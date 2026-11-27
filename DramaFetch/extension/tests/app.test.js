// @ts-check
// Unit tests of src/app (the engine, the discovery, the downloader and, at the end, the page itself
// over a fake document) over fakes: no browser, no network, no real sleep. The integration scenarios
// (tests/integration/test_extension.py) drive the same code in a real Chromium against the fake
// TikTok server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { makeEpisode, uncertainText } from "../src/lib/catalog.js";
import { clearCooldown, recordBlock } from "../src/lib/cooldown.js";
import { CUT_SHORT_CAUSE_PREFIX, LOCKED_CAUSE_PREFIX, NOT_ATTEMPTED_CAUSE } from "../src/lib/diagnosis.js";
import { displayText } from "../src/lib/display.js";
import {
  DRM_MESSAGE,
  DRM_REMEMBERED_MESSAGE,
  LIST_RATE_LIMIT_MESSAGE,
  MEDIA_RATE_LIMIT_MESSAGE,
  NOT_LISTED_AGAIN_MESSAGE,
  NOT_LISTED_EARLY_END_MESSAGE,
  NOT_LISTED_MESSAGE,
  shortServedMessage,
} from "../src/lib/messages.js";
import { JOB_REST, LONG_REST, PACE, PacingState, REST, SERIES_REST, pacingOptions, pauseMessage } from "../src/lib/pacing.js";
import { completeSkip, isGuessedLocked, reportLine, seriesReport } from "../src/lib/report.js";
import { doneEntries, donePath, markComplete, missingFiles, newState, record } from "../src/lib/state.js";
import {
  ChallengeError,
  DISCOVERY_TAB_KEY,
  LoginRequiredError,
  NO_LIST_WARNING,
  RateLimitedError,
  chromeBrowser,
  closeLeftoverDiscoveryTab,
  discoverSeries,
  fetchInPage,
  isLoginUrl,
  looksLikeChallenge,
  pageTextInPage,
  queryParam,
  scrollInPage,
  withQueryParams,
} from "../src/app/discovery.js";
import {
  ATTEMPT_ENCRYPTED,
  ATTEMPT_NOT_REQUESTED,
  ATTEMPT_SAVED,
  DownloadsView,
  Downloader,
  ATTEMPT_SHORT_HEADER_PREFIX,
  contentLength,
  sanitizeError,
  saveFile,
  servedShort,
} from "../src/app/downloader.js";
import { STORAGE_REFUSED_PREFIX, StopRequested, StorageRefusedError, downloadSeries, runBatch, runSelectionJob } from "../src/app/engine.js";
import { DEFAULT_SETTINGS, cooldownStore as pageCooldownStore } from "../src/app/storage.js";
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
 * @param {{locked?: boolean, guessed?: boolean, urls?: string[], durationS?: number, seriesId?: string}} [options]
 *   `guessed` (3.0.1): a locked one DramaFetch's own rules only guessed was locked (no play address)
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
    access: options.locked || options.guessed ? "locked" : "free",
    guessedLock: options.guessed === true,
    lockHints: options.locked || options.guessed ? ["no play address"] : [],
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

/**
 * A series' state as a run left it: `done` episodes saved (`/dl/old/E<n>.mp4`, Chrome's download
 * id `100 + n`, the file still there), `drm` episodes an earlier download found encrypted.
 * @param {number[]} done
 * @param {number[]} [drm]
 */
function stateWith(done, drm = []) {
  const state = newState(SERIES_ID, "Test Series");
  const context = { exists: () => true, now: 1_800_000_000 };
  for (const number of done) {
    record(state, { episode: episode(number), status: "done", path: `/dl/old/E${number}.mp4`, message: `saved E${number}.mp4 (0.1 MiB)`, downloadId: 100 + number }, context);
  }
  for (const number of drm) {
    record(state, { episode: episode(number), status: "failed-unavailable", path: null, message: DRM_MESSAGE }, context);
  }
  return state;
}

test("the resume: an episode the records say is on disk is skipped (`already downloaded (manifest)`), one an earlier download found encrypted is skipped with no request unless includeLocked, a locked one stays skipped — only the rest is asked for, and a skip never pauses", async () => {
  const episodes = [episode(1), episode(2), episode(3, { locked: true }), episode(4), episode(5)];
  // E01 and E04 on disk, E02 remembered as DRM-protected, E03 locked, E05 never downloaded
  const resume = fakeEngine();
  const kept = await downloadSeries(resume.engine, series(episodes), episodes, stateWith([1, 4], [2]));
  assert.deepEqual(kept.results.map((r) => [r.episode.number, r.status, r.message]), [
    [1, "skipped-exists", "already downloaded (manifest): E1.mp4"],
    [2, "skipped-locked", DRM_REMEMBERED_MESSAGE],
    [3, "skipped-locked", "looks locked"], // the fake downloader's own skip
    [4, "skipped-exists", "already downloaded (manifest): E4.mp4"],
    [5, "done", "done 5"],
  ]);
  assert.deepEqual(resume.downloads, [5]);
  assert.deepEqual(resume.pauses, []); // the skips never pause: E05 is the run's first request
  // includeLocked (a paste with **Also ask for locked episodes**): the DRM memory no longer holds
  // E02 back, the records on disk still skip E01 and E04
  const asked = fakeEngine();
  asked.engine.includeLocked = true;
  await downloadSeries(asked.engine, series(episodes), episodes, stateWith([1, 4], [2]));
  assert.deepEqual(asked.downloads, [2, 5]);
});

