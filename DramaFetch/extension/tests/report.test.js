// @ts-check
// Unit tests of src/lib/report.js: the report and its line, the rows a run writes without a
// request, the complete skip, batches.
import assert from "node:assert/strict";
import { test } from "node:test";

import { makeEpisode } from "../src/lib/catalog.js";
import {
  DRM_MESSAGE,
  DRM_REMEMBERED_MESSAGE,
  NOT_LISTED_AGAIN_MESSAGE,
  NOT_LISTED_EARLY_END_MESSAGE,
  NOT_LISTED_MESSAGE,
  PAYLOAD_DRM_MESSAGE,
  RECHECK_HINT,
  UNAVAILABLE_MESSAGE,
} from "../src/lib/messages.js";
import {
  MAX_EPISODE_NUMBER,
  MAX_NOT_LISTED_ROWS,
  NOT_ASKED_TEXT,
  batchStatus,
  completeSkip,
  completeSkipAllowed,
  dedupeRefs,
  drmMemorySkip,
  isGuessedLocked,
  isNotListed,
  listIncomplete,
  listMissing,
  listOtherItems,
  listUncertain,
  lockedResult,
  notListedResults,
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

test("`overwrite` — Python's `DownloadOptions.overwrite`, which the CLI's --overwrite sets and the extension's **See episodes** downloads again in full with (3.0.0, back in 4.1.0) —: a stopped row has no done skip and no existing-file skip, the stop's row instead, while the DRM memory and a locked episode keep theirs unless includeLocked (`engine._stopped_result`); and no complete skip (`_complete_skip_allowed`)", () => {
  const state = newState("S1");
  const exists = () => true;
  record(state, { episode: { number: 1, itemId: "id-1" }, status: "done", path: "/d/E01.mp4", message: "saved" }, { exists, now: 1 });
  record(state, { episode: { number: 2, itemId: "id-2" }, status: "skipped-locked", message: DRM_REMEMBERED_MESSAGE }, { exists, now: 1 });
  /** @type {number[]} the episodes whose file at its target was looked for */
  const looked = [];
  /** @param {import("../src/lib/catalog.js").Episode} episode @returns {DownloadResult} its file found at its target */
  const existingResult = (episode) => {
    looked.push(episode.number);
    return /** @type {DownloadResult} */ (row(episode, "skipped-exists", `already exists: E0${episode.number}.mp4`));
  };
  const overwrite = { state, exists, existingResult, overwrite: true };
  // on disk in the state, or at its target: the stop's row — never asked whether a file is there
  assert.deepEqual(stoppedResult(ep(1), "failed-rate-limited", "episode 3 failed-rate-limited", overwrite), {
    episode: ep(1),
    status: "failed-rate-limited",
    path: null,
    message: "stopped: episode 3 failed-rate-limited",
  });
  assert.equal(stoppedResult(ep(5), "failed", "x", overwrite).message, "stopped: x");
  assert.deepEqual(looked, []);
  // the DRM memory and the lock stay, as without overwrite; includeLocked lifts both
  assert.equal(stoppedResult(ep(2), "failed-rate-limited", "x", overwrite).message, DRM_REMEMBERED_MESSAGE);
  assert.equal(stoppedResult(ep(4, "locked", ["isLocked=True"]), "failed", "x", overwrite).status, "skipped-locked");
  const asking = { ...overwrite, includeLocked: true };
  assert.equal(stoppedResult(ep(2), "failed", "x", asking).message, "stopped: x");
  assert.equal(stoppedResult(ep(4, "locked", ["isLocked=True"]), "failed", "x", asking).message, "stopped: x");
  // without it, the same episodes keep their skips (the resume every other extension job has)
  const resume = { state, exists, existingResult };
  assert.equal(stoppedResult(ep(1), "failed", "x", resume).message, "already downloaded (manifest): E01.mp4");
  assert.equal(stoppedResult(ep(5), "failed", "x", resume).message, "already exists: E05.mp4");
  assert.deepEqual(looked, [5]);
  // the complete skip: a whole-series run only, never with overwrite (nor a dry run)
  assert.equal(completeSkipAllowed(null, { overwrite: true }), false);
  assert.equal(completeSkipAllowed(null, { overwrite: false }), true);
  assert.equal(completeSkipAllowed(undefined, { overwrite: true, recheck: false, includeLocked: false }), false);
  assert.equal(completeSkipAllowed(null, { dryRun: true }), false);
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

// ------------------------------------------- 3.0.1: no episode missing from TikTok's list without a word

/**
 * @param {number[]} numbers the episode numbers listed
 * @param {Partial<import("../src/lib/catalog.js").Series>} [extra]
 * @returns {import("../src/lib/catalog.js").Series}
 */
const listOf = (numbers, extra = {}) => ({ seriesId: "S1", name: "Paid Love Story", episodes: numbers.map((number) => ep(number)), totalHint: null, warnings: [], ...extra });
/** @param {import("../src/lib/catalog.js").Series} series */
const allDone = (series) => /** @type {DownloadResult[]} */ (series.episodes.map((episode) => row(episode, "done")));

test("3.0.1: the report holds TikTok's count by the one count rule — a count that may include a trailer names no phantom episode but leaves the list uncertain; fewer items than it counts name the missing ones; more listed than announced stays incomplete", () => {
  // 61 episodes and a trailer: TikTok counts 62, 62 items came. 3.0.1, the lead's decision D2
  // (changed on purpose): whether TikTok counts the trailer is not known — no gap, no row, but the
  // list is uncertain: not complete (no mark, no 24-hour skip), and the line says why
  const trailer = listOf(Array.from({ length: 61 }, (_, index) => index + 1), { totalHint: 62, itemsReceived: 62 });
  const whole = seriesReport(trailer, allDone(trailer));
  assert.deepEqual(whole.gaps, []);
  assert.equal(whole.complete, false);
  assert.deepEqual([whole.uncertain, whole.otherItems, whole.total], [true, 1, 61]);
  assert.equal(
    reportLine(whole),
    "incomplete: 61 of 61 — TikTok's list may be incomplete: TikTok counts 62 episodes, 61 listed and 1 other item (a trailer or a highlight)",
  );
  assert.deepEqual([reportToDict(whole).uncertain, reportToDict(whole).other_items], [true, 1]);
  // the count everything listed accounts for: complete, nothing uncertain
  const placed = listOf(Array.from({ length: 62 }, (_, index) => index + 1), { totalHint: 62, itemsReceived: 63 });
  assert.equal(seriesReport(placed, allDone(placed)).complete, true);
  assert.equal(seriesReport(placed, allDone(placed)).uncertain, false);
  // the same list with 61 items received: E62 is missing, named
  const short = { ...trailer, itemsReceived: 61 };
  const missing = seriesReport(short, allDone(short));
  assert.deepEqual(missing.gaps, [62]);
  assert.equal(missing.complete, false);
  assert.equal(reportLine(missing), "incomplete: 61 of 62 — episode 62 missing from TikTok's list");
  // items received unknown (a series built by hand): the count stands, as before
  const unknown = listOf([1, 2, 3], { totalHint: 5 });
  assert.deepEqual(seriesReport(unknown, allDone(unknown)).gaps, [4, 5]);
  // more listed than TikTok announces: incomplete, whatever the items say
  const more = listOf([1, 2, 3, 4], { totalHint: 3, itemsReceived: 4 });
  const over = seriesReport(more, allDone(more));
  assert.equal(over.complete, false);
  assert.equal(reportLine(over), "incomplete: 4 of 4 — TikTok announces 3 episodes, 4 listed");
});

test("3.0.1: a list that ended early is incomplete while what came does not reach TikTok's count — unknown, or fewer items —; the line names what it did not bring past the highest number listed, apart from its holes", () => {
  const early = "in-page pagination fetch returned no episode list; scrolled the page instead";
  // TikTok's count unknown: where it ended
  const unknown = listOf([1, 2, 3], { earlyEnd: early });
  const report = seriesReport(unknown, allDone(unknown));
  assert.equal(report.endedEarly, true);
  assert.equal(report.lastListed, 3);
  assert.equal(report.complete, false);
  assert.equal(reportLine(report), "incomplete: 3 of 3 — TikTok's list ended early after episode 3");
  // a count the items fall short of: the holes, then what never came
  const counted = listOf([1, 3, 4], { totalHint: 6, itemsReceived: 3, earlyEnd: early });
  const short = seriesReport(counted, allDone(counted));
  assert.deepEqual(short.gaps, [2, 5, 6]);
  assert.equal(reportLine(short), "incomplete: 3 of 6 — episode 2 missing from TikTok's list; TikTok's list ended early: episodes 5, 6 not received");
  assert.equal(
    reportLine(seriesReport({ ...counted, totalHint: 5 }, allDone(counted))),
    "incomplete: 3 of 5 — episode 2 missing from TikTok's list; TikTok's list ended early: episode 5 not received",
  );
  // every item TikTok counts came: the early end was harmless — complete
  const reached = listOf([1, 2, 3], { totalHint: 3, itemsReceived: 3, earlyEnd: early });
  const fine = seriesReport(reached, allDone(reached));
  assert.equal(fine.endedEarly, false);
  assert.equal(fine.complete, true);
  // nothing listed at all
  assert.equal(reportLine(seriesReport(listOf([], { earlyEnd: early }), [])), "incomplete: 0 of 0 — TikTok's list ended early; no episodes listed");
  assert.deepEqual(
    [reportToDict(short).ended_early, reportToDict(short).last_listed, reportToDict(fine).ended_early],
    [true, 4, false],
  );
});

test("3.0.1: notListedResults gives every number a list does not hold a failed-unavailable row — each once, ascending, between 1 and the largest number, at most MAX_NOT_LISTED_ROWS — whose message says why; isNotListed knows them; the report counts them missing from the list, never failed", () => {
  const early = listOf([1, 3, 4], { earlyEnd: "x" });
  const rows = notListedResults(early, [6, 2, 3, 2, 0, -1, MAX_EPISODE_NUMBER + 1, 5]);
  assert.deepEqual(rows.map((r) => [r.episode.number, r.status, r.message]), [
    [2, "failed-unavailable", NOT_LISTED_MESSAGE], // a hole: below the highest listed
    [5, "failed-unavailable", NOT_LISTED_EARLY_END_MESSAGE], // past it, the list having ended early
    [6, "failed-unavailable", NOT_LISTED_EARLY_END_MESSAGE],
  ]);
  assert.deepEqual(rows[0]?.episode, makeEpisode({ number: 2, itemId: "", title: "", seriesId: "S1", seriesName: "Paid Love Story" }));
  assert.equal(rows[0]?.path, null);
  assert.deepEqual(notListedResults(listOf([1, 3]), [2, 5]).map((r) => r.message), [NOT_LISTED_MESSAGE, NOT_LISTED_MESSAGE]); // no early end
  assert.deepEqual(notListedResults(early, [2, 9], { again: true }).map((r) => r.message), [NOT_LISTED_AGAIN_MESSAGE, NOT_LISTED_AGAIN_MESSAGE]); // a selection
  assert.deepEqual(notListedResults(early, []), []);
  assert.equal(notListedResults(listOf([1]), Array.from({ length: 2000 }, (_, index) => index + 2)).length, MAX_NOT_LISTED_ROWS);
  assert.equal(MAX_NOT_LISTED_ROWS, 500);
  for (const result of rows) assert.equal(isNotListed(result), true);
  assert.equal(isNotListed({ status: "failed", message: NOT_LISTED_MESSAGE }), false);
  assert.equal(isNotListed({ status: "failed-unavailable", message: UNAVAILABLE_MESSAGE }), false);
  // the report: missing from the list, never failed; the total counts them
  const series = listOf([1, 2, 3]);
  const report = seriesReport(series, [...allDone(series), ...notListedResults(series, [5], { again: true })]);
  assert.deepEqual([report.failed, report.gaps, report.total, report.complete], [0, [4, 5], 5, false]);
  assert.equal(reportLine(report), "incomplete: 3 of 5 — episodes 4, 5 missing from TikTok's list");
  // a listed episode that failed stays a failure
  assert.deepEqual(seriesReport(series, [row(series.episodes[0], "failed", "boom")]).failedNumbers, [1]);
});

test("3.0.1: listIncomplete and listMissing — the list itself short: a number missing (the discovery's missingNumbers, else computed), or an early end short of TikTok's count", () => {
  assert.equal(listIncomplete(listOf([1, 2, 3])), false);
  assert.equal(listIncomplete(listOf([1, 3])), true); // a hole, computed
  assert.deepEqual(listMissing(listOf([1, 3], { totalHint: 4 })), [2, 4]);
  assert.deepEqual(listMissing(listOf([1, 3], { missingNumbers: [] })), []); // the discovery's word wins
  assert.equal(listIncomplete(listOf([1, 2], { missingNumbers: [3] })), true);
  assert.equal(listIncomplete(listOf([1, 2], { earlyEnd: "x" })), true); // count unknown
  assert.equal(listIncomplete(listOf([1, 2], { earlyEnd: "x", totalHint: 2, itemsReceived: 2 })), false); // every counted item came
  assert.equal(listIncomplete(listOf([1, 2], { earlyEnd: "x", totalHint: 3, itemsReceived: 2, missingNumbers: [] })), true);
});

test("4.0.1: an episode TikTok marks as a highlight counts like any other — E66 listed as such with a count of 66: not uncertain, no other item, nothing missing, complete; without E66, a count of 66 that may hold a trailer stays uncertain with no row", () => {
  const numbers = Array.from({ length: 66 }, (_, index) => index + 1);
  const counted = listOf(numbers, { totalHint: 66, itemsReceived: 66 });
  // the discovery listed the item TikTok marks as a highlight as episode 66 (catalog.mergePages)
  counted.episodes[65] = makeEpisode({
    number: 66,
    itemId: "id-66",
    title: "t66",
    seriesId: "S1",
    raw: { id: "id-66", dramaInfo: { DramaVideoData: { EpisodeNumber: 66, IsHighlight: true } } },
  });
  assert.deepEqual([listUncertain(counted), listOtherItems(counted), listIncomplete(counted), listMissing(counted)], [false, 0, false, []]);
  const report = seriesReport(counted, allDone(counted));
  assert.deepEqual([report.complete, report.uncertain, report.gaps], [true, false, []]);
  assert.equal(reportLine(report), "complete: 66 of 66 (66 downloaded)");
  // without E66 — 65 episodes and one other item, a trailer say —, a count of 66 may hold that
  // item: uncertain, no row
  const bare = listOf(numbers.slice(0, 65), { totalHint: 66, itemsReceived: 66 });
  assert.deepEqual([listUncertain(bare), listOtherItems(bare), listMissing(bare)], [true, 1, []]);
});

/**
 * A free episode DramaFetch's own rules guessed was locked (3.0.1): a short header or no play address.
 * @param {number} number
 * @param {string} [hint]
 */
const guessed = (number, hint = "plays 2 s of 3 s") =>
  makeEpisode({ number, itemId: `id-${number}`, title: `t${number}`, seriesId: "S1", seriesName: "Limited Free Drama", access: "locked", lockHints: [hint], guessedLock: true });

test("3.0.1 (§9): a free episode DramaFetch only guessed was locked counts against completeness, apart from the locked ones, and the line names it; a remembered DRM verdict and a paid lock keep their accounting", () => {
  assert.equal(NOT_ASKED_TEXT, "not asked for");
  const episodes = [ep(1), ep(2), guessed(3), ep(4, "locked", ["isLocked=True"])];
  const series = { seriesId: "S1", name: "Limited Free Drama", episodes, totalHint: null, warnings: [] };
  const rows = [row(episodes[0], "done"), row(episodes[1], "done"), lockedResult(episodes[2]), lockedResult(episodes[3])];
  assert.deepEqual(rows.map(isGuessedLocked), [false, false, true, false]);
  assert.equal(rows[2]?.message, "looks locked: plays 2 s of 3 s"); // the status and the row do not change
  const report = seriesReport(series, rows);
  assert.equal(report.complete, false);
  assert.deepEqual([report.locked, report.lockedNumbers], [1, [4]]);
  assert.deepEqual([report.guessedLocked, report.guessedLockedNumbers], [1, [3]]);
  assert.equal(reportLine(report), "incomplete: 2 of 4 — 1 locked (4); 1 free episode not asked for (3): TikTok's list made it look locked");
  const dict = reportToDict(report);
  assert.deepEqual([dict["guessed_locked"], dict["guessed_locked_numbers"]], [1, [3]]);
  // several, nothing else wrong
  const two = { ...series, episodes: [ep(1), guessed(2, "no play address"), guessed(3)] };
  const twoReport = seriesReport(two, [row(two.episodes[0], "done"), lockedResult(two.episodes[1]), lockedResult(two.episodes[2])]);
  assert.equal(reportLine(twoReport), "incomplete: 1 of 3 — 2 free episodes not asked for (2, 3): TikTok's list made them look locked");
  // the skip of a DRM verdict the state remembers is no guess: locked, and complete as before
  const remembered = seriesReport({ ...series, episodes: episodes.slice(0, 3) }, [rows[0], rows[1], drmMemorySkip(guessed(3))]);
  assert.deepEqual([remembered.complete, remembered.lockedNumbers, remembered.guessedLocked], [true, [3], 0]);
  // asked for anyway and saved: an ordinary download
  const saved = seriesReport({ ...series, episodes: episodes.slice(0, 3) }, [rows[0], rows[1], row(guessed(3), "done")]);
  assert.equal(reportLine(saved), "complete: 3 of 3 (3 downloaded)");
  // a selection's report reads the whole series: a guessed lock outside it is counted too
  const state = newState("S1", "Limited Free Drama");
  const selection = seriesReport(series, reportRows(series, [row(episodes[0], "done"), row(episodes[1], "done")], state, () => false));
  assert.deepEqual([selection.complete, selection.guessedLockedNumbers, selection.lockedNumbers], [false, [3], [4]]);
});

test("3.0.1 (§10): a complete mark of 3.0.0 or earlier — no rule — never skips; the one written now does", () => {
  const present = new Set(["/d/E01.mp4", "/d/E02.mp4"]);
  /** @param {{path: string | null}} entry */
  const exists = (entry) => entry.path !== null && present.has(entry.path);
  const state = newState("S1", "Name");
  for (const n of [1, 2]) record(state, { episode: { number: n, itemId: `id-${n}` }, status: "done", path: `/d/E0${n}.mp4`, message: "saved" }, { exists, now: 1761200000 });
  markComplete(state, 1761200000, 2);
  const context = { seriesId: "S1", nowS: 1761200000 + 3600, exists };
  assert.ok(completeSkip(state, context) !== null); // written under the rule in force
  const { complete_rule: _rule, ...old } = state;
  assert.equal(completeSkip(old, context), null); // 3.0.0's: listed again
  assert.equal(completeSkip({ ...state, complete_rule: 1 }, context), null);
});
