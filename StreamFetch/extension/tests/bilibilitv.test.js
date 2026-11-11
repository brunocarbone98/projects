// @ts-check
// Unit tests of src/lib/bilibilitv.js: the playurl answers (ok, geo, login, premium, other codes,
// empty, entries without a URL, junk), the stream selection shared with lib/bilibili.js, the page
// readers (embedded state, og: and JSON-LD fallbacks), a series' episodes and season_info, the
// API and page URLs, and the ids kept as text end to end. Invented ids, example hosts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { chooseStreams as chooseBilibiliStreams } from "../src/lib/bilibili.js";
import {
  API_PREFIX,
  BILIBILITV_API_ORIGIN,
  BILIBILITV_ORIGIN,
  GEO_CODE,
  LOGIN_CODES,
  MILLISECONDS_FROM,
  REFERER,
  chooseStreams,
  codeRefusal,
  decodeEntities,
  durationFromNumber,
  elementTextByClass,
  episodesUrl,
  idText,
  isoDurationSeconds,
  jsonLdVideo,
  metaContent,
  pageUrl,
  parseEpisodes,
  parsePage,
  parsePlayurl,
  parseSeasonInfo,
  playurlUrl,
  seasonInfoUrl,
} from "../src/lib/bilibilitv.js";

/** @typedef {import("../src/lib/bilibilitv.js").BilibilitvPlay} BilibilitvPlay */
/** @typedef {import("../src/lib/bilibilitv.js").BilibilitvRefusal} BilibilitvRefusal */

/** @param {string} name */
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
/** @param {string} name @returns {unknown} */
const json = (name) => JSON.parse(fixture(name));

/** An invented aid of the real shape: 16 digits. */
const AID = "4801520000000001";
/** An aid beyond 2^53 − 1: JSON.parse would change its last digit. */
const BIG_AID = "9007199254740993";
const CDN_PATH =
  "https://upos-bstar1-mirrorakam.example-cdn.test/iupxcodeboss/ab/cd/" +
  "n241108ad0000000000000000000000001";
/** @type {{ maxHeight: null, codec: "compatible" }} */
const COMPATIBLE = { maxHeight: null, codec: "compatible" };
/** @type {{ maxHeight: null, codec: "best" }} */
const BEST = { maxHeight: null, codec: "best" };

/**
 * The ok result of a playurl answer (fails the test on a refusal).
 * @param {unknown} answer
 * @returns {BilibilitvPlay}
 */
function played(answer) {
  const play = parsePlayurl(answer);
  if (!play.ok) assert.fail(`refused: ${play.code} ${JSON.stringify(play.params)}`);
  return play;
}

/**
 * The refusal of a playurl answer (fails the test when it is ok).
 * @param {unknown} answer
 * @returns {BilibilitvRefusal}
 */
function refused(answer) {
  const play = parsePlayurl(answer);
  if (play.ok) assert.fail("accepted");
  return play;
}

/**
 * A playurl answer with these video entries and the fixture's two audio entries.
 * @param {unknown[]} video
 * @returns {Record<string, unknown>}
 */
function answerWith(video) {
  const ok = /** @type {{ data: { playurl: Record<string, unknown> } }} */ (
    json("btv-playurl-ok.json")
  );
  return { code: 0, message: "0", data: { playurl: { ...ok.data.playurl, video } } };
}

/**
 * One video entry.
 * @param {number} quality
 * @param {string} codecs
 * @param {number} height
 * @param {number} bandwidth
 * @param {string | null} [url]
 * @returns {Record<string, unknown>}
 */
function entry(quality, codecs, height, bandwidth, url) {
  return {
    video_resource: {
      url: url === undefined ? `${CDN_PATH}-${quality}-${codecs}.mp4?deadline=1` : url,
      codecs,
      width: Math.round((height * 16) / 9),
      height,
      bandwidth,
      size: bandwidth,
      mime_type: "video/mp4",
      quality,
    },
    stream_info: { quality, desc_words: `${height}P` },
  };
}

// --------------------------------------------------------------------------- playurl

