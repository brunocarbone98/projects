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
 * duration the media contradicts — which carry time-limited signed media links; per series a
 * digest of every LISTED episode (`episodes_digest`: number, access, hints, whether DramaFetch only
 * guessed it was locked (3.0.1), the video's duration, size and bitrate, the sound's id, title,
 * duration and `original` flag, `IsPreview` / `PreviewType` — the fields the SHORT-HEADER rule and
 * the short-served check read, no URL); the requests made as
 * `scheme://host/path` with their HTTP status and sizes, never a query string (TikTok signs it),
 * never a header value, never a cookie or a token; per series (3.0.1, the owner's report of
 * 2026-11-27) how its episode list was read — the `listing` section: the list request's
 * `scheme://host/path`, every page asked (its `cursor` and `count`, the items it brought, the
 * series' numbers among them, `hasMore` and the cursor it returned), the gap filling's requests,
 * the items DramaFetch could not read with their reasons, the warnings, TikTok's count, the items
 * received, the numbers still missing and why the listing ended early ({@link listingSection}).
 * The report is written when an episode did not download — a failure, or (3.0.1) a free episode
 * DramaFetch only guessed was locked —, and also when the list itself is short (a number missing,
 * or an early end short of TikTok's count: {@link hasFailures}). The causes are
 * stored English texts like every engine text and are never shown in the UI (so `lib/display`
 * needs no rule for them).
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
  NOT_LISTED_PREFIX,
  SHORT_SERVED_PREFIX,
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
/**
 * Rule 2: a short-served file, named by the downloader (`SHORT_SERVED_PREFIX`): `<prefix><a> s of
 * <e> s<suffix>` — what was measured, then both readings, since the list cannot tell them apart.
 */
export const SHORT_SERVED_CAUSE_PREFIX =
  "TikTok serves this episode short: the file is the whole episode by size but its header stops at ";
export const SHORT_SERVED_CAUSE_SUFFIX =
  ". Either a window for an episode this account has not unlocked, or a defective encode on TikTok's " +
  "side — the list cannot tell: if the TikTok app plays it whole, watch it there and look again; if the " +
  "app breaks at the same point too, no retry will change it";
/** Rule 3: HTTP 429 on the media. */
export const RATE_LIMITED_CAUSE =
  "TikTok limited the rate of requests (HTTP 429): the run stopped and the 30-minute cooldown " +
  "started; nothing is wrong with the episode";
/** Rule 4: HTTP 403 or a verification page. */
export const BLOCKED_CAUSE =
  "TikTok blocked or challenged the request (HTTP 403 or a verification page); the run stopped and " +
  "the cooldown started";
/** Rule 5: the session is not logged in. */
export const LOGIN_CAUSE = "the session is not logged in to TikTok (log in in a normal tab of this Chrome profile)";
/** Rule 6: encrypted media. */
export const DRM_CAUSE = "encrypted media (DRM): DramaFetch never decrypts or keeps it; retrying cannot change it";
/** Rule 7: `<prefix><hints or "no clue"><suffix>`; the hints include `plays 69 s of 106 s` when that was the reason. */
export const LOCKED_CAUSE_PREFIX = "listed as locked for this session: ";
export const LOCKED_CAUSE_SUFFIX =
  " — the list TikTok served to your session marks it so; unlock it in the TikTok app, then look again";
/**
 * Rule 7, for a free episode DramaFetch only GUESSED was locked (3.0.1, `report.isGuessedLocked`: no
 * price, entitlement, TikTok lock or DRM clue): `<prefix><hints><suffix>` — what DramaFetch's own
 * rules read (a short header: `plays 69 s of 106 s`, or no play address) and what settles it.
 */
export const GUESSED_LOCKED_CAUSE_PREFIX = "not asked for: free in the list TikTok served, but DramaFetch's own rules guessed it was locked: ";
export const GUESSED_LOCKED_CAUSE_SUFFIX =
  " — no price, entitlement, lock flag or DRM clue names it; Retry asks TikTok for it once (TikTok decides): a whole " +
  "file is saved, a short one is named short-served; the digest's music and video durations show what the list said";
/**
 * Rule 8, a shorter file of an unlisted size (a listed size is rule 2): `the file plays <a> s where the
 * list announces <e> s<middle><hints or "none">` — the measured fact and both readings, never a verdict.
 */
export const SHORTER_FILE_CAUSE_PREFIX = "the file plays ";
export const SHORTER_FILE_CAUSE_MIDDLE =
  ", and its size is none the list announced — a shorter file than listed: a window or a preview clip for an " +
  "episode this account has not unlocked, or a defective encode on TikTok's side; the list's marks for it: ";
/** Rule 8, a longer file: `the file lasts <a> s where the list announces <e> s<suffix>`. */
export const LONGER_FILE_CAUSE_SUFFIX = ": the list and the media disagree; the file was not kept as the episode";
/** Rule 9: `<prefix><N of M bytes | the transfer was cut short><suffix>`. */
export const CUT_SHORT_CAUSE_PREFIX = "the transfer was cut short (";
export const CUT_SHORT_CAUSE_SUFFIX = "): a network or server problem, worth a retry";
/** Rule 10: `<prefix><reason><suffix>`. */
export const INVALID_FILE_CAUSE_PREFIX = "the file TikTok served is not a valid episode video (";
export const INVALID_FILE_CAUSE_SUFFIX =
  "): worth one retry; if it repeats, the rendition TikTok serves this session is broken";
/**
 * Rule 11 (3.0.1): an episode TikTok's list lacked — a `failed-unavailable` row whose message starts
 * with `NOT_LISTED_PREFIX`, made without a request (`report.notListedResults`). True whether or not
 * the gap filling reached its page (the lead's D10: the filling stops after `GAP_FILL_REQUESTS`
 * requests, or at an answer without a list): the listing section says which pages were asked.
 */
export const NOT_LISTED_CAUSE =
  "missing from the episode list TikTok served to your session (this series' listing section shows each page asked, " +
  "the gap filling's included, and what it brought): a later listing may hold it, and Retry lists the drama again; " +
  "if tiktok.com does not show it either, TikTok's web list lacks it";
/** Rule 12: `<prefix><message><suffix>`. */
export const UNAVAILABLE_CAUSE_PREFIX = "no playable stream this session may use (";
export const UNAVAILABLE_CAUSE_SUFFIX =
  "): locked, region-restricted, not logged in, or TikTok served no video at any play URL";
/** Rule 13: `<prefix><message>`. */
export const FAILED_CAUSE_PREFIX = "download failed: ";

/** The verification reason of a file whose duration disagrees with the list (`lib/mp4.verifyVideo`). */
const DURATION_RE = /^duration (\d+(?:\.\d+)?) s, expected (\d+(?:\.\d+)?) s/;
/** The transfer check's reason: `truncated body (<N> of <M> bytes)` / `(the transfer was cut short)`. */
const TRUNCATED_RE = /truncated body \(([^)]*)\)/;
/** The durations of a short-served message (`messages.shortServedMessage`): `… but it plays <a> s of <e> s — …`. */
const SHORT_SERVED_RE = / but it plays (\d+(?:\.\d+)?) s of (\d+(?:\.\d+)?) s — /;

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
 * @property {boolean} [guessedLock] the row of a free episode DramaFetch only guessed was locked
 *   (3.0.1, `report.isGuessedLocked`)
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
 * @property {boolean} [guessedLock] the row is a free episode DramaFetch only guessed was locked —
 *   `skipped-locked`, no price, entitlement, TikTok lock or DRM clue (3.0.1,
 *   `report.isGuessedLocked`): not downloaded, so the report is written
 * @property {string | null} qualityHint
 * @property {Record<string, unknown> | null} raw the list item as TikTok served it
 * @property {string} status
 * @property {string} message
 * @property {string | null} path
 * @property {EpisodeTrace | null} trace
 *
 * @typedef {object} ListedEpisode What the digest reads of one LISTED episode (a `catalog.Episode` fits).
 * @property {number} number
 * @property {string} access
 * @property {readonly string[]} lockHints
 * @property {boolean} [guessedLock] DramaFetch only guessed it was locked (3.0.1, `catalog.accessOf`)
 * @property {number | null} durationS
 * @property {Record<string, unknown> | null} raw the list item as TikTok served it
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
 * @property {readonly ListedEpisode[] | null} [listedEpisodes] every episode the list had, in its
 *   order (`series.episodes`), for the digest; null (or absent) when the series was not listed
 * @property {Record<string, unknown>[] | null} [episodesDigest] the digest made already
 *   ({@link digestEntry} of every listed episode, in the list's order; null when the series was not
 *   listed): when present it is the report's digest and `listedEpisodes` is not read — a batch
 *   takes it when a series is done, so the list's raw items need not stay until the job ends
 * @property {ListingInput | null} [listing] how the series' episode list was read (3.0.1); null (or
 *   absent) when the series was not listed
 *
 * @typedef {object} ListingPageInput One episode-list page the listing asked for or read
 *   (`catalog.ListingPage`).
 * @property {string} kind `first`, `next`, `scroll` or `fill` (the gap filling)
 * @property {string | null} cursorAsked the request's `cursor`, null without one
 * @property {string | null} countAsked the request's `count`, null without one
 * @property {boolean} listed whether the answer held an episode list
 * @property {number} items every item of the answer (any drama)
 * @property {readonly number[]} numbers the series' episode numbers in it, as listed
 * @property {boolean | null} hasMore
 * @property {number | string | null} cursor the cursor the answer returned
 *
 * @typedef {object} ListingInput What the report reads of a series' listing (3.0.1, the series as
 *   `app/discovery.js` built it).
 * @property {string | null} endpoint the list request's `scheme://host/path`, never its query
 * @property {readonly ListingPageInput[]} pages every page, in the order it came
 * @property {number | null} totalHint TikTok's count of the series' episodes
 * @property {number | null} itemsReceived the distinct items TikTok listed for the series
 * @property {number} [otherItems] the drama's items received besides its episode numbers — a
 *   trailer, a highlight, … (3.0.1, `catalog.countCheck`)
 * @property {boolean} [uncertain] TikTok counts more than the drama certainly has (3.0.1,
 *   `catalog.countCheck`): its count may include the other items, or episodes may be missing
 * @property {number} episodesListed the episodes the list holds (one per number)
 * @property {readonly number[]} missingNumbers the numbers the list still lacks
 * @property {string | null} earlyEnd why the listing ended before TikTok said the list was over
 * @property {readonly {reason: string, itemId: string | null}[]} skippedItems the items DramaFetch
 *   could not read, with their reasons
 * @property {readonly string[]} warnings the list's warnings
 * @property {boolean} incomplete the list itself is short — a number missing, an early end short of
 *   TikTok's count, or (3.0.1) TikTok counting more than the drama certainly has
 *   (`report.listIncomplete`): the report is written even when every row downloaded
 *
 * @typedef {object} JobInput The job as its report records it.
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
 * How many `skipped-locked` rows of one series keep their raw list item in the report: the first
 * ones by number. Every locked row keeps its access, hints and probable cause, and the digest
 * lists every episode; the raw items of a whole locked series (one of 6 KB or more per episode)
 * would make the report of a large batch hundreds of megabytes.
 */
