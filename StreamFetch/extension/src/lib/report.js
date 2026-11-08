// @ts-check
/**
 * The "did not download" report: for every target a run did not download, what the site served,
 * what StreamFetch asked (the attempt traces the resolver and the downloader record — this module
 * only reads them) and a probable cause. The app saves it as one JSON file under
 * `StreamFetch/reports/` at the end of a run with at least one `failed*` or `stopped` row (the
 * `report` setting), or on **Save the report**; it is the thing to attach when asking for help.
 * Pure: no `chrome.*`, no DOM — it runs in Node and in the extension alike.
 *
 * Privacy, binding: every URL is stored with its query string and fragment removed (both sites
 * sign their media URLs in the query), in the attempts, the page, the chosen streams and the raw
 * metadata alike; no request header and no cookie, token or `Authorization` value exists anywhere
 * in the report (keys that name one are dropped from the raw metadata, section 2 of the spec).
 */

import { hostOf, isRecord, stripQuery, stripUrlQueriesInText } from "./json.js";
import {
  DONE,
  NOT_DOWNLOADED_STATUSES,
  SKIPPED_EXISTS,
  STOPPED,
  isFailureCode,
  render,
  statusLabel,
} from "./messages.js";

/** The report's format version. */
export const REPORT_VERSION = 1;
/** The report's own one-line description (`what_this_is`). */
export const WHAT_THIS_IS =
  "The videos of one StreamFetch run that did not download, what StreamFetch asked Dailymotion " +
  "or Bilibili and what came back. It holds the sites' metadata as served to your session " +
  "(titles, ids, hosts, qualities) with every URL's query string removed, and never a cookie, " +
  "a token or a request header. Read it before sharing it.";

/**
 * @typedef {object} Attempt One HTTP step of a target, as the resolver or the downloader recorded
 *   it (the spec's `Attempt`); the report stores it with the URL's query stripped.
 * @property {string} url the URL asked for (any query it carries is stripped here)
 * @property {string | null} [host] the URL's host; derived from `url` when absent
 * @property {boolean} requested false when the URL was never requested (a host the manifest
 *   does not cover)
 * @property {number | null} http_status
 * @property {string | null} content_type
 * @property {number | null} content_length the announced `Content-Length`
 * @property {number | null} received_bytes the body's length, when one was read
 * @property {string | null} range the `Range` header sent (`bytes=1234-`), null when none
 * @property {string} outcome `ok`, `saved`, `retry`, `refused`, `stalled`, … (free English text)
 *
 * @typedef {object} PageInput What the resolver recorded of the page or metadata request.
 * @property {string} url
 * @property {number | null} http_status
 * @property {number | null} bytes
 *
 * @typedef {object} RowInput One target of the run, as the engine recorded it.
 * @property {string} input the pasted line that named it (`Item.original`)
 * @property {string} site
 * @property {string} id
 * @property {number | null} part
 * @property {string | null} title
 * @property {string} status
 * @property {import("./messages.js").Failure | null} failure
 * @property {readonly Attempt[] | null} [attempts]
 * @property {unknown} [streams] the resolver's `{ kind, chosen, available }`, when it got that far
 * @property {PageInput | null} [page]
 * @property {unknown} [raw] the metadata as served (Dailymotion's metadata JSON, Bilibili's
 *   `__playinfo__`)
 *
 * @typedef {object} RunInput One run, as the engine and the history record it.
 * @property {Date | string | null} startedAt
 * @property {Date | string | null} finishedAt
 * @property {string | null} stopReason null when the run finished on its own
 * @property {unknown} settings the user's settings record (nothing secret in it)
 * @property {readonly RowInput[]} rows every target of the run, in input order
 *
 * @typedef {object} ReportOptions
 * @property {string} extensionVersion
 * @property {string} userAgent
 * @property {string} language the language the UI shows
 * @property {Date} [now] `created_at`; the current time by default
 * @property {boolean} [testMode] true for a test copy of the extension
 *
 * @typedef {object} CauseRow What {@link probableCause} reads of a row.
 * @property {string} status
 * @property {import("./messages.js").Failure | null} failure
 */

