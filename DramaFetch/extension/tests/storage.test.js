// @ts-check
// The history is the least important thing the extension stores: it is cut to the last 20 runs
// and to HISTORY_MAX_BYTES of JSON, the oldest first, and when chrome.storage.local refuses it (a
// full disk under the Chrome profile) it gives way and never throws. A refusal's cooldown the
// storage will not take stays in force from memory.
import assert from "node:assert/strict";
import { test } from "node:test";

import { activeCooldown, clearCooldown, recordBlock } from "../src/lib/cooldown.js";
import { MEDIA_RATE_LIMIT_MESSAGE } from "../src/lib/messages.js";
import { reportLine, reportToDict } from "../src/lib/report.js";
import {
  DEFAULT_SETTINGS,
  HISTORY_ENTRY_MAX_BYTES,
  HISTORY_KEY,
  HISTORY_LIMIT,
  HISTORY_MAX_BYTES,
  appendHistory,
  cooldownStore,
  historyEntry,
  normalizeSettings,
  settingsProblem,
  trimHistory,
} from "../src/app/storage.js";

/** What Chrome 153 rejects a `chrome.storage.local.set` with when the disk under its profile is full. */
const REFUSED = "IO error: .../000003.log: FILE_ERROR_NO_SPACE (ChromeMethodBFE: 3::WritableFileAppend::8)";

/**
 * A `chrome.storage.local` whose writes (`set`, `remove`) and reads (`get`) can be made to reject,
 * installed as the global `chrome` with a `chrome.storage.session` (the browser session's memory:
 * `session`, never refused).
 * @param {Record<string, unknown>} [stored]
 * @param {Record<string, unknown>} [session]
 */
function fakeLocal(stored = {}, session = {}) {
  const switches = { refuseWrites: false, refuseReads: false };
  const local = {
    /** @param {string} key */
    async get(key) {
      if (switches.refuseReads) throw new Error("IO error: the store cannot be read");
      return Object.hasOwn(stored, key) ? { [key]: stored[key] } : {};
    },
    /** @param {Record<string, unknown>} items */
    async set(items) {
      if (switches.refuseWrites) throw new Error(REFUSED);
      Object.assign(stored, items);
    },
    /** @param {string} key */
    async remove(key) {
      if (switches.refuseWrites) throw new Error(REFUSED);
      delete stored[key];
    },
  };
  const sessionArea = {
    /** @param {string} key */
    get: async (key) => (Object.hasOwn(session, key) ? { [key]: session[key] } : {}),
    /** @param {Record<string, unknown>} items */
    set: async (items) => void Object.assign(session, items),
    /** @param {string} key */
    remove: async (key) => void delete session[key],
  };
  Object.assign(globalThis, { chrome: { storage: { local, session: sessionArea } } });
  return { stored, session, switches };
}

/**
 * A finished run of about `bytes` bytes of JSON.
 * @param {number} id
 * @param {number} [bytes]
 * @returns {Record<string, unknown>}
 */
function run(id, bytes = 100) {
  return { id, label: `run ${id}`, padding: "x".repeat(Math.max(0, bytes - 40)) };
}

/** @param {unknown} value a history, or one entry of it @returns {number} its size as UTF-8 JSON */
const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

test("the history keeps the last 20 runs, most recent first", () => {
  const entries = Array.from({ length: 30 }, (_, index) => run(30 - index));
  const kept = trimHistory(entries);
  assert.equal(kept.length, HISTORY_LIMIT);
  assert.deepEqual(
    kept.map((entry) => entry["id"]),
    Array.from({ length: 20 }, (_, index) => 30 - index),
  );
});

test("over the byte budget the oldest runs go first; the most recent always stays", () => {
  const entries = [run(5, 400), run(4, 400), run(3, 400), run(2, 400), run(1, 400)];
  const kept = trimHistory(entries, HISTORY_LIMIT, 1000);
  assert.deepEqual(
    kept.map((entry) => entry["id"]),
    [5, 4],
  );
  assert.ok(size(kept) <= 1000);
  const alone = trimHistory([run(9, 5000), run(8, 10)], HISTORY_LIMIT, 1000);
  assert.deepEqual(
    alone.map((entry) => entry["id"]),
    [9],
  );
  // the real budget holds hundreds of ordinary runs' worth of rows
  assert.ok(HISTORY_MAX_BYTES >= 1024 * 1024);
  assert.equal(trimHistory([run(1), run(2)]).length, 2);
});

