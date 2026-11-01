// @ts-check
/**
 * Pacing — the whole anti-bot strategy, behaving like one person watching: a port of
 * `engine.py`'s pacing (`PacingState`, `_next_pause`, `_pause_before_attempt`, `long_rest_due`,
 * `_pause_between_series`, the stop rules of `download_series`), of the web job manager's rest
 * between jobs (`web.jobs.JobManager.before_network`) and of the CLI's pause announcements. Pure:
 * the random source, the clock and the sleeping are the caller's (injected), so no test waits.
 *
 * The Python defaults are FLOORS here ({@link PACING_DEFAULTS}, `DramaFetch/CLAUDE.md` → Pacing):
 * 4–9 s between episodes (or the human pace), a 60–120 s rest every 10 network attempts, the same
 * rest between two series (or jobs) that contact TikTok, a 15–30 min break every 100 network
 * attempts of a run (an idle gap of 15 min counts as that break), 0.8–1.6 s before each list
 * page, a stop after 3 failures in a row. {@link validatePacing} refuses anything lighter unless
 * the manifest of a TEST copy of the extension says `dramafetch_test` (the caller passes
 * `testMode`); users may only make the pauses longer.
 */

import {
  DONE,
  DRY_RUN,
  FAILED,
  FAILED_BLOCKED,
  FAILED_LOGIN,
  FAILED_RATE_LIMITED,
  FAILED_UNAVAILABLE,
  SKIPPED_EXISTS,
  SKIPPED_LOCKED,
  pyFormatFixed,
  pyFormatG,
  pyRepr,
} from "./messages.js";

/** `on_pause` kinds: inside a series, the run's long break, between series, between jobs. */
export const PACE = "pace";
export const REST = "rest";
export const LONG_REST = "long-rest";
export const SERIES_REST = "series-rest";
export const JOB_REST = "job-rest";
/** `pace` values: a random `delayMinS`–`delayMaxS`, or about the previous episode's duration. */
export const PACES = Object.freeze(/** @type {const} */ (["fixed", "human"]));
/** Upper bound of a "human" pause. */
export const MAX_HUMAN_PAUSE_S = 300;
/** Random extra on top of a "human" pause. */
export const HUMAN_JITTER_S = 3;
/** The pause before each further list page: `PAGE_DELAY_S` × a factor in `PAGE_DELAY_JITTER`. */
export const PAGE_DELAY_S = 0.8;
export const PAGE_DELAY_JITTER = Object.freeze(/** @type {const} */ ([1.0, 2.0]));
/** Media GETs one episode may cost in all, refresh included (`MAX_GETS_PER_EPISODE`). */
export const MAX_GETS_PER_EPISODE = 4;
/** Cover GETs per episode, outside the media budget, never retried (`MAX_COVER_GETS`). */
export const MAX_COVER_GETS = 1;
/** A play URL expiring within this many seconds counts as expired (`EXPIRY_MARGIN_S`). */
export const EXPIRY_MARGIN_S = 60;
/** The longest pause a setting may ask for: one day (pauses may be raised, but within reason). */
export const MAX_PAUSE_S = 86400;
/** The longest delay one timer honours (2^31 - 1 ms): a longer `setTimeout` overflows and fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** One of these stops the run at once: TikTok said no (`engine._STOP_STATUSES`). */
export const STOP_STATUSES = Object.freeze(new Set([FAILED_LOGIN, FAILED_RATE_LIMITED, FAILED_BLOCKED]));
/** The stop statuses that are TikTok refusing: they also start the cooldown (`engine.BLOCK_STATUSES`). */
export const BLOCK_STATUSES = Object.freeze(new Set([FAILED_RATE_LIMITED, FAILED_BLOCKED]));
/** Failures counted towards `maxConsecutiveFailures` (`engine._COUNTED_FAILURES`). */
export const COUNTED_FAILURES = Object.freeze(new Set([FAILED, FAILED_UNAVAILABLE]));
/** Results that did not contact TikTok: they never pause, count or reset anything. */
export const NO_NETWORK_STATUSES = Object.freeze(new Set([SKIPPED_EXISTS, SKIPPED_LOCKED, DRY_RUN]));
/** The same four sets under their short names. */
export const STOP = STOP_STATUSES;
export const BLOCK = BLOCK_STATUSES;
export const NO_NETWORK = NO_NETWORK_STATUSES;