/** Keys of the raw metadata that may hold a credential: dropped, whatever their value. */
const SENSITIVE_KEY_RE = /cookie|authorization|token|sessdata|bili_jct|password|secret|^headers?$/i;

/**
 * A deep copy of a JSON value fit for the report: keys that name a credential dropped, the query
 * string and fragment of every URL in every string removed. Never throws.
 * @param {unknown} value
 * @returns {unknown}
 */
export function sanitize(value) {
  if (typeof value === "string") return stripUrlQueriesInText(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (isRecord(value)) {
    /** @type {Record<string, unknown>} */
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) continue;
      copy[key] = sanitize(item);
    }
    return copy;
  }
  return value;
}

// ------------------------------------------------------------------- the probable causes

/**
 * The fixed table: one English sentence per failure code (`http_status` is refined by its status
 * in {@link probableCause}). Stored like every engine text, never shown in the UI.
 * @type {Readonly<Record<import("./messages.js").FailureCode, string>>}
 */
export const PROBABLE_CAUSES = Object.freeze({
  http_status:
    "the server answered an unexpected HTTP status where media or a page was expected; worth " +
    "one retry, and if it repeats the site changed something",
  host_not_covered:
    "the site pointed at a host the extension has no permission for, so nothing was requested " +
    "there; report the host so a later version can cover it",
  redirect_refused:
    "a redirect left the site's own hosts and was not followed; StreamFetch only fetches from " +
    "the two sites' own hosts",
  no_response:
    "a network problem between this computer and the site (no answer, a stall or a reset); " +
    "worth a retry",
  truncated_body: "the transfer was cut short by the network or the server; worth a retry",
  not_a_video:
    "the server sent a page where media was expected, often a verification or login page; open " +
    "the video on the site in a normal tab, then retry",
  encrypted:
    "the media is encrypted (DRM); StreamFetch never decrypts it and no retry changes that",
  key_protected:
    "the HLS playlist is key-protected; StreamFetch never decrypts it and no retry changes that",
  live_stream: "a live stream; out of scope in 1.0",
  discontinuous_stream: "a spliced playlist (discontinuities, often ads); not supported in 1.0",
  legacy_stream:
    "Bilibili served a legacy FLV/MP4 stream (durl) to this session instead of DASH; not " +
    "supported in 1.0 — being logged in usually gets DASH",
  geo_blocked:
    "Dailymotion does not serve this video in your country; StreamFetch never bypasses " +
    "geo-restrictions",
  login_required:
    "the session is not logged in to the site, or the site wants a login for this video; log " +
    "in in a normal tab of this Chrome profile, then retry",
  premium_only:
    "the video's qualities are premium-only and this session has no premium membership; " +
    "StreamFetch never bypasses a paywall",
  supporter_only:
    "the video is for the uploader's paying supporters and this session is not one; StreamFetch " +
    "never bypasses a paywall",
  trial_only:
    "Bilibili served only a trial clip to this session (the full video needs payment or a " +
    "membership); StreamFetch never saves a clip as the video",
  deleted: "the video was deleted, made private or is not served to this session; nothing to retry",
  interactive: "an interactive (branching) video; not supported in 1.0",
  rate_limited:
    "the site limited the rate of requests (HTTP 429 / 412 or a risk-control page); the run " +
    "stopped and the 30-minute cooldown started — wait, then retry; nothing is wrong with the " +
    "video",
  blocked:
    "the site blocked or challenged the request (HTTP 403 on a page or a manifest, or a " +
    "verification wall); the run stopped and the cooldown started — wait, open the site in a " +
    "normal tab, then retry",
  verify_failed:
    "the finished file did not match the video (duration or tracks) and was not saved; worth one " +
    "retry, and if it repeats the site serves a broken stream to this session",
  remux_failed:
    "the MP4 writer failed on this stream; nothing was saved — report it with this file",
  save_failed:
    "Chrome could not save the file (disk full, a blocked download or a path problem); check " +
    "Chrome's download settings, then retry",
  stopped: "not attempted: the run stopped before this video",
  unsupported_link:
    "the link is not a single video of Dailymotion or Bilibili; paste the video's own link",
  no_streams:
    "the site offered no stream this session may play; check that the video plays in a normal " +
    "tab (logged in, if it needs a login), then retry",
  cooldown:
    "a cooldown was in force (the site refused a request earlier), so nothing was requested; " +
    "wait for it to end, then retry",
  unsupported_codec:
    "the stream uses a codec StreamFetch 1.0 cannot demux (only H.264 video and AAC audio in " +
    "MPEG-TS); report it",
  corrupt_stream:
    "the stream's bytes are corrupt or not what the playlist announced; worth one retry",
});

