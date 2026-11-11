// @ts-check
// Unit tests of src/lib/report.js: the probable cause of every failure code, the report built
// over a run (snake_case, the rows that did not download in input order, the counts, the
// summary) and its privacy: every URL stripped of its query, no header, no cookie or token.
import assert from "node:assert/strict";
import { test } from "node:test";

import { FAILURE_CODES, render } from "../src/lib/messages.js";
import {
  BILIBILITV_PROBABLE_CAUSES,
  PROBABLE_CAUSES,
  REPORT_VERSION,
  WHAT_THIS_IS,
  attemptEntry,
  buildReport,
  hasFailures,
  probableCause,
  reportJson,
  rowEntry,
  sanitize,
} from "../src/lib/report.js";

const SIGNED =
  "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/1/2/3/4-1-30080.m4s" +
  "?e=ig8euxZM2rNcNbdlhoNvNC8BqJIzNbfq&deadline=1762600000&gen=playurlv3&os=cosbv&trid=abc" +
  "&platform=pc&upsig=SIGNATURE&uparams=e,deadline";
const STRIPPED = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/1/2/3/4-1-30080.m4s";
const METADATA = "https://www.dailymotion.com/player/metadata/video/x1?app=com.dailymotion.neon";
const MASTER = "https://www.dailymotion.com/cdn/manifest/video/x1.m3u8";

/**
 * An attempt record of the fixed shape.
 * @param {Partial<import("../src/lib/report.js").Attempt>} [fields]
 * @returns {import("../src/lib/report.js").Attempt}
 */
function attempt(fields = {}) {
  return {
    url: SIGNED,
    requested: true,
    http_status: 403,
    content_type: "text/html",
    content_length: 0,
    received_bytes: 0,
    range: null,
    outcome: "refused",
    ...fields,
  };
}

/**
 * One row of a run.
 * @param {string} status
 * @param {import("../src/lib/messages.js").Failure | null} failure
 * @param {Partial<import("../src/lib/report.js").RowInput>} [extra]
 * @returns {import("../src/lib/report.js").RowInput}
 */
function row(status, failure, extra = {}) {
  return {
    input: "https://www.dailymotion.com/video/x1",
    site: "dailymotion",
    id: "x1",
    part: null,
    title: "Title",
    status,
    failure,
    ...extra,
  };
}

/** @type {import("../src/lib/report.js").ReportOptions} */
const OPTIONS = {
  extensionVersion: "1.0.0",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0",
  language: "en",
  now: new Date("2026-11-08T21:30:00Z"),
  testMode: false,
};

/** A run with a downloaded row, a skipped one and three that did not download. */
const RUN = {
  startedAt: new Date("2026-11-08T21:00:00Z"),
  finishedAt: "2026-11-08T21:20:00Z",
  stopReason: "rate_limited",
  settings: {
    quality: "best",
    codec: "compatible",
    videoPauseS: [3, 6],
    report: true,
    language: "auto",
  },
  rows: [
    row("done", null, {
      input: "https://www.dailymotion.com/video/x8vu47w",
      id: "x8vu47w",
      title: "First",
    }),
    row(
      "failed-unavailable",
      { code: "geo_blocked", params: { site_message: "Video geo-blocked" } },
      {
        title: "Geo",
        attempts: [
          attempt({
            url: METADATA,
            http_status: 200,
            content_type: "application/json",
            received_bytes: 1234,
            outcome: "ok",
          }),
        ],
        page: { url: METADATA, http_status: 200, bytes: 1234 },
        raw: {
          title: "Geo",
          error: { code: "DM007", title: "Video geo-blocked" },
          qualities: {
            auto: [{ type: "application/x-mpegURL", url: `${MASTER}?sec=abc` }],
          },
        },
      },
    ),
    row("skipped-exists", null, { id: "x2", title: "Already" }),
    row(
      "failed-rate-limited",
      { code: "rate_limited", params: { detail: `HTTP 412 on the media request ${SIGNED}` } },
      {
        input: "https://www.bilibili.com/video/BV1GJ411x7h7?p=2",
        site: "bilibili",
        id: "BV1GJ411x7h7",
        part: 2,
        title: "Second",
        attempts: [attempt({ range: "bytes=1024-" })],
        streams: {
          kind: "dash",
          chosen: { video: { id: 80, urls: [SIGNED] }, audio: { id: 30280, urls: [SIGNED] } },
          available: [{ id: 80, urls: [SIGNED] }],
        },
        raw: {
          data: { dash: { video: [{ id: 80, baseUrl: SIGNED, backupUrl: [SIGNED] }] } },
          SESSDATA: "secret-cookie-value",
          headers: { Cookie: "SESSDATA=secret-cookie-value" },
          access_token: "secret-token-value",
        },
      },
    ),
    row("stopped", null, {
      input: "https://www.bilibili.com/video/av170001",
      site: "bilibili",
      id: "av170001",
      title: "Third",
    }),
  ],
};

