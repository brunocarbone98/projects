// @ts-check
/**
 * Unit tests of `src/lib/remux.js`, the progressive MP4 writer: DASH pairs, the fMP4 HLS stream
 * and progressive one-track files (`mp4.collectFmp4` / `mp4.collectMp4`) written to one MP4 that
 * ffprobe reads with one h264 and one aac stream, framemd5-equal to the source, `moov` before
 * `mdat`, no `moof`; the edit rules (a later start, negative composition offsets); chunk
 * interleaving checked against `ffprobe -show_packets`; `co64` and the largesize `mdat` header
 * on a synthetic plan past 4 GiB; the refusals; the embedded title and cover (`moov/udta/meta`:
 * the boxes byte for byte, the 5 MiB cover limit, ffprobe's attached picture and title tag, the
 * audio and video framemd5 and the sample bytes unchanged by the metadata); every codec the
 * sites serve (`helpers/media.js` `SITE_CODECS`) from fragmented and from progressive inputs,
 * with and without the cover and title: the codecs and durations ffprobe reads, both streams
 * decoded framemd5-equal to the input's, every sample's bytes and timing kept, `probe` and the
 * downloader's verification satisfied.
 *
 * The ffmpeg helpers at the bottom are a private copy (the shared `tests/helpers/media.js` is
 * written in parallel); fixtures are built once per process under `fixtures/generated/remux/`.
 * Without ffmpeg/ffprobe the media tests are skipped with `ffmpeg not found: media tests not run`;
 * with `STREAMFETCH_REQUIRE_TOOLS=1` that is a failure.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import {
  Mp4Error,
  TFHD,
  TRUN,
  box,
  childBoxes,
  collectFmp4,
  collectMp4,
  concat,
  findBox,
  fullBox,
  i32,
  memoryFile,
  parseInit,
  probe,
  readBoxes,
  str4,
  u32,
  u64,
} from "../src/lib/mp4.js";
import {
  DEFAULT_CHUNK_S,
  MAX_COVER_BYTES,
  MAX_READ_BYTES,
  coverProblem,
  metadataUdta,
  planMoov,
  writeProgressiveMp4,
} from "../src/lib/remux.js";
import { TsDemuxer, tracksFromDemux } from "../src/lib/ts.js";
import { WRITER_TOLERANCE_S, durationMatches, mediaGap } from "../src/app/downloader.js";
import {
  CODEC_SECONDS,
  SITE_CODECS,
  codecFixture,
  ffprobe as probeStreams,
  framemd5 as decodedFrames,
  md5Hex,
} from "./helpers/media.js";

const NODE = /** @type {NodeProcess} */ (Reflect.get(globalThis, "process"));
const CHILD = /** @type {ChildProcessModule} */ (NODE.getBuiltinModule("node:child_process"));
const FS = /** @type {FsExtras} */ (NODE.getBuiltinModule("node:fs"));
const SKIP_MESSAGE = "ffmpeg not found: media tests not run";
const REQUIRE_TOOLS = NODE.env["STREAMFETCH_REQUIRE_TOOLS"] === "1";
const TOOLS = hasTool("ffmpeg") && hasTool("ffprobe");
const FIXTURE_URL = new URL("./fixtures/generated/remux/", import.meta.url);
const FIXTURE_DIR = decodeURIComponent(FIXTURE_URL.pathname);
// with STREAMFETCH_REQUIRE_TOOLS=1 a missing ffmpeg fails these proofs instead of skipping them
const MEDIA = TOOLS || REQUIRE_TOOLS ? {} : { skip: SKIP_MESSAGE };

/** @typedef {import("../src/lib/mp4.js").TrackPlan} TrackPlan */
/** @typedef {import("../src/lib/mp4.js").SampleRef} SampleRef */
/** @typedef {import("../src/lib/mp4.js").Box} Box */
/** @typedef {import("../src/lib/remux.js").MoovPlan} MoovPlan */
/** @typedef {import("../src/lib/remux.js").Mp4Meta} Mp4Meta */

// ---------------------------------------------------------------------------------- helpers

/**
 * @param {Uint8Array} bytes
 * @param {number} at
 */
const getU32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
/**
 * @param {Uint8Array} bytes
 * @param {number} at
 */
const getI32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getInt32(at);
/**
 * @param {Uint8Array} bytes
 * @param {number} at
 */
const getU64 = (bytes, at) => Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(at));

/**
 * Writes `plans` into memory: the output bytes, the writer's result and every `read` call.
 * @param {TrackPlan[]} plans
 * @param {Map<string, Uint8Array>} sources
 * @param {{ chunkS?: number, meta?: Mp4Meta }} [opts]
 */
async function writeToMemory(plans, sources, opts) {
  /** @type {Uint8Array[]} */
  const parts = [];
  /** @type {{ file: string, offset: number, size: number }[]} */
  const reads = [];
  const result = await writeProgressiveMp4(
    plans,
    async (ref, size) => {
      reads.push({ file: ref.file, offset: ref.offset, size });
      const source = sources.get(ref.file);
      assert.ok(source, `a source named ${ref.file}`);
      return source.slice(ref.offset, ref.offset + size);
    },
    {
      write: async (bytes) => {
        parts.push(bytes);
      },
    },
    opts,
  );
  return { out: concat(...parts), result, reads, writes: parts.length };
}

/**
 * The plans of the named fixture files (each through `collectMp4`) and the sources map.
 * @param {Fixtures} media
 * @param {string[]} names
 */
async function plansOf(media, names) {
  /** @type {Map<string, Uint8Array>} */
  const sources = new Map();
  /** @type {TrackPlan[]} */
  const plans = [];
  for (const name of names) {
    sources.set(name, media.bytes(name));
    plans.push(...(await collectMp4(memoryFile(name, media.bytes(name)))));
  }
  return { plans, sources };
}

/**
 * The sample-table boxes of the `index`-th trak of a written file, by type.
 * @param {Uint8Array} out
 * @param {number} index
 * @returns {Map<string, Box>}
 */
function tablesOf(out, index) {
  const moov = findBox(out, "moov");
  assert.ok(moov);
  const trak = childBoxes(out, moov).filter((found) => found.type === "trak")[index];
  assert.ok(trak, `trak ${index}`);
  /** @type {Map<string, Box>} */
  const tables = new Map();
  const stbl = findBox(out, "mdia/minf/stbl", trak.start + trak.headerSize, trak.end);
  assert.ok(stbl);
  for (const child of childBoxes(out, stbl)) tables.set(child.type, child);
  const elst = findBox(out, "edts/elst", trak.start + trak.headerSize, trak.end);
  if (elst !== null) tables.set("elst", elst);
  const tkhd = findBox(out, "tkhd", trak.start + trak.headerSize, trak.end);
  if (tkhd !== null) tables.set("tkhd", tkhd);
  return tables;
}

/**
 * The 32-bit words after a full box's version/flags (entry count first).
 * @param {Uint8Array} out
 * @param {Box | undefined} found
 * @returns {number[]}
 */
function words(out, found) {
  assert.ok(found);
  /** @type {number[]} */
  const values = [];
  for (let at = found.start + 12; at + 4 <= found.end; at += 4) values.push(getU32(out, at));
  return values;
}

/**
 * The entries of an `elst` as `[segment_duration, media_time]` pairs (version 0).
 * @param {Uint8Array} out
 * @param {Box | undefined} elst
 * @returns {[number, number][]}
 */
function editsOf(out, elst) {
  assert.ok(elst);
  assert.equal(out[elst.start + 8], 0, "elst version 0");
  const count = getU32(out, elst.start + 12);
  /** @type {[number, number][]} */
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const at = elst.start + 16 + 12 * index;
    entries.push([getU32(out, at), getI32(out, at + 4)]);
  }
  return entries;
}

/**
 * The absolute position of every sample of every track in the written file, from the plan.
 * @param {MoovPlan} plan
 * @returns {number[][]}
 */
function samplePositions(plan) {
  /** @type {number[][]} */
  const positions = plan.plans.map(() => []);
  for (const chunk of plan.order) {
    const samples = plan.plans[chunk.track]?.samples ?? [];
    let at = chunk.offset;
    for (let index = chunk.first; index < chunk.first + chunk.count; index += 1) {
      positions[chunk.track]?.push(at);
      at += samples[index]?.size ?? 0;
    }
  }
  return positions;
}

