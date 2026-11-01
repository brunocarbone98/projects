// @ts-check
// Unit tests of src/app (the engine, the discovery and the downloader) over fakes: no browser, no
// network, no real sleep. The integration scenarios (tests/integration/test_extension.py) drive the
// same code in a real Chromium against the fake TikTok server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { makeEpisode } from "../src/lib/catalog.js";
import { DRM_MESSAGE, MEDIA_RATE_LIMIT_MESSAGE } from "../src/lib/messages.js";
import { PacingState, pacingOptions } from "../src/lib/pacing.js";
import { newState } from "../src/lib/state.js";
import {
  ChallengeError,
  LoginRequiredError,
  RateLimitedError,
  discoverSeries,
  isLoginUrl,
  looksLikeChallenge,
  queryParam,
  withQueryParams,
} from "../src/app/discovery.js";
import { Downloader, contentLength, sanitizeError } from "../src/app/downloader.js";
import { downloadSeries, runBatch } from "../src/app/engine.js";

const TINY = readFileSync(new URL("../../tests/fixtures/tiny.mp4", import.meta.url));
const SERIES_ID = "7699393770256782354";

/**
 * tiny.mp4 padded with a top-level `free` box to 128 KiB (a real video: >= 64 KiB, 3 s, audio).
 * @returns {Uint8Array}
 */
function video() {
  const size = 128 * 1024;
  const out = new Uint8Array(size);
  out.set(TINY, 0);
  const box = size - TINY.length;
  new DataView(out.buffer).setUint32(TINY.length, box);
  out.set([0x66, 0x72, 0x65, 0x65], TINY.length + 4);
  return out;
}

/** A JPEG-looking cover of 600 bytes (the magic decides; nothing decodes it). */
const COVER = (() => {
  const out = new Uint8Array(600);
  out.set([0xff, 0xd8, 0xff, 0xe0]);
  out.set([0xff, 0xd9], 598);
  return out;
})();

/**
 * @param {number} number
 * @param {{locked?: boolean, urls?: string[], durationS?: number, seriesId?: string}} [options]
 */
function episode(number, options = {}) {
  const urls = options.urls ?? [`https://v16-webapp-prime.tiktok.com/v/${number}.mp4?expire=99999999999`];
  return makeEpisode({
    number,
    itemId: `76994000000000000${String(number).padStart(2, "0")}`,
    title: `Episode ${number}`,
    seriesId: options.seriesId ?? SERIES_ID,
    seriesName: "Test Series",
    durationS: options.durationS ?? 3,
    access: options.locked ? "locked" : "free",
    lockHints: options.locked ? ["no play address"] : [],
    coverUrl: `https://p16-sign-sg.tiktokcdn.com/c/${number}.jpeg`,
    raw: { id: `item${number}`, video: { playAddr: options.locked ? "" : urls } },
  });
}

/** @param {import("../src/lib/catalog.js").Episode[]} episodes */
const series = (episodes, name = "Test Series", seriesId = SERIES_ID) => ({
  seriesId,
  name,
  episodes,
  totalHint: null,
  warnings: [],
});

/**
 * A fake engine: scripted downloads, recorded pauses, an in-memory cooldown and state.
 * @param {{results?: Record<number, string>, testMode?: boolean, pacing?: object, discover?: (ref: import("../src/lib/urls.js").SeriesRef) => Promise<import("../src/lib/catalog.js").Series>}} [options]
 */
