// @ts-check
/**
 * Who may message DramaFetch's worker (`background.js`: `dramafetch:open`) and the DramaFetch tab
 * (`app.js`: `dramafetch:load`, `dramafetch:favorites`): the extension's own pages — the popup, the
 * DramaFetch tab — and its service worker, never a web page. The manifest has no
 * `externally_connectable`, so no other extension or site can reach them at all; but the one
 * content script (`src/content/cards.js`) runs with this extension's id inside every
 * `www.tiktok.com` page, so a TikTok renderer that went wrong could send a runtime message that
 * carries the right `sender.id`. The content script itself never sends one: it only answers the
 * worker's `chrome.tabs.sendMessage` (and keeps its own check, `sender.id`).
 */

/**
 * Whether a runtime message comes from DramaFetch itself: the sender's `id` is this extension's
 * AND the sender is no web page — its `url` lies under the extension's own origin
 * (`chrome.runtime.getURL("")`, `chrome-extension://<id>/`), as the popup's, the DramaFetch tab's
 * and the service worker's do. A sender without a `url`, which only the service worker may be,
 * counts as the extension's own unless it names a tab: a content script always carries its
 * frame's `url` and `sender.tab`, so it never passes.
 * @param {chrome.runtime.MessageSender} sender
 * @returns {boolean}
 */
export function isOwnSender(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.url === undefined) return sender.tab === undefined;
  return typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}
