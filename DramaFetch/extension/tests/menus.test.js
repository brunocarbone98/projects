// @ts-check
// The right-click menu (src/app/menus.js and its wiring in background.js): the three items, each
// with its own title ("Download this drama" on a link to a series, on any page; "Download this
// page's drama" on a series page; "Download this favorite drama" on a card of the profile's
// favorites, on www.tiktok.com only), where Chrome shows them, what a click asks the DramaFetch tab
// to list, and the worker that puts the items in place at install and at Chrome's start, answers a
// click the way it answers the popup's "Download this series" — the card item by asking the tab's
// frame for the right-clicked card, telling "no card" from "no script" —, hears only the
// extension's own pages and worker, and observes the favorites list's requests of the user's TikTok
// tabs, keeping the first page's. Over a fake chrome: no browser — the integration scenarios check
// that Chrome itself takes the items and that the content script answers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  MENU_CARD,
  MENU_LINK,
  MENU_PAGE,
  PROFILE_PAGE_PATTERNS,
  SERIES_PAGE_PATTERNS,
  SHORT_DRAMA_LINK_PATTERNS,
  loadOfClick,
  menuItems,
} from "../src/app/menus.js";

const SERIES = "7675706520839033876";
const ROOT = "chrome-extension://dramafetch-test-id/";

/**
 * Whether Chrome's match `pattern` (`<scheme>://<host>/<path>`, `*` scheme = http or https,
 * `*.` host = the domain or any subdomain, `*` in the path = anything, matched against the path
 * and the query; a path `/x/*` also matches `/x` — Chromium's `URLPattern::MatchesPath`) matches
 * `url`.
 * @param {string} pattern
 * @param {string} url
 * @returns {boolean}
 */
function matches(pattern, url) {
  const parts = /^(\*|https?):\/\/(\*\.)?([^/]+)(\/.*)$/.exec(pattern);
  assert.ok(parts, `not a match pattern: ${pattern}`);
  const [, scheme, anySub, host, path] = /** @type {string[]} */ (parts);
  const parsed = new URL(url);
  if (scheme === "*" ? !["http:", "https:"].includes(parsed.protocol) : parsed.protocol !== `${scheme}:`) return false;
  const hostOk = parsed.hostname === host || (anySub !== undefined && parsed.hostname.endsWith(`.${host}`));
  const target = parsed.pathname + parsed.search;
  if (String(path).endsWith("/*") && target === String(path).slice(0, -2)) return hostOk;
  const pathRe = new RegExp(`^${String(path).split("*").map((piece) => piece.replace(/[.?+^$()[\]{}|\\]/g, "\\$&")).join(".*")}$`);
  return hostOk && pathRe.test(target);
}

/**
 * @param {readonly string[]} patterns
 * @param {string} url
 */
const shownBy = (patterns, url) => patterns.some((pattern) => matches(pattern, url));

test("three items, each with its own title: one on a link under /shortdrama/, one on a series page, one on a profile's favorites card", () => {
  const hosts = ["www.tiktok.com", "m.tiktok.com", "tiktok.com"];
  assert.deepEqual(menuItems("Download this drama", "Download this page's drama", "Download this favorite drama"), [
    {
      id: MENU_LINK,
      title: "Download this drama",
      contexts: ["link"],
      targetUrlPatterns: hosts.map((host) => `*://${host}/shortdrama/*`),
    },
    {
      id: MENU_PAGE,
      title: "Download this page's drama",
      contexts: ["page"],
      documentUrlPatterns: hosts.flatMap((host) => [
        ...["episode", "detail", "series"].map((kind) => `*://${host}/shortdrama/${kind}/*`),
        ..."0123456789".split("").map((digit) => `*://${host}/shortdrama/${digit}*`),
      ]),
    },
    {
      id: MENU_CARD,
      title: "Download this favorite drama",
      contexts: ["page", "image"],
      // where the content script runs (`https://www.tiktok.com/*`): www only
      documentUrlPatterns: ["*://www.tiktok.com/@*"],
    },
  ]);
  assert.equal(MENU_CARD, "dramafetch-download-card");
  assert.equal(Object.isFrozen(SHORT_DRAMA_LINK_PATTERNS), true);
  assert.equal(Object.isFrozen(SERIES_PAGE_PATTERNS), true);
  assert.equal(Object.isFrozen(PROFILE_PAGE_PATTERNS), true);
  // the link item shows on any page (no documentUrlPatterns): TikTok's own lists of dramas too
  assert.equal(Object.hasOwn(/** @type {object} */ (menuItems("x", "y", "z")[0]), "documentUrlPatterns"), false);
  // the card item's title is its own, never the link item's
  assert.deepEqual(menuItems("a", "b", "c").map((item) => item.title), ["a", "b", "c"]);
});

