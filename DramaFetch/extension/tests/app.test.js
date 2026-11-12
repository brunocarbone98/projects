// @ts-check
// Unit tests of src/app (the engine, the discovery, the downloader and, at the end, the page itself
// over a fake document) over fakes: no browser, no network, no real sleep. The integration scenarios
// (tests/integration/test_extension.py) drive the same code in a real Chromium against the fake
// TikTok server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { makeEpisode } from "../src/lib/catalog.js";
import { clearCooldown, recordBlock } from "../src/lib/cooldown.js";
import { CUT_SHORT_CAUSE_PREFIX, DRM_CAUSE, LOCKED_CAUSE_PREFIX, NOT_ATTEMPTED_CAUSE } from "../src/lib/diagnosis.js";
import { DRM_MESSAGE, MEDIA_RATE_LIMIT_MESSAGE, shortServedMessage } from "../src/lib/messages.js";
import { PacingState, pacingOptions } from "../src/lib/pacing.js";
import { completeSkip, seriesReport } from "../src/lib/report.js";
import { donePath, markComplete, missingFiles, newState, record } from "../src/lib/state.js";
import {
  ChallengeError,
  DISCOVERY_TAB_KEY,
  LoginRequiredError,
  RateLimitedError,
  chromeBrowser,
  closeLeftoverDiscoveryTab,
  discoverSeries,
  isLoginUrl,
  looksLikeChallenge,
  queryParam,
  withQueryParams,
} from "../src/app/discovery.js";
import {
  ATTEMPT_ENCRYPTED,
  ATTEMPT_NOT_REQUESTED,
  ATTEMPT_SAVED,
  CoverLoader,
  DownloadsView,
  Downloader,
  ATTEMPT_SHORT_HEADER_PREFIX,
  contentLength,
  sanitizeError,
  servedShort,
} from "../src/app/downloader.js";
import { STORAGE_REFUSED_PREFIX, StorageRefusedError, downloadSeries, runBatch, runSelectionJob } from "../src/app/engine.js";
import { historyEntry as storedHistoryEntry } from "../src/app/storage.js";
import { TabKeeper } from "../src/app/tabkeeper.js";

const TINY = readFileSync(new URL("../../tests/fixtures/tiny.mp4", import.meta.url));
const SERIES_ID = "7699393770256782354";
/** What Chrome 153 rejects a `chrome.storage.local.set` with when the disk under its profile is full. */
const REFUSED = "IO error: .../000003.log: FILE_ERROR_NO_SPACE (ChromeMethodBFE: 3::WritableFileAppend::8)";
/** The stop of a run whose progress the storage refused. */
const UNSAVED = `${STORAGE_REFUSED_PREFIX}${REFUSED}`;

/**
 * tiny.mp4 padded with a top-level `free` box to 128 KiB (a real video: >= 64 KiB, 3 s, audio).
 * @returns {Uint8Array<ArrayBuffer>}
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
 * `stateWrites`: how many state writes the storage accepts before it refuses every further one
 * ({@link REFUSED}, as `chrome.storage.local` rejects them).
 * @param {{results?: Record<number, string>, testMode?: boolean, pacing?: object, stateWrites?: number, discover?: (ref: import("../src/lib/urls.js").SeriesRef) => Promise<import("../src/lib/catalog.js").Series>}} [options]
 */
