// @ts-check
/**
 * The service worker: opens the DramaFetch tab — or re-focuses the one already open (one per
 * browser) — when the popup asks or a right-click item is clicked (`menus.js`: **Download this
 * drama**, **Download this page's drama**, **Download this favorite drama**), and hands it a series
 * to list, or the favorites of a TikTok tab to show. It holds no long-running work: the engine runs
 * in the DramaFetch tab while that tab is open. When that tab goes away in the middle of a listing
 * — closed, navigated elsewhere or discarded, so its own clean-up never runs — the worker closes
 * the muted TikTok tab the listing had open (`discovery.DISCOVERY_TAB_KEY`). It answers only the
 * extension's own pages (`senders.isOwnSender`: never a content script).
 *
 * It also OBSERVES — URLs and status codes only, never a body, never blocking, never changing
 * anything — the `drama_list` requests the user's own TikTok tabs make when their profile's
 * **Favorites** → **Drama** list is shown (the owner's decision of 2026-11-15; Chrome hands the
 * worker only the URLs holding `drama_list`, {@link favoritesObserverUrls}): per tab, the most
 * recent FIRST page of the favorites list that completed with HTTP 200 —
 * `lib/favorites.isFavoritesFirstPageUrl`: its address holds `favorite` and its `cursor` is absent,
 * empty or `0`; a later page, the page's own as its grid scrolls or one the DramaFetch tab asked
 * for, never replaces it — is kept in `chrome.storage.session` (`storage.rememberFavoritesTemplate`;
 * in memory for the browser session, never logged, never in a report or the history: it carries
 * TikTok's signature parameters) with whose list it reads — the `@handle` of the profile page that
 * asked for it ({@link keepFavoritesTemplate}) — and forgotten when the tab closes. That URL is the
 * template the DramaFetch tab reads the list with (`favorites.js`): its first page replayed
 * unchanged; that handle is the library's profile when the list becomes the library.
 */

import { cardOf, favoritesQuery, isFavoritesFirstPageUrl } from "../lib/favorites.js";
import { profileHandleOf } from "../lib/library.js";
import { TIKTOK_BASE_URL } from "../lib/messages.js";
import { closeLeftoverDiscoveryTab, observedUrlPatterns } from "./discovery.js";
import { t } from "./i18n.js";
import { MENU_CARD, loadOfClick, menuItems } from "./menus.js";
import { isOwnSender } from "./senders.js";
import { forgetFavoritesTemplate, loadTestSettings, readFavoritesTemplate, rememberFavoritesTemplate } from "./storage.js";

const APP_PATH = "src/app/app.html";

/**
 * @typedef {import("../lib/favorites.js").Card} Card
 * @typedef {import("../lib/favorites.js").FavoritesHandover} FavoritesHandover
 *
 * @typedef {{load: string} | {favorites: FavoritesHandover} | {library: true}} Handover What the
 *   DramaFetch tab is handed: a series to list (an address or an id, as the box reads it), the
 *   favorites of a TikTok tab to show — with the right-clicked card to list, when there is one —,
 *   or the library to show as it is kept (the popup's **Open my library** away from a TikTok
 *   profile: no job, no request).
 */

/**
 * The URLs the worker hears complete: those holding `drama_list` on TikTok's hosts
 * (`discovery.observedUrlPatterns`) and — in the harness' test copy only (`dramafetch_test`) — on
 * the fake TikTok's, the plain-http host permission that copy adds. Chrome filters them, so no other
 * request of the user's TikTok tabs reaches the worker or starts it; the listener itself keeps only
 * the favorites list's first page (`isFavoritesFirstPageUrl`).
 * @param {chrome.runtime.Manifest} manifest
 * @returns {string[]}
 */
export function favoritesObserverUrls(manifest) {
  /** @param {string} pattern a whole host, `…/*` @returns {string} its URLs that hold `drama_list` */
  const narrow = (pattern) => pattern.replace(/\/\*$/, "/*drama_list*");
  const urls = observedUrlPatterns(TIKTOK_BASE_URL).map(narrow);
  if (manifest.dramafetch_test !== true) return urls;
  return [...urls, ...(manifest.host_permissions ?? []).filter((pattern) => pattern.startsWith("http://")).map(narrow)];
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    // a tab's own first page of its favorites list, answered: its URL and when (never a body, never
    // a header); a later page never replaces it — the first page is the one replayed unchanged
    if (details.tabId < 0 || details.statusCode !== 200 || !isFavoritesFirstPageUrl(details.url)) return;
    void keepFavoritesTemplate(details.tabId, details.url, details.timeStamp / 1000).catch(() => undefined);
  },
  { urls: favoritesObserverUrls(chrome.runtime.getManifest()), types: ["xmlhttprequest"] },
);

/**
 * Keep TikTok tab `tabId`'s first page of its favorites list with whose list it reads: the
 * `@handle` of the profile page that asked for it — the tab's address as it completed
 * (`lib/library.profileHandleOf`; null on no profile page, or the tab gone) —, unless it is the
 * address kept for that tab already, byte for byte: DramaFetch's own replay of it (a listing's first
 * page, the count after a removal), made from wherever the tab is by then, keeps the handle kept
 * with it. The tab's address is read with the `tabs` permission DramaFetch holds; nothing else.
 * @param {number} tabId
 * @param {string} url
 * @param {number} at seconds since the epoch
 * @returns {Promise<void>}
 */