test("the link item shows on links under /shortdrama/ on TikTok's hosts, the page item on series pages only", () => {
  for (const url of [
    `https://www.tiktok.com/shortdrama/episode/${SERIES}/8`,
    `https://www.tiktok.com/shortdrama/episode/${SERIES}/1?enter_from=drama_list`,
    `http://www.tiktok.com/shortdrama/episode/${SERIES}`,
    `https://m.tiktok.com/shortdrama/detail/${SERIES}`,
    `https://tiktok.com/shortdrama/series/${SERIES}`,
    `https://m.tiktok.com/shortdrama/${SERIES}`,
    `https://www.tiktok.com/shortdrama/${SERIES}?lang=en`,
  ]) {
    assert.equal(shownBy(SHORT_DRAMA_LINK_PATTERNS, url), true, `link: ${url}`);
    assert.equal(shownBy(SERIES_PAGE_PATTERNS, url), true, `page: ${url}`);
  }
  // a link under /shortdrama/ that names no series shows the link item: the tab says why it lists
  // nothing; no page item on such an address, a list of dramas
  for (const url of ["https://www.tiktok.com/shortdrama/foryou", "https://www.tiktok.com/shortdrama"]) {
    assert.equal(shownBy(SHORT_DRAMA_LINK_PATTERNS, url), true, `link: ${url}`);
    assert.equal(shownBy(SERIES_PAGE_PATTERNS, url), false, `page: ${url}`);
  }
  for (const url of [
    `https://www.tiktok.com/@someone/video/${SERIES}`,
    "https://www.tiktok.com/foryou",
    `https://ads.tiktok.com/shortdrama/episode/${SERIES}/1`,
    "https://vm.tiktok.com/ZMabc123/",
    `https://example.com/shortdrama/episode/${SERIES}/1`,
    `https://tiktok.com.example.com/shortdrama/episode/${SERIES}/1`,
    `https://eviltiktok.com/shortdrama/episode/${SERIES}/1`,
    `ftp://www.tiktok.com/shortdrama/episode/${SERIES}/1`,
  ]) {
    assert.equal(shownBy(SHORT_DRAMA_LINK_PATTERNS, url), false, `link: ${url}`);
    assert.equal(shownBy(SERIES_PAGE_PATTERNS, url), false, `page: ${url}`);
  }
});

test("the card item shows on TikTok's www profile pages only — where the content script runs —: never on m. or the bare host, a series, a list of dramas, the feed or another host", () => {
  for (const url of [
    "https://www.tiktok.com/@invented_viewer",
    "https://www.tiktok.com/@invented_viewer?lang=en",
    "http://www.tiktok.com/@invented_viewer",
    "https://www.tiktok.com/@invented.viewer_2",
  ]) {
    assert.equal(shownBy(PROFILE_PAGE_PATTERNS, url), true, url);
  }
  for (const url of [
    "https://m.tiktok.com/@invented_viewer", // no content script there: nothing could say which card
    "https://tiktok.com/@invented.viewer_2",
    `https://www.tiktok.com/shortdrama/episode/${SERIES}/1`,
    `https://www.tiktok.com/shortdrama/${SERIES}`,
    "https://www.tiktok.com/shortdrama/foryou",
    "https://www.tiktok.com/foryou",
    "https://www.tiktok.com/",
    "https://www.tiktok.com/explore?x=@someone",
    "https://ads.tiktok.com/@someone",
    "https://example.com/@someone",
    "https://tiktok.com.example.com/@someone",
    "https://eviltiktok.com/@someone",
    "ftp://www.tiktok.com/@someone",
  ]) {
    assert.equal(shownBy(PROFILE_PAGE_PATTERNS, url), false, url);
  }
  // the other two items never show on a profile page itself (a link there to a series still offers the link item)
  assert.equal(shownBy(SERIES_PAGE_PATTERNS, "https://www.tiktok.com/@invented_viewer"), false);
  assert.equal(shownBy(SHORT_DRAMA_LINK_PATTERNS, "https://www.tiktok.com/@invented_viewer"), false);
  // every page the card item shows on is one the content script runs in (an https page: the
  // script's `matches`), so a right-click there can be answered
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const scripts = /** @type {{matches: string[]}[]} */ (manifest["content_scripts"]);
  for (const url of ["https://www.tiktok.com/@invented_viewer", "https://www.tiktok.com/@a.b?lang=en"]) {
    assert.equal(shownBy(PROFILE_PAGE_PATTERNS, url), true, url);
    assert.equal(scripts.some((script) => shownBy(script.matches, url)), true, url);
  }
  // its click lists no address: the worker asks the tab for the card instead
  assert.equal(loadOfClick({ menuItemId: MENU_CARD, pageUrl: "https://www.tiktok.com/@invented_viewer", frameId: 0 }), null);
});

