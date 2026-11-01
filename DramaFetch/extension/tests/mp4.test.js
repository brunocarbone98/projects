// @ts-check
/**
 * Unit tests of `src/lib/mp4.js`: the integrity verdicts of `media.verify_video`, the structural
 * DRM walk of `media.drm_problem_in`, the body and image helpers, and the cover writer — on
 * `tests/fixtures/tiny.mp4` and variants built here by structural edits (no binary fixture of
 * their own). `tests/test_extension_media.py` compares the same functions with the Python ones.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DRM_MESSAGE } from "../src/lib/messages.js";
import {
  COVER_FORMATS,
  DURATION_TOLERANCE_RATIO,
  DURATION_TOLERANCE_S,
  ENCRYPTED_SAMPLE_ENTRIES,
  IMAGE_EXTENSIONS,
  IMAGE_MIME_TYPES,
  KNOWN_ATOMS,
  MAX_ATOMS,
  MAX_COVER_BYTES,
  MAX_DRM_BOXES,
  MIN_IMAGE_BYTES,
  MIN_VIDEO_BYTES,
  MediaError,
  PSSH_BOX,
  ThumbnailError,
  atomProblem,
  bodyProblem,
  drmProblem,
  embedCover,
  extensionFor,
  extractCover,
  formatSize,
  hasEmbeddedCover,
  imageKind,
  imageProblem,
  mimeTypeFor,
  probe,
  verifyVideo,
} from "../src/lib/mp4.js";

const TINY = new Uint8Array(
  readFileSync(new URL("../../tests/fixtures/tiny.mp4", import.meta.url)),
);
/** The fixture's top-level atoms: ftyp (32 bytes), moov (3363), free (8), mdat (17128). */
const MDAT_OFFSET = 3403;
const MDAT_SIZE = 17128;
/** The audio track's `mdhd` (version 0: its timescale and duration at +20 and +24). */
const AUDIO_MDHD = 1588;
const JPEG = concat(
  bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
  text("JFIF"),
  new Uint8Array(600),
  bytes([0xff, 0xd9]),
);
const PNG = concat(bytes([0x89]), text("PNG\r\n\x1a\n"), new Uint8Array(400));
const WEBP = concat(text("RIFF"), bytes([0x2c, 1, 0, 0]), text("WEBPVP8 "), new Uint8Array(300));

// ----------------------------------------------------------------------------- byte helpers

/**
 * @param {number[]} values
 * @returns {Uint8Array}
 */
function bytes(values) {
  return new Uint8Array(values);
}

/**
 * @param {string} value Latin-1 characters only
 * @returns {Uint8Array}
 */
function text(value) {
  return bytes(Array.from(value, (char) => char.charCodeAt(0)));
}

/**
 * @param {...Uint8Array} parts
 * @returns {Uint8Array}
 */
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * @param {Uint8Array} data
 * @param {number} at
 * @returns {number}
 */
function u32(data, at) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at);
}

/**
 * @param {Uint8Array} data
 * @param {number} at
 * @returns {bigint}
 */
function u64(data, at) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(at);
}

/**
 * @param {number} value
 * @returns {Uint8Array}
 */
function be32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/**
 * @param {bigint} value
 * @returns {Uint8Array}
 */
function be64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value);
  return out;
}

/**
 * @param {string} kind
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
function box(kind, payload) {
  return concat(be32(8 + payload.length), text(kind), payload);
}

/**
 * @param {Uint8Array} data
 * @returns {string}
 */
function latin1(data) {
  return String.fromCharCode(...data);
}

/**
 * `[offset, size, type]` of the 32-bit boxes between `start` and `end`.
 * @param {Uint8Array} data
 * @param {number} [start]
 * @param {number} [end]
 * @returns {[number, number, string][]}
 */
function boxes(data, start = 0, end = data.length) {
  /** @type {[number, number, string][]} */
  const found = [];
  let pos = start;
  while (pos + 8 <= end) {
    const size = u32(data, pos);
    if (size < 8 || pos + size > end) throw new Error(`not a box at ${pos}`);
    found.push([pos, size, latin1(data.subarray(pos + 4, pos + 8))]);
    pos += size;
  }
  return found;
}

/**
 * `[offset, size]` of the first box of `kind` between `start` and `end`.
 * @param {Uint8Array} data
 * @param {string} kind
 * @param {number} [start]
 * @param {number} [end]
 * @returns {[number, number]}
 */
