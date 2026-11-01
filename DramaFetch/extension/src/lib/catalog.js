// @ts-check
/**
 * Pure parsing of TikTok's short-drama payloads: a line-by-line port of `catalog.py`. No I/O,
 * no network, no `chrome.*`, no DOM.
 *
 * TikTok facts it encodes (verified October 2026, see `catalog.py`): the web app lists a series
 * through `GET /api/drama/episode/item_list/?dramaID=<id>&cursor=<c>&count=<n>&…`, answering
 * `{"itemList": [...], "cursor": 30, "hasMore": true}` (sometimes nested, so {@link findItemLists}
 * searches recursively); `dramaInfo.DramaVideoData.EpisodeNumber` is the only reliable order;
 * every item carries the signed play URLs of its renditions (`video.bitrateInfo[*].PlayAddr`,
 * `video.playAddr`) and its cover (`video.originCover` / `cover` / `dynamicCover`).
 *
 * What THIS session may play is decided by {@link accessOf} from the payload TikTok served to
 * the user's own logged-in session — `free`, `unlocked` (sold, and this account may play it) or
 * `locked` (listed and skipped). Nothing here unlocks, buys, fakes or sends anything back.
 *
 * Python semantics are kept where they decide: dict keys are own properties only, strings are
 * stripped with Python's whitespace set, `re.IGNORECASE` is emulated with
 * {@link caseless}, `\d` is any Unicode decimal digit, lengths count code points. JSON numbers
 * are JavaScript numbers: a whole number counts as an int (TikTok never sends `1.0`), integers
 * beyond 2^53 lose precision, and integer-like keys (`"1"`) enumerate first in JavaScript.
 */

import {
  PY_SPACE,
  QUALITY_MODES,
  caseless,
  pyDecimalInt,
  pyHead,
  pyLen,
  pyRepr,
  pyScalarText,
  pyStrip,
} from "./messages.js";

/** How deep the recursive searches descend into a payload before giving up. */
export const MAX_DEPTH = 12;
/** The hint of an item THIS session's payload gives no play address for. */
export const NO_PLAY_ADDRESS = "no play address";
/** Codec of a rendition whose `CodecType` is missing. */
export const UNKNOWN_CODEC = "unknown";
/** Height part of a label when neither the `GearName` nor `video.ratio` tells it. */
export const UNKNOWN_HEIGHT = "?p";

/**
 * @typedef {"free" | "unlocked" | "locked"} Access
 *
 * @typedef {object} Episode One episode, as the `item_list` payload describes it (`models.Episode`).
 * @property {number} number `dramaInfo.DramaVideoData.EpisodeNumber`, 1-based
 * @property {string} itemId the ordinary TikTok video id of the episode
 * @property {string} title
 * @property {string} seriesId
 * @property {string | null} seriesName
 * @property {string | null} author
 * @property {number | null} durationS
 * @property {string[]} lockHints every pricing / lock / entitlement / DRM clue, `key=value`
 * @property {string | null} coverUrl
 * @property {string | null} qualityHint the label of the rendition `compatible` takes, e.g. `720p h264`
 * @property {Access} access
 * @property {boolean} paid a pricing or entitlement clue is present
 * @property {boolean} drm the payload itself flags DRM (then always `locked`)
 * @property {Record<string, unknown> | null} raw the item payload (null for an episode built by hand)
 *
 * @typedef {object} Rendition One `video.bitrateInfo` entry with at least one play URL.
 * @property {string[]} urlList
 * @property {string} codec `h264`, `h265`, `bytevc1`, the lower-cased raw `CodecType` or `unknown`
 * @property {number} bitrate bit/s, 0 when absent
 * @property {number | null} heightHint
 * @property {string} label `720p h264`, `?p h264`
 *
 * @typedef {object} PagePayload What one `item_list` page contributed for the requested series.
 * @property {Episode[]} episodes
 * @property {number | string | null} cursor
 * @property {boolean} hasMore
 * @property {number} seenItems
 * @property {number} skippedItems
 *
 * @typedef {object} AccessDecision The result of {@link accessOf}.
 * @property {Access} access
 * @property {boolean} paid
 * @property {boolean} drm
 * @property {string[]} hints
 *
 * @typedef {object} Series A resolved series, as the discovery builds it (`models.Series`).
 * @property {string} seriesId
 * @property {string | null} name
 * @property {Episode[]} episodes
 * @property {number | null} totalHint
 * @property {string[]} warnings
 */