test("parsePlayurl: the ok answer — three video files, two audio files, labels and ids", () => {
  const play = played(json("btv-playurl-ok.json"));
  assert.deepEqual(
    play.videos.map((rep) => [rep.id, rep.label, rep.width, rep.height, rep.codecFamily]),
    [
      [80, "1080P", 1920, 1080, "avc"],
      [64, "720P", 1280, 720, "avc"],
      [32, "480P", 852, 480, "avc"],
    ],
  );
  const first = /** @type {import("../src/lib/bilibili.js").DashRep} */ (play.videos[0]);
  assert.equal(first.codecs, "avc1.640032");
  assert.equal(first.bandwidth, 1450000);
  assert.equal(first.size, 17312000);
  assert.equal(first.mimeType, "video/mp4");
  assert.equal(first.frameRate, null);
  assert.equal(first.urls.length, 1);
  assert.ok(first.urls[0]?.startsWith(`${CDN_PATH}-1-80.mp4?e=`), "the URL as served");
  assert.deepEqual(
    play.audios.map((rep) => [rep.id, rep.label, rep.bandwidth, rep.codecs, rep.codecFamily]),
    [
      [30280, "192K", 192000, "mp4a.40.2", "unknown"],
      [30216, "64K", 64000, "mp4a.40.2", "unknown"],
    ],
  );
  assert.deepEqual(
    play.supportFormats.map((format) => [format.quality, format.label]),
    [
      [80, "1080P"],
      [64, "720P"],
      [32, "480P"],
    ],
  );
  assert.deepEqual(play.acceptQuality, [80, 64, 32]);
  assert.deepEqual(
    [play.dolby, play.flac, play.trialOnly, play.legacy, play.timelengthS],
    [[], null, false, false, 95.5],
  );
  // a JSON text is parsed first
  assert.deepEqual(parsePlayurl(fixture("btv-playurl-ok.json")), play);
});

test("parsePlayurl: the answer's duration in milliseconds, or none — never a guess", () => {
  const ok = /** @type {{ data: { playurl: Record<string, unknown> } }} */ (
    json("btv-playurl-ok.json")
  );
  /** @param {unknown} duration */
  const withDuration = (duration) => {
    /** @type {Record<string, unknown>} */
    const playurl = { ...ok.data.playurl };
    delete playurl["duration"];
    if (duration !== undefined) playurl["duration"] = duration;
    return played({ code: 0, message: "0", data: { playurl } }).timelengthS;
  };
  assert.equal(withDuration(95500), 95.5);
  assert.equal(withDuration(6000), 6, "milliseconds whatever the magnitude");
  assert.equal(withDuration("1440000"), 1440, "a number written as text");
  for (const none of [undefined, null, 0, -95500, "", "95 s", Number.NaN, {}, [95500], true]) {
    assert.equal(withDuration(none), null, String(none));
  }
});

test("parsePlayurl: the site's codes — geo, login (or premium), any other unavailable", () => {
  assert.deepEqual(refused(json("btv-playurl-geo.json")), {
    ok: false,
    code: "geo_blocked",
    params: { site_code: "10004001", site_message: "Bilibili.tv answered code 10004001" },
  });
  assert.deepEqual(refused(json("btv-playurl-login.json")), {
    ok: false,
    code: "login_required",
    params: { site_code: "10004004", site_message: "Bilibili.tv answered code 10004004" },
  });
  assert.deepEqual(refused(json("btv-playurl-premium.json")), {
    ok: false,
    code: "login_required",
    params: {
      site_code: "10023006",
      site_message: "This episode is only available to premium members",
    },
  });
  for (const code of LOGIN_CODES) {
    assert.equal(refused({ code, message: "x" }).code, "login_required", String(code));
  }
  assert.deepEqual(LOGIN_CODES, [10004004, 10004005, 10023006]);
  assert.equal(GEO_CODE, 10004001);
  assert.deepEqual(refused({ code: 10003003, message: "The video does not exist" }), {
    ok: false,
    code: "deleted",
    params: { site_code: "10003003", site_message: "The video does not exist" },
  });
  // a code written as text, and a code that is no number at all
  assert.equal(refused({ code: "10004001", message: "geo" }).code, "geo_blocked");
  assert.deepEqual(refused({ code: "E_FAIL", message: "" }).params, {
    site_code: "E_FAIL",
    site_message: "Bilibili.tv answered code E_FAIL",
  });
  // code 0 written as text, or no code at all, is an ok answer
  const one = answerWith([entry(80, "avc1.640032", 1080, 1)]);
  assert.equal(parsePlayurl({ ...one, code: "0" }).ok, true);
  const { code: _code, ...noCode } = one;
  assert.equal(parsePlayurl(noCode).ok, true);
});

