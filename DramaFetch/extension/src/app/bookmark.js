// @ts-check
/**
 * **Remove from Favorites** (Spanish: **Quitar de Bookmark**) — the one new capability of DramaFetch
 * 1.6.0, the owner's decision of 2026-11-19: on the user's explicit request — a click on the
 * library card of ONE drama DramaFetch's records show complete on disk, and a confirmation —
 * DramaFetch presses TikTok's OWN Bookmark button once on that drama's page, in a muted background
 * tab it opens like the discovery's, and verifies that TikTok kept the change. It never sends
 * TikTok's `collect` request itself, never builds, re-signs or replays it, never reads its body:
 * the page sends it, as when the user clicks. The click is synthetic (`isTrusted` false): TikTok
 * could ignore it or count it as automation — DramaFetch then reports that TikTok did not keep the
 * change, never presses twice, and the user removes the drama by hand (**Open on TikTok**).
 *
 * TikTok facts (the owner's captures of 2026-11-15 and 2026-11-19; the sandbox cannot reach TikTok):
 * - on a drama's episode page (`https://www.tiktok.com/shortdrama/episode/<id>/<n>`) the Bookmark is
 *   `div[role="button"][data-e2e="favorite-icon"][data-key-interaction="action_favorite"]`
 *   ({@link BOOKMARK_SELECTOR}); its `aria-label` is the same in both states ("Add to Favorites. N
 *   added to Favorites");
 * - saved: its svg is yellow (`color="#FACE15"`, {@link BOOKMARK_SAVED_COLOR}); the count next to it
 *   drops by one when removed (7057 → 7056 in the owner's test);
 * - a click makes the page send `…/collect/?…&action=<n>&…&itemId=<the episode's item id>&…` — one
 *   request, the page's own;
 * - the owner ran `document.querySelector('[data-e2e="favorite-icon"]').click()` in DevTools on
 *   such a page (2026-11-19): the button turned off and the count dropped. Whether TikTok keeps a
 *   synthetic click's change after a reload was not confirmed yet — the verification below (a
 *   reload, then the button read again) is exactly that check, every time.
 *
 * The steps ({@link removeFromBookmark}; the gate — on disk per the records against an episode count
 * read from TikTok in the last 24 h, the cooldown, the rest between jobs — and the library's update
 * are the DramaFetch tab's, `app.js` `runUnbookmark`):
 * open the tab (`discovery.chromeBrowser(appTabId).openTab`: muted, inactive, recorded so the
 * worker closes it when the DramaFetch tab goes away) on `seriesPageUrl(id, 1)`; wait for the page,
 * looking every second ({@link POLL_S}) for at most the discovery's timeout — TikTok's login page:
 * {@link LoginRequiredError} (a stop, no cooldown); the verification wall in its text
 * (`looksLikeChallenge`): {@link ChallengeError} with {@link BOOKMARK_CHALLENGE_MESSAGE} (a stop and
 * the cooldown, source `discovery`); the drama page's OWN episode list (`ITEM_LIST_MARKER`, the
 * page's request, observed from the first load on: URL and status only) answered HTTP 429 — the
 * discovery's rule — {@link RateLimitedError} with `LIST_RATE_LIMIT_MESSAGE` (a stop and the
 * cooldown, nothing pressed); the Bookmark button: its state read in the ISOLATED world
 * ({@link bookmarkInPage}, read only) on the confirmed drama's own page only — its id a segment of
 * the address's path; a page TikTok sent the tab to instead is never read or pressed —, saved only
 * by a yellow as Chrome computes it (never an attribute alone) on an element that passes the
 * reader's checks — laid out, visible, a box that is not empty, not clipped to nothing by a
 * wrapper, not transparent, a yellow fill not of `fill-opacity` 0: a yellow variant hidden in one of
 * those ways never counts; one hidden another way (clipped, masked, off-screen, covered) is not
 * detected, nor a yellow `color` painting nothing, {@link bookmarkInPage} —, `saved` or `unsaved`
 * once two readings a poll apart agree; no
 * single button within the wait — none, or
 * several, or not the drama's page — {@link BookmarkError} `bookmark-missing` (nothing pressed).
 * Already `unsaved`: nothing to press (`already` — the caller changes nothing for it: a page that
 * shows the button off is no proof TikTok's list lost the drama). Else the list-page pause, the
 * cooldown asked again (and that episode list once more), the tab's requests whose path ends in
 * `/collect/` noted (webRequest: URL and status only, never a body, never stored), and the button
 * clicked ONCE — re-found by the same selector and clicked only while it still reads saved, so a
 * button that reads unsaved is never pressed (that would ADD the drama). Then at most {@link CHANGE_WAIT_S} for
 * the button to read `unsaved` and for TikTok's answer to the page's `collect` (a request cut short
 * counts): a `collect` answered 429 is {@link RateLimitedError} (the cooldown, a stop), 403
 * {@link BookmarkRefusedError} (the same), no change `not-confirmed` — never a second click.
 * TikTok's answer decides even when the page draws the button off before it comes: once the button
 * reads off the wait goes on until that answer is seen (so the reload never cuts it short), it is
 * asked again after the pause (no reload follows a refusal), and a refusal noted by the end — Stop,
 * the login page or anything else after the click included — is the outcome. Then the pause, the
 * cooldown again (a 429 on the page's episode list since the click: no reload, `not-confirmed`), the
 * page reloaded and read as before, from a NEW document only (an answer of the page before the
 * reload never counts): `unsaved` → `removed`; `saved` → `not-kept`; a reload that fails or a page
 * that cannot be read → `not-confirmed`. A 429 on the page's own episode list after the click leaves
 * that outcome as it is and records the cooldown: `removed` then carries it as the job's stop. The
 * tab is closed on every path. **Stop** is honoured between the steps (the sleeps); after the click,
 * the caller says the outcome is unknown.
 */

