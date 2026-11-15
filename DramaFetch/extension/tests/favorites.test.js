// @ts-check
// The user's TikTok favorites list as DramaFetch reads it (src/lib/favorites.js, pure): which
// request is the list's first page (the only one the worker keeps), one page of TikTok's
// `drama_list` answer — the anonymized capture of 2026-11-15, tests/fixtures/drama_list_page.json,
// with two DIFFERENT dramas of the same title, as in the owner's list —, the resolver that turns a
// right-clicked card into its drama (never a guess between dramas of the same title) and how far a
// card's listing reads, the lines a favorite adds to the box, the checks of what a TikTok tab's
// content script answers, the hand-over's address and the status DramaFetch's own records give a
// favorite. No browser, no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CARD_MAX_AGE_S,
  FAVORITES_CARD_SELECTOR,
  FAVORITES_MAX_PAGES,
  FAVORITES_URL_WORD,
  FavoritesPayloadError,
  MAX_CARD_TITLE_LENGTH,
  NOT_A_LIST_MESSAGE,
  boxWithFavorites,
  cardOf,
  cleanTitle,
  coversCard,
  coversShift,
  durationParts,
  favoritesOfQuery,
  favoritesQuery,
  handoverOf,
  isDramaListUrl,
  isFavoritesFirstPageUrl,
  isProfilePageUrl,
  parseDramaListPayload,
  progressStatus,
  resolveCard,
  titleMatches,
} from "../src/lib/favorites.js";
import { markComplete, newState, record } from "../src/lib/state.js";
import { parseSeriesList } from "../src/lib/urls.js";

/** @type {Record<string, unknown>} the anonymized capture of one page of the owner's list */
const CAPTURE = JSON.parse(readFileSync(new URL("../../tests/fixtures/drama_list_page.json", import.meta.url), "utf8"));
const LIGHTHOUSE = "7712345678901234561";
const SNOW_A = "7712345678901234562";
const SNOW_B = "7712345678901234563";

/**
 * A copy of the capture with `changes` applied to the page (its `dramaList` untouched unless given).
 * @param {Record<string, unknown>} changes
 * @returns {Record<string, unknown>}
 */
const page = (changes) => ({ ...JSON.parse(JSON.stringify(CAPTURE)), ...changes });

/** @param {string} seriesId @param {string | null} title @returns {import("../src/lib/favorites.js").FavoriteItem} */
const item = (seriesId, title) => ({ seriesId, title, episodes: 60, durationS: 4743 });

test("the constants: 100 pages at most, the card's selector and age, the drama_list path", () => {
  assert.equal(FAVORITES_MAX_PAGES, 100);
  assert.equal(FAVORITES_CARD_SELECTOR, "button[aria-label][class*=FavoriteDramaCard]");
  assert.equal(CARD_MAX_AGE_S, 30);
  for (const url of [
    "https://www.tiktok.com/api/user/favorite/drama_list/?WebIdLastTime=1794300000&aid=1988&cursor=0",
    "https://www.tiktok.com/api/favorite/drama_list?aid=1988",
    "http://127.0.0.1:8123/api/user/favorite/drama_list/?cursor=0",
  ]) {
    assert.equal(isDramaListUrl(url), true, url);
  }
  for (const url of [
    "https://www.tiktok.com/api/drama/episode/item_list/?dramaID=1&from=drama_list",
    "https://www.tiktok.com/api/user/detail/#/drama_list/",
    "https://www.tiktok.com/api/favorite/drama_listing/?aid=1",
    "https://www.tiktok.com/api/drama_list/recommend/?aid=1", // a drama_list segment, not the path's end
    "https://drama_list.example.com/",
    "not a url",
  ]) {
    assert.equal(isDramaListUrl(url), false, url);
  }
});

