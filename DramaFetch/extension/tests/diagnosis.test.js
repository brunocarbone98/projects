// @ts-check
// The "did not download" report (src/lib/diagnosis.js): the probable cause of every kind of row,
// the report built over a run's series (snake_case, the rows that did not download ascending, a
// downloaded row for comparison, the raw items as served), its file name and its bytes. Pure: no
// browser, no network.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BLOCKED_CAUSE,
  CUT_SHORT_CAUSE_PREFIX,
  CUT_SHORT_CAUSE_SUFFIX,
  DRM_CAUSE,
  FAILED_CAUSE_PREFIX,
  INVALID_FILE_CAUSE_PREFIX,
  INVALID_FILE_CAUSE_SUFFIX,
  LOCKED_CAUSE_PREFIX,
  LOCKED_RAW_KEPT,
  LOCKED_CAUSE_SUFFIX,
  LOGIN_CAUSE,
  LONGER_FILE_CAUSE_SUFFIX,
  NOT_ATTEMPTED_CAUSE,
  RATE_LIMITED_CAUSE,
  REPORTS_FOLDER,
  REPORT_VERSION,
  SHORTER_FILE_CAUSE_MIDDLE,
  SHORTER_FILE_CAUSE_PREFIX,
  SHORT_SERVED_CAUSE_PREFIX,
  SHORT_SERVED_CAUSE_SUFFIX,
  UNAVAILABLE_CAUSE_PREFIX,
  UNAVAILABLE_CAUSE_SUFFIX,
  WHAT_THIS_IS,
  buildReport,
  digestEntry,
  hasFailures,
  probableCause,
  reportFilename,
  reportJson,
  reportStem,
  slimRows,
} from "../src/lib/diagnosis.js";
import {
  BLOCKED_MESSAGE,
  DRM_MESSAGE,
  INCOMPLETE_PREFIX,
  MEDIA_RATE_LIMIT_MESSAGE,
  PAYLOAD_DRM_MESSAGE,
  SHORT_SERVED_PREFIX,
  UNAVAILABLE_MESSAGE,
  shortServedMessage,
} from "../src/lib/messages.js";

const SERIES_ID = "7699393770256782354";
const OTHER_ID = "7699393770256782399";

/**
 * A row as `probableCause` reads it.
 * @param {string} status
 * @param {string} message
 * @param {{access?: string, lockHints?: string[], drm?: boolean, durationS?: number | null}} [extra]
 * @returns {import("../src/lib/diagnosis.js").CauseRow}
 */
function row(status, message, extra = {}) {
  return {
    status,
    message,
    access: extra.access ?? "free",
    lockHints: extra.lockHints ?? [],
    drm: extra.drm ?? false,
    durationS: extra.durationS ?? 106,
  };
}

/**
 * An attempt record of the fixed shape, `saved` unless said otherwise.
 * @param {Partial<import("../src/lib/diagnosis.js").AttemptRecord>} [fields]
 * @returns {import("../src/lib/diagnosis.js").AttemptRecord}
 */
function attempt(fields = {}) {
  return {
    url: "https://v16-webapp-prime.tiktok.com/v/1.mp4",
    host: "v16-webapp-prime.tiktok.com",
    url_expiry: 1_800_000_000,
    requested: true,
    redirect_hops: 0,
    http_status: 200,
    content_type: "video/mp4",
    content_length: 131072,
    received_bytes: 131072,
    outcome: "saved",
    ...fields,
  };
}

/**
 * One result row of a run, with its episode and trace.
 * @param {number} number
 * @param {string} status
 * @param {string} message
 * @param {{trace?: import("../src/lib/diagnosis.js").EpisodeTrace | null, access?: string, lockHints?: string[], drm?: boolean, raw?: Record<string, unknown> | null}} [extra]
 * @returns {import("../src/lib/diagnosis.js").EpisodeInput}
 */
function episodeInput(number, status, message, extra = {}) {
  return {
    number,
    itemId: `76994000000000000${String(number).padStart(2, "0")}`,
    title: `Episode ${number}`,
    durationS: 106,
    access: extra.access ?? "free",
    paid: extra.access === "unlocked" || extra.access === "locked",
    drm: extra.drm ?? false,
    lockHints: extra.lockHints ?? [],
    qualityHint: "720p h264",
    raw: extra.raw === undefined ? { id: `item${number}`, video: { playAddr: [`https://v16.tiktok.com/${number}.mp4?expire=1`] } } : extra.raw,
    status,
    message,
    path: status === "done" ? `/home/me/Downloads/DramaFetch/E${number}.mp4` : null,
    trace: extra.trace === undefined ? { attempts: [attempt()], refreshes: [] } : extra.trace,
  };
}

/**
 * @param {string} seriesId
 * @param {string | null} name
 * @param {import("../src/lib/diagnosis.js").EpisodeInput[]} episodes
 * @returns {import("../src/lib/diagnosis.js").SeriesInput}
 */