/**
 * The probable cause of a row that did not download: {@link PROBABLE_CAUSES} by failure code, an
 * `http_status` refined by its status (403, 404 / 410, 5xx), a `stopped` row without a failure as
 * `stopped`. English, stored like every engine text, never shown in the UI.
 * @param {CauseRow} row
 * @returns {string}
 */
export function probableCause(row) {
  const code = row.failure?.code ?? (row.status === STOPPED ? "stopped" : null);
  if (code === null) return "no failure was recorded for this row";
  if (!isFailureCode(code)) return `unknown failure code ${JSON.stringify(code)}`;
  if (code === "http_status") {
    const status = Number(row.failure?.params["status"]);
    if (status === 403) {
      return (
        "the server refused the request (HTTP 403): the signed media URL expired or this " +
        "session is not allowed to fetch it; Analyze again for fresh URLs — StreamFetch never " +
        "forges access"
      );
    }
    if (status === 404 || status === 410) {
      return (
        "the media URL is gone (HTTP 404 / 410): it expired or the video was removed; Analyze " +
        "again for fresh URLs"
      );
    }
    if (status >= 500 && status <= 599) {
      return `a server problem on the site's side (HTTP ${status}); worth a retry later`;
    }
  }
  return PROBABLE_CAUSES[code];
}

// ------------------------------------------------------------------------------ the report

/**
 * An attempt as the report stores it: the URL stripped of its query and fragment, the host filled
 * in, every other field copied — never a header.
 * @param {Attempt} attempt
 * @returns {Record<string, unknown>}
 */
export function attemptEntry(attempt) {
  const url = stripQuery(String(attempt.url));
  return {
    url,
    host: attempt.host ?? hostOf(url),
    requested: attempt.requested,
    http_status: attempt.http_status ?? null,
    content_type: attempt.content_type ?? null,
    content_length: attempt.content_length ?? null,
    received_bytes: attempt.received_bytes ?? null,
    range: attempt.range ?? null,
    outcome: attempt.outcome,
  };
}

/**
 * The failure a row carries for the report: its own, or `stopped` for a `stopped` row without one.
 * @param {RowInput} row
 * @returns {import("./messages.js").Failure | null}
 */
function failureOf(row) {
  if (row.failure) return row.failure;
  return row.status === STOPPED ? { code: "stopped", params: {} } : null;
}

/**
 * The report's entry of a row that did not download (snake_case keys).
 * @param {RowInput} row
 * @returns {Record<string, unknown>}
 */
