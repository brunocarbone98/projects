// @ts-check
// The List favorites job's reading of the list (src/app/favorites.js `listFavorites`) over a fake
// `chrome.scripting.executeScript` serving the pages of a TikTok tab's `drama_list` request and a
// fake `chrome.tabs`: the pause before every page (the injected sleep records it, nothing sleeps
// for real), the first page as the template itself — replayed byte for byte, never rewritten — and
// the later pages as the template with only `cursor` changed, one request at a time, every stop
// (hasMore false, a cursor repeated or unchanged, a page that brings nothing new, two empty pages,
// the page cap, a card's listing far enough, Stop) and `cutShort`, the refusals (429 and 403 with
// the cooldown recorded, the login page, a captcha read in the ISOLATED world — also behind an
// answer that brings no list) and no request at all when the tab is gone, left TikTok (before any
// page, the first or a later one) or a cooldown is in force. tests/app.test.js drives the job
// inside the page (the panel, the card).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { FAVORITES_MAX_PAGES, NOT_A_LIST_MESSAGE, coversCard, resolveCard } from "../src/lib/favorites.js";
import { BLOCKED_MESSAGE, LIST_RATE_LIMIT_MESSAGE } from "../src/lib/messages.js";
import { PacingState, pacingOptions } from "../src/lib/pacing.js";
import {
  CHALLENGE_MESSAGE,
  ChallengeError,
  LOGIN_REDIRECT_MESSAGE,
  LoginRequiredError,
  RateLimitedError,
  fetchInPage,
  pageTextInPage,
  withQueryParams,
} from "../src/app/discovery.js";
import { StopRequested } from "../src/app/engine.js";
import {
  FAVORITES_CHALLENGE_MESSAGE,
  FAVORITES_RATE_LIMIT_MESSAGE,
  FavoritesError,
  FavoritesRefusedError,
  checkFavoritesTab,
  cutShort,
  listFavorites,
} from "../src/app/favorites.js";

const TAB = 42;
const PROFILE = "https://www.tiktok.com/@invented_viewer";
/** The tab's own first `drama_list` request: TikTok's signature parameters around `cursor`, one value percent-encoded as TikTok's are. */
const TEMPLATE =
  "https://www.tiktok.com/api/user/favorite/drama_list/?WebIdLastTime=1794300000&aid=1988&app_language=en" +
  "&browser_version=5.0%20%28Windows%29&count=19&cursor=0&msToken=abc-DEF_123&X-Bogus=DFSzswVOxQ&_signature=_02B4Z6wo00001";
/** @type {Record<string, unknown>} the anonymized capture: three dramas, the next cursor, hasMore, total 946 */
const CAPTURE = JSON.parse(readFileSync(new URL("../../tests/fixtures/drama_list_page.json", import.meta.url), "utf8"));
const CAPTURE_ITEMS = /** @type {Record<string, unknown>[]} */ (CAPTURE["dramaList"]);

/**
 * An item of the list, shaped like the capture's.
 * @param {string} seriesId
 * @param {string} title
 */
const favorite = (seriesId, title) => ({ ...CAPTURE_ITEMS[0], dramaID: seriesId, dramaName: title, numVideos: 40, totalDuration: "3000" });

/**
 * The list TikTok serves the tab, by cursor: the capture's page first, then two more.
 * @type {Record<string, unknown>}
 */
const PAGES = {
  "0": CAPTURE,
  "1794351568": { ...CAPTURE, cursor: "1794350100", dramaList: [favorite("7712345678901234564", "Paper Crowns"), favorite("7712345678901234565", "Moonlight Over the Harbor"), favorite("7712345678901234566", "Glass Slipper Contract")] },
  "1794350100": { ...CAPTURE, cursor: "1794349000", hasMore: false, dramaList: [favorite("7712345678901234567", "The Last Lantern"), favorite("7712345678901234568", "Tea House Vows")] },
};

/**
 * A fake chrome: the tab (its address; gone when `tabUrl` is null), `executeScript` serving `pages`
 * by cursor in the MAIN world (anything else as `fetchInPage` returns it) and the tab's text in the
 * ISOLATED world; every call logged, the concurrency measured. `log` interleaves the requests with
 * the pauses the engine slept and the cooldown reads. `duringFetch` runs while a page is read in
 * the MAIN world, before anything is asked: it may move the tab (`state.tabUrl`) or throw, as
 * Chrome's `executeScript` rejects for a tab closed or a frame replaced meanwhile.
 * @param {{pages?: Record<string, unknown>, tabUrl?: string | null, text?: string, duringFetch?: (cursor: string, state: {tabUrl: string | null}) => void}} [options]
 */
