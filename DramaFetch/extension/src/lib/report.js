// @ts-check
/**
 * How complete a series is after a run, and the rows a run writes without a request: a port of
 * `engine.py`'s reporting (`series_report`, `report_rows`, `report_line`, `report_to_dict`,
 * `not_started_message`, `dedupe_refs`, the complete skip) and of `cli.batch_status`, with the
 * shared result builders of `downloader.py` / `engine.py` (`locked_result`, the manifest skip,
 * the DRM-memory skip, the stopped row). Pure: no `chrome.*`, no DOM; the per-series state comes
 * from `state.js` with an injected "file still exists" answer.
 */

import { UNCERTAIN_TEXT, countCheck, isLocked, makeEpisode, missingNumbers, otherItemsText } from "./catalog.js";
import {
  DRM_MARK,
  DRM_REMEMBERED_MESSAGE,
  DONE,
  ENDED_EARLY_TEXT,
  FAILED_UNAVAILABLE,
  MANIFEST_SKIP_PREFIX,
  NOT_LISTED_AGAIN_MESSAGE,
  NOT_LISTED_EARLY_END_MESSAGE,
  NOT_LISTED_MESSAGE,
  NOT_LISTED_PREFIX,
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
import { completeSince, completeTrusted, doneEntries, donePath, drmProtected, lockedNumbers, missingFiles } from "./state.js";

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
 * @property {boolean} endedEarly the listing ended before TikTok said the list was over
 *   (`Series.earlyEnd`) and the episodes listed do not reach TikTok's count — unknown, or above the
 *   highest number listed
 *   (3.0.1, `SeriesReport.ended_early`)
 * @property {number} lastListed the highest episode number listed (0: none, or never listed)
 * @property {number} guessedLocked the `skipped-locked` rows of FREE episodes DramaFetch only
 *   guessed were locked ({@link isGuessedLocked}; 3.0.1, `SeriesReport.guessed_locked`): counted
 *   apart from `locked` and against completeness
 * @property {number[]} guessedLockedNumbers their numbers, ascending
 * @property {boolean} [uncertain] TikTok counts more than the drama certainly has (3.0.1,
 *   `catalog.countCheck`; `SeriesReport.uncertain`): its count may include the other items it
 *   listed, or episodes past the highest number listed may be missing — never complete, no row for
 *   a number past `certainTop`, said in the line
 * @property {number} [otherItems] the drama's items received besides its episode numbers (a
 *   trailer, a highlight, …; `SeriesReport.other_items`)
 *
 * @typedef {object} SeriesRunLike What {@link batchStatus} and {@link notStartedMessage} read of a run.
 * @property {{seriesId: string}} ref
 * @property {Series | null} series
 * @property {SeriesReport} report
 * @property {string | null} error
 * @property {string | null} [errorKind]
 */

/**
 * What a report line says of the free episodes DramaFetch did not ask for because its own rules
 * guessed they were locked (3.0.1, `engine.NOT_ASKED_TEXT`): `1 free episode not asked for (17):
 * TikTok's list made it look locked`.
 */
export const NOT_ASKED_TEXT = "not asked for";

/** Largest episode number gaps are computed up to (`engine.MAX_EPISODE_NUMBER`). */
export const MAX_EPISODE_NUMBER = 10_000;
/** At most this many ranges of numbers in a report line; the rest becomes "…". */
const MAX_REPORT_RANGES = 10;
/**
 * `SeriesRun.error_kind` values the extension uses: `engine.ERROR_KINDS` less `cookies`, plus its
 * own `storage` (a series refused because `chrome.storage.local` would not store its progress).
 */