/**
 * A minimal `stsd` with one sample entry of `type` (no codec configuration: enough to plan).
 * @param {string} type
 * @param {number} [width]
 * @param {number} [height]
 */
function stubStsd(type, width = 0, height = 0) {
  const body = new Uint8Array(type === "mp4a" ? 28 : 78);
  const view = new DataView(body.buffer);
  view.setUint16(6, 1);
  if (type !== "mp4a") {
    view.setUint16(24, width);
    view.setUint16(26, height);
  }
  return fullBox("stsd", 0, 0, u32(1), box(type, body));
}

/**
 * A synthetic plan: `count` samples of `size` bytes, one every `step` ticks, all sync.
 * @param {"video" | "audio"} kind
 * @param {{ count?: number, size?: number, step?: number, timescale?: number, start?: number,
 *   file?: string, entry?: string }} [options]
 * @returns {TrackPlan}
 */
function syntheticPlan(kind, options = {}) {
  const { count = 3, size = 10, step = 1000, timescale = 1000, start = 0 } = options;
  const file = options.file ?? `${kind}.bin`;
  return {
    kind,
    timescale,
    stsd: stubStsd(options.entry ?? (kind === "video" ? "avc1" : "mp4a"), 64, 36),
    width: kind === "video" ? 64 : null,
    height: kind === "video" ? 36 : null,
    sampleRate: kind === "audio" ? timescale : null,
    channelCount: kind === "audio" ? 2 : null,
    language: "und",
    samples: Array.from({ length: count }, (_, index) => ({
      dts: start + index * step,
      cts: 0,
      size,
      sync: true,
      data: { file, offset: index * size },
    })),
  };
}

/**
 * Asserts that `action` throws (or rejects with) an `Mp4Error` of `code` matching `pattern`.
 * @param {(() => unknown) | Promise<unknown>} action
 * @param {string} code
 * @param {RegExp} pattern
 */
async function refuses(action, code, pattern) {
  /** @param {unknown} error */
  const check = (error) =>
    error instanceof Mp4Error && error.code === code && pattern.test(error.message);
  if (typeof action === "function") assert.throws(() => action(), check);
  else await assert.rejects(action, check);
}

/**
 * The checks every written file passes: the byte count, `ftyp` + `moov` + `mdat` with no `moof`,
 * ffprobe's one h264 and one aac stream with durations within 0.05 s of the source's, and
 * `probe` saying progressive with the writer's tracks.
 * @param {Fixtures} media
 * @param {Uint8Array} out
 * @param {{ bytes: number, durationS: number,
 *   tracks: { kind: string, samples: number, durationS: number }[] }} result
 * @param {string} path the written file
 */
async function assertProgressive(media, out, result, path) {
  assert.equal(result.bytes, out.length, "the writer returns the exact byte count");
  assert.deepEqual(
    readBoxes(out).map((found) => found.type),
    ["ftyp", "moov", "mdat"],
    "moov before mdat, no moof",
  );
  const written = ffprobe(path);
  const source = ffprobe(media.path("src.mp4"));
  assert.deepEqual(
    written.streams.map((stream) => [stream.codec_type, stream.codec_name]),
    [
      ["video", "h264"],
      ["audio", "aac"],
    ],
  );
  written.streams.forEach((stream, index) => {
    const reference = source.streams[index];
    assert.ok(reference);
    assert.ok(
      Math.abs(Number(stream.duration) - Number(reference.duration)) < 0.05,
      `${stream.codec_type} duration ${stream.duration} vs ${reference.duration}`,
    );
  });
  assert.ok(Math.abs(Number(written.format.duration) - Number(source.format.duration)) < 0.05);
  const probed = await probe(out);
  assert.equal(probed.progressive, true);
  assert.equal(probed.fragmented, false);
  assert.equal(probed.encrypted, false);
  assert.equal(probed.truncated, false);
  assert.deepEqual(
    probed.tracks.map((track) => [track.kind, track.sampleCount]),
    result.tracks.map((track) => [track.kind, track.samples]),
  );
  probed.tracks.forEach((track, index) => {
    assert.ok(Math.abs(track.durationS - (result.tracks[index]?.durationS ?? 0)) < 0.002);
  });
}

// ------------------------------------------------------------------------- the media tests

test("media tools: ffmpeg and ffprobe are installed (STREAMFETCH_REQUIRE_TOOLS=1)", (t) => {
  if (TOOLS) return;
  if (REQUIRE_TOOLS) assert.fail(SKIP_MESSAGE);
  t.skip(SKIP_MESSAGE);
});

test("DASH video.m4s + audio.m4s → one progressive MP4, lossless", MEDIA, async () => {
  const media = fixtures();
  const { plans, sources } = await plansOf(media, ["video.m4s", "audio.m4s"]);
  const { out, result } = await writeToMemory(plans, sources);
  const path = media.write("out-dash.mp4", out);
  await assertProgressive(media, out, result, path);
  assert.deepEqual(framemd5(path, "v"), framemd5(media.path("src.mp4"), "v"));
  // ffmpeg's fragmented audio carries no AAC priming edit: the writer keeps what it was given
  // (every frame of audio.m4s) — the source's frames after the one priming frame.
  const audio = framemd5(path, "a");
  assert.deepEqual(audio, framemd5(media.path("audio.m4s"), "a"));
  assert.deepEqual(audio.slice(1), framemd5(media.path("src.mp4"), "a"));
  assert.deepEqual(
    result.tracks.map((track) => [track.kind, track.samples]),
    [
      ["video", 150],
      ["audio", 283],
    ],
  );
});

test("DASH audio keeping the AAC priming edit → framemd5 = src.mp4", MEDIA, async () => {
  const media = fixtures();
  const { plans, sources } = await plansOf(media, ["video.m4s", "audio-edit.m4s"]);
  const { out, result } = await writeToMemory(plans, sources);
  const path = media.write("out-dash-edit.mp4", out);
  await assertProgressive(media, out, result, path);
  assert.deepEqual(framemd5(path, "v"), framemd5(media.path("src.mp4"), "v"));
  assert.deepEqual(framemd5(path, "a"), framemd5(media.path("src.mp4"), "a"));
  // src.mp4's own audio edit: 6000 ms from media_time 1024 — the last AAC frame keeps the 256
  // ticks the source gives it (its trun's `lastDuration`), not the 1024 of the frame before
  assert.deepEqual(editsOf(out, tablesOf(out, 1).get("elst")), [[6000, 1024]]);
  const src = media.bytes("src.mp4");
  assert.deepEqual(editsOf(src, tablesOf(src, 1).get("elst")), [[6000, 1024]]);
  assert.equal(tablesOf(out, 1).get("ctts"), undefined, "every offset is 0 after the shift");
});

test("fMP4 HLS (init + segments) → progressive MP4, video starts at 21 ms", MEDIA, async () => {
  const media = fixtures();
  const { plans, sources } = await plansOf(media, ["hls.m4s"]);
  const { out, result } = await writeToMemory(plans, sources);
  const path = media.write("out-hls.mp4", out);
  await assertProgressive(media, out, result, path);
  assert.deepEqual(framemd5(path, "v"), framemd5(media.path("src.mp4"), "v"));
  assert.deepEqual(framemd5(path, "a"), framemd5(media.path("hls.m4s"), "a"));
  assert.deepEqual(framemd5(path, "a").slice(1), framemd5(media.path("src.mp4"), "a"));
  const starts = ffprobe(path).streams.map((stream) => Number(stream.start_time));
  assert.ok(Math.abs((starts[0] ?? 0) - 0.021) < 0.001, `video start ${starts[0]}`);
  assert.equal(starts[1], 0);
  assert.deepEqual(editsOf(out, tablesOf(out, 0).get("elst")), [
    [21, -1],
    [6000, 0],
  ]);
});