test("parsePlayurl: empty, entries without a URL, no playurl, junk — never a throw", () => {
  assert.deepEqual(refused(json("btv-playurl-empty.json")), {
    ok: false,
    code: "no_streams",
    params: { detail: "the playurl answer lists no video" },
  });
  // the entry without a URL is skipped, its quality still listed (the premium hint)
  const partial = played(json("btv-playurl-nourl.json"));
  assert.deepEqual(
    partial.videos.map((rep) => rep.id),
    [64, 32],
  );
  assert.deepEqual(
    partial.supportFormats.map((format) => [format.quality, format.label]),
    [
      [112, "1080P (HD+)"],
      [64, "720P"],
      [32, "480P"],
    ],
  );
  // every entry without a URL: the qualities exist, none is served — premium only
  assert.deepEqual(
    refused(answerWith([entry(112, "avc1.640033", 1080, 9, ""), entry(80, "avc1", 1080, 1, null)])),
    { ok: false, code: "premium_only", params: { labels: ["1080P"] } },
  );
  assert.deepEqual(
    refused(answerWith([entry(112, "avc1.640033", 1080, 9, "ftp://x.example/1.mp4")])).params,
    { labels: ["1080P"] },
  );
  assert.deepEqual(refused({ code: 0, data: {} }), {
    ok: false,
    code: "no_streams",
    params: { detail: "the answer has no playurl" },
  });
  assert.equal(refused({ code: 0, data: null }).code, "no_streams");
  for (const junk of [null, 7, "not json", [], undefined, "[1,2]"]) {
    assert.deepEqual(
      refused(junk),
      { ok: false, code: "not_a_video", params: { content_type: "an answer that is not JSON" } },
      String(junk),
    );
  }
  // junk entries are skipped; the quality falls back to the resource's own; labels fall back
  const odd = played(
    answerWith([
      7,
      null,
      {
        video_resource: { url: "//cdn.example/a.mp4", height: 720, quality: 64, codecs: "hev1.1" },
      },
      { video_resource: { url: "https://cdn.example/b.mp4", height: 360 }, stream_info: {} },
      { video_resource: { url: "https://cdn.example/c.mp4", bandwidth: -5 } },
    ]),
  );
  assert.deepEqual(
    odd.videos.map((rep) => [rep.id, rep.label, rep.codecFamily, rep.urls[0], rep.bandwidth]),
    [
      [64, "720P", "hevc", "https://cdn.example/a.mp4", 0],
      [0, "360P", "unknown", "https://cdn.example/b.mp4", 0],
      [0, null, "unknown", "https://cdn.example/c.mp4", 0],
    ],
  );
  const audios = answerWith([entry(80, "avc1", 1080, 1)]);
  const playurl = /** @type {{ playurl: Record<string, unknown> }} */ (audios["data"]).playurl;
  playurl["audio_resource"] = [
    { url: "https://cdn.example/a1.mp4", codecs: "mp4a.40.2", bandwidth: 96000, quality: 30250 },
    { url: "", codecs: "mp4a.40.2", bandwidth: 320000, quality: 30251 },
    { url: "https://cdn.example/a2.mp4", codecs: "mp4a.40.2" },
    "junk",
  ];
  assert.deepEqual(
    played(audios).audios.map((rep) => [rep.id, rep.label, rep.bandwidth]),
    [
      [30250, "96K", 96000],
      [0, null, 0],
    ],
  );
});

test("codeRefusal: 0 or no code is none; the message is kept unless it repeats the code", () => {
  assert.equal(codeRefusal({ code: 0 }), null);
  assert.equal(codeRefusal({}), null);
  assert.equal(codeRefusal({ code: null }), null);
  assert.deepEqual(codeRefusal({ code: 10004005, message: "  Please log in  " }), {
    ok: false,
    code: "login_required",
    params: { site_code: "10004005", site_message: "Please log in" },
  });
  assert.equal(
    codeRefusal({ code: -404, message: "-404" })?.params["site_message"],
    "Bilibili.tv answered code -404",
  );
});

