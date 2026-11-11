// @ts-check
/**
 * The progressive MP4 writer: one video track and at most one audio track ({@link TrackPlan}s
 * from `mp4.collectFmp4` / `mp4.collectMp4` or from `ts.TsDemuxer`) become `ftyp` + `moov` + one
 * interleaved `mdat`, the layout every player opens. Streaming and codec-agnostic: two passes
 * over the plans build the whole `moov` (its size, hence every chunk offset, is known before a
 * single sample is copied), then one pass copies the sample bytes through `read` into `sink`,
 * chunk by chunk. The sample entries (`stsd`) are copied byte for byte; nothing is decoded or
 * re-encoded, so the result is lossless. Pure: no `chrome.*`, no DOM, no dependency.
 *
 * Timing: a sample's presentation time is `dts + cts` (`cts` is the composition offset). Per
 * track, every offset is made non-negative by one shift (`shift = −min(cts)` when negative): the
 * `ctts` (version 0) holds `cts + shift` and an `elst` media edit starts at `media_time = shift`,
 * so the presentation is unchanged. The edit lasts until the last frame SHOWN ends (with
 * B-frames that is not the last one decoded), so no frame is cut off. The earliest track's first
 * decode time is time zero; a track whose first `dts` is later starts with an empty edit of that
 * gap, which keeps A/V sync. Each sample lasts until the next one's `dts`; the last one as long
 * as the plan's `lastDuration` says (the source's own `stts` / `trun` value), else as long as the
 * one before it (the MPEG-TS path, where nothing says).
 *
 * Codec-agnostic: H.264, HEVC (`hvc1` / `hev1`) and AV1 video, AAC, FLAC, AC-3, E-AC-3 and Opus
 * audio are written the same way — the sample entry with its configuration box as given, the
 * sample bytes as read (proven against ffmpeg's decoders in `tests/remux.test.js`).
 *
 * Metadata (`opts.meta`): the title and the cover go into `moov/udta/meta` (iTunes style: a full
 * `meta` box, an `hdlr` of handler `mdir`, then an `ilst` with `©nam` and `covr`), after the
 * `trak`s. The `udta` is part of the planned `moov`, so every chunk offset accounts for it; the
 * sample data is the same bytes with or without it.
 */

import {
  COVER_ITEM,
  DATA_TYPE,
  ENCRYPTED_SAMPLE_ENTRIES,
  Mp4Error,
  TITLE_ITEM,
  box,
  concat,
  fullBox,
  i32,
  i64,
  imageType,
  readBoxes,
  str4,
  u16,
  u32,
  u64,
} from "./mp4.js";

/** @typedef {import("./mp4.js").TrackPlan} TrackPlan */
/** @typedef {import("./mp4.js").SampleRef} SampleRef */
/**
 * One chunk of the output: `count` samples of `plans[track]` from sample `first`, written
 * contiguously at the absolute file `offset`, `size` bytes in all.
 * @typedef {{ track: number, first: number, count: number, offset: number,
 *   size: number }} ChunkPlan
 */
/** @typedef {{ kind: "video" | "audio", samples: number, durationS: number }} TrackSummary */
/**
 * What `planMoov` decides: the `ftyp`, `moov` and `mdat` header bytes, where the `mdat` box
 * starts (`mdatOffset`, its payload follows the header), the chunks in output order, the plans in
 * track-id order (video then audio), the sizes, the durations, whether chunk offsets needed
 * `co64`, and the size of the metadata `udta` inside the `moov` (0 without one).
 * @typedef {{ ftyp: Uint8Array, moov: Uint8Array, mdatHeader: Uint8Array, mdatOffset: number,
 *   payloadBytes: number, totalBytes: number, order: ChunkPlan[], plans: TrackPlan[],
 *   durationS: number, tracks: TrackSummary[], co64: boolean, udtaBytes: number }} MoovPlan
 */
/**
 * A cover image embedded as served: a JPEG (`covr` data type 13) or a PNG (data type 14).
 * @typedef {{ bytes: Uint8Array, type: "jpeg" | "png" }} Cover
 */
/**
 * The metadata written into the file: the title (`©nam`, UTF-8; an empty one is not written)
 * and the cover (`covr`, at most {@link MAX_COVER_BYTES}).
 * @typedef {{ title?: string, cover?: Cover }} Mp4Meta
 */
