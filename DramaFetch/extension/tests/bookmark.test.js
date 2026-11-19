// @ts-check
// Remove from Favorites (src/app/bookmark.js): the Bookmark state reader run in the drama's page
// (over a fake DOM: saved, unsaved, missing, several buttons, the one click), and the removal over a
// fake `chrome` — `tabs` (the muted background tab, its navigations, its closing), `scripting` (the
// reader in the ISOLATED world, each answer stamped with its document) and `webRequest` (the page's
// own `collect` request, URL and status) — on every path: removed after a reload, already removed,
// no button, several buttons, no change after the click, TikTok not keeping it, 429 and 403 on
// `collect`, a captcha, the login page, a cooldown, Stop, the tab closed by hand. One click at most,
// a pause and the cooldown before the click and before the reload, the tab closed on every path, a
// refusal's cooldown recorded with its reason. Then TikTok's count after a removal: one request.
// Nothing sleeps for real, nothing reaches the network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { clearCooldown, recordBlock } from "../src/lib/cooldown.js";
import { BLOCKED_MESSAGE, LIST_RATE_LIMIT_MESSAGE } from "../src/lib/messages.js";
import { PacingState, pacingOptions } from "../src/lib/pacing.js";
import {
  BOOKMARK_CHALLENGE_MESSAGE,
  BOOKMARK_MESSAGES,
  BOOKMARK_RATE_LIMIT_MESSAGE,
  BOOKMARK_SAVED_COLOR,
  BOOKMARK_SELECTOR,
  BookmarkCooldown,
  BookmarkError,
  BookmarkRefusedError,
  CHANGE_WAIT_S,
  POLL_S,
  bookmarkInPage,
  countAfterRemoval,
  isCollectUrl,
  removeFromBookmark,
} from "../src/app/bookmark.js";
import {
  ChallengeError,
  DISCOVERY_TAB_KEY,
  DISCOVERY_TIMEOUT_S,
  LOGIN_REDIRECT_MESSAGE,
  LoginRequiredError,
  RateLimitedError,
  fetchInPage,
  pageTextInPage,
} from "../src/app/discovery.js";
import { StopRequested } from "../src/app/engine.js";

const SERIES = "7712345678901234561";
const BASE = "https://www.tiktok.com";
const PAGE = `${BASE}/shortdrama/episode/${SERIES}/1`;
const COLLECT = `${BASE}/api/item/collect/?WebIdLastTime=1794300000&action=0&aid=1988&itemId=7699400000000000001&X-Bogus=x`;
/** The drama page's own episode-list request (the discovery's `ITEM_LIST_MARKER`). */
const ITEM_LIST = `${BASE}/api/drama/episode/item_list/?aid=1988&count=30&cursor=0&seriesId=${SERIES}&X-Bogus=y`;
const TAB = 77;
const APP_TAB = 5;

// ------------------------------------------------------------- the reader, over a fake DOM

/**
 * What Chrome computes for a `color` / `fill` presentation attribute: `#FACE15` (letter case aside)
 * as rgb(250, 206, 21); anything else falls back to the node's default.
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
const presented = (value) => (typeof value === "string" && /^#face15$/i.test(value.trim()) ? "rgb(250, 206, 21)" : undefined);

/**
 * A fake element of the drama's page: its attributes, computed colours — as Chrome computes them:
 * an svg element's `color` / `fill` attribute unless a style (`color` / `fill` here) draws it
 * otherwise; on an HTML element (`html`) the attribute does nothing —, `fill-opacity`,
 * `visibility`, `opacity`, `overflow` and `display`, its namespace (`svg`), its box (`size`: 24×24
 * when laid out, else 0×0), children (each linked back to it as its `parentElement`), whether it
 * is laid out, and its clicks.
 */
class Node {
  /**
   * @param {Record<string, string>} [attributes]
   * @param {{color?: string, fill?: string, fillOpacity?: string, visibility?: string, opacity?: string, overflow?: string, display?: string, svg?: boolean, html?: boolean, size?: [number, number], laidOut?: boolean, children?: Node[]}} [options]
   */
  constructor(attributes = {}, options = {}) {
    this.attributes = attributes;
    const shown = options.html ? {} : attributes; // a presentation attribute takes effect on an svg element only
    this.color = options.color ?? presented(shown["color"]) ?? "rgb(255, 255, 255)";
    this.fill = options.fill ?? presented(shown["fill"]) ?? "rgb(0, 0, 0)";
    this.fillOpacity = options.fillOpacity ?? "1";
    this.visibility = options.visibility ?? "visible";
    this.opacity = options.opacity ?? "1";
    this.overflow = options.overflow ?? "visible";
    this.display = options.display ?? "block";
    this.namespaceURI = options.svg ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml";
    this.laidOut = options.laidOut ?? true;
    this.size = options.size ?? (this.laidOut ? [24, 24] : [0, 0]);
    this.children = options.children ?? [];
    /** @type {Node | null} */
    this.parentElement = null;
    for (const child of this.children) child.parentElement = this;
    this.clicks = 0;
  }
  /** @param {string} name */
  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }
  getClientRects() {
    return this.laidOut ? [{}] : [];
  }
  getBoundingClientRect() {
    const [width, height] = this.size;
    return { width, height };
  }
  /** @returns {Node[]} */
  querySelectorAll() {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll()]);
  }
  click() {
    this.clicks += 1;
  }
}

/**
 * Run `bookmarkInPage(press, SERIES)` over a page at `path` (the drama's own by default) that holds
 * `buttons` for the selector (and computes colours, `fill-opacity`, `visibility`, `opacity`,
 * `overflow` and `display` from the nodes themselves).
 * @param {Node[]} buttons
 * @param {boolean} press
 * @param {string} [path] the page's `location.pathname`
 */
function readPage(buttons, press, path = `/shortdrama/episode/${SERIES}/1`) {
  /** @type {string[]} */
  const selectors = [];
  Object.assign(globalThis, {
    location: { pathname: path },
    document: {
      querySelectorAll: (/** @type {string} */ selector) => {
        selectors.push(selector);
        return buttons;
      },
    },
    getComputedStyle: (/** @type {Node} */ node) => ({
      color: node.color,
      visibility: node.visibility,
      opacity: node.opacity,
      overflow: node.overflow,
      display: node.display,
      getPropertyValue: (/** @type {string} */ name) => (name === "fill" ? node.fill : name === "fill-opacity" ? node.fillOpacity : ""),
    }),
  });
  try {
    return { state: bookmarkInPage(press, SERIES), selectors };
  } finally {
    Reflect.deleteProperty(globalThis, "location");
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "getComputedStyle");
  }
}

/** TikTok's Bookmark as the owner captured it: the button and its svg, yellow when saved. @param {boolean} saved */
const bookmarkButton = (saved) =>
  new Node({ role: "button", "data-e2e": "favorite-icon", "data-key-interaction": "action_favorite", "aria-label": "Add to Favorites. 7057 added to Favorites" }, {
    children: [new Node(saved ? { color: BOOKMARK_SAVED_COLOR } : { color: "currentColor" }, { children: [new Node({ d: "M6 3h12v18l-6-4-6 4z" })] })],
  });