test("a stop marks the rest of the run with no request — but an episode on disk keeps its skip (in the records, or in Chrome's history at its target), and so do the DRM memory and a locked episode; a skip never downgrades an entry on disk", async () => {
  const episodes = [episode(1), episode(2), episode(3), episode(4), episode(5), episode(6, { locked: true })];
  /**
   * A 429 on E02; E03 on disk in the records, E04 in Chrome's history at its target, E05 found
   * encrypted, E06 locked: the rows after the stop, and the records it leaves.
   */
  const rest = async () => {
    const fake = fakeEngine({ results: { 2: "failed-rate-limited" } });
    fake.engine.downloader.existingResult = (ep) =>
      ep.number === 4 ? { episode: ep, status: "skipped-exists", path: "/dl/old/E4.mp4", message: "already exists: E4.mp4", downloadId: 104 } : null;
    const state = stateWith([3], [5]);
    const { results, stopped } = await downloadSeries(fake.engine, series(episodes), episodes, state);
    assert.equal(stopped, "episode 2 failed-rate-limited");
    assert.deepEqual(fake.downloads, [1, 2]); // nothing after the stop
    const onDisk = new Map(doneEntries(state, () => true)); // the records' episodes on disk
    /** @param {number} number */
    const kept = (number) => {
      const entry = state.episodes[String(number)];
      return [number, entry?.status, entry?.path ?? null, entry?.download_id ?? null, onDisk.get(number) ?? null];
    };
    return { rows: results.slice(2).map((r) => [r.episode.number, r.status, r.message]), records: [3, 4].map(kept) };
  };
  const resume = await rest();
  assert.deepEqual(resume.rows, [
    [3, "skipped-exists", "already downloaded (manifest): E3.mp4"],
    [4, "skipped-exists", "already exists: E4.mp4"],
    [5, "skipped-locked", DRM_REMEMBERED_MESSAGE],
    [6, "skipped-locked", "looks locked: no play address"],
  ]);
  // a skip never downgrades an entry on disk: E03 keeps its download, E04's found file is noted
  assert.deepEqual(resume.records, [
    [3, "done", "/dl/old/E3.mp4", 103, "/dl/old/E3.mp4"],
    [4, "skipped-exists", "/dl/old/E4.mp4", 104, "/dl/old/E4.mp4"],
  ]);
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

/**
 * A downloader over fakes: every file it saves goes to `saved` (its path below the Downloads
 * folder); `askGuessed` as a Retry of free episodes DramaFetch guessed were locked sets it (3.0.1).
 * @param {{fetch: typeof fetch, saved?: string[], thumbnail?: string, view?: DownloadsView, askGuessed?: boolean}} options
 */
function downloader(options) {
  /** @type {string[]} */
  const saved = options.saved ?? [];
  let id = 0;
  return new Downloader({
    quality: "compatible",
    thumbnail: options.thumbnail ?? "embed",
    nameFormat: "{series} - Episode {number}",
    includeLocked: false,
    askGuessed: options.askGuessed, // 3.0.1
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

test("download: an episode Chrome's history shows saved at its target is `skipped-exists` with no request (existingResult, needsNetwork false); a new one is downloaded and saved under its name, its cover file too — its result carrying the video's path and download id, which the records keep —; a locked one is skipped with no request", async () => {
  const folder = `DramaFetch/Test Series [${SERIES_ID}]`;
  const target = `${folder}/Test Series - Episode 01.mp4`;
  const old = { id: 7, filename: `/home/me/Downloads/${target}`, state: "complete", exists: true };
  // Chrome's history: the episode's file, completed at exactly its target and still there
  const view = /** @type {DownloadsView} */ (/** @type {unknown} */ ({ completedAt: (/** @type {string} */ relative) => (relative === target ? old : null), remember() {} }));
  const routes = {
    "https://v16-webapp-prime.tiktok.com/": () => new Response(video(), { headers: { "content-type": "video/mp4", "content-length": String(128 * 1024) } }),
    "https://p16-sign-sg.tiktokcdn.com/": () => new Response(COVER, { headers: { "content-type": "image/jpeg" } }),
  };
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} */
  const saved = [];
  const subject = downloader({ fetch: fakeFetch(routes, log), saved, thumbnail: "both", view });
  // the file at its target is the episode: skipped, no request
  assert.equal(subject.existingResult(episode(1), CONTEXT)?.status, "skipped-exists");
  assert.equal(subject.needsNetwork(episode(1), CONTEXT), false);
  const skipped = await subject.download(episode(1), CONTEXT);
  assert.deepEqual([skipped.status, skipped.message, skipped.downloadId], ["skipped-exists", "already exists: Test Series - Episode 01.mp4", 7]);
  assert.deepEqual(log, []); // no request
  // a new one: its video and its cover file, each saved under its own name
  assert.equal(subject.existingResult(episode(2), CONTEXT), null);
  assert.equal(subject.needsNetwork(episode(2), CONTEXT), true);
  const result = await subject.download(episode(2), CONTEXT);
  assert.equal(result.status, "done");
  assert.equal(result.message, "saved Test Series - Episode 02.mp4 (0.1 MiB) + cover embedded + file");
  // the file Chrome saved, as the records keep it (the resume compares it with Chrome's history): the video's, never the cover file's
  assert.equal(result.path, `/home/me/Downloads/${folder}/Test Series - Episode 02.mp4`);
  assert.equal(result.downloadId, 1);
  assert.deepEqual(saved, [`${folder}/Test Series - Episode 02.mp4`, `${folder}/Test Series - Episode 02.jpg`]);
  assert.equal(log.length, 2); // the video and the one cover GET
  // a locked episode: skipped, no request
  assert.equal(subject.needsNetwork(episode(3, { locked: true }), CONTEXT), false);
  assert.equal((await subject.download(episode(3, { locked: true }), CONTEXT)).status, "skipped-locked");
  assert.equal(log.length, 2);
});

test("saveFile hands Chrome `uniquify` — never a file overwritten, the same name twice gets Chrome's ` (1)` — whatever it saves, and gives back what Chrome saved", async () => {
  /** @type {Record<string, unknown>[]} */
  const asked = [];
  const api = /** @type {typeof chrome.downloads} */ (
    /** @type {unknown} */ ({
      download: async (/** @type {Record<string, unknown>} */ options) => {
        asked.push(options);
        return asked.length;
      },
      search: async (/** @type {{id?: number}} */ query) => [{ id: query.id, filename: `/home/me/Downloads/E${query.id}.mp4`, state: "complete", exists: true }],
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    })
  );
  const bytes = new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]);
  const first = await saveFile(bytes, "video/mp4", "DramaFetch/S [1]/S - Episode 01.mp4", api);
  await saveFile(bytes, "video/mp4", "DramaFetch/S [1]/S - Episode 01.mp4", api);
  await saveFile(bytes, "image/jpeg", "DramaFetch/S [1]/S - Episode 01.jpg", api);
  assert.equal(first.filename, "/home/me/Downloads/E1.mp4");
  assert.deepEqual(
    asked.map((options) => [options["filename"], options["conflictAction"], options["saveAs"]]),
    [
      ["DramaFetch/S [1]/S - Episode 01.mp4", "uniquify", false],
      ["DramaFetch/S [1]/S - Episode 01.mp4", "uniquify", false],
      ["DramaFetch/S [1]/S - Episode 01.jpg", "uniquify", false],
    ],
  );
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

const EARLY_END = "in-page pagination fetch returned no episode list; scrolled the page instead";

test("3.0.1: a whole-series run gives every number TikTok's list still lacks a row of its own — failed-unavailable, `not in TikTok's list` (`…: it ended early` past the highest one listed when the list ended early) — after the downloads, passed to onResult: no request, no pause, nothing recorded, no complete mark; the report names them missing from the list, never failed", async () => {
  // TikTok counts 6; the list brought E01, E03, E04 and ended early: E02 a hole, E05-E06 never received
  const listed = { ...series([episode(1), episode(3), episode(4)]), totalHint: 6, itemsReceived: 3, missingNumbers: [2, 5, 6], earlyEnd: EARLY_END };
  const fake = fakeEngine({ discover: async () => listed });
  const ref = { kind: /** @type {const} */ ("series"), seriesId: SERIES_ID, episodeHint: null, sourceUrl: SERIES_ID };
  const [run] = await runBatch(fake.engine, [ref]);
  assert.ok(run !== undefined);
  assert.deepEqual(run.results.map((r) => [r.episode.number, r.status, r.message]), [
    [1, "done", "done 1"],
    [3, "done", "done 3"],
    [4, "done", "done 4"],
    [2, "failed-unavailable", NOT_LISTED_MESSAGE],
    [5, "failed-unavailable", NOT_LISTED_EARLY_END_MESSAGE],
    [6, "failed-unavailable", NOT_LISTED_EARLY_END_MESSAGE],
  ]);
  assert.deepEqual(fake.downloads, [1, 3, 4]); // no request for a missing number
  assert.deepEqual(fake.pauses.map((p) => p.kind), ["pace", "pace"]); // nor a pause
  assert.deepEqual(fake.shown.slice(-3).map((r) => r.episode.number), [2, 5, 6]); // the page draws them
  const state = /** @type {Record<string, unknown>} */ (fake.states.get(SERIES_ID));
  assert.deepEqual(Object.keys(/** @type {object} */ (state["episodes"])).sort(), ["1", "3", "4"]); // nothing recorded for them
  assert.equal(state["complete_at"], null); // never marked complete
  assert.equal(run.report.complete, false);
  assert.deepEqual(run.report.gaps, [2, 5, 6]);
  assert.equal(run.report.failed, 0); // missing from the list, not a failed download
  assert.equal(run.report.endedEarly, true);
  assert.equal(reportLine(run.report), "incomplete: 3 of 6 — episode 2 missing from TikTok's list; TikTok's list ended early: episodes 5, 6 not received");
  assert.equal(run.stop, false);
  // a list that came whole: no such row, complete as before
  const whole = fakeEngine({ discover: async () => ({ ...series([episode(1), episode(2)]), totalHint: 2, itemsReceived: 2, missingNumbers: [], earlyEnd: null }) });
  const [done] = await runBatch(whole.engine, [ref]);
  assert.deepEqual(done?.results.map((r) => r.status), ["done", "done"]);
  assert.equal(done?.report.complete, true);
});

test("3.0.1: a selection whose fresh list lacks a wanted number gives that number a row of its own — failed-unavailable, `not in TikTok's list this time` — after the downloads, never a request; the Python selection path does the same (parity: report.notListedResults)", async () => {
  const fresh = series([episode(1), episode(2), episode(3)]);
  const fake = fakeEngine({ discover: async () => fresh });
  const ref = { kind: /** @type {const} */ ("series"), seriesId: SERIES_ID, episodeHint: null, sourceUrl: SERIES_ID };
  const run = await runSelectionJob(fake.engine, ref, [2, 5, 3, 5], { lastContactAt: null });
  assert.deepEqual(run.results.map((r) => [r.episode.number, r.status, r.message]), [
    [2, "done", "done 2"],
    [3, "done", "done 3"],
    [5, "failed-unavailable", NOT_LISTED_AGAIN_MESSAGE],
  ]);
  assert.deepEqual(fake.downloads, [2, 3]);
  assert.deepEqual(fake.shown.at(-1)?.message, NOT_LISTED_AGAIN_MESSAGE);
  assert.deepEqual(run.report.gaps, [4, 5]); // what the line names: up to the highest number wanted
  assert.equal(run.report.failed, 0);
  assert.equal(reportLine(run.report), "incomplete: 2 of 5 — 1 not downloaded; episodes 4, 5 missing from TikTok's list");
  // every wanted number missing: rows only, no request at all, no rest taken
  const none = fakeEngine({ discover: async () => fresh });
  const gone = await runSelectionJob(none.engine, ref, [7], { lastContactAt: null });
  assert.deepEqual(gone.results.map((r) => [r.episode.number, r.status, r.message]), [[7, "failed-unavailable", NOT_LISTED_AGAIN_MESSAGE]]);
  assert.deepEqual(none.downloads, []);
  assert.equal(gone.contacted, true); // it listed the series
});

/**
 * A fake `chrome` with the tabs and the session storage the discovery's tab handling uses, and
 * `chrome.scripting.executeScript`, which records each injection as it was given (`injections`) and
 * answers as the injected function would: a list page for `fetchInPage`, the page's text for
 * `pageTextInPage`, nothing for `scrollInPage`.
 * @param {{completeAfter?: number, tab?: {url?: string, pendingUrl?: string} | null}} [options]
 *   `completeAfter`: how many `tabs.get` calls see the tab still loading; `tab`: the addresses
 *   `tabs.get` reports (by default `about:blank`), or null for a tab that is gone — `tabs.get`
 *   then rejects, as Chrome does
 */
function fakeChrome(options = {}) {
  /** @type {Map<string, unknown>} */
  const session = new Map();
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {unknown[]} */
  const injections = [];
  let gets = 0;
  const chrome = {
    scripting: {
      /** @param {chrome.scripting.ScriptInjection<unknown[], unknown>} injection */
      executeScript: async (injection) => {
        injections.push(injection);
        const result = injection.func === fetchInPage ? { statusCode: 0, itemList: [] } : injection.func === pageTextInPage ? "the page's text" : undefined;
        return [{ frameId: 0, result }];
      },
    },
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
        if (options.tab === null) throw new Error(`No tab with id: ${id}.`);
        return { id, url: "about:blank", ...options.tab, status: gets > (options.completeAfter ?? 0) ? "complete" : "loading" };
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
  return { session, calls, injections, restore: () => Reflect.deleteProperty(globalThis, "chrome") };
}

test("the discovery tab: muted, sent on only once about:blank has loaded, recorded until it is closed; its address read as Chrome reports it — the committed one, else the one still loading, else nothing — and a closed tab's error passed on, never swallowed (the discovery stops on it)", async () => {
  const fake = fakeChrome({ completeAfter: 2 });
  try {
    /** @type {number[]} */
    const polls = [];
    const browser = chromeBrowser(7, { sleep: async (seconds) => void polls.push(seconds) });
    assert.equal(await browser.openTab(3), 42);
    assert.deepEqual(fake.calls.slice(0, 2), [["create", "about:blank", false], ["update", 42, { muted: true }]]);
    assert.deepEqual(fake.calls.filter((call) => call[0] === "get").length, 3); // loading, loading, complete
    assert.deepEqual(polls, [0.02, 0.02]);
    // the address the discovery reads every round, to spot TikTok's login page and a closed tab
    assert.equal(await browser.tabUrl(42), "about:blank");
    assert.deepEqual(fake.calls.at(-1), ["get", 42]);
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
  const login = "https://www.tiktok.com/login?redirect_url=%2Fshortdrama";
  const series = `https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/1`;
  /** @type {[{url?: string, pendingUrl?: string}, string][]} what Chrome reports of the tab → what the discovery reads */
  const reports = [
    [{ url: "", pendingUrl: login }, login], // still loading: the address it is going to
    [{ url: series, pendingUrl: login }, series], // the committed address first
    [{ url: "" }, ""],
  ];
  for (const [tab, expected] of reports) {
    const reported = fakeChrome({ tab });
    try {
      assert.equal(await chromeBrowser(7).tabUrl(42), expected, JSON.stringify(tab));
      assert.deepEqual(reported.calls, [["get", 42]]);
    } finally {
      reported.restore();
    }
  }
  const closed = fakeChrome({ tab: null }); // the user closed it: Chrome knows no such tab
  try {
    await assert.rejects(chromeBrowser(7).tabUrl(42), /No tab with id: 42\./);
  } finally {
    closed.restore();
  }
});

test("what the discovery injects into the tab it opened — and nothing else: the list's pages read by the page's own `fetch` in the MAIN world (its address and timeout as given), the scroll and the page's text in the ISOLATED world (Chrome's default: no world given), each the discovery's own function, in that tab only", async () => {
  const fake = fakeChrome();
  try {
    const browser = chromeBrowser(7);
    const url = `https://www.tiktok.com/api/drama/episode/item_list/?dramaID=${SERIES_ID}&count=30&cursor=0`;
    assert.deepEqual(await browser.fetchInTab(42, url, 45_000), { statusCode: 0, itemList: [] });
    await browser.scrollTab(42);
    assert.equal(await browser.pageText(42), "the page's text");
    assert.deepEqual(fake.injections, [
      { target: { tabId: 42 }, world: "MAIN", func: fetchInPage, args: [url, 45_000] },
      { target: { tabId: 42 }, func: scrollInPage },
      { target: { tabId: 42 }, func: pageTextInPage },
    ]);
    assert.deepEqual(fake.calls, []); // no tab opened, moved or closed for it
  } finally {
    fake.restore();
  }
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
/** @type {FakeElement | null} the element the page focused last (`document.activeElement`) */
let focusedElement = null;

class FakeElement {
  /** @param {string} tag */
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = "";
    this.title = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    /** its `value` (a text field's, a select's) */
    this.current = "";
    /** a text field's selection: the caret at the end of its value whenever that changes, as in Chrome */
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.lang = "";
    this.text = "";
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
    /** @type {FakeElement | null} the element it was appended to last (`remove` takes it out of there) */
    this.parentNode = null;
  }
  get textContent() {
    return this.text;
  }
  /** @param {string | null} value */
  set textContent(value) {
    this.text = value ?? "";
    this.children = [];
  }
  get value() {
    return this.current;
  }
  /**
   * As Chrome sets a text field's value: its line breaks read as `\n`, the caret moved to the end
   * only when the value changes.
   * @param {string} value
   */
  set value(value) {
    const text = String(value).replace(/\r\n?/g, "\n");
    if (text !== this.current) this.selectionStart = this.selectionEnd = text.length;
    this.current = text;
  }
  /** The element focused, as `document.activeElement` names it (the page's editing commands act there). */
  focus() {
    focusedElement = this;
  }
  /** No element focused any more, when this one was; its selection is kept, as Chrome keeps a text field's. */
  blur() {
    if (focusedElement === this) focusedElement = null;
  }
  /**
   * A text field's `setSelectionRange`, as Chrome does it: `start` after `end` taken as `end`, both
   * held to the value's length.
   * @param {number} start
   * @param {number} end
   */
  setSelectionRange(start, end) {
    const length = this.current.length;
    this.selectionEnd = Math.min(end, length);
    this.selectionStart = Math.min(start, this.selectionEnd);
  }
  /**
   * A text field's `setRangeText`, as the HTML standard and Chrome do it: `start` after `end` an
   * IndexSizeError, then `start`..`end` (held to the value's length) replaced by `replacement`, its
   * line breaks read as `\n`, then the selection — `start`: collapsed before the replacement, `end`:
   * after it, `select`: around it, `preserve`: kept where it was relative to the text around it.
   * @param {string} replacement
   * @param {number} start
   * @param {number} end
   * @param {"select" | "start" | "end" | "preserve"} [mode]
   */
  setRangeText(replacement, start, end, mode = "preserve") {
    if (start > end) throw new RangeError("IndexSizeError: start is after end");
    replacement = replacement.replace(/\r\n?/g, "\n");
    const length = this.current.length;
    const [from, to] = [Math.min(start, length), Math.min(end, length)];
    const [oldStart, oldEnd] = [this.selectionStart, this.selectionEnd];
    this.current = this.current.slice(0, from) + replacement + this.current.slice(to);
    const newEnd = from + replacement.length;
    if (mode === "start") this.selectionStart = this.selectionEnd = from;
    else if (mode === "end") this.selectionStart = this.selectionEnd = newEnd;
    else if (mode === "select") [this.selectionStart, this.selectionEnd] = [from, newEnd];
    else {
      const delta = replacement.length - (to - from);
      /** @param {number} at @param {number} inside where a point inside the replaced range goes */
      const moved = (at, inside) => (at > to ? at + delta : at > from ? inside : at);
      [this.selectionStart, this.selectionEnd] = [moved(oldStart, from), moved(oldEnd, newEnd)];
    }
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
    for (const node of nodes) {
      if (!(node instanceof FakeElement)) continue;
      this.children.push(node);
      node.parentNode = this;
    }
  }
  /** Out of the element it was appended to (as Chrome's `Element.remove`). */
  remove() {
    const parent = this.parentNode;
    if (parent !== null) parent.children = parent.children.filter((child) => child !== this);
    this.parentNode = null;
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
 * with `options.storage` — a cooldown, a series' records — else empty, the engine lock free): a FRESH
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
 * a job then runs without Chrome's 10 s between two file checks when they say so — and keeps the
 * journal of finished jobs (`module.journal()`, DramaFetch 2.0.0: the history's entries, in memory
 * only; outside test mode nothing records jobs). `chrome.storage.session` holds nothing: what the
 * page writes there is dropped. With
 * `options.language` `es`, Chrome's UI is Spanish: the Spanish messages, `getUILanguage()` `es-419`.
 * `tick()` runs the page's one-second tick once (its `setInterval`, never armed here).
 * With `options.refuseRemove`, `chrome.storage.local` refuses every removal (a full disk); `removed`
 * is every key the page asked it to remove, in order, refused or not.
 * @param {{storage?: Record<string, unknown>, lockTaken?: boolean, search?: string, testSettings?: Record<string, unknown>, language?: "en" | "es", refuseRemove?: boolean}} [options]
 */
async function fakePage(options = {}) {
  const language = options.language ?? "en";
  /** @type {Record<string, CatalogEntry>} */
  const catalog = JSON.parse(readFileSync(new URL(`../_locales/${language}/messages.json`, import.meta.url), "utf8"));
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
  /** @type {string[]} every key the page asked `chrome.storage.local` to remove */
  const removed = [];
  const address = { search: options.search ?? "", pathname: "/src/app/app.html" };
  /** @type {(() => void)[]} the page's `setInterval` callbacks (its one-second tick) */
  const intervals = [];
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
      getUILanguage: () => (language === "es" ? "es-419" : "en-US"),
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
        /** @param {string | string[]} keys */
        remove: async (keys) => {
          const asked = Array.isArray(keys) ? keys : [keys];
          removed.push(...asked);
          if (options.refuseRemove) throw new Error(REFUSED);
          for (const key of asked) local.delete(key);
        },
      },
      session: {
        get: async (/** @type {unknown} */ keys) => {
          sessionKeys.push(keys);
          return {};
        },
        set: async () => undefined,
        remove: async () => undefined,
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
  focusedElement = null;
  /** Chrome's editing commands as the page used them (`document.execCommand`), and whether Chrome takes them. */
  /** @type {{command: string, value: string | null}[]} */
  const edits = [];
  const editor = { on: true, edits };
  const document = {
    documentElement: new FakeElement("html"),
    body: new FakeElement("body"),
    getElementById: element,
    /** @returns {FakeElement[]} */
    querySelectorAll: () => [],
    /** @param {string} tag */
    createElement: (tag) => new FakeElement(tag),
    get activeElement() {
      return focusedElement;
    },
    /**
     * Chrome's editing commands on the focused text field, the ones the page uses: `insertText`
     * puts the text in place of the selection, the caret after it; `delete` removes the selection
     * (with none, the character before the caret) — each an edit Ctrl+Z takes back, which the
     * test reads from `editor.edits`. While `editor.on` is false, Chrome is taken to refuse them:
     * false, no change.
     * @param {string} command
     * @param {boolean} [_showUi]
     * @param {string} [value]
     * @returns {boolean}
     */
    execCommand: (command, _showUi, value) => {
      const box = focusedElement;
      if (!editor.on || box === null || !["insertText", "delete"].includes(command)) return false;
      const { selectionStart: start, selectionEnd: end } = box;
      if (command === "insertText") box.setRangeText(String(value ?? ""), start, end, "end");
      else if (start < end) box.setRangeText("", start, end, "start");
      else if (start > 0) box.setRangeText("", start - 1, start, "start");
      editor.edits.push({ command, value: command === "insertText" ? String(value ?? "") : null });
      return true;
    },
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
    CSS: { escape: (/** @type {string} */ value) => value.replace(/["\\]/g, "\\$&") },
    // the page's one-second tick: never armed, so that the test process can exit — `tick()` runs it
    setInterval: (/** @type {() => void} */ callback) => {
      intervals.push(callback);
      return 0;
    },
  });
  const restore = () => {
    for (const name of ["document", "chrome", "location", "history", "MutationObserver", "CSS", "dramafetchJournal"]) Reflect.deleteProperty(globalThis, name);
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
    assert.ok(element("links").listeners.has("paste") && element("links").listeners.has("keydown"), "the box's paste and Enter are wired");
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
    editor,
    local,
    downloads,
    replaced,
    sessionKeys,
    removed,
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
    /** One second of the page's own tick, as its `setInterval` would run it: the cooldown banner's countdown, the pause line's. */
    tick: () => {
      for (const callback of intervals) callback();
    },
    /**
     * A runtime message from `sender` — by default this extension's own popup; a string is the
     * popup of the extension of that id; an object is the whole sender (the worker, a TikTok page
     * carrying the extension's id) —; what the page answers (the worker's openApp brings the
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

/**
 * What the user types or pastes into a text field when the page lets it happen: `text` in place of
 * its selection (at the caret), the caret after it — as Chrome does.
 * @param {FakeElement} box
 * @param {string} text
 */
function insertAtSelection(box, text) {
  box.setRangeText(text, box.selectionStart, box.selectionEnd, "end"); // its line breaks read as `\n`, as Chrome stores them
}

/**
 * A paste into the box, as Chrome hands it to the page: `text` as the clipboard's `text/plain`.
 * When the page lets the paste happen (no `preventDefault`), it lands in the box, as in Chrome:
 * in place of the box's selection (at the caret, by default the end of what it holds). Returns
 * whether the page kept it out of the box.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {string} text
 * @returns {boolean}
 */
function paste(page, text) {
  const box = page.element("links");
  let prevented = false;
  const event = {
    clipboardData: { getData: (/** @type {string} */ type) => (type === "text/plain" ? text : "") },
    preventDefault: () => void (prevented = true),
  };
  for (const listener of box.listeners.get("paste") ?? []) listener(event);
  if (!prevented) insertAtSelection(box, text); // the browser's own paste
  return prevented;
}

/**
 * A key pressed in the box (`Enter` by default; Shift held, or an input method composing, when
 * asked). When the page lets Enter happen, it makes a new line at the caret, as in Chrome.
 * Returns whether the page kept it from doing so.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {{key?: string, shiftKey?: boolean, isComposing?: boolean}} [options]
 * @returns {boolean}
 */
function press(page, options = {}) {
  const box = page.element("links");
  let prevented = false;
  const event = { key: options.key ?? "Enter", shiftKey: options.shiftKey ?? false, isComposing: options.isComposing ?? false, preventDefault: () => void (prevented = true) };
  for (const listener of box.listeners.get("keydown") ?? []) listener(event);
  if (!prevented && event.key === "Enter") insertAtSelection(box, "\n");
  return prevented;
}

/**
 * Select line `line` (from 1) of the box, without its line break — as a user selects a line to
 * paste over it.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {number} line
 */
function selectLine(page, line) {
  const box = page.element("links");
  const lines = box.value.split("\n");
  const start = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
  box.selectionStart = start;
  box.selectionEnd = start + (lines[line - 1] ?? "").length;
}

/**
 * A queued job as the tests compare it: `[kind, label, series ids, includeLocked, recheck]`.
 * @param {import("../src/app/app.js").Job} job
 * @returns {[string, string, string[], boolean, boolean]}
 */
const jobSummary = (job) => [job.kind, job.label, job.refs.map((ref) => ref.seriesId), job.includeLocked, job.recheck];

/**
 * What a fake element reads: its own text, then its children's, in order — as the DOM's
 * `textContent` reads an element made of spans.
 * @param {FakeElement} node
 * @returns {string}
 */
const textOf = (node) => (node.textContent ?? "") + node.children.map(textOf).join("");

/**
 * The Waiting card's rows as they read (DramaFetch 2.0.0: one per drama still to run — the running
 * batch's not begun yet, then every waiting job's —, by its name and whole id).
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @returns {string[]}
 */
const waitingRows = (page) => page.element("queue-list").children.map(textOf);

/**
 * A drama as a Waiting card row names it: `<name> · <whole id>`, or — no name known without asking
 * TikTok — `<whole id> · name shown once its list is read`.
 * @param {string} seriesId
 * @param {string | null} [name]
 * @returns {string}
 */
const dramaRow = (seriesId, name = null) => (name === null ? `${seriesId} · name shown once its list is read` : `${name} · ${seriesId}`);

/**
 * A Waiting card row that says what it is before its drama: `Retry E03 — <drama>`.
 * @param {string} what
 * @param {string} seriesId
 * @param {string | null} [name]
 * @returns {string}
 */
const whatRow = (what, seriesId, name = null) => `${what} — ${dramaRow(seriesId, name)}`;

/**
 * A series' stored progress: `numbers` saved with the downloader's message (the cover embedded),
 * found complete with `complete` episodes (at `completeAt`, seconds since the epoch: a fixed time by
 * default); the drama named `name` (`A drama` by default).
 * @param {string} seriesId
 * @param {number[]} numbers
 * @param {{complete?: number, completeAt?: number, name?: string}} [options]
 */
function savedState(seriesId, numbers, options = {}) {
  const state = newState(seriesId, options.name ?? "A drama");
  for (const number of numbers) {
    const message = `saved E${number}.mp4 (0.1 MiB) + cover embedded`;
    record(state, { episode: { number, itemId: `i${number}` }, status: "done", path: `/dl/E${number}.mp4`, message, downloadId: number }, { exists: () => true, now: 1_800_000_000 });
  }
  if (options.complete !== undefined) markComplete(state, options.completeAt ?? 1_800_000_100, options.complete);
  return JSON.parse(JSON.stringify(state));
}

/** @param {Awaited<ReturnType<typeof fakePage>>} page @param {number} [rounds] */
async function settled(page, rounds = 12) {
  for (let turn = 0; turn < rounds; turn += 1) await page.turn();
}

test("the page: a series handed over (the popup's Download this series) is downloaded — the batch job a paste of it queues, no checkbox, the box left alone —, never twice; the engine's tab answers with its tab; a read-only tab stays silent", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const other = "7699393770256782399";
    const third = "7699393770256782388";
    const links = element("links");
    const status = element("input-status");
    const queued = () => waitingRows(page);
    page.hold(); // the job's `tabs.getCurrent` never answers: it runs, and makes no request
    // what the box holds stays as it is — a hand-over never touches the box — and so do its checkboxes
    const typed = `https://www.tiktok.com/shortdrama/episode/${other}/1\n${third}`;
    links.value = typed;
    element("include-locked").checked = true;
    element("recheck").checked = true;
    assert.deepEqual(page.message({ type: "dramafetch:load", input: SERIES_ID }), [{ ok: true, tabId: 1 }]);
    await page.turn();
    assert.equal(links.value, typed);
    assert.deepEqual(module.queuedJobs().map(jobSummary), [["batch", `Series ${SERIES_ID}`, [SERIES_ID], false, false]]);
    assert.equal(element("progress-current").textContent, `Series ${SERIES_ID}`); // it runs: one listing, its own
    assert.equal(status.textContent, `Series ${SERIES_ID} queued: it downloads whole, with the usual pauses.`);
    assert.equal(status.className, "status ok");
    assert.equal(element("include-locked").checked, true); // the box's, for its next paste
    assert.equal(element("recheck").checked, true);
    // the same series again (another episode's link): being downloaded — never queued twice
    assert.deepEqual(page.message({ type: "dramafetch:load", input: `https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/3` }), [{ ok: true, tabId: 1 }]);
    assert.equal(status.textContent, `Already being downloaded, or waiting to be — not queued twice: ${SERIES_ID}.`);
    assert.equal(status.className, "status error");
    assert.equal(module.queuedJobs().length, 1);
    // another series: its own batch, waiting behind; handed over again while it waits: not twice either
    page.message({ type: "dramafetch:load", input: other });
    assert.equal(status.textContent, `Series ${other} queued: it downloads whole, with the usual pauses.`);
    page.message({ type: "dramafetch:load", input: other });
    assert.equal(status.textContent, `Already being downloaded, or waiting to be — not queued twice: ${other}.`);
    assert.deepEqual(module.queuedJobs().map(jobSummary), [
      ["batch", `Series ${SERIES_ID}`, [SERIES_ID], false, false],
      ["batch", `Series ${other}`, [other], false, false],
    ]);
    assert.deepEqual(queued(), [dramaRow(SERIES_ID), dramaRow(other)]); // the running batch's drama too: its list not read yet
    // an address that names no series changes nothing in the box: the tab says why (about the
    // link, not about the box's first line) and still answers, so that it comes to the front
    assert.deepEqual(page.message({ type: "dramafetch:load", input: "https://www.tiktok.com/shortdrama/foryou" }), [{ ok: true, tabId: 1 }]);
    assert.equal(links.value, typed);
    assert.equal(status.className, "status error");
    assert.match(String(status.textContent), /^Not a TikTok short-drama or video URL: 'https:\/\/www\.tiktok\.com\/shortdrama\/foryou'/);
    assert.deepEqual(queued(), [dramaRow(SERIES_ID), dramaRow(other)]);
    // only this extension's own code is heard, and only this message
    const fourth = "7699393770256782344";
    assert.deepEqual(page.message({ type: "dramafetch:load", input: fourth }, "another-extension-id"), []);
    assert.deepEqual(page.message({ type: "dramafetch:open", input: fourth }), []);
    assert.deepEqual(page.message("dramafetch:load"), []);
    assert.equal(links.value, typed);
    assert.deepEqual(queued(), [dramaRow(SERIES_ID), dramaRow(other)]);
  } finally {
    page.restore();
  }
  const readonly = await fakePage({ lockTaken: true });
  try {
    assert.deepEqual(readonly.message({ type: "dramafetch:load", input: SERIES_ID }), []);
    assert.equal(readonly.element("links").value, "");
    assert.equal(readonly.element("queue-card").hidden, true);
    assert.deepEqual(readonly.module.queuedJobs(), []);
  } finally {
    readonly.restore();
  }
});

test("the page: a series handed over during a cooldown is queued as before and refused at the job's gate — no request, the cooldown's end on the status line and in the journal —; its download is a batch", async () => {
  const now = Date.now() / 1000;
  const cooldown = { until: now + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: now };
  const page = await fakePage({ storage: { cooldown }, testSettings: {} }); // the test copy: its journal of finished jobs
  try {
    const { element, module } = page;
    assert.deepEqual(page.message({ type: "dramafetch:load", input: SERIES_ID }), [{ ok: true, tabId: 1 }]);
    for (let turns = 0; turns < 50 && module.journal().length === 0; turns += 1) await page.turn();
    const [entry] = module.journal();
    assert.ok(entry !== undefined);
    assert.equal(page.local.has("history"), false); // in the page's memory only: nothing stored
    assert.deepEqual([entry["kind"], entry["label"]], ["batch", `Series ${SERIES_ID}`]);
    assert.match(String(entry["error"]), /^TikTok refused a request at /);
    assert.deepEqual(entry["series"], []); // refused before its first series: nothing asked of TikTok
    assert.match(String(element("input-status").textContent), /^TikTok refused a request at /);
    assert.equal(element("input-status").className, "status error");
  } finally {
    page.restore();
  }
});

test("the page: a paste into the box downloads what was pasted — ONE batch job, the checkboxes for that run then cleared, the paste kept out of the box and whatever the box held besides it kept there, never lost —; several lines are one batch; a line the parser refuses queues nothing and the paste stays in the box with the error, and the right link pasted over that line is taken, the rest left for Enter; Enter queues the whole box, Shift+Enter is a new line, and in a blank box Enter does nothing", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const other = "7699393770256782399";
    const third = "7699393770256782388";
    const links = element("links");
    const status = element("input-status");
    page.hold(); // the job's `tabs.getCurrent` never answers: it runs, and makes no request
    // one link: the whole series, the box's checkboxes for this run — then cleared, as Download all had them
    element("include-locked").checked = true;
    element("recheck").checked = true;
    links.value = "";
    assert.equal(paste(page, `https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/4`), true); // kept out of the box
    await page.turn();
    assert.equal(links.value, "");
    assert.deepEqual(module.queuedJobs().map(jobSummary), [["batch", `Series ${SERIES_ID}`, [SERIES_ID], true, true]]);
    assert.equal(element("progress-current").textContent, `Series ${SERIES_ID}`);
    assert.equal(element("include-locked").checked, false);
    assert.equal(element("recheck").checked, false);
    assert.equal(status.textContent, `Series ${SERIES_ID} queued: it downloads whole, with the usual pauses.`);
    assert.equal(status.className, "status ok");
    // three lines (a comment, a duplicate): ONE batch of the series not being downloaded already,
    // the one running named; only the PASTED text counts — what the box holds besides (an id typed
    // there) stays there, never lost, and the status line says so
    const kept = "What the box held before stays there: press Enter to download it.";
    assert.equal(page.catalog["linksKept"]?.message, kept);
    const typedFirst = "7699393770256782377";
    links.value = typedFirst;
    const three = `# this week\nhttps://www.tiktok.com/shortdrama/episode/${other}/2\n${third}\n${SERIES_ID}\n${third}`;
    assert.equal(paste(page, three), true);
    assert.equal(links.value, typedFirst);
    assert.deepEqual(module.queuedJobs().map(jobSummary), [
      ["batch", `Series ${SERIES_ID}`, [SERIES_ID], true, true],
      ["batch", "2 series", [other, third], false, false],
    ]);
    assert.equal(
      status.textContent,
      `2 series queued: they download one after the other, with the usual pauses. · Already being downloaded, or waiting to be — not queued twice: ${SERIES_ID}. · duplicate: ${third} · ${kept}`,
    );
    // pasted again while they wait: nothing queued twice — the paste is taken all the same, kept
    // out of the box, which keeps what it held
    element("recheck").checked = true;
    assert.equal(paste(page, `${other}\n${third}`), true);
    assert.equal(links.value, typedFirst);
    assert.equal(module.queuedJobs().length, 2);
    assert.equal(status.textContent, `Already being downloaded, or waiting to be — not queued twice: ${other}, ${third}. · ${kept}`);
    assert.equal(status.className, "status error");
    assert.equal(element("recheck").checked, true); // nothing queued: still there for the next paste
    element("recheck").checked = false;
    // a line the parser refuses (a single video, text that names no series): nothing queued, the
    // paste lands in the box — after what it holds — and the status line says why, naming the line
    links.value = "";
    const fourth = "7699393770256782344";
    const refusedPaste = `${fourth}\nhttps://www.tiktok.com/@someone/video/7699400000000000001`;
    assert.equal(paste(page, refusedPaste), false);
    assert.equal(links.value, refusedPaste);
    assert.equal(module.queuedJobs().length, 2);
    assert.equal(status.className, "status error");
    assert.match(String(status.textContent), /^line 2: 'https:\/\/www\.tiktok\.com\/@someone\/video\/7699400000000000001' is a single video, not a series/);
    // a refused line is named by the box's own number, the line the user sees it on: the pasted
    // text's second line lands on the box's third
    assert.equal(paste(page, "\nnot a link at all"), false);
    assert.equal(links.value, `${refusedPaste}\nnot a link at all`);
    assert.match(String(status.textContent), /^line 3: Not a TikTok short-drama or video URL: 'not a link at all'/);
    assert.equal(paste(page, "# only a comment"), false); // no series at all
    assert.equal(status.textContent, page.catalog["noLinks"]?.message);
    // corrected by hand, then Enter: the whole box, as a paste — and emptied
    links.value = `${fourth}\n  # the single video taken out`;
    assert.equal(press(page, { shiftKey: true }), false); // Shift+Enter: a new line, nothing queued
    assert.equal(links.value, `${fourth}\n  # the single video taken out\n`);
    assert.equal(press(page, { isComposing: true }), false); // an input method composing: its Enter
    assert.equal(module.queuedJobs().length, 2);
    assert.equal(press(page, { key: "a" }), false);
    assert.equal(module.queuedJobs().length, 2);
    links.value = `${fourth}\n  # the single video taken out`;
    assert.equal(press(page), true);
    assert.equal(links.value, "");
    assert.deepEqual(page.editor.edits.at(-1), { command: "delete", value: null }); // emptied by Chrome's own edit: Ctrl+Z brings it back
    assert.deepEqual([links.selectionStart, links.selectionEnd], [0, 0]);
    assert.deepEqual(module.queuedJobs().map(jobSummary).at(-1), ["batch", `Series ${fourth}`, [fourth], false, false]);
    assert.deepEqual(waitingRows(page), [SERIES_ID, other, third, fourth].map((id) => dramaRow(id))); // one row per drama: the running one (not begun), the batch of two, the fourth
    // Enter in an empty or blank box — right after a paste or an Enter that queued, say: nothing
    // at all, the line that says what was queued left as it is
    const queuedFourth = `Series ${fourth} queued: it downloads whole, with the usual pauses.`;
    assert.equal(status.textContent, queuedFourth);
    for (const blank of ["", " \n\t "]) {
      links.value = blank;
      assert.equal(press(page), true); // no new line either
      assert.equal(links.value, blank);
      assert.equal(status.textContent, queuedFourth);
      assert.equal(status.className, "status ok");
    }
    // a box of comments only names no series: the page says what to do
    links.value = "# only a comment";
    assert.equal(press(page), true);
    assert.equal(status.textContent, page.catalog["noLinks"]?.message);
    assert.equal(status.className, "status error");
    assert.equal(links.value, "# only a comment");
    assert.equal(module.queuedJobs().length, 3);
    // a refused paste lands; the right link pasted over its wrong line is taken: that series
    // queued, the line it was pasted over gone as with any paste, the other lines kept — never
    // lost —, the status line saying so; then Enter queues them, ONE batch, and empties the box
    const [fifth, sixth, seventh] = ["7699393770256782311", "7699393770256782322", "7699393770256782333"];
    links.value = "";
    const wrong = `https://www.tiktok.com/shortdrama/episode/${fifth}/1\nhttps://www.tiktok.com/@someone/video/7699400000000000002\n${sixth}`;
    assert.equal(paste(page, wrong), false);
    assert.equal(links.value, wrong);
    assert.match(String(status.textContent), /^line 2: 'https:\/\/www\.tiktok\.com\/@someone\/video\/7699400000000000002' is a single video, not a series/);
    selectLine(page, 2);
    assert.equal(paste(page, `https://www.tiktok.com/shortdrama/episode/${seventh}/3`), true);
    assert.equal(links.value, `https://www.tiktok.com/shortdrama/episode/${fifth}/1\n\n${sixth}`);
    assert.deepEqual(module.queuedJobs().map(jobSummary).at(-1), ["batch", `Series ${seventh}`, [seventh], false, false]);
    assert.equal(status.textContent, `Series ${seventh} queued: it downloads whole, with the usual pauses. · ${kept}`);
    assert.equal(status.className, "status ok");
    assert.equal(press(page), true);
    assert.equal(links.value, "");
    assert.deepEqual(module.queuedJobs().map(jobSummary).at(-1), ["batch", "2 series", [fifth, sixth], false, false]);
    assert.deepEqual(waitingRows(page), [SERIES_ID, other, third, fourth, seventh, fifth, sixth].map((id) => dramaRow(id)));
    // an id typed, a new line (Shift+Enter), then a paste at the caret: the pasted series queued,
    // the typed id kept for Enter
    const [typed, pastedId] = ["7699393770256782355", "7699393770256782300"];
    links.value = typed;
    assert.equal(press(page, { shiftKey: true }), false);
    assert.equal(paste(page, pastedId), true);
    assert.equal(links.value, `${typed}\n`);
    assert.deepEqual(module.queuedJobs().map(jobSummary).at(-1), ["batch", `Series ${pastedId}`, [pastedId], false, false]);
    assert.equal(status.textContent, `Series ${pastedId} queued: it downloads whole, with the usual pauses. · ${kept}`);
    assert.equal(press(page), true);
    assert.equal(links.value, "");
    assert.deepEqual(module.queuedJobs().map(jobSummary).at(-1), ["batch", `Series ${typed}`, [typed], false, false]);
    // what the box held besides the paste but blank goes, and comments alone stay — neither is said
    links.value = " \n ";
    const blankEdits = page.editor.edits.length;
    assert.equal(paste(page, `${typed}\n${pastedId}`), true); // both waiting already: taken, nothing queued
    assert.equal(links.value, "");
    assert.deepEqual(page.editor.edits.slice(blankEdits), [{ command: "delete", value: null }]); // one edit, one Ctrl+Z
    assert.equal(status.textContent, `Already being downloaded, or waiting to be — not queued twice: ${typed}, ${pastedId}.`);
    links.value = "# to watch\n";
    assert.equal(paste(page, typed), true);
    assert.equal(links.value, "# to watch\n");
    assert.equal(status.textContent, `Already being downloaded, or waiting to be — not queued twice: ${typed}.`);
    assert.equal(module.queuedJobs().length, 7);
    // what the box keeps is said only when Enter would download something of it: never for text
    // that names no series, nor next to a line the parser refuses (Enter would refuse the whole
    // box), nor for a series already waiting — the one the paste just queued included
    const [eighth, ninth, tenth] = ["7699393770256782366", "7699393770256782301", "7699393770256782302"];
    const video = "https://www.tiktok.com/@someone/video/7699400000000000005";
    links.value = "typed, not pasted";
    assert.equal(paste(page, eighth), true);
    assert.equal(links.value, "typed, not pasted");
    assert.equal(status.textContent, `Series ${eighth} queued: it downloads whole, with the usual pauses.`);
    links.value = `${ninth}\n${video}`; // a series Enter could take, next to a refused line
    assert.equal(paste(page, tenth), true);
    assert.equal(links.value, `${ninth}\n${video}`);
    assert.equal(status.textContent, `Series ${tenth} queued: it downloads whole, with the usual pauses.`);
    links.value = typed; // waiting already
    assert.equal(paste(page, ninth), true);
    assert.equal(status.textContent, `Series ${ninth} queued: it downloads whole, with the usual pauses.`);
    assert.equal(module.queuedJobs().length, 10);
    // a paste taken over a selection: that text goes, the caret stays where it was (not at the
    // end); the box keeps its other lines
    const [first, second] = ["7699393770256782391", "7699393770256782392"];
    links.value = `${first}\n${video}\n${second}`;
    selectLine(page, 2);
    assert.equal(paste(page, "7699393770256782393"), true);
    assert.equal(links.value, `${first}\n\n${second}`);
    assert.deepEqual([links.selectionStart, links.selectionEnd], [first.length + 1, first.length + 1]);
    assert.equal(status.textContent, `Series 7699393770256782393 queued: it downloads whole, with the usual pauses. · ${kept}`);
    assert.deepEqual(page.editor.edits.at(-1), { command: "delete", value: null }); // Chrome's own edit: Ctrl+Z takes it back
    // a paste taken over part of a line — a selection run past a line's end, say — leaves the box
    // as it was: it was a download, not an edit (half a line removed could leave an id that names
    // another series)
    const overshoot = `${video}\n2222222222222222222`;
    links.value = overshoot;
    links.selectionStart = 0;
    links.selectionEnd = video.length + 3;
    const edited = page.editor.edits.length;
    assert.equal(paste(page, "7699393770256782394"), true);
    assert.equal(links.value, overshoot);
    assert.equal(page.editor.edits.length, edited);
    assert.equal(status.textContent, "Series 7699393770256782394 queued: it downloads whole, with the usual pauses."); // no note: Enter would refuse the box
    // pasted over the id inside a link — meant to replace it —: the pasted series is queued, the
    // box left as it was, and no note invites Enter to download the series pasted over
    const pastedOver = "https://www.tiktok.com/shortdrama/episode/7699393770256782378/1";
    links.value = pastedOver;
    links.selectionStart = pastedOver.indexOf("7699393770256782378");
    links.selectionEnd = links.selectionStart + 19;
    assert.equal(paste(page, "7699393770256782379"), true);
    assert.equal(links.value, pastedOver);
    assert.equal(status.textContent, "Series 7699393770256782379 queued: it downloads whole, with the usual pauses.");
    // a byte-order mark a paste brought (copied from a file that starts with one) is no part of
    // the line it landed on, wherever that line is: Enter takes it
    links.value = "7699393770256782376\n\ufeff7699393770256782375";
    assert.equal(press(page), true);
    assert.equal(links.value, "");
    assert.deepEqual(module.queuedJobs().map(jobSummary).at(-1), ["batch", "2 series", ["7699393770256782376", "7699393770256782375"], false, false]);
    // and what the note after a paste says of such a box is what Enter would do: take it
    links.value = "7699393770256782371\n\ufeff7699393770256782372";
    assert.equal(paste(page, "7699393770256782373"), true);
    assert.equal(status.textContent, `Series 7699393770256782373 queued: it downloads whole, with the usual pauses. · ${kept}`);
    // the note is decided once the paste is queued: the box naming the series the paste queues
    // gets none (Enter would only say it is waiting already)
    links.value = "7699393770256782303";
    assert.equal(paste(page, "https://www.tiktok.com/shortdrama/episode/7699393770256782303/2"), true);
    assert.equal(status.textContent, "Series 7699393770256782303 queued: it downloads whole, with the usual pauses.");
    // a link refused lands on a line of its own — never glued onto the line the caret is on, nor
    // into it —, named by the box's own line number; Windows line breaks land as plain ones
    links.value = first; // the caret at the end of the line, no line break after it
    assert.equal(paste(page, video), true); // the page puts it in place itself
    assert.equal(links.value, `${first}\n${video}`);
    assert.deepEqual(page.editor.edits.at(-1), { command: "insertText", value: `\n${video}` }); // an edit Ctrl+Z takes back
    assert.match(String(status.textContent), /^line 2: 'https:\/\/www\.tiktok\.com\/@someone\/video\/7699400000000000005' is a single video, not a series/);
    assert.deepEqual([links.selectionStart, links.selectionEnd], [links.value.length, links.value.length]);
    links.value = `${first}\n${second}`;
    links.selectionStart = links.selectionEnd = 4; // inside the first line
    assert.equal(paste(page, `${video}\r\n${second}\r\n`), true); // after the caret's line
    assert.equal(links.value, `${first}\n${video}\n${second}\n\n${second}`);
    assert.match(String(status.textContent), /^line 2: 'https:\/\/www\.tiktok\.com\/@someone\/video\/7699400000000000005' is a single video/);
    // anything the parser reads as a line — a short link, other words — lands on a line of its
    // own too; only blank lines and comments land as any paste does, at the caret
    links.value = first;
    assert.equal(paste(page, "https://vm.tiktok.com/ZMabc123/"), true);
    assert.equal(links.value, `${first}\nhttps://vm.tiktok.com/ZMabc123/`);
    assert.match(String(status.textContent), /^line 2: Short links/);
    links.value = `${first}\n${second}`;
    links.selectionStart = links.selectionEnd = 2; // inside the first line
    assert.equal(paste(page, "not a link"), true);
    assert.equal(links.value, `${first}\nnot a link\n${second}`);
    assert.match(String(status.textContent), /^line 2: Not a TikTok short-drama or video URL: 'not a link'/);
    links.value = `${first}\n${second}`;
    assert.equal(paste(page, " # not a link"), false);
    assert.equal(links.value, `${first}\n${second} # not a link`);
    assert.equal(paste(page, "\nnot a link"), false); // a line break first: the browser's own paste lands it the same way
    assert.match(String(status.textContent), /^line 3: Not a TikTok short-drama or video URL: 'not a link'/);
    // where Chrome refuses its editing command, the page puts the text in place all the same
    page.editor.on = false;
    links.value = first;
    assert.equal(paste(page, video), true);
    assert.equal(links.value, `${first}\n${video}`);
    page.editor.on = true;
    assert.equal(module.queuedJobs().length, 16);
  } finally {
    page.restore();
  }
});

test("the page: no paste and no Enter queues anything while a cooldown is in force, after a refused write, or in a read-only tab — the paste lands in the box, the reason on the status line (a read-only tab: its banner) —; back once the cooldown ends", async () => {
  const now = Date.now() / 1000;
  const cooldown = { until: now + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: now };
  const page = await fakePage({ storage: { cooldown } });
  try {
    const { element, module } = page;
    const links = element("links");
    page.hold();
    element("recheck").checked = true;
    assert.equal(paste(page, SERIES_ID), false);
    assert.equal(links.value, SERIES_ID); // the paste lands in the box, for later
    assert.deepEqual(module.queuedJobs(), []);
    assert.match(String(element("input-status").textContent), /^TikTok refused a request at \d\d:\d\d \(rate limited \(HTTP 429\) by the video server/);
    assert.equal(element("input-status").className, "status error");
    assert.equal(press(page), true); // Enter: the same refusal, no new line
    assert.equal(links.value, SERIES_ID);
    assert.deepEqual(module.queuedJobs(), []);
    assert.equal(element("recheck").checked, true); // untouched: nothing was queued
    // the cooldown ends: Enter queues the box
    page.local.delete("cooldown");
    page.storageChanged("cooldown");
    await page.turn();
    assert.equal(press(page), true);
    assert.equal(links.value, "");
    assert.deepEqual(module.queuedJobs().map(jobSummary), [["batch", `Series ${SERIES_ID}`, [SERIES_ID], false, true]]);
    // two links pasted one after the other during a cooldown — copied from the address bar: no line
    // break around them — both land, each on a line of its own, never glued into one (where the
    // second would hide in the first's query and never be downloaded); once it is over, another
    // paste downloads what it brings and leaves those two in the box — never lost —, for Enter
    const [first, second, later] = ["7699393770256782311", "7699393770256782322", "7699393770256782333"];
    const [firstLink, secondLink] = [first, second].map((id) => `https://www.tiktok.com/shortdrama/episode/${id}/1?is_from_webapp=1&sender_device=pc`);
    page.local.set("cooldown", { ...cooldown, until: Date.now() / 1000 + 1800 });
    page.storageChanged("cooldown");
    await page.turn();
    assert.equal(paste(page, firstLink), false); // an empty box: it lands as any paste does
    assert.equal(paste(page, secondLink), true); // put on a line of its own by the page
    assert.equal(links.value, `${firstLink}\n${secondLink}`);
    // with text selected, a refused paste takes its place as any paste does: the right link over a
    // wrong line; an id over the id inside a kept link, which corrects that link
    const wrongLine = "https://www.tiktok.com/@someone/video/7699400000000000009";
    const kept = links.value;
    links.value = `${kept}\n${wrongLine}`;
    selectLine(page, 3);
    const laterLink = `https://www.tiktok.com/shortdrama/episode/${later}/1`;
    assert.equal(paste(page, laterLink), false);
    assert.equal(links.value, `${kept}\n${laterLink}`);
    links.selectionStart = links.value.indexOf(later);
    links.selectionEnd = links.selectionStart + later.length;
    assert.equal(paste(page, "7699393770256782344"), false);
    assert.equal(links.value, `${kept}\nhttps://www.tiktok.com/shortdrama/episode/7699393770256782344/1`);
    links.value = kept;
    page.local.delete("cooldown");
    page.storageChanged("cooldown");
    await page.turn();
    assert.equal(paste(page, later), true);
    assert.equal(links.value, `${firstLink}\n${secondLink}`);
    assert.deepEqual(module.queuedJobs().map(jobSummary).at(-1), ["batch", `Series ${later}`, [later], false, false]);
    assert.equal(element("input-status").textContent, `Series ${later} queued: it downloads whole, with the usual pauses. · What the box held before stays there: press Enter to download it.`);
    assert.equal(press(page), true);
    assert.equal(links.value, "");
    assert.deepEqual(module.queuedJobs().map(jobSummary).at(-1), ["batch", "2 series", [first, second], false, false]);
  } finally {
    page.restore();
  }
  // a write chrome.storage.local refused: nothing queued, the storage advice
  const unsaved = await fakePage();
  try {
    const { element, module } = unsaved;
    const engine = module.buildEngine({ ...BATCH_JOB }, { pauses: [], inputs: [], taking: true });
    const set = chrome.storage.local.set;
    Object.assign(chrome.storage.local, {
      set: async () => {
        throw new Error(REFUSED);
      },
    });
    try {
      await engine.persist?.();
      assert.equal(paste(unsaved, SERIES_ID), false);
      for (let turns = 0; turns < 20 && element("input-status").className !== "status error"; turns += 1) await unsaved.turn();
      assert.match(String(element("input-status").textContent), /^DramaFetch stopped: the progress could not be saved: /);
      assert.equal(element("links").value, SERIES_ID);
      assert.deepEqual(module.queuedJobs(), []);
    } finally {
      Object.assign(chrome.storage.local, { set });
    }
  } finally {
    unsaved.restore();
  }
  // a read-only DramaFetch tab: nothing at all — the paste is the box's, Enter a new line, not even
  // the parser's word on what was pasted (its banner says why nothing happens there)
  const readonly = await fakePage({ lockTaken: true });
  try {
    const { element, module } = readonly;
    assert.equal(paste(readonly, SERIES_ID), false);
    assert.equal(press(readonly), false);
    assert.equal(element("links").value, `${SERIES_ID}\n`);
    assert.equal(paste(readonly, "not a link at all"), false);
    assert.equal(element("links").value, `${SERIES_ID}\nnot a link at all`);
    // not even a link's own line: the paste lands as any paste does, glued at the caret
    const link = `https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/2`;
    assert.equal(paste(readonly, link), false);
    assert.equal(element("links").value, `${SERIES_ID}\nnot a link at all${link}`);
    assert.deepEqual(readonly.editor.edits, []);
    assert.deepEqual(module.queuedJobs(), []);
    assert.equal(element("input-status").textContent, "");
    assert.equal(element("duplicate-banner").hidden, false);
  } finally {
    readonly.restore();
  }
});

// ------------------------------------------------------- the episodes that did not download

/** The fake TikTok's second series, as the page tests name it. */
const OTHER_ID = "7699393770256782399";
/** A row's message when a 429 stopped the run before it. */
const STOPPED_BY_429 = `stopped: episode 2 failed-rate-limited: ${MEDIA_RATE_LIMIT_MESSAGE}`;
/** The report line every fake record carries. */
const RECORD_LINE = "incomplete: 1 of 2 (1 downloaded) — 1 failed (2)";

/**
 * A finished job's per-series record as `runRecord` makes it, its rows from `[number, status,
 * message?]` (the message defaults to `<status> <number>`); `rows: null` leaves the rows out (a
 * malformed record).
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
      { series_id: "7699393770256782377", name: "Four", error: null, episodes: 3 }, // no rows at all: malformed, as stored data may be
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
      { kind: "selection", label: "Retry 4 of One", refs: [ref(SERIES_ID)], numbers: [2, 4, 6, 7], includeLocked: false, recheck: false },
      { kind: "selection", label: "Retry 1 of Two", refs: [ref(OTHER_ID)], numbers: [1], includeLocked: false, recheck: false },
    ]);
    // a series the job never learnt the name of goes by its id
    assert.equal(retryJobs(retryTargets([seriesRecord(OTHER_ID, null, [[3, "failed"]])]))[0]?.label, `Retry 1 of ${OTHER_ID}`);
    assert.deepEqual(retryTargets([]), []);
  } finally {
    page.restore();
  }
});

test("the page: the retry button obeys the cooldown like every download button — disabled while it is in force, back when it ends", async () => {
  const now = Date.now() / 1000;
  const cooldown = { until: now + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: now };
  const page = await fakePage({ storage: { cooldown } });
  try {
    const { element, module } = page;
    assert.equal(element("cooldown-banner").hidden, false);
    // the progress card's: a job that ended under the cooldown (a 429 stop records one)
    module.renderFailed([
      seriesRecord(SERIES_ID, "One", [
        [1, "failed-rate-limited", MEDIA_RATE_LIMIT_MESSAGE],
        [2, "failed-rate-limited", STOPPED_BY_429],
      ]),
    ]);
    assert.equal(element("failed-block").hidden, false);
    assert.equal(element("retry-button").disabled, true);
    element("retry-button").fire("click"); // a disabled button cannot be clicked in a browser; the handler refuses all the same
    await page.turn();
    assert.equal(element("app-status").dataset["state"], "idle");
    assert.deepEqual(waitingRows(page), []);
    // the cooldown ends (lifted in storage: the clock, another DramaFetch page): the buttons come back
    page.local.delete("cooldown");
    page.storageChanged("cooldown");
    await page.turn();
    assert.equal(element("cooldown-banner").hidden, true);
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
    // the button: one selection job per series
    page.hold();
    element("retry-button").fire("click");
    await page.turn();
    assert.equal(element("retry-button").disabled, true);
    assert.equal(element("progress-current").textContent, "Retry 2 of One");
    assert.deepEqual(waitingRows(page), [whatRow("Retry E01", OTHER_ID)]); // its records never named it: its id, whole
    // 3.0.1 (§11, the owner's report of 2026-11-27): the block stays as the first one starts — it
    // used to be hidden and emptied — and a job's end replaces only the rows of the episodes it took
    assert.equal(element("failed-block").hidden, false);
    assert.deepEqual(failed.children.map(keys), [
      [SERIES_ID, "2", "failed-unavailable"],
      [SERIES_ID, "4", "failed"],
      [OTHER_ID, "1", "failed-rate-limited"],
    ]);
    assert.equal(element("failed-heading").textContent, "Did not download (3)");
    // a job that took E01 and E02 of One and saved them: E02 leaves, E04 and Two's E01 stay
    module.renderFailed([seriesRecord(SERIES_ID, "One", [[1, "done"], [2, "skipped-exists"]])]);
    assert.equal(element("failed-block").hidden, false);
    assert.deepEqual(failed.children.map(keys), [
      [SERIES_ID, "4", "failed"],
      [OTHER_ID, "1", "failed-rate-limited"],
    ]);
    assert.equal(element("failed-heading").textContent, "Did not download (2)");
    // the jobs that took the last two saved them: the block hides, the button with it
    module.renderFailed([seriesRecord(SERIES_ID, "One", [[4, "done"]]), seriesRecord(OTHER_ID, "Two", [[1, "done"]])]);
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
  numbers: [],
  includeLocked: false,
  recheck: false,
});

/**
 * The stored settings of a page that retries nothing on its own (DramaFetch 1.8.0's automatic retry
 * off): the path the tests of a plain failure's ⚠ alert and the tab's own Retry prove, as in 1.7.0.
 */
const NO_AUTO_RETRY = { settings: { autoRetry: false } };

test("the page: the engine's hook releases each finished series of a batch and keeps the table light", async () => {
  const page = await fakePage({ storage: NO_AUTO_RETRY }); // its run's E02 failed: no automatic retry started under this test
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

test("the page: once chrome.storage.local refuses a write nothing more is asked of TikTok — no listing, no job — and the page says what to do", async () => {
  const page = await fakePage();
  try {
    const { element, module, local } = page;
    const engine = module.buildEngine({ ...BATCH_JOB }, { pauses: [], inputs: [], taking: true });
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
      // the popup's "Download this series": nothing queued, the page says why and what to do
      const finished = element("app-status").dataset["finished"];
      page.message({ type: "dramafetch:load", input: SERIES_ID });
      for (let turns = 0; turns < 20 && element("input-status").className !== "status error"; turns += 1) await page.turn();
      assert.equal(element("input-status").textContent, `DramaFetch stopped: ${UNSAVED}. Chrome could not write to its profile folder — usually its disk is full. Free some space, restart Chrome and run again: what is already saved is skipped.`);
      assert.deepEqual(waitingRows(page), []);
      assert.equal(element("app-status").dataset["finished"], finished);
      assert.equal(element("retry-button").disabled, true);
      // a paste: nothing queued either — it lands in the box, the same advice on the status line
      element("input-status").className = "";
      assert.equal(paste(page, SERIES_ID), false);
      for (let turns = 0; turns < 20 && element("input-status").className !== "status error"; turns += 1) await page.turn();
      assert.equal(element("input-status").textContent, `DramaFetch stopped: ${UNSAVED}. Chrome could not write to its profile folder — usually its disk is full. Free some space, restart Chrome and run again: what is already saved is skipped.`);
      assert.equal(element("links").value, SERIES_ID);
      assert.deepEqual(waitingRows(page), []);
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
      page.message({ type: "dramafetch:load", input: SERIES_ID });
      for (let turns = 0; turns < 20 && page.element("input-status").className !== "status error"; turns += 1) await page.turn();
      assert.deepEqual(waitingRows(page), []);
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

test("the page: at a job's end with failures the report is saved once under DramaFetch/reports, named and parseable; nothing for a job that produced no run or a clean job", async () => {
  const page = await fakePage();
  try {
    const { element, module, downloads } = page;
    assert.equal(element("setting-report").checked, true); // the setting, on by default
    assert.equal(element("report-button").disabled, true);
    const before = new Date();
    await module.reportJobEnd({ kind: "selection", label: "Retry 4 of Test Series" }, OUTCOME, [finishedRun(SERIES_ID, "Test Series", reportRows())], TRACES.of);
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
      label: "Retry 4 of Test Series",
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
    // 3.0.1: the digest also says whether DramaFetch only guessed the episode was locked, and the sound's id and title
    assert.deepEqual(Object.keys(run.episodes_digest[0]), [
      "number",
      "access",
      "lock_hints",
      "guessed_lock",
      "duration_s",
      "music_id",
      "music_title",
      "music_duration_s",
      "music_original",
      "size",
      "bitrate",
      "is_preview",
      "preview_type",
    ]);
    assert.deepEqual(run.episodes_digest[0], {
      number: 1,
      access: "free",
      lock_hints: [],
      guessed_lock: false,
      duration_s: 3,
      music_id: null,
      music_title: null,
      music_duration_s: null,
      music_original: null,
      size: null,
      bitrate: null,
      is_preview: null,
      preview_type: null,
    });
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
    // a job that produced no run has no report; the button goes back to disabled
    await module.reportJobEnd({ kind: "batch", label: "2 series" }, OUTCOME, null, TRACES.of);
    assert.equal(downloads.length, 2);
    assert.equal(element("report-button").disabled, true);
    // a job in which nothing failed: no report (a locked skip alone is no failure) — over a whole list
    // (3.0.1: the list the run's rows alone make lacks number 2, which is worth a report of its own, below)
    const clean = reportRows().filter((row) => row.status !== "failed");
    const whole = finishedRun(SERIES_ID, "Test Series", clean);
    whole.series = { .../** @type {import("../src/lib/catalog.js").Series} */ (whole.series), episodes: reportRows().map((row) => row.episode) };
    await module.reportJobEnd({ kind: "selection", label: "clean" }, OUTCOME, [whole], TRACES.of);
    assert.equal(downloads.length, 2);
    assert.equal(element("report-button").disabled, true);
    // 3.0.1: nothing failed, but TikTok's list lacks episode 2: the report is saved, its listing section says so
    await module.reportJobEnd({ kind: "selection", label: "short list" }, OUTCOME, [finishedRun(SERIES_ID, "Test Series", clean)], TRACES.of);
    assert.equal(downloads.length, 3);
    const short = JSON.parse(/** @type {string} */ (downloads[2]?.text));
    assert.deepEqual(short.series[0].listing.missing_numbers, [2]);
    assert.equal(short.series[0].listing.incomplete, true);
    downloads.pop();
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

test("the page hears only the extension's own pages and worker: the popup, the DramaFetch tab, the worker with or without its address — never a TikTok page carrying the extension's id (no content script is declared since 2.0.0, but the functions DramaFetch injects into a TikTok tab run there with its id), nor another extension", async () => {
  const page = await fakePage();
  try {
    const { element } = page;
    page.hold(); // a job queued here runs and makes no request
    const queued = () => waitingRows(page);
    const profile = "https://www.tiktok.com/@invented_viewer";
    const tiktokTab = { id: 42, index: 0, windowId: 2, active: true, url: profile };
    const ours = [
      { id: "dramafetch-test-id", url: `${EXTENSION_ROOT}src/app/popup.html` }, // the popup
      { id: "dramafetch-test-id", url: `${EXTENSION_ROOT}src/app/app.html`, tab: { id: 3, index: 0, windowId: 1, active: true, url: `${EXTENSION_ROOT}src/app/app.html` } }, // a DramaFetch tab
      { id: "dramafetch-test-id", url: `${EXTENSION_ROOT}src/app/background.js` }, // the worker, with its address
      { id: "dramafetch-test-id" }, // the worker, without one
    ];
    const theirs = [
      { id: "dramafetch-test-id", url: profile, tab: tiktokTab }, // a TikTok page with the extension's id
      { id: "dramafetch-test-id", url: profile, frameId: 0 },
      { id: "dramafetch-test-id", tab: tiktokTab }, // a tab but no address: never the worker
      { id: "dramafetch-test-id", url: "chrome-extension://another-extension/src/app/popup.html" },
      { id: "another-extension", url: `${EXTENSION_ROOT}src/app/popup.html` },
    ];
    for (const sender of theirs) {
      assert.deepEqual(page.message({ type: "dramafetch:load", input: SERIES_ID }, sender), [], JSON.stringify(sender));
    }
    assert.equal(element("links").value, "");
    assert.equal(element("queue-card").hidden, true);
    assert.equal(element("app-status").dataset["state"], "idle"); // nothing queued
    const series = ["7699393770256782399", "7699393770256782388", "7699393770256782366", "7699393770256782344"];
    for (const [index, sender] of ours.entries()) {
      assert.deepEqual(page.message({ type: "dramafetch:load", input: series[index] }, sender), [{ ok: true, tabId: 1 }], JSON.stringify(sender));
    }
    await page.turn();
    assert.deepEqual(queued(), series.map((id) => dramaRow(id))); // the first runs — its list not read yet, so it waits too —, the rest wait
  } finally {
    page.restore();
  }
});

// ---------------------------------- DramaFetch 4.0.0: no library, nothing read of the Favorites

test("the library, every read of the user's TikTok Favorites and their hand-overs are gone (DramaFetch 4.0.0, the owner's decision of 2026-11-27): no element, no handler, no message, no key, no style — and a 3.x hand-over, a message or an address, is ignored: nothing queued, nothing said, the address cleared, in a read-only tab too", async () => {
  const html = readFileSync(new URL("../src/app/app.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/app/app.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/app/app.js", import.meta.url), "utf8");
  for (const removed of ['id="library', 'href="#library"', "favorites-", "library-", "navLibrary", "drama-grid"]) assert.ok(!html.includes(removed), `app.html: ${removed}`);
  for (const removed of [
    "runFavorites",
    "favoritesFromOutside",
    "showLibrarySection",
    "renderLibrary",
    "libraryCovers",
    "queueDramas",
    "onLibraryDownload",
    "openOnTikTok",
    "dramafetch:favorites",
    "dramafetch:library",
    "favoritesOfQuery",
    "readLibrary",
    "writeLibrary",
    "favoritesLibrary",
    "librarySort",
    "chrome.tabs.query",
    "chrome.tabs.create",
  ]) {
    assert.ok(!source.includes(removed), `app.js: ${removed}`);
  }
  for (const removed of [".drama-", ".selection-bar", ".connection", ".library", "--conn-bg", "--bar-", "--ph-", "--pick-", "--link-hover", ".queue-row.favorites", ".badge.twin", ".badge.queued", "#favorites-card"]) {
    assert.ok(!css.includes(removed), `app.css: ${removed}`);
  }
  for (const language of ["en", "es"]) {
    /** @type {Record<string, unknown>} */
    const catalog = JSON.parse(readFileSync(new URL(`../_locales/${language}/messages.json`, import.meta.url), "utf8"));
    for (const key of Object.keys(catalog)) assert.ok(!/^(favorites|library|popupLibrary|popupFavorites|navLibrary|jobFavorites|queueFavorites)/.test(key), `${language}: ${key}`);
    assert.ok(Object.hasOwn(catalog, "queuedSeveral"), `${language}: the paste's several-series line, renamed`);
  }
  // a 3.x hand-over handed to this page: no answer, no job, nothing said — and nothing of the
  // browser session's memory read for it, at the page's start or since
  const page = await fakePage();
  try {
    const { element, module } = page;
    page.hold();
    assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: 42 }), []);
    assert.deepEqual(page.message({ type: "dramafetch:library" }), []);
    await page.turn();
    assert.deepEqual(module.queuedJobs(), []);
    assert.equal(element("input-status").textContent, "");
    const asked = page.sessionKeys.flatMap((keys) => (Array.isArray(keys) ? keys : [keys])).map(String);
    assert.ok(asked.length > 0, "the page reads its session keys (the discovery tab's record)");
    for (const key of asked) assert.doesNotMatch(key, /favorit|librar/i, key);
  } finally {
    page.restore();
  }
  // a tab a 3.x worker reloaded with a hand-over in its address, restored or bookmarked since: the
  // address cleared, nothing queued, nothing said, never an error
  for (const search of ["?favorites=42", "?library=1"]) {
    const opened = await fakePage({ search });
    try {
      assert.deepEqual(opened.replaced, ["/src/app/app.html"], search);
      await opened.turn();
      assert.deepEqual(opened.module.queuedJobs(), [], search);
      assert.equal(opened.element("input-status").textContent, "", search);
      assert.equal(opened.element("app-status").dataset["state"], "idle", search);
    } finally {
      opened.restore();
    }
    // the same in a read-only tab (another DramaFetch tab holds the engine): cleared all the same,
    // so that a reload once it holds the engine finds nothing in its address
    const readonly = await fakePage({ search, lockTaken: true, testSettings: {} });
    try {
      assert.equal(readonly.element("duplicate-banner").hidden, false, search); // read-only indeed
      assert.deepEqual(readonly.replaced, ["/src/app/app.html"], search);
      for (let turns = 0; turns < 5; turns += 1) await readonly.turn();
      assert.deepEqual(readonly.module.queuedJobs(), [], search);
      assert.deepEqual(readonly.module.journal(), [], search);
      assert.equal(readonly.element("input-status").textContent, "", search);
    } finally {
      readonly.restore();
    }
  }
});

test("See episodes, its downloads again in full and the page's thumbnails are gone (DramaFetch 4.0.0, the owner's decision of 2026-11-27: no library, no See episodes): no episode list to pick from, no job that lists a drama without downloading it, no job that replaces a file — no element, no handler, no export, no key, no style; the jobs left are a batch (a paste, Enter, the popup's hand-over) and a Retry's selection", async () => {
  const read = (/** @type {string} */ path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const html = read("src/app/app.html");
  const css = read("src/app/app.css");
  const source = read("src/app/app.js");
  for (const removed of ["series-card", "series-title", "series-meta", "series-warnings", "episode-table", "download-available-button", "download-selected-button", "selection-count", "select-all"]) {
    assert.ok(!html.includes(removed), `app.html: ${removed}`);
    assert.ok(!source.includes(removed), `app.js: ${removed}`);
  }
  for (const removed of ["runLoad", "listSeries", "loadPending", "startSelection", "availableNumbers", "renderSeries", "redrawListed", "listedDrm", "coversAllowed", "coverLoaders", "CoverLoader", "CoverLane", "overwrite", "job.pick", "job.series"]) {
    assert.ok(!source.includes(removed), `app.js: ${removed}`);
  }
  assert.doesNotMatch(source, /kind\s*(?:===|!==|:)\s*"(?:load|favorites)"/); // no listing job (the `?load=` hand-over is a paste's batch)
  assert.match(source, /@property \{"batch" \| "selection"\} kind/); // the two kinds of job left
  // the downloader: no thumbnail loader, and every save `uniquify` — nothing that could replace a file
  const downloader = read("src/app/downloader.js");
  for (const removed of ["CoverLoader", "CoverLane", "COVER_MARGIN_PX", "IntersectionObserver", '"overwrite"', ".overwrite", "ConflictAction"]) {
    assert.ok(!downloader.includes(removed), `downloader.js: ${removed}`);
  }
  assert.deepEqual([...downloader.matchAll(/conflictAction\b[^,}]*/g)].map((match) => match[0]), ['conflictAction: "uniquify"']);
  assert.ok(!/\boverwrite\b/.test(read("src/app/engine.js")), "engine.js: overwrite");
  for (const removed of [".cover", ".hints", ".warnings", "#episode-table", "#series-card", ".badge.free", ".badge.ondisk", ".badge.unlocked", ".badge.locked", ".queue-row.load", ".queue-row.selected", ".queue-row.available", "--queue-list-", "--pink-", "--chip"]) {
    assert.ok(!css.includes(removed), `app.css: ${removed}`);
  }
  const seeEpisodesKeys = [
    "badgeFree",
    "badgeFreeTitle",
    "badgeUnlocked",
    "badgeUnlockedTitle",
    "badgeLocked",
    "badgeLockedTitle",
    "badgeOnDisk",
    "badgeOnDiskTitle",
    "downloadAvailableButton",
    "downloadSelectedButton",
    "seriesMeta",
    "seriesDrmHint",
    "selectionCount",
    "selectionLocked",
    "loading",
    "loaded",
    "loadAlreadyQueued",
    "jobLoad",
    "jobSelection",
    "selectAll",
    "colCover",
    "colTitle",
    "colDuration",
    "colQuality",
    "colAccess",
    "queueSelected",
    "queueAvailable",
    "queueSeeEpisodes",
  ];
  for (const language of ["en", "es"]) {
    /** @type {Record<string, {message: string}>} */
    const catalog = JSON.parse(read(`_locales/${language}/messages.json`));
    for (const key of seeEpisodesKeys) assert.ok(!Object.hasOwn(catalog, key), `${language}: ${key}`);
    // the keys these features shared with what stays: a drama skipped as complete (its header row),
    // the paste's several-series line, the tables' # column
    for (const kept of ["seriesSkippedComplete", "queuedSeveral", "colNumber"]) assert.ok(Object.hasOwn(catalog, kept), `${language}: ${kept}`);
    for (const key of ["linksLabel", "linksHint"]) assert.doesNotMatch(String(catalog[key]?.message), /See episodes|Ver episodios|library|biblioteca/, `${language}: ${key}`);
  }
  // and at run time: none of the exports the tests of See episodes and the thumbnails read
  const page = await fakePage();
  try {
    const exported = Object.keys(page.module);
    for (const removed of ["runLoad", "coversAllowed", "coverLoaders"]) assert.ok(!exported.includes(removed), removed);
    for (const kept of ["buildEngine", "retryTargets", "retryJobs", "queueRows", "queuedJobs", "renderFailed", "reportJobEnd"]) assert.ok(exported.includes(kept), kept);
  } finally {
    page.restore();
  }
});

// ---------------------------------------------------- DramaFetch 1.7.0: the box downloads

test("the page: the duplicate guard follows the running batch drama by drama — a paste, Enter or the popup's hand-over of a drama it has not finished is refused (named, nothing queued twice); one it has finished queues again, behind it —; a waiting Retry holds its drama the same way; and a finished drama is the running batch's only: the next batch holds it afresh", async () => {
  const refused = (/** @type {string} */ id) => `Already being downloaded, or waiting to be — not queued twice: ${id}.`;
  const page = await fakePage();
  try {
    const { element, module } = page;
    fakeNotifications();
    page.hold(); // the job's `tabs.getCurrent` never answers: it runs, and makes no request
    assert.equal(paste(page, `${SERIES_ID}\n${OTHER_ID}`), true); // ONE batch of the two: running
    await page.turn();
    const [running] = module.queuedJobs();
    assert.ok(running !== undefined && running.kind === "batch");
    // before its first drama's list: both of its dramas are being downloaded — a paste, Enter, the hand-over
    for (const id of [SERIES_ID, OTHER_ID]) {
      assert.equal(paste(page, id), true); // taken: never lands in the box
      assert.equal(element("input-status").textContent, refused(id));
    }
    element("links").value = OTHER_ID;
    assert.equal(press(page), true);
    assert.equal(element("input-status").textContent, refused(OTHER_ID));
    assert.equal(element("links").value, ""); // taken (refused, named): Enter empties the box
    assert.deepEqual(page.message({ type: "dramafetch:load", input: SERIES_ID }), [{ ok: true, tabId: 1 }]);
    assert.equal(element("input-status").textContent, refused(SERIES_ID));
    assert.equal(module.queuedJobs().length, 1);
    // the batch runs on through the page's own hooks (its engine is the running job's): its first
    // drama downloads — still refused —, then is done
    const engine = module.buildEngine(running, { pauses: [], inputs: [], taking: true });
    engine.onSeriesStart?.(1, 2, refOf(SERIES_ID));
    assert.equal(paste(page, SERIES_ID), true);
    assert.equal(element("input-status").textContent, refused(SERIES_ID));
    const done = { episode: episode(1), status: /** @type {const} */ ("done"), path: "/dl/E01.mp4", message: "saved E01.mp4 (0.1 MiB) + cover embedded", downloadId: 1 };
    engine.onSeriesDone?.(1, 2, finishedRun(SERIES_ID, "Test Series", [done]));
    // done with it: a paste of it queues it again — a batch of its own, behind the running one —;
    // the drama it has not finished is still refused, and so is the one just queued
    assert.equal(paste(page, SERIES_ID), true);
    assert.equal(element("input-status").textContent, `Series ${SERIES_ID} queued: it downloads whole, with the usual pauses.`);
    assert.deepEqual(module.queuedJobs().map(jobSummary), [
      ["batch", "2 series", [SERIES_ID, OTHER_ID], false, false],
      ["batch", `Series ${SERIES_ID}`, [SERIES_ID], false, false],
    ]);
    for (const id of [OTHER_ID, SERIES_ID]) {
      assert.equal(paste(page, id), true);
      assert.equal(element("input-status").textContent, refused(id));
    }
    // a Retry waiting in the queue (a selection job) holds its drama: a paste and the hand-over of it are refused
    module.renderFailed([seriesRecord(THIRD_ID, "Drama 2388", [[2, "failed"]])]);
    element("retry-button").fire("click");
    assert.deepEqual(module.queuedJobs().map((job) => [job.kind, job.refs.map((ref) => ref.seriesId)]).at(-1), ["selection", [THIRD_ID]]);
    assert.equal(paste(page, THIRD_ID), true);
    assert.equal(element("input-status").textContent, refused(THIRD_ID));
    assert.deepEqual(page.message({ type: "dramafetch:load", input: THIRD_ID }), [{ ok: true, tabId: 1 }]);
    assert.equal(element("input-status").textContent, refused(THIRD_ID));
    assert.equal(module.queuedJobs().length, 3); // nothing queued twice
  } finally {
    page.restore();
  }
  // a drama a batch finished counts as finished for that batch alone: once it ends, the next batch
  // that names it holds it until it is done with it (each job starts with none finished)
  const next = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = next;
    fakeNotifications();
    const journal = () => module.journal();
    assert.equal(paste(next, SERIES_ID), true); // job 1: its list cannot be read here (no tab can open) — done with it, and ended
    for (let turn = 0; turn < 500 && (journal().length < 1 || element("app-status").dataset["state"] !== "idle"); turn += 1) await next.turn();
    assert.equal(journal().length, 1);
    const open = gateJobs();
    assert.equal(paste(next, `${SERIES_ID}\n${OTHER_ID}`), true); // job 2, started: held at its gate
    await next.turn();
    assert.equal(paste(next, SERIES_ID), true);
    assert.equal(element("input-status").textContent, refused(SERIES_ID));
    assert.equal(module.queuedJobs().length, 1);
    open();
    for (let turn = 0; turn < 500 && (journal().length < 2 || element("app-status").dataset["state"] !== "idle"); turn += 1) await next.turn();
  } finally {
    next.restore();
  }
});

test("the page: a paste of three lines on a fresh page is ONE batch of the three, in their order — the checkboxes' values for that run, then cleared —; the series a hand-over gives in the tab's address (`?load=`, no running page took it) is downloaded the same way, the address cleared; a read-only tab takes nothing, its address cleared too", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    page.hold(); // the job's `tabs.getCurrent` never answers: it runs, and makes no request
    const ids = ["7699393770256782399", "7699393770256782388", "7699393770256782377"];
    element("include-locked").checked = true;
    element("recheck").checked = true;
    assert.equal(paste(page, `https://www.tiktok.com/shortdrama/episode/${ids[0]}/7\n${ids[1]}\r\nhttps://m.tiktok.com/shortdrama/episode/${ids[2]}/1`), true);
    await page.turn();
    assert.deepEqual(module.queuedJobs().map(jobSummary), [["batch", "3 series", ids, true, true]]);
    assert.equal(element("include-locked").checked, false);
    assert.equal(element("recheck").checked, false);
    assert.equal(element("input-status").textContent, "3 series queued: they download one after the other, with the usual pauses.");
    assert.equal(element("links").value, "");
  } finally {
    page.restore();
  }
  // the address: taken once (the job runs to its end here — the discovery can open no tab, so no request)
  const link = `?load=${encodeURIComponent(`https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/2`)}`;
  const opened = await fakePage({ search: link, testSettings: QUICK });
  try {
    assert.deepEqual(opened.replaced, ["/src/app/app.html"]);
    for (let turn = 0; turn < 200 && opened.module.journal().length === 0; turn += 1) await opened.turn();
    assert.deepEqual(opened.module.journal().map((entry) => [entry["kind"], entry["label"]]), [["batch", `Series ${SERIES_ID}`]]);
    assert.equal(opened.element("links").value, "");
  } finally {
    opened.restore();
  }
  // a read-only tab (another DramaFetch tab holds the engine) takes nothing, its address cleared too:
  // reloaded once the engine is free, it never queues that series again
  for (const search of [link, `?load=${SERIES_ID}`]) {
    const readonly = await fakePage({ search, lockTaken: true, testSettings: QUICK });
    try {
      assert.equal(readonly.element("duplicate-banner").hidden, false, search); // read-only indeed
      assert.deepEqual(readonly.replaced, ["/src/app/app.html"], search);
      for (let turns = 0; turns < 5; turns += 1) await readonly.turn();
      assert.deepEqual(readonly.module.queuedJobs(), [], search);
      assert.deepEqual(readonly.module.journal(), [], search); // nothing ran, nothing was refused
      assert.equal(readonly.element("queue-card").hidden, true, search);
      assert.equal(readonly.element("input-status").textContent, "", search);
      assert.equal(readonly.element("links").value, "", search);
    } finally {
      readonly.restore();
    }
  }
});

test("the box (DramaFetch 4.0.0, the owner's request of 2026-11-27: “que las descargas se hagan automáticamente al pegar el link o el id … que se vayan acumulando en la cola”): an ID pasted — not a link — downloads its whole drama at once, no button: ONE batch job, running; pasted while it runs, a link queues a second job behind it, two lines in one paste a third, typed IDs and Enter a fourth — one job at a time, every drama in Waiting in the order it will run —; the running drama leaves Waiting once its list is read; the box's label and hint say so in both languages", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    page.hold(); // the first job's tabs.getCurrent never answers: it runs, asking nothing; the others wait
    // an ID pasted: its whole drama queued at once, and running
    assert.equal(paste(page, SERIES_ID), true);
    await page.turn();
    assert.deepEqual(module.queuedJobs().map(jobSummary), [["batch", `Series ${SERIES_ID}`, [SERIES_ID], false, false]]);
    assert.equal(element("app-status").dataset["state"], "running");
    assert.equal(element("progress-current").textContent, `Series ${SERIES_ID}`);
    assert.equal(element("input-status").textContent, `Series ${SERIES_ID} queued: it downloads whole, with the usual pauses.`);
    assert.deepEqual(waitingRows(page), [dramaRow(SERIES_ID)]); // its list not read yet: it waits too
    // pasted while it runs: a link — a second job, behind it —, then two lines in one paste — a third
    assert.equal(paste(page, `https://www.tiktok.com/shortdrama/episode/${OTHER_ID}/3`), true);
    assert.equal(element("input-status").textContent, `Series ${OTHER_ID} queued: it downloads whole, with the usual pauses.`);
    assert.equal(paste(page, `${THIRD_ID}\n${FOURTH_ID}`), true);
    assert.equal(element("input-status").textContent, "2 series queued: they download one after the other, with the usual pauses.");
    // typed IDs, then Enter: a fourth, the box emptied
    const typed = "7699393770256782366";
    element("links").value = typed;
    assert.equal(press(page), true);
    assert.equal(element("links").value, "");
    await page.turn();
    assert.deepEqual(module.queuedJobs().map(jobSummary), [
      ["batch", `Series ${SERIES_ID}`, [SERIES_ID], false, false],
      ["batch", `Series ${OTHER_ID}`, [OTHER_ID], false, false],
      ["batch", "2 series", [THIRD_ID, FOURTH_ID], false, false],
      ["batch", `Series ${typed}`, [typed], false, false],
    ]);
    assert.equal(element("progress-current").textContent, `Series ${SERIES_ID}`); // still the first: one job at a time
    assert.equal(element("queue-card").hidden, false);
    assert.deepEqual(waitingRows(page), [SERIES_ID, OTHER_ID, THIRD_ID, FOURTH_ID, typed].map((id) => dramaRow(id)));
    // the running job reads its drama's list (the page's own hooks: its engine is the running job's):
    // that drama leaves Waiting, the others wait in their order
    const [running] = module.queuedJobs();
    assert.ok(running !== undefined);
    const engine = module.buildEngine(running, { pauses: [], inputs: [], taking: true });
    engine.onSeriesStart?.(1, 1, refOf(SERIES_ID));
    engine.onStart?.({ ref: refOf(SERIES_ID), series: null, name: "Test Series", episodes: [], skippedComplete: false });
    assert.deepEqual(waitingRows(page), [OTHER_ID, THIRD_ID, FOURTH_ID, typed].map((id) => dramaRow(id)));
    assert.equal(module.queuedJobs().length, 4);
  } finally {
    page.restore();
  }
  // the box says it: one or many links or IDs, one per line, at once and one after the other; what
  // is pasted while DramaFetch works joins Waiting (the card's own heading) — in both languages, the
  // page's English fallback the English text
  const html = readFileSync(new URL("../src/app/app.html", import.meta.url), "utf8");
  for (const [language, words] of /** @type {const} */ ([
    ["en", { label: [/one or more/, /IDs/, /one per line/, /at once/, /one after the other/], hint: [/Keep pasting while DramaFetch works/, /joins the queue/] }],
    ["es", { label: [/uno o varios/, /IDs/, /uno por línea/, /sin pulsar nada más/, /uno tras otro/], hint: [/Sigue pegando mientras DramaFetch trabaja/, /se suma a la cola/] }],
  ])) {
    /** @type {Record<string, {message: string}>} */
    const catalog = JSON.parse(readFileSync(new URL(`../_locales/${language}/messages.json`, import.meta.url), "utf8"));
    const label = String(catalog["linksLabel"]?.message);
    const hint = String(catalog["linksHint"]?.message);
    for (const word of words.label) assert.match(label, word, `${language}: linksLabel`);
    for (const word of words.hint) assert.match(hint, word, `${language}: linksHint`);
    assert.ok(hint.includes(`(${catalog["queueHeading"]?.message})`), `${language}: the hint names the Waiting card by its heading`);
    if (language === "en") {
      assert.ok(html.includes(`>${label}</label>`), "app.html: the label's English fallback");
      assert.ok(html.includes(`>${hint}</p>`), "app.html: the hint's English fallback");
    }
  }
});

test("the page: Load list, Download all and Add selected to the box are gone — no element, no handler, no message —; the box's paste and Enter take their place", async () => {
  const html = readFileSync(new URL("../src/app/app.html", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/app/app.js", import.meta.url), "utf8");
  for (const removed of ["load-button", "download-all-button", "favorites-add-button"]) {
    assert.ok(!html.includes(`id="${removed}"`), removed);
    assert.ok(!source.includes(`"${removed}"`), removed);
  }
  for (const handler of ["onLoad", "onDownloadAll", "onFavoritesAdd", "joinBox", "loadFromOutside"]) assert.ok(!new RegExp(`function ${handler}\\b`).test(source), handler);
  for (const language of ["en", "es"]) {
    /** @type {Record<string, unknown>} */
    const messages = JSON.parse(readFileSync(new URL(`../_locales/${language}/messages.json`, import.meta.url), "utf8"));
    for (const key of ["loadButton", "downloadAllButton", "favoritesAddButton", "favoritesAdded", "favoritesNoneAdded", "loadOneOnly", "favoritesEpisodesLength"]) assert.ok(!Object.hasOwn(messages, key), `${language}: ${key}`);
  }
  assert.ok(html.includes('id="links"'));
  const page = await fakePage();
  try {
    assert.ok(page.element("links").listeners.has("paste") && page.element("links").listeners.has("keydown"));
  } finally {
    page.restore();
  }
});

// ------------------------------------------------ the alert when a drama finishes (DramaFetch 1.7.0)

/** The worker, as the page sees it when it hands a notification's **Retry** over. */
const WORKER = { id: "dramafetch-test-id", url: `${EXTENSION_ROOT}src/app/background.js` };
/** The notification's icon: the extension's own file, its address from the extension's root. */
const ALERT_ICON_URL = `${EXTENSION_ROOT}icons/icon128.png`;
/** @param {string} seriesId @returns {import("../src/lib/urls.js").SeriesRef} */
const refOf = (seriesId) => ({ kind: "series", seriesId, episodeHint: null, sourceUrl: seriesId });
/**
 * The test copy's settings for jobs run through the page's own queue: no wait for Chrome's file
 * checks, and the rest between jobs and the list-page pause cut to milliseconds (test mode only).
 */
const QUICK = { existenceRateLimitS: 0, existenceDelayMs: 0, restMinS: 0.001, restMaxS: 0.002, pageDelayS: 0.001 };

/**
 * A fake `chrome.notifications` on the page's fake chrome: `shown` holds what Chrome shows (by id,
 * with its options), `created` every id the page asked for, in order, `cleared` every id it took
 * away; `getAll()` answers as Chrome does. With `refuse`, `create` throws, rejects or never answers.
 * @param {{refuse?: "throw" | "reject" | "hang"}} [options]
 */
function fakeNotifications(options = {}) {
  /** @type {Map<string, Record<string, unknown>>} */
  const shown = new Map();
  /** @type {string[]} */
  const created = [];
  /** @type {string[]} */
  const cleared = [];
  const api = {
    /** @param {string} id @param {Record<string, unknown>} notification */
    create: (id, notification) => {
      created.push(id);
      if (options.refuse === "throw") throw new TypeError("Error in invocation of notifications.create");
      if (options.refuse === "reject") return Promise.reject(new Error("Unable to download all specified images."));
      if (options.refuse === "hang") return new Promise(() => undefined);
      shown.set(id, JSON.parse(JSON.stringify(notification)));
      return Promise.resolve(id);
    },
    /** @param {string} id */
    clear: async (id) => {
      cleared.push(id);
      return shown.delete(id);
    },
    getAll: async () => Object.fromEntries([...shown.keys()].map((id) => [id, true])),
    onClicked: { addListener: () => undefined },
    onButtonClicked: { addListener: () => undefined },
  };
  Object.assign(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis.chrome)), { notifications: api });
  return { api, shown, created, cleared };
}

/**
 * The page's engine of `job` over a scripted TikTok: every series listed with `episodes` episodes
 * (`locked[seriesId]` the numbers its session may not play; the series named `Drama <its last four
 * digits>`), every download `done` unless `statuses` gives `<series id>:<number>` another status (a
 * 429's message the media server's) — with the fake engine's clock, sleep, cooldown, view and state
 * (`states`, which a test may seed). The page's own hooks, pacing state and `persist` see real runs
 * of `runBatch` and `runSelectionJob`; nothing is asked of anything.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {import("../src/app/app.js").Job} job
 * `onDownload` is told of every episode the run asks for, before its result. `absent[seriesId]`
 * (3.0.1): the numbers TikTok's list leaves out of that series every time it is listed — TikTok
 * still counts them (`totalHint`), and they are the series' `missingNumbers`. `guessed[seriesId]`
 * (3.0.1): the numbers DramaFetch's own rules only guessed were locked (no play address): skipped,
 * `looks locked: no play address`, as the locked ones.
 * @param {{episodes?: number, locked?: Record<string, number[]>, guessed?: Record<string, number[]>, statuses?: Record<string, string>, onDownload?: (ep: import("../src/lib/catalog.js").Episode) => void, absent?: Record<string, number[]>}} [options]
 */
function scriptedEngine(page, job, options = {}) {
  /** @type {import("../src/app/app.js").JobRecord} */
  const jobRecord = { pauses: [], inputs: [], taking: true };
  const engine = page.module.buildEngine(job, jobRecord);
  const fake = fakeEngine();
  const statuses = options.statuses ?? {};
  const downloader = {
    refreshes: 0,
    existingResult: () => null,
    /** @param {import("../src/lib/catalog.js").Episode} ep */
    needsNetwork: (ep) => ep.access !== "locked",
    /** @param {import("../src/lib/catalog.js").Episode} ep */
    async download(ep) {
      options.onDownload?.(ep);
      if (ep.access === "locked") return { episode: ep, status: "skipped-locked", path: null, message: "looks locked: no play address" };
      const status = statuses[`${ep.seriesId}:${ep.number}`] ?? "done";
      if (status === "done") return { episode: ep, status, path: `/dl/${ep.seriesId}/E${ep.number}.mp4`, message: `saved E${ep.number}.mp4 (0.1 MiB) + cover embedded`, downloadId: ep.number };
      return { episode: ep, status, path: null, message: status === "failed-rate-limited" ? MEDIA_RATE_LIMIT_MESSAGE : `${status} ${ep.number}` };
    },
  };
  Object.assign(engine, {
    sleep: fake.engine.sleep,
    clock: fake.engine.clock,
    wallClock: fake.engine.wallClock,
    rng: fake.engine.rng,
    cooldownStore: fake.engine.cooldownStore,
    discover: async (/** @type {import("../src/lib/urls.js").SeriesRef} */ ref) => {
      const count = options.episodes ?? 3;
      const absent = options.absent?.[ref.seriesId] ?? [];
      const listed = series(
        Array.from({ length: count }, (_, index) =>
          episode(index + 1, {
            seriesId: ref.seriesId,
            locked: options.locked?.[ref.seriesId]?.includes(index + 1),
            guessed: options.guessed?.[ref.seriesId]?.includes(index + 1), // 3.0.1
          }),
        ).filter(
          (ep) => !absent.includes(ep.number),
        ),
        `Drama ${ref.seriesId.slice(-4)}`,
        ref.seriesId,
      );
      if (absent.length === 0) return listed;
      const missing = [...absent].sort((a, b) => a - b);
      return { ...listed, totalHint: count, itemsReceived: count - missing.length, missingNumbers: missing, warnings: [`TikTok announces ${count} episodes, ${count - missing.length} listed`] };
    },
    downloader,
    view: fake.engine.view,
    readState: fake.engine.readState,
    writeState: fake.engine.writeState,
  });
  return { engine, jobRecord, states: fake.states };
}

/**
 * The per-series records of finished runs as a job's record keeps them — what the tab's **Retry**
 * reads (`retryTargets`).
 * @param {readonly import("../src/app/engine.js").SeriesRun[]} runs
 */
const recordsOf = (runs) =>
  runs.map((run) => ({ series_id: run.ref.seriesId, name: run.report.name, rows: run.results.map((result) => ({ number: result.episode.number, status: result.status, message: result.message })) }));

test("the alert: as each drama of a batch is done — its rows and records stored — the complete one says ✓ with its episodes on disk and its locked one in the report line's words; the one with failures says ⚠, names them and has ONE button, Retry; the ids are this page's, the job's and the drama's", async () => {
  const page = await fakePage({ storage: NO_AUTO_RETRY }); // the ⚠ alert of plain failures: the automatic retry off
  try {
    const { module } = page;
    const notes = fakeNotifications();
    const job = { ...BATCH_JOB, id: 7, refs: [refOf(SERIES_ID), refOf(OTHER_ID)] };
    /** @type {string[]} the drama's records as each alert was asked for */
    const storedAtAlert = [];
    const { engine, states } = scriptedEngine(page, job, { episodes: 12, locked: { [SERIES_ID]: [12] }, statuses: { [`${OTHER_ID}:3`]: "failed", [`${OTHER_ID}:7`]: "failed", [`${OTHER_ID}:12`]: "failed" } });
    const create = notes.api.create;
    notes.api.create = (id, notification) => {
      storedAtAlert.push(JSON.stringify(states.get(id.split(":").at(-2) ?? "")));
      return create(id, notification);
    };
    const runs = await runBatch(engine, job.refs);
    assert.deepEqual(runs.map((run) => run.report.complete), [true, false]);
    const page7 = `dramafetch-alert:${module.alerts.page}:7`;
    assert.deepEqual(notes.created, [`${page7}:${SERIES_ID}:complete`, `${page7}:${OTHER_ID}:retry`]);
    assert.deepEqual(notes.shown.get(`${page7}:${SERIES_ID}:complete`), {
      type: "basic",
      iconUrl: ALERT_ICON_URL,
      title: "✓ Drama 2354 — downloaded",
      message: "All 11 episodes are on disk — 1 locked (12).",
      priority: 0,
      requireInteraction: false,
      silent: false,
    });
    assert.deepEqual(notes.shown.get(`${page7}:${OTHER_ID}:retry`), {
      type: "basic",
      iconUrl: ALERT_ICON_URL,
      title: "⚠ Drama 2399 — 3 episodes to retry",
      message: "E03, E07, E12 did not download.",
      priority: 0,
      requireInteraction: false,
      silent: false,
      buttons: [{ title: "Retry" }],
    });
    // made after the drama's every row was stored — its complete mark too
    const [first, second] = storedAtAlert.map((stored) => JSON.parse(stored));
    assert.equal(Object.keys(first.episodes).length, 12);
    assert.equal(first.complete_episodes, 11);
    assert.equal(Object.keys(second.episodes).length, 12);
    assert.deepEqual(Object.values(second.episodes).filter((entry) => entry.status === "failed").map((entry) => entry.number), [3, 7, 12]);
    // its Retry stands for what the tab's Retry takes for that drama
    assert.deepEqual(module.alerts.retryOf(`${page7}:${OTHER_ID}:retry`), module.retryTargets(recordsOf(runs))[0]);
    assert.equal(module.alerts.retryOf(`${page7}:${SERIES_ID}:complete`), null);
    // the batch ended without a stop: no more alerts
    module.alertJobEnd({ ...job, contacted: true }, null, runs, {}, []);
    assert.equal(notes.created.length, 2);
  } finally {
    page.restore();
  }
});

test("the alert's Retry, handed over by the worker: the page that made it queues exactly the selection job the tab's Retry queues for that drama and takes the alert away — once; a cooldown in force: nothing queued, the alert kept, the tab named for the worker to bring forward; an alert of another page, or a sender that is no page of the extension: no answer", async () => {
  /** @type {import("../src/app/engine.js").SeriesRun[]} */
  let runs = [];
  /** @type {Omit<import("../src/app/app.js").Job, "id"> | undefined} */
  let expected;
  const page = await fakePage({ storage: NO_AUTO_RETRY }); // the ⚠ alert of plain failures: the automatic retry off
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    const job = { ...BATCH_JOB, id: 3, refs: [refOf(OTHER_ID)] };
    const { engine } = scriptedEngine(page, job, { episodes: 12, statuses: { [`${OTHER_ID}:3`]: "failed", [`${OTHER_ID}:7`]: "failed-unavailable", [`${OTHER_ID}:12`]: "failed" } });
    runs = await runBatch(engine, job.refs);
    const [id] = notes.created;
    assert.ok(id !== undefined);
    const [target] = module.retryTargets(recordsOf(runs));
    assert.ok(target !== undefined);
    [expected] = module.retryJobs([target]);
    // not from a TikTok page carrying the extension's id (what DramaFetch injects into a TikTok tab carries it) nor another extension
    assert.deepEqual(page.message({ type: "dramafetch:retry", notificationId: id }, { id: "dramafetch-test-id", url: "https://www.tiktok.com/@invented_viewer", tab: /** @type {chrome.tabs.Tab} */ ({ id: 42, index: 0, windowId: 1, active: true }) }), []);
    assert.deepEqual(page.message({ type: "dramafetch:retry", notificationId: id }, "another-extension"), []);
    assert.deepEqual(page.message({ type: "dramafetch:retry", notificationId: `dramafetch-alert:another-page:3:${OTHER_ID}:retry` }, WORKER), []);
    assert.deepEqual(notes.cleared, []);
    page.hold(); // the job's tabs.getCurrent never answers: it runs, and makes no request
    assert.deepEqual(page.message({ type: "dramafetch:retry", notificationId: id }, WORKER), [{ ok: true, queued: true, tabId: 1 }]);
    await page.turn();
    assert.equal(element("progress-current").textContent, expected?.label);
    assert.equal(expected?.label, `Retry 3 of Drama 2399`);
    assert.deepEqual(expected?.numbers, [3, 7, 12]);
    assert.deepEqual(waitingRows(page), []); // one job, running
    assert.deepEqual(notes.cleared, [id]);
    assert.deepEqual(await notes.api.getAll(), {});
    assert.equal(module.alerts.retryOf(id), null);
    // a second press: this page holds it no more (the worker then only brings the tab forward)
    assert.deepEqual(page.message({ type: "dramafetch:retry", notificationId: id }, WORKER), []);
    await page.turn();
    assert.deepEqual(waitingRows(page), []);
    // the tab's own Retry over the same run's records while that retry runs: its episodes are held
    // already — nothing queued twice (DramaFetch 1.8.0), the button spent, and the status line says so
    module.renderFailed(recordsOf(runs));
    element("retry-button").fire("click");
    await page.turn();
    assert.deepEqual(waitingRows(page), []);
    assert.equal(element("retry-button").disabled, true);
    assert.equal(element("input-status").textContent, "Already queued — not queued twice.");
  } finally {
    page.restore();
  }
  // the tab's own Retry over the same run's records, where no retry holds them, queues the very same job
  const tab = await fakePage({ storage: NO_AUTO_RETRY });
  try {
    tab.hold();
    tab.module.renderFailed(recordsOf(runs));
    tab.element("retry-button").fire("click");
    await tab.turn();
    assert.equal(tab.element("progress-current").textContent, expected?.label);
    assert.deepEqual(
      tab.module.queuedJobs().map(({ id: _id, ...queued }) => queued),
      [expected],
    );
  } finally {
    tab.restore();
  }
  // a cooldown in force: the gate of the tab's Retry button
  const now = Date.now() / 1000;
  const cooled = await fakePage({ storage: { cooldown: { until: now + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: now } } });
  try {
    const { element, module } = cooled;
    const notes = fakeNotifications();
    const job = { ...BATCH_JOB, id: 4, refs: [refOf(OTHER_ID)] };
    const { engine } = scriptedEngine(cooled, job, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
    await runBatch(engine, job.refs);
    const [id] = notes.created;
    assert.ok(id !== undefined);
    assert.equal(element("cooldown-banner").hidden, false);
    assert.deepEqual(cooled.message({ type: "dramafetch:retry", notificationId: id }, WORKER), [{ ok: true, queued: false, tabId: 1 }]);
    await cooled.turn();
    assert.equal(element("app-status").dataset["state"], "idle");
    assert.deepEqual(waitingRows(cooled), []);
    assert.deepEqual(notes.cleared, []); // not taken away: nothing was queued (the tab's own Retry once the wait is over)
    assert.notEqual(module.alerts.retryOf(id), null);
  } finally {
    cooled.restore();
  }
});

test("the alert of a batch TikTok stopped with a 429: ⚠ for the drama it stopped in — its stopped episodes retryable, the stop's reason the context —, and at the job's end ONE more: DramaFetch stopped, how many dramas were never started — those of the jobs the stop took out of the queue counted too; Stop in the middle of a batch counts the dramas after the one it ran; a Retry that stops says so for the download jobs it took out of the queue", async () => {
  const page = await fakePage();
  try {
    const { module } = page;
    const notes = fakeNotifications();
    const THIRD_ID = "7699393770256782388";
    const job = { ...BATCH_JOB, id: 5, refs: [refOf(SERIES_ID), refOf(OTHER_ID), refOf(THIRD_ID)] };
    const { engine, jobRecord } = scriptedEngine(page, job, { statuses: { [`${OTHER_ID}:2`]: "failed-rate-limited" } });
    const runs = await runBatch(engine, job.refs);
    assert.deepEqual(runs.map((run) => run.errorKind), [null, null, "not-started"]);
    const stopping = /** @type {import("../src/app/engine.js").SeriesRun} */ (runs.find((run) => run.stop));
    const stop = stopping.report.stopped || stopping.error || "stopped";
    assert.equal(stop, "episode 2 failed-rate-limited");
    const page5 = `dramafetch-alert:${module.alerts.page}:5`;
    assert.deepEqual(notes.created, [`${page5}:${SERIES_ID}:complete`, `${page5}:${OTHER_ID}:retry`]); // nothing for the drama never started
    assert.deepEqual(notes.shown.get(`${page5}:${OTHER_ID}:retry`), {
      type: "basic",
      iconUrl: ALERT_ICON_URL,
      title: "⚠ Drama 2399 — 2 episodes to retry",
      message: "E02, E03 did not download.",
      contextMessage: "episode 2 failed-rate-limited",
      priority: 0,
      requireInteraction: false,
      silent: false,
      buttons: [{ title: "Retry" }],
    });
    assert.deepEqual(module.alerts.retryOf(`${page5}:${OTHER_ID}:retry`)?.numbers, [2, 3]);
    // the job's end: one more, and a batch the stop took out of the queue counts its dramas too
    assert.equal(job.contacted, true); // it made requests (the page's own `persist` noted them)
    const waiting = { kind: /** @type {const} */ ("batch"), refs: [refOf("7699393770256782366"), refOf(THIRD_ID)] };
    module.alertJobEnd(job, stop, runs, jobRecord, [waiting]);
    assert.deepEqual(notes.created.at(-1), `${page5}:stopped`);
    assert.deepEqual(notes.shown.get(`${page5}:stopped`), {
      type: "basic",
      iconUrl: ALERT_ICON_URL,
      title: "DramaFetch stopped: episode 2 failed-rate-limited",
      message: "2 dramas were not started — download them again later",
      priority: 0,
      requireInteraction: false,
      silent: false,
    });
    // Stop pressed while the second drama of three runs (as its episode 2 downloads): the batch
    // throws — no runs, no rows kept for that drama, so no alert of its own —; the hooks counted the
    // dramas it began, and the third never was
    notes.created.length = 0;
    const stopJob = { ...BATCH_JOB, id: 6, refs: job.refs };
    const pressed = scriptedEngine(page, stopJob, {
      onDownload: (ep) => {
        if (ep.seriesId === OTHER_ID && ep.number === 2) page.element("stop-button").fire("click");
      },
    });
    await assert.rejects(runBatch(pressed.engine, stopJob.refs), StopRequested);
    assert.equal(pressed.jobRecord.begun, 2);
    module.alertJobEnd(stopJob, "stopped by you", null, pressed.jobRecord, []);
    const page6 = `dramafetch-alert:${module.alerts.page}:6`;
    assert.deepEqual(notes.created, [`${page6}:${SERIES_ID}:complete`, `${page6}:stopped`]);
    assert.equal(notes.shown.get(`${page6}:stopped`)?.["title"], "DramaFetch stopped: stopped by you");
    assert.equal(notes.shown.get(`${page6}:stopped`)?.["message"], "1 drama was not started — download it again later");
    // nothing when no drama was left unstarted, when the job asked TikTok for nothing (refused at
    // its gate), or for a Retry that ended before its run (Stop) when its stop cancelled nothing:
    // its own drama gets its own alert, never a count
    notes.created.length = 0;
    module.alertJobEnd({ ...job, id: 8 }, "stopped by you", null, { begun: 3 }, []);
    module.alertJobEnd({ ...job, id: 9, contacted: false }, "cooldown until 12:30", null, {}, [waiting]);
    module.alertJobEnd({ id: 10, kind: "selection", refs: [refOf(SERIES_ID)], contacted: true }, LIST_RATE_LIMIT_MESSAGE, null, {}, []);
    assert.deepEqual(notes.created, []);
    // ... but the download jobs a Retry's stop took out of the queue are said, as a batch's would
    // be (an alert's Retry may wait behind one): their dramas only
    module.alertJobEnd({ id: 11, kind: "selection", refs: [refOf(SERIES_ID)], contacted: true }, LIST_RATE_LIMIT_MESSAGE, null, {}, [waiting]);
    assert.deepEqual(notes.created, [`dramafetch-alert:${module.alerts.page}:11:stopped`]);
    assert.deepEqual(notes.shown.get(`dramafetch-alert:${module.alerts.page}:11:stopped`), {
      type: "basic",
      iconUrl: ALERT_ICON_URL,
      title: `DramaFetch stopped: ${LIST_RATE_LIMIT_MESSAGE}`,
      message: "2 dramas were not started — download them again later",
      priority: 0,
      requireInteraction: false,
      silent: false,
    });
  } finally {
    page.restore();
  }
});

test("the alert of a batch Stop ended before a drama's downloads began — in the rest before it, the long break, or while its list was read —: that drama counts among those never started, as every one after it does; the drama done before keeps its own alert", async () => {
  const THIRD_ID = "7699393770256782388";
  for (const when of /** @type {const} */ (["series-rest", "long-rest", "listing"])) {
    for (const count of [2, 3]) {
      const page = await fakePage();
      try {
        const { module } = page;
        const notes = fakeNotifications();
        const job = { ...BATCH_JOB, id: 12, refs: [refOf(SERIES_ID), refOf(OTHER_ID), refOf(THIRD_ID)].slice(0, count) };
        const { engine, jobRecord } = scriptedEngine(page, job);
        // the long break due right after the first drama's three downloads (one every 100 of a run)
        if (when === "long-rest") engine.pacingState.runAttempts = 97;
        /** Stop pressed: the page's own button, then the pause or the listing it caught ends so */
        const press = () => {
          page.element("stop-button").fire("click");
          return new StopRequested();
        };
        if (when === "listing") {
          const list = engine.discover;
          engine.discover = async (ref) => {
            if (ref.seriesId === OTHER_ID) throw press();
            return list(ref);
          };
        } else {
          const sleep = engine.sleep;
          engine.sleep = async (seconds) => {
            if (jobRecord.pauses.at(-1)?.kind === when) throw press();
            return sleep(seconds);
          };
        }
        await assert.rejects(runBatch(engine, job.refs), StopRequested);
        const label = `${when}, ${count} dramas`;
        if (when !== "listing") assert.equal(jobRecord.pauses.at(-1)?.kind, when, label);
        assert.equal(job.contacted, true, label); // the first drama downloaded
        assert.equal(jobRecord.begun, 1, label); // the second drama's downloads never began
        module.alertJobEnd(job, "stopped by you", null, jobRecord, []);
        const id = `dramafetch-alert:${module.alerts.page}:12`;
        assert.deepEqual(notes.created, [`${id}:${SERIES_ID}:complete`, `${id}:stopped`], label);
        assert.equal(notes.shown.get(`${id}:stopped`)?.["title"], "DramaFetch stopped: stopped by you", label);
        assert.equal(
          notes.shown.get(`${id}:stopped`)?.["message"],
          count === 2 ? "1 drama was not started — download it again later" : "2 dramas were not started — download them again later",
          label,
        );
      } finally {
        page.restore();
      }
    }
  }
});

test("the alert setting: Alert me when a drama finishes, on by default, saved with the settings; off, no notification at all — not for a drama, not for a stopped batch", async () => {
  const page = await fakePage();
  try {
    const { element, module, local } = page;
    assert.equal(element("setting-alerts").checked, true);
    element("setting-alerts").checked = false;
    element("settings-form").fire("submit");
    for (let turns = 0; turns < 20 && element("settings-status").className !== "status ok"; turns += 1) await page.turn();
    assert.equal(/** @type {Record<string, unknown>} */ (local.get("settings"))["alerts"], false);
    const notes = fakeNotifications();
    const job = { ...BATCH_JOB, id: 2, refs: [refOf(SERIES_ID), refOf(OTHER_ID), refOf("7699393770256782388")] };
    const { engine, jobRecord } = scriptedEngine(page, job, { statuses: { [`${OTHER_ID}:2`]: "failed-rate-limited" } });
    const runs = await runBatch(engine, job.refs);
    module.alertJobEnd(job, "episode 2 failed-rate-limited", runs, jobRecord, []);
    assert.deepEqual(notes.created, []);
  } finally {
    page.restore();
  }
  const off = await fakePage({ storage: { settings: { alerts: false } } });
  try {
    assert.equal(off.element("setting-alerts").checked, false);
  } finally {
    off.restore();
  }
});

test("the alert: nothing for a drama skipped as complete (no request), nothing for a batch refused at its gate; a batch whose drama's list cannot be read while another batch and an alert's Retry wait behind it says once how many dramas its stop left unstarted, beside that drama's own; each job run to its end through the page's own queue", async () => {
  // a drama found complete less than 24 hours ago, every file still there: skipped, no request
  let page = await fakePage();
  try {
    const notes = fakeNotifications();
    const job = { ...BATCH_JOB, id: 1, refs: [refOf(SERIES_ID)] };
    const { engine, states } = scriptedEngine(page, job);
    const state = newState(SERIES_ID, "Drama 2354");
    for (const number of [1, 2, 3]) record(state, { episode: { number, itemId: `i${number}` }, status: "done", path: `/dl/E${number}.mp4`, message: "saved", downloadId: number }, { exists: () => true, now: 1_800_000_000 });
    markComplete(state, 1_800_000_000 - 60, 3);
    states.set(SERIES_ID, JSON.parse(JSON.stringify(state)));
    const [run] = await runBatch(engine, job.refs);
    assert.equal(run?.report.skippedComplete, true);
    assert.equal(run?.contacted, false);
    assert.deepEqual(notes.created, []);
  } finally {
    page.restore();
  }
  // a batch whose one drama's list cannot be read here (no tab can open: a stop) while another batch
  // and an alert's Retry wait behind it: both are cancelled, and ONE alert says how many dramas its
  // stop left unstarted — the retry's among them —, beside the stopped drama's own (the earlier
  // batch's plain failure keeps its ⚠ alert: the automatic retry off)
  page = await fakePage({ testSettings: QUICK, storage: NO_AUTO_RETRY });
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    // a ⚠ alert this page holds: a drama of an earlier batch whose episode 2 did not download
    const THIRD_ID = "7699393770256782388";
    const earlier = { ...BATCH_JOB, id: 90, refs: [refOf(THIRD_ID)] };
    await runBatch(scriptedEngine(page, earlier, { statuses: { [`${THIRD_ID}:2`]: "failed" } }).engine, earlier.refs);
    const [retryAlert] = notes.created;
    assert.equal(retryAlert, `dramafetch-alert:${module.alerts.page}:90:${THIRD_ID}:retry`);
    const journal = () => page.module.journal();
    const open = gateJobs();
    assert.equal(paste(page, SERIES_ID), true); // job 1, started: held at its gate
    await page.turn();
    assert.equal(paste(page, OTHER_ID), true); // job 2, a download waiting behind it
    // the alert's Retry, pressed meanwhile: queued behind them, the alert taken away
    assert.deepEqual(page.message({ type: "dramafetch:retry", notificationId: retryAlert }, WORKER), [{ ok: true, queued: true, tabId: 1 }]);
    assert.deepEqual(notes.cleared, [retryAlert]);
    open(); // job 1's list cannot be read: a stop, which takes both out of the queue
    for (let turn = 0; turn < 1000 && (journal().length < 3 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    const notStarted = `not started: batch stopped in ${SERIES_ID} (the episode list could not be fetched)`;
    assert.deepEqual(journal().slice(0, 3).map((entry) => [entry["kind"], entry["stopped"], entry["error"]]), [
      ["batch", "the episode list could not be fetched", null],
      ["selection", null, notStarted],
      ["batch", null, notStarted],
    ]);
    assert.equal(journal()[1]?.["label"], "Retry 1 of Drama 2388");
    const job1 = `dramafetch-alert:${module.alerts.page}:1`;
    assert.deepEqual(notes.created, [retryAlert, `${job1}:${SERIES_ID}:incomplete`, `${job1}:stopped`]);
    assert.equal(notes.shown.get(`${job1}:stopped`)?.["title"], "DramaFetch stopped: the episode list could not be fetched");
    assert.equal(notes.shown.get(`${job1}:stopped`)?.["message"], "2 dramas were not started — download them again later");
    assert.equal(notes.shown.get(`${job1}:stopped`)?.["buttons"], undefined);
  } finally {
    await clearCooldown(pageCooldownStore());
    page.restore();
  }
  // a batch refused at its gate (a cooldown in force) with another waiting behind it — two series
  // handed over (a paste is refused before any job during a cooldown): no request, nothing said
  const now = Date.now() / 1000;
  page = await fakePage({ storage: { cooldown: { until: now + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: now } }, testSettings: QUICK });
  try {
    const { element } = page;
    const notes = fakeNotifications();
    page.message({ type: "dramafetch:load", input: SERIES_ID });
    page.message({ type: "dramafetch:load", input: OTHER_ID }); // the second waits behind the first
    const journal = () => page.module.journal();
    for (let turn = 0; turn < 500 && (journal().length < 2 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    assert.ok(String(journal()[0]?.["error"]).startsWith("TikTok refused a request at ")); // the job refused at its gate
    assert.ok(String(journal()[1]?.["error"]).startsWith(`not started: batch stopped in Series ${SERIES_ID} (TikTok refused a request at `)); // the one behind it
    assert.deepEqual(notes.created, []);
  } finally {
    page.restore();
  }
});

test("the alert of a batch run through the page's own queue to its end: the drama whose list could not be read says it is not complete — the error the tab shows —, the batch stopped there, and ONE more says how many dramas were never started", async () => {
  const page = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    assert.equal(paste(page, `${SERIES_ID}\n${OTHER_ID}\n7699393770256782388`), true); // the discovery can open no tab here: no request at all
    const journal = () => page.module.journal();
    for (let turn = 0; turn < 500 && (journal().length < 1 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    const [entry] = journal();
    assert.equal(entry?.["stopped"], "the episode list could not be fetched");
    const job = `dramafetch-alert:${module.alerts.page}:1`;
    assert.deepEqual(notes.created, [`${job}:${SERIES_ID}:incomplete`, `${job}:stopped`]);
    assert.deepEqual(notes.shown.get(`${job}:${SERIES_ID}:incomplete`)?.["title"], `${SERIES_ID} — not complete`);
    assert.match(String(notes.shown.get(`${job}:${SERIES_ID}:incomplete`)?.["message"]), /^could not list the series: /);
    assert.equal(notes.shown.get(`${job}:${SERIES_ID}:incomplete`)?.["buttons"], undefined);
    assert.deepEqual(notes.shown.get(`${job}:stopped`)?.["title"], "DramaFetch stopped: the episode list could not be fetched");
    assert.deepEqual(notes.shown.get(`${job}:stopped`)?.["message"], "2 dramas were not started — download them again later");
    // a selection job — the tab's Retry here — has its drama's alert at its end too; one drama, no
    // other job waiting: nothing more
    notes.created.length = 0;
    module.renderFailed([seriesRecord(OTHER_ID, "Two", [[1, "done"], [2, "failed"]])]);
    element("retry-button").fire("click");
    for (let turn = 0; turn < 500 && (journal().length < 2 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    assert.equal(journal()[0]?.["kind"], "selection");
    assert.deepEqual(notes.created, [`dramafetch-alert:${module.alerts.page}:2:${OTHER_ID}:incomplete`]);
  } finally {
    page.restore();
  }
});

test("the alert in Spanish under a Spanish Chrome: the titles, the messages, the button and the engine's words as the tab shows them", async () => {
  const page = await fakePage({ language: "es" });
  try {
    const { module } = page;
    const notes = fakeNotifications();
    const job = { ...BATCH_JOB, id: 2, refs: [refOf(SERIES_ID), refOf(OTHER_ID), refOf("7699393770256782388")] };
    const { engine, jobRecord } = scriptedEngine(page, job, { episodes: 4, locked: { [SERIES_ID]: [4] }, statuses: { [`${OTHER_ID}:2`]: "failed-rate-limited" } });
    const runs = await runBatch(engine, job.refs);
    module.alertJobEnd(job, "episode 2 failed-rate-limited", runs, jobRecord, []);
    const texts = [...notes.shown.values()].map((shown) => [shown["title"], shown["message"], shown["contextMessage"], shown["buttons"]]);
    assert.deepEqual(texts, [
      ["✓ Drama 2354 — descargado", "Los 3 episodios están en el disco — 1 bloqueado (4).", undefined, undefined],
      ["⚠ Drama 2399 — 3 episodios por reintentar", "E02, E03, E04 no se descargaron.", "episodio 2 (limitado por TikTok)", [{ title: "Reintentar" }]],
      ["DramaFetch se detuvo: episodio 2 (limitado por TikTok)", "1 drama no se inició: descárgalo de nuevo más tarde", undefined, undefined],
    ]);
  } finally {
    page.restore();
  }
});

test("a notification Chrome refuses — a throw, a rejected promise, an answer that never comes, no API at all (a copy without the permission) — never breaks or slows a job: the batch ends as it would, its journal entry and failed block the same", async () => {
  const warn = console.warn;
  console.warn = () => undefined; // the page notes each refusal; not this test's output
  try {
    /** @type {unknown[]} */
    const entries = [];
    for (const refuse of /** @type {const} */ (["throw", "reject", "hang", "missing", "none"])) {
      const page = await fakePage({ testSettings: QUICK, storage: NO_AUTO_RETRY }); // the ⚠ alert's retry kept or not: the automatic retry off
      try {
        const { element, module } = page;
        const notes = refuse === "missing" ? null : fakeNotifications(refuse === "none" ? {} : { refuse });
        // a whole job through the queue: it ends, as it would
        assert.equal(paste(page, `${SERIES_ID}\n${OTHER_ID}`), true, refuse);
        const journal = () => page.module.journal();
        for (let turn = 0; turn < 500 && (journal().length < 1 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
        assert.equal(element("app-status").dataset["state"], "idle", refuse);
        const [entry] = journal();
        assert.ok(entry !== undefined, refuse);
        entries.push({ ...entry, id: null, started_at: null, finished_at: null });
        if (notes !== null) assert.equal(notes.created.length, 2, refuse); // asked for all the same: the drama, the stop
        // the hooks themselves, over a drama with a failure: nothing thrown out of them, and the
        // retry of an alert Chrome refused is not kept
        const job = { ...BATCH_JOB, id: 9, refs: [refOf(OTHER_ID)] };
        const { engine } = scriptedEngine(page, job, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
        const runs = await runBatch(engine, job.refs);
        await page.turn();
        assert.equal(runs.length, 1, refuse);
        const kept = module.alerts.retryOf(`dramafetch-alert:${module.alerts.page}:9:${OTHER_ID}:retry`);
        assert.deepEqual(kept, refuse === "hang" || refuse === "none" ? module.retryTargets(recordsOf(runs))[0] : null, refuse);
      } finally {
        page.restore();
      }
    }
    for (const entry of entries.slice(1)) assert.deepEqual(entry, entries[0]);
  } finally {
    console.warn = warn;
  }
});

// ------------------------------------------ the automatic retry of what did not download (1.8.0)

/** The fake TikTok's third and fourth series, as these tests name them. */
const THIRD_ID = "7699393770256782388";
const FOURTH_ID = "7699393770256782377";

/**
 * Every job of the page waits at its `chrome.tabs.getCurrent` until the test opens the gate: a job
 * queued meanwhile starts and waits there, asking nothing of anything; once open, jobs run on (and
 * `page.hold()` still holds them).
 * @returns {() => void} what opens the gate
 */
function gateJobs() {
  const tabs = /** @type {{getCurrent: () => Promise<unknown>}} */ (/** @type {unknown} */ (globalThis.chrome.tabs));
  const answer = tabs.getCurrent;
  /** @type {(value?: unknown) => void} */
  let open = () => undefined;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  tabs.getCurrent = () => opened.then(() => answer());
  return () => open();
}

/**
 * The page's jobs as the unit tests compare them: their ids left out (the queue numbers them).
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 */
const jobsOf = (page) => page.module.queuedJobs().map(({ id: _id, ...job }) => job);

/**
 * A batch of one drama — `OTHER_ID` unless `seriesId` names another — (job `id`) run through the
 * page's own hooks, the page held (a job it queues starts and waits, asking nothing): returns what
 * its engine kept. `ready` gets the engine before the batch runs.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {number} id
 * @param {Parameters<typeof scriptedEngine>[2]} [options]
 * @param {(engine: import("../src/app/engine.js").Engine) => void} [ready]
 * @param {string} [seriesId]
 */
async function batchOfOther(page, id, options = {}, ready = () => undefined, seriesId = OTHER_ID) {
  const job = { ...BATCH_JOB, id, refs: [refOf(seriesId)] };
  const scripted = scriptedEngine(page, job, options);
  ready(scripted.engine);
  const runs = await runBatch(scripted.engine, job.refs);
  await page.turn(); // a job it queued is started (and held)
  return { ...scripted, job, runs };
}

test("the automatic retry (1.8.0): a drama of a batch done with plain failures — a cut transfer, a file that failed its check — queues ONE retry of exactly those episodes at the END of the queue, as its alert's Retry would — a selection job, includeLocked false, its label, its alert's id — and says “retrying” instead of ⚠: no button, no retry kept; a short-served, locked or stopped row is never taken", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    page.hold(); // every job stays at its tabs.getCurrent: it runs, and makes no request
    assert.equal(paste(page, SERIES_ID), true); // running
    assert.equal(paste(page, THIRD_ID), true); // waiting
    const job = { ...BATCH_JOB, id: 7, refs: [refOf(SERIES_ID), refOf(OTHER_ID)] };
    const { engine, jobRecord } = scriptedEngine(page, job, { episodes: 12, statuses: { [`${OTHER_ID}:3`]: "failed", [`${OTHER_ID}:7`]: "failed-unavailable", [`${OTHER_ID}:12`]: "failed" } });
    const runs = await runBatch(engine, job.refs);
    await page.turn();
    assert.deepEqual(runs.map((run) => [run.report.complete, run.stop]), [[true, false], [false, false]]);
    const page7 = `dramafetch-alert:${module.alerts.page}:7`;
    const alertId = `${page7}:${OTHER_ID}:retry`; // the ⚠ alert's own id
    // after the job running and the one waiting: ONE automatic retry of E03 and E12, never E07
    assert.deepEqual(jobsOf(page).slice(0, 2).map((queued) => [queued.kind, queued.label]), [["batch", `Series ${SERIES_ID}`], ["batch", `Series ${THIRD_ID}`]]);
    assert.deepEqual(jobsOf(page).slice(2), [
      {
        kind: "selection",
        label: "Automatic retry: 2 of Drama 2399",
        refs: [refOf(OTHER_ID)],
        numbers: [3, 12],
        includeLocked: false,
        recheck: false,
        autoRetry: { alertId, name: "Drama 2399" },
      },
    ]);
    // exactly the job the alert's Retry would have queued, but for its label and its alert's id
    const [manual] = module.retryJobs([{ seriesId: OTHER_ID, name: "Drama 2399", numbers: [3, 12] }]);
    const { label: _label, autoRetry: _auto, ...same } = /** @type {Omit<import("../src/app/app.js").Job, "id">} */ (jobsOf(page)[2]);
    assert.deepEqual({ ...same, label: manual?.label }, manual);
    // the running paste's drama (never begun: held) by the name a run of this page read, the one waiting, the retry
    assert.deepEqual(waitingRows(page), [dramaRow(SERIES_ID, "Drama 2354"), dramaRow(THIRD_ID), whatRow("Automatic retry E03, E12", OTHER_ID, "Drama 2399")]);
    assert.deepEqual(jobRecord.autoRetried, [alertId]);
    // the alerts: ✓ for the complete one; “retrying” in place of ⚠ — no button, nothing kept behind it
    assert.deepEqual(notes.created, [`${page7}:${SERIES_ID}:complete`, alertId]);
    assert.deepEqual(notes.shown.get(alertId), {
      type: "basic",
      iconUrl: ALERT_ICON_URL,
      title: "↻ Drama 2399 — retrying 2 episodes",
      message: "E03, E12 did not download — DramaFetch tries them once more on its own.",
      priority: 0,
      requireInteraction: false,
      silent: false,
    });
    assert.equal(module.alerts.retryOf(alertId), null);
    // the tab's own Retry would take E07 too (failed-unavailable): left to the user
    assert.deepEqual(module.retryTargets(recordsOf(runs))[0]?.numbers, [3, 7, 12]);
    assert.equal(element("app-status").dataset["state"], "running");
  } finally {
    page.restore();
  }
  // a `failed` row a stop left (`stopped: …`) and a locked one are never taken, only the plain failure
  const other = await fakePage();
  try {
    const notes = fakeNotifications();
    other.hold();
    const job = { ...BATCH_JOB, id: 5, refs: [refOf(SERIES_ID)] };
    other.module.dramaDone(job, finishedRun(SERIES_ID, "Test Series", reportRows()), {});
    await other.turn();
    assert.deepEqual(jobsOf(other).map((queued) => [queued.label, queued.numbers]), [["Automatic retry: 1 of Test Series", [2]]]);
    assert.equal(notes.shown.get(`dramafetch-alert:${other.module.alerts.page}:5:${SERIES_ID}:retry`)?.["message"], "E02 did not download — DramaFetch tries it once more on its own.");
  } finally {
    other.restore();
  }
});

test("no automatic retry — the 1.7.0 ⚠ alert with its Retry instead — when the setting is off, when the only failures are short-served or DRM, when the run stopped (a 429, three failures in a row, a cooldown met before an episode: never a retry after a stop) or when a cooldown is in force", async () => {
  const now = Date.now() / 1000;
  const cooldown = { until: now + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: now };
  /**
   * @type {{label: string, storage?: Record<string, unknown>, episodes?: number, statuses: Record<string, string>, coolAfter?: number, title: string, message: string, numbers: number[], context?: (text: unknown) => boolean}[]}
   */
  const cases = [
    { label: "the setting off", storage: NO_AUTO_RETRY, statuses: { [`${OTHER_ID}:2`]: "failed" }, title: "⚠ Drama 2399 — 1 episode to retry", message: "E02 did not download.", numbers: [2] },
    { label: "short-served or DRM only", statuses: { [`${OTHER_ID}:2`]: "failed-unavailable" }, title: "⚠ Drama 2399 — 1 episode to retry", message: "E02 did not download.", numbers: [2] },
    {
      label: "a 429 after a plain failure",
      statuses: { [`${OTHER_ID}:1`]: "failed", [`${OTHER_ID}:2`]: "failed-rate-limited" },
      title: "⚠ Drama 2399 — 3 episodes to retry",
      message: "E01, E02, E03 did not download.",
      numbers: [1, 2, 3],
      context: (text) => text === "episode 2 failed-rate-limited",
    },
    {
      label: "three failures in a row",
      episodes: 4,
      statuses: { [`${OTHER_ID}:1`]: "failed", [`${OTHER_ID}:2`]: "failed", [`${OTHER_ID}:3`]: "failed" },
      title: "⚠ Drama 2399 — 4 episodes to retry",
      message: "E01, E02, E03, E04 did not download.",
      numbers: [1, 2, 3, 4],
      context: (text) => text === "3 consecutive failures",
    },
    {
      label: "a cooldown met before an episode",
      statuses: { [`${OTHER_ID}:1`]: "failed" },
      coolAfter: 1,
      title: "⚠ Drama 2399 — 3 episodes to retry",
      message: "E01, E02, E03 did not download.",
      numbers: [1, 2, 3],
      context: (text) => /^cooldown until \d\d:\d\d$/.test(String(text)),
    },
    { label: "a cooldown in force", storage: { cooldown }, statuses: { [`${OTHER_ID}:2`]: "failed" }, title: "⚠ Drama 2399 — 1 episode to retry", message: "E02 did not download.", numbers: [2] },
  ];
  for (const item of cases) {
    const page = await fakePage(item.storage === undefined ? {} : { storage: item.storage });
    try {
      const { module } = page;
      const notes = fakeNotifications();
      page.hold();
      /** @type {import("../src/app/engine.js").Engine | null} */
      let used = null;
      const coolAfter = item.coolAfter;
      const { runs } = await batchOfOther(
        page,
        4,
        {
          ...(item.episodes === undefined ? {} : { episodes: item.episodes }),
          statuses: item.statuses,
          // TikTok refused a request elsewhere meanwhile: recorded as this episode is asked for
          ...(coolAfter === undefined ? {} : { onDownload: (ep) => void (ep.number === coolAfter && used !== null && recordBlock(used.cooldownStore, MEDIA_RATE_LIMIT_MESSAGE, "browser", { now: used.wallClock() })) }),
        },
        (engine) => {
          used = engine;
        },
      );
      assert.equal(runs.length, 1, item.label);
      assert.equal(runs[0]?.stop, item.context !== undefined, item.label); // the stopped cases stopped
      assert.deepEqual(jobsOf(page), [], item.label); // nothing queued
      const id = `dramafetch-alert:${module.alerts.page}:4:${OTHER_ID}:retry`;
      assert.deepEqual(notes.created, [id], item.label);
      const shown = notes.shown.get(id);
      assert.equal(shown?.["title"], item.title, item.label);
      assert.equal(shown?.["message"], item.message, item.label);
      assert.deepEqual(shown?.["buttons"], [{ title: "Retry" }], item.label);
      if (item.context === undefined) assert.equal(shown?.["contextMessage"], undefined, item.label);
      else assert.ok(item.context(shown?.["contextMessage"]), `${item.label}: ${String(shown?.["contextMessage"])}`);
      assert.deepEqual(module.alerts.retryOf(id)?.numbers, item.numbers, item.label);
    } finally {
      page.restore();
    }
  }
});

test("the automatic retry is not behind the alert setting: alerts off, it is queued all the same, and nothing is shown", async () => {
  const page = await fakePage({ storage: { settings: { alerts: false } } });
  try {
    const notes = fakeNotifications();
    page.hold();
    await batchOfOther(page, 4, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
    assert.deepEqual(jobsOf(page).map((queued) => [queued.label, queued.numbers, queued.autoRetry?.alertId]), [["Automatic retry: 1 of Drama 2399", [2], `dramafetch-alert:${page.module.alerts.page}:4:${OTHER_ID}:retry`]]);
    assert.deepEqual(notes.created, []);
  } finally {
    page.restore();
  }
});

test("a selection job's drama the same (1.8.0): a retry the user asked for (the progress card's Retry) — its plain failures get their one automatic retry, queued behind it; the selection job itself, running, holds its episodes no more", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    page.hold();
    // a job that ended with E02 and E04 not downloaded: its Did not download block and its Retry
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "failed"], [3, "done"], [4, "failed"]])]);
    element("retry-button").fire("click"); // the progress card's Retry: the selection job of E02 and E04, running
    await page.turn();
    const [running] = module.queuedJobs();
    assert.ok(running !== undefined && running.kind === "selection");
    assert.deepEqual(running.numbers, [2, 4]);
    // its run, as runJob gets it (listed again, then the downloads): E02 fails again, plain
    const scripted = scriptedEngine(page, running, { episodes: 4, statuses: { [`${OTHER_ID}:2`]: "failed" } });
    const run = await runSelectionJob(scripted.engine, refOf(OTHER_ID), running.numbers, { lastContactAt: null });
    assert.deepEqual(run.results.map((result) => [result.episode.number, result.status]), [[2, "failed"], [4, "done"]]);
    module.dramaDone(running, run, scripted.jobRecord); // where runJob makes the drama's alert
    await page.turn();
    const alertId = `dramafetch-alert:${module.alerts.page}:${running.id}:${OTHER_ID}:retry`;
    assert.deepEqual(jobsOf(page).slice(1), [
      { kind: "selection", label: "Automatic retry: 1 of Drama 2399", refs: [refOf(OTHER_ID)], numbers: [2], includeLocked: false, recheck: false, autoRetry: { alertId, name: "Drama 2399" } },
    ]);
    assert.deepEqual(notes.created, [alertId]);
    assert.equal(notes.shown.get(alertId)?.["title"], "↻ Drama 2399 — retrying 1 episode");
    assert.equal(notes.shown.get(alertId)?.["buttons"], undefined);
  } finally {
    page.restore();
  }
});

test("what came of the automatic retry (1.8.0): its drama's alert under the id of “retrying” — Chrome replaces it —, `After an automatic retry.` its context: ✓ once its episodes are on disk, ⚠ with its Retry when one still did not download, the stop's reason when it stopped; never a second automatic retry", async () => {
  const page = await fakePage();
  try {
    const { module } = page;
    const notes = fakeNotifications();
    page.hold();
    const first = await batchOfOther(page, 7, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
    const [auto] = module.queuedJobs(); // started, held
    assert.ok(auto?.autoRetry !== undefined);
    const alertId = auto.autoRetry.alertId;
    assert.equal(alertId, `dramafetch-alert:${module.alerts.page}:7:${OTHER_ID}:retry`);
    assert.deepEqual(notes.created, [alertId]);
    /**
     * The automatic retry's own run, as runJob gets it: the series listed again, `statuses` its
     * downloads, the records the batch left (E01 and E03 on disk); then its drama's alert.
     * @param {Record<string, string>} statuses
     */
    const retried = async (statuses) => {
      const scripted = scriptedEngine(page, auto, { statuses });
      scripted.states.set(OTHER_ID, first.states.get(OTHER_ID));
      const run = await runSelectionJob(scripted.engine, refOf(OTHER_ID), auto.numbers, { lastContactAt: null });
      module.dramaDone(auto, run, scripted.jobRecord);
      await page.turn();
      return { run, jobRecord: scripted.jobRecord };
    };
    // E02 fails again: ⚠ with its Retry, the same id, the context; nothing more queued
    const again = await retried({ [`${OTHER_ID}:2`]: "failed" });
    assert.equal(again.run.stop, false);
    assert.deepEqual(notes.created, [alertId, alertId]);
    assert.deepEqual(notes.shown.get(alertId), {
      type: "basic",
      iconUrl: ALERT_ICON_URL,
      title: "⚠ Drama 2399 — 1 episode to retry",
      message: "E02 did not download.",
      contextMessage: "After an automatic retry.",
      priority: 0,
      requireInteraction: false,
      silent: false,
      buttons: [{ title: "Retry" }],
    });
    assert.deepEqual(module.alerts.retryOf(alertId), { seriesId: OTHER_ID, name: "Drama 2399", numbers: [2] });
    assert.deepEqual(jobsOf(page).length, 1); // the automatic retry alone: no second round
    assert.equal(again.jobRecord.autoRetried, undefined);
    // its episodes on disk now: ✓, the whole drama, the context; no Retry kept behind it
    await retried({});
    assert.deepEqual(notes.created, [alertId, alertId, alertId]);
    assert.deepEqual(notes.shown.get(alertId), {
      type: "basic",
      iconUrl: ALERT_ICON_URL,
      title: "✓ Drama 2399 — downloaded",
      message: "All 3 episodes are on disk.",
      contextMessage: "After an automatic retry.",
      priority: 0,
      requireInteraction: false,
      silent: false,
    });
    assert.equal(module.alerts.retryOf(alertId), null);
    // a 429 while it retried: the stop's reason as its context, as for any download
    const stopped = await retried({ [`${OTHER_ID}:2`]: "failed-rate-limited" });
    assert.equal(stopped.run.stop, true);
    assert.equal(notes.shown.get(alertId)?.["title"], "⚠ Drama 2399 — 1 episode to retry");
    assert.equal(notes.shown.get(alertId)?.["contextMessage"], "episode 2 failed-rate-limited");
    assert.deepEqual(jobsOf(page).length, 1);
  } finally {
    page.restore();
  }
});

test("no retry is queued twice (1.8.0): the automatic one leaves out the episodes a running or waiting selection job holds — nothing left: none, and the 1.7.0 ⚠ alert —; the progress card's Retry queues only what no retry holds and, with nothing left, says so, spent; an alert's Retry with nothing left answers queued and takes the alert away", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    page.hold();
    // a batch's drama: its automatic retry of E02, running
    await batchOfOther(page, 7, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
    assert.deepEqual(jobsOf(page).map((queued) => queued.label), ["Automatic retry: 1 of Drama 2399"]);
    // the progress card's Retry of E02 and E03 (a job that ended without them): E03 only, waiting behind it
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "failed"], [3, "failed"]])]);
    assert.equal(element("retry-button").disabled, false);
    element("retry-button").fire("click");
    await page.turn();
    assert.deepEqual(jobsOf(page).map((queued) => [queued.label, queued.numbers]), [["Automatic retry: 1 of Drama 2399", [2]], ["Retry 1 of Drama 2399", [3]]]);
    assert.equal(element("retry-button").disabled, true);
    assert.equal(element("input-status").textContent, ""); // something was queued: nothing to say
    // a Retry of the same two again (the block drawn anew, its button new): both held — nothing
    // queued, said, the button spent
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "failed"], [3, "failed"]])]);
    assert.equal(element("retry-button").disabled, false);
    element("retry-button").fire("click");
    await page.turn();
    assert.equal(jobsOf(page).length, 2);
    assert.equal(element("retry-button").disabled, true);
    assert.equal(element("input-status").textContent, "Already queued — not queued twice.");
    // another batch's drama with E02 and E03 failing: both held — no automatic retry, the ⚠ alert
    await batchOfOther(page, 8, { statuses: { [`${OTHER_ID}:2`]: "failed", [`${OTHER_ID}:3`]: "failed" } });
    assert.equal(jobsOf(page).length, 2);
    const warned = `dramafetch-alert:${module.alerts.page}:8:${OTHER_ID}:retry`;
    assert.equal(notes.shown.get(warned)?.["title"], "⚠ Drama 2399 — 2 episodes to retry");
    assert.deepEqual(notes.shown.get(warned)?.["buttons"], [{ title: "Retry" }]);
    // ... whose Retry finds both queued: answered queued, nothing queued twice, the alert taken away
    assert.deepEqual(page.message({ type: "dramafetch:retry", notificationId: warned }, WORKER), [{ ok: true, queued: true, tabId: 1 }]);
    await page.turn();
    assert.equal(jobsOf(page).length, 2);
    assert.deepEqual(notes.cleared, [warned]);
    assert.equal(module.alerts.retryOf(warned), null);
    // a third batch's drama with E02 and E04 failing: its automatic retry takes E04 alone
    await batchOfOther(page, 9, { episodes: 4, statuses: { [`${OTHER_ID}:2`]: "failed", [`${OTHER_ID}:4`]: "failed" } });
    assert.deepEqual(jobsOf(page).map((queued) => [queued.label, queued.numbers]), [
      ["Automatic retry: 1 of Drama 2399", [2]],
      ["Retry 1 of Drama 2399", [3]],
      ["Automatic retry: 1 of Drama 2399", [4]],
    ]);
    assert.equal(notes.shown.get(`dramafetch-alert:${module.alerts.page}:9:${OTHER_ID}:retry`)?.["message"], "E04 did not download — DramaFetch tries it once more on its own.");
    // an episode of the same drama no retry holds is queued
    await batchOfOther(page, 10, { statuses: { [`${OTHER_ID}:1`]: "failed" } });
    assert.deepEqual(jobsOf(page).at(-1)?.numbers, [1]);
    // another drama's episodes are never held by these: Drama 2388's own E02, while Drama 2399's E02
    // is held, gets its automatic retry
    await batchOfOther(page, 11, { statuses: { [`${THIRD_ID}:2`]: "failed" } }, undefined, THIRD_ID);
    assert.deepEqual([jobsOf(page).at(-1)?.label, jobsOf(page).at(-1)?.refs, jobsOf(page).at(-1)?.numbers], ["Automatic retry: 1 of Drama 2388", [refOf(THIRD_ID)], [2]]);
    assert.equal(notes.shown.get(`dramafetch-alert:${module.alerts.page}:11:${THIRD_ID}:retry`)?.["title"], "↻ Drama 2388 — retrying 1 episode");
    // ... and one progress card's Retry over two more dramas that did not download the same
    // episodes queues each its own
    module.renderFailed([seriesRecord(SERIES_ID, "Test Series", [[1, "done"], [2, "failed"], [3, "failed"]]), seriesRecord(FOURTH_ID, "Four", [[2, "failed"], [3, "failed"]])]);
    element("retry-button").fire("click");
    await page.turn();
    assert.deepEqual(jobsOf(page).slice(-2).map((queued) => [queued.label, queued.refs, queued.numbers]), [
      ["Retry 2 of Test Series", [refOf(SERIES_ID)], [2, 3]],
      ["Retry 2 of Four", [refOf(FOURTH_ID)], [2, 3]],
    ]);
  } finally {
    page.restore();
  }
});

test("an automatic retry a later stop takes out of the queue (1.8.0): its drama's ⚠ alert WITH its Retry under the id of “retrying”, `Not retried automatically: <the stop's reason>` — never counted among the dramas the stopped alert says were not started; its journal entry is any cancelled job's; its Retry queues it", async () => {
  const page = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    const journal = () => page.module.journal();
    const open = gateJobs();
    assert.equal(paste(page, `${SERIES_ID}\n${THIRD_ID}`), true); // job 1, started: waits at the gate
    await page.turn();
    // a drama of another download done meanwhile, a plain failure: its automatic retry waits behind
    await batchOfOther(page, 90, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
    assert.equal(paste(page, FOURTH_ID), true); // a download behind it
    assert.deepEqual(jobsOf(page).map((queued) => queued.label), ["2 series", "Automatic retry: 1 of Drama 2399", `Series ${FOURTH_ID}`]);
    const alertId = `dramafetch-alert:${module.alerts.page}:90:${OTHER_ID}:retry`;
    assert.deepEqual(notes.created, [alertId]);
    // job 1 goes on: the discovery can open no tab here — its first list fails, a stop
    open();
    for (let turn = 0; turn < 1000 && (journal().length < 3 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    assert.deepEqual(journal().map((entry) => [entry["kind"], entry["label"]]), [
      ["batch", "2 series"],
      ["batch", `Series ${FOURTH_ID}`],
      ["selection", "Automatic retry: 1 of Drama 2399"],
    ]);
    const stop = "the episode list could not be fetched";
    assert.equal(journal()[0]?.["stopped"], stop);
    assert.ok(String(journal()[2]?.["error"]).startsWith("not started: batch stopped in "), String(journal()[2]?.["error"])); // as any cancelled job
    const job1 = `dramafetch-alert:${module.alerts.page}:1`;
    assert.deepEqual(notes.created, [alertId, `${job1}:${SERIES_ID}:incomplete`, alertId, `${job1}:stopped`]);
    assert.deepEqual(notes.shown.get(alertId), {
      type: "basic",
      iconUrl: ALERT_ICON_URL,
      title: "⚠ Drama 2399 — 1 episode to retry",
      message: "E02 did not download.",
      contextMessage: `Not retried automatically: ${stop}`,
      priority: 0,
      requireInteraction: false,
      silent: false,
      buttons: [{ title: "Retry" }],
    });
    // the stopped alert counts job 1's drama never started and the download behind — not the retry's
    assert.equal(notes.shown.get(`${job1}:stopped`)?.["title"], `DramaFetch stopped: ${stop}`);
    assert.equal(notes.shown.get(`${job1}:stopped`)?.["message"], "2 dramas were not started — download them again later");
    // its Retry queues what the automatic one would have: the job's own episodes
    assert.deepEqual(module.alerts.retryOf(alertId), { seriesId: OTHER_ID, name: "Drama 2399", numbers: [2] });
    page.hold();
    assert.deepEqual(page.message({ type: "dramafetch:retry", notificationId: alertId }, WORKER), [{ ok: true, queued: true, tabId: 1 }]);
    await page.turn();
    assert.deepEqual(jobsOf(page).map((queued) => [queued.label, queued.numbers, queued.autoRetry]), [["Retry 1 of Drama 2399", [2], undefined]]);
    assert.deepEqual(notes.cleared, [alertId]);
  } finally {
    page.restore();
  }
  // only an automatic retry cancelled: the stopped alert counts the job's own dramas never started,
  // as before — here none, so none is shown
  const only = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = only;
    const notes = fakeNotifications();
    const journal = () => only.module.journal();
    const open = gateJobs();
    assert.equal(paste(only, SERIES_ID), true);
    await only.turn();
    await batchOfOther(only, 90, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
    open();
    for (let turn = 0; turn < 1000 && (journal().length < 2 || element("app-status").dataset["state"] !== "idle"); turn += 1) await only.turn();
    const alertId = `dramafetch-alert:${module.alerts.page}:90:${OTHER_ID}:retry`;
    assert.deepEqual(notes.created, [alertId, `dramafetch-alert:${module.alerts.page}:1:${SERIES_ID}:incomplete`, alertId]);
    assert.equal(notes.shown.get(alertId)?.["contextMessage"], "Not retried automatically: the episode list could not be fetched");
  } finally {
    only.restore();
  }
});

test("an automatic retry refused at its own gate (1.8.0) — a cooldown in force when it starts —: no request, its journal entry says why, and its drama's ⚠ alert WITH its Retry replaces “retrying”, `Not retried automatically: <the cooldown>`; nothing else said; alerts off, nothing at all", async () => {
  for (const alertsOn of [true, false]) {
    const page = await fakePage({ testSettings: QUICK, ...(alertsOn ? {} : { storage: { settings: { alerts: false } } }) });
    try {
      const { element, module } = page;
      const notes = fakeNotifications();
      const journal = () => page.module.journal();
      const open = gateJobs();
      await batchOfOther(page, 7, { statuses: { [`${OTHER_ID}:2`]: "failed" } }); // its retry starts: waits at the gate
      assert.deepEqual(jobsOf(page).map((queued) => queued.label), ["Automatic retry: 1 of Drama 2399"]);
      // TikTok refused a request meanwhile (another DramaFetch page): the cooldown is stored
      const now = Date.now() / 1000;
      page.local.set("cooldown", { until: now + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: now });
      open();
      for (let turn = 0; turn < 1000 && (journal().length < 1 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
      const [entry] = journal();
      assert.equal(entry?.["label"], "Automatic retry: 1 of Drama 2399");
      assert.ok(String(entry?.["error"]).startsWith("TikTok refused a request at "), String(entry?.["error"]));
      assert.deepEqual(entry?.["series"], []); // no request, no row
      const alertId = `dramafetch-alert:${module.alerts.page}:7:${OTHER_ID}:retry`;
      if (!alertsOn) {
        assert.deepEqual(notes.created, []);
        continue;
      }
      assert.deepEqual(notes.created, [alertId, alertId]);
      const shown = notes.shown.get(alertId);
      assert.equal(shown?.["title"], "⚠ Drama 2399 — 1 episode to retry");
      assert.equal(shown?.["message"], "E02 did not download.");
      assert.ok(String(shown?.["contextMessage"]).startsWith("Not retried automatically: TikTok refused a request at "), String(shown?.["contextMessage"]));
      assert.ok([...String(shown?.["contextMessage"])].length <= "Not retried automatically: ".length + 200);
      assert.deepEqual(shown?.["buttons"], [{ title: "Retry" }]);
      assert.deepEqual(module.alerts.retryOf(alertId)?.numbers, [2]);
    } finally {
      page.restore();
    }
  }
});

test("an automatic retry refused at its run's own gates (1.8.0), past the job's — a write Chrome refuses right before its listing, a cooldown met during its rest between jobs —: no request, its journal entry says why, and its drama's ⚠ alert WITH its Retry replaces “retrying”, `Not retried automatically: <the reason>` — never left saying “retrying”", async () => {
  for (const refusal of /** @type {const} */ (["write", "cooldown"])) {
    // the cooldown's case: a rest between jobs due (the last contact just now), the cooldown met in it
    const page = await fakePage(refusal === "write" ? { testSettings: QUICK } : { testSettings: { ...QUICK, restMinS: 0.3, restMaxS: 0.4 }, storage: { pacing: { lastContactAt: Date.now() / 1000 } } });
    try {
      const { element, module } = page;
      const notes = fakeNotifications();
      const journal = () => page.module.journal();
      const open = gateJobs();
      await batchOfOther(page, 7, { statuses: { [`${OTHER_ID}:2`]: "failed" } }); // its retry starts: waits at the gate
      assert.deepEqual(jobsOf(page).map((queued) => queued.label), ["Automatic retry: 1 of Drama 2399"], refusal);
      const alertId = `dramafetch-alert:${module.alerts.page}:7:${OTHER_ID}:retry`;
      assert.deepEqual(notes.created, [alertId], refusal);
      // the job's own gate lets it through; then, from the retry's first write of the pacing on —
      // its rest's, or the one right before its listing —, the disk under Chrome's profile is full;
      // or, with that rest's write, TikTok refused a request meanwhile (another DramaFetch page)
      const area = /** @type {{set: (items: Record<string, unknown>) => Promise<void>}} */ (/** @type {unknown} */ (globalThis.chrome.storage.local));
      const set = area.set;
      let armed = true;
      area.set = async (items) => {
        if (!("pacing" in items)) return set(items);
        if (refusal === "write") throw new Error(REFUSED);
        if (armed) {
          armed = false;
          const at = Date.now() / 1000;
          page.local.set("cooldown", { until: at + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: at });
        }
        return set(items);
      };
      open();
      for (let turn = 0; turn < 20000 && (journal().length < 1 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
      const [entry] = journal();
      const series = /** @type {Record<string, unknown>[]} */ (entry?.["series"] ?? []);
      assert.equal(entry?.["label"], "Automatic retry: 1 of Drama 2399", refusal);
      assert.equal(series.length, 1, refusal);
      assert.equal(series[0]?.["contacted"], false, refusal); // refused by the run's own gate: no request
      assert.deepEqual(series[0]?.["rows"], [], refusal);
      if (refusal === "write") {
        assert.equal(entry?.["stopped"], UNSAVED);
      } else {
        assert.ok(String(entry?.["stopped"]).startsWith("cooldown until "), String(entry?.["stopped"]));
        // met after the rest, by the run's own second look at the cooldown
        assert.deepEqual(/** @type {{kind: string}[]} */ (entry?.["pauses"]).map((pause) => pause.kind), ["job-rest"]);
      }
      assert.deepEqual(notes.created, [alertId, alertId], refusal); // ONE more, replacing “retrying”
      const shown = notes.shown.get(alertId);
      assert.equal(shown?.["title"], "⚠ Drama 2399 — 1 episode to retry", refusal);
      assert.equal(shown?.["message"], "E02 did not download.", refusal);
      const reason = refusal === "write" ? "the progress could not be saved: " : "cooldown until ";
      assert.ok(String(shown?.["contextMessage"]).startsWith(`Not retried automatically: ${reason}`), String(shown?.["contextMessage"]));
      assert.deepEqual(shown?.["buttons"], [{ title: "Retry" }], refusal);
      assert.deepEqual(module.alerts.retryOf(alertId), { seriesId: OTHER_ID, name: "Drama 2399", numbers: [2] }, refusal);
    } finally {
      page.restore();
    }
  }
});

test("an automatic retry an error ends before its drama's alert (1.8.0) is not left saying “retrying”: its drama's ⚠ alert WITH its Retry under that id, `Not retried automatically: <the error>`", async () => {
  const page = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    const journal = () => page.module.journal();
    const open = gateJobs();
    await batchOfOther(page, 7, { statuses: { [`${OTHER_ID}:2`]: "failed" } }); // its retry starts: waits at the gate
    // Chrome refuses the job's header rule, right after its gate: the job ends with that error
    Object.assign(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis.chrome)), {
      declarativeNetRequest: { updateSessionRules: async () => Promise.reject(new Error("Internal error: the rule could not be set")) },
    });
    open();
    for (let turn = 0; turn < 1000 && (journal().length < 1 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    assert.equal(journal()[0]?.["label"], "Automatic retry: 1 of Drama 2399");
    assert.equal(journal()[0]?.["error"], "Internal error: the rule could not be set");
    const alertId = `dramafetch-alert:${module.alerts.page}:7:${OTHER_ID}:retry`;
    assert.deepEqual(notes.created, [alertId, alertId]);
    assert.equal(notes.shown.get(alertId)?.["title"], "⚠ Drama 2399 — 1 episode to retry");
    assert.equal(notes.shown.get(alertId)?.["contextMessage"], "Not retried automatically: Internal error: the rule could not be set");
    assert.deepEqual(notes.shown.get(alertId)?.["buttons"], [{ title: "Retry" }]);
    assert.deepEqual(module.alerts.retryOf(alertId)?.numbers, [2]);
  } finally {
    page.restore();
  }
});

test("an automatic retry that ran and then stopped (1.8.0) — its fresh listing asked for, then the stop —: its own outcome alert under the id of “retrying”, the stop's reason its context; never “Not retried automatically”, which is for one that never ran", async () => {
  const page = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    const journal = () => page.module.journal();
    const open = gateJobs();
    await batchOfOther(page, 7, { statuses: { [`${OTHER_ID}:2`]: "failed" } }); // its retry starts: waits at the gate
    const alertId = `dramafetch-alert:${module.alerts.page}:7:${OTHER_ID}:retry`;
    assert.deepEqual(notes.created, [alertId]);
    open(); // it runs: the rest, then its fresh listing, which fails here (no tab can open): a stop after a request
    for (let turn = 0; turn < 1000 && (journal().length < 1 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    const [entry] = journal();
    const series = /** @type {Record<string, unknown>[]} */ (entry?.["series"] ?? []);
    assert.equal(entry?.["label"], "Automatic retry: 1 of Drama 2399");
    assert.equal(entry?.["stopped"], "the episode list could not be fetched");
    assert.equal(series[0]?.["contacted"], true); // it made a request: it ran
    assert.deepEqual(notes.created, [alertId, alertId]); // ONE outcome notification, replacing “retrying”
    assert.equal(notes.shown.get(alertId)?.["contextMessage"], "the episode list could not be fetched");
  } finally {
    page.restore();
  }
});

test("an automatic retry Stop ends after it saved some of its episodes (1.8.0): its drama's ⚠ alert under the id of “retrying” names only those not on disk, with their Retry, the stop's reason its context — never “Not retried automatically”: it ran —; every one on disk, “retrying” goes; one that never ran keeps “Not retried automatically”", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    page.hold();
    const first = await batchOfOther(page, 7, { statuses: { [`${OTHER_ID}:2`]: "failed", [`${OTHER_ID}:3`]: "failed" } });
    const [auto] = module.queuedJobs(); // started, held
    assert.ok(auto?.autoRetry !== undefined);
    assert.deepEqual(auto.numbers, [2, 3]);
    const alertId = auto.autoRetry.alertId;
    assert.equal(notes.shown.get(alertId)?.["title"], "↻ Drama 2399 — retrying 2 episodes");
    // its run, as runJob gets it: E02 saved, Stop pressed meanwhile — the engine meets it before E03
    const scripted = scriptedEngine(page, auto, {
      onDownload: (ep) => {
        if (ep.number === 2) element("stop-button").fire("click");
      },
    });
    scripted.states.set(OTHER_ID, first.states.get(OTHER_ID));
    await assert.rejects(runSelectionJob(scripted.engine, refOf(OTHER_ID), auto.numbers, { lastContactAt: null }), StopRequested);
    assert.deepEqual(scripted.jobRecord.saved, [2]); // what it got on disk, as it went
    // runJob's end: E03 alone, the stop's reason as the context
    module.alertNotRetried(auto, "stopped by you", scripted.jobRecord.saved ?? []);
    assert.deepEqual(notes.created, [alertId, alertId]);
    assert.deepEqual(notes.shown.get(alertId), {
      type: "basic",
      iconUrl: ALERT_ICON_URL,
      title: "⚠ Drama 2399 — 1 episode to retry",
      message: "E03 did not download.",
      contextMessage: "stopped by you",
      priority: 0,
      requireInteraction: false,
      silent: false,
      buttons: [{ title: "Retry" }],
    });
    assert.deepEqual(module.alerts.retryOf(alertId), { seriesId: OTHER_ID, name: "Drama 2399", numbers: [3] });
    // every episode it retried on disk: “retrying” goes, nothing in its place
    module.alertNotRetried(auto, "stopped by you", [2, 3]);
    assert.deepEqual(notes.cleared, [alertId]);
    assert.equal(notes.created.length, 2);
    assert.equal(module.alerts.retryOf(alertId), null);
    // one that never ran (no request: Stop in the rest before its list): the job's own episodes
    module.alertNotRetried(auto, "stopped by you", null);
    assert.equal(notes.shown.get(alertId)?.["message"], "E02, E03 did not download.");
    assert.equal(notes.shown.get(alertId)?.["contextMessage"], "Not retried automatically: stopped by you");
    assert.deepEqual(module.alerts.retryOf(alertId)?.numbers, [2, 3]);
  } finally {
    page.restore();
  }
});

test("an automatic retry Stop ends counts on disk only what it saved or found saved (1.8.0): an episode that failed again, or that it found served short, is named in its drama's ⚠ alert and taken by its Retry with the ones it never reached; one it found on disk already is not", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    page.hold();
    // the paste: E02, E03 and E05 cut short, E04 and E06 saved between them (the failure streak back at 0)
    const statuses = { [`${OTHER_ID}:2`]: "failed", [`${OTHER_ID}:3`]: "failed", [`${OTHER_ID}:5`]: "failed" };
    const first = await batchOfOther(page, 7, { episodes: 6, statuses });
    const [auto] = module.queuedJobs(); // started, held
    assert.ok(auto?.autoRetry !== undefined);
    assert.deepEqual(auto.numbers, [2, 3, 5]);
    const alertId = auto.autoRetry.alertId;
    /** @type {string[]} */
    const results = [];
    // its run, as runJob gets it: E02 fails again, E03 is served short, Stop pressed meanwhile — met before E05
    const scripted = scriptedEngine(page, auto, {
      episodes: 6,
      statuses: { [`${OTHER_ID}:2`]: "failed", [`${OTHER_ID}:3`]: "failed-unavailable" },
      onDownload: (ep) => {
        if (ep.number === 3) element("stop-button").fire("click");
      },
    });
    const onResult = scripted.engine.onResult;
    scripted.engine.onResult = (result) => {
      results.push(`${result.episode.number}:${result.status}`);
      onResult?.(result);
    };
    scripted.states.set(OTHER_ID, first.states.get(OTHER_ID));
    await assert.rejects(runSelectionJob(scripted.engine, refOf(OTHER_ID), auto.numbers, { lastContactAt: null }), StopRequested);
    assert.deepEqual(results, ["2:failed", "3:failed-unavailable"]);
    assert.equal(scripted.jobRecord.saved, undefined); // nothing of it on disk
    // runJob's end: every one of its episodes named, the stop's reason the context
    module.alertNotRetried(auto, "stopped by you", scripted.jobRecord.saved ?? []);
    assert.deepEqual(notes.created, [alertId, alertId]);
    assert.deepEqual(notes.shown.get(alertId), {
      type: "basic",
      iconUrl: ALERT_ICON_URL,
      title: "⚠ Drama 2399 — 3 episodes to retry",
      message: "E02, E03, E05 did not download.",
      contextMessage: "stopped by you",
      priority: 0,
      requireInteraction: false,
      silent: false,
      buttons: [{ title: "Retry" }],
    });
    assert.deepEqual(module.alerts.retryOf(alertId), { seriesId: OTHER_ID, name: "Drama 2399", numbers: [2, 3, 5] });
  } finally {
    page.restore();
  }
  const found = await fakePage();
  try {
    const { element, module } = found;
    const notes = fakeNotifications();
    found.hold();
    const first = await batchOfOther(found, 7, { statuses: { [`${OTHER_ID}:2`]: "failed", [`${OTHER_ID}:3`]: "failed" } });
    const [auto] = module.queuedJobs(); // started, held
    assert.ok(auto?.autoRetry !== undefined);
    assert.deepEqual(auto.numbers, [2, 3]);
    const alertId = auto.autoRetry.alertId;
    // E02 saved meanwhile — another download of the drama ahead of the retry —: recorded done, its file there
    const state = structuredClone(/** @type {import("../src/lib/state.js").SeriesState} */ (first.states.get(OTHER_ID)));
    record(state, { episode: episode(2, { seriesId: OTHER_ID }), status: "done", path: `/dl/${OTHER_ID}/E2.mp4`, message: "saved E2.mp4 (0.1 MiB) + cover embedded", downloadId: 2 }, { exists: () => true, now: 1_800_000_000 });
    /** @type {string[]} */
    const results = [];
    const scripted = scriptedEngine(found, auto);
    const onResult = scripted.engine.onResult;
    scripted.engine.onResult = (result) => {
      results.push(`${result.episode.number}:${result.status}`);
      onResult?.(result);
      if (result.episode.number === 2) element("stop-button").fire("click"); // met in the pause before E03
    };
    scripted.states.set(OTHER_ID, state);
    await assert.rejects(runSelectionJob(scripted.engine, refOf(OTHER_ID), auto.numbers, { lastContactAt: null }), StopRequested);
    assert.deepEqual(results, ["2:skipped-exists"]);
    assert.deepEqual(scripted.jobRecord.saved, [2]); // found on disk: on disk all the same
    module.alertNotRetried(auto, "stopped by you", scripted.jobRecord.saved ?? []);
    assert.equal(notes.shown.get(alertId)?.["title"], "⚠ Drama 2399 — 1 episode to retry");
    assert.equal(notes.shown.get(alertId)?.["message"], "E03 did not download.");
    assert.deepEqual(module.alerts.retryOf(alertId)?.numbers, [3]);
  } finally {
    found.restore();
  }
});

test("Stop pressed while a drama's last episode downloads (1.8.0) — after the engine's last look at it, so the run ends unstopped —: a stop all the same, no automatic retry for that drama, its 1.7.0 ⚠ alert with its Retry; a selection job's drama the same", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    page.hold();
    const { runs } = await batchOfOther(page, 7, {
      statuses: { [`${OTHER_ID}:3`]: "failed" },
      onDownload: (ep) => {
        if (ep.number === 3) element("stop-button").fire("click"); // E03, the drama's last: no checkpoint after it
      },
    });
    assert.deepEqual(runs.map((run) => [run.stop, run.report.stopped]), [[false, null]]); // the engine never met it
    assert.deepEqual(jobsOf(page), []); // nothing queued
    const id = `dramafetch-alert:${module.alerts.page}:7:${OTHER_ID}:retry`;
    assert.deepEqual(notes.created, [id]);
    assert.equal(notes.shown.get(id)?.["title"], "⚠ Drama 2399 — 1 episode to retry");
    assert.equal(notes.shown.get(id)?.["message"], "E03 did not download.");
    assert.deepEqual(notes.shown.get(id)?.["buttons"], [{ title: "Retry" }]);
    assert.deepEqual(module.alerts.retryOf(id)?.numbers, [3]);
  } finally {
    page.restore();
  }
  const other = await fakePage();
  try {
    const { element, module } = other;
    const notes = fakeNotifications();
    other.hold();
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "failed"], [3, "failed"]])]);
    element("retry-button").fire("click"); // the progress card's Retry of E02 and E03: running
    await other.turn();
    const [running] = module.queuedJobs();
    assert.ok(running !== undefined && running.kind === "selection");
    const scripted = scriptedEngine(other, running, {
      statuses: { [`${OTHER_ID}:3`]: "failed" },
      onDownload: (ep) => {
        if (ep.number === 3) element("stop-button").fire("click");
      },
    });
    const run = await runSelectionJob(scripted.engine, refOf(OTHER_ID), running.numbers, { lastContactAt: null });
    assert.equal(run.stop, false);
    module.dramaDone(running, run, scripted.jobRecord); // where runJob makes the drama's alert
    await other.turn();
    assert.deepEqual(jobsOf(other).map((queued) => queued.label), ["Retry 2 of Drama 2399"]); // itself: nothing behind it
    const id = `dramafetch-alert:${module.alerts.page}:${running.id}:${OTHER_ID}:retry`;
    assert.deepEqual(notes.created, [id]);
    assert.equal(notes.shown.get(id)?.["title"], "⚠ Drama 2399 — 1 episode to retry");
    assert.deepEqual(notes.shown.get(id)?.["buttons"], [{ title: "Retry" }]);
  } finally {
    other.restore();
  }
});

