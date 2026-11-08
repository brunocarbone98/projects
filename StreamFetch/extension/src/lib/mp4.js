// @ts-check
/**
 * MP4 reading for StreamFetch: the ISO BMFF box reader and writers, the init (`moov`) and
 * fragment (`moof`) parsers, the DRM walk, the readers that turn a downloaded file into
 * {@link TrackPlan}s for the progressive writer (`remux.js`) — fragmented files (DASH m4s, fMP4
 * HLS) through `collectFmp4`, any layout through `collectMp4` — and `probe`, the check of a
 * finished file. Pure: bytes in, bytes out, Uint8Array everywhere, DataView big-endian; no
 * `chrome.*`, no DOM, no dependency — it runs in Node (`node --test`) and in the extension alike.
 *
 * Files are read through a {@link Mp4File} (`{ name, size, slice(start, end) }`) in bounded
 * windows: box headers, the `moov` and each `moof` are read, an `mdat` never is (its samples are
 * referenced by absolute offset and copied later by the writer), so a gigabyte download costs a
 * few megabytes of memory.
 *
 * Time model of a {@link SampleRef}: `dts` is the decode time in the track's timescale and `cts`
 * is the composition OFFSET (presentation time minus `dts`, possibly negative) — what `ts.js`
 * emits as `pts − dts`. A source's edit list is folded in: a leading empty edit delays every
 * `dts`, the first media edit's `media_time` is subtracted from every `cts`. The writer turns the
 * offsets back into a non-negative `ctts` plus an `elst`, so the presentation is unchanged.
 */

// --------------------------------------------------------------------------------- the model

/**
 * One elementary-stream sample, codec-agnostic. `dts` in the track's timescale; `cts` is the
 * composition offset (presentation time − `dts`, negative allowed); `data` names where its bytes
 * live: a byte range of a work file (`{ file, offset }` + `size`) — the original m4s/fMP4/MP4
 * file for DASH and HLS fMP4, or the `<key>.video.bin` / `<key>.audio.bin` sample files of the
 * TS path.
 * @typedef {{ dts: number, cts: number, size: number, sync: boolean,
 *   data: { file: string, offset: number } }} SampleRef
 */
/**
 * What the progressive writer needs of one track: the sample entry box (`stsd`, built or copied
 * byte for byte), the timescale and the samples in decode order.
 * @typedef {{ kind: "video" | "audio", timescale: number, stsd: Uint8Array, width: number | null,
 *   height: number | null, sampleRate: number | null, channelCount: number | null,
 *   language: string, samples: SampleRef[] }} TrackPlan
 */
/**
 * A file read in windows: `slice(start, end)` resolves to exactly `end − start` bytes.
 * @typedef {{ name: string, size: number,
 *   slice(start: number, end: number): Promise<Uint8Array> }} Mp4File
 */
/**
 * A box: its type, total size, header size (8, 16 with a largesize, +16 for a `uuid` type) and
 * the byte range it covers in the buffer it was read from.
 * @typedef {{ type: string, size: number, headerSize: number, start: number, end: number }} Box
 */
/**
 * The `trex` defaults of a track (`mvex`), used by fragments that leave a field out.
 * @typedef {{ defaultSampleDescriptionIndex: number, defaultSampleDuration: number,
 *   defaultSampleSize: number, defaultSampleFlags: number }} Trex
 */
/**
 * A track's edit list reduced to what StreamFetch honours: the leading empty edits (movie
 * timescale) and the `media_time` of the first media edit (track timescale).
 * @typedef {{ emptyDuration: number, mediaTime: number }} Edit
 */
/**
 * One `trak` of a `moov`.
 * @typedef {{ id: number, kind: "video" | "audio" | "other", timescale: number, durationTs: number,
 *   handler: string, stsd: Uint8Array, sampleEntryType: string, sampleEntryCount: number,
 *   width: number | null, height: number | null, sampleRate: number | null,
 *   channelCount: number | null, language: string, trex: Trex | null, encrypted: boolean,
 *   edit: Edit }} TrackInfo
 */
/**
 * What `parseInit` reads: the tracks, the movie timescale, whether the movie is fragmented
 * (`mvex`) and whether anything declares encryption.
 * @typedef {{ tracks: TrackInfo[], movieTimescale: number, fragmented: boolean,
 *   encrypted: boolean }} InitInfo
 */
/**
 * One sample of a track fragment; `offset` is its absolute position in the file.
 * @typedef {{ size: number, duration: number, flags: number, cts: number,
 *   offset: number }} FragmentSample
 */
/**
 * One `traf` of a `moof`: the samples with absolute data offsets, `baseDecodeTime` from `tfdt`
 * (null without one), `dataStart` / `dataEnd` the range its samples cover.
 * @typedef {{ trackId: number, baseDecodeTime: number | null, sampleDescriptionIndex: number,
 *   samples: FragmentSample[], dataStart: number, dataEnd: number }} Fragment
 */
/**
 * @typedef {{ id: number, kind: "video" | "audio" | "other", codec: string, timescale: number,
 *   durationS: number, sampleCount: number }} ProbeTrack
 */
/**
 * What `probe` says of a finished file. `progressive`: `moov` before the first `mdat`, no `moof`
 * and no `mvex`; `truncated`: a top-level box runs past the end of the file.
 * @typedef {{ tracks: ProbeTrack[], durationS: number, progressive: boolean, fragmented: boolean,
 *   encrypted: boolean, truncated: boolean }} ProbeResult
 */
/** @typedef {"invalid" | "truncated" | "encrypted" | "unsupported"} Mp4ErrorCode */

// ------------------------------------------------------------------------------- constants

/** Bytes read to decode one box header: 8, +8 for a largesize, +16 for a `uuid` type. */
export const BOX_HEADER_PEEK = 32;
/** The largest `moov` or `moof` read into memory at once; a real one is kilobytes to megabytes. */
export const MAX_METADATA_BOX_BYTES = 128 * 1024 * 1024;
/** Boxes one `readBoxes` call lists at most. */
export const MAX_BOXES = 1_000_000;
/** Samples one track may hold at most (a 10-hour 60 fps video is about 2.2 million). */
export const MAX_SAMPLES_PER_TRACK = 10_000_000;

/** Box headers one DRM walk reads at most, every level together. */
export const MAX_DRM_BOXES = 4096;
/** Sample-entry types of an encrypted track (Common Encryption). */
export const ENCRYPTED_SAMPLE_ENTRIES = /** @type {ReadonlySet<string>} */ (
  new Set(["encv", "enca"])
);
/** `tfhd` flags (ISO/IEC 14496-12 8.8.7). */
export const TFHD = Object.freeze({
  BASE_DATA_OFFSET: 0x000001,
  SAMPLE_DESCRIPTION_INDEX: 0x000002,
  DEFAULT_SAMPLE_DURATION: 0x000008,
  DEFAULT_SAMPLE_SIZE: 0x000010,
  DEFAULT_SAMPLE_FLAGS: 0x000020,
  DURATION_IS_EMPTY: 0x010000,
  DEFAULT_BASE_IS_MOOF: 0x020000,
});
/** `trun` flags (ISO/IEC 14496-12 8.8.8). */
export const TRUN = Object.freeze({
  DATA_OFFSET: 0x000001,
  FIRST_SAMPLE_FLAGS: 0x000004,
  SAMPLE_DURATION: 0x000100,
  SAMPLE_SIZE: 0x000200,
  SAMPLE_FLAGS: 0x000400,
  SAMPLE_COMPOSITION_TIME_OFFSET: 0x000800,
});
/** The per-sample fields a `trun` may carry, 4 bytes each. */
const PER_SAMPLE_FIELDS = [
  TRUN.SAMPLE_DURATION,
  TRUN.SAMPLE_SIZE,
  TRUN.SAMPLE_FLAGS,
  TRUN.SAMPLE_COMPOSITION_TIME_OFFSET,
];
/** Sample flags: `sample_is_non_sync_sample` and `sample_depends_on == 1` (depends on others). */
export const SAMPLE_FLAG_NON_SYNC = 0x00010000;
export const SAMPLE_FLAG_DEPENDS_YES = 0x01000000;