test("the favorites list's first page — the only address the worker keeps: a drama_list path, `favorite` in the address, a cursor absent, empty or 0", () => {
  assert.equal(FAVORITES_URL_WORD, "favorite");
  const base = "https://www.tiktok.com/api/user/favorite/drama_list/";
  const signed = "WebIdLastTime=1794300000&aid=1988&count=19&X-Bogus=DFSzswVOxQ";
  for (const url of [
    `${base}?${signed}`, // no cursor at all
    `${base}?${signed}&cursor=0`,
    `${base}?cursor=0&${signed}`,
    `${base}?${signed}&cursor=`, // an empty cursor
    `${base}?${signed}&cursor`, // a cursor without a value
    `${base}?${signed}&cursor=%30`, // percent-encoded 0
    `${base}?${signed}&%63ursor=0`, // the key percent-encoded too
    `${base}?${signed}&cursor=0#cursor=1794351568`, // the fragment is no query
    "https://www.tiktok.com/api/favorite/drama_list?aid=1988&cursor=0", // the path without its last slash
    "https://www.tiktok.com/api/user/FAVORITE/drama_list/?aid=1988", // letter case aside
    "https://www.tiktok.com/api/drama_list/?scene=favorite_tab&cursor=0", // the word anywhere in the address
    "http://127.0.0.1:8123/api/user/favorite/drama_list/?cursor=0", // the fake TikTok's (test mode)
  ]) {
    assert.equal(isFavoritesFirstPageUrl(url), true, url);
  }
  for (const url of [
    `${base}?${signed}&cursor=1794351568`, // a later page: the page's own as its grid scrolls, or DramaFetch's
    `${base}?cursor=1794350100&${signed}`,
    `${base}?${signed}&cursor=%31794351568`, // percent-encoded, still a later page
    `${base}?${signed}&cursor=00`,
    `${base}?${signed}&cursor=%200`, // " 0" is not 0
    `${base}?${signed}&cursor=0&cursor=1794351568`, // every cursor must say the first page
    `${base}?${signed}&%63ursor=19`,
    "https://www.tiktok.com/api/user/detail/?from=favorite_drama_list&cursor=0", // drama_list in the query only
    "https://www.tiktok.com/api/user/detail/?next=/favorite/drama_list/", // the same, a path-shaped value
    "https://www.tiktok.com/api/drama/recommend/drama_list/?aid=1988&cursor=0", // a drama_list without `favorite`
    "https://www.tiktok.com/api/drama/episode/item_list/?dramaID=1&cursor=0&from=favorite",
    "https://favorite.drama_list.example.com/?cursor=0", // drama_list in another host's name, not its path
    "https://drama_list.example.com/favorite?cursor=0",
    "https://www.tiktok.com/api/user/favorite/drama_listing/?cursor=0",
    "not a url",
  ]) {
    assert.equal(isFavoritesFirstPageUrl(url), false, url);
  }
});

test("a page of the list: the capture's three dramas in its order — the two of the same title kept apart —, numbers given as strings read, the cursor, hasMore and the total", () => {
  const parsed = parseDramaListPayload(CAPTURE);
  assert.deepEqual(parsed, {
    items: [
      { seriesId: LIGHTHOUSE, title: "The Lighthouse Keeper's Promise", episodes: 60, durationS: 4743 },
      { seriesId: SNOW_A, title: "Snowfall in Two Cities", episodes: 60, durationS: 5827 },
      { seriesId: SNOW_B, title: "Snowfall in Two Cities", episodes: 60, durationS: 5827 },
    ],
    cursor: "1794351568",
    hasMore: true,
    total: 946,
    skipped: 0,
  });
  // the same as numbers, flags and a numeric cursor
  const numeric = parseDramaListPayload(page({ cursor: 1794351568, hasMore: 1, total: 946, statusCode: "0", status_code: 0 }));
  assert.equal(numeric.cursor, "1794351568");
  assert.equal(numeric.hasMore, true);
  assert.equal(numeric.total, 946);
  assert.equal(parseDramaListPayload(page({ hasMore: "false" })).hasMore, false);
  assert.equal(parseDramaListPayload(page({ hasMore: false })).hasMore, false);
  // a title on one line: line breaks and runs of blanks collapsed, NFC
  const list = /** @type {Record<string, unknown>[]} */ (page({})["dramaList"]);
  const odd = { ...list[0], dramaName: "  Café\n  at\tNight  ", numVideos: "12", totalDuration: 59.6 };
  assert.deepEqual(parseDramaListPayload({ dramaList: [odd], hasMore: false }).items, [
    { seriesId: LIGHTHOUSE, title: "Café at Night", episodes: 12, durationS: 59.6 },
  ]);
});