// ------------------------------------------------------------------- stream selection

test("chooseStreams: lib/bilibili.js's rules: top height under the cap, AAC by bandwidth", () => {
  const play = played(json("btv-playurl-ok.json"));
  const best = chooseStreams(play, COMPATIBLE);
  assert.equal(best?.video.id, 80);
  assert.equal(best?.audio?.id, 30280, "the highest-bandwidth AAC");
  assert.deepEqual(best?.missingPremium, []);
  assert.equal(best?.available, play.videos);
  assert.equal(best?.audioAvailable, play.audios);
  assert.equal(chooseStreams(play, { maxHeight: 720, codec: "compatible" })?.video.id, 64);
  assert.equal(chooseStreams(play, { maxHeight: 480, codec: "best" })?.video.id, 32);
  assert.equal(chooseStreams(play, { maxHeight: 360, codec: "best" })?.video.id, 32, "the lowest");
  // one implementation: the same video and audio as lib/bilibili.js picks
  /** @type {{ maxHeight: number | null, codec: "compatible" | "best" }[]} */
  const preferences = [COMPATIBLE, BEST, { maxHeight: 720, codec: "best" }];
  for (const prefs of preferences) {
    const own = chooseStreams(play, prefs);
    const shared = chooseBilibiliStreams(play, prefs);
    assert.equal(own?.video, shared?.video);
    assert.equal(own?.audio, shared?.audio);
  }
  assert.equal(chooseStreams(null, COMPATIBLE), null);
  assert.equal(chooseStreams(undefined, BEST), null);
  assert.equal(chooseStreams({ ...play, videos: [] }, BEST), null);
});

test("chooseStreams: the codec preference only among streams of the chosen height", () => {
  const play = played(
    answerWith([
      entry(80, "hev1.1.6.L120.90", 1080, 900000),
      entry(80, "avc1.640032", 1080, 1500000),
      entry(80, "av01.0.08M.08", 1080, 2000000),
      entry(64, "avc1.64001F", 720, 800000),
    ]),
  );
  assert.equal(chooseStreams(play, COMPATIBLE)?.video.codecFamily, "avc");
  assert.equal(chooseStreams(play, BEST)?.video.codecFamily, "av1", "the highest bandwidth");
  // the resolution is never lowered to get H.264
  const hevcOnly = played(
    answerWith([entry(80, "hev1.1.6.L120.90", 1080, 900000), entry(64, "avc1.64001F", 720, 1)]),
  );
  const chosen = chooseStreams(hevcOnly, COMPATIBLE)?.video;
  assert.deepEqual([chosen?.height, chosen?.codecFamily], [1080, "hevc"]);
});

test("chooseStreams: missingPremium names the qualities listed without a URL, site's words", () => {
  const play = played(json("btv-playurl-nourl.json"));
  const selection = chooseStreams(play, COMPATIBLE);
  assert.equal(selection?.video.id, 64);
  assert.deepEqual(selection?.missingPremium, ["1080P (HD+)"]);
  // lib/bilibili.js would print its own English label; the Bilibili.tv rows keep the site's
  assert.deepEqual(chooseBilibiliStreams(play, COMPATIBLE)?.missingPremium, ["1080P+"]);
});

// ------------------------------------------------------------------------------ pages

test("parsePage: an episode page — OgvVideo.epDetail under __INITIAL_DATA__", () => {
  assert.deepEqual(parsePage(fixture("btv-page-ogv.html")), {
    title: "E3 - An Invented Episode",
    cover: "https://pic.bstarstatic.example/ogv/0000000000000000000000000000000000000003.png",
    durationS: 1440,
    kind: "episode",
  });
});

test("parsePage: a user video page — UgcVideo.videoData under __INITIAL_STATE__", () => {
  assert.deepEqual(parsePage(fixture("btv-page-ugc.html")), {
    title: "An Invented User Video",
    cover: "https://pic.bstarstatic.example/ugc/0123456789abcdef0123456789abcdef.jpg",
    durationS: 95,
    kind: "video",
  });
});

