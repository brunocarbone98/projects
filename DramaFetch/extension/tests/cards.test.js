// @ts-check
// The content script of the favorites right-click (src/content/cards.js), over a minimal fake
// window and document and a fake chrome: what it hears (a `contextmenu` on `window`, in the capture
// phase, passively), what
// it remembers of a right-clicked favorites card (its aria-label and its position among the page's
// cards — nothing else), how it answers the extension's own `dramafetch:card` message (once, while
// under 30 s old, else null) and that it changes nothing in the page. No browser: the integration
// scenario (tests/integration/test_extension_ui.py) dispatches a real contextmenu in Chromium.
import assert from "node:assert/strict";
import { test } from "node:test";

import { CARD_MAX_AGE_S, FAVORITES_CARD_SELECTOR } from "../src/lib/favorites.js";

/** An element of the fake page: a tag, attributes, a parent; `closest` knows the card selector only. */
class FakeNode {
  /**
   * @param {string} tag
   * @param {Record<string, string>} [attributes]
   * @param {FakeNode | null} [parent]
   */
  constructor(tag, attributes = {}, parent = null) {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.parent = parent;
    /** @type {string[]} every call that would change the element */
    this.changes = [];
  }
  /** @param {string} name @returns {string | null} */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.changes.push(`setAttribute ${name}=${value}`);
  }
  /** @returns {boolean} whether this is a favorites card ({@link FAVORITES_CARD_SELECTOR}) */
  isCard() {
    return this.tagName === "BUTTON" && this.attributes.has("aria-label") && (this.attributes.get("class") ?? "").includes("FavoriteDramaCard");
  }
  /** @param {string} selector @returns {FakeNode | null} */
  closest(selector) {
    assert.equal(selector, FAVORITES_CARD_SELECTOR, "the content script looks for the favorites card only");
    for (let node = /** @type {FakeNode | null} */ (this); node !== null; node = node.parent) if (node.isCard()) return node;
    return null;
  }
}

/**
 * A profile page with the favorites grid: `titles` as cards (a cover `<img>` and a title `<p>`
 * each), plus a button that is no favorites card (TikTok's "Follow") and a plain text block.
 * @param {string[]} titles
 */
function fakeProfile(titles) {
  const grid = new FakeNode("div", { class: "css-1qb12g8-DivDramaGrid" });
  const cards = titles.map(
    (title) => new FakeNode("button", { type: "button", "aria-label": title, "aria-disabled": "false", class: "css-d8d7up-7937d88b--ButtonFavoriteDramaCard eqgng220" }, grid),
  );
  const parts = cards.map((card) => ({
    cover: new FakeNode("img", { src: "https://p16-sign.tiktokcdn.com/cover.avif", alt: "" }, card),
    title: new FakeNode("p", { class: "css-1o7f8ch-7937d88b--PFavoriteDramaTitle eqgng227" }, card),
  }));
  const follow = new FakeNode("button", { "aria-label": "Follow", class: "css-1hy6x9b-ButtonFollow" });
  const text = new FakeNode("div", { class: "css-bio" });
  return { grid, cards, parts, follow, text };
}

