// @ts-check
// Unit tests of src/lib/ts.js: hand-built transport streams for every rule of the demuxer (PSI,
// PES, timestamps, access units, ADTS, problems), then the ffmpeg fixtures of
// tests/helpers/media.js checked against ffmpeg and ffprobe themselves (skipped without them,
// failed with STREAMFETCH_REQUIRE_TOOLS=1).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import {
  AAC_SAMPLE_RATES,
  TsDemuxer,
  audioSpecificConfig,
  buildAacStsd,
  buildAvcStsd,
  crc32Mpeg2,
  parseAdtsHeader,
  parseSps,
  tracksFromDemux,
  unescapeRbsp,
} from "../src/lib/ts.js";
import {
  SKIP_MESSAGE,
  avcConfig,
  boxPayload,
  concatBytes,
  dashFixture,
  encryptedFixture,
  ffmpeg,
  ffprobe,
  ffprobePackets,
  findBox,
  framemd5,
  hlsFmp4Fixture,
  hlsTsFixture,
  makeClip,
  md5Hex,
  mediaRoot,
  mediaSkip,
  mp4Boxes,
  readConcat,
  remuxToTs,
  scratchPath,
  sourceClip,
  trackBoxes,
} from "./helpers/media.js";

/** @typedef {import("../src/lib/ts.js").TrackKind} TrackKind */
/** @typedef {import("../src/lib/ts.js").DemuxTrack} DemuxTrack */
/** @typedef {import("../src/lib/ts.js").DemuxProblem} DemuxProblem */
/** @typedef {import("../src/lib/ts.js").DemuxStats} DemuxStats */
/** @typedef {import("../src/lib/ts.js").SpsInfo} SpsInfo */
/** @typedef {import("../src/lib/ts.js").AdtsHeader} AdtsHeader */

const MEDIA = { skip: mediaSkip(), timeout: 120_000 };

// ------------------------------------------------------------------------------ test tools

/**
 * A seeded PRNG (mulberry32): the same bytes on every run.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random bytes in [min, max] — a range without 0x00 keeps start codes out of NAL payloads.
 * @param {() => number} random
 * @param {number} length
 * @param {number} [min]
 * @param {number} [max]
 * @returns {Uint8Array}
 */
function randomBytes(random, length, min = 0, max = 255) {
  return Uint8Array.from({ length }, () => min + Math.floor(random() * (max - min + 1)));
}

/**
 * @typedef {object} Got One sample as a test sees it.
 * @property {TrackKind} kind
 * @property {number} dts
 * @property {number} cts
 * @property {boolean} sync
 * @property {Uint8Array} bytes
 */

/**
 * @typedef {object} DemuxResult
 * @property {Got[]} samples every sample, in emission order
 * @property {Got[]} video
 * @property {Got[]} audio
 * @property {Partial<Record<TrackKind, DemuxTrack>>} tracks
 * @property {DemuxProblem[]} problems
 * @property {string[]} events `track:video`, `sample:audio`, … in call order
 * @property {DemuxStats | null} stats
 */

/**
 * Demuxes `bytes` pushed in chunks of `chunk` bytes (whole by default), then flushes.
 * @param {Uint8Array} bytes
 * @param {number} [chunk]
 * @returns {DemuxResult}
 */
function demux(bytes, chunk = bytes.length || 1) {
  /** @type {DemuxResult} */
  const result = {
    samples: [],
    video: [],
    audio: [],
    tracks: {},
    problems: [],
    events: [],
    stats: null,
  };
  const demuxer = new TsDemuxer({
    onSample(kind, sample) {
      const got = { kind, ...sample };
      result.samples.push(got);
      result[kind].push(got);
      result.events.push(`sample:${kind}`);
    },
    onTrack(kind, info) {
      result.tracks[kind] = info;
      result.events.push(`track:${kind}`);
    },
    onProblem(code, params) {
      result.problems.push({ code, params });
      result.events.push(`problem:${code}`);
    },
  });
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    demuxer.push(bytes.subarray(offset, offset + chunk));
  }
  demuxer.flush();
  result.stats = demuxer.stats;
  return result;
}

/**
 * @param {DemuxResult} result
 * @returns {DemuxStats}
 */
function statsOf(result) {
  assert.ok(result.stats);
  return result.stats;
}

/**
 * A comparable digest of a demux: one line per sample.
 * @param {Got[]} samples
 * @returns {string[]}
 */
function digest(samples) {
  return samples.map((s) => `${s.kind} ${s.dts} ${s.cts} ${s.sync ? "K" : "-"} ${md5Hex(s.bytes)}`);
}

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} without trailing zero bytes
 */
function trimZeros(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return bytes.subarray(0, end);
}

/**
 * The NAL units of an Annex B byte stream (independent of the demuxer's own splitter).
 * @param {Uint8Array} bytes
 * @returns {Uint8Array[]}
 */
function annexBNals(bytes) {
  /** @type {Uint8Array[]} */
  const nals = [];
  let start = -1;
  let i = 0;
  while (i + 2 < bytes.length) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      if (start >= 0) nals.push(trimZeros(bytes.subarray(start, i)));
      start = i + 3;
      i += 3;
    } else {
      i += 1;
    }
  }
  if (start >= 0) nals.push(trimZeros(bytes.subarray(start)));
  return nals.filter((nal) => nal.length > 0);
}

/**
 * The NAL units of one AVCC sample (4-byte big-endian lengths); fails when the lengths do not
 * add up to the sample.
 * @param {Uint8Array} sample
 * @returns {Uint8Array[]}
 */
function avccNals(sample) {
  const view = new DataView(sample.buffer, sample.byteOffset, sample.byteLength);
  /** @type {Uint8Array[]} */
  const nals = [];
  let pos = 0;
  while (pos < sample.length) {
    assert.ok(pos + 4 <= sample.length, "a truncated NAL length");
    const length = view.getUint32(pos);
    assert.ok(pos + 4 + length <= sample.length, "a NAL longer than its sample");
    nals.push(sample.subarray(pos + 4, pos + 4 + length));
    pos += 4 + length;
  }
  return nals;
}

/**
 * @param {number} value
 * @returns {Uint8Array} big-endian 32 bits
 */
