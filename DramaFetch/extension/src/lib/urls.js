// @ts-check
/**
 * Parse what the user pastes into a series or video reference, and build TikTok page URLs: a
 * port of `urls.py`, plus the rules of the CLI's `--from-file` for the text box of the app page
 * (one link or id per line). Pure: no `chrome.*`, no DOM.
 *
 * Verified facts (October 2026, see `urls.py`): the short-drama entry point is
 * `https://www.tiktok.com/shortdrama/episode/<series_id>/<episode_number>`; the long number is the
 * series (TikTok: `dramaID`), the trailing number the 1-based episode. Ids and episode numbers are
 * ASCII `[0-9]`, never `\d`: full-width or Arabic-Indic digits are refused like any other text.
 */

import { dedupeRefs } from "./report.js";
import { PY_SPACE, TIKTOK_BASE_URL, caseless, pyHead, pyRepr, pyStrip } from "./messages.js";

/**
 * @typedef {object} SeriesRef A short-drama series identified from a pasted URL or id.
 * @property {"series"} kind
 * @property {string} seriesId
 * @property {number | null} episodeHint the 1-based episode the viewer was looking at
 * @property {string} sourceUrl
 *
 * @typedef {object} VideoRef A single ordinary TikTok video (`/@user/video/<item_id>`).
 * @property {"video"} kind
 * @property {string} itemId
 * @property {string | null} author
 * @property {string} sourceUrl
 */

/** What `parseInput` throws for text that names no series or video (`errors.UnsupportedUrlError`). */
export class UnsupportedUrlError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "UnsupportedUrlError";
  }
}

// The patterns of urls.py, written lower-case and matched against `caseless(text)` — that is
// re.IGNORECASE as Python applies it (`\u017f`, `\u0131`, `\u0130` and the Kelvin sign included). Python's `.`
// is `[^\n]` (JavaScript's also stops at \r, U+2028, U+2029) and its `$` also matches before a
// final newline: `(?=\n?$)`.
const HOST = String.raw`https?://(?:www\.|m\.)?tiktok\.com`;
const TAIL = String.raw`/?(?:[?#][^\n]*)?(?=\n?$)`;
const SERIES_EPISODE_RE = new RegExp(
  String.raw`^${HOST}/shortdrama/episode/(?<id>[0-9]{15,22})(?:/(?<n>[0-9]{1,4}))?${TAIL}`,
  "u",
);
const SERIES_RE = new RegExp(
  String.raw`^${HOST}/shortdrama/(?:detail/|series/)?(?<id>[0-9]{15,22})${TAIL}`,
  "u",
);
// Python's \w is Unicode-aware: letters, digits and numbers of any script, and "_".
const VIDEO_RE = new RegExp(
  String.raw`^${HOST}/(?:@(?<user>[\p{L}\p{N}_.\-]+)/)?video/(?<id>[0-9]{15,22})${TAIL}`,
  "du",
);
const SHORT_LINK_RE = /^https?:\/\/(?:vm|vt)\.tiktok\.com\/|^https?:\/\/(?:www\.)?tiktok\.com\/t\//;
const BARE_ID_RE = /^[0-9]{15,22}(?=\n?$)/;
const SCHEMELESS_RE = /^(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\//;
const ANGLE_BRACKETS_RE = /^[<>]+|[<>]+$/g;

/**
 * The series or video `text` refers to (`urls.parse_input`); throws {@link UnsupportedUrlError}
 * with the Python tool's message otherwise.
 * @param {string} text
 * @returns {SeriesRef | VideoRef}
 */
export function parseInput(text) {
  let candidate = pyStrip(pyStrip(text).replace(ANGLE_BRACKETS_RE, ""));
  if (!candidate) {
    throw new UnsupportedUrlError("Paste a TikTok short-drama URL (…/shortdrama/episode/<id>/<n>).");
  }
  // People paste addresses without the scheme ("www.tiktok.com/shortdrama/…"): accept them.
  if (SCHEMELESS_RE.test(caseless(candidate))) candidate = `https://${candidate}`;
  const folded = caseless(candidate);
  if (BARE_ID_RE.test(candidate)) {
    return { kind: "series", seriesId: candidate, episodeHint: null, sourceUrl: candidate };
  }
  let match = SERIES_EPISODE_RE.exec(folded);
  if (match?.groups) {
    const hint = match.groups["n"] ? Number(match.groups["n"]) : null;
    return {
      kind: "series",
      seriesId: /** @type {string} */ (match.groups["id"]),
      episodeHint: hint || null,
      sourceUrl: candidate,
    };
  }
  match = SERIES_RE.exec(folded);
  if (match?.groups) {
    return {
      kind: "series",
      seriesId: /** @type {string} */ (match.groups["id"]),
      episodeHint: null,
      sourceUrl: candidate,
    };
  }
  match = VIDEO_RE.exec(folded);
  if (match?.groups) {
    // the user group from the text as pasted (caseless() kept every index where it was)
    const span = match.indices?.groups?.["user"];
    return {
      kind: "video",
      itemId: /** @type {string} */ (match.groups["id"]),
      author: span ? candidate.slice(span[0], span[1]) : null,
      sourceUrl: candidate,
    };
  }
  if (SHORT_LINK_RE.test(folded)) {
    throw new UnsupportedUrlError(
      "Short links (vm.tiktok.com, vt.tiktok.com, tiktok.com/t/…) are not resolved: open the " +
        "link in your browser and paste the full address, which contains /shortdrama/episode/.",
    );
  }
  throw new UnsupportedUrlError(
    `Not a TikTok short-drama or video URL: ${pyRepr(pyHead(candidate, 120))}. Expected ` +
      "https://www.tiktok.com/shortdrama/episode/<series id>/<episode> or " +
      "https://www.tiktok.com/@user/video/<id>.",
  );
}

/**
 * `base` without its trailing slashes (Python's `base_url.rstrip('/')`).
 * @param {string} base
 * @returns {string}
 */
function trimBase(base) {
  return base.replace(/\/+$/, "");
}

/**
 * The series page the discovery opens (`urls.series_page_url`).
 * @param {string} seriesId
 * @param {number} [episode]
 * @param {string} [base]
 * @returns {string}
 */
export function seriesPageUrl(seriesId, episode = 1, base = TIKTOK_BASE_URL) {
  return `${trimBase(base)}/shortdrama/episode/${seriesId}/${Math.max(1, episode)}`;
}

/**
 * The ordinary video page of an episode (`urls.video_page_url`); TikTok ignores the username.
 * @param {string} itemId
 * @param {string | null} [author]
 * @param {string} [base]
 * @returns {string}
 */
export function videoPageUrl(itemId, author = null, base = TIKTOK_BASE_URL) {
  return `${trimBase(base)}/@${author || "_"}/video/${itemId}`;
}

/**
 * The series a tab shows — a short-drama page URL of TikTok (or, in test mode, of `base`) — or
 * null: a bare id, a video page or any other page is no series tab.
 * @param {string} url
 * @param {string} [base]
 * @returns {SeriesRef | null}
 */
export function seriesRefFromUrl(url, base = TIKTOK_BASE_URL) {
  if (typeof url !== "string") return null;
  let text = url;
  const root = trimBase(base);
  if (root !== TIKTOK_BASE_URL && text.startsWith(`${root}/`)) {
    text = TIKTOK_BASE_URL + text.slice(root.length);
  }
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const ref = parseInput(text);
    return ref.kind === "series" ? ref : null;
  } catch (error) {
    if (error instanceof UnsupportedUrlError) return null;
    throw error;
  }
}

