// @ts-check
// The right-click menu, "Download this video" (src/app/menus.js and its wiring in background.js):
// the two items (a link to a video, on any page; "Download this page's video" on a video page or
// an embedded player), where Chrome shows them, what a click puts into the box, and the worker
// that puts the items in place — titled in the pages' language — at install, at Chrome's start
// and when the Settings' language changes, and answers a click the way it answers the popup's
// "Download this video". Over a fake chrome: no browser — the end-to-end suite checks that Chrome
// itself takes the items.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { MENU_LINK, MENU_PAGE, VIDEO_PATTERNS, linkOfClick, menuItems } from "../src/app/menus.js";

const ROOT = "chrome-extension://streamfetch-test-id/";
const AID = "4801520000000001";

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
  const schemeOk = scheme === "*" ? ["http:", "https:"].includes(parsed.protocol) : parsed.protocol === `${scheme}:`;
  const hostOk = parsed.hostname === host || (anySub !== undefined && parsed.hostname.endsWith(`.${host}`));
  const target = parsed.pathname + parsed.search;
  if (String(path).endsWith("/*") && target === String(path).slice(0, -2)) return schemeOk && hostOk;
  const pieces = String(path).split("*").map((piece) => piece.replace(/[.?+^$()[\]{}|\\]/g, "\\$&"));
  return schemeOk && hostOk && new RegExp(`^${pieces.join(".*")}$`).test(target);
}

/** @param {string} url */
const shown = (url) => VIDEO_PATTERNS.some((pattern) => matches(pattern, url));

test("two items, each with its title: one on a link to a video, one on a video page", () => {
  assert.deepEqual(menuItems("Download this video", "Download this page's video"), [
    { id: MENU_LINK, title: "Download this video", contexts: ["link"], targetUrlPatterns: [...VIDEO_PATTERNS] },
    { id: MENU_PAGE, title: "Download this page's video", contexts: ["page"], documentUrlPatterns: [...VIDEO_PATTERNS] },
  ]);
  assert.equal(Object.isFrozen(VIDEO_PATTERNS), true);
  // the link item shows on any page (no documentUrlPatterns): the sites' own lists too
  assert.equal(Object.hasOwn(/** @type {object} */ (menuItems("x", "y")[0]), "documentUrlPatterns"), false);
});

test("the items show on the three sites' video pages and short links only", () => {
  for (const url of [
    "https://www.dailymotion.com/video/xbq9z2k",
    "https://www.dailymotion.com/video/xbq9z2k?playlist=x6hynp",
    "https://www.dailymotion.com/embed/video/xbq9z2k",
    "https://www.dailymotion.com/swf/video/xbq9z2k",
    "https://www.dailymotion.com/crawler/video/x8u4owg",
    "https://touch.dailymotion.com/video/xbq9z2k",
    // the players other sites embed (yt-dlp's DailymotionIE geo player and Bilibili's embed code)
    "https://geo.dailymotion.com/player.html?video=x89eyek",
    "https://geo.dailymotion.com/player/xakln.html?video=x8mjju4",
    "https://player.bilibili.com/player.html?isOutside=true&aid=170001&bvid=BV1GJ411x7h7&cid=279786&p=1",
    "https://dai.ly/xbq9z2k",
    "https://www.bilibili.com/video/BV1GJ411x7h7?p=2&vd_source=abc",
    "https://m.bilibili.com/video/av170001",
    "https://b23.tv/abc123",
    `https://www.bilibili.tv/en/video/${AID}?bstar_from=bstar-web.homepage.recommend.all`,
    `https://www.bilibili.tv/video/${AID}`,
    "https://www.bilibili.tv/en/play/2090001/13000002",
    "https://www.bilibili.tv/en/play/2090001",
    "https://bilibili.tv/media/2090001",
    `https://www.biliintl.com/en/video/${AID}`,
    "https://www.biliintl.com/en/play/34613/341736",
    "https://www.biliintl.com/en/play/34613",
    "https://www.biliintl.com/en/media/1048837",
  ]) {
    assert.equal(shown(url), true, url);
  }
  for (const url of [
    "https://www.dailymotion.com/playlist/x6hynp",
    "https://www.dailymotion.com/us",
    // a search whose words end in "video" (yt-dlp's DailymotionSearchIE: /search/<query>/videos)
    "https://www.dailymotion.com/search/music%20video/videos",
    "https://www.dailymotion.com/somewhere?next=video/x1",
    "https://space.bilibili.com/12345/video",
    "https://search.bilibili.com/video?keyword=x",
    "https://www.bilibili.com/bangumi/play/ep123",
    "https://www.bilibili.tv/en/trending",
    "https://www.biliintl.com/en/trending",
    "https://player.bilibili.com/",
    "https://geo.dailymotion.com/libs/player.js",
    // a geo player of a playlist alone: the box would refuse it ("playlist")
    "https://geo.dailymotion.com/player.html?playlist=x7wdsj",
    "https://www.youtube.com/watch?v=x",
    "https://bilibili.com.example.com/video/BV1GJ411x7h7",
    "https://evilbilibili.tv/en/video/1",
  ]) {
    assert.equal(shown(url), false, url);
  }
});

