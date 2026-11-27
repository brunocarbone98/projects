// @ts-check
// The toolbar popup (src/app/popup.js) over a fake document and a fake `chrome`: everywhere **Open
// DramaFetch** and its hint (never hidden); on a TikTok drama page also the series and **Download
// this series** (its id handed to the DramaFetch tab: the job a paste of it queues). It reads the
// active tab's address and nothing stored (DramaFetch 4.0.0: no library, nothing of the user's
// TikTok Favorites — the fake chrome has no storage at all, so a popup that reached for it would
// throw).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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

/** The ids popup.html gives its elements. */
const IDS = ["popup-version", "popup-series", "popup-download", "popup-open"];

let loads = 0;

/**
 * popup.js loaded (a fresh instance) over a fake document and `chrome`: the active tab's address,
 * and nothing else — no storage.
 * @param {{url: string}} options
 */
async function popup(options) {
  /** @type {Record<string, {message: string, placeholders?: Record<string, {content: string}>}>} */
  const catalog = JSON.parse(readFileSync(new URL("../_locales/en/messages.json", import.meta.url), "utf8"));
  /** @type {Map<string, Element>} */
  const elements = new Map();
  for (const id of IDS) elements.set(id, new Element());
  /** @type {unknown[]} */
  const sent = [];
  let closed = 0;
  const chrome = {
    runtime: {
      getManifest: () => ({ manifest_version: 3, name: "DramaFetch", version: "4.0.0" }),
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
  return { elements, sent, closed: () => closed, click, restore };
}

test("popup.html: the series line, Download this series, Open DramaFetch and its hint — no Open my library, no Favorites hint (DramaFetch 4.0.0)", () => {
  const html = readFileSync(new URL("../src/app/popup.html", import.meta.url), "utf8");
  assert.deepEqual([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]), IDS);
  assert.doesNotMatch(html, /popup-favorites|popup-library|popupLibrary|popupFavorites|library|favorit/i);
  assert.match(html, /<p class="hint" data-i18n="popupHint">/); // shown everywhere: no `hidden` in its markup (popup.js changes only the series' and its button's)
});

test("on a TikTok drama page: the series and Download this series — its id handed over, the popup closed —; Open DramaFetch there too", async () => {
  const series = await popup({ url: `https://www.tiktok.com/shortdrama/episode/${SERIES}/1` });
  try {
    const { elements, sent, closed } = series;
    assert.equal(elements.get("popup-series")?.hidden, false);
    assert.equal(elements.get("popup-series")?.textContent, `Series ${SERIES}`);
    assert.equal(elements.get("popup-download")?.hidden, false);
    assert.equal(elements.get("popup-version")?.textContent, "4.0.0");
    await series.click("popup-download");
    assert.deepEqual(sent, [{ type: "dramafetch:open", load: SERIES }]);
    assert.equal(closed(), 1);
  } finally {
    series.restore();
  }
  const again = await popup({ url: `https://www.tiktok.com/shortdrama/episode/${SERIES}/7` });
  try {
    await again.click("popup-open");
    assert.deepEqual(again.sent, [{ type: "dramafetch:open", load: null }]);
    assert.equal(again.closed(), 1);
  } finally {
    again.restore();
  }
});

test("anywhere else — a TikTok profile (its Favorites shown or not), TikTok's feed, any other site —: Open DramaFetch and its hint alone, which opens the DramaFetch tab with nothing handed over", async () => {
  for (const url of ["https://www.tiktok.com/@invented_viewer", "https://www.tiktok.com/foryou", "https://example.com/"]) {
    const elsewhere = await popup({ url });
    try {
      const { elements, sent } = elsewhere;
      assert.equal(elements.get("popup-series")?.hidden, true, url);
      assert.equal(elements.get("popup-download")?.hidden, true, url);
      assert.deepEqual(sent, [], url); // nothing asked of the worker until a click
      await elsewhere.click("popup-download"); // hidden, and never wired: nothing
      assert.deepEqual(sent, [], url);
      await elsewhere.click("popup-open");
      assert.deepEqual(sent, [{ type: "dramafetch:open", load: null }], url);
      assert.equal(elsewhere.closed(), 1, url);
    } finally {
      elsewhere.restore();
    }
  }
});
