// @ts-check
/**
 * The user's TikTok favorites list (**Favorites** → **Drama** on their own profile), read from
 * INSIDE the user's own TikTok tab that showed it, with that page's own request — as the discovery
 * reads a series with the page's own `item_list` request:
 *
 * - the background worker OBSERVED that tab's own FIRST `drama_list` request (`chrome.webRequest`,
 *   URL and status only; `lib/favorites.isFavoritesFirstPageUrl`: a `cursor` absent, empty or `0` —
 *   a later page, the page's own as its grid scrolls or one asked for here, is never kept) and kept
 *   its URL in `chrome.storage.session` (`storage.readFavoritesTemplate`): that URL is the TEMPLATE;
 * - every page is fetched with `chrome.scripting.executeScript({world: "MAIN"})` running the
 *   discovery's `fetchInPage` — the page's own `fetch`, so the session's cookies and TikTok's own
 *   request handling apply exactly as for the page; the extension never reads a cookie. The FIRST
 *   page is the template itself, replayed byte for byte (TikTok signs the whole query: the
 *   discovery's first page is a pure replay for that reason too); every LATER page is the template
 *   with only its `cursor` changed to the next page's (`discovery.withQueryParams`: every other
 *   query parameter byte for byte, `count` included), as the discovery's later pages carry the next
 *   `cursor`. Whether TikTok accepts those later pages for this list could not be tested from the
 *   sandbox: if it answers one empty or with nothing new, the listing ends as cut short
 *   ({@link cutShort}: the page says TikTok stopped sending the list); if it answers with its own
 *   error, the page shows that error — either way no cooldown, and nothing is downloaded;
 * - one request at a time, each after the list-page pause (`pacing.pagePause`, 0.8–1.6 s) and the
 *   cooldown asked right before it; the listing stops when `hasMore` is false, the cursor does not
 *   change or comes again, a page brings no drama not listed already (TikTok served a page again)
 *   or no item twice in a row, {@link FAVORITES_MAX_PAGES} pages were read, a right-clicked card's
 *   listing reached far enough (`until`: `lib/favorites.coversCard`), the job is stopped, or TikTok
 *   refuses; an empty last page while TikTok counts more than it sent is no end of the list
 *   ({@link cutShort});
 * - refusals as the discovery and the engine treat a list page: HTTP 429 → {@link RateLimitedError}
 *   and HTTP 403 → {@link FavoritesRefusedError} (a stop and the 30-minute cooldown, recorded with
 *   its reason), the tab on TikTok's login page → {@link LoginRequiredError} (a stop, no cooldown),
 *   an answer that brings no list (no JSON, TikTok's own error, a page without a drama) → the tab's
 *   visible text read in the ISOLATED world: TikTok's verification wall → {@link ChallengeError} (a
 *   stop and the cooldown), as the discovery reads a list page that brings none. The texts of a
 *   429 and of the wall name the favorites list ({@link FAVORITES_RATE_LIMIT_MESSAGE},
 *   {@link FAVORITES_CHALLENGE_MESSAGE}: the wall stands in the user's own tab, with no series to
 *   open); `lib/display.js` shows them in Spanish too.
 *
 * Nothing here patches, wraps or overrides anything in TikTok's page, changes one of its requests,
 * guesses or re-signs a URL, or sends anything back; the payload is parsed by `lib/favorites.js`.
 */

import { cooldownMessage, recordBlock } from "../lib/cooldown.js";
import { isDict } from "../lib/catalog.js";
import { FAVORITES_MAX_PAGES, FavoritesPayloadError, parseDramaListPayload } from "../lib/favorites.js";
import { BLOCKED_MESSAGE } from "../lib/messages.js";
import { PAGE_DELAY_S, pagePause } from "../lib/pacing.js";
import {
  ChallengeError,
  DISCOVERY_TIMEOUT_S,
  DiscoveryError,
  LOGIN_REDIRECT_MESSAGE,
  LoginRequiredError,
  RateLimitedError,
  chromeBrowser,
  isLoginUrl,
  looksLikeChallenge,
  queryParam,
  withQueryParams,
} from "./discovery.js";
import { DISCOVERY_SOURCE, StopRequested, checkCooldown } from "./engine.js";

