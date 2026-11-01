// @ts-check
/**
 * Shared texts and constants of DramaFetch for Chrome, byte-identical to the Python constants
 * they port (`models.py`, `downloader.py`, `downloader_browser.py`, `media.py`, `engine.py`,
 * `discovery/browser.py`, `web/jobs.py`); `tests/test_extension_parity.py` compares every one of
 * them with its Python original. Pure: no `chrome.*`, no DOM — this module runs in Node and in
 * the extension alike.
 *
 * Statuses, access modes and messages are data the engine writes into the per-series state and
 * the report; they stay English (like the Python tool's manifest). The UI translates its own
 * strings through `chrome.i18n`.
 */

/** TikTok's web origin (`models.TIKTOK_BASE_URL`); test mode may point the extension elsewhere. */
export const TIKTOK_BASE_URL = "https://www.tiktok.com";
/** Default episode file name, without extension (`models.DEFAULT_NAME_FORMAT`). */
export const DEFAULT_NAME_FORMAT = "{series} - Episode {number}";
/** Where an episode's cover goes (`models.THUMBNAIL_MODES`): into the MP4, both, a file, none. */
export const THUMBNAIL_MODES = Object.freeze(/** @type {const} */ (["embed", "both", "file", "none"]));
/** Which rendition is taken (`models.QUALITY_MODES`): the best H.264, or the best of anything. */
export const QUALITY_MODES = Object.freeze(/** @type {const} */ (["compatible", "best"]));
/** A series complete less than this long ago (seconds) is skipped without a request. */
export const RECHECK_AFTER_S = 24 * 3600;
/** `Episode.access` values (`models.ACCESS_MODES`): what THIS session may do with an episode. */
export const ACCESS_MODES = Object.freeze(/** @type {const} */ (["free", "unlocked", "locked"]));

/** Every DRM message starts with this: DramaFetch never decrypts and never keeps encrypted media. */
export const DRM_MARK = "protected by DRM";
/** The verdict of a downloaded file with encrypted tracks (`models.DRM_MESSAGE`). */
export const DRM_MESSAGE = `${DRM_MARK} (encrypted tracks): DramaFetch does not decrypt it`;
/** The skip of an episode an earlier run's DOWNLOAD found encrypted (`models.DRM_REMEMBERED_MESSAGE`). */
export const DRM_REMEMBERED_MESSAGE =
  `${DRM_MARK} (found by an earlier run): DramaFetch does not decrypt it; ` +
  "--include-locked tries again";
/** A payload-flagged DRM episode without hints (`downloader.PAYLOAD_DRM_MESSAGE`); never remembered. */
export const PAYLOAD_DRM_MESSAGE = `${DRM_MARK} (flagged in the episode list): DramaFetch does not decrypt it`;
/** What a complete skip's report line adds when locked episodes remain (`engine.RECHECK_HINT`). */
export const RECHECK_HINT = "unlocked more in the TikTok app since? --recheck looks again";
/** Prefix of a FAILED_BLOCKED message: HTTP 403, TikTok refused (`downloader.BLOCKED_MESSAGE`). */
export const BLOCKED_MESSAGE =
  "blocked (HTTP 403): TikTok refused the request; wait 30-60 minutes before trying again";
/** Prefix of the message of an episode whose bytes failed the verification (`media.INCOMPLETE_PREFIX`). */
export const INCOMPLETE_PREFIX = "download looks incomplete or wrong: ";
/** No URL gave a video (`downloader_browser.UNAVAILABLE_MESSAGE`). */
export const UNAVAILABLE_MESSAGE = "no playable stream: locked, region-restricted or not logged in";
/** A 429 from the video CDN (`downloader_browser.RATE_LIMIT_MESSAGE`): stop + cooldown. */
export const MEDIA_RATE_LIMIT_MESSAGE =
  "rate limited (HTTP 429) by the video server: wait 30-60 minutes before trying again";