test("progressive inputs (moov last, faststart, muxed) → framemd5 = src.mp4", MEDIA, async () => {
  const media = fixtures();
  const inputs = [
    ["video-only.mp4", "audio-only.mp4"],
    ["video-faststart.mp4", "audio-faststart.mp4"],
    ["src.mp4"],
  ];
  for (const names of inputs) {
    const { plans, sources } = await plansOf(media, names);
    const { out, result } = await writeToMemory(plans, sources);
    const path = media.write(`out-${names[0]}`, out);
    await assertProgressive(media, out, result, path);
    assert.deepEqual(framemd5(path, "v"), framemd5(media.path("src.mp4"), "v"), names.join(" + "));
    assert.deepEqual(framemd5(path, "a"), framemd5(media.path("src.mp4"), "a"), names.join(" + "));
  }
});

test("a track whose first tfdt is later gets an empty edit (start_time)", MEDIA, async () => {
  const media = fixtures();
  const late = shiftTfdt(media.bytes("audio.m4s"), 24000);
  const path = media.write("audio-late.m4s", late);
  const sources = new Map([
    ["video.m4s", media.bytes("video.m4s")],
    ["audio-late.m4s", late],
  ]);
  const plans = [
    ...(await collectFmp4(memoryFile("video.m4s", media.bytes("video.m4s")))),
    ...(await collectFmp4(memoryFile("audio-late.m4s", late))),
  ];
  assert.equal(plans[1]?.samples[0]?.dts, 24000);
  const { out, result } = await writeToMemory(plans, sources);
  const outPath = media.write("out-late.mp4", out);
  const streams = ffprobe(outPath).streams;
  assert.equal(Number(streams[0]?.start_time), 0);
  const audioStart = Number(streams[1]?.start_time);
  assert.ok(Math.abs(audioStart - 0.5) < 0.001, `audio start ${audioStart}`);
  // 6021 ms: 282 frames of 1024 ticks and the last one's 256 at 48 kHz, as audio.m4s says
  assert.deepEqual(editsOf(out, tablesOf(out, 1).get("elst")), [
    [500, -1],
    [6021, 0],
  ]);
  assert.equal(tablesOf(out, 0).get("elst"), undefined, "the earliest track needs no edit");
  assert.equal(result.durationS, 6.521);
  assert.deepEqual(framemd5(outPath, "a"), framemd5(path, "a"));
  assert.deepEqual(framemd5(outPath, "v"), framemd5(media.path("src.mp4"), "v"));
});

test("negative composition offsets → ctts v0 shifted + elst media_time", MEDIA, async () => {
  const media = fixtures();
  const init = media.bytes("video.m4s");
  const firstMoof = readBoxes(init).find((found) => found.type === "moof");
  assert.ok(firstMoof);
  const samples = [-1024, 512, -512, 0];
  const TFHD_FLAGS =
    TFHD.DEFAULT_BASE_IS_MOOF | TFHD.DEFAULT_SAMPLE_DURATION | TFHD.DEFAULT_SAMPLE_SIZE;
  /** @param {number} dataOffset */
  const fragment = (dataOffset) =>
    box(
      "moof",
      fullBox("mfhd", 0, 0, u32(1)),
      box(
        "traf",
        fullBox("tfhd", 0, TFHD_FLAGS, u32(1), u32(512), u32(10)),
        fullBox("tfdt", 1, 0, u64(0)),
        fullBox(
          "trun",
          1,
          TRUN.DATA_OFFSET | TRUN.SAMPLE_COMPOSITION_TIME_OFFSET,
          u32(samples.length),
          i32(dataOffset),
          ...samples.map((cts) => i32(cts)),
        ),
      ),
    );
  const size = fragment(0).length;
  const mdat = box("mdat", new Uint8Array(40).fill(7));
  const data = concat(init.slice(0, firstMoof.start), fragment(size + 8), mdat);
  const plans = await collectFmp4(memoryFile("neg.m4s", data));
  assert.deepEqual(
    plans[0]?.samples.map((sample) => [
      sample.dts,
      sample.cts,
      sample.data.offset - firstMoof.start,
    ]),
    [
      [0, -1024, size + 8],
      [512, 512, size + 18],
      [1024, -512, size + 28],
      [1536, 0, size + 38],
    ],
  );
  const plan = planMoov(plans);
  const out = concat(plan.ftyp, plan.moov);
  const tables = tablesOf(out, 0);
  const ctts = tables.get("ctts");
  assert.ok(ctts);
  assert.equal(out[ctts.start + 8], 0, "ctts version 0");
  assert.deepEqual(words(out, ctts), [4, 1, 0, 1, 1536, 1, 512, 1, 1024]);
  // presented until the last sample SHOWN ends: dts 1536 + cts 0 + 512 = 2048 ticks = 160 ms
  // (the media duration minus the shift, 80 ms, would cut the last two samples off)
  assert.deepEqual(editsOf(out, tables.get("elst")), [[160, 1024]]);
  assert.deepEqual(words(out, tables.get("stts")), [1, 4, 512]);
  assert.equal(plan.tracks[0]?.durationS, 0.16);
});

test("chunks interleave per second, checked against ffprobe positions", MEDIA, async () => {
  const media = fixtures();
  const { plans, sources } = await plansOf(media, ["video.m4s", "audio.m4s"]);
  const plan = planMoov(plans);
  assert.equal(DEFAULT_CHUNK_S, 1);
  const { out } = await writeToMemory(plans, sources);
  const path = media.write("out-interleave.mp4", out);
  const video = tablesOf(out, 0);
  const audio = tablesOf(out, 1);
  assert.deepEqual(words(out, video.get("stsc")), [1, 1, 25, 1]);
  assert.deepEqual(words(out, audio.get("stsc")), [2, 1, 47, 1, 7, 1, 1]);
  const videoOffsets = words(out, video.get("stco")).slice(1);
  const audioOffsets = words(out, audio.get("stco")).slice(1);
  assert.equal(videoOffsets.length, 6);
  assert.equal(audioOffsets.length, 7);
  const merged = [
    ...videoOffsets.map((offset) => ({ offset, kind: "v" })),
    ...audioOffsets.map((offset) => ({ offset, kind: "a" })),
  ].sort((left, right) => left.offset - right.offset);
  assert.equal(merged.map((chunk) => chunk.kind).join(""), "vavavavavavaa");
  assert.ok(
    plan.order.every(
      (chunk, index) => index === 0 || chunk.offset > (plan.order[index - 1]?.offset ?? 0),
    ),
  );
  assert.equal(plan.order[0]?.offset, plan.mdatOffset + plan.mdatHeader.length);
  assert.deepEqual(plan.order.map((chunk) => chunk.offset), merged.map((chunk) => chunk.offset));
  const positions = samplePositions(plan);
  for (const [index, stream] of /** @type {[number, "v" | "a"][]} */ ([[0, "v"], [1, "a"]])) {
    const expected = packets(path, stream);
    assert.deepEqual(
      expected.map((packet) => packet.pos),
      positions[index],
      `${stream}: ffprobe's packet positions are the planned ones`,
    );
    assert.deepEqual(
      expected.map((packet) => packet.size),
      plans[index]?.samples.map((sample) => sample.size),
    );
  }
  const twoSeconds = planMoov(plans, { chunkS: 2 });
  assert.equal(twoSeconds.order.filter((chunk) => chunk.track === 0).length, 3);
  const videoChunks = twoSeconds.order.filter((chunk) => chunk.track === 0);
  assert.ok(videoChunks.every((chunk) => chunk.count === 50));
});

test("sequential, coalesced reads; deterministic output", MEDIA, async () => {
  const media = fixtures();
  const { plans, sources } = await plansOf(media, ["video.m4s", "audio.m4s"]);
  const first = await writeToMemory(plans, sources);
  const second = await writeToMemory([...plans].reverse(), sources);
  assert.deepEqual(second.out, first.out, "the same bytes, whatever the input order");
  for (const name of ["video.m4s", "audio.m4s"]) {
    const reads = first.reads.filter((read) => read.file === name);
    const inOrder = reads.every(
      (read, index) => index === 0 || read.offset > (reads[index - 1]?.offset ?? 0),
    );
    assert.ok(inOrder, `${name} read in order`);
    assert.ok(reads.every((read) => read.size <= MAX_READ_BYTES));
  }
  const payload = first.reads.reduce((sum, read) => sum + read.size, 0);
  const plan = planMoov(plans);
  assert.equal(payload, plan.payloadBytes);
  assert.equal(first.out.length, plan.totalBytes);
  const samples = plans.reduce((sum, track) => sum + track.samples.length, 0);
  assert.ok(first.reads.length < samples / 5, `${first.reads.length} reads for ${samples} samples`);
});