function fakeEngine(options = {}) {
  /** @type {{kind: string, seconds: number, text: string}[]} */
  const pauses = [];
  /** @type {number[]} */
  const downloads = [];
  /** @type {Record<string, unknown> | undefined} */
  let cooldown;
  /** @type {Map<string, unknown>} */
  const states = new Map();
  let now = 1_800_000_000;
  const scripted = options.results ?? {};
  const downloader = {
    refreshes: 0,
    existingResult: () => null,
    /** @param {import("../src/lib/catalog.js").Episode} ep */
    needsNetwork: (ep) => ep.access !== "locked",
    /** @param {import("../src/lib/catalog.js").Episode} ep */
    async download(ep) {
      if (ep.access === "locked") return { episode: ep, status: "skipped-locked", path: null, message: "looks locked" };
      downloads.push(ep.number);
      const status = scripted[ep.number] ?? "done";
      const message = status === "failed-rate-limited" ? MEDIA_RATE_LIMIT_MESSAGE : `${status} ${ep.number}`;
      return { episode: ep, status, path: status === "done" ? `/dl/E${ep.number}.mp4` : null, message, downloadId: ep.number };
    },
  };
  /** @type {import("../src/app/engine.js").Engine} */
  const engine = {
    pacing: pacingOptions(/** @type {object} */ (options.pacing ?? {})),
    testMode: options.testMode ?? false,
    includeLocked: false,
    recheck: false,
    pacingState: new PacingState(),
    rng: { uniform: (low) => low },
    sleep: async (seconds) => {
      now += seconds;
    },
    clock: () => now,
    wallClock: () => now,
    cooldownStore: {
      read: () => cooldown,
      write: (record) => {
        cooldown = record;
      },
    },
    discover: options.discover ?? (async () => series([episode(1)])),
    downloader: /** @type {import("../src/app/downloader.js").Downloader} */ (/** @type {unknown} */ (downloader)),
    view: /** @type {import("../src/app/downloader.js").DownloadsView} */ (
      /** @type {unknown} */ ({ exists: () => true, refresh: async () => undefined, completedAt: () => null, remember() {} })
    ),
    readState: async (id) => states.get(id),
    writeState: async (state) => {
      states.set(state.series_id, JSON.parse(JSON.stringify(state)));
    },
    onPause: (kind, seconds, text) => pauses.push({ kind, seconds, text }),
  };
  return {
    engine,
    pauses,
    downloads,
    states,
    getCooldown: () => cooldown,
    /** @param {Record<string, unknown>} record */
    setCooldown: (record) => {
      cooldown = record;
    },
    tick: (/** @type {number} */ seconds) => {
      now += seconds;
    },
  };
}

// ---------------------------------------------------------------------------- engine

test("no pause before a series' first request, then the pace, and the rest every 10", async () => {
  const fake = fakeEngine();
  const episodes = Array.from({ length: 12 }, (_, i) => episode(i + 1));
  const { results, stopped } = await downloadSeries(fake.engine, series(episodes), episodes, newState(SERIES_ID));
  assert.equal(stopped, null);
  assert.deepEqual(results.map((r) => r.status), Array(12).fill("done"));
  assert.deepEqual(
    fake.pauses.map((p) => `${p.kind} ${p.seconds}`),
    [...Array(9).fill("pace 4"), "rest 60", "pace 4"],
  );
  assert.equal(fake.pauses[0]?.text, "pausing 4 s");
  assert.equal(fake.pauses[9]?.text, "resting 60 s after 10 downloads");
});

test("skips never pause, count or reset anything", async () => {
  const fake = fakeEngine();
  const episodes = [episode(1), episode(2, { locked: true }), episode(3, { locked: true }), episode(4)];
  const { results } = await downloadSeries(fake.engine, series(episodes), episodes, newState(SERIES_ID));
  assert.deepEqual(results.map((r) => r.status), ["done", "skipped-locked", "skipped-locked", "done"]);
  assert.deepEqual(fake.pauses.map((p) => p.kind), ["pace"]);
  assert.deepEqual(fake.downloads, [1, 4]);
});

test("a 429 stops the run, records the cooldown once and marks the rest without a request", async () => {
  const fake = fakeEngine({ results: { 2: "failed-rate-limited" } });
  const episodes = [episode(1), episode(2), episode(3), episode(4, { locked: true })];
  const { results, stopped } = await downloadSeries(fake.engine, series(episodes), episodes, newState(SERIES_ID));
  assert.equal(stopped, "episode 2 failed-rate-limited");
  assert.deepEqual(fake.downloads, [1, 2]);
  assert.equal(results[2]?.status, "failed-rate-limited");
  assert.equal(results[2]?.message, `stopped: episode 2 failed-rate-limited: ${MEDIA_RATE_LIMIT_MESSAGE}`);
  assert.equal(results[3]?.status, "skipped-locked"); // the skip it would have had anyway
  const cooldown = /** @type {Record<string, unknown>} */ (fake.getCooldown());
  assert.equal(cooldown["source"], "browser");
  assert.equal(cooldown["reason"], MEDIA_RATE_LIMIT_MESSAGE);
});

