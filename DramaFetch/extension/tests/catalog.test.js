// @ts-check
// Unit tests of src/lib/catalog.js (the Python parity is proven by tests/test_extension_parity.py).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  NO_PLAY_ADDRESS,
  accessOf,
  catalogWarnings,
  chooseRendition,
  codecName,
  coverUrlOf,
  episodeFromItem,
  findItemLists,
  isDrmKey,
  isLocked,
  keyWords,
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

test("re.IGNORECASE is Python's: a dotless i, a long s and the Kelvin sign match ASCII letters", () => {
  assert.equal(accessOf(item({ "\u0131sLocked": true })).access, "locked");
  assert.equal(accessOf(item({ "isLoc\u212aed": true })).access, "locked");
  assert.equal(accessOf(item({ "co\u017ft": 5 })).access, "unlocked");
  assert.equal(accessOf(item({ lockStatus: "ye\u017f" })).access, "locked");
});

test("accessOf and episodeFromItem never throw on seeded junk", () => {
  const rng = seededRng(7);
  const keys = ["isLocked", "isUnlocked", "price", "drm", "lockStatus", "video", "dramaInfo", "itemStruct", "bitrateInfo", "playAddr", "id", ""];
  const scalars = [null, true, false, 0, 1, -1, 1.5, "", "0", "true", "locked", "https://x/?expire=1", "²"];
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