/** Boxes whose children start after a few bytes of their own (full-box fields, entry count). */
const CHILD_OFFSETS = /** @type {ReadonlyMap<string, number>} */ (
  new Map([
    ["stsd", 8],
    ["dref", 8],
    ["meta", 4],
  ])
);
/** Top-level boxes `collectFmp4` passes over (besides `mdat`, `free`, `skip`). */
const SKIPPED_TOP_LEVEL = new Set(["ftyp", "styp", "sidx", "free", "skip", "mfra", "emsg", "prft"]);
const U32_MAX = 0xffffffff;
const EMPTY = new Uint8Array(0);

// ------------------------------------------------------------------------------- the error

/** An MP4 StreamFetch cannot read or will not write; `code` says why, the message says what. */
export class Mp4Error extends Error {
  /**
   * @param {Mp4ErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "Mp4Error";
    /** @type {Mp4ErrorCode} */
    this.code = code;
  }
}

// ------------------------------------------------------------------------- reading helpers

/**
 * Big-endian reads over one buffer, every read bounds-checked (a cut box is `truncated`).
 */
class ByteReader {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /**
   * @param {number} at
   * @param {number} length
   * @param {string} what
   */
  need(at, length, what) {
    if (at < 0 || length < 0 || at + length > this.bytes.length) {
      throw new Mp4Error("truncated", `${what} is cut short`);
    }
  }

  /** @param {number} at @param {string} [what] */
  u8(at, what = "a field") {
    this.need(at, 1, what);
    return this.view.getUint8(at);
  }

  /** @param {number} at @param {string} [what] */
  u16(at, what = "a field") {
    this.need(at, 2, what);
    return this.view.getUint16(at);
  }

  /** @param {number} at @param {string} [what] */
  u24(at, what = "a field") {
    this.need(at, 3, what);
    return (this.view.getUint8(at) << 16) | this.view.getUint16(at + 1);
  }

  /** @param {number} at @param {string} [what] */
  u32(at, what = "a field") {
    this.need(at, 4, what);
    return this.view.getUint32(at);
  }

  /** @param {number} at @param {string} [what] */
  i32(at, what = "a field") {
    this.need(at, 4, what);
    return this.view.getInt32(at);
  }

  /**
   * An unsigned 64-bit field as a Number; beyond 2^53 − 1 it is `unsupported`.
   * @param {number} at
   * @param {string} [what]
   */
  u64(at, what = "a field") {
    this.need(at, 8, what);
    return safeNumber(this.view.getBigUint64(at), what);
  }

  /**
   * A signed 64-bit field as a Number; beyond ±(2^53 − 1) it is `unsupported`.
   * @param {number} at
   * @param {string} [what]
   */
  i64(at, what = "a field") {
    this.need(at, 8, what);
    return safeNumber(this.view.getBigInt64(at), what);
  }

  /** @param {number} at @param {string} [what] */
  str4(at, what = "a box type") {
    this.need(at, 4, what);
    const b = this.bytes;
    return String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);
  }
}

/**
 * @param {bigint} value
 * @param {string} what
 * @returns {number}
 */
function safeNumber(value, what) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Mp4Error("unsupported", `${what} (${value}) is beyond 2^53`);
  }
  return Number(value);
}

/**
 * The header of the box at `at`, or null when `bytes` ends inside the header. `size` 0 means
 * "to the end of the enclosing range"; the caller resolves it.
 * @param {Uint8Array} bytes
 * @param {number} at
 * @param {number} [end]
 * @returns {{ type: string, size: number, headerSize: number } | null}
 */
function rawHeader(bytes, at, end = bytes.length) {
  if (end - at < 8) return null;
  const reader = new ByteReader(bytes.subarray(0, end));
  let size = reader.u32(at);
  const type = reader.str4(at + 4);
  let headerSize = 8;
  if (size === 1) {
    if (end - at < 16) return null;
    size = reader.u64(at + 8, `the largesize of the ${type} box at byte ${at}`);
    headerSize = 16;
  }
  if (type === "uuid") {
    if (end - at < headerSize + 16) return null;
    headerSize += 16;
  }
  return { type, size, headerSize };
}

/**
 * Whether `bytes[start, end)` is all zeros (the QuickTime terminator some writers leave at the
 * end of a container).
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 */
function allZero(bytes, start, end) {
  for (let at = start; at < end; at += 1) if (bytes[at] !== 0) return false;
  return true;
}

// ------------------------------------------------------------------------------ the reader

/**
 * The boxes between `start` and `end`, in order. A largesize is honoured, a `uuid` box's header
 * includes its 16-byte extended type, size 0 runs to `end`; a trailing run of fewer than 8 zero
 * bytes is tolerated. A box that runs past `end` is `truncated`, one smaller than its header
 * `invalid`.
 * @param {Uint8Array} bytes
 * @param {number} [start]
 * @param {number} [end]
 * @returns {Box[]}
 */
export function readBoxes(bytes, start = 0, end = bytes.length) {
  /** @type {Box[]} */
  const boxes = [];
  let at = start;
  while (at < end) {
    if (boxes.length >= MAX_BOXES) {
      throw new Mp4Error("invalid", `more than ${MAX_BOXES} boxes in one container`);
    }
    const head = rawHeader(bytes, at, end);
    if (head === null) {
      if (end - at < 8 && allZero(bytes, at, end)) break;
      throw new Mp4Error("truncated", `a box header at byte ${at} is cut short`);
    }
    const size = head.size === 0 ? end - at : head.size;
    if (size < head.headerSize) {
      const name = printable(head.type);
      throw new Mp4Error(
        "invalid",
        `the ${name} box at byte ${at} declares ${size} bytes, less than its header`,
      );
    }
    if (at + size > end) {
      const name = printable(head.type);
      throw new Mp4Error(
        "truncated",
        `the ${name} box at byte ${at} runs past the end (${size} bytes, ${end - at} left)`,
      );
    }
    boxes.push({ type: head.type, size, headerSize: head.headerSize, start: at, end: at + size });
    at += size;
  }
  return boxes;
}

/**
 * Where a box's children start: after its header, and after the full-box fields and entry count
 * of `stsd` / `dref` (8 bytes) and `meta` (4 bytes).
 * @param {Box} box
 * @returns {number}
 */
export function contentStart(box) {
  return box.start + box.headerSize + (CHILD_OFFSETS.get(box.type) ?? 0);
}

/**
 * The child boxes of `box` (see {@link contentStart}).
 * @param {Uint8Array} bytes
 * @param {Box} box
 * @returns {Box[]}
 */
export function childBoxes(bytes, box) {
  return readBoxes(bytes, contentStart(box), box.end);
}

/**
 * The first box along `path` (`"moov/trak/mdia"` or `["moov", "trak", "mdia"]`), searching
 * `bytes[start, end)`; null when a step is missing.
 * @param {Uint8Array} bytes
 * @param {string | readonly string[]} path
 * @param {number} [start]
 * @param {number} [end]
 * @returns {Box | null}
 */
export function findBox(bytes, path, start = 0, end = bytes.length) {
  const names = typeof path === "string" ? path.split("/").filter((name) => name !== "") : path;
  let from = start;
  let to = end;
  /** @type {Box | null} */
  let found = null;
  for (const name of names) {
    found = readBoxes(bytes, from, to).find((candidate) => candidate.type === name) ?? null;
    if (found === null) return null;
    from = contentStart(found);
    to = found.end;
  }
  return found;
}

/**
 * Every box of `type` directly inside `box`.
 * @param {Uint8Array} bytes
 * @param {Box} box
 * @param {string} type
 * @returns {Box[]}
 */
function childrenOf(bytes, box, type) {
  return childBoxes(bytes, box).filter((child) => child.type === type);
}

/**
 * The one child of `type` inside `box`, or an `invalid` error naming what is missing.
 * @param {Uint8Array} bytes
 * @param {Box} box
 * @param {string} type
 * @param {string} where
 * @returns {Box}
 */
function required(bytes, box, type, where) {
  const found = childBoxes(bytes, box).find((child) => child.type === type);
  if (found === undefined) throw new Mp4Error("invalid", `no ${type} box in ${where}`);
  return found;
}

