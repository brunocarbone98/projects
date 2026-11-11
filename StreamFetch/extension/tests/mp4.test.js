// @ts-check
/**
 * Unit tests of `src/lib/mp4.js`: the box reader and writers, `parseInit`, the DRM walk,
 * `parseFragments` over hand-built moofs (every tfhd / trun flag), `collectFmp4` and `collectMp4`
 * over ffmpeg-made files (every sample checked against `ffprobe -show_packets`), the progressive
 * reader's table variants (stz2, co64, ctts v0/v1, stss, stsc runs, elst) on hand-built files,
 * and `probe`; every codec the sites serve (`helpers/media.js` `SITE_CODECS`: H.264 with
 * B-frames, HEVC as hvc1 and hev1, AV1, AAC, FLAC 96 kHz, E-AC-3 5.1, AC-3, Opus), fragmented and
 * progressive, read as ffprobe reads it.
 *
 * The ffmpeg helpers at the bottom are a private copy (the shared `tests/helpers/media.js` is
 * written in parallel); fixtures are built once per process under `fixtures/generated/mp4/`.
 * Without ffmpeg/ffprobe the media tests are skipped with `ffmpeg not found: media tests not run`;
 * with `STREAMFETCH_REQUIRE_TOOLS=1` that is a failure.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import {
  BOX_HEADER_PEEK,
  COVER_ITEM,
  DATA_TYPE,
  Mp4Error,
  TITLE_ITEM,
  SAMPLE_FLAG_DEPENDS_YES,
  SAMPLE_FLAG_NON_SYNC,
  TFHD,
  TRUN,
  box,
  childBoxes,
  collectFmp4,
  collectMp4,
  concat,
  drmProblem,
  findBox,
  fullBox,
  i32,
  i64,
  imageType,
  isSyncSample,
  memoryFile,
  parseFragments,
  parseInit,
  probe,
  readBoxes,
  readMetadata,
  str4,
  u16,
  u24,
  u32,
  u64,
  u8,
} from "../src/lib/mp4.js";
import {
  SITE_CODECS,
  codecFixture,
  ffprobe as probeStreams,
  ffprobePackets,
  findBox as findPath,
} from "./helpers/media.js";

const NODE = /** @type {NodeProcess} */ (Reflect.get(globalThis, "process"));
const CHILD = /** @type {ChildProcessModule} */ (NODE.getBuiltinModule("node:child_process"));
const FS = /** @type {FsExtras} */ (NODE.getBuiltinModule("node:fs"));
const SKIP_MESSAGE = "ffmpeg not found: media tests not run";
const REQUIRE_TOOLS = NODE.env["STREAMFETCH_REQUIRE_TOOLS"] === "1";
const TOOLS = hasTool("ffmpeg") && hasTool("ffprobe");
const FIXTURE_URL = new URL("./fixtures/generated/mp4/", import.meta.url);
const FIXTURE_DIR = decodeURIComponent(FIXTURE_URL.pathname);

/** @typedef {import("../src/lib/mp4.js").Mp4File} Mp4File */
/** @typedef {import("../src/lib/mp4.js").TrackPlan} TrackPlan */
/** @typedef {import("../src/lib/mp4.js").SampleRef} SampleRef */
/** @typedef {import("../src/lib/mp4.js").Box} Box */

// ------------------------------------------------------------------------------ byte helpers

/** @param {string} text Latin-1 @returns {Uint8Array} */
const latin1 = (text) => new Uint8Array(Array.from(text, (char) => char.charCodeAt(0)));

/**
 * @param {Uint8Array} bytes
 * @param {number} at
 */
const getU32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);

/**
 * Asserts that `promise` rejects with an `Mp4Error` of `code` whose message matches `pattern`.
 * @param {Promise<unknown> | (() => unknown)} action
 * @param {string} code
 * @param {RegExp} [pattern]
 */
async function rejectsWith(action, code, pattern = /./) {
  /** @param {unknown} error */
  const check = (error) =>
    error instanceof Mp4Error && error.code === code && pattern.test(error.message);
  if (typeof action === "function") assert.throws(() => action(), check);
  else await assert.rejects(action, check);
}

/**
 * A file over `bytes` that records every slice it serves.
 * @param {string} name
 * @param {Uint8Array} bytes
 * @returns {Mp4File & { reads: [number, number][] }}
 */
function recordingFile(name, bytes) {
  /** @type {[number, number][]} */
  const reads = [];
  return {
    name,
    size: bytes.length,
    reads,
    slice: async (start, end) => {
      reads.push([start, end]);
      return bytes.slice(start, end);
    },
  };
}

/**
 * A copy of `data` with the boxes `edit` replaces (it returns new bytes for a box, or undefined
 * to keep it); containers along the way are rebuilt with their new sizes.
 * @param {Uint8Array} data
 * @param {(found: Box, data: Uint8Array) => Uint8Array | undefined} edit
 * @returns {Uint8Array}
 */
function rewrite(data, edit) {
  const containers = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "moof", "traf"]);
  /** @param {Box} found @returns {Uint8Array} */
  const visit = (found) => {
    const replaced = edit(found, data);
    if (replaced !== undefined) return replaced;
    if (!containers.has(found.type)) return data.slice(found.start, found.end);
    return box(found.type, ...childBoxes(data, found).map(visit));
  };
  return concat(...readBoxes(data).map(visit));
}

// ---------------------------------------------------------------------- the box reader/writers

