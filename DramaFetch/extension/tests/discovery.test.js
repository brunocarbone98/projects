// @ts-check
// Unit tests of the discovery's pagination over a fake tab: no browser, no network, no real sleep.
// The first page as the page's own request replayed byte for byte, the captcha checks after the
// first page (a later page that brings no list, a scroll round that loads nothing) and the scroll
// fallback exactly as before; since 3.0.1 the gap filling (what the listing still lacks asked for
// again, once, through the pagination's own request) and the listing page opened at episode 1.
// tests/app.test.js holds the first-page stops (a 429, the login redirect, the wall before any
// list) and the real chrome.* seam.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CHALLENGE_MESSAGE,
  ChallengeError,
  FIRST_PAGE_WARNING,
  GAP_FILL_REQUESTS,
  NOTHING_NEW_WARNING,
  NO_CURSOR_WARNING,
  NO_LIST_WARNING,
  RateLimitedError,
  SCROLL_ROUNDS_WITHOUT_NEWS,
  discoverSeries,
  queryParam,
  withQueryParams,
} from "../src/app/discovery.js";
import { Downloader } from "../src/app/downloader.js";
import { DISCOVERY_SOURCE, resolve } from "../src/app/engine.js";
import { makeEpisode, uncertainText } from "../src/lib/catalog.js";
import { reportLine, seriesReport } from "../src/lib/report.js";
import { LIST_RATE_LIMIT_MESSAGE } from "../src/lib/messages.js";

const SERIES_ID = "7699393770256782354";
/** The page's own first item_list request: TikTok's signature parameters around `count` and `cursor`. */
const TEMPLATE =
  "https://www.tiktok.com/api/drama/episode/item_list/?WebIdLastTime=1762300000&aid=1988&app_language=en" +
  `&count=10&cursor=0&dramaID=${SERIES_ID}&msToken=abc-DEF_123&X-Bogus=DFSzswVOxQ&_signature=_02B4Z6wo00001`;
const DETAIL_URL = `https://www.tiktok.com/api/drama/detail/?dramaID=${SERIES_ID}&aid=1988&X-Bogus=DFSz`;
/** @type {import("../src/lib/urls.js").SeriesRef} */
const REF = { kind: "series", seriesId: SERIES_ID, episodeHint: null, sourceUrl: SERIES_ID };
/** What the in-page fetch answers for a page that is no list (an HTML wall, say): `fetchInPage`'s marker. */
const NO_LIST = { __dramafetch_status: 200, __dramafetch_text: "<!doctype html>" };
/** The page text of TikTok's verification wall, and of the series page. */
const WALL = "Security check\nVerify to continue\nDrag the puzzle piece into place.";
const LIST_PAGE = "Fake Drama\nEpisode 1\nEpisode 2";

/**
 * One item_list page holding one episode of the series.
 * @param {number} number
 * @param {boolean} hasMore
 * @param {number} cursor
 */
const page = (number, hasMore, cursor) => ({
  itemList: [
    {
      id: `76994000000000000${String(number).padStart(2, "0")}`,
      dramaInfo: { dramaID: SERIES_ID, dramaName: "Fake Drama", DramaVideoData: { EpisodeNumber: number } },
      video: { playAddr: `https://v16-webapp-prime.tiktok.com/v/${number}.mp4`, duration: 3 },
    },
  ],
  hasMore,
  cursor,
});

/**
 * A fake series tab. The observer hears the page's own requests (`observed`, the template first);
 * the in-page fetches answer from `answers` in order (a missing answer is "no list"); the page text
 * answers from `texts` in order, the last one staying (an Error there is a read that throws: the
 * tab navigating or gone); every call is counted.
 * @param {{answers?: unknown[], texts?: (string | Error)[], observed?: string[]}} [script]
 */
function fakeTab(script = {}) {
  const answers = [...(script.answers ?? [])];
  const texts = [...(script.texts ?? [LIST_PAGE])];
  const observed = script.observed ?? [TEMPLATE];
  /** @type {string[]} the URLs fetched from inside the page, in order */
  const fetched = [];
  const calls = { scrolls: 0, closed: 0, textReads: 0 };
  /** @type {import("../src/app/discovery.js").DiscoveryBrowser} */
  const browser = {
    openTab: async () => 7,
    navigate: async () => undefined,
    tabUrl: async () => `https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/1`,
    activate: async () => undefined,
    closeTab: async () => {
      calls.closed += 1;
    },
    observe: (_tab, _urls, handlers) => {
      queueMicrotask(() => {
        for (const url of observed) handlers.completed({ url, status: 200 });
      });
      return () => undefined;
    },
    fetchInTab: async (_tab, url) => {
      fetched.push(url);
      return answers.length > 0 ? answers.shift() : NO_LIST;
    },
    scrollTab: async () => {
      calls.scrolls += 1;
      return null;
    },
    pageText: async () => {
      calls.textReads += 1;
      const text = texts.length > 1 ? texts.shift() : texts[0];
      if (text instanceof Error) throw text;
      return text ?? "";
    },
  };
  return { browser, fetched, calls };
}

/**
 * Deterministic options: every pause recorded instead of slept, the rng at its floor (0.8 s before
 * a page), a clock that ticks one second per sleep so that every deadline is reached.
 * @param {import("../src/app/discovery.js").DiscoveryBrowser} browser
 * @returns {{options: import("../src/app/discovery.js").DiscoveryOptions, sleeps: number[]}}
 */
function deterministic(browser) {
  /** @type {number[]} */
  const sleeps = [];
  return {
    sleeps,
    options: { browser, sleep: async (seconds) => void sleeps.push(seconds), rng: { uniform: (low) => low }, clock: () => sleeps.length },
  };
}

/** @param {unknown} error */
const isTheChallenge = (error) => error instanceof ChallengeError && error.message === CHALLENGE_MESSAGE;

test("the first page is the page's own request replayed byte for byte; later pages change cursor and count only", async () => {
  const tab = fakeTab({
    answers: [page(1, true, 1), page(2, false, 2), { dramaInfo: { dramaName: "Fake Drama", totalEpisode: 2 } }],
    observed: [TEMPLATE, DETAIL_URL],
  });
  const { options, sleeps } = deterministic(tab.browser);
  const found = await discoverSeries(REF, options);
  assert.deepEqual(found.episodes.map((episode) => episode.number), [1, 2]);
  assert.equal(found.name, "Fake Drama");
  assert.equal(found.totalHint, 2);
  assert.deepEqual(found.warnings, []);
  assert.equal(tab.fetched[0], TEMPLATE); // never a `cursor=0&count=30` rewrite: TikTok's signature covers the whole query
  assert.equal(tab.fetched[1], withQueryParams(TEMPLATE, { cursor: "1", count: "30" }));
  assert.equal(tab.fetched[1], TEMPLATE.replace("&count=10&cursor=0&", "&count=30&cursor=1&"));
  assert.deepEqual(tab.fetched.slice(2), [DETAIL_URL]);
  assert.equal(sleeps.filter((seconds) => seconds === 0.8).length, 3); // a pause before every fetch, the first included
  assert.equal(tab.calls.textReads, 0); // nothing stalled: no captcha check
  assert.equal(tab.calls.scrolls, 0);
  assert.equal(tab.calls.closed, 1);
});

