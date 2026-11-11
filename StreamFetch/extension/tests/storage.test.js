// @ts-check
// app/storage.js over a fake chrome.storage.local: the settings never lighter than the floors
// outside test mode, the test settings honoured only in the test copy, the cooldown only ever
// lengthened by the extension, the history cut to 20 runs and 1 MiB.
import assert from "node:assert/strict";
import { test } from "node:test";

import { makeCooldown } from "../src/lib/cooldown.js";
import { PACING_DEFAULTS } from "../src/lib/pacing.js";
import {
  COOLDOWN_STORAGE_KEY,
  DEFAULT_SETTINGS,
  HISTORY_KEY,
  HISTORY_LIMIT,
  SETTINGS_KEY,
  TEST_SETTINGS_KEY,
  appendHistory,
  clearCooldown,
  copySettings,
  effectivePacing,
  isTestMode,
  loadActiveCooldown,
  loadSettings,
  loadTestSettings,
  maxHeightOf,
  normalizeSettings,
  parseTestSettings,
  readHistory,
  saveSettings,
  saveTestSettings,
  settingsProblem,
  trimHistory,
  writeCooldown,
} from "../src/app/storage.js";

/**
 * A fake `chrome` with `storage.local` in memory and the manifest's test flag.
 * @param {{ testMode?: boolean, stored?: Record<string, unknown> }} [options]
 * @returns {Map<string, unknown>}
 */
function installChrome(options = {}) {
  const local = new Map(Object.entries(options.stored ?? {}));
  const fake = {
    runtime: {
      getManifest: () => ({
        manifest_version: 3,
        name: "x",
        version: "1.0.0",
        ...(options.testMode ? { streamfetch_test: true } : {}),
      }),
    },
    storage: {
      local: {
        /** @param {string | string[]} keys */
        get: async (keys) => {
          /** @type {Record<string, unknown>} */
          const found = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (local.has(key)) found[key] = structuredClone(local.get(key));
          }
          return found;
        },
        /** @param {Record<string, unknown>} items */
        set: async (items) => {
          for (const [key, value] of Object.entries(items)) local.set(key, structuredClone(value));
        },
        /** @param {string | string[]} keys */
        remove: async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) local.delete(key);
        },
      },
    },
  };
  Object.assign(globalThis, { chrome: fake });
  return local;
}

test("the defaults: best quality, compatible codec, the pacing floors, the report on, covers embedded", () => {
  assert.equal(DEFAULT_SETTINGS.quality, "best");
  assert.equal(DEFAULT_SETTINGS.codec, "compatible");
  assert.equal(DEFAULT_SETTINGS.cover, "embed");
  assert.deepEqual(DEFAULT_SETTINGS.videoPauseS, [...PACING_DEFAULTS.videoPauseS]);
  assert.deepEqual(DEFAULT_SETTINGS.pagePauseS, [...PACING_DEFAULTS.pagePauseS]);
  assert.deepEqual(DEFAULT_SETTINGS.mediaPauseMs, [...PACING_DEFAULTS.mediaPauseMs]);
  assert.equal(DEFAULT_SETTINGS.report, true);
  assert.equal(DEFAULT_SETTINGS.language, "auto");
  assert.equal(settingsProblem({ ...DEFAULT_SETTINGS }, false), null);
  assert.equal(maxHeightOf("best"), null);
  assert.equal(maxHeightOf("720"), 720);
});

test("settingsProblem: unknown values refused; pauses below the floors only in test mode", () => {
  const base = copySettings(DEFAULT_SETTINGS);
  assert.equal(settingsProblem({ ...base, quality: "4k" }, false), "unknown quality");
  assert.equal(settingsProblem({ ...base, codec: "av1" }, false), "unknown codec preference");
  assert.equal(settingsProblem({ ...base, language: "fr" }, false), "unknown language");
  assert.equal(settingsProblem({ ...base, cover: "thumbnail" }, false), "unknown cover choice");
  assert.equal(settingsProblem({ ...base, cover: "none" }, false), null);
  assert.equal(settingsProblem({ ...base, report: "yes" }, false), "the report switch must be on or off");
  const lighter = { ...base, videoPauseS: [1, 2] };
  assert.match(String(settingsProblem(lighter, false)), /pauses may only be made longer/);
  assert.equal(settingsProblem(lighter, true), null);
  assert.equal(settingsProblem({ ...base, videoPauseS: [10, 20], mediaPauseMs: [500, 900] }, false), null);
  assert.match(String(settingsProblem({ ...base, pagePauseS: [5, 2] }, false)), /at least the minimum/);
});