function seriesInput(seriesId, name, episodes) {
  return {
    seriesId,
    name,
    line: "incomplete: 1 of 2 (1 downloaded) — 1 failed (2)",
    status: "incomplete",
    error: null,
    stop: false,
    contacted: true,
    listed: episodes.length,
    access: { free: episodes.length, unlocked: 0, locked: 0 },
    episodes,
  };
}

/** A shorter file of an UNLISTED size (`downloader.js` quarantines it as incomplete; a listed size is `SERVED`). */
const SHORTER = `${INCOMPLETE_PREFIX}duration 70 s, expected 106 s`;
const SHORTER_HINTS = ["isFree=False", "unlockPrice=30"];

/** The downloader's short-served message (`downloader.js`): the whole file by size, a 70 s header. */
const SERVED = shortServedMessage(9676471, "70", "106");

test("probableCause: the twelve rules, first match wins", () => {
  // 1. the run stopped before the episode — whatever its status
  assert.equal(
    probableCause(row("failed-rate-limited", `stopped: episode 2 failed-rate-limited: ${MEDIA_RATE_LIMIT_MESSAGE}`), null),
    `${NOT_ATTEMPTED_CAUSE} (episode 2 failed-rate-limited: ${MEDIA_RATE_LIMIT_MESSAGE})`,
  );
  assert.equal(probableCause(row("failed", "stopped: cooldown until 19:30"), null), `${NOT_ATTEMPTED_CAUSE} (cooldown until 19:30)`);
  // 2-4. the stops
  // 2. a short-served file, named by the downloader: the whole file by size, a header that plays less
  assert.equal(
    probableCause(row("failed-unavailable", SERVED, { access: "free", lockHints: ["isLimitedFree=True"] }), null),
    "TikTok serves this episode short: the file is the whole episode by size but its header stops at 70 s of 106 s. Either a " +
      "window for an episode this account has not unlocked, or a defective encode on TikTok's side — the list cannot tell: " +
      "if the TikTok app plays it whole, watch it there and look again; if the app breaks at the same point too, no retry " +
      "will change it",
  );
  assert.equal(probableCause(row("failed-unavailable", SERVED), null), `${SHORT_SERVED_CAUSE_PREFIX}70 s of 106 s${SHORT_SERVED_CAUSE_SUFFIX}`);
  assert.equal(probableCause(row("failed-unavailable", `${SERVED} (kept as E05 (short).mp4)`), null), `${SHORT_SERVED_CAUSE_PREFIX}70 s of 106 s${SHORT_SERVED_CAUSE_SUFFIX}`);
  assert.ok(SERVED.startsWith(SHORT_SERVED_PREFIX) && SHORT_SERVED_CAUSE_PREFIX.startsWith(SHORT_SERVED_PREFIX));
  // whatever the status says, the message decides; a stop still comes first
  assert.equal(probableCause(row("failed", SERVED), null), `${SHORT_SERVED_CAUSE_PREFIX}70 s of 106 s${SHORT_SERVED_CAUSE_SUFFIX}`);
  assert.equal(probableCause(row("failed-unavailable", `stopped: ${SERVED}`), null), `${NOT_ATTEMPTED_CAUSE} (${SERVED})`);
  assert.equal(probableCause(row("failed-rate-limited", MEDIA_RATE_LIMIT_MESSAGE), null), RATE_LIMITED_CAUSE);
  assert.equal(probableCause(row("failed-blocked", BLOCKED_MESSAGE), null), BLOCKED_CAUSE);
  assert.equal(probableCause(row("failed-login-required", "login required: TikTok sent the page to a login"), null), LOGIN_CAUSE);
  // 5. DRM, from a download's verdict, a fresh list's flag or the list's flag (a skipped-locked row)
  assert.equal(probableCause(row("failed-unavailable", DRM_MESSAGE), null), DRM_CAUSE);
  assert.equal(probableCause(row("skipped-locked", PAYLOAD_DRM_MESSAGE, { access: "locked", drm: true }), null), DRM_CAUSE);
  // 6. listed as locked
  assert.equal(
    probableCause(row("skipped-locked", "looks locked: isLocked=True; no play address", { access: "locked", lockHints: ["isLocked=True", "no play address"] }), null),
    `${LOCKED_CAUSE_PREFIX}isLocked=True; no play address${LOCKED_CAUSE_SUFFIX}`,
  );
  assert.equal(probableCause(row("skipped-locked", "looks locked", { access: "locked" }), null), `${LOCKED_CAUSE_PREFIX}no clue${LOCKED_CAUSE_SUFFIX}`);
  // …the list's short-header hint among them when that was the reason
  assert.equal(
    probableCause(row("skipped-locked", "looks locked: isLimitedFree=True; plays 69 s of 106 s", { access: "locked", lockHints: ["isLimitedFree=True", "plays 69 s of 106 s"] }), null),
    `${LOCKED_CAUSE_PREFIX}isLimitedFree=True; plays 69 s of 106 s${LOCKED_CAUSE_SUFFIX}`,
  );
  // 8. a shorter file of an unlisted size — the measured fact, both readings, the list's marks; a longer one: the
  //    list and the media disagree
  assert.equal(
    probableCause(row("failed", SHORTER, { access: "unlocked", lockHints: SHORTER_HINTS }), null),
    "the file plays 70 s where the list announces 106 s, and its size is none the list announced — a shorter file than " +
      "listed: a window or a preview clip for an episode this account has not unlocked, or a defective encode on " +
      "TikTok's side; the list's marks for it: isFree=False; unlockPrice=30",
  );
  assert.equal(
    probableCause(row("failed", SHORTER), null),
    `${SHORTER_FILE_CAUSE_PREFIX}70 s where the list announces 106 s${SHORTER_FILE_CAUSE_MIDDLE}none`,
  );
  assert.equal(
    probableCause(row("failed", `${INCOMPLETE_PREFIX}duration 130 s, expected 106 s`), null),
    `the file lasts 130 s where the list announces 106 s${LONGER_FILE_CAUSE_SUFFIX}`,
  );
  // 9. a transfer cut short, both wordings
  assert.equal(
    probableCause(row("failed", `${INCOMPLETE_PREFIX}truncated body (100000 of 131072 bytes) from v16.tiktok.com`), null),
    `${CUT_SHORT_CAUSE_PREFIX}100000 of 131072 bytes${CUT_SHORT_CAUSE_SUFFIX}`,
  );
  assert.equal(
    probableCause(row("failed", `${INCOMPLETE_PREFIX}truncated body (the transfer was cut short) from v16.tiktok.com`), null),
    "the transfer was cut short (the transfer was cut short): a network or server problem, worth a retry",
  );
  // 10. any other verification reason
  for (const reason of ["no audio track", "not a valid MP4 (no moov atom)", "no playable duration", "truncated MP4 (mdat atom cut short: 10 of 20 bytes)"]) {
    assert.equal(probableCause(row("failed", `${INCOMPLETE_PREFIX}${reason}`), null), `${INVALID_FILE_CAUSE_PREFIX}${reason}${INVALID_FILE_CAUSE_SUFFIX}`);
  }
  // 11. no playable stream
  const unavailable = `${UNAVAILABLE_MESSAGE} (HTTP 403 from v4.tiktok.com)`;
  assert.equal(probableCause(row("failed-unavailable", unavailable), null), `${UNAVAILABLE_CAUSE_PREFIX}${unavailable}${UNAVAILABLE_CAUSE_SUFFIX}`);
  // 12. the rest
  assert.equal(probableCause(row("failed", "download failed: no response (Failed to fetch) from v1.tiktok.com"), null), `${FAILED_CAUSE_PREFIX}no response (Failed to fetch) from v1.tiktok.com`); // the prefix once, never doubled
  assert.equal(probableCause(row("failed", "could not save E01.mp4: FILE_FAILED"), null), `${FAILED_CAUSE_PREFIX}could not save E01.mp4: FILE_FAILED`);
  // every cause is English text without a URL query or a cookie-like value
  for (const text of [RATE_LIMITED_CAUSE, BLOCKED_CAUSE, LOGIN_CAUSE, DRM_CAUSE, WHAT_THIS_IS]) {
    assert.doesNotMatch(text, /[?&]|sessionid|msToken/i);
  }
});

