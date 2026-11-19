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
import { DRM_MESSAGE, LIST_RATE_LIMIT_MESSAGE, MEDIA_RATE_LIMIT_MESSAGE, shortServedMessage } from "../src/lib/messages.js";
import { PacingState, pacingOptions } from "../src/lib/pacing.js";
import { profileHandleOf } from "../src/lib/library.js";
import { completeSkip, seriesReport } from "../src/lib/report.js";
import { donePath, markComplete, missingFiles, newState, record } from "../src/lib/state.js";
import {
  ChallengeError,
  DISCOVERY_TAB_KEY,
  LOGIN_REDIRECT_MESSAGE,
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
import { STORAGE_REFUSED_PREFIX, StopRequested, StorageRefusedError, downloadSeries, runBatch, runSelectionJob } from "../src/app/engine.js";
import { BOOKMARK_MESSAGES } from "../src/app/bookmark.js";
import { FAVORITES_RATE_LIMIT_MESSAGE } from "../src/app/favorites.js";
import { historyEntry as storedHistoryEntry } from "../src/app/storage.js";
import { TabKeeper } from "../src/app/tabkeeper.js";

const TINY = readFileSync(new URL("../../tests/fixtures/tiny.mp4", import.meta.url));
const SERIES_ID = "7699393770256782354";
/** The fake extension's own origin (`chrome.runtime.getURL("")`): its pages and its worker live under it. */
const EXTENSION_ROOT = "chrome-extension://dramafetch-test-id/";
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

test("a listing refused because nothing could be stored is a storage stop, never a request; a re-discovery refused so fails its episode with no further URL after a requested one, and stops the series before any request", async () => {
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
    /** whether a `<dialog>` is open */
    this.open = false;
    /** @type {number | undefined} how many times the page scrolled it into view */
    this.scrolledIntoView = undefined;
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
  /** A `<dialog>` opened as a modal (the confirmation of Remove from Favorites). */
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  scrollIntoView() {
    this.scrolledIntoView = (this.scrolledIntoView ?? 0) + 1;
  }
  /** Its place taken by another row (the fake keeps no parent: the new row is not kept). */
  replaceWith() {}
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
 * anything; `message()` is a runtime message from this extension's own popup (or from the
 * extension its `sender` names, or from the `sender` given whole: a TikTok page, the worker), and
 * returns the page's answers; `local` is the storage and
 * `storageChanged(key)` tells the page a key of it changed; `downloads` is every file the page
 * saved through `chrome.downloads` (a fake that completes each at once); `restore()` removes the
 * fakes again. With `options.lockTaken`, another tab holds the engine: this one is
 * read-only. With `options.search`, the page opens with that address query (the worker's hand-over
 * no running page took); `replaced` is every address `history.replaceState` gave it, and
 * `sessionKeys` every key it asked `chrome.storage.session` for. With `options.testSettings`, the
 * page is the test harness' copy (`dramafetch_test` in its manifest) with those test settings —
 * a job then runs without Chrome's 10 s between two file checks. With `options.session`,
 * `chrome.storage.session` holds those keys from the start (the browser session's memory: the
 * library's covers, say) and keeps what the page writes; without it, it holds nothing.
 * @param {{storage?: Record<string, unknown>, lockTaken?: boolean, search?: string, testSettings?: Record<string, unknown>, session?: Record<string, unknown>}} [options]
 */
async function fakePage(options = {}) {
  /** @type {Record<string, CatalogEntry>} */
  const catalog = JSON.parse(readFileSync(new URL("../_locales/en/messages.json", import.meta.url), "utf8"));
  /** @type {Record<string, unknown>} */
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  if (options.testSettings !== undefined) manifest["dramafetch_test"] = true;
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
  if (options.testSettings !== undefined) local.set("testSettings", options.testSettings);
  /** @type {((changes: Record<string, unknown>, area: string) => void)[]} */
  const changeListeners = [];
  /** @type {((message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => void)[]} */
  const messageListeners = [];
  /** @type {{filename: string, conflictAction: string | undefined, text: string}[]} every file the page saved through chrome.downloads, its bytes as text */
  const downloads = [];
  /** @type {string[]} every address `history.replaceState` gave the page */
  const replaced = [];
  /** @type {unknown[]} every key the page asked `chrome.storage.session` for */
  const sessionKeys = [];
  /** @type {Map<string, unknown> | null} chrome.storage.session, when the test seeds it */
  const sessionStore = options.session === undefined ? null : new Map(Object.entries(options.session));
  const address = { search: options.search ?? "", pathname: "/src/app/app.html" };
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
      getURL: (/** @type {string} */ path) => `${EXTENSION_ROOT}${path}`,
      onMessage: {
        /** @param {(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => void} listener */
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
      session: {
        get: async (/** @type {unknown} */ keys) => {
          sessionKeys.push(keys);
          /** @type {Record<string, unknown>} */
          const found = {};
          if (sessionStore === null) return found;
          for (const key of Array.isArray(keys) ? keys : [keys]) if (typeof key === "string" && sessionStore.has(key)) found[key] = sessionStore.get(key);
          return found;
        },
        /** @param {Record<string, unknown>} items */
        set: async (items) => {
          if (sessionStore !== null) for (const [key, value] of Object.entries(items)) sessionStore.set(key, value);
        },
        remove: async (/** @type {string} */ key) => void sessionStore?.delete(key),
      },
      onChanged: {
        /** @param {(changes: Record<string, unknown>, area: string) => void} listener */
        addListener: (listener) => void changeListeners.push(listener),
      },
    },
    tabs: {
      getCurrent: () => (holding ? new Promise(() => undefined) : Promise.resolve({ id: 1, windowId: 10 })),
      update: async () => undefined,
    },
    // a job the page starts itself gets past its header rule (`downloader.applyRefererRule`)
    declarativeNetRequest: { updateSessionRules: async () => undefined },
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
        request: (name, _options, callback) => Promise.resolve(callback(options.lockTaken ? null : { name })),
      },
    },
  });
  Object.assign(globalThis, {
    document,
    chrome,
    location: address,
    history: {
      /** @param {unknown} _state @param {string} _unused @param {string} url */
      replaceState: (_state, _unused, url) => {
        replaced.push(url);
        address.search = "";
      },
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    // the library's covers are watched as the cards come into view: nothing is ever in view here,
    // so no cover is ever requested
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    CSS: { escape: (/** @type {string} */ value) => value.replace(/["\\]/g, "\\$&") },
    setInterval: () => 0, // the page's one-second tick: never armed, so that the test process can exit
  });
  const restore = () => {
    for (const name of ["document", "chrome", "location", "history", "MutationObserver", "IntersectionObserver", "CSS"]) Reflect.deleteProperty(globalThis, name);
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
    replaced,
    sessionKeys,
    /**
     * `chrome.storage.local` changed `key` (the page reads it again): the cooldown ending, say — or,
     * with `area` `session`, the browser session's memory (a TikTok tab's favorites address the
     * worker kept, say).
     * @param {string} key
     * @param {"local" | "session"} [area]
     */
    storageChanged: (key, area = "local") => {
      for (const listener of changeListeners) listener({ [key]: {} }, area);
    },
    hold: () => {
      holding = true;
    },
    /**
     * A runtime message from `sender` — by default this extension's own popup; a string is the
     * popup of the extension of that id; an object is the whole sender (the worker, a TikTok page
     * where the content script runs) —; what the page answers (the worker's openApp brings the
     * answering tab to the front).
     * @param {unknown} message
     * @param {string | chrome.runtime.MessageSender} [sender]
     * @returns {unknown[]}
     */
    message: (message, sender = chrome.runtime.id) => {
      /** @type {chrome.runtime.MessageSender} */
      const from = typeof sender === "string" ? { id: sender, url: `chrome-extension://${sender}/src/app/popup.html` } : sender;
      /** @type {unknown[]} */
      const answers = [];
      for (const listener of messageListeners) listener(message, from, (answer) => void answers.push(answer));
      return answers;
    },
  };
}

test("the page: a series handed over (the popup, the right-click) joins the box and is listed; the engine's tab answers with its tab; a read-only tab stays silent", async () => {
  const page = await fakePage();
  try {
    const { element } = page;
    const other = "7699393770256782399";
    const third = "7699393770256782388";
    const links = element("links");
    const status = element("input-status");
    const queued = () => element("queue-list").children.map((item) => item.textContent);
    page.hold(); // the job's `tabs.getCurrent` never answers: it runs, and makes no request
    // a batch typed for Download all stays: the series joins it on a line of its own
    const batch = `https://www.tiktok.com/shortdrama/episode/${other}/1\nhttps://www.tiktok.com/shortdrama/episode/${third}/1\n`;
    links.value = batch;
    assert.deepEqual(page.message({ type: "dramafetch:load", input: SERIES_ID }), [{ ok: true, tabId: 1 }]);
    await page.turn();
    assert.equal(links.value, `${batch.trimEnd()}\n${SERIES_ID}`);
    assert.equal(element("progress-current").textContent, `List series ${SERIES_ID}`);
    // a series the box names already is listed without a second line
    assert.deepEqual(page.message({ type: "dramafetch:load", input: other }), [{ ok: true, tabId: 1 }]);
    assert.equal(links.value, `${batch.trimEnd()}\n${SERIES_ID}`);
    assert.deepEqual(queued(), [`List series ${other}`]);
    // an address that names no series changes nothing in the box: the tab says why (about the
    // link, not about the box's first line) and still answers, so that it comes to the front
    assert.deepEqual(page.message({ type: "dramafetch:load", input: "https://www.tiktok.com/shortdrama/foryou" }), [{ ok: true, tabId: 1 }]);
    assert.equal(links.value, `${batch.trimEnd()}\n${SERIES_ID}`);
    assert.equal(status.className, "status error");
    assert.match(String(status.textContent), /^Not a TikTok short-drama or video URL: 'https:\/\/www\.tiktok\.com\/shortdrama\/foryou'/);
    assert.deepEqual(queued(), [`List series ${other}`]);
    // only this extension's own code is heard, and only this message
    const fourth = "7699393770256782344";
    assert.deepEqual(page.message({ type: "dramafetch:load", input: fourth }, "another-extension-id"), []);
    assert.deepEqual(page.message({ type: "dramafetch:open", input: fourth }), []);
    assert.deepEqual(page.message("dramafetch:load"), []);
    assert.equal(links.value, `${batch.trimEnd()}\n${SERIES_ID}`);
    assert.deepEqual(queued(), [`List series ${other}`]);
  } finally {
    page.restore();
  }
  const readonly = await fakePage({ lockTaken: true });
  try {
    assert.deepEqual(readonly.message({ type: "dramafetch:load", input: SERIES_ID }), []);
    assert.equal(readonly.element("links").value, "");
    assert.equal(readonly.element("queue-card").hidden, true);
  } finally {
    readonly.restore();
  }
});

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
      for (let turns = 0; turns < 20 && element("input-status").className !== "status error"; turns += 1) await page.turn();
      assert.equal(element("input-status").textContent, `DramaFetch stopped: ${UNSAVED}. Chrome could not write to its profile folder — usually its disk is full. Free some space, restart Chrome and run again: what is already saved is skipped.`);
      assert.deepEqual(queuedLabels(page), []);
      assert.equal(element("app-status").dataset["finished"], finished);
      for (const id of ["load-button", "download-all-button", "download-available-button", "download-selected-button", "retry-button"]) {
        assert.equal(element(id).disabled, true, id);
      }
      /** @param {number} until @returns {string} the page's HH:MM of a cooldown's end */
      const clock = (until) => {
        const time = new Date(Math.floor(until) * 1000);
        return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
      };
      /** @param {number} until @returns {string} the advice for a stored wait: its end named all the same */
      const storedWaitAdvice = (until) =>
        `DramaFetch stopped: ${UNSAVED}. Chrome could not write to its profile folder — usually its disk is full. TikTok also refused a request: free some space, restart Chrome or reload DramaFetch only after ${clock(until)} and run again — what is already saved is skipped.`;
      // a cooldown in force that chrome.storage.local holds: its end is named all the same — what Chrome
      // accepts after a refused write may not survive a restart — without saying it was not saved
      const stored = Date.now() / 1000 + 600;
      local.set("cooldown", { until: stored, reason: "rate limited (HTTP 429) by the video server", source: "browser", recorded_at: stored - 1800 });
      element("input-status").className = "";
      page.message({ type: "dramafetch:load", input: SERIES_ID });
      for (let turns = 0; turns < 20 && element("input-status").className !== "status error"; turns += 1) await page.turn();
      assert.equal(element("input-status").textContent, storedWaitAdvice(stored));
      // a refusal by TikTok whose cooldown the storage refuses too: the advice names the wait's end, kept only in this browser session
      const recorded = await recordBlock(engine.cooldownStore, MEDIA_RATE_LIMIT_MESSAGE, "browser", { now: Date.now() / 1000 });
      assert.equal(/** @type {{until: number} | undefined} */ (local.get("cooldown"))?.until, stored); // not stored
      element("input-status").className = "";
      page.message({ type: "dramafetch:load", input: SERIES_ID });
      for (let turns = 0; turns < 20 && element("input-status").className !== "status error"; turns += 1) await page.turn();
      const hhmm = clock(recorded.until);
      assert.equal(
        element("input-status").textContent,
        `DramaFetch stopped: ${UNSAVED}. Chrome could not write to its profile folder — usually its disk is full. TikTok also refused a request, and the wait until ${hhmm} could not be saved: free some space, restart Chrome or reload DramaFetch only after ${hhmm} and run again — what is already saved is skipped.`,
      );
      // a reset of the settings the storage refuses says so, instead of failing silently
      element("settings-reset").fire("click");
      for (let turns = 0; turns < 20 && element("settings-status").className !== "status error"; turns += 1) await page.turn();
      assert.equal(element("settings-status").textContent, `Not saved: ${REFUSED}`);
      // the page holds the unsaved cooldown; while the disk is full its look stores nothing
      page.storageChanged("cooldown");
      for (let turns = 0; turns < 20 && element("cooldown-banner").hidden; turns += 1) await page.turn();
      assert.equal(element("cooldown-banner").hidden, false);
      assert.equal(await module.lookAgainAtCooldown(), false);
      // space freed: the next look (every COOLDOWN_LOOK_S s) stores it, and the advice drops "could not be saved" — never the wait's end
      Object.assign(chrome.storage.local, { set });
      assert.equal(module.COOLDOWN_LOOK_S, 15);
      assert.equal(await module.lookAgainAtCooldown(), true);
      assert.equal(/** @type {{until: number} | undefined} */ (local.get("cooldown"))?.until, recorded.until);
      assert.equal(element("input-status").textContent, storedWaitAdvice(recorded.until));
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
      // the cooldown lifted and writes working again: the noted refusal alone still keeps the page from asking anything
      Object.assign(chrome.storage.local, { set });
      await clearCooldown(engine.cooldownStore);
      assert.equal((await module.coversAllowed()), false);
      page.message({ type: "dramafetch:load", input: SERIES_ID });
      for (let turns = 0; turns < 20 && page.element("input-status").className !== "status error"; turns += 1) await page.turn();
      assert.deepEqual(queuedLabels(page), []);
      const status = String(page.element("input-status").textContent);
      assert.ok(status.startsWith(`DramaFetch stopped: ${UNSAVED}.`), status);
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

// ------------------------------------------------------------- the user's TikTok favorites

/** The user's TikTok tab that showed its favorites list, and that list's own first request. */
const FAVORITES_TAB = 42;
const FAVORITES_TEMPLATE =
  "https://www.tiktok.com/api/user/favorite/drama_list/?WebIdLastTime=1794300000&aid=1988&count=19&cursor=0&X-Bogus=DFSzswVOxQ";
/** @type {Record<string, unknown>} the anonymized capture: three dramas, two of the same title */
const FAVORITES_CAPTURE = JSON.parse(readFileSync(new URL("../../tests/fixtures/drama_list_page.json", import.meta.url), "utf8"));
const LIGHTHOUSE = "7712345678901234561";
const SNOW_A = "7712345678901234562";
const SNOW_B = "7712345678901234563";
const PAPER = "7712345678901234564";
const MOON = "7712345678901234565";

/**
 * The favorites list TikTok serves the tab, by cursor: the capture's page, then a last one.
 * @returns {Record<string, unknown>}
 */
function favoritesPages() {
  const [shape] = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
  /** @param {string} seriesId @param {string} title @param {number} episodes @param {string} seconds */
  const item = (seriesId, title, episodes, seconds) => ({ ...shape, dramaID: seriesId, dramaName: title, numVideos: episodes, totalDuration: seconds });
  return {
    "0": FAVORITES_CAPTURE,
    "1794351568": { ...FAVORITES_CAPTURE, cursor: "1794350100", hasMore: false, total: "5", dramaList: [item(PAPER, "Paper Crowns", 30, "1500"), item(MOON, "Moonlight Over the Harbor", 12, "")] },
  };
}

/**
 * The user's TikTok tab on the page's fake chrome: `tabs.get` (its address: the profile, or
 * `options.tabUrl` — TikTok's login page, say), `scripting.executeScript` (the list's pages by
 * cursor in the MAIN world, its text in the ISOLATED world), and `storage.session`, where the
 * worker keeps the tab's favorites address (`remember(at)`) with the `@handle` of the page that
 * asked for it — the tab's address then (`profile`: another one when given).
 * @param {{pages?: Record<string, unknown>, tabUrl?: string}} [options]
 */
function favoritesTab(options = {}) {
  const pages = options.pages ?? favoritesPages();
  /** @type {string[]} the URLs fetched from inside the tab */
  const fetched = [];
  /** @type {Map<string, unknown>} */
  const session = new Map();
  const fake = /** @type {Record<string, Record<string, unknown>>} */ (/** @type {unknown} */ (globalThis.chrome));
  const tabUrl = options.tabUrl ?? "https://www.tiktok.com/@invented_viewer";
  Object.assign(fake["tabs"] ?? {}, {
    get: async (/** @type {number} */ tabId) => ({ id: tabId, index: 0, windowId: 1, active: false, url: tabUrl }),
  });
  fake["scripting"] = {
    executeScript: async (/** @type {chrome.scripting.ScriptInjection<unknown[], unknown>} */ injection) => {
      if (injection.world !== "MAIN") return [{ frameId: 0, result: "Invented Viewer" }];
      const [url] = /** @type {[string]} */ (injection.args);
      fetched.push(url);
      const cursor = /[?&]cursor=([^&]*)/.exec(url)?.[1] ?? "";
      return [{ frameId: 0, result: JSON.parse(JSON.stringify(pages[cursor] ?? { __dramafetch_status: 404, __dramafetch_text: "" })) }];
    },
  };
  fake["storage"] = {
    ...fake["storage"],
    session: {
      get: async (/** @type {string} */ key) => (session.has(key) ? { [key]: session.get(key) } : {}),
      set: async (/** @type {Record<string, unknown>} */ items) => {
        for (const [key, value] of Object.entries(items)) session.set(key, value);
      },
      remove: async (/** @type {string} */ key) => void session.delete(key),
    },
  };
  return {
    fetched,
    /** the browser session's memory (`chrome.storage.session`): the favorites address, the library's covers */
    session,
    /**
     * @param {number} at when the tab's own drama_list request completed (seconds)
     * @param {string | null} [profile] whose list it reads, as the worker recorded it: the tab's address's handle by default
     */
    remember: (at, profile = profileHandleOf(tabUrl)) => session.set(`favoritesTemplate:${FAVORITES_TAB}`, { url: FAVORITES_TEMPLATE, at, profile }),
  };
}

/**
 * A job's engine as the page builds it, with the pauses recorded instead of slept, the rng at its
 * floor, a fake listing of a series (what it was asked to list) and a view of Chrome's downloads
 * that knows no file.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {import("../src/app/app.js").Job} job
 */
function favoritesEngine(page, job) {
  const engine = page.module.buildEngine(job, { pauses: [], inputs: [], taking: true });
  /** @type {number[]} */
  const pauses = [];
  /** @type {string[]} */
  const listed = [];
  engine.sleep = async (seconds) => void pauses.push(seconds);
  engine.rng = { uniform: (low) => low };
  engine.discover = async (ref) => {
    listed.push(ref.seriesId);
    /** @param {number} number */
    const plain = (number) => makeEpisode({ number, itemId: `${ref.seriesId.slice(-4)}0${number}`, title: `Episode ${number}`, seriesId: ref.seriesId, durationS: 3, coverUrl: null, raw: {} });
    return series([plain(1), plain(2), plain(3)], `Series ${ref.seriesId}`, ref.seriesId);
  };
  engine.view = /** @type {import("../src/app/downloader.js").DownloadsView} */ (
    /** @type {unknown} */ ({ exists: () => false, refresh: async () => undefined, completedAt: () => null, remember() {} })
  );
  return { engine, pauses, listed };
}

/**
 * A job as the page queues it.
 * @param {"favorites" | "load"} kind
 * @param {import("../src/lib/favorites.js").Card | null} card
 * @returns {import("../src/app/app.js").Job}
 */
const favoritesJob = (kind, card) => ({ id: 1, kind, label: kind, refs: [], series: null, numbers: [], includeLocked: false, recheck: false, favoritesTab: FAVORITES_TAB, card });

/**
 * An element and everything appended under it, depth first.
 * @param {FakeElement} element
 * @returns {FakeElement[]}
 */
const descendants = (element) => [element, ...element.children.flatMap(descendants)];

/**
 * The part of `element` (itself or below it) whose class list holds `className`.
 * @param {FakeElement} element
 * @param {string} className
 * @returns {FakeElement | undefined}
 */
const partOf = (element, className) => descendants(element).find((part) => ` ${part.className} `.includes(` ${className} `));

/**
 * The library's cards the grid shows (1.5.0's panel rows, on the 1.6.0 card grid): `[series id,
 * title, episodes and length, status, ticked, shown]` — the status the card's badge carries
 * (`on-disk`, `partly`, `none`, `queued`, `running`, `removed`), `shown` true for every card drawn:
 * a drama the search or a status filter leaves out has no card at all.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 */
const favoriteRows = (page) =>
  page.element("favorites-grid").children.map((card) => [
    card.getAttribute("data-series-id"),
    partOf(card, "favorite-title")?.textContent,
    partOf(card, "favorite-meta")?.textContent,
    partOf(card, "favorite-status")?.getAttribute("data-status") ?? null,
    descendants(card).find((part) => part.tagName === "INPUT")?.checked ?? false,
    true,
  ]);

/**
 * A drama's tick in the library's grid, when its card is drawn.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {string} seriesId
 * @returns {FakeElement | undefined}
 */
const tickOf = (page, seriesId) => {
  const card = page.element("favorites-grid").children.find((article) => article.getAttribute("data-series-id") === seriesId);
  return card === undefined ? undefined : descendants(card).find((part) => part.tagName === "INPUT");
};

test("the page: List favorites reads every page of the tab's list after a pause each, fills the panel as pages arrive — episodes and length, the records' status —, filters, selects the shown ones and adds them to the box; nothing asked of TikTok without the tab's favorites address", async () => {
  const complete = newState(LIGHTHOUSE, "The Lighthouse Keeper's Promise");
  const partly = newState(SNOW_B, "Snowfall in Two Cities");
  for (const [state, numbers] of /** @type {[import("../src/lib/state.js").SeriesState, number[]][]} */ ([[complete, Array.from({ length: 60 }, (_, index) => index + 1)], [partly, [1]]])) {
    for (const number of numbers) {
      record(state, { episode: { number, itemId: `i${number}` }, status: "done", path: `/dl/E${number}.mp4`, message: "done", downloadId: number }, { exists: () => true, now: 1_800_000_000 });
    }
  }
  markComplete(complete, 1_800_000_100, 60); // a whole-series run saved all 60 the list names
  const page = await fakePage({ storage: { [`series:${LIGHTHOUSE}`]: complete, [`series:${SNOW_B}`]: partly } });
  try {
    const { element, module } = page;
    element("favorites-card").hidden = true; // as app.html has it (the fake's elements start shown)
    const tab = favoritesTab();
    const job = favoritesJob("favorites", null);
    // the worker saw no favorites list in that tab: the page says what to do, and asks nothing
    let { engine, pauses } = favoritesEngine(page, job);
    /** @type {Record<string, unknown>} */
    let entry = {};
    assert.equal(await module.runFavorites(job, engine, entry), null);
    assert.deepEqual(tab.fetched, []);
    assert.deepEqual(pauses, []);
    const noTemplate = String(page.catalog["favoritesNoTemplate"]?.message);
    assert.equal(element("input-status").textContent, noTemplate);
    assert.equal(element("input-status").className, "status error");
    assert.equal(entry["error"], noTemplate);
    assert.equal(element("favorites-card").hidden, true); // nothing listed: the panel stays hidden, empty
    assert.equal(element("favorites-count").textContent, "");
    assert.equal(element("favorites-grid").children.length, 0);

    // seen: every page, each after its pause, the template with only its cursor changed
    tab.remember(1_794_351_500);
    ({ engine, pauses } = favoritesEngine(page, job));
    entry = {};
    assert.equal(await module.runFavorites(job, engine, entry), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE, FAVORITES_TEMPLATE.replace("cursor=0", "cursor=1794351568")]);
    assert.deepEqual(pauses, [0.8, 0.8]);
    assert.equal(job.contacted, true); // the rest between jobs counts this job
    assert.equal(element("favorites-card").hidden, false); // shown by the listing
    for (let turns = 0; turns < 10; turns += 1) await page.turn(); // the records' statuses
    assert.deepEqual(favoriteRows(page), [
      [LIGHTHOUSE, "The Lighthouse Keeper's Promise", "60 episodes · 1h 19m", "on-disk", false, true],
      [SNOW_A, "Snowfall in Two Cities", "60 episodes · 1h 37m", "none", false, true],
      [SNOW_B, "Snowfall in Two Cities", "60 episodes · 1h 37m", "partly", false, true],
      [PAPER, "Paper Crowns", "30 episodes · 25m", "none", false, true],
      [MOON, "Moonlight Over the Harbor", "12 episodes", "none", false, true],
    ]);
    assert.equal(element("favorites-count").textContent, "5 favorite dramas listed.");
    // 1.6.0's guidance (`favoritesLoaded`): the library's own Download selected dramas first, the box second
    assert.equal(element("input-status").textContent, "5 favorite dramas listed: tick the ones to download and press Download selected dramas (or Add selected to the box).");
    assert.equal(entry["favorites"], 5);
    assert.equal(entry["error"], undefined);
    assert.equal(element("favorites-add-button").disabled, true); // nothing ticked yet

    // the search (letter case aside), then "select all shown": only the two shown are ticked — the
    // library still holds all five
    element("favorites-filter").value = "SNOWFALL";
    element("favorites-filter").fire("input");
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [SNOW_A, SNOW_B]);
    assert.equal(element("library-chip-all").textContent, "All · 5");
    element("favorites-select-all").checked = true;
    element("favorites-select-all").fire("change");
    assert.deepEqual(favoriteRows(page).filter(([, , , , ticked]) => ticked).map(([id]) => id), [SNOW_A, SNOW_B]);
    assert.equal(element("favorites-selection").textContent, "2 selected · 120 episodes");
    assert.equal(element("favorites-add-button").disabled, false);
    // one more ticked by hand, with the search cleared
    element("favorites-filter").value = "";
    element("favorites-filter").fire("input");
    assert.deepEqual(favoriteRows(page).filter(([, , , , ticked]) => ticked).map(([id]) => id), [SNOW_A, SNOW_B]); // the ticks are the dramas'
    const paper = tickOf(page, PAPER);
    assert.ok(paper !== undefined);
    paper.checked = true;
    paper.fire("change");
    // Add selected to the box: a `# <title>` line above each id, below what the box holds; nothing downloaded
    element("links").value = `https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/1`;
    element("favorites-add-button").fire("click");
    assert.equal(
      element("links").value,
      `https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/1\n# Snowfall in Two Cities\n${SNOW_A}\n# Snowfall in Two Cities\n${SNOW_B}\n# Paper Crowns\n${PAPER}`,
    );
    assert.equal(element("favorites-status").textContent, "3 added to the box. Download all downloads them, one series after the other.");
    element("favorites-add-button").fire("click"); // nothing twice
    assert.equal(element("favorites-status").textContent, "The box already names every ticked drama: nothing added.");
    assert.equal(element("links").value.split("\n").length, 7);
    assert.deepEqual(page.downloads, []);
    assert.equal(element("app-status").dataset["state"], "idle"); // nothing queued
  } finally {
    page.restore();
  }
});

test("the page: a right-click on a favorites card is resolved inside its Load list job — from the panel's list with no request, else the list read until it reaches the card — and that series is listed; a title two dramas share is never guessed; a drama not in the list lists nothing", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    const notFound = (/** @type {string} */ title) => String(page.catalog["favoritesNotFound"]?.message).replace("$title$", title);
    const shared = (/** @type {string} */ title) => String(page.catalog["favoritesShared"]?.message).replace("$title$", title);

    // not listed yet: the list's first page only (it reaches the card), then the series of the card at index 0
    let job = favoritesJob("load", { title: "The Lighthouse Keeper's Promise", index: 0 });
    let run = favoritesEngine(page, job);
    /** @type {Record<string, unknown>} */
    let entry = {};
    assert.equal(await module.runLoad(job, run.engine, entry), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.deepEqual(run.pauses, [0.8]);
    assert.deepEqual(run.listed, [LIGHTHOUSE]);
    assert.deepEqual(job.refs.map((ref) => ref.seriesId), [LIGHTHOUSE]);
    assert.equal(element("links").value, `# The Lighthouse Keeper's Promise\n${LIGHTHOUSE}`);
    assert.equal(element("input-status").textContent, "3 episodes listed.");
    assert.equal(element("favorites-count").textContent, "3 of 946 favorite dramas listed."); // the empty panel filled
    assert.deepEqual(entry["series"], [{ series_id: LIGHTHOUSE, name: `Series ${LIGHTHOUSE}`, error: null, episodes: 3, warnings: [] }]);

    // the whole list listed meanwhile — a job like any other: the rest between jobs first (the
    // listing before it contacted TikTok), then each page's pause —: a card it holds needs no request at all
    const full = favoritesJob("favorites", null);
    const listing = favoritesEngine(page, full);
    assert.equal(await module.runFavorites(full, listing.engine, {}), null);
    assert.deepEqual(listing.pauses, [60, 0.8, 0.8]); // the rest between jobs, then each page's pause
    // a tab whose favorites address the worker never saw, right after: no request, so no rest either
    const unseen = { ...favoritesJob("favorites", null), favoritesTab: FAVORITES_TAB + 1 };
    const idle = favoritesEngine(page, unseen);
    assert.equal(await module.runFavorites(unseen, idle.engine, {}), null);
    assert.deepEqual(idle.pauses, []);
    assert.equal(tab.fetched.length, 3);
    tab.fetched.length = 0;
    job = favoritesJob("load", { title: "Paper Crowns", index: 3 });
    run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, []);
    assert.deepEqual(run.pauses, [60]); // the rest between jobs (the listing before it contacted TikTok), no page's pause
    assert.deepEqual(run.listed, [PAPER]);
    assert.equal(element("links").value, `# The Lighthouse Keeper's Promise\n${LIGHTHOUSE}\n# Paper Crowns\n${PAPER}`);

    // the same title twice — two DIFFERENT dramas: whatever the card's position, none is picked —
    // the panel shows them (filtered to that title) for the user to tick; nothing listed, no
    // request (the panel's list of that tab shows them, not listed again since), not even the rest
    for (const index of [1, 2]) {
      job = favoritesJob("load", { title: "Snowfall in Two Cities", index });
      run = favoritesEngine(page, job);
      entry = {};
      assert.equal(await module.runLoad(job, run.engine, entry), null);
      assert.deepEqual(tab.fetched, []);
      assert.deepEqual(run.pauses, []);
      assert.deepEqual(run.listed, []);
      assert.deepEqual(job.refs, []);
      assert.equal(element("input-status").textContent, shared("Snowfall in Two Cities"));
      assert.equal(element("input-status").className, "status error");
      assert.equal(entry["error"], shared("Snowfall in Two Cities")); // the history keeps it
      assert.equal(element("favorites-filter").value, "Snowfall in Two Cities");
      assert.deepEqual(
        favoriteRows(page).filter(([, , , , , visible]) => visible).map(([id, title, meta]) => [id, title, meta]),
        [
          [SNOW_A, "Snowfall in Two Cities", "60 episodes · 1h 37m"],
          [SNOW_B, "Snowfall in Two Cities", "60 episodes · 1h 37m"],
        ],
      );
      assert.equal(favoriteRows(page).length, 2); // only those two drawn …
      assert.equal(element("library-chip-all").textContent, "All · 5"); // … of the library's whole list, searched
    }
    assert.equal(element("links").value, `# The Lighthouse Keeper's Promise\n${LIGHTHOUSE}\n# Paper Crowns\n${PAPER}`); // nothing added
    element("favorites-filter").value = "";
    element("favorites-filter").fire("input");

    // a drama the list does not hold: nothing listed, no request, not even the rest — the panel holds
    // the tab's complete list and the tab has not listed its favorites again since
    job = favoritesJob("load", { title: "A Drama Not Listed", index: 1 });
    run = favoritesEngine(page, job);
    entry = {};
    assert.equal(await module.runLoad(job, run.engine, entry), null);
    assert.deepEqual(tab.fetched, []);
    assert.deepEqual(run.pauses, []);
    assert.deepEqual(run.listed, []);
    assert.equal(element("input-status").textContent, notFound("A Drama Not Listed"));
    assert.equal(entry["error"], notFound("A Drama Not Listed"));
    assert.deepEqual(job.refs, []);
    // after an F5 on TikTok (the tab listed its favorites again): read again from the top until it
    // reaches the card — here to the list's end —; still not there
    tab.remember(Date.now() / 1000 + 60);
    run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE, FAVORITES_TEMPLATE.replace("cursor=0", "cursor=1794351568")]);
    assert.deepEqual(run.pauses, [60, 0.8, 0.8]); // the rest between jobs, then each page's pause
    assert.deepEqual(run.listed, []);
    assert.equal(element("input-status").textContent, notFound("A Drama Not Listed"));
    assert.equal(element("links").value.split("\n").length, 4); // the box as it was
  } finally {
    page.restore();
  }
});