/** @typedef {{ chunkS?: number, meta?: Mp4Meta }} WriteOptions */
/** @typedef {{ file: string, offset: number }} DataRef */
/**
 * Reads `size` bytes of the work file `ref.file` at `ref.offset`.
 * @typedef {(ref: DataRef, size: number) => Promise<Uint8Array>} SampleReader
 */
/** @typedef {{ write(bytes: Uint8Array): Promise<void> }} Sink */

/** Interleaving: one chunk per track per this many seconds of decode time. */
export const DEFAULT_CHUNK_S = 1;
/** The movie timescale (`mvhd`, `tkhd`, `elst` durations): milliseconds. */
export const MOVIE_TIMESCALE = 1000;
/** Contiguous samples of one chunk are read in one call, up to this many bytes. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;
/** The largest cover embedded in a file: 5 MiB (a site's cover is tens to hundreds of KB). */
export const MAX_COVER_BYTES = 5 * 1024 * 1024;

const U32_MAX = 0xffffffff;
const I32_MAX = 0x7fffffff;
const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
/** Bucket arithmetic is in seconds: this keeps an exact boundary inside its bucket. */
const EPSILON = 1e-9;

/**
 * A track after validation, with everything the tables need.
 * @typedef {{ plan: TrackPlan, id: number, deltas: Float64Array, offsets: Float64Array | null,
 *   shift: number, mediaDuration: number, startS: number, emptyMovie: number,
 *   presentedMovie: number, width: number, height: number, chunks: ChunkPlan[] }} Prepared
 */

// ------------------------------------------------------------------------------ validation

/**
 * The plans in track-id order: the video track, then the audio track when there is one. A
 * 3-track input, an audio-only input, two tracks of one kind or an unknown kind are refused.
 * @param {readonly TrackPlan[]} tracks
 * @returns {TrackPlan[]}
 */
function orderTracks(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Mp4Error("invalid", "no tracks to write");
  }
  if (tracks.length > 2) {
    throw new Mp4Error(
      "unsupported",
      `${tracks.length} tracks: StreamFetch writes one video track and at most one audio track`,
    );
  }
  const videos = tracks.filter((track) => track.kind === "video");
  const audios = tracks.filter((track) => track.kind === "audio");
  if (videos.length + audios.length !== tracks.length) {
    throw new Mp4Error("invalid", "a track that is neither video nor audio");
  }
  const video = videos[0];
  if (video === undefined) {
    throw new Mp4Error(
      "unsupported",
      "no video track: an audio-only input is not saved as a video",
    );
  }
  if (videos.length > 1) throw new Mp4Error("unsupported", "two video tracks");
  if (audios.length > 1) throw new Mp4Error("unsupported", "two audio tracks");
  return [video, ...audios];
}

/**
 * The type and box range of the first sample entry of an `stsd`, after checking that the bytes
 * are exactly one `stsd` box and that no entry is encrypted.
 * @param {Uint8Array} stsd
 * @param {string} kind
 * @returns {{ type: string, start: number, end: number }}
 */
