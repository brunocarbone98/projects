// @ts-check
// Unit tests of src/lib/catalog.js (the Python parity is proven by tests/test_extension_parity.py).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  LEFT_OUT_HIGHLIGHT,
  LEFT_OUT_LATER,
  LEFT_OUT_LOCKED,
  LEFT_OUT_REASONS,
  LEFT_OUT_SHORTER,
  NO_PLAY_ADDRESS,
  SHORT_HEADER_HINT_PREFIX,
  SKIP_HIGHLIGHT,
  SKIP_NO_ID,
  SKIP_NO_NUMBER,
  SKIP_OTHER_DRAMA,
  SKIP_REASONS,
  UNCERTAIN_TEXT,
  VIDEO_ONLY_PATH_SUFFIX,
  accessOf,
  catalogWarnings,
  chooseRendition,
  codecName,
  countCheck,
  coverUrlOf,
  episodeFromItem,
  fillTarget,
  findItemLists,
  isDrmKey,
  isHighlight,
  isLocked,
  isVideoOnlyUrl,
  itemKey,
  itemTotalHint,
  keyWords,
  listedSizes,
  makeEpisode,
  mergeEpisodes,
  mergePages,
  missingNumbers,
  pageEndsList,
  parseDetailPayload,
  parseItemListPayload,
  playUrlCandidates,
  renditions,
  skipReason,
  uncertainText,
  urlExpiry,
} from "../src/lib/catalog.js";
import { seededRng } from "../src/lib/pacing.js";

const SERIES_ID = "7699393770256782354";
const PAID_SERIES_ID = "7699393770256782388";
const PLAYABLE = { playAddr: "https://v16-webapp-prime.tiktok.com/video/tos/x/?a=1988&expire=1" };

/**
 * @param {string} name
 * @returns {unknown}
 */
function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf8"));
}

/**
 * An item like tests/test_catalog.py's `_item`: `drama` goes into `dramaInfo.DramaVideoData`.
 * @param {Record<string, unknown> | null} drama
 * @param {Record<string, unknown> | null} [video]
 * @returns {Record<string, unknown>}
 */
function item(drama, video = PLAYABLE) {
  /** @type {Record<string, unknown>} */
  const built = { id: "1" };
  if (video !== null) built["video"] = { ...video };
  if (drama !== null) built["dramaInfo"] = { DramaVideoData: { EpisodeNumber: 1, ...drama } };
  return built;
}

test("the two pages of the main series list episodes 1-5, a trailer and a foreign item skipped", () => {
  const page1 = parseItemListPayload(fixture("item_list_page1.json"), SERIES_ID);
  const page2 = parseItemListPayload(fixture("item_list_page2.json"), SERIES_ID);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.cursor, 3);
  const merged = mergeEpisodes([page1.episodes, page2.episodes]);
  assert.deepEqual(
    merged.map((episode) => episode.number),
    [1, 2, 3, 4, 5],
  );
  const last = /** @type {import("../src/lib/catalog.js").Episode} */ (merged[4]);
  assert.equal(isLocked(last), true);
  assert.ok(last.lockHints.length > 0);
  assert.equal(merged[0]?.qualityHint, "720p h264");
  assert.match(String(merged[0]?.coverUrl), /^https:\/\/p16-sign-sg\.tiktokcdn\.com\/.*origin\.jpeg/);
  assert.ok(page1.skippedItems + page2.skippedItems >= 1);
});

test("the paid series: episode 3 unlocked for the session that bought it, locked without one", () => {
  const loggedIn = parseItemListPayload(fixture("item_list_series3_logged_in.json"), PAID_SERIES_ID).episodes;
  const loggedOut = parseItemListPayload(fixture("item_list_series3_logged_out.json"), PAID_SERIES_ID).episodes;
  assert.deepEqual(
    loggedIn.map((episode) => [episode.number, episode.access, episode.paid]),
    [
      [1, "free", false],
      [2, "free", false],
      [3, "unlocked", true],
      [4, "locked", true],
    ],
  );
  assert.equal(loggedOut.find((episode) => episode.number === 3)?.access, "locked");
  assert.ok(loggedOut.every((episode) => !episode.drm));
});

test("a DRM key in whole words locks as DRM; HDR flags, negations and identifiers do not", () => {
  for (const key of ["isDrm", "drmType", "DRMType", "is_encrypted", "videoEncrypted", "encryption"]) {
    assert.equal(isDrmKey(key), true, key);
    const decision = accessOf(item({ [key]: true, isUnlocked: true }));
    assert.deepEqual([decision.access, decision.drm], ["locked", true], key);
  }
  for (const key of ["hdrMode", "HDRType", "isDrmFree", "no_drm", "nonEncrypted", "unEncrypted", "encryptedUid", "encryptedUIDs"]) {
    assert.equal(isDrmKey(key), false, key);
    assert.deepEqual(accessOf(item({ [key]: 1 })), { access: "free", paid: false, drm: false, hints: [], guessedLock: false }, key);
  }
  // a DRM negation is no price flag either: `isDrmFree: false` is not `isFree=false`
  for (const key of ["isDrmFree", "drm_free", "encryptionFree"]) {
    assert.deepEqual(accessOf(item({ [key]: false, unlockPrice: 30 })).hints, ["unlockPrice=30"], key);
    assert.deepEqual(accessOf(item({ [key]: true, unlockPrice: 30 })), { access: "unlocked", paid: true, drm: false, hints: ["unlockPrice=30"], guessedLock: false }, key);
  }
  assert.deepEqual(keyWords("encryptedUserIDs"), ["encrypted", "user", "ids"]);
  assert.deepEqual(keyWords("HDR10Plus"), ["hdr", "10", "plus"]);
});

test("the decision table: entitled, viewer lock, sold with and without a real play URL", () => {
  assert.equal(accessOf(item({ isUnlocked: true }, {})).access, "unlocked"); // entitled needs no URL
  assert.equal(accessOf(item({ isLocked: true, unlockPrice: 30 })).access, "locked");
  assert.deepEqual(accessOf(item({ isFree: false, unlockPrice: 30 })), {
    access: "unlocked",
    paid: true,
    drm: false,
    hints: ["isFree=false", "unlockPrice=30"],
    guessedLock: false,
  });
  assert.deepEqual(accessOf(item({ isFree: false }, { playAddr: "null" })), {
    access: "locked",
    paid: true,
    drm: false,
    hints: ["isFree=false", NO_PLAY_ADDRESS],
    guessedLock: false, // 3.0.1: sold, so no guess of DramaFetch's alone
  });
  // a NOT-ENTITLED flag decides for a sold episode only
  assert.equal(accessOf(item({ isFree: false, isUnlocked: false })).access, "locked");
  assert.equal(accessOf(item({ isUnlocked: false })).access, "free");
  // "block" is not "lock"
  assert.deepEqual(accessOf(item({ blockStatus: 1, isBlocked: true })).hints, []);
  assert.equal(accessOf(item({ subLockStatus: 1 })).access, "locked");
  // booleans print as Python prints them, keys are own properties only
  assert.deepEqual(accessOf(item({ isUnlocked: true })).hints, ["isUnlocked=True"]);
  assert.deepEqual(accessOf({ toString: 1, video: PLAYABLE }).hints, []);
  assert.deepEqual(accessOf(null), { access: "locked", paid: false, drm: false, hints: [NO_PLAY_ADDRESS], guessedLock: true });
});

/**
 * An item of a free series with conditions as TikTok served it on 2026-11-06 (the owner's report, anonymised):
 * `dramaInfo.isLimitedFree`, `IsFreeIntro: false`, `IsPreview` / `PreviewType` on every episode,
 * `video.size` equal to the H.264 rendition's `DataSize`, the episode's own sound in `music`.
 * @param {number} number
 * @param {{videoDuration: number, musicDuration: unknown, original?: unknown, isPreview?: boolean, previewType?: number, extra?: Record<string, unknown>}} fields
 * @returns {Record<string, unknown>}
 */
function limitedFreeItem(number, fields) {
  const music = { duration: fields.musicDuration, shoot_duration: fields.musicDuration, title: "original sound", authorName: "Author", id: "77" };
  if (fields.original !== undefined) /** @type {Record<string, unknown>} */ (music)["original"] = fields.original;
  return {
    id: `769939377025678${String(number).padStart(4, "0")}`,
    desc: `Episode ${number}`,
    dramaInfo: {
      DramaVideoData: {
        EpisodeNumber: number,
        IsFreeIntro: false,
        IsHighlight: false,
        IsPreview: fields.isPreview ?? true,
        LinkedEpisodeID: "0",
        PreviewType: fields.previewType ?? 4,
      },
      dramaID: "7699393770256782366",
      dramaName: "Limited Free Drama",
      isLimitedFree: true,
      numVideos: 3,
      totalDuration: "9",
      ...(fields.extra ?? {}),
    },
    music,
    video: {
      duration: fields.videoDuration,
      size: 9676471,
      bitrate: 726189,
      ratio: "540p",
      bitrateInfo: [
        {
          Bitrate: 726189,
          CodecType: "h264",
          GearName: "normal_540_0",
          PlayAddr: { DataSize: 9676471, UrlList: [`https://v16-webapp-prime.tiktok.com/video/${number}/?a=1988&expire=1900000000`], Uri: "v1", UrlKey: "v1_h264_540p_726189", Width: 576, Height: 1024 },
        },
        {
          Bitrate: 345913,
          CodecType: "h265_hvc1",
          GearName: "adapt_540_1",
          PlayAddr: { DataSize: 4609304, UrlList: [`https://v16-webapp-prime.tiktok.com/video/${number}/hevc/?a=1988&expire=1900000000`] },
        },
      ],
      playAddr: `https://v16-webapp-prime.tiktok.com/video/${number}/?a=1988&expire=1900000000`,
      cover: `https://p16-sign-sg.tiktokcdn.com/c/${number}.jpeg`,
      originCover: `https://p16-sign-sg.tiktokcdn.com/o/${number}.jpeg`,
    },
  };
}

