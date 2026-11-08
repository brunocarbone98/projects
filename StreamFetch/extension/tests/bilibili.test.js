// @ts-check
// Unit tests of src/lib/bilibili.js: the page fixtures, the embedded-JSON scanner, the junk cases
// and the quality/codec selection matrix.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  AUDIO_LABELS,
  BILIBILI_BASE_URL,
  QUALITY_HEIGHTS,
  QUALITY_LABELS,
  TRIAL_MARKER,
  canonicalId,
  chooseAudio,
  chooseStreams,
  extractEmbeddedJson,
  frameRateOf,
  nominalHeight,
  pageUrl,
  parsePage,
  parsePlayInfo,
} from "../src/lib/bilibili.js";

/** @typedef {import("../src/lib/bilibili.js").DashRep} DashRep */
/** @typedef {import("../src/lib/bilibili.js").PlayInfo} PlayInfo */
/** @typedef {import("../src/lib/bilibili.js").BilibiliPageResult} BilibiliPageResult */
/** @typedef {Record<string, unknown>} Dict */

/** @param {string} name */
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const OK_HTML = fixture("bilibili-page-ok.html");
const PREMIUM_HTML = fixture("bilibili-page-premium.html");
const CDN = "https://upos-sz-mirror.example-cdn.test/upgcxcode/90/78/1234567890";
const DESCRIPTION = 'An invented description with a "quoted" word and braces {like these}.';
const COVER =
  "https://cover.example-bili.test/bfs/archive/0123456789abcdef0123456789abcdef01234567.jpg";
/** @type {{ maxHeight: null, codec: "best" }} */
const BEST = { maxHeight: null, codec: "best" };
/** @type {{ maxHeight: null, codec: "compatible" }} */
const COMPATIBLE = { maxHeight: null, codec: "compatible" };

/**
 * The ok branch of a page result, or a failed assertion.
 * @param {BilibiliPageResult} result
 */
function okOf(result) {
  if (!result.ok) assert.fail(`refused: ${result.code} ${JSON.stringify(result.params)}`);
  return result;
}

/**
 * The refusal of a page result, or a failed assertion.
 * @param {BilibiliPageResult} result
 */
function refusalOf(result) {
  if (result.ok) assert.fail(`not refused: ${result.info.id}`);
  return result;
}

/**
 * A copy of the ok fixture's `__INITIAL_STATE__`, its `videoData` copied too, ready to be edited.
 * @returns {{ state: Dict, videoData: Dict }}
 */
function okState() {
  const copy = structuredClone(extractEmbeddedJson(OK_HTML, "__INITIAL_STATE__"));
  const state = /** @type {Dict} */ (copy);
  const videoData = /** @type {Dict} */ (state["videoData"]);
  state["videoData"] = videoData;
  return { state, videoData };
}

/** The ok fixture's `__playinfo__`, copied. @returns {Dict} */
function okPlayinfo() {
  return /** @type {Dict} */ (structuredClone(extractEmbeddedJson(OK_HTML, "__playinfo__")));
}

/**
 * A page embedding `state` and, when given, `playinfo`, the way the site writes them.
 * @param {unknown} state
 * @param {unknown} [playinfo]
 * @returns {string}
 */
function pageWith(state, playinfo) {
  const remover =
    "(function(){var s;(s=document.currentScript||document.scripts[document.scripts.length-1])" +
    ".parentNode.removeChild(s);}());";
  const play =
    playinfo === undefined
      ? ""
      : `<script>window.__playinfo__=${JSON.stringify(playinfo)}</script>`;
  return (
    '<!DOCTYPE html><html><head><title>t</title></head><body><div id="app"></div>' +
    `<script>window.__INITIAL_STATE__=${JSON.stringify(state)};${remover}</script>${play}` +
    "</body></html>"
  );
}

test("the embedded JSON scanner: the fixture, decoys before the assignment, both objects", () => {
  const state = /** @type {Dict} */ (extractEmbeddedJson(OK_HTML, "__INITIAL_STATE__"));
  assert.equal(state["bvid"], "BV1Ab4C1dE2f");
  assert.equal(/** @type {Dict} */ (state["videoData"])["desc"], DESCRIPTION);
  const play = /** @type {Dict} */ (extractEmbeddedJson(OK_HTML, "__playinfo__"));
  assert.equal(play["code"], 0);
  assert.equal(extractEmbeddedJson(OK_HTML, "_riskdata_"), null);
  assert.equal(extractEmbeddedJson(OK_HTML, "__NOTHING__"), null);
});

test("the scanner handles strings, escapes, nesting, spacing, and refuses what is not an object", () => {
  const tricky =
    '{"a":"}{","b":"it\'s \\"quoted\\" }","c":{"d":[1,{"e":"{"}],"f":"\\\\"},"g":"\\u007d"}';
  assert.deepEqual(extractEmbeddedJson(`<script>window.__X__ = ${tricky};</script>`, "__X__"), {
    a: "}{",
    b: 'it\'s "quoted" }',
    c: { d: [1, { e: "{" }], f: "\\" },
    g: "}",
  });
  assert.deepEqual(extractEmbeddedJson("window.__X__={}", "__X__"), {});
  assert.deepEqual(extractEmbeddedJson('window.__X__\n\t=\r\n{\n"a" : 1\n}', "__X__"), { a: 1 });
  // the first mention is a read, the second a comparison, the third a longer identifier: the
  // fourth assigns
  const decoys =
    "if(window.__X__.a){}\nif(window.__X__==null){}\n" +
    'mywindow.__X__={"no":1};\nwindow.__X__={"yes":1};';
  assert.deepEqual(extractEmbeddedJson(decoys, "__X__"), { yes: 1 });
  // a prefix of a longer name is not the marker
  assert.equal(extractEmbeddedJson('window.__X__extra={"no":1}', "__X__"), null);
  // not an object, unbalanced, invalid JSON, a string that never closes
  assert.equal(extractEmbeddedJson("window.__X__=null;", "__X__"), null);
  assert.equal(extractEmbeddedJson("window.__X__=[1,2];", "__X__"), null);
  assert.equal(extractEmbeddedJson('window.__X__={"a":{"b":1}', "__X__"), null);
  assert.equal(extractEmbeddedJson("window.__X__={a:1};", "__X__"), null);
  assert.equal(extractEmbeddedJson('window.__X__={"a":"never closes};', "__X__"), null);
  // an invalid first assignment does not hide a valid later one
  const twice = 'window.__X__={a:1};window.__X__={"a":2};';
  assert.deepEqual(extractEmbeddedJson(twice, "__X__"), { a: 2 });
  // junk arguments
  const notText = /** @type {string} */ (/** @type {unknown} */ (null));
  assert.equal(extractEmbeddedJson(notText, "__X__"), null);
  assert.equal(extractEmbeddedJson("window.__X__={}", ""), null);
  assert.equal(extractEmbeddedJson("", "__X__"), null);
});