import { cooldownMessage, recordBlock } from "../lib/cooldown.js";
import { BLOCKED_MESSAGE, LIST_RATE_LIMIT_MESSAGE, TIKTOK_BASE_URL } from "../lib/messages.js";
import { PAGE_DELAY_S, pagePause } from "../lib/pacing.js";
import { seriesPageUrl } from "../lib/urls.js";
import {
  ChallengeError,
  DISCOVERY_TIMEOUT_S,
  DiscoveryError,
  ITEM_LIST_MARKER,
  LOGIN_REDIRECT_MESSAGE,
  LoginRequiredError,
  RateLimitedError,
  chromeBrowser,
  isLoginUrl,
  looksLikeChallenge,
  observedUrlPatterns,
} from "./discovery.js";
import { DISCOVERY_SOURCE, StopRequested, checkCooldown } from "./engine.js";
import { listFavorites } from "./favorites.js";

/** The Bookmark button of a drama's episode page (the owner's capture of 2026-11-19). */
export const BOOKMARK_SELECTOR = 'div[role="button"][data-e2e="favorite-icon"][data-key-interaction="action_favorite"]';
/**
 * The colour of a saved Bookmark's svg (`color="#FACE15"`; computed: rgb(250, 206, 21)) — counted
 * only as Chrome computes it, on an element that passes the reader's checks ({@link bookmarkInPage}:
 * laid out, visible, a box that is not empty, not clipped to nothing, not transparent).
 */
export const BOOKMARK_SAVED_COLOR = "#FACE15";
/** How often (seconds) the drama's page is looked at while it loads and after the click. */
export const POLL_S = 1;
/** How long (seconds) the button may take to turn off after the one click. */
export const CHANGE_WAIT_S = 15;
/** The path of the page's own Bookmark request ends with this (`…/collect/?…&action=…`). */
const COLLECT_PATH_RE = /\/collect\/?$/;

/**
 * HTTP 429 on the Bookmark button's request (the page's own `collect`): a stop and the 30-minute
 * cooldown. The extension's own text: the Python tool removes nothing.
 */
export const BOOKMARK_RATE_LIMIT_MESSAGE =
  "TikTok is rate-limiting this address (HTTP 429 on the Bookmark button's request): wait 30-60 minutes " +
  "before trying again";
/**
 * TikTok's verification wall instead of the drama's page while DramaFetch removes it from the
 * Favorites ({@link ChallengeError}): a stop and the 30-minute cooldown. At most 200 characters, as
 * the cooldown keeps its reason (`lib/cooldown.js`).
 */
export const BOOKMARK_CHALLENGE_MESSAGE =
  "TikTok is asking for a verification (captcha) on the drama's page while removing it from your Favorites: " +
  "after the cooldown, solve it in a normal tab of this Chrome, then try again";

