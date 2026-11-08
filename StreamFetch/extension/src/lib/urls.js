// @ts-check
/**
 * The links the user pastes: one per line, Dailymotion and Bilibili video pages and short links
 * (section 4 of the spec), canonicalised and de-duplicated; everything else refused with a reason.
 * Pure: no `chrome.*`, no DOM.
 *
 * Facts from yt-dlp 2026.10.26's extractors (`dailymotion.py`, `bilibili.py`; read 2026-11-08):
 * - Dailymotion ids are `x` + lowercase alphanumerics (`x8vu47w`) or `k…` ids
 *   (`k2Y4Mjp7krAF9iCuINM`); pages `www.dailymotion.com/video/<id>[_slug]` (also `embed/video/`,
 *   `crawler/video/`, `swf/video/`), the short link `dai.ly/<id>`, the geo player
 *   `geo.dailymotion.com/player[/xxxxx].html?video=<id>`; the site answers on any
 *   `dailymotion.<tld>` (and `touch.`), the canonical page is
 *   `https://www.dailymotion.com/video/<id>`.
 *   A `?playlist=<xid>` anywhere, a `/playlist/` page: a playlist (refused in 1.0).
 * - Bilibili ids are `BV` + 10 alphanumerics (`BV1GJ411x7h7`, the prefix in any case, the rest
 *   case-sensitive) or `av` + digits; pages `www.bilibili.com/video/<id>[/]?p=<part>` (`m.` too),
 *   the LAST `p` of the query counts (`parse_qs(url).get('p')[-1]`), parts are 1-based; the short
 *   link `b23.tv/<code>` redirects to the page (resolved by the app; a code that is itself a
 *   `BV…` / `av…` id is parsed here). Festival pages, bangumi, cheese (courses), space, lists,
 *   audio, live, the player embed without an id: refused with a reason.
 */

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

/**
 * @typedef {"dailymotion" | "bilibili"} Site
 *
 * @typedef {object} Item One video the batch names.
 * @property {string} key `dailymotion:<id>` or `bilibili:<id>:<part|all>`
 *   (`bilibili:b23:<code>:all` until resolved)
 * @property {Site} site
 * @property {"video"} kind
 * @property {string} id the Dailymotion xid; the Bilibili bvid or `av<digits>`; `b23:<code>` for
 *   an unresolved short link
 * @property {number | null} part the Bilibili `?p=N` (1-based), null for every part or for
 *   Dailymotion
 * @property {string | null} shortLink `https://b23.tv/<code>` or `https://dai.ly/<id>` when
 *   pasted so
 * @property {string} pageUrl the canonical page (`https://www.dailymotion.com/video/<id>`,
 *   `https://www.bilibili.com/video/<id>[?p=N]`); for an unresolved `b23.tv` link, the short
 *   link itself
 * @property {string} original the line as pasted (trimmed, its comment removed)
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
 * The canonical key of a video: `dailymotion:<id>`, or `bilibili:<id>:<part>` /
 * `bilibili:<id>:all`.
 * @param {Site} site
 * @param {string} id
 * @param {number | null} [part]
 * @returns {string}
 */
export function itemKey(site, id, part = null) {
  return site === "dailymotion" ? `dailymotion:${id}` : `bilibili:${id}:${part ?? "all"}`;
}

/**
 * The canonical page URL of a video: `https://www.dailymotion.com/video/<id>`,
 * `https://www.bilibili.com/video/<id>[?p=N]`; for an unresolved `b23.tv` id, the short link.
 * @param {Site} site
 * @param {string} id
 * @param {number | null} [part]
 * @returns {string}
 */
export function pageUrlOf(site, id, part = null) {
  if (site === "dailymotion") return `${DAILYMOTION_ORIGIN}/video/${id}`;
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
 * @returns {Item}
 */
function dailymotionItem(id, shortLink, original) {
  return {
    key: itemKey("dailymotion", id),
    site: "dailymotion",
    kind: "video",
    id,
    part: null,
    shortLink,
    pageUrl: pageUrlOf("dailymotion", id),
    original,
  };
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
    return dailymotionItem(id, `${DAILY_SHORT_ORIGIN}/${id}`, original);
  }
  if (url.searchParams.has("playlist") || DAILYMOTION_PLAYLIST_PATH_RE.test(path)) {
    return refuse(original, "playlist");
  }
  const video = DAILYMOTION_VIDEO_PATH_RE.exec(path);
  if (video !== null) {
    // `/video/<id>_<slug>`: the id ends at the first underscore (yt-dlp's `[^/?_&#]+`)
    const id = /** @type {string} */ (/** @type {string} */ (video[1]).split("_")[0]);
    if (!DAILYMOTION_ID_RE.test(id)) return refuse(original, "unsupported-path");
    return dailymotionItem(id, null, original);
  }
  if (DAILYMOTION_PLAYER_PATH_RE.test(path)) {
    const id = url.searchParams.get("video");
    if (id !== null && DAILYMOTION_ID_RE.test(id)) return dailymotionItem(id, null, original);
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
 * The video a tab shows — a Dailymotion or Bilibili video page URL, or in test mode one under the
 * fake sites' `bases` (mapped onto the real origins first) — or null: a refused URL, and an
 * unresolved `b23.tv` link (never a tab's final URL), is no video page. The item's `original` is
 * the URL as given.
 * @param {string} url
 * @param {{ dailymotion?: string, bilibili?: string }} [bases] test mode: the fake sites' base URLs
 * @returns {Item | null}
 */
export function videoItemFromUrl(url, bases = {}) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  let text = url;
  const mappings = /** @type {const} */ ([
    ["dailymotion", DAILYMOTION_ORIGIN],
    ["bilibili", BILIBILI_ORIGIN],
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
 * @param {{ dailymotion?: string, bilibili?: string }} [bases]
 * @returns {boolean}
 */
export function isVideoPageUrl(url, bases = {}) {
  return videoItemFromUrl(url, bases) !== null;
}