test("a free series with conditions (2026-11-06): isLimitedFree is free, IsFreeIntro / IsPreview / PreviewType give no clue", () => {
  // a free flag alone is no hint: it says nothing about a price or a lock (an empty list means that)
  const full = accessOf(limitedFreeItem(1, { videoDuration: 69, musicDuration: 69, original: true }));
  assert.deepEqual(full, { access: "free", paid: false, drm: false, hints: [], guessedLock: false });
  // E02: IsPreview true, PreviewType 4, the sound as long as the video: free as well
  assert.equal(accessOf(limitedFreeItem(2, { videoDuration: 106, musicDuration: 106, original: true, previewType: 4 })).access, "free");
  // E03: the episode's own sound lasts 2 s of a 3 s video: the short header locks it, that hint alone
  const windowed = accessOf(limitedFreeItem(3, { videoDuration: 3, musicDuration: 2, original: true, isPreview: false, previewType: 1 }));
  assert.deepEqual(windowed, { access: "locked", paid: false, drm: false, hints: [`${SHORT_HEADER_HINT_PREFIX}2 s of 3 s`], guessedLock: true });
  assert.equal(SHORT_HEADER_HINT_PREFIX, "plays ");
  // the owner's E05: 106 s announced, the sound 69 s
  const owner = accessOf(limitedFreeItem(5, { videoDuration: 106, musicDuration: 69, original: true }));
  assert.deepEqual([owner.access, owner.hints], ["locked", ["plays 69 s of 106 s"]]);
  // the episodes parse with that access and the hint; the quality hint still names the H.264 rendition
  const episodes = [1, 3].map((number) =>
    episodeFromItem(limitedFreeItem(number, { videoDuration: 3, musicDuration: number === 3 ? 2 : 3, original: true }), "7699393770256782366"),
  );
  assert.deepEqual(
    episodes.map((episode) => [episode?.number, episode?.access, episode?.lockHints, episode?.paid, episode?.qualityHint]),
    [
      [1, "free", [], false, "540p h264"],
      [3, "locked", ["plays 2 s of 3 s"], false, "540p h264"],
    ],
  );
  // IsFreeIntro gives no clue whatever its value; preview, trial and intro keys alone are nothing
  assert.deepEqual(accessOf(item({ IsFreeIntro: false })), { access: "free", paid: false, drm: false, hints: [], guessedLock: false });
  assert.deepEqual(accessOf(item({ IsFreeIntro: true, is_free_intro: 1 })).hints, []);
  assert.deepEqual(accessOf(item({ isPreview: true })), { access: "free", paid: false, drm: false, hints: [], guessedLock: false });
  assert.deepEqual(accessOf(item({ IsPreview: true, PreviewType: 4, isTrial: true, preview_type: 1 })).hints, []);
  // a FREE clue beats pricing: a sold series the payload calls free is free (and still `paid`);
  // next to the price the free flag IS a hint — it says why
  assert.deepEqual(accessOf(item({ isLimitedFree: true, unlockPrice: 30 })), {
    access: "free",
    paid: true,
    drm: false,
    hints: ["isLimitedFree=True", "unlockPrice=30"],
    guessedLock: false,
  });
  assert.deepEqual(accessOf(item({ isFree: false, isLimitedFree: true })).hints, ["isFree=false", "isLimitedFree=True"]);
  assert.deepEqual(accessOf(item({ limitedFree: 1 })), { access: "free", paid: false, drm: false, hints: [], guessedLock: false });
  assert.deepEqual(accessOf(item({ isFree: true })).hints, []);
  assert.deepEqual(accessOf(item({ freebie: "yes", coinCost: 5 })).hints, ["freebie=yes", "coinCost=5"]); // `free` anywhere in the key
  // the falsy free key keeps its old hint for every free key but an intro or a DRM one
  assert.deepEqual(accessOf(item({ freeEpisode: 0 })).hints, ["isFree=false"]);
  assert.deepEqual(accessOf(item({ is_free: "false" })).hints, ["isFree=false"]);
  assert.deepEqual(accessOf(item({ freeIntroPrice: 5 })).hints, ["freeIntroPrice=5"]); // an intro key is no free key: the price counts
  // a free clue does not lift a lock, a missing play address or an entitlement
  assert.equal(accessOf(item({ isLimitedFree: true, isLocked: true })).access, "locked");
  assert.equal(accessOf(item({ isLimitedFree: true }, { playAddr: "" })).access, "locked");
  assert.deepEqual(accessOf(item({ isLimitedFree: true }, {})).hints, [NO_PLAY_ADDRESS]);
  assert.equal(accessOf(item({ isLimitedFree: true, isUnlocked: true })).access, "unlocked");
});

test("the short header: music.original, both durations, 85 % and a 1 s gap; the decision order", () => {
  /** @param {unknown} music @param {Record<string, unknown>} [video] @param {Record<string, unknown>} [drama] */
  const windowed = (music, video = { duration: 106, ...PLAYABLE }, drama = {}) => accessOf({ ...item(drama, video), music });
  const sound = (/** @type {unknown} */ duration, /** @type {unknown} */ original = true) => ({ duration, original });
  // 3.0.1: locked only by the SHORT-HEADER guess: `guessedLock`
  assert.deepEqual(windowed(sound(69)), { access: "locked", paid: false, drm: false, hints: ["plays 69 s of 106 s"], guessedLock: true });
  // never without `original` truthy (a licensed track's length says nothing), nor without either duration
  assert.deepEqual(windowed(sound(69, false)).hints, []);
  assert.deepEqual(windowed(sound(69, 0)).hints, []);
  assert.deepEqual(windowed({ duration: 69 }).hints, []);
  assert.deepEqual(windowed(sound(69), PLAYABLE).hints, []);
  assert.deepEqual(windowed(sound(69), { duration: 0, ...PLAYABLE }).hints, []);
  assert.deepEqual(windowed(sound(69), { duration: "x", ...PLAYABLE }).hints, []);
  assert.deepEqual(windowed(sound("69")).hints, []); // a number only
  assert.deepEqual(windowed(sound(0)).hints, []);
  assert.deepEqual(windowed(sound(true)).hints, []);
  assert.deepEqual(windowed("x").hints, []);
  assert.deepEqual(windowed(null).hints, []);
  // `original` as the payload spells truth; `video.duration` as _as_int reads it
  assert.equal(windowed(sound(69, "true")).access, "locked");
  assert.equal(windowed(sound(69, "0")).access, "free");
  assert.deepEqual(windowed(sound(69), { duration: " 106 ", ...PLAYABLE }).hints, ["plays 69 s of 106 s"]);
  assert.deepEqual(windowed(sound(69), { duration: 106.0, ...PLAYABLE }).hints, ["plays 69 s of 106 s"]);
  // the thresholds: at most 85 % of the video and at least 1 s shorter
  assert.equal(windowed(sound(85), { duration: 100, ...PLAYABLE }).access, "locked");
  assert.equal(windowed(sound(85.5), { duration: 100, ...PLAYABLE }).access, "free");
  assert.equal(windowed(sound(1.5), { duration: 2, ...PLAYABLE }).access, "free"); // 75 %, but only 0.5 s shorter
  assert.equal(windowed(sound(1), { duration: 2, ...PLAYABLE }).access, "locked");
  assert.deepEqual(windowed(sound(69.5)).hints, ["plays 69.5 s of 106 s"]); // floats as Python prints them
  // `video.duration` is read up to Number.MAX_SAFE_INTEGER (catalog.MAX_EXACT_INT); a 400-digit number — Infinity
  // here, an exact int in Python — is junk in both front ends, never an `inf s` hint nor an OverflowError
  assert.deepEqual(windowed(sound(69), { duration: Number.MAX_SAFE_INTEGER, ...PLAYABLE }).hints, [
    `plays 69 s of ${Number.MAX_SAFE_INTEGER} s`,
  ]);
  assert.deepEqual(windowed(sound(69), { duration: 2 ** 53, ...PLAYABLE }).hints, []);
  assert.deepEqual(windowed(sound(69), { duration: "1".repeat(400), ...PLAYABLE }).hints, []);
  assert.deepEqual(windowed(sound(69), { duration: JSON.parse("1".repeat(400)), ...PLAYABLE }).hints, []);
  assert.deepEqual(windowed(sound(Infinity)).hints, []);
  // the music dict is the item's own (an itemStruct wrapper's too), never dramaInfo's
  assert.equal(accessOf({ itemStruct: { id: "1", video: { duration: 106, ...PLAYABLE }, music: sound(69) } }).access, "locked");
  assert.equal(accessOf({ ...item({ music: sound(69) }, { duration: 106, ...PLAYABLE }) }).access, "free");
  // the order: DRM first, then an entitlement that says yes, then the window, then the rest
  assert.equal(windowed(sound(69), { duration: 106, ...PLAYABLE }, { isUnlocked: true }).access, "unlocked");
  const drm = windowed(sound(69), { duration: 106, ...PLAYABLE }, { isDrm: true, isUnlocked: true });
  assert.deepEqual([drm.access, drm.drm], ["locked", true]);
  assert.equal(windowed(sound(69), { duration: 106, ...PLAYABLE }, { isLimitedFree: true }).access, "locked");
  assert.equal(windowed(sound(69), { duration: 106, ...PLAYABLE }, { isFree: false, unlockPrice: 30 }).access, "locked");
  // the window's hint comes after the clues and before the play address'
  assert.deepEqual(windowed(sound(69), { duration: 106, playAddr: "" }, { isFree: false }).hints, [
    "isFree=false",
    "plays 69 s of 106 s",
    NO_PLAY_ADDRESS,
  ]);
});

