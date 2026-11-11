// @ts-check
/**
 * The links the user pastes: one per line, Dailymotion, Bilibili.tv and Bilibili video pages and
 * short links (section 4, Addendum A.2, A.7, A.8 and B.3 of the spec), canonicalised and
 * de-duplicated; everything else refused with a reason. Pure: no `chrome.*`, no DOM.
 *
 * Facts from yt-dlp 2026.10.26's extractors (`dailymotion.py`, `bilibili.py`; read 2026-11-08):
 * - Dailymotion ids are `x` + lowercase alphanumerics (`x8vu47w`) or `k…` ids
 *   (`k2Y4Mjp7krAF9iCuINM`); pages `www.dailymotion.com/video/<id>[_slug]` (also `embed/video/`,
 *   `crawler/video/`, `swf/video/`), the short link `dai.ly/<id>`, the geo player
 *   `geo.dailymotion.com/player[/xxxxx].html?video=<id>`; the site answers on any
 *   `dailymotion.<tld>` (and `touch.`), the canonical page is
 *   `https://www.dailymotion.com/video/<id>`. A video link that also carries `?playlist=<xid>`
 *   (Dailymotion adds it when a video is opened from a playlist) is the video: the playlist is
 *   ignored and the item says so (`playlistIgnored`, A.8); a link that names a playlist and no
 *   video (`/playlist/<xid>`, the geo player with `playlist=` and no `video=`) is refused. Every
 *   other query parameter is ignored.
 * - Bilibili ids are `BV` + 10 alphanumerics (`BV1GJ411x7h7`, the prefix in any case, the rest
 *   case-sensitive) or `av` + digits; pages `www.bilibili.com/video/<id>[/]?p=<part>` (`m.` too),
 *   the LAST `p` of the query counts (`parse_qs(url).get('p')[-1]`), parts are 1-based; the short
 *   link `b23.tv/<code>` redirects to the page (resolved by the app; a code that is itself a
 *   `BV…` / `av…` id is parsed here). `?p=N` is the only meaningful parameter: every other one
 *   (`vd_source`, `spm_id_from`, `share_source`, …) and the fragment are ignored (B.3). Festival
 *   pages, bangumi, cheese (courses), space, lists, audio, live, the player embed without an id:
 *   refused with a reason.
 * - Bilibili.tv (`BiliIntlIE`, `BiliIntlSeriesIE`): `[www.]bilibili.tv` and `[www.]biliintl.com`,
 *   an optional two-letter language segment in any case, then `video/<aid>` (a user video),
 *   `play/<season_id>/<ep_id>` (an episode) or `play|media/<season_id>` (a whole series). Every id
 *   is digits and stays a STRING (an aid has 16 digits, close to 2^53 − 1); every query parameter
 *   (`bstar_from`, `spm_id_from`, …) and the fragment are ignored; the language does not change
 *   the key. Any other path is refused, and so are `bili.im` share links (not in yt-dlp's
 *   extractor: the user pastes the full link from the address bar).
 */

import { BILIBILITV_ORIGIN, pageUrl as bilibilitvPageUrl } from "./bilibilitv.js";

/**
 * How many items one batch may hold; the lines beyond are dropped (refusals are always
 * reported).
 */
export const MAX_ITEMS = 100;
/** The canonical origins. */
export const DAILYMOTION_ORIGIN = "https://www.dailymotion.com";
export const BILIBILI_ORIGIN = "https://www.bilibili.com";
export const DAILY_SHORT_ORIGIN = "https://dai.ly";
export const B23_ORIGIN = "https://b23.tv";
/** The id prefix of a `b23.tv` item whose video is unknown until the redirect is followed. */
export const B23_PREFIX = "b23:";
export { BILIBILITV_ORIGIN };

