// @ts-check
// The library (src/lib/library.js, pure): what DramaFetch's own records say of each drama (the
// episodes saved, how many it has), a card's state from the jobs alone (queued, running, idle —
// 3.0.0: no lasting status, no status filters, no locked count), the twins, the sort orders, the
// search, the smart refresh's "unchanged" question and how long the episode counts are trusted,
// which signed cover addresses have expired, the selection's episodes, what the library keeps
// across sessions (never a URL; a 2.x library's dramas DramaFetch had removed from the Favorites
// leave it) and the profile's handle. No browser, no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { titleMatches } from "../src/lib/favorites.js";
import * as libraryModule from "../src/lib/library.js";
import {
  LIBRARY_PIECE,
  LIBRARY_SORTS,
  LIBRARY_VERSION,
  DEFAULT_LIBRARY_SORT,
  ageOf,
  countsFresh,
  coverExpired,
  distinctItems,
  libraryOf,
  libraryRecord,
  librarySortOf,
  libraryStatus,
  profileHandleOf,
  progressOf,
  selectionEpisodes,
  sortedItems,
  twinIds,
  unchangedSince,
} from "../src/lib/library.js";
import { markComplete, newState, record } from "../src/lib/state.js";

const LIGHTHOUSE = "7712345678901234561";
const SNOW_A = "7712345678901234562";
const SNOW_B = "7712345678901234563";
const PAPER = "7712345678901234564";
const MOON = "7712345678901234565";
const LANTERN = "7712345678901234566";
/** @type {Record<string, unknown>} the anonymized capture of a favorites page (its covers signed, `x-expires` in them) */
const CAPTURE = JSON.parse(readFileSync(new URL("../../tests/fixtures/drama_list_page.json", import.meta.url), "utf8"));
const COVER = "https://p16-common-sign.tiktokcdn.com/tos/aaaa~tplv-photomode-zoomcover:240:240.avif?x-expires=1794895200&x-signature=INVENTED%3D";

/**
 * @param {string} seriesId
 * @param {string | null} title
 * @param {number | null} episodes
 * @returns {import("../src/lib/favorites.js").FavoriteItem}
 */
const item = (seriesId, title, episodes = 60) => ({ seriesId, title, episodes, durationS: 4743, coverUrl: COVER });

/**
 * A series' stored state with `numbers` saved (`done`, the downloader's message) and `locked` ones
 * skipped as locked, optionally found complete.
 * @param {string} seriesId
 * @param {number[]} numbers
 * @param {{complete?: number, locked?: number[]}} [options]
 */
function stored(seriesId, numbers, options = {}) {
  const state = newState(seriesId, "A drama");
  for (const number of numbers) {
    record(state, { episode: { number, itemId: `i${number}` }, status: "done", path: `/dl/E${number}.mp4`, message: `saved E${number}.mp4 (0.1 MiB) + cover embedded`, downloadId: number }, { exists: () => true, now: 1_800_000_000 });
  }
  for (const number of options.locked ?? []) {
    record(state, { episode: { number, itemId: `i${number}` }, status: "skipped-locked", path: null, message: "looks locked" }, { exists: () => true, now: 1_800_000_000 });
  }
  if (options.complete !== undefined) markComplete(state, 1_800_000_100, options.complete);
  return JSON.parse(JSON.stringify(state));
}

test("the constants: pieces of 60 cards, the sorts of the sketch, version 1 — and no status filters any more (3.0.0)", () => {
  assert.equal(LIBRARY_PIECE, 60);
  assert.deepEqual([...LIBRARY_SORTS], ["recent", "title", "episodes"]);
  assert.equal(LIBRARY_VERSION, 1);
  // the filter chips (All / Not downloaded / Partly / On disk) went with the lasting statuses
  for (const removed of ["LIBRARY_FILTERS", "chipCounts", "inFilter"]) assert.equal(Object.hasOwn(libraryModule, removed), false, removed);
});