test("the reader: TikTok's Bookmark by its selector — saved when it or a descendant is #FACE15 as Chrome computes it (an svg's attribute, any letter case, through its computed colour; a computed rgb / rgba), unsaved otherwise, missing without one laid out, several never pressed; with press, one click and only on a saved button", () => {
  assert.equal(BOOKMARK_SELECTOR, 'div[role="button"][data-e2e="favorite-icon"][data-key-interaction="action_favorite"]');
  // the function runs in the page, serialised: it carries the selector itself
  assert.ok(bookmarkInPage.toString().includes(BOOKMARK_SELECTOR));
  const saved = bookmarkButton(true);
  const read = readPage([saved], false);
  assert.equal(read.state, "saved");
  assert.deepEqual(read.selectors, [BOOKMARK_SELECTOR]);
  assert.equal(saved.clicks, 0); // reading never clicks
  assert.equal(readPage([bookmarkButton(false)], false).state, "unsaved");
  // letter case and `fill` (an svg's attribute, through the colour Chrome computes for it), a computed colour (rgb / rgba)
  assert.equal(readPage([new Node({}, { children: [new Node({ fill: "#face15" })] })], false).state, "saved");
  assert.equal(readPage([new Node({}, { color: "rgb(250, 206, 21)" })], false).state, "saved");
  assert.equal(readPage([new Node({}, { children: [new Node({}, { fill: "rgba(250,206,21,1)" })] })], false).state, "saved");
  assert.equal(readPage([new Node({}, { color: "rgb(250, 206, 20)" })], false).state, "unsaved");
  // none, or none laid out: missing; two laid out: several (which one is the drama's cannot be told)
  assert.equal(readPage([], false).state, "missing");
  assert.equal(readPage([new Node({}, { laidOut: false, color: "#FACE15" })], false).state, "missing");
  const first = bookmarkButton(true);
  const second = bookmarkButton(true);
  assert.equal(readPage([first, second], true).state, "several");
  assert.equal(first.clicks + second.clicks, 0);
  assert.equal(readPage([new Node({}, { laidOut: false }), bookmarkButton(true)], false).state, "saved"); // a hidden copy aside
  // press: a saved button clicked once; an unsaved one never (that would ADD the drama)
  const pressed = bookmarkButton(true);
  assert.equal(readPage([pressed], true).state, "clicked");
  assert.equal(pressed.clicks, 1);
  const off = bookmarkButton(false);
  assert.equal(readPage([off], true).state, "unsaved");
  assert.equal(off.clicks, 0);
});

test("the reader: only on the confirmed drama's own page — a page TikTok sent the tab to instead (another drama, the feed, the login page), or an id that merely starts like it, is missing: never read, never pressed", () => {
  for (const path of [`/shortdrama/episode/7712345678901234999/1`, "/foryou", "/login", `/shortdrama/episode/${SERIES}9/1`, "/"]) {
    const saved = bookmarkButton(true);
    const read = readPage([saved], true, path);
    assert.equal(read.state, "missing", path);
    assert.deepEqual(read.selectors, [], path); // the page is not even looked at
    assert.equal(saved.clicks, 0, path);
  }
  // the drama's page under any episode, with or without a trailing slash
  for (const path of [`/shortdrama/episode/${SERIES}/7`, `/shortdrama/episode/${SERIES}`, `/shortdrama/episode/${SERIES}/1/`]) {
    assert.equal(readPage([bookmarkButton(true)], false, path).state, "saved", path);
  }
});

test("the reader: a yellow hidden in one of the ways it checks never reads saved — a descendant not laid out (an ancestor with display: none), one whose visibility is hidden or collapse, one inside a wrapper of opacity 0, the button itself transparent, one scaled or sized to nothing, one a wrapper clips to an empty box (a 0-size svg too), a yellow fill of fill-opacity 0 — so press never clicks such a button that would ADD the drama; a yellow the page draws still reads saved, next to a hidden one, in a display: contents wrapper or a plain inline one too", () => {
  /**
   * TikTok's Bookmark showing OFF (its svg white), holding `variant` too — a yellow icon for the
   * other state, say —, the button's own `opacity` from `options`.
   * @param {Node} variant
   * @param {{opacity?: string}} [options]
   */
  const holding = (variant, options = {}) =>
    new Node(
      { role: "button", "data-e2e": "favorite-icon", "data-key-interaction": "action_favorite", "aria-label": "Add to Favorites. 7057 added to Favorites" },
      { ...options, children: [new Node({ color: "currentColor" }, { children: [new Node({ d: "M6 3h12v18l-6-4-6 4z" })] }), variant] },
    );
  /** @type {[string, () => Node][]} */
  const undrawn = [
    ["not laid out", () => holding(new Node({ color: BOOKMARK_SAVED_COLOR }, { laidOut: false }))],
    ["visibility hidden", () => holding(new Node({ color: BOOKMARK_SAVED_COLOR }, { visibility: "hidden" }))],
    ["visibility collapse (a computed yellow)", () => holding(new Node({}, { color: "rgb(250, 206, 21)", visibility: "collapse" }))],
    ["inside a wrapper of opacity 0", () => holding(new Node({}, { opacity: "0", children: [new Node({}, { children: [new Node({ fill: "#FACE15" })] })] }))],
    ["the button itself transparent", () => holding(new Node({ color: BOOKMARK_SAVED_COLOR }), { opacity: "0" })],
    // laid out, visible, opaque — and still drawing nothing (Chrome 153: one client rect each)
    ["scaled to nothing (a scale(0) wrapper, an SVG matrix(0…) layer): a 0×0 box", () => holding(new Node({ color: BOOKMARK_SAVED_COLOR }, { size: [0, 0] }))],
    ["scaled to nothing on one axis (scaleY(0))", () => holding(new Node({ color: BOOKMARK_SAVED_COLOR }, { size: [24, 0] }))],
    [
      "inside a wrapper that clips to an empty box (width: 0; height: 0; overflow: hidden)",
      () => holding(new Node({}, { display: "inline-block", overflow: "hidden", size: [0, 0], children: [new Node({ color: BOOKMARK_SAVED_COLOR })] })),
    ],
    [
      "a 0-size svg (it clips; its path keeps a box of its own)",
      () => holding(new Node({ color: BOOKMARK_SAVED_COLOR, width: "0", height: "0" }, { svg: true, display: "inline", overflow: "hidden", size: [0, 0], children: [new Node({}, { svg: true, display: "inline", fill: "rgb(250, 206, 21)", size: [12, 18] })] })),
    ],
    ["a yellow fill of fill-opacity 0", () => holding(new Node({ fill: "#FACE15" }, { fillOpacity: "0" }))],
  ];
  for (const [why, make] of undrawn) {
    assert.equal(readPage([make()], false).state, "unsaved", why);
    const button = make();
    assert.equal(readPage([button], true).state, "unsaved", why); // answered without a click
    assert.equal(button.clicks, 0, why); // that click would ADD the drama
  }
  // a yellow the page draws: saved, alone or next to a hidden variant — and pressed once
  for (const [why, button] of /** @type {[string, Node][]} */ ([
    ["drawn", holding(new Node({ color: BOOKMARK_SAVED_COLOR }))],
    ["drawn, half transparent", holding(new Node({ color: BOOKMARK_SAVED_COLOR }, { opacity: "0.5" }))],
    ["drawn, next to a hidden one", holding(new Node({}, { children: [new Node({ color: BOOKMARK_SAVED_COLOR }, { visibility: "hidden" }), new Node({ fill: "#face15" })] }))],
    // a wrapper with no box of its own clips nothing; overflow does not apply to a plain inline element
    ["drawn, in a display: contents wrapper with overflow hidden", holding(new Node({}, { display: "contents", overflow: "hidden", laidOut: false, children: [new Node({ color: BOOKMARK_SAVED_COLOR })] }))],
    ["drawn, in an inline wrapper with overflow hidden and a 24×0 box", holding(new Node({}, { display: "inline", overflow: "hidden", size: [24, 0], children: [new Node({ color: BOOKMARK_SAVED_COLOR })] }))],
    ["drawn, in a wrapper of its size with overflow hidden", holding(new Node({}, { display: "inline-block", overflow: "hidden", children: [new Node({ color: BOOKMARK_SAVED_COLOR })] }))],
    ["drawn, a yellow fill of fill-opacity 0.6", holding(new Node({ fill: "#FACE15" }, { fillOpacity: "0.6" }))],
  ])) {
    assert.equal(readPage([button], false).state, "saved", why);
    assert.equal(readPage([button], true).state, "clicked", why);
    assert.equal(button.clicks, 1, why);
  }
});