function checkStsd(stsd, kind) {
  if (!(stsd instanceof Uint8Array)) throw new Mp4Error("invalid", `the ${kind} track has no stsd`);
  const boxes = readBoxes(stsd);
  const only = boxes[0];
  if (boxes.length !== 1 || only === undefined || only.type !== "stsd") {
    throw new Mp4Error("invalid", `the ${kind} track's stsd is not one stsd box`);
  }
  const entries = readBoxes(stsd, only.start + only.headerSize + 8, only.end);
  const entry = entries[0];
  if (entry === undefined) {
    throw new Mp4Error("invalid", `the ${kind} track's stsd has no sample entry`);
  }
  for (const candidate of entries) {
    if (ENCRYPTED_SAMPLE_ENTRIES.has(candidate.type)) {
      throw new Mp4Error("encrypted", `${candidate.type} sample entry`);
    }
  }
  return { type: entry.type, start: entry.start, end: entry.end };
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isSafe(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Validates one plan and computes its decode durations (`next dts − dts`; the last one is the
 * plan's `lastDuration` when the source stated it, else the previous one again), its composition
 * shift, its media duration and how long it is presented: from the edit's start to where the
 * last sample shown ends — the latest `dts − first dts + cts + duration`, which with B-frames
 * is a frame or two after the last decoded one (the `elst` media edit must not cut them off).
 * @param {TrackPlan} plan
 * @param {number} id
 * @returns {Prepared}
 */
function prepare(plan, id) {
  const { kind } = plan;
  if (!isSafe(plan.timescale) || plan.timescale <= 0 || plan.timescale > U32_MAX) {
    throw new Mp4Error("invalid", `the ${kind} track's timescale ${plan.timescale} is not valid`);
  }
  const lastDuration = /** @type {unknown} */ (plan.lastDuration);
  if (
    lastDuration !== undefined &&
    (!isSafe(lastDuration) || lastDuration <= 0 || lastDuration > U32_MAX)
  ) {
    throw new Mp4Error("invalid", `the ${kind} track's last duration ${lastDuration} is not valid`);
  }
  const entry = checkStsd(plan.stsd, kind);
  const samples = plan.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Mp4Error("invalid", `the ${kind} track has no samples`);
  }
  const count = samples.length;
  const deltas = new Float64Array(count);
  let minCts = 0;
  let anyOffset = false;
  for (let index = 0; index < count; index += 1) {
    const sample = /** @type {SampleRef} */ (samples[index]);
    if (
      !isSafe(sample.dts) ||
      !isSafe(sample.cts) ||
      !isSafe(sample.size) ||
      sample.size < 0 ||
      sample.size > U32_MAX ||
      typeof sample.data?.file !== "string" ||
      !isSafe(sample.data.offset) ||
      sample.data.offset < 0
    ) {
      throw new Mp4Error("invalid", `${kind} sample ${index} is not a valid sample reference`);
    }
    if (sample.cts !== 0) anyOffset = true;
    if (sample.cts < minCts) minCts = sample.cts;
    if (index > 0) {
      const delta = sample.dts - /** @type {SampleRef} */ (samples[index - 1]).dts;
      if (delta < 0) {
        throw new Mp4Error("invalid", `${kind} decode times go backwards at sample ${index}`);
      }
      if (delta > U32_MAX) {
        throw new Mp4Error("invalid", `${kind} sample ${index - 1} lasts ${delta} ticks, too long`);
      }
      deltas[index - 1] = delta;
    }
  }
  deltas[count - 1] =
    typeof lastDuration === "number" ? lastDuration : count > 1 ? (deltas[count - 2] ?? 0) : 0;
  const shift = minCts < 0 ? -minCts : 0;
  /** @type {Float64Array | null} */
  let offsets = null;
  if (anyOffset) {
    offsets = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      const offset = /** @type {SampleRef} */ (samples[index]).cts + shift;
      if (offset > U32_MAX) {
        throw new Mp4Error("invalid", `${kind} composition offset ${offset} is too large`);
      }
      offsets[index] = offset;
    }
    if (offsets.every((offset) => offset === 0)) offsets = null;
  }
  const first = /** @type {SampleRef} */ (samples[0]);
  const last = /** @type {SampleRef} */ (samples[count - 1]);
  const mediaDuration = last.dts - first.dts + (deltas[count - 1] ?? 0);
  // presentation times run from the media edit's start (`media_time = shift`): dts − first + cts
  let presentedEnd = 0;
  for (let index = 0; index < count; index += 1) {
    const sample = /** @type {SampleRef} */ (samples[index]);
    const end = sample.dts - first.dts + sample.cts + (deltas[index] ?? 0);
    if (end > presentedEnd) presentedEnd = end;
  }
  let width = 0;
  let height = 0;
  if (kind === "video") {
    const body = entry.start + 8;
    const view = new DataView(plan.stsd.buffer, plan.stsd.byteOffset, plan.stsd.byteLength);
    const fromEntry = entry.end - body >= 28;
    width = plan.width ?? (fromEntry ? view.getUint16(body + 24) : 0);
    height = plan.height ?? (fromEntry ? view.getUint16(body + 26) : 0);
    const fits = (/** @type {number} */ size) => isSafe(size) && size >= 0 && size <= 0xffff;
    if (!fits(width) || !fits(height)) {
      throw new Mp4Error("invalid", `the video size ${width}x${height} is not valid`);
    }
  }
  return {
    plan,
    id,
    deltas,
    offsets,
    shift,
    mediaDuration,
    startS: first.dts / plan.timescale,
    emptyMovie: 0,
    presentedMovie: Math.round((presentedEnd * MOVIE_TIMESCALE) / plan.timescale),
    width,
    height,
    chunks: [],
  };
}

// -------------------------------------------------------------------------------- chunking

/**
 * Groups a track's samples into chunks of `chunkS` seconds of decode time (counted from the
 * movie's time zero, `offsetS` being the track's start), each chunk contiguous in decode order.
 * @param {Prepared} track
 * @param {number} trackIndex
 * @param {number} offsetS
 * @param {number} chunkS
 * @returns {{ bucket: number, chunk: ChunkPlan }[]}
 */
function chunksOf(track, trackIndex, offsetS, chunkS) {
  const { samples, timescale } = track.plan;
  const firstDts = /** @type {SampleRef} */ (samples[0]).dts;
  /** @type {{ bucket: number, chunk: ChunkPlan }[]} */
  const chunks = [];
  /** @type {{ bucket: number, chunk: ChunkPlan } | null} */
  let current = null;
  samples.forEach((sample, index) => {
    const seconds = (sample.dts - firstDts) / timescale + offsetS;
    const bucket = Math.floor(seconds / chunkS + EPSILON);
    if (current === null || current.bucket !== bucket) {
      const chunk = { track: trackIndex, first: index, count: 0, offset: 0, size: 0 };
      current = { bucket, chunk };
      chunks.push(current);
    }
    current.chunk.count += 1;
    current.chunk.size += sample.size;
  });
  return chunks;
}

// ------------------------------------------------------------------------------ the tables

/**
 * A full box made of 32-bit words: the `prefix` words, then the `values` (each a u32).
 * @param {string} type
 * @param {number} version
 * @param {ArrayLike<number>} prefix
 * @param {ArrayLike<number>} values
 * @returns {Uint8Array}
 */
function wordTable(type, version, prefix, values) {
  const size = 12 + 4 * (prefix.length + values.length);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, size);
  out.set(str4(type), 4);
  view.setUint8(8, version);
  let at = 12;
  for (const list of [prefix, values]) {
    for (let index = 0; index < list.length; index += 1, at += 4) {
      view.setUint32(at, list[index] ?? 0);
    }
  }
  return out;
}

