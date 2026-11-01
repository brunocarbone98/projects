// @ts-check
/**
 * The per-series state the extension keeps in `chrome.storage.local`: a port of `manifest.py`'s
 * `Manifest` semantics over a plain object in the very format of `dramafetch.json` — `{"version":
 * 1, "series_id", "series_name", "episodes": {"1": {number, item_id, status, path, message,
 * updated_at}}, "complete_at", "complete_episodes"}` — plus each entry's `download_id` (Chrome's
 * id of the saved file). Pure: the caller loads and saves the object; whether a recorded file
 * still exists is an injected answer ({@link FileExists}, from `chrome.downloads.search`).
 *
 * The rules kept from the Python tool: a skip never downgrades a `done` entry whose file still
 * exists; any new attempt (a result that is not a skip) forgets the complete mark; `done` and
 * `skipped-exists` entries count as on disk while their file exists; a DRM verdict of a DOWNLOAD
 * is remembered (`drmProtected`), a payload's DRM flag never is.
 */

import {
  DONE,
  DRM_MESSAGE,
  DRM_REMEMBERED_MESSAGE,
  DRY_RUN,
  FAILED_UNAVAILABLE,
  PY_SPACE,
  SKIPPED_EXISTS,
  SKIPPED_LOCKED,
  decimalDigitValue,
  pyScalarText,
} from "./messages.js";

/** The `version` of the state format (`manifest.MANIFEST_VERSION`). */
export const STATE_VERSION = 1;
/** Results that mean "nothing was attempted": they never overwrite a finished download's entry. */
const NON_ATTEMPT_STATUSES = new Set([SKIPPED_EXISTS, SKIPPED_LOCKED, DRY_RUN]);
/** Entry statuses that mean "the episode's file is on disk". */
const ON_DISK_STATUSES = new Set([DONE, SKIPPED_EXISTS]);
/** Entry statuses that carry a DRM verdict when their message starts with one of DRM_VERDICTS. */
const DRM_STATUSES = new Set([FAILED_UNAVAILABLE, SKIPPED_LOCKED]);
const DRM_VERDICTS = [DRM_MESSAGE, DRM_REMEMBERED_MESSAGE];

/**
 * @typedef {object} StateEntry One recorded episode outcome (`manifest.ManifestEntry`).
 * @property {number} number
 * @property {string} item_id
 * @property {string} status
 * @property {string | null} path the saved file as Chrome reported it (its full path)
 * @property {string} message
 * @property {string} updated_at ISO 8601 UTC, whole seconds
 * @property {number | null} [download_id] Chrome's download id of the saved file
 *
 * @typedef {object} SeriesState The state of one series (the `dramafetch.json` format).
 * @property {1} version
 * @property {string} series_id
 * @property {string | null} series_name
 * @property {Record<string, StateEntry>} episodes keyed by the episode number
 * @property {string | null} [complete_at] when a run last found the series complete
 * @property {number | null} [complete_episodes] how many episodes were on disk then
 *
 * @callback FileExists Whether the file an entry recorded is still on disk.
 * @param {StateEntry} entry
 * @returns {boolean}
 *
 * @typedef {object} RecordedResult What {@link record} stores of a result.
 * @property {{number: number, itemId: string}} episode
 * @property {string} status
 * @property {string | null} [path]
 * @property {string} message
 * @property {number | null} [downloadId]
 */

/**
 * An empty state for a series (a new `Manifest`).
 * @param {string} seriesId
 * @param {string | null} [seriesName]
 * @returns {SeriesState}
 */
export function newState(seriesId, seriesName = null) {
  return {
    version: STATE_VERSION,
    series_id: String(seriesId),
    series_name: seriesName,
    episodes: {},
    complete_at: null,
    complete_episodes: null,
  };
}

/**
 * The stored state of a series, read without any side effect (`manifest.read_manifest` /
 * `_parse_manifest`): null for anything that is not a version-1 state of `seriesId`; entries that
 * do not parse are dropped, and an odd completeness memory is forgotten (never a reason to call the
 * state corrupt).
 * @param {unknown} raw
 * @param {string} seriesId
 * @returns {SeriesState | null}
 */
export function readState(raw, seriesId) {
  if (!isDict(raw) || get(raw, "version") !== STATE_VERSION) return null;
  if (pyStr(get(raw, "series_id")) !== String(seriesId)) return null;
  const episodes = get(raw, "episodes");
  if (!isDict(episodes)) return null;
  const storedName = get(raw, "series_name");
  /** @type {Record<string, StateEntry>} */
  const entries = {};
  for (const [key, value] of Object.entries(episodes)) {
    const entry = parseEntry(key, value);
    if (entry !== null) entries[String(entry.number)] = entry;
  }
  let completeAt = get(raw, "complete_at");
  let completeEpisodes = get(raw, "complete_episodes");
  if (typeof completeAt !== "string" || epochOf(completeAt) === null) completeAt = null;
  if (
    completeAt === null ||
    typeof completeEpisodes !== "number" ||
    !Number.isInteger(completeEpisodes) ||
    completeEpisodes < 0
  ) {
    completeAt = null;
    completeEpisodes = null;
  }
  return {
    version: STATE_VERSION,
    series_id: String(seriesId),
    series_name: typeof storedName === "string" && storedName ? storedName : null,
    episodes: entries,
    complete_at: /** @type {string | null} */ (completeAt),
    complete_episodes: /** @type {number | null} */ (completeEpisodes),
  };
}

