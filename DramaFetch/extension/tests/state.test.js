// @ts-check
// Unit tests of src/lib/state.js: the dramafetch.json semantics over a plain object.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DRM_MESSAGE, DRM_REMEMBERED_MESSAGE, PAYLOAD_DRM_MESSAGE } from "../src/lib/messages.js";
import {
  clearComplete,
  completeSince,
  doneEntries,
  donePath,
  drmProtected,
  epochOf,
  isDone,
  isoUtc,
  loadState,
  lockedNumbers,
  markComplete,
  missingFiles,
  newState,
  readState,
  record,
} from "../src/lib/state.js";

/** @param {number} number @param {string} status @param {string | null} [path] @param {string} [message] */
const result = (number, status, path = null, message = "") => ({
  episode: { number, itemId: `id-${number}` },
  status,
  path,
  message,
  downloadId: path ? number * 10 : null,
});

test("a skip never downgrades a done entry whose file exists; an attempt forgets the complete mark", () => {
  const state = newState("S1", "Name");
  const present = new Set(["/d/E01.mp4"]);
  /** @param {{path: string | null}} entry */
  const exists = (entry) => entry.path !== null && present.has(entry.path);
  assert.equal(record(state, result(1, "done", "/d/E01.mp4", "saved"), { exists, now: 1761200000 }), true);
  assert.equal(record(state, result(1, "skipped-exists", "/d/E01.mp4", "already"), { exists, now: 1761200001 }), false);
  assert.equal(state.episodes["1"]?.status, "done");
  assert.equal(state.episodes["1"]?.download_id, 10);
  assert.equal(state.episodes["1"]?.updated_at, "2025-10-23T06:13:20Z");
  markComplete(state, 1761200000.75, 1);
  assert.equal(state.complete_at, "2025-10-23T06:13:20Z");
  assert.equal(completeSince(state), 1761200000);
  record(state, result(2, "skipped-locked", null, "looks locked"), { exists });
  assert.equal(state.complete_episodes, 1); // a skip keeps the mark
  record(state, result(3, "failed", null, "boom"), { exists });
  assert.equal(state.complete_at, null); // an attempt forgets it
  present.delete("/d/E01.mp4");
  record(state, result(1, "skipped-exists", "/d/E01 (1).mp4", "already"), { exists });
  assert.equal(state.episodes["1"]?.status, "skipped-exists"); // the done file is gone: replaced
});

test("on disk, missing, locked and DRM-remembered entries", () => {
  const state = newState("S1");
  const present = new Set(["/d/E01.mp4", "/d/E03.mp4"]);
  /** @param {{path: string | null}} entry */
  const exists = (entry) => entry.path !== null && present.has(entry.path);
  record(state, result(3, "skipped-exists", "/d/E03.mp4", "already"), { exists });
  record(state, result(1, "done", "/d/E01.mp4", "saved"), { exists });
  record(state, result(2, "done", "/d/E02.mp4", "saved"), { exists });
  record(state, result(4, "failed-unavailable", null, DRM_MESSAGE), { exists });
  record(state, result(5, "skipped-locked", null, DRM_REMEMBERED_MESSAGE), { exists });
  record(state, result(6, "skipped-locked", null, PAYLOAD_DRM_MESSAGE), { exists });
  assert.deepEqual(doneEntries(state, exists), [
    [1, "/d/E01.mp4"],
    [3, "/d/E03.mp4"],
  ]);
  assert.deepEqual(missingFiles(state, exists), [2]);
  assert.deepEqual(lockedNumbers(state), [5, 6]);
  assert.deepEqual([4, 5, 6, 7].map((n) => drmProtected(state, n)), [true, true, false, false]);
  assert.equal(donePath(state, 3, exists), null); // skipped-exists is on disk, not "done"
  assert.equal(isDone(state, 1, exists), true);
});

test("a stored state reads back as itself; foreign, corrupt or odd values do not poison it", () => {
  const state = newState("S1", "Name");
  record(state, result(1, "done", "/d/E01.mp4", "saved"), { exists: () => true, now: 5 });
  markComplete(state, 1761200000, 1);
  const stored = JSON.parse(JSON.stringify(state));
  assert.deepEqual(readState(stored, "S1"), state);
  assert.equal(readState(stored, "S2"), null);
  assert.equal(readState({ ...stored, version: 2 }, "S1"), null);
  assert.equal(readState("junk", "S1"), null);
  const odd = readState(
    { ...stored, complete_episodes: true, episodes: { ...stored.episodes, x: {}, "2": { status: 5 }, " 3 ": { status: "done", item_id: null } } },
    "S1",
  );
  assert.ok(odd !== null);
  assert.equal(odd.complete_at, null);
  assert.deepEqual(Object.keys(odd.episodes), ["1", "3"]);
  assert.equal(odd.episodes["3"]?.item_id, "None");
  const loaded = loadState(stored, "S1", "Fresh Name");
  assert.equal(loaded.series_name, "Fresh Name");
  assert.deepEqual(loadState("junk", "S1", "N"), newState("S1", "N"));
  assert.equal(clearComplete(loaded), true);
  assert.equal(clearComplete(loaded), false);
});

test("ISO times: whole seconds in UTC, read back in the usual forms", () => {
  assert.equal(isoUtc(0), "1970-01-01T00:00:00Z");
  assert.equal(isoUtc(1761203600.9999996), "2025-10-23T07:13:21Z"); // rounded to microseconds first
  assert.equal(epochOf("2025-10-23T06:13:20Z"), 1761200000);
  assert.equal(epochOf("2025-10-23T06:13:20"), 1761200000);
  assert.equal(epochOf("2025-10-23T01:13:20-05:00"), 1761200000);
  assert.equal(epochOf("2025-10-23 06:13:20.5+00:00"), 1761200000.5);
  assert.equal(epochOf("2025-10-23"), 1761177600);
  for (const bad of ["", "yesterday", "2026-02-30T00:00:00Z", "2026-13-01", "2025-10-23T24:00:00Z"]) {
    assert.equal(epochOf(bad), null, bad);
  }
});
