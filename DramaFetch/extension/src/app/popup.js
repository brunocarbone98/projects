// @ts-check
/**
 * The toolbar popup. On a TikTok short-drama tab: **Download this series** (opens the DramaFetch
 * tab with that series listed) and **Open DramaFetch**; anywhere else only **Open DramaFetch**. The
 * background worker opens or re-focuses the one DramaFetch tab; the popup reads the active tab's
 * URL only (the `tabs` permission) and nothing of its page.
 */

import { TIKTOK_BASE_URL } from "../lib/messages.js";
import { seriesRefFromUrl } from "../lib/urls.js";
import { localize, t } from "./i18n.js";
import { loadTestSettings } from "./storage.js";

/**
 * Ask the background worker to open (or focus) the DramaFetch tab, then close the popup.
 * @param {string | null} load a series link to list there
 */
async function open(load) {
  try {
    await chrome.runtime.sendMessage({ type: "dramafetch:open", load });
  } finally {
    window.close();
  }
}

async function main() {
  localize();
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
    download.addEventListener("click", () => void open(ref.seriesId));
  }
  openButton.addEventListener("click", () => void open(null));
}

void main();