export const ERROR_KINDS = Object.freeze(
  /** @type {const} */ (["cooldown", "login", "captcha", "rate-limited", "discovery", "empty", "not-started", "storage"]),
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

/**
 * Whether `result` is the row of a FREE episode DramaFetch skipped only because its own rules
 * guessed it was locked (3.0.1, `engine.is_guessed_locked`): `skipped-locked` for an episode whose
 * `guessedLock` is set (`catalog.accessOf`: a short header and/or no play address, with no DRM,
 * price, entitlement or TikTok lock clue) — not the skip of a DRM verdict an earlier download left
 * in the state ({@link drmMemorySkip}), which is a fact, not a guess. {@link seriesReport} counts
 * such a row as NOT downloaded.
 * @param {{status: string, message: string, episode: {guessedLock?: boolean, access: string, drm: boolean, paid: boolean}}} result
 * @returns {boolean}
 */
export function isGuessedLocked(result) {
  const { episode } = result;
  return (
    result.status === SKIPPED_LOCKED &&
    episode.guessedLock === true &&
    episode.access === "locked" &&
    !episode.drm &&
    !episode.paid &&
    result.message !== DRM_REMEMBERED_MESSAGE
  );
}

// ------------------------------------------------------------------------ reports

/**
 * The {@link SeriesReport} of a series and the results of its run (`engine.series_report`).
 * `series` is null when it was never resolved (skipped as complete, refused by a cooldown, a
 * failed resolve, not started); the id and name then come from `seriesId` / `name`, else from
 * the first result's episode. Gaps are computed up to {@link MAX_EPISODE_NUMBER} at most: since
 * 3.0.1 up to `catalog.countCheck`'s `certainTop` (TikTok's count less the drama's other items
 * received, so a count that may include a trailer raises no number it cannot place), plus the
 * number of every failure row the list does not hold ({@link notListedResults}) — such a row counts
 * as missing from the list, not as failed —; a list that ended early short of TikTok's count
 * (unknown, or above the highest number listed) is incomplete too (`endedEarly`), and so is an
 * uncertain one (`uncertain`).
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
  // 3.0.1: a free episode DramaFetch only guessed was locked is not downloaded, apart from locked
  const guessed = [...rows.entries()].filter(([, row]) => isGuessedLocked(row)).map(([number]) => number).sort((a, b) => a - b);
  const guessedSet = new Set(guessed);
  const locked = numbersWhere((status) => status === SKIPPED_LOCKED).filter((number) => !guessedSet.has(number));
  // paid episodes the user's own account unlocked, among those obtained (downloaded or on disk)
  const unlocked = [...new Set([...done, ...onDisk])]
    .sort((a, b) => a - b)
    .filter((number) => /** @type {DownloadResult} */ (rows.get(number)).episode.access === "unlocked");
  if (series === null) {
    const failed = numbersWhere((status) => !isOk(status));
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
      endedEarly: false,
      lastListed: 0,
      guessedLocked: guessed.length,
      guessedLockedNumbers: guessed,
      uncertain: false,
      otherItems: 0,
    };
  }
  const numbers = new Set(series.episodes.map((episode) => episode.number));
  const listed = series.episodes.length;
  const hint = series.totalHint && series.totalHint > 0 ? series.totalHint : null;
  // THE count rule (catalog.countCheck): the numbers certainly an episode of the drama, and whether
  // TikTok counts more than that (its count may include the other items it listed)
  const check = countCheck(numbers, hint, series.itemsReceived ?? null, series.highlightNumbers ?? []);
  // a failure row of a number the list does not hold: missing from TikTok's list, not a failure
  const unlisted = new Set(
    numbersWhere((status) => !isOk(status)).filter((number) => !numbers.has(number) && number > 0 && number <= MAX_EPISODE_NUMBER),
  );
  const failed = numbersWhere((status) => !isOk(status)).filter((number) => !unlisted.has(number));
  // every number from 1 up to the highest one certainly an episode, or wanted (such a row's), that
  // the list does not hold
  let top = check.certainTop;
  for (const number of unlisted) if (number > top) top = number;
  top = Math.min(top, MAX_EPISODE_NUMBER);
  /** @type {number[]} */
  const gaps = [];
  for (let number = 1; number <= top; number += 1) if (!numbers.has(number)) gaps.push(number);
  let lastListed = 0;
  for (const number of numbers) if (number > lastListed) lastListed = number;
  const highest = Math.max(lastListed, check.certainTop, gaps.length > 0 ? /** @type {number} */ (gaps[gaps.length - 1]) : 0);
  // the list ended before TikTok said it was over, and the episodes listed do not reach its count
  const endedEarly = (series.earlyEnd ?? null) !== null && (hint === null || hint > lastListed);
  const obtained = new Set([...done, ...onDisk]);
  // What cannot be downloaded is left out of "every downloadable episode is on disk": a locked
  // episode, and one this run skipped as locked although its payload reads as playable (a DRM
  // verdict the state remembers; it is counted in `locked` all the same). A free episode
  // DramaFetch only GUESSED was locked (3.0.1, `guessed`) is not left out: while one is not on
  // disk the series is not complete.
  const skippedLocked = new Set(locked);
  const complete =
    listed > 0 &&
    series.episodes
      .filter((episode) => !isLocked(episode) && !skippedLocked.has(episode.number))
      .every((episode) => obtained.has(episode.number)) &&
    failed.length === 0 &&
    guessed.length === 0 &&
    gaps.length === 0 &&
    // more listed than TikTok announces stays incomplete; fewer is a gap, or uncertain
    (hint === null || listed <= hint) &&
    !endedEarly &&
    !check.uncertain;
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
    endedEarly,
    lastListed,
    guessedLocked: guessed.length,
    guessedLockedNumbers: guessed,
    uncertain: check.uncertain,
    otherItems: check.otherItems,
  };
}