test("a template without a cursor is replayed as it is too; the next page gets cursor and count appended", async () => {
  const template = `https://www.tiktok.com/api/drama/episode/item_list/?dramaID=${SERIES_ID}&aid=1988&X-Bogus=DFSz`;
  const tab = fakeTab({ answers: [page(1, true, 1), page(2, false, 2)], observed: [template] });
  const found = await discoverSeries(REF, deterministic(tab.browser).options);
  assert.deepEqual(found.episodes.map((episode) => episode.number), [1, 2]);
  assert.deepEqual(tab.fetched, [template, `${template}&cursor=1&count=30`]);
});

test("a later page without a list while the tab shows the verification wall: ChallengeError, no scroll, the tab closed", async () => {
  const tab = fakeTab({ answers: [page(1, true, 1), NO_LIST], texts: [WALL] });
  await assert.rejects(discoverSeries(REF, deterministic(tab.browser).options), isTheChallenge);
  assert.equal(tab.fetched.length, 2); // the first page was listed; the second brought the wall
  assert.equal(tab.calls.textReads, 1);
  assert.equal(tab.calls.scrolls, 0);
  assert.equal(tab.calls.closed, 1);
});

test("a later page without a list on an ordinary page: the scroll fallback and its warning, then that page asked for once more", async () => {
  const tab = fakeTab({ answers: [page(1, true, 1), NO_LIST] });
  const { options, sleeps } = deterministic(tab.browser);
  const found = await discoverSeries(REF, options);
  assert.deepEqual(found.episodes.map((episode) => episode.number), [1]);
  assert.deepEqual(found.warnings, [NO_LIST_WARNING]);
  assert.equal(tab.calls.scrolls, SCROLL_ROUNDS_WITHOUT_NEWS);
  // 3.0.1: the list ended early and TikTok's count is unknown, so the gap filling asks once more for
  // the page after the highest episode — the very request that brought no list — and, with no list
  // again, checks the page for the wall and ends: one more fetch, one more pause, one more check
  const next = withQueryParams(TEMPLATE, { cursor: "1", count: "30" });
  assert.deepEqual(tab.fetched, [TEMPLATE, next, next]);
  assert.equal(tab.calls.textReads, 2 + SCROLL_ROUNDS_WITHOUT_NEWS); // after the listless page, every quiet round and the filling
  assert.equal(sleeps.filter((seconds) => seconds === 0.8).length, 3 + SCROLL_ROUNDS_WITHOUT_NEWS); // all three fetches, every round
  assert.equal(found.earlyEnd, NO_LIST_WARNING); // still said: no page told the list was over
  assert.deepEqual(found.missingNumbers, []); // no count to name them by
  assert.equal(tab.calls.closed, 1);
});

test("a page text that cannot be read (the tab is navigating) is no captcha: the fallback and the filling go on as before", async () => {
  const tab = fakeTab({ answers: [page(1, true, 1), NO_LIST], texts: [new Error("Frame with ID 0 was removed.")] });
  const found = await discoverSeries(REF, deterministic(tab.browser).options);
  assert.deepEqual(found.episodes.map((episode) => episode.number), [1]);
  assert.deepEqual(found.warnings, [NO_LIST_WARNING]);
  assert.equal(tab.calls.scrolls, SCROLL_ROUNDS_WITHOUT_NEWS);
  assert.equal(tab.calls.textReads, 2 + SCROLL_ROUNDS_WITHOUT_NEWS); // 3.0.1: the filling's listless answer is checked too
  assert.equal(tab.calls.closed, 1);
});

test("the scroll fallback meets the wall after a quiet round: ChallengeError, no further round, the tab closed", async () => {
  const tab = fakeTab({ answers: [page(1, true, 1), NO_LIST], texts: [LIST_PAGE, WALL] });
  await assert.rejects(discoverSeries(REF, deterministic(tab.browser).options), isTheChallenge);
  assert.equal(tab.calls.scrolls, 1); // one quiet round, then the wall
  assert.equal(tab.calls.textReads, 2); // ordinary after the listless page, the wall after the quiet round
  assert.equal(tab.calls.closed, 1);
});

test("a round that added episodes needs no check; the wall during a later quiet round still stops", async () => {
  // the page's own second request (its scroll handler's), re-fetched once by the fallback
  const second = withQueryParams(TEMPLATE, { cursor: "1" });
  const tab = fakeTab({
    answers: [page(1, true, 1), NO_LIST, page(2, false, 2)],
    texts: [LIST_PAGE, LIST_PAGE, WALL],
    observed: [TEMPLATE, second],
  });
  await assert.rejects(discoverSeries(REF, deterministic(tab.browser).options), isTheChallenge);
  assert.deepEqual(tab.fetched, [TEMPLATE, withQueryParams(TEMPLATE, { cursor: "1", count: "30" }), second]);
  assert.equal(tab.calls.scrolls, 3); // one round that loaded the page's second request, then two quiet ones
  assert.equal(tab.calls.textReads, 3); // after the listless page and after each quiet round, never after a round that added
  assert.equal(tab.calls.closed, 1);
});

