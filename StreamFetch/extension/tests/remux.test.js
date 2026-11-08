// @ts-check
/**
 * Unit tests of `src/lib/remux.js`, the progressive MP4 writer: DASH pairs, the fMP4 HLS stream
 * and progressive one-track files (`mp4.collectFmp4` / `mp4.collectMp4`) written to one MP4 that
 * ffprobe reads with one h264 and one aac stream, framemd5-equal to the source, `moov` before
 * `mdat`, no `moof`; the edit rules (a later start, negative composition offsets); chunk
 * interleaving checked against `ffprobe -show_packets`; `co64` and the largesize `mdat` header
 * on a synthetic plan past 4 GiB; the refusals.
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
  MAX_READ_BYTES,
  planMoov,
  writeProgressiveMp4,
} from "../src/lib/remux.js";

const NODE = /** @type {NodeProcess} */ (Reflect.get(globalThis, "process"));
const CHILD = /** @type {ChildProcessModule} */ (NODE.getBuiltinModule("node:child_process"));
const FS = /** @type {FsExtras} */ (NODE.getBuiltinModule("node:fs"));
const SKIP_MESSAGE = "ffmpeg not found: media tests not run";
const REQUIRE_TOOLS = NODE.env["STREAMFETCH_REQUIRE_TOOLS"] === "1";
const TOOLS = hasTool("ffmpeg") && hasTool("ffprobe");
const FIXTURE_URL = new URL("./fixtures/generated/remux/", import.meta.url);
const FIXTURE_DIR = decodeURIComponent(FIXTURE_URL.pathname);
const MEDIA = TOOLS ? {} : { skip: SKIP_MESSAGE };

/** @typedef {import("../src/lib/mp4.js").TrackPlan} TrackPlan */
/** @typedef {import("../src/lib/mp4.js").SampleRef} SampleRef */
/** @typedef {import("../src/lib/mp4.js").Box} Box */
/** @typedef {import("../src/lib/remux.js").MoovPlan} MoovPlan */

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
 * @param {{ chunkS?: number }} [opts]
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
  assert.deepEqual(editsOf(out, tablesOf(out, 1).get("elst")), [[6016, 1024]]);
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
  assert.deepEqual(editsOf(out, tablesOf(out, 1).get("elst")), [
    [500, -1],
    [6037, 0],
  ]);
  assert.equal(tablesOf(out, 0).get("elst"), undefined, "the earliest track needs no edit");
  assert.equal(result.durationS, 6.537);
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
  assert.deepEqual(editsOf(out, tables.get("elst")), [[80, 1024]]);
  assert.deepEqual(words(out, tables.get("stts")), [1, 4, 512]);
  assert.equal(plan.tracks[0]?.durationS, 0.08);
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
