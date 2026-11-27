// @ts-check
/**
 * The toolbar popup. Everywhere **Open DramaFetch** and its hint; on a TikTok short-drama tab also
 * the series and **Download this series** (the DramaFetch tab downloads that whole series —
 * DramaFetch 1.7.0: the `batch` job a paste of it queues, listed right before its downloads). The
 * background worker opens or re-focuses the one DramaFetch tab. The popup reads the active tab's
 * URL only (the `tabs` permission), nothing of its page, and nothing stored but the test settings
 * of the test harness' copy (DramaFetch 4.0.0: no library, nothing of the user's TikTok Favorites
 * — the popup's **Open my library** is gone).
 */

import { TIKTOK_BASE_URL } from "../lib/messages.js";
import { seriesRefFromUrl } from "../lib/urls.js";
import { localize, t } from "./i18n.js";
import { loadTestSettings } from "./storage.js";

/**
 * Ask the background worker to open (or focus) the DramaFetch tab, then close the popup.
 * @param {{load: string | null}} request a series to download there; null: the tab only
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
  openButton.addEventListener("click", () => void open({ load: null }));
}

void main();