const TRUNCATED_TRACE = {
  attempts: [attempt({ received_bytes: 100000, outcome: "truncated body (100000 of 131072 bytes)" })],
  refreshes: [],
};
const LOCKED_RAW = { id: "item5", isLocked: true, video: { playAddr: "" } };

/** The two series of the report tests: one with failures and a done row, one without any. */
const runs = () => [
  seriesInput(SERIES_ID, "One", [
    episodeInput(4, "failed", `${INCOMPLETE_PREFIX}truncated body (100000 of 131072 bytes) from v16.tiktok.com`, { trace: TRUNCATED_TRACE }),
    episodeInput(1, "done", "saved One - Episode 01.mp4 (0.1 MiB) + cover embedded"),
    episodeInput(2, "failed", SHORTER, { access: "unlocked", lockHints: SHORTER_HINTS }),
    episodeInput(3, "skipped-exists", "already exists: One - Episode 03.mp4", { trace: { attempts: [], refreshes: [] } }),
    episodeInput(5, "skipped-locked", "looks locked: isLocked=True; no play address", {
      access: "locked",
      lockHints: ["isLocked=True", "no play address"],
      raw: LOCKED_RAW,
      trace: { attempts: [], refreshes: [] },
    }),
    episodeInput(6, "failed-unavailable", `${UNAVAILABLE_MESSAGE} (locked in a fresh episode list: isLocked=True)`, {
      trace: {
        attempts: [attempt({ http_status: 403, content_type: "text/plain", content_length: 2, received_bytes: null, outcome: "HTTP 403" })],
        refreshes: [{ outcome: "locked", fresh_list: true, access: "locked", hints: ["isLocked=True"], listed_url_count: 0 }],
      },
    }),
    episodeInput(7, "failed", "stopped: three failures in a row", { trace: null }),
  ]),
  seriesInput(OTHER_ID, null, [episodeInput(1, "done", "saved E1"), episodeInput(2, "dry-run", "would download")]),
];

