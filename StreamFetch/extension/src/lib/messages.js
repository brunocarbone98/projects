// @ts-check
/**
 * The statuses a target goes through, the failure codes a run records and their English texts.
 * The resolver, the downloader and the engine write a status and a `{ code, params }` failure,
 * never a sentence; the report and the English UI render them here ({@link render}), and the
 * Spanish UI renders the same code through `_locales` (`failure_<code>`, `status_<status>`) with
 * the same parameters in the same order ({@link failureSubstitutions} gives the `$1…$n` values).
 * Pure: no `chrome.*`, no DOM — this module runs in Node and in the extension alike.
 */

// ------------------------------------------------------------------------------- statuses

/** Waiting for its turn: nothing requested yet. */
export const QUEUED = "queued";
/** The page, the metadata or the manifests are being read (Analyze, or the start of a download). */
export const RESOLVING = "resolving";
/** Media requests are running. */
export const DOWNLOADING = "downloading";
/** Every byte is there: the progressive MP4 is being written. */
export const FINISHING = "finishing";
/** The written file is being checked (tracks, duration) before it is saved. */
export const VERIFYING = "verifying";
/** Downloaded, verified and saved. */
export const DONE = "done";
/** A file with the target's name is already in Downloads: no request was made. */
export const SKIPPED_EXISTS = "skipped-exists";
/** Something went wrong that a retry may fix: the network, a server error, a bad file. */
export const FAILED = "failed";
/**
 * The site refuses the video to this session: geo, login, premium, deleted, DRM, live, an
 * unsupported stream. A retry changes nothing until the session's rights change.
 */
export const FAILED_UNAVAILABLE = "failed-unavailable";
/** HTTP 429 / 412 or a risk-control page: the run stopped and the cooldown started. */
export const FAILED_RATE_LIMITED = "failed-rate-limited";
/**
 * HTTP 403 on a page or a manifest, a verification wall: the run stopped and the cooldown
 * started.
 */
export const FAILED_BLOCKED = "failed-blocked";
/** The run stopped before this target (a refusal, three failures in a row, Stop, a cooldown). */
export const STOPPED = "stopped";

/**
 * @typedef {"queued" | "resolving" | "downloading" | "finishing" | "verifying" | "done" |
 *   "skipped-exists" | "failed" | "failed-unavailable" | "failed-rate-limited" | "failed-blocked" |
 *   "stopped"} Status
 */

/** Every status, in the order of a target's life. */
export const STATUSES = Object.freeze(
  /** @type {const} */ ([
    QUEUED,
    RESOLVING,
    DOWNLOADING,
    FINISHING,
    VERIFYING,
    DONE,
    SKIPPED_EXISTS,
    FAILED,
    FAILED_UNAVAILABLE,
    FAILED_RATE_LIMITED,
    FAILED_BLOCKED,
    STOPPED,
  ]),
);
/** The statuses of a target the run is still working on. */
export const ACTIVE_STATUSES = Object.freeze(
  new Set([QUEUED, RESOLVING, DOWNLOADING, FINISHING, VERIFYING]),
);
/** The `failed-*` statuses. */
export const FAILURE_STATUSES = Object.freeze(
  new Set([FAILED, FAILED_UNAVAILABLE, FAILED_RATE_LIMITED, FAILED_BLOCKED]),
);
/** The statuses a target ends with. */
export const FINAL_STATUSES = Object.freeze(
  new Set([DONE, SKIPPED_EXISTS, ...FAILURE_STATUSES, STOPPED]),
);
/**
 * The statuses of a row that did not download: what the report lists, and what makes a run
 * worth a report.
 */
export const NOT_DOWNLOADED_STATUSES = Object.freeze(new Set([...FAILURE_STATUSES, STOPPED]));
/** The statuses that mean "the site refused": the run stops at once and the cooldown starts. */
export const BLOCK_STATUSES = Object.freeze(new Set([FAILED_RATE_LIMITED, FAILED_BLOCKED]));

/**
 * Whether `text` is one of the statuses.
 * @param {unknown} text
 * @returns {text is Status}
 */