test("the reader: an attribute #FACE15 Chrome does not draw yellow never reads saved — an svg's color attribute a class draws white, a path's fill attribute a style overrides, a color attribute on an HTML element (where it does nothing) —: the colour Chrome computes decides, so press never clicks such a button that would ADD the drama; the owner's capture still reads saved through it", () => {
  /**
   * TikTok's Bookmark showing OFF, its icon `icon`.
   * @param {Node} icon
   */
  const showing = (icon) => new Node({ role: "button", "data-e2e": "favorite-icon", "data-key-interaction": "action_favorite", "aria-label": "Add to Favorites. 7057 added to Favorites" }, { children: [icon] });
  const path = () => new Node({ d: "M6 3h12v18l-6-4-6 4z" }, { svg: true, display: "inline" });
  /** @type {[string, () => Node][]} */
  const undrawn = [
    ["an svg whose color attribute a class draws white", () => showing(new Node({ color: BOOKMARK_SAVED_COLOR }, { svg: true, display: "inline", color: "rgba(255, 255, 255, 0.9)", fill: "rgba(255, 255, 255, 0.9)", children: [path()] }))],
    ["a path whose fill attribute a style overrides", () => showing(new Node({}, { svg: true, display: "inline", children: [new Node({ fill: BOOKMARK_SAVED_COLOR, d: "M6 3h12v18l-6-4-6 4z" }, { svg: true, display: "inline", fill: "rgb(255, 255, 255)" })] }))],
    ["a color attribute on an HTML element, around a white icon", () => showing(new Node({ color: BOOKMARK_SAVED_COLOR }, { html: true, display: "inline", children: [new Node({}, { svg: true, display: "inline", children: [path()] })] }))],
  ];
  for (const [why, make] of undrawn) {
    assert.equal(readPage([make()], false).state, "unsaved", why);
    const button = make();
    assert.equal(readPage([button], true).state, "unsaved", why); // answered without a click
    assert.equal(button.clicks, 0, why); // that click would ADD the drama
  }
  // the owner's capture — `color="#FACE15"` on the svg, no style over it —: Chrome computes it yellow
  const saved = bookmarkButton(true);
  assert.equal(readPage([saved], true).state, "clicked");
  assert.equal(saved.clicks, 1);
});

test("the page's own Bookmark request: a path ending in /collect/, nothing else read of it", () => {
  assert.equal(isCollectUrl(COLLECT), true);
  assert.equal(isCollectUrl(`${BASE}/api/item/collect?aid=1988`), true);
  assert.equal(isCollectUrl(`${BASE}/api/item/detail/?from=collect/`), false); // `collect` in the query only
  assert.equal(isCollectUrl(`${BASE}/api/collection/list/`), false);
  assert.equal(isCollectUrl(`${BASE}/api/user/favorite/drama_list/?cursor=0`), false);
});

// ------------------------------------------------------------ the removal, over a fake chrome

/**
 * @typedef {object} Site What the fake TikTok does with the drama's page.
 * @property {boolean} saved the drama in the user's Bookmark (TikTok's record)
 * @property {number} [buttons] Bookmark buttons on the page (1)
 * @property {number} [readyAfter] readings before the button shows (1)
 * @property {"unsaved" | null} [firstLook] what the very first reading of each document says before the real state (a page drawn before it knows)
 * @property {number} [collectStatus] the answer to the page's `collect` request (200)
 * @property {number} [collectLate] the answer to the page's `collect` request, coming late: reported
 *   during the first reading after the click — when the button already reads off (a page that draws
 *   it off at once), or still on —, in place of {@link Site.collectStatus}
 * @property {number} [collectHeld] the answer to the page's `collect` request, held back until the
 *   test lets it come (`release()`), in place of {@link Site.collectStatus}; a reload of the page
 *   cuts the request short first (Chrome's `onErrorOccurred`: status 0)
 * @property {boolean} [keeps] whether TikTok keeps a click's change (true)
 * @property {boolean} [reacts] whether the button turns off after the click (true)
 * @property {boolean} [login] the page redirects to TikTok's login page
 * @property {string} [elsewhere] the address TikTok sends the tab to instead of the drama's page
 *   (another page that may show a Bookmark of its own)
 * @property {boolean} [captcha] the page shows TikTok's verification wall
 * @property {number} [staleAfterReload] readings after the reload that still come from the page before it
 * @property {number} [buttonsAfterReload] Bookmark buttons on the page once reloaded ({@link Site.buttons})
 * @property {{at: "load" | "click" | "reload", status: number}} [listStatus] the page's own
 *   episode-list request answered `status` — as the page loads, right after the click, or as it
 *   reloads (its other loads answer it 200)
 * @property {(event: string) => void} [on] called with every event (a test may act on one)
 */