test("Stop takes DramaFetch's own automatic retries out of the queue at once (1.8.0) — none starts after a Stop, even when the running job ends no run —: the Did not download block's line that promised one goes; at the running job's end each one's drama gets the ⚠ alert with its Retry, `Not retried automatically: stopped by you`, and its journal entry is any cancelled job's — never counted in the stopped alert", async () => {
  const page = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    const journal = () => page.module.journal();
    const open = gateJobs();
    assert.equal(paste(page, SERIES_ID), true); // job 1, started: waits at the gate
    await page.turn();
    const first = await batchOfOther(page, 7, { statuses: { [`${OTHER_ID}:2`]: "failed" } }); // its automatic retry waits behind job 1
    assert.equal(paste(page, THIRD_ID), true); // a download the user queued behind it
    assert.deepEqual(waitingRows(page), [dramaRow(SERIES_ID), whatRow("Automatic retry E02", OTHER_ID, "Drama 2399"), dramaRow(THIRD_ID)]); // job 1's drama first: at the gate, never begun
    // the end of the job that queued it, as runJob draws it: its line says it is retried
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "failed"], [3, "done"]])], module.waitingAutoRetries(first.jobRecord));
    assert.equal(element("failed-auto").textContent, "1 of them will be retried automatically, once.");
    const alertId = `dramafetch-alert:${module.alerts.page}:7:${OTHER_ID}:retry`;
    assert.deepEqual(notes.created, [alertId]);
    element("stop-button").fire("click");
    // out of the queue at once, whatever job 1 does now; the user's own download is left to the stop
    assert.deepEqual(waitingRows(page), [dramaRow(SERIES_ID), dramaRow(THIRD_ID)]);
    assert.equal(element("failed-auto").hidden, true);
    assert.equal(element("failed-auto").textContent, "");
    assert.deepEqual(notes.created, [alertId]); // said at job 1's end
    open(); // job 1 goes on, and meets the Stop before any request
    for (let turn = 0; turn < 1000 && (journal().length < 3 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    const notStarted = `not started: batch stopped in Series ${SERIES_ID} (stopped by you)`;
    assert.deepEqual(journal().map((entry) => [entry["kind"], entry["label"], entry["error"], entry["series"]]), [
      ["batch", `Series ${SERIES_ID}`, "stopped by you", []],
      ["batch", `Series ${THIRD_ID}`, notStarted, []],
      ["selection", "Automatic retry: 1 of Drama 2399", notStarted, []],
    ]);
    assert.deepEqual(notes.created, [alertId, alertId]); // no “DramaFetch stopped”: job 1 asked for nothing
    assert.deepEqual(notes.shown.get(alertId), {
      type: "basic",
      iconUrl: ALERT_ICON_URL,
      title: "⚠ Drama 2399 — 1 episode to retry",
      message: "E02 did not download.",
      contextMessage: "Not retried automatically: stopped by you",
      priority: 0,
      requireInteraction: false,
      silent: false,
      buttons: [{ title: "Retry" }],
    });
    assert.deepEqual(module.alerts.retryOf(alertId), { seriesId: OTHER_ID, name: "Drama 2399", numbers: [2] });
    // its Retry, pressed once the stopped job is over: queued, and it runs
    page.hold();
    assert.deepEqual(page.message({ type: "dramafetch:retry", notificationId: alertId }, WORKER), [{ ok: true, queued: true, tabId: 1 }]);
    await page.turn();
    assert.deepEqual(jobsOf(page).map((queued) => [queued.label, queued.numbers, queued.autoRetry]), [["Retry 1 of Drama 2399", [2], undefined]]);
  } finally {
    page.restore();
  }
});