// --------------------------------------------------------------------- synthetic plans (no ffmpeg)

test("co64 and the largesize mdat header past 2^32 (planned, never written)", async () => {
  const video = syntheticPlan("video", { count: 3, size: 0x7fffffff, step: 1000 });
  const audio = syntheticPlan("audio", { count: 3, size: 100, step: 1000 });
  const plan = planMoov([video, audio]);
  assert.equal(plan.co64, true);
  assert.equal(plan.payloadBytes, 3 * 0x7fffffff + 300);
  assert.equal(plan.mdatHeader.length, 16);
  assert.equal(getU32(plan.mdatHeader, 0), 1);
  assert.equal(String.fromCharCode(...plan.mdatHeader.subarray(4, 8)), "mdat");
  assert.equal(getU64(plan.mdatHeader, 8), 16 + plan.payloadBytes);
  assert.equal(plan.totalBytes, plan.mdatOffset + 16 + plan.payloadBytes);
  const moov = concat(plan.ftyp, plan.moov);
  for (const index of [0, 1]) {
    const tables = tablesOf(moov, index);
    assert.equal(tables.get("stco"), undefined);
    const co64 = tables.get("co64");
    assert.ok(co64);
    const count = getU32(moov, co64.start + 12);
    const offsets = Array.from({ length: count }, (_, entry) =>
      getU64(moov, co64.start + 16 + 8 * entry),
    );
    assert.deepEqual(
      offsets,
      plan.order.filter((chunk) => chunk.track === index).map((chunk) => chunk.offset),
    );
  }
  assert.ok(plan.order.some((chunk) => chunk.offset > 2 ** 32));
  assert.deepEqual(
    plan.order.map((chunk) => chunk.track),
    [0, 1, 0, 1, 0, 1],
  );
  // The writer decides the header before any sample: it writes the 16-byte one, then reads.
  /** @type {Uint8Array[]} */
  const written = [];
  const stop = new Error("stop before the first sample");
  await assert.rejects(
    writeProgressiveMp4(
      [video, audio],
      async () => {
        throw stop;
      },
      {
        write: async (bytes) => {
          written.push(bytes);
        },
      },
    ),
    (error) => error === stop,
  );
  assert.deepEqual(written, [plan.ftyp, plan.moov, plan.mdatHeader]);

  const small = planMoov([syntheticPlan("video"), syntheticPlan("audio")]);
  assert.equal(small.co64, false);
  assert.equal(small.mdatHeader.length, 8);
  assert.equal(getU32(small.mdatHeader, 0), 8 + 60);
  assert.ok(tablesOf(concat(small.ftyp, small.moov), 0).get("stco"));
});

test("the moov: ids, mvhd, tkhd, hdlr, language, stts, stss only when needed", async () => {
  const video = syntheticPlan("video", { count: 4, step: 3000, timescale: 90000 });
  /** @type {SampleRef} */ (video.samples[2]).sync = false;
  const audio = {
    ...syntheticPlan("audio", { count: 4, step: 1024, timescale: 48000 }),
    language: "spa",
  };
  const plan = planMoov([audio, video]);
  const out = concat(plan.ftyp, plan.moov);
  assert.deepEqual(
    readBoxes(plan.ftyp).map((found) => found.type),
    ["ftyp"],
  );
  assert.equal(String.fromCharCode(...plan.ftyp.subarray(8, 12)), "isom");
  assert.ok(String.fromCharCode(...plan.ftyp).includes("avc1"));
  const init = parseInit(out);
  assert.equal(init.movieTimescale, 1000);
  assert.deepEqual(
    init.tracks.map((track) => [
      track.id,
      track.kind,
      track.handler,
      track.timescale,
      track.language,
      track.width,
      track.height,
    ]),
    [
      [1, "video", "vide", 90000, "und", 64, 36],
      [2, "audio", "soun", 48000, "spa", null, null],
    ],
  );
  const videoTables = tablesOf(out, 0);
  const tkhd = videoTables.get("tkhd");
  assert.ok(tkhd);
  assert.equal(getU32(out, tkhd.start + 8) & 0xffffff, 3, "tkhd flags enabled + in movie");
  assert.equal(getU32(out, tkhd.start + 84), 64 * 0x10000);
  assert.equal(getU32(out, tkhd.start + 88), 36 * 0x10000);
  assert.deepEqual(words(out, videoTables.get("stss")), [3, 1, 2, 4]);
  assert.equal(tablesOf(out, 1).get("stss"), undefined, "audio has no stss");
  const stts = words(out, videoTables.get("stts"));
  assert.deepEqual(stts, [1, 4, 3000], "the last sample repeats the previous duration");
  assert.deepEqual(words(out, videoTables.get("stsz")), [0, 4, 10, 10, 10, 10]);
  assert.deepEqual(plan.tracks, [
    { kind: "video", samples: 4, durationS: 0.133 },
    { kind: "audio", samples: 4, durationS: 0.085 },
  ]);
  const probed = await probe(concat(out, plan.mdatHeader, new Uint8Array(plan.payloadBytes)));
  assert.equal(probed.progressive, true);
  const single = planMoov([syntheticPlan("video", { count: 1 })]);
  const lone = concat(single.ftyp, single.moov);
  assert.deepEqual(words(lone, tablesOf(lone, 0).get("stts")), [1, 1, 0]);
});

test("B-frames: the edit lasts until the last frame shown ends; the last duration as stated", async () => {
  // ffmpeg's progressive H.264/HEVC: ctts 1024, 2560, 1024, 0, 512 and an edit from 1024 — read
  // as these offsets; shown in the order 0, 3, 2, 4, 1, so the last frame SHOWN is the second
  const video = syntheticPlan("video", { count: 5, step: 512, timescale: 12800 });
  [0, 1536, 0, -1024, -512].forEach((cts, index) => {
    /** @type {SampleRef} */ (video.samples[index]).cts = cts;
  });
  const audio = { ...syntheticPlan("audio", { count: 4, step: 1024, timescale: 48000 }) };
  audio.lastDuration = 256;
  const plan = planMoov([video, audio]);
  const out = concat(plan.ftyp, plan.moov);
  // 5 frames of 40 ms from media_time 1024: 200 ms (the media duration minus the shift, 120 ms,
  // would cut the last two frames shown)
  assert.deepEqual(editsOf(out, tablesOf(out, 0).get("elst")), [[200, 1024]]);
  assert.deepEqual(words(out, tablesOf(out, 0).get("stts")), [1, 5, 512]);
  // the audio's last frame: 256 ticks, as its source said, not the 1024 of the one before
  assert.deepEqual(words(out, tablesOf(out, 1).get("stts")), [2, 3, 1024, 1, 256]);
  assert.deepEqual(plan.tracks, [
    { kind: "video", samples: 5, durationS: 0.2 },
    { kind: "audio", samples: 4, durationS: 0.069 },
  ]);
  const probed = await probe(concat(out, plan.mdatHeader, new Uint8Array(plan.payloadBytes)));
  assert.deepEqual(
    probed.tracks.map((track) => track.durationS),
    [0.2, (3 * 1024 + 256) / 48000],
    "probe reads the same presentation",
  );
  // without lastDuration the previous duration repeats (the MPEG-TS path)
  const untimed = syntheticPlan("audio", { count: 4, step: 1024, timescale: 48000 });
  const repeated = planMoov([video, untimed]);
  const plain = concat(repeated.ftyp, repeated.moov);
  assert.deepEqual(words(plain, tablesOf(plain, 1).get("stts")), [1, 4, 1024]);
  for (const bad of [0, -256, 1.5, 2 ** 32, Number.NaN]) {
    await refuses(
      () => planMoov([video, { ...audio, lastDuration: bad }]),
      "invalid",
      /last duration .* is not valid/,
    );
  }
});

