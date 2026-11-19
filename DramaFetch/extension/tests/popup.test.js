// @ts-check
// The toolbar popup (src/app/popup.js) over a fake document and a fake `chrome`: on a TikTok
// profile whose favorites list the worker saw, **Open my library · N dramas** hands that tab over
// (the message 1.5.0's Choose from your favorites sent: the DramaFetch tab updates the library from
// it); on such a page before the list was shown, the 1.5.0 hint stays; anywhere else, when a
// library is kept, the same button opens the DramaFetch tab on the library — no job, no request.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const PROFILE = "https://www.tiktok.com/@invented_viewer";
const SERIES = "7699393770256782354";

/** One element of popup.html as popup.js uses it. */
class Element {
  constructor() {
    this.hidden = true;
    this.textContent = "";
    /** @type {(() => void)[]} */
    this.clicks = [];
  }
  /** @param {string} type @param {() => void} listener */
  addEventListener(type, listener) {
    if (type === "click") this.clicks.push(listener);
  }
  click() {
    for (const listener of this.clicks) listener();
  }
}

let loads = 0;

/**
 * popup.js loaded (a fresh instance) over a fake document and `chrome`: the active tab's address,
 * the favorites addresses the worker kept (session) and the library kept (local).
 * @param {{url: string, template?: boolean, library?: Record<string, unknown> | null}} options
 */
async function popup(options) {
  /** @type {Record<string, {message: string, placeholders?: Record<string, {content: string}>}>} */
  const catalog = JSON.parse(readFileSync(new URL("../_locales/en/messages.json", import.meta.url), "utf8"));
  /** @type {Map<string, Element>} */
  const elements = new Map();
  for (const id of ["popup-version", "popup-series", "popup-download", "popup-favorites", "popup-favorites-hint", "popup-library", "popup-open"]) elements.set(id, new Element());
  /** @type {unknown[]} */
  const sent = [];
  let closed = 0;
  /** @type {unknown[]} */
  const localKeys = [];
  const chrome = {
    runtime: {
      getManifest: () => ({ manifest_version: 3, name: "DramaFetch", version: "1.6.0" }),
      sendMessage: async (/** @type {unknown} */ message) => void sent.push(message),
    },
    i18n: {
      getUILanguage: () => "en-US",
      /** @param {string} key @param {string[]} [substitutions] */
      getMessage: (key, substitutions = []) => {
        const entry = catalog[key];
        if (entry === undefined) return "";
        return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (_match, name) => {
          const known = Object.entries(entry.placeholders ?? {}).find(([placeholder]) => placeholder.toLowerCase() === String(name).toLowerCase());
          return known === undefined ? "" : (substitutions[Number(known[1].content.slice(1)) - 1] ?? "");
        });
      },
    },
    tabs: { query: async () => [{ id: 42, index: 0, windowId: 1, active: true, url: options.url }] },
    storage: {
      local: {
        get: async (/** @type {string} */ key) => {
          localKeys.push(key);
          return key === "favoritesLibrary" && options.library ? { favoritesLibrary: options.library } : {};
        },
      },
      session: {
        get: async (/** @type {string} */ key) =>
          options.template && key === "favoritesTemplate:42"
            ? { [key]: { url: "https://www.tiktok.com/api/user/favorite/drama_list/?aid=1988&count=19&cursor=0", at: 1_794_351_500 } }
            : {},
      },
    },
  };
  Object.assign(globalThis, {
    chrome,
    document: {
      documentElement: { lang: "" },
      getElementById: (/** @type {string} */ id) => elements.get(id) ?? null,
      querySelectorAll: () => [],
    },
    window: { close: () => void (closed += 1) },
  });
  const restore = () => {
    for (const name of ["chrome", "document", "window"]) Reflect.deleteProperty(globalThis, name);
  };
  try {
    const url = new URL("../src/app/popup.js", import.meta.url);
    url.search = `?load=${(loads += 1)}`;
    await import(url.href);
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  } catch (error) {
    restore();
    throw error;
  }
  /** a button's click, and what it sent once its message went out */
  const click = async (/** @type {string} */ id) => {
    /** @type {Element} */ (elements.get(id)).click();
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { elements, sent, closed: () => closed, localKeys, click, restore };
}