test("the repeated first page brings no list: the wall stops the discovery; an ordinary page scrolls, as before", async () => {
  const walled = fakeTab({ answers: [NO_LIST], texts: [WALL] });
  await assert.rejects(discoverSeries(REF, deterministic(walled.browser).options), isTheChallenge);
  assert.deepEqual(walled.fetched, [TEMPLATE]);
  assert.equal(walled.calls.scrolls, 0);
  assert.equal(walled.calls.closed, 1);
  const second = withQueryParams(TEMPLATE, { cursor: "1" });
  const ordinary = fakeTab({ answers: [NO_LIST, page(2, false, 2)], observed: [TEMPLATE, second] });
  const found = await discoverSeries(REF, deterministic(ordinary.browser).options);
  assert.deepEqual(found.episodes.map((episode) => episode.number), [2]);
  assert.equal(found.warnings[0], FIRST_PAGE_WARNING);
  // the page's own later request, once; then (3.0.1) the gap filling asks for episode 1, the hole
  // below the highest one listed — the template with cursor 0 and the usual count — which brings no
  // list here: one more fetch and one more check of the page, and episode 1 is said missing
  assert.deepEqual(ordinary.fetched, [TEMPLATE, second, withQueryParams(TEMPLATE, { cursor: "0", count: "30" })]);
  assert.equal(ordinary.calls.scrolls, 1 + SCROLL_ROUNDS_WITHOUT_NEWS);
  assert.equal(ordinary.calls.textReads, 2 + SCROLL_ROUNDS_WITHOUT_NEWS);
  assert.deepEqual(found.missingNumbers, [1]);
  assert.equal(found.earlyEnd, null); // the page's own second page said the list is over
  assert.equal(ordinary.calls.closed, 1);
});

// ------------------------------------------------------------------- the list's count (3.0.1)

const FIFTH_SERIES_ID = "7699393770256782377";
/** @type {import("../src/lib/urls.js").SeriesRef} */
const FIFTH_REF = { kind: "series", seriesId: FIFTH_SERIES_ID, episodeHint: null, sourceUrl: FIFTH_SERIES_ID };
const FIFTH_TEMPLATE = TEMPLATE.replaceAll(SERIES_ID, FIFTH_SERIES_ID);
const FIFTH_DETAIL_URL = DETAIL_URL.replaceAll(SERIES_ID, FIFTH_SERIES_ID);
/** The fifth series' duplicate and skipped items, as the warnings name them. */
const FIFTH_WARNINGS = [
  "duplicate episode number 2: item 7699400000000000692 left out (a highlight), item 7699400000000000602 kept",
  "TikTok listed 1 item DramaFetch could not read (another drama's id)",
  "TikTok listed 1 item DramaFetch could not read (no episode number)",
];

/**
 * A page of the fifth series (tests/fixtures/item_list_series5_page<n>.json): the series-4 capture's
 * item shape with a highlight of episode 2, an EpisodeNumber of 0, a trailer and another drama's item.
 * @param {number} n
 * @returns {unknown}
 */
function fifthPage(n) {
  return JSON.parse(readFileSync(new URL(`../../tests/fixtures/item_list_series5_page${n}.json`, import.meta.url), "utf8"));
}

test("the series: the items' numVideos is TikTok's count when the detail gives none; the merge's duplicates and the skipped items are said and kept", async () => {
  const tab = fakeTab({ answers: [fifthPage(1), fifthPage(2)], observed: [FIFTH_TEMPLATE] });
  const found = await discoverSeries(FIFTH_REF, deterministic(tab.browser).options);
  assert.deepEqual(found.episodes.map((episode) => episode.number), [1, 2, 3, 4, 5]);
  assert.equal(found.episodes[1]?.itemId, "7699400000000000602"); // the episode, never its highlight
  assert.equal(found.name, "Highlight Drama");
  assert.equal(found.totalHint, 7); // numVideos — not the other drama's 12
  assert.equal(found.itemsReceived, 7); // five episodes, the highlight and the trailer
  assert.deepEqual(found.skippedItems, [
    { reason: "no episode number", itemId: "7699400000000000690" },
    { reason: "another drama's id", itemId: "7699400000000000778" },
  ]);
  // 3.0.1, the lead's decision D2 (changed on purpose): TikTok's 7 may count the highlight and the
  // trailer, or two episodes past 5 may be missing — the list is uncertain: the filling asks once
  // for the page after the highest number listed (cursor 5), and the warnings say it
  assert.deepEqual(found.warnings, [...FIFTH_WARNINGS, "TikTok announces 7 episodes, 5 listed", uncertainText(7, 5, 2)]);
  assert.deepEqual(found.missingNumbers, []); // no phantom episode 6 or 7
  const fifthCursor5 = withQueryParams(FIFTH_TEMPLATE, { cursor: "5", count: "30" });
  assert.deepEqual(tab.fetched, [FIFTH_TEMPLATE, fifthCursor5, fifthCursor5]);
  assert.deepEqual(fills(found).map((page) => [page.cursorAsked, page.listed]), [["5", false]]);
  // a detail that names its count wins; a related drama's object in it gives nothing
  const detailed = fakeTab({
    answers: [
      fifthPage(1),
      fifthPage(2),
      {
        related: [{ dramaInfo: { dramaID: "1", dramaName: "Other", numVideos: 40 } }],
        dramaInfo: { dramaID: FIFTH_SERIES_ID, dramaName: "Detail Name", numVideos: 9 },
      },
    ],
    observed: [FIFTH_TEMPLATE, FIFTH_DETAIL_URL],
  });
  const withDetail = await discoverSeries(FIFTH_REF, deterministic(detailed.browser).options);
  assert.deepEqual([withDetail.name, withDetail.totalHint, withDetail.itemsReceived], ["Detail Name", 9, 7]);
  // 9 - 2 other items: 6 and 7 certainly missing, 8 and 9 uncertain (3.0.1, D2)
  assert.deepEqual(withDetail.missingNumbers, [6, 7]);
  assert.deepEqual(withDetail.warnings, [...FIFTH_WARNINGS, "TikTok announces 9 episodes, 5 listed", uncertainText(9, 5, 2)]);
});

// ---------------------------------------------------------------- the gap filling (3.0.1)

/** The list request's scheme, host and path, as the listing record keeps it (never the query). */
const ENDPOINT = "https://www.tiktok.com/api/drama/episode/item_list/";

/**
 * One episode of the fake drama in TikTok's item shape, `numVideos` (TikTok's count) on it unless
 * null, the highlight marks of every capture.
 * @param {number} number
 * @param {number | null} numVideos
 */
const listItem = (number, numVideos) => ({
  id: `7699400000${String(500000 + number).padStart(9, "0")}`,
  dramaInfo: {
    dramaID: SERIES_ID,
    dramaName: "Fake Drama",
    ...(numVideos === null ? {} : { numVideos }),
    DramaVideoData: { EpisodeNumber: number, IsHighlight: false, LinkedEpisodeID: "0" },
  },
  video: { playAddr: `https://v16-webapp-prime.tiktok.com/v/${number}.mp4`, duration: 3 },
});