test("writers: integers big-endian, str4, box and fullBox headers", () => {
  assert.deepEqual([...u8(7)], [7]);
  assert.deepEqual([...u16(0x1234)], [0x12, 0x34]);
  assert.deepEqual([...u24(0x010203)], [1, 2, 3]);
  assert.deepEqual([...u32(0xdeadbeef)], [0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual([...i32(-1)], [0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual([...u64(2 ** 32 + 5)], [0, 0, 0, 1, 0, 0, 0, 5]);
  assert.deepEqual([...u64(0xffffffffffffffffn)], [255, 255, 255, 255, 255, 255, 255, 255]);
  assert.deepEqual([...i64(-2)], [255, 255, 255, 255, 255, 255, 255, 0xfe]);
  assert.deepEqual([...str4("ftyp")], [0x66, 0x74, 0x79, 0x70]);
  assert.deepEqual([...box("free")], [0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]);
  assert.deepEqual(
    [...fullBox("test", 1, 0x000203, u8(9))],
    [0, 0, 0, 13, 0x74, 0x65, 0x73, 0x74, 1, 0, 2, 3, 9],
  );
  assert.throws(() => u8(256), RangeError);
  assert.throws(() => u16(-1), RangeError);
  assert.throws(() => u32(2 ** 32), RangeError);
  assert.throws(() => u32(1.5), RangeError);
  assert.throws(() => i32(2 ** 31), RangeError);
  assert.throws(() => u64(-1), RangeError);
  assert.throws(() => str4("abc"), RangeError);
  assert.throws(() => str4("abĀd"), RangeError);
  assert.deepEqual([...concat(u8(1), new Uint8Array(0), u16(2))], [1, 0, 2]);
});

test("readBoxes: plain, largesize, uuid, size 0 to the end, trailing zero bytes", () => {
  const large = concat(u32(1), str4("wide"), u64(20), u32(42));
  const uuid = concat(u32(8 + 16 + 2), str4("uuid"), new Uint8Array(16).fill(0xab), u16(1));
  const toEnd = concat(u32(0), str4("mdat"), u32(1), u32(2));
  const data = concat(box("ftyp", str4("isom")), large, uuid, toEnd);
  const boxes = readBoxes(data);
  assert.deepEqual(
    boxes.map((found) => [found.type, found.size, found.headerSize, found.start, found.end]),
    [
      ["ftyp", 12, 8, 0, 12],
      ["wide", 20, 16, 12, 32],
      ["uuid", 26, 24, 32, 58],
      ["mdat", 16, 8, 58, 74],
    ],
  );
  const padded = concat(box("udta", box("name", u8(1))), new Uint8Array(4));
  assert.deepEqual(
    readBoxes(padded).map((found) => found.type),
    ["udta"],
  );
});

test("readBoxes: a cut box is truncated, a box smaller than its header invalid", async () => {
  const cut = concat(u32(16), str4("free"), u32(0));
  await rejectsWith(() => readBoxes(cut), "truncated", /free.*runs past/);
  await rejectsWith(() => readBoxes(concat(box("free"), u32(9), u8(1))), "truncated", /header/);
  const small = concat(u32(4), str4("free"));
  await rejectsWith(() => readBoxes(small), "invalid", /less than its header/);
  await rejectsWith(
    () => readBoxes(concat(u32(1), str4("wide"), u64(2n ** 60n))),
    "unsupported",
    /beyond 2\^53/,
  );
});

test("findBox and childBoxes: string or array paths, stsd children after its count", () => {
  const entry = box("avc1", new Uint8Array(78));
  const stsd = fullBox("stsd", 0, 0, u32(1), entry);
  const data = concat(
    box("ftyp", str4("isom")),
    box("moov", box("mvhd"), box("trak", box("tkhd"), box("mdia", box("minf", box("stbl", stsd))))),
  );
  const found = findBox(data, "moov/trak/mdia/minf/stbl/stsd");
  assert.ok(found !== null);
  assert.equal(found.type, "stsd");
  assert.deepEqual(
    childBoxes(data, found).map((child) => child.type),
    ["avc1"],
  );
  assert.equal(findBox(data, ["moov", "trak", "tkhd"])?.size, 8);
  assert.equal(findBox(data, "moov/trak/edts"), null);
  assert.equal(findBox(data, "moof"), null);
});

// ------------------------------------------------------------------------------- fragments

/**
 * A `tfhd` with the fields its flags declare.
 * @param {number} flags
 * @param {number} trackId
 * @param {{ base?: number, sdi?: number, duration?: number, size?: number,
 *   sampleFlags?: number }} [fields]
 */
function tfhd(flags, trackId, fields = {}) {
  return fullBox(
    "tfhd",
    0,
    flags,
    u32(trackId),
    flags & TFHD.BASE_DATA_OFFSET ? u64(fields.base ?? 0) : new Uint8Array(0),
    flags & TFHD.SAMPLE_DESCRIPTION_INDEX ? u32(fields.sdi ?? 1) : new Uint8Array(0),
    flags & TFHD.DEFAULT_SAMPLE_DURATION ? u32(fields.duration ?? 0) : new Uint8Array(0),
    flags & TFHD.DEFAULT_SAMPLE_SIZE ? u32(fields.size ?? 0) : new Uint8Array(0),
    flags & TFHD.DEFAULT_SAMPLE_FLAGS ? u32(fields.sampleFlags ?? 0) : new Uint8Array(0),
  );
}

/**
 * A `trun` with the fields its flags declare.
 * @param {number} version
 * @param {number} flags
 * @param {{ dataOffset?: number, firstFlags?: number,
 *   samples: { duration?: number, size?: number, flags?: number, cts?: number }[] }} fields
 */
function trun(version, flags, fields) {
  const parts = [u32(fields.samples.length)];
  if (flags & TRUN.DATA_OFFSET) parts.push(i32(fields.dataOffset ?? 0));
  if (flags & TRUN.FIRST_SAMPLE_FLAGS) parts.push(u32(fields.firstFlags ?? 0));
  for (const sample of fields.samples) {
    if (flags & TRUN.SAMPLE_DURATION) parts.push(u32(sample.duration ?? 0));
    if (flags & TRUN.SAMPLE_SIZE) parts.push(u32(sample.size ?? 0));
    if (flags & TRUN.SAMPLE_FLAGS) parts.push(u32(sample.flags ?? 0));
    if (flags & TRUN.SAMPLE_COMPOSITION_TIME_OFFSET) {
      const cts = sample.cts ?? 0;
      parts.push(version === 0 ? u32(cts) : i32(cts));
    }
  }
  return fullBox("trun", version, flags, ...parts);
}

/**
 * @param {number} version
 * @param {number | bigint} time
 */
function tfdt(version, time) {
  return fullBox("tfdt", version, 0, version === 1 ? u64(time) : u32(Number(time)));
}

/** @param {...Uint8Array} trafs */
function moof(...trafs) {
  return box("moof", fullBox("mfhd", 0, 0, u32(1)), ...trafs.map((traf) => box("traf", traf)));
}

/**
 * Offset, size, duration, flags and cts of each sample of a fragment, for compact asserts.
 * @param {import("../src/lib/mp4.js").Fragment} fragment
 */
const rows = (fragment) =>
  fragment.samples.map(({ offset, size, duration, flags, cts }) => [
    offset,
    size,
    duration,
    flags,
    cts,
  ]);
/** Every per-sample field of a trun. */
const ALL_SAMPLE_FIELDS =
  TRUN.SAMPLE_DURATION | TRUN.SAMPLE_SIZE | TRUN.SAMPLE_FLAGS | TRUN.SAMPLE_COMPOSITION_TIME_OFFSET;
/** A tfhd relative to its moof with default durations and sizes. */
const MOOF_DEFAULTS =
  TFHD.DEFAULT_BASE_IS_MOOF | TFHD.DEFAULT_SAMPLE_DURATION | TFHD.DEFAULT_SAMPLE_SIZE;

test("parseFragments: default-base-is-moof, trun data offset, per-sample fields, v0 cts (signed, as ffmpeg reads it)", () => {
  const samples = [
    { duration: 10, size: 4, flags: 0x02000000, cts: 3000 },
    { duration: 11, size: 5, flags: 0x01010000, cts: 0xffffff00 },
  ];
  const traf = concat(
    tfhd(TFHD.DEFAULT_BASE_IS_MOOF, 1),
    tfdt(1, 9000),
    trun(0, TRUN.DATA_OFFSET | ALL_SAMPLE_FIELDS, { dataOffset: 300, samples }),
  );
  const data = concat(box("styp", str4("msdh")), moof(traf), box("mdat", new Uint8Array(9)));
  const [fragment, ...rest] = parseFragments(data, 1000);
  assert.equal(rest.length, 0);
  assert.ok(fragment);
  assert.equal(fragment.trackId, 1);
  assert.equal(fragment.baseDecodeTime, 9000);
  assert.equal(fragment.sampleDescriptionIndex, 1);
  const moofStart = 1000 + 12;
  assert.deepEqual(rows(fragment), [
    [moofStart + 300, 4, 10, 0x02000000, 3000],
    [moofStart + 304, 5, 11, 0x01010000, -256],
  ]);
  assert.equal(fragment.dataStart, moofStart + 300);
  assert.equal(fragment.dataEnd, moofStart + 309);
});

test("parseFragments: version-1 trun composition offsets are signed", () => {
  const traf = concat(
    tfhd(MOOF_DEFAULTS, 2, { duration: 512, size: 3 }),
    trun(1, TRUN.SAMPLE_COMPOSITION_TIME_OFFSET, {
      samples: [{ cts: -512 }, { cts: 1024 }, { cts: -1 }],
    }),
  );
  const [fragment] = parseFragments(moof(traf));
  assert.ok(fragment);
  assert.deepEqual(
    fragment.samples.map((sample) => sample.cts),
    [-512, 1024, -1],
  );
  // No data offset, first run: the data starts at the base, the moof's first byte.
  assert.deepEqual(
    fragment.samples.map((sample) => sample.offset),
    [0, 3, 6],
  );
  assert.equal(fragment.baseDecodeTime, null);
});

test("parseFragments: absolute base-data-offset, sample-description-index, tfhd defaults", () => {
  const flags =
    TFHD.BASE_DATA_OFFSET |
    TFHD.SAMPLE_DESCRIPTION_INDEX |
    TFHD.DEFAULT_SAMPLE_DURATION |
    TFHD.DEFAULT_SAMPLE_SIZE |
    TFHD.DEFAULT_SAMPLE_FLAGS;
  const traf = concat(
    tfhd(flags, 1, {
      base: 70000,
      sdi: 2,
      duration: 1001,
      size: 7,
      sampleFlags: SAMPLE_FLAG_NON_SYNC,
    }),
    tfdt(0, 123),
    trun(0, TRUN.DATA_OFFSET | TRUN.FIRST_SAMPLE_FLAGS, {
      dataOffset: 16,
      firstFlags: 0x02000000,
      samples: [{}, {}, {}],
    }),
  );
  const [fragment] = parseFragments(moof(traf), 5000);
  assert.ok(fragment);
  assert.equal(fragment.sampleDescriptionIndex, 2);
  assert.equal(fragment.baseDecodeTime, 123);
  assert.deepEqual(rows(fragment), [
    [70016, 7, 1001, 0x02000000, 0],
    [70023, 7, 1001, SAMPLE_FLAG_NON_SYNC, 0],
    [70030, 7, 1001, SAMPLE_FLAG_NON_SYNC, 0],
  ]);
});

test("parseFragments: with no base flag the second traf starts where the first data ends", () => {
  const first = concat(
    tfhd(TFHD.DEFAULT_SAMPLE_DURATION, 1, { duration: 1 }),
    trun(0, TRUN.DATA_OFFSET | TRUN.SAMPLE_SIZE, {
      dataOffset: 200,
      samples: [{ size: 10 }, { size: 20 }],
    }),
  );
  const second = concat(
    tfhd(TFHD.DEFAULT_SAMPLE_DURATION, 2, { duration: 1 }),
    trun(0, TRUN.SAMPLE_SIZE, { samples: [{ size: 5 }] }),
  );
  const fragments = parseFragments(moof(first, second), 100);
  assert.deepEqual(
    fragments.map((fragment) => [fragment.trackId, fragment.dataStart, fragment.dataEnd]),
    [
      [1, 300, 330],
      [2, 330, 335],
    ],
  );
});

test("parseFragments: a second trun without a data offset continues after the first run", () => {
  const traf = concat(
    tfhd(TFHD.DEFAULT_BASE_IS_MOOF | TFHD.DEFAULT_SAMPLE_DURATION, 1, { duration: 2 }),
    trun(0, TRUN.DATA_OFFSET | TRUN.SAMPLE_SIZE, {
      dataOffset: 64,
      samples: [{ size: 3 }, { size: 4 }],
    }),
    trun(0, TRUN.SAMPLE_SIZE, { samples: [{ size: 5 }] }),
    trun(0, TRUN.DATA_OFFSET | TRUN.SAMPLE_SIZE, { dataOffset: 100, samples: [{ size: 1 }] }),
  );
  const [fragment] = parseFragments(moof(traf));
  assert.ok(fragment);
  assert.deepEqual(
    fragment.samples.map((sample) => sample.offset),
    [64, 67, 71, 100],
  );
  assert.equal(fragment.dataStart, 64);
  assert.equal(fragment.dataEnd, 101);
});

test("parseFragments: trex defaults fill what the tfhd and trun leave out", async () => {
  const trex = {
    defaultSampleDescriptionIndex: 1,
    defaultSampleDuration: 1024,
    defaultSampleSize: 6,
    defaultSampleFlags: 0x02000000,
  };
  const traf = concat(
    tfhd(TFHD.DEFAULT_BASE_IS_MOOF, 3),
    trun(0, TRUN.DATA_OFFSET, { dataOffset: 8, samples: [{}, {}] }),
  );
  const [fromMap] = parseFragments(moof(traf), 0, new Map([[3, trex]]));
  assert.ok(fromMap);
  assert.deepEqual(rows(fromMap), [
    [8, 6, 1024, 0x02000000, 0],
    [14, 6, 1024, 0x02000000, 0],
  ]);
  // Without any default the duration is missing: invalid, not a guess.
  await rejectsWith(() => parseFragments(moof(traf)), "invalid", /no sample duration for track 3/);
});

test("parseFragments: empty duration, tfdt v0/v1, junk, cut moofs, overlong truns", async () => {
  const emptyFlags = TFHD.DURATION_IS_EMPTY | TFHD.DEFAULT_SAMPLE_DURATION;
  const empty = concat(tfhd(emptyFlags, 1, { duration: 900 }), tfdt(0, 5));
  const [nothing] = parseFragments(moof(empty), 40);
  assert.ok(nothing);
  assert.equal(nothing.samples.length, 0);
  assert.equal(nothing.dataStart, nothing.dataEnd);
  assert.equal(nothing.baseDecodeTime, 5);

  const big = concat(tfhd(TFHD.DEFAULT_BASE_IS_MOOF, 1), tfdt(1, 2n ** 40n));
  assert.equal(parseFragments(moof(big))[0]?.baseDecodeTime, 2 ** 40);
  const huge = moof(concat(tfhd(0, 1), tfdt(1, 2n ** 60n)));
  await rejectsWith(() => parseFragments(huge), "unsupported", /beyond 2\^53/);

  // sidx and a cut trailing mdat are passed over.
  const traf = concat(
    tfhd(MOOF_DEFAULTS, 1, { duration: 1, size: 1 }),
    trun(0, 0, { samples: [{}] }),
  );
  const cutMdat = concat(u32(1000), str4("mdat"), u8(1));
  const withJunk = concat(box("sidx", new Uint8Array(20)), moof(traf), cutMdat);
  assert.equal(parseFragments(withJunk).length, 1);

  const whole = moof(traf);
  const cutMoof = whole.subarray(0, whole.length - 3);
  await rejectsWith(() => parseFragments(cutMoof, 77), "truncated", /moof box at byte 77/);

  const lying = fullBox("trun", 0, TRUN.SAMPLE_SIZE, u32(1000), u32(1));
  const overlong = moof(concat(tfhd(TFHD.DEFAULT_SAMPLE_DURATION, 1, { duration: 1 }), lying));
  await rejectsWith(() => parseFragments(overlong), "invalid", /lists 1000 samples/);
  const noTfhd = moof(trun(0, 0, { samples: [] }));
  await rejectsWith(() => parseFragments(noTfhd), "invalid", /without a tfhd/);
});

test("isSyncSample: non-sync bit and depends-on-others are not sync", () => {
  assert.equal(isSyncSample(0), true);
  assert.equal(isSyncSample(0x02000000), true);
  assert.equal(isSyncSample(SAMPLE_FLAG_NON_SYNC), false);
  assert.equal(isSyncSample(SAMPLE_FLAG_DEPENDS_YES), false);
  assert.equal(isSyncSample(0x01010000), false);
  assert.equal(isSyncSample(0x00400000), true);
});

// ------------------------------------------------------------- hand-built progressive files

/**
 * A visual sample entry (`avc1`, no codec configuration) of `width` × `height`.
 * @param {number} width
 * @param {number} height
 */
function visualEntry(width, height) {
  const body = new Uint8Array(78);
  const view = new DataView(body.buffer);
  view.setUint16(6, 1);
  view.setUint16(24, width);
  view.setUint16(26, height);
  return box("avc1", body);
}

/**
 * @typedef {{ sizes?: "stsz" | 4 | 8 | 16, co64?: boolean, cttsVersion?: 0 | 1,
 *   moovFirst?: boolean }} HandBuiltOptions
 */

/** The sample sizes of the hand-built file. */
const HAND_SIZES = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];

/**
 * The size box of the hand-built file: an `stsz`, or an `stz2` of 4-, 8- or 16-bit fields (two
 * 4-bit fields per byte, high nibble first).
 * @param {"stsz" | 4 | 8 | 16} kind
 */
function sizeBox(kind) {
  const sizes = HAND_SIZES;
  if (kind === "stsz") {
    return fullBox("stsz", 0, 0, u32(0), u32(sizes.length), ...sizes.map((size) => u32(size)));
  }
  /** @type {Uint8Array} */
  let table;
  if (kind === 16) table = concat(...sizes.map((size) => u16(size)));
  else if (kind === 8) table = new Uint8Array(sizes);
  else {
    table = new Uint8Array(Math.ceil(sizes.length / 2));
    sizes.forEach((size, index) => {
      table[index >> 1] = (table[index >> 1] ?? 0) | (index % 2 === 0 ? size << 4 : size);
    });
  }
  return fullBox("stz2", 0, 0, u24(0), u8(kind), u32(sizes.length), table);
}

/**
 * A progressive file with one video track and hand-built tables: 10 samples of sizes
 * 3,1,4,1,5,9,2,6,5,3 in chunks of 3,3,2,2 (a 7-byte gap before the third chunk), stts
 * 4×100 + 6×50, ctts v1 [−100, 200, 200, 0×7], stss {1, 6}, an elst of 500 ms empty then
 * media_time 100, timescales 1000. `sizes` picks stsz or stz2 (4/8/16 bits), `co64` the offset
 * box, `cttsVersion` 0 writes −100 as its 32-bit two's complement, `moovFirst` the layout.
 * @param {HandBuiltOptions} [options]
 */
function handBuilt(options = {}) {
  const chunks = [3, 3, 2, 2];
  /** @type {number[]} */
  const payload = [];
  /** @type {number[]} the chunks' offsets inside the mdat payload */
  const relative = [];
  let sample = 0;
  chunks.forEach((count, chunk) => {
    if (chunk === 2) payload.push(...new Array(7).fill(0xee));
    relative.push(payload.length);
    for (let index = 0; index < count; index += 1) {
      payload.push(...new Array(HAND_SIZES[sample] ?? 0).fill(sample));
      sample += 1;
    }
  });
  const mdat = box("mdat", new Uint8Array(payload));
  const ftyp = box("ftyp", str4("isom"), u32(512), str4("isom"));
  const cttsVersion = options.cttsVersion ?? 1;
  const firstOffset = cttsVersion === 1 ? i32(-100) : u32(2 ** 32 - 100);
  const ctts = fullBox("ctts", cttsVersion, 0, u32(3), u32(1), firstOffset, u32(2), u32(200));
  const cttsTail = concat(u32(7), u32(0));
  const run = (/** @type {number} */ duration, /** @type {number} */ time) =>
    concat(u32(duration), i32(time), u32(0x10000));
  const elst = fullBox("elst", 0, 0, u32(2), run(500, -1), run(450, 100));
  /** @param {number[]} offsets */
  const chunkOffsets = (offsets) =>
    options.co64
      ? fullBox("co64", 0, 0, u32(offsets.length), ...offsets.map((offset) => u64(offset)))
      : fullBox("stco", 0, 0, u32(offsets.length), ...offsets.map((offset) => u32(offset)));
  /** @param {number[]} offsets */
  const stbl = (offsets) =>
    box(
      "stbl",
      fullBox("stsd", 0, 0, u32(1), visualEntry(64, 48)),
      fullBox("stts", 0, 0, u32(2), u32(4), u32(100), u32(6), u32(50)),
      fullBox("stss", 0, 0, u32(2), u32(1), u32(6)),
      concat(u32(ctts.length + 8), ctts.subarray(4), cttsTail),
      fullBox("stsc", 0, 0, u32(2), u32(1), u32(3), u32(1), u32(3), u32(2), u32(1)),
      sizeBox(options.sizes ?? "stsz"),
      chunkOffsets(offsets),
    );
  /** @param {number[]} offsets */
  const moov = (offsets) =>
    box(
      "moov",
      fullBox("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(1150), new Uint8Array(80)),
      box(
        "trak",
        fullBox("tkhd", 0, 3, u32(0), u32(0), u32(7), new Uint8Array(68)),
        box("edts", elst),
        box(
          "mdia",
          fullBox("mdhd", 0, 0, u32(0), u32(0), u32(1000), u32(1150), u16(0x15c7), u16(0)),
          fullBox("hdlr", 0, 0, u32(0), str4("vide"), new Uint8Array(13)),
          box("minf", stbl(offsets)),
        ),
      ),
    );
  const moovSize = moov(relative.map(() => 0)).length;
  const payloadStart = ftyp.length + 8 + (options.moovFirst ? moovSize : 0);
  const offsets = relative.map((offset) => payloadStart + offset);
  const bytes = options.moovFirst
    ? concat(ftyp, moov(offsets), mdat)
    : concat(ftyp, mdat, moov(offsets));
  return { bytes, offsets };
}

/** The samples `handBuilt` describes, for a file named `name` with chunk offsets `offsets`. */
/** @param {string} name @param {number[]} offsets @returns {SampleRef[]} */
function handBuiltSamples(name, offsets) {
  const sizes = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
  const chunkOf = [0, 0, 0, 1, 1, 1, 2, 2, 3, 3];
  const dts = [0, 100, 200, 300, 400, 450, 500, 550, 600, 650].map((time) => time + 500);
  const cts = [-100, 200, 200, 0, 0, 0, 0, 0, 0, 0].map((offset) => offset - 100);
  /** @type {SampleRef[]} */
  const samples = [];
  let previousChunk = -1;
  let offset = 0;
  sizes.forEach((size, index) => {
    const chunk = chunkOf[index] ?? 0;
    if (chunk !== previousChunk) offset = offsets[chunk] ?? 0;
    previousChunk = chunk;
    samples.push({
      dts: dts[index] ?? 0,
      cts: cts[index] ?? 0,
      size,
      sync: index === 0 || index === 5,
      data: { file: name, offset },
    });
    offset += size;
  });
  return samples;
}

test("collectMp4 (progressive): stsz/stz2, stco/co64, ctts v0/v1, stss, stsc, elst", async () => {
  /** @type {HandBuiltOptions[]} */
  const variants = [
    {},
    { sizes: 4 },
    { sizes: 8, co64: true },
    { sizes: 16, cttsVersion: 0 },
    { co64: true, moovFirst: true },
    { sizes: 4, cttsVersion: 0, moovFirst: true },
  ];
  for (const variant of variants) {
    const { bytes, offsets } = handBuilt(variant);
    const plans = await collectMp4(memoryFile("hand.mp4", bytes));
    assert.equal(plans.length, 1, JSON.stringify(variant));
    const [plan] = plans;
    assert.ok(plan);
    assert.equal(plan.kind, "video");
    assert.equal(plan.timescale, 1000);
    assert.equal(plan.width, 64);
    assert.equal(plan.height, 48);
    assert.equal(plan.language, "eng");
    assert.deepEqual(plan.samples, handBuiltSamples("hand.mp4", offsets), JSON.stringify(variant));
    for (const sample of plan.samples) {
      const first = bytes[sample.data.offset];
      assert.equal(first, plan.samples.indexOf(sample), "every reference points at its own bytes");
    }
  }
});

test("collectMp4 (progressive): broken tables are refused with what is wrong", async () => {
  const { bytes } = handBuilt();
  /**
   * The hand-built file with the box of `type` replaced, read by `collectMp4`.
   * @param {string} type
   * @param {...Uint8Array} words the full box's payload after version and flags
   */
  const swapped = (type, ...words) => {
    const replacement = words.length === 0 ? new Uint8Array(0) : fullBox(type, 0, 0, ...words);
    const data = rewrite(bytes, (found) => (found.type === type ? replacement : undefined));
    return collectMp4(memoryFile("hand.mp4", data));
  };
  const stz2 = fullBox("stz2", 0, 0, u24(0), u8(12), u32(10));
  const withStz2 = rewrite(bytes, (found) => (found.type === "stsz" ? stz2 : undefined));
  const encv = box("encv", new Uint8Array(78));
  const twoEntries = [u32(2), visualEntry(1, 1), visualEntry(2, 2)];
  const cases = /** @type {[Promise<unknown>, string, RegExp][]} */ ([
    [swapped("stts", u32(1), u32(9), u32(100)), "invalid", /stts covers 9 of 10/],
    [swapped("stts", u32(1), u32(11), u32(100)), "invalid", /stts covers more samples/],
    [swapped("stsc", u32(1), u32(1), u32(2), u32(1)), "invalid", /chunks hold 8 of 10/],
    [swapped("stsc", u32(2), u32(3), u32(3), u32(1), u32(1), u32(2), u32(1)), "invalid", /order/],
    [swapped("stco", u32(4), u32(9), u32(9), u32(9), u32(bytes.length)), "truncated", /past the/],
    [collectMp4(memoryFile("hand.mp4", withStz2)), "invalid", /field size of 12/],
    [swapped("stsz", u32(0), u32(10), u32(1)), "truncated", /stsz is cut short/],
    [swapped("stsd", u32(1), encv), "encrypted", /encv sample entry/],
    [swapped("stsd", ...twoEntries), "unsupported", /2 sample descriptions/],
    [swapped("stsz"), "invalid", /no stsz or stz2/],
    [swapped("stts"), "invalid", /no stts/],
    [swapped("stsc"), "invalid", /no stsc/],
    [swapped("stco"), "invalid", /no stco or co64/],
  ]);
  for (const [action, code, pattern] of cases) await rejectsWith(action, code, pattern);
  const text = latin1("not an mp4 at all, just text");
  await rejectsWith(collectMp4(memoryFile("junk.bin", text)), "invalid");
  const ftypOnly = box("ftyp", str4("isom"));
  await rejectsWith(collectMp4(memoryFile("empty.mp4", ftypOnly)), "invalid", /no moov/);
  const cut = bytes.subarray(0, bytes.length - 5);
  await rejectsWith(collectMp4(memoryFile("cut.mp4", cut)), "truncated");
});

// -------------------------------------------------------------------------------- media tests

// with STREAMFETCH_REQUIRE_TOOLS=1 a missing ffmpeg fails these proofs instead of skipping them
const MEDIA = TOOLS || REQUIRE_TOOLS ? {} : { skip: SKIP_MESSAGE };

test("media tools: ffmpeg and ffprobe are installed (STREAMFETCH_REQUIRE_TOOLS=1)", (t) => {
  if (TOOLS) return;
  if (REQUIRE_TOOLS) assert.fail(SKIP_MESSAGE);
  t.skip(SKIP_MESSAGE);
});

test("parseInit: DASH and HLS inits — ids, kinds, stsd, sizes, trex, edits", MEDIA, async () => {
  const media = fixtures();
  const video = parseInit(media.bytes("video.m4s"));
  assert.equal(video.movieTimescale, 1000);
  assert.equal(video.fragmented, true);
  assert.equal(video.encrypted, false);
  const [track] = video.tracks;
  assert.ok(track);
  assert.equal(track.id, 1);
  assert.equal(track.kind, "video");
  assert.equal(track.handler, "vide");
  assert.equal(track.timescale, 12800);
  assert.equal(track.sampleEntryType, "avc1");
  assert.equal(track.sampleEntryCount, 1);
  assert.equal(track.width, 320);
  assert.equal(track.height, 180);
  assert.equal(track.language, "und");
  assert.deepEqual(track.trex, {
    defaultSampleDescriptionIndex: 1,
    defaultSampleDuration: 0,
    defaultSampleSize: 0,
    defaultSampleFlags: 0,
  });
  assert.deepEqual(track.edit, { emptyDuration: 0, mediaTime: 0 });
  const stsd = findBox(media.bytes("video.m4s"), "moov/trak/mdia/minf/stbl/stsd");
  assert.ok(stsd);
  assert.deepEqual(track.stsd, media.bytes("video.m4s").slice(stsd.start, stsd.end));

  const [audio] = parseInit(media.bytes("audio.m4s")).tracks;
  assert.ok(audio);
  assert.equal(audio.kind, "audio");
  assert.equal(audio.sampleEntryType, "mp4a");
  assert.equal(audio.sampleRate, 48000);
  assert.equal(audio.channelCount, 1);
  assert.equal(audio.width, null);

  const [edited] = parseInit(media.bytes("audio-edit.m4s")).tracks;
  assert.deepEqual(edited?.edit, { emptyDuration: 0, mediaTime: 1024 });

  const hls = parseInit(media.bytes("hls.m4s"));
  assert.deepEqual(
    hls.tracks.map((info) => [info.id, info.kind, info.edit.emptyDuration, info.edit.mediaTime]),
    [
      [1, "video", 21, 0],
      [2, "audio", 0, 0],
    ],
  );

  // The first bytes of a download (init + the start of a fragment) are enough.
  const head = media.bytes("video.m4s").subarray(0, 1200);
  assert.equal(parseInit(head).tracks[0]?.width, 320);
  const cutInit = media.bytes("video.m4s").subarray(0, 300);
  await rejectsWith(() => parseInit(cutInit), "truncated", /moov/);
  await rejectsWith(() => parseInit(box("ftyp", str4("isom"))), "invalid", /no moov/);
});

test("drmProblem: encv/enca/pssh/senc are named; clean files and mdat words are not", MEDIA, () => {
  const media = fixtures();
  const clean = media.bytes("video.m4s");
  assert.equal(drmProblem(clean), null);
  assert.equal(drmProblem(media.bytes("src.mp4")), null);
  const encv = renameSampleEntry(clean, "avc1", "encv");
  assert.equal(drmProblem(encv), "encv sample entry");
  assert.equal(drmProblem(concat(encv, psshBox())), "encv sample entry, pssh box");
  assert.equal(drmProblem(withMoovPssh(clean)), "pssh box");
  const enca = renameSampleEntry(media.bytes("audio.m4s"), "mp4a", "enca");
  assert.equal(drmProblem(enca), "enca sample entry");
  const senc = moof(concat(tfhd(TFHD.DEFAULT_BASE_IS_MOOF, 1), fullBox("senc", 0, 0, u32(0))));
  const firstMoof = readBoxes(clean).find((found) => found.type === "moof");
  assert.ok(firstMoof);
  assert.equal(drmProblem(concat(clean.subarray(0, firstMoof.start), senc)), "senc box");
  // The bytes alone mean nothing: inside an mdat they are samples, not boxes.
  assert.equal(drmProblem(withDrmWordsInMdat(clean)), null);
  // The first bytes of the encrypted init are enough, and a cut never throws.
  assert.equal(drmProblem(encv.subarray(0, 500)), "encv sample entry");
  for (let length = 0; length <= 800; length += 7) drmProblem(encv.subarray(0, length));
});

test("drmProblem: never throws on junk", () => {
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed;
  };
  for (let round = 0; round < 300; round += 1) {
    const junk = new Uint8Array(next() % 300);
    for (let index = 0; index < junk.length; index += 1) junk[index] = next() & 0xff;
    if (round % 3 === 0 && junk.length >= 8) junk.set(str4(round % 2 === 0 ? "moov" : "moof"), 4);
    assert.doesNotThrow(() => drmProblem(junk));
  }
  assert.equal(drmProblem(/** @type {Uint8Array} */ (/** @type {unknown} */ ("moov"))), null);
  assert.equal(drmProblem(concat(u32(0xffffffff), str4("moov"))), null);
  assert.equal(drmProblem(concat(u32(1), str4("moov"), u64(2n ** 63n))), null);
});

test("encrypted media: flagged by parseInit and probe, refused by the readers", MEDIA, async () => {
  const media = fixtures();
  const encrypted = concat(renameSampleEntry(media.bytes("video.m4s"), "avc1", "encv"), psshBox());
  assert.equal(parseInit(encrypted).encrypted, true);
  assert.equal(parseInit(encrypted).tracks[0]?.encrypted, true);
  const encFile = memoryFile("enc.m4s", encrypted);
  await rejectsWith(collectFmp4(encFile), "encrypted", /encv sample entry/);
  await rejectsWith(collectMp4(memoryFile("enc.m4s", encrypted)), "encrypted", /encv/);
  // A pssh alone, at the top level after the media, is refused too (fragmented and progressive).
  const lonePssh = concat(media.bytes("video.m4s"), psshBox());
  await rejectsWith(collectFmp4(memoryFile("lone.m4s", lonePssh)), "encrypted", /^pssh box$/);
  const progressivePssh = concat(media.bytes("video-only.mp4"), psshBox());
  await rejectsWith(collectMp4(memoryFile("lone.mp4", progressivePssh)), "encrypted", /^pssh box$/);
  assert.equal((await probe(progressivePssh)).encrypted, true);
  assert.equal(drmProblem(media.bytes("video-only.mp4")), null);
  assert.ok(withDrmWordsInMdat(media.bytes("video.m4s")).length > 0);
  assert.deepEqual(
    (await collectFmp4(memoryFile("w.m4s", withDrmWordsInMdat(media.bytes("video.m4s"))))).map(
      (plan) => plan.samples.length,
    ),
    [150],
    "DRM words inside an mdat are not a refusal",
  );
  const pssh = withMoovPssh(media.bytes("audio.m4s"));
  await rejectsWith(collectFmp4(memoryFile("pssh.m4s", pssh)), "encrypted", /pssh box/);
  assert.equal((await probe(encrypted)).encrypted, true);
  assert.equal((await probe(memoryFile("pssh.m4s", pssh))).encrypted, true);
  assert.equal((await probe(media.bytes("video.m4s"))).encrypted, false);
});

test("collectFmp4: each DASH sample is ffprobe's packet (pts, size, pos, key)", MEDIA, async () => {
  const media = fixtures();
  for (const name of ["video.m4s", "audio.m4s", "audio-edit.m4s"]) {
    const plans = await collectFmp4(memoryFile(name, media.bytes(name)));
    assert.equal(plans.length, 1);
    const [plan] = plans;
    assert.ok(plan);
    assertMatchesPackets(plan, media.path(name), name.startsWith("video") ? "v" : "a");
    assert.ok(plan.samples.every((sample) => sample.data.file === name));
  }
  const [video] = await collectFmp4(memoryFile("video.m4s", media.bytes("video.m4s")));
  assert.equal(video?.samples.length, 150);
  assert.equal(video?.samples.filter((sample) => sample.sync).length, 6);
  const [edited] = await collectFmp4(memoryFile("a.m4s", media.bytes("audio-edit.m4s")));
  assert.equal(edited?.samples[0]?.cts, -1024, "the priming edit becomes a composition offset");
});

test("collectFmp4: fMP4 HLS, the video's empty edit becomes a delay", MEDIA, async () => {
  const media = fixtures();
  const plans = await collectFmp4(memoryFile("hls.m4s", media.bytes("hls.m4s")));
  assert.deepEqual(
    plans.map((plan) => [plan.kind, plan.samples.length, plan.samples[0]?.dts]),
    [
      ["video", 150, 269],
      ["audio", 283, 0],
    ],
  );
  const [video, audio] = plans;
  assert.ok(video && audio);
  assertMatchesPackets(video, media.path("hls.m4s"), "v");
  assertMatchesPackets(audio, media.path("hls.m4s"), "a");
});

test("collectFmp4: bounded windows, never an mdat payload", MEDIA, async () => {
  const media = fixtures();
  for (const name of ["video.m4s", "hls.m4s"]) {
    const bytes = media.bytes(name);
    const file = recordingFile(name, bytes);
    await collectFmp4(file);
    const metadata = readBoxes(bytes).filter((found) => ["moov", "moof"].includes(found.type));
    const largest = Math.max(...metadata.map((found) => found.size));
    const lengths = file.reads.map(([start, end]) => end - start);
    const longest = Math.max(...lengths);
    assert.ok(longest <= largest + BOX_HEADER_PEEK, `${name}: one read stays within a box`);
    const total = lengths.reduce((sum, length) => sum + length, 0);
    const mdat = readBoxes(bytes)
      .filter((found) => found.type === "mdat")
      .reduce((sum, found) => sum + found.size, 0);
    assert.ok(total < bytes.length - mdat + 64 * metadata.length, `${name}: ${total} bytes read`);
  }
});

test("collectFmp4: truncated, moof before moov, progressive input", MEDIA, async () => {
  const media = fixtures();
  const bytes = media.bytes("video.m4s");
  const boxes = readBoxes(bytes);
  const moov = boxes.find((found) => found.type === "moov");
  const first = boxes.find((found) => found.type === "moof");
  assert.ok(moov && first);
  const cut = (/** @type {number} */ length) => memoryFile("cut.m4s", bytes.subarray(0, length));
  await rejectsWith(collectFmp4(cut(bytes.length - 100)), "truncated", /past the end|ends inside/);
  const atMoof = new RegExp(`moof box at byte ${first.start}`);
  await rejectsWith(collectFmp4(cut(first.start + 100)), "truncated", atMoof);
  await rejectsWith(collectFmp4(cut(first.start + 4)), "truncated");
  const swapped = concat(
    bytes.slice(0, moov.start),
    bytes.slice(first.start, first.end),
    bytes.slice(moov.start, moov.end),
  );
  await rejectsWith(collectFmp4(memoryFile("odd.m4s", swapped)), "invalid", /moof before the moov/);
  const progressive = memoryFile("src.mp4", media.bytes("src.mp4"));
  await rejectsWith(collectFmp4(progressive), "invalid", /not a fragmented MP4/);
  const init = bytes.slice(0, first.start);
  assert.deepEqual(
    (await collectFmp4(memoryFile("init.mp4", init))).map((plan) => plan.samples.length),
    [0],
  );
});

test("collectMp4: progressive files (moov last, faststart, muxed) = ffprobe", MEDIA, async () => {
  const media = fixtures();
  for (const [name, kinds] of /** @type {[string, ("v" | "a")[]][]} */ ([
    ["src.mp4", ["v", "a"]],
    ["video-only.mp4", ["v"]],
    ["audio-only.mp4", ["a"]],
    ["video-faststart.mp4", ["v"]],
    ["audio-faststart.mp4", ["a"]],
  ])) {
    const plans = await collectMp4(memoryFile(name, media.bytes(name)));
    assert.deepEqual(
      plans.map((plan) => plan.kind),
      kinds.map((kind) => (kind === "v" ? "video" : "audio")),
      name,
    );
    plans.forEach((plan, index) => {
      assertMatchesPackets(plan, media.path(name), kinds[index] ?? "v");
    });
  }
  const [moovLast] = await collectMp4(memoryFile("x", media.bytes("audio-only.mp4")));
  const [moovFirst] = await collectMp4(memoryFile("x", media.bytes("audio-faststart.mp4")));
  /** @param {SampleRef} sample */
  const timing = (sample) => [sample.dts, sample.cts, sample.size, sample.sync];
  assert.deepEqual(moovLast?.samples.map(timing), moovFirst?.samples.map(timing));
  assert.equal(moovLast?.samples[0]?.cts, -1024, "the priming edit becomes a composition offset");
});

test("collectMp4: a fragmented file goes through collectFmp4", MEDIA, async () => {
  const media = fixtures();
  for (const name of ["video.m4s", "hls.m4s"]) {
    assert.deepEqual(
      await collectMp4(memoryFile(name, media.bytes(name))),
      await collectFmp4(memoryFile(name, media.bytes(name))),
    );
  }
});

test("collectMp4: stz2 and co64 written by hand read the same samples", MEDIA, async () => {
  const media = fixtures();
  const original = media.bytes("audio-only.mp4");
  const edited = rewrite(original, (found, data) => {
    const body = found.start + found.headerSize;
    if (found.type === "stsz") {
      const count = getU32(data, body + 8);
      const sizes = Array.from({ length: count }, (_, at) => getU32(data, body + 12 + 4 * at));
      return fullBox("stz2", 0, 0, u24(0), u8(16), u32(count), ...sizes.map((size) => u16(size)));
    }
    if (found.type === "stco") {
      const count = getU32(data, body + 4);
      const offsets = Array.from({ length: count }, (_, at) => getU32(data, body + 8 + 4 * at));
      return fullBox("co64", 0, 0, u32(count), ...offsets.map((offset) => u64(offset)));
    }
    return undefined;
  });
  assert.ok(findBox(edited, "moov/trak/mdia/minf/stbl/stz2"));
  assert.ok(findBox(edited, "moov/trak/mdia/minf/stbl/co64"));
  assert.equal(findBox(edited, "moov/trak/mdia/minf/stbl/stsz"), null);
  const path = media.write("audio-stz2-co64.mp4", edited);
  const reference = framemd5(media.path("audio-only.mp4"), "a");
  assert.deepEqual(framemd5(path, "a"), reference, "ffmpeg reads the hand-built boxes too");
  assert.deepEqual(
    await collectMp4(memoryFile("same.mp4", edited)),
    await collectMp4(memoryFile("same.mp4", original)),
  );
});

test("probe: layout, fragmented durations, truncation, Uint8Array input", MEDIA, async () => {
  const media = fixtures();
  const src = await probe(memoryFile("src.mp4", media.bytes("src.mp4")));
  assert.equal(src.progressive, false, "ffmpeg's default puts the moov after the mdat");
  assert.equal(src.fragmented, false);
  assert.equal(src.truncated, false);
  assert.deepEqual(
    src.tracks.map((track) => [
      track.id,
      track.kind,
      track.codec,
      track.timescale,
      track.sampleCount,
      track.durationS,
    ]),
    [
      [1, "video", "avc1", 12800, 150, 6],
      [2, "audio", "mp4a", 48000, 283, 6],
    ],
  );
  assert.equal(src.durationS, 6);
  const fast = await probe(media.bytes("video-faststart.mp4"));
  assert.equal(fast.progressive, true);
  assert.equal(fast.tracks.length, 1);
  const dash = await probe(memoryFile("audio.m4s", media.bytes("audio.m4s")));
  assert.equal(dash.progressive, false);
  assert.equal(dash.fragmented, true);
  assert.equal(dash.tracks[0]?.sampleCount, 283);
  const dashDuration = dash.tracks[0]?.durationS ?? 0;
  assert.ok(Math.abs(dashDuration - (283 * 1024) / 48000) < 0.03, "the trun durations");
  const edited = await probe(media.bytes("audio-edit.m4s"));
  assert.equal(edited.tracks[0]?.durationS, (289024 - 1024) / 48000);
  const hls = await probe(media.bytes("hls.m4s"));
  const hlsVideo = hls.tracks[0]?.durationS ?? 0;
  assert.ok(Math.abs(hlsVideo - 6.021) < 1e-9, "the video's empty edit counts");
  const bytes = media.bytes("video-faststart.mp4");
  const cut = await probe(bytes.subarray(0, bytes.length - 10));
  assert.equal(cut.truncated, true);
  assert.equal((await probe(concat(bytes, u32(9)))).truncated, true);
  const file = recordingFile("src.mp4", media.bytes("src.mp4"));
  await probe(file);
  assert.ok(
    file.reads.reduce((sum, [start, end]) => sum + end - start, 0) < 8000,
    "only headers and the moov are read",
  );
  await assert.rejects(probe(latin1("plain text, not a movie")), Mp4Error);
});

// ------------------------------------------------------------------- the iTunes metadata

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x01, 0x02, 0xff, 0xd9]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
/** The title ffmpeg is given below, with non-ASCII characters. */
const TITLE = "Ñandú 日本 🎬";

/**
 * An `ilst` item holding one `data` atom of `dataType`.
 * @param {string} type
 * @param {number} dataType
 * @param {Uint8Array} payload
 */
const item = (type, dataType, payload) => box(type, box("data", u32(dataType), u32(0), payload));
const MDIR = fullBox("hdlr", 0, 0, u32(0), str4("mdir"), str4("appl"), new Uint8Array(9));

/**
 * A `moov` holding only `udta` › `meta` › `hdlr` + `ilst` of `items`; `quickTime` leaves out the
 * meta's version and flags.
 * @param {Uint8Array[]} items
 * @param {boolean} [quickTime]
 */
function metaMoov(items, quickTime = false) {
  const ilst = box("ilst", ...items);
  const meta = quickTime ? box("meta", MDIR, ilst) : fullBox("meta", 0, 0, MDIR, ilst);
  return box("moov", box("udta", meta));
}

test("imageType: the JPEG and PNG signatures, nothing else", () => {
  assert.equal(imageType(JPEG), "jpeg");
  assert.equal(imageType(PNG), "png");
  assert.equal(imageType(JPEG.subarray(0, 2)), null, "cut short");
  assert.equal(imageType(PNG.subarray(0, 7)), null, "cut short");
  assert.equal(imageType(latin1("RIFF\0\0\0\0WEBPVP8 ")), null, "WebP is not embedded as is");
  assert.equal(imageType(latin1("<html>")), null);
  assert.equal(imageType(new Uint8Array(0)), null);
  assert.equal(imageType(/** @type {Uint8Array} */ (/** @type {unknown} */ ("jpeg"))), null);
});

test("readMetadata: ISO and QuickTime meta, UTF-8/UTF-16 titles, cover types", () => {
  assert.equal(TITLE_ITEM, "©nam");
  assert.equal(COVER_ITEM, "covr");
  assert.deepEqual(DATA_TYPE, { UTF8: 1, UTF16: 2, JPEG: 13, PNG: 14 });
  const title = new TextEncoder().encode(TITLE);
  const iso = metaMoov([item(TITLE_ITEM, 1, title), item(COVER_ITEM, 13, JPEG)]);
  assert.deepEqual(readMetadata(iso), { title: TITLE, cover: { type: "jpeg", bytes: JPEG } });
  // QuickTime's meta (no version and flags), a UTF-16 title and a cover of the implicit type 0.
  const utf16 = Uint8Array.from([0x00, 0xd1, 0x00, 0x75]);
  const quickTime = metaMoov([item(COVER_ITEM, 0, PNG), item(TITLE_ITEM, 2, utf16)], true);
  assert.deepEqual(readMetadata(quickTime), { title: "Ñu", cover: { type: "png", bytes: PNG } });
  assert.deepEqual(readMetadata(metaMoov([item(COVER_ITEM, 14, PNG)])).cover?.type, "png");
  const bmp = latin1("BM\0\0\0\0");
  assert.deepEqual(readMetadata(metaMoov([item(COVER_ITEM, 27, bmp)])).cover, {
    type: "other",
    bytes: bmp,
  });
  // The first item and the first data atom win; a binary title, an empty cover are no metadata.
  const twice = metaMoov([
    box(TITLE_ITEM, box("data", u32(1), u32(0), latin1("one")), box("data", u32(1), u32(0))),
    item(TITLE_ITEM, 1, latin1("two")),
  ]);
  assert.equal(readMetadata(twice).title, "one");
  const none = { title: null, cover: null };
  assert.deepEqual(readMetadata(metaMoov([item(TITLE_ITEM, 0, latin1("?"))])), none);
  assert.deepEqual(readMetadata(metaMoov([item(COVER_ITEM, 13, new Uint8Array(0))])), none);
  assert.deepEqual(readMetadata(metaMoov([box(TITLE_ITEM), box(COVER_ITEM)])), none);
  // The cover is a copy: the moov's bytes may be reused.
  const copied = readMetadata(iso).cover;
  iso.fill(0);
  assert.deepEqual(copied?.bytes, JPEG);
});

test("readMetadata: no udta, no meta, no ilst, cut or junk boxes → nulls, never a throw", () => {
  const none = { title: null, cover: null };
  const whole = metaMoov([item(TITLE_ITEM, 1, latin1("title")), item(COVER_ITEM, 13, JPEG)]);
  /** @type {Uint8Array[]} */
  const inputs = [
    new Uint8Array(0),
    latin1("plain text, not a movie"),
    box("moov", fullBox("mvhd", 0, 0, new Uint8Array(96))),
    box("moov", box("udta", box("©too", latin1("Lavf")))),
    box("moov", box("udta", fullBox("meta", 0, 0, MDIR))),
    box("moov", box("udta", fullBox("meta", 0, 0, MDIR, box("ilst", u32(99))))),
    box("free", box("udta")),
  ];
  for (const input of inputs) assert.deepEqual(readMetadata(input), none);
  for (let cut = 0; cut < whole.length; cut += 7) {
    assert.doesNotThrow(() => readMetadata(whole.subarray(0, cut)), `cut at ${cut}`);
  }
  const lying = whole.slice();
  new DataView(lying.buffer).setUint32(8, 0xfffffff0, false);
  assert.deepEqual(readMetadata(lying), none, "a udta that claims more bytes than the moov");
});

test("probe: the title and cover ffmpeg embeds (covr from an attached pic)", MEDIA, async () => {
  const media = fixtures();
  const src = await probe(media.bytes("src.mp4"));
  assert.equal(src.title, null, "ffmpeg's own ilst holds only ©too");
  assert.equal(src.cover, null);
  ffmpeg(...options("-f lavfi -i color=c=blue:s=96x54 -frames:v 1"), media.path("cover.png"));
  ffmpeg(
    ...["-i", media.path("video-faststart.mp4"), "-i", media.path("cover.png")],
    ...options("-map 0 -map 1 -c copy -disposition:v:1 attached_pic -movflags faststart"),
    ...["-metadata", `title=${TITLE}`, media.path("with-cover.mp4")],
  );
  const probed = await probe(memoryFile("with-cover.mp4", media.bytes("with-cover.mp4")));
  assert.equal(probed.title, TITLE);
  assert.equal(probed.cover?.type, "png");
  assert.deepEqual(probed.cover?.bytes, media.bytes("cover.png"));
  assert.equal(probed.progressive, true);
  assert.deepEqual(
    probed.tracks.map((track) => [track.kind, track.codec, track.sampleCount]),
    [["video", "avc1", 150]],
    "the cover is no track",
  );
});

// ------------------------------------------------------- every codec the sites serve

test("every codec the sites serve, fragmented and progressive: parseInit, collectMp4 and probe = ffprobe", MEDIA, async () => {
  for (const entry of Object.keys(SITE_CODECS)) {
    const fixture = codecFixture(entry);
    const { codec } = fixture;
    for (const layout of /** @type {const} */ (["fragmented", "progressive"])) {
      const path = fixture[layout];
      const bytes = new Uint8Array(readFileSync(path));
      const label = `${codec.what} (${entry}), ${layout}`;
      const [stream] = probeStreams(path).streams;
      assert.ok(stream, label);
      assert.deepEqual([stream.codec_name, stream.codec_tag_string], [codec.codecName, entry]);

      // the init: one track of the codec's sample entry, its configuration box, nothing encrypted
      const init = parseInit(bytes);
      assert.equal(init.fragmented, layout === "fragmented", label);
      assert.equal(init.encrypted, false, label);
      assert.equal(drmProblem(bytes), null, label);
      assert.equal(init.tracks.length, 1, label);
      const [track] = init.tracks;
      assert.ok(track);
      assert.deepEqual([track.kind, track.sampleEntryType, track.sampleEntryCount], [
        codec.kind,
        entry,
        1,
      ]);
      const stsd = findBox(bytes, "moov/trak/mdia/minf/stbl/stsd");
      assert.ok(stsd);
      assert.deepEqual(track.stsd, bytes.slice(stsd.start, stsd.end), `${label}: the stsd as is`);
      assert.ok(findPath(track.stsd, ["stsd", entry, codec.config]), `${label}: ${codec.config}`);
      if (codec.kind === "video") {
        assert.deepEqual([track.width, track.height], [stream.width, stream.height], label);
      } else {
        // a 96 kHz FLAC does not fit the entry's 16-bit rate: the timescale says it
        const audio = [track.sampleRate, track.channelCount];
        assert.deepEqual(audio, [stream.sample_rate, stream.channels], label);
      }

      // collectMp4: every sample is ffprobe's packet, and the last one keeps its duration
      const plans = await collectMp4(memoryFile(entry, bytes));
      assert.equal(plans.length, 1, label);
      const [plan] = plans;
      assert.ok(plan);
      assert.equal(plan.kind, codec.kind, `${label}: the downloader finds the ${codec.kind}`);
      const packets = ffprobePackets(path, codec.kind === "video" ? "v:0" : "a:0");
      assert.equal(plan.samples.length, packets.length, label);
      plan.samples.forEach((sample, index) => {
        const packet = packets[index];
        assert.ok(packet);
        assert.deepEqual(
          [sample.dts + sample.cts, sample.size, sample.data.offset],
          [packet.pts, packet.size, packet.pos],
          `${label}: sample ${index}`,
        );
        if (codec.kind === "video") assert.equal(sample.sync, packet.keyframe, `${label} ${index}`);
      });
      // the last sample's duration as the file states it (its stts or trun): what the tables'
      // total — ffprobe's duration without the edit list — leaves after the last decode time
      // (ffprobe's last PACKET duration is not that: ffmpeg re-times AC-3 frames from their size)
      const [tables] = probeStreams(path, { ignoreEditList: true }).streams;
      const span = (plan.samples.at(-1)?.dts ?? 0) - (plan.samples[0]?.dts ?? 0);
      const stated = (tables?.duration_ts ?? 0) - span;
      assert.ok(stated > 0, label);
      assert.equal(plan.lastDuration, stated, `${label}: the last sample's duration`);

      // probe: the codec, the samples and where ffprobe says the presentation ends
      const probed = await probe(memoryFile(entry, bytes));
      assert.equal(probed.fragmented, layout === "fragmented", label);
      assert.equal(probed.progressive, false, `${label}: ffmpeg writes the moov last`);
      assert.equal(probed.encrypted, false, label);
      assert.equal(probed.truncated, false, label);
      const [probedTrack] = probed.tracks;
      assert.ok(probedTrack);
      assert.deepEqual(
        [probedTrack.kind, probedTrack.codec, probedTrack.sampleCount],
        [codec.kind, entry, packets.length],
        label,
      );
      const end = (stream.start_time ?? 0) + (stream.duration ?? 0);
      assert.ok(
        Math.abs(probedTrack.durationS - end) < 0.002,
        `${label}: probe ${probedTrack.durationS} s, ffprobe ${end} s`,
      );
    }
  }
});

test("probe: a B-frame track's duration runs to the end of the last frame shown, as ffprobe's", MEDIA, async () => {
  // ffmpeg's progressive H.264 / HEVC with B-frames: ctts offsets and an edit from media_time
  // 1024 (two frames); the frames shown last are decoded before the last one — the presentation
  // ends 2 s after it starts, not 2 s − 1024 ticks
  for (const entry of ["avc1", "hvc1"]) {
    const { progressive } = codecFixture(entry);
    const bytes = new Uint8Array(readFileSync(progressive));
    const [track] = parseInit(bytes).tracks;
    assert.deepEqual(track?.edit, { emptyDuration: 0, mediaTime: 1024 }, entry);
    assert.ok(findBox(bytes, "moov/trak/mdia/minf/stbl/ctts"), `${entry} has composition offsets`);
    const probed = await probe(bytes);
    assert.equal(probed.tracks[0]?.durationS, 2, entry);
    assert.equal(probed.durationS, 2, entry);
    const [stream] = probeStreams(progressive).streams;
    assert.equal(stream?.duration, 2, `${entry}: ffprobe agrees`);
  }
});

// ------------------------------------------------------------------- samples against ffprobe

/**
 * Asserts that a plan's samples are ffprobe's packets: presentation time (`dts + cts`), size,
 * file position, key flag (video only: ffmpeg marks every AAC packet key).
 * @param {TrackPlan} plan
 * @param {string} path
 * @param {"v" | "a"} stream
 */
function assertMatchesPackets(plan, path, stream) {
  const expected = packets(path, stream);
  assert.equal(plan.samples.length, expected.length, `${path} ${stream}: sample count`);
  plan.samples.forEach((sample, index) => {
    const packet = expected[index];
    assert.ok(packet);
    assert.deepEqual(
      [sample.dts + sample.cts, sample.size, sample.data.offset],
      [packet.pts, packet.size, packet.pos],
      `${path} ${stream} sample ${index}`,
    );
    if (stream === "v") assert.equal(sample.sync, packet.key, `${path} sample ${index} key flag`);
  });
}

// ------------------------------------------------------------------------ encrypted variants

/**
 * `data` with its one sample entry of type `from` renamed `to`, in place (same size) — what
 * Common Encryption does to a protected track's entry (`avc1` → `encv`, `mp4a` → `enca`).
 * @param {Uint8Array} data
 * @param {string} from
 * @param {string} to
 */
function renameSampleEntry(data, from, to) {
  const stsd = findBox(data, "moov/trak/mdia/minf/stbl/stsd");
  assert.ok(stsd);
  const entry = childBoxes(data, stsd).find((found) => found.type === from);
  assert.ok(entry, `a ${from} entry`);
  const out = data.slice();
  out.set(str4(to), entry.start + 4);
  return out;
}

/** A valid version-0 `pssh` box (Widevine's system id, a test payload). @param {number} [size] */
function psshBox(size) {
  const systemId = new Uint8Array(
    "edef8ba979d64acea3c827dcd51d21ed".match(/../g)?.map((pair) => parseInt(pair, 16)) ?? [],
  );
  const payload =
    size === undefined ? latin1("streamfetch test key id") : new Uint8Array(size - 32);
  return fullBox("pssh", 0, 0, systemId, u32(payload.length), payload);
}

/**
 * `data` with the `moov`'s `udta` replaced by a `pssh` box of the same size: no offset moves.
 * @param {Uint8Array} data
 */
function withMoovPssh(data) {
  const udta = findBox(data, "moov/udta");
  assert.ok(udta);
  const pssh = psshBox(udta.size);
  assert.equal(pssh.length, udta.size);
  return concat(data.subarray(0, udta.start), pssh, data.subarray(udta.end));
}

/**
 * `data` with its last `mdat` grown by bytes that spell `encv`, `enca` and a `pssh` box after
 * its last sample — samples, not boxes; what follows (an `mfra`) points at earlier boxes only.
 * @param {Uint8Array} data
 */
function withDrmWordsInMdat(data) {
  const last = readBoxes(data).filter((found) => found.type === "mdat").at(-1);
  assert.ok(last);
  const words = concat(box("encv", new Uint8Array(8)), box("enca", new Uint8Array(8)), psshBox());
  const out = concat(data.subarray(0, last.end), words, data.subarray(last.end));
  out.set(u32(last.size + words.length), last.start);
  return out;
}

// ------------------------------------------- media helpers (private copy until helpers/media.js)

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string, error?: Error }} SpawnResult
 * @typedef {{ spawnSync(command: string, args: readonly string[],
 *   options: { encoding: "utf8", maxBuffer?: number }): SpawnResult }} ChildProcessModule
 * @typedef {{ mkdirSync(path: string, options: { recursive: boolean }): unknown }} FsExtras
 * @typedef {{ env: Record<string, string | undefined>,
 *   getBuiltinModule(id: string): unknown }} NodeProcess
 * @typedef {{ codec_type: string, codec_name: string, duration?: string,
 *   start_time?: string }} ProbeStream
 * @typedef {{ pts: number, size: string, pos: string, flags: string }} ProbePacket
 */