/**
 * A fake `chrome` around one TikTok tab: `tabs` (create, update, get, remove — the tab muted,
 * navigated, read, closed), `storage.session` (the discovery tab's record), `webRequest` (the
 * page's own `collect` request reported to the observers) and `scripting.executeScript` (the
 * reader in the ISOLATED world: its answer from the site's state, stamped with the document;
 * the page's text). `log` records every step in order.
 * @param {Site} site
 */
function fakeChrome(site) {
  /** @type {string[]} */
  const log = [];
  const say = (/** @type {string} */ event) => {
    log.push(event);
    site.on?.(event);
  };
  /** @type {Map<string, unknown>} */
  const session = new Map();
  /** @type {{completed: ((details: chrome.webRequest.CompletedDetails) => void)[], failed: ((details: chrome.webRequest.ErrorDetails) => void)[], filters: chrome.webRequest.RequestFilter[]}} */
  const listeners = { completed: [], failed: [], filters: [] };
  const state = {
    open: false,
    url: "",
    document: 0,
    readings: 0, // of the current document
    shown: /** @type {"saved" | "unsaved"} */ ("saved"),
    stale: 0,
    clicks: 0,
    /** @type {number | null} the page's `collect` answer still to come ({@link Site.collectLate}) */
    late: /** @type {number | null} */ (null),
    /** @type {number | null} the page's `collect` answer held back ({@link Site.collectHeld}) */
    held: /** @type {number | null} */ (null),
  };
  /**
   * One of the page's own requests answered: reported to the observers.
   * @param {string} url
   * @param {number} statusCode
   */
  const report = (url, statusCode) => {
    for (const listener of listeners.completed) {
      listener({ requestId: "9", url, method: "GET", tabId: TAB, type: "xmlhttprequest", timeStamp: 0, statusCode, fromCache: false });
    }
  };
  /** @param {number} statusCode the page's own `collect` request answered */
  const answer = (statusCode) => report(COLLECT, statusCode);
  /** @param {"load" | "click" | "reload"} at the page's own episode list, answered as it is at that moment */
  const list = (at) => {
    if (site.listStatus !== undefined) report(ITEM_LIST, site.listStatus.at === at ? site.listStatus.status : 200);
  };
  /** The held `collect` answer comes now (TikTok answered late). */
  const release = () => {
    if (state.held === null) return;
    const status = state.held;
    state.held = null;
    answer(status);
  };
  const chrome = {
    tabs: {
      create: async (/** @type {chrome.tabs.CreateProperties} */ properties) => {
        say(`open ${properties.url} active=${String(properties.active)}`);
        state.open = true;
        state.url = "about:blank";
        return { id: TAB, index: 1, windowId: 1, active: false, status: "complete" };
      },
      update: async (/** @type {number} */ tabId, /** @type {chrome.tabs.UpdateProperties} */ properties) => {
        assert.equal(tabId, TAB);
        if (!state.open) throw new Error(`No tab with id: ${tabId}.`); // as Chrome answers for a closed tab
        if (properties.muted !== undefined) say(`muted ${String(properties.muted)}`);
        if (properties.url !== undefined) {
          say(`navigate ${properties.url}`);
          if (state.held !== null) {
            // the page unloads: its request still in flight is cut short (onErrorOccurred), its answer never seen
            state.held = null;
            for (const listener of listeners.failed) {
              listener({ requestId: "9", url: COLLECT, method: "GET", tabId: TAB, type: "xmlhttprequest", timeStamp: 0, error: "net::ERR_ABORTED", fromCache: false });
            }
          }
          state.stale = state.document > 0 ? (site.staleAfterReload ?? 0) : 0;
          state.document += 1;
          state.readings = 0;
          state.url = site.login ? `${BASE}/login?redirect_url=%2Fshortdrama` : (site.elsewhere ?? properties.url);
          state.shown = site.saved ? "saved" : "unsaved";
          list(state.document === 1 ? "load" : "reload");
        }
        return { id: tabId, index: 1, windowId: 1, active: false };
      },
      get: async (/** @type {number} */ tabId) => {
        assert.equal(tabId, TAB);
        if (!state.open) throw new Error(`No tab with id: ${tabId}.`);
        return { id: tabId, index: 1, windowId: 1, active: false, status: "complete", url: state.url };
      },
      remove: async (/** @type {number} */ tabId) => {
        assert.equal(tabId, TAB);
        say("close");
        state.open = false;
      },
    },
    storage: {
      session: {
        get: async (/** @type {string} */ key) => (session.has(key) ? { [key]: session.get(key) } : {}),
        set: async (/** @type {Record<string, unknown>} */ items) => {
          for (const [key, value] of Object.entries(items)) session.set(key, value);
        },
        remove: async (/** @type {string} */ key) => void session.delete(key),
      },
    },
    webRequest: {
      onCompleted: {
        addListener: (/** @type {(details: chrome.webRequest.CompletedDetails) => void} */ listener, /** @type {chrome.webRequest.RequestFilter} */ filter) => {
          listeners.completed.push(listener);
          listeners.filters.push(filter);
        },
        removeListener: (/** @type {(details: chrome.webRequest.CompletedDetails) => void} */ listener) => {
          listeners.completed = listeners.completed.filter((known) => known !== listener);
          say("unobserve");
        },
      },
      onErrorOccurred: {
        addListener: (/** @type {(details: chrome.webRequest.ErrorDetails) => void} */ listener) => void listeners.failed.push(listener),
        removeListener: (/** @type {(details: chrome.webRequest.ErrorDetails) => void} */ listener) => {
          listeners.failed = listeners.failed.filter((known) => known !== listener);
        },
      },
    },
    scripting: {
      executeScript: async (/** @type {chrome.scripting.ScriptInjection<unknown[], unknown>} */ injection) => {
        assert.deepEqual(injection.target, { tabId: TAB });
        if (!state.open) throw new Error(`No tab with id: ${TAB}.`);
        assert.equal(injection.world, undefined); // the ISOLATED world: never the page's own
        if (injection.func === pageTextInPage) return [{ frameId: 0, result: site.captcha ? "Security check\nVerify to continue" : "A drama\nEpisode 1" }];
        assert.equal(injection.func, bookmarkInPage);
        const [press, seriesId] = /** @type {[boolean, string]} */ (injection.args);
        assert.equal(seriesId, SERIES); // the reader is told which drama's page alone counts
        // as the reader does in the page: not the drama's page (blank, the login page, elsewhere) → missing
        if (!new URL(state.url).pathname.split("/").includes(seriesId)) return [{ frameId: 0, documentId: `doc${state.document}`, result: "missing" }];
        if (state.stale > 0) {
          state.stale -= 1; // an answer of the page before the reload
          return [{ frameId: 0, documentId: `doc${state.document - 1}`, result: "unsaved" }];
        }
        state.readings += 1;
        const documentId = `doc${state.document}`;
        const buttons = state.document > 1 && site.buttonsAfterReload !== undefined ? site.buttonsAfterReload : (site.buttons ?? 1);
        if (state.readings <= (site.readyAfter ?? 1) - 1) return [{ frameId: 0, documentId, result: "missing" }];
        if (buttons === 0) return [{ frameId: 0, documentId, result: "missing" }];
        if (buttons > 1) return [{ frameId: 0, documentId, result: "several" }];
        if (site.firstLook === "unsaved" && state.readings === (site.readyAfter ?? 1)) return [{ frameId: 0, documentId, result: "unsaved" }];
        if (!press) {
          say(`read ${state.shown}`);
          if (state.late !== null) {
            answer(state.late); // TikTok's answer comes only now
            state.late = null;
          }
          return [{ frameId: 0, documentId, result: state.shown }];
        }
        if (state.shown !== "saved") return [{ frameId: 0, documentId, result: state.shown }];
        state.clicks += 1;
        say("click");
        // the page's own handler: its request (reported to webRequest), the button drawn off
        const status = site.collectHeld ?? site.collectLate ?? site.collectStatus ?? 200;
        if (site.collectHeld !== undefined) state.held = site.collectHeld;
        else if (site.collectLate === undefined) answer(status);
        else state.late = site.collectLate;
        if (status === 200 && site.keeps !== false) site.saved = false;
        if (site.reacts !== false) state.shown = "unsaved";
        list("click");
        return [{ frameId: 0, documentId, result: "clicked" }];
      },
    },
  };
  Object.assign(globalThis, { chrome });
  return { log, state, session, listeners, report, release, restore: () => Reflect.deleteProperty(globalThis, "chrome") };
}