/**
 * @typedef {"dailymotion" | "bilibili" | "bilibilitv"} Site
 *
 * @typedef {"video" | "episode" | "series"} ItemKind `episode` and `series` are Bilibili.tv's
 *
 * @typedef {object} Item One video, Bilibili.tv episode or Bilibili.tv series the batch names.
 * @property {string} key `dailymotion:<id>`, `bilibili:<id>:<part|all>`
 *   (`bilibili:b23:<code>:all` until resolved), `bilibilitv:video:<aid>`,
 *   `bilibilitv:episode:<ep_id>` or `bilibilitv:series:<season_id>`
 * @property {Site} site
 * @property {ItemKind} kind `video` for Dailymotion and Bilibili
 * @property {string} id the Dailymotion xid; the Bilibili bvid or `av<digits>`; `b23:<code>` for
 *   an unresolved short link; the Bilibili.tv aid, ep_id or season_id (digits, as text)
 * @property {number | null} part the Bilibili `?p=N` (1-based), null for every part and for the
 *   other sites
 * @property {string | null} shortLink `https://b23.tv/<code>` or `https://dai.ly/<id>` when
 *   pasted so
 * @property {string} pageUrl the canonical page (`https://www.dailymotion.com/video/<id>`,
 *   `https://www.bilibili.com/video/<id>[?p=N]`, `https://www.bilibili.tv/en/video/<aid>`,
 *   `…/en/play/<season>/<ep>`, `…/en/play/<season>`); for an unresolved `b23.tv` link, the
 *   short link itself
 * @property {string} original the line as pasted (trimmed, its comment removed)
 * @property {string | null} [seasonId] Bilibili.tv only: an episode's season, a series' own id,
 *   null for a user video
 * @property {true} [playlistIgnored] Dailymotion only, present when the video link also named a
 *   playlist (`?playlist=`): the playlist is ignored and the row says so
 *
 * @typedef {"playlist" | "bangumi" | "space" | "list" | "audio" | "live" | "other-site" |
 *   "unsupported-path" | "junk"} RefusalReason
 *
 * @typedef {object} Refused A line that names no single video.
 * @property {string} original
 * @property {RefusalReason} reason
 *
 * @typedef {object} ParsedInput What {@link parseInput} makes of the text box.
 * @property {Item[]} items in order, at most {@link MAX_ITEMS}, duplicates dropped (the first kept)
 * @property {Refused[]} refused in order, every refused line
 * @property {string[]} dropped the lines dropped as duplicates or beyond the cap, in order
 */

/** Every refusal reason, for the UI's texts (`messages.refusalText`) and the tests. */
export const REFUSAL_REASONS = Object.freeze(
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
  ]),
);

const LINE_BREAK_RE = /\r\n|\r|\n/;
/** The inline comment rule: whitespace, then `#` (a `#fragment` glued to a link is part of it). */
const INLINE_COMMENT_RE = /\s#/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** A line that starts like a host name (`www.dailymotion.com/…`, `dai.ly/…`): no scheme. */
const HOST_START_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|$)/i;

const DAILYMOTION_HOST_RE = /^(?:(?:www|touch|geo)\.)?dailymotion\.[a-z]{2,3}$/;
const DAILYMOTION_ID_RE = /^(?:x[a-z0-9]+|k[A-Za-z0-9]+)$/;
const DAILYMOTION_VIDEO_PATH_RE = /^\/(?:(?:embed|swf|crawler)\/)?video\/([^/]+)\/?$/i;
const DAILYMOTION_PLAYER_PATH_RE = /^\/player(?:\/[a-z0-9]+)?\.html$/i;
const DAILYMOTION_PLAYLIST_PATH_RE = /^\/playlist(?:\/|$)/i;
const DAILYMOTION_SEARCH_PATH_RE = /^\/search(?:\/|$)/i;
const SHORT_ID_PATH_RE = /^\/([^/]+)\/?$/;

const BILIBILI_HOST_RE = /^(?:www\.|m\.)?bilibili\.com$/;
const BV_ID_RE = /^[Bb][Vv]([A-Za-z0-9]{10})$/;
const AV_ID_RE = /^[Aa][Vv]([0-9]+)$/;
const BILIBILI_VIDEO_PATH_RE = /^\/video\/([^/]+)\/?$/i;
const BILIBILI_BANGUMI_PATH_RE = /^\/(?:bangumi|anime)(?:\/|$)/i;
const BILIBILI_LIST_PATH_RE = /^\/(?:list|medialist|watchlater)(?:\/|$)/i;
const BILIBILI_AUDIO_PATH_RE = /^\/audio(?:\/|$)/i;
const B23_CODE_PATH_RE = /^\/([A-Za-z0-9]+)\/?$/;