test("listedSizes: video.size and every PlayAddr.DataSize, positive ints or digit strings, sorted and unique", () => {
  assert.deepEqual(listedSizes(limitedFreeItem(1, { videoDuration: 69, musicDuration: 69 })), [4609304, 9676471]);
  const video = {
    size: "131072",
    bitrateInfo: [
      { PlayAddr: { DataSize: 131072 } },
      { PlayAddr: { DataSize: " ٣ " } },
      { PlayAddr: { DataSize: 0 } },
      { PlayAddr: { DataSize: -5 } },
      { PlayAddr: { DataSize: 1.5 } },
      { PlayAddr: { DataSize: true } },
      { PlayAddr: { DataSize: "x" } },
      { PlayAddr: "x" },
      { PlayAddr: { DataSize: 70000 } },
      "junk",
      null,
    ],
  };
  assert.deepEqual(listedSizes({ id: "1", video }), [3, 70000, 131072]);
  assert.deepEqual(listedSizes({ itemStruct: { video: { size: 7 } } }), [7]);
  assert.deepEqual(listedSizes({ id: "1", video: { size: 2.5, bitrateInfo: {} } }), []);
  // an int both front ends read exactly is kept; above Number.MAX_SAFE_INTEGER (Infinity for a 400-digit one) is junk
  assert.deepEqual(listedSizes({ id: "1", video: { size: Number.MAX_SAFE_INTEGER } }), [Number.MAX_SAFE_INTEGER]);
  assert.deepEqual(listedSizes({ id: "1", video: { size: 2 ** 53, bitrateInfo: [{ PlayAddr: { DataSize: 8 } }] } }), [8]);
  assert.deepEqual(listedSizes({ id: "1", video: { size: "1".repeat(400) } }), []);
  assert.deepEqual(listedSizes({ id: "1", video: { size: JSON.parse("1".repeat(400)) } }), []);
  assert.deepEqual(listedSizes({ id: "1", video: "x" }), []);
  assert.deepEqual(listedSizes({ id: "1" }), []);
  assert.deepEqual(listedSizes(null), []);
  assert.deepEqual(listedSizes([1, 2]), []);
});

test("re.IGNORECASE is Python's: a dotless i, a long s and the Kelvin sign match ASCII letters", () => {
  assert.equal(accessOf(item({ "\u0131sLocked": true })).access, "locked");
  assert.equal(accessOf(item({ "isLoc\u212aed": true })).access, "locked");
  assert.equal(accessOf(item({ "co\u017ft": 5 })).access, "unlocked");
  assert.equal(accessOf(item({ lockStatus: "ye\u017f" })).access, "locked");
});

test("accessOf and episodeFromItem never throw on seeded junk", () => {
  const rng = seededRng(7);
  const keys = ["isLocked", "isUnlocked", "price", "drm", "lockStatus", "video", "dramaInfo", "itemStruct", "bitrateInfo", "playAddr", "id", "", "music", "duration", "original", "size", "PlayAddr", "DataSize", "isLimitedFree", "IsFreeIntro"];
  const scalars = [null, true, false, 0, 1, -1, 1.5, "", "0", "true", "locked", "https://x/?expire=1", "²", 69, 106];
  /**
   * @param {number} depth
   * @returns {unknown}
   */
  const junk = (depth) => {
    const roll = rng.uniform(0, 1);
    if (depth > 5 || roll < 0.45) return scalars[Math.floor(rng.uniform(0, scalars.length))];
    if (roll < 0.75) {
      /** @type {Record<string, unknown>} */
      const dict = {};
      for (let i = 0; i < Math.floor(rng.uniform(0, 6)); i += 1) {
        dict[/** @type {string} */ (keys[Math.floor(rng.uniform(0, keys.length))])] = junk(depth + 1);
      }
      return dict;
    }
    return Array.from({ length: Math.floor(rng.uniform(0, 4)) }, () => junk(depth + 1));
  };
  for (let i = 0; i < 2000; i += 1) {
    const value = junk(0);
    const decision = accessOf(value);
    assert.ok(["free", "unlocked", "locked"].includes(decision.access));
    assert.ok(!decision.drm || decision.access === "locked");
    assert.equal(new Set(decision.hints).size, decision.hints.length);
    assert.deepEqual(accessOf(structuredClone(value)), decision);
    episodeFromItem(value, "s");
    playUrlCandidates(value, "best");
    coverUrlOf(value);
    const sizes = listedSizes(value);
    assert.ok(sizes.every((size, index) => Number.isInteger(size) && size > 0 && (index === 0 || size > /** @type {number} */ (sizes[index - 1]))));
  }
});

test("renditions, the quality modes and the play URL order", () => {
  const video = {
    ratio: "720p",
    playAddr: "https://cdn/play",
    bitrateInfo: [
      { CodecType: "bytevc1", Bitrate: 2000, GearName: "adapt_lower_1080_1", PlayAddr: { UrlList: ["https://cdn/265"] } },
      { CodecType: "h264", Bitrate: 1000, GearName: "normal_720_0", PlayAddr: { UrlList: ["https://cdn/264", "https://cdn/play"] } },
      { CodecType: "h264", Bitrate: 500, PlayAddr: { UrlList: ["null"] } },
    ],
  };
  const entry = { id: "1", video };
  assert.deepEqual(
    renditions(entry).map((rendition) => rendition.label),
    ["1080p bytevc1", "720p h264"],
  );
  assert.equal(chooseRendition(entry)?.label, "720p h264");
  assert.equal(chooseRendition(entry, "best")?.label, "1080p bytevc1");
  assert.deepEqual(playUrlCandidates(entry), ["https://cdn/264", "https://cdn/play", "https://cdn/265"]);
  assert.deepEqual(playUrlCandidates(entry, "best"), ["https://cdn/265", "https://cdn/264", "https://cdn/play"]);
  assert.throws(() => playUrlCandidates(entry, "fast"), /unknown quality 'fast': expected one of compatible, best/);
  assert.equal(codecName("AVC1"), "h264");
  assert.equal(codecName(undefined), "unknown");
});

test("video-only HEVC streams (/media-video-hvc1/) are never candidates, whatever the quality", () => {
  const hvc1 = "https://v16-webapp-prime.tiktok.com/video/tos/x/media-video-hvc1/?a=1988&expire=1";
  const item = {
    video: {
      playAddr: { UrlList: ["https://c/play", "https://c/x/media-video-hvc1/"] },
      bitrateInfo: [
        { CodecType: "bytevc1", Bitrate: 3000000, PlayAddr: { UrlList: [hvc1, "https://c/mirror/media-video-hvc1/#f"] } },
        { CodecType: "bytevc1", Bitrate: 2500000, PlayAddr: { UrlList: ["https://c/hevc-with-audio", hvc1] } },
        { CodecType: "h264", Bitrate: 1000000, PlayAddr: { UrlList: ["https://c/h264"] } },
      ],
    },
  };
  assert.deepEqual(
    renditions(item).map((rendition) => rendition.urlList),
    [["https://c/hevc-with-audio"], ["https://c/h264"]],
  );
  assert.deepEqual(chooseRendition(item, "best")?.urlList, ["https://c/hevc-with-audio"]);
  assert.deepEqual(playUrlCandidates(item, "best"), ["https://c/hevc-with-audio", "https://c/h264", "https://c/play"]);
  assert.deepEqual(playUrlCandidates(item), ["https://c/h264", "https://c/hevc-with-audio", "https://c/play"]);
  assert.equal(VIDEO_ONLY_PATH_SUFFIX, "/media-video-hvc1/");
  assert.ok(isVideoOnlyUrl(hvc1) && isVideoOnlyUrl("https://c/media-video-hvc1/#frag"));
  assert.ok(isVideoOnlyUrl("HTTPS://C/a/media-video-hvc1/?q=1#f"));
  assert.ok(!isVideoOnlyUrl("https://c/media-video-hvc1") && !isVideoOnlyUrl("https://c/?p=/media-video-hvc1/"));
  assert.ok(!isVideoOnlyUrl("https://c/media-video-hvc1/x/") && !isVideoOnlyUrl(""));
});

test("urlExpiry reads the expire parameter as Python's parse_qs does", () => {
  assert.equal(urlExpiry("https://v16.tiktokcdn.com/x/?a=1&expire=1761200000&sig=x"), 1761200000);
  assert.equal(urlExpiry("https://x/?expire=+5"), 5); // "+" is a space
  assert.equal(urlExpiry("https://x/?expire=%2B5"), null);
  assert.equal(urlExpiry("https://x/#?expire=5"), null);
  assert.equal(urlExpiry("https://[::1/?expire=5"), null); // urlsplit refuses it
  assert.equal(urlExpiry("https://x/?%EF%BB%BFexpire=5"), null); // a BOM stays part of the name
  assert.equal(urlExpiry("https://x/?expire=٣"), 3);
  assert.equal(urlExpiry(42), null);
});

test("findItemLists is depth-limited; details, warnings and hand-built episodes", () => {
  /** @type {unknown} */
  let deep = { itemList: [{ id: "x" }] };
  for (let i = 0; i < 20; i += 1) deep = { level: deep };
  assert.deepEqual(findItemLists(deep), []);
  assert.deepEqual(findItemLists(deep, 50), [[{ id: "x" }]]);
  assert.deepEqual(parseDetailPayload({ data: { dramaInfo: { dramaName: " Love ", totalEpisode: "30" } } }), {
    name: "Love",
    total: 30,
  });
  const episodes = [1, 2, 4, 4].map((number, index) =>
    makeEpisode({ number, itemId: `i${number}-${index}`, title: "t", seriesId: "s", lockHints: number === 4 ? ["x"] : [] }),
  );
  // a list that still holds two items with one number: the duplicate is found by the merge's
  // rules (alike in every rule: the first listed stays) and named with both items
  assert.deepEqual(catalogWarnings(episodes, 6), [
    "episode 3 missing (gap)",
    "duplicate episode number 4: item i4-3 left out (listed later), item i4-2 kept",
    "TikTok announces 6 episodes, 3 listed",
    "2 episodes look locked",
  ]);
  assert.equal(makeEpisode({ number: 1, itemId: "1", title: "t", seriesId: "s" }).access, "free");
  assert.throws(() => makeEpisode({ number: 1, itemId: "1", title: "t", seriesId: "s", drm: true, access: "free" }));
  assert.throws(() => makeEpisode({ number: 1, itemId: "1", title: "t", seriesId: "s", access: "maybe" }));
});