test("Stop takes EVERY automatic retry waiting out of the queue at once (1.8.0) — two side by side — and never a job the user queued: the progress card's Retry (a selection job of the user's) and a paste stay, left to the stop; at the running job's end each automatic retry is said in turn — its `not started: …` entry, its drama's ⚠ `Not retried automatically: stopped by you` —, before the jobs the stop cancels", async () => {
  const PAST_ID = "7699393770256782366";
  const page = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    const journal = () => page.module.journal();
    const open = gateJobs();
    assert.equal(paste(page, SERIES_ID), true); // job 1, started: waits at the gate
    await page.turn();
    await batchOfOther(page, 7, { statuses: { [`${OTHER_ID}:2`]: "failed" } }); // Drama 2399's automatic retry waits
    await batchOfOther(page, 8, { statuses: { [`${FOURTH_ID}:3`]: "failed" } }, undefined, FOURTH_ID); // Drama 2377's, right behind it
    // a job that ended without Drama 2366's E02: the user's own Retry of it, a selection job — not an automatic retry
    module.renderFailed([seriesRecord(PAST_ID, "Drama 2366", [[1, "done"], [2, "failed"]])]);
    element("retry-button").fire("click");
    await page.turn();
    assert.equal(paste(page, THIRD_ID), true); // and the user's own download
    assert.deepEqual(jobsOf(page).map((queued) => [queued.kind, queued.label, queued.autoRetry !== undefined]), [
      ["batch", `Series ${SERIES_ID}`, false],
      ["selection", "Automatic retry: 1 of Drama 2399", true],
      ["selection", "Automatic retry: 1 of Drama 2377", true],
      ["selection", "Retry 1 of Drama 2366", false],
      ["batch", `Series ${THIRD_ID}`, false],
    ]);
    const first = `dramafetch-alert:${module.alerts.page}:7:${OTHER_ID}:retry`;
    const second = `dramafetch-alert:${module.alerts.page}:8:${FOURTH_ID}:retry`;
    assert.deepEqual(notes.created, [first, second]);
    element("stop-button").fire("click");
    // both out at once, whatever job 1 does now; the jobs the user queued are left to the stop
    assert.deepEqual(waitingRows(page), [dramaRow(SERIES_ID), whatRow("Retry E02", PAST_ID, "Drama 2366"), dramaRow(THIRD_ID)]);
    assert.deepEqual(notes.created, [first, second]); // said at job 1's end
    open(); // job 1 goes on, and meets the Stop before any request
    for (let turn = 0; turn < 1000 && (journal().length < 5 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    const notStarted = `not started: batch stopped in Series ${SERIES_ID} (stopped by you)`;
    // newest first: job 1, the jobs its stop took out of the queue, and before them each automatic retry in turn
    assert.deepEqual(journal().map((entry) => [entry["kind"], entry["label"], entry["error"], entry["series"]]), [
      ["batch", `Series ${SERIES_ID}`, "stopped by you", []],
      ["batch", `Series ${THIRD_ID}`, notStarted, []],
      ["selection", "Retry 1 of Drama 2366", notStarted, []],
      ["selection", "Automatic retry: 1 of Drama 2377", notStarted, []],
      ["selection", "Automatic retry: 1 of Drama 2399", notStarted, []],
    ]);
    assert.deepEqual(notes.created, [first, second, first, second]); // no “DramaFetch stopped”: job 1 asked for nothing
    assert.equal(notes.shown.get(first)?.["title"], "⚠ Drama 2399 — 1 episode to retry");
    assert.equal(notes.shown.get(first)?.["contextMessage"], "Not retried automatically: stopped by you");
    assert.deepEqual(notes.shown.get(first)?.["buttons"], [{ title: "Retry" }]);
    assert.deepEqual(module.alerts.retryOf(first), { seriesId: OTHER_ID, name: "Drama 2399", numbers: [2] });
    assert.equal(notes.shown.get(second)?.["title"], "⚠ Drama 2377 — 1 episode to retry");
    assert.equal(notes.shown.get(second)?.["message"], "E03 did not download.");
    assert.equal(notes.shown.get(second)?.["contextMessage"], "Not retried automatically: stopped by you");
    assert.deepEqual(notes.shown.get(second)?.["buttons"], [{ title: "Retry" }]);
    assert.deepEqual(module.alerts.retryOf(second), { seriesId: FOURTH_ID, name: "Drama 2377", numbers: [3] });
  } finally {
    page.restore();
  }
});

test("Stop pressed while the Did not download block is kept for the first of its job's automatic retries (1.8.0): the others leave the queue and the block's line that counted them goes at once — the block, its table and its Retry stay until that retry's own end, which draws its own —; each drama then gets its ⚠ alert, `Not retried automatically: stopped by you`", async () => {
  // a rest between jobs due (the last contact just now): the running retry meets the Stop there, before any request
  const page = await fakePage({ testSettings: { ...QUICK, restMinS: 0.3, restMaxS: 0.4 }, storage: { pacing: { lastContactAt: Date.now() / 1000 } } });
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    const journal = () => page.module.journal();
    const open = gateJobs();
    const first = module.alerts.idOf(7, `${OTHER_ID}:retry`);
    const second = module.alerts.idOf(7, `${THIRD_ID}:retry`);
    // job 7's end as runJob draws it, its two automatic retries waiting
    module.renderFailed(
      [seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "failed"], [3, "done"]]), seriesRecord(THIRD_ID, "Drama 2388", [[1, "done"], [2, "done"], [3, "failed"]])],
      [
        { numbers: [2], autoRetry: { alertId: first, name: "Drama 2399" } },
        { numbers: [3], autoRetry: { alertId: second, name: "Drama 2388" } },
      ],
    );
    // job 7's two dramas, through the page's own hooks, queue those two: the first starts — the
    // block kept for it — and waits at the gate, the second waits behind it
    const job = { ...BATCH_JOB, id: 7, refs: [refOf(OTHER_ID), refOf(THIRD_ID)] };
    const { engine } = scriptedEngine(page, job, { statuses: { [`${OTHER_ID}:2`]: "failed", [`${THIRD_ID}:3`]: "failed" } });
    await runBatch(engine, job.refs);
    await page.turn();
    assert.deepEqual(module.queuedJobs().map((queued) => queued.label), ["Automatic retry: 1 of Drama 2399", "Automatic retry: 1 of Drama 2388"]);
    assert.deepEqual(waitingRows(page), [whatRow("Automatic retry E03", THIRD_ID, "Drama 2388")]); // the running retry has no row
    assert.equal(element("failed-block").hidden, false);
    assert.equal(element("failed-heading").textContent, "Did not download (2)");
    assert.equal(element("failed-auto").hidden, false);
    assert.equal(element("failed-auto").textContent, "2 of them will be retried automatically, once.");
    element("stop-button").fire("click");
    // the second out of the queue at once, and the line that promised it with it
    assert.deepEqual(waitingRows(page), []);
    assert.equal(element("failed-auto").hidden, true);
    assert.equal(element("failed-auto").textContent, "");
    // the block itself stays while the first one runs
    assert.equal(element("failed-block").hidden, false);
    assert.equal(element("failed-heading").textContent, "Did not download (2)");
    assert.equal(element("failed-table").querySelector("tbody").children.length, 2);
    assert.equal(element("retry-button").disabled, false);
    open(); // the first one goes on and meets the Stop in its rest between jobs
    for (let turn = 0; turn < 1000 && (journal().length < 2 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    assert.deepEqual(journal().map((entry) => [entry["label"], entry["error"], entry["series"]]), [
      ["Automatic retry: 1 of Drama 2399", "stopped by you", []],
      ["Automatic retry: 1 of Drama 2388", "not started: batch stopped in Automatic retry: 1 of Drama 2399 (stopped by you)", []],
    ]);
    // 3.0.1 (§11): its own end takes nothing (it was stopped before its list: no row of its own) —
    // the block used to hide then —, so job 7's rows stay, their Retry with them
    assert.equal(element("failed-block").hidden, false);
    assert.equal(element("failed-heading").textContent, "Did not download (2)");
    assert.equal(element("failed-auto").hidden, true);
    assert.deepEqual(notes.created, [first, second, second, first]);
    for (const id of [first, second]) {
      assert.equal(notes.shown.get(id)?.["contextMessage"], "Not retried automatically: stopped by you", id);
      assert.deepEqual(notes.shown.get(id)?.["buttons"], [{ title: "Retry" }], id);
    }
    assert.deepEqual(module.alerts.retryOf(first)?.numbers, [2]);
    assert.deepEqual(module.alerts.retryOf(second)?.numbers, [3]);
  } finally {
    page.restore();
  }
});