/**
 * @typedef {import("../lib/favorites.js").FavoriteItem} FavoriteItem
 * @typedef {import("../lib/favorites.js").FavoritesPage} FavoritesPage
 * @typedef {import("./engine.js").Engine} Engine
 *
 * @typedef {Pick<import("./discovery.js").DiscoveryBrowser, "tabUrl" | "fetchInTab" | "pageText">} FavoritesBrowser
 *   The chrome.* calls the listing makes in the user's TikTok tab (`discovery.chromeBrowser`'s;
 *   injectable for tests): its address, the page's own `fetch` (MAIN world), its visible text
 *   (ISOLATED world).
 *
 * @typedef {object} FavoritesListing What a listing read, in the list's order.
 * @property {FavoriteItem[]} items every page's dramas, in the pages' order
 * @property {number | null} total how many favorites TikTok counts (the last page that said so)
 * @property {number} pages the pages read
 * @property {number} skipped items left out for want of a valid `dramaID`
 * @property {number} perPage how many dramas a page of the list holds: the most a page read held,
 *   items without a valid `dramaID` included (0 before the first page) — how far past a card's
 *   position its listing reads when the grid has moved (`lib/favorites.coversShift`)
 * @property {boolean} complete the list's end was reached (`hasMore` false)
 * @property {"cap" | "until" | "empty" | "cursor" | null} ended why the listing ended before the
 *   list's end: {@link FAVORITES_MAX_PAGES} pages, far enough for a card (`until`), two empty pages
 *   in a row or an empty last page while TikTok counts more than it sent, a cursor that did not
 *   change or came again or a page that brought no drama not listed already; null when complete (or
 *   not ended yet)
 *
 * @typedef {object} FavoritesOptions
 * @property {number} [pageDelayS] the minimum pause before a page (0.8 s outside test mode)
 * @property {number} [timeoutS] how long one page may take (the discovery's 45 s)
 * @property {number} [maxPages] {@link FAVORITES_MAX_PAGES}
 * @property {(items: readonly FavoriteItem[], perPage: number) => boolean} [until] stop once this
 *   holds of the items listed so far, given how many dramas a page holds (`FavoritesListing.perPage`)
 *   — a right-clicked card's listing: `lib/favorites.coversCard` —, asked after every page that does
 *   not end the list
 * @property {(listing: FavoritesListing, page: FavoritesPage) => void} [onPage] after every page
 * @property {FavoritesBrowser} [browser] `discovery.chromeBrowser()` by default
 */

/**
 * HTTP 429 on the favorites list ({@link RateLimitedError}) — a stop and the 30-minute cooldown.
 * The episode list's `LIST_RATE_LIMIT_MESSAGE` names that list; this one names the list that was
 * refused. The extension's own text: the Python tool has no favorites list.
 */
export const FAVORITES_RATE_LIMIT_MESSAGE =
  "TikTok is rate-limiting this address (HTTP 429 on your favorites list): wait 30-60 minutes " +
  "before trying again";
/**
 * TikTok's verification wall in the user's own TikTok tab instead of the favorites list
 * ({@link ChallengeError}) — a stop and the 30-minute cooldown. The discovery's `CHALLENGE_MESSAGE`
 * says to open the series; here the wall stands in the tab that shows the list, so that is where
 * to solve it.
 */
export const FAVORITES_CHALLENGE_MESSAGE =
  "TikTok is asking for a verification (captcha) instead of your favorites list: after the cooldown, " +
  "solve it in your TikTok tab that shows the list, then try again";

