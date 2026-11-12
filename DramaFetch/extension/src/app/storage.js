// @ts-check
/**
 * `chrome.storage.local` wrappers: the settings (validated: the pauses never below the Python
 * defaults), the cooldown record, the per-series state (`series:<id>`, the `dramafetch.json`
 * format of `lib/state.js`), the run's pacing (persisted, so reopening the tab never resets the
 * long break or the rest between jobs), the history of the last 20 runs — and the test settings,
 * honoured ONLY when the manifest says `dramafetch_test` (the test harness' temporary copy).
 *
 * The manifest's `unlimitedStorage` lifts the area's 10 MB quota: a series' state is about 350–400
 * bytes per episode and is never pruned (it is the resume memory), so the quota was full near
 * 27 000 episodes. A write can still be refused — the disk that holds the Chrome profile is full
 * or failing: the callers stop the run (`engine.storageRefusedReason`), the history gives way
 * ({@link appendHistory}) and a refusal's cooldown stays in force from this browser session's
 * memory ({@link cooldownStore}).
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
/** At most this much UTF-8 JSON of history ({@link trimHistory}): 1 MiB. */
export const HISTORY_MAX_BYTES = 1024 * 1024;
/**
 * One run's share of the history ({@link HISTORY_MAX_BYTES} / {@link HISTORY_LIMIT}, about
 * 51 KiB): a run larger than this is stored compact ({@link historyEntry}), so that the last runs
 * stay together however large one of them was.
 */
export const HISTORY_ENTRY_MAX_BYTES = Math.floor(HISTORY_MAX_BYTES / HISTORY_LIMIT);

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
 * @property {boolean} report save the "did not download" report at the end of a run with failures
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
 * @property {number} [existenceRateLimitS] Chrome's 10 s between two such checks, which a job's
 *   first look at the downloads waits out; 0: never wait (tests that delete no file)
 * @property {number} [maxResultRows] how many rows the result table keeps while a job runs (2000
 *   outside test mode: `app.MAX_RESULT_ROWS`)
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
  report: true,
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
  "existenceRateLimitS",
  "maxResultRows",
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
 * `lib/naming` refuses, a report switch that is not a boolean, pauses below the Python defaults
 * (outside test mode) or inverted.
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
  if (typeof settings.report !== "boolean") return "the report switch must be on or off";
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

/**
 * A refusal's record that `chrome.storage.local` would not store (a full disk under the Chrome
 * profile): TikTok refused all the same, so the cooldown stays in force from here while this page
 * lives — and from `chrome.storage.session`, the browser session's memory (never written to disk),
 * after a reload of the tab too.
 * @type {Record<string, unknown> | null}
 */
let unstoredCooldown = null;

/**
 * @param {unknown} record a cooldown record, or whatever the storage holds
 * @returns {number} when it ends, -Infinity when it is no record
 */
function untilOf(record) {
  const until = isRecord(record) ? record["until"] : undefined;
  return typeof until === "number" && Number.isFinite(until) ? until : Number.NEGATIVE_INFINITY;
}

/**
 * The cooldown record in `chrome.storage.local` — and, when the storage refused to write one, the
 * same record kept in this page's memory and in `chrome.storage.session` (the browser session's
 * memory: it survives a reload of the tab and is gone when Chrome closes; a full disk cannot
 * refuse it). Reading gives whichever of them ends later — also when one cannot be read —, so a
 * refusal by TikTok is honoured even when it could not be stored. The record the local storage
 * accepts next ends later and so replaces them.
 * @returns {import("../lib/cooldown.js").CooldownStore}
 */
export function cooldownStore() {
  const stored = storageAreaStore(chrome.storage.local);
  const session = chrome.storage.session === undefined ? null : storageAreaStore(chrome.storage.session);
  /** @param {import("../lib/cooldown.js").CooldownStore | null} area @returns {Promise<unknown>} */
  const readOf = async (area) => {
    try {
      return area === null ? undefined : await area.read();
    } catch {
      return undefined; // an unreadable area counts as none (`readCooldown`); the others still answer
    }
  };
  return {
    read: async () => {
      let found = await readOf(stored);
      for (const other of [unstoredCooldown, await readOf(session)]) if (untilOf(other) > untilOf(found)) found = other;
      return found;
    },
    write: async (record) => {
      try {
        await stored.write(record);
        unstoredCooldown = null; // the stored record is the newest: the copies kept on a refusal go
        await session?.remove?.()?.catch(() => undefined);
      } catch (error) {
        unstoredCooldown = record;
        await session?.write(record)?.catch(() => undefined);
        throw error; // `recordBlock` reports it and still returns the cooldown
      }
    },
    remove: async () => {
      unstoredCooldown = null;
      await session?.remove?.()?.catch(() => undefined);
      await stored.remove?.();
    },
  };
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
 * run is always kept. The history is read whole at every page start and after every job, so it
 * stays small whatever the storage could hold.
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
 * @param {unknown} value
 * @returns {number} its size as UTF-8 JSON
 */
function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * A run as the history stores it. One that fits its share of the history
 * ({@link HISTORY_ENTRY_MAX_BYTES}, about 51 KiB: a couple of 60-episode series) is stored as it
 * is. A larger one — a row per episode and a record per pause — is stored compact, so that it
 * neither pushes the earlier runs out nor makes the history a value of megabytes read at every
 * page start: of each series only the rows whose episode did not download (status `failed…`: all
 * the history's retry line and button read), no pauses, and how many of each were left out
 * (`rows_omitted` per series, `pauses_omitted`). The series' names, lines, errors and reports stay.
 * @param {Record<string, unknown>} entry
 * @param {number} [maxBytes]
 * @returns {Record<string, unknown>}
 */
export function historyEntry(entry, maxBytes = HISTORY_ENTRY_MAX_BYTES) {
  if (jsonBytes(entry) <= maxBytes) return entry;
  const series = Array.isArray(entry["series"]) ? entry["series"] : [];
  const pauses = Array.isArray(entry["pauses"]) ? entry["pauses"] : [];
  return {
    ...entry,
    pauses: [],
    pauses_omitted: pauses.length,
    series: series.map((record) => {
      if (!isRecord(record) || !Array.isArray(record["rows"])) return record;
      const rows = record["rows"].filter((row) => isRecord(row) && typeof row["status"] === "string" && row["status"].startsWith("failed"));
      return { ...record, rows, rows_omitted: record["rows"].length - rows.length };
    }),
  };
}

/**
 * Put a finished run first in the history ({@link historyEntry}, {@link trimHistory}). Should the
 * storage refuse it (a full disk), the history gives way — the run alone, else no history at all —
 * and never the series states; a history that cannot be read gives way too. Never throws: a job's
 * end must not break on its history.
 * @param {Record<string, unknown>} run
 * @returns {Promise<void>}
 */
export async function appendHistory(run) {
  const entry = historyEntry(run);
  const history = trimHistory([entry, ...(await readHistory().catch(() => []))]);
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