test("an item without a valid dramaID is left out and counted; a page missing fields degrades and never throws", () => {
  const list = /** @type {Record<string, unknown>[]} */ (page({})["dramaList"]);
  const [first, second] = list;
  const bad = [
    { ...first, dramaID: Number(LIGHTHOUSE) }, // a 19-digit JSON number is no exact id
    { ...first, dramaID: "12345" }, // too short
    { ...first, dramaID: "７７１２３４５６７８９０１２３４５６１" }, // full-width digits
    { ...first, dramaID: "" },
    { dramaName: "No id at all" },
    "not an item",
    null,
  ];
  const parsed = parseDramaListPayload({ dramaList: [...bad, second], cursor: "", hasMore: true });
  assert.deepEqual(parsed.items.map((entry) => entry.seriesId), [SNOW_A]);
  assert.equal(parsed.skipped, bad.length);
  assert.equal(parsed.cursor, null); // an empty cursor is none
  assert.equal(parsed.total, null);
  // missing numbers and title: null, never an error
  assert.deepEqual(parseDramaListPayload({ dramaList: [{ dramaID: ` ${SNOW_B} ` }] }), {
    items: [{ seriesId: SNOW_B, title: null, episodes: null, durationS: null }],
    cursor: null,
    hasMore: false,
    total: null,
    skipped: 0,
  });
  for (const junk of [{ numVideos: -1, totalDuration: "1h 19m" }, { numVideos: "60 episodes", totalDuration: -4 }, { numVideos: 1.5, totalDuration: true }]) {
    const [found] = parseDramaListPayload({ dramaList: [{ ...first, ...junk }] }).items;
    assert.equal(found?.seriesId, LIGHTHOUSE);
    assert.equal(found?.episodes, null);
    assert.equal(found?.durationS, null);
  }
  // an empty page is no error — also one that leaves its empty `dramaList` out but has the list's own `hasMore`
  assert.deepEqual(parseDramaListPayload({ dramaList: [], hasMore: false, statusCode: 0 }).items, []);
  assert.deepEqual(parseDramaListPayload({ statusCode: 0, hasMore: false, total: "0" }), { items: [], cursor: null, hasMore: false, total: 0, skipped: 0 });
  assert.deepEqual(parseDramaListPayload({ dramaList: null, hasMore: false }).items, []);
});

test("TikTok's own error (statusCode or status_code not 0) is an error carrying status_msg; an answer that is no list too — JSON without a `dramaList` array and without the list's `hasMore`", () => {
  /** @param {string} message @param {number | null} [code] @returns {(error: unknown) => boolean} */
  const failsWith = (message, code = null) => (error) =>
    error instanceof FavoritesPayloadError && error.message === message && error.code === code;
  assert.throws(() => parseDramaListPayload(page({ statusCode: 10201, status_code: 10201, status_msg: "Something went wrong" })), failsWith("Something went wrong", 10201));
  assert.throws(() => parseDramaListPayload(page({ status_code: "8", status_msg: "", statusMsg: "Login required" })), failsWith("Login required", 8));
  assert.throws(() => parseDramaListPayload(page({ statusCode: 7, status_msg: "" })), failsWith("statusCode 7", 7));
  for (const junk of [
    null,
    [],
    "<!doctype html>",
    42,
    {},
    { statusCode: 0 },
    { statusCode: 0, status_code: 0, status_msg: "" },
    { status_code: 0, itemList: [] }, // another list, not the favorites'
    { statusCode: 0, data: { list: [] }, has_more: true },
    { dramaList: "nope" },
    { dramaList: { a: 1 } },
  ]) {
    assert.throws(() => parseDramaListPayload(junk), failsWith(NOT_A_LIST_MESSAGE), JSON.stringify(junk));
  }
});

