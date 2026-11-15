// @ts-check
// Who may message DramaFetch's worker and the DramaFetch tab (src/app/senders.js `isOwnSender`,
// used by both `runtime.onMessage` handlers): the extension's own pages and its service worker —
// never a web page, although the content script runs in every www.tiktok.com page with the
// extension's id. Over a fake `chrome.runtime` (its id and `getURL`); the handlers themselves are
// driven in tests/menus.test.js (the worker) and tests/app.test.js (the page).
import assert from "node:assert/strict";
import { test } from "node:test";

import { isOwnSender } from "../src/app/senders.js";

const ID = "dramafetch-test-id";
const ROOT = `chrome-extension://${ID}/`;

test("the extension's own pages and worker are its own senders; a TikTok page with its id, an address elsewhere and another extension are not", () => {
  Object.assign(globalThis, { chrome: { runtime: { id: ID, getURL: (/** @type {string} */ path) => `${ROOT}${path}` } } });
  try {
    const tiktokTab = { id: 42, index: 0, windowId: 2, active: true, url: "https://www.tiktok.com/@invented_viewer" };
    const appTab = { id: 3, index: 0, windowId: 1, active: true, url: `${ROOT}src/app/app.html` };
    for (const sender of /** @type {chrome.runtime.MessageSender[]} */ ([
      { id: ID, url: `${ROOT}src/app/popup.html` }, // the popup
      { id: ID, url: `${ROOT}src/app/app.html?load=7699393770256782354`, tab: appTab }, // a DramaFetch tab
      { id: ID, url: `${ROOT}src/app/background.js` }, // the service worker, as Chrome may name it
      { id: ID }, // the service worker without an address
    ])) {
      assert.equal(isOwnSender(sender), true, JSON.stringify(sender));
    }
    for (const sender of /** @type {chrome.runtime.MessageSender[]} */ ([
      { id: ID, url: "https://www.tiktok.com/@invented_viewer", tab: tiktokTab }, // the content script's page
      { id: ID, url: "https://www.tiktok.com/@invented_viewer" },
      { id: ID, url: "http://127.0.0.1:8123/@invented_viewer", tab: tiktokTab }, // the fake TikTok's page (test mode)
      { id: ID, tab: tiktokTab }, // a tab but no address: no worker sends from a tab
      { id: ID, url: "" },
      { id: ID, url: `chrome-extension://another-extension/src/app/popup.html` },
      { id: ID, url: `chrome-extension://${ID}.evil.example/` }, // not under the extension's own origin
      { id: ID, url: `https://evil.example/chrome-extension://${ID}/` },
      { id: "another-extension", url: `${ROOT}src/app/popup.html` },
      { url: `${ROOT}src/app/popup.html` }, // no id at all
      {},
    ])) {
      assert.equal(isOwnSender(sender), false, JSON.stringify(sender));
    }
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});
