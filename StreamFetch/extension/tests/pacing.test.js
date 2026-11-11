// @ts-check
// Unit tests of src/lib/pacing.js: the floors, every pacingProblem case, the draws, the deadline
// sleep, the stop rules and the pacing line.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COOLDOWN_MINUTES,
  COUNTED_FAILURES,
  MAX_CONSECUTIVE_FAILURES,
  MAX_PAUSE_S,
  MAX_RETRIES,
  MAX_TIMER_MS,
  MEDIA_PAUSE_MS,
  NO_NETWORK_STATUSES,
  PACING_DEFAULTS,
  PAGE_PAUSE_S,
  RETRY_BACKOFF_S,
  STALL_TIMEOUT_S,
  STOP_STATUSES,
  VIDEO_PAUSE_S,
  afterResult,
  defaultRng,
  describePacing,
  formatRange,
  isRange,
  mediaPauseMs,
  pacingProblem,
  pacingSettings,
  pagePauseS,
  retryBackoffS,
  seededRng,
  sleepMs,
  sleepSeconds,
  stallTimeoutS,
  uniform,
  validatePacing,
  videoPauseS,
} from "../src/lib/pacing.js";

/** A random source that always draws `r`. @param {number} r */
const fixed = (r) => () => r;

test("the floors of the spec, and the default settings built from them", () => {
  assert.deepEqual(VIDEO_PAUSE_S, [3, 6]);
  assert.deepEqual(PAGE_PAUSE_S, [1, 2]);
  assert.deepEqual(MEDIA_PAUSE_MS, [100, 300]);
  assert.equal(MAX_RETRIES, 3);
  assert.deepEqual(RETRY_BACKOFF_S, [1, 2, 4]);
  assert.equal(STALL_TIMEOUT_S, 30);
  assert.equal(MAX_CONSECUTIVE_FAILURES, 3);
  assert.equal(COOLDOWN_MINUTES, 30);
  assert.equal(MAX_PAUSE_S, 86400);
  assert.equal(MAX_TIMER_MS, 2147483647);
  const defaults = { videoPauseS: [3, 6], pagePauseS: [1, 2], mediaPauseMs: [100, 300] };
  assert.deepEqual(PACING_DEFAULTS, defaults);
  assert.deepEqual(pacingSettings(), defaults);
  assert.deepEqual(pacingSettings({ videoPauseS: [10, 20], stallTimeoutS: 5 }), {
    videoPauseS: [10, 20],
    pagePauseS: [1, 2],
    mediaPauseMs: [100, 300],
    stallTimeoutS: 5,
  });
  assert.ok(Object.isFrozen(VIDEO_PAUSE_S) && Object.isFrozen(PACING_DEFAULTS));
});

test("pacingProblem: nothing lighter than a floor outside test mode, anything heavier", () => {
  assert.equal(pacingProblem(pacingSettings()), null);
  assert.equal(
    pacingProblem(
      pacingSettings({ videoPauseS: [10, 30], pagePauseS: [1, 5], mediaPauseMs: [100, 1000] }),
    ),
    null,
  );
  assert.equal(
    pacingProblem(pacingSettings({ videoPauseS: [2, 6] })),
    "the pause between videos: the minimum (2 s) must be at least 3 s — pauses may only be " +
      "made longer",
  );
  assert.equal(
    pacingProblem(pacingSettings({ videoPauseS: [5, 5] })),
    "the pause between videos: the maximum (5 s) must be at least 6 s — pauses may only be " +
      "made longer",
  );
  assert.equal(
    pacingProblem(pacingSettings({ pagePauseS: [0.5, 2] })),
    "the pause between page requests: the minimum (0.5 s) must be at least 1 s — pauses may " +
      "only be made longer",
  );
  assert.equal(
    pacingProblem(pacingSettings({ pagePauseS: [1, 1.5] })),
    "the pause between page requests: the maximum (1.5 s) must be at least 2 s — pauses may " +
      "only be made longer",
  );
  assert.equal(
    pacingProblem(pacingSettings({ mediaPauseMs: [50, 300] })),
    "the pause between media requests: the minimum (50 ms) must be at least 100 ms — pauses " +
      "may only be made longer",
  );
  assert.equal(
    pacingProblem(pacingSettings({ mediaPauseMs: [100, 200] })),
    "the pause between media requests: the maximum (200 ms) must be at least 300 ms — pauses " +
      "may only be made longer",
  );
  // test mode may lower them: only the structural checks remain
  const light = pacingSettings({
    videoPauseS: [0, 0],
    pagePauseS: [0, 0],
    mediaPauseMs: [0, 0],
    stallTimeoutS: 2,
  });
  assert.equal(pacingProblem(light, true), null);
  assert.match(
    String(pacingProblem(light)),
    /^the pause between videos: the minimum \(0 s\) must be at least 3 s/,
  );
  assert.equal(pacingProblem(pacingSettings({ videoPauseS: [MAX_PAUSE_S, MAX_PAUSE_S] })), null);
  assert.throws(
    () => validatePacing(pacingSettings({ videoPauseS: [1, 6] })),
    /must be at least 3 s/,
  );
  assert.doesNotThrow(() => validatePacing(pacingSettings({ videoPauseS: [1, 6] }), true));
});

