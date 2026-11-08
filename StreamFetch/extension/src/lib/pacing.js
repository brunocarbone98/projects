// @ts-check
/**
 * Pacing — the "safety against blocks" the owner asked for, by behaving like one person watching
 * rather than by evasion: one request at a time, jittered pauses between media requests, between
 * page requests and between videos, bounded retries with backoff, a stall timeout, a stop after
 * three failures in a row and a full stop plus a 30-minute cooldown when a site refuses (429, 412,
 * a 403 on a page or a manifest, a verification wall). The constants here are FLOORS: no code
 * path lowers them, a user may only raise the pauses ({@link pacingProblem} refuses anything
 * lighter), and only the manifest of a TEST copy of the extension (`streamfetch_test`) brings
 * them down (the caller passes `testMode`). Pure: the random source, the clock and the timers are
 * the caller's (injected), so no test waits.
 */

import {
  DONE,
  FAILED,
  FAILED_BLOCKED,
  FAILED_RATE_LIMITED,
  FAILED_UNAVAILABLE,
  SKIPPED_EXISTS,
} from "./messages.js";

/**
 * @typedef {readonly [number, number]} Range A `[min, max]` pair; a draw is uniform between
 *   the two.
 */

/** Between two downloads, in seconds. */
export const VIDEO_PAUSE_S = Object.freeze(/** @type {Range} */ ([3, 6]));
/**
 * Between two page or manifest requests of one batch (the Bilibili parts, the HLS playlists), in
 * seconds.
 */
export const PAGE_PAUSE_S = Object.freeze(/** @type {Range} */ ([1, 2]));
/** Between two media requests (segments, Range continuations, track files), in milliseconds. */
export const MEDIA_PAUSE_MS = Object.freeze(/** @type {Range} */ ([100, 300]));
/** How many times one request is retried on a network error, a 5xx or a stall. */
export const MAX_RETRIES = 3;
/** The pause before retry 1, 2 and 3, in seconds (exponential backoff). */
export const RETRY_BACKOFF_S = Object.freeze(/** @type {readonly number[]} */ ([1, 2, 4]));
/** No bytes for this long → the request is aborted and retried. */
export const STALL_TIMEOUT_S = 30;
/** `failed` / `failed-unavailable` results in a row that stop the batch. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/**
 * How long nothing contacts a site after it refused (429, 412, a 403 on a page or a manifest, a
 * verification wall), in minutes.
 */
export const COOLDOWN_MINUTES = 30;
/** The longest pause a setting may ask for: one day (pauses may be raised, but within reason). */
export const MAX_PAUSE_S = 86400;
/**
 * The longest delay one timer honours (2^31 - 1 ms): a longer `setTimeout` overflows and fires
 * at once.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * @typedef {object} PacingSettings The pacing knobs of the `settings` record (`app/storage.js`).
 * @property {Range} videoPauseS between two downloads, in seconds
 * @property {Range} pagePauseS between two page or manifest requests of one batch, in seconds
 * @property {Range} mediaPauseMs between two media requests, in milliseconds
 * @property {number} [stallTimeoutS] test mode only (`testSettings`): the stall timeout; the
 *   floor otherwise
 */

/** The floors as a settings record: what a fresh install uses. */
export const PACING_DEFAULTS = Object.freeze(
  /** @type {PacingSettings} */ ({
    videoPauseS: VIDEO_PAUSE_S,
    pagePauseS: PAGE_PAUSE_S,
    mediaPauseMs: MEDIA_PAUSE_MS,
  }),
);

/**
 * The defaults with `overrides` on top (unknown keys ignored, `stallTimeoutS` kept when given).
 * @param {Partial<PacingSettings>} [overrides]
 * @returns {PacingSettings}
 */
export function pacingSettings(overrides = {}) {
  /** @type {PacingSettings} */
  const settings = {
    videoPauseS: overrides.videoPauseS ?? PACING_DEFAULTS.videoPauseS,
    pagePauseS: overrides.pagePauseS ?? PACING_DEFAULTS.pagePauseS,
    mediaPauseMs: overrides.mediaPauseMs ?? PACING_DEFAULTS.mediaPauseMs,
  };
  if (overrides.stallTimeoutS !== undefined) settings.stallTimeoutS = overrides.stallTimeoutS;
  return settings;
}