test("the page: a card whose title two dramas share is resolved from a listing that reached the card — the panel then shows that listing, filtered to the title —; a drama that moved below the card's position is found by reading on", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    // the panel empty: the card at index 1 (the first twin), read until both twins are in view —
    // they end the first page, so one page more —, then shown, filtered, for the user to pick
    let job = favoritesJob("load", { title: "Snowfall in Two Cities", index: 1 });
    let run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE, FAVORITES_TEMPLATE.replace("cursor=0", "cursor=1794351568")]);
    assert.deepEqual(run.listed, []);
    assert.equal(element("input-status").textContent, String(page.catalog["favoritesShared"]?.message).replace("$title$", "Snowfall in Two Cities"));
    assert.equal(element("favorites-card").hidden, false);
    assert.deepEqual(favoriteRows(page).filter(([, , , , , visible]) => visible).map(([id]) => id), [SNOW_A, SNOW_B]);
    // ticking the one right-clicked and adding it puts that drama, and only it, in the box
    const box = tickOf(page, SNOW_B);
    assert.ok(box !== undefined);
    box.checked = true;
    box.fire("change");
    element("favorites-add-button").fire("click");
    assert.equal(element("links").value, `# Snowfall in Two Cities\n${SNOW_B}`);
    assert.deepEqual(page.downloads, []);
  } finally {
    page.restore();
  }
  // a drama that moved down since the grid loaded (a favorite added above it): the card says index
  // 1, the drama is the second page's second — read on until it is in view, then listed
  const moved = await fakePage();
  try {
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    const job = favoritesJob("load", { title: "Moonlight Over the Harbor", index: 1 });
    const run = favoritesEngine(moved, job);
    assert.equal(await moved.module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE, FAVORITES_TEMPLATE.replace("cursor=0", "cursor=1794351568")]);
    assert.deepEqual(run.listed, [MOON]);
    assert.equal(moved.element("links").value, `# Moonlight Over the Harbor\n${MOON}`);
  } finally {
    moved.restore();
  }
});

test("the page: a card whose drama is not where the card sits — a favorite added elsewhere since the grid loaded — lists neither of two dramas of its title: the list read a page past the card's position shows both; a list that ends before that (TikTok stopped sending it, or the panel's list) lists nothing", async () => {
  const [shape] = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
  /** @param {string} seriesId @param {string} title */
  const entryOf = (seriesId, title) => ({ ...shape, dramaID: seriesId, dramaName: title, numVideos: 60, totalDuration: "5827" });
  const UPPER = "7712345678901250002";
  const LOWER = "7712345678901250018";
  // the grid as it loaded: 40 favorites, two different "Snowfall in Two Cities" at 2 and 18 — one
  // favorite added on the phone since, on top of the list TikTok sends now: 19 dramas a page, the
  // other one at 3 and the right-clicked one (the card at 18) the first of page 2
  const grid = Array.from({ length: 40 }, (_, n) =>
    n === 2 ? entryOf(UPPER, "Snowfall in Two Cities") : n === 18 ? entryOf(LOWER, "Snowfall in Two Cities") : entryOf(String(7712345678901251000n + BigInt(n)), `Drama ${n}`),
  );
  const fresh = [entryOf("7712345678901252000", "A New Favorite"), ...grid];
  const cursors = ["0", "1794351568", "1794350100"];
  /** @param {number} sent how many pages TikTok sends: after them, an empty last page @returns {Record<string, unknown>} */
  const pagesOf = (sent) =>
    Object.fromEntries(
      cursors.map((cursor, page) => [
        cursor,
        page < sent
          ? { ...FAVORITES_CAPTURE, total: String(fresh.length), cursor: cursors[page + 1] ?? "1794349000", hasMore: page < cursors.length - 1, dramaList: fresh.slice(page * 19, page * 19 + 19) }
          : { dramaList: [], hasMore: false, statusCode: 0 },
      ]),
    );
  const card = { title: "Snowfall in Two Cities", index: 18 };
  const shared = (/** @type {Awaited<ReturnType<typeof fakePage>>} */ page) => String(page.catalog["favoritesShared"]?.message).replace("$title$", card.title);
  const cutShortText = (/** @type {Awaited<ReturnType<typeof fakePage>>} */ page) =>
    String(page.catalog["favoritesCardCutShort"]?.message).replace("$title$", card.title).replace("$count$", "19");
  const visible = (/** @type {Awaited<ReturnType<typeof fakePage>>} */ page) => favoriteRows(page).filter(([, , , , , shown]) => shown).map(([id]) => id);

  // the panel empty: page 1 holds the card's position and the other one with dramas after it, and
  // another drama at the card's position — read a page more: both in view, shown, nothing listed
  let page = await fakePage();
  try {
    const tab = favoritesTab({ pages: pagesOf(3) });
    tab.remember(1_794_351_500);
    const job = favoritesJob("load", card);
    const run = favoritesEngine(page, job);
    assert.equal(await page.module.runLoad(job, run.engine, {}), null);
    assert.equal(tab.fetched.length, 2);
    assert.deepEqual(run.listed, []);
    assert.equal(page.element("input-status").textContent, shared(page));
    assert.deepEqual(visible(page), [UPPER, LOWER]);
    assert.equal(page.element("links").value, "");
  } finally {
    page.restore();
  }
  // TikTok stops sending after page 1: it cannot tell which one the card is — nothing listed; the
  // panel then holds that list, cut short, and the same card again is answered from it, no request
  page = await fakePage();
  try {
    const tab = favoritesTab({ pages: pagesOf(1) });
    tab.remember(1_794_351_500);
    for (const requests of [2, 0]) {
      tab.fetched.length = 0;
      const job = favoritesJob("load", card);
      const run = favoritesEngine(page, job);
      assert.equal(await page.module.runLoad(job, run.engine, {}), null);
      assert.equal(tab.fetched.length, requests);
      assert.deepEqual(run.listed, []);
      assert.equal(page.element("input-status").textContent, cutShortText(page));
      assert.equal(page.element("links").value, "");
    }
  } finally {
    page.restore();
  }
  // the panel holds page 1 of that list (an earlier card's listing stopped there): not far enough for
  // this card — read again from the top, a page past it: both shown, nothing listed
  page = await fakePage();
  try {
    const tab = favoritesTab({ pages: pagesOf(3) });
    tab.remember(1_794_351_500);
    const first = favoritesJob("load", { title: "A New Favorite", index: 0 });
    const earlier = favoritesEngine(page, first);
    await page.module.runLoad(first, earlier.engine, {});
    assert.equal(page.element("favorites-count").textContent, "19 of 41 favorite dramas listed.");
    tab.fetched.length = 0;
    const job = favoritesJob("load", card);
    const run = favoritesEngine(page, job);
    assert.equal(await page.module.runLoad(job, run.engine, {}), null);
    assert.equal(tab.fetched.length, 2);
    assert.deepEqual(run.listed, []);
    assert.equal(page.element("input-status").textContent, shared(page));
    assert.deepEqual(visible(page), [UPPER, LOWER]);
  } finally {
    page.restore();
  }
});

test("the page: a favorites hand-over is taken by the engine's tab only — a card queues one Load list job; a right-click that named no card queues nothing and says why (no card, or no script in the tab); the popup's hand-over the List favorites job —, never twice; a read-only tab stays silent", async () => {
  const page = await fakePage();
  try {
    const { element } = page;
    const queued = () => element("queue-list").children.map((item) => item.textContent);
    const status = element("input-status");
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    page.hold(); // the job's `tabs.getCurrent` never answers: it runs, and makes no request
    const card = { title: "Snowfall in Two Cities", index: 2 };
    assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB, card, menu: true, script: true }), [{ ok: true, tabId: 1 }]);
    await page.turn();
    assert.equal(element("progress-current").textContent, "List “Snowfall in Two Cities” from your favorites");
    // the same card again while its job runs: nothing queued
    page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB, card, menu: true, script: true });
    assert.equal(status.textContent, page.catalog["loadAlreadyQueued"]?.message);
    assert.deepEqual(queued(), []);
    // a right-click on no card — the tab's script said so —: nothing queued, nothing asked of
    // TikTok; the tab still answers (the worker brings it to the front to say it)
    assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB, card: null, menu: true, script: true }), [{ ok: true, tabId: 1 }]);
    assert.equal(status.textContent, page.catalog["favoritesNoCard"]?.message);
    assert.equal(status.className, "status error");
    assert.deepEqual(queued(), []);
    // no script in that tab answered (a tab older than DramaFetch's load or update): nothing queued,
    // and the page says to reload the TikTok tab
    assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB, card: null, menu: true, script: false }), [{ ok: true, tabId: 1 }]);
    assert.equal(status.textContent, page.catalog["favoritesNoScript"]?.message);
    assert.equal(status.className, "status error");
    assert.deepEqual(queued(), []);
    assert.notEqual(page.catalog["favoritesNoScript"]?.message, page.catalog["favoritesNoCard"]?.message);
    assert.deepEqual(tab.fetched, []);
    // the popup's Choose from your favorites: the List favorites job — and not twice
    assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB, card: null, menu: false, script: true }), [{ ok: true, tabId: 1 }]);
    assert.equal(status.textContent, page.catalog["favoritesChoose"]?.message);
    assert.deepEqual(queued(), ["List your favorites"]);
    page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB, card: null, menu: false });
    assert.equal(status.textContent, page.catalog["favoritesAlreadyQueued"]?.message);
    assert.deepEqual(queued(), ["List your favorites"]);
    // junk, another extension: not heard
    assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: -1 }), []);
    assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: 7, card: null }, "another-extension-id"), []);
    assert.deepEqual(queued(), ["List your favorites"]);
    assert.deepEqual(tab.fetched, []);
  } finally {
    page.restore();
  }
  const readonly = await fakePage({ lockTaken: true });
  try {
    assert.deepEqual(readonly.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB, card: null, menu: false }), []);
    assert.equal(readonly.element("queue-card").hidden, true);
  } finally {
    readonly.restore();
  }
});

test("the page: TikTok refusing the favorites list (HTTP 429) is a full stop — the cooldown recorded with its reason, the page says so, the dramas listed before it stay", async () => {
  const page = await fakePage();
  try {
    const { element, module, local } = page;
    const tab = favoritesTab({ pages: { "0": FAVORITES_CAPTURE, "1794351568": { __dramafetch_status: 429, __dramafetch_text: '{"statusCode": 429}' } } });
    tab.remember(1_794_351_500);
    const job = favoritesJob("favorites", null);
    const { engine } = favoritesEngine(page, job);
    /** @type {Record<string, unknown>} */
    const entry = {};
    try {
      assert.equal(await module.runFavorites(job, engine, entry), FAVORITES_RATE_LIMIT_MESSAGE); // the job's stop: the waiting jobs end unstarted
      assert.equal(tab.fetched.length, 2); // nothing after the refusal
      const cooldown = /** @type {Record<string, unknown>} */ (local.get("cooldown"));
      assert.equal(cooldown["reason"], FAVORITES_RATE_LIMIT_MESSAGE);
      assert.equal(cooldown["source"], "discovery");
      assert.equal(element("input-status").textContent, FAVORITES_RATE_LIMIT_MESSAGE);
      assert.equal(element("input-status").className, "status error");
      assert.equal(entry["error"], FAVORITES_RATE_LIMIT_MESSAGE);
      assert.equal(entry["favorites"], undefined);
      assert.deepEqual(favoriteRows(page).map(([id]) => id), [LIGHTHOUSE, SNOW_A, SNOW_B]);
      assert.equal(element("favorites-count").textContent, "3 of 946 favorite dramas listed.");
    } finally {
      await clearCooldown(engine.cooldownStore);
    }
  } finally {
    page.restore();
  }
});

test("the page: after the tab listed its favorites again, a card whose title two dramas share is read again — the fresh list shown in the panel, filtered, nothing listed —; a title only one bears needs no request where the card sits at its drama's place in the panel's list, and is read again where it does not", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    let tab = favoritesTab();
    tab.remember(1_794_351_500);
    const full = favoritesJob("favorites", null);
    await module.runFavorites(full, favoritesEngine(page, full).engine, {});
    assert.equal(favoriteRows(page).length, 5);
    tab.fetched.length = 0;
    // the profile shown again since, its grid as the panel's list: a title only one drama bears, at
    // the card's very position in that list — the panel still tells it, no request
    tab.remember(Date.now() / 1000 + 30);
    let job = favoritesJob("load", { title: "Paper Crowns", index: 3 });
    let run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, []);
    assert.deepEqual(run.listed, [PAPER]);
    // the profile shown again since — Lighthouse removed from the favorites: every drama moved up
    // one, so the card no longer sits where the panel's list has its drama (a drama of that title
    // favorited since would sit in the grid and not in that list): read again, then listed
    const list = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
    const last = /** @type {Record<string, unknown>[]} */ (/** @type {Record<string, unknown>} */ (favoritesPages()["1794351568"])["dramaList"]);
    tab = favoritesTab({ pages: { "0": { ...FAVORITES_CAPTURE, hasMore: false, total: "4", dramaList: [list[1], list[2], ...last] } } });
    tab.remember(Date.now() / 1000 + 60);
    job = favoritesJob("load", { title: "Paper Crowns", index: 2 });
    run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.deepEqual(run.listed, [PAPER]);
    assert.equal(favoriteRows(page).length, 5); // a card's reading leaves the panel's complete list in place
    tab.fetched.length = 0;
    // the title two dramas bear: the panel's list is older than the grid — read again; both still
    // there, so none is picked: the fresh list takes the panel's place, filtered to that title
    job = favoritesJob("load", { title: "Snowfall in Two Cities", index: 1 });
    run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.deepEqual(run.listed, []);
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [SNOW_A, SNOW_B]); // the fresh list, searched to that title
    assert.equal(element("library-chip-all").textContent, "All · 4");
    assert.equal(element("favorites-count").textContent, "4 favorite dramas listed.");
    assert.equal(element("links").value, `# Paper Crowns\n${PAPER}`);
  } finally {
    page.restore();
  }
});

test("the page: a second drama of a title the panel's complete list holds once, favorited since under another id — the tab listed its favorites again —: a right-click on either card is read again and never takes the panel's older drama for it", async () => {
  const PAPER_TWIN = "7712345678901234570";
  for (const index of [0, 4]) {
    // 0: the new favorite, at the top of the list (newest first); 4: the older one, moved down one
    const page = await fakePage();
    try {
      const { element, module } = page;
      let tab = favoritesTab();
      tab.remember(1_794_351_500);
      const full = favoritesJob("favorites", null);
      await module.runFavorites(full, favoritesEngine(page, full).engine, {});
      assert.deepEqual(favoriteRows(page).map(([id]) => id), [LIGHTHOUSE, SNOW_A, SNOW_B, PAPER, MOON]);
      const list = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
      const last = /** @type {Record<string, unknown>[]} */ (/** @type {Record<string, unknown>} */ (favoritesPages()["1794351568"])["dramaList"]);
      const twin = { ...list[0], dramaID: PAPER_TWIN, dramaName: "Paper Crowns", numVideos: 24, totalDuration: "1300" };
      tab = favoritesTab({ pages: { "0": { ...FAVORITES_CAPTURE, hasMore: false, total: "6", dramaList: [twin, ...list, ...last] } } });
      tab.remember(Date.now() / 1000 + 60);
      const job = favoritesJob("load", { title: "Paper Crowns", index });
      const run = favoritesEngine(page, job);
      /** @type {Record<string, unknown>} */
      const entry = {};
      assert.equal(await module.runLoad(job, run.engine, entry), null);
      // the panel's list is older than the grid: read again, and both dramas of that title seen
      assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
      assert.deepEqual(run.listed, []); // none picked — never the panel's older one
      assert.deepEqual(job.refs, []);
      assert.deepEqual(
        favoriteRows(page).filter(([, , , , , visible]) => visible).map(([id]) => id),
        [PAPER_TWIN, PAPER],
      );
      assert.equal(entry["error"], 'Several of your favorites are called “Paper Crowns”: they are shown below with their episodes and length — tick the one you right-clicked (its card shows the same) and press Add selected to the box.');
      assert.equal(element("links").value, "");
    } finally {
      page.restore();
    }
  }
});