test("the content script remembers the right-clicked favorites card — its label and position, nothing else — and answers the extension's own message once, within 30 s", async () => {
  const profile = fakeProfile(["The Lighthouse Keeper's Promise", "Snowfall in Two Cities", "Snowfall in Two Cities", "Paper Crowns"]);
  /** @type {{type: string, listener: (event: {target: unknown}) => void, options: unknown}[]} the listeners on `window` */
  const listened = [];
  /** @type {string[]} what was listened for on `document` (nothing: `window` comes first in the capture path) */
  const onDocument = [];
  /** @type {string[]} */
  const queried = [];
  /** @type {((message: unknown, sender: {id?: string}, sendResponse: (response?: unknown) => void) => unknown)[]} */
  const onMessage = [];
  let clock = 1_794_351_000_000;
  const realNow = Date.now;
  Object.assign(globalThis, {
    window: {
      /** @param {string} type @param {(event: {target: unknown}) => void} listener @param {unknown} options */
      addEventListener: (type, listener, options) => void listened.push({ type, listener, options }),
    },
    document: {
      /** @param {string} type */
      addEventListener: (type) => void onDocument.push(type),
      /** @param {string} selector */
      querySelectorAll: (selector) => {
        queried.push(selector);
        assert.equal(selector, FAVORITES_CARD_SELECTOR);
        return profile.cards; // in document order
      },
    },
    chrome: {
      runtime: {
        id: "dramafetch-test-id",
        onMessage: { addListener: (/** @type {(typeof onMessage)[number]} */ listener) => void onMessage.push(listener) },
      },
    },
  });
  Date.now = () => clock;
  try {
    await import(new URL("../src/content/cards.js?cards", import.meta.url).href);
    // one listener: contextmenu on `window` — the earliest point of the capture path, before any of
    // the page's own listeners on its document —, in the capture phase, passive: it never changes
    // how the page handles it
    assert.deepEqual(
      listened.map(({ type, options }) => [type, options]),
      [["contextmenu", { capture: true, passive: true }]],
    );
    assert.deepEqual(onDocument, []);
    assert.equal(onMessage.length, 1);
    const [{ listener: contextmenu }] = /** @type {[(typeof listened)[number]]} */ (listened);
    const [answer] = /** @type {[(typeof onMessage)[number]]} */ (onMessage);
    /** @param {unknown} message @param {string} [sender] @returns {unknown[]} what the script answered */
    const ask = (message, sender = "dramafetch-test-id") => {
      /** @type {unknown[]} */
      const answers = [];
      answer(message, { id: sender }, (response) => void answers.push(response));
      return answers;
    };
    const card = { type: "dramafetch:card" };

    // nothing right-clicked yet
    assert.deepEqual(ask(card), [null]);
    // the second card's title: its label and its position among the page's cards
    contextmenu({ target: profile.parts[1]?.title });
    assert.deepEqual(ask(card), [{ title: "Snowfall in Two Cities", index: 1, at: clock }]);
    assert.deepEqual(ask(card), [null]); // answered once, then forgotten
    // the third card's cover (a picture inside the button): the third card, not the second of the same title
    contextmenu({ target: profile.parts[2]?.cover });
    clock += (CARD_MAX_AGE_S - 0.1) * 1000;
    assert.deepEqual(ask(card), [{ title: "Snowfall in Two Cities", index: 2, at: clock - (CARD_MAX_AGE_S - 0.1) * 1000 }]);
    // remembered 30 s or longer ago: no card
    contextmenu({ target: profile.cards[3] });
    clock += CARD_MAX_AGE_S * 1000;
    assert.deepEqual(ask(card), [null]);
    // a right-click on no card forgets the last one: the menu's click is about no card
    contextmenu({ target: profile.parts[0]?.title });
    contextmenu({ target: profile.follow }); // a button, but no favorites card
    assert.deepEqual(ask(card), [null]);
    contextmenu({ target: profile.cards[0] });
    contextmenu({ target: profile.text });
    assert.deepEqual(ask(card), [null]);
    contextmenu({ target: null });
    contextmenu({ target: { nodeType: 3 } }); // no element (nothing to look up from)
    assert.deepEqual(ask(card), [null]);

    // only the extension's own message, and only that one, is answered
    contextmenu({ target: profile.parts[3]?.title });
    assert.deepEqual(ask(card, "another-extension"), []);
    assert.deepEqual(ask({ type: "dramafetch:load" }), []);
    assert.deepEqual(ask("dramafetch:card"), []);
    assert.deepEqual(ask(null), []);
    assert.deepEqual(ask(card), [{ title: "Paper Crowns", index: 3, at: clock }]); // still there for the right one

    // it read the page's cards and their labels, and changed nothing
    assert.ok(queried.length > 0);
    for (const node of [profile.grid, ...profile.cards, ...profile.parts.flatMap(({ cover, title }) => [cover, title]), profile.follow, profile.text]) {
      assert.deepEqual(node.changes, []);
    }
  } finally {
    Date.now = realNow;
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "chrome");
  }
});
