// @ts-check
/**
 * The right-click menu, **Download this video**: on a link to a Dailymotion, Bilibili or
 * Bilibili.tv video — on any page, the sites' own lists included, so the video need not be opened
 * first — and, as **Download this page's video**, on such a video page itself. A click does what
 * the popup's **Download this video** does: the background worker opens (or brings to the front)
 * the StreamFetch tab and puts the link into its box, after the links already there; nothing is
 * requested or downloaded until **Analyze** or **Download all** is pressed there. Of what Chrome
 * passes with a click (the link's and the page's addresses, any selected text, the tab),
 * StreamFetch reads only the link's address — or, for the page item, the right-clicked page's — and
 * keeps nothing else; the items need the `contextMenus` permission only. Pure: no `chrome.*`, no
 * DOM — `background.js` puts the items in place and answers the clicks.
 */

import { videoItemFromUrl } from "../lib/urls.js";

/** The item on a link to a video. */
export const MENU_LINK = "streamfetch-download-link";
/**
 * The item on a video page itself. Chrome shows a page's items only for a right-click on no link,
 * no selected text, no editable field and no picture, video, audio, canvas or plugin (on macOS and
 * ChromeOS a right-click on text selects a word first) — so never both items at once. Inside a
 * frame (an embedded player), the frame's address decides whether the item shows, and the click
 * reads that address.
 */
export const MENU_PAGE = "streamfetch-download-page";
/**
 * Where the items show (Chrome's match patterns: `*.` covers the domain itself, a `*` in the path
 * any text, `/` and the query included): the video pages, short links and players `lib/urls.js`
 * reads — Dailymotion's `/video/<id>` (also `embed/`, `swf/`, `crawler/`), `dai.ly/<id>` and the
 * geo player other sites embed, `geo.dailymotion.com/player[/<id>].html?video=<id>` (matched up
 * to `video=`: a player of a playlist alone shows no item), Bilibili's `/video/<id>` (`www.`,
 * `m.`), `b23.tv/<code>` and the player other sites embed,
 * `player.bilibili.com/player.html?bvid=…`, Bilibili.tv's `[/<lang>]/video/<aid>`,
 * `/play/<season>[/<ep>]` and `/media/<season>` on `bilibili.tv` and `biliintl.com`. The link is
 * read with the box's own parser, so an address of these shapes that names no video reaches the
 * box as it is, and the box says why at **Analyze** or **Download all**.
 */
export const VIDEO_PATTERNS = Object.freeze([
  "*://*.dailymotion.com/video/*",
  "*://*.dailymotion.com/embed/video/*",
  "*://*.dailymotion.com/swf/video/*",
  "*://*.dailymotion.com/crawler/video/*",
  "*://geo.dailymotion.com/player*video=*",
  "*://dai.ly/*",
  "*://*.bilibili.com/video/*",
  "*://player.bilibili.com/player.html*",
  "*://b23.tv/*",
  "*://*.bilibili.tv/*video/*",
  "*://*.bilibili.tv/*play/*",
  "*://*.bilibili.tv/*media/*",
  "*://*.biliintl.com/*video/*",
  "*://*.biliintl.com/*play/*",
  "*://*.biliintl.com/*media/*",
]);

/**
 * The menu's two items: the link item titled `linkTitle` (`contextDownload`), the page item
 * `pageTitle` (`contextDownloadPage`) — both in the display language, like the pages.
 * @param {string} linkTitle
 * @param {string} pageTitle
 * @returns {chrome.contextMenus.CreateProperties[]}
 */
export function menuItems(linkTitle, pageTitle) {
  return [
    { id: MENU_LINK, title: linkTitle, contexts: ["link"], targetUrlPatterns: [...VIDEO_PATTERNS] },
    { id: MENU_PAGE, title: pageTitle, contexts: ["page"], documentUrlPatterns: [...VIDEO_PATTERNS] },
  ];
}

/**
 * What a click of one of the items puts into the box — what the popup hands it: the canonical
 * page of the video the link names, or the right-clicked page (the frame's address, which Chrome
 * matched the page item against — Chrome 116 sends it only from inside a frame —, else the
 * page's) (`urls.videoItemFromUrl`); the address as it is otherwise — a `b23.tv` short link, read
 * when the box runs, or an address the box will refuse saying why; null for anything else
 * (another item, no address).
 * @param {chrome.contextMenus.OnClickData} info
 * @param {import("./storage.js").BaseUrls} [bases] test mode: the fake sites' base URLs
 * @returns {string | null}
 */
export function linkOfClick(info, bases = {}) {
  const url =
    info.menuItemId === MENU_LINK
      ? info.linkUrl
      : info.menuItemId === MENU_PAGE
        ? info.frameUrl || info.pageUrl
        : undefined;
  if (typeof url !== "string" || url === "") return null;
  return videoItemFromUrl(url, bases)?.pageUrl ?? url;
}