test("a drama's progress from the records: the episodes saved and how many it has — the list's count raised to what the records hold —, nothing else (3.0.0: no status, no locked count)", () => {
  // nothing stored, or nothing saved: 0 of the list's count
  assert.deepEqual(progressOf(undefined, LIGHTHOUSE, 60), { saved: 0, total: 60 });
  assert.deepEqual(progressOf(stored(LIGHTHOUSE, [], { locked: [3] }), LIGHTHOUSE, 60), { saved: 0, total: 60 });
  // some saved, or every one the list names (a complete run's count too)
  assert.deepEqual(progressOf(stored(LIGHTHOUSE, [1, 2, 3]), LIGHTHOUSE, 60), { saved: 3, total: 60 });
  assert.deepEqual(progressOf(stored(LIGHTHOUSE, [1, 2, 3], { complete: 3 }), LIGHTHOUSE, 3), { saved: 3, total: 3 });
  assert.deepEqual(progressOf(stored(LIGHTHOUSE, [1, 2], { locked: [3] }), LIGHTHOUSE, 3), { saved: 2, total: 3 });
  // found complete, the list grown since: the list's larger count
  assert.deepEqual(progressOf(stored(LIGHTHOUSE, [1, 2, 3], { complete: 3 }), LIGHTHOUSE, 5), { saved: 3, total: 5 });
  // the list names no count: what the records know — a complete run's count plus the locked ones, else the highest number recorded
  assert.deepEqual(progressOf(stored(LIGHTHOUSE, [1, 2], { complete: 2, locked: [3] }), LIGHTHOUSE, null), { saved: 2, total: 3 });
  assert.deepEqual(progressOf(stored(LIGHTHOUSE, [1, 4]), LIGHTHOUSE, null), { saved: 2, total: 4 });
  assert.deepEqual(progressOf(undefined, LIGHTHOUSE, null), { saved: 0, total: null });
  // another series' state is no record of this one
  assert.deepEqual(progressOf(stored(PAPER, [1, 2, 3], { complete: 3 }), LIGHTHOUSE, 3), { saved: 0, total: 3 });
  assert.deepEqual(progressOf(stored(PAPER, [1], { locked: [2, 3, 4, 5] }), LIGHTHOUSE, 3), { saved: 0, total: 3 });
  // a list that shrank: an episode failed by a run that listed 4, then a run found the 3 TikTok lists
  // now complete — the old failed entry under that mark raises nothing: 3 of 3; while the library
  // still says 4, 3 of 4
  const shrunk = newState(LIGHTHOUSE, "A drama");
  record(shrunk, { episode: { number: 4, itemId: "i4" }, status: "failed-unavailable", path: null, message: "unavailable" }, { exists: () => true, now: 1_800_000_000 });
  for (const number of [1, 2, 3]) record(shrunk, { episode: { number, itemId: `i${number}` }, status: "done", path: `/dl/E${number}.mp4`, message: `saved E${number}.mp4 (0.1 MiB) + cover embedded`, downloadId: number }, { exists: () => true, now: 1_800_000_050 });
  markComplete(shrunk, 1_800_000_100, 3);
  const raw = JSON.parse(JSON.stringify(shrunk));
  assert.deepEqual(progressOf(raw, LIGHTHOUSE, 3), { saved: 3, total: 3 });
  assert.deepEqual(progressOf(raw, LIGHTHOUSE, 4), { saved: 3, total: 4 });
  // a paywalled drama: 5 saved, 45 recorded locked — TikTok's 60 the count, no locked count kept
  const paywalled = stored(LIGHTHOUSE, [1, 2, 3, 4, 5], { locked: Array.from({ length: 45 }, (_, index) => index + 16), complete: 5 });
  assert.deepEqual(progressOf(paywalled, LIGHTHOUSE, 60), { saved: 5, total: 60 });
  // a run that listed more episodes than TikTok's favorites entry says: the larger number, the one
  // the card's count, Downloading · saved/total, Most episodes and the selection's sum all use
  assert.deepEqual(progressOf(stored(LIGHTHOUSE, [1, 2], { locked: [3, 4] }), LIGHTHOUSE, 3), { saved: 2, total: 4 });
  // the two numbers only: no status from the records, no locked count
  assert.deepEqual(Object.keys(progressOf(paywalled, LIGHTHOUSE, 60)).sort(), ["saved", "total"]);
});

