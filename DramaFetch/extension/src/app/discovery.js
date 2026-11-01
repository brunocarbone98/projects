// @ts-check
/**
 * The episode list of a series, from the user's own Chrome: a port of `discovery/browser.py`.
 *
 * The Python strategy opens the series page in its Chromium, takes the
 * `/api/drama/episode/item_list/` request the page itself makes as a template and pages through
 * the list by re-issuing it from INSIDE the page with the next `cursor` / `count` — everything
 * else of the query byte for byte, since it carries TikTok's signature parameters. This module
 * does the same in a new, inactive and muted tab of the user's Chrome:
 *
 * - it OBSERVES the tab's requests with `chrome.webRequest` (URLs and status codes only — never a
 *   body, never blocking, never changing anything);
 * - it fetches each list page with `chrome.scripting.executeScript({world: "MAIN"})` running
 *   {@link fetchInPage} — the page's own `fetch`, so the session's cookies and TikTok's own
 *   request handling apply exactly as for the page; the extension never reads a cookie. It cannot
 *   read the bodies of the page's own requests, so the first page costs one repeated request;
 * - it pauses `pageDelayS` × uniform(1.0, 2.0) — 0.8–1.6 s — before EVERY page fetch, the first
 *   included; it falls back to scrolling the list ({@link scrollInPage}, DOM scrolling in the
 *   ISOLATED world) and re-fetching, once each, the exact item_list URLs the page requested;
 * - it stops at a login redirect, a captcha page ({@link looksLikeChallenge}, the page text read
 *   in the ISOLATED world) or an HTTP 429, and closes the tab it opened on every path — also when
 *   the DramaFetch tab goes away mid-listing: the tab is recorded ({@link DISCOVERY_TAB_KEY}) for
 *   the background worker and the next DramaFetch page to close.
 *
 * Nothing here patches, wraps or overrides anything in TikTok's page, unlocks anything or sends
 * anything back: the payload is parsed by `lib/catalog.js` exactly as the Python code parses it.
 */

import {
  catalogWarnings,
  findItemLists,
  isDict,
  mergeEpisodes,
  parseDetailPayload,
  parseItemListPayload,
} from "../lib/catalog.js";
import { LIST_RATE_LIMIT_MESSAGE, TIKTOK_BASE_URL, pyFormatG } from "../lib/messages.js";
import { PAGE_DELAY_S, defaultRng, pagePause, sleepSeconds } from "../lib/pacing.js";
import { seriesPageUrl } from "../lib/urls.js";

/** Substrings of the two API requests the page makes (`browser.ITEM_LIST_MARKER` / `DETAIL_MARKER`). */
export const ITEM_LIST_MARKER = "/api/drama/episode/item_list";
export const DETAIL_MARKER = "/api/drama/detail";
/** Visible text of TikTok's verification wall (`static.CHALLENGE_MARKERS`). */
export const CHALLENGE_MARKERS = Object.freeze(
  /** @type {const} */ (["verify to continue", "captcha", "checking your browser", "verify you are human"]),
);
/** How often the wait for the first list request looks again (`browser.POLL_INTERVAL_S`). */
export const POLL_INTERVAL_S = 0.25;
/** How often the page text is read for a captcha while waiting (`browser.CHALLENGE_CHECK_INTERVAL_S`). */
export const CHALLENGE_CHECK_INTERVAL_S = 2;
/** No list request within this long: the tab is activated (TikTok may defer work in a hidden tab). */
export const ACTIVATE_AFTER_S = 10;
/** The whole wait for the first list request (`DiscoveryOptions.timeout_s`). */
export const DISCOVERY_TIMEOUT_S = 45;
/** How long the detail request may still take after the list (`browser.DETAIL_GRACE_S`). */
export const DETAIL_GRACE_S = 2;
/** Quiet scroll rounds before the fallback gives up (`browser.SCROLL_ROUNDS_WITHOUT_NEWS`). */
export const SCROLL_ROUNDS_WITHOUT_NEWS = 4;
/** `count` of every page the extension fetches (`DiscoveryOptions.page_count`). */
export const PAGE_COUNT = 30;
/** At most this many list pages per series (`DiscoveryOptions.max_pages`). */
export const MAX_PAGES = 60;
/** How long the new tab may take to finish loading `about:blank` before it is sent to the series. */
export const BLANK_TAB_WAIT_S = 2;
/**
 * The `chrome.storage.session` record of the TikTok tab a discovery has open, `{tabId, appTabId}`:
 * the background worker closes that tab when its DramaFetch tab goes away mid-listing (closed,
 * navigated elsewhere, discarded — the page's own `finally` never runs then), and a new engine
 * page closes what an earlier one left behind (a reload).
 */
