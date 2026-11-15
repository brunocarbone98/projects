// @ts-check
/**
 * The right-click menu, **Download this drama**: on a link to a TikTok short-drama series — on any
 * page, TikTok's own lists of dramas included, so the series need not be opened first —, as
 * **Download this page's drama** on a series page itself, and — the owner's request of 2026-11-15 —
 * as **Download this favorite drama** on the user's TikTok profile, whose **Favorites** → **Drama**
 * entries are buttons, not links ({@link MENU_CARD}). A click does what the popup's **Download this
 * series** does: the background worker opens (or brings to the front) the DramaFetch tab, which
 * lists the series; nothing is downloaded until a download button is pressed there. Of what Chrome
 * passes with a click (the link's and the page's addresses, any selected text, the tab), DramaFetch
 * reads only the link's address — or, for the page item, the right-clicked page's; for the card
 * item, the tab and the frame, which it asks for the card (`src/content/cards.js`) — and keeps
 * nothing else; the items need the `contextMenus` permission only. Pure: no `chrome.*`, no DOM —
 * `background.js` puts the items in place and answers the clicks.
 */

import { TIKTOK_BASE_URL } from "../lib/messages.js";
import { seriesRefFromUrl } from "../lib/urls.js";

/** The item on a link to a series. */
export const MENU_LINK = "dramafetch-download-link";
/**
 * The item on a series page itself. Chrome shows a page's items only for a right-click on no link,
 * no selected text, no editable field and no picture, video, audio, canvas or plugin (on macOS and
 * ChromeOS a right-click on text selects a word first) — so never both items at once. Inside a
 * frame, the frame's address decides whether the item shows, and the click reads that address.
 */
export const MENU_PAGE = "dramafetch-download-page";
/**
 * The item on a drama of the user's TikTok favorites (**Favorites** → **Drama** on their profile):
 * those entries are buttons — no address to read — so Chrome cannot tell the item which one was
 * right-clicked; the content script (`src/content/cards.js`) remembers the card the right-click was
 * on, and the worker asks that tab's frame for it. It shows on the profile pages where that script
 * runs ({@link PROFILE_PAGE_PATTERNS}) for a right-click on the page itself or on a picture (a
 * card's cover): on a card's title or its cover. Titled **Download this favorite drama**
 * (`contextDownloadFavorite`).
 */
export const MENU_CARD = "dramafetch-download-card";

/** TikTok's hosts, as the box's parser reads them (`lib/urls.js`: `www.`, `m.` or none). */
const TIKTOK_HOSTS = ["www.tiktok.com", "m.tiktok.com", "tiktok.com"];

/**
 * Where the link item shows (Chrome's match patterns; `*` in the scheme is http or https): links
 * under `/shortdrama/` on TikTok's hosts. The series is read with the box's own parser
 * (`urls.seriesRefFromUrl`), so a link there that names no series (a list, a category) reaches the
 * DramaFetch tab as it is, and the tab says why it lists nothing, keeping what its box holds.
 */
export const SHORT_DRAMA_LINK_PATTERNS = Object.freeze(TIKTOK_HOSTS.map((host) => `*://${host}/shortdrama/*`));

/**
 * Where the page item shows: the pages of a series — `/shortdrama/episode/…` (TikTok's player
 * page), `/shortdrama/detail/…`, `/shortdrama/series/…` and `/shortdrama/<series id>` (the id is
 * ASCII digits: one pattern per first digit) — never a list of dramas, whose own address names no
 * series. A page there whose address names no series all the same reaches the tab as it is, and
 * the tab says why it lists nothing.
 */
export const SERIES_PAGE_PATTERNS = Object.freeze(
  TIKTOK_HOSTS.flatMap((host) => [
    ...["episode", "detail", "series"].map((kind) => `*://${host}/shortdrama/${kind}/*`),
    ..."0123456789".split("").map((digit) => `*://${host}/shortdrama/${digit}*`),
  ]),
);

/**
 * Where the card item shows: the user's TikTok profile pages, `/@<user>…` on `www.tiktok.com` only
 * — the one host whose pages the content script runs in (`manifest.json`: `https://www.tiktok.com/*`),
 * so the item never shows where nothing could say which card was right-clicked (the profile URL
 * has no tab parameter: Favorites → Drama is a tab of the page itself).
 */
export const PROFILE_PAGE_PATTERNS = Object.freeze(["*://www.tiktok.com/@*"]);

/**
 * The menu's three items: the link item titled `linkTitle` (`contextDownload`, **Download this
 * drama**), the page item `pageTitle` (`contextDownloadPage`, **Download this page's drama**) and
 * the card item `cardTitle` (`contextDownloadFavorite`, **Download this favorite drama**) — all in
 * Chrome's language, like the pages.
 * @param {string} linkTitle
 * @param {string} pageTitle
 * @param {string} cardTitle
 * @returns {chrome.contextMenus.CreateProperties[]}
 */
export function menuItems(linkTitle, pageTitle, cardTitle) {
  return [
    { id: MENU_LINK, title: linkTitle, contexts: ["link"], targetUrlPatterns: [...SHORT_DRAMA_LINK_PATTERNS] },
    { id: MENU_PAGE, title: pageTitle, contexts: ["page"], documentUrlPatterns: [...SERIES_PAGE_PATTERNS] },
    { id: MENU_CARD, title: cardTitle, contexts: ["page", "image"], documentUrlPatterns: [...PROFILE_PAGE_PATTERNS] },
  ];
}

/**
 * What a click of the link or the page item asks the DramaFetch tab to list — what the popup hands
 * it: the series id of the link, or of the right-clicked page (the frame's address, which Chrome
 * matched the page item against — Chrome 116 sends it only from inside a frame —, else the page's);
 * the address as it is when it names no series; null for anything else (the card item, which the
 * worker answers with the right-clicked card, another item, no address).
 * @param {chrome.contextMenus.OnClickData} info
 * @param {string} [base] TikTok's address (in test mode, the fake TikTok's)
 * @returns {string | null}
 */
export function loadOfClick(info, base = TIKTOK_BASE_URL) {
  const url =
    info.menuItemId === MENU_LINK
      ? info.linkUrl
      : info.menuItemId === MENU_PAGE
        ? info.frameUrl || info.pageUrl
        : undefined;
  if (typeof url !== "string" || url === "") return null;
  return seriesRefFromUrl(url, base)?.seriesId ?? url;
}
