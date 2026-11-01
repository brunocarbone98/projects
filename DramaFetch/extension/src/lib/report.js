// @ts-check
/**
 * How complete a series is after a run, and the rows a run writes without a request: a port of
 * `engine.py`'s reporting (`series_report`, `report_rows`, `report_line`, `report_to_dict`,
 * `not_started_message`, `dedupe_refs`, the complete skip) and of `cli.batch_status`, with the
 * shared result builders of `downloader.py` / `engine.py` (`locked_result`, the manifest skip,
 * the DRM-memory skip, the stopped row). Pure: no `chrome.*`, no DOM; the per-series state comes
 * from `state.js` with an injected "file still exists" answer.
 */

import { isLocked, makeEpisode } from "./catalog.js";
import {
  DRM_MARK,
  DRM_REMEMBERED_MESSAGE,
  DONE,
  MANIFEST_SKIP_PREFIX,
  PAYLOAD_DRM_MESSAGE,
  RECHECK_AFTER_S,
  RECHECK_HINT,
  SKIPPED_EXISTS,
  SKIPPED_LOCKED,
  STATUSES,
  STOPPED_PREFIX,
  isOk,
} from "./messages.js";
import { displayName, fileBaseName, fileStem } from "./naming.js";
import { completeSince, doneEntries, donePath, drmProtected, lockedNumbers, missingFiles } from "./state.js";

/**
 * @typedef {import("./catalog.js").Episode} Episode
 * @typedef {import("./catalog.js").Series} Series
 * @typedef {import("./messages.js").Status} Status
 * @typedef {import("./state.js").SeriesState} SeriesState
 * @typedef {import("./state.js").FileExists} FileExists
 *
 * @typedef {object} DownloadResult One episode's outcome (`models.DownloadResult`).
 * @property {Episode} episode
 * @property {Status} status
 * @property {string | null} [path] the saved file (Chrome's full path), when there is one
 * @property {string} message
 * @property {number | null} [downloadId] Chrome's download id of the saved file
 *
 * @typedef {object} SeriesReport How complete a series is (`engine.SeriesReport`).
 * @property {string} seriesId
 * @property {string | null} name
 * @property {number} listed
 * @property {number} done
 * @property {number} onDisk
 * @property {number} locked
 * @property {number} failed
 * @property {number[]} gaps
 * @property {boolean} complete
 * @property {boolean} skippedComplete
 * @property {string | null} stopped
 * @property {number} total
 * @property {number[]} lockedNumbers
 * @property {number[]} failedNumbers
 * @property {number | null} totalHint
 * @property {number | null} checkedAgoS
 * @property {number} unlocked
 * @property {number[]} unlockedNumbers
 *
 * @typedef {object} SeriesRunLike What {@link batchStatus} and {@link notStartedMessage} read of a run.
 * @property {{seriesId: string}} ref
 * @property {Series | null} series
 * @property {SeriesReport} report
 * @property {string | null} error
 * @property {string | null} [errorKind]
 */

/** Largest episode number gaps are computed up to (`engine.MAX_EPISODE_NUMBER`). */
export const MAX_EPISODE_NUMBER = 10_000;
/** At most this many ranges of numbers in a report line; the rest becomes "…". */
const MAX_REPORT_RANGES = 10;
/** `SeriesRun.error_kind` values the extension uses (`engine.ERROR_KINDS` less `cookies`). */
export const ERROR_KINDS = Object.freeze(
  /** @type {const} */ (["cooldown", "login", "captcha", "rate-limited", "discovery", "empty", "not-started"]),
);

// ------------------------------------------------------------------------ result builders

/**
 * The SKIPPED_LOCKED result of a locked episode (`downloader.locked_result`): `looks locked:
 * <hints>`, or for a payload DRM flag `protected by DRM (<hints>): DramaFetch does not decrypt it`
 * (`PAYLOAD_DRM_MESSAGE` without hints) — never remembered as a DRM verdict.
 * @param {Episode} episode
 * @returns {DownloadResult}
 */