test("a right-clicked card: the one series of its title, wherever it is; several different series of that title are shared — never a guess by position —; none, missing", () => {
  const items = [item("7700000000000000001", "Moonlight Over the Harbor"), item(SNOW_A, "Snowfall in Two Cities"), item(LIGHTHOUSE, "The Lighthouse Keeper's Promise"), item(SNOW_B, "Snowfall in Two Cities"), item("7700000000000000005", "Paper Crowns")];
  // the one series of that title: at the card's position, or elsewhere (a favorite added or removed since the grid loaded)
  assert.deepEqual(resolveCard(items, { title: "Paper Crowns", index: 4 }), { kind: "found", item: items[4], index: 4 });
  assert.deepEqual(resolveCard(items, { title: "Paper Crowns", index: 3 }), { kind: "found", item: items[4], index: 4 });
  assert.deepEqual(resolveCard(items, { title: "Moonlight Over the Harbor", index: 40 }), { kind: "found", item: items[0], index: 0 });
  // the title compared on one line, NFC (the page's aria-label against TikTok's dramaName)
  assert.deepEqual(resolveCard(items, { title: " The Lighthouse\n Keeper's  Promise ", index: 2 }), { kind: "found", item: items[2], index: 2 });
  // two DIFFERENT dramas of that title: shared, at the card's position or not — the position cannot
  // tell them apart once the grid has moved; both, in the list's order
  for (const index of [0, 1, 2, 3, 4, 40]) {
    assert.deepEqual(resolveCard(items, { title: "Snowfall in Two Cities", index }), { kind: "shared", items: [items[1], items[3]] }, String(index));
  }
  // the same drama listed twice is one series: found, at the card's position when it is there
  const twice = [item(SNOW_A, "Snowfall in Two Cities"), item(LIGHTHOUSE, "The Lighthouse Keeper's Promise"), item(SNOW_A, "Snowfall in Two Cities")];
  assert.deepEqual(resolveCard(twice, { title: "Snowfall in Two Cities", index: 2 }), { kind: "found", item: twice[2], index: 2 });
  assert.deepEqual(resolveCard(twice, { title: "Snowfall in Two Cities", index: 1 }), { kind: "found", item: twice[0], index: 0 });
  // three dramas of a title: all of them
  const three = [...items, item("7700000000000000006", "Snowfall in Two Cities")];
  assert.deepEqual(resolveCard(three, { title: "Snowfall in Two Cities", index: 5 }), { kind: "shared", items: [items[1], items[3], three[5]] });
  // no item of that title: missing (the list changed); letter case counts; an empty title is none
  assert.deepEqual(resolveCard(items, { title: "Snowfall In Two Cities", index: 1 }), { kind: "missing" });
  assert.deepEqual(resolveCard(items, { title: "A Drama Not Listed", index: 0 }), { kind: "missing" });
  assert.deepEqual(resolveCard(items, { title: "   ", index: 0 }), { kind: "missing" });
  assert.deepEqual(resolveCard([], { title: "Paper Crowns", index: 0 }), { kind: "missing" });
  assert.deepEqual(resolveCard([item(SNOW_A, null)], { title: SNOW_A, index: 0 }), { kind: "missing" });
});

