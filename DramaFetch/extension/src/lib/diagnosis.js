// @ts-check
/**
 * The "did not download" report: for every episode a run did not download, what the list TikTok
 * served said of it, what DramaFetch asked and what came back (the downloader's attempt traces —
 * `src/app/downloader.js` records them, this module only reads them) and a probable cause. The
 * extension saves it as one JSON file under `DramaFetch/reports/` at the end of a run with at
 * least one failed episode (the `report` setting), or on **Save the report**; it is the thing to
 * attach when asking for help. Pure: no `chrome.*`, no DOM — it runs in Node and in the extension
 * alike.
 *
 * What the report holds, and what it never holds: the raw list items (`Episode.raw`) as TikTok
 * served them — the whole point: a payload field that makes DramaFetch call an episode locked, a
 * duration the media contradicts — which carry time-limited signed media links; the requests
 * made as `scheme://host/path` with their HTTP status and sizes, never a query string (TikTok
 * signs it), never a header value, never a cookie or a token. The causes are stored English texts
 * like every engine text and are never shown in the UI (so `lib/display` needs no rule for them).
 */

import {
  DONE,
  DRM_MARK,
  DRY_RUN,
  FAILED_BLOCKED,
  FAILED_LOGIN,
  FAILED_RATE_LIMITED,
  FAILED_UNAVAILABLE,
  INCOMPLETE_PREFIX,
  SKIPPED_EXISTS,
  SKIPPED_LOCKED,
  STOPPED_PREFIX,
} from "./messages.js";
import { chromeSafeFilename, downloadFilename } from "./naming.js";

/** The report's format version (`dramafetch_report`). */
export const REPORT_VERSION = 1;
/** The folder under `DramaFetch/` the reports go to. */
export const REPORTS_FOLDER = "reports";
/** The report's own one-line description (`what_this_is`). */
export const WHAT_THIS_IS =
  "The episodes of one run that did not download, what DramaFetch asked TikTok and what came back. " +
  "It holds the list entries TikTok served to your session (with their time-limited video links) " +
  "and never a cookie, a token or a request header.";

// ------------------------------------------------------------------- the probable causes
// Fixed parts of the texts of {@link probableCause}, one per rule, in the order the rules apply.

/** Rule 1: the run stopped before this episode; followed by ` (<the rest of the message>)`. */
export const NOT_ATTEMPTED_CAUSE = "not attempted: the run stopped before this episode";
/** Rule 2: HTTP 429 on the media. */
export const RATE_LIMITED_CAUSE =
  "TikTok limited the rate of requests (HTTP 429): the run stopped and the 30-minute cooldown " +
  "started; nothing is wrong with the episode";
/** Rule 3: HTTP 403 or a verification page. */
export const BLOCKED_CAUSE =
  "TikTok blocked or challenged the request (HTTP 403 or a verification page); the run stopped and " +
  "the cooldown started";
/** Rule 4: the session is not logged in. */
export const LOGIN_CAUSE = "the session is not logged in to TikTok (log in in a normal tab of this Chrome profile)";
/** Rule 5: encrypted media. */
export const DRM_CAUSE = "encrypted media (DRM): DramaFetch never decrypts or keeps it; retrying cannot change it";
/** Rule 6: `<prefix><hints or "no clue"><suffix>`. */
export const LOCKED_CAUSE_PREFIX = "listed as locked for this session: ";
export const LOCKED_CAUSE_SUFFIX =
  " — the list TikTok served to your session marks it so; unlock it in the TikTok app, then look again";
/** Rule 7, a shorter file: `TikTok served a preview: a complete MP4 of <a> s where the list announces <e> s. …`. */
export const PREVIEW_CAUSE_PREFIX = "TikTok served a preview: ";
export const PREVIEW_CAUSE_MIDDLE =
  ". That is what TikTok serves for an episode the account has not unlocked (Drama Pass, coins or an " +
  "unlock in the TikTok app); the list's marks for it: ";
/** Rule 7, a longer file: `the file lasts <a> s where the list announces <e> s<suffix>`. */
export const LONGER_FILE_CAUSE_SUFFIX = ": the list and the media disagree; the file was not kept as the episode";
/** Rule 8: `<prefix><N of M bytes | the transfer was cut short><suffix>`. */
export const CUT_SHORT_CAUSE_PREFIX = "the transfer was cut short (";
export const CUT_SHORT_CAUSE_SUFFIX = "): a network or server problem, worth a retry";
/** Rule 9: `<prefix><reason><suffix>`. */
export const INVALID_FILE_CAUSE_PREFIX = "the file TikTok served is not a valid episode video (";
export const INVALID_FILE_CAUSE_SUFFIX =
  "): worth one retry; if it repeats, the rendition TikTok serves this session is broken";