export function isStatus(text) {
  return typeof text === "string" && /** @type {readonly string[]} */ (STATUSES).includes(text);
}

/**
 * Whether a target with this status is finished (nothing more will happen to it in this run).
 * @param {string} status
 * @returns {boolean}
 */
export function isFinal(status) {
  return FINAL_STATUSES.has(status);
}

/**
 * Whether the status is one of the `failed-*` statuses (`stopped` is not a failure of the target).
 * @param {string} status
 * @returns {boolean}
 */
export function isFailure(status) {
  return FAILURE_STATUSES.has(status);
}

/**
 * Whether a row with this status belongs in the "did not download" report (`failed-*` or
 * `stopped`).
 * @param {string} status
 * @returns {boolean}
 */
export function isNotDownloaded(status) {
  return NOT_DOWNLOADED_STATUSES.has(status);
}

/**
 * The English labels of the statuses: the report and the English UI use them, the Spanish UI the
 * `status_<status>` texts of `_locales` (same keys).
 * @type {Readonly<Record<Status, string>>}
 */
export const STATUS_LABELS_EN = Object.freeze({
  queued: "Queued",
  resolving: "Reading",
  downloading: "Downloading",
  finishing: "Finishing",
  verifying: "Verifying",
  done: "Done",
  "skipped-exists": "Already there",
  failed: "Failed",
  "failed-unavailable": "Not available",
  "failed-rate-limited": "Rate-limited",
  "failed-blocked": "Blocked",
  stopped: "Stopped",
});

/**
 * The English label of a status; an unknown status is returned as it is.
 * @param {string} status
 * @returns {string}
 */
export function statusLabel(status) {
  return isStatus(status) ? STATUS_LABELS_EN[status] : status;
}

// -------------------------------------------------------------------------- failure codes

/**
 * Every failure code a run may record, the fixed list of the spec (section 6) plus the two the
 * MPEG-TS demuxer reports (`unsupported_codec`, `corrupt_stream`: "the download fails with that
 * code"). The engine never writes a code outside this list.
 */
export const FAILURE_CODES = Object.freeze(
  /** @type {const} */ ([
    "http_status",
    "host_not_covered",
    "redirect_refused",
    "no_response",
    "truncated_body",
    "not_a_video",
    "encrypted",
    "key_protected",
    "live_stream",
    "discontinuous_stream",
    "legacy_stream",
    "geo_blocked",
    "login_required",
    "premium_only",
    "supporter_only",
    "trial_only",
    "deleted",
    "interactive",
    "rate_limited",
    "blocked",
    "verify_failed",
    "remux_failed",
    "save_failed",
    "stopped",
    "unsupported_link",
    "no_streams",
    "cooldown",
    "unsupported_codec",
    "corrupt_stream",
  ]),
);

/**
 * @typedef {(typeof FAILURE_CODES)[number]} FailureCode
 * @typedef {Record<string, unknown>} FailureParams The parameters of a failure, by name
 *   ({@link FAILURE_PARAMS}); a missing one renders as its default.
 * @typedef {{ code: FailureCode, params: FailureParams }} Failure What a result row carries.
 */

/**
 * The parameters of every code, in the order the `$1…$n` placeholders of `_locales` take them
 * ({@link failureSubstitutions}). Codes with an empty list take none.
 * @type {Readonly<Record<FailureCode, readonly string[]>>}
 */
export const FAILURE_PARAMS = Object.freeze({
  http_status: ["status", "what"],
  host_not_covered: ["host"],
  redirect_refused: ["host"],
  no_response: ["detail"],
  truncated_body: ["received", "expected"],
  not_a_video: ["content_type"],
  encrypted: ["detail"],
  key_protected: ["method"],
  live_stream: [],
  discontinuous_stream: ["count"],
  legacy_stream: [],
  geo_blocked: ["site_message"],
  login_required: [],
  premium_only: ["labels"],
  supporter_only: [],
  trial_only: [],
  deleted: ["site_message"],
  interactive: [],
  rate_limited: ["detail"],
  blocked: ["detail"],
  verify_failed: ["reason"],
  remux_failed: ["reason"],
  save_failed: ["reason"],
  stopped: ["reason"],
  unsupported_link: ["what"],
  no_streams: ["detail"],
  cooldown: ["until", "minutes_left", "reason"],
  unsupported_codec: ["stream_type"],
  corrupt_stream: ["detail"],
});