/**
 * The job's engine as the removal uses it: the injected sleep (logged, the clock moved on by it,
 * never slept), the rng at its floor, an in-memory cooldown read through `cooldownStore`, Stop.
 * @param {string[]} log
 */
function fakeEngine(log) {
  /** @type {Record<string, unknown> | undefined} */
  let cooldown;
  let now = 1_800_000_000;
  let stop = false;
  /** @type {import("../src/app/engine.js").Engine} */
  const engine = /** @type {import("../src/app/engine.js").Engine} */ (
    /** @type {unknown} */ ({
      pacing: pacingOptions(),
      testMode: false,
      includeLocked: false,
      recheck: false,
      pacingState: new PacingState(),
      rng: { uniform: (/** @type {number} */ low) => low },
      sleep: async (/** @type {number} */ seconds) => {
        log.push(`sleep ${seconds}`);
        now += seconds;
        if (stop) throw new StopRequested();
      },
      clock: () => now,
      wallClock: () => now,
      cooldownStore: {
        read: () => {
          log.push("cooldown?");
          return cooldown;
        },
        write: (/** @type {Record<string, unknown>} */ written) => {
          cooldown = written;
        },
      },
      stopRequested: () => stop,
    })
  );
  return {
    engine,
    getCooldown: () => cooldown,
    stop: () => {
      stop = true;
    },
  };
}

/**
 * Remove `SERIES` against `site` with the real browser seam (`bookmarkBrowser` over the fake chrome).
 * @param {Site} site
 * @param {{timeoutS?: number, waitS?: number, onPressed?: () => void, engineSetup?: (fake: ReturnType<typeof fakeEngine>, chrome: ReturnType<typeof fakeChrome>) => void}} [options]
 */
async function remove(site, options = {}) {
  const chrome = fakeChrome(site);
  const fake = fakeEngine(chrome.log);
  options.engineSetup?.(fake, chrome);
  /** @type {import("../src/app/bookmark.js").BookmarkOptions} */
  const given = { baseUrl: BASE, appTabId: APP_TAB, windowId: 1 };
  if (options.timeoutS !== undefined) given.timeoutS = options.timeoutS;
  if (options.waitS !== undefined) given.waitS = options.waitS;
  if (options.onPressed !== undefined) given.onPressed = options.onPressed;
  try {
    const outcome = await removeFromBookmark(fake.engine, SERIES, given).then(
      (value) => ({ value, error: null }),
      (/** @type {unknown} */ error) => ({ value: null, error }),
    );
    return { ...outcome, chrome, fake };
  } finally {
    chrome.restore();
  }
}

/** The log's entries that are steps (not the polling's reads and sleeps). @param {string[]} log */
const steps = (log) => log.filter((entry) => !entry.startsWith("read ") && entry !== `sleep ${POLL_S}` && entry !== "cooldown?");

test("removed: the drama's page in a muted background tab, the Bookmark read saved (twice, steady), the pause and the cooldown, ONE click, the button off, the pause and the cooldown, the page reloaded and read off from its new document; the tab closed", async () => {
  let pressed = 0;
  /** @type {Promise<Record<string, unknown>> | null} the worker's record of the tab, read while it is open */
  let recorded = null;
  const site = {
    saved: true,
    on: (/** @type {string} */ event) => {
      if (event === "read saved" && recorded === null) recorded = globalThis.chrome.storage.session.get(DISCOVERY_TAB_KEY);
    },
  };
  const { value, error, chrome } = await remove(site, { onPressed: () => void (pressed += 1) });
  assert.equal(error, null);
  assert.deepEqual(value, { outcome: "removed" });
  assert.equal(chrome.state.clicks, 1);
  assert.equal(pressed, 1);
  assert.deepEqual(steps(chrome.log), [
    "open about:blank active=false",
    "muted true",
    `navigate ${PAGE}`,
    "sleep 0.8", // the list-page pause before the click …
    "click",
    "sleep 0.8", // … and before the reload
    `navigate ${PAGE}`,
    "unobserve",
    "close",
  ]);
  // the cooldown asked right before the click and right before the reload, after each pause
  const pauses = chrome.log.flatMap((entry, index) => (entry === "sleep 0.8" ? [chrome.log[index + 1]] : []));
  assert.deepEqual(pauses, ["cooldown?", "cooldown?"]);
  // the state read twice before the click (a steady reading), and after the reload
  assert.deepEqual(chrome.log.filter((entry) => entry.startsWith("read ")), ["read saved", "read saved", "read unsaved", "read unsaved", "read unsaved"]);
  // the page's requests observed on that tab only, xmlhttprequest, never blocking
  assert.deepEqual(chrome.listeners.filters, [{ urls: [`${BASE}/*`, "https://*.tiktok.com/*"], tabId: TAB, types: ["xmlhttprequest"] }]);
  // the tab recorded for the worker while open (its DramaFetch tab with it), forgotten once closed
  assert.deepEqual(await recorded, { [DISCOVERY_TAB_KEY]: { tabId: TAB, appTabId: APP_TAB } });
  assert.equal(chrome.session.has(DISCOVERY_TAB_KEY), false);
});

test("a page drawn before it knows (unsaved, then saved) is read until two readings agree: saved — then pressed once", async () => {
  const { value, chrome } = await remove({ saved: true, readyAfter: 2, firstLook: "unsaved" });
  assert.deepEqual(value, { outcome: "removed" });
  assert.equal(chrome.state.clicks, 1);
});

