// @ts-check
// Unit tests of src/lib/dailymotion.js over the metadata fixtures and the junk cases.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  COVER_PREFERENCE,
  DAILYMOTION_BASE_URL,
  GEO_BLOCKED_CODE,
  HLS_TYPE,
  LUMBERJACK_TYPE,
  VIDEO_ID_RE,
  chooseCover,
  findHlsMaster,
  isVideoId,
  metadataUrl,
  pageUrl,
  parseMetadata,
} from "../src/lib/dailymotion.js";

/** @param {string} name @returns {unknown} */
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

/**
 * The refusal of a metadata result, or a failed assertion.
 * @param {import("../src/lib/dailymotion.js").DailymotionMetadataResult} result
 */
function refusalOf(result) {
  if (result.ok) assert.fail(`not refused: ${result.info.title}`);
  return result;
}

/** A `qualities` dict holding one HLS master. @param {string} url */
const hlsAt = (url) => ({ auto: [{ type: HLS_TYPE, url }] });

const POSTERS = "https://posters.example-dm.test/v/Abc12";
const MASTER =
  "https://www.example-dm.test/cdn/manifest/video/x8abcd1.m3u8" +
  "?sec=AbCdEf0123456789&dmTs=1234567&dmV1st=0123456789abcdef";

test("a playable video: the facts, the 720 px poster and the HLS master under qualities.auto", () => {
  assert.deepEqual(parseMetadata(fixture("dailymotion-metadata-ok.json")), {
    ok: true,
    info: {
      id: "x8abcd1",
      title: "Example video – a fixture title with “quotes” and a / slash",
      durationS: 187,
      uploader: "Example Channel",
      uploaderId: "x1owner",
      cover: `${POSTERS}/x720-poster.jpg`,
      explicit: false,
      createdTime: 1711496732,
      masterUrl: MASTER,
    },
  });
});

test("DM007 is geo-blocking; any other error makes the video unavailable with the site's title", () => {
  assert.deepEqual(parseMetadata(fixture("dailymotion-metadata-geo.json")), {
    ok: false,
    code: "geo_blocked",
    params: { site_message: "Video geo-restricted by the owner.", site_code: "DM007" },
  });
  assert.equal(GEO_BLOCKED_CODE, "DM007");
  assert.deepEqual(parseMetadata(fixture("dailymotion-metadata-error.json")), {
    ok: false,
    code: "not_a_video",
    params: { site_message: "The owner has removed this video.", site_code: "DM999" },
  });
  // the title first, then raw_message, then message, then the bare code; a string error as is
  const rawMessage = parseMetadata({ error: { code: "DM004", raw_message: "Private video" } });
  assert.deepEqual(refusalOf(rawMessage).params, {
    site_message: "Private video",
    site_code: "DM004",
  });
  const message = parseMetadata({ error: { code: "DM005", message: "Spam" } });
  assert.deepEqual(refusalOf(message).params, { site_message: "Spam", site_code: "DM005" });
  const codeOnly = parseMetadata({ error: { code: "DM006" } });
  assert.deepEqual(refusalOf(codeOnly).params, { site_message: "DM006", site_code: "DM006" });
  assert.deepEqual(parseMetadata({ error: "Something went wrong" }), {
    ok: false,
    code: "not_a_video",
    params: { site_message: "Something went wrong", site_code: "" },
  });
  // an error object without a code is still a refusal, never a video
  const codeless = { error: { title: "Nope" }, qualities: hlsAt("https://a.test/m") };
  assert.equal(parseMetadata(codeless).ok, false);
  // an empty or null error is no error
  const nullError = { error: null, title: "t", qualities: hlsAt("https://a.test/m") };
  assert.equal(parseMetadata(nullError).ok, true);
  const emptyError = { error: "", title: "t", qualities: hlsAt("https://a.test/m") };
  assert.equal(parseMetadata(emptyError).ok, true);
});

test("no HLS master means no streams; lumberjack entries are ignored; another quality may hold the master", () => {
  assert.deepEqual(parseMetadata(fixture("dailymotion-metadata-nostreams.json")), {
    ok: false,
    code: "no_streams",
    params: { types: "video/mp4" },
  });
  assert.deepEqual(findHlsMaster({ auto: [{ type: LUMBERJACK_TYPE, url: "https://a.test/l" }] }), {
    masterUrl: null,
    types: [],
  });
  assert.deepEqual(
    findHlsMaster({
      "720": [{ type: "video/mp4", url: "https://a.test/720.mp4" }],
      auto: [
        { type: HLS_TYPE, url: "" },
        { type: HLS_TYPE },
        "junk",
        null,
        { type: HLS_TYPE, url: "https://a.test/second.m3u8" },
      ],
    }),
    { masterUrl: "https://a.test/second.m3u8", types: ["application/x-mpegURL", "video/mp4"] },
  );
  // "auto" is looked at first even when another key sorts before it
  const both = {
    "1080": [{ type: HLS_TYPE, url: "https://a.test/1080.m3u8" }],
    auto: [{ type: HLS_TYPE, url: "https://a.test/auto.m3u8" }],
  };
  assert.equal(findHlsMaster(both).masterUrl, "https://a.test/auto.m3u8");
  const elsewhere = { "1080": [{ type: HLS_TYPE, url: "https://a.test/1080.m3u8" }] };
  assert.equal(findHlsMaster(elsewhere).masterUrl, "https://a.test/1080.m3u8");
  assert.deepEqual(findHlsMaster({ auto: "not a list", other: 5 }), { masterUrl: null, types: [] });
  assert.deepEqual(findHlsMaster(null), { masterUrl: null, types: [] });
  assert.deepEqual(findHlsMaster([]), { masterUrl: null, types: [] });
});

