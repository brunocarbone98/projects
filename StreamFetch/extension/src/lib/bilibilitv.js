// @ts-check
/**
 * Bilibili.tv (Bstation, also `biliintl.com`) — Bilibili's INTERNATIONAL site, a different
 * service from `www.bilibili.com` — read the way yt-dlp 2026.10.26's `BiliIntlBaseIE`,
 * `BiliIntlIE` and `BiliIntlSeriesIE` read it (facts read 2026-11-08; the sandbox cannot reach
 * the site, the owner verifies on a real machine). Pure: HTML or JSON in, decisions out; no
 * `chrome.*`, no DOM, no network, never `eval`, never a throw from a parser.
 *
 * Facts (Addendum A.1 of the spec):
 * - Pages: user videos `https://www.bilibili.tv/<lang>/video/<aid>`, series episodes
 *   `…/<lang>/play/<season_id>/<ep_id>`, a whole series `…/<lang>/play/<season_id>` or
 *   `…/media/<season_id>`. Every id is digits and stays a STRING here (an aid has 16 digits
 *   today, close to 2^53 − 1).
 * - Streams: `GET https://api.bilibili.tv/intl/gateway/web/playurl?platform=web&aid=<aid>` (or
 *   `&ep_id=<ep_id>`), with the session's cookies and `Referer: https://www.bilibili.tv/`. The
 *   answer `{code, message, data: {playurl: {video: [{video_resource: {url, codecs, width, height,
 *   bandwidth, size, mime_type, quality}, stream_info: {quality, desc_words}}], audio_resource:
 *   [{url, codecs, bandwidth, size, mime_type, quality}]}}}` lists video-only and audio-only files
 *   (complete MP4s, fragmented or not). `code` 0 is ok; `10004001` geo-restricted; `10004004`,
 *   `10004005`, `10023006` a login (or a premium episode); any other code an error with the site's
 *   `message`. An entry without `url` is not served to this session.
 * - Metadata: the page embeds `window.__INITIAL_DATA__ = {...}` or `window.__INITIAL_STATE__ =
 *   {...}` (or Nuxt's `__initialState`: read here only when it is a JSON object literal — the
 *   function form yt-dlp substitutes arguments into would need running the page's code, which
 *   StreamFetch never does; the fallbacks below cover such a page); the video is at
 *   `OgvVideo.epDetail` (episodes), `UgcVideo.videoData` or `ugc.archive` (user videos):
 *   `title_display` / `title`, `cover`, a duration when present. Fallbacks: the
 *   `bstar-meta__title` element, `og:title` / `og:image`, JSON-LD `VideoObject` (`name`, ISO 8601
 *   `duration`, `thumbnailUrl`).
 * - Series: `…/web/v2/ogv/play/episodes?season_id=<id>&platform=web` →
 *   `data.sections[].episodes[]` (`episode_id`, `title_display`, `title`, `cover`) and
 *   `…/web/v2/ogv/play/season_info?season_id=<id>&platform=web` → `data.season.title`.
 *
 * The stream selection is `lib/bilibili.js`'s — one implementation, two sites: the playurl answer
 * is turned into the same `PlayInfo` shape and handed to `bilibili.chooseStreams`.
 */

import {
  AUDIO_LABELS,
  QUALITY_LABELS,
  chooseStreams as chooseDashStreams,
  extractEmbeddedJson,
} from "./bilibili.js";
import { codecFamily } from "./hls.js";
import { isRecord, safeParse } from "./json.js";

