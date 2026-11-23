// @ts-check
/**
 * The user's TikTok favorites list — the **Drama** sub-tab of **Favorites** on their own profile —
 * as DramaFetch for Chrome reads it. Pure: no `chrome.*`, no DOM (`src/app/favorites.js` fetches the
 * pages from inside the user's TikTok tab, `src/app/app.js` shows the library). An extension-only
 * feature: the Python tool has no favorites list, and nothing here decides anything about a
 * download — a favorite becomes a series id the DramaFetch tab hands to its engine, which downloads
 * it exactly like a pasted link.
 *
 * Facts from the owner's captures (Chrome DevTools, 2026-11-15; the sandbox cannot reach TikTok):
 * - the list is on the user's profile, `https://www.tiktok.com/@<uniqueId>` → **Favorites** →
 *   **Drama <total>**; the profile URL has no tab parameter;
 * - each entry is a `<button type="button" aria-label="<dramaName>" class="…ButtonFavoriteDramaCard
 *   …">` (no `href`, no data attribute with the id) holding the cover, the title
 *   (`…PFavoriteDramaTitle…`) and "N Episodes | 1h 19m"; the hashed parts of the class names change
 *   between TikTok's deploys, the readable emotion labels stay;
 * - the page loads the list with one request per page whose path ends with `/drama_list/` (the
 *   owner's DevTools filter `favorite` matched it, so its address holds `favorite`; the full path
 *   was not captured) and whose query carries TikTok's signature parameters; the list's first page
 *   is the request with `cursor=0` ({@link isFavoritesFirstPageUrl}); 19 items per page in the
 *   capture, newest favorite first, the grid in that order;
 * - its JSON: `{cursor: "<the next page's cursor>", dramaList: [item…], hasMore, statusCode: 0,
 *   status_code: 0, status_msg: "", total: "<count as a string>", …}`; an item: `{dramaID: "<19
 *   digits>", dramaName, numVideos: <int>, totalDuration: "<seconds as a string>", author, cover,
 *   zoomCover, themes, …}` — `dramaID` is DramaFetch's series id (`lib/urls.js`), `totalDuration`
 *   is seconds (4743 → the card's "1h 19m"), `zoomCover` maps sizes (`"240"`, `"480"`, …) to
 *   signed https URLs of the drama's cover (`.avif` in the capture) and `cover.urlList` holds more
 *   of them ({@link coverUrlOf}: the library's thumbnail — a signed URL, kept in the page's memory
 *   and `chrome.storage.session` only, never in `chrome.storage.local`, a log or a report). Two
 *   different dramas may share a title and a cover: the library shows both, each with its own
 *   series id.
 */

import { isDict } from "./catalog.js";
import { DONE, SKIPPED_EXISTS, SKIPPED_LOCKED, TIKTOK_BASE_URL, pyStrip } from "./messages.js";
import { completeSince, doneEntries, lockedNumbers, readState } from "./state.js";

/** The records' statuses of an episode on disk or locked: under a complete mark, only these raise a drama's episode count ({@link knownEpisodes}). */
const ACCOUNTED_STATUSES = new Set([DONE, SKIPPED_EXISTS, SKIPPED_LOCKED]);

/** At most this many pages of the favorites list are read per listing (19 items a page: 1 900). */
export const FAVORITES_MAX_PAGES = 100;
/** The path of the page's favorites request ends with this segment (`…/favorite/…/drama_list/`). */
export const DRAMA_LIST_MARKER = "/drama_list";
/**
 * The address of the favorites list's request holds this word, letter case aside (the owner's
 * DevTools filter `favorite` matched the page's request): a `drama_list` request without it is
 * another list, never the favorites.
 */
export const FAVORITES_URL_WORD = "favorite";
/** What a payload that holds no favorites list is called (an error's message). */
export const NOT_A_LIST_MESSAGE = "not a favorites list";

