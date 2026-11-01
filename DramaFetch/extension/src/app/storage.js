// @ts-check
/**
 * `chrome.storage.local` wrappers: the settings (validated: the pauses never below the Python
 * defaults), the cooldown record, the per-series state (`series:<id>`, the `dramafetch.json`
 * format of `lib/state.js`), the run's pacing (persisted, so reopening the tab never resets the
 * long break or the rest between jobs), the history of the last 20 runs — and the test settings,
 * honoured ONLY when the manifest says `dramafetch_test` (the test harness' temporary copy).
 *
 * Nothing here stores a cookie or a token: the extension never reads cookies at all.
 */

import { storageAreaStore } from "../lib/cooldown.js";
import { DEFAULT_NAME_FORMAT, QUALITY_MODES, THUMBNAIL_MODES } from "../lib/messages.js";
import { nameFormatProblem } from "../lib/naming.js";
import { PACES, PACING_DEFAULTS, PacingState, pacingOptions, pacingProblem } from "../lib/pacing.js";

/** The keys of `chrome.storage.local` (the test harness reads some of them). */
export const SETTINGS_KEY = "settings";
export const TEST_SETTINGS_KEY = "testSettings";
export const HISTORY_KEY = "history";
export const PACING_KEY = "pacing";
export const SERIES_KEY_PREFIX = "series:";
/** How many past runs the history keeps. */
export const HISTORY_LIMIT = 20;
/** At most this much UTF-8 JSON of history ({@link trimHistory}): 1 MiB of the 10 MB quota. */
export const HISTORY_MAX_BYTES = 1024 * 1024;

/**
 * @typedef {object} Settings What the user may set (Settings panel); the pauses only upwards.
 * @property {"compatible" | "best"} quality
 * @property {"embed" | "both" | "file" | "none"} thumbnail
 * @property {string} nameFormat
 * @property {"fixed" | "human"} pace
 * @property {number} delayMinS
 * @property {number} delayMaxS
 * @property {number} restEvery
 * @property {number} restMinS
 * @property {number} restMaxS
 *
 * @typedef {object} TestSettings Overrides honoured only in test mode (`dramafetch_test`).
 * @property {string} [baseUrl] another origin than TikTok's (the fake TikTok server)
 * @property {number} [delayMinS]
 * @property {number} [delayMaxS]
 * @property {number} [restEvery]
 * @property {number} [restMinS]
 * @property {number} [restMaxS]
 * @property {number} [maxConsecutiveFailures]
 * @property {number} [longRestEvery]
 * @property {number} [longRestMinS]
 * @property {number} [longRestMaxS]
 * @property {number} [pageDelayS] the list page pause minimum (0.8 s outside test mode)
 * @property {number} [discoveryTimeoutS] 45 s outside test mode
 * @property {number} [activateAfterS] 10 s outside test mode
 * @property {number} [detailGraceS] 2 s outside test mode
 * @property {number} [existenceDelayMs] the wait after asking Chrome to re-check its files (300 ms)
 *
 * @typedef {object} StoredPacing The run's pacing as stored (wall-clock seconds).
 * @property {PacingState} pacing
 * @property {number | null} lastContactAt when the last job that contacted TikTok finished
 */

/** @type {Readonly<Settings>} */
export const DEFAULT_SETTINGS = Object.freeze({
  quality: "compatible",
  thumbnail: "embed",
  nameFormat: DEFAULT_NAME_FORMAT,
  pace: "fixed",
  delayMinS: PACING_DEFAULTS.delayMinS,
  delayMaxS: PACING_DEFAULTS.delayMaxS,
  restEvery: PACING_DEFAULTS.restEvery,
  restMinS: PACING_DEFAULTS.restMinS,
  restMaxS: PACING_DEFAULTS.restMaxS,
});

/** The numeric test settings and nothing else; anything outside test mode is ignored. */
const TEST_NUMBER_KEYS = /** @type {const} */ ([
  "delayMinS",
  "delayMaxS",
  "restEvery",
  "restMinS",
  "restMaxS",
  "maxConsecutiveFailures",
  "longRestEvery",
  "longRestMinS",
  "longRestMaxS",
  "pageDelayS",
  "discoveryTimeoutS",
  "activateAfterS",
  "detailGraceS",
  "existenceDelayMs",
]);