export const LOCKED_RAW_KEPT = 3;

/**
 * The rows of one series as the report reads them, and nothing more: `raw` only for the rows it
 * describes (every status but the downloaded ones) — of the `skipped-locked` ones the first
 * {@link LOCKED_RAW_KEPT} by number, and (3.0.1) of the free ones DramaFetch only guessed were
 * locked (`guessedLock`) the first {@link LOCKED_RAW_KEPT} too, apart: their items are the evidence
 * that settles the guess — and for its reference row (the first `done`, else the first
 * `skipped-exists`); `trace` only for the rows it describes. {@link buildReport} applies it to
 * whatever it is given, so the rows may be reduced as soon as a series is done: the report is the
 * same.
 * @param {readonly EpisodeInput[]} episodes every result row of the run, in order
 * @returns {EpisodeInput[]}
 */
export function slimRows(episodes) {
  const reference = referenceRow(episodes);
  /** @param {boolean} guessed @returns {Set<number>} */
  const firstLocked = (guessed) =>
    new Set(
      episodes
        .filter((episode) => episode.status === SKIPPED_LOCKED && (episode.guessedLock === true) === guessed)
        .map((episode) => episode.number)
        .sort((a, b) => a - b)
        .slice(0, LOCKED_RAW_KEPT),
    );
  const lockedWithRaw = new Set([...firstLocked(false), ...firstLocked(true)]);
  return episodes.map((episode) => {
    const described = !DOWNLOADED_STATUSES.has(episode.status);
    const keepsRaw = described ? episode.status !== SKIPPED_LOCKED || lockedWithRaw.has(episode.number) : episode === reference;
    if (keepsRaw && described) return episode;
    return { ...episode, raw: keepsRaw ? episode.raw : null, trace: described ? episode.trace : null };
  });
}

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
  if (message.startsWith(SHORT_SERVED_PREFIX)) {
    const window = SHORT_SERVED_RE.exec(message);
    if (window !== null) return `${SHORT_SERVED_CAUSE_PREFIX}${window[1]} s of ${window[2]} s${SHORT_SERVED_CAUSE_SUFFIX}`;
  }
  if (status === FAILED_RATE_LIMITED) return RATE_LIMITED_CAUSE;
  if (status === FAILED_BLOCKED) return BLOCKED_CAUSE;
  if (status === FAILED_LOGIN) return LOGIN_CAUSE;
  if (message.includes(DRM_MARK)) return DRM_CAUSE;
  if (status === SKIPPED_LOCKED && row.guessedLock === true) return `${GUESSED_LOCKED_CAUSE_PREFIX}${hints || "no clue"}${GUESSED_LOCKED_CAUSE_SUFFIX}`;
  if (status === SKIPPED_LOCKED) return `${LOCKED_CAUSE_PREFIX}${hints || "no clue"}${LOCKED_CAUSE_SUFFIX}`;
  if (message.startsWith(INCOMPLETE_PREFIX)) {
    const reason = message.slice(INCOMPLETE_PREFIX.length);
    const durations = DURATION_RE.exec(reason);
    if (durations !== null) {
      const actual = Number(durations[1]);
      const expected = Number(durations[2]);
      if (actual < expected) {
        return (
          `${SHORTER_FILE_CAUSE_PREFIX}${durations[1]} s where the list announces ${durations[2]} s` +
          `${SHORTER_FILE_CAUSE_MIDDLE}${hints || "none"}`
        );
      }
      return `the file lasts ${durations[1]} s where the list announces ${durations[2]} s${LONGER_FILE_CAUSE_SUFFIX}`;
    }
    const truncated = TRUNCATED_RE.exec(reason);
    if (truncated !== null) return `${CUT_SHORT_CAUSE_PREFIX}${truncated[1]}${CUT_SHORT_CAUSE_SUFFIX}`;
    return `${INVALID_FILE_CAUSE_PREFIX}${reason}${INVALID_FILE_CAUSE_SUFFIX}`;
  }
  if (status === FAILED_UNAVAILABLE && message.startsWith(NOT_LISTED_PREFIX)) return NOT_LISTED_CAUSE;
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
 * Whether any row of any series did not download — a failure, or (3.0.1) a free episode DramaFetch
 * only guessed was locked (`guessedLock`) — or (3.0.1) the episode list of one is itself short (its
 * `listing.incomplete`: a number missing, or an early end short of TikTok's count): the report is
 * built (and saved) only then.
 * @param {readonly SeriesInput[]} series
 * @returns {boolean}
 */
export function hasFailures(series) {
  return series.some(
    (input) =>
      input.listing?.incomplete === true ||
      input.episodes.some((episode) => isFailure(episode.status) || (episode.status === SKIPPED_LOCKED && episode.guessedLock === true)),
  );
}

/**
 * `url` as the report may hold it: its `scheme://host/path`, the query and the fragment (TikTok
 * signs the query) and any `user:password@` dropped; null for nothing.
 * @param {string | null} url
 * @returns {string | null}
 */
function bareUrl(url) {
  if (url === null || url === "") return null;
  const path = url.split(/[?#]/, 1)[0] ?? "";
  return path.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

/**
 * The report's `listing` section of one series (3.0.1, the owner's report of 2026-11-27: “que cuente
 * y se dé cuenta si falta un episodio”): how its episode list was read — the list request's
 * `scheme://host/path` (never its query: TikTok signs it), TikTok's count, the items received, the
 * episodes listed, the numbers still missing, why the listing ended early, every page asked (its
 * `cursor` and `count`, the items it brought, the series' numbers among them, `hasMore` and the
 * cursor it returned), how many of them the gap filling asked for, the items DramaFetch could not
 * read with their reasons, the warnings. No URL with a query, no cookie, no signed parameter.
 * @param {ListingInput} listing
 * @returns {Record<string, unknown>}
 */
export function listingSection(listing) {
  return {
    endpoint: bareUrl(listing.endpoint),
    tiktok_count: listing.totalHint,
    items_received: listing.itemsReceived,
    other_items: listing.otherItems ?? 0,
    uncertain: listing.uncertain ?? false,
    episodes_listed: listing.episodesListed,
    missing_numbers: [...listing.missingNumbers],
    ended_early: listing.earlyEnd,
    incomplete: listing.incomplete,
    fill_requests: listing.pages.filter((page) => page.kind === "fill").length,
    pages: listing.pages.map((page) => ({
      kind: page.kind,
      cursor_asked: page.cursorAsked,
      count_asked: page.countAsked,
      listed: page.listed,
      items: page.items,
      numbers: [...page.numbers],
      has_more: page.hasMore,
      cursor: page.cursor,
    })),
    skipped_items: listing.skippedItems.map((item) => ({ reason: item.reason, item_id: item.itemId })),
    warnings: [...listing.warnings],
  };
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
    guessedLock: episode.guessedLock === true,
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
    guessed_lock: episode.guessedLock === true, // 3.0.1
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
 * `value` when it is a finite number, else null (a digest field read from the raw item).
 * @param {unknown} value
 * @returns {number | null}
 */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * `dict[key]` when `dict` is a plain object and owns the key, else undefined.
 * @param {unknown} dict
 * @param {string} key
 * @returns {unknown}
 */
function fieldOf(dict, key) {
  if (dict === null || typeof dict !== "object" || Array.isArray(dict)) return undefined;
  const record = /** @type {Record<string, unknown>} */ (dict);
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * The digest of one listed episode (snake_case): what the list said of it and the fields the
 * SHORT-HEADER rule and the short-served check read — `video.duration`, `music.duration`,
 * `music.original`, `video.size`, `video.bitrateInfo[0].Bitrate`, `dramaInfo.DramaVideoData.
 * IsPreview` / `PreviewType` —, since 3.0.1 whether DramaFetch only guessed it was locked
 * (`guessed_lock`) and the sound's `music.id` and `music.title` (what tells the episode's own sound
 * from another; a number id as its digits), null when absent; no URL, nothing else.
 * @param {ListedEpisode} episode
 * @returns {Record<string, unknown>}
 */
export function digestEntry(episode) {
  const raw = episode.raw;
  const video = fieldOf(raw, "video");
  const music = fieldOf(raw, "music");
  const bitrateInfo = fieldOf(video, "bitrateInfo");
  const first = Array.isArray(bitrateInfo) ? bitrateInfo[0] : undefined;
  const videoData = fieldOf(fieldOf(raw, "dramaInfo"), "DramaVideoData");
  const original = fieldOf(music, "original");
  const musicId = fieldOf(music, "id");
  const musicTitle = fieldOf(music, "title");
  return {
    number: episode.number,
    access: episode.access,
    lock_hints: [...episode.lockHints],
    guessed_lock: episode.guessedLock === true,
    duration_s: numberOrNull(fieldOf(video, "duration")) ?? episode.durationS,
    music_id: typeof musicId === "string" ? musicId : typeof musicId === "number" && Number.isFinite(musicId) ? String(musicId) : null,
    music_title: typeof musicTitle === "string" ? musicTitle : null,
    music_duration_s: numberOrNull(fieldOf(music, "duration")),
    music_original: typeof original === "boolean" ? original : null,
    size: numberOrNull(fieldOf(video, "size")),
    bitrate: numberOrNull(fieldOf(first, "Bitrate")),
    is_preview: fieldOf(videoData, "IsPreview") ?? null,
    preview_type: fieldOf(videoData, "PreviewType") ?? null,
  };
}

/**
 * The row to compare the failures with: the first `done` row of the series, else the first
 * `skipped-exists` one (a file an earlier run saved), else undefined.
 * @param {readonly EpisodeInput[]} episodes
 * @returns {EpisodeInput | undefined}
 */
function referenceRow(episodes) {
  return episodes.find((episode) => episode.status === DONE) ?? episodes.find((episode) => episode.status === SKIPPED_EXISTS);
}

/**
 * {@link referenceRow} as the report shows it, or null.
 * @param {readonly EpisodeInput[]} episodes
 * @returns {Record<string, unknown> | null}
 */
function referenceEntry(episodes) {
  const found = referenceRow(episodes);
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
 * probable cause, its attempts and re-discoveries and its raw list item (of a series' locked rows
 * only the first {@link LOCKED_RAW_KEPT}: {@link slimRows}); one downloaded row for comparison;
 * and the digest of every LISTED episode ({@link digestEntry}; null when the series was not
 * listed), and how its list was read ({@link listingSection}; null when it was not listed). The
 * `summary` has one line per such row, series-prefixed when the run had several series.
 * @param {ReportInput} input
 * @returns {Record<string, unknown>}
 */
export function buildReport(input) {
  const several = input.series.length > 1;
  /** @type {string[]} */
  const summary = [];
  const series = input.series.map((run) => {
    const rows = slimRows(run.episodes);
    const notDownloaded = rows
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
      reference: referenceEntry(rows),
      episodes_digest: run.episodesDigest !== undefined ? run.episodesDigest : (run.listedEpisodes?.map(digestEntry) ?? null),
      listing: run.listing === undefined || run.listing === null ? null : listingSection(run.listing),
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