test("a storage that refuses the history gets the run alone, else no history", async () => {
  /** @type {Record<string, unknown>} */
  const stored = { [HISTORY_KEY]: [run(2, 300), run(1, 300)] };
  let refuseAbove = 500;
  const local = {
    /** @param {string} key */
    async get(key) {
      return { [key]: stored[key] };
    },
    /** @param {Record<string, unknown>} items */
    async set(items) {
      if (size(Object.values(items)) > refuseAbove) throw new Error("Resource::kQuotaBytes quota exceeded");
      Object.assign(stored, items);
    },
    /** @param {string} key */
    async remove(key) {
      delete stored[key];
    },
  };
  Object.assign(globalThis, { chrome: { storage: { local } } });
  await appendHistory(run(3, 300));
  assert.deepEqual(
    /** @type {Record<string, unknown>[]} */ (stored[HISTORY_KEY]).map((entry) => entry["id"]),
    [3],
  );
  refuseAbove = 10;
  await appendHistory(run(4, 300));
  assert.equal(Object.hasOwn(stored, HISTORY_KEY), false);
  refuseAbove = Number.POSITIVE_INFINITY;
  await appendHistory(run(5, 300));
  assert.deepEqual(
    /** @type {Record<string, unknown>[]} */ (stored[HISTORY_KEY]).map((entry) => entry["id"]),
    [5],
  );
});

/**
 * A finished series' report: `episodes` listed, the `failedNumbers` failed, the rest downloaded.
 * @param {string} seriesId
 * @param {string} name
 * @param {number} episodes
 * @param {number[]} failedNumbers
 * @returns {import("../src/lib/report.js").SeriesReport}
 */
function seriesReportOf(seriesId, name, episodes, failedNumbers) {
  const failed = failedNumbers.length;
  return { seriesId, name, listed: episodes, done: episodes - failed, onDisk: 0, locked: 0, failed, gaps: [], complete: failed === 0, skippedComplete: false, stopped: null, total: episodes, lockedNumbers: [], failedNumbers, totalHint: episodes, checkedAgoS: null, unlocked: 0, unlockedNumbers: [] };
}

/**
 * The history entry of a batch as the page records it (app.js `runToHistory`: each series' line,
 * its report as `reportToDict` writes it, a row per episode): `seriesCount` series of `episodes`
 * rows, the second episode of every `failEvery`-th series failed, a pause per episode.
 * @param {number} id
 * @param {number} seriesCount
 * @param {number} episodes
 * @param {number} [failEvery]
 * @returns {Record<string, unknown>}
 */
function batchRun(id, seriesCount, episodes, failEvery = 10) {
  return {
    id,
    kind: "batch",
    label: `${seriesCount} series`,
    started_at: "2026-11-12T08:00:00.000Z",
    finished_at: "2026-11-12T20:00:00.000Z",
    error: null,
    stopped: null,
    refreshes: 0,
    pauses: Array.from({ length: seriesCount * episodes }, () => ({ kind: "pace", seconds: 6.4, text: "pausing 6.4 s" })),
    series: Array.from({ length: seriesCount }, (_, index) => {
      const seriesId = String(7599400000000000000n + BigInt(index));
      const name = `Invented Series Number ${index}`;
      const failedNumbers = index % failEvery === 0 ? [2] : [];
      const report = seriesReportOf(seriesId, name, episodes, failedNumbers);
      return {
        series_id: seriesId,
        name,
        status: report.complete ? "complete" : "incomplete",
        error: null,
        error_kind: null,
        stop: false,
        contacted: true,
        line: reportLine(report),
        report: reportToDict(report),
        rows: Array.from({ length: episodes }, (_, row) => ({
          number: row + 1,
          status: failedNumbers.includes(row + 1) ? "failed-unavailable" : "done",
          message: `saved ${name} - Episode ${String(row + 1).padStart(2, "0")}.mp4 (12.3 MiB) + cover embedded`,
          path: `C:\\Users\\Owner\\Downloads\\DramaFetch\\${name}\\Episode ${row + 1}.mp4`,
          download_id: index * 100 + row,
        })),
      };
    }),
  };
}