/**
 * A fake TikTok series tab whose list answers by `cursor` and `count` — `cursor` the episodes
 * before the page, the answer's `cursor` the end of the window it served, `hasMore` while episodes
 * are left — as the investigation's reproduction (`r2_discovery.mjs`) models it. `pageSize` caps a
 * page whatever `count` asks; `lose(cursor, attempt)` answers something else for the attempt-th
 * request of a cursor (no list, a 429); `leave(number, cursor)` leaves an episode out of the page of
 * that cursor; `extras` puts an item that is no episode right before an episode, on every page that
 * holds it; `scrolled` are the item_list URLs the page itself requests at the first scroll round
 * (its own scroll handler). Every fetch and every pause lands in `events`, in order; navigations in
 * `navigated`.
 * @param {{total: number, numVideos?: number | null, pageSize?: number, template?: string,
 *   lose?: (cursor: number, attempt: number) => unknown, leave?: (number: number, cursor: number) => boolean,
 *   texts?: string[], extras?: {before: number, item: unknown}[], scrolled?: string[]}} script
 */
function fakeTikTok(script) {
  const numVideos = script.numVideos === undefined ? script.total : script.numVideos;
  const pageSize = script.pageSize ?? Number.POSITIVE_INFINITY;
  const template = script.template ?? TEMPLATE;
  const texts = [...(script.texts ?? [LIST_PAGE])];
  /** @type {Map<number, number>} how many times each cursor was asked */
  const attempts = new Map();
  /** @type {string[]} */
  const fetched = [];
  /** @type {string[]} */
  const navigated = [];
  /** @type {string[]} */
  const events = [];
  const calls = { scrolls: 0, closed: 0, textReads: 0 };
  /** @type {((request: {url: string, status: number}) => void) | null} */
  let completed = null;
  /** @type {import("../src/app/discovery.js").DiscoveryBrowser} */
  const browser = {
    openTab: async () => 7,
    navigate: async (_tab, url) => void navigated.push(url),
    tabUrl: async () => `https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/1`,
    activate: async () => undefined,
    closeTab: async () => {
      calls.closed += 1;
    },
    observe: (_tab, _urls, handlers) => {
      completed = handlers.completed;
      queueMicrotask(() => handlers.completed({ url: template, status: 200 }));
      return () => undefined;
    },
    fetchInTab: async (_tab, url) => {
      fetched.push(url);
      events.push(`fetch ${queryParam(url, "cursor")}/${queryParam(url, "count")}`);
      const cursor = Number(queryParam(url, "cursor") ?? "0");
      const count = Number(queryParam(url, "count") ?? "30");
      const attempt = (attempts.get(cursor) ?? 0) + 1;
      attempts.set(cursor, attempt);
      const other = script.lose?.(cursor, attempt);
      if (other !== undefined) return other;
      const end = Math.min(script.total, cursor + Math.min(count, pageSize));
      const itemList = [];
      for (let number = cursor + 1; number <= end; number += 1) {
        for (const extra of script.extras ?? []) if (extra.before === number) itemList.push(extra.item);
        if (!script.leave?.(number, cursor)) itemList.push(listItem(number, numVideos));
      }
      return { statusCode: 0, cursor: end, hasMore: end < script.total, itemList };
    },
    scrollTab: async () => {
      calls.scrolls += 1;
      if (calls.scrolls === 1) for (const url of script.scrolled ?? []) completed?.({ url, status: 200 });
      return null;
    },
    pageText: async () => {
      calls.textReads += 1;
      return (texts.length > 1 ? texts.shift() : texts[0]) ?? "";
    },
  };
  return { browser, fetched, navigated, events, calls };
}

/**
 * Deterministic options whose pauses land in the fake's `events` too (the rng at its floor: 0.8 s
 * before a page).
 * @param {ReturnType<typeof fakeTikTok>} tab
 * @param {Partial<import("../src/app/discovery.js").DiscoveryOptions>} [extra]
 * @returns {import("../src/app/discovery.js").DiscoveryOptions}
 */
function paced(tab, extra = {}) {
  let ticks = 0;
  return {
    browser: tab.browser,
    sleep: async (seconds) => {
      ticks += 1;
      tab.events.push(`sleep ${seconds}`);
    },
    rng: { uniform: (low) => low },
    clock: () => ticks,
    ...extra,
  };
}

/** @param {number} low @param {number} high */
const range = (low, high) => Array.from({ length: high - low + 1 }, (_, index) => low + index);
/** @param {import("../src/lib/catalog.js").Series} series */
const numbersOf = (series) => series.episodes.map((episode) => episode.number);
/** @param {import("../src/lib/catalog.js").Series} series */
const fills = (series) => (series.listing?.pages ?? []).filter((page) => page.kind === "fill");
/** @param {string[]} events every fetch right after a list-page pause */
const pausedBeforeEach = (events) => events.every((event, index) => !event.startsWith("fetch") || events[index - 1] === "sleep 0.8");
/** @param {number} cursor @param {number} count */
const pageUrl = (cursor, count) => withQueryParams(TEMPLATE, { cursor: String(cursor), count: String(count) });

test("a lost last page is asked for again once the pagination is over: every episode listed, nothing missing", async () => {
  const tab = fakeTikTok({ total: 45, lose: (cursor, attempt) => (cursor === 40 && attempt === 1 ? NO_LIST : undefined) });
  const found = await discoverSeries(REF, paced(tab));
  assert.deepEqual(numbersOf(found), range(1, 45));
  assert.deepEqual(found.missingNumbers, []);
  assert.equal(found.earlyEnd, null); // the filling's answer said the list is over
  assert.deepEqual(found.warnings, [NO_LIST_WARNING]); // the fallback's, as before: no gap, no count left
  // the very request the pagination made for the lost page, after the usual pause, once
  assert.deepEqual(tab.fetched, [TEMPLATE, pageUrl(10, 30), pageUrl(40, 30), pageUrl(40, 30)]);
  assert.ok(pausedBeforeEach(tab.events), tab.events.join(" | "));
  assert.equal(found.listing?.endpoint, ENDPOINT);
  assert.deepEqual(
    found.listing?.pages.map((p) => [p.kind, p.cursorAsked, p.countAsked, p.listed, p.items, p.hasMore, p.cursor]),
    [
      ["first", "0", "10", true, 10, true, 10],
      ["next", "10", "30", true, 30, true, 40],
      ["next", "40", "30", false, 0, null, null],
      ["fill", "40", "30", true, 5, false, 45],
    ],
  );
  assert.deepEqual(fills(found)[0]?.numbers, range(41, 45));
  assert.equal(tab.calls.closed, 1);
  // TikTok's count unknown (no numVideos): the early end asks for the episode after the highest one
  const uncounted = fakeTikTok({ total: 45, numVideos: null, lose: (cursor, attempt) => (cursor === 40 && attempt === 1 ? NO_LIST : undefined) });
  const listed = await discoverSeries(REF, paced(uncounted));
  assert.deepEqual(numbersOf(listed), range(1, 45));
  assert.deepEqual([listed.totalHint, listed.earlyEnd, listed.missingNumbers], [null, null, []]);
  assert.deepEqual(uncounted.fetched.slice(-1), [pageUrl(40, 30)]);
});