/** Rule 10: `<prefix><message><suffix>`. */
export const UNAVAILABLE_CAUSE_PREFIX = "no playable stream this session may use (";
export const UNAVAILABLE_CAUSE_SUFFIX =
  "): locked, region-restricted, not logged in, or TikTok served no video at any play URL";
/** Rule 11: `<prefix><message>`. */
export const FAILED_CAUSE_PREFIX = "download failed: ";

/** The verification reason of a file whose duration disagrees with the list (`lib/mp4.verifyVideo`). */
const DURATION_RE = /^duration (\d+(?:\.\d+)?) s, expected (\d+(?:\.\d+)?) s/;
/** The transfer check's reason: `truncated body (<N> of <M> bytes)` / `(the transfer was cut short)`. */
const TRUNCATED_RE = /truncated body \(([^)]*)\)/;

/**
 * @typedef {object} AttemptRecord One candidate play URL of an episode, as the downloader saw it.
 * @property {string} url the URL with its query stripped (`scheme://host/path`): TikTok signs the query
 * @property {string} host
 * @property {number | null} url_expiry the URL's `expire`, when it has one
 * @property {boolean} requested false when the URL was never requested (a host the manifest does not cover)
 * @property {number | null} redirect_hops how many redirects were followed before the answer
 * @property {number | null} http_status
 * @property {string | null} content_type
 * @property {number | null} content_length the announced `Content-Length` of an identity-encoded body
 * @property {number | null} received_bytes the body's length, when one was read
 * @property {string} outcome why this URL gave no episode, or `saved`
 *
 * @typedef {object} RefreshRecord One in-run re-discovery asked for the episode (`_refresh`).
 * @property {"adopted" | "locked" | "not listed" | "refused" | "failed"} outcome
 * @property {boolean} fresh_list whether the series was listed again for it (else the run's cached list answered)
 * @property {string | null} access the fresh entry's access, when there was one
 * @property {string[] | null} hints its lock hints, when there was one
 * @property {number | null} listed_url_count how many play URLs the fresh entry named
 *
 * @typedef {object} EpisodeTrace What the downloader recorded of one episode's download.
 * @property {AttemptRecord[]} attempts
 * @property {RefreshRecord[]} refreshes
 *
 * @typedef {object} CauseRow What {@link probableCause} reads of a result row.
 * @property {string} status
 * @property {string} message
 * @property {string} access
 * @property {readonly string[]} lockHints
 * @property {boolean} drm
 * @property {number | null} durationS
 *
 * @typedef {object} EpisodeInput One result row of a run, with its episode and its trace.
 * @property {number} number
 * @property {string} itemId
 * @property {string} title
 * @property {number | null} durationS
 * @property {string} access
 * @property {boolean} paid
 * @property {boolean} drm
 * @property {readonly string[]} lockHints
 * @property {string | null} qualityHint
 * @property {Record<string, unknown> | null} raw the list item as TikTok served it
 * @property {string} status
 * @property {string} message
 * @property {string | null} path
 * @property {EpisodeTrace | null} trace
 *
 * @typedef {object} SeriesInput One series of the run, in the run's order.
 * @property {string} seriesId
 * @property {string | null} name
 * @property {string | null} line the report line
 * @property {string} status the batch status
 * @property {string | null} error
 * @property {boolean} stop
 * @property {boolean} contacted
 * @property {number | null} listed how many episodes the list had, when the series was listed
 * @property {{free: number, unlocked: number, locked: number} | null} access the counts over the list
 * @property {EpisodeInput[]} episodes every result row of the run, in order
 *
 * @typedef {object} JobInput The job as the history records it.
 * @property {string} kind
 * @property {string} label
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {string | null} error
 * @property {string | null} stopped
 * @property {number} refreshes
 * @property {{kind: string, seconds: number, text: string}[]} pauses
 *
 * @typedef {object} ReportInput
 * @property {string} generatedAt ISO 8601
 * @property {string} extensionVersion
 * @property {string} userAgent
 * @property {string} language the language the page shows the texts in
 * @property {boolean} testMode
 * @property {JobInput} job
 * @property {SeriesInput[]} series
 */

/** The statuses of a row that did download, or needed no download: never in the report. */
const DOWNLOADED_STATUSES = new Set([DONE, SKIPPED_EXISTS, DRY_RUN]);