/**
 * @typedef {import("./bilibili.js").DashRep} DashRep
 * @typedef {import("./bilibili.js").PlayInfo} PlayInfo
 * @typedef {import("./bilibili.js").StreamSelection} StreamSelection
 * @typedef {import("./bilibili.js").SupportFormat} SupportFormat
 *
 * @typedef {"geo_blocked" | "login_required" | "premium_only" | "deleted" | "no_streams" |
 *   "not_a_video"} BilibilitvRefusalCode
 *
 * @typedef {{ ok: false, code: BilibilitvRefusalCode, params: Record<string, unknown> }}
 *   BilibilitvRefusal A refusal of the site (or an answer that is no playurl answer); `params`
 *   carries the failure parameters (`site_message`, `labels`, `detail`, `content_type`) and the
 *   site's own `site_code` when it gave one.
 *
 * @typedef {PlayInfo & { ok: true }} BilibilitvPlay What a playurl answer offers this session, in
 *   `lib/bilibili.js`'s `PlayInfo` shape (no Dolby, no FLAC, never a trial or a legacy stream);
 *   `supportFormats` lists every quality the answer names, served or not.
 *
 * @typedef {"video" | "episode" | "series"} BilibilitvKind
 *
 * @typedef {object} BilibilitvPage What a video or episode page says about itself.
 * @property {string | null} title `title_display`, else `title`, else the fallbacks
 * @property {string | null} cover an http(s) URL
 * @property {number | null} durationS
 * @property {"video" | "episode" | null} kind which embedded object it came from (null: fallbacks
 *   only)
 *
 * @typedef {object} BilibilitvEpisode One episode of a series, in the series' order.
 * @property {string} epId digits, as text
 * @property {string | null} title `title_display` (`E3 - Episode title`), else `title`
 * @property {string | null} cover
 * @property {number | null} durationS
 * @property {number} index 1-based position in the series (every section, in order)
 *
 * @typedef {object} BilibilitvEpisodes
 * @property {BilibilitvEpisode[]} episodes
 * @property {BilibilitvRefusal | null} refusal the site's refusal (a geo or login code) when the
 *   answer carried one, else null
 *
 * @typedef {object} BilibilitvLink What {@link pageUrl} needs of a link.
 * @property {BilibilitvKind | string} kind
 * @property {string} id the aid, the ep_id or the season_id
 * @property {string | null} [seasonId] an episode's season
 */

/** The site's origin; test mode points the resolver at a fake one. */
export const BILIBILITV_ORIGIN = "https://www.bilibili.tv";
/** The API's origin. */
export const BILIBILITV_API_ORIGIN = "https://api.bilibili.tv";
/** The API's path prefix (yt-dlp's `_API_URL`). */
export const API_PREFIX = "/intl/gateway/web";
/** The language segment of the canonical page URLs. */
export const CANONICAL_LANGUAGE = "en";
/** The `Referer` the site's own player sends with its API and media requests. */
export const REFERER = "https://www.bilibili.tv/";
/** The playurl code of a geo-restricted video. */
export const GEO_CODE = 10004001;
/** The playurl codes of a video that needs a login (or a premium membership). */
export const LOGIN_CODES = Object.freeze([10004004, 10004005, 10023006]);
/**
 * A bare number from this value on is a duration in milliseconds, below it one in seconds: the
 * site's pages carry `duration` without a unit. 10 000 keeps clips of 10 s and more in
 * milliseconds and films up to 2 h 46 min in seconds right; a JSON-LD duration decides when the
 * page has one ({@link parsePage}).
 */
export const MILLISECONDS_FROM = 10_000;

const DIGITS_RE = /^[0-9]+$/;

// ------------------------------------------------------------------------- small readers

/**
 * A plain object, else null.
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function recordOf(value) {
  return isRecord(value) ? value : null;
}

/**
 * An array, else an empty one.
 * @param {unknown} value
 * @returns {unknown[]}
 */
