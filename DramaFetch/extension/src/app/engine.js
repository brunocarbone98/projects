// @ts-check
/**
 * The engine of the app page: a faithful port of `engine.download_series`, `run_series` and
 * `run_batch`, plus the web job manager's rules for a selection (`web.jobs`: the rest between
 * jobs). Pacing is the whole anti-bot strategy — behave like one person watching:
 *
 * - one request at a time, one episode at a time, ascending; one `PacingState` for the app page's
 *   whole life (persisted by the caller), so the long break and the failure streak span series
 *   and jobs;
 * - the pause before every network attempt (none before a series' first unless the long break is
 *   due), the rest every `restEvery` attempts, the human pace, the long break every
 *   `longRestEvery` attempts of the run (an idle gap of `longRestMinS` counts as that break);
 * - the cooldown asked before every series and again right before every network attempt, after its
 *   pause: one recorded meanwhile stops the run (`cooldown until HH:MM`);
 * - a stop status (login, captcha, HTTP 429) records the cooldown once (429 / captcha) and marks
 *   the rest `stopped: …` with no request; 3 failures in a row (across the series of a run) stop
 *   it too — an HTTP 403, 404 or 410 on a video URL is not a stop (the browser engine's rule: the
 *   next URL, then one fresh list, then `failed-unavailable`, which counts toward the three);
 * - a batch resolves each series right before its own downloads (never every list up front), rests
 *   between two series that contact TikTok (or takes the long break there, before the resolve),
 *   and after any stop marks every remaining series `not started: batch stopped in <name>
 *   (<reason>)` with no request; a series complete less than 24 h ago with every file still there
 *   costs no request at all (whole-series runs only).
 *
 * Every pause is announced (`onPause`) and slept through the injected `sleep`; the state is saved
 * after every episode, so closing the tab loses nothing and the next run resumes. Timers in a
 * background tab may fire late: that only lengthens a pause, nothing ever "catches up".
 */

import { activeCooldown, cooldownMessage, cooldownStopReason, recordBlock } from "../lib/cooldown.js";
import { FAILED_BLOCKED, FAILED_LOGIN, FAILED_RATE_LIMITED, isOk } from "../lib/messages.js";
import { displayName, seriesFolder } from "../lib/naming.js";
import {
  LONG_REST,
  STOP_STATUSES,
  afterResult,
  pauseBeforeAttempt,
  pauseBetweenJobs,
  pauseBetweenSeries,
  pauseMessage,
  validatePacing,
} from "../lib/pacing.js";
import {
  completeSkip,
  completeSkipAllowed,
  drmMemorySkip,
  manifestSkip,
  notStartedMessage,
  reportRows,
  seriesReport,
  stoppedResult,
} from "../lib/report.js";
import { clearComplete, donePath, drmProtected, loadState, markComplete, readState, record } from "../lib/state.js";
import { ChallengeError, DiscoveryError, LoginRequiredError, RateLimitedError } from "./discovery.js";
import { oneLine } from "./downloader.js";

/** Exit codes, as the Python tool's (`engine.EXIT_*`): kept in every run for the batch table. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 2;
export const EXIT_LOGIN_REQUIRED = 3;
export const EXIT_DISCOVERY = 4;
export const EXIT_RATE_LIMITED = 5;
/** The cooldown source of a refusal met while downloading (`options.engine` of the browser engine). */
export const DOWNLOAD_SOURCE = "browser";
/** The cooldown source of a refusal met while listing a series. */
export const DISCOVERY_SOURCE = "discovery";