/**
 * The probable cause of a row that did not download, from its status, its message, what the list
 * said of the episode and (when the rules need it) its trace. English, stored like every engine
 * text, never shown in the UI. The rules apply in order; the first that matches decides.
 * @param {CauseRow} row
 * @param {EpisodeTrace | null} _trace the episode's trace (no rule reads it yet; the shape is fixed)
 * @returns {string}
 */
export function probableCause(row, _trace) {
  const { status, message } = row;
  const hints = row.lockHints.join("; ");
  if (message.startsWith(STOPPED_PREFIX)) return `${NOT_ATTEMPTED_CAUSE} (${message.slice(STOPPED_PREFIX.length)})`;
  if (status === FAILED_RATE_LIMITED) return RATE_LIMITED_CAUSE;
  if (status === FAILED_BLOCKED) return BLOCKED_CAUSE;
  if (status === FAILED_LOGIN) return LOGIN_CAUSE;
  if (message.includes(DRM_MARK)) return DRM_CAUSE;
  if (status === SKIPPED_LOCKED) return `${LOCKED_CAUSE_PREFIX}${hints || "no clue"}${LOCKED_CAUSE_SUFFIX}`;
  if (message.startsWith(INCOMPLETE_PREFIX)) {
    const reason = message.slice(INCOMPLETE_PREFIX.length);
    const durations = DURATION_RE.exec(reason);
    if (durations !== null) {
      const actual = Number(durations[1]);
      const expected = Number(durations[2]);
      if (actual < expected) {
        return (
          `${PREVIEW_CAUSE_PREFIX}a complete MP4 of ${durations[1]} s where the list announces ${durations[2]} s` +
          `${PREVIEW_CAUSE_MIDDLE}${hints || "none"}`
        );
      }
      return `the file lasts ${durations[1]} s where the list announces ${durations[2]} s${LONGER_FILE_CAUSE_SUFFIX}`;
    }
    const truncated = TRUNCATED_RE.exec(reason);
    if (truncated !== null) return `${CUT_SHORT_CAUSE_PREFIX}${truncated[1]}${CUT_SHORT_CAUSE_SUFFIX}`;
    return `${INVALID_FILE_CAUSE_PREFIX}${reason}${INVALID_FILE_CAUSE_SUFFIX}`;
  }
  if (status === FAILED_UNAVAILABLE) return `${UNAVAILABLE_CAUSE_PREFIX}${message}${UNAVAILABLE_CAUSE_SUFFIX}`;
  // the downloader's own failures already start with the prefix: never `download failed: download failed: …`
  const rest = message.startsWith(FAILED_CAUSE_PREFIX) ? message.slice(FAILED_CAUSE_PREFIX.length) : message;
  return `${FAILED_CAUSE_PREFIX}${rest}`;
}

/**
 * Whether a row's status is a failure (`failed`, `failed-unavailable`, …): what makes a run worth a
 * report. A `skipped-locked` row is listed in the report but is no failure on its own.
 * @param {string} status
 * @returns {boolean}
 */
function isFailure(status) {
  return status.startsWith("failed");
}

/**
 * Whether any row of any series failed: the report is built (and saved) only then.
 * @param {readonly SeriesInput[]} series
 * @returns {boolean}
 */
export function hasFailures(series) {
  return series.some((input) => input.episodes.some((episode) => isFailure(episode.status)));
}

/**
 * `E05`: an episode number as the summary names it.
 * @param {number} number
 * @returns {string}
 */
function episodeLabel(number) {
  return `E${String(number).padStart(2, "0")}`;
}

/**
 * @param {EpisodeInput} episode
 * @returns {CauseRow}
 */
function causeRow(episode) {
  return {
    status: episode.status,
    message: episode.message,
    access: episode.access,
    lockHints: episode.lockHints,
    drm: episode.drm,
    durationS: episode.durationS,
  };
}

/**
 * The report's entry of a row that did not download (snake_case keys; `raw` as served, untouched).
 * @param {EpisodeInput} episode
 * @returns {Record<string, unknown>}
 */
function notDownloadedEntry(episode) {
  const attempts = episode.trace?.attempts ?? [];
  return {
    number: episode.number,
    item_id: episode.itemId,
    title: episode.title,
    duration_s: episode.durationS,
    access: episode.access,
    paid: episode.paid,
    drm: episode.drm,
    lock_hints: [...episode.lockHints],
    quality_hint: episode.qualityHint,
    status: episode.status,
    message: episode.message,
    attempted: attempts.some((attempt) => attempt.requested),
    probable_cause: probableCause(causeRow(episode), episode.trace),
    attempts: attempts.map((attempt) => ({ ...attempt })),
    refreshes: (episode.trace?.refreshes ?? []).map((refresh) => ({ ...refresh, hints: refresh.hints === null ? null : [...refresh.hints] })),
    raw: episode.raw,
  };
}