test("the duplicate guard lets go of a selection job done with its drama (1.8.0): from its drama's alert on it asks for none of its episodes, so its alert's Retry of what it could not save is queued behind it, answered queued, the alert taken away — the progress card's Retry then finds those episodes held by that waiting retry; an automatic retry's ⚠ outcome the same", async () => {
  const page = await fakePage({ storage: { ...NO_AUTO_RETRY } });
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    page.hold();
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "failed"], [3, "done"]])]);
    element("retry-button").fire("click"); // the progress card's Retry of E02: running
    await page.turn();
    const [running] = module.queuedJobs();
    assert.ok(running !== undefined);
    assert.deepEqual([running.label, running.numbers], ["Retry 1 of Drama 2399", [2]]);
    const scripted = scriptedEngine(page, running, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
    module.dramaDone(running, await runSelectionJob(scripted.engine, refOf(OTHER_ID), running.numbers, { lastContactAt: null }), scripted.jobRecord);
    const id = `dramafetch-alert:${module.alerts.page}:${running.id}:${OTHER_ID}:retry`;
    assert.deepEqual(notes.shown.get(id)?.["buttons"], [{ title: "Retry" }]);
    // its alert's Retry while the job ends (it runs on, held): queued behind it
    assert.deepEqual(page.message({ type: "dramafetch:retry", notificationId: id }, WORKER), [{ ok: true, queued: true, tabId: 1 }]);
    await page.turn();
    assert.deepEqual(jobsOf(page).map((queued) => [queued.label, queued.numbers]), [
      ["Retry 1 of Drama 2399", [2]],
      ["Retry 1 of Drama 2399", [2]],
    ]);
    assert.deepEqual(notes.cleared, [id]);
    // the progress card's Retry of E02 now: held by that waiting retry, nothing twice
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[2, "failed"]])]);
    element("retry-button").fire("click");
    await page.turn();
    assert.equal(element("input-status").textContent, "Already queued — not queued twice.");
    assert.equal(jobsOf(page).length, 2);
  } finally {
    page.restore();
  }
  const auto = await fakePage();
  try {
    const { module } = auto;
    const notes = fakeNotifications();
    auto.hold();
    const first = await batchOfOther(auto, 7, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
    const [running] = module.queuedJobs(); // the automatic retry, running
    assert.ok(running?.autoRetry !== undefined);
    const scripted = scriptedEngine(auto, running, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
    scripted.states.set(OTHER_ID, first.states.get(OTHER_ID));
    module.dramaDone(running, await runSelectionJob(scripted.engine, refOf(OTHER_ID), running.numbers, { lastContactAt: null }), scripted.jobRecord);
    const id = running.autoRetry.alertId;
    assert.equal(notes.shown.get(id)?.["contextMessage"], "After an automatic retry.");
    assert.deepEqual(auto.message({ type: "dramafetch:retry", notificationId: id }, WORKER), [{ ok: true, queued: true, tabId: 1 }]);
    await auto.turn();
    assert.deepEqual(jobsOf(auto).map((queued) => [queued.label, queued.numbers]), [
      ["Automatic retry: 1 of Drama 2399", [2]],
      ["Retry 1 of Drama 2399", [2]],
    ]);
    assert.deepEqual(notes.cleared, [id]);
  } finally {
    auto.restore();
  }
});

