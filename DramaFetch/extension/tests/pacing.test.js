// @ts-check
// Unit tests of src/lib/pacing.js: the floors, the pauses, the long break, the stop rules.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BLOCK,
  COUNTED_FAILURES,
  JOB_REST,
  LONG_REST,
  NO_NETWORK,
  PACE,
  PACING_DEFAULTS,
  PacingState,
  REST,
  SERIES_REST,
  STOP,
  afterResult,
  defaultRng,
  describeBatchPacing,
  describePacing,
  longRestDue,
  nextPause,
  pacingOptions,
  pacingProblem,
  pagePause,
  pauseBeforeAttempt,
  pauseBetweenJobs,
  pauseBetweenSeries,
  pauseMessage,
  seededRng,
  validatePacing,
} from "../src/lib/pacing.js";

/** A random source that always draws `r`. @param {number} r */
const fixed = (r) => ({ uniform: (/** @type {number} */ low, /** @type {number} */ high) => low + (high - low) * r });

test("the Python defaults are floors: nothing lighter outside test mode, anything heavier", () => {
  assert.equal(pacingProblem(pacingOptions()), null);
  assert.equal(pacingProblem(pacingOptions({ delayMinS: 10, delayMaxS: 30, restEvery: 5, pace: "human" })), null);
  assert.match(String(pacingProblem(pacingOptions({ delayMinS: 2 }))), /^delay_min_s \(2\) must be at least 4/);
  assert.match(String(pacingProblem(pacingOptions({ restMaxS: 100 }))), /^rest_max_s \(100\) must be at least 120/);
  assert.match(String(pacingProblem(pacingOptions({ restEvery: 0 }))), /^rest_every \(0\) must be between 1 and 10/);
  assert.match(String(pacingProblem(pacingOptions({ restEvery: 20 }))), /^rest_every \(20\) must be between 1 and 10/);
  assert.match(String(pacingProblem(pacingOptions({ maxConsecutiveFailures: 0 }))), /^max_consecutive_failures/);
  assert.match(String(pacingProblem(pacingOptions({ longRestEvery: 500 }))), /^long_rest_every/);
  assert.match(String(pacingProblem(pacingOptions({ longRestMinS: 60 }))), /^long_rest_min_s/);
  assert.match(String(pacingProblem(pacingOptions({ delayMinS: Number.NaN }))), /must be a number/);
  assert.match(String(pacingProblem(pacingOptions({ delayMinS: 0, delayMaxS: 0 }), { testMode: true })), /^$|./);
  assert.equal(pacingProblem(pacingOptions({ delayMinS: 0, delayMaxS: 0, restMinS: 0, restMaxS: 0 }), { testMode: true }), null);
  assert.equal(pacingProblem(pacingOptions({ delayMinS: Number.NaN }), { testMode: true }), "delay_min_s must be a number");
  assert.equal(pacingProblem(pacingOptions({ pace: "slow" }), { testMode: true }), "unknown pace 'slow': expected one of fixed, human");
  assert.throws(() => validatePacing(pacingOptions({ delayMaxS: 1 })), /delay_max_s \(1\) must be >= delay_min_s \(4\)/);
  assert.deepEqual(Object.keys(PACING_DEFAULTS).length, 10);
});

test("the pause between episodes: none before the first, 4-9 s, a rest every 10, the human pace", () => {
  const options = pacingOptions();
  const pacing = new PacingState();
  assert.deepEqual(pauseBeforeAttempt(options, fixed(0.5), pacing, () => 0, 0, null), { kind: PACE, seconds: 0 });
  assert.deepEqual(pauseBeforeAttempt(options, fixed(0), pacing, () => 0, 1, null), { kind: PACE, seconds: 4 });
  assert.deepEqual(nextPause(options, fixed(1), 3, null), { kind: PACE, seconds: 9 });
  assert.deepEqual(nextPause(options, fixed(0.5), 10, null), { kind: REST, seconds: 90 });
  const human = pacingOptions({ pace: "human" });
  assert.deepEqual(nextPause(human, fixed(0.5), 1, { durationS: 92 }), { kind: PACE, seconds: 93.5 });
  assert.deepEqual(nextPause(human, fixed(0), 1, { durationS: null }), { kind: PACE, seconds: 4 });
  assert.deepEqual(nextPause(human, fixed(1), 1, { durationS: 400 }), { kind: PACE, seconds: 300 });
});

test("the long break every 100 network attempts of a run, and an idle gap that counts as one", () => {
  const options = pacingOptions();
  const pacing = new PacingState({ runAttempts: 100, lastNetworkAt: 1000, consecutiveFailures: 2 });
  assert.deepEqual(pauseBeforeAttempt(options, fixed(0), pacing, () => 1010, 0, null), { kind: LONG_REST, seconds: 900 });
  assert.equal(longRestDue(options, pacing, () => 1010), true);
  // an idle gap of 15 min is the break: the count and the failure streak start again
  assert.equal(longRestDue(options, pacing, () => 1900), false);
  assert.deepEqual([pacing.runAttempts, pacing.consecutiveFailures], [0, 0]);
  assert.equal(longRestDue(options, new PacingState(), () => 5), false);
});