function listOf(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * A string with something in it, trimmed, else null.
 * @param {unknown} value
 * @returns {string | null}
 */
function textOf(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

/**
 * A finite number (numbers written as strings included), else null.
 * @param {unknown} value
 * @returns {number | null}
 */
function numberOf(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

/**
 * A positive integer, else null.
 * @param {unknown} value
 * @returns {number | null}
 */
function positiveIntegerOf(value) {
  const number = numberOf(value);
  return number !== null && number > 0 && Number.isInteger(number) ? number : null;
}

/**
 * An http(s) URL as served (a protocol-relative `//host/path` becomes `https:`), else null.
 * @param {unknown} value
 * @returns {string | null}
 */
function urlOf(value) {
  const text = textOf(value);
  if (text === null) return null;
  if (text.startsWith("//")) return `https:${text}`;
  return /^https?:\/\//i.test(text) ? text : null;
}

/**
 * An id as digits in text: a digit string as it is, a JSON number only when it is a safe integer
 * (a larger one lost digits in `JSON.parse` and is never trusted); null otherwise.
 * @param {unknown} value
 * @returns {string | null}
 */
export function idText(value) {
  if (typeof value === "string") return DIGITS_RE.test(value.trim()) ? value.trim() : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/**
 * A duration in seconds from a bare number whose unit the site does not state: from
 * {@link MILLISECONDS_FROM} on it is read as milliseconds, below as seconds; null for anything
 * that is not a positive number.
 * @param {unknown} value
 * @returns {number | null}
 */
export function durationFromNumber(value) {
  const number = numberOf(value);
  if (number === null || number <= 0) return null;
  return number >= MILLISECONDS_FROM ? number / 1000 : number;
}

/**
 * An ISO 8601 duration (`PT1H2M3.5S`, `P1DT2H`) in seconds, else null.
 * @param {unknown} value
 * @returns {number | null}
 */
export function isoDurationSeconds(value) {
  const text = textOf(value);
  if (text === null) return null;
  const number = "(\\d+(?:\\.\\d+)?)";
  const pattern = `^P(?:${number}D)?(?:T(?:${number}H)?(?:${number}M)?(?:${number}S)?)?$`;
  const match = new RegExp(pattern, "i").exec(text);
  if (match === null || match.slice(1).every((part) => part === undefined)) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  const total =
    /** @type {number} */ (days) * 86400 +
    /** @type {number} */ (hours) * 3600 +
    /** @type {number} */ (minutes) * 60 +
    /** @type {number} */ (seconds);
  return total > 0 ? total : null;
}

/**
 * The duration a record names: `duration_ms` in milliseconds, else `duration` or
 * `video_duration` by magnitude ({@link durationFromNumber}) — or, when a `reference` duration is
 * known (the page's JSON-LD), the reading of the bare number closest to it. Null when none.
 * @param {Record<string, unknown>} record
 * @param {number | null} [reference]
 * @returns {number | null}
 */
function durationOfRecord(record, reference = null) {
  const ms = numberOf(record["duration_ms"]);
  if (ms !== null && ms > 0) return ms / 1000;
  for (const key of ["duration", "video_duration"]) {
    const raw = numberOf(record[key]);
    if (raw === null || raw <= 0) continue;
    if (reference !== null) {
      const asSeconds = Math.abs(raw - reference);
      const asMilliseconds = Math.abs(raw / 1000 - reference);
      return asMilliseconds < asSeconds ? raw / 1000 : raw;
    }
    return durationFromNumber(raw);
  }
  return null;
}

// --------------------------------------------------------------------------- the URLs

/**
 * The origin of a base without its trailing slashes.
 * @param {string} base
 * @returns {string}
 */
function rootOf(base) {
  return base.replace(/\/+$/, "");
}

/**
 * The playurl request of a user video (`aid`) or an episode (`epId`), the id sent as text:
 * `<base>/intl/gateway/web/playurl?platform=web&aid=<aid>` (or `&ep_id=<ep_id>`).
 * @param {string} base the API's origin ({@link BILIBILITV_API_ORIGIN}, or a test base)
 * @param {{ aid?: string, epId?: string }} ids
 * @returns {string}
 */
export function playurlUrl(base, ids) {
  const query =
    ids.aid !== undefined
      ? `aid=${encodeURIComponent(ids.aid)}`
      : `ep_id=${encodeURIComponent(ids.epId ?? "")}`;
  return `${rootOf(base)}${API_PREFIX}/playurl?platform=web&${query}`;
}

/**
 * The episode list of a series: `<base>/intl/gateway/web/v2/ogv/play/episodes?season_id=<id>&
 * platform=web`.
 * @param {string} base
 * @param {string} seasonId
 * @returns {string}
 */
export function episodesUrl(base, seasonId) {
  const id = encodeURIComponent(seasonId);
  return `${rootOf(base)}${API_PREFIX}/v2/ogv/play/episodes?season_id=${id}&platform=web`;
}

/**
 * The facts of a series: `<base>/intl/gateway/web/v2/ogv/play/season_info?season_id=<id>&
 * platform=web`.
 * @param {string} base
 * @param {string} seasonId
 * @returns {string}
 */
export function seasonInfoUrl(base, seasonId) {
  const id = encodeURIComponent(seasonId);
  return `${rootOf(base)}${API_PREFIX}/v2/ogv/play/season_info?season_id=${id}&platform=web`;
}

/**
 * The canonical page of a link: `<base>/en/video/<aid>`, `<base>/en/play/<season>/<ep>` for an
 * episode, `<base>/en/play/<season>` for a series. Throws for an episode without its season or an
 * unknown kind — a programming error, never a runtime one (`lib/urls.js` always has both).
 * @param {BilibilitvLink} link
 * @param {string} [base] {@link BILIBILITV_ORIGIN} by default
 * @returns {string}
 */
export function pageUrl(link, base = BILIBILITV_ORIGIN) {
  const root = `${rootOf(base)}/${CANONICAL_LANGUAGE}`;
  const id = encodeURIComponent(link.id);
  if (link.kind === "video") return `${root}/video/${id}`;
  if (link.kind === "series") return `${root}/play/${id}`;
  if (link.kind === "episode") {
    if (!link.seasonId) throw new Error(`episode ${link.id} has no season`);
    return `${root}/play/${encodeURIComponent(link.seasonId)}/${id}`;
  }
  throw new Error(`unknown Bilibili.tv link kind ${JSON.stringify(link.kind)}`);
}

// ------------------------------------------------------------------------ the API's codes

/**
 * The refusal an API answer's non-zero `code` means, or null for `code` 0 (or none): 10004001 →
 * `geo_blocked`; 10004004, 10004005, 10023006 → `login_required` (a login, or a premium episode);
 * any other code → `deleted` with the site's own message (unavailable to this session). The
 * site's code is kept as `site_code`; `site_message` is the site's `message` unless it only
 * repeats the code (yt-dlp's rule), then a sentence naming the code.
 * @param {Record<string, unknown>} answer
 * @returns {BilibilitvRefusal | null}
 */
export function codeRefusal(answer) {
  const raw = answer["code"];
  if (raw === undefined || raw === null) return null;
  const code = numberOf(raw);
  if (code === 0) return null;
  const siteCode = code === null ? String(raw) : String(code);
  const message = textOf(answer["message"]);
  const siteMessage =
    message !== null && message !== siteCode ? message : `Bilibili.tv answered code ${siteCode}`;
  const params = { site_code: siteCode, site_message: siteMessage };
  if (code === GEO_CODE) return { ok: false, code: "geo_blocked", params };
  if (code !== null && LOGIN_CODES.includes(code)) {
    return { ok: false, code: "login_required", params };
  }
  return { ok: false, code: "deleted", params };
}

// ------------------------------------------------------------------------ the playurl

/**
 * The label of a video quality: the site's `desc_words`, else the English label of its quality
 * id, else `<height>P`; null when nothing names it.
 * @param {string | null} descWords
 * @param {number} quality
 * @param {number | null} height
 * @returns {string | null}
 */
function videoLabel(descWords, quality, height) {
  return descWords ?? QUALITY_LABELS[quality] ?? (height !== null ? `${height}P` : null);
}

/**
 * One representation of a playurl resource, or null when it has no http(s) URL.
 * @param {Record<string, unknown>} resource `video_resource` or an `audio_resource[]` entry
 * @param {number} id the quality id
 * @param {"video" | "audio"} kind
 * @param {string | null} label
 * @returns {DashRep | null}
 */
function representationOf(resource, id, kind, label) {
  const url = urlOf(resource["url"]);
  if (url === null) return null;
  const codecs = textOf(resource["codecs"]) ?? "";
  const isVideo = kind === "video";
  const bandwidth = numberOf(resource["bandwidth"]);
  return {
    id,
    codecs,
    codecFamily: isVideo ? codecFamily(codecs) : "unknown",
    bandwidth: bandwidth !== null && bandwidth > 0 ? Math.floor(bandwidth) : 0,
    width: isVideo ? positiveIntegerOf(resource["width"]) : null,
    height: isVideo ? positiveIntegerOf(resource["height"]) : null,
    frameRate: null,
    urls: [url],
    mimeType: textOf(resource["mime_type"]) ?? textOf(resource["mimeType"]),
    size: positiveIntegerOf(resource["size"]),
    label,
  };
}

/**
 * What a playurl answer offers this session: `{ ok: true, videos, audios, … }` in
 * `lib/bilibili.js`'s `PlayInfo` shape, or the refusal. Video ids are `stream_info.quality` (else
 * the resource's own `quality`), labels `stream_info.desc_words`; an entry without a URL is not
 * downloadable but its quality still goes to `supportFormats` (a quality the session is not
 * served: the premium hint). Refusals: a non-zero `code` ({@link codeRefusal}); not a JSON object
 * → `not_a_video`; no `data.playurl` → `no_streams`; video entries that all lack a URL →
 * `premium_only` with their labels; no video entry at all → `no_streams`. Never throws.
 * @param {unknown} json the answer, parsed (a string is parsed here)
 * @returns {BilibilitvPlay | BilibilitvRefusal}
 */
export function parsePlayurl(json) {
  const answer = recordOf(typeof json === "string" ? safeParse(json) : json);
  if (answer === null) {
    const params = { content_type: "an answer that is not JSON" };
    return { ok: false, code: "not_a_video", params };
  }
  const refusal = codeRefusal(answer);
  if (refusal !== null) return refusal;
  const data = recordOf(answer["data"]);
  const playurl = data === null ? null : recordOf(data["playurl"]);
  if (playurl === null) {
    return { ok: false, code: "no_streams", params: { detail: "the answer has no playurl" } };
  }
  /** @type {DashRep[]} */
  const videos = [];
  /** @type {SupportFormat[]} */
  const supportFormats = [];
  /** @type {string[]} */
  const unserved = [];
  for (const entry of listOf(playurl["video"])) {
    const record = recordOf(entry);
    if (record === null) continue;
    const resource = recordOf(record["video_resource"]) ?? {};
    const info = recordOf(record["stream_info"]) ?? {};
    const quality =
      positiveIntegerOf(info["quality"]) ?? positiveIntegerOf(resource["quality"]) ?? 0;
    const height = positiveIntegerOf(resource["height"]);
    const label = videoLabel(textOf(info["desc_words"]), quality, height);
    const codecs = textOf(resource["codecs"]);
    if (quality > 0 && !supportFormats.some((format) => format.quality === quality)) {
      supportFormats.push({
        quality,
        label: label ?? String(quality),
        codecs: codecs === null ? [] : [codecs],
      });
    }
    const rep = representationOf(resource, quality, "video", label);
    if (rep !== null) videos.push(rep);
    else unserved.push(label ?? String(quality));
  }
  /** @type {DashRep[]} */
  const audios = [];
  for (const entry of listOf(playurl["audio_resource"])) {
    const record = recordOf(entry);
    if (record === null) continue;
    const quality = positiveIntegerOf(record["quality"]) ?? 0;
    const bandwidth = numberOf(record["bandwidth"]);
    const label =
      AUDIO_LABELS[quality] ??
      (bandwidth !== null && bandwidth > 0 ? `${Math.round(bandwidth / 1000)}K` : null);
    const rep = representationOf(record, quality, "audio", label);
    if (rep !== null) audios.push(rep);
  }
  if (videos.length === 0) {
    if (unserved.length > 0) {
      return { ok: false, code: "premium_only", params: { labels: [...new Set(unserved)] } };
    }
    const params = { detail: "the playurl answer lists no video" };
    return { ok: false, code: "no_streams", params };
  }
  return {
    ok: true,
    videos,
    audios,
    dolby: [],
    flac: null,
    supportFormats,
    acceptQuality: supportFormats.map((format) => format.quality),
    acceptDescription: [],
    timelengthS: null,
    trialOnly: false,
    legacy: false,
  };
}

/**
 * The streams to download: `lib/bilibili.js`'s selection over the playurl's representations (the
 * best height not above `maxHeight`, the codec preference only among streams of that height, the
 * highest-bandwidth AAC audio), with `missingPremium` named by the site's own labels
 * (`desc_words`) of the qualities the answer lists without a URL. Null when nothing is offered.
 * @param {BilibilitvPlay | PlayInfo | null | undefined} play
 * @param {{ maxHeight: number | null, codec: "compatible" | "best" }} preferences
 * @returns {StreamSelection | null}
 */
export function chooseStreams(play, preferences) {
  const selection = chooseDashStreams(play, preferences);
  if (selection === null || !play) return selection;
  const served = new Set(play.videos.map((rep) => rep.id));
  const missingPremium = play.supportFormats
    .filter((format) => !served.has(format.quality))
    .map((format) => format.label);
  return { ...selection, missingPremium };
}

// --------------------------------------------------------------------------- the page

/** Named HTML entities a title may carry. */
const ENTITIES = Object.freeze(
  /** @type {Readonly<Record<string, string>>} */ ({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  }),
);

/**
 * Text with its HTML character references decoded (`&amp;`, `&#39;`, `&#x4E2D;`, …); an unknown
 * or invalid reference stays as written.
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name) => {
    const body = String(name);
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      const valid = Number.isInteger(code) && code > 0 && code <= 0x10ffff;
      return valid ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * The attributes of one start tag (`<meta property="og:title" content="…">`), names lower-cased,
 * values entity-decoded.
 * @param {string} tag
 * @returns {Map<string, string>}
 */
function attributesOf(tag) {
  /** @type {Map<string, string>} */
  const attributes = new Map();
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const match of tag.matchAll(re)) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attributes.set(String(match[1]).toLowerCase(), decodeEntities(value));
  }
  return attributes;
}

/**
 * The `content` of the first `<meta property|name="<name>">` of a page, else null.
 * @param {string} html
 * @param {string} name `og:title`, `og:image`
 * @returns {string | null}
 */
export function metaContent(html, name) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = attributesOf(match[0]);
    const key = attributes.get("property") ?? attributes.get("name");
    if (key?.toLowerCase() !== name) continue;
    const content = textOf(attributes.get("content"));
    if (content !== null) return content;
  }
  return null;
}