test("a drama's progress while See episodes downloads it again in full (3.0.0): the episodes that download has still to save anew are not counted as saved — their earlier downloads still in the records —, against the drama's own count; an episode it saved again, or one it does not take, counts as before", () => {
  const thirty = Array.from({ length: 30 }, (_, index) => index + 1);
  const onDisk = stored(LIGHTHOUSE, thirty, { complete: 30 });
  // Download all available over 30 on disk: 0 of 30 at its start, then one more for each saved anew
  assert.deepEqual(progressOf(onDisk, LIGHTHOUSE, 30, new Set(thirty)), { saved: 0, total: 30 });
  assert.deepEqual(progressOf(onDisk, LIGHTHOUSE, 30, new Set(thirty.slice(2))), { saved: 2, total: 30 });
  // Download selected of E01 and E03, both on disk: 28 of 30, never 28 of 2
  assert.deepEqual(progressOf(onDisk, LIGHTHOUSE, 30, new Set([1, 3])), { saved: 28, total: 30 });
  // its retry of E05 and E07, which failed (not on disk): what the records say, as before
  assert.deepEqual(progressOf(stored(LIGHTHOUSE, thirty.filter((number) => number !== 5 && number !== 7)), LIGHTHOUSE, 30, new Set([5, 7])), { saved: 28, total: 30 });
  // none to leave out: the records alone
  assert.deepEqual(progressOf(onDisk, LIGHTHOUSE, 30, new Set()), { saved: 30, total: 30 });
  assert.deepEqual(progressOf(onDisk, LIGHTHOUSE, 30, null), progressOf(onDisk, LIGHTHOUSE, 30));
  assert.deepEqual(progressOf(undefined, LIGHTHOUSE, 30, new Set([1])), { saved: 0, total: 30 });
});

test("a card's state, from the jobs alone: running, then queued, else idle — never a status from the records (3.0.0)", () => {
  assert.equal(libraryStatus({ queued: false, running: false }), "idle");
  assert.equal(libraryStatus({ queued: true, running: false }), "queued");
  assert.equal(libraryStatus({ queued: true, running: true }), "running");
  assert.equal(libraryStatus({ queued: false, running: true }), "running");
});

test("twins: DIFFERENT series of the same title (on one line, NFC) — never one drama listed twice, never an untitled one", () => {
  const items = [
    item(LIGHTHOUSE, "The Lighthouse Keeper's Promise"),
    item(SNOW_A, "Snowfall in Two Cities"),
    item(SNOW_B, " Snowfall  in\nTwo Cities "),
    item(PAPER, "Paper Crowns"),
    item(PAPER, "Paper Crowns"), // the same drama twice: no twin of itself
    item(MOON, null),
    item(LANTERN, null),
    item("7712345678901234570", "Café at Night"),
    item("7712345678901234571", "Café at Night"),
  ];
  assert.deepEqual([...twinIds(items)].sort(), [SNOW_A, SNOW_B, "7712345678901234570", "7712345678901234571"].sort());
});