test("the two-part page: the video, both parts, the part shown, the uploader, the cover", () => {
  const { info, play } = okOf(parsePage(OK_HTML));
  const pages = [
    { part: 1, cid: "1234567890", title: "P1 Intro", durationS: 605 },
    { part: 2, cid: "1234567891", title: "P2 Second half", durationS: 480 },
  ];
  assert.deepEqual(info, {
    site: "bilibili",
    id: "BV1Ab4C1dE2f",
    part: 1,
    pageUrl: "https://www.bilibili.com/video/BV1Ab4C1dE2f?p=1",
    title: "Example title: a two-part video / 示例标题",
    uploader: "Example Uploader",
    uploaderId: "12345678",
    durationS: 1085,
    cover: COVER,
    parts: pages,
    aid: 112233445566,
    pages,
    selectedPart: 1,
    isUpowerExclusive: false,
    description: DESCRIPTION,
  });
  assert.ok(play);
  assert.deepEqual(
    play.videos.map((v) => [
      v.id,
      v.codecs,
      v.codecFamily,
      v.bandwidth,
      v.width,
      v.height,
      v.frameRate,
      v.urls.length,
      v.mimeType,
      v.label,
    ]),
    [
      [80, "avc1.640028", "avc", 1546789, 1920, 1080, 25, 3, "video/mp4", "1080P"],
      [80, "hev1.1.6.L150.90", "hevc", 1012345, 1920, 1080, 25, 2, "video/mp4", "1080P"],
      [
        80,
        "av01.0.08M.08.0.110.01.01.01.0",
        "av1",
        912345,
        1920,
        1080,
        25,
        1,
        "video/mp4",
        "1080P",
      ],
      [64, "avc1.64001F", "avc", 876543, 1280, 720, 25, 2, "video/mp4", "720P"],
      [64, "hev1.1.6.L120.90", "hevc", 612345, 1280, 720, 25, 1, "video/mp4", "720P"],
      [32, "avc1.64001E", "avc", 456789, 852, 480, 25, 1, "video/mp4", "480P"],
      [16, "avc1.64001E", "avc", 234567, 640, 360, 25, 1, "video/mp4", "360P"],
    ],
  );
  // baseUrl first, then the backups in order; base_url / backup_url duplicates folded; the query
  // kept as served
  const first = /** @type {DashRep} */ (play.videos[0]);
  assert.equal(first.urls[0]?.startsWith(`${CDN}/1234567890-1-30080.m4s?e=`), true);
  assert.equal(first.urls[1]?.startsWith("https://upos-sz-mirror2.example-cdn.test/"), true);
  assert.equal(first.urls[2]?.startsWith("https://xy1x2x3x4xy.mcdn.example-cdn.test:4483/"), true);
  assert.equal(first.urls[0]?.includes("deadline=1762600000"), true);
  assert.equal(first.size, null);
  assert.deepEqual(
    play.audios.map((a) => [
      a.id,
      a.codecs,
      a.codecFamily,
      a.bandwidth,
      a.width,
      a.frameRate,
      a.label,
    ]),
    [
      [30280, "mp4a.40.2", "unknown", 319000, null, null, "192K"],
      [30232, "mp4a.40.2", "unknown", 132000, null, null, "132K"],
      [30216, "mp4a.40.2", "unknown", 67000, null, null, "64K"],
    ],
  );
  assert.equal(play.audios[0]?.height, null);
  assert.deepEqual(play.dolby, []);
  assert.equal(play.flac, null);
  assert.deepEqual(
    play.supportFormats.map((f) => [f.quality, f.label, f.codecs.length]),
    [
      [116, "1080P 60帧", 2],
      [112, "1080P 高码率", 2],
      [80, "1080P 高清", 3],
      [64, "720P 高清", 2],
      [32, "480P 清晰", 1],
      [16, "360P 流畅", 1],
    ],
  );
  assert.deepEqual(play.acceptQuality, [116, 112, 80, 64, 32, 16]);
  assert.equal(play.acceptDescription.length, 6);
  assert.equal(play.timelengthS, 605.12);
  assert.equal(play.trialOnly, false);
  assert.equal(play.legacy, false);
});

