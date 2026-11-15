// @ts-check
/**
 * The toolbar popup. On a TikTok short-drama tab: **Download this series** (opens the DramaFetch
 * tab with that series listed) and **Open DramaFetch**; on a TikTok profile page (`/@…`) whose
 * **Favorites** → **Drama** list the background worker saw that tab load: **Choose from your
 * favorites** (opens the DramaFetch tab with that tab's favorites listed) — on such a page before
 * the list was shown, a hint to open it first; anywhere else only **Open DramaFetch**. The
 * background worker opens or re-focuses the one DramaFetch tab; the popup reads the active tab's
 * URL only (the `tabs` permission), whether the worker saw that tab's favorites list
 * (`chrome.storage.session`), and nothing of its page.
 */

import { isProfilePageUrl } from "../lib/favorites.js";
import { TIKTOK_BASE_URL } from "../lib/messages.js";
import { seriesRefFromUrl } from "../lib/urls.js";
import { localize, t } from "./i18n.js";
import { loadTestSettings, readFavoritesTemplate } from "./storage.js";

/**
 * Ask the background worker to open (or focus) the DramaFetch tab, then close the popup.
 * @param {{load: string | null} | {favorites: number}} request a series link to list there, or
 *   the TikTok tab whose favorites to list
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
  } else if (tab?.id !== undefined && tab.url && isProfilePageUrl(tab.url, base)) {
    const tabId = tab.id;
    if ((await readFavoritesTemplate(tabId)) !== null) {
      const favorites = /** @type {HTMLButtonElement} */ (document.getElementById("popup-favorites"));
      favorites.hidden = false;
      favorites.addEventListener("click", () => void open({ favorites: tabId }));
    } else {
      /** @type {HTMLElement} */ (document.getElementById("popup-favorites-hint")).hidden = false;
    }
  }
  openButton.addEventListener("click", () => void open({ load: null }));
}

void main();