test("a lost middle page: the filling asks from the first missing episode, then on from where the answer stopped", async () => {
  const tab = fakeTikTok({ total: 45, lose: (cursor, attempt) => (cursor === 10 && attempt === 1 ? NO_LIST : undefined) });
  const found = await discoverSeries(REF, paced(tab));
  assert.deepEqual(numbersOf(found), range(1, 45));
  assert.deepEqual([found.missingNumbers, found.earlyEnd], [[], null]);
  assert.deepEqual(tab.fetched, [TEMPLATE, pageUrl(10, 30), pageUrl(10, 30), pageUrl(40, 30)]);
  assert.deepEqual(
    fills(found).map((p) => [p.cursorAsked, p.numbers.length, p.hasMore]),
    [
      ["10", 30, true],
      ["40", 5, false],
    ],
  );
  assert.ok(pausedBeforeEach(tab.events), tab.events.join(" | "));
});

test("an episode TikTok leaves out of one page once comes with the filling: every episode, no warning left", async () => {
  const tab = fakeTikTok({ total: 45, leave: (number, cursor) => number === 17 && cursor === 10 });
  const found = await discoverSeries(REF, paced(tab));
  assert.deepEqual(numbersOf(found), range(1, 45));
  assert.deepEqual(found.warnings, []);
  assert.deepEqual([found.missingNumbers, found.earlyEnd], [[], null]);
  // the pagination ended on TikTok's own last page; the hole is asked for from episode 17 on
  assert.deepEqual(tab.fetched, [TEMPLATE, pageUrl(10, 30), pageUrl(40, 30), pageUrl(16, 30)]);
  assert.deepEqual(fills(found).map((p) => [p.cursorAsked, p.countAsked, p.numbers[0], p.hasMore]), [["16", "30", 17, false]]);
  assert.deepEqual(tab.events.slice(-2), ["sleep 0.8", "fetch 16/30"]);
});

test("an episode TikTok always leaves out: one request for it, then it stays missing and is said", async () => {
  const tab = fakeTikTok({ total: 45, leave: (number) => number === 17 });
  const found = await discoverSeries(REF, paced(tab));
  assert.deepEqual(numbersOf(found), range(1, 45).filter((number) => number !== 17));
  assert.equal(fills(found).length, 1); // the answer said the list ends without it: never asked twice
  assert.deepEqual(found.missingNumbers, [17]);
  assert.equal(found.earlyEnd, null);
  assert.deepEqual(found.warnings, ["episode 17 missing (gap)", "TikTok announces 45 episodes, 44 listed"]);
});

test("a page that stays lost: one more request, no list, the filling ends; the early end and the missing episodes say it", async () => {
  const tab = fakeTikTok({ total: 45, lose: (cursor) => (cursor === 40 ? NO_LIST : undefined) });
  const found = await discoverSeries(REF, paced(tab));
  assert.deepEqual(numbersOf(found), range(1, 40));
  assert.deepEqual(found.missingNumbers, range(41, 45));
  assert.equal(found.earlyEnd, NO_LIST_WARNING);
  assert.deepEqual(found.warnings, [NO_LIST_WARNING, "TikTok announces 45 episodes, 40 listed"]);
  assert.deepEqual(fills(found).map((p) => [p.cursorAsked, p.listed]), [["40", false]]);
  // after the listless page, every quiet scroll round and the filling's listless answer: no wall
  assert.equal(tab.calls.textReads, 2 + SCROLL_ROUNDS_WITHOUT_NEWS);
  assert.equal(tab.calls.closed, 1);
});

test(`at most ${GAP_FILL_REQUESTS} filling requests per listing, each after the list-page pause; what is left stays missing`, async () => {
  assert.equal(GAP_FILL_REQUESTS, 4);
  // TikTok serves 10 episodes a page whatever is asked; the pagination stops at its page cap
  const tab = fakeTikTok({ total: 200, pageSize: 10 });
  const found = await discoverSeries(REF, paced(tab, { maxPages: 2 }));
  assert.equal(fills(found).length, GAP_FILL_REQUESTS);
  assert.deepEqual(
    fills(found).map((p) => p.cursorAsked),
    ["20", "30", "40", "50"], // each one on from where the answer before it stopped
  );
  assert.deepEqual(numbersOf(found), range(1, 60));
  assert.deepEqual(found.missingNumbers, range(61, 200));
  assert.equal(found.earlyEnd, "pagination stopped at max_pages (2); the list may be incomplete");
  assert.ok(pausedBeforeEach(tab.events), tab.events.join(" | "));
  assert.equal(tab.events.filter((event) => event === "sleep 0.8").length, 2 + GAP_FILL_REQUESTS);
});

test("no filling request for a list that came whole", async () => {
  const tab = fakeTikTok({ total: 45 });
  const found = await discoverSeries(REF, paced(tab));
  assert.deepEqual(numbersOf(found), range(1, 45));
  assert.deepEqual(tab.fetched, [TEMPLATE, pageUrl(10, 30), pageUrl(40, 30)]);
  assert.deepEqual([fills(found).length, found.missingNumbers, found.earlyEnd, found.warnings], [0, [], null, []]);
});

test("a 429 on a filling request stops the listing as a 429 anywhere does: RateLimitedError, the tab closed, the cooldown recorded", async () => {
  const lose = (/** @type {number} */ cursor, /** @type {number} */ attempt) => {
    if (cursor !== 40) return undefined;
    return attempt === 1 ? NO_LIST : { __dramafetch_status: 429, __dramafetch_text: "Too Many Requests" };
  };
  const tab = fakeTikTok({ total: 45, lose });
  await assert.rejects(
    discoverSeries(REF, paced(tab)),
    (/** @type {unknown} */ error) => error instanceof RateLimitedError && error.message === LIST_RATE_LIMIT_MESSAGE,
  );
  assert.deepEqual(tab.fetched.slice(-2), [pageUrl(40, 30), pageUrl(40, 30)]); // the filling's request was the last
  assert.equal(tab.calls.closed, 1);
  // through the engine's resolve, as a job lists a series: the 30-minute cooldown, source discovery
  /** @type {unknown} */
  let stored = null;
  const engine = /** @type {import("../src/app/engine.js").Engine} */ (
    /** @type {unknown} */ ({
      discover: (/** @type {import("../src/lib/urls.js").SeriesRef} */ ref) => discoverSeries(ref, paced(fakeTikTok({ total: 45, lose }))),
      cooldownStore: {
        read: () => stored,
        write: (/** @type {unknown} */ record) => {
          stored = record;
        },
      },
      wallClock: () => 1_800_000_000,
    })
  );
  await assert.rejects(resolve(engine, REF), RateLimitedError);
  assert.deepEqual(stored, { until: 1_800_000_000 + 1800, reason: LIST_RATE_LIMIT_MESSAGE, source: DISCOVERY_SOURCE, recorded_at: 1_800_000_000 });
});