function fakeChrome(options = {}) {
  const pages = options.pages ?? PAGES;
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} the URLs fetched from inside the tab */
  const fetched = [];
  const state = { tabUrl: options.tabUrl === undefined ? PROFILE : options.tabUrl, text: options.text ?? "Invented Viewer\nFavorites\nDrama 946", inFlight: 0, most: 0, textReads: 0 };
  const chrome = {
    tabs: {
      get: async (/** @type {number} */ tabId) => {
        assert.equal(tabId, TAB);
        if (state.tabUrl === null) throw new Error(`No tab with id: ${tabId}.`);
        return { id: tabId, index: 0, windowId: 1, active: true, url: state.tabUrl };
      },
    },
    scripting: {
      /** @param {chrome.scripting.ScriptInjection<unknown[], unknown>} injection */
      executeScript: async (injection) => {
        assert.deepEqual(injection.target, { tabId: TAB });
        state.inFlight += 1;
        state.most = Math.max(state.most, state.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        state.inFlight -= 1;
        if (injection.world === "MAIN") {
          assert.equal(injection.func, fetchInPage); // the discovery's own in-page fetch, reused
          const [url, timeoutMs] = /** @type {[string, number]} */ (injection.args);
          assert.equal(timeoutMs, 45_000);
          const cursor = /[?&]cursor=([^&]*)/.exec(url)?.[1] ?? "";
          options.duringFetch?.(cursor, state);
          fetched.push(url);
          log.push(`request ${cursor}`);
          const answer = Object.hasOwn(pages, cursor) ? pages[cursor] : { __dramafetch_status: 404, __dramafetch_text: "not found" };
          return [{ frameId: 0, result: JSON.parse(JSON.stringify(answer)) }];
        }
        assert.equal(injection.world, undefined); // the page's text: the ISOLATED world, read only
        assert.equal(injection.func, pageTextInPage);
        state.textReads += 1;
        return [{ frameId: 0, result: state.text }];
      },
    },
  };
  Object.assign(globalThis, { chrome });
  return { log, fetched, state, restore: () => Reflect.deleteProperty(globalThis, "chrome") };
}

/**
 * The job's engine as `listFavorites` uses it: the injected sleep (logged, never slept), the rng at
 * its floor (0.8 s before a page), an in-memory cooldown, Stop.
 * @param {string[]} log
 */
function fakeEngine(log) {
  /** @type {Record<string, unknown> | undefined} */
  let cooldown;
  let now = 1_794_351_600;
  let stop = false;
  /** @type {(() => void) | null} what happens during the next pause */
  let duringPause = null;
  /** @type {import("../src/app/engine.js").Engine} */
  const engine = /** @type {import("../src/app/engine.js").Engine} */ (
    /** @type {unknown} */ ({
      pacing: pacingOptions(),
      testMode: false,
      includeLocked: false,
      recheck: false,
      pacingState: new PacingState(),
      rng: { uniform: (/** @type {number} */ low) => low },
      sleep: async (/** @type {number} */ seconds) => {
        log.push(`pause ${seconds}`);
        now += seconds;
        const then = duringPause;
        duringPause = null;
        then?.();
      },
      clock: () => now,
      wallClock: () => now,
      cooldownStore: {
        read: () => {
          log.push("cooldown?");
          return cooldown;
        },
        write: (/** @type {Record<string, unknown>} */ record) => {
          cooldown = record;
        },
      },
      stopRequested: () => stop,
    })
  );
  return {
    engine,
    cooldown: () => cooldown,
    /** @param {Record<string, unknown>} record */
    setCooldown: (record) => {
      cooldown = record;
    },
    /** @param {() => void} action */
    duringNextPause: (action) => {
      duringPause = action;
    },
    stop: () => {
      stop = true;
    },
    now: () => now,
  };
}

test("every page from inside the tab — the first the template itself, the later ones with only their cursor changed —, after a pause each and the cooldown asked right before it, one at a time, until hasMore is false", async () => {
  const fake = fakeChrome();
  try {
    const job = fakeEngine(fake.log);
    /** @type {number[]} */
    const seen = [];
    const listing = await listFavorites(job.engine, TAB, TEMPLATE, { onPage: (shown) => void seen.push(shown.items.length) });
    assert.deepEqual(listing.items.map((item) => item.title), [
      "The Lighthouse Keeper's Promise",
      "Snowfall in Two Cities",
      "Snowfall in Two Cities",
      "Paper Crowns",
      "Moonlight Over the Harbor",
      "Glass Slipper Contract",
      "The Last Lantern",
      "Tea House Vows",
    ]);
    assert.equal(listing.total, 946);
    assert.equal(listing.pages, 3);
    assert.equal(listing.complete, true);
    assert.equal(listing.ended, null);
    assert.deepEqual(seen, [3, 6, 8]); // the panel fills as pages arrive
    // the page's own request replayed: cursor 0 first, then the cursors TikTok named — every other
    // parameter byte for byte (TikTok signed them), `count` included
    assert.deepEqual(fake.fetched, ["0", "1794351568", "1794350100"].map((cursor) => withQueryParams(TEMPLATE, { cursor })));
    assert.equal(fake.fetched[0], TEMPLATE);
    for (const url of fake.fetched) assert.equal(url.replace(/cursor=[0-9]+/, "cursor=0"), TEMPLATE);
    // a pause before EVERY page (0.8 s at the floor of 0.8–1.6 s), the cooldown right before each request
    assert.deepEqual(fake.log, ["pause 0.8", "cooldown?", "request 0", "pause 0.8", "cooldown?", "request 1794351568", "pause 0.8", "cooldown?", "request 1794350100"]);
    assert.equal(fake.state.most, 1); // one request at a time
    assert.equal(fake.state.textReads, 0); // nothing went wrong: the page's text was never read
    assert.equal(job.cooldown(), undefined);
  } finally {
    fake.restore();
  }
});