/**
 * @typedef {object} PacingOptions The pacing knobs (`models.DownloadOptions`), in seconds.
 * @property {number} delayMinS
 * @property {number} delayMaxS
 * @property {"fixed" | "human" | string} pace
 * @property {number} restEvery
 * @property {number} restMinS
 * @property {number} restMaxS
 * @property {number} maxConsecutiveFailures
 * @property {number} longRestEvery
 * @property {number} longRestMinS
 * @property {number} longRestMaxS
 *
 * @typedef {object} Rng The random source: `uniform(a, b)` is `a + (b - a) * random()`, as Python's.
 * @property {(low: number, high: number) => number} uniform
 *
 * @typedef {() => number} Clock Seconds, monotonic within a run.
 *
 * @typedef {object} Pause
 * @property {string} kind {@link PACE}, {@link REST}, {@link LONG_REST}, {@link SERIES_REST} or {@link JOB_REST}
 * @property {number} seconds
 */

/** The Python defaults, which are the extension's floors. */
export const PACING_DEFAULTS = Object.freeze({
  delayMinS: 4,
  delayMaxS: 9,
  pace: "fixed",
  restEvery: 10,
  restMinS: 60,
  restMaxS: 120,
  maxConsecutiveFailures: 3,
  longRestEvery: 100,
  longRestMinS: 900,
  longRestMaxS: 1800,
});

/**
 * The defaults with `overrides` on top (unknown keys ignored).
 * @param {Partial<PacingOptions>} [overrides]
 * @returns {PacingOptions}
 */
export function pacingOptions(overrides = {}) {
  /** @type {PacingOptions} */
  const options = { ...PACING_DEFAULTS };
  for (const key of /** @type {(keyof PacingOptions)[]} */ (Object.keys(PACING_DEFAULTS))) {
    const value = overrides[key];
    if (value !== undefined) /** @type {Record<string, unknown>} */ (options)[key] = value;
  }
  return options;
}

/**
 * The pacing of one RUN (`engine.PacingState`), shared by every series of a batch and every job
 * of the app page: `runAttempts` network attempts so far (skips never count), `lastNetworkAt` the
 * clock right after the last of them, and the failure streak across series.
 */
export class PacingState {
  /** @param {{runAttempts?: number, lastNetworkAt?: number | null, consecutiveFailures?: number}} [init] */
  constructor(init = {}) {
    /** @type {number} */
    this.runAttempts = init.runAttempts ?? 0;
    /** @type {number | null} */
    this.lastNetworkAt = init.lastNetworkAt ?? null;
    /** @type {number} */
    this.consecutiveFailures = init.consecutiveFailures ?? 0;
  }
}

/** The floors {@link validatePacing} enforces outside test mode. */
const FLOORS = /** @type {const} */ ([
  ["delay_min_s", "delayMinS", 4],
  ["delay_max_s", "delayMaxS", 9],
  ["rest_min_s", "restMinS", 60],
  ["rest_max_s", "restMaxS", 120],
  ["long_rest_min_s", "longRestMinS", 900],
  ["long_rest_max_s", "longRestMaxS", 1800],
]);
/** Counts that may only get SMALLER (more often), never 0 (which would disable them). */
const CEILINGS = /** @type {const} */ ([
  ["rest_every", "restEvery", 10],
  ["max_consecutive_failures", "maxConsecutiveFailures", 3],
  ["long_rest_every", "longRestEvery", 100],
]);

/**
 * Why the pacing cannot be honoured, or null (`engine.validate_pacing` and its messages), and —
 * outside test mode — why it would be lighter than the Python defaults: every pause at least its
 * default, every count (`restEvery`, `maxConsecutiveFailures`, `longRestEvery`) between 1 and its
 * default. A value that is not a finite number, and a pause over {@link MAX_PAUSE_S}, are refused
 * in any mode.
 * @param {PacingOptions} options
 * @param {{testMode?: boolean}} [mode]
 * @returns {string | null}
 */