// ------------------------------------------------------------------- the whole list (3.0.1)
// The owner's report of 2026-11-27: some dramas lost one or two free episodes without a word.
// TikTok's own count (dramaInfo.numVideos), an episode number that falls through to the next key,
// duplicates found BEFORE the number merge (the episode over a highlight, free or unlocked over
// locked, the longer over the shorter, the first listed) and every item that is no episode, kept
// with its reason and said. tests/test_catalog.py holds the same cases; the parity tests prove the
// two front ends agree on seeded corpora.

const FIFTH_SERIES_ID = "7699393770256782377";
const OTHER_SERIES_ID = "7600000000000000000";
const E2_ID = "7699400000000000602";
const HIGHLIGHT_OF_E2 = "7699400000000000692";
const TRAILER_ID = "7699400000000000690";
const FOREIGN_ID = "7699400000000000778";
const HIGHLIGHT_WARNING = `duplicate episode number 2: item ${HIGHLIGHT_OF_E2} left out (a highlight), item ${E2_ID} kept`;

/** @param {readonly import("../src/lib/catalog.js").Episode[]} episodes */
const numbered = (episodes) => episodes.map((episode) => [episode.number, episode.itemId.slice(-3)]);

test("the fifth series reads like the real captures: the highlight never takes episode 2, TikTok's count is numVideos", () => {
  const first = parseItemListPayload(fixture("item_list_series5_page1.json"), FIFTH_SERIES_ID);
  const second = parseItemListPayload(fixture("item_list_series5_page2.json"), FIFTH_SERIES_ID);
  // page 1: E1, the highlight of E2 (numbered 2, listed first), E2, E3 (EpisodeNumber 0: its number
  // is dramaInfo's episodeNumber), the trailer (EpisodeNumber 0 and nothing else)
  assert.deepEqual(numbered(first.episodes), [[1, "601"], [2, "692"], [2, "602"], [3, "603"]]);
  assert.deepEqual([first.cursor, first.hasMore, first.seenItems, first.skippedItems], [5, true, 5, 1]);
  assert.deepEqual(first.skipped, [{ reason: SKIP_NO_NUMBER, itemId: TRAILER_ID }]);
  assert.equal(first.totalHint, 7);
  // page 2: another drama's item first — its numVideos (12) is no count of this drama
  assert.deepEqual(numbered(second.episodes), [[4, "604"], [5, "605"]]);
  assert.deepEqual(second.skipped, [{ reason: SKIP_OTHER_DRAMA, itemId: FOREIGN_ID }]);
  assert.equal(second.totalHint, 7);

  const listing = mergePages([first, second]);
  assert.deepEqual(numbered(listing.episodes), [[1, "601"], [2, "602"], [3, "603"], [4, "604"], [5, "605"]]);
  assert.equal(listing.episodes[1]?.durationS, 98);
  assert.equal(listing.duplicates.length, 1);
  const [duplicate] = listing.duplicates;
  assert.deepEqual([duplicate?.number, duplicate?.kept.itemId, duplicate?.leftOut.itemId, duplicate?.why], [2, E2_ID, HIGHLIGHT_OF_E2, LEFT_OUT_HIGHLIGHT]);
  assert.deepEqual(listing.skipped, [
    { reason: SKIP_NO_NUMBER, itemId: TRAILER_ID },
    { reason: SKIP_OTHER_DRAMA, itemId: FOREIGN_ID },
  ]);
  // five episodes, the highlight and the trailer: TikTok's 7 all came. 3.0.1, the lead's decision
  // D2 (changed on purpose): whether TikTok counts the highlight and the trailer is not known, so
  // no number past 5 is named missing — and the list is UNCERTAIN (TikTok counts 7, the drama
  // certainly has 5): said, never complete
  assert.deepEqual([listing.itemsReceived, listing.totalHint], [7, 7]);
  const numbers = listing.episodes.map((episode) => episode.number);
  assert.deepEqual(countCheck(numbers, 7, listing.itemsReceived), { certainTop: 5, otherItems: 2, uncertain: true });
  assert.deepEqual(missingNumbers(numbers, 7, listing.itemsReceived, 10_000), []);
  const options = { duplicates: listing.duplicates, skipped: listing.skipped, itemsReceived: listing.itemsReceived };
  assert.deepEqual(catalogWarnings(listing.episodes, listing.totalHint, options), [
    HIGHLIGHT_WARNING,
    "TikTok listed 1 item DramaFetch could not read (another drama's id)",
    "TikTok listed 1 item DramaFetch could not read (no episode number)",
    "TikTok announces 7 episodes, 5 listed",
    uncertainText(7, 5, 2),
  ]);

  // the list ended after page 1: three episodes and two other items — 4 and 5 certainly missing
  // (7 - 2), 6 and 7 never named (3.0.1, D2: no phantom episode), the list uncertain past 5
  const early = mergePages([first]);
  assert.deepEqual([early.itemsReceived, early.totalHint], [5, 7]);
  assert.deepEqual(countCheck([1, 2, 3], 7, early.itemsReceived), { certainTop: 5, otherItems: 2, uncertain: true });
  assert.deepEqual(missingNumbers([1, 2, 3], 7, early.itemsReceived, 10_000), [4, 5]);
  assert.deepEqual(
    catalogWarnings(early.episodes, early.totalHint, { duplicates: early.duplicates, skipped: early.skipped, itemsReceived: early.itemsReceived }),
    [
      HIGHLIGHT_WARNING,
      "TikTok listed 1 item DramaFetch could not read (no episode number)",
      "TikTok announces 7 episodes, 3 listed",
      uncertainText(7, 3, 2),
    ],
  );
  // the highlight listed AFTER its episode changes nothing
  const page = /** @type {{itemList: unknown[]}} */ (fixture("item_list_series5_page1.json"));
  [page.itemList[1], page.itemList[2]] = [page.itemList[2], page.itemList[1]];
  const reordered = mergePages([parseItemListPayload(page, FIFTH_SERIES_ID)]);
  assert.equal(reordered.episodes[1]?.itemId, E2_ID);
  assert.deepEqual(reordered.duplicates.map((found) => found.leftOut.itemId), [HIGHLIGHT_OF_E2]);
});

test("numVideos is TikTok's count: the detail's first total key, else the items' — never another drama's", () => {
  assert.deepEqual(parseDetailPayload({ dramaInfo: { dramaName: "D", numVideos: 62 } }), { name: "D", total: 62 });
  assert.deepEqual(parseDetailPayload({ dramaInfo: { numVideos: 62, totalEpisode: 60 } }), { name: null, total: 62 });
  assert.deepEqual(parseDetailPayload({ dramaInfo: { numVideos: 0, totalEpisode: 60 } }), { name: null, total: 60 });
  const related = {
    data: {
      recommended: { dramaInfo: { dramaID: "1", dramaName: "Other", numVideos: 12 } },
      dramaInfo: { dramaID: FIFTH_SERIES_ID, dramaName: "Mine", numVideos: 7 },
    },
  };
  assert.deepEqual(parseDetailPayload(related), { name: "Other", total: 12 });
  assert.deepEqual(parseDetailPayload(related, FIFTH_SERIES_ID), { name: "Mine", total: 7 });
  assert.deepEqual(parseDetailPayload({ dramaInfo: { dramaName: "No id", numVideos: 5 } }, FIFTH_SERIES_ID), { name: "No id", total: 5 });
  // the items' count: a positive int of an item of the series, wrapped or not
  for (const [drama, expected] of /** @type {[Record<string, unknown>, number | null][]} */ ([
    [{ numVideos: 62 }, 62],
    [{ numVideos: "62" }, 62],
    [{ numVideos: " 62 " }, 62],
    [{ numVideos: 0 }, null],
    [{ numVideos: -3 }, null],
    [{ numVideos: 2.5 }, null],
    [{ numVideos: true }, null],
    [{ numVideos: "x" }, null],
    [{ numVideos: null }, null],
    [{ numVideos: [62] }, null],
    [{ numVideos: Number.MAX_SAFE_INTEGER + 1 }, null],
    [{}, null],
    [{ dramaID: OTHER_SERIES_ID, numVideos: 12 }, null],
    [{ dramaID: FIFTH_SERIES_ID, numVideos: 7 }, 7],
    [{ DramaVideoData: { numVideos: 7 } }, null],
  ])) {
    assert.equal(itemTotalHint({ id: "1", dramaInfo: drama }, FIFTH_SERIES_ID), expected, JSON.stringify(drama));
    assert.equal(itemTotalHint({ itemStruct: { id: "1", dramaInfo: drama } }, FIFTH_SERIES_ID), expected);
  }
  for (const junk of [null, "x", 5, [], { dramaInfo: "x" }]) assert.equal(itemTotalHint(junk, "s"), null);
  const items = [
    { id: "a", dramaInfo: { dramaID: "other", numVideos: 40 } },
    { id: "b", dramaInfo: { numVideos: 0, DramaVideoData: { EpisodeNumber: 1 } } },
    { id: "c", dramaInfo: { dramaID: "s", DramaVideoData: {}, numVideos: "9" } },
    { id: "d", dramaInfo: { numVideos: 11, DramaVideoData: { EpisodeNumber: 2 } } },
  ];
  assert.equal(parseItemListPayload({ itemList: items }, "s").totalHint, 9);
  assert.equal(parseItemListPayload({ itemList: items.slice(0, 2) }, "s").totalHint, null);
});

