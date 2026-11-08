// @ts-check
/**
 * The MPEG-TS demuxer (ISO/IEC 13818-1) for the HLS streams Dailymotion serves in TS segments:
 * H.264 video (stream type 0x1B, ITU-T H.264 Annex B byte stream) and AAC audio in ADTS frames
 * (stream type 0x0F, ISO/IEC 13818-7 / 14496-3). Bytes in, codec-agnostic samples out — the
 * common sample model `remux.js` writes into a progressive MP4. Ours from the standards; no
 * `chrome.*`, no DOM, no network, no library.
 *
 * What it does, in stream order:
 * - re-aligns 188-byte packets across arbitrary chunking (sync byte 0x47): a lock needs two sync
 *   bytes 188 bytes apart; a packet that does not start with 0x47 loses the lock and the
 *   demuxer searches again, so junk before or inside the stream is skipped, never thrown on;
 * - PAT → the program's PMT PID; PMT → the elementary PIDs by stream type (sections may span
 *   packets; a section with a bad CRC-32 is ignored);
 * - reassembles PES packets per PID (`payload_unit_start_indicator`; a PES length of 0, as video
 *   uses, ends at the next start) and reads the 33-bit PTS/DTS (90 kHz), unwrapped across the
 *   2^33 wrap (each value is taken as the candidate closest to the previous timestamp, so a
 *   backwards jump larger than 2^32 ticks adds 2^33); `dts = pts` when the DTS is absent;
 * - video: Annex B start codes (3 or 4 bytes, across PES boundaries) → NAL units → access units
 *   (an access unit begins at an AUD, at a VCL NAL whose `first_mb_in_slice` is 0, or — H.264
 *   7.4.1.2.3 — at an SEI, SPS, PPS or NAL type 14–18 once the current one holds a VCL NAL);
 *   AUD (9) and filler (12) NALs dropped, every other NAL kept with a 4-byte length prefix
 *   (AVCC); `sync` = the access unit holds an IDR (5); `cts = pts − dts` (≥ 0); the SPS and PPS
 *   seen before the first sample build the `avcC` (width and height from the SPS: exp-Golomb,
 *   scaling lists, cropping, `frame_mbs_only_flag`) and the `avc1` sample entry; access units
 *   before the first IDR with its SPS and PPS cannot be decoded and are dropped (counted in
 *   {@link TsDemuxer#stats});
 * - audio: ADTS frames (sync 0xFFF, 7-byte header or 9 with a CRC, which is skipped), possibly
 *   spanning PES packets → one sample per frame, `timescale` = the sample rate; the first frame
 *   that starts in a PES takes that PES's PTS, every following frame +1024; a PTS more than 1.5
 *   frames ahead of that clock resets it (a gap), one more than 1.5 frames behind it is reported
 *   and the clock kept (decode times never go backwards); `cts = 0`, `sync = true`; the `esds`
 *   carries the two-byte AudioSpecificConfig (`audioObjectType = profile + 1`,
 *   `samplingFrequencyIndex`, `channelConfiguration`; no explicit SBR signalling, since ADTS
 *   cannot say whether HE-AAC's SBR is present) inside the `mp4a` sample entry.
 *
 * Every timestamp is the stream's own (unwrapped, not shifted to 0): video in 90 kHz ticks,
 * audio in samples of the same clock, so the writer keeps A/V sync from them. No PES packet, NAL
 * unit or access unit may grow beyond {@link MAX_UNIT_BYTES}.
 *
 * Problems go to `onProblem`, never thrown: `unsupported_codec` once per elementary stream whose
 * codec StreamFetch 1.0 cannot carry (HEVC 0x24, MP3 0x03/0x04, AC-3 0x81, … — the download
 * fails with that code) and `corrupt_stream` once per demuxer for anything malformed (junk,
 * lost sync, a bad PES header, a truncated packet or frame); the demuxer keeps resyncing after
 * either. Elementary streams that never carry audio or video (ID3 timed metadata 0x15, SCTE-35
 * 0x86, private sections, DSM-CC, DVB subtitles or teletext) are ignored.
 */

/** @typedef {"video" | "audio"} TrackKind */

/**
 * @typedef {object} DemuxSample One elementary-stream sample, as {@link TsDemuxer} emits it.
 * @property {number} dts decode time in the track's timescale (90 kHz video, the sample rate audio)
 * @property {number} cts composition offset (pts − dts), ≥ 0
 * @property {boolean} sync a sync sample (an IDR access unit; every AAC frame)
 * @property {Uint8Array} bytes the sample: AVCC NAL units with 4-byte lengths, or one raw AAC
 *   frame without its ADTS header; a fresh array the receiver owns
 */

/**
 * @typedef {object} DemuxTrack What `onTrack` tells about a track, once, before its first sample.
 * @property {number} timescale 90000 for video, the sample rate for audio
 * @property {Uint8Array} stsd the whole `stsd` box (one `avc1` or `mp4a` sample entry)
 * @property {number | null} width video: from the SPS (cropped); audio: null
 * @property {number | null} height video: from the SPS (cropped); audio: null
 * @property {number | null} sampleRate audio: Hz; video: null
 * @property {number | null} channelCount audio; video: null
 * @property {string} language ISO 639-2 code from the PMT's language descriptor, else "und"
 * @property {string} codec RFC 6381 codec string (`avc1.42c00d`, `mp4a.40.2`)
 */

/** @typedef {"unsupported_codec" | "corrupt_stream"} DemuxProblemCode */

/**
 * @typedef {Record<string, string | number>} DemuxProblemParams The failure parameters, named as
 *   `lib/messages.js` renders them: `unsupported_codec` → `{ stream_type: "0x03", codec, pid }`;
 *   `corrupt_stream` → `{ detail }` (one English sentence).
 */

/**
 * @typedef {object} TsDemuxerHooks
 * @property {(kind: TrackKind, sample: DemuxSample) => void} onSample every sample, in stream
 *   order
 * @property {(kind: TrackKind, info: DemuxTrack) => void} onTrack once per kind, before its
 *   first sample
 * @property {(code: DemuxProblemCode, params: DemuxProblemParams) => void} onProblem see the
 *   module doc
 */

/**
 * @typedef {object} DemuxStats Counters of what the demuxer read and set aside.
 * @property {number} packets TS packets processed
 * @property {number} skippedBytes bytes that were not part of a TS packet (junk, lost sync, a
 *   truncated last packet)
 * @property {number} videoSamples
 * @property {number} audioSamples
 * @property {number} droppedVideoUnits access units dropped: before the first IDR with its SPS
 *   and PPS, or without a timestamp before the first sample
 * @property {number} droppedAudioFrames frames dropped: before the first PTS, a configuration
 *   change, an unsupported layout
 * @property {number} corruptEvents how many times something malformed was met (reported once)
 */

/**
 * @typedef {object} SampleData Where a sample's bytes live: a byte offset in a work file.
 * @property {string} file
 * @property {number} offset
 */

/**
 * @typedef {object} SampleRef One sample of a {@link TrackPlan} (the spec's common sample model).
 * @property {number} dts in the track's timescale
 * @property {number} cts composition offset
 * @property {number} size bytes
 * @property {boolean} sync
 * @property {SampleData} data
 */

/**
 * @typedef {object} TrackPlan What the progressive writer needs of one track.
 * @property {TrackKind} kind
 * @property {number} timescale
 * @property {Uint8Array} stsd the whole `stsd` box
 * @property {number | null} width
 * @property {number | null} height
 * @property {number | null} sampleRate
 * @property {number | null} channelCount
 * @property {string} language
 * @property {SampleRef[]} samples in decode order
 */