/**
 * @param {Record<string, unknown>} entry a history entry
 * @returns {Record<string, unknown>[]} its series records
 */
const seriesOf = (entry) => /** @type {Record<string, unknown>[]} */ (entry["series"]);

test("a run too large for its share of the history is stored compact — its failure rows, its series' lines, no pauses, no reports — and pushes no earlier run out", async () => {
  const small = batchRun(1, 2, 60);
  assert.ok(size([small]) < HISTORY_MAX_BYTES);
  assert.equal(historyEntry(small), small); // a run that fits is stored as it is
  const large = batchRun(2, 70, 60);
  assert.ok(size([large]) > HISTORY_MAX_BYTES, String(size([large]))); // 4 200 rows and 4 200 pauses: over 1 MiB
  const compact = historyEntry(large);
  assert.ok(size(compact) <= HISTORY_ENTRY_MAX_BYTES, String(size(compact)));
  assert.equal(Object.hasOwn(compact, "series_omitted"), false); // every series listed
  assert.deepEqual(compact["pauses"], []);
  assert.equal(compact["pauses_omitted"], 4200);
  const series = /** @type {Record<string, unknown>[]} */ (compact["series"]);
  assert.equal(series.length, 70);
  for (const [index, record] of series.entries()) {
    const whole = /** @type {Record<string, unknown>[]} */ (large["series"])[index];
    const { rows, rows_omitted: omitted, ...rest } = record;
    const { rows: wholeRows, report, ...wholeRest } = /** @type {Record<string, unknown>} */ (whole);
    assert.deepEqual(rest, wholeRest); // the name, the status, the error and the line stay
    assert.equal(typeof report, "object"); // the report, which Past runs never reads, goes
    const failures = /** @type {Record<string, unknown>[]} */ (wholeRows).filter((row) => String(row["status"]).startsWith("failed"));
    assert.deepEqual(rows, failures); // every row the retry reads, whole
    assert.equal(omitted, 60 - failures.length);
  }
  assert.equal(series.filter((record) => /** @type {unknown[]} */ (record["rows"]).length === 1).length, 7);
  for (const key of ["id", "kind", "label", "started_at", "finished_at", "error", "stopped", "refreshes"]) assert.deepEqual(compact[key], large[key]);
  assert.equal(JSON.stringify(large).length > 1_000_000, true); // the run handed in is not touched
  // malformed parts are left as they are, never a throw
  const odd = { id: 3, padding: "x".repeat(2000), pauses: "none", series: [null, { series_id: "1", rows: "many" }, { series_id: "2", rows: [null, { status: 7 }, { status: "failed" }] }] };
  assert.deepEqual(historyEntry(odd, 1000), { ...odd, pauses: [], pauses_omitted: 0, series: [null, { series_id: "1", rows: "many" }, { series_id: "2", rows: [{ status: "failed" }], rows_omitted: 2 }] });
  // stored: the earlier runs stay, where the whole run would have pushed them all out
  const { stored } = fakeLocal({ [HISTORY_KEY]: [run(1), run(0)] });
  await appendHistory(large);
  const history = /** @type {Record<string, unknown>[]} */ (stored[HISTORY_KEY]);
  assert.deepEqual(history.map((entry) => entry["id"]), [2, 1, 0]);
  assert.deepEqual(history[0], compact);
  assert.ok(size(history) < HISTORY_MAX_BYTES);
});

test("every run is held to its share of the history: back-to-back batches of 40 series all stay, each with its retry", async () => {
  // twenty runs of the share, each with its comma, and the brackets fit the history's budget
  assert.ok(HISTORY_LIMIT * (HISTORY_ENTRY_MAX_BYTES + 1) + 2 <= HISTORY_MAX_BYTES);
  assert.ok(HISTORY_ENTRY_MAX_BYTES > 50 * 1024);
  const one = batchRun(1, 40, 60);
  assert.ok(size([one]) > HISTORY_ENTRY_MAX_BYTES && size([one]) < HISTORY_MAX_BYTES, String(size([one]))); // whole, it would fit 1 MiB alone
  const { stored } = fakeLocal();
  for (let id = 1; id <= HISTORY_LIMIT; id += 1) await appendHistory(batchRun(id, 40, 60));
  const history = /** @type {Record<string, unknown>[]} */ (stored[HISTORY_KEY]);
  assert.deepEqual(history.map((entry) => entry["id"]), Array.from({ length: HISTORY_LIMIT }, (_, index) => HISTORY_LIMIT - index));
  for (const entry of history) {
    const series = /** @type {Record<string, unknown>[]} */ (entry["series"]);
    assert.equal(series.filter((record) => /** @type {unknown[]} */ (record["rows"]).length === 1).length, 4); // the failures each run's retry reads
  }
  assert.ok(size(history) <= HISTORY_MAX_BYTES);
  // a run within its share is stored as it is: what the end-to-end scenarios read of small runs
  const small = batchRun(99, 1, 60);
  assert.ok(size([small]) <= HISTORY_ENTRY_MAX_BYTES);
  assert.equal(historyEntry(small), small);
});