/**
 * Whether this copy of the extension is the test harness' (`dramafetch_test: true` in its
 * manifest). The shipped manifest never has the key.
 * @returns {boolean}
 */
export function isTestMode() {
  return chrome.runtime.getManifest().dramafetch_test === true;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Why `settings` cannot be saved, or null: an unknown quality, cover mode or pace, a name format
 * `lib/naming` refuses, pauses below the Python defaults (outside test mode) or inverted.
 * @param {Settings} settings
 * @param {boolean} testMode
 * @returns {string | null}
 */
export function settingsProblem(settings, testMode) {
  if (!(/** @type {readonly string[]} */ (QUALITY_MODES).includes(settings.quality))) return "unknown quality";
  if (!(/** @type {readonly string[]} */ (THUMBNAIL_MODES).includes(settings.thumbnail))) return "unknown cover mode";
  if (!(/** @type {readonly string[]} */ (PACES).includes(settings.pace))) return "unknown pace";
  if (typeof settings.nameFormat !== "string") return "the name format must be text";
  const naming = nameFormatProblem(settings.nameFormat);
  if (naming !== null) return naming;
  return pacingProblem(pacingOptions(pickPacing(settings)), { testMode });
}

/**
 * @param {Partial<Settings>} settings
 * @returns {Partial<import("../lib/pacing.js").PacingOptions>}
 */
function pickPacing(settings) {
  return {
    pace: settings.pace,
    delayMinS: settings.delayMinS,
    delayMaxS: settings.delayMaxS,
    restEvery: settings.restEvery,
    restMinS: settings.restMinS,
    restMaxS: settings.restMaxS,
  };
}

/**
 * The stored settings over the defaults; a stored value that does not validate is dropped (the
 * default stays), so nothing stored can make the pauses lighter.
 * @param {unknown} raw
 * @param {boolean} testMode
 * @returns {Settings}
 */
export function normalizeSettings(raw, testMode) {
  /** @type {Settings} */
  let settings = { ...DEFAULT_SETTINGS };
  if (!isRecord(raw)) return settings;
  const known = pickKnown(raw);
  /** @type {Settings} */
  const merged = { ...settings, ...known };
  if (settingsProblem(merged, testMode) === null) return merged;
  // otherwise each stored value that validates on its own
  for (const key of /** @type {(keyof Settings)[]} */ (Object.keys(known))) {
    /** @type {Settings} */
    const candidate = { ...settings, [key]: known[key] };
    if (settingsProblem(candidate, testMode) === null) settings = candidate;
  }
  return settings;
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {Partial<Settings>}
 */
function pickKnown(raw) {
  /** @type {Record<string, unknown>} */
  const known = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = raw[key];
    if (Object.hasOwn(raw, key) && typeof value === typeof DEFAULT_SETTINGS[/** @type {keyof Settings} */ (key)]) {
      known[key] = value;
    }
  }
  return /** @type {Partial<Settings>} */ (known);
}

/** @returns {Promise<Settings>} */
export async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY], isTestMode());
}

/**
 * Save the settings; throws an Error with the reason when they do not validate (nothing saved).
 * @param {Settings} settings
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
  const problem = settingsProblem(settings, isTestMode());
  if (problem !== null) throw new Error(problem);
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings } });
}

/**
 * The known test settings of a raw object (unknown keys and wrong types dropped).
 * @param {unknown} raw
 * @returns {TestSettings}
 */
export function parseTestSettings(raw) {
  /** @type {TestSettings} */
  const parsed = {};
  if (!isRecord(raw)) return parsed;
  if (typeof raw["baseUrl"] === "string" && /^https?:\/\/[^/?#\s]+$/i.test(raw["baseUrl"].replace(/\/+$/, ""))) {
    parsed.baseUrl = raw["baseUrl"].replace(/\/+$/, "");
  }
  for (const key of TEST_NUMBER_KEYS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) parsed[key] = value;
  }
  return parsed;
}

/**
 * The test settings — an empty object outside test mode, whatever is stored.
 * @returns {Promise<TestSettings>}
 */
export async function loadTestSettings() {
  if (!isTestMode()) return {};
  const stored = await chrome.storage.local.get(TEST_SETTINGS_KEY);
  return parseTestSettings(stored[TEST_SETTINGS_KEY]);
}

/**
 * Store test settings; refused outside test mode.
 * @param {unknown} raw
 * @returns {Promise<TestSettings>} what was stored
 */
