// @ts-check
/**
 * The "do not contact the site" window after a refusal (HTTP 429 or 412 anywhere, a 403 on a page
 * or a manifest, a risk-control or verification wall): for {@link COOLDOWN_MINUTES} every start is
 * refused with the minutes left, a banner shows it, and no code path skips it — knocking again
 * right after a refusal is what makes a site's protections escalate. The record lives in
 * `chrome.storage.local` under {@link COOLDOWN_STORAGE_KEY} as `{ until, reason, source,
 * recordedAt }` (milliseconds since the epoch, `Date.now()`); the storage calls are the app's
 * (`app/storage.js`), the helpers here are pure and never throw: a missing or corrupt record
 * counts as no cooldown. The user may delete the record in Settings ("at your own risk"); the
 * extension itself never lifts it early.
 */

import { COOLDOWN_MINUTES } from "./pacing.js";

export { COOLDOWN_MINUTES };

/** The key of the record in `chrome.storage.local`. */
export const COOLDOWN_STORAGE_KEY = "cooldown";
/** Where a refusal comes from (informative; stored as given). */
export const COOLDOWN_SOURCES = Object.freeze(
  /** @type {const} */ (["dailymotion", "bilibili", "test"]),
);
/** The longest reason stored (a collapsed detail of the refusal). */
export const MAX_REASON_LEN = 200;

/**
 * @typedef {object} Cooldown A recorded refusal: the site is not contacted again before `until`.
 * @property {number} until milliseconds since the epoch
 * @property {string} reason what started it: the refusal's short detail as the engine wrote it
 *   (`HTTP 429 (manifest)`) or a failure code, collapsed and cut at 200 characters — never a
 *   rendered sentence, so the page can show it in its own language
 * @property {string} source `dailymotion`, `bilibili` (or `test`)
 * @property {number | null} recordedAt milliseconds since the epoch when the site refused; null
 *   for a record built by hand
 */

/**
 * `reason` with its whitespace collapsed to single spaces, trimmed and cut at
 * {@link MAX_REASON_LEN} characters (`…` last); `request refused` when empty.
 * @param {unknown} reason
 * @returns {string}
 */