/**
 * @typedef {import("../lib/catalog.js").Episode} Episode
 * @typedef {import("../lib/catalog.js").Series} Series
 * @typedef {import("../lib/urls.js").SeriesRef} SeriesRef
 * @typedef {import("../lib/report.js").DownloadResult} DownloadResult
 * @typedef {import("../lib/report.js").SeriesReport} SeriesReport
 * @typedef {import("../lib/state.js").SeriesState} SeriesState
 * @typedef {import("../lib/pacing.js").PacingOptions} PacingOptions
 * @typedef {import("../lib/pacing.js").PacingState} PacingState
 * @typedef {import("../lib/pacing.js").Rng} Rng
 * @typedef {import("../lib/cooldown.js").CooldownStore} CooldownStore
 * @typedef {import("../lib/cooldown.js").Cooldown} Cooldown
 * @typedef {import("./downloader.js").Downloader} Downloader
 * @typedef {import("./downloader.js").DownloadsView} DownloadsView
 *
 * @typedef {object} SeriesStart What `onStart` gets before any row (`engine.SeriesStart`).
 * @property {SeriesRef} ref
 * @property {Series | null} series
 * @property {string} name the display name
 * @property {Episode[]} episodes what the run will go through
 * @property {boolean} skippedComplete
 *
 * @typedef {object} SeriesRun The outcome of one series (`engine.SeriesRun`).
 * @property {SeriesRef} ref
 * @property {Series | null} series
 * @property {DownloadResult[]} results
 * @property {SeriesReport} report
 * @property {string | null} error
 * @property {boolean} stop
 * @property {number} exitCode
 * @property {string | null} errorKind
 * @property {boolean} contacted
 *
 * @typedef {object} Engine Everything a run needs (injected: tests and the app page alike).
 * @property {PacingOptions} pacing the pacing knobs (validated)
 * @property {boolean} testMode whether the pacing may go below the floors
 * @property {boolean} includeLocked
 * @property {boolean} recheck
 * @property {PacingState} pacingState the run's pacing (one for the app page's life)
 * @property {Rng} rng
 * @property {(seconds: number) => Promise<void>} sleep
 * @property {() => number} clock seconds, for the pacing (wall clock: it is persisted)
 * @property {() => number} wallClock seconds since the epoch (complete marks, cooldowns)
 * @property {CooldownStore} cooldownStore
 * @property {(ref: SeriesRef) => Promise<Series>} discover
 * @property {Downloader} downloader
 * @property {DownloadsView} view
 * @property {(seriesId: string) => Promise<unknown>} readState
 * @property {(state: SeriesState) => Promise<void>} writeState
 * @property {() => Promise<void>} [persist] save the pacing (after every attempt and pause)
 * @property {() => boolean} [stopRequested] the user pressed Stop: end at the next checkpoint
 * @property {(kind: string, seconds: number, text: string) => void} [onPause]
 * @property {(result: DownloadResult) => void} [onResult]
 * @property {(start: SeriesStart) => void} [onStart]
 * @property {(index: number, total: number, ref: SeriesRef) => void} [onSeriesStart]
 * @property {(index: number, total: number, run: SeriesRun) => void} [onSeriesDone]
 */

/**
 * The cooldown in force, or null (`engine.check_cooldown`).
 * @param {Engine} engine
 * @returns {Promise<Cooldown | null>}
 */
export function checkCooldown(engine) {
  return activeCooldown(engine.cooldownStore, { now: engine.wallClock() });
}

/**
 * Announce a pause, sleep it, persist the pacing.
 * @param {Engine} engine
 * @param {string} kind
 * @param {number} seconds
 * @param {string} text
 * @returns {Promise<void>}
 */
async function takePause(engine, kind, seconds, text) {
  engine.onPause?.(kind, seconds, text);
  await engine.sleep(seconds);
  await engine.persist?.();
}

/**
 * 0 when all ok; 3 on any login failure; 5 when blocked or rate limited; 2 on other failures
 * (`engine.exit_code`).
 * @param {readonly DownloadResult[]} results
 * @returns {number}
 */
export function exitCode(results) {
  const statuses = new Set(results.map((result) => result.status));
  if (statuses.has(FAILED_LOGIN)) return EXIT_LOGIN_REQUIRED;
  if (statuses.has(FAILED_RATE_LIMITED) || statuses.has(FAILED_BLOCKED)) return EXIT_RATE_LIMITED;
  if ([...statuses].some((status) => !isOk(status))) return EXIT_FAILED;
  return EXIT_OK;
}

/**
 * The folder and `{series}` value of a series.
 * @param {Series} series
 * @returns {import("./downloader.js").EpisodeContext}
 */
export function episodeContext(series) {
  const name = displayName(series.name, series.seriesId);
  return { seriesName: name, folder: seriesFolder(name, series.seriesId) };
}

/**
 * Download the given episodes of a series, one at a time, ascending, resumably, paced
 * (`engine.download_series`). `state` is the series' state (loaded by the caller); every result
 * is recorded in it and saved. `beforeNetwork` (a selection job's rest) runs right before every
 * network attempt, after its pause. Returns the results and why the run stopped, if it did.
 * @param {Engine} engine
 * @param {Series} series
 * @param {readonly Episode[]} episodes
 * @param {SeriesState} state
 * @param {{beforeNetwork?: () => Promise<void>}} [hooks]
 * @returns {Promise<{results: DownloadResult[], stopped: string | null}>}
 */