function fakeEngine(options = {}) {
  /** @type {{kind: string, seconds: number, text: string}[]} */
  const pauses = [];
  /** @type {number[]} */
  const downloads = [];
  /** @type {import("../src/lib/report.js").DownloadResult[]} the rows as the page gets them (`onResult`) */
  const shown = [];
  let writesLeft = options.stateWrites ?? Number.POSITIVE_INFINITY;
  let refusedWrites = 0;
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
      if (writesLeft <= 0) {
        refusedWrites += 1;
        throw new Error(REFUSED);
      }
      writesLeft -= 1;
      states.set(state.series_id, JSON.parse(JSON.stringify(state)));
    },
    onPause: (kind, seconds, text) => pauses.push({ kind, seconds, text }),
    onResult: (result) => shown.push(result),
  };
  return {
    engine,
    pauses,
    downloads,
    shown,
    refusedWrites: () => refusedWrites,
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

// ------------------------------------------------- a write chrome.storage.local refuses

test("a refused state write: the saved episode keeps its row and counts, the rest is stopped with no request and no further write", async () => {
  const fake = fakeEngine({ stateWrites: 2 });
  const episodes = [episode(1), episode(2), episode(3), episode(4, { locked: true }), episode(5)];
  const { results, stopped } = await downloadSeries(fake.engine, series(episodes), episodes, newState(SERIES_ID));
  assert.equal(UNSAVED, `the progress could not be saved: ${REFUSED}`);
  assert.equal(stopped, UNSAVED);
  assert.deepEqual(fake.downloads, [1, 2, 3]); // E03 was saved before its write was refused; nothing after it is asked for
  assert.deepEqual(results.map((r) => r.status), ["done", "done", "done", "skipped-locked", "failed"]);
  assert.equal(results[2]?.message, "done 3"); // the saved episode keeps its own row
  assert.match(String(results[3]?.message), /^looks locked/); // the skip it would have had anyway
  assert.equal(results[4]?.message, `stopped: ${UNSAVED}`);
  assert.deepEqual(fake.shown.map((r) => r.episode.number), [1, 2, 3, 4, 5]); // every row reached the page, E03's too
  assert.equal(fake.engine.pacingState.runAttempts, 3); // E03's request counts toward the rest and the long break
  assert.equal(fake.engine.pacingState.lastNetworkAt, fake.engine.clock());
  assert.equal(fake.engine.pacingState.consecutiveFailures, 0);
  assert.deepEqual(fake.pauses.map((p) => p.kind), ["pace", "pace"]); // no pause for a request that is never made
  assert.equal(fake.refusedWrites(), 1); // one refused write, not one per remaining row
  const stored = /** @type {{episodes: Record<string, unknown>}} */ (fake.states.get(SERIES_ID));
  assert.deepEqual(Object.keys(stored.episodes), ["1", "2"]); // E03's file is found on disk by the next run
});

test("a 429 whose state write is refused is still the stop, with its cooldown and its count", async () => {
  const fake = fakeEngine({ stateWrites: 1, results: { 2: "failed-rate-limited" } });
  const episodes = [episode(1), episode(2), episode(3)];
  const { results, stopped } = await downloadSeries(fake.engine, series(episodes), episodes, newState(SERIES_ID));
  assert.equal(stopped, "episode 2 failed-rate-limited");
  assert.deepEqual(fake.downloads, [1, 2]);
  const cooldown = /** @type {Record<string, unknown>} */ (fake.getCooldown());
  assert.equal(cooldown["reason"], MEDIA_RATE_LIMIT_MESSAGE); // recorded although the state was not
  assert.equal(cooldown["until"], fake.engine.wallClock() + 1800);
  assert.equal(fake.engine.pacingState.runAttempts, 2);
  assert.equal(results[2]?.status, "failed-rate-limited");
  assert.equal(results[2]?.message, `stopped: episode 2 failed-rate-limited: ${MEDIA_RATE_LIMIT_MESSAGE}`);
  assert.equal(fake.refusedWrites(), 1);
});

test("a batch ends at a refused write — at a series' last result or at its complete mark: the next series is never listed", async () => {
  const lists = {
    [SERIES_ID]: series([episode(1), episode(2)], "One"),
    "7699393770256782399": series([episode(1, { seriesId: "7699393770256782399" })], "Two", "7699393770256782399"),
  };
  const refs = Object.keys(lists).map((seriesId) => ({ kind: /** @type {const} */ ("series"), seriesId, episodeHint: null, sourceUrl: seriesId }));
  // E01 stored, E02 (the last result) refused — then both stored and the complete mark refused
  for (const stateWrites of [1, 2]) {
    /** @type {string[]} */
    const resolved = [];
    const fake = fakeEngine({
      stateWrites,
      discover: async (ref) => {
        resolved.push(ref.seriesId);
        return /** @type {never} */ (lists)[ref.seriesId];
      },
    });
    const runs = await runBatch(fake.engine, refs);
    assert.deepEqual(resolved, [SERIES_ID], `${stateWrites} writes`); // the second series is never listed
    assert.deepEqual(fake.downloads, [1, 2]);
    assert.deepEqual(runs[0]?.results.map((r) => r.status), ["done", "done"]);
    assert.equal(runs[0]?.stop, true);
    assert.equal(runs[0]?.report.stopped, UNSAVED);
    assert.equal(runs[0]?.report.complete, true); // every file is on disk; what is missing is the memory of it
    const stored = /** @type {{episodes: Record<string, unknown>, complete_at?: string | null}} */ (fake.states.get(SERIES_ID));
    assert.equal(Object.keys(stored.episodes).length, stateWrites);
    assert.equal(stored.complete_at ?? null, null); // no complete mark stored: the next run lists the series and finds its files
    assert.equal(runs[1]?.error, `not started: batch stopped in One (${UNSAVED})`);
    assert.equal(runs[1]?.errorKind, "not-started");
    assert.equal(fake.refusedWrites(), 1);
    assert.deepEqual(fake.pauses.map((p) => p.kind), ["pace"]); // and no rest before a series that never starts
  }
});

test("a write the page was refused (the pacing): the run stops before its next request, and no series is listed while it holds", async () => {
  // the page's memory of a refused write: here a variable the fake `persist` sets from its third save on
  /** @type {string | null} */
  let unsaved = null;
  let persists = 0;
  const fake = fakeEngine();
  fake.engine.unsaved = () => unsaved;
  fake.engine.persist = async () => {
    persists += 1;
    if (persists >= 3) unsaved = unsaved ?? UNSAVED;
  };
  const episodes = [episode(1), episode(2), episode(3), episode(4)];
  const { results, stopped } = await downloadSeries(fake.engine, series(episodes), episodes, newState(SERIES_ID));
  // the saves: after E01's attempt, after E02's pause, after E02's attempt (refused) — E03 is never asked for
  assert.deepEqual(fake.downloads, [1, 2]);
  assert.deepEqual(fake.pauses.map((p) => p.kind), ["pace"]); // and no pause once the refusal is known
  assert.equal(stopped, UNSAVED);
  assert.deepEqual(results.map((r) => r.status), ["done", "done", "failed", "failed"]);
  assert.equal(results[2]?.message, `stopped: ${UNSAVED}`);
  assert.equal(fake.refusedWrites(), 0); // no state write was refused: the page's refusal alone stops the run
  const stored = /** @type {{episodes: Record<string, unknown>}} */ (fake.states.get(SERIES_ID));
  assert.deepEqual(Object.keys(stored.episodes), ["1", "2"]); // nothing is written after it
  // refused during a pause: the save after E01's attempt is stored, the one at E02's pause refused —
  // the request that pause was for is not made
  unsaved = null;
  persists = 0;
  const paused = fakeEngine();
  paused.engine.unsaved = () => unsaved;
  paused.engine.persist = async () => {
    persists += 1;
    if (persists >= 2) unsaved = unsaved ?? UNSAVED;
  };
  const during = await downloadSeries(paused.engine, series(episodes), episodes, newState(SERIES_ID));
  assert.deepEqual(paused.downloads, [1]);
  assert.deepEqual(paused.pauses.map((p) => p.kind), ["pace"]); // the pause was taken, its request was not made
  assert.equal(persists, 2);
  assert.equal(during.stopped, UNSAVED);
  assert.deepEqual(during.results.map((r) => r.status), ["done", "failed", "failed", "failed"]);
  // a batch and a selection started while it holds: asked before the listing, no request at all
  /** @type {string[]} */
  const resolved = [];
  const later = fakeEngine({
    discover: async (ref) => {
      resolved.push(ref.seriesId);
      return series([episode(1)]);
    },
  });
  let asked = 0;
  later.engine.unsaved = () => unsaved;
  later.engine.persist = async () => {
    asked += 1;
  };
  const refs = [SERIES_ID, "7699393770256782399"].map((seriesId) => ({ kind: /** @type {const} */ ("series"), seriesId, episodeHint: null, sourceUrl: seriesId }));
  const runs = await runBatch(later.engine, refs);
  assert.deepEqual(resolved, []);
  assert.deepEqual(later.downloads, []);
  assert.equal(asked, 1); // the question is one save of the pacing, asked once: the second series is not started
  assert.equal(runs[0]?.error, UNSAVED);
  assert.equal(runs[0]?.report.stopped, UNSAVED);
  assert.equal(runs[0]?.errorKind, "storage");
  assert.equal(runs[0]?.stop, true);
  assert.equal(runs[0]?.contacted, false);
  assert.equal(runs[1]?.error, `not started: batch stopped in ${SERIES_ID} (${UNSAVED})`);
  const selection = await runSelectionJob(later.engine, /** @type {never} */ (refs[0]), [1], { lastContactAt: null });
  assert.deepEqual(resolved, []);
  assert.equal(selection.errorKind, "storage");
  assert.equal(selection.contacted, false);
  // a series found complete still costs nothing: no save, no request
  unsaved = null;
  const complete = fakeEngine({ discover: later.engine.discover });
  await runBatch(complete.engine, refs.slice(0, 1));
  resolved.length = 0;
  asked = 0;
  unsaved = UNSAVED;
  complete.engine.unsaved = () => unsaved;
  complete.engine.persist = later.engine.persist;
  const again = await runBatch(complete.engine, refs.slice(0, 1));
  assert.equal(again[0]?.report.skippedComplete, true);
  assert.deepEqual(resolved, []);
  assert.equal(asked, 0);
});

test("a listing refused because nothing could be stored is a storage stop, never a request; a re-discovery refused so fails its episode with no further URL", async () => {
  // the page's listing throws StorageRefusedError when its save right before was refused
  /** @type {string[]} */
  const resolved = [];
  const fake = fakeEngine({
    discover: async (ref) => {
      resolved.push(ref.seriesId);
      throw new StorageRefusedError(UNSAVED);
    },
  });
  const refs = [SERIES_ID, OTHER_ID].map((seriesId) => ({ kind: /** @type {const} */ ("series"), seriesId, episodeHint: null, sourceUrl: seriesId }));
  const runs = await runBatch(fake.engine, refs);
  assert.deepEqual(resolved, [SERIES_ID]);
  assert.deepEqual(fake.downloads, []);
  assert.equal(runs[0]?.errorKind, "storage");
  assert.equal(runs[0]?.error, UNSAVED);
  assert.equal(runs[0]?.report.stopped, UNSAVED); // not "the episode list could not be fetched"
  assert.equal(runs[1]?.error, `not started: batch stopped in ${SERIES_ID} (${UNSAVED})`);
  const selection = await runSelectionJob(fake.engine, /** @type {never} */ (refs[1]), [1], { lastContactAt: null });
  assert.equal(selection.errorKind, "storage");
  assert.deepEqual(fake.downloads, []);
  // inside a run: the episode's URL is refused (403), the fresh list it would need is refused for storage — no other URL is tried
  /** @type {string[]} */
  const log = [];
  let listings = 0;
  const subject = new Downloader({
    quality: "compatible",
    thumbnail: "none",
    nameFormat: "{series} - Episode {number}",
    includeLocked: false,
    hostPatterns: ["https://*.tiktok.com/*", "https://*.tiktokcdn.com/*"],
    view: /** @type {never} */ ({ completedAt: () => null, remember() {} }),
    rediscover: async () => {
      listings += 1;
      throw new StorageRefusedError(UNSAVED);
    },
    fetch: fakeFetch({ "https://v1.tiktok.com/": () => new Response("", { status: 403 }) }, log),
    redirects: null,
    save: async () => {
      throw new Error("nothing is saved");
    },
  });
  const refused = episode(1, { urls: ["https://v1.tiktok.com/a.mp4"] });
  const result = await subject.download(refused, CONTEXT);
  assert.equal(result.status, "failed");
  assert.equal(result.message, `HTTP 403 from v1.tiktok.com; refreshing the episode list failed: ${UNSAVED}`);
  assert.deepEqual(log, ["https://v1.tiktok.com/a.mp4"]);
  assert.equal(listings, 1);
  // the report says no fresh list was fetched: none was, no request went out for it
  assert.equal(subject.refreshes, 0);
  assert.deepEqual(subject.traceOf(refused)?.refreshes.map((record) => [record.outcome, record.fresh_list]), [["failed", false]]);
  // an episode with no usable URL needs the fresh list before any request: refused, it is the run's storage stop, not a result
  // (another series: this one's re-discovery already failed in this run and is not asked again)
  const unlisted = episode(2, { urls: [], seriesId: OTHER_ID });
  await assert.rejects(subject.download(unlisted, CONTEXT), (error) => error instanceof StorageRefusedError && error.message === UNSAVED);
  assert.deepEqual(log, ["https://v1.tiktok.com/a.mp4"]); // nothing more requested
  // in a run: that episode and the rest read `stopped: <the storage reason>`, the run stops on it — not on a failure streak — and no attempt is counted
  const run = fakeEngine({ results: { 1: "failed", 2: "failed" } });
  const scripted = run.engine.downloader.download.bind(run.engine.downloader);
  Object.assign(run.engine.downloader, {
    /** @param {import("../src/lib/catalog.js").Episode} ep @param {import("../src/app/downloader.js").EpisodeContext} context */
    download: async (ep, context) => {
      if (ep.number === 3) throw new StorageRefusedError(UNSAVED);
      return scripted(ep, context);
    },
  });
  const listed = series([episode(1), episode(2), episode(3), episode(4)]);
  const { results, stopped } = await downloadSeries(run.engine, listed, listed.episodes, newState(SERIES_ID, "One"));
  assert.deepEqual(results.map((result) => [result.episode.number, result.status, result.message]), [
    [1, "failed", "failed 1"],
    [2, "failed", "failed 2"],
    [3, "failed", `stopped: ${UNSAVED}`],
    [4, "failed", `stopped: ${UNSAVED}`],
  ]);
  assert.equal(stopped, UNSAVED);
  assert.equal(run.engine.pacingState.runAttempts, 2); // E3 asked nothing
  assert.deepEqual(run.downloads, [1, 2]);
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
    "https://www.tiktok.com/api/drama/episode/item_list/?dramaID=1&cursor=0&count=10&sig=s", // the page's own request, byte for byte
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

/** @param {{fetch: typeof fetch, saved?: string[], thumbnail?: string, view?: DownloadsView}} options */
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
    view: options.view ?? /** @type {never} */ ({ completedAt: () => null, remember() {} }),
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

test("download: 403 moves on, at most 4 URLs per episode; a host outside the manifest counts, never requested", async () => {
  /** @type {string[]} */
  const log = [];
  const urls = [1, 2, 3, 4, 5].map((n) => `https://v${n}.tiktok.com/v.mp4`);
  const subject = downloader({ fetch: fakeFetch({ "https://v": () => new Response("no", { status: 403 }) }, log) });
  subject.config.rediscover = async () => series([]);
  const result = await subject.download(episode(1, { urls }), CONTEXT);
  assert.equal(result.status, "failed-unavailable");
  assert.deepEqual(log, urls.slice(0, 4)); // the fifth never
  assert.equal(result.message, "no playable stream: locked, region-restricted or not logged in (HTTP 403 from v4.tiktok.com)");

  // a URL whose host the manifest does not cover is never requested, yet takes its place in the
  // budget like any URL Python's `tried` holds: three TikTok GETs after it, as Python makes
  log.length = 0;
  const first = await subject.download(episode(2, { urls: ["https://evil.example.com/a.mp4", ...urls] }), CONTEXT);
  assert.equal(first.status, "failed-unavailable");
  assert.deepEqual(log, urls.slice(0, 3));
  assert.ok(!log.some((url) => url.includes("example.com")));
  assert.equal(first.message, "no playable stream: locked, region-restricted or not logged in (HTTP 403 from v3.tiktok.com)");
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

test("download: the whole file by the list's size with a header that plays less is short-served — failed-unavailable, nothing saved", async () => {
  const size = 128 * 1024; // what video() is
  /** @param {number} listed the size the list announces */
  const listed = (listed, dataSize = listed) => {
    const ep = episode(1, { durationS: 92 });
    ep.raw = { id: "item1", video: { playAddr: ep.raw?.["video"] && /** @type {Record<string, unknown>} */ (ep.raw["video"])["playAddr"], size: listed, bitrateInfo: [{ PlayAddr: { DataSize: dataSize } }] } };
    return ep;
  };
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} */
  const saved = [];
  const subject = downloader({
    saved,
    fetch: fakeFetch(
      {
        "https://v16": () => new Response(video(), { headers: { "content-type": "video/mp4", "content-length": String(size) } }),
        "https://p16-sign-sg.tiktokcdn.com/": () => new Response(COVER, { headers: { "content-type": "image/jpeg" } }),
      },
      log,
    ),
  });
  const ep = listed(size);
  const result = await subject.download(ep, CONTEXT);
  assert.equal(result.status, "failed-unavailable");
  assert.equal(
    result.message,
    `TikTok serves this episode short: the whole file came (${size} bytes, as listed) but it plays 3 s of 92 s — if the TikTok app plays it whole, watch it there, then --recheck looks again; if the app breaks at the same point, the episode is defective on TikTok's side and no retry changes it`,
  );
  assert.equal(result.message, shortServedMessage(size, "3", "92"));
  assert.deepEqual(saved, []);
  assert.equal(log.length, 1); // one request: no other mirror, no fresh list, no cover
  const trace = subject.traceOf(ep);
  assert.equal(trace?.attempts.length, 1);
  assert.equal(trace?.attempts[0]?.outcome, `${ATTEMPT_SHORT_HEADER_PREFIX}3 s of 92 s`);
  assert.equal(trace?.attempts[0]?.received_bytes, size);
  assert.equal(ATTEMPT_SHORT_HEADER_PREFIX, "plays ");
  // within 0.5 % of a listed size (the H.264 rendition's DataSize counts too)
  const close = await subject.download(listed(size + Math.floor(size * 0.004), 1), CONTEXT);
  assert.equal(close.status, "failed-unavailable");
  const byRendition = await subject.download(listed(1, size), CONTEXT);
  assert.equal(byRendition.status, "failed-unavailable");
  // an unlisted size: the old path — `download looks incomplete or wrong`, FAILED, nothing saved either
  for (const other of [listed(size + Math.ceil(size * 0.006)), listed(1)]) {
    const incomplete = await subject.download(other, CONTEXT);
    assert.equal(incomplete.status, "failed");
    assert.equal(incomplete.message, "download looks incomplete or wrong: duration 3 s, expected 92 s");
    assert.equal(subject.traceOf(other)?.attempts[0]?.outcome, "verify failed: duration 3 s, expected 92 s");
  }
  const noSize = await subject.download(episode(1, { durationS: 92 }), CONTEXT);
  assert.equal(noSize.status, "failed");
  assert.deepEqual(saved, []);
  // servedShort on its own: the reason must be the duration one, with a < e
  assert.deepEqual(servedShort("duration 3 s, expected 92 s", size, [size]), { actual: "3", expected: "92" });
  assert.equal(servedShort("duration 3 s, expected 92 s", size, []), null);
  assert.equal(servedShort("duration 92 s, expected 3 s", size, [size]), null);
  assert.equal(servedShort("no audio track", size, [size]), null);
  assert.equal(servedShort("duration 2.5 s, expected 92 s", size, [size]), null); // whole seconds only, as media._DURATION_MISMATCH_RE
  assert.equal(servedShort("duration 3 s, expected 92 s", 1000, [995]), null); // 5 > 0.5 % of 995 (4.975)
  assert.deepEqual(servedShort("duration 3 s, expected 92 s", 1000, [996]), { actual: "3", expected: "92" }); // 4 <= 4.98
  assert.deepEqual(servedShort("duration 3 s, expected 92 s", 1000, [990, 1000]), { actual: "3", expected: "92" });
  assert.deepEqual(servedShort("duration 3 s, expected 92 s", 1004, [1000]), { actual: "3", expected: "92" });
  assert.equal(servedShort("duration 3 s, expected 92 s", size, [Infinity]), null); // never `Infinity <= Infinity`
  assert.equal(servedShort("duration 3 s, expected 92 s", size, [NaN, -Infinity]), null);
});

test("the traces record every candidate as decided: query stripped, sizes, status, outcome; never requested when the host is not covered", async () => {
  const signed = (/** @type {string} */ host, /** @type {string} */ path) => `https://${host}/${path}?expire=1900000000&X-Bogus=abc&_signature=def&msToken=ghi`;
  const urls = [signed("v1.tiktok.com", "a.mp4"), signed("v2.tiktok.com", "b.mp4")];
  /** @type {string[]} */
  const log = [];
  // a 404 then a good URL: two attempts, `HTTP 404` and `saved`
  const subject = downloader({
    fetch: fakeFetch(
      {
        "https://v1.tiktok.com/": () => new Response("gone", { status: 404, headers: { "content-type": "text/plain", "content-length": "4" } }),
        "https://v2.tiktok.com/": () => new Response(video(), { headers: { "content-type": "video/mp4", "content-length": String(128 * 1024) } }),
        "https://p16-sign-sg.tiktokcdn.com/": () => new Response(COVER, { headers: { "content-type": "image/jpeg" } }),
      },
      log,
    ),
  });
  const first = episode(1, { urls });
  assert.equal(subject.traceOf(first), null); // nothing recorded before the download
  const result = await subject.download(first, CONTEXT);
  assert.equal(result.status, "done");
  const trace = subject.traceOf(first);
  assert.ok(trace !== null);
  assert.deepEqual(trace.refreshes, []);
  assert.deepEqual(trace.attempts, [
    {
      url: "https://v1.tiktok.com/a.mp4",
      host: "v1.tiktok.com",
      url_expiry: 1900000000,
      requested: true,
      redirect_hops: 0,
      http_status: 404,
      content_type: "text/plain",
      content_length: 4,
      received_bytes: null,
      outcome: "HTTP 404",
    },
    {
      url: "https://v2.tiktok.com/b.mp4",
      host: "v2.tiktok.com",
      url_expiry: 1900000000,
      requested: true,
      redirect_hops: 0,
      http_status: 200,
      content_type: "video/mp4",
      content_length: 128 * 1024,
      received_bytes: 128 * 1024,
      outcome: ATTEMPT_SAVED,
    },
  ]);
  // never the query: TikTok signs it
  assert.ok(trace.attempts.every((attempt) => !attempt.url.includes("?") && !JSON.stringify(attempt).includes("X-Bogus")));
  assert.deepEqual(log, [...urls, "https://p16-sign-sg.tiktokcdn.com/c/1.jpeg"]); // the same requests as ever
  // a host the manifest does not cover: counted, never requested; a truncated body: the bytes that came
  log.length = 0;
  const short = () => new Response(video().subarray(0, 100_000), { headers: { "content-type": "video/mp4", "content-length": String(128 * 1024) } });
  const cut = downloader({ fetch: fakeFetch({ "https://v": short }, log) });
  const second = episode(2, { urls: ["https://evil.example.com/a.mp4?sig=x", ...urls] });
  const truncated = await cut.download(second, CONTEXT);
  assert.equal(truncated.status, "failed");
  const attempts = /** @type {import("../src/lib/diagnosis.js").EpisodeTrace} */ (cut.traceOf(second)).attempts;
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map((attempt) => [attempt.url, attempt.requested, attempt.http_status, attempt.content_length, attempt.received_bytes, attempt.outcome]),
    [
      ["https://evil.example.com/a.mp4", false, null, null, null, ATTEMPT_NOT_REQUESTED],
      ["https://v1.tiktok.com/a.mp4", true, 200, 128 * 1024, 100_000, `truncated body (100000 of ${128 * 1024} bytes)`],
    ],
  );
  assert.ok(/** @type {number} */ (attempts[1]?.received_bytes) < /** @type {number} */ (attempts[1]?.content_length));
  assert.deepEqual(log, [urls[0]]);
  // an encrypted body
  const encrypted = video();
  const text = new TextDecoder("latin1").decode(encrypted);
  encrypted.set([0x65, 0x6e, 0x63, 0x76], text.indexOf("avc1", text.indexOf("stsd")));
  const drm = downloader({ fetch: fakeFetch({ "https://v": () => new Response(encrypted.slice(), { headers: { "content-type": "video/mp4" } }) }, []) });
  const third = episode(3, { urls });
  assert.equal((await drm.download(third, CONTEXT)).message, DRM_MESSAGE);
  assert.deepEqual(
    /** @type {import("../src/lib/diagnosis.js").EpisodeTrace} */ (drm.traceOf(third)).attempts.map((attempt) => [attempt.received_bytes, attempt.outcome]),
    [[128 * 1024, ATTEMPT_ENCRYPTED]],
  );
  // a download starts its episode's trace afresh; a locked skip leaves an empty one
  assert.equal((await drm.download(third, CONTEXT)).status, "failed-unavailable");
  assert.equal(/** @type {import("../src/lib/diagnosis.js").EpisodeTrace} */ (drm.traceOf(third)).attempts.length, 1);
  const locked = episode(4, { locked: true });
  assert.equal((await drm.download(locked, CONTEXT)).status, "skipped-locked");
  assert.deepEqual(drm.traceOf(locked), { attempts: [], refreshes: [] });
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

// ------------------------------------------------------------- redirects, ids, re-listing

/** What `fetch(url, {redirect: "manual"})` answers for a 3xx: an opaque redirect, target unknown. */
const opaqueRedirect = () =>
  /** @type {Response} */ (/** @type {unknown} */ ({ type: "opaqueredirect", status: 0, headers: new Headers(), body: null }));

test("download: a redirect is never followed — counted, the next URL tried; a cover's only noted", async () => {
  /** @type {string[]} */
  const log = [];
  /** @type {(string | undefined)[]} */
  const modes = [];
  const urls = ["https://v1.tiktok.com/a.mp4", "https://v2.tiktok.com/b.mp4"];
  const routes = fakeFetch(
    {
      "https://v1.tiktok.com/": opaqueRedirect,
      "https://v2.tiktok.com/": () => new Response(video(), { headers: { "content-type": "video/mp4" } }),
      "https://p16-sign-sg.tiktokcdn.com/": opaqueRedirect,
    },
    log,
  );
  const fetchFn = /** @type {typeof fetch} */ (
    (input, init) => {
      modes.push(init?.redirect);
      return routes(input, init);
    }
  );
  /** @type {string[]} */
  const saved = [];
  const result = await downloader({ saved, fetch: fetchFn }).download(episode(1, { urls }), CONTEXT);
  assert.equal(result.status, "done");
  assert.equal(
    result.message,
    "saved Test Series - Episode 01.mp4 (0.1 MiB); cover: a redirect from p16-sign-sg.tiktokcdn.com, not followed",
  );
  assert.deepEqual(log, [...urls, "https://p16-sign-sg.tiktokcdn.com/c/1.jpeg"]);
  assert.deepEqual(modes, ["manual", "manual", "manual"]);
  assert.equal(saved.length, 1); // the video only: no cover was kept

  // every URL redirecting: refused like a 403, at most 4 GETs, nothing saved
  log.length = 0;
  const many = [1, 2, 3, 4, 5].map((n) => `https://v${n}.tiktok.com/v.mp4`);
  const all = downloader({ saved, fetch: fakeFetch({ "https://v": opaqueRedirect }, log) });
  const refused = await all.download(episode(2, { urls: many }), CONTEXT);
  assert.equal(refused.status, "failed-unavailable");
  assert.equal(
    refused.message,
    "no playable stream: locked, region-restricted or not logged in (a redirect from v4.tiktok.com, not followed)",
  );
  assert.equal(log.length, 4);
  assert.equal(saved.length, 1);
});

/**
 * A fake `chrome.downloads` whose search answers `items` and logs every query with the clock.
 * @param {chrome.downloads.DownloadItem[]} items
 * @param {() => number} clock
 */
function fakeDownloads(items, clock) {
  /** @type {[number, chrome.downloads.DownloadQuery][]} */
  const searches = [];
  const api = /** @type {typeof chrome.downloads} */ (
    /** @type {unknown} */ ({
      search: async (/** @type {chrome.downloads.DownloadQuery} */ query) => {
        searches.push([clock(), query]);
        return items;
      },
    })
  );
  return { api, searches };
}

/** @param {number} id @param {string} filename @returns {chrome.downloads.DownloadItem} */
const item = (id, filename) =>
  /** @type {chrome.downloads.DownloadItem} */ (/** @type {unknown} */ ({ id, filename, state: "complete", exists: true }));

test("the downloads view: a recorded id that now names another file is not the episode on disk", async () => {
  const episode01 = "/home/me/Downloads/DramaFetch/S [1]/S - Episode 01.mp4";
  const episode02 = "/home/me/Downloads/DramaFetch/S [1]/S - Episode 02.mp4";
  // the history was cleared and Chrome restarted: id 2 went to an unrelated download
  const { api } = fakeDownloads([item(1, episode01), item(2, "/home/me/Downloads/invoice.pdf")], () => 0);
  const view = new DownloadsView({ api, sleep: async () => undefined, checks: { lastMs: Number.NEGATIVE_INFINITY } });
  await view.refresh();
  const state = newState(SERIES_ID, "S");
  const at = 1_800_000_000;
  const none = () => false;
  record(state, { episode: { number: 1, itemId: "a" }, status: "done", path: episode01, message: "saved", downloadId: 1 }, { exists: none, now: at });
  record(state, { episode: { number: 2, itemId: "b" }, status: "done", path: episode02, message: "saved", downloadId: 2 }, { exists: none, now: at });
  markComplete(state, at, 2);
  const exists = (/** @type {import("../src/lib/state.js").StateEntry} */ entry) => view.exists(entry);
  assert.equal(donePath(state, 1, exists), episode01);
  assert.equal(donePath(state, 2, exists), null);
  assert.deepEqual(missingFiles(state, exists), [2]);
  assert.equal(completeSkip(state, { seriesId: SERIES_ID, nowS: at + 60, exists }), null); // it downloads E02 again
});

test("the downloads view: a job's first look waits out Chrome's 10 s between two file checks", async () => {
  let clock = 1_000_000_500; // ms
  /** @type {number[]} */
  const sleeps = [];
  const { api, searches } = fakeDownloads([], () => clock);
  const checks = { lastMs: Number.NEGATIVE_INFINITY };
  const sleep = async (/** @type {number} */ seconds) => {
    sleeps.push(seconds);
    clock += seconds * 1000;
  };
  const view = () => new DownloadsView({ api, sleep, now: () => clock, checks, existenceDelayMs: 300 });
  const first = view();
  await first.refresh(); // no check made yet: no wait
  assert.equal(checks.lastMs, 1_000_000_500);
  clock += 200;
  await first.refresh(); // the same job again: no wait
  assert.deepEqual(sleeps, [0.3, 0.3]);
  const next = view(); // the next job, a moment later: Chrome checks again from second 1_000_011 on
  const before = clock;
  await next.refresh();
  assert.deepEqual(sleeps, [0.3, 0.3, (1_000_011_000 - before) / 1000, 0.3]);
  assert.equal(searches[4]?.[0], 1_000_011_000);
  assert.equal(checks.lastMs, 1_000_011_000);
  // the test copy may skip the wait (no scenario of its deletes a file but one)
  const quick = new DownloadsView({ api, sleep, now: () => clock, checks, existenceDelayMs: 0, rateLimitS: 0 });
  sleeps.length = 0;
  await quick.refresh();
  assert.deepEqual(sleeps, [0]);
});

test("the downloads view: Chrome's Windows paths, backslashes and all, match the episode's target", async () => {
  // Chrome on Windows reports C:\Users\x\Downloads\DramaFetch\<folder>\<file>
  const folder = `C:\\Users\\x\\Downloads\\DramaFetch\\Test Series [${SERIES_ID}]`;
  const episode01 = `${folder}\\Test Series - Episode 01.mp4`;
  const { api } = fakeDownloads(
    [
      item(1, episode01),
      item(2, `${folder}\\Test Series - Episode 02 (1).mp4`), // uniquified by Chrome: another name
      item(3, `C:\\Users\\x\\Downloads\\MyDramaFetch\\Test Series [${SERIES_ID}]\\Test Series - Episode 03.mp4`),
    ],
    () => 0,
  );
  const view = new DownloadsView({ api, sleep: async () => undefined, checks: { lastMs: Number.NEGATIVE_INFINITY } });
  await view.refresh();
  const target = (/** @type {number} */ n) => `DramaFetch/Test Series [${SERIES_ID}]/Test Series - Episode 0${n}.mp4`;
  assert.equal(view.completedAt(target(1))?.filename, episode01);
  assert.equal(view.completedAt(target(2)), null);
  assert.equal(view.completedAt(target(3)), null); // "MyDramaFetch" is another folder
  // the state records Chrome's own filename, so the recorded download is the file on disk
  assert.equal(view.exists({ download_id: 1, path: episode01 }), true);

  // the downloader's existing-file skip: no request, Chrome's Windows path in the row
  /** @type {string[]} */
  const log = [];
  const subject = downloader({ fetch: fakeFetch({}, log), view });
  const skipped = await subject.download(episode(1), CONTEXT);
  assert.equal(skipped.status, "skipped-exists");
  assert.equal(skipped.path, episode01);
  assert.equal(skipped.message, "already exists: Test Series - Episode 01.mp4");
  assert.equal(skipped.downloadId, 1);
  assert.equal(subject.needsNetwork(episode(1), CONTEXT), false);
  assert.equal(subject.needsNetwork(episode(2), CONTEXT), true);
  assert.deepEqual(log, []);
});

test("a selection lists the series again, after the rest between jobs, and the fresh list decides", async () => {
  // listed earlier with E02 playable; whoever is logged in now gets it locked
  const fresh = series([episode(1), episode(2, { locked: true }), episode(3)]);
  /** @type {number[]} */
  const listedAt = [];
  const fake = fakeEngine({
    discover: async () => {
      listedAt.push(fake.engine.clock());
      return fresh;
    },
  });
  const ref = { kind: /** @type {const} */ ("series"), seriesId: SERIES_ID, episodeHint: null, sourceUrl: SERIES_ID };
  const start = fake.engine.clock();
  const run = await runSelectionJob(fake.engine, ref, [1, 2, 3], { lastContactAt: start - 30 });
  assert.deepEqual(fake.pauses.map((p) => `${p.kind} ${p.seconds}`), ["job-rest 60", "pace 4"]); // no second rest
  assert.equal(fake.pauses[0]?.text, "resting 60 s before the next series");
  assert.deepEqual(listedAt, [start + 60]); // the rest first, then the list
  assert.deepEqual(run.results.map((r) => r.status), ["done", "skipped-locked", "done"]);
  assert.deepEqual(fake.downloads, [1, 3]);
  assert.equal(run.contacted, true);
  assert.equal(run.series, fresh);

  // a cooldown recorded during the rest: refused before the list, no request
  const refused = fakeEngine({
    discover: async () => {
      throw new Error("no list expected");
    },
  });
  refused.engine.sleep = async (seconds) => {
    refused.tick(seconds);
    refused.setCooldown({ until: refused.engine.wallClock() + 1800, reason: "elsewhere", source: "web", recorded_at: refused.engine.wallClock() });
  };
  const stopped = await runSelectionJob(refused.engine, ref, [1], { lastContactAt: refused.engine.clock() - 5 });
  assert.equal(stopped.errorKind, "cooldown");
  assert.equal(stopped.stop, true);
  assert.equal(stopped.contacted, false);
  assert.deepEqual(refused.downloads, []);
});

/**
 * A fake `chrome` with the tabs and the session storage the discovery's tab handling uses.
 * @param {{completeAfter?: number}} [options] how many `tabs.get` calls see the tab still loading
 */
function fakeChrome(options = {}) {
  /** @type {Map<string, unknown>} */
  const session = new Map();
  /** @type {unknown[][]} */
  const calls = [];
  let gets = 0;
  const chrome = {
    tabs: {
      create: async (/** @type {{url: string, active: boolean}} */ props) => {
        calls.push(["create", props.url, props.active]);
        return { id: 42 };
      },
      update: async (/** @type {number} */ id, /** @type {object} */ props) => {
        calls.push(["update", id, props]);
        return undefined;
      },
      get: async (/** @type {number} */ id) => {
        gets += 1;
        calls.push(["get", id]);
        return { id, url: "about:blank", status: gets > (options.completeAfter ?? 0) ? "complete" : "loading" };
      },
      remove: async (/** @type {number} */ id) => {
        calls.push(["remove", id]);
      },
    },
    storage: {
      session: {
        get: async (/** @type {string} */ key) => (session.has(key) ? { [key]: session.get(key) } : {}),
        set: async (/** @type {Record<string, unknown>} */ items) => {
          for (const [key, value] of Object.entries(items)) session.set(key, value);
        },
        remove: async (/** @type {string} */ key) => {
          session.delete(key);
        },
      },
    },
  };
  Object.assign(globalThis, { chrome });
  return { session, calls, restore: () => Reflect.deleteProperty(globalThis, "chrome") };
}

test("the discovery tab: muted, sent on only once about:blank has loaded, recorded until it is closed", async () => {
  const fake = fakeChrome({ completeAfter: 2 });
  try {
    /** @type {number[]} */
    const polls = [];
    const browser = chromeBrowser(7, { sleep: async (seconds) => void polls.push(seconds) });
    assert.equal(await browser.openTab(3), 42);
    assert.deepEqual(fake.calls.slice(0, 2), [["create", "about:blank", false], ["update", 42, { muted: true }]]);
    assert.deepEqual(fake.calls.filter((call) => call[0] === "get").length, 3); // loading, loading, complete
    assert.deepEqual(polls, [0.02, 0.02]);
    assert.deepEqual(fake.session.get(DISCOVERY_TAB_KEY), { tabId: 42, appTabId: 7 });
    await browser.closeTab(42);
    assert.deepEqual(fake.calls.at(-1), ["remove", 42]);
    assert.equal(fake.session.has(DISCOVERY_TAB_KEY), false);
    // a tab left behind: closed for its own DramaFetch tab (the worker), or for a new engine page
    fake.session.set(DISCOVERY_TAB_KEY, { tabId: 43, appTabId: 7 });
    assert.equal(await closeLeftoverDiscoveryTab(8), false);
    assert.equal(fake.session.has(DISCOVERY_TAB_KEY), true);
    assert.equal(await closeLeftoverDiscoveryTab(7), true);
    assert.deepEqual(fake.calls.at(-1), ["remove", 43]);
    assert.equal(fake.session.has(DISCOVERY_TAB_KEY), false);
    fake.session.set(DISCOVERY_TAB_KEY, { tabId: 44, appTabId: null });
    assert.equal(await closeLeftoverDiscoveryTab(), true);
    assert.deepEqual(fake.calls.at(-1), ["remove", 44]);
    assert.equal(await closeLeftoverDiscoveryTab(), false); // nothing left
  } finally {
    fake.restore();
  }
});

test("the list's thumbnails: one request at a time, only while allowed, only rows in view, each kept by item id", async () => {
  /** @type {string[]} */
  const log = [];
  let inFlight = 0;
  let most = 0;
  const fetchFn = /** @type {typeof fetch} */ (
    async (input, init) => {
      log.push(String(input));
      assert.equal(init?.redirect, "manual");
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      if (String(input).includes("/moved/")) return opaqueRedirect();
      return new Response(COVER, { headers: { "content-type": "image/jpeg" } });
    }
  );
  let allowed = false;
  let pauses = 0;
  /** @type {string[]} */
  const shown = [];
  const loader = new CoverLoader({
    hostPatterns: ["https://*.tiktokcdn.com/*"],
    allowed: async () => allowed,
    pause: async () => {
      pauses += 1;
    },
    onCover: (itemId, url) => void shown.push(`${itemId} ${url}`),
    fetch: fetchFn,
    objectUrl: (blob) => `blob:${blob.type}:${blob.size}`,
  });
  const list = [
    ...[1, 2, 3].map((n) => ({ itemId: `i${n}`, coverUrl: `https://p16.tiktokcdn.com/c/${n}.jpeg` })),
    { itemId: "i4", coverUrl: "https://evil.example.com/4.jpeg" }, // never requested, no pause either
    { itemId: "i5", coverUrl: "https://p16.tiktokcdn.com/moved/5.jpeg" }, // a redirect: not followed
    { itemId: "i6", coverUrl: null },
  ];
  loader.show(list); // nothing is wanted before its row is in view
  await loader.idle();
  assert.deepEqual(log, []);
  for (const { itemId } of list) loader.setVisible(itemId, true); // every row in view
  await loader.idle(); // a job runs or waits, or a cooldown: nothing goes out
  assert.deepEqual(log, []);
  allowed = true;
  loader.resume();
  await loader.idle();
  assert.equal(most, 1);
  assert.deepEqual(log, [1, 2, 3].map((n) => `https://p16.tiktokcdn.com/c/${n}.jpeg`).concat("https://p16.tiktokcdn.com/moved/5.jpeg"));
  assert.equal(pauses, 4);
  assert.deepEqual(shown, ["i1 blob:image/jpeg:600", "i2 blob:image/jpeg:600", "i3 blob:image/jpeg:600"]);
  assert.equal(loader.urlOf("i2"), "blob:image/jpeg:600");
  assert.equal(loader.urlOf("i5"), null);
  loader.show(list); // the list shown again: every thumbnail asked for once already
  for (const { itemId } of list) loader.setVisible(itemId, true);
  await loader.idle();
  assert.equal(log.length, 4);
});

test("the app tab is never discarded while a job runs or waits, discardable again once nothing does", async () => {
  /** @type {[number, chrome.tabs.UpdateProperties][]} */
  const updates = [];
  let refuse = false;
  /** @type {unknown[]} */
  const errors = [];
  const keeper = new TabKeeper({
    tabs: {
      update: async (tabId, properties) => {
        if (refuse) throw new Error("No tab with id: 5");
        updates.push([tabId, properties]);
        return undefined;
      },
    },
    onError: (error) => void errors.push(error),
  });
  await keeper.keep(undefined, true); // no tab known yet: nothing to tell
  assert.deepEqual(updates, []);
  await keeper.keep(5, false); // the page starts idle: Chrome's default, said once
  await keeper.keep(5, true); // a job queued
  await keeper.keep(5, true); // it runs, another waits: no second call
  assert.deepEqual(updates, [[5, { autoDiscardable: true }], [5, { autoDiscardable: false }]]);
  // the last state asked for wins, in order, even when asked faster than Chrome answers
  void keeper.keep(5, false);
  void keeper.keep(5, true);
  await keeper.keep(5, false); // a Stop or an error ends the job: the queue is empty again
  assert.deepEqual(updates.slice(2), [[5, { autoDiscardable: true }], [5, { autoDiscardable: false }], [5, { autoDiscardable: true }]]);
  refuse = true; // the tab is gone: noted, never thrown
  await keeper.keep(5, true);
  assert.equal(errors.length, 1);
});

// ------------------------------------------------------------------------------ the page (app.js)

/**
 * One element of app.html, as far as app.js reads or writes it: text, class, flags, value, the
 * `data-*` set, attributes, the children appended (`textContent = ""` drops them, as in the DOM),
 * the parts `querySelector` hands out (one per selector, kept) and the listeners added, by event
 * type, for the test to fire.
 */
class FakeElement {
  /** @param {string} tag */
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = "";
    this.title = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.lang = "";
    this.text = "";
    /** @type {Record<string, string | undefined>} */
    this.dataset = {};
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {FakeElement[]} */
    this.children = [];
    /** @type {Map<string, FakeElement>} */
    this.parts = new Map();
    /** @type {Map<string, ((event: unknown) => unknown)[]>} */
    this.listeners = new Map();
  }
  get textContent() {
    return this.text;
  }
  /** @param {string | null} value */
  set textContent(value) {
    this.text = value ?? "";
    this.children = [];
  }
  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  /** @param {string} name @returns {string | null} */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  /** @param {...(FakeElement | string)} nodes */
  append(...nodes) {
    for (const node of nodes) if (node instanceof FakeElement) this.children.push(node);
  }
  /** @param {...(FakeElement | string)} nodes */
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  /** @param {string} selector @returns {FakeElement} */
  querySelector(selector) {
    let part = this.parts.get(selector);
    if (part === undefined) {
      part = new FakeElement(selector);
      this.parts.set(selector, part);
    }
    return part;
  }
  /** @returns {FakeElement[]} */
  querySelectorAll() {
    return [];
  }
  /** @param {string} type @param {(event: unknown) => unknown} listener */
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  /** @param {string} type */
  fire(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault: () => undefined });
  }
}

/**
 * @typedef {{message: string, placeholders?: Record<string, {content: string}>}} CatalogEntry
 */

/** How many instances of app.js the tests have loaded: each gets a module URL of its own. */
let pages = 0;

/**
 * app.js loaded over a fake document and a fake `chrome` (the English messages, the storage seeded
 * with `options.storage` — a history, a cooldown — else empty, the engine lock free): a FRESH
 * instance each time (a module URL of its own, so `main()` runs again, over these fakes), awaited
 * to its end; `module` is that instance's exports. `hold()` then makes the next job's first
 * `chrome.tabs.getCurrent` never answer, so that the job stays running and makes no request to
 * anything; `message()` is a runtime message from this extension's own popup; `local` is the
 * storage and `storageChanged(key)` tells the page a key of it changed; `downloads` is every file
 * the page saved through `chrome.downloads` (a fake that completes each at once); `restore()`
 * removes the fakes again.
 * @param {{storage?: Record<string, unknown>}} [options]
 */
async function fakePage(options = {}) {
  /** @type {Record<string, CatalogEntry>} */
  const catalog = JSON.parse(readFileSync(new URL("../_locales/en/messages.json", import.meta.url), "utf8"));
  /** @type {Record<string, unknown>} */
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  /** @type {Map<string, FakeElement>} */
  const elements = new Map();
  /** @param {string} id @returns {FakeElement} */
  const element = (id) => {
    let found = elements.get(id);
    if (found === undefined) {
      found = new FakeElement("div");
      elements.set(id, found);
    }
    return found;
  };
  /** @type {Map<string, unknown>} chrome.storage.local */
  const local = new Map(Object.entries(options.storage ?? {}));
  /** @type {((changes: Record<string, unknown>, area: string) => void)[]} */
  const changeListeners = [];
  /** @type {((message: unknown, sender: {id: string}) => void)[]} */
  const messageListeners = [];
  /** @type {{filename: string, conflictAction: string | undefined, text: string}[]} every file the page saved through chrome.downloads, its bytes as text */
  const downloads = [];
  let holding = false;
  const chrome = {
    downloads: {
      // the blob is read NOW: the page revokes its URL once the download has completed
      /** @param {{url: string, filename: string, conflictAction?: string}} options */
      download: async (options) => {
        const text = await (await fetch(options.url)).text();
        downloads.push({ filename: options.filename, conflictAction: options.conflictAction, text });
        return downloads.length;
      },
      /** @param {{id?: number}} query */
      search: async (query) => {
        const saved = query.id === undefined ? undefined : downloads[query.id - 1];
        if (saved === undefined) return [];
        return [{ id: query.id, filename: `/home/me/Downloads/${saved.filename}`, state: "complete", exists: true }];
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    runtime: {
      id: "dramafetch-test-id",
      getManifest: () => manifest,
      onMessage: {
        /** @param {(message: unknown, sender: {id: string}) => void} listener */
        addListener: (listener) => void messageListeners.push(listener),
      },
    },
    i18n: {
      getUILanguage: () => "en-US",
      /** @param {string} key @param {string[]} [substitutions] */
      getMessage: (key, substitutions = []) => {
        const entry = catalog[key];
        if (entry === undefined) return "";
        return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (_match, name) => {
          const known = Object.entries(entry.placeholders ?? {}).find(([placeholder]) => placeholder.toLowerCase() === String(name).toLowerCase());
          return known === undefined ? "" : (substitutions[Number(known[1].content.slice(1)) - 1] ?? "");
        });
      },
    },
    storage: {
      local: {
        /** @param {string | string[]} keys */
        get: async (keys) => {
          /** @type {Record<string, unknown>} */
          const found = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) if (local.has(key)) found[key] = local.get(key);
          return found;
        },
        /** @param {Record<string, unknown>} items */
        set: async (items) => {
          for (const [key, value] of Object.entries(items)) local.set(key, value);
        },
        /** @param {string} key */
        remove: async (key) => void local.delete(key),
      },
      session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
      onChanged: {
        /** @param {(changes: Record<string, unknown>, area: string) => void} listener */
        addListener: (listener) => void changeListeners.push(listener),
      },
    },
    tabs: {
      getCurrent: () => (holding ? new Promise(() => undefined) : Promise.resolve({ id: 1, windowId: 10 })),
      update: async () => undefined,
    },
  };
  const document = {
    documentElement: new FakeElement("html"),
    body: new FakeElement("body"),
    getElementById: element,
    /** @returns {FakeElement[]} */
    querySelectorAll: () => [],
    /** @param {string} tag */
    createElement: (tag) => new FakeElement(tag),
  };
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const setIntervalBefore = globalThis.setInterval;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "FakeChrome/1",
      locks: {
        /** @param {string} name @param {object} _options @param {(lock: {name: string} | null) => unknown} callback */
        request: (name, _options, callback) => Promise.resolve(callback({ name })),
      },
    },
  });
  Object.assign(globalThis, {
    document,
    chrome,
    location: { search: "", pathname: "/src/app/app.html" },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setInterval: () => 0, // the page's one-second tick: never armed, so that the test process can exit
  });
  const restore = () => {
    for (const name of ["document", "chrome", "location", "MutationObserver"]) Reflect.deleteProperty(globalThis, name);
    Object.assign(globalThis, { setInterval: setIntervalBefore });
    if (navigatorBefore !== undefined) Object.defineProperty(globalThis, "navigator", navigatorBefore);
  };
  /** @returns {Promise<void>} one macrotask turn: what the page awaited meanwhile has run */
  const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** @type {typeof import("../src/app/app.js")} */
  let module;
  try {
    const url = new URL("../src/app/app.js", import.meta.url);
    url.search = `?page=${(pages += 1)}`; // a fresh instance: main() runs again, over these fakes
    module = await import(url.href);
    for (let turns = 0; turns < 200 && element("app-status").dataset["state"] !== "idle"; turns += 1) await turn();
    assert.equal(element("app-status").dataset["state"], "idle", "the page did not finish loading");
    assert.ok(element("load-button").listeners.has("click"), "Load list is wired");
  } catch (error) {
    restore();
    throw error;
  }
  return {
    module,
    element,
    catalog,
    turn,
    restore,
    local,
    downloads,
    /**
     * `chrome.storage.local` changed `key` (the page reads it again): the cooldown ending, say.
     * @param {string} key
     */
    storageChanged: (key) => {
      for (const listener of changeListeners) listener({ [key]: {} }, "local");
    },
    hold: () => {
      holding = true;
    },
    /** @param {unknown} message */
    message: (message) => {
      for (const listener of messageListeners) listener(message, { id: chrome.runtime.id });
    },
  };
}