test("probableCause: one sentence per failure code, the http_status ones refined by status", () => {
  for (const code of FAILURE_CODES) {
    const cause = probableCause({ status: "failed", failure: { code, params: {} } });
    assert.equal(cause, PROBABLE_CAUSES[code], code);
    assert.ok(cause.length > 20, code);
  }
  assert.deepEqual(Object.keys(PROBABLE_CAUSES).sort(), [...FAILURE_CODES].sort());
  assert.equal(
    probableCause({ status: "failed-unavailable", failure: { code: "geo_blocked", params: {} } }),
    "Dailymotion does not serve this video in your country; StreamFetch never bypasses " +
      "geo-restrictions",
  );
  /** @param {unknown} status */
  const http = (status) =>
    probableCause({ status: "failed", failure: { code: "http_status", params: { status } } });
  assert.match(http(403), /^the server refused the request \(HTTP 403\)/);
  assert.match(http(404), /^the media URL is gone \(HTTP 404 \/ 410\)/);
  assert.match(http(410), /^the media URL is gone/);
  assert.equal(http(503), "a server problem on the site's side (HTTP 503); worth a retry later");
  assert.equal(http(418), PROBABLE_CAUSES.http_status);
  assert.equal(http("x"), PROBABLE_CAUSES.http_status);
  assert.equal(http(undefined), PROBABLE_CAUSES.http_status);
  assert.equal(probableCause({ status: "stopped", failure: null }), PROBABLE_CAUSES.stopped);
  assert.equal(
    probableCause({ status: "failed", failure: null }),
    "no failure was recorded for this row",
  );
  const unknownCode = /** @type {unknown} */ ("nope");
  const bad = /** @type {import("../src/lib/messages.js").FailureCode} */ (unknownCode);
  assert.equal(
    probableCause({ status: "failed", failure: { code: bad, params: {} } }),
    'unknown failure code "nope"',
  );
});