test("the listing stops at a cursor that repeats or does not change, at two empty pages in a row, at the page cap, and once a card's position is covered", async () => {
  /** @param {string} cursor @param {boolean} hasMore @param {unknown[]} list */
  const pageOf = (cursor, hasMore, list) => ({ ...CAPTURE, cursor, hasMore, dramaList: list });
  const one = [favorite("7712345678901234569", "One More")];
  for (const [pages, fetched, ended] of /** @type {[Record<string, unknown>, string[], string][]} */ ([
    [{ "0": pageOf("0", true, one) }, ["0"], "cursor"], // the same cursor back
    [{ "0": pageOf("5", true, one), "5": pageOf("0", true, one) }, ["0", "5"], "cursor"], // a cursor that comes again
    [{ "0": { ...pageOf("5", true, one), cursor: null } }, ["0"], "cursor"], // no cursor at all
    [{ "0": pageOf("5", true, []), "5": pageOf("6", true, []), "6": pageOf("7", true, one) }, ["0", "5"], "empty"], // nothing twice in a row
    [{ "0": pageOf("5", true, []), "5": pageOf("6", true, one), "6": pageOf("7", true, []), "7": pageOf("7", true, one) }, ["0", "5", "6", "7"], "cursor"], // empty pages apart: it goes on
  ])) {
    const fake = fakeChrome({ pages });
    try {
      const listing = await listFavorites(fakeEngine(fake.log).engine, TAB, TEMPLATE);
      assert.deepEqual(fake.fetched.map((url) => /cursor=([^&]*)/.exec(url)?.[1]), fetched);
      assert.equal(listing.ended, ended);
      assert.equal(listing.complete, false);
    } finally {
      fake.restore();
    }
  }
  // the cap: FAVORITES_MAX_PAGES pages at most, whatever TikTok says
  assert.equal(FAVORITES_MAX_PAGES, 100);
  /** @type {Record<string, unknown>} */
  const endless = {};
  for (let page = 0; page < 150; page += 1) endless[String(page)] = pageOf(String(page + 1), true, [favorite(String(7712345678901300000n + BigInt(page)), `Drama ${page}`)]);
  let fake = fakeChrome({ pages: endless });
  try {
    const listing = await listFavorites(fakeEngine(fake.log).engine, TAB, TEMPLATE);
    assert.equal(fake.fetched.length, FAVORITES_MAX_PAGES);
    assert.equal(listing.ended, "cap");
    assert.equal(listing.items.length, FAVORITES_MAX_PAGES);
    assert.equal(fake.log.filter((line) => line.startsWith("pause ")).length, FAVORITES_MAX_PAGES);
    const capped = await listFavorites(fakeEngine([]).engine, TAB, TEMPLATE, { maxPages: 2 });
    assert.equal(capped.pages, 2);
  } finally {
    fake.restore();
  }
  // a right-clicked card's listing: the pages until it reaches the card (`until`, asked after every
  // page that does not end the list), no further
  fake = fakeChrome();
  try {
    const paper = { title: "Paper Crowns", index: 3 }; // the first drama of the second page
    const listing = await listFavorites(fakeEngine(fake.log).engine, TAB, TEMPLATE, { until: (items, perPage) => coversCard(items, paper, perPage) });
    assert.equal(fake.fetched.length, 2);
    assert.equal(listing.items.length, 6);
    assert.equal(listing.ended, "until");
    const lighthouse = { title: "The Lighthouse Keeper's Promise", index: 0 };
    const first = await listFavorites(fakeEngine([]).engine, TAB, TEMPLATE, { until: (items, perPage) => coversCard(items, lighthouse, perPage) });
    assert.equal(first.pages, 1);
    // the stop condition sees every item listed so far, in the list's order
    /** @type {number[]} */
    const asked = [];
    await listFavorites(fakeEngine([]).engine, TAB, TEMPLATE, { until: (items) => (asked.push(items.length), false) });
    assert.deepEqual(asked, [3, 6]); // not after the last page: the list's end comes first
  } finally {
    fake.restore();
  }
});