test("how far a card's listing reads: past the card's position, its title in view, one drama after the last of that title — a twin may begin the next page —, and a page past the card's position when its drama is not where the card sits", () => {
  const page1 = [item(LIGHTHOUSE, "The Lighthouse Keeper's Promise"), item(SNOW_A, "Snowfall in Two Cities"), item("7700000000000000003", "Paper Crowns")];
  const per = page1.length; // three dramas a page
  // the card's position covered and its title in view there, a drama after it: far enough
  assert.equal(coversCard(page1, { title: "Snowfall in Two Cities", index: 1 }, per), true);
  // the title further down than the card's position (a drama that moved down — or another drama of
  // that title): a page past the card's position, then far enough
  assert.equal(coversCard(page1, { title: "Snowfall in Two Cities", index: 0 }, per), false);
  assert.equal(coversCard([...page1, item("7700000000000000004", "Tea House Vows")], { title: "Snowfall in Two Cities", index: 0 }, per), true);
  // not past the card's position yet: read on (the grid holds more cards than read so far)
  assert.equal(coversCard(page1, { title: "Snowfall in Two Cities", index: 3 }, per), false);
  assert.equal(coversCard(page1, { title: "Paper Crowns", index: 2 }, per), false); // the last one read: a twin may follow
  // the title not in view yet: read on (a drama that moved down)
  assert.equal(coversCard(page1, { title: "Moonlight Over the Harbor", index: 0 }, per), false);
  // the last drama of that title is the last one read: one page more, so that its twin, first on
  // the next page, is seen — then both are, and the card is shared
  const page2 = [...page1, item(SNOW_B, "Snowfall in Two Cities"), item("7700000000000000005", "Tea House Vows")];
  assert.equal(coversCard([...page1, item(SNOW_B, "Snowfall in Two Cities")], { title: "Snowfall in Two Cities", index: 1 }, per), false);
  assert.equal(coversCard(page2, { title: "Snowfall in Two Cities", index: 1 }, per), true);
  assert.equal(resolveCard(page2, { title: "Snowfall in Two Cities", index: 1 }).kind, "shared");
  // the title compared on one line, NFC; an empty title never covers
  assert.equal(coversCard(page1, { title: " Snowfall  in\nTwo Cities ", index: 1 }, per), true);
  assert.equal(coversCard(page1, { title: "  ", index: 0 }, per), false);
  assert.equal(coversCard([], { title: "Paper Crowns", index: 0 }, per), false);
});

test("a card whose drama is not where the card sits — the grid moved since it loaded, a favorite added elsewhere — is read a page past its position: a drama of its title pushed down, the card's own, is then seen too and the card shared, never the other one picked", () => {
  const per = 19; // the owner's capture: 19 dramas a page
  /** @param {number} n */
  const drama = (n) => item(String(7700000000000001000n + BigInt(n)), `Drama ${n}`);
  const snowfall = (/** @type {number} */ n) => item(String(7700000000000002000n + BigInt(n)), "Snowfall in Two Cities");
  /** @param {number[]} twins the grid's positions of two different dramas called "Snowfall in Two Cities" */
  const gridOf = (twins) => Array.from({ length: 40 }, (_, n) => (twins.includes(n) ? snowfall(n) : drama(n)));
  const added = item("7700000000000003000", "A New Favorite");
  const card = { title: "Snowfall in Two Cities", index: 18 }; // the lower one right-clicked
  for (const twins of [
    [2, 18], // far apart
    [16, 18], // one drama between them
  ]) {
    const grid = gridOf(twins);
    // one favorite added on the phone since the grid loaded — the list TikTok sends now has it on
    // top: every card one place further down, the right-clicked one first on page 2
    const fresh = [added, ...grid];
    const page1 = fresh.slice(0, per);
    // page 1 holds the card's position and the other drama of that title with a drama after it, and
    // the card's position another drama: not far enough (stopping there would pick the other one)
    assert.deepEqual(resolveCard(page1, card), { kind: "found", item: snowfall(twins[0]), index: twins[0] + 1 }, String(twins));
    assert.equal(coversShift(page1, card, per), false, String(twins));
    assert.equal(coversCard(page1, card, per), false, String(twins));
    // a page past it: both in view — shared, nothing picked
    const page2 = fresh.slice(0, 2 * per);
    assert.equal(coversCard(page2, card, per), true, String(twins));
    assert.deepEqual(resolveCard(page2, card), { kind: "shared", items: twins.map(snowfall) }, String(twins));
  }
  // a title one drama bears, moved down one place since the grid loaded: found a page past the
  // card's position — one request more, only when the grid has moved
  const grid = gridOf([]);
  const fresh = [added, ...grid];
  const five = { title: "Drama 5", index: 5 };
  assert.equal(coversCard(fresh.slice(0, per), five, per), false);
  assert.equal(coversCard(fresh.slice(0, 2 * per), five, per), true);
  assert.deepEqual(resolveCard(fresh.slice(0, 2 * per), five), { kind: "found", item: drama(5), index: 6 });
  // the grid as the list: the card's drama at the card's position — the first page is enough
  assert.equal(coversCard(grid.slice(0, per), five, per), true);
  // coversShift itself: the card's position bearing the title, or more than a page past it read
  assert.equal(coversShift(grid.slice(0, per), five, per), true);
  assert.equal(coversShift(fresh.slice(0, 24), five, per), false); // 24 dramas: not more than 5 + 19
  assert.equal(coversShift(fresh.slice(0, 25), five, per), true);
  assert.equal(coversShift(fresh.slice(0, 3), five, per), false); // the card's position not even read
});

