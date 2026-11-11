// @ts-check
// Unit tests of src/lib/naming.js: Chrome-safe names on Windows, the paths of the spec, the
// multi-part numbering, the reserved names, the lengths, the report path.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_FOLDER_LEN,
  MAX_NAME_LEN,
  ROOT_FOLDER,
  SEASON_FOLDER_PREFIX,
  SITE_FOLDERS,
  chromeSafeFilename,
  fileBaseName,
  isEpisode,
  isMultiPart,
  partLabel,
  partStem,
  reportPath,
  reportStem,
  seriesFolder,
  targetPath,
  videoStem,
} from "../src/lib/naming.js";

const SMILE = String.fromCodePoint(0x1f600);
const BVID = "BV1GJ411x7h7";

/**
 * A Bilibili target.
 * @param {number} part
 * @param {string | null} partTitle
 * @param {number | null} [partCount]
 * @returns {import("../src/lib/naming.js").NamingTarget}
 */
const bili = (part, partTitle, partCount) => ({
  site: "bilibili",
  id: BVID,
  title: "Series",
  part,
  partTitle,
  ...(partCount === undefined ? {} : { partCount }),
});

test("chromeSafeFilename: forbidden characters become _, controls and format chars go, NFC", () => {
  assert.equal(chromeSafeFilename('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(chromeSafeFilename("Love ~ Story 100%"), "Love _ Story 100_");
  assert.equal(chromeSafeFilename("tab\tnew\nline\rend"), "tab new line end");
  const zwj = String.fromCharCode(0x200d);
  const bidi = String.fromCharCode(0x202e);
  const bom = String.fromCharCode(0xfeff);
  const c1 = String.fromCharCode(0x81);
  const c0 = String.fromCharCode(1);
  assert.equal(chromeSafeFilename(`a${zwj}b${bidi}c${bom}d${c1}e${c0}f`), "abcdef");
  assert.equal(chromeSafeFilename(`e${String.fromCharCode(0x301)}`), "é"); // NFC composes
  assert.equal(chromeSafeFilename("  spaced \u3000  out  "), "spaced out");
  assert.equal(chromeSafeFilename("...hidden..."), "hidden");
  assert.equal(chromeSafeFilename(". . ."), "untitled");
  assert.equal(chromeSafeFilename(""), "untitled");
  assert.equal(chromeSafeFilename("名字 — 第1集"), "名字 — 第1集");
  assert.equal(chromeSafeFilename("Le Mans: 24h"), "Le Mans_ 24h");
});

test("reserved device names and Chrome's reserved names are suffixed, in any case", () => {
  assert.equal(chromeSafeFilename("CON"), "CON_");
  assert.equal(chromeSafeFilename("con"), "con_");
  assert.equal(chromeSafeFilename("com1.txt"), "com1_.txt");
  assert.equal(chromeSafeFilename("Aux. Stories"), "Aux_. Stories");
  assert.equal(chromeSafeFilename("LPT9"), "LPT9_");
  assert.equal(chromeSafeFilename("COM0"), "COM0_");
  assert.equal(chromeSafeFilename("COM²"), "COM²_");
  assert.equal(chromeSafeFilename("PRN"), "PRN_");
  assert.equal(chromeSafeFilename("NUL"), "NUL_");
  assert.equal(chromeSafeFilename("CONIN$"), "CONIN$_");
  assert.equal(chromeSafeFilename("clock$"), "clock$_");
  assert.equal(chromeSafeFilename("desktop.ini"), "desktop_.ini");
  assert.equal(chromeSafeFilename("Thumbs.DB"), "Thumbs_.DB");
  assert.equal(chromeSafeFilename("CONS"), "CONS");
  assert.equal(chromeSafeFilename("COM10"), "COM10");
  assert.equal(chromeSafeFilename("Console"), "Console");
  // the rule applies to the name as saved: after the leading dot and the cut
  assert.equal(chromeSafeFilename(".CON"), "CON_");
  assert.equal(chromeSafeFilename(`NUL${SMILE}`, 3), "NUL_");
  assert.equal(chromeSafeFilename(`${SMILE}NUL`, 3), `${SMILE}N`); // 2 + 1 UTF-16 units
});

test("length: at most max UTF-16 units, an emoji never split, the id never cut", () => {
  assert.equal(chromeSafeFilename("x".repeat(200)).length, MAX_NAME_LEN);
  assert.equal(chromeSafeFilename("x".repeat(200), 10), "x".repeat(10));
  assert.equal(chromeSafeFilename("x".repeat(200), 0).length, 200);
  assert.equal(chromeSafeFilename(SMILE.repeat(10), 5), SMILE.repeat(2));
  assert.equal(chromeSafeFilename("abc. .", 10), "abc");
  assert.equal(chromeSafeFilename("abcd. x", 5), "abcd"); // the cut lands on a dot: trimmed again
  // lone surrogates (a title cut in the middle of an emoji) are dropped, whole pairs kept
  assert.equal(chromeSafeFilename("Love \ud83d"), "Love");
  assert.equal(chromeSafeFilename("\ude00Love"), "Love");
  assert.equal(chromeSafeFilename(`Love ${SMILE} Story`), `Love ${SMILE} Story`);
  // what downloads.download makes of a name: UTF-8 (a lone surrogate turns into U+FFFD), then
  // every "%" an "_"
  const saved = (/** @type {string} */ name) =>
    new TextDecoder().decode(new TextEncoder().encode(name)).replaceAll("%", "_");
  for (const name of [chromeSafeFilename("100% Love \ud83d"), chromeSafeFilename(`a${SMILE}~b`)]) {
    assert.equal(saved(name), name);
  }
  const stem = videoStem("T".repeat(300), BVID);
  assert.equal(stem.length, MAX_NAME_LEN);
  assert.ok(stem.endsWith(` [${BVID}]`));
  assert.equal(videoStem("", "x8vu47w"), "untitled [x8vu47w]");
  assert.equal(videoStem("a", "we/ird"), "a [we_ird]");
  assert.equal(videoStem("Title", "x8vu47w", 10), "T [x8vu47w]"); // the title gives way
});

test("the paths of the spec: Dailymotion, Bilibili with one part, multi-part numbering", () => {
  assert.equal(
    targetPath({
      site: "dailymotion",
      id: "x8vu47w",
      title: "Le Mans: 24h",
      part: null,
      partTitle: null,
    }),
    "StreamFetch/Dailymotion/Le Mans_ 24h [x8vu47w].mp4",
  );
  assert.equal(
    targetPath({
      site: "bilibili",
      id: BVID,
      title: "【合集】title",
      part: 1,
      partTitle: "【合集】title",
      partCount: 1,
    }),
    `StreamFetch/Bilibili/【合集】title [${BVID}].mp4`,
  );
  const folder = `StreamFetch/Bilibili/Series [${BVID}]`;
  assert.equal(targetPath(bili(1, "Intro", 3)), `${folder}/P01 - Intro.mp4`);
  assert.equal(targetPath(bili(12, "Series", 20)), `${folder}/P12.mp4`);
  assert.equal(targetPath(bili(100, "", 120)), `${folder}/P100.mp4`);
  assert.equal(targetPath(bili(7, "a/b", 9)), `${folder}/P07 - a_b.mp4`);
  assert.equal(targetPath(bili(2, null, null)), `${folder}/P02.mp4`);
  assert.equal(targetPath(bili(1, "Series", null)), `${folder}.mp4`);
  assert.equal(
    targetPath({ site: "bilibili", id: "av170001", title: "Old", part: 1, partTitle: null }),
    "StreamFetch/Bilibili/Old [av170001].mp4",
  );
  assert.equal(
    targetPath(
      { site: "dailymotion", id: "x1", title: "T", part: null, partTitle: null },
      { rootFolder: "Custom" },
    ),
    "Custom/Dailymotion/T [x1].mp4",
  );
  const site = /** @type {"bilibili"} */ (/** @type {unknown} */ ("youtube"));
  assert.throws(
    () => targetPath({ site, id: "1", title: "T", part: null, partTitle: null }),
    /unknown site "youtube"/,
  );
  // the count decides when known; a part above 1 means multi-part when it is not
  assert.equal(isMultiPart(bili(2, null)), true);
  assert.equal(isMultiPart(bili(1, null)), false);
  assert.equal(isMultiPart(bili(1, null, 2)), true);
  assert.equal(isMultiPart(bili(3, null, 1)), false);
  /** @type {import("../src/lib/naming.js").NamingTarget} */
  const single = {
    site: "dailymotion",
    id: "x1",
    title: "T",
    part: null,
    partTitle: null,
    partCount: 5,
  };
  assert.equal(isMultiPart(single), false);
  assert.deepEqual(SITE_FOLDERS, {
    dailymotion: "Dailymotion",
    bilibili: "Bilibili",
    bilibilitv: "Bilibili.tv",
  });
  assert.equal(ROOT_FOLDER, "StreamFetch");
});

test("multi-part names: the folder capped at 80, the id kept, the part file at 120, labels", () => {
  const long = targetPath({
    site: "bilibili",
    id: BVID,
    title: "N".repeat(200),
    part: 2,
    partTitle: "P".repeat(200),
    partCount: 2,
  });
  const parts = long.split("/");
  assert.equal(parts.length, 4);
  const folder = /** @type {string} */ (parts[2]);
  const file = /** @type {string} */ (parts[3]);
  assert.equal(folder.length, MAX_FOLDER_LEN);
  assert.ok(folder.endsWith(` [${BVID}]`));
  assert.equal(file.length, MAX_NAME_LEN + ".mp4".length);
  assert.ok(file.startsWith("P02 - PPP"));
  assert.deepEqual(
    [1, 9, 10, 99, 100, 0].map((part) => partLabel(part)),
    ["P01", "P09", "P10", "P99", "P100", "P01"],
  );
  assert.equal(partStem(3, "  ", "T"), "P03");
  assert.equal(partStem(3, " T ", "T"), "P03");
  assert.equal(partStem(3, "CON", "T"), "P03 - CON");
  assert.equal(partStem(4, "***", "T"), "P04 - ___");
  assert.equal(partStem(4, String.fromCharCode(1, 2), "T"), "P04"); // nothing left once cleaned
  assert.equal(partStem(5, "Part: five", "T"), "P05 - Part_ five");
  assert.equal(partStem(5, "x".repeat(300), "T").length, MAX_NAME_LEN);
});

test("the report path: local date and time, no colon; file names from Chrome's paths", () => {
  const now = new Date(2026, 10, 8, 21, 7, 59);
  assert.equal(reportStem(now), "2026-11-08 2107 - did not download");
  assert.equal(reportPath(now), "StreamFetch/reports/2026-11-08 2107 - did not download.json");
  assert.equal(
    reportPath(new Date(2026, 0, 1, 0, 0)),
    "StreamFetch/reports/2026-01-01 0000 - did not download.json",
  );
  assert.match(
    reportPath(),
    /^StreamFetch\/reports\/\d{4}-\d{2}-\d{2} \d{4} - did not download\.json$/,
  );
  assert.equal(fileBaseName("C:\\Users\\me\\Downloads\\StreamFetch\\reports\\x.json"), "x.json");
  assert.equal(fileBaseName("StreamFetch/Dailymotion/a [x].mp4"), "a [x].mp4");
  assert.equal(fileBaseName("plain.mp4"), "plain.mp4");
});

test("Bilibili.tv: a user video, an episode in its series' folder or its season's", () => {
  const aid = "4801520000000001";
  /** @type {import("../src/lib/naming.js").NamingTarget} */
  const video = {
    site: "bilibilitv",
    id: aid,
    title: "An invented clip: part 1",
    part: null,
    partTitle: null,
    seasonId: null,
    episodeId: null,
    seriesTitle: null,
  };
  assert.equal(targetPath(video), `StreamFetch/Bilibili.tv/An invented clip_ part 1 [${aid}].mp4`);
  assert.equal(isEpisode(video), false);
  assert.equal(isMultiPart({ ...video, part: 3, partCount: 5 }), false);
  /** @type {import("../src/lib/naming.js").NamingTarget} */
  const episode = {
    site: "bilibilitv",
    id: "30010003",
    title: "E3 - The End?",
    part: 3,
    partTitle: null,
    seasonId: "2090001",
    episodeId: "30010003",
    seriesTitle: "An Invented Series",
  };
  assert.equal(isEpisode(episode), true);
  assert.equal(
    targetPath(episode),
    "StreamFetch/Bilibili.tv/An Invented Series/E3 - The End_ [30010003].mp4",
  );
  // the series' title unknown (an episode pasted alone): `season <season_id>`
  assert.equal(
    targetPath({ ...episode, seriesTitle: null }),
    "StreamFetch/Bilibili.tv/season 2090001/E3 - The End_ [30010003].mp4",
  );
  assert.equal(seriesFolder({ ...episode, seriesTitle: "  " }), `${SEASON_FOLDER_PREFIX} 2090001`);
  // the episode's own title when the resolver keeps it apart; the episode id in brackets
  assert.equal(
    targetPath({ ...episode, title: "Series", partTitle: "E3 - Own", id: "x" }),
    "StreamFetch/Bilibili.tv/An Invented Series/E3 - Own [30010003].mp4",
  );
  // a long series title is a folder of at most 80 units; forbidden characters become _
  const long = targetPath({ ...episode, seriesTitle: `A/B ${"S".repeat(200)}` });
  const folder = /** @type {string} */ (long.split("/")[2]);
  assert.equal(folder.length, MAX_FOLDER_LEN);
  assert.ok(folder.startsWith("A_B SSS"));
  assert.equal(SITE_FOLDERS.bilibilitv, "Bilibili.tv");
});
