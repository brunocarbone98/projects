// @ts-check
/**
 * The global "do not contact TikTok" window after a refusal (HTTP 403, HTTP 429, a captcha): a
 * port of `cooldown.py` over an injected store (`chrome.storage.local` in the extension, a Map in
 * tests). For {@link COOLDOWN_MINUTES} nothing contacts TikTok — asked before every series and
 * again right before every request. Knocking again right after a refusal is what makes TikTok's
 * protections escalate, so nothing in the extension lifts it early. Reading never throws: a
 * missing or corrupt record counts as no cooldown. The stored record is the Python file's object,
 * `{"until", "reason", "source", "recorded_at"}` (seconds since the epoch); the reason is an
 * already-sanitised engine message, whitespace-collapsed and cut at 200 characters.
 */

import { PY_SPACE, pyHead, pyLen, pyStrip } from "./messages.js";

/** How long DramaFetch refuses to contact TikTok after a refusal. */
export const COOLDOWN_MINUTES = 30;
/** Where a block can be recorded from (informative; stored as given). */
export const COOLDOWN_SOURCES = Object.freeze(/** @type {const} */ (["yt-dlp", "browser", "discovery", "web"]));
/** The key of the record in `chrome.storage.local`. */
export const COOLDOWN_STORAGE_KEY = "cooldown";
/**
 * How the extension's cooldown message ends: the Python tool names the file to delete; the
 * extension has none, and no button lifts the cooldown.
 */
export const EXTENSION_LIFT_TEXT = "the extension has no way to lift it early";
const MAX_REASON_LEN = 200;
const WHITESPACE_RE = new RegExp(`[${PY_SPACE}]+`, "g");

/**
 * @typedef {object} Cooldown A recorded refusal: TikTok is not contacted again before `until`.
 * @property {number} until seconds since the epoch
 * @property {string} reason
 * @property {string} source `browser`, `discovery`, …
 * @property {number | null} recordedAt when TikTok refused (null for one built by hand)
 *
 * @typedef {object} CooldownStore Where the record lives (async or not).
 * @property {() => unknown | Promise<unknown>} read the stored record, undefined when there is none
 * @property {(record: Record<string, unknown>) => void | Promise<void>} write
 * @property {() => void | Promise<void>} [remove]
 */

/**
 * When TikTok refused: `recordedAt` when known, else `until` minus the default window.
 * @param {Cooldown} cooldown
 * @returns {number}
 */
export function started(cooldown) {
  return cooldown.recordedAt !== null ? cooldown.recordedAt : cooldown.until - COOLDOWN_MINUTES * 60;
}

/**
 * Whole seconds until the cooldown ends (0 once it has), e.g. for a banner's countdown.
 * @param {Cooldown} cooldown
 * @param {number} [now] seconds since the epoch
 * @returns {number}
 */
export function secondsLeft(cooldown, now = Date.now() / 1000) {
  return Math.max(0, Math.ceil(cooldown.until - now));
}

/**
 * Whole minutes until the cooldown ends, rounded up (0 once it has).
 * @param {Cooldown} cooldown
 * @param {number} [now]
 * @returns {number}
 */
export function minutesLeft(cooldown, now = Date.now() / 1000) {
  return Math.ceil(secondsLeft(cooldown, now) / 60);
}

/**
 * Whether the cooldown is still in force at `now`.
 * @param {Cooldown} cooldown
 * @param {number} [now]
 * @returns {boolean}
 */
export function isActive(cooldown, now = Date.now() / 1000) {
  return cooldown.until > now;
}

/**
 * @param {string} reason
 * @returns {string}
 */