export async function downloadSeries(engine, series, episodes, state, hooks = {}) {
  validatePacing(engine.pacing, { testMode: engine.testMode });
  const { downloader, view, pacingState: pacing, rng, clock } = engine;
  const exists = (/** @type {import("../lib/state.js").StateEntry} */ entry) => view.exists(entry);
  const context = episodeContext(series);
  const ordered = [...episodes].sort((a, b) => a.number - b.number);
  /** @type {DownloadResult[]} */
  const results = [];
  /** @type {string | null} */
  let stopped = null;

  /** @param {DownloadResult} result */
  const emit = async (result) => {
    results.push(result);
    if (record(state, result, { exists, now: engine.wallClock() })) await engine.writeState(state);
    engine.onResult?.(result);
  };
  /**
   * Mark the rest (`stopped: <reason>`, or the skip each would have had anyway), forget the
   * failure streak — the stop has been acted on — and remember why.
   * @param {readonly Episode[]} remaining
   * @param {import("../lib/messages.js").Status} status
   * @param {string} reason
   * @param {string} summary
   */
  const stop = async (remaining, status, reason, summary) => {
    for (const episode of remaining) {
      await emit(
        stoppedResult(episode, status, reason, {
          state,
          exists,
          includeLocked: engine.includeLocked,
          existingResult: (candidate) => downloader.existingResult(candidate, context),
        }),
      );
    }
    pacing.consecutiveFailures = 0;
    stopped = stopped ?? summary;
  };

  let networkAttempts = 0;
  /** @type {Episode | null} */
  let previous = null;
  for (let index = 0; index < ordered.length; index += 1) {
    if (engine.stopRequested?.()) throw new StopRequested();
    const episode = /** @type {Episode} */ (ordered[index]);
    const done = donePath(state, episode.number, exists);
    if (done !== null) {
      await emit(manifestSkip(episode, done));
      continue;
    }
    if (!engine.includeLocked && drmProtected(state, episode.number)) {
      await emit(drmMemorySkip(episode)); // an earlier run found it encrypted: no request, no pause
      continue;
    }
    if (downloader.needsNetwork(episode, context)) {
      const pause = pauseBeforeAttempt(engine.pacing, rng, pacing, clock, networkAttempts, previous);
      if (pause.seconds > 0) {
        const text = pauseMessage(pause.kind, pause.seconds, {
          downloads: networkAttempts,
          runAttempts: pacing.runAttempts,
        });
        await takePause(engine, pause.kind, pause.seconds, text);
      }
      if (hooks.beforeNetwork) await hooks.beforeNetwork();
      const active = await checkCooldown(engine);
      if (active !== null) {
        // TikTok refused a request meanwhile (another series, the popup's tab, a long break):
        // not one more request until the cooldown ends. Already recorded.
        const summary = cooldownStopReason(active);
        await stop(ordered.slice(index), FAILED_RATE_LIMITED, summary, summary);
        break;
      }
    }
    const result = await downloader.download(episode, context);
    await emit(result);
    const outcome = afterResult(engine.pacing, pacing, clock, result);
    if (outcome.network) {
      networkAttempts += 1;
      previous = episode;
      await engine.persist?.();
    }
    if (outcome.stop !== null) {
      if (outcome.stop.block) {
        await recordBlock(engine.cooldownStore, result.message || result.status, DOWNLOAD_SOURCE, {
          now: engine.wallClock(),
        });
      }
      await stop(ordered.slice(index + 1), /** @type {import("../lib/messages.js").Status} */ (outcome.stop.status), outcome.stop.reason, outcome.stop.summary);
      await engine.persist?.();
      break;
    }
  }
  return { results, stopped };
}

/**
 * `engine._stop_status_summary`: `episode N <status>` for the first stop status, or null.
 * @param {readonly DownloadResult[]} results
 * @returns {string | null}
 */
function stopStatusSummary(results) {
  for (const result of results) {
    if (STOP_STATUSES.has(result.status)) return `episode ${result.episode.number} ${result.status}`;
  }
  return null;
}

/**
 * @param {SeriesRef} ref
 * @param {Cooldown} cooldown
 * @param {number} now
 * @returns {SeriesRun}
 */
function cooldownRefusal(ref, cooldown, now) {
  return {
    ref,
    series: null,
    results: [],
    report: seriesReport(null, [], { seriesId: ref.seriesId, stopped: cooldownStopReason(cooldown) }),
    error: cooldownMessage(cooldown, { now }),
    stop: true,
    exitCode: EXIT_RATE_LIMITED,
    errorKind: "cooldown",
    contacted: false,
  };
}

