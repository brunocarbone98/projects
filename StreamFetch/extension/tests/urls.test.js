// @ts-check
// Unit tests of src/lib/urls.js: every accepted link shape of both sites, every refusal, the text
// box rules (comments, duplicates, the cap) and the popup's tab check.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  B23_PREFIX,
  MAX_ITEMS,
  REFUSAL_REASONS,
  canonicalBilibiliId,
  isRefused,
  isVideoPageUrl,
  itemKey,
  pageUrlOf,
  parseInput,
  parseLine,
  videoItemFromUrl,
} from "../src/lib/urls.js";

const BVID = "BV1GJ411x7h7";

/**
 * The item a line parses to (fails the test when the line is refused).
 * @param {string} text
 * @returns {import("../src/lib/urls.js").Item}
 */
function item(text) {
  const parsed = parseLine(text);
  if (isRefused(parsed)) assert.fail(`${text}: refused as ${parsed.reason}`);
  return parsed;
}

/**
 * The reason a line is refused for (fails the test when it is accepted).
 * @param {string} text
 * @returns {string}
 */
function reason(text) {
  const parsed = parseLine(text);
  if (!isRefused(parsed)) assert.fail(`${text}: accepted as ${parsed.key}`);
  return parsed.reason;
}

test("Dailymotion: x and k ids, slugs, embed, geo player, dai.ly, no scheme, http, hosts", () => {
  assert.deepEqual(item("https://www.dailymotion.com/video/x8vu47w"), {
    key: "dailymotion:x8vu47w",
    site: "dailymotion",
    kind: "video",
    id: "x8vu47w",
    part: null,
    shortLink: null,
    pageUrl: "https://www.dailymotion.com/video/x8vu47w",
    original: "https://www.dailymotion.com/video/x8vu47w",
  });
  assert.equal(item("https://www.dailymotion.com/video/x8vu47w_le-titre-de-la").id, "x8vu47w");
  const kid = "k2Y4Mjp7krAF9iCuINM";
  assert.equal(item(`https://www.dailymotion.com/video/${kid}`).id, kid);
  assert.equal(item("https://www.dailymotion.com/embed/video/x89eyek?autoplay=1").id, "x89eyek");
  assert.equal(item("https://geo.dailymotion.com/player.html?video=x89eyek&mute=1").id, "x89eyek");
  const geoKid = "k46oCapRs4iikoz9DWy";
  assert.equal(item(`https://geo.dailymotion.com/player/x86gw.html?video=${geoKid}`).id, geoKid);
  assert.equal(
    item("https://geo.dailymotion.com/player/xakln.html?video=x8mjju4&customConfig%5Bx%5D=1").id,
    "x8mjju4",
  );
  const short = item("https://dai.ly/x94cnnk");
  assert.deepEqual(
    [short.id, short.shortLink, short.pageUrl, short.key],
    [
      "x94cnnk",
      "https://dai.ly/x94cnnk",
      "https://www.dailymotion.com/video/x94cnnk",
      "dailymotion:x94cnnk",
    ],
  );
  assert.equal(item("dai.ly/x94cnnk").shortLink, "https://dai.ly/x94cnnk");
  const page = "https://www.dailymotion.com/video/x8vu47w";
  assert.equal(item("www.dailymotion.com/video/x8vu47w").pageUrl, page);
  assert.equal(item("http://www.dailymotion.com/video/x8vu47w/").key, "dailymotion:x8vu47w");
  assert.equal(item("https://touch.dailymotion.com/video/x8vu47w").id, "x8vu47w");
  assert.equal(item("https://www.dailymotion.fr/video/x8vu47w").id, "x8vu47w");
  assert.equal(item("https://dailymotion.com/video/x8vu47w").id, "x8vu47w");
  assert.equal(item(`<${page}>`).original, `<${page}>`);
  assert.equal(item("https://www.dailymotion.com/crawler/video/x8vu47w").id, "x8vu47w");
  assert.equal(item("https://www.dailymotion.com/swf/video/x8vu47w").id, "x8vu47w");
  assert.equal(item("HTTPS://WWW.DAILYMOTION.COM/VIDEO/x8vu47w").id, "x8vu47w");
  assert.equal(item(`  ${page}  `).original, page);
});