const BILIBILITV_HOST_RE = /^(?:www\.)?(?:bilibili\.tv|biliintl\.com)$/;
const BILIBILITV_VIDEO_PATH_RE = /^(?:\/[a-z]{2})?\/video\/([0-9]+)\/?$/i;
const BILIBILITV_EPISODE_PATH_RE = /^(?:\/[a-z]{2})?\/play\/([0-9]+)\/([0-9]+)\/?$/i;
const BILIBILITV_SERIES_PATH_RE = /^(?:\/[a-z]{2})?\/(?:play|media)\/([0-9]+)\/?$/i;

/**
 * @param {string} original
 * @param {RefusalReason} reason
 * @returns {Refused}
 */
function refuse(original, reason) {
  return { original, reason };
}

/**
 * Whether a parsed line was refused (the other case is an {@link Item}).
 * @param {Item | Refused} parsed
 * @returns {parsed is Refused}
 */
export function isRefused(parsed) {
  return "reason" in parsed;
}

/**
 * The canonical key of an item: `dailymotion:<id>`, `bilibili:<id>:<part>` / `bilibili:<id>:all`,
 * or `bilibilitv:<kind>:<id>` (the language of the link is not part of it).
 * @param {Site} site
 * @param {string} id
 * @param {number | null} [part] Bilibili only
 * @param {ItemKind} [kind] Bilibili.tv only (`video` by default)
 * @returns {string}
 */
export function itemKey(site, id, part = null, kind = "video") {
  if (site === "dailymotion") return `dailymotion:${id}`;
  if (site === "bilibilitv") return `bilibilitv:${kind}:${id}`;
  return `bilibili:${id}:${part ?? "all"}`;
}

/**
 * The canonical page URL of a video: `https://www.dailymotion.com/video/<id>`,
 * `https://www.bilibili.com/video/<id>[?p=N]`, `https://www.bilibili.tv/en/video/<aid>` (an
 * episode's or a series' page: `lib/bilibilitv.pageUrl`); for an unresolved `b23.tv` id, the
 * short link.
 * @param {Site} site
 * @param {string} id
 * @param {number | null} [part]
 * @returns {string}
 */
export function pageUrlOf(site, id, part = null) {
  if (site === "dailymotion") return `${DAILYMOTION_ORIGIN}/video/${id}`;
  if (site === "bilibilitv") return bilibilitvPageUrl({ kind: "video", id });
  if (id.startsWith(B23_PREFIX)) return `${B23_ORIGIN}/${id.slice(B23_PREFIX.length)}`;
  return `${BILIBILI_ORIGIN}/video/${id}${part !== null ? `?p=${part}` : ""}`;
}

/**
 * `BV…` (prefix upper-cased, the ten characters as given) or `av<digits>` (lower-case, leading
 * zeros dropped) for a text that is a Bilibili video id; null otherwise.
 * @param {string} text
 * @returns {string | null}
 */
export function canonicalBilibiliId(text) {
  const bv = BV_ID_RE.exec(text);
  if (bv !== null) return `BV${bv[1]}`;
  const av = AV_ID_RE.exec(text);
  if (av !== null) return `av${/** @type {string} */ (av[1]).replace(/^0+(?=[0-9])/, "")}`;
  return null;
}

/**
 * The `?p=N` of a Bilibili URL: the LAST `p` (as yt-dlp reads it), a whole number from 1; null
 * when absent or not such a number (the site then shows the first part: every part is taken).
 * @param {URL} url
 * @returns {number | null}
 */
function partOf(url) {
  const values = url.searchParams.getAll("p");
  const last = values.length > 0 ? values[values.length - 1] : undefined;
  if (last === undefined || !/^[0-9]+$/.test(last)) return null;
  const part = Number(last);
  return part >= 1 && Number.isSafeInteger(part) ? part : null;
}