test("the first page is the page's own request replayed byte for byte — nothing appended to an address without a cursor, an empty or an encoded cursor never rewritten —; every later page is that request with only its cursor changed, count untouched", async () => {
  const noCursor = TEMPLATE.replace("&cursor=0", "");
  assert.ok(!noCursor.includes("cursor"));
  for (const [template, own] of /** @type {[string, string][]} */ ([
    [TEMPLATE, "0"],
    [noCursor, ""], // the page asked for its first page without a cursor
    [TEMPLATE.replace("cursor=0", "cursor="), ""], // with an empty one
    [TEMPLATE.replace("cursor=0", "cursor=%30"), "%30"], // with an encoded 0
  ])) {
    const fake = fakeChrome({ pages: { ...PAGES, [own]: CAPTURE } });
    try {
      const listing = await listFavorites(fakeEngine(fake.log).engine, TAB, template);
      assert.equal(listing.complete, true, template);
      assert.equal(fake.fetched.length, 3, template);
      assert.equal(fake.fetched[0], template); // the first page: the template itself, byte for byte
      // the later pages: the template with the next cursor in place of its own (appended when it had
      // none) — every other parameter byte for byte, `count` included
      assert.deepEqual(fake.fetched.slice(1), ["1794351568", "1794350100"].map((cursor) => withQueryParams(template, { cursor })), template);
      for (const url of fake.fetched.slice(1)) assert.ok(url.includes("&count=19&"), url);
    } finally {
      fake.restore();
    }
  }
  // without a cursor of its own: page 2 carries one, appended — the only parameter added
  const fake = fakeChrome({ pages: { ...PAGES, "": CAPTURE } });
  try {
    await listFavorites(fakeEngine(fake.log).engine, TAB, noCursor);
    assert.equal(fake.fetched[1], `${noCursor}&cursor=1794351568`);
  } finally {
    fake.restore();
  }
  // the first page's own cursor counts as asked: a page that names it next is the end, never a
  // rewritten first page (`…&cursor=0` appended to the page's own request)
  const back = fakeChrome({ pages: { "": { ...CAPTURE, cursor: "0" } } });
  try {
    const listing = await listFavorites(fakeEngine(back.log).engine, TAB, noCursor);
    assert.deepEqual(back.fetched, [noCursor]);
    assert.equal(listing.ended, "cursor");
  } finally {
    back.restore();
  }
});

test("a right-clicked card's listing reads on until it reaches the card: past a drama that moved down the list, and one page past a last drama of the card's title — its twin may begin the next page", async () => {
  for (const [card, pages] of /** @type {[import("../src/lib/favorites.js").Card, number][]} */ ([
    [{ title: "The Lighthouse Keeper's Promise", index: 0 }, 1], // at its position: the first page only
    [{ title: "Moonlight Over the Harbor", index: 1 }, 2], // moved down since the grid loaded: read on to it
    [{ title: "Paper Crowns", index: 0 }, 2],
    [{ title: "Glass Slipper Contract", index: 5 }, 3], // the last drama of page 2: one page more (here, the list's end)
    [{ title: "Snowfall in Two Cities", index: 1 }, 2], // two of that title end page 1: one page more
    [{ title: "A Drama Not Listed", index: 0 }, 3], // never in view: to the list's end
    // moved down one place, another drama at the card's position: a page past it (here, the list's end)
    [{ title: "Moonlight Over the Harbor", index: 3 }, 3],
  ])) {
    const fake = fakeChrome();
    try {
      const listing = await listFavorites(fakeEngine(fake.log).engine, TAB, TEMPLATE, { until: (items, perPage) => coversCard(items, card, perPage) });
      assert.equal(listing.pages, pages, card.title);
      assert.equal(fake.fetched.length, pages, card.title);
      assert.equal(listing.ended, pages === 3 ? null : "until", card.title);
      assert.equal(listing.perPage, 3, card.title); // three dramas a page
    } finally {
      fake.restore();
    }
  }
});

test("a right-clicked card whose drama is not where the card sits — a favorite added elsewhere since the grid loaded moved every card — is read a page past its position: two different dramas of its title then both in view, none picked", async () => {
  // 19 dramas a page, as in the owner's capture: two different "Snowfall in Two Cities" at 2 and 18
  // in the grid, one favorite added on the phone since — on top of the list TikTok sends now, so
  // the right-clicked one (the card at 18) is the first drama of page 2, the other one at 3
  const twins = [favorite("7712345678901240002", "Snowfall in Two Cities"), favorite("7712345678901240018", "Snowfall in Two Cities")];
  const grid = Array.from({ length: 40 }, (_, n) => (n === 2 ? twins[0] : n === 18 ? twins[1] : favorite(String(7712345678901241000n + BigInt(n)), `Drama ${n}`)));
  const fresh = [favorite("7712345678901242000", "A New Favorite"), ...grid];
  const cursors = ["0", "1794351568", "1794350100"];
  /** @type {Record<string, unknown>} */
  const pages = {};
  cursors.forEach((cursor, page) => {
    pages[cursor] = { ...CAPTURE, total: String(fresh.length), cursor: cursors[page + 1] ?? "1794349000", hasMore: page < 2, dramaList: fresh.slice(page * 19, page * 19 + 19) };
  });
  const card = { title: "Snowfall in Two Cities", index: 18 };
  const fake = fakeChrome({ pages });
  try {
    const listing = await listFavorites(fakeEngine(fake.log).engine, TAB, TEMPLATE, { until: (items, perPage) => coversCard(items, card, perPage) });
    assert.equal(listing.perPage, 19);
    assert.equal(fake.fetched.length, 2); // page 1 held the card's position and the other one: one page more
    assert.equal(listing.ended, "until");
    assert.deepEqual(
      resolveCard(listing.items, card),
      { kind: "shared", items: [{ seriesId: "7712345678901240002", title: "Snowfall in Two Cities", episodes: 40, durationS: 3000 }, { seriesId: "7712345678901240018", title: "Snowfall in Two Cities", episodes: 40, durationS: 3000 }] },
    );
  } finally {
    fake.restore();
  }
});

