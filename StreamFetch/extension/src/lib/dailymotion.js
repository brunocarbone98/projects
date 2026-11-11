// @ts-check
/**
 * Dailymotion's player metadata JSON, read the way yt-dlp 2026.10.26's `DailymotionIE` reads it
 * (facts read 2026-11-08; the sandbox cannot reach the site, the owner verifies on a real
 * machine). Pure: JSON in, a decision out; no `chrome.*`, no DOM, no network, never a throw.
 *
 * Facts: `GET https://www.dailymotion.com/player/metadata/video/<id>?app=com.dailymotion.neon`
 * answers, for the user's own session (cookies: the family filter `ff`, the login), either the
 * video — `title`, `duration` (seconds), `owner.screenname` / `owner.id`, `created_time`,
 * `explicit`, `posters` / `thumbnails` (`{ "<height>": url }`), `qualities` (a dict quality →
 * list of `{ type, url }`; the HLS master is the `application/x-mpegURL` entry under `auto`;
 * `application/vnd.lumberjack.manifest` entries are ignored; any other type is a direct file, not
 * expected today) — or `error: { code, title, raw_message }`: `DM007` is geo-blocking, any other
 * code makes the video unavailable with the site's own title. Video ids are `x` + lower-case
 * alphanumerics (`x8vu47w`) or `k` + alphanumerics (`k2Y4Mjp7krAF9iCuINM`). Posters live on
 * `s1.dmcdn.net` / `s2.dmcdn.net`.
 */

/**
 * @typedef {object} DailymotionInfo What the metadata says about a playable video.
 * @property {string | null} id the xid the JSON carries (`expectedId` when it carries none)
 * @property {string} title "" when the JSON has no title
 * @property {number | null} durationS positive seconds, else null
 * @property {string | null} uploader `owner.screenname`
 * @property {string | null} uploaderId `owner.id`, else the top-level `screenname`
 * @property {string | null} cover the poster {@link COVER_PREFERENCE} selects
 * @property {boolean} explicit
 * @property {number | null} createdTime `created_time` (Unix seconds)
 * @property {string} masterUrl the HLS master playlist
 *
 * @typedef {"geo_blocked" | "not_a_video" | "no_streams"} DailymotionRefusalCode
 *
 * @typedef {{ ok: true, info: DailymotionInfo }
 *   | { ok: false, code: DailymotionRefusalCode, params: Record<string, string> }
 * } DailymotionMetadataResult
 */

/** The site; test mode points `metadataUrl` / `pageUrl` at a fake. */
export const DAILYMOTION_BASE_URL = "https://www.dailymotion.com";
/** The query the player sends with the metadata request (yt-dlp sends the same). */
export const METADATA_QUERY = "app=com.dailymotion.neon";
/** The MIME type of the HLS master in `qualities`. */
export const HLS_TYPE = "application/x-mpegURL";
/** Entries of this type are Dailymotion's own analytics manifest, never a stream. */
export const LUMBERJACK_TYPE = "application/vnd.lumberjack.manifest";
/** The error code of a geo-blocked video (Dailymotion's access errors). */
export const GEO_BLOCKED_CODE = "DM007";
/**
 * Which poster becomes the row's cover: the largest one at most `maxHeight` pixels high, read
 * from `posters` first and `thumbnails` second; when every poster is taller, the smallest.
 */
export const COVER_PREFERENCE = Object.freeze({
  maxHeight: 720,
  sources: Object.freeze(
    /** @type {readonly ["posters", "thumbnails"]} */ (["posters", "thumbnails"]),
  ),
});
/** A Dailymotion video id: `x` + lower-case alphanumerics, or `k` + alphanumerics. */
export const VIDEO_ID_RE = /^(?:x[0-9a-z]+|k[0-9A-Za-z]+)$/;

/**
 * Whether `text` is a Dailymotion video id.
 * @param {unknown} text
 * @returns {text is string}
 */
export function isVideoId(text) {
  return typeof text === "string" && VIDEO_ID_RE.test(text);
}

/**
 * A plain object, else null.
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function recordOf(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * A non-empty string, else null.
 * @param {unknown} value
 * @returns {string | null}
 */