/** Bytes per transport stream packet. */
export const PACKET_SIZE = 188;
/** The first byte of every transport stream packet. */
export const SYNC_BYTE = 0x47;
/** The timescale of every PTS/DTS and of the video track. */
export const VIDEO_TIMESCALE = 90000;
/** PCM samples per AAC frame (one raw data block). */
export const AAC_FRAME_SAMPLES = 1024;
/** PMT stream type of H.264 video. */
export const STREAM_TYPE_H264 = 0x1b;
/** PMT stream type of AAC audio in ADTS frames. */
export const STREAM_TYPE_AAC = 0x0f;

/** The wrap of a 33-bit timestamp. */
const TS_WRAP = 2 ** 33;
const NULL_PID = 0x1fff;
/** A jump of the AAC clock beyond this many frames resets it to the PES timestamp. */
const AUDIO_RESYNC_FRAMES = 1.5;
/** The frame duration assumed for a video access unit without a timestamp (30 fps). */
const DEFAULT_VIDEO_DURATION = 3000;
/**
 * The most bytes one PES packet, NAL unit or access unit may grow to before it is dropped as
 * corrupt (a 4K IDR picture is a few MiB): junk without start codes cannot exhaust memory.
 */
export const MAX_UNIT_BYTES = 64 * 1024 * 1024;

/** Names of the stream types an unsupported_codec report names. */
const STREAM_TYPE_NAMES = Object.freeze(
  /** @type {Record<number, string>} */ ({
    0x01: "MPEG-1 video",
    0x02: "MPEG-2 video",
    0x03: "MPEG-1 audio (MP3)",
    0x04: "MPEG-2 audio (MP3)",
    0x06: "private data",
    0x0f: "AAC (ADTS)",
    0x10: "MPEG-4 Part 2 video",
    0x11: "AAC (LATM)",
    0x1b: "H.264",
    0x1c: "MPEG-4 audio (raw)",
    0x1f: "H.264 SVC",
    0x20: "H.264 MVC",
    0x21: "JPEG 2000 video",
    0x24: "HEVC",
    0x2d: "MPEG-H 3D audio",
    0x33: "VVC",
    0x42: "AVS video",
    0x81: "AC-3",
    0x82: "DTS",
    0x83: "Dolby TrueHD",
    0x84: "E-AC-3",
    0x87: "E-AC-3",
    0x8a: "DTS",
    0xd1: "Dirac video",
    0xea: "VC-1",
  }),
);

/**
 * Stream types that never carry audio or video and are ignored: private sections (0x05),
 * DSM-CC (0x0A–0x0D), metadata in PES / sections / carousels (0x13–0x16: the ID3 timed metadata
 * of HLS is 0x15), IPMP (0x1A, 0x7F), SCTE-35 splice information (0x86).
 */
const DATA_STREAM_TYPES = new Set([
  0x05, 0x0a, 0x0b, 0x0c, 0x0d, 0x13, 0x14, 0x15, 0x16, 0x1a, 0x7f, 0x86,
]);

/** Descriptors that make a private-data stream (0x06) audio or video StreamFetch cannot carry. */
const MEDIA_DESCRIPTOR_TAGS = new Set([
  0x6a, // AC-3
  0x7a, // E-AC-3
  0x7b, // DTS
  0x7c, // AAC
]);
/** Registration descriptor formats (0x05) of audio or video codecs in a private-data stream. */
const MEDIA_REGISTRATIONS = new Set([
  "AC-3",
  "EAC3",
  "AC-4",
  "DTS1",
  "DTS2",
  "DTS3",
  "Opus",
  "HEVC",
  "AV01",
  "VC-1",
  "drac",
  "BSSD",
  "mlpa",
]);

/** Stream ids whose PES packets have no optional header (13818-1 table 2-21). */
const PES_NO_HEADER_IDS = new Set([0xbc, 0xbe, 0xbf, 0xf0, 0xf1, 0xf2, 0xf8, 0xff]);

/** H.264 profiles whose SPS carries chroma_format_idc, bit depths and scaling matrices. */
const HIGH_SPS_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
/** H.264 profiles whose `avcC` carries the chroma and bit-depth extension (14496-15 5.3.3.1.2). */
const AVCC_EXTENSION_PROFILES = new Set([100, 110, 122, 144]);

/** ADTS `sampling_frequency_index` → Hz (14496-3 table 1.18); 13 and 14 are reserved. */
export const AAC_SAMPLE_RATES = Object.freeze([
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]);

// ------------------------------------------------------------------------------ bit reading

/** Reads bits MSB first, with the exp-Golomb codes of H.264 9.1; throws RangeError past the end. */
class BitReader {
  #bytes;
  #pos = 0;

  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.#bytes = bytes;
  }

  /** @returns {number} the next bit */
  bit() {
    if (this.#pos >= this.#bytes.length * 8) throw new RangeError("read past the end");
    const value = (this.#bytes[this.#pos >> 3] >> (7 - (this.#pos & 7))) & 1;
    this.#pos += 1;
    return value;
  }

  /**
   * @param {number} count up to 32
   * @returns {number} the next `count` bits as an unsigned number
   */
  bits(count) {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = value * 2 + this.bit();
    return value;
  }

  /** @returns {number} ue(v) */
  ue() {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros += 1;
      if (zeros > 31) throw new RangeError("exp-Golomb code too long");
    }
    return zeros === 0 ? 0 : 2 ** zeros - 1 + this.bits(zeros);
  }

  /** @returns {number} se(v) */
  se() {
    const code = this.ue();
    return code % 2 === 1 ? (code + 1) / 2 : -(code / 2);
  }
}

/**
 * The RBSP of a NAL unit payload: every emulation prevention byte (the 0x03 of `00 00 03`)
 * removed (H.264 7.4.1).
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function unescapeRbsp(bytes) {
  const out = new Uint8Array(bytes.length);
  let length = 0;
  let zeros = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out[length] = byte;
    length += 1;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, length);
}

// ------------------------------------------------------------------------------------- SPS

/**
 * @typedef {object} SpsInfo What StreamFetch reads of a sequence parameter set (H.264 7.3.2.1.1).
 * @property {number} profileIdc
 * @property {number} constraintFlags the constraint_set flags byte (the avcC's
 *   profile_compatibility)
 * @property {number} levelIdc
 * @property {number} spsId
 * @property {number} chromaFormatIdc 0 monochrome, 1 4:2:0, 2 4:2:2, 3 4:4:4
 * @property {boolean} separateColourPlane
 * @property {number} bitDepthLuma
 * @property {number} bitDepthChroma
 * @property {boolean} frameMbsOnly
 * @property {number} width luma samples, after cropping
 * @property {number} height luma samples, after cropping
 * @property {string} codec `avc1.PPCCLL`
 */

/**
 * Skips one `scaling_list()` of H.264 7.3.2.1.1.1 (its values do not matter here).
 * @param {BitReader} reader
 * @param {number} size 16 or 64
 */
function skipScalingList(reader, size) {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j += 1) {
    if (next !== 0) next = (last + reader.se() + 256) % 256;
    if (next !== 0) last = next;
  }
}

/**
 * Parses an SPS NAL unit (header byte included) far enough to know the picture size: the
 * profile, the High-profile fields (chroma format, bit depths, scaling matrices), the picture
 * order count fields, the size in macroblocks, `frame_mbs_only_flag` and the cropping window
 * (CropUnitX/Y per 7.4.2.1.1). Null for anything that is not a valid SPS; never throws.
 * @param {Uint8Array} nal
 * @returns {SpsInfo | null}
 */