test("the page: a right-clicked card past what the list read so far holds — the first drama of its second page — is read up to its own page and listed, with the panel empty and after a card's listing that stopped short of it", async () => {
  for (const before of [null, { title: "The Lighthouse Keeper's Promise", index: 0 }]) {
    const page = await fakePage();
    try {
      const { element, module } = page;
      const tab = favoritesTab();
      tab.remember(1_794_351_500);
      if (before !== null) {
        // a card of the first page first: the list read as far as that page — positions 0–2 —, no further
        const first = favoritesJob("load", before);
        await module.runLoad(first, favoritesEngine(page, first).engine, {});
        assert.equal(element("favorites-count").textContent, "3 of 946 favorite dramas listed.");
        tab.fetched.length = 0;
      }
      // position 3: the first drama of the list's second page — the first page does not cover it
      const job = favoritesJob("load", { title: "Paper Crowns", index: 3 });
      const run = favoritesEngine(page, job);
      /** @type {Record<string, unknown>} */
      const entry = {};
      assert.equal(await module.runLoad(job, run.engine, entry), null);
      assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE, FAVORITES_TEMPLATE.replace("cursor=0", "cursor=1794351568")]);
      assert.deepEqual(run.pauses, before === null ? [0.8, 0.8] : [60, 0.8, 0.8]); // the rest between jobs after a listing, then each page's pause
      assert.deepEqual(run.listed, [PAPER]);
      assert.deepEqual(job.refs.map((ref) => ref.seriesId), [PAPER]);
      assert.ok(element("links").value.endsWith(`# Paper Crowns\n${PAPER}`), element("links").value);
      assert.equal(entry["error"], undefined);
    } finally {
      page.restore();
    }
  }
});

test("the page: a favorites hand-over in its address (no running page took it, so the worker opened or reloaded the tab with it) is taken once — a card's Load list job, the popup's List favorites, nothing at all for a right-click that named no card — and the address cleared; a read-only tab takes nothing", async () => {
  const card = { title: "Snowfall in Two Cities", index: 2 };
  for (const [search, kind, label] of /** @type {[string, string, string][]} */ ([
    [`?favorites=${FAVORITES_TAB}&menu=1&card=${encodeURIComponent(JSON.stringify(card)).replace(/%20/g, "+")}`, "load", "List “Snowfall in Two Cities” from your favorites"],
    [`?favorites=${FAVORITES_TAB}`, "favorites", "List your favorites"],
  ])) {
    const page = await fakePage({ search }); // loaded once its job ended: no address seen for that tab, so no request
    try {
      const noTemplate = String(page.catalog["favoritesNoTemplate"]?.message);
      assert.deepEqual(page.replaced, ["/src/app/app.html"], search);
      const history = /** @type {Record<string, unknown>[]} */ (page.local.get("history") ?? []);
      assert.deepEqual(history.map((entry) => [entry["kind"], entry["label"], entry["error"]]), [[kind, label, noTemplate]], search);
      assert.deepEqual(page.sessionKeys.filter((key) => String(key).startsWith("favoritesTemplate:")), [`favoritesTemplate:${FAVORITES_TAB}`], search);
      assert.equal(page.element("input-status").textContent, noTemplate, search);
    } finally {
      page.restore();
    }
  }
  // a right-click that named no card — the tab's script said so, or no script answered
  // (`script=0`) —: no job at all, no history entry, not even the favorites address read; the
  // page says why
  for (const [search, key] of [
    [`?favorites=${FAVORITES_TAB}&menu=1`, "favoritesNoCard"],
    [`?favorites=${FAVORITES_TAB}&menu=1&script=0`, "favoritesNoScript"],
  ]) {
    const page = await fakePage({ search });
    try {
      assert.deepEqual(page.replaced, ["/src/app/app.html"], search);
      assert.equal(page.local.get("history"), undefined, search);
      assert.deepEqual(page.sessionKeys.filter((stored) => String(stored).startsWith("favoritesTemplate:")), [], search);
      assert.equal(page.element("input-status").textContent, page.catalog[String(key)]?.message, search);
      assert.equal(page.element("app-status").dataset["state"], "idle", search);
    } finally {
      page.restore();
    }
  }
  const readonly = await fakePage({ search: `?favorites=${FAVORITES_TAB}`, lockTaken: true });
  try {
    assert.deepEqual(readonly.replaced, ["/src/app/app.html"]);
    assert.equal(readonly.local.get("history"), undefined);
    assert.equal(readonly.element("queue-card").hidden, true);
  } finally {
    readonly.restore();
  }
});

/**
 * Another TikTok tab (43) whose own favorites address the worker kept too; returns the tabs every
 * page of a favorites list was read from (`chrome.scripting.executeScript`'s MAIN-world target).
 * @returns {Promise<number[]>}
 */
async function secondFavoritesTab() {
  /** @type {number[]} */
  const readFrom = [];
  const fake = /** @type {{scripting: {executeScript: (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => Promise<unknown>}}} */ (
    /** @type {unknown} */ (globalThis.chrome)
  );
  const execute = fake.scripting.executeScript;
  fake.scripting.executeScript = async (injection) => {
    if (injection.world === "MAIN") readFrom.push(injection.target.tabId);
    return execute(injection);
  };
  await chrome.storage.session.set({ "favoritesTemplate:43": { url: FAVORITES_TEMPLATE, at: 1_794_351_500, profile: "@invented_viewer" } });
  return readFrom;
}

test("the page: a card the panel's partial list of its own tab reaches needs no request — its one drama listed, two of its title shown —; a card of another TikTok tab reads that tab's own list and leaves the panel as it was", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    const readFrom = await secondFavoritesTab();
    // a card at index 0: the list read until it reaches it, the panel holds its first page only (3 of 946)
    let job = favoritesJob("load", { title: "The Lighthouse Keeper's Promise", index: 0 });
    let run = favoritesEngine(page, job);
    await module.runLoad(job, run.engine, {});
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.equal(element("favorites-count").textContent, "3 of 946 favorite dramas listed.");
    // the same card again: that partial list reaches it — no request, the panel's own item
    run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.deepEqual(run.listed, [LIGHTHOUSE]);
    // a card of a title two dramas of that partial list bear, within it: shown, no request
    job = favoritesJob("load", { title: "Snowfall in Two Cities", index: 1 });
    run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.deepEqual(run.listed, []);
    assert.deepEqual(favoriteRows(page).filter(([, , , , , visible]) => visible).map(([id]) => id), [SNOW_A, SNOW_B]);
    element("favorites-filter").value = "";
    element("favorites-filter").fire("input");
    // a card of tab 43 while the panel shows tab 42's list: tab 43's own list is read — the panel
    // (rows, count line) stays tab 42's
    job = { ...favoritesJob("load", { title: "The Lighthouse Keeper's Promise", index: 0 }), favoritesTab: 43 };
    run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(readFrom, [FAVORITES_TAB, 43]);
    assert.deepEqual(run.listed, [LIGHTHOUSE]);
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [LIGHTHOUSE, SNOW_A, SNOW_B]);
    assert.equal(element("favorites-count").textContent, "3 of 946 favorite dramas listed.");
    // a card further down in tab 43: its list read to its end — five dramas, complete, more than the
    // panel holds —, which neither takes the place of tab 42's partial list (rows) nor marks it
    // whole (the count line)
    job = { ...favoritesJob("load", { title: "Paper Crowns", index: 3 }), favoritesTab: 43 };
    run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(readFrom, [FAVORITES_TAB, 43, 43, 43]);
    assert.deepEqual(run.listed, [PAPER]);
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [LIGHTHOUSE, SNOW_A, SNOW_B]);
    assert.equal(element("favorites-count").textContent, "3 of 946 favorite dramas listed.");
    // so a card of tab 42 past that partial list still reads tab 42's own list, and finds its drama
    job = favoritesJob("load", { title: "Moonlight Over the Harbor", index: 4 });
    run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(readFrom, [FAVORITES_TAB, 43, 43, 43, FAVORITES_TAB, FAVORITES_TAB]);
    assert.deepEqual(run.listed, [MOON]);
  } finally {
    page.restore();
  }
});

test("the page: a card's listing never wipes the panel — another tab's card leaves a full list and its ticks as they were; the same tab's partial list is extended by a card further down —, and ticks survive every listing but a complete one, which prunes them", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const pages = favoritesPages();
    const tab = favoritesTab({ pages });
    tab.remember(1_794_351_500);
    await secondFavoritesTab();
    const ticked = () => favoriteRows(page).filter(([, , , , checked]) => checked).map(([id]) => id);
    /** @param {string} seriesId */
    const tick = (seriesId) => {
      const box = tickOf(page, seriesId);
      assert.ok(box !== undefined, seriesId);
      box.checked = true;
      box.fire("change");
    };
    // tab 42's whole list, two ticks
    const full = favoritesJob("favorites", null);
    await module.runFavorites(full, favoritesEngine(page, full).engine, {});
    tick(SNOW_A);
    tick(PAPER);
    const rows = favoriteRows(page);
    const count = element("favorites-count").textContent;
    // a card of tab 43 (its list read up to the card): the panel — rows, count line, ticks — as it was
    const other = { ...favoritesJob("load", { title: "The Lighthouse Keeper's Promise", index: 0 }), favoritesTab: 43 };
    const run = favoritesEngine(page, other);
    assert.equal(await module.runLoad(other, run.engine, {}), null);
    assert.deepEqual(run.listed, [LIGHTHOUSE]);
    assert.deepEqual(favoriteRows(page), rows);
    assert.equal(element("favorites-count").textContent, count);
    assert.deepEqual(ticked(), [SNOW_A, PAPER]);
    assert.equal(element("favorites-selection").textContent, "2 selected · 90 episodes");
  } finally {
    page.restore();
  }
  const page2 = await fakePage();
  try {
    const { element, module } = page2;
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    const ticked = () => favoriteRows(page2).filter(([, , , , checked]) => checked).map(([id]) => id);
    // the same tab's partial list (a card of its first page) …
    let job = favoritesJob("load", { title: "The Lighthouse Keeper's Promise", index: 0 });
    await module.runLoad(job, favoritesEngine(page2, job).engine, {});
    assert.equal(element("favorites-count").textContent, "3 of 946 favorite dramas listed.");
    const box = tickOf(page2, SNOW_A);
    assert.ok(box !== undefined);
    box.checked = true; // SNOW_A ticked
    box.fire("change");
    // … then a card further down: the listing holds more than the panel, so it extends it — the
    // tick shown again on its row
    job = favoritesJob("load", { title: "Paper Crowns", index: 3 });
    const run = favoritesEngine(page2, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(run.listed, [PAPER]);
    assert.deepEqual(favoriteRows(page2).map(([id]) => id), [LIGHTHOUSE, SNOW_A, SNOW_B, PAPER, MOON]);
    assert.equal(element("favorites-count").textContent, "5 favorite dramas listed.");
    assert.deepEqual(ticked(), [SNOW_A]);
  } finally {
    page2.restore();
  }
  // ticks survive a partial listing (here one TikTok cut short, without a ticked drama: it leaves the
  // library as it was) and another tab's complete list that holds them; only a complete list without
  // them prunes them
  const page3 = await fakePage();
  try {
    const { module } = page3;
    const pages = favoritesPages();
    const tab = favoritesTab({ pages });
    tab.remember(1_794_351_500);
    await secondFavoritesTab();
    const ticked = () => favoriteRows(page3).filter(([, , , , checked]) => checked).map(([id]) => id);
    /** @param {number} tabId */
    const list = async (tabId) => {
      const job = { ...favoritesJob("favorites", null), favoritesTab: tabId };
      await module.runFavorites(job, favoritesEngine(page3, job).engine, {});
    };
    await list(FAVORITES_TAB);
    const box = tickOf(page3, PAPER);
    assert.ok(box !== undefined);
    box.checked = true;
    box.fire("change");
    const second = /** @type {Record<string, unknown>} */ (pages["1794351568"]);
    pages["1794351568"] = { dramaList: [], hasMore: false, statusCode: 0 }; // TikTok stops after the first page
    await list(FAVORITES_TAB);
    // a listing cut short over a library that holds dramas leaves the library as it was — all five
    // (1.6.0's review: what is kept across sessions never shrinks to a partial read; before, the three
    // TikTok sent took its place); the tick of a drama past what TikTok sent is kept either way
    assert.deepEqual(favoriteRows(page3).map(([id]) => id), [LIGHTHOUSE, SNOW_A, SNOW_B, PAPER, MOON]);
    pages["1794351568"] = second;
    await list(FAVORITES_TAB);
    assert.deepEqual(ticked(), [PAPER]); // kept through the partial list
    await list(43); // another tab's complete list, PAPER in it: kept
    assert.deepEqual(ticked(), [PAPER]);
    pages["1794351568"] = { ...second, dramaList: /** @type {unknown[]} */ (second["dramaList"]).slice(1) }; // PAPER unfavorited
    await list(FAVORITES_TAB);
    pages["1794351568"] = second;
    await list(FAVORITES_TAB);
    assert.deepEqual(ticked(), []); // pruned by the complete list that lacked it
  } finally {
    page3.restore();
  }
});

test("the page: a right-clicked card whose series waits in the queue for its own Load list is not listed twice", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    page.hold(); // the first job's `tabs.getCurrent` never answers: it runs, and makes no request
    element("links").value = `https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/1`;
    element("load-button").fire("click");
    await page.turn();
    element("links").value = `https://www.tiktok.com/shortdrama/episode/${LIGHTHOUSE}/1`; // the card's series, waiting
    element("load-button").fire("click");
    assert.deepEqual(element("queue-list").children.map((item) => item.textContent), [`List series ${LIGHTHOUSE}`]);
    const job = favoritesJob("load", { title: "The Lighthouse Keeper's Promise", index: 0 });
    const run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]); // resolved from the list
    assert.deepEqual(run.listed, []); // the waiting Load list lists it: not twice
    assert.equal(element("input-status").textContent, page.catalog["loadAlreadyQueued"]?.message);
  } finally {
    page.restore();
  }
});

test("the page: TikTok's login page in the TikTok tab before the favorites list's first request is the job's stop — the popup's List favorites and a card's job alike —: the job waiting behind ends without a request", async () => {
  const login = "https://www.tiktok.com/login?redirect_url=%2F%40invented_viewer";
  for (const [handover, label] of /** @type {[Record<string, unknown>, string][]} */ ([
    [{ card: null, menu: false }, "List your favorites"],
    [{ card: { title: "Paper Crowns", index: 3 }, menu: true }, "List “Paper Crowns” from your favorites"],
  ])) {
    const page = await fakePage();
    try {
      const tab = favoritesTab({ tabUrl: login });
      tab.remember(1_794_351_500);
      // the favorites job, and a Load list queued behind it while it runs
      assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB, ...handover, script: true }), [{ ok: true, tabId: 1 }]);
      assert.deepEqual(page.message({ type: "dramafetch:load", input: SERIES_ID }), [{ ok: true, tabId: 1 }]);
      const history = () => /** @type {Record<string, unknown>[]} */ (page.local.get("history") ?? []);
      for (let turns = 0; turns < 400 && !(history().length === 2 && page.element("app-status").dataset["state"] === "idle"); turns += 1) await page.turn();
      assert.deepEqual(
        history().map((entry) => [entry["label"], entry["error"], entry["stopped"]]),
        [
          [label, LOGIN_REDIRECT_MESSAGE, LOGIN_REDIRECT_MESSAGE], // the job's stop
          [`List series ${SERIES_ID}`, `not started: batch stopped in ${label} (${LOGIN_REDIRECT_MESSAGE})`, null], // never started
        ],
        label,
      );
      assert.deepEqual(tab.fetched, [], label); // no favorites page asked for
      assert.equal(page.element("input-status").textContent, LOGIN_REDIRECT_MESSAGE, label);
    } finally {
      page.restore();
    }
  }
});

test("the page hears only the extension's own pages and worker: the popup, the DramaFetch tab, the worker with or without its address — never a TikTok page carrying the extension's id (where the content script runs), nor another extension", async () => {
  const page = await fakePage();
  try {
    const { element } = page;
    page.hold(); // a job queued here runs and makes no request
    const queued = () => element("queue-list").children.map((item) => item.textContent);
    const profile = "https://www.tiktok.com/@invented_viewer";
    const tiktokTab = { id: FAVORITES_TAB, index: 0, windowId: 2, active: true, url: profile };
    const ours = [
      { id: "dramafetch-test-id", url: `${EXTENSION_ROOT}src/app/popup.html` }, // the popup
      { id: "dramafetch-test-id", url: `${EXTENSION_ROOT}src/app/app.html`, tab: { id: 3, index: 0, windowId: 1, active: true, url: `${EXTENSION_ROOT}src/app/app.html` } }, // a DramaFetch tab
      { id: "dramafetch-test-id", url: `${EXTENSION_ROOT}src/app/background.js` }, // the worker, with its address
      { id: "dramafetch-test-id" }, // the worker, without one
    ];
    const theirs = [
      { id: "dramafetch-test-id", url: profile, tab: tiktokTab }, // a TikTok page with the content script's id
      { id: "dramafetch-test-id", url: profile, frameId: 0 },
      { id: "dramafetch-test-id", tab: tiktokTab }, // a tab but no address: never the worker
      { id: "dramafetch-test-id", url: "chrome-extension://another-extension/src/app/popup.html" },
      { id: "another-extension", url: `${EXTENSION_ROOT}src/app/popup.html` },
    ];
    for (const sender of theirs) {
      assert.deepEqual(page.message({ type: "dramafetch:load", input: SERIES_ID }, sender), [], JSON.stringify(sender));
      assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB, card: { title: "Paper Crowns", index: 3 }, menu: true }, sender), [], JSON.stringify(sender));
    }
    assert.equal(element("links").value, "");
    assert.equal(element("queue-card").hidden, true);
    assert.equal(element("app-status").dataset["state"], "idle"); // nothing queued
    const series = ["7699393770256782399", "7699393770256782388", "7699393770256782366", "7699393770256782344"];
    for (const [index, sender] of ours.entries()) {
      assert.deepEqual(page.message({ type: "dramafetch:load", input: series[index] }, sender), [{ ok: true, tabId: 1 }], JSON.stringify(sender));
    }
    await page.turn();
    assert.deepEqual(queued(), series.slice(1).map((id) => `List series ${id}`)); // the first runs, the rest wait
  } finally {
    page.restore();
  }
});

test("the page: a cooldown met before a page of the favorites list is the job's stop; Stop keeps the count of what was listed in the history", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    // a cooldown recorded during the second page's pause: that page is never asked for, the job stops the queue
    let job = favoritesJob("favorites", null);
    let { engine } = favoritesEngine(page, job);
    const store = engine.cooldownStore;
    engine.sleep = async () => {
      if (tab.fetched.length === 1) await recordBlock(store, "rate limited (HTTP 429) by the video server", "browser", { now: Date.now() / 1000 });
    };
    /** @type {Record<string, unknown>} */
    let entry = {};
    try {
      const stop = await module.runFavorites(job, engine, entry);
      assert.ok(stop !== null && stop.startsWith("TikTok refused a request at "), String(stop));
      assert.equal(entry["error"], stop);
      assert.equal(element("input-status").className, "status error");
      assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    } finally {
      await clearCooldown(store);
    }
    // Stop pressed once the first page was read: the job ends, and its history entry keeps the 3 listed
    tab.fetched.length = 0;
    job = favoritesJob("favorites", null);
    ({ engine } = favoritesEngine(page, job));
    engine.stopRequested = () => tab.fetched.length > 0;
    entry = {};
    await assert.rejects(module.runFavorites(job, engine, entry), StopRequested);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.equal(entry["favorites"], 3);
  } finally {
    page.restore();
  }
});

test("the page: the panel's ticks are series — kept when the same tab, or another tab, is listed again (a row built for a ticked drama shows ticked) — and a drama that left the list loses its tick", async () => {
  const page = await fakePage();
  try {
    const { module } = page;
    const pages = favoritesPages();
    const tab = favoritesTab({ pages });
    tab.remember(1_794_351_500);
    await secondFavoritesTab();
    /** @param {number} tabId */
    const list = async (tabId) => {
      const job = { ...favoritesJob("favorites", null), favoritesTab: tabId };
      assert.equal(await module.runFavorites(job, favoritesEngine(page, job).engine, {}), null);
    };
    const ticked = () => favoriteRows(page).filter(([, , , , checked]) => checked).map(([id]) => id);
    /** @param {string} seriesId */
    const tick = (seriesId) => {
      const box = tickOf(page, seriesId);
      assert.ok(box !== undefined);
      box.checked = true;
      box.fire("change");
    };
    await list(FAVORITES_TAB);
    tick(SNOW_A);
    await list(FAVORITES_TAB); // the same tab's list again: the tick stays
    assert.deepEqual(ticked(), [SNOW_A]);
    await list(43); // another tab's list holding the same drama: still ticked (never cleared by a tab change)
    assert.deepEqual(ticked(), [SNOW_A]);
    await list(FAVORITES_TAB);
    assert.deepEqual(ticked(), [SNOW_A]);
    tick(PAPER);
    // PAPER left the list (unfavorited), then came back: its tick is gone
    const last = /** @type {Record<string, unknown>} */ (pages["1794351568"]);
    pages["1794351568"] = { ...last, dramaList: /** @type {unknown[]} */ (last["dramaList"]).slice(1) };
    await list(FAVORITES_TAB);
    pages["1794351568"] = last;
    await list(FAVORITES_TAB);
    assert.deepEqual(ticked(), [SNOW_A]);
  } finally {
    page.restore();
  }
});

test("the page: TikTok stopping before the list's end is said — the count keeps TikTok's total, the status and the history say why — and a card further down than it sent is not guessed by its title", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const tab = favoritesTab({ pages: { "0": FAVORITES_CAPTURE, "1794351568": { dramaList: [], hasMore: false, statusCode: 0, status_code: 0, status_msg: "" } } });
    tab.remember(1_794_351_500);
    const cutShortText = String(page.catalog["favoritesCutShort"]?.message).replace("$count$", "3");
    const job = favoritesJob("favorites", null);
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await module.runFavorites(job, favoritesEngine(page, job).engine, entry), null); // TikTok refused nothing: no stop
    assert.equal(tab.fetched.length, 2);
    assert.equal(element("favorites-count").textContent, `3 of 946 favorite dramas listed. ${page.catalog["favoritesCutShortNote"]?.message}`);
    assert.equal(element("input-status").textContent, cutShortText);
    assert.equal(element("input-status").className, "status error");
    assert.deepEqual(entry, { favorites: 3, error: cutShortText });
    // a card further down than TikTok sent, of a title the list holds twice: neither of those — no request, nothing listed
    tab.fetched.length = 0;
    const card = favoritesJob("load", { title: "Snowfall in Two Cities", index: 5 });
    const run = favoritesEngine(page, card);
    assert.equal(await module.runLoad(card, run.engine, {}), null);
    assert.deepEqual(tab.fetched, []);
    assert.deepEqual(run.pauses, []);
    assert.deepEqual(run.listed, []);
    assert.equal(element("links").value, "");
    const cardText = String(page.catalog["favoritesCardCutShort"]?.message).replace("$title$", "Snowfall in Two Cities").replace("$count$", "3");
    assert.equal(element("input-status").textContent, cardText);
  } finally {
    page.restore();
  }
  // the same card with no list shown: the list read up to it (paced), then the same answer — not the wrong drama
  const fresh = await fakePage();
  try {
    const tab = favoritesTab({ pages: { "0": FAVORITES_CAPTURE, "1794351568": { dramaList: [], hasMore: false, statusCode: 0 } } });
    tab.remember(1_794_351_500);
    const card = favoritesJob("load", { title: "Snowfall in Two Cities", index: 5 });
    const run = favoritesEngine(fresh, card);
    assert.equal(await fresh.module.runLoad(card, run.engine, {}), null);
    assert.equal(tab.fetched.length, 2);
    assert.deepEqual(run.listed, []);
    assert.equal(fresh.element("links").value, "");
  } finally {
    fresh.restore();
  }
});

test("the page: a listing stopped at the page cap says so on the count line", async () => {
  const page = await fakePage();
  try {
    const [shape] = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
    /** @type {Record<string, unknown>} */
    const pages = {};
    for (let index = 0; index <= 100; index += 1) {
      pages[index === 0 ? "0" : String(1000 + index)] = { ...FAVORITES_CAPTURE, cursor: String(1001 + index), dramaList: [{ ...shape, dramaID: String(7712345678901300000n + BigInt(index)), dramaName: `Drama ${index}` }] };
    }
    const tab = favoritesTab({ pages });
    tab.remember(1_794_351_500);
    const job = favoritesJob("favorites", null);
    assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, {}), null);
    assert.equal(tab.fetched.length, 100);
    const capped = String(page.catalog["favoritesCapped"]?.message).replace("$pages$", "100");
    assert.equal(page.element("favorites-count").textContent, `100 of 946 favorite dramas listed. ${capped}`);
  } finally {
    page.restore();
  }
});

test("the page: dramas TikTok sent without a readable series id are left out and said — on the count line and in the listing's history entry", async () => {
  const [shape] = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
  const numeric = { ...shape, dramaID: 7712345678901234000 }; // a JSON number: 19 digits are no exact id
  const skipped = (/** @type {Awaited<ReturnType<typeof fakePage>>} */ page) => String(page.catalog["favoritesSkipped"]?.message).replace("$count$", "2");
  const page = await fakePage();
  try {
    const { element, module } = page;
    const dramas = /** @type {unknown[]} */ (FAVORITES_CAPTURE["dramaList"]);
    const tab = favoritesTab({ pages: { "0": { ...FAVORITES_CAPTURE, hasMore: false, total: "5", dramaList: [...dramas, numeric, numeric] } } });
    tab.remember(1_794_351_500);
    const job = favoritesJob("favorites", null);
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await module.runFavorites(job, favoritesEngine(page, job).engine, entry), null);
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [LIGHTHOUSE, SNOW_A, SNOW_B]);
    assert.equal(element("favorites-count").textContent, `3 favorite dramas listed. ${skipped(page)}`);
    assert.deepEqual(entry, { favorites: 3, favorites_skipped: 2 });
  } finally {
    page.restore();
  }
  const seeded = await fakePage({ storage: { history: [{ ...historyEntry("favorites", "List your favorites", []), favorites: 3, favorites_skipped: 2 }] } });
  try {
    const item = /** @type {FakeElement} */ (seeded.element("history-list").children[0]);
    assert.deepEqual(item.children.slice(1).map((child) => child.textContent), ["3 favorite dramas listed.", skipped(seeded)]);
  } finally {
    seeded.restore();
  }
});