/**
 * Whether a tab's URL is a TikTok short-drama series page (the popup's "Download this series").
 * @param {string} url
 * @param {string} [base]
 * @returns {boolean}
 */
export function isShortDramaUrl(url, base = TIKTOK_BASE_URL) {
  return seriesRefFromUrl(url, base) !== null;
}

/**
 * @typedef {object} SeriesListLine A refused line of the text box.
 * @property {number} line 1-based
 * @property {"unsupported" | "video"} kind
 * @property {string} message the line, then the reason
 *
 * @typedef {object} SeriesList What {@link parseSeriesList} makes of the text box.
 * @property {SeriesRef[]} refs every series, in order, duplicates dropped (first one kept)
 * @property {string[]} notes `duplicate: <series id>` per dropped duplicate
 * @property {SeriesListLine[]} errors refused lines; nothing may start while there is one
 * @property {number} lines how many lines named something (comments and blank lines aside)
 */

/** The Python CLI's inline comment rule: whitespace then `#` (`cli._INLINE_COMMENT_RE`). */
const INLINE_COMMENT_RE = new RegExp(`[${PY_SPACE}]#`);
const LINE_BREAK_RE = /\r\n|\r|\n/;

/**
 * The series the text box names, by the rules of the CLI's `--from-file` (`cli._read_series_file`
 * and `cli._collect_series`): one link or id per line; blank lines, `#` lines and text after
 * whitespace + `#` ignored; a byte-order mark tolerated; every line parsed before anything starts —
 * unsupported text or a single-video URL is refused naming its line (`line 4: …`); duplicates are
 * dropped with a note (`engine.dedupe_refs`).
 * @param {string} text
 * @returns {SeriesList}
 */
export function parseSeriesList(text) {
  /** @type {SeriesRef[]} */
  const refs = [];
  /** @type {SeriesListLine[]} */
  const errors = [];
  let lines = 0;
  const body = text.startsWith("\ufeff") ? text.slice(1) : text;
  body.split(LINE_BREAK_RE).forEach((raw, index) => {
    let line = pyStrip(raw);
    if (!line || line.startsWith("#")) return;
    const comment = INLINE_COMMENT_RE.exec(line);
    if (comment !== null) line = pyStrip(line.slice(0, comment.index));
    if (!line) return;
    lines += 1;
    const where = `line ${index + 1}: `;
    try {
      const ref = parseInput(line);
      if (ref.kind === "video") {
        errors.push({
          line: index + 1,
          kind: "video",
          message:
            `${where}${pyRepr(pyStrip(line))} is a single video, not a series: paste the link of ` +
            "a series (…/shortdrama/episode/<series id>/<episode>)",
        });
      } else {
        refs.push(ref);
      }
    } catch (error) {
      if (!(error instanceof UnsupportedUrlError)) throw error;
      errors.push({ line: index + 1, kind: "unsupported", message: `${where}${error.message}` });
    }
  });
  const { kept, notes } = dedupeRefs(refs);
  return { refs: kept, notes, errors, lines };
}