test("HTTP 429 and 403 stop the listing and record the 30-minute cooldown with their reason; the login page stops it without one", async () => {
  // the refusals' texts name the list that was refused, never a series or the episode list
  assert.notEqual(FAVORITES_RATE_LIMIT_MESSAGE, LIST_RATE_LIMIT_MESSAGE);
  assert.notEqual(FAVORITES_CHALLENGE_MESSAGE, CHALLENGE_MESSAGE);
  for (const text of [FAVORITES_RATE_LIMIT_MESSAGE, FAVORITES_CHALLENGE_MESSAGE]) {
    assert.match(text, /favorites list/);
    assert.doesNotMatch(text, /series|episode list/);
  }
  for (const [status, type, message] of /** @type {[number, Function, string][]} */ ([
    [429, RateLimitedError, FAVORITES_RATE_LIMIT_MESSAGE],
    [403, FavoritesRefusedError, BLOCKED_MESSAGE],
  ])) {
    const fake = fakeChrome({ pages: { "0": CAPTURE, "1794351568": { __dramafetch_status: status, __dramafetch_text: '{"statusCode": 429}' } } });
    try {
      const job = fakeEngine(fake.log);
      await assert.rejects(listFavorites(job.engine, TAB, TEMPLATE), (error) => error instanceof type && /** @type {Error} */ (error).message === message);
      assert.equal(fake.fetched.length, 2); // nothing after the refusal
      const cooldown = /** @type {Record<string, unknown>} */ (job.cooldown());
      assert.equal(cooldown["reason"], message);
      assert.equal(cooldown["source"], "discovery");
      assert.equal(Number(cooldown["until"]) - Number(cooldown["recorded_at"]), 30 * 60);
    } finally {
      fake.restore();
    }
  }
  // the tab on TikTok's login page: a stop, no request, no cooldown
  const fake = fakeChrome({ tabUrl: "https://www.tiktok.com/login?redirect_url=%2F%40invented_viewer" });
  try {
    const job = fakeEngine(fake.log);
    await assert.rejects(listFavorites(job.engine, TAB, TEMPLATE), (error) => error instanceof LoginRequiredError && error.message === LOGIN_REDIRECT_MESSAGE);
    assert.deepEqual(fake.fetched, []);
    assert.equal(job.cooldown(), undefined);
  } finally {
    fake.restore();
  }
});

test("an answer that is no JSON: the tab's text read in the ISOLATED world — TikTok's wall is a captcha (a stop and the cooldown), anything else a stop without one; TikTok's own error carries its message", async () => {
  const notJson = { __dramafetch_status: 200, __dramafetch_text: "<!doctype html><title>Security check</title>" };
  let fake = fakeChrome({ pages: { "0": notJson }, text: "Security check\nVerify to continue\nDrag the puzzle piece into place." });
  try {
    const job = fakeEngine(fake.log);
    await assert.rejects(listFavorites(job.engine, TAB, TEMPLATE), (error) => error instanceof ChallengeError && error.message === FAVORITES_CHALLENGE_MESSAGE);
    assert.equal(fake.state.textReads, 1);
    assert.equal(/** @type {Record<string, unknown>} */ (job.cooldown())["reason"], FAVORITES_CHALLENGE_MESSAGE);
  } finally {
    fake.restore();
  }
  for (const [answer, detail] of /** @type {[unknown, string][]} */ ([
    [notJson, "200"],
    [{ __dramafetch_status: 500, __dramafetch_text: "oops" }, "500"],
    [{ __dramafetch_status: 0, __dramafetch_text: "AbortError" }, "0"],
  ])) {
    fake = fakeChrome({ pages: { "0": answer } });
    try {
      const job = fakeEngine(fake.log);
      await assert.rejects(listFavorites(job.engine, TAB, TEMPLATE), (error) => error instanceof FavoritesError && error.kind === "unreadable" && error.detail === detail);
      assert.equal(fake.state.textReads, 1);
      assert.equal(job.cooldown(), undefined); // no refusal: no cooldown
    } finally {
      fake.restore();
    }
  }
  fake = fakeChrome({ pages: { "0": { ...CAPTURE, statusCode: 10201, status_code: 10201, status_msg: "Something went wrong", dramaList: [] } } });
  try {
    const job = fakeEngine(fake.log);
    await assert.rejects(listFavorites(job.engine, TAB, TEMPLATE), (error) => error instanceof FavoritesError && error.kind === "status" && error.detail === "Something went wrong");
    assert.equal(job.cooldown(), undefined);
  } finally {
    fake.restore();
  }
});