// --------------------------------------------------------------- the library (DramaFetch 1.6.0)

/** The fake profile's handle: the library's `profile`. */
const PROFILE = "@invented_viewer";
/** A sixth drama of the library tests. */
const LANTERN_ID = "7712345678901234566";

/**
 * A library as `chrome.storage.local` keeps it (`favoritesLibrary`), read two hours ago from the
 * profile — the whole list, every drama's episode count with it (`fullReadAt`) —: `items` as
 * `[series id, title, episodes]`, in the list's order.
 * @param {[string, string, number | null][]} items
 * @param {Record<string, unknown>} [changes]
 * @returns {Record<string, unknown>}
 */
function storedLibrary(items, changes = {}) {
  const readAt = Date.now() / 1000 - 2 * 3600 - 30;
  return {
    v: 1,
    listedAt: readAt,
    total: items.length,
    countedAt: null,
    fullReadAt: readAt,
    unconfirmed: false,
    complete: true,
    short: false,
    ended: null,
    profile: PROFILE,
    items: items.map(([seriesId, title, episodes]) => ({ seriesId, title, episodes, durationS: episodes === null ? null : episodes * 79 })),
    removed: [],
    ...changes,
  };
}

/**
 * A series' stored progress: `numbers` saved with the downloader's message (the cover embedded,
 * unless `bareCover` names episodes whose cover was not), found complete with `complete` episodes
 * (at `completeAt`, seconds since the epoch: a fixed time by default).
 * @param {string} seriesId
 * @param {number[]} numbers
 * @param {{complete?: number, bareCover?: number[], completeAt?: number}} [options]
 */
function savedState(seriesId, numbers, options = {}) {
  const state = newState(seriesId, "A drama");
  for (const number of numbers) {
    const message = options.bareCover?.includes(number) ? `saved E${number}.mp4 (0.1 MiB); cover: HTTP 404 from p16.tiktokcdn.com` : `saved E${number}.mp4 (0.1 MiB) + cover embedded`;
    record(state, { episode: { number, itemId: `i${number}` }, status: "done", path: `/dl/E${number}.mp4`, message, downloadId: number }, { exists: () => true, now: 1_800_000_000 });
  }
  if (options.complete !== undefined) markComplete(state, options.completeAt ?? 1_800_000_100, options.complete);
  return JSON.parse(JSON.stringify(state));
}

/** The five dramas of the page tests' favorites list, as the library keeps them. @type {[string, string, number][]} */
const FIVE = [
  [LIGHTHOUSE, "The Lighthouse Keeper's Promise", 60],
  [SNOW_A, "Snowfall in Two Cities", 60],
  [SNOW_B, "Snowfall in Two Cities", 60],
  [PAPER, "Paper Crowns", 30],
  [MOON, "Moonlight Over the Harbor", 12],
];

/**
 * A card of the library's grid, when it is drawn.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {string} seriesId
 */
const cardOf = (page, seriesId) => page.element("favorites-grid").children.find((card) => card.getAttribute("data-series-id") === seriesId);

/**
 * A card's button by its action (`remove`, `browse`, `open`), when it has one.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {string} seriesId
 * @param {string} action
 */
const actionOf = (page, seriesId, action) => {
  const card = cardOf(page, seriesId);
  return card === undefined ? undefined : descendants(card).find((part) => part.getAttribute("data-action") === action);
};

/**
 * The cards' `[series id, status text]`.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 */
const statusTexts = (page) => page.element("favorites-grid").children.map((card) => [card.getAttribute("data-series-id"), partOf(card, "favorite-status")?.textContent]);

/** @param {Awaited<ReturnType<typeof fakePage>>} page @param {number} [rounds] */
async function settled(page, rounds = 12) {
  for (let turn = 0; turn < rounds; turn += 1) await page.turn();
}

test("the page: the library kept from an earlier session is shown at once with no request — the connection line with TikTok's count, the filters' counts, the records' statuses, the twins, 60 cards at a time —; the search, the status filters and the sort narrow and order what is shown", async () => {
  /** @type {[string, string, number][]} */
  const many = Array.from({ length: 130 }, (_, n) => [String(7712345678901300000n + BigInt(n)), `Drama ${String(n).padStart(3, "0")}`, 10]);
  const page = await fakePage({
    storage: {
      favoritesLibrary: storedLibrary([...FIVE, ...many], { total: 134, removed: [{ seriesId: MOON, at: Date.now() / 1000 - 60 }] }),
      [`series:${LIGHTHOUSE}`]: savedState(LIGHTHOUSE, Array.from({ length: 60 }, (_, n) => n + 1), { complete: 60 }),
      [`series:${SNOW_B}`]: savedState(SNOW_B, [1]),
    },
  });
  try {
    const { element } = page;
    // shown at once, from storage: no TikTok tab asked for anything (the fake has no scripting at all)
    assert.equal(element("favorites-card").hidden, false);
    assert.equal(element("library-empty").hidden, true);
    assert.equal(element("library-source").textContent, "Read from your TikTok tab (@invented_viewer)");
    assert.equal(element("library-age").textContent, "2 h ago");
    assert.equal(element("library-total").textContent, "TikTok counts 134 dramas");
    assert.equal(element("library-stale").hidden, true); // the library holds what TikTok counts
    assert.equal(element("favorites-count").textContent, "134 favorite dramas listed.");
    assert.deepEqual(page.sessionKeys.filter((key) => String(key).startsWith("favoritesTemplate:")), []);
    // the filters' counts: the removed drama in none of them, its own line
    assert.deepEqual(
      ["all", "none", "partly", "on-disk"].map((filter) => element(`library-chip-${filter}`).textContent),
      ["All · 134", "Not downloaded · 132", "Partly · 1", "On disk · 1"],
    );
    assert.equal(element("library-chip-all").getAttribute("aria-pressed"), "true");
    assert.equal(element("library-removed").hidden, false);
    assert.match(String(element("library-removed").textContent), /^1 removed from your Favorites by DramaFetch since the last read/);
    // the first 60 cards, in the list's order, with the records' statuses and the twins' badge
    assert.equal(element("favorites-grid").children.length, 60);
    assert.deepEqual(statusTexts(page).slice(0, 6), [
      [LIGHTHOUSE, "On disk · 60/60"],
      [SNOW_A, "Not downloaded"],
      [SNOW_B, "Partly · 1/60"],
      [PAPER, "Not downloaded"],
      [MOON, "Removed from your Favorites"],
      [many[0]?.[0], "Not downloaded"],
    ]);
    assert.deepEqual(favoriteRows(page).slice(0, 2), [
      [LIGHTHOUSE, "The Lighthouse Keeper's Promise", "60 episodes · 1h 19m", "on-disk", false, true],
      [SNOW_A, "Snowfall in Two Cities", "60 episodes · 1h 19m", "none", false, true],
    ]);
    const twins = page.element("favorites-grid").children.filter((card) => partOf(card, "twin") !== undefined).map((card) => card.getAttribute("data-series-id"));
    assert.deepEqual(twins, [SNOW_A, SNOW_B]);
    assert.equal(cardOf(page, MOON)?.className, "drama-card removed"); // dashed, no tick, no action but its note
    assert.equal(tickOf(page, MOON), undefined);
    assert.equal(actionOf(page, MOON, "open"), undefined);
    assert.equal(cardOf(page, SNOW_B) !== undefined && descendants(/** @type {FakeElement} */ (cardOf(page, SNOW_B))).some((part) => part.tagName === "PROGRESS"), true); // partly: its bar
    // the actions: Remove from Favorites only on an on-disk card; See episodes on the others; Open on TikTok on both
    assert.ok(actionOf(page, LIGHTHOUSE, "remove") !== undefined && actionOf(page, LIGHTHOUSE, "browse") === undefined);
    assert.ok(actionOf(page, SNOW_B, "browse") !== undefined && actionOf(page, SNOW_B, "remove") === undefined);
    assert.ok(actionOf(page, LIGHTHOUSE, "open") !== undefined && actionOf(page, SNOW_B, "open") !== undefined);
    // 60 more at a time
    assert.equal(element("library-shown").textContent, "Showing 60 of 135");
    assert.equal(element("library-more").hidden, false);
    assert.equal(element("library-more").textContent, "Show 60 more");
    element("library-more").fire("click");
    assert.equal(element("favorites-grid").children.length, 120);
    assert.equal(element("library-more").textContent, "Show 15 more");
    element("library-more").fire("click");
    assert.equal(element("favorites-grid").children.length, 135);
    assert.equal(element("library-more").hidden, true);
    // the search (letter case aside) starts again from the first 60 of what matches
    element("favorites-filter").value = "DRAMA 12";
    element("favorites-filter").fire("input");
    assert.deepEqual(favoriteRows(page).map(([, title]) => title), Array.from({ length: 10 }, (_, n) => `Drama ${120 + n}`));
    element("favorites-filter").value = "";
    element("favorites-filter").fire("input");
    assert.equal(element("favorites-grid").children.length, 60);
    // a status filter: only its dramas — never the removed one
    element("library-chip-partly").fire("click");
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [SNOW_B]);
    assert.equal(element("library-chip-partly").getAttribute("aria-pressed"), "true");
    assert.equal(element("library-chip-all").getAttribute("aria-pressed"), "false");
    element("library-chip-on-disk").fire("click");
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [LIGHTHOUSE]);
    element("library-chip-none").fire("click");
    assert.equal(favoriteRows(page).length, 60);
    assert.ok(!favoriteRows(page).some(([id]) => [LIGHTHOUSE, SNOW_B, MOON].includes(String(id))));
    element("library-chip-all").fire("click");
    // the sort: title A–Z, most episodes first, back to the list's own order
    element("library-sort").value = "title";
    element("library-sort").fire("change");
    assert.deepEqual(favoriteRows(page).slice(0, 2).map(([, title]) => title), ["Drama 000", "Drama 001"]);
    element("favorites-filter").value = "o"; // the five's titles all hold an "o"; "Drama …" do not
    element("favorites-filter").fire("input");
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [MOON, PAPER, SNOW_A, SNOW_B, LIGHTHOUSE]);
    element("library-sort").value = "episodes";
    element("library-sort").fire("change");
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [LIGHTHOUSE, SNOW_A, SNOW_B, PAPER, MOON]);
    element("library-sort").value = "recent";
    element("library-sort").fire("change");
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [LIGHTHOUSE, SNOW_A, SNOW_B, PAPER, MOON]);
    assert.deepEqual(page.downloads, []);
    assert.equal(element("app-status").dataset["state"], "idle");
  } finally {
    page.restore();
  }
});

test("the page: with no library kept the section says how to fill it; once TikTok's count and the list differ, a second line says so", async () => {
  const empty = await fakePage();
  try {
    assert.equal(empty.element("favorites-card").hidden, true);
    assert.equal(empty.element("library-empty").hidden, false);
    assert.equal(empty.element("favorites-grid").children.length, 0);
  } finally {
    empty.restore();
  }
  const partial = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE.slice(0, 3), { total: 946, complete: false }) } });
  try {
    assert.equal(partial.element("library-total").textContent, "TikTok counts 946 dramas");
    assert.equal(partial.element("library-stale").hidden, false);
    // the reviewed wording (`libraryStale`): the button to press, named as such
    assert.equal(partial.element("library-stale").textContent, "This list has 3: press Update from TikTok to bring it up to date");
    assert.equal(partial.element("favorites-count").textContent, "3 of 946 favorite dramas listed.");
  } finally {
    partial.restore();
  }
});

test("the page: Download selected dramas queues ONE batch job over exactly the ticked dramas, in the order the library shows them — what Download all does with those ids —, leaves the box alone, clears the ticks, and the cards say Queued; nothing for an empty selection; Add selected to the box", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    const { element } = page;
    element("links").value = "a box typed by hand";
    // nothing ticked: nothing queued
    assert.equal(element("library-download").disabled, true);
    element("library-download").fire("click");
    assert.equal(element("app-status").dataset["state"], "idle");
    // two ticked, the library sorted by title: Paper Crowns comes first
    for (const seriesId of [LIGHTHOUSE, PAPER]) {
      const box = tickOf(page, seriesId);
      assert.ok(box !== undefined);
      box.checked = true;
      box.fire("change");
    }
    assert.equal(element("favorites-selection").textContent, "2 selected · 90 episodes");
    assert.equal(element("library-download").disabled, false);
    element("library-sort").value = "title";
    element("library-sort").fire("change");
    // Add selected to the box: the existing path — `# <title>` and id lines, in the order shown
    element("favorites-add-button").fire("click");
    assert.equal(element("links").value, `a box typed by hand\n# Paper Crowns\n${PAPER}\n# The Lighthouse Keeper's Promise\n${LIGHTHOUSE}`);
    element("links").value = "a box typed by hand";
    page.hold(); // the job's `tabs.getCurrent` never answers: it runs, and makes no request
    element("library-download").fire("click");
    await page.turn();
    assert.equal(element("progress-current").textContent, "2 series"); // Download all's label
    assert.deepEqual(queuedLabels(page), []); // one job, running
    assert.equal(element("links").value, "a box typed by hand"); // the box untouched
    assert.equal(element("favorites-selection").textContent, "0 selected · 0 episodes");
    assert.deepEqual(favoriteRows(page).filter(([, , , , ticked]) => ticked), []);
    assert.equal(element("favorites-status").textContent, "2 series queued: they download one after the other, with the usual pauses.");
    // the cards of the job's series say Queued; the others what the records say
    element("library-sort").value = "recent";
    element("library-sort").fire("change");
    assert.deepEqual(favoriteRows(page).map(([id, , , status]) => [id, status]), [
      [LIGHTHOUSE, "queued"],
      [SNOW_A, "none"],
      [SNOW_B, "none"],
      [PAPER, "queued"],
      [MOON, "none"],
    ]);
  } finally {
    page.restore();
  }
  // the same, run to its end — the discovery can open no tab here, so no request is ever made —: its
  // history entry is a batch over exactly those series, in the order shown
  const run = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) }, testSettings: { existenceRateLimitS: 0, existenceDelayMs: 0 } });
  try {
    const { element } = run;
    for (const seriesId of [LIGHTHOUSE, PAPER]) {
      const box = tickOf(run, seriesId);
      assert.ok(box !== undefined);
      box.checked = true;
      box.fire("change");
    }
    element("library-sort").value = "title";
    element("library-sort").fire("change");
    element("library-download").fire("click");
    for (let turn = 0; turn < 500 && (run.local.get("history") === undefined || element("app-status").dataset["state"] !== "idle"); turn += 1) await run.turn();
    const [entry] = /** @type {Record<string, unknown>[]} */ (run.local.get("history"));
    assert.ok(entry !== undefined);
    assert.equal(entry["kind"], "batch");
    assert.equal(entry["label"], "2 series");
    assert.deepEqual(/** @type {Record<string, unknown>[]} */ (entry["series"]).map((series) => series["series_id"]), [PAPER, LIGHTHOUSE]);
  } finally {
    run.restore();
  }
});

test("the page: while a write was refused (app.unsaved) Download selected dramas queues nothing and says why; the job buttons of the library are disabled", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    const { element, module } = page;
    const box = tickOf(page, PAPER);
    assert.ok(box !== undefined);
    box.checked = true;
    box.fire("change");
    const engine = module.buildEngine({ ...BATCH_JOB }, { pauses: [], inputs: [], taking: true });
    Object.assign(chrome.storage.local, {
      set: async () => {
        throw new Error(REFUSED);
      },
    });
    await engine.persist?.(); // a save of the pacing, refused: remembered
    assert.equal(element("library-download").disabled, true);
    assert.equal(actionOf(page, PAPER, "browse")?.disabled, true);
    element("library-download").fire("click");
    await settled(page);
    assert.equal(element("app-status").dataset["state"], "idle");
    assert.equal(element("app-status").dataset["finished"], "0");
    assert.match(String(element("input-status").textContent), /^DramaFetch stopped: /);
  } finally {
    page.restore();
  }
});

test("the page: Download selected dramas pressed while Update from TikTok still reads the list queues what the bar counts — the ticked dramas read so far — and unticks only those: a ticked drama the update has not reached yet stays ticked, its card ticked again once TikTok's whole list is read, or once the library comes back as it was (an update cut short), for the next press", async () => {
  const [shape] = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
  const NEW_ID = "7712345678901234568";
  // TikTok's list now: a favorite added since on top — the smart refresh's first page differs, so the
  // update reads the whole list, the library refilling page by page
  const first = { ...FAVORITES_CAPTURE, total: "6", dramaList: [{ ...shape, dramaID: NEW_ID, dramaName: "A New Favorite" }, .../** @type {unknown[]} */ (FAVORITES_CAPTURE["dramaList"])] };
  for (const [why, secondPage, after] of /** @type {[string, Record<string, unknown>, string[]][]} */ ([
    ["TikTok's whole list read", { .../** @type {Record<string, unknown>} */ (favoritesPages()["1794351568"]), total: "6" }, [NEW_ID, ...FIVE.map(([seriesId]) => seriesId)]],
    ["page 2 answered HTTP 404: the library as it was", { __dramafetch_status: 404, __dramafetch_text: "" }, FIVE.map(([seriesId]) => seriesId)],
  ])) {
    const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) }, testSettings: { pageDelayS: 0.001 } });
    try {
      const { element } = page;
      // The Lighthouse Keeper's Promise (on TikTok's page 1) and Moonlight Over the Harbor (on page 2) ticked
      for (const seriesId of [LIGHTHOUSE, MOON]) {
        const box = tickOf(page, seriesId);
        assert.ok(box !== undefined, why);
        box.checked = true;
        box.fire("change");
      }
      assert.equal(element("favorites-selection").textContent, "2 selected · 72 episodes", why);
      const tab = favoritesTab({ pages: { "0": first, "1794351568": secondPage } });
      tab.remember(1_794_351_500);
      // page 2 held until released: the update is between its two pages
      let asked = false;
      /** @type {() => void} */
      let release = () => undefined;
      const held = new Promise((resolve) => (release = () => resolve(undefined)));
      const fake = /** @type {{scripting: {executeScript: (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => Promise<unknown>}}} */ (
        /** @type {unknown} */ (globalThis.chrome)
      );
      const read = fake.scripting.executeScript;
      fake.scripting.executeScript = async (injection) => {
        if (injection.world === "MAIN" && /[?&]cursor=1794351568/.test(String(injection.args?.[0]))) {
          asked = true;
          await held;
        }
        return read(injection);
      };
      Object.assign(chrome.tabs, { query: async () => [{ id: FAVORITES_TAB, index: 0, windowId: 1, active: false, url: "https://www.tiktok.com/@invented_viewer" }] });
      element("library-refresh").fire("click");
      for (let turn = 0; turn < 500 && !asked; turn += 1) await page.turn();
      assert.ok(asked, why);
      await settled(page);
      // the library shows page 1's dramas so far: the bar counts the one ticked drama among them
      assert.deepEqual(favoriteRows(page).map(([id]) => id), [NEW_ID, LIGHTHOUSE, SNOW_A, SNOW_B], why);
      assert.equal(element("favorites-selection").textContent, "1 selected · 60 episodes", why);
      element("library-download").fire("click");
      await settled(page);
      // ONE job, waiting behind the update, over what the bar counted; that drama's tick cleared
      assert.deepEqual(queuedLabels(page), [`Series ${LIGHTHOUSE}`], why);
      assert.equal(element("favorites-status").textContent, "1 series queued: they download one after the other, with the usual pauses.", why);
      assert.equal(element("favorites-selection").textContent, "0 selected · 0 episodes", why);
      page.hold(); // the batch's tabs.getCurrent never answers: it starts, and asks nothing of TikTok
      release();
      for (let turn = 0; turn < 500 && element("progress-current").textContent !== `Series ${LIGHTHOUSE}`; turn += 1) await page.turn();
      await settled(page);
      assert.equal(element("progress-current").textContent, `Series ${LIGHTHOUSE}`, why);
      // the update over: the drama it had not reached when the button was pressed is still ticked
      assert.deepEqual(favoriteRows(page).map(([id]) => id), after, why);
      assert.deepEqual(favoriteRows(page).filter(([, , , , ticked]) => ticked).map(([id]) => id), [MOON], why);
      assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "queued", why);
      assert.equal(element("favorites-selection").textContent, "1 selected · 12 episodes", why);
      // the next press queues it: its own job, behind the running one
      element("library-download").fire("click");
      await settled(page);
      assert.deepEqual(queuedLabels(page), [`Series ${MOON}`], why);
      assert.equal(element("favorites-selection").textContent, "0 selected · 0 episodes", why);
      assert.equal(cardOf(page, MOON)?.getAttribute("data-status"), "queued", why);
    } finally {
      page.restore();
    }
  }
});

test("the page: a card's status follows a batch job — Queued while it waits, Downloading S/N after every episode, then what the records say once its series is done", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    const { element, module, local } = page;
    const status = () => Object.fromEntries(statusTexts(page));
    page.hold();
    const box = tickOf(page, PAPER);
    assert.ok(box !== undefined);
    box.checked = true;
    box.fire("change");
    element("library-download").fire("click");
    await page.turn();
    assert.equal(status()[PAPER], "Queued");
    // the running job's hooks, as the engine calls them
    const job = /** @type {import("../src/app/app.js").Job} */ ({ ...BATCH_JOB, label: "Series", refs: [{ kind: "series", seriesId: PAPER, episodeHint: null, sourceUrl: PAPER }] });
    const engine = module.buildEngine(job, { pauses: [], inputs: [], taking: true });
    engine.onSeriesStart?.(1, 1, { kind: "series", seriesId: PAPER, episodeHint: null, sourceUrl: PAPER });
    assert.equal(status()[PAPER], "Downloading · 0/30");
    local.set(`series:${PAPER}`, savedState(PAPER, [1, 2]));
    const ep = makeEpisode({ number: 2, itemId: "i2", title: "Episode 2", seriesId: PAPER, durationS: 3, coverUrl: null, raw: {} });
    engine.onResult?.({ episode: ep, status: "done", path: "/dl/E2.mp4", message: "saved E2.mp4 (0.1 MiB) + cover embedded", downloadId: 2 });
    await settled(page);
    assert.equal(status()[PAPER], "Downloading · 2/30");
    local.set(`series:${PAPER}`, savedState(PAPER, Array.from({ length: 30 }, (_, n) => n + 1), { complete: 30 }));
    engine.onSeriesDone?.(1, 1, finishedRun(PAPER, "Paper Crowns", []));
    await settled(page);
    assert.equal(status()[PAPER], "On disk · 30/30");
    assert.equal(element("library-chip-on-disk").textContent, "On disk · 1");
  } finally {
    page.restore();
  }
});

test("the page: Remove from Favorites on an on-disk card opens the confirmation with what the records support — the cover line only when every saved episode's message says it was embedded —; confirmed, it queues the removal once; Cancel queues nothing", async () => {
  const page = await fakePage({
    storage: {
      favoritesLibrary: storedLibrary([
        [LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3],
        [PAPER, "Paper Crowns", 3],
        [MOON, "Moonlight Over the Harbor", 3],
      ]),
      [`series:${LIGHTHOUSE}`]: savedState(LIGHTHOUSE, [1, 2, 3], { complete: 3 }),
      [`series:${PAPER}`]: savedState(PAPER, [1, 2, 3], { complete: 3, bareCover: [2] }),
      [`series:${MOON}`]: savedState(MOON, [1]),
    },
  });
  try {
    const { element } = page;
    const facts = () => element("bookmark-dialog-facts").children.map((fact) => [fact.getAttribute("data-fact"), fact.textContent]);
    // only an on-disk card offers it
    assert.equal(actionOf(page, MOON, "remove"), undefined);
    actionOf(page, LIGHTHOUSE, "remove")?.fire("click");
    await settled(page);
    assert.equal(element("bookmark-dialog").open, true);
    assert.equal(element("bookmark-dialog-name").textContent, "The Lighthouse Keeper's Promise");
    assert.equal(element("bookmark-dialog-meta").textContent, "3 episodes · 4m");
    assert.deepEqual(facts().map(([fact]) => fact), ["saved", "verified", "complete", "cover"]);
    assert.equal(facts()[0]?.[1], "3 of 3 episodes on disk");
    assert.equal(facts()[3]?.[1], "Cover included in every episode");
    element("bookmark-cancel").fire("click");
    assert.equal(element("bookmark-dialog").open, false);
    assert.equal(element("app-status").dataset["state"], "idle"); // nothing queued
    // one episode's cover only kept as a file: no cover line
    actionOf(page, PAPER, "remove")?.fire("click");
    await settled(page);
    assert.deepEqual(facts().map(([fact]) => fact), ["saved", "verified", "complete"]);
    element("bookmark-cancel").fire("click");
    // confirmed: the removal job, once
    page.hold();
    actionOf(page, LIGHTHOUSE, "remove")?.fire("click");
    await settled(page);
    element("bookmark-confirm").fire("click");
    await page.turn();
    assert.equal(element("bookmark-dialog").open, false);
    assert.equal(element("progress-current").textContent, "Remove “The Lighthouse Keeper's Promise” from your Favorites");
    actionOf(page, LIGHTHOUSE, "remove")?.fire("click");
    await settled(page);
    element("bookmark-confirm").fire("click");
    assert.equal(element("favorites-status").textContent, "“The Lighthouse Keeper's Promise” is already waiting to be removed from your Favorites.");
    assert.deepEqual(queuedLabels(page), []);
  } finally {
    page.restore();
  }
});