test("Dailymotion refusals: a playlist and no video, searches, channels, bad ids, paths", () => {
  assert.equal(reason("https://geo.dailymotion.com/player/xf7zn.html?playlist=x7wdsj"), "playlist");
  assert.equal(reason("https://www.dailymotion.com/playlist/x7wdsj"), "playlist");
  assert.equal(reason("https://www.dailymotion.com/playlist"), "playlist");
  assert.equal(reason("https://www.dailymotion.com/search/tennis/videos"), "list");
  assert.equal(reason("https://www.dailymotion.com/lequipe"), "unsupported-path");
  assert.equal(reason("https://www.dailymotion.com/"), "unsupported-path");
  assert.equal(reason("https://www.dailymotion.com/video/X8VU47W"), "unsupported-path");
  assert.equal(reason("https://www.dailymotion.com/video/x8vu47w-slug"), "unsupported-path");
  assert.equal(reason("https://www.dailymotion.com/video/"), "unsupported-path");
  assert.equal(reason("https://www.dailymotion.com/video/x8vu47w/extra"), "unsupported-path");
  assert.equal(reason("https://www.dailymotion.com/video/y8vu47w"), "unsupported-path");
  assert.equal(reason("https://geo.dailymotion.com/player/xf7zn.html"), "unsupported-path");
  assert.equal(reason("https://geo.dailymotion.com/player.html?video=nope!"), "unsupported-path");
  assert.equal(reason("https://dai.ly/"), "unsupported-path");
  assert.equal(reason("https://dai.ly/playlist/x7"), "unsupported-path");
  assert.equal(reason("https://dai.ly/not-an-id"), "unsupported-path");
});

test("Bilibili: BV and av ids, ?p= (the last counts), slashes, m. host, the player embed", () => {
  assert.deepEqual(item(`https://www.bilibili.com/video/${BVID}`), {
    key: `bilibili:${BVID}:all`,
    site: "bilibili",
    kind: "video",
    id: BVID,
    part: null,
    shortLink: null,
    pageUrl: `https://www.bilibili.com/video/${BVID}`,
    original: `https://www.bilibili.com/video/${BVID}`,
  });
  const part = item(`https://www.bilibili.com/video/${BVID}/?spm_id_from=333.999.0.0&p=2#reply1`);
  assert.deepEqual(
    [part.key, part.part, part.pageUrl],
    [`bilibili:${BVID}:2`, 2, `https://www.bilibili.com/video/${BVID}?p=2`],
  );
  assert.equal(item(`https://www.bilibili.com/video/${BVID}?p=1&p=3`).part, 3);
  assert.equal(item(`https://www.bilibili.com/video/${BVID}?p=0`).part, null);
  assert.equal(item(`https://www.bilibili.com/video/${BVID}?p=abc`).part, null);
  assert.equal(item(`https://www.bilibili.com/video/${BVID}?p=2.5`).part, null);
  assert.equal(item(`https://www.bilibili.com/video/${BVID}?p=-1`).part, null);
  assert.equal(item(`https://www.bilibili.com/video/${BVID}?t=90`).part, null);
  assert.equal(item("https://www.bilibili.com/video/av170001/").key, "bilibili:av170001:all");
  assert.equal(item("https://www.bilibili.com/video/AV0170001").id, "av170001");
  assert.equal(item("https://www.bilibili.com/video/bv1GJ411x7h7").id, BVID);
  assert.equal(item("https://www.bilibili.com/video/Bv1GJ411x7h7").id, BVID);
  const partTwo = `https://www.bilibili.com/video/${BVID}?p=2`;
  assert.equal(item(`https://m.bilibili.com/video/${BVID}?p=2`).pageUrl, partTwo);
  assert.equal(item(`bilibili.com/video/${BVID}`).id, BVID);
  assert.equal(item(`www.bilibili.com/video/${BVID}/`).id, BVID);
  assert.equal(item(`http://www.bilibili.com/VIDEO/${BVID}`).id, BVID);
  const embed = `https://player.bilibili.com/player.html?bvid=${BVID}&cid=1&p=2`;
  assert.equal(item(embed).key, `bilibili:${BVID}:2`);
  assert.equal(item("https://player.bilibili.com/player.html?aid=170001&cid=1").id, "av170001");
});