/** @param {string} name */
function hasTool(name) {
  const result = CHILD.spawnSync(name, ["-version"], { encoding: "utf8" });
  return result.error === undefined && result.status === 0;
}

/**
 * Runs a tool, returns its stdout; a failure throws with its stderr.
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
function run(command, args) {
  const options = { encoding: /** @type {"utf8"} */ ("utf8"), maxBuffer: 256 * 1024 * 1024 };
  const result = CHILD.spawnSync(command, args, options);
  if (result.error !== undefined || result.status !== 0) {
    const reason = result.stderr || String(result.error);
    throw new Error(`${command} ${args.join(" ")} failed: ${reason}`);
  }
  return result.stdout;
}

/**
 * Options written as one space-separated string (no value of theirs has a space).
 * @param {string} text
 * @returns {string[]}
 */
function options(text) {
  return text.split(" ").filter((word) => word !== "");
}

/** @param {...string} args */
function ffmpeg(...args) {
  return run("ffmpeg", [...options("-hide_banner -loglevel error -y"), ...args]);
}

/**
 * ffprobe's streams (type, codec, duration, start time) and format duration.
 * @param {string} path
 * @returns {{ streams: ProbeStream[], format: { duration?: string } }}
 */
function ffprobe(path) {
  const entries = "stream=codec_type,codec_name,duration,start_time:format=duration";
  const text = run("ffprobe", [...options("-v error -of json -show_entries"), entries, path]);
  return /** @type {{ streams: ProbeStream[], format: { duration?: string } }} */ (
    JSON.parse(text)
  );
}