export function parseSps(nal) {
  if (!(nal instanceof Uint8Array) || nal.length < 4 || (nal[0] & 0x9f) !== 7) return null;
  try {
    const reader = new BitReader(unescapeRbsp(nal.subarray(1)));
    const profileIdc = reader.bits(8);
    const constraintFlags = reader.bits(8);
    const levelIdc = reader.bits(8);
    const spsId = reader.ue();
    if (spsId > 31) return null;
    let chromaFormatIdc = 1;
    let separateColourPlane = false;
    let bitDepthLuma = 8;
    let bitDepthChroma = 8;
    if (HIGH_SPS_PROFILES.has(profileIdc)) {
      chromaFormatIdc = reader.ue();
      if (chromaFormatIdc > 3) return null;
      if (chromaFormatIdc === 3) separateColourPlane = reader.bit() === 1;
      bitDepthLuma = reader.ue() + 8;
      bitDepthChroma = reader.ue() + 8;
      if (bitDepthLuma > 14 || bitDepthChroma > 14) return null;
      reader.bit(); // qpprime_y_zero_transform_bypass_flag
      if (reader.bit() === 1) {
        const lists = chromaFormatIdc === 3 ? 12 : 8;
        for (let i = 0; i < lists; i += 1) {
          if (reader.bit() === 1) skipScalingList(reader, i < 6 ? 16 : 64);
        }
      }
    }
    reader.ue(); // log2_max_frame_num_minus4
    const pocType = reader.ue();
    if (pocType === 0) {
      reader.ue(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      reader.bit(); // delta_pic_order_always_zero_flag
      reader.se(); // offset_for_non_ref_pic
      reader.se(); // offset_for_top_to_bottom_field
      const cycle = reader.ue();
      if (cycle > 255) return null;
      for (let i = 0; i < cycle; i += 1) reader.se();
    } else if (pocType !== 2) {
      return null;
    }
    reader.ue(); // max_num_ref_frames
    reader.bit(); // gaps_in_frame_num_value_allowed_flag
    const widthMbs = reader.ue() + 1;
    const heightMapUnits = reader.ue() + 1;
    const frameMbsOnly = reader.bit() === 1;
    if (!frameMbsOnly) reader.bit(); // mb_adaptive_frame_field_flag
    reader.bit(); // direct_8x8_inference_flag
    let left = 0;
    let right = 0;
    let top = 0;
    let bottom = 0;
    if (reader.bit() === 1) {
      left = reader.ue();
      right = reader.ue();
      top = reader.ue();
      bottom = reader.ue();
    }
    const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
    const fieldFactor = frameMbsOnly ? 1 : 2;
    const cropUnitX = chromaArrayType === 0 || chromaFormatIdc === 3 ? 1 : 2;
    const cropUnitY = (chromaArrayType === 0 || chromaFormatIdc !== 1 ? 1 : 2) * fieldFactor;
    const width = widthMbs * 16 - cropUnitX * (left + right);
    const height = fieldFactor * heightMapUnits * 16 - cropUnitY * (top + bottom);
    if (width <= 0 || height <= 0) return null;
    return {
      profileIdc,
      constraintFlags,
      levelIdc,
      spsId,
      chromaFormatIdc,
      separateColourPlane,
      bitDepthLuma,
      bitDepthChroma,
      frameMbsOnly,
      width,
      height,
      codec: `avc1.${hex2(profileIdc)}${hex2(constraintFlags)}${hex2(levelIdc)}`,
    };
  } catch {
    return null;
  }
}

/**
 * @param {number} value 0–255
 * @returns {string} two lowercase hex digits
 */
function hex2(value) {
  return value.toString(16).padStart(2, "0");
}

// -------------------------------------------------------------------------------- box bytes

/**
 * @param {number} value
 * @returns {Uint8Array} big-endian 16 bits
 */
function u16(value) {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

/**
 * @param {number} value
 * @returns {Uint8Array} big-endian 32 bits
 */
function u32(value) {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

/**
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array} the parts, concatenated
 */
function concat(parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * @param {string} type four ASCII characters
 * @param {Uint8Array[]} parts the payload
 * @returns {Uint8Array} an ISO BMFF box with a 32-bit size
 */
function box(type, ...parts) {
  const payload = concat(parts);
  const out = new Uint8Array(8 + payload.length);
  out.set(u32(out.length), 0);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

/**
 * @param {number} tag an MPEG-4 descriptor tag (14496-1 7.2.2.1)
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array} the descriptor with a one-byte size (every payload here is < 128 bytes)
 */
function descriptor(tag, ...parts) {
  const payload = concat(parts);
  if (payload.length > 127) throw new RangeError("descriptor too large");
  return concat([Uint8Array.of(tag, payload.length), payload]);
}

/**
 * The `stsd` box of an H.264 track: one `avc1` visual sample entry (14496-12 12.1.3) holding an
 * `avcC` (14496-15 5.3.3.1): configurationVersion 1, the profile, compatibility and level bytes
 * of the first SPS, `lengthSizeMinusOne` 3, the SPS and PPS lists, and — for the High, High 10,
 * High 4:2:2 and High 4:4:4 profiles — the chroma format and bit depths.
 * @param {Uint8Array[]} spsList SPS NAL units (header byte included), at most 31
 * @param {Uint8Array[]} ppsList PPS NAL units, at most 255
 * @param {SpsInfo} info {@link parseSps} of the active SPS (the picture size)
 * @returns {Uint8Array}
 */
export function buildAvcStsd(spsList, ppsList, info) {
  if (spsList.length === 0 || spsList.length > 31 || ppsList.length === 0 || ppsList.length > 255) {
    throw new RangeError("an avcC needs 1–31 SPS and 1–255 PPS");
  }
  const first = spsList[0];
  /** @type {Uint8Array[]} */
  const parts = [Uint8Array.of(1, first[1], first[2], first[3], 0xfc | 3, 0xe0 | spsList.length)];
  for (const sps of spsList) parts.push(u16(sps.length), sps);
  parts.push(Uint8Array.of(ppsList.length));
  for (const pps of ppsList) parts.push(u16(pps.length), pps);
  if (AVCC_EXTENSION_PROFILES.has(first[1])) {
    parts.push(
      Uint8Array.of(
        0xfc | info.chromaFormatIdc,
        0xf8 | (info.bitDepthLuma - 8),
        0xf8 | (info.bitDepthChroma - 8),
        0,
      ),
    );
  }
  const avcC = box("avcC", ...parts);
  const entry = box(
    "avc1",
    new Uint8Array(6), // reserved
    u16(1), // data_reference_index
    new Uint8Array(16), // pre_defined, reserved, pre_defined[3]
    u16(info.width),
    u16(info.height),
    u32(0x00480000), // horizresolution 72 dpi
    u32(0x00480000), // vertresolution 72 dpi
    u32(0), // reserved
    u16(1), // frame_count
    new Uint8Array(32), // compressorname
    u16(0x0018), // depth
    u16(0xffff), // pre_defined = -1
    avcC,
  );
  return box("stsd", u32(0), u32(1), entry);
}

// ------------------------------------------------------------------------------------ ADTS

/**
 * @typedef {object} AdtsHeader One ADTS frame header (13818-7 6.2 / 14496-3 1.A.2.2).
 * @property {number} headerLength 7, or 9 with a CRC
 * @property {number} frameLength header + payload, bytes
 * @property {number} profile 0–3 (`audioObjectType − 1`)
 * @property {number} samplingFrequencyIndex 0–12
 * @property {number} sampleRate Hz
 * @property {number} channelConfiguration 0–7
 * @property {number} rawDataBlocks raw data blocks in the frame (1 in practice)
 */

/**
 * The ADTS header at `offset`, or null when the bytes there are not one (no 0xFFF sync, a layer
 * other than 0, a reserved sampling frequency, a frame shorter than its header, or fewer than 7
 * bytes). Never throws.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {AdtsHeader | null}
 */
export function parseAdtsHeader(bytes, offset) {
  if (offset < 0 || offset + 7 > bytes.length) return null;
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xf6) !== 0xf0) return null;
  const headerLength = (bytes[offset + 1] & 1) === 1 ? 7 : 9;
  const profile = bytes[offset + 2] >> 6;
  const samplingFrequencyIndex = (bytes[offset + 2] >> 2) & 0x0f;
  if (samplingFrequencyIndex >= AAC_SAMPLE_RATES.length) return null;
  const channelConfiguration = ((bytes[offset + 2] & 1) << 2) | (bytes[offset + 3] >> 6);
  const frameLength =
    ((bytes[offset + 3] & 3) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5);
  if (frameLength <= headerLength) return null;
  return {
    headerLength,
    frameLength,
    profile,
    samplingFrequencyIndex,
    sampleRate: AAC_SAMPLE_RATES[samplingFrequencyIndex],
    channelConfiguration,
    rawDataBlocks: (bytes[offset + 6] & 3) + 1,
  };
}

/**
 * The two-byte AudioSpecificConfig (14496-3 1.6.2.1) an ADTS header implies: audioObjectType
 * (profile + 1), samplingFrequencyIndex, channelConfiguration, then the GASpecificConfig's three
 * zero flags (1024-sample frames, no core coder, no extension).
 * @param {AdtsHeader} header
 * @returns {Uint8Array}
 */
export function audioSpecificConfig(header) {
  const objectType = header.profile + 1;
  return Uint8Array.of(
    (objectType << 3) | (header.samplingFrequencyIndex >> 1),
    ((header.samplingFrequencyIndex & 1) << 7) | (header.channelConfiguration << 3),
  );
}

/**
 * The channel count of an MPEG-4 channelConfiguration (1–7; 7 is 7.1, eight channels).
 * @param {number} configuration
 * @returns {number}
 */
function channelCountOf(configuration) {
  return configuration === 7 ? 8 : configuration;
}

/**
 * The `stsd` box of an AAC track: one `mp4a` audio sample entry (14496-12 12.2.3: channelcount,
 * 16-bit samples, the rate as 16.16 — 0 above 65535 Hz, where the `esds` and the track's
 * timescale carry it) holding an `esds` (14496-14 5.6) whose DecoderConfigDescriptor (object type
 * 0x40, audio stream) carries the AudioSpecificConfig. Buffer size and bitrates are 0 (unknown
 * when the first frame is read).
 * @param {AdtsHeader} header
 * @returns {Uint8Array}
 */
export function buildAacStsd(header) {
  const decoderSpecificInfo = descriptor(0x05, audioSpecificConfig(header));
  const decoderConfig = descriptor(
    0x04,
    Uint8Array.of(0x40, (0x05 << 2) | 1, 0, 0, 0), // object type, stream type, bufferSizeDB
    u32(0), // maxBitrate
    u32(0), // avgBitrate
    decoderSpecificInfo,
  );
  const slConfig = descriptor(0x06, Uint8Array.of(0x02));
  const esDescriptor = descriptor(0x03, u16(0), Uint8Array.of(0), decoderConfig, slConfig);
  const esds = box("esds", u32(0), esDescriptor);
  const rate = header.sampleRate <= 0xffff ? header.sampleRate * 65536 : 0;
  const entry = box(
    "mp4a",
    new Uint8Array(6), // reserved
    u16(1), // data_reference_index
    new Uint8Array(8), // reserved
    u16(channelCountOf(header.channelConfiguration)),
    u16(16), // samplesize
    u32(0), // pre_defined, reserved
    u32(rate),
    esds,
  );
  return box("stsd", u32(0), u32(1), entry);
}

// ------------------------------------------------------------------------------------- PSI

/** CRC-32/MPEG-2 table (polynomial 0x04C11DB7, no reflection). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

/**
 * CRC-32/MPEG-2 of `bytes` (initial value 0xFFFFFFFF, no final XOR): 0 over a whole PSI section
 * whose CRC_32 field is right.
 * @param {Uint8Array} bytes
 * @returns {number} unsigned 32 bits
 */
export function crc32Mpeg2(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc;
}

/**
 * The 33-bit timestamp at `offset` of a PES header (13818-1 2.4.3.7).
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
function readTimestamp(bytes, offset) {
  return (
    ((bytes[offset] >> 1) & 0x07) * 2 ** 30 +
    ((bytes[offset + 1] << 7) | (bytes[offset + 2] >> 1)) * 2 ** 15 +
    ((bytes[offset + 3] << 7) | (bytes[offset + 4] >> 1))
  );
}

/**
 * @typedef {object} PesPacket
 * @property {number | null} pts raw 33-bit
 * @property {number | null} dts raw 33-bit (the PTS when absent)
 * @property {Uint8Array} payload
 * @property {boolean} short the packet holds fewer bytes than its PES_packet_length says
 */

/**
 * Parses one reassembled PES packet; null when it has no start code or a malformed header.
 * @param {Uint8Array} data
 * @returns {PesPacket | null}
 */
function parsePes(data) {
  if (data.length < 6 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return null;
  const streamId = data[3];
  const declared = (data[4] << 8) | data[5];
  const end = declared > 0 ? Math.min(data.length, 6 + declared) : data.length;
  const short = declared > 0 && data.length < 6 + declared;
  if (PES_NO_HEADER_IDS.has(streamId)) {
    return { pts: null, dts: null, payload: data.subarray(6, end), short };
  }
  if (data.length < 9 || (data[6] & 0xc0) !== 0x80) return null;
  const flags = data[7] >> 6;
  const headerLength = data[8];
  const payloadStart = 9 + headerLength;
  if (payloadStart > end) return null;
  let pts = null;
  let dts = null;
  if (flags === 2 || flags === 3) {
    if (headerLength < 5) return null;
    pts = readTimestamp(data, 9);
    dts = pts;
    if (flags === 3) {
      if (headerLength < 10) return null;
      dts = readTimestamp(data, 14);
    }
  }
  return { pts, dts, payload: data.subarray(payloadStart, end), short };
}

// ---------------------------------------------------------------------------- byte buffers

/** A growable byte buffer: appends copy, `take` hands out a copy and empties it. */
class ByteBuffer {
  #bytes = new Uint8Array(4096);
  #length = 0;

  /** @returns {number} */
  get length() {
    return this.#length;
  }

  /** @param {Uint8Array} chunk */
  append(chunk) {
    const need = this.#length + chunk.length;
    if (need > this.#bytes.length) {
      const next = new Uint8Array(Math.max(need, this.#bytes.length * 2));
      next.set(this.#bytes.subarray(0, this.#length));
      this.#bytes = next;
    }
    this.#bytes.set(chunk, this.#length);
    this.#length = need;
  }

  /**
   * @param {number} index from the start
   * @returns {number} the byte, or -1 past the end
   */
  at(index) {
    return index >= 0 && index < this.#length ? this.#bytes[index] : -1;
  }

  /**
   * @param {number} index counted from the end (1 = the last byte)
   * @returns {number} the byte, or -1 past the start
   */
  fromEnd(index) {
    return index <= this.#length ? this.#bytes[this.#length - index] : -1;
  }

  /** @returns {Uint8Array} a copy of the content; the buffer is emptied */
  take() {
    const out = this.#bytes.slice(0, this.#length);
    this.#length = 0;
    return out;
  }

  clear() {
    this.#length = 0;
  }
}

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} `bytes` without its trailing zero bytes (a NAL unit never ends in 0x00:
 *   trailing zeros are `trailing_zero_8bits` or the first byte of a 4-byte start code)
 */
function trimTrailingZeros(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return end === bytes.length ? bytes : bytes.subarray(0, end);
}

// ---------------------------------------------------------------------------------- demuxer

/**
 * @typedef {object} Timestamps The timestamps of one PES packet, unwrapped (90 kHz).
 * @property {number} pts
 * @property {number} dts
 * @property {boolean} used whether an access unit has taken them already
 */

/**
 * @typedef {object} PesState The PES packet being reassembled on one elementary PID.
 * @property {TrackKind} kind
 * @property {ByteBuffer} buffer
 * @property {boolean} active a start was seen and the packet is not finished
 * @property {number} expected 6 + PES_packet_length, or 0 when unbounded
 */

/**
 * @typedef {object} AccessUnit The H.264 access unit being assembled.
 * @property {Uint8Array[]} nals kept NAL units
 * @property {number} size the AVCC size of the kept NAL units
 * @property {boolean} hasVcl
 * @property {boolean} hasIdr
 * @property {Timestamps | null} ts
 */

/**
 * @typedef {object} PsiState A PSI section being reassembled on one PID.
 * @property {ByteBuffer} buffer
 * @property {number} total 3 + section_length, or 0 while unknown
 */

/** Demuxes an MPEG-TS byte stream into H.264 and AAC samples (see the module doc). */
export class TsDemuxer {
  /** @type {TsDemuxerHooks} */
  #hooks;
  // packet layer
  #buf = new Uint8Array(0);
  #start = 0;
  #end = 0;
  #position = 0;
  #locked = false;
  #skipping = false;
  // PSI
  #pmtPid = -1;
  /** @type {Map<number, PsiState>} */
  #psi = new Map();
  /** @type {Map<number, PesState>} */
  #pes = new Map();
  /** @type {Set<string>} */
  #reported = new Set();
  #corruptReported = false;
  /** @type {number | null} */
  #lastTs = null;
  /** @type {Record<TrackKind, number | null>} */
  #streamTs = { video: null, audio: null };
  // video
  #nal = new ByteBuffer();
  #inNal = false;
  /** @type {Timestamps | null} */
  #nalTs = null;
  /** @type {AccessUnit | null} */
  #au = null;
  /** @type {Uint8Array[]} */
  #spsList = [];
  /** @type {Uint8Array[]} */
  #ppsList = [];
  /** @type {SpsInfo | null} */
  #spsInfo = null;
  #videoAnnounced = false;
  /** @type {number | null} */
  #lastVideoDts = null;
  #lastVideoDuration = DEFAULT_VIDEO_DURATION;
  // audio
  /** @type {Uint8Array | null} */
  #audioCarry = null;
  /** @type {Timestamps | null} */
  #audioCarryTs = null;
  /** @type {AdtsHeader | null} */
  #audioConfig = null;
  #audioAnnounced = false;
  /** @type {number | null} */
  #audioClock = null;
  #audioLanguage = "und";
  #stats = {
    packets: 0,
    skippedBytes: 0,
    videoSamples: 0,
    audioSamples: 0,
    droppedVideoUnits: 0,
    droppedAudioFrames: 0,
    corruptEvents: 0,
  };

  /** @param {TsDemuxerHooks} hooks */
  constructor(hooks) {
    this.#hooks = hooks;
  }

  /** @returns {DemuxStats} a copy of the counters so far */
  get stats() {
    return { ...this.#stats };
  }

  /**
   * Feeds the next bytes of the stream, chunked in any way: packets are re-aligned across calls.
   * Samples are emitted through the hooks as soon as they are complete.
   * @param {Uint8Array} chunk
   */
  push(chunk) {
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) return;
    const live = this.#end - this.#start;
    if (this.#end + chunk.length > this.#buf.length) {
      const need = live + chunk.length;
      if (need <= this.#buf.length) {
        this.#buf.copyWithin(0, this.#start, this.#end);
      } else {
        const next = new Uint8Array(Math.max(need, this.#buf.length * 2, 4096));
        next.set(this.#buf.subarray(this.#start, this.#end));
        this.#buf = next;
      }
      this.#start = 0;
      this.#end = live;
    }
    this.#buf.set(chunk, this.#end);
    this.#end += chunk.length;
    this.#drain(false);
  }

  /**
   * Ends the stream: the last packet (which has no following sync byte to confirm it), the open
   * PES packets, the last NAL unit and access unit, and the last AAC frame are emitted. A partial
   * packet or frame left over is reported as `corrupt_stream`.
   */
  flush() {
    this.#drain(true);
    for (const state of this.#pes.values()) {
      if (state.active) this.#finishPes(state);
    }
    if (this.#inNal) {
      this.#nalUnit(trimTrailingZeros(this.#nal.take()), this.#nalTs);
      this.#inNal = false;
      this.#nalTs = null;
    }
    this.#finishAccessUnit();
    if (this.#audioCarry && this.#audioCarry.length > 0) {
      this.#corrupt("an incomplete AAC frame at the end of the stream");
      this.#stats.droppedAudioFrames += 1;
    }
    this.#audioCarry = null;
    this.#audioCarryTs = null;
    this.#locked = false;
    this.#skipping = false;
  }

  // ---------------------------------------------------------------------------- problems

  /** @param {string} detail */
  #corrupt(detail) {
    this.#stats.corruptEvents += 1;
    if (this.#corruptReported) return;
    this.#corruptReported = true;
    this.#hooks.onProblem("corrupt_stream", { detail });
  }

  /**
   * @param {number} pid
   * @param {number} streamType
   * @param {string} codec
   */
  #unsupported(pid, streamType, codec) {
    const key = `${pid}:${streamType}:${codec}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    this.#hooks.onProblem("unsupported_codec", {
      stream_type: `0x${hex2(streamType)}`,
      codec,
      pid,
    });
  }

  // ------------------------------------------------------------------------ packet layer

  /** @param {boolean} final no more bytes will come: the last packet needs no confirmation */
  #drain(final) {
    const bytes = this.#buf;
    const end = this.#end;
    let pos = this.#start;
    while (end - pos >= PACKET_SIZE) {
      if (this.#locked) {
        if (bytes[pos] === SYNC_BYTE) {
          this.#packet(bytes.subarray(pos, pos + PACKET_SIZE));
          pos += PACKET_SIZE;
          continue;
        }
        this.#locked = false;
        this.#skipping = true;
        this.#corrupt(`lost MPEG-TS packet sync at byte ${this.#position + (pos - this.#start)}`);
      }
      let skip = 0;
      if (bytes[pos] !== SYNC_BYTE) {
        const found = bytes.indexOf(SYNC_BYTE, pos);
        skip = found < 0 || found >= end ? end - pos : found - pos;
      } else if (end - pos > PACKET_SIZE) {
        if (bytes[pos + PACKET_SIZE] === SYNC_BYTE) {
          this.#locked = true;
          this.#skipping = false;
          continue;
        }
        skip = 1;
      } else if (final) {
        this.#locked = true;
        this.#skipping = false;
        continue;
      } else {
        break;
      }
      if (!this.#skipping) {
        this.#skipping = true;
        const at = this.#position + (pos - this.#start);
        this.#corrupt(`bytes that are not MPEG-TS packets at byte ${at}`);
      }
      this.#stats.skippedBytes += skip;
      pos += skip;
    }
    if (final && end > pos) {
      this.#corrupt(`a truncated MPEG-TS packet of ${end - pos} bytes at the end of the stream`);
      this.#stats.skippedBytes += end - pos;
      pos = end;
    }
    this.#position += pos - this.#start;
    this.#start = pos;
  }

  /** @param {Uint8Array} packet 188 bytes starting with the sync byte */
  #packet(packet) {
    this.#stats.packets += 1;
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    if (pid === NULL_PID) return;
    const known = pid === 0 || pid === this.#pmtPid || this.#pes.has(pid);
    if (!known) return;
    if ((packet[1] & 0x80) !== 0) {
      this.#corrupt("a packet flagged with a transport error");
      return;
    }
    const control = (packet[3] >> 4) & 3;
    if (control === 0 || control === 2) return; // reserved, or adaptation field only
    let offset = 4;
    if (control === 3) {
      offset = 5 + packet[4];
      if (offset > PACKET_SIZE) {
        this.#corrupt("a packet whose adaptation field is longer than the packet");
        return;
      }
    }
    if (offset >= PACKET_SIZE) return;
    if ((packet[3] & 0xc0) !== 0) {
      this.#corrupt("a scrambled packet (StreamFetch never decrypts)");
      return;
    }
    const payload = packet.subarray(offset);
    const unitStart = (packet[1] & 0x40) !== 0;
    const pes = this.#pes.get(pid);
    if (pes) this.#pesPayload(pes, payload, unitStart);
    else this.#psiPayload(pid, payload, unitStart);
  }

  // --------------------------------------------------------------------------------- PSI

  /**
   * @param {number} pid
   * @param {Uint8Array} payload
   * @param {boolean} unitStart
   */
  #psiPayload(pid, payload, unitStart) {
    let state = this.#psi.get(pid);
    if (!state) {
      state = { buffer: new ByteBuffer(), total: 0 };
      this.#psi.set(pid, state);
    }
    if (!unitStart) {
      if (state.buffer.length > 0) this.#psiAppend(pid, state, payload);
      return;
    }
    const pointer = payload[0];
    if (1 + pointer > payload.length) {
      this.#corrupt("a PSI pointer field past the end of its packet");
      state.buffer.clear();
      return;
    }
    if (state.buffer.length > 0) this.#psiAppend(pid, state, payload.subarray(1, 1 + pointer));
    state.buffer.clear();
    state.total = 0;
    let pos = 1 + pointer;
    while (pos < payload.length && payload[pos] !== 0xff) {
      if (pos + 3 > payload.length) {
        state.buffer.append(payload.subarray(pos));
        return;
      }
      const total = 3 + (((payload[pos + 1] & 0x0f) << 8) | payload[pos + 2]);
      if (pos + total > payload.length) {
        state.total = total;
        state.buffer.append(payload.subarray(pos));
        return;
      }
      this.#section(pid, payload.subarray(pos, pos + total));
      pos += total;
    }
  }

  /**
   * @param {number} pid
   * @param {PsiState} state
   * @param {Uint8Array} bytes
   */
  #psiAppend(pid, state, bytes) {
    state.buffer.append(bytes);
    if (state.total === 0 && state.buffer.length >= 3) {
      state.total = 3 + (((state.buffer.at(1) & 0x0f) << 8) | state.buffer.at(2));
    }
    if (state.total > 0 && state.buffer.length >= state.total) {
      const section = state.buffer.take().subarray(0, state.total);
      state.total = 0;
      this.#section(pid, section);
    }
  }

  /**
   * @param {number} pid
   * @param {Uint8Array} section a whole PSI section, CRC included
   */
  #section(pid, section) {
    if (section.length < 12 || (section[1] & 0x80) === 0) return;
    if (crc32Mpeg2(section) !== 0) {
      this.#corrupt("a PSI section with a bad CRC");
      return;
    }
    if ((section[5] & 1) === 0) return; // not yet applicable
    if (pid === 0 && section[0] === 0x00) this.#pat(section);
    else if (pid === this.#pmtPid && section[0] === 0x02) this.#pmt(section);
  }

  /** @param {Uint8Array} section */
  #pat(section) {
    for (let pos = 8; pos + 4 <= section.length - 4; pos += 4) {
      const program = (section[pos] << 8) | section[pos + 1];
      if (program === 0) continue; // the network PID
      const pid = ((section[pos + 2] & 0x1f) << 8) | section[pos + 3];
      if (pid !== this.#pmtPid) {
        this.#pmtPid = pid;
        this.#psi.delete(pid);
      }
      return;
    }
  }

  /** @param {Uint8Array} section */
  #pmt(section) {
    const end = section.length - 4;
    const programInfo = ((section[10] & 0x0f) << 8) | section[11];
    let pos = 12 + programInfo;
    /** @type {Map<number, TrackKind>} */
    const wanted = new Map();
    let haveVideo = false;
    let haveAudio = false;
    while (pos + 5 <= end) {
      const type = section[pos];
      const pid = ((section[pos + 1] & 0x1f) << 8) | section[pos + 2];
      const infoLength = ((section[pos + 3] & 0x0f) << 8) | section[pos + 4];
      const descriptors = section.subarray(pos + 5, Math.min(end, pos + 5 + infoLength));
      pos += 5 + infoLength;
      if (type === STREAM_TYPE_H264 && !haveVideo) {
        haveVideo = true;
        wanted.set(pid, "video");
      } else if (type === STREAM_TYPE_AAC && !haveAudio) {
        haveAudio = true;
        wanted.set(pid, "audio");
        this.#audioLanguage = languageOf(descriptors) ?? this.#audioLanguage;
      } else if (type === STREAM_TYPE_H264 || type === STREAM_TYPE_AAC) {
        // a second video or audio stream of a supported codec: the first one is demuxed
      } else if (!isDataStream(type, descriptors)) {
        this.#unsupported(pid, type, STREAM_TYPE_NAMES[type] ?? "unknown");
      }
    }
    for (const [pid, state] of [...this.#pes]) {
      if (wanted.get(pid) === state.kind) continue;
      if (state.active) this.#finishPes(state);
      this.#pes.delete(pid);
    }
    for (const [pid, kind] of wanted) {
      if (!this.#pes.has(pid)) {
        this.#pes.set(pid, { kind, buffer: new ByteBuffer(), active: false, expected: 0 });
      }
    }
  }

  // --------------------------------------------------------------------------------- PES

  /**
   * @param {PesState} state
   * @param {Uint8Array} payload
   * @param {boolean} unitStart
   */
  #pesPayload(state, payload, unitStart) {
    if (unitStart) {
      if (state.active) this.#finishPes(state);
      state.active = true;
      state.expected = 0;
      state.buffer.clear();
    } else if (!state.active) {
      this.#stats.skippedBytes += payload.length; // the middle of a PES whose start was not seen
      return;
    }
    if (state.buffer.length + payload.length > MAX_UNIT_BYTES) {
      this.#corrupt("a PES packet larger than any picture");
      state.buffer.clear();
      state.active = false;
      return;
    }
    state.buffer.append(payload);
    if (unitStart && payload.length >= 6) {
      const declared = (payload[4] << 8) | payload[5];
      state.expected = declared > 0 ? 6 + declared : 0;
    }
    if (state.expected > 0 && state.buffer.length >= state.expected) this.#finishPes(state);
  }

  /** @param {PesState} state */
  #finishPes(state) {
    state.active = false;
    const pes = parsePes(state.buffer.take());
    state.expected = 0;
    if (!pes) {
      this.#corrupt("a PES packet without a valid header");
      return;
    }
    if (pes.short) this.#corrupt("a PES packet shorter than its declared length");
    /** @type {Timestamps | null} */
    let ts = null;
    if (pes.pts !== null && pes.dts !== null) {
      const dts = this.#unwrap(pes.dts, this.#streamTs[state.kind]);
      this.#streamTs[state.kind] = dts;
      const pts = pes.pts + Math.round((dts - pes.pts) / TS_WRAP) * TS_WRAP;
      ts = { pts, dts, used: false };
    }
    if (state.kind === "video") this.#videoPayload(pes.payload, ts);
    else this.#audioPayload(pes.payload, ts);
  }

  /**
   * The unwrapped value of a 33-bit timestamp: the candidate `raw + k·2^33` closest to the
   * reference (this stream's previous timestamp, else the last one of any stream).
   * @param {number} raw
   * @param {number | null} streamReference
   * @returns {number}
   */
  #unwrap(raw, streamReference) {
    const reference = streamReference ?? this.#lastTs;
    const value =
      reference === null ? raw : raw + Math.round((reference - raw) / TS_WRAP) * TS_WRAP;
    this.#lastTs = value;
    return value;
  }

  // ------------------------------------------------------------------------------- video

  /**
   * Splits a PES payload into NAL units on Annex B start codes (a 0x01 after two or more zero
   * bytes, the zeros possibly at the end of the previous payload).
   * @param {Uint8Array} payload
   * @param {Timestamps | null} ts
   */
  #videoPayload(payload, ts) {
    let nalStart = 0;
    let from = 0;
    while (from < payload.length) {
      const one = payload.indexOf(1, from);
      if (one < 0) break;
      from = one + 1;
      let zeros = 0;
      for (let i = one - 1; i >= nalStart && zeros < 2 && payload[i] === 0; i -= 1) zeros += 1;
      if (zeros < 2 && one - zeros === nalStart && nalStart === 0 && this.#inNal) {
        for (let back = 1; zeros < 2 && this.#nal.fromEnd(back) === 0; back += 1) zeros += 1;
      }
      if (zeros < 2) continue;
      if (this.#inNal) {
        let nal;
        if (this.#nal.length > 0) {
          this.#nal.append(payload.subarray(nalStart, one));
          nal = this.#nal.take();
        } else {
          nal = payload.subarray(nalStart, one);
        }
        this.#nalUnit(trimTrailingZeros(nal), this.#nalTs);
      } else if (payload.subarray(nalStart, one - zeros).some((byte) => byte !== 0)) {
        this.#corrupt("video data before the first start code");
      }
      this.#inNal = true;
      this.#nalTs = ts;
      nalStart = one + 1;
    }
    if (this.#inNal) {
      if (this.#nal.length + payload.length - nalStart > MAX_UNIT_BYTES) {
        this.#corrupt("an H.264 NAL unit larger than any picture");
        this.#nal.clear();
        this.#inNal = false;
        return;
      }
      this.#nal.append(payload.subarray(nalStart));
    } else if (payload.subarray(nalStart).some((byte) => byte !== 0)) {
      this.#corrupt("video data before the first start code");
    }
  }

  /**
   * One complete NAL unit: decides the access unit boundary, collects the parameter sets for
   * the `avcC` and keeps every NAL but AUD and filler.
   * @param {Uint8Array} nal
   * @param {Timestamps | null} ts the timestamps of the PES packet the NAL unit started in
   */
  #nalUnit(nal, ts) {
    if (nal.length === 0) return;
    if ((nal[0] & 0x80) !== 0) {
      this.#corrupt("an H.264 NAL unit with its forbidden bit set");
      return;
    }
    const type = nal[0] & 0x1f;
    const vcl = type >= 1 && type <= 5;
    const current = this.#au;
    let begins = current === null || type === 9;
    if (!begins && current !== null && current.hasVcl) {
      if (vcl) begins = nal.length > 1 && (nal[1] & 0x80) !== 0; // first_mb_in_slice == 0
      else begins = type === 6 || type === 7 || type === 8 || (type >= 14 && type <= 18);
    }
    if (begins) {
      this.#finishAccessUnit();
      const claimed = ts !== null && !ts.used ? ts : null;
      if (claimed) claimed.used = true;
      this.#au = { nals: [], size: 0, hasVcl: false, hasIdr: false, ts: claimed };
    }
    const au = /** @type {AccessUnit} */ (this.#au);
    if (!this.#videoAnnounced) {
      if (type === 7) {
        const info = parseSps(nal);
        if (info) {
          this.#spsInfo = info;
          addUnique(this.#spsList, nal, 31);
        } else {
          this.#corrupt("an H.264 sequence parameter set that does not parse");
        }
      } else if (type === 8) {
        addUnique(this.#ppsList, nal, 255);
      }
    }
    if (type === 9 || type === 12) return;
    if (au.size + 4 + nal.length > MAX_UNIT_BYTES) {
      this.#corrupt("an H.264 access unit larger than any picture");
      this.#au = null;
      return;
    }
    au.nals.push(nal);
    au.size += 4 + nal.length;
    if (vcl) au.hasVcl = true;
    if (type === 5) au.hasIdr = true;
  }

  /** Emits the access unit being assembled, when it holds a picture. */
  #finishAccessUnit() {
    const au = this.#au;
    this.#au = null;
    if (!au || !au.hasVcl) return;
    let dts;
    let pts;
    if (au.ts) {
      dts = au.ts.dts;
      pts = au.ts.pts;
    } else if (this.#lastVideoDts !== null) {
      dts = this.#lastVideoDts + this.#lastVideoDuration;
      pts = dts;
    } else {
      this.#stats.droppedVideoUnits += 1;
      return;
    }
    if (!this.#videoAnnounced) {
      const info = this.#spsInfo;
      if (!au.hasIdr || !info || this.#ppsList.length === 0) {
        this.#stats.droppedVideoUnits += 1;
        return;
      }
      this.#videoAnnounced = true;
      this.#hooks.onTrack("video", {
        timescale: VIDEO_TIMESCALE,
        stsd: buildAvcStsd(this.#spsList, this.#ppsList, info),
        width: info.width,
        height: info.height,
        sampleRate: null,
        channelCount: null,
        language: "und",
        codec: info.codec,
      });
    }
    if (this.#lastVideoDts !== null) {
      if (dts <= this.#lastVideoDts) {
        this.#corrupt("video decode timestamps that do not increase");
        dts = this.#lastVideoDts + 1;
      }
      this.#lastVideoDuration = dts - this.#lastVideoDts;
    }
    this.#lastVideoDts = dts;
    const bytes = new Uint8Array(au.size);
    const lengths = new DataView(bytes.buffer);
    let offset = 0;
    for (const nal of au.nals) {
      lengths.setUint32(offset, nal.length);
      bytes.set(nal, offset + 4);
      offset += 4 + nal.length;
    }
    this.#stats.videoSamples += 1;
    this.#hooks.onSample("video", { dts, cts: Math.max(0, pts - dts), sync: au.hasIdr, bytes });
  }

  // ------------------------------------------------------------------------------- audio

  /**
   * Splits a PES payload (after the carried-over bytes of the previous one) into ADTS frames.
   * @param {Uint8Array} payload
   * @param {Timestamps | null} ts
   */
  #audioPayload(payload, ts) {
    let data = payload;
    let fresh = 0;
    if (this.#audioCarry) {
      data = concat([this.#audioCarry, payload]);
      fresh = this.#audioCarry.length;
      this.#audioCarry = null;
    }
    // The PTS of a PES belongs to the first frame that starts in it; a frame that started in the
    // previous PES and was incomplete there carries that PES's PTS along.
    /** @type {Timestamps | null} */
    let carried = this.#audioCarryTs;
    this.#audioCarryTs = null;
    /** @type {Timestamps | null} */
    let pending = ts;
    let pos = 0;
    let resyncing = false;
    while (pos + 7 <= data.length) {
      const header = parseAdtsHeader(data, pos);
      const valid =
        header !== null &&
        (!resyncing ||
          pos + header.frameLength >= data.length ||
          parseAdtsHeader(data, pos + header.frameLength) !== null);
      if (!header || !valid) {
        if (!resyncing) this.#corrupt("audio bytes that are not ADTS frames");
        resyncing = true;
        const found = data.indexOf(0xff, pos + 1);
        const next = found < 0 ? data.length : found;
        this.#stats.skippedBytes += next - pos;
        pos = next;
        continue;
      }
      if (pos + header.frameLength > data.length) break;
      resyncing = false;
      let frameTs = null;
      if (pos < fresh) {
        frameTs = carried;
        carried = null;
      } else if (pending) {
        frameTs = pending;
        pending = null;
      }
      const frame = data.subarray(pos + header.headerLength, pos + header.frameLength);
      this.#audioFrame(frame, header, frameTs);
      pos += header.frameLength;
    }
    if (pos < data.length) {
      this.#audioCarry = data.slice(pos);
      this.#audioCarryTs = pos < fresh ? carried : pending;
    }
  }

  /**
   * @param {Uint8Array} frame the raw AAC frame (no header, no CRC)
   * @param {AdtsHeader} header
   * @param {Timestamps | null} ts the PES timestamps when this frame starts the PES payload
   */
  #audioFrame(frame, header, ts) {
    if (header.rawDataBlocks !== 1 || header.channelConfiguration === 0) {
      this.#unsupported(
        this.#audioPid(),
        STREAM_TYPE_AAC,
        header.channelConfiguration === 0
          ? "AAC (ADTS) with a program config element"
          : "AAC (ADTS) with several raw data blocks per frame",
      );
      this.#stats.droppedAudioFrames += 1;
      return;
    }
    const config = this.#audioConfig;
    if (
      config &&
      (config.profile !== header.profile ||
        config.samplingFrequencyIndex !== header.samplingFrequencyIndex ||
        config.channelConfiguration !== header.channelConfiguration)
    ) {
      this.#corrupt("an AAC frame whose configuration differs from the first frame's");
      this.#stats.droppedAudioFrames += 1;
      return;
    }
    if (ts) {
      const at = Math.round((ts.pts * header.sampleRate) / VIDEO_TIMESCALE);
      const limit = AUDIO_RESYNC_FRAMES * AAC_FRAME_SAMPLES;
      if (this.#audioClock === null || at - this.#audioClock > limit) {
        this.#audioClock = at;
      } else if (this.#audioClock - at > limit) {
        this.#corrupt("audio timestamps that go backwards");
      }
    }
    if (this.#audioClock === null) {
      this.#stats.droppedAudioFrames += 1;
      return;
    }
    if (!config) {
      this.#audioConfig = header;
    }
    if (!this.#audioAnnounced) {
      this.#audioAnnounced = true;
      this.#hooks.onTrack("audio", {
        timescale: header.sampleRate,
        stsd: buildAacStsd(header),
        width: null,
        height: null,
        sampleRate: header.sampleRate,
        channelCount: channelCountOf(header.channelConfiguration),
        language: this.#audioLanguage,
        codec: `mp4a.40.${header.profile + 1}`,
      });
    }
    const dts = this.#audioClock;
    this.#audioClock += AAC_FRAME_SAMPLES;
    this.#stats.audioSamples += 1;
    this.#hooks.onSample("audio", { dts, cts: 0, sync: true, bytes: frame.slice() });
  }

  /** @returns {number} the audio PID (for a report), or -1 */
  #audioPid() {
    for (const [pid, state] of this.#pes) if (state.kind === "audio") return pid;
    return -1;
  }
}