test("the Did not download block (1.8.0): a line says how many of its episodes will be retried automatically, once — hidden when none —; the block stays, line, table and Retry, while that automatic retry runs; as any other job starts the line goes and (3.0.1) the block stays", async () => {
  const records = [seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "failed"], [3, "failed-unavailable", DRM_MESSAGE], [4, "failed"]])];
  const page = await fakePage();
  try {
    const { element, module } = page;
    const alertId = module.alerts.idOf(7, `${OTHER_ID}:retry`);
    const auto = (/** @type {number[]} */ numbers, id = alertId) => ({ numbers, autoRetry: { alertId: id, name: "Drama 2399" } });
    // none queued: hidden, as in 1.7.0
    module.renderFailed(records);
    assert.equal(element("failed-block").hidden, false);
    assert.equal(element("failed-auto").hidden, true);
    assert.equal(element("failed-auto").textContent, "");
    module.renderFailed(records, [auto([2, 4])]);
    assert.equal(element("failed-auto").hidden, false);
    assert.equal(element("failed-auto").textContent, "2 of them will be retried automatically, once.");
    module.renderFailed(records, [auto([2])]);
    assert.equal(element("failed-auto").textContent, "1 of them will be retried automatically, once.");
    // nothing failed: the block and its line hidden — 3.0.1 (§11): a job's end replaces only the rows
    // of the episodes it took, so this one takes all four (it used to take E01 alone)
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "done"], [3, "done"], [4, "done"]])], [auto([2])]);
    assert.equal(element("failed-block").hidden, true);
    assert.equal(element("failed-auto").hidden, true);
    // the job's end as runJob draws it, that retry waiting — then it starts: the block stays
    page.hold();
    module.renderFailed(records, [auto([2, 4])]);
    await batchOfOther(page, 7, { episodes: 4, statuses: { [`${OTHER_ID}:2`]: "failed", [`${OTHER_ID}:4`]: "failed" } }); // queues it, under that id: it starts
    assert.equal(element("progress-current").textContent, "Automatic retry: 2 of Drama 2399");
    assert.equal(element("failed-block").hidden, false);
    assert.equal(element("failed-heading").textContent, "Did not download (3)");
    assert.equal(element("failed-auto").textContent, "2 of them will be retried automatically, once.");
    assert.equal(element("failed-table").querySelector("tbody").children.length, 3);
    assert.equal(element("retry-button").disabled, false);
    // its Retry takes what that retry does not hold: E03 (the short-served one), not E02 or E04
    element("retry-button").fire("click");
    await page.turn();
    assert.deepEqual(waitingRows(page), [whatRow("Retry E03", OTHER_ID, "Drama 2399")]);
    assert.deepEqual(jobsOf(page).at(-1)?.numbers, [3]);
  } finally {
    page.restore();
  }
  // any other job — a download, an automatic retry another job queued — starts: the line goes; 3.0.1
  // (§11, the owner's report of 2026-11-27): the block, its rows and its Retry stay — they used to go
  for (const next of ["paste", "another retry"]) {
    const other = await fakePage();
    try {
      const { element, module } = other;
      const alertId = module.alerts.idOf(7, `${OTHER_ID}:retry`);
      other.hold();
      module.renderFailed(records, [{ numbers: [2, 4], autoRetry: { alertId: next === "paste" ? alertId : "dramafetch-alert:another:1:x:retry", name: "Drama 2399" } }]);
      if (next === "paste") {
        assert.equal(paste(other, SERIES_ID), true);
        await other.turn();
      } else {
        await batchOfOther(other, 7, { episodes: 4, statuses: { [`${OTHER_ID}:2`]: "failed" } });
      }
      assert.equal(element("app-status").dataset["state"], "running", next);
      assert.equal(element("failed-block").hidden, false, next);
      assert.equal(element("failed-auto").hidden, true, next);
      assert.equal(element("failed-auto").textContent, "", next);
      assert.equal(element("failed-heading").textContent, "Did not download (3)", next);
      assert.equal(element("failed-table").querySelector("tbody").children.length, 3, next);
      assert.equal(element("retry-button").disabled, false, next);
    } finally {
      other.restore();
    }
  }
});

test("the Did not download block counts only the automatic retries its own job queued (1.8.0): another job's, waiting too, are never in its line", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    page.hold();
    assert.equal(paste(page, SERIES_ID), true); // running: what the batches below queue waits
    await page.turn();
    const first = await batchOfOther(page, 7, { episodes: 4, statuses: { [`${OTHER_ID}:2`]: "failed" } });
    const second = await batchOfOther(page, 8, { episodes: 4, statuses: { [`${OTHER_ID}:3`]: "failed", [`${OTHER_ID}:4`]: "failed" } });
    assert.deepEqual(waitingRows(page), [dramaRow(SERIES_ID), whatRow("Automatic retry E02", OTHER_ID, "Drama 2399"), whatRow("Automatic retry E03, E04", OTHER_ID, "Drama 2399")]);
    assert.deepEqual(module.waitingAutoRetries(first.jobRecord).map((job) => job.numbers), [[2]]);
    assert.deepEqual(module.waitingAutoRetries(second.jobRecord).map((job) => job.numbers), [[3, 4]]);
    assert.deepEqual(module.waitingAutoRetries({}), []); // a job that queued none
    // the second job's end as runJob draws it: its own two, never the first job's one
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "done"], [3, "failed"], [4, "failed"]])], module.waitingAutoRetries(second.jobRecord));
    assert.equal(element("failed-auto").textContent, "2 of them will be retried automatically, once.");
  } finally {
    page.restore();
  }
});

test("the Did not download block kept while its automatic retry runs keeps its Save the report (1.8.0): the report setting off, the job's report is saved on demand then — every row, the short-served one the retry leaves too —; the retry's own end takes that report's line away; any other job takes the report away (the last job's), the block (3.0.1) staying", async () => {
  const truncated = "download looks incomplete or wrong: truncated body (100000 of 131072 bytes) from v16-webapp-prime.tiktok.com";
  const results = [
    { episode: episode(1, { seriesId: OTHER_ID }), status: /** @type {const} */ ("done"), path: "/dl/E1.mp4", message: "saved E1.mp4 (0.1 MiB)", downloadId: 1 },
    { episode: episode(2, { seriesId: OTHER_ID }), status: /** @type {const} */ ("failed"), path: null, message: truncated },
    { episode: episode(3, { seriesId: OTHER_ID }), status: /** @type {const} */ ("failed-unavailable"), path: null, message: DRM_MESSAGE },
  ];
  const records = [seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "failed", truncated], [3, "failed-unavailable", DRM_MESSAGE]])];
  const page = await fakePage({ storage: { settings: { report: false } } });
  try {
    const { element, module, downloads } = page;
    const alertId = module.alerts.idOf(7, `${OTHER_ID}:retry`);
    page.hold();
    // job 7's end as runJob makes it: its block (its automatic retry of E02 waits), then its report — kept, not saved
    module.renderFailed(records, [{ numbers: [2], autoRetry: { alertId, name: "Drama 2399" } }]);
    await module.reportJobEnd({ kind: "batch", label: `Series ${OTHER_ID}` }, OUTCOME, [finishedRun(OTHER_ID, "Drama 2399", results)], TRACES.of);
    assert.deepEqual(downloads, []);
    assert.equal(element("report-button").disabled, false);
    // that automatic retry starts: the block stays, its Save the report with it
    await batchOfOther(page, 7, { statuses: { [`${OTHER_ID}:2`]: "failed" } }); // queues it under that id: it starts
    assert.equal(element("progress-current").textContent, "Automatic retry: 1 of Drama 2399");
    assert.equal(element("failed-block").hidden, false);
    assert.equal(element("report-button").disabled, false);
    element("report-button").fire("click");
    for (let turns = 0; turns < 20 && downloads.length < 1; turns += 1) await page.turn();
    assert.equal(downloads.length, 1);
    assert.match(/** @type {string} */ (downloads[0]?.filename), /^DramaFetch\/reports\/Drama 2399 - did not download /);
    const report = JSON.parse(/** @type {string} */ (downloads[0]?.text));
    assert.deepEqual(
      report.series[0].not_downloaded.map((/** @type {Record<string, unknown>} */ row) => [row["number"], row["status"]]),
      [
        [2, "failed"],
        [3, "failed-unavailable"],
      ],
    );
    assert.ok(String(element("failed-report").textContent).startsWith("Report saved: Drama 2399 - did not download "));
    // the retry's own end (E02 did not download again): its block and its report; the line of the
    // earlier one goes — nothing of the retry's is saved (the setting off), its own on demand
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[2, "failed", truncated]])]);
    await module.reportJobEnd({ kind: "selection", label: "Automatic retry: 1 of Drama 2399" }, OUTCOME, [finishedRun(OTHER_ID, "Drama 2399", [/** @type {(typeof results)[number]} */ (results[1])])], TRACES.of);
    assert.equal(element("failed-report").hidden, true);
    assert.equal(element("failed-report").textContent, "");
    assert.equal(downloads.length, 1);
    assert.equal(element("report-button").disabled, false);
  } finally {
    page.restore();
  }
  const other = await fakePage({ storage: { settings: { report: false } } });
  try {
    const { element, module } = other;
    other.hold();
    module.renderFailed(records, [{ numbers: [2], autoRetry: { alertId: module.alerts.idOf(7, `${OTHER_ID}:retry`), name: "Drama 2399" } }]);
    await module.reportJobEnd({ kind: "batch", label: `Series ${OTHER_ID}` }, OUTCOME, [finishedRun(OTHER_ID, "Drama 2399", results)], TRACES.of);
    assert.equal(element("report-button").disabled, false);
    assert.equal(paste(other, SERIES_ID), true); // another download starts first
    await other.turn();
    // 3.0.1 (§11): the block stays, its rows and Retry with it — it used to go —; Save the report
    // saves the last job's, so it goes as before
    assert.equal(element("failed-block").hidden, false);
    assert.equal(element("failed-heading").textContent, "Did not download (2)");
    assert.equal(element("report-button").disabled, true);
  } finally {
    other.restore();
  }
});

test("the automatic retry setting (1.8.0): Retry on its own what did not download, on by default, saved with the settings and back with Defaults; off, a plain failure gets the 1.7.0 ⚠ alert and nothing is queued", async () => {
  const page = await fakePage();
  try {
    const { element, local, module } = page;
    assert.equal(element("setting-auto-retry").checked, true);
    element("setting-auto-retry").checked = false;
    element("settings-form").fire("submit");
    for (let turns = 0; turns < 20 && element("settings-status").className !== "status ok"; turns += 1) await page.turn();
    assert.equal(element("settings-status").className, "status ok");
    assert.equal(/** @type {Record<string, unknown>} */ (local.get("settings"))["autoRetry"], false);
    assert.equal(/** @type {Record<string, unknown>} */ (local.get("settings"))["alerts"], true); // the others as they were
    const notes = fakeNotifications();
    page.hold();
    await batchOfOther(page, 4, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
    assert.deepEqual(jobsOf(page), []);
    const id = `dramafetch-alert:${module.alerts.page}:4:${OTHER_ID}:retry`;
    assert.deepEqual(notes.created, [id]);
    assert.deepEqual(notes.shown.get(id)?.["buttons"], [{ title: "Retry" }]);
    // Defaults: on again
    element("settings-reset").fire("click");
    for (let turns = 0; turns < 20 && !element("setting-auto-retry").checked; turns += 1) await page.turn();
    assert.equal(element("setting-auto-retry").checked, true);
    assert.equal(/** @type {Record<string, unknown>} */ (local.get("settings"))["autoRetry"], true);
  } finally {
    page.restore();
  }
  const off = await fakePage({ storage: NO_AUTO_RETRY });
  try {
    assert.equal(off.element("setting-auto-retry").checked, false);
    assert.equal(off.element("setting-alerts").checked, true);
  } finally {
    off.restore();
  }
});

test("the settings saved in another DramaFetch tab (2.0.0: a read-only tab's form still saves): the tab that downloads follows what is stored — the form shows it, and what the page does next follows it: the automatic retry unticked there, a plain failure here gets none (the 1.7.0 ⚠ instead); ticked again there, the next one does —; a 2.x tab's automatic removal switch stored with them is ignored (3.0.0) and never written back; its own Save, heard back, changes nothing more — the form left as it is being edited", async () => {
  const page = await fakePage();
  try {
    const { element, local, module } = page;
    const notes = fakeNotifications();
    page.hold();
    // the other tab saves the automatic retry unticked and a longer pause — a 2.x tab its automatic
    // removal switch with them —: chrome.storage.local holds them, and Chrome tells every DramaFetch page
    local.set("settings", { ...DEFAULT_SETTINGS, autoRetry: false, delayMinS: 6, autoRemove: true });
    page.storageChanged("settings");
    await settled(page);
    assert.equal(element("setting-auto-retry").checked, false); // the form shows what is stored
    assert.equal(element("setting-delay-min").value, "6");
    await batchOfOther(page, 4, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
    assert.deepEqual(jobsOf(page), []); // no automatic retry: what the other tab saved
    assert.deepEqual(notes.created, [`dramafetch-alert:${module.alerts.page}:4:${OTHER_ID}:retry`]); // the 1.7.0 ⚠ instead
    // ticked again in the other tab: the next plain failure gets its automatic retry
    local.set("settings", { ...DEFAULT_SETTINGS });
    page.storageChanged("settings");
    await settled(page);
    assert.equal(element("setting-auto-retry").checked, true);
    assert.equal(element("setting-delay-min").value, String(DEFAULT_SETTINGS.delayMinS));
    await batchOfOther(page, 5, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
    assert.deepEqual(jobsOf(page).map((queued) => [queued.label, queued.numbers]), [["Automatic retry: 1 of Drama 2399", [2]]]);
    // its own Save, which Chrome tells this page too — maybe once the user is editing the form
    // again: nothing more happens, and the edit stays as typed
    element("setting-alerts").checked = false;
    element("settings-form").fire("submit");
    for (let turns = 0; turns < 20 && element("settings-status").className !== "status ok"; turns += 1) await page.turn();
    assert.deepEqual(local.get("settings"), { ...DEFAULT_SETTINGS, alerts: false }); // nothing of 2.x's switch written back
    element("setting-auto-retry").checked = false; // being edited, not saved yet
    page.storageChanged("settings");
    await settled(page);
    assert.equal(element("setting-auto-retry").checked, false);
    assert.equal(element("setting-alerts").checked, false);
    assert.equal(jobsOf(page).length, 1); // the automatic retry queued before is still there
  } finally {
    page.restore();
  }
});

test("the automatic retry in Spanish under a Spanish Chrome (1.8.0): its queue label, “retrying”, what came of it, the Did not download line and the duplicate guard's status line", async () => {
  const page = await fakePage({ language: "es" });
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    page.hold();
    const first = await batchOfOther(page, 7, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
    const [auto] = module.queuedJobs();
    assert.ok(auto?.autoRetry !== undefined);
    assert.equal(auto.label, "Reintento automático: 1 de Drama 2399");
    const alertId = auto.autoRetry.alertId;
    assert.equal(notes.shown.get(alertId)?.["title"], "↻ Drama 2399 — reintentando 1 episodio");
    assert.equal(notes.shown.get(alertId)?.["message"], "E02 no se descargó: DramaFetch lo intenta una vez más por su cuenta.");
    // the block's line, and the progress card's Retry of what that retry — running, its drama not
    // done yet — holds
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "failed"], [3, "failed"]])], [{ numbers: [2, 3], autoRetry: { alertId: "x", name: null } }]);
    assert.equal(element("failed-auto").textContent, "Se reintentarán automáticamente 2, una vez.");
    // 3.0.1 (§11): a job's end replaces only the rows of the episodes it took — this one takes E03
    // too (saved), so the block holds E02 alone, which the waiting retry holds
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "failed"], [3, "done"]])], [{ numbers: [2], autoRetry: { alertId: "x", name: null } }]);
    assert.equal(element("failed-auto").textContent, "Se reintentará automáticamente 1, una vez.");
    element("retry-button").fire("click");
    await page.turn();
    assert.equal(element("input-status").textContent, "Ya está en la cola: no se encola dos veces.");
    // what came of it: still not downloaded
    const scripted = scriptedEngine(page, auto, { statuses: { [`${OTHER_ID}:2`]: "failed" } });
    scripted.states.set(OTHER_ID, first.states.get(OTHER_ID));
    module.dramaDone(auto, await runSelectionJob(scripted.engine, refOf(OTHER_ID), auto.numbers, { lastContactAt: null }), scripted.jobRecord);
    assert.equal(notes.shown.get(alertId)?.["title"], "⚠ Drama 2399 — 1 episodio por reintentar");
    assert.equal(notes.shown.get(alertId)?.["contextMessage"], "Tras un reintento automático.");
    assert.deepEqual(notes.shown.get(alertId)?.["buttons"], [{ title: "Reintentar" }]);
    // an automatic retry of E02 and E03 that Stop ended once E02 was saved: the stop's reason as the tab shows it
    const later = { refs: [refOf(OTHER_ID)], numbers: [2, 3], autoRetry: { alertId: module.alerts.idOf(9, `${OTHER_ID}:retry`), name: "Drama 2399" } };
    module.alertNotRetried(later, "stopped by you", [2]);
    assert.equal(notes.shown.get(later.autoRetry.alertId)?.["message"], "E03 no se descargó.");
    assert.equal(notes.shown.get(later.autoRetry.alertId)?.["contextMessage"], "detenido por ti");
  } finally {
    page.restore();
  }
  // an automatic retry a later stop took out of the queue: its reason as the tab shows it, in Spanish
  const es = await fakePage({ testSettings: QUICK, language: "es" });
  try {
    const { element, module } = es;
    const notes = fakeNotifications();
    const journal = () => es.module.journal();
    const open = gateJobs();
    assert.equal(paste(es, SERIES_ID), true); // job 1, started: waits at the gate
    await es.turn();
    await batchOfOther(es, 90, { statuses: { [`${OTHER_ID}:2`]: "failed" } }); // its automatic retry waits behind it
    open(); // job 1's list fails here (no tab can open): a stop, which takes the retry out of the queue
    for (let turn = 0; turn < 1000 && (journal().length < 2 || element("app-status").dataset["state"] !== "idle"); turn += 1) await es.turn();
    assert.equal(journal()[0]?.["stopped"], "the episode list could not be fetched"); // stored in English
    const alertId = `dramafetch-alert:${module.alerts.page}:90:${OTHER_ID}:retry`;
    assert.equal(notes.shown.get(alertId)?.["title"], "⚠ Drama 2399 — 1 episodio por reintentar");
    assert.equal(notes.shown.get(alertId)?.["contextMessage"], "No se reintentó automáticamente: no se pudo obtener la lista de episodios");
    assert.deepEqual(notes.shown.get(alertId)?.["buttons"], [{ title: "Reintentar" }]);
  } finally {
    es.restore();
  }
});

// ------------------------------------- DramaFetch 2.0.0: no history of past runs, the test journal

test("the test journal (DramaFetch 2.0.0, in place of the stored history): in the test harness' copy each job that ends — and each one a stop takes out of the queue (`not started: …`) — is noted, the most recent first, in the shape the history's entries had (every series' record, its rows included), in the page's memory only — never stored, never shown; the end-to-end harness reads `globalThis.dramafetchJournal`, the same; a reader's copy changes nothing —; outside test mode nothing records jobs", async () => {
  const page = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = page;
    const open = gateJobs();
    assert.equal(paste(page, `${SERIES_ID}\n${OTHER_ID}`), true); // job 1, held at its gate
    await page.turn();
    assert.equal(paste(page, THIRD_ID), true); // job 2, waiting behind it
    element("stop-button").fire("click"); // job 1 meets the Stop before any request: job 2 never starts
    open();
    for (let turn = 0; turn < 1000 && (module.journal().length < 2 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    const entries = module.journal();
    assert.deepEqual(
      entries.map((entry) => [entry["kind"], entry["label"], entry["error"], entry["stopped"]]),
      [
        ["batch", "2 series", "stopped by you", "stopped by you"], // noted last, shown first
        ["batch", `Series ${THIRD_ID}`, `not started: batch stopped in 2 series (stopped by you)`, null],
      ],
    );
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), ["error", "finished_at", "id", "kind", "label", "pauses", "refreshes", "series", "started_at", "stopped"]);
    }
    assert.deepEqual(entries[1]?.["series"], []); // never started: no record
    // never stored, never shown: no key of chrome.storage.local holds it, the page has no list of it
    assert.equal(page.local.has("history"), false);
    for (const [key, value] of page.local) assert.ok(!JSON.stringify(value).includes('"label":"2 series"'), key);
    // what the end-to-end harness reads with `page.evaluate`, the same entries
    assert.deepEqual(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis))["dramafetchJournal"], module.journal());
    // a copy each time: what a reader does with it changes nothing
    const copy = module.journal();
    /** @type {Record<string, unknown>} */ (copy[0])["label"] = "changed";
    assert.equal(module.journal()[0]?.["label"], "2 series");
  } finally {
    page.restore();
  }
  // a job run to its end with its series' records: each with its rows, as the retries read them
  const ran = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = ran;
    assert.equal(paste(ran, SERIES_ID), true); // the discovery can open no tab here: the batch stops at its list
    for (let turn = 0; turn < 1000 && (module.journal().length < 1 || element("app-status").dataset["state"] !== "idle"); turn += 1) await ran.turn();
    const [entry] = module.journal();
    const records = /** @type {Record<string, unknown>[]} */ (entry?.["series"]);
    assert.deepEqual(records.map((record) => record["series_id"]), [SERIES_ID]);
    assert.ok(records.every((record) => Array.isArray(record["rows"]) && typeof record["line"] === "string"));
    assert.ok(Array.isArray(entry?.["pauses"]));
  } finally {
    ran.restore();
  }
  // outside test mode: a job ends (refused at its gate here), and nothing records it
  const now = Date.now() / 1000;
  const plain = await fakePage({ storage: { cooldown: { until: now + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: now } } });
  try {
    const { element, module } = plain;
    assert.deepEqual(plain.message({ type: "dramafetch:load", input: SERIES_ID }), [{ ok: true, tabId: 1 }]);
    for (let turn = 0; turn < 50 && element("app-status").dataset["finished"] !== "1"; turn += 1) await plain.turn();
    assert.equal(element("app-status").dataset["finished"], "1");
    assert.deepEqual(module.journal(), []);
    assert.equal(Object.hasOwn(globalThis, "dramafetchJournal"), false);
    assert.equal(plain.local.has("history"), false);
  } finally {
    plain.restore();
  }
});

test("what an earlier DramaFetch kept and this one never uses is removed once at the page's start, in one call — 1.x's history (DramaFetch 2.0.0) and 3.x's library and its sort (4.0.0) —, those keys alone: the settings, the series' records, the pacing and the cooldown stay —; a removal the storage refuses is ignored: the page starts, no refused write remembered, jobs still run", async () => {
  const now = Date.now() / 1000;
  const kept = {
    settings: { ...DEFAULT_SETTINGS, quality: "best" },
    [`series:${SERIES_ID}`]: savedState(SERIES_ID, [1, 2]),
    pacing: { runAttempts: 2, lastNetworkAt: null, consecutiveFailures: 0, lastContactAt: null },
  };
  const retired = {
    history: [{ id: 1, kind: "batch", label: `Series ${SERIES_ID}`, series: [] }],
    // the library 3.x kept (its dramas' ids, titles and counts, the profile's handle) and its sort
    favoritesLibrary: { v: 1, listedAt: now - 7200, total: 1, countedAt: null, fullReadAt: now - 7200, complete: true, short: false, ended: null, profile: "@invented_viewer", items: [{ seriesId: SERIES_ID, title: "Test Series", episodes: 2, durationS: 158 }] },
    librarySort: "title",
  };
  const page = await fakePage({ storage: { ...kept, ...retired } });
  try {
    for (const key of Object.keys(retired)) assert.equal(page.local.has(key), false, key);
    for (const [key, value] of Object.entries(kept)) assert.deepEqual(page.local.get(key), value, key);
    assert.deepEqual([...page.local.keys()].sort(), Object.keys(kept).sort()); // nothing else removed, nothing added
    assert.deepEqual(page.removed, ["history", "favoritesLibrary", "librarySort"]); // asked once, those keys alone
  } finally {
    page.restore();
  }
  // a cooldown stays too
  const cooldown = { until: now + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: now };
  const cooling = await fakePage({ storage: { cooldown, history: [] } });
  try {
    assert.equal(cooling.local.has("history"), false);
    assert.deepEqual(cooling.local.get("cooldown"), cooldown);
    assert.equal(cooling.element("cooldown-banner").hidden, false);
  } finally {
    cooling.restore();
  }
  // the storage refuses the removal (a full disk): ignored — the page starts all the same, nothing
  // remembered as a refused write, a paste still queues its job
  const refusing = await fakePage({ storage: { history: [], favoritesLibrary: { v: 1, items: [] }, librarySort: "title" }, refuseRemove: true });
  try {
    const { element, module } = refusing;
    for (const key of ["history", "favoritesLibrary", "librarySort"]) assert.equal(refusing.local.has(key), true, key); // left for the next start
    assert.equal(element("app-status").dataset["state"], "idle");
    refusing.hold();
    assert.equal(paste(refusing, SERIES_ID), true);
    await refusing.turn();
    assert.deepEqual(module.queuedJobs().map(jobSummary), [["batch", `Series ${SERIES_ID}`, [SERIES_ID], false, false]]);
    assert.notEqual(element("input-status").className, "status error");
  } finally {
    refusing.restore();
  }
});

test("Past runs is gone (DramaFetch 2.0.0): no card, no header link, no list, no text in either language — nothing on the page reads or shows a past run", () => {
  const html = readFileSync(new URL("../src/app/app.html", import.meta.url), "utf8");
  for (const removed of ["history-card", "history-list", "navHistory", "historyHeading"]) assert.equal(html.includes(removed), false, removed);
  const source = readFileSync(new URL("../src/app/app.js", import.meta.url), "utf8");
  for (const removed of ["history-list", "renderHistory", "readHistory", "appendHistory", "historyRetryButton", "historyFailed", "historySeriesOmitted"]) {
    assert.equal(source.includes(removed), false, removed);
  }
  for (const language of ["en", "es"]) {
    /** @type {Record<string, unknown>} */
    const catalog = JSON.parse(readFileSync(new URL(`../_locales/${language}/messages.json`, import.meta.url), "utf8"));
    for (const key of Object.keys(catalog)) assert.ok(!/^history|^navHistory$/.test(key), `${language}: ${key}`);
  }
});

// --------------- DramaFetch 2.0.0: the countdown in minutes and seconds (C1), the Waiting card (C2)

/**
 * Run `act` with the page's clock — `Date.now`, which its `now()` reads — moved on by what `act`
 * sets with `ahead(seconds)`; the real clock put back after.
 * @param {(ahead: (seconds: number) => void) => Promise<void>} act
 */
async function withClock(act) {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow.call(Date) + offset * 1000;
  try {
    await act((seconds) => {
      offset = seconds;
    });
  } finally {
    Date.now = realNow;
  }
}

test("the pause line (2.0.0): what the pause is, from its kind, with its length and the time left in minutes and seconds — `1 min 07 s` from 60 s up, `45 s` below —, counted down by the page's one-second tick, in English and in Spanish; the job keeps the engine's own English texts; a pause the line has no text for shows the engine's text with the time left", async () => {
  /** @type {[string, number, Record<string, number>][]} kind, length, the engine's counts */
  const pauses = [
    [REST, 95, { downloads: 10 }],
    [REST, 61, { downloads: 1 }],
    [LONG_REST, 1360, { runAttempts: 100 }],
    [PACE, 7, {}],
    [SERIES_REST, 72, {}],
    [JOB_REST, 72, {}],
  ];
  // [the line as the pause starts, the seconds that then pass, the line after them]
  const expected = {
    en: [
      ["Resting 1 min 35 s after 10 downloads — 1 min 35 s left", 28, "Resting 1 min 35 s after 10 downloads — 1 min 07 s left"],
      ["Resting 1 min 01 s after 1 download — 1 min 01 s left", 2, "Resting 1 min 01 s after 1 download — 59 s left"],
      ["Long break of 22 min 40 s after 100 episodes — 22 min 40 s left", 97, "Long break of 22 min 40 s after 100 episodes — 21 min 03 s left"],
      ["Pausing 7 s before the next episode — 7 s left", 3, "Pausing 7 s before the next episode — 4 s left"],
      ["Resting 1 min 12 s before the next drama — 1 min 12 s left", 14, "Resting 1 min 12 s before the next drama — 58 s left"],
      ["Resting 1 min 12 s before contacting TikTok again — 1 min 12 s left", 14, "Resting 1 min 12 s before contacting TikTok again — 58 s left"],
    ],
    es: [
      ["Descanso de 1 min 35 s tras 10 descargas — tiempo restante: 1 min 35 s", 28, "Descanso de 1 min 35 s tras 10 descargas — tiempo restante: 1 min 07 s"],
      ["Descanso de 1 min 01 s tras 1 descarga — tiempo restante: 1 min 01 s", 2, "Descanso de 1 min 01 s tras 1 descarga — tiempo restante: 59 s"],
      ["Pausa larga de 22 min 40 s tras 100 episodios — tiempo restante: 22 min 40 s", 97, "Pausa larga de 22 min 40 s tras 100 episodios — tiempo restante: 21 min 03 s"],
      ["Pausa de 7 s antes del siguiente episodio — tiempo restante: 7 s", 3, "Pausa de 7 s antes del siguiente episodio — tiempo restante: 4 s"],
      ["Descanso de 1 min 12 s antes del siguiente drama — tiempo restante: 1 min 12 s", 14, "Descanso de 1 min 12 s antes del siguiente drama — tiempo restante: 58 s"],
      ["Descanso de 1 min 12 s antes de volver a contactar a TikTok — tiempo restante: 1 min 12 s", 14, "Descanso de 1 min 12 s antes de volver a contactar a TikTok — tiempo restante: 58 s"],
    ],
  };
  await withClock(async (ahead) => {
    for (const language of /** @type {const} */ (["en", "es"])) {
      const page = await fakePage({ language });
      try {
        const { element, module } = page;
        /** @type {import("../src/app/app.js").JobRecord} */
        const jobRecord = { pauses: [], inputs: [], taking: true };
        const engine = module.buildEngine({ ...BATCH_JOB, id: 5, refs: [refOf(SERIES_ID)] }, jobRecord);
        const line = element("progress-pause");
        let at = 0;
        for (const [index, [kind, seconds, counts]] of pauses.entries()) {
          const [first, waited, later] = /** @type {[string, number, string]} */ (expected[language][index]);
          ahead(at);
          engine.onPause?.(kind, seconds, pauseMessage(kind, seconds, counts));
          assert.equal(line.hidden, false, kind);
          assert.equal(line.textContent, first, `${language} ${kind} ${seconds}`);
          at += waited;
          ahead(at);
          page.tick(); // one second of the page's own tick
          assert.equal(line.textContent, later, `${language} ${kind} ${seconds} after ${waited} s`);
          at += 1000; // the next pause starts later
        }
        // the job keeps the engine's English texts, byte for byte the Python tool's, for its report
        assert.deepEqual(
          jobRecord.pauses,
          pauses.map(([kind, seconds, counts]) => ({ kind, seconds, text: pauseMessage(kind, seconds, counts) })),
        );
        assert.equal(jobRecord.pauses[0]?.text, "resting 95 s after 10 downloads");
        // a pause the line has no text of its own for: the engine's text, as the tab shows it, and the time left
        ahead(at);
        engine.onPause?.("nap", 45, "pausing 45 s");
        assert.equal(line.textContent, language === "en" ? "pausing 45 s — 45 s left" : `${displayText("pausing 45 s", { lang: "es" })} — tiempo restante: 45 s`);
        ahead(at + 44.5);
        page.tick();
        assert.equal(line.textContent, language === "en" ? "pausing 45 s — 1 s left" : `${displayText("pausing 45 s", { lang: "es" })} — tiempo restante: 1 s`); // a fraction left is a whole second
        // the pause over (the next episode's row): the line goes
        engine.onResult?.({ episode: episode(1), status: "done", path: "/dl/E1.mp4", message: "saved E1.mp4 (0.1 MiB) + cover embedded", downloadId: 1 });
        assert.equal(line.hidden, true);
        assert.equal(line.textContent, "");
      } finally {
        page.restore();
      }
    }
  });
});