function u32be(value) {
  return Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

/**
 * @param {Uint8Array[]} nals
 * @returns {Uint8Array} an AVCC sample
 */
function avcc(nals) {
  return concatBytes(nals.flatMap((nal) => [u32be(nal.length), nal]));
}

/**
 * @param {Uint8Array} sample
 * @returns {number[]} the NAL unit types of an AVCC sample
 */
function nalTypes(sample) {
  return avccNals(sample).map((nal) => nal[0] & 0x1f);
}

// ------------------------------------------------------------------- building transport streams

/**
 * The 188-byte packets carrying `payload` on `pid`: the first with payload_unit_start, the last
 * filled out with adaptation-field stuffing.
 * @param {number} pid
 * @param {Uint8Array} payload
 * @param {{ cc?: number, unitStart?: boolean }} [options]
 * @returns {Uint8Array}
 */
function packetize(pid, payload, options = {}) {
  /** @type {Uint8Array[]} */
  const packets = [];
  let pos = 0;
  let counter = options.cc ?? 0;
  let first = options.unitStart ?? true;
  do {
    const packet = new Uint8Array(188);
    packet[0] = 0x47;
    packet[1] = (first ? 0x40 : 0) | ((pid >> 8) & 0x1f);
    packet[2] = pid & 0xff;
    const remaining = payload.length - pos;
    if (remaining >= 184) {
      packet[3] = 0x10 | (counter & 15);
      packet.set(payload.subarray(pos, pos + 184), 4);
      pos += 184;
    } else {
      const stuffing = 183 - remaining;
      packet[3] = 0x30 | (counter & 15);
      packet[4] = stuffing;
      if (stuffing > 0) {
        packet[5] = 0;
        packet.fill(0xff, 6, 5 + stuffing);
      }
      packet.set(payload.subarray(pos), 5 + stuffing);
      pos = payload.length;
    }
    counter += 1;
    first = false;
    packets.push(packet);
  } while (pos < payload.length);
  return concatBytes(packets);
}

/**
 * @param {Uint8Array} body a PSI section without its CRC
 * @returns {Uint8Array} the section with its CRC_32
 */
function withCrc(body) {
  return concatBytes([body, u32be(crc32Mpeg2(body))]);
}

/**
 * @param {number} pmtPid
 * @returns {Uint8Array} the PAT's packets
 */
function pat(pmtPid) {
  const length = 5 + 4 + 4;
  const body = [0x00, 0xb0 | (length >> 8), length & 0xff, 0, 1, 0xc1, 0, 0];
  body.push(0, 1, 0xe0 | (pmtPid >> 8), pmtPid & 0xff);
  return packetize(0, concatBytes([Uint8Array.of(0), withCrc(Uint8Array.from(body))]));
}

/**
 * @typedef {{ type: number, pid: number, descriptors?: Uint8Array }} PmtStream
 */

/**
 * @param {number} pmtPid
 * @param {PmtStream[]} streams
 * @param {{ corruptCrc?: boolean }} [options]
 * @returns {Uint8Array} the PMT's packets
 */
function pmt(pmtPid, streams, options = {}) {
  const entries = concatBytes(
    streams.map((s) => {
      const d = s.descriptors ?? new Uint8Array(0);
      const head = [s.type, 0xe0 | (s.pid >> 8), s.pid & 0xff, 0xf0 | (d.length >> 8)];
      return concatBytes([Uint8Array.of(...head, d.length & 0xff), d]);
    }),
  );
  const length = 9 + entries.length + 4;
  const pcr = streams[0]?.pid ?? 0x100;
  const head = [0x02, 0xb0 | (length >> 8), length & 0xff, 0, 1, 0xc1, 0, 0];
  head.push(0xe0 | (pcr >> 8), pcr & 0xff, 0xf0, 0);
  const section = withCrc(concatBytes([Uint8Array.from(head), entries]));
  if (options.corruptCrc) section[section.length - 1] ^= 0xff;
  return packetize(pmtPid, concatBytes([Uint8Array.of(0), section]));
}

/**
 * The five bytes of a PES timestamp field.
 * @param {number} prefix 2 (PTS only), 3 (PTS before a DTS), 1 (DTS)
 * @param {number} value 33 bits
 * @returns {Uint8Array}
 */
function timestampField(prefix, value) {
  const high = Math.floor(value / 2 ** 30) & 7;
  const low = value % 2 ** 30;
  return Uint8Array.of(
    (prefix << 4) | (high << 1) | 1,
    (low >> 22) & 0xff,
    (((low >> 15) & 0x7f) << 1) | 1,
    (low >> 7) & 0xff,
    ((low & 0x7f) << 1) | 1,
  );
}

/**
 * @param {number} value
 * @returns {number} the value modulo 2^33, as a PES carries it
 */
function wrap33(value) {
  return ((value % 2 ** 33) + 2 ** 33) % 2 ** 33;
}

/**
 * @typedef {object} PesOptions
 * @property {number} [pts]
 * @property {number} [dts] written only with a PTS
 * @property {boolean} [bounded] write PES_packet_length (else 0, unbounded)
 * @property {number} [streamId] default 0xE0 (video)
 */

/**
 * The packets of one PES packet on `pid`.
 * @param {number} pid
 * @param {Uint8Array} payload
 * @param {PesOptions} [options]
 * @returns {Uint8Array}
 */
function pes(pid, payload, options = {}) {
  /** @type {Uint8Array[]} */
  const fields = [];
  let flags = 0;
  if (options.pts !== undefined) {
    if (options.dts !== undefined) {
      flags = 0xc0;
      fields.push(timestampField(3, wrap33(options.pts)), timestampField(1, wrap33(options.dts)));
    } else {
      flags = 0x80;
      fields.push(timestampField(2, wrap33(options.pts)));
    }
  }
  const optional = concatBytes(fields);
  const length = options.bounded ? 3 + optional.length + payload.length : 0;
  const header = [0, 0, 1, options.streamId ?? 0xe0, length >> 8, length & 0xff, 0x80, flags];
  header.push(optional.length);
  return packetize(pid, concatBytes([Uint8Array.from(header), optional, payload]));
}

/**
 * An audio PES (stream id 0xC0).
 * @param {Uint8Array} payload
 * @param {PesOptions} [options]
 * @returns {Uint8Array}
 */
function audioPes(payload, options = {}) {
  return pes(AUDIO_PID, payload, { streamId: 0xc0, ...options });
}

const VIDEO_PID = 0x100;
const AUDIO_PID = 0x101;
const PMT_PID = 0x1000;
/** A Spanish ISO_639_language_descriptor. */
const SPANISH = Uint8Array.of(0x0a, 4, 0x73, 0x70, 0x61, 0);
/** The PSI of a stream with H.264 on VIDEO_PID and AAC on AUDIO_PID. */
const PSI = concatBytes([
  pat(PMT_PID),
  pmt(PMT_PID, [
    { type: 0x1b, pid: VIDEO_PID },
    { type: 0x0f, pid: AUDIO_PID, descriptors: SPANISH },
  ]),
]);

// ----------------------------------------------------------------------------- H.264 bits

/** Writes bits MSB first, with exp-Golomb codes. */
class BitWriter {
  /** @type {number[]} */
  bits = [];

  /**
   * @param {number} count
   * @param {number} value
   * @returns {BitWriter}
   */
  u(count, value) {
    for (let i = count - 1; i >= 0; i -= 1) this.bits.push(Math.floor(value / 2 ** i) % 2);
    return this;
  }

  /**
   * @param {number} value
   * @returns {BitWriter}
   */
  ue(value) {
    const code = value + 1;
    const length = Math.floor(Math.log2(code)) + 1;
    return this.u(length - 1, 0).u(length, code);
  }

  /**
   * @param {number} value
   * @returns {BitWriter}
   */
  se(value) {
    return this.ue(value > 0 ? 2 * value - 1 : -2 * value);
  }

  /** @returns {Uint8Array} the bits with rbsp_trailing_bits */
  rbsp() {
    const bits = [...this.bits, 1];
    while (bits.length % 8 !== 0) bits.push(0);
    return Uint8Array.from({ length: bits.length / 8 }, (_, i) =>
      bits.slice(i * 8, i * 8 + 8).reduce((byte, bit) => byte * 2 + bit, 0),
    );
  }
}

/**
 * A NAL unit from a header byte and an RBSP, with emulation prevention bytes inserted.
 * @param {number} header
 * @param {Uint8Array} rbsp
 * @returns {Uint8Array}
 */
function nalUnit(header, rbsp) {
  /** @type {number[]} */
  const out = [header];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

const HIGH = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

/**
 * @typedef {object} SpsSpec
 * @property {number} profile
 * @property {number} [constraint]
 * @property {number} [level]
 * @property {number} [id]
 * @property {number} [chroma]
 * @property {boolean} [separate]
 * @property {number} [bitDepth]
 * @property {(number[] | null)[]} [scaling] delta_scale lists by index; null = not present
 * @property {0 | 1 | 2} [poc]
 * @property {number[]} [pocCycle] offsets of a type-1 picture order count cycle
 * @property {number} widthMbs
 * @property {number} heightMapUnits
 * @property {boolean} [frameMbsOnly]
 * @property {[number, number, number, number]} [crop] left, right, top, bottom
 * @property {number} [maxFrameNum] log2_max_frame_num_minus4
 */

/**
 * @param {SpsSpec} spec
 * @returns {Uint8Array} an SPS NAL unit
 */
function buildSps(spec) {
  const w = new BitWriter();
  w.u(8, spec.profile).u(8, spec.constraint ?? 0).u(8, spec.level ?? 30).ue(spec.id ?? 0);
  if (HIGH.includes(spec.profile)) {
    const chroma = spec.chroma ?? 1;
    w.ue(chroma);
    if (chroma === 3) w.u(1, spec.separate ? 1 : 0);
    w.ue((spec.bitDepth ?? 8) - 8).ue((spec.bitDepth ?? 8) - 8).u(1, 0);
    if (spec.scaling) {
      w.u(1, 1);
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i += 1) {
        const list = spec.scaling[i] ?? null;
        w.u(1, list ? 1 : 0);
        if (list) for (const delta of list) w.se(delta);
      }
    } else {
      w.u(1, 0);
    }
  }
  w.ue(spec.maxFrameNum ?? 0);
  const poc = spec.poc ?? 0;
  w.ue(poc);
  if (poc === 0) w.ue(2);
  if (poc === 1) {
    w.u(1, 0).se(-2).se(5).ue((spec.pocCycle ?? []).length);
    for (const offset of spec.pocCycle ?? []) w.se(offset);
  }
  w.ue(1).u(1, 0).ue(spec.widthMbs - 1).ue(spec.heightMapUnits - 1);
  const frameMbsOnly = spec.frameMbsOnly ?? true;
  w.u(1, frameMbsOnly ? 1 : 0);
  if (!frameMbsOnly) w.u(1, 1);
  w.u(1, 1);
  if (spec.crop) {
    w.u(1, 1);
    for (const value of spec.crop) w.ue(value);
  } else {
    w.u(1, 0);
  }
  w.u(1, 0); // no VUI
  return nalUnit(0x67, w.rbsp());
}

const SPS = buildSps({
  profile: 66,
  constraint: 0xc0,
  level: 13,
  widthMbs: 20,
  heightMapUnits: 12,
  crop: [0, 0, 0, 6],
});
const PPS = Uint8Array.of(0x68, 0xce, 0x3c, 0x80);
const AUD = Uint8Array.of(0x09, 0xf0);
const SEI = Uint8Array.of(0x06, 0x05, 0x01, 0x42, 0x80);

/**
 * A slice NAL unit: `first_mb_in_slice` 0 (first bit 1) or not, then non-zero filler bytes.
 * @param {number} type 1 or 5
 * @param {boolean} first
 * @param {() => number} random
 * @param {number} [size]
 * @returns {Uint8Array}
 */
function slice(type, first, random, size = 40) {
  const head = Uint8Array.of(type === 5 ? 0x65 : 0x41, first ? 0x88 : 0x44);
  return concatBytes([head, randomBytes(random, size, 0x10, 0xfe)]);
}

/**
 * @param {Uint8Array[]} nals
 * @param {boolean} [fourByte] 4-byte start codes (else 3-byte after the first)
 * @returns {Uint8Array} Annex B bytes
 */
function annexB(nals, fourByte = true) {
  const long = Uint8Array.of(0, 0, 0, 1);
  const short = Uint8Array.of(0, 0, 1);
  return concatBytes(nals.flatMap((nal, i) => [fourByte || i === 0 ? long : short, nal]));
}

/**
 * The first IDR access unit of most hand-built streams.
 * @param {() => number} random
 * @returns {Uint8Array}
 */
function keyframe(random) {
  return annexB([AUD, SPS, PPS, slice(5, true, random)]);
}

/**
 * @param {() => number} random
 * @returns {Uint8Array} a P-picture access unit
 */
function picture(random) {
  return annexB([AUD, slice(1, true, random)]);
}

// ------------------------------------------------------------------------------- ADTS bits

/**
 * @typedef {object} AdtsOptions
 * @property {number} [sfi] sampling_frequency_index, default 3 (48 kHz)
 * @property {number} [channels] default 2
 * @property {number} [profile] default 1 (AAC-LC)
 * @property {boolean} [crc] a 9-byte header with a CRC
 * @property {number} [blocks] raw data blocks, default 1
 */

/**
 * @param {Uint8Array} payload
 * @param {AdtsOptions} [options]
 * @returns {Uint8Array} one ADTS frame
 */
function adts(payload, options = {}) {
  const crc = options.crc ?? false;
  const length = (crc ? 9 : 7) + payload.length;
  const sfi = options.sfi ?? 3;
  const channels = options.channels ?? 2;
  const header = [
    0xff,
    0xf0 | (crc ? 0 : 1),
    ((options.profile ?? 1) << 6) | (sfi << 2) | (channels >> 2),
    ((channels & 3) << 6) | (length >> 11),
    (length >> 3) & 0xff,
    ((length & 7) << 5) | 0x1f,
    0xfc | ((options.blocks ?? 1) - 1),
  ];
  if (crc) header.push(0x12, 0x34);
  return concatBytes([Uint8Array.from(header), payload]);
}

/**
 * The DecoderSpecificInfo of an `esds` payload (version/flags, then the descriptors).
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
function decoderSpecificInfo(payload) {
  let pos = 4;
  /** @returns {[number, number]} the tag and the length */
  const head = () => {
    const tag = payload[pos];
    pos += 1;
    let length = 0;
    for (;;) {
      const byte = payload[pos];
      pos += 1;
      length = length * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return [tag, length];
  };
  assert.equal(head()[0], 0x03);
  const flags = payload[pos + 2];
  pos += 3 + (flags & 0x80 ? 2 : 0) + (flags & 0x20 ? 2 : 0);
  assert.equal(head()[0], 0x04);
  pos += 13;
  const [tag, length] = head();
  assert.equal(tag, 0x05);
  return payload.subarray(pos, pos + length);
}

/**
 * @param {Uint8Array} haystack
 * @param {Uint8Array} needle
 * @param {number} [from]
 * @returns {number}
 */
function indexOfBytes(haystack, needle, from = 0) {
  outer: for (let i = from; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  throw new Error("not found");
}

// ================================================================================ pure tests

test("unescapeRbsp drops every emulation prevention byte and nothing else", () => {
  const escaped = Uint8Array.of(1, 0, 0, 3, 1, 0, 0, 3, 0, 3, 0, 0, 3);
  assert.deepEqual([...unescapeRbsp(escaped)], [1, 0, 0, 1, 0, 0, 0, 3, 0, 0]);
  assert.deepEqual([...unescapeRbsp(Uint8Array.of(0, 3, 0, 0, 4))], [0, 3, 0, 0, 4]);
});

test("parseSps reads the picture size of every SPS layout", () => {
  /** @type {[string, SpsSpec, Partial<SpsInfo>][]} */
  const cases = [
    [
      "baseline 4:2:0, bottom crop",
      {
        profile: 66,
        constraint: 0xc0,
        level: 13,
        widthMbs: 20,
        heightMapUnits: 12,
        crop: [0, 0, 0, 6],
      },
      { width: 320, height: 180, codec: "avc1.42c00d", chromaFormatIdc: 1 },
    ],
    [
      "main, no crop, POC type 2",
      { profile: 77, level: 31, widthMbs: 80, heightMapUnits: 45, poc: 2 },
      { width: 1280, height: 720, codec: "avc1.4d001f" },
    ],
    [
      "high with scaling lists, POC type 1, left/right crop",
      {
        profile: 100,
        level: 40,
        scaling: [[-8], Array(16).fill(1), null, [4, 4, -16], null, null, Array(64).fill(0), [-8]],
        poc: 1,
        pocCycle: [3, -1, 7],
        widthMbs: 120,
        heightMapUnits: 68,
        crop: [2, 2, 0, 4],
      },
      { width: 1912, height: 1080, profileIdc: 100, chromaFormatIdc: 1 },
    ],
    [
      "high 10",
      { profile: 110, bitDepth: 10, widthMbs: 20, heightMapUnits: 12, crop: [0, 0, 0, 6] },
      { width: 320, height: 180, bitDepthLuma: 10, bitDepthChroma: 10 },
    ],
    [
      "high 4:2:2 (CropUnitX 2, CropUnitY 1)",
      { profile: 122, chroma: 2, widthMbs: 21, heightMapUnits: 12, crop: [0, 3, 0, 2] },
      { width: 330, height: 190, chromaFormatIdc: 2 },
    ],
    [
      "high 4:4:4, 12 scaling lists (CropUnitX 1)",
      {
        profile: 244,
        chroma: 3,
        scaling: [...Array(11).fill(null), Array(64).fill(2)],
        widthMbs: 21,
        heightMapUnits: 12,
        crop: [0, 14, 0, 10],
      },
      { width: 322, height: 182, chromaFormatIdc: 3 },
    ],
    [
      "high 4:4:4, separate colour planes (ChromaArrayType 0)",
      {
        profile: 244,
        chroma: 3,
        separate: true,
        widthMbs: 21,
        heightMapUnits: 12,
        crop: [1, 1, 1, 1],
      },
      { width: 334, height: 190, separateColourPlane: true },
    ],
    [
      "interlaced 4:2:0 (field pairs: CropUnitY 4)",
      { profile: 100, widthMbs: 20, heightMapUnits: 6, frameMbsOnly: false, crop: [0, 0, 0, 3] },
      { width: 320, height: 180, frameMbsOnly: false },
    ],
    [
      "monochrome interlaced (CropUnitY 2)",
      {
        profile: 100,
        chroma: 0,
        widthMbs: 11,
        heightMapUnits: 5,
        frameMbsOnly: false,
        crop: [0, 0, 0, 8],
      },
      { width: 176, height: 144, chromaFormatIdc: 0 },
    ],
    [
      "a long log2_max_frame_num code",
      { profile: 66, widthMbs: 1, heightMapUnits: 1, maxFrameNum: 12, crop: [0, 0, 0, 0] },
      { width: 16, height: 16 },
    ],
  ];
  for (const [name, spec, expected] of cases) {
    const info = parseSps(buildSps(spec));
    assert.ok(info, `${name}: parsed`);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(info[/** @type {keyof SpsInfo} */ (key)], value, `${name}: ${key}`);
    }
  }
  // Two 65535s in a row put 32 zero bits together: the NAL needs an emulation prevention byte.
  const zeros = new BitWriter().u(8, 66).u(8, 0).u(8, 30).ue(0).ue(0).ue(0).ue(65535).ue(65535);
  zeros.u(1, 0).ue(0).ue(0).u(1, 1).u(1, 1).u(1, 0).u(1, 0);
  const escaped = nalUnit(0x67, zeros.rbsp());
  assert.ok(
    escaped.some((byte, i) => byte === 3 && escaped[i - 1] === 0 && escaped[i - 2] === 0),
    "the SPS carries an emulation prevention byte",
  );
  assert.equal(parseSps(escaped)?.width, 16);
});

test("parseSps returns null for anything that is not a valid SPS, never throws", () => {
  const sps = buildSps({ profile: 100, widthMbs: 20, heightMapUnits: 12 });
  assert.equal(parseSps(sps.subarray(0, 6)), null, "truncated");
  assert.equal(parseSps(PPS), null, "a PPS");
  assert.equal(parseSps(new Uint8Array(0)), null, "empty");
  assert.equal(parseSps(Uint8Array.of(0x67, 66, 0, 30, 0, 0, 0, 0, 0)), null, "zeros");
  const id32 = buildSps({ profile: 66, id: 32, widthMbs: 1, heightMapUnits: 1 });
  assert.equal(parseSps(id32), null, "seq_parameter_set_id > 31");
  const cropped = buildSps({ profile: 66, widthMbs: 1, heightMapUnits: 1, crop: [9, 0, 0, 0] });
  assert.equal(parseSps(cropped), null, "cropped away");
  assert.equal(parseSps(/** @type {Uint8Array} */ (/** @type {unknown} */ (null))), null);
  const random = prng(7);
  for (let i = 0; i < 500; i += 1) {
    const tail = randomBytes(random, 1 + Math.floor(random() * 40));
    const junk = concatBytes([Uint8Array.of(0x67), tail]);
    assert.doesNotThrow(() => parseSps(junk));
  }
});

test("buildAvcStsd writes an avc1 sample entry with the avcC of the parameter sets", () => {
  const info = /** @type {SpsInfo} */ (parseSps(SPS));
  const stsd = buildAvcStsd([SPS], [PPS], info);
  assert.equal(String.fromCharCode(...stsd.subarray(4, 8)), "stsd");
  assert.equal(new DataView(stsd.buffer).getUint32(0), stsd.length);
  assert.equal(new DataView(stsd.buffer).getUint32(12), 1, "one entry");
  const entry = findBox(stsd, ["stsd", "avc1"]);
  assert.ok(entry);
  const view = new DataView(stsd.buffer, entry.start);
  assert.equal(view.getUint16(14), 1, "data_reference_index");
  assert.equal(view.getUint16(32), 320, "width");
  assert.equal(view.getUint16(34), 180, "height");
  assert.equal(view.getUint16(82), 0x18, "depth");
  const avcCBox = findBox(stsd, ["stsd", "avc1", "avcC"]);
  assert.ok(avcCBox);
  const config = boxPayload(stsd, avcCBox);
  assert.deepEqual([...config.subarray(0, 6)], [1, 66, 0xc0, 13, 0xff, 0xe1]);
  assert.deepEqual([...config.subarray(6, 8)], [0, SPS.length]);
  assert.deepEqual([...config.subarray(8, 8 + SPS.length)], [...SPS]);
  const rest = [...config.subarray(8 + SPS.length)];
  assert.deepEqual(rest, [1, 0, PPS.length, ...PPS], "no High extension for Baseline");
  const high = buildSps({ profile: 110, bitDepth: 10, widthMbs: 20, heightMapUnits: 12 });
  const highStsd = buildAvcStsd([high], [PPS], /** @type {SpsInfo} */ (parseSps(high)));
  const highBox = findBox(highStsd, ["stsd", "avc1", "avcC"]);
  assert.ok(highBox);
  const extension = [...boxPayload(highStsd, highBox).slice(-4)];
  assert.deepEqual(extension, [0xfd, 0xfa, 0xfa, 0], "4:2:0, 10-bit luma and chroma");
  assert.throws(() => buildAvcStsd([], [PPS], info), RangeError);
});

test("ADTS headers, the AudioSpecificConfig and the mp4a sample entry", () => {
  const frame = adts(new Uint8Array(100), { sfi: 4, channels: 2, profile: 1 });
  const header = /** @type {AdtsHeader} */ (parseAdtsHeader(frame, 0));
  assert.deepEqual(header, {
    headerLength: 7,
    frameLength: 107,
    profile: 1,
    samplingFrequencyIndex: 4,
    sampleRate: 44100,
    channelConfiguration: 2,
    rawDataBlocks: 1,
  });
  assert.equal(parseAdtsHeader(adts(new Uint8Array(10), { crc: true }), 0)?.headerLength, 9);
  assert.equal(parseAdtsHeader(frame, 1), null, "not at a sync word");
  assert.equal(parseAdtsHeader(frame.subarray(0, 6), 0), null, "too short");
  assert.equal(parseAdtsHeader(adts(new Uint8Array(10), { sfi: 13 }), 0), null, "reserved rate");
  const layer = adts(new Uint8Array(10));
  layer[1] |= 0x02;
  assert.equal(parseAdtsHeader(layer, 0), null, "layer must be 0");
  assert.equal(parseAdtsHeader(adts(new Uint8Array(0)), 0), null, "a frame without a payload");
  assert.deepEqual([...audioSpecificConfig(header)], [0x12, 0x10], "AAC-LC 44.1 kHz stereo");
  const stsd = buildAacStsd(header);
  const entry = findBox(stsd, ["stsd", "mp4a"]);
  assert.ok(entry);
  const view = new DataView(stsd.buffer, entry.start);
  assert.equal(view.getUint16(24), 2, "channelcount");
  assert.equal(view.getUint16(26), 16, "samplesize");
  assert.equal(view.getUint32(32), 44100 * 65536, "samplerate 16.16");
  const esds = findBox(stsd, ["stsd", "mp4a", "esds"]);
  assert.ok(esds);
  assert.deepEqual([...decoderSpecificInfo(boxPayload(stsd, esds))], [0x12, 0x10]);
  const seven = parseAdtsHeader(adts(new Uint8Array(4), { sfi: 0, channels: 7 }), 0);
  const big = buildAacStsd(/** @type {AdtsHeader} */ (seven));
  const bigEntry = findBox(big, ["stsd", "mp4a"]);
  assert.ok(bigEntry);
  const bigView = new DataView(big.buffer, bigEntry.start);
  assert.equal(bigView.getUint16(24), 8, "7.1 is eight channels");
  assert.equal(bigView.getUint32(32), 0, "96 kHz does not fit 16.16");
});

test("crc32Mpeg2 has the CRC-32/MPEG-2 check value and zeroes a whole section", () => {
  assert.equal(crc32Mpeg2(new TextEncoder().encode("123456789")), 0x0376e6e7);
  const section = withCrc(Uint8Array.of(0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0));
  assert.equal(crc32Mpeg2(section), 0);
});

// ====================================================================== hand-built streams

test("a hand-built stream: tracks before samples, AVCC units, IDR sync, AAC, language", () => {
  const random = prng(1);
  const idr = slice(5, true, random, 300);
  const p1 = slice(1, true, random);
  const p2 = slice(1, true, random);
  const frames = [randomBytes(random, 120), randomBytes(random, 90), randomBytes(random, 200)];
  const stream = concatBytes([
    PSI,
    pes(VIDEO_PID, annexB([AUD, SPS, PPS, SEI, idr]), { pts: 93600, dts: 90000 }),
    audioPes(concatBytes(frames.map((f) => adts(f))), { pts: 90000 }),
    pes(VIDEO_PID, annexB([AUD, p1], false), { pts: 99600, dts: 93600 }),
    pes(VIDEO_PID, annexB([AUD, p2]), { pts: 96600, dts: 96600 }),
  ]);
  const result = demux(stream);
  assert.deepEqual(result.problems, []);
  assert.equal(result.events[0], "track:video");
  assert.equal(result.events.indexOf("track:audio"), result.events.indexOf("sample:audio") - 1);
  assert.deepEqual(
    result.video.map((s) => [s.dts, s.cts, s.sync]),
    [
      [90000, 3600, true],
      [93600, 6000, false],
      [96600, 0, false],
    ],
  );
  assert.deepEqual(nalTypes(result.video[0].bytes), [7, 8, 6, 5], "AUD dropped, the rest kept");
  assert.deepEqual([...result.video[0].bytes], [...avcc([SPS, PPS, SEI, idr])]);
  assert.deepEqual([...result.video[1].bytes], [...avcc([p1])], "after a 3-byte start code");
  assert.deepEqual(
    result.audio.map((s) => [s.dts, s.cts, s.sync]),
    [
      [48000, 0, true],
      [49024, 0, true],
      [50048, 0, true],
    ],
  );
  assert.deepEqual(
    result.audio.map((s) => [...s.bytes]),
    frames.map((f) => [...f]),
  );
  const video = /** @type {DemuxTrack} */ (result.tracks.video);
  assert.deepEqual(
    [video.timescale, video.width, video.height, video.codec, video.language],
    [90000, 320, 180, "avc1.42c00d", "und"],
  );
  const audio = /** @type {DemuxTrack} */ (result.tracks.audio);
  assert.deepEqual(
    [audio.timescale, audio.sampleRate, audio.channelCount, audio.language, audio.codec],
    [48000, 48000, 2, "spa", "mp4a.40.2"],
  );
  assert.equal(statsOf(result).videoSamples, 3);
  assert.equal(statsOf(result).audioSamples, 3);
});

test("no AUDs: a new access unit at first_mb_in_slice 0 or an SEI/SPS/PPS after a slice", () => {
  const random = prng(2);
  const idrA = slice(5, true, random);
  const idrB = slice(5, false, random);
  const pA = slice(1, true, random);
  const pB = slice(1, false, random);
  const p2 = slice(1, true, random);
  const p3 = slice(1, true, random);
  // One PES per picture, but the PES boundaries fall inside start codes and NAL units: the demuxer
  // must split on the NAL rules, not on the PES packets.
  const es = annexB([SPS, PPS, idrA, idrB, SEI, pA, pB, p2, SPS, PPS, p3]);
  const cut1 = indexOfBytes(es, SEI) - 2; // inside the start code before the SEI
  const cut2 = indexOfBytes(es, p2) - 1;
  const cut3 = indexOfBytes(es, p3, indexOfBytes(es, p2) + 1) - 30; // inside the second SPS/PPS
  const stream = concatBytes([
    PSI,
    pes(VIDEO_PID, es.subarray(0, cut1), { pts: 0 }),
    pes(VIDEO_PID, es.subarray(cut1, cut2), { pts: 3000 }),
    pes(VIDEO_PID, es.subarray(cut2, cut3), { pts: 6000 }),
    pes(VIDEO_PID, es.subarray(cut3), { pts: 9000 }),
  ]);
  const result = demux(stream);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(
    result.video.map((s) => nalTypes(s.bytes)),
    [[7, 8, 5, 5], [6, 1, 1], [1], [7, 8, 1]],
  );
  assert.deepEqual([...result.video[1].bytes], [...avcc([SEI, pA, pB])]);
  assert.deepEqual(
    result.video.map((s) => s.dts),
    [0, 3000, 6000, 9000],
  );
  assert.deepEqual(
    result.video.map((s) => s.sync),
    [true, false, false, false],
  );
});

test("several access units in one PES: the first takes its timestamps, the next follow", () => {
  const random = prng(3);
  const two = annexB([AUD, SPS, PPS, slice(5, true, random), AUD, slice(1, true, random)]);
  const stream = concatBytes([
    PSI,
    pes(VIDEO_PID, two, { pts: 1000 }),
    pes(VIDEO_PID, picture(random), { pts: 4600 }),
    pes(VIDEO_PID, concatBytes([picture(random), picture(random)])),
  ]);
  const result = demux(stream);
  assert.deepEqual(
    result.video.map((s) => s.dts),
    [1000, 4000, 4600, 5200, 5800],
  );
});

test("33-bit timestamps are unwrapped across 2^33, on both streams", () => {
  const random = prng(4);
  const start = 2 ** 33 - 9000;
  /** @type {Uint8Array[]} */
  const parts = [PSI];
  for (let k = 0; k < 6; k += 1) {
    const dts = start + k * 3000;
    const unit = k === 0 ? keyframe(random) : picture(random);
    parts.push(pes(VIDEO_PID, unit, { pts: dts + 3000, dts }));
    parts.push(audioPes(adts(randomBytes(random, 50)), { pts: start + k * 1920 }));
  }
  const result = demux(concatBytes(parts));
  assert.deepEqual(result.problems, []);
  const ks = [0, 1, 2, 3, 4, 5];
  assert.deepEqual(
    result.video.map((s) => s.dts),
    ks.map((k) => start + k * 3000),
  );
  assert.ok(result.video.every((s) => s.cts === 3000));
  const audioStart = Math.round((start * 48000) / 90000);
  assert.deepEqual(
    result.audio.map((s) => s.dts),
    ks.map((k) => audioStart + k * 1024),
  );
});

test("ADTS frames across PES packets: +1024 per frame, the PTS on the frame starting in it", () => {
  const random = prng(5);
  const sizes = [150, 600, 90, 300, 220, 180, 400, 75];
  const payloads = sizes.map((size) => randomBytes(random, size, 0, 0xfe));
  const frames = payloads.map((p, i) => adts(p, { crc: i % 3 === 0 }));
  const es = concatBytes(frames);
  /** @param {number} k */
  const startOf = (k) => frames.slice(0, k).reduce((sum, f) => sum + f.length, 0);
  /** @param {number} k */
  const t90 = (k) => 180000 + k * 1920;
  const gap = 10 * 1920;
  // PES 1: frame 0 and the head of frame 1 (which then spans PES 2 and 3)
  // PES 2: the middle of frame 1 — no frame starts in it, its PTS is unused
  // PES 3: the tail of frame 1, frames 2–3, the head of frame 4 — frame 2's PTS, one tick off
  // PES 4: the tail of frame 4, the head of frame 5 — a PTS 10 frames ahead for frame 5 (a gap);
  //        frame 5 is incomplete there and carries that PTS into PES 5
  // PES 5: the tail of frame 5, frames 6 and 7 — frame 6's PTS after the gap
  const cuts = [0, startOf(1) + 40, startOf(1) + 300, startOf(4) + 100, startOf(5) + 50, es.length];
  const pts = [t90(0), 0, t90(2) + 1, t90(5) + gap, t90(6) + gap];
  const stream = concatBytes([
    PSI,
    ...pts.map((value, i) => audioPes(es.subarray(cuts[i], cuts[i + 1]), { pts: value })),
  ]);
  const result = demux(stream);
  assert.deepEqual(result.problems, []);
  const base = (180000 * 48000) / 90000;
  const expected = [0, 1, 2, 3, 4].map((k) => base + k * 1024);
  expected.push(...[5, 6, 7].map((k) => base + (k + 10) * 1024));
  assert.deepEqual(
    result.audio.map((s) => s.dts),
    expected,
  );
  assert.deepEqual(
    result.audio.map((s) => [...s.bytes]),
    payloads.map((p) => [...p]),
    "the CRC is not part of the frame",
  );
});

test("audio before the first PTS is dropped; a jump backwards is reported, the clock kept", () => {
  const random = prng(6);
  const frame = () => adts(randomBytes(random, 60, 0, 0xfe));
  const stream = concatBytes([
    PSI,
    audioPes(frame()),
    audioPes(concatBytes([frame(), frame()]), { pts: 9000 }),
    audioPes(frame(), { pts: 9000 }),
  ]);
  const result = demux(stream);
  assert.deepEqual(
    result.audio.map((s) => s.dts),
    [4800, 5824, 6848],
  );
  assert.equal(statsOf(result).droppedAudioFrames, 1);
  assert.deepEqual(result.problems, [
    { code: "corrupt_stream", params: { detail: "audio timestamps that go backwards" } },
  ]);
});

test("a PES with a declared length is emitted before the next one starts", () => {
  const random = prng(7);
  /** @type {TrackKind[]} */
  const kinds = [];
  const demuxer = new TsDemuxer({
    onSample: (kind) => kinds.push(kind),
    onTrack: () => {},
    onProblem: () => {},
  });
  const frames = concatBytes([adts(randomBytes(random, 30)), adts(randomBytes(random, 30))]);
  demuxer.push(concatBytes([PSI, audioPes(frames, { pts: 0, bounded: true })]));
  assert.deepEqual(kinds, ["audio", "audio"]);
});

test("video before the first IDR with its SPS and PPS cannot be decoded and is dropped", () => {
  const random = prng(8);
  const stream = concatBytes([
    PSI,
    pes(VIDEO_PID, picture(random), { pts: 0 }),
    pes(VIDEO_PID, annexB([AUD, PPS, slice(5, true, random)]), { pts: 3000 }),
    pes(VIDEO_PID, keyframe(random), { pts: 6000 }),
    pes(VIDEO_PID, picture(random), { pts: 9000 }),
  ]);
  const result = demux(stream);
  assert.deepEqual(
    result.video.map((s) => [s.dts, s.sync]),
    [
      [6000, true],
      [9000, false],
    ],
  );
  assert.equal(statsOf(result).droppedVideoUnits, 2);
  assert.deepEqual(result.problems, []);
});

test("decode timestamps that do not increase are made increasing and reported once", () => {
  const random = prng(9);
  const stream = concatBytes([
    PSI,
    pes(VIDEO_PID, keyframe(random), { pts: 6000 }),
    pes(VIDEO_PID, picture(random), { pts: 6000 }),
    pes(VIDEO_PID, picture(random), { pts: 3000 }),
    pes(VIDEO_PID, picture(random), { pts: 12000 }),
  ]);
  const result = demux(stream);
  assert.deepEqual(
    result.video.map((s) => [s.dts, s.cts]),
    [
      [6000, 0],
      [6001, 0],
      [6002, 0],
      [12000, 0],
    ],
  );
  assert.deepEqual(result.problems, [
    { code: "corrupt_stream", params: { detail: "video decode timestamps that do not increase" } },
  ]);
});

test("unsupported codecs are reported once per stream; data streams are ignored", () => {
  const random = prng(10);
  /** @param {string} format */
  const registration = (format) =>
    Uint8Array.of(0x05, 4, ...[...format].map((c) => c.charCodeAt(0)));
  const english = Uint8Array.of(0x0a, 4, 0x65, 0x6e, 0x67, 0);
  const longDescriptors = concatBytes(Array.from({ length: 40 }, () => english));
  const teletext = Uint8Array.of(0x56, 5, 0x65, 0x6e, 0x67, 0x09, 0x00);
  const streams = [
    { type: 0x1b, pid: VIDEO_PID },
    { type: 0x0f, pid: AUDIO_PID, descriptors: longDescriptors },
    { type: 0x24, pid: 0x102 },
    { type: 0x15, pid: 0x103, descriptors: registration("ID3 ") },
    { type: 0x86, pid: 0x104 },
    { type: 0x06, pid: 0x105, descriptors: registration("AC-3") },
    { type: 0x06, pid: 0x106, descriptors: teletext },
    { type: 0x81, pid: 0x107 },
    { type: 0x1b, pid: 0x108 },
  ];
  const table = pmt(PMT_PID, streams);
  assert.ok(table.length > 188, "the PMT spans two packets");
  const stream = concatBytes([
    pat(PMT_PID),
    table,
    pes(VIDEO_PID, keyframe(random), { pts: 0 }),
    pes(0x102, randomBytes(random, 400), { pts: 0 }),
    pat(PMT_PID),
    table,
    audioPes(adts(randomBytes(random, 40)), { pts: 0 }),
    pat(PMT_PID),
    table,
  ]);
  const result = demux(stream);
  assert.deepEqual(result.problems, [
    { code: "unsupported_codec", params: { stream_type: "0x24", codec: "HEVC", pid: 0x102 } },
    {
      code: "unsupported_codec",
      params: { stream_type: "0x06", codec: "private data", pid: 0x105 },
    },
    { code: "unsupported_codec", params: { stream_type: "0x81", codec: "AC-3", pid: 0x107 } },
  ]);
  assert.equal(result.video.length, 1);
  assert.equal(result.audio.length, 1);
  assert.equal(result.tracks.audio?.language, "eng");
});

test("AAC the MP4 track cannot carry: a configuration change, several raw data blocks", () => {
  const random = prng(11);
  const frames = [
    adts(randomBytes(random, 40)),
    adts(randomBytes(random, 40), { sfi: 4 }),
    adts(randomBytes(random, 40), { blocks: 2 }),
    adts(randomBytes(random, 40)),
  ];
  const result = demux(concatBytes([PSI, audioPes(concatBytes(frames), { pts: 0 })]));
  assert.deepEqual(
    result.audio.map((s) => s.dts),
    [0, 1024],
  );
  assert.equal(statsOf(result).droppedAudioFrames, 2);
  assert.deepEqual(
    result.problems.map((p) => p.code),
    ["corrupt_stream", "unsupported_codec"],
  );
  assert.equal(result.problems[1].params.stream_type, "0x0f");
});

test("malformed input never throws: junk, transport errors, scrambling, bad CRCs and PES", () => {
  const random = prng(12);
  const tei = packetize(VIDEO_PID, randomBytes(random, 100));
  tei[1] |= 0x80;
  const scrambled = packetize(VIDEO_PID, randomBytes(random, 100));
  scrambled[3] |= 0x80;
  const noStartCode = packetize(VIDEO_PID, randomBytes(random, 150, 1, 0xfe));
  const badPmt = pmt(PMT_PID, [{ type: 0x24, pid: VIDEO_PID }], { corruptCrc: true });
  const stream = concatBytes([
    PSI,
    pes(VIDEO_PID, keyframe(random), { pts: 0 }),
    tei,
    scrambled,
    noStartCode,
    badPmt,
    pes(VIDEO_PID, picture(random), { pts: 3000 }),
  ]);
  const result = demux(stream);
  assert.deepEqual(
    result.video.map((s) => s.dts),
    [0, 3000],
  );
  assert.equal(result.problems.length, 1, "reported once");
  assert.equal(result.problems[0].code, "corrupt_stream");
  assert.ok(statsOf(result).corruptEvents >= 4, `corrupt events: ${statsOf(result).corruptEvents}`);
  for (let i = 0; i < 40; i += 1) {
    const junk = randomBytes(random, 1 + Math.floor(random() * 5000));
    if (i % 2 === 0) for (let j = 0; j < junk.length; j += 188) junk[j] = 0x47;
    const chunk = 1 + Math.floor(random() * 300);
    assert.doesNotThrow(() => demux(concatBytes([PSI, junk]), chunk));
  }
  const empty = demux(new Uint8Array(0));
  assert.deepEqual([empty.samples.length, empty.problems.length], [0, 0]);
  const demuxer = new TsDemuxer({ onSample: () => {}, onTrack: () => {}, onProblem: () => {} });
  const notBytes = /** @type {Uint8Array} */ (/** @type {unknown} */ ("not bytes"));
  assert.doesNotThrow(() => demuxer.push(notBytes));
});

test("tracksFromDemux turns the hooks into TrackPlans whose sample data the store placed", () => {
  const random = prng(13);
  /** @type {Record<TrackKind, number>} */
  const sizes = { video: 0, audio: 0 };
  /** @type {string[]} */
  const seen = [];
  const collector = tracksFromDemux(
    (kind, bytes) => {
      const offset = sizes[kind];
      sizes[kind] += bytes.length;
      return { file: `work/k.${kind}.bin`, offset };
    },
    (code) => seen.push(code),
  );
  const demuxer = new TsDemuxer(collector.hooks);
  const twoFrames = concatBytes([adts(randomBytes(random, 30)), adts(randomBytes(random, 31))]);
  demuxer.push(
    concatBytes([
      PSI,
      audioPes(twoFrames, { pts: 90000 }),
      pes(VIDEO_PID, keyframe(random), { pts: 93000, dts: 90000 }),
      pes(VIDEO_PID, picture(random), { pts: 96000, dts: 93000 }),
      pes(0x777, randomBytes(random, 10)),
      pmt(PMT_PID, [
        { type: 0x1b, pid: VIDEO_PID },
        { type: 0x0f, pid: AUDIO_PID },
        { type: 0x03, pid: 0x102 },
      ]),
    ]),
  );
  demuxer.flush();
  const plans = collector.plans();
  assert.deepEqual(
    plans.map((p) => p.kind),
    ["video", "audio"],
  );
  const [video, audio] = plans;
  assert.deepEqual(
    [video.timescale, video.width, video.height, video.language],
    [90000, 320, 180, "und"],
  );
  assert.deepEqual(
    [audio.timescale, audio.sampleRate, audio.channelCount, audio.language],
    [48000, 48000, 2, "spa"],
  );
  assert.deepEqual(
    video.samples.map((s) => [s.dts, s.cts, s.sync, s.data.file, s.data.offset]),
    [
      [90000, 3000, true, "work/k.video.bin", 0],
      [93000, 3000, false, "work/k.video.bin", video.samples[0].size],
    ],
  );
  assert.deepEqual(
    audio.samples.map((s) => [s.dts, s.size, s.data.offset]),
    [
      [48000, 30, 0],
      [49024, 31, 30],
    ],
  );
  assert.equal(String.fromCharCode(...video.stsd.subarray(4, 8)), "stsd");
  assert.deepEqual(collector.problems, [
    {
      code: "unsupported_codec",
      params: { stream_type: "0x03", codec: "MPEG-1 audio (MP3)", pid: 0x102 },
    },
  ]);
  assert.deepEqual(seen, ["unsupported_codec"]);
  assert.deepEqual(tracksFromDemux(() => ({ file: "x", offset: 0 })).plans(), []);
});

// ========================================================================== ffmpeg fixtures

/** @type {DemuxResult | null} */
let fixtureResult = null;

/**
 * The HLS TS fixture's segments concatenated (the downloader's one demuxer per download), the
 * concatenation written to a file for ffprobe, and its demux (whole, computed once).
 * @returns {{ bytes: Uint8Array, file: string, result: DemuxResult }}
 */
function fixtureDemux() {
  const bytes = readConcat(hlsTsFixture().segments);
  const file = scratchPath("hls-ts-all.ts");
  writeFileSync(file, bytes);
  if (fixtureResult === null) fixtureResult = demux(bytes);
  return { bytes, file, result: fixtureResult };
}

test("media tests are skipped with the agreed message when ffmpeg is missing", () => {
  assert.equal(SKIP_MESSAGE, "ffmpeg not found: media tests not run");
  assert.ok(MEDIA.skip === false || MEDIA.skip === SKIP_MESSAGE);
});

test("the ffmpeg TS fixture demuxes to the same samples whatever the chunking", MEDIA, () => {
  const { bytes, result } = fixtureDemux();
  assert.deepEqual(result.problems, []);
  assert.equal(statsOf(result).skippedBytes, 0);
  const reference = digest(result.samples);
  for (const chunk of [1, 187, 188, 1000, 65536]) {
    assert.deepEqual(digest(demux(bytes, chunk).samples), reference, `chunks of ${chunk} bytes`);
  }
  for (const segment of hlsTsFixture().segments) {
    assert.equal(readFileSync(segment).length % 188, 0);
  }
});

test("video samples as Annex B equal h264_mp4toannexb's output, decode as src.mp4", MEDIA, () => {
  const { result } = fixtureDemux();
  const src = sourceClip();
  const raw = scratchPath("src-annexb.h264");
  const bsf = ["-bsf:v", "h264_mp4toannexb"];
  ffmpeg(["-i", src, "-map", "0:v:0", "-c:v", "copy", ...bsf, "-f", "h264", raw]);
  const reference = annexBNals(readFileSync(raw)).filter((nal) => ![9, 12].includes(nal[0] & 0x1f));
  const mine = result.video.flatMap((s) => avccNals(s.bytes));
  assert.deepEqual(
    mine.map((nal) => nal[0] & 0x1f),
    reference.map((nal) => nal[0] & 0x1f),
    "NAL types",
  );
  assert.deepEqual(mine.map(md5Hex), reference.map(md5Hex), "NAL bytes");
  const rebuilt = scratchPath("demuxed.h264");
  const startCode = Uint8Array.of(0, 0, 0, 1);
  writeFileSync(rebuilt, concatBytes(mine.flatMap((nal) => [startCode, nal])));
  assert.deepEqual(
    framemd5(rebuilt, { inputFormat: "h264" }),
    framemd5(src, { stream: "v:0" }),
    "decoded frames",
  );
});

test("AAC samples are src.mp4's packets; with ADTS headers, framemd5-equal", MEDIA, () => {
  const { result } = fixtureDemux();
  const src = sourceClip();
  assert.deepEqual(
    result.audio.map((s) => md5Hex(s.bytes)),
    framemd5(src, { stream: "a:0", copy: true }),
  );
  const track = /** @type {DemuxTrack} */ (result.tracks.audio);
  /** @type {AdtsOptions} */
  const options = {
    sfi: AAC_SAMPLE_RATES.indexOf(/** @type {number} */ (track.sampleRate)),
    channels: track.channelCount ?? 0,
    profile: Number(track.codec.split(".")[2]) - 1,
  };
  const rebuilt = scratchPath("demuxed.aac");
  writeFileSync(rebuilt, concatBytes(result.audio.map((s) => adts(s.bytes, options))));
  const decoded = framemd5(rebuilt, { stream: "a:0", inputFormat: "aac" });
  assert.deepEqual(decoded, framemd5(src, { stream: "a:0", ignoreEditList: true }));
  assert.deepEqual(
    decoded.slice(1),
    framemd5(src, { stream: "a:0" }),
    "with its edit list, ffmpeg skips the priming frame of src.mp4",
  );
});

test("sample counts and timestamps equal ffprobe's for the TS", MEDIA, () => {
  const { file, result } = fixtureDemux();
  const probe = ffprobe(file, { countPackets: true });
  /** @param {string} type */
  const count = (type) => probe.streams.find((s) => s.codec_type === type)?.nb_read_packets;
  assert.equal(result.video.length, count("video"));
  assert.equal(result.audio.length, count("audio"));
  assert.equal(result.video.length, 150);
  assert.deepEqual(
    result.video.map((s) => [s.dts, s.dts + s.cts, s.sync]),
    ffprobePackets(file, "v:0").map((p) => [p.dts, p.pts, p.keyframe]),
  );
  const rate = /** @type {number} */ (result.tracks.audio?.sampleRate);
  assert.deepEqual(
    result.audio.map((s) => (s.dts * 90000) / rate),
    ffprobePackets(file, "a:0").map((p) => p.pts),
  );
});

test("the sample entries match src.mp4's: avcC byte for byte, the ASC, the sizes", MEDIA, () => {
  const { result } = fixtureDemux();
  const src = readFileSync(sourceClip());
  const video = /** @type {DemuxTrack} */ (result.tracks.video);
  const avcC = findBox(video.stsd, ["stsd", "avc1", "avcC"]);
  assert.ok(avcC);
  assert.deepEqual([...boxPayload(video.stsd, avcC)], [...(avcConfig(src) ?? [])]);
  const audio = /** @type {DemuxTrack} */ (result.tracks.audio);
  const mine = findBox(audio.stsd, ["stsd", "mp4a", "esds"]);
  assert.ok(mine);
  const theirs = trackBoxes(src)
    .map((trak) => findBox(src, ["mdia", "minf", "stbl", "stsd", "mp4a", "esds"], trak))
    .find((box) => box !== null);
  assert.ok(theirs);
  // ffmpeg's encoder adds the explicit "no SBR" sync extension (0x2b7) after the two bytes ADTS
  // can tell; the demuxer never claims what ADTS does not say (HE-AAC in ADTS is implicit).
  assert.deepEqual(
    [...decoderSpecificInfo(boxPayload(audio.stsd, mine))],
    [...decoderSpecificInfo(boxPayload(src, theirs)).subarray(0, 2)],
  );
  const probe = ffprobe(sourceClip());
  const v = probe.streams.find((s) => s.codec_type === "video");
  const a = probe.streams.find((s) => s.codec_type === "audio");
  assert.deepEqual([video.width, video.height], [v?.width, v?.height]);
  assert.deepEqual([audio.sampleRate, audio.channelCount], [a?.sample_rate, a?.channels]);
});

test("B-frames, High, 44.1 kHz stereo: timestamps as ffprobe's, avcC as the MP4's", MEDIA, () => {
  const mp4 = makeClip(mediaRoot(), "bframes", {
    size: "318x178",
    rate: 30,
    preset: "veryfast",
    bframes: 2,
    sampleRate: 44100,
    channels: 2,
  });
  const ts = remuxToTs(mp4);
  const result = demux(readFileSync(ts), 4096);
  assert.deepEqual(result.problems, []);
  const packets = ffprobePackets(ts, "v:0");
  assert.ok(packets.some((p) => p.pts !== p.dts), "the clip has B-frames");
  assert.deepEqual(
    result.video.map((s) => [s.dts, s.dts + s.cts, s.sync]),
    packets.map((p) => [p.dts, p.pts, p.keyframe]),
  );
  assert.ok(result.video.every((s) => s.cts >= 0));
  const video = /** @type {DemuxTrack} */ (result.tracks.video);
  assert.equal(video.codec.slice(0, 7), "avc1.64", "High profile");
  assert.deepEqual([video.width, video.height], [318, 178]);
  const avcC = findBox(video.stsd, ["stsd", "avc1", "avcC"]);
  assert.ok(avcC);
  assert.deepEqual(
    [...boxPayload(video.stsd, avcC)],
    [...(avcConfig(readFileSync(mp4)) ?? [])],
    "with the High extension",
  );
  const audio = /** @type {DemuxTrack} */ (result.tracks.audio);
  assert.deepEqual([audio.sampleRate, audio.channelCount, audio.timescale], [44100, 2, 44100]);
  const audioPackets = ffprobePackets(ts, "a:0");
  assert.equal(result.audio.length, audioPackets.length);
  result.audio.forEach((s, i) => {
    const mine = (s.dts * 90000) / 44100;
    const theirs = /** @type {number} */ (audioPackets[i].pts);
    assert.ok(Math.abs(mine - theirs) <= 2, `audio frame ${i}: ${mine} vs ${theirs}`);
  });
  assert.deepEqual(
    result.audio.map((s) => md5Hex(s.bytes)),
    framemd5(mp4, { stream: "a:0", copy: true }),
  );
});

test("the SPS of x264's layouts gives ffprobe's picture size", MEDIA, () => {
  /** @type {[string, import("./helpers/media.js").ClipOptions][]} */
  const layouts = [
    ["high-420", { size: "318x178", preset: "veryfast" }],
    ["high-422", { size: "330x190", preset: "veryfast", pixFmt: "yuv422p" }],
    ["high-444", { size: "322x182", preset: "veryfast", pixFmt: "yuv444p" }],
    ["high-10", { size: "320x180", preset: "veryfast", pixFmt: "yuv420p10le" }],
    ["gray", { size: "176x144", preset: "veryfast", pixFmt: "gray" }],
    ["interlaced", { size: "320x180", preset: "veryfast", videoArgs: ["-flags", "+ildct+ilme"] }],
    ["baseline-odd", { size: "100x60" }],
  ];
  for (const [name, options] of layouts) {
    const file = makeClip(mediaRoot(), `sps-${name}`, {
      ...options,
      seconds: 0.2,
      format: "h264",
      audio: null,
    });
    const sps = annexBNals(readFileSync(file)).find((nal) => (nal[0] & 0x1f) === 7);
    assert.ok(sps, `${name}: an SPS`);
    const info = parseSps(sps);
    const stream = ffprobe(file).streams[0];
    assert.deepEqual([info?.width, info?.height], [stream.width, stream.height], name);
  }
});

test("MP3 audio is unsupported_codec 0x03, AC-3 is 0x81; the video is still demuxed", MEDIA, () => {
  /** @type {["mp3" | "ac3", string][]} */
  const cases = [
    ["mp3", "0x03"],
    ["ac3", "0x81"],
  ];
  for (const [audio, type] of cases) {
    const ts = makeClip(mediaRoot(), `codec-${audio}`, { audio, format: "mpegts", seconds: 1 });
    const result = demux(readFileSync(ts), 1000);
    assert.deepEqual(
      result.problems.map((p) => [p.code, p.params.stream_type]),
      [["unsupported_codec", type]],
      audio,
    );
    assert.equal(result.audio.length, 0);
    assert.equal(result.tracks.audio, undefined);
    assert.equal(result.video.length, ffprobePackets(ts, "v:0").length);
  }
});

test("junk between packets costs no sample; junk inside packets never throws", MEDIA, () => {
  const { bytes, result } = fixtureDemux();
  const reference = digest(result.samples);
  const random = prng(14);
  /** @param {number} length junk without a sync byte */
  const junk = (length) =>
    Uint8Array.from(randomBytes(random, length), (b) => (b === 0x47 ? 0x46 : b));
  const before = demux(concatBytes([junk(1000), bytes]), 1000);
  assert.deepEqual(digest(before.samples), reference);
  assert.deepEqual(
    before.problems.map((p) => p.code),
    ["corrupt_stream"],
  );
  assert.equal(statsOf(before).skippedBytes, 1000);
  const between = demux(
    concatBytes([
      bytes.subarray(0, 188 * 100),
      junk(50),
      bytes.subarray(188 * 100, 188 * 600),
      junk(7),
      bytes.subarray(188 * 600),
    ]),
    333,
  );
  assert.deepEqual(digest(between.samples), reference);
  assert.equal(between.problems.length, 1);
  assert.equal(statsOf(between).skippedBytes, 57);
  for (let round = 0; round < 25; round += 1) {
    const damaged = bytes.slice();
    for (let i = 0; i < 20; i += 1) {
      const at = Math.floor(random() * damaged.length);
      const noise = randomBytes(random, 1 + Math.floor(random() * 40));
      damaged.set(noise.subarray(0, damaged.length - at), at);
    }
    const cut = Math.floor(random() * damaged.length);
    const drop = Math.floor(random() * 3000);
    const spliced = concatBytes([damaged.subarray(0, cut), damaged.subarray(cut + drop)]);
    const chunk = 1 + Math.floor(random() * 5000);
    /** @type {DemuxResult | null} */
    let out = null;
    assert.doesNotThrow(() => {
      out = demux(spliced, chunk);
    }, `round ${round}`);
    const got = /** @type {DemuxResult} */ (/** @type {unknown} */ (out));
    const codes = new Set(got.problems.map((p) => p.code));
    assert.ok(got.problems.length <= 2, `round ${round}: ${got.problems.length} problems`);
    const known = ["corrupt_stream", "unsupported_codec"];
    assert.ok([...codes].every((code) => known.includes(code)));
    assert.ok(got.video.length > 100, `round ${round}: ${got.video.length} video samples survive`);
  }
});

test("media helpers: the HLS, DASH and encrypted fixtures are what they claim", MEDIA, () => {
  const hls = hlsTsFixture();
  assert.equal(hls.segments.length, 3);
  const master = readFileSync(hls.master, "utf8");
  assert.equal((master.match(/#EXT-X-STREAM-INF/g) ?? []).length, 2);
  assert.match(master, /CODECS="avc1\.42c00c,mp4a\.40\.2"/);
  const fmp4 = hlsFmp4Fixture();
  assert.ok(fmp4.init && fmp4.segments.every((s) => s.endsWith(".m4s")));
  const dash = dashFixture();
  const video = readFileSync(dash.video);
  assert.ok(findBox(video, ["moov", "mvex"]), "fragmented");
  assert.ok(mp4Boxes(video).some((box) => box.type === "moof"));
  assert.deepEqual(
    ffprobe(dash.video).streams.map((s) => s.codec_type),
    ["video"],
  );
  assert.deepEqual(
    ffprobe(dash.audio).streams.map((s) => s.codec_type),
    ["audio"],
  );
  const encrypted = encryptedFixture();
  /** @type {[string, string][]} */
  const files = [
    [encrypted.init, "encv"],
    [encrypted.video, "encv"],
    [encrypted.audio, "enca"],
  ];
  for (const [file, entry] of files) {
    const bytes = readFileSync(file);
    const top = mp4Boxes(bytes);
    assert.equal(top[top.length - 1].end, bytes.length, `${file}: boxes to the end`);
    const trak = trackBoxes(bytes)[0];
    assert.ok(findBox(bytes, ["mdia", "minf", "stbl", "stsd", entry], trak), `${file}: ${entry}`);
    assert.ok(findBox(bytes, ["moov", "pssh"]), `${file}: pssh in the moov`);
  }
  const grown = readFileSync(encrypted.video).length - video.length;
  assert.equal(grown, 32 + "streamfetch test key id".length, "only the pssh box was added");
});