test("the sort orders: the list's own, title A–Z (letter case and accents aside, numbers by value, untitled last), most episodes first by the number each card shows (unknown last); ties keep the list's order", () => {
  /**
   * @param {import("../src/lib/favorites.js").FavoriteItem} favorite
   * @param {number | null} [total] how many episodes its card shows: TikTok's count unless the records raised it
   */
  const entry = (favorite, total = favorite.episodes) => ({ item: favorite, progress: { saved: 0, total } });
  const entries = [
    entry(item(LIGHTHOUSE, "the lighthouse keeper's promise", 60)),
    entry(item(SNOW_A, "Snowfall in Two Cities", 44)),
    entry(item(SNOW_B, null, 80)),
    entry(item(PAPER, "Paper Crowns", null)),
    entry(item(MOON, "Éclair Days", 60)),
    entry(item(LANTERN, "Snowfall in Two Cities", 60)),
  ];
  const ids = (/** @type {import("../src/lib/library.js").LibrarySort} */ sort, list = entries) => sortedItems(list, sort).map((sorted) => sorted.item.seriesId);
  assert.deepEqual(ids("recent"), [LIGHTHOUSE, SNOW_A, SNOW_B, PAPER, MOON, LANTERN]);
  assert.deepEqual(ids("title"), [MOON, PAPER, SNOW_A, LANTERN, LIGHTHOUSE, SNOW_B]);
  assert.deepEqual(ids("episodes"), [SNOW_B, LIGHTHOUSE, MOON, LANTERN, SNOW_A, PAPER]);
  assert.notEqual(sortedItems(entries, "recent"), entries); // a new array: the list's order kept
  // Most episodes: the number each card shows — a run that listed more than TikTok's favorites entry
  // says moves the drama up with it
  const raised = entries.map((sorted) => (sorted.item.seriesId === SNOW_A ? entry(sorted.item, 90) : sorted));
  assert.deepEqual(ids("episodes", raised), [SNOW_A, SNOW_B, LIGHTHOUSE, MOON, LANTERN, PAPER]);
  // the collation (TITLE_ORDER): numbers by value, letter case and accents aside — ties keep the list's order
  const titled = [
    entry(item("7712345678901234580", "Episode 10")),
    entry(item("7712345678901234581", "Ángel de medianoche")),
    entry(item("7712345678901234582", "episode 2")),
    entry(item("7712345678901234583", "angel de medianoche")),
    entry(item("7712345678901234584", "Abril")),
    entry(item("7712345678901234585", "Zafiro")),
    entry(item("7712345678901234586", "Árbol")),
  ];
  assert.deepEqual(
    sortedItems(titled, "title").map((sorted) => sorted.item.title),
    ["Abril", "Ángel de medianoche", "angel de medianoche", "Árbol", "episode 2", "Episode 10", "Zafiro"],
  );
  // the search the toolbar uses: the title holds the text, letter case and blanks aside
  assert.equal(titleMatches("Snowfall in Two Cities", "  SNOWFALL in "), true);
  assert.equal(titleMatches(null, "x"), false);
});

test("the sort order kept across sessions, read back checked: one of the three, else the list's own", () => {
  assert.equal(DEFAULT_LIBRARY_SORT, "recent");
  for (const sort of LIBRARY_SORTS) assert.equal(librarySortOf(sort), sort);
  for (const other of [undefined, null, "", "Title", "random", 3, ["title"], { sort: "title" }]) assert.equal(librarySortOf(other), "recent");
});

test("the selection's episodes: the sum of the ticked dramas' counts as their cards show them, each once; an unknown count adds none", () => {
  /** @param {import("../src/lib/favorites.js").FavoriteItem} favorite @param {number | null} total */
  const entry = (favorite, total) => ({ item: favorite, progress: { saved: 1, total } });
  const items = [item(LIGHTHOUSE, "a", 60), item(SNOW_A, "b", 44), item(PAPER, "c", null), item(LIGHTHOUSE, "a", 60)];
  const entries = items.map((favorite) => entry(favorite, favorite.episodes));
  assert.equal(selectionEpisodes(entries, new Set([LIGHTHOUSE, SNOW_A, PAPER])), 104);
  assert.equal(selectionEpisodes(entries, new Set()), 0);
  // a drama whose records raised its count (a run listed 50, TikTok's entry says 44): the card's 50
  const raised = [entry(item(LIGHTHOUSE, "a", 60), 60), entry(item(SNOW_A, "b", 44), 50)];
  assert.equal(selectionEpisodes(raised, new Set([LIGHTHOUSE, SNOW_A])), 110);
  assert.deepEqual(distinctItems(items).map((distinct) => distinct.seriesId), [LIGHTHOUSE, SNOW_A, PAPER]);
});