/** HTTP 403 on the favorites list: TikTok refused — a stop and the 30-minute cooldown. */
export class FavoritesRefusedError extends DiscoveryError {
  constructor() {
    super(BLOCKED_MESSAGE);
    this.name = "FavoritesRefusedError";
  }
}

/**
 * The favorites list could not be read, TikTok refusing nothing: `no-template` (the worker saw no
 * favorites list in that tab: no request), `tab-gone` (the TikTok tab was closed or left TikTok: no
 * request), `cooldown` (a cooldown in force before a page: no request; `detail` is the cooldown's
 * message), `status` (JSON that holds no favorites list and no wall in the tab: TikTok's own error
 * — `detail` is its `status_msg` — or none at all, `lib/favorites.NOT_A_LIST_MESSAGE`),
 * `unreadable` (an answer that is no JSON and no wall in the tab: `detail` is the HTTP status, `0`
 * when no answer came). A stop without a cooldown.
 */
export class FavoritesError extends DiscoveryError {
  /**
   * @param {"no-template" | "tab-gone" | "cooldown" | "status" | "unreadable"} kind
   * @param {string} [detail]
   */
  constructor(kind, detail = "") {
    super(detail ? `the favorites list could not be read (${kind}): ${detail}` : `the favorites list could not be read (${kind})`);
    this.name = "FavoritesError";
    this.kind = kind;
    this.detail = detail;
  }
}

/** The hosts of TikTok's own pages, where a profile's favorites list is shown (`menus.js` matches the same three). */
const TIKTOK_PAGE_HOSTS = ["www.tiktok.com", "m.tiktok.com", "tiktok.com"];

/**
 * Whether the tab's page `url` is on the site of the favorites address `template`: the same origin
 * (the fake TikTok's in test mode), or an https page of TikTok's (`www.`, `m.` or the bare host)
 * while the address is on one of TikTok's https hosts — the worker keeps a `drama_list` request of
 * any of them (`https://*.tiktok.com/…`), so the page may ask for its list from another host than
 * its own.
 * @param {string} url
 * @param {string} template
 * @returns {boolean}
 */
function onTemplateSite(url, template) {
  let page;
  let address;
  try {
    page = new URL(url);
    address = new URL(template);
  } catch {
    return false;
  }
  if (page.origin !== "null" && page.origin === address.origin) return true;
  const tiktokAddress = address.protocol === "https:" && (address.hostname === "tiktok.com" || address.hostname.endsWith(".tiktok.com"));
  return tiktokAddress && page.protocol === "https:" && TIKTOK_PAGE_HOSTS.includes(page.hostname);
}

/**
 * Right before a page: the user's TikTok tab is still there and still on TikTok (the site of the
 * template: {@link onTemplateSite}) — else no request ({@link FavoritesError} `tab-gone`) — and not
 * on TikTok's login page ({@link LoginRequiredError}).
 * @param {FavoritesBrowser} browser
 * @param {number} tabId
 * @param {string} template
 * @returns {Promise<void>}
 */
async function stillOnTikTok(browser, tabId, template) {
  let url;
  try {
    url = await browser.tabUrl(tabId);
  } catch {
    throw new FavoritesError("tab-gone");
  }
  if (!onTemplateSite(url, template)) throw new FavoritesError("tab-gone");
  if (isLoginUrl(url)) throw new LoginRequiredError(LOGIN_REDIRECT_MESSAGE);
}

/**
 * Before a favorites job's first request — no request made: the user's TikTok tab `tabId` is still
 * there and on TikTok (the site of its favorites address `template`, {@link onTemplateSite}), else
 * {@link FavoritesError} `tab-gone`; on TikTok's login page, {@link LoginRequiredError}.
 * @param {number} tabId
 * @param {string} template
 * @param {FavoritesBrowser} [browser] `discovery.chromeBrowser()` by default
 * @returns {Promise<void>}
 */