/**
 * The `what` of `http_status`: which request the site answered so. The `detail` of `rate_limited`
 * and `blocked` names the same request kinds (`HTTP 429 on the manifest request`).
 */
export const REQUEST_KINDS = Object.freeze(
  /** @type {const} */ ([
    "page",
    "short link",
    "metadata",
    "manifest",
    "playlist",
    "segment",
    "media",
    "cover",
  ]),
);

/**
 * Why a run stops before a target (`stopped` → `reason`); the engine writes one of these, the
 * UI's `_locales` may translate them (`stop_reason_<reason>`), {@link stopReasonText} renders
 * them in English.
 */
export const STOP_REASONS = Object.freeze(
  /** @type {const} */ ([
    "user",
    "consecutive_failures",
    "rate_limited",
    "blocked",
    "login_required",
    "cooldown",
  ]),
);
/** @typedef {(typeof STOP_REASONS)[number]} StopReason */

/** @type {Readonly<Record<StopReason, string>>} */
export const STOP_REASON_TEXTS_EN = Object.freeze({
  user: "you pressed Stop",
  consecutive_failures: "3 failures in a row stopped the run",
  rate_limited: "the site rate-limited this session and the run stopped",
  blocked: "the site blocked a request and the run stopped",
  login_required: "the site asked for a login and the run stopped",
  cooldown: "a cooldown is in force",
});

/**
 * Whether `text` is one of the {@link STOP_REASONS}.
 * @param {unknown} text
 * @returns {text is StopReason}
 */
export function isStopReason(text) {
  return (
    typeof text === "string" && /** @type {readonly string[]} */ (STOP_REASONS).includes(text)
  );
}

/**
 * The English text of a stop reason; a text that is not one of the {@link STOP_REASONS} (such as
 * `cooldown until 19:30`) is returned as it is.
 * @param {string} reason
 * @returns {string}
 */
export function stopReasonText(reason) {
  return isStopReason(reason) ? STOP_REASON_TEXTS_EN[reason] : reason;
}

/**
 * Why a pasted link was refused (`lib/urls.js` `Refused.reason`, plus `festival` for a Bilibili
 * festival page the parser meets) and the English text of each (the UI's `_locales` carry
 * `refused_<reason>`); also the `what` of the `unsupported_link` failure code.
 */
export const LINK_REFUSALS = Object.freeze(
  /** @type {const} */ ([
    "playlist",
    "bangumi",
    "space",
    "list",
    "audio",
    "live",
    "other-site",
    "unsupported-path",
    "junk",
    "festival",
  ]),
);
/** @typedef {(typeof LINK_REFUSALS)[number]} LinkRefusal */

/** @type {Readonly<Record<LinkRefusal, string>>} */
export const LINK_REFUSAL_TEXTS_EN = Object.freeze({
  playlist: "a playlist link: paste the link of one video",
  bangumi: "a bangumi (anime or series) link: out of scope in 1.0",
  space: "a user space (channel) link: paste the link of one video",
  list: "a list, favourites or search link: paste the link of one video",
  audio: "an audio link: out of scope in 1.0",
  live: "a live-stream link: live streams are out of scope",
  "other-site": "not a Dailymotion or Bilibili link",
  "unsupported-path": "a Dailymotion or Bilibili page that is not a single video",
  junk: "not a link",
  festival: "a festival page: paste the video's own link (…/video/BV…)",
});

/**
 * The English text of a link refusal; an unknown reason is returned as it is.
 * @param {string} reason
 * @returns {string}
 */
