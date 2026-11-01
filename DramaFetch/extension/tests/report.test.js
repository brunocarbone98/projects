// @ts-check
// Unit tests of src/lib/report.js: the report and its line, the rows a run writes without a
// request, the complete skip, batches.
import assert from "node:assert/strict";
import { test } from "node:test";

import { makeEpisode } from "../src/lib/catalog.js";
import { DRM_MESSAGE, DRM_REMEMBERED_MESSAGE, PAYLOAD_DRM_MESSAGE, RECHECK_HINT } from "../src/lib/messages.js";
import {
  batchStatus,
  completeSkip,
  completeSkipAllowed,
  dedupeRefs,
  lockedResult,
  notStartedMessage,
  numbersText,
  reportLine,
  reportRows,
  reportToDict,
  seriesReport,
  stoppedResult,
  summarize,
} from "../src/lib/report.js";
import { markComplete, newState, record } from "../src/lib/state.js";

/** @typedef {import("../src/lib/report.js").DownloadResult} DownloadResult */

/** @param {number} number @param {"free" | "unlocked" | "locked"} [access] @param {string[]} [hints] */
const ep = (number, access = "free", hints = []) =>
  makeEpisode({ number, itemId: `id-${number}`, title: `t${number}`, seriesId: "S1", seriesName: "Paid Love Story", access, paid: access !== "free", lockHints: hints });
/** @param {import("../src/lib/catalog.js").Episode} episode @param {import("../src/lib/messages.js").Status} status */
const row = (episode, status, message = "", path = /** @type {string | null} */ (null)) => ({ episode, status, message, path });

const PAID = {
  seriesId: "S1",
  name: "Paid Love Story",
  episodes: [ep(1), ep(2), ep(3, "unlocked"), ep(4, "locked", ["isLocked=True"])],
  totalHint: 4,
  warnings: [],
};

test("the paid line: complete, the unlocked episode named before the locked one", () => {
  const results = [
    row(PAID.episodes[0], "done"),
    row(PAID.episodes[1], "done"),
    row(PAID.episodes[2], "done"),
    lockedResult(/** @type {import("../src/lib/catalog.js").Episode} */ (PAID.episodes[3])),
  ];
  const report = seriesReport(PAID, /** @type {DownloadResult[]} */ (results));
  assert.equal(report.complete, true);
  assert.equal(reportLine(report), "complete: 3 of 4 (3 downloaded) — 1 paid episode your account unlocked (3), 1 locked (4)");
  assert.deepEqual(reportToDict(report).unlocked_numbers, [3]);
  assert.deepEqual(summarize(/** @type {DownloadResult[]} */ (results)), { done: 3, "skipped-locked": 1 });
});

test("an incomplete line names failures, the rest, gaps and the stop", () => {
  const series = { ...PAID, episodes: [ep(1), ep(2), ep(5)], totalHint: null };
  const results = [row(ep(1), "done"), row(ep(2), "failed-rate-limited", "stopped: x")];
  const report = seriesReport(series, /** @type {DownloadResult[]} */ (results), { stopped: "episode 2 failed-rate-limited" });
  assert.equal(
    reportLine(report),
    "incomplete: 1 of 5 — 1 failed (2), 1 not downloaded; episodes 3, 4 missing from TikTok's list; stopped: episode 2 failed-rate-limited",
  );
  assert.equal(numbersText([1, 2, 3, 9, 10]), "1-3, 9, 10");
  assert.equal(numbersText(Array.from({ length: 30 }, (_, i) => i * 2)), "0, 2, 4, 6, 8, 10, 12, 14, 16, 18, …");
});

test("a selection's report counts what the state knows: on disk, remembered DRM, locked", () => {
  const state = newState("S1", "Paid Love Story");
  const exists = () => true;
  record(state, { episode: { number: 1, itemId: "id-1" }, status: "done", path: "/d/E01.mp4", message: "saved" }, { exists, now: 1 });
  record(state, { episode: { number: 2, itemId: "id-2" }, status: "failed-unavailable", message: DRM_MESSAGE }, { exists, now: 1 });
  const rows = reportRows(PAID, /** @type {DownloadResult[]} */ ([row(ep(3, "unlocked"), "done")]), state, exists);
  assert.deepEqual(
    rows.map((r) => [r.episode.number, r.status, r.message]),
    [
      [3, "done", ""],
      [1, "skipped-exists", "already downloaded (manifest): E01.mp4"],
      [2, "skipped-locked", DRM_REMEMBERED_MESSAGE],
      [4, "skipped-locked", "looks locked: isLocked=True"],
    ],
  );
  assert.equal(seriesReport(PAID, rows).complete, true);
});