/**
 * `(count, value)` runs of equal consecutive values, flattened.
 * @param {ArrayLike<number>} values
 * @returns {number[]}
 */
function runs(values) {
  /** @type {number[]} */
  const out = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    if (out.length > 0 && out[out.length - 1] === value) {
      out[out.length - 2] = (out[out.length - 2] ?? 0) + 1;
    } else {
      out.push(1, value);
    }
  }
  return out;
}

/**
 * The sample table of one track, given its chunk offsets.
 * @param {Prepared} track
 * @param {readonly number[]} chunkOffsets
 * @param {boolean} wide `co64` instead of `stco`
 * @returns {Uint8Array}
 */
function stbl(track, chunkOffsets, wide) {
  const { samples } = track.plan;
  const tables = [track.plan.stsd];
  const stts = runs(track.deltas);
  tables.push(wordTable("stts", 0, [stts.length / 2], stts));
  if (track.plan.kind === "video" && samples.some((sample) => !sample.sync)) {
    /** @type {number[]} */
    const sync = [];
    samples.forEach((sample, index) => {
      if (sample.sync) sync.push(index + 1);
    });
    tables.push(wordTable("stss", 0, [sync.length], sync));
  }
  if (track.offsets !== null) {
    const ctts = runs(track.offsets);
    tables.push(wordTable("ctts", 0, [ctts.length / 2], ctts));
  }
  /** @type {number[]} */
  const stsc = [];
  let previous = -1;
  track.chunks.forEach((chunk, index) => {
    if (chunk.count !== previous) stsc.push(index + 1, chunk.count, 1);
    previous = chunk.count;
  });
  tables.push(wordTable("stsc", 0, [stsc.length / 3], stsc));
  tables.push(wordTable("stsz", 0, [0, samples.length], samples.map((sample) => sample.size)));
  if (wide) {
    const out = new Uint8Array(16 + 8 * chunkOffsets.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, out.length);
    out.set(str4("co64"), 4);
    view.setUint32(12, chunkOffsets.length);
    chunkOffsets.forEach((offset, index) => view.setBigUint64(16 + 8 * index, BigInt(offset)));
    tables.push(out);
  } else {
    tables.push(wordTable("stco", 0, [chunkOffsets.length], chunkOffsets));
  }
  return box("stbl", ...tables);
}

/**
 * The 9 words of a transformation matrix.
 * @returns {Uint8Array}
 */
function matrix() {
  return concat(...IDENTITY_MATRIX.map((word) => u32(word)));
}