/** Resolve errors → (kind, exit code, short reason), most specific first (`engine._RESOLVE_ERRORS`). */
const RESOLVE_ERRORS = /** @type {const} */ ([
  [LoginRequiredError, "login", EXIT_LOGIN_REQUIRED, "login required"],
  [ChallengeError, "captcha", EXIT_DISCOVERY, "captcha"],
  [RateLimitedError, "rate-limited", EXIT_RATE_LIMITED, "rate limited (HTTP 429)"],
  [DiscoveryError, "discovery", EXIT_DISCOVERY, "the episode list could not be fetched"],
]);

/**
 * @param {SeriesRef} ref
 * @param {DiscoveryError} error
 * @returns {SeriesRun}
 */
function resolveFailure(ref, error) {
  /** @type {[string, number, string]} */
  let found = ["discovery", EXIT_DISCOVERY, "the episode list could not be fetched"];
  for (const [type, kind, code, reason] of RESOLVE_ERRORS) {
    if (error instanceof type) {
      found = [kind, code, reason];
      break;
    }
  }
  return {
    ref,
    series: null,
    results: [],
    report: seriesReport(null, [], { seriesId: ref.seriesId, stopped: found[2] }),
    error: error.message || error.name,
    stop: true,
    exitCode: found[1],
    errorKind: found[0],
    contacted: true,
  };
}

/**
 * Resolve a series (`engine.resolve`): a refusal (HTTP 429, a captcha) records the cooldown
 * (source `discovery`) before the error goes on. Anything that is not a DiscoveryError becomes
 * one, so a batch never dies of an unexpected error.
 * @param {Engine} engine
 * @param {SeriesRef} ref
 * @returns {Promise<Series>}
 */
export async function resolve(engine, ref) {
  let series;
  try {
    series = await engine.discover(ref);
  } catch (error) {
    if (error instanceof RateLimitedError || error instanceof ChallengeError) {
      await recordBlock(engine.cooldownStore, error.message, DISCOVERY_SOURCE, { now: engine.wallClock() });
    }
    if (error instanceof DiscoveryError) throw error;
    if (error instanceof StopRequested) throw error;
    throw new DiscoveryError(`could not list the series: ${oneLine(error)}`);
  }
  if (series.name === null) series.name = series.episodes.find((episode) => episode.seriesName)?.seriesName ?? null;
  return series;
}

/**
 * One series, start to finish, resolved right before its downloads (`engine.run_series`, a
 * whole-series run): the cooldown (refused: no request) → the complete skip (no request, no tab)
 * → `beforeNetwork` (the batch rests there) + the cooldown again → the resolve → the downloads →
 * the report, and the complete mark set or cleared.
 * @param {Engine} engine
 * @param {SeriesRef} ref
 * @param {{beforeNetwork?: (() => Promise<void>) | null}} [hooks]
 * @returns {Promise<SeriesRun>}
 */
export async function runSeries(engine, ref, hooks = {}) {
  let cooldown = await checkCooldown(engine);
  if (cooldown !== null) return cooldownRefusal(ref, cooldown, engine.wallClock());
  const exists = (/** @type {import("../lib/state.js").StateEntry} */ entry) => engine.view.exists(entry);
  if (completeSkipAllowed(null, { recheck: engine.recheck, includeLocked: engine.includeLocked })) {
    await engine.view.refresh();
    const stored = readState(await engine.readState(ref.seriesId), ref.seriesId);
    const skipped = completeSkip(stored, { seriesId: ref.seriesId, nowS: engine.wallClock(), exists });
    if (skipped !== null) {
      engine.onStart?.({ ref, series: null, name: skipped.name, episodes: skipped.episodes, skippedComplete: true });
      for (const result of skipped.results) engine.onResult?.(result);
      return {
        ref,
        series: null,
        results: skipped.results,
        report: skipped.report,
        error: null,
        stop: false,
        exitCode: EXIT_OK,
        errorKind: null,
        contacted: false,
      };
    }
  }
  if (hooks.beforeNetwork) {
    await hooks.beforeNetwork();
    cooldown = await checkCooldown(engine); // a refusal may have been met meanwhile
    if (cooldown !== null) return cooldownRefusal(ref, cooldown, engine.wallClock());
  }
  let series;
  try {
    series = await resolve(engine, ref);
  } catch (error) {
    if (error instanceof DiscoveryError) return resolveFailure(ref, error);
    throw error;
  }
  const selected = [...series.episodes].sort((a, b) => a.number - b.number);
  engine.onStart?.({
    ref,
    series,
    name: displayName(series.name, series.seriesId),
    episodes: selected,
    skippedComplete: false,
  });
  if (series.episodes.length === 0) {
    return {
      ref,
      series,
      results: [],
      report: seriesReport(series, []),
      error: "no episodes listed",
      stop: false,
      exitCode: EXIT_DISCOVERY,
      errorKind: "empty",
      contacted: true,
    };
  }
  const state = loadState(await engine.readState(series.seriesId), series.seriesId, series.name);
  await engine.view.refresh();
  const { results, stopped: reported } = await downloadSeries(engine, series, selected, state);
  const stopped = reported ?? stopStatusSummary(results);
  const report = seriesReport(series, results, { stopped });
  if (report.complete) {
    markComplete(state, engine.wallClock(), report.done + report.onDisk);
    await engine.writeState(state);
  } else if (clearComplete(state)) {
    await engine.writeState(state);
  }
  return {
    ref,
    series,
    results,
    report,
    error: null,
    stop: stopped !== null,
    exitCode: exitCode(results),
    errorKind: null,
    contacted: true,
  };
}