function child(data, kind, start = 0, end = data.length) {
  const found = boxes(data, start, end).find(([, , type]) => type === kind);
  if (found === undefined) throw new Error(`no ${kind} box`);
  return [found[0], found[1]];
}

/**
 * `[offset, size]` down a path of boxes (a `meta` is a full box: 4 more bytes before its children).
 * @param {Uint8Array} data
 * @param {...string} path
 * @returns {[number, number]}
 */
function at(data, ...path) {
  let [start, end] = [0, data.length];
  let found = /** @type {[number, number]} */ ([0, data.length]);
  for (const kind of path) {
    found = child(data, kind, start, end);
    start = found[0] + 8 + (kind === "meta" ? 4 : 0);
    end = found[0] + found[1];
  }
  return found;
}

/**
 * @param {Uint8Array} data
 * @param {number} offset
 * @param {Uint8Array} replacement
 * @returns {Uint8Array}
 */
function patched(data, offset, replacement) {
  const out = data.slice();
  out.set(replacement, offset);
  return out;
}

/** Container boxes on the way from `moov` to the chunk offset tables. */
const TABLE_PATH = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

/**
 * `[offset, type]` of every `stco` / `co64` under `moov`.
 * @param {Uint8Array} data
 * @param {number} [start]
 * @param {number} [end]
 * @returns {[number, string][]}
 */
function tables(data, start = 0, end = data.length) {
  /** @type {[number, string][]} */
  const found = [];
  for (const [pos, size, kind] of boxes(data, start, end)) {
    if (TABLE_PATH.has(kind)) found.push(...tables(data, pos + 8, pos + size));
    else if (kind === "stco" || kind === "co64") found.push([pos, kind]);
  }
  return found;
}

/**
 * Every chunk offset of every track.
 * @param {Uint8Array} data
 * @returns {bigint[]}
 */
function chunkOffsets(data) {
  /** @type {bigint[]} */
  const offsets = [];
  for (const [pos, kind] of tables(data)) {
    const width = kind === "stco" ? 4 : 8;
    const count = u32(data, pos + 12);
    for (let index = 0; index < count; index += 1) {
      const entry = pos + 16 + index * width;
      offsets.push(width === 4 ? BigInt(u32(data, entry)) : u64(data, entry));
    }
  }
  return offsets;
}

/**
 * `data` with every chunk offset moved by `delta`.
 * @param {Uint8Array} data
 * @param {number} delta
 * @returns {Uint8Array}
 */
function shiftChunks(data, delta) {
  const out = data.slice();
  const view = new DataView(out.buffer);
  for (const [pos, kind] of tables(data)) {
    const width = kind === "stco" ? 4 : 8;
    const count = u32(data, pos + 12);
    for (let index = 0; index < count; index += 1) {
      const entry = pos + 16 + index * width;
      if (width === 4) view.setUint32(entry, view.getUint32(entry) + delta);
      else view.setBigUint64(entry, view.getBigUint64(entry) + BigInt(delta));
    }
  }
  return out;
}

/**
 * Every track's sample entries: `[offset, type]` of the boxes in `moov/trak/mdia/minf/stbl/stsd`.
 * @param {Uint8Array} data
 * @returns {[number, string][]}
 */
function sampleEntries(data) {
  const [moov, moovSize] = child(data, "moov");
  /** @type {[number, string][]} */
  const found = [];
  for (const [trak, trakSize, kind] of boxes(data, moov + 8, moov + moovSize)) {
    if (kind !== "trak") continue;
    let [start, end] = [trak + 8, trak + trakSize];
    for (const container of ["mdia", "minf", "stbl", "stsd"]) {
      const [pos, size] = child(data, container, start, end);
      [start, end] = [pos + 8, pos + size];
    }
    for (const [pos, , entry] of boxes(data, start + 8, end)) found.push([pos, entry]);
  }
  return found;
}

/**
 * `data` with the sample entry of type `from` renamed `to`, in place.
 * @param {Uint8Array} data
 * @param {string} from
 * @param {string} to
 * @returns {Uint8Array}
 */
function renamedEntry(data, from, to) {
  const found = sampleEntries(data).filter(([, kind]) => kind === from);
  assert.equal(found.length, 1);
  return patched(data, found[0][0] + 4, text(to));
}