test("the part the page is for: the resolver's ?p= hint, else the state's p, else 1", () => {
  const second = okOf(parsePage(OK_HTML, { part: 2 })).info;
  assert.equal(second.selectedPart, 2);
  assert.equal(second.part, 2);
  assert.equal(second.pageUrl, "https://www.bilibili.com/video/BV1Ab4C1dE2f?p=2");
  // out of range, zero, null, a fraction: the state's p
  assert.equal(okOf(parsePage(OK_HTML, { part: 5 })).info.selectedPart, 1);
  assert.equal(okOf(parsePage(OK_HTML, { part: 0 })).info.selectedPart, 1);
  assert.equal(okOf(parsePage(OK_HTML, { part: null })).info.selectedPart, 1);
  assert.equal(okOf(parsePage(OK_HTML, { part: 1.5 })).info.selectedPart, 1);
  const { state } = okState();
  state["p"] = 2;
  assert.equal(okOf(parsePage(pageWith(state))).info.selectedPart, 2);
  state["p"] = 9;
  assert.equal(okOf(parsePage(pageWith(state))).info.selectedPart, 1);
  delete state["p"];
  assert.equal(okOf(parsePage(pageWith(state))).info.selectedPart, 1);
  assert.equal(okOf(parsePage(pageWith(state), { part: 2 })).info.selectedPart, 2);
});

test("the premium single-part page: no ?p, Dolby and FLAC audio, 4K served, nothing missing", () => {
  const { info, play } = okOf(parsePage(PREMIUM_HTML));
  assert.equal(info.id, "BV1Pr3M1uM9x");
  assert.equal(info.part, null);
  assert.equal(info.parts, null);
  assert.equal(info.pageUrl, "https://www.bilibili.com/video/BV1Pr3M1uM9x");
  assert.equal(info.pages.length, 1);
  assert.equal(info.selectedPart, 1);
  assert.equal(
    info.cover,
    "https://cover.example-bili.test/bfs/archive/fedcba9876543210fedcba9876543210fedcba98.jpg",
  );
  assert.equal(info.uploaderId, "87654321");
  assert.ok(play);
  assert.equal(play.videos.length, 9);
  assert.deepEqual(
    play.dolby.map((a) => [a.id, a.codecs, a.label]),
    [[30250, "ec-3", "Dolby"]],
  );
  assert.deepEqual([play.flac?.id, play.flac?.codecs, play.flac?.label], [30251, "fLaC", "FLAC"]);
  assert.equal(play.videos.find((v) => v.id === 120)?.label, "4K");
  assert.equal(play.videos.find((v) => v.id === 116)?.frameRate, 60);
  const best = chooseStreams(play, BEST);
  assert.deepEqual(
    [best?.video.id, best?.video.codecs, best?.audio?.codecs, best?.missingPremium],
    [120, "avc1.640034", "fLaC", []],
  );
  const compatible = chooseStreams(play, COMPATIBLE);
  assert.deepEqual(
    [compatible?.video.id, compatible?.video.codecs, compatible?.audio?.id],
    [120, "avc1.640034", 30280],
  );
  // the 1080 cap: 116, 112 and 80 are all 1080 nominal; best takes the hev1 116 (3.2M),
  // compatible the avc1 116 (2.9M)
  const best1080 = chooseStreams(play, { maxHeight: 1080, codec: "best" });
  assert.deepEqual(
    [best1080?.video.id, best1080?.video.codecFamily, best1080?.video.bandwidth],
    [116, "hevc", 3200000],
  );
  const compat1080 = chooseStreams(play, { maxHeight: 1080, codec: "compatible" });
  assert.deepEqual(
    [compat1080?.video.id, compat1080?.video.codecFamily, compat1080?.video.bandwidth],
    [116, "avc", 2900000],
  );
  assert.equal(chooseStreams(play, { maxHeight: 720, codec: "best" })?.video.id, 64);
  assert.equal(chooseStreams(play, { maxHeight: 480, codec: "compatible" })?.video.id, 32);
  assert.equal(best?.available.length, 9);
  assert.equal(best?.audioAvailable.length, 3);
});

test("the refusals the fixtures carry", () => {
  assert.deepEqual(refusalOf(parsePage(fixture("bilibili-page-login.html"))), {
    ok: false,
    code: "login_required",
    params: { site_message: "Access to this video requires logging in" },
  });
  assert.deepEqual(refusalOf(parsePage(fixture("bilibili-page-deleted.html"))), {
    ok: false,
    code: "deleted",
    params: { site_message: "啥都木有" },
  });
  assert.deepEqual(refusalOf(parsePage(fixture("bilibili-page-riskdata.html"))), {
    ok: false,
    code: "rate_limited",
    params: { reason: "risk control (v_voucher)" },
  });
  assert.deepEqual(refusalOf(parsePage(fixture("bilibili-page-festival.html"))), {
    ok: false,
    code: "unsupported_link",
    params: { kind: "festival" },
  });
  assert.deepEqual(refusalOf(parsePage(fixture("bilibili-page-upower-nodash.html"))), {
    ok: false,
    code: "supporter_only",
    params: { site_message: "Supporters-only video，Join the monthly plan to watch it" },
  });
  assert.deepEqual(refusalOf(parsePage(fixture("bilibili-page-trial.html"))), {
    ok: false,
    code: "trial_only",
    params: { site_message: "Supporters-only video，Join the monthly plan to watch it all" },
  });
  assert.deepEqual(refusalOf(parsePage(fixture("bilibili-page-durl.html"))), {
    ok: false,
    code: "legacy_stream",
    params: {},
  });
});