test("the cooldown banner counts down in minutes and seconds too (2.0.0): `30 min 00 s left`, then every second of the page's tick, `45 s left` below a minute — in English and in Spanish", async () => {
  await withClock(async (ahead) => {
    for (const [language, texts] of /** @type {const} */ ([
      ["en", ["30 min 00 s left — nothing contacts TikTok until then.", "28 min 47 s left — nothing contacts TikTok until then.", "45 s left — nothing contacts TikTok until then."]],
      ["es", ["Tiempo restante: 30 min 00 s — nada contacta a TikTok hasta entonces.", "Tiempo restante: 28 min 47 s — nada contacta a TikTok hasta entonces.", "Tiempo restante: 45 s — nada contacta a TikTok hasta entonces."]],
    ])) {
      ahead(0);
      const at = Date.now() / 1000;
      const cooldown = { until: at + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: at };
      const page = await fakePage({ language, storage: { cooldown } });
      try {
        const left = page.element("cooldown-left");
        assert.equal(page.element("cooldown-banner").hidden, false);
        assert.equal(left.textContent, texts[0]);
        ahead(73);
        page.tick();
        assert.equal(left.textContent, texts[1]);
        ahead(1755);
        page.tick();
        assert.equal(left.textContent, texts[2]);
        await page.turn(); // the storage looked at meanwhile (COOLDOWN_LOOK_S) answers
      } finally {
        page.restore();
      }
    }
  });
});

/** Dramas of the Waiting card's tests: three their stored records name (ALPHA, BETA, STORED), one nothing names (GAMMA). */
const ALPHA = "7712345678901234571";
const BETA = "7712345678901234572";
const GAMMA = "7712345678901234573";
const STORED = "7712345678901234574";

test("the Waiting card (2.0.0): one row per drama still to run, in the order they will run — the running batch's dramas not begun yet, then every waiting job's —, each by its name when DramaFetch knows it without asking TikTok (its stored records', a name a run of this page read, a retry's records' — 4.0.0: no library title) and its WHOLE id, else its id and `name shown once its list is read`; every other kind of row says what it is — a Retry and an automatic retry of E02, E07 (ten at most, then `and N more`) — DramaFetch 4.0.0: no See episodes row", async () => {
  const page = await fakePage({
    storage: {
      [`series:${ALPHA}`]: savedState(ALPHA, [], { name: "Alpha Bride" }),
      [`series:${BETA}`]: savedState(BETA, [], { name: "Beta Heir" }),
      [`series:${STORED}`]: savedState(STORED, [1]), // named `A drama` by its records alone
    },
  });
  try {
    const { element, module } = page;
    fakeNotifications();
    // what the page reads of the storage: a name is never asked of TikTok, and the records once
    /** @type {unknown[]} */
    const asked = [];
    const local = /** @type {{get: (keys: unknown) => unknown}} */ (/** @type {unknown} */ (chrome.storage.local));
    const get = local.get;
    local.get = (keys) => (asked.push(keys), get(keys));
    page.hold(); // the batch's tabs.getCurrent never answers: it runs, and asks nothing of anything
    assert.equal(paste(page, `${ALPHA}\n${BETA}\n${GAMMA}`), true); // running: never begun, all three wait
    assert.equal(paste(page, STORED), true); // waiting
    assert.deepEqual(waitingRows(page), [dramaRow(ALPHA), dramaRow(BETA), dramaRow(GAMMA), dramaRow(STORED)]); // none named yet
    await settled(page); // the records of the four read, once: three name their dramas
    assert.deepEqual(waitingRows(page), [dramaRow(ALPHA, "Alpha Bride"), dramaRow(BETA, "Beta Heir"), dramaRow(GAMMA), dramaRow(STORED, "A drama")]);
    const readsOf = (/** @type {string} */ key) => asked.filter((keys) => (Array.isArray(keys) ? keys : [keys]).includes(key)).length;
    for (const id of [ALPHA, BETA, GAMMA, STORED]) assert.equal(readsOf(`series:${id}`), 1, id);
    assert.equal(element("queue-card").hidden, false);
    // the whole id, every digit, in a part of its own one click selects; the note muted apart
    const list = element("queue-list");
    const parts = (/** @type {number} */ index) => (list.children[index]?.children ?? []).map((part) => [part.className, part.textContent]);
    assert.deepEqual(parts(0), [["queue-name", "Alpha Bride"], ["queue-sep", " · "], ["queue-id", ALPHA]]);
    assert.deepEqual(parts(2), [["queue-id", GAMMA], ["queue-sep", " · "], ["queue-note", "name shown once its list is read"]]);
    assert.equal(GAMMA.length, 19);
    assert.equal(list.children[2]?.children[0]?.title, "The drama's whole ID: a click selects it, Ctrl+C copies it.");
    assert.deepEqual(
      list.children.map((row) => [row.className, row.getAttribute("data-kind"), row.getAttribute("data-series-id")]),
      [ALPHA, BETA, GAMMA, STORED].map((id) => ["queue-row download", "download", id]),
    );
    // the Retry of a finished job's two dramas: E02, E07 — and twelve, named as the alerts name them
    module.renderFailed([
      seriesRecord(OTHER_ID, "Drama 2399", [[2, "failed"], [7, "failed"]]),
      seriesRecord(FOURTH_ID, "Drama 2377", Array.from({ length: 12 }, (_, index) => /** @type {[number, string]} */ ([index + 1, "failed"]))),
    ]);
    element("retry-button").fire("click");
    // an automatic retry of E03: a drama of a batch run through the page's own hooks
    await batchOfOther(page, 7, { statuses: { [`${THIRD_ID}:3`]: "failed" } }, undefined, THIRD_ID);
    await settled(page);
    const twelve = "E01, E02, E03, E04, E05, E06, E07, E08, E09, E10 and 2 more";
    assert.deepEqual(waitingRows(page), [
      dramaRow(ALPHA, "Alpha Bride"),
      dramaRow(BETA, "Beta Heir"),
      dramaRow(GAMMA),
      dramaRow(STORED, "A drama"),
      whatRow("Retry E02, E07", OTHER_ID, "Drama 2399"),
      whatRow(`Retry ${twelve}`, FOURTH_ID, "Drama 2377"),
      whatRow("Automatic retry E03", THIRD_ID, "Drama 2388"),
    ]);
    assert.deepEqual(
      list.children.map((row) => row.getAttribute("data-kind")),
      ["download", "download", "download", "download", "retry", "retry", "autoretry"],
    );
    assert.ok(list.children.every((row) => row.getAttribute("data-series-id") !== null)); // every row names its drama
    // the rows as the page holds them: the episodes only where a row names them
    assert.deepEqual(
      module.queueRows().map((row) => [row.kind, row.seriesId, row.numbers]),
      [
        ["download", ALPHA, []],
        ["download", BETA, []],
        ["download", GAMMA, []],
        ["download", STORED, []],
        ["retry", OTHER_ID, [2, 7]],
        ["retry", FOURTH_ID, Array.from({ length: 12 }, (_, index) => index + 1)],
        ["autoretry", THIRD_ID, [3]],
      ],
    );
    // the jobs behind those rows: the batches, then a selection job per Retry and automatic retry
    assert.deepEqual(
      jobsOf(page).map((job) => [job.kind, job.refs.map((ref) => ref.seriesId), job.numbers]),
      [
        ["batch", [ALPHA, BETA, GAMMA], []],
        ["batch", [STORED], []],
        ["selection", [OTHER_ID], [2, 7]],
        ["selection", [FOURTH_ID], Array.from({ length: 12 }, (_, index) => index + 1)],
        ["selection", [THIRD_ID], [3]],
      ],
    );
    // only a drama nothing names is looked up in its records — once —; a name is never asked of TikTok
    assert.equal(readsOf(`series:${GAMMA}`), 1); // never read twice
    for (const named of [OTHER_ID, FOURTH_ID]) assert.equal(readsOf(`series:${named}`), 0, named); // a retry's records name it
  } finally {
    page.restore();
  }
});

test("the Waiting card (2.0.0): hidden while nothing waits; the running batch's dramas leave it as each one's list is read — the next one to run first —; a name a run of this page read — its own list of that drama — names a drama that waits; a read-only tab shows none", async () => {
  const page = await fakePage({
    storage: {
      [`series:${ALPHA}`]: savedState(ALPHA, [], { name: "Alpha Bride" }),
      [`series:${BETA}`]: savedState(BETA, [], { name: "Beta Heir" }),
    },
  });
  try {
    const { element, module } = page;
    fakeNotifications();
    assert.equal(element("queue-card").hidden, true); // nothing waits: no card
    page.hold();
    assert.equal(paste(page, `${ALPHA}\n${BETA}\n${GAMMA}`), true); // job 1, running
    assert.equal(element("queue-card").hidden, false);
    assert.equal(paste(page, OTHER_ID), true); // job 2, waiting
    await settled(page);
    assert.deepEqual(waitingRows(page), [dramaRow(ALPHA, "Alpha Bride"), dramaRow(BETA, "Beta Heir"), dramaRow(GAMMA), dramaRow(OTHER_ID)]);
    // job 1 runs on through the page's own hooks (its engine is the running job's): each drama
    // leaves the card as its list comes, before its first episode
    const running = /** @type {import("../src/app/app.js").Job} */ (module.queuedJobs()[0]);
    /** @type {string[][]} */
    const seen = [];
    const { engine } = scriptedEngine(page, running, { onDownload: (ep) => void (ep.number === 1 && seen.push(waitingRows(page))) });
    // lists that carry no name, in the series or its episodes (the engine names such a drama
    // `series-<id>`: its folder's name, never a name to show)
    engine.discover = async (ref) => ({
      seriesId: ref.seriesId,
      name: null,
      episodes: [1, 2, 3].map((number) => ({ ...episode(number, { seriesId: ref.seriesId }), seriesName: null })),
      totalHint: null,
      warnings: [],
    });
    await runBatch(engine, running.refs);
    assert.deepEqual(seen, [
      [dramaRow(BETA, "Beta Heir"), dramaRow(GAMMA), dramaRow(OTHER_ID)],
      [dramaRow(GAMMA), dramaRow(OTHER_ID)],
      [dramaRow(OTHER_ID)],
    ]);
    // a run of this page that reads the waiting drama's list — an earlier batch of it, run through
    // the page's own hooks — names its row at once (its list calls it `Drama 2399`)
    await batchOfOther(page, 8);
    assert.deepEqual(waitingRows(page), [dramaRow(OTHER_ID, "Drama 2399")]);
    // a drama whose list carried no name is queued again (a Retry): still by its id, never `series-<id>`
    module.renderFailed([seriesRecord(GAMMA, null, [[2, "failed"]])]);
    element("retry-button").fire("click");
    await settled(page);
    assert.deepEqual(waitingRows(page), [dramaRow(OTHER_ID, "Drama 2399"), whatRow("Retry E02", GAMMA)]);
  } finally {
    page.restore();
  }
  const readonly = await fakePage({ lockTaken: true });
  try {
    assert.deepEqual(readonly.message({ type: "dramafetch:load", input: SERIES_ID }), []);
    assert.deepEqual(waitingRows(readonly), []);
    assert.equal(readonly.element("queue-card").hidden, true);
  } finally {
    readonly.restore();
  }
});

test("the Waiting card in Spanish under a Spanish Chrome (2.0.0): what each row is, the note of a drama whose name is not known yet, the id whole", async () => {
  const page = await fakePage({ language: "es", storage: { [`series:${ALPHA}`]: savedState(ALPHA, [], { name: "Alpha Bride" }) } });
  try {
    const { element, module } = page;
    fakeNotifications();
    page.hold();
    assert.equal(paste(page, `${ALPHA}\n${GAMMA}`), true);
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[2, "failed"], [7, "failed"]])]);
    element("retry-button").fire("click");
    await batchOfOther(page, 7, { statuses: { [`${THIRD_ID}:3`]: "failed" } }, undefined, THIRD_ID);
    await settled(page);
    assert.deepEqual(waitingRows(page), [
      `Alpha Bride · ${ALPHA}`,
      `${GAMMA} · el nombre aparece al leer su lista`,
      `Reintentar E02, E07 — Drama 2399 · ${OTHER_ID}`,
      `Reintento automático E03 — Drama 2388 · ${THIRD_ID}`,
    ]);
    assert.equal(element("queue-list").children[1]?.children[0]?.title, "El ID completo del drama: un clic lo selecciona y Ctrl+C lo copia.");
  } finally {
    page.restore();
  }
});

// ------------------------------------------ DramaFetch 4.0.0: nothing is downloaded again in full

test("every download keeps what is on disk (DramaFetch 4.0.0: no See episodes, so nothing is downloaded again in full) — the engine a paste's batch, the popup's hand-over and the tab's Retry get asks Chrome to `uniquify` every file it saves, never to replace one; a Retry's run skips an episode meanwhile on disk with no request; a job's record says nothing of an overwrite", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    page.hold(); // the first job's tabs.getCurrent never answers: it runs, asking nothing; the others wait
    assert.equal(paste(page, OTHER_ID), true); // a paste: a batch
    page.message({ type: "dramafetch:load", input: THIRD_ID }); // the popup's Download this series: a batch
    module.renderFailed([seriesRecord(SERIES_ID, "Test Series", [[1, "done"], [2, "failed"]])]);
    element("retry-button").fire("click"); // the tab's Retry: a selection job of E02
    await settled(page);
    const jobs = module.queuedJobs();
    assert.deepEqual(
      jobs.map((job) => [job.kind, job.refs.map((ref) => ref.seriesId), job.numbers]),
      [
        ["batch", [OTHER_ID], []],
        ["batch", [THIRD_ID], []],
        ["selection", [SERIES_ID], [2]],
      ],
    );
    const bytes = new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]);
    for (const [index, job] of jobs.entries()) {
      for (const gone of ["overwrite", "pick", "series"]) assert.equal(Object.hasOwn(job, gone), false, `${job.label}: ${gone}`);
      // its engine (another id: the running job's record stays its own) and its downloader's own save
      const engine = module.buildEngine({ ...job, id: 990 + index }, { pauses: [], inputs: [], taking: true });
      assert.equal(Object.hasOwn(engine, "overwrite"), false, job.label);
      assert.equal(Object.hasOwn(engine.downloader.config, "overwrite"), false, job.label);
      await engine.downloader.save(bytes, "video/mp4", `DramaFetch/Test Series [${SERIES_ID}]/Test Series - Episode 0${index + 1}.mp4`);
    }
    assert.deepEqual(
      page.downloads.map((saved) => saved.conflictAction),
      ["uniquify", "uniquify", "uniquify"],
    );
    // the Retry's run, through the page's own engine: E02 — on disk meanwhile, its records say — is
    // skipped with no request, as every retry before DramaFetch 3.0.0 skipped it
    const retry = /** @type {import("../src/app/app.js").Job} */ (jobs[2]);
    /** @type {number[]} */
    const asked = [];
    const scripted = scriptedEngine(page, { ...retry, id: 995 }, { onDownload: (ep) => void asked.push(ep.number) });
    scripted.states.set(SERIES_ID, savedState(SERIES_ID, [2], { name: "Test Series" }));
    const run = await runSelectionJob(scripted.engine, refOf(SERIES_ID), retry.numbers, { lastContactAt: null });
    assert.deepEqual(
      run.results.map((result) => [result.episode.number, result.status, result.message]),
      [[2, "skipped-exists", "already downloaded (manifest): E2.mp4"]],
    );
    assert.deepEqual(asked, []);
  } finally {
    page.restore();
  }
  // run through the page's own queue to its end: the job's record holds its rows and what the
  // retries read — and nothing that would make a retry of it download again in full
  const queued = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = queued;
    assert.equal(paste(queued, SERIES_ID), true); // the discovery can open no tab here: no request at all
    for (let turn = 0; turn < 500 && (module.journal().length < 1 || element("app-status").dataset["state"] !== "idle"); turn += 1) await queued.turn();
    const [entry] = module.journal();
    assert.equal(entry?.["kind"], "batch");
    const [record] = /** @type {Record<string, unknown>[]} */ (entry?.["series"]);
    // 3.0.1: the list's warnings too (`warnings`) — and still no `overwrite`
    assert.deepEqual(Object.keys(record ?? {}).sort(), ["contacted", "error", "error_kind", "line", "name", "report", "rows", "series_id", "status", "stop", "warnings"]);
  } finally {
    queued.restore();
  }
});

// ------------------------------- DramaFetch 3.0.1: no episode left out of TikTok's list without a word

test("3.0.1, the page: the list's warnings show under the drama's header for a paste too — muted information, warn-coloured when the list itself is short —, in the page's language; none for a drama found complete", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const engine = module.buildEngine({ ...BATCH_JOB, refs: [refOf(SERIES_ID)] }, { pauses: [], inputs: [], taking: true });
    const body = element("result-table").querySelector("tbody");
    // a whole list with an item DramaFetch could not read: information only
    const whole = { ...series([episode(1), episode(2)]), totalHint: 2, itemsReceived: 3, missingNumbers: [], earlyEnd: null, warnings: ["TikTok listed 1 item DramaFetch could not read (no episode number)"] };
    engine.onStart?.({ ref: refOf(SERIES_ID), series: whole, name: "Test Series", episodes: whole.episodes, skippedComplete: false });
    // a short list: TikTok counts 4, the pagination fell back, E04 never came
    const short = { ...series([episode(1, { seriesId: OTHER_ID }), episode(2, { seriesId: OTHER_ID }), episode(3, { seriesId: OTHER_ID })], "Two", OTHER_ID), totalHint: 4, itemsReceived: 3, missingNumbers: [4], earlyEnd: EARLY_END, warnings: [EARLY_END, "TikTok announces 4 episodes, 3 listed"] };
    engine.onStart?.({ ref: refOf(OTHER_ID), series: short, name: "Two", episodes: short.episodes, skippedComplete: false });
    // skipped as complete: no list, no warning
    engine.onStart?.({ ref: refOf(THIRD_ID), series: null, name: "Three", episodes: [], skippedComplete: true });
    const rows = body.children.map((row) => [row.className, row.getAttribute("data-series-id"), row.children[0]?.textContent]);
    assert.deepEqual(rows, [
      ["series-row", SERIES_ID, "Test Series"],
      ["series-warning", SERIES_ID, "TikTok listed 1 item DramaFetch could not read (no episode number)"],
      ["series-row", OTHER_ID, "Two"],
      ["series-warning warn", OTHER_ID, EARLY_END],
      ["series-warning warn", OTHER_ID, "TikTok announces 4 episodes, 3 listed"],
      ["series-row", THIRD_ID, "Three — complete on disk, nothing to do"],
    ]);
    // a warning row is no failure: the job's end keeps it with its header
    module.renderFailed([seriesRecord(OTHER_ID, "Two", [[1, "done"], [4, "failed-unavailable", NOT_LISTED_EARLY_END_MESSAGE]])]);
    assert.ok(body.children.some((row) => row.className === "series-warning warn" && row.getAttribute("data-series-id") === OTHER_ID));
  } finally {
    page.restore();
  }
  const spanish = await fakePage({ language: "es" });
  try {
    const engine = spanish.module.buildEngine({ ...BATCH_JOB, refs: [refOf(OTHER_ID)] }, { pauses: [], inputs: [], taking: true });
    const short = { ...series([episode(1, { seriesId: OTHER_ID })], "Dos", OTHER_ID), totalHint: 3, itemsReceived: 1, missingNumbers: [2, 3], earlyEnd: null, warnings: ["episodes 2-3 missing (gap)", "TikTok announces 3 episodes, 1 listed"] };
    engine.onStart?.({ ref: refOf(OTHER_ID), series: short, name: "Dos", episodes: short.episodes, skippedComplete: false });
    const texts = spanish.element("result-table").querySelector("tbody").children.filter((row) => row.className.startsWith("series-warning")).map((row) => row.children[0]?.textContent);
    assert.deepEqual(texts, ["faltan los episodios 2-3 (hay un hueco)", "TikTok anuncia 3 episodios, 1 listado"]);
  } finally {
    spanish.restore();
  }
});

test("3.0.1 (the lead's D2), the page: an uncertain list's warnings are warn-coloured — TikTok counts more than the drama certainly has —, and muted information once everything TikTok counts is placed", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const engine = module.buildEngine({ ...BATCH_JOB, refs: [refOf(SERIES_ID)] }, { pauses: [], inputs: [], taking: true });
    const body = element("result-table").querySelector("tbody");
    // TikTok counts 4; three episodes and a trailer came: nothing named missing, but uncertain
    const uncertain = {
      ...series([episode(1), episode(2), episode(3)]),
      totalHint: 4,
      itemsReceived: 4,
      missingNumbers: [],
      earlyEnd: null,
      warnings: ["TikTok listed 1 item DramaFetch could not read (no episode number)", "TikTok announces 4 episodes, 3 listed", uncertainText(4, 3, 1)],
    };
    engine.onStart?.({ ref: refOf(SERIES_ID), series: uncertain, name: "Test Series", episodes: uncertain.episodes, skippedComplete: false });
    // TikTok counts 3 for three episodes and a trailer: everything it counts is placed
    const placed = { ...series([episode(1, { seriesId: OTHER_ID }), episode(2, { seriesId: OTHER_ID }), episode(3, { seriesId: OTHER_ID })], "Two", OTHER_ID), totalHint: 3, itemsReceived: 4, missingNumbers: [], earlyEnd: null, warnings: ["TikTok listed 1 item DramaFetch could not read (no episode number)"] };
    engine.onStart?.({ ref: refOf(OTHER_ID), series: placed, name: "Two", episodes: placed.episodes, skippedComplete: false });
    const rows = body.children.filter((row) => row.className.startsWith("series-warning")).map((row) => [row.className, row.getAttribute("data-series-id")]);
    assert.deepEqual(rows, [
      ["series-warning warn", SERIES_ID],
      ["series-warning warn", SERIES_ID],
      ["series-warning warn", SERIES_ID],
      ["series-warning", OTHER_ID],
    ]);
  } finally {
    page.restore();
  }
});

test("3.0.1, the page: a paste whose list still lacks episodes gives each its row in Did not download — `missing from the list`, `not in TikTok's list` —, counted in the heading and the Retry, which queues them as a selection job (a fresh listing, then those numbers); its alert is ⚠ naming them apart", async () => {
  const page = await fakePage({ storage: NO_AUTO_RETRY });
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    page.hold();
    // TikTok counts 6 for Drama 2399; its list leaves E02 and E06 out (a hole and the last one); E04 fails plainly
    const { runs } = await batchOfOther(page, 5, { episodes: 6, absent: { [OTHER_ID]: [2, 6] }, statuses: { [`${OTHER_ID}:4`]: "failed" } });
    const [run] = runs;
    assert.ok(run !== undefined);
    assert.deepEqual(run.results.map((r) => [r.episode.number, r.status]), [[1, "done"], [3, "done"], [4, "failed"], [5, "done"], [2, "failed-unavailable"], [6, "failed-unavailable"]]);
    assert.equal(reportLine(run.report), "incomplete: 3 of 6 — 1 failed (4); episodes 2, 6 missing from TikTok's list");
    // the job's end: its records → the Did not download block
    module.renderFailed(recordsOf(runs));
    assert.equal(element("failed-block").hidden, false);
    assert.equal(element("failed-heading").textContent, "Did not download (3)");
    const failed = element("failed-table").querySelector("tbody").children;
    assert.deepEqual(
      failed.map((row) => [row.getAttribute("data-number"), row.getAttribute("data-status"), row.children[2]?.children[0]?.textContent, row.children[3]?.textContent]),
      [
        ["2", "failed-unavailable", "missing from the list", NOT_LISTED_MESSAGE],
        ["4", "failed", "failed", "failed 4"],
        ["6", "failed-unavailable", "missing from the list", NOT_LISTED_MESSAGE],
      ],
    );
    assert.equal(element("retry-button").textContent, "Retry the episodes that did not download (3)");
    // what its Retry takes: those numbers, the missing ones named
    assert.deepEqual(module.retryTargets(recordsOf(runs)), [{ seriesId: OTHER_ID, name: "Drama 2399", numbers: [2, 4, 6], missing: [2, 6] }]);
    // its alert (the setting off: no automatic retry): ⚠ with its Retry, the missing ones named apart
    const id = `dramafetch-alert:${module.alerts.page}:5:${OTHER_ID}:retry`;
    assert.equal(notes.shown.get(id)?.["title"], "⚠ Drama 2399 — 3 episodes to retry");
    assert.equal(notes.shown.get(id)?.["message"], "E04 did not download. E02, E06 are not in TikTok's list.");
    assert.deepEqual(notes.shown.get(id)?.["buttons"], [{ title: "Retry" }]);
    assert.deepEqual(module.alerts.retryOf(id)?.numbers, [2, 4, 6]);
    element("retry-button").fire("click");
    await page.turn();
    assert.deepEqual(jobsOf(page), [
      { kind: "selection", label: "Retry 3 of Drama 2399", refs: [refOf(OTHER_ID)], numbers: [2, 4, 6], includeLocked: false, recheck: false, missing: [2, 6] },
    ]);
  } finally {
    page.restore();
  }
});

test("3.0.1, the automatic retry takes the episodes TikTok's list lacked too — once, its “retrying” alert naming them —; its fresh list still without them: `not in TikTok's list this time`, the ⚠ alert with its Retry, never a second round; never after a stop, never in a cooldown", async () => {
  const page = await fakePage();
  try {
    const { module } = page;
    const notes = fakeNotifications();
    page.hold();
    const first = await batchOfOther(page, 9, { episodes: 5, absent: { [OTHER_ID]: [5] } });
    const alertId = `dramafetch-alert:${module.alerts.page}:9:${OTHER_ID}:retry`;
    const [auto] = module.queuedJobs();
    assert.ok(auto !== undefined);
    assert.deepEqual(jobsOf(page), [
      { kind: "selection", label: "Automatic retry: 1 of Drama 2399", refs: [refOf(OTHER_ID)], numbers: [5], includeLocked: false, recheck: false, missing: [5], autoRetry: { alertId, name: "Drama 2399" } },
    ]);
    assert.equal(notes.shown.get(alertId)?.["title"], "↻ Drama 2399 — retrying 1 episode");
    assert.equal(notes.shown.get(alertId)?.["message"], "E05 is not in TikTok's list. DramaFetch tries once more on its own.");
    assert.equal(notes.shown.get(alertId)?.["buttons"], undefined);
    // the automatic retry's own run: a fresh list, still without E05 — its row, no request, its ⚠ with its Retry
    const scripted = scriptedEngine(page, auto, { episodes: 5, absent: { [OTHER_ID]: [5] } });
    scripted.states.set(OTHER_ID, first.states.get(OTHER_ID));
    const run = await runSelectionJob(scripted.engine, refOf(OTHER_ID), auto.numbers, { lastContactAt: null });
    assert.deepEqual(run.results.map((r) => [r.episode.number, r.status, r.message]), [[5, "failed-unavailable", NOT_LISTED_AGAIN_MESSAGE]]);
    module.dramaDone(auto, run, scripted.jobRecord);
    await page.turn();
    assert.deepEqual(notes.shown.get(alertId), {
      type: "basic",
      iconUrl: ALERT_ICON_URL,
      title: "⚠ Drama 2399 — 1 episode to retry",
      message: "E05 is not in TikTok's list.",
      contextMessage: "After an automatic retry.",
      priority: 0,
      requireInteraction: false,
      silent: false,
      buttons: [{ title: "Retry" }],
    });
    assert.deepEqual(module.alerts.retryOf(alertId), { seriesId: OTHER_ID, name: "Drama 2399", numbers: [5], missing: [5] });
    assert.equal(jobsOf(page).length, 1); // the automatic retry alone: no second round
    assert.equal(scripted.jobRecord.autoRetried, undefined);
  } finally {
    page.restore();
  }
  // a run that stopped (a 429): no automatic retry, even of a missing number
  const stopped = await fakePage();
  try {
    stopped.hold();
    fakeNotifications();
    const { runs } = await batchOfOther(stopped, 3, { episodes: 4, absent: { [OTHER_ID]: [4] }, statuses: { [`${OTHER_ID}:2`]: "failed-rate-limited" } });
    assert.equal(runs[0]?.stop, true);
    assert.ok(runs[0]?.results.some((r) => r.episode.number === 4 && r.message === NOT_LISTED_MESSAGE)); // still said
    assert.deepEqual(jobsOf(stopped), []);
  } finally {
    stopped.restore();
  }
  // a cooldown in force: none either
  const now = Date.now() / 1000;
  const cooling = await fakePage({ storage: { cooldown: { until: now + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: now } } });
  try {
    cooling.hold();
    fakeNotifications();
    await batchOfOther(cooling, 3, { episodes: 4, absent: { [OTHER_ID]: [4] } });
    assert.deepEqual(jobsOf(cooling), []);
  } finally {
    cooling.restore();
  }
});

test("3.0.1, the alert of an automatic retry that never ran names the episodes TikTok's list lacked apart, with its Retry", async () => {
  const page = await fakePage();
  try {
    const { module } = page;
    const notes = fakeNotifications();
    const alertId = `dramafetch-alert:${module.alerts.page}:3:${OTHER_ID}:retry`;
    module.alertNotRetried({ refs: [refOf(OTHER_ID)], numbers: [2, 5], autoRetry: { alertId, name: "Drama 2399" }, missing: [5] }, "stopped by you");
    assert.equal(notes.shown.get(alertId)?.["message"], "E02 did not download. E05 is not in TikTok's list.");
    assert.equal(notes.shown.get(alertId)?.["contextMessage"], "Not retried automatically: stopped by you");
    assert.deepEqual(module.alerts.retryOf(alertId), { seriesId: OTHER_ID, name: "Drama 2399", numbers: [2, 5], missing: [5] });
    // one that ran and saved E02 before Stop: only E05 is left, named so
    module.alertNotRetried({ refs: [refOf(OTHER_ID)], numbers: [2, 5], autoRetry: { alertId, name: "Drama 2399" }, missing: [5] }, "stopped by you", [2]);
    assert.equal(notes.shown.get(alertId)?.["message"], "E05 is not in TikTok's list.");
    assert.deepEqual(module.alerts.retryOf(alertId), { seriesId: OTHER_ID, name: "Drama 2399", numbers: [5], missing: [5] });
  } finally {
    page.restore();
  }
});

/**
 * The result table's body of a fake page as Chrome keeps it (3.0.1, the lead's D13, the review's T4):
 * `renderResult` looks for an episode's row first (`tr[data-key="…"]`) and appends one when none is
 * there — the fake's own lookup finds a stand-in every time, so none of its rows would stay. With
 * this, the rows the engine's `onResult` draws stay in `body.children`, as the page drew them.
 * @param {FakeElement} body
 */
function keepRows(body) {
  const lookup = body.querySelector.bind(body);
  body.querySelector = /** @type {FakeElement["querySelector"]} */ (
    /** @type {unknown} */ (
      (/** @type {string} */ selector) => {
        const key = /^tr\[data-key="(.*)"\]$/.exec(selector)?.[1];
        if (key === undefined) return lookup(selector);
        return body.children.find((row) => row.getAttribute("data-key") === key) ?? null;
      }
    )
  );
}

test("3.0.1 (§9), the page: a free episode DramaFetch only guessed was locked reads `not downloaded (free)`, failure-coloured — a lock of TikTok's keeps `locked, skipped` —, the trimming keeps it; it goes under Did not download beside the failures; the Retry queues one selection job per drama and kind — the failures as ever, the guessed ones asking for them anyway —; the automatic retry never takes it; the drama's alert is ⚠ naming it with its hint", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    fakeNotifications();
    page.hold();
    const results = element("result-table").querySelector("tbody");
    keepRows(results); // the rows the engine's onResult draws stay, as in Chrome (T4)
    /** @type {FakeElement[]} the live table as the drama ends — before its automatic retry's job starts and empties it */
    let drawn = [];
    const { runs } = await batchOfOther(page, 7, { episodes: 4, statuses: { [`${OTHER_ID}:2`]: "failed" }, guessed: { [OTHER_ID]: [3] }, locked: { [OTHER_ID]: [4] } }, (engine) => {
      const done = engine.onSeriesDone;
      engine.onSeriesDone = (index, total, finished) => {
        drawn = [...results.children];
        done?.(index, total, finished);
      };
    });
    const [run] = runs;
    // E03 skipped like the locked E04 — no request —, but not downloaded: the drama is not complete
    assert.deepEqual(run?.results.map((result) => [result.episode.number, result.status]), [
      [1, "done"],
      [2, "failed"],
      [3, "skipped-locked"],
      [4, "skipped-locked"],
    ]);
    assert.equal(run?.report.complete, false);
    assert.deepEqual([run?.report.guessedLockedNumbers, run?.report.lockedNumbers], [[3], [4]]);
    // its line names it apart
    assert.equal(
      element("report-lines").children.at(-1)?.textContent,
      "Drama 2399: incomplete: 1 of 4 — 1 locked (4), 1 failed (2); 1 free episode not asked for (3): TikTok's list made it look locked",
    );
    // the live table as renderResult drew it through the engine's onResult (3.0.1, the lead's D13,
    // the review's T4): E03 marked `data-guessed`, its badge `not downloaded (free)` in the failure
    // colour — the locked E04 keeps `locked, skipped`
    const episodeRows = () => results.children.filter((row) => row.getAttribute("data-number") !== null);
    results.replaceChildren(...drawn);
    assert.deepEqual(
      episodeRows().map((row) => [
        row.getAttribute("data-number"),
        row.getAttribute("data-status"),
        row.getAttribute("data-guessed"),
        row.children[1]?.children[0]?.textContent,
        row.children[1]?.children[0]?.className,
      ]),
      [
        ["1", "done", null, "downloaded", "badge done"],
        ["2", "failed", null, "failed", "badge failed"],
        ["3", "skipped-locked", "1", "not downloaded (free)", "badge failed"],
        ["4", "skipped-locked", null, "locked, skipped", "badge skipped"],
      ],
    );
    // the trimming takes what completed, never a row that did not download
    module.trimResultRows(1);
    assert.deepEqual(
      episodeRows().map((row) => row.getAttribute("data-number")),
      ["2", "3"],
    );
    // the automatic retry (1.8.0) takes E02 only: never an episode DramaFetch judged locked
    assert.deepEqual(
      module.queuedJobs().map((job) => [job.numbers, job.askGuessed === true, job.autoRetry !== undefined]),
      [[[2], false, true]],
    );
    // the job's end: E02 and E03 under Did not download, E03 with its own badge — the records as
    // the page writes them (the real runRecord, 3.0.1, the lead's D13, the review's T3)
    module.renderFailed(runs.map((one) => module.runRecord(one)));
    const failed = element("failed-table").querySelector("tbody");
    assert.deepEqual(
      failed.children.map((row) => [
        row.getAttribute("data-number"),
        row.getAttribute("data-status"),
        row.getAttribute("data-guessed"),
        row.children[2]?.children[0]?.textContent,
        row.children[2]?.children[0]?.className,
      ]),
      [
        ["2", "failed", null, "failed", "badge failed"],
        ["3", "skipped-locked", "1", "not downloaded (free)", "badge failed"],
      ],
    );
    assert.equal(element("failed-heading").textContent, "Did not download (2)");
    assert.equal(element("retry-button").textContent, "Retry the episodes that did not download (2)");
    // the Retry: E02's job is the automatic retry's already; E03 gets a job of its own that asks for it anyway
    element("retry-button").fire("click");
    await page.turn();
    assert.deepEqual(
      module.queuedJobs().map((job) => [job.numbers, job.includeLocked, job.askGuessed === true, job.autoRetry !== undefined]),
      [
        [[2], false, false, true],
        [[3], false, true, false],
      ],
    );
    assert.deepEqual(waitingRows(page), [whatRow("Retry E03", OTHER_ID, "Drama 2399")]);
  } finally {
    page.restore();
  }
  // the alert of such a drama (no automatic retry): ⚠ naming both kinds, the guessed one with its
  // hint; its Retry queues the same two jobs
  const quiet = await fakePage({ storage: NO_AUTO_RETRY });
  try {
    const { module } = quiet;
    const notes = fakeNotifications();
    quiet.hold();
    await batchOfOther(quiet, 7, { episodes: 4, statuses: { [`${OTHER_ID}:2`]: "failed" }, guessed: { [OTHER_ID]: [3] }, locked: { [OTHER_ID]: [4] } });
    const id = module.alerts.idOf(7, `${OTHER_ID}:retry`);
    assert.equal(notes.shown.get(id)?.["title"], "⚠ Drama 2399 — 2 episodes to retry");
    assert.equal(notes.shown.get(id)?.["message"], "E02 did not download. E03 was not asked for: TikTok's list made it look locked (no play address).");
    assert.deepEqual(notes.shown.get(id)?.["buttons"], [{ title: "Retry" }]);
    assert.deepEqual(module.alerts.retryOf(id), { seriesId: OTHER_ID, name: "Drama 2399", numbers: [2, 3], guessed: [3] });
    assert.deepEqual(
      module.retryJobs([/** @type {import("../src/app/app.js").RetryTarget} */ (module.alerts.retryOf(id))]).map((job) => [job.numbers, job.askGuessed === true, job.label]),
      [
        [[2], false, "Retry 1 of Drama 2399"],
        [[3], true, "Retry 1 of Drama 2399"],
      ],
    );
  } finally {
    quiet.restore();
  }
});