test("the page: a second Load list for a series being listed, or waiting to be, is refused with loadAlreadyQueued and queues nothing", async () => {
  const page = await fakePage();
  try {
    const { element } = page;
    const refused = String(page.catalog["loadAlreadyQueued"]?.message);
    const other = "7699393770256782399";
    const links = element("links");
    const status = element("input-status");
    const load = () => element("load-button").fire("click");
    const queued = () => element("queue-list").children.map((item) => item.textContent);
    page.hold(); // the job's `tabs.getCurrent` never answers: it runs, and makes no request
    links.value = `https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/1`;
    load();
    await page.turn();
    assert.equal(element("app-status").dataset["state"], "running");
    assert.equal(element("progress-current").textContent, `List series ${SERIES_ID}`);
    assert.equal(element("queue-card").hidden, true); // it left the queue when it started
    // the same series again, from the box and from the popup ("Download this series", another episode's link)
    load();
    assert.equal(status.textContent, refused);
    assert.equal(status.className, "status error");
    assert.deepEqual(queued(), []);
    status.textContent = "";
    page.message({ type: "dramafetch:load", input: `https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/3` });
    assert.equal(status.textContent, refused);
    assert.deepEqual(queued(), []);
    assert.equal(element("app-status").dataset["state"], "running");
    // another series waits in the queue: a second request for it is refused the same way
    links.value = `https://www.tiktok.com/shortdrama/episode/${other}/1`;
    load();
    assert.notEqual(status.textContent, refused);
    assert.equal(element("queue-card").hidden, false);
    assert.deepEqual(queued(), [`List series ${other}`]);
    load();
    assert.equal(status.textContent, refused);
    assert.equal(status.className, "status error");
    assert.deepEqual(queued(), [`List series ${other}`]);
  } finally {
    page.restore();
  }
});