test("the verification wall behind a filling request is a stop: ChallengeError, nothing more asked", async () => {
  // the listless page, the quiet scroll rounds: an ordinary page; the filling's answer: the wall
  const texts = [...Array(1 + SCROLL_ROUNDS_WITHOUT_NEWS).fill(LIST_PAGE), WALL];
  const tab = fakeTikTok({ total: 45, lose: (cursor) => (cursor === 40 ? NO_LIST : undefined), texts });
  await assert.rejects(discoverSeries(REF, paced(tab)), isTheChallenge);
  assert.equal(tab.fetched.length, 4); // the filling's one request, then the stop
  assert.equal(tab.calls.closed, 1);
});

test("a link to episode 3 opens episode 1's page; a page that still asks first for a later window has its first episodes filled", async () => {
  const link = `https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/3`;
  /** @type {import("../src/lib/urls.js").SeriesRef} */
  const third = { kind: "series", seriesId: SERIES_ID, episodeHint: 3, sourceUrl: link };
  const opened = fakeTikTok({ total: 45 });
  const whole = await discoverSeries(third, paced(opened));
  assert.deepEqual(opened.navigated, [`https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/1`]);
  assert.deepEqual(numbersOf(whole), range(1, 45)); // the episode in the link picks nothing
  assert.equal(fills(whole).length, 0); // and costs no request
  // the page's own first request is the window that holds episode 3 (cursor 2): episodes 1 and 2
  // are a hole below the highest one listed, asked for from cursor 0 once the pagination is over
  const window = withQueryParams(TEMPLATE, { cursor: "2", count: "30" });
  const tab = fakeTikTok({ total: 45, template: window });
  const found = await discoverSeries(third, paced(tab));
  assert.deepEqual(numbersOf(found), range(1, 45));
  assert.deepEqual([found.missingNumbers, found.warnings], [[], []]);
  assert.deepEqual(tab.fetched, [window, pageUrl(32, 30), pageUrl(0, 30)]);
});

test("the listing record names no query, no cookie, no signature: host and path, the cursor and count asked", async () => {
  const tab = fakeTikTok({ total: 45, leave: (number, cursor) => number === 17 && cursor === 10 });
  const found = await discoverSeries(REF, paced(tab));
  const record = JSON.stringify(found.listing);
  for (const secret of ["?", "msToken", "abc-DEF_123", "X-Bogus", "_signature", "WebIdLastTime", "dramaID"]) {
    assert.ok(!record.includes(secret), `${secret} in ${record}`);
  }
  // what each page says: how it was asked, what came back — nothing else of the request
  assert.deepEqual(Object.keys(found.listing?.pages[0] ?? {}).sort(), [
    "countAsked",
    "cursor",
    "cursorAsked",
    "hasMore",
    "items",
    "kind",
    "listed",
    "numbers",
  ]);
});

// ------------------------------------------------- 3.0.1: the review's listing fixes (D2, D4, D5, D6)

/** @param {import("../src/lib/catalog.js").Series} series every listed episode downloaded */
const allDone = (series) => series.episodes.map((episode) => ({ episode, status: "done", path: null, message: "" }));
/** @param {import("../src/lib/catalog.js").Series} series the report line of a run that saved every listed episode */
const lineOf = (series) => reportLine(seriesReport(series, /** @type {any} */ (allDone(series))));
/** An answer with a list in it and nothing of the series: TikTok's empty last page. */
const EMPTY_END = { statusCode: 0, itemList: [], hasMore: false, cursor: 0 };

test("the review's case (a): 66 episodes and a trailer, TikTok counts 66, E66 never listed — nothing named missing, one filling request at cursor 65, the list may be incomplete", async () => {
  const trailer = { id: "7699400000000000690", dramaInfo: { dramaID: SERIES_ID, numVideos: 66, DramaVideoData: { IsHighlight: false, LinkedEpisodeID: "0" } }, video: { duration: 30 } };
  const tab = fakeTikTok({ total: 66, leave: (number) => number === 66, extras: [{ before: 1, item: trailer }] });
  const found = await discoverSeries(REF, paced(tab));
  assert.deepEqual(numbersOf(found), range(1, 65));
  assert.deepEqual([found.missingNumbers, found.earlyEnd, found.itemsReceived], [[], null, 66]);
  assert.deepEqual(fills(found).map((page) => [page.cursorAsked, page.countAsked]), [["65", "30"]]);
  assert.ok(pausedBeforeEach(tab.events), tab.events.join(" | "));
  assert.deepEqual(found.warnings, [
    "TikTok listed 1 item DramaFetch could not read (no episode number)",
    "TikTok announces 66 episodes, 65 listed",
    uncertainText(66, 65, 1),
  ]);
  const report = seriesReport(found, /** @type {any} */ (allDone(found)));
  assert.deepEqual([report.complete, report.uncertain, report.gaps], [false, true, []]);
  assert.equal(lineOf(found), "incomplete: 65 of 65 — TikTok's list may be incomplete: TikTok counts 66 episodes, 65 listed and 1 other item (a trailer or a highlight)");
});

test("the review's case (b): 6 episodes and a trailer, TikTok counts 7, E04 never listed — E04 only (no phantom E07), also uncertain", async () => {
  const trailer = { id: "7699400000000000690", dramaInfo: { dramaID: SERIES_ID, numVideos: 7, DramaVideoData: {} } };
  const tab = fakeTikTok({ total: 6, numVideos: 7, leave: (number) => number === 4, extras: [{ before: 1, item: trailer }] });
  const found = await discoverSeries(REF, paced(tab));
  assert.deepEqual(numbersOf(found), [1, 2, 3, 5, 6]);
  assert.deepEqual(found.missingNumbers, [4]);
  // the filling asks for E04 (cursor 3); its answer says the list is over: the page after 6 too
  assert.deepEqual(fills(found).map((page) => page.cursorAsked), ["3"]);
  const report = seriesReport(found, /** @type {any} */ (allDone(found)));
  assert.deepEqual([report.gaps, report.uncertain, report.complete], [[4], true, false]);
  assert.equal(
    lineOf(found),
    "incomplete: 5 of 6 — episode 4 missing from TikTok's list; TikTok's list may be incomplete: TikTok counts 7 episodes, 5 listed and 1 other item (a trailer or a highlight)",
  );
});