test("three failures in a row stop the run, across the series of a run", async () => {
  const fake = fakeEngine({ results: { 1: "failed", 2: "failed-unavailable" } });
  const first = [episode(1), episode(2)];
  const a = await downloadSeries(fake.engine, series(first), first, newState(SERIES_ID));
  assert.equal(a.stopped, null);
  assert.equal(fake.engine.pacingState.consecutiveFailures, 2);
  const other = series([episode(1), episode(2)], "Other", "7699393770256782399");
  const b = await downloadSeries(
    { ...fake.engine, downloader: /** @type {never} */ ({ ...fake.engine.downloader, download: async (/** @type {never} */ ep) => ({ episode: ep, status: "failed", path: null, message: "boom" }) }) },
    other,
    other.episodes,
    newState(other.seriesId),
  );
  assert.equal(b.stopped, "3 consecutive failures");
  assert.equal(b.results[1]?.message, "stopped: 3 consecutive failures (last: boom)");
  assert.equal(fake.engine.pacingState.consecutiveFailures, 0); // the stop has been acted on
});

test("a cooldown recorded meanwhile stops the run right before the next request", async () => {
  const fake = fakeEngine();
  const episodes = [episode(1), episode(2), episode(3)];
  const original = fake.engine.downloader.download.bind(fake.engine.downloader);
  fake.engine.downloader.download = async (ep, context) => {
    const result = await original(ep, context);
    fake.setCooldown({ until: fake.engine.wallClock() + 1800, reason: "elsewhere", source: "web", recorded_at: fake.engine.wallClock() });
    return result;
  };
  const { results, stopped } = await downloadSeries(fake.engine, series(episodes), episodes, newState(SERIES_ID));
  assert.match(String(stopped), /^cooldown until \d\d:\d\d$/);
  assert.deepEqual(fake.downloads, [1]);
  assert.deepEqual(results.slice(1).map((r) => r.status), ["failed-rate-limited", "failed-rate-limited"]);
  assert.equal(results[1]?.message, `stopped: ${stopped}`);
});

test("the long break comes every longRestEvery attempts of the run; a shorter break only in test mode", async () => {
  const fake = fakeEngine({ testMode: true, pacing: { longRestEvery: 3, longRestMinS: 900, longRestMaxS: 1800 } });
  const episodes = Array.from({ length: 5 }, (_, i) => episode(i + 1));
  await downloadSeries(fake.engine, series(episodes), episodes, newState(SERIES_ID));
  assert.deepEqual(fake.pauses.map((p) => p.kind), ["pace", "pace", "long-rest", "pace"]);
  assert.equal(fake.pauses[2]?.text, "long break 15 min after 3 episodes");
  // more often is allowed anywhere; a shorter break only in the test copy of the extension
  const normal = fakeEngine({ pacing: { longRestEvery: 3, longRestMinS: 60, longRestMaxS: 120 } });
  await assert.rejects(downloadSeries(normal.engine, series(episodes), episodes, newState(SERIES_ID)), /long_rest_min_s/);
});

test("a batch: series one after the other, the series rest between them, not started after a stop", async () => {
  const lists = {
    "7699393770256782354": series([episode(1), episode(2)], "One"),
    "7699393770256782399": series([episode(1, { seriesId: "7699393770256782399" })], "Two", "7699393770256782399"),
    "7699393770256782388": series([episode(1, { seriesId: "7699393770256782388" })], "Three", "7699393770256782388"),
  };
  /** @type {string[]} */
  const resolved = [];
  const fake = fakeEngine({
    discover: async (ref) => {
      resolved.push(ref.seriesId);
      return /** @type {never} */ (lists)[ref.seriesId];
    },
  });
  const original = fake.engine.downloader.download.bind(fake.engine.downloader);
  fake.engine.downloader.download = async (ep, context) =>
    ep.seriesId === "7699393770256782399" ? { episode: ep, status: "failed-blocked", path: null, message: "blocked" } : original(ep, context);
  const refs = Object.keys(lists).map((seriesId) => ({ kind: /** @type {const} */ ("series"), seriesId, episodeHint: null, sourceUrl: seriesId }));
  const runs = await runBatch(fake.engine, refs);
  assert.deepEqual(resolved, ["7699393770256782354", "7699393770256782399"]); // never all up front
  assert.equal(runs[0]?.report.complete, true);
  assert.equal(runs[1]?.stop, true);
  assert.equal(runs[2]?.error, "not started: batch stopped in Two (episode 1 failed-blocked)");
  assert.deepEqual(fake.pauses.map((p) => p.kind), ["pace", "series-rest"]);
  assert.equal(fake.pauses[1]?.text, "resting 60 s before the next series");
  // the complete skip on a second batch: no resolve, no pause for that series
  resolved.length = 0;
  fake.setCooldown({});
  const again = await runBatch(fake.engine, refs.slice(0, 1));
  assert.deepEqual(resolved, []);
  assert.equal(again[0]?.report.skippedComplete, true);
});