/**
 * A 32-bit field, or a 64-bit one in a version-1 box.
 * @param {number} value
 * @param {boolean} wide
 * @returns {Uint8Array}
 */
function time(value, wide) {
  return wide ? u64(value) : u32(value);
}

/**
 * The packed ISO 639-2/T language of an `mdhd` (`und` for anything not three letters a–z).
 * @param {string} code
 * @returns {number}
 */
function packLanguage(code) {
  const text = typeof code === "string" && /^[a-z]{3}$/.test(code) ? code : "und";
  return (
    ((text.charCodeAt(0) - 0x60) << 10) |
    ((text.charCodeAt(1) - 0x60) << 5) |
    (text.charCodeAt(2) - 0x60)
  );
}

/**
 * The `edts` of a track: an empty edit of its start gap, then the media edit from
 * `media_time = shift` — or nothing when neither is needed.
 * @param {Prepared} track
 * @returns {Uint8Array[]}
 */
function edts(track) {
  if (track.emptyMovie === 0 && track.shift === 0) return [];
  /** @type {[number, number][]} */
  const entries = [];
  if (track.emptyMovie > 0) entries.push([track.emptyMovie, -1]);
  entries.push([track.presentedMovie, track.shift]);
  const wide = entries.some(([duration, mediaTime]) => duration > U32_MAX || mediaTime > I32_MAX);
  const body = entries.map(([duration, mediaTime]) =>
    concat(
      wide ? u64(duration) : u32(duration),
      wide ? i64(mediaTime) : i32(mediaTime),
      u16(1),
      u16(0),
    ),
  );
  return [box("edts", fullBox("elst", wide ? 1 : 0, 0, u32(entries.length), ...body))];
}

/**
 * One `trak`.
 * @param {Prepared} track
 * @param {readonly number[]} chunkOffsets
 * @param {boolean} wideOffsets
 * @returns {Uint8Array}
 */
function trak(track, chunkOffsets, wideOffsets) {
  const video = track.plan.kind === "video";
  const tkhdDuration = track.emptyMovie + track.presentedMovie;
  const tkhdWide = tkhdDuration > U32_MAX;
  const tkhd = fullBox(
    "tkhd",
    tkhdWide ? 1 : 0,
    3,
    time(0, tkhdWide),
    time(0, tkhdWide),
    u32(track.id),
    u32(0),
    time(tkhdDuration, tkhdWide),
    new Uint8Array(8),
    u16(0),
    u16(0),
    u16(video ? 0 : 0x0100),
    u16(0),
    matrix(),
    u32(track.width * 0x10000),
    u32(track.height * 0x10000),
  );
  const mdhdWide = track.mediaDuration > U32_MAX;
  const mdhd = fullBox(
    "mdhd",
    mdhdWide ? 1 : 0,
    0,
    time(0, mdhdWide),
    time(0, mdhdWide),
    u32(track.plan.timescale),
    time(track.mediaDuration, mdhdWide),
    u16(packLanguage(track.plan.language)),
    u16(0),
  );
  const name = video ? "VideoHandler" : "SoundHandler";
  const hdlr = fullBox(
    "hdlr",
    0,
    0,
    u32(0),
    str4(video ? "vide" : "soun"),
    new Uint8Array(12),
    new Uint8Array([...Array.from(name, (char) => char.charCodeAt(0)), 0]),
  );
  const header = video
    ? fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0))
    : fullBox("smhd", 0, 0, u16(0), u16(0));
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
  const minf = box("minf", header, dinf, stbl(track, chunkOffsets, wideOffsets));
  return box("trak", tkhd, ...edts(track), box("mdia", mdhd, hdlr, minf));
}

/**
 * The `moov` for the prepared tracks and their chunk offsets, the metadata `udta` (when there is
 * one) after the `trak`s.
 * @param {readonly Prepared[]} tracks
 * @param {readonly (readonly number[])[]} offsets per track
 * @param {boolean} wide
 * @param {Uint8Array | null} udta
 * @returns {Uint8Array}
 */