test("already removed: the page shows the Bookmark as off — nothing pressed, no pause for a click, the tab closed", async () => {
  const { value, chrome } = await remove({ saved: false });
  assert.deepEqual(value, { outcome: "already" });
  assert.equal(chrome.state.clicks, 0);
  assert.deepEqual(steps(chrome.log), ["open about:blank active=false", "muted true", `navigate ${PAGE}`, "unobserve", "close"]);
});

test("TikTok sends the tab to another page than the drama's (one with a saved Bookmark of its own): never read as the drama's, nothing pressed — bookmark-missing, the tab closed", async () => {
  const { error, chrome } = await remove({ saved: true, elsewhere: `${BASE}/@someone/video/7600000000000000001` }, { timeoutS: 5 });
  assert.ok(error instanceof BookmarkError);
  assert.equal(error.kind, "bookmark-missing");
  assert.equal(chrome.state.clicks, 0);
  assert.equal(chrome.log.includes("click"), false);
  assert.equal(chrome.log.at(-1), "close");
});

test("no Bookmark button within the wait, or more than one: bookmark-missing — nothing pressed, the tab closed", async () => {
  for (const buttons of [0, 2]) {
    const { error, chrome } = await remove({ saved: true, buttons }, { timeoutS: 5 });
    assert.ok(error instanceof BookmarkError, String(buttons));
    assert.equal(error.kind, "bookmark-missing");
    assert.equal(error.message, BOOKMARK_MESSAGES["bookmark-missing"]);
    assert.equal(chrome.state.clicks, 0);
    assert.equal(chrome.log.at(-1), "close");
    // looked at every second until the wait ended
    assert.equal(chrome.log.filter((entry) => entry === `sleep ${POLL_S}`).length, 5);
  }
  assert.equal(DISCOVERY_TIMEOUT_S, 45); // the default wait: the discovery's
});

test("the button does not turn off after the one click within 15 s: not-confirmed — never a second click", async () => {
  assert.equal(CHANGE_WAIT_S, 15);
  const { error, chrome } = await remove({ saved: true, reacts: false, keeps: false });
  assert.ok(error instanceof BookmarkError);
  assert.equal(error.kind, "not-confirmed");
  assert.equal(chrome.state.clicks, 1);
  const afterClick = chrome.log.slice(chrome.log.indexOf("click"));
  assert.equal(afterClick.filter((entry) => entry === `sleep ${POLL_S}`).length, 15); // 15 s of looking, one a second
  assert.ok(!afterClick.includes("navigate " + PAGE)); // no reload: nothing to check it by
  assert.equal(chrome.log.at(-1), "close");
});

test("TikTok does not keep the change: the reloaded page shows the drama saved again — not-kept, one click", async () => {
  const { error, chrome } = await remove({ saved: true, keeps: false });
  assert.ok(error instanceof BookmarkError);
  assert.equal(error.kind, "not-kept");
  assert.equal(error.message, "TikTok did not keep the change: the drama is still in your Favorites — remove it on TikTok yourself");
  assert.equal(chrome.state.clicks, 1);
  assert.equal(chrome.log.at(-1), "close");
});

test("after the reload, an answer of the page BEFORE it never counts: the old document says off, the new one says saved — not-kept, never removed", async () => {
  const { error, chrome } = await remove({ saved: true, keeps: false, staleAfterReload: 3 });
  assert.ok(error instanceof BookmarkError);
  assert.equal(error.kind, "not-kept");
  assert.equal(chrome.state.clicks, 1);
});

test("TikTok refuses the page's own collect request — 429 or 403 —: a stop with the 30-minute cooldown recorded with its reason; the tab closed", async () => {
  for (const [status, kind, message] of /** @type {[number, Function, string][]} */ ([
    [429, RateLimitedError, BOOKMARK_RATE_LIMIT_MESSAGE],
    [403, BookmarkRefusedError, BLOCKED_MESSAGE],
  ])) {
    const { error, chrome, fake } = await remove({ saved: true, collectStatus: status });
    assert.ok(error instanceof kind, String(status));
    assert.equal(/** @type {Error} */ (error).message, message);
    const cooldown = /** @type {Record<string, unknown>} */ (fake.getCooldown());
    assert.equal(cooldown["reason"], message);
    assert.equal(cooldown["source"], "discovery");
    assert.equal(chrome.state.clicks, 1);
    assert.equal(chrome.log.at(-1), "close");
  }
});

test("TikTok's answer to the page's collect request coming late — once the button already reads off (a page that draws it off at once), or during the wait's last look —: its 429 or 403 still decides — a stop with the cooldown, and no reload after it", async () => {
  for (const [status, kind, message] of /** @type {[number, Function, string][]} */ ([
    [429, RateLimitedError, BOOKMARK_RATE_LIMIT_MESSAGE],
    [403, BookmarkRefusedError, BLOCKED_MESSAGE],
  ])) {
    const { error, chrome, fake } = await remove({ saved: true, collectLate: status });
    assert.ok(error instanceof kind, String(status));
    assert.equal(/** @type {Error} */ (error).message, message);
    const cooldown = /** @type {Record<string, unknown>} */ (fake.getCooldown());
    assert.equal(cooldown["reason"], message);
    assert.equal(cooldown["source"], "discovery");
    assert.equal(chrome.state.clicks, 1);
    // the drama's page loaded once: no reload — no request at all — after TikTok refused
    assert.equal(chrome.log.filter((entry) => entry.startsWith("navigate ")).length, 1, String(status));
    assert.equal(chrome.log.at(-1), "close");
  }
  // the button never turns off and TikTok's 429 comes during the wait's last look: not-confirmed
  // would hide it — the refusal is the outcome, with the cooldown
  const late = await remove({ saved: true, reacts: false, collectLate: 429 }, { waitS: 0 });
  assert.ok(late.error instanceof RateLimitedError);
  assert.equal(/** @type {Record<string, unknown>} */ (late.fake.getCooldown())["reason"], BOOKMARK_RATE_LIMIT_MESSAGE);
  assert.equal(late.chrome.state.clicks, 1);
  assert.equal(late.chrome.log.at(-1), "close");
});

