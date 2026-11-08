// @ts-check
/**
 * The toolbar popup: **Open StreamFetch** always, and **Download this video** when the active tab
 * shows a Dailymotion, Bilibili.tv or Bilibili video page (the link is put into the StreamFetch
 * tab's box). The background worker opens or re-focuses the one StreamFetch tab. The popup reads
 * the active tab's URL only — Chrome gives it for the hosts of `host_permissions`, no `tabs`
 * permission needed — and nothing of its page.
 */

import { videoItemFromUrl } from "../lib/urls.js";
import { displayLanguage, loadCatalogs, localize, setLanguage, t } from "./i18n.js";
import { loadSettings, loadTestSettings } from "./storage.js";

/**
 * The supported video page a tab URL names, as the link to add, or null. In test mode the fake
 * sites' bases count as the real sites.
 * @param {string | undefined} url
 * @param {import("./storage.js").BaseUrls} bases
 * @returns {string | null}
 */
export function linkOfTab(url, bases) {
  if (!url) return null;
  const item = videoItemFromUrl(url, bases);
  return item === null ? null : item.pageUrl;
}

/**
 * Ask the background worker to open (or focus) the StreamFetch tab, then close the popup.
 * @param {string | null} links a link to add to the box
 */
async function open(links) {
  try {
    await chrome.runtime.sendMessage({ type: "streamfetch:open", links });
  } finally {
    window.close();
  }
}

async function main() {
  await loadCatalogs();
  setLanguage(displayLanguage(await loadSettings()));
  localize();
  const version = document.getElementById("popup-version");
  if (version) version.textContent = chrome.runtime.getManifest().version;
  const test = await loadTestSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const link = linkOfTab(tab?.url, test.baseUrls ?? {});
  const download = /** @type {HTMLButtonElement} */ (document.getElementById("popup-download"));
  const openButton = /** @type {HTMLButtonElement} */ (document.getElementById("popup-open"));
  const video = /** @type {HTMLElement} */ (document.getElementById("popup-video"));
  if (link !== null) {
    video.hidden = false;
    video.textContent = t("popupVideo", link);
    download.hidden = false;
    download.addEventListener("click", () => void open(link));
  }
  openButton.addEventListener("click", () => void open(null));
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") void main();