test("refusals and tolerances built from the ok page", () => {
  // an interactive video
  let edited = okState();
  edited.videoData["rights"] = { is_stein_gate: 1 };
  assert.equal(refusalOf(parsePage(pageWith(edited.state, okPlayinfo()))).code, "interactive");
  edited.videoData["rights"] = { is_stein_gate: true };
  assert.equal(refusalOf(parsePage(pageWith(edited.state))).code, "interactive");
  // no videoData at all, no festival
  edited = okState();
  delete edited.state["videoData"];
  assert.deepEqual(refusalOf(parsePage(pageWith(edited.state))), {
    ok: false,
    code: "not_a_video",
    params: { reason: "no videoData in the page", site_message: "" },
  });
  edited.state["error"] = { trueCode: -500, message: "odd" };
  assert.equal(refusalOf(parsePage(pageWith(edited.state))).params["site_message"], "odd");
  // an error the page shows next to a full videoData is not a refusal
  edited = okState();
  edited.state["error"] = { trueCode: -500, message: "odd" };
  assert.equal(parsePage(pageWith(edited.state, okPlayinfo())).ok, true);
  // -403 and -404 win over everything else
  edited.state["error"] = { trueCode: "-403" };
  assert.deepEqual(refusalOf(parsePage(pageWith(edited.state, okPlayinfo()))), {
    ok: false,
    code: "login_required",
    params: { site_message: "" },
  });
  edited.state["error"] = { trueCode: -404 };
  assert.equal(refusalOf(parsePage(pageWith(edited.state))).code, "deleted");
  // no bvid: the aid names the video; neither: not a video
  edited = okState();
  delete edited.videoData["bvid"];
  const byAid = okOf(parsePage(pageWith(edited.state, okPlayinfo()))).info;
  assert.equal(byAid.id, "av112233445566");
  assert.equal(byAid.pageUrl, "https://www.bilibili.com/video/av112233445566?p=1");
  delete edited.videoData["aid"];
  assert.equal(refusalOf(parsePage(pageWith(edited.state))).code, "not_a_video");
  // a lower-case bvid is canonicalised
  edited = okState();
  edited.videoData["bvid"] = "bv1Ab4C1dE2f";
  assert.equal(okOf(parsePage(pageWith(edited.state))).info.id, "BV1Ab4C1dE2f");
  // no pages: one part from the top-level cid; no cid either: no parts
  edited = okState();
  delete edited.videoData["pages"];
  let info = okOf(parsePage(pageWith(edited.state))).info;
  assert.deepEqual(info.pages, [{ part: 1, cid: "1234567890", title: "", durationS: 1085 }]);
  assert.equal(info.parts, null);
  assert.equal(info.part, null);
  delete edited.videoData["cid"];
  info = okOf(parsePage(pageWith(edited.state))).info;
  assert.deepEqual(info.pages, []);
  assert.equal(info.selectedPart, 1);
  // pages out of order, a page without cid dropped, a page number missing
  edited = okState();
  edited.videoData["pages"] = [
    { cid: 3, page: 3, part: "c", duration: 3 },
    { cid: 1, page: 1, part: "a", duration: 1 },
    { page: 4, part: "no cid" },
    { cid: 2, part: "b", duration: "x" },
    "junk",
  ];
  info = okOf(parsePage(pageWith(edited.state))).info;
  assert.deepEqual(info.pages, [
    { part: 1, cid: "1", title: "a", durationS: 1 },
    { part: 3, cid: "3", title: "c", durationS: 3 },
    { part: 4, cid: "2", title: "b", durationS: null },
  ]);
  // the uploader falls back to videoData.owner; a non-http or missing cover; odd titles
  edited = okState();
  delete edited.state["upData"];
  edited.videoData["pic"] = "ftp://nope";
  edited.videoData["title"] = 42;
  edited.videoData["desc"] = "";
  info = okOf(parsePage(pageWith(edited.state))).info;
  assert.deepEqual(
    [info.uploader, info.uploaderId, info.cover, info.title, info.description],
    ["Example Uploader", "12345678", null, "", null],
  );
  edited.videoData["owner"] = null;
  info = okOf(parsePage(pageWith(edited.state))).info;
  assert.deepEqual([info.uploader, info.uploaderId], [null, null]);
  // supporter-only: refused when the dash is empty, served when the dash is there and no 试看
  edited = okState();
  edited.videoData["is_upower_exclusive"] = true;
  const playinfo = okPlayinfo();
  const data = /** @type {Dict} */ (playinfo["data"]);
  assert.equal(okOf(parsePage(pageWith(edited.state, playinfo))).info.isUpowerExclusive, true);
  data["dash"] = { video: [], audio: [] };
  assert.equal(refusalOf(parsePage(pageWith(edited.state, playinfo))).code, "supporter_only");
  assert.equal(refusalOf(parsePage(pageWith(edited.state))).params["site_message"], "");
  edited.videoData["is_upower_exclusive"] = 1;
  assert.equal(refusalOf(parsePage(pageWith(edited.state))).code, "supporter_only");
  // a trial clip is refused even when the page does not say supporter-only
  edited = okState();
  const trial = okPlayinfo();
  /** @type {Dict} */ (trial["data"])["accept_description"] = ["清晰 480P 试看"];
  assert.deepEqual(refusalOf(parsePage(pageWith(edited.state, trial))), {
    ok: false,
    code: "trial_only",
    params: { site_message: "" },
  });
  // a __playinfo__ without data, or with another code: no streams, still a video
  edited = okState();
  const broken = parsePage(pageWith(edited.state, { code: -404, message: "no", data: null }));
  assert.equal(okOf(broken).play, null);
  assert.equal(okOf(parsePage(pageWith(edited.state))).play, null);
  assert.equal(chooseStreams(okOf(broken).play, BEST), null);
  // a legacy answer on an ordinary video
  const legacy = okPlayinfo();
  const legacyData = /** @type {Dict} */ (legacy["data"]);
  delete legacyData["dash"];
  legacyData["durl"] = [{ url: "https://upos-sz-mirror.example-cdn.test/a.flv" }];
  assert.equal(refusalOf(parsePage(pageWith(edited.state, legacy))).code, "legacy_stream");
  // neither dash nor durl: a video without streams, left to the chooser (null)
  delete legacyData["durl"];
  const streamless = okOf(parsePage(pageWith(edited.state, legacy)));
  assert.equal(streamless.play?.legacy, false);
  assert.equal(chooseStreams(streamless.play, BEST), null);
});