test("an unusable EpisodeNumber falls through to DramaVideoData's other keys, then dramaInfo's", () => {
  for (const junk of [0, null, "", " ", "x", -1, 2.5, true, {}, [3], "²"]) {
    const label = JSON.stringify(junk);
    const first = episodeFromItem({ id: "1", dramaInfo: { DramaVideoData: { EpisodeNumber: junk, episodeNumber: 6 } } }, "s");
    assert.equal(first?.number, 6, label);
    const item = { id: "1", dramaInfo: { DramaVideoData: { EpisodeNumber: junk, episode_number: junk }, episodeNumber: 17 } };
    assert.equal(episodeFromItem(item, "s")?.number, 17, label);
    assert.equal(skipReason(item, "s"), null);
    item.dramaInfo.episodeNumber = /** @type {number} */ (/** @type {unknown} */ (junk));
    assert.equal(episodeFromItem(item, "s"), null, label);
    assert.equal(skipReason(item, "s"), SKIP_NO_NUMBER, label);
  }
  // the first usable one wins, in key order
  assert.equal(episodeFromItem({ id: "1", dramaInfo: { DramaVideoData: { EpisodeNumber: 4, episodeNumber: 9 }, EpisodeNumber: 12 } }, "s")?.number, 4);
  assert.equal(episodeFromItem({ id: "1", dramaInfo: { DramaVideoData: "not a dict", EpisodeNumber: 12 } }, "s")?.number, 12);
});

test("skipReason says why an item is no episode: another drama's id, then no id, then no episode number", () => {
  assert.deepEqual(SKIP_REASONS, [SKIP_OTHER_DRAMA, SKIP_NO_ID, SKIP_NO_NUMBER]);
  assert.deepEqual(SKIP_REASONS, ["another drama's id", "no id", "no episode number"]);
  const episode = { id: "1", dramaInfo: { dramaID: SERIES_ID, DramaVideoData: { EpisodeNumber: 7 } } };
  assert.equal(skipReason(episode, SERIES_ID), null);
  assert.equal(skipReason({ dramaInfo: { dramaID: OTHER_SERIES_ID, DramaVideoData: { EpisodeNumber: 7 } } }, SERIES_ID), SKIP_OTHER_DRAMA);
  assert.equal(skipReason({ id: " ", dramaInfo: {} }, SERIES_ID), SKIP_NO_ID);
  assert.equal(skipReason({ id: "9", dramaInfo: { DramaVideoData: {} } }, SERIES_ID), SKIP_NO_NUMBER);
  assert.equal(skipReason({ itemStruct: { id: "9" } }, SERIES_ID), SKIP_NO_NUMBER);
  for (const junk of [null, "x", 5, []]) assert.equal(skipReason(junk, SERIES_ID), SKIP_NO_ID);
  const page = parseItemListPayload(
    { itemList: [{ id: "", dramaInfo: {} }, episode, { id: "1t", dramaInfo: {} }, { dramaInfo: { dramaID: OTHER_SERIES_ID } }] },
    SERIES_ID,
  );
  assert.deepEqual(page.episodes.map((found) => found.number), [7]);
  assert.deepEqual(page.skipped, [
    { reason: SKIP_NO_ID, itemId: null },
    { reason: SKIP_NO_NUMBER, itemId: "1t" },
    { reason: SKIP_OTHER_DRAMA, itemId: null },
  ]);
  assert.deepEqual([page.seenItems, page.skippedItems], [4, 3]);
});

test("isHighlight reads IsHighlight and LinkedEpisodeID, in DramaVideoData or dramaInfo", () => {
  for (const [marks, expected] of /** @type {[Record<string, unknown>, boolean][]} */ ([
    [{ IsHighlight: false, LinkedEpisodeID: "0" }, false], // every captured episode
    [{}, false],
    [{ IsHighlight: true }, true],
    [{ IsHighlight: 1 }, true],
    [{ IsHighlight: "true" }, true],
    [{ IsHighlight: "false" }, false],
    [{ IsHighlight: "0" }, false],
    [{ IsHighlight: 0 }, false],
    [{ IsHighlight: null }, false],
    [{ IsHighlight: { x: 1 } }, false], // a container never counts
    [{ IsHighlight: [1] }, false],
    [{ LinkedEpisodeID: E2_ID }, true],
    [{ LinkedEpisodeID: 7699400 }, true],
    [{ LinkedEpisodeID: " 0 " }, false],
    [{ LinkedEpisodeID: 0 }, false],
    [{ LinkedEpisodeID: "" }, false],
    [{ LinkedEpisodeID: null }, false],
    [{ LinkedEpisodeID: true }, false],
    [{ LinkedEpisodeID: 1.5 }, false],
    [{ IsHighlight: false, LinkedEpisodeID: "12" }, true],
  ])) {
    const label = JSON.stringify(marks);
    const nested = { id: "1", dramaInfo: { DramaVideoData: { EpisodeNumber: 2, ...marks } } };
    assert.equal(isHighlight(nested), expected, label);
    assert.equal(isHighlight({ itemStruct: nested }), expected, label);
    assert.equal(isHighlight({ id: "1", dramaInfo: { DramaVideoData: { EpisodeNumber: 2 }, ...marks } }), expected, label);
  }
  for (const junk of [null, "x", 5, [], {}, { dramaInfo: "x" }, { dramaInfo: { DramaVideoData: 3 } }]) assert.equal(isHighlight(junk), false);
});

/**
 * One item of number `number` as the merge sees it.
 * @param {string} itemId
 * @param {{highlight?: boolean, access?: "free" | "unlocked" | "locked", duration?: number | null, number?: number}} [options]
 */
function candidate(itemId, options = {}) {
  const number = options.number ?? 2;
  /** @type {Record<string, unknown>} */
  const videoData = { EpisodeNumber: number };
  if (options.highlight) videoData["IsHighlight"] = true;
  return makeEpisode({
    number,
    itemId,
    title: itemId,
    seriesId: "s",
    durationS: options.duration ?? null,
    access: options.access ?? "free",
    paid: options.access === "unlocked",
    raw: { id: itemId, dramaInfo: { DramaVideoData: videoData } },
  });
}

/**
 * @param {...import("../src/lib/catalog.js").Episode} candidates
 * @returns {[string | undefined, [string, string][]]}
 */
function keptAndLeftOut(...candidates) {
  const listing = mergePages([{ episodes: candidates, cursor: null, hasMore: false, seenItems: candidates.length, skippedItems: 0, skipped: [], totalHint: null }]);
  return [listing.episodes[0]?.itemId, listing.duplicates.map((found) => [found.leftOut.itemId, found.why])];
}

test("the merge keeps one episode per number: no highlight, then free or unlocked, then the longer, then the first listed", () => {
  assert.deepEqual(LEFT_OUT_REASONS, [LEFT_OUT_HIGHLIGHT, LEFT_OUT_LOCKED, LEFT_OUT_SHORTER, LEFT_OUT_LATER]);
  const clip = candidate("clip", { highlight: true, duration: 99 });
  const episode = candidate("ep", { duration: 40 });
  assert.deepEqual(keptAndLeftOut(clip, episode), ["ep", [["clip", LEFT_OUT_HIGHLIGHT]]]);
  assert.deepEqual(keptAndLeftOut(episode, clip), ["ep", [["clip", LEFT_OUT_HIGHLIGHT]]]);
  const locked = candidate("locked-ep", { access: "locked", duration: 99 });
  assert.deepEqual(keptAndLeftOut(locked, clip), ["locked-ep", [["clip", LEFT_OUT_HIGHLIGHT]]]);
  assert.deepEqual(keptAndLeftOut(locked, candidate("free", { duration: 10 })), ["free", [["locked-ep", LEFT_OUT_LOCKED]]]);
  assert.deepEqual(keptAndLeftOut(locked, candidate("unlocked", { access: "unlocked", duration: 10 })), ["unlocked", [["locked-ep", LEFT_OUT_LOCKED]]]);
  const short = candidate("short", { duration: 41 });
  const long = candidate("long", { duration: 98 });
  assert.deepEqual(keptAndLeftOut(short, long), ["long", [["short", LEFT_OUT_SHORTER]]]);
  assert.deepEqual(keptAndLeftOut(candidate("unknown"), short), ["short", [["unknown", LEFT_OUT_SHORTER]]]);
  assert.deepEqual(keptAndLeftOut(candidate("unknown"), candidate("zero", { duration: 0 })), ["zero", [["unknown", LEFT_OUT_SHORTER]]]);
  assert.deepEqual(keptAndLeftOut(candidate("a", { duration: 90 }), candidate("b", { duration: 90 })), ["a", [["b", LEFT_OUT_LATER]]]);
  assert.deepEqual(keptAndLeftOut(candidate("b", { duration: 90 }), candidate("a", { duration: 90 })), ["b", [["a", LEFT_OUT_LATER]]]);
  assert.deepEqual(keptAndLeftOut(clip, short, locked, long), [
    "long",
    [
      ["clip", LEFT_OUT_HIGHLIGHT],
      ["short", LEFT_OUT_SHORTER],
      ["locked-ep", LEFT_OUT_LOCKED],
    ],
  ]);
  // the same item served twice is one item, never a duplicate; mergeEpisodes is the same merge
  const again = mergePages([
    { episodes: [short], cursor: null, hasMore: false, seenItems: 1, skippedItems: 0, skipped: [], totalHint: null },
    { episodes: [{ ...short, title: "again" }], cursor: null, hasMore: false, seenItems: 1, skippedItems: 0, skipped: [], totalHint: null },
  ]);
  assert.deepEqual([again.episodes.map((found) => found.title), again.duplicates], [["short"], []]);
  assert.deepEqual(mergeEpisodes([[clip, short], [long]]), [long]);
  // a hand-built episode without its payload is no highlight
  assert.equal(keptAndLeftOut({ ...clip, raw: null }, episode)[0], "clip");
});

