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
 * Verified 2026-11-06 from the owner's reports (a 62-episode series, `catalog.py` has the same
 * facts): a free series with conditions carries `dramaInfo.isLimitedFree: true` on every item (what
 * the condition is, the field does not say); `DramaVideoData.IsFreeIntro` ("is this the free intro
 * teaser") is false on every episode, E01 included, and `IsPreview` / `PreviewType` (4 or 1) sit on
 * fully served episodes too — none of the three says anything about a lock, so none gives a clue.
 * What does: an episode TikTok serves short comes as the WHOLE file by size (`video.size` == the
 * rendition's `PlayAddr.DataSize`) whose MP4 header plays only about 70 s, and the list tells it
 * beforehand — the episode's own sound (`music.original: true`) lasts that long (`music.duration`,
 * 69 s) while `video.duration` is the full length (106 s). Either a window for an episode the
 * account has not unlocked or a defective encode on TikTok's side (the owner's 7 episodes of
 * 2026-11-06 broke at the same point in the TikTok app and in TikTok's web player: no sound past
 * it, a broken picture when seeking past it); the list cannot tell the two apart. That is the
 * SHORT-HEADER rule (hint {@link SHORT_HEADER_HINT_PREFIX}); after a download the downloader
 * recognises the short-served file by its listed size ({@link listedSizes}). DramaFetch never
 * rewrites that header: if the TikTok app plays the episode whole, watching it there and looking
 * again is the way; if the app breaks at the same point too, nothing changes it until TikTok
 * replaces the file.
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
  pyNumberText,
  pyRepr,
  pyScalarText,
  pyStrip,
} from "./messages.js";

/** How deep the recursive searches descend into a payload before giving up. */
export const MAX_DEPTH = 12;
/** The hint of an item THIS session's payload gives no play address for. */
export const NO_PLAY_ADDRESS = "no play address";
/**
 * The hint of an item whose own sound lasts only part of its video (`catalog.
 * SHORT_HEADER_HINT_PREFIX`): `plays 69 s of 106 s` — `music.duration` of `video.duration`, the
 * list's tell of an episode TikTok serves short to this session.
 */
export const SHORT_HEADER_HINT_PREFIX = "plays ";
/** Codec of a rendition whose `CodecType` is missing. */
export const UNKNOWN_CODEC = "unknown";
/** Height part of a label when neither the `GearName` nor `video.ratio` tells it. */
export const UNKNOWN_HEIGHT = "?p";
/**
 * The path TikTok's video-only HEVC streams end with (`catalog.VIDEO_ONLY_PATH_SUFFIX`): no audio
 * track (yt-dlp marks every such format `acodec: none`, yt-dlp/yt-dlp#16622 and #17372), so never
 * a candidate, whatever the quality mode — the saved file could only be quarantined.
 */
export const VIDEO_ONLY_PATH_SUFFIX = "/media-video-hvc1/";
/**
 * Why {@link skipReason} leaves an item out of a series (`catalog.SKIP_*`), in the order it
 * checks them: the item names another drama, it has no id, or neither `DramaVideoData` nor
 * `dramaInfo` gives a usable episode number (a trailer). {@link catalogWarnings} says each one.
 */
export const SKIP_OTHER_DRAMA = "another drama's id";
export const SKIP_NO_ID = "no id";
export const SKIP_NO_NUMBER = "no episode number";
export const SKIP_REASONS = [SKIP_OTHER_DRAMA, SKIP_NO_ID, SKIP_NO_NUMBER];
/**
 * How the warnings and the report line start for a list TikTok counts more items of than
 * DramaFetch can place (3.0.1, {@link countCheck}'s `uncertain`; `catalog.UNCERTAIN_TEXT`) — the
 * words of the alert's title too.
 */
export const UNCERTAIN_TEXT = "TikTok's list may be incomplete";
/**
 * Why the merge left an item out for another one with its number (`catalog.LEFT_OUT_*`): the
 * first rule of the preference order that tells the two apart — the kept one is no highlight
 * ({@link isHighlight}), or reads free or unlocked where the other reads locked, or is longer
 * (`video.duration`); else it was listed first. Of items that are all highlights, the same order
 * decides from its second rule on (4.0.1).
 */
