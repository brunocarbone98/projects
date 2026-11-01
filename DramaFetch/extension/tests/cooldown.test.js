// @ts-check
// Unit tests of src/lib/cooldown.js over an in-memory store.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COOLDOWN_MINUTES,
  EXTENSION_LIFT_TEXT,
  activeCooldown,
  clearCooldown,
  clockTime,
  cooldownMessage,
  cooldownStopReason,
  cooldownSummary,
  isActive,
  makeCooldown,
  minutesLeft,
  parseCooldown,
  readCooldown,
  recordBlock,
  secondsLeft,
  storageAreaStore,
} from "../src/lib/cooldown.js";

/** An in-memory CooldownStore. */
function memoryStore() {
  /** @type {{value: unknown}} */
  const box = { value: undefined };
  return {
    box,
    read: () => box.value,
    /** @param {Record<string, unknown>} record */
    write: (record) => {
      box.value = structuredClone(record);
    },
    remove: () => {
      box.value = undefined;
    },
  };
}

const NOW = 1761200000;

test("a refusal starts a 30-minute window that every action asks about", async () => {
  const store = memoryStore();
  assert.equal(COOLDOWN_MINUTES, 30);
  assert.equal(await activeCooldown(store, { now: NOW }), null);
  const recorded = await recordBlock(store, "episode 2 failed-blocked:\n  blocked (HTTP 403)", "browser", { now: NOW });
  assert.deepEqual(recorded, { until: NOW + 1800, reason: "episode 2 failed-blocked: blocked (HTTP 403)", source: "browser", recordedAt: NOW });
  assert.deepEqual(store.box.value, { until: NOW + 1800, reason: recorded.reason, source: "browser", recorded_at: NOW });
  assert.deepEqual(await activeCooldown(store, { now: NOW + 1799 }), recorded);
  assert.equal(await activeCooldown(store, { now: NOW + 1800 }), null);
  assert.deepEqual(await readCooldown(store), recorded); // expired, still readable
  await clearCooldown(store);
  assert.equal(await readCooldown(store), null);
});

test("the minutes left round up; the texts name the reason and when it ends", () => {
  const { cooldown } = makeCooldown("rate limited", "discovery", { now: NOW });
  assert.equal(secondsLeft(cooldown, NOW + 0.5), 1800);
  assert.equal(minutesLeft(cooldown, NOW + 61), 29);
  assert.equal(minutesLeft(cooldown, NOW + 1799.5), 1);
  assert.equal(minutesLeft(cooldown, NOW + 5000), 0);
  assert.equal(isActive(cooldown, NOW), true);
  const until = clockTime(NOW + 1800);
  assert.match(until, /^[0-2][0-9]:[0-5][0-9]$/);
  assert.equal(cooldownSummary(cooldown, { now: NOW }), `until ${until} (30 min left): rate limited`);
  assert.equal(
    cooldownMessage(cooldown, { now: NOW }),
    `TikTok refused a request at ${clockTime(NOW)} (rate limited); DramaFetch waits until ${until} (30 min left) ` +
      `before contacting TikTok again — ${EXTENSION_LIFT_TEXT}`,
  );
  assert.equal(cooldownStopReason(cooldown), `cooldown until ${until}`);
});

test("reasons are collapsed and cut at 200 characters; a corrupt record is no cooldown", async () => {
  assert.equal(makeCooldown("", "web").cooldown.reason, "request refused");
  const long = makeCooldown("x".repeat(500), "web").cooldown.reason;
  assert.equal([...long].length, 200);
  assert.ok(long.endsWith("…"));
  for (const raw of [null, "x", [], {}, { until: "soon" }, { until: true }, { until: Number.NaN }]) {
    assert.equal(parseCooldown(raw), null);
  }
  assert.deepEqual(parseCooldown({ until: 5, reason: 7, source: null, recorded_at: false }), {
    until: 5,
    reason: "",
    source: "",
    recordedAt: null,
  });
  const broken = { read: () => Promise.reject(new Error("storage gone")), write: () => undefined };
  assert.equal(await readCooldown(broken), null);
  /** @type {unknown[]} */
  const errors = [];
  const unwritable = { read: () => undefined, write: () => Promise.reject(new Error("quota")) };
  const recorded = await recordBlock(unwritable, "blocked", "browser", { now: NOW, onError: (error) => errors.push(error) });
  assert.equal(recorded.until, NOW + 1800);
  assert.equal(errors.length, 1);
});

test("the chrome.storage.local adapter reads and writes one key", async () => {
  /** @type {Record<string, unknown>} */
  const data = {};
  const area = {
    get: async (/** @type {string} */ key) => (Object.hasOwn(data, key) ? { [key]: data[key] } : {}),
    set: async (/** @type {Record<string, unknown>} */ items) => {
      Object.assign(data, items);
    },
    remove: async (/** @type {string} */ key) => {
      delete data[key];
    },
  };
  const store = storageAreaStore(area);
  await recordBlock(store, "blocked", "browser", { now: NOW });
  assert.deepEqual(Object.keys(data), ["cooldown"]);
  assert.equal((await activeCooldown(store, { now: NOW + 10 }))?.reason, "blocked");
  await clearCooldown(store);
  assert.deepEqual(data, {});
});