/** A 429 on the episode list (`discovery.browser.RATE_LIMIT_MESSAGE`): stop + cooldown. */
export const LIST_RATE_LIMIT_MESSAGE =
  "TikTok is rate-limiting this address (HTTP 429 on the episode list): wait 30-60 minutes " +
  "before trying again";
/** Message of the rows of an episode the state knows to be on disk (`engine.MANIFEST_SKIP_PREFIX`). */
export const MANIFEST_SKIP_PREFIX = "already downloaded (manifest): ";
/** Every result written for an episode a run gave up on starts with this (`engine.STOPPED_PREFIX`). */
export const STOPPED_PREFIX = "stopped: ";
/** Every series a stop left untouched starts its error with this (`web.jobs.NOT_STARTED_PREFIX`). */
export const NOT_STARTED_PREFIX = "not started: ";

/** `DownloadStatus.DONE`: the episode was downloaded, verified and saved. */
export const DONE = "done";
/** `DownloadStatus.SKIPPED_EXISTS`: already on disk; no request. */
export const SKIPPED_EXISTS = "skipped-exists";
/** `DownloadStatus.SKIPPED_LOCKED`: locked for this session (or remembered as DRM); no request. */
export const SKIPPED_LOCKED = "skipped-locked";
/** `DownloadStatus.DRY_RUN` (the extension has no dry run; kept for the shared status set). */
export const DRY_RUN = "dry-run";
/** `DownloadStatus.FAILED_LOGIN`: TikTok wants a login; stops the run. */
export const FAILED_LOGIN = "failed-login-required";
/** `DownloadStatus.FAILED_UNAVAILABLE`: locked, region-restricted, removed, private or DRM. */
export const FAILED_UNAVAILABLE = "failed-unavailable";
/** `DownloadStatus.FAILED_RATE_LIMITED`: HTTP 429 (or a cooldown met mid-run); stops the run. */
export const FAILED_RATE_LIMITED = "failed-rate-limited";
/** `DownloadStatus.FAILED_BLOCKED`: HTTP 403 or a captcha; stops the run. */
export const FAILED_BLOCKED = "failed-blocked";
/** `DownloadStatus.FAILED`: anything else that went wrong. */
export const FAILED = "failed";

/**
 * Every status, in the order of Python's `DownloadStatus` enum (what `summarize` counts in).
 * @typedef {"done" | "skipped-exists" | "skipped-locked" | "dry-run" | "failed-login-required" |
 *   "failed-unavailable" | "failed-rate-limited" | "failed-blocked" | "failed"} Status
 */
export const STATUSES = Object.freeze(
  /** @type {const} */ ([
    DONE,
    SKIPPED_EXISTS,
    SKIPPED_LOCKED,
    DRY_RUN,
    FAILED_LOGIN,
    FAILED_UNAVAILABLE,
    FAILED_RATE_LIMITED,
    FAILED_BLOCKED,
    FAILED,
  ]),
);
/** The statuses `DownloadStatus.ok` is true for: nothing went wrong. */
export const OK_STATUSES = Object.freeze(new Set([DONE, SKIPPED_EXISTS, SKIPPED_LOCKED, DRY_RUN]));

/**
 * `DownloadStatus.ok`: the status is a success or a skip (never one of the `failed-*`).
 * @param {string} status
 * @returns {boolean}
 */
export function isOk(status) {
  return OK_STATUSES.has(status);
}

/**
 * Whether `text` is one of the statuses.
 * @param {unknown} text
 * @returns {text is Status}
 */
export function isStatus(text) {
  return typeof text === "string" && /** @type {readonly string[]} */ (STATUSES).includes(text);
}

// ------------------------------------------------------------------ Python's text rules
// The Python tool's texts and decisions depend on Python's own string semantics; the ports use
// these helpers wherever the Python code relies on them, so that the same input gives the same
// answer (tests/test_extension_parity.py proves it on a fuzz corpus).