function cleanReason(reason) {
  const text = pyStrip(String(reason).replace(WHITESPACE_RE, " "));
  if (!text) return "request refused";
  if (pyLen(text) > MAX_REASON_LEN) return `${pyHead(text, MAX_REASON_LEN - 1)}…`;
  return text;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function asEpoch(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The cooldown a refusal starts and the record to store for it (`cooldown.record_block` without
 * the write): `until` = `now` + `minutes`.
 * @param {string} reason
 * @param {string} source
 * @param {{now?: number, minutes?: number}} [options]
 * @returns {{cooldown: Cooldown, record: Record<string, unknown>}}
 */
export function makeCooldown(reason, source, options = {}) {
  const recordedAt = options.now ?? Date.now() / 1000;
  const cooldown = {
    until: recordedAt + (options.minutes ?? COOLDOWN_MINUTES) * 60,
    reason: cleanReason(reason),
    source: String(source),
    recordedAt,
  };
  return {
    cooldown,
    record: { until: cooldown.until, reason: cooldown.reason, source: cooldown.source, recorded_at: recordedAt },
  };
}

/**
 * The cooldown a stored record holds, active or expired; null when it is missing or not the
 * expected object (`cooldown.read_cooldown` after reading the file). Never throws.
 * @param {unknown} raw
 * @returns {Cooldown | null}
 */
export function parseCooldown(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = /** @type {Record<string, unknown>} */ (raw);
  const until = asEpoch(Object.hasOwn(record, "until") ? record["until"] : undefined);
  if (until === null) return null;
  const reason = Object.hasOwn(record, "reason") ? record["reason"] : undefined;
  const source = Object.hasOwn(record, "source") ? record["source"] : undefined;
  return {
    until,
    reason: typeof reason === "string" ? cleanReason(reason) : "",
    source: typeof source === "string" ? source : "",
    recordedAt: asEpoch(Object.hasOwn(record, "recorded_at") ? record["recorded_at"] : undefined),
  };
}

/**
 * Record a refusal (`cooldown.record_block`): TikTok is not contacted again for `minutes` from
 * `now`; a newer refusal restarts the window. A store that cannot be written is reported to
 * `onError` (the run is already stopping) and the cooldown is still returned.
 * @param {CooldownStore} store
 * @param {string} reason
 * @param {string} source
 * @param {{now?: number, minutes?: number, onError?: (error: unknown) => void}} [options]
 * @returns {Promise<Cooldown>}
 */
export async function recordBlock(store, reason, source, options = {}) {
  const { cooldown, record } = makeCooldown(reason, source, options);
  try {
    await store.write(record);
  } catch (error) {
    options.onError?.(error);
  }
  return cooldown;
}

/**
 * The stored cooldown, active or expired; null when there is none (`cooldown.read_cooldown`).
 * Never throws: an unreadable store counts as none.
 * @param {CooldownStore} store
 * @returns {Promise<Cooldown | null>}
 */
export async function readCooldown(store) {
  try {
    return parseCooldown(await store.read());
  } catch {
    return null;
  }
}

/**
 * The cooldown in force at `now`, null when there is none or it has expired
 * (`cooldown.active_cooldown`): what every action asks before contacting TikTok.
 * @param {CooldownStore} store
 * @param {{now?: number}} [options]
 * @returns {Promise<Cooldown | null>}
 */
export async function activeCooldown(store, options = {}) {
  const cooldown = await readCooldown(store);
  if (cooldown === null || !isActive(cooldown, options.now ?? Date.now() / 1000)) return null;
  return cooldown;
}

/**
 * Remove the record (`cooldown.clear_cooldown`) — for tests and the expired record only: no
 * control of the extension lifts an active cooldown.
 * @param {CooldownStore} store
 * @returns {Promise<void>}
 */
export async function clearCooldown(store) {
  await store.remove?.();
}

/**
 * `HH:MM` in local time for a moment in seconds since the epoch (`cooldown.clock_time`).
 * @param {number} epoch
 * @returns {string}
 */
export function clockTime(epoch) {
  const date = new Date(Math.floor(epoch) * 1000);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * `until HH:MM (N min left): <reason>` (`cooldown.cooldown_summary`): status displays.
 * @param {Cooldown} cooldown
 * @param {{now?: number}} [options]
 * @returns {string}
 */
export function cooldownSummary(cooldown, options = {}) {
  const left = minutesLeft(cooldown, options.now ?? Date.now() / 1000);
  return `until ${clockTime(cooldown.until)} (${left} min left): ${cooldown.reason}`;
}

/**
 * The full explanation (`cooldown.cooldown_message`): `TikTok refused a request at HH:MM
 * (<reason>); DramaFetch waits until HH:MM (N min left) before contacting TikTok again — <lift>`,
 * where `lift` is {@link EXTENSION_LIFT_TEXT} by default (the Python tool's is `delete <file> to
 * lift it, at your own risk`).
 * @param {Cooldown} cooldown
 * @param {{now?: number, lift?: string}} [options]
 * @returns {string}
 */
export function cooldownMessage(cooldown, options = {}) {
  const now = options.now ?? Date.now() / 1000;
  return (
    `TikTok refused a request at ${clockTime(started(cooldown))} (${cooldown.reason}); ` +
    `DramaFetch waits until ${clockTime(cooldown.until)} ` +
    `(${minutesLeft(cooldown, now)} min left) before contacting TikTok again ` +
    `— ${options.lift ?? EXTENSION_LIFT_TEXT}`
  );
}

/**
 * `cooldown until HH:MM`: the stop reason of a run that meets a cooldown right before a request,
 * and the report's `stopped` of a series refused by one (`engine._cooldown_refusal`).
 * @param {Cooldown} cooldown
 * @returns {string}
 */
export function cooldownStopReason(cooldown) {
  return `cooldown until ${clockTime(cooldown.until)}`;
}

/**
 * A {@link CooldownStore} over `chrome.storage.local`-like storage (`get(key)` → `{[key]: value}`,
 * `set({[key]: value})`, `remove(key)`), under {@link COOLDOWN_STORAGE_KEY}.
 * @param {{get(key: string): Promise<Record<string, unknown>>, set(items: Record<string, unknown>): Promise<void>,
 *   remove(key: string): Promise<void>}} area
 * @param {string} [key]
 * @returns {CooldownStore}
 */
export function storageAreaStore(area, key = COOLDOWN_STORAGE_KEY) {
  return {
    read: async () => (await area.get(key))[key],
    write: (record) => area.set({ [key]: record }),
    remove: () => area.remove(key),
  };
}