test("the page draws the button off at once and TikTok's answer to its collect comes seconds later: the wait goes on until it comes — the reload would cut the request short —, so its 429 is the outcome with the cooldown and no reload; an answer never seen ends the wait after 15 s, and the reload checks", async () => {
  /** Let the held answer come once `seconds` of pauses have passed since the click. @param {number} seconds */
  const after = (seconds) => (/** @type {ReturnType<typeof fakeEngine>} */ fake, /** @type {ReturnType<typeof fakeChrome>} */ chromeTab) => {
    const sleep = fake.engine.sleep;
    let waited = 0;
    fake.engine.sleep = async (pause) => {
      await sleep(pause);
      if (chromeTab.state.clicks === 0) return;
      waited += pause;
      if (waited >= seconds) chromeTab.release();
    };
  };
  const late = await remove({ saved: true, collectHeld: 429 }, { engineSetup: after(2) });
  assert.ok(late.error instanceof RateLimitedError);
  assert.equal(late.error.message, BOOKMARK_RATE_LIMIT_MESSAGE);
  assert.equal(/** @type {Record<string, unknown>} */ (late.fake.getCooldown())["reason"], BOOKMARK_RATE_LIMIT_MESSAGE);
  assert.equal(late.chrome.state.clicks, 1);
  assert.equal(late.chrome.log.filter((entry) => entry.startsWith("navigate ")).length, 1); // no reload: no request after the refusal
  assert.equal(late.chrome.log.at(-1), "close");
  // TikTok's answer never seen (not observable, say): the wait ends as it did, then the reload checks
  const unseen = await remove({ saved: true, collectHeld: 200 });
  assert.deepEqual(unseen.value, { outcome: "removed" });
  const afterClick = unseen.chrome.log.slice(unseen.chrome.log.indexOf("click"), unseen.chrome.log.lastIndexOf(`navigate ${PAGE}`));
  assert.equal(afterClick.filter((entry) => entry === `sleep ${POLL_S}`).length, CHANGE_WAIT_S);
  assert.equal(unseen.chrome.state.clicks, 1);
});

test("the drama page's OWN episode list answered HTTP 429 — the discovery's rule —: before the click, a stop with the cooldown and nothing pressed (no button drawn yet, none at all, or the 429 during the pause before the click); after it, the outcome stands with the cooldown recorded — removed carries it as the job's stop, not-kept stays not-kept, and a 429 before the reload means no reload", async () => {
  for (const site of /** @type {Site[]} */ ([
    { saved: true, readyAfter: 3, listStatus: { at: "load", status: 429 } },
    { saved: true, buttons: 0, listStatus: { at: "load", status: 429 } },
  ])) {
    const { error, chrome, fake } = await remove(site, { timeoutS: 5 });
    assert.ok(error instanceof RateLimitedError);
    assert.equal(error.message, LIST_RATE_LIMIT_MESSAGE);
    const cooldown = /** @type {Record<string, unknown>} */ (fake.getCooldown());
    assert.equal(cooldown["reason"], LIST_RATE_LIMIT_MESSAGE);
    assert.equal(cooldown["source"], "discovery");
    assert.equal(chrome.state.clicks, 0);
    assert.equal(chrome.log.filter((entry) => entry === `sleep ${POLL_S}`).length, 0); // the first look stops it: no 45 s wait into it
    assert.equal(chrome.log.at(-1), "close");
  }
  // the 429 comes during the pause before the click: still nothing pressed
  const paused = await remove(
    { saved: true },
    {
      engineSetup: (fake, chromeTab) => {
        const sleep = fake.engine.sleep;
        fake.engine.sleep = async (seconds) => {
          if (seconds === 0.8 && chromeTab.state.clicks === 0) chromeTab.report(ITEM_LIST, 429);
          await sleep(seconds);
        };
      },
    },
  );
  assert.ok(paused.error instanceof RateLimitedError);
  assert.equal(paused.chrome.state.clicks, 0);
  assert.equal(/** @type {Record<string, unknown>} */ (paused.fake.getCooldown())["reason"], LIST_RATE_LIMIT_MESSAGE);
  // the reloaded page's list refused: the removal stands, the cooldown recorded, the job told to stop
  const reload = await remove({ saved: true, listStatus: { at: "reload", status: 429 } });
  assert.equal(reload.error, null);
  assert.deepEqual(reload.value, { outcome: "removed", refused: LIST_RATE_LIMIT_MESSAGE });
  assert.equal(/** @type {Record<string, unknown>} */ (reload.fake.getCooldown())["reason"], LIST_RATE_LIMIT_MESSAGE);
  assert.equal(reload.chrome.state.clicks, 1);
  assert.equal(reload.chrome.log.at(-1), "close");
  // not kept, and the reloaded page's list refused: not-kept, with the cooldown
  const kept = await remove({ saved: true, keeps: false, listStatus: { at: "reload", status: 429 } });
  assert.ok(kept.error instanceof BookmarkError);
  assert.equal(kept.error.kind, "not-kept");
  assert.equal(/** @type {Record<string, unknown>} */ (kept.fake.getCooldown())["reason"], LIST_RATE_LIMIT_MESSAGE);
  // refused between the click and the reload: no reload into it — pressed, nothing to check it by
  const click = await remove({ saved: true, listStatus: { at: "click", status: 429 } });
  assert.ok(click.error instanceof BookmarkError);
  assert.equal(click.error.kind, "not-confirmed");
  assert.equal(/** @type {Record<string, unknown>} */ (click.fake.getCooldown())["reason"], LIST_RATE_LIMIT_MESSAGE);
  assert.equal(click.chrome.log.filter((entry) => entry.startsWith("navigate ")).length, 1);
  assert.equal(click.chrome.state.clicks, 1);
  assert.equal(click.chrome.log.at(-1), "close");
  // the page's own list answered 200 every time: nothing of this
  const fine = await remove({ saved: true, listStatus: { at: "load", status: 200 } });
  assert.deepEqual(fine.value, { outcome: "removed" });
  assert.equal(fine.fake.getCooldown(), undefined);
});

test("pressed and seen off, then nothing to check it by — no single button on the reloaded page, the tab closed right after the reload, or before it (Chrome refuses the reload) —: not-confirmed, one click and never a second, the tab closed; a Stop after the click with TikTok's refusal already noted is that refusal, with the cooldown", async () => {
  const missing = await remove({ saved: true, buttonsAfterReload: 0 }, { timeoutS: 3 });
  assert.ok(missing.error instanceof BookmarkError);
  assert.equal(missing.error.kind, "not-confirmed");
  assert.equal(missing.error.message, BOOKMARK_MESSAGES["not-confirmed"]);
  assert.equal(missing.chrome.state.clicks, 1);
  assert.equal(missing.chrome.log.at(-1), "close");
  let navigations = 0;
  const closedAfter = await remove({
    saved: true,
    on: (event) => {
      if (event.startsWith("navigate ") && (navigations += 1) === 2) void globalThis.chrome.tabs.remove(TAB);
    },
  });
  assert.ok(closedAfter.error instanceof BookmarkError);
  assert.equal(closedAfter.error.kind, "not-confirmed");
  assert.equal(closedAfter.chrome.state.clicks, 1);
  const closedBefore = await remove(
    { saved: true },
    {
      engineSetup: (fake, chromeTab) => {
        const sleep = fake.engine.sleep;
        fake.engine.sleep = async (seconds) => {
          if (seconds === 0.8 && chromeTab.state.clicks > 0) await globalThis.chrome.tabs.remove(TAB);
          await sleep(seconds);
        };
      },
    },
  );
  assert.ok(closedBefore.error instanceof BookmarkError, String(closedBefore.error)); // never Chrome's own "No tab with id"
  assert.equal(closedBefore.error.kind, "not-confirmed");
  assert.equal(closedBefore.chrome.state.clicks, 1);
  assert.equal(closedBefore.chrome.log.filter((entry) => entry.startsWith("navigate ")).length, 1);
  // Stop after the click while TikTok's refusal of the page's collect was already noted: the refusal decides
  for (const [status, kind, message] of /** @type {[number, Function, string][]} */ ([
    [429, RateLimitedError, BOOKMARK_RATE_LIMIT_MESSAGE],
    [403, BookmarkRefusedError, BLOCKED_MESSAGE],
  ])) {
    const stopped = await remove(
      { saved: true, reacts: false, collectLate: status },
      {
        engineSetup: (fake, chromeTab) => {
          const sleep = fake.engine.sleep;
          fake.engine.sleep = async (seconds) => {
            if (chromeTab.state.clicks > 0) fake.stop();
            await sleep(seconds);
          };
        },
      },
    );
    assert.ok(stopped.error instanceof kind, String(status));
    assert.equal(/** @type {Error} */ (stopped.error).message, message);
    assert.equal(/** @type {Record<string, unknown>} */ (stopped.fake.getCooldown())["reason"], message);
    assert.equal(stopped.chrome.state.clicks, 1);
    assert.equal(stopped.chrome.log.at(-1), "close");
  }
});