const ID_RE = /^[0-9]{15,22}$/;
const COUNT_RE = /^[0-9]{1,15}$/;
const SECONDS_RE = /^[0-9]{1,12}(?:\.[0-9]+)?$/;
const DRAMA_LIST_PATH_RE = /\/drama_list\/?$/;
/** Every run of whitespace, line break or control character: a title on one line, collapsed. */
const BLANKS_RE = /[\s\p{Cc}\p{Zl}\p{Zp}\p{Zs}]+/gu;
const PROFILE_RE = /^https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[^/?#\s]/i;

/**
 * @typedef {object} FavoriteItem One drama of the list, as DramaFetch uses it.
 * @property {string} seriesId `dramaID`: ASCII digits, 15–22 of them
 * @property {string | null} title `dramaName` on one line, null when missing
 * @property {number | null} episodes `numVideos`, null when missing
 * @property {number | null} durationS `totalDuration` in seconds, null when missing
 * @property {string | null} coverUrl the drama's cover ({@link coverUrlOf}): a signed URL, null
 *   when the item has none — never stored on disk
 *
 * @typedef {object} FavoritesPage One page of the list ({@link parseDramaListPayload}).
 * @property {FavoriteItem[]} items in the page's order
 * @property {string | null} cursor the next page's cursor, null when the page names none
 * @property {boolean} hasMore
 * @property {number | null} total how many favorites TikTok counts, null when missing
 * @property {number} skipped the page's items without a valid `dramaID` (left out)
 *
 * @typedef {object} FavoritesHandover What the DramaFetch tab is handed: list the favorites of a
 *   TikTok tab — the popup's **Open my library** on a profile (1.5.0's **Choose from your
 *   favorites**) —, and **Update from TikTok** the same way.
 * @property {number} tabId the user's TikTok tab that showed the list
 */

/** TikTok's own error in a favorites answer (`statusCode` / `status_code` not 0), or no list at all. */
export class FavoritesPayloadError extends Error {
  /**
   * @param {string} message TikTok's `status_msg` (or {@link NOT_A_LIST_MESSAGE}, or the code)
   * @param {number | null} [code] TikTok's status code, null when the answer was no list
   */
  constructor(message, code = null) {
    super(message);
    this.name = "FavoritesPayloadError";
    this.code = code;
  }
}

/**
 * `text` on one line: NFC, every run of whitespace, line breaks and control characters one space,
 * trimmed — how a title is compared and shown.
 * @param {string} text
 * @returns {string}
 */
export function cleanTitle(text) {
  return text.normalize("NFC").replace(BLANKS_RE, " ").trim();
}

/**
 * Whether `url` is a request of a `drama_list`: its path (not its query) ends with `/drama_list/`
 * (or `/drama_list`), as the page's own favorites request does.
 * @param {string} url
 * @returns {boolean}
 */
export function isDramaListUrl(url) {
  if (typeof url !== "string") return false;
  const path = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/, "").replace(/[?#].*$/s, "");
  return DRAMA_LIST_PATH_RE.test(path);
}

/**
 * Every value of the query parameter `name` in `url`, in order, percent-decoded (a `+` read as a
 * space, as a server reads a query; a malformed escape kept as it is): the parameter's key is
 * compared decoded too. The fragment is no query.
 * @param {string} url
 * @param {string} name
 * @returns {string[]}
 */
function queryValues(url, name) {
  /** @param {string} text @returns {string} */
  const decoded = (text) => {
    try {
      return decodeURIComponent(text.replace(/\+/g, " "));
    } catch {
      return text;
    }
  };
  const head = url.replace(/#.*$/s, "");
  const question = head.indexOf("?");
  if (question < 0) return [];
  /** @type {string[]} */
  const values = [];
  for (const field of head.slice(question + 1).split("&")) {
    if (field === "") continue;
    const eq = field.indexOf("=");
    if (decoded(eq >= 0 ? field.slice(0, eq) : field) !== name) continue;
    values.push(decoded(eq >= 0 ? field.slice(eq + 1) : ""));
  }
  return values;
}

/**
 * Whether `url` is the FIRST page of the user's favorites list as the profile page asks for it —
 * the only request the background worker keeps as the list's address: its path ends with
 * `/drama_list/` (or `/drama_list`: {@link isDramaListUrl}), the address holds
 * {@link FAVORITES_URL_WORD} (letter case aside, anywhere in it: the owner's DevTools filter
 * matched the page's request by it), and its `cursor` is absent, empty or `0` (every `cursor`
 * parameter, read percent-decoded). A later page — the page's own as the grid scrolls, or one
 * DramaFetch asked for — is never the address: TikTok signs the whole query, so the first page is
 * replayed as the page asked for it, and only the later pages carry another `cursor`.
 * @param {string} url
 * @returns {boolean}
 */
export function isFavoritesFirstPageUrl(url) {
  if (typeof url !== "string" || !isDramaListUrl(url)) return false;
  if (!url.toLowerCase().includes(FAVORITES_URL_WORD)) return false;
  return queryValues(url, "cursor").every((value) => value === "" || value === "0");
}

/**
 * Whether `url` is a TikTok profile page (`https://www.tiktok.com/@<user>…`, also `m.` and the bare
 * host; in test mode a page `/@…` of `base`): where the favorites list lives.
 * @param {string} url
 * @param {string} [base] TikTok's address (in test mode, the fake TikTok's)
 * @returns {boolean}
 */
export function isProfilePageUrl(url, base = TIKTOK_BASE_URL) {
  if (typeof url !== "string") return false;
  const root = base.replace(/\/+$/, "");
  if (root !== TIKTOK_BASE_URL && url.startsWith(`${root}/@`) && /^[^/?#\s]/.test(url.slice(root.length + 2))) return true;
  return PROFILE_RE.test(url);
}

/**
 * A count the payload gives as a number or as a string of ASCII digits; null otherwise.
 * @param {unknown} value
 * @returns {number | null}
 */
function asCount(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === "string" && COUNT_RE.test(pyStrip(value))) return Number(pyStrip(value));
  return null;
}

/**
 * Seconds the payload gives as a number or as a string (`"4743"`); null otherwise.
 * @param {unknown} value
 * @returns {number | null}
 */
function asSeconds(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === "string" && SECONDS_RE.test(pyStrip(value))) return Number(pyStrip(value));
  return null;
}

/**
 * A status code as a number (`0`, `"0"`, `10201`), null when absent; NaN for anything else.
 * @param {unknown} value
 * @returns {number | null}
 */
function asStatus(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?[0-9]{1,12}$/.test(pyStrip(value))) return Number(pyStrip(value));
  return Number.NaN;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function asFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return ["true", "1"].includes(pyStrip(value).toLowerCase());
  return false;
}

/**
 * The next page's cursor: a non-empty string, or a whole number read exactly; null otherwise.
 * @param {unknown} value
 * @returns {string | null}
 */
function asCursor(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value === "string" && pyStrip(value)) return pyStrip(value);
  return null;
}

/**
 * Whether `value` is an http(s) URL as a string: a cover address of the list, else nothing.
 * @param {unknown} value
 * @returns {value is string}
 */
function isWebUrl(value) {
  return typeof value === "string" && /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(value) && value.length <= 4096;
}

/**
 * The cover of one item of `dramaList`: its `zoomCover["240"]` when that is an http(s) URL, else
 * the first http(s) URL of `cover.urlList`, else null — never anything else of the item (the
 * author's avatars, the list's other fields). A signed URL: the page keeps it in its memory and
 * `chrome.storage.session` only.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function coverUrlOf(raw) {
  if (!isDict(raw)) return null;
  const zoom = Object.hasOwn(raw, "zoomCover") ? raw["zoomCover"] : undefined;
  if (isDict(zoom) && Object.hasOwn(zoom, "240") && isWebUrl(zoom["240"])) return zoom["240"];
  const cover = Object.hasOwn(raw, "cover") ? raw["cover"] : undefined;
  const list = isDict(cover) && Object.hasOwn(cover, "urlList") ? cover["urlList"] : undefined;
  if (!Array.isArray(list)) return null;
  const found = list.find(isWebUrl);
  return found === undefined ? null : found;
}

/**
 * One item of `dramaList`, or null without a valid `dramaID` (ASCII digits, 15–22 of them, as the
 * box reads a series id; a JSON number is never one — 19 digits are past JavaScript's exact
 * integers).
 * @param {unknown} raw
 * @returns {FavoriteItem | null}
 */
function itemOf(raw) {
  if (!isDict(raw)) return null;
  const id = Object.hasOwn(raw, "dramaID") ? raw["dramaID"] : undefined;
  if (typeof id !== "string" || !ID_RE.test(pyStrip(id))) return null;
  const name = Object.hasOwn(raw, "dramaName") ? raw["dramaName"] : undefined;
  const title = typeof name === "string" && cleanTitle(name) ? cleanTitle(name) : null;
  return {
    seriesId: pyStrip(id),
    title,
    episodes: asCount(Object.hasOwn(raw, "numVideos") ? raw["numVideos"] : undefined),
    durationS: asSeconds(Object.hasOwn(raw, "totalDuration") ? raw["totalDuration"] : undefined),
    coverUrl: coverUrlOf(raw),
  };
}

/**
 * One page of the favorites list, as TikTok answers the page's `drama_list` request: its dramas in
 * the page's order (an item without a valid `dramaID` is left out and counted in `skipped`), the
 * next page's cursor, whether more pages follow and how many favorites TikTok counts. Numbers given
 * as strings are read; a missing field gives null, never an error. Throws
 * {@link FavoritesPayloadError} when TikTok answered with its own error (`statusCode` or
 * `status_code` other than 0: the error carries `status_msg`) or the answer holds no list at all
 * (no `dramaList` array — an empty page may leave it out, but then it has the list's own `hasMore`).
 * @param {unknown} payload
 * @returns {FavoritesPage}
 */
export function parseDramaListPayload(payload) {
  if (!isDict(payload)) throw new FavoritesPayloadError(NOT_A_LIST_MESSAGE);
  const get = (/** @type {string} */ key) => (Object.hasOwn(payload, key) ? payload[key] : undefined);
  for (const key of ["statusCode", "status_code"]) {
    const code = asStatus(get(key));
    if (code !== null && code !== 0) {
      const message = [get("status_msg"), get("statusMsg")].find((value) => typeof value === "string" && cleanTitle(value));
      throw new FavoritesPayloadError(
        typeof message === "string" ? cleanTitle(message) : `${key} ${String(get(key))}`,
        Number.isFinite(code) ? code : null,
      );
    }
  }
  const list = get("dramaList");
  // no `dramaList` at all: an empty page only when the answer has the list's own `hasMore`; anything else is no favorites list
  if (!Array.isArray(list) && !((list === undefined || list === null) && Object.hasOwn(payload, "hasMore"))) {
    throw new FavoritesPayloadError(NOT_A_LIST_MESSAGE);
  }
  /** @type {FavoriteItem[]} */
  const items = [];
  let skipped = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    const item = itemOf(raw);
    if (item === null) skipped += 1;
    else items.push(item);
  }
  return { items, cursor: asCursor(get("cursor")), hasMore: asFlag(get("hasMore")), total: asCount(get("total")), skipped };
}