test("b23.tv: an opaque code is a b23: item for the resolver; an id code is parsed", () => {
  assert.deepEqual(item("https://b23.tv/abcDEF1"), {
    key: "bilibili:b23:abcDEF1:all",
    site: "bilibili",
    kind: "video",
    id: "b23:abcDEF1",
    part: null,
    shortLink: "https://b23.tv/abcDEF1",
    pageUrl: "https://b23.tv/abcDEF1",
    original: "https://b23.tv/abcDEF1",
  });
  assert.equal(item("b23.tv/abcDEF1?share_source=copy_web").id, `${B23_PREFIX}abcDEF1`);
  assert.equal(item("http://b23.tv/abcDEF1/").shortLink, "https://b23.tv/abcDEF1");
  const direct = item(`https://b23.tv/${BVID}?p=2`);
  assert.deepEqual(
    [direct.id, direct.part, direct.shortLink, direct.pageUrl],
    [BVID, 2, `https://b23.tv/${BVID}`, `https://www.bilibili.com/video/${BVID}?p=2`],
  );
  assert.equal(item("https://b23.tv/av170001").id, "av170001");
  assert.equal(reason("https://b23.tv/"), "unsupported-path");
  assert.equal(reason("https://b23.tv/a/b"), "unsupported-path");
  assert.equal(reason("https://b23.tv/a-b"), "unsupported-path");
  assert.equal(pageUrlOf("bilibili", "b23:abc"), "https://b23.tv/abc");
});

test("Bilibili refusals: bangumi, space, lists, audio, live, festival, cheese, subdomains", () => {
  for (const url of [
    "https://www.bilibili.com/bangumi/play/ep1234",
    "https://www.bilibili.com/bangumi/play/ss5678",
    "https://www.bilibili.com/bangumi/media/md1",
    "https://www.bilibili.com/anime/",
  ]) {
    assert.equal(reason(url), "bangumi", url);
  }
  for (const url of [
    "https://space.bilibili.com/4801520000000077",
    "https://space.bilibili.com/4801520000000077/video",
    "https://space.bilibili.com/4801520000000077/upload/video",
  ]) {
    assert.equal(reason(url), "space", url);
  }
  for (const url of [
    "https://space.bilibili.com/4801520000000077/favlist?fid=1234",
    "https://www.bilibili.com/list/1958703906?sid=547718&bvid=BV1DU4y1r7tz",
    "https://www.bilibili.com/list/watchlater?bvid=BV1DU4y1r7tz",
    "https://www.bilibili.com/medialist/play/ml1234",
    "https://www.bilibili.com/medialist/detail/ml1234",
    "https://www.bilibili.com/watchlater/",
    "https://search.bilibili.com/all?keyword=x",
  ]) {
    assert.equal(reason(url), "list", url);
  }
  for (const url of [
    "https://www.bilibili.com/audio/au1003142",
    "https://www.bilibili.com/audio/am10624",
    "https://space.bilibili.com/4801520000000077/audio",
  ]) {
    assert.equal(reason(url), "audio", url);
  }
  assert.equal(reason("https://live.bilibili.com/196"), "live");
  assert.equal(reason("https://live.bilibili.com/blanc/196"), "live");
  for (const url of [
    "https://www.bilibili.com/festival/2023honkaiimpact3gala?bvid=BV1ay4y1d77f",
    "https://www.bilibili.com/cheese/play/ep229832",
    "https://www.bilibili.com/cheese/play/ss5918",
    "https://t.bilibili.com/722702795225120785",
    "https://www.bilibili.com/opus/722702795225120785",
    "https://www.bilibili.com/read/cv1234",
    "https://www.bilibili.com/",
    "https://www.bilibili.com/video/",
    "https://www.bilibili.com/video/BV1GJ411x7h/",
    "https://www.bilibili.com/video/BV1GJ411x7h7x",
    "https://www.bilibili.com/video/xx170001",
    "https://www.bilibili.com/video/BV1GJ411x7h7/extra",
    "https://www.bilibili.com/v/popular/rank/all",
    "https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7",
    "https://player.bilibili.com/player.html?cid=1",
    "https://player.bilibili.com/player.html?aid=x1",
    "https://player.bilibili.com/other.html?bvid=BV1GJ411x7h7",
  ]) {
    assert.equal(reason(url), "unsupported-path", url);
  }
});