export const DISCOVERY_TAB_KEY = "discoveryTab";

/** Login redirect (the Python text names `--cookies`; the extension uses the browser's session). */
export const LOGIN_REDIRECT_MESSAGE =
  "TikTok redirected to its login page: log in to TikTok in a normal tab of this Chrome, then try again";
/** A captcha instead of the series (`ChallengeError`): stop and 30-minute cooldown. */
export const CHALLENGE_MESSAGE =
  "TikTok is asking for a verification (captcha) instead of the series: after the cooldown, open the " +
  "series in a normal tab of this Chrome, solve it there, then try again";
/** No list item at all (`_build_series`, seen == 0). */
export const EMPTY_LIST_MESSAGE =
  "TikTok returned an empty episode list; a logged-in session is required: log in to TikTok in a " +
  "normal tab of this Chrome";
/** The warnings of the pagination (`browser._paginate`), word for word. */
export const NO_CURSOR_WARNING = "TikTok reported more episodes without a usable cursor; scrolled the page instead";
export const NO_LIST_WARNING = "in-page pagination fetch returned no episode list; scrolled the page instead";
export const NOTHING_NEW_WARNING =
  "in-page pagination returned no new episodes although TikTok reported more; scrolled the page instead";
/** The extension's own case: its repeat of the page's first request gave no list. */
export const FIRST_PAGE_WARNING =
  "the first episode-list page could not be fetched again from inside the page; scrolled the page instead";

/** A discovery failure (`errors.DiscoveryError`); its message is printable as is. */
export class DiscoveryError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/** TikTok wants a login (`errors.LoginRequiredError`): the run stops. */
export class LoginRequiredError extends DiscoveryError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "LoginRequiredError";
  }
}

/** A captcha page (`errors.ChallengeError`): the run stops and the cooldown starts. */
export class ChallengeError extends DiscoveryError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ChallengeError";
  }
}

/** HTTP 429 on the list (`errors.RateLimitedError`): the run stops and the cooldown starts. */
export class RateLimitedError extends DiscoveryError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "RateLimitedError";
  }
}

// ------------------------------------------------------------------------ pure helpers

/**
 * True when visible page text reads like TikTok's captcha wall (`static.looks_like_challenge`).
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeChallenge(text) {
  const lowered = text.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * The path of a URL as Python's `urlsplit(url).path` gives it (no query, no fragment).
 * @param {string} url
 * @returns {string}
 */