/**
 * Whether a series' list itself is incomplete (3.0.1): it lacks a number — a hole, or one up to
 * TikTok's count less the drama's other items received (`Series.missingNumbers`, else computed as
 * `catalog.missingNumbers` does) —, it ended early (`Series.earlyEnd`) short of TikTok's count
 * (unknown, or above the highest number listed), or it is uncertain ({@link listUncertain}): what
 * makes {@link seriesReport} say `gaps`, `endedEarly` or `uncertain`, whatever the downloads did —
 * and the list's warnings warn-coloured, the report saved.
 * @param {Series} series
 * @returns {boolean}
 */
export function listIncomplete(series) {
  if (listMissing(series).length > 0) return true;
  if (listUncertain(series)) return true;
  const hint = series.totalHint && series.totalHint > 0 ? series.totalHint : null;
  let lastListed = 0;
  for (const episode of series.episodes) if (episode.number > lastListed) lastListed = episode.number;
  return (series.earlyEnd ?? null) !== null && (hint === null || hint > lastListed);
}

/**
 * Whether TikTok counts more than a series' list can place (3.0.1, `catalog.countCheck`'s
 * `uncertain`): its count may include the trailer or highlight it listed, or episodes past the
 * highest number listed may be missing.
 * @param {Series} series
 * @returns {boolean}
 */
export function listUncertain(series) {
  return countCheck(
    series.episodes.map((episode) => episode.number),
    series.totalHint,
    series.itemsReceived ?? null,
    series.highlightNumbers ?? [],
  ).uncertain;
}

/**
 * The drama's items received besides its episode numbers (3.0.1, `catalog.countCheck`'s
 * `otherItems`): a trailer, a highlight, an item left out for another one's number, one without a
 * number or an id.
 * @param {Series} series
 * @returns {number}
 */
export function listOtherItems(series) {
  return countCheck(
    series.episodes.map((episode) => episode.number),
    series.totalHint,
    series.itemsReceived ?? null,
    series.highlightNumbers ?? [],
  ).otherItems;
}

/**
 * The numbers a series' list lacks (3.0.1): `Series.missingNumbers` as the discovery left it after
 * its gap filling, else — a series built by hand — computed as `catalog.missingNumbers` does.
 * @param {Series} series
 * @returns {number[]}
 */