/**
 * The state a run works with (`Manifest.load`): the stored one, or an empty one when there is none
 * or it does not parse; `seriesName` (the name of the fresh list) wins over the stored name.
 * @param {unknown} raw
 * @param {string} seriesId
 * @param {string | null} [seriesName]
 * @returns {SeriesState}
 */
export function loadState(raw, seriesId, seriesName = null) {
  const state = readState(raw, seriesId) ?? newState(seriesId, seriesName);
  if (seriesName !== null) state.series_name = seriesName;
  return state;
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {StateEntry | null}
 */
function parseEntry(key, value) {
  const number = pyIntOfText(key);
  if (number === null || !isDict(value)) return null;
  const status = get(value, "status");
  if (typeof status !== "string") return null;
  const path = get(value, "path");
  const message = get(value, "message");
  const updatedAt = get(value, "updated_at");
  const downloadId = get(value, "download_id");
  return {
    number,
    item_id: Object.hasOwn(value, "item_id") ? pyStr(value["item_id"]) : "",
    status,
    path: typeof path === "string" && path ? path : null,
    message: typeof message === "string" ? message : "",
    updated_at: typeof updatedAt === "string" ? updatedAt : "",
    download_id: typeof downloadId === "number" && Number.isInteger(downloadId) ? downloadId : null,
  };
}

const PY_INT_TEXT_RE = new RegExp(`^[${PY_SPACE}]*([+-]?)(\\p{Nd}+(?:_\\p{Nd}+)*)[${PY_SPACE}]*$`, "u");

/**
 * Python's `int(text)` for a str (sign, Unicode decimal digits, single underscores between
 * digits, surrounding whitespace), null where it raises.
 * @param {string} text
 * @returns {number | null}
 */
function pyIntOfText(text) {
  const match = PY_INT_TEXT_RE.exec(text);
  if (match === null) return null;
  let digits = "";
  for (const ch of /** @type {string} */ (match[2])) if (ch !== "_") digits += String(decimalDigitValue(ch));
  if (digits.length > 4300) return null;
  const value = Number(digits);
  return match[1] === "-" ? -value : value;
}

/**
 * Python's `str(value)` for a JSON value (`None`, `True`, numbers as Python prints them).
 * @param {unknown} value
 * @returns {string}
 */
function pyStr(value) {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return pyScalarText(value);
  }
  return JSON.stringify(value);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} dict
 * @param {string} key
 * @returns {unknown}
 */
function get(dict, key) {
  return Object.hasOwn(dict, key) ? dict[key] : undefined;
}

/**
 * The entry of an episode number, or null.
 * @param {SeriesState} state
 * @param {number} number
 * @returns {StateEntry | null}
 */
export function entryOf(state, number) {
  const key = String(number);
  return Object.hasOwn(state.episodes, key) ? /** @type {StateEntry} */ (state.episodes[key]) : null;
}

/**
 * Every entry, ascending by number.
 * @param {SeriesState} state
 * @returns {StateEntry[]}
 */
export function sortedEntries(state) {
  return Object.values(state.episodes).sort((a, b) => a.number - b.number);
}

/**
 * The episode's file when the state says `done` and the file still exists (`Manifest.done_path`).
 * @param {SeriesState} state
 * @param {number} number
 * @param {FileExists} exists
 * @returns {string | null}
 */
export function donePath(state, number, exists) {
  const entry = entryOf(state, number);
  if (entry === null || entry.status !== DONE || !entry.path) return null;
  return exists(entry) ? entry.path : null;
}

/**
 * Recorded as done AND the recorded file is still there (`Manifest.is_done`).
 * @param {SeriesState} state
 * @param {number} number
 * @param {FileExists} exists
 * @returns {boolean}
 */
export function isDone(state, number, exists) {
  return donePath(state, number, exists) !== null;
}

/**
 * `[number, file]` for every episode the state knows to be on disk — a `done` entry, or a
 * `skipped-exists` one with the file a run found — whose file still exists, ascending.
 * @param {SeriesState} state
 * @param {FileExists} exists
 * @returns {[number, string][]}
 */
export function doneEntries(state, exists) {
  /** @type {[number, string][]} */
  const found = [];
  for (const entry of sortedEntries(state)) {
    if (!ON_DISK_STATUSES.has(entry.status) || !entry.path) continue;
    if (exists(entry)) found.push([entry.number, entry.path]);
  }
  return found;
}

/**
 * Numbers of the entries {@link doneEntries} would count whose file is gone: a series with any of
 * them is not complete any more (`Manifest.missing_files`).
 * @param {SeriesState} state
 * @param {FileExists} exists
 * @returns {number[]}
 */