/**
 * The characters of Python's `str.isspace()`, which `str.strip()` removes and `re`'s `\s`
 * matches — NOT JavaScript's `trim()` set (Python also has U+001C-U+001F and U+0085, and lacks
 * U+FEFF). For building character classes: `[${PY_SPACE}]`.
 */
export const PY_SPACE =
  "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
const PY_LSTRIP_RE = new RegExp(`^[${PY_SPACE}]+`);
const PY_RSTRIP_RE = new RegExp(`[${PY_SPACE}]+$`);

/**
 * Python's `text.strip()` (no argument): leading and trailing Python whitespace removed.
 * @param {string} text
 * @returns {string}
 */
export function pyStrip(text) {
  return text.replace(PY_STRIP_RE, "");
}

/**
 * Python's `text.lstrip()` (no argument).
 * @param {string} text
 * @returns {string}
 */
export function pyLstrip(text) {
  return text.replace(PY_LSTRIP_RE, "");
}

/**
 * Python's `text.rstrip()` (no argument).
 * @param {string} text
 * @returns {string}
 */
export function pyRstrip(text) {
  return text.replace(PY_RSTRIP_RE, "");
}

/** The non-ASCII characters Python's `re.IGNORECASE` matches against an ASCII letter. */
const CASELESS_SPECIALS = new Map([
  ["\u0130", "i"], // LATIN CAPITAL LETTER I WITH DOT ABOVE (its simple lowercase is "i")
  ["\u0131", "i"], // LATIN SMALL LETTER DOTLESS I (an "i" equivalent in Python's re)
  ["\u017f", "s"], // LATIN SMALL LETTER LONG S (an "s" equivalent)
  ["\u212a", "k"], // KELVIN SIGN (its simple lowercase is "k")
]);
const CASELESS_RE = /[A-Z\u0130\u0131\u017f\u212a]/g;

/**
 * `text` as Python's `re.IGNORECASE` sees it against a pattern of ASCII letters: ASCII capitals
 * lowered, and the four non-ASCII characters Python matches to an ASCII letter (`\u0130` `\u0131` → `i`,
 * `\u017f` → `s`, the Kelvin sign → `k`) replaced by it. Every replaced character is one UTF-16 unit
 * and so is its replacement, so indexes into the result are indexes into `text`. The ports run
 * a lower-case pattern WITHOUT the `i` flag over this text (JavaScript's `i` flag matches
 * neither those four nor, with `u`, the same set).
 * @param {string} text
 * @returns {string}
 */
export function caseless(text) {
  return text.replace(CASELESS_RE, (ch) => CASELESS_SPECIALS.get(ch) ?? ch.toLowerCase());
}

/**
 * Length in code points, Python's `len(text)` (JavaScript's `length` counts UTF-16 units).
 * @param {string} text
 * @returns {number}
 */