export const LEFT_OUT_HIGHLIGHT = "a highlight";
export const LEFT_OUT_LOCKED = "locked";
export const LEFT_OUT_SHORTER = "shorter";
export const LEFT_OUT_LATER = "listed later";
export const LEFT_OUT_REASONS = [LEFT_OUT_HIGHLIGHT, LEFT_OUT_LOCKED, LEFT_OUT_SHORTER, LEFT_OUT_LATER];

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
 * @property {boolean} guessedLock `locked` ONLY by DramaFetch's own structural guesses — the
 *   SHORT-HEADER rule and/or no play address — with no DRM, price, entitlement or TikTok lock clue
 *   ({@link accessOf}, `Episode.guessed_lock`; 3.0.1, the owner's report of 2026-11-27): a free
 *   episode DramaFetch guessed was locked — still skipped before any request, but counted as not
 *   downloaded (`report.seriesReport`), and the tab's **Retry** asks TikTok for it once
 * @property {Record<string, unknown> | null} raw the item payload (null for an episode built by hand)
 *
 * @typedef {object} Rendition One `video.bitrateInfo` entry with at least one play URL.
 * @property {string[]} urlList
 * @property {string} codec `h264`, `h265`, `bytevc1`, the lower-cased raw `CodecType` or `unknown`
 * @property {number} bitrate bit/s, 0 when absent
 * @property {number | null} heightHint
 * @property {string} label `720p h264`, `?p h264`
 *
 * @typedef {object} SkippedItem An item TikTok listed that is no episode of the series
 *   (`models.SkippedItem`): said in the warnings, never only counted.
 * @property {string} reason one of {@link SKIP_REASONS}
 * @property {string | null} itemId the item's id when it has one
 *
 * @typedef {object} PagePayload What one `item_list` page contributed for the requested series.
 * @property {Episode[]} episodes
 * @property {number | string | null} cursor
 * @property {boolean} hasMore
 * @property {number} seenItems
 * @property {number} skippedItems how many of the page's items are no episode of the series
 * @property {SkippedItem[]} skipped those items, with their reasons, in page order
 * @property {number | null} totalHint TikTok's count of the series' episodes as the page's items
 *   carry it: the first positive `dramaInfo.numVideos` of an item of the series ({@link itemTotalHint})
 * @property {(string | null)[]} [skippedKeys] one entry per `skipped` item (3.0.1, the review's L4):
 *   the canonical JSON of the raw item ({@link itemKey}) for an item without an id, null for one
 *   with an id — what {@link mergePages} dedupes id-less items by; absent for a page built by hand,
 *   whose id-less items then count each
 *
 * @typedef {object} Duplicate Two items TikTok listed with one episode number (`catalog.Duplicate`).
 * @property {number} number
 * @property {Episode} kept the episode the series keeps
 * @property {Episode} leftOut the other item
 * @property {string} why the rule that decided, one of {@link LEFT_OUT_REASONS}
 *
 * @typedef {object} Listing What the pages of one listing add up to ({@link mergePages}).
 * @property {Episode[]} episodes one per number, sorted
 * @property {Duplicate[]} duplicates every item left out for another one's number
 * @property {SkippedItem[]} skipped every item that is no episode, with its reason
 * @property {number} itemsReceived the distinct items of the series that came
 * @property {number | null} totalHint TikTok's count as the items carry it (the first page's)
 *
 * @typedef {object} CountCheck What a listing's numbers say against TikTok's count ({@link countCheck},
 *   `catalog.CountCheck`, 3.0.1).
 * @property {number} certainTop the highest episode number the drama certainly has (listed, or up to
 *   TikTok's count less the other items)
 * @property {number} otherItems the drama's items received besides its episode numbers (a trailer, an
 *   item left out for another one's number — a highlight beside the episode of its number among
 *   them —, one without a number or an id)
 * @property {boolean} uncertain TikTok counts more than `certainTop`: its count may include the
 *   other items, or episodes past the highest number listed may be missing — nothing tells which
 *
 * @typedef {object} AccessDecision The result of {@link accessOf} (`catalog.AccessDecision`).
 * @property {Access} access
 * @property {boolean} paid
 * @property {boolean} drm
 * @property {string[]} hints
 * @property {boolean} guessedLock `locked` only by SHORT-HEADER and/or no play address, with no
 *   DRM, PRICING, ENTITLED, VIEWER-LOCK or NOT-ENTITLED clue (3.0.1): see {@link accessOf}
 *
 * @typedef {object} ListingPage One episode-list page a listing asked for (`models.ListingPage`), as
 *   the "did not download" report shows it: how it was asked and what came back — never a URL, a
 *   query or a cookie.
 * @property {string} kind `first` (the page's own first request, replayed byte for byte), `next`
 *   (the pagination's next page), `scroll` (a request of the page's the scroll fallback asked for
 *   again) or `fill` (the gap filling); the Python tool also says `page` and `embedded`
 * @property {string | null} cursorAsked the request's `cursor` parameter, null without one
 * @property {string | null} countAsked the request's `count` parameter, null without one
 * @property {boolean} listed whether the answer held an episode list at all
 * @property {number} items every item of the answer (any drama); 0 without a list
 * @property {number[]} numbers the series' episode numbers in it, as listed
 * @property {boolean | null} hasMore what the answer said; null without a list
 * @property {number | string | null} cursor the cursor the answer returned; null without a list
 *
 * @typedef {object} ListingRecord What a listing asked TikTok for (`models.ListingRecord`).
 * @property {string | null} endpoint the list request's scheme, host and path — never its query
 * @property {ListingPage[]} pages every page, in the order it came, the gap filling's among them
 *
 * @typedef {object} Series A resolved series, as the discovery builds it (`models.Series`).
 * @property {string} seriesId
 * @property {string | null} name
 * @property {Episode[]} episodes
 * @property {number | null} totalHint TikTok's count of the episodes: the detail's total, else the
 *   items' `numVideos`
 * @property {string[]} warnings
 * @property {SkippedItem[]} [skippedItems] the items TikTok listed that are no episode of the series
 * @property {number | null} [itemsReceived] the distinct items TikTok listed for the series — the
 *   episodes before the number merge plus the skipped items of THIS drama — what
 *   {@link countCheck} holds against `totalHint`; absent or null when unknown
 * @property {number[]} [missingNumbers] the episode numbers the listing still certainly lacks once
 *   it is over, the gap filling included ({@link missingNumbers}): the holes below the highest
 *   number listed and the numbers up to TikTok's count less the drama's other items received;
 *   empty when nothing is known missing
 * @property {string | null} [earlyEnd] why the listing ended before TikTok said the list was over —
 *   the warning of the fallback the pagination stopped on (`discovery.FIRST_PAGE_WARNING`,
 *   `NO_CURSOR_WARNING`, `NO_LIST_WARNING`, `NOTHING_NEW_WARNING`, the max-pages warning) while no
 *   page said `hasMore` false since; null when the list reached its end. TikTok's count, when
 *   known, says whether anything is missing all the same (`missingNumbers`)
 * @property {ListingRecord | null} [listing] the pages the listing asked for, the gap filling's
 *   included; absent or null for a series built by hand
 */

const ITEM_LIST_KEYS = ["itemList", "item_list"];
// The key patterns of access_of, written lower-case and matched against `caseless(key)`: that is
// re.IGNORECASE as Python's re applies it to these ASCII patterns.
/**
 * The key-name heuristic of the builds before the access model (matched without block words);
 * `preview` left it on 2026-11-06: TikTok sets `IsPreview` on fully served episodes.
 */
const LOCK_KEY_RE = /lock|paid|needpay|unlock|price|coin|vip/;
const FREE_KEY_RE = /free/;
/** The word that makes a `free` key no price flag: `IsFreeIntro`, "is this the free intro teaser". */
const INTRO_WORD = "intro";
const DRM = "drm";
const ENTITLED = "entitled";
const NOT_ENTITLED = "not-entitled";
const VIEWER_LOCK = "viewer-lock";
const AMBIGUOUS = "ambiguous";
const PRICING = "pricing";
/** A truthy `free` key about the price ({@link isFreeKey}): free, whatever the price says (with conditions the key does not name). */
const FREE = "free";
/** The structural SHORT-HEADER rule: the item's own sound lasts only part of its video. */
const SHORT_HEADER = "short-header";
/** The rule fires when `music.duration` is at most this share of `video.duration`… */
const SHORT_HEADER_RATIO = 0.85;
/**
 * `catalog.MAX_EXACT_INT`: the largest integer both front ends read exactly. {@link asInt} — every
 * episode number, duration, size and bitrate read from the payload — gives null beyond it, so a
 * 400-digit `video.duration` or `DataSize` (`Infinity` or an inexact float here, an exact int in
 * Python) is junk in both: the SHORT-HEADER rule never fires on it and {@link listedSizes} drops it.
 */
const MAX_EXACT_INT = Number.MAX_SAFE_INTEGER;
/** …and at least this many seconds shorter. */
const SHORT_HEADER_MIN_GAP_S = 1;
/** One word of a key: see {@link keyWords}. Case-sensitive, ASCII only. */
const KEY_WORD_RE = /[A-Z]+s(?![a-z])|[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g;
const DRM_NEGATION_WORDS = new Set(["free", "no", "non", "not", "un", "without"]);
const DRM_ID_WORDS = new Set(["id", "ids", "uid", "uids"]);
/** Matched against the FULL key: `isUnlocked`, `is_purchased`, `hasPaid`, `paidByUser`, … */
const ENTITLED_KEY_RE =
  /^(?:(?:is_?)?(?:unlocked|purchased|bought|entitled)|has_?(?:paid|purchased|unlocked|bought|access)|paid_?by_?(?:user|viewer|me))$/;
/** Matched against the FULL key: `isLocked`, `is_locked`, `locked`. */
const LOCKED_KEY_RE = /^(?:is_?)?locked$/;
/** `preview` and `trial` left it on 2026-11-06 (`IsPreview`, `PreviewType` sit on served episodes). */
const VIEWER_LOCK_KEY_RE = /need_?(?:pay|unlock|buy|purchase)|paywall/;
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
/**
 * Where an item's episode number lives, read in order — `DramaVideoData`'s keys, then
 * `dramaInfo`'s — the first usable one wins (an int ≥ 1: a `0`, `null`, `""` or any other value
 * falls through to the next key instead of dropping the item).
 */
const EPISODE_NUMBER_KEYS = ["EpisodeNumber", "episodeNumber", "episode_number"];
const NAME_KEYS = ["dramaName", "title", "name"];
/** TikTok's own count of a drama's episodes: every captured `dramaInfo` carries it. */
const NUM_VIDEOS_KEY = "numVideos";
const TOTAL_KEYS = [NUM_VIDEOS_KEY, "totalEpisode", "totalEpisodes", "episodeCount", "total", "episodeTotal"];
const DETAIL_CONTAINER_KEYS = ["dramaInfo", "drama", "detail"];
/**
 * TikTok's highlight marks ({@link isHighlight}), on `dramaInfo.DramaVideoData` in every capture
 * (`IsHighlight: false`, `LinkedEpisodeID: "0"` on almost every episode; `IsHighlight` truthy on
 * episodes 9 and 17 of the owner's drama of 2026-11-27, full episodes).
 */
const HIGHLIGHT_KEY = "IsHighlight";
const LINKED_EPISODE_KEY = "LinkedEpisodeID";
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
 * full keys, falsy), VIEWER-LOCK (`(is_?)?locked`; `need_?(pay|unlock|buy|purchase)`, `paywall`; a
 * `lock_?status` bool or number or a string spelling one, truthy; a status string `locked` `lock`
 * `need_pay` `needpay` `unpaid` `unpurchased`), AMBIGUOUS (never decides), FREE (a truthy `free`
 * key about the price, {@link isFreeKey}: `isLimitedFree`, `isFree`, `limitedFree`; its
 * `key=value` is a hint only next to a PRICING clue — it says why a sold episode is free;
 * alone it says nothing about a price or a lock), PRICING (a falsy such key → `isFree=false`;
 * `price` `coin` `cost` `charge` above 0; `vip` / `paid` outside the entitled keys; the old
 * heuristic's leftovers — "block" is not "lock") and two structural rules: SHORT-HEADER
 * (`music.original` truthy, `music.duration` a number above 0 at most 0.85 × `video.duration` (an
 * int above 0) and at least 1 s shorter: the episode's own sound lasts only part of the episode, and
 * so does what the file TikTok serves plays — a window for an episode the account has not unlocked,
 * or a defective encode on TikTok's side; hint {@link SHORT_HEADER_HINT_PREFIX} + `69 s of 106 s`) and PLAY (no
 * play address, {@link NO_PLAY_ADDRESS}). A `free` key with `intro` among its words
 * (`IsFreeIntro`) or naming DRM (`isDrmFree`, a negation) is no price flag at all, whatever its
 * value; `IsPreview`, `PreviewType` and `isTrial` give no clue either (TikTok sets them on fully
 * served episodes; the raw item keeps them for the report).
 *
 * Decision, first match wins: DRM → `locked` with `drm`; ENTITLED → `unlocked`; SHORT-HEADER →
 * `locked`; VIEWER-LOCK or no play address → `locked`; FREE → `free` (a sold series the payload
 * calls free is free); PRICING → `unlocked` with a real play URL ({@link playUrlCandidates})
 * and no NOT-ENTITLED clue, else `locked` (without a URL, hint {@link NO_PLAY_ADDRESS}); else
 * `free`. `paid` is any PRICING or ENTITLED clue; `hints` are unique, in scan order, the two
 * structural hints last (the short header's before the play address'). `guessedLock` (3.0.1,
 * `catalog.AccessDecision.guessed_lock`): `locked` with no DRM clue, no PRICING or ENTITLED clue
 * (`paid` false) and no VIEWER-LOCK or NOT-ENTITLED clue — locked only by SHORT-HEADER and/or no
 * play address, DramaFetch's own guesses; it changes no decision.
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
  const window = shortHeaderHint(dict);
  const classes = new Set(clues.map(([kind]) => kind));
  // a free flag is a hint only next to a price (it says why a sold episode is free); on
  // its own it says nothing about a price or a lock, which is what an empty list means
  const hints = clues.filter(([kind]) => kind !== FREE || classes.has(PRICING)).map(([, hint]) => hint);
  if (window !== null) {
    classes.add(SHORT_HEADER);
    hints.push(window);
  }
  if (!playable) hints.push(NO_PLAY_ADDRESS);
  const drm = classes.has(DRM);
  /** @type {Access} */
  let access;
  if (drm) {
    access = "locked";
  } else if (classes.has(ENTITLED)) {
    access = "unlocked";
  } else if (classes.has(SHORT_HEADER) || classes.has(VIEWER_LOCK) || !playable) {
    access = "locked";
  } else if (classes.has(FREE)) {
    access = "free";
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
  // 3.0.1: locked only by DramaFetch's own structural guesses (SHORT-HEADER, no play address) —
  // nothing of TikTok's says DRM, a price, an entitlement or a lock
  const guessedLock = access === "locked" && !drm && !paid && !classes.has(VIEWER_LOCK) && !classes.has(NOT_ENTITLED);
  return { access, paid, drm, hints: [...new Set(hints)], guessedLock };
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
  if (!namesDrm(words)) return false;
  return !words.some((word) => DRM_NEGATION_WORDS.has(word) || DRM_ID_WORDS.has(word));
}

/**
 * Whether one of a key's words is `drm` or starts with `encrypt` (negated or not).
 * @param {readonly string[]} words
 * @returns {boolean}
 */
function namesDrm(words) {
  return words.some((word) => word === "drm" || word.startsWith("encrypt"));
}

/**
 * Whether a key is a `free` flag about the episode's price (the FREE / `isFree=false` clues of
 * {@link accessOf}): it contains `free`, and none of its {@link keyWords} is `intro`
 * (`IsFreeIntro`: the free intro teaser flag) or names DRM (`isDrmFree`: a DRM negation).
 * @param {string} key
 * @returns {boolean}
 */
function isFreeKey(key) {
  if (!FREE_KEY_RE.test(caseless(key))) return false;
  const words = keyWords(key);
  return !words.includes(INTRO_WORD) && !namesDrm(words);
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
  // a `free` key about the price: falsy a price (isFree=false), truthy FREE (isLimitedFree=True)
  const freeKey = isFreeKey(key);
  if (freeKey && !truthy) found.push([PRICING, "isFree=false"]);
  else if (freeKey) found.push([FREE, hint]);
  else if (sold) found.push([PRICING, hint]);
  return found;
}

/**
 * The SHORT-HEADER hint of an item, or null when the rule does not fire: `video.duration` (an
 * int above 0, {@link asInt}), `music.duration` (a number above 0; `music` is the item's top-level
 * `music` dict) and `music.original` truthy, with the sound at most {@link SHORT_HEADER_RATIO}
 * of the video and at least {@link SHORT_HEADER_MIN_GAP_S} s shorter. A licensed track's length
 * says nothing, so without `original` — or either duration — the rule never fires. Numbers print
 * as Python prints them: the sound's through {@link formatHintValue} (`_format_hint_value`), the
 * video's through {@link pyNumberText} (`str()` of an int).
 * @param {Record<string, unknown>} item
 * @returns {string | null}
 */
function shortHeaderHint(item) {
  const video = field(item, "video");
  const music = field(item, "music");
  if (!isDict(video) || !isDict(music)) return null;
  const videoDuration = asInt(get(video, "duration"));
  if (videoDuration === null || videoDuration <= 0) return null;
  const musicDuration = get(music, "duration");
  if (typeof musicDuration !== "number" || !Number.isFinite(musicDuration) || musicDuration <= 0) return null;
  if (!isTruthy(get(music, "original"))) return null;
  if (musicDuration > SHORT_HEADER_RATIO * videoDuration) return null;
  if (videoDuration - musicDuration < SHORT_HEADER_MIN_GAP_S) return null;
  // the sound's length as a hint value (`_format_hint_value`), the video's as Python prints an int
  return `${SHORT_HEADER_HINT_PREFIX}${formatHintValue(musicDuration)} s of ${pyNumberText(videoDuration)} s`;
}

/**
 * The file sizes the list announces for an item (`catalog.listed_sizes`): the positive ints among
 * `video.size` and every `video.bitrateInfo[].PlayAddr.DataSize` (ints, or digit strings, of at most
 * {@link MAX_EXACT_INT}; anything else ignored), sorted and de-duplicated. The downloader compares a verified-short body with them:
 * a whole file by size with a short header is short-served. Pure, never throws.
 * @param {unknown} item
 * @returns {number[]}
 */
export function listedSizes(item) {
  const video = isDict(item) ? field(item, "video") : undefined;
  if (!isDict(video)) return [];
  /** @type {Set<number>} */
  const sizes = new Set();
  const size = asInt(get(video, "size"));
  if (size !== null && size > 0) sizes.add(size);
  const bitrateInfo = get(video, "bitrateInfo");
  if (Array.isArray(bitrateInfo)) {
    for (const entry of bitrateInfo) {
      if (!isDict(entry)) continue;
      const playAddr = get(entry, "PlayAddr");
      if (!isDict(playAddr)) continue;
      const dataSize = asInt(get(playAddr, "DataSize"));
      if (dataSize !== null && dataSize > 0) sizes.add(dataSize);
    }
  }
  return [...sizes].sort((a, b) => a - b);
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
 * or `drm` without `locked`, throws (DramaFetch never decrypts), and so does `guessedLock` on an
 * episode that is not `locked`, or is `drm` or `paid` (3.0.1).
 * @param {{number: number, itemId: string, title: string, seriesId: string,
 *   seriesName?: string | null, author?: string | null, durationS?: number | null,
 *   lockHints?: readonly string[], coverUrl?: string | null, qualityHint?: string | null,
 *   access?: string, paid?: boolean, drm?: boolean, guessedLock?: boolean,
 *   raw?: Record<string, unknown> | null}} fields
 * @returns {Episode}
 */
export function makeEpisode(fields) {
  const lockHintsList = [...(fields.lockHints ?? [])];
  const drm = fields.drm ?? false;
  const paid = fields.paid ?? false;
  const guessedLock = fields.guessedLock ?? false;
  const access = fields.access || (lockHintsList.length > 0 || drm ? "locked" : "free");
  if (access !== "free" && access !== "unlocked" && access !== "locked") {
    throw new Error(`Episode.access must be one of free, unlocked, locked, not ${pyRepr(access)}`);
  }
  if (drm && access !== "locked") {
    throw new Error("a DRM-protected episode is always locked: DramaFetch never decrypts");
  }
  if (guessedLock && (access !== "locked" || drm || paid)) {
    throw new Error("a guessed lock is a locked episode with no DRM, price or entitlement clue");
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
    paid,
    drm,
    guessedLock,
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
 * One `itemList` entry as an {@link Episode}, or null when it must be skipped ({@link skipReason}
 * says why): a `dramaInfo` series id that differs from `seriesId`; no item id; no usable episode
 * number — `DramaVideoData`'s `EpisodeNumber` / `episodeNumber` / `episode_number`, then
 * `dramaInfo`'s, the first that is an int ≥ 1 (junk falls through to the next key): trailers. The
 * item may be wrapped in `{"itemStruct": {...}}`.
 * @param {unknown} item
 * @param {string} seriesId
 * @returns {Episode | null}
 */
export function episodeFromItem(item, seriesId) {
  if (!isDict(item)) return null;
  const found = identify(item, seriesId);
  if (found.reason !== null || found.itemId === null || found.number === null) return null;
  return buildEpisode(item, seriesId, found.itemId, found.number);
}

/**
 * Why {@link episodeFromItem} leaves an item out of series `seriesId` (`catalog.skip_reason`) —
 * the first that holds of {@link SKIP_OTHER_DRAMA}, {@link SKIP_NO_ID} and {@link SKIP_NO_NUMBER}
 * — or null when it reads as one of the series' episodes. A non-object is {@link SKIP_NO_ID}.
 * @param {unknown} item
 * @param {string} seriesId
 * @returns {string | null}
 */
export function skipReason(item, seriesId) {
  if (!isDict(item)) return SKIP_NO_ID;
  return identify(item, seriesId).reason;
}

/**
 * Whether an item carries TikTok's highlight marks (`catalog.is_highlight`): a truthy `IsHighlight`
 * (a bool, a number or a string, read as {@link isTruthy} reads one; a container or null never
 * counts) or a `LinkedEpisodeID` that is an id other than `"0"`, in `dramaInfo.DramaVideoData` or in
 * `dramaInfo`. Absent keys, `false`, `"0"` and `0` are no mark: almost every captured episode carries
 * `IsHighlight: false` and `LinkedEpisodeID: "0"`. A mark does not make an item a clip of an episode:
 * TikTok marks some full episodes this way (the owner's drama of 2026-11-27: episodes 9 and 17 of 66,
 * alone with their numbers, play on TikTok), so it only decides between items of one number — the
 * one that is no highlight is kept ({@link mergePages}) —, never whether a number has an episode
 * (4.0.1).
 * @param {unknown} item
 * @returns {boolean}
 */
export function isHighlight(item) {
  if (!isDict(item)) return false;
  const dramaInfo = dramaInfoOf(item);
  const videoData = get(dramaInfo, "DramaVideoData");
  const containers = isDict(videoData) ? [videoData, dramaInfo] : [dramaInfo];
  for (const container of containers) {
    const flag = get(container, HIGHLIGHT_KEY);
    if (isScalar(flag) && isTruthy(flag)) return true;
    const linked = asId(get(container, LINKED_EPISODE_KEY));
    if (linked !== null && linked !== "0") return true;
  }
  return false;
}

/**
 * TikTok's count of the episodes of the item's drama (`catalog.item_total_hint`):
 * `dramaInfo.numVideos` when it is a positive int ({@link asInt}) and the item does not name
 * another drama than `seriesId`; else null.
 * @param {unknown} item
 * @param {string} seriesId
 * @returns {number | null}
 */
export function itemTotalHint(item, seriesId) {
  if (!isDict(item)) return null;
  const dramaInfo = dramaInfoOf(item);
  const foundSeriesId = seriesIdOf(dramaInfo);
  if (foundSeriesId !== null && foundSeriesId !== String(seriesId)) return null;
  const total = asInt(get(dramaInfo, NUM_VIDEOS_KEY));
  return total !== null && total > 0 ? total : null;
}

/**
 * The item's `dramaInfo` (an `itemStruct` wrapper's too), `{}` when it is no object.
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function dramaInfoOf(item) {
  const found = field(item, "dramaInfo");
  return isDict(found) ? found : {};
}

/**
 * `catalog._identify`: the skip reason, the item id and the episode number of an item, the checks
 * of {@link skipReason} in order; the reason is null — and the id and the number are set — for an
 * episode.
 * @param {Record<string, unknown>} item
 * @param {string} seriesId
 * @returns {{reason: string | null, itemId: string | null, number: number | null}}
 */
function identify(item, seriesId) {
  const dramaInfo = dramaInfoOf(item);
  const itemId = asId(field(item, "id"));
  const foundSeriesId = seriesIdOf(dramaInfo);
  if (foundSeriesId !== null && foundSeriesId !== String(seriesId)) return { reason: SKIP_OTHER_DRAMA, itemId, number: null };
  if (itemId === null) return { reason: SKIP_NO_ID, itemId: null, number: null };
  const number = episodeNumber(dramaInfo);
  if (number === null) return { reason: SKIP_NO_NUMBER, itemId, number: null };
  return { reason: null, itemId, number };
}

/**
 * The {@link Episode} of an item {@link identify} read as episode `number` of the series.
 * @param {Record<string, unknown>} item
 * @param {string} seriesId
 * @param {string} itemId
 * @param {number} number
 * @returns {Episode}
 */
function buildEpisode(item, seriesId, itemId, number) {
  const dramaInfo = dramaInfoOf(item);
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
  const { access, paid, drm, hints, guessedLock } = accessOf(item);
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
    guessedLock,
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
 * negative) within ±{@link MAX_EXACT_INT} — what Python reads exactly too; null otherwise (bools,
 * `Infinity`, a longer number included).
 * @param {unknown} value
 * @returns {number | null}
 */
function asInt(value) {
  /** @type {number | null} */
  let found = null;
  if (typeof value === "number") found = value;
  else if (typeof value === "string") found = pyDecimalInt(pyStrip(value));
  return found !== null && Number.isSafeInteger(found) ? found : null;
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
 * `catalog._episode_number`: the first usable episode number (an int ≥ 1) among `DramaVideoData`'s
 * number keys, then `dramaInfo`'s; a key present with junk (`0`, `null`, `""`, `2.5`) falls
 * through to the next one; null when none is usable.
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
        if (number !== null && number >= 1) return number;
      }
    }
  }
  return null;
}

/**
 * One `item_list` page: the episodes of the series, the pagination cursor and `hasMore`.
 * `cursor` is read from the top level first, else the first one found recursively (items
 * themselves are not searched); `hasMore` is true only for `hasMore`/`has_more` being `true`
 * (also `1` / `"true"`). Every item that is no episode of the series is kept in `skipped` with its
 * reason ({@link skipReason}) and its id; `totalHint` is the first positive `dramaInfo.numVideos`
 * of an item of the series ({@link itemTotalHint}).
 * @param {unknown} payload
 * @param {string} seriesId
 * @returns {PagePayload}
 */
export function parseItemListPayload(payload, seriesId) {
  /** @type {Episode[]} */
  const episodes = [];
  /** @type {SkippedItem[]} */
  const skipped = [];
  /** @type {(string | null)[]} */
  const keys = [];
  let seen = 0;
  /** @type {number | null} */
  let total = null;
  for (const items of findItemLists(payload)) {
    for (const item of items) {
      seen += 1;
      const found = identify(item, seriesId);
      if (found.reason === null && found.itemId !== null && found.number !== null) {
        episodes.push(buildEpisode(item, seriesId, found.itemId, found.number));
      } else {
        skipped.push({ reason: found.reason ?? SKIP_NO_ID, itemId: found.itemId });
        keys.push(found.itemId === null ? itemKey(item) : null);
      }
      if (total === null) total = itemTotalHint(item, seriesId);
    }
  }
  const cursor = asCursor(firstValue(payload, ["cursor"]));
  const hasMore = asFlag(firstValue(payload, ["hasMore", "has_more"]));
  return { episodes, cursor, hasMore, seenItems: seen, skippedItems: skipped.length, skipped, totalHint: total, skippedKeys: keys };
}

/** How deep {@link itemKey} writes a raw item before it writes a marker instead (`catalog._canonical`). */
const MAX_KEY_DEPTH = MAX_DEPTH * 4;

/**
 * The canonical JSON of a raw item (3.0.1, the review's L4; `catalog.item_key`): its keys sorted at
 * every depth, no spaces, a number that is not finite written as `null` — so that two copies of one
 * item give one key. {@link mergePages} dedupes the items without an id by it. The Python tool's
 * agrees on which items are the same (parity-tested); the strings themselves may differ. Pure;
 * never throws.
 * @param {unknown} item
 * @returns {string}
 */
export function itemKey(item) {
  return canonical(item, 0);
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @returns {string}
 */
function canonical(value, depth) {
  if (Array.isArray(value)) {
    if (depth > MAX_KEY_DEPTH) return JSON.stringify("<list>"); // deeper than any item: its kind only
    return `[${value.map((inner) => canonical(inner, depth + 1)).join(",")}]`;
  }
  if (isDict(value)) {
    if (depth > MAX_KEY_DEPTH) return JSON.stringify("<dict>");
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "string" || typeof value === "boolean" || value === null) return JSON.stringify(value);
  return JSON.stringify(String(value));
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
 * Combine pages: dedupe by item id (the first seen stays), then keep one episode per number by the
 * preference order of {@link mergePages}; sort by number.
 * @param {Iterable<Iterable<Episode>>} pages
 * @returns {Episode[]}
 */
export function mergeEpisodes(pages) {
  return merge(pages).episodes;
}

/**
 * The pages of one listing as a {@link Listing} (`catalog.merge_pages`). The episodes are deduped
 * by item id, THEN merged by number: of several items with one number the series keeps the one
 * that is no highlight ({@link isHighlight}), then one that reads free or unlocked over one that
 * reads locked, then the longer `video.duration` (an unknown one is the shortest), then the first
 * listed — every other item is a {@link Duplicate} naming the rule that decided. A number only
 * highlights hold keeps one of them as its episode, by the same order (4.0.1, the owner's report of
 * 2026-11-27: TikTok marks some full episodes as highlights — episodes 9 and 17 of the owner's drama
 * of 66 —, so a highlight alone with its number is that number's episode and downloads like any
 * other). The skipped items keep their reasons, once per item id (an id read as an episode on
 * another page is no skipped item), and an item without an id once per listing (3.0.1, the review's
 * L4: its canonical JSON, `PagePayload.skippedKeys`; a page built by hand without keys counts each
 * one). `itemsReceived` counts the distinct items of the series: every episode before the number
 * merge plus the skipped items that do not name another drama. `totalHint` is the first page's
 * count.
 * @param {Iterable<PagePayload>} pages
 * @returns {Listing}
 */
export function mergePages(pages) {
  const listed = [...pages];
  const { episodes, duplicates } = merge(listed.map((page) => page.episodes));
  /** @type {Set<string>} */
  const episodeIds = new Set();
  for (const page of listed) for (const episode of page.episodes) episodeIds.add(episode.itemId);
  /** @type {SkippedItem[]} */
  const skipped = [];
  /** @type {Set<string>} */
  const skippedIds = new Set();
  /** @type {Set<string>} */
  const skippedKeys = new Set();
  for (const page of listed) {
    for (const [index, item] of page.skipped.entries()) {
      if (typeof item.itemId === "string") {
        if (episodeIds.has(item.itemId) || skippedIds.has(item.itemId)) continue;
        skippedIds.add(item.itemId);
      } else {
        const key = page.skippedKeys?.[index] ?? null;
        if (key !== null) {
          if (skippedKeys.has(key)) continue;
          skippedKeys.add(key);
        }
      }
      skipped.push(item);
    }
  }
  const received = episodeIds.size + skipped.filter((item) => item.reason !== SKIP_OTHER_DRAMA).length;
  /** @type {number | null} */
  let total = null;
  for (const page of listed) {
    if (page.totalHint !== null && page.totalHint > 0) {
      total = page.totalHint;
      break;
    }
  }
  return { episodes, duplicates, skipped, itemsReceived: received, totalHint: total };
}

/**
 * `catalog._merge`: the episodes of `pages` deduped by item id, then one per number by the
 * preference order — a number only highlights hold keeps one of them —, sorted by number; and every
 * item left out, by number then as listed.
 * @param {Iterable<Iterable<Episode>>} pages
 * @returns {{episodes: Episode[], duplicates: Duplicate[]}}
 */
function merge(pages) {
  /** @type {Map<string, Episode>} */
  const byItem = new Map();
  for (const page of pages) {
    for (const episode of page) if (!byItem.has(episode.itemId)) byItem.set(episode.itemId, episode);
  }
  /** @type {Map<number, Episode[]>} */
  const byNumber = new Map();
  for (const episode of byItem.values()) {
    const candidates = byNumber.get(episode.number);
    if (candidates === undefined) byNumber.set(episode.number, [episode]);
    else candidates.push(episode);
  }
  /** @type {Episode[]} */
  const episodes = [];
  /** @type {Duplicate[]} */
  const duplicates = [];
  for (const number of [...byNumber.keys()].sort((a, b) => a - b)) {
    const candidates = /** @type {Episode[]} */ (byNumber.get(number));
    let kept = /** @type {Episode} */ (candidates[0]);
    for (const candidate of candidates.slice(1)) if (comparePreference(candidate, kept) < 0) kept = candidate;
    episodes.push(kept);
    for (const other of candidates) {
      if (other !== kept) duplicates.push({ number, kept, leftOut: other, why: leftOutWhy(kept, other) });
    }
  }
  return { episodes, duplicates };
}

/**
 * `catalog._preference`: the merge's sort key, smaller kept — a highlight last, then a locked
 * episode, then the shorter `video.duration` (an unknown duration below every known one).
 * @param {Episode} episode
 * @returns {number[]}
 */
function preference(episode) {
  const duration = episode.durationS ?? -1;
  return [isHighlight(episode.raw) ? 1 : 0, isLocked(episode) ? 1 : 0, -duration];
}

/**
 * Python's tuple order on two {@link preference} keys: negative when `a` is kept over `b`.
 * @param {Episode} a
 * @param {Episode} b
 * @returns {number}
 */
function comparePreference(a, b) {
  const left = preference(a);
  const right = preference(b);
  for (let index = 0; index < left.length; index += 1) {
    const x = /** @type {number} */ (left[index]);
    const y = /** @type {number} */ (right[index]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The first rule of the preference order that tells `leftOut` from `kept`.
 * @param {Episode} kept
 * @param {Episode} leftOut
 * @returns {string}
 */
function leftOutWhy(kept, leftOut) {
  const keptKey = preference(kept);
  const leftKey = preference(leftOut);
  const whys = [LEFT_OUT_HIGHLIGHT, LEFT_OUT_LOCKED, LEFT_OUT_SHORTER];
  for (let index = 0; index < whys.length; index += 1) {
    if (leftKey[index] !== keptKey[index]) return /** @type {string} */ (whys[index]);
  }
  return LEFT_OUT_LATER;
}

/**
 * THE count rule of a listing (3.0.1, the owner's report of 2026-11-27; `catalog.count_check`,
 * parity-tested): with C TikTok's count (`totalHint`, unknown when it is not a positive number), E
 * the distinct episode numbers listed (an episode TikTok marks as a highlight among them:
 * {@link mergePages}), H their highest (0 for none) and S = `itemsReceived` - |E| the drama's other
 * items received (0 when `itemsReceived` is unknown: a series built by hand), the numbers certainly
 * an episode of the drama are 1..`certainTop` = max(H, C - S) — H when C is unknown —, and the list
 * is `uncertain` when C is known and above `certainTop` (only possible when S > 0): whether TikTok
 * counts the S other items or S episodes past H are missing, nothing in the list tells. Pure.
 * @param {Iterable<number>} numbers
 * @param {number | null | undefined} totalHint
 * @param {number | null | undefined} itemsReceived
 * @returns {CountCheck}
 */
export function countCheck(numbers, totalHint, itemsReceived) {
  const listed = new Set(numbers);
  let highest = 0;
  for (const number of listed) if (number > highest) highest = number;
  const otherItems = itemsReceived === null || itemsReceived === undefined ? 0 : Math.max(0, itemsReceived - listed.size);
  if (totalHint === null || totalHint === undefined || !(totalHint > 0)) return { certainTop: highest, otherItems, uncertain: false };
  const certainTop = Math.max(highest, totalHint - otherItems);
  return { certainTop, otherItems, uncertain: totalHint > certainTop };
}

/**
 * The episode numbers a listing certainly lacks, ascending (`catalog.missing_numbers`): every
 * number from 1 up to {@link countCheck}'s `certainTop` that is not listed — a hole below the
 * highest number listed (5, then 7 without 6) and the numbers above it up to TikTok's count less
 * the drama's other items received —; never above `limit`. A number past `certainTop` is never
 * named: an uncertain list is said, not given rows (3.0.1).
 * @param {Iterable<number>} numbers
 * @param {number | null | undefined} totalHint
 * @param {number | null | undefined} itemsReceived
 * @param {number} limit
 * @returns {number[]}
 */
export function missingNumbers(numbers, totalHint, itemsReceived, limit) {
  const listed = new Set(numbers);
  const top = Math.min(countCheck(listed, totalHint, itemsReceived).certainTop, limit);
  /** @type {number[]} */
  const missing = [];
  for (let number = 1; number <= top; number += 1) if (!listed.has(number)) missing.push(number);
  return missing;
}

/**
 * The ids of the page's items of the series (`catalog.series_item_ids`) — its episodes, then the
 * items DramaFetch could not read that do not name another drama — in page order; an item without
 * an id gives none.
 * @param {PagePayload} page
 * @returns {string[]}
 */
export function seriesItemIds(page) {
  const ids = page.episodes.map((episode) => episode.itemId);
  for (const item of page.skipped) {
    if (item.reason !== SKIP_OTHER_DRAMA && item.itemId !== null) ids.push(item.itemId);
  }
  return ids;
}

/**
 * Whether an episode-list page says the series' list is over (`catalog.page_ends_list`): an answer
 * that holds a list (`listed`: an answer without one — TikTok's error JSON, say — ends nothing)
 * whose `hasMore` is false and that is no repeat: it holds no item of the series at all (an empty
 * last page), or one whose id `seenIds` — the ids of the series' items earlier pages brought —
 * does not hold. A page that only repeats items already listed (TikTok answering a later cursor
 * with the first page again) ends nothing, whatever its `hasMore` says; and (3.0.1, the review's L5)
 * an answer with no item of the series ends nothing when more was expected (`expectedMore`: it
 * answers a cursor an earlier page announced with `hasMore` true, or a gap-filling request) — TikTok
 * may answer a re-signed request with an empty list; a last page that brings items of the series
 * still ends the list.
 * @param {PagePayload} page
 * @param {Iterable<string>} seenIds
 * @param {boolean} [listed]
 * @param {boolean} [expectedMore]
 * @returns {boolean}
 */
export function pageEndsList(page, seenIds, listed = true, expectedMore = false) {
  if (!listed || page.hasMore) return false;
  /** @type {(string | null)[]} */
  const own = page.episodes.map((episode) => episode.itemId);
  for (const item of page.skipped) if (item.reason !== SKIP_OTHER_DRAMA) own.push(item.itemId);
  if (own.length === 0) return !expectedMore;
  const seen = new Set(seenIds);
  return own.some((itemId) => itemId !== null && !seen.has(itemId));
}

/**
 * The episode number the gap filling asks TikTok for next — the list page from `cursor` = that
 * number - 1 — or null when nothing is left to ask (`catalog.fill_target`): the first number
 * {@link missingNumbers} names (a hole below the highest number listed, or a number up to TikTok's
 * count less the drama's other items received: {@link countCheck}) that no earlier filling answer
 * covered (`options.covered`: the spans {@link fillCovered} gave, `[low, high]` with `high` null for
 * no bound); else, once every such number is covered, the number after the highest one listed,
 * unless an answer covered it, when the list ended early (`options.earlyEnd`) and TikTok's count is
 * unknown, or when the list is uncertain (3.0.1: TikTok counts more than the drama certainly has —
 * the page after the highest number listed is asked for once). A known count everything listed
 * accounts for leaves nothing to ask past the highest number listed.
 * @param {Iterable<number>} numbers
 * @param {number | null | undefined} totalHint
 * @param {number | null | undefined} itemsReceived
 * @param {{earlyEnd: boolean, covered?: readonly (readonly [number, number | null])[], limit: number}} options
 * @returns {number | null}
 */
export function fillTarget(numbers, totalHint, itemsReceived, options) {
  const spans = options.covered ?? [];
  const isCovered = (/** @type {number} */ number) =>
    spans.some(([low, high]) => low <= number && (high === null || number <= high));
  const listed = [...numbers];
  for (const number of missingNumbers(listed, totalHint, itemsReceived, options.limit)) {
    if (!isCovered(number)) return number;
  }
  const unknown = totalHint === null || totalHint === undefined || !(totalHint > 0);
  if ((options.earlyEnd && unknown) || countCheck(listed, totalHint, itemsReceived).uncertain) {
    let highest = 0;
    for (const number of listed) if (number > highest) highest = number;
    const after = highest + 1;
    if (after <= options.limit && !isCovered(after)) return after;
  }
  return null;
}

/**
 * The episode numbers one filling answer covered, from `target` on (`catalog.fill_covered`) —
 * those the filling stops asking for once the answer did not bring them: every number from
 * `target` on when the answer says the list is over (`hasMore` false; null: no upper bound); while
 * it says more, up to the highest number at or above `target` it listed (TikTok sent a shorter page
 * than asked), else up to `target + count - 1` (the page asked; `count` at least 1).
 * @param {number} target
 * @param {number} count
 * @param {PagePayload | null} answer
 * @returns {[number, number | null]}
 */
export function fillCovered(target, count, answer) {
  if (answer !== null && !answer.hasMore) return [target, null];
  /** @type {number | null} */
  let reached = null;
  for (const episode of answer === null ? [] : answer.episodes) {
    if (episode.number >= target && (reached === null || episode.number > reached)) reached = episode.number;
  }
  if (reached !== null) return [target, reached];
  return [target, target + Math.max(1, count) - 1];
}

/**
 * Human-readable oddities of a listing (`catalog.catalog_warnings`), in this order: the gaps below
 * the highest number listed; one line per item left out for another one's number — those
 * `episodes` holds itself (found by {@link mergePages}' rules), then `options.duplicates` — naming
 * the number, the item left out and why, and the item kept; one line per reason of the
 * `options.skipped` items, with their count ({@link SKIP_REASONS} first); TikTok's count against the
 * numbers listed whenever they differ (`TikTok announces N episodes, M listed`: more listed than it
 * announces, or fewer — 3.0.1, the review's L2: other items received never silence it); when
 * {@link countCheck} finds the list uncertain, what TikTok counts, what was listed and that
 * DramaFetch cannot tell ({@link uncertainText}); the locked count.
 * @param {readonly Episode[]} episodes
 * @param {number | null} totalHint
 * @param {{duplicates?: readonly Duplicate[], skipped?: readonly SkippedItem[], itemsReceived?: number | null}} [options]
 * @returns {string[]}
 */
export function catalogWarnings(episodes, totalHint, options = {}) {
  /** @type {string[]} */
  const warnings = [];
  const numbers = [...new Set(episodes.map((episode) => episode.number))].sort((a, b) => a - b);
  let expected = 1;
  for (const number of numbers) {
    if (number > expected) warnings.push(gapText(expected, number - 1));
    expected = number + 1;
  }
  const found = [...merge([episodes]).duplicates, ...(options.duplicates ?? [])];
  found.sort((a, b) => a.number - b.number);
  for (const duplicate of found) warnings.push(duplicateText(duplicate));
  /** @type {Map<string, number>} */
  const reasons = new Map();
  for (const item of options.skipped ?? []) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
  const order = [...SKIP_REASONS, ...[...reasons.keys()].filter((reason) => !SKIP_REASONS.includes(reason))];
  for (const reason of order) {
    const count = reasons.get(reason) ?? 0;
    if (count > 0) warnings.push(skippedText(count, reason));
  }
  if (totalHint !== null && totalHint > 0 && numbers.length !== totalHint) {
    warnings.push(`TikTok announces ${totalHint} episodes, ${numbers.length} listed`);
  }
  const check = countCheck(numbers, totalHint, options.itemsReceived ?? null);
  if (check.uncertain && totalHint !== null) warnings.push(uncertainText(totalHint, numbers.length, check.otherItems));
  const locked = episodes.filter(isLocked).length;
  if (locked === 1) warnings.push("1 episode looks locked");
  else if (locked > 1) warnings.push(`${locked} episodes look locked`);
  return warnings;
}

/**
 * @param {Duplicate} duplicate
 * @returns {string}
 */
function duplicateText(duplicate) {
  return (
    `duplicate episode number ${duplicate.number}: item ${duplicate.leftOut.itemId} left out (${duplicate.why}), ` +
    `item ${duplicate.kept.itemId} kept`
  );
}

/**
 * `1 other item (a trailer or a highlight)` / `2 other items (trailers or highlights)`
 * (`catalog.other_items_text`).
 * @param {number} count
 * @returns {string}
 */
export function otherItemsText(count) {
  return count === 1 ? "1 other item (a trailer or a highlight)" : `${count} other items (trailers or highlights)`;
}

/**
 * `1 episode` / `2 episodes`.
 * @param {number} count
 * @returns {string}
 */
function episodesText(count) {
  return count === 1 ? "1 episode" : `${count} episodes`;
}

/**
 * The warning of an uncertain list (3.0.1, the review's L2; `catalog.uncertain_text`): `TikTok's
 * list may be incomplete: TikTok counts 66 episodes; 65 episodes and 1 other item (a trailer or a
 * highlight) were listed, so DramaFetch cannot tell whether an episode is missing — paste the drama
 * again later to check again`.
 * @param {number} total
 * @param {number} listed
 * @param {number} other
 * @returns {string}
 */
export function uncertainText(total, listed, other) {
  return (
    `${UNCERTAIN_TEXT}: TikTok counts ${episodesText(total)}; ${episodesText(listed)} and ${otherItemsText(other)} ` +
    "were listed, so DramaFetch cannot tell whether an episode is missing — paste the drama again later to check again"
  );
}

/**
 * @param {number} count
 * @param {string} reason
 * @returns {string}
 */
function skippedText(count, reason) {
  return `TikTok listed ${count} ${count === 1 ? "item" : "items"} DramaFetch could not read (${reason})`;
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
 * `dramaName`, `title` or `name`, the total the first positive integer under `numVideos` (TikTok's
 * count), `totalEpisode`, `totalEpisodes`, `episodeCount`, `total` or `episodeTotal`. With
 * `seriesId`, an object whose own series id names another drama gives neither.
 * @param {unknown} payload
 * @param {string | null} [seriesId]
 * @returns {{name: string | null, total: number | null}}
 */
export function parseDetailPayload(payload, seriesId = null) {
  /** @type {string | null} */
  let name = null;
  /** @type {number | null} */
  let total = null;
  for (const container of detailContainers(payload)) {
    if (seriesId !== null && seriesId !== undefined) {
      const foundSeriesId = seriesIdOf(container);
      if (foundSeriesId !== null && foundSeriesId !== String(seriesId)) continue;
    }
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
    const urls = playUrls(get(entry, "PlayAddr"), 0).filter((url) => !isVideoOnlyUrl(url));
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
  ordered.push(...playUrls(get(video, "playAddr"), 0).filter((url) => !isVideoOnlyUrl(url)));
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
/**
 * True for a play URL whose path ends with {@link VIDEO_ONLY_PATH_SUFFIX}: one of TikTok's HEVC
 * streams without an audio track, never a candidate (`catalog.is_video_only_url`). The path is
 * the URL up to its first `?` or `#`.
 * @param {string} url
 * @returns {boolean}
 */
export function isVideoOnlyUrl(url) {
  const path = url.split("#", 1)[0].split("?", 1)[0];
  return path.endsWith(VIDEO_ONLY_PATH_SUFFIX);
}

/**
 * The http(s) URLs of a play address: a string, a list of them or a dict with a `UrlList`
 * (`catalog._play_urls`), depth-limited.
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
