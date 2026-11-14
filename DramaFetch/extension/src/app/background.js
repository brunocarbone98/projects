// @ts-check
/**
 * The service worker: opens the DramaFetch tab — or re-focuses the one already open (one per
 * browser) — when the popup asks or the right-click menu's **Download this drama** is clicked
 * (`menus.js`), and hands it a series to list. It holds no long-running work: the engine runs in
 * the DramaFetch tab while that tab is open. When that tab goes away in the middle of a listing —
 * closed, navigated elsewhere or discarded, so its own clean-up never runs — the worker closes the
 * muted TikTok tab the listing had open (`discovery.DISCOVERY_TAB_KEY`).
 */

import { TIKTOK_BASE_URL } from "../lib/messages.js";
import { closeLeftoverDiscoveryTab } from "./discovery.js";
import { t } from "./i18n.js";
import { loadOfClick, menuItems } from "./menus.js";
import { loadTestSettings } from "./storage.js";

const APP_PATH = "src/app/app.html";

chrome.tabs.onRemoved.addListener((tabId) => {
  void closeLeftoverDiscoveryTab(tabId).catch(() => undefined);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const leftTheApp = changeInfo.url !== undefined && !changeInfo.url.startsWith(chrome.runtime.getURL(APP_PATH));
  if (leftTheApp || changeInfo.discarded === true) void closeLeftoverDiscoveryTab(tabId).catch(() => undefined);
});

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Open the DramaFetch tab, or bring the open one to the front; with `load`, have it list that
 * series. The engine's tab (one per browser) takes the series and answers with its tab, which
 * comes to the front. When no page answers — no DramaFetch tab is open, or the open one's page is
 * not running (Chrome restored it after a restart without loading it yet, or it was discarded:
 * Chrome never discards an extension's page on its own, but `chrome://discards` or a
 * tab-suspending extension can), or the one open is read-only and its engine's tab was closed —
 * the series travels in the address of a tab that (re)loads with it: the open DramaFetch tab,
 * else a new one. A message to a page that is not running would be lost.
 * @param {string | null} load
 * @returns {Promise<void>}
 */
async function openApp(load) {
  const appUrl = chrome.runtime.getURL(APP_PATH);
  if (load) {
    const answer = await chrome.runtime.sendMessage({ type: "dramafetch:load", input: load }).catch(() => undefined);
    if (isRecord(answer) && answer["ok"] === true) {
      const tabId = answer["tabId"];
      const tab = typeof tabId === "number" ? await chrome.tabs.update(tabId, { active: true }) : undefined;
      if (tab !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  }
  const url = load ? `${appUrl}?load=${encodeURIComponent(load)}` : appUrl;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => (tab.url ?? "").startsWith(appUrl));
  if (existing !== undefined && existing.id !== undefined) {
    await chrome.tabs.update(existing.id, load ? { active: true, url } : { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own code may ask (web pages cannot reach it: no externally_connectable).
  if (sender.id !== chrome.runtime.id) return false;
  if (!isRecord(message) || message["type"] !== "dramafetch:open") return false;
  const load = typeof message["load"] === "string" && message["load"] ? message["load"] : null;
  openApp(load).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true; // the answer comes asynchronously
});

/**
 * A contextMenus call as a promise: Chrome reports the call's outcome to its callback, a failure in
 * `chrome.runtime.lastError` (`removeAll` returns a promise only from Chrome 123 on; `create` never
 * does: it returns the item's id at once, and only the callback learns whether Chrome took it).
 * @param {(done: () => void) => void} call
 * @returns {Promise<void>}
 */
function menuCall(call) {
  return new Promise((resolve, reject) => {
    call(() => {
      const error = chrome.runtime.lastError;
      if (error === undefined) resolve();
      else reject(new Error(error.message ?? "the menu could not be changed"));
    });
  });
}

/** The latest putting in place of the menu: one at a time, never two at once. */
let menusInPlace = Promise.resolve();

/**
 * Put the right-click items in place again, titled in Chrome's language: at install, at every
 * update (a reload of the unpacked folder too) and at every start of Chrome.
 * @returns {Promise<void>}
 */
function installMenus() {
  const install = async () => {
    await menuCall((done) => chrome.contextMenus.removeAll(done));
    for (const item of menuItems(t("contextDownload"), t("contextDownloadPage"))) {
      await menuCall((done) => void chrome.contextMenus.create(item, done));
    }
  };
  menusInPlace = menusInPlace.then(install, install);
  return menusInPlace;
}

chrome.runtime.onInstalled.addListener(() => void installMenus().catch(() => undefined));
chrome.runtime.onStartup.addListener(() => void installMenus().catch(() => undefined));
chrome.contextMenus.onClicked.addListener((info) => {
  const answer = async () => {
    const test = await loadTestSettings();
    const load = loadOfClick(info, test.baseUrl ?? TIKTOK_BASE_URL);
    if (load !== null) await openApp(load);
  };
  void answer().catch(() => undefined);
});
