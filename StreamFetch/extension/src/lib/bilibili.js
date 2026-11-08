// @ts-check
/**
 * Bilibili's video page as the user's own browser receives it, read the way yt-dlp 2026.10.26's
 * `BiliBiliIE` reads it (facts read 2026-11-08; the sandbox cannot reach the site, the owner
 * verifies on a real machine). Pure: HTML or JSON in, decisions out; no `chrome.*`, no DOM, no
 * network, never `eval`, never a throw.
 *
 * Facts: the page embeds `window.__INITIAL_STATE__ = {...};` and `window.__playinfo__ = {...}`.
 * `__INITIAL_STATE__.videoData` carries `bvid`, `aid`, `title`, `desc`, `pic`, `duration`,
 * `pages[]` (`cid`, `page`, `part`, `duration`), `rights.is_stein_gate` (an interactive video)
 * and `is_upower_exclusive` (supporter-only); `upData.name` / `upData.mid` is the uploader;
 * `error.trueCode` is `-403` when a login is required and `-404` when the video is deleted or
 * geo-restricted; a page without `__INITIAL_STATE__` but with `window._riskdata_` carrying
 * `v_voucher` means the site is rate-limiting this session; a festival page carries `videoInfo`
 * instead of `videoData`. `__playinfo__.data` is the playurl answer the page itself requested
 * (`fnval=4048`) for the part shown: `dash.video[]` (`id` = quality: 127 8K, 126 Dolby Vision,
 * 125 HDR, 120 4K, 116 1080p60, 112 1080p+, 80 1080p, 64 720p, 32 480p, 16 360p; `codecs`
 * `avc1.…` / `hev1.…` / `av01.…`; `bandwidth`, `width`, `height`, `frameRate`, `baseUrl` /
 * `base_url`, `backupUrl` / `backup_url`, `mimeType`, `size`), `dash.audio[]` (30216 64k,
 * 30232 132k, 30280 192k; `mp4a.40.2`), `dash.dolby.audio[]` (`ec-3`, premium) and
 * `dash.flac.audio` (premium), `support_formats[]` and `accept_quality[]` (what exists, which may
 * exceed what this session is served: premium-only qualities are simply absent from
 * `dash.video`), `accept_description[]` (`试看` marks a trial clip), `timelength` (ms). A `durl`
 * answer without `dash` is the legacy FLV/MP4 stream, not supported in 1.0. Video ids: `BV` + 10
 * alphanumerics (case-sensitive) or `av` + digits. StreamFetch never requests the playurl API
 * itself (that would mean computing the site's request signature): what the page embeds is what
 * this session may play.
 */

import { codecFamily } from "./hls.js";