test("pacingProblem: the structural checks hold in any mode", () => {
  for (const testMode of [false, true]) {
    const mode = testMode ? "test mode" : "normal mode";
    assert.equal(
      pacingProblem({ pagePauseS: [1, 2], mediaPauseMs: [100, 300] }, testMode),
      "the pause between videos must be two numbers: a minimum and a maximum in s",
      mode,
    );
    assert.equal(
      pacingProblem({ ...pacingSettings(), pagePauseS: [1] }, testMode),
      "the pause between page requests must be two numbers: a minimum and a maximum in s",
      mode,
    );
    assert.equal(
      pacingProblem({ ...pacingSettings(), mediaPauseMs: ["100", 300] }, testMode),
      "the pause between media requests must be two numbers: a minimum and a maximum in ms",
      mode,
    );
    assert.equal(
      pacingProblem({ ...pacingSettings(), videoPauseS: [Number.NaN, 6] }, testMode),
      "the pause between videos must be two numbers: a minimum and a maximum in s",
      mode,
    );
    assert.equal(
      pacingProblem({ ...pacingSettings(), videoPauseS: [-1, 6] }, testMode),
      "the pause between videos must not be negative (got -1 and 6 s)",
      mode,
    );
    assert.equal(
      pacingProblem({ ...pacingSettings(), videoPauseS: [6, 3] }, testMode),
      "the pause between videos: the maximum (3 s) must be at least the minimum (6 s)",
      mode,
    );
    assert.equal(
      pacingProblem({ ...pacingSettings(), videoPauseS: [3, 100000] }, testMode),
      "the pause between videos: the maximum (100000 s) must be at most 86400 s (one day)",
      mode,
    );
    assert.equal(
      pacingProblem({ ...pacingSettings(), mediaPauseMs: [100, 86400001] }, testMode),
      "the pause between media requests: the maximum (86400001 ms) must be at most 86400000 ms " +
        "(one day)",
      mode,
    );
    assert.equal(
      pacingProblem({ ...pacingSettings(), stallTimeoutS: 0 }, testMode),
      "the stall timeout must be a positive number of seconds",
      mode,
    );
    assert.equal(
      pacingProblem({ ...pacingSettings(), stallTimeoutS: "30" }, testMode),
      "the stall timeout must be a positive number of seconds",
      mode,
    );
    assert.equal(
      pacingProblem({ ...pacingSettings(), stallTimeoutS: 90000 }, testMode),
      "the stall timeout (90000 s) must be at most 86400 s (one day)",
      mode,
    );
    assert.equal(pacingProblem({ ...pacingSettings(), stallTimeoutS: 30 }, testMode), null, mode);
  }
  assert.ok(isRange([1, 2]));
  assert.ok(!isRange([1]) && !isRange([1, "2"]) && !isRange(null) && !isRange([1, Infinity]));
});