test("3.0.1 (§9), a selection's alert: a free episode the job did not take, which its report counts as a guessed lock, is named and retried too — never ✓ while one is left", async () => {
  const page = await fakePage({ storage: NO_AUTO_RETRY });
  try {
    const { module } = page;
    const notes = fakeNotifications();
    page.hold();
    const job = { ...BATCH_JOB, id: 9, kind: /** @type {const} */ ("selection"), refs: [refOf(OTHER_ID)], numbers: [1, 2] };
    const scripted = scriptedEngine(page, job, { episodes: 3, guessed: { [OTHER_ID]: [3] } });
    const run = await runSelectionJob(scripted.engine, refOf(OTHER_ID), [1, 2], { lastContactAt: null });
    assert.deepEqual(run.results.map((result) => [result.episode.number, result.status]), [
      [1, "done"],
      [2, "done"],
    ]);
    assert.deepEqual([run.report.complete, run.report.guessedLockedNumbers], [false, [3]]);
    module.dramaDone(job, run, scripted.jobRecord);
    const id = module.alerts.idOf(9, `${OTHER_ID}:retry`);
    assert.equal(notes.shown.get(id)?.["title"], "⚠ Drama 2399 — 1 episode to retry");
    assert.equal(notes.shown.get(id)?.["message"], "E03 was not asked for: TikTok's list made it look locked (no play address).");
    assert.deepEqual(module.alerts.retryOf(id), { seriesId: OTHER_ID, name: "Drama 2399", numbers: [3], guessed: [3] });
  } finally {
    page.restore();
  }
});

test("3.0.1 (§11), the page: every job's outcome stays on screen — a second paste keeps the first drama's line and its rows in Did not download, with its Retry; a drama's retry replaces only the numbers it took; each line styled by its outcome, the newest MAX_REPORT_LINES kept", async () => {
  const page = await fakePage({ storage: NO_AUTO_RETRY });
  try {
    const { element, module } = page;
    fakeNotifications();
    page.hold();
    // drama A: E02 failed, E05 missing from TikTok's list
    const first = await batchOfOther(page, 7, { episodes: 5, statuses: { [`${OTHER_ID}:2`]: "failed" }, absent: { [OTHER_ID]: [5] } });
    module.renderFailed(first.runs.map((one) => module.runRecord(one)));
    // drama B, complete
    const second = await batchOfOther(page, 8, {}, undefined, THIRD_ID);
    module.renderFailed(second.runs.map((one) => module.runRecord(one)));
    const lines = element("report-lines");
    assert.deepEqual(
      lines.children.map((line) => [line.getAttribute("data-series-id"), line.className]),
      [
        [OTHER_ID, "incomplete"],
        [THIRD_ID, "complete"],
      ],
    );
    const failed = element("failed-table").querySelector("tbody");
    const blockRows = () => failed.children.map((row) => [row.getAttribute("data-series-id"), row.getAttribute("data-number"), row.children[3]?.textContent]);
    assert.deepEqual(blockRows(), [
      [OTHER_ID, "2", "failed 2"],
      [OTHER_ID, "5", NOT_LISTED_MESSAGE],
    ]);
    assert.equal(element("failed-heading").textContent, "Did not download (2)");
    // a third job starts (a paste): the lines and the block stay, the Retry with them
    assert.equal(paste(page, SERIES_ID), true);
    await page.turn();
    assert.equal(element("app-status").dataset["state"], "running");
    assert.equal(lines.children.length, 2);
    assert.equal(element("failed-block").hidden, false);
    assert.deepEqual(blockRows().length, 2);
    assert.equal(element("retry-button").disabled, false);
    // drama A's retry of E02 saved it, E05 is still not in the list: E02 leaves, E05 stays with its new message
    module.renderFailed([
      {
        series_id: OTHER_ID,
        name: "Drama 2399",
        rows: [
          { number: 2, status: "done", message: "saved" },
          { number: 5, status: "failed-unavailable", message: NOT_LISTED_AGAIN_MESSAGE },
        ],
      },
    ]);
    assert.deepEqual(blockRows(), [[OTHER_ID, "5", NOT_LISTED_AGAIN_MESSAGE]]);
    assert.equal(element("failed-heading").textContent, "Did not download (1)");
  } finally {
    page.restore();
  }
  // a batch of 503 dramas: the newest 500 lines stay, the oldest go first
  const many = await fakePage({ storage: NO_AUTO_RETRY });
  try {
    const { element, module } = many;
    assert.equal(module.MAX_REPORT_LINES, 500);
    many.hold();
    const refs = Array.from({ length: 503 }, (_, index) => refOf(`77000000000000${String(index).padStart(5, "0")}`));
    const job = { ...BATCH_JOB, id: 11, refs };
    const { engine } = scriptedEngine(many, job, { episodes: 1 });
    await runBatch(engine, refs);
    const lines = element("report-lines").children;
    assert.equal(lines.length, 500);
    assert.equal(lines[0]?.getAttribute("data-series-id"), refs[3]?.seriesId);
    assert.equal(lines.at(-1)?.getAttribute("data-series-id"), refs[502]?.seriesId);
    assert.ok(lines.every((line) => line.className === "complete"));
  } finally {
    many.restore();
  }
});

test("3.0.1 (§9), the downloader of a Retry of free episodes DramaFetch guessed were locked (`askGuessed`): it asks for such an episode — one request, saved whole — while a lock of TikTok's (a price, a lock flag) stays skipped with no request; without `askGuessed` both are skipped, as ever", async () => {
  const media = () => new Response(video(), { headers: { "content-type": "video/mp4", "content-length": String(128 * 1024) } });
  const routes = { "https://v16-webapp-prime.tiktok.com/": media, "https://p16-sign-sg.tiktokcdn.com/": () => new Response(COVER, { headers: { "content-type": "image/jpeg" } }) };
  const urls = ["https://v16-webapp-prime.tiktok.com/v/3.mp4?expire=99999999999"];
  // E03: a short header guessed it locked — its play URL is there; E04: TikTok's own lock flag
  const guessed = makeEpisode({ ...episode(3), access: "locked", lockHints: ["plays 2 s of 3 s"], guessedLock: true, raw: { id: "item3", video: { playAddr: urls } } });
  const flagged = makeEpisode({ ...episode(4), access: "locked", paid: true, lockHints: ["isLocked=True"], raw: { id: "item4", video: { playAddr: urls } } });
  /** @type {string[]} */
  const log = [];
  const asking = downloader({ fetch: fakeFetch(routes, log), askGuessed: true, thumbnail: "none" });
  assert.equal(asking.asks(guessed), true);
  assert.equal(asking.asks(flagged), false);
  assert.equal(asking.needsNetwork(guessed, CONTEXT), true);
  assert.equal(asking.needsNetwork(flagged, CONTEXT), false);
  const result = await asking.download(guessed, CONTEXT);
  assert.equal(result.status, "done");
  assert.equal(log.length, 1); // one request, the usual one
  const refused = await asking.download(flagged, CONTEXT);
  assert.deepEqual([refused.status, refused.message], ["skipped-locked", "looks locked: isLocked=True"]);
  assert.equal(log.length, 1); // none for it
  // without askGuessed (a paste, the automatic retry, any other job): skipped, no request
  /** @type {string[]} */
  const quiet = [];
  const plain = downloader({ fetch: fakeFetch(routes, quiet), thumbnail: "none" });
  assert.equal(plain.asks(guessed), false);
  assert.equal(plain.needsNetwork(guessed, CONTEXT), false);
  assert.deepEqual([(await plain.download(guessed, CONTEXT)).status, quiet.length], ["skipped-locked", 0]);
});


test("3.0.1 (§9), a guessed lock with no play address asked for anyway: one fresh episode list decides — still guessed and still no URL: `failed-unavailable`, no media request; now locked by TikTok (a lock flag): refused, its URLs never requested; now with a URL: downloaded", async () => {
  /** @param {Record<string, unknown>} fresh the fresh list's item for E03 @param {string[]} log */
  const subject = (fresh, log) => {
    const asking = downloader({
      fetch: fakeFetch({ "https://v16-webapp-prime.tiktok.com/": () => new Response(video(), { headers: { "content-type": "video/mp4", "content-length": String(128 * 1024) } }) }, log),
      askGuessed: true,
      thumbnail: "none",
    });
    let listings = 0;
    asking.config.rediscover = async () => {
      listings += 1;
      const item = { id: "item3", ...fresh };
      return { seriesId: SERIES_ID, name: "Test Series", episodes: [makeEpisode({ ...episode(3), itemId: "item3", raw: item })], totalHint: null, warnings: [] };
    };
    return { asking, listings: () => listings };
  };
  const guessed = makeEpisode({ ...episode(3), itemId: "item3", access: "locked", lockHints: ["no play address"], guessedLock: true, raw: { id: "item3", video: {} } });
  const url = "https://v16-webapp-prime.tiktok.com/v/3.mp4?expire=99999999999";
  /** @type {string[]} */
  const still = [];
  const one = subject({ video: {} }, still);
  const result = await one.asking.download(guessed, CONTEXT);
  assert.equal(result.status, "failed-unavailable");
  assert.match(result.message, /no play url, even in a fresh episode list/);
  assert.deepEqual([one.listings(), still.length], [1, 0]);
  /** @type {string[]} */
  const flaggedLog = [];
  const two = subject({ dramaInfo: { isLocked: true }, video: { playAddr: [url] } }, flaggedLog);
  const flagged = await two.asking.download({ ...guessed }, CONTEXT);
  assert.equal(flagged.status, "failed-unavailable");
  assert.match(flagged.message, /locked in a fresh episode list: isLocked=True/);
  assert.deepEqual([two.listings(), flaggedLog.length], [1, 0]);
  /** @type {string[]} */
  const servedLog = [];
  const three = subject({ video: { playAddr: [url] } }, servedLog);
  const served = await three.asking.download({ ...guessed }, CONTEXT);
  assert.equal(served.status, "done");
  assert.deepEqual([three.listings(), servedLog.length], [1, 1]);
});

test("3.0.1 (the lead's D12, the review's M3): the batch table counts the free episodes DramaFetch did not ask for — TikTok's list made them look locked — in a column of their own, `Not asked` (`Sin pedir`), between Locked and Failed; a locked one TikTok's list gives no reason to doubt stays under Locked", async () => {
  // the header, in the page's order, and its words in both languages
  const html = readFileSync(new URL("../src/app/app.html", import.meta.url), "utf8");
  const head = /<table id="batch-table"[\s\S]*?<\/thead>/.exec(html)?.[0] ?? "";
  assert.deepEqual(
    [...head.matchAll(/data-i18n="([A-Za-z]+)"/g)].map((match) => match[1]),
    ["colSeries", "colStatus", "colListed", "colDone", "colOnDisk", "colLocked", "colNotAsked", "colFailed"],
  );
  for (const [language, words] of [
    ["en", "Not asked"],
    ["es", "Sin pedir"],
  ]) {
    const catalog = JSON.parse(readFileSync(new URL(`../_locales/${language}/messages.json`, import.meta.url), "utf8"));
    assert.equal(catalog["colNotAsked"]?.message, words);
  }
  const page = await fakePage({ storage: NO_AUTO_RETRY });
  try {
    const { element, module } = page;
    fakeNotifications();
    page.hold();
    const { runs } = await batchOfOther(page, 7, { episodes: 4, statuses: { [`${OTHER_ID}:2`]: "failed" }, guessed: { [OTHER_ID]: [3] }, locked: { [OTHER_ID]: [4] } });
    module.renderBatchTable(runs);
    const table = element("batch-table");
    assert.equal(table.hidden, false);
    const rows = table.querySelector("tbody").children;
    assert.deepEqual(
      rows.map((row) => row.children.map((cell) => cell.textContent)),
      [["Drama 2399", "incomplete", "4", "1", "0", "1", "1", "1"]], // listed, downloaded, on disk, locked, not asked, failed
    );
  } finally {
    page.restore();
  }
});

test("3.0.1 (the lead's D9, the review's V3): a report saved only because a drama's list came short — no row under Did not download — is shown all the same: the block shows its `Report saved: …` line and its Save the report, without a heading, a Retry or a table, until the next job takes the report away; (D14) a block a Retry emptied keeps no stale count", async () => {
  const page = await fakePage();
  try {
    const { element, module, downloads } = page;
    // the list ended early and TikTok gave no count: every episode it listed downloaded, no row
    const results = [1, 2, 3].map((number) => ({
      episode: episode(number),
      status: /** @type {const} */ ("done"),
      path: `/home/me/Downloads/DramaFetch/E${number}.mp4`,
      message: `saved E${number}.mp4 (0.1 MiB)`,
    }));
    /** @type {import("../src/lib/catalog.js").Series} */
    const short = { ...series(results.map((result) => result.episode)), earlyEnd: NO_LIST_WARNING };
    const report = seriesReport(short, results);
    assert.deepEqual([report.complete, report.endedEarly], [false, true]);
    /** @type {import("../src/app/engine.js").SeriesRun} */
    const run = { ref: refOf(SERIES_ID), series: short, results, report, error: null, stop: false, exitCode: 0, errorKind: null, contacted: true };
    module.renderFailed([seriesRecord(SERIES_ID, "Test Series", [[1, "done"], [2, "done"], [3, "done"]])]);
    assert.equal(element("failed-block").hidden, true); // nothing yet: no row, no report
    await module.reportJobEnd({ kind: "batch", label: "Series 7699393770256782354" }, OUTCOME, [run], TRACES.of);
    assert.equal(downloads.length, 1); // saved: the setting is on
    assert.equal(element("failed-block").hidden, false);
    assert.equal(element("failed-report").hidden, false);
    assert.match(String(element("failed-report").textContent), /^Report saved: Test Series - did not download \d{4}-\d{2}-\d{2} \d{4}\.json$/);
    assert.deepEqual([element("report-button").hidden, element("report-button").disabled], [false, false]);
    // no row: no heading, no Retry, no table
    assert.deepEqual(
      ["failed-heading", "retry-button", "failed-table"].map((id) => [id, element(id).hidden, element(id).textContent]),
      [
        ["failed-heading", true, ""],
        ["retry-button", true, ""],
        ["failed-table", true, ""],
      ],
    );
    // Save the report saves it once more
    element("report-button").fire("click");
    for (let turns = 0; turns < 20 && downloads.length < 2; turns += 1) await page.turn();
    assert.equal(downloads.length, 2);
    // the next job's start takes the last job's report away, and the block with it
    page.hold();
    assert.equal(paste(page, OTHER_ID), true);
    await page.turn();
    assert.equal(element("app-status").dataset["state"], "running");
    assert.equal(element("failed-block").hidden, true);
  } finally {
    page.restore();
  }
  // D14: a Retry that saved every episode of the block empties it — no count left in its hidden heading
  const retried = await fakePage({ storage: NO_AUTO_RETRY });
  try {
    const { element, module } = retried;
    module.renderFailed([seriesRecord(OTHER_ID, "Two", [[1, "done"], [2, "failed"], [3, "failed"]])]);
    assert.equal(element("failed-heading").textContent, "Did not download (2)");
    assert.equal(element("retry-button").textContent, "Retry the episodes that did not download (2)");
    assert.equal(element("failed-block").hidden, false);
    module.renderFailed([seriesRecord(OTHER_ID, "Two", [[2, "done"], [3, "done"]])]);
    assert.equal(element("failed-block").hidden, true);
    assert.deepEqual([element("failed-heading").textContent, element("retry-button").textContent], ["", ""]);
  } finally {
    retried.restore();
  }
});

test("3.0.1 (the lead's D8, the review's V1 = M2): the automatic retry of a drama's plain failure carries the drama's free episode DramaFetch only guessed was locked — its “retrying” alert names it, with its hint —; when that retry never runs or Stop ends it, the drama's ⚠ alert names both and its Retry queues two jobs: the failure's, and one that asks for the free episode anyway", async () => {
  const GUESSED_E03 = "E03 was not asked for: TikTok's list made it look locked (no play address).";
  /** The drama: E03 a guessed lock, E05 cut short — run as a batch whose automatic retry it queues. */
  const shape = { episodes: 5, statuses: { [`${OTHER_ID}:5`]: "failed" }, guessed: { [OTHER_ID]: [3] } };
  /**
   * The ⚠ alert under the id of “retrying” and the two jobs its Retry queues.
   * @param {Awaited<ReturnType<typeof fakePage>>} page
   * @param {ReturnType<typeof fakeNotifications>} notes
   * @param {string} alertId
   * @param {string} context
   * @param {boolean} [throughPage] its Retry also pressed as Chrome hands it over (not while a cooldown is in force or a job runs)
   */
  const bothNamed = async (page, notes, alertId, context, throughPage = true) => {
    const shown = notes.shown.get(alertId);
    assert.deepEqual(
      [shown?.["title"], shown?.["message"], shown?.["contextMessage"], shown?.["buttons"]],
      ["⚠ Drama 2399 — 2 episodes to retry", `E05 did not download. ${GUESSED_E03}`, context, [{ title: "Retry" }]],
    );
    const target = page.module.alerts.retryOf(alertId);
    assert.deepEqual(target, { seriesId: OTHER_ID, name: "Drama 2399", numbers: [3, 5], guessed: [3] });
    assert.deepEqual(
      page.module.retryJobs([/** @type {import("../src/app/app.js").RetryTarget} */ (target)]).map((job) => [job.numbers, job.askGuessed === true]),
      [
        [[5], false],
        [[3], true],
      ],
    );
    if (!throughPage) return;
    page.hold();
    assert.deepEqual(page.message({ type: "dramafetch:retry", notificationId: alertId }, WORKER), [{ ok: true, queued: true, tabId: 1 }]);
    await page.turn();
    assert.deepEqual(
      jobsOf(page).map((queued) => [queued.label, queued.numbers, queued.askGuessed === true, queued.autoRetry]),
      [
        ["Retry 1 of Drama 2399", [5], false, undefined],
        ["Retry 1 of Drama 2399", [3], true, undefined],
      ],
    );
  };

  // queued: it carries E03 (and its hint), never asks for it; “retrying” names it apart
  const queued = await fakePage();
  try {
    const { module } = queued;
    const notes = fakeNotifications();
    queued.hold();
    await batchOfOther(queued, 7, shape);
    const alertId = `dramafetch-alert:${module.alerts.page}:7:${OTHER_ID}:retry`;
    assert.deepEqual(jobsOf(queued), [
      {
        kind: "selection",
        label: "Automatic retry: 1 of Drama 2399",
        refs: [refOf(OTHER_ID)],
        numbers: [5],
        includeLocked: false,
        recheck: false,
        autoRetry: { alertId, name: "Drama 2399", guessed: [3], hints: ["no play address"] },
      },
    ]);
    const shown = notes.shown.get(alertId);
    assert.deepEqual(
      [shown?.["title"], shown?.["message"], shown?.["buttons"]],
      ["↻ Drama 2399 — retrying 1 episode", `E05 did not download — DramaFetch tries it once more on its own. ${GUESSED_E03}`, undefined],
    );
  } finally {
    queued.restore();
  }

  // Stop takes it out of the queue: at the running job's end, `Not retried automatically: stopped by you`
  const dropped = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = dropped;
    const notes = fakeNotifications();
    const journal = () => dropped.module.journal();
    const open = gateJobs();
    assert.equal(paste(dropped, SERIES_ID), true); // job 1, started: waits at the gate
    await dropped.turn();
    await batchOfOther(dropped, 7, shape); // its automatic retry waits behind job 1
    const alertId = `dramafetch-alert:${module.alerts.page}:7:${OTHER_ID}:retry`;
    element("stop-button").fire("click");
    open();
    for (let turn = 0; turn < 1000 && (journal().length < 2 || element("app-status").dataset["state"] !== "idle"); turn += 1) await dropped.turn();
    await bothNamed(dropped, notes, alertId, "Not retried automatically: stopped by you");
  } finally {
    dropped.restore();
  }

  // a cooldown refuses it at its gate: `Not retried automatically: <the cooldown>`
  const refused = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = refused;
    const notes = fakeNotifications();
    const journal = () => refused.module.journal();
    const open = gateJobs();
    await batchOfOther(refused, 7, shape); // its retry starts: waits at the gate
    const now = Date.now() / 1000;
    refused.local.set("cooldown", { until: now + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: now });
    open();
    for (let turn = 0; turn < 1000 && (journal().length < 1 || element("app-status").dataset["state"] !== "idle"); turn += 1) await refused.turn();
    const alertId = `dramafetch-alert:${module.alerts.page}:7:${OTHER_ID}:retry`;
    const context = String(notes.shown.get(alertId)?.["contextMessage"]);
    assert.ok(context.startsWith("Not retried automatically: TikTok refused a request at "), context);
    await bothNamed(refused, notes, alertId, context, false); // the cooldown in force: its Retry waits for its end
  } finally {
    refused.restore();
  }

  // Stop ends it while it runs (nothing saved yet): the stop's reason, both named
  const ended = await fakePage();
  try {
    const { element, module } = ended;
    const notes = fakeNotifications();
    ended.hold();
    const first = await batchOfOther(ended, 7, shape);
    const [auto] = module.queuedJobs(); // started, held
    assert.ok(auto?.autoRetry !== undefined);
    const scripted = scriptedEngine(ended, auto, { ...shape, statuses: {} });
    scripted.states.set(OTHER_ID, first.states.get(OTHER_ID));
    const listing = scripted.engine.discover;
    // its fresh list asked for, Stop pressed meanwhile: the engine meets it before E05
    scripted.engine.discover = async (ref) => {
      element("stop-button").fire("click");
      return listing(ref);
    };
    await assert.rejects(runSelectionJob(scripted.engine, refOf(OTHER_ID), auto.numbers, { lastContactAt: null }), StopRequested);
    assert.equal(scripted.jobRecord.saved, undefined); // nothing on disk
    module.alertNotRetried(auto, "stopped by you", scripted.jobRecord.saved ?? []);
    await bothNamed(ended, notes, auto.autoRetry.alertId, "stopped by you", false); // runJob's end not run here
    // one that saved E05 before Stop: E03 alone is left, still named — “retrying” never just goes
    module.alertNotRetried(auto, "stopped by you", [5]);
    const alone = notes.shown.get(auto.autoRetry.alertId);
    assert.deepEqual([alone?.["title"], alone?.["message"], alone?.["contextMessage"]], ["⚠ Drama 2399 — 1 episode to retry", GUESSED_E03, "stopped by you"]);
    assert.deepEqual(module.alerts.retryOf(auto.autoRetry.alertId), { seriesId: OTHER_ID, name: "Drama 2399", numbers: [3], guessed: [3] });
  } finally {
    ended.restore();
  }
});

test("3.0.1 (the lead's D11, the review's M1): Stop keeps the Did not download block true — a stopped retry's saved episodes leave it, one that failed again before the Stop keeps its row with its new message (or gets one, in a block that had none) and the ones it never reached keep their rows; a stopped batch's finished dramas get their rows, and the drama Stop interrupted loses only the rows of what it saved (no new row: a run Stop cuts short keeps none)", async () => {
  const blockRows = (/** @type {Awaited<ReturnType<typeof fakePage>>} */ page) =>
    page.element("failed-table").querySelector("tbody").children.map((row) => [row.getAttribute("data-series-id"), row.getAttribute("data-number")]);
  // a retry of E02 and E03 that Stop ends after it saved E02
  const retry = await fakePage({ storage: NO_AUTO_RETRY });
  try {
    const { element, module } = retry;
    fakeNotifications();
    retry.hold();
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "failed"], [3, "failed"]])]);
    assert.equal(element("failed-heading").textContent, "Did not download (2)");
    const job = { ...BATCH_JOB, id: 9, kind: /** @type {const} */ ("selection"), label: "Retry 2 of Drama 2399", refs: [refOf(OTHER_ID)], numbers: [2, 3] };
    const scripted = scriptedEngine(retry, job, {
      onDownload: (ep) => {
        if (ep.number === 2) element("stop-button").fire("click"); // the engine meets it before E03
      },
    });
    await assert.rejects(runSelectionJob(scripted.engine, refOf(OTHER_ID), job.numbers, { lastContactAt: null }), StopRequested);
    const records = module.stoppedRecords(job, scripted.jobRecord);
    assert.deepEqual(
      records.map((record) => [record["series_id"], record["name"], /** @type {Record<string, unknown>[]} */ (record["rows"]).map((row) => [row["number"], row["status"]])]),
      [[OTHER_ID, "Drama 2399", [[2, "done"]]]],
    );
    module.renderFailed(records);
    assert.deepEqual(blockRows(retry), [[OTHER_ID, "3"]]);
    assert.equal(element("failed-heading").textContent, "Did not download (1)");
    assert.equal(element("retry-button").textContent, "Retry the episodes that did not download (1)");
  } finally {
    retry.restore();
  }
  /**
   * A retry of E02 and E03 whose E02 fails again (`failed 2`: a new message) and that Stop ends
   * before E03, in a page whose block holds `before` of the drama (null: no row): its record is
   * every row the retry had — never a batch's rule, only what is on disk —, and the block after it,
   * `[number, message]` per row, with its heading.
   * @param {[number, string, string?][] | null} before
   */
  const failedAgain = async (before) => {
    const page = await fakePage({ storage: NO_AUTO_RETRY });
    try {
      const { element, module } = page;
      fakeNotifications();
      page.hold();
      if (before !== null) module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", before)]);
      const job = { ...BATCH_JOB, id: 9, kind: /** @type {const} */ ("selection"), label: "Retry 2 of Drama 2399", refs: [refOf(OTHER_ID)], numbers: [2, 3] };
      const scripted = scriptedEngine(page, job, {
        statuses: { [`${OTHER_ID}:2`]: "failed" },
        onDownload: (ep) => {
          if (ep.number === 2) element("stop-button").fire("click"); // the engine meets it before E03
        },
      });
      await assert.rejects(runSelectionJob(scripted.engine, refOf(OTHER_ID), job.numbers, { lastContactAt: null }), StopRequested);
      const records = module.stoppedRecords(job, scripted.jobRecord);
      assert.deepEqual(
        records.map((record) => [record["series_id"], /** @type {Record<string, unknown>[]} */ (record["rows"]).map((row) => [row["number"], row["status"], row["message"]])]),
        [[OTHER_ID, [[2, "failed", "failed 2"]]]],
      );
      module.renderFailed(records);
      const rows = element("failed-table").querySelector("tbody").children.map((row) => [row.getAttribute("data-number"), row.children[3]?.textContent]);
      return { rows, heading: element("failed-heading").textContent };
    } finally {
      page.restore();
    }
  };
  // the block held E02 and E03 from an earlier run: E02 keeps its row with its new message, E03 its old one
  assert.deepEqual(await failedAgain([[1, "done"], [2, "failed", "old message 2"], [3, "failed", "old message 3"]]), {
    rows: [["2", "failed 2"], ["3", "old message 3"]],
    heading: "Did not download (2)",
  });
  // the block held no row of the drama (an alert's Retry in a tab reloaded since): E02 gets one
  assert.deepEqual(await failedAgain(null), { rows: [["2", "failed 2"]], heading: "Did not download (1)" });
  // a batch of two dramas that Stop ends in the second — its E01 failed, its E02 saved, Stop met before E03
  const batch = await fakePage({ storage: NO_AUTO_RETRY });
  try {
    const { element, module } = batch;
    fakeNotifications();
    batch.hold();
    // an earlier job left the second drama's E02 under Did not download
    module.renderFailed([seriesRecord(THIRD_ID, "Drama 2388", [[2, "failed"]])]);
    const job = { ...BATCH_JOB, id: 11, refs: [refOf(OTHER_ID), refOf(THIRD_ID)] };
    const scripted = scriptedEngine(batch, job, {
      statuses: { [`${OTHER_ID}:2`]: "failed", [`${THIRD_ID}:1`]: "failed" },
      onDownload: (ep) => {
        if (ep.seriesId === THIRD_ID && ep.number === 2) element("stop-button").fire("click");
      },
    });
    await assert.rejects(runBatch(scripted.engine, job.refs), StopRequested);
    const records = module.stoppedRecords(job, scripted.jobRecord);
    assert.deepEqual(
      records.map((record) => [record["series_id"], /** @type {Record<string, unknown>[]} */ (record["rows"]).map((row) => [row["number"], row["status"]])]),
      [
        [OTHER_ID, [[1, "done"], [2, "failed"], [3, "done"]]], // finished: its whole record
        [THIRD_ID, [[2, "done"]]], // interrupted: only what it saved — its failed E01 makes no row
      ],
    );
    module.renderFailed(records);
    assert.deepEqual(blockRows(batch), [[OTHER_ID, "2"]]); // the first drama's row in; the second's saved E02 out, no row for its E01
    assert.equal(element("failed-heading").textContent, "Did not download (1)");
  } finally {
    batch.restore();
  }
});

test("3.0.1 (the lead's D13, the review's T2): the automatic retry never takes a free episode DramaFetch only guessed was locked — a drama whose only episode not downloaded is one, the automatic retry on, queues nothing on its own; its alert is the ⚠ one with its Retry, never “retrying”", async () => {
  const page = await fakePage(); // the automatic retry on: the default
  try {
    const { module } = page;
    const notes = fakeNotifications();
    page.hold();
    const { runs } = await batchOfOther(page, 7, { episodes: 3, guessed: { [OTHER_ID]: [3] } });
    assert.deepEqual(runs[0]?.results.map((result) => [result.episode.number, result.status, isGuessedLocked(result)]), [
      [1, "done", false],
      [2, "done", false],
      [3, "skipped-locked", true],
    ]);
    assert.deepEqual(jobsOf(page), []); // nothing asks TikTok on its own for an episode DramaFetch judged locked
    const id = module.alerts.idOf(7, `${OTHER_ID}:retry`);
    assert.deepEqual(notes.created, [id]); // no “retrying” before it
    const shown = notes.shown.get(id);
    assert.deepEqual(
      [shown?.["title"], shown?.["message"], shown?.["buttons"]],
      ["⚠ Drama 2399 — 1 episode to retry", "E03 was not asked for: TikTok's list made it look locked (no play address).", [{ title: "Retry" }]],
    );
    // its Retry: the job that asks for it anyway, the user's
    assert.deepEqual(
      module.retryJobs([/** @type {import("../src/app/app.js").RetryTarget} */ (module.alerts.retryOf(id))]).map((job) => [job.numbers, job.askGuessed === true, job.autoRetry]),
      [[[3], true, undefined]],
    );
  } finally {
    page.restore();
  }
});

test("3.0.1: an automatic retry whose fresh list never comes — no list, no row: a login wall, no episode list in time, a closed tab — ends in its drama's ⚠ alert with its Retry under the id of “retrying”: titled with the drama's name, naming the episode it retried and the free one it carried, the listing's reason its context; never a `not complete` with no button", async () => {
  const GUESSED_E03 = "E03 was not asked for: TikTok's list made it look locked (no play address).";
  const page = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = page;
    const notes = fakeNotifications();
    const alertId = `dramafetch-alert:${module.alerts.page}:7:${OTHER_ID}:retry`;
    /** @type {unknown[]} every title Chrome was asked to show under that id, in order */
    const titles = [];
    const create = notes.api.create;
    notes.api.create = (id, notification) => {
      if (id === alertId) titles.push(notification["title"]);
      return create(id, notification);
    };
    const open = gateJobs();
    // E03 a guessed lock, E05 cut short: its automatic retry of E05 starts, carrying E03, and waits at the gate
    await batchOfOther(page, 7, { episodes: 5, statuses: { [`${OTHER_ID}:5`]: "failed" }, guessed: { [OTHER_ID]: [3] } });
    const [auto] = module.queuedJobs();
    assert.deepEqual(auto?.autoRetry, { alertId, name: "Drama 2399", guessed: [3], hints: ["no play address"] });
    // it runs: its fresh listing fails before any list comes (no TikTok tab can be opened here)
    const tabs = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis.chrome.tabs));
    tabs["create"] = async () => {
      throw new Error("No tab with id: 404.");
    };
    open();
    const journal = () => module.journal();
    for (let turn = 0; turn < 1000 && (journal().length < 1 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    const [ended] = journal();
    assert.equal(ended?.["label"], "Automatic retry: 1 of Drama 2399");
    assert.equal(ended?.["stopped"], "the episode list could not be fetched");
    // “retrying”, then the ⚠ alert in its place — nothing in between
    assert.deepEqual(titles, ["↻ Drama 2399 — retrying 1 episode", "⚠ Drama 2399 — 2 episodes to retry"]);
    const shown = notes.shown.get(alertId);
    assert.deepEqual(
      [shown?.["title"], shown?.["message"], shown?.["contextMessage"], shown?.["buttons"]],
      ["⚠ Drama 2399 — 2 episodes to retry", `E05 did not download. ${GUESSED_E03}`, "the episode list could not be fetched", [{ title: "Retry" }]],
    );
    // its Retry: the failure's job, and the one that asks for the free episode anyway
    const target = module.alerts.retryOf(alertId);
    assert.deepEqual(target, { seriesId: OTHER_ID, name: "Drama 2399", numbers: [3, 5], guessed: [3] });
    assert.deepEqual(
      module.retryJobs([/** @type {import("../src/app/app.js").RetryTarget} */ (target)]).map((job) => [job.numbers, job.askGuessed === true, job.autoRetry]),
      [
        [[5], false, undefined],
        [[3], true, undefined],
      ],
    );
  } finally {
    page.restore();
  }
});

test("3.0.1 (D9), the report setting off: a report kept only because a drama's list came short — no row under Did not download — keeps its block on screen with Save the report (no heading, Retry or table, no `Report saved` line: nothing saved); Save the report saves it and says so", async () => {
  const page = await fakePage({ storage: { settings: { report: false } } });
  try {
    const { element, module, downloads } = page;
    // the list ended early and TikTok gave no count: every episode it listed downloaded, no row
    const results = [1, 2, 3].map((number) => ({
      episode: episode(number),
      status: /** @type {const} */ ("done"),
      path: `/home/me/Downloads/DramaFetch/E${number}.mp4`,
      message: `saved E${number}.mp4 (0.1 MiB)`,
    }));
    /** @type {import("../src/lib/catalog.js").Series} */
    const short = { ...series(results.map((result) => result.episode)), earlyEnd: NO_LIST_WARNING };
    /** @type {import("../src/app/engine.js").SeriesRun} */
    const run = { ref: refOf(SERIES_ID), series: short, results, report: seriesReport(short, results), error: null, stop: false, exitCode: 0, errorKind: null, contacted: true };
    module.renderFailed([seriesRecord(SERIES_ID, "Test Series", [[1, "done"], [2, "done"], [3, "done"]])]);
    assert.equal(element("failed-block").hidden, true); // no row, no report yet
    await module.reportJobEnd({ kind: "batch", label: "Series 7699393770256782354" }, OUTCOME, [run], TRACES.of);
    assert.deepEqual(downloads, []); // the setting is off: nothing saved
    assert.equal(element("failed-block").hidden, false); // the block shows the report all the same
    assert.deepEqual([element("report-button").hidden, element("report-button").disabled], [false, false]);
    assert.deepEqual([element("failed-report").hidden, element("failed-report").textContent], [true, ""]);
    assert.deepEqual(
      ["failed-heading", "retry-button", "failed-table"].map((id) => [id, element(id).hidden, element(id).textContent]),
      [
        ["failed-heading", true, ""],
        ["retry-button", true, ""],
        ["failed-table", true, ""],
      ],
    );
    element("report-button").fire("click");
    for (let turns = 0; turns < 20 && downloads.length < 1; turns += 1) await page.turn();
    assert.equal(downloads.length, 1);
    assert.equal(element("failed-report").hidden, false);
    assert.match(String(element("failed-report").textContent), /^Report saved: Test Series - did not download \d{4}-\d{2}-\d{2} \d{4}\.json$/);
  } finally {
    page.restore();
  }
});