/**
 * Why a removal ended without removing anything, in the engine's English (the history keeps it;
 * `lib/display.js` shows it in Spanish; the page shows its own words from `_locales`).
 * @type {Readonly<Record<BookmarkErrorKind, string>>}
 */
export const BOOKMARK_MESSAGES = Object.freeze({
  "not-on-disk":
    "not removed from your Favorites: DramaFetch's records do not show every episode of this drama on disk; " +
    "nothing was asked of TikTok",
  stale:
    "not removed from your Favorites: its episode count was read from TikTok more than 24 hours ago and new " +
    "episodes may have come since — update the library from TikTok first; nothing was asked of TikTok",
  "bookmark-missing":
    "not removed from your Favorites: DramaFetch found no single Bookmark button to press on the drama's page; " +
    "nothing was pressed — remove it on TikTok yourself",
  "tab-gone": "not removed from your Favorites: the tab DramaFetch opened for the drama was closed before anything was pressed",
  "not-confirmed":
    "TikTok did not confirm the removal: DramaFetch pressed Bookmark once and could not check that TikTok kept the change " +
    "(the button did not turn off, or the page could not be read again); it does not press it again — check on TikTok",
  "not-kept": "TikTok did not keep the change: the drama is still in your Favorites — remove it on TikTok yourself",
  unknown: "stopped by you after DramaFetch pressed Bookmark: the outcome is unknown — check on TikTok",
});

/**
 * @typedef {"not-on-disk" | "stale" | "bookmark-missing" | "tab-gone" | "not-confirmed" | "not-kept" | "unknown"} BookmarkErrorKind
 * @typedef {"saved" | "unsaved" | "missing" | "several" | "clicked"} BookmarkState What the page
 *   answers ({@link bookmarkInPage}): the one button's state, none, more than one, or the one click
 * @typedef {import("./engine.js").Engine} Engine
 *
 * @typedef {object} BookmarkReading One reading of the page.
 * @property {BookmarkState} state
 * @property {string | null} documentId the document that answered (Chrome's `documentId`)
 *
 * @typedef {Pick<import("./discovery.js").DiscoveryBrowser, "openTab" | "navigate" | "tabUrl" | "closeTab" | "observe" | "pageText">} TabBrowser
 * @typedef {TabBrowser & {bookmark: (tabId: number, press: boolean, seriesId: string) => Promise<BookmarkReading>}} BookmarkBrowser
 *   The chrome.* calls a removal makes (injectable for tests): the discovery's tab, address,
 *   observation and page text, and the Bookmark of drama `seriesId`'s page read — or pressed once —
 *   in the ISOLATED world.
 *
 * @typedef {object} BookmarkOptions
 * @property {string} [baseUrl] TikTok's origin (the fake TikTok's in test mode)
 * @property {number} [windowId] the window the tab opens in (the DramaFetch tab's)
 * @property {number} [appTabId] the DramaFetch tab, recorded with the tab opened
 * @property {number} [timeoutS] how long the page may take to show the button (the discovery's 45 s)
 * @property {number} [waitS] how long the button may take to turn off after the click ({@link CHANGE_WAIT_S})
 * @property {number} [pollS] {@link POLL_S}
 * @property {number} [pageDelayS] the minimum pause before the click and the reload (0.8 s)
 * @property {() => void} [onPressed] right after the one click (the page notes it: a Stop after it
 *   leaves the outcome unknown)
 * @property {BookmarkBrowser} [browser] {@link bookmarkBrowser} by default
 *
 * @typedef {object} BookmarkResult
 * @property {"removed" | "already"} outcome `removed`: pressed once, and the reloaded page shows it
 *   off; `already`: the page showed it off before anything was pressed
 * @property {string} [refused] TikTok answered the drama page's own episode list HTTP 429 after the
 *   click (`LIST_RATE_LIMIT_MESSAGE`): the removal stands, the cooldown is recorded already, and
 *   this is the job's stop
 */

/** A removal that ended without removing anything, TikTok refusing nothing (no cooldown). */
export class BookmarkError extends Error {
  /** @param {BookmarkErrorKind} kind */
  constructor(kind) {
    super(BOOKMARK_MESSAGES[kind]);
    this.name = "BookmarkError";
    this.kind = kind;
  }
}