function pathOf(url) {
  const rest = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, "");
  const afterHost = rest.startsWith("//") ? rest.slice(2).replace(/^[^/?#]*/, "") : rest;
  return afterHost.replace(/[?#].*$/s, "");
}

/**
 * Whether a tab's URL is TikTok's login page (`static.is_login_url`).
 * @param {string} url
 * @returns {boolean}
 */
export function isLoginUrl(url) {
  return pathOf(url).replace(/\/+$/, "").toLowerCase().startsWith("/login");
}

/**
 * The first value of a query parameter (percent-decoded), or null.
 * @param {string} url
 * @param {string} name
 * @returns {string | null}
 */
export function queryParam(url, name) {
  const query = url.replace(/#.*$/s, "").split("?").slice(1).join("?");
  for (const field of query.split("&")) {
    const eq = field.indexOf("=");
    const key = eq >= 0 ? field.slice(0, eq) : field;
    if (key !== name) continue;
    const value = eq >= 0 ? field.slice(eq + 1) : "";
    try {
      return decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      return value;
    }
  }
  return null;
}

/**
 * A URL fit for messages: scheme, host and path only (`static.safe_url`; queries carry tokens).
 * @param {string} url
 * @returns {string}
 */
export function safeUrl(url) {
  return url.replace(/[?#].*$/s, "");
}

/**
 * Python's `urllib.parse.quote(value, safe="")`: UTF-8, every byte but `A-Za-z0-9_.-~` as `%XX`.
 * @param {string} value
 * @returns {string}
 */
export function pyQuote(value) {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.\-~]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * `browser._with_query_params`: replace (or append) query parameters in place, every other
 * parameter byte for byte — the rest of the query carries TikTok's signature parameters.
 * @param {string} url
 * @param {Record<string, string>} params
 * @returns {string}
 */
export function withQueryParams(url, params) {
  const hash = url.indexOf("#");
  const fragment = hash >= 0 ? url.slice(hash) : "";
  const head = hash >= 0 ? url.slice(0, hash) : url;
  const question = head.indexOf("?");
  const base = question >= 0 ? head.slice(0, question) : head;
  let query = question >= 0 ? head.slice(question + 1) : "";
  for (const [key, value] of Object.entries(params)) {
    const encoded = `${key}=${pyQuote(value)}`;
    const match = new RegExp(`(^|&)${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=[^&]*`).exec(query);
    if (match !== null) {
      query = `${query.slice(0, match.index)}${match[1]}${encoded}${query.slice(match.index + match[0].length)}`;
    } else {
      query = query ? `${query}&${encoded}` : encoded;
    }
  }
  return query ? `${base}?${query}${fragment}` : `${base}${fragment}`;
}

// ------------------------------------------------------------- functions run in the page
// executeScript serialises these: each must be self-contained (no imports, no closures).

/**
 * `browser.FETCH_JS`, run in the page's MAIN world: re-issue an item_list (or detail) request
 * with the page's own `fetch`. A non-2xx answer (whatever its body) and a non-JSON body come back
 * as a `__dramafetch_status` marker, so a 429 is recognised even with a JSON body; the timeout
 * aborts a stalled request (marker with status 0).
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
export async function fetchInPage(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { credentials: "include", signal: controller.signal });
    const text = await response.text();
    if (!response.ok) return { __dramafetch_status: response.status, __dramafetch_text: text.slice(0, 200) };
    try {
      return JSON.parse(text);
    } catch {
      return { __dramafetch_status: response.status, __dramafetch_text: text.slice(0, 200) };
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : String(error);
    return { __dramafetch_status: 0, __dramafetch_text: name.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `browser.SCROLL_JS`, run in the ISOLATED world: scroll the episode list (or the first
 * scrollable ancestor of an episode link) and the window — DOM scrolling only.
 * @returns {string | null} what was scrolled
 */
export function scrollInPage() {
  /** @type {Element | null} */
  let el = document.querySelector('[data-testid="short-drama-detail"]');
  if (!el) {
    const links = document.querySelectorAll('a[href*="/shortdrama/episode/"], a[href*="/video/"]');
    outer: for (const a of links) {
      for (let p = a.parentElement; p && p !== document.body; p = p.parentElement) {
        const style = getComputedStyle(p);
        const scrolls = /(auto|scroll)/.test(style.overflowY) && p.scrollHeight > p.clientHeight;
        if (scrolls) {
          el = p;
          break outer;
        }
      }
    }
  }
  if (el) {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  }
  window.scrollTo(0, document.body.scrollHeight);
  return el ? el.getAttribute("data-testid") || el.tagName.toLowerCase() : null;
}

/**
 * The title and visible text of the page, run in the ISOLATED world (read only): what
 * {@link looksLikeChallenge} judges (`browser._page_shows_challenge`).
 * @returns {string}
 */
export function pageTextInPage() {
  return `${document.title}\n${(document.body && document.body.innerText) || ""}`;
}

// ------------------------------------------------------------------- the browser seam

/**
 * @typedef {object} ObservedRequest A request of the series tab, as webRequest reports it.
 * @property {string} url
 * @property {number} status the HTTP status, 0 when the request failed
 *
 * @typedef {object} ObserverHandlers
 * @property {(request: ObservedRequest) => void} completed
 *
 * @typedef {object} DiscoveryBrowser The chrome.* calls the discovery makes (injectable for tests).
 * @property {(windowId: number | undefined) => Promise<number>} openTab a new inactive, muted tab
 * @property {(tabId: number, url: string) => Promise<void>} navigate
 * @property {(tabId: number) => Promise<string>} tabUrl
 * @property {(tabId: number) => Promise<void>} activate
 * @property {(tabId: number) => Promise<void>} closeTab
 * @property {(tabId: number, urls: string[], handlers: ObserverHandlers) => () => void} observe
 * @property {(tabId: number, url: string, timeoutMs: number) => Promise<unknown>} fetchInTab MAIN world
 * @property {(tabId: number) => Promise<unknown>} scrollTab ISOLATED world
 * @property {(tabId: number) => Promise<string>} pageText ISOLATED world
 */

/**
 * Record the TikTok tab a discovery opened, with the DramaFetch tab it belongs to
 * ({@link DISCOVERY_TAB_KEY}).
 * @param {number} tabId
 * @param {number | undefined} appTabId
 * @returns {Promise<void>}
 */
async function rememberDiscoveryTab(tabId, appTabId) {
  await chrome.storage.session.set({ [DISCOVERY_TAB_KEY]: { tabId, appTabId: appTabId ?? null } });
}

/**
 * The recorded discovery tab, or null.
 * @returns {Promise<{tabId: number, appTabId: number | null} | null>}
 */
async function recordedDiscoveryTab() {
  const record = (await chrome.storage.session.get(DISCOVERY_TAB_KEY))[DISCOVERY_TAB_KEY];
  if (!isDict(record) || typeof record["tabId"] !== "number") return null;
  const appTabId = record["appTabId"];
  return { tabId: record["tabId"], appTabId: typeof appTabId === "number" ? appTabId : null };
}

/**
 * Forget the recorded discovery tab when it is `tabId` (it has been closed).
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function forgetDiscoveryTab(tabId) {
  const recorded = await recordedDiscoveryTab();
  if (recorded !== null && recorded.tabId === tabId) await chrome.storage.session.remove(DISCOVERY_TAB_KEY);
}

/**
 * Close the TikTok tab a discovery left open and forget it: the one of the DramaFetch tab
 * `appTabId` (the background worker, when that tab is removed or leaves the app), or — without
 * `appTabId` — whatever is recorded (a new engine page: no discovery of its own runs yet).
 * Whether a tab was closed.
 * @param {number} [appTabId]
 * @returns {Promise<boolean>}
 */
export async function closeLeftoverDiscoveryTab(appTabId) {
  const recorded = await recordedDiscoveryTab();
  if (recorded === null || (appTabId !== undefined && recorded.appTabId !== appTabId)) return false;
  await chrome.tabs.remove(recorded.tabId).catch(() => undefined);
  await forgetDiscoveryTab(recorded.tabId);
  return true;
}

/**
 * Wait (at most {@link BLANK_TAB_WAIT_S}) until a new tab has finished loading `about:blank`: a
 * navigation started before that first commit can be cancelled by it, which leaves the tab on
 * `about:blank` while the series page was already requested.
 * @param {number} tabId
 * @param {(seconds: number) => Promise<void>} sleep
 * @returns {Promise<void>}
 */
async function blankTabLoaded(tabId, sleep) {
  const deadline = Date.now() + BLANK_TAB_WAIT_S * 1000;
  while ((await chrome.tabs.get(tabId)).status !== "complete" && Date.now() < deadline) {
    await sleep(0.02);
  }
}

/**
 * The real browser: chrome.tabs, chrome.webRequest (observation only) and chrome.scripting. The tab
 * it opens is recorded with `appTabId` (the DramaFetch tab) until it is closed
 * ({@link DISCOVERY_TAB_KEY}).
 * @param {number} [appTabId]
 * @param {{sleep?: (seconds: number) => Promise<void>}} [options] the polling of a new tab's first load
 * @returns {DiscoveryBrowser}
 */
export function chromeBrowser(appTabId, options = {}) {
  const sleep = options.sleep ?? ((seconds) => sleepSeconds(seconds));
  return {
    async openTab(windowId) {
      /** @type {chrome.tabs.CreateProperties} */
      const properties = { url: "about:blank", active: false };
      if (windowId !== undefined) properties.windowId = windowId;
      const tab = await chrome.tabs.create(properties);
      if (tab.id === undefined) throw new DiscoveryError("Chrome did not open a tab for the series");
      const tabId = tab.id;
      try {
        await rememberDiscoveryTab(tabId, appTabId); // first: closed even if this page goes away
        await chrome.tabs.update(tabId, { muted: true });
        await blankTabLoaded(tabId, sleep);
      } catch (error) {
        await chrome.tabs.remove(tabId).catch(() => undefined);
        await forgetDiscoveryTab(tabId).catch(() => undefined);
        throw error;
      }
      return tabId;
    },
    async navigate(tabId, url) {
      await chrome.tabs.update(tabId, { url });
    },
    async tabUrl(tabId) {
      const tab = await chrome.tabs.get(tabId);
      return tab.url || tab.pendingUrl || "";
    },
    async activate(tabId) {
      await chrome.tabs.update(tabId, { active: true });
    },
    async closeTab(tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } finally {
        await forgetDiscoveryTab(tabId);
      }
    },
    observe(tabId, urls, handlers) {
      /** @param {chrome.webRequest.CompletedDetails} details */
      const completed = (details) => handlers.completed({ url: details.url, status: details.statusCode });
      /** @param {chrome.webRequest.ErrorDetails} details */
      const failed = (details) => handlers.completed({ url: details.url, status: 0 });
      /** @type {chrome.webRequest.RequestFilter} */
      const filter = { urls, tabId, types: ["xmlhttprequest"] };
      chrome.webRequest.onCompleted.addListener(completed, filter);
      chrome.webRequest.onErrorOccurred.addListener(failed, filter);
      return () => {
        chrome.webRequest.onCompleted.removeListener(completed);
        chrome.webRequest.onErrorOccurred.removeListener(failed);
      };
    },
    async fetchInTab(tabId, url, timeoutMs) {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: fetchInPage,
        args: [url, timeoutMs],
      });
      return injection?.result;
    },
    async scrollTab(tabId) {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: scrollInPage });
      return injection?.result;
    },
    async pageText(tabId) {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: pageTextInPage });
      return typeof injection?.result === "string" ? injection.result : "";
    },
  };
}