export function missingFiles(state, exists) {
  return sortedEntries(state)
    .filter((entry) => ON_DISK_STATUSES.has(entry.status) && entry.path && !exists(entry))
    .map((entry) => entry.number);
}

/**
 * Numbers of the entries recorded `skipped-locked`, ascending (`Manifest.locked_numbers`).
 * @param {SeriesState} state
 * @returns {number[]}
 */
export function lockedNumbers(state) {
  return sortedEntries(state)
    .filter((entry) => entry.status === SKIPPED_LOCKED)
    .map((entry) => entry.number);
}

/**
 * Whether an earlier run's DOWNLOAD found the episode protected by DRM (`Manifest.drm_protected`):
 * its entry is `failed-unavailable` or `skipped-locked` and its message starts with `DRM_MESSAGE`
 * or `DRM_REMEMBERED_MESSAGE`. A payload's DRM flag (`lockedResult`) is never remembered.
 * @param {SeriesState} state
 * @param {number} number
 * @returns {boolean}
 */
export function drmProtected(state, number) {
  const entry = entryOf(state, number);
  return (
    entry !== null &&
    DRM_STATUSES.has(entry.status) &&
    DRM_VERDICTS.some((verdict) => entry.message.startsWith(verdict))
  );
}

/**
 * Store one result, replacing any earlier entry for the number (`Manifest.record`) — except that
 * a skip never downgrades a `done` entry whose file still exists (resumed runs report those
 * episodes as `skipped-exists`). A result that is not a skip forgets the complete mark. Returns
 * whether the state changed (the caller then saves it).
 * @param {SeriesState} state
 * @param {RecordedResult} result
 * @param {{exists: FileExists, now?: number}} context `now` in seconds since the epoch
 * @returns {boolean}
 */
export function record(state, result, context) {
  const { number } = result.episode;
  const attempt = !NON_ATTEMPT_STATUSES.has(result.status);
  if (!attempt && isDone(state, number, context.exists)) return false;
  if (attempt) {
    // A new attempt means the series changed: it has to be found complete again before a skip.
    state.complete_at = null;
    state.complete_episodes = null;
  }
  state.episodes[String(number)] = {
    number,
    item_id: result.episode.itemId,
    status: result.status,
    path: result.path ?? null,
    message: result.message,
    updated_at: isoUtc(Math.floor(context.now ?? Date.now() / 1000)),
    download_id: result.downloadId ?? null,
  };
  return true;
}

/**
 * Remember that a run found the series complete at `when` (seconds since the epoch) with
 * `episodes` on disk (`Manifest.mark_complete`); cleared by the next attempt.
 * @param {SeriesState} state
 * @param {number} when
 * @param {number} episodes
 */
export function markComplete(state, when, episodes) {
  state.complete_at = isoUtc(when);
  state.complete_episodes = Math.trunc(episodes);
}

/**
 * Forget that the series was complete (`Manifest.clear_complete`); whether anything changed.
 * @param {SeriesState} state
 * @returns {boolean}
 */
export function clearComplete(state) {
  if ((state.complete_at ?? null) === null && (state.complete_episodes ?? null) === null) return false;
  state.complete_at = null;
  state.complete_episodes = null;
  return true;
}

/**
 * `complete_at` as seconds since the epoch, null when unset or unreadable (`Manifest.complete_since`).
 * @param {SeriesState} state
 * @returns {number | null}
 */
export function completeSince(state) {
  const text = state.complete_at ?? null;
  return text === null ? null : epochOf(text);
}

/**
 * `when` (seconds since the epoch) as `YYYY-MM-DDTHH:MM:SSZ`, the fraction dropped the way
 * `manifest._iso_utc` drops it (rounded to microseconds first, as `datetime.fromtimestamp`).
 * @param {number} when
 * @returns {string}
 */
export function isoUtc(when) {
  let seconds = Math.floor(when);
  if (Math.round((when - seconds) * 1e6) >= 1_000_000) seconds += 1;
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const ISO_RE =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,6}))?)?)?(Z|[+-][0-9]{2}:[0-9]{2})?$/;

/**
 * Seconds since the epoch of an ISO 8601 time as {@link isoUtc} writes it (`manifest._epoch_of`
 * over `datetime.fromisoformat`, for the forms the extension writes and the usual variants: a date,
 * minutes, seconds, a fraction, `Z` or `±HH:MM`; a naive time is UTC); null for anything else.
 * @param {string} text
 * @returns {number | null}
 */
export function epochOf(text) {
  const match = ISO_RE.exec(text);
  if (match === null) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "", zone = "Z"] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59) {
    return null;
  }
  let offset = 0;
  if (zone !== "Z") {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offset = (zone.startsWith("-") ? -1 : 1) * (oh * 3600 + om * 60);
  }
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, 0);
  return date.getTime() / 1000 + (fraction ? Number(`0.${fraction}`) : 0) - offset;
}

/**
 * @param {number} year
 * @param {number} month 1-12
 * @returns {number}
 */
function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return /** @type {number} */ ([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]);
}