// ------------------------------------------------------- the episodes that did not download

/** The fake TikTok's second series, as the page tests name it. */
const OTHER_ID = "7699393770256782399";
/** A row's message when a 429 stopped the run before it. */
const STOPPED_BY_429 = `stopped: episode 2 failed-rate-limited: ${MEDIA_RATE_LIMIT_MESSAGE}`;
/** The report line every fake record carries (the history shows it as it is). */
const RECORD_LINE = "incomplete: 1 of 2 (1 downloaded) — 1 failed (2)";

/**
 * A finished job's per-series record as `runToHistory` stores it, its rows from `[number, status,
 * message?]` (the message defaults to `<status> <number>`); `rows: null` leaves the rows out, as
 * a listing's record has none.
 * @param {string} seriesId
 * @param {string | null} name
 * @param {[number, string, string?][] | null} rows
 * @returns {Record<string, unknown>}
 */
function seriesRecord(seriesId, name, rows) {
  /** @type {Record<string, unknown>} */
  const record = { series_id: seriesId, name, status: "incomplete", error: null, error_kind: null, stop: false, contacted: true, line: RECORD_LINE, report: {} };
  if (rows !== null) {
    record["rows"] = rows.map(([number, status, message]) => ({ number, status, message: message ?? `${status} ${number}`, path: null, download_id: null }));
  }
  return record;
}