test("pages that are no video page", () => {
  assert.deepEqual(parsePage("<html><body>nothing here</body></html>"), {
    ok: false,
    code: "not_a_video",
    params: { reason: "no __INITIAL_STATE__ in the page" },
  });
  const otherRisk = '<script>window._riskdata_={"other":"x"}</script>';
  assert.equal(refusalOf(parsePage(otherRisk)).code, "not_a_video");
  const emptyVoucher = '<script>window._riskdata_={"v_voucher":""}</script>';
  assert.equal(refusalOf(parsePage(emptyVoucher)).code, "not_a_video");
  const voucher = '<script>window._riskdata_ = {"v_voucher":"voucher_1"}</script>';
  assert.equal(refusalOf(parsePage(voucher)).code, "rate_limited");
  assert.equal(refusalOf(parsePage("window.__INITIAL_STATE__={}")).code, "not_a_video");
  assert.equal(refusalOf(parsePage("window.__INITIAL_STATE__=[]")).code, "not_a_video");
  assert.deepEqual(parsePage(/** @type {string} */ (/** @type {unknown} */ (undefined))), {
    ok: false,
    code: "not_a_video",
    params: { reason: "the page is not text" },
  });
});

test("parsePlayInfo: the wrapper, both spellings, URL cleaning, labels, legacy, trial, junk", () => {
  const empty = parsePlayInfo(null);
  assert.deepEqual(empty, {
    videos: [],
    audios: [],
    dolby: [],
    flac: null,
    supportFormats: [],
    acceptQuality: [],
    acceptDescription: [],
    timelengthS: null,
    trialOnly: false,
    legacy: false,
  });
  assert.deepEqual(parsePlayInfo("junk"), empty);
  assert.deepEqual(parsePlayInfo([]), empty);
  assert.deepEqual(parsePlayInfo({ data: "junk" }), empty);
  const wrapper = parsePlayInfo(okPlayinfo());
  const inner = parsePlayInfo(okPlayinfo()["data"]);
  assert.deepEqual(wrapper, inner);
  assert.equal(wrapper.videos.length, 7);
  const play = parsePlayInfo({
    timelength: "1500",
    accept_quality: [80, "64", "x", null],
    accept_description: ["高清 1080P", 5, "流畅 360P 试看"],
    support_formats: [
      { quality: 74, new_description: "720P 60帧", codecs: null },
      { quality: 64, display_desc: "720P" },
      { quality: 16 },
      { quality: "x" },
      "junk",
    ],
    dash: {
      video: [
        {
          id: 74,
          base_url: "//upos-sz-mirror.example-cdn.test/a.m4s?e=1",
          backup_url: [
            "https://b.test/a.m4s",
            "//upos-sz-mirror.example-cdn.test/a.m4s?e=1",
            "ftp://no",
            5,
          ],
          codecs: "HEV1.1.6.L120.90",
          bandwidth: "900000.7",
          width: "1280",
          height: 720,
          frame_rate: "16000/672",
          size: 12345,
          mime_type: "video/mp4",
        },
        {
          id: 64,
          url: "https://c.test/only-url.m4s",
          codecs: "avc1.64001F",
          bandwidth: -1,
          width: 0,
          height: 0,
          frameRate: 0,
        },
        { id: 999, baseUrl: "https://c.test/unknown-id.m4s", width: 2160, height: 3840 },
        { baseUrl: "https://c.test/no-id.m4s", codecs: "avc1" },
        { id: 32, codecs: "avc1", backupUrl: [] },
        null,
      ],
      audio: [
        { id: 30280, baseUrl: "https://c.test/a.m4s", codecs: "mp4a.40.2", bandwidth: 319000 },
        { id: 30999, baseUrl: "https://c.test/b.m4s" },
      ],
      dolby: {
        type: 1,
        audio: [{ id: 30250, baseUrl: "https://c.test/d.m4s", codecs: "ec-3", bandwidth: 384000 }],
      },
      flac: { display: false, audio: null },
    },
  });
  assert.deepEqual(
    play.videos.map((v) => [
      v.id,
      v.codecs,
      v.codecFamily,
      v.bandwidth,
      v.width,
      v.height,
      v.frameRate,
      v.urls,
      v.size,
      v.mimeType,
      v.label,
    ]),
    [
      [
        74,
        "HEV1.1.6.L120.90",
        "hevc",
        900000,
        1280,
        720,
        16000 / 672,
        ["https://upos-sz-mirror.example-cdn.test/a.m4s?e=1", "https://b.test/a.m4s"],
        12345,
        "video/mp4",
        "720P 60帧",
      ],
      [
        64,
        "avc1.64001F",
        "avc",
        0,
        null,
        null,
        null,
        ["https://c.test/only-url.m4s"],
        null,
        null,
        "720P",
      ],
      [
        999,
        "",
        "unknown",
        0,
        2160,
        3840,
        null,
        ["https://c.test/unknown-id.m4s"],
        null,
        null,
        null,
      ],
      [0, "avc1", "avc", 0, null, null, null, ["https://c.test/no-id.m4s"], null, null, null],
    ],
  );
  assert.deepEqual(
    play.audios.map((a) => [a.id, a.label, a.codecs]),
    [
      [30280, "192K", "mp4a.40.2"],
      [30999, null, ""],
    ],
  );
  assert.deepEqual(
    play.dolby.map((a) => [a.id, a.label]),
    [[30250, "Dolby"]],
  );
  assert.equal(play.flac, null);
  assert.deepEqual(play.supportFormats, [
    { quality: 74, label: "720P 60帧", codecs: [] },
    { quality: 64, label: "720P", codecs: [] },
    { quality: 16, label: "360P", codecs: [] },
  ]);
  assert.deepEqual(play.acceptQuality, [80, 64]);
  assert.deepEqual(play.acceptDescription, ["高清 1080P", "流畅 360P 试看"]);
  assert.equal(play.trialOnly, true);
  assert.equal(play.timelengthS, 1.5);
  assert.equal(play.legacy, false);
  assert.equal(TRIAL_MARKER, "试看");
  // legacy: durl without dash; no durl entries: not legacy; dash present with durl: not legacy
  const flv = [{ url: "https://c.test/a.flv" }];
  assert.equal(parsePlayInfo({ durl: flv }).legacy, true);
  assert.equal(parsePlayInfo({ durl: [] }).legacy, false);
  assert.equal(parsePlayInfo({ dash: {}, durl: flv }).legacy, false);
  assert.equal(parsePlayInfo({ data: { durl: flv } }).legacy, true);
  assert.equal(parsePlayInfo({ timelength: 0 }).timelengthS, null);
  assert.equal(parsePlayInfo({ timelength: 605120 }).timelengthS, 605.12);
});