/** @returns {import("../src/lib/diagnosis.js").ReportInput} */
const input = (series = runs()) => ({
  generatedAt: "2026-11-06T19:30:00.000Z",
  extensionVersion: "1.3.0",
  userAgent: "Mozilla/5.0 Chrome/142",
  language: "es",
  testMode: false,
  job: {
    kind: "batch",
    label: "2 series",
    startedAt: "2026-11-06T19:00:00.000Z",
    finishedAt: "2026-11-06T19:30:00.000Z",
    error: null,
    stopped: "three failures in a row",
    refreshes: 1,
    pauses: [{ kind: "pace", seconds: 5.5, text: "pause 5.5 s" }],
  },
  series,
});

test("buildReport: the shape, the rows that did not download ascending, a reference row, the raw items untouched", () => {
  const report = buildReport(input());
  assert.deepEqual(Object.keys(report), [
    "dramafetch_report",
    "generated_at",
    "extension_version",
    "browser",
    "test_mode",
    "what_this_is",
    "summary",
    "job",
    "series",
  ]);
  assert.equal(report["dramafetch_report"], REPORT_VERSION);
  assert.equal(report["generated_at"], "2026-11-06T19:30:00.000Z");
  assert.equal(report["extension_version"], "1.3.0");
  assert.deepEqual(report["browser"], { user_agent: "Mozilla/5.0 Chrome/142", language: "es" });
  assert.equal(report["test_mode"], false);
  assert.equal(report["what_this_is"], WHAT_THIS_IS);
  assert.deepEqual(report["job"], {
    kind: "batch",
    label: "2 series",
    started_at: "2026-11-06T19:00:00.000Z",
    finished_at: "2026-11-06T19:30:00.000Z",
    error: null,
    stopped: "three failures in a row",
    refreshes: 1,
    pauses: [{ kind: "pace", seconds: 5.5, text: "pause 5.5 s" }],
  });
  const series = /** @type {Record<string, unknown>[]} */ (report["series"]);
  assert.equal(series.length, 2);
  const [one, other] = /** @type {[Record<string, unknown>, Record<string, unknown>]} */ (series);
  assert.deepEqual(Object.keys(one), ["series_id", "name", "line", "status", "error", "stop", "contacted", "listed", "access_counts", "not_downloaded", "reference", "episodes_digest"]);
  assert.equal(one["episodes_digest"], null); // the series' listed episodes were not passed
  assert.equal(one["series_id"], SERIES_ID);
  assert.equal(one["name"], "One");
  assert.equal(one["listed"], 7);
  assert.deepEqual(one["access_counts"], { free: 7, unlocked: 0, locked: 0 });
  const rows = /** @type {Record<string, unknown>[]} */ (one["not_downloaded"]);
  // every status but done / skipped-exists / dry-run, ascending by number
  assert.deepEqual(
    rows.map((entry) => [entry["number"], entry["status"]]),
    [
      [2, "failed"],
      [4, "failed"],
      [5, "skipped-locked"],
      [6, "failed-unavailable"],
      [7, "failed"],
    ],
  );
  const [shortFile, truncated, locked, fresh, stopped] = /** @type {Record<string, unknown>[]} */ (rows);
  assert.deepEqual(Object.keys(/** @type {object} */ (shortFile)), [
    "number",
    "item_id",
    "title",
    "duration_s",
    "access",
    "paid",
    "drm",
    "lock_hints",
    "quality_hint",
    "status",
    "message",
    "attempted",
    "probable_cause",
    "attempts",
    "refreshes",
    "raw",
  ]);
  assert.equal(shortFile?.["item_id"], "7699400000000000002");
  assert.equal(shortFile?.["access"], "unlocked");
  assert.equal(shortFile?.["paid"], true);
  assert.deepEqual(shortFile?.["lock_hints"], SHORTER_HINTS);
  assert.equal(shortFile?.["attempted"], true);
  assert.match(String(shortFile?.["probable_cause"]), /^the file plays 70 s where the list announces 106 s, and its size is none the list announced/);
  assert.ok(String(shortFile?.["probable_cause"]).endsWith("isFree=False; unlockPrice=30"));
  // the attempts and refreshes come from the trace, copied
  assert.deepEqual(truncated?.["attempts"], TRUNCATED_TRACE.attempts);
  assert.notEqual(truncated?.["attempts"], TRUNCATED_TRACE.attempts);
  assert.equal(truncated?.["probable_cause"], `${CUT_SHORT_CAUSE_PREFIX}100000 of 131072 bytes${CUT_SHORT_CAUSE_SUFFIX}`);
  assert.deepEqual(fresh?.["refreshes"], [{ outcome: "locked", fresh_list: true, access: "locked", hints: ["isLocked=True"], listed_url_count: 0 }]);
  assert.equal(fresh?.["attempted"], true);
  // a locked row was never attempted: its raw item is the whole point
  assert.equal(locked?.["attempted"], false);
  assert.deepEqual(locked?.["attempts"], []);
  assert.deepEqual(locked?.["raw"], LOCKED_RAW);
  assert.equal(locked?.["probable_cause"], `${LOCKED_CAUSE_PREFIX}isLocked=True; no play address${LOCKED_CAUSE_SUFFIX}`);
  // a row without a trace: no attempts, not attempted
  assert.equal(stopped?.["attempted"], false);
  assert.deepEqual(stopped?.["attempts"], []);
  assert.deepEqual(stopped?.["refreshes"], []);
  assert.equal(stopped?.["probable_cause"], `${NOT_ATTEMPTED_CAUSE} (three failures in a row)`);
  // the raw items pass through with their content as served (the signed links included)
  assert.deepEqual(shortFile?.["raw"], { id: "item2", video: { playAddr: ["https://v16.tiktok.com/2.mp4?expire=1"] } });
  // the reference: the FIRST done row of the series, with its raw item
  assert.deepEqual(one["reference"], {
    number: 1,
    status: "done",
    message: "saved One - Episode 01.mp4 (0.1 MiB) + cover embedded",
    access: "free",
    lock_hints: [],
    raw: { id: "item1", video: { playAddr: ["https://v16.tiktok.com/1.mp4?expire=1"] } },
  });
  // the other series: nothing not downloaded (a dry-run row is none), its done row the reference
  assert.deepEqual(other["not_downloaded"], []);
  assert.equal(/** @type {Record<string, unknown>} */ (other["reference"])["number"], 1);
  assert.equal(other["name"], null);
  // the summary: one line per row that did not download, series-prefixed (several series), the name or the id
  const summary = /** @type {string[]} */ (report["summary"]);
  assert.equal(summary.length, 5);
  assert.equal(
    summary[0],
    `One: E02 failed — ${SHORTER} — probable cause: ${SHORTER_FILE_CAUSE_PREFIX}70 s where the list announces 106 s${SHORTER_FILE_CAUSE_MIDDLE}isFree=False; unlockPrice=30`,
  );
  assert.equal(summary[4], `One: E07 failed — stopped: three failures in a row — probable cause: ${NOT_ATTEMPTED_CAUSE} (three failures in a row)`);
});