/** HTTP 403 on the Bookmark button's request: TikTok refused — a stop and the 30-minute cooldown. */
export class BookmarkRefusedError extends DiscoveryError {
  constructor() {
    super(BLOCKED_MESSAGE);
    this.name = "BookmarkRefusedError";
  }
}

/** A cooldown in force before a step of a removal: a stop, already recorded (its message). */
export class BookmarkCooldown extends Error {
  /** @param {string} message the cooldown's */
  constructor(message) {
    super(message);
    this.name = "BookmarkCooldown";
  }
}

/**
 * Whether `url` is the page's own Bookmark request: its path (not its query) ends with `/collect/`.
 * Only that is read of it — never the query, never a body; nothing of it is kept.
 * @param {string} url
 * @returns {boolean}
 */
export function isCollectUrl(url) {
  if (typeof url !== "string") return false;
  const path = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/, "").replace(/[?#].*$/s, "");
  return COLLECT_PATH_RE.test(path);
}

// ------------------------------------------------------------- the function run in the page
// executeScript serialises it: self-contained (no imports, no closures).

/**
 * Run in the drama's tab, in the ISOLATED world: the Bookmark button's state — `missing` when the
 * page is not drama `seriesId`'s own (its id is no segment of `location.pathname`: TikTok's
 * `/shortdrama/episode/<id>/<n>`; a page TikTok sent the tab to instead is never read or pressed) or
 * shows no button ({@link BOOKMARK_SELECTOR}, laid out), `several` when it shows more than one
 * (which one is the drama's cannot be told: never pressed), else `saved` when the button or one of
 * its descendants is yellow as Chrome computes it — a computed `color`, or a computed `fill` whose
 * computed `fill-opacity` is not 0, of rgb(250, 206, 21): an svg's `color` / `fill` attribute
 * `#FACE15` counts only through that computed value, never when a style draws the element in
 * another colour, never on an HTML element (where it does nothing) — AND passes these checks: laid
 * out (`getClientRects()` not empty — an ancestor with `display: none` gives it no box), its
 * computed `visibility` neither `hidden` nor `collapse`, its own box not empty
 * (`getBoundingClientRect()`: not scaled to nothing by a CSS or an SVG transform, not sized 0), no
 * ancestor up to the button that clips it to an empty box (an overflow other than `visible` on an
 * ancestor whose box has a width or a height of 0 — not one of `display: contents`, nor a plain
 * inline element, where overflow does not apply; an `<svg>` does clip), and neither it nor any
 * ancestor up to the button of a computed `opacity` of 0; `unsaved` otherwise. A yellow variant the
 * page holds hidden in one of those ways (an icon for the other state, say) never reads saved: with
 * `press`, that would ADD the drama. A yellow hidden any other way — clipped by `clip` or
 * `clip-path`, masked or filtered, placed off-screen, under `content-visibility: hidden`, covered by
 * another element — is not detected and would read saved, as would a yellow `color` on an element
 * that paints nothing with it (Chrome 153: the reviewers' 74 structures). With `press`, a button that reads `saved`
 * is clicked once (`element.click()`, the page's own handler sends its request) and `clicked` comes
 * back; any other state is answered without a click — a button that does not read saved is never
 * pressed. Reads nothing else, changes nothing else.
 * @param {boolean} press
 * @param {string} seriesId the confirmed drama
 * @returns {"saved" | "unsaved" | "missing" | "several" | "clicked"}
 */
export function bookmarkInPage(press, seriesId) {
  if (!location.pathname.split("/").includes(String(seriesId))) return "missing"; // not the drama's page
  const selector = 'div[role="button"][data-e2e="favorite-icon"][data-key-interaction="action_favorite"]';
  /** @param {unknown} value @returns {boolean} */
  const yellow = (value) => {
    if (typeof value !== "string") return false;
    const text = value.trim().toLowerCase().replace(/\s+/g, "");
    return text === "#face15" || text === "rgb(250,206,21)" || text === "rgba(250,206,21,1)";
  };
  const shown = [...document.querySelectorAll(selector)].filter((element) => element.getClientRects().length > 0);
  if (shown.length === 0) return "missing";
  if (shown.length > 1) return "several";
  const button = /** @type {HTMLElement} */ (shown[0]);
  /**
   * Whether `element` (the button or one of its descendants) passes the checks of a drawn element:
   * laid out, visible, a box of its own that is not empty (not scaled or sized to nothing), no
   * ancestor up to the button that clips it to an empty box, and neither it nor an ancestor up to
   * the button fully transparent.
   * @param {Element} element
   * @returns {boolean}
   */
  const rendered = (element) => {
    if (element.getClientRects().length === 0) return false;
    const visibility = getComputedStyle(element).visibility;
    if (visibility === "hidden" || visibility === "collapse") return false;
    const own = element.getBoundingClientRect();
    if (own.width <= 0 || own.height <= 0) return false; // scaled to nothing (a CSS or an SVG transform), or sized 0
    /** @type {Element | null} */
    let node = element;
    while (node !== null) {
      const style = getComputedStyle(node);
      if (Number.parseFloat(style.opacity) === 0) return false;
      // an ancestor that clips to an empty box: one with a box (not `display: contents`) that its
      // overflow applies to (not a plain inline element — an <svg> is inline, and clips)
      if (node !== element && style.overflow !== "visible" && node.getClientRects().length > 0 && (style.display !== "inline" || node.namespaceURI === "http://www.w3.org/2000/svg")) {
        const box = node.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return false;
      }
      if (node === button) break;
      node = node.parentElement;
    }
    return true;
  };
  let saved = false;
  for (const element of [button, ...button.querySelectorAll("*")]) {
    const style = getComputedStyle(element);
    // the colour Chrome computes — never an attribute alone: a class may draw that element in another
    // colour, and on an HTML element a `color` attribute does nothing; a yellow fill only while its
    // `fill-opacity` is not 0
    const isYellow = yellow(style.color) || (yellow(style.getPropertyValue("fill")) && Number.parseFloat(style.getPropertyValue("fill-opacity")) !== 0);
    if (isYellow && rendered(element)) {
      saved = true;
      break;
    }
  }
  if (!saved) return "unsaved";
  if (!press) return "saved";
  button.click();
  return "clicked";
}

// ------------------------------------------------------------------------ the browser seam

/**
 * The real browser: the discovery's (`chromeBrowser(appTabId)`: the tab it opens is recorded with
 * the DramaFetch tab until it is closed) and the Bookmark read or pressed through
 * `chrome.scripting.executeScript` in the ISOLATED world ({@link bookmarkInPage}).
 * @param {number} [appTabId]
 * @returns {BookmarkBrowser}
 */
export function bookmarkBrowser(appTabId) {
  const tabs = chromeBrowser(appTabId);
  return {
    openTab: (windowId) => tabs.openTab(windowId),
    navigate: (tabId, url) => tabs.navigate(tabId, url),
    tabUrl: (tabId) => tabs.tabUrl(tabId),
    closeTab: (tabId) => tabs.closeTab(tabId),
    observe: (tabId, urls, handlers) => tabs.observe(tabId, urls, handlers),
    pageText: (tabId) => tabs.pageText(tabId),
    async bookmark(tabId, press, seriesId) {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: bookmarkInPage, args: [press, seriesId] });
      const state = injection?.result;
      const known = ["saved", "unsaved", "missing", "several", "clicked"];
      return {
        state: typeof state === "string" && known.includes(state) ? /** @type {BookmarkState} */ (state) : "missing",
        documentId: typeof injection?.documentId === "string" ? injection.documentId : null,
      };
    },
  };
}