/**
 * The codec family of a codec string, the way the matrix builder labels its fixtures.
 * @param {string} codecs
 * @returns {import("../src/lib/hls.js").CodecFamily}
 */
function familyOf(codecs) {
  if (codecs.startsWith("avc")) return "avc";
  if (codecs.startsWith("hev") || codecs.startsWith("hvc")) return "hevc";
  if (codecs.startsWith("av01")) return "av1";
  return "unknown";
}

/**
 * @param {number} id
 * @param {string} codecs
 * @param {number} bandwidth
 * @param {{ width?: number | null, height?: number | null }} [dimensions]
 * @returns {DashRep}
 */
function rep(id, codecs, bandwidth, dimensions = {}) {
  const isAudio =
    codecs.startsWith("mp4a") || codecs === "ec-3" || codecs === "fLaC" || codecs === "";
  const height =
    dimensions.height === undefined ? (QUALITY_HEIGHTS[id] ?? null) : dimensions.height;
  let width = dimensions.width;
  if (width === undefined) width = height === null ? null : Math.round((height * 16) / 9);
  return {
    id,
    codecs,
    codecFamily: isAudio ? "unknown" : familyOf(codecs),
    bandwidth,
    width,
    height,
    frameRate: 25,
    urls: [`https://upos-sz-mirror.example-cdn.test/${id}-${codecs}.m4s?deadline=1`],
    mimeType: isAudio ? "audio/mp4" : "video/mp4",
    size: null,
    label: QUALITY_LABELS[id] ?? AUDIO_LABELS[id] ?? null,
  };
}

const AAC_TRACKS = [
  rep(30216, "mp4a.40.2", 67000),
  rep(30280, "mp4a.40.2", 319000),
  rep(30232, "mp4a.40.2", 132000),
];

/**
 * @typedef {object} PlayExtras
 * @property {DashRep[]} [audios]
 * @property {DashRep[]} [dolby]
 * @property {DashRep | null} [flac]
 * @property {{ quality: number, label: string, codecs: string[] }[]} [supportFormats]
 */

/**
 * @param {DashRep[]} videos
 * @param {PlayExtras} [extra]
 * @returns {PlayInfo}
 */
function playOf(videos, extra = {}) {
  return {
    videos,
    audios: extra.audios ?? AAC_TRACKS,
    dolby: extra.dolby ?? [],
    flac: extra.flac ?? null,
    supportFormats: extra.supportFormats ?? [],
    acceptQuality: [],
    acceptDescription: [],
    timelengthS: 100,
    trialOnly: false,
    legacy: false,
  };
}

const AVC = "avc1.640028";
const HEVC = "hev1.1.6.L150.90";
const AV1 = "av01.0.08M.08";
/** @type {Record<string, DashRep[]>} */
const SETS = {
  avcOnly: [
    rep(80, AVC, 1600000),
    rep(64, AVC, 900000),
    rep(32, AVC, 450000),
    rep(16, AVC, 230000),
  ],
  hevcOnly: [rep(80, HEVC, 1200000), rep(64, HEVC, 600000), rep(32, HEVC, 300000)],
  mixedHevcLower: [
    rep(112, AVC, 3000000),
    rep(112, HEVC, 2400000),
    rep(80, AVC, 1600000),
    rep(80, HEVC, 1200000),
    rep(80, AV1, 1100000),
    rep(64, AVC, 900000),
    rep(64, HEVC, 600000),
    rep(32, AVC, 450000),
    rep(16, AVC, 230000),
  ],
  mixedHevcHigher: [
    rep(112, AVC, 3000000),
    rep(112, HEVC, 3400000),
    rep(80, AVC, 1600000),
    rep(80, HEVC, 1800000),
    rep(64, AVC, 900000),
    rep(64, HEVC, 1000000),
    rep(32, AVC, 450000),
    rep(32, HEVC, 500000),
    rep(16, AVC, 230000),
  ],
};
/**
 * set, cap, mode → the expected quality id and codec family.
 * @type {[string, number | null, "compatible" | "best", number, "avc" | "hevc"][]}
 */
