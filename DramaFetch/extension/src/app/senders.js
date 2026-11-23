// @ts-check
/**
 * Who may message DramaFetch's worker (`background.js`: `dramafetch:open`) and the DramaFetch tab
 * (`app.js`: `dramafetch:load`, `dramafetch:favorites`, `dramafetch:library`, `dramafetch:retry`):
 * the extension's own pages — the popup, the DramaFetch tab — and its service worker, never a web
 * page. The manifest has no `externally_connectable`, so no other extension or site can reach them
 * at all. Until 2.0.0 a declared content script ran with this extension's id inside every
 * `www.tiktok.com` page (the favorites card reader of the right-click, gone since). DramaFetch
 * declares none any more, but it still injects functions into the TikTok tabs it works in, in the
 * ISOLATED world, where a runtime message carries this extension's id: the Bookmark reader
 * (`bookmark.bookmarkInPage`) and the discovery's scroll and page-text reads (`discovery.scrollInPage`,
 * `pageTextInPage` — the latter in the user's own TikTok tab too, during a favorites listing). None of
 * them sends a message; this check keeps any sender in a web page's frame out all the same — a real
 * guard, as defence in depth against a TikTok renderer gone wrong.
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