export function pacingProblem(options, mode = {}) {
  for (const [name, key] of [...FLOORS, ...CEILINGS]) {
    const value = options[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return `${name} must be a number`;
  }
  for (const [name, key] of CEILINGS) {
    if (!Number.isInteger(options[key])) return `${name} must be a whole number`;
  }
  const ranges = /** @type {const} */ ([
    ["delay_min_s", "delayMinS", "delay_max_s", "delayMaxS"],
    ["rest_min_s", "restMinS", "rest_max_s", "restMaxS"],
    ["long_rest_min_s", "longRestMinS", "long_rest_max_s", "longRestMaxS"],
  ]);
  for (const [lowName, lowKey, highName, highKey] of ranges) {
    const low = options[lowKey];
    const high = options[highKey];
    if (low < 0 || high < 0) {
      return `${lowName}/${highName} must not be negative (got ${pyFormatG(low)} and ${pyFormatG(high)})`;
    }
    if (high < low) return `${highName} (${pyFormatG(high)}) must be >= ${lowName} (${pyFormatG(low)})`;
  }
  for (const [name, key] of FLOORS) {
    if (options[key] > MAX_PAUSE_S) {
      return `${name} (${pyFormatG(options[key])}) must be at most ${MAX_PAUSE_S} s (one day)`;
    }
  }
  if (options.restEvery < 0 || options.longRestEvery < 0) {
    return "rest_every/long_rest_every must not be negative (0 disables)";
  }
  if (!(/** @type {readonly string[]} */ (PACES).includes(options.pace))) {
    return `unknown pace ${pyRepr(String(options.pace))}: expected one of ${PACES.join(", ")}`;
  }
  if (mode.testMode) return null;
  for (const [name, key, floor] of FLOORS) {
    if (options[key] < floor) {
      return `${name} (${pyFormatG(options[key])}) must be at least ${pyFormatG(floor)}: pauses may only be made longer`;
    }
  }
  for (const [name, key, ceiling] of CEILINGS) {
    if (options[key] < 1 || options[key] > ceiling) {
      return `${name} (${options[key]}) must be between 1 and ${ceiling}: never less often than the defaults`;
    }
  }
  return null;
}

/**
 * Sleep `seconds` of wall-clock time through timers of at most {@link MAX_TIMER_MS} each, re-armed
 * until the deadline — one longer `setTimeout` would overflow and fire at once — so a pause can
 * only come out longer (a late timer, a background tab), never shorter. A negative or non-finite
 * duration sleeps 0 s (one timer turn). With `signal`, aborting it ends the sleep at once: the
 * promise rejects with `signal.reason`.
 * @param {number} seconds
 * @param {{signal?: AbortSignal, now?: () => number, setTimer?: (callback: () => void, ms: number) => unknown, clearTimer?: (handle: unknown) => void}} [options]
 *   `now` in milliseconds (`Date.now`), the timers (`setTimeout` / `clearTimeout`) injectable for tests
 * @returns {Promise<void>}
 */
export function sleepSeconds(seconds, options = {}) {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)));
  const { signal } = options;
  const total = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  const end = now() + total;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    /** @type {unknown} */
    let handle;
    const onAbort = () => {
      clearTimer(handle);
      reject(signal?.reason);
    };
    const tick = () => {
      const left = end - now();
      if (left > 0) {
        handle = setTimer(tick, Math.min(left, MAX_TIMER_MS));
        return;
      }
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    handle = setTimer(tick, Math.min(total, MAX_TIMER_MS));
  });
}

/**
 * {@link pacingProblem} as an exception (`engine.validate_pacing`).
 * @param {PacingOptions} options
 * @param {{testMode?: boolean}} [mode]
 */
export function validatePacing(options, mode = {}) {
  const problem = pacingProblem(options, mode);
  if (problem !== null) throw new Error(problem);
}

/**
 * Whether the run's long break is due before the next network attempt; first forgets the count —
 * and the failure streak — when the run has been idle for `longRestMinS` (`engine._long_rest_due`).
 * @param {PacingOptions} options
 * @param {PacingState} pacing
 * @param {number | null} now
 * @returns {boolean}
 */