test("a batch of hundreds or thousands of series is held to its share too: the series with an episode to retry first, then as many others as fit, and how many more it had", async () => {
  // 300 series, a failure in every tenth: compact with every series listed it would pass the share
  const large = batchRun(1, 300, 10);
  const entry = historyEntry(large);
  assert.ok(size(entry) <= HISTORY_ENTRY_MAX_BYTES, String(size(entry)));
  const kept = seriesOf(entry);
  const omitted = Number(entry["series_omitted"]);
  assert.ok(omitted > 0 && kept.length > 150, `${kept.length} kept, ${omitted} omitted`);
  assert.equal(kept.length + omitted, 300);
  // in batch order; every series with an episode to retry kept, its rows' number and status only
  const order = seriesOf(large).map((record) => record["series_id"]);
  const keptIds = kept.map((record) => record["series_id"]);
  assert.deepEqual(keptIds, order.filter((id) => keptIds.includes(id)));
  const retried = kept.filter((record) => /** @type {unknown[]} */ (record["rows"]).length > 0);
  assert.equal(retried.length, 30);
  for (const record of retried) assert.deepEqual(record["rows"], [{ number: 2, status: "failed-unavailable" }]);
  for (const record of kept) {
    assert.equal(Object.hasOwn(record, "report"), false);
    assert.match(String(record["line"]), /^(complete|incomplete): /);
  }
  assert.deepEqual(entry["pauses"], []);
  assert.equal(entry["pauses_omitted"], 3000);
  // twenty of them back to back: all twenty stay
  const { stored } = fakeLocal();
  for (let id = 1; id <= HISTORY_LIMIT; id += 1) await appendHistory(batchRun(id, 300, 10));
  const history = /** @type {Record<string, unknown>[]} */ (stored[HISTORY_KEY]);
  assert.deepEqual(history.map((run) => run["id"]), Array.from({ length: HISTORY_LIMIT }, (_, index) => HISTORY_LIMIT - index));
  assert.ok(size(history) <= HISTORY_MAX_BYTES, String(size(history)));
  // nineteen runs, then one batch of 2 000 series with an episode to retry in each: the nineteen
  // stay, and the batch keeps as many series to retry as fit, and says how many more it had
  const { stored: after } = fakeLocal();
  for (let id = 1; id < HISTORY_LIMIT; id += 1) await appendHistory(run(id));
  await appendHistory(batchRun(HISTORY_LIMIT, 2000, 2, 1));
  const both = /** @type {Record<string, unknown>[]} */ (after[HISTORY_KEY]);
  assert.deepEqual(both.map((run) => run["id"]), Array.from({ length: HISTORY_LIMIT }, (_, index) => HISTORY_LIMIT - index));
  const huge = /** @type {Record<string, unknown>} */ (both[0]);
  assert.ok(size(huge) <= HISTORY_ENTRY_MAX_BYTES, String(size(huge)));
  const listed = seriesOf(huge);
  assert.ok(listed.length > 100, String(listed.length));
  assert.ok(listed.every((record) => /** @type {unknown[]} */ (record["rows"]).length === 1));
  assert.equal(huge["series_omitted"], 2000 - listed.length);
  // a run that does not even need the second step lists every series and no count
  assert.equal(Object.hasOwn(historyEntry(batchRun(2, 70, 60)), "series_omitted"), false);
  // the second step over malformed parts: left as they are, in order, never a throw
  const records = [null, "odd", { series_id: "x", rows: "many", report: {} }, ...Array.from({ length: 40 }, (_, index) => ({ series_id: String(index), rows: [{ number: 1, status: "failed", message: "m".repeat(50) }] }))];
  const held = historyEntry({ id: 5, pauses: [], series: records }, 1000);
  assert.ok(size(held) <= 1000, String(size(held)));
  const heldSeries = /** @type {unknown[]} */ (held["series"]);
  assert.deepEqual(heldSeries.slice(0, 2), [null, "odd"]); // small enough to fit after the series to retry, in batch order
  const retry = heldSeries.slice(2).filter((record) => JSON.stringify(record) !== '{"series_id":"x","rows":"many"}');
  assert.ok(retry.length > 5, String(retry.length));
  assert.deepEqual(retry, retry.map((_, index) => ({ series_id: String(index), rows: [{ number: 1, status: "failed" }], rows_omitted: 0 })));
  assert.equal(Number(held["series_omitted"]) + heldSeries.length, records.length);
  // a run whose own fields pass the share keeps its series: leaving them out would not bring it in
  const wordy = historyEntry({ id: 6, error: "e".repeat(2000), series: [{ series_id: "1", rows: [{ status: "done" }] }] }, 1000);
  assert.deepEqual(wordy["series"], [{ series_id: "1", rows: [], rows_omitted: 1 }]);
  assert.equal(Object.hasOwn(wordy, "series_omitted"), false);
});