test("the stopped row keeps every skip an episode would have had", () => {
  const state = newState("S1");
  const exists = () => true;
  record(state, { episode: { number: 1, itemId: "id-1" }, status: "done", path: "/d/E01.mp4", message: "saved" }, { exists, now: 1 });
  record(state, { episode: { number: 2, itemId: "id-2" }, status: "skipped-locked", message: DRM_REMEMBERED_MESSAGE }, { exists, now: 1 });
  const context = { state, exists };
  assert.equal(stoppedResult(ep(1), "failed-rate-limited", "x", context).status, "skipped-exists");
  assert.equal(stoppedResult(ep(2), "failed-rate-limited", "x", context).message, DRM_REMEMBERED_MESSAGE);
  assert.equal(stoppedResult(ep(4, "locked", ["isLocked=True"]), "failed", "x", context).status, "skipped-locked");
  const drmFlag = makeEpisode({ number: 6, itemId: "6", title: "t", seriesId: "S1", drm: true, lockHints: ["isDrm=True"] });
  assert.equal(lockedResult(drmFlag).message, "protected by DRM (isDrm=True): DramaFetch does not decrypt it");
  assert.equal(lockedResult({ ...drmFlag, lockHints: [] }).message, PAYLOAD_DRM_MESSAGE);
  const existing = { ...context, existingResult: () => /** @type {DownloadResult} */ (row(ep(5), "skipped-exists", "already exists: E05.mp4")) };
  assert.equal(stoppedResult(ep(5), "failed", "x", existing).message, "already exists: E05.mp4");
  assert.deepEqual(stoppedResult(ep(5), "failed-blocked", "episode 3 failed-blocked", context), {
    episode: ep(5),
    status: "failed-blocked",
    path: null,
    message: "stopped: episode 3 failed-blocked",
  });
});

test("the complete skip: 24 h, every counted file there, the locked ones and RECHECK_HINT", () => {
  const state = newState("S1", "Paid Love Story");
  const present = new Set(["/d/E01.mp4", "/d/E02.mp4", "/d/E03.mp4"]);
  /** @param {{path: string | null}} entry */
  const exists = (entry) => entry.path !== null && present.has(entry.path);
  for (const number of [1, 2, 3]) {
    record(state, { episode: { number, itemId: `id-${number}` }, status: "done", path: `/d/E0${number}.mp4`, message: "saved" }, { exists, now: 1 });
  }
  record(state, { episode: { number: 4, itemId: "id-4" }, status: "skipped-locked", message: "looks locked: isLocked=True" }, { exists, now: 1 });
  markComplete(state, 1761200000, 3);
  const skipped = completeSkip(state, { seriesId: "S1", nowS: 1761200000 + 7200, exists });
  assert.ok(skipped !== null);
  assert.equal(
    reportLine(skipped.report),
    `complete, nothing to do: 3 episodes already on disk, 1 locked (4) (checked 2 h ago) — ${RECHECK_HINT}`,
  );
  assert.deepEqual(
    skipped.results.map((r) => [r.episode.number, r.episode.title, r.message]),
    [
      [1, "E01", "already downloaded (manifest): E01.mp4"],
      [2, "E02", "already downloaded (manifest): E02.mp4"],
      [3, "E03", "already downloaded (manifest): E03.mp4"],
    ],
  );
  assert.equal(completeSkip(state, { seriesId: "S1", nowS: 1761200000 + 86400, exists }), null); // stale
  assert.equal(completeSkip(state, { seriesId: "S1", nowS: 1761200000 - 1, exists }), null); // the future
  present.delete("/d/E02.mp4");
  assert.equal(completeSkip(state, { seriesId: "S1", nowS: 1761200000 + 60, exists }), null); // a file is gone
  assert.equal(completeSkip(null, { seriesId: "S1", nowS: 0, exists }), null);
  assert.equal(completeSkipAllowed(null, {}), true);
  assert.equal(completeSkipAllowed([1, 2], {}), false);
  assert.equal(completeSkipAllowed(null, { recheck: true }), false);
  assert.equal(completeSkipAllowed(null, { includeLocked: true }), false);
});

test("batches: the status column, not started, duplicates", () => {
  const report = seriesReport(null, [], { seriesId: "S1", stopped: "rate limited (HTTP 429)" });
  const stopping = { ref: { seriesId: "S1" }, series: null, report: { ...report, name: "Paid Love Story" }, error: "TikTok is rate-limiting" };
  assert.equal(notStartedMessage(stopping), "not started: batch stopped in Paid Love Story (rate limited (HTTP 429))");
  assert.equal(notStartedMessage({ ...stopping, report }), "not started: batch stopped in S1 (rate limited (HTTP 429))");
  assert.equal(batchStatus({ ...stopping, errorKind: "not-started" }), "not started");
  assert.equal(batchStatus(stopping), "failed: TikTok is rate-limiting");
  assert.equal(batchStatus({ ...stopping, error: null, report: { ...report, skippedComplete: true } }), "skipped (complete)");
  assert.equal(batchStatus({ ...stopping, error: null, report: { ...report, complete: true } }), "complete");
  assert.equal(batchStatus({ ...stopping, error: null }), "incomplete");
  assert.deepEqual(dedupeRefs([{ seriesId: "1" }, { seriesId: "2" }, { seriesId: "1" }]), {
    kept: [{ seriesId: "1" }, { seriesId: "2" }],
    notes: ["duplicate: 1"],
  });
});