/**
 * @typedef {object} Knob One pacing knob, for the checks and the texts.
 * @property {"videoPauseS" | "pagePauseS" | "mediaPauseMs"} key
 * @property {string} label
 * @property {"s" | "ms"} unit
 * @property {Range} floor
 * @property {number} limit the longest pause allowed, in the knob's unit
 */

/** @type {readonly Knob[]} */
const KNOBS = Object.freeze([
  {
    key: "videoPauseS",
    label: "pause between videos",
    unit: "s",
    floor: VIDEO_PAUSE_S,
    limit: MAX_PAUSE_S,
  },
  {
    key: "pagePauseS",
    label: "pause between page requests",
    unit: "s",
    floor: PAGE_PAUSE_S,
    limit: MAX_PAUSE_S,
  },
  {
    key: "mediaPauseMs",
    label: "pause between media requests",
    unit: "ms",
    floor: MEDIA_PAUSE_MS,
    limit: MAX_PAUSE_S * 1000,
  },
]);

/**
 * Whether `value` is a `[min, max]` pair of finite numbers.
 * @param {unknown} value
 * @returns {value is Range}
 */
export function isRange(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

/**
 * Why the pacing settings cannot be honoured, or null: every knob a `[min, max]` pair of finite
 * numbers, not negative, `max` at least `min` and at most one day (`stallTimeoutS`, when present, a
 * positive number of seconds up to one day) — in any mode; and, outside test mode, every `min`
 * and `max` at least its floor: pauses may only be made longer. The texts are the ones the
 * settings form shows (`#settings-problem`).
 * @param {Record<string, unknown>} settings the `settings` record (a {@link PacingSettings} fits)
 * @param {boolean} [testMode] true only when the manifest says `streamfetch_test`
 * @returns {string | null}
 */
export function pacingProblem(settings, testMode = false) {
  for (const knob of KNOBS) {
    const range = settings[knob.key];
    if (!isRange(range)) {
      return `the ${knob.label} must be two numbers: a minimum and a maximum in ${knob.unit}`;
    }
    const [min, max] = range;
    const unit = knob.unit;
    if (min < 0 || max < 0) {
      return `the ${knob.label} must not be negative (got ${min} and ${max} ${unit})`;
    }
    if (max < min) {
      return (
        `the ${knob.label}: the maximum (${max} ${unit}) must be at least the minimum ` +
        `(${min} ${unit})`
      );
    }
    if (max > knob.limit) {
      return (
        `the ${knob.label}: the maximum (${max} ${unit}) must be at most ${knob.limit} ${unit} ` +
        "(one day)"
      );
    }
  }
  const stall = settings["stallTimeoutS"];
  if (stall !== undefined) {
    if (typeof stall !== "number" || !Number.isFinite(stall) || stall <= 0) {
      return "the stall timeout must be a positive number of seconds";
    }
    if (stall > MAX_PAUSE_S) {
      return `the stall timeout (${stall} s) must be at most ${MAX_PAUSE_S} s (one day)`;
    }
  }
  if (testMode) return null;
  for (const knob of KNOBS) {
    const [min, max] = /** @type {Range} */ (settings[knob.key]);
    const [floorMin, floorMax] = knob.floor;
    const unit = knob.unit;
    if (min < floorMin) {
      return (
        `the ${knob.label}: the minimum (${min} ${unit}) must be at least ${floorMin} ${unit} ` +
        "— pauses may only be made longer"
      );
    }
    if (max < floorMax) {
      return (
        `the ${knob.label}: the maximum (${max} ${unit}) must be at least ${floorMax} ${unit} ` +
        "— pauses may only be made longer"
      );
    }
  }
  return null;
}

/**
 * {@link pacingProblem} as an exception.
 * @param {Record<string, unknown>} settings
 * @param {boolean} [testMode]
 */
export function validatePacing(settings, testMode = false) {
  const problem = pacingProblem(settings, testMode);
  if (problem !== null) throw new Error(problem);
}

/**
 * @typedef {() => number} Rng A random source: a number in [0, 1), like `Math.random`.
 */

/**
 * A uniform draw between `min` and `max` (inclusive of `min`, as `rng` never reaches 1).
 * @param {Rng} rng
 * @param {Range} range
 * @returns {number}
 */
export function uniform(rng, range) {
  const [min, max] = range;
  return min + (max - min) * rng();
}

/**
 * The pause before the next download, in seconds.
 * @param {PacingSettings} settings
 * @param {Rng} [rng]
 * @returns {number}
 */
export function videoPauseS(settings, rng = defaultRng) {
  return uniform(rng, settings.videoPauseS);
}

/**
 * The pause before the next page or manifest request of a batch, in seconds.
 * @param {PacingSettings} settings
 * @param {Rng} [rng]
 * @returns {number}
 */
export function pagePauseS(settings, rng = defaultRng) {
  return uniform(rng, settings.pagePauseS);
}

/**
 * The pause before the next media request, in milliseconds.
 * @param {PacingSettings} settings
 * @param {Rng} [rng]
 * @returns {number}
 */
export function mediaPauseMs(settings, rng = defaultRng) {
  return uniform(rng, settings.mediaPauseMs);
}

/**
 * The backoff before retry number `retry` (1-based): 1, 2, 4 s; a retry beyond the table (never
 * asked for: {@link MAX_RETRIES} is 3) waits the last value.
 * @param {number} retry
 * @returns {number}
 */
export function retryBackoffS(retry) {
  const index = Math.min(Math.max(1, Math.floor(retry)), RETRY_BACKOFF_S.length) - 1;
  return /** @type {number} */ (RETRY_BACKOFF_S[index]);
}

/**
 * The stall timeout in force: the floor, or in test mode the `stallTimeoutS` of the settings.
 * @param {PacingSettings} settings
 * @param {boolean} [testMode]
 * @returns {number}
 */
export function stallTimeoutS(settings, testMode = false) {
  const stall = settings.stallTimeoutS;
  if (testMode && typeof stall === "number" && Number.isFinite(stall) && stall > 0) return stall;
  return STALL_TIMEOUT_S;
}

/**
 * @typedef {object} SleepOptions
 * @property {AbortSignal} [signal] aborting it ends the sleep at once: the promise rejects with
 *   `signal.reason`
 * @property {() => number} [now] the clock in milliseconds (`Date.now`)
 * @property {(callback: () => void, ms: number) => unknown} [setTimer] `setTimeout`
 * @property {(handle: unknown) => void} [clearTimer] `clearTimeout`
 */

/**
 * @param {unknown} value
 * @returns {value is AbortSignal}
 */
function isAbortSignal(value) {
  return typeof AbortSignal !== "undefined" && value instanceof AbortSignal;
}

/**
 * Sleep `seconds` of wall-clock time through timers of at most {@link MAX_TIMER_MS} each, re-armed
 * until the deadline — one longer `setTimeout` would overflow and fire at once — so a pause can
 * only come out longer (a late timer, a background tab), never shorter. A negative or non-finite
 * duration sleeps 0 s (one timer turn). The second argument is an `AbortSignal` or a
 * {@link SleepOptions}; aborting the signal ends the sleep at once, rejecting with `signal.reason`.
 * @param {number} seconds
 * @param {AbortSignal | SleepOptions} [signalOrOptions]
 * @returns {Promise<void>}
 */
export function sleepSeconds(seconds, signalOrOptions = {}) {
  const options = isAbortSignal(signalOrOptions) ? { signal: signalOrOptions } : signalOrOptions;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)));
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
 * {@link sleepSeconds} for a duration in milliseconds (the media pauses).
 * @param {number} ms
 * @param {AbortSignal | SleepOptions} [signalOrOptions]
 * @returns {Promise<void>}
 */