test("TikTok's verification wall on the drama's page: a stop with the cooldown, nothing pressed; its login page: a stop without one", async () => {
  const walled = await remove({ saved: true, captcha: true });
  assert.ok(walled.error instanceof ChallengeError);
  assert.equal(walled.error.message, BOOKMARK_CHALLENGE_MESSAGE);
  assert.equal(/** @type {Record<string, unknown>} */ (walled.fake.getCooldown())["reason"], BOOKMARK_CHALLENGE_MESSAGE);
  assert.equal(walled.chrome.state.clicks, 0);
  assert.equal(walled.chrome.log.at(-1), "close");
  const login = await remove({ saved: true, login: true });
  assert.ok(login.error instanceof LoginRequiredError);
  assert.equal(login.error.message, LOGIN_REDIRECT_MESSAGE);
  assert.equal(login.fake.getCooldown(), undefined);
  assert.equal(login.chrome.state.clicks, 0);
  assert.equal(login.chrome.log.at(-1), "close");
});

test("a cooldown recorded meanwhile (another job's refusal) is met before the click: a stop, nothing pressed", async () => {
  const { error, chrome } = await remove(
    { saved: true },
    {
      engineSetup: (fake, fakeChromeTab) => {
        fakeChromeTab.log.push("armed");
        const sleep = fake.engine.sleep;
        fake.engine.sleep = async (seconds) => {
          if (seconds === 0.8) await recordBlock(fake.engine.cooldownStore, "rate limited (HTTP 429) by the video server", "browser", { now: fake.engine.wallClock() });
          await sleep(seconds);
        };
      },
    },
  );
  assert.ok(error instanceof BookmarkCooldown);
  assert.match(error.message, /^TikTok refused a request at /);
  assert.equal(chrome.state.clicks, 0);
  assert.equal(chrome.log.at(-1), "close");
});

test("Stop between two steps: before the click nothing is pressed; after it the caller knows it was pressed — the tab closed either way, never a second click", async () => {
  // Stop during the pause before the click
  const before = await remove(
    { saved: true },
    {
      engineSetup: (fake) => {
        const sleep = fake.engine.sleep;
        fake.engine.sleep = async (seconds) => {
          if (seconds === 0.8) fake.stop();
          await sleep(seconds);
        };
      },
    },
  );
  assert.ok(before.error instanceof StopRequested);
  assert.equal(before.chrome.state.clicks, 0);
  assert.equal(before.chrome.log.at(-1), "close");
  // Stop once it was pressed (while the button is watched)
  let pressed = false;
  const after = await remove(
    { saved: true, reacts: false },
    {
      onPressed: () => void (pressed = true),
      engineSetup: (fake, fakeChromeTab) => {
        const sleep = fake.engine.sleep;
        fake.engine.sleep = async (seconds) => {
          if (fakeChromeTab.state.clicks > 0) fake.stop();
          await sleep(seconds);
        };
      },
    },
  );
  assert.ok(after.error instanceof StopRequested);
  assert.equal(pressed, true);
  assert.equal(after.chrome.state.clicks, 1);
  assert.equal(after.chrome.log.at(-1), "close");
});

test("the tab DramaFetch opened, closed by hand before anything was pressed: tab-gone", async () => {
  const { error, chrome } = await remove({
    saved: true,
    on: (event) => {
      if (event === "read saved") globalThis.chrome.tabs.remove(TAB);
    },
  });
  assert.ok(error instanceof BookmarkError);
  assert.equal(error.kind, "tab-gone");
  assert.equal(chrome.state.clicks, 0);
});

test("TikTok's count after a removal: ONE request — the favorites tab's first page, its address replayed byte for byte, after the pause and the cooldown — its total, and whether the drama is still on it", async () => {
  const CAPTURE = JSON.parse(readFileSync(new URL("../../tests/fixtures/drama_list_page.json", import.meta.url), "utf8"));
  const template = `${BASE}/api/user/favorite/drama_list/?WebIdLastTime=1794300000&aid=1988&count=19&cursor=0&X-Bogus=DFSzswVOxQ`;
  for (const [page, still] of /** @type {[Record<string, unknown>, boolean][]} */ ([
    [{ ...CAPTURE, total: "945", dramaList: CAPTURE.dramaList.slice(1) }, false],
    [{ ...CAPTURE, total: "946" }, true],
  ])) {
    /** @type {string[]} */
    const log = [];
    Object.assign(globalThis, {
      chrome: {
        tabs: { get: async (/** @type {number} */ tabId) => ({ id: tabId, index: 0, windowId: 1, active: true, url: "https://www.tiktok.com/@invented_viewer" }) },
        scripting: {
          executeScript: async (/** @type {chrome.scripting.ScriptInjection<unknown[], unknown>} */ injection) => {
            assert.equal(injection.world, "MAIN"); // the page's own fetch
            assert.equal(injection.func, fetchInPage);
            const [url] = /** @type {[string]} */ (injection.args);
            log.push(`request ${url}`);
            return [{ frameId: 0, result: JSON.parse(JSON.stringify(page)) }];
          },
        },
      },
    });
    try {
      const fake = fakeEngine(log);
      const counted = await countAfterRemoval(fake.engine, 42, template, SERIES);
      assert.equal(counted.total, still ? 946 : 945);
      assert.equal(counted.stillListed, still);
      assert.deepEqual(log, ["sleep 0.8", "cooldown?", `request ${template}`]); // the pause, the cooldown, one request
      await clearCooldown(fake.engine.cooldownStore);
    } finally {
      Reflect.deleteProperty(globalThis, "chrome");
    }
  }
});