export function cleanReason(reason) {
  const text = String(reason ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "request refused";
  const chars = Array.from(text);
  if (chars.length > MAX_REASON_LEN) return `${chars.slice(0, MAX_REASON_LEN - 1).join("")}…`;
  return text;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function asEpochMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The cooldown a refusal starts — the record to store as it is: `until` = `now` + `minutes`.
 * @param {string} reason the refusal's short detail (`HTTP 429 (manifest)`) or its code
 * @param {string} source {@link COOLDOWN_SOURCES}
 * @param {{ now?: number, minutes?: number }} [options] `now` in milliseconds (`Date.now()`)
 * @returns {Cooldown}
 */
export function makeCooldown(reason, source, options = {}) {
  const recordedAt = options.now ?? Date.now();
  const minutes = options.minutes ?? COOLDOWN_MINUTES;
  return {
    until: recordedAt + minutes * 60_000,
    reason: cleanReason(reason),
    source: String(source),
    recordedAt,
  };
}

/**
 * The cooldown a stored record holds, active or expired; null when the record is missing, not an
 * object or has no numeric `until`. Never throws.
 * @param {unknown} raw what `chrome.storage.local` gave for {@link COOLDOWN_STORAGE_KEY}
 * @returns {Cooldown | null}
 */
export function parseCooldown(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = /** @type {Record<string, unknown>} */ (raw);
  const until = asEpochMs(record["until"]);
  if (until === null) return null;
  const reason = record["reason"];
  const source = record["source"];
  return {
    until,
    reason: typeof reason === "string" ? cleanReason(reason) : "",
    source: typeof source === "string" ? source : "",
    recordedAt: asEpochMs(record["recordedAt"]),
  };
}

/**
 * Whether the cooldown is still in force at `now`.
 * @param {Cooldown} cooldown
 * @param {number} [now] milliseconds since the epoch
 * @returns {boolean}
 */
export function isActive(cooldown, now = Date.now()) {
  return cooldown.until > now;
}

/**
 * The cooldown in force at `now`, or null when the stored record is missing, corrupt or expired:
 * what every start asks before contacting a site.
 * @param {number} now milliseconds since the epoch (`Date.now()`)
 * @param {unknown} stored the stored record (or undefined)
 * @returns {Cooldown | null}
 */
export function activeCooldown(now, stored) {
  const cooldown = parseCooldown(stored);
  return cooldown !== null && isActive(cooldown, now) ? cooldown : null;
}

/**
 * Whole seconds until the cooldown ends (0 once it has), e.g. for a banner's countdown.
 * @param {Cooldown} cooldown
 * @param {number} [now]
 * @returns {number}
 */
export function secondsLeft(cooldown, now = Date.now()) {
  return Math.max(0, Math.ceil((cooldown.until - now) / 1000));
}

/**
 * Whole minutes until the cooldown ends, rounded up (0 once it has): "N min left".
 * @param {Cooldown} cooldown
 * @param {number} [now]
 * @returns {number}
 */
export function minutesLeft(cooldown, now = Date.now()) {
  return Math.ceil(secondsLeft(cooldown, now) / 60);
}

/**
 * When the site refused: `recordedAt` when known, else `until` minus the default window.
 * @param {Cooldown} cooldown
 * @returns {number}
 */
export function startedAt(cooldown) {
  return cooldown.recordedAt ?? cooldown.until - COOLDOWN_MINUTES * 60_000;
}

/**
 * `HH:MM` in local time for a moment in milliseconds since the epoch.
 * @param {number} epochMs
 * @returns {string}
 */
export function clockTime(epochMs) {
  const date = new Date(epochMs);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * @typedef {object} CooldownMessageParams The parameters of the `cooldown` failure code
 *   (`messages.render("cooldown", params)`, the `_locales` `failure_cooldown` text).
 * @property {string} until `HH:MM`, local time
 * @property {number} minutes_left rounded up
 * @property {string} reason
 * @property {string} source
 */

/**
 * The parameters of the `cooldown` failure code for the cooldown in force at `now`, or null when
 * none is: what the banner and a refused start render.
 * @param {unknown} stored the stored record (or undefined)
 * @param {number} [now] milliseconds since the epoch
 * @returns {CooldownMessageParams | null}
 */
export function cooldownMessageParams(stored, now = Date.now()) {
  const cooldown = activeCooldown(now, stored);
  if (cooldown === null) return null;
  return {
    until: clockTime(cooldown.until),
    minutes_left: minutesLeft(cooldown, now),
    reason: cooldown.reason || "request refused",
    source: cooldown.source,
  };
}

/**
 * The `cooldown` failure of a start refused by the cooldown in force at `now` (what the rows of a
 * refused run and the report carry), or null when none is in force.
 * @param {unknown} stored
 * @param {number} [now]
 * @returns {import("./messages.js").Failure | null}
 */
export function cooldownFailure(stored, now = Date.now()) {
  const params = cooldownMessageParams(stored, now);
  return params === null ? null : { code: "cooldown", params: { ...params } };
}

/**
 * `cooldown until HH:MM`: the stop reason of a run that meets a cooldown right before a request.
 * @param {Cooldown} cooldown
 * @returns {string}
 */
export function cooldownStopReason(cooldown) {
  return `cooldown until ${clockTime(cooldown.until)}`;
}

/**
 * `until HH:MM (N min left): <reason>` for status displays and the history.
 * @param {Cooldown} cooldown
 * @param {number} [now]
 * @returns {string}
 */
export function cooldownSummary(cooldown, now = Date.now()) {
  const left = minutesLeft(cooldown, now);
  return `until ${clockTime(cooldown.until)} (${left} min left): ${cooldown.reason}`;
}