// ------------------------------------------------------------------------- discovery

/**
 * @typedef {import("../lib/catalog.js").Series} Series
 * @typedef {import("../lib/catalog.js").PagePayload} PagePayload
 * @typedef {import("../lib/urls.js").SeriesRef} SeriesRef
 * @typedef {import("../lib/pacing.js").Rng} Rng
 *
 * @typedef {object} DiscoveryOptions
 * @property {string} [baseUrl] TikTok's origin (another one only in test mode)
 * @property {number} [timeoutS] the wait for the first list request (45 s)
 * @property {number} [activateAfterS] activate the tab after this long without a list (10 s)
 * @property {number} [detailGraceS] (2 s)
 * @property {number} [pageDelayS] the minimum pause before a list page (0.8 s)
 * @property {number} [pageCount]
 * @property {number} [maxPages]
 * @property {number} [windowId] the window the tab opens in (the app's)
 * @property {number} [returnTabId] the DramaFetch tab: activated again when the series tab was
 *   activated, and the owner the series tab is recorded with ({@link DISCOVERY_TAB_KEY})
 * @property {Rng} [rng]
 * @property {(seconds: number) => Promise<void>} [sleep] the pauses and the polling
 * @property {() => number} [clock] seconds, for the deadlines
 * @property {DiscoveryBrowser} [browser]
 */