export function lockedResult(episode) {
  const hints = episode.lockHints.join("; ");
  let message;
  if (episode.drm && hints) message = `${DRM_MARK} (${hints}): DramaFetch does not decrypt it`;
  else if (episode.drm) message = PAYLOAD_DRM_MESSAGE;
  else message = hints ? `looks locked: ${hints}` : "looks locked";
  return { episode, status: SKIPPED_LOCKED, path: null, message };
}

/**
 * The SKIPPED_EXISTS row of an episode the state knows to be on disk (`engine._manifest_skip`):
 * `already downloaded (manifest): <file name>`.
 * @param {Episode} episode
 * @param {string} path
 * @returns {DownloadResult}
 */
export function manifestSkip(episode, path) {
  return { episode, status: SKIPPED_EXISTS, path, message: `${MANIFEST_SKIP_PREFIX}${fileBaseName(path)}` };
}

/**
 * The SKIPPED_LOCKED row of an episode an earlier run's DOWNLOAD found encrypted
 * (`engine._drm_memory_skip`): no request, no pause, nothing counted.
 * @param {Episode} episode
 * @returns {DownloadResult}
 */
export function drmMemorySkip(episode) {
  return { episode, status: SKIPPED_LOCKED, path: null, message: DRM_REMEMBERED_MESSAGE };
}

/**
 * The row of an episode a run gave up on before reaching it (`engine._stopped_result`): the skip
 * it would have had anyway — done in the state (file still there), remembered as DRM, locked, its
 * file already saved (`existingResult`, the downloader's no-request check) — else `status` with
 * `stopped: <reason>`. Never overwrites the DRM memory of an episode.
 * @param {Episode} episode
 * @param {Status} status
 * @param {string} reason
 * @param {{state: SeriesState, exists: FileExists, includeLocked?: boolean, overwrite?: boolean,
 *   existingResult?: (episode: Episode) => DownloadResult | null}} context
 * @returns {DownloadResult}
 */
export function stoppedResult(episode, status, reason, context) {
  const done = context.overwrite ? null : donePath(context.state, episode.number, context.exists);
  if (done !== null) return manifestSkip(episode, done);
  if (!context.includeLocked && drmProtected(context.state, episode.number)) return drmMemorySkip(episode);
  if (isLocked(episode) && !context.includeLocked) return lockedResult(episode);
  const existing = context.overwrite || !context.existingResult ? null : context.existingResult(episode);
  if (existing !== null) return existing;
  return { episode, status, path: null, message: `${STOPPED_PREFIX}${reason}` };
}

/**
 * `{"done": 3, "skipped-locked": 1, …}`: the statuses that occurred, in `DownloadStatus` order.
 * @param {readonly DownloadResult[]} results
 * @returns {Record<string, number>}
 */
export function summarize(results) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const status of STATUSES) {
    const count = results.filter((result) => result.status === status).length;
    if (count) counts[status] = count;
  }
  return counts;
}

// ------------------------------------------------------------------------ reports

/**
 * The {@link SeriesReport} of a series and the results of its run (`engine.series_report`).
 * `series` is null when it was never resolved (skipped as complete, refused by a cooldown, a
 * failed resolve, not started); the id and name then come from `seriesId` / `name`, else from
 * the first result's episode. Gaps are computed up to {@link MAX_EPISODE_NUMBER} at most.
 * @param {Series | null} series
 * @param {readonly DownloadResult[]} results
 * @param {{skippedComplete?: boolean, stopped?: string | null, seriesId?: string | null,
 *   name?: string | null, checkedAgoS?: number | null}} [options]
 * @returns {SeriesReport}
 */