// ------------------------------------------------------------------------------- the removal

/**
 * @typedef {object} Timing
 * @property {number} timeoutS
 * @property {number} waitS
 * @property {number} pollS
 * @property {number} pageDelayS
 */

/**
 * Wait for the drama's page to show its Bookmark button and read its state: `saved` or `unsaved`
 * once two readings a poll apart agree (a page may draw the button before it knows the state). A
 * reading of the document `staleDocument` (the page before a reload) never counts. The login page
 * stops ({@link LoginRequiredError}), the verification wall too ({@link ChallengeError}, the
 * cooldown recorded by the caller), and so does what `refused` throws — asked at every look, before
 * the state is given and before the wait ends (the page's own episode list answered 429, before
 * the click); a tab gone is `tab-gone`; no single button in a steady state within the wait — none,
 * or several (which one is the drama's cannot be told) — `bookmark-missing`.
 * @param {Engine} engine
 * @param {BookmarkBrowser} browser
 * @param {number} tabId
 * @param {string} seriesId the drama whose page alone counts
 * @param {Timing} timing
 * @param {string | null} staleDocument
 * @param {() => void} [refused] throws when TikTok refused something the page asked for meanwhile
 * @returns {Promise<{state: "saved" | "unsaved", documentId: string | null}>}
 */