test("parsePage: a page with only og: tags and JSON-LD", () => {
  assert.deepEqual(parsePage(fixture("btv-page-meta.html")), {
    title: "Tom & Jerry's Invented Clip — Part 1",
    cover: "https://pic.bstarstatic.example/ugc/meta-only-cover.jpg",
    durationS: 95.5,
    kind: null,
  });
});

test("parsePage: ugc.archive, a JSON __initialState, title_display before title, fallbacks", () => {
  /** @param {unknown} state @param {string} [marker] @param {string} [extra] */
  const page = (state, marker = "__INITIAL_DATA__", extra = "") =>
    `<html><head>${extra}</head>` +
    `<script>window.${marker} = ${JSON.stringify(state)};</script></html>`;
  assert.deepEqual(parsePage(page({ ugc: { archive: { title: "Archive", duration: 30 } } })), {
    title: "Archive",
    cover: null,
    durationS: 30,
    kind: "video",
  });
  const nuxt = page({ OgvVideo: { epDetail: { title: "Nuxt" } } }, "__initialState");
  assert.equal(parsePage(nuxt)?.title, "Nuxt");
  assert.equal(parsePage(nuxt)?.kind, "episode");
  const both = page({ UgcVideo: { videoData: { title: "Plain", title_display: "Shown" } } });
  assert.equal(parsePage(both)?.title, "Shown");
  // the state names no title: the bstar-meta__title heading, then og:title, then JSON-LD
  const heading = '<h2 class="x bstar-meta__title y">  Heading &amp; <b>bold</b>\n title </h2>';
  const og = '<meta property="og:title" content="From og">';
  const ld =
    '<script type="application/ld+json">{"@type":"VideoObject","name":"From LD",' +
    '"thumbnailUrl":"https://pic.bstarstatic.example/ld.jpg","duration":"PT2M"}</script>';
  const empty = { UgcVideo: { videoData: { cover: "" } } };
  const all = page(empty, "__INITIAL_DATA__", heading + og + ld);
  assert.equal(parsePage(all)?.title, "Heading & bold title");
  assert.equal(parsePage(page(empty, "__INITIAL_DATA__", og + ld))?.title, "From og");
  assert.deepEqual(parsePage(page(empty, "__INITIAL_DATA__", ld)), {
    title: "From LD",
    cover: "https://pic.bstarstatic.example/ld.jpg",
    durationS: 120,
    kind: "video",
  });
  // a state without the video object still lets the fallbacks speak; nothing at all is null
  assert.equal(parsePage(page({ other: 1 }, "__INITIAL_STATE__", og))?.title, "From og");
  assert.equal(parsePage(page({ other: 1 })), null);
});

test("parsePage: durations — duration_ms, video_duration, by magnitude, JSON-LD decides", () => {
  /** @param {Record<string, unknown>} video @param {string} [extra] */
  const page = (video, extra = "") =>
    `${extra}<script>window.__INITIAL_DATA__=` +
    `{"UgcVideo":{"videoData":${JSON.stringify({ title: "t", ...video })}}}</script>`;
  assert.equal(parsePage(page({ duration_ms: 95500 }))?.durationS, 95.5);
  assert.equal(parsePage(page({ video_duration: 300 }))?.durationS, 300);
  assert.equal(parsePage(page({ duration: "620" }))?.durationS, 620);
  assert.equal(parsePage(page({ duration: 9999 }))?.durationS, 9999, "seconds below the line");
  assert.equal(parsePage(page({ duration: 15000 }))?.durationS, 15, "milliseconds from it");
  assert.equal(parsePage(page({ duration: 0 }))?.durationS, null);
  assert.equal(parsePage(page({ duration: "long" }))?.durationS, null);
  // a 3-hour film in seconds: JSON-LD's duration says which reading is right
  const ld = (/** @type {string} */ iso) =>
    `<script type="application/ld+json">{"@type":"VideoObject","duration":"${iso}"}</script>`;
  assert.equal(parsePage(page({ duration: 10800 }, ld("PT3H")))?.durationS, 10800);
  assert.equal(parsePage(page({ duration: 6000 }, ld("PT6S")))?.durationS, 6);
  assert.equal(parsePage(page({}, ld("PT1H1S")))?.durationS, 3601);
  assert.equal(MILLISECONDS_FROM, 10_000);
});