function longRestDueAt(options, pacing, now) {
  if (now !== null && pacing.lastNetworkAt !== null && now - pacing.lastNetworkAt >= options.longRestMinS) {
    pacing.runAttempts = 0; // the break already happened naturally
    pacing.consecutiveFailures = 0; // and failures before it are not "in a row" any more
  }
  return options.longRestEvery > 0 && pacing.runAttempts > 0 && pacing.runAttempts % options.longRestEvery === 0;
}

/**
 * Whether the run's long break is due before its next network attempt (`engine.long_rest_due`):
 * what a front end asks right before a series' first request, so that the break comes BEFORE the
 * series is resolved. The caller then takes `rng.uniform(longRestMinS, longRestMaxS)` and sets
 * `pacing.runAttempts` to 0.
 * @param {PacingOptions} options
 * @param {PacingState} pacing
 * @param {Clock} clock
 * @returns {boolean}
 */
export function longRestDue(options, pacing, clock) {
  const now = pacing.lastNetworkAt !== null ? clock() : null;
  return longRestDueAt(options, pacing, now);
}

/**
 * The pause before the next network attempt of a series, `networkAttempts` > 0 made
 * (`engine._next_pause`): a REST when the attempts so far are a multiple of `restEvery`, else a
 * PACE — random `delayMinS`–`delayMaxS`, or with the human pace the previous episode's duration
 * (at least `delayMinS`) plus 0–3 s, capped at 300 s.
 * @param {PacingOptions} options
 * @param {Rng} rng
 * @param {number} networkAttempts
 * @param {{durationS: number | null} | null} previous the episode of the previous network attempt
 * @returns {Pause}
 */
export function nextPause(options, rng, networkAttempts, previous) {
  if (options.restEvery > 0 && networkAttempts % options.restEvery === 0) {
    return { kind: REST, seconds: rng.uniform(options.restMinS, options.restMaxS) };
  }
  if (options.pace === "human") {
    const watched = previous !== null ? previous.durationS || 0 : 0;
    const pause = Math.max(options.delayMinS, watched) + rng.uniform(0, HUMAN_JITTER_S);
    return { kind: PACE, seconds: Math.min(pause, MAX_HUMAN_PAUSE_S) };
  }
  return { kind: PACE, seconds: rng.uniform(options.delayMinS, options.delayMaxS) };
}

/**
 * The pause before a network attempt (`engine._pause_before_attempt`): the run's long break when
 * due (it REPLACES that step's pause, also before a series' first attempt), else
 * {@link nextPause}, and none (0 s) before a series' first attempt.
 * @param {PacingOptions} options
 * @param {Rng} rng
 * @param {PacingState} pacing
 * @param {Clock} clock
 * @param {number} networkAttempts the series' network attempts so far
 * @param {{durationS: number | null} | null} previous
 * @returns {Pause}
 */
export function pauseBeforeAttempt(options, rng, pacing, clock, networkAttempts, previous) {
  const now = pacing.lastNetworkAt !== null ? clock() : null;
  if (longRestDueAt(options, pacing, now)) {
    return { kind: LONG_REST, seconds: rng.uniform(options.longRestMinS, options.longRestMaxS) };
  }
  if (networkAttempts > 0) return nextPause(options, rng, networkAttempts, previous);
  return { kind: PACE, seconds: 0 };
}

/**
 * The pause before a series that will contact TikTok when an earlier one of the batch did
 * (`engine._pause_between_series`): the series rest, `restMinS`–`restMaxS` — or the long break
 * when it is due, taken BEFORE the resolve. Announce it, sleep it, and after a LONG_REST set
 * `pacing.runAttempts = 0` (the CLI announces the count first: "long break 22 min after 100").
 * @param {PacingOptions} options
 * @param {Rng} rng
 * @param {PacingState} pacing
 * @param {Clock} clock
 * @returns {Pause}
 */
export function pauseBetweenSeries(options, rng, pacing, clock) {
  if (longRestDue(options, pacing, clock)) {
    return { kind: LONG_REST, seconds: rng.uniform(options.longRestMinS, options.longRestMaxS) };
  }
  return { kind: SERIES_REST, seconds: rng.uniform(options.restMinS, options.restMaxS) };
}