/**
 * The rest between two series of a batch that contact TikTok (`engine._pause_between_series`):
 * `restMinS`–`restMaxS`, or the long break when it is due, taken BEFORE the resolve so the fresh
 * play URLs never wait through it (the count then starts again).
 * @param {Engine} engine
 * @returns {Promise<void>}
 */
export async function restBetweenSeries(engine) {
  const pause = pauseBetweenSeries(engine.pacing, engine.rng, engine.pacingState, engine.clock);
  if (pause.seconds > 0) {
    const text = pauseMessage(pause.kind, pause.seconds, { runAttempts: engine.pacingState.runAttempts });
    await takePause(engine, pause.kind, pause.seconds, text);
  }
  if (pause.kind === LONG_REST) {
    engine.pacingState.runAttempts = 0;
    await engine.persist?.();
  }
}

/**
 * The rest before a job's first request (`web.jobs.JobManager.before_network`): the long break
 * when due (batch jobs, before the first resolve), else — when the last job that contacted TikTok
 * finished at most `restMaxS` ago — `restMinS`–`restMaxS`; nothing otherwise.
 * @param {Engine} engine
 * @param {{lastContactAt: number | null, batchJob: boolean}} job
 * @returns {Promise<void>}
 */
export async function restBetweenJobs(engine, job) {
  const pause = pauseBetweenJobs(engine.pacing, engine.rng, engine.pacingState, engine.clock, job);
  if (pause === null) return;
  if (pause.seconds > 0) {
    const text = pauseMessage(pause.kind, pause.seconds, { runAttempts: engine.pacingState.runAttempts });
    await takePause(engine, pause.kind, pause.seconds, text);
  }
  if (pause.kind === LONG_REST) {
    engine.pacingState.runAttempts = 0;
    await engine.persist?.();
  }
}

/**
 * @param {SeriesRef} ref
 * @param {SeriesRun} stopping
 * @returns {SeriesRun}
 */
function notStarted(ref, stopping) {
  return {
    ref,
    series: null,
    results: [],
    report: seriesReport(null, [], { seriesId: ref.seriesId }),
    error: notStartedMessage(stopping),
    stop: false,
    exitCode: stopping.exitCode,
    errorKind: "not-started",
    contacted: false,
  };
}

/**
 * Several series, strictly one after the other (`engine.run_batch`); `refs` already de-duplicated.
 * The first series to contact TikTok gets `beforeFirstNetwork` (the job rest), every later one the
 * rest between series; after a stop every remaining series is `not started`, with no request.
 * @param {Engine} engine
 * @param {readonly SeriesRef[]} refs
 * @param {{beforeFirstNetwork?: () => Promise<void>}} [hooks]
 * @returns {Promise<SeriesRun[]>}
 */