export function seriesReport(series, results, options = {}) {
  const skippedComplete = options.skippedComplete ?? false;
  const stopped = options.stopped ?? null;
  const checkedAgoS = options.checkedAgoS ?? null;
  const first = results.length > 0 ? /** @type {DownloadResult} */ (results[0]).episode : null;
  let reportId;
  let reportName;
  if (series !== null) {
    reportId = series.seriesId;
    reportName = series.name;
  } else {
    reportId = options.seriesId || (first !== null ? first.seriesId : "");
    reportName = options.name ?? (first !== null ? first.seriesName : null);
  }
  /** @type {Map<number, DownloadResult>} */
  const rows = new Map();
  for (const result of results) rows.set(result.episode.number, result);
  /** @param {(status: string) => boolean} test */
  const numbersWhere = (test) =>
    [...rows.entries()].filter(([, row]) => test(row.status)).map(([number]) => number).sort((a, b) => a - b);
  const done = numbersWhere((status) => status === DONE);
  const onDisk = numbersWhere((status) => status === SKIPPED_EXISTS);
  const locked = numbersWhere((status) => status === SKIPPED_LOCKED);
  const failed = numbersWhere((status) => !isOk(status));
  // paid episodes the user's own account unlocked, among those obtained (downloaded or on disk)
  const unlocked = [...new Set([...done, ...onDisk])]
    .sort((a, b) => a - b)
    .filter((number) => /** @type {DownloadResult} */ (rows.get(number)).episode.access === "unlocked");
  if (series === null) {
    return {
      seriesId: reportId,
      name: reportName,
      listed: 0,
      done: done.length,
      onDisk: onDisk.length,
      locked: locked.length,
      failed: failed.length,
      gaps: [],
      complete: skippedComplete,
      skippedComplete,
      stopped,
      total: skippedComplete ? done.length + onDisk.length : 0,
      lockedNumbers: locked,
      failedNumbers: failed,
      totalHint: null,
      checkedAgoS,
      unlocked: unlocked.length,
      unlockedNumbers: unlocked,
    };
  }
  const numbers = new Set(series.episodes.map((episode) => episode.number));
  const listed = series.episodes.length;
  const hint = series.totalHint && series.totalHint > 0 ? series.totalHint : null;
  let highest = hint ?? 0;
  for (const number of numbers) if (number > highest) highest = number;
  /** @type {number[]} */
  const gaps = [];
  for (let number = 1; number <= Math.min(highest, MAX_EPISODE_NUMBER); number += 1) {
    if (!numbers.has(number)) gaps.push(number);
  }
  const obtained = new Set([...done, ...onDisk]);
  // What cannot be downloaded is left out of "every downloadable episode is on disk": a locked
  // episode, and one this run skipped as locked although its payload reads as playable (a DRM
  // verdict the state remembers; it is counted in `locked` all the same).
  const skippedLocked = new Set(locked);
  const complete =
    listed > 0 &&
    series.episodes
      .filter((episode) => !isLocked(episode) && !skippedLocked.has(episode.number))
      .every((episode) => obtained.has(episode.number)) &&
    failed.length === 0 &&
    gaps.length === 0 &&
    (hint === null || listed === hint);
  return {
    seriesId: reportId,
    name: reportName,
    listed,
    done: done.length,
    onDisk: onDisk.length,
    locked: locked.length,
    failed: failed.length,
    gaps,
    complete,
    skippedComplete: false,
    stopped,
    total: Math.max(listed, highest),
    lockedNumbers: locked,
    failedNumbers: failed,
    totalHint: hint,
    checkedAgoS,
    unlocked: unlocked.length,
    unlockedNumbers: unlocked,
  };
}

/**
 * What the report of a run of a SELECTION counts (`engine.report_rows`): `results` plus, for every
 * listed episode they do not cover, a SKIPPED_EXISTS row when the state knows it to be on disk,
 * else a SKIPPED_LOCKED row when the state remembers it as DRM or it is locked — so the report is
 * the whole series'. `results` itself is not changed.
 * @param {Series} series
 * @param {readonly DownloadResult[]} results
 * @param {SeriesState | null} state
 * @param {FileExists} exists
 * @returns {DownloadResult[]}
 */