async function readSteadyState(engine, browser, tabId, seriesId, timing, staleDocument, refused = () => undefined) {
  const deadline = engine.clock() + timing.timeoutS;
  /** @type {BookmarkState | null} the state the previous reading gave, of the same document */
  let previous = null;
  /** @type {string | null} */
  let previousDocument = null;
  for (;;) {
    if (engine.stopRequested?.()) throw new StopRequested();
    refused();
    let url;
    try {
      url = await browser.tabUrl(tabId);
    } catch {
      throw new BookmarkError("tab-gone");
    }
    if (isLoginUrl(url)) throw new LoginRequiredError(LOGIN_REDIRECT_MESSAGE);
    const text = await browser.pageText(tabId).catch(() => "");
    if (looksLikeChallenge(text)) throw new ChallengeError(BOOKMARK_CHALLENGE_MESSAGE);
    /** @type {BookmarkReading} */
    let reading;
    try {
      reading = await browser.bookmark(tabId, false, seriesId);
    } catch {
      reading = { state: "missing", documentId: null }; // the page is between two documents
    }
    // `several`: which one is the drama's cannot be told — never pressed; looked at again until the wait ends
    const fresh = staleDocument === null || reading.documentId === null || reading.documentId !== staleDocument;
    if (fresh && (reading.state === "saved" || reading.state === "unsaved")) {
      if (previous === reading.state && previousDocument === reading.documentId) {
        refused(); // a refusal that came during this look decides first
        return { state: reading.state, documentId: reading.documentId };
      }
      previous = reading.state;
      previousDocument = reading.documentId;
    } else {
      previous = null;
      previousDocument = null;
    }
    if (engine.clock() >= deadline) {
      refused();
      throw new BookmarkError("bookmark-missing");
    }
    await engine.sleep(timing.pollS);
  }
}

/**
 * The list-page pause, then the cooldown asked: one in force stops the removal before its next
 * step (its message, no request).
 * @param {Engine} engine
 * @param {Timing} timing
 * @returns {Promise<void>}
 */
async function pauseBeforeStep(engine, timing) {
  if (engine.stopRequested?.()) throw new StopRequested();
  await engine.sleep(pagePause(engine.rng, timing.pageDelayS));
  if (engine.stopRequested?.()) throw new StopRequested();
  const cooldown = await checkCooldown(engine);
  if (cooldown !== null) throw new BookmarkCooldown(cooldownMessage(cooldown, { now: engine.wallClock() }));
}

/**
 * TikTok refused the page's own `collect` request — among the statuses noted since right before
 * the click: 429 → {@link RateLimitedError}, 403 → {@link BookmarkRefusedError}. Asked at every
 * look after the click, also once the button reads off (a page may draw it off before TikTok's
 * answer comes), before the reload and after it, and on every other end after the click: a refusal
 * is always a stop with the cooldown.
 * @param {readonly number[]} collects
 */
function stopIfRefused(collects) {
  if (collects.includes(429)) throw new RateLimitedError(BOOKMARK_RATE_LIMIT_MESSAGE);
  if (collects.includes(403)) throw new BookmarkRefusedError();
}

/**
 * Whether `error` is one of TikTok's refusals (a stop with the 30-minute cooldown).
 * @param {unknown} error
 * @returns {error is RateLimitedError | ChallengeError | BookmarkRefusedError}
 */
function refusedByTikTok(error) {
  return error instanceof RateLimitedError || error instanceof ChallengeError || error instanceof BookmarkRefusedError;
}

/**
 * After the one click: wait at most `timing.waitS` for the button to read `unsaved` AND for TikTok's
 * answer to the page's own `collect` (a request cut short, status 0, counts) — a page may draw the
 * button off before that answer comes, and the reload that follows would cut the request short, so
 * that a late refusal were never seen. The page's own `collect` answered 429 →
 * {@link RateLimitedError}, 403 → {@link BookmarkRefusedError}; the wall in the tab →
 * {@link ChallengeError}; no change in time, or the tab gone, → `false`; the button off but no
 * answer seen by the end of the wait → `true` (the reload checks it).
 * @param {Engine} engine
 * @param {BookmarkBrowser} browser
 * @param {number} tabId
 * @param {string} seriesId the drama whose page alone counts
 * @param {Timing} timing
 * @param {readonly number[]} collects the statuses of the page's `collect` requests since the click
 * @returns {Promise<boolean>} whether the button turned off
 */