/**
 * A history entry of a finished job over `series`.
 * @param {string} kind
 * @param {string} label
 * @param {Record<string, unknown>[]} series
 * @returns {Record<string, unknown>}
 */
function historyEntry(kind, label, series) {
  return { id: 1, kind, label, started_at: "2026-11-05T10:00:00.000Z", finished_at: "2026-11-05T10:05:00.000Z", error: null, stopped: null, refreshes: 0, pauses: [], series };
}

/**
 * @param {FakeElement} item a history entry's `<li>`
 * @returns {{line: FakeElement, retry: FakeElement} | null} its “did not download” line and retry button
 */
function retryLineOf(item) {
  const line = item.children.find((child) => child.className === "retry-line");
  const retry = line?.children.find((child) => child.tagName === "BUTTON");
  return line !== undefined && retry !== undefined ? { line, retry } : null;
}

/**
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @returns {string[]} the labels waiting in the queue card
 */
const queuedLabels = (page) => page.element("queue-list").children.map((item) => item.textContent ?? "");

/**
 * A result-table row as `renderResult` makes it (its `data-*` set).
 * @param {string} seriesId
 * @param {number} number
 * @param {string} status
 * @returns {FakeElement}
 */
function resultRow(seriesId, number, status) {
  const row = new FakeElement("tr");
  row.setAttribute("data-key", `${seriesId}:${number}`);
  row.setAttribute("data-series-id", seriesId);
  row.setAttribute("data-number", String(number));
  row.setAttribute("data-status", status);
  return row;
}

test("retryTargets: every failure row of every series, stopped ones included, ascending and de-duplicated; nothing for done, skipped, dry-run or rowless records", async () => {
  const page = await fakePage();
  try {
    const { retryTargets, retryJobs } = page.module;
    const records = [
      seriesRecord(SERIES_ID, "One", [
        [1, "done"],
        [2, "failed-unavailable", DRM_MESSAGE],
        [3, "skipped-exists"],
        [4, "failed"],
        [5, "skipped-locked"],
        [7, "failed-rate-limited", STOPPED_BY_429],
        [6, "failed-rate-limited", MEDIA_RATE_LIMIT_MESSAGE],
        [4, "failed", "the row written last"],
        [8, "dry-run"],
      ]),
      seriesRecord(OTHER_ID, "Two", [[2, "done"], [1, "failed-blocked"]]),
      seriesRecord("7699393770256782388", null, []), // a failed resolve, or a series the batch never started
      { series_id: "7699393770256782377", name: "Four", error: null, episodes: 3 }, // a listing
      seriesRecord("7699393770256782366", "Five", [[1, "done"], [2, "skipped-exists"], [3, "skipped-locked"]]),
      null,
    ];
    const targets = retryTargets(records);
    assert.deepEqual(targets, [
      { seriesId: SERIES_ID, name: "One", numbers: [2, 4, 6, 7] },
      { seriesId: OTHER_ID, name: "Two", numbers: [1] },
    ]);
    assert.equal(targets.reduce((count, target) => count + target.numbers.length, 0), 5);
    // what the retry queues: one selection job per series, in order, exactly those numbers, nothing else asked
    const ref = (/** @type {string} */ seriesId) => ({ kind: "series", seriesId, episodeHint: null, sourceUrl: seriesId });
    assert.deepEqual(retryJobs(targets), [
      { kind: "selection", label: "Retry 4 of One", refs: [ref(SERIES_ID)], series: null, numbers: [2, 4, 6, 7], includeLocked: false, recheck: false },
      { kind: "selection", label: "Retry 1 of Two", refs: [ref(OTHER_ID)], series: null, numbers: [1], includeLocked: false, recheck: false },
    ]);
    // a series the job never learnt the name of goes by its id
    assert.equal(retryJobs(retryTargets([seriesRecord(OTHER_ID, null, [[3, "failed"]])]))[0]?.label, `Retry 1 of ${OTHER_ID}`);
    assert.deepEqual(retryTargets([]), []);
  } finally {
    page.restore();
  }
});

test("the page: a past run's episodes that did not download get their line and a retry button; a click queues one selection job per series, none for a series without failures", async () => {
  const failures = historyEntry("batch", "3 series", [
    seriesRecord(SERIES_ID, "One", [
      [1, "done"],
      [2, "failed-rate-limited", MEDIA_RATE_LIMIT_MESSAGE],
      [4, "failed-rate-limited", STOPPED_BY_429],
      [3, "failed-rate-limited", STOPPED_BY_429],
    ]),
    seriesRecord(OTHER_ID, "Two", [[1, "failed"], [2, "done"]]),
    seriesRecord("7699393770256782388", "Three", [[1, "done"], [2, "skipped-locked"]]),
  ]);
  const clean = historyEntry("selection", "3 episodes of One", [seriesRecord(SERIES_ID, "One", [[1, "done"], [2, "skipped-exists"], [3, "skipped-locked"]])]);
  const page = await fakePage({ storage: { history: [failures, clean] } });
  try {
    const { element } = page;
    const [first, second] = element("history-list").children;
    assert.ok(first !== undefined && second !== undefined, "both entries are listed");
    const found = retryLineOf(first);
    assert.ok(found, "the entry with failures has its line and button");
    const { line, retry } = found;
    assert.equal(line.children[0]?.textContent, "Did not download: One: E02, E03, E04; Two: E01");
    assert.equal(retry.textContent, "Retry the episodes that did not download (4)");
    assert.equal(retry.disabled, false);
    // the entry's lines stay as they were, above it
    assert.ok(String(first.children[0]?.textContent).endsWith(" — 3 series"));
    assert.deepEqual(
      first.children.slice(1, -1).map((child) => child.textContent),
      ["One", "Two", "Three"].map((name) => `${name}: ${RECORD_LINE}`),
    );
    assert.equal(retryLineOf(second), null); // nothing to retry: neither the line nor the button
    assert.deepEqual(
      second.children.slice(1).map((child) => child.textContent),
      [`One: ${RECORD_LINE}`],
    );
    // the click: one selection job per series with failures, in the series' order; the button spent
    page.hold();
    retry.fire("click");
    await page.turn();
    assert.equal(retry.disabled, true);
    assert.equal(element("app-status").dataset["state"], "running");
    assert.equal(element("progress-current").textContent, "Retry 3 of One");
    assert.deepEqual(queuedLabels(page), ["Retry 1 of Two"]);
    retry.fire("click"); // spent until the next job ends: a second click queues nothing
    await page.turn();
    assert.deepEqual(queuedLabels(page), ["Retry 1 of Two"]);
  } finally {
    page.restore();
  }
});

