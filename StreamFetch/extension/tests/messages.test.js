// @ts-check
// Unit tests of src/lib/messages.js: the statuses and their sets, every failure code's parameters
// and English text, the stop reasons and the link refusals.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ACTIVE_STATUSES,
  BLOCK_STATUSES,
  FAILURE_CODES,
  FAILURE_PARAMS,
  FINAL_STATUSES,
  HINT_CODES,
  HINT_PARAMS,
  LINK_REFUSALS,
  LINK_REFUSAL_TEXTS_EN,
  NOT_DOWNLOADED_STATUSES,
  REQUEST_KINDS,
  STATUSES,
  STATUS_LABELS_EN,
  STOP_REASONS,
  STOP_REASON_TEXTS_EN,
  failure,
  failureSubstitutions,
  failureText,
  hintSubstitutions,
  hintText,
  isFailure,
  isFailureCode,
  isFinal,
  isHintCode,
  isNotDownloaded,
  isStatus,
  isStopReason,
  paramText,
  refusalText,
  render,
  statusForFailure,
  statusLabel,
  stopReasonText,
} from "../src/lib/messages.js";

/** The fixed list of section 6 of the spec, in its order. */
const SPEC_CODES = [
  "http_status",
  "host_not_covered",
  "redirect_refused",
  "no_response",
  "truncated_body",
  "not_a_video",
  "encrypted",
  "key_protected",
  "live_stream",
  "discontinuous_stream",
  "legacy_stream",
  "geo_blocked",
  "login_required",
  "premium_only",
  "supporter_only",
  "trial_only",
  "deleted",
  "interactive",
  "rate_limited",
  "blocked",
  "verify_failed",
  "remux_failed",
  "save_failed",
  "stopped",
  "unsupported_link",
  "no_streams",
  "cooldown",
];

/** A value for every parameter name. @type {Record<string, unknown>} */
const SAMPLE = {
  status: 404,
  what: "segment",
  host: "evil.example",
  detail: "stalled for 30 s",
  received: 1234,
  expected: 5678,
  content_type: "text/html",
  method: "AES-128",
  count: 2,
  site_message: "DM007",
  labels: ["1080P60", "4K"],
  reason: "duration 70 s, expected 106 s",
  until: "19:30",
  minutes_left: 12,
  stream_type: 0x24,
};

test("the statuses of the spec in the order of a target's life, their sets and labels", () => {
  assert.deepEqual(STATUSES, [
    "queued",
    "resolving",
    "downloading",
    "finishing",
    "verifying",
    "done",
    "skipped-exists",
    "failed",
    "failed-unavailable",
    "failed-rate-limited",
    "failed-blocked",
    "stopped",
  ]);
  assert.deepEqual(Object.keys(STATUS_LABELS_EN), [...STATUSES]);
  for (const status of STATUSES) {
    assert.ok(isStatus(status));
    assert.equal(isFinal(status), FINAL_STATUSES.has(status));
    assert.equal(isFinal(status), !ACTIVE_STATUSES.has(status));
    assert.ok(statusLabel(status).length > 0 && statusLabel(status) !== status, status);
  }
  assert.equal(isStatus("Done"), false);
  assert.equal(isStatus(3), false);
  assert.equal(statusLabel("weird"), "weird");
  assert.ok(isFailure("failed-unavailable") && !isFailure("stopped") && !isFailure("done"));
  assert.ok(isNotDownloaded("stopped") && isNotDownloaded("failed"));
  assert.ok(!isNotDownloaded("skipped-exists") && !isNotDownloaded("done"));
  assert.deepEqual(
    [...NOT_DOWNLOADED_STATUSES],
    ["failed", "failed-unavailable", "failed-rate-limited", "failed-blocked", "stopped"],
  );
  assert.deepEqual([...BLOCK_STATUSES], ["failed-rate-limited", "failed-blocked"]);
});

