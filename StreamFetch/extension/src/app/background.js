// @ts-check
/**
 * The service worker: opens the StreamFetch tab — or re-focuses the one already open (one per
 * browser) — when the popup asks or the right-click menu's **Download this video** is clicked
 * (`menus.js`), and hands it the link to add. It holds no long-running work: the engine runs in the
 * StreamFetch tab while that tab is open. The open tab is found with `chrome.runtime.getContexts`
 * (the extension's own documents, Chrome 116+), so no `tabs` permission is needed.
 */

import { displayLanguage, loadCatalogs, t } from "./i18n.js";
import { linkOfClick, menuItems } from "./menus.js";
import { SETTINGS_KEY, loadSettings, loadTestSettings } from "./storage.js";

export const APP_PATH = "src/app/app.html";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Open the StreamFetch tab, or bring the open one to the front; with `links`, add them to its
 * box. The engine's tab (one per browser) takes them and answers with its tab, which comes to the
 * front. When no page answers — no StreamFetch tab is open, or the open one is read-only and its
 * engine's tab was closed, or its page is not running (Chrome never discards an extension's page
 * on its own, but `chrome://discards` or a tab-suspending extension can) — the links travel in the
 * address of a tab that (re)loads with them, since a message to a page that is not running would
 * be lost: the open StreamFetch tab, else a new one. The open tab is found with
 * `chrome.runtime.getContexts` (no `tabs` permission needed), which may not list a tab whose page
 * is not running — a tab Chrome restored after a restart but has not loaded yet is never listed —:
 * then a new tab opens, and the old one shows it is read-only once it loads.
 * @param {string | null} links
 * @returns {Promise<void>}
 */
export async function openApp(links) {
  const appUrl = chrome.runtime.getURL(APP_PATH);
  if (links) {
    const answer = await chrome.runtime.sendMessage({ type: "streamfetch:links", links }).catch(() => undefined);
    if (isRecord(answer) && answer["ok"] === true) {
      const tabId = answer["tabId"];
      const tab = typeof tabId === "number" ? await chrome.tabs.update(tabId, { active: true }) : undefined;
      if (tab !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  }
  const url = links ? `${appUrl}?links=${encodeURIComponent(links)}` : appUrl;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
  const existing = contexts.find((context) => (context.documentUrl ?? "").startsWith(appUrl));
  if (existing !== undefined && existing.tabId >= 0) {
    await chrome.tabs.update(existing.tabId, links ? { active: true, url } : { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

/**
 * The worker's message handler: only this extension's own pages may ask (web pages cannot reach
 * it: no `externally_connectable`), and only `streamfetch:open`.
 * @param {unknown} message
 * @param {chrome.runtime.MessageSender} sender
 * @param {(response?: unknown) => void} sendResponse
 * @returns {boolean} whether the answer comes asynchronously
 */
export function onMessage(message, sender, sendResponse) {
  if (sender.id !== chrome.runtime.id) return false;
  if (!isRecord(message) || message["type"] !== "streamfetch:open") return false;
  const links = typeof message["links"] === "string" && message["links"] ? message["links"] : null;
  openApp(links).then(
    () => sendResponse({ ok: true }),
    (error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
}

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
 * Put the right-click items in place again, titled in the language the pages show (the Settings'
 * choice, or Chrome's): at install, at every update (a reload of the unpacked folder too), at every
 * start of Chrome and when the Settings' language changes.
 * @returns {Promise<void>}
 */
export function installMenus() {
  const install = async () => {
    await loadCatalogs();
    const language = displayLanguage(await loadSettings());
    const items = menuItems(t("contextDownload", undefined, language), t("contextDownloadPage", undefined, language));
    await menuCall((done) => chrome.contextMenus.removeAll(done));
    for (const item of items) {
      await menuCall((done) => void chrome.contextMenus.create(item, done));
    }
  };
  menusInPlace = menusInPlace.then(install, install);
  return menusInPlace;
}

/**
 * A click of the menu: the StreamFetch tab opened or focused with the link added to its box,
 * exactly as the popup's **Download this video** does (the fake sites' bases in test mode).
 * @param {chrome.contextMenus.OnClickData} info
 * @returns {Promise<void>}
 */
export async function onMenuClicked(info) {
  const test = await loadTestSettings();
  const link = linkOfClick(info, test.baseUrls ?? {});
  if (link !== null) await openApp(link);
}

/**
 * The Settings saved with another language: the menu follows the pages.
 * @param {Record<string, chrome.storage.StorageChange>} changes
 * @param {string} area
 */
export function onStorageChanged(changes, area) {
  const change = area === "local" ? changes[SETTINGS_KEY] : undefined;
  if (change === undefined) return;
  /** @param {unknown} value */
  const languageOf = (value) => (isRecord(value) ? value["language"] : undefined);
  if (languageOf(change.oldValue) === languageOf(change.newValue)) return;
  void installMenus().catch(() => undefined);
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.runtime.onInstalled.addListener(() => void installMenus().catch(() => undefined));
  chrome.runtime.onStartup.addListener(() => void installMenus().catch(() => undefined));
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.contextMenus.onClicked.addListener((info) => {
    void onMenuClicked(info).catch(() => undefined);
  });
}