test("mergePages counts the items received of the series and keeps every skipped reason, once per id", () => {
  const one = candidate("e1", { number: 1 });
  const two = candidate("e2", { number: 2 });
  const listing = mergePages([
    {
      episodes: [one],
      cursor: 3,
      hasMore: true,
      seenItems: 4,
      skippedItems: 3,
      skipped: [
        { reason: SKIP_NO_NUMBER, itemId: "trailer" },
        { reason: SKIP_NO_ID, itemId: null },
        { reason: SKIP_OTHER_DRAMA, itemId: "foreign" },
      ],
      totalHint: 0,
    },
    {
      episodes: [two],
      cursor: null,
      hasMore: false,
      seenItems: 5,
      skippedItems: 4,
      skipped: [
        { reason: SKIP_NO_NUMBER, itemId: "trailer" }, // the same trailer again: once
        { reason: SKIP_NO_NUMBER, itemId: "e1" }, // read as an episode on page 1: no skip
        { reason: SKIP_NO_ID, itemId: null }, // no id: each one counts
        { reason: SKIP_OTHER_DRAMA, itemId: "foreign-2" },
      ],
      totalHint: 9,
    },
    { episodes: [], cursor: null, hasMore: false, seenItems: 0, skippedItems: 0, skipped: [], totalHint: 4 },
  ]);
  assert.deepEqual(listing.skipped, [
    { reason: SKIP_NO_NUMBER, itemId: "trailer" },
    { reason: SKIP_NO_ID, itemId: null },
    { reason: SKIP_OTHER_DRAMA, itemId: "foreign" },
    { reason: SKIP_NO_ID, itemId: null },
    { reason: SKIP_OTHER_DRAMA, itemId: "foreign-2" },
  ]);
  assert.equal(listing.itemsReceived, 5); // two episodes, the trailer, two without an id
  assert.equal(listing.totalHint, 9);
  assert.deepEqual(mergePages([]), { episodes: [], duplicates: [], skipped: [], itemsReceived: 0, totalHint: null, highlightNumbers: [] });
});

test("a highlight never stands for an episode (3.0.1, D3): with no episode of its number it is a skipped item and its number missing", () => {
  const first = parseItemListPayload(fixture("item_list_series5_page1.json"), FIFTH_SERIES_ID);
  const second = parseItemListPayload(fixture("item_list_series5_page2.json"), FIFTH_SERIES_ID);
  const lone = { ...first, episodes: first.episodes.filter((episode) => episode.itemId !== E2_ID) }; // the clip, not E02
  const listing = mergePages([lone, second]);
  assert.deepEqual(numbered(listing.episodes), [[1, "601"], [3, "603"], [4, "604"], [5, "605"]]);
  assert.deepEqual(listing.duplicates, []);
  assert.deepEqual(listing.skipped, [
    { reason: SKIP_NO_NUMBER, itemId: TRAILER_ID },
    { reason: SKIP_OTHER_DRAMA, itemId: FOREIGN_ID },
    { reason: SKIP_HIGHLIGHT, itemId: HIGHLIGHT_OF_E2 },
  ]);
  assert.equal(listing.itemsReceived, 6); // E01, E03-E05, the highlight and the trailer
  const numbers = listing.episodes.map((episode) => episode.number);
  assert.deepEqual(countCheck(numbers, 7, listing.itemsReceived), { certainTop: 5, otherItems: 2, uncertain: true });
  assert.deepEqual(missingNumbers(numbers, 7, listing.itemsReceived, 10_000), [2]);
  assert.equal(fillTarget(numbers, 7, listing.itemsReceived, { earlyEnd: false, limit: 10_000 }), 2);
  assert.deepEqual(catalogWarnings(listing.episodes, 7, { duplicates: listing.duplicates, skipped: listing.skipped, itemsReceived: listing.itemsReceived }), [
    "episode 2 missing (gap)",
    "TikTok listed 1 item DramaFetch could not read (another drama's id)",
    "TikTok listed 1 item DramaFetch could not read (no episode number)",
    "TikTok listed 1 item DramaFetch could not read (a highlight, a clip of an episode)",
    "TikTok announces 7 episodes, 4 listed",
    uncertainText(7, 4, 2),
  ]);
  // two highlights of one number and no episode: both skipped, no duplicate between them
  const clipA = candidate("clip-a", { highlight: true, duration: 40 });
  const clipB = candidate("clip-b", { highlight: true, duration: 50 });
  const one = candidate("e1", { number: 1 });
  const both = mergePages([{ episodes: [one, clipA, clipB], cursor: null, hasMore: false, seenItems: 3, skippedItems: 0, skipped: [], totalHint: null }]);
  assert.deepEqual(both.episodes.map((episode) => episode.itemId), ["e1"]);
  assert.deepEqual(both.duplicates, []);
  assert.deepEqual(both.skipped, [
    { reason: SKIP_HIGHLIGHT, itemId: "clip-a" },
    { reason: SKIP_HIGHLIGHT, itemId: "clip-b" },
  ]);
  assert.equal(both.itemsReceived, 3);
  assert.deepEqual(mergeEpisodes([[one, clipA]]), [one]);
  // the paired case is unchanged: the episode kept, the highlight the duplicate left out
  const paired = mergePages([first, second]);
  assert.deepEqual(paired.duplicates.map((found) => found.leftOut.itemId), [HIGHLIGHT_OF_E2]);
  assert.ok(paired.skipped.every((found) => found.reason !== SKIP_HIGHLIGHT));
  assert.ok(!SKIP_REASONS.includes(SKIP_HIGHLIGHT)); // the merge's reason, not skipReason's
  assert.deepEqual([listing.highlightNumbers, paired.highlightNumbers], [[2], []]);
  assert.deepEqual(both.highlightNumbers, [2]); // two clips of one number: one number
});

test("a lone highlight past the last episode listed makes its number missing (3.0.1, D3 at the top of the list): the filling asks for it and the warnings name it, whether TikTok's count is unknown or counts the episodes only", () => {
  const episodes = Array.from({ length: 65 }, (_, index) => candidate(`e${index + 1}`, { number: index + 1 }));
  const clip = candidate("clip-66", { highlight: true, number: 66 });
  const listing = mergePages([{ episodes: [...episodes, clip], cursor: null, hasMore: false, seenItems: 66, skippedItems: 0, skipped: [], totalHint: null }]);
  assert.equal(listing.episodes.length, 65);
  assert.deepEqual(listing.skipped, [{ reason: SKIP_HIGHLIGHT, itemId: "clip-66" }]);
  assert.deepEqual([listing.itemsReceived, listing.highlightNumbers], [66, [66]]);
  const numbers = listing.episodes.map((episode) => episode.number);
  for (const total of [null, 66]) {
    assert.deepEqual(countCheck(numbers, total, 66, [66]), { certainTop: 66, otherItems: 1, uncertain: false });
    assert.deepEqual(missingNumbers(numbers, total, 66, 10_000, [66]), [66]);
    assert.equal(fillTarget(numbers, total, 66, { earlyEnd: false, limit: 10_000, highlights: [66] }), 66);
    assert.equal(fillTarget(numbers, total, 66, { earlyEnd: false, covered: [[66, null]], limit: 10_000, highlights: [66] }), null);
  }
  assert.deepEqual(catalogWarnings(listing.episodes, null, { skipped: listing.skipped, itemsReceived: 66, highlights: listing.highlightNumbers }), [
    "episode 66 missing (gap)",
    "TikTok listed 1 item DramaFetch could not read (a highlight, a clip of an episode)",
  ]);
  // a count of 67 may hold the highlight, or one more episode: 66 missing, the rest uncertain
  assert.deepEqual(countCheck(numbers, 67, 66, [66]), { certainTop: 66, otherItems: 1, uncertain: true });
  assert.deepEqual(missingNumbers(numbers, 67, 66, 10_000, [66]), [66]);
  // once the filling covered 66 (its answer brought the clip again, hasMore true), the uncertain
  // list asks once for the page after the clip's number — never the clip's own page again
  assert.equal(fillTarget(numbers, 67, 66, { earlyEnd: false, covered: [[66, 66]], limit: 10_000, highlights: [66] }), 67);
  assert.equal(fillTarget(numbers, 67, 66, { earlyEnd: false, covered: [[66, null]], limit: 10_000 }), null);
  // without the highlight's number, the old reading: nothing missing past the last episode
  assert.deepEqual(missingNumbers(numbers, null, 66, 10_000), []);
  // a lone highlight below the highest number listed was a hole already: unchanged
  const middle = episodes.filter((episode) => episode.number !== 30);
  const below = mergePages([{ episodes: [...middle, candidate("clip-30", { highlight: true, number: 30 })], cursor: null, hasMore: false, seenItems: 65, skippedItems: 0, skipped: [], totalHint: null }]);
  assert.deepEqual(below.highlightNumbers, [30]);
  const belowNumbers = below.episodes.map((episode) => episode.number);
  assert.deepEqual(missingNumbers(belowNumbers, null, 65, 10_000, [30]), [30]);
  assert.deepEqual(missingNumbers(belowNumbers, null, 65, 10_000), [30]);
});

