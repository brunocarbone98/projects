// @ts-check
/**
 * `chrome.storage.local` wrappers: the settings (validated: the pauses never below the Python
 * defaults), the cooldown record, the per-series state (`series:<id>`, the `dramafetch.json`
 * format of `lib/state.js`), the run's pacing (persisted, so reopening the tab never resets the
 * long break or the rest between jobs) — and the test settings, honoured ONLY when the manifest
 * says `dramafetch_test` (the test harness' temporary copy). DramaFetch 2.0.0 (the owner's decision
 * of 2026-11-22) keeps no history of past runs, and DramaFetch 4.0.0 (the owner's decision of
 * 2026-11-27) no library: what 1.x and 3.x kept of them is removed at the page's start
 * ({@link removeRetiredKeys}).
 *
 * The manifest's `unlimitedStorage` lifts the area's 10 MB quota: a series' state is about 350–400
 * bytes per episode and is never pruned (it is the resume memory), so the quota was full near
 * 27 000 episodes. A write can still be refused — the disk that holds the Chrome profile is full
 * or failing: the callers stop the run (`engine.storageRefusedReason`) and a refusal's cooldown
 * stays in force from this browser session's memory ({@link cooldownStore}).
 *
 * `chrome.storage.session` (in memory for the browser session, never on disk) holds the discovery
 * tab's record and a cooldown the local storage refused — nothing else since DramaFetch 4.0.0 (what
 * 3.x kept there, a TikTok tab's favorites address and the library's covers, went when Chrome
 * reloaded the extension for its update, and nothing writes it again).
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
export const PACING_KEY = "pacing";
export const SERIES_KEY_PREFIX = "series:";
/**
 * The `chrome.storage.local` keys of what an earlier DramaFetch kept and this one never reads or
 * writes, removed at the page's start ({@link removeRetiredKeys}): `history`, the last 20 runs 1.x
 * kept (**Past runs**; DramaFetch 2.0.0 keeps no history), and the library 3.x kept — its dramas'
 * ids, titles and counts and the profile's `@handle` (`favoritesLibrary`, since 1.6.0) and the sort
 * picked last (`librarySort`, since 1.7.0) — which DramaFetch 4.0.0 (the owner's decision of
 * 2026-11-27: no library, nothing read of the user's TikTok Favorites) has no use for.
 * @type {readonly string[]}
 */
export const RETIRED_KEYS = Object.freeze(["history", "favoritesLibrary", "librarySort"]);

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
 * @property {boolean} alerts a notification when a drama finishes — complete, or episodes to retry
 *   (`alerts.js`, DramaFetch 1.7.0)
 * @property {boolean} autoRetry one automatic retry of a drama's episodes that did not download for a
 *   reason a retry can change — never after a stop (`app.js`, DramaFetch 1.8.0)
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
  alerts: true,
  autoRetry: true,
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
 * `lib/naming` refuses, a report, alert or automatic retry switch that is not a boolean, pauses
 * below the Python defaults (outside test mode) or inverted.
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
  if (typeof settings.alerts !== "boolean") return "the alert switch must be on or off";
  if (typeof settings.autoRetry !== "boolean") return "the automatic retry switch must be on or off";
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
 * default stays), so nothing stored can make the pauses lighter. A key the settings no longer have
 * — the `autoRemove` switch DramaFetch 2.x stored (3.0.0 removes nothing from the Favorites) — is
 * read as if it were absent: never an error, and never written back ({@link saveSettings} writes
 * the settings as they are now).
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
 * refusal by TikTok is honoured even when it could not be stored; a kept copy that ends later than
 * the stored record is written to `chrome.storage.local` again at each reading, so it outlives a
 * restart of Chrome as soon as the storage takes it (still refused, the copies answer). The
 * record the local storage accepts next ends later and so replaces them.
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
      const local = await readOf(stored);
      let found = local;
      for (const other of [unstoredCooldown, await readOf(session)]) if (untilOf(other) > untilOf(found)) found = other;
      if (found !== local && isRecord(found)) {
        try {
          await stored.write(found);
          unstoredCooldown = null;
          await session?.remove?.()?.catch(() => undefined);
        } catch {
          // refused again: the copies still answer
        }
      }
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
 * When the cooldown `chrome.storage.local` holds ends (-Infinity when there is none or it cannot
 * be read): a cooldown in force that ends later lives only in this browser session's memory.
 * @returns {Promise<number>}
 */
export async function storedCooldownUntil() {
  try {
    return untilOf(await storageAreaStore(chrome.storage.local).read());
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
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
 * The stored states of several series at once, raw, by series id (one read for a whole list: the
 * names of the dramas the Waiting card waits for).
 * @param {readonly string[]} seriesIds
 * @returns {Promise<Map<string, unknown>>}
 */
export async function readSeriesStates(seriesIds) {
  if (seriesIds.length === 0) return new Map();
  const stored = await chrome.storage.local.get(seriesIds.map(seriesKey));
  return new Map(seriesIds.map((seriesId) => [seriesId, stored[seriesKey(seriesId)]]));
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

/**
 * Remove what an earlier DramaFetch kept and this one never uses ({@link RETIRED_KEYS}: 1.x's
 * history, 3.x's library and its sort) from `chrome.storage.local`, in one call — the page calls it
 * once at its start: deleted on the first start after the update; keys no longer there cost
 * nothing. Best effort: a removal the storage refuses (a full or failing disk) is ignored — never a
 * stop, never the page's refused write (`app.unsaved`), and the next start tries again. Nothing
 * else is removed: the settings, the series' records, the pacing and the cooldown stay. Never
 * throws; returns whether the storage took it.
 * @returns {Promise<boolean>}
 */
export async function removeRetiredKeys() {
  try {
    await chrome.storage.local.remove([...RETIRED_KEYS]);
    return true;
  } catch {
    return false;
  }
}