test("the smart refresh's question: TikTok's total equals the library's dramas AND the first page's ids are the library's first ones, in order", () => {
  const kept = [LIGHTHOUSE, SNOW_A, SNOW_B, PAPER, MOON];
  assert.equal(unchangedSince(kept, [LIGHTHOUSE, SNOW_A, SNOW_B], 5), true);
  assert.equal(unchangedSince(kept, kept, 5), true); // a first page that is the whole list
  assert.equal(unchangedSince(kept, [LIGHTHOUSE, SNOW_A, SNOW_B], 6), false); // one added somewhere: the count says so
  assert.equal(unchangedSince(kept, [LIGHTHOUSE, SNOW_A, SNOW_B], 4), false); // one taken out on TikTok
  assert.equal(unchangedSince(kept, [PAPER, LIGHTHOUSE, SNOW_A], 5), false); // one favorited again (newest first) and one taken out: the page says so
  assert.equal(unchangedSince(kept, [SNOW_A, LIGHTHOUSE, SNOW_B], 5), false); // the order differs
  assert.equal(unchangedSince(kept, [LIGHTHOUSE, SNOW_A, SNOW_B], null), false); // no total: read on
  assert.equal(unchangedSince([LIGHTHOUSE], [LIGHTHOUSE, SNOW_A], 1), false); // a page longer than the library
  assert.equal(unchangedSince([], [], 0), true);
  assert.equal(unchangedSince(kept, [], 5), false);
});

test("what the library keeps: the dramas each once, id, title, episodes and length only — no cover URL, nothing signed —; read back checked", () => {
  const items = [item(LIGHTHOUSE, "The Lighthouse Keeper's Promise"), item(SNOW_A, "Snowfall in Two Cities", null), item(LIGHTHOUSE, "dup"), { ...item(PAPER, "  Paper\nCrowns "), durationS: null }];
  const kept = libraryRecord({
    listedAt: 1_800_000_000,
    total: 946,
    countedAt: 1_800_000_050,
    fullReadAt: 1_799_990_000,
    complete: false,
    short: false,
    ended: "cap",
    profile: "@invented_viewer",
    items,
  });
  assert.deepEqual(kept, {
    v: 1,
    listedAt: 1_800_000_000,
    total: 946,
    countedAt: 1_800_000_050,
    fullReadAt: 1_799_990_000,
    complete: false,
    short: false,
    ended: "cap",
    profile: "@invented_viewer",
    items: [
      { seriesId: LIGHTHOUSE, title: "The Lighthouse Keeper's Promise", episodes: 60, durationS: 4743 },
      { seriesId: SNOW_A, title: "Snowfall in Two Cities", episodes: null, durationS: 4743 },
      { seriesId: PAPER, title: "Paper Crowns", episodes: 60, durationS: null },
    ],
  });
  assert.doesNotMatch(JSON.stringify(kept), /http|tiktokcdn|signature/i); // nothing signed, no address at all
  // back from storage, checked: the same; junk is no library, a drama without a valid id is left out
  assert.deepEqual(libraryOf(JSON.parse(JSON.stringify(kept))), kept);
  assert.equal(libraryOf(undefined), null);
  assert.equal(libraryOf({ ...kept, v: 2 }), null);
  assert.equal(libraryOf({ ...kept, items: "x" }), null);
  assert.equal(libraryOf({ ...kept, listedAt: "yesterday" }), null);
  const odd = libraryOf({
    ...kept,
    total: -1,
    fullReadAt: "yesterday",
    ended: "whatever",
    profile: "invented_viewer", // not a handle as kept
    items: [...kept.items, { seriesId: "123", title: "short id" }, { seriesId: 7712345678901234000 }, null, { seriesId: MOON, title: 5, episodes: 1.5, durationS: -3, coverUrl: COVER }],
  });
  assert.ok(odd !== null);
  assert.deepEqual(odd.items.map((entry) => entry.seriesId), [LIGHTHOUSE, SNOW_A, PAPER, MOON]);
  assert.deepEqual(odd.items[3], { seriesId: MOON, title: null, episodes: null, durationS: null }); // the cover URL dropped
  assert.equal(odd.total, null);
  assert.equal(odd.fullReadAt, null);
  assert.equal(odd.ended, null);
  assert.equal(odd.profile, null);
  // a library kept before the whole read was remembered: none known
  const { fullReadAt: _never, ...older } = kept;
  assert.equal(libraryOf(older)?.fullReadAt, null);
  assert.equal(libraryRecord(older).fullReadAt, null);
});