test("a click puts the video's page into the box, or the address as it is", () => {
  assert.equal(linkOfClick({ menuItemId: MENU_LINK, linkUrl: "https://dai.ly/xbq9z2k", pageUrl: "https://www.dailymotion.com/us" }), "https://www.dailymotion.com/video/xbq9z2k");
  assert.equal(linkOfClick({ menuItemId: MENU_LINK, linkUrl: "https://www.bilibili.com/video/BV1GJ411x7h7?p=2&vd_source=abc" }), "https://www.bilibili.com/video/BV1GJ411x7h7?p=2");
  assert.equal(linkOfClick({ menuItemId: MENU_LINK, linkUrl: `https://www.bilibili.tv/es/video/${AID}?bstar_from=x` }), `https://www.bilibili.tv/en/video/${AID}`);
  assert.equal(linkOfClick({ menuItemId: MENU_PAGE, pageUrl: "https://www.bilibili.tv/en/play/2090001" }), "https://www.bilibili.tv/en/play/2090001");
  // the link item reads the link, the page item the page — never the other one
  assert.equal(linkOfClick({ menuItemId: MENU_PAGE, linkUrl: "https://dai.ly/xbq9z2k", pageUrl: "https://www.dailymotion.com/video/xother1" }), "https://www.dailymotion.com/video/xother1");
  assert.equal(linkOfClick({ menuItemId: MENU_LINK, linkUrl: "https://dai.ly/xbq9z2k", pageUrl: "https://www.dailymotion.com/video/xother1", frameUrl: "https://www.dailymotion.com/video/xother1", selectionText: "xother1" }), "https://www.dailymotion.com/video/xbq9z2k");
  // the page item in an embedded player: Chrome matched the frame's address, and the click reads it
  // (Chrome 116 sends frameUrl only from inside a frame; later versions send it for the page too)
  assert.equal(linkOfClick({ menuItemId: MENU_PAGE, pageUrl: "https://news.example/article?id=42", frameUrl: "https://www.dailymotion.com/embed/video/xbq9z2k" }), "https://www.dailymotion.com/video/xbq9z2k");
  assert.equal(linkOfClick({ menuItemId: MENU_PAGE, pageUrl: "https://www.dailymotion.com/video/xbq9z2k", frameUrl: "https://www.dailymotion.com/video/xbq9z2k" }), "https://www.dailymotion.com/video/xbq9z2k");
  assert.equal(linkOfClick({ menuItemId: MENU_PAGE, pageUrl: "https://blog.example/post", frameUrl: "https://geo.dailymotion.com/player/xakln.html?video=x8mjju4" }), "https://www.dailymotion.com/video/x8mjju4");
  assert.equal(linkOfClick({ menuItemId: MENU_PAGE, pageUrl: "https://blog.example/post", frameUrl: "https://player.bilibili.com/player.html?isOutside=true&aid=170001&bvid=BV1GJ411x7h7&cid=279786&p=2" }), "https://www.bilibili.com/video/BV1GJ411x7h7?p=2");
  // a short b23.tv link is read when the box runs; an address the box refuses says why there
  assert.equal(linkOfClick({ menuItemId: MENU_LINK, linkUrl: "https://b23.tv/abc123" }), "https://b23.tv/abc123");
  assert.equal(linkOfClick({ menuItemId: MENU_LINK, linkUrl: "https://www.bilibili.tv/en/uservideo/1" }), "https://www.bilibili.tv/en/uservideo/1");
  assert.equal(linkOfClick({ menuItemId: MENU_LINK }), null);
  assert.equal(linkOfClick({ menuItemId: MENU_LINK, linkUrl: "" }), null);
  assert.equal(linkOfClick({ menuItemId: MENU_PAGE, linkUrl: "https://dai.ly/xbq9z2k" }), null);
  assert.equal(linkOfClick({ menuItemId: "another-item", linkUrl: "https://dai.ly/xbq9z2k" }), null);
  // test mode: a fake site's base counts as the site
  assert.equal(linkOfClick({ menuItemId: MENU_LINK, linkUrl: "http://127.0.0.1:8123/dm/video/xbq9z2k" }, { dailymotion: "http://127.0.0.1:8123/dm" }), "https://www.dailymotion.com/video/xbq9z2k");
});