test("other sites and junk; the original is kept as pasted", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.tiktok.com/@a/video/1",
    "https://vimeo.com/1",
    "example.com/video/BV1GJ411x7h7",
    "https://notbilibili.tv/en/video/1",
    "https://www.bilibili.tv.example.com/en/video/1",
    "https://dailymotion.example.com/video/x8vu47w",
    "https://notdailymotion.com/video/x1",
    "https://dai.ly.example.com/x1",
  ]) {
    assert.equal(reason(url), "other-site", url);
  }
  for (const text of [
    "",
    "   ",
    "hello",
    "it's junk",
    BVID,
    "x8vu47w",
    "av170001",
    "ftp://www.bilibili.com/video/BV1GJ411x7h7",
    "https://",
    "http://[::1",
    "video/BV1GJ411x7h7",
    "mailto:someone@example.com",
    "localhost/video/BV1GJ411x7h7",
    "<>",
  ]) {
    assert.equal(reason(text), "junk", JSON.stringify(text));
  }
  assert.equal(parseLine("  hello  ").original, "hello");
  assert.deepEqual(parseLine("nope"), { original: "nope", reason: "junk" });
  assert.deepEqual(REFUSAL_REASONS, [
    "playlist",
    "bangumi",
    "space",
    "list",
    "audio",
    "live",
    "other-site",
    "unsupported-path",
    "junk",
  ]);
});

test("the text box: comments, blank lines, BOM, CRLF, duplicates by key, the cap of 100", () => {
  const bom = String.fromCharCode(0xfeff);
  const text =
    `${bom}# my list\n\nhttps://www.dailymotion.com/video/x8vu47w  # first\r\n` +
    `https://dai.ly/x8vu47w\nhttps://www.bilibili.com/video/${BVID}?p=2 #part two\n` +
    `https://b23.tv/${BVID}?p=2\nhttps://www.bilibili.com/video/${BVID}\nnope\n` +
    "https://www.bilibili.com/bangumi/play/ep1\n   \n";
  const parsed = parseInput(text);
  assert.deepEqual(
    parsed.items.map((entry) => entry.key),
    ["dailymotion:x8vu47w", `bilibili:${BVID}:2`, `bilibili:${BVID}:all`],
  );
  assert.deepEqual(parsed.dropped, ["https://dai.ly/x8vu47w", `https://b23.tv/${BVID}?p=2`]);
  assert.deepEqual(parsed.refused, [
    { original: "nope", reason: "junk" },
    { original: "https://www.bilibili.com/bangumi/play/ep1", reason: "bangumi" },
  ]);
  // the comment is not part of the line
  assert.equal(parsed.items[0]?.original, "https://www.dailymotion.com/video/x8vu47w");
  assert.equal(parsed.items[1]?.original, `https://www.bilibili.com/video/${BVID}?p=2`);
  // a fragment glued to the link is part of it; a comment needs whitespace before its #
  assert.equal(parseInput(`https://www.bilibili.com/video/${BVID}#reply\n`).items[0]?.id, BVID);
  assert.deepEqual(parseInput("\n# nothing\n\n"), { items: [], refused: [], dropped: [] });
  assert.deepEqual(parseInput(""), { items: [], refused: [], dropped: [] });
  // the cap: 100 items, the rest dropped, refusals still reported
  const many = Array.from({ length: 105 }, (_, i) => `https://www.bilibili.com/video/av${i + 1}`);
  const capped = parseInput([...many, "junk line", ...many.slice(0, 2)].join("\n"));
  assert.equal(capped.items.length, MAX_ITEMS);
  assert.equal(capped.items[99]?.id, "av100");
  assert.deepEqual(capped.dropped, [...many.slice(100), ...many.slice(0, 2)]);
  assert.deepEqual(capped.refused, [{ original: "junk line", reason: "junk" }]);
  assert.equal(MAX_ITEMS, 100);
});

