// @ts-check
// The user's TikTok favorites list as DramaFetch reads it (src/lib/favorites.js, pure): which
// request is the list's first page (the only one the worker keeps), one page of TikTok's
// `drama_list` answer — the anonymized capture of 2026-11-15, tests/fixtures/drama_list_page.json,
// with two DIFFERENT dramas of the same title, as in the owner's list —, the hand-over (a message's,
// an address's: the TikTok tab alone since 2.0.0, which took the right-clicked card away) and how
// many episodes DramaFetch's own records say a favorite has (3.0.0: no status from the records any
// more). No browser, no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  FAVORITES_MAX_PAGES,
  FAVORITES_URL_WORD,
  FavoritesPayloadError,
  NOT_A_LIST_MESSAGE,
  cleanTitle,
  coverUrlOf,
  durationParts,
  favoritesOfQuery,
  favoritesQuery,
  handoverOf,
  isDramaListUrl,
  isFavoritesFirstPageUrl,
  isProfilePageUrl,
  parseDramaListPayload,
  knownEpisodes,
  titleMatches,
} from "../src/lib/favorites.js";
import * as favoritesModule from "../src/lib/favorites.js";
import { completeSince, markComplete, newState, record } from "../src/lib/state.js";

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
const item = (seriesId, title) => ({ seriesId, title, episodes: 60, durationS: 4743, coverUrl: null });
/**
 * The capture's item `index`'s `zoomCover["240"]`: the cover the library shows for it.
 * @param {number} index
 * @returns {string}
 */
const zoom240 = (index) => {
  const entry = /** @type {Record<string, Record<string, string>>} */ (/** @type {unknown[]} */ (CAPTURE["dramaList"])[index]);
  return String(entry["zoomCover"]?.["240"]);
};