/**
 * The drama's TikTok page and the user's TikTok profile tab (42, its favorites address kept by the
 * worker) on the page's fake chrome, for Remove from Favorites: `tabs` (the background tab 77
 * opened, navigated, closed; the profile tab), `scripting` (the Bookmark read or pressed in the
 * drama's tab, the favorites list's first page fetched in the profile's), `webRequest` (the page's
 * own `collect`, and its own episode list as it reloads: `reloadList`, a status) and the session
 * storage. `log` records the steps; `site.recorded` is the worker's record of the drama's tab
 * (`DISCOVERY_TAB_KEY`) as it stood at the click. `profileUrl` is the profile tab's address (the
 * library's own profile, `@invented_viewer`, by default); `buttonsAfterReload: 0` makes the reloaded
 * page show no Bookmark button.
 * @param {{saved?: boolean, keeps?: boolean, profileTab?: boolean, firstPage?: Record<string, unknown>, profileUrl?: string, reloadList?: number, buttonsAfterReload?: number}} [options]
 */
function bookmarkChrome(options = {}) {
  const fake = /** @type {Record<string, Record<string, unknown>>} */ (/** @type {unknown} */ (globalThis.chrome));
  const site = { saved: options.saved ?? true, shown: "", url: "", clicks: 0, loads: 0, recorded: /** @type {unknown} */ (undefined) };
  /** @type {string[]} */
  const log = [];
  /** @type {Map<string, unknown>} */
  const session = new Map();
  const profile = options.profileUrl ?? "https://www.tiktok.com/@invented_viewer";
  // the worker's record: the address and whose list it reads, the profile page that asked for it
  if (options.profileTab !== false) session.set(`favoritesTemplate:${FAVORITES_TAB}`, { url: FAVORITES_TEMPLATE, at: 1_794_351_500, profile: profileHandleOf(profile) });
  /** @type {((details: chrome.webRequest.CompletedDetails) => void)[]} */
  let listeners = [];
  Object.assign(fake["tabs"] ?? {}, {
    create: async (/** @type {chrome.tabs.CreateProperties} */ properties) => {
      log.push(`open ${properties.url}`);
      site.url = "about:blank";
      return { id: 77, index: 1, windowId: 10, active: false, status: "complete" };
    },
    update: async (/** @type {number} */ tabId, /** @type {chrome.tabs.UpdateProperties} */ properties) => {
      if (tabId === 77 && properties.url !== undefined) {
        log.push(`navigate ${properties.url}`);
        site.url = properties.url;
        site.loads += 1;
        site.shown = site.saved ? "saved" : "unsaved";
        if (site.loads > 1 && options.buttonsAfterReload === 0) site.shown = "";
        if (site.loads > 1 && options.reloadList !== undefined) {
          // the reloaded page's own episode-list request, answered so
          const url = `https://www.tiktok.com/api/drama/episode/item_list/?aid=1988&count=30&cursor=0&seriesId=${LIGHTHOUSE}`;
          for (const listener of listeners) listener({ requestId: "2", url, method: "GET", tabId: 77, type: "xmlhttprequest", timeStamp: 0, statusCode: options.reloadList, fromCache: false });
        }
      }
      return { id: tabId, index: 1, windowId: 10, active: false };
    },
    get: async (/** @type {number} */ tabId) => {
      if (tabId === 77) return { id: 77, index: 1, windowId: 10, active: false, status: "complete", url: site.url };
      if (tabId === FAVORITES_TAB) return { id: tabId, index: 0, windowId: 1, active: false, url: profile };
      throw new Error(`No tab with id: ${tabId}.`);
    },
    remove: async (/** @type {number} */ tabId) => void log.push(`close ${tabId}`),
    query: async () => (options.profileTab === false ? [] : [{ id: FAVORITES_TAB, index: 0, windowId: 1, active: false, url: profile }]),
  });
  fake["webRequest"] = {
    onCompleted: {
      addListener: (/** @type {(details: chrome.webRequest.CompletedDetails) => void} */ listener) => void listeners.push(listener),
      removeListener: (/** @type {(details: chrome.webRequest.CompletedDetails) => void} */ listener) => {
        listeners = listeners.filter((known) => known !== listener);
      },
    },
    onErrorOccurred: { addListener: () => undefined, removeListener: () => undefined },
  };
  fake["scripting"] = {
    executeScript: async (/** @type {chrome.scripting.ScriptInjection<unknown[], unknown>} */ injection) => {
      if (injection.target.tabId === FAVORITES_TAB) {
        assert.equal(injection.world, "MAIN");
        const [url] = /** @type {[string]} */ (injection.args);
        log.push(`request ${url}`);
        return [{ frameId: 0, result: JSON.parse(JSON.stringify(options.firstPage ?? FAVORITES_CAPTURE)) }];
      }
      assert.equal(injection.target.tabId, 77);
      assert.equal(injection.world, undefined); // the drama's page: the ISOLATED world only
      if (injection.args === undefined) return [{ frameId: 0, result: "A drama" }]; // its text
      const [press, seriesId] = /** @type {[boolean, string]} */ (injection.args);
      assert.ok(typeof seriesId === "string" && site.url.includes(`/shortdrama/episode/${seriesId}/`)); // the drama the tab was opened on
      if (press && site.shown === "saved") {
        site.clicks += 1;
        log.push("click");
        site.recorded = session.get(DISCOVERY_TAB_KEY); // the worker's record of this tab, while it is open
        for (const listener of listeners) listener({ requestId: "1", url: "https://www.tiktok.com/api/item/collect/?action=0", method: "GET", tabId: 77, type: "xmlhttprequest", timeStamp: 0, statusCode: 200, fromCache: false });
        site.shown = "unsaved";
        if (options.keeps !== false) site.saved = false;
        return [{ frameId: 0, documentId: site.url + site.clicks, result: "clicked" }];
      }
      return [{ frameId: 0, documentId: `${site.url}#${log.length}`, result: site.shown || "missing" }];
    },
  };
  fake["storage"] = {
    ...fake["storage"],
    session: {
      get: async (/** @type {string} */ key) => (session.has(key) ? { [key]: session.get(key) } : {}),
      set: async (/** @type {Record<string, unknown>} */ items) => {
        for (const [key, value] of Object.entries(items)) session.set(key, value);
      },
      remove: async (/** @type {string} */ key) => void session.delete(key),
    },
  };
  return { site, log, session };
}

/**
 * The removal job as the page queues it, and its engine: pauses recorded, a clock they move on.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {string} seriesId
 * @param {string} title
 * @param {number} episodes
 */
function removalJob(page, seriesId, title, episodes) {
  /** @type {import("../src/app/app.js").Job} */
  const job = { id: 9, kind: "unbookmark", label: `Remove “${title}” from your Favorites`, refs: [{ kind: "series", seriesId, episodeHint: null, sourceUrl: seriesId }], series: null, numbers: [], includeLocked: false, recheck: false, bookmark: { seriesId, title, episodes } };
  const engine = page.module.buildEngine(job, { pauses: [], inputs: [], taking: true });
  /** @type {number[]} */
  const pauses = [];
  let clock = 0;
  engine.sleep = async (seconds) => {
    pauses.push(seconds);
    clock += seconds;
  };
  engine.clock = () => clock;
  engine.rng = { uniform: (low) => low };
  return { job, engine, pauses };
}

test("the page: a removal — the records say on disk —: TikTok's Bookmark pressed once in a background tab and checked after a reload; the card says so at once, the counts follow, TikTok's new total from ONE first-page request of the profile's tab, the library kept without any address", async () => {
  const LIBRARY = [
    [LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3],
    [SNOW_A, "Snowfall in Two Cities", 60],
    [SNOW_B, "Snowfall in Two Cities", 60],
  ];
  const page = await fakePage({
    storage: {
      favoritesLibrary: storedLibrary(/** @type {[string, string, number][]} */ (LIBRARY), { total: 946, complete: false }),
      [`series:${LIGHTHOUSE}`]: savedState(LIGHTHOUSE, [1, 2, 3], { complete: 3 }),
    },
  });
  try {
    const { element, module, local } = page;
    const after = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]).slice(1);
    const { site, log } = bookmarkChrome({ firstPage: { ...FAVORITES_CAPTURE, total: "945", dramaList: after } });
    const { job, engine, pauses } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(element("library-chip-on-disk").textContent, "On disk · 1");
    assert.equal(await module.runUnbookmark(job, engine, entry), null);
    // one click, in a background tab opened and closed, the page reloaded to check; then one request
    assert.equal(site.clicks, 1);
    // the tab recorded for the worker with THIS DramaFetch tab (1): the worker closes it if this tab goes away
    assert.deepEqual(site.recorded, { tabId: 77, appTabId: 1 });
    const drama = `https://www.tiktok.com/shortdrama/episode/${LIGHTHOUSE}/1`;
    assert.deepEqual(log, ["open about:blank", `navigate ${drama}`, "click", `navigate ${drama}`, "close 77", `request ${FAVORITES_TEMPLATE}`]);
    // a pause before the click, the reload and the first-page request (and the polls in between)
    assert.deepEqual(pauses.filter((seconds) => seconds !== 1), [0.8, 0.8, 0.8]);
    assert.deepEqual(entry["bookmark"], { series_id: LIGHTHOUSE, title: "The Lighthouse Keeper's Promise", outcome: "removed" });
    assert.equal(entry["error"], undefined);
    // the card says so, out of the counts but its own line; the count TikTok's new total
    assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "removed");
    assert.equal(element("library-chip-all").textContent, "All · 2");
    assert.equal(element("library-chip-on-disk").textContent, "On disk · 0");
    assert.equal(element("library-total").textContent, "TikTok counts 945 dramas");
    assert.equal(element("library-age").textContent, "just now");
    assert.equal(element("favorites-status").textContent, "“The Lighthouse Keeper's Promise” removed from your Favorites: TikTok kept the change. TikTok counts 945 dramas.");
    // kept: the removal and the count — and no address, no cover URL, nothing signed
    const kept = /** @type {Record<string, unknown>} */ (local.get("favoritesLibrary"));
    assert.equal(kept["total"], 945);
    assert.deepEqual(/** @type {Record<string, unknown>[]} */ (kept["removed"]).map((removed) => removed["seriesId"]), [LIGHTHOUSE]);
    assert.doesNotMatch(JSON.stringify(kept), /http/);
  } finally {
    page.restore();
  }
});

test("the page: a drama whose records hold episodes beyond the library's count that did not download (TikTok added them after the list was read, and the run failed on them) is Partly, never On disk: its card says so, and Remove from Favorites asks nothing of TikTok", async () => {
  const state = JSON.parse(JSON.stringify(savedState(LIGHTHOUSE, [1, 2, 3])));
  for (const number of [4, 5]) {
    state.episodes[String(number)] = { number, item_id: `i${number}`, status: "failed", path: null, message: "download looks incomplete or wrong: truncated body (60 %)", updated_at: "2027-01-15T08:00:00Z", download_id: null };
  }
  const page = await fakePage({
    storage: {
      favoritesLibrary: storedLibrary([[LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3], [SNOW_A, "Snowfall in Two Cities", 60]], { total: 946 }),
      [`series:${LIGHTHOUSE}`]: state,
    },
  });
  try {
    assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "partly");
    assert.equal(Object.fromEntries(statusTexts(page))[LIGHTHOUSE], "Partly · 3/5"); // the records know 5 episodes
    const { site, log } = bookmarkChrome();
    const { job, engine, pauses } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await page.module.runUnbookmark(job, engine, entry), null);
    assert.deepEqual(log, []); // no tab, no request
    assert.deepEqual(pauses, []);
    assert.equal(site.clicks, 0);
    assert.equal(entry["error"], BOOKMARK_MESSAGES["not-on-disk"]);
  } finally {
    page.restore();
  }
});

test("the page: a removal that changes nothing — no request without the records' on disk, TikTok still listing the drama first thing (not kept after all), no TikTok tab to count with (the last count minus one, not confirmed), Stop after the click (the outcome unknown)", async () => {
  // the records do not say on disk: nothing asked of TikTok at all
  let page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE), [`series:${PAPER}`]: savedState(PAPER, [1, 2]) } });
  try {
    const { site, log } = bookmarkChrome();
    const { job, engine, pauses } = removalJob(page, PAPER, "Paper Crowns", 30);
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await page.module.runUnbookmark(job, engine, entry), null);
    assert.deepEqual(log, []);
    assert.deepEqual(pauses, []);
    assert.equal(site.clicks, 0);
    assert.match(String(entry["error"]), /^not removed from your Favorites: DramaFetch's records do not show every episode/);
    assert.equal(page.element("favorites-status").textContent, "“Paper Crowns” was not removed: DramaFetch's records do not show every episode of it on disk. Nothing was asked of TikTok.");
    assert.equal(cardOf(page, PAPER)?.getAttribute("data-status"), "partly");
  } finally {
    page.restore();
  }
  // TikTok keeps nothing a synthetic click did, but the reloaded page lied: the first page still holds it — not kept, a stop
  const library = { favoritesLibrary: storedLibrary([[LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3], [SNOW_A, "Snowfall in Two Cities", 60]], { total: 946 }), [`series:${LIGHTHOUSE}`]: savedState(LIGHTHOUSE, [1, 2, 3], { complete: 3 }) };
  page = await fakePage({ storage: library });
  try {
    bookmarkChrome({ firstPage: FAVORITES_CAPTURE });
    const { job, engine } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    /** @type {Record<string, unknown>} */
    const entry = {};
    const stop = await page.module.runUnbookmark(job, engine, entry);
    assert.equal(stop, "TikTok did not keep the change: the drama is still in your Favorites — remove it on TikTok yourself");
    assert.equal(entry["error"], stop);
    assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "on-disk"); // back as it was
    assert.equal(page.element("library-total").textContent, "TikTok counts 946 dramas");
    assert.equal(page.element("favorites-status").textContent, "TikTok did not keep the change: “The Lighthouse Keeper's Promise” is still in your Favorites. Remove it yourself: Open on TikTok.");
  } finally {
    page.restore();
  }
  // no TikTok tab with the list open: removed, the count the last one minus one — not confirmed
  page = await fakePage({ storage: library });
  try {
    const { log } = bookmarkChrome({ profileTab: false });
    const { job, engine } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    assert.equal(await page.module.runUnbookmark(job, engine, {}), null);
    assert.ok(!log.some((step) => step.startsWith("request ")));
    assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "removed");
    assert.equal(page.element("library-total").textContent, "TikTok counts 945 dramas (not confirmed: open your profile → Favorites → Drama and press Update from TikTok)");
    const kept = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
    assert.equal(kept["total"], 945);
    assert.equal(kept["unconfirmed"], true);
  } finally {
    page.restore();
  }
  // Stop once Bookmark was pressed: the tab closed, the outcome unknown — the history says to check on TikTok
  page = await fakePage({ storage: library });
  try {
    const { site, log } = bookmarkChrome();
    const { job, engine } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    const sleep = engine.sleep;
    engine.sleep = async (seconds) => {
      if (site.clicks > 0) throw new StopRequested();
      await sleep(seconds);
    };
    /** @type {Record<string, unknown>} */
    const entry = {};
    await assert.rejects(page.module.runUnbookmark(job, engine, entry), StopRequested);
    assert.equal(site.clicks, 1);
    assert.ok(log.includes("close 77"));
    assert.equal(/** @type {Record<string, unknown>} */ (entry["bookmark"])["outcome"], "stopped by you after DramaFetch pressed Bookmark: the outcome is unknown — check on TikTok");
    assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "on-disk");
  } finally {
    page.restore();
  }
});

test("the page: the smart refresh — a library read from this TikTok profile and still TikTok's list costs ONE request (the removed dramas leave it); otherwise the whole list is read and becomes the library; nothing kept signed", async () => {
  const [shape] = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
  /** @param {string} seriesId @param {string} title @param {number} episodes */
  const entryOf = (seriesId, title, episodes) => ({ ...shape, dramaID: seriesId, dramaName: title, numVideos: episodes, totalDuration: String(episodes * 79) });
  const list = FIVE.map(([seriesId, title, episodes]) => entryOf(seriesId, title, episodes));
  /** @param {Record<string, unknown>[]} dramas @returns {Record<string, unknown>} TikTok's list in two pages: three, then the rest */
  const pagesOf = (dramas) => ({
    "0": { ...FAVORITES_CAPTURE, total: String(dramas.length), cursor: "1794351568", hasMore: true, dramaList: dramas.slice(0, 3) },
    "1794351568": { ...FAVORITES_CAPTURE, total: String(dramas.length), cursor: "1794350100", hasMore: false, dramaList: dramas.slice(3) },
  });
  // unchanged: one request; TikTok's count; the dramas DramaFetch removed leave the library
  let page = await fakePage({ storage: { favoritesLibrary: storedLibrary([...FIVE, [LANTERN_ID, "The Last Lantern", 24]], { total: 6, removed: [{ seriesId: LANTERN_ID, at: 1 }] }) } });
  try {
    const { element, module, local } = page;
    const tab = favoritesTab({ pages: pagesOf(list) });
    tab.remember(1_794_351_500);
    assert.equal(cardOf(page, LANTERN_ID)?.getAttribute("data-status"), "removed");
    const job = favoritesJob("favorites", null);
    const { engine, pauses } = favoritesEngine(page, job);
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await module.runFavorites(job, engine, entry), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]); // the first page only
    assert.deepEqual(pauses, [0.8]);
    assert.equal(element("input-status").textContent, "No changes: TikTok counts 5 dramas.");
    assert.equal(entry["favorites"], 5);
    assert.deepEqual(favoriteRows(page).map(([id]) => id), FIVE.map(([seriesId]) => seriesId)); // the removed one left
    assert.equal(element("library-removed").hidden, true);
    assert.equal(element("library-total").textContent, "TikTok counts 5 dramas");
    const kept = /** @type {Record<string, unknown>} */ (local.get("favoritesLibrary"));
    assert.deepEqual(kept["removed"], []);
    assert.equal(/** @type {unknown[]} */ (kept["items"]).length, 5);
    assert.doesNotMatch(JSON.stringify(kept), /http/);
  } finally {
    page.restore();
  }
  // a favorite added since (newest first): the first page differs — the whole list read, it becomes the library
  page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    const { element, module, local } = page;
    const added = [entryOf(LANTERN_ID, "The Last Lantern", 24), ...list];
    const tab = favoritesTab({ pages: pagesOf(added) });
    tab.remember(1_794_351_500);
    const job = favoritesJob("favorites", null);
    assert.equal(await module.runFavorites(job, favoritesEngine(page, job).engine, {}), null);
    assert.equal(tab.fetched.length, 2);
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [LANTERN_ID, ...FIVE.map(([seriesId]) => seriesId)]);
    assert.equal(element("library-total").textContent, "TikTok counts 6 dramas");
    // 1.6.0's guidance (`favoritesLoaded`): the library's own Download selected dramas first, the box second
    assert.equal(element("input-status").textContent, "6 favorite dramas listed: tick the ones to download and press Download selected dramas (or Add selected to the box).");
    const kept = /** @type {Record<string, unknown>} */ (local.get("favoritesLibrary"));
    assert.equal(kept["profile"], PROFILE);
    assert.equal(/** @type {unknown[]} */ (kept["items"]).length, 6);
    assert.doesNotMatch(JSON.stringify(kept), /http/);
  } finally {
    page.restore();
  }
  // a library read from another profile: never taken for this one's — the whole list read
  page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE, { profile: "@someone_else" }) } });
  try {
    const tab = favoritesTab({ pages: pagesOf(list) });
    tab.remember(1_794_351_500);
    const job = favoritesJob("favorites", null);
    assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, {}), null);
    assert.equal(tab.fetched.length, 2);
    assert.equal(/** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"))["profile"], PROFILE);
  } finally {
    page.restore();
  }
  // a refusal before the first page leaves the library as it was — shown and kept
  page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    const tab = favoritesTab({ pages: { "0": { __dramafetch_status: 429, __dramafetch_text: "" } } });
    tab.remember(1_794_351_500);
    const job = favoritesJob("favorites", null);
    const { engine } = favoritesEngine(page, job);
    try {
      assert.equal(await page.module.runFavorites(job, engine, {}), FAVORITES_RATE_LIMIT_MESSAGE);
      assert.deepEqual(favoriteRows(page).map(([id]) => id), FIVE.map(([seriesId]) => seriesId));
      assert.equal(/** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"))["items"]).length, 5);
    } finally {
      await clearCooldown(engine.cooldownStore);
    }
  } finally {
    page.restore();
  }
});

test("the page: an update that does not reach TikTok's end never shrinks the library kept — page 2 answered HTTP 429, Stop after page 1, TikTok sending no more after page 1: the library in the page and on disk is the one it was (the drama DramaFetch removed still marked), only TikTok's count of page 1 taken (the library's own profile), the time of its whole read kept; the status line, the history entry, the cooldown and the job's stop as before", async () => {
  const [shape] = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
  const NEW_ID = "7712345678901234568";
  // TikTok's list now: a favorite added since on top — so the smart refresh's first page differs and
  // the listing reads on —, seven in all
  const first = {
    ...FAVORITES_CAPTURE,
    total: "7",
    cursor: "1794351568",
    hasMore: true,
    dramaList: [{ ...shape, dramaID: NEW_ID, dramaName: "A New Favorite" }, .../** @type {unknown[]} */ (FAVORITES_CAPTURE["dramaList"]).slice(0, 2)],
  };
  /** the library kept: the five, and a sixth DramaFetch removed since its whole list was read (two hours ago) */
  const keptSix = () => storedLibrary([...FIVE, [LANTERN_ID, "The Last Lantern", 24]], { total: 6, removed: [{ seriesId: LANTERN_ID, at: 1_794_000_000 }] });
  const sixIds = [...FIVE.map(([seriesId]) => seriesId), LANTERN_ID];
  /**
   * The library as it was, in the page and on disk — but for TikTok's count of page 1, read now.
   * @param {Awaited<ReturnType<typeof fakePage>>} page
   * @param {Record<string, unknown>} stored what the page was seeded with
   */
  const keptAsItWas = (page, stored) => {
    assert.deepEqual(favoriteRows(page).map(([id]) => id), sixIds); // its dramas, in its order
    assert.equal(cardOf(page, LANTERN_ID)?.getAttribute("data-status"), "removed"); // its mark kept
    assert.equal(cardOf(page, NEW_ID), undefined); // nothing of the partial read
    assert.equal(page.element("library-total").textContent, "TikTok counts 7 dramas"); // page 1's count
    assert.equal(page.element("library-stale").textContent, "This list has 5: press Update from TikTok to bring it up to date");
    const kept = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
    assert.deepEqual(/** @type {{seriesId: string}[]} */ (kept["items"]).map((item) => item.seriesId), sixIds);
    assert.deepEqual(kept["removed"], stored["removed"]);
    assert.equal(kept["total"], 7);
    assert.ok(Math.abs(Number(kept["countedAt"]) - Date.now() / 1000) < 60, "TikTok's count read now");
    assert.equal(kept["unconfirmed"], false);
    for (const key of ["fullReadAt", "listedAt", "complete", "profile"]) assert.deepEqual(kept[key], stored[key], key); // the whole read's
  };
  // page 2 answered HTTP 429: the job's stop, the cooldown recorded with its reason, nothing counted in the history
  let stored = keptSix();
  let page = await fakePage({ storage: { favoritesLibrary: stored } });
  try {
    const tab = favoritesTab({ pages: { "0": first, "1794351568": { __dramafetch_status: 429, __dramafetch_text: "" } } });
    tab.remember(1_794_351_500);
    const job = favoritesJob("favorites", null);
    const { engine } = favoritesEngine(page, job);
    /** @type {Record<string, unknown>} */
    const entry = {};
    try {
      assert.equal(await page.module.runFavorites(job, engine, entry), FAVORITES_RATE_LIMIT_MESSAGE);
      assert.equal(tab.fetched.length, 2); // nothing after the refusal
      assert.equal(/** @type {Record<string, unknown>} */ (page.local.get("cooldown"))["reason"], FAVORITES_RATE_LIMIT_MESSAGE);
      assert.equal(page.element("input-status").textContent, FAVORITES_RATE_LIMIT_MESSAGE);
      assert.deepEqual(entry, { error: FAVORITES_RATE_LIMIT_MESSAGE });
      keptAsItWas(page, stored);
    } finally {
      await clearCooldown(engine.cooldownStore);
    }
  } finally {
    page.restore();
  }
  // Stop once page 1 was read: the job stopped, the history keeps the three it listed
  stored = keptSix();
  page = await fakePage({ storage: { favoritesLibrary: stored } });
  try {
    const tab = favoritesTab({ pages: { "0": first } });
    tab.remember(1_794_351_500);
    const job = favoritesJob("favorites", null);
    const { engine } = favoritesEngine(page, job);
    engine.stopRequested = () => tab.fetched.length > 0;
    /** @type {Record<string, unknown>} */
    const entry = {};
    await assert.rejects(page.module.runFavorites(job, engine, entry), StopRequested);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.deepEqual(entry, { favorites: 3 });
    keptAsItWas(page, stored);
  } finally {
    page.restore();
  }
  // TikTok sends no more after page 1 (`favorites.cutShort`): no stop; the status line and the history
  // say how many TikTok sent, as before
  stored = keptSix();
  page = await fakePage({ storage: { favoritesLibrary: stored } });
  try {
    const tab = favoritesTab({ pages: { "0": first, "1794351568": { dramaList: [], hasMore: false, statusCode: 0 } } });
    tab.remember(1_794_351_500);
    const job = favoritesJob("favorites", null);
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, entry), null);
    assert.equal(tab.fetched.length, 2);
    const cutShortText = String(page.catalog["favoritesCutShort"]?.message).replace("$count$", "3");
    // the status line says the library was kept as it was (1.6.0's review: 1.5.0's "the rest of the
    // list is not shown" was said next to every drama the library kept); the history keeps why, as before
    assert.equal(page.element("input-status").textContent, String(page.catalog["libraryKept"]?.message).replace("$count$", "3"));
    assert.equal(page.element("input-status").className, "status error");
    assert.deepEqual(entry, { favorites: 3, error: cutShortText });
    keptAsItWas(page, stored);
  } finally {
    page.restore();
  }
});