function buildMoov(tracks, offsets, wide, udta) {
  const duration = Math.max(...tracks.map((track) => track.emptyMovie + track.presentedMovie));
  const mvhdWide = duration > U32_MAX;
  const mvhd = fullBox(
    "mvhd",
    mvhdWide ? 1 : 0,
    0,
    time(0, mvhdWide),
    time(0, mvhdWide),
    u32(MOVIE_TIMESCALE),
    time(duration, mvhdWide),
    u32(0x00010000),
    u16(0x0100),
    new Uint8Array(10),
    matrix(),
    new Uint8Array(24),
    u32(tracks.length + 1),
  );
  const traks = tracks.map((track, index) => trak(track, offsets[index] ?? [], wide));
  return box("moov", mvhd, ...traks, ...(udta === null ? [] : [udta]));
}

/**
 * The `ftyp`: `isom` 0x200, compatible `isom`, `iso2`, `avc1` (for an AVC video) and `mp41`.
 * @param {string} videoEntry
 * @returns {Uint8Array}
 */
function ftyp(videoEntry) {
  const brands = ["isom", "iso2", ...(videoEntry.startsWith("avc") ? ["avc1"] : []), "mp41"];
  return box("ftyp", str4("isom"), u32(0x200), ...brands.map((brand) => str4(brand)));
}

// ----------------------------------------------------------------------------- the metadata

/**
 * Why a cover cannot be embedded, with the error code the writer throws, or null when it can.
 * @param {unknown} cover
 * @returns {{ code: "invalid" | "unsupported", reason: string } | null}
 */
function checkCover(cover) {
  if (typeof cover !== "object" || cover === null) {
    return { code: "invalid", reason: "the cover is not { bytes, type }" };
  }
  const type = Reflect.get(cover, "type");
  const bytes = Reflect.get(cover, "bytes");
  if (type !== "jpeg" && type !== "png") {
    const named = typeof type === "string" ? JSON.stringify(type) : typeof type;
    return { code: "invalid", reason: `the cover type must be "jpeg" or "png", not ${named}` };
  }
  if (!(bytes instanceof Uint8Array)) return { code: "invalid", reason: "the cover has no bytes" };
  if (bytes.length === 0) return { code: "invalid", reason: "the cover is empty" };
  if (bytes.length > MAX_COVER_BYTES) {
    return {
      code: "unsupported",
      reason: `the cover is ${bytes.length} bytes, over the 5 MiB limit (${MAX_COVER_BYTES} bytes)`,
    };
  }
  const actual = imageType(bytes);
  if (actual !== type) {
    const seen = actual === null ? "" : ` (its bytes are a ${actual.toUpperCase()} image)`;
    return { code: "invalid", reason: `the cover is not a ${type.toUpperCase()} image${seen}` };
  }
  return null;
}

/**
 * Why `cover` cannot be embedded — not `{ bytes, type }`, a type other than `jpeg`/`png`, empty,
 * over {@link MAX_COVER_BYTES}, or bytes whose signature is not the declared type — or null when
 * it can. The reason is the one {@link writeProgressiveMp4} would throw, so a caller can drop a
 * bad cover (and say why) before writing instead of failing the file.
 * @param {unknown} cover
 * @returns {string | null}
 */
export function coverProblem(cover) {
  return checkCover(cover)?.reason ?? null;
}

/**
 * An iTunes metadata `data` atom: version 0, the 24-bit type, locale 0, the payload.
 * @param {number} type
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
function dataAtom(type, payload) {
  return box("data", u32(type), u32(0), payload);
}

/**
 * The `udta` that carries `meta` — `udta` › `meta` (full box, version 0, flags 0) › `hdlr`
 * (handler `mdir`, reserved `appl` then zeros, an empty name) and `ilst` › `©nam` (a `data` atom
 * of type 1, the title in UTF-8) and `covr` (type 13 for a JPEG, 14 for a PNG, the image as
 * given) — or null when there is nothing to write (no meta, an empty title and no cover). Throws
 * an `Mp4Error` for a meta that is not an object, a title that is not a string, or a cover
 * {@link coverProblem} refuses (`unsupported` over {@link MAX_COVER_BYTES}, else `invalid`).
 * @param {Mp4Meta | undefined} meta
 * @returns {Uint8Array | null}
 */