/**
 * The rest before a job's first request (`web.jobs.JobManager.before_network`): for a batch job
 * the long break when due (then set `pacing.runAttempts = 0` once slept); else, when the last job
 * that contacted TikTok finished at most `restMaxS` ago, a JOB_REST of `restMinS`–`restMaxS`;
 * else null (no pause). Ask the cooldown again after sleeping a pause.
 * @param {PacingOptions} options
 * @param {Rng} rng
 * @param {PacingState} pacing
 * @param {Clock} clock
 * @param {{lastContactAt: number | null, batchJob: boolean}} job
 * @returns {Pause | null}
 */
export function pauseBetweenJobs(options, rng, pacing, clock, job) {
  if (job.batchJob && longRestDue(options, pacing, clock)) {
    return { kind: LONG_REST, seconds: rng.uniform(options.longRestMinS, options.longRestMaxS) };
  }
  if (job.lastContactAt === null || clock() - job.lastContactAt > options.restMaxS) return null;
  return { kind: JOB_REST, seconds: rng.uniform(options.restMinS, options.restMaxS) };
}

/**
 * The pause before a list page (the discovery's `page_pause_s`): `pageDelayS` × uniform(1.0, 2.0),
 * 0.8–1.6 s by default.
 * @param {Rng} rng
 * @param {number} [pageDelayS]
 * @returns {number}
 */
export function pagePause(rng, pageDelayS = PAGE_DELAY_S) {
  return pageDelayS * rng.uniform(PAGE_DELAY_JITTER[0], PAGE_DELAY_JITTER[1]);
}

/**
 * @typedef {object} Stop Why a run stops after a result (the texts of `engine.download_series`).
 * @property {string} status the status of the remaining rows (`stopped: <reason>`)
 * @property {string} reason
 * @property {string} summary what `on_stop` gets: `episode 2 failed-rate-limited`, `3 consecutive failures`
 * @property {boolean} block a refusal (403 / 429 / captcha): record the cooldown, once per run
 */

/**
 * What a result does to the run (`engine.download_series` after `downloader.download`): counts a
 * network attempt (`pacing.runAttempts`, `pacing.lastNetworkAt`; the caller counts the series'
 * own), then a stop status → a {@link Stop}; a counted failure → the streak, and a Stop at
 * `maxConsecutiveFailures`; a DONE resets the streak. After a stop the caller marks the rest
 * (`report.stoppedResult`) and sets `pacing.consecutiveFailures = 0`.
 * @param {PacingOptions} options
 * @param {PacingState} pacing
 * @param {Clock} clock
 * @param {{episode: {number: number}, status: string, message: string}} result
 * @returns {{network: boolean, stop: Stop | null}}
 */
export function afterResult(options, pacing, clock, result) {
  const network = !NO_NETWORK_STATUSES.has(result.status);
  if (network) {
    pacing.runAttempts += 1;
    pacing.lastNetworkAt = clock();
  }
  if (STOP_STATUSES.has(result.status)) {
    const summary = `episode ${result.episode.number} ${result.status}`;
    const reason = result.message ? `${summary}: ${result.message}` : summary;
    return { network, stop: { status: result.status, reason, summary, block: BLOCK_STATUSES.has(result.status) } };
  }
  if (COUNTED_FAILURES.has(result.status)) {
    pacing.consecutiveFailures += 1; // the RUN's streak: it spans the series
    if (options.maxConsecutiveFailures > 0 && options.maxConsecutiveFailures <= pacing.consecutiveFailures) {
      const last = result.message || result.status;
      const summary = `${pacing.consecutiveFailures} consecutive failures`;
      return { network, stop: { status: FAILED, reason: `${summary} (last: ${last})`, summary, block: false } };
    }
  } else if (result.status === DONE) {
    pacing.consecutiveFailures = 0;
  }
  return { network, stop: null };
}

/**
 * `f"{seconds:.0f} s"`, or with one decimal under a second (`cli._format_seconds`).
 * @param {number} seconds
 * @returns {string}
 */
export function formatSeconds(seconds) {
  return seconds >= 1 ? `${pyFormatFixed(seconds, 0)} s` : `${pyFormatFixed(seconds, 1)} s`;
}