/**
 * @param {string} id
 * @param {string | null} shortLink
 * @param {string} original
 * @param {URL} url the link: a `playlist` parameter marks the item `playlistIgnored`
 * @returns {Item}
 */
function dailymotionItem(id, shortLink, original, url) {
  /** @type {Item} */
  const item = {
    key: itemKey("dailymotion", id),
    site: "dailymotion",
    kind: "video",
    id,
    part: null,
    shortLink,
    pageUrl: pageUrlOf("dailymotion", id),
    original,
  };
  if (url.searchParams.has("playlist")) item.playlistIgnored = true;
  return item;
}

/**
 * @param {string} id
 * @param {number | null} part
 * @param {string | null} shortLink
 * @param {string} original
 * @returns {Item}
 */
function bilibiliItem(id, part, shortLink, original) {
  return {
    key: itemKey("bilibili", id, part),
    site: "bilibili",
    kind: "video",
    id,
    part,
    shortLink,
    pageUrl: pageUrlOf("bilibili", id, part),
    original,
  };
}

/**
 * @param {URL} url
 * @param {string} host
 * @param {string} original
 * @returns {Item | Refused}
 */
function parseDailymotion(url, host, original) {
  const path = url.pathname;
  if (host === "dai.ly") {
    const short = SHORT_ID_PATH_RE.exec(path);
    const id = short !== null ? /** @type {string} */ (short[1]) : null;
    if (id === null || !DAILYMOTION_ID_RE.test(id)) return refuse(original, "unsupported-path");
    return dailymotionItem(id, `${DAILY_SHORT_ORIGIN}/${id}`, original, url);
  }
  if (DAILYMOTION_PLAYLIST_PATH_RE.test(path)) return refuse(original, "playlist");
  const video = DAILYMOTION_VIDEO_PATH_RE.exec(path);
  if (video !== null) {
    // `/video/<id>_<slug>`: the id ends at the first underscore (yt-dlp's `[^/?_&#]+`)
    const id = /** @type {string} */ (/** @type {string} */ (video[1]).split("_")[0]);
    if (!DAILYMOTION_ID_RE.test(id)) return refuse(original, "unsupported-path");
    return dailymotionItem(id, null, original, url);
  }
  if (DAILYMOTION_PLAYER_PATH_RE.test(path)) {
    const id = url.searchParams.get("video");
    if (id !== null && DAILYMOTION_ID_RE.test(id)) return dailymotionItem(id, null, original, url);
    if (id === null && url.searchParams.has("playlist")) return refuse(original, "playlist");
    return refuse(original, "unsupported-path");
  }
  if (DAILYMOTION_SEARCH_PATH_RE.test(path)) return refuse(original, "list");
  return refuse(original, "unsupported-path");
}

/**
 * @param {URL} url
 * @param {string} original
 * @returns {Item | Refused}
 */
function parseB23(url, original) {
  const match = B23_CODE_PATH_RE.exec(url.pathname);
  if (match === null) return refuse(original, "unsupported-path");
  const code = /** @type {string} */ (match[1]);
  const shortLink = `${B23_ORIGIN}/${code}`;
  const id = canonicalBilibiliId(code);
  if (id !== null) return bilibiliItem(id, partOf(url), shortLink, original);
  return bilibiliItem(`${B23_PREFIX}${code}`, null, shortLink, original);
}

/**
 * @param {URL} url
 * @param {string} host
 * @param {string} original
 * @returns {Item | Refused}
 */