const MATRIX = [
  ["avcOnly", 1080, "compatible", 80, "avc"],
  ["avcOnly", 1080, "best", 80, "avc"],
  ["avcOnly", 720, "compatible", 64, "avc"],
  ["avcOnly", 720, "best", 64, "avc"],
  ["avcOnly", 480, "compatible", 32, "avc"],
  ["avcOnly", 480, "best", 32, "avc"],
  ["avcOnly", null, "compatible", 80, "avc"],
  ["avcOnly", null, "best", 80, "avc"],
  ["hevcOnly", 1080, "compatible", 80, "hevc"], // no avc at all: hevc it is
  ["hevcOnly", 1080, "best", 80, "hevc"],
  ["hevcOnly", 720, "compatible", 64, "hevc"],
  ["hevcOnly", 720, "best", 64, "hevc"],
  ["hevcOnly", 480, "compatible", 32, "hevc"],
  ["hevcOnly", 480, "best", 32, "hevc"],
  ["hevcOnly", null, "compatible", 80, "hevc"],
  ["hevcOnly", null, "best", 80, "hevc"],
  ["mixedHevcLower", 1080, "compatible", 112, "avc"], // 112 and 80 are both 1080 nominal
  ["mixedHevcLower", 1080, "best", 112, "avc"],
  ["mixedHevcLower", 720, "compatible", 64, "avc"],
  ["mixedHevcLower", 720, "best", 64, "avc"],
  ["mixedHevcLower", 480, "compatible", 32, "avc"],
  ["mixedHevcLower", 480, "best", 32, "avc"],
  ["mixedHevcLower", null, "compatible", 112, "avc"],
  ["mixedHevcLower", null, "best", 112, "avc"],
  ["mixedHevcHigher", 1080, "compatible", 112, "avc"], // compatible: avc even at less bandwidth
  ["mixedHevcHigher", 1080, "best", 112, "hevc"], // best takes the bandwidth
  ["mixedHevcHigher", 720, "compatible", 64, "avc"],
  ["mixedHevcHigher", 720, "best", 64, "hevc"],
  ["mixedHevcHigher", 480, "compatible", 32, "avc"],
  ["mixedHevcHigher", 480, "best", 32, "hevc"],
  ["mixedHevcHigher", null, "compatible", 112, "avc"],
  ["mixedHevcHigher", null, "best", 112, "hevc"],
];

test("the selection matrix: caps 1080/720/480/best × compatible/best × avc-only/hevc-only/mixed", () => {
  for (const [set, maxHeight, codec, id, family] of MATRIX) {
    const label = `${set} ${maxHeight} ${codec}`;
    const videos = /** @type {DashRep[]} */ (SETS[set]);
    const chosen = chooseStreams(playOf(videos), { maxHeight, codec });
    assert.ok(chosen, label);
    assert.equal(chosen.video.id, id, `${label}: quality`);
    assert.equal(chosen.video.codecFamily, family, `${label}: codec`);
    assert.equal(chosen.audio?.id, 30280, `${label}: audio`); // the highest-bandwidth AAC
  }
});

test("selection edge cases: av1 fallback, ties, unknown ids, portrait videos, a cap below everything", () => {
  assert.equal(chooseStreams(playOf([]), BEST), null);
  assert.equal(chooseStreams(null, BEST), null);
  assert.equal(chooseStreams(undefined, BEST), null);
  // compatible: avc, then hevc, then av1 — only av1 at the best height
  const av1Only1080 = playOf([rep(80, AV1, 1100000), rep(64, AVC, 900000)]);
  const av1Pick = chooseStreams(av1Only1080, { maxHeight: 1080, codec: "compatible" });
  assert.equal(av1Pick?.video.codecFamily, "av1");
  const hevcAndAv1 = playOf([rep(80, AV1, 1300000), rep(80, HEVC, 1200000), rep(64, AVC, 900000)]);
  assert.equal(chooseStreams(hevcAndAv1, COMPATIBLE)?.video.codecFamily, "hevc");
  assert.equal(chooseStreams(hevcAndAv1, BEST)?.video.codecFamily, "av1");
  // equal bandwidths: the higher quality id, then the served order
  const tie = playOf([rep(80, AVC, 1600000), rep(112, AVC, 1600000), rep(116, AVC, 1600000)]);
  assert.equal(chooseStreams(tie, BEST)?.video.id, 116);
  const sameTie = playOf([rep(80, AVC, 1600000), rep(80, HEVC, 1600000)]);
  assert.equal(chooseStreams(sameTie, BEST)?.video.codecFamily, "avc");
  // every quality taller than the cap: the lowest one
  const avcOnly = playOf(/** @type {DashRep[]} */ (SETS["avcOnly"]));
  assert.equal(chooseStreams(avcOnly, { maxHeight: 240, codec: "best" })?.video.id, 16);
  // an unknown id is ranked by its dimensions; a portrait 1080P video is 1080 nominal
  const portrait = rep(80, AVC, 1600000, { width: 1080, height: 1920 });
  assert.equal(nominalHeight(portrait), 1080);
  assert.equal(nominalHeight(rep(999, AVC, 1, { width: 1080, height: 1920 })), 1080);
  assert.equal(nominalHeight(rep(999, AVC, 1, { width: 3840, height: 2160 })), 2160);
  assert.equal(nominalHeight(rep(999, AVC, 1, { width: null, height: 540 })), 540);
  assert.equal(nominalHeight(rep(999, AVC, 1, { width: null, height: null })), null);
  const unknownIds = playOf([
    rep(999, AVC, 5000000, { width: 3840, height: 2160 }),
    rep(998, AVC, 2000000, { width: 1920, height: 1080 }),
  ]);
  assert.equal(chooseStreams(unknownIds, { maxHeight: 1080, codec: "best" })?.video.id, 998);
  assert.equal(chooseStreams(unknownIds, BEST)?.video.id, 999);
  // no dimensions anywhere: by bandwidth
  const blind = playOf([
    rep(998, AVC, 100, { width: null, height: null }),
    rep(997, AVC, 300, { width: null, height: null }),
  ]);
  assert.equal(chooseStreams(blind, { maxHeight: 480, codec: "compatible" })?.video.id, 997);
  // a representation without a known height loses to one with
  const mixedKnowledge = playOf([
    rep(998, AVC, 9000000, { width: null, height: null }),
    rep(32, AVC, 450000),
  ]);
  assert.equal(chooseStreams(mixedKnowledge, BEST)?.video.id, 32);
});