export function reportRows(series, results, state, exists) {
  const covered = new Set(results.map((result) => result.episode.number));
  const onDisk = new Map(state !== null ? doneEntries(state, exists) : []);
  /** @type {DownloadResult[]} */
  const extra = [];
  for (const episode of [...series.episodes].sort((a, b) => a.number - b.number)) {
    if (covered.has(episode.number)) continue;
    const path = onDisk.get(episode.number);
    if (path !== undefined) extra.push(manifestSkip(episode, path));
    else if (state !== null && drmProtected(state, episode.number)) extra.push(drmMemorySkip(episode));
    else if (isLocked(episode)) extra.push(lockedResult(episode));
  }
  return [...results, ...extra];
}

/**
 * `[1, 2, 3, 7, 9, 10]` → `[[1, 3], [7, 7], [9, 10]]` (input sorted; `engine.compress_ranges`).
 * @param {readonly number[]} numbers
 * @returns {[number, number][]}
 */
export function compressRanges(numbers) {
  /** @type {[number, number][]} */
  const ranges = [];
  for (const number of numbers) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && number === last[1] + 1) last[1] = number;
    else if (last === undefined || number > last[1]) ranges.push([number, number]);
  }
  return ranges;
}

/**
 * `[5, 6]` → `"5, 6"`, `[1, 2, 3, 9]` → `"1-3, 9"`: runs of three or more as ranges, at most
 * ten of them (`engine._numbers_text`).
 * @param {readonly number[]} numbers
 * @returns {string}
 */
export function numbersText(numbers) {
  /** @type {string[]} */
  let parts = [];
  for (const [low, high] of compressRanges([...new Set(numbers)].sort((a, b) => a - b))) {
    if (low === high) parts.push(String(low));
    else if (high === low + 1) parts.push(String(low), String(high));
    else parts.push(`${low}-${high}`);
  }
  if (parts.length > MAX_REPORT_RANGES) parts = [...parts.slice(0, MAX_REPORT_RANGES), "…"];
  return parts.join(", ");
}

/**
 * Python's float `x // y` (`float_floor_div`): fmod-based, so a quotient rounded up to an integer
 * still floors like Python.
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function pyFloorDiv(x, y) {
  let mod = x % y;
  let div = (x - mod) / y;
  if (mod && y < 0 !== mod < 0) {
    mod += y;
    div -= 1;
  }
  if (!div) return 0;
  let floor = Math.floor(div);
  if (div - floor > 0.5) floor += 1;
  return floor;
}

/**
 * `"just now"`, `"5 min ago"`, `"2 h ago"` (`engine._ago`).
 * @param {number} seconds
 * @returns {string}
 */