async function turnedOff(engine, browser, tabId, seriesId, timing, collects) {
  const deadline = engine.clock() + timing.waitS;
  let off = false;
  for (;;) {
    stopIfRefused(collects);
    try {
      await browser.tabUrl(tabId);
    } catch {
      return false; // the tab was closed: nothing can be seen any more
    }
    const text = await browser.pageText(tabId).catch(() => "");
    if (looksLikeChallenge(text)) throw new ChallengeError(BOOKMARK_CHALLENGE_MESSAGE);
    if (!off) {
      const reading = await browser.bookmark(tabId, false, seriesId).catch(() => ({ state: "missing", documentId: null }));
      off = reading.state === "unsaved";
    }
    if (off) {
      stopIfRefused(collects); // drawn off before TikTok answered: its answer decides
      if (collects.length > 0) return true; // TikTok answered the page's request
    }
    if (engine.clock() >= deadline) return off; // off, and no answer seen in time: the reload checks it
    await engine.sleep(timing.pollS);
  }
}

/**
 * Remove the drama `seriesId` from the user's Bookmark with TikTok's own button (see the module's
 * comment for every step): `removed` once the reloaded page shows the button off, `already` when
 * the page showed it off before anything was pressed. Throws {@link BookmarkError} (nothing
 * removed, no cooldown), {@link LoginRequiredError}, {@link BookmarkCooldown}, `StopRequested`, and
 * TikTok's refusals — {@link RateLimitedError}, {@link BookmarkRefusedError}, {@link ChallengeError}
 * — with the 30-minute cooldown recorded first (source `discovery`, the reason their message). A
 * 429 on the drama page's own episode list after the click leaves the outcome as it is and records
 * the cooldown too (`LIST_RATE_LIMIT_MESSAGE`): a `removed` then carries it as `refused`. The tab
 * it opened is closed on every path.
 * @param {Engine} engine the job's: its sleep, random source, clocks, cooldown and Stop
 * @param {string} seriesId
 * @param {BookmarkOptions} [options]
 * @returns {Promise<BookmarkResult>}
 */