test("the report: snake_case, the undownloaded rows in input order, counts, summary", () => {
  const report = buildReport(RUN, OPTIONS);
  assert.deepEqual(Object.keys(report), [
    "report_version",
    "what_this_is",
    "extension_version",
    "user_agent",
    "language",
    "test_mode",
    "created_at",
    "run",
    "not_downloaded",
    "downloaded_count",
    "skipped_exists_count",
    "summary",
  ]);
  assert.equal(report["report_version"], REPORT_VERSION);
  assert.equal(REPORT_VERSION, 1);
  assert.equal(report["what_this_is"], WHAT_THIS_IS);
  assert.equal(report["extension_version"], "1.0.0");
  assert.equal(report["user_agent"], OPTIONS.userAgent);
  assert.equal(report["language"], "en");
  assert.equal(report["test_mode"], false);
  assert.equal(report["created_at"], "2026-11-08T21:30:00.000Z");
  assert.deepEqual(report["run"], {
    started_at: "2026-11-08T21:00:00.000Z",
    finished_at: "2026-11-08T21:20:00Z",
    stop_reason: "rate_limited",
    settings: RUN.settings,
  });
  assert.equal(report["downloaded_count"], 1);
  assert.equal(report["skipped_exists_count"], 1);
  const rows = /** @type {Record<string, unknown>[]} */ (report["not_downloaded"]);
  assert.deepEqual(
    rows.map((entry) => [entry["id"], entry["status"]]),
    [
      ["x1", "failed-unavailable"],
      ["BV1GJ411x7h7", "failed-rate-limited"],
      ["av170001", "stopped"],
    ],
  );
  const geo = /** @type {Record<string, unknown>} */ (rows[0]);
  assert.deepEqual(Object.keys(geo), [
    "input",
    "site",
    "id",
    "part",
    "season_id",
    "episode_id",
    "title",
    "status",
    "failure",
    "message_en",
    "probable_cause",
    "attempts",
    "streams",
    "page",
    "raw",
  ]);
  assert.deepEqual(geo["failure"], {
    code: "geo_blocked",
    params: { site_message: "Video geo-blocked" },
  });
  assert.equal(geo["message_en"], render("geo_blocked", { site_message: "Video geo-blocked" }));
  assert.equal(geo["probable_cause"], PROBABLE_CAUSES.geo_blocked);
  assert.deepEqual(geo["page"], {
    url_without_query: "https://www.dailymotion.com/player/metadata/video/x1",
    http_status: 200,
    bytes: 1234,
  });
  assert.deepEqual(geo["attempts"], [
    {
      url: "https://www.dailymotion.com/player/metadata/video/x1",
      host: "www.dailymotion.com",
      requested: true,
      http_status: 200,
      content_type: "application/json",
      content_length: 0,
      received_bytes: 1234,
      range: null,
      outcome: "ok",
    },
  ]);
  assert.equal(geo["streams"], null);
  assert.deepEqual(geo["raw"], {
    title: "Geo",
    error: { code: "DM007", title: "Video geo-blocked" },
    qualities: { auto: [{ type: "application/x-mpegURL", url: MASTER }] },
  });
  const stopped = /** @type {Record<string, unknown>} */ (rows[2]);
  assert.deepEqual(stopped["failure"], { code: "stopped", params: {} });
  assert.equal(stopped["message_en"], "not attempted: no reason given");
  assert.equal(stopped["probable_cause"], PROBABLE_CAUSES.stopped);
  assert.deepEqual(
    [stopped["attempts"], stopped["streams"], stopped["page"], stopped["raw"]],
    [[], null, null, null],
  );
  const summary = /** @type {string[]} */ (report["summary"]);
  assert.equal(summary.length, 3);
  assert.equal(
    summary[0],
    `2. dailymotion x1 — Geo — failed-unavailable: ${geo["message_en"]} — probable cause: ` +
      PROBABLE_CAUSES.geo_blocked,
  );
  assert.match(
    /** @type {string} */ (summary[1]),
    /^4\. bilibili BV1GJ411x7h7 P2 — Second — failed-rate-limited: /,
  );
  assert.equal(
    summary[2],
    "5. bilibili av170001 — Third — stopped: not attempted: no reason given — " +
      `probable cause: ${PROBABLE_CAUSES.stopped}`,
  );
  assert.equal(hasFailures(RUN), true);
  assert.equal(hasFailures({ ...RUN, rows: RUN.rows.slice(0, 1) }), false);
  const [first, , skipped, , third] = RUN.rows;
  assert.equal(hasFailures({ ...RUN, rows: [first, skipped] }), false);
  assert.equal(hasFailures({ ...RUN, rows: [third] }), true);
});