test("the draws: uniform in range, pauses from the settings, backoff, stall timeout", () => {
  assert.equal(uniform(fixed(0), [3, 6]), 3);
  assert.equal(uniform(fixed(0.5), [3, 6]), 4.5);
  assert.ok(Math.abs(uniform(fixed(0.999), [3, 6]) - 5.997) < 1e-9);
  const settings = pacingSettings({
    videoPauseS: [4, 8],
    pagePauseS: [1, 3],
    mediaPauseMs: [100, 500],
  });
  assert.equal(videoPauseS(settings, fixed(0.25)), 5);
  assert.equal(pagePauseS(settings, fixed(0.5)), 2);
  assert.equal(mediaPauseMs(settings, fixed(1)), 500);
  const drawn = videoPauseS(settings);
  assert.ok(drawn >= 4 && drawn < 8, String(drawn));
  assert.deepEqual([retryBackoffS(1), retryBackoffS(2), retryBackoffS(3)], [1, 2, 4]);
  assert.deepEqual([retryBackoffS(4), retryBackoffS(0), retryBackoffS(2.7)], [4, 1, 2]);
  // never below the floor outside test mode
  assert.equal(stallTimeoutS(pacingSettings({ stallTimeoutS: 2 })), 30);
  assert.equal(stallTimeoutS(pacingSettings({ stallTimeoutS: 2 }), true), 2);
  assert.equal(stallTimeoutS(pacingSettings(), true), 30);
  assert.equal(stallTimeoutS(pacingSettings({ stallTimeoutS: -1 }), true), 30);
});

test("the random sources: seeded draws repeat, crypto draws stay in [0, 1)", () => {
  const rng = seededRng(7);
  const again = seededRng(7);
  const other = seededRng(8);
  let differs = false;
  for (let i = 0; i < 200; i += 1) {
    const draw = rng();
    assert.ok(draw >= 0 && draw < 1, String(draw));
    assert.equal(again(), draw);
    if (other() !== draw) differs = true;
    const crypto = defaultRng();
    assert.ok(crypto >= 0 && crypto < 1, String(crypto));
  }
  assert.ok(differs);
});

/**
 * Fake timers for {@link sleepSeconds}: `run()` fires the pending timer, `ms` lists every delay
 * asked for; the clock moves exactly by each delay unless `late` adds to it.
 * @param {{late?: number}} [options]
 */
function fakeTimers(options = {}) {
  let clock = 1_000_000;
  /** @type {{callback: () => void, ms: number} | null} */
  let pending = null;
  /** @type {number[]} */
  const ms = [];
  return {
    ms,
    now: () => clock,
    /** @param {() => void} callback @param {number} delay */
    setTimer: (callback, delay) => {
      ms.push(delay);
      pending = { callback, ms: delay };
      return ms.length;
    },
    clearTimer: () => {
      pending = null;
    },
    run() {
      const timer = pending;
      if (timer === null) return false;
      pending = null;
      clock += timer.ms + (options.late ?? 0);
      timer.callback();
      return true;
    },
  };
}

test("sleepSeconds: timer-sized pieces up to the deadline, never shorter", async () => {
  const timers = fakeTimers();
  let done = false;
  const sleeping = sleepSeconds(4294967.5, timers).then(() => {
    done = true;
  });
  while (timers.run()) await Promise.resolve();
  await sleeping;
  assert.equal(done, true);
  assert.deepEqual(timers.ms, [MAX_TIMER_MS, MAX_TIMER_MS, 4294967500 - 2 * MAX_TIMER_MS]);
  assert.ok(timers.ms.every((delay) => delay > 0 && delay <= MAX_TIMER_MS));
  // a late timer only makes the pause longer: nothing is re-armed to catch up
  const late = fakeTimers({ late: 500 });
  const short = sleepSeconds(2, late);
  while (late.run()) await Promise.resolve();
  await short;
  assert.deepEqual(late.ms, [2000]);
  // nothing to sleep still waits for one timer turn; junk sleeps 0 s
  const zero = fakeTimers();
  const none = sleepSeconds(Number.NaN, zero);
  assert.equal(zero.run(), true);
  await none;
  assert.deepEqual(zero.ms, [0]);
  const negative = fakeTimers();
  const nothing = sleepSeconds(-5, negative);
  negative.run();
  await nothing;
  assert.deepEqual(negative.ms, [0]);
  // milliseconds
  const millis = fakeTimers();
  const pause = sleepMs(250, millis);
  while (millis.run()) await Promise.resolve();
  await pause;
  assert.deepEqual(millis.ms, [250]);
});