test("keys, page URLs and canonical ids", () => {
  assert.equal(itemKey("dailymotion", "x1"), "dailymotion:x1");
  assert.equal(itemKey("bilibili", BVID, 3), `bilibili:${BVID}:3`);
  assert.equal(itemKey("bilibili", BVID), `bilibili:${BVID}:all`);
  assert.equal(pageUrlOf("dailymotion", "x1"), "https://www.dailymotion.com/video/x1");
  assert.equal(pageUrlOf("bilibili", "av1", 2), "https://www.bilibili.com/video/av1?p=2");
  assert.equal(pageUrlOf("bilibili", BVID), `https://www.bilibili.com/video/${BVID}`);
  assert.equal(canonicalBilibiliId("bv1GJ411x7h7"), BVID);
  assert.equal(canonicalBilibiliId("AV007"), "av7");
  assert.equal(canonicalBilibiliId("av0"), "av0");
  assert.equal(canonicalBilibiliId("BV1GJ411x7h"), null);
  assert.equal(canonicalBilibiliId("BV1GJ411x7h7x"), null);
  assert.equal(canonicalBilibiliId("x"), null);
  assert.equal(canonicalBilibiliId("av"), null);
});

test("the popup's check: a tab on a video page, real or under the test bases; no b23 link", () => {
  assert.equal(isVideoPageUrl(`https://www.bilibili.com/video/${BVID}?p=2`), true);
  assert.equal(isVideoPageUrl("https://www.dailymotion.com/video/x8vu47w_slug"), true);
  assert.equal(isVideoPageUrl("https://www.bilibili.com/"), false);
  assert.equal(isVideoPageUrl("https://b23.tv/abc"), false);
  assert.equal(isVideoPageUrl("chrome://extensions"), false);
  assert.equal(isVideoPageUrl(BVID), false);
  const bases = {
    dailymotion: "http://127.0.0.1:8123/dm/",
    bilibili: "http://127.0.0.1:8123/bili",
  };
  const fake = videoItemFromUrl(`http://127.0.0.1:8123/bili/video/${BVID}?p=2`, bases);
  assert.deepEqual(
    [fake?.key, fake?.pageUrl, fake?.original],
    [
      `bilibili:${BVID}:2`,
      `https://www.bilibili.com/video/${BVID}?p=2`,
      `http://127.0.0.1:8123/bili/video/${BVID}?p=2`,
    ],
  );
  const dm = videoItemFromUrl("http://127.0.0.1:8123/dm/video/x8vu47w", bases);
  assert.equal(dm?.key, "dailymotion:x8vu47w");
  // without the bases, the test host is no site
  assert.equal(videoItemFromUrl(`http://127.0.0.1:8123/bili/video/${BVID}`), null);
  assert.equal(videoItemFromUrl(`http://127.0.0.1:8123/other/video/${BVID}`, bases), null);
  assert.equal(videoItemFromUrl("http://127.0.0.1:8123/bili/bangumi/play/ep1", bases), null);
});

// ------------------------------------------------------- Addendum A.7: Bilibili.tv links

/** An invented aid of the shape of the owner's examples (16 digits). */
const AID = "4801520000000001";
/** The tracking parameter the site adds to links of its "related" list, exactly. */
const BSTAR_FROM = "bstar_from=bstar-web.ugc-video-detail.related-recommend.all";