test("the page: an empty first page never wipes the library kept — TikTok counting dramas it did not send, or giving no count (a replay it no longer accepts may come back so): the library as it was, its ticks too, only a count TikTok gave taken; TikTok's whole list counting none is adopted — no favorites left", async () => {
  for (const [why, firstPage, total] of /** @type {[string, Record<string, unknown>, number | null][]} */ ([
    ["TikTok counting 12", { ...FAVORITES_CAPTURE, total: "12", hasMore: false, dramaList: [] }, 12],
    ["no count", { dramaList: [], hasMore: false, statusCode: 0 }, null],
  ])) {
    const stored = storedLibrary(FIVE);
    const page = await fakePage({ storage: { favoritesLibrary: stored } });
    try {
      const tick = tickOf(page, PAPER);
      assert.ok(tick !== undefined, why);
      tick.checked = true;
      tick.fire("change");
      const tab = favoritesTab({ pages: { "0": firstPage } });
      tab.remember(1_794_351_500);
      const job = favoritesJob("favorites", null);
      /** @type {Record<string, unknown>} */
      const entry = {};
      assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, entry), null, why);
      assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE], why);
      assert.deepEqual(favoriteRows(page).map(([id]) => id), FIVE.map(([seriesId]) => seriesId), why);
      // the status line says the library was not updated — never "0 favorite dramas listed", as success —;
      // the history keeps why: TikTok cutting the list short when it counted more, else that text
      const keptText = String(page.catalog["libraryKeptEmpty"]?.message);
      assert.equal(page.element("input-status").textContent, keptText, why);
      assert.equal(page.element("input-status").className, "status error", why);
      assert.deepEqual(entry, { favorites: 0, error: total === null ? keptText : String(page.catalog["favoritesCutShort"]?.message).replace("$count$", "0") }, why);
      assert.deepEqual(favoriteRows(page).filter(([, , , , ticked]) => ticked).map(([id]) => id), [PAPER], why); // never pruned by a list not kept
      assert.equal(page.element("favorites-selection").textContent, "1 selected · 30 episodes", why);
      const kept = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
      assert.deepEqual(/** @type {{seriesId: string}[]} */ (kept["items"]).map((item) => item.seriesId), FIVE.map(([seriesId]) => seriesId), why);
      assert.equal(kept["total"], total ?? 5, why); // TikTok's count when it gave one: the library's own profile
      assert.equal(kept["fullReadAt"], stored["fullReadAt"], why);
      if (total === null) assert.equal(kept, stored, why); // nothing to take: not even written
    } finally {
      page.restore();
    }
  }
  // TikTok's whole list, counting none: the user has no favorites left — the library says so
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    const tab = favoritesTab({ pages: { "0": { ...FAVORITES_CAPTURE, total: "0", hasMore: false, dramaList: [] } } });
    tab.remember(1_794_351_500);
    const job = favoritesJob("favorites", null);
    assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, {}), null);
    assert.deepEqual(favoriteRows(page), []);
    assert.equal(page.element("library-total").textContent, "TikTok counts 0 dramas");
    const kept = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
    assert.deepEqual(kept["items"], []);
    assert.equal(kept["total"], 0);
    assert.equal(kept["complete"], true);
    assert.ok(Math.abs(Number(kept["fullReadAt"]) - Date.now() / 1000) < 60, "TikTok's whole list, read now");
  } finally {
    page.restore();
  }
});

test("the page: an update read partially from a tab of another TikTok profile leaves the library exactly as it was — that account's count never taken —; with no library yet, the dramas read before a refusal become the library, kept as before", async () => {
  const refusedAfterPage1 = { "0": FAVORITES_CAPTURE, "1794351568": { __dramafetch_status: 429, __dramafetch_text: "" } };
  const stored = storedLibrary(FIVE); // read from @invented_viewer
  let page = await fakePage({ storage: { favoritesLibrary: stored } });
  try {
    const tab = favoritesTab({ tabUrl: "https://www.tiktok.com/@someone_else", pages: refusedAfterPage1 });
    tab.remember(1_794_351_500);
    const job = favoritesJob("favorites", null);
    const { engine } = favoritesEngine(page, job);
    try {
      assert.equal(await page.module.runFavorites(job, engine, {}), FAVORITES_RATE_LIMIT_MESSAGE);
      assert.equal(tab.fetched.length, 2); // another profile: no smart refresh, its list read from the top
      assert.deepEqual(favoriteRows(page).map(([id]) => id), FIVE.map(([seriesId]) => seriesId));
      assert.equal(page.element("library-total").textContent, "TikTok counts 5 dramas"); // not the other account's 946
      assert.equal(page.local.get("favoritesLibrary"), stored); // the very object it was seeded with: not one write
    } finally {
      await clearCooldown(engine.cooldownStore);
    }
  } finally {
    page.restore();
  }
  // no library yet: what was read before the refusal becomes the library — kept, with the tab's
  // profile and TikTok's count, its whole list never read
  page = await fakePage();
  try {
    const tab = favoritesTab({ pages: refusedAfterPage1 });
    tab.remember(1_794_351_500);
    const job = favoritesJob("favorites", null);
    const { engine } = favoritesEngine(page, job);
    try {
      assert.equal(await page.module.runFavorites(job, engine, {}), FAVORITES_RATE_LIMIT_MESSAGE);
      assert.deepEqual(favoriteRows(page).map(([id]) => id), [LIGHTHOUSE, SNOW_A, SNOW_B]);
      const kept = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
      assert.deepEqual(/** @type {{seriesId: string}[]} */ (kept["items"]).map((item) => item.seriesId), [LIGHTHOUSE, SNOW_A, SNOW_B]);
      assert.equal(kept["total"], 946);
      assert.equal(kept["complete"], false);
      assert.equal(kept["fullReadAt"], null);
      assert.equal(kept["profile"], PROFILE);
    } finally {
      await clearCooldown(engine.cooldownStore);
    }
  } finally {
    page.restore();
  }
});

test("the page: the popup's Open my library away from a TikTok profile shows the library — the engine's tab answers, no job, no request —; a read-only tab stays silent; with no page running, the tab the worker opens at ?library=1 shows it", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  /** how often a page that was handed nothing scrolled its library into view while it started */
  let atStart = 0;
  try {
    const before = page.element("library").scrolledIntoView ?? 0;
    atStart = before;
    assert.deepEqual(page.message({ type: "dramafetch:library" }), [{ ok: true, tabId: 1 }]);
    assert.equal(page.element("library").scrolledIntoView, before + 1);
    assert.equal(page.element("app-status").dataset["state"], "idle");
    assert.equal(page.local.get("history"), undefined);
    assert.deepEqual(page.message({ type: "dramafetch:library" }, "another-extension-id"), []);
  } finally {
    page.restore();
  }
  const readonly = await fakePage({ lockTaken: true, storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    assert.deepEqual(readonly.message({ type: "dramafetch:library" }), []);
  } finally {
    readonly.restore();
  }
  // no page was running to answer: the worker opened (or reloaded) the DramaFetch tab at ?library=1 —
  // the library shown once, the address back to the page's own, no job, nothing kept
  const opened = await fakePage({ search: "?library=1", storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    assert.equal(opened.element("library").scrolledIntoView ?? 0, atStart + 1);
    assert.deepEqual(opened.replaced, ["/src/app/app.html"]);
    assert.equal(opened.element("app-status").dataset["state"], "idle");
    assert.equal(opened.local.get("history"), undefined);
    assert.equal(favoriteRows(opened).length, 5);
  } finally {
    opened.restore();
  }
});

test("the page: after a removal TikTok's count is read only from a tab of the library's own profile — another account's favorites tab is never asked: the last count minus one, not confirmed", async () => {
  const page = await fakePage({
    storage: {
      favoritesLibrary: storedLibrary([[LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3], [SNOW_A, "Snowfall in Two Cities", 60]], { total: 946 }),
      [`series:${LIGHTHOUSE}`]: savedState(LIGHTHOUSE, [1, 2, 3], { complete: 3 }),
    },
  });
  try {
    const { site, log } = bookmarkChrome({ profileUrl: "https://www.tiktok.com/@someone_else" });
    const { job, engine } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await page.module.runUnbookmark(job, engine, entry), null);
    assert.equal(site.clicks, 1);
    assert.ok(log.includes("close 77"));
    assert.ok(!log.some((step) => step.startsWith("request ")), "another account's list is never asked for this library's count");
    assert.deepEqual(entry["bookmark"], { series_id: LIGHTHOUSE, title: "The Lighthouse Keeper's Promise", outcome: "removed" });
    assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "removed");
    assert.equal(page.element("library-total").textContent, "TikTok counts 945 dramas (not confirmed: open your profile → Favorites → Drama and press Update from TikTok)");
    const kept = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
    assert.equal(kept["total"], 945);
    assert.equal(kept["unconfirmed"], true);
    assert.equal(kept["profile"], PROFILE);
  } finally {
    page.restore();
  }
});

test("the page: the episode list's thumbnails and the library's covers share the page's one lane — never two cover requests in flight at once — and the same gate: never during a job or a cooldown, nor after a refused write", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    const { list, library } = page.module.coverLoaders();
    assert.notEqual(list, library);
    assert.ok(list.options.lane !== undefined, "the episode list's loader takes its turns in a lane");
    assert.equal(list.options.lane, library.options.lane, "one lane for both loaders");
    // both asked, before each pause and again right before each request, whether a request may go out
    assert.equal(list.options.allowed, page.module.coversAllowed);
    assert.equal(library.options.allowed, page.module.coversAllowed);
  } finally {
    page.restore();
  }
});

/** The library of the removal tests: two dramas, TikTok counting 946; the first one downloaded whole. */
const REMOVAL_LIBRARY = () => ({
  favoritesLibrary: storedLibrary([[LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3], [SNOW_A, "Snowfall in Two Cities", 60]], { total: 946 }),
  [`series:${LIGHTHOUSE}`]: savedState(LIGHTHOUSE, [1, 2, 3], { complete: 3 }),
});
/** The connection line's count once a removal could not be counted: the last one minus one. */
const UNCONFIRMED_945 = "TikTok counts 945 dramas (not confirmed: open your profile → Favorites → Drama and press Update from TikTok)";

test("the page: a removal whose reloaded drama page saw TikTok answer its OWN episode list HTTP 429 — the discovery's rule —: the removal stands (the card removed), the cooldown recorded, and the job stops without asking for the count (the last one minus one, not confirmed)", async () => {
  const page = await fakePage({ storage: REMOVAL_LIBRARY() });
  try {
    const { site, log } = bookmarkChrome({ reloadList: 429 });
    const { job, engine } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    /** @type {Record<string, unknown>} */
    const entry = {};
    try {
      assert.equal(await page.module.runUnbookmark(job, engine, entry), LIST_RATE_LIMIT_MESSAGE); // the job's stop
      assert.equal(site.clicks, 1);
      assert.ok(log.includes("close 77"));
      assert.ok(!log.some((step) => step.startsWith("request ")), "nothing asked after TikTok's refusal");
      assert.deepEqual(entry["bookmark"], { series_id: LIGHTHOUSE, title: "The Lighthouse Keeper's Promise", outcome: "removed" });
      assert.equal(entry["error"], LIST_RATE_LIMIT_MESSAGE);
      const cooldown = /** @type {Record<string, unknown>} */ (page.local.get("cooldown"));
      assert.equal(cooldown["reason"], LIST_RATE_LIMIT_MESSAGE);
      assert.equal(cooldown["source"], "discovery");
      assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "removed");
      assert.equal(page.element("library-total").textContent, UNCONFIRMED_945);
    } finally {
      await clearCooldown(engine.cooldownStore);
    }
  } finally {
    page.restore();
  }
});

test("the page: a removal pressed and seen off whose reloaded page shows no Bookmark button: not-confirmed — the job's stop (never a second click), the drama as it was, the page's own words", async () => {
  const page = await fakePage({ storage: REMOVAL_LIBRARY() });
  try {
    const { site, log } = bookmarkChrome({ buttonsAfterReload: 0 });
    const { job, engine } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    /** @type {Record<string, unknown>} */
    const entry = {};
    const stop = await page.module.runUnbookmark(job, engine, entry);
    assert.equal(stop, BOOKMARK_MESSAGES["not-confirmed"]); // a stop: the jobs waiting behind end without a request
    assert.equal(site.clicks, 1);
    assert.ok(log.includes("close 77"));
    assert.ok(!log.some((step) => step.startsWith("request ")));
    assert.equal(/** @type {Record<string, unknown>} */ (entry["bookmark"])["outcome"], BOOKMARK_MESSAGES["not-confirmed"]);
    assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "on-disk");
    assert.equal(
      page.element("favorites-status").textContent,
      "TikTok did not confirm that “The Lighthouse Keeper's Promise” was removed: DramaFetch pressed Bookmark once and could not check that TikTok kept the change (the button did not turn off, or the page could not be read again). It does not press it again — check with Open on TikTok.",
    );
  } finally {
    page.restore();
  }
});

test("the page: a write chrome.storage.local refuses during a removal — after the click, or right before the drama's page opens — means not one request more: the count's first page is never asked, the job's stop is the refusal", async () => {
  // refused from the click on: the removal stands (TikTok removed it), its count is never asked
  let page = await fakePage({ storage: REMOVAL_LIBRARY() });
  try {
    const { site, log } = bookmarkChrome();
    const { job, engine } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    const set = chrome.storage.local.set;
    Object.assign(chrome.storage.local, {
      set: async (/** @type {Record<string, unknown>} */ items) => {
        if (site.clicks > 0) throw new Error(REFUSED);
        return set(items);
      },
    });
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await page.module.runUnbookmark(job, engine, entry), UNSAVED);
    assert.equal(entry["error"], UNSAVED);
    assert.equal(site.clicks, 1);
    assert.ok(log.includes("close 77"));
    assert.ok(!log.some((step) => step.startsWith("request ")), "no request after a refused write");
    assert.equal(/** @type {Record<string, unknown>} */ (entry["bookmark"])["outcome"], "removed");
    assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "removed");
    assert.equal(page.element("library-total").textContent, UNCONFIRMED_945);
  } finally {
    page.restore();
  }
  // refused when the job notes its contact, right before the drama's page: no tab opened at all
  page = await fakePage({ storage: REMOVAL_LIBRARY() });
  try {
    const { site, log } = bookmarkChrome();
    const { job, engine } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    const set = chrome.storage.local.set;
    let pacingWrites = 0;
    Object.assign(chrome.storage.local, {
      set: async (/** @type {Record<string, unknown>} */ items) => {
        if ("pacing" in items && (pacingWrites += 1) >= 2) throw new Error(REFUSED); // the gate's own write passed
        return set(items);
      },
    });
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await page.module.runUnbookmark(job, engine, entry), UNSAVED);
    assert.deepEqual(log, []);
    assert.equal(site.clicks, 0);
    assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "on-disk");
  } finally {
    page.restore();
  }
});

test("the page: Stop while TikTok's count is about to be read after a removal: the removal stands, the count is the last one minus one — not confirmed, and kept so —, the job stopped before that request", async () => {
  const page = await fakePage({ storage: REMOVAL_LIBRARY() });
  try {
    const { site, log } = bookmarkChrome();
    const { job, engine } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    const sleep = engine.sleep;
    engine.sleep = async (seconds) => {
      if (log.includes("close 77")) throw new StopRequested(); // Stop during the pause before the count's request
      await sleep(seconds);
    };
    /** @type {Record<string, unknown>} */
    const entry = {};
    await assert.rejects(page.module.runUnbookmark(job, engine, entry), StopRequested);
    assert.equal(site.clicks, 1);
    assert.ok(!log.some((step) => step.startsWith("request ")));
    assert.equal(/** @type {Record<string, unknown>} */ (entry["bookmark"])["outcome"], "removed");
    assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "removed");
    assert.equal(page.element("library-total").textContent, UNCONFIRMED_945);
    const kept = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
    assert.equal(kept["total"], 945);
    assert.equal(kept["unconfirmed"], true);
    assert.equal(
      page.element("favorites-status").textContent,
      "“The Lighthouse Keeper's Promise” removed from your Favorites: TikTok kept the change. TikTok's count is not confirmed: open your profile → Favorites → Drama and press Update from TikTok.",
    );
  } finally {
    page.restore();
  }
});

test("the page: a drama whose page already shows the Bookmark as off (no proof TikTok's list lost it: a page may draw the button before it knows): nothing pressed, nothing changed — the card as it was, the count as it was, no request for it —, the status line points to Update from TikTok; the history says what came of each removal — removed, already off, refused at the gate (said once), stopped after the click (the outcome unknown)", async () => {
  const page = await fakePage({ storage: REMOVAL_LIBRARY() });
  try {
    const after = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]).slice(1);
    const { site, log } = bookmarkChrome({ saved: false, firstPage: { ...FAVORITES_CAPTURE, total: "945", dramaList: after } });
    const { job, engine } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    const total = page.element("library-total").textContent;
    const stored = JSON.stringify(page.local.get("favoritesLibrary"));
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await page.module.runUnbookmark(job, engine, entry), null);
    assert.equal(site.clicks, 0);
    const drama = `https://www.tiktok.com/shortdrama/episode/${LIGHTHOUSE}/1`;
    assert.deepEqual(log, ["open about:blank", `navigate ${drama}`, "close 77"]); // no count requested
    assert.deepEqual(entry["bookmark"], { series_id: LIGHTHOUSE, title: "The Lighthouse Keeper's Promise", outcome: "already" });
    assert.equal(entry["error"], undefined);
    assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "on-disk");
    assert.equal(page.element("library-total").textContent, total);
    assert.equal(JSON.stringify(page.local.get("favoritesLibrary")), stored); // the library kept as it was
    assert.equal(page.element("favorites-status").textContent, "On the page of “The Lighthouse Keeper's Promise”, the Bookmark already shows as off: DramaFetch pressed nothing and changed nothing in your library. If you removed it on TikTok yourself, press Update from TikTok.");
  } finally {
    page.restore();
  }
  // Past runs: each removal's line, never a URL
  const at = "2026-11-19T10:00:00.000Z";
  /** @param {string} title @param {unknown} outcome @param {string | null} error */
  const removal = (title, outcome, error) => ({
    id: 1,
    kind: "unbookmark",
    label: `Remove “${title}” from your Favorites`,
    started_at: at,
    finished_at: at,
    error,
    stopped: error,
    refreshes: 0,
    pauses: [],
    series: [],
    bookmark: { series_id: LIGHTHOUSE, title, outcome },
  });
  const seeded = await fakePage({
    storage: {
      history: [
        removal("Kept off", "removed", null),
        removal("Gone already", "already", null),
        removal("Refused", BOOKMARK_MESSAGES["not-on-disk"], BOOKMARK_MESSAGES["not-on-disk"]),
        removal("Stopped", BOOKMARK_MESSAGES.unknown, "stopped by you"),
      ],
    },
  });
  try {
    const lines = seeded.element("history-list").children.map((item) => item.children.slice(1).map((line) => line.textContent));
    assert.deepEqual(lines, [
      ["Removed from your Favorites: TikTok kept the change"],
      ["Its page already showed the Bookmark as off: nothing was pressed, nothing changed"],
      [BOOKMARK_MESSAGES["not-on-disk"]], // its reason once: the outcome is the error
      ["stopped by you", BOOKMARK_MESSAGES.unknown], // the history says to check on TikTok
    ]);
  } finally {
    seeded.restore();
  }
});

test("the page: the removal job's gate — the rest between jobs before the drama's page opens, a cooldown met right after that rest, a write the storage refuses — and TikTok refusing the count's request (HTTP 429): a stop with the cooldown, the drama removed, the count the last one minus one, not confirmed", async () => {
  /** TikTok contacted 30 s ago (the stored pacing): the next job rests first. */
  const contacted = { pacing: { lastContactAt: Date.now() / 1000 - 30 } };
  let page = await fakePage({ storage: { ...REMOVAL_LIBRARY(), ...contacted } });
  try {
    const { log } = bookmarkChrome({ firstPage: { ...FAVORITES_CAPTURE, total: "945", dramaList: /** @type {unknown[]} */ (FAVORITES_CAPTURE["dramaList"]).slice(1) } });
    const { job, engine, pauses } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    /** @type {number[]} how many steps the drama's tab had taken at each pause */
    const steps = [];
    const sleep = engine.sleep;
    engine.sleep = async (seconds) => {
      steps.push(log.length);
      await sleep(seconds);
    };
    assert.equal(await page.module.runUnbookmark(job, engine, {}), null);
    assert.equal(pauses[0], 60); // the rest between jobs, at the rng's floor
    assert.equal(steps[0], 0); // before the drama's tab was even opened
    assert.equal(log[0], "open about:blank");
  } finally {
    page.restore();
  }
  // a cooldown recorded during that rest (another tab's job, say): met right after it — no tab opened
  page = await fakePage({ storage: { ...REMOVAL_LIBRARY(), ...contacted } });
  try {
    const { log } = bookmarkChrome();
    const { job, engine } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    const sleep = engine.sleep;
    engine.sleep = async (seconds) => {
      if (seconds === 60) await recordBlock(engine.cooldownStore, "rate limited (HTTP 429) by the video server", "browser", { now: Date.now() / 1000 });
      await sleep(seconds);
    };
    /** @type {Record<string, unknown>} */
    const entry = {};
    try {
      const stop = await page.module.runUnbookmark(job, engine, entry);
      assert.match(String(stop), /^TikTok refused a request at /);
      assert.equal(entry["error"], stop);
      assert.deepEqual(log, []);
      assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "on-disk");
    } finally {
      await clearCooldown(engine.cooldownStore);
    }
  } finally {
    page.restore();
  }
  // chrome.storage.local refuses the write that asks whether anything can be stored: no tab opened
  page = await fakePage({ storage: REMOVAL_LIBRARY() });
  try {
    const { log } = bookmarkChrome();
    const { job, engine } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    Object.assign(chrome.storage.local, {
      set: async () => {
        throw new Error(REFUSED);
      },
    });
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await page.module.runUnbookmark(job, engine, entry), UNSAVED);
    assert.equal(entry["error"], UNSAVED);
    assert.deepEqual(log, []);
  } finally {
    page.restore();
  }
  // TikTok refuses the count's first page (HTTP 429): the job's stop, with the cooldown; the removal stands
  page = await fakePage({ storage: REMOVAL_LIBRARY() });
  try {
    const { site, log } = bookmarkChrome({ firstPage: { __dramafetch_status: 429, __dramafetch_text: "" } });
    const { job, engine } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    /** @type {Record<string, unknown>} */
    const entry = {};
    try {
      assert.equal(await page.module.runUnbookmark(job, engine, entry), FAVORITES_RATE_LIMIT_MESSAGE);
      assert.equal(entry["error"], FAVORITES_RATE_LIMIT_MESSAGE);
      assert.equal(site.clicks, 1);
      assert.equal(log.filter((step) => step.startsWith("request ")).length, 1); // that one, nothing after it
      const cooldown = /** @type {Record<string, unknown>} */ (page.local.get("cooldown"));
      assert.equal(cooldown["reason"], FAVORITES_RATE_LIMIT_MESSAGE);
      assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "removed");
      assert.equal(page.element("library-total").textContent, UNCONFIRMED_945);
    } finally {
      await clearCooldown(engine.cooldownStore);
    }
  } finally {
    page.restore();
  }
});

