// @ts-check
// The right-click menu, "Download this drama" (src/app/menus.js and its wiring in background.js):
// the two items (a link to a series, on any page; "Download this page's drama" on a series page),
// where Chrome shows them, what a click asks the DramaFetch tab to list, and the worker that puts
// the items in place at install and at Chrome's start and answers a click the way it answers the
// popup's "Download this series". Over a fake chrome: no browser — the integration scenario
// checks that Chrome itself takes the items.
import assert from "node:assert/strict";
import { test } from "node:test";

import { MENU_LINK, MENU_PAGE, SERIES_PAGE_PATTERNS, SHORT_DRAMA_LINK_PATTERNS, loadOfClick, menuItems } from "../src/app/menus.js";

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

test("two items, each with its title: one on a link under /shortdrama/, one on a series page", () => {
  const hosts = ["www.tiktok.com", "m.tiktok.com", "tiktok.com"];
  assert.deepEqual(menuItems("Download this drama", "Download this page's drama"), [
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
  ]);
  assert.equal(Object.isFrozen(SHORT_DRAMA_LINK_PATTERNS), true);
  assert.equal(Object.isFrozen(SERIES_PAGE_PATTERNS), true);
  // the link item shows on any page (no documentUrlPatterns): TikTok's own lists of dramas too
  assert.equal(Object.hasOwn(/** @type {object} */ (menuItems("x", "y")[0]), "documentUrlPatterns"), false);
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
  /** @type {{ installed?: () => void, startup?: () => void, clicked?: (info: chrome.contextMenus.OnClickData) => void, message?: (message: unknown, sender: { id?: string }, sendResponse: (response?: unknown) => void) => boolean }} */
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
    onMessage: { addListener: (/** @type {(message: unknown, sender: { id?: string }, sendResponse: (response?: unknown) => void) => boolean} */ listener) => void (on.message = listener) },
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
  const spanish = { contextDownload: "Descargar este drama", contextDownloadPage: "Descargar el drama de esta página" };
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
      storage: { local: { get: async () => ({}) } },
    },
  });
  const settle = async () => {
    for (let round = 0; round < 30; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const placed = [["removeAll"], ["menu", MENU_LINK, "Descargar este drama"], ["menu", MENU_PAGE, "Descargar el drama de esta página"]];
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
    assert.deepEqual(calls, [...placed, ...placed], "removed, then both items, in Chrome's language — twice, in turn");
    assert.deepEqual(held(), [[MENU_LINK, "Descargar este drama"], [MENU_PAGE, "Descargar el drama de esta página"]]);
    calls.length = 0;

    // Chrome refuses an item: that install stops there (no unhandled error); the next one puts both
    // in place
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
    assert.equal(message({ type: "dramafetch:open", load: null }, { id: runtime.id }, (response) => void answers.push(response)), true);
    await settle();
    assert.deepEqual(calls, [["update", 9, { active: true }], ["focus", 4, { focused: true }]]);
    assert.deepEqual(answers, [{ ok: true }]);
    calls.length = 0;
    // another extension, or another message: not heard
    assert.equal(message({ type: "dramafetch:open", load: null }, { id: "another-extension" }, (response) => void answers.push(response)), false);
    assert.equal(message({ type: "dramafetch:load", input: SERIES }, { id: runtime.id }, (response) => void answers.push(response)), false);
    await settle();
    assert.deepEqual(calls, []);
    assert.deepEqual(answers, [{ ok: true }]);
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});