test("the box: a `# <title>` line above each series id it does not name yet, the title on one line; nothing twice", () => {
  const lighthouse = item(LIGHTHOUSE, "The Lighthouse Keeper's Promise");
  const snowA = item(SNOW_A, "Snowfall in Two Cities");
  const snowB = item(SNOW_B, "Snowfall in Two Cities");
  // an empty box
  const first = boxWithFavorites("", [lighthouse, snowA, snowB]);
  assert.equal(first.text, `# The Lighthouse Keeper's Promise\n${LIGHTHOUSE}\n# Snowfall in Two Cities\n${SNOW_A}\n# Snowfall in Two Cities\n${SNOW_B}`);
  assert.deepEqual(first.added, [lighthouse, snowA, snowB]);
  // the box's own rules read exactly those three series, the comments skipped
  const read = parseSeriesList(first.text);
  assert.deepEqual(read.refs.map((ref) => ref.seriesId), [LIGHTHOUSE, SNOW_A, SNOW_B]);
  assert.deepEqual(read.errors, []);
  // what the box names already (a link, an id, a line with a comment) is not added again; nor twice from one selection
  const typed = `https://www.tiktok.com/shortdrama/episode/${SNOW_A}/3\n${LIGHTHOUSE}  # mine\n\n`;
  const second = boxWithFavorites(typed, [snowA, lighthouse, snowB, snowB]);
  assert.equal(second.text, `${typed.trimEnd()}\n# Snowfall in Two Cities\n${SNOW_B}`);
  assert.deepEqual(second.added, [snowB]);
  const third = boxWithFavorites(second.text, [snowA, snowB, lighthouse]);
  assert.equal(third.text, second.text);
  assert.deepEqual(third.added, []);
  // a title with line breaks and controls stays on one line, so the id line is never swallowed or split
  const odd = item("7700000000000000009", "Line one\nline two\r\n\u0085# not a comment end\t\u0000");
  const fourth = boxWithFavorites("", [odd, item("7700000000000000010", null)]);
  assert.equal(fourth.text, "# Line one line two # not a comment end\n7700000000000000009\n7700000000000000010");
  assert.deepEqual(parseSeriesList(fourth.text).refs.map((ref) => ref.seriesId), ["7700000000000000009", "7700000000000000010"]);
});

test("the filter: the title holds the text, letter case and blanks aside", () => {
  assert.equal(titleMatches("Snowfall in Two Cities", "snowfall"), true);
  assert.equal(titleMatches("Snowfall in Two Cities", "TWO  cities"), true);
  assert.equal(titleMatches("Snowfall in Two Cities", ""), true);
  assert.equal(titleMatches("Snowfall in Two Cities", "  "), true);
  assert.equal(titleMatches("Snowfall in Two Cities", "lighthouse"), false);
  assert.equal(titleMatches(null, "x"), false);
  assert.equal(titleMatches(null, ""), true);
  assert.equal(cleanTitle("  a \n\t b  "), "a b");
});