export function refusalText(reason) {
  return /** @type {readonly string[]} */ (LINK_REFUSALS).includes(reason)
    ? LINK_REFUSAL_TEXTS_EN[/** @type {LinkRefusal} */ (reason)]
    : reason;
}

/**
 * Whether `text` is one of the {@link FAILURE_CODES}.
 * @param {unknown} text
 * @returns {text is FailureCode}
 */
export function isFailureCode(text) {
  return (
    typeof text === "string" && /** @type {readonly string[]} */ (FAILURE_CODES).includes(text)
  );
}

/**
 * A failure record: the code checked, the parameters copied (never shared with the caller).
 * Throws for a code outside {@link FAILURE_CODES} — a programming error, never a runtime one.
 * @param {FailureCode} code
 * @param {FailureParams} [params]
 * @returns {Failure}
 */
export function failure(code, params = {}) {
  if (!isFailureCode(code)) throw new Error(`unknown failure code ${JSON.stringify(code)}`);
  return { code, params: { ...params } };
}

/** The codes whose status is `failed-unavailable`: the site refuses the video to this session. */
const UNAVAILABLE_CODES = new Set([
  "geo_blocked",
  "login_required",
  "premium_only",
  "supporter_only",
  "trial_only",
  "deleted",
  "interactive",
  "encrypted",
  "key_protected",
  "live_stream",
  "discontinuous_stream",
  "legacy_stream",
  "no_streams",
  "unsupported_link",
  "unsupported_codec",
]);

/**
 * The status a failure code gives its target: `rate_limited` → `failed-rate-limited`,
 * `blocked` → `failed-blocked`, `stopped` and `cooldown` → `stopped`, what the site refuses to
 * this session → `failed-unavailable`, everything else (network, server, file problems) →
 * `failed`.
 * @param {string} code
 * @returns {Status}
 */
export function statusForFailure(code) {
  if (code === "rate_limited") return FAILED_RATE_LIMITED;
  if (code === "blocked") return FAILED_BLOCKED;
  if (code === "stopped" || code === "cooldown") return STOPPED;
  if (UNAVAILABLE_CODES.has(code)) return FAILED_UNAVAILABLE;
  return FAILED;
}

/** What a missing parameter renders as, by name. */
const PARAM_DEFAULTS = Object.freeze(
  /** @type {Readonly<Record<string, string>>} */ ({
    status: "?",
    what: "page or media",
    host: "an unknown host",
    detail: "no detail",
    received: "0",
    expected: "?",
    content_type: "an unknown content type",
    method: "?",
    count: "?",
    site_message: "no message from the site",
    labels: "none listed",
    reason: "no reason given",
    until: "?",
    minutes_left: "?",
    stream_type: "unknown",
  }),
);

/**
 * One parameter as text: a number as decimal (`stream_type` as `0x..` hex), a list joined with
 * `, `, a string as it is; null, undefined, an empty string or list → the parameter's default.
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
export function paramText(name, value) {
  const fallback = PARAM_DEFAULTS[name] ?? "?";
  if (value === null || value === undefined) return fallback;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fallback;
    if (name === "stream_type") return `0x${value.toString(16).toUpperCase().padStart(2, "0")}`;
    return String(value);
  }
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return value === "" ? fallback : value;
  if (Array.isArray(value)) {
    const items = value.map((item) => paramText(name, item));
    return items.length > 0 ? items.join(", ") : fallback;
  }
  try {
    return JSON.stringify(value) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * The `$1…$n` substitutions of a code's `_locales` message: its parameters as text, in the order
 * of {@link FAILURE_PARAMS}. An unknown code has none.
 * @param {string} code
 * @param {FailureParams} [params]
 * @returns {string[]}
 */
export function failureSubstitutions(code, params = {}) {
  const names = isFailureCode(code) ? FAILURE_PARAMS[code] : [];
  return names.map((name) => paramText(name, params[name]));
}

/**
 * The English text of a failure — what the report's `message_en` and the English UI show, and
 * what the `_locales` `failure_<code>` texts translate with the same parameters. Never throws; an
 * unknown code renders as `unknown failure (<code>)`.
 * @param {string} code
 * @param {FailureParams} [params]
 * @returns {string}
 */