/**
 * @typedef {import("./hls.js").CodecFamily} CodecFamily
 *
 * @typedef {object} DashRep One DASH representation (a complete fragmented MP4 file of one track).
 * @property {number} id the quality id (video) or the audio id; 0 when missing
 * @property {string} codecs as served (`avc1.640028`, `mp4a.40.2`, `ec-3`, `fLaC`); "" unknown
 * @property {CodecFamily} codecFamily of a video representation; `unknown` for audio
 * @property {number} bandwidth bits per second; 0 unknown
 * @property {number | null} width
 * @property {number | null} height
 * @property {number | null} frameRate
 * @property {string[]} urls `baseUrl` first, then the backups in order (http(s) only, deduplicated)
 * @property {string | null} mimeType
 * @property {number | null} size bytes
 * @property {string | null} label `1080P60`, `720P`, `192K`, `Dolby`, `FLAC`, … (the site's own
 *   description when this file knows no English label)
 *
 * @typedef {object} SupportFormat One `support_formats[]` entry: a quality that exists.
 * @property {number} quality
 * @property {string} label the site's `new_description` / `display_desc`, else the English label
 * @property {string[]} codecs
 *
 * @typedef {object} PlayInfo What `__playinfo__.data` offers this session.
 * @property {DashRep[]} videos `dash.video[]` with at least one URL, in the served order
 * @property {DashRep[]} audios `dash.audio[]` (AAC)
 * @property {DashRep[]} dolby `dash.dolby.audio[]` (premium)
 * @property {DashRep | null} flac `dash.flac.audio` (premium)
 * @property {SupportFormat[]} supportFormats
 * @property {number[]} acceptQuality
 * @property {string[]} acceptDescription
 * @property {number | null} timelengthS `timelength` in seconds
 * @property {boolean} trialOnly `试看` in an `accept_description`: the served stream is a trial
 * @property {boolean} legacy `durl` without `dash`: the legacy stream, refused in 1.0
 *
 * @typedef {object} PartRef One part (page) of a video.
 * @property {number} part 1-based
 * @property {string} cid
 * @property {string} title the part's own title (`part`); "" when none
 * @property {number | null} durationS
 *
 * @typedef {object} BilibiliInfo The video a page shows (`VideoInfo` plus the Bilibili extras).
 * @property {"bilibili"} site
 * @property {string} id `BV…` or `av…` (canonical case)
 * @property {number | null} part the part this page is for when the video has several, else null
 * @property {string} pageUrl `https://www.bilibili.com/video/<id>[?p=N]`
 * @property {string} title
 * @property {string | null} uploader
 * @property {string | null} uploaderId
 * @property {number | null} durationS the whole video (every part)
 * @property {string | null} cover `videoData.pic`
 * @property {PartRef[] | null} parts every part when there are several, else null
 * @property {number | null} aid
 * @property {PartRef[]} pages every part, one for a single-part video
 * @property {number} selectedPart the part whose `__playinfo__` the page embeds (1-based)
 * @property {boolean} isUpowerExclusive supporter-only
 * @property {string | null} description `videoData.desc`
 *
 * @typedef {"login_required" | "deleted" | "rate_limited" | "interactive" | "unsupported_link"
 *   | "not_a_video" | "supporter_only" | "trial_only" | "legacy_stream"} BilibiliRefusalCode
 *
 * @typedef {{ ok: true, info: BilibiliInfo, play: PlayInfo | null }
 *   | { ok: false, code: BilibiliRefusalCode, params: Record<string, string> }} BilibiliPageResult
 *
 * @typedef {object} StreamSelection What {@link chooseStreams} picks.
 * @property {DashRep} video
 * @property {DashRep | null} audio null only when the page offers no audio track at all
 * @property {string[]} missingPremium `support_formats` qualities absent from `dash.video` (labels)
 * @property {DashRep[]} available every video representation offered
 * @property {DashRep[]} audioAvailable every AAC representation offered
 */

/** The site; test mode points `pageUrl` at a fake. */
export const BILIBILI_BASE_URL = "https://www.bilibili.com";
/** The marker of a trial clip in `accept_description`. */
export const TRIAL_MARKER = "试看";
/** English labels of the video quality ids (the site's own descriptions are Chinese). */
export const QUALITY_LABELS = Object.freeze(
  /** @type {Readonly<Record<number, string>>} */ ({
    127: "8K",
    126: "Dolby Vision",
    125: "HDR",
    120: "4K",
    116: "1080P60",
    112: "1080P+",
    80: "1080P",
    64: "720P",
    32: "480P",
    16: "360P",
  }),
);
/** The nominal height of a video quality id, orientation aside (a portrait 1080P is 1080 wide). */
export const QUALITY_HEIGHTS = Object.freeze(
  /** @type {Readonly<Record<number, number>>} */ ({
    127: 4320,
    120: 2160,
    116: 1080,
    112: 1080,
    80: 1080,
    64: 720,
    32: 480,
    16: 360,
  }),
);
/** English labels of the AAC audio ids. */
export const AUDIO_LABELS = Object.freeze(
  /** @type {Readonly<Record<number, string>>} */ ({
    30216: "64K",
    30232: "132K",
    30280: "192K",
  }),
);
/** The codec families `compatible` mode prefers, best first. */
const COMPATIBLE_ORDER = /** @type {readonly CodecFamily[]} */ (["avc", "hevc", "av1"]);
const BV_ID_RE = /^bv([0-9A-Za-z]{10})$/i;
const AV_ID_RE = /^av0*(\d+)$/i;
const IDENTIFIER_CHAR_RE = /[\w$.]/;

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
 * An array, else an empty one.
 * @param {unknown} value
 * @returns {unknown[]}
 */