// ------------------------------------------------------------------------- discovery

test("the query is rewritten in place, every other parameter byte for byte", () => {
  const template = "https://www.tiktok.com/api/drama/episode/item_list/?dramaID=1&cursor=0&count=10&X-Bogus=a%2Fb&msToken=x";
  assert.equal(
    withQueryParams(template, { cursor: "30", count: "30" }),
    "https://www.tiktok.com/api/drama/episode/item_list/?dramaID=1&cursor=30&count=30&X-Bogus=a%2Fb&msToken=x",
  );
  assert.equal(withQueryParams("https://h/p?a=1", { cursor: "a b/c" }), "https://h/p?a=1&cursor=a%20b%2Fc");
  assert.equal(withQueryParams("https://h/p", { count: "30" }), "https://h/p?count=30");
  assert.equal(queryParam(template, "cursor"), "0");
  assert.equal(queryParam(template, "missing"), null);
  assert.equal(isLoginUrl("https://www.tiktok.com/login?redirect_url=/x"), true);
  assert.equal(isLoginUrl("https://www.tiktok.com/login/"), true);
  assert.equal(isLoginUrl("https://www.tiktok.com/shortdrama/episode/1/1"), false);
  assert.equal(looksLikeChallenge("Security check\nVerify to continue"), true);
  assert.equal(looksLikeChallenge("Episode 1"), false);
});

/**
 * A fake tab: the page's own list request URL, then scripted answers to the in-page fetches.
 * @param {{answers: unknown[], tabUrl?: string, pageText?: string, observe?: boolean}} script
 */
function fakeBrowser(script) {
  /** @type {string[]} */
  const fetched = [];
  const calls = { closed: 0, activated: 0 };
  /** @type {import("../src/app/discovery.js").DiscoveryBrowser} */
  const browser = {
    openTab: async () => 7,
    navigate: async () => undefined,
    tabUrl: async () => script.tabUrl ?? "https://www.tiktok.com/shortdrama/episode/1/1",
    activate: async () => {
      calls.activated += 1;
    },
    closeTab: async () => {
      calls.closed += 1;
    },
    observe: (_tab, _urls, handlers) => {
      if (script.observe !== false) {
        queueMicrotask(() => {
          handlers.completed({ url: "https://www.tiktok.com/api/drama/detail/?dramaID=1&sig=s", status: 200 });
          handlers.completed({ url: "https://www.tiktok.com/api/drama/episode/item_list/?dramaID=1&cursor=0&count=10&sig=s", status: 200 });
        });
      }
      return () => undefined;
    },
    fetchInTab: async (_tab, url) => {
      fetched.push(url);
      return script.answers.shift();
    },
    scrollTab: async () => null,
    pageText: async () => script.pageText ?? "Episode list",
  };
  return { browser, fetched, calls };
}

/** @param {number} number @param {boolean} more @param {number | null} cursor */
const page = (number, more, cursor) => ({
  itemList: [{ id: `i${number}`, dramaInfo: { dramaID: "1", dramaName: "Fake", DramaVideoData: { EpisodeNumber: number } }, video: { playAddr: "https://v16.tiktok.com/x.mp4", duration: 3 } }],
  hasMore: more,
  cursor,
});

test("discovery: every page fetched from inside the page, a pause before each, the tab closed", async () => {
  const { browser, fetched, calls } = fakeBrowser({
    answers: [page(1, true, 1), page(2, false, 2), { dramaInfo: { dramaName: "Fake Drama", totalEpisode: 2 } }],
  });
  /** @type {number[]} */
  const sleeps = [];
  const found = await discoverSeries(
    { kind: "series", seriesId: "1", episodeHint: null, sourceUrl: "1" },
    { browser, sleep: async (s) => void sleeps.push(s), rng: { uniform: (low) => low }, clock: () => sleeps.length },
  );
  assert.deepEqual(found.episodes.map((e) => e.number), [1, 2]);
  assert.equal(found.name, "Fake Drama");
  assert.equal(found.totalHint, 2);
  assert.deepEqual(fetched, [
    "https://www.tiktok.com/api/drama/episode/item_list/?dramaID=1&cursor=0&count=30&sig=s",
    "https://www.tiktok.com/api/drama/episode/item_list/?dramaID=1&cursor=1&count=30&sig=s",
    "https://www.tiktok.com/api/drama/detail/?dramaID=1&sig=s",
  ]);
  assert.equal(sleeps.filter((s) => s === 0.8).length, 3); // 0.8 s x uniform(1, 2) before each fetch
  assert.equal(calls.closed, 1);
});