/**
 * The hash column of `ffmpeg -f framemd5` for the first video (`v`) or audio (`a`) stream.
 * @param {string} path
 * @param {"v" | "a"} stream
 * @returns {string[]}
 */
function framemd5(path, stream) {
  const args = ["-i", path, "-map", `0:${stream}:0`, ...options("-f framemd5 -")];
  return run("ffmpeg", [...options("-hide_banner -loglevel error"), ...args])
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => (line.split(",").at(-1) ?? "").trim());
}

/**
 * `ffprobe -show_packets` of the first video or audio stream: pts, size, position, key flag.
 * @param {string} path
 * @param {"v" | "a"} stream
 * @returns {{ pts: number, size: number, pos: number, key: boolean }[]}
 */
function packets(path, stream) {
  const args = ["-select_streams", `${stream}:0`, "-show_entries", "packet=pts,size,pos,flags"];
  const text = run("ffprobe", [...options("-v error -of json"), ...args, path]);
  const json = /** @type {{ packets: ProbePacket[] }} */ (JSON.parse(text));
  return json.packets.map((packet) => ({
    pts: packet.pts,
    size: Number(packet.size),
    pos: Number(packet.pos),
    key: packet.flags.startsWith("K"),
  }));
}

/**
 * @typedef {{ path(name: string): string, bytes(name: string): Uint8Array,
 *   write(name: string, data: Uint8Array): string }} Fixtures
 */