function listOf(value) {
  return Array.isArray(value) ? value : [];
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
 * A finite number (numbers written as strings included), else null.
 * @param {unknown} value
 * @returns {number | null}
 */
function numberOf(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

/**
 * A positive finite number, else null.
 * @param {unknown} value
 * @returns {number | null}
 */
function positiveOf(value) {
  const number = numberOf(value);
  return number !== null && number > 0 ? number : null;
}

/**
 * A positive integer, else null.
 * @param {unknown} value
 * @returns {number | null}
 */
function positiveIntegerOf(value) {
  const number = positiveOf(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

/**
 * A frame rate as Bilibili writes it: a number, a numeric string (`"25"`) or a fraction
 * (`"16000/672"`), else null.
 * @param {unknown} value
 * @returns {number | null}
 */
export function frameRateOf(value) {
  if (typeof value === "string") {
    const fraction = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
    if (fraction !== null) {
      const denominator = Number(fraction[2]);
      return denominator > 0 ? Number(fraction[1]) / denominator : null;
    }
  }
  return positiveOf(value);
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
 * The canonical form of a Bilibili video id: `BV` + its ten case-sensitive characters (the prefix
 * upper-cased), or `av` + digits (lower-cased, leading zeros dropped). Null for anything else.
 * @param {unknown} id
 * @returns {string | null}
 */
export function canonicalId(id) {
  if (typeof id !== "string") return null;
  const bv = BV_ID_RE.exec(id.trim());
  if (bv !== null) return `BV${bv[1]}`;
  const av = AV_ID_RE.exec(id.trim());
  if (av !== null) return `av${av[1]}`;
  return null;
}

/**
 * The canonical page of a video: `https://www.bilibili.com/video/<id>`, with `?p=N` for one part
 * of a multi-part video.
 * @param {string} id
 * @param {number | null} [part]
 * @param {string} [base]
 * @returns {string}
 */
export function pageUrl(id, part = null, base = BILIBILI_BASE_URL) {
  const root = base.replace(/\/+$/, "");
  const query = part !== null && Number.isInteger(part) && part > 0 ? `?p=${part}` : "";
  return `${root}/video/${encodeURIComponent(id)}${query}`;
}

/**
 * The index just past the object literal that starts at `start` (an opening brace): braces are
 * counted outside strings, strings (`"` or `'`) skip their escapes. -1 when unbalanced.
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function endOfObject(text, start) {
  let depth = 0;
  /** @type {string | null} */
  let quote = null;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * The JSON object a page assigns to `window.<marker>`: the first `window.<marker> = {` (any
 * spaces, a single `=`) whose braces balance and whose text parses as JSON, matched with a brace
 * scanner that understands strings and escapes — the way yt-dlp's `_search_json` finds it, never
 * with `eval`. Reads of the variable (`window.<marker>.videoData`), comparisons (`==`) and
 * assignments of anything but an object are skipped. Null when there is none.
 * @param {string} html
 * @param {string} marker `__INITIAL_STATE__`, `__playinfo__`, `_riskdata_`
 * @returns {unknown | null}
 */
export function extractEmbeddedJson(html, marker) {
  if (typeof html !== "string" || typeof marker !== "string" || marker === "") return null;
  const needle = `window.${marker}`;
  let from = 0;
  while (from < html.length) {
    const at = html.indexOf(needle, from);
    if (at === -1) return null;
    from = at + needle.length;
    if (at > 0 && IDENTIFIER_CHAR_RE.test(/** @type {string} */ (html[at - 1]))) continue;
    let index = from;
    while (index < html.length && /\s/.test(/** @type {string} */ (html[index]))) index += 1;
    if (html[index] !== "=" || html[index + 1] === "=") continue;
    index += 1;
    while (index < html.length && /\s/.test(/** @type {string} */ (html[index]))) index += 1;
    if (html[index] !== "{") continue;
    const end = endOfObject(html, index);
    if (end === -1) continue;
    try {
      return JSON.parse(html.slice(index, end));
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * One DASH representation from a `dash.video[]` / `dash.audio[]` / `dash.dolby.audio[]` entry or
 * `dash.flac.audio`; null when the entry has no URL (nothing to download) or is not an object.
 * @param {unknown} entry
 * @param {"video" | "audio" | "dolby" | "flac"} kind
 * @param {Map<number, string>} siteLabels quality → the site's description (video only)
 * @returns {DashRep | null}
 */
function representationOf(entry, kind, siteLabels) {
  const record = recordOf(entry);
  if (record === null) return null;
  /** @type {string[]} */
  const urls = [];
  const candidates = [record["baseUrl"], record["base_url"], record["url"]]
    .concat(listOf(record["backupUrl"]), listOf(record["backup_url"]));
  for (const candidate of candidates) {
    const url = urlOf(candidate);
    if (url !== null && !urls.includes(url)) urls.push(url);
  }
  if (urls.length === 0) return null;
  const id = positiveIntegerOf(record["id"]) ?? 0;
  const codecs = textOf(record["codecs"]) ?? "";
  const isVideo = kind === "video";
  /** @type {string | null} */
  let label;
  if (isVideo) label = QUALITY_LABELS[id] ?? siteLabels.get(id) ?? null;
  else if (kind === "dolby") label = "Dolby";
  else if (kind === "flac") label = "FLAC";
  else label = AUDIO_LABELS[id] ?? null;
  return {
    id,
    codecs,
    codecFamily: isVideo ? codecFamily(codecs) : "unknown",
    bandwidth: Math.floor(positiveOf(record["bandwidth"]) ?? 0),
    width: isVideo ? positiveIntegerOf(record["width"]) : null,
    height: isVideo ? positiveIntegerOf(record["height"]) : null,
    frameRate: isVideo ? frameRateOf(record["frameRate"] ?? record["frame_rate"]) : null,
    urls,
    mimeType: textOf(record["mimeType"]) ?? textOf(record["mime_type"]),
    size: positiveIntegerOf(record["size"]),
    label,
  };
}

/**
 * What a playurl answer (`__playinfo__.data`; the whole `__playinfo__` object is accepted too)
 * offers this session. Junk parses to no streams. Never throws.
 * @param {unknown} data
 * @returns {PlayInfo}
 */
export function parsePlayInfo(data) {
  /** @type {PlayInfo} */
  const play = {
    videos: [],
    audios: [],
    dolby: [],
    flac: null,
    supportFormats: [],
    acceptQuality: [],
    acceptDescription: [],
    timelengthS: null,
    trialOnly: false,
    legacy: false,
  };
  let record = recordOf(data);
  if (record === null) return play;
  if (recordOf(record["dash"]) === null && !Array.isArray(record["durl"])) {
    const inner = recordOf(record["data"]);
    if (inner !== null) record = inner;
  }
  /** @type {Map<number, string>} */
  const siteLabels = new Map();
  for (const entry of listOf(record["support_formats"])) {
    const format = recordOf(entry);
    const quality = format === null ? null : positiveIntegerOf(format["quality"]);
    if (format === null || quality === null) continue;
    const siteLabel = textOf(format["new_description"]) ?? textOf(format["display_desc"]);
    if (siteLabel !== null) siteLabels.set(quality, siteLabel);
    play.supportFormats.push({
      quality,
      label: siteLabel ?? QUALITY_LABELS[quality] ?? String(quality),
      codecs: listOf(format["codecs"]).filter((codec) => typeof codec === "string"),
    });
  }
  const dash = recordOf(record["dash"]);
  if (dash !== null) {
    for (const entry of listOf(dash["video"])) {
      const rep = representationOf(entry, "video", siteLabels);
      if (rep !== null) play.videos.push(rep);
    }
    for (const entry of listOf(dash["audio"])) {
      const rep = representationOf(entry, "audio", siteLabels);
      if (rep !== null) play.audios.push(rep);
    }
    const dolby = recordOf(dash["dolby"]);
    for (const entry of dolby === null ? [] : listOf(dolby["audio"])) {
      const rep = representationOf(entry, "dolby", siteLabels);
      if (rep !== null) play.dolby.push(rep);
    }
    const flac = recordOf(dash["flac"]);
    play.flac = flac === null ? null : representationOf(flac["audio"], "flac", siteLabels);
  } else {
    play.legacy = listOf(record["durl"]).length > 0;
  }
  play.acceptQuality = listOf(record["accept_quality"])
    .map((quality) => positiveIntegerOf(quality))
    .filter((quality) => quality !== null);
  play.acceptDescription = listOf(record["accept_description"]).filter(
    (description) => typeof description === "string",
  );
  play.trialOnly = play.acceptDescription.some((description) => description.includes(TRIAL_MARKER));
  const timelength = positiveOf(record["timelength"]);
  play.timelengthS = timelength === null ? null : timelength / 1000;
  return play;
}

/**
 * The nominal height of a video representation: the one its quality id stands for (a portrait
 * 1080P is 1080 wide and 1920 tall), else the shorter side of its dimensions, else its height.
 * @param {DashRep} rep
 * @returns {number | null}
 */
export function nominalHeight(rep) {
  const byId = QUALITY_HEIGHTS[rep.id];
  if (byId !== undefined) return byId;
  if (rep.width !== null && rep.height !== null) return Math.min(rep.width, rep.height);
  return rep.height;
}

/**
 * The representations ordered best first: bandwidth, then quality id, then the served order.
 * @param {{ rep: DashRep, index: number }[]} entries
 * @returns {{ rep: DashRep, index: number }[]}
 */
function bestFirst(entries) {
  return [...entries].sort(
    (a, b) => b.rep.bandwidth - a.rep.bandwidth || b.rep.id - a.rep.id || a.index - b.index,
  );
}

/**
 * The audio track to download: `compatible` takes the highest-bandwidth AAC (every browser plays
 * it; FLAC, then Dolby, only when there is no AAC at all); `best` takes FLAC, then Dolby, then
 * AAC. Null when the page offers no audio.
 * @param {PlayInfo} play
 * @param {"compatible" | "best"} codec
 * @returns {DashRep | null}
 */
export function chooseAudio(play, codec) {
  const aacFirst = play.audios.filter((rep) => rep.codecs.toLowerCase().startsWith("mp4a"));
  const aacPool = (aacFirst.length > 0 ? aacFirst : play.audios).map((rep, index) => ({
    rep,
    index,
  }));
  const aac = bestFirst(aacPool)[0]?.rep ?? null;
  const dolby = bestFirst(play.dolby.map((rep, index) => ({ rep, index })))[0]?.rep ?? null;
  if (codec === "best") return play.flac ?? dolby ?? aac;
  return aac ?? play.flac ?? dolby;
}

/**
 * The streams to download: the video at the best nominal height not above `maxHeight` (no cap
 * when null; when every quality is taller than the cap, the lowest one), `compatible` preferring
 * `avc`, then `hevc`, then `av1` at that height and `best` taking the highest bandwidth there
 * (ties: the higher quality id, then the served order); the audio per {@link chooseAudio};
 * `missingPremium` names the `support_formats` qualities this session is not served (premium
 * membership). Null when the page offers no DASH video (a legacy `durl` answer included).
 * @param {PlayInfo | null | undefined} play
 * @param {{ maxHeight: number | null, codec: "compatible" | "best" }} preferences
 * @returns {StreamSelection | null}
 */
export function chooseStreams(play, preferences) {
  if (!play || !Array.isArray(play.videos) || play.videos.length === 0) return null;
  const ranked = play.videos.map((rep, index) => ({ rep, index, height: nominalHeight(rep) }));
  const known = ranked.filter((entry) => entry.height !== null);
  let candidates = ranked;
  if (known.length > 0) {
    const heights = known.map((entry) => /** @type {number} */ (entry.height));
    const cap = preferences.maxHeight;
    const fitting = cap === null ? heights : heights.filter((height) => height <= cap);
    const target = fitting.length > 0 ? Math.max(...fitting) : Math.min(...heights);
    candidates = known.filter((entry) => entry.height === target);
  }
  if (preferences.codec === "compatible") {
    for (const family of COMPATIBLE_ORDER) {
      const some = candidates.filter((entry) => entry.rep.codecFamily === family);
      if (some.length > 0) {
        candidates = some;
        break;
      }
    }
  }
  const winner = bestFirst(candidates)[0];
  if (winner === undefined) return null;
  const served = new Set(play.videos.map((rep) => rep.id));
  const missingPremium = play.supportFormats
    .filter((format) => !served.has(format.quality))
    .map((format) => QUALITY_LABELS[format.quality] ?? format.label);
  return {
    video: winner.rep,
    audio: chooseAudio(play, preferences.codec),
    missingPremium,
    available: play.videos,
    audioAvailable: play.audios,
  };
}

/**
 * A refusal.
 * @param {BilibiliRefusalCode} code
 * @param {Record<string, string>} params
 * @returns {BilibiliPageResult}
 */
function refuse(code, params) {
  return { ok: false, code, params };
}

/**
 * The parts of a video from `videoData.pages[]`, ordered by page number; a page without a `cid`
 * is dropped (nothing to download). A video without `pages` gets one part from `videoData.cid`.
 * @param {Record<string, unknown>} videoData
 * @returns {PartRef[]}
 */
function partsOf(videoData) {
  /** @type {PartRef[]} */
  const parts = [];
  listOf(videoData["pages"]).forEach((entry, index) => {
    const page = recordOf(entry);
    if (page === null) return;
    const cid = positiveIntegerOf(page["cid"]);
    if (cid === null) return;
    parts.push({
      part: positiveIntegerOf(page["page"]) ?? index + 1,
      cid: String(cid),
      title: textOf(page["part"]) ?? "",
      durationS: positiveOf(page["duration"]),
    });
  });
  if (parts.length === 0) {
    const cid = positiveIntegerOf(videoData["cid"]);
    if (cid !== null) {
      parts.push({
        part: 1,
        cid: String(cid),
        title: "",
        durationS: positiveOf(videoData["duration"]),
      });
    }
  }
  return parts.sort((a, b) => a.part - b.part);
}

/**
 * The supporter-only message of `elecFullInfo.show_info.high_level` (`title`, `sub_title`), "" when
 * the page has none.
 * @param {Record<string, unknown>} state
 * @returns {string}
 */
function upowerMessage(state) {
  const info = recordOf(state["elecFullInfo"]);
  const show = info === null ? null : recordOf(info["show_info"]);
  const level = show === null ? null : recordOf(show["high_level"]);
  if (level === null) return "";
  return [textOf(level["title"]), textOf(level["sub_title"])]
    .filter((text) => text !== null)
    .join("，");
}

/**
 * A flag the site writes as `true` or `1`.
 * @param {unknown} value
 * @returns {boolean}
 */
function flagOf(value) {
  return value === true || positiveOf(value) !== null;
}

/**
 * The `name` of an uploader record (`upData`, `videoData.owner`), else null.
 * @param {Record<string, unknown> | null} record
 * @returns {string | null}
 */
function nameOf(record) {
  return record === null ? null : textOf(record["name"]);
}

/**
 * The `mid` of an uploader record as a string, else null.
 * @param {Record<string, unknown> | null} record
 * @returns {string | null}
 */
function midOf(record) {
  const mid = record === null ? null : positiveIntegerOf(record["mid"]);
  return mid === null ? null : String(mid);
}

/**
 * What a video page decides. Refusals, in the order they are checked: no `__INITIAL_STATE__` and
 * a `_riskdata_` with `v_voucher` → `rate_limited`; no `__INITIAL_STATE__` → `not_a_video`;
 * `error.trueCode` -403 → `login_required`, -404 → `deleted`; `videoInfo` instead of
 * `videoData` (a festival page) → `unsupported_link`; no `videoData` → `not_a_video`;
 * `rights.is_stein_gate` → `interactive`; `is_upower_exclusive` with no DASH video served →
 * `supporter_only`; an `accept_description` with `试看` → `trial_only` (the served stream is a
 * trial clip, never saved as the video); a `durl` answer without `dash` → `legacy_stream`.
 * Otherwise the video's facts, every part, the part this page embeds the streams of
 * (`options.part`, what the resolver asked for with `?p=`, else the state's `p`, else 1) and
 * the parsed `__playinfo__` (null when the page embeds none). Never throws.
 * @param {string} html
 * @param {{ part?: number | null }} [options]
 * @returns {BilibiliPageResult}
 */
export function parsePage(html, options = {}) {
  if (typeof html !== "string") return refuse("not_a_video", { reason: "the page is not text" });
  const state = recordOf(extractEmbeddedJson(html, "__INITIAL_STATE__"));
  if (state === null) {
    const risk = recordOf(extractEmbeddedJson(html, "_riskdata_"));
    if (risk !== null && textOf(risk["v_voucher"]) !== null) {
      return refuse("rate_limited", { reason: "risk control (v_voucher)" });
    }
    return refuse("not_a_video", { reason: "no __INITIAL_STATE__ in the page" });
  }
  const error = recordOf(state["error"]);
  const siteMessage = error === null ? "" : (textOf(error["message"]) ?? "");
  const trueCode = error === null ? null : numberOf(error["trueCode"]);
  if (trueCode === -403) return refuse("login_required", { site_message: siteMessage });
  if (trueCode === -404) return refuse("deleted", { site_message: siteMessage });
  const videoData = recordOf(state["videoData"]);
  if (videoData === null) {
    if (recordOf(state["videoInfo"]) !== null) {
      return refuse("unsupported_link", { kind: "festival" });
    }
    return refuse("not_a_video", { reason: "no videoData in the page", site_message: siteMessage });
  }
  const aid = positiveIntegerOf(videoData["aid"]);
  const id = canonicalId(videoData["bvid"]) ?? (aid === null ? null : `av${aid}`);
  if (id === null) return refuse("not_a_video", { reason: "no bvid in the page" });
  const rights = recordOf(videoData["rights"]);
  if (rights !== null && flagOf(rights["is_stein_gate"])) return refuse("interactive", {});
  const playinfo = recordOf(extractEmbeddedJson(html, "__playinfo__"));
  const playData = playinfo === null ? null : recordOf(playinfo["data"]);
  const play = playData === null ? null : parsePlayInfo(playData);
  const isUpowerExclusive = flagOf(videoData["is_upower_exclusive"]);
  if (isUpowerExclusive && (play === null || play.videos.length === 0)) {
    return refuse("supporter_only", { site_message: upowerMessage(state) });
  }
  if (play !== null && play.trialOnly) {
    return refuse("trial_only", { site_message: isUpowerExclusive ? upowerMessage(state) : "" });
  }
  if (play !== null && play.legacy) return refuse("legacy_stream", {});
  const pages = partsOf(videoData);
  const hinted = positiveIntegerOf(options.part);
  const stateP = positiveIntegerOf(state["p"]);
  const last = Math.max(pages.length, 1);
  let selectedPart = 1;
  if (hinted !== null && hinted <= last) selectedPart = hinted;
  else if (stateP !== null && stateP <= last) selectedPart = stateP;
  const part = pages.length > 1 ? selectedPart : null;
  const upData = recordOf(state["upData"]);
  const owner = recordOf(videoData["owner"]);
  return {
    ok: true,
    info: {
      site: "bilibili",
      id,
      part,
      pageUrl: pageUrl(id, part),
      title: typeof videoData["title"] === "string" ? videoData["title"] : "",
      uploader: nameOf(upData) ?? nameOf(owner),
      uploaderId: midOf(upData) ?? midOf(owner),
      durationS: positiveOf(videoData["duration"]),
      cover: urlOf(videoData["pic"]),
      parts: pages.length > 1 ? pages : null,
      aid,
      pages,
      selectedPart,
      isUpowerExclusive,
      description: textOf(videoData["desc"]),
    },
    play,
  };
}