test("the review's case (c): no other item, TikTok counts 66, E66 never listed — E66 missing, as before", async () => {
  const tab = fakeTikTok({ total: 66, leave: (number) => number === 66 });
  const found = await discoverSeries(REF, paced(tab));
  assert.deepEqual(found.missingNumbers, [66]);
  assert.deepEqual(fills(found).map((page) => page.cursorAsked), ["65"]);
  const report = seriesReport(found, /** @type {any} */ (allDone(found)));
  assert.deepEqual([report.gaps, report.uncertain], [[66], false]);
});

test("a lone highlight past the last episode listed (3.0.1, D3 at the top of the list): TikTok drops E66 but lists its highlight, numbered 66 — missing, one filling request for it, named in the warnings and the line; with a count of 66, never uncertain", async () => {
  for (const numVideos of [null, 66]) {
    const clip = {
      id: "7699400000000000066",
      dramaInfo: { dramaID: SERIES_ID, ...(numVideos === null ? {} : { numVideos }), DramaVideoData: { EpisodeNumber: 66, IsHighlight: true, LinkedEpisodeID: "7699400000000500066" } },
      video: { duration: 41 },
    };
    const tab = fakeTikTok({ total: 66, numVideos, leave: (number) => number === 66, extras: [{ before: 66, item: clip }] });
    const found = await discoverSeries(REF, paced(tab));
    assert.deepEqual(numbersOf(found), range(1, 65));
    assert.deepEqual([found.missingNumbers, found.highlightNumbers], [[66], [66]], `count ${numVideos}`);
    assert.deepEqual(fills(found).map((page) => page.cursorAsked), ["65"]);
    assert.equal(found.warnings[0], "episode 66 missing (gap)");
    assert.ok(!found.warnings.includes(uncertainText(66, 65, 1)), found.warnings.join(" | "));
    assert.equal(lineOf(found), "incomplete: 65 of 66 — episode 66 missing from TikTok's list");
  }
});

test("an item without an id served again by an overlapping filling page counts once (3.0.1, D4): TikTok's count still asks for the lost last episode", async () => {
  const idless = { dramaInfo: { dramaID: SERIES_ID, numVideos: 66, DramaVideoData: { EpisodeNumber: 0 } } };
  const tab = fakeTikTok({ total: 66, leave: (number) => number === 12 || number === 66, extras: [{ before: 15, item: idless }] });
  const found = await discoverSeries(REF, paced(tab));
  assert.deepEqual(found.missingNumbers, [12]);
  assert.equal(found.itemsReceived, 65); // 64 episodes and the one id-less item, once
  assert.deepEqual(fills(found).map((page) => page.cursorAsked), ["11", "65"]); // E12, then the page after 65
  assert.deepEqual(found.skippedItems, [{ reason: "no id", itemId: null }]);
  assert.ok(found.warnings.includes("TikTok listed 1 item DramaFetch could not read (no id)"), found.warnings.join(" | "));
  assert.ok(found.warnings.includes(uncertainText(66, 64, 1)), found.warnings.join(" | "));
});

test("an empty last answer to a cursor TikTok announced ends nothing (3.0.1, D5): the early end stands, the filling asks once, the line says the list ended early", async () => {
  // TikTok's count unknown; the page of cursor 40 always answers an empty list with hasMore false
  const tab = fakeTikTok({ total: 66, numVideos: null, lose: (cursor) => (cursor === 40 ? EMPTY_END : undefined) });
  const found = await discoverSeries(REF, paced(tab));
  assert.deepEqual(numbersOf(found), range(1, 40));
  assert.equal(found.earlyEnd, NOTHING_NEW_WARNING);
  assert.deepEqual(fills(found).map((page) => [page.cursorAsked, page.listed, page.hasMore]), [["40", true, false]]);
  assert.equal(lineOf(found), "incomplete: 40 of 40 — TikTok's list ended early after episode 40");
  // with TikTok's count, the filling brings what the empty answer did not
  const counted = fakeTikTok({ total: 66, lose: (cursor, attempt) => (cursor === 40 && attempt === 1 ? EMPTY_END : undefined) });
  const whole = await discoverSeries(REF, paced(counted));
  assert.deepEqual(numbersOf(whole), range(1, 66));
  assert.deepEqual([whole.missingNumbers, whole.earlyEnd], [[], null]);
  assert.equal(lineOf(whole), "complete: 66 of 66 (66 downloaded)");
  // a last page that brings items of the series with hasMore false still ends the list
  const ordinary = fakeTikTok({ total: 45, numVideos: null });
  const listed = await discoverSeries(REF, paced(ordinary));
  assert.deepEqual([listed.earlyEnd, fills(listed).length], [null, 0]);
});

test("the exact-multiple end (3.0.1, D5): TikTok says hasMore on its last full page, then answers an empty list — complete with its count, ended early without one", async () => {
  // 40 episodes: the page of cursor 10 holds 11-40 and still says hasMore; cursor 40 is empty
  const lose = (/** @type {number} */ cursor) =>
    cursor === 10
      ? { statusCode: 0, cursor: 40, hasMore: true, itemList: range(11, 40).map((number) => listItem(number, null)) }
      : cursor === 40
        ? EMPTY_END
        : undefined;
  const counted = fakeTikTok({ total: 40, lose, numVideos: 40 });
  const known = await discoverSeries(REF, paced(counted));
  assert.equal(known.earlyEnd, NOTHING_NEW_WARNING);
  assert.equal(fills(known).length, 0); // TikTok's 40 are all listed: nothing to ask
  assert.equal(lineOf(known), "complete: 40 of 40 (40 downloaded)");
  const uncounted = fakeTikTok({ total: 40, lose, numVideos: null });
  const unknown = await discoverSeries(REF, paced(uncounted));
  assert.deepEqual(fills(unknown).map((page) => page.cursorAsked), ["40"]); // once, the page after 40
  assert.equal(lineOf(unknown), "incomplete: 40 of 40 — TikTok's list ended early after episode 40");
});