test("the page: a past run too large for its share of the history lists the series it kept, says how many more it had, and retries what it kept", async () => {
  // 60 series, the third and the fiftieth with an episode that did not download, held to 1 500 bytes
  const records = Array.from({ length: 60 }, (_, index) => seriesRecord(String(7699393770256782300n + BigInt(index)), `Series ${index}`, [[1, "done"], [2, index === 2 || index === 49 ? "failed" : "done"]]));
  const entry = storedHistoryEntry(historyEntry("batch", "60 series", records), 1500);
  const kept = /** @type {Record<string, unknown>[]} */ (entry["series"]);
  const omitted = Number(entry["series_omitted"]);
  assert.ok(omitted > 0 && kept.length + omitted === 60, `${kept.length} kept, ${omitted} omitted`);
  const page = await fakePage({ storage: { history: [entry] } });
  try {
    const item = /** @type {FakeElement} */ (page.element("history-list").children[0]);
    const lines = item.children.slice(1).map((child) => child.textContent);
    // the series kept, in batch order (the two with a failure among them), then the count
    assert.deepEqual(
      lines.slice(0, kept.length),
      kept.map((record) => `${String(record["name"])}: ${RECORD_LINE}`),
    );
    assert.ok(lines.includes("Series 2: " + RECORD_LINE) && lines.includes("Series 49: " + RECORD_LINE));
    assert.equal(lines[kept.length], `Series of this run not kept here: ${omitted}.`);
    const found = retryLineOf(item);
    assert.ok(found, "the run keeps its retry line and button");
    assert.equal(found.line.children[0]?.textContent, "Did not download: Series 2: E02; Series 49: E02");
    assert.equal(found.retry.textContent, "Retry the episodes that did not download (2)");
  } finally {
    page.restore();
  }
});

test("the page: the retry buttons obey the cooldown like every download button — disabled while it is in force, back when it ends", async () => {
  const now = Date.now() / 1000;
  const failures = historyEntry("selection", "2 episodes of One", [seriesRecord(SERIES_ID, "One", [[1, "done"], [2, "failed"]])]);
  const cooldown = { until: now + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: now };
  const page = await fakePage({ storage: { history: [failures], cooldown } });
  try {
    const { element, module } = page;
    assert.equal(element("cooldown-banner").hidden, false);
    assert.equal(element("download-all-button").disabled, true);
    const found = retryLineOf(/** @type {FakeElement} */ (element("history-list").children[0]));
    assert.ok(found, "the entry has its button");
    assert.equal(found.retry.disabled, true);
    // the progress card's too: a job that ended under the cooldown (a 429 stop records one)
    module.renderFailed([
      seriesRecord(SERIES_ID, "One", [
        [1, "failed-rate-limited", MEDIA_RATE_LIMIT_MESSAGE],
        [2, "failed-rate-limited", STOPPED_BY_429],
      ]),
    ]);
    assert.equal(element("failed-block").hidden, false);
    assert.equal(element("retry-button").disabled, true);
    found.retry.fire("click"); // a disabled button cannot be clicked in a browser; the handler refuses all the same
    element("retry-button").fire("click");
    await page.turn();
    assert.equal(element("app-status").dataset["state"], "idle");
    assert.deepEqual(queuedLabels(page), []);
    // the cooldown ends (lifted in storage: the clock, another DramaFetch page): the buttons come back
    page.local.delete("cooldown");
    page.storageChanged("cooldown");
    await page.turn();
    assert.equal(element("cooldown-banner").hidden, true);
    assert.equal(element("download-all-button").disabled, false);
    assert.equal(found.retry.disabled, false);
    assert.equal(element("retry-button").disabled, false);
  } finally {
    page.restore();
  }
});

test("the page: at a job's end the failure rows leave the result table for the failed block, their count in the heading, the retry button under it", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const results = element("result-table").querySelector("tbody");
    const header = new FakeElement("tr"); // the series' header row, as onStart adds it
    header.className = "series-row";
    header.setAttribute("data-series-id", SERIES_ID);
    results.append(
      header,
      resultRow(SERIES_ID, 1, "done"),
      resultRow(SERIES_ID, 2, "failed-unavailable"),
      resultRow(SERIES_ID, 3, "skipped-exists"),
      resultRow(SERIES_ID, 4, "failed"),
      resultRow(SERIES_ID, 5, "skipped-locked"),
      resultRow(OTHER_ID, 1, "failed-rate-limited"),
    );
    const incomplete = "download looks incomplete or wrong: truncated body (100000 of 131072 bytes) from v16.tiktok.com";
    module.renderFailed([
      seriesRecord(SERIES_ID, "One", [
        [1, "done"],
        [2, "failed-unavailable", DRM_MESSAGE],
        [3, "skipped-exists"],
        [4, "failed", incomplete],
        [5, "skipped-locked"],
      ]),
      seriesRecord(OTHER_ID, null, [[1, "failed-rate-limited", STOPPED_BY_429]]),
    ]);
    const keys = (/** @type {FakeElement} */ row) => [row.getAttribute("data-series-id"), row.getAttribute("data-number"), row.getAttribute("data-status")];
    // the result table keeps the header and what completed
    assert.deepEqual(results.children.map(keys), [
      [SERIES_ID, null, null],
      [SERIES_ID, "1", "done"],
      [SERIES_ID, "3", "skipped-exists"],
      [SERIES_ID, "5", "skipped-locked"],
    ]);
    const failed = element("failed-table").querySelector("tbody");
    assert.deepEqual(failed.children.map(keys), [
      [SERIES_ID, "2", "failed-unavailable"],
      [SERIES_ID, "4", "failed"],
      [OTHER_ID, "1", "failed-rate-limited"],
    ]);
    // series (the stored name, else the id), E-number, the same status badge, the message as shown
    assert.deepEqual(
      failed.children.map((row) => row.children.map((cell) => cell.children[0]?.textContent ?? cell.textContent)),
      [
        ["One", "E02", "unavailable", DRM_MESSAGE],
        ["One", "E04", "failed", incomplete],
        [OTHER_ID, "E01", "stopped", STOPPED_BY_429],
      ],
    );
    assert.deepEqual(
      failed.children.map((row) => row.children[2]?.children[0]?.getAttribute("data-status")),
      ["failed-unavailable", "failed", "failed-rate-limited"],
    );
    assert.equal(element("failed-block").hidden, false);
    assert.equal(element("failed-heading").textContent, "Did not download (3)");
    assert.equal(element("retry-button").textContent, "Retry the episodes that did not download (3)");
    assert.equal(element("retry-button").disabled, false);
    // the button: one selection job per series; the block hidden and emptied as the first one starts
    page.hold();
    element("retry-button").fire("click");
    await page.turn();
    assert.equal(element("retry-button").disabled, true);
    assert.equal(element("progress-current").textContent, "Retry 2 of One");
    assert.deepEqual(queuedLabels(page), [`Retry 1 of ${OTHER_ID}`]);
    assert.equal(element("failed-block").hidden, true);
    assert.deepEqual(failed.children, []);
    assert.equal(element("failed-heading").textContent, "");
    // a job in which nothing failed: the block stays hidden, the button disabled
    module.renderFailed([seriesRecord(SERIES_ID, "One", [[1, "done"], [2, "skipped-exists"]])]);
    assert.equal(element("failed-block").hidden, true);
    assert.equal(element("retry-button").disabled, true);
    assert.deepEqual(failed.children, []);
  } finally {
    page.restore();
  }
});

// ------------------------------------------------------------ a batch of hundreds of series

/**
 * A series' header row of the result table, as `onStart` adds it.
 * @param {string} seriesId
 * @returns {FakeElement}
 */
function headerRow(seriesId) {
  const header = new FakeElement("tr");
  header.className = "series-row";
  header.setAttribute("data-series-id", seriesId);
  return header;
}

test("the page: a long batch keeps the result table light — the oldest completed rows leave, a failure and its series' header never", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    assert.equal(module.MAX_RESULT_ROWS, 2000);
    const results = element("result-table").querySelector("tbody");
    const keys = (/** @type {FakeElement} */ row) => `${row.getAttribute("data-series-id")}:${row.getAttribute("data-number") ?? "header"}:${row.getAttribute("data-status") ?? ""}`;
    // four finished series of four rows each under their headers: A clean, B with a failure, C clean, D clean
    const ids = ["A", "B", "C", "D"];
    const fill = () => {
      results.textContent = "";
      for (const id of ids) {
        results.append(headerRow(id));
        for (let number = 1; number <= 4; number += 1) {
          results.append(resultRow(id, number, id === "B" && number === 2 ? "failed-unavailable" : number === 4 ? "skipped-locked" : "done"));
        }
      }
    };
    fill();
    const before = results.children.map(keys);
    assert.equal(before.length, 20);
    element("result-trimmed").hidden = true;
    module.trimResultRows(20); // at the cap: nothing leaves, nothing is said
    assert.deepEqual(results.children.map(keys), before);
    assert.equal(element("result-trimmed").hidden, true);
    module.trimResultRows(13); // seven over: A's four rows and B's three completed ones leave — never B's failure
    assert.deepEqual(results.children.map(keys), [
      "B:header:",
      "B:2:failed-unavailable",
      "C:header:",
      "C:1:done",
      "C:2:done",
      "C:3:done",
      "C:4:skipped-locked",
      "D:header:",
      "D:1:done",
      "D:2:done",
      "D:3:done",
      "D:4:skipped-locked",
    ]); // A's header went with its last row; the order of what stays is unchanged
    assert.equal(element("result-trimmed").hidden, false);
    module.trimResultRows(1); // far over: every completed row leaves, the failure and its header stay
    assert.deepEqual(results.children.map(keys), ["B:header:", "B:2:failed-unavailable"]);
    module.trimResultRows(1); // nothing more can leave: said once, done once
    assert.deepEqual(results.children.map(keys), ["B:header:", "B:2:failed-unavailable"]);
    // the shipped cap: a batch of 60 series x 60 episodes ends with the last rows of the last series
    results.textContent = "";
    for (let seriesIndex = 0; seriesIndex < 60; seriesIndex += 1) {
      results.append(headerRow(`S${seriesIndex}`));
      for (let number = 1; number <= 60; number += 1) results.append(resultRow(`S${seriesIndex}`, number, "done"));
      module.trimResultRows(); // as each series is done
    }
    assert.ok(results.children.length <= 2000, String(results.children.length));
    assert.ok(results.children.length > 1900);
    assert.equal(results.children.at(-1)?.getAttribute("data-key"), "S59:60");
    // only the series that still have rows keep their header, each right before its rows
    const headers = results.children.filter((row) => row.className === "series-row").map((row) => row.getAttribute("data-series-id"));
    const withRows = [...new Set(results.children.filter((row) => row.className !== "series-row").map((row) => row.getAttribute("data-series-id")))];
    assert.deepEqual(headers, withRows);
    assert.ok(headers.length >= 32 && headers.length <= 34, String(headers.length));
  } finally {
    page.restore();
  }
});

test("the page: a table of 200 000 rows is emptied of its failure rows without one call taking them all", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const results = element("result-table").querySelector("tbody");
    results.children = Array.from({ length: 200_000 }, (_, index) => resultRow(SERIES_ID, index + 1, index === 99_999 ? "failed" : "done"));
    // a call handed 200 000 arguments overflows the stack, in Node as in Chrome (there from 124 568 on)
    assert.throws(() => new FakeElement("tbody").append(...results.children), RangeError);
    module.renderFailed([seriesRecord(SERIES_ID, "One", [[100_000, "failed", "boom"]])]);
    assert.equal(results.children.length, 199_999);
    assert.equal(results.children[99_998]?.getAttribute("data-number"), "99999"); // the order holds around the row that left
    assert.equal(results.children[99_999]?.getAttribute("data-number"), "100001");
    assert.equal(element("failed-table").querySelector("tbody").children.length, 1);
    assert.equal(element("failed-heading").textContent, "Did not download (1)");
  } finally {
    page.restore();
  }
});