test("the worker puts the items in place in the pages' language — one install at a time, again after a refused one —, follows the Settings, and a click hands the link over like the popup", async () => {
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {{ installed?: () => void, startup?: () => void, changed?: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void, clicked?: (info: chrome.contextMenus.OnClickData) => void }} */
  const on = {};
  /** @type {Record<string, unknown>} the Settings choose Spanish before the first install */
  const stored = { settings: { language: "es" } };
  /** @type {chrome.runtime.ExtensionContext[]} */
  let contexts = [];
  /** @type {unknown} what the StreamFetch pages answer: an Error when none is running */
  let answer = new Error("Could not establish connection. Receiving end does not exist.");
  /** @type {Map<string, chrome.contextMenus.CreateProperties>} Chrome's menu: the items it holds */
  const menu = new Map();
  /** @type {string | undefined} an id whose create Chrome refuses */
  let refused;
  /** @type {Record<string, { message: string }>} Chrome in English: what chrome.i18n serves */
  const english = JSON.parse(readFileSync(new URL("../_locales/en/messages.json", import.meta.url), "utf8"));
  const runtime = {
    id: "streamfetch-test-id",
    /** @type {{ message?: string } | undefined} */
    lastError: undefined,
    getURL: (/** @type {string} */ path) => `${ROOT}${path}`,
    getManifest: () => ({ manifest_version: 3, name: "StreamFetch", version: "1.1.0" }),
    getContexts: async () => contexts,
    sendMessage: async (/** @type {unknown} */ message) => {
      calls.push(["sendMessage", message]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    onMessage: { addListener: () => undefined },
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
  const fetchBefore = globalThis.fetch;
  Object.assign(globalThis, {
    // the worker reads the catalogs from the extension's own files: a read takes I/O time
    fetch: async (/** @type {string} */ url) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const path = String(url).startsWith(ROOT) ? String(url).slice(ROOT.length) : "";
      return { ok: path !== "", json: async () => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) };
    },
    chrome: {
      runtime,
      i18n: { getMessage: (/** @type {string} */ key) => english[key]?.message ?? "", getUILanguage: () => "en-US" },
      tabs: {
        create: async (/** @type {unknown} */ properties) => void calls.push(["create", properties]),
        update: async (/** @type {number} */ id, /** @type {unknown} */ properties) => {
          calls.push(["update", id, properties]);
          return { id, windowId: 3, active: true };
        },
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
      storage: {
        local: { get: async (/** @type {string} */ key) => (key in stored ? { [key]: stored[key] } : {}) },
        onChanged: {
          addListener: (/** @type {(changes: Record<string, chrome.storage.StorageChange>, area: string) => void} */ listener) =>
            void (on.changed = listener),
        },
      },
    },
  });
  const settle = async () => {
    for (let round = 0; round < 40; round += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  };
  /** @param {"en" | "es"} language */
  const titles = (language) =>
    language === "es" ? ["Descargar este video", "Descargar el video de esta página"] : ["Download this video", "Download this page's video"];
  /** @param {"en" | "es"} language */
  const placed = (language) => {
    const [link, page] = titles(language);
    return [["removeAll"], ["menu", MENU_LINK, link], ["menu", MENU_PAGE, page]];
  };
  /** @returns {[string | number, string][]} */
  const held = () => [...menu.values()].map((item) => [item.id, item.title]);
  try {
    await import("../src/app/background.js");
    const { installed, startup, changed, clicked } = on;
    assert.ok(installed && startup && changed && clicked, "the worker listens to the install, Chrome's start, the Settings and the menu");

    // the install and Chrome's start at once: one after the other, never interleaved; the
    // Settings' Spanish wins over Chrome's English (the catalogs are read before the titles)
    installed();
    startup();
    await settle();
    assert.deepEqual(calls, [...placed("es"), ...placed("es")]);
    assert.deepEqual(held(), [[MENU_LINK, "Descargar este video"], [MENU_PAGE, "Descargar el video de esta página"]]);
    calls.length = 0;

    stored["settings"] = { language: "en" };
    changed({ settings: { oldValue: { language: "es", quality: "best" }, newValue: { language: "en", quality: "best" } } }, "local");
    await settle();
    assert.deepEqual(calls, placed("en"), "the language changed: the menu follows");
    calls.length = 0;
    changed({ settings: { oldValue: { language: "en", quality: "best" }, newValue: { language: "en", quality: "720" } } }, "local");
    changed({ settings: { oldValue: { language: "es" }, newValue: { language: "en" } } }, "session");
    changed({ cooldown: { newValue: { until: 1 } } }, "local");
    await settle();
    assert.deepEqual(calls, [], "nothing else changes the menu");

    // Chrome refuses an item: that install stops there (no unhandled error); the next one puts both
    // in place
    refused = MENU_LINK;
    startup();
    await settle();
    assert.deepEqual(calls, [["removeAll"], ["menu", MENU_LINK, "Download this video"]]);
    assert.deepEqual(held(), []);
    calls.length = 0;
    refused = undefined;
    startup();
    await settle();
    assert.deepEqual(calls, placed("en"));
    assert.deepEqual(held(), [[MENU_LINK, "Download this video"], [MENU_PAGE, "Download this page's video"]]);
    calls.length = 0;

    // no StreamFetch page running: a tab opens with the link (`app.html?links=<page>`)
    const dailymotion = "https://www.dailymotion.com/video/xbq9z2k";
    clicked({ menuItemId: MENU_LINK, linkUrl: "https://dai.ly/xbq9z2k", pageUrl: "https://www.dailymotion.com/us" });
    await settle();
    assert.deepEqual(calls, [
      ["sendMessage", { type: "streamfetch:links", links: dailymotion }],
      ["create", { url: `${ROOT}src/app/app.html?links=${encodeURIComponent(dailymotion)}` }],
    ]);
    calls.length = 0;

    // the engine's tab takes the link and names itself: that tab comes to the front — here the
    // page item in a player embedded in an article (the frame's address)
    contexts = [{ contextType: "TAB", contextId: "c", tabId: 9, windowId: 4, documentUrl: `${ROOT}src/app/app.html`, frameId: 0, incognito: false }];
    answer = { ok: true, tabId: 7 };
    clicked({ menuItemId: MENU_PAGE, pageUrl: "https://news.example/article?id=42", frameUrl: "https://www.dailymotion.com/embed/video/xbq9z2k" });
    await settle();
    assert.deepEqual(calls, [
      ["sendMessage", { type: "streamfetch:links", links: dailymotion }],
      ["update", 7, { active: true }],
      ["focus", 3, { focused: true }],
    ]);
    calls.length = 0;

    // a StreamFetch tab listed, but no page taking the link (a read-only one, say): it reloads
    // with the link
    answer = undefined;
    const bilibili = "https://www.bilibili.com/video/BV1GJ411x7h7?p=3";
    clicked({ menuItemId: MENU_PAGE, pageUrl: "https://www.bilibili.com/video/BV1GJ411x7h7?p=3&spm_id_from=x" });
    await settle();
    assert.deepEqual(calls, [
      ["sendMessage", { type: "streamfetch:links", links: bilibili }],
      ["update", 9, { active: true, url: `${ROOT}src/app/app.html?links=${encodeURIComponent(bilibili)}` }],
      ["focus", 4, { focused: true }],
    ]);
    calls.length = 0;

    // another item's click (none exists) asks nothing
    clicked({ menuItemId: "another-item", linkUrl: "https://dai.ly/xbq9z2k" });
    await settle();
    assert.deepEqual(calls, []);
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
    Object.assign(globalThis, { fetch: fetchBefore });
  }
});