export async function saveTestSettings(raw) {
  if (!isTestMode()) throw new Error("test settings exist only in the test harness' copy of the extension");
  const parsed = parseTestSettings(raw);
  await chrome.storage.local.set({ [TEST_SETTINGS_KEY]: parsed });
  return parsed;
}

/** @returns {import("../lib/cooldown.js").CooldownStore} the cooldown record in chrome.storage.local */
export function cooldownStore() {
  return storageAreaStore(chrome.storage.local);
}

/**
 * The storage key of a series' state.
 * @param {string} seriesId
 * @returns {string}
 */
export function seriesKey(seriesId) {
  return `${SERIES_KEY_PREFIX}${seriesId}`;
}

/**
 * The stored state of a series, raw (`lib/state.readState` / `loadState` parse it).
 * @param {string} seriesId
 * @returns {Promise<unknown>}
 */
export async function readSeriesState(seriesId) {
  const key = seriesKey(seriesId);
  return (await chrome.storage.local.get(key))[key];
}

/**
 * @param {import("../lib/state.js").SeriesState} state
 * @returns {Promise<void>}
 */
export async function writeSeriesState(state) {
  await chrome.storage.local.set({ [seriesKey(state.series_id)]: state });
}

/** @returns {Promise<StoredPacing>} */
export async function loadPacing() {
  const raw = (await chrome.storage.local.get(PACING_KEY))[PACING_KEY];
  const record = isRecord(raw) ? raw : {};
  /** @param {unknown} value @returns {number | null} */
  const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    pacing: new PacingState({
      runAttempts: Math.max(0, Math.trunc(number(record["runAttempts"]) ?? 0)),
      lastNetworkAt: number(record["lastNetworkAt"]),
      consecutiveFailures: Math.max(0, Math.trunc(number(record["consecutiveFailures"]) ?? 0)),
    }),
    lastContactAt: number(record["lastContactAt"]),
  };
}

/**
 * @param {PacingState} pacing
 * @param {number | null} lastContactAt
 * @returns {Promise<void>}
 */
export async function savePacing(pacing, lastContactAt) {
  await chrome.storage.local.set({
    [PACING_KEY]: {
      runAttempts: pacing.runAttempts,
      lastNetworkAt: pacing.lastNetworkAt,
      consecutiveFailures: pacing.consecutiveFailures,
      lastContactAt,
    },
  });
}

/** @returns {Promise<Record<string, unknown>[]>} the past runs, most recent first */
export async function readHistory() {
  const raw = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY];
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

/**
 * The history to store: `entries` (most recent first) cut to the last {@link HISTORY_LIMIT} runs
 * and to {@link HISTORY_MAX_BYTES} of UTF-8 JSON, the oldest runs dropped first; the most recent
 * run is always kept. `chrome.storage.local` holds 10 MB without the `unlimitedStorage`
 * permission, and the per-series states — the resume memory — must never lose that room to the
 * history.
 * @param {readonly Record<string, unknown>[]} entries
 * @param {number} [limit]
 * @param {number} [maxBytes]
 * @returns {Record<string, unknown>[]}
 */
export function trimHistory(entries, limit = HISTORY_LIMIT, maxBytes = HISTORY_MAX_BYTES) {
  const encoder = new TextEncoder();
  /** @type {Record<string, unknown>[]} */
  const kept = [];
  let bytes = 2; // the brackets of the array
  for (const entry of entries.slice(0, limit)) {
    const size = encoder.encode(JSON.stringify(entry)).length + 1; // and its comma
    if (kept.length > 0 && bytes + size > maxBytes) break;
    kept.push(entry);
    bytes += size;
  }
  return kept;
}

/**
 * Put a finished run first in the history ({@link trimHistory}). Should the storage still refuse
 * it (the quota), the history gives way — the run alone, else no history at all — and never the
 * series states.
 * @param {Record<string, unknown>} entry
 * @returns {Promise<void>}
 */
export async function appendHistory(entry) {
  const history = trimHistory([entry, ...(await readHistory())]);
  try {
    await chrome.storage.local.set({ [HISTORY_KEY]: history });
  } catch {
    try {
      await chrome.storage.local.set({ [HISTORY_KEY]: [entry] });
    } catch {
      await chrome.storage.local.remove(HISTORY_KEY).catch(() => undefined);
    }
  }
}