test("a click asks for the series of the link, or of the right-clicked page; anything else as it is", () => {
  const episode = `https://www.tiktok.com/shortdrama/episode/${SERIES}/8`;
  const list = "https://www.tiktok.com/shortdrama/foryou";
  assert.equal(loadOfClick({ menuItemId: MENU_LINK, linkUrl: episode, pageUrl: list }), SERIES);
  assert.equal(loadOfClick({ menuItemId: MENU_LINK, linkUrl: `${episode}?enter_from=drama_list&is_from_webapp=1` }), SERIES);
  assert.equal(loadOfClick({ menuItemId: MENU_LINK, linkUrl: `https://m.tiktok.com/shortdrama/${SERIES}` }), SERIES);
  assert.equal(loadOfClick({ menuItemId: MENU_PAGE, pageUrl: episode }), SERIES);
  // the link item reads the link, the page item the page — never the other one, nor the selection
  assert.equal(loadOfClick({ menuItemId: MENU_PAGE, linkUrl: episode, pageUrl: list }), list);
  assert.equal(loadOfClick({ menuItemId: MENU_LINK, linkUrl: episode, pageUrl: list, frameUrl: list, selectionText: "another drama" }), SERIES);
  // the page item inside a frame: Chrome matched the frame's address, and the click reads it
  // (Chrome 116 sends frameUrl only from inside a frame; later versions send it for the page too)
  assert.equal(loadOfClick({ menuItemId: MENU_PAGE, pageUrl: "https://blog.example/post?ref=mail", frameUrl: episode }), SERIES);
  assert.equal(loadOfClick({ menuItemId: MENU_PAGE, pageUrl: episode, frameUrl: episode }), SERIES);
  // a short-drama address that names no series reaches the tab as it is: the tab says why
  assert.equal(loadOfClick({ menuItemId: MENU_LINK, linkUrl: list }), list);
  assert.equal(loadOfClick({ menuItemId: MENU_LINK }), null);
  assert.equal(loadOfClick({ menuItemId: MENU_LINK, linkUrl: "" }), null);
  assert.equal(loadOfClick({ menuItemId: MENU_PAGE, linkUrl: episode }), null);
  assert.equal(loadOfClick({ menuItemId: "another-item", linkUrl: episode, pageUrl: episode }), null);
  // test mode: the fake TikTok's address counts as TikTok's
  assert.equal(loadOfClick({ menuItemId: MENU_LINK, linkUrl: `http://127.0.0.1:8123/shortdrama/episode/${SERIES}/2` }, "http://127.0.0.1:8123"), SERIES);
});

