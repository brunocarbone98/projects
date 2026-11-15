// @ts-check
/**
 * The right-clicked drama of the user's TikTok favorites (the owner's decision of 2026-11-15).
 *
 * A classic content script (MV3 content scripts are no modules), in the ISOLATED world of
 * `https://www.tiktok.com/*` pages at `document_idle`, wrapped so that it declares no global. The
 * entries of a profile's **Favorites** → **Drama** grid are buttons, not links — `<button
 * aria-label="<dramaName>" class="…ButtonFavoriteDramaCard…">` — so Chrome cannot tell the
 * right-click menu which one was right-clicked. This script listens for `contextmenu` on `window`
 * — the earliest point of the capture phase, before any listener of the page's document can stop
 * the event — passively (it never changes how the page handles it) and, when the right-click is
 * inside a favorites card, remembers the card's `aria-label` (the drama's name) and its position
 * among the page's favorites cards in document order — nothing else; a right-click anywhere else
 * forgets it. It answers the extension's own `{type: "dramafetch:card"}` message (the worker's,
 * when **Download this favorite drama** was clicked) with that record while it is under 30 s old
 * (`CARD_MAX_AGE_S` of `lib/favorites.js`), then forgets it; otherwise with null. It reads nothing
 * else, changes nothing in the page, sends nothing anywhere else and holds no cookie.
 */
(() => {
  /** The cards of the grid: `FAVORITES_CARD_SELECTOR` of `lib/favorites.js`, the same text. */
  const CARD_SELECTOR = "button[aria-label][class*=FavoriteDramaCard]";
  /** How long a right-clicked card is remembered (`CARD_MAX_AGE_S` × 1000). */
  const MAX_AGE_MS = 30_000;

  /** @type {{title: string, index: number, at: number} | null} the last right-clicked card */
  let remembered = null;

  /**
   * The favorites card `target` is inside, or null.
   * @param {EventTarget | null} target
   * @returns {Element | null}
   */
  const cardOf = (target) => {
    const element = /** @type {Element | null} */ (target);
    if (element === null || typeof element.closest !== "function") return null;
    return element.closest(CARD_SELECTOR);
  };

  window.addEventListener(
    "contextmenu",
    (event) => {
      const card = cardOf(event.target);
      if (card === null) {
        remembered = null; // a right-click elsewhere: the menu's click is about no card
        return;
      }
      const cards = [...document.querySelectorAll(CARD_SELECTOR)];
      remembered = { title: card.getAttribute("aria-label") ?? "", index: cards.indexOf(card), at: Date.now() };
    },
    { capture: true, passive: true },
  );

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return; // only this extension's own worker
    if (message === null || typeof message !== "object" || /** @type {{type?: unknown}} */ (message).type !== "dramafetch:card") return;
    const card = remembered !== null && Date.now() - remembered.at < MAX_AGE_MS ? remembered : null;
    remembered = null; // answered once
    sendResponse(card);
  });
})();