/**
 * Whether a drama's title holds the filter's text, letter case aside (the library's search box).
 * @param {string | null} title
 * @param {string} filter
 * @returns {boolean}
 */
export function titleMatches(title, filter) {
  const wanted = cleanTitle(filter).toLowerCase();
  return wanted === "" || cleanTitle(title ?? "").toLowerCase().includes(wanted);
}

/**
 * A favorites hand-over as a message carries it (`{tabId}`), checked; null when it names no tab.
 * Nothing else of the message is read.
 * @param {unknown} value
 * @returns {FavoritesHandover | null}
 */
export function handoverOf(value) {
  if (!isDict(value)) return null;
  const tabId = value["tabId"];
  if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0) return null;
  return { tabId };
}

/**
 * The DramaFetch tab's address query for a favorites hand-over no running page took (the worker's
 * `openApp` reloads or opens the tab with it): `favorites=<tab id>`.
 * @param {FavoritesHandover} handover
 * @returns {string}
 */
export function favoritesQuery(handover) {
  return new URLSearchParams({ favorites: String(handover.tabId) }).toString();
}

/**
 * The favorites hand-over an address query carries ({@link favoritesQuery}), or null. Nothing else
 * of the query is read.
 * @param {string} search `location.search`
 * @returns {FavoritesHandover | null}
 */