test("each fallback of the pagination is an early end (3.0.1, D6): no usable cursor, a repeated page — with hasMore and without —, a replayed first page with no list; the filling asks for the page after the highest, and the line says the list ended early when it brings nothing", async () => {
  const noList = (/** @type {number} */ cursor) => (cursor === 20 ? NO_LIST : undefined);
  // a page that says hasMore with no cursor: the scroll fallback, then the filling at cursor 20
  const noCursor = fakeTikTok({
    total: 45,
    numVideos: null,
    lose: (cursor) =>
      cursor === 10 ? { statusCode: 0, hasMore: true, itemList: range(11, 20).map((number) => listItem(number, null)) } : noList(cursor),
  });
  const cursorless = await discoverSeries(REF, paced(noCursor));
  assert.equal(cursorless.earlyEnd, NO_CURSOR_WARNING);
  assert.deepEqual(fills(cursorless).map((page) => [page.cursorAsked, page.listed]), [["20", false]]);
  assert.equal(lineOf(cursorless), "incomplete: 20 of 20 — TikTok's list ended early after episode 20");
  // D5's filling half: the filling's own request — cursor 20, which no page announced — answered
  // with an empty last page ends nothing either: the early end stands
  const emptyFill = fakeTikTok({
    total: 45,
    numVideos: null,
    lose: (cursor) =>
      cursor === 10
        ? { statusCode: 0, hasMore: true, itemList: range(11, 20).map((number) => listItem(number, null)) }
        : cursor === 20
          ? EMPTY_END
          : undefined,
  });
  const emptied = await discoverSeries(REF, paced(emptyFill));
  assert.equal(emptied.earlyEnd, NO_CURSOR_WARNING);
  assert.deepEqual(fills(emptied).map((page) => [page.cursorAsked, page.listed, page.hasMore]), [["20", true, false]]);
  assert.equal(lineOf(emptied), "incomplete: 20 of 20 — TikTok's list ended early after episode 20");
  // ... and when the filling brings the rest, the drama is whole
  const healed = fakeTikTok({
    total: 25,
    numVideos: null,
    lose: (cursor) =>
      cursor === 10 ? { statusCode: 0, hasMore: true, itemList: range(11, 20).map((number) => listItem(number, null)) } : undefined,
  });
  const whole = await discoverSeries(REF, paced(healed));
  assert.deepEqual([numbersOf(whole), whole.earlyEnd], [range(1, 25), null]);
  assert.equal(lineOf(whole), "complete: 25 of 25 (25 downloaded)");
  // a later page that repeats the first one, with hasMore and without (pageEndsList: no end)
  for (const hasMore of [true, false]) {
    const repeat = fakeTikTok({
      total: 45,
      numVideos: null,
      lose: (cursor) =>
        cursor === 10 ? { statusCode: 0, cursor: 20, hasMore, itemList: range(1, 10).map((number) => listItem(number, null)) } : undefined,
    });
    const repeated = await discoverSeries(REF, paced(repeat));
    assert.equal(repeated.earlyEnd, NOTHING_NEW_WARNING, `hasMore ${hasMore}`);
    assert.deepEqual(fills(repeated).map((page) => page.cursorAsked), ["10"]);
    // the filling's answer at cursor 10 is the same repeat: nothing new, the line says where it ended
    assert.equal(lineOf(repeated), "incomplete: 10 of 10 — TikTok's list ended early after episode 10");
  }
  // the extension's own case: the replayed first page brings no list, a scroll round brings the
  // page's own request with hasMore; the filling asks for the page after the highest (cursor 20)
  const scrolledUrl = withQueryParams(TEMPLATE, { cursor: "0", count: "20" });
  const firstLost = fakeTikTok({
    total: 45,
    numVideos: null,
    lose: (cursor, attempt) => ((cursor === 0 && attempt === 1) || cursor === 20 ? NO_LIST : undefined),
    scrolled: [scrolledUrl],
  });
  const fromScroll = await discoverSeries(REF, paced(firstLost));
  assert.deepEqual(numbersOf(fromScroll), range(1, 20));
  assert.equal(fromScroll.earlyEnd, FIRST_PAGE_WARNING);
  assert.deepEqual(fills(fromScroll).map((page) => [page.cursorAsked, page.listed]), [["20", false]]);
  assert.equal(lineOf(fromScroll), "incomplete: 20 of 20 — TikTok's list ended early after episode 20");
});


test("the in-run refresh of a late episode's play addresses lists the drama like every listing (3.0.1, D7: no change of behaviour) — its page opened at episode 1, its reference naming no episode, the whole list read", async () => {
  const tiny = readFileSync(new URL("../../tests/fixtures/tiny.mp4", import.meta.url));
  const video = new Uint8Array(128 * 1024); // tiny.mp4 padded to 128 KiB with a top-level `free` box
  video.set(tiny, 0);
  new DataView(video.buffer).setUint32(tiny.length, video.length - tiny.length);
  video.set([0x66, 0x72, 0x65, 0x65], tiny.length + 4);
  const tab = fakeTikTok({ total: 45 });
  /** @type {import("../src/lib/urls.js").SeriesRef[]} */
  const asked = [];
  /** @type {string[]} */
  const requested = [];
  const subject = new Downloader({
    quality: "compatible",
    thumbnail: "none",
    nameFormat: "{series} - Episode {number}",
    includeLocked: false,
    hostPatterns: ["https://*.tiktok.com/*", "https://*.tiktokcdn.com/*"],
    view: /** @type {never} */ ({ completedAt: () => null, remember() {} }),
    rediscover: async (ref) => {
      asked.push(ref);
      return discoverSeries(ref, paced(tab));
    },
    fetch: async (input) => {
      requested.push(String(input));
      return new Response(video, { headers: { "content-type": "video/mp4" } });
    },
    redirects: null,
    save: async (_bytes, _mime, filename) => /** @type {never} */ ({ id: 1, filename: `/home/me/Downloads/${filename}`, state: "complete", exists: true }),
  });
  // episode 45, listed without a play address: its play addresses are asked for again
  const late = makeEpisode({
    number: 45,
    itemId: listItem(45, 45).id,
    title: "Episode 45",
    seriesId: SERIES_ID,
    seriesName: "Fake Drama",
    durationS: 3,
    raw: { ...listItem(45, 45), video: { duration: 3 } },
  });
  const result = await subject.download(late, { seriesName: "Fake Drama", folder: `Fake Drama [${SERIES_ID}]` });
  assert.equal(result.status, "done");
  assert.equal(subject.refreshes, 1);
  assert.deepEqual(asked, [{ kind: "series", seriesId: SERIES_ID, episodeHint: null, sourceUrl: SERIES_ID }]);
  assert.deepEqual(tab.navigated, [`https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/1`]);
  assert.deepEqual(requested, ["https://v16-webapp-prime.tiktok.com/v/45.mp4"]);
});