test("the history never throws: a store that can be neither read nor written ends a job all the same", async () => {
  const { stored, switches } = fakeLocal({ [HISTORY_KEY]: [run(1)] });
  switches.refuseWrites = true;
  await appendHistory(run(2)); // set, set and remove all reject
  assert.deepEqual(/** @type {Record<string, unknown>[]} */ (stored[HISTORY_KEY]).map((entry) => entry["id"]), [1]);
  switches.refuseReads = true;
  await appendHistory(run(3)); // and get rejects too
  switches.refuseWrites = false;
  await appendHistory(run(4)); // unreadable but writable: the run alone, the unreadable history gives way
  assert.deepEqual(/** @type {Record<string, unknown>[]} */ (stored[HISTORY_KEY]).map((entry) => entry["id"]), [4]);
});

test("a cooldown the storage refuses to write is in force from memory until it ends; the next one stored replaces it", async () => {
  const { stored, switches } = fakeLocal();
  const now = 1_800_000_000;
  /** @type {unknown[]} */
  const errors = [];
  switches.refuseWrites = true;
  const recorded = await recordBlock(cooldownStore(), MEDIA_RATE_LIMIT_MESSAGE, "browser", { now, onError: (error) => errors.push(error) });
  assert.equal(recorded.until, now + 1800);
  assert.equal(errors.length, 1); // the write was refused…
  assert.equal(Object.hasOwn(stored, "cooldown"), false);
  const active = await activeCooldown(cooldownStore(), { now: now + 60 }); // …and another store object of the page still knows it
  assert.equal(active?.until, now + 1800);
  assert.equal(active?.reason, MEDIA_RATE_LIMIT_MESSAGE);
  assert.equal(active?.source, "browser");
  assert.equal(await activeCooldown(cooldownStore(), { now: now + 1801 }), null); // it ends when it would have
  switches.refuseReads = true;
  assert.equal((await activeCooldown(cooldownStore(), { now: now + 60 }))?.until, now + 1800); // an unreadable store too
  switches.refuseReads = false;
  // an older record the storage holds never hides the newer refusal it could not take, nor the other way round
  stored["cooldown"] = { until: now + 600, reason: "earlier", source: "discovery", recorded_at: now - 1200 };
  assert.equal((await activeCooldown(cooldownStore(), { now: now + 60 }))?.reason, MEDIA_RATE_LIMIT_MESSAGE);
  stored["cooldown"] = { until: now + 3000, reason: "another tab", source: "discovery", recorded_at: now + 1200 };
  assert.equal((await activeCooldown(cooldownStore(), { now: now + 60 }))?.reason, "another tab");
  // the next refusal the storage accepts is the record again: nothing is kept in memory
  switches.refuseWrites = false;
  await recordBlock(cooldownStore(), "later refusal", "discovery", { now: now + 100 });
  assert.equal(/** @type {Record<string, unknown>} */ (stored["cooldown"])["until"], now + 100 + 1800);
  delete stored["cooldown"];
  assert.equal(await activeCooldown(cooldownStore(), { now: now + 200 }), null);
  // clearing (the tests' and the expired record's only) forgets the one in memory as well
  switches.refuseWrites = true;
  await recordBlock(cooldownStore(), "refused again", "browser", { now: now + 300 });
  assert.equal((await activeCooldown(cooldownStore(), { now: now + 301 }))?.reason, "refused again");
  switches.refuseWrites = false;
  await clearCooldown(cooldownStore());
  assert.equal(await activeCooldown(cooldownStore(), { now: now + 302 }), null);
});

