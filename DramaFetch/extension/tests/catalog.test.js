// @ts-check
// Unit tests of src/lib/catalog.js (the Python parity is proven by tests/test_extension_parity.py).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  NO_PLAY_ADDRESS,
  SHORT_HEADER_HINT_PREFIX,
  VIDEO_ONLY_PATH_SUFFIX,
  accessOf,
  catalogWarnings,
  chooseRendition,
  codecName,
  coverUrlOf,
  episodeFromItem,
  findItemLists,
  isDrmKey,
  isLocked,
  isVideoOnlyUrl,
  keyWords,
  listedSizes,
  makeEpisode,
  mergeEpisodes,
  parseDetailPayload,
  parseItemListPayload,
  playUrlCandidates,
  renditions,
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
    assert.deepEqual(accessOf(item({ [key]: 1 })), { access: "free", paid: false, drm: false, hints: [] }, key);
  }
  // a DRM negation is no price flag either: `isDrmFree: false` is not `isFree=false`
  for (const key of ["isDrmFree", "drm_free", "encryptionFree"]) {
    assert.deepEqual(accessOf(item({ [key]: false, unlockPrice: 30 })).hints, ["unlockPrice=30"], key);
    assert.deepEqual(accessOf(item({ [key]: true, unlockPrice: 30 })), { access: "unlocked", paid: true, drm: false, hints: ["unlockPrice=30"] }, key);
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
  });
  assert.deepEqual(accessOf(item({ isFree: false }, { playAddr: "null" })), {
    access: "locked",
    paid: true,
    drm: false,
    hints: ["isFree=false", NO_PLAY_ADDRESS],
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
  assert.deepEqual(accessOf(null), { access: "locked", paid: false, drm: false, hints: [NO_PLAY_ADDRESS] });
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
  assert.deepEqual(full, { access: "free", paid: false, drm: false, hints: [] });
  // E02: IsPreview true, PreviewType 4, the sound as long as the video: free as well
  assert.equal(accessOf(limitedFreeItem(2, { videoDuration: 106, musicDuration: 106, original: true, previewType: 4 })).access, "free");
  // E03: the episode's own sound lasts 2 s of a 3 s video: the short header locks it, that hint alone
  const windowed = accessOf(limitedFreeItem(3, { videoDuration: 3, musicDuration: 2, original: true, isPreview: false, previewType: 1 }));
  assert.deepEqual(windowed, { access: "locked", paid: false, drm: false, hints: [`${SHORT_HEADER_HINT_PREFIX}2 s of 3 s`] });
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
  assert.deepEqual(accessOf(item({ IsFreeIntro: false })), { access: "free", paid: false, drm: false, hints: [] });
  assert.deepEqual(accessOf(item({ IsFreeIntro: true, is_free_intro: 1 })).hints, []);
  assert.deepEqual(accessOf(item({ isPreview: true })), { access: "free", paid: false, drm: false, hints: [] });
  assert.deepEqual(accessOf(item({ IsPreview: true, PreviewType: 4, isTrial: true, preview_type: 1 })).hints, []);
  // a FREE clue beats pricing: a sold series the payload calls free is free (and still `paid`);
  // next to the price the free flag IS a hint — it says why
  assert.deepEqual(accessOf(item({ isLimitedFree: true, unlockPrice: 30 })), {
    access: "free",
    paid: true,
    drm: false,
    hints: ["isLimitedFree=True", "unlockPrice=30"],
  });
  assert.deepEqual(accessOf(item({ isFree: false, isLimitedFree: true })).hints, ["isFree=false", "isLimitedFree=True"]);
  assert.deepEqual(accessOf(item({ limitedFree: 1 })), { access: "free", paid: false, drm: false, hints: [] });
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
  assert.deepEqual(windowed(sound(69)), { access: "locked", paid: false, drm: false, hints: ["plays 69 s of 106 s"] });
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
  const episodes = [1, 2, 4, 4].map((number) =>
    makeEpisode({ number, itemId: `i${number}${Math.random()}`, title: "t", seriesId: "s", lockHints: number === 4 ? ["x"] : [] }),
  );
  assert.deepEqual(catalogWarnings(episodes, 6), [
    "episode 3 missing (gap)",
    "duplicate episode number 4",
    "TikTok announces 6 episodes, 3 listed",
    "2 episodes look locked",
  ]);
  assert.equal(makeEpisode({ number: 1, itemId: "1", title: "t", seriesId: "s" }).access, "free");
  assert.throws(() => makeEpisode({ number: 1, itemId: "1", title: "t", seriesId: "s", drm: true, access: "free" }));
  assert.throws(() => makeEpisode({ number: 1, itemId: "1", title: "t", seriesId: "s", access: "maybe" }));
});