test("no request at all when the tab is gone or shows another site, or when a cooldown is in force before a page; Stop ends the listing between two pages", async () => {
  for (const tabUrl of [null, "https://example.com/elsewhere", "chrome://newtab/"]) {
    const fake = fakeChrome({ tabUrl });
    try {
      await assert.rejects(listFavorites(fakeEngine(fake.log).engine, TAB, TEMPLATE), (error) => error instanceof FavoritesError && error.kind === "tab-gone");
      await assert.rejects(checkFavoritesTab(TAB, TEMPLATE), (error) => error instanceof FavoritesError && error.kind === "tab-gone");
      assert.deepEqual(fake.fetched, []);
    } finally {
      fake.restore();
    }
  }
  // the tab still there and on TikTok: nothing to say before the first request — on any of TikTok's
  // own pages (`www.`, `m.`, the bare host), whichever TikTok host the address is on
  let fake = fakeChrome();
  try {
    await checkFavoritesTab(TAB, TEMPLATE);
    assert.deepEqual(fake.fetched, []);
  } finally {
    fake.restore();
  }
  for (const tabUrl of ["https://m.tiktok.com/@invented_viewer", "https://tiktok.com/@invented_viewer"]) {
    fake = fakeChrome({ tabUrl });
    try {
      await checkFavoritesTab(TAB, TEMPLATE);
    } finally {
      fake.restore();
    }
  }
  // the page's list on another TikTok host than the tab's (the worker observes them all): read
  // from that tab all the same, the address replayed with only its cursor changed
  const elsewhere = TEMPLATE.replace("https://www.tiktok.com/", "https://m.tiktok.com/");
  fake = fakeChrome();
  try {
    await checkFavoritesTab(TAB, elsewhere);
    const listing = await listFavorites(fakeEngine(fake.log).engine, TAB, elsewhere);
    assert.equal(listing.complete, true);
    assert.deepEqual(fake.fetched, ["0", "1794351568", "1794350100"].map((cursor) => withQueryParams(elsewhere, { cursor })));
  } finally {
    fake.restore();
  }
  // but never from a page off TikTok's own pages, nor over plain http
  for (const tabUrl of ["https://nottiktok.com/@x", "http://www.tiktok.com/@invented_viewer", "https://tiktok.com.example.com/@x", "https://seller.tiktok.com/home"]) {
    fake = fakeChrome({ tabUrl });
    try {
      await assert.rejects(checkFavoritesTab(TAB, elsewhere), (error) => error instanceof FavoritesError && error.kind === "tab-gone");
      await assert.rejects(listFavorites(fakeEngine(fake.log).engine, TAB, elsewhere), (error) => error instanceof FavoritesError && error.kind === "tab-gone");
      assert.deepEqual(fake.fetched, []);
    } finally {
      fake.restore();
    }
  }
  // a cooldown recorded during the second page's pause: that page is never asked for
  fake = fakeChrome();
  try {
    const job = fakeEngine(fake.log);
    let pauses = 0;
    const engine = { ...job.engine, sleep: async (/** @type {number} */ seconds) => {
      await job.engine.sleep(seconds);
      pauses += 1;
      if (pauses === 2) job.setCooldown({ until: job.now() + 1800, reason: "rate limited (HTTP 429) by the video server", source: "browser", recorded_at: job.now() });
    } };
    await assert.rejects(listFavorites(engine, TAB, TEMPLATE), (error) => error instanceof FavoritesError && error.kind === "cooldown" && error.detail.startsWith("TikTok refused a request at "));
    assert.equal(fake.fetched.length, 1);
  } finally {
    fake.restore();
  }
  // Stop pressed while the first page was read: the listing ends before the next pause
  fake = fakeChrome();
  try {
    const job = fakeEngine(fake.log);
    /** @type {number[]} */
    const pages = [];
    await assert.rejects(
      listFavorites(job.engine, TAB, TEMPLATE, {
        onPage: (listing) => {
          pages.push(listing.items.length);
          job.stop();
        },
      }),
      StopRequested,
    );
    assert.deepEqual(pages, [3]);
    assert.equal(fake.fetched.length, 1);
    assert.deepEqual(fake.log, ["pause 0.8", "cooldown?", "request 0"]);
  } finally {
    fake.restore();
  }
});