test("discovery stops at a 429, a login redirect or a captcha, and always closes its tab", async () => {
  const options = { sleep: async () => undefined, rng: { uniform: (/** @type {number} */ low) => low } };
  const ref = { kind: /** @type {const} */ ("series"), seriesId: "1", episodeHint: null, sourceUrl: "1" };
  const limited = fakeBrowser({ answers: [{ __dramafetch_status: 429, __dramafetch_text: "" }] });
  await assert.rejects(discoverSeries(ref, { ...options, browser: limited.browser }), RateLimitedError);
  assert.equal(limited.calls.closed, 1);
  const login = fakeBrowser({ answers: [], observe: false, tabUrl: "https://www.tiktok.com/login?x=1" });
  await assert.rejects(discoverSeries(ref, { ...options, browser: login.browser }), LoginRequiredError);
  assert.equal(login.calls.closed, 1);
  const captcha = fakeBrowser({ answers: [], observe: false, pageText: "Verify to continue" });
  await assert.rejects(discoverSeries(ref, { ...options, browser: captcha.browser }), ChallengeError);
  assert.equal(captcha.calls.closed, 1);
});

// ------------------------------------------------------------------------ downloader

/**
 * @param {Record<string, () => Response>} routes
 * @param {string[]} log
 * @returns {typeof fetch}
 */
function fakeFetch(routes, log) {
  return /** @type {typeof fetch} */ (
    async (input) => {
      const url = String(input);
      log.push(url);
      const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      if (route === undefined) throw new TypeError("Failed to fetch");
      return route[1]();
    }
  );
}

/** @param {{fetch: typeof fetch, saved?: string[], thumbnail?: string}} options */
function downloader(options) {
  /** @type {string[]} */
  const saved = options.saved ?? [];
  let id = 0;
  return new Downloader({
    quality: "compatible",
    thumbnail: options.thumbnail ?? "embed",
    nameFormat: "{series} - Episode {number}",
    includeLocked: false,
    hostPatterns: ["https://*.tiktok.com/*", "https://*.tiktokcdn.com/*"],
    view: /** @type {never} */ ({ completedAt: () => null, remember() {} }),
    rediscover: async () => {
      throw new Error("no rediscovery expected");
    },
    fetch: options.fetch,
    save: async (_bytes, _mime, filename) => {
      saved.push(filename);
      id += 1;
      return /** @type {never} */ ({ id, filename: `/home/me/Downloads/${filename}`, state: "complete", exists: true });
    },
  });
}

const CONTEXT = { seriesName: "Test Series", folder: `Test Series [${SERIES_ID}]` };

test("download: verified bytes, one cover GET, the cover embedded, saved under its name", async () => {
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} */
  const saved = [];
  const subject = downloader({
    saved,
    fetch: fakeFetch(
      {
        "https://v16-webapp-prime.tiktok.com/": () => new Response(video(), { headers: { "content-type": "video/mp4", "content-length": String(128 * 1024) } }),
        "https://p16-sign-sg.tiktokcdn.com/": () => new Response(COVER, { headers: { "content-type": "image/jpeg" } }),
      },
      log,
    ),
  });
  const result = await subject.download(episode(1), CONTEXT);
  assert.equal(result.status, "done");
  assert.equal(result.message, "saved Test Series - Episode 01.mp4 (0.1 MiB) + cover embedded");
  assert.deepEqual(saved, [`DramaFetch/Test Series [${SERIES_ID}]/Test Series - Episode 01.mp4`]);
  assert.equal(log.length, 2);
});

