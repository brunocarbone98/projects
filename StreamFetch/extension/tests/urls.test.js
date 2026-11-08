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

test("Dailymotion refusals: playlists of every shape, searches, channels, bad ids, paths", () => {
  assert.equal(reason("https://www.dailymotion.com/video/x8vu47w?playlist=x7wdsj"), "playlist");
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
    "https://space.bilibili.com/3985676",
    "https://space.bilibili.com/3985676/video",
    "https://space.bilibili.com/3985676/upload/video",
  ]) {
    assert.equal(reason(url), "space", url);
  }
  for (const url of [
    "https://space.bilibili.com/3985676/favlist?fid=1234",
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
    "https://space.bilibili.com/3985676/audio",
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
    "https://bilibili.tv/en/video/1",
    "https://www.biliintl.com/en/video/1",
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