test("buildReport: one series gives unprefixed summary lines and a skipped-exists reference when nothing is done", () => {
  const only = seriesInput(SERIES_ID, "One", [
    episodeInput(2, "skipped-exists", "already exists: One - Episode 02.mp4"),
    episodeInput(1, "failed-unavailable", DRM_MESSAGE, { trace: { attempts: [attempt({ outcome: "encrypted (DRM)" })], refreshes: [] } }),
  ]);
  const report = buildReport(input([only]));
  assert.deepEqual(report["summary"], [`E01 failed-unavailable — ${DRM_MESSAGE} — probable cause: ${DRM_CAUSE}`]);
  const [series] = /** @type {Record<string, unknown>[]} */ (report["series"]);
  assert.equal(/** @type {Record<string, unknown>} */ (series?.["reference"])["status"], "skipped-exists");
  // no done or skipped-exists row at all: no reference
  const none = buildReport(input([seriesInput(SERIES_ID, "One", [episodeInput(1, "failed", "download failed: x")])]));
  assert.equal(/** @type {Record<string, unknown>[]} */ (none["series"])[0]?.["reference"], null);
  // a series the batch never started: no list, no counts, no rows
  const unstarted = { ...seriesInput(OTHER_ID, null, []), listed: null, access: null, status: "not started", error: "not started: batch stopped in One (x)", line: null };
  const stopped = /** @type {Record<string, unknown>[]} */ (buildReport(input([only, unstarted]))["series"]);
  assert.deepEqual(stopped[1], {
    series_id: OTHER_ID,
    name: null,
    line: null,
    status: "not started",
    error: "not started: batch stopped in One (x)",
    stop: false,
    contacted: true,
    listed: null,
    access_counts: null,
    not_downloaded: [],
    reference: null,
    episodes_digest: null,
  });
});

/**
 * A list item of the `isLimitedFree` shape (2026-11-06), the fields the digest reads set as given.
 * @param {{videoDuration?: unknown, musicDuration?: unknown, original?: unknown, size?: unknown, bitrate?: unknown, isPreview?: unknown, previewType?: unknown}} fields
 * @returns {Record<string, unknown>}
 */