/**
 * Adds a parameter set to a list unless the same bytes are there already.
 * @param {Uint8Array[]} list
 * @param {Uint8Array} nal
 * @param {number} max
 */
function addUnique(list, nal, max) {
  for (const known of list) {
    if (known.length === nal.length && known.every((byte, i) => byte === nal[i])) return;
  }
  if (list.length < max) list.push(nal.slice());
}

/**
 * Whether an elementary stream never carries audio or video: a data stream type, or private
 * data (0x06) without a descriptor that names an audio or video codec.
 * @param {number} type
 * @param {Uint8Array} descriptors
 * @returns {boolean}
 */
function isDataStream(type, descriptors) {
  if (DATA_STREAM_TYPES.has(type)) return true;
  if (type !== 0x06) return false;
  for (let pos = 0; pos + 2 <= descriptors.length; pos += 2 + descriptors[pos + 1]) {
    const tag = descriptors[pos];
    if (MEDIA_DESCRIPTOR_TAGS.has(tag)) return false;
    if (tag === 0x05 && pos + 6 <= descriptors.length) {
      const format = String.fromCharCode(...descriptors.subarray(pos + 2, pos + 6));
      if (MEDIA_REGISTRATIONS.has(format)) return false;
    }
  }
  return true;
}

/**
 * The ISO 639-2 code of an ISO_639_language_descriptor (tag 0x0A), when there is one.
 * @param {Uint8Array} descriptors
 * @returns {string | null}
 */