/** The page's API requests the observer saw, and the URLs the extension fetched itself. */
class Capture {
  /** @param {string} seriesId */
  constructor(seriesId) {
    this.seriesId = seriesId;
    /** @type {PagePayload[]} */
    this.pages = [];
    /** @type {Set<string>} */
    this.itemIds = new Set();
    /** @type {Set<string>} */
    this.seenPayloads = new Set();
    /** @type {unknown} */
    this.detail = null;
    /** @type {string[]} */
    this.warnings = [];
    /** @type {string | null} the first item_list request of the page, once it completed */
    this.template = null;
    /** @type {string[]} item_list URLs the page itself requested, in order */
    this.pageLists = [];
    /** @type {string | null} */
    this.detailUrl = null;
    /** @type {Set<string>} URLs the extension fetched (their webRequest events are its own) */
    this.ours = new Set();
    /** @type {Set<string>} URLs fetched once already: never twice */
    this.fetched = new Set();
    /** @type {Set<string>} `cursor` values of the list pages fetched: the page's own request of
     * the same cursor brings nothing new, so the fallback never repeats it */
    this.fetchedCursors = new Set();
    this.rateLimited = false;
  }

  /**
   * Whether the fallback still has to fetch this page-requested URL.
   * @param {string} url
   * @returns {boolean}
   */
  wanted(url) {
    if (this.fetched.has(url)) return false;
    const cursor = queryParam(url, "cursor");
    return cursor === null || !this.fetchedCursors.has(cursor);
  }