test("a cooldown the storage refuses survives a reload of the tab: the browser session's memory keeps it until Chrome closes", async () => {
  const { stored, session, switches } = fakeLocal();
  const now = 1_800_000_000;
  switches.refuseWrites = true;
  await recordBlock(cooldownStore(), MEDIA_RATE_LIMIT_MESSAGE, "browser", { now, onError: () => undefined });
  assert.equal(Object.hasOwn(stored, "cooldown"), false);
  assert.equal(/** @type {Record<string, unknown>} */ (session["cooldown"])["until"], now + 1800);
  // the page reloaded: a fresh instance of the module, its memory empty — the session still answers
  const reloaded = /** @type {typeof import("../src/app/storage.js")} */ (await import(`../src/app/storage.js?reload=${now}`));
  assert.equal((await activeCooldown(reloaded.cooldownStore(), { now: now + 60 }))?.reason, MEDIA_RATE_LIMIT_MESSAGE);
  assert.equal(Object.hasOwn(stored, "cooldown"), false); // read while the storage still refuses: stays in the session
  // Chrome restarted: the session's memory is gone, and so is that cooldown (the page's message says to wait it out first)
  const kept = session["cooldown"];
  delete session["cooldown"];
  const restarted = /** @type {typeof import("../src/app/storage.js")} */ (await import(`../src/app/storage.js?restart=${now}`));
  assert.equal(await activeCooldown(restarted.cooldownStore(), { now: now + 60 }), null);
  // unless the storage takes it first: once space is freed, the next reading stores it, and a restart keeps it
  session["cooldown"] = kept;
  switches.refuseWrites = false;
  assert.equal((await activeCooldown(reloaded.cooldownStore(), { now: now + 120 }))?.reason, MEDIA_RATE_LIMIT_MESSAGE);
  assert.deepEqual(stored["cooldown"], kept);
  assert.equal(Object.hasOwn(session, "cooldown"), false);
  const later = /** @type {typeof import("../src/app/storage.js")} */ (await import(`../src/app/storage.js?later=${now}`));
  assert.equal((await activeCooldown(later.cooldownStore(), { now: now + 180 }))?.reason, MEDIA_RATE_LIMIT_MESSAGE);
  assert.equal(await later.storedCooldownUntil(), now + 1800);
  switches.refuseWrites = true;
  // clearing removes the session's copy too
  await recordBlock(reloaded.cooldownStore(), "again", "browser", { now: now + 100, onError: () => undefined });
  switches.refuseWrites = false;
  await clearCooldown(reloaded.cooldownStore());
  assert.equal(Object.hasOwn(session, "cooldown"), false);
});

test("the report switch: on by default, a stored non-boolean falls back to it, and it must be a boolean to save", () => {
  assert.equal(DEFAULT_SETTINGS.report, true);
  assert.equal(normalizeSettings({ report: false }, false).report, false);
  assert.equal(normalizeSettings({ report: "yes" }, false).report, true); // not a boolean: dropped, the default stays
  assert.equal(normalizeSettings({ report: 0 }, false).report, true);
  assert.equal(settingsProblem({ ...DEFAULT_SETTINGS, report: false }, false), null);
  assert.equal(settingsProblem({ ...DEFAULT_SETTINGS, report: /** @type {never} */ ("x") }, false), "the report switch must be on or off");
  // checked before the pacing: a bad switch is named even when the pauses are bad too
  assert.equal(settingsProblem({ ...DEFAULT_SETTINGS, report: /** @type {never} */ (1), delayMinS: 0 }, false), "the report switch must be on or off");
});