test("between series: the series rest, or the long break when due; between jobs: the job rest", () => {
  const options = pacingOptions();
  assert.deepEqual(pauseBetweenSeries(options, fixed(0.25), new PacingState({ runAttempts: 7, lastNetworkAt: 0 }), () => 30), {
    kind: SERIES_REST,
    seconds: 75,
  });
  const due = new PacingState({ runAttempts: 200, lastNetworkAt: 0 });
  assert.deepEqual(pauseBetweenSeries(options, fixed(1), due, () => 30), { kind: LONG_REST, seconds: 1800 });
  assert.equal(due.runAttempts, 200); // the caller resets it once the break is slept
  const pacing = new PacingState({ runAttempts: 3, lastNetworkAt: 0 });
  assert.equal(pauseBetweenJobs(options, fixed(0), pacing, () => 500, { lastContactAt: null, batchJob: false }), null);
  assert.equal(pauseBetweenJobs(options, fixed(0), pacing, () => 500, { lastContactAt: 300, batchJob: false }), null);
  assert.deepEqual(pauseBetweenJobs(options, fixed(0), pacing, () => 500, { lastContactAt: 450, batchJob: true }), {
    kind: JOB_REST,
    seconds: 60,
  });
  const batchDue = new PacingState({ runAttempts: 100, lastNetworkAt: 490 });
  assert.equal(pauseBetweenJobs(options, fixed(0), batchDue, () => 500, { lastContactAt: 490, batchJob: true })?.kind, LONG_REST);
  assert.equal(pauseBetweenJobs(options, fixed(0), batchDue, () => 500, { lastContactAt: 490, batchJob: false })?.kind, JOB_REST);
});

test("the stop rules: 403 / 429 / login stop at once, three counted failures in a row, a done resets", () => {
  const options = pacingOptions();
  const pacing = new PacingState();
  const clock = () => 42;
  /** @param {number} number @param {string} status @param {string} [message] */
  const step = (number, status, message = "") => afterResult(options, pacing, clock, { episode: { number }, status, message });
  assert.deepEqual(step(1, "failed", "a"), { network: true, stop: null });
  assert.deepEqual(step(2, "skipped-locked"), { network: false, stop: null });
  assert.deepEqual(step(3, "failed-unavailable", "b"), { network: true, stop: null });
  assert.deepEqual(step(4, "failed", "c"), {
    network: true,
    stop: { status: "failed", reason: "3 consecutive failures (last: c)", summary: "3 consecutive failures", block: false },
  });
  assert.deepEqual([pacing.runAttempts, pacing.lastNetworkAt, pacing.consecutiveFailures], [3, 42, 3]);
  pacing.consecutiveFailures = 0;
  step(5, "failed", "x");
  step(6, "done", "ok");
  assert.equal(pacing.consecutiveFailures, 0);
  assert.deepEqual(step(7, "failed-rate-limited", "rate limited").stop, {
    status: "failed-rate-limited",
    reason: "episode 7 failed-rate-limited: rate limited",
    summary: "episode 7 failed-rate-limited",
    block: true,
  });
  assert.equal(step(8, "failed-login-required").stop?.block, false);
  assert.ok(STOP.has("failed-blocked") && BLOCK.has("failed-blocked") && !BLOCK.has("failed-login-required"));
  assert.ok(COUNTED_FAILURES.has("failed-unavailable") && NO_NETWORK.has("skipped-exists"));
});

test("the announcements and the pacing lines read like the Python CLI's", () => {
  assert.equal(pauseMessage(PACE, 6.5), "pausing 6 s");
  assert.equal(pauseMessage(PACE, 0.25), "pausing 0.2 s");
  assert.equal(pauseMessage(REST, 95.4, { downloads: 10 }), "resting 95 s after 10 downloads");
  assert.equal(pauseMessage(SERIES_REST, 95), "resting 95 s before the next series");
  assert.equal(pauseMessage(LONG_REST, 1320, { runAttempts: 100 }), "long break 22 min after 100 episodes");
  assert.equal(describePacing(), "4–9 s between episodes, 60–120 s rest every 10; stop after 3 failures / 403 / 429");
  assert.equal(describeBatchPacing(), "60–120 s rest between series, a 15–30 min break every 100 episodes");
});

test("the random sources: 0.8-1.6 s list pauses, seeded draws repeat, crypto draws stay in range", () => {
  const rng = seededRng(3);
  const again = seededRng(3);
  for (let i = 0; i < 200; i += 1) {
    const pause = pagePause(rng);
    assert.ok(pause >= 0.8 && pause <= 1.6, String(pause));
    assert.equal(pagePause(again), pause);
    const draw = defaultRng.uniform(4, 9);
    assert.ok(draw >= 4 && draw < 9, String(draw));
  }
});