  /**
   * One request the observer saw.
   * @param {ObservedRequest} request
   */
  observed(request) {
    if (this.ours.has(request.url)) return;
    if (request.url.includes(ITEM_LIST_MARKER)) {
      if (request.status === 429) this.rateLimited = true;
      if (!this.pageLists.includes(request.url)) this.pageLists.push(request.url);
      if (this.template === null) this.template = request.url;
    } else if (request.url.includes(DETAIL_MARKER) && this.detailUrl === null) {
      this.detailUrl = request.url;
    }
  }

  /**
   * Parse one item_list payload (`_Capture.ingest`): the page and how many episodes it added. A
   * payload seen before is parsed but not counted or stored again.
   * @param {unknown} payload
   * @returns {{page: PagePayload, added: number}}
   */
  ingest(payload) {
    const page = parseItemListPayload(payload, this.seriesId);
    const key = JSON.stringify(payload);
    if (this.seenPayloads.has(key)) return { page, added: 0 };
    this.seenPayloads.add(key);
    this.pages.push(page);
    let added = 0;
    for (const episode of page.episodes) {
      if (!this.itemIds.has(episode.itemId)) {
        this.itemIds.add(episode.itemId);
        added += 1;
      }
    }
    return { page, added };
  }
}

/**
 * @param {number} seconds
 * @returns {Promise<void>}
 */
function realSleep(seconds) {
  return sleepSeconds(seconds);
}

/**
 * The URL patterns the observer listens to: the base's whole origin (the marker is checked in
 * the listener, like the Python response listener), plus TikTok's subdomains for the real site.
 * @param {string} base
 * @returns {string[]}
 */
export function observedUrlPatterns(base) {
  const origin = base.replace(/\/+$/, "");
  if (origin === TIKTOK_BASE_URL) return [`${origin}/*`, "https://*.tiktok.com/*"];
  return [`${origin}/*`];
}

/**
 * Resolve a series into its episode list from a tab of the user's Chrome (`PlaywrightDiscovery
 * .discover`). Throws a {@link DiscoveryError} (login, captcha, HTTP 429, nothing listed); the
 * caller records the cooldown for a {@link RateLimitedError} or {@link ChallengeError}.
 * @param {SeriesRef} ref
 * @param {DiscoveryOptions} [options]
 * @returns {Promise<Series>}
 */