function parseBilibili(url, host, original) {
  const path = url.pathname;
  if (host === "live.bilibili.com") return refuse(original, "live");
  if (host === "search.bilibili.com") return refuse(original, "list");
  if (host === "space.bilibili.com") {
    if (/\/favlist(?:\/|$)/i.test(path) || url.searchParams.has("fid")) {
      return refuse(original, "list");
    }
    if (/\/audio(?:\/|$)/i.test(path)) return refuse(original, "audio");
    return refuse(original, "space");
  }
  if (host === "player.bilibili.com") {
    if (/^\/player\.html$/i.test(path)) {
      const bvid = url.searchParams.get("bvid");
      const aid = url.searchParams.get("aid");
      const id =
        bvid !== null
          ? canonicalBilibiliId(bvid)
          : aid !== null && /^[0-9]+$/.test(aid)
            ? canonicalBilibiliId(`av${aid}`)
            : null;
      if (id !== null) return bilibiliItem(id, partOf(url), null, original);
    }
    return refuse(original, "unsupported-path");
  }
  if (!BILIBILI_HOST_RE.test(host)) return refuse(original, "unsupported-path");
  if (BILIBILI_BANGUMI_PATH_RE.test(path)) return refuse(original, "bangumi");
  if (BILIBILI_LIST_PATH_RE.test(path)) return refuse(original, "list");
  if (BILIBILI_AUDIO_PATH_RE.test(path)) return refuse(original, "audio");
  const video = BILIBILI_VIDEO_PATH_RE.exec(path);
  if (video !== null) {
    const id = canonicalBilibiliId(/** @type {string} */ (video[1]));
    if (id === null) return refuse(original, "unsupported-path");
    return bilibiliItem(id, partOf(url), null, original);
  }
  // festival pages, cheese (courses), dynamic posts, articles, blackboard, the home page, …
  return refuse(original, "unsupported-path");
}

/**
 * A Bilibili.tv item: its key, canonical page and season.
 * @param {ItemKind} kind
 * @param {string} id the aid, ep_id or season_id (digits, as text)
 * @param {string | null} seasonId
 * @param {string} original
 * @returns {Item}
 */
function bilibilitvItem(kind, id, seasonId, original) {
  return {
    key: itemKey("bilibilitv", id, null, kind),
    site: "bilibilitv",
    kind,
    id,
    part: null,
    shortLink: null,
    pageUrl: bilibilitvPageUrl({ kind, id, seasonId }),
    original,
    seasonId,
  };
}

/**
 * A `bilibili.tv` / `biliintl.com` link: a user video, an episode or a whole series (the
 * language segment, the query and the fragment ignored); any other path, or another host of the
 * site, is `unsupported-path`.
 * @param {URL} url
 * @param {string} host
 * @param {string} original
 * @returns {Item | Refused}
 */
function parseBilibilitv(url, host, original) {
  if (!BILIBILITV_HOST_RE.test(host)) return refuse(original, "unsupported-path");
  const path = url.pathname;
  const video = BILIBILITV_VIDEO_PATH_RE.exec(path);
  if (video !== null) return bilibilitvItem("video", String(video[1]), null, original);
  const episode = BILIBILITV_EPISODE_PATH_RE.exec(path);
  if (episode !== null) {
    const season = String(episode[1]);
    return bilibilitvItem("episode", String(episode[2]), season, original);
  }
  const series = BILIBILITV_SERIES_PATH_RE.exec(path);
  if (series !== null) {
    const season = String(series[1]);
    return bilibilitvItem("series", season, season, original);
  }
  return refuse(original, "unsupported-path");
}

/**
 * One line of the text box (or one tab URL): the video it names, or why it is refused. Accepts
 * `http` and `https`, a link without its scheme (`www.bilibili.com/video/…`), a link wrapped in
 * `<…>`; everything that is not a link is `junk`, a link to another site `other-site`.
 * @param {string} text
 * @returns {Item | Refused}
 */