export function pyLen(text) {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * The first `count` code points of `text`, Python's `text[:count]` (`count` >= 0).
 * @param {string} text
 * @param {number} count
 * @returns {string}
 */
export function pyHead(text, count) {
  if (text.length <= count) return text; // fewer units than code points asked: all of it
  let out = "";
  let taken = 0;
  for (const ch of text) {
    if (taken >= count) break;
    out += ch;
    taken += 1;
  }
  return out;
}

const NOT_PRINTABLE_RE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/**
 * Python's `repr(text)` for a str: single quotes unless the text holds `'` and no `"`; `\\`,
 * the quote, `\t` `\n` `\r` escaped; other ASCII controls as `\xNN`; non-printable non-ASCII
 * (categories C*, Z* — the space excepted) as `\xNN`, `\uNNNN` or `\UNNNNNNNN`.
 * @param {string} text
 * @returns {string}
 */
export function pyRepr(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${hex(cp, 2)}`;
    else if (cp < 0x7f) out += ch;
    else if (!NOT_PRINTABLE_RE.test(ch)) out += ch;
    else if (cp <= 0xff) out += `\\x${hex(cp, 2)}`;
    else if (cp <= 0xffff) out += `\\u${hex(cp, 4)}`;
    else out += `\\U${hex(cp, 8)}`;
  }
  return out + quote;
}

/**
 * @param {number} value
 * @param {number} width
 * @returns {string}
 */
function hex(value, width) {
  return value.toString(16).padStart(width, "0");
}

/**
 * Python's `f"{x:g}"` for a float: 6 significant digits, trailing zeros dropped, exponent form
 * (`1e-05`, `1.23457e+06`) below 1e-4 or from 1e6 on. (An exact decimal tie rounds up here and
 * to even in Python: no pacing value is one.)
 * @param {number} x
 * @returns {string}
 */
export function pyFormatG(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const [mantissa, expText] = x.toExponential(5).split("e");
  const exponent = Number(expText);
  if (exponent < -4 || exponent >= 6) {
    const sign = exponent < 0 ? "-" : "+";
    return `${dropZeros(/** @type {string} */ (mantissa))}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return dropZeros(x.toFixed(5 - exponent));
}

/**
 * @param {string} text
 * @returns {string}
 */
function dropZeros(text) {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/**
 * `str(value)` of a JSON number as Python prints it. JavaScript cannot tell `1` from `1.0`, so a
 * whole number prints as an int (`30`, as TikTok sends it); a fraction as Python's float repr
 * (`0.5`, `1e-05` below 1e-4).
 * @param {number} value
 * @returns {string}
 */
export function pyNumberText(value) {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (Number.isInteger(value)) {
    return Math.abs(value) < 1e21 ? String(value === 0 ? 0 : value) : BigInt(value).toString();
  }
  if (Math.abs(value) < 1e-4) {
    const [mantissa, expText] = value.toExponential().split("e");
    const exponent = Number(expText);
    const sign = exponent < 0 ? "-" : "+";
    return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return String(value);
}

/**
 * `str(value)` of a JSON scalar as Python prints it: `True` / `False` for booleans, numbers as
 * {@link pyNumberText}, strings as they are.
 * @param {boolean | number | string} value
 * @returns {string}
 */
export function pyScalarText(value) {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return pyNumberText(value);
  return value;
}

const ND_RE = /^\p{Nd}$/u;
const DECIMAL_INT_RE = /^-?\p{Nd}+$/u;
/** Python refuses to convert a str of more digits than this to an int (`sys.int_info`). */
const PY_INT_MAX_STR_DIGITS = 4300;

/**
 * The value 0-9 of one Unicode decimal digit (category Nd: `٣`, `３`, …), -1 for anything
 * else. Decimal digits come in runs of ten from 0 to 9 (a Unicode stability rule), so the value
 * is the distance from the start of the digit's run, modulo 10.
 * @param {string} ch one code point
 * @returns {number}
 */
export function decimalDigitValue(ch) {
  if (!ND_RE.test(ch)) return -1;
  const cp = /** @type {number} */ (ch.codePointAt(0));
  let start = cp;
  while (start > 0 && ND_RE.test(String.fromCodePoint(start - 1))) start -= 1;
  return (cp - start) % 10;
}

/**
 * Python's `int(text)` for a text whose `text.lstrip("-").isdigit()` held — what
 * `catalog._as_int` and `catalog.url_expiry` do: an optional `-` then Unicode decimal digits
 * (`"٣"` is 3; `"²"` passes `isdigit()` but not `int()`), at most 4300 digits; null otherwise.
 * The text must already be stripped.
 * @param {string} text
 * @returns {number | null}
 */
export function pyDecimalInt(text) {
  if (!DECIMAL_INT_RE.test(text)) return null;
  const negative = text.startsWith("-");
  let digits = "";
  for (const ch of negative ? text.slice(1) : text) digits += String(decimalDigitValue(ch));
  if (digits.length > PY_INT_MAX_STR_DIGITS) return null;
  const value = Number(digits);
  return negative ? -value : value;
}