export function favoritesOfQuery(search) {
  const tab = new URLSearchParams(search).get("favorites");
  if (tab === null || !COUNT_RE.test(tab)) return null;
  return { tabId: Number(tab) };
}

/**
 * How many episodes a drama has as far as DramaFetch knows: the list's `episodes`, raised to the
 * highest episode number its own records hold — a run may have listed episodes TikTok added after
 * the list was read and failed to save them (or stopped before them): they count, so such a drama
 * is never `on-disk`. Under a complete mark only an entry on disk or locked raises it: every attempt
 * clears the mark (`state.record`), so a failed or stopped entry under one predates the run that
 * found the series complete and lies past every episode that run listed — TikTok no longer lists it
 * (episodes withdrawn). Null without the list's count: the records alone never tell how many
 * episodes a series has (a selection may have saved only some).
 * @param {import("./state.js").SeriesState} state
 * @param {number | null} episodes the list's episode count
 * @returns {number | null}
 */
export function knownEpisodes(state, episodes) {
  if (episodes === null || !(episodes > 0)) return null;
  const marked = completeSince(state) !== null;
  let known = episodes;
  for (const entry of Object.values(state.episodes)) {
    if (marked && !ACCOUNTED_STATUSES.has(entry.status)) continue;
    if (entry.number > known) known = entry.number;
  }
  return known;
}

