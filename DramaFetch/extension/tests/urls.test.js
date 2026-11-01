// @ts-check
// Unit tests of src/lib/urls.js.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  UnsupportedUrlError,
  isShortDramaUrl,
  parseInput,
  parseSeriesList,
  seriesPageUrl,
  seriesRefFromUrl,
  videoPageUrl,
} from "../src/lib/urls.js";

const ID = "7699393770256782354";

test("series links of every shape, a bare id and the episode hint", () => {
  assert.deepEqual(parseInput(`https://www.tiktok.com/shortdrama/episode/${ID}/3`), {
    kind: "series",
    seriesId: ID,
    episodeHint: 3,
    sourceUrl: `https://www.tiktok.com/shortdrama/episode/${ID}/3`,
  });
  assert.equal(parseInput(`www.tiktok.com/shortdrama/episode/${ID}/1`).sourceUrl, `https://www.tiktok.com/shortdrama/episode/${ID}/1`);
  assert.deepEqual(parseInput(`  ${ID} `), { kind: "series", seriesId: ID, episodeHint: null, sourceUrl: ID });
  const zero = parseInput(`https://m.tiktok.com/shortdrama/episode/${ID}/0?x=1`);
  assert.equal(zero.kind === "series" && zero.episodeHint, null);
  assert.equal(parseInput(`<https://www.tiktok.com/shortdrama/detail/${ID}>`).kind, "series");
});

test("a single video is recognised, with its author as pasted", () => {
  assert.deepEqual(parseInput("https://www.tiktok.com/@Muffin.Drama/video/7699400000000000001"), {
    kind: "video",
    itemId: "7699400000000000001",
    author: "Muffin.Drama",
    sourceUrl: "https://www.tiktok.com/@Muffin.Drama/video/7699400000000000001",
  });
});

test("short links, other hosts, other digits and junk are refused with the Python texts", () => {
  assert.throws(() => parseInput("https://vm.tiktok.com/ZMabc/"), /^UnsupportedUrlError: Short links/);
  assert.throws(() => parseInput(""), { name: "UnsupportedUrlError", message: "Paste a TikTok short-drama URL (…/shortdrama/episode/<id>/<n>)." });
  assert.throws(() => parseInput("it's junk"), {
    message:
      "Not a TikTok short-drama or video URL: \"it's junk\". Expected https://www.tiktok.com/shortdrama/episode/<series id>/<episode> or https://www.tiktok.com/@user/video/<id>.",
  });
  assert.throws(() => parseInput("７".repeat(19)), UnsupportedUrlError); // full-width digits
  assert.throws(() => parseInput(`https://example.com/shortdrama/episode/${ID}/1`), UnsupportedUrlError);
});

test("page URLs and the tab check, test base included", () => {
  assert.equal(seriesPageUrl(ID), `https://www.tiktok.com/shortdrama/episode/${ID}/1`);
  assert.equal(seriesPageUrl(ID, 0, "http://127.0.0.1:8123//"), `http://127.0.0.1:8123/shortdrama/episode/${ID}/1`);
  assert.equal(videoPageUrl("5"), "https://www.tiktok.com/@_/video/5");
  assert.equal(isShortDramaUrl(`https://www.tiktok.com/shortdrama/episode/${ID}/2`), true);
  assert.equal(isShortDramaUrl("https://www.tiktok.com/@a/video/7699400000000000001"), false);
  assert.equal(isShortDramaUrl(ID), false); // a bare id is no tab
  assert.equal(isShortDramaUrl("https://www.tiktok.com/foryou"), false);
  assert.equal(seriesRefFromUrl(`http://127.0.0.1:8123/shortdrama/episode/${ID}/4`, "http://127.0.0.1:8123")?.seriesId, ID);
  assert.equal(seriesRefFromUrl(`http://127.0.0.1:8123/shortdrama/episode/${ID}/4`), null);
});

test("the text box follows --from-file: comments, blank lines, BOM, duplicates, refused lines", () => {
  const list = parseSeriesList(
    `\ufeff# my list\n\n${ID}\r\nhttps://www.tiktok.com/shortdrama/episode/7699393770256782399/3  # second\n${ID}\n`,
  );
  assert.deepEqual(
    list.refs.map((ref) => ref.seriesId),
    [ID, "7699393770256782399"],
  );
  assert.deepEqual(list.notes, [`duplicate: ${ID}`]);
  assert.deepEqual(list.errors, []);
  assert.equal(list.lines, 3);
  const refused = parseSeriesList(`${ID}\n\nhttps://www.tiktok.com/@a/video/7699400000000000001\nnope\n`);
  assert.deepEqual(
    refused.errors.map((error) => [error.line, error.kind]),
    [
      [3, "video"],
      [4, "unsupported"],
    ],
  );
  assert.match(/** @type {{message: string}} */ (refused.errors[0]).message, /^line 3: 'https:\/\/www\.tiktok\.com\/@a\/video\/7699400000000000001' is a single video, not a series/);
  assert.match(/** @type {{message: string}} */ (refused.errors[1]).message, /^line 4: Not a TikTok short-drama or video URL: 'nope'/);
  assert.deepEqual(parseSeriesList("\n# nothing\n"), { refs: [], notes: [], errors: [], lines: 0 });
});