test("download: 403 moves on, at most 4 media GETs, a host outside the manifest never requested", async () => {
  /** @type {string[]} */
  const log = [];
  const urls = ["https://evil.example.com/a.mp4", ...[1, 2, 3, 4, 5].map((n) => `https://v${n}.tiktok.com/v.mp4`)];
  const subject = downloader({ fetch: fakeFetch({ "https://v": () => new Response("no", { status: 403 }) }, log) });
  subject.config.rediscover = async () => series([]);
  const result = await subject.download(episode(1, { urls }), CONTEXT);
  assert.equal(result.status, "failed-unavailable");
  assert.equal(log.length, 4);
  assert.ok(!log.some((url) => url.includes("example.com")));
  assert.equal(result.message, "no playable stream: locked, region-restricted or not logged in (HTTP 403 from v4.tiktok.com)");
});

test("download: a 429 is a stop, a truncated body fails with no next mirror, DRM is never saved", async () => {
  const urls = ["https://v1.tiktok.com/v.mp4", "https://v2.tiktok.com/v.mp4"];
  /** @type {string[]} */
  const log = [];
  const limited = downloader({ fetch: fakeFetch({ "https://v": () => new Response("{}", { status: 429 }) }, log) });
  const rate = await limited.download(episode(1, { urls }), CONTEXT);
  assert.equal(rate.status, "failed-rate-limited");
  assert.equal(rate.message, MEDIA_RATE_LIMIT_MESSAGE);
  assert.equal(log.length, 1);

  log.length = 0;
  const cut = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(video().subarray(0, 1000));
          controller.error(new TypeError("network error"));
        },
      }),
      { headers: { "content-type": "video/mp4", "content-length": String(128 * 1024) } },
    );
  const truncated = await downloader({ fetch: fakeFetch({ "https://v": cut }, log) }).download(episode(2, { urls }), CONTEXT);
  assert.equal(truncated.status, "failed");
  assert.equal(truncated.message, "download looks incomplete or wrong: truncated body (the transfer was cut short) from v1.tiktok.com");
  assert.equal(log.length, 1);

  log.length = 0;
  const short = () => new Response(video().subarray(0, 100_000), { headers: { "content-type": "video/mp4", "content-length": String(128 * 1024) } });
  const shorter = await downloader({ fetch: fakeFetch({ "https://v": short }, log) }).download(episode(3, { urls }), CONTEXT);
  assert.equal(shorter.message, `download looks incomplete or wrong: truncated body (100000 of ${128 * 1024} bytes) from v1.tiktok.com`);

  // an encrypted body: an `encv` sample entry where tiny.mp4 has `avc1`
  const encrypted = video();
  const text = new TextDecoder("latin1").decode(encrypted);
  const at = text.indexOf("avc1", text.indexOf("stsd")); // the sample entry, not the ftyp brand
  assert.ok(at > 0);
  encrypted.set([0x65, 0x6e, 0x63, 0x76], at);
  /** @type {string[]} */
  const saved = [];
  log.length = 0;
  const drm = await downloader({
    saved,
    fetch: fakeFetch({ "https://v": () => new Response(encrypted.slice(), { headers: { "content-type": "video/mp4" } }) }, log),
  }).download(episode(4, { urls }), CONTEXT);
  assert.equal(drm.status, "failed-unavailable");
  assert.equal(drm.message, DRM_MESSAGE);
  assert.deepEqual(saved, []);
  assert.equal(log.length, 1); // no other mirror, no cover
});

test("download: a video far shorter than listed is never saved", async () => {
  /** @type {string[]} */
  const saved = [];
  const subject = downloader({
    saved,
    fetch: fakeFetch({ "https://v16": () => new Response(video(), { headers: { "content-type": "video/mp4" } }) }, []),
  });
  const result = await subject.download(episode(1, { durationS: 92 }), CONTEXT);
  assert.equal(result.status, "failed");
  assert.equal(result.message, "download looks incomplete or wrong: duration 3 s, expected 92 s");
  assert.deepEqual(saved, []);
});

test("Content-Length counts only for identity-encoded bodies; messages carry no URL query or token", () => {
  const headers = (/** @type {Record<string, string>} */ values) => new Headers(values);
  assert.equal(contentLength(headers({ "content-length": "12" })), 12);
  assert.equal(contentLength(headers({ "content-length": "12", "content-encoding": "gzip" })), null);
  assert.equal(contentLength(headers({ "content-length": "x" })), null);
  assert.equal(
    sanitizeError("failed https://v16.tiktok.com/x.mp4?expire=1&sig=abc sessionid=SECRET\nmore"),
    "failed https://v16.tiktok.com/x.mp4 sessionid=<redacted>",
  );
});