export async function checkFavoritesTab(tabId, template, browser = chromeBrowser()) {
  await stillOnTikTok(browser, tabId, template);
}

/**
 * An answer that brought no list: the login page in the tab ({@link LoginRequiredError}) or
 * TikTok's verification wall in its visible text ({@link ChallengeError} with
 * {@link FAVORITES_CHALLENGE_MESSAGE}, the discovery's `looksLikeChallenge`); else nothing to say.
 * A tab that cannot be read shows neither. Only reads the tab: no request.
 * @param {FavoritesBrowser} browser
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function stopIfWalled(browser, tabId) {
  const url = await browser.tabUrl(tabId).catch(() => "");
  if (isLoginUrl(url)) throw new LoginRequiredError(LOGIN_REDIRECT_MESSAGE);
  let text = "";
  try {
    text = await browser.pageText(tabId);
  } catch {
    text = "";
  }
  if (looksLikeChallenge(text)) throw new ChallengeError(FAVORITES_CHALLENGE_MESSAGE);
}

/**
 * One page fetched from inside the user's tab: the JSON TikTok answered, or a refusal / no list.
 * @param {FavoritesBrowser} browser
 * @param {number} tabId
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
async function fetchPage(browser, tabId, url, timeoutMs) {
  let payload;
  try {
    payload = await browser.fetchInTab(tabId, url, timeoutMs);
  } catch {
    throw new FavoritesError("tab-gone"); // the tab navigated or closed: the script could not run there
  }
  if (!isDict(payload) || !Object.hasOwn(payload, "__dramafetch_status")) return payload;
  const status = payload["__dramafetch_status"];
  if (status === 429) throw new RateLimitedError(FAVORITES_RATE_LIMIT_MESSAGE);
  if (status === 403) throw new FavoritesRefusedError();
  await stopIfWalled(browser, tabId); // no JSON, or another status: the wall may stand in the tab
  throw new FavoritesError("unreadable", typeof status === "number" ? String(status) : "0");
}

/**
 * Read the favorites list of TikTok tab `tabId` with `template` — the tab's own first `drama_list`
 * request — page after page from the top, paced, one request at a time (see the module's comment):
 * the first request is `template` itself, unchanged, and every later one is `template` with only
 * its `cursor` changed to the next page's. Every page goes to `onPage` as it arrives. A refusal
 * (HTTP 429, HTTP 403, a captcha — also behind an answer that brings no list) records the
 * 30-minute cooldown (source `discovery`, the reason its message) and is thrown, like a login wall,
 * a cooldown met before a page, a tab gone or an answer that is no list ({@link FavoritesError});
 * **Stop** throws `StopRequested` at the next pause or between two pages.
 * @param {Engine} engine the job's: its sleep, random source, cooldown and Stop
 * @param {number} tabId
 * @param {string} template
 * @param {FavoritesOptions} [options]
 * @returns {Promise<FavoritesListing>}
 */