export function ago(seconds) {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.trunc(pyFloorDiv(seconds, 60))} min ago`;
  return `${Math.trunc(pyFloorDiv(seconds, 3600))} h ago`;
}

/**
 * One line on how complete a series is (`engine.report_line`), e.g. `complete: 30 of 30 (28
 * downloaded, 2 already on disk)`, `complete: 3 of 4 (3 downloaded) — 1 paid episode your account
 * unlocked (3), 1 locked (4)`, `incomplete: 26 of 30 — 2 locked (5, 6), 1 failed (12); episode 17
 * missing from TikTok's list`, or for a series skipped as complete `complete, nothing to do: 3
 * episodes already on disk, 1 locked (4) (checked 2 h ago) — unlocked more in the TikTok app since?
 * --recheck looks again`.
 * @param {SeriesReport} report
 * @returns {string}
 */
export function reportLine(report) {
  const locked = `${report.locked} locked (${numbersText(report.lockedNumbers)})`;
  if (report.skippedComplete) {
    const noun = report.onDisk === 1 ? "episode" : "episodes";
    let line = `complete, nothing to do: ${report.onDisk} ${noun} already on disk`;
    if (report.locked) line += `, ${locked}`;
    if (report.checkedAgoS !== null) line += ` (checked ${ago(report.checkedAgoS)})`;
    if (report.locked) line += ` — ${RECHECK_HINT}`;
    return line;
  }
  const have = report.done + report.onDisk;
  const total = Math.max(report.total, have);
  const noun = report.unlocked === 1 ? "episode" : "episodes";
  const unlocked = `${report.unlocked} paid ${noun} your account unlocked (${numbersText(report.unlockedNumbers)})`;
  if (report.complete) {
    /** @type {string[]} */
    const obtained = [];
    if (report.done) obtained.push(`${report.done} downloaded`);
    if (report.onDisk) obtained.push(`${report.onDisk} already on disk`);
    let line = `complete: ${have} of ${total}`;
    if (obtained.length > 0) line += ` (${obtained.join(", ")})`;
    const notes = report.unlocked ? [unlocked] : [];
    if (report.locked) notes.push(locked);
    if (notes.length > 0) line += ` — ${notes.join(", ")}`;
    return line;
  }
  /** @type {string[]} */
  const details = [];
  if (report.unlocked) details.push(unlocked);
  if (report.locked) details.push(locked);
  if (report.failed) details.push(`${report.failed} failed (${numbersText(report.failedNumbers)})`);
  const rest = report.listed - have - report.locked - report.failed;
  if (rest > 0) details.push(`${rest} not downloaded`);
  const groups = details.length > 0 ? [details.join(", ")] : [];
  if (report.gaps.length > 0) {
    const gapNoun = report.gaps.length === 1 ? "episode" : "episodes";
    groups.push(`${gapNoun} ${numbersText(report.gaps)} missing from TikTok's list`);
  }
  if (report.totalHint && report.listed > report.totalHint) {
    groups.push(`TikTok announces ${report.totalHint} episodes, ${report.listed} listed`);
  }
  if (report.listed === 0) groups.push("no episodes listed");
  if (report.stopped) groups.push(`stopped: ${report.stopped}`);
  let line = `incomplete: ${have} of ${total}`;
  if (groups.length > 0) line += ` — ${groups.join("; ")}`;
  return line;
}

/**
 * JSON-friendly view of a report with the Python tool's keys (`engine.report_to_dict`) plus its
 * {@link reportLine} as `line`.
 * @param {SeriesReport} report
 * @returns {Record<string, unknown>}
 */
export function reportToDict(report) {
  return {
    series_id: report.seriesId,
    name: report.name,
    listed: report.listed,
    done: report.done,
    on_disk: report.onDisk,
    locked: report.locked,
    failed: report.failed,
    gaps: [...report.gaps],
    complete: report.complete,
    skipped_complete: report.skippedComplete,
    stopped: report.stopped,
    total: report.total,
    locked_numbers: [...report.lockedNumbers],
    failed_numbers: [...report.failedNumbers],
    total_hint: report.totalHint,
    checked_ago_s: report.checkedAgoS,
    unlocked: report.unlocked,
    unlocked_numbers: [...report.unlockedNumbers],
    line: reportLine(report),
  };
}

// ------------------------------------------------------------------------ batches

/**
 * The status of a series in the batch table (`cli.batch_status`): `complete`, `incomplete`,
 * `skipped (complete)`, `failed: <error>` or `not started`.
 * @param {SeriesRunLike} run
 * @returns {string}
 */
export function batchStatus(run) {
  if (run.errorKind === "not-started") return "not started";
  if (run.error !== null && run.error !== undefined) return `failed: ${run.error}`;
  if (run.report.skippedComplete) return "skipped (complete)";
  return run.report.complete ? "complete" : "incomplete";
}

/**
 * `not started: batch stopped in <name or id> (<reason>)` — the error of every series a stop left
 * untouched (`engine.not_started_message`).
 * @param {SeriesRunLike} stopping
 * @returns {string}
 */