test("a lone highlight numbered past TikTok's count raises no row (3.0.1): no missing number, no gap warning, no filling request; with no count its number is the drama's", () => {
  const episodes = Array.from({ length: 65 }, (_, index) => candidate(`e${index + 1}`, { number: index + 1 }));
  const clip = candidate("clip-500", { highlight: true, number: 500 });
  const listing = mergePages([{ episodes: [...episodes, clip], cursor: null, hasMore: false, seenItems: 66, skippedItems: 0, skipped: [], totalHint: null }]);
  assert.deepEqual([listing.itemsReceived, listing.highlightNumbers], [66, [500]]);
  const numbers = listing.episodes.map((episode) => episode.number);
  // every episode TikTok counts is listed: nothing missing, nothing asked, not uncertain
  assert.deepEqual(countCheck(numbers, 65, 66, [500]), { certainTop: 65, otherItems: 1, uncertain: false });
  assert.deepEqual(missingNumbers(numbers, 65, 66, 10_000, [500]), []);
  assert.equal(fillTarget(numbers, 65, 66, { earlyEnd: false, limit: 10_000, highlights: [500] }), null);
  assert.deepEqual(catalogWarnings(listing.episodes, 65, { skipped: listing.skipped, itemsReceived: 66, highlights: [500] }), [
    "TikTok listed 1 item DramaFetch could not read (a highlight, a clip of an episode)",
  ]);
  // a count of 66 may hold the clip, or one more episode: uncertain, the page after E65 asked
  assert.deepEqual(countCheck(numbers, 66, 66, [500]), { certainTop: 65, otherItems: 1, uncertain: true });
  assert.deepEqual(missingNumbers(numbers, 66, 66, 10_000, [500]), []);
  assert.equal(fillTarget(numbers, 66, 66, { earlyEnd: false, limit: 10_000, highlights: [500] }), 66);
  assert.deepEqual(catalogWarnings(listing.episodes, 66, { skipped: listing.skipped, itemsReceived: 66, highlights: [500] }), [
    "TikTok listed 1 item DramaFetch could not read (a highlight, a clip of an episode)",
    "TikTok announces 66 episodes, 65 listed",
    uncertainText(66, 65, 1),
  ]);
  // a clip within the count is placed as before; with no count, the clip's number is the drama's
  assert.deepEqual(missingNumbers(numbers, 67, 66, 10_000, [66, 500]), [66]);
  assert.deepEqual(missingNumbers(numbers, null, 66, 10_000, [500]), Array.from({ length: 435 }, (_, index) => 66 + index));
  // a count the list itself goes past (60 with E1-E65 listed: a stale count) holds nothing back:
  // the clip of E66 makes E66 missing, as with no count — asked for, named, never hidden
  assert.deepEqual(countCheck(numbers, 60, 66, [66]), { certainTop: 66, otherItems: 1, uncertain: false });
  assert.deepEqual(missingNumbers(numbers, 60, 66, 10_000, [66]), [66]);
  assert.equal(fillTarget(numbers, 60, 66, { earlyEnd: false, limit: 10_000, highlights: [66] }), 66);
  assert.equal(catalogWarnings(listing.episodes, 60, { skipped: listing.skipped, itemsReceived: 66, highlights: [66] })[0], "episode 66 missing (gap)");
});

test("an item without an id counts once per listing (3.0.1, D4): the same item served again is one item", () => {
  const idless = { dramaInfo: { dramaID: SERIES_ID, DramaVideoData: { EpisodeNumber: 14 } } };
  const other = { dramaInfo: { dramaID: SERIES_ID, DramaVideoData: { EpisodeNumber: 15 } } };
  const episode = { id: "1", dramaInfo: { dramaID: SERIES_ID, DramaVideoData: { EpisodeNumber: 7 } }, video: PLAYABLE };
  const first = parseItemListPayload({ itemList: [episode, idless], hasMore: true }, SERIES_ID);
  // the same item again, its keys in another order
  const again = { dramaInfo: { DramaVideoData: { EpisodeNumber: 14 }, dramaID: SERIES_ID } };
  const refill = parseItemListPayload({ itemList: [again], hasMore: false }, SERIES_ID);
  assert.deepEqual(first.skippedKeys, [itemKey(idless)]);
  assert.deepEqual(refill.skippedKeys, [itemKey(idless)]);
  const listing = mergePages([first, refill]);
  assert.deepEqual(listing.skipped, [{ reason: SKIP_NO_ID, itemId: null }]);
  assert.equal(listing.itemsReceived, 2); // the episode and the one id-less item
  assert.deepEqual(catalogWarnings(listing.episodes, null, { skipped: listing.skipped }), [
    "episodes 1-6 missing (gap)",
    "TikTok listed 1 item DramaFetch could not read (no id)",
  ]);
  const distinct = parseItemListPayload({ itemList: [other], hasMore: false }, SERIES_ID);
  assert.equal(mergePages([first, distinct]).itemsReceived, 3);
  // an item with an id gets no key; a page built by hand has none: each id-less item counts
  assert.deepEqual(parseItemListPayload({ itemList: [episode, episode] }, SERIES_ID).skippedKeys, []);
  const hand = { episodes: [], cursor: null, hasMore: false, seenItems: 1, skippedItems: 1, skipped: [{ reason: SKIP_NO_ID, itemId: null }], totalHint: null };
  assert.equal(mergePages([hand, hand]).itemsReceived, 2);
});

test("itemKey is canonical (sorted keys, whole floats as ints) and never throws", () => {
  assert.equal(itemKey({ b: 1, a: [2, { d: null, c: "é" }] }), itemKey({ a: [2, { c: "é", d: null }], b: 1 }));
  assert.notEqual(itemKey({ a: 1 }), itemKey({ a: "1" }));
  assert.notEqual(itemKey({ a: true }), itemKey({ a: 1 }));
  assert.notEqual(itemKey({ a: 2.5 }), itemKey({ a: 2 }));
  assert.equal(itemKey({ a: Number.NaN }), itemKey({ a: null }));
  assert.equal(itemKey({ a: -0 }), itemKey({ a: 0 }));
  /** @type {Record<string, unknown>} */
  const deep = {};
  let node = deep;
  for (let index = 0; index < 200; index += 1) {
    /** @type {Record<string, unknown>} */
    const inner = {};
    node["x"] = inner;
    node = inner;
  }
  assert.equal(typeof itemKey(deep), "string");
  for (const junk of [null, undefined, "x", 5, [], 2 ** 80]) assert.equal(typeof itemKey(junk), "string");
});

test("an answer with no item of the series ends nothing when more was expected (3.0.1, D5)", () => {
  const empty = parseItemListPayload({ itemList: [], hasMore: false }, SERIES_ID);
  const foreign = { id: "9", dramaInfo: { dramaID: "7600000000000000000", DramaVideoData: { EpisodeNumber: 1 } } };
  const onlyOther = parseItemListPayload({ itemList: [foreign], hasMore: false }, SERIES_ID);
  const episode = { id: "1", dramaInfo: { dramaID: SERIES_ID, DramaVideoData: { EpisodeNumber: 7 } } };
  const last = parseItemListPayload({ itemList: [episode], hasMore: false }, SERIES_ID);
  for (const page of [empty, onlyOther]) {
    assert.equal(pageEndsList(page, []), true);
    assert.equal(pageEndsList(page, [], true, true), false);
  }
  assert.equal(pageEndsList(last, [], true, true), true); // a last page with items still ends it
  assert.equal(pageEndsList(last, ["1"], true, true), false); // a repeat never does
  assert.equal(pageEndsList(last, [], false), false);
});

test("countCheck is the one count rule (3.0.1, D2): certainTop = max(H, C - S), uncertain when C is above it", () => {
  const range = (/** @type {number} */ high) => Array.from({ length: high }, (_, index) => index + 1);
  for (const [numbers, total, received, expected] of /** @type {[number[], number | null, number | null, [number, number, boolean]][]} */ ([
    [[], null, null, [0, 0, false]],
    [[1, 2, 3], null, 5, [3, 2, false]], // no count: the highest listed
    [[1, 2, 3], 0, null, [3, 0, false]],
    [[1, 2, 3], -1, 0, [3, 0, false]],
    [[1, 2, 3], 7, null, [7, 0, false]], // unknown items: the count stands
    [[1, 2, 3], 7, 3, [7, 0, false]], // no other item: 4-7 certainly missing
    [[1, 2, 3], 7, 5, [5, 2, true]], // 4-5 certain, 6-7 uncertain
    [[1, 2, 3], 7, 7, [3, 4, true]],
    [[1, 2, 3], 3, 5, [3, 2, false]], // the count placed
    [[1, 2, 3], 2, 5, [3, 2, false]], // more listed than announced
    [[1, 2, 5], 5, 4, [5, 1, false]],
    // the review's cases: 66 + a trailer, E66 lost; 6 + a trailer counted 7, E04 lost; no other item
    [range(65), 66, 66, [65, 1, true]],
    [[1, 2, 3, 5, 6], 7, 6, [6, 1, true]],
    [range(65), 66, 65, [66, 0, false]],
  ])) {
    const [certainTop, otherItems, uncertain] = expected;
    assert.deepEqual(countCheck(numbers, total, received), { certainTop, otherItems, uncertain }, `${numbers.length} ${total} ${received}`);
  }
});

test("the review's cases (3.0.1, L2 and V2): no phantom episode, the page after the highest asked for once when uncertain", () => {
  const sixtyFive = Array.from({ length: 65 }, (_, index) => index + 1);
  const ask = (/** @type {number[]} */ numbers, /** @type {number} */ total, /** @type {number} */ received, /** @type {[number, number | null][]} */ covered = []) =>
    fillTarget(numbers, total, received, { earlyEnd: false, covered, limit: 10_000 });
  // (a) 66 episodes and a trailer, TikTok counts 66, E66 never listed: nothing certain, one ask
  assert.deepEqual(missingNumbers(sixtyFive, 66, 66, 10_000), []);
  assert.equal(ask(sixtyFive, 66, 66), 66);
  assert.equal(ask(sixtyFive, 66, 66, [[66, null]]), null);
  assert.equal(ask(sixtyFive, 66, 66, [[66, 95]]), null);
  // (b) 6 episodes and a trailer, TikTok counts 7, E04 never listed: [4] only, also uncertain
  const six = [1, 2, 3, 5, 6];
  assert.deepEqual(missingNumbers(six, 7, 6, 10_000), [4]);
  assert.equal(ask(six, 7, 6), 4);
  assert.equal(ask(six, 7, 6, [[4, null]]), null); // an answer that ends the list covers 7 too
  assert.equal(ask(six, 7, 6, [[4, 6]]), 7);
  // (c) no other item, TikTok counts 66, E66 never listed: [66], as before
  assert.deepEqual(missingNumbers(sixtyFive, 66, 65, 10_000), [66]);
  assert.equal(ask(sixtyFive, 66, 65), 66);
  // a count everything listed accounts for asks nothing past the highest
  assert.equal(fillTarget([1, 2, 3], 3, 5, { earlyEnd: true, limit: 10_000 }), null);
  // the main fake series' shape (TikTok counts 5, five episodes, a trailer) is no question...
  assert.deepEqual(countCheck([1, 2, 3, 4, 5], 5, 6), { certainTop: 5, otherItems: 1, uncertain: false });
  assert.equal(ask([1, 2, 3, 4, 5], 5, 6), null);
  // ... and with E05 lost: uncertain, the page after 4 asked for once
  assert.deepEqual(countCheck([1, 2, 3, 4], 5, 5), { certainTop: 4, otherItems: 1, uncertain: true });
  assert.equal(ask([1, 2, 3, 4], 5, 5), 5);
});