export async function listFavorites(engine, tabId, template, options = {}) {
  const browser = options.browser ?? chromeBrowser();
  const maxPages = options.maxPages ?? FAVORITES_MAX_PAGES;
  const pageDelayS = options.pageDelayS ?? PAGE_DELAY_S;
  const timeoutMs = Math.max(1, Math.trunc((options.timeoutS ?? DISCOVERY_TIMEOUT_S) * 1000));
  /** @type {FavoritesListing} */
  const listing = { items: [], total: null, pages: 0, skipped: 0, perPage: 0, complete: false, ended: null };
  /** @type {Set<string>} the series listed so far: a page that brings none new is no progress */
  const listedIds = new Set();
  const own = queryParam(template, "cursor");
  /** @type {string} the cursor of the page asked for next: the template's own ("0" without one, or an empty one) */
  let cursor = own === null || own === "" ? "0" : own;
  /** @type {Set<string>} the cursors asked for already: never twice */
  const asked = new Set();
  /** @type {string} the next page's address: the first page is the template itself, a pure replay */
  let url = template;
  let emptyInARow = 0;
  try {
    for (;;) {
      if (listing.pages >= maxPages) {
        listing.ended = "cap";
        break;
      }
      if (engine.stopRequested?.()) throw new StopRequested();
      await engine.sleep(pagePause(engine.rng, pageDelayS)); // before EVERY page, the first one too
      if (engine.stopRequested?.()) throw new StopRequested();
      const cooldown = await checkCooldown(engine); // right before the request, after its pause
      if (cooldown !== null) throw new FavoritesError("cooldown", cooldownMessage(cooldown, { now: engine.wallClock() }));
      await stillOnTikTok(browser, tabId, template);
      asked.add(cursor);
      const payload = await fetchPage(browser, tabId, url, timeoutMs);
      let page;
      try {
        page = parseDramaListPayload(payload);
      } catch (error) {
        if (!(error instanceof FavoritesPayloadError)) throw error;
        await stopIfWalled(browser, tabId); // no list: the wall may stand in the tab (the discovery's rule)
        throw new FavoritesError("status", error.message);
      }
      if (page.items.length + page.skipped === 0) await stopIfWalled(browser, tabId); // no drama on the page: the same
      listing.pages += 1;
      if (page.items.length > 0 && page.items.every((item) => listedIds.has(item.seriesId))) {
        // nothing new (`browser._paginate`: "the re-issued request added nothing" — TikTok served a
        // page again), whatever items without a readable series id it carries too (each favorite
        // is on the list once): neither its dramas listed nor its unreadable items counted twice,
        // so the positions and the counts stay the profile's ({@link cutShort}), and the end
        listing.ended = "cursor";
        break;
      }
      listing.items.push(...page.items);
      for (const item of page.items) listedIds.add(item.seriesId);
      listing.skipped += page.skipped;
      listing.perPage = Math.max(listing.perPage, page.items.length + page.skipped);
      if (page.total !== null) listing.total = page.total;
      options.onPage?.(listing, page);
      if (!page.hasMore) {
        // TikTok may answer a request it did not sign with an empty list: an empty last page while
        // TikTok counts more than it sent is no end of the list ({@link cutShort})
        const sent = listing.items.length + listing.skipped;
        if (page.items.length + page.skipped === 0 && listing.total !== null && sent < listing.total) listing.ended = "empty";
        else listing.complete = true;
        break;
      }
      if (options.until?.(listing.items, listing.perPage)) {
        listing.ended = "until";
        break;
      }
      emptyInARow = page.items.length + page.skipped === 0 ? emptyInARow + 1 : 0;
      if (emptyInARow >= 2) {
        listing.ended = "empty";
        break;
      }
      if (page.cursor === null || asked.has(page.cursor)) {
        listing.ended = "cursor"; // the cursor did not change, or came again: no page twice
        break;
      }
      cursor = page.cursor;
      url = withQueryParams(template, { cursor }); // a later page: only its cursor changed, `count` untouched
    }
  } catch (error) {
    if (error instanceof RateLimitedError || error instanceof ChallengeError || error instanceof FavoritesRefusedError) {
      await recordBlock(engine.cooldownStore, error.message, DISCOVERY_SOURCE, { now: engine.wallClock() });
    }
    throw error;
  }
  return listing;
}

/**
 * Whether TikTok stopped sending the favorites before the list's end — the listing ended at a cursor
 * that did not move, a page that brought nothing new or empty pages — while it counts more than it
 * sent (or counts none): the rest of the list never arrived. TikTok refused nothing: no cooldown.
 * @param {Pick<FavoritesListing, "ended" | "total" | "items" | "skipped">} listing
 * @returns {boolean}
 */
export function cutShort(listing) {
  if (listing.ended !== "cursor" && listing.ended !== "empty") return false;
  return listing.total === null || listing.items.length + listing.skipped < listing.total;
}