test("Bilibili.tv: a user video with and without bstar_from, any language, host and scheme", () => {
  const plain = `https://www.bilibili.tv/en/video/${AID}`;
  assert.deepEqual(item(`${plain}?${BSTAR_FROM}`), {
    key: `bilibilitv:video:${AID}`,
    site: "bilibilitv",
    kind: "video",
    id: AID,
    part: null,
    shortLink: null,
    pageUrl: plain,
    original: `${plain}?${BSTAR_FROM}`,
    seasonId: null,
  });
  for (const link of [
    plain,
    `${plain}/`,
    `https://www.bilibili.tv/es/video/${AID}?${BSTAR_FROM}`,
    `https://www.bilibili.tv/EN/video/${AID}`,
    `https://www.bilibili.tv/id/video/${AID}`,
    `https://www.bilibili.tv/th/video/${AID}#comments`,
    `https://www.bilibili.tv/vi/video/${AID}?spm_id_from=a.b.c&share_source=copy_link`,
    `https://www.bilibili.tv/zh/video/${AID}?share_medium=android&from_spmid=x&t=42`,
    `https://bilibili.tv/video/${AID}`,
    `http://www.bilibili.tv/en/video/${AID}`,
    `www.bilibili.tv/en/video/${AID}?${BSTAR_FROM}`,
    `bilibili.tv/en/video/${AID}`,
    `https://www.biliintl.com/en/video/${AID}`,
    `https://biliintl.com/video/${AID}?${BSTAR_FROM}`,
    `HTTPS://WWW.BILIBILI.TV/EN/VIDEO/${AID}`,
  ]) {
    const parsed = item(link);
    assert.deepEqual(
      [parsed.key, parsed.id, parsed.pageUrl, parsed.kind],
      [`bilibilitv:video:${AID}`, AID, plain, "video"],
      link,
    );
  }
});

test("Bilibili.tv: the aid is text end to end — 16 digits past 2^53 keep every digit", () => {
  const big = "9007199254740993";
  const parsed = item(`https://www.bilibili.tv/en/video/${big}?${BSTAR_FROM}`);
  assert.equal(parsed.id, big);
  assert.equal(parsed.key, `bilibilitv:video:${big}`);
  assert.equal(parsed.pageUrl, `https://www.bilibili.tv/en/video/${big}`);
  assert.notEqual(String(Number(big)), big, "a number would have lost the last digit");
  // two aids that are the same number once parsed stay two items
  const next = "9007199254740992";
  const both = parseInput(
    `https://www.bilibili.tv/en/video/${big}\nhttps://www.bilibili.tv/en/video/${next}`,
  );
  assert.deepEqual(
    both.items.map((entry) => entry.id),
    [big, next],
  );
});

test("Bilibili.tv: episodes and whole series (play/<season>, media/<season>)", () => {
  assert.deepEqual(item("https://www.bilibili.tv/en/play/2090001/30010003?bstar_from=x"), {
    key: "bilibilitv:episode:30010003",
    site: "bilibilitv",
    kind: "episode",
    id: "30010003",
    part: null,
    shortLink: null,
    pageUrl: "https://www.bilibili.tv/en/play/2090001/30010003",
    original: "https://www.bilibili.tv/en/play/2090001/30010003?bstar_from=x",
    seasonId: "2090001",
  });
  const intl = item("https://www.biliintl.com/es/play/2090001/30010003/");
  assert.equal(intl.key, "bilibilitv:episode:30010003");
  const series = item("https://www.bilibili.tv/en/play/2090001");
  assert.deepEqual(
    [series.key, series.kind, series.id, series.seasonId, series.pageUrl],
    [
      "bilibilitv:series:2090001",
      "series",
      "2090001",
      "2090001",
      "https://www.bilibili.tv/en/play/2090001",
    ],
  );
  const media = item("https://www.bilibili.tv/en/media/2090001?x=1");
  assert.equal(media.key, "bilibilitv:series:2090001");
  assert.equal(item("https://www.bilibili.tv/play/2090001/").key, "bilibilitv:series:2090001");
  assert.equal(item("https://www.biliintl.com/EN/media/2090001").key, "bilibilitv:series:2090001");
});

test("Bilibili.tv refusals: other paths and hosts, bili.im share links", () => {
  for (const url of [
    "https://www.bilibili.tv/en/space/123456",
    "https://www.bilibili.tv/en/trending",
    "https://www.bilibili.tv/en/search-result?q=drama",
    "https://www.bilibili.tv/en",
    "https://www.bilibili.tv/",
    "https://bilibili.tv",
    `https://www.bilibili.tv/en/video/${AID}/extra`,
    "https://www.bilibili.tv/en/video/abc123",
    "https://www.bilibili.tv/en/video/",
    "https://www.bilibili.tv/english/video/1",
    "https://www.bilibili.tv/en/play/2090001/30010003/1",
    "https://www.bilibili.tv/en/media/2090001/30010003",
    `https://api.bilibili.tv/intl/gateway/web/playurl?platform=web&aid=${AID}`,
    `https://m.bilibili.tv/en/video/${AID}`,
    "https://bili.im/AbCdEfG",
    "bili.im/AbCdEfG",
  ]) {
    assert.equal(reason(url), "unsupported-path", url);
  }
});