test("privacy: every URL stripped of its query, no header, no cookie or token anywhere", () => {
  const report = buildReport(RUN, OPTIONS);
  const json = reportJson(report);
  assert.equal(json, JSON.stringify(report, null, 2));
  assert.ok(json.startsWith('{\n  "report_version": 1,'));
  assert.doesNotMatch(json, /https?:\/\/[^"\s]*[?#]/, "a URL kept its query or fragment");
  // the signed query strings and the credential VALUES are nowhere; the credential KEYS are no
  // JSON keys either
  const secrets = [
    "deadline=",
    "upsig",
    "SIGNATURE",
    "sec=abc",
    "secret-cookie-value",
    "secret-token-value",
    "SESSDATA=",
  ];
  for (const secret of secrets) {
    assert.ok(!json.includes(secret), `the report holds ${secret}`);
  }
  assert.doesNotMatch(json, /"(SESSDATA|Cookie|cookie|headers|access_token|Authorization)":/);
  assert.ok(!json.includes("?p=2"), "the pasted line's own query is stripped (part keeps it)");
  const rows = /** @type {Record<string, unknown>[]} */ (report["not_downloaded"]);
  const bili = /** @type {Record<string, unknown>} */ (rows[1]);
  assert.equal(bili["input"], "https://www.bilibili.com/video/BV1GJ411x7h7");
  assert.equal(bili["part"], 2);
  const detail = `HTTP 412 on the media request ${STRIPPED}`;
  assert.deepEqual(bili["failure"], { code: "rate_limited", params: { detail } });
  assert.equal(bili["message_en"], render("rate_limited", { detail }));
  assert.deepEqual(bili["streams"], {
    kind: "dash",
    chosen: { video: { id: 80, urls: [STRIPPED] }, audio: { id: 30280, urls: [STRIPPED] } },
    available: [{ id: 80, urls: [STRIPPED] }],
  });
  assert.deepEqual(bili["raw"], {
    data: { dash: { video: [{ id: 80, baseUrl: STRIPPED, backupUrl: [STRIPPED] }] } },
  });
  const attempts = /** @type {Record<string, unknown>[]} */ (bili["attempts"]);
  assert.deepEqual(attempts, [
    {
      url: STRIPPED,
      host: "upos-sz-mirrorcos.bilivideo.com",
      requested: true,
      http_status: 403,
      content_type: "text/html",
      content_length: 0,
      received_bytes: 0,
      range: "bytes=1024-",
      outcome: "refused",
    },
  ]);
  // the originals are untouched
  assert.ok(/** @type {string} */ (RUN.rows[3]?.input).includes("?p=2"));
  assert.equal(RUN.rows[3]?.attempts?.[0]?.url, SIGNED);
});

test("sanitize and attemptEntry on their own", () => {
  assert.deepEqual(
    sanitize({
      title: "Keep",
      cookie: "a",
      Cookie: "b",
      "set-cookie": "c",
      authorization: "d",
      Authorization: "e",
      accessToken: "f",
      refresh_token: "g",
      SESSDATA: "h",
      bili_jct: "i",
      password: "j",
      client_secret: "k",
      headers: {},
      header: {},
      deadline: 1762600000,
      list: [{ token: "x", url: `${SIGNED}` }],
      text: `see ${SIGNED} now`,
    }),
    { title: "Keep", deadline: 1762600000, list: [{ url: STRIPPED }], text: `see ${STRIPPED} now` },
  );
  assert.equal(sanitize(null), null);
  assert.equal(sanitize(5), 5);
  assert.deepEqual(sanitize(["a", 1]), ["a", 1]);
  const bare = {
    url: `${METADATA}#x`,
    requested: false,
    http_status: null,
    content_type: null,
    content_length: null,
    received_bytes: null,
    range: null,
    outcome: "host not covered",
  };
  assert.deepEqual(attemptEntry(bare), {
    url: "https://www.dailymotion.com/player/metadata/video/x1",
    host: "www.dailymotion.com",
    requested: false,
    http_status: null,
    content_type: null,
    content_length: null,
    received_bytes: null,
    range: null,
    outcome: "host not covered",
  });
  assert.equal(attemptEntry(attempt({ host: "given.example" }))["host"], "given.example");
  assert.equal(attemptEntry(attempt({ url: "junk" }))["host"], null);
});

test("a run with nothing to report still builds; strings pass through, bad dates are null", () => {
  const run = {
    startedAt: "2026-11-08T21:00:00Z",
    finishedAt: null,
    stopReason: null,
    settings: null,
    rows: [row("done", null)],
  };
  const report = buildReport(run, { extensionVersion: "1.0.0", userAgent: "UA", language: "es" });
  assert.deepEqual(report["not_downloaded"], []);
  assert.deepEqual(report["summary"], []);
  assert.equal(report["downloaded_count"], 1);
  assert.equal(report["skipped_exists_count"], 0);
  assert.deepEqual(report["run"], {
    started_at: "2026-11-08T21:00:00Z",
    finished_at: null,
    stop_reason: null,
    settings: null,
  });
  assert.match(String(report["created_at"]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(report["test_mode"], false);
  assert.equal(hasFailures(run), false);
  const broken = buildReport(
    { ...run, startedAt: new Date(Number.NaN) },
    { ...OPTIONS, testMode: true },
  );
  assert.equal(/** @type {Record<string, unknown>} */ (broken["run"])["started_at"], null);
  assert.equal(broken["test_mode"], true);
  // a downloaded row is never listed, even with a failure record; a failed row without one is
  const odd = buildReport(
    {
      ...run,
      rows: [row("done", { code: "deleted", params: {} }), row("failed", null, { id: "x9" })],
    },
    OPTIONS,
  );
  const rows = /** @type {Record<string, unknown>[]} */ (odd["not_downloaded"]);
  assert.deepEqual(
    rows.map((entry) => [entry["id"], entry["failure"], entry["message_en"]]),
    [["x9", null, "Failed"]],
  );
  assert.equal(rows[0]?.["probable_cause"], "no failure was recorded for this row");
  assert.equal(rowEntry(row("stopped", null))["message_en"], "not attempted: no reason given");
});

test("Bilibili.tv rows: season_id and episode_id, the site's own probable causes", () => {
  const login = rowEntry(
    row(
      "failed-unavailable",
      {
        code: "login_required",
        params: { site_code: "10023006", site_message: "premium members only" },
      },
      {
        input: "https://www.bilibili.tv/en/play/2090001/30010003?bstar_from=x",
        site: "bilibilitv",
        id: "30010003",
        part: 3,
        seasonId: "2090001",
        episodeId: "30010003",
        title: "E3 - Invented",
      },
    ),
  );
  assert.deepEqual(
    [login["site"], login["season_id"], login["episode_id"], login["input"]],
    ["bilibilitv", "2090001", "30010003", "https://www.bilibili.tv/en/play/2090001/30010003"],
  );
  assert.equal(login["probable_cause"], BILIBILITV_PROBABLE_CAUSES.login_required);
  assert.match(String(login["probable_cause"]), /log in to Bilibili\.tv/);
  assert.match(String(login["probable_cause"]), /premium/);
  assert.deepEqual(login["failure"], {
    code: "login_required",
    params: { site_code: "10023006", site_message: "premium members only" },
  });
  /** @param {import("../src/lib/messages.js").FailureCode} code @param {string} site */
  const cause = (code, site) =>
    probableCause({ status: "failed-unavailable", failure: { code, params: {} }, site });
  assert.match(cause("geo_blocked", "bilibilitv"), /^Bilibili\.tv does not serve this video/);
  assert.equal(cause("geo_blocked", "dailymotion"), PROBABLE_CAUSES.geo_blocked);
  assert.equal(cause("geo_blocked", "bilibili"), PROBABLE_CAUSES.geo_blocked);
  for (const code of /** @type {const} */ ([
    "deleted",
    "premium_only",
    "no_streams",
    "host_not_covered",
  ])) {
    assert.equal(cause(code, "bilibilitv"), BILIBILITV_PROBABLE_CAUSES[code], code);
    assert.notEqual(cause(code, "bilibilitv"), PROBABLE_CAUSES[code], code);
  }
  assert.match(cause("host_not_covered", "bilibilitv"), /send this report/);
  // the codes without a Bilibili.tv sentence keep the common one
  assert.equal(cause("rate_limited", "bilibilitv"), PROBABLE_CAUSES.rate_limited);
  assert.match(PROBABLE_CAUSES.unsupported_link, /bili\.im/);
  // the other sites' rows carry the two keys as null
  const dm = rowEntry(row("failed", { code: "no_response", params: {} }));
  assert.deepEqual([dm["season_id"], dm["episode_id"]], [null, null]);
  assert.match(WHAT_THIS_IS, /Dailymotion, Bilibili\.tv or Bilibili/);
});
