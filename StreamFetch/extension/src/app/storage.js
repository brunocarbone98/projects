// @ts-check
/**
 * `chrome.storage.local` wrappers: the settings (validated: the pauses never below the floors of
 * `lib/pacing.js` outside test mode), the cooldown record (`lib/cooldown.js` decides, this module
 * reads and writes it), the history of the last 20 runs (at most 1 MiB, the oldest runs dropped
 * first) — and the test settings, honoured ONLY when the manifest says `streamfetch_test` (the
 * test harness' temporary copy; the shipped manifest never has the key).
 *
 * Nothing here stores a cookie, a token or a request header: the extension never reads them.
 */

import { COOLDOWN_STORAGE_KEY, activeCooldown, parseCooldown } from "../lib/cooldown.js";
import { PACING_DEFAULTS, pacingProblem } from "../lib/pacing.js";

/** The keys of `chrome.storage.local` (the test harness reads some of them). */
export const SETTINGS_KEY = "settings";
export const TEST_SETTINGS_KEY = "testSettings";
export const HISTORY_KEY = "history";
export { COOLDOWN_STORAGE_KEY };
/** How many past runs the history keeps. */
export const HISTORY_LIMIT = 20;
/** At most this much UTF-8 JSON of history ({@link trimHistory}): 1 MiB of the 10 MB quota. */
export const HISTORY_MAX_BYTES = 1024 * 1024;

/** The quality caps the settings offer: `best` (no cap) or a maximum height. */
export const QUALITIES = Object.freeze(/** @type {const} */ (["best", "1080", "720", "480"]));
/** `compatible` prefers H.264 at the chosen height (every Windows Chrome plays it); `best` the highest bandwidth. */
export const CODECS = Object.freeze(/** @type {const} */ (["compatible", "best"]));
/** The UI language: Chrome's (`auto`), or English / Spanish whatever Chrome's is. */
export const LANGUAGES = Object.freeze(/** @type {const} */ (["auto", "en", "es"]));
/** The sites a test base URL may stand in for (test mode only). */
export const BASE_URL_KEYS = Object.freeze(
  /** @type {const} */ (["dailymotion", "bilibili", "b23", "dmcdn", "bilibilitv", "bilibilitvApi"]),
);

/**
 * @typedef {[number, number]} Range
 *
 * @typedef {object} Settings What the user may set (the settings form); the pauses only upwards.
 * @property {(typeof QUALITIES)[number]} quality
 * @property {(typeof CODECS)[number]} codec
 * @property {Range} videoPauseS between two downloads, seconds
 * @property {Range} pagePauseS between two page or manifest requests, seconds
 * @property {Range} mediaPauseMs between two media requests, milliseconds
 * @property {boolean} report save the "did not download" report at the end of a run with failures
 * @property {(typeof LANGUAGES)[number]} language
 *
 * @typedef {object} BaseUrls Test mode: where the fake sites live (`http://127.0.0.1:<port>/dm`, …).
 * @property {string} [dailymotion] stands for `https://www.dailymotion.com`
 * @property {string} [bilibili] stands for `https://www.bilibili.com`
 * @property {string} [b23] stands for `https://b23.tv`
 * @property {string} [dmcdn] stands for `https://s1.dmcdn.net` (posters)
 * @property {string} [bilibilitv] stands for `https://www.bilibili.tv`
 * @property {string} [bilibilitvApi] stands for `https://api.bilibili.tv`
 *
 * @typedef {object} TestSettings Overrides honoured only in test mode (`streamfetch_test`).
 * @property {BaseUrls} [baseUrls]
 * @property {Range} [videoPauseS] may go below the floor (test mode only)
 * @property {Range} [pagePauseS]
 * @property {Range} [mediaPauseMs]
 * @property {number} [stallTimeoutS] the stall timeout (30 s outside test mode)
 * @property {number} [existenceRateLimitS] Chrome's 10 s between two file checks (0: never wait)
 * @property {number} [browserCheckTimeoutS] the browser decoder check's timeout (10 s outside)
 * @property {number[]} [retryBackoffS] the waits before retries 1, 2, 3 (1, 2, 4 s outside)
 */