export async function discoverSeries(ref, options = {}) {
  const base = (options.baseUrl ?? TIKTOK_BASE_URL).replace(/\/+$/, "");
  const browser = options.browser ?? chromeBrowser(options.returnTabId);
  const sleep = options.sleep ?? realSleep;
  const clock = options.clock ?? (() => performance.now() / 1000);
  const rng = options.rng ?? defaultRng;
  const timeoutS = options.timeoutS ?? DISCOVERY_TIMEOUT_S;
  const pageDelayS = options.pageDelayS ?? PAGE_DELAY_S;
  const pageCount = options.pageCount ?? PAGE_COUNT;
  const maxPages = options.maxPages ?? MAX_PAGES;
  const capture = new Capture(ref.seriesId);
  const timeoutMs = Math.max(1, Math.trunc(timeoutS * 1000));
  let activated = false;
  /** @type {number | null} */
  let tabId = null;
  /** @type {(() => void) | null} */
  let stopObserving = null;

  const pause = () => sleep(pagePause(rng, pageDelayS));

  /**
   * One page fetched from inside the page (`_fetch_in_page`): the payload, or null when the
   * answer is unusable; HTTP 429 stops the discovery.
   * @param {number} tab
   * @param {string} url
   * @returns {Promise<unknown>}
   */
  const fetchPage = async (tab, url) => {
    if (capture.rateLimited) throw new RateLimitedError(LIST_RATE_LIMIT_MESSAGE); // the page met a 429
    capture.ours.add(url);
    capture.fetched.add(url);
    let payload;
    try {
      payload = await browser.fetchInTab(tab, url, timeoutMs);
    } catch {
      return null; // the tab navigated or closed: the fallback takes over
    }
    if (!isDict(payload) || Object.hasOwn(payload, "__dramafetch_status")) {
      const status = isDict(payload) ? payload["__dramafetch_status"] : null;
      if (status === 429) throw new RateLimitedError(LIST_RATE_LIMIT_MESSAGE);
      return null;
    }
    return payload;
  };

  /**
   * A list page (the payload must hold an item list).
   * @param {number} tab
   * @param {string} url
   * @returns {Promise<unknown>}
   */
  const fetchListPage = async (tab, url) => {
    const payload = await fetchPage(tab, url);
    if (payload === null || findItemLists(payload).length === 0) return null;
    const cursor = queryParam(url, "cursor");
    if (cursor !== null) capture.fetchedCursors.add(cursor);
    return payload;
  };

  /** @param {number} tab */
  const scrollForMore = async (tab) => {
    let quiet = 0;
    while (quiet < SCROLL_ROUNDS_WITHOUT_NEWS) {
      if (capture.pages.length >= maxPages) {
        capture.warnings.push(maxPagesWarning(maxPages));
        return;
      }
      try {
        await browser.scrollTab(tab);
      } catch {
        return;
      }
      await pause();
      let added = 0;
      for (const url of capture.pageLists.filter((candidate) => capture.wanted(candidate))) {
        if (capture.pages.length >= maxPages) {
          capture.warnings.push(maxPagesWarning(maxPages));
          return;
        }
        await pause();
        const payload = await fetchListPage(tab, url);
        if (payload !== null) added += capture.ingest(payload).added;
      }
      quiet = added > 0 ? 0 : quiet + 1;
    }
  };

  /** @param {number} tab @param {string} template */
  const paginate = async (tab, template) => {
    const firstUrl = withQueryParams(template, { cursor: "0", count: String(pageCount) });
    await pause();
    const first = await fetchListPage(tab, firstUrl);
    if (first === null) {
      capture.warnings.push(FIRST_PAGE_WARNING);
      await scrollForMore(tab);
      return;
    }
    let current = capture.ingest(first).page;
    /** @type {string} */
    let previousCursor = "0";
    while (current.hasMore) {
      if (capture.pages.length >= maxPages) {
        capture.warnings.push(maxPagesWarning(maxPages));
        return;
      }
      const cursor = current.cursor;
      if (cursor === null || String(cursor) === previousCursor) {
        capture.warnings.push(NO_CURSOR_WARNING);
        await scrollForMore(tab);
        return;
      }
      const nextUrl = withQueryParams(template, { cursor: String(cursor), count: String(pageCount) });
      await pause();
      const payload = await fetchListPage(tab, nextUrl);
      if (payload === null) {
        capture.warnings.push(NO_LIST_WARNING);
        await scrollForMore(tab);
        return;
      }
      previousCursor = String(cursor);
      const ingested = capture.ingest(payload);
      current = ingested.page;
      if (ingested.added === 0) {
        capture.warnings.push(NOTHING_NEW_WARNING);
        await scrollForMore(tab);
        return;
      }
    }
  };

  try {
    tabId = await browser.openTab(options.windowId);
    const tab = tabId;
    stopObserving = browser.observe(tab, observedUrlPatterns(base), {
      completed: (request) => capture.observed(request),
    });
    await browser.navigate(tab, seriesPageUrl(ref.seriesId, ref.episodeHint || 1, base));

    // `_open_series_page`: wait for the page's own first item_list request
    const started = clock();
    const deadline = started + timeoutS;
    let nextChallengeCheck = 0;
    let pageUrl = "";
    for (;;) {
      if (capture.rateLimited) throw new RateLimitedError(LIST_RATE_LIMIT_MESSAGE);
      if (capture.template !== null) break;
      try {
        pageUrl = await browser.tabUrl(tab);
      } catch {
        throw new DiscoveryError("the TikTok tab DramaFetch opened was closed before the episode list arrived");
      }
      if (isLoginUrl(pageUrl)) throw new LoginRequiredError(LOGIN_REDIRECT_MESSAGE);
      const now = clock();
      if (now >= nextChallengeCheck) {
        nextChallengeCheck = now + CHALLENGE_CHECK_INTERVAL_S;
        let text = "";
        try {
          text = await browser.pageText(tab);
        } catch {
          text = ""; // navigating: look again next round
        }
        if (looksLikeChallenge(text)) throw new ChallengeError(CHALLENGE_MESSAGE);
      }
      if (!activated && now - started >= (options.activateAfterS ?? ACTIVATE_AFTER_S)) {
        activated = true;
        await browser.activate(tab).catch(() => undefined);
      }
      if (now >= deadline) {
        throw new DiscoveryError(
          `no episode list within ${pyFormatG(timeoutS)} s (page: ${safeUrl(pageUrl)}): if this Chrome ` +
            "is not logged in to TikTok, log in in a normal tab and try again",
        );
      }
      await sleep(POLL_INTERVAL_S);
    }
    await paginate(tab, /** @type {string} */ (capture.template));

    // `_await_detail`: the detail request the page made (name and announced total), fetched once
    const detailDeadline = clock() + (options.detailGraceS ?? DETAIL_GRACE_S);
    while (capture.detailUrl === null && clock() < detailDeadline) await sleep(POLL_INTERVAL_S);
    if (capture.detailUrl !== null && !capture.fetched.has(capture.detailUrl)) {
      await pause();
      const detail = await fetchPage(tab, capture.detailUrl);
      if (detail !== null) capture.detail = detail;
    }
  } finally {
    if (stopObserving !== null) stopObserving();
    if (tabId !== null) {
      await browser.closeTab(tabId).catch(() => undefined);
      if (activated && options.returnTabId !== undefined) {
        await browser.activate(options.returnTabId).catch(() => undefined);
      }
    }
  }
  return buildSeries(ref, capture);
}