test("Bilibili.tv in the text box: the same video in two languages is one item", () => {
  const parsed = parseInput(
    [
      `https://www.bilibili.tv/en/video/${AID}?${BSTAR_FROM}`,
      `https://www.bilibili.tv/es/video/${AID}`,
      `bilibili.tv/video/${AID}`,
      "https://www.bilibili.tv/en/play/2090001",
      "https://www.bilibili.tv/en/media/2090001",
      "https://bili.im/AbCdEfG",
    ].join("\n"),
  );
  assert.deepEqual(
    parsed.items.map((entry) => entry.key),
    [`bilibilitv:video:${AID}`, "bilibilitv:series:2090001"],
  );
  assert.deepEqual(parsed.dropped, [
    `https://www.bilibili.tv/es/video/${AID}`,
    `bilibili.tv/video/${AID}`,
    "https://www.bilibili.tv/en/media/2090001",
  ]);
  assert.deepEqual(parsed.refused, [
    { original: "https://bili.im/AbCdEfG", reason: "unsupported-path" },
  ]);
  assert.equal(itemKey("bilibilitv", AID), `bilibilitv:video:${AID}`);
  assert.equal(itemKey("bilibilitv", "7", null, "episode"), "bilibilitv:episode:7");
  assert.equal(itemKey("bilibilitv", "9", null, "series"), "bilibilitv:series:9");
  assert.equal(pageUrlOf("bilibilitv", AID), `https://www.bilibili.tv/en/video/${AID}`);
});

test("the popup's check knows Bilibili.tv pages, real or under the test base", () => {
  assert.equal(isVideoPageUrl(`https://www.bilibili.tv/en/video/${AID}?${BSTAR_FROM}`), true);
  assert.equal(isVideoPageUrl("https://www.bilibili.tv/en/play/2090001/30010003"), true);
  assert.equal(isVideoPageUrl("https://www.bilibili.tv/en/trending"), false);
  const bases = { bilibilitv: "http://127.0.0.1:8123/btv/" };
  const fake = videoItemFromUrl(`http://127.0.0.1:8123/btv/es/video/${AID}`, bases);
  assert.deepEqual(
    [fake?.key, fake?.pageUrl, fake?.original],
    [
      `bilibilitv:video:${AID}`,
      `https://www.bilibili.tv/en/video/${AID}`,
      `http://127.0.0.1:8123/btv/es/video/${AID}`,
    ],
  );
  assert.equal(videoItemFromUrl(`http://127.0.0.1:8123/btv/es/video/${AID}`), null);
});

// ---------------------------------------------------------- Addendum A.8: Dailymotion

test("Dailymotion: a video link with ?playlist= is the video, flagged; playlist ignored", () => {
  const xid = "xbq9z2k";
  const flagged = item(`https://www.dailymotion.com/video/${xid}?playlist=x7wdsj`);
  assert.deepEqual(flagged, {
    key: `dailymotion:${xid}`,
    site: "dailymotion",
    kind: "video",
    id: xid,
    part: null,
    shortLink: null,
    pageUrl: `https://www.dailymotion.com/video/${xid}`,
    original: `https://www.dailymotion.com/video/${xid}?playlist=x7wdsj`,
    playlistIgnored: true,
  });
  for (const link of [
    `https://dai.ly/${xid}?playlist=x7wdsj`,
    `https://www.dailymotion.com/embed/video/${xid}?autoplay=1&playlist=x7wdsj`,
    `https://geo.dailymotion.com/player/xf7zn.html?video=${xid}&playlist=x7wdsj`,
    `https://www.dailymotion.com/video/${xid}_an-invented-slug?playlist=x7wdsj&start=10`,
  ]) {
    const parsed = item(link);
    assert.deepEqual([parsed.key, parsed.playlistIgnored], [`dailymotion:${xid}`, true], link);
  }
  // every other parameter is ignored and sets no flag
  const other = item(`https://www.dailymotion.com/video/${xid}?autoplay=1&start=10&ref=share`);
  assert.equal(other.key, `dailymotion:${xid}`);
  assert.equal("playlistIgnored" in other, false);
  // one item with the plain link
  const page = `https://www.dailymotion.com/video/${xid}`;
  const both = parseInput(`${page}?playlist=x7wdsj\n${page}`);
  assert.equal(both.items.length, 1);
  assert.equal(both.items[0]?.playlistIgnored, true);
  // only a link that names a playlist and no video is refused
  assert.equal(reason("https://www.dailymotion.com/playlist/x7wdsj"), "playlist");
  assert.equal(reason("https://geo.dailymotion.com/player.html?playlist=x7wdsj"), "playlist");
});