test("the page: the library's episode counts are trusted for 24 hours after its whole list was read — the smart refresh then costs one request; older, the whole list is read again and a series that gained episodes says so —; a removal needs a count that fresh (the whole read, or a run that found the series complete), else nothing is asked of TikTok", async () => {
  const [shape] = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
  /** @param {string} seriesId @param {string} title @param {number} episodes */
  const entryOf = (seriesId, title, episodes) => ({ ...shape, dramaID: seriesId, dramaName: title, numVideos: episodes, totalDuration: String(episodes * 79) });
  // TikTok's list: the same five dramas in the same order — Paper Crowns now has 40 episodes, not 30
  const grown = FIVE.map(([seriesId, title, episodes]) => entryOf(seriesId, title, seriesId === PAPER ? 40 : episodes));
  const pages = {
    "0": { ...FAVORITES_CAPTURE, total: "5", cursor: "1794351568", hasMore: true, dramaList: grown.slice(0, 3) },
    "1794351568": { ...FAVORITES_CAPTURE, total: "5", cursor: "1794350100", hasMore: false, dramaList: grown.slice(3) },
  };
  const stale = Date.now() / 1000 - 25 * 3600;
  const thirty = Array.from({ length: 30 }, (_, n) => n + 1);
  let page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE, { fullReadAt: stale }), [`series:${PAPER}`]: savedState(PAPER, thirty, { complete: 30 }) } });
  try {
    await settled(page);
    assert.equal(Object.fromEntries(statusTexts(page))[PAPER], "On disk · 30/30"); // what the old count says
    let tab = favoritesTab({ pages });
    tab.remember(1_794_351_500);
    let job = favoritesJob("favorites", null);
    assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, {}), null);
    assert.equal(tab.fetched.length, 2); // the whole list: its first page could not tell
    await settled(page);
    assert.equal(Object.fromEntries(statusTexts(page))[PAPER], "Partly · 30/40");
    const read = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
    assert.ok(Math.abs(Number(read["fullReadAt"]) - Date.now() / 1000) < 60, "the whole list read now");
    // read whole a moment ago: nothing changed — one request, and the whole read stays the earlier one
    tab = favoritesTab({ pages });
    tab.remember(1_794_351_500);
    job = favoritesJob("favorites", null);
    assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.equal(/** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"))["fullReadAt"], read["fullReadAt"]);
  } finally {
    page.restore();
  }
  // a removal whose count was read more than 24 h ago — and no run found the series complete since —: nothing asked
  const library = storedLibrary([[LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3], [SNOW_A, "Snowfall in Two Cities", 60]], { total: 946, fullReadAt: stale });
  page = await fakePage({ storage: { favoritesLibrary: library, [`series:${LIGHTHOUSE}`]: savedState(LIGHTHOUSE, [1, 2, 3], { complete: 3, completeAt: Date.now() / 1000 - 3 * 86_400 }) } });
  try {
    const { site, log } = bookmarkChrome();
    const { job, engine, pauses } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await page.module.runUnbookmark(job, engine, entry), null); // nothing pressed: no stop
    assert.deepEqual(log, []);
    assert.deepEqual(pauses, []);
    assert.equal(site.clicks, 0);
    assert.equal(entry["error"], BOOKMARK_MESSAGES.stale);
    assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "on-disk");
    assert.equal(
      page.element("favorites-status").textContent,
      "“The Lighthouse Keeper's Promise” was not removed: its episode count was read from TikTok more than 24 hours ago, and new episodes may have come since. Press Update from TikTok first, then remove it. Nothing was asked of TikTok.",
    );
  } finally {
    page.restore();
  }
  // a run found the series complete an hour ago: that count is fresh — removed as usual
  page = await fakePage({ storage: { favoritesLibrary: library, [`series:${LIGHTHOUSE}`]: savedState(LIGHTHOUSE, [1, 2, 3], { complete: 3, completeAt: Date.now() / 1000 - 3600 }) } });
  try {
    const { site } = bookmarkChrome({ firstPage: { ...FAVORITES_CAPTURE, total: "945", dramaList: /** @type {unknown[]} */ (FAVORITES_CAPTURE["dramaList"]).slice(1) } });
    const { job, engine } = removalJob(page, LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3);
    assert.equal(await page.module.runUnbookmark(job, engine, {}), null);
    assert.equal(site.clicks, 1);
    assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "removed");
  } finally {
    page.restore();
  }
});

test("the page: a cover whose signed address has expired is never asked for — restored from the browser session's memory, or one the page still shows past its signature (asked right before each request) —, while a fresh one is", async () => {
  /** @param {string} seriesId @param {number} expires */
  const signed = (seriesId, expires) => `https://p16-common-sign.tiktokcdn.com/c/${seriesId}.avif?x-expires=${expires}&x-signature=INVENTED%3D`;
  const past = Math.floor(Date.now() / 1000) - 86_400;
  const future = Math.floor(Date.now() / 1000) + 86_400;
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) }, session: { favoritesCovers: { [LIGHTHOUSE]: signed(LIGHTHOUSE, past), [SNOW_A]: signed(SNOW_A, future) } } });
  try {
    const { library } = page.module.coverLoaders();
    assert.equal(library.urls.has(LIGHTHOUSE), false); // expired: its card shows the title, no request
    assert.equal(library.urls.get(SNOW_A), signed(SNOW_A, future));
    assert.equal(library.options.usable?.(signed(SNOW_A, future)), true);
    assert.equal(library.options.usable?.(signed(SNOW_A, past)), false);
  } finally {
    page.restore();
  }
});

test("the page: right-clicks over a library kept from an earlier session — a list of no tab, never trusted — cost what they cost in 1.5.0: the first card's listing is kept as that tab's list, so a card it reaches needs no request (two of its title shown from the library), one further down reads on and extends it; the library stays as it was", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    const { element, module } = page;
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    // a card at index 0: the tab's list read until it reaches it (one page)
    let job = favoritesJob("load", { title: "The Lighthouse Keeper's Promise", index: 0 });
    let run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.deepEqual(run.listed, [LIGHTHOUSE]);
    // the same card again: that listing reaches it — no request
    run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.deepEqual(run.listed, [LIGHTHOUSE]);
    // a card of a title two dramas of that listing bear: shown from the library (which holds both), no request
    job = favoritesJob("load", { title: "Snowfall in Two Cities", index: 1 });
    run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.deepEqual(run.listed, []);
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [SNOW_A, SNOW_B]);
    element("favorites-filter").value = "";
    element("favorites-filter").fire("input");
    // a card further down: read on from the top to its end — the kept listing extended (complete)
    job = favoritesJob("load", { title: "Paper Crowns", index: 3 });
    run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.equal(tab.fetched.length, 3);
    assert.deepEqual(run.listed, [PAPER]);
    // and every card of that whole list now needs no request
    job = favoritesJob("load", { title: "Moonlight Over the Harbor", index: 4 });
    run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.equal(tab.fetched.length, 3);
    assert.deepEqual(run.listed, [MOON]);
    // the library itself: as it was kept
    assert.deepEqual(favoriteRows(page).map(([id]) => id), FIVE.map(([seriesId]) => seriesId));
    assert.equal(/** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"))["items"]).length, 5);
  } finally {
    page.restore();
  }
});

test("the page: a card whose title two dramas share, read from a list that reached it but not its end, over a larger library of the same profile that lacks one of them (favorited since, or removed by DramaFetch and bookmarked again): that listing is joined into the library — the one it lacked on top, a removed one unmarked, saved, nothing shrunk — and every drama of the title shown to pick from, never only the library's older ones", async () => {
  const NEW_SNOW = "7712345678901234567";
  const [shape] = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
  /** @param {string} seriesId @param {string} title */
  const entryOf = (seriesId, title) => ({ ...shape, dramaID: seriesId, dramaName: title, numVideos: 60, totalDuration: "5820" });
  /** @type {[string, string, number][]} */
  const many = Array.from({ length: 40 }, (_, n) => [String(7712345678901300000n + BigInt(n)), `Drama ${String(n).padStart(3, "0")}`, 10]);
  /** @param {string[][]} first the first page's dramas: [id, title] */
  const pagesOf = (first) => ({ "0": { ...FAVORITES_CAPTURE, total: "46", cursor: "1794351568", hasMore: true, dramaList: first.map(([seriesId, title]) => entryOf(String(seriesId), String(title))) } });
  const card = { title: "Snowfall in Two Cities", index: 0 };
  const ids = [...FIVE, ...many].map(([seriesId]) => seriesId);
  /** @param {Awaited<ReturnType<typeof fakePage>>} page @returns {{seriesId: string, durationS: number | null}[]} */
  const keptItems = (page) => /** @type {{seriesId: string, durationS: number | null}[]} */ (/** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"))["items"]);
  // a drama of the title favorited since, on top: the listing's two are it and SNOW_A — joined into
  // the library (1.6.0's review; before, that three-drama listing took the larger library's place and
  // was kept so): the one it lacked goes on top, in the listing's order (TikTok lists the newest
  // first), and the library shows every drama of the title it holds now — SNOW_B too
  let page = await fakePage({ storage: { favoritesLibrary: storedLibrary([...FIVE, ...many]) } });
  try {
    const tab = favoritesTab({ pages: pagesOf([[NEW_SNOW, "Snowfall in Two Cities"], [SNOW_A, "Snowfall in Two Cities"], [LIGHTHOUSE, "The Lighthouse Keeper's Promise"]]) });
    tab.remember(1_794_351_500);
    const job = favoritesJob("load", card);
    const run = favoritesEngine(page, job);
    assert.equal(await page.module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.deepEqual(run.listed, []); // nothing guessed
    assert.equal(page.element("input-status").textContent, String(page.catalog["favoritesShared"]?.message).replace("$title$", card.title));
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [NEW_SNOW, SNOW_A, SNOW_B]); // the one right-clicked is offered, with the others of its title
    assert.ok(tickOf(page, NEW_SNOW) !== undefined);
    assert.equal(page.element("library-chip-all").textContent, "All · 46"); // grown by one, nothing lost
    // kept so: the one it lacked on top, every drama the listing read with its fresh entry, TikTok's count the listing's
    assert.deepEqual(keptItems(page).map((item) => item.seriesId), [NEW_SNOW, ...ids]);
    assert.equal(keptItems(page).find((item) => item.seriesId === LIGHTHOUSE)?.durationS, 5820); // the listing's, not the library's 60 × 79
    assert.equal(/** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"))["total"], 46);
    assert.equal(page.element("library-total").textContent, "TikTok counts 46 dramas");
  } finally {
    page.restore();
  }
  // SNOW_B removed by DramaFetch, then bookmarked again by hand: no longer marked removed — tickable,
  // not dashed — in its own place in the library (the join keeps the library's order: before, the
  // listing took the library's place, SNOW_B first), and kept so
  page = await fakePage({ storage: { favoritesLibrary: storedLibrary([...FIVE, ...many], { removed: [{ seriesId: SNOW_B, at: Date.now() / 1000 - 600 }] }) } });
  try {
    assert.equal(cardOf(page, SNOW_B)?.getAttribute("data-status"), "removed");
    const tab = favoritesTab({ pages: pagesOf([[SNOW_B, "Snowfall in Two Cities"], [SNOW_A, "Snowfall in Two Cities"], [LIGHTHOUSE, "The Lighthouse Keeper's Promise"]]) });
    tab.remember(1_794_351_500);
    const job = favoritesJob("load", card);
    assert.equal(await page.module.runLoad(job, favoritesEngine(page, job).engine, {}), null);
    const rows = favoriteRows(page);
    assert.deepEqual(rows.map(([id]) => id), [SNOW_A, SNOW_B]);
    assert.notEqual(cardOf(page, SNOW_B)?.getAttribute("data-status"), "removed");
    assert.ok(tickOf(page, SNOW_B) !== undefined);
    assert.deepEqual(/** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"))["removed"], []);
    assert.deepEqual(keptItems(page).map((item) => item.seriesId), ids); // nothing shrunk, nothing moved
  } finally {
    page.restore();
  }
  // the library holds both dramas the listing found: it stays — larger —, filtered to the title
  page = await fakePage({ storage: { favoritesLibrary: storedLibrary([...FIVE, ...many]) } });
  try {
    const tab = favoritesTab({ pages: pagesOf([[SNOW_A, "Snowfall in Two Cities"], [SNOW_B, "Snowfall in Two Cities"], [LIGHTHOUSE, "The Lighthouse Keeper's Promise"]]) });
    tab.remember(1_794_351_500);
    const job = favoritesJob("load", card);
    assert.equal(await page.module.runLoad(job, favoritesEngine(page, job).engine, {}), null);
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [SNOW_A, SNOW_B]);
    assert.equal(/** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"))["items"]).length, 45); // never shrunk
  } finally {
    page.restore();
  }
});

test("the page: a right-click in a TikTok tab of another profile than the library's, on a card whose title several of that profile's favorites bear: the library stays exactly as it was — that account's list never enters it — and the page says to open the drama on TikTok and use Download this series; again, from that tab's kept listing, with no request", async () => {
  const NEW_SNOW = "7712345678901234567";
  const [shape] = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
  /** @param {string} seriesId @param {string} title */
  const entryOf = (seriesId, title) => ({ ...shape, dramaID: seriesId, dramaName: title, numVideos: 60, totalDuration: "5820" });
  /** @type {[string, string, number][]} */
  const many = Array.from({ length: 40 }, (_, n) => [String(7712345678901300000n + BigInt(n)), `Drama ${String(n).padStart(3, "0")}`, 10]);
  const stored = storedLibrary([...FIVE, ...many]); // read from @invented_viewer
  const page = await fakePage({ storage: { favoritesLibrary: stored } });
  try {
    const dramas = [entryOf(NEW_SNOW, "Snowfall in Two Cities"), entryOf(SNOW_A, "Snowfall in Two Cities"), entryOf(LIGHTHOUSE, "The Lighthouse Keeper's Promise")];
    const tab = favoritesTab({
      tabUrl: "https://www.tiktok.com/@someone_else",
      pages: { "0": { ...FAVORITES_CAPTURE, total: "46", cursor: "1794351568", hasMore: true, dramaList: dramas } },
    });
    tab.remember(1_794_351_500);
    const card = { title: "Snowfall in Two Cities", index: 0 };
    const elsewhere = String(page.catalog["favoritesSharedElsewhere"]?.message).replace("$title$", card.title);
    assert.match(elsewhere, /Download this series/);
    // first the list read until it reaches the card (one page); then that tab's kept listing tells, no request
    for (const requests of [1, 0]) {
      tab.fetched.length = 0;
      const job = favoritesJob("load", card);
      const run = favoritesEngine(page, job);
      /** @type {Record<string, unknown>} */
      const entry = {};
      assert.equal(await page.module.runLoad(job, run.engine, entry), null);
      assert.equal(tab.fetched.length, requests);
      assert.deepEqual(run.listed, []); // nothing guessed, nothing listed
      assert.deepEqual(job.refs, []);
      assert.equal(page.element("input-status").textContent, elsewhere);
      assert.equal(page.element("input-status").className, "status error");
      assert.equal(entry["error"], elsewhere); // the history keeps it
      // the library exactly as it was: its dramas, unsearched, its count, never written
      assert.equal(page.element("favorites-filter").value, "");
      assert.deepEqual(favoriteRows(page).map(([id]) => id), [...FIVE, ...many].map(([seriesId]) => seriesId));
      assert.equal(page.element("library-total").textContent, "TikTok counts 45 dramas");
      assert.equal(page.local.get("favoritesLibrary"), stored); // the very object it was seeded with: not one write
      assert.equal(page.element("links").value, "");
    }
  } finally {
    page.restore();
  }
});

test("the page: Update from TikTok reads only the library's own profile — with only a tab of another account showing its favorites the button stays disabled, its hint naming the library's profile, and a click queues nothing; a tab of the library's profile enables it; a library that does not know its profile takes any profile's tab, its hint the general one", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } }); // read from @invented_viewer
  try {
    const { element, local } = page;
    const tab = favoritesTab({ tabUrl: "https://www.tiktok.com/@someone_else" });
    tab.remember(1_794_351_500); // the worker kept that tab's favorites address
    /** @param {number} id @param {string} url a TikTok tab as `chrome.tabs.query` lists it */
    const tabOf = (id, url) => ({ id, index: 0, windowId: 1, active: false, url });
    const open = [tabOf(FAVORITES_TAB, "https://www.tiktok.com/@someone_else")];
    Object.assign(chrome.tabs, { query: async () => open });
    page.storageChanged(`favoritesTemplate:${FAVORITES_TAB}`, "session");
    await settled(page);
    assert.equal(element("library-refresh").disabled, true);
    assert.equal(element("library-refresh-hint").hidden, false);
    assert.equal(element("library-refresh-hint").textContent, "To update, open your TikTok profile (@invented_viewer) → Favorites → Drama in a tab of this Chrome.");
    assert.equal(element("library-dot").className, "dot");
    element("library-refresh").fire("click"); // nothing to read from: nothing queued, nothing asked
    await settled(page);
    assert.equal(element("app-status").dataset["state"], "idle");
    assert.equal(local.get("history"), undefined);
    assert.deepEqual(tab.fetched, []);
    // the library's own profile shows its favorites in another tab — whose address the worker kept
    // before the other account's —: enabled, the hint gone
    open.push(tabOf(43, "https://www.tiktok.com/@invented_viewer"));
    tab.session.set("favoritesTemplate:43", { url: FAVORITES_TEMPLATE, at: 1_794_351_400, profile: "@invented_viewer" });
    page.storageChanged("favoritesTemplate:43", "session");
    await settled(page);
    assert.equal(element("library-refresh").disabled, false);
    assert.equal(element("library-refresh-hint").hidden, true);
    assert.equal(element("library-dot").className, "dot connected");
  } finally {
    page.restore();
  }
  // a library that does not know the profile it was read from: the general hint, and any profile's tab enables it
  const unknown = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE, { profile: null }) } });
  try {
    const { element } = unknown;
    assert.equal(element("library-refresh").disabled, true);
    assert.equal(element("library-refresh-hint").textContent, unknown.catalog["libraryRefreshHint"]?.message);
    const tab = favoritesTab({ tabUrl: "https://www.tiktok.com/@someone_else" });
    tab.remember(1_794_351_500);
    Object.assign(chrome.tabs, { query: async () => [{ id: FAVORITES_TAB, index: 0, windowId: 1, active: false, url: "https://www.tiktok.com/@someone_else" }] });
    unknown.storageChanged(`favoritesTemplate:${FAVORITES_TAB}`, "session");
    await settled(unknown);
    assert.equal(element("library-refresh").disabled, false);
    assert.equal(element("library-refresh-hint").hidden, true);
  } finally {
    unknown.restore();
  }
});

test("the page: Update from TikTok — disabled with its hint while no TikTok tab shows the favorites list; then enabled, its click the smart refresh of that tab (one request when nothing changed) —; Open on TikTok opens the drama's first episode in a tab in front; Clear selection unticks every drama; See episodes queues Load list of that series", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) }, testSettings: { pageDelayS: 0.001 } });
  try {
    const { element, local } = page;
    // no TikTok tab with the list: disabled, the hint shown — and a click queues nothing
    assert.equal(element("library-refresh").disabled, true);
    assert.equal(element("library-refresh-hint").hidden, false);
    element("library-refresh").fire("click");
    await settled(page);
    assert.equal(element("app-status").dataset["state"], "idle");
    assert.equal(local.get("history"), undefined);
    // the profile's tab shows the list (its favorites address kept): enabled, the hint gone; one request
    const tab = favoritesTab({ pages: { "0": { ...FAVORITES_CAPTURE, total: "5" } } });
    tab.remember(1_794_351_500);
    Object.assign(chrome.tabs, { query: async () => [{ id: FAVORITES_TAB, index: 0, windowId: 1, active: false, url: "https://www.tiktok.com/@invented_viewer" }] });
    element("library-refresh").fire("click");
    for (let turn = 0; turn < 500 && (local.get("history") === undefined || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    assert.equal(element("library-refresh").disabled, false);
    assert.equal(element("library-refresh-hint").hidden, true);
    const [entry] = /** @type {Record<string, unknown>[]} */ (local.get("history"));
    assert.equal(entry?.["kind"], "favorites");
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]); // that tab's list, its first page: nothing changed
    assert.equal(element("input-status").textContent, "No changes: TikTok counts 5 dramas.");
    // Open on TikTok: the drama's first episode, a normal tab in front
    /** @type {chrome.tabs.CreateProperties[]} */
    const created = [];
    Object.assign(chrome.tabs, {
      create: async (/** @type {chrome.tabs.CreateProperties} */ properties) => {
        created.push(properties);
        return { id: 99, index: 2, windowId: 1, active: true };
      },
    });
    actionOf(page, PAPER, "open")?.fire("click");
    await page.turn();
    assert.deepEqual(created, [{ url: `https://www.tiktok.com/shortdrama/episode/${PAPER}/1`, active: true }]);
    // Clear selection: no drama ticked
    for (const seriesId of [PAPER, MOON]) {
      const box = tickOf(page, seriesId);
      assert.ok(box !== undefined);
      box.checked = true;
      box.fire("change");
    }
    assert.equal(element("favorites-selection").textContent, "2 selected · 42 episodes");
    element("library-clear").fire("click");
    assert.equal(element("favorites-selection").textContent, "0 selected · 0 episodes");
    assert.deepEqual(favoriteRows(page).filter(([, , , , ticked]) => ticked), []);
    // See episodes: Load list of that series, one job
    page.hold();
    actionOf(page, PAPER, "browse")?.fire("click");
    await page.turn();
    assert.equal(element("progress-current").textContent, `List series ${PAPER}`); // Load list's own job
  } finally {
    page.restore();
  }
});

test("the page: a listing keeps its covers' signed addresses in the browser session's memory only — never in chrome.storage.local —; a library write the storage refuses is said once and stops nothing: the listing ends, no refused write is remembered, the next listing runs", async () => {
  const page = await fakePage();
  try {
    const { element, module, local } = page;
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    let job = favoritesJob("favorites", null);
    assert.equal(await module.runFavorites(job, favoritesEngine(page, job).engine, {}), null);
    const covers = /** @type {Record<string, string>} */ (tab.session.get("favoritesCovers"));
    assert.deepEqual(Object.keys(covers).sort(), [LIGHTHOUSE, SNOW_A, SNOW_B, PAPER, MOON].sort());
    assert.ok(Object.values(covers).every((url) => url.startsWith("https://") && url.includes("x-signature=")));
    for (const [key, value] of local) assert.doesNotMatch(JSON.stringify(value), /x-signature|tiktokcdn|https?:/, key); // not one address on disk
  } finally {
    page.restore();
  }
  const refused = await fakePage();
  try {
    const { element, module } = refused;
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    const set = chrome.storage.local.set;
    Object.assign(chrome.storage.local, {
      set: async (/** @type {Record<string, unknown>} */ items) => {
        if ("favoritesLibrary" in items) throw new Error(REFUSED); // only the library's write
        return set(items);
      },
    });
    let job = favoritesJob("favorites", null);
    assert.equal(await module.runFavorites(job, favoritesEngine(refused, job).engine, {}), null); // no stop
    assert.equal(element("favorites-status").textContent, `The library could not be kept on this computer (${REFUSED}): it is read from TikTok again next time.`);
    assert.equal(await module.coversAllowed(), true); // nothing remembered as refused: the page goes on asking
    assert.equal(element("load-button").disabled, false);
    job = favoritesJob("favorites", null);
    assert.equal(await module.runFavorites(job, favoritesEngine(refused, job).engine, {}), null);
    assert.equal(tab.fetched.length, 4); // the next listing ran: its two pages too
    assert.equal(element("favorites-status").textContent, ""); // said once in this page
  } finally {
    refused.restore();
  }
});

// ------------------------------------------------- 1.6.0's review: what a listing becomes in the library

/** @param {string} seriesId @param {string} title @param {number} [episodes] @returns {Record<string, unknown>} a drama of TikTok's list */
const listed = (seriesId, title, episodes = 60) => {
  const [shape] = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
  return { ...shape, dramaID: seriesId, dramaName: title, numVideos: episodes, totalDuration: String(episodes * 97) };
};

/**
 * TikTok tab 42 shows `url` from now on (`chrome.tabs.get`, `chrome.tabs.query`): the user browsed on in it.
 * @param {string | (() => string)} url
 */
function tabShows(url) {
  const at = typeof url === "string" ? () => url : url;
  Object.assign(chrome.tabs, {
    get: async (/** @type {number} */ tabId) => ({ id: tabId, index: 0, windowId: 1, active: false, url: at() }),
    query: async () => [{ id: FAVORITES_TAB, index: 0, windowId: 1, active: false, url: at() }],
  });
}

