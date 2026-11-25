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
import { displayText } from "../src/lib/display.js";
import { DRM_MESSAGE, DRM_REMEMBERED_MESSAGE, MEDIA_RATE_LIMIT_MESSAGE, shortServedMessage } from "../src/lib/messages.js";
import { JOB_REST, LONG_REST, PACE, PacingState, REST, SERIES_REST, pacingOptions, pauseMessage } from "../src/lib/pacing.js";
import { profileHandleOf } from "../src/lib/library.js";
import { completeSkip, seriesReport } from "../src/lib/report.js";
import { doneEntries, donePath, markComplete, missingFiles, newState, record } from "../src/lib/state.js";
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
  saveFile,
  servedShort,
} from "../src/app/downloader.js";
import { STORAGE_REFUSED_PREFIX, StopRequested, StorageRefusedError, downloadSeries, runBatch, runSelectionJob } from "../src/app/engine.js";
import { FAVORITES_RATE_LIMIT_MESSAGE } from "../src/app/favorites.js";
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

test("overwrite (3.0.0, See episodes' downloads): an episode the records say is on disk is downloaded again in full — a request like any other, paced, its new download in the records —; one an earlier download found encrypted is still skipped with no request unless includeLocked, and a locked one stays skipped; without overwrite both on-disk episodes are skipped", async () => {
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

  const again = fakeEngine();
  again.engine.overwrite = true;
  const state = stateWith([1, 4], [2]);
  const { results, stopped } = await downloadSeries(again.engine, series(episodes), episodes, state);
  assert.equal(stopped, null);
  assert.deepEqual(results.map((r) => [r.episode.number, r.status, r.message]), [
    [1, "done", "done 1"],
    [2, "skipped-locked", DRM_REMEMBERED_MESSAGE], // retrying cannot change that verdict: no request
    [3, "skipped-locked", "looks locked"],
    [4, "done", "done 4"],
    [5, "done", "done 5"],
  ]);
  assert.deepEqual(again.downloads, [1, 4, 5]); // the two on disk asked for again, in order
  assert.deepEqual(again.pauses.map((p) => p.kind), ["pace", "pace"]); // paced like any request (none before the first)
  // the records hold the new downloads: their path and Chrome's id
  assert.deepEqual(
    [1, 4].map((number) => [state.episodes[String(number)]?.status, state.episodes[String(number)]?.path, state.episodes[String(number)]?.download_id]),
    [["done", "/dl/E1.mp4", 1], ["done", "/dl/E4.mp4", 4]],
  );
  // a ticked locked or DRM row (includeLocked): the DRM memory no longer holds it back
  const asked = fakeEngine();
  asked.engine.overwrite = true;
  asked.engine.includeLocked = true;
  await downloadSeries(asked.engine, series(episodes), episodes, stateWith([1, 4], [2]));
  assert.deepEqual(asked.downloads, [1, 2, 4, 5]);
});

test("overwrite (3.0.0): a stop marks the rest `stopped: …` — never the skip an episode on disk (in the records, or in Chrome's history at its target) has without overwrite —; the DRM memory and a locked episode keep theirs; the records then hold the stop's rows, as Python's `Manifest.record` does: an episode on disk the download in full did not get back is recorded as not downloaded (its old file untouched)", async () => {
  const episodes = [episode(1), episode(2), episode(3), episode(4), episode(5), episode(6, { locked: true })];
  /**
   * A 429 on E02; E03 on disk in the records, E04 in Chrome's history at its target, E05 found
   * encrypted, E06 locked: the rows after the stop, and the records it leaves.
   * @param {boolean} overwrite
   */
  const rest = async (overwrite) => {
    const fake = fakeEngine({ results: { 2: "failed-rate-limited" } });
    fake.engine.overwrite = overwrite;
    fake.engine.downloader.existingResult = (ep) =>
      ep.number === 4 ? { episode: ep, status: "skipped-exists", path: "/dl/old/E4.mp4", message: "already exists: E4.mp4", downloadId: 104 } : null;
    const state = stateWith([3], [5]);
    const { results, stopped } = await downloadSeries(fake.engine, series(episodes), episodes, state);
    assert.equal(stopped, "episode 2 failed-rate-limited");
    assert.deepEqual(fake.downloads, [1, 2]); // nothing after the stop
    const onDisk = new Map(doneEntries(state, () => true)); // what See episodes calls on disk
    /** @param {number} number */
    const kept = (number) => {
      const entry = state.episodes[String(number)];
      return [number, entry?.status, entry?.path ?? null, entry?.download_id ?? null, onDisk.get(number) ?? null];
    };
    return { rows: results.slice(2).map((r) => [r.episode.number, r.status, r.message]), records: [3, 4].map(kept) };
  };
  const stoppedBy429 = `stopped: episode 2 failed-rate-limited: ${MEDIA_RATE_LIMIT_MESSAGE}`;
  const resume = await rest(false);
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
  const again = await rest(true);
  assert.deepEqual(again.rows, [
    [3, "failed-rate-limited", stoppedBy429], // not downloaded again: its retry takes it
    [4, "failed-rate-limited", stoppedBy429],
    [5, "skipped-locked", DRM_REMEMBERED_MESSAGE],
    [6, "skipped-locked", "looks locked: no play address"],
  ]);
  // a stop's row is an attempt (`Manifest.record`): E03's download gives way to it, so See episodes
  // shows it not on disk — ticked — until it is downloaded again, or a paste finds its file, which
  // nothing touched, in Chrome's history
  assert.deepEqual(again.records, [
    [3, "failed-rate-limited", null, null, null],
    [4, "failed-rate-limited", null, null, null],
  ]);
});