function rawItem(fields) {
  return {
    id: "7699393770256782001",
    dramaInfo: { DramaVideoData: { EpisodeNumber: 1, IsFreeIntro: false, IsPreview: fields.isPreview, PreviewType: fields.previewType }, isLimitedFree: true },
    music: { duration: fields.musicDuration, original: fields.original, playUrl: "https://sf16.tiktokcdn.com/obj/x.mp3" },
    video: {
      duration: fields.videoDuration,
      size: fields.size,
      bitrateInfo: [{ Bitrate: fields.bitrate, PlayAddr: { DataSize: fields.size, UrlList: ["https://v16.tiktok.com/1.mp4?expire=1"] } }],
      playAddr: "https://v16.tiktok.com/1.mp4?expire=1",
    },
  };
}

test("buildReport: episodes_digest has one small entry per LISTED episode — the fields the short-header rules read, no URL", () => {
  const listedEpisodes = [
    { number: 1, access: "free", lockHints: ["isLimitedFree=True"], durationS: 69, raw: rawItem({ videoDuration: 69, musicDuration: 69, original: true, size: 6_000_000, bitrate: 700_000, isPreview: true, previewType: 4 }) },
    { number: 5, access: "locked", lockHints: ["isLimitedFree=True", "plays 69 s of 106 s"], durationS: 106, raw: rawItem({ videoDuration: 106, musicDuration: 69, original: true, size: 9676471, bitrate: 726189, isPreview: true, previewType: 4 }) },
    // absent or odd fields: null; a sound duration that is no number: null; a string original: null
    { number: 7, access: "free", lockHints: [], durationS: 94, raw: rawItem({ videoDuration: "94", musicDuration: "93", original: "true", size: "x", bitrate: null }) },
    { number: 8, access: "free", lockHints: [], durationS: null, raw: { id: "x", video: "junk", music: [1], dramaInfo: null } },
    { number: 9, access: "locked", lockHints: ["no play address"], durationS: null, raw: null },
  ];
  const one = { ...seriesInput(SERIES_ID, "One", [episodeInput(5, "failed-unavailable", SERVED, { access: "locked", lockHints: ["isLimitedFree=True", "plays 69 s of 106 s"] })]), listedEpisodes };
  const report = buildReport(input([one]));
  const [series] = /** @type {Record<string, unknown>[]} */ (report["series"]);
  const digest = /** @type {Record<string, unknown>[]} */ (series?.["episodes_digest"]);
  assert.equal(digest.length, 5); // every listed episode, not only the failures
  assert.deepEqual(digest[0], {
    number: 1,
    access: "free",
    lock_hints: ["isLimitedFree=True"],
    duration_s: 69,
    music_duration_s: 69,
    music_original: true,
    size: 6_000_000,
    bitrate: 700_000,
    is_preview: true,
    preview_type: 4,
  });
  assert.deepEqual(digest[1], {
    number: 5,
    access: "locked",
    lock_hints: ["isLimitedFree=True", "plays 69 s of 106 s"],
    duration_s: 106,
    music_duration_s: 69,
    music_original: true,
    size: 9676471,
    bitrate: 726189,
    is_preview: true,
    preview_type: 4,
  });
  assert.deepEqual(digest[2], {
    number: 7,
    access: "free",
    lock_hints: [],
    duration_s: 94, // the episode's parsed duration where the raw value is no number
    music_duration_s: null,
    music_original: null,
    size: null,
    bitrate: null,
    is_preview: null,
    preview_type: null,
  });
  assert.deepEqual(digest[3], { number: 8, access: "free", lock_hints: [], duration_s: null, music_duration_s: null, music_original: null, size: null, bitrate: null, is_preview: null, preview_type: null });
  assert.deepEqual(digest[4], { number: 9, access: "locked", lock_hints: ["no play address"], duration_s: null, music_duration_s: null, music_original: null, size: null, bitrate: null, is_preview: null, preview_type: null });
  assert.ok(!JSON.stringify(digest).includes("http"));
  // the short-served row's cause, and the digest copies the hints (the input stays untouched)
  assert.equal(/** @type {Record<string, unknown>[]} */ (series?.["not_downloaded"])[0]?.["probable_cause"], `${SHORT_SERVED_CAUSE_PREFIX}70 s of 106 s${SHORT_SERVED_CAUSE_SUFFIX}`);
  assert.notEqual(digest[0]?.["lock_hints"], listedEpisodes[0]?.lockHints);
  // not listed: null (an unstarted series, or an input without the list)
  assert.equal(/** @type {Record<string, unknown>[]} */ (buildReport(input([{ ...one, listedEpisodes: null }]))["series"])[0]?.["episodes_digest"], null);
  assert.equal(REPORT_VERSION, 1); // an additive field: the format version stays
});