test("a library DramaFetch 2.x kept (3.0.0: DramaFetch removes nothing from the Favorites): the dramas it had removed from the Favorites leave it as it is read back — no card, no count —, a count it had not confirmed (its own estimate, never TikTok's) reads as unknown, and its `removed` and `unconfirmed` are read no further and never written again", () => {
  const items = [LIGHTHOUSE, SNOW_A, SNOW_B, PAPER].map((seriesId) => ({ seriesId, title: `Drama ${seriesId.slice(-1)}`, episodes: 3, durationS: 237 }));
  const stored2x = {
    v: 1,
    listedAt: 1_800_000_000,
    total: 945, // TikTok's count as 2.x left it: the last one minus its removal, not confirmed
    countedAt: 1_800_000_050,
    fullReadAt: 1_799_990_000,
    unconfirmed: true,
    complete: true,
    short: false,
    ended: null,
    profile: "@invented_viewer",
    items,
    // as 2.x wrote them: removed since the list was read; one no longer listed, entries it never wrote
    removed: [{ seriesId: SNOW_A, at: 1_800_000_040 }, { seriesId: PAPER, at: 1_800_000_041 }, { seriesId: MOON, at: 1 }, { seriesId: LANTERN }, "x", null],
  };
  const read = libraryOf(JSON.parse(JSON.stringify(stored2x)));
  assert.ok(read !== null);
  assert.deepEqual(read.items.map((entry) => entry.seriesId), [LIGHTHOUSE, SNOW_B]); // the two it removed gone, nothing else
  assert.equal(read.total, null); // 2.x's estimate is not TikTok's count: unknown until the next read
  assert.equal(read.countedAt, 1_800_000_050);
  assert.equal(Object.hasOwn(read, "removed"), false);
  assert.equal(Object.hasOwn(read, "unconfirmed"), false);
  // kept again: nothing of 2.x's removal written back
  const again = libraryRecord(read);
  assert.deepEqual(again, read);
  assert.doesNotMatch(JSON.stringify(again), /removed|unconfirmed/);
  // a count 2.x read from TikTok (confirmed, or no mark at all) stays TikTok's count
  assert.equal(libraryOf({ ...stored2x, unconfirmed: false })?.total, 945);
  assert.equal(libraryOf({ ...stored2x, unconfirmed: undefined })?.total, 945);
  assert.equal(libraryOf({ ...stored2x, unconfirmed: "yes" })?.total, 945);
  // an entry without a time is no removal 2.x made: that drama stays
  assert.deepEqual(libraryOf({ ...stored2x, removed: [{ seriesId: SNOW_A }] })?.items.map((entry) => entry.seriesId), [LIGHTHOUSE, SNOW_A, SNOW_B, PAPER]);
  // no `removed` at all, or anything but a list: every drama stays
  assert.equal(libraryOf({ ...stored2x, removed: undefined })?.items.length, 4);
  assert.equal(libraryOf({ ...stored2x, removed: "x" })?.items.length, 4);
});