test("what a TikTok tab's content script answers is checked: a title on one line and a whole position, else no card", () => {
  assert.deepEqual(cardOf({ title: " Snowfall in\nTwo Cities ", index: 1, at: 1794351572000 }), { title: "Snowfall in Two Cities", index: 1 });
  assert.deepEqual(cardOf({ title: "Paper Crowns", index: 0 }), { title: "Paper Crowns", index: 0 });
  for (const junk of [
    null,
    "Paper Crowns",
    [],
    { title: "", index: 0 },
    { title: "  \n ", index: 0 },
    { title: 5, index: 0 },
    { title: "Paper Crowns", index: -1 },
    { title: "Paper Crowns", index: 1.5 },
    { title: "Paper Crowns", index: "1" },
    { title: "Paper Crowns" },
    { title: "x".repeat(MAX_CARD_TITLE_LENGTH + 1), index: 0 },
  ]) {
    assert.equal(cardOf(junk), null, JSON.stringify(junk));
  }
  // a hand-over: a tab, the card (checked), whether it came from the menu and whether the tab's
  // content script answered — true unless the message says false
  assert.deepEqual(handoverOf({ type: "dramafetch:favorites", tabId: 7, card: { title: "Paper Crowns", index: 2 }, menu: true, script: true }), {
    tabId: 7,
    card: { title: "Paper Crowns", index: 2 },
    menu: true,
    script: true,
  });
  assert.deepEqual(handoverOf({ tabId: 7, card: { title: 9 }, menu: "yes" }), { tabId: 7, card: null, menu: false, script: true });
  assert.deepEqual(handoverOf({ tabId: 7, card: null, menu: true, script: false }), { tabId: 7, card: null, menu: true, script: false });
  assert.deepEqual(handoverOf({ tabId: 7, card: null, menu: true, script: 0 }), { tabId: 7, card: null, menu: true, script: true }); // only false says no script
  for (const junk of [null, { tabId: -1 }, { tabId: "7" }, { tabId: 1.5 }, {}]) assert.equal(handoverOf(junk), null);
});

test("a hand-over no running page took travels in the DramaFetch tab's address and comes back the same", () => {
  const card = { title: "Snowfall in Two Cities & more", index: 12 };
  for (const handover of [
    { tabId: 7, card: null, menu: false, script: true },
    { tabId: 7, card: null, menu: true, script: true },
    { tabId: 7, card: null, menu: true, script: false },
    { tabId: 1234567, card, menu: true, script: true },
  ]) {
    const query = favoritesQuery(handover);
    assert.deepEqual(favoritesOfQuery(`?${query}`), handover, query);
  }
  assert.equal(favoritesQuery({ tabId: 7, card: null, menu: false, script: true }), "favorites=7");
  assert.equal(favoritesQuery({ tabId: 7, card: null, menu: true, script: true }), "favorites=7&menu=1");
  // `script=0` only when the tab's content script did not answer
  assert.equal(favoritesQuery({ tabId: 7, card: null, menu: true, script: false }), "favorites=7&menu=1&script=0");
  assert.equal(favoritesOfQuery("?favorites=7&menu=1&script=1")?.script, true);
  assert.equal(favoritesOfQuery("?favorites=7&menu=1&script=no")?.script, true);
  assert.equal(favoritesOfQuery(""), null);
  assert.equal(favoritesOfQuery("?load=7699393770256782354"), null);
  assert.equal(favoritesOfQuery("?favorites=-1"), null);
  assert.equal(favoritesOfQuery("?favorites=x"), null);
  assert.deepEqual(favoritesOfQuery("?favorites=7&card=%7Bnot+json"), { tabId: 7, card: null, menu: false, script: true });
  assert.deepEqual(favoritesOfQuery(`?favorites=7&card=${encodeURIComponent(JSON.stringify({ title: "", index: 1 }))}`), { tabId: 7, card: null, menu: false, script: true });
});