export function sleepMs(ms, signalOrOptions = {}) {
  return sleepSeconds(ms / 1000, signalOrOptions);
}

// ------------------------------------------------------------------------------ stop rules

/** The statuses that stop the run at once and start the cooldown: the site refused. */
export const STOP_STATUSES = Object.freeze(new Set([FAILED_RATE_LIMITED, FAILED_BLOCKED]));
/** Failures counted towards {@link MAX_CONSECUTIVE_FAILURES}. */
export const COUNTED_FAILURES = Object.freeze(new Set([FAILED, FAILED_UNAVAILABLE]));
/** Results that contacted no site: they neither pause, count nor reset anything. */
export const NO_NETWORK_STATUSES = Object.freeze(new Set([SKIPPED_EXISTS]));

/**
 * @typedef {object} RunCounters The counters of one run, shared by every target of a batch.
 * @property {number} consecutiveFailures `failed` / `failed-unavailable` results in a row
 *
 * @typedef {object} Stop Why the run stops after a result.
 * @property {import("./messages.js").StopReason} reason what the remaining rows' `stopped`
 *   failure carries
 * @property {boolean} cooldown a refusal by the site: record the cooldown, once per run
 */

/**
 * What a result does to the run: a `failed-rate-limited` / `failed-blocked` status stops it with
 * the cooldown; a `login_required` failure stops it without one; a counted failure lengthens the
 * streak and stops it at {@link MAX_CONSECUTIVE_FAILURES}; a `done` resets the streak; a
 * `skipped-exists` changes nothing. The caller marks the remaining targets `stopped` with the
 * reason and, after a stop, resets `counters.consecutiveFailures`.
 * @param {RunCounters} counters
 * @param {string} status the result's status
 * @param {string | null} [code] the result's failure code, when it failed
 * @returns {{ network: boolean, stop: Stop | null }}
 */