/** @type {Fixtures | null} */
let built = null;

/**
 * The fixtures, built once per process: the spec's source clip, DASH pair (`makeDash`, with
 * `-f mp4`: ffmpeg cannot guess a format from `.m4s`) and fMP4 HLS (`makeHlsFmp4`, init and
 * segments concatenated into `hls.m4s`), plus a DASH audio that keeps the AAC priming edit
 * (`delay_moov` + `-use_editlist 1`) and progressive one-track files (moov last / faststart).
 * @returns {Fixtures}
 */
function fixtures() {
  if (built !== null) return built;
  const dir = FIXTURE_DIR;
  FS.mkdirSync(`${dir}hls`, { recursive: true });
  /** @param {string} name */
  const path = (name) => `${dir}${name}`;
  const src = path("src.mp4");
  ffmpeg(
    ...options("-f lavfi -i testsrc=size=320x180:rate=25"),
    ...options("-f lavfi -i sine=frequency=440:sample_rate=48000"),
    ...options("-t 6 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 25"),
    ...options("-c:a aac -b:a 64k -shortest"),
    src,
  );
  const fragments = "-movflags frag_keyframe+empty_moov+default_base_moof";
  const fragmented = options(`${fragments} -frag_duration 1000000 -f mp4`);
  ffmpeg("-i", src, ...options("-an -c:v copy"), ...fragmented, path("video.m4s"));
  ffmpeg("-i", src, ...options("-vn -c:a copy"), ...fragmented, path("audio.m4s"));
  ffmpeg(
    ...["-i", src, ...options("-vn -c:a copy"), ...options(`${fragments}+delay_moov`)],
    ...options("-use_editlist 1 -frag_duration 1000000 -f mp4"),
    path("audio-edit.m4s"),
  );
  ffmpeg(
    ...["-i", src, ...options("-c copy -f hls -hls_time 2 -hls_playlist_type vod")],
    ...options("-hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4"),
    ...["-hls_segment_filename", path("hls/seg%03d.m4s"), path("hls/media.m3u8")],
  );
  const playlist = readFileSync(path("hls/media.m3u8"), "utf8").split("\n");
  const segments = playlist.map((line) => line.trim()).filter((line) => /^[^#]/.test(line));
  const parts = ["init.mp4", ...segments].map((name) => readFileSync(path(`hls/${name}`)));
  writeFileSync(path("hls.m4s"), concat(...parts.map((part) => new Uint8Array(part))));
  ffmpeg("-i", src, ...options("-an -c:v copy"), path("video-only.mp4"));
  ffmpeg("-i", src, ...options("-vn -c:a copy"), path("audio-only.mp4"));
  ffmpeg("-i", src, ...options("-an -c:v copy -movflags faststart"), path("video-faststart.mp4"));
  ffmpeg("-i", src, ...options("-vn -c:a copy -movflags faststart"), path("audio-faststart.mp4"));
  /** @type {Map<string, Uint8Array>} */
  const cache = new Map();
  built = {
    path,
    bytes: (name) => {
      let data = cache.get(name);
      if (data === undefined) {
        data = new Uint8Array(readFileSync(path(name)));
        cache.set(name, data);
      }
      return data;
    },
    write: (name, data) => {
      writeFileSync(path(name), data);
      return path(name);
    },
  };
  return built;
}