test("TS-like starts: the earliest first dts is time zero, the later track gets a gap", () => {
  const video = syntheticPlan("video", { count: 50, step: 3600, timescale: 90000, start: 126000 });
  const audio = syntheticPlan("audio", {
    count: 50,
    step: 1024,
    timescale: 48000,
    start: 67200 + 4800,
  });
  const plan = planMoov([video, audio]);
  const out = concat(plan.ftyp, plan.moov);
  assert.equal(tablesOf(out, 0).get("elst"), undefined);
  assert.deepEqual(editsOf(out, tablesOf(out, 1).get("elst")), [
    [100, -1],
    [1067, 0],
  ]);
  assert.deepEqual(
    plan.order.slice(0, 4).map((chunk) => [chunk.track, chunk.count]),
    [
      [0, 25],
      [1, 43],
      [0, 25],
      [1, 7],
    ],
  );
});

test("MPEG-TS B-frames: the edit starts at the first frame shown, the earliest shown is zero", () => {
  // decode order I0 P3 B1 B2 P6 B4 B5 at 25 fps (3600 ticks of 90 kHz), as a TS stream with
  // B-frames carries it: every PTS at least its DTS, the first frame shown 40 ms after the first
  // decode time
  const video = syntheticPlan("video", { count: 7, step: 3600, timescale: 90000, start: 126000 });
  [3600, 10800, 0, 0, 10800, 0, 0].forEach((cts, index) => {
    /** @type {SampleRef} */ (video.samples[index]).cts = cts;
  });
  // the audio starts 100 ms before the video's first dts, so 140 ms before its first frame shown:
  // 140 ms of nothing, then the 7 frames (280 ms) from the first one shown (media_time 3600); an
  // edit from media_time 0 would show the picture 40 ms early in ffmpeg-based players
  const early = syntheticPlan("audio", { count: 10, step: 1024, timescale: 48000, start: 62400 });
  const first = planMoov([video, early]);
  const out = concat(first.ftyp, first.moov);
  assert.deepEqual(editsOf(out, tablesOf(out, 0).get("elst")), [
    [140, -1],
    [280, 3600],
  ]);
  assert.equal(tablesOf(out, 1).get("elst"), undefined, "the audio starts at time zero");
  // the audio starts with the first frame shown (after the video's first dts): nothing empty
  // before either track, the video's edit still from its first frame shown
  const level = syntheticPlan("audio", { count: 10, step: 1024, timescale: 48000, start: 69120 });
  const second = planMoov([video, level]);
  const both = concat(second.ftyp, second.moov);
  assert.deepEqual(editsOf(both, tablesOf(both, 0).get("elst")), [[280, 3600]]);
  assert.equal(tablesOf(both, 1).get("elst"), undefined);
  // the writer reports milliseconds: 7 frames of 40 ms, 10 AAC frames of 1024 at 48 kHz
  assert.deepEqual(
    second.tracks.map((track) => track.durationS),
    [0.28, 0.213],
  );
});

test("refusals: 3 tracks, audio-only, empty, two of a kind, broken samples, DRM", async () => {
  const video = syntheticPlan("video");
  const audio = syntheticPlan("audio");
  const sink = { write: async () => {} };
  const nothing = async () => new Uint8Array(0);
  await refuses(
    () => planMoov([video, audio, syntheticPlan("audio")]),
    "unsupported",
    /^3 tracks: StreamFetch writes one video track and at most one audio track$/,
  );
  await refuses(
    writeProgressiveMp4([audio], nothing, sink),
    "unsupported",
    /no video track: an audio-only input/,
  );
  await refuses(() => planMoov([]), "invalid", /no tracks/);
  await refuses(() => planMoov([video, syntheticPlan("video")]), "unsupported", /two video tracks/);
  const text = /** @type {"audio"} */ (/** @type {unknown} */ ("text"));
  await refuses(() => planMoov([video, { ...audio, kind: text }]), "invalid", /neither video nor/);
  await refuses(() => planMoov([{ ...video, samples: [] }]), "invalid", /video track has no samp/);
  const backwards = syntheticPlan("video");
  /** @type {SampleRef} */ (backwards.samples[2]).dts = 500;
  await refuses(() => planMoov([backwards]), "invalid", /decode times go backwards at sample 2/);
  const broken = syntheticPlan("video");
  /** @type {SampleRef} */ (broken.samples[1]).size = -1;
  await refuses(() => planMoov([broken]), "invalid", /video sample 1 is not a valid sample ref/);
  const fractional = syntheticPlan("audio");
  /** @type {SampleRef} */ (fractional.samples[0]).dts = 0.5;
  await refuses(() => planMoov([video, fractional]), "invalid", /audio sample 0/);
  const encv = { ...video, stsd: stubStsd("encv") };
  const enca = { ...audio, stsd: stubStsd("enca") };
  await refuses(() => planMoov([encv]), "encrypted", /^encv sample entry$/);
  await refuses(() => planMoov([video, enca]), "encrypted", /^enca sample entry$/);
  await refuses(() => planMoov([{ ...video, stsd: box("free") }]), "invalid", /not one stsd box/);
  await refuses(() => planMoov([{ ...video, timescale: 0 }]), "invalid", /timescale 0/);
  for (const chunkS of [0, -1, Number.NaN, Infinity]) {
    await refuses(() => planMoov([video], { chunkS }), "invalid", /chunkS must be a positive/);
  }
});

test("the writer refuses a short read and counts every byte it writes", async () => {
  const video = syntheticPlan("video", { count: 4, size: 25, step: 100 });
  const source = new Uint8Array(100).map((_, index) => index);
  await refuses(
    writeProgressiveMp4(
      [video],
      async (ref, size) => source.slice(ref.offset, ref.offset + size - 1),
      { write: async () => {} },
    ),
    "truncated",
    /a read of 100 bytes at byte 0 of video.bin returned 99/,
  );
  let counted = 0;
  const result = await writeProgressiveMp4(
    [video],
    async (ref, size) => source.slice(ref.offset, ref.offset + size),
    {
      write: async (bytes) => {
        counted += bytes.length;
      },
    },
  );
  const plan = planMoov([video]);
  assert.equal(result.bytes, counted);
  assert.equal(result.bytes, plan.totalBytes);
  assert.equal(result.durationS, 0.4);
  assert.equal(plan.order.length, 1, "four contiguous samples in one chunk, read in one call");
  const sources = new Map([["video.bin", source]]);
  const { out } = await writeToMemory([video], sources);
  const tail = out.subarray(out.length - 100);
  assert.deepEqual(tail, source, "the samples, byte for byte, after the mdat header");
});

// ------------------------------------------------------------- the cover and the title (B.2)

/** A title with non-ASCII characters: Latin-1, CJK and an astral-plane emoji. */
const TITLE = "Ñandú 日本 🎬";
/** {@link TITLE} in UTF-8, written out by hand (19 bytes). */
const TITLE_UTF8 = [
  0xc3, 0x91, 0x61, 0x6e, 0x64, 0xc3, 0xba, 0x20, 0xe6, 0x97, 0xa5, 0xe6, 0x9c, 0xac, 0x20, 0xf0,
  0x9f, 0x8e, 0xac,
];
/** The smallest "JPEG" the signature check accepts: SOI, an APP0 marker, two bytes, EOI. */
const TINY_JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9];
const TINY_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00];

/** @param {string} text ASCII, or "©" (0xA9) @returns {number[]} */
const chars = (text) => Array.from(text, (char) => char.charCodeAt(0));

/**
 * A meta of any shape, for the refusals.
 * @param {unknown} value
 * @returns {Mp4Meta}
 */
const looseMeta = (value) => /** @type {Mp4Meta} */ (value);