test("a profile page: TikTok's /@<user> pages, or the fake's in test mode", () => {
  for (const url of ["https://www.tiktok.com/@invented_viewer", "https://m.tiktok.com/@a.b?lang=en", "http://tiktok.com/@x/video/1"]) {
    assert.equal(isProfilePageUrl(url), true, url);
  }
  for (const url of ["https://www.tiktok.com/", "https://www.tiktok.com/@", "https://www.tiktok.com/@/x", "https://www.tiktok.com/shortdrama/1", "https://example.com/@x", "http://127.0.0.1:8123/@x"]) {
    assert.equal(isProfilePageUrl(url), false, url);
  }
  assert.equal(isProfilePageUrl("http://127.0.0.1:8123/@invented_viewer", "http://127.0.0.1:8123"), true);
  assert.equal(isProfilePageUrl("http://127.0.0.1:8123/@", "http://127.0.0.1:8123/"), false);
  assert.equal(isProfilePageUrl("https://www.tiktok.com/@invented_viewer", "http://127.0.0.1:8123"), true);
});

test("the status from DramaFetch's own records: on disk when complete and the list has not grown since (or every listed episode saved or locked), partly when some are saved, else none", () => {
  const exists = () => true;
  /** @param {number} number @param {string} status */
  const result = (number, status) => ({
    episode: { number, itemId: `i${number}` },
    status,
    path: status === "done" ? `/dl/S/E${number}.mp4` : null,
    message: status,
    downloadId: status === "done" ? number : null,
  });
  const state = newState(SNOW_A, "Snowfall in Two Cities");
  assert.equal(progressStatus(state, SNOW_A, 3), null); // nothing saved yet
  record(state, result(1, "done"), { exists, now: 1_800_000_000 });
  assert.equal(progressStatus(state, SNOW_A, 3), "partly");
  record(state, result(2, "done"), { exists, now: 1_800_000_000 });
  record(state, result(3, "skipped-locked"), { exists, now: 1_800_000_000 });
  assert.equal(progressStatus(state, SNOW_A, 3), "on-disk"); // every episode saved or locked
  assert.equal(progressStatus(state, SNOW_A, 60), "partly");
  assert.equal(progressStatus(state, SNOW_A, null), "partly");
  markComplete(state, 1_800_000_100, 2); // a whole-series run found it complete: 2 saved, 1 locked
  const stored = JSON.parse(JSON.stringify(state));
  assert.equal(progressStatus(stored, SNOW_A, 3), "on-disk");
  assert.equal(progressStatus(stored, SNOW_A, null), "on-disk"); // no count in the list: the complete mark decides
  assert.equal(progressStatus(stored, SNOW_A, 60), "partly"); // the list has grown since that run: new episodes
  // another series' record, a record of nothing saved, junk: none
  assert.equal(progressStatus(state, SNOW_B, 60), null);
  assert.equal(progressStatus(undefined, SNOW_A, 60), null);
  assert.equal(progressStatus({ version: 9 }, SNOW_A, 60), null);
  const locked = newState(SNOW_B);
  record(locked, result(1, "skipped-locked"), { exists, now: 1_800_000_000 });
  markComplete(locked, 1_800_000_100, 0);
  assert.equal(progressStatus(locked, SNOW_B, 1), null);
});

test("a drama's length: whole hours and minutes, as the card shows it", () => {
  assert.deepEqual(durationParts(4743), { hours: 1, minutes: 19 }); // the capture's "1h 19m"
  assert.deepEqual(durationParts(5827), { hours: 1, minutes: 37 });
  assert.deepEqual(durationParts(3600), { hours: 1, minutes: 0 });
  assert.deepEqual(durationParts(1500), { hours: 0, minutes: 25 });
  assert.deepEqual(durationParts(20), { hours: 0, minutes: 1 });
  assert.equal(durationParts(0), null);
  assert.equal(durationParts(null), null);
  assert.equal(durationParts(Number.NaN), null);
});