/**
 * @param {string} type
 * @returns {string}
 */
function printable(type) {
  return /^[\x20-\x7e]{4}$/.test(type) ? type : JSON.stringify(type);
}

// ------------------------------------------------------------------------------ the writers

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {string} what
 */
function checkInt(value, min, max, what) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${what} ${value} is out of range`);
  }
}

/** @param {number} value @returns {Uint8Array} one unsigned byte */
export function u8(value) {
  checkInt(value, 0, 0xff, "u8");
  return new Uint8Array([value]);
}

/** @param {number} value @returns {Uint8Array} two bytes, unsigned big-endian */
export function u16(value) {
  checkInt(value, 0, 0xffff, "u16");
  return new Uint8Array([value >>> 8, value & 0xff]);
}

/** @param {number} value @returns {Uint8Array} three bytes, unsigned big-endian (full-box flags) */
export function u24(value) {
  checkInt(value, 0, 0xffffff, "u24");
  return new Uint8Array([value >>> 16, (value >>> 8) & 0xff, value & 0xff]);
}

/** @param {number} value @returns {Uint8Array} four bytes, unsigned big-endian */
export function u32(value) {
  checkInt(value, 0, U32_MAX, "u32");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** @param {number} value @returns {Uint8Array} four bytes, signed big-endian */
export function i32(value) {
  checkInt(value, -0x80000000, 0x7fffffff, "i32");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value);
  return out;
}

/** @param {number | bigint} value @returns {Uint8Array} eight bytes, unsigned big-endian */
export function u64(value) {
  if (typeof value === "number") checkInt(value, 0, Number.MAX_SAFE_INTEGER, "u64");
  else if (value < 0n || value > 0xffffffffffffffffn) {
    throw new RangeError(`u64 ${value} is out of range`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

/** @param {number | bigint} value @returns {Uint8Array} eight bytes, signed big-endian */
export function i64(value) {
  if (typeof value === "number") {
    checkInt(value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "i64");
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(value));
  return out;
}

/**
 * Four Latin-1 characters (a box or brand type).
 * @param {string} text
 * @returns {Uint8Array}
 */
export function str4(text) {
  if (text.length !== 4 || !/^[\x00-\xff]{4}$/.test(text)) {
    throw new RangeError(`a box type is four Latin-1 characters, not ${JSON.stringify(text)}`);
  }
  return new Uint8Array(Array.from(text, (char) => char.charCodeAt(0)));
}

/**
 * The parts one after the other in a new buffer.
 * @param {...Uint8Array} parts
 * @returns {Uint8Array}
 */
export function concat(...parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * A box of `type` around the payloads (a largesize header when it needs one).
 * @param {string} type
 * @param {...Uint8Array} payloads
 * @returns {Uint8Array}
 */
export function box(type, ...payloads) {
  let payloadSize = 0;
  for (const payload of payloads) payloadSize += payload.length;
  if (8 + payloadSize <= U32_MAX) return concat(u32(8 + payloadSize), str4(type), ...payloads);
  return concat(u32(1), str4(type), u64(16 + payloadSize), ...payloads);
}

/**
 * A full box: version, 24-bit flags, then the payloads.
 * @param {string} type
 * @param {number} version
 * @param {number} flags
 * @param {...Uint8Array} payloads
 * @returns {Uint8Array}
 */
export function fullBox(type, version, flags, ...payloads) {
  return box(type, u8(version), u24(flags), ...payloads);
}

// ---------------------------------------------------------------------------- the init (moov)

/**
 * The top-level boxes of a buffer that may end inside a box (the first bytes of a file): the
 * complete ones, and the first one that is cut (or null).
 * @param {Uint8Array} bytes
 * @returns {{ boxes: Box[], cut: { type: string, start: number } | null }}
 */
function scanTopLevel(bytes) {
  /** @type {Box[]} */
  const boxes = [];
  let at = 0;
  while (at < bytes.length) {
    const head = rawHeader(bytes, at);
    if (head === null) return { boxes, cut: { type: "", start: at } };
    const size = head.size === 0 ? bytes.length - at : head.size;
    if (size < head.headerSize) {
      const name = printable(head.type);
      throw new Mp4Error("invalid", `the ${name} box at byte ${at} is smaller than its header`);
    }
    if (at + size > bytes.length) return { boxes, cut: { type: head.type, start: at } };
    boxes.push({ type: head.type, size, headerSize: head.headerSize, start: at, end: at + size });
    at += size;
  }
  return { boxes, cut: null };
}

/**
 * The language of an `mdhd` (ISO 639-2/T packed in 15 bits), `und` when unset or not letters.
 * @param {number} packed
 * @returns {string}
 */
function language(packed) {
  const chars = [(packed >> 10) & 0x1f, (packed >> 5) & 0x1f, packed & 0x1f];
  if (chars.some((code) => code < 1 || code > 26)) return "und";
  return String.fromCharCode(...chars.map((code) => code + 0x60));
}

/**
 * A track's `edts/elst` reduced to {@link Edit}: the leading empty edits (`media_time` −1) add
 * up to `emptyDuration`; the first media edit gives `mediaTime`. Later edits are not honoured.
 * @param {Uint8Array} bytes
 * @param {Box} trak
 * @returns {Edit}
 */
function readEdit(bytes, trak) {
  const elst = findBox(bytes, ["edts", "elst"], contentStart(trak), trak.end);
  if (elst === null) return { emptyDuration: 0, mediaTime: 0 };
  const reader = new ByteReader(bytes);
  const body = elst.start + elst.headerSize;
  const version = reader.u8(body, "the elst");
  const count = reader.u32(body + 4, "the elst");
  const entrySize = version === 1 ? 20 : 12;
  reader.need(body + 8, count * entrySize, "the elst");
  let emptyDuration = 0;
  for (let index = 0; index < count; index += 1) {
    const at = body + 8 + index * entrySize;
    const duration = version === 1 ? reader.u64(at) : reader.u32(at);
    const mediaTime = version === 1 ? reader.i64(at + 8) : reader.i32(at + 4);
    if (mediaTime === -1) {
      emptyDuration += duration;
      continue;
    }
    return { emptyDuration, mediaTime };
  }
  return { emptyDuration, mediaTime: 0 };
}

/**
 * @param {Uint8Array} bytes
 * @param {Box} trak
 * @param {Map<number, Trex>} trexes
 * @param {boolean} psshSeen
 * @returns {TrackInfo}
 */
function parseTrak(bytes, trak, trexes, psshSeen) {
  const reader = new ByteReader(bytes);
  const tkhd = required(bytes, trak, "tkhd", "a trak");
  const tkhdBody = tkhd.start + tkhd.headerSize;
  const tkhdVersion = reader.u8(tkhdBody, "the tkhd");
  const id = reader.u32(tkhdBody + (tkhdVersion === 1 ? 20 : 12), "the tkhd");
  const where = `track ${id}`;
  const mdia = required(bytes, trak, "mdia", where);
  const mdhd = required(bytes, mdia, "mdhd", where);
  const mdhdBody = mdhd.start + mdhd.headerSize;
  const mdhdVersion = reader.u8(mdhdBody, "the mdhd");
  const timescale = reader.u32(mdhdBody + (mdhdVersion === 1 ? 20 : 12), "the mdhd");
  const durationTs =
    mdhdVersion === 1
      ? reader.u64(mdhdBody + 24, "the mdhd")
      : reader.u32(mdhdBody + 16, "the mdhd");
  const packedLanguage = reader.u16(mdhdBody + (mdhdVersion === 1 ? 32 : 20), "the mdhd");
  if (timescale === 0) throw new Mp4Error("invalid", `${where} has a timescale of 0`);
  const hdlr = required(bytes, mdia, "hdlr", where);
  const handler = reader.str4(hdlr.start + hdlr.headerSize + 8, "the hdlr");
  const minf = required(bytes, mdia, "minf", where);
  const stbl = required(bytes, minf, "stbl", where);
  const stsd = required(bytes, stbl, "stsd", where);
  const entryCount = reader.u32(stsd.start + stsd.headerSize + 4, "the stsd");
  const entries = childBoxes(bytes, stsd);
  const entry = entries[0];
  if (entry === undefined || entryCount === 0) {
    throw new Mp4Error("invalid", `the stsd of ${where} has no sample entry`);
  }
  const kind = handler === "vide" ? "video" : handler === "soun" ? "audio" : "other";
  /** @type {number | null} */
  let width = null;
  /** @type {number | null} */
  let height = null;
  /** @type {number | null} */
  let sampleRate = null;
  /** @type {number | null} */
  let channelCount = null;
  const entryBody = entry.start + entry.headerSize;
  if (kind === "video" && entry.end - entryBody >= 28) {
    width = reader.u16(entryBody + 24);
    height = reader.u16(entryBody + 26);
  }
  if (kind === "audio" && entry.end - entryBody >= 28) {
    const soundVersion = reader.u16(entryBody + 8);
    channelCount = reader.u16(entryBody + 16);
    const rate = reader.u32(entryBody + 24) >>> 16;
    sampleRate = soundVersion < 2 && rate > 0 ? rate : timescale;
  }
  const encrypted = entries.some((candidate) => ENCRYPTED_SAMPLE_ENTRIES.has(candidate.type));
  return {
    id,
    kind,
    timescale,
    durationTs,
    handler,
    stsd: bytes.slice(stsd.start, stsd.end),
    sampleEntryType: entry.type,
    sampleEntryCount: entryCount,
    width,
    height,
    sampleRate,
    channelCount,
    language: language(packedLanguage),
    trex: trexes.get(id) ?? null,
    encrypted: encrypted || psshSeen,
    edit: readEdit(bytes, trak),
  };
}

/**
 * The tracks of the `moov` in `bytes` (an init segment, the first bytes of a file, or a whole
 * file held in memory): ids, kinds (`vide` → video, `soun` → audio), timescales, the `stsd`
 * copied byte for byte, the first sample entry's type and dimensions or audio fields, the
 * language, the `trex` defaults, the edit, and `encrypted` (an `encv`/`enca` entry, or a `pssh`
 * at the top level or in the `moov`).
 * @param {Uint8Array} bytes
 * @returns {InitInfo}
 */
export function parseInit(bytes) {
  const top = scanTopLevel(bytes);
  const moov = top.boxes.find((candidate) => candidate.type === "moov");
  if (moov === undefined) {
    if (top.cut !== null && top.cut.type === "moov") {
      throw new Mp4Error("truncated", `the moov box at byte ${top.cut.start} is cut short`);
    }
    throw new Mp4Error("invalid", "no moov box: not an MP4 init");
  }
  const reader = new ByteReader(bytes);
  const children = childBoxes(bytes, moov);
  const mvhd = children.find((child) => child.type === "mvhd");
  if (mvhd === undefined) throw new Mp4Error("invalid", "no mvhd box in the moov");
  const mvhdBody = mvhd.start + mvhd.headerSize;
  const movieTimescale = reader.u32(mvhdBody + (reader.u8(mvhdBody) === 1 ? 20 : 12), "the mvhd");
  /** @type {Map<number, Trex>} */
  const trexes = new Map();
  const mvex = children.find((child) => child.type === "mvex");
  if (mvex !== undefined) {
    for (const trex of childrenOf(bytes, mvex, "trex")) {
      const body = trex.start + trex.headerSize;
      trexes.set(reader.u32(body + 4, "the trex"), {
        defaultSampleDescriptionIndex: reader.u32(body + 8, "the trex"),
        defaultSampleDuration: reader.u32(body + 12, "the trex"),
        defaultSampleSize: reader.u32(body + 16, "the trex"),
        defaultSampleFlags: reader.u32(body + 20, "the trex"),
      });
    }
  }
  const psshSeen =
    children.some((child) => child.type === "pssh") ||
    top.boxes.some((candidate) => candidate.type === "pssh");
  const tracks = children
    .filter((child) => child.type === "trak")
    .map((trak) => parseTrak(bytes, trak, trexes, psshSeen));
  return {
    tracks,
    movieTimescale: movieTimescale === 0 ? 1000 : movieTimescale,
    fragmented: mvex !== undefined,
    encrypted: psshSeen || tracks.some((track) => track.encrypted),
  };
}

// ------------------------------------------------------------------------------- the DRM walk

/**
 * The boxes between `start` and `end`, leniently: a box that runs past `end` is clamped to it,
 * a header that is cut or makes no sense ends the list. Never throws.
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @param {{ left: number }} budget
 * @returns {Box[]}
 */
function lenientBoxes(bytes, start, end, budget) {
  /** @type {Box[]} */
  const boxes = [];
  let at = start;
  while (at < end && budget.left > 0) {
    let head;
    try {
      head = rawHeader(bytes, at, end);
    } catch {
      break;
    }
    if (head === null) break;
    budget.left -= 1;
    const size = head.size === 0 ? end - at : head.size;
    if (size < head.headerSize) break;
    const stop = Math.min(end, at + size);
    boxes.push({ type: head.type, size, headerSize: head.headerSize, start: at, end: stop });
    at = stop;
  }
  return boxes;
}

/**
 * What declares encryption in `bytes` — `encv sample entry`, `enca sample entry`, `pssh box`,
 * `senc box` — as one comma-separated detail, or null when nothing does. A structural walk of box
 * headers along the paths where encryption is declared (top level, `moov`, the sample entries,
 * `moof/traf`), bounded by {@link MAX_DRM_BOXES} headers and tolerant of a buffer that ends
 * inside a box (the first bytes of a download); never a raw byte search (the bytes `encv` inside
 * an `mdat` mean nothing) and it never throws.
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
export function drmProblem(bytes) {
  try {
    if (!(bytes instanceof Uint8Array)) return null;
    /** @type {Set<string>} */
    const found = new Set();
    const budget = { left: MAX_DRM_BOXES };
    /** @param {Box} parent */
    const inside = (parent) => lenientBoxes(bytes, contentStart(parent), parent.end, budget);
    for (const top of lenientBoxes(bytes, 0, bytes.length, budget)) {
      if (top.type === "pssh") found.add("pssh box");
      if (top.type === "moov") {
        for (const child of inside(top)) {
          if (child.type === "pssh") found.add("pssh box");
          if (child.type !== "trak") continue;
          /** @type {Box[]} */
          let level = [child];
          for (const step of ["mdia", "minf", "stbl", "stsd"]) {
            level = level.flatMap((parent) => inside(parent).filter((box) => box.type === step));
          }
          for (const stsd of level) {
            for (const entry of inside(stsd)) {
              if (ENCRYPTED_SAMPLE_ENTRIES.has(entry.type)) found.add(`${entry.type} sample entry`);
            }
          }
        }
      }
      if (top.type === "moof") {
        for (const child of inside(top)) {
          if (child.type === "pssh") found.add("pssh box");
          if (child.type !== "traf") continue;
          for (const grandchild of inside(child)) {
            if (grandchild.type === "senc") found.add("senc box");
          }
        }
      }
    }
    return found.size === 0 ? null : [...found].join(", ");
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- the fragments

/**
 * Whether fragment sample flags mark a sync sample: neither `sample_is_non_sync_sample` nor
 * `sample_depends_on == 1` (the rule ffmpeg's reader applies).
 * @param {number} flags
 * @returns {boolean}
 */
export function isSyncSample(flags) {
  return (flags & SAMPLE_FLAG_NON_SYNC) === 0 && ((flags >>> 24) & 0x3) !== 1;
}

/**
 * @param {Uint8Array} bytes
 * @param {Box} traf
 * @param {number} moofStart absolute offset of the enclosing moof
 * @param {number | null} previousEnd absolute end of the previous traf's data in this moof
 * @param {Map<number, Trex>} defaults
 * @returns {Fragment}
 */
function parseTraf(bytes, traf, moofStart, previousEnd, defaults) {
  const reader = new ByteReader(bytes);
  const children = childBoxes(bytes, traf);
  const tfhd = children.find((child) => child.type === "tfhd");
  if (tfhd === undefined) throw new Mp4Error("invalid", "a traf without a tfhd");
  const tfhdBody = tfhd.start + tfhd.headerSize;
  const tfhdFlags = reader.u24(tfhdBody + 1, "the tfhd");
  const trackId = reader.u32(tfhdBody + 4, "the tfhd");
  const trex = defaults.get(trackId) ?? null;
  let at = tfhdBody + 8;
  /** @type {number | null} */
  let baseDataOffset = null;
  if (tfhdFlags & TFHD.BASE_DATA_OFFSET) {
    baseDataOffset = reader.u64(at, "the tfhd base data offset");
    at += 8;
  }
  let sampleDescriptionIndex = trex?.defaultSampleDescriptionIndex ?? 1;
  if (tfhdFlags & TFHD.SAMPLE_DESCRIPTION_INDEX) {
    sampleDescriptionIndex = reader.u32(at, "the tfhd");
    at += 4;
  }
  /** @type {number | null} */
  let defaultDuration = trex?.defaultSampleDuration ?? null;
  if (tfhdFlags & TFHD.DEFAULT_SAMPLE_DURATION) {
    defaultDuration = reader.u32(at, "the tfhd");
    at += 4;
  }
  /** @type {number | null} */
  let defaultSize = trex?.defaultSampleSize ?? null;
  if (tfhdFlags & TFHD.DEFAULT_SAMPLE_SIZE) {
    defaultSize = reader.u32(at, "the tfhd");
    at += 4;
  }
  let defaultFlags = trex?.defaultSampleFlags ?? 0;
  if (tfhdFlags & TFHD.DEFAULT_SAMPLE_FLAGS) {
    defaultFlags = reader.u32(at, "the tfhd");
    at += 4;
  }
  const base =
    baseDataOffset !== null
      ? baseDataOffset
      : tfhdFlags & TFHD.DEFAULT_BASE_IS_MOOF || previousEnd === null
        ? moofStart
        : previousEnd;

  /** @type {number | null} */
  let baseDecodeTime = null;
  const tfdt = children.find((child) => child.type === "tfdt");
  if (tfdt !== undefined) {
    const body = tfdt.start + tfdt.headerSize;
    baseDecodeTime =
      reader.u8(body, "the tfdt") === 1
        ? reader.u64(body + 4, "the tfdt")
        : reader.u32(body + 4, "the tfdt");
  }

  /** @type {FragmentSample[]} */
  const samples = [];
  let cursor = base;
  let dataStart = base;
  let dataEnd = base;
  let firstRun = true;
  for (const trun of children) {
    if (trun.type !== "trun") continue;
    const body = trun.start + trun.headerSize;
    const version = reader.u8(body, "the trun");
    const flags = reader.u24(body + 1, "the trun");
    const count = reader.u32(body + 4, "the trun");
    let field = body + 8;
    if (flags & TRUN.DATA_OFFSET) {
      cursor = base + reader.i32(field, "the trun data offset");
      field += 4;
    } else if (firstRun) {
      cursor = base;
    }
    /** @type {number | null} */
    let firstFlags = null;
    if (flags & TRUN.FIRST_SAMPLE_FLAGS) {
      firstFlags = reader.u32(field, "the trun");
      field += 4;
    }
    const perSample = 4 * PER_SAMPLE_FIELDS.filter((bit) => flags & bit).length;
    if (field + count * perSample > trun.end) {
      throw new Mp4Error(
        "invalid",
        `a trun of track ${trackId} lists ${count} samples it has no room for`,
      );
    }
    for (let index = 0; index < count; index += 1) {
      let duration = defaultDuration;
      if (flags & TRUN.SAMPLE_DURATION) {
        duration = reader.u32(field);
        field += 4;
      }
      let size = defaultSize;
      if (flags & TRUN.SAMPLE_SIZE) {
        size = reader.u32(field);
        field += 4;
      }
      let sampleFlags = defaultFlags;
      if (flags & TRUN.SAMPLE_FLAGS) {
        sampleFlags = reader.u32(field);
        field += 4;
      }
      if (index === 0 && firstFlags !== null) sampleFlags = firstFlags;
      let cts = 0;
      if (flags & TRUN.SAMPLE_COMPOSITION_TIME_OFFSET) {
        cts = version === 0 ? reader.u32(field) : reader.i32(field);
        field += 4;
      }
      if (duration === null) {
        throw new Mp4Error("invalid", `no sample duration for track ${trackId}`);
      }
      if (size === null) throw new Mp4Error("invalid", `no sample size for track ${trackId}`);
      samples.push({ size, duration, flags: sampleFlags, cts, offset: cursor });
      cursor += size;
    }
    firstRun = false;
  }
  samples.forEach((sample, index) => {
    if (index === 0 || sample.offset < dataStart) dataStart = sample.offset;
    if (index === 0 || sample.offset + sample.size > dataEnd) dataEnd = sample.offset + sample.size;
  });
  return { trackId, baseDecodeTime, sampleDescriptionIndex, samples, dataStart, dataEnd };
}

/**
 * The track fragments of every `moof` in `bytes` (a buffer holding `moof` + `mdat` pairs, or
 * just a `moof`; other top-level boxes are passed over, a cut trailing `mdat` too). `fileOffset`
 * is where the buffer starts in the file, so every sample `offset` is absolute. Data offsets
 * follow ISO/IEC 14496-12: `tfhd` base-data-offset, else default-base-is-moof (or the first traf)
 * → the moof's first byte, else the end of the previous traf's data; a `trun` data-offset is
 * added to that base, a `trun` without one continues after the previous run. Missing durations,
 * sizes and flags come from the `tfhd`, then from `defaults` (the init's `trex`, keyed by track
 * id, or the {@link TrackInfo}s of `parseInit`). `cts` is unsigned in `trun` version 0, signed in
 * version 1.
 * @param {Uint8Array} bytes
 * @param {number} [fileOffset]
 * @param {Map<number, Trex> | readonly TrackInfo[]} [defaults]
 * @returns {Fragment[]}
 */
export function parseFragments(bytes, fileOffset = 0, defaults = new Map()) {
  /** @type {Map<number, Trex>} */
  const trexes = new Map();
  if (defaults instanceof Map) for (const [id, trex] of defaults) trexes.set(id, trex);
  else for (const track of defaults) if (track.trex !== null) trexes.set(track.id, track.trex);
  const top = scanTopLevel(bytes);
  if (top.cut !== null && top.cut.type === "moof") {
    const at = fileOffset + top.cut.start;
    throw new Mp4Error("truncated", `the moof box at byte ${at} is cut short`);
  }
  /** @type {Fragment[]} */
  const fragments = [];
  for (const moof of top.boxes) {
    if (moof.type !== "moof") continue;
    const moofStart = fileOffset + moof.start;
    /** @type {number | null} */
    let previousEnd = null;
    for (const traf of childrenOf(bytes, moof, "traf")) {
      const fragment = parseTraf(bytes, traf, moofStart, previousEnd, trexes);
      previousEnd = fragment.dataEnd;
      fragments.push(fragment);
    }
  }
  return fragments;
}

// ---------------------------------------------------------------------------- file reading

/**
 * A file held in memory, as an {@link Mp4File}.
 * @param {string} name
 * @param {Uint8Array} bytes
 * @returns {Mp4File}
 */
export function memoryFile(name, bytes) {
  return {
    name,
    size: bytes.length,
    slice: async (start, end) => bytes.slice(start, end),
  };
}

/** Reads an {@link Mp4File} through one cached window: box headers, `moov`s and `moof`s. */
class WindowReader {
  /** @param {Mp4File} file */
  constructor(file) {
    this.file = file;
    this.start = 0;
    /** @type {Uint8Array} */
    this.bytes = EMPTY;
  }

  /**
   * `length` bytes at `start` (fewer at the end of the file).
   * @param {number} start
   * @param {number} length
   * @returns {Promise<Uint8Array>}
   */
  async range(start, length) {
    const end = Math.min(this.file.size, start + length);
    if (start >= this.start && end <= this.start + this.bytes.length) {
      return this.bytes.subarray(start - this.start, end - this.start);
    }
    const bytes = await this.file.slice(start, end);
    if (!(bytes instanceof Uint8Array) || bytes.length !== end - start) {
      throw new Mp4Error(
        "truncated",
        `${this.file.name}: a read of ${end - start} bytes at ${start} came back short`,
      );
    }
    this.start = start;
    this.bytes = bytes;
    return bytes;
  }

  /**
   * The header of the top-level box at `at`; size 0 is resolved to the end of the file.
   * @param {number} at
   * @returns {Promise<Box>}
   */
  async header(at) {
    const peek = await this.range(at, BOX_HEADER_PEEK);
    const head = rawHeader(peek, 0);
    if (head === null) {
      throw new Mp4Error(
        "truncated",
        `${this.file.name}: the box header at byte ${at} is cut short`,
      );
    }
    const size = head.size === 0 ? this.file.size - at : head.size;
    if (size < head.headerSize) {
      const name = printable(head.type);
      throw new Mp4Error(
        "invalid",
        `${this.file.name}: the ${name} box at byte ${at} is smaller than its header`,
      );
    }
    return { type: head.type, size, headerSize: head.headerSize, start: at, end: at + size };
  }

  /**
   * The whole of a metadata box (`moov`, `moof`), plus a peek at the next header in the window.
   * @param {Box} found
   * @returns {Promise<Uint8Array>}
   */
  async whole(found) {
    if (found.end > this.file.size) {
      const where = `${this.file.name}: the ${found.type} box at byte ${found.start}`;
      throw new Mp4Error("truncated", `${where} runs past the end of the file`);
    }
    if (found.size > MAX_METADATA_BOX_BYTES) {
      throw new Mp4Error(
        "unsupported",
        `${this.file.name}: a ${found.size}-byte ${found.type} box is too large`,
      );
    }
    const bytes = await this.range(found.start, found.size + BOX_HEADER_PEEK);
    return bytes.subarray(0, found.size);
  }
}


/**
 * Every top-level box of the file, in order, with the bytes of the `moov` (`mdat` and the rest
 * are never read). When `onMoof` is given each `moof` is read and handed over with the `moov`
 * read before it (a `moof` before any `moov` is `invalid`), so a fragmented file is never held
 * whole; without it a `moof` is only counted. `truncated`: the file ends inside a box or a box
 * header.
 * @param {WindowReader} reader
 * @param {(moof: Uint8Array, at: number, moov: Uint8Array) => void} [onMoof]
 * @returns {Promise<{ boxes: Box[], moov: Uint8Array | null, moofCount: number,
 *   truncated: boolean }>}
 */
async function walkTopLevel(reader, onMoof) {
  const { file } = reader;
  /** @type {Box[]} */
  const boxes = [];
  /** @type {Uint8Array | null} */
  let moov = null;
  let moofCount = 0;
  let truncated = false;
  let at = 0;
  while (at < file.size) {
    if (boxes.length >= MAX_BOXES) throw new Mp4Error("invalid", `${file.name}: too many boxes`);
    if (file.size - at < 8) {
      truncated = true;
      break;
    }
    const found = await reader.header(at);
    boxes.push(found);
    if (found.end > file.size) truncated = true;
    if (found.type === "moov") {
      if (moov !== null) throw new Mp4Error("invalid", `${file.name}: two moov boxes`);
      moov = await reader.whole(found);
    } else if (found.type === "moof") {
      moofCount += 1;
      if (onMoof !== undefined) {
        if (moov === null) throw new Mp4Error("invalid", `${file.name}: a moof before the moov`);
        onMoof(await reader.whole(found), found.start, moov);
      }
    }
    at = found.end;
  }
  return { boxes, moov, moofCount, truncated };
}

/**
 * The tracks StreamFetch can write (video and audio) of an init, refusing encrypted media and
 * tracks with several sample descriptions.
 * @param {InitInfo} init
 * @param {string} name
 * @param {string | null} drm
 * @returns {TrackInfo[]}
 */
function writableTracks(init, name, drm) {
  if (init.encrypted || drm !== null) throw new Mp4Error("encrypted", drm ?? "encrypted tracks");
  const tracks = init.tracks.filter((track) => track.kind !== "other");
  if (tracks.length === 0) throw new Mp4Error("invalid", `${name}: no audio or video track`);
  for (const track of tracks) {
    if (track.sampleEntryCount !== 1) {
      throw new Mp4Error(
        "unsupported",
        `${name}: track ${track.id} has ${track.sampleEntryCount} sample descriptions`,
      );
    }
  }
  return tracks;
}

/**
 * Refuses a file with a `pssh` box at the top level (the DRM system's key information).
 * @param {readonly Box[]} boxes
 */
function refuseTopLevelPssh(boxes) {
  if (boxes.some((found) => found.type === "pssh")) throw new Mp4Error("encrypted", "pssh box");
}

/**
 * A {@link TrackPlan} of `track` without samples.
 * @param {TrackInfo} track
 * @returns {TrackPlan}
 */
function emptyPlan(track) {
  return {
    kind: track.kind === "video" ? "video" : "audio",
    timescale: track.timescale,
    stsd: track.stsd,
    width: track.width,
    height: track.height,
    sampleRate: track.sampleRate,
    channelCount: track.channelCount,
    language: track.language,
    samples: [],
  };
}

/**
 * The decode-time delay of a track's leading empty edit, in the track's timescale.
 * @param {TrackInfo} track
 * @param {number} movieTimescale
 * @returns {number}
 */
function editDelay(track, movieTimescale) {
  return Math.round((track.edit.emptyDuration * track.timescale) / movieTimescale);
}

/**
 * @param {Mp4File} file
 * @param {number} offset
 * @param {number} size
 */
function checkInFile(file, offset, size) {
  if (offset < 0 || offset + size > file.size) {
    throw new Mp4Error(
      "truncated",
      `${file.name}: sample data at byte ${offset} runs past the end of the file`,
    );
  }
}

/**
 * @param {TrackPlan} plan
 * @param {Mp4File} file
 */
function checkSampleCount(plan, file) {
  if (plan.samples.length > MAX_SAMPLES_PER_TRACK) {
    throw new Mp4Error(
      "unsupported",
      `${file.name}: more than ${MAX_SAMPLES_PER_TRACK} samples in one track`,
    );
  }
}

/**
 * The {@link TrackPlan}s of a FRAGMENTED MP4 (a DASH m4s file, or an fMP4 HLS init followed by
 * its segments), read in bounded windows — box headers, the `moov` and one `moof` at a time,
 * never an `mdat`. One plan per video or audio track, in `moov` order: the `stsd` copied, `dts`
 * from each `tfdt` (or the running sum of durations when a fragment has none) plus the delay of
 * the init's leading empty edit, `cts` the `trun` offset minus the edit's `media_time`, `sync`
 * from the sample flags, data references into the same file (`file.name`). `styp`, `sidx`,
 * `free`, `skip`, `mfra`, `emsg` and the other top-level boxes are passed over. Encrypted media
 * (`encv`, `enca`, `pssh`, `senc`) is refused (`Mp4Error` `encrypted`); a file that ends inside
 * a box or sample data beyond its end is `truncated`; a file without `moov` or `moof` is
 * `invalid`.
 * @param {Mp4File} file
 * @returns {Promise<TrackPlan[]>}
 */
export async function collectFmp4(file) {
  const reader = new WindowReader(file);
  /** @type {InitInfo | null} */
  let init = null;
  /** @type {TrackInfo[]} */
  let tracks = [];
  /** @type {Map<number, { plan: TrackPlan, nextDts: number, delay: number, mediaTime: number }>} */
  const builders = new Map();
  const walk = await walkTopLevel(reader, (moof, at, moov) => {
    if (init === null) {
      init = parseInit(moov);
      tracks = writableTracks(init, file.name, drmProblem(moov));
      for (const track of tracks) {
        const delay = editDelay(track, init.movieTimescale);
        builders.set(track.id, {
          plan: emptyPlan(track),
          nextDts: delay,
          delay,
          mediaTime: track.edit.mediaTime,
        });
      }
    }
    const drm = drmProblem(moof);
    if (drm !== null) throw new Mp4Error("encrypted", drm);
    for (const fragment of parseFragments(moof, at, init.tracks)) {
      const builder = builders.get(fragment.trackId);
      if (builder === undefined) continue;
      let dts =
        fragment.baseDecodeTime === null
          ? builder.nextDts
          : fragment.baseDecodeTime + builder.delay;
      for (const sample of fragment.samples) {
        checkInFile(file, sample.offset, sample.size);
        builder.plan.samples.push({
          dts,
          cts: sample.cts - builder.mediaTime,
          size: sample.size,
          sync: isSyncSample(sample.flags),
          data: { file: file.name, offset: sample.offset },
        });
        dts += sample.duration;
      }
      checkSampleCount(builder.plan, file);
      builder.nextDts = dts;
    }
  });
  if (walk.truncated) throw new Mp4Error("truncated", `${file.name}: the file ends inside a box`);
  if (walk.moov === null) throw new Mp4Error("invalid", `${file.name}: no moov box: not an MP4`);
  refuseTopLevelPssh(walk.boxes);
  if (init === null) {
    const info = parseInit(walk.moov);
    tracks = writableTracks(info, file.name, drmProblem(walk.moov));
    if (!info.fragmented) throw new Mp4Error("invalid", `${file.name}: not a fragmented MP4`);
    return tracks.map(emptyPlan);
  }
  return tracks.map((track) => builders.get(track.id)?.plan ?? emptyPlan(track));
}

// ------------------------------------------------------------------------ progressive files

/**
 * The sample sizes of an `stsz` (one size for all, or a table) or an `stz2` (4-, 8- or 16-bit
 * fields, two 4-bit fields per byte, high nibble first).
 * @param {ByteReader} reader
 * @param {Box | undefined} found
 * @param {string} where
 * @returns {Uint32Array}
 */
function sampleSizes(reader, found, where) {
  if (found === undefined) throw new Mp4Error("invalid", `no stsz or stz2 box in ${where}`);
  const body = found.start + found.headerSize;
  if (found.type === "stsz") {
    const constant = reader.u32(body + 4, "the stsz");
    const count = reader.u32(body + 8, "the stsz");
    if (count > MAX_SAMPLES_PER_TRACK) {
      throw new Mp4Error("unsupported", `${where}: more than ${MAX_SAMPLES_PER_TRACK} samples`);
    }
    const sizes = new Uint32Array(count);
    if (constant !== 0) return sizes.fill(constant);
    reader.need(body + 12, count * 4, "the stsz");
    for (let index = 0; index < count; index += 1) sizes[index] = reader.u32(body + 12 + 4 * index);
    return sizes;
  }
  const fieldSize = reader.u8(body + 7, "the stz2");
  const count = reader.u32(body + 8, "the stz2");
  if (fieldSize !== 4 && fieldSize !== 8 && fieldSize !== 16) {
    throw new Mp4Error("invalid", `${where}: an stz2 field size of ${fieldSize} bits`);
  }
  if (count > MAX_SAMPLES_PER_TRACK) {
    throw new Mp4Error("unsupported", `${where}: more than ${MAX_SAMPLES_PER_TRACK} samples`);
  }
  reader.need(body + 12, Math.ceil((count * fieldSize) / 8), "the stz2");
  const sizes = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    if (fieldSize === 16) sizes[index] = reader.u16(body + 12 + 2 * index);
    else if (fieldSize === 8) sizes[index] = reader.u8(body + 12 + index);
    else {
      const byte = reader.u8(body + 12 + (index >> 1));
      sizes[index] = index % 2 === 0 ? byte >> 4 : byte & 0x0f;
    }
  }
  return sizes;
}

/**
 * The `(count, value)` entries of an `stts` or `ctts` expanded to one value per sample (`stts`:
 * the decode times from `start`; `ctts`: the offsets, read as signed in both versions — the way
 * ffmpeg reads version 0). The entries must cover exactly `count` samples (a short `ctts` leaves
 * the rest at 0).
 * @param {ByteReader} reader
 * @param {Box} found
 * @param {number} count
 * @param {"stts" | "ctts"} type
 * @param {string} where
 * @param {number} start
 * @returns {Float64Array}
 */
function expandRuns(reader, found, count, type, where, start) {
  const body = found.start + found.headerSize;
  const entries = reader.u32(body + 4, `the ${type}`);
  reader.need(body + 8, entries * 8, `the ${type}`);
  const values = new Float64Array(count);
  let index = 0;
  let time = start;
  for (let entry = 0; entry < entries; entry += 1) {
    const runLength = reader.u32(body + 8 + 8 * entry);
    const value =
      type === "stts" ? reader.u32(body + 12 + 8 * entry) : reader.i32(body + 12 + 8 * entry);
    if (index + runLength > count) {
      throw new Mp4Error(
        "invalid",
        `${where}: the ${type} covers more samples than the stsz lists`,
      );
    }
    for (let run = 0; run < runLength; run += 1) {
      if (type === "stts") {
        values[index] = time;
        time += value;
      } else {
        values[index] = value;
      }
      index += 1;
    }
  }
  if (type === "stts" && index !== count) {
    throw new Mp4Error("invalid", `${where}: the stts covers ${index} of ${count} samples`);
  }
  return values;
}

/**
 * The chunk offsets of an `stco` or `co64`.
 * @param {ByteReader} reader
 * @param {Box | undefined} found
 * @param {string} where
 * @returns {Float64Array}
 */
function chunkOffsets(reader, found, where) {
  if (found === undefined) throw new Mp4Error("invalid", `no stco or co64 box in ${where}`);
  const body = found.start + found.headerSize;
  const count = reader.u32(body + 4, `the ${found.type}`);
  const wide = found.type === "co64";
  reader.need(body + 8, count * (wide ? 8 : 4), `the ${found.type}`);
  const offsets = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    offsets[index] = wide ? reader.u64(body + 8 + 8 * index) : reader.u32(body + 8 + 4 * index);
  }
  return offsets;
}

/**
 * The plan of one track of a PROGRESSIVE file: its sample tables (`stts`, `ctts` v0/v1, `stss`,
 * `stsc`, `stsz`/`stz2`, `stco`/`co64`) turned into samples with absolute data offsets, the
 * track's edit folded in (empty edit → later `dts`, `media_time` → smaller `cts`).
 * @param {Uint8Array} moov
 * @param {Box} trak
 * @param {TrackInfo} track
 * @param {number} movieTimescale
 * @param {Mp4File} file
 * @returns {TrackPlan}
 */
function progressivePlan(moov, trak, track, movieTimescale, file) {
  const where = `${file.name}: track ${track.id}`;
  const reader = new ByteReader(moov);
  const stbl = findBox(moov, ["mdia", "minf", "stbl"], contentStart(trak), trak.end);
  if (stbl === null) throw new Mp4Error("invalid", `${where} has no stbl`);
  /** @type {Map<string, Box>} */
  const tables = new Map();
  for (const child of childBoxes(moov, stbl)) {
    if (!tables.has(child.type)) tables.set(child.type, child);
  }
  const sizes = sampleSizes(reader, tables.get("stsz") ?? tables.get("stz2"), where);
  const count = sizes.length;
  const stts = tables.get("stts");
  if (stts === undefined) throw new Mp4Error("invalid", `no stts box in ${where}`);
  const delay = editDelay(track, movieTimescale);
  const decodeTimes = expandRuns(reader, stts, count, "stts", where, delay);
  const ctts = tables.get("ctts");
  const offsets =
    ctts === undefined
      ? new Float64Array(count)
      : expandRuns(reader, ctts, count, "ctts", where, 0);
  /** @type {Uint8Array | null} */
  let sync = null;
  const stss = tables.get("stss");
  if (stss !== undefined) {
    const body = stss.start + stss.headerSize;
    const entries = reader.u32(body + 4, "the stss");
    reader.need(body + 8, entries * 4, "the stss");
    sync = new Uint8Array(count);
    for (let entry = 0; entry < entries; entry += 1) {
      const number = reader.u32(body + 8 + 4 * entry);
      if (number >= 1 && number <= count) sync[number - 1] = 1;
    }
  }
  const chunks = chunkOffsets(reader, tables.get("co64") ?? tables.get("stco"), where);
  const stsc = tables.get("stsc");
  if (stsc === undefined) throw new Mp4Error("invalid", `no stsc box in ${where}`);
  const stscBody = stsc.start + stsc.headerSize;
  const runs = reader.u32(stscBody + 4, "the stsc");
  reader.need(stscBody + 8, runs * 12, "the stsc");
  const plan = emptyPlan(track);
  const { mediaTime } = track.edit;
  let sample = 0;
  for (let run = 0; run < runs && sample < count; run += 1) {
    const firstChunk = reader.u32(stscBody + 8 + 12 * run);
    const perChunk = reader.u32(stscBody + 12 + 12 * run);
    const nextFirst =
      run + 1 < runs ? reader.u32(stscBody + 8 + 12 * (run + 1)) : chunks.length + 1;
    if (firstChunk < 1 || nextFirst <= firstChunk) {
      throw new Mp4Error("invalid", `${where}: the stsc runs are out of order`);
    }
    for (let chunk = firstChunk; chunk < nextFirst && chunk <= chunks.length; chunk += 1) {
      let offset = chunks[chunk - 1] ?? 0;
      for (let index = 0; index < perChunk && sample < count; index += 1) {
        const size = sizes[sample] ?? 0;
        checkInFile(file, offset, size);
        plan.samples.push({
          dts: decodeTimes[sample] ?? 0,
          cts: (offsets[sample] ?? 0) - mediaTime,
          size,
          sync: sync === null || sync[sample] === 1,
          data: { file: file.name, offset },
        });
        offset += size;
        sample += 1;
      }
    }
  }
  if (sample !== count) {
    throw new Mp4Error("invalid", `${where}: the chunks hold ${sample} of ${count} samples`);
  }
  return plan;
}

/**
 * The {@link TrackPlan}s of any MP4 a site serves: a FRAGMENTED file (a `moof`, or `mvex` in the
 * `moov`) goes to {@link collectFmp4}; a PROGRESSIVE one (one `moov` with full sample tables,
 * before or after the `mdat`) is read from its `stbl`s — `stts`, `ctts` (v0/v1), `stss`, `stsc`,
 * `stsz`/`stz2`, `stco`/`co64` — honouring each track's edit (a leading empty edit delays the
 * track, a `media_time` shifts its composition offsets). Only box headers and the `moov` are
 * read; samples are data references. Both layouts feed the same writer.
 * @param {Mp4File} file
 * @returns {Promise<TrackPlan[]>}
 */
export async function collectMp4(file) {
  const walk = await walkTopLevel(new WindowReader(file));
  if (walk.moov === null) throw new Mp4Error("invalid", `${file.name}: no moov box: not an MP4`);
  const init = parseInit(walk.moov);
  if (walk.moofCount > 0 || init.fragmented) return collectFmp4(file);
  if (walk.truncated) throw new Mp4Error("truncated", `${file.name}: the file ends inside a box`);
  const tracks = writableTracks(init, file.name, drmProblem(walk.moov));
  refuseTopLevelPssh(walk.boxes);
  const moov = walk.moov;
  const moovBox = readBoxes(moov)[0];
  if (moovBox === undefined) throw new Mp4Error("invalid", `${file.name}: an empty moov`);
  const traks = childBoxes(moov, moovBox).filter((child) => child.type === "trak");
  /** @type {TrackPlan[]} */
  const plans = [];
  init.tracks.forEach((track, index) => {
    const trak = traks[index];
    if (trak === undefined || !tracks.includes(track)) return;
    plans.push(progressivePlan(moov, trak, track, init.movieTimescale, file));
  });
  return plans;
}

// -------------------------------------------------------------------------------- the probe

/**
 * The sample count and media duration (track timescale) of one progressive track's tables.
 * @param {Uint8Array} moov
 * @param {Box} trak
 * @param {TrackInfo} track
 * @returns {{ count: number, duration: number }}
 */
function progressiveTotals(moov, trak, track) {
  const reader = new ByteReader(moov);
  const stbl = findBox(moov, ["mdia", "minf", "stbl"], contentStart(trak), trak.end);
  if (stbl === null) return { count: 0, duration: track.durationTs };
  let count = 0;
  let duration = 0;
  let sawStts = false;
  for (const child of childBoxes(moov, stbl)) {
    const body = child.start + child.headerSize;
    if (child.type === "stsz" || child.type === "stz2") count = reader.u32(body + 8, "the stsz");
    if (child.type === "stts" && !sawStts) {
      sawStts = true;
      const entries = reader.u32(body + 4, "the stts");
      reader.need(body + 8, entries * 8, "the stts");
      for (let entry = 0; entry < entries; entry += 1) {
        duration += reader.u32(body + 8 + 8 * entry) * reader.u32(body + 12 + 8 * entry);
      }
    }
  }
  return { count, duration: sawStts ? duration : track.durationTs };
}

/**
 * What a finished file is: its tracks (kind, codec — the sample entry type, timescale, presented
 * duration, sample count), the longest track's duration, whether it is progressive (`moov`
 * before the first `mdat`, no `moof`, no `mvex`), fragmented, encrypted (`encv`, `enca`, `pssh`,
 * `senc`), truncated (it ends inside a box). Reads only box headers, the `moov` and, for a
 * fragmented file, each `moof`. A track's duration is its leading empty edit plus its media
 * duration (sum of `stts` or `trun` durations) minus the edit's `media_time`. A `Uint8Array` is
 * probed as an in-memory file. A file without a `moov` is `invalid`.
 * @param {Mp4File | Uint8Array} input
 * @returns {Promise<ProbeResult>}
 */
export async function probe(input) {
  const file = input instanceof Uint8Array ? memoryFile("buffer", input) : input;
  /** @type {InitInfo | null} */
  let init = null;
  /** @type {Map<number, { count: number, duration: number }>} */
  const fragmentTotals = new Map();
  let encrypted = false;
  const walk = await walkTopLevel(new WindowReader(file), (moof, at, moov) => {
    if (init === null) init = parseInit(moov);
    if (drmProblem(moof) !== null) encrypted = true;
    for (const fragment of parseFragments(moof, at, init.tracks)) {
      const totals = fragmentTotals.get(fragment.trackId) ?? { count: 0, duration: 0 };
      totals.count += fragment.samples.length;
      for (const sample of fragment.samples) totals.duration += sample.duration;
      fragmentTotals.set(fragment.trackId, totals);
    }
  });
  if (walk.moov === null) throw new Mp4Error("invalid", `${file.name}: no moov box: not an MP4`);
  const moov = walk.moov;
  const info = init ?? parseInit(moov);
  const moovBox = readBoxes(moov)[0];
  const traks =
    moovBox === undefined ? [] : childBoxes(moov, moovBox).filter((child) => child.type === "trak");
  const fragmented = info.fragmented || walk.moofCount > 0;
  /** @type {ProbeTrack[]} */
  const tracks = info.tracks.map((track, index) => {
    const trak = traks[index];
    const totals = fragmented
      ? (fragmentTotals.get(track.id) ?? { count: 0, duration: 0 })
      : trak === undefined
        ? { count: 0, duration: track.durationTs }
        : progressiveTotals(moov, trak, track);
    const presented = Math.max(0, totals.duration - track.edit.mediaTime) / track.timescale;
    return {
      id: track.id,
      kind: track.kind,
      codec: track.sampleEntryType,
      timescale: track.timescale,
      durationS: track.edit.emptyDuration / info.movieTimescale + presented,
      sampleCount: totals.count,
    };
  });
  const moovIndex = walk.boxes.findIndex((found) => found.type === "moov");
  const mdatIndex = walk.boxes.findIndex((found) => found.type === "mdat");
  const topPssh = walk.boxes.some((found) => found.type === "pssh");
  return {
    tracks,
    durationS: tracks.reduce((longest, track) => Math.max(longest, track.durationS), 0),
    progressive: !fragmented && (mdatIndex === -1 || moovIndex < mdatIndex),
    fragmented,
    encrypted: encrypted || topPssh || info.encrypted || drmProblem(moov) !== null,
    truncated: walk.truncated,
  };
}