test("meta: udta › meta › hdlr mdir › ilst ©nam + covr, byte for byte", () => {
  const cover = { bytes: Uint8Array.from(TINY_JPEG), type: /** @type {const} */ ("jpeg") };
  const udta = metadataUdta({ title: TITLE, cover });
  const expected = [
    ...[0, 0, 0, 136, ...chars("udta")],
    ...[0, 0, 0, 128, ...chars("meta"), 0, 0, 0, 0], // full box: version 0, flags 0
    ...[0, 0, 0, 33, ...chars("hdlr"), 0, 0, 0, 0], // full box
    ...[0, 0, 0, 0, ...chars("mdir"), ...chars("appl"), 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ...[0, 0, 0, 83, ...chars("ilst")],
    ...[0, 0, 0, 43, ...chars("©nam")],
    ...[0, 0, 0, 35, ...chars("data"), 0, 0, 0, 1, 0, 0, 0, 0, ...TITLE_UTF8], // type 1: UTF-8
    ...[0, 0, 0, 32, ...chars("covr")],
    ...[0, 0, 0, 24, ...chars("data"), 0, 0, 0, 13, 0, 0, 0, 0, ...TINY_JPEG], // type 13: JPEG
  ];
  assert.deepEqual(udta, Uint8Array.from(expected));

  const png = metadataUdta({ cover: { bytes: Uint8Array.from(TINY_PNG), type: "png" } });
  assert.ok(png);
  assert.deepEqual(
    png.subarray(png.length - 33),
    Uint8Array.from([
      ...[0, 0, 0, 33, ...chars("covr")],
      ...[0, 0, 0, 25, ...chars("data"), 0, 0, 0, 14, 0, 0, 0, 0, ...TINY_PNG], // type 14: PNG
    ]),
  );
  assert.deepEqual(readBoxes(png).map((found) => [found.type, found.size]), [["udta", 94]]);

  const titleOnly = metadataUdta({ title: TITLE });
  assert.ok(titleOnly);
  assert.equal(titleOnly.length, 136 - 32, "no covr without a cover");
  assert.equal(metadataUdta(undefined), null);
  assert.equal(metadataUdta({}), null, "nothing to write: no udta");
  assert.equal(metadataUdta({ title: "" }), null, "an empty title is not written");
});

test("meta: the udta ends the moov, every chunk offset moves by its size", async () => {
  const video = syntheticPlan("video", { count: 30, step: 100 });
  const audio = syntheticPlan("audio", { count: 30, step: 100 });
  const cover = { bytes: Uint8Array.from(TINY_JPEG), type: /** @type {const} */ ("jpeg") };
  const meta = { title: TITLE, cover };
  const plain = planMoov([video, audio]);
  const plan = planMoov([video, audio], { meta });
  const udta = metadataUdta(meta);
  assert.ok(udta);
  assert.equal(plain.udtaBytes, 0);
  assert.equal(plan.udtaBytes, udta.length);
  assert.equal(plan.moov.length, plain.moov.length + udta.length);
  assert.deepEqual(plan.moov.subarray(plan.moov.length - udta.length), udta);
  const moovBox = readBoxes(plan.moov)[0];
  assert.ok(moovBox);
  assert.deepEqual(
    childBoxes(plan.moov, moovBox).map((found) => found.type),
    ["mvhd", "trak", "trak", "udta"],
  );
  assert.equal(plan.mdatOffset, plain.mdatOffset + udta.length);
  assert.equal(plan.totalBytes, plain.totalBytes + udta.length);
  assert.deepEqual(
    plan.order.map((chunk) => chunk.offset),
    plain.order.map((chunk) => chunk.offset + udta.length),
  );
  const out = concat(plan.ftyp, plan.moov);
  for (const index of [0, 1]) {
    assert.deepEqual(
      words(out, tablesOf(out, index).get("stco")).slice(1),
      plan.order.filter((chunk) => chunk.track === index).map((chunk) => chunk.offset),
      "the stco points past the udta",
    );
  }
  const probed = await probe(concat(out, plan.mdatHeader, new Uint8Array(plan.payloadBytes)));
  assert.equal(probed.progressive, true);
  assert.equal(probed.title, TITLE);
  assert.deepEqual(probed.cover, { type: "jpeg", bytes: Uint8Array.from(TINY_JPEG) });
  const bare = await probe(concat(plain.ftyp, plain.moov, plain.mdatHeader));
  assert.equal(bare.title, null);
  assert.equal(bare.cover, null);
  const empty = planMoov([video, audio], { meta: { title: "" } });
  assert.deepEqual(empty.moov, plain.moov, "no metadata, the very same moov");
});

test("meta refusals: a cover over 5 MiB, not JPEG/PNG, wrong bytes, before any write", async () => {
  const video = syntheticPlan("video");
  /** @type {Uint8Array[]} */
  const written = [];
  const sink = {
    write: async (/** @type {Uint8Array} */ bytes) => {
      written.push(bytes);
    },
  };
  const read = async (/** @type {{ offset: number }} */ _ref, /** @type {number} */ size) =>
    new Uint8Array(size);
  assert.equal(MAX_COVER_BYTES, 5 * 1024 * 1024);
  const limit = new Uint8Array(MAX_COVER_BYTES);
  limit.set(TINY_JPEG);
  const atLimit = planMoov([video], { meta: { cover: { bytes: limit, type: "jpeg" } } });
  assert.equal(atLimit.udtaBytes, MAX_COVER_BYTES + 85, "exactly 5 MiB is embedded");
  const over = new Uint8Array(MAX_COVER_BYTES + 1);
  over.set(TINY_JPEG);
  const tooBig = { cover: { bytes: over, type: /** @type {const} */ ("jpeg") } };
  const overLimit = /^the cover is 5242881 bytes, over the 5 MiB limit \(5242880 bytes\)$/;
  await refuses(() => planMoov([video], { meta: tooBig }), "unsupported", overLimit);
  const writing = writeProgressiveMp4([video], read, sink, { meta: tooBig });
  await refuses(writing, "unsupported", overLimit);
  assert.equal(written.length, 0, "nothing reaches the sink");
  assert.match(coverProblem(tooBig.cover) ?? "", overLimit);

  const jpeg = Uint8Array.from(TINY_JPEG);
  const notJpegOrPng = /^the cover type must be "jpeg" or "png", not /;
  /** @type {[unknown, RegExp][]} */
  const refused = [
    [{ bytes: jpeg, type: "webp" }, new RegExp(`${notJpegOrPng.source}"webp"$`)],
    [{ bytes: jpeg }, new RegExp(`${notJpegOrPng.source}undefined$`)],
    [{ bytes: jpeg, type: "png" }, /^the cover is not a PNG image \(its bytes are a JPEG image\)$/],
    [{ bytes: latin1Bytes("<html>"), type: "jpeg" }, /^the cover is not a JPEG image$/],
    [{ bytes: new Uint8Array(0), type: "jpeg" }, /^the cover is empty$/],
    [{ bytes: [0xff, 0xd8, 0xff], type: "jpeg" }, /^the cover has no bytes$/],
    ["cover.jpg", /^the cover is not \{ bytes, type \}$/],
  ];
  for (const [cover, pattern] of refused) {
    await refuses(() => planMoov([video], { meta: looseMeta({ cover }) }), "invalid", pattern);
    assert.match(coverProblem(cover) ?? "", pattern);
  }
  const badTitle = looseMeta({ title: 42 });
  await refuses(() => planMoov([video], { meta: badTitle }), "invalid", /^the title must be a/);
  await refuses(() => planMoov([video], { meta: looseMeta("x") }), "invalid", /must be an object/);
  assert.equal(coverProblem({ bytes: jpeg, type: "jpeg" }), null);
  assert.equal(coverProblem({ bytes: Uint8Array.from(TINY_PNG), type: "png" }), null);
  assert.equal(written.length, 0);
});

test("MPEG-TS with B-frames, the audio first → the source's A/V offset, every frame", MEDIA, async () => {
  const media = fixtures();
  const tsPath = media.path("bframes-audio-first.mpegts");
  // libx264's default B-frames (the first frame is shown after its decode time) and the audio
  // 100 ms ahead of the video, the case where an edit from media_time 0 showed the picture early
  ffmpeg(
    ...options("-itsoffset 0.1 -f lavfi -i testsrc=size=320x180:rate=30"),
    ...options("-f lavfi -i sine=frequency=440:sample_rate=48000"),
    ...options("-t 4 -map 0:v -map 1:a -c:v libx264 -preset medium -g 30 -pix_fmt yuv420p"),
    ...options("-c:a aac -b:a 64k -f mpegts"),
    tsPath,
  );
  /** @type {Record<string, Uint8Array[]>} */
  const parts = { video: [], audio: [] };
  /** @type {Record<string, number>} */
  const sizes = { video: 0, audio: 0 };
  const collector = tracksFromDemux(
    (kind, bytes) => {
      const offset = sizes[kind] ?? 0;
      sizes[kind] = offset + bytes.length;
      parts[kind]?.push(bytes);
      return { file: kind, offset };
    },
    (code) => assert.fail(`the demuxer met ${code}`),
  );
  const demuxer = new TsDemuxer(collector.hooks);
  demuxer.push(new Uint8Array(readFileSync(tsPath)));
  demuxer.flush();
  const plans = collector.plans();
  const sources = new Map(Object.entries(parts).map(([kind, list]) => [kind, concat(...list)]));
  const video = plans.find((plan) => plan.kind === "video");
  assert.ok(video && video.samples.some((sample) => sample.cts > 0), "the source has B-frames");
  const { out } = await writeToMemory(plans, sources);
  const outPath = media.write("bframes-audio-first.mp4", out);
  /** @param {string} path */
  const starts = (path) => {
    const streams = ffprobe(path).streams;
    const of = (/** @type {string} */ type) =>
      Number(streams.find((stream) => stream.codec_type === type)?.start_time);
    return { video: of("video"), audio: of("audio") };
  };
  const source = starts(tsPath);
  const saved = starts(outPath);
  const sourceOffset = source.video - source.audio;
  const savedOffset = saved.video - saved.audio;
  assert.ok(sourceOffset > 0.1, `the source's picture starts ${sourceOffset} s after its sound`);
  assert.ok(
    Math.abs(savedOffset - sourceOffset) < 0.001,
    `picture after sound: ${savedOffset} s saved, ${sourceOffset} s in the source`,
  );
  assert.equal(Math.min(saved.video, saved.audio), 0, "nothing before the first sample shown");
  assert.deepEqual(framemd5(outPath, "v"), framemd5(tsPath, "v"), "every frame, in order");
});

test("cover + title embedded: ffprobe's attached pic and title; A/V untouched", MEDIA, async () => {
  const media = fixtures();
  const images = coverImages(media);
  const { plans, sources } = await plansOf(media, ["video.m4s", "audio.m4s"]);
  const plain = await writeToMemory(plans, sources);
  const plainPath = media.write("out-plain.mp4", plain.out);
  const plainPlan = planMoov(plans);
  const plainSamples = await collectMp4(memoryFile("plain.mp4", plain.out));
  const plainProbe = await probe(plain.out);
  const reference = { v: framemd5(plainPath, "v"), a: framemd5(plainPath, "a") };
  assert.deepEqual(reference.v, framemd5(media.path("src.mp4"), "v"));
  for (const [type, codec] of /** @type {const} */ ([["jpeg", "mjpeg"], ["png", "png"]])) {
    const cover = { bytes: images[type], type };
    const meta = { title: TITLE, cover };
    const written = await writeToMemory(plans, sources, { meta });
    const path = media.write(`out-meta-${type}.mp4`, written.out);
    const plan = planMoov(plans, { meta });

    // What ffprobe reads: h264, aac, then the cover as an attached picture; the title tag.
    const info = ffprobeAll(path);
    assert.deepEqual(
      info.streams.map((stream) => [
        stream.codec_type,
        stream.codec_name,
        stream.disposition?.attached_pic,
      ]),
      [
        ["video", "h264", 0],
        ["audio", "aac", 0],
        ["video", codec, 1],
      ],
      type,
    );
    assert.equal(info.format.tags?.title, TITLE, "the title, non-ASCII characters intact");
    const duration = Number(info.format.duration);
    assert.ok(Math.abs(duration - Number(ffprobeAll(plainPath).format.duration)) < 0.001);

    // The audio and the video decode to the same frames as without meta.
    assert.deepEqual(framemd5(path, "v"), reference.v, `${type}: video framemd5`);
    assert.deepEqual(framemd5(path, "a"), reference.a, `${type}: audio framemd5`);

    // The sample data is the same bytes, read the same way; only the offsets moved.
    assert.equal(written.result.bytes, written.out.length);
    assert.equal(written.out.length, plain.out.length + plan.udtaBytes);
    const payload = (/** @type {Uint8Array} */ out, /** @type {MoovPlan} */ moovPlan) =>
      out.subarray(moovPlan.mdatOffset + moovPlan.mdatHeader.length);
    assert.deepEqual(payload(written.out, plan), payload(plain.out, plainPlan));
    assert.deepEqual(written.reads, plain.reads);
    const samples = await collectMp4(memoryFile("plain.mp4", written.out));
    /** @param {number} shift @returns {(track: TrackPlan) => SampleRef[]} */
    const moved = (shift) => (track) =>
      track.samples.map((sample) => ({
        ...sample,
        data: { file: sample.data.file, offset: sample.data.offset + shift },
      }));
    assert.deepEqual(
      samples.map(moved(0)),
      plainSamples.map(moved(plan.udtaBytes)),
      "every sample: the same dts, cts, size and sync; its offset moved by the udta",
    );

    // probe: still progressive with the same two tracks; it reads the title and the cover back.
    const probed = await probe(written.out);
    assert.equal(probed.progressive, true);
    assert.deepEqual(probed.tracks, plainProbe.tracks, "the cover is not a track");
    assert.equal(probed.title, TITLE);
    assert.equal(probed.cover?.type, type);
    assert.deepEqual(probed.cover?.bytes, images[type]);
  }
});

// ------------------------------------------------------- every codec the sites serve

/**
 * Video + audio pairs over every codec of `SITE_CODECS` (each written from its fragmented DASH
 * files and from its progressive files): HEVC as hvc1 and hev1, AV1 and H.264 with B-frames;
 * FLAC 24-bit 96 kHz, E-AC-3 5.1, AC-3, Opus and AAC.
 */
const CODEC_PAIRS = /** @type {const} */ ([
  ["hvc1", "fLaC"],
  ["hev1", "ec-3"],
  ["av01", "ac-3"],
  ["avc1", "Opus"],
  ["hvc1", "mp4a"],
]);

/**
 * What a written file holds, per track: each sample's timing and the MD5 of its bytes.
 * @param {TrackPlan[]} plans
 * @param {(file: string) => Uint8Array} bytesOf
 */
function sampleDigest(plans, bytesOf) {
  return plans.map((plan) => {
    const firstDts = plan.samples[0]?.dts ?? 0;
    return {
      kind: plan.kind,
      stsd: [...plan.stsd],
      lastDuration: plan.lastDuration,
      // each sample's decode time from the track's first and its presentation time: the writer's
      // edit starts at the first sample shown, which changes how a reader splits a presentation
      // time into dts and cts (an empty edit adds to the dts, media_time comes off the cts), never
      // the time itself
      samples: plan.samples.map((sample) => {
        const data = bytesOf(sample.data.file);
        const bytes = data.subarray(sample.data.offset, sample.data.offset + sample.size);
        const presented = sample.dts + sample.cts;
        return [sample.dts - firstDts, presented, sample.size, sample.sync, md5Hex(bytes)];
      }),
    };
  });
}

/**
 * Where a stream's presentation ends, by ffprobe: start time plus duration.
 * @param {import("./helpers/media.js").ProbedStream | undefined} stream
 */
const streamEnd = (stream) => (stream?.start_time ?? 0) + (stream?.duration ?? 0);

for (const [videoEntry, audioEntry] of CODEC_PAIRS) {
  for (const layout of /** @type {const} */ (["fragmented", "progressive"])) {
    const v = SITE_CODECS[videoEntry];
    const a = SITE_CODECS[audioEntry];
    const name = `${v?.what} + ${a?.what}, ${layout} → one progressive MP4, every sample kept`;
    test(name, MEDIA, async () => {
      assert.ok(v && a);
      const video = codecFixture(videoEntry);
      const audio = codecFixture(audioEntry);
      const inputs = [video[layout], audio[layout]];
      /** @type {Map<string, Uint8Array>} */
      const sources = new Map();
      /** @type {TrackPlan[]} */
      const plans = [];
      for (const input of inputs) {
        const bytes = new Uint8Array(readFileSync(input));
        sources.set(input, bytes);
        plans.push(...(await collectMp4(memoryFile(input, bytes))));
      }
      const sourceBytes = (/** @type {string} */ file) => sources.get(file) ?? new Uint8Array(0);

      // the downloader's checks before the writer: a video and an audio track (the audio the
      // source announced is there), no hole in either
      assert.deepEqual(
        plans.map((plan) => plan.kind),
        ["video", "audio"],
      );
      for (const plan of plans) assert.equal(mediaGap(plan, false), null, `${plan.kind}: no hole`);

      const images = coverImages(fixtures());
      const cover = { bytes: images.jpeg, type: /** @type {const} */ ("jpeg") };
      const meta = { title: TITLE, cover };
      const plain = await writeToMemory(plans, sources);
      const withMeta = await writeToMemory(plans, sources, { meta });
      const tag = `${videoEntry}-${audioEntry}-${layout}`;
      const plainPath = fixtures().write(`codec-${tag}.mp4`, plain.out);
      const metaPath = fixtures().write(`codec-${tag}-meta.mp4`, withMeta.out);

      // ffmpeg applies an edit's leading cut (the encoder delay) to a progressive file only: a
      // fragmented input with one (AC-3, E-AC-3 behind delay_moov) decodes its first frame whole,
      // the written file — like the codec's progressive source — without the delay
      /** @param {import("./helpers/media.js").CodecFixture} fixture @param {number} index */
      const reference = (fixture, index) => {
        const edit = parseInit(sourceBytes(inputs[index] ?? "")).tracks[0]?.edit;
        return layout === "fragmented" && (edit?.mediaTime ?? 0) !== 0
          ? fixture.progressive
          : fixture[layout];
      };
      const expected = {
        v: decodedFrames(reference(video, 0), { stream: "v:0" }),
        a: decodedFrames(reference(audio, 1), { stream: "a:0" }),
      };
      assert.ok(expected.v.length >= 50 && expected.a.length > 20, "frames decoded");
      const inputStreams = inputs.map((input) => probeStreams(input).streams[0]);

      for (const [out, path, result, label] of /** @type {const} */ ([
        [plain.out, plainPath, plain.result, "plain"],
        [withMeta.out, metaPath, withMeta.result, "with cover and title"],
      ])) {
        assert.equal(result.bytes, out.length, label);
        assert.deepEqual(
          readBoxes(out).map((found) => found.type),
          ["ftyp", "moov", "mdat"],
          `${label}: moov before mdat, no moof`,
        );

        // ffprobe: the codecs and tags as served, each stream ending where the input's ends
        const info = probeStreams(path);
        assert.deepEqual(
          info.streams.slice(0, 2).map((s) => [s.codec_type, s.codec_name, s.codec_tag_string]),
          [
            ["video", v.codecName, videoEntry],
            ["audio", a.codecName, audioEntry],
          ],
          label,
        );
        info.streams.slice(0, 2).forEach((stream, index) => {
          const want = streamEnd(inputStreams[index]);
          const got = streamEnd(stream);
          const what = `${label} ${stream.codec_type}: ${got} vs ${want}`;
          assert.ok(Math.abs(got - want) < 0.002, what);
        });

        // decode both: the same frames as the input's (and every sample decodes the same
        // without the edit lists)
        assert.deepEqual(decodedFrames(path, { stream: "v:0" }), expected.v, `${label}: video`);
        assert.deepEqual(decodedFrames(path, { stream: "a:0" }), expected.a, `${label}: audio`);
        for (const [stream, input] of /** @type {const} */ ([["v:0", 0], ["a:0", 1]])) {
          const raw = { stream, ignoreEditList: true };
          assert.deepEqual(
            decodedFrames(path, raw),
            decodedFrames(inputs[input] ?? "", raw),
            `${label} ${stream}: without edit lists`,
          );
        }

        // the samples: the same bytes, timing, sync flags and last duration as given
        const back = await collectMp4(memoryFile(path, out));
        assert.deepEqual(
          sampleDigest(back, () => out),
          sampleDigest(plans, sourceBytes),
          `${label}: every sample as given`,
        );

        // probe and the downloader's verification: progressive, the writer's tracks, the codecs,
        // the durations the writer reported and ffprobe reads
        const probed = await probe(out);
        assert.equal(probed.progressive, true, label);
        assert.equal(probed.fragmented || probed.encrypted || probed.truncated, false, label);
        assert.deepEqual(
          probed.tracks.map((track) => [track.kind, track.codec, track.sampleCount]),
          plans.map((plan) => [
            plan.kind,
            plan.kind === "video" ? videoEntry : audioEntry,
            plan.samples.length,
          ]),
          label,
        );
        probed.tracks.forEach((track, index) => {
          const wrote = result.tracks[index];
          assert.ok(wrote);
          assert.equal(track.sampleCount, wrote.samples, label);
          const off = Math.abs(track.durationS - wrote.durationS);
          const versus = `${track.durationS} vs ${wrote.durationS}`;
          assert.ok(off <= WRITER_TOLERANCE_S, `${label} ${track.kind}: ${versus}`);
          const ffprobed = streamEnd(info.streams[index]);
          const near = Math.abs(track.durationS - ffprobed) < 0.002;
          assert.ok(near, `${label} ${track.kind}: ffprobe ${ffprobed}`);
          assert.ok(durationMatches(track.durationS, CODEC_SECONDS), `${label} ${track.kind}`);
          assert.ok(Math.abs(track.durationS - CODEC_SECONDS) < 0.1, `${label} ${track.kind}`);
        });
        assert.ok(durationMatches(probed.durationS, CODEC_SECONDS), label);
        assert.equal(probed.title, label === "plain" ? null : TITLE, label);
        assert.equal(probed.cover?.type, label === "plain" ? undefined : "jpeg", label);
      }

      // the cover and title change nothing else: the same frames, the same sample bytes
      const tagged = ffprobeAll(metaPath);
      assert.deepEqual(tagged.streams[2]?.disposition?.attached_pic, 1, "the cover is a picture");
      assert.equal(tagged.format.tags?.title, TITLE);
      const plainPlan = planMoov(plans);
      const metaPlan = planMoov(plans, { meta });
      assert.deepEqual(
        withMeta.out.subarray(metaPlan.mdatOffset + metaPlan.mdatHeader.length),
        plain.out.subarray(plainPlan.mdatOffset + plainPlan.mdatHeader.length),
        "the same mdat payload",
      );
    });
  }
}

// ----------------------------------------------------------------------------- tfdt shifting

/**
 * `data` with every `tfdt` moved `ticks` later, in place (version 1, 64-bit: no size changes).
 * @param {Uint8Array} data
 * @param {number} ticks
 */
function shiftTfdt(data, ticks) {
  const out = data.slice();
  for (const moof of readBoxes(out).filter((found) => found.type === "moof")) {
    for (const traf of childBoxes(out, moof).filter((found) => found.type === "traf")) {
      const tfdt = childBoxes(out, traf).find((found) => found.type === "tfdt");
      assert.ok(tfdt && out[tfdt.start + 8] === 1);
      out.set(u64(getU64(out, tfdt.start + 12) + ticks), tfdt.start + 12);
    }
  }
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
 * @typedef {{ index: number, codec_type: string, codec_name: string,
 *   disposition?: { attached_pic?: number } }} FullStream
 * @typedef {{ streams: FullStream[],
 *   format: { duration?: string, tags?: Record<string, string> } }} FullProbe
 */

/**
 * `ffprobe -show_streams -show_format` of a file, as JSON.
 * @param {string} path
 * @returns {FullProbe}
 */
function ffprobeAll(path) {
  const text = run("ffprobe", [...options("-v error -of json -show_streams -show_format"), path]);
  return /** @type {FullProbe} */ (JSON.parse(text));
}

/**
 * Latin-1 text as bytes.
 * @param {string} text
 * @returns {Uint8Array}
 */
function latin1Bytes(text) {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

/** @type {{ jpeg: Uint8Array, png: Uint8Array } | null} */
let covers = null;

/**
 * Two small cover images made by ffmpeg once per process: a 96×54 JPEG and a 96×54 PNG.
 * @param {Fixtures} media
 * @returns {{ jpeg: Uint8Array, png: Uint8Array }}
 */
function coverImages(media) {
  if (covers !== null) return covers;
  ffmpeg(...options("-f lavfi -i color=c=red:s=96x54 -frames:v 1"), media.path("cover.jpg"));
  ffmpeg(...options("-f lavfi -i color=c=blue:s=96x54 -frames:v 1"), media.path("cover.png"));
  covers = { jpeg: media.bytes("cover.jpg"), png: media.bytes("cover.png") };
  return covers;
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
