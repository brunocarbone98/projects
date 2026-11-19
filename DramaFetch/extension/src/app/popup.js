// @ts-check
/**
 * The toolbar popup. On a TikTok short-drama tab: **Download this series** (opens the DramaFetch
 * tab with that series listed) and **Open DramaFetch**; on a TikTok profile page (`/@…`) whose
 * **Favorites** → **Drama** list the background worker saw that tab load: **Open my library · N
 * dramas** (N: TikTok's count the library kept) — that tab handed over as 1.5.0's **Choose from
 * your favorites** did, and the DramaFetch tab updates the library from it (the smart refresh) and
 * shows it —; on such a page before the list was shown, a hint to open it first. Anywhere else —
 * that page without the list included — when a library exists, **Open my library · N dramas**
 * opens the DramaFetch tab on the library with no job and no request. The background worker opens
 * or re-focuses the one DramaFetch tab; the popup reads the active tab's URL only (the `tabs`
 * permission), whether the worker saw that tab's favorites list (`chrome.storage.session`), the
 * library's count (`chrome.storage.local`), and nothing of its page.
 */

import { isProfilePageUrl } from "../lib/favorites.js";
import { TIKTOK_BASE_URL } from "../lib/messages.js";
import { seriesRefFromUrl } from "../lib/urls.js";
import { localize, t } from "./i18n.js";
import { loadTestSettings, readFavoritesTemplate, readLibrary } from "./storage.js";

/**
 * Ask the background worker to open (or focus) the DramaFetch tab, then close the popup.
 * @param {{load: string | null} | {favorites: number} | {library: true}} request a series link to
 *   list there, the TikTok tab whose favorites to list, or the library to show
 */
async function open(request) {
  try {
    await chrome.runtime.sendMessage({ type: "dramafetch:open", ...request });
  } finally {
    window.close();
  }
}

async function main() {
  localize();
  /** @type {HTMLElement} */ (document.getElementById("popup-version")).textContent = chrome.runtime.getManifest().version;
  const test = await loadTestSettings();
  const base = test.baseUrl ?? TIKTOK_BASE_URL;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const ref = tab?.url ? seriesRefFromUrl(tab.url, base) : null;
  const download = /** @type {HTMLButtonElement} */ (document.getElementById("popup-download"));
  const openButton = /** @type {HTMLButtonElement} */ (document.getElementById("popup-open"));
  const series = /** @type {HTMLElement} */ (document.getElementById("popup-series"));
  if (ref !== null) {
    series.hidden = false;
    series.textContent = t("popupSeries", ref.seriesId);
    download.hidden = false;
    download.addEventListener("click", () => void open({ load: ref.seriesId }));
  }
  const stored = await readLibrary();
  const label = stored !== null && stored.total !== null ? t("popupLibrary", [stored.total]) : t("popupLibraryOpen");
  let handedOver = false;
  if (ref === null && tab?.id !== undefined && tab.url && isProfilePageUrl(tab.url, base)) {
    const tabId = tab.id;
    if ((await readFavoritesTemplate(tabId)) !== null) {
      // that tab handed over (as 1.5.0's Choose from your favorites): the library updated from it
      const favorites = /** @type {HTMLButtonElement} */ (document.getElementById("popup-favorites"));
      favorites.textContent = label;
      favorites.hidden = false;
      favorites.addEventListener("click", () => void open({ favorites: tabId }));
      handedOver = true;
    } else {
      /** @type {HTMLElement} */ (document.getElementById("popup-favorites-hint")).hidden = false;
    }
  }
  if (!handedOver && stored !== null) {
    // elsewhere: the library shown as it is kept — no job, no request
    const libraryButton = /** @type {HTMLButtonElement} */ (document.getElementById("popup-library"));
    libraryButton.textContent = label;
    libraryButton.hidden = false;
    libraryButton.addEventListener("click", () => void open({ library: true }));
  }
  openButton.addEventListener("click", () => void open({ load: null }));
}

void main();