test("overwrite (3.0.0): never the complete skip — a series found complete an hour ago, every file still there, is listed and downloaded again in full (Python's `_complete_skip_allowed`); without overwrite it costs no request", async () => {
  const ref = { kind: /** @type {const} */ ("series"), seriesId: SERIES_ID, episodeHint: null, sourceUrl: SERIES_ID };
  /** @param {boolean} overwrite */
  const run = async (overwrite) => {
    /** @type {string[]} */
    const listed = [];
    const fake = fakeEngine({
      discover: async (asked) => {
        listed.push(asked.seriesId);
        return series([episode(1), episode(2)]);
      },
    });
    fake.engine.overwrite = overwrite;
    const state = stateWith([1, 2]);
    markComplete(state, fake.engine.wallClock() - 3600, 2);
    fake.states.set(SERIES_ID, JSON.parse(JSON.stringify(state)));
    const [only] = await runBatch(fake.engine, [ref]);
    return { skipped: only?.report.skippedComplete, contacted: only?.contacted, listed, downloads: fake.downloads, statuses: only?.results.map((r) => r.status) };
  };
  assert.deepEqual(await run(false), { skipped: true, contacted: false, listed: [], downloads: [], statuses: ["skipped-exists", "skipped-exists"] });
  assert.deepEqual(await run(true), { skipped: false, contacted: true, listed: [SERIES_ID], downloads: [1, 2], statuses: ["done", "done"] });
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
 * folder) and the conflict action it asked Chrome for to `conflicts`; `overwrite` as the jobs of
 * See episodes set it (3.0.0).
 * @param {{fetch: typeof fetch, saved?: string[], conflicts?: string[], thumbnail?: string, view?: DownloadsView, overwrite?: boolean}} options
 */
function downloader(options) {
  /** @type {string[]} */
  const saved = options.saved ?? [];
  /** @type {string[]} */
  const conflicts = options.conflicts ?? [];
  let id = 0;
  return new Downloader({
    quality: "compatible",
    thumbnail: options.thumbnail ?? "embed",
    nameFormat: "{series} - Episode {number}",
    includeLocked: false,
    overwrite: options.overwrite,
    hostPatterns: ["https://*.tiktok.com/*", "https://*.tiktokcdn.com/*"],
    view: options.view ?? /** @type {never} */ ({ completedAt: () => null, remember() {} }),
    rediscover: async () => {
      throw new Error("no rediscovery expected");
    },
    fetch: options.fetch,
    save: async (_bytes, _mime, filename, conflictAction) => {
      saved.push(filename);
      conflicts.push(conflictAction);
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

test("download with overwrite (3.0.0, See episodes' downloads): an episode Chrome's history shows saved at its target is not skipped — existingResult null, needsNetwork true —: it is downloaded again in full and saved with conflictAction `overwrite` under the same name, its cover file too; a locked one stays skipped; without overwrite the same episode is `skipped-exists` with no request, and a new one is saved with `uniquify`", async () => {
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
  /** @type {string[]} */
  const conflicts = [];
  // without overwrite (a paste, a card's Download): the file at its target is the episode
  const resume = downloader({ fetch: fakeFetch(routes, log), saved, conflicts, thumbnail: "both", view });
  assert.equal(resume.existingResult(episode(1), CONTEXT)?.status, "skipped-exists");
  assert.equal(resume.needsNetwork(episode(1), CONTEXT), false);
  const skipped = await resume.download(episode(1), CONTEXT);
  assert.deepEqual([skipped.status, skipped.message, skipped.downloadId], ["skipped-exists", "already exists: Test Series - Episode 01.mp4", 7]);
  assert.deepEqual(log, []); // no request
  assert.equal((await resume.download(episode(2), CONTEXT)).status, "done");
  assert.deepEqual(conflicts, ["uniquify", "uniquify"]); // the video and its cover file: never a file overwritten

  // with overwrite: downloaded again in full, both files replaced under their own names
  log.length = 0;
  saved.length = 0;
  conflicts.length = 0;
  const again = downloader({ fetch: fakeFetch(routes, log), saved, conflicts, thumbnail: "both", view, overwrite: true });
  assert.equal(again.existingResult(episode(1), CONTEXT), null);
  assert.equal(again.needsNetwork(episode(1), CONTEXT), true);
  const result = await again.download(episode(1), CONTEXT);
  assert.equal(result.status, "done");
  assert.equal(result.message, "saved Test Series - Episode 01.mp4 (0.1 MiB) + cover embedded + file");
  assert.equal(result.path, `/home/me/Downloads/${target}`);
  assert.deepEqual(saved, [target, `${folder}/Test Series - Episode 01.jpg`]);
  assert.deepEqual(conflicts, ["overwrite", "overwrite"]);
  assert.equal(log.length, 2); // the video and the one cover GET
  // a locked episode: still skipped, no request
  assert.equal(again.needsNetwork(episode(3, { locked: true }), CONTEXT), false);
  assert.equal((await again.download(episode(3, { locked: true }), CONTEXT)).status, "skipped-locked");
  assert.equal(log.length, 2);
});

test("saveFile hands Chrome its conflict action: `uniquify` by default — never a file overwritten —, `overwrite` only when asked (3.0.0: See episodes' downloads again)", async () => {
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
  const first = await saveFile(bytes, "video/mp4", "DramaFetch/S [1]/S - Episode 01.mp4", undefined, api);
  await saveFile(bytes, "video/mp4", "DramaFetch/S [1]/S - Episode 01.mp4", "overwrite", api);
  await saveFile(bytes, "image/jpeg", "DramaFetch/S [1]/S - Episode 01.jpg", "uniquify", api);
  assert.equal(first.filename, "/home/me/Downloads/E1.mp4");
  assert.deepEqual(
    asked.map((options) => [options["filename"], options["conflictAction"], options["saveAs"]]),
    [
      ["DramaFetch/S [1]/S - Episode 01.mp4", "uniquify", false],
      ["DramaFetch/S [1]/S - Episode 01.mp4", "overwrite", false],
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
 * with `options.storage` — a cooldown, a library — else empty, the engine lock free): a FRESH
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
 * only; outside test mode nothing records jobs). With `options.session`,
 * `chrome.storage.session` holds those keys from the start (the browser session's memory: the
 * library's covers, say) and keeps what the page writes; without it, it holds nothing. With
 * `options.language` `es`, Chrome's UI is Spanish: the Spanish messages, `getUILanguage()` `es-419`.
 * `tick()` runs the page's one-second tick once (its `setInterval`, never armed here).
 * With `options.refuseRemove`, `chrome.storage.local` refuses every removal (a full disk).
 * @param {{storage?: Record<string, unknown>, lockTaken?: boolean, search?: string, testSettings?: Record<string, unknown>, session?: Record<string, unknown>, language?: "en" | "es", refuseRemove?: boolean}} [options]
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
  /** @type {Map<string, unknown> | null} chrome.storage.session, when the test seeds it */
  const sessionStore = options.session === undefined ? null : new Map(Object.entries(options.session));
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
        /** @param {string} key */
        remove: async (key) => {
          if (options.refuseRemove) throw new Error(REFUSED);
          local.delete(key);
        },
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
    // the library's covers are watched as the cards come into view: nothing is ever in view here,
    // so no cover is ever requested
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
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
    for (const name of ["document", "chrome", "location", "history", "MutationObserver", "IntersectionObserver", "CSS", "dramafetchJournal"]) Reflect.deleteProperty(globalThis, name);
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

test("See episodes: an episode a download found encrypted (DRM) shows as locked, with what tries it again there, and Download all available takes exactly the episodes the list counts as available — none: disabled", async () => {
  /**
   * See episodes over the five-episode series (E05 paid and locked) whose stored records hold a
   * DRM verdict for `drm`; returns the page, the list drawn.
   * @param {number[]} drm
   * @param {"en" | "es"} [language]
   */
  const seeEpisodes = async (drm, language = "en") => {
    const state = newState(SERIES_ID, "Test Series");
    for (const number of drm) {
      const result = { episode: episode(number), status: /** @type {const} */ ("failed-unavailable"), path: null, message: DRM_MESSAGE };
      record(state, result, { exists: () => true, now: 1_800_000_000 });
    }
    const page = await fakePage({ storage: { [`series:${SERIES_ID}`]: state }, language });
    const ref = { kind: /** @type {const} */ ("series"), seriesId: SERIES_ID, episodeHint: null, sourceUrl: SERIES_ID };
    /** @type {import("../src/app/app.js").Job} */
    const job = { id: 99, kind: "load", label: `List series ${SERIES_ID}`, refs: [ref], series: null, numbers: [], includeLocked: false, recheck: false };
    const engine = page.module.buildEngine(job, { pauses: [], inputs: [], taking: true });
    engine.sleep = async () => undefined;
    engine.discover = async () => series([episode(1), episode(2), episode(3), episode(4), episode(5, { locked: true })]);
    engine.view = /** @type {import("../src/app/downloader.js").DownloadsView} */ (
      /** @type {unknown} */ ({ exists: () => false, refresh: async () => undefined, completedAt: () => null, remember() {} })
    );
    assert.equal(await page.module.runLoad(job, engine, {}), null);
    return page;
  };
  /**
   * Each row of the list drawn: [number, data-locked, ticked, its hints].
   * @param {Awaited<ReturnType<typeof fakePage>>} page
   */
  const rows = (page) =>
    page
      .element("episode-table")
      .querySelector("tbody")
      ?.children.map((row) => [
        row.getAttribute("data-number"),
        row.children[0]?.children[0]?.getAttribute("data-locked"),
        row.children[0]?.children[0]?.checked,
        (row.children[6]?.children ?? []).filter((child) => child.className === "hints").map((child) => child.textContent),
      ]);
  const hint = "protected by DRM (found by an earlier run): DramaFetch does not decrypt it; tick it and press “Download selected” to try again";
  let page = await seeEpisodes([2]);
  try {
    assert.equal(page.element("series-meta").textContent, "5 episodes listed, 3 available (free or unlocked by your account), 0 already on disk.");
    assert.deepEqual(rows(page), [
      ["1", "0", true, []],
      ["2", "1", false, [hint]], // never the box's checkbox: See episodes' own buttons do not read it
      ["3", "0", true, []],
      ["4", "0", true, []],
      ["5", "1", false, ["no play address"]],
    ]);
    assert.equal(page.element("download-available-button").disabled, false);
    page.hold(); // the job's tabs.getCurrent never answers: it runs, and makes no request
    page.element("download-available-button").fire("click");
    await page.turn();
    // the three the list counts as available, never the episode the engine would skip again
    assert.deepEqual(
      page.module.queuedJobs().map((job) => [job.kind, job.numbers, job.includeLocked]),
      [["selection", [1, 3, 4], false]],
    );
  } finally {
    page.restore();
  }
  page = await seeEpisodes([1, 2, 3, 4]);
  try {
    assert.equal(page.element("series-meta").textContent, "5 episodes listed, 0 available (free or unlocked by your account), 0 already on disk.");
    assert.equal(page.element("download-available-button").disabled, true); // no job lists the series for nothing
    page.element("download-available-button").fire("click");
    await page.turn();
    assert.deepEqual(page.module.queuedJobs(), []);
  } finally {
    page.restore();
  }
  page = await seeEpisodes([2], "es");
  try {
    assert.deepEqual(rows(page)?.[1]?.[3], [
      "protegido con DRM (lo detectó una ejecución anterior): DramaFetch no lo descifra; para intentarlo de nuevo, márcalo y pulsa “Descargar selección”",
    ]);
  } finally {
    page.restore();
  }
});

test("See episodes of drama A, then of drama B: until B's list is drawn, the page acts on A's list on screen; then on B's — the list, its counts and what its buttons take change in one step", async () => {
  const other = "7699393770256782399";
  /**
   * @param {string} seriesId
   * @param {string} name
   * @param {number[]} drm the episodes a download found encrypted
   */
  const records = (seriesId, name, drm) => {
    const state = newState(seriesId, name);
    for (const number of drm) {
      const result = { episode: episode(number, { seriesId }), status: /** @type {const} */ ("failed-unavailable"), path: null, message: DRM_MESSAGE };
      record(state, result, { exists: () => true, now: 1_800_000_000 });
    }
    return state;
  };
  const page = await fakePage({ storage: { [`series:${SERIES_ID}`]: records(SERIES_ID, "Series A", [2]), [`series:${other}`]: records(other, "Series B", [1, 2, 3, 4]) } });
  try {
    /**
     * See episodes of `seriesId` (E05 paid and locked), Chrome's download history answering when
     * `refresh` resolves.
     * @param {string} seriesId
     * @param {string} name
     * @param {() => Promise<void>} refresh
     */
    const seeEpisodes = (seriesId, name, refresh) => {
      const ref = { kind: /** @type {const} */ ("series"), seriesId, episodeHint: null, sourceUrl: seriesId };
      /** @type {import("../src/app/app.js").Job} */
      const job = { id: 99, kind: "load", label: `List series ${seriesId}`, refs: [ref], series: null, numbers: [], includeLocked: false, recheck: false };
      const engine = page.module.buildEngine(job, { pauses: [], inputs: [], taking: true });
      engine.sleep = async () => undefined;
      const episodes = [1, 2, 3, 4].map((number) => episode(number, { seriesId })).concat([episode(5, { locked: true, seriesId })]);
      engine.discover = async () => series(episodes, name, seriesId);
      engine.view = /** @type {import("../src/app/downloader.js").DownloadsView} */ (
        /** @type {unknown} */ ({ exists: () => false, refresh, completedAt: () => null, remember() {} })
      );
      return page.module.runLoad(job, engine, {});
    };
    const shown = () => [page.element("series-title").textContent, page.element("series-meta").textContent, page.element("download-available-button").disabled];
    assert.equal(await seeEpisodes(SERIES_ID, "Series A", async () => undefined), null);
    const listA = ["Series A", "5 episodes listed, 3 available (free or unlocked by your account), 0 already on disk.", false];
    assert.deepEqual(shown(), listA);
    /** @type {() => void} */
    let answer = () => undefined;
    const history = new Promise((resolve) => {
      answer = () => resolve(undefined);
    });
    const drawing = seeEpisodes(other, "Series B", () => /** @type {Promise<void>} */ (history));
    for (let turns = 0; turns < 20; turns += 1) await page.turn();
    // B listed, its list not drawn yet (Chrome's download history not answered): A's list, counts
    // and buttons, all of a piece — Download all available takes what A's list counts
    assert.deepEqual(shown(), listA);
    page.hold(); // the job's tabs.getCurrent never answers: it runs, and makes no request
    page.element("download-available-button").fire("click");
    await page.turn();
    assert.deepEqual(
      page.module.queuedJobs().map((job) => [job.kind, job.refs[0]?.seriesId, job.numbers, job.includeLocked]),
      [["selection", SERIES_ID, [1, 3, 4], false]],
    );
    answer();
    assert.equal(await drawing, null);
    assert.deepEqual(shown(), ["Series B", "5 episodes listed, 0 available (free or unlocked by your account), 0 already on disk.", true]);
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

test("the page: a second See episodes for a series being listed, or waiting to be, is refused with loadAlreadyQueued and queues nothing; a download of it is no listing and queues", async () => {
  const other = "7699393770256782399";
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary([[SERIES_ID, "Test Series", 5], [other, "Second Chance Bride", 3]]) } });
  try {
    const { element } = page;
    const refused = String(page.catalog["loadAlreadyQueued"]?.message);
    const status = element("input-status");
    /** @param {string} seriesId */
    const see = (seriesId) => {
      const browse = actionOf(page, seriesId, "browse");
      assert.ok(browse !== undefined, `See episodes on ${seriesId}`);
      browse.fire("click");
    };
    page.hold(); // the job's `tabs.getCurrent` never answers: it runs, and makes no request
    see(SERIES_ID);
    await page.turn();
    assert.equal(element("app-status").dataset["state"], "running");
    assert.equal(element("progress-current").textContent, `List series ${SERIES_ID}`);
    assert.equal(element("queue-card").hidden, true); // it left the queue when it started
    // the same series again
    see(SERIES_ID);
    assert.equal(status.textContent, refused);
    assert.equal(status.className, "status error");
    assert.deepEqual(waitingRows(page), []);
    // its download — the popup's "Download this series" — is no listing: queued behind it
    status.textContent = "";
    page.message({ type: "dramafetch:load", input: `https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/3` });
    assert.deepEqual(waitingRows(page), [dramaRow(SERIES_ID, "Test Series")]); // named by the library's title
    // another series waits in the queue: a second See episodes for it is refused the same way
    see(other);
    assert.notEqual(status.textContent, refused);
    assert.deepEqual(waitingRows(page), [dramaRow(SERIES_ID, "Test Series"), whatRow("See episodes", other, "Second Chance Bride")]);
    see(other);
    assert.equal(status.textContent, refused);
    assert.equal(status.className, "status error");
    assert.deepEqual(waitingRows(page), [dramaRow(SERIES_ID, "Test Series"), whatRow("See episodes", other, "Second Chance Bride")]);
  } finally {
    page.restore();
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

test("the page: the retry button obeys the cooldown like every download button — disabled while it is in force, back when it ends", async () => {
  const now = Date.now() / 1000;
  const cooldown = { until: now + 1800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: now };
  const page = await fakePage({ storage: { cooldown, favoritesLibrary: storedLibrary([[SERIES_ID, "One", 2]]) } });
  try {
    const { element, module } = page;
    assert.equal(element("cooldown-banner").hidden, false);
    assert.equal(actionOf(page, SERIES_ID, "download")?.disabled, true); // a library card's Download
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
    assert.equal(actionOf(page, SERIES_ID, "download")?.disabled, false);
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
    assert.deepEqual(waitingRows(page), [whatRow("Retry E01", OTHER_ID)]); // its records never named it: its id, whole
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
      assert.deepEqual(waitingRows(page), []);
      assert.equal(element("app-status").dataset["finished"], finished);
      for (const id of ["download-available-button", "download-selected-button", "retry-button"]) {
        assert.equal(element(id).disabled, true, id);
      }
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
      assert.equal((await module.coversAllowed()), false);
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
 * A List favorites job as the page queues it (the popup's hand-over, **Update from TikTok**).
 * @returns {import("../src/app/app.js").Job}
 */
const favoritesJob = () => ({ id: 1, kind: "favorites", label: "favorites", refs: [], series: null, numbers: [], includeLocked: false, recheck: false, favoritesTab: FAVORITES_TAB });

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
 * title, episodes and length, state, ticked, shown]` — the state the card's `data-status` carries
 * (3.0.0: `queued`, `running` or `idle`, from the jobs alone), `shown` true for every card drawn:
 * a drama the search leaves out has no card at all.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 */
const favoriteRows = (page) =>
  page.element("favorites-grid").children.map((card) => [
    card.getAttribute("data-series-id"),
    partOf(card, "favorite-title")?.textContent,
    partOf(card, "favorite-meta")?.textContent,
    card.getAttribute("data-status"),
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

test("the page: List favorites reads every page of the tab's list after a pause each, fills the panel as pages arrive — episodes and length, no status from the records (3.0.0) —, filters and selects the shown ones, with nothing downloaded until asked; nothing asked of TikTok without the tab's favorites address", async () => {
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
    const job = favoritesJob();
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
    for (let turns = 0; turns < 10; turns += 1) await page.turn(); // the records read
    // one saved whole, one in part, three never run: no card says so (3.0.0) — idle, no status badge
    assert.deepEqual(favoriteRows(page), [
      [LIGHTHOUSE, "The Lighthouse Keeper's Promise", "60 episodes · 1h 19m", "idle", false, true],
      [SNOW_A, "Snowfall in Two Cities", "60 episodes · 1h 37m", "idle", false, true],
      [SNOW_B, "Snowfall in Two Cities", "60 episodes · 1h 37m", "idle", false, true],
      [PAPER, "Paper Crowns", "30 episodes · 25m", "idle", false, true],
      [MOON, "Moonlight Over the Harbor", "12 episodes", "idle", false, true],
    ]);
    for (const card of element("favorites-grid").children) assert.equal(partOf(card, "favorite-status"), undefined);
    assert.equal(element("favorites-count").textContent, "5 favorite dramas listed.");
    // the guidance (`favoritesLoaded`): a card's own Download, or several ticked and Download selected dramas
    assert.equal(element("input-status").textContent, "5 favorite dramas listed: press Download on a drama, or tick several and press Download selected dramas.");
    assert.equal(entry["favorites"], 5);
    assert.equal(entry["error"], undefined);
    assert.equal(element("library-download").disabled, true); // nothing ticked yet

    // the search (letter case aside), then "select all shown": only the two shown are ticked — the
    // library still holds all five
    element("favorites-filter").value = "SNOWFALL";
    element("favorites-filter").fire("input");
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [SNOW_A, SNOW_B]);
    assert.equal(element("library-shown").textContent, "Showing 2 of 2");
    assert.equal(element("favorites-count").textContent, "5 favorite dramas listed."); // the library still holds all five
    element("favorites-select-all").checked = true;
    element("favorites-select-all").fire("change");
    assert.deepEqual(favoriteRows(page).filter(([, , , , ticked]) => ticked).map(([id]) => id), [SNOW_A, SNOW_B]);
    assert.equal(element("favorites-selection").textContent, "2 selected · 120 episodes");
    assert.equal(element("library-download").disabled, false);
    // one more ticked by hand, with the search cleared
    element("favorites-filter").value = "";
    element("favorites-filter").fire("input");
    assert.deepEqual(favoriteRows(page).filter(([, , , , ticked]) => ticked).map(([id]) => id), [SNOW_A, SNOW_B]); // the ticks are the dramas'
    const paper = tickOf(page, PAPER);
    assert.ok(paper !== undefined);
    paper.checked = true;
    paper.fire("change");
    // the ticks, the bar's sum — nothing downloaded until asked: no job, the box left alone
    assert.equal(element("favorites-selection").textContent, "3 selected · 150 episodes");
    assert.equal(element("links").value, "");
    assert.deepEqual(page.downloads, []);
    assert.equal(element("app-status").dataset["state"], "idle"); // nothing queued
    assert.deepEqual(module.queuedJobs(), []);
  } finally {
    page.restore();
  }
});

test("the page: a favorites hand-over is taken by the engine's tab only — the popup's Open my library on a profile (that tab alone, DramaFetch 2.0.0: no card, no menu) is the List favorites job —, never twice — while its listing runs, or while it waits behind a download —, and never a card's job; a read-only tab stays silent", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const queued = () => waitingRows(page);
    const status = element("input-status");
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    page.hold(); // the job's `tabs.getCurrent` never answers: it runs, and makes no request
    // the popup's Open my library on the profile: the List favorites job of that tab
    assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB }), [{ ok: true, tabId: 1 }]);
    await page.turn();
    assert.equal(status.textContent, page.catalog["favoritesChoose"]?.message);
    assert.equal(element("progress-current").textContent, "List your favorites");
    assert.deepEqual(module.queuedJobs().map((job) => [job.kind, job.favoritesTab, Object.hasOwn(job, "card")]), [["favorites", FAVORITES_TAB, false]]);
    // the same tab again while its listing runs: not twice
    assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB }), [{ ok: true, tabId: 1 }]);
    assert.equal(status.textContent, page.catalog["favoritesAlreadyQueued"]?.message);
    assert.equal(status.className, "status error");
    assert.deepEqual(queued(), []);
    // what 1.x's right-click added to a hand-over (a card, `menu`, `script`) is read no more: the
    // tab alone, the same listing — never a job that resolves a card
    assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB, card: { title: "Snowfall in Two Cities", index: 2 }, menu: true, script: true }), [{ ok: true, tabId: 1 }]);
    assert.equal(status.textContent, page.catalog["favoritesAlreadyQueued"]?.message);
    assert.deepEqual(module.queuedJobs().map((job) => job.kind), ["favorites"]);
    // junk, another extension: not heard
    assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: -1 }), []);
    assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: 7 }, "another-extension-id"), []);
    assert.deepEqual(queued(), []);
    assert.deepEqual(tab.fetched, []);
  } finally {
    page.restore();
  }
  // the same tab handed over while its listing WAITS behind a download (a paste running): queued
  // once — what the 1.x test proved with a card's job running —, never a second listing of that list
  const waiting = await fakePage();
  try {
    const { element, module } = waiting;
    const status = element("input-status");
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    waiting.hold(); // the paste's job runs, and makes no request
    assert.equal(paste(waiting, SERIES_ID), true);
    await waiting.turn();
    assert.deepEqual(waiting.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB }), [{ ok: true, tabId: 1 }]);
    assert.equal(status.textContent, waiting.catalog["favoritesChoose"]?.message);
    assert.deepEqual(module.queuedJobs().map((job) => [job.kind, job.favoritesTab ?? null]), [["batch", null], ["favorites", FAVORITES_TAB]]);
    assert.deepEqual(waitingRows(waiting), [dramaRow(SERIES_ID), "Update from TikTok"]);
    assert.deepEqual(waiting.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB }), [{ ok: true, tabId: 1 }]);
    assert.equal(status.textContent, waiting.catalog["favoritesAlreadyQueued"]?.message);
    assert.equal(status.className, "status error");
    assert.deepEqual(module.queuedJobs().map((job) => job.kind), ["batch", "favorites"]);
    assert.deepEqual(waitingRows(waiting), [dramaRow(SERIES_ID), "Update from TikTok"]);
    // junk, another extension: not heard
    assert.deepEqual(waiting.message({ type: "dramafetch:favorites", tabId: -1 }), []);
    assert.deepEqual(waiting.message({ type: "dramafetch:favorites", tabId: 7 }, "another-extension-id"), []);
    assert.deepEqual(module.queuedJobs().map((job) => job.kind), ["batch", "favorites"]);
    assert.deepEqual(tab.fetched, []);
  } finally {
    waiting.restore();
  }
  const readonly = await fakePage({ lockTaken: true });
  try {
    assert.deepEqual(readonly.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB }), []);
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
    const job = favoritesJob();
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

test("the page: a favorites hand-over in its address (no running page took it, so the worker opened or reloaded the tab with it) is taken once — the popup's List favorites of that tab; an address of 1.x's right-click (`menu`, `card`) is read as the tab alone, never a card's job — and the address cleared; a read-only tab takes nothing", async () => {
  const card = encodeURIComponent(JSON.stringify({ title: "Snowfall in Two Cities", index: 2 })).replace(/%20/g, "+");
  for (const search of [`?favorites=${FAVORITES_TAB}`, `?favorites=${FAVORITES_TAB}&menu=1&card=${card}`, `?favorites=${FAVORITES_TAB}&menu=1&script=0`]) {
    const page = await fakePage({ search, testSettings: {} }); // loaded once its job ended: no address seen for that tab, so no request
    try {
      const noTemplate = String(page.catalog["favoritesNoTemplate"]?.message);
      assert.deepEqual(page.replaced, ["/src/app/app.html"], search);
      for (let turns = 0; turns < 50 && page.module.journal().length === 0; turns += 1) await page.turn();
      assert.deepEqual(page.module.journal().map((entry) => [entry["kind"], entry["label"], entry["error"]]), [["favorites", "List your favorites", noTemplate]], search);
      assert.deepEqual(page.sessionKeys.filter((key) => String(key).startsWith("favoritesTemplate:")), [`favoritesTemplate:${FAVORITES_TAB}`], search);
      assert.equal(page.element("input-status").textContent, noTemplate, search);
    } finally {
      page.restore();
    }
  }
  const readonly = await fakePage({ search: `?favorites=${FAVORITES_TAB}`, lockTaken: true, testSettings: {} });
  try {
    assert.deepEqual(readonly.replaced, ["/src/app/app.html"]);
    assert.deepEqual(readonly.module.journal(), []);
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

test("the page: the library's ticks survive every listing but a complete one, which prunes them — a listing TikTok cut short leaves the library as it was, another tab's complete list that holds them keeps them", async () => {
  // ticks survive a partial listing (here one TikTok cut short, without a ticked drama: it leaves the
  // library as it was) and another tab's complete list that holds them; only a complete list without
  // them prunes them
  const page = await fakePage();
  try {
    const { module } = page;
    const pages = favoritesPages();
    const tab = favoritesTab({ pages });
    tab.remember(1_794_351_500);
    await secondFavoritesTab();
    const ticked = () => favoriteRows(page).filter(([, , , , checked]) => checked).map(([id]) => id);
    /** @param {number} tabId */
    const list = async (tabId) => {
      const job = { ...favoritesJob(), favoritesTab: tabId };
      await module.runFavorites(job, favoritesEngine(page, job).engine, {});
    };
    await list(FAVORITES_TAB);
    const box = tickOf(page, PAPER);
    assert.ok(box !== undefined);
    box.checked = true;
    box.fire("change");
    const second = /** @type {Record<string, unknown>} */ (pages["1794351568"]);
    pages["1794351568"] = { dramaList: [], hasMore: false, statusCode: 0 }; // TikTok stops after the first page
    await list(FAVORITES_TAB);
    // a listing cut short over a library that holds dramas leaves the library as it was — all five
    // (1.6.0's review: what is kept across sessions never shrinks to a partial read; before, the three
    // TikTok sent took its place); the tick of a drama past what TikTok sent is kept either way
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [LIGHTHOUSE, SNOW_A, SNOW_B, PAPER, MOON]);
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
    page.restore();
  }
});

test("the page: TikTok's login page in the TikTok tab before the favorites list's first request is the job's stop — the popup's List favorites —: the job waiting behind ends without a request", async () => {
  const login = "https://www.tiktok.com/login?redirect_url=%2F%40invented_viewer";
  const label = "List your favorites";
  const page = await fakePage({ testSettings: {} }); // the test copy: its journal of finished jobs
  try {
    const tab = favoritesTab({ tabUrl: login });
    tab.remember(1_794_351_500);
    // the favorites job, and a series handed over (its download) queued behind it while it runs
    assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB }), [{ ok: true, tabId: 1 }]);
    assert.deepEqual(page.message({ type: "dramafetch:load", input: SERIES_ID }), [{ ok: true, tabId: 1 }]);
    const journal = () => page.module.journal();
    for (let turns = 0; turns < 400 && !(journal().length === 2 && page.element("app-status").dataset["state"] === "idle"); turns += 1) await page.turn();
    assert.deepEqual(
      journal().map((entry) => [entry["label"], entry["error"], entry["stopped"]]),
      [
        [label, LOGIN_REDIRECT_MESSAGE, LOGIN_REDIRECT_MESSAGE], // the job's stop
        [`Series ${SERIES_ID}`, `not started: batch stopped in ${label} (${LOGIN_REDIRECT_MESSAGE})`, null], // never started
      ],
    );
    assert.deepEqual(tab.fetched, []); // no favorites page asked for
    assert.equal(page.element("input-status").textContent, LOGIN_REDIRECT_MESSAGE);
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
    const tiktokTab = { id: FAVORITES_TAB, index: 0, windowId: 2, active: true, url: profile };
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
      assert.deepEqual(page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB }, sender), [], JSON.stringify(sender));
      assert.deepEqual(page.message({ type: "dramafetch:library" }, sender), [], JSON.stringify(sender));
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

test("the page: a cooldown met before a page of the favorites list is the job's stop; Stop keeps the count of what was listed in the job's record", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    // a cooldown recorded during the second page's pause: that page is never asked for, the job stops the queue
    let job = favoritesJob();
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
    // Stop pressed once the first page was read: the job ends, and its record keeps the 3 listed
    tab.fetched.length = 0;
    job = favoritesJob();
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
      const job = { ...favoritesJob(), favoritesTab: tabId };
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

test("the page: TikTok stopping before the list's end is said — the count keeps TikTok's total, the status and the job's record say why", async () => {
  const page = await fakePage();
  try {
    const { element, module } = page;
    const tab = favoritesTab({ pages: { "0": FAVORITES_CAPTURE, "1794351568": { dramaList: [], hasMore: false, statusCode: 0, status_code: 0, status_msg: "" } } });
    tab.remember(1_794_351_500);
    const cutShortText = String(page.catalog["favoritesCutShort"]?.message).replace("$count$", "3");
    const job = favoritesJob();
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await module.runFavorites(job, favoritesEngine(page, job).engine, entry), null); // TikTok refused nothing: no stop
    assert.equal(tab.fetched.length, 2);
    assert.equal(element("favorites-count").textContent, `3 of 946 favorite dramas listed. ${page.catalog["favoritesCutShortNote"]?.message}`);
    assert.equal(element("input-status").textContent, cutShortText);
    assert.equal(element("input-status").className, "status error");
    assert.deepEqual(entry, { favorites: 3, error: cutShortText });
  } finally {
    page.restore();
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
    const job = favoritesJob();
    assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, {}), null);
    assert.equal(tab.fetched.length, 100);
    const capped = String(page.catalog["favoritesCapped"]?.message).replace("$pages$", "100");
    assert.equal(page.element("favorites-count").textContent, `100 of 946 favorite dramas listed. ${capped}`);
  } finally {
    page.restore();
  }
});

test("the page: dramas TikTok sent without a readable series id are left out and said — on the count line and in the listing's record", async () => {
  const [shape] = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
  const numeric = { ...shape, dramaID: 7712345678901234000 }; // a JSON number: 19 digits are no exact id
  const skipped = (/** @type {Awaited<ReturnType<typeof fakePage>>} */ page) => String(page.catalog["favoritesSkipped"]?.message).replace("$count$", "2");
  const page = await fakePage();
  try {
    const { element, module } = page;
    const dramas = /** @type {unknown[]} */ (FAVORITES_CAPTURE["dramaList"]);
    const tab = favoritesTab({ pages: { "0": { ...FAVORITES_CAPTURE, hasMore: false, total: "5", dramaList: [...dramas, numeric, numeric] } } });
    tab.remember(1_794_351_500);
    const job = favoritesJob();
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await module.runFavorites(job, favoritesEngine(page, job).engine, entry), null);
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [LIGHTHOUSE, SNOW_A, SNOW_B]);
    assert.equal(element("favorites-count").textContent, `3 favorite dramas listed. ${skipped(page)}`);
    assert.deepEqual(entry, { favorites: 3, favorites_skipped: 2 });
  } finally {
    page.restore();
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
    complete: true,
    short: false,
    ended: null,
    profile: PROFILE,
    items: items.map(([seriesId, title, episodes]) => ({ seriesId, title, episodes, durationS: episodes === null ? null : episodes * 79 })),
    ...changes,
  };
}

/**
 * A series' stored progress: `numbers` saved with the downloader's message (the cover embedded),
 * found complete with `complete` episodes (at `completeAt`, seconds since the epoch: a fixed time by
 * default).
 * @param {string} seriesId
 * @param {number[]} numbers
 * @param {{complete?: number, completeAt?: number}} [options]
 */
function savedState(seriesId, numbers, options = {}) {
  const state = newState(seriesId, "A drama");
  for (const number of numbers) {
    const message = `saved E${number}.mp4 (0.1 MiB) + cover embedded`;
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
 * A card's button by its action (`download`, `browse`, `open`), when it has one.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {string} seriesId
 * @param {string} action
 */
const actionOf = (page, seriesId, action) => {
  const card = cardOf(page, seriesId);
  return card === undefined ? undefined : descendants(card).find((part) => part.getAttribute("data-action") === action);
};

/**
 * The cards' `[series id, status text]` — the text of the card's status badge, which it has only
 * while a job holds its drama (`Queued`, `Downloading · S/N`); `undefined` for an idle card (3.0.0:
 * no status from the records).
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 */
const statusTexts = (page) => page.element("favorites-grid").children.map((card) => [card.getAttribute("data-series-id"), partOf(card, "favorite-status")?.textContent]);

/**
 * A card's episodes and length line (`60 episodes · 1h 19m`), when the card is drawn.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {string} seriesId
 */
const metaOf = (page, seriesId) => {
  const card = page.element("favorites-grid").children.find((article) => article.getAttribute("data-series-id") === seriesId);
  return card === undefined ? undefined : partOf(card, "favorite-meta")?.textContent;
};

/** @param {Awaited<ReturnType<typeof fakePage>>} page @param {number} [rounds] */
async function settled(page, rounds = 12) {
  for (let turn = 0; turn < rounds; turn += 1) await page.turn();
}

test("the page: the library kept from an earlier session is shown at once with no request — the connection line with TikTok's count, the twins, 60 cards at a time, no status from the records and no status filters (3.0.0) —; the search and the sort narrow and order what is shown", async () => {
  /** @type {[string, string, number][]} */
  const many = Array.from({ length: 130 }, (_, n) => [String(7712345678901300000n + BigInt(n)), `Drama ${String(n).padStart(3, "0")}`, 10]);
  const page = await fakePage({
    storage: {
      favoritesLibrary: storedLibrary([...FIVE, ...many], { total: 135 }),
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
    assert.equal(element("library-total").textContent, "TikTok counts 135 dramas");
    assert.equal(element("library-stale").hidden, true); // the library holds what TikTok counts
    assert.equal(element("favorites-count").textContent, "135 favorite dramas listed.");
    assert.deepEqual(page.sessionKeys.filter((key) => String(key).startsWith("favoritesTemplate:")), []);
    // the first 60 cards, in the list's order, with the twins' badge — and no status: the one saved
    // whole, the one saved in part and the ones never run look alike (3.0.0), no badge, no bar
    assert.equal(element("favorites-grid").children.length, 60);
    assert.deepEqual(statusTexts(page).slice(0, 6), [
      [LIGHTHOUSE, undefined],
      [SNOW_A, undefined],
      [SNOW_B, undefined],
      [PAPER, undefined],
      [MOON, undefined],
      [many[0]?.[0], undefined],
    ]);
    assert.deepEqual(favoriteRows(page).slice(0, 3), [
      [LIGHTHOUSE, "The Lighthouse Keeper's Promise", "60 episodes · 1h 19m", "idle", false, true],
      [SNOW_A, "Snowfall in Two Cities", "60 episodes · 1h 19m", "idle", false, true],
      [SNOW_B, "Snowfall in Two Cities", "60 episodes · 1h 19m", "idle", false, true],
    ]);
    for (const card of element("favorites-grid").children) {
      assert.equal(card.getAttribute("data-status"), "idle");
      assert.equal(card.className, "drama-card idle");
      assert.equal(descendants(card).some((part) => part.tagName === "PROGRESS"), false); // a bar only while its drama downloads
    }
    const twins = page.element("favorites-grid").children.filter((card) => partOf(card, "twin") !== undefined).map((card) => card.getAttribute("data-series-id"));
    assert.deepEqual(twins, [SNOW_A, SNOW_B]);
    for (const seriesId of [LIGHTHOUSE, SNOW_B, MOON]) assert.ok(tickOf(page, seriesId) !== undefined, seriesId); // every card can be ticked
    // the actions: Download (1.7.0), See episodes and Open on TikTok on every card, on disk or not —
    // See episodes is the one way left to list a drama's episodes; 3.0.0: nothing removes a drama
    // from the Favorites
    /** @param {string} seriesId @returns {(string | null)[]} */
    const actions = (seriesId) => descendants(/** @type {FakeElement} */ (cardOf(page, seriesId))).filter((part) => part.tagName === "BUTTON").map((part) => part.getAttribute("data-action"));
    for (const seriesId of [LIGHTHOUSE, SNOW_B, MOON]) assert.deepEqual(actions(seriesId), ["download", "browse", "open"], seriesId);
    assert.equal(actionOf(page, LIGHTHOUSE, "download")?.textContent, "Download");
    assert.equal(actionOf(page, LIGHTHOUSE, "download")?.disabled, false);
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
    assert.equal(element("library-shown").textContent, "Showing 60 of 135"); // every drama, whatever its records hold
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
    assert.equal(page.local.get("librarySort"), "recent"); // each pick kept for the next sessions
    assert.deepEqual(page.downloads, []);
    assert.equal(element("app-status").dataset["state"], "idle");
  } finally {
    page.restore();
  }
});

test("the cards' lasting statuses, their filters and the locked count are gone (DramaFetch 3.0.0, the owner's decision of 2026-11-25): no chip in the page, no handler, no rule, no text in either language — Queued and Downloading stay", () => {
  const html = readFileSync(new URL("../src/app/app.html", import.meta.url), "utf8");
  for (const removed of ["library-chip", "chips", "libraryChips", "Filter by status", "“On disk” =", "with what is already on disk"]) assert.equal(html.includes(removed), false, removed);
  const source = readFileSync(new URL("../src/app/app.js", import.meta.url), "utf8");
  for (const removed of ["library-chip", "setLibraryFilter", "library.filter", "chipCounts", "inFilter", "libraryChip", "libraryOnDisk", "libraryPartly", "libraryNone", "libraryLocked", "progress.locked", "progress.status"]) {
    assert.equal(source.includes(removed), false, removed);
  }
  const css = readFileSync(new URL("../src/app/app.css", import.meta.url), "utf8");
  for (const removed of [".chip", ".badge.on-disk", ".badge.partly", ".badge.none"]) assert.equal(css.includes(removed), false, removed);
  for (const language of ["en", "es"]) {
    /** @type {Record<string, {message: string}>} */
    const catalog = JSON.parse(readFileSync(new URL(`../_locales/${language}/messages.json`, import.meta.url), "utf8"));
    for (const key of Object.keys(catalog)) assert.ok(!/^libraryChip|^libraryOnDisk$|^libraryPartly$|^libraryNone$|^libraryLocked/.test(key), `${language}: ${key}`);
    // no hint explains a status any more
    for (const key of ["favoritesHint", "libraryEmpty"]) assert.doesNotMatch(String(catalog[key]?.message), /“On disk”|“En disco”|with what is already on disk|con lo que ya está en disco/, `${language}: ${key}`);
    // kept: the two statuses a card shows while a job holds its drama
    for (const key of ["libraryQueued", "libraryRunning"]) assert.ok(Object.hasOwn(catalog, key), `${language}: ${key}`);
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

test("the page: Download selected dramas queues ONE batch job over exactly the ticked dramas, in the order the library shows them — what a paste of those ids queues —, leaves the box alone, clears the ticks, and the cards say Queued; nothing for an empty selection; Add selected to the box is gone", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    const { element, module } = page;
    assert.equal(element("favorites-add-button").listeners.size, 0); // 1.7.0: no such button (nothing wires it)
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
    page.hold(); // the job's `tabs.getCurrent` never answers: it runs, and makes no request
    element("library-download").fire("click");
    await page.turn();
    assert.equal(element("progress-current").textContent, "2 series"); // a paste's label
    // the job a paste of those ids, in that order, queues with both checkboxes unticked
    assert.deepEqual(module.queuedJobs().map(jobSummary), [["batch", "2 series", [PAPER, LIGHTHOUSE], false, false]]);
    assert.deepEqual(waitingRows(page), [dramaRow(PAPER, "Paper Crowns"), dramaRow(LIGHTHOUSE, "The Lighthouse Keeper's Promise")]); // one job, running: its two dramas wait, by the library's titles, until their lists are read
    assert.equal(element("links").value, "a box typed by hand"); // the box untouched
    assert.equal(element("favorites-selection").textContent, "0 selected · 0 episodes");
    assert.deepEqual(favoriteRows(page).filter(([, , , , ticked]) => ticked), []);
    assert.equal(element("favorites-status").textContent, "2 series queued: they download one after the other, with the usual pauses.");
    // the cards of the job's series say Queued; the others nothing (idle)
    element("library-sort").value = "recent";
    element("library-sort").fire("change");
    assert.deepEqual(favoriteRows(page).map(([id, , , status]) => [id, status]), [
      [LIGHTHOUSE, "queued"],
      [SNOW_A, "idle"],
      [SNOW_B, "idle"],
      [PAPER, "queued"],
      [MOON, "idle"],
    ]);
    assert.deepEqual(statusTexts(page), [
      [LIGHTHOUSE, "Queued"],
      [SNOW_A, undefined],
      [SNOW_B, undefined],
      [PAPER, "Queued"],
      [MOON, undefined],
    ]);
  } finally {
    page.restore();
  }
  // the same, run to its end — the discovery can open no tab here, so no request is ever made —: its
  // journal entry is a batch over exactly those series, in the order shown
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
    for (let turn = 0; turn < 500 && (run.module.journal().length === 0 || element("app-status").dataset["state"] !== "idle"); turn += 1) await run.turn();
    const [entry] = run.module.journal();
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
    assert.equal(actionOf(page, PAPER, "download")?.disabled, true); // a card's Download (1.7.0) too
    element("library-download").fire("click");
    await settled(page);
    assert.equal(element("app-status").dataset["state"], "idle");
    assert.equal(element("app-status").dataset["finished"], "0");
    assert.match(String(element("input-status").textContent), /^DramaFetch stopped: /);
  } finally {
    page.restore();
  }
});

// ------------------------------------- DramaFetch 1.7.0: the card's Download, the sort kept, the counts

test("the page: a card's Download queues exactly the job one tick and Download selected dramas queue for that drama — the ticks left alone —, and is disabled while that drama is queued or downloading; another card's still works; a click that slips through queues nothing twice", async () => {
  // the job one tick and Download selected dramas queue, on a page of its own
  const selected = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  /** @type {unknown[]} */
  let viaSelection = [];
  try {
    selected.hold();
    const box = tickOf(selected, PAPER);
    assert.ok(box !== undefined);
    box.checked = true;
    box.fire("change");
    selected.element("library-download").fire("click");
    await selected.turn();
    viaSelection = selected.module.queuedJobs().map(jobSummary);
  } finally {
    selected.restore();
  }
  assert.deepEqual(viaSelection, [["batch", `Series ${PAPER}`, [PAPER], false, false]]);
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    const { element, module } = page;
    page.hold(); // the job's `tabs.getCurrent` never answers: it runs, and makes no request
    // a tick elsewhere, and the box's checkboxes: a card's Download leaves both alone
    const tick = tickOf(page, MOON);
    assert.ok(tick !== undefined);
    tick.checked = true;
    tick.fire("change");
    element("include-locked").checked = true;
    const download = actionOf(page, PAPER, "download");
    assert.ok(download !== undefined && download.disabled === false);
    download.fire("click");
    await page.turn();
    assert.deepEqual(module.queuedJobs().map(jobSummary), viaSelection); // the same job, through the same path
    assert.equal(element("favorites-status").textContent, "“Paper Crowns” queued: it downloads whole, with the usual pauses.");
    assert.equal(element("favorites-status").className, "status ok");
    assert.deepEqual(favoriteRows(page).filter(([, , , , ticked]) => ticked).map(([id]) => id), [MOON]); // the ticks as they were
    assert.equal(element("include-locked").checked, true); // the box's, untouched
    assert.equal(element("links").value, "");
    // its card says Queued and its Download is disabled; the others' are not
    assert.equal(cardOf(page, PAPER)?.getAttribute("data-status"), "queued");
    assert.equal(actionOf(page, PAPER, "download")?.disabled, true);
    assert.equal(actionOf(page, LIGHTHOUSE, "download")?.disabled, false);
    // another card's: queued behind it, disabled in turn — the library drawn again, the tick still there
    actionOf(page, LIGHTHOUSE, "download")?.fire("click");
    assert.deepEqual(module.queuedJobs().map(jobSummary), [...viaSelection, ["batch", `Series ${LIGHTHOUSE}`, [LIGHTHOUSE], false, false]]);
    assert.equal(actionOf(page, LIGHTHOUSE, "download")?.disabled, true);
    assert.deepEqual(waitingRows(page), [dramaRow(PAPER, "Paper Crowns"), dramaRow(LIGHTHOUSE, "The Lighthouse Keeper's Promise")]); // the running one's list not read yet: it waits too
    assert.deepEqual(favoriteRows(page).filter(([, , , , ticked]) => ticked).map(([id]) => id), [MOON]);
    assert.equal(element("favorites-selection").textContent, "1 selected · 12 episodes");
    // a click that slips through anyway (the button disabled): nothing queued twice, the page says why
    actionOf(page, PAPER, "download")?.fire("click");
    assert.equal(module.queuedJobs().length, 2);
    assert.equal(element("favorites-status").textContent, "Already being downloaded, or waiting to be — not queued twice: “Paper Crowns”.");
    assert.equal(element("favorites-status").className, "status error");
    // downloading now (the engine's hook for the series it starts): Downloading, still disabled
    const engine = module.buildEngine({ ...BATCH_JOB, refs: [refOf(PAPER)] }, { pauses: [], inputs: [], taking: true });
    engine.onSeriesStart?.(1, 1, refOf(PAPER));
    assert.equal(cardOf(page, PAPER)?.getAttribute("data-status"), "running");
    assert.equal(actionOf(page, PAPER, "download")?.disabled, true);
    actionOf(page, PAPER, "download")?.fire("click");
    assert.equal(module.queuedJobs().length, 2);
  } finally {
    page.restore();
  }
});

test("the page: a paste of three lines on a fresh page is ONE batch of the three, in their order — the checkboxes' values for that run, then cleared —; the series a hand-over gives in the tab's address (`?load=`, no running page took it) is downloaded the same way, the address cleared", async () => {
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
  const opened = await fakePage({ search: `?load=${encodeURIComponent(`https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/2`)}`, testSettings: QUICK });
  try {
    assert.deepEqual(opened.replaced, ["/src/app/app.html"]);
    for (let turn = 0; turn < 200 && opened.module.journal().length === 0; turn += 1) await opened.turn();
    assert.deepEqual(opened.module.journal().map((entry) => [entry["kind"], entry["label"]]), [["batch", `Series ${SERIES_ID}`]]);
    assert.equal(opened.element("links").value, "");
  } finally {
    opened.restore();
  }
});

test("the page: Load list, Download all and Add selected to the box are gone — no element, no handler, no message —; the box's paste and Enter, the cards' Download, See episodes and Download selected dramas take their place", async () => {
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
  assert.ok(html.includes('id="library-download"') && html.includes('id="links"'));
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    assert.ok(page.element("links").listeners.has("paste") && page.element("links").listeners.has("keydown"));
    assert.ok(page.element("library-download").listeners.has("click"));
    assert.equal(actionOf(page, PAPER, "download")?.textContent, "Download");
    assert.equal(actionOf(page, PAPER, "browse")?.textContent, "See episodes");
  } finally {
    page.restore();
  }
});

test("the page: the library's sort is kept across sessions — the order picked last restored before the first cards are drawn —; a write the storage refuses changes nothing else: no refused write remembered, nothing stopped", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE), librarySort: "title" } });
  try {
    const { element, local } = page;
    assert.equal(element("library-sort").value, "title");
    // drawn A–Z from the first render: Moonlight, Paper Crowns, the two Snowfalls (the list's order between them), The Lighthouse
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [MOON, PAPER, SNOW_A, SNOW_B, LIGHTHOUSE]);
    element("library-sort").value = "episodes";
    element("library-sort").fire("change");
    await page.turn();
    assert.equal(local.get("librarySort"), "episodes");
    // a write the storage refuses: the order shown all the same, no stop, no refused write remembered
    const set = chrome.storage.local.set;
    Object.assign(chrome.storage.local, {
      set: async (/** @type {Record<string, unknown>} */ items) => {
        if ("librarySort" in items) throw new Error(REFUSED);
        return set(items);
      },
    });
    element("library-sort").value = "recent";
    element("library-sort").fire("change");
    await settled(page);
    assert.deepEqual(favoriteRows(page).map(([id]) => id), FIVE.map(([seriesId]) => seriesId));
    assert.equal(local.get("librarySort"), "episodes"); // what was kept stays
    assert.equal(actionOf(page, PAPER, "download")?.disabled, false); // no refused write remembered: jobs may start
    assert.equal(element("input-status").textContent, "");
    assert.equal(element("favorites-status").textContent, "");
  } finally {
    page.restore();
  }
  // a stored value that is no sort order: the list's own
  const junk = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE), librarySort: "by colour" } });
  try {
    assert.equal(junk.element("library-sort").value, "recent");
    assert.deepEqual(favoriteRows(junk).map(([id]) => id), FIVE.map(([seriesId]) => seriesId));
  } finally {
    junk.restore();
  }
});

/**
 * A series' stored progress with `done` episodes saved and `locked` ones recorded `skipped-locked`
 * (paid episodes a run listed and skipped), optionally found complete.
 * @param {string} seriesId
 * @param {number[]} done
 * @param {number[]} locked
 * @param {number} [complete] the episodes a complete run saw on disk
 */
function lockedState(seriesId, done, locked, complete) {
  const state = newState(seriesId, "A drama");
  for (const number of done) record(state, { episode: { number, itemId: `i${number}` }, status: "done", path: `/dl/E${number}.mp4`, message: `saved E${number}.mp4 (0.1 MiB) + cover embedded`, downloadId: number }, { exists: () => true, now: 1_800_000_000 });
  for (const number of locked) record(state, { episode: { number, itemId: `i${number}` }, status: "skipped-locked", path: null, message: "looks locked: price=1" }, { exists: () => true, now: 1_800_000_000 });
  if (complete !== undefined) markComplete(state, 1_800_000_100, complete);
  return JSON.parse(JSON.stringify(state));
}

test("the page: a card's episode count — TikTok's count raised to what the records hold — and its length, nothing more: no locked count and no tooltip (3.0.0); Downloading · saved/total counts against the same number; Most episodes and the selection's sum count the same; in Spanish too", async () => {
  const storage = {
    // TikTok's favorites entry says 12; a run listed 55 — 10 saved, 45 locked: 55 episodes
    favoritesLibrary: storedLibrary(FIVE),
    [`series:${MOON}`]: lockedState(MOON, Array.from({ length: 10 }, (_, n) => n + 1), Array.from({ length: 45 }, (_, n) => n + 11), 10),
    // 30 by TikTok's count, 3 saved, none locked: 30 episodes
    [`series:${PAPER}`]: lockedState(PAPER, [1, 2, 3], []),
  };
  const page = await fakePage({ storage });
  try {
    const { element, module } = page;
    await settled(page);
    const moon = favoriteRows(page).find(([id]) => id === MOON);
    assert.deepEqual(moon?.slice(2, 4), ["55 episodes · 16m", "idle"]); // the 45 locked ones counted among its episodes, never named
    const meta = partOf(/** @type {FakeElement} */ (cardOf(page, MOON)), "favorite-meta");
    assert.equal(meta?.getAttribute("data-locked"), null);
    assert.equal(meta?.title, "");
    assert.equal(partOf(/** @type {FakeElement} */ (cardOf(page, MOON)), "favorite-status"), undefined); // no status from the records
    const paper = partOf(/** @type {FakeElement} */ (cardOf(page, PAPER)), "favorite-meta");
    assert.equal(paper?.textContent, "30 episodes · 40m");
    assert.equal(paper?.getAttribute("data-locked"), null);
    assert.equal(paper?.title, "");
    assert.equal(statusTexts(page).find(([id]) => id === PAPER)?.[1], undefined);
    // a drama DramaFetch never ran: TikTok's count alone — nothing asked of TikTok to learn more
    assert.equal(partOf(/** @type {FakeElement} */ (cardOf(page, LIGHTHOUSE)), "favorite-meta")?.textContent, "60 episodes · 1h 19m");
    // Most episodes by that number: Moonlight's 55 above Paper Crowns' 30 (by TikTok's 12 it would be last)
    element("library-sort").value = "episodes";
    element("library-sort").fire("change");
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [LIGHTHOUSE, SNOW_A, SNOW_B, MOON, PAPER]);
    // the selection's sum: 55 for Moonlight, not TikTok's 12
    for (const seriesId of [MOON, PAPER]) {
      const box = tickOf(page, seriesId);
      assert.ok(box !== undefined);
      box.checked = true;
      box.fire("change");
    }
    assert.equal(element("favorites-selection").textContent, "2 selected · 85 episodes");
    // downloading it: the card agrees with itself — Downloading · 10/55, the bar out of 55
    const engine = module.buildEngine({ ...BATCH_JOB, refs: [refOf(MOON)] }, { pauses: [], inputs: [], taking: true });
    engine.onSeriesStart?.(1, 1, refOf(MOON));
    assert.equal(statusTexts(page).find(([id]) => id === MOON)?.[1], "Downloading · 10/55");
    const bar = descendants(/** @type {FakeElement} */ (cardOf(page, MOON))).find((part) => part.tagName === "PROGRESS");
    assert.deepEqual([bar?.getAttribute("max"), bar?.getAttribute("value")], ["55", "10"]);
    assert.equal(metaOf(page, MOON), "55 episodes · 16m");
  } finally {
    page.restore();
  }
  // in Spanish, with one more drama whose records hold ONE locked episode: its count and length
  // only, never `1 bloqueado`
  const spanish = await fakePage({ storage: { ...storage, [`series:${SNOW_A}`]: lockedState(SNOW_A, [1], [2]) }, language: "es" });
  try {
    await settled(spanish);
    const meta = partOf(/** @type {FakeElement} */ (cardOf(spanish, MOON)), "favorite-meta");
    assert.equal(meta?.textContent, "55 episodios · 16 min");
    assert.equal(meta?.title, "");
    const one = partOf(/** @type {FakeElement} */ (cardOf(spanish, SNOW_A)), "favorite-meta");
    assert.equal(one?.textContent, "60 episodios · 1 h 19 min");
    assert.equal(one?.getAttribute("data-locked"), null);
    assert.equal(one?.title, "");
    assert.equal(statusTexts(spanish).find(([id]) => id === MOON)?.[1], undefined);
    // downloading it, in Spanish: Descargando · 10/55
    const engine = spanish.module.buildEngine({ ...BATCH_JOB, refs: [refOf(MOON)] }, { pauses: [], inputs: [], taking: true });
    engine.onSeriesStart?.(1, 1, refOf(MOON));
    assert.equal(statusTexts(spanish).find(([id]) => id === MOON)?.[1], "Descargando · 10/55");
  } finally {
    spanish.restore();
  }
  // in English, one locked episode: no locked count either
  const english = await fakePage({ storage: { ...storage, [`series:${SNOW_A}`]: lockedState(SNOW_A, [1], [2]) } });
  try {
    await settled(english);
    const one = partOf(/** @type {FakeElement} */ (cardOf(english, SNOW_A)), "favorite-meta");
    assert.equal(one?.textContent, "60 episodes · 1h 19m");
    assert.equal(one?.title, "");
  } finally {
    english.restore();
  }
  // a drama TikTok's list gives no episode count and no length for, never run: `–`, and no status
  const UNKNOWN = "7712345678901234577";
  const bare = await fakePage({ storage: { favoritesLibrary: storedLibrary([...FIVE, [UNKNOWN, "No Count Yet", null]]) } });
  try {
    await settled(bare);
    assert.equal(metaOf(bare, UNKNOWN), "–");
    assert.equal(cardOf(bare, UNKNOWN)?.getAttribute("data-status"), "idle");
    assert.equal(statusTexts(bare).find(([id]) => id === UNKNOWN)?.[1], undefined);
  } finally {
    bare.restore();
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
      assert.deepEqual(waitingRows(page), [dramaRow(LIGHTHOUSE, "The Lighthouse Keeper's Promise")], why); // the running update has no row
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
      assert.deepEqual(waitingRows(page), [dramaRow(LIGHTHOUSE, "The Lighthouse Keeper's Promise"), dramaRow(MOON, "Moonlight Over the Harbor")], why); // the running one's list not read yet
      assert.equal(element("favorites-selection").textContent, "0 selected · 0 episodes", why);
      assert.equal(cardOf(page, MOON)?.getAttribute("data-status"), "queued", why);
    } finally {
      page.restore();
    }
  }
});

test("the page: a card's status follows a batch job — Queued while it waits, Downloading S/N with its bar after every episode, then nothing once its series is done (3.0.0: no status from the records — its count stays)", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    const { element, module, local } = page;
    const status = () => Object.fromEntries(statusTexts(page));
    /** @returns {(string | null | undefined)[]} the card's state, its badge's class and its bar `[value, max]`, or none */
    const card = () => {
      const article = /** @type {FakeElement} */ (cardOf(page, PAPER));
      const bar = descendants(article).find((part) => part.tagName === "PROGRESS");
      return [article.getAttribute("data-status"), partOf(article, "favorite-status")?.className, bar?.getAttribute("value"), bar?.getAttribute("max")];
    };
    assert.equal(status()[PAPER], undefined); // nothing to say while no job holds it
    assert.deepEqual(card(), ["idle", undefined, undefined, undefined]);
    page.hold();
    const box = tickOf(page, PAPER);
    assert.ok(box !== undefined);
    box.checked = true;
    box.fire("change");
    element("library-download").fire("click");
    await page.turn();
    assert.equal(status()[PAPER], "Queued");
    assert.deepEqual(card(), ["queued", "badge favorite-status queued", undefined, undefined]); // no bar while it waits
    // the running job's hooks, as the engine calls them
    const job = /** @type {import("../src/app/app.js").Job} */ ({ ...BATCH_JOB, label: "Series", refs: [{ kind: "series", seriesId: PAPER, episodeHint: null, sourceUrl: PAPER }] });
    const engine = module.buildEngine(job, { pauses: [], inputs: [], taking: true });
    engine.onSeriesStart?.(1, 1, { kind: "series", seriesId: PAPER, episodeHint: null, sourceUrl: PAPER });
    assert.equal(status()[PAPER], "Downloading · 0/30");
    assert.deepEqual(card(), ["running", "badge favorite-status running", "0", "30"]);
    local.set(`series:${PAPER}`, savedState(PAPER, [1, 2]));
    const ep = makeEpisode({ number: 2, itemId: "i2", title: "Episode 2", seriesId: PAPER, durationS: 3, coverUrl: null, raw: {} });
    engine.onResult?.({ episode: ep, status: "done", path: "/dl/E2.mp4", message: "saved E2.mp4 (0.1 MiB) + cover embedded", downloadId: 2 });
    await settled(page);
    assert.equal(status()[PAPER], "Downloading · 2/30");
    assert.deepEqual(card(), ["running", "badge favorite-status running", "2", "30"]);
    local.set(`series:${PAPER}`, savedState(PAPER, Array.from({ length: 30 }, (_, n) => n + 1), { complete: 30 }));
    engine.onSeriesDone?.(1, 1, finishedRun(PAPER, "Paper Crowns", []));
    await settled(page);
    // done — every episode on disk — and the card says nothing: no On disk, no bar; its count as before
    assert.equal(status()[PAPER], undefined);
    assert.deepEqual(card(), ["idle", undefined, undefined, undefined]);
    assert.equal(metaOf(page, PAPER), "30 episodes · 40m");
  } finally {
    page.restore();
  }
});

test("the page: a drama whose records hold episodes beyond the library's count that did not download (TikTok added them after the list was read, and the run failed on them) counts them: its card says 5 episodes, and Downloading · 3/5 while it downloads — never a status of its own (3.0.0)", async () => {
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
    assert.equal(cardOf(page, LIGHTHOUSE)?.getAttribute("data-status"), "idle");
    assert.equal(Object.fromEntries(statusTexts(page))[LIGHTHOUSE], undefined);
    assert.equal(metaOf(page, LIGHTHOUSE), "5 episodes · 4m"); // the records know 5 episodes, TikTok's entry said 3
    const engine = page.module.buildEngine({ ...BATCH_JOB, refs: [refOf(LIGHTHOUSE)] }, { pauses: [], inputs: [], taking: true });
    engine.onSeriesStart?.(1, 1, refOf(LIGHTHOUSE));
    assert.equal(Object.fromEntries(statusTexts(page))[LIGHTHOUSE], "Downloading · 3/5");
  } finally {
    page.restore();
  }
});

test("the page: the smart refresh — a library read from this TikTok profile and still TikTok's list costs ONE request (a library 2.x kept: the dramas it had removed from the Favorites leave it as it is read back, never written again); otherwise the whole list is read and becomes the library; nothing kept signed", async () => {
  const [shape] = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
  /** @param {string} seriesId @param {string} title @param {number} episodes */
  const entryOf = (seriesId, title, episodes) => ({ ...shape, dramaID: seriesId, dramaName: title, numVideos: episodes, totalDuration: String(episodes * 79) });
  const list = FIVE.map(([seriesId, title, episodes]) => entryOf(seriesId, title, episodes));
  /** @param {Record<string, unknown>[]} dramas @returns {Record<string, unknown>} TikTok's list in two pages: three, then the rest */
  const pagesOf = (dramas) => ({
    "0": { ...FAVORITES_CAPTURE, total: String(dramas.length), cursor: "1794351568", hasMore: true, dramaList: dramas.slice(0, 3) },
    "1794351568": { ...FAVORITES_CAPTURE, total: String(dramas.length), cursor: "1794350100", hasMore: false, dramaList: dramas.slice(3) },
  });
  // unchanged: one request; TikTok's count — over a library 2.x kept after it removed a sixth drama
  // from the Favorites (its count the last one minus one, not confirmed): that drama left the
  // library as it was read back (3.0.0), its count is unknown until TikTok says it again (2.x's
  // estimate, never TikTok's), and 2.x's marks are never written again
  let page = await fakePage({ storage: { favoritesLibrary: storedLibrary([...FIVE, [LANTERN_ID, "The Last Lantern", 24]], { total: 5, unconfirmed: true, removed: [{ seriesId: LANTERN_ID, at: 1 }] }) } });
  try {
    const { element, module, local } = page;
    const tab = favoritesTab({ pages: pagesOf(list) });
    tab.remember(1_794_351_500);
    assert.equal(cardOf(page, LANTERN_ID), undefined); // gone at once: no card, no count
    assert.deepEqual(favoriteRows(page).map(([id]) => id), FIVE.map(([seriesId]) => seriesId));
    assert.equal(element("favorites-count").textContent, "5 favorite dramas listed.");
    assert.equal(element("library-total").textContent, "TikTok did not say how many dramas it counts");
    assert.equal(element("library-stale").hidden, true);
    const job = favoritesJob();
    const { engine, pauses } = favoritesEngine(page, job);
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await module.runFavorites(job, engine, entry), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]); // the first page only
    assert.deepEqual(pauses, [0.8]);
    assert.equal(element("input-status").textContent, "No changes: TikTok counts 5 dramas.");
    assert.equal(entry["favorites"], 5);
    assert.deepEqual(favoriteRows(page).map(([id]) => id), FIVE.map(([seriesId]) => seriesId));
    assert.equal(element("library-total").textContent, "TikTok counts 5 dramas");
    const kept = /** @type {Record<string, unknown>} */ (local.get("favoritesLibrary"));
    assert.equal(Object.hasOwn(kept, "removed"), false); // 2.x's marks never written again
    assert.equal(Object.hasOwn(kept, "unconfirmed"), false);
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
    const job = favoritesJob();
    assert.equal(await module.runFavorites(job, favoritesEngine(page, job).engine, {}), null);
    assert.equal(tab.fetched.length, 2);
    assert.deepEqual(favoriteRows(page).map(([id]) => id), [LANTERN_ID, ...FIVE.map(([seriesId]) => seriesId)]);
    assert.equal(element("library-total").textContent, "TikTok counts 6 dramas");
    // 1.6.0's guidance (`favoritesLoaded`): the library's own Download selected dramas first, the box second
    assert.equal(element("input-status").textContent, "6 favorite dramas listed: press Download on a drama, or tick several and press Download selected dramas.");
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
    const job = favoritesJob();
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
    const job = favoritesJob();
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

test("the page: an update that does not reach TikTok's end never shrinks the library kept — page 2 answered HTTP 429, Stop after page 1, TikTok sending no more after page 1: the library in the page and on disk is the one it was, only TikTok's count of page 1 taken (the library's own profile), the time of its whole read kept; the status line, the job's record, the cooldown and the job's stop as before", async () => {
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
  /** the library kept: the five and a sixth, its whole list read two hours ago */
  const keptSix = () => storedLibrary([...FIVE, [LANTERN_ID, "The Last Lantern", 24]], { total: 6 });
  const sixIds = [...FIVE.map(([seriesId]) => seriesId), LANTERN_ID];
  /**
   * The library as it was, in the page and on disk — but for TikTok's count of page 1, read now.
   * @param {Awaited<ReturnType<typeof fakePage>>} page
   * @param {Record<string, unknown>} stored what the page was seeded with
   */
  const keptAsItWas = (page, stored) => {
    assert.deepEqual(favoriteRows(page).map(([id]) => id), sixIds); // its dramas, in its order
    assert.equal(cardOf(page, NEW_ID), undefined); // nothing of the partial read
    assert.equal(page.element("library-total").textContent, "TikTok counts 7 dramas"); // page 1's count
    assert.equal(page.element("library-stale").textContent, "This list has 6: press Update from TikTok to bring it up to date");
    const kept = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
    assert.deepEqual(/** @type {{seriesId: string}[]} */ (kept["items"]).map((item) => item.seriesId), sixIds);
    assert.equal(kept["total"], 7);
    assert.ok(Math.abs(Number(kept["countedAt"]) - Date.now() / 1000) < 60, "TikTok's count read now");
    for (const key of ["fullReadAt", "listedAt", "complete", "profile"]) assert.deepEqual(kept[key], stored[key], key); // the whole read's
  };
  // page 2 answered HTTP 429: the job's stop, the cooldown recorded with its reason, nothing counted in the job's record
  let stored = keptSix();
  let page = await fakePage({ storage: { favoritesLibrary: stored } });
  try {
    const tab = favoritesTab({ pages: { "0": first, "1794351568": { __dramafetch_status: 429, __dramafetch_text: "" } } });
    tab.remember(1_794_351_500);
    const job = favoritesJob();
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
  // Stop once page 1 was read: the job stopped, the job's record keeps the three it listed
  stored = keptSix();
  page = await fakePage({ storage: { favoritesLibrary: stored } });
  try {
    const tab = favoritesTab({ pages: { "0": first } });
    tab.remember(1_794_351_500);
    const job = favoritesJob();
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
  // TikTok sends no more after page 1 (`favorites.cutShort`): no stop; the status line and the job's
  // record say how many TikTok sent, as before
  stored = keptSix();
  page = await fakePage({ storage: { favoritesLibrary: stored } });
  try {
    const tab = favoritesTab({ pages: { "0": first, "1794351568": { dramaList: [], hasMore: false, statusCode: 0 } } });
    tab.remember(1_794_351_500);
    const job = favoritesJob();
    /** @type {Record<string, unknown>} */
    const entry = {};
    assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, entry), null);
    assert.equal(tab.fetched.length, 2);
    const cutShortText = String(page.catalog["favoritesCutShort"]?.message).replace("$count$", "3");
    // the status line says the library was kept as it was (1.6.0's review: 1.5.0's "the rest of the
    // list is not shown" was said next to every drama the library kept); the job's record keeps why, as before
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
      const job = favoritesJob();
      /** @type {Record<string, unknown>} */
      const entry = {};
      assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, entry), null, why);
      assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE], why);
      assert.deepEqual(favoriteRows(page).map(([id]) => id), FIVE.map(([seriesId]) => seriesId), why);
      // the status line says the library was not updated — never "0 favorite dramas listed", as success —;
      // the job's record keeps why: TikTok cutting the list short when it counted more, else that text
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
    const job = favoritesJob();
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
    const job = favoritesJob();
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
    const job = favoritesJob();
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
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) }, testSettings: {} }); // the test copy: its journal of jobs
  /** how often a page that was handed nothing scrolled its library into view while it started */
  let atStart = 0;
  try {
    const before = page.element("library").scrolledIntoView ?? 0;
    atStart = before;
    assert.deepEqual(page.message({ type: "dramafetch:library" }), [{ ok: true, tabId: 1 }]);
    assert.equal(page.element("library").scrolledIntoView, before + 1);
    assert.equal(page.element("app-status").dataset["state"], "idle");
    assert.deepEqual(page.module.journal(), []); // no job
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
  const opened = await fakePage({ search: "?library=1", storage: { favoritesLibrary: storedLibrary(FIVE) }, testSettings: {} });
  try {
    assert.equal(opened.element("library").scrolledIntoView ?? 0, atStart + 1);
    assert.deepEqual(opened.replaced, ["/src/app/app.html"]);
    assert.equal(opened.element("app-status").dataset["state"], "idle");
    assert.deepEqual(opened.module.journal(), []); // no job
    assert.equal(favoriteRows(opened).length, 5);
  } finally {
    opened.restore();
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

test("the page: the library's episode counts — the numbers its cards show — are trusted for 24 hours after its whole list was read — the smart refresh then costs one request; older, the whole list is read again and a series that gained episodes says so on its card", async () => {
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
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE, { fullReadAt: stale }), [`series:${PAPER}`]: savedState(PAPER, thirty, { complete: 30 }) } });
  try {
    await settled(page);
    assert.equal(metaOf(page, PAPER), "30 episodes · 40m"); // what the old count says
    let tab = favoritesTab({ pages });
    tab.remember(1_794_351_500);
    let job = favoritesJob();
    assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, {}), null);
    assert.equal(tab.fetched.length, 2); // the whole list: its first page could not tell
    await settled(page);
    assert.equal(metaOf(page, PAPER), "40 episodes · 53m");
    assert.equal(Object.fromEntries(statusTexts(page))[PAPER], undefined); // its count, never a status
    const read = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
    assert.ok(Math.abs(Number(read["fullReadAt"]) - Date.now() / 1000) < 60, "the whole list read now");
    // read whole a moment ago: nothing changed — one request, and the whole read stays the earlier one
    tab = favoritesTab({ pages });
    tab.remember(1_794_351_500);
    job = favoritesJob();
    assert.equal(await page.module.runFavorites(job, favoritesEngine(page, job).engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.equal(/** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"))["fullReadAt"], read["fullReadAt"]);
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

test("the page: Update from TikTok reads only the library's own profile — with only a tab of another account showing its favorites the button stays disabled, its hint naming the library's profile, and a click queues nothing; a tab of the library's profile enables it; a library that does not know its profile takes any profile's tab, its hint the general one", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) }, testSettings: {} }); // read from @invented_viewer; the test copy: its journal of jobs
  try {
    const { element, module } = page;
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
    assert.deepEqual(module.journal(), []); // no job
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

test("the page: Update from TikTok — disabled with its hint while no TikTok tab shows the favorites list; then enabled, its click the smart refresh of that tab (one request when nothing changed) —; Open on TikTok opens the drama's first episode in a tab in front; Clear selection unticks every drama; See episodes queues the listing of that series", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) }, testSettings: { pageDelayS: 0.001 } });
  try {
    const { element, local, module } = page;
    // no TikTok tab with the list: disabled, the hint shown — and a click queues nothing
    assert.equal(element("library-refresh").disabled, true);
    assert.equal(element("library-refresh-hint").hidden, false);
    element("library-refresh").fire("click");
    await settled(page);
    assert.equal(element("app-status").dataset["state"], "idle");
    assert.deepEqual(module.journal(), []); // no job
    // the profile's tab shows the list (its favorites address kept): enabled, the hint gone; one request
    const tab = favoritesTab({ pages: { "0": { ...FAVORITES_CAPTURE, total: "5" } } });
    tab.remember(1_794_351_500);
    Object.assign(chrome.tabs, { query: async () => [{ id: FAVORITES_TAB, index: 0, windowId: 1, active: false, url: "https://www.tiktok.com/@invented_viewer" }] });
    element("library-refresh").fire("click");
    for (let turn = 0; turn < 500 && (module.journal().length === 0 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    assert.equal(element("library-refresh").disabled, false);
    assert.equal(element("library-refresh-hint").hidden, true);
    const [entry] = module.journal();
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
    // See episodes: the listing of that series, one job
    page.hold();
    actionOf(page, PAPER, "browse")?.fire("click");
    await page.turn();
    assert.equal(element("progress-current").textContent, `List series ${PAPER}`); // the listing's own job
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
    let job = favoritesJob();
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
    let job = favoritesJob();
    assert.equal(await module.runFavorites(job, favoritesEngine(refused, job).engine, {}), null); // no stop
    assert.equal(element("favorites-status").textContent, `The library could not be kept on this computer (${REFUSED}): it is read from TikTok again next time.`);
    assert.equal(await module.coversAllowed(), true); // nothing remembered as refused: the page goes on asking
    assert.equal(actionOf(refused, LIGHTHOUSE, "download")?.disabled, false); // the job buttons too
    job = favoritesJob();
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
      const job = favoritesJob();
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
    const job = favoritesJob();
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
      const job = favoritesJob();
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
      const job = favoritesJob();
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

test("the page: an update that stops before TikTok's end keeps the library's dramas and order but takes the episode counts it read from the library's own profile — Paper Crowns, saved whole at 30, listed with 40 now, says 40 episodes (TikTok page 2 cut short, answered HTTP 429, or Stop); another account's listing renews nothing", async () => {
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
      assert.equal(metaOf(page, PAPER), "30 episodes · 40m", why);
      const tab = favoritesTab({ pages: page2 === null ? { "0": first } : { "0": first, "1794351568": page2 } });
      tab.remember(1_794_351_500);
      const job = favoritesJob();
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
      assert.equal(metaOf(page, PAPER), "40 episodes · 1h 5m", why); // the listing's entry: 40 episodes, its length too
      assert.equal(statusTexts(page).find(([id]) => id === PAPER)?.[1], undefined, why); // its count, never a status
      const kept = /** @type {Record<string, unknown>} */ (page.local.get("favoritesLibrary"));
      assert.deepEqual(/** @type {{seriesId: string}[]} */ (kept["items"]).map((item) => item.seriesId), FIVE.map(([seriesId]) => seriesId), why);
      assert.equal(/** @type {{seriesId: string, episodes: number}[]} */ (kept["items"]).find((item) => item.seriesId === PAPER)?.episodes, 40, why);
    } finally {
      page.restore();
    }
  }
  // another account's partial listing: nothing of it enters the library — its counts neither
  const other = await fakePage({ storage: storage() });
  try {
    const tab = favoritesTab({ tabUrl: "https://www.tiktok.com/@someone_else", pages: { "0": first, "1794351568": { dramaList: [], hasMore: false, statusCode: 0 } } });
    tab.remember(1_794_351_500);
    const job = favoritesJob();
    await other.module.runFavorites(job, favoritesEngine(other, job).engine, {});
    await settled(other);
    assert.equal(metaOf(other, PAPER), "30 episodes · 40m");
    assert.equal(/** @type {{seriesId: string, episodes: number}[]} */ (/** @type {Record<string, unknown>} */ (other.local.get("favoritesLibrary"))["items"]).find((item) => item.seriesId === PAPER)?.episodes, 30);
  } finally {
    other.restore();
  }
});

test("the page: an update that leaves the library as it was puts back everything of it — how many cards the grid drew —; with no library yet, an empty answer with no count is not kept", async () => {
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
    // 120 cards drawn
    element("library-more").fire("click");
    await settled(page);
    assert.equal(element("favorites-grid").children.length, 120);
    // an update from that tab TikTok cuts short: the library as it was
    const job = favoritesJob();
    assert.equal(await module.runFavorites(job, favoritesEngine(page, job).engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE, FAVORITES_TEMPLATE.replace("cursor=0", "cursor=1794351568")]);
    await settled(page);
    assert.equal(element("favorites-grid").children.length, 120); // as many cards as it drew
    assert.equal(element("library-more").textContent, "Show 15 more");
  } finally {
    page.restore();
  }
  // no library yet: an empty first page with no count is no list to keep
  const empty = await fakePage();
  try {
    const tab = favoritesTab({ pages: { "0": cutShort } });
    tab.remember(1_794_351_500);
    const job = favoritesJob();
    assert.equal(await empty.module.runFavorites(job, favoritesEngine(empty, job).engine, {}), null);
    assert.deepEqual(tab.fetched, [FAVORITES_TEMPLATE]);
    assert.equal(empty.local.get("favoritesLibrary"), undefined);
  } finally {
    empty.restore();
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
 * `onDownload` is told of every episode the run asks for, before its result.
 * @param {{episodes?: number, locked?: Record<string, number[]>, statuses?: Record<string, string>, onDownload?: (ep: import("../src/lib/catalog.js").Episode) => void}} [options]
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
    discover: async (/** @type {import("../src/lib/urls.js").SeriesRef} */ ref) =>
      series(
        Array.from({ length: options.episodes ?? 3 }, (_, index) => episode(index + 1, { seriesId: ref.seriesId, locked: options.locked?.[ref.seriesId]?.includes(index + 1) })),
        `Drama ${ref.seriesId.slice(-4)}`,
        ref.seriesId,
      ),
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

test("the alert of a batch TikTok stopped with a 429: ⚠ for the drama it stopped in — its stopped episodes retryable, the stop's reason the context —, and at the job's end ONE more: DramaFetch stopped, how many dramas were never started — those of the jobs the stop took out of the queue counted too; Stop in the middle of a batch counts the dramas after the one it ran; a listing that stops says so only for the download jobs it took out of the queue", async () => {
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
    module.alertJobEnd(job, stop, runs, jobRecord, [waiting, { kind: "load", refs: [refOf("7699393770256782377")] }]);
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
    // its gate), or for a job that downloads nothing (a listing) when its stop cancelled no
    // download: its own series are no downloads
    notes.created.length = 0;
    module.alertJobEnd({ ...job, id: 8 }, "stopped by you", null, { begun: 3 }, []);
    module.alertJobEnd({ ...job, id: 9, contacted: false }, "cooldown until 12:30", null, {}, [waiting]);
    const listingLoad = { kind: /** @type {const} */ ("load"), refs: [refOf("7699393770256782377")] };
    for (const kind of /** @type {const} */ (["load", "favorites"])) module.alertJobEnd({ id: 10, kind, refs: [refOf(SERIES_ID)], contacted: true }, FAVORITES_RATE_LIMIT_MESSAGE, null, {}, [listingLoad]);
    assert.deepEqual(notes.created, []);
    // ... but the download jobs a listing's stop took out of the queue are said, as a batch's would
    // be (an alert's Retry may wait behind one): their dramas only
    for (const [id, kind] of /** @type {const} */ ([[11, "load"], [12, "favorites"]])) {
      module.alertJobEnd({ id, kind, refs: [refOf(SERIES_ID)], contacted: true }, FAVORITES_RATE_LIMIT_MESSAGE, null, {}, [waiting, listingLoad]);
    }
    assert.deepEqual(notes.created, [11, 12].map((id) => `dramafetch-alert:${module.alerts.page}:${id}:stopped`));
    assert.deepEqual(notes.shown.get(`dramafetch-alert:${module.alerts.page}:12:stopped`), {
      type: "basic",
      iconUrl: ALERT_ICON_URL,
      title: `DramaFetch stopped: ${FAVORITES_RATE_LIMIT_MESSAGE}`,
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

test("the alert: nothing for a drama skipped as complete (no request), nothing of their own for a listing or a listing of the favorites, nothing for a batch refused at its gate; a listing TikTok stops with a 429 while a batch and an alert's Retry wait behind it says once how many dramas that left unstarted; each job run to its end through the page's own queue", async () => {
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
  // a listing (See episodes on a library card): run to its end
  page = await fakePage({ testSettings: QUICK, storage: { favoritesLibrary: storedLibrary([[SERIES_ID, "Drama 2354", 3]]) } });
  try {
    const notes = fakeNotifications();
    actionOf(page, SERIES_ID, "browse")?.fire("click");
    for (let turn = 0; turn < 500 && (page.module.journal().length === 0 || page.element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    assert.equal(page.module.journal()[0]?.["kind"], "load");
    assert.deepEqual(notes.created, []);
  } finally {
    page.restore();
  }
  // the favorites listed (the popup's Open my library), then a listing TikTok stops with a 429 while
  // a batch and an alert's Retry wait behind it: both are cancelled, the listing gets no alert of its
  // own, and ONE says how many dramas its stop left unstarted — the retry's among them (the earlier
  // batch's plain failure keeps its ⚠ alert: the automatic retry off)
  page = await fakePage({ testSettings: QUICK, storage: NO_AUTO_RETRY });
  try {
    const { element, catalog, module } = page;
    const notes = fakeNotifications();
    // a ⚠ alert this page holds: a drama of an earlier batch whose episode 2 did not download
    const THIRD_ID = "7699393770256782388";
    const earlier = { ...BATCH_JOB, id: 90, refs: [refOf(THIRD_ID)] };
    await runBatch(scriptedEngine(page, earlier, { statuses: { [`${THIRD_ID}:2`]: "failed" } }).engine, earlier.refs);
    const [retryAlert] = notes.created;
    assert.equal(retryAlert, `dramafetch-alert:${module.alerts.page}:90:${THIRD_ID}:retry`);
    const tab = favoritesTab();
    tab.remember(1_794_351_500);
    const journal = () => page.module.journal();
    page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB });
    for (let turn = 0; turn < 500 && (journal().length < 1 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    assert.equal(journal()[0]?.["kind"], "favorites");
    assert.equal(journal()[0]?.["favorites"], 5);
    assert.deepEqual(notes.created, [retryAlert]); // a listing that ends well: nothing
    const refused = favoritesTab({ pages: { "0": FAVORITES_CAPTURE, "1794351568": { __dramafetch_status: 429, __dramafetch_text: '{"statusCode": 429}' } } });
    refused.remember(1_794_351_600);
    page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB });
    assert.equal(paste(page, `${SERIES_ID}\n${OTHER_ID}`), true); // a download, waiting behind the listing
    // the alert's Retry, pressed meanwhile: queued behind them, the alert taken away
    assert.deepEqual(page.message({ type: "dramafetch:retry", notificationId: retryAlert }, WORKER), [{ ok: true, queued: true, tabId: 1 }]);
    assert.deepEqual(notes.cleared, [retryAlert]);
    for (let turn = 0; turn < 1000 && (journal().length < 4 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    const notStarted = `not started: batch stopped in ${catalog["jobFavorites"]?.message} (${FAVORITES_RATE_LIMIT_MESSAGE})`;
    assert.deepEqual(journal().slice(0, 3).map((entry) => [entry["kind"], entry["error"]]), [
      ["favorites", FAVORITES_RATE_LIMIT_MESSAGE],
      ["selection", notStarted],
      ["batch", notStarted],
    ]);
    assert.equal(journal()[1]?.["label"], "Retry 1 of Drama 2388");
    const stopped = `dramafetch-alert:${module.alerts.page}:2:stopped`;
    assert.deepEqual(notes.created, [retryAlert, stopped]);
    assert.equal(notes.shown.get(stopped)?.["title"], `DramaFetch stopped: ${FAVORITES_RATE_LIMIT_MESSAGE}`);
    assert.equal(notes.shown.get(stopped)?.["message"], "3 dramas were not started — download them again later");
    assert.equal(notes.shown.get(stopped)?.["buttons"], undefined);
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
        series: null,
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
      { kind: "selection", label: "Automatic retry: 1 of Drama 2399", refs: [refOf(OTHER_ID)], series: null, numbers: [2], includeLocked: false, recheck: false, autoRetry: { alertId, name: "Drama 2399" } },
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
    assert.equal(element("failed-block").hidden, true); // its own end: nothing of its own to show
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

test("the Did not download block (1.8.0): a line says how many of its episodes will be retried automatically, once — hidden when none —; the block stays, line, table and Retry, while that automatic retry runs, and goes as any other job starts", async () => {
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
    // nothing failed: the block and its line hidden
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"]])], [auto([2])]);
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
  // any other job — a download, an automatic retry another job queued — starts: the block goes
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
      assert.equal(element("failed-block").hidden, true, next);
      assert.equal(element("failed-auto").hidden, true, next);
      assert.equal(element("failed-auto").textContent, "", next);
      assert.equal(element("failed-heading").textContent, "", next);
      assert.equal(element("retry-button").disabled, true, next);
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

test("the Did not download block kept while its automatic retry runs keeps its Save the report (1.8.0): the report setting off, the job's report is saved on demand then — every row, the short-served one the retry leaves too —; the retry's own end takes that report's line away; a block any other job takes away takes its report too, as in 1.7.0", async () => {
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
    assert.equal(element("failed-block").hidden, true);
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
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "failed"]])], [{ numbers: [2], autoRetry: { alertId: "x", name: null } }]);
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

test("the history 1.x kept is removed once at the page's start (DramaFetch 2.0.0) — that key alone: the settings, the series' records, the pacing, the cooldown and the library stay —; a removal the storage refuses is ignored: the page starts, no refused write remembered, jobs still run", async () => {
  const now = Date.now() / 1000;
  const kept = {
    settings: { ...DEFAULT_SETTINGS, quality: "best" },
    [`series:${SERIES_ID}`]: savedState(SERIES_ID, [1, 2]),
    pacing: { runAttempts: 2, lastNetworkAt: null, consecutiveFailures: 0, lastContactAt: null },
    favoritesLibrary: storedLibrary([[SERIES_ID, "Test Series", 2]]),
    librarySort: "title",
  };
  const page = await fakePage({ storage: { ...kept, history: [{ id: 1, kind: "batch", label: `Series ${SERIES_ID}`, series: [] }] } });
  try {
    assert.equal(page.local.has("history"), false);
    for (const [key, value] of Object.entries(kept)) assert.deepEqual(page.local.get(key), value, key);
    assert.equal(favoriteRows(page).length, 1); // the library shown as it was kept
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
  const refusing = await fakePage({ storage: { history: [] }, refuseRemove: true });
  try {
    const { element, module } = refusing;
    assert.equal(refusing.local.has("history"), true); // left for the next start
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

/** Dramas of the Waiting card's tests: two the library holds, one only the stored records name, one nothing names. */
const ALPHA = "7712345678901234571";
const BETA = "7712345678901234572";
const GAMMA = "7712345678901234573";
const STORED = "7712345678901234574";

/**
 * **See episodes** of `seriesId` run through the page's own `runLoad` — a listing job of its own
 * (id 99), never the queue's —: its list on screen (five episodes, E05 locked), named `name`.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {string} seriesId
 * @param {string} name
 */
async function listOnScreen(page, seriesId, name) {
  /** @type {import("../src/app/app.js").Job} */
  const job = { id: 99, kind: "load", label: `List series ${seriesId}`, refs: [refOf(seriesId)], series: null, numbers: [], includeLocked: false, recheck: false };
  const engine = page.module.buildEngine(job, { pauses: [], inputs: [], taking: true });
  engine.sleep = async () => undefined;
  engine.discover = async () => series([1, 2, 3, 4].map((number) => episode(number, { seriesId })).concat([episode(5, { locked: true, seriesId })]), name, seriesId);
  engine.view = /** @type {import("../src/app/downloader.js").DownloadsView} */ (
    /** @type {unknown} */ ({ exists: () => false, refresh: async () => undefined, completedAt: () => null, remember() {} })
  );
  assert.equal(await page.module.runLoad(job, engine, {}), null);
}

/**
 * The episode list's checkboxes as Chrome would give them to the page (`querySelectorAll` of the
 * table): the rows' boxes, their `data-*` read back as Chrome reflects them; `ticked` checked.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {number[]} ticked
 */
function tickEpisodes(page, ticked) {
  const table = page.element("episode-table");
  const boxes = table.querySelector("tbody").children.map((row) => /** @type {FakeElement} */ (row.children[0]?.children[0]));
  for (const box of boxes) {
    box.dataset["number"] = box.getAttribute("data-number") ?? "";
    box.dataset["locked"] = box.getAttribute("data-locked") ?? "";
    box.checked = ticked.includes(Number(box.dataset["number"]));
  }
  table.querySelectorAll = () => boxes;
}

test("the Waiting card (2.0.0): one row per drama still to run, in the order they will run — the running batch's dramas not begun yet, then every waiting job's —, each by its name when DramaFetch knows it without asking TikTok (the library's title, its stored records', a name a run of this page read) and its WHOLE id, else its id and `name shown once its list is read`; every other kind of row says what it is — a Retry and an automatic retry of E02, E07 (ten at most, then `and N more`), Download all available, Download selected, See episodes, Update from TikTok (no drama)", async () => {
  const page = await fakePage({
    storage: {
      favoritesLibrary: storedLibrary([[ALPHA, "Alpha Bride", 3], [BETA, "Beta Heir", 3], [LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3]]),
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
    assert.deepEqual(waitingRows(page), [dramaRow(ALPHA, "Alpha Bride"), dramaRow(BETA, "Beta Heir"), dramaRow(GAMMA), dramaRow(STORED)]);
    await settled(page); // the records of the two unnamed ones read, once: STORED's names it
    assert.deepEqual(waitingRows(page), [dramaRow(ALPHA, "Alpha Bride"), dramaRow(BETA, "Beta Heir"), dramaRow(GAMMA), dramaRow(STORED, "A drama")]);
    const readsOf = (/** @type {string} */ key) => asked.filter((keys) => (Array.isArray(keys) ? keys : [keys]).includes(key)).length;
    assert.equal(readsOf(`series:${GAMMA}`), 1);
    assert.equal(readsOf(`series:${STORED}`), 1);
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
    // See episodes on a card; Download all available and Download selected of the list on screen
    actionOf(page, LIGHTHOUSE, "browse")?.fire("click");
    await listOnScreen(page, SERIES_ID, "Test Series");
    element("download-available-button").fire("click");
    tickEpisodes(page, [1, 2, 4]);
    element("download-selected-button").fire("click");
    // Update from TikTok (the popup's hand-over of a TikTok tab's favorites): no drama
    page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB });
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
      whatRow("See episodes", LIGHTHOUSE, "The Lighthouse Keeper's Promise"),
      whatRow("Download all available", SERIES_ID, "Test Series"),
      whatRow("Download selected E01, E02, E04", SERIES_ID, "Test Series"),
      "Update from TikTok",
    ]);
    assert.deepEqual(
      list.children.map((row) => row.getAttribute("data-kind")),
      ["download", "download", "download", "download", "retry", "retry", "autoretry", "load", "available", "selected", "favorites"],
    );
    assert.equal(list.children.at(-1)?.getAttribute("data-series-id"), null); // the favorites' listing names no drama
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
        ["load", LIGHTHOUSE, []],
        ["available", SERIES_ID, []],
        ["selected", SERIES_ID, [1, 2, 4]],
        ["favorites", null, []],
      ],
    );
    // exactly what the jobs are: the See episodes buttons' own picks, nothing else changed
    assert.deepEqual(
      jobsOf(page).filter((job) => job.pick !== undefined).map((job) => [job.kind, job.pick, job.numbers]),
      [["selection", "available", [1, 2, 3, 4]], ["selection", "selected", [1, 2, 4]]],
    );
    // only a drama nothing names is looked up in its records — once —; a name is never asked of TikTok
    assert.equal(readsOf(`series:${GAMMA}`), 1); // never read twice
    for (const named of [OTHER_ID, FOURTH_ID]) assert.equal(readsOf(`series:${named}`), 0, named); // a retry's records name it
  } finally {
    page.restore();
  }
});

test("the Waiting card (2.0.0): hidden while nothing waits; the running batch's dramas leave it as each one's list is read — the next one to run first —; a name a run of this page read names a drama that waits, and so does the library's title the moment a listing running ahead of it reads it; a read-only tab shows none", async () => {
  const page = await fakePage({
    storage: {
      favoritesLibrary: storedLibrary([[ALPHA, "Alpha Bride", 3], [BETA, "Beta Heir", 3]]),
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
    // See episodes of the drama that waits: the name its list carries names its row at once
    await listOnScreen(page, OTHER_ID, "Second Chance Bride");
    assert.deepEqual(waitingRows(page), [dramaRow(OTHER_ID, "Second Chance Bride")]);
    // a drama whose list carried no name is queued again (a Retry): still by its id, never `series-<id>`
    module.renderFailed([seriesRecord(GAMMA, null, [[2, "failed"]])]);
    element("retry-button").fire("click");
    await settled(page);
    assert.deepEqual(waitingRows(page), [dramaRow(OTHER_ID, "Second Chance Bride"), whatRow("Retry E02", GAMMA)]);
  } finally {
    page.restore();
  }
  // a drama pasted while Update from TikTok (the popup's Open my library) reads the list: named the
  // moment the page of TikTok's list that holds it arrives — the library's title —, while the listing
  // still reads the rest, never only once it ends
  const listing = await fakePage({ testSettings: { pageDelayS: 0.001 } });
  try {
    const { module } = listing;
    const [shape] = /** @type {Record<string, unknown>[]} */ (FAVORITES_CAPTURE["dramaList"]);
    const pages = favoritesPages();
    const tab = favoritesTab({
      pages: {
        "0": pages["0"],
        "1794351568": { .../** @type {Record<string, unknown>} */ (pages["1794351568"]), cursor: "1794350100", hasMore: true, total: "6" },
        "1794350100": { ...FAVORITES_CAPTURE, cursor: "1794349000", hasMore: false, total: "6", dramaList: [{ ...shape, dramaID: BETA, dramaName: "Beta Heir", numVideos: 3, totalDuration: "300" }] },
      },
    });
    tab.remember(1_794_351_500);
    // TikTok's pages 2 and 3 held until released: the listing is between its pages
    /** @type {Map<string, {asked: boolean, release: () => void}>} */
    const held = new Map();
    /** @type {Map<string, Promise<unknown>>} */
    const answers = new Map();
    for (const cursor of ["1794351568", "1794350100"]) {
      /** @type {() => void} */
      let release = () => undefined;
      answers.set(cursor, new Promise((resolve) => (release = () => resolve(undefined))));
      held.set(cursor, { asked: false, release: () => release() });
    }
    const fake = /** @type {{scripting: {executeScript: (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => Promise<unknown>}}} */ (
      /** @type {unknown} */ (globalThis.chrome)
    );
    const read = fake.scripting.executeScript;
    fake.scripting.executeScript = async (injection) => {
      const cursor = /[?&]cursor=([^&]*)/.exec(String(injection.args?.[0]))?.[1] ?? "";
      const hold = injection.world === "MAIN" ? held.get(cursor) : undefined;
      if (hold !== undefined) {
        hold.asked = true;
        await answers.get(cursor);
      }
      return read(injection);
    };
    /** @param {string} cursor */
    const asked = async (cursor) => {
      for (let turn = 0; turn < 500 && held.get(cursor)?.asked !== true; turn += 1) await listing.turn();
      assert.equal(held.get(cursor)?.asked, true, `page ${cursor} never asked`);
      await settled(listing);
    };
    listing.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB });
    await asked("1794351568");
    assert.equal(paste(listing, PAPER), true); // waits behind the listing: nothing names it yet
    await settled(listing);
    assert.deepEqual(waitingRows(listing), [dramaRow(PAPER)]);
    listing.hold(); // the paste's job, once it starts, asks nothing of anything
    held.get("1794351568")?.release(); // the page that lists Paper Crowns
    await asked("1794350100");
    assert.deepEqual(module.queuedJobs().map((job) => job.kind), ["favorites", "batch"]); // the listing still reads its last page
    assert.deepEqual(waitingRows(listing), [dramaRow(PAPER, "Paper Crowns")]);
    held.get("1794350100")?.release();
    for (let turn = 0; turn < 500 && listing.element("progress-current").textContent !== `Series ${PAPER}`; turn += 1) await listing.turn();
    assert.equal(listing.element("progress-current").textContent, `Series ${PAPER}`); // the listing over, the paste running
    assert.deepEqual(waitingRows(listing), [dramaRow(PAPER, "Paper Crowns")]); // its drama, not begun, by the library's name
  } finally {
    listing.restore();
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
  const page = await fakePage({ language: "es", storage: { favoritesLibrary: storedLibrary([[ALPHA, "Alpha Bride", 3], [LIGHTHOUSE, "The Lighthouse Keeper's Promise", 3]]) } });
  try {
    const { element, module } = page;
    fakeNotifications();
    page.hold();
    assert.equal(paste(page, `${ALPHA}\n${GAMMA}`), true);
    module.renderFailed([seriesRecord(OTHER_ID, "Drama 2399", [[2, "failed"], [7, "failed"]])]);
    element("retry-button").fire("click");
    await batchOfOther(page, 7, { statuses: { [`${THIRD_ID}:3`]: "failed" } }, undefined, THIRD_ID);
    actionOf(page, LIGHTHOUSE, "browse")?.fire("click");
    await listOnScreen(page, SERIES_ID, "Test Series");
    element("download-available-button").fire("click");
    tickEpisodes(page, [1, 2]);
    element("download-selected-button").fire("click");
    page.message({ type: "dramafetch:favorites", tabId: FAVORITES_TAB });
    await settled(page);
    assert.deepEqual(waitingRows(page), [
      `Alpha Bride · ${ALPHA}`,
      `${GAMMA} · el nombre aparece al leer su lista`,
      `Reintentar E02, E07 — Drama 2399 · ${OTHER_ID}`,
      `Reintento automático E03 — Drama 2388 · ${THIRD_ID}`,
      `Ver episodios — The Lighthouse Keeper's Promise · ${LIGHTHOUSE}`,
      `Descargar todo lo disponible — Test Series · ${SERIES_ID}`,
      `Descargar selección E01, E02 — Test Series · ${SERIES_ID}`,
      "Actualizar desde TikTok",
    ]);
    assert.equal(element("queue-list").children[1]?.children[0]?.title, "El ID completo del drama: un clic lo selecciona y Ctrl+C lo copia.");
  } finally {
    page.restore();
  }
});

// ------------------------------------------------- See episodes downloads again in full (3.0.0)

test("See episodes downloads again in full (DramaFetch 3.0.0, the owner's decision of 2026-11-25): Download all available and Download selected queue `selection` jobs with `overwrite` — the engine built for one carries it to its run and to its downloader, whose saves ask Chrome to replace the file —; a paste, a card's Download, Download selected dramas and the popup's hand-over keep what is on disk: no `overwrite`", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    const { element, module } = page;
    page.hold(); // the first job's tabs.getCurrent never answers: it runs, asking nothing; the others wait
    await listOnScreen(page, SERIES_ID, "Test Series");
    element("download-available-button").fire("click");
    tickEpisodes(page, [1, 3]);
    element("download-selected-button").fire("click");
    assert.equal(paste(page, OTHER_ID), true); // a paste
    actionOf(page, MOON, "download")?.fire("click"); // a card's Download
    const box = tickOf(page, PAPER);
    assert.ok(box !== undefined);
    box.checked = true;
    box.fire("change");
    element("library-download").fire("click"); // Download selected dramas
    page.message({ type: "dramafetch:load", input: THIRD_ID }); // the popup's Download this series
    await settled(page);
    assert.deepEqual(
      jobsOf(page).map((job) => [job.kind, job.refs.map((ref) => ref.seriesId), job.pick, job.numbers, job.overwrite]),
      [
        ["selection", [SERIES_ID], "available", [1, 2, 3, 4], true],
        ["selection", [SERIES_ID], "selected", [1, 3], true],
        ["batch", [OTHER_ID], undefined, [], undefined],
        ["batch", [MOON], undefined, [], undefined],
        ["batch", [PAPER], undefined, [], undefined],
        ["batch", [THIRD_ID], undefined, [], undefined],
      ],
    );
    // the engine of such a job: no done skip, and a downloader with no existing-file skip whose
    // saves replace the file at its target (the page's own chrome.downloads)
    const [available] = module.queuedJobs();
    assert.ok(available !== undefined);
    const engine = module.buildEngine({ ...available, id: 990 }, { pauses: [], inputs: [], taking: true });
    assert.equal(engine.overwrite, true);
    assert.equal(engine.downloader.config.overwrite, true);
    await engine.downloader.save(new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]), "video/mp4", `DramaFetch/Test Series [${SERIES_ID}]/Test Series - Episode 01.mp4`, "overwrite");
    assert.deepEqual(page.downloads.map((saved) => [saved.filename, saved.conflictAction]), [[`DramaFetch/Test Series [${SERIES_ID}]/Test Series - Episode 01.mp4`, "overwrite"]]);
    // any other job's: the resume (what is on disk is skipped)
    const batch = module.buildEngine({ ...BATCH_JOB, id: 991, refs: [refOf(OTHER_ID)] }, { pauses: [], inputs: [], taking: true });
    assert.equal(batch.overwrite, false);
    assert.equal(batch.downloader.config.overwrite, false);
  } finally {
    page.restore();
  }
  // run through the page's own queue to its end: the job's record says it downloaded again in full
  // (what every retry of it reads); a paste's does not
  const queued = await fakePage({ testSettings: QUICK });
  try {
    const { element, module } = queued;
    const ended = async (/** @type {number} */ count) => {
      for (let turn = 0; turn < 500 && (module.journal().length < count || element("app-status").dataset["state"] !== "idle"); turn += 1) await queued.turn();
    };
    await listOnScreen(queued, SERIES_ID, "Test Series");
    element("download-available-button").fire("click"); // the discovery can open no tab here: no request at all
    await ended(1);
    const [selection] = module.journal();
    assert.equal(selection?.["kind"], "selection");
    const [record] = /** @type {Record<string, unknown>[]} */ (selection?.["series"]);
    assert.deepEqual([record?.["series_id"], record?.["overwrite"]], [SERIES_ID, true]);
    assert.equal(paste(queued, SERIES_ID), true);
    await ended(2);
    const [pasted] = module.journal();
    assert.equal(pasted?.["kind"], "batch");
    const [batchRecord] = /** @type {Record<string, unknown>[]} */ (pasted?.["series"]);
    assert.deepEqual([batchRecord?.["series_id"], Object.hasOwn(batchRecord ?? {}, "overwrite")], [SERIES_ID, false]);
  } finally {
    queued.restore();
  }
});

test("the retries of a job that downloaded again in full do too (3.0.0): its records say `overwrite`, and so does each retry read from them — the tab's Retry, its one automatic retry, the alert's Retry, the ⚠ alert of an automatic retry that did not run —, so that an episode whose download again failed is never skipped for the old copy on disk; a retry of any other job keeps the resume", async () => {
  const again = { ...seriesRecord(OTHER_ID, "Drama 2399", [[1, "done"], [2, "failed"], [3, "failed-unavailable"]]), overwrite: true };
  const kept = seriesRecord(THIRD_ID, "Drama 2388", [[1, "failed"]]);
  /**
   * A See episodes job over `THIRD_ID`'s three episodes (Download all available).
   * @param {number} id
   * @returns {import("../src/app/app.js").Job}
   */
  const seeEpisodesJob = (id) => ({ id, kind: "selection", label: "3 episodes of Drama 2388", refs: [refOf(THIRD_ID)], series: null, numbers: [1, 2, 3], includeLocked: false, recheck: false, overwrite: true, pick: "available" });
  let page = await fakePage();
  try {
    const { element, module } = page;
    // what a retry takes from the records, and the jobs it queues
    assert.deepEqual(module.retryTargets([again, kept]), [
      { seriesId: OTHER_ID, name: "Drama 2399", numbers: [2, 3], overwrite: true },
      { seriesId: THIRD_ID, name: "Drama 2388", numbers: [1] },
    ]);
    assert.deepEqual(
      module.retryJobs(module.retryTargets([again, kept])).map((job) => [job.kind, job.label, job.numbers, job.includeLocked, job.overwrite]),
      [
        ["selection", "Retry 2 of Drama 2399", [2, 3], false, true],
        ["selection", "Retry 1 of Drama 2388", [1], false, undefined],
      ],
    );
    // the tab's Retry over them
    page.hold();
    module.renderFailed([again, kept]);
    element("retry-button").fire("click");
    await page.turn();
    assert.deepEqual(jobsOf(page).map((job) => [job.refs[0]?.seriesId, job.numbers, job.overwrite]), [
      [OTHER_ID, [2, 3], true],
      [THIRD_ID, [1], undefined],
    ]);
  } finally {
    page.restore();
  }
  // the automatic retry of a See episodes job's plain failure, and the ⚠ alert it gets when it
  // does not run (Stop): both download again in full
  page = await fakePage();
  try {
    const { module } = page;
    const notes = fakeNotifications();
    page.hold();
    const job = seeEpisodesJob(5);
    const scripted = scriptedEngine(page, job, { statuses: { [`${THIRD_ID}:2`]: "failed" } });
    assert.equal(scripted.engine.overwrite, true);
    const run = await runSelectionJob(scripted.engine, refOf(THIRD_ID), job.numbers, { lastContactAt: null });
    assert.deepEqual(run.results.map((result) => [result.episode.number, result.status]), [[1, "done"], [2, "failed"], [3, "done"]]);
    module.dramaDone(job, run, scripted.jobRecord); // where runJob makes the drama's alert
    await page.turn();
    const alertId = `dramafetch-alert:${module.alerts.page}:5:${THIRD_ID}:retry`;
    assert.deepEqual(jobsOf(page), [
      { kind: "selection", label: "Automatic retry: 1 of Drama 2388", refs: [refOf(THIRD_ID)], series: null, numbers: [2], includeLocked: false, recheck: false, overwrite: true, autoRetry: { alertId, name: "Drama 2388" } },
    ]);
    assert.equal(notes.shown.get(alertId)?.["title"], "↻ Drama 2388 — retrying 1 episode");
    const [automatic] = module.queuedJobs();
    assert.ok(automatic !== undefined);
    module.alertNotRetried(automatic, "stopped by you");
    assert.deepEqual(module.alerts.retryOf(alertId), { seriesId: THIRD_ID, name: "Drama 2388", numbers: [2], overwrite: true });
    module.alertNotRetried({ ...automatic, overwrite: undefined }, "stopped by you"); // an automatic retry of a paste's drama
    assert.deepEqual(module.alerts.retryOf(alertId), { seriesId: THIRD_ID, name: "Drama 2388", numbers: [2] });
  } finally {
    page.restore();
  }
  // the automatic retry off: the ⚠ alert's Retry, handed over by the worker
  page = await fakePage({ storage: NO_AUTO_RETRY });
  try {
    const { module } = page;
    const notes = fakeNotifications();
    const job = seeEpisodesJob(6);
    const scripted = scriptedEngine(page, job, { statuses: { [`${THIRD_ID}:2`]: "failed" } });
    const run = await runSelectionJob(scripted.engine, refOf(THIRD_ID), job.numbers, { lastContactAt: null });
    module.dramaDone(job, run, scripted.jobRecord);
    const alertId = `dramafetch-alert:${module.alerts.page}:6:${THIRD_ID}:retry`;
    assert.deepEqual(notes.created, [alertId]);
    assert.deepEqual(module.alerts.retryOf(alertId), { seriesId: THIRD_ID, name: "Drama 2388", numbers: [2], overwrite: true });
    page.hold();
    assert.deepEqual(page.message({ type: "dramafetch:retry", notificationId: alertId }, WORKER), [{ ok: true, queued: true, tabId: 1 }]);
    await page.turn();
    assert.deepEqual(jobsOf(page).map((queued) => [queued.label, queued.numbers, queued.overwrite]), [["Retry 1 of Drama 2388", [2], true]]);
  } finally {
    page.restore();
  }
});

test("See episodes (3.0.0): an episode on disk keeps its On disk badge and comes unticked; its tooltip says that the list's buttons download it again in full and replace the file — in English and in Spanish —; Download all available takes it with the rest", async () => {
  /** @type {["en" | "es", string][]} */
  const languages = [
    ["en", "Already downloaded: “Download all available”, or “Download selected” with it ticked, downloads it again in full and replaces the file"],
    ["es", "Ya descargado: “Descargar todo lo disponible”, o “Descargar selección” con él marcado, lo vuelve a descargar completo y reemplaza el archivo"],
  ];
  for (const [language, title] of languages) {
    const page = await fakePage({ storage: { [`series:${SERIES_ID}`]: savedState(SERIES_ID, [1, 2]) }, language });
    try {
      const { element, module } = page;
      // See episodes over the five-episode list (E05 locked), Chrome's history showing E01 and E02's files
      /** @type {import("../src/app/app.js").Job} */
      const job = { id: 99, kind: "load", label: `List series ${SERIES_ID}`, refs: [refOf(SERIES_ID)], series: null, numbers: [], includeLocked: false, recheck: false };
      const engine = module.buildEngine(job, { pauses: [], inputs: [], taking: true });
      engine.sleep = async () => undefined;
      engine.discover = async () => series([episode(1), episode(2), episode(3), episode(4), episode(5, { locked: true })]);
      engine.view = /** @type {import("../src/app/downloader.js").DownloadsView} */ (
        /** @type {unknown} */ ({ exists: () => true, refresh: async () => undefined, completedAt: () => null, remember() {} })
      );
      assert.equal(await module.runLoad(job, engine, {}), null);
      const rows = element("episode-table").querySelector("tbody")?.children ?? [];
      assert.deepEqual(
        rows.map((row) => [row.getAttribute("data-number"), row.children[0]?.children[0]?.checked, descendants(row).find((part) => part.className === "badge ondisk")?.title ?? null]),
        [
          ["1", false, title],
          ["2", false, title],
          ["3", true, null],
          ["4", true, null],
          ["5", false, null],
        ],
        language,
      );
      page.hold();
      element("download-available-button").fire("click");
      await page.turn();
      assert.deepEqual(jobsOf(page).map((queued) => [queued.numbers, queued.overwrite]), [[[1, 2, 3, 4], true]]); // on disk or not
    } finally {
      page.restore();
    }
  }
});

/**
 * A library card's state as the tests compare it: its `data-status`, its badge's text and its bar's
 * `[value, max]` — no badge and no bar while it is idle.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {string} seriesId
 */
const cardState = (page, seriesId) => {
  const article = /** @type {FakeElement} */ (cardOf(page, seriesId));
  const bar = descendants(article).find((part) => part.tagName === "PROGRESS");
  return [article.getAttribute("data-status"), partOf(article, "favorite-status")?.textContent, bar?.getAttribute("value"), bar?.getAttribute("max")];
};

/**
 * Every text a library card's badge shows from now on, in order, one entry per change — `(idle)`
 * for no badge: what a user sees between the samples a test takes, every redraw of the grid read.
 * @param {Awaited<ReturnType<typeof fakePage>>} page
 * @param {string} seriesId
 * @returns {string[]}
 */
function recordCard(page, seriesId) {
  const grid = page.element("favorites-grid");
  /** @type {string[]} */
  const seen = [];
  const draw = grid.replaceChildren.bind(grid);
  grid.replaceChildren = (/** @type {FakeElement[]} */ ...cards) => {
    draw(...cards);
    const card = cardOf(page, seriesId);
    const text = card === undefined ? "(no card)" : (partOf(card, "favorite-status")?.textContent ?? "(idle)");
    if (seen.at(-1) !== text) seen.push(text);
  };
  return seen;
}

test("the page: See episodes' download (a `selection` job — 3.0.0: in full) waiting behind another drama's batch holds its drama like any download: its card says Queued, its Download is disabled, and a paste or the popup's hand-over of it queues nothing", async () => {
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE) } });
  try {
    const { element, module } = page;
    page.hold(); // the running job's tabs.getCurrent never answers: it runs, asking nothing; the next one waits
    await listOnScreen(page, PAPER, "Paper Crowns");
    assert.equal(paste(page, MOON), true); // another drama's batch: it runs
    await page.turn();
    tickEpisodes(page, [2]);
    element("download-selected-button").fire("click"); // waits behind it
    await settled(page);
    assert.deepEqual(jobsOf(page).map((job) => [job.kind, job.refs.map((ref) => ref.seriesId), job.overwrite === true]), [
      ["batch", [MOON], false],
      ["selection", [PAPER], true],
    ]);
    assert.deepEqual(cardState(page, PAPER), ["queued", "Queued", undefined, undefined]);
    assert.equal(actionOf(page, PAPER, "download")?.disabled, true);
    assert.equal(paste(page, PAPER), true);
    assert.equal(element("input-status").textContent, `Already being downloaded, or waiting to be — not queued twice: ${PAPER}.`);
    element("input-status").textContent = "";
    assert.deepEqual(page.message({ type: "dramafetch:load", input: PAPER }), [{ ok: true, tabId: 1 }]); // the popup's Download this series
    assert.equal(element("input-status").textContent, `Already being downloaded, or waiting to be — not queued twice: ${PAPER}.`);
    assert.equal(module.queuedJobs().length, 2); // nothing queued twice
  } finally {
    page.restore();
  }
});

test("the page: See episodes' download in full of a drama already on disk (3.0.0) holds its drama like any download — Queued while it waits, Downloading with its bar while it runs, its Download disabled and a paste of it refused throughout — and its count follows the job: the episodes it takes again count once saved anew, against the drama's own 30, never going down; at its end the card says nothing and its Download is back", async () => {
  const thirty = Array.from({ length: 30 }, (_, n) => n + 1);
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE), [`series:${PAPER}`]: savedState(PAPER, thirty, { complete: 30 }) }, testSettings: QUICK });
  try {
    const { element, module, local } = page;
    const refused = `Already being downloaded, or waiting to be — not queued twice: ${PAPER}.`;
    const open = gateJobs(); // the job starts and waits at its first step, asking nothing
    await listOnScreen(page, PAPER, "Paper Crowns");
    tickEpisodes(page, [1, 3]); // both on disk: ticked, they download again in full
    const seen = recordCard(page, PAPER);
    element("download-selected-button").fire("click");
    await settled(page);
    assert.deepEqual(jobsOf(page).map((job) => [job.kind, job.refs.map((ref) => ref.seriesId), job.numbers, job.overwrite]), [["selection", [PAPER], [1, 3], true]]);
    // not begun yet: Queued, no bar
    assert.deepEqual(cardState(page, PAPER), ["queued", "Queued", undefined, undefined]);
    assert.equal(actionOf(page, PAPER, "download")?.disabled, true);
    assert.equal(paste(page, PAPER), true);
    assert.equal(element("input-status").textContent, refused);
    assert.equal(module.queuedJobs().length, 1);
    // its drama begins (the engine's hooks, as it calls them): Downloading, the two it takes again not counted
    const [running] = module.queuedJobs();
    assert.ok(running !== undefined);
    const engine = module.buildEngine(running, { pauses: [], inputs: [], taking: true });
    /** @param {number} number */
    const ep = (number) => makeEpisode({ number, itemId: `i${number}`, title: `Episode ${number}`, seriesId: PAPER, durationS: 3, coverUrl: null, raw: {} });
    engine.onStart?.({ ref: refOf(PAPER), series: null, name: "Paper Crowns", episodes: [ep(1), ep(3)], skippedComplete: false });
    await settled(page);
    assert.deepEqual(cardState(page, PAPER), ["running", "Downloading · 28/30", "28", "30"]);
    assert.equal(actionOf(page, PAPER, "download")?.disabled, true);
    element("input-status").textContent = "";
    assert.equal(paste(page, PAPER), true);
    assert.equal(element("input-status").textContent, refused);
    assert.equal(module.queuedJobs().length, 1);
    // E01 saved anew (the records hold its new download): counted again
    local.set(`series:${PAPER}`, savedState(PAPER, thirty));
    engine.onResult?.({ episode: ep(1), status: "done", path: "/dl/E1.mp4", message: "saved E1.mp4 (0.1 MiB) + cover embedded", downloadId: 201 });
    await settled(page);
    assert.deepEqual(cardState(page, PAPER), ["running", "Downloading · 29/30", "29", "30"]);
    // E03's download again failed (its record says so; its old file untouched): not counted, the count unchanged
    const failed = savedState(PAPER, thirty.filter((number) => number !== 3));
    failed.episodes["3"] = { number: 3, item_id: "i3", status: "failed", path: null, message: "download failed: HTTP 500", updated_at: "2027-01-15T08:00:00Z", download_id: null };
    local.set(`series:${PAPER}`, failed);
    engine.onResult?.({ episode: ep(3), status: "failed", path: null, message: "download failed: HTTP 500" });
    await settled(page);
    assert.deepEqual(cardState(page, PAPER), ["running", "Downloading · 29/30", "29", "30"]);
    // the job ends (its listing can open no tab here: no request at all): nothing on the card, its Download back
    open();
    for (let turn = 0; turn < 500 && (module.journal().length === 0 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    assert.equal(module.journal().length, 1);
    await settled(page);
    assert.deepEqual(cardState(page, PAPER), ["idle", undefined, undefined, undefined]);
    assert.equal(actionOf(page, PAPER, "download")?.disabled, false);
    assert.equal(metaOf(page, PAPER), "30 episodes · 40m");
    // everything the card showed, every redraw: its count only went up
    assert.deepEqual(seen, ["Queued", "Downloading · 28/30", "Downloading · 29/30", "(idle)"]);
  } finally {
    page.restore();
  }
});