test("the worker puts the items in place at install and at Chrome's start — one install at a time, again after a refused one —; a click has the series listed like the popup; the popup's Open DramaFetch leaves the open tab as it is", async () => {
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {{ installed?: () => void, startup?: () => void, clicked?: (info: chrome.contextMenus.OnClickData) => void, message?: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean }} */
  const on = {};
  /** @type {{ id: number, windowId: number, url: string }[]} */
  let tabs = [];
  /** @type {unknown} what the DramaFetch pages answer: an Error when none is running */
  let answer = new Error("Could not establish connection. Receiving end does not exist.");
  /** @type {Map<string, chrome.contextMenus.CreateProperties>} Chrome's menu: the items it holds */
  const menu = new Map();
  /** @type {string | undefined} an id whose create Chrome refuses */
  let refused;
  const ignored = { addListener: () => undefined };
  const runtime = {
    id: "dramafetch-test-id",
    /** @type {{ message?: string } | undefined} */
    lastError: undefined,
    getURL: (/** @type {string} */ path) => `${ROOT}${path}`,
    getManifest: () => ({ manifest_version: 3, name: "DramaFetch", version: "1.4.0" }),
    sendMessage: async (/** @type {unknown} */ message) => {
      calls.push(["sendMessage", message]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    onMessage: { addListener: (/** @type {(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean} */ listener) => void (on.message = listener) },
    onInstalled: { addListener: (/** @type {() => void} */ listener) => void (on.installed = listener) },
    onStartup: { addListener: (/** @type {() => void} */ listener) => void (on.startup = listener) },
  };
  /**
   * Chrome answers a contextMenus call later, with `error` in chrome.runtime.lastError while the
   * callback runs.
   * @param {() => void} done
   * @param {string} [error]
   */
  const answerLater = (done, error) =>
    void setTimeout(() => {
      runtime.lastError = error === undefined ? undefined : { message: error };
      try {
        done();
      } finally {
        runtime.lastError = undefined;
      }
    }, 0);
  /** @type {Record<string, string>} Chrome in Spanish */
  const spanish = {
    contextDownload: "Descargar este drama",
    contextDownloadPage: "Descargar el drama de esta página",
    contextDownloadFavorite: "Descargar este drama favorito",
  };
  Object.assign(globalThis, {
    chrome: {
      runtime,
      i18n: { getMessage: (/** @type {string} */ key) => spanish[key] ?? "", getUILanguage: () => "es" },
      tabs: {
        query: async () => tabs,
        create: async (/** @type {unknown} */ properties) => void calls.push(["create", properties]),
        update: async (/** @type {number} */ id, /** @type {unknown} */ properties) => {
          calls.push(["update", id, properties]);
          return { id, windowId: 3, active: true, index: 0 };
        },
        onRemoved: ignored,
        onUpdated: ignored,
      },
      windows: { update: async (/** @type {number} */ id, /** @type {unknown} */ info) => void calls.push(["focus", id, info]) },
      contextMenus: {
        removeAll: (/** @type {() => void} */ done) => {
          calls.push(["removeAll"]);
          menu.clear();
          answerLater(done);
        },
        create: (/** @type {chrome.contextMenus.CreateProperties} */ properties, /** @type {() => void} */ done) => {
          calls.push(["menu", properties.id, properties.title]);
          const error = menu.has(properties.id)
            ? `Cannot create item with duplicate id ${properties.id}`
            : properties.id === refused
              ? "Invalid url pattern"
              : undefined;
          if (error === undefined) menu.set(properties.id, properties);
          answerLater(done, error);
          return properties.id;
        },
        onClicked: {
          addListener: (/** @type {(info: chrome.contextMenus.OnClickData) => void} */ listener) => void (on.clicked = listener),
        },
      },
      storage: { local: { get: async () => ({}) }, session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined } },
      webRequest: { onCompleted: { addListener: () => undefined } },
    },
  });
  const settle = async () => {
    for (let round = 0; round < 30; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const placed = [
    ["removeAll"],
    ["menu", MENU_LINK, "Descargar este drama"],
    ["menu", MENU_PAGE, "Descargar el drama de esta página"],
    ["menu", MENU_CARD, "Descargar este drama favorito"],
  ];
  /** @returns {[string | number, string][]} */
  const held = () => [...menu.values()].map((item) => [item.id, item.title]);
  try {
    await import("../src/app/background.js");
    const { installed, startup, clicked } = on;
    assert.ok(installed && startup && clicked, "the worker listens to the install, Chrome's start and the menu");

    // the install and Chrome's start at once: one after the other, never interleaved
    installed();
    startup();
    await settle();
    assert.deepEqual(calls, [...placed, ...placed], "removed, then the three items, in Chrome's language — twice, in turn");
    assert.deepEqual(held(), [
      [MENU_LINK, "Descargar este drama"],
      [MENU_PAGE, "Descargar el drama de esta página"],
      [MENU_CARD, "Descargar este drama favorito"], // its own title, never the link item's
    ]);
    calls.length = 0;

    // Chrome refuses an item: that install stops there (no unhandled error); the next one puts all
    // three in place
    refused = MENU_LINK;
    startup();
    await settle();
    assert.deepEqual(calls, [["removeAll"], ["menu", MENU_LINK, "Descargar este drama"]]);
    assert.deepEqual(held(), []);
    calls.length = 0;
    refused = undefined;
    startup();
    await settle();
    assert.deepEqual(calls, placed);
    calls.length = 0;

    // no DramaFetch page running, no tab: one opens with the series to list
    // (`app.html?load=<series id>`)
    const load = { type: "dramafetch:load", input: SERIES };
    clicked({ menuItemId: MENU_LINK, linkUrl: `https://www.tiktok.com/shortdrama/episode/${SERIES}/8`, pageUrl: "https://www.tiktok.com/shortdrama/foryou" });
    await settle();
    assert.deepEqual(calls, [["sendMessage", load], ["create", { url: `${ROOT}src/app/app.html?load=${SERIES}` }]]);
    calls.length = 0;

    // the engine's tab takes the series and names itself: that tab comes to the front, nothing
    // reloads — here the page item, on a series page
    tabs = [{ id: 9, windowId: 4, url: `${ROOT}src/app/app.html` }];
    answer = { ok: true, tabId: 7 };
    clicked({ menuItemId: MENU_PAGE, pageUrl: `https://www.tiktok.com/shortdrama/episode/${SERIES}/3` });
    await settle();
    assert.deepEqual(calls, [["sendMessage", load], ["update", 7, { active: true }], ["focus", 3, { focused: true }]]);
    calls.length = 0;

    // an address that names no series: handed over as it is, the tab says why it lists nothing
    clicked({ menuItemId: MENU_LINK, linkUrl: "https://www.tiktok.com/shortdrama/foryou" });
    await settle();
    assert.deepEqual(calls[0], ["sendMessage", { type: "dramafetch:load", input: "https://www.tiktok.com/shortdrama/foryou" }]);
    calls.length = 0;

    // the DramaFetch tab open but its page not running (restored by Chrome after a restart but
    // not loaded yet, or discarded): it reloads with the series in its address
    answer = undefined;
    clicked({ menuItemId: MENU_LINK, linkUrl: `https://www.tiktok.com/shortdrama/episode/${SERIES}/8` });
    await settle();
    assert.deepEqual(calls, [["sendMessage", load], ["update", 9, { active: true, url: `${ROOT}src/app/app.html?load=${SERIES}` }], ["focus", 4, { focused: true }]]);
    calls.length = 0;

    // another item's click (none exists) asks nothing
    clicked({ menuItemId: "another-item", linkUrl: `https://www.tiktok.com/shortdrama/episode/${SERIES}/8` });
    await settle();
    assert.deepEqual(calls, []);

    // the popup's Open DramaFetch (no series): the open tab comes to the front as it is — nothing
    // is sent to the pages, nothing reloads
    const { message } = on;
    assert.ok(message, "the worker listens to the popup");
    /** @type {unknown[]} */
    const answers = [];
    const popup = { id: runtime.id, url: `${ROOT}src/app/popup.html` };
    assert.equal(message({ type: "dramafetch:open", load: null }, popup, (response) => void answers.push(response)), true);
    await settle();
    assert.deepEqual(calls, [["update", 9, { active: true }], ["focus", 4, { focused: true }]]);
    assert.deepEqual(answers, [{ ok: true }]);
    calls.length = 0;
    // another extension, or another message: not heard
    assert.equal(message({ type: "dramafetch:open", load: null }, { id: "another-extension", url: "chrome-extension://another-extension/popup.html" }, (response) => void answers.push(response)), false);
    assert.equal(message({ type: "dramafetch:load", input: SERIES }, popup, (response) => void answers.push(response)), false);
    await settle();
    assert.deepEqual(calls, []);
    assert.deepEqual(answers, [{ ok: true }]);
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("the worker: the card item asks the right-clicked tab's frame for the card and hands it over with that tab — without one, whether the tab's script answered at all —; the popup's Choose from your favorites hands its tab over; the favorites list's FIRST page kept per tab from the tab's own requests, never replaced by a later page, and forgotten when the tab closes", async () => {
  const FAVORITES = "https://www.tiktok.com/api/user/favorite/drama_list/?WebIdLastTime=1794300000&aid=1988&count=19&cursor=0&X-Bogus=DFSzswVO";
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {{ installed?: () => void, clicked?: (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void, message?: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean, completed?: (details: chrome.webRequest.CompletedDetails) => void, removed?: (tabId: number) => void }} */
  const on = {};
  /** @type {chrome.webRequest.RequestFilter | undefined} */
  let filter;
  /** @type {{ id: number, windowId: number, url: string }[]} */
  let tabs = [];
  /** @type {unknown} what the DramaFetch pages answer: an Error when none is running */
  let pages = new Error("Could not establish connection. Receiving end does not exist.");
  /** @type {unknown} what the content script answers: an Error when the tab has none */
  let content = null;
  /** @type {Map<string, unknown>} chrome.storage.session */
  const session = new Map();
  const runtime = {
    id: "dramafetch-test-id",
    lastError: undefined,
    getURL: (/** @type {string} */ path) => `${ROOT}${path}`,
    getManifest: () => ({ manifest_version: 3, name: "DramaFetch", version: "1.5.0", host_permissions: ["https://www.tiktok.com/*"] }),
    sendMessage: async (/** @type {unknown} */ message) => {
      calls.push(["sendMessage", message]);
      if (pages instanceof Error) throw pages;
      return pages;
    },
    onMessage: { addListener: (/** @type {NonNullable<typeof on.message>} */ listener) => void (on.message = listener) },
    onInstalled: { addListener: (/** @type {() => void} */ listener) => void (on.installed = listener) },
    onStartup: { addListener: () => undefined },
  };
  Object.assign(globalThis, {
    chrome: {
      runtime,
      i18n: { getMessage: () => "", getUILanguage: () => "en" },
      tabs: {
        query: async () => tabs,
        create: async (/** @type {unknown} */ properties) => void calls.push(["create", properties]),
        update: async (/** @type {number} */ id, /** @type {unknown} */ properties) => {
          calls.push(["update", id, properties]);
          return { id, windowId: 3, active: true, index: 0 };
        },
        sendMessage: async (/** @type {number} */ tabId, /** @type {unknown} */ message, /** @type {unknown} */ options) => {
          calls.push(["tabMessage", tabId, message, options]);
          if (content instanceof Error) throw content;
          return content;
        },
        remove: async () => undefined,
        onRemoved: { addListener: (/** @type {(tabId: number) => void} */ listener) => void (on.removed = listener) },
        onUpdated: { addListener: () => undefined },
      },
      windows: { update: async (/** @type {number} */ id, /** @type {unknown} */ info) => void calls.push(["focus", id, info]) },
      contextMenus: {
        removeAll: (/** @type {() => void} */ done) => void setTimeout(done, 0),
        create: (/** @type {chrome.contextMenus.CreateProperties} */ properties, /** @type {() => void} */ done) => {
          setTimeout(done, 0);
          return properties.id;
        },
        onClicked: { addListener: (/** @type {NonNullable<typeof on.clicked>} */ listener) => void (on.clicked = listener) },
      },
      storage: {
        local: { get: async () => ({}) },
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
          addListener: (/** @type {NonNullable<typeof on.completed>} */ listener, /** @type {chrome.webRequest.RequestFilter} */ given) => {
            on.completed = listener;
            filter = given;
          },
        },
      },
    },
  });
  const settle = async () => {
    for (let round = 0; round < 30; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /**
   * What webRequest reports when a request of a tab completes (URL, status, tab, time: no body, no header).
   * @param {Partial<chrome.webRequest.CompletedDetails>} details
   * @returns {chrome.webRequest.CompletedDetails}
   */
  const completed = (details) => ({ requestId: "1", url: FAVORITES, method: "GET", tabId: 5, type: "xmlhttprequest", timeStamp: 1794351568000, statusCode: 200, fromCache: false, ...details });
  try {
    const url = new URL("../src/app/background.js", import.meta.url);
    url.search = "?favorites"; // a fresh worker over this fake: its listeners are registered again
    /** @type {typeof import("../src/app/background.js")} */
    const worker = await import(url.href);
    const { clicked, message, removed } = on;
    const hear = on.completed;
    assert.ok(clicked && message && removed && hear, "the worker listens to the menu, the popup, closed tabs and completed requests");

    // the observer: the URLs holding drama_list on TikTok's hosts, xmlhttprequest only — Chrome hands
    // the worker no other request of the user's TikTok tabs; observation (no "blocking", no
    // "requestBody", no "extraHeaders" in the filter's place); in the test copy the fake's host too
    assert.deepEqual(filter, { urls: ["https://www.tiktok.com/*drama_list*", "https://*.tiktok.com/*drama_list*"], types: ["xmlhttprequest"] });
    assert.deepEqual(worker.favoritesObserverUrls({ manifest_version: 3, name: "x", version: "1", host_permissions: ["https://www.tiktok.com/*", "http://127.0.0.1/*"] }), [
      "https://www.tiktok.com/*drama_list*",
      "https://*.tiktok.com/*drama_list*",
    ]);
    assert.deepEqual(
      worker.favoritesObserverUrls({ manifest_version: 3, name: "x", version: "1", dramafetch_test: true, host_permissions: ["https://www.tiktok.com/*", "http://127.0.0.1/*"] }),
      ["https://www.tiktok.com/*drama_list*", "https://*.tiktok.com/*drama_list*", "http://127.0.0.1/*drama_list*"],
    );
    // kept per tab: the list's first page of a tab, answered 200 — its URL and when, nothing else
    hear(completed({}));
    await settle();
    assert.deepEqual([...session.entries()], [["favoritesTemplate:5", { url: FAVORITES, at: 1794351568 }]]);
    // never kept, never replacing it: a later page — the page's own as its grid scrolls, or one the
    // DramaFetch tab asked for (cursor ≠ 0) —, a drama_list without `favorite`, another status, no
    // tab (the extension's own worker or a request of no tab), another list
    const next = FAVORITES.replace("cursor=0", "cursor=1794351568");
    hear(completed({ url: next, timeStamp: 1794351570500 }));
    hear(completed({ url: FAVORITES.replace("cursor=0", "cursor=1794350100"), timeStamp: 1794351571500 }));
    hear(completed({ url: "https://www.tiktok.com/api/drama/recommend/drama_list/?aid=1988&cursor=0", timeStamp: 1794351572000 }));
    hear(completed({ statusCode: 429 }));
    hear(completed({ statusCode: 403 }));
    hear(completed({ statusCode: 304 }));
    hear(completed({ tabId: -1 }));
    hear(completed({ url: `https://www.tiktok.com/api/drama/episode/item_list/?dramaID=${SERIES}&cursor=0` }));
    hear(completed({ url: "https://www.tiktok.com/api/user/detail/?from=favorite_drama_list" })); // drama_list in the query only
    await settle();
    assert.deepEqual([...session.entries()], [["favoritesTemplate:5", { url: FAVORITES, at: 1794351568 }]]);
    // the most recent FIRST page wins (the profile shown again, or the DramaFetch tab's own replay of
    // it, byte for byte); a first page without a cursor counts; another tab has its own
    const noCursor = FAVORITES.replace("&cursor=0", "");
    hear(completed({ timeStamp: 1794351573000 }));
    hear(completed({ tabId: 6, url: noCursor, timeStamp: 1794351574000 }));
    await settle();
    assert.deepEqual(session.get("favoritesTemplate:5"), { url: FAVORITES, at: 1794351573 });
    assert.deepEqual(session.get("favoritesTemplate:6"), { url: noCursor, at: 1794351574 });
    hear(completed({ tabId: 6, url: next.replace("&cursor=0", ""), timeStamp: 1794351575000 })); // a later page of tab 6
    await settle();
    assert.deepEqual(session.get("favoritesTemplate:6"), { url: noCursor, at: 1794351574 });
    // forgotten when its tab closes
    removed(5);
    await settle();
    assert.deepEqual([...session.keys()], ["favoritesTemplate:6"]);

    const profile = "https://www.tiktok.com/@invented_viewer";
    const tab = { id: 6, index: 0, windowId: 2, active: true, url: profile };
    // the card item on a card: the tab's top frame asked for the card, then the hand-over — no
    // DramaFetch page running, no tab: a new one with the hand-over in its address
    content = { title: "  Snowfall in\nTwo Cities ", index: 2, at: 1794351572000 };
    clicked({ menuItemId: MENU_CARD, pageUrl: profile, frameId: 0 }, tab);
    await settle();
    const card = { title: "Snowfall in Two Cities", index: 2 };
    assert.deepEqual(calls, [
      ["tabMessage", 6, { type: "dramafetch:card" }, { frameId: 0 }],
      ["sendMessage", { type: "dramafetch:favorites", tabId: 6, card, menu: true, script: true }],
      ["create", { url: `${ROOT}src/app/app.html?favorites=6&menu=1&card=${encodeURIComponent(JSON.stringify(card)).replace(/%20/g, "+")}` }],
    ]);
    calls.length = 0;
    // the engine's tab takes it and comes to the front; a right-click in a frame asks that frame
    pages = { ok: true, tabId: 9 };
    clicked({ menuItemId: MENU_CARD, pageUrl: profile, frameId: 4 }, tab);
    await settle();
    assert.deepEqual(calls, [
      ["tabMessage", 6, { type: "dramafetch:card" }, { frameId: 4 }],
      ["sendMessage", { type: "dramafetch:favorites", tabId: 6, card, menu: true, script: true }],
      ["update", 9, { active: true }],
      ["focus", 3, { focused: true }],
    ]);
    calls.length = 0;
    // a right-click on no card — the script answered, with null or with something that is no card —:
    // no card, `script` true; no script in the tab at all (loaded before this version: the message
    // is rejected): no card, `script` false — the DramaFetch tab lists nothing either way and says why
    for (const [answer, script] of /** @type {[unknown, boolean][]} */ ([
      [null, true],
      [{ title: 5, index: 1 }, true],
      [{ title: "x", index: -1 }, true],
      [new Error("Could not establish connection. Receiving end does not exist."), false],
    ])) {
      content = answer;
      clicked({ menuItemId: MENU_CARD, pageUrl: profile, frameId: 0 }, tab);
      await settle();
      assert.deepEqual(calls.slice(0, 2), [
        ["tabMessage", 6, { type: "dramafetch:card" }, { frameId: 0 }],
        ["sendMessage", { type: "dramafetch:favorites", tabId: 6, card: null, menu: true, script }],
      ]);
      calls.length = 0;
    }
    // the open DramaFetch tab not running: it reloads with the hand-over in its address — `script=0`
    // only when no content script answered
    pages = undefined;
    tabs = [{ id: 9, windowId: 4, url: `${ROOT}src/app/app.html` }];
    content = null;
    clicked({ menuItemId: MENU_CARD, pageUrl: profile, frameId: 0 }, tab);
    await settle();
    assert.deepEqual(calls.slice(2), [["update", 9, { active: true, url: `${ROOT}src/app/app.html?favorites=6&menu=1` }], ["focus", 4, { focused: true }]]);
    calls.length = 0;
    content = new Error("Could not establish connection. Receiving end does not exist.");
    clicked({ menuItemId: MENU_CARD, pageUrl: profile, frameId: 0 }, tab);
    await settle();
    assert.deepEqual(calls.slice(2), [["update", 9, { active: true, url: `${ROOT}src/app/app.html?favorites=6&menu=1&script=0` }], ["focus", 4, { focused: true }]]);
    calls.length = 0;
    // a click Chrome reports without its tab: nothing asked, nothing opened
    clicked({ menuItemId: MENU_CARD, pageUrl: profile, frameId: 0 });
    await settle();
    assert.deepEqual(calls, []);

    // the popup's Choose from your favorites: that tab handed over, no card, not from the menu
    /** @type {unknown[]} */
    const answers = [];
    const popup = { id: runtime.id, url: `${ROOT}src/app/popup.html` };
    assert.equal(message({ type: "dramafetch:open", favorites: 6 }, popup, (response) => void answers.push(response)), true);
    await settle();
    assert.deepEqual(calls, [
      ["sendMessage", { type: "dramafetch:favorites", tabId: 6, card: null, menu: false, script: true }],
      ["update", 9, { active: true, url: `${ROOT}src/app/app.html?favorites=6` }],
      ["focus", 4, { focused: true }],
    ]);
    assert.deepEqual(answers, [{ ok: true }]);
    calls.length = 0;
    // a tab id that is none: the popup's Open DramaFetch, as before
    assert.equal(message({ type: "dramafetch:open", favorites: -3, load: null }, popup, () => undefined), true);
    await settle();
    assert.deepEqual(calls, [["update", 9, { active: true }], ["focus", 4, { focused: true }]]);
    calls.length = 0;

    // only the extension's own pages and worker are heard: the popup, the DramaFetch tab (in a tab),
    // the worker with or without its address — never a TikTok page carrying the extension's id (its
    // content script runs there), nor another extension
    const tiktokTab = { id: 6, index: 0, windowId: 2, active: true, url: profile };
    for (const [sender, heard] of /** @type {[chrome.runtime.MessageSender, boolean][]} */ ([
      [popup, true],
      [{ id: runtime.id, url: `${ROOT}src/app/app.html?load=1`, tab: { id: 9, index: 0, windowId: 4, active: true, url: `${ROOT}src/app/app.html` } }, true],
      [{ id: runtime.id, url: `${ROOT}src/app/background.js` }, true],
      [{ id: runtime.id }, true],
      [{ id: runtime.id, url: profile, tab: tiktokTab }, false],
      [{ id: runtime.id, url: "https://www.tiktok.com/@x/video/1" }, false],
      [{ id: runtime.id, tab: tiktokTab }, false], // a tab and no address: never the worker
      [{ id: runtime.id, url: "" }, false],
      [{ id: runtime.id, url: "chrome-extension://another-extension/popup.html" }, false],
      [{ id: "another-extension", url: `${ROOT}src/app/popup.html` }, false],
      [{ url: `${ROOT}src/app/popup.html` }, false],
    ])) {
      /** @type {unknown[]} */
      const said = [];
      assert.equal(message({ type: "dramafetch:open", favorites: 6 }, sender, (response) => void said.push(response)), heard, JSON.stringify(sender));
      await settle();
      assert.equal(calls.length > 0, heard, JSON.stringify(sender));
      assert.deepEqual(said, heard ? [{ ok: true }] : [], JSON.stringify(sender));
      calls.length = 0;
    }
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});