test("parsePage: junk is null, never a throw", () => {
  const junks = [null, undefined, 7, "", "<html></html>", "window.__INITIAL_DATA__ = {", "{}"];
  for (const junk of junks) {
    assert.equal(parsePage(junk), null, String(junk));
  }
  const broken =
    '<script>window.__INITIAL_DATA__ = {"UgcVideo": {"videoData": {"title": "x"</script>' +
    '<script type="application/ld+json">{not json}</script><meta property="og:title" content="">';
  assert.equal(parsePage(broken), null);
});

test("page helpers: entities, meta tags, elements by class, JSON-LD graphs, ISO durations", () => {
  assert.equal(
    decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x4E2D;&nbsp;&unknown; &#0;"),
    "a & b <c> \"d\" 'e' 中 &unknown; &#0;",
  );
  const html =
    "<meta name=\"og:title\" content='Single'><meta property=\"og:image\" content=\"\">" +
    '<META PROPERTY="OG:IMAGE" CONTENT="https://pic.example/x.jpg">';
  assert.equal(metaContent(html, "og:title"), "Single");
  assert.equal(metaContent(html, "og:image"), "https://pic.example/x.jpg");
  assert.equal(metaContent(html, "og:description"), null);
  const near = '<div class="bstar-meta__title-x">no</div>';
  assert.equal(elementTextByClass(near, "bstar-meta__title"), null);
  assert.equal(elementTextByClass('<p class="a">unclosed', "a"), null);
  assert.equal(elementTextByClass('<p class="a"> </p><p class="a">second</p>', "a"), "second");
  const graph =
    '<script type="application/ld+json">[{"@type":"Person"},{"@graph":[{"@type":"VideoObject",' +
    '"name":"G","thumbnailUrl":["", "//pic.example/g.jpg"]}]}]</script>';
  assert.deepEqual(jsonLdVideo(graph), {
    name: "G",
    durationS: null,
    thumbnail: "https://pic.example/g.jpg",
  });
  const notLd = '<script type="text/javascript">{"@type":"VideoObject"}</script>';
  assert.equal(jsonLdVideo(notLd), null);
  assert.equal(isoDurationSeconds("PT1H2M3.5S"), 3723.5);
  assert.equal(isoDurationSeconds("P1DT1S"), 86401);
  assert.equal(isoDurationSeconds("pt90s"), 90);
  for (const bad of ["P", "PT", "1:30", "", null, 90, "PT0S"]) {
    assert.equal(isoDurationSeconds(bad), null, String(bad));
  }
  assert.equal(durationFromNumber(42), 42);
  assert.equal(durationFromNumber(1440000), 1440);
  assert.equal(durationFromNumber(-1), null);
  assert.equal(durationFromNumber("x"), null);
});

// ----------------------------------------------------------------------------- series

test("parseEpisodes: two sections in order, ids as text, titles, covers, durations", () => {
  const listed = parseEpisodes(json("btv-episodes.json"));
  assert.equal(listed.refusal, null);
  assert.deepEqual(
    listed.episodes.map((one) => [one.index, one.epId, one.title, one.durationS]),
    [
      [1, "30010001", "E1 - The Beginning", 1440],
      [2, "30010002", 'E2 - A "Quoted" Middle', 1438],
      [3, "30010003", "E3 - The End {special}", null],
    ],
  );
  assert.equal(
    listed.episodes[0]?.cover,
    "https://pic.bstarstatic.example/ogv/0000000000000000000000000000000000000001.png",
  );
  assert.deepEqual(parseEpisodes(fixture("btv-episodes.json")), listed);
});

test("parseEpisodes: duplicates dropped, lossy numbers never trusted, refusals, junk", () => {
  const answer = {
    code: 0,
    data: {
      sections: [
        null,
        { episodes: [{ episode_id: 7, title: "Seven" }, { episode_id: "7" }, "junk"] },
        {
          episodes: [
            { episode_id: Number(BIG_AID) },
            { episode_id: BIG_AID, title_display: "Big" },
            { episode_id: "12a" },
            { episode_id: -3 },
            { title: "no id" },
          ],
        },
      ],
    },
  };
  assert.deepEqual(
    parseEpisodes(answer).episodes.map((one) => [one.index, one.epId, one.title]),
    [
      [1, "7", "Seven"],
      [2, BIG_AID, "Big"],
    ],
  );
  assert.deepEqual(parseEpisodes({ code: 10004001, message: "10004001" }), {
    episodes: [],
    refusal: {
      ok: false,
      code: "geo_blocked",
      params: { site_code: "10004001", site_message: "Bilibili.tv answered code 10004001" },
    },
  });
  for (const junk of [null, "nope", 3, { code: 0 }, { code: 0, data: { sections: "x" } }]) {
    assert.deepEqual(parseEpisodes(junk), { episodes: [], refusal: null }, String(junk));
  }
});