test("missingNumbers: the holes, and the numbers up to the count less the drama's other items", () => {
  assert.deepEqual(missingNumbers([1, 2, 3, 5, 7], null, null, 100), [4, 6]);
  assert.deepEqual(missingNumbers([1, 2, 3], 5, 3, 100), [4, 5]);
  assert.deepEqual(missingNumbers([1, 2, 3], 5, 5, 100), []);
  assert.deepEqual(missingNumbers([1, 2, 3], 5, null, 100), [4, 5]);
  assert.deepEqual(missingNumbers([2, 4], 6, 2, 100), [1, 3, 5, 6]);
  assert.deepEqual(missingNumbers([], 3, 0, 100), [1, 2, 3]);
  assert.deepEqual(missingNumbers([], null, null, 100), []);
  assert.deepEqual(missingNumbers([1, 9], 2 ** 40, 2, 12), [2, 3, 4, 5, 6, 7, 8, 10, 11, 12]);
  // 3.0.1, D2: never past TikTok's count less the drama's other items received
  assert.deepEqual(missingNumbers([1, 2, 3], 7, 5, 100), [4, 5]);
  assert.deepEqual(missingNumbers([1, 2, 3, 5, 6], 7, 6, 100), [4]);
});

test("catalogWarnings names the duplicates, the skipped items by reason and holds the items received against the count", () => {
  const [e1, e2, e3] = [1, 2, 3].map((number) => candidate(`e${number}`, { number, duration: 90 }));
  const clip = candidate("clip", { number: 2, highlight: true });
  const e2Kept = /** @type {import("../src/lib/catalog.js").Episode} */ (e2);
  const duplicate = { number: 2, kept: e2Kept, leftOut: clip, why: LEFT_OUT_HIGHLIGHT };
  const listed = /** @type {import("../src/lib/catalog.js").Episode[]} */ ([e1, e2, e3]);
  const skipped = [
    { reason: SKIP_NO_NUMBER, itemId: "t1" },
    { reason: "an odd reason", itemId: "x" },
    { reason: SKIP_NO_NUMBER, itemId: "t2" },
    { reason: SKIP_NO_ID, itemId: null },
    { reason: SKIP_OTHER_DRAMA, itemId: "f" },
  ];
  // 3.0.1, the lead's decision D2 (changed on purpose): seven items for TikTok's six no longer
  // silence the count — four of them are other items, so the list is uncertain and says so
  assert.deepEqual(catalogWarnings(listed, 6, { duplicates: [duplicate], skipped, itemsReceived: 7 }), [
    "duplicate episode number 2: item clip left out (a highlight), item e2 kept",
    "TikTok listed 1 item DramaFetch could not read (another drama's id)",
    "TikTok listed 1 item DramaFetch could not read (no id)",
    "TikTok listed 2 items DramaFetch could not read (no episode number)",
    "TikTok listed 1 item DramaFetch could not read (an odd reason)",
    "TikTok announces 6 episodes, 3 listed",
    uncertainText(6, 3, 4),
  ]);
  assert.equal(
    uncertainText(6, 3, 4),
    "TikTok's list may be incomplete: TikTok counts 6 episodes; 3 episodes and 4 other items (trailers or highlights) " +
      "were listed, so DramaFetch cannot tell whether an episode is missing — paste the drama again later to check again",
  );
  assert.ok(uncertainText(66, 65, 1).startsWith(`${UNCERTAIN_TEXT}: TikTok counts 66 episodes; 65 episodes and 1 other item (a trailer or a highlight) were listed`));
  // 4 certainly missing (6 - 2); 5-6 may be the 2 other items: uncertain (changed on purpose, D2)
  assert.deepEqual(catalogWarnings(listed, 6, { itemsReceived: 5 }), ["TikTok announces 6 episodes, 3 listed", uncertainText(6, 3, 2)]);
  assert.deepEqual(catalogWarnings(listed, 6, { itemsReceived: 6 }), ["TikTok announces 6 episodes, 3 listed", uncertainText(6, 3, 3)]);
  assert.deepEqual(catalogWarnings(listed, 6, { itemsReceived: 3 }), ["TikTok announces 6 episodes, 3 listed"]);
  assert.deepEqual(catalogWarnings(listed, 2, { itemsReceived: 3 }), ["TikTok announces 2 episodes, 3 listed"]);
  assert.deepEqual(catalogWarnings(listed, 3, { itemsReceived: 3 }), []);
  assert.deepEqual(catalogWarnings(listed, 6), ["TikTok announces 6 episodes, 3 listed"]);
  assert.deepEqual(catalogWarnings(listed, 3), []);
  assert.deepEqual(catalogWarnings([clip, e1, e2Kept].map((found) => /** @type {import("../src/lib/catalog.js").Episode} */ (found)), null), [
    "duplicate episode number 2: item clip left out (a highlight), item e2 kept",
  ]);
});

test("3.0.1, the guessed lock: locked ONLY by DramaFetch's own guesses (a short header, no play address) — never with DRM, a price, an entitlement or a lock flag of TikTok's", () => {
  const short = { duration: 69, original: true };
  /** @param {Record<string, unknown> | null} drama @param {Record<string, unknown> | null} [video] @param {unknown} [music] */
  const decide = (drama, video = { duration: 106, ...PLAYABLE }, music = undefined) =>
    accessOf(music === undefined ? item(drama, video) : { ...item(drama, video), music });
  // guessed: the decision is `locked` as ever, the flag says DramaFetch guessed it
  assert.deepEqual(decide(null, undefined, short), { access: "locked", paid: false, drm: false, hints: ["plays 69 s of 106 s"], guessedLock: true });
  assert.equal(decide(null, {}).guessedLock, true); // no play address alone
  assert.equal(accessOf({ id: "1" }).guessedLock, true); // no video at all
  assert.equal(decide(null, { duration: 106 }, short).guessedLock, true); // both structural rules
  assert.equal(decide({ isLimitedFree: true }, undefined, short).guessedLock, true); // the owner's shape
  assert.equal(decide({ payStatus: 1 }, {}).guessedLock, true); // an ambiguous hint decides nothing
  // not guessed: a whole episode, a price, an entitlement, TikTok's own lock flags, DRM
  assert.equal(decide(null, undefined, { duration: 106, original: true }).guessedLock, false);
  assert.equal(decide({ unlockPrice: 30 }, {}).guessedLock, false);
  assert.equal(decide({ unlockPrice: 30 }, undefined, short).guessedLock, false);
  assert.equal(decide({ isFree: false }, undefined, short).guessedLock, false);
  assert.equal(decide({ isVip: true }, undefined, short).guessedLock, false);
  assert.equal(decide({ isUnlocked: true }, {}).access, "unlocked");
  assert.equal(decide({ isUnlocked: false }, {}).guessedLock, false); // NOT-ENTITLED
  assert.equal(decide({ isLocked: true }).guessedLock, false);
  assert.equal(decide({ needPay: 1 }, {}).guessedLock, false);
  assert.equal(decide({ lockStatus: "locked" }).guessedLock, false);
  assert.deepEqual(decide({ isDrm: true }), { access: "locked", paid: false, drm: true, hints: ["isDrm=True"], guessedLock: false });
  assert.equal(decide({ drmType: "widevine" }, undefined, short).guessedLock, false);
  // every guessed lock is a locked episode with no DRM, price or entitlement clue (a seeded fuzz)
  const rng = seededRng(20261127);
  const keys = ["isLocked", "needPay", "unlockPrice", "isFree", "isUnlocked", "isDrm", "payStatus", "isLimitedFree", "lockStatus"];
  const values = [true, false, 0, 1, 30, "locked", "unlocked", "x"];
  for (let round = 0; round < 500; round += 1) {
    /** @type {Record<string, unknown>} */
    const drama = {};
    for (const key of keys) if (rng.uniform(0, 1) < 0.25) drama[key] = values[Math.floor(rng.uniform(0, values.length))];
    const video = rng.uniform(0, 1) < 0.4 ? {} : { duration: 106, ...PLAYABLE };
    const decision = decide(drama, video, rng.uniform(0, 1) < 0.5 ? short : undefined);
    if (decision.guessedLock) assert.deepEqual([decision.access, decision.paid, decision.drm], ["locked", false, false], JSON.stringify(drama));
  }
});

test("3.0.1, the guessed lock rides on the episode: the owner's series 4 guesses E03 locked (its own sound 2 s of 3 s), E01 and E02 free; an Episode refuses a guessed lock that is not locked, or is DRM or sold", () => {
  const page = parseItemListPayload(fixture("item_list_series4_limited_free.json"), "7699393770256782366");
  assert.deepEqual(
    page.episodes.map((episode) => [episode.number, episode.access, episode.guessedLock, episode.lockHints]),
    [
      [1, "free", false, []],
      [2, "free", false, []],
      [3, "locked", true, ["plays 2 s of 3 s"]],
    ],
  );
  const base = { number: 1, itemId: "1", title: "t", seriesId: "s" };
  assert.equal(makeEpisode({ ...base, access: "locked", guessedLock: true }).guessedLock, true);
  assert.equal(makeEpisode(base).guessedLock, false);
  for (const wrong of [{ access: "free" }, { access: "unlocked", paid: true }, { access: "locked", drm: true }, { access: "locked", paid: true }]) {
    assert.throws(() => makeEpisode({ ...base, guessedLock: true, ...wrong }), /guessed lock/, JSON.stringify(wrong));
  }
});