test("the constants: 100 pages at most, the drama_list path", () => {
  assert.equal(FAVORITES_MAX_PAGES, 100);
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
      { seriesId: LIGHTHOUSE, title: "The Lighthouse Keeper's Promise", episodes: 60, durationS: 4743, coverUrl: zoom240(0) },
      { seriesId: SNOW_A, title: "Snowfall in Two Cities", episodes: 60, durationS: 5827, coverUrl: zoom240(1) },
      { seriesId: SNOW_B, title: "Snowfall in Two Cities", episodes: 60, durationS: 5827, coverUrl: zoom240(2) },
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
    { seriesId: LIGHTHOUSE, title: "Café at Night", episodes: 12, durationS: 59.6, coverUrl: zoom240(0) },
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
    items: [{ seriesId: SNOW_B, title: null, episodes: null, durationS: null, coverUrl: null }],
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

test("a drama's cover: its zoomCover 240 when that is an http(s) URL, else the first http(s) URL of cover.urlList, else none — never anything else of the item", () => {
  const list = /** @type {Record<string, unknown>[]} */ (page({})["dramaList"]);
  const [first] = list;
  assert.ok(first !== undefined);
  const urls = /** @type {{urlList: string[]}} */ (first["cover"]).urlList;
  // the capture: zoomCover["240"], an .avif TikTok signs — as the list gives it, byte for byte
  assert.equal(coverUrlOf(first), zoom240(0));
  assert.match(String(coverUrlOf(first)), /^https:\/\/p16-common-sign\.tiktokcdn\.com\/.+zoomcover:240:240\.avif\?.+x-signature=/);
  // no 240 (or a 240 that is no web address): the first web address of cover.urlList
  for (const zoomCover of [undefined, null, {}, { 480: "https://example.invalid/480.avif" }, { 240: "" }, { 240: 240 }, { 240: "javascript:alert(1)" }, { 240: "/relative/cover.avif" }, { 240: "data:image/avif;base64,AAAA" }]) {
    assert.equal(coverUrlOf({ ...first, zoomCover }), urls[0], JSON.stringify(zoomCover));
  }
  assert.equal(coverUrlOf({ ...first, zoomCover: null, cover: { urlList: ["", 42, "ftp://x/y.jpg", urls[2]] } }), urls[2]);
  // nothing usable: none — never the author's avatar, never another field of the item
  for (const cover of [undefined, null, {}, { urlList: [] }, { urlList: "https://p16.tiktokcdn.com/x.jpeg" }, { urlList: [null, "not a url", "https:// spaced.example/x"] }]) {
    assert.equal(coverUrlOf({ ...first, zoomCover: undefined, cover }), null, JSON.stringify(cover));
  }
  assert.equal(coverUrlOf(null), null);
  assert.equal(coverUrlOf("https://p16.tiktokcdn.com/x.jpeg"), null);
  // parsed with every item of a page
  const parsed = parseDramaListPayload({ dramaList: [{ ...first, zoomCover: undefined }, { ...first, dramaID: SNOW_A, zoomCover: undefined, cover: undefined }], hasMore: false });
  assert.deepEqual(parsed.items.map((entry) => entry.coverUrl), [urls[0], null]);
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

test("a favorites hand-over as a message carries it is checked: the TikTok tab alone — a whole number from 0 —, nothing else of the message read (2.0.0: no card, no menu, no script)", () => {
  assert.deepEqual(handoverOf({ type: "dramafetch:favorites", tabId: 7 }), { tabId: 7 });
  assert.deepEqual(handoverOf({ tabId: 0 }), { tabId: 0 });
  // what 1.x's right-click added to it is no part of it any more: never read, never kept
  assert.deepEqual(handoverOf({ type: "dramafetch:favorites", tabId: 7, card: { title: "Paper Crowns", index: 2 }, menu: true, script: false }), { tabId: 7 });
  for (const junk of [null, "7", [], { tabId: -1 }, { tabId: "7" }, { tabId: 1.5 }, { tabId: Number.NaN }, {}]) assert.equal(handoverOf(junk), null, JSON.stringify(junk));
});

test("a hand-over no running page took travels in the DramaFetch tab's address and comes back the same: `favorites=<tab>`, nothing else", () => {
  for (const tabId of [0, 7, 1234567]) {
    const query = favoritesQuery({ tabId });
    assert.equal(query, `favorites=${tabId}`);
    assert.deepEqual(favoritesOfQuery(`?${query}`), { tabId }, query);
  }
  assert.equal(favoritesOfQuery(""), null);
  assert.equal(favoritesOfQuery("?load=7699393770256782354"), null);
  assert.equal(favoritesOfQuery("?favorites=-1"), null);
  assert.equal(favoritesOfQuery("?favorites=x"), null);
  assert.equal(favoritesOfQuery("?favorites="), null);
  // a 1.x right-click's address (`menu`, `script`, `card`): the tab alone is read
  const card = encodeURIComponent(JSON.stringify({ title: "Snowfall in Two Cities", index: 12 }));
  assert.deepEqual(favoritesOfQuery(`?favorites=7&menu=1&script=0&card=${card}`), { tabId: 7 });
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

test("how many episodes a drama has as far as DramaFetch knows — its card's count: the list's count, raised to the highest episode number the records hold, for an episode not saved too (TikTok added it after the list was read, and a run failed to save it or stopped before it); never raised by the records alone (3.0.0: no status from the records — `progressStatus` is gone)", () => {
  assert.equal(Object.hasOwn(favoritesModule, "progressStatus"), false);
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
  assert.equal(knownEpisodes(state, 3), 3); // nothing recorded yet: the list's count
  for (const number of [1, 2, 3]) record(state, result(number, "done"), { exists, now: 1_800_000_000 });
  assert.equal(knownEpisodes(state, 3), 3);
  assert.equal(knownEpisodes(state, 60), 60); // the list's larger count stays
  record(state, result(4, "failed"), { exists, now: 1_800_000_000 });
  record(state, result(5, "failed-unavailable"), { exists, now: 1_800_000_000 });
  assert.equal(knownEpisodes(state, 3), 5); // the list said 3: the records know 5
  // the records alone never raise an unknown count (a selection may have saved only some), nor a
  // count that is no count
  assert.equal(knownEpisodes(state, null), null);
  assert.equal(knownEpisodes(state, 0), null);
  // a stopped run after a whole-series run's complete mark: every attempt clears the mark, so its
  // failed episode beyond the count raises it
  const stopped = newState(SNOW_B);
  for (const number of [1, 2]) record(stopped, result(number, "done"), { exists, now: 1_800_000_000 });
  markComplete(stopped, 1_800_000_100, 2);
  assert.equal(knownEpisodes(stopped, 2), 2);
  // the failed attempt recorded as a run records it — after the mark, which every attempt clears
  // (written straight under the mark before 1.6.0's review: a state the records never hold)
  record(stopped, { ...result(3, "failed"), message: "stopped: 3 consecutive failures" }, { exists, now: 1_800_000_200 });
  assert.equal(stopped.complete_at, null);
  assert.equal(knownEpisodes(stopped, 2), 3);
  // a locked episode beyond the count counts too, as one saved does
  const paid = newState(SNOW_B);
  for (const number of [1, 2]) record(paid, result(number, "done"), { exists, now: 1_800_000_000 });
  record(paid, result(3, "skipped-locked"), { exists, now: 1_800_000_000 });
  assert.equal(knownEpisodes(paid, 2), 3);
});

test("the count of a drama whose list shrank: TikTok withdrew its last episodes after a run failed on them, and a later whole-series run found the 60 it lists now complete — 60; the old failed entries under that complete mark never raise the count (every attempt clears the mark, so they predate the run that set it and lie past every episode it listed); while the library still says 62, 62", () => {
  const exists = () => true;
  /** @param {number} number @param {string} status */
  const result = (number, status) => ({
    episode: { number, itemId: `i${number}` },
    status,
    path: status === "done" || status === "skipped-exists" ? `/dl/S/E${number}.mp4` : null,
    message: status,
    downloadId: status === "done" ? number : null,
  });
  const shrunk = newState(SNOW_A, "Snowfall in Two Cities");
  // run 1: TikTok listed 62; 1–60 saved, 61 and 62 failed — no complete mark: they count
  for (let number = 1; number <= 60; number += 1) record(shrunk, result(number, "done"), { exists, now: 1_800_000_000 });
  for (const number of [61, 62]) record(shrunk, result(number, "failed-unavailable"), { exists, now: 1_800_000_000 });
  assert.equal(completeSince(shrunk), null);
  assert.equal(knownEpisodes(shrunk, 60), 62);
  assert.equal(knownEpisodes(shrunk, 62), 62);
  // run 2: TikTok lists 60; every one found on disk (no attempt), the series complete with 60
  for (let number = 1; number <= 60; number += 1) record(shrunk, result(number, "skipped-exists"), { exists, now: 1_800_100_000 });
  markComplete(shrunk, 1_800_100_100, 60);
  assert.equal(shrunk.episodes["62"]?.status, "failed-unavailable"); // left as it was: that run never listed it
  assert.equal(knownEpisodes(shrunk, 60), 60);
  // the library not updated yet (TikTok's list read when it named 62): its 62 stays
  assert.equal(knownEpisodes(shrunk, 62), 62);
  // a locked episode beyond the count under a complete mark still raises it, as before
  const paid = newState(SNOW_B);
  for (const number of [1, 2]) record(paid, result(number, "done"), { exists, now: 1_800_000_000 });
  record(paid, result(3, "skipped-locked"), { exists, now: 1_800_000_000 });
  markComplete(paid, 1_800_000_100, 2);
  assert.equal(knownEpisodes(paid, 2), 3);
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