test("sleepSeconds: an abort ends the pause at once, as options or as a bare signal", async () => {
  const timers = fakeTimers();
  const controller = new AbortController();
  const sleeping = sleepSeconds(90, { ...timers, signal: controller.signal });
  controller.abort(new Error("stopped by you"));
  await assert.rejects(sleeping, /stopped by you/);
  assert.equal(timers.run(), false); // the timer was cleared
  await assert.rejects(
    sleepSeconds(1, { ...fakeTimers(), signal: controller.signal }),
    /stopped by you/,
  );
  // the spec's shape: sleepSeconds(seconds, signal)
  await assert.rejects(sleepSeconds(1, controller.signal), /stopped by you/);
  const live = new AbortController();
  const quick = sleepSeconds(0.001, live.signal);
  await quick; // a real timer of 1 ms; resolves
  live.abort();
});

test("afterResult: refusals stop with the cooldown, a login without, 3 failures in a row", () => {
  const counters = { consecutiveFailures: 0 };
  assert.deepEqual(afterResult(counters, "failed", "http_status"), { network: true, stop: null });
  assert.deepEqual(afterResult(counters, "skipped-exists"), { network: false, stop: null });
  assert.deepEqual(afterResult(counters, "failed-unavailable", "geo_blocked"), {
    network: true,
    stop: null,
  });
  assert.deepEqual(afterResult(counters, "failed", "truncated_body"), {
    network: true,
    stop: { reason: "consecutive_failures", cooldown: false },
  });
  assert.equal(counters.consecutiveFailures, 3);
  counters.consecutiveFailures = 0;
  afterResult(counters, "failed", "no_response");
  assert.equal(counters.consecutiveFailures, 1);
  afterResult(counters, "done");
  assert.equal(counters.consecutiveFailures, 0);
  assert.deepEqual(afterResult(counters, "failed-rate-limited", "rate_limited").stop, {
    reason: "rate_limited",
    cooldown: true,
  });
  assert.deepEqual(afterResult(counters, "failed-blocked", "blocked").stop, {
    reason: "blocked",
    cooldown: true,
  });
  assert.deepEqual(afterResult(counters, "failed-unavailable", "login_required").stop, {
    reason: "login_required",
    cooldown: false,
  });
  assert.equal(counters.consecutiveFailures, 0); // a stop counts nothing
  assert.ok(STOP_STATUSES.has("failed-blocked") && STOP_STATUSES.has("failed-rate-limited"));
  assert.ok(COUNTED_FAILURES.has("failed") && COUNTED_FAILURES.has("failed-unavailable"));
  assert.ok(NO_NETWORK_STATUSES.has("skipped-exists") && !NO_NETWORK_STATUSES.has("done"));
});

test("the pacing line reads like the README's", () => {
  assert.equal(
    describePacing(),
    "3–6 s between videos, 1–2 s between page requests, 100–300 ms between media requests; " +
      "3 retries (1, 2, 4 s back-off), 30 s stall timeout; stop after 3 failures in a row or any " +
      "429 / 412 / 403, then a 30 min cooldown",
  );
  assert.equal(formatRange([5, 5], "s"), "5 s");
  assert.equal(formatRange([100, 300], "ms"), "100–300 ms");
  const testLine = describePacing(pacingSettings({ stallTimeoutS: 2 }), true);
  assert.ok(testLine.includes("2 s stall timeout"));
  assert.ok(describePacing(pacingSettings({ stallTimeoutS: 2 })).includes("30 s stall timeout"));
});