test("an answer that brings no list — TikTok's own error, JSON without a list, a page without a drama — with TikTok's wall in the tab is a captcha (a stop and the cooldown), as the discovery reads a listless page; without the wall, as before", async () => {
  const wall = "Security check\nVerify to continue\nDrag the puzzle piece into place.";
  const verify = { statusCode: 10000, status_code: 10000, status_msg: "verify" };
  for (const pages of /** @type {Record<string, unknown>[]} */ ([
    { "0": verify }, // TikTok's own error
    { "0": { statusCode: 0, status_code: 0, status_msg: "" } }, // JSON that holds no list
    { "0": { ...CAPTURE, dramaList: [], hasMore: false } }, // a page without a drama
    { "0": CAPTURE, "1794351568": { code: "10000", type: "verify" } }, // mid-list: never a partial list called complete
  ])) {
    const fake = fakeChrome({ pages, text: wall });
    try {
      const job = fakeEngine(fake.log);
      await assert.rejects(listFavorites(job.engine, TAB, TEMPLATE), (error) => error instanceof ChallengeError && error.message === FAVORITES_CHALLENGE_MESSAGE);
      assert.equal(fake.state.textReads, 1); // the tab's text, read in the ISOLATED world: no request
      const cooldown = /** @type {Record<string, unknown>} */ (job.cooldown());
      assert.equal(cooldown["reason"], FAVORITES_CHALLENGE_MESSAGE);
      assert.equal(cooldown["source"], "discovery");
    } finally {
      fake.restore();
    }
  }
  // without the wall: TikTok's own error carries its message, JSON without a list is none, an
  // empty last page of a list TikTok counts empty is its end — never a cooldown
  let fake = fakeChrome({ pages: { "0": verify } });
  try {
    const job = fakeEngine(fake.log);
    await assert.rejects(listFavorites(job.engine, TAB, TEMPLATE), (error) => error instanceof FavoritesError && error.kind === "status" && error.detail === "verify");
    assert.equal(fake.state.textReads, 1);
    assert.equal(job.cooldown(), undefined);
  } finally {
    fake.restore();
  }
  fake = fakeChrome({ pages: { "0": { statusCode: 0, status_code: 0, status_msg: "" } } });
  try {
    const job = fakeEngine(fake.log);
    await assert.rejects(listFavorites(job.engine, TAB, TEMPLATE), (error) => error instanceof FavoritesError && error.kind === "status" && error.detail === NOT_A_LIST_MESSAGE);
    assert.equal(job.cooldown(), undefined);
  } finally {
    fake.restore();
  }
  fake = fakeChrome({ pages: { "0": { ...CAPTURE, dramaList: [], hasMore: false, total: "0" } } });
  try {
    const job = fakeEngine(fake.log);
    const listing = await listFavorites(job.engine, TAB, TEMPLATE);
    assert.deepEqual([listing.items.length, listing.complete, fake.state.textReads], [0, true, 1]);
    assert.equal(job.cooldown(), undefined);
  } finally {
    fake.restore();
  }
});

test("the tab checked again before every page: closed, on another site or on TikTok's login page after the first page, nothing more is asked of it; a page whose script could not run in the tab ends it as a tab gone, the login page met during a request is the login wall — never a cooldown", async () => {
  const login = "https://www.tiktok.com/login?redirect_url=%2F%40invented_viewer";
  // the tab moved while the first page was read: the next page is never asked for
  for (const [moved, expected] of /** @type {[string | null, (error: unknown) => boolean][]} */ ([
    [null, (error) => error instanceof FavoritesError && error.kind === "tab-gone"], // closed
    ["https://example.com/elsewhere", (error) => error instanceof FavoritesError && error.kind === "tab-gone"],
    ["https://support.tiktok.com/en", (error) => error instanceof FavoritesError && error.kind === "tab-gone"], // a TikTok host, not its pages: only the site check stops it
    [login, (error) => error instanceof LoginRequiredError && error.message === LOGIN_REDIRECT_MESSAGE],
  ])) {
    const fake = fakeChrome();
    try {
      const job = fakeEngine(fake.log);
      await assert.rejects(listFavorites(job.engine, TAB, TEMPLATE, { onPage: () => void (fake.state.tabUrl = moved) }), expected);
      assert.deepEqual(fake.fetched, [TEMPLATE]); // the first page only
      assert.deepEqual(fake.log, ["pause 0.8", "cooldown?", "request 0", "pause 0.8", "cooldown?"]);
      assert.equal(job.cooldown(), undefined);
    } finally {
      fake.restore();
    }
  }
  // the second page's script could not run: the frame went away (the tab closed or navigated)
  let fake = fakeChrome({
    duringFetch: (cursor) => {
      if (cursor !== "0") throw new Error("Frame with ID 0 was removed.");
    },
  });
  try {
    const job = fakeEngine(fake.log);
    await assert.rejects(listFavorites(job.engine, TAB, TEMPLATE), (error) => error instanceof FavoritesError && error.kind === "tab-gone");
    assert.equal(fake.fetched.length, 1);
    assert.equal(fake.state.textReads, 0);
    assert.equal(job.cooldown(), undefined);
  } finally {
    fake.restore();
  }
  // the tab went to TikTok's login page while the second page was asked for, and the answer was no
  // list: the login wall, read from the tab's address before its text
  fake = fakeChrome({
    pages: { ...PAGES, "1794351568": { __dramafetch_status: 200, __dramafetch_text: "<!doctype html><title>Log in | TikTok</title>" } },
    duringFetch: (cursor, state) => {
      if (cursor !== "0") state.tabUrl = login;
    },
  });
  try {
    const job = fakeEngine(fake.log);
    await assert.rejects(listFavorites(job.engine, TAB, TEMPLATE), (error) => error instanceof LoginRequiredError && error.message === LOGIN_REDIRECT_MESSAGE);
    assert.equal(fake.fetched.length, 2);
    assert.equal(fake.state.textReads, 0);
    assert.equal(job.cooldown(), undefined);
  } finally {
    fake.restore();
  }
});