/** @type {Readonly<Settings>} */
export const DEFAULT_SETTINGS = Object.freeze({
  quality: "best",
  codec: "compatible",
  videoPauseS: /** @type {Range} */ ([...PACING_DEFAULTS.videoPauseS]),
  pagePauseS: /** @type {Range} */ ([...PACING_DEFAULTS.pagePauseS]),
  mediaPauseMs: /** @type {Range} */ ([...PACING_DEFAULTS.mediaPauseMs]),
  report: true,
  language: "auto",
});

/**
 * Whether this copy of the extension is the test harness' (`streamfetch_test: true` in its
 * manifest). The shipped manifest never has the key.
 * @returns {boolean}
 */
export function isTestMode() {
  return chrome.runtime.getManifest().streamfetch_test === true;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Why `settings` cannot be saved, or null: an unknown quality, codec or language, a report switch
 * that is not a boolean, pauses that `lib/pacing.pacingProblem` refuses (below the floors outside
 * test mode, inverted, negative, longer than a day).
 * @param {Record<string, unknown>} settings a {@link Settings} (or something claiming to be one)
 * @param {boolean} testMode
 * @returns {string | null}
 */
export function settingsProblem(settings, testMode) {
  if (!(/** @type {readonly unknown[]} */ (QUALITIES).includes(settings["quality"]))) {
    return "unknown quality";
  }
  if (!(/** @type {readonly unknown[]} */ (CODECS).includes(settings["codec"]))) {
    return "unknown codec preference";
  }
  if (!(/** @type {readonly unknown[]} */ (LANGUAGES).includes(settings["language"]))) {
    return "unknown language";
  }
  if (typeof settings["report"] !== "boolean") return "the report switch must be on or off";
  return pacingProblem(settings, testMode);
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
  let settings = copySettings(DEFAULT_SETTINGS);
  if (!isRecord(raw)) return settings;
  /** @type {Record<string, unknown>} */
  const known = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.hasOwn(raw, key)) known[key] = raw[key];
  }
  const merged = { ...settings, ...known };
  if (settingsProblem(merged, testMode) === null) return copySettings(/** @type {Settings} */ (merged));
  for (const [key, value] of Object.entries(known)) {
    const candidate = { ...settings, [key]: value };
    if (settingsProblem(candidate, testMode) === null) {
      settings = copySettings(/** @type {Settings} */ (candidate));
    }
  }
  return settings;
}

/**
 * A deep copy (the ranges are arrays).
 * @param {Readonly<Settings>} settings
 * @returns {Settings}
 */
export function copySettings(settings) {
  return {
    quality: settings.quality,
    codec: settings.codec,
    videoPauseS: [settings.videoPauseS[0], settings.videoPauseS[1]],
    pagePauseS: [settings.pagePauseS[0], settings.pagePauseS[1]],
    mediaPauseMs: [settings.mediaPauseMs[0], settings.mediaPauseMs[1]],
    report: settings.report,
    language: settings.language,
  };
}

/**
 * The maximum height a quality setting stands for (`best` → no cap).
 * @param {Settings["quality"]} quality
 * @returns {number | null}
 */
export function maxHeightOf(quality) {
  return quality === "best" ? null : Number(quality);
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
  const problem = settingsProblem({ ...settings }, isTestMode());
  if (problem !== null) throw new Error(problem);
  await chrome.storage.local.set({ [SETTINGS_KEY]: copySettings(settings) });
}

/**
 * A `[min, max]` pair of finite, non-negative numbers with `max >= min`, else undefined.
 * @param {unknown} value
 * @returns {Range | undefined}
 */
function rangeOf(value) {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [min, max] = value;
  if (typeof min !== "number" || typeof max !== "number") return undefined;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) return undefined;
  return [min, max];
}