/**
 * The row to compare the failures with: the first `done` row of the series, else the first
 * `skipped-exists` one (a file an earlier run saved), else null.
 * @param {readonly EpisodeInput[]} episodes
 * @returns {Record<string, unknown> | null}
 */
function referenceEntry(episodes) {
  const found = episodes.find((episode) => episode.status === DONE) ?? episodes.find((episode) => episode.status === SKIPPED_EXISTS);
  if (found === undefined) return null;
  return {
    number: found.number,
    status: found.status,
    message: found.message,
    access: found.access,
    lock_hints: [...found.lockHints],
    raw: found.raw,
  };
}

/**
 * The report of one run: a plain JSON-serialisable object, snake_case keys. Every series of the
 * run is in it, with its rows that did not download (every status but `done`, `skipped-exists`
 * and `dry-run`: the `failed-*` ones and `skipped-locked`), ascending by number, each with its
 * probable cause, its attempts and re-discoveries and its raw list item; and one downloaded row
 * for comparison. The `summary` has one line per such row, series-prefixed when the run had
 * several series.
 * @param {ReportInput} input
 * @returns {Record<string, unknown>}
 */
export function buildReport(input) {
  const several = input.series.length > 1;
  /** @type {string[]} */
  const summary = [];
  const series = input.series.map((run) => {
    const notDownloaded = run.episodes
      .filter((episode) => !DOWNLOADED_STATUSES.has(episode.status))
      .sort((a, b) => a.number - b.number)
      .map(notDownloadedEntry);
    for (const entry of notDownloaded) {
      const line = `${episodeLabel(/** @type {number} */ (entry["number"]))} ${entry["status"]} — ${entry["message"]} — probable cause: ${entry["probable_cause"]}`;
      summary.push(several ? `${run.name ?? run.seriesId}: ${line}` : line);
    }
    return {
      series_id: run.seriesId,
      name: run.name,
      line: run.line,
      status: run.status,
      error: run.error,
      stop: run.stop,
      contacted: run.contacted,
      listed: run.listed,
      access_counts: run.access === null ? null : { ...run.access },
      not_downloaded: notDownloaded,
      reference: referenceEntry(run.episodes),
    };
  });
  const job = input.job;
  return {
    dramafetch_report: REPORT_VERSION,
    generated_at: input.generatedAt,
    extension_version: input.extensionVersion,
    browser: { user_agent: input.userAgent, language: input.language },
    test_mode: input.testMode,
    what_this_is: WHAT_THIS_IS,
    summary,
    job: {
      kind: job.kind,
      label: job.label,
      started_at: job.startedAt,
      finished_at: job.finishedAt,
      error: job.error,
      stopped: job.stopped,
      refreshes: job.refreshes,
      pauses: job.pauses.map((pause) => ({ ...pause })),
    },
    series,
  };
}

/**
 * @param {number} value
 * @returns {string} two digits
 */
function two(value) {
  return String(value).padStart(2, "0");
}

/**
 * The report's file name without extension: `<name> - did not download <YYYY-MM-DD HHMM>`, the
 * name the series' (`chromeSafeFilename`, 60 characters at most, so the whole path stays within
 * Windows' limits) or `<N> series` for several, the time `generatedAt`'s LOCAL time — no colon:
 * Windows refuses one in a file name.
 * @param {readonly SeriesInput[]} series
 * @param {Date} generatedAt
 * @returns {string}
 */
export function reportStem(series, generatedAt) {
  const one = series.length === 1 ? series[0] : undefined;
  const name = one !== undefined ? chromeSafeFilename(one.name ?? one.seriesId, 60) : `${series.length} series`;
  const date = `${generatedAt.getFullYear()}-${two(generatedAt.getMonth() + 1)}-${two(generatedAt.getDate())}`;
  const time = `${two(generatedAt.getHours())}${two(generatedAt.getMinutes())}`;
  return `${name} - did not download ${date} ${time}`;
}

/**
 * The path the report is saved at, relative to the Downloads folder: `DramaFetch/reports/<stem>.json`.
 * @param {string} stem {@link reportStem}
 * @returns {string}
 */
export function reportFilename(stem) {
  return downloadFilename(REPORTS_FOLDER, stem, "json");
}

/**
 * The report as the bytes of its file: indented JSON, UTF-8.
 * @param {Record<string, unknown>} report {@link buildReport}
 * @returns {Uint8Array}
 */
export function reportJson(report) {
  return new TextEncoder().encode(JSON.stringify(report, null, 2));
}