export function notStartedMessage(stopping) {
  const where = stopping.report.name || (stopping.series !== null ? stopping.series.name : null);
  const reason = stopping.report.stopped || stopping.error || "stopped";
  return `not started: batch stopped in ${where || stopping.ref.seriesId} (${reason})`;
}

/**
 * The refs without repeated series (the first occurrence of each id kept, in order) and one note
 * per dropped one: `duplicate: <series id>` (`engine.dedupe_refs`).
 * @template {{seriesId: string}} T
 * @param {readonly T[]} refs
 * @returns {{kept: T[], notes: string[]}}
 */
export function dedupeRefs(refs) {
  /** @type {T[]} */
  const kept = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const ref of refs) {
    if (seen.has(ref.seriesId)) {
      notes.push(`duplicate: ${ref.seriesId}`);
      continue;
    }
    seen.add(ref.seriesId);
    kept.push(ref);
  }
  return { kept, notes };
}

/**
 * Whether the complete skip may apply (`engine._complete_skip_allowed`): a whole-series run only —
 * never with a selection of episodes, `recheck`, `overwrite`, `includeLocked` or a dry run.
 * @param {readonly number[] | null | undefined} selection the chosen episode numbers, null for the whole series
 * @param {{recheck?: boolean, overwrite?: boolean, includeLocked?: boolean, dryRun?: boolean}} options
 * @returns {boolean}
 */
export function completeSkipAllowed(selection, options) {
  if (selection !== null && selection !== undefined) return false;
  return !(options.recheck || options.overwrite || options.includeLocked || options.dryRun);
}

/**
 * @typedef {object} CompleteSkip What {@link completeSkip} rebuilds from the state, no request made.
 * @property {DownloadResult[]} results `skipped-exists` rows, `already downloaded (manifest): <file>`
 * @property {SeriesReport} report `skippedComplete`; its `locked` the state's `skipped-locked` entries
 * @property {string} name the display name
 * @property {Episode[]} episodes
 */

/**
 * The run of a series its state says was complete less than `RECHECK_AFTER_S` (24 h) before
 * `nowS`, every file it counted still on disk and at least one there (`engine._skip_if_complete`)
 * — or null, and the series is resolved as usual. Ask {@link completeSkipAllowed} first.
 * @param {SeriesState | null} state
 * @param {{seriesId: string, nowS: number, exists: FileExists}} context
 * @returns {CompleteSkip | null}
 */
export function completeSkip(state, context) {
  if (state === null || state.complete_episodes === null || state.complete_episodes === undefined) return null;
  const since = completeSince(state);
  if (since === null) return null;
  const age = context.nowS - since;
  if (!(age >= 0 && age < RECHECK_AFTER_S)) return null;
  if (missingFiles(state, context.exists).length > 0) return null; // a file is gone: download it again
  const entries = doneEntries(state, context.exists);
  if (entries.length === 0 || entries.length < state.complete_episodes) return null;
  const name = state.series_name;
  const results = entries.map(([number, path]) =>
    manifestSkip(
      makeEpisode({
        number,
        itemId: /** @type {import("./state.js").StateEntry} */ (state.episodes[String(number)]).item_id,
        title: fileStem(path),
        seriesId: context.seriesId,
        seriesName: name,
      }),
      path,
    ),
  );
  let report = seriesReport(null, results, {
    skippedComplete: true,
    seriesId: context.seriesId,
    name,
    checkedAgoS: age,
  });
  const onDisk = new Set(entries.map(([number]) => number));
  const stillLocked = lockedNumbers(state).filter((number) => !onDisk.has(number));
  if (stillLocked.length > 0) report = { ...report, locked: stillLocked.length, lockedNumbers: stillLocked };
  return {
    results,
    report,
    name: displayName(name, context.seriesId),
    episodes: results.map((result) => result.episode),
  };
}