export async function removeFromBookmark(engine, seriesId, options = {}) {
  const base = (options.baseUrl ?? TIKTOK_BASE_URL).replace(/\/+$/, "");
  const browser = options.browser ?? bookmarkBrowser(options.appTabId);
  /** @type {Timing} */
  const timing = {
    timeoutS: options.timeoutS ?? DISCOVERY_TIMEOUT_S,
    waitS: options.waitS ?? CHANGE_WAIT_S,
    pollS: options.pollS ?? POLL_S,
    pageDelayS: options.pageDelayS ?? PAGE_DELAY_S,
  };
  const page = seriesPageUrl(seriesId, 1, base);
  /** @type {number | null} */
  let tabId = null;
  /** @type {(() => void) | null} */
  let stopObserving = null;
  let pressed = false;
  /** whether the page's `collect` requests are noted: from right before the click on */
  let listening = false;
  /** @type {number[]} the statuses of the page's own `collect` requests from the click on: nothing else */
  const collects = [];
  /** whether TikTok answered the drama page's own episode list HTTP 429 (the discovery's rule), from its first load on */
  let listRefused = false;
  /** Before the click, that 429 is the removal's stop: nothing is pressed into a rate limit. */
  const stopIfListRefused = () => {
    if (listRefused) throw new RateLimitedError(LIST_RATE_LIMIT_MESSAGE);
  };
  try {
    tabId = await browser.openTab(options.windowId);
    const tab = tabId;
    stopObserving = browser.observe(tab, observedUrlPatterns(base), {
      completed: (request) => {
        // their status only: the page's own episode list (a 429 is a refusal, as for the discovery) and, from the click on, its `collect`
        if (request.url.includes(ITEM_LIST_MARKER) && request.status === 429) listRefused = true;
        if (listening && isCollectUrl(request.url)) collects.push(request.status);
      },
    });
    try {
      await browser.navigate(tab, page);
    } catch {
      throw new BookmarkError("tab-gone"); // closed before anything was pressed
    }
    const before = await readSteadyState(engine, browser, tab, seriesId, timing, null, stopIfListRefused);
    if (before.state === "unsaved") return { outcome: "already" }; // nothing to press
    await pauseBeforeStep(engine, timing);
    stopIfListRefused(); // a 429 on the page's own list during the pause: still nothing pressed
    /** @type {BookmarkReading} */
    let press;
    listening = true; // the page's answer may come before the click's own does
    try {
      press = await browser.bookmark(tab, true, seriesId);
    } catch {
      throw new BookmarkError("tab-gone");
    }
    if (press.state !== "clicked") throw new BookmarkError("bookmark-missing"); // it changed meanwhile: nothing pressed
    pressed = true;
    options.onPressed?.();
    if (!(await turnedOff(engine, browser, tab, seriesId, timing, collects))) throw new BookmarkError("not-confirmed");
    // did TikTok keep it? the page loaded again, read from its new document only
    await pauseBeforeStep(engine, timing);
    stopIfRefused(collects); // TikTok's answer may have come during the pause
    if (listRefused) throw new BookmarkError("not-confirmed"); // no reload into a 429: pressed, nothing to check it by
    try {
      await browser.navigate(tab, page);
    } catch {
      throw new BookmarkError("not-confirmed"); // the tab closed meanwhile: pressed, nothing to check it by
    }
    let after;
    try {
      after = await readSteadyState(engine, browser, tab, seriesId, timing, press.documentId);
    } catch (error) {
      if (error instanceof BookmarkError) throw new BookmarkError("not-confirmed"); // pressed, but nothing to check it by
      throw error;
    }
    stopIfRefused(collects);
    if (after.state === "saved") throw new BookmarkError("not-kept");
    if (listRefused) {
      // the reloaded page's own episode list answered 429: the removal stands; the cooldown, and a stop
      await recordBlock(engine.cooldownStore, LIST_RATE_LIMIT_MESSAGE, DISCOVERY_SOURCE, { now: engine.wallClock() });
      return { outcome: "removed", refused: LIST_RATE_LIMIT_MESSAGE };
    }
    return { outcome: "removed" };
  } catch (caught) {
    let error = caught;
    if (pressed && !refusedByTikTok(error)) {
      // pressed, then no outcome to act on — not confirmed, not kept, Stop, the login page, a
      // cooldown, the tab gone: when TikTok refused the page's request meanwhile, that refusal is
      // the outcome — a stop with the cooldown
      try {
        stopIfRefused(collects);
      } catch (refusal) {
        error = refusal;
      }
    }
    if (refusedByTikTok(error)) {
      await recordBlock(engine.cooldownStore, error.message, DISCOVERY_SOURCE, { now: engine.wallClock() });
    } else if (listRefused) {
      // TikTok answered the page's own episode list 429 meanwhile: the outcome stays, the cooldown is recorded
      await recordBlock(engine.cooldownStore, LIST_RATE_LIMIT_MESSAGE, DISCOVERY_SOURCE, { now: engine.wallClock() });
    }
    throw error;
  } finally {
    if (stopObserving !== null) stopObserving();
    if (tabId !== null) await browser.closeTab(tabId).catch(() => undefined);
  }
}

/**
 * After a removal, TikTok's count — ONE request: the first page of the favorites list of TikTok tab
 * `tabId`, its address `template` replayed byte for byte (`favorites.listFavorites` with one page:
 * the list-page pause, the cooldown, the tab checked, a refusal a stop with the cooldown). Whether
 * the removed drama is still on that page: TikTok did not keep the change after all.
 * @param {Engine} engine
 * @param {number} tabId
 * @param {string} template
 * @param {string} seriesId the drama removed
 * @param {Omit<import("./favorites.js").FavoritesOptions, "maxPages" | "until" | "onPage">} [options]
 * @returns {Promise<{total: number | null, stillListed: boolean, items: import("../lib/favorites.js").FavoriteItem[]}>}
 */
export async function countAfterRemoval(engine, tabId, template, seriesId, options = {}) {
  const listing = await listFavorites(engine, tabId, template, { ...options, maxPages: 1 });
  return { total: listing.total, stillListed: listing.items.some((item) => item.seriesId === seriesId), items: listing.items };
}