export function render(code, params = {}) {
  /** @param {string} name */
  const p = (name) => paramText(name, params[name]);
  switch (code) {
    case "http_status":
      return `HTTP ${p("status")} on the ${p("what")} request`;
    case "host_not_covered":
      return (
        `the media is on ${p("host")}, a host the extension has no permission for; ` +
        "it was not requested"
      );
    case "redirect_refused":
      return `a redirect led to ${p("host")}, outside the site; it was not followed`;
    case "no_response":
      return `no answer from the server (${p("detail")})`;
    case "truncated_body":
      return `the transfer was cut short (${p("received")} of ${p("expected")} bytes received)`;
    case "not_a_video":
      return `the server sent ${p("content_type")} where a video or a playlist was expected`;
    case "encrypted": {
      const detail = paramText("detail", params["detail"] ?? "encrypted tracks");
      return `encrypted media (DRM: ${detail}); StreamFetch never decrypts or keeps it`;
    }
    case "key_protected":
      return (
        `the playlist is key-protected (EXT-X-KEY METHOD=${p("method")}); ` +
        "StreamFetch never decrypts it"
      );
    case "live_stream":
      return "a live stream (the playlist never ends); live streams are out of scope";
    case "discontinuous_stream":
      return (
        `the playlist has ${p("count")} discontinuities (spliced content such as ads); ` +
        "not supported in 1.0"
      );
    case "legacy_stream":
      return "Bilibili served a legacy FLV/MP4 stream (durl) instead of DASH; not supported yet";
    case "geo_blocked":
      return (
        `not available in your country (${p("site_message")}); ` +
        "StreamFetch never bypasses geo-restrictions"
      );
    case "login_required":
      return (
        "the site asks for a login; log in to it in a normal tab of this Chrome profile, " +
        "then retry"
      );
    case "premium_only":
      return (
        `only premium qualities exist for this video (${p("labels")}) and this session is ` +
        "served none; StreamFetch never bypasses a paywall"
      );
    case "supporter_only":
      return "reserved for the uploader's paying supporters; this session is served no stream";
    case "trial_only":
      return (
        "Bilibili served only a trial clip (试看) to this session; " +
        "it was not saved as the video"
      );
    case "deleted":
      return `the video is gone or not available to this session (${p("site_message")})`;
    case "interactive":
      return "an interactive video (branching story); not supported";
    case "rate_limited":
      return (
        `the site is rate-limiting this session (${p("detail")}); the run stopped and a ` +
        "30-minute cooldown started"
      );
    case "blocked":
      return (
        `the site blocked the request (${p("detail")}); the run stopped and a 30-minute ` +
        "cooldown started"
      );
    case "verify_failed":
      return `the finished file failed verification (${p("reason")}); it was not saved`;
    case "remux_failed":
      return `the MP4 could not be written (${p("reason")}); nothing was saved`;
    case "save_failed":
      return `Chrome could not save the file (${p("reason")})`;
    case "stopped":
      return `not attempted: ${stopReasonText(p("reason"))}`;
    case "unsupported_link":
      return `unsupported link: ${refusalText(p("what"))}`;
    case "no_streams":
      return `the site offered no stream this session may play (${p("detail")})`;
    case "cooldown":
      return (
        `a cooldown is in force until ${p("until")} (${p("minutes_left")} min left) after the ` +
        `site refused a request (${p("reason")}); nothing is requested before then`
      );
    case "unsupported_codec":
      return (
        "the stream carries a codec StreamFetch cannot handle " +
        `(MPEG-TS stream type ${p("stream_type")})`
      );
    case "corrupt_stream":
      return `the media stream is corrupt (${p("detail")})`;
    default:
      return `unknown failure (${String(code)})`;
  }
}

/**
 * {@link render} of a failure record; null renders as an empty string.
 * @param {Failure | null | undefined} failure
 * @returns {string}
 */
export function failureText(failure) {
  return failure ? render(failure.code, failure.params) : "";
}