export function metadataUdta(meta) {
  if (meta === undefined || meta === null) return null;
  if (typeof meta !== "object" || Array.isArray(meta)) {
    throw new Mp4Error("invalid", "the metadata must be an object { title?, cover? }");
  }
  /** @type {Uint8Array[]} */
  const items = [];
  const title = /** @type {unknown} */ (meta.title);
  if (title !== undefined) {
    if (typeof title !== "string") throw new Mp4Error("invalid", "the title must be a string");
    if (title !== "") {
      items.push(box(TITLE_ITEM, dataAtom(DATA_TYPE.UTF8, new TextEncoder().encode(title))));
    }
  }
  const cover = /** @type {unknown} */ (meta.cover);
  if (cover !== undefined) {
    const problem = checkCover(cover);
    if (problem !== null) throw new Mp4Error(problem.code, problem.reason);
    const { bytes, type } = /** @type {Cover} */ (cover);
    items.push(box(COVER_ITEM, dataAtom(type === "jpeg" ? DATA_TYPE.JPEG : DATA_TYPE.PNG, bytes)));
  }
  if (items.length === 0) return null;
  const hdlr = fullBox(
    "hdlr",
    0,
    0,
    u32(0),
    str4("mdir"),
    str4("appl"),
    new Uint8Array(8),
    new Uint8Array(1),
  );
  return box("udta", fullBox("meta", 0, 0, hdlr, box("ilst", ...items)));
}

// --------------------------------------------------------------------------------- the plan

/**
 * Plans the progressive file without touching a sample byte: validates the tracks (one video,
 * at most one audio — ids 1 and 2), builds `ftyp`, the `moov` (`mvhd` timescale 1000; per track
 * `tkhd`, `edts`/`elst` when needed, `mdhd`, `hdlr`, `vmhd`/`smhd`, `dinf`, `stbl` with the
 * `stsd` copied, `stts`, `stss` (video, when not every sample is sync), `ctts` v0 (when an
 * offset is non-zero), `stsc`, `stsz`, `stco` — `co64` for every track once any chunk offset is
 * at or beyond 2^32) and the `mdat` header (64-bit largesize when the payload, the sum of every
 * sample size, does not fit in 32 bits), and orders the chunks: per `chunkS` seconds of decode
 * time the video chunk, then the audio chunk, each chunk's samples contiguous. `opts.meta` adds
 * the title and cover `udta` ({@link metadataUdta}) at the end of the `moov`; it is part of the
 * planned size, so the chunk offsets account for it.
 * @param {readonly TrackPlan[]} tracks
 * @param {WriteOptions} [opts]
 * @returns {MoovPlan}
 */
export function planMoov(tracks, opts = {}) {
  const chunkS = opts.chunkS ?? DEFAULT_CHUNK_S;
  if (typeof chunkS !== "number" || !Number.isFinite(chunkS) || chunkS <= 0) {
    throw new Mp4Error("invalid", `chunkS must be a positive number of seconds, not ${chunkS}`);
  }
  const udta = metadataUdta(opts.meta);
  const plans = orderTracks(tracks);
  const prepared = plans.map((plan, index) => prepare(plan, index + 1));
  const zero = Math.min(...prepared.map((track) => track.startS));
  /** @type {{ bucket: number, chunk: ChunkPlan }[][]} */
  const perTrack = prepared.map((track, index) => {
    const offsetS = track.startS - zero;
    track.emptyMovie = Math.round(offsetS * MOVIE_TIMESCALE);
    const chunks = chunksOf(track, index, offsetS, chunkS);
    track.chunks = chunks.map((entry) => entry.chunk);
    return chunks;
  });
  /** @type {ChunkPlan[]} */
  const order = [];
  const cursors = perTrack.map(() => 0);
  for (;;) {
    let pick = -1;
    let bucket = Infinity;
    perTrack.forEach((chunks, index) => {
      const next = chunks[cursors[index] ?? 0];
      if (next !== undefined && next.bucket < bucket) {
        pick = index;
        bucket = next.bucket;
      }
    });
    if (pick === -1) break;
    const next = /** @type {{ bucket: number, chunk: ChunkPlan }} */ (
      perTrack[pick]?.[cursors[pick] ?? 0]
    );
    order.push(next.chunk);
    cursors[pick] = (cursors[pick] ?? 0) + 1;
  }
  const payloadBytes = order.reduce((sum, chunk) => sum + chunk.size, 0);
  const mdatHeader =
    8 + payloadBytes <= U32_MAX
      ? concat(u32(8 + payloadBytes), str4("mdat"))
      : concat(u32(1), str4("mdat"), u64(16 + payloadBytes));
  const fileType = ftyp(checkStsd(/** @type {TrackPlan} */ (plans[0]).stsd, "video").type);

  /** @param {boolean} wide @returns {{ moov: Uint8Array, offsets: number[][] }} */
  const layout = (wide) => {
    const placeholder = prepared.map((track) => track.chunks.map(() => 0));
    const size = buildMoov(prepared, placeholder, wide, udta).length;
    let cursor = fileType.length + size + mdatHeader.length;
    for (const chunk of order) {
      chunk.offset = cursor;
      cursor += chunk.size;
    }
    const offsets = prepared.map((track) => track.chunks.map((chunk) => chunk.offset));
    const moov = buildMoov(prepared, offsets, wide, udta);
    if (moov.length !== size) throw new Mp4Error("invalid", "the moov size changed between passes");
    return { moov, offsets };
  };
  let co64 = false;
  let { moov } = layout(false);
  if (order.some((chunk) => chunk.offset > U32_MAX)) {
    co64 = true;
    ({ moov } = layout(true));
  }
  const durationMovie = Math.max(
    ...prepared.map((track) => track.emptyMovie + track.presentedMovie),
  );
  return {
    ftyp: fileType,
    moov,
    mdatHeader,
    mdatOffset: fileType.length + moov.length,
    payloadBytes,
    totalBytes: fileType.length + moov.length + mdatHeader.length + payloadBytes,
    order,
    plans,
    durationS: durationMovie / MOVIE_TIMESCALE,
    tracks: prepared.map((track) => ({
      kind: track.plan.kind,
      samples: track.plan.samples.length,
      durationS: (track.emptyMovie + track.presentedMovie) / MOVIE_TIMESCALE,
    })),
    co64,
    udtaBytes: udta === null ? 0 : udta.length,
  };
}