test("the page: the library's profile is whose favorites the listing's address reads — the worker records it with the address —, never the page the tab shows by the listing's end: an update during which the tab moves on to another creator's video, or a drama's page, keeps @invented_viewer (on disk, on the connection line) and Update from TikTok stays enabled on that profile's tab; the popup's Open my library from a tab that moved on to another creator's page since its address was recorded labels a first library so too; an address recorded for another account is never the source", async () => {
  const NEW_ID = "7712345678901234568";
  const pages = {
    "0": { ...FAVORITES_CAPTURE, total: "6", cursor: "1794351568", hasMore: true, dramaList: [listed(NEW_ID, "A New Favorite"), ...FIVE.slice(0, 3).map(([seriesId, title, episodes]) => listed(seriesId, title, episodes))] },
    "1794351568": { ...FAVORITES_CAPTURE, total: "6", cursor: "1794350100", hasMore: false, dramaList: FIVE.slice(3).map(([seriesId, title, episodes]) => listed(seriesId, title, episodes)) },
  };
  for (const moved of ["https://www.tiktok.com/@some_creator/video/7412345678901234567", `https://www.tiktok.com/shortdrama/episode/${PAPER}/1`]) {
    const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
    try {
      const tab = favoritesTab({ pages });
      tab.remember(1_794_351_500); // recorded while the tab showed @invented_viewer → Favorites → Drama
      tabShows(() => (tab.fetched.length > 0 ? moved : "https://www.tiktok.com/@invented_viewer")); // the user clicked on after page 1
      const job = favoritesJob("favorites", null);
      assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, {}), null, moved);
      assert.equal(tab.fetched.length, 2, moved); // the whole list read: it became the library
      const kept = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
      assert.equal(/** @type {unknown[]} */ (kept["items"]).length, 6, moved);
      assert.equal(kept["profile"], PROFILE, moved); // whose list was read — never the page the tab shows now
      assert.equal(page.element("library-source").textContent, "Read from your TikTok tab (@invented_viewer)", moved);
      // back on the profile: that tab is Update from TikTok's source — its address reads @invented_viewer's list
      tabShows("https://www.tiktok.com/@invented_viewer");
      page.storageChanged(`favoritesTemplate:${FAVORITES_TAB}`, "session");
      await settled(page);
      assert.equal(page.element("library-refresh").disabled, false, moved);
      assert.equal(page.element("library-refresh-hint").hidden, true, moved);
    } finally {
      page.restore();
    }
  }
  // the popup's Open my library in a tab that moved on to another creator's profile after its
  // address was recorded: that address still reads @invented_viewer's list — the library says so
  const first = await fakePage();
  try {
    const tab = favoritesTab({ tabUrl: "https://www.tiktok.com/@a_creator", pages });
    tab.remember(1_794_351_500, PROFILE);
    const job = favoritesJob("favorites", null);
    assert.equal(await first.module.runFavorites(job, favoritesEngine(first, job).engine, {}), null);
    assert.equal(/** @type {Record<string, unknown>} */ (first.local.get("favoritesLibrary"))["profile"], PROFILE);
    assert.equal(first.element("library-source").textContent, "Read from your TikTok tab (@invented_viewer)");
  } finally {
    first.restore();
  }
  // a tab on the library's profile page whose address was recorded on another account's profile is no source
  const other = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    const tab = favoritesTab();
    tab.remember(1_794_351_500, "@someone_else");
    tabShows("https://www.tiktok.com/@invented_viewer");
    other.storageChanged(`favoritesTemplate:${FAVORITES_TAB}`, "session");
    await settled(other);
    assert.equal(other.element("library-refresh").disabled, true);
    assert.equal(other.element("library-refresh-hint").textContent, "To update, open your TikTok profile (@invented_viewer) → Favorites → Drama in a tab of this Chrome.");
  } finally {
    other.restore();
  }
});

test("the page: a right-click's listing kept for its tab never brings back into the library what the library learned since — after a removal whose count could not be read (Stop before its request, TikTok answering it HTTP 500), a right-click on the removed drama's twin in that tab reads the list again: the removed drama stays removed, TikTok's count stays the one after the removal, and the twin it finds now is listed", async () => {
  /** @type {[string, string, number][]} */
  const many = Array.from({ length: 40 }, (_, n) => [String(7712345678901300000n + BigInt(n)), `Drama ${String(n).padStart(3, "0")}`, 10]);
  // TikTok's list once SNOW_A was removed: 44, its first page without it
  const after = { ...FAVORITES_CAPTURE, total: "44", dramaList: /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]).filter((item) => item["dramaID"] !== SNOW_A) };
  for (const [why, countPage] of /** @type {[string, Record<string, unknown> | null][]} */ ([
    ["Stop before the count's request", null],
    ["the count's request answered HTTP 500", { __dramafetch_status: 500, __dramafetch_text: "" }],
  ])) {
    const page = await fakePage({
      storage: {
        favoritesLibrary: storedLibrary([...FIVE, ...many]),
        [`series:${SNOW_A}`]: savedState(SNOW_A, Array.from({ length: 60 }, (_, n) => n + 1), { complete: 60, completeAt: Date.now() / 1000 - 3600 }),
      },
    });
    try {
      const { element, local, module } = page;
      // a first right-click in tab 42 over the library kept from an earlier session: that tab's listing kept apart
      const tab = favoritesTab({ pages: { "0": { ...FAVORITES_CAPTURE, total: "45", cursor: "1794351568", hasMore: true } } });
      tab.remember(1_794_351_500);
      let job = favoritesJob("load", { title: "The Lighthouse Keeper's Promise", index: 0 });
      assert.equal(await module.runLoad(job, favoritesEngine(page, job).engine, {}), null, why);
      assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE], why);
      // SNOW_A removed; TikTok's count after it never read
      const { log } = bookmarkChrome({ firstPage: countPage ?? after });
      const removal = removalJob(page, SNOW_A, "Snowfall in Two Cities", 60);
      if (countPage === null) {
        const sleep = removal.engine.sleep;
        removal.engine.sleep = async (seconds) => {
          if (log.includes("close 77")) throw new StopRequested(); // in the pause before the count's request
          await sleep(seconds);
        };
        await assert.rejects(module.runUnbookmark(removal.job, removal.engine, {}), StopRequested);
      } else {
        assert.equal(await module.runUnbookmark(removal.job, removal.engine, {}), null, why);
      }
      assert.equal(cardOf(page, SNOW_A)?.getAttribute("data-status"), "removed", why);
      assert.equal(element("library-total").textContent, "TikTok counts 44 dramas (not confirmed: open your profile → Favorites → Drama and press Update from TikTok)", why);
      // TikTok's list read again from now on (after the removal): the twin right-clicked
      Object.assign(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis.chrome))["scripting"] ?? {}, {
        executeScript: async (/** @type {chrome.scripting.ScriptInjection<unknown[], unknown>} */ injection) => {
          if (injection.world !== "MAIN") return [{ frameId: 0, result: "Invented Viewer" }];
          log.push(`request ${String(/** @type {[string]} */ (injection.args)[0])}`);
          return [{ frameId: 0, result: JSON.parse(JSON.stringify(after)) }];
        },
      });
      const before = log.filter((line) => line.startsWith("request")).length;
      job = favoritesJob("load", { title: "Snowfall in Two Cities", index: 1 });
      const run = favoritesEngine(page, job);
      assert.equal(await module.runLoad(job, run.engine, {}), null, why);
      assert.ok(log.filter((line) => line.startsWith("request")).length > before, why); // read again: the kept listing predates the removal
      assert.deepEqual(run.listed, [SNOW_B], why); // the one drama of that title TikTok lists now
      // the removal and TikTok's count after it stand
      assert.equal(cardOf(page, SNOW_A)?.getAttribute("data-status"), "removed", why);
      assert.equal(element("library-total").textContent, "TikTok counts 44 dramas (not confirmed: open your profile → Favorites → Drama and press Update from TikTok)", why);
      const kept = /** @type {Record<string, unknown>} */ (local.get("favoritesLibrary"));
      assert.equal(kept["total"], 44, why);
      assert.equal(kept["unconfirmed"], true, why);
      assert.deepEqual(/** @type {{seriesId: string}[]} */ (kept["removed"]).map((removed) => removed.seriesId), [SNOW_A], why);
    } finally {
      page.restore();
    }
  }
});

test("the page: a right-click's listing kept for its tab, read after everything the library knows, still goes into it with no request — 1.5.0's cost — and dates from when it was read: a whole list kept 23 hours ago over a library kept from an earlier session becomes the library with its count and its episode counts 23 hours old, not read now", async () => {
  const realNow = Date.now;
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary([[LIGHTHOUSE, "The Lighthouse Keeper's Promise", 60], [SNOW_A, "Snowfall in Two Cities", 60]], { complete: false, fullReadAt: null, total: 5 }) } });
  try {
    const { local, module } = page;
    const tab = favoritesTab();
    tab.remember(Date.now() / 1000 - 60);
    // a card at the list's end: the whole list read, kept for tab 42 (the library is no tab's list)
    let job = favoritesJob("load", { title: "Moonlight Over the Harbor", index: 4 });
    assert.equal(await module.runLoad(job, favoritesEngine(page, job).engine, {}), null);
    assert.equal(tab.fetched.length, 2);
    const readAt = Date.now() / 1000;
    Date.now = () => realNow() + 23 * 3600 * 1000;
    // the twin of a drama the library lacks: that listing is newer than the library — into it, no request
    job = favoritesJob("load", { title: "Snowfall in Two Cities", index: 1 });
    assert.equal(await module.runLoad(job, favoritesEngine(page, job).engine, {}), null);
    assert.equal(tab.fetched.length, 2);
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [SNOW_A, SNOW_B]); // both of the title to pick from
    const kept = /** @type {Record<string, unknown>} */ (local.get("favoritesLibrary"));
    assert.deepEqual(/** @type {{seriesId: string}[]} */ (kept["items"]).map((item) => item.seriesId), FIVE.map(([seriesId]) => seriesId));
    // as read 23 hours ago — the removal's 24-hour gate trusts those counts for one hour more, not a day
    assert.ok(Math.abs(Number(kept["fullReadAt"]) - readAt) < 5, `fullReadAt ${kept["fullReadAt"]} is the listing's own time`);
    assert.ok(Math.abs(Number(kept["countedAt"]) - readAt) < 5, `countedAt ${kept["countedAt"]} is the listing's own time`);
    assert.ok(Math.abs(Number(kept["listedAt"]) - readAt) < 5, `listedAt ${kept["listedAt"]} is the listing's own time`);
  } finally {
    Date.now = realNow;
    page.restore();
  }
});

test("the page: a right-click's partial listing never takes the place of a library that holds TikTok's whole list — it is joined, the dramas it lacked on top, nothing dropped, the whole read's time kept (no Remove refused as stale) —; over a partial library a listing at least as long still takes its place, in the list's order", async () => {
  const NEW_SNOW = "7712345678901234567";
  const NEW_ID = "7712345678901234568";
  // TikTok's list now: two favorites added since on top (one of them a third "Snowfall in Two Cities"), seven in all
  const pages = {
    "0": {
      ...FAVORITES_CAPTURE,
      total: "7",
      cursor: "1794351568",
      hasMore: true,
      dramaList: [listed(NEW_SNOW, "Snowfall in Two Cities"), listed(NEW_ID, "A New Favorite"), ...FIVE.slice(0, 4).map(([seriesId, title, episodes]) => listed(seriesId, title, episodes))],
    },
    "1794351568": { ...FAVORITES_CAPTURE, total: "7", cursor: "1794350100", hasMore: false, dramaList: [listed(MOON, "Moonlight Over the Harbor", 12)] },
  };
  const stored = storedLibrary(FIVE); // TikTok's whole list, read two hours ago
  const page = await fakePage({ storage: { favoritesLibrary: stored, [`series:${PAPER}`]: savedState(PAPER, Array.from({ length: 30 }, (_, n) => n + 1), { complete: 30, completeAt: Date.now() / 1000 - 3 * 86400 }) } });
  try {
    const tab = favoritesTab({ pages });
    tab.remember(1_794_351_500);
    const job = favoritesJob("load", { title: "Snowfall in Two Cities", index: 0 });
    const run = favoritesEngine(page, job);
    assert.equal(await page.module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]); // the list read until it reached the card: one page
    assert.deepEqual(run.listed, []); // nothing guessed
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [NEW_SNOW, SNOW_A, SNOW_B]); // every drama of the title to pick from
    const kept = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
    // joined: what it lacked on top in the list's order, MOON — still a favorite — kept
    assert.deepEqual(/** @type {{seriesId: string}[]} */ (kept["items"]).map((item) => item.seriesId), [NEW_SNOW, NEW_ID, ...FIVE.map(([seriesId]) => seriesId)]);
    assert.equal(kept["complete"], true);
    assert.equal(kept["fullReadAt"], stored["fullReadAt"]); // the whole read's time: its episode counts still trusted
    assert.equal(kept["total"], 7);
    assert.equal(page.element("library-stale").hidden, true); // the library holds what TikTok counts
    // so Remove from Favorites on a drama on disk is not refused as stale
    const { log } = bookmarkChrome();
    const removal = removalJob(page, PAPER, "Paper Crowns", 30);
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await page.module.runUnbookmark(removal.job, removal.engine, entry), null);
    assert.notEqual(entry["error"], BOOKMARK_MESSAGES.stale);
    assert.ok(log.includes("click"));
  } finally {
    page.restore();
  }
  // a partial library (a first read that stopped early, kept from an earlier session): a reading as
  // long from the list's top takes its place, in the list's order — as before
  const partial = await fakePage({ storage: { favoritesLibrary: storedLibrary([[LIGHTHOUSE, "The Lighthouse Keeper's Promise", 60], [SNOW_A, "Snowfall in Two Cities", 60]], { complete: false, fullReadAt: null, total: 5 }) } });
  try {
    const tab = favoritesTab({
      pages: {
        "0": { ...FAVORITES_CAPTURE, total: "5", cursor: "1794351568", hasMore: true, dramaList: FIVE.slice(0, 4).map(([seriesId, title, episodes]) => listed(seriesId, title, episodes)) },
        "1794351568": { ...FAVORITES_CAPTURE, total: "5", cursor: "1794350100", hasMore: false, dramaList: [listed(MOON, "Moonlight Over the Harbor", 12)] },
      },
    });
    tab.remember(1_794_351_500);
    const job = favoritesJob("load", { title: "Snowfall in Two Cities", index: 1 });
    assert.equal(await partial.module.runLoad(job, favoritesEngine(partial, job).engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    const kept = /** @type {Record<string, unknown>} */ (partial.local.get("favoritesLibrary"));
    assert.deepEqual(/** @type {{seriesId: string}[]} */ (kept["items"]).map((item) => item.seriesId), FIVE.slice(0, 4).map(([seriesId]) => seriesId));
    assert.equal(kept["complete"], false);
  } finally {
    partial.restore();
  }
});

test("the page: an update that received every drama TikTok counts is TikTok's whole list though it ended at a page served again, a cursor that does not move or two empty pages — it becomes the library (a drama removed on TikTok itself leaves it), its whole read dated now, and the status line's \"listed\" is true —; one that received fewer, or an empty answer with TikTok counting none, leaves the library as it was", async () => {
  const NEW_ID = "7712345678901234568";
  const all = [listed(NEW_ID, "A New Favorite"), ...FIVE.map(([seriesId, title, episodes]) => listed(seriesId, title, episodes))];
  /** @param {unknown[]} dramas @param {Record<string, unknown>} more */
  const pageOf = (dramas, more) => ({ ...FAVORITES_CAPTURE, ...more, dramaList: dramas });
  const withoutMoon = all.slice(0, 5); // TikTok's list once MOON was removed on TikTok itself: NEW_ID and four
  /** @type {[string, Record<string, unknown>, string[]][]} */
  const whole = [
    [
      "the last page served again",
      { "0": pageOf(all.slice(0, 4), { total: "6", cursor: "11", hasMore: true }), "11": pageOf(all.slice(4), { total: "6", cursor: "12", hasMore: true }), "12": pageOf(all.slice(4), { total: "6", cursor: "13", hasMore: true }) },
      [NEW_ID, ...FIVE.map(([seriesId]) => seriesId)],
    ],
    ["a cursor that does not move — MOON removed on TikTok", { "0": pageOf(withoutMoon, { total: "5", cursor: "0", hasMore: true }) }, [NEW_ID, ...FIVE.slice(0, 4).map(([seriesId]) => seriesId)]],
    [
      "two empty pages — MOON removed on TikTok",
      { "0": pageOf(withoutMoon, { total: "5", cursor: "11", hasMore: true }), "11": pageOf([], { total: "5", cursor: "12", hasMore: true }), "12": pageOf([], { total: "5", cursor: "13", hasMore: true }) },
      [NEW_ID, ...FIVE.slice(0, 4).map(([seriesId]) => seriesId)],
    ],
  ];
  for (const [why, pages, ids] of whole) {
    const stored = storedLibrary(FIVE, { fullReadAt: Date.now() / 1000 - 30 * 3600 }); // its whole read a day and more ago
    const page = await fakePage({ storage: { favoritesLibrary: stored } });
    try {
      const tab = favoritesTab({ pages });
      tab.remember(1_794_351_500);
      const job = favoritesJob("favorites", null);
      assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, {}), null, why);
      const kept = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
      assert.deepEqual(/** @type {{seriesId: string}[]} */ (kept["items"]).map((item) => item.seriesId), ids, why);
      assert.equal(kept["complete"], true, why);
      assert.ok(Math.abs(Number(kept["fullReadAt"]) - Date.now() / 1000) < 60, `${why}: TikTok's whole list, read now`);
      assert.deepEqual(favoriteRows(page).map(([id]) => id), ids, why);
      assert.equal(page.element("input-status").textContent, String(page.catalog["favoritesLoaded"]?.message).replace("$count$", String(ids.length)), why);
      assert.equal(page.element("library-stale").hidden, true, why);
    } finally {
      page.restore();
    }
  }
  /** @type {[string, Record<string, unknown>][]} */
  const short = [
    ["six of seven, then a page served again", { "0": pageOf(all.slice(0, 4), { total: "7", cursor: "11", hasMore: true }), "11": pageOf(all.slice(4), { total: "7", cursor: "12", hasMore: true }), "12": pageOf(all.slice(4), { total: "7", cursor: "13", hasMore: true }) }],
    ["an empty answer whose cursor does not move, TikTok counting none", { "0": pageOf([], { total: "0", cursor: "0", hasMore: true }) }],
  ];
  for (const [why, pages] of short) {
    const stored = storedLibrary(FIVE);
    const page = await fakePage({ storage: { favoritesLibrary: stored } });
    try {
      const tab = favoritesTab({ pages });
      tab.remember(1_794_351_500);
      const job = favoritesJob("favorites", null);
      assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, {}), null, why);
      const kept = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
      assert.deepEqual(/** @type {{seriesId: string}[]} */ (kept["items"]).map((item) => item.seriesId), FIVE.map(([seriesId]) => seriesId), why);
      assert.equal(kept["fullReadAt"], stored["fullReadAt"], why);
      assert.deepEqual(favoriteRows(page).map(([id]) => id), FIVE.map(([seriesId]) => seriesId), why);
      // said so: never "listed" as if the library had become that read
      const kept6 = String(page.catalog["libraryKept"]?.message).replace("$count$", "6");
      assert.equal(page.element("input-status").textContent, why.startsWith("six") ? kept6 : String(page.catalog["libraryKeptEmpty"]?.message), why);
      assert.equal(page.element("input-status").className, "status error", why);
    } finally {
      page.restore();
    }
  }
});

test("the page: an update that stops before TikTok's end keeps the library's dramas and order but takes the episode counts it read from the library's own profile — Paper Crowns, saved whole at 30, listed with 40 now, says Partly · 30/40 and Remove from Favorites asks nothing (TikTok page 2 cut short, answered HTTP 429, or Stop); another account's listing renews nothing", async () => {
  const NEW_ID = "7712345678901234568";
  // TikTok's list now: a favorite added on top (so the smart refresh reads on), Paper Crowns grown to 40 episodes
  const first = { ...FAVORITES_CAPTURE, total: "6", cursor: "1794351568", hasMore: true, dramaList: [listed(NEW_ID, "A New Favorite"), listed(PAPER, "Paper Crowns", 40), listed(LIGHTHOUSE, "The Lighthouse Keeper's Promise", 60)] };
  const storage = () => ({ favoritesLibrary: storedLibrary(FIVE), [`series:${PAPER}`]: savedState(PAPER, Array.from({ length: 30 }, (_, n) => n + 1), { complete: 30, completeAt: Date.now() / 1000 - 3600 }) });
  for (const [why, page2] of /** @type {[string, Record<string, unknown> | null][]} */ ([
    ["TikTok sends no more after page 1", { dramaList: [], hasMore: false, statusCode: 0 }],
    ["page 2 answered HTTP 429", { __dramafetch_status: 429, __dramafetch_text: "" }],
    ["Stop after page 1", null],
  ])) {
    const page = await fakePage({ storage: storage() });
    try {
      assert.equal(statusTexts(page).find(([id]) => id === PAPER)?.[1], "On disk · 30/30", why);
      const tab = favoritesTab({ pages: page2 === null ? { "0": first } : { "0": first, "1794351568": page2 } });
      tab.remember(1_794_351_500);
      const job = favoritesJob("favorites", null);
      const { engine } = favoritesEngine(page, job);
      if (page2 === null) engine.stopRequested = () => tab.fetched.length > 0;
      try {
        if (page2 === null) await assert.rejects(page.module.runFavorites(job, engine, {}), StopRequested);
        else await page.module.runFavorites(job, engine, {});
      } finally {
        await clearCooldown(engine.cooldownStore);
      }
      await settled(page);
      // the library as it was — its dramas, its order, its whole read's time —, Paper Crowns' count TikTok's now
      assert.deepEqual(favoriteRows(page).map(([id]) => id), FIVE.map(([seriesId]) => seriesId), why);
      assert.equal(statusTexts(page).find(([id]) => id === PAPER)?.[1], "Partly · 30/40", why);
      assert.equal(actionOf(page, PAPER, "remove"), undefined, why);
      const kept = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
      assert.deepEqual(/** @type {{seriesId: string}[]} */ (kept["items"]).map((item) => item.seriesId), FIVE.map(([seriesId]) => seriesId), why);
      assert.equal(/** @type {{seriesId: string, episodes: number}[]} */ (kept["items"]).find((item) => item.seriesId === PAPER)?.episodes, 40, why);
      // a removal queued with the card's count asks nothing of TikTok
      const { log, site } = bookmarkChrome();
      const removal = removalJob(page, PAPER, "Paper Crowns", 40);
      /** @type {Record<string, unknown>} */
      const entry = {};
      assert.equal(await page.module.runUnbookmark(removal.job, removal.engine, entry), null, why);
      assert.equal(entry["error"], BOOKMARK_MESSAGES["not-on-disk"], why);
      assert.deepEqual(log, [], why);
      assert.equal(site.clicks, 0, why);
    } finally {
      page.restore();
    }
  }
  // another account's partial listing: nothing of it enters the library — its counts neither
  const other = await fakePage({ storage: storage() });
  try {
    const tab = favoritesTab({ tabUrl: "https://www.tiktok.com/@someone_else", pages: { "0": first, "1794351568": { dramaList: [], hasMore: false, statusCode: 0 } } });
    tab.remember(1_794_351_500);
    const job = favoritesJob("favorites", null);
    await other.module.runFavorites(job, favoritesEngine(other, job).engine, {});
    await settled(other);
    assert.equal(statusTexts(other).find(([id]) => id === PAPER)?.[1], "On disk · 30/30");
    assert.equal(/** @type {{seriesId: string, episodes: number}[]} */ (/** @type {Record<string, unknown>} */ (other.local.get("favoritesLibrary"))["items"]).find((item) => item.seriesId === PAPER)?.episodes, 30);
  } finally {
    other.restore();
  }
});

test("the page: an update that leaves the library as it was puts back everything of it — the list a right-click read of that tab (the same card again needs no request), how many cards the grid drew, what the records say of a drama another account's list counted otherwise —; with no library yet, an empty answer with no count is not kept", async () => {
  const NEW_ID = "7712345678901234568";
  /** @type {[string, string, number][]} */
  const many = Array.from({ length: 130 }, (_, n) => [String(7712345678901300000n + BigInt(n)), `Drama ${String(n).padStart(3, "0")}`, 10]);
  const first = { ...FAVORITES_CAPTURE, total: "136", cursor: "1794351568", hasMore: true, dramaList: [listed(NEW_ID, "A New Favorite"), ...FIVE.slice(0, 2).map(([seriesId, title, episodes]) => listed(seriesId, title, episodes))] };
  const cutShort = { dramaList: [], hasMore: false, statusCode: 0 };
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary([...FIVE, ...many]) } });
  try {
    const { element, module } = page;
    const tab = favoritesTab({ pages: { "0": first, "1794351568": cutShort } });
    tab.remember(1_794_351_500);
    // a right-click in tab 42 over the library kept from an earlier session: that tab's list kept apart
    const card = { title: "The Lighthouse Keeper's Promise", index: 1 };
    let job = favoritesJob("load", card);
    let run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.deepEqual(run.listed, [LIGHTHOUSE]);
    // 120 cards drawn
    element("library-more").fire("click");
    await settled(page);
    assert.equal(element("favorites-grid").children.length, 120);
    // an update from that tab TikTok cuts short: the library as it was
    job = favoritesJob("favorites", null);
    assert.equal(await module.runFavorites(job, favoritesEngine(page, job).engine, {}), null);
    assert.equal(tab.fetched.length, 3);
    await settled(page);
    assert.equal(element("favorites-grid").children.length, 120); // as many cards as it drew
    assert.equal(element("library-more").textContent, "Show 15 more");
    // that update's own first page, as the worker records it; the same card again: from the list
    // put back with the library, no request
    tab.remember(Date.now() / 1000 + 5);
    job = favoritesJob("load", card);
    run = favoritesEngine(page, job);
    assert.equal(await module.runLoad(job, run.engine, {}), null);
    assert.equal(tab.fetched.length, 3);
    assert.deepEqual(run.listed, [LIGHTHOUSE]);
  } finally {
    page.restore();
  }
  // no library yet: an empty first page with no count is no list to keep
  const empty = await fakePage();
  try {
    const tab = favoritesTab({ pages: { "0": cutShort } });
    tab.remember(1_794_351_500);
    const job = favoritesJob("favorites", null);
    assert.equal(await empty.module.runFavorites(job, favoritesEngine(empty, job).engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.equal(empty.local.get("favoritesLibrary"), undefined);
  } finally {
    empty.restore();
  }
});