const ITEM_LIST_KEYS = ["itemList", "item_list"];
// The key patterns of access_of, written lower-case and matched against `caseless(key)`: that is
// re.IGNORECASE as Python's re applies it to these ASCII patterns.
/** The key-name heuristic of the builds before the access model (matched without block words). */
const LOCK_KEY_RE = /lock|paid|needpay|unlock|price|coin|vip|preview/;
const FREE_KEY_RE = /free/;
const DRM = "drm";
const ENTITLED = "entitled";
const NOT_ENTITLED = "not-entitled";
const VIEWER_LOCK = "viewer-lock";
const AMBIGUOUS = "ambiguous";
const PRICING = "pricing";
/** One word of a key: see {@link keyWords}. Case-sensitive, ASCII only. */
const KEY_WORD_RE = /[A-Z]+s(?![a-z])|[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g;
const DRM_NEGATION_WORDS = new Set(["free", "no", "non", "not", "un", "without"]);
const DRM_ID_WORDS = new Set(["id", "ids", "uid", "uids"]);
/** Matched against the FULL key: `isUnlocked`, `is_purchased`, `hasPaid`, `paidByUser`, … */
const ENTITLED_KEY_RE =
  /^(?:(?:is_?)?(?:unlocked|purchased|bought|entitled)|has_?(?:paid|purchased|unlocked|bought|access)|paid_?by_?(?:user|viewer|me))$/;
/** Matched against the FULL key: `isLocked`, `is_locked`, `locked`. */
const LOCKED_KEY_RE = /^(?:is_?)?locked$/;
const VIEWER_LOCK_KEY_RE = /need_?(?:pay|unlock|buy|purchase)|preview|trial|paywall/;
/** `lockStatus` / `lock_status` — not `unlockStatus`, not `blockStatus` (block words removed). */
const LOCK_STATUS_KEY_RE = /(?<!un)lock_?status/;
/** A string that spells a number or a bool: a `lock_?status` key reads it as that. */
const NUMBER_OR_BOOL_TEXT_RE = /^(?:[+-]?[0-9]+(?:\.[0-9]+)?|true|yes)$/;
const STATUS_KEY_RE = /(?:unlock|pay|purchase)_?status/;
const ENTITLED_STATUS_VALUES = new Set(["unlocked", "paid", "purchased", "bought", "entitled"]);
const LOCKED_STATUS_VALUES = new Set(["locked", "lock", "need_pay", "needpay", "unpaid", "unpurchased"]);
const KNOWN_STATUS_VALUES = new Set([...ENTITLED_STATUS_VALUES, ...LOCKED_STATUS_VALUES]);
const PRICE_KEY_RE = /price|coin|cost|charge/;
const SOLD_KEY_RE = /vip|paid/;
const SERIES_ID_KEYS = ["dramaID", "dramaId", "DramaID", "albumId"];
const EPISODE_NUMBER_KEYS = ["EpisodeNumber", "episodeNumber", "episode_number"];
const NAME_KEYS = ["dramaName", "title", "name"];
const TOTAL_KEYS = ["totalEpisode", "totalEpisodes", "episodeCount", "total", "episodeTotal"];
const DETAIL_CONTAINER_KEYS = ["dramaInfo", "drama", "detail"];
/** Where an item's cover lives, best first: the full frame, the cropped poster, the animated preview. */
const COVER_KEYS = ["originCover", "cover", "dynamicCover"];
const FALSY_STRINGS = new Set(["", "0", "false", "no", "none", "null"]);
const MAX_HINT_VALUE_LEN = 40;

// ------------------------------------------------------------------------ Python dict semantics

/**
 * Python's `isinstance(value, dict)` for a JSON value: a plain object, not an array, not null.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * `dict.get(key)`: the OWN property only (`"toString"` is no key of `{}`), undefined when absent.
 * @param {Record<string, unknown>} dict
 * @param {string} key
 * @returns {unknown}
 */
function get(dict, key) {
  return Object.hasOwn(dict, key) ? dict[key] : undefined;
}

/**
 * Python's `isinstance(value, bool | int | float | str)`.
 * @param {unknown} value
 * @returns {value is boolean | number | string}
 */
function isScalar(value) {
  return typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

/**
 * Python's `isinstance(value, dict | list)`.
 * @param {unknown} value
 * @returns {boolean}
 */
function isContainer(value) {
  return Array.isArray(value) || isDict(value);
}

// ------------------------------------------------------------------------ item lists

/**
 * Every `itemList` (list of item dicts) found in the payload, in document order; recursive
 * through dicts and lists, depth-limited, never descending into a list once identified as an item
 * list. Non-dict entries are dropped.
 * @param {unknown} payload
 * @param {number} [maxDepth]
 * @returns {Record<string, unknown>[][]}
 */
export function findItemLists(payload, maxDepth = MAX_DEPTH) {
  /** @type {Record<string, unknown>[][]} */
  const found = [];
  walkItemLists(payload, 0, maxDepth, found);
  return found;
}

/**
 * @param {unknown} node
 * @param {number} depth
 * @param {number} maxDepth
 * @param {Record<string, unknown>[][]} found
 */
function walkItemLists(node, depth, maxDepth, found) {
  if (depth > maxDepth) return;
  if (isDict(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (ITEM_LIST_KEYS.includes(key) && Array.isArray(value)) {
        found.push(value.filter(isDict));
      } else {
        walkItemLists(value, depth + 1, maxDepth, found);
      }
    }
  } else if (Array.isArray(node)) {
    for (const value of node) walkItemLists(value, depth + 1, maxDepth, found);
  }
}

// ------------------------------------------------------------------------ access

/**
 * What THIS session may do with an episode: `{access, paid, drm, hints}` (`catalog.access_of`).
 *
 * Pure and deterministic; never throws on junk. Scanned: the item's top-level scalars (an
 * `itemStruct` wrapper's too, the outer key winning), `dramaInfo` recursively ({@link MAX_DEPTH})
 * and `video`'s top-level scalars; keys case-insensitive. The clue classes — DRM (a key that names
 * DRM in whole words, {@link isDrmKey}, truthy), ENTITLED (`(is_?)?(unlocked|purchased|bought|
 * entitled)`, `has_?(paid|purchased|unlocked|bought|access)`, `paid_?by_?(user|viewer|me)`, truthy;
 * or a status string `unlocked` `paid` `purchased` `bought` `entitled`), NOT-ENTITLED (one of those
 * full keys, falsy), VIEWER-LOCK (`(is_?)?locked`; `need_?(pay|unlock|buy|purchase)`, `preview`,
 * `trial`, `paywall`; a `lock_?status` bool or number or a string spelling one, truthy; a status
 * string `locked` `lock` `need_pay` `needpay` `unpaid` `unpurchased`), AMBIGUOUS (never decides),
 * PRICING (a falsy `free` key; `price` `coin` `cost` `charge` above 0; `vip` / `paid` outside the
 * entitled keys; the old heuristic's leftovers — "block" is not "lock") and PLAY (no play address).
 *
 * Decision, first match wins: DRM → `locked` with `drm`; ENTITLED → `unlocked`; VIEWER-LOCK or no
 * play address → `locked`; PRICING → `unlocked` with a real play URL ({@link playUrlCandidates})
 * and no NOT-ENTITLED clue, else `locked` (without a URL, hint {@link NO_PLAY_ADDRESS}); else
 * `free`. `paid` is any PRICING or ENTITLED clue; `hints` are unique, in scan order.
 * @param {unknown} item
 * @returns {AccessDecision}
 */
export function accessOf(item) {
  const dict = isDict(item) ? item : {};
  /** @type {[string, string][]} */
  const clues = [];
  for (const [key, value] of topLevelScalars(dict)) clues.push(...cluesOf(key, value));
  const dramaInfo = field(dict, "dramaInfo");
  if (isDict(dramaInfo)) collectClues(dramaInfo, 0, clues);
  const video = field(dict, "video");
  if (isDict(video)) {
    for (const [key, value] of Object.entries(video)) clues.push(...cluesOf(key, value));
  }
  const playable = isDict(video) && hasPlayAddress(video);
  const classes = new Set(clues.map(([kind]) => kind));
  const hints = clues.map(([, hint]) => hint);
  if (!playable) hints.push(NO_PLAY_ADDRESS);
  const drm = classes.has(DRM);
  /** @type {Access} */
  let access;
  if (drm) {
    access = "locked";
  } else if (classes.has(ENTITLED)) {
    access = "unlocked";
  } else if (classes.has(VIEWER_LOCK) || !playable) {
    access = "locked";
  } else if (classes.has(PRICING)) {
    // Sold: unlocked only for a real play URL this session got and no entitlement flag saying no.
    if (playUrlCandidates(dict).length === 0) {
      access = "locked";
      hints.push(NO_PLAY_ADDRESS);
    } else {
      access = classes.has(NOT_ENTITLED) ? "locked" : "unlocked";
    }
  } else {
    access = "free";
  }
  const paid = classes.has(PRICING) || classes.has(ENTITLED);
  return { access, paid, drm, hints: [...new Set(hints)] };
}

/**
 * Every pricing, lock, entitlement and DRM clue of an item (the `hints` of {@link accessOf}).
 * @param {unknown} item
 * @returns {string[]}
 */
export function lockHints(item) {
  return accessOf(item).hints;
}

/**
 * The item's own scalar `[key, value]` pairs, then those of an `itemStruct` wrapper whose key the
 * item itself lacks.
 * @param {Record<string, unknown>} item
 * @returns {[string, unknown][]}
 */
function topLevelScalars(item) {
  /** @type {[string, unknown][]} */
  const pairs = Object.entries(item).filter(([, value]) => !isContainer(value));
  const inner = get(item, "itemStruct");
  if (isDict(inner)) {
    for (const [key, value] of Object.entries(inner)) {
      if (!Object.hasOwn(item, key) && !isContainer(value)) pairs.push([key, value]);
    }
  }
  return pairs;
}

/**
 * @param {unknown} node
 * @param {number} depth
 * @param {[string, string][]} clues
 */
function collectClues(node, depth, clues) {
  if (depth > MAX_DEPTH) return;
  if (isDict(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (isContainer(value)) collectClues(value, depth + 1, clues);
      else clues.push(...cluesOf(key, value));
    }
  } else if (Array.isArray(node)) {
    for (const value of node) collectClues(value, depth + 1, clues);
  }
}

/**
 * The lower-case words of a payload key, in order: camelCase / PascalCase split at every capital,
 * an acronym run kept whole (`DRMType` → `drm`, `type`), its plural too (`encryptedIDs` →
 * `encrypted`, `ids`), snake_case and kebab-case at their separators, digits on their own.
 * Anything that is not an ASCII letter or digit separates.
 * @param {string} key
 * @returns {string[]}
 */
export function keyWords(key) {
  return (key.match(KEY_WORD_RE) ?? []).map((word) => word.toLowerCase());
}

/**
 * Whether a payload key names DRM: one of its {@link keyWords} is `drm` or starts with
 * `encrypt`, and none is a negation (`free` `no` `non` `not` `un` `without`) or an identifier
 * (`id` `ids` `uid` `uids`). Precision over recall: the media check is the real guard.
 * @param {string} key
 * @returns {boolean}
 */
export function isDrmKey(key) {
  const words = keyWords(key);
  if (!words.some((word) => word === "drm" || word.startsWith("encrypt"))) return false;
  return !words.some((word) => DRM_NEGATION_WORDS.has(word) || DRM_ID_WORDS.has(word));
}

/**
 * `key` with each of its {@link keyWords} that contains `block` turned into `_`: "block" is not
 * "lock" (`blockStatus`, `isBlocked` give no clue), while `subLockStatus` or `webLock` still do.
 * @param {string} key
 * @returns {string}
 */
function withoutBlockWords(key) {
  return key.replace(KEY_WORD_RE, (word) => (word.toLowerCase().includes("block") ? "_" : word));
}

/**
 * The `[class, hint]` clues one scalar `key: value` gives; empty for a value that is not a bool,
 * a number or a string.
 * @param {string} key
 * @param {unknown} value
 * @returns {[string, string][]}
 */
function cluesOf(key, value) {
  if (!isScalar(value)) return [];
  const hint = `${key}=${formatHintValue(value)}`;
  const truthy = isTruthy(value);
  const folded = caseless(key);
  const entitledKey = ENTITLED_KEY_RE.test(folded);
  const statusKey = STATUS_KEY_RE.test(folded);
  const lockKey = caseless(withoutBlockWords(key)); // "block" is not "lock"
  const lockStatusKey = LOCK_STATUS_KEY_RE.test(lockKey);
  // a lockStatus string that spells a number or a bool ("1", "true") is that number or bool
  const isText =
    typeof value === "string" &&
    !(lockStatusKey && NUMBER_OR_BOOL_TEXT_RE.test(caseless(pyStrip(value))));
  // a status STRING decides through the two value sets, for lockStatus as for unlockStatus
  const status =
    (statusKey || lockStatusKey) && typeof value === "string" ? pyStrip(value).toLowerCase() : null;
  /** @type {[string, string][]} */
  const found = [];
  if (truthy && isDrmKey(key)) found.push([DRM, hint]);
  if ((truthy && entitledKey) || (status !== null && ENTITLED_STATUS_VALUES.has(status))) {
    found.push([ENTITLED, hint]);
  } else if (entitledKey) {
    found.push([NOT_ENTITLED, hint]); // falsy: the payload says the account has NOT unlocked it
  }
  const viewerLockKey =
    LOCKED_KEY_RE.test(folded) || VIEWER_LOCK_KEY_RE.test(folded) || (lockStatusKey && !isText);
  if ((truthy && viewerLockKey) || (status !== null && LOCKED_STATUS_VALUES.has(status))) {
    found.push([VIEWER_LOCK, hint]);
  }
  if (statusKey && !isText) {
    found.push([AMBIGUOUS, hint]);
  } else if (lockStatusKey && isText && truthy && !KNOWN_STATUS_VALUES.has(status ?? "")) {
    found.push([AMBIGUOUS, hint]); // a lockStatus string neither set knows: a hint only
  }
  const sold =
    (PRICE_KEY_RE.test(folded) && isPositive(value)) ||
    (truthy && !entitledKey && SOLD_KEY_RE.test(folded)) ||
    // the old heuristic's leftovers, for a key no class above turned into a clue
    (truthy && found.length === 0 && LOCK_KEY_RE.test(lockKey));
  if (FREE_KEY_RE.test(folded) && !truthy) found.push([PRICING, "isFree=false"]);
  else if (sold) found.push([PRICING, hint]);
  return found;
}

/**
 * A price that means "sold": a number above 0, `true`, or a truthy string.
 * @param {boolean | number | string} value
 * @returns {boolean}
 */
function isPositive(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  return isTruthy(value);
}

/**
 * Python truthiness as `catalog._truthy` reads a payload value: `0`, `""`, `"0"`, `"false"`,
 * `"no"`, `"none"`, `"null"` (stripped, any case) are falsy.
 * @param {unknown} value
 * @returns {boolean}
 */
function isTruthy(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !FALSY_STRINGS.has(pyStrip(value).toLowerCase());
  return Boolean(value);
}

/**
 * @param {boolean | number | string} value
 * @returns {string}
 */
function formatHintValue(value) {
  const text = typeof value === "string" ? pyStrip(value) : pyScalarText(value);
  if (pyLen(text) > MAX_HINT_VALUE_LEN) return `${pyHead(text, MAX_HINT_VALUE_LEN - 1)}…`;
  return text;
}

/**
 * @param {Record<string, unknown>} video
 * @returns {boolean}
 */
function hasPlayAddress(video) {
  const playAddr = get(video, "playAddr");
  if (typeof playAddr === "string" && pyStrip(playAddr)) return true;
  const bitrateInfo = get(video, "bitrateInfo");
  return Array.isArray(bitrateInfo) && bitrateInfo.length > 0;
}

// ------------------------------------------------------------------------ episodes

/**
 * An {@link Episode} built the way `models.Episode(...)` builds one: an empty `access` derives
 * `locked` from non-empty `lockHints` (or `drm`), else `free`; an access outside `ACCESS_MODES`,
 * or `drm` without `locked`, throws (DramaFetch never decrypts).
 * @param {{number: number, itemId: string, title: string, seriesId: string,
 *   seriesName?: string | null, author?: string | null, durationS?: number | null,
 *   lockHints?: readonly string[], coverUrl?: string | null, qualityHint?: string | null,
 *   access?: string, paid?: boolean, drm?: boolean, raw?: Record<string, unknown> | null}} fields
 * @returns {Episode}
 */
export function makeEpisode(fields) {
  const lockHintsList = [...(fields.lockHints ?? [])];
  const drm = fields.drm ?? false;
  const access = fields.access || (lockHintsList.length > 0 || drm ? "locked" : "free");
  if (access !== "free" && access !== "unlocked" && access !== "locked") {
    throw new Error(`Episode.access must be one of free, unlocked, locked, not ${pyRepr(access)}`);
  }
  if (drm && access !== "locked") {
    throw new Error("a DRM-protected episode is always locked: DramaFetch never decrypts");
  }
  return {
    number: fields.number,
    itemId: fields.itemId,
    title: fields.title,
    seriesId: fields.seriesId,
    seriesName: fields.seriesName ?? null,
    author: fields.author ?? null,
    durationS: fields.durationS ?? null,
    lockHints: lockHintsList,
    coverUrl: fields.coverUrl ?? null,
    qualityHint: fields.qualityHint ?? null,
    access,
    paid: fields.paid ?? false,
    drm,
    raw: fields.raw ?? null,
  };
}

/**
 * `Episode.locked`: the payload says this session cannot play it (skipped unless includeLocked).
 * @param {{access: string}} episode
 * @returns {boolean}
 */
export function isLocked(episode) {
  return episode.access === "locked";
}

/**
 * One `itemList` entry as an {@link Episode}, or null when it must be skipped: no item id; no
 * (or invalid) `dramaInfo.DramaVideoData.EpisodeNumber` (trailers); a `dramaInfo` series id that
 * differs from `seriesId`. The item may be wrapped in `{"itemStruct": {...}}`.
 * @param {unknown} item
 * @param {string} seriesId
 * @returns {Episode | null}
 */
export function episodeFromItem(item, seriesId) {
  if (!isDict(item)) return null;
  const itemId = asId(field(item, "id"));
  if (itemId === null) return null;
  const dramaInfoRaw = field(item, "dramaInfo");
  const dramaInfo = isDict(dramaInfoRaw) ? dramaInfoRaw : {};
  const foundSeriesId = seriesIdOf(dramaInfo);
  if (foundSeriesId !== null && foundSeriesId !== String(seriesId)) return null;
  const number = episodeNumber(dramaInfo);
  if (number === null) return null;

  const seriesName = cleanStr(get(dramaInfo, "dramaName"));
  const desc = cleanStr(field(item, "desc"));
  let title;
  if (desc) title = desc;
  else if (seriesName) title = `${seriesName} E${number}`;
  else title = `Episode ${number}`;

  const authorRaw = field(item, "author");
  const author = isDict(authorRaw) ? cleanStr(get(authorRaw, "uniqueId")) : null;
  const video = field(item, "video");
  let duration = isDict(video) ? asInt(get(video, "duration")) : null;
  if (duration !== null && duration < 0) duration = null;
  const { access, paid, drm, hints } = accessOf(item);
  const chosen = chooseRendition(item);
  return makeEpisode({
    number,
    itemId,
    title,
    seriesId: String(seriesId),
    seriesName,
    author,
    durationS: duration,
    lockHints: hints,
    coverUrl: coverUrlOf(item),
    qualityHint: chosen !== null ? chosen.label : null,
    access,
    paid,
    drm,
    raw: item,
  });
}

/**
 * The episode cover of an item: the first http(s) URL under `video.originCover`, `video.cover`
 * or `video.dynamicCover` (each a string, a list or a `UrlList` dict); null when there is none.
 * @param {unknown} item
 * @returns {string | null}
 */
export function coverUrlOf(item) {
  const video = isDict(item) ? field(item, "video") : undefined;
  if (!isDict(video)) return null;
  for (const key of COVER_KEYS) {
    const urls = playUrls(get(video, key), 0);
    if (urls.length > 0) return /** @type {string} */ (urls[0]);
  }
  return null;
}

/**
 * `item[key]`, falling back to `item["itemStruct"][key]` for wrapped items.
 * @param {Record<string, unknown>} item
 * @param {string} key
 * @returns {unknown}
 */
function field(item, key) {
  if (Object.hasOwn(item, key)) return item[key];
  const inner = get(item, "itemStruct");
  return isDict(inner) ? get(inner, key) : undefined;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asId(value) {
  if (typeof value === "number") return Number.isInteger(value) ? pyScalarText(value) : null;
  if (typeof value === "string" && pyStrip(value)) return pyStrip(value);
  return null;
}

/**
 * `catalog._as_int`: an int, a whole float, or a string of Unicode decimal digits (optionally
 * negative); null otherwise (bools included).
 * @param {unknown} value
 * @returns {number | null}
 */
function asInt(value) {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string") return pyDecimalInt(pyStrip(value));
  return null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function cleanStr(value) {
  if (typeof value === "string" && pyStrip(value)) return pyStrip(value);
  return null;
}

/**
 * @param {Record<string, unknown>} dramaInfo
 * @returns {string | null}
 */
function seriesIdOf(dramaInfo) {
  for (const key of SERIES_ID_KEYS) {
    if (Object.hasOwn(dramaInfo, key)) {
      const found = asId(dramaInfo[key]);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} dramaInfo
 * @returns {number | null}
 */
function episodeNumber(dramaInfo) {
  const videoData = get(dramaInfo, "DramaVideoData");
  const containers = isDict(videoData) ? [videoData, dramaInfo] : [dramaInfo];
  for (const container of containers) {
    for (const key of EPISODE_NUMBER_KEYS) {
      if (Object.hasOwn(container, key)) {
        const number = asInt(container[key]);
        return number !== null && number >= 1 ? number : null;
      }
    }
  }
  return null;
}

/**
 * One `item_list` page: the episodes of the series, the pagination cursor and `hasMore`.
 * `cursor` is read from the top level first, else the first one found recursively (items
 * themselves are not searched); `hasMore` is true only for `hasMore`/`has_more` being `true`
 * (also `1` / `"true"`).
 * @param {unknown} payload
 * @param {string} seriesId
 * @returns {PagePayload}
 */
export function parseItemListPayload(payload, seriesId) {
  /** @type {Episode[]} */
  const episodes = [];
  let seen = 0;
  let skipped = 0;
  for (const items of findItemLists(payload)) {
    for (const item of items) {
      seen += 1;
      const episode = episodeFromItem(item, seriesId);
      if (episode === null) skipped += 1;
      else episodes.push(episode);
    }
  }
  const cursor = asCursor(firstValue(payload, ["cursor"]));
  const hasMore = asFlag(firstValue(payload, ["hasMore", "has_more"]));
  return { episodes, cursor, hasMore, seenItems: seen, skippedItems: skipped };
}

/**
 * The value of the first of `keys` at the top level, else the first found recursively.
 * @param {unknown} payload
 * @param {string[]} keys
 * @returns {unknown}
 */
function firstValue(payload, keys) {
  if (isDict(payload)) {
    for (const key of keys) if (Object.hasOwn(payload, key)) return payload[key];
  }
  return searchValue(payload, keys, 0);
}

/**
 * @param {unknown} node
 * @param {string[]} keys
 * @param {number} depth
 * @returns {unknown}
 */
function searchValue(node, keys, depth) {
  if (depth > MAX_DEPTH) return undefined;
  if (isDict(node)) {
    for (const key of keys) if (Object.hasOwn(node, key)) return node[key];
    for (const [key, value] of Object.entries(node)) {
      if (ITEM_LIST_KEYS.includes(key)) continue;
      const found = searchValue(value, keys, depth + 1);
      if (found !== null && found !== undefined) return found;
    }
  } else if (Array.isArray(node)) {
    for (const value of node) {
      const found = searchValue(value, keys, depth + 1);
      if (found !== null && found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {number | string | null}
 */
function asCursor(value) {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && pyStrip(value)) return pyStrip(value);
  return null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function asFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const text = pyStrip(value).toLowerCase();
    return text === "true" || text === "1";
  }
  return false;
}

/**
 * Combine pages: dedupe by item id, then by number (first seen wins); sort by number.
 * @param {Iterable<Iterable<Episode>>} pages
 * @returns {Episode[]}
 */
export function mergeEpisodes(pages) {
  /** @type {Map<string, Episode>} */
  const byItem = new Map();
  for (const page of pages) {
    for (const episode of page) if (!byItem.has(episode.itemId)) byItem.set(episode.itemId, episode);
  }
  /** @type {Map<number, Episode>} */
  const byNumber = new Map();
  for (const episode of byItem.values()) {
    if (!byNumber.has(episode.number)) byNumber.set(episode.number, episode);
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/**
 * Human-readable oddities: gaps, duplicate numbers, announced-vs-listed total, locked count.
 * @param {readonly Episode[]} episodes
 * @param {number | null} totalHint
 * @returns {string[]}
 */
export function catalogWarnings(episodes, totalHint) {
  /** @type {string[]} */
  const warnings = [];
  const numbers = [...new Set(episodes.map((episode) => episode.number))].sort((a, b) => a - b);
  let expected = 1;
  for (const number of numbers) {
    if (number > expected) warnings.push(gapText(expected, number - 1));
    expected = number + 1;
  }
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const episode of episodes) counts.set(episode.number, (counts.get(episode.number) ?? 0) + 1);
  for (const [number, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > 1) warnings.push(`duplicate episode number ${number}`);
  }
  if (totalHint !== null && totalHint > 0 && numbers.length !== totalHint) {
    warnings.push(`TikTok announces ${totalHint} episodes, ${numbers.length} listed`);
  }
  const locked = episodes.filter(isLocked).length;
  if (locked === 1) warnings.push("1 episode looks locked");
  else if (locked > 1) warnings.push(`${locked} episodes look locked`);
  return warnings;
}

/**
 * @param {number} low
 * @param {number} high
 * @returns {string}
 */
function gapText(low, high) {
  if (low === high) return `episode ${low} missing (gap)`;
  return `episodes ${low}-${high} missing (gap)`;
}

/**
 * Best-effort `{name, total}` from a `/api/drama/detail/` payload: inside `dramaInfo` / `drama` /
 * `detail` objects first (recursively), then the top level; the name is the first string under
 * `dramaName`, `title` or `name`, the total the first positive integer under `totalEpisode`,
 * `totalEpisodes`, `episodeCount`, `total` or `episodeTotal`.
 * @param {unknown} payload
 * @returns {{name: string | null, total: number | null}}
 */
export function parseDetailPayload(payload) {
  /** @type {string | null} */
  let name = null;
  /** @type {number | null} */
  let total = null;
  for (const container of detailContainers(payload)) {
    if (name === null) name = firstStr(container, NAME_KEYS);
    if (total === null) total = firstPositiveInt(container, TOTAL_KEYS);
    if (name !== null && total !== null) break;
  }
  return { name, total };
}

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown>[]}
 */
function detailContainers(payload) {
  /** @type {Record<string, unknown>[]} */
  const containers = [];
  walkDetailContainers(payload, 0, containers);
  if (isDict(payload)) containers.push(payload);
  return containers;
}

/**
 * @param {unknown} node
 * @param {number} depth
 * @param {Record<string, unknown>[]} containers
 */
function walkDetailContainers(node, depth, containers) {
  if (depth > MAX_DEPTH) return;
  if (isDict(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (DETAIL_CONTAINER_KEYS.includes(key) && isDict(value)) containers.push(value);
      walkDetailContainers(value, depth + 1, containers);
    }
  } else if (Array.isArray(node)) {
    for (const value of node) walkDetailContainers(value, depth + 1, containers);
  }
}

/**
 * @param {Record<string, unknown>} container
 * @param {string[]} keys
 * @returns {string | null}
 */
function firstStr(container, keys) {
  for (const key of keys) {
    const found = cleanStr(get(container, key));
    if (found !== null) return found;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} container
 * @param {string[]} keys
 * @returns {number | null}
 */
function firstPositiveInt(container, keys) {
  for (const key of keys) {
    const found = asInt(get(container, key));
    if (found !== null && found > 0) return found;
  }
  return null;
}

// ------------------------------------------------------------------------ renditions & play URLs

const H264_CODEC_RE = /h\.?264|avc/;
const H265_CODEC_RE = /h\.?265|hevc|hvc1|hev1/;
const URL_LIST_KEYS = ["UrlList", "urlList", "url_list"];
const MAX_URL_LIST_DEPTH = 3;
/** The height inside a `GearName` (`normal_720_0`): the only run of three or four digits. */
const GEAR_HEIGHT_RE = /(?<!\p{Nd})(\p{Nd}{3,4})(?!\p{Nd})/u;
/** `video.ratio` such as `720p` (or a bare `720`); matched against `caseless(text)`. */
const RATIO_RE = new RegExp(`^[${PY_SPACE}]*(\\p{Nd}{3,4})p?[${PY_SPACE}]*$`, "u");

/**
 * `h264` for H.264/AVC spellings, `h265` for H.265/HEVC ones, `bytevc1` for TikTok's, else the
 * lower-cased raw string; {@link UNKNOWN_CODEC} for anything that is not a non-blank string.
 * @param {unknown} raw
 * @returns {string}
 */
export function codecName(raw) {
  if (typeof raw !== "string" || !pyStrip(raw)) return UNKNOWN_CODEC;
  const text = pyStrip(raw);
  const folded = caseless(text);
  if (H264_CODEC_RE.test(folded)) return "h264";
  if (H265_CODEC_RE.test(folded)) return "h265";
  if (text.toLowerCase().startsWith("bytevc1")) return "bytevc1";
  return text.toLowerCase();
}

/**
 * Every `video.bitrateInfo` entry with at least one http(s) play URL, in payload order; never
 * throws on junk. A bare `video.playAddr` is no rendition ({@link playUrlCandidates} appends it).
 * @param {unknown} item
 * @returns {Rendition[]}
 */
export function renditions(item) {
  const video = isDict(item) ? field(item, "video") : undefined;
  if (!isDict(video)) return [];
  const bitrateInfo = get(video, "bitrateInfo");
  if (!Array.isArray(bitrateInfo)) return [];
  const ratioHeight = ratioHeightOf(get(video, "ratio"));
  /** @type {Rendition[]} */
  const found = [];
  for (const entry of bitrateInfo) {
    if (!isDict(entry)) continue;
    const urls = playUrls(get(entry, "PlayAddr"), 0);
    if (urls.length === 0) continue;
    const codec = codecName(get(entry, "CodecType"));
    const height = gearHeightOf(get(entry, "GearName")) ?? ratioHeight;
    const label = height !== null ? `${height}p ${codec}` : `${UNKNOWN_HEIGHT} ${codec}`;
    found.push({
      urlList: urls,
      codec,
      bitrate: asInt(get(entry, "Bitrate")) || 0,
      heightHint: height,
      label,
    });
  }
  return found;
}

/**
 * The renditions in the order `quality` tries them: `compatible` the H.264 ones by bitrate
 * descending, then the other codecs the same way; `best` all by bitrate descending. Ties keep
 * payload order. Throws for a quality outside `QUALITY_MODES`.
 * @param {unknown} item
 * @param {string} [quality]
 * @returns {Rendition[]}
 */
export function orderedRenditions(item, quality = "compatible") {
  if (!(/** @type {readonly string[]} */ (QUALITY_MODES).includes(quality))) {
    throw new Error(`unknown quality ${pyRepr(quality)}: expected one of ${QUALITY_MODES.join(", ")}`);
  }
  const byBitrate = renditions(item).sort((a, b) => b.bitrate - a.bitrate);
  if (quality === "best") return byBitrate;
  return [
    ...byBitrate.filter((rendition) => rendition.codec === "h264"),
    ...byBitrate.filter((rendition) => rendition.codec !== "h264"),
  ];
}

/**
 * The rendition `quality` downloads, null when the item lists none.
 * @param {unknown} item
 * @param {string} [quality]
 * @returns {Rendition | null}
 */
export function chooseRendition(item, quality = "compatible") {
  return orderedRenditions(item, quality)[0] ?? null;
}

/**
 * Direct play URLs of an item, best first and de-duplicated: the renditions' URLs in
 * {@link orderedRenditions} order, then `video.playAddr` (a string, or a dict with a `UrlList`).
 * Only http(s) strings are kept. This is what the downloader fetches.
 * @param {unknown} item
 * @param {string} [quality]
 * @returns {string[]}
 */
export function playUrlCandidates(item, quality = "compatible") {
  const video = isDict(item) ? field(item, "video") : undefined;
  if (!isDict(video)) return [];
  /** @type {string[]} */
  const ordered = [];
  for (const rendition of orderedRenditions(item, quality)) ordered.push(...rendition.urlList);
  ordered.push(...playUrls(get(video, "playAddr"), 0));
  return [...new Set(ordered)];
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function gearHeightOf(value) {
  if (typeof value !== "string") return null;
  const match = GEAR_HEIGHT_RE.exec(value);
  return match ? pyDecimalInt(/** @type {string} */ (match[1])) : null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function ratioHeightOf(value) {
  if (typeof value !== "string") return null;
  const match = RATIO_RE.exec(caseless(value));
  return match ? pyDecimalInt(/** @type {string} */ (match[1])) : null;
}

/**
 * The http(s) URLs of a play address: a string, a list of them or a dict with `UrlList`.
 * @param {unknown} value
 * @param {number} depth
 * @returns {string[]}
 */
function playUrls(value, depth) {
  if (depth > MAX_URL_LIST_DEPTH) return [];
  if (isDict(value)) {
    for (const key of URL_LIST_KEYS) {
      if (Object.hasOwn(value, key)) return playUrls(value[key], depth + 1);
    }
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((entry) => playUrls(entry, depth + 1));
  if (typeof value === "string") {
    const url = pyStrip(value);
    const lower = url.toLowerCase();
    return lower.startsWith("http://") || lower.startsWith("https://") ? [url] : [];
  }
  return [];
}

// ------------------------------------------------------------------------ url expiry

/** What Python's `urlsplit` strips from the left of a URL (C0 controls and the space). */
const C0_CONTROL_OR_SPACE_RE = /^[\x00-\x20]+/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+\-.]*$/;
/** Python's "utf-8" codec keeps a byte-order mark: so must the decoder (`ignoreBOM: true`). */
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * The integer `expire` query parameter of a signed CDN URL (seconds since the epoch), or null
 * when absent or not a whole number — `catalog.url_expiry` over Python's `urlsplit` and
 * `parse_qs(keep_blank_values=True)`, including the URLs `urlsplit` refuses (null).
 * @param {unknown} url
 * @returns {number | null}
 */
export function urlExpiry(url) {
  if (typeof url !== "string") return null;
  const query = splitQuery(url);
  if (query === null) return null;
  const values = parseQs(query).get("expire");
  if (values === undefined || values.length === 0) return null;
  return pyDecimalInt(pyStrip(/** @type {string} */ (values[0])));
}

/**
 * The query of `urllib.parse.urlsplit(url)`, or null where it raises ValueError.
 * @param {string} raw
 * @returns {string | null}
 */
function splitQuery(raw) {
  let url = raw.replace(C0_CONTROL_OR_SPACE_RE, "").replace(/[\t\r\n]/g, "");
  const colon = url.indexOf(":");
  if (colon > 0 && SCHEME_RE.test(url.slice(0, colon))) url = url.slice(colon + 1);
  let netloc = "";
  if (url.startsWith("//")) {
    let delim = url.length;
    for (const ch of "/?#") {
      const found = url.indexOf(ch, 2);
      if (found >= 0) delim = Math.min(delim, found);
    }
    netloc = url.slice(2, delim);
    url = url.slice(delim);
    const open = netloc.includes("[");
    const close = netloc.includes("]");
    if (open !== close) return null; // "Invalid IPv6 URL"
    if (open && close && !bracketedNetlocOk(netloc)) return null;
  }
  const hash = url.indexOf("#");
  if (hash >= 0) url = url.slice(0, hash);
  const question = url.indexOf("?");
  const query = question >= 0 ? url.slice(question + 1) : "";
  if (!netlocOk(netloc)) return null;
  return query;
}

/**
 * `urllib.parse._check_bracketed_netloc` (true where it does not raise).
 * @param {string} netloc
 * @returns {boolean}
 */
function bracketedNetlocOk(netloc) {
  const hostAndPort = netloc.slice(netloc.lastIndexOf("@") + 1);
  const bracket = hostAndPort.indexOf("[");
  let hostname;
  if (bracket >= 0) {
    if (bracket > 0) return false; // data before the bracket
    const bracketed = hostAndPort.slice(bracket + 1);
    const end = bracketed.indexOf("]");
    hostname = end >= 0 ? bracketed.slice(0, end) : bracketed;
    const port = end >= 0 ? bracketed.slice(end + 1) : "";
    if (port && !port.startsWith(":")) return false;
  } else {
    const portColon = hostAndPort.indexOf(":");
    hostname = portColon >= 0 ? hostAndPort.slice(0, portColon) : hostAndPort;
  }
  if (hostname.startsWith("v") || hostname.startsWith("V")) {
    return /^[vV][a-fA-F0-9]+\.[^\n]+$/.test(hostname); // an IPvFuture address
  }
  return isIPv6(hostname); // ipaddress.ip_address, and an IPv4 address cannot be in brackets
}

/**
 * `urllib.parse._checknetloc`: a non-ASCII netloc must not gain `/?#@:` under NFKC.
 * @param {string} netloc
 * @returns {boolean}
 */
function netlocOk(netloc) {
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return true;
  const plain = netloc.replace(/[@:#?]/g, "");
  const normalized = plain.normalize("NFKC");
  if (plain === normalized) return true;
  return ![..."/?#@:"].some((ch) => normalized.includes(ch));
}

/**
 * `ipaddress.IPv4Address(text)` does not raise.
 * @param {string} text
 * @returns {boolean}
 */
function isIPv4(text) {
  if (!text || text.includes("/")) return false;
  const octets = text.split(".");
  if (octets.length !== 4) return false;
  return octets.every(
    (octet) =>
      /^[0-9]{1,3}$/.test(octet) && (octet === "0" || !octet.startsWith("0")) && Number(octet) <= 255,
  );
}

/**
 * `ipaddress.IPv6Address(text)` does not raise (a scope id `%…` allowed).
 * @param {string} text
 * @returns {boolean}
 */
function isIPv6(text) {
  if (text.includes("/")) return false;
  let address = text;
  const percent = text.indexOf("%");
  if (percent >= 0) {
    const scope = text.slice(percent + 1);
    if (!scope || scope.includes("%")) return false;
    address = text.slice(0, percent);
  }
  if (!address || pyLen(address) > 45) return false; // "At most 45 characters expected"
  const parts = address.split(":");
  if (parts.length < 3) return false;
  if (/** @type {string} */ (parts[parts.length - 1]).includes(".")) {
    if (!isIPv4(/** @type {string} */ (parts.pop()))) return false;
    parts.push("0", "0");
  }
  if (parts.length > 9) return false;
  let skip = -1;
  for (let i = 1; i < parts.length - 1; i += 1) {
    if (!parts[i]) {
      if (skip >= 0) return false; // more than one "::"
      skip = i;
    }
  }
  let high;
  let low;
  if (skip >= 0) {
    high = skip;
    low = parts.length - skip - 1;
    if (!parts[0]) {
      high -= 1;
      if (high) return false;
    }
    if (!parts[parts.length - 1]) {
      low -= 1;
      if (low) return false;
    }
    if (8 - (high + low) < 1) return false;
  } else {
    if (parts.length !== 8 || !parts[0] || !parts[parts.length - 1]) return false;
    high = parts.length;
    low = 0;
  }
  const hextet = /^[0-9a-fA-F]{1,4}$/;
  for (let i = 0; i < high; i += 1) if (!hextet.test(/** @type {string} */ (parts[i]))) return false;
  for (let i = parts.length - low; i < parts.length; i += 1) {
    if (!hextet.test(/** @type {string} */ (parts[i]))) return false;
  }
  return true;
}

/**
 * `urllib.parse.parse_qs(query, keep_blank_values=True)`: name → values, first-seen order.
 * @param {string} query
 * @returns {Map<string, string[]>}
 */
function parseQs(query) {
  /** @type {Map<string, string[]>} */
  const parsed = new Map();
  if (!query) return parsed;
  for (const field of query.split("&")) {
    if (!field) continue;
    const eq = field.indexOf("=");
    const name = unquotePlus(eq >= 0 ? field.slice(0, eq) : field);
    const value = unquotePlus(eq >= 0 ? field.slice(eq + 1) : "");
    const values = parsed.get(name);
    if (values === undefined) parsed.set(name, [value]);
    else values.push(value);
  }
  return parsed;
}

/**
 * `urllib.parse.unquote_plus` (UTF-8, errors="replace"): `+` is a space, `%XX` runs of the ASCII
 * parts are decoded as UTF-8; non-ASCII text passes through unchanged.
 * @param {string} text
 * @returns {string}
 */
function unquotePlus(text) {
  const spaced = text.replace(/\+/g, " ");
  if (!spaced.includes("%")) return spaced;
  return spaced.replace(/[\x00-\x7f]+/g, (run) => UTF8.decode(percentBytes(run)));
}

/**
 * `urllib.parse._unquote_impl` of an ASCII run: `%XX` (two hex digits) → that byte, any other
 * `%` kept.
 * @param {string} run
 * @returns {Uint8Array}
 */
function percentBytes(run) {
  /** @type {number[]} */
  const bytes = [];
  for (let i = 0; i < run.length; i += 1) {
    const pair = run.slice(i + 1, i + 3);
    if (run[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(pair)) {
      bytes.push(Number.parseInt(pair, 16));
      i += 2;
    } else {
      bytes.push(run.charCodeAt(i));
    }
  }
  return Uint8Array.from(bytes);
}