/**
 * `f"{seconds / 60:.0f} min"` (`cli._format_minutes`).
 * @param {number} seconds
 * @returns {string}
 */
export function formatMinutes(seconds) {
  return `${pyFormatFixed(seconds / 60, 0)} min`;
}

/**
 * What the run announces for a pause (`cli._RunPrinter.pause`, without its `… `): `pausing 7 s`,
 * `resting 95 s after 10 downloads`, `resting 95 s before the next series` (also between jobs),
 * `long break 22 min after 100 episodes`.
 * @param {string} kind
 * @param {number} seconds
 * @param {{downloads?: number, runAttempts?: number}} [counts] the series' downloads, the run's attempts
 * @returns {string}
 */
export function pauseMessage(kind, seconds, counts = {}) {
  const downloads = counts.downloads ?? 0;
  if (kind === REST) return `resting ${formatSeconds(seconds)} after ${downloads} downloads`;
  if (kind === SERIES_REST || kind === JOB_REST) return `resting ${formatSeconds(seconds)} before the next series`;
  if (kind === LONG_REST) return `long break ${formatMinutes(seconds)} after ${counts.runAttempts ?? downloads} episodes`;
  return `pausing ${formatSeconds(seconds)}`;
}

/**
 * @param {number} low
 * @param {number} high
 * @returns {string}
 */
function describeRange(low, high) {
  return low === high ? pyFormatG(low) : `${pyFormatG(low)}–${pyFormatG(high)}`;
}

/**
 * One line with the pacing in force (`cli.describe_pacing`), e.g. `4–9 s between episodes,
 * 60–120 s rest every 10; stop after 3 failures / 403 / 429`.
 * @param {PacingOptions} [options]
 * @returns {string}
 */
export function describePacing(options = pacingOptions()) {
  const between =
    options.pace === "human"
      ? `human pace (about one episode's length, at least ${pyFormatG(options.delayMinS)} s) between episodes`
      : `${describeRange(options.delayMinS, options.delayMaxS)} s between episodes`;
  const rest =
    options.restEvery > 0
      ? `${describeRange(options.restMinS, options.restMaxS)} s rest every ${options.restEvery}`
      : "no long rests";
  let stop;
  if (options.maxConsecutiveFailures > 0) {
    const noun = options.maxConsecutiveFailures === 1 ? "failure" : "failures";
    stop = `stop after ${options.maxConsecutiveFailures} ${noun} / 403 / 429`;
  } else {
    stop = "stop on 403 / 429";
  }
  return `${between}, ${rest}; ${stop}`;
}

/**
 * What a batch adds (`cli.describe_batch_pacing`), e.g. `60–120 s rest between series, a 15–30
 * min break every 100 episodes`.
 * @param {PacingOptions} [options]
 * @returns {string}
 */
export function describeBatchPacing(options = pacingOptions()) {
  const rest = `${describeRange(options.restMinS, options.restMaxS)} s rest between series`;
  if (options.longRestEvery <= 0) return rest;
  const minutes = describeRange(options.longRestMinS / 60, options.longRestMaxS / 60);
  return `${rest}, a ${minutes} min break every ${options.longRestEvery} episodes`;
}

/**
 * The extension's random source: `crypto.getRandomValues` (Math.random where it is missing).
 * @type {Rng}
 */
export const defaultRng = Object.freeze({
  uniform(low, high) {
    return low + (high - low) * random01();
  },
});

/** @returns {number} uniform in [0, 1) */
function random01() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const words = cryptoApi.getRandomValues(new Uint32Array(2));
    const high = /** @type {number} */ (words[0]) >>> 5; // 27 bits
    const low = /** @type {number} */ (words[1]) >>> 6; // 26 bits
    // 53 random bits, like Python's random(): (a * 2^26 + b) / 2^53
    return (high * 67108864 + low) / 9007199254740992;
  }
  return Math.random();
}

/**
 * A seeded random source for tests (mulberry32): the same seed, the same pauses.
 * @param {number} seed
 * @returns {Rng}
 */
export function seededRng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { uniform: (low, high) => low + (high - low) * next() };
}