test("the page: a download in full (3.0.0) counts again each episode it takes once that one is done — saved anew, or skipped as locked with its earlier download kept, no request — and takes only what its fresh list holds: an episode ticked on the list on screen that the fresh list lacks keeps counting as on disk; its first count is exact — also when it takes episodes not on disk, as a Retry of its failures does —, the count only goes up and ends at the drama's 30", async () => {
  const thirty = Array.from({ length: 30 }, (_, n) => n + 1);
  for (const fourth of ["missing", "locked"]) {
    const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE), [`series:${PAPER}`]: savedState(PAPER, thirty, { complete: 30 }) }, testSettings: QUICK });
    try {
      const { element, module } = page;
      const open = gateJobs(); // the job starts and waits at its first step, asking nothing
      await listOnScreen(page, PAPER, "Paper Crowns");
      tickEpisodes(page, [1, 2, 3, 4]); // all four on disk: ticked, they download again in full
      const seen = recordCard(page, PAPER);
      element("download-selected-button").fire("click");
      await settled(page);
      const [running] = module.queuedJobs();
      assert.ok(running !== undefined);
      assert.deepEqual([running.numbers, running.overwrite], [[1, 2, 3, 4], true], fourth);
      const engine = module.buildEngine(running, { pauses: [], inputs: [], taking: true });
      // the fresh list: E04 gone from it, or listed locked now (an entitlement that lapsed)
      const taken = [1, 2, 3].map((number) => episode(number, { seriesId: PAPER })).concat(fourth === "locked" ? [episode(4, { locked: true, seriesId: PAPER })] : []);
      engine.onStart?.({ ref: refOf(PAPER), series: null, name: "Paper Crowns", episodes: taken, skippedComplete: false });
      await settled(page);
      const first = fourth === "missing" ? 27 : 26;
      assert.deepEqual(cardState(page, PAPER), ["running", `Downloading · ${first}/30`, String(first), "30"], fourth);
      // E01–E03 saved anew (the records hold a done entry each, as before)
      for (const ep of taken.slice(0, 3)) {
        engine.onResult?.({ episode: ep, status: "done", path: `/dl/E${ep.number}.mp4`, message: `saved E${ep.number}.mp4 (0.1 MiB) + cover embedded`, downloadId: 200 + ep.number });
        await settled(page);
      }
      if (fourth === "locked") {
        // no request: the locked skip, which never replaces an entry on disk — its earlier download counts again
        engine.onResult?.({ episode: /** @type {import("../src/lib/catalog.js").Episode} */ (taken[3]), status: "skipped-locked", path: null, message: "looks locked: no play address" });
        await settled(page);
      }
      assert.deepEqual(cardState(page, PAPER), ["running", "Downloading · 30/30", "30", "30"], fourth);
      open();
      for (let turn = 0; turn < 500 && (module.journal().length === 0 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
      await settled(page);
      assert.deepEqual(cardState(page, PAPER), ["idle", undefined, undefined, undefined], fourth);
      const counts = seen.flatMap((text) => /Downloading · (\d+)\/30$/.exec(text)?.[1] ?? []).map(Number);
      assert.deepEqual(counts, fourth === "missing" ? [27, 28, 29, 30] : [26, 27, 28, 29, 30], `${fourth}: ${JSON.stringify(seen)}`);
      assert.deepEqual([seen[0], seen.at(-1)], ["Queued", "(idle)"], fourth);
    } finally {
      page.restore();
    }
  }
  // E02 and E04 not on disk (an earlier download in full's failures): 28 at once — never 26, the 28
  // lowered by two episodes the records do not count anyway —, then 29 and 30 as each is saved
  const missing = thirty.filter((number) => number !== 2 && number !== 4);
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE), [`series:${PAPER}`]: savedState(PAPER, missing) }, testSettings: QUICK });
  try {
    const { element, module, local } = page;
    const open = gateJobs();
    await listOnScreen(page, PAPER, "Paper Crowns");
    tickEpisodes(page, [2, 4]);
    const seen = recordCard(page, PAPER);
    element("download-selected-button").fire("click");
    await settled(page);
    const [running] = module.queuedJobs();
    assert.ok(running !== undefined);
    assert.deepEqual([running.numbers, running.overwrite], [[2, 4], true]);
    const engine = module.buildEngine(running, { pauses: [], inputs: [], taking: true });
    const [two, four] = [2, 4].map((number) => episode(number, { seriesId: PAPER }));
    assert.ok(two !== undefined && four !== undefined);
    engine.onStart?.({ ref: refOf(PAPER), series: null, name: "Paper Crowns", episodes: [two, four], skippedComplete: false });
    await settled(page);
    assert.deepEqual(cardState(page, PAPER), ["running", "Downloading · 28/30", "28", "30"]);
    local.set(`series:${PAPER}`, savedState(PAPER, thirty.filter((number) => number !== 4)));
    engine.onResult?.({ episode: two, status: "done", path: "/dl/E2.mp4", message: "saved E2.mp4 (0.1 MiB) + cover embedded", downloadId: 202 });
    await settled(page);
    local.set(`series:${PAPER}`, savedState(PAPER, thirty));
    engine.onResult?.({ episode: four, status: "done", path: "/dl/E4.mp4", message: "saved E4.mp4 (0.1 MiB) + cover embedded", downloadId: 204 });
    await settled(page);
    open();
    for (let turn = 0; turn < 500 && (module.journal().length === 0 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    await settled(page);
    assert.deepEqual(seen, ["Queued", "Downloading · 28/30", "Downloading · 29/30", "Downloading · 30/30", "(idle)"]);
  } finally {
    page.restore();
  }
});