test("normalizeSettings keeps what validates and never a pause below the floor", () => {
  const stored = { quality: "720", codec: "best", videoPauseS: [0, 0], report: false, cover: "none", junk: 1 };
  const settings = normalizeSettings(stored, false);
  assert.equal(settings.quality, "720");
  assert.equal(settings.cover, "none");
  assert.equal(normalizeSettings({ cover: 7 }, false).cover, "embed", "a bad cover choice keeps the default");
  assert.equal(settings.codec, "best");
  assert.equal(settings.report, false);
  assert.deepEqual(settings.videoPauseS, [3, 6], "the lighter pause is dropped");
  assert.equal(Object.hasOwn(settings, "junk"), false);
  assert.deepEqual(normalizeSettings(null, false), copySettings(DEFAULT_SETTINGS));
  assert.deepEqual(normalizeSettings({ videoPauseS: [0, 0] }, true).videoPauseS, [0, 0]);
});

test("loadSettings / saveSettings through chrome.storage.local; a refused save stores nothing", async () => {
  const local = installChrome();
  assert.deepEqual(await loadSettings(), copySettings(DEFAULT_SETTINGS));
  const settings = { ...copySettings(DEFAULT_SETTINGS), quality: /** @type {const} */ ("480") };
  await saveSettings(settings);
  assert.equal(/** @type {{ quality: string }} */ (local.get(SETTINGS_KEY)).quality, "480");
  assert.equal((await loadSettings()).quality, "480");
  await assert.rejects(
    saveSettings({ ...settings, mediaPauseMs: [0, 0] }),
    /pauses may only be made longer/,
  );
  assert.deepEqual(/** @type {{ mediaPauseMs: number[] }} */ (local.get(SETTINGS_KEY)).mediaPauseMs, [100, 300]);
});

test("the test settings exist only in the test copy (streamfetch_test)", async () => {
  installChrome({ stored: { [TEST_SETTINGS_KEY]: { baseUrls: { dailymotion: "http://127.0.0.1:9/dm" } } } });
  assert.equal(isTestMode(), false);
  assert.deepEqual(await loadTestSettings(), {});
  await assert.rejects(saveTestSettings({ videoPauseS: [0, 0] }), /test harness/);
  const local = installChrome({ testMode: true });
  assert.equal(isTestMode(), true);
  const saved = await saveTestSettings({
    baseUrls: { dailymotion: "http://127.0.0.1:8123/dm/", bilibili: "ftp://x", bogus: "http://a" },
    videoPauseS: [0, 0.1],
    pagePauseS: [2, 1],
    stallTimeoutS: 2,
    existenceRateLimitS: 0,
  });
  assert.deepEqual(saved, {
    baseUrls: { dailymotion: "http://127.0.0.1:8123/dm" },
    videoPauseS: [0, 0.1],
    stallTimeoutS: 2,
    existenceRateLimitS: 0,
  });
  assert.deepEqual(local.get(TEST_SETTINGS_KEY), saved);
  assert.deepEqual(await loadTestSettings(), saved);
  assert.deepEqual(parseTestSettings("junk"), {});
});

test("effectivePacing: the test pauses and stall timeout only in test mode", () => {
  const settings = copySettings(DEFAULT_SETTINGS);
  const test = { videoPauseS: /** @type {[number, number]} */ ([0, 0]), stallTimeoutS: 2 };
  assert.deepEqual(effectivePacing(settings, test, false), {
    videoPauseS: [3, 6],
    pagePauseS: [1, 2],
    mediaPauseMs: [100, 300],
  });
  assert.deepEqual(effectivePacing(settings, test, true), {
    videoPauseS: [0, 0],
    pagePauseS: [1, 2],
    mediaPauseMs: [100, 300],
    stallTimeoutS: 2,
  });
});

test("the cooldown: read when active, only ever lengthened, deleted only on request", async () => {
  const local = installChrome();
  assert.equal(await loadActiveCooldown(), null);
  const now = Date.now();
  const long = makeCooldown("HTTP 429", "dailymotion", { now, minutes: 30 });
  await writeCooldown(long);
  assert.deepEqual(local.get(COOLDOWN_STORAGE_KEY), long);
  await writeCooldown(makeCooldown("shorter", "bilibili", { now, minutes: 5 }));
  assert.deepEqual(local.get(COOLDOWN_STORAGE_KEY), long, "a shorter cooldown never replaces a longer one");
  assert.equal((await loadActiveCooldown(now))?.reason, "HTTP 429");
  assert.equal(await loadActiveCooldown(now + 31 * 60_000), null);
  await clearCooldown();
  assert.equal(local.has(COOLDOWN_STORAGE_KEY), false);
});

test("the history: most recent first, at most 20 runs and 1 MiB, the newest always kept", async () => {
  const local = installChrome();
  for (let run = 1; run <= HISTORY_LIMIT + 5; run += 1) await appendHistory({ run });
  const history = await readHistory();
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0]?.["run"], HISTORY_LIMIT + 5);
  assert.ok(Array.isArray(local.get(HISTORY_KEY)));
  const big = { blob: "x".repeat(600 * 1024) };
  const trimmed = trimHistory([big, big, big]);
  assert.equal(trimmed.length, 1, "1 MiB holds one of them");
  assert.equal(trimHistory([{ blob: "x".repeat(2 * 1024 * 1024) }]).length, 1, "the newest stays");
});