/** A job as the report records it. */
const JOB = { kind: "batch", label: "3 series", startedAt: "2026-11-12T09:00:00.000Z", finishedAt: "2026-11-12T10:00:00.000Z", error: null, stopped: null, refreshes: 0, pauses: [] };

/**
 * A whole series as a run leaves it: two downloaded rows, two failures and `locked` locked rows from E05 on.
 * @param {number} locked
 */
function mixedRows(locked) {
  const lockedMessage = "looks locked: isLocked=True; no play address";
  return [
    episodeInput(1, "skipped-exists", "already downloaded (manifest): E1.mp4"),
    episodeInput(2, "done", "saved E2.mp4 (0.1 MiB)"),
    episodeInput(3, "failed", `${INCOMPLETE_PREFIX}truncated body (100000 of 131072 bytes) from v16.tiktok.com`),
    episodeInput(4, "done", "saved E4.mp4 (0.1 MiB)"),
    ...Array.from({ length: locked }, (_, index) =>
      episodeInput(5 + index, "skipped-locked", lockedMessage, { access: "locked", lockHints: ["isLocked=True", "no play address"], trace: null }),
    ),
    episodeInput(5 + locked, "failed", "stopped: 3 consecutive failures", { trace: null }),
  ];
}

test("slimRows: the raw item and the trace only of what the report describes — of a series' locked rows the first three — and the reference row's raw item", () => {
  assert.equal(LOCKED_RAW_KEPT, 3);
  const rows = mixedRows(10);
  const slim = slimRows(rows);
  assert.equal(slim.length, rows.length);
  const kept = (/** @type {"raw" | "trace"} */ field) => slim.filter((row) => row[field] !== null).map((row) => row.number);
  // raw: the reference (E02, the first done — not E01, on disk only), both failures, the first three locked rows
  assert.deepEqual(kept("raw"), [2, 3, 5, 6, 7, 15]);
  // trace: only what a row that did not download recorded (the locked and the stopped ones recorded none)
  assert.deepEqual(kept("trace"), [3]);
  for (const [index, row] of slim.entries()) {
    const { raw, trace, ...rest } = row;
    const { raw: fullRaw, trace: fullTrace, ...fullRest } = /** @type {import("../src/lib/diagnosis.js").EpisodeInput} */ (rows[index]);
    assert.deepEqual(rest, fullRest); // nothing else of a row changes
    if (raw !== null) assert.equal(raw, fullRaw); // the very item, as served
    if (trace !== null) assert.equal(trace, fullTrace);
  }
  assert.deepEqual(slimRows(slim), slim); // taking it twice changes nothing
  // the three locked rows that keep their item are the first by NUMBER, whatever the rows' order
  assert.deepEqual(
    slimRows([...rows].reverse()).filter((row) => row.status === "skipped-locked" && row.raw !== null).map((row) => row.number).sort((a, b) => a - b),
    [5, 6, 7],
  );
  // with no done row the reference is the first one found on disk; a series with three locked rows or fewer loses nothing
  const onDisk = slimRows([episodeInput(1, "skipped-exists", "x"), episodeInput(2, "skipped-exists", "x"), episodeInput(3, "dry-run", "x")]);
  assert.deepEqual(onDisk.map((row) => row.raw !== null), [true, false, false]);
  const few = mixedRows(3);
  assert.deepEqual(slimRows(few).filter((row) => row.status !== "done" && row.status !== "skipped-exists"), few.filter((row) => row.status !== "done" && row.status !== "skipped-exists"));
});

