// @ts-check
// The history is the least important thing the extension stores: it is cut to the last 20 runs
// and to HISTORY_MAX_BYTES of JSON, the oldest first, and when chrome.storage.local still refuses
// it (its 10 MB quota) it gives way, so the per-series states — the resume memory — keep the room.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SETTINGS,
  HISTORY_KEY,
  HISTORY_LIMIT,
  HISTORY_MAX_BYTES,
  appendHistory,
  normalizeSettings,
  settingsProblem,
  trimHistory,
} from "../src/app/storage.js";

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

test("a storage that refuses the history (the quota) gets the run alone, else no history", async () => {
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
      if (size(Object.values(items)) > refuseAbove) throw new Error("QUOTA_BYTES quota exceeded");
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