export function listMissing(series) {
  if (series.missingNumbers !== undefined) return [...series.missingNumbers];
  const hint = series.totalHint && series.totalHint > 0 ? series.totalHint : null;
  return missingNumbers(
    series.episodes.map((episode) => episode.number),
    hint,
    series.itemsReceived ?? null,
    MAX_EPISODE_NUMBER,
    series.highlightNumbers ?? [],
  );
}

/**
 * Whether a row is the row of an episode TikTok's list lacks ({@link notListedResults}, 3.0.1;
 * `engine.is_not_listed`): `failed-unavailable` with a message that starts with
 * `messages.NOT_LISTED_PREFIX` — made without a request.
 * @param {{status: string, message: string}} result
 * @returns {boolean}
 */
export function isNotListed(result) {
  return result.status === FAILED_UNAVAILABLE && result.message.startsWith(NOT_LISTED_PREFIX);
}

/**
 * At most this many rows {@link notListedResults} makes for one series (the lowest numbers;
 * `engine.MAX_NOT_LISTED_ROWS`): more missing numbers come from an absurd number in a payload — the
 * report line still names them all.
 */
export const MAX_NOT_LISTED_ROWS = 500;

/**
 * One `failed-unavailable` row per number of `numbers` that `series` does not list
 * (`engine.not_listed_results`; 3.0.1, the owner's report of 2026-11-27: an episode missing from
 * TikTok's list gets a row of its own, never silence) — ascending, each number once, between 1 and
 * {@link MAX_EPISODE_NUMBER}, at most {@link MAX_NOT_LISTED_ROWS} — made without a request: no
 * pause, nothing counted, never recorded in the state. The message says why: `again` (a
 * selection's wanted number its fresh list lacks) {@link NOT_LISTED_AGAIN_MESSAGE}, else
 * {@link NOT_LISTED_EARLY_END_MESSAGE} for a number past the highest one listed when the listing
 * ended early (`Series.earlyEnd`), else {@link NOT_LISTED_MESSAGE}. The row's episode has the
 * number, the series' id and name, and nothing else (no item id: TikTok's list named none).
 * @param {Series} series
 * @param {Iterable<number>} numbers
 * @param {{again?: boolean}} [options]
 * @returns {DownloadResult[]}
 */