/**
 * What DramaFetch's own records say of a favorite (read-only, no request): `on-disk` when a run
 * found the series complete — every episode the account may play saved — and the list names no
 * more `episodes` than that run saw (saved, plus the ones recorded locked), or the records hold
 * every one of its `episodes` saved or locked; `partly` when some are saved — also for a series
 * found complete whose list has grown since, and for one whose records hold an episode beyond the
 * list's count that is not saved while no complete mark covers it ({@link knownEpisodes}); null when
 * none is (or the series was never run).
 * @param {unknown} raw the stored state (`series:<id>`)
 * @param {string} seriesId
 * @param {number | null} episodes the list's episode count
 * @returns {"on-disk" | "partly" | null}
 */
export function progressStatus(raw, seriesId, episodes) {
  const state = readState(raw, seriesId);
  if (state === null) return null;
  const saved = doneEntries(state, () => true).length;
  if (saved === 0) return null;
  const locked = lockedNumbers(state).length;
  const listed = knownEpisodes(state, episodes);
  if (completeSince(state) !== null && (listed === null || (state.complete_episodes ?? 0) + locked >= listed)) return "on-disk";
  if (listed !== null && saved + locked >= listed) return "on-disk";
  return "partly";
}

/**
 * A drama's length as whole hours and minutes (4743 s → 1 h 19 min), at least one minute; null
 * without one.
 * @param {number | null} seconds
 * @returns {{hours: number, minutes: number} | null}
 */
export function durationParts(seconds) {
  if (seconds === null || !(seconds > 0)) return null;
  const total = Math.max(1, Math.round(seconds / 60));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}