test("how long the library's episode counts are trusted: less than 24 hours after its whole list was read (the engine's own window for a complete series) — never in the future, never without a read", () => {
  const now = 1_800_000_000;
  assert.equal(countsFresh(now - 60, now), true);
  assert.equal(countsFresh(now - (24 * 3600 - 1), now), true);
  assert.equal(countsFresh(now - 24 * 3600, now), false); // a series may have gained episodes since
  assert.equal(countsFresh(now - 3 * 86_400, now), false);
  assert.equal(countsFresh(now + 600, now), false); // a clock moved back: not trusted
  assert.equal(countsFresh(null, now), false);
});

test("a cover's signed address expires at TikTok's x-expires — the capture's own shape; an address without it, or with anything but whole seconds, is not judged", () => {
  const signed = (/** @type {string} */ expires) =>
    `https://p16-common-sign.tiktokcdn.com/tos-alisg-i-x/aaaa~tplv-photomode-zoomcover:240:240.avif?dr=14575&x-expires=${expires}&x-signature=INVENTED%3D&idc=my`;
  const now = 1_800_000_000;
  assert.equal(coverExpired(signed("1700000000"), now), true); // far past
  assert.equal(coverExpired(signed(String(now)), now), true); // expiring now
  assert.equal(coverExpired(signed("1900000000"), now), false); // far future
  assert.equal(coverExpired(signed("soon"), now), false);
  assert.equal(coverExpired(signed(""), now), false);
  assert.equal(coverExpired("https://p16-common-sign.tiktokcdn.com/c/1.jpeg", now), false); // no signature time
  assert.equal(coverExpired("http://127.0.0.1:8123/cover/7712345678901234561.jpg", now), false); // the fake's covers
  assert.equal(coverExpired("not a url", now), false);
  // the capture's covers carry it: zoomCover["240"] and cover.urlList alike
  const [drama] = /** @type {Record<string, unknown>[]} */ (CAPTURE["dramaList"]);
  const zoom = /** @type {Record<string, string>} */ (drama?.["zoomCover"])["240"];
  assert.equal(coverExpired(String(zoom), 1_794_895_199), false);
  assert.equal(coverExpired(String(zoom), 1_794_895_200), true);
});

test("the profile's handle: TikTok's /@<handle> address (and the fake's in test mode), nothing else", () => {
  assert.equal(profileHandleOf("https://www.tiktok.com/@invented_viewer"), "@invented_viewer");
  assert.equal(profileHandleOf("https://www.tiktok.com/@invented.viewer_2?lang=es#x"), "@invented.viewer_2");
  assert.equal(profileHandleOf("http://127.0.0.1:8123/@invented_viewer/"), "@invented_viewer");
  assert.equal(profileHandleOf("https://www.tiktok.com/@a%20b"), null);
  assert.equal(profileHandleOf("https://www.tiktok.com/shortdrama/episode/7712345678901234561/1"), null);
  assert.equal(profileHandleOf("https://www.tiktok.com/@"), null);
  assert.equal(profileHandleOf("not a url"), null);
});

test("how long ago: now under a minute, then whole minutes, hours, days", () => {
  const now = 1_800_000_000;
  assert.deepEqual(ageOf(now, now - 59), { unit: "now", count: 0 });
  assert.deepEqual(ageOf(now, now + 30), { unit: "now", count: 0 }); // a clock a little ahead
  assert.deepEqual(ageOf(now, now - 125), { unit: "minutes", count: 2 });
  assert.deepEqual(ageOf(now, now - 3 * 3600 - 5), { unit: "hours", count: 3 });
  assert.deepEqual(ageOf(now, now - 2 * 86_400), { unit: "days", count: 2 });
});