// ------------------------------------------------------------------------------- the writer

/**
 * Writes `ftyp` + `moov` + one interleaved `mdat` for the given tracks (see {@link planMoov}),
 * reading the sample bytes back through `read` and handing every piece to `sink.write` in file
 * order. `read` is called chunk by chunk in output order, contiguous samples of a chunk in one
 * call (up to {@link MAX_READ_BYTES}), so each source track is read sequentially; it must resolve
 * to exactly the bytes asked for. Returns the exact byte count written (checked against the
 * plan), the movie duration and each track's sample count and duration. `opts.meta` embeds the
 * title and the cover (`moov/udta/meta`, see {@link metadataUdta}); the sample bytes are the
 * same with or without it. Throws an `Mp4Error` when the tracks or the meta cannot be written —
 * before anything reaches `sink` (the message is the reason a report shows).
 * @param {readonly TrackPlan[]} tracks
 * @param {SampleReader} read
 * @param {Sink} sink
 * @param {WriteOptions} [opts]
 * @returns {Promise<{ bytes: number, durationS: number, tracks: TrackSummary[] }>}
 */
export async function writeProgressiveMp4(tracks, read, sink, opts = {}) {
  const plan = planMoov(tracks, opts);
  let written = 0;
  /** @param {Uint8Array} bytes */
  const write = async (bytes) => {
    await sink.write(bytes);
    written += bytes.length;
  };
  await write(plan.ftyp);
  await write(plan.moov);
  await write(plan.mdatHeader);
  for (const chunk of plan.order) {
    const samples = /** @type {TrackPlan} */ (plan.plans[chunk.track]).samples;
    const end = chunk.first + chunk.count;
    let index = chunk.first;
    while (index < end) {
      const first = /** @type {SampleRef} */ (samples[index]);
      let size = first.size;
      let next = index + 1;
      while (next < end) {
        const sample = /** @type {SampleRef} */ (samples[next]);
        if (
          sample.data.file !== first.data.file ||
          sample.data.offset !== first.data.offset + size ||
          size + sample.size > MAX_READ_BYTES
        ) {
          break;
        }
        size += sample.size;
        next += 1;
      }
      if (size > 0) {
        const bytes = await read({ file: first.data.file, offset: first.data.offset }, size);
        if (!(bytes instanceof Uint8Array) || bytes.length !== size) {
          const got = bytes instanceof Uint8Array ? bytes.length : 0;
          const where = `byte ${first.data.offset} of ${first.data.file}`;
          throw new Mp4Error("truncated", `a read of ${size} bytes at ${where} returned ${got}`);
        }
        await write(bytes);
      }
      index = next;
    }
  }
  if (written !== plan.totalBytes) {
    throw new Mp4Error("invalid", `wrote ${written} bytes where the plan has ${plan.totalBytes}`);
  }
  return { bytes: written, durationS: plan.durationS, tracks: plan.tracks };
}
