// @ts-check
// Unit tests of the discovery's pagination over a fake tab: no browser, no network, no real sleep.
// The first page as the page's own request replayed byte for byte, the captcha checks after the
// first page (a later page that brings no list, a scroll round that loads nothing) and the scroll
// fallback exactly as before. tests/app.test.js holds the first-page stops (a 429, the login
// redirect, the wall before any list) and the real chrome.* seam.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHALLENGE_MESSAGE,
  ChallengeError,
  FIRST_PAGE_WARNING,
  NO_LIST_WARNING,
  SCROLL_ROUNDS_WITHOUT_NEWS,
  discoverSeries,
  withQueryParams,
} from "../src/app/discovery.js";

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

test("a later page without a list on an ordinary page: the scroll fallback and its warning, exactly as before", async () => {
  const tab = fakeTab({ answers: [page(1, true, 1), NO_LIST] });
  const { options, sleeps } = deterministic(tab.browser);
  const found = await discoverSeries(REF, options);
  assert.deepEqual(found.episodes.map((episode) => episode.number), [1]);
  assert.deepEqual(found.warnings, [NO_LIST_WARNING]);
  assert.equal(tab.calls.scrolls, SCROLL_ROUNDS_WITHOUT_NEWS);
  assert.equal(tab.calls.textReads, 1 + SCROLL_ROUNDS_WITHOUT_NEWS); // after the listless page, then after every quiet round
  assert.equal(sleeps.filter((seconds) => seconds === 0.8).length, 2 + SCROLL_ROUNDS_WITHOUT_NEWS); // both fetches, every round
  assert.equal(tab.calls.closed, 1);
});

test("a page text that cannot be read (the tab is navigating) is no captcha: the fallback goes on as before", async () => {
  const tab = fakeTab({ answers: [page(1, true, 1), NO_LIST], texts: [new Error("Frame with ID 0 was removed.")] });
  const found = await discoverSeries(REF, deterministic(tab.browser).options);
  assert.deepEqual(found.episodes.map((episode) => episode.number), [1]);
  assert.deepEqual(found.warnings, [NO_LIST_WARNING]);
  assert.equal(tab.calls.scrolls, SCROLL_ROUNDS_WITHOUT_NEWS);
  assert.equal(tab.calls.textReads, 1 + SCROLL_ROUNDS_WITHOUT_NEWS);
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
  assert.deepEqual(ordinary.fetched, [TEMPLATE, second]); // the page's own later request, once
  assert.equal(ordinary.calls.scrolls, 1 + SCROLL_ROUNDS_WITHOUT_NEWS);
  assert.equal(ordinary.calls.textReads, 1 + SCROLL_ROUNDS_WITHOUT_NEWS);
  assert.equal(ordinary.calls.closed, 1);
});