/**
 * A version-0 `pssh` box (Widevine's system id).
 * @param {Uint8Array} [payload]
 * @returns {Uint8Array}
 */
function psshBox(payload = new Uint8Array(0)) {
  const systemId = bytes([
    0xed, 0xef, 0x8b, 0xa9, 0x79, 0xd6, 0x4a, 0xce, 0xa3, 0xc8, 0x27, 0xdc, 0xd5, 0x1d, 0x21, 0xed,
  ]);
  return box("pssh", concat(new Uint8Array(4), systemId, be32(payload.length), payload));
}

/** What `tests/encrypted_mp4.py` builds: both entries renamed and a top-level `pssh`. */
const ENCRYPTED = concat(
  renamedEntry(renamedEntry(TINY, "avc1", "encv"), "mp4a", "enca"),
  psshBox(text("key id")),
);

/**
 * The audio `trak` (the one whose `hdlr` says `soun`) replaced by a `free` box of its size.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function withoutAudioTrack(data) {
  const [moov, moovSize] = child(data, "moov");
  for (const [pos, size, kind] of boxes(data, moov + 8, moov + moovSize)) {
    if (kind === "trak" && latin1(data.subarray(pos, pos + size)).includes("soun")) {
      return patched(data, pos, box("free", new Uint8Array(size - 8)));
    }
  }
  throw new Error("no sound track");
}

/**
 * The audio `mdhd` saying `duration / timescale` seconds.
 * @param {number} timescale
 * @param {number} duration
 * @returns {Uint8Array}
 */
function lasting(timescale, duration) {
  const mdhd = AUDIO_MDHD;
  assert.equal(latin1(TINY.subarray(mdhd + 4, mdhd + 8)), "mdhd");
  return patched(TINY, mdhd + 20, concat(be32(timescale), be32(duration)));
}

/**
 * The `moov` moved behind the `mdat`, chunk offsets fixed.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function moovLast(data) {
  const [moov, size] = child(data, "moov");
  const shifted = shiftChunks(data, -size);
  return concat(
    shifted.subarray(0, moov),
    shifted.subarray(moov + size),
    shifted.subarray(moov, moov + size),
  );
}

/**
 * The `moov` without its `udta`, chunk offsets fixed.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function withoutUdta(data) {
  const [moov, moovSize] = child(data, "moov");
  const [udta, udtaSize] = child(data, "udta", moov + 8, moov + moovSize);
  const shifted = shiftChunks(data, -udtaSize);
  shifted.set(be32(moovSize - udtaSize), moov);
  return concat(shifted.subarray(0, udta), shifted.subarray(udta + udtaSize));
}

/**
 * Every `stco` rebuilt as a `co64`; the `moov` grows, so every chunk offset moves.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function withCo64(data) {
  const growth = tables(data).reduce((sum, [pos]) => sum + 4 * u32(data, pos + 12), 0);
  /**
   * @param {number} start
   * @param {number} end
   * @returns {Uint8Array}
   */
  const rebuilt = (start, end) =>
    concat(
      ...boxes(data, start, end).map(([pos, size, kind]) => {
        if (TABLE_PATH.has(kind)) return box(kind, rebuilt(pos + 8, pos + size));
        if (kind !== "stco") return data.subarray(pos, pos + size);
        const count = u32(data, pos + 12);
        const entries = Array.from({ length: count }, (_, index) =>
          be64(BigInt(u32(data, pos + 16 + 4 * index) + growth)),
        );
        return box("co64", concat(data.subarray(pos + 8, pos + 16), ...entries));
      }),
    );
  const [moov, moovSize] = child(data, "moov");
  return concat(
    data.subarray(0, moov),
    box("moov", rebuilt(moov + 8, moov + moovSize)),
    data.subarray(moov + moovSize),
  );
}

/**
 * A seeded PRNG in [0, 1) (mulberry32): the fuzz is the same on every run.
 * @param {number} seed
 * @returns {() => number}
 */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------- tests