export function notListedResults(series, numbers, options = {}) {
  const listed = new Set(series.episodes.map((episode) => episode.number));
  let last = 0;
  for (const number of listed) if (number > last) last = number;
  const endedEarly = (series.earlyEnd ?? null) !== null;
  const wanted = [...new Set(numbers)]
    .filter((number) => Number.isInteger(number) && number > 0 && number <= MAX_EPISODE_NUMBER && !listed.has(number))
    .sort((a, b) => a - b);
  return wanted.slice(0, MAX_NOT_LISTED_ROWS).map((number) => {
    let message = NOT_LISTED_MESSAGE;
    if (options.again === true) message = NOT_LISTED_AGAIN_MESSAGE;
    else if (endedEarly && number > last) message = NOT_LISTED_EARLY_END_MESSAGE;
    const episode = makeEpisode({ number, itemId: "", title: "", seriesId: series.seriesId, seriesName: series.name });
    return { episode, status: FAILED_UNAVAILABLE, path: null, message };
  });
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
 * --recheck looks again`. A list that ended early (`endedEarly`, 3.0.1) names apart what it did
 * not bring past the highest number listed — `incomplete: 60 of 62 — TikTok's list ended early:
 * episodes 61, 62 not received` ({@link ENDED_EARLY_TEXT}), its holes below that number still
 * `missing from TikTok's list` — or, when TikTok's count is unknown, where it ended: `incomplete:
 * 60 of 60 — TikTok's list ended early after episode 60`. The free episodes DramaFetch only guessed
 * were locked (`guessedLocked`, 3.0.1) have a group of their own after the counts: `incomplete: 2 of
 * 3 — 1 free episode not asked for (3): TikTok's list made it look locked`. An uncertain list
 * (`uncertain`, 3.0.1) says what TikTok counts and what was listed: `incomplete: 65 of 65 — TikTok's
 * list may be incomplete: TikTok counts 66 episodes, 65 listed and 1 other item (a trailer or a
 * highlight)`.
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
  const rest = report.listed - have - report.locked - (report.guessedLocked ?? 0) - report.failed;
  if (rest > 0) details.push(`${rest} not downloaded`);
  const groups = details.length > 0 ? [details.join(", ")] : [];
  if ((report.guessedLocked ?? 0) > 0) groups.push(notAskedText(report.guessedLockedNumbers ?? []));
  if (report.endedEarly) {
    const holes = report.gaps.filter((number) => number < report.lastListed);
    const unreceived = report.gaps.filter((number) => number > report.lastListed);
    if (holes.length > 0) groups.push(missingText(holes));
    if (unreceived.length > 0) {
      const noun = unreceived.length === 1 ? "episode" : "episodes";
      groups.push(`${ENDED_EARLY_TEXT}: ${noun} ${numbersText(unreceived)} not received`);
    } else if (report.lastListed > 0) {
      groups.push(`${ENDED_EARLY_TEXT} after episode ${report.lastListed}`);
    } else {
      groups.push(ENDED_EARLY_TEXT);
    }
  } else if (report.gaps.length > 0) {
    groups.push(missingText(report.gaps));
  }
  if (report.uncertain === true && report.totalHint) {
    groups.push(uncertainLineText(report.totalHint, report.listed, report.otherItems ?? 0));
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
 * `1 free episode not asked for (17): TikTok's list made it look locked` / `2 free episodes not
 * asked for (3, 17): TikTok's list made them look locked` (3.0.1, `engine._not_asked_text`,
 * {@link NOT_ASKED_TEXT}): the free episodes DramaFetch's own rules guessed were locked.
 * @param {readonly number[]} numbers
 * @returns {string}
 */
function notAskedText(numbers) {
  const one = numbers.length === 1;
  return `${numbers.length} free ${one ? "episode" : "episodes"} ${NOT_ASKED_TEXT} (${numbersText(numbers)}): TikTok's list made ${one ? "it" : "them"} look locked`;
}

/**
 * `TikTok's list may be incomplete: TikTok counts 66 episodes, 65 listed and 1 other item (a trailer
 * or a highlight)` (3.0.1, `engine._uncertain_text`, `catalog.UNCERTAIN_TEXT`): an uncertain list, in
 * a report line.
 * @param {number} total
 * @param {number} listed
 * @param {number} other
 * @returns {string}
 */
function uncertainLineText(total, listed, other) {
  return `${UNCERTAIN_TEXT}: TikTok counts ${total} ${total === 1 ? "episode" : "episodes"}, ${listed} listed and ${otherItemsText(other)}`;
}

/**
 * `episode 17 missing from TikTok's list` / `episodes 5, 6 missing from TikTok's list`
 * (`engine._missing_text`).
 * @param {readonly number[]} numbers
 * @returns {string}
 */
function missingText(numbers) {
  const noun = numbers.length === 1 ? "episode" : "episodes";
  return `${noun} ${numbersText(numbers)} missing from TikTok's list`;
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
    ended_early: report.endedEarly,
    last_listed: report.lastListed,
    guessed_locked: report.guessedLocked ?? 0,
    guessed_locked_numbers: [...(report.guessedLockedNumbers ?? [])],
    uncertain: report.uncertain ?? false,
    other_items: report.otherItems ?? 0,
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
 * — or null, and the series is resolved as usual. A mark written under another completeness rule
 * than `state.COMPLETE_RULE` (3.0.1: a mark of 3.0.0 or earlier carries none, `completeTrusted`)
 * never skips. Ask {@link completeSkipAllowed} first.
 * @param {SeriesState | null} state
 * @param {{seriesId: string, nowS: number, exists: FileExists}} context
 * @returns {CompleteSkip | null}
 */
export function completeSkip(state, context) {
  if (state === null || state.complete_episodes === null || state.complete_episodes === undefined) return null;
  if (!completeTrusted(state)) return null; // 3.0.1: a mark of an older completeness rule never skips
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