// ----------------------------------------------------- Addendum B.3: bilibili.com links

/** The parameters real Bilibili share links carry (B.3), with invented values. */
const SHARE_PARAMS = [
  "vd_source=0123456789abcdef0123456789abcdef",
  "spm_id_from=333.1007.tianma.1-1-1.click",
  "share_source=copy_web",
  "share_medium=android",
  "share_plat=android",
  "share_from=ugc",
  "share_tag=s_i",
  "bbid=XY0123456789ABCDEF0123456789ABCDEF012",
  "ts=1762600000",
  "timestamp=1762600000",
  "from_spmid=search.search-result.0.0",
  "from=search",
  "seid=1234567890123456789",
  "t=90",
  "buvid=XY0123456789ABCDEF",
  "is_story_h5=false",
  "mid=AbCdEfGh%3D%3D",
  "plat_id=116",
  "unique_k=AbCdEfG",
  "up_id=123456",
];

test("Bilibili: every share parameter is ignored; ?p= is the only one that selects", () => {
  const plain = `https://www.bilibili.com/video/${BVID}`;
  for (const param of SHARE_PARAMS) {
    const parsed = item(`${plain}/?${param}#reply123`);
    assert.deepEqual(
      [parsed.key, parsed.part, parsed.pageUrl],
      [`bilibili:${BVID}:all`, null, plain],
      param,
    );
    const withPart = item(`${plain}?${param}&p=3`);
    assert.deepEqual(
      [withPart.key, withPart.part, withPart.pageUrl],
      [`bilibili:${BVID}:3`, 3, `${plain}?p=3`],
      param,
    );
    const partFirst = item(`https://m.bilibili.com/video/${BVID}?p=2&${param}`);
    assert.equal(partFirst.key, `bilibili:${BVID}:2`, param);
  }
  const all = item(`bilibili.com/video/av170001?${SHARE_PARAMS.join("&")}&p=4`);
  assert.deepEqual(
    [all.key, all.pageUrl],
    ["bilibili:av170001:4", "https://www.bilibili.com/video/av170001?p=4"],
  );
  assert.equal(item(`http://www.bilibili.com/video/bV1GJ411x7h7?${SHARE_PARAMS[0]}`).id, BVID);
  const short = item(`https://b23.tv/abcDEF1?${SHARE_PARAMS[2]}&${SHARE_PARAMS[3]}`);
  assert.equal(short.key, "bilibili:b23:abcDEF1:all");
  // refused with a reason whatever the parameters
  const tail = `?${SHARE_PARAMS[0]}&${SHARE_PARAMS[1]}`;
  assert.equal(reason(`https://www.bilibili.com/bangumi/play/ep1234${tail}`), "bangumi");
  assert.equal(reason(`https://space.bilibili.com/4801520000000077${tail}`), "space");
  assert.equal(reason(`https://www.bilibili.com/list/watchlater${tail}`), "list");
  assert.equal(reason(`https://www.bilibili.com/audio/au1003142${tail}`), "audio");
  assert.equal(reason(`https://live.bilibili.com/196${tail}`), "live");
  const festival = `https://www.bilibili.com/festival/x?bvid=${BVID}&${SHARE_PARAMS[0]}`;
  assert.equal(reason(festival), "unsupported-path");
  assert.equal(reason(`https://www.bilibili.com/cheese/play/ep1${tail}`), "unsupported-path");
});