/**
 * The text of the first element whose `class` holds `className` (tags inside removed, entities
 * decoded, whitespace collapsed), else null.
 * @param {string} html
 * @param {string} className
 * @returns {string | null}
 */
export function elementTextByClass(html, className) {
  // start tags only: an element's text runs to the first closing tag of its name
  for (const match of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
    const classes = attributesOf(String(match[2])).get("class") ?? "";
    if (!classes.split(/\s+/).includes(className)) continue;
    const start = /** @type {number} */ (match.index) + match[0].length;
    const close = html.slice(start).search(new RegExp(`</${String(match[1])}\\s*>`, "i"));
    if (close === -1) continue;
    const inner = html.slice(start, start + close);
    const text = decodeEntities(inner.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (text !== "") return text;
  }
  return null;
}

/**
 * Every JSON-LD object of a page (`<script type="application/ld+json">`), arrays and `@graph`
 * flattened; a block that is not JSON is skipped.
 * @param {string} html
 * @returns {Record<string, unknown>[]}
 */
function jsonLdObjects(html) {
  /** @type {Record<string, unknown>[]} */
  const objects = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  /** @param {unknown} value */
  const collect = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
    } else if (isRecord(value)) {
      objects.push(value);
      if (Array.isArray(value["@graph"])) collect(value["@graph"]);
    }
  };
  for (const match of html.matchAll(re)) {
    const type = attributesOf(String(match[1])).get("type") ?? "";
    if (type.trim().toLowerCase() !== "application/ld+json") continue;
    collect(safeParse(String(match[2]).trim()));
  }
  return objects;
}