async function keepFavoritesTemplate(tabId, url, at) {
  const kept = await readFavoritesTemplate(tabId).catch(() => null);
  let profile;
  if (kept !== null && kept.url === url) profile = kept.profile;
  else {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    profile = profileHandleOf(tab?.url || tab?.pendingUrl || "");
  }
  await rememberFavoritesTemplate(tabId, url, at, profile);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void closeLeftoverDiscoveryTab(tabId).catch(() => undefined);
  void forgetFavoritesTemplate(tabId).catch(() => undefined);
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
 * @param {unknown} value
 * @returns {value is number}
 */
function isTabId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Open the DramaFetch tab, or bring the open one to the front; with a hand-over, have it list that
 * series (`dramafetch:load`), show that TikTok tab's favorites (`dramafetch:favorites`) or show the
 * library as it is kept (`dramafetch:library`: no job, no request). The engine's tab (one per
 * browser) takes it and answers with its tab, which comes to the front. When no page answers — no
 * DramaFetch tab is open, or the open one's page is not running (Chrome restored it after a restart
 * without loading it yet, or it was discarded: Chrome never discards an extension's page on its
 * own, but `chrome://discards` or a tab-suspending extension can), or the one open is read-only and
 * its engine's tab was closed — the hand-over travels in the address of a tab that (re)loads with
 * it (`?load=…`, `?favorites=…`, `?library=1`): the open DramaFetch tab, else a new one. A message
 * to a page that is not running would be lost.
 * @param {Handover | null} handover
 * @returns {Promise<void>}
 */
async function openApp(handover) {
  const appUrl = chrome.runtime.getURL(APP_PATH);
  if (handover !== null) {
    const message =
      "load" in handover
        ? { type: "dramafetch:load", input: handover.load }
        : "favorites" in handover
          ? { type: "dramafetch:favorites", ...handover.favorites }
          : { type: "dramafetch:library" };
    const answer = await chrome.runtime.sendMessage(message).catch(() => undefined);
    if (isRecord(answer) && answer["ok"] === true) {
      const tabId = answer["tabId"];
      const tab = typeof tabId === "number" ? await chrome.tabs.update(tabId, { active: true }) : undefined;
      if (tab !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  }
  const suffix =
    handover === null
      ? ""
      : "load" in handover
        ? `?load=${encodeURIComponent(handover.load)}`
        : "favorites" in handover
          ? `?${favoritesQuery(handover.favorites)}`
          : "?library=1"; // a query, not a fragment: an open DramaFetch tab reloads, as for `?load=`
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
  // Only this extension's own pages may ask (web pages cannot reach it: no externally_connectable;
  // the content script, which runs in TikTok's pages with this extension's id, never passes)
  if (!isOwnSender(sender)) return false;
  if (!isRecord(message) || message["type"] !== "dramafetch:open") return false;
  const load = typeof message["load"] === "string" && message["load"] ? message["load"] : null;
  const favorites = message["favorites"];
  /** @type {Handover | null} the popup's Open my library on a profile (that tab), its Download this series, or its Open my library elsewhere */
  const handover = isTabId(favorites)
    ? { favorites: { tabId: favorites, card: null, menu: false, script: true } }
    : load !== null
      ? { load }
      : message["library"] === true
        ? { library: true }
        : null;
  openApp(handover).then(
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
    for (const item of menuItems(t("contextDownload"), t("contextDownloadPage"), t("contextDownloadFavorite"))) {
      await menuCall((done) => void chrome.contextMenus.create(item, done));
    }
  };
  menusInPlace = menusInPlace.then(install, install);
  return menusInPlace;
}

/**
 * The favorites card the right-click of the card item was on: the content script of that tab's
 * frame remembers it (`src/content/cards.js`) and answers the extension's own message, checked
 * (`lib/favorites.cardOf`). `script` tells the two ways of having no card apart: true when the
 * script answered — `card` null then means the right-click was on no card —, false when no content
 * script answered at all (`chrome.tabs.sendMessage` rejects: a tab loaded before this version of
 * DramaFetch was, a frame without one), so nothing could say which drama was right-clicked.
 * @param {number} tabId
 * @param {number} frameId
 * @returns {Promise<{card: Card | null, script: boolean}>}
 */
async function rightClickedCard(tabId, frameId) {
  let answer;
  try {
    answer = await chrome.tabs.sendMessage(tabId, { type: "dramafetch:card" }, { frameId });
  } catch {
    return { card: null, script: false };
  }
  return { card: cardOf(answer), script: true };
}

chrome.runtime.onInstalled.addListener(() => void installMenus().catch(() => undefined));
chrome.runtime.onStartup.addListener(() => void installMenus().catch(() => undefined));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const answer = async () => {
    if (info.menuItemId === MENU_CARD) {
      // a drama of the profile's favorites: its card, from the tab's frame — without one (no card
      // right-clicked, no script to ask) the DramaFetch tab lists nothing and says why
      const tabId = tab?.id;
      if (!isTabId(tabId)) return;
      const { card, script } = await rightClickedCard(tabId, info.frameId ?? 0);
      await openApp({ favorites: { tabId, card, menu: true, script } });
      return;
    }
    const test = await loadTestSettings();
    const load = loadOfClick(info, test.baseUrl ?? TIKTOK_BASE_URL);
    if (load !== null) await openApp({ load });
  };
  void answer().catch(() => undefined);
});