test("the page: a finished series of a batch gives the report what it reads, then lets go of its list items and traces — the report is the same", async () => {
  const page = await fakePage();
  try {
    const { module, downloads } = page;
    const job = { kind: /** @type {const} */ ("batch"), label: "2 series" };
    const other = () => finishedRun(OTHER_ID, "Other", [{ episode: episode(1, { seriesId: OTHER_ID }), status: /** @type {const} */ ("done"), path: "/x", message: "saved" }]);
    // the whole runs, read at the job's end (what a selection job does)
    await module.reportJobEnd(job, OUTCOME, [finishedRun(SERIES_ID, "Test Series", reportRows()), other()], TRACES.of);
    // the same runs, each taken and released when its series was done
    const runs = [finishedRun(SERIES_ID, "Test Series", reportRows()), other()];
    /** @type {string[]} */
    const forgotten = [];
    const jobDownloader = { traceOf: TRACES.of, forgetSeries: (/** @type {string} */ seriesId) => void forgotten.push(seriesId) };
    /** @type {Pick<import("../src/app/app.js").JobRecord, "inputs" | "taking">} */
    const record = { inputs: [], taking: true };
    for (const run of runs) module.releaseSeries(run, jobDownloader, record);
    assert.equal(record.inputs.length, 2);
    assert.deepEqual(forgotten, [SERIES_ID, OTHER_ID]);
    for (const run of runs) {
      assert.ok(run.series?.episodes.every((ep) => ep.raw === null)); // the list items are gone…
      assert.ok(run.results.every((result) => result.episode.raw === null));
      assert.equal(run.results.length > 0 && run.report.listed > 0, true); // …the results and the series' report are not
    }
    // nothing of a downloaded row but the reference's item was kept for the report
    const [first] = record.inputs;
    assert.deepEqual(first?.episodes.map((row) => [row.number, row.status, row.raw !== null, row.trace !== null]), [
      [1, "done", true, false], // the reference row: its item, no trace
      [2, "failed", true, true],
      [3, "skipped-locked", true, true], // described: whatever the run recorded of it
      [4, "failed", true, true],
    ]);
    assert.equal(first?.listedEpisodes, null);
    assert.equal(first?.episodesDigest?.length, 4);
    await module.reportJobEnd(job, OUTCOME, runs, () => null, record.inputs); // the downloader has forgotten: it is not asked
    assert.equal(downloads.length, 2);
    const parsed = downloads.map((saved) => ({ ...JSON.parse(saved.text), generated_at: null }));
    assert.deepEqual(parsed[1], parsed[0]);
    assert.equal(parsed[0].series[0].not_downloaded[0].attempts.length, 1); // the truncated episode's attempt is in both
    // an input that cannot be taken leaves that run, and every later one, whole — and the report still has them all
    const later = [finishedRun(SERIES_ID, "Test Series", reportRows()), other(), finishedRun("7699393770256782388", "Third", reportRows().map((row) => ({ ...row, episode: episode(row.episode.number, { seriesId: "7699393770256782388" }) })))];
    let asked = 0;
    const failing = {
      traceOf: (/** @type {import("../src/lib/catalog.js").Episode} */ ep) => {
        asked += 1;
        if (ep.seriesId === OTHER_ID) throw new Error("no trace");
        return TRACES.of(ep);
      },
      forgetSeries: jobDownloader.forgetSeries,
    };
    /** @type {Pick<import("../src/app/app.js").JobRecord, "inputs" | "taking">} */
    const partial = { inputs: [], taking: true };
    const warn = console.warn;
    console.warn = () => undefined; // the page notes the reason; not this test's output
    try {
      for (const run of later) module.releaseSeries(run, failing, partial);
    } finally {
      console.warn = warn;
    }
    assert.equal(partial.inputs.length, 1);
    assert.equal(partial.taking, false);
    assert.equal(asked, 4 + 1); // the third series was not even tried
    assert.ok(later[1]?.results.every((result) => result.episode.raw !== null) && later[2]?.results.every((result) => result.episode.raw !== null));
    await module.reportJobEnd({ kind: "batch", label: "3 series" }, OUTCOME, later, TRACES.of, partial.inputs);
    const whole = JSON.parse(/** @type {string} */ (downloads[2]?.text));
    assert.deepEqual(whole.series.map((/** @type {{not_downloaded: unknown[]}} */ run) => run.not_downloaded.length), [3, 0, 3]);
    assert.equal(whole.series[2].not_downloaded[0].raw.id, "item2");
  } finally {
    page.restore();
  }
});

test("the downloader lets go of a finished series: its traces and fresh list, nothing of another series", async () => {
  const subject = downloader({ fetch: async () => new Response("", { status: 404 }) });
  const mine = [episode(1), episode(2)];
  const theirs = episode(1, { seriesId: OTHER_ID });
  for (const ep of [...mine, theirs]) subject.trace(ep).attempts.push(/** @type {never} */ ({ url: "https://v1.tiktok.com/a.mp4" }));
  subject.freshItems.set(SERIES_ID, new Map([["item1", {}]]));
  subject.freshItems.set(OTHER_ID, new Map([["item1", {}]]));
  subject.failedRefreshes.add(SERIES_ID);
  subject.refreshes = 3;
  subject.forgetSeries(SERIES_ID);
  assert.deepEqual(mine.map((ep) => subject.traceOf(ep)), [null, null]);
  assert.equal(subject.traceOf(theirs)?.attempts.length, 1);
  assert.deepEqual([...subject.freshItems.keys()], [OTHER_ID]);
  assert.equal(subject.failedRefreshes.has(SERIES_ID), true); // a failed refresh is still not asked again
  assert.equal(subject.refreshes, 3);
  // an id that is the beginning of another's is not that other series
  const longer = episode(1, { seriesId: `${OTHER_ID}9` });
  subject.trace(longer);
  subject.forgetSeries(OTHER_ID);
  assert.equal(subject.traceOf(theirs), null);
  assert.notEqual(subject.traceOf(longer), null);
});

/** A batch job as the page queues it (no request is made by building its engine). */
const BATCH_JOB = /** @type {import("../src/app/app.js").Job} */ ({
  id: 1,
  kind: "batch",
  label: "2 series",
  refs: [],
  series: null,
  numbers: [],
  includeLocked: false,
  recheck: false,
});

test("the page: the engine's hook releases each finished series of a batch and keeps the table light", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    /** @type {import("../src/app/app.js").JobRecord} */
    const record = { pauses: [], inputs: [], taking: true };
    const engine = module.buildEngine({ ...BATCH_JOB }, record);
    const run = finishedRun(SERIES_ID, "Test Series", reportRows());
    const [first] = run.results;
    assert.ok(first !== undefined);
    engine.downloader.trace(first.episode).attempts.push(/** @type {never} */ ({ url: "https://v1.tiktok.com/a.mp4" }));
    const results = element("result-table").querySelector("tbody");
    for (let number = 1; number <= module.MAX_RESULT_ROWS + 5; number += 1) results.append(resultRow(OTHER_ID, number, "done"));
    element("result-trimmed").hidden = true;
    engine.onSeriesDone?.(1, 2, run);
    assert.equal(record.inputs.length, 1); // what the report reads of it, taken
    assert.equal(record.inputs[0]?.seriesId, SERIES_ID);
    assert.ok(run.series?.episodes.every((ep) => ep.raw === null)); // then its list items let go of
    assert.equal(engine.downloader.traceOf(first.episode), null); // and its traces
    assert.equal(element("report-lines").children.length, 1); // its report line, as before
    assert.equal(results.children.length, module.MAX_RESULT_ROWS); // and the table held to the cap
    assert.equal(element("result-trimmed").hidden, false);
  } finally {
    page.restore();
  }
});

test("the page: a series whose rows all failed leaves no bare header behind when they move to the failed block", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const results = element("result-table").querySelector("tbody");
    results.append(headerRow(SERIES_ID), resultRow(SERIES_ID, 1, "failed"), resultRow(SERIES_ID, 2, "failed"), headerRow(OTHER_ID), resultRow(OTHER_ID, 1, "done"), resultRow(OTHER_ID, 2, "failed"));
    module.renderFailed([
      seriesRecord(SERIES_ID, "One", [[1, "failed", "boom"], [2, "failed", "boom"]]),
      seriesRecord(OTHER_ID, "Two", [[1, "done"], [2, "failed", "boom"]]),
    ]);
    const keys = (/** @type {FakeElement} */ row) => `${row.getAttribute("data-series-id")}:${row.getAttribute("data-number") ?? "header"}`;
    assert.deepEqual(results.children.map(keys), [`${OTHER_ID}:header`, `${OTHER_ID}:1`]);
    assert.equal(element("failed-table").querySelector("tbody").children.length, 3);
  } finally {
    page.restore();
  }
});

test("the page: once chrome.storage.local refuses a write nothing more is asked of TikTok — no listing, no thumbnail, no job — and the page says what to do", async () => {
  const page = await fakePage();
  try {
    const { element, module, local } = page;
    const engine = module.buildEngine({ ...BATCH_JOB }, { pauses: [], inputs: [], taking: true });
    assert.equal(await module.coversAllowed(), true);
    assert.equal(engine.unsaved?.(), null);
    const set = chrome.storage.local.set;
    Object.assign(chrome.storage.local, {
      set: async () => {
        throw new Error(REFUSED);
      },
    });
    try {
      await engine.persist?.(); // a save of the pacing, refused: never thrown, remembered
      assert.equal(engine.unsaved?.(), UNSAVED);
      // a listing asked for now makes no request: refused before the discovery's tab is even opened
      await assert.rejects(
        engine.discover({ kind: "series", seriesId: SERIES_ID, episodeHint: null, sourceUrl: SERIES_ID }),
        (error) => error instanceof StorageRefusedError && error.message === UNSAVED,
      );
      assert.equal(await module.coversAllowed(), false); // no thumbnail either
      // the popup's "Download this series": nothing queued, the page says why and what to do
      const finished = element("app-status").dataset["finished"];
      page.message({ type: "dramafetch:load", input: SERIES_ID });
      for (let turns = 0; turns < 20 && element("input-status").className !== "error"; turns += 1) await page.turn();
      assert.equal(element("input-status").textContent, `DramaFetch stopped: ${UNSAVED}. Chrome could not write to its profile folder — usually its disk is full. Free some space, restart Chrome and run again: what is already saved is skipped.`);
      assert.deepEqual(queuedLabels(page), []);
      assert.equal(element("app-status").dataset["finished"], finished);
      for (const id of ["load-button", "download-all-button", "download-available-button", "download-selected-button", "retry-button"]) {
        assert.equal(element(id).disabled, true, id);
      }
      // a cooldown in force that chrome.storage.local holds: it outlives a restart, the banner names its end
      const stored = Date.now() / 1000 + 600;
      local.set("cooldown", { until: stored, reason: "rate limited (HTTP 429) by the video server", source: "browser", recorded_at: stored - 1800 });
      element("input-status").className = "";
      page.message({ type: "dramafetch:load", input: SERIES_ID });
      for (let turns = 0; turns < 20 && element("input-status").className !== "error"; turns += 1) await page.turn();
      assert.equal(element("input-status").textContent, `DramaFetch stopped: ${UNSAVED}. Chrome could not write to its profile folder — usually its disk is full. Free some space, restart Chrome and run again: what is already saved is skipped.`);
      // a refusal by TikTok whose cooldown the storage refuses too: the advice names the wait's end, kept only in this browser session
      const recorded = await recordBlock(engine.cooldownStore, MEDIA_RATE_LIMIT_MESSAGE, "browser", { now: Date.now() / 1000 });
      assert.equal(/** @type {{until: number} | undefined} */ (local.get("cooldown"))?.until, stored); // not stored
      element("input-status").className = "";
      page.message({ type: "dramafetch:load", input: SERIES_ID });
      for (let turns = 0; turns < 20 && element("input-status").className !== "error"; turns += 1) await page.turn();
      const time = new Date(Math.floor(recorded.until) * 1000);
      const hhmm = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
      assert.equal(
        element("input-status").textContent,
        `DramaFetch stopped: ${UNSAVED}. Chrome could not write to its profile folder — usually its disk is full. TikTok also refused a request, and the wait until ${hhmm} could not be saved: free some space, restart Chrome or reload DramaFetch only after ${hhmm} and run again — what is already saved is skipped.`,
      );
      // a reset of the settings the storage refuses says so, instead of failing silently
      element("settings-reset").fire("click");
      for (let turns = 0; turns < 20 && element("settings-status").className !== "error"; turns += 1) await page.turn();
      assert.equal(element("settings-status").textContent, `Not saved: ${REFUSED}`);
      // the page holds the unsaved cooldown; while the disk is full its look stores nothing
      page.storageChanged("cooldown");
      for (let turns = 0; turns < 20 && element("cooldown-banner").hidden; turns += 1) await page.turn();
      assert.equal(element("cooldown-banner").hidden, false);
      assert.equal(await module.lookAgainAtCooldown(), false);
      // space freed: the next look (every COOLDOWN_LOOK_S s) stores it, and the advice drops "could not be saved"
      Object.assign(chrome.storage.local, { set });
      assert.equal(module.COOLDOWN_LOOK_S, 15);
      assert.equal(await module.lookAgainAtCooldown(), true);
      assert.equal(/** @type {{until: number} | undefined} */ (local.get("cooldown"))?.until, recorded.until);
      assert.equal(element("input-status").textContent, `DramaFetch stopped: ${UNSAVED}. Chrome could not write to its profile folder — usually its disk is full. Free some space, restart Chrome and run again: what is already saved is skipped.`);
      assert.equal(await module.lookAgainAtCooldown(), true); // stored: nothing more to do
    } finally {
      Object.assign(chrome.storage.local, { set });
      await clearCooldown(engine.cooldownStore); // the page's memory of it, which outlives this page's module
    }
  } finally {
    page.restore();
  }
});