export function parseLine(text) {
  const original = text.trim();
  let candidate = original.replace(/^<+|>+$/g, "").trim();
  if (!candidate) return refuse(original, "junk");
  if (!SCHEME_RE.test(candidate)) {
    if (!HOST_START_RE.test(candidate)) return refuse(original, "junk");
    candidate = `https://${candidate}`;
  }
  /** @type {URL} */
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return refuse(original, "junk");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return refuse(original, "junk");
  const host = url.hostname.toLowerCase();
  if (host === "dai.ly" || DAILYMOTION_HOST_RE.test(host)) {
    return parseDailymotion(url, host, original);
  }
  if (host === "b23.tv") return parseB23(url, original);
  if (host === "bilibili.com" || host.endsWith(".bilibili.com")) {
    return parseBilibili(url, host, original);
  }
  const site = host.replace(/^.*\.(?=[^.]+\.[^.]+$)/, "");
  if (site === "bilibili.tv" || site === "biliintl.com") {
    return parseBilibilitv(url, host, original);
  }
  // a Bilibili.tv share link: not in yt-dlp's extractor, the full link is needed (A.7)
  if (host === "bili.im" || host.endsWith(".bili.im")) return refuse(original, "unsupported-path");
  return refuse(original, "other-site");
}

/**
 * The content of one raw line of the text box, or null when it names nothing: trimmed, a `#` line
 * or a blank line is nothing, text after whitespace + `#` is a comment.
 * @param {string} raw
 * @returns {string | null}
 */
function lineContent(raw) {
  let line = raw.trim();
  if (!line || line.startsWith("#")) return null;
  const comment = INLINE_COMMENT_RE.exec(line);
  if (comment !== null) line = line.slice(0, comment.index).trim();
  return line || null;
}

/**
 * What the batch text box names: one link per line (`#` lines, blank lines and text after
 * whitespace + `#` ignored; a byte-order mark tolerated), every line parsed ({@link parseLine});
 * duplicates dropped by canonical key (the first kept) and, past {@link MAX_ITEMS} items, every
 * further item dropped — the dropped lines are listed; refused lines are always listed.
 * @param {string} text
 * @returns {ParsedInput}
 */
export function parseInput(text) {
  /** @type {Item[]} */
  const items = [];
  /** @type {Refused[]} */
  const refused = [];
  /** @type {string[]} */
  const dropped = [];
  /** @type {Set<string>} */
  const keys = new Set();
  const body = text.startsWith("\ufeff") ? text.slice(1) : text;
  for (const raw of body.split(LINE_BREAK_RE)) {
    const line = lineContent(raw);
    if (line === null) continue;
    const parsed = parseLine(line);
    if (isRefused(parsed)) {
      refused.push(parsed);
    } else if (keys.has(parsed.key) || items.length >= MAX_ITEMS) {
      dropped.push(line);
    } else {
      keys.add(parsed.key);
      items.push(parsed);
    }
  }
  return { items, refused, dropped };
}

/**
 * @typedef {{ dailymotion?: string, bilibili?: string, bilibilitv?: string }} PageBases test
 *   mode: the fake sites' base URLs of the pages
 */

/**
 * The video a tab shows — a Dailymotion, Bilibili.tv or Bilibili video page URL (a Bilibili.tv
 * episode or series page too), or in test mode one under the fake sites' `bases` (mapped onto the
 * real origins first) — or null: a refused URL, and an unresolved `b23.tv` link (never a tab's
 * final URL), is no video page. The item's `original` is the URL as given.
 * @param {string} url
 * @param {PageBases} [bases]
 * @returns {Item | null}
 */
export function videoItemFromUrl(url, bases = {}) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  let text = url;
  const mappings = /** @type {const} */ ([
    ["dailymotion", DAILYMOTION_ORIGIN],
    ["bilibili", BILIBILI_ORIGIN],
    ["bilibilitv", BILIBILITV_ORIGIN],
  ]);
  for (const [site, origin] of mappings) {
    const base = bases[site];
    if (!base) continue;
    const root = base.replace(/\/+$/, "");
    if (text === root || text.startsWith(`${root}/`) || text.startsWith(`${root}?`)) {
      text = origin + text.slice(root.length);
      break;
    }
  }
  const parsed = parseLine(text);
  if (isRefused(parsed) || parsed.id.startsWith(B23_PREFIX)) return null;
  return { ...parsed, original: url };
}

/**
 * Whether a tab's URL is a supported video page (the popup's "Download this video").
 * @param {string} url
 * @param {PageBases} [bases]
 * @returns {boolean}
 */
export function isVideoPageUrl(url, bases = {}) {
  return videoItemFromUrl(url, bases) !== null;
}