export async function runBatch(engine, refs, hooks = {}) {
  validatePacing(engine.pacing, { testMode: engine.testMode });
  /** @type {SeriesRun[]} */
  const runs = [];
  let contacted = false;
  /** @type {SeriesRun | null} */
  let stopping = null;
  const total = refs.length;
  for (let index = 0; index < total; index += 1) {
    const ref = /** @type {SeriesRef} */ (refs[index]);
    if (engine.stopRequested?.()) throw new StopRequested();
    engine.onSeriesStart?.(index + 1, total, ref);
    /** @type {SeriesRun} */
    let run;
    if (stopping !== null) {
      run = notStarted(ref, stopping);
    } else {
      const rest = contacted ? () => restBetweenSeries(engine) : (hooks.beforeFirstNetwork ?? null);
      run = await runSeries(engine, ref, { beforeNetwork: rest });
      contacted = contacted || run.contacted;
      if (run.stop) stopping = run;
    }
    runs.push(run);
    engine.onSeriesDone?.(index + 1, total, run);
  }
  return runs;
}

/**
 * A selection of an already listed series (**Download all available** / **Download selected**,
 * the web's download job): the cooldown first (refused: no request), the job rest right before
 * the first request, the downloads, and a report over the whole series (`engine.report_rows`). No
 * complete mark: only a whole-series run sets one.
 * @param {Engine} engine
 * @param {Series} series
 * @param {readonly number[]} numbers
 * @param {{lastContactAt: number | null}} job
 * @returns {Promise<SeriesRun>}
 */
export async function runSelection(engine, series, numbers, job) {
  const ref = { kind: /** @type {const} */ ("series"), seriesId: series.seriesId, episodeHint: null, sourceUrl: series.seriesId };
  const cooldown = await checkCooldown(engine);
  if (cooldown !== null) return cooldownRefusal(ref, cooldown, engine.wallClock());
  const wanted = new Set(numbers);
  const selected = series.episodes.filter((episode) => wanted.has(episode.number)).sort((a, b) => a.number - b.number);
  engine.onStart?.({
    ref,
    series,
    name: displayName(series.name, series.seriesId),
    episodes: selected,
    skippedComplete: false,
  });
  const state = loadState(await engine.readState(series.seriesId), series.seriesId, series.name);
  await engine.view.refresh();
  let rested = false;
  const beforeNetwork = async () => {
    if (rested) return;
    rested = true;
    await restBetweenJobs(engine, { lastContactAt: job.lastContactAt, batchJob: false });
  };
  const { results, stopped: reported } = await downloadSeries(engine, series, selected, state, { beforeNetwork });
  const stopped = reported ?? stopStatusSummary(results);
  const exists = (/** @type {import("../lib/state.js").StateEntry} */ entry) => engine.view.exists(entry);
  const report = seriesReport(series, reportRows(series, results, state, exists), { stopped });
  return {
    ref,
    series,
    results,
    report,
    error: null,
    stop: stopped !== null,
    exitCode: exitCode(results),
    errorKind: null,
    contacted: rested,
  };
}

/**
 * A selection job (**Download all available** / **Download selected**): never from a list an
 * earlier job resolved — whoever is logged in to TikTok in this Chrome NOW decides what may be
 * played and with which signed URLs (the web's list cache serves a list only to the session that
 * resolved it; the extension cannot tell sessions apart, so it lists again) —, so the series is
 * listed right before its downloads: the cooldown (refused: no request), the rest between jobs or
 * the long break (before the list, so the fresh play URLs never wait through it), the cooldown
 * again, the resolve (a failure is the run's error and a stop, as in a batch), then
 * {@link runSelection} over the fresh list, whose access decisions apply: an episode it now calls
 * locked is `skipped-locked` unless includeLocked.
 * @param {Engine} engine
 * @param {SeriesRef} ref
 * @param {readonly number[]} numbers the episodes picked from the list shown
 * @param {{lastContactAt: number | null}} job when the last job contacted TikTok (the job rest)
 * @returns {Promise<SeriesRun>}
 */
export async function runSelectionJob(engine, ref, numbers, job) {
  let cooldown = await checkCooldown(engine);
  if (cooldown !== null) return cooldownRefusal(ref, cooldown, engine.wallClock());
  await restBetweenJobs(engine, { lastContactAt: job.lastContactAt, batchJob: true });
  cooldown = await checkCooldown(engine); // a refusal may have been met meanwhile
  if (cooldown !== null) return cooldownRefusal(ref, cooldown, engine.wallClock());
  let series;
  try {
    series = await resolve(engine, ref);
  } catch (error) {
    if (error instanceof DiscoveryError) return resolveFailure(ref, error);
    throw error;
  }
  const run = await runSelection(engine, series, numbers, { lastContactAt: null }); // rested already
  return { ...run, contacted: true };
}

/** The user asked the run to stop: it ends at the next pause or between two episodes. */
export class StopRequested extends Error {
  constructor() {
    super("stopped by you");
    this.name = "StopRequested";
  }
}