test("the page: a cooldown the storage refuses is a refused write — the job's engine remembers it and nothing more is asked", async () => {
  const page = await fakePage();
  try {
    const { module } = page;
    const engine = module.buildEngine({ ...BATCH_JOB }, { pauses: [], inputs: [], taking: true });
    const set = chrome.storage.local.set;
    Object.assign(chrome.storage.local, {
      set: async () => {
        throw new Error(REFUSED);
      },
    });
    try {
      assert.equal(engine.unsaved?.(), null);
      const cooldown = await recordBlock(engine.cooldownStore, MEDIA_RATE_LIMIT_MESSAGE, "browser", { now: Date.now() / 1000 });
      assert.equal(cooldown.reason, MEDIA_RATE_LIMIT_MESSAGE); // in force all the same
      assert.equal(engine.unsaved?.(), UNSAVED);
      assert.equal(await module.coversAllowed(), false);
    } finally {
      Object.assign(chrome.storage.local, { set });
      await clearCooldown(engine.cooldownStore);
    }
  } finally {
    page.restore();
  }
});

/**
 * A finished series run as the engine hands it to the page, over `results` (its series listed:
 * every result's episode, plus `extra` episodes the run never reached).
 * @param {string} seriesId
 * @param {string | null} name
 * @param {import("../src/lib/report.js").DownloadResult[]} results
 * @returns {import("../src/app/engine.js").SeriesRun}
 */
function finishedRun(seriesId, name, results) {
  /** @type {import("../src/lib/catalog.js").Series} */
  const listed = { ...series(results.map((result) => result.episode), name ?? "", seriesId), name };
  return {
    ref: { kind: "series", seriesId, episodeHint: null, sourceUrl: seriesId },
    series: listed,
    results,
    report: seriesReport(listed, results, { name }),
    error: null,
    stop: false,
    exitCode: 0,
    errorKind: null,
    contacted: true,
  };
}

/** @type {import("../src/app/app.js").JobOutcome} */
const OUTCOME = {
  startedAt: "2026-11-06T19:00:00.000Z",
  finishedAt: "2026-11-06T19:30:00.000Z",
  error: null,
  stopped: null,
  refreshes: 0,
  pauses: [{ kind: "pace", seconds: 5, text: "pause 5 s" }],
};

/** The traces the fake downloader hands the report: the truncated one's for E02, none for the rest. */
const TRACES = {
  /** @param {import("../src/lib/catalog.js").Episode} ep */
  of: (ep) =>
    ep.number === 2
      ? {
          attempts: [
            {
              url: "https://v16-webapp-prime.tiktok.com/v/2.mp4",
              host: "v16-webapp-prime.tiktok.com",
              url_expiry: 99999999999,
              requested: true,
              redirect_hops: 0,
              http_status: 200,
              content_type: "video/mp4",
              content_length: 131072,
              received_bytes: 100000,
              outcome: "truncated body (100000 of 131072 bytes)",
            },
          ],
          refreshes: [],
        }
      : { attempts: [], refreshes: [] },
};

/** The rows of the report tests' run: a done episode, a truncated one, a locked one, one the stop left. */
function reportRows() {
  const truncated = "download looks incomplete or wrong: truncated body (100000 of 131072 bytes) from v16-webapp-prime.tiktok.com";
  const lockedEpisode = episode(3, { locked: true });
  lockedEpisode.lockHints = ["isLocked=True", "no play address"];
  return [
    { episode: episode(1), status: /** @type {const} */ ("done"), path: "/home/me/Downloads/DramaFetch/E1.mp4", message: "saved E1.mp4 (0.1 MiB)", downloadId: 1 },
    { episode: episode(2), status: /** @type {const} */ ("failed"), path: null, message: truncated },
    { episode: lockedEpisode, status: /** @type {const} */ ("skipped-locked"), path: null, message: "looks locked: isLocked=True; no play address" },
    { episode: episode(4), status: /** @type {const} */ ("failed"), path: null, message: "stopped: three failures in a row" },
  ];
}

test("the page: at a job's end with failures the report is saved once under DramaFetch/reports, named and parseable; nothing for a listing or a clean job", async () => {
  const page = await fakePage();
  try {
    const { element, module, downloads } = page;
    assert.equal(element("setting-report").checked, true); // the setting, on by default
    assert.equal(element("report-button").disabled, true);
    const before = new Date();
    await module.reportJobEnd({ kind: "selection", label: "4 episodes of Test Series" }, OUTCOME, [finishedRun(SERIES_ID, "Test Series", reportRows())], TRACES.of);
    assert.equal(downloads.length, 1);
    const [saved] = downloads;
    assert.ok(saved !== undefined);
    assert.match(saved.filename, /^DramaFetch\/reports\/Test Series - did not download \d{4}-\d{2}-\d{2} \d{4}\.json$/);
    const stamp = saved.filename.slice("DramaFetch/reports/Test Series - did not download ".length, -".json".length);
    const two = (/** @type {number} */ n) => String(n).padStart(2, "0");
    assert.equal(stamp, `${before.getFullYear()}-${two(before.getMonth() + 1)}-${two(before.getDate())} ${two(before.getHours())}${two(before.getMinutes())}`);
    assert.equal(saved.conflictAction, "uniquify");
    assert.equal(element("failed-report").hidden, false);
    assert.equal(element("failed-report").textContent, `Report saved: ${saved.filename.slice("DramaFetch/reports/".length)}`);
    assert.equal(element("failed-report").className, "meta");
    assert.equal(element("report-button").disabled, false);
    const report = JSON.parse(saved.text);
    assert.equal(report.dramafetch_report, 1);
    assert.equal(report.extension_version, JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")).version);
    assert.deepEqual(report.browser, { user_agent: "FakeChrome/1", language: "en" });
    assert.equal(report.test_mode, false);
    assert.deepEqual(report.job, {
      kind: "selection",
      label: "4 episodes of Test Series",
      started_at: OUTCOME.startedAt,
      finished_at: OUTCOME.finishedAt,
      error: null,
      stopped: null,
      refreshes: 0,
      pauses: OUTCOME.pauses,
    });
    assert.equal(report.series.length, 1);
    const [run] = report.series;
    assert.equal(run.series_id, SERIES_ID);
    assert.equal(run.name, "Test Series");
    assert.equal(run.listed, 4);
    assert.deepEqual(run.access_counts, { free: 3, unlocked: 0, locked: 1 });
    assert.equal(run.status, "incomplete");
    assert.equal(typeof run.line, "string");
    assert.deepEqual(
      run.not_downloaded.map((/** @type {Record<string, unknown>} */ row) => [row["number"], row["status"], row["attempted"]]),
      [
        [2, "failed", true],
        [3, "skipped-locked", false],
        [4, "failed", false],
      ],
    );
    const [truncated, locked, stopped] = run.not_downloaded;
    assert.ok(String(truncated.probable_cause).startsWith(CUT_SHORT_CAUSE_PREFIX));
    assert.equal(truncated.attempts.length, 1);
    assert.equal(truncated.attempts[0].received_bytes, 100000);
    assert.ok(String(locked.probable_cause).startsWith(`${LOCKED_CAUSE_PREFIX}isLocked=True; no play address`));
    assert.deepEqual(locked.raw, { id: "item3", video: { playAddr: "" } }); // the list entry as served
    assert.ok(String(stopped.probable_cause).startsWith(NOT_ATTEMPTED_CAUSE));
    assert.equal(run.reference.number, 1);
    assert.equal(run.reference.status, "done");
    // the digest of every LISTED episode (the fake run's list is its results' episodes), from their raw items
    assert.deepEqual(
      run.episodes_digest.map((/** @type {Record<string, unknown>} */ entry) => [entry["number"], entry["access"], entry["lock_hints"]]),
      [
        [1, "free", []],
        [2, "free", []],
        [3, "locked", ["isLocked=True", "no play address"]],
        [4, "free", []],
      ],
    );
    assert.deepEqual(Object.keys(run.episodes_digest[0]), ["number", "access", "lock_hints", "duration_s", "music_duration_s", "music_original", "size", "bitrate", "is_preview", "preview_type"]);
    assert.deepEqual(run.episodes_digest[0], { number: 1, access: "free", lock_hints: [], duration_s: 3, music_duration_s: null, music_original: null, size: null, bitrate: null, is_preview: null, preview_type: null });
    assert.equal(report.summary.length, 3);
    // the signed links live in the raw items only: no attempt keeps its query, and outside `raw` no signed link remains
    const attempts = run.not_downloaded.flatMap((/** @type {{attempts: Record<string, unknown>[]}} */ row) => row.attempts);
    assert.equal(attempts.length, 1);
    assert.ok(attempts.every((/** @type {Record<string, unknown>} */ attempt) => !String(attempt.url).includes("?") && !JSON.stringify(attempt).includes("expire=")));
    assert.ok(!JSON.stringify(report, (key, value) => (key === "raw" ? undefined : value)).includes("?expire="));
    assert.ok(!saved.text.includes("sessionid"));
    // the manual button saves it again (a second file: uniquify is Chrome's)
    element("report-button").fire("click");
    for (let turns = 0; turns < 20 && downloads.length < 2; turns += 1) await page.turn();
    assert.equal(downloads.length, 2);
    assert.equal(downloads[1]?.filename, saved.filename);
    assert.deepEqual(JSON.parse(/** @type {string} */ (downloads[1]?.text)), report);
    // a listing never has a report, nor a job that produced no run; the button goes back to disabled
    await module.reportJobEnd({ kind: "load", label: "List series" }, OUTCOME, [finishedRun(SERIES_ID, "Test Series", reportRows())], TRACES.of);
    await module.reportJobEnd({ kind: "batch", label: "2 series" }, OUTCOME, null, TRACES.of);
    assert.equal(downloads.length, 2);
    assert.equal(element("report-button").disabled, true);
    // a job in which nothing failed: no report (a locked skip alone is no failure)
    const clean = reportRows().filter((row) => row.status !== "failed");
    await module.reportJobEnd({ kind: "selection", label: "clean" }, OUTCOME, [finishedRun(SERIES_ID, "Test Series", clean)], TRACES.of);
    assert.equal(downloads.length, 2);
    assert.equal(element("report-button").disabled, true);
    // several series: the file is named after their count
    await module.reportJobEnd(
      { kind: "batch", label: "2 series" },
      OUTCOME,
      [finishedRun(SERIES_ID, "Test Series", reportRows()), finishedRun(OTHER_ID, null, [{ episode: episode(1, { seriesId: OTHER_ID }), status: "done", path: "/x", message: "saved" }])],
      TRACES.of,
    );
    assert.equal(downloads.length, 3);
    assert.match(/** @type {string} */ (downloads[2]?.filename), /^DramaFetch\/reports\/2 series - did not download /);
    assert.equal(JSON.parse(/** @type {string} */ (downloads[2]?.text)).summary[0].startsWith("Test Series: E02 failed — "), true);
  } finally {
    page.restore();
  }
});

test("the page: with the report setting off nothing is saved at a job's end, and Save the report saves it once on demand", async () => {
  const page = await fakePage({ storage: { settings: { report: false } } });
  try {
    const { element, module, downloads } = page;
    assert.equal(element("setting-report").checked, false);
    await module.reportJobEnd({ kind: "selection", label: "4 episodes" }, OUTCOME, [finishedRun(SERIES_ID, "Test Series", reportRows())], TRACES.of);
    assert.deepEqual(downloads, []);
    assert.equal(element("failed-report").textContent, ""); // (hidden in the page's HTML: the fake element has no default)
    assert.equal(element("report-button").disabled, false);
    element("report-button").fire("click");
    for (let turns = 0; turns < 20 && downloads.length < 1; turns += 1) await page.turn();
    assert.equal(downloads.length, 1);
    assert.match(/** @type {string} */ (downloads[0]?.filename), /^DramaFetch\/reports\/Test Series - did not download /);
    assert.equal(element("failed-report").hidden, false);
    assert.ok(String(element("failed-report").textContent).startsWith("Report saved: Test Series - did not download "));
    // a save Chrome refuses only shows why, as an error line
    const api = /** @type {{download: () => Promise<number>}} */ (/** @type {unknown} */ (globalThis.chrome.downloads));
    api.download = async () => {
      throw new Error("FILE_FAILED");
    };
    element("report-button").fire("click");
    await page.turn();
    assert.equal(element("failed-report").textContent, "The report could not be saved: FILE_FAILED");
    assert.equal(element("failed-report").className, "meta error");
  } finally {
    page.restore();
  }
});