test("buildReport: the same report from rows and a digest taken when the series was done as from the whole run", () => {
  const listed = (/** @type {import("../src/lib/diagnosis.js").EpisodeInput[]} */ rows) =>
    rows.map((row) => ({ number: row.number, access: row.access, lockHints: row.lockHints, durationS: row.durationS, raw: row.raw }));
  const first = mixedRows(10);
  const second = [episodeInput(1, "done", "saved"), episodeInput(2, "failed-rate-limited", MEDIA_RATE_LIMIT_MESSAGE)];
  const whole = [
    { ...seriesInput(SERIES_ID, "One", first), listedEpisodes: listed(first) },
    { ...seriesInput(OTHER_ID, null, second), listedEpisodes: listed(second) },
    { ...seriesInput("7699393770256782388", "Never started", []), listed: null, access: null, listedEpisodes: null },
  ];
  // what the page takes when a series of a batch is done: the slim rows and the digest, no list any more
  const taken = whole.map((run) => ({
    ...run,
    episodes: slimRows(run.episodes),
    listedEpisodes: null,
    episodesDigest: run.listedEpisodes === null ? null : run.listedEpisodes.map(digestEntry),
  }));
  const input = { generatedAt: "2026-11-12T10:00:00.000Z", extensionVersion: "1.3.1", userAgent: "UA", language: "en", testMode: false, job: JOB };
  const fromWhole = buildReport({ ...input, series: whole });
  const fromTaken = buildReport({ ...input, series: taken });
  assert.deepEqual(fromTaken, fromWhole);
  assert.equal(new TextDecoder().decode(reportJson(fromTaken)), new TextDecoder().decode(reportJson(fromWhole)));
  const [one, two, never] = /** @type {Record<string, any>[]} */ (fromWhole["series"]);
  // every locked row is described; only the first three carry their list item
  const locked = one?.["not_downloaded"].filter((/** @type {Record<string, unknown>} */ row) => row["status"] === "skipped-locked");
  assert.equal(locked.length, 10);
  assert.deepEqual(locked.map((/** @type {Record<string, unknown>} */ row) => row["raw"] !== null), [true, true, true, ...Array(7).fill(false)]);
  assert.ok(locked.every((/** @type {Record<string, unknown>} */ row) => String(row["probable_cause"]).startsWith(LOCKED_CAUSE_PREFIX) && /** @type {unknown[]} */ (row["lock_hints"]).length === 2));
  // a failure always carries its item, the reference too, and the digest lists every episode
  assert.ok(one?.["not_downloaded"].filter((/** @type {Record<string, unknown>} */ row) => String(row["status"]).startsWith("failed")).every((/** @type {Record<string, unknown>} */ row) => row["raw"] !== null));
  assert.equal(one?.["reference"].number, 2);
  assert.notEqual(one?.["reference"].raw, null);
  assert.equal(one?.["episodes_digest"].length, first.length);
  assert.equal(two?.["episodes_digest"].length, 2);
  assert.equal(never?.["episodes_digest"], null);
  assert.equal(/** @type {string[]} */ (fromWhole["summary"]).length, 10 + 2 + 1);
});

test("the report of a series with many locked episodes stays small: its size no longer grows with their list items", () => {
  const padding = "x".repeat(6000); // a list item of some 6 KB, as TikTok serves them
  /** @param {number} locked */
  const bytes = (locked) => {
    const rows = mixedRows(locked).map((row) => ({ ...row, raw: { ...row.raw, padding } }));
    const report = buildReport({
      generatedAt: "2026-11-12T10:00:00.000Z",
      extensionVersion: "1.3.1",
      userAgent: "UA",
      language: "en",
      testMode: false,
      job: JOB,
      series: [seriesInput(SERIES_ID, "One", rows)],
    });
    return reportJson(report).length;
  };
  const perLockedRow = (bytes(53) - bytes(3)) / 50;
  assert.ok(perLockedRow < 1500, `${perLockedRow} bytes per further locked row`); // its description, not its 6 KB item
  assert.ok(bytes(3) - bytes(0) > 3 * 6000); // the first three do carry theirs
});

test("hasFailures: any failed-* row of any series; locked skips alone are none", () => {
  assert.equal(hasFailures(runs()), true);
  assert.equal(hasFailures([seriesInput(SERIES_ID, "One", [episodeInput(1, "done", "saved"), episodeInput(2, "skipped-locked", "looks locked")])]), false);
  assert.equal(hasFailures([seriesInput(SERIES_ID, "One", [episodeInput(1, "failed-unavailable", "x")])]), true);
  assert.equal(hasFailures([]), false);
});

test("reportStem: the series' Chrome-safe name (60 at most) or the series count, the local date and time without a colon", () => {
  const when = new Date(2026, 10, 6, 19, 30, 59); // the 6th of November 2026, 19:30 local time
  assert.equal(reportStem([seriesInput(SERIES_ID, "One", [])], when), "One - did not download 2026-11-06 1930");
  assert.equal(reportStem([seriesInput(SERIES_ID, null, [])], when), `${SERIES_ID} - did not download 2026-11-06 1930`);
  assert.equal(reportStem([seriesInput(SERIES_ID, 'Love: "Forever"? <Yes|No> *~', [])], when), "Love Forever Yes No - did not download 2026-11-06 1930");
  const long = "A".repeat(70);
  assert.equal(reportStem([seriesInput(SERIES_ID, long, [])], when), `${"A".repeat(60)} - did not download 2026-11-06 1930`);
  assert.equal(reportStem(runs(), when), "2 series - did not download 2026-11-06 1930");
  assert.equal(reportStem([seriesInput(SERIES_ID, "One", [])], new Date(2026, 0, 2, 3, 4)), "One - did not download 2026-01-02 0304");
});

test("reportFilename and reportJson: DramaFetch/reports/<stem>.json, indented UTF-8 JSON that parses back", () => {
  assert.equal(REPORTS_FOLDER, "reports");
  assert.equal(reportFilename("One - did not download 2026-11-06 1930"), "DramaFetch/reports/One - did not download 2026-11-06 1930.json");
  const report = buildReport(input());
  const bytes = reportJson(report);
  assert.ok(bytes instanceof Uint8Array);
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.startsWith('{\n  "dramafetch_report": 1,\n'));
  assert.deepEqual(JSON.parse(text), report);
});
