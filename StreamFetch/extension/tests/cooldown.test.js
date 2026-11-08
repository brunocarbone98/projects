// @ts-check
// Unit tests of src/lib/cooldown.js: the 30-minute window, its activity, the message parameters.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COOLDOWN_MINUTES,
  COOLDOWN_SOURCES,
  COOLDOWN_STORAGE_KEY,
  MAX_REASON_LEN,
  activeCooldown,
  cleanReason,
  clockTime,
  cooldownFailure,
  cooldownMessageParams,
  cooldownStopReason,
  cooldownSummary,
  isActive,
  makeCooldown,
  minutesLeft,
  parseCooldown,
  secondsLeft,
  startedAt,
} from "../src/lib/cooldown.js";
import { render } from "../src/lib/messages.js";

/** A moment in milliseconds since the epoch. */
const NOW = 1_762_600_000_000;
const HALF_HOUR = 30 * 60_000;

test("a refusal starts a 30-minute window; activeCooldown(now, stored) reads the record", () => {
  const reason =
    "the site is rate-limiting this session (HTTP 429 on the manifest request); the run stopped";
  const cooldown = makeCooldown(reason, "bilibili", { now: NOW });
  assert.deepEqual(cooldown, {
    until: NOW + HALF_HOUR,
    reason,
    source: "bilibili",
    recordedAt: NOW,
  });
  assert.deepEqual(activeCooldown(NOW, cooldown), cooldown);
  assert.deepEqual(activeCooldown(NOW + HALF_HOUR - 1, cooldown), cooldown);
  assert.equal(activeCooldown(NOW + HALF_HOUR, cooldown), null);
  assert.equal(activeCooldown(NOW, undefined), null);
  assert.equal(activeCooldown(NOW, null), null);
  assert.equal(isActive(cooldown, NOW), true);
  assert.equal(isActive(cooldown, NOW + 2 * HALF_HOUR), false);
  assert.equal(makeCooldown("x", "test", { now: NOW, minutes: 1 }).until, NOW + 60_000);
  // the record round-trips through JSON, as chrome.storage.local keeps it
  assert.deepEqual(parseCooldown(JSON.parse(JSON.stringify(cooldown))), cooldown);
  const fresh = makeCooldown("x", "dailymotion");
  assert.ok(fresh.recordedAt !== null && Math.abs(fresh.recordedAt - Date.now()) < 5_000);
  assert.equal(fresh.until - /** @type {number} */ (fresh.recordedAt), HALF_HOUR);
});

test("minutes left round up; the message params, the failure, the stop reason, the summary", () => {
  const cooldown = makeCooldown("HTTP 412", "bilibili", { now: NOW });
  assert.equal(secondsLeft(cooldown, NOW + 500), 1800);
  assert.equal(secondsLeft(cooldown, NOW + 5_000_000), 0);
  assert.equal(minutesLeft(cooldown, NOW + 61_000), 29);
  assert.equal(minutesLeft(cooldown, NOW + HALF_HOUR - 500), 1);
  assert.equal(minutesLeft(cooldown, NOW + 5_000_000), 0);
  const until = clockTime(cooldown.until);
  assert.match(until, /^[0-2][0-9]:[0-5][0-9]$/);
  assert.deepEqual(cooldownMessageParams(cooldown, NOW), {
    until,
    minutes_left: 30,
    reason: "HTTP 412",
    source: "bilibili",
  });
  assert.equal(cooldownMessageParams(cooldown, NOW + HALF_HOUR), null);
  assert.equal(cooldownMessageParams(undefined, NOW), null);
  const failure = cooldownFailure(cooldown, NOW + 60_000);
  assert.deepEqual(failure, {
    code: "cooldown",
    params: { until, minutes_left: 29, reason: "HTTP 412", source: "bilibili" },
  });
  assert.equal(
    render("cooldown", failure?.params),
    `a cooldown is in force until ${until} (29 min left) after the site refused a request ` +
      "(HTTP 412); nothing is requested before then",
  );
  assert.equal(cooldownFailure(undefined, NOW), null);
  assert.equal(cooldownStopReason(cooldown), `cooldown until ${until}`);
  assert.equal(cooldownSummary(cooldown, NOW), `until ${until} (30 min left): HTTP 412`);
  assert.equal(startedAt(cooldown), NOW);
  const byHand = { until: NOW + HALF_HOUR, reason: "", source: "", recordedAt: null };
  assert.equal(startedAt(byHand), NOW);
  assert.equal(clockTime(new Date(2026, 10, 8, 9, 5).getTime()), "09:05");
  assert.equal(clockTime(new Date(2026, 10, 8, 23, 59, 59).getTime()), "23:59");
});

test("reasons are collapsed and cut at 200 characters; a corrupt record is no cooldown", () => {
  assert.equal(makeCooldown("", "test").reason, "request refused");
  const messy = makeCooldown("  HTTP 429\n  on the\tmanifest ", "test");
  assert.equal(messy.reason, "HTTP 429 on the manifest");
  const long = makeCooldown("x".repeat(500), "test").reason;
  assert.equal([...long].length, MAX_REASON_LEN);
  assert.ok(long.endsWith("…"));
  assert.equal(cleanReason(undefined), "request refused");
  assert.equal(cleanReason("ok"), "ok");
  const corrupt = [
    null,
    "x",
    [],
    {},
    { until: "soon" },
    { until: true },
    { until: Number.NaN },
    42,
  ];
  for (const raw of corrupt) {
    assert.equal(parseCooldown(raw), null, JSON.stringify(raw));
  }
  assert.deepEqual(parseCooldown({ until: 5, reason: 7, source: null, recordedAt: false }), {
    until: 5,
    reason: "",
    source: "",
    recordedAt: null,
  });
  assert.equal(cooldownMessageParams({ until: NOW + 60_000 }, NOW)?.reason, "request refused");
  assert.equal(COOLDOWN_MINUTES, 30);
  assert.equal(COOLDOWN_STORAGE_KEY, "cooldown");
  assert.ok(COOLDOWN_SOURCES.includes("dailymotion") && COOLDOWN_SOURCES.includes("bilibili"));
});
