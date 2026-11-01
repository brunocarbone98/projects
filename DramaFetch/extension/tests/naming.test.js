// @ts-check
// Unit tests of src/lib/naming.js: the Python rule (parity-tested in pytest) and the extension's
// own Windows / Chrome rules on top of it.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXTENSION_MAX_STEM_LEN,
  MAX_FOLDER_LEN,
  chromeSafeFilename,
  displayName,
  downloadFilename,
  episodeStem,
  fileBaseName,
  fileStem,
  nameFormatProblem,
  safeFilename,
  seriesFolder,
  validateNameFormat,
} from "../src/lib/naming.js";

/** @param {number} number @param {Partial<{title: string, seriesName: string | null, itemId: string}>} [extra] */
const episode = (number, extra = {}) => ({
  number,
  itemId: extra.itemId ?? `76994000000000000${String(number).padStart(2, "0")}`,
  title: extra.title ?? `Episode ${number}`,
  seriesId: "7699393770256782354",
  seriesName: extra.seriesName ?? "The Billionaire's Secret Heiress",
});

test("the default stem: <Series name> - Episode NN", () => {
  assert.equal(episodeStem(episode(1)), "The Billionaire's Secret Heiress - Episode 01");
  assert.equal(episodeStem(episode(100)), "The Billionaire's Secret Heiress - Episode 100");
  assert.equal(episodeStem(episode(3, { seriesName: null }), { seriesName: "Given" }), "Given - Episode 03");
  assert.equal(episodeStem({ ...episode(4), seriesName: null }), "series-7699393770256782354 - Episode 04");
});

test("safeFilename keeps the Python rule: reserved characters, device names, dots", () => {
  assert.equal(safeFilename('a/b\\c:d*e?f"g<h>i|j'), "a b c d e f g h i j");
  assert.equal(safeFilename("CON"), "CON_");
  assert.equal(safeFilename("com1.txt"), "com1_.txt");
  assert.equal(safeFilename("Aux. Stories"), "Aux_. Stories");
  assert.equal(safeFilename("..."), "untitled");
  assert.equal(safeFilename("x".repeat(100), 10), "x".repeat(10));
  assert.equal(safeFilename("tab\tnew\nline\x85nel"), "tab new line nel");
});

test("a long stem shortens {series} first, so Episode NN is never cut; the cap is 110", () => {
  const long = { seriesName: "A Very Long Series Name ".repeat(6), title: "T".repeat(60) };
  const stem = episodeStem(episode(7, long), { nameFormat: "{series} - {title} - Episode {number}" });
  assert.ok(stem.length <= EXTENSION_MAX_STEM_LEN, String(stem.length));
  assert.ok(stem.endsWith(` - ${"T".repeat(60)} - Episode 07`), stem);
  assert.ok(stem.startsWith("A Very Long"), stem);
  // the Python tool's length and no shortening: the plain safe_filename cut
  const python = episodeStem(episode(7, long), {
    nameFormat: "{series} - {title} - Episode {number}",
    maxLen: 150,
    shortenSeries: false,
    chromeSafe: false,
  });
  assert.equal(python.length, 150);
  assert.ok(!python.endsWith("Episode 07"));
  // two {series}: each gives up its share
  const twice = episodeStem(episode(2, long), { nameFormat: "{series} {title} {series} {number}" });
  assert.ok(twice.length <= EXTENSION_MAX_STEM_LEN && twice.endsWith(" 02"), twice);
});

test("Chrome-safe names: no tilde, no format or control character, no leading dot", () => {
  assert.equal(chromeSafeFilename("Love ~ Story"), "Love Story");
  assert.equal(chromeSafeFilename("a\u200db\u202ec\ufeffd\u0081e"), "abcde");
  assert.equal(chromeSafeFilename(".hack"), "hack");
  assert.equal(chromeSafeFilename(". . ."), "untitled");
  assert.equal(chromeSafeFilename("clock$"), "clock$_");
  assert.equal(chromeSafeFilename("desktop.ini"), "desktop_.ini");
  // Windows counts UTF-16 units: an astral character is two, and is never split
  const emoji = chromeSafeFilename("\u{1f600}".repeat(10), 5);
  assert.equal(emoji, "\u{1f600}\u{1f600}");
  assert.equal(episodeStem(episode(1, { seriesName: "~Love~" })), "Love - Episode 01");
});

test("the series folder is <name> [<id>], 60 characters at most, the id never cut", () => {
  assert.equal(seriesFolder("Paid Love Story", "7699393770256782388"), "Paid Love Story [7699393770256782388]");
  const folder = seriesFolder("N".repeat(200), "7699393770256782388");
  assert.equal(folder.length, MAX_FOLDER_LEN);
  assert.ok(folder.endsWith(" [7699393770256782388]"));
  assert.equal(seriesFolder("CON", "1"), "CON_ [1]");
  assert.equal(displayName(null, "5"), "series-5");
  assert.equal(displayName("Name", "5"), "Name");
  assert.equal(
    downloadFilename("Paid Love Story [7699393770256782388]", "Paid Love Story - Episode 03", "mp4"),
    "DramaFetch/Paid Love Story [7699393770256782388]/Paid Love Story - Episode 03.mp4",
  );
});

test("name formats are validated with the Python messages", () => {
  assert.equal(nameFormatProblem("{series} - Episode {number}"), null);
  assert.equal(
    nameFormatProblem("{number:02d}"),
    "unknown placeholder {number:02d} in name format '{number:02d}': use {series}, {number}, {n}, {title}, {id}",
  );
  assert.match(String(nameFormatProblem("{series")), /^unmatched brace in name format '\{series'/);
  assert.match(String(nameFormatProblem("{series}")), /does not tell episodes apart/);
  assert.throws(() => validateNameFormat("{nope}"), /unknown placeholder \{nope\}/);
  assert.throws(() => episodeStem(episode(1), { nameFormat: "{series}" }), /does not tell episodes apart/);
});

test("file names from Chrome's paths, Windows or POSIX", () => {
  assert.equal(fileBaseName("C:\\Users\\me\\Downloads\\DramaFetch\\S [1]\\S - Episode 01.mp4"), "S - Episode 01.mp4");
  assert.equal(fileBaseName("/home/me/Downloads/DramaFetch/S [1]/S - Episode 01 (1).mp4"), "S - Episode 01 (1).mp4");
  assert.equal(fileStem("/x/a.b.mp4"), "a.b");
  assert.equal(fileStem("/x/.hidden"), ".hidden");
  assert.equal(fileStem("name."), "name.");
});