function languageOf(descriptors) {
  for (let pos = 0; pos + 2 <= descriptors.length; pos += 2 + descriptors[pos + 1]) {
    if (descriptors[pos] === 0x0a && descriptors[pos + 1] >= 3 && pos + 5 <= descriptors.length) {
      const code = String.fromCharCode(...descriptors.subarray(pos + 2, pos + 5));
      if (/^[a-z]{3}$/.test(code)) return code;
    }
  }
  return null;
}

// --------------------------------------------------------------------------- track plans

/**
 * @typedef {object} DemuxProblem
 * @property {DemuxProblemCode} code
 * @property {DemuxProblemParams} params
 */

/**
 * @typedef {object} DemuxCollector
 * @property {TsDemuxerHooks} hooks hand these to `new TsDemuxer(hooks)`
 * @property {() => TrackPlan[]} plans the tracks so far: video first, then audio; only kinds
 *   whose `onTrack` came
 * @property {DemuxProblem[]} problems every problem reported, in order
 */

/**
 * Turns a {@link TsDemuxer}'s hook calls into the spec's TrackPlans: each sample's bytes go to
 * `store`, which writes them (or queues the write) and returns where they live; the plan keeps
 * only that reference, the timing and the sync flag. Pure apart from calling `store` and
 * `onProblem`.
 * @param {(kind: TrackKind, bytes: Uint8Array) => SampleData} store
 * @param {(code: DemuxProblemCode, params: DemuxProblemParams) => void} [onProblem] also told
 *   of every problem, as it happens
 * @returns {DemuxCollector}
 */
export function tracksFromDemux(store, onProblem) {
  /** @type {Map<TrackKind, TrackPlan>} */
  const tracks = new Map();
  /** @type {DemuxProblem[]} */
  const problems = [];
  /** @type {TsDemuxerHooks} */
  const hooks = {
    onTrack(kind, info) {
      if (tracks.has(kind)) return;
      tracks.set(kind, {
        kind,
        timescale: info.timescale,
        stsd: info.stsd,
        width: info.width,
        height: info.height,
        sampleRate: info.sampleRate,
        channelCount: info.channelCount,
        language: info.language,
        samples: [],
      });
    },
    onSample(kind, sample) {
      const track = tracks.get(kind);
      if (!track) return;
      track.samples.push({
        dts: sample.dts,
        cts: sample.cts,
        size: sample.bytes.length,
        sync: sample.sync,
        data: store(kind, sample.bytes),
      });
    },
    onProblem(code, params) {
      problems.push({ code, params });
      if (onProblem) onProblem(code, params);
    },
  };
  /** @type {TrackKind[]} */
  const order = ["video", "audio"];
  return {
    hooks,
    plans: () => order.flatMap((kind) => tracks.get(kind) ?? []),
    problems,
  };
}