export function afterResult(counters, status, code = null) {
  const network = !NO_NETWORK_STATUSES.has(status);
  if (status === FAILED_RATE_LIMITED) {
    return { network, stop: { reason: "rate_limited", cooldown: true } };
  }
  if (status === FAILED_BLOCKED) {
    return { network, stop: { reason: "blocked", cooldown: true } };
  }
  if (code === "login_required") {
    return { network, stop: { reason: "login_required", cooldown: false } };
  }
  if (COUNTED_FAILURES.has(status)) {
    counters.consecutiveFailures += 1;
    if (counters.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return { network, stop: { reason: "consecutive_failures", cooldown: false } };
    }
  } else if (status === DONE) {
    counters.consecutiveFailures = 0;
  }
  return { network, stop: null };
}

// ----------------------------------------------------------------------------------- texts

/**
 * `3–6 s`, `100–300 ms`, or `5 s` when both ends agree.
 * @param {Range} range
 * @param {"s" | "ms"} unit
 * @returns {string}
 */
export function formatRange(range, unit) {
  const [min, max] = range;
  return min === max ? `${min} ${unit}` : `${min}–${max} ${unit}`;
}

/**
 * One line with the pacing in force (the README and the settings form), e.g. `3–6 s between
 * videos, 1–2 s between page requests, 100–300 ms between media requests; 3 retries (1, 2, 4 s
 * back-off), 30 s stall timeout; stop after 3 failures in a row or any 429 / 412 / 403, then a
 * 30 min cooldown`.
 * @param {PacingSettings} [settings]
 * @param {boolean} [testMode]
 * @returns {string}
 */
export function describePacing(settings = PACING_DEFAULTS, testMode = false) {
  const pauses =
    `${formatRange(settings.videoPauseS, "s")} between videos, ` +
    `${formatRange(settings.pagePauseS, "s")} between page requests, ` +
    `${formatRange(settings.mediaPauseMs, "ms")} between media requests`;
  const retries =
    `${MAX_RETRIES} retries (${RETRY_BACKOFF_S.join(", ")} s back-off), ` +
    `${stallTimeoutS(settings, testMode)} s stall timeout`;
  const stop =
    `stop after ${MAX_CONSECUTIVE_FAILURES} failures in a row or any 429 / 412 / 403, ` +
    `then a ${COOLDOWN_MINUTES} min cooldown`;
  return `${pauses}; ${retries}; ${stop}`;
}

// --------------------------------------------------------------------------- random sources

/**
 * The extension's random source: 53 random bits from `crypto.getRandomValues` (`Math.random`
 * where crypto is missing), uniform in [0, 1).
 * @type {Rng}
 */
export function defaultRng() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const words = cryptoApi.getRandomValues(new Uint32Array(2));
    const high = /** @type {number} */ (words[0]) >>> 5; // 27 bits
    const low = /** @type {number} */ (words[1]) >>> 6; // 26 bits
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
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
