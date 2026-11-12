// @ts-check
// The history is the least important thing the extension stores: it is cut to the last 20 runs
// and to HISTORY_MAX_BYTES of JSON, the oldest first, and when chrome.storage.local refuses it (a
// full disk under the Chrome profile) it gives way and never throws. A refusal's cooldown the
// storage will not take stays in force from memory.
import assert from "node:assert/strict";
import { test } from "node:test";

import { activeCooldown, clearCooldown, recordBlock } from "../src/lib/cooldown.js";
import { MEDIA_RATE_LIMIT_MESSAGE } from "../src/lib/messages.js";
import {
  DEFAULT_SETTINGS,
  HISTORY_KEY,
  HISTORY_LIMIT,
  HISTORY_MAX_BYTES,
  appendHistory,
  cooldownStore,
  normalizeSettings,
  settingsProblem,
  trimHistory,
} from "../src/app/storage.js";

/** What Chrome 153 rejects a `chrome.storage.local.set` with when the disk under its profile is full. */
const REFUSED = "IO error: .../000003.log: FILE_ERROR_NO_SPACE (ChromeMethodBFE: 3::WritableFileAppend::8)";

/**
 * A `chrome.storage.local` whose writes (`set`, `remove`) and reads (`get`) can be made to reject,
 * installed as the global `chrome`.
 * @param {Record<string, unknown>} [stored]
 */
function fakeLocal(stored = {}) {
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
  Object.assign(globalThis, { chrome: { storage: { local } } });
  return { stored, switches };
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

/** @param {readonly unknown[]} entries @returns {number} */
const size = (entries) => new TextEncoder().encode(JSON.stringify(entries)).length;

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