test("TikTok stopping before the list's end: a page that brings nothing new ends the listing (not listed twice, so the positions stay the profile's), an empty last page while TikTok counts more is no end, and cutShort tells both from the end", async () => {
  // the replayed next cursor answered with the first page again, under a fresh cursor each time:
  // two requests, not FAVORITES_MAX_PAGES
  /** @type {Record<string, unknown>} */
  const again = { "0": CAPTURE };
  for (let page = 1; page < 150; page += 1) again[String(1794351567 + page)] = { ...CAPTURE, cursor: String(1794351568 + page) };
  let fake = fakeChrome({ pages: again });
  try {
    // a card's listing: the card (index 4) lies past what TikTok sends
    const listing = await listFavorites(fakeEngine(fake.log).engine, TAB, TEMPLATE, { until: (items, perPage) => coversCard(items, { title: "Tea House Vows", index: 4 }, perPage) });
    assert.equal(fake.fetched.length, 2);
    assert.equal(listing.items.length, 3);
    assert.equal(listing.ended, "cursor");
    assert.equal(listing.complete, false);
    assert.equal(cutShort(listing), true);
  } finally {
    fake.restore();
  }
  // the same, the first page carrying an item without a readable series id (a JSON number): the
  // page served again still brings no drama not listed already — two requests, its dramas not
  // listed twice nor its unreadable item counted twice, and TikTok's stop said (cut short)
  /** @type {Record<string, unknown>} */
  const unreadable = { ...CAPTURE, dramaList: [...CAPTURE_ITEMS, { ...CAPTURE_ITEMS[0], dramaID: 7712345678901234000 }] };
  /** @type {Record<string, unknown>} */
  const againUnreadable = { "0": unreadable };
  for (let page = 1; page < 150; page += 1) againUnreadable[String(1794351567 + page)] = { ...unreadable, cursor: String(1794351568 + page) };
  fake = fakeChrome({ pages: againUnreadable });
  try {
    const listing = await listFavorites(fakeEngine(fake.log).engine, TAB, TEMPLATE, { until: (items, perPage) => coversCard(items, { title: "Tea House Vows", index: 4 }, perPage) });
    assert.equal(fake.fetched.length, 2);
    assert.equal(listing.items.length, 3);
    assert.equal(listing.skipped, 1);
    assert.equal(listing.perPage, 4); // a page's dramas, the one without a readable id included
    assert.equal(listing.ended, "cursor");
    assert.equal(listing.complete, false);
    assert.equal(cutShort(listing), true);
  } finally {
    fake.restore();
  }
  // that page served again under the cursor it came with, while TikTok counts 6 favorites and sent
  // 4: the end after two requests, and the counts stay what TikTok sent — so the list is cut short,
  // never passed off as whole by dramas counted twice
  fake = fakeChrome({ pages: { "0": { ...unreadable, total: "6" }, "1794351568": { ...unreadable, total: "6" } } });
  try {
    const listing = await listFavorites(fakeEngine(fake.log).engine, TAB, TEMPLATE);
    assert.equal(fake.fetched.length, 2);
    assert.equal(listing.items.length, 3);
    assert.equal(listing.skipped, 1);
    assert.equal(listing.ended, "cursor");
    assert.equal(cutShort(listing), true);
  } finally {
    fake.restore();
  }
  // an empty last page (hasMore false) while TikTok counts 946: not the list's end
  fake = fakeChrome({ pages: { "0": CAPTURE, "1794351568": { dramaList: [], hasMore: false, statusCode: 0 } } });
  try {
    const listing = await listFavorites(fakeEngine(fake.log).engine, TAB, TEMPLATE);
    assert.equal(fake.fetched.length, 2);
    assert.equal(listing.complete, false);
    assert.equal(listing.ended, "empty");
    assert.equal(cutShort(listing), true);
  } finally {
    fake.restore();
  }
  // the same empty last page when TikTok counts no more than it sent: the end
  fake = fakeChrome({ pages: { "0": { ...CAPTURE, total: "3" }, "1794351568": { dramaList: [], hasMore: false, statusCode: 0 } } });
  try {
    const listing = await listFavorites(fakeEngine(fake.log).engine, TAB, TEMPLATE);
    assert.equal(listing.complete, true);
    assert.equal(listing.ended, null);
    assert.equal(cutShort(listing), false);
  } finally {
    fake.restore();
  }
  // every favorite TikTok counts sent though the cursor stuck, a card's position reached, the cap: not cut short
  assert.equal(cutShort({ ended: "cursor", total: 3, items: [], skipped: 3 }), false);
  assert.equal(cutShort({ ended: "until", total: 946, items: [], skipped: 0 }), false);
  assert.equal(cutShort({ ended: "cap", total: 946, items: [], skipped: 0 }), false);
  assert.equal(cutShort({ ended: "empty", total: null, items: [], skipped: 0 }), true);
});