function textOf(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * A positive finite number (numbers written as strings included), else null.
 * @param {unknown} value
 * @returns {number | null}
 */
function positiveOf(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * `base` without trailing slashes.
 * @param {string} base
 * @returns {string}
 */
function trimBase(base) {
  return base.replace(/\/+$/, "");
}

/**
 * The metadata request of a video: `<base>/player/metadata/video/<id>?app=com.dailymotion.neon`.
 * @param {string} base `https://www.dailymotion.com` or the test fake's base
 * @param {string} id
 * @returns {string}
 */
export function metadataUrl(base, id) {
  return `${trimBase(base)}/player/metadata/video/${encodeURIComponent(id)}?${METADATA_QUERY}`;
}

/**
 * The canonical page of a video: `https://www.dailymotion.com/video/<id>`.
 * @param {string} id
 * @param {string} [base]
 * @returns {string}
 */
export function pageUrl(id, base = DAILYMOTION_BASE_URL) {
  return `${trimBase(base)}/video/${encodeURIComponent(id)}`;
}

/**
 * The poster {@link COVER_PREFERENCE} selects among `posters` / `thumbnails` (`{ "<h>": url }`):
 * the largest at most 720 px high, else the smallest; keys that are not heights are ignored
 * unless nothing else exists. Null when there is no poster.
 * @param {unknown} json the metadata object
 * @returns {string | null}
 */
export function chooseCover(json) {
  const metadata = recordOf(json);
  if (metadata === null) return null;
  /** @type {{ height: number, url: string }[]} */
  const sized = [];
  /** @type {string[]} */
  const unsized = [];
  for (const source of COVER_PREFERENCE.sources) {
    const posters = recordOf(metadata[source]);
    if (posters === null) continue;
    for (const [key, value] of Object.entries(posters)) {
      const url = textOf(value);
      if (url === null || !/^https?:\/\//i.test(url)) continue;
      const height = positiveOf(key);
      if (height === null) unsized.push(url);
      else sized.push({ height, url });
    }
    if (sized.length > 0) break; // posters first; thumbnails only when there is no poster
  }
  if (sized.length === 0) return unsized[0] ?? null;
  const fitting = sized.filter((poster) => poster.height <= COVER_PREFERENCE.maxHeight);
  // the largest that fits; when none fits, the smallest there is
  const wantLarger = fitting.length > 0;
  const pool = wantLarger ? fitting : sized;
  let best = /** @type {{ height: number, url: string }} */ (pool[0]);
  for (const poster of pool) {
    if (wantLarger ? poster.height > best.height : poster.height < best.height) best = poster;
  }
  return best.url;
}

/**
 * The HLS master among `qualities`: the `application/x-mpegURL` entry under `auto`, else the first
 * such entry under any quality (the player's "auto" is where Dailymotion puts it). Lumberjack
 * entries and entries without a URL are skipped. Also returns the types seen, for the row's hint
 * when no master exists.
 * @param {unknown} qualities
 * @returns {{ masterUrl: string | null, types: string[] }}
 */
export function findHlsMaster(qualities) {
  const table = recordOf(qualities);
  /** @type {string[]} */
  const types = [];
  if (table === null) return { masterUrl: null, types };
  let masterUrl = null;
  const keys = Object.keys(table).sort((a, b) => (a === "auto" ? -1 : b === "auto" ? 1 : 0));
  for (const key of keys) {
    const entries = table[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const record = recordOf(entry);
      if (record === null) continue;
      const type = textOf(record["type"]);
      const url = textOf(record["url"]);
      if (type !== null && type !== LUMBERJACK_TYPE && !types.includes(type)) types.push(type);
      if (masterUrl === null && type === HLS_TYPE && url !== null) masterUrl = url;
    }
  }
  return { masterUrl, types };
}

/**
 * What the metadata JSON decides: the video's facts and its HLS master, or a refusal —
 * `error.code === "DM007"` → `geo_blocked`; any other `error` → `not_a_video` (status
 * `failed-unavailable`) with `params.site_message = error.title || error.raw_message` and
 * `params.site_code`; a JSON that is not an object → `not_a_video`; a video without an HLS master
 * → `no_streams` (`params.types`: the stream types the JSON offers instead, comma-separated).
 * Never throws.
 * @param {unknown} json the parsed metadata response
 * @param {string | null} [expectedId] the id the link named, used when the JSON carries none
 * @returns {DailymotionMetadataResult}
 */
export function parseMetadata(json, expectedId = null) {
  const metadata = recordOf(json);
  if (metadata === null) {
    return {
      ok: false,
      code: "not_a_video",
      params: { site_message: "the metadata is not a JSON object" },
    };
  }
  const error = metadata["error"];
  const errorRecord = recordOf(error);
  if (errorRecord !== null || textOf(error) !== null) {
    const code = errorRecord === null ? "" : (textOf(errorRecord["code"]) ?? "");
    const message =
      errorRecord === null
        ? /** @type {string} */ (error)
        : (textOf(errorRecord["title"]) ??
          textOf(errorRecord["raw_message"]) ??
          textOf(errorRecord["message"]) ??
          code);
    if (code === GEO_BLOCKED_CODE) {
      return { ok: false, code: "geo_blocked", params: { site_message: message, site_code: code } };
    }
    return { ok: false, code: "not_a_video", params: { site_message: message, site_code: code } };
  }
  const { masterUrl, types } = findHlsMaster(metadata["qualities"]);
  if (masterUrl === null) {
    return { ok: false, code: "no_streams", params: { types: types.join(", ") } };
  }
  const owner = recordOf(metadata["owner"]);
  return {
    ok: true,
    info: {
      id: textOf(metadata["id"]) ?? expectedId,
      title: typeof metadata["title"] === "string" ? metadata["title"] : "",
      durationS: positiveOf(metadata["duration"]),
      uploader: owner === null ? null : textOf(owner["screenname"]),
      uploaderId: (owner === null ? null : textOf(owner["id"])) ?? textOf(metadata["screenname"]),
      cover: chooseCover(metadata),
      explicit: Boolean(metadata["explicit"]),
      createdTime: positiveOf(metadata["created_time"]),
      masterUrl,
    },
  };
}