/**
 * @param {number} maxPages
 * @returns {string}
 */
function maxPagesWarning(maxPages) {
  return `pagination stopped at max_pages (${maxPages}); the list may be incomplete`;
}

/**
 * `browser._build_series`: the merged episodes, the detail's name and total (the items'
 * `dramaInfo.dramaName` as the fallback name), the warnings.
 * @param {SeriesRef} ref
 * @param {Capture} capture
 * @returns {Series}
 */
function buildSeries(ref, capture) {
  const episodes = mergeEpisodes(capture.pages.map((page) => page.episodes));
  let { name, total } = capture.detail !== null ? parseDetailPayload(capture.detail) : { name: null, total: null };
  if (name === null) name = episodes.find((episode) => episode.seriesName)?.seriesName ?? null;
  if (episodes.length === 0) {
    const seen = capture.pages.reduce((sum, page) => sum + page.seenItems, 0);
    if (seen === 0) throw new LoginRequiredError(EMPTY_LIST_MESSAGE);
    throw new DiscoveryError(
      `TikTok listed ${seen} items but none belongs to series ${ref.seriesId} (is this a short-drama series URL?)`,
    );
  }
  return {
    seriesId: ref.seriesId,
    name,
    episodes,
    totalHint: total,
    warnings: [...capture.warnings, ...catalogWarnings(episodes, total)],
  };
}