test("parseSeasonInfo: the series' title; null for a refusal or junk", () => {
  assert.deepEqual(parseSeasonInfo(json("btv-season-info.json")), { title: "An Invented Series" });
  assert.deepEqual(parseSeasonInfo(fixture("btv-season-info.json")), {
    title: "An Invented Series",
  });
  assert.deepEqual(parseSeasonInfo({ code: 10004004, data: { season: { title: "x" } } }), {
    title: null,
  });
  const blank = { code: 0, data: { season: { title: " " } } };
  for (const junk of [null, "{", { code: 0, data: {} }, blank]) {
    assert.deepEqual(parseSeasonInfo(junk), { title: null }, String(junk));
  }
});

// ------------------------------------------------------------------------------- URLs

test("the API's URLs: playurl by aid or ep_id, episodes, season_info — the ids as text", () => {
  assert.equal(
    playurlUrl(BILIBILITV_API_ORIGIN, { aid: AID }),
    `https://api.bilibili.tv/intl/gateway/web/playurl?platform=web&aid=${AID}`,
  );
  assert.equal(
    playurlUrl("http://127.0.0.1:8123/btv-api/", { epId: "30010003" }),
    "http://127.0.0.1:8123/btv-api/intl/gateway/web/playurl?platform=web&ep_id=30010003",
  );
  assert.ok(playurlUrl(BILIBILITV_API_ORIGIN, { aid: BIG_AID }).endsWith(`&aid=${BIG_AID}`));
  assert.notEqual(String(Number(BIG_AID)), BIG_AID, "a number would have changed it");
  assert.equal(
    episodesUrl(BILIBILITV_API_ORIGIN, "2090001"),
    "https://api.bilibili.tv/intl/gateway/web/v2/ogv/play/episodes?season_id=2090001&platform=web",
  );
  assert.equal(
    seasonInfoUrl("http://127.0.0.1:1/btv-api", "2090001"),
    "http://127.0.0.1:1/btv-api/intl/gateway/web/v2/ogv/play/season_info" +
      "?season_id=2090001&platform=web",
  );
  assert.equal(API_PREFIX, "/intl/gateway/web");
  assert.equal(REFERER, "https://www.bilibili.tv/");
});

test("pageUrl: the canonical /en/ pages of a video, an episode and a series", () => {
  assert.equal(pageUrl({ kind: "video", id: AID }), `https://www.bilibili.tv/en/video/${AID}`);
  assert.equal(
    pageUrl({ kind: "episode", id: "30010003", seasonId: "2090001" }),
    "https://www.bilibili.tv/en/play/2090001/30010003",
  );
  assert.equal(
    pageUrl({ kind: "series", id: "2090001", seasonId: "2090001" }, "http://127.0.0.1:9/btv/"),
    "http://127.0.0.1:9/btv/en/play/2090001",
  );
  assert.equal(BILIBILITV_ORIGIN, "https://www.bilibili.tv");
  assert.throws(() => pageUrl({ kind: "episode", id: "1" }), /episode 1 has no season/);
  assert.throws(() => pageUrl({ kind: "space", id: "1" }), /unknown Bilibili.tv link kind "space"/);
});

test("idText: digit strings as they are, safe JSON numbers, nothing lossy", () => {
  assert.equal(idText(AID), AID);
  assert.equal(idText(` ${BIG_AID} `), BIG_AID);
  assert.equal(idText(30010001), "30010001");
  assert.equal(idText(Number(BIG_AID)), null);
  for (const bad of ["", "12a", -1, 1.5, null, {}, Number.NaN]) {
    assert.equal(idText(bad), null, String(bad));
  }
});