test("the page: a download in full (3.0.0) whose drama's records the storage refuses to read as it begins still says Downloading on its card — at most the count it would have read (the stored one less the episodes it takes again), never more", async () => {
  const thirty = Array.from({ length: 30 }, (_, n) => n + 1);
  const page = await fakePage({ storage: { favoritesLibrary: storedLibrary(FIVE), [`series:${PAPER}`]: savedState(PAPER, thirty, { complete: 30 }) }, testSettings: QUICK });
  const local = /** @type {{get: (keys: unknown) => unknown}} */ (/** @type {unknown} */ (chrome.storage.local));
  const get = local.get;
  try {
    const { element, module } = page;
    const open = gateJobs();
    await listOnScreen(page, PAPER, "Paper Crowns");
    tickEpisodes(page, [1, 3]);
    const seen = recordCard(page, PAPER);
    element("download-selected-button").fire("click");
    await settled(page);
    const [running] = module.queuedJobs();
    assert.ok(running !== undefined);
    const engine = module.buildEngine(running, { pauses: [], inputs: [], taking: true });
    local.get = async () => {
      throw new Error("IO error: the profile's storage refused the read");
    };
    engine.onStart?.({ ref: refOf(PAPER), series: null, name: "Paper Crowns", episodes: [1, 3].map((number) => episode(number, { seriesId: PAPER })), skippedComplete: false });
    await settled(page);
    assert.deepEqual(cardState(page, PAPER), ["running", "Downloading · 28/30", "28", "30"]);
    assert.deepEqual(seen, ["Queued", "Downloading · 28/30"]);
    local.get = get;
    open();
    for (let turn = 0; turn < 500 && (module.journal().length === 0 || element("app-status").dataset["state"] !== "idle"); turn += 1) await page.turn();
    await settled(page);
    assert.deepEqual(cardState(page, PAPER), ["idle", undefined, undefined, undefined]);
  } finally {
    local.get = get;
    page.restore();
  }
});