/**
 * A base URL without trailing slashes, `http(s)://host[:port][/path]`, no query or fragment; else
 * undefined.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function baseOf(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\/+$/, "");
  return /^https?:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/i.test(trimmed) ? trimmed : undefined;
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
  const bases = raw["baseUrls"];
  if (isRecord(bases)) {
    /** @type {BaseUrls} */
    const urls = {};
    for (const key of BASE_URL_KEYS) {
      const base = baseOf(bases[key]);
      if (base !== undefined) urls[key] = base;
    }
    parsed.baseUrls = urls;
  }
  for (const key of /** @type {const} */ (["videoPauseS", "pagePauseS", "mediaPauseMs"])) {
    const range = rangeOf(raw[key]);
    if (range !== undefined) parsed[key] = range;
  }
  const backoff = raw["retryBackoffS"];
  if (
    Array.isArray(backoff) &&
    backoff.length > 0 &&
    backoff.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
  ) {
    parsed.retryBackoffS = backoff.map(Number);
  }
  for (const key of /** @type {const} */ ([
    "stallTimeoutS",
    "existenceRateLimitS",
    "browserCheckTimeoutS",
  ])) {
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
  if (!isTestMode()) {
    throw new Error("test settings exist only in the test harness' copy of the extension");
  }
  const parsed = parseTestSettings(raw);
  await chrome.storage.local.set({ [TEST_SETTINGS_KEY]: parsed });
  return parsed;
}

/**
 * The pacing a run uses: the user's settings, and in test mode the test settings' pauses and
 * stall timeout on top (they may go below the floors there, and only there).
 * @param {Settings} settings
 * @param {TestSettings} test
 * @param {boolean} testMode
 * @returns {import("../lib/pacing.js").PacingSettings}
 */
export function effectivePacing(settings, test, testMode) {
  /** @type {import("../lib/pacing.js").PacingSettings} */
  const pacing = {
    videoPauseS: settings.videoPauseS,
    pagePauseS: settings.pagePauseS,
    mediaPauseMs: settings.mediaPauseMs,
  };
  if (!testMode) return pacing;
  if (test.videoPauseS) pacing.videoPauseS = test.videoPauseS;
  if (test.pagePauseS) pacing.pagePauseS = test.pagePauseS;
  if (test.mediaPauseMs) pacing.mediaPauseMs = test.mediaPauseMs;
  if (test.stallTimeoutS !== undefined && test.stallTimeoutS > 0) {
    pacing.stallTimeoutS = test.stallTimeoutS;
  }
  return pacing;
}

// ------------------------------------------------------------------------------ cooldown

/**
 * The stored cooldown record, raw or null when none is stored (`lib/cooldown.parseCooldown`
 * parses it).
 * @returns {Promise<unknown>}
 */
export async function readCooldown() {
  const stored = await chrome.storage.local.get(COOLDOWN_STORAGE_KEY);
  return stored[COOLDOWN_STORAGE_KEY] ?? null;
}

/**
 * The cooldown in force now, or null.
 * @param {number} [now] milliseconds since the epoch
 * @returns {Promise<import("../lib/cooldown.js").Cooldown | null>}
 */
export async function loadActiveCooldown(now = Date.now()) {
  return activeCooldown(now, await readCooldown());
}

/**
 * Record a cooldown (`lib/cooldown.makeCooldown`'s record, stored as it is). A later `until` never
 * gives way to an earlier one: a cooldown can only be lengthened by the extension.
 * @param {import("../lib/cooldown.js").Cooldown} cooldown
 * @returns {Promise<void>}
 */
export async function writeCooldown(cooldown) {
  const existing = parseCooldown(await readCooldown());
  if (existing !== null && existing.until > cooldown.until) return;
  await chrome.storage.local.set({ [COOLDOWN_STORAGE_KEY]: { ...cooldown } });
}

/**
 * Delete the cooldown record — only ever on the user's explicit request in Settings ("at your own
 * risk"); no code path of the engine calls it.
 * @returns {Promise<void>}
 */
export async function clearCooldown() {
  await chrome.storage.local.remove(COOLDOWN_STORAGE_KEY);
}

// ------------------------------------------------------------------------------- history

/** @returns {Promise<Record<string, unknown>[]>} the past runs, most recent first */
export async function readHistory() {
  const raw = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY];
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

/**
 * The history to store: `entries` (most recent first) cut to the last {@link HISTORY_LIMIT} runs
 * and to {@link HISTORY_MAX_BYTES} of UTF-8 JSON, the oldest runs dropped first; the most recent
 * run is always kept.
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
 * it (the quota), the history gives way — the run alone, else no history at all.
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
