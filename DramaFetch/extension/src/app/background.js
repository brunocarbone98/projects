// @ts-check
/**
 * The service worker: opens the DramaFetch tab — or re-focuses the one already open (one per
 * browser) — when the popup asks, and hands it a series to download (the popup's **Download this
 * series**; DramaFetch 1.7.0: the job a paste of it queues). It holds no long-running work: the
 * engine runs in the DramaFetch tab while that tab is open. When that tab goes away in the middle
 * of a listing — closed, navigated elsewhere or discarded, so its own clean-up never runs — the
 * worker closes the muted TikTok tab the listing had open (`discovery.DISCOVERY_TAB_KEY`). It
 * answers only the extension's own pages and worker (`senders.isOwnSender`). DramaFetch 2.0.0 (the
 * owner's decision of 2026-11-22) took the right-click items and the favorites card reader they
 * asked away: the worker puts no menu in place and the manifest grants no context-menu permission.
 * DramaFetch 4.0.0 (the owner's decision of 2026-11-27: no library, nothing read of the user's
 * TikTok Favorites) took the rest of what it did in the user's own TikTok tabs away: it observes no
 * request of theirs (no `webRequest` listener at all), keeps no address of theirs, and hands the
 * DramaFetch tab no favorites and no library.
 *
 * And it answers the clicks on the notifications the DramaFetch tab shows when a drama finishes
 * (DramaFetch 1.7.0, `alerts.js`): a click on one brings the DramaFetch tab to the front
 * ({@link openApp}, no hand-over) and takes the notification away; its **Retry** button is handed
 * to the page that made it (`dramafetch:retry`), which queues the retry as the tab's own **Retry**
 * does — when no running page holds it (the tab was closed or reloaded since), the button only
 * opens or focuses the DramaFetch tab. The worker itself never makes a request.
 *
 * At every start (DramaFetch 2.0.1) it first keeps `chrome.storage.local` to the extension's own
 * pages and itself ({@link restrictStorageToTrustedContexts}).
 */

import { isAlertId } from "./alerts.js";
import { closeLeftoverDiscoveryTab } from "./discovery.js";
import { isOwnSender } from "./senders.js";

const APP_PATH = "src/app/app.html";

/**
 * Keep what DramaFetch stores in `chrome.storage.local` — each series' progress, the settings, the
 * pacing, the cooldown — to its own pages and this worker (DramaFetch 2.0.1, issue
 * #112): `TRUSTED_CONTEXTS`, so that no script running in a web page under the extension's id can
 * read or change it, nor hear its changes. DramaFetch declares no content script; the functions it
 * injects into TikTok tabs in the ISOLATED world (the discovery's scroll and page-text reads) use
 * no storage. `chrome.storage.session` is kept so by Chrome already. Chrome honours the level for
 * `local` from Chrome 140 on and keeps it in the profile; Chrome 116–139
 * refuse it (`This StorageArea is not available for setting access level`), and the area stays as
 * it was, as in 2.0.0. Called once, at the top level: at every start of the worker, before its
 * listeners. It never throws and never rejects — a missing method, a synchronous throw and a
 * refusal all leave the worker as it is.
 * @returns {Promise<void>}
 */
export async function restrictStorageToTrustedContexts() {
  try {
    await chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // refused (Chrome 116–139 for `local`) or not there: the area keeps Chrome's default
  }
}

void restrictStorageToTrustedContexts();

/**
 * @typedef {{load: string}} Handover What the DramaFetch tab is handed: a series to download (an
 *   address or an id, as the box reads it — the popup's **Download this series**).
 */

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
 * Open the DramaFetch tab, or bring the open one to the front; with a hand-over, have it download
 * that series (`dramafetch:load`). The engine's tab (one per browser) takes it and answers with its
 * tab, which comes to the front. When no page answers — no DramaFetch tab is open, or the open
 * one's page is not running (Chrome restored it after a restart without loading it yet, or it was
 * discarded: Chrome never discards an extension's page on its own, but `chrome://discards` or a
 * tab-suspending extension can), or the one open is read-only and its engine's tab was closed —
 * the hand-over travels in the address of a tab that (re)loads with it (`?load=…`): the open
 * DramaFetch tab, else a new one. A message to a page that is not running would be lost.
 * @param {Handover | null} handover
 * @returns {Promise<void>}
 */