test("junk never throws: not an object, an empty object, odd field types", () => {
  for (const junk of [null, undefined, "text", 42, true, [], [{ title: "x" }]]) {
    const result = parseMetadata(junk);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "not_a_video");
  }
  assert.deepEqual(parseMetadata({}), { ok: false, code: "no_streams", params: { types: "" } });
  const odd = parseMetadata(
    {
      id: 123,
      title: ["not", "a", "string"],
      duration: "187",
      created_time: -5,
      explicit: 1,
      owner: "not an object",
      screenname: "fallback-owner",
      qualities: hlsAt("https://a.test/m.m3u8"),
    },
    "x8given",
  );
  assert.deepEqual(odd, {
    ok: true,
    info: {
      id: "x8given",
      title: "",
      durationS: 187,
      uploader: null,
      uploaderId: "fallback-owner",
      cover: null,
      explicit: true,
      createdTime: null,
      masterUrl: "https://a.test/m.m3u8",
    },
  });
  const minimal = parseMetadata({ qualities: hlsAt("https://a.test/m.m3u8"), duration: 0 });
  assert.equal(minimal.ok && minimal.info.id, null);
  assert.equal(minimal.ok && minimal.info.durationS, null);
  assert.equal(minimal.ok && minimal.info.explicit, false);
});

test("the cover: the largest poster at most 720 px high, posters before thumbnails, else the smallest", () => {
  assert.equal(COVER_PREFERENCE.maxHeight, 720);
  assert.deepEqual([...COVER_PREFERENCE.sources], ["posters", "thumbnails"]);
  const metadata = /** @type {Record<string, unknown>} */ (fixture("dailymotion-metadata-ok.json"));
  assert.equal(chooseCover(metadata), `${POSTERS}/x720-poster.jpg`);
  assert.equal(chooseCover({ ...metadata, posters: {} }), `${POSTERS}/x720-thumb.jpg`);
  assert.equal(chooseCover({ ...metadata, posters: undefined }), `${POSTERS}/x720-thumb.jpg`);
  const two = { posters: { "240": "https://p.test/240.jpg", "480": "https://p.test/480.jpg" } };
  assert.equal(chooseCover(two), "https://p.test/480.jpg");
  // every poster taller than 720: the smallest
  const tall = {
    posters: { "1080": "https://p.test/1080.jpg", "2160": "https://p.test/2160.jpg" },
  };
  assert.equal(chooseCover(tall), "https://p.test/1080.jpg");
  // keys that are not heights count only when nothing else exists; non-http values are ignored
  const named = { posters: { default: "https://p.test/d.jpg", "360": "https://p.test/360.jpg" } };
  assert.equal(chooseCover(named), "https://p.test/360.jpg");
  const onlyNamed = { posters: { default: "https://p.test/d.jpg" } };
  assert.equal(chooseCover(onlyNamed), "https://p.test/d.jpg");
  assert.equal(chooseCover({ posters: { "360": "data:image/png;base64,AAAA", "480": 42 } }), null);
  assert.equal(chooseCover({ posters: "https://p.test/not-a-dict.jpg" }), null);
  assert.equal(chooseCover({}), null);
  assert.equal(chooseCover(null), null);
  assert.equal(chooseCover("junk"), null);
});

test("URLs and ids", () => {
  assert.equal(DAILYMOTION_BASE_URL, "https://www.dailymotion.com");
  assert.equal(
    metadataUrl(DAILYMOTION_BASE_URL, "x8vu47w"),
    "https://www.dailymotion.com/player/metadata/video/x8vu47w?app=com.dailymotion.neon",
  );
  assert.equal(
    metadataUrl("http://127.0.0.1:8123/dm//", "k2Y4Mjp7krAF9iCuINM"),
    "http://127.0.0.1:8123/dm/player/metadata/video/k2Y4Mjp7krAF9iCuINM?app=com.dailymotion.neon",
  );
  assert.equal(
    metadataUrl(DAILYMOTION_BASE_URL, "a/b"),
    "https://www.dailymotion.com/player/metadata/video/a%2Fb?app=com.dailymotion.neon",
  );
  assert.equal(pageUrl("x8vu47w"), "https://www.dailymotion.com/video/x8vu47w");
  assert.equal(
    pageUrl("x8vu47w", "http://127.0.0.1:8123/dm/"),
    "http://127.0.0.1:8123/dm/video/x8vu47w",
  );
  const valid = ["x8vu47w", "x5kesuj", "k2Y4Mjp7krAF9iCuINM", "k46oCapRs4iikoz9DWy", "x1"];
  for (const id of valid) assert.equal(isVideoId(id), true, id);
  const invalid = ["X8VU47W", "x", "k", "", "8vu47w", "x8vu-47w", "x8vu47w_slug", 42, null];
  for (const id of invalid) assert.equal(isVideoId(id), false, String(id));
  assert.equal(VIDEO_ID_RE.test("x8vu47w"), true);
});