/**
 * The first JSON-LD `VideoObject` of a page: its `name`, its ISO 8601 `duration` in seconds and
 * its first `thumbnailUrl` (a string, a list or an `ImageObject`).
 * @param {string} html
 * @returns {{ name: string | null, durationS: number | null, thumbnail: string | null } | null}
 */
export function jsonLdVideo(html) {
  for (const object of jsonLdObjects(html)) {
    const type = object["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (!types.includes("VideoObject")) continue;
    /** @type {string | null} */
    let thumbnail = null;
    for (const candidate of listOf(object["thumbnailUrl"]).concat([object["thumbnailUrl"]])) {
      const record = recordOf(candidate);
      thumbnail = urlOf(record === null ? candidate : record["url"]);
      if (thumbnail !== null) break;
    }
    return {
      name: textOf(object["name"]),
      durationS: isoDurationSeconds(object["duration"]),
      thumbnail,
    };
  }
  return null;
}

/**
 * The video object a page's embedded state holds, with the layout it came from.
 * @param {string} html
 * @returns {{ video: Record<string, unknown>, kind: "video" | "episode" } | null}
 */
function embeddedVideo(html) {
  for (const marker of ["__INITIAL_DATA__", "__INITIAL_STATE__", "__initialState"]) {
    const state = recordOf(extractEmbeddedJson(html, marker));
    if (state === null) continue;
    const ogv = recordOf(state["OgvVideo"]);
    const episode = ogv === null ? null : recordOf(ogv["epDetail"]);
    if (episode !== null) return { video: episode, kind: "episode" };
    const ugcVideo = recordOf(state["UgcVideo"]);
    const videoData = ugcVideo === null ? null : recordOf(ugcVideo["videoData"]);
    if (videoData !== null) return { video: videoData, kind: "video" };
    const ugc = recordOf(state["ugc"]);
    const archive = ugc === null ? null : recordOf(ugc["archive"]);
    if (archive !== null) return { video: archive, kind: "video" };
  }
  return null;
}

/**
 * What a Bilibili.tv video or episode page says about itself, read as yt-dlp merges it (the first
 * value found wins): the embedded state's video object (`OgvVideo.epDetail`, `UgcVideo.videoData`,
 * `ugc.archive`, under `window.__INITIAL_DATA__`, `window.__INITIAL_STATE__` or a JSON
 * `window.__initialState`) — `title_display` / `title`, `cover`, a duration —, then the
 * `bstar-meta__title` element and `og:title` / `og:image`, then JSON-LD's `VideoObject` (`name`,
 * `duration`, `thumbnailUrl`). A bare duration number is read in seconds or milliseconds by its
 * magnitude, or by the JSON-LD duration when the page has one. Null when the page names nothing.
 * Never throws.
 * @param {unknown} html
 * @returns {BilibilitvPage | null}
 */
export function parsePage(html) {
  if (typeof html !== "string" || html === "") return null;
  try {
    const embedded = embeddedVideo(html);
    const ld = jsonLdVideo(html);
    const video = embedded?.video ?? null;
    const title =
      (video === null ? null : (textOf(video["title_display"]) ?? textOf(video["title"]))) ??
      elementTextByClass(html, "bstar-meta__title") ??
      metaContent(html, "og:title") ??
      ld?.name ??
      null;
    const cover =
      (video === null ? null : urlOf(video["cover"])) ??
      urlOf(metaContent(html, "og:image")) ??
      ld?.thumbnail ??
      null;
    const durationS =
      (video === null ? null : durationOfRecord(video, ld?.durationS ?? null)) ??
      ld?.durationS ??
      null;
    if (title === null && cover === null && durationS === null) return null;
    return { title, cover, durationS, kind: embedded?.kind ?? null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------- a series

/**
 * The episodes of a series in the order the site lists them (every section, in order), each with
 * its id as text — an `episode_id` given as a JSON number beyond 2^53 − 1 lost digits and is
 * skipped, never trusted —, its title (`title_display`, else `title`), cover and duration;
 * duplicates dropped (the first kept). A non-zero `code` gives no episode and the refusal. Never
 * throws.
 * @param {unknown} json the episodes answer, parsed (a string is parsed here)
 * @returns {BilibilitvEpisodes}
 */
export function parseEpisodes(json) {
  const answer = recordOf(typeof json === "string" ? safeParse(json) : json);
  if (answer === null) return { episodes: [], refusal: null };
  const refusal = codeRefusal(answer);
  if (refusal !== null) return { episodes: [], refusal };
  const data = recordOf(answer["data"]) ?? answer;
  /** @type {BilibilitvEpisode[]} */
  const episodes = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const section of listOf(data["sections"])) {
    const sectionRecord = recordOf(section);
    if (sectionRecord === null) continue;
    for (const entry of listOf(sectionRecord["episodes"])) {
      const episode = recordOf(entry);
      if (episode === null) continue;
      const epId = idText(episode["episode_id"]);
      if (epId === null || seen.has(epId)) continue;
      seen.add(epId);
      episodes.push({
        epId,
        title: textOf(episode["title_display"]) ?? textOf(episode["title"]),
        cover: urlOf(episode["cover"]),
        durationS: durationOfRecord(episode),
        index: episodes.length + 1,
      });
    }
  }
  return { episodes, refusal: null };
}

/**
 * The title of a series from its `season_info` answer (`data.season.title`); null when the answer
 * has none (a refusal included). Never throws.
 * @param {unknown} json the answer, parsed (a string is parsed here)
 * @returns {{ title: string | null }}
 */
export function parseSeasonInfo(json) {
  const answer = recordOf(typeof json === "string" ? safeParse(json) : json);
  if (answer === null || codeRefusal(answer) !== null) return { title: null };
  const data = recordOf(answer["data"]) ?? answer;
  const season = recordOf(data["season"]);
  return { title: season === null ? null : textOf(season["title"]) };
}