export function rowEntry(row) {
  const failure = failureOf(row);
  const params =
    failure === null ? null : /** @type {Record<string, unknown>} */ (sanitize(failure.params));
  return {
    input: stripUrlQueriesInText(row.input),
    site: row.site,
    id: row.id,
    part: row.part,
    title: row.title === null ? null : stripUrlQueriesInText(row.title),
    status: row.status,
    failure: failure === null || params === null ? null : { code: failure.code, params },
    message_en:
      failure === null || params === null
        ? statusLabel(row.status)
        : render(failure.code, params),
    probable_cause: probableCause({ status: row.status, failure }),
    attempts: (row.attempts ?? []).map(attemptEntry),
    streams: row.streams === undefined || row.streams === null ? null : sanitize(row.streams),
    page:
      row.page === undefined || row.page === null
        ? null
        : {
            url_without_query: stripQuery(String(row.page.url)),
            http_status: row.page.http_status ?? null,
            bytes: row.page.bytes ?? null,
          },
    raw: row.raw === undefined ? null : sanitize(row.raw),
  };
}

/**
 * Whether any row of the run did not download (`failed*` or `stopped`): the report is saved
 * only then.
 * @param {RunInput} run
 * @returns {boolean}
 */
export function hasFailures(run) {
  return run.rows.some((row) => NOT_DOWNLOADED_STATUSES.has(row.status));
}

/**
 * @param {Date | string | null | undefined} moment
 * @returns {string | null}
 */
function isoOrNull(moment) {
  if (moment === null || moment === undefined) return null;
  if (moment instanceof Date) return Number.isNaN(moment.getTime()) ? null : moment.toISOString();
  return String(moment);
}

/**
 * The summary line of one entry: `3. bilibili BV1GJ411x7h7 P2 — <title> — failed-unavailable:
 * <message> — probable cause: <cause>`, numbered by the row's position in the run.
 * @param {number} position 1-based
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
function summaryLine(position, entry) {
  const part = entry["part"];
  const where = `${entry["site"]} ${entry["id"]}${typeof part === "number" ? ` P${part}` : ""}`;
  const title = entry["title"] ?? "(no title)";
  return (
    `${position}. ${where} — ${title} — ${entry["status"]}: ${entry["message_en"]} — ` +
    `probable cause: ${entry["probable_cause"]}`
  );
}

/**
 * The report of one run: a plain JSON-serialisable object with snake_case keys — the environment,
 * the run (times, stop reason, settings), every row that did not download (`not_downloaded`, in
 * input order, each with its English message, its probable cause, its attempts, the chosen
 * streams, the page and the raw metadata, all sanitised), the counts of the rows that did, and a
 * `summary` with one line per listed row.
 * @param {RunInput} run
 * @param {ReportOptions} options
 * @returns {Record<string, unknown>}
 */
export function buildReport(run, options) {
  /** @type {Record<string, unknown>[]} */
  const notDownloaded = [];
  /** @type {string[]} */
  const summary = [];
  run.rows.forEach((row, index) => {
    if (!NOT_DOWNLOADED_STATUSES.has(row.status)) return;
    const entry = rowEntry(row);
    notDownloaded.push(entry);
    summary.push(summaryLine(index + 1, entry));
  });
  return {
    report_version: REPORT_VERSION,
    what_this_is: WHAT_THIS_IS,
    extension_version: options.extensionVersion,
    user_agent: options.userAgent,
    language: options.language,
    test_mode: options.testMode ?? false,
    created_at: (options.now ?? new Date()).toISOString(),
    run: {
      started_at: isoOrNull(run.startedAt),
      finished_at: isoOrNull(run.finishedAt),
      stop_reason: run.stopReason ?? null,
      settings: sanitize(run.settings ?? null),
    },
    not_downloaded: notDownloaded,
    downloaded_count: run.rows.filter((row) => row.status === DONE).length,
    skipped_exists_count: run.rows.filter((row) => row.status === SKIPPED_EXISTS).length,
    summary,
  };
}

/**
 * The report as the text of its file: 2-space indented JSON.
 * @param {Record<string, unknown>} report {@link buildReport}
 * @returns {string}
 */
export function reportJson(report) {
  return JSON.stringify(report, null, 2);
}