async function openApp(handover) {
  const appUrl = chrome.runtime.getURL(APP_PATH);
  if (handover !== null) {
    const answer = await chrome.runtime.sendMessage({ type: "dramafetch:load", input: handover.load }).catch(() => undefined);
    if (isRecord(answer) && answer["ok"] === true) {
      const tabId = answer["tabId"];
      const tab = typeof tabId === "number" ? await chrome.tabs.update(tabId, { active: true }) : undefined;
      if (tab !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  }
  // a query, not a fragment: an open DramaFetch tab reloads with it
  const suffix = handover === null ? "" : `?load=${encodeURIComponent(handover.load)}`;
  const url = `${appUrl}${suffix}`;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => (tab.url ?? "").startsWith(appUrl));
  if (existing !== undefined && existing.id !== undefined) {
    await chrome.tabs.update(existing.id, suffix ? { active: true, url } : { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own pages may ask (web pages cannot reach it: no externally_connectable);
  // a sender in a web page's frame never passes — DramaFetch declares no content script since 2.0.0,
  // but the functions it injects into the TikTok tabs it works in run in the ISOLATED world, where a
  // message carries this extension's id (the discovery's scroll and page-text reads): this check
  // keeps every such sender out, a guard against a TikTok renderer gone wrong
  if (!isOwnSender(sender)) return false;
  if (!isRecord(message) || message["type"] !== "dramafetch:open") return false;
  const load = typeof message["load"] === "string" && message["load"] ? message["load"] : null;
  /** @type {Handover | null} the popup's Download this series; anything else is its Open DramaFetch */
  const handover = load !== null ? { load } : null;
  openApp(handover).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true; // the answer comes asynchronously
});

/**
 * Take a notification away; Chrome's refusal is ignored (it may be gone already).
 * @param {string} notificationId
 * @returns {Promise<void>}
 */
async function clearAlert(notificationId) {
  await chrome.notifications.clear(notificationId).catch(() => undefined);
}

/**
 * A notification's **Retry**: handed to the DramaFetch pages (`dramafetch:retry`). The page that
 * made it queues the retry — the tab's own **Retry** for that drama — and takes the notification
 * away; when its gate refuses (a cooldown in force), that page comes to the front, where the
 * banner says until when. When no running page holds it (the tab was closed or reloaded since),
 * the button only opens or focuses the DramaFetch tab: nothing is queued, and the worker asks
 * TikTok for nothing.
 * @param {string} notificationId
 * @returns {Promise<void>}
 */
async function retryFromAlert(notificationId) {
  const answer = await chrome.runtime.sendMessage({ type: "dramafetch:retry", notificationId }).catch(() => undefined);
  if (isRecord(answer) && answer["ok"] === true) {
    if (answer["queued"] === true) return;
    const tabId = answer["tabId"];
    const tab = typeof tabId === "number" ? await chrome.tabs.update(tabId, { active: true }) : undefined;
    if (tab !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  await clearAlert(notificationId);
  await openApp(null);
}

// a copy of the extension without the `notifications` permission has no API: nothing to answer
chrome.notifications?.onClicked.addListener((notificationId) => {
  if (!isAlertId(notificationId)) return;
  void clearAlert(notificationId);
  void openApp(null).catch(() => undefined); // the DramaFetch tab to the front, nothing handed over
});
chrome.notifications?.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (!isAlertId(notificationId) || buttonIndex !== 0) return;
  void retryFromAlert(notificationId).catch(() => undefined);
});