test("the audio: AAC first in compatible, FLAC then Dolby then AAC in best, null without any", () => {
  const dolby = [rep(30250, "ec-3", 384000)];
  const flac = rep(30251, "fLaC", 1150000);
  assert.equal(chooseAudio(playOf([]), "compatible")?.id, 30280);
  assert.equal(chooseAudio(playOf([]), "best")?.id, 30280);
  assert.equal(chooseAudio(playOf([], { dolby }), "best")?.codecs, "ec-3");
  assert.equal(chooseAudio(playOf([], { dolby, flac }), "best")?.codecs, "fLaC");
  assert.equal(chooseAudio(playOf([], { dolby, flac }), "compatible")?.id, 30280);
  assert.equal(chooseAudio(playOf([], { audios: [], dolby, flac }), "compatible")?.codecs, "fLaC");
  assert.equal(chooseAudio(playOf([], { audios: [], dolby }), "compatible")?.codecs, "ec-3");
  assert.equal(chooseAudio(playOf([], { audios: [] }), "compatible"), null);
  assert.equal(chooseAudio(playOf([], { audios: [] }), "best"), null);
  // audios without an AAC codec string: the highest bandwidth of what there is
  const odd = [rep(1, "", 50), rep(2, "", 70)];
  assert.equal(chooseAudio(playOf([], { audios: odd }), "compatible")?.id, 2);
  // two Dolby tracks: the higher bandwidth
  const twoDolby = [rep(30250, "ec-3", 384000), rep(30255, "ec-3", 640000)];
  assert.equal(chooseAudio(playOf([], { dolby: twoDolby }), "best")?.id, 30255);
  // through chooseStreams: a video without any audio
  const silent = chooseStreams(playOf([rep(80, AVC, 1600000)], { audios: [] }), BEST);
  assert.equal(silent?.audio, null);
  assert.equal(silent?.video.id, 80);
});

test("missingPremium names the support_formats qualities the session is not served", () => {
  const formats = [
    { quality: 125, label: "HDR 真彩", codecs: [] },
    { quality: 116, label: "1080P 60帧", codecs: [] },
    { quality: 74, label: "720P 60帧", codecs: [] },
    { quality: 80, label: "1080P 高清", codecs: [] },
    { quality: 16, label: "360P 流畅", codecs: [] },
  ];
  const served = playOf([rep(80, AVC, 1600000), rep(16, AVC, 230000)], { supportFormats: formats });
  assert.deepEqual(chooseStreams(served, BEST)?.missingPremium, ["HDR", "1080P60", "720P 60帧"]);
  assert.deepEqual(chooseStreams(playOf([rep(80, AVC, 1600000)]), BEST)?.missingPremium, []);
  const { play } = okOf(parsePage(OK_HTML));
  const capped = chooseStreams(play, { maxHeight: 480, codec: "compatible" });
  assert.deepEqual(capped?.missingPremium, ["1080P60", "1080P+"]);
});

test("ids, page URLs, frame rates and the label tables", () => {
  assert.equal(canonicalId("BV1GJ411x7h7"), "BV1GJ411x7h7");
  assert.equal(canonicalId("bv1GJ411x7h7"), "BV1GJ411x7h7");
  assert.equal(canonicalId(" Bv1GJ411x7h7 "), "BV1GJ411x7h7");
  assert.equal(canonicalId("av170001"), "av170001");
  assert.equal(canonicalId("AV170001"), "av170001");
  assert.equal(canonicalId("av000170001"), "av170001");
  assert.equal(canonicalId("av0"), "av0");
  assert.equal(canonicalId("BV1GJ411x7h"), null); // 9 characters
  assert.equal(canonicalId("BV1GJ411x7h7x"), null); // 11
  assert.equal(canonicalId("BV1GJ411-7h7"), null);
  assert.equal(canonicalId("av"), null);
  assert.equal(canonicalId("av12a"), null);
  assert.equal(canonicalId(""), null);
  assert.equal(canonicalId(42), null);
  assert.equal(canonicalId(null), null);
  assert.equal(BILIBILI_BASE_URL, "https://www.bilibili.com");
  assert.equal(pageUrl("BV1GJ411x7h7"), "https://www.bilibili.com/video/BV1GJ411x7h7");
  assert.equal(pageUrl("BV1GJ411x7h7", 2), "https://www.bilibili.com/video/BV1GJ411x7h7?p=2");
  assert.equal(pageUrl("BV1GJ411x7h7", null), "https://www.bilibili.com/video/BV1GJ411x7h7");
  assert.equal(pageUrl("BV1GJ411x7h7", 0), "https://www.bilibili.com/video/BV1GJ411x7h7");
  assert.equal(
    pageUrl("av170001", 3, "http://127.0.0.1:8123/bili//"),
    "http://127.0.0.1:8123/bili/video/av170001?p=3",
  );
  assert.equal(frameRateOf("25"), 25);
  assert.equal(frameRateOf("16000/672"), 16000 / 672);
  assert.equal(frameRateOf("29.97"), 29.97);
  assert.equal(frameRateOf(60), 60);
  assert.equal(frameRateOf("1/0"), null);
  assert.equal(frameRateOf(""), null);
  assert.equal(frameRateOf("fast"), null);
  assert.equal(frameRateOf(0), null);
  assert.equal(frameRateOf(null), null);
  const labelled = Object.keys(QUALITY_LABELS)
    .map(Number)
    .sort((a, b) => a - b);
  assert.deepEqual(labelled, [16, 32, 64, 80, 112, 116, 120, 125, 126, 127]);
  assert.equal(QUALITY_LABELS[116], "1080P60");
  assert.equal(QUALITY_HEIGHTS[116], 1080);
  assert.equal(QUALITY_HEIGHTS[125], undefined); // HDR: its dimensions decide
  assert.deepEqual(AUDIO_LABELS, { 30216: "64K", 30232: "132K", 30280: "192K" });
});