test("the 27 codes of the spec plus the demuxer's two, every one with a parameter list", () => {
  assert.equal(FAILURE_CODES.length, 29);
  assert.deepEqual(FAILURE_CODES.slice(0, 27), SPEC_CODES);
  assert.deepEqual(FAILURE_CODES.slice(27), ["unsupported_codec", "corrupt_stream"]);
  assert.deepEqual(Object.keys(FAILURE_PARAMS).sort(), [...FAILURE_CODES].sort());
  assert.ok(isFailureCode("geo_blocked") && !isFailureCode("geo-blocked") && !isFailureCode(null));
  assert.deepEqual(FAILURE_PARAMS.cooldown, ["until", "minutes_left", "reason"]);
  assert.ok(REQUEST_KINDS.includes("manifest") && REQUEST_KINDS.includes("segment"));
});

test("render: a sentence for every code, its parameters in it, defaults without them", () => {
  for (const code of FAILURE_CODES) {
    const text = render(code, SAMPLE);
    assert.ok(text.length > 20, `${code}: ${text}`);
    assert.doesNotMatch(text, /undefined|null|\[object|\$\d/, `${code}: ${text}`);
    assert.notEqual(text, code);
    const bare = render(code, {});
    assert.ok(bare.length > 20, `${code} without params: ${bare}`);
    assert.doesNotMatch(bare, /undefined|null|\[object/, `${code}: ${bare}`);
    for (const name of FAILURE_PARAMS[code]) {
      const value = paramText(name, SAMPLE[name]);
      assert.ok(text.includes(value), `${code} should carry ${name}=${value}: ${text}`);
    }
    assert.deepEqual(
      failureSubstitutions(code, SAMPLE),
      FAILURE_PARAMS[code].map((name) => paramText(name, SAMPLE[name])),
    );
    assert.equal(failureText({ code, params: SAMPLE }), text);
  }
  assert.equal(render("nonsense"), "unknown failure (nonsense)");
  assert.deepEqual(failureSubstitutions("nonsense", SAMPLE), []);
  assert.equal(failureText(null), "");
});

test("the exact texts the UI and the e2e tests look for", () => {
  assert.equal(
    render("http_status", { status: 403, what: "segment" }),
    "HTTP 403 on the segment request",
  );
  assert.equal(render("http_status"), "HTTP ? on the page or media request");
  assert.equal(
    render("truncated_body", { received: 1234, expected: null }),
    "the transfer was cut short (1234 of ? bytes received)",
  );
  assert.equal(
    render("geo_blocked", { site_message: "Video geo-blocked" }),
    "not available in your country (Video geo-blocked); StreamFetch never bypasses " +
      "geo-restrictions",
  );
  assert.equal(
    render("rate_limited", { detail: "HTTP 429 on the manifest request" }),
    "the site is rate-limiting this session (HTTP 429 on the manifest request); the run stopped " +
      "and a 30-minute cooldown started",
  );
  assert.equal(
    render("blocked", { detail: "a verification page" }),
    "the site blocked the request (a verification page); the run stopped and a 30-minute " +
      "cooldown started",
  );
  assert.equal(render("stopped", { reason: "user" }), "not attempted: you pressed Stop");
  assert.equal(
    render("stopped", { reason: "consecutive_failures" }),
    "not attempted: 3 failures in a row stopped the run",
  );
  assert.equal(
    render("stopped", { reason: "cooldown until 19:30" }),
    "not attempted: cooldown until 19:30",
  );
  assert.equal(render("stopped"), "not attempted: no reason given");
  assert.equal(
    render("unsupported_link", { what: "playlist" }),
    "unsupported link: a playlist link: paste the link of one video",
  );
  assert.equal(
    render("unsupported_link", { what: "festival" }),
    "unsupported link: a festival page: paste the video's own link (…/video/BV…)",
  );
  assert.equal(
    render("premium_only", { labels: ["1080P60", "4K"] }),
    "only premium qualities exist for this video (1080P60, 4K) and this session is served none; " +
      "StreamFetch never bypasses a paywall",
  );
  assert.equal(
    render("unsupported_codec", { stream_type: 0x24 }),
    "the stream carries a codec StreamFetch cannot handle (MPEG-TS stream type 0x24)",
  );
  assert.equal(
    render("cooldown", { until: "19:30", minutes_left: 12, reason: "HTTP 412" }),
    "a cooldown is in force until 19:30 (12 min left) after the site refused a request " +
      "(HTTP 412); nothing is requested before then",
  );
  assert.equal(
    render("verify_failed", { reason: "duration 70 s, expected 106 s" }),
    "the finished file failed verification (duration 70 s, expected 106 s); it was not saved",
  );
  assert.equal(
    render("encrypted"),
    "encrypted media (DRM: encrypted tracks); StreamFetch never decrypts or keeps it",
  );
  assert.equal(
    render("encrypted", { detail: "pssh box" }),
    "encrypted media (DRM: pssh box); StreamFetch never decrypts or keeps it",
  );
  assert.equal(
    render("key_protected", { method: "AES-128" }),
    "the playlist is key-protected (EXT-X-KEY METHOD=AES-128); StreamFetch never decrypts it",
  );
  assert.equal(
    render("trial_only"),
    "Bilibili served only a trial clip (试看) to this session; it was not saved as the video",
  );
  assert.equal(
    render("deleted", { site_message: "-404" }),
    "the video is gone or not available to this session (-404)",
  );
  assert.equal(
    render("host_not_covered", { host: "cdn.example.net" }),
    "the media is on cdn.example.net, a host the extension has no permission for; it was not " +
      "requested",
  );
});

test("parameters as text: numbers, hex stream types, lists, defaults for junk", () => {
  assert.equal(paramText("stream_type", 36), "0x24");
  assert.equal(paramText("stream_type", 3), "0x03");
  assert.equal(paramText("stream_type", "0x81"), "0x81");
  assert.equal(paramText("labels", []), "none listed");
  assert.equal(paramText("labels", ["4K"]), "4K");
  assert.equal(paramText("status", ""), "?");
  assert.equal(paramText("status", 429), "429");
  assert.equal(paramText("count", Number.NaN), "?");
  assert.equal(paramText("detail", { a: 1 }), '{"a":1}');
  assert.equal(paramText("detail", true), "true");
  assert.equal(paramText("unknown_name", undefined), "?");
  assert.equal(paramText("what", null), "page or media");
});

test("failure records, the status a code gives, the stop reasons and the link refusals", () => {
  const params = { site_message: "-404" };
  const record = failure("deleted", params);
  assert.deepEqual(record, { code: "deleted", params: { site_message: "-404" } });
  params.site_message = "changed";
  assert.equal(record.params["site_message"], "-404"); // copied, never shared
  assert.deepEqual(failure("live_stream"), { code: "live_stream", params: {} });
  const unknownCode = /** @type {unknown} */ ("nope");
  const bad = /** @type {import("../src/lib/messages.js").FailureCode} */ (unknownCode);
  assert.throws(() => failure(bad), /unknown failure code "nope"/);
  assert.equal(statusForFailure("rate_limited"), "failed-rate-limited");
  assert.equal(statusForFailure("blocked"), "failed-blocked");
  assert.equal(statusForFailure("stopped"), "stopped");
  assert.equal(statusForFailure("cooldown"), "stopped");
  const unavailable = [
    "geo_blocked",
    "login_required",
    "premium_only",
    "supporter_only",
    "trial_only",
    "deleted",
    "interactive",
    "encrypted",
    "key_protected",
    "live_stream",
    "legacy_stream",
    "no_streams",
    "discontinuous_stream",
    "unsupported_link",
    "unsupported_codec",
  ];
  for (const code of unavailable) {
    assert.equal(statusForFailure(code), "failed-unavailable", code);
  }
  const plainFailures = [
    "http_status",
    "host_not_covered",
    "redirect_refused",
    "no_response",
    "truncated_body",
    "not_a_video",
    "verify_failed",
    "remux_failed",
    "save_failed",
    "corrupt_stream",
    "nonsense",
  ];
  for (const code of plainFailures) assert.equal(statusForFailure(code), "failed", code);
  assert.deepEqual(STOP_REASONS, [
    "user",
    "consecutive_failures",
    "rate_limited",
    "blocked",
    "login_required",
    "cooldown",
  ]);
  for (const reason of STOP_REASONS) {
    assert.ok(isStopReason(reason));
    assert.equal(stopReasonText(reason), STOP_REASON_TEXTS_EN[reason]);
    assert.ok(STOP_REASON_TEXTS_EN[reason].length > 10);
  }
  assert.equal(isStopReason("other"), false);
  assert.equal(stopReasonText("cooldown until 19:30"), "cooldown until 19:30");
  assert.deepEqual(LINK_REFUSALS, [
    "playlist",
    "bangumi",
    "space",
    "list",
    "audio",
    "live",
    "other-site",
    "unsupported-path",
    "junk",
    "festival",
  ]);
  for (const reason of LINK_REFUSALS) {
    assert.equal(refusalText(reason), LINK_REFUSAL_TEXTS_EN[reason]);
    assert.ok(LINK_REFUSAL_TEXTS_EN[reason].length >= 10, reason);
  }
  assert.equal(refusalText("mystery"), "mystery");
});

test("hints: premium, playlist ignored (A.8), login or premium (Bilibili.tv), parameters", () => {
  assert.deepEqual(HINT_CODES, ["premium", "playlist_ignored", "login_or_premium"]);
  assert.deepEqual(HINT_PARAMS, {
    premium: ["labels"],
    playlist_ignored: [],
    login_or_premium: [],
  });
  assert.equal(
    hintText("premium", { labels: ["1080P60", "4K"] }),
    "1080P60, 4K needs a premium membership",
  );
  assert.equal(hintText("premium"), "none listed needs a premium membership");
  assert.equal(hintText("playlist_ignored"), "playlist ignored: only this video is downloaded");
  assert.equal(
    hintText("login_or_premium"),
    "log in to Bilibili.tv in this browser; a premium episode stays unavailable",
  );
  assert.equal(hintText("mystery"), "mystery");
  assert.deepEqual(hintSubstitutions("premium", { labels: ["1080P+"] }), ["1080P+"]);
  assert.deepEqual(hintSubstitutions("playlist_ignored", { labels: ["x"] }), []);
  assert.deepEqual(hintSubstitutions("mystery"), []);
  assert.ok(isHintCode("premium") && !isHintCode("premium_only") && !isHintCode(1));
});

test("the hint and link-refusal texts are the English catalog's, the share-link advice too", () => {
  /** @type {Record<string, { message: string }>} */
  const english = JSON.parse(
    readFileSync(new URL("../_locales/en/messages.json", import.meta.url), "utf8"),
  );
  for (const code of HINT_CODES) {
    const values = HINT_PARAMS[code].map((name, index) => `<${name}:${index + 1}>`);
    const params = Object.fromEntries(
      HINT_PARAMS[code].map((name, index) => [name, values[index]]),
    );
    const message = english[`hint_${code}`]?.message ?? "";
    const shown = message.replace(/\$[A-Z_]+\$/g, () => String(values.shift()));
    assert.equal(shown, hintText(code, params), code);
  }
  for (const reason of LINK_REFUSALS) {
    const key = `refused_${reason.replace(/-/g, "_")}`;
    assert.equal(english[key]?.message, refusalText(reason), key);
  }
  assert.match(refusalText("other-site"), /Bilibili\.tv/);
  assert.match(refusalText("unsupported-path"), /bili\.im/);
});