/** A library as `chrome.storage.local` keeps it, TikTok counting `total`. @param {number} total */
const library = (total) => ({ v: 1, listedAt: 1_800_000_000, total, complete: true, short: false, ended: null, profile: "@invented_viewer", items: [{ seriesId: "7712345678901234561", title: "A", episodes: 3, durationS: 9 }], removed: [] });

test("on a TikTok profile whose favorites list the worker saw: Open my library · N dramas hands that tab over — the message 1.5.0's Choose from your favorites sent", async () => {
  const shown = await popup({ url: PROFILE, template: true, library: library(946) });
  try {
    const { elements, sent, closed } = shown;
    const button = /** @type {Element} */ (elements.get("popup-favorites"));
    assert.equal(button.hidden, false);
    assert.equal(button.textContent, "Open my library · 946 dramas");
    assert.equal(elements.get("popup-library")?.hidden, true);
    assert.equal(elements.get("popup-favorites-hint")?.hidden, true);
    await shown.click("popup-favorites");
    assert.deepEqual(sent, [{ type: "dramafetch:open", favorites: 42 }]);
    assert.equal(closed(), 1);
  } finally {
    shown.restore();
  }
  // no library kept yet: the same hand-over, without a count
  const first = await popup({ url: PROFILE, template: true, library: null });
  try {
    assert.equal(first.elements.get("popup-favorites")?.textContent, "Open my library");
  } finally {
    first.restore();
  }
});

test("on a TikTok profile before its favorites list was shown: the 1.5.0 hint — and, with a library kept, Open my library opens it as it is (no job, no request)", async () => {
  const shown = await popup({ url: PROFILE, template: false, library: library(945) });
  try {
    const { elements, sent } = shown;
    assert.equal(elements.get("popup-favorites")?.hidden, true);
    assert.equal(elements.get("popup-favorites-hint")?.hidden, false);
    const button = /** @type {Element} */ (elements.get("popup-library"));
    assert.equal(button.hidden, false);
    assert.equal(button.textContent, "Open my library · 945 dramas");
    await shown.click("popup-library");
    assert.deepEqual(sent, [{ type: "dramafetch:open", library: true }]);
  } finally {
    shown.restore();
  }
  const none = await popup({ url: PROFILE, template: false, library: null });
  try {
    assert.equal(none.elements.get("popup-library")?.hidden, true);
    assert.equal(none.elements.get("popup-favorites-hint")?.hidden, false);
  } finally {
    none.restore();
  }
});

test("anywhere else: Open my library with a library kept, nothing without one; a series tab keeps Download this series", async () => {
  const elsewhere = await popup({ url: "https://example.com/", library: library(12) });
  try {
    assert.equal(elsewhere.elements.get("popup-library")?.hidden, false);
    assert.equal(elsewhere.elements.get("popup-library")?.textContent, "Open my library · 12 dramas");
    assert.equal(elsewhere.elements.get("popup-favorites")?.hidden, true);
    assert.equal(elsewhere.elements.get("popup-favorites-hint")?.hidden, true);
  } finally {
    elsewhere.restore();
  }
  const bare = await popup({ url: "https://example.com/", library: null });
  try {
    assert.equal(bare.elements.get("popup-library")?.hidden, true);
  } finally {
    bare.restore();
  }
  const series = await popup({ url: `https://www.tiktok.com/shortdrama/episode/${SERIES}/1`, library: library(12) });
  try {
    assert.equal(series.elements.get("popup-download")?.hidden, false);
    assert.equal(series.elements.get("popup-library")?.hidden, false);
    await series.click("popup-download");
    assert.deepEqual(series.sent, [{ type: "dramafetch:open", load: SERIES }]);
  } finally {
    series.restore();
  }
});