test("the constants are media.py's, thumbnails.py's and downloader_browser.py's", () => {
  assert.equal(MIN_VIDEO_BYTES, 64 * 1024);
  assert.equal(MIN_IMAGE_BYTES, 200);
  assert.equal(MAX_COVER_BYTES, 5 * 1024 * 1024);
  assert.deepEqual([DURATION_TOLERANCE_S, DURATION_TOLERANCE_RATIO], [3.0, 0.05]);
  assert.deepEqual([...KNOWN_ATOMS].sort(), [
    "free",
    "ftyp",
    "junk",
    "mdat",
    "meta",
    "mfra",
    "moof",
    "moov",
    "pdin",
    "sidx",
    "skip",
    "styp",
    "uuid",
    "wide",
  ]);
  assert.deepEqual([MAX_ATOMS, MAX_DRM_BOXES], [1024, 1024]);
  assert.deepEqual([...ENCRYPTED_SAMPLE_ENTRIES].sort(), ["enca", "encv"]);
  assert.equal(PSSH_BOX, "pssh");
  assert.deepEqual(COVER_FORMATS, { jpeg: 13, png: 14 });
  assert.deepEqual(IMAGE_EXTENSIONS, { jpeg: ".jpg", png: ".png", webp: ".webp" });
  assert.deepEqual(IMAGE_MIME_TYPES, { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" });
  assert.equal(DRM_MESSAGE, "protected by DRM (encrypted tracks): DramaFetch does not decrypt it");
});

test("probe reads the fixture the way mutagen does", () => {
  assert.deepEqual(probe(TINY), {
    durationS: 3.01859410430839,
    hasAudio: true,
    audioCodec: "mp4a.40.2",
  });
  assert.deepEqual(
    probe(TINY.buffer.slice(TINY.byteOffset, TINY.byteOffset + TINY.byteLength)),
    probe(TINY),
  );
  const silent = probe(withoutAudioTrack(TINY));
  assert.equal(silent.hasAudio, false);
  assert.equal(silent.audioCodec, null);
  assert.equal(silent.durationS, 3); // the mvhd's 3000 / 1000 when there is no sound track
  assert.throws(
    () => probe(TINY.subarray(0, 2000)),
    (error) => {
      assert.ok(error instanceof MediaError);
      assert.equal(error.message, "not a valid MP4 (truncated data)");
      return true;
    },
  );
});

test("verifyVideo: the fixture passes; the duration is judged within max(3 s, 5 %)", () => {
  for (const expected of [null, undefined, 0, 3, 6])
    assert.equal(verifyVideo(TINY, expected), null);
  assert.equal(verifyVideo(TINY, 7), "duration 3 s, expected 7 s");
  assert.equal(verifyVideo(TINY, 120), "duration 3 s, expected 120 s");
  assert.equal(verifyVideo(lasting(1, 385), 400), null); // 5 % of 400 s is wider than 3 s
  assert.equal(verifyVideo(lasting(5, 1852), 400), "duration 370 s, expected 400 s");
});

test("verifyVideo prints the duration rounded half to even, like Python's :.0f", () => {
  assert.equal(verifyVideo(lasting(2, 1), 120), "duration 0 s, expected 120 s");
  assert.equal(verifyVideo(lasting(2, 5), 120), "duration 2 s, expected 120 s");
  assert.equal(verifyVideo(lasting(2, 7), 120), "duration 4 s, expected 120 s");
  assert.equal(verifyVideo(lasting(2, 9), 120), "duration 4 s, expected 120 s");
  assert.equal(verifyVideo(lasting(0, 1000), 3), "no playable duration"); // timescale 0
});

test("verifyVideo: bytes that are not an MP4, and files cut short", () => {
  assert.equal(verifyVideo(new Uint8Array(0), 3), "not a valid MP4 (not a MP4 file)");
  assert.equal(verifyVideo(TINY.subarray(0, 2000), 3), "not a valid MP4 (truncated data)");
  const random = seeded(7);
  const junk = Uint8Array.from({ length: 70_000 }, () => Math.floor(random() * 256));
  assert.match(/** @type {string} */ (verifyVideo(junk, 3)), /^not a valid MP4 \(/);
  const have = 12000 - MDAT_OFFSET;
  assert.equal(
    verifyVideo(TINY.subarray(0, 12000), 3),
    `truncated MP4 (mdat atom cut short: ${have} of ${MDAT_SIZE} bytes)`,
  );
  // the fake CDN's `truncate_media`: 60 % of a padded file cuts its padding atom
  const padded = concat(TINY, box("free", new Uint8Array(128 * 1024 - TINY.length - 8)));
  const short = padded.subarray(0, Math.floor(padded.length * 0.6));
  const free = 128 * 1024 - TINY.length;
  assert.equal(
    verifyVideo(short, 3),
    `truncated MP4 (free atom cut short: ${short.length - TINY.length} of ${free} bytes)`,
  );
  // cut inside the 8 bytes between moov and mdat: mutagen and the atom walk both see a whole file
  assert.equal(verifyVideo(TINY.subarray(0, MDAT_OFFSET - 3), 3), null);
  assert.equal(verifyVideo(withoutAudioTrack(TINY), 3), "no audio track");
});

test("atomProblem: only a known atom cut short is a truncation", () => {
  assert.equal(atomProblem(TINY), null);
  assert.equal(atomProblem(concat(TINY, text("JUNK".repeat(40)))), null);
  assert.equal(atomProblem(concat(TINY, be32(1_000_000), text("zzzz"), new Uint8Array(16))), null);
  assert.equal(atomProblem(concat(TINY, bytes([0, 0, 0, 16]), text("fr"))), null);
  const big = concat(TINY, be32(1), text("mdat"), be64(116n), new Uint8Array(10));
  assert.equal(atomProblem(big), "truncated MP4 (mdat atom cut short: 26 of 116 bytes)");
  const huge = concat(TINY, be32(1), text("mdat"), be64((1n << 64n) - 1n));
  assert.equal(
    atomProblem(huge),
    "truncated MP4 (mdat atom cut short: 16 of 18446744073709551615 bytes)",
  );
  const header = concat(TINY, be32(1), text("mdat"), bytes([0, 0]));
  assert.equal(
    atomProblem(header),
    "truncated MP4 (mdat atom cut short: 10 bytes left for its header)",
  );
  assert.equal(atomProblem(concat(TINY, be32(0), text("mdat"), text("x"))), null);
  assert.equal(
    verifyVideo(huge, 3),
    "not a valid MP4 (cannot fit 'int' into an offset-sized integer)",
  );
});

test("drmProblem finds encrypted tracks in the box structure", () => {
  const [udta, udtaSize] = at(TINY, "moov", "udta");
  const moovPssh = patched(TINY, udta, psshBox(new Uint8Array(udtaSize - 32)));
  assert.equal(u32(moovPssh, udta), udtaSize);
  const variants = [
    renamedEntry(TINY, "avc1", "encv"),
    renamedEntry(TINY, "mp4a", "enca"),
    concat(TINY, psshBox(text("key"))),
    moovPssh,
    ENCRYPTED,
  ];
  for (const variant of variants) {
    assert.equal(drmProblem(variant), DRM_MESSAGE);
    assert.equal(verifyVideo(variant, 3), null); // the integrity check alone lets every one through
  }
  assert.equal(drmProblem(TINY), null);
  assert.equal(drmProblem(concat(TINY, box("free", new Uint8Array(128 * 1024)))), null);
});

test("drmProblem never searches the samples: encv inside mdat is no DRM", () => {
  const words = concat(
    be32(16),
    text("encv"),
    new Uint8Array(8),
    be32(16),
    text("enca"),
    new Uint8Array(8),
    psshBox(),
  );
  const grown = patched(TINY, MDAT_OFFSET, be32(MDAT_SIZE + words.length));
  const data = concat(grown, words);
  assert.ok(latin1(data).includes("encv") && latin1(data).includes("pssh"));
  assert.equal(drmProblem(data), null);
  assert.equal(verifyVideo(data, 3), null);
  // a top-level box called encv is not a sample entry
  assert.equal(drmProblem(concat(TINY, box("encv", new Uint8Array(8)))), null);
});

test("drmProblem: a cut right after an encv header still declares it; junk never throws", () => {
  const video = renamedEntry(TINY, "avc1", "encv");
  const [encvAt] = /** @type {[number, string]} */ (
    sampleEntries(video).find(([, kind]) => kind === "encv")
  );
  assert.equal(drmProblem(video.subarray(0, encvAt + 8)), DRM_MESSAGE);
  const junk = [
    new Uint8Array(0),
    new Uint8Array(7),
    concat(be32(7), text("pssh")),
    concat(be32(1), text("moov"), bytes([0, 0])),
    concat(be32(1), text("moov"), be64(8n)),
    concat(be32(2 ** 31), text("moov"), be32(16), text("trak"), new Uint8Array(8)),
    concat(TINY.subarray(0, 32), new Uint8Array(64).fill(0xff)),
  ];
  for (const data of junk) assert.equal(drmProblem(data), null);
});

test("drmProblem reads at most MAX_DRM_BOXES box headers", () => {
  const empty = box("free", new Uint8Array(0));
  const repeated = (/** @type {number} */ count) =>
    concat(...Array.from({ length: count }, () => empty));
  assert.equal(drmProblem(concat(TINY.subarray(0, 32), repeated(10), psshBox())), DRM_MESSAGE);
  assert.equal(
    drmProblem(concat(TINY.subarray(0, 32), repeated(MAX_DRM_BOXES + 10), psshBox())),
    null,
  );
});

test("a seeded fuzz: verifyVideo and drmProblem never throw", () => {
  const random = seeded(20261101);
  for (let round = 0; round < 300; round += 1) {
    let data = (round % 2 ? ENCRYPTED : TINY).slice();
    const flips = 1 + Math.floor(random() * 12);
    for (let flip = 0; flip < flips; flip += 1) {
      const position =
        random() < 0.5 ? Math.floor(random() * 3395) : Math.floor(random() * data.length);
      data[position] = Math.floor(random() * 256);
    }
    if (random() < 0.3) data = data.subarray(0, Math.floor(random() * (data.length + 1)));
    const verdict = verifyVideo(data, 3);
    assert.ok(verdict === null || typeof verdict === "string");
    assert.ok([null, DRM_MESSAGE].includes(drmProblem(data)));
    assert.ok(extractCover(data) === null || extractCover(data) !== undefined);
  }
});

test("bodyProblem: too small, or neither a video type nor MP4 bytes", () => {
  const page = text(`<html>${"x".repeat(17_400)}</html>`);
  assert.equal(
    bodyProblem(page, "text/html; charset=utf-8"),
    "17.0 KiB of text/html instead of a video",
  );
  assert.equal(bodyProblem(new Uint8Array(10)), "10 bytes of an untyped body instead of a video");
  const large = concat(text("<html>"), new Uint8Array(70 * 1024));
  assert.equal(bodyProblem(large, " TEXT/HTML "), "text/html instead of a video");
  assert.equal(bodyProblem(large, "video/mp4"), null);
  assert.equal(bodyProblem(large, "application/octet-stream"), null);
  const video = concat(TINY, new Uint8Array(64 * 1024));
  assert.equal(bodyProblem(video, "text/plain"), null); // ftyp in the first 32 bytes
  assert.equal(bodyProblem(video), null);
});

test("imageKind, imageProblem, formatSize, extensionFor and mimeTypeFor", () => {
  assert.equal(imageKind(JPEG), "jpeg");
  assert.equal(imageKind(PNG), "png");
  assert.equal(imageKind(WEBP), "webp");
  assert.equal(imageKind(text("GIF89a")), null);
  assert.equal(imageKind(text("????"), "image/jpg"), "jpeg");
  assert.equal(imageKind(text("????"), "Image/PNG; q=1"), "png");
  // any other image/* is taken for a JPEG
  assert.equal(imageKind(text("????"), "image/avif"), "jpeg");
  assert.equal(imageKind(text("????"), "text/html"), null);
  assert.equal(imageKind(PNG, "image/jpeg"), "png"); // the bytes decide
  assert.equal(imageKind(text("????"), "\ufeffimage/png"), null); // U+FEFF is no space to Python
  assert.equal(
    imageProblem(new Uint8Array(12), "text/html"),
    "12 bytes of text/html instead of an image",
  );
  assert.equal(imageProblem(new Uint8Array(500)), "an untyped body instead of an image");
  assert.deepEqual(
    [0, 1023, 1024, 1280, 1536, 2560, 1024 * 1024, 1_310_720, 5 * 1024 * 1024 + 1].map(formatSize),
    [
      "0 bytes",
      "1023 bytes",
      "1.0 KiB",
      "1.2 KiB",
      "1.5 KiB",
      "2.5 KiB",
      "1.0 MiB",
      "1.2 MiB",
      "5.0 MiB",
    ],
  );
  assert.deepEqual(["jpeg", "png", "webp"].map(extensionFor), [".jpg", ".png", ".webp"]);
  assert.deepEqual(["jpeg", "png", "webp"].map(mimeTypeFor), [
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);
  assert.throws(() => extensionFor("gif"), /unknown image kind 'gif'/);
});

test("embedCover puts the cover where mutagen reads it and moves the chunk offsets with it", () => {
  const original = TINY.slice();
  const out = embedCover(TINY, JPEG, "jpeg");
  assert.deepEqual(TINY, original); // the input is never modified
  const cover = extractCover(out);
  assert.ok(cover !== null);
  assert.deepEqual(cover.data, JPEG);
  assert.equal(cover.mime, "image/jpeg");
  assert.ok(hasEmbeddedCover(out) && !hasEmbeddedCover(TINY));
  const covrSize = 8 + 16 + JPEG.length;
  assert.equal(out.length, TINY.length + covrSize);
  for (const path of [
    ["moov"],
    ["moov", "udta"],
    ["moov", "udta", "meta"],
    ["moov", "udta", "meta", "ilst"],
  ]) {
    assert.equal(at(out, ...path)[1], at(TINY, ...path)[1] + covrSize, path.join("/"));
  }
  const [ilst, ilstSize] = at(out, "moov", "udta", "meta", "ilst");
  const tags = boxes(out, ilst + 8, ilst + ilstSize);
  assert.deepEqual(
    tags.map(([, , kind]) => kind),
    ["\xa9too", "covr"],
  ); // every other tag kept
  const [too, tooSize] = at(TINY, "moov", "udta", "meta", "ilst", "\xa9too");
  assert.deepEqual(
    out.subarray(tags[0][0], tags[0][0] + tags[0][1]),
    TINY.subarray(too, too + tooSize),
  );
  const [covr] = tags[1];
  assert.equal(latin1(out.subarray(covr + 12, covr + 16)), "data");
  assert.deepEqual([u32(out, covr + 16), u32(out, covr + 20)], [COVER_FORMATS.jpeg, 0]);
  assert.deepEqual(
    chunkOffsets(out),
    chunkOffsets(TINY).map((offset) => offset + BigInt(covrSize)),
  );
  assert.equal(verifyVideo(out, 3), null);
  assert.equal(drmProblem(out), null);
  assert.deepEqual(probe(out), probe(TINY));
});

test("embedCover replaces an existing cover, a PNG as data type 14", () => {
  const first = embedCover(TINY, JPEG);
  const second = embedCover(first, PNG, "png");
  const [ilst, ilstSize] = at(second, "moov", "udta", "meta", "ilst");
  assert.deepEqual(
    boxes(second, ilst + 8, ilst + ilstSize).map(([, , kind]) => kind),
    ["\xa9too", "covr"],
  );
  const cover = extractCover(second);
  assert.ok(cover !== null);
  assert.deepEqual([cover.data, cover.mime], [PNG, "image/png"]);
  assert.equal(second.length, first.length - JPEG.length + PNG.length);
  assert.deepEqual(
    chunkOffsets(second),
    chunkOffsets(TINY).map((offset) => offset + BigInt(8 + 16 + PNG.length)),
  );
  assert.equal(verifyVideo(second, 3), null);
});

test("embedCover without a udta adds one at the end of the moov, with mutagen's meta", () => {
  const plain = withoutUdta(TINY);
  assert.equal(verifyVideo(plain, 3), null);
  const out = embedCover(plain, JPEG);
  const [moov, moovSize] = at(out, "moov");
  const children = boxes(out, moov + 8, moov + moovSize).map(([, , kind]) => kind);
  assert.deepEqual(children, ["mvhd", "trak", "trak", "udta"]); // the tracks keep their order
  const [meta, metaSize] = at(out, "moov", "udta", "meta");
  assert.deepEqual(out.subarray(meta + 8, meta + 12), new Uint8Array(4)); // a full box
  const [hdlr, hdlrSize] = at(out, "moov", "udta", "meta", "hdlr");
  assert.equal(hdlrSize, 33);
  assert.equal(latin1(out.subarray(hdlr + 16, hdlr + 24)), "mdirappl");
  const [udta, udtaSize] = at(out, "moov", "udta");
  assert.equal(udta + udtaSize, moov + moovSize); // the last child of the moov
  assert.equal(meta + metaSize, udta + udtaSize);
  assert.deepEqual(extractCover(out)?.data, JPEG);
  const delta = out.length - plain.length;
  assert.deepEqual(
    chunkOffsets(out),
    chunkOffsets(plain).map((offset) => offset + BigInt(delta)),
  );
  assert.equal(verifyVideo(out, 3), null);
});

test("embedCover with a udta but no meta puts mutagen's meta first in it", () => {
  const [meta, metaSize] = at(TINY, "moov", "udta", "meta");
  const noMeta = patched(TINY, meta, box("free", new Uint8Array(metaSize - 8)));
  const out = embedCover(noMeta, PNG);
  const [udta, udtaSize] = at(out, "moov", "udta");
  assert.deepEqual(
    boxes(out, udta + 8, udta + udtaSize).map(([, , kind]) => kind),
    ["meta", "free"],
  );
  assert.deepEqual(extractCover(out)?.data, PNG);
  assert.equal(verifyVideo(out, 3), null);
});

test("embedCover with the moov behind the mdat moves no chunk offset", () => {
  const late = moovLast(TINY);
  assert.equal(verifyVideo(late, 3), null);
  const out = embedCover(late, JPEG);
  assert.deepEqual(chunkOffsets(out), chunkOffsets(late));
  // ftyp, free and the start of the mdat: untouched
  assert.deepEqual(out.subarray(0, MDAT_OFFSET), late.subarray(0, MDAT_OFFSET));
  assert.deepEqual(extractCover(out)?.data, JPEG);
  assert.equal(verifyVideo(out, 3), null);
});

test("embedCover moves 64-bit co64 offsets too", () => {
  const wide = withCo64(TINY);
  assert.deepEqual(
    tables(wide).map(([, kind]) => kind),
    ["co64", "co64"],
  );
  assert.equal(verifyVideo(wide, 3), null);
  const out = embedCover(wide, PNG);
  const delta = BigInt(8 + 16 + PNG.length);
  assert.deepEqual(
    chunkOffsets(out),
    chunkOffsets(wide).map((offset) => offset + delta),
  );
  assert.deepEqual(extractCover(out)?.data, PNG);
});

test("embedCover refuses with a printable reason, like thumbnails.embed_cover", () => {
  /**
   * @param {() => unknown} call
   * @param {string} message
   */
  const refuses = (call, message) =>
    assert.throws(call, (error) => {
      assert.ok(error instanceof ThumbnailError);
      assert.equal(error.message, message);
      return true;
    });
  refuses(() => embedCover(TINY, WEBP), "webp cannot be embedded");
  refuses(() => embedCover(TINY, JPEG, "webp"), "webp cannot be embedded");
  refuses(() => embedCover(TINY, text("GIF89a")), "not a JPEG or PNG image");
  const tooBig = concat(JPEG.subarray(0, 4), new Uint8Array(MAX_COVER_BYTES + 1 - 4));
  refuses(() => embedCover(TINY, tooBig), "5,242,881 bytes is above the 5 MiB cover limit");
  refuses(
    () => embedCover(new Uint8Array(100), JPEG),
    "could not write the cover into the video (MP4StreamInfoError: not a MP4 file)",
  );
  refuses(
    () => embedCover(TINY.subarray(0, 2000), JPEG, null, "ep.mp4"),
    "could not write the cover into ep.mp4 (error: truncated data)",
  );
  const [audioTable] = /** @type {[number, string]} */ (tables(TINY)[1]);
  const count = u32(TINY, audioTable + 12);
  const overflow = patched(TINY, audioTable + 16 + 4 * (count - 1), be32(0xfffffff0));
  refuses(
    () => embedCover(overflow, JPEG, "jpeg", "ep.mp4"),
    "could not write the cover into ep.mp4 (MP4MetadataError: wrong offset inside b'stco')",
  );
  const fragmented = concat(TINY, box("moof", box("mfhd", new Uint8Array(8))));
  refuses(
    () => embedCover(fragmented, JPEG),
    "could not write the cover into the video (MP4MetadataError: a fragmented MP4 (moof): " +
      "its absolute offsets are not rewritten)",
  );
});

test("extractCover never throws and reads only a JPEG or a PNG", () => {
  assert.equal(extractCover(TINY), null);
  assert.equal(extractCover(new Uint8Array(0)), null);
  assert.equal(extractCover(TINY.subarray(0, 2000)), null);
  const copy = extractCover(embedCover(TINY, JPEG));
  assert.ok(copy !== null);
  copy.data[0] = 0; // a copy, not a view into the video
  assert.deepEqual(extractCover(embedCover(TINY, JPEG))?.data, JPEG);
});
