// @ts-check
/**
 * MP4 integrity, DRM detection and cover art over bytes held in memory: the extension's port of
 * `media.py` (`probe_video`, `atom_problem`, `verify_video`, `drm_problem_in`), `thumbnails.py`
 * (`image_kind`, `image_problem`, `format_size`, `extension_for`, `mime_type_for`, `embed_cover`,
 * `extract_cover`, `has_embedded_cover`) and `downloader_browser._body_problem`. Pure: no
 * `chrome.*`, no DOM, no dependency — it runs in Node (`node --test`, `tests/media_runner.js`)
 * and in the extension alike.
 *
 * The Python tool judges a saved file with mutagen's MP4 reader; the extension judges the body
 * before anything is saved. So this module carries a faithful port of the part of mutagen 1.48
 * that `verify_video` and `extract_cover` stand on: the atom tree (`mutagen/mp4/_atom.py`), the
 * stream info (`MP4Info.load`: the length of the first `soun` track's `mdhd`, else the `mvhd`'s;
 * the codec of that track's first sample entry, `_as_entry.py` down to the AAC
 * AudioSpecificConfig), the tag list (`MP4Tags.load`: every `ilst` child must be readable, and
 * the parsers that can fail the load — `covr`, `----`, `trkn`, `disk` — run as mutagen runs
 * them) and the chapters' checks (`MP4Chapters`), all with mutagen's — and Python's — own error
 * texts. `verifyVideo` therefore gives the verdict `media.verify_video` gives, word for word:
 * `tests/test_extension_media.py` compares them on the fixture, every truncation of it, hostile
 * box sizes, mutagen's corner cases, the encrypted variants and a seeded fuzz.
 *
 * Where a file system decides what Python does (a seek beyond the largest file the file system
 * allows: `[Errno 22] Invalid argument` on ext4, nothing on tmpfs), this port behaves like an
 * in-memory file and lets the seek through. Two safety bounds have no mutagen counterpart: atom
 * trees nested deeper than {@link MAX_NESTING} levels fail with Python's `maximum recursion depth
 * exceeded` (Python's own limit depends on the caller's stack), and a file of more than
 * {@link MAX_PARSED_ATOMS} atoms is `not a valid MP4 (too many atoms)` instead of costing a
 * gigabyte of memory.
 *
 * DRM (`drmProblem`) is the structural walk of `media.drm_problem_in` — box headers only, along
 * the paths where encryption is declared, bounded, never raising, never a raw byte search: the
 * bytes `encv` inside `mdat` mean nothing.
 *
 * Covers (`embedCover`) go where mutagen puts them, `moov/udta/meta/ilst/covr/data` (a full-box
 * `meta` with an `hdlr` `mdir`/`appl`; data type 13 for JPEG, 14 for PNG), replacing every
 * existing `covr` and keeping every other atom byte for byte. The size change moves whatever
 * follows the edit, so every `stco` / `co64` entry of every track that points past the edit
 * moves with it (mutagen's rule); an entry that would no longer fit fails like mutagen does
 * (`wrong offset inside b'stco'`), and the sample data is never touched. The input is never
 * modified: the result is a new buffer, read back before it is returned.
 */

import { DRM_MESSAGE } from "./messages.js";

// --------------------------------------------------------------------------------- constants

/** A real episode is megabytes: a body under this is an error page (`downloader_browser`). */
export const MIN_VIDEO_BYTES = 64 * 1024;
/** A cover is kilobytes; a body under this is an error body (`thumbnails.MIN_IMAGE_BYTES`). */
export const MIN_IMAGE_BYTES = 200;
/** Bigger "covers" are error pages or abuse: never kept, never embedded (`thumbnails`). */
export const MAX_COVER_BYTES = 5 * 1024 * 1024;
/** Duration tolerance: `max(3 s, 5 %)` of the listed duration (`media.DURATION_TOLERANCE_*`). */
export const DURATION_TOLERANCE_S = 3.0;
export const DURATION_TOLERANCE_RATIO = 0.05;
/** Top-level atoms a real MP4 is made of: the truncation walk trusts no other (`media`). */
export const KNOWN_ATOMS = /** @type {ReadonlySet<string>} */ (
  new Set([
    "ftyp",
    "styp",
    "moov",
    "moof",
    "mdat",
    "free",
    "skip",
    "wide",
    "junk",
    "uuid",
    "meta",
    "mfra",
    "sidx",
    "pdin",
  ])
);
/** Top-level atoms the truncation walk reads at most (`media._MAX_ATOMS`). */
export const MAX_ATOMS = 1024;
/** Box headers one DRM walk reads at most, every level together (`media._MAX_DRM_BOXES`). */
export const MAX_DRM_BOXES = MAX_ATOMS;
/** Sample-entry types of an encrypted track (`media.ENCRYPTED_SAMPLE_ENTRIES`, CENC). */
export const ENCRYPTED_SAMPLE_ENTRIES = /** @type {ReadonlySet<string>} */ (
  new Set(["encv", "enca"])
);
/** The Protection System Specific Header box (`media.PSSH_BOX`). */
export const PSSH_BOX = "pssh";
/** Nesting depth of the atom tree beyond which the reader gives up (no mutagen counterpart). */
export const MAX_NESTING = 400;
/** Atoms the reader builds at most for one file (no mutagen counterpart; a real MP4 has dozens). */
export const MAX_PARSED_ATOMS = 200_000;

/** @typedef {"jpeg" | "png" | "webp"} ImageKind */
/** The extension an image kind is saved under (`thumbnails.EXTENSIONS`). */
export const IMAGE_EXTENSIONS = Object.freeze({ jpeg: ".jpg", png: ".png", webp: ".webp" });
/** The MIME type of an image kind (`thumbnails.MIME_TYPES`). */
export const IMAGE_MIME_TYPES = Object.freeze({
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
});
/** The `covr` data types (`MP4Cover.FORMAT_JPEG` / `FORMAT_PNG`): a WEBP cannot live there. */
export const COVER_FORMATS = Object.freeze({ jpeg: 13, png: 14 });

const MIB = 1024 * 1024;
/** `media._MAX_DETAIL_LEN`: the detail of `not a valid MP4 (<detail>)` is cut there. */
const MAX_DETAIL_LEN = 120;
/** `thumbnails._MAX_REASON_LEN`: an embedding failure's reason is cut there. */
const MAX_REASON_LEN = 200;
/** `downloader_browser._VIDEO_CONTENT_TYPES`. */
const VIDEO_CONTENT_TYPES = ["video/", "application/octet-stream"];
/** `thumbnails._CONTENT_TYPES`: the content types a cover may come with. */
const CONTENT_TYPES = /** @type {ReadonlyMap<string, ImageKind>} */ (
  new Map([
    ["image/jpeg", "jpeg"],
    ["image/jpg", "jpeg"],
    ["image/pjpeg", "jpeg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ])
);
/** The atoms mutagen descends into (`mutagen/mp4/_atom.py` `_CONTAINERS`). */
const CONTAINERS = new Set([
  "moov",
  "udta",
  "trak",
  "mdia",
  "meta",
  "ilst",
  "stbl",
  "minf",
  "moof",
  "traf",
]);
/** The boxes from a `trak` down to its sample descriptions (`media._TRACK_PATH`). */
const TRACK_PATH = ["mdia", "minf", "stbl", "stsd"];
/** mutagen's tag parse errors, which only mark one tag as failed (`MP4Tags.load`). */
const SWALLOWED = new Set(["MP4MetadataError", "MP4MetadataValueError"]);
/** mutagen's own exception classes: `MP4.load` lets them through (`except error: raise`). */
const MUTAGEN_ERRORS = new Set([
  "error",
  "MP4MetadataError",
  "MP4StreamInfoError",
  "MP4NoTrackError",
  "MP4MetadataValueError",
]);
/** `DecoderSpecificInfo._FREQS`. */
const FREQS = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
/** AAC object types with a GASpecificConfig (`DecoderSpecificInfo._parse`). */
const GA_TYPES = new Set([1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23]);
/** AAC object types followed by an epConfig (`DecoderSpecificInfo._parse`). */
const EP_TYPES = new Set([17, 19, 20, 21, 22, 23, 24, 25, 26, 27, 39]);
/** The `hdlr` mutagen writes into a new `meta`: `mdir` / `appl` (`MP4Tags.__save_new`). */
const MDIR_HDLR_PAYLOAD = concat(new Uint8Array(8), ascii("mdirappl"), new Uint8Array(9));
const U32_MAX = 0xffffffff;
const U64_MAX = (1n << 64n) - 1n;
const SEEK_LIMIT = 1n << 63n;
const EMPTY = new Uint8Array(0);

// ------------------------------------------------------------------------------- the errors

/** Bytes that are not an MP4 mutagen could read (`errors.MediaError`): `not a valid MP4 (…)`. */
export class MediaError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "MediaError";
  }
}

/** A cover that cannot be embedded (`errors.ThumbnailError`); the message is printable as is. */
export class ThumbnailError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ThumbnailError";
  }
}

/** A Python exception as mutagen raises it: `message` is `str(exc)`, `pyType` its class name. */
class PyError extends Error {
  /**
   * @param {string} message
   * @param {string} pyType
   */
  constructor(message, pyType) {
    super(message);
    this.pyType = pyType;
  }
}

/**
 * @param {unknown} error
 * @param {string} type
 * @returns {boolean}
 */
function isPy(error, type) {
  return error instanceof PyError && error.pyType === type;
}

/**
 * `except <from> as e: raise <to>(e)`: the same text under another class; anything else as is.
 * @param {unknown} error
 * @param {string} from
 * @param {string} to
 * @returns {unknown}
 */
function retype(error, from, to) {
  return isPy(error, from) ? new PyError(errorText(error), to) : error;
}

/**
 * What `MP4.load` makes of an exception: mutagen's own classes unchanged, anything else wrapped
 * (`reraise(<type>, err)`), with the same text.
 * @param {unknown} error
 * @param {string} type
 * @returns {PyError}
 */
function asMutagen(error, type) {
  if (error instanceof PyError && MUTAGEN_ERRORS.has(error.pyType)) return error;
  return new PyError(errorText(error), type);
}

/**
 * `KeyError(message)`: Python's `str()` of a KeyError is the `repr()` of its argument.
 * @param {string} message
 * @returns {PyError}
 */
function keyError(message) {
  return new PyError(pyStrRepr(message), "KeyError");
}

/**
 * `struct.error` of an `unpack` that got the wrong number of bytes.
 * @param {number} size
 * @returns {PyError}
 */
function structError(size) {
  return new PyError(`unpack requires a buffer of ${size} bytes`, "error");
}

/**
 * `str(exc)`.
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * `exc.__class__.__name__`.
 * @param {unknown} error
 * @returns {string}
 */
function errorType(error) {
  if (error instanceof PyError) return error.pyType;
  if (error instanceof Error) return error.name || "Error";
  return "Error";
}

// ------------------------------------------------------------------- Python's string rules

/** What Python's `str.strip()` and `str.isspace()` count as whitespace (code points). */
const PY_WHITESPACE = new Set(
  [
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
    0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
    0x205f, 0x3000,
  ].map((code) => String.fromCharCode(code)),
);
/** Python's `str.splitlines()` line boundaries (`\r\n`, then each of these code points). */
const PY_LINE_BREAKS = new RegExp(
  "\\r\\n|[" +
    [0x0a, 0x0d, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]
      .map((code) => `\\u${code.toString(16).padStart(4, "0")}`)
      .join("") +
    "]",
);

/**
 * `text.strip()`.
 * @param {string} text
 * @returns {string}
 */
function pyStrip(text) {
  let start = 0;
  let end = text.length;
  while (start < end && PY_WHITESPACE.has(text[start])) start += 1;
  while (end > start && PY_WHITESPACE.has(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/**
 * `content_type.split(";")[0].strip().lower()`: the media type of a Content-Type header.
 * @param {string} contentType
 * @returns {string}
 */
function mediaType(contentType) {
  return pyStrip(String(contentType).split(";")[0]).toLowerCase();
}

/**
 * Cut to `limit` characters, the last one an ellipsis (`text[: limit - 1] + "…"`).
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function cut(text, limit) {
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : text;
}

/**
 * `media._detail(exc)`: the first non-blank line of the exception, else its class name, cut at
 * 120 characters.
 * @param {unknown} error
 * @returns {string}
 */
function detail(error) {
  const lines = errorText(error)
    .split(PY_LINE_BREAKS)
    .map(pyStrip)
    .filter((line) => line !== "");
  return cut(lines.length > 0 ? lines[0] : errorType(error), MAX_DETAIL_LEN);
}

/**
 * `thumbnails._describe(exc)`: `ClassName: first line` (the class name alone without text), cut
 * at 200 characters.
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  const text = pyStrip(errorText(error));
  const first = text ? pyStrip(text.split(PY_LINE_BREAKS)[0]) : "";
  return cut(first ? `${errorType(error)}: ${first}` : errorType(error), MAX_REASON_LEN);
}

/**
 * Python's `repr()` of a `str` (the quoting and escaping rules; non-ASCII kept unless it is a C1
 * control or one of the two Latin-1 non-printables).
 * @param {string} text
 * @returns {string}
 */
function pyStrRepr(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    const code = /** @type {number} */ (char.codePointAt(0));
    if (char === quote || char === "\\") out += `\\${char}`;
    else if (char === "\t") out += "\\t";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (code < 0x20 || (code >= 0x7f && code < 0xa1) || code === 0xad) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else out += char;
  }
  return out + quote;
}

/**
 * Python's `repr()` of a `bytes` value given as a Latin-1 string (an atom name): `b'moov'`.
 * @param {string} text
 * @returns {string}
 */
function pyBytesRepr(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = `b${quote}`;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const code = text.charCodeAt(index);
    if (char === quote || char === "\\") out += `\\${char}`;
    else if (code === 9) out += "\\t";
    else if (code === 10) out += "\\n";
    else if (code === 13) out += "\\r";
    else if (code < 32 || code >= 127) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += char;
  }
  return out + quote;
}

/**
 * `f"{x:.0f}"`: Python rounds the exact binary value, ties to even (`2.5` → `2`, `3.5` → `4`).
 * @param {number} value
 * @returns {string}
 */
function pyFixed0(value) {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  const negative = value < 0 || Object.is(value, -0);
  const magnitude = Math.abs(value);
  let whole = Math.floor(magnitude);
  const fraction = magnitude - whole; // exact for every double
  if (fraction > 0.5 || (fraction === 0.5 && whole % 2 === 1)) whole += 1;
  return `${negative ? "-" : ""}${BigInt(whole).toString()}`;
}

/**
 * `f"{numerator / denominator:.1f}"` for integers whose quotient is exact in binary (the
 * denominator a power of two): rounded half to even, like Python.
 * @param {number} numerator
 * @param {number} denominator
 * @returns {string}
 */
function pyFixed1(numerator, denominator) {
  const scaled = BigInt(numerator) * 10n;
  const divisor = BigInt(denominator);
  let tenths = scaled / divisor;
  const rest = (scaled % divisor) * 2n;
  if (rest > divisor || (rest === divisor && tenths % 2n === 1n)) tenths += 1n;
  return `${tenths / 10n}.${tenths % 10n}`;
}

/**
 * `f"{number:,}"`.
 * @param {number} number
 * @returns {string}
 */
function pyThousands(number) {
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Python's `int / int` (`duration / timescale` in `MP4Info._parse_mvhd`): the double nearest to
 * the exact quotient, ties to even — `Number(a) / Number(b)` would round twice above 2^53.
 * @param {bigint} dividend non-negative
 * @param {bigint} divisor positive
 * @returns {number}
 */
function trueDivide(dividend, divisor) {
  if (dividend === 0n) return 0;
  const limit = 1n << 53n;
  if (dividend <= limit && divisor <= limit) return Number(dividend) / Number(divisor);
  const bits = (/** @type {bigint} */ value) => value.toString(2).length;
  const shift = 55 - (bits(dividend) - bits(divisor));
  const numerator = shift >= 0 ? dividend << BigInt(shift) : dividend;
  const denominator = shift >= 0 ? divisor : divisor << BigInt(-shift);
  const quotient = numerator / denominator;
  const sticky = numerator % denominator !== 0n;
  const extra = bits(quotient) - 53;
  const low = quotient & ((1n << BigInt(extra)) - 1n);
  const half = 1n << BigInt(extra - 1);
  let mantissa = quotient >> BigInt(extra);
  if (low > half || (low === half && (sticky || (mantissa & 1n) === 1n))) mantissa += 1n;
  return Number(mantissa) * 2 ** (extra - shift);
}

/**
 * The text of the `UnicodeDecodeError` Python's `bytes.decode()` (UTF-8, strict) raises for
 * `data` — CPython's maximal-subpart ranges — or null when it decodes.
 * @param {Uint8Array} data
 * @returns {string | null}
 */
function utf8DecodeError(data) {
  const end = data.length;
  const isCont = (/** @type {number} */ byte) => byte >= 0x80 && byte <= 0xbf;
  let s = 0;
  while (s < end) {
    const ch = data[s];
    let error = 0; // 0: none; 1: invalid start; 2-4: invalid continuation; 5: unexpected end
    let width = 1;
    if (ch < 0x80) {
      width = 1;
    } else if (ch < 0xc2) {
      error = 1;
    } else if (ch < 0xe0) {
      width = 2;
      if (end - s < 2) error = 5;
      else if (!isCont(data[s + 1])) error = 2;
    } else if (ch < 0xf0) {
      width = 3;
      if (end - s < 3) {
        if (end - s < 2) error = 5;
        else {
          const ch2 = data[s + 1];
          error = !isCont(ch2) || (ch2 < 0xa0 ? ch === 0xe0 : ch === 0xed) ? 2 : 5;
        }
      } else {
        const ch2 = data[s + 1];
        if (!isCont(ch2) || (ch === 0xe0 && ch2 < 0xa0) || (ch === 0xed && ch2 >= 0xa0)) error = 2;
        else if (!isCont(data[s + 2])) error = 3;
      }
    } else if (ch < 0xf5) {
      width = 4;
      if (end - s < 4) {
        if (end - s < 2) error = 5;
        else {
          const ch2 = data[s + 1];
          if (!isCont(ch2) || (ch2 < 0x90 ? ch === 0xf0 : ch === 0xf4)) error = 2;
          else if (end - s < 3) error = 5;
          else error = isCont(data[s + 2]) ? 5 : 3;
        }
      } else {
        const ch2 = data[s + 1];
        if (!isCont(ch2) || (ch === 0xf0 && ch2 < 0x90) || (ch === 0xf4 && ch2 >= 0x90)) error = 2;
        else if (!isCont(data[s + 2])) error = 3;
        else if (!isCont(data[s + 3])) error = 4;
      }
    } else {
      error = 1;
    }
    if (error === 0) {
      s += width;
      continue;
    }
    const reason =
      error === 1
        ? "invalid start byte"
        : error === 5
          ? "unexpected end of data"
          : "invalid continuation byte";
    const stop = error === 1 ? s + 1 : error === 5 ? end : s + error - 1;
    return stop - s === 1
      ? `'utf-8' codec can't decode byte 0x${data[s].toString(16).padStart(2, "0")} ` +
          `in position ${s}: ${reason}`
      : `'utf-8' codec can't decode bytes in position ${s}-${stop - 1}: ${reason}`;
  }
  return null;
}

// ------------------------------------------------------------------------------ byte helpers

/**
 * @param {Uint8Array} bytes
 * @param {number} at
 * @returns {number}
 */
function u32(bytes, at) {
  return bytes[at] * 0x1000000 + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} at
 * @returns {number}
 */
function i32(bytes, at) {
  return (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
}

/**
 * @param {Uint8Array} bytes
 * @param {number} at
 * @returns {bigint}
 */
function u64(bytes, at) {
  return (BigInt(u32(bytes, at)) << 32n) | BigInt(u32(bytes, at + 4));
}

/**
 * @param {Uint8Array} bytes
 * @param {number} at
 * @param {number} value
 */
function setU32(bytes, at, value) {
  bytes[at] = Math.floor(value / 0x1000000) & 0xff;
  bytes[at + 1] = (value >>> 16) & 0xff;
  bytes[at + 2] = (value >>> 8) & 0xff;
  bytes[at + 3] = value & 0xff;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} at
 * @param {bigint} value
 */
function setU64(bytes, at, value) {
  setU32(bytes, at, Number(value >> 32n));
  setU32(bytes, at + 4, Number(value & 0xffffffffn));
}

/**
 * The bytes as a Latin-1 string (one character per byte), the way atom names are compared.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function latin1(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/**
 * @param {string} text Latin-1 characters only
 * @returns {Uint8Array}
 */
function ascii(text) {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff;
  return out;
}

/**
 * @param {...Uint8Array} parts
 * @returns {Uint8Array}
 */
function concat(...parts) {
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
 * @param {Uint8Array} left
 * @param {Uint8Array} right
 * @returns {boolean}
 */
function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

/**
 * @param {Uint8Array} data
 * @param {Uint8Array} prefix
 * @returns {boolean}
 */
function startsWith(data, prefix) {
  if (data.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1)
    if (data[index] !== prefix[index]) return false;
  return true;
}

/**
 * Whether `needle` occurs in `haystack` (`needle in haystack` for bytes).
 * @param {Uint8Array} haystack
 * @param {Uint8Array} needle
 * @returns {boolean}
 */
function contains(haystack, needle) {
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {Uint8Array}
 */
function bytesOf(input) {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff]);
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const RIFF_MAGIC = ascii("RIFF");
const MP4_MAGIC = ascii("ftyp");

// ------------------------------------------------------- mutagen's MP4 reader, over bytes

/**
 * A Python file object over bytes: `seek` may go past the end, `read` returns what is there and
 * advances by that much. `kind` picks the text of an impossible seek (a real file's or a
 * BytesIO's — mutagen reads the episode as a file and a sample entry as a BytesIO).
 */
class PyFile {
  /**
   * @param {Uint8Array} data
   * @param {"file" | "bytesio"} kind
   */
  constructor(data, kind) {
    this.data = data;
    this.kind = kind;
    this.pos = 0;
    this.atoms = 0;
  }

  tell() {
    return this.pos;
  }

  /**
   * @param {number} offset
   * @param {0 | 1 | 2} [whence]
   */
  seek(offset, whence = 0) {
    this.pos = whence === 0 ? offset : whence === 1 ? this.pos + offset : this.data.length + offset;
  }

  /**
   * `seek(start + length)` with the exact (possibly 64-bit) length: Python refuses a target that
   * does not fit a signed 64-bit offset.
   * @param {number} start
   * @param {bigint} length
   */
  seekPast(start, length) {
    const target = BigInt(start) + length;
    if (target >= SEEK_LIMIT) {
      throw this.kind === "file"
        ? new PyError("cannot fit 'int' into an offset-sized integer", "ValueError")
        : new PyError("Python int too large to convert to C ssize_t", "OverflowError");
    }
    this.pos = Number(target);
  }

  /**
   * @param {number} count
   * @returns {Uint8Array}
   */
  read(count) {
    if (this.pos >= this.data.length || count <= 0) return EMPTY;
    const end = Math.min(this.data.length, this.pos + count);
    const out = this.data.subarray(this.pos, end);
    this.pos = end;
    return out;
  }
}

/** One atom of mutagen's tree (`mutagen.mp4._atom.Atom`), parsed from the file's position. */
class Atom {
  /**
   * @param {PyFile} file
   * @param {number} level
   */
  constructor(file, level) {
    if (level > MAX_NESTING)
      throw new PyError("maximum recursion depth exceeded", "RecursionError");
    file.atoms += 1;
    if (file.atoms > MAX_PARSED_ATOMS) throw new PyError("too many atoms", "AtomError");
    /** @type {number} */
    this.offset = file.tell();
    const head = file.read(8);
    if (head.length < 8) throw new PyError("truncated data", "AtomError");
    let length = u32(head, 0);
    /** @type {string} */
    this.name = latin1(head.subarray(4, 8));
    /** @type {number} */
    this.dataOffset = this.offset + 8;
    /** @type {bigint | null} */
    let exact = null;
    if (length === 1) {
      const large = file.read(8);
      if (large.length < 8) throw new PyError("truncated data", "AtomError");
      exact = u64(large, 0);
      this.dataOffset += 8;
      if (exact < 16n)
        throw new PyError("64 bit atom length can only be 16 and higher", "AtomError");
      length = Number(exact);
    } else if (length === 0) {
      if (level !== 0) throw new PyError("only a top-level atom can have zero length", "AtomError");
      file.seek(0, 2);
      length = file.tell() - this.offset;
      file.seek(this.offset + 8, 0);
    } else if (length < 8) {
      throw new PyError("atom length can only be 0, 1 or 8 and higher", "AtomError");
    }
    /** @type {number} */
    this.length = length;
    /** @type {Atom[] | null} */
    this.children = null;
    if (CONTAINERS.has(this.name)) {
      /** @type {Atom[]} */
      const children = [];
      this.children = children;
      file.seek(this.name === "meta" ? 4 : 0, 1);
      while (file.tell() < this.offset + this.length) children.push(new Atom(file, level + 1));
    } else {
      file.seekPast(this.offset, exact ?? BigInt(length));
    }
  }
}

/**
 * `Atom.read(fileobj)`: whether the whole payload could be read, and what was.
 * @param {Atom} atom
 * @param {PyFile} file
 * @returns {[boolean, Uint8Array]}
 */
function readAtom(atom, file) {
  file.seek(atom.dataOffset, 0);
  const want = atom.length - (atom.dataOffset - atom.offset);
  const data = file.read(want);
  return [data.length === want, data];
}

/**
 * `Atoms(fileobj)`: the top-level atoms, while 8 more bytes are left.
 * @param {PyFile} file
 * @returns {Atom[]}
 */
function parseAtoms(file) {
  /** @type {Atom[]} */
  const atoms = [];
  file.seek(0, 2);
  const end = file.tell();
  file.seek(0, 0);
  while (file.tell() + 8 <= end) atoms.push(new Atom(file, 0));
  return atoms;
}

/**
 * `atom[names]` (`Atom.__getitem__`): the first child of each name in turn, or a KeyError.
 * @param {Atom} atom
 * @param {string[]} names
 * @returns {Atom}
 */
function child(atom, names) {
  let current = atom;
  for (const name of names) {
    if (current.children === null)
      throw keyError(`${pyBytesRepr(current.name)} is not a container`);
    const found = current.children.find((candidate) => candidate.name === name);
    if (found === undefined) throw keyError(`${pyBytesRepr(name)} not found`);
    current = found;
  }
  return current;
}

/**
 * `atoms[names]` (`Atoms.__getitem__`): the first top-level atom of the first name, then down.
 * @param {Atom[]} atoms
 * @param {string[]} names
 * @returns {Atom}
 */
function top(atoms, names) {
  const found = atoms.find((candidate) => candidate.name === names[0]);
  if (found === undefined) throw keyError(`${pyBytesRepr(names[0])} not found`);
  return child(found, names.slice(1));
}

/**
 * `names in atoms` (`Atoms.__contains__`).
 * @param {Atom[]} atoms
 * @param {string[]} names
 * @returns {boolean}
 */
function has(atoms, names) {
  try {
    top(atoms, names);
    return true;
  } catch (error) {
    if (isPy(error, "KeyError")) return false;
    throw error;
  }
}

/**
 * `atoms.path(*names)`: every atom on the way, or null where `has` would say no.
 * @param {Atom[]} atoms
 * @param {string[]} names
 * @returns {Atom[] | null}
 */
function pathOf(atoms, names) {
  if (!has(atoms, names)) return null;
  return names.map((_, index) => top(atoms, names.slice(0, index + 1)));
}

/**
 * `atom.findall(name, recursive)`.
 * @param {Atom} atom
 * @param {string} name
 * @param {boolean} recursive
 * @returns {Generator<Atom>}
 */
function* findAll(atom, name, recursive) {
  if (atom.children === null) return;
  for (const candidate of atom.children) {
    if (candidate.name === name) yield candidate;
    if (recursive) yield* findAll(candidate, name, true);
  }
}

/** mutagen's `BitReader` (MSB first) over a `PyFile`. */
class BitReader {
  /** @param {PyFile} file */
  constructor(file) {
    this.file = file;
    this.buffer = 0;
    this.count = 0;
    this.start = file.tell();
  }

  /**
   * @param {number} count
   * @returns {number}
   */
  bits(count) {
    if (count > this.count) {
      const needed = Math.floor((count - this.count + 7) / 8);
      const data = this.file.read(needed);
      if (data.length !== needed) throw new PyError("not enough data", "BitReaderError");
      for (const byte of data) this.buffer = this.buffer * 256 + byte;
      this.count += needed * 8;
    }
    this.count -= count;
    const scale = 2 ** this.count;
    const value = Math.floor(this.buffer / scale);
    this.buffer %= scale;
    return value;
  }

  /**
   * @param {number} count
   * @returns {Uint8Array}
   */
  bytes(count) {
    if (this.count === 0) {
      const data = this.file.read(count);
      if (data.length !== count) throw new PyError("not enough data", "BitReaderError");
      return data;
    }
    const out = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) out[index] = this.bits(8);
    return out;
  }

  /** @param {number} count */
  skip(count) {
    if (count <= this.count) {
      this.bits(count);
      return;
    }
    let left = count - this.align();
    const whole = Math.floor(left / 8);
    this.file.seek(whole, 1);
    left -= whole * 8;
    this.bits(left);
  }

  position() {
    return (this.file.tell() - this.start) * 8 - this.count;
  }

  align() {
    const dropped = this.count;
    this.buffer = 0;
    this.count = 0;
    return dropped;
  }
}

/**
 * `MP4Info.load`: the length (seconds) and the codec of the first sound track; a file without a
 * sound track gets the `mvhd`'s length and no codec, a file without that either nothing at all
 * (`MP4NoTrackError`, which `MP4.load` ignores).
 * @param {Atom[]} atoms
 * @param {PyFile} file
 * @returns {{length: number, codec: string}}
 */
function streamInfo(atoms, file) {
  let moov;
  try {
    moov = top(atoms, ["moov"]);
  } catch (error) {
    if (isPy(error, "KeyError")) throw new PyError("not a MP4 file", "MP4StreamInfoError");
    throw error;
  }
  /** @type {Atom | null} */
  let sound = null;
  for (const trak of findAll(moov, "trak", false)) {
    const hdlr = child(trak, ["mdia", "hdlr"]);
    const [ok, data] = readAtom(hdlr, file);
    if (!ok) throw new PyError("Not enough data", "MP4StreamInfoError");
    if (latin1(data.subarray(8, 12)) === "soun") {
      sound = trak;
      break;
    }
  }
  if (sound === null) {
    let mvhd;
    try {
      mvhd = child(moov, ["mvhd"]);
    } catch (error) {
      if (isPy(error, "KeyError")) throw new PyError("track has no audio data", "MP4NoTrackError");
      throw error;
    }
    return { length: movieLength(mvhd, file), codec: "" };
  }
  const mdhd = child(sound, ["mdia", "mdhd"]);
  const [ok, raw] = readAtom(mdhd, file);
  if (!ok) throw new PyError("Not enough data", "MP4StreamInfoError");
  if (raw.length < 4) throw new PyError("not enough data", "MP4StreamInfoError");
  const version = raw[0];
  const data = raw.subarray(4);
  let unit;
  let duration;
  if (version === 0) {
    const fields = data.subarray(8, 16);
    if (fields.length !== 8) throw structError(8);
    unit = u32(fields, 0);
    duration = u32(fields, 4);
  } else if (version === 1) {
    const fields = data.subarray(16, 28);
    if (fields.length !== 12) throw structError(12);
    unit = u32(fields, 0);
    duration = Number(u64(fields, 4));
  } else {
    throw new PyError(`Unknown mdhd version ${version}`, "MP4StreamInfoError");
  }
  const length = unit === 0 ? 0 : duration / unit;
  /** @type {Atom | null} */
  let stsd = null;
  try {
    stsd = child(sound, ["mdia", "minf", "stbl", "stsd"]);
  } catch (error) {
    if (!isPy(error, "KeyError")) throw error;
  }
  return { length, codec: stsd === null ? "" : sampleCodec(stsd, file) };
}

/**
 * `MP4Info._parse_mvhd`: the movie's length in seconds (0 for a version it does not know).
 * @param {Atom} mvhd
 * @param {PyFile} file
 * @returns {number}
 */
function movieLength(mvhd, file) {
  const [ok, raw] = readAtom(mvhd, file);
  if (!ok) throw new PyError("Invalid mvhd", "MP4StreamInfoError");
  if (raw.length < 4) throw new PyError("not enough data", "MP4StreamInfoError");
  const version = raw[0];
  const data = raw.subarray(4);
  let timescale;
  let duration;
  if (version === 0) {
    const fields = data.subarray(8, 16);
    if (fields.length !== 8) throw structError(8);
    timescale = u32(fields, 0);
    duration = BigInt(u32(fields, 4));
  } else if (version === 1) {
    const fields = data.subarray(16, 28);
    if (fields.length !== 12) throw structError(12);
    timescale = u32(fields, 0);
    duration = u64(fields, 4);
  } else {
    return 0;
  }
  if (timescale === 0) throw new PyError("division by zero", "ZeroDivisionError");
  return trueDivide(duration, BigInt(timescale));
}

/**
 * `MP4Info._parse_stsd`: the codec of the first sample entry (`""` when there is none).
 * @param {Atom} stsd
 * @param {PyFile} file
 * @returns {string}
 */
function sampleCodec(stsd, file) {
  const [ok, raw] = readAtom(stsd, file);
  if (!ok) throw new PyError("Invalid stsd", "MP4StreamInfoError");
  if (raw.length < 4) throw new PyError("not enough data", "MP4StreamInfoError");
  if (raw[0] !== 0) throw new PyError("Unsupported stsd version", "MP4StreamInfoError");
  const data = raw.subarray(4);
  if (data.length < 4) {
    throw new PyError(
      "unpack_from requires a buffer of at least 4 bytes for unpacking 4 bytes at offset 0 " +
        `(actual buffer size is ${data.length})`,
      "MP4StreamInfoError",
    );
  }
  if (u32(data, 0) === 0) return "";
  const entries = new PyFile(data.subarray(4), "bytesio");
  let entry;
  try {
    entry = new Atom(entries, 0);
  } catch (error) {
    throw retype(error, "AtomError", "MP4StreamInfoError");
  }
  try {
    return audioSampleEntry(entry, entries);
  } catch (error) {
    throw retype(error, "ASEntryError", "MP4StreamInfoError");
  }
}

/**
 * `AudioSampleEntry.__init__`: the entry's codec — its type, plus `.40.2` and the like for an
 * `mp4a` with an `esds` (rfc6381).
 * @param {Atom} atom
 * @param {PyFile} file
 * @returns {string}
 */
function audioSampleEntry(atom, file) {
  const [ok, data] = readAtom(atom, file);
  if (!ok) throw new PyError(`too short ${pyBytesRepr(atom.name)} atom`, "ASEntryError");
  const payload = new PyFile(data, "bytesio");
  const reader = new BitReader(payload);
  try {
    reader.skip(6 * 8); // reserved
    reader.skip(2 * 8); // data_ref_index
    reader.skip(8 * 8); // reserved
    reader.bits(16); // channels
    reader.bits(16); // sample_size
    reader.skip(2 * 8); // pre_defined
    reader.skip(2 * 8); // reserved
    reader.bits(32); // sample_rate
  } catch (error) {
    throw retype(error, "BitReaderError", "ASEntryError");
  }
  let extra;
  try {
    extra = new Atom(payload, 0);
  } catch (error) {
    throw retype(error, "AtomError", "ASEntryError");
  }
  let codec = atom.name;
  if (atom.name === "mp4a" && extra.name === "esds") codec += esdsCodecParam(extra, payload);
  else if (atom.name === "alac" && extra.name === "alac") checkAlac(extra, payload);
  else if (atom.name === "ac-3" && extra.name === "dac3") checkDac3(extra, payload);
  return codec;
}

/**
 * `AudioSampleEntry._parse_esds`: the codec parameter (`.40.2` for AAC LC).
 * @param {Atom} esds
 * @param {PyFile} file
 * @returns {string}
 */
function esdsCodecParam(esds, file) {
  const [ok, raw] = readAtom(esds, file);
  if (!ok) throw new PyError("truncated b'esds' atom", "ASEntryError");
  if (raw.length < 4) throw new PyError("not enough data", "ASEntryError");
  if (raw[0] !== 0) throw new PyError(`Unsupported version ${raw[0]}`, "ASEntryError");
  const body = new PyFile(raw.subarray(4), "bytesio");
  const reader = new BitReader(body);
  let tag;
  try {
    tag = reader.bits(8);
  } catch (error) {
    throw retype(error, "BitReaderError", "ASEntryError");
  }
  if (tag !== 0x3) throw new PyError(`unexpected descriptor: ${tag}`, "ASEntryError");
  let es;
  try {
    es = parseDescriptor(body, esDescriptor);
  } catch (error) {
    throw retype(error, "DescriptorError", "ASEntryError");
  }
  const config = es.config;
  let param = `.${config.objectType.toString(16).toUpperCase()}`;
  if (config.specific !== null) param += `.${config.specific.audioObjectType}`;
  return param;
}

/**
 * `BaseDescriptor.parse`: the length, the descriptor, then a skip over what it left unread.
 * @template T
 * @param {PyFile} file
 * @param {(file: PyFile, length: number) => T} parse
 * @returns {T}
 */
function parseDescriptor(file, parse) {
  let length = 0;
  let done = false;
  for (let index = 0; index < 4 && !done; index += 1) {
    const one = file.read(1);
    if (one.length !== 1)
      throw new PyError("unpack requires a buffer of 1 bytes", "DescriptorError");
    length = length * 128 + (one[0] & 0x7f);
    done = one[0] >> 7 === 0;
  }
  if (!done) throw new PyError("invalid descriptor length", "DescriptorError");
  const start = file.tell();
  const instance = parse(file, length);
  const left = length - (file.tell() - start);
  if (left > 0) file.seek(left, 1);
  return instance;
}

/**
 * `ES_Descriptor.__init__`.
 * @param {PyFile} file
 * @param {number} _length
 * @returns {{config: DecoderConfig}}
 */
function esDescriptor(file, _length) {
  const reader = new BitReader(file);
  let tag;
  try {
    reader.bits(16); // ES_ID
    const dependence = reader.bits(1);
    const url = reader.bits(1);
    const ocr = reader.bits(1);
    reader.bits(5); // streamPriority
    if (dependence) reader.bits(16);
    if (url) reader.bytes(reader.bits(8));
    if (ocr) reader.bits(16);
    tag = reader.bits(8);
  } catch (error) {
    throw retype(error, "BitReaderError", "DescriptorError");
  }
  if (tag !== 0x4) throw new PyError(`unexpected DecoderConfigDescrTag ${tag}`, "DescriptorError");
  return { config: parseDescriptor(file, decoderConfig) };
}

/** @typedef {{objectType: number, specific: {audioObjectType: number} | null}} DecoderConfig */

/**
 * `DecoderConfigDescriptor.__init__`.
 * @param {PyFile} file
 * @param {number} length
 * @returns {DecoderConfig}
 */
function decoderConfig(file, length) {
  const reader = new BitReader(file);
  /** @type {DecoderConfig} */
  const config = { objectType: 0, specific: null };
  let tag;
  try {
    config.objectType = reader.bits(8);
    const streamType = reader.bits(6);
    reader.bits(1); // upStream
    reader.bits(1); // reserved
    reader.bits(24); // bufferSizeDB
    reader.bits(32); // maxBitrate
    reader.bits(32); // avgBitrate
    if (config.objectType !== 0x40 || streamType !== 0x5) return config;
    if (length * 8 === reader.position()) return config;
    tag = reader.bits(8);
  } catch (error) {
    throw retype(error, "BitReaderError", "DescriptorError");
  }
  if (tag === 0x5) config.specific = parseDescriptor(file, decoderSpecificInfo);
  return config;
}

/**
 * `DecoderSpecificInfo.__init__` (the AAC AudioSpecificConfig): its audio object type.
 * @param {PyFile} file
 * @param {number} length
 * @returns {{audioObjectType: number}}
 */
function decoderSpecificInfo(file, length) {
  const reader = new BitReader(file);
  const info = { audioObjectType: 0, channelConfiguration: 0 };
  try {
    audioSpecificConfig(reader, length, info);
  } catch (error) {
    throw retype(error, "BitReaderError", "DescriptorError");
  }
  return info;
}

/**
 * `DecoderSpecificInfo._parse`.
 * @param {BitReader} reader
 * @param {number} length
 * @param {{audioObjectType: number, channelConfiguration: number}} info
 */
function audioSpecificConfig(reader, length, info) {
  const bitsLeft = () => length * 8 - reader.position();
  info.audioObjectType = audioObjectType(reader);
  samplingFrequency(reader);
  info.channelConfiguration = reader.bits(4);
  let extensionType = 0;
  if (info.audioObjectType === 5 || info.audioObjectType === 29) {
    extensionType = 5;
    samplingFrequency(reader);
    info.audioObjectType = audioObjectType(reader);
    if (info.audioObjectType === 22) reader.bits(4);
  }
  if (!GA_TYPES.has(info.audioObjectType)) return;
  if (!gaSpecificConfig(reader, info)) return;
  if (EP_TYPES.has(info.audioObjectType)) {
    const epConfig = reader.bits(2);
    if (epConfig === 2 || epConfig === 3) return;
  }
  if (extensionType !== 5 && bitsLeft() >= 16) {
    if (reader.bits(11) === 0x2b7) {
      extensionType = audioObjectType(reader);
      if (extensionType === 5) {
        if (reader.bits(1) === 1) {
          samplingFrequency(reader);
          if (bitsLeft() >= 12 && reader.bits(11) === 0x548) reader.bits(1);
        }
      }
      if (extensionType === 22) {
        if (reader.bits(1) === 1) samplingFrequency(reader);
        reader.bits(4);
      }
    }
  }
}

/**
 * @param {BitReader} reader
 * @returns {number}
 */
function audioObjectType(reader) {
  const type = reader.bits(5);
  return type === 31 ? 32 + reader.bits(6) : type;
}

/**
 * @param {BitReader} reader
 * @returns {number}
 */
function samplingFrequency(reader) {
  const index = reader.bits(4);
  return index === 0xf ? reader.bits(24) : (FREQS[index] ?? 0);
}

/**
 * `GASpecificConfig`: false where mutagen stops (`NotImplementedError("extensionFlag3 set")`).
 * @param {BitReader} reader
 * @param {{audioObjectType: number, channelConfiguration: number}} info
 * @returns {boolean}
 */
function gaSpecificConfig(reader, info) {
  reader.skip(1); // frameLengthFlag
  if (reader.bits(1)) reader.skip(14); // dependsOnCoreCoder
  const extensionFlag = reader.bits(1);
  if (!info.channelConfiguration) programConfigElement(reader);
  if (info.audioObjectType === 6 || info.audioObjectType === 20) reader.skip(3);
  if (extensionFlag) {
    if (info.audioObjectType === 22) reader.skip(5 + 11);
    if ([17, 19, 20, 23].includes(info.audioObjectType)) reader.skip(1 + 1 + 1);
    if (reader.bits(1) !== 0) return false;
  }
  return true;
}

/**
 * `mutagen.aac.ProgramConfigElement.__init__` (its reads; the channel count is not needed).
 * @param {BitReader} reader
 */
function programConfigElement(reader) {
  reader.bits(4); // element_instance_tag
  reader.bits(2); // object_type
  reader.bits(4); // sampling_frequency_index
  const front = reader.bits(4);
  const side = reader.bits(4);
  const back = reader.bits(4);
  const lfe = reader.bits(2);
  const assoc = reader.bits(3);
  const cc = reader.bits(4);
  if (reader.bits(1) === 1) reader.skip(4); // mono_mixdown
  if (reader.bits(1) === 1) reader.skip(4); // stereo_mixdown
  if (reader.bits(1) === 1) reader.skip(3); // matrix_mixdown_idx
  for (let index = 0; index < front + side + back; index += 1) {
    reader.bits(1); // element_is_cpe
    reader.skip(4);
  }
  reader.skip(4 * lfe);
  reader.skip(4 * assoc);
  reader.skip(5 * cc);
  reader.align();
  const comment = reader.bits(8);
  reader.skip(8 * comment);
}

/**
 * `AudioSampleEntry._parse_alac` (its checks).
 * @param {Atom} atom
 * @param {PyFile} file
 */
function checkAlac(atom, file) {
  const [ok, raw] = readAtom(atom, file);
  if (!ok) throw new PyError("truncated b'alac' atom", "ASEntryError");
  if (raw.length < 4) throw new PyError("not enough data", "ASEntryError");
  if (raw[0] !== 0) throw new PyError(`Unsupported version ${raw[0]}`, "ASEntryError");
  const reader = new BitReader(new PyFile(raw.subarray(4), "bytesio"));
  try {
    reader.skip(32); // frameLength
    if (reader.bits(8) !== 0) return; // compatibleVersion
    reader.bits(8);
    reader.skip(8 + 8 + 8);
    reader.bits(8);
    reader.skip(16 + 32);
    reader.bits(32);
    reader.bits(32);
  } catch (error) {
    throw retype(error, "BitReaderError", "ASEntryError");
  }
}

/**
 * `AudioSampleEntry._parse_dac3` (its checks).
 * @param {Atom} atom
 * @param {PyFile} file
 */
function checkDac3(atom, file) {
  const [ok, raw] = readAtom(atom, file);
  if (!ok) throw new PyError("truncated b'dac3' atom", "ASEntryError");
  const reader = new BitReader(new PyFile(raw, "bytesio"));
  try {
    reader.skip(2 + 5 + 3);
    reader.bits(3);
    reader.bits(1);
    reader.bits(5);
    reader.skip(5);
  } catch (error) {
    throw retype(error, "BitReaderError", "ASEntryError");
  }
}

/** @typedef {{data: Uint8Array, imageformat: number}} CoverValue */

/**
 * `MP4Tags.load`: the `covr` values, after every tag was read and every parser that can make the
 * load fail ran (a parser's own `MP4MetadataError` only marks its tag as failed).
 * @param {Atom[]} atoms
 * @param {PyFile} file
 * @returns {CoverValue[]}
 */
function loadCovers(atoms, file) {
  const ilst = top(atoms, ["moov", "udta", "meta", "ilst"]);
  /** @type {CoverValue[]} */
  const covers = [];
  for (const atom of ilst.children ?? []) {
    const [ok, data] = readAtom(atom, file);
    if (!ok) throw new PyError("Not enough data", "MP4MetadataError");
    try {
      if (atom.name === "covr") {
        for (const cover of parseCover(atom, data)) covers.push(cover);
      } else if (atom.name === "----") {
        checkFreeform(atom, data);
      } else if (atom.name === "trkn" || atom.name === "disk") {
        for (const value of dataAtoms(atom, data)) {
          if (value.subarray(2, 6).length !== 4) throw structError(4);
        }
      }
      // Every other parser fails with MP4MetadataError only: the tag is failed, the load goes on.
    } catch (error) {
      if (error instanceof PyError && SWALLOWED.has(error.pyType)) continue;
      throw error;
    }
  }
  return covers;
}

/**
 * `MP4Tags.__parse_data`: the payloads of the `data` atoms of a tag, one at a time.
 * @param {Atom} atom
 * @param {Uint8Array} data
 * @returns {Generator<Uint8Array>}
 */
function* dataAtoms(atom, data) {
  let pos = 0;
  while (pos < atom.length - 8) {
    const head = data.subarray(pos, pos + 12);
    if (head.length !== 12)
      throw new PyError(`truncated atom ${pyBytesRepr(atom.name)}`, "MP4MetadataError");
    const length = u32(head, 0);
    if (length < 1)
      throw new PyError(`atom ${pyBytesRepr(atom.name)} has a length of zero`, "MP4MetadataError");
    const name = latin1(head.subarray(4, 8));
    if (name !== "data") {
      throw new PyError(
        `unexpected atom ${pyBytesRepr(name)} inside ${pyBytesRepr(atom.name)}`,
        "MP4MetadataError",
      );
    }
    const chunk = data.subarray(pos + 16, pos + length);
    if (chunk.length !== length - 16)
      throw new PyError(`truncated atom ${pyBytesRepr(atom.name)}`, "MP4MetadataError");
    yield chunk;
    pos += length;
  }
}

/**
 * `MP4Tags.__parse_cover`.
 * @param {Atom} atom
 * @param {Uint8Array} data
 * @returns {CoverValue[]}
 */
function parseCover(atom, data) {
  /** @type {CoverValue[]} */
  const values = [];
  let pos = 0;
  while (pos < atom.length - 8) {
    const head = data.subarray(pos, pos + 12);
    if (head.length !== 12) throw structError(12);
    const length = u32(head, 0);
    const name = latin1(head.subarray(4, 8));
    let imageformat = u32(head, 8);
    if (name !== "data") {
      if (name === "name") {
        // mutagen loops forever on a `name` atom of length 0; here the tag is failed instead.
        if (length === 0)
          throw new PyError("a 'name' atom of length 0 inside 'covr'", "MP4MetadataError");
        pos += length;
        continue;
      }
      throw new PyError(`unexpected atom ${pyBytesRepr(name)} inside 'covr'`, "MP4MetadataError");
    }
    if (length < 1)
      throw new PyError(`atom ${pyBytesRepr(atom.name)} has a length of zero`, "MP4MetadataError");
    if (imageformat !== COVER_FORMATS.jpeg && imageformat !== COVER_FORMATS.png)
      imageformat = COVER_FORMATS.jpeg;
    values.push({ data: data.subarray(pos + 16, pos + length), imageformat });
    pos += length;
  }
  return values;
}

/**
 * `MP4Tags.__parse_freeform` (the reads that can fail with something else than a metadata error).
 * @param {Atom} atom
 * @param {Uint8Array} data
 */
function checkFreeform(atom, data) {
  let field = data.subarray(0, 4);
  if (field.length !== 4) throw structError(4);
  let length = u32(field, 0);
  let pos = length;
  field = data.subarray(pos, pos + 4);
  if (field.length !== 4) throw structError(4);
  length = u32(field, 0);
  pos += length;
  while (pos < atom.length - 8) {
    const head = data.subarray(pos, pos + 8);
    if (head.length !== 8) throw structError(8);
    length = u32(head, 0);
    const name = latin1(head.subarray(4, 8));
    if (name !== "data") {
      throw new PyError(
        `unexpected atom ${pyBytesRepr(name)} inside ${pyBytesRepr(atom.name)}`,
        "MP4MetadataError",
      );
    }
    if (length < 1)
      throw new PyError(`atom ${pyBytesRepr(atom.name)} has a length of zero`, "MP4MetadataError");
    if (data.subarray(pos + 8, pos + 9).length === 0) {
      throw new PyError("ord() expected a character, but string of length 0 found", "TypeError");
    }
    if (data.subarray(pos + 9, pos + 12).length !== 3) throw structError(4);
    pos += length;
  }
}

/**
 * `MP4Chapters.load` (its checks), run when the file has `moov/udta/chpl` and `moov/mvhd`.
 * @param {Atom[]} atoms
 * @param {PyFile} file
 */
function checkChapters(atoms, file) {
  const mvhd = top(atoms, ["moov", "mvhd"]);
  const [ok, data] = readAtom(mvhd, file);
  if (!ok) throw new PyError("Invalid mvhd", "MP4StreamInfoError");
  if (data.length === 0) throw new PyError("index out of range", "IndexError");
  let timescale = 0;
  if (data[0] === 0) {
    if (data.subarray(12, 16).length !== 4) throw structError(4);
    timescale = i32(data, 12);
    if (data.subarray(16, 20).length !== 4) throw structError(4);
  } else if (data[0] === 1) {
    if (data.subarray(20, 24).length !== 4) throw structError(4);
    timescale = i32(data, 20);
    if (data.subarray(24, 32).length !== 8) throw structError(8);
  }
  if (!timescale) throw new PyError("Unable to get timescale", "MP4MetadataError");
  const chpl = top(atoms, ["moov", "udta", "chpl"]);
  const [whole, chapters] = readAtom(chpl, file);
  if (!whole) throw new PyError("Invalid atom", "MP4StreamInfoError");
  if (chapters.length <= 8) throw new PyError("index out of range", "IndexError");
  let pos = 9;
  for (let index = 0; index < chapters[8]; index += 1) {
    if (chapters.subarray(pos, pos + 8).length !== 8) throw structError(8);
    pos += 8;
    if (pos >= chapters.length) throw new PyError("index out of range", "IndexError");
    const titleLength = chapters[pos];
    pos += 1;
    const problem = utf8DecodeError(chapters.subarray(pos, pos + titleLength));
    if (problem !== null)
      throw new PyError(`chapter ${index} title: ${problem}`, "MP4MetadataError");
    pos += titleLength;
  }
}

/**
 * @typedef {{length: number, codec: string, covers: CoverValue[] | null, atoms: Atom[]}} Mp4Read
 */

/**
 * `mutagen.mp4.MP4(file)`: the atom tree, the stream info and the covers, or the PyError
 * mutagen would raise.
 * @param {Uint8Array} bytes
 * @returns {Mp4Read}
 */
function readMp4(bytes) {
  const file = new PyFile(bytes, "file");
  let atoms;
  try {
    atoms = parseAtoms(file);
  } catch (error) {
    throw retype(error, "AtomError", "error");
  }
  let info = { length: 0, codec: "" };
  try {
    info = streamInfo(atoms, file);
  } catch (error) {
    if (!isPy(error, "MP4NoTrackError")) throw asMutagen(error, "MP4StreamInfoError");
  }
  /** @type {CoverValue[] | null} */
  let covers = null;
  if (has(atoms, ["moov", "udta", "meta", "ilst"])) {
    try {
      covers = loadCovers(atoms, file);
    } catch (error) {
      throw asMutagen(error, "MP4MetadataError");
    }
  }
  if (has(atoms, ["moov", "udta", "chpl"]) && has(atoms, ["moov", "mvhd"])) {
    try {
      checkChapters(atoms, file);
    } catch (error) {
      throw asMutagen(error, "MP4MetadataError");
    }
  }
  return { length: info.length, codec: info.codec, covers, atoms };
}

// --------------------------------------------------------------------- integrity (media.py)

/**
 * @typedef {object} VideoProbe What the container index says (`media.VideoProbe`).
 * @property {number} durationS the length in seconds (mutagen's `info.length`)
 * @property {boolean} hasAudio whether there is an audio track (mutagen gives it a codec)
 * @property {string | null} audioCodec mutagen's name for it, e.g. `mp4a.40.2`; null without one
 */

/**
 * `media.probe_video` over bytes: what mutagen reads from the container index. A video-only MP4
 * gives `hasAudio: false`; bytes mutagen cannot parse throw a {@link MediaError} `not a valid MP4
 * (<detail>)` with mutagen's own detail.
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {VideoProbe}
 */
export function probe(input) {
  let info;
  try {
    info = readMp4(bytesOf(input));
  } catch (error) {
    throw new MediaError(`not a valid MP4 (${detail(error)})`);
  }
  const codec = info.codec;
  return { durationS: info.length, hasAudio: Boolean(codec), audioCodec: codec || null };
}

/**
 * `media.atom_problem` over bytes: a top-level atom of {@link KNOWN_ATOMS} whose declared size
 * runs past the end — `truncated MP4 (mdat atom cut short: 1200000 of 13087000 bytes)` — else
 * null. An unknown type, a size of 0 (to the end) or a size the format does not define ends the
 * walk without a verdict.
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {string | null}
 */
export function atomProblem(input) {
  const bytes = bytesOf(input);
  const size = bytes.length;
  let offset = 0;
  for (let index = 0; index < MAX_ATOMS; index += 1) {
    if (offset >= size) return null;
    const header = bytes.subarray(offset, offset + 16);
    if (header.length < 8) return null;
    const kind = latin1(header.subarray(4, 8));
    if (!KNOWN_ATOMS.has(kind)) return null;
    let declared = BigInt(u32(header, 0));
    if (declared === 0n) return null;
    if (declared === 1n) {
      if (header.length < 16) return cutShort(kind, size - offset, null);
      declared = u64(header, 8);
    }
    if (declared < 8n) return null;
    if (BigInt(offset) + declared > BigInt(size)) return cutShort(kind, size - offset, declared);
    offset += Number(declared);
  }
  return null;
}

/**
 * `media._cut_short`.
 * @param {string} kind
 * @param {number} have
 * @param {bigint | null} need
 * @returns {string}
 */
function cutShort(kind, have, need) {
  if (need === null)
    return `truncated MP4 (${kind} atom cut short: ${have} bytes left for its header)`;
  return `truncated MP4 (${kind} atom cut short: ${have} of ${need} bytes)`;
}

/**
 * `media.verify_video` over the bytes of a download: why they are not the episode, or null when
 * they look fine. Reasons, in the order they are checked: `not a valid MP4 (<detail>)`, the
 * truncation of {@link atomProblem}, `no playable duration`, `no audio track`, `duration 61 s,
 * expected 120 s` when `|actual − expected| > max(3 s, 5 % of expected)`. Without an expected
 * duration (null, undefined or 0) the duration is not judged.
 * @param {Uint8Array | ArrayBuffer} input
 * @param {number | null | undefined} expectedDurationS
 * @returns {string | null}
 */
export function verifyVideo(input, expectedDurationS) {
  const bytes = bytesOf(input);
  let probed;
  try {
    probed = probe(bytes);
  } catch (error) {
    return errorText(error);
  }
  const truncated = atomProblem(bytes);
  if (truncated !== null) return truncated;
  if (probed.durationS <= 0) return "no playable duration";
  if (!probed.hasAudio) return "no audio track";
  if (expectedDurationS !== null && expectedDurationS !== undefined && expectedDurationS > 0) {
    const tolerance = Math.max(DURATION_TOLERANCE_S, DURATION_TOLERANCE_RATIO * expectedDurationS);
    if (Math.abs(probed.durationS - expectedDurationS) > tolerance) {
      return `duration ${pyFixed0(probed.durationS)} s, expected ${expectedDurationS} s`;
    }
  }
  return null;
}

// ----------------------------------------------------------------------- DRM (media.py)

/**
 * `media._BoxWalk`: the box structure along the paths where encryption is declared, one header
 * at a time, at most {@link MAX_DRM_BOXES} headers for the whole walk.
 */
class BoxWalk {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    this.budget = MAX_DRM_BOXES;
  }

  /**
   * @param {number} offset
   * @param {number} count
   * @returns {Uint8Array}
   */
  read(offset, count) {
    return this.bytes.subarray(offset, offset + count);
  }

  /** @returns {boolean} */
  encrypted() {
    for (const [kind, start, end] of this.boxes(0, this.bytes.length)) {
      if (kind === PSSH_BOX) return true;
      if (kind === "moov" && this.movieEncrypted(start, end)) return true;
    }
    return false;
  }

  /**
   * @param {number} start
   * @param {number} end
   * @returns {boolean}
   */
  movieEncrypted(start, end) {
    for (const [kind, childStart, childEnd] of this.boxes(start, end)) {
      if (kind === PSSH_BOX) return true;
      if (kind === "trak" && this.trackEncrypted(childStart, childEnd)) return true;
    }
    return false;
  }

  /**
   * `trak` → `mdia` → `minf` → `stbl` → `stsd`, then its sample entries.
   * @param {number} start
   * @param {number} end
   * @returns {boolean}
   */
  trackEncrypted(start, end) {
    let from = start;
    let to = end;
    for (const container of TRACK_PATH) {
      const span = this.first(container, from, to);
      if (span === null) return false;
      [from, to] = span;
    }
    // `stsd` is a full box: version (1 byte), flags (3) and the entry count (4) come first.
    const header = this.read(from, 8);
    if (header.length < 8) return false;
    const count = u32(header, 4);
    let index = 0;
    for (const [kind] of this.boxes(from + 8, to)) {
      if (index >= count) return false;
      if (ENCRYPTED_SAMPLE_ENTRIES.has(kind)) return true;
      index += 1;
    }
    return false;
  }

  /**
   * @param {string} kind
   * @param {number} start
   * @param {number} end
   * @returns {[number, number] | null}
   */
  first(kind, start, end) {
    for (const [found, childStart, childEnd] of this.boxes(start, end)) {
      if (found === kind) return [childStart, childEnd];
    }
    return null;
  }

  /**
   * `(type, payload start, payload end)` of each box between `start` and `end`: a size of 0 runs
   * to `end`, a size of 1 is followed by a 64-bit size, a size smaller than its header ends the
   * level, a box declared past `end` is cut there.
   * @param {number} start
   * @param {number} end
   * @returns {Generator<[string, number, number]>}
   */
  *boxes(start, end) {
    let pos = start;
    while (pos + 8 <= end && this.budget > 0) {
      this.budget -= 1;
      const header = this.read(pos, 8);
      if (header.length < 8) return;
      let declared = u32(header, 0);
      let payload = pos + 8;
      if (declared === 1) {
        const large = this.read(payload, 8);
        if (large.length < 8) return;
        declared = Number(u64(large, 0));
        payload += 8;
      } else if (declared === 0) {
        declared = end - pos;
      }
      if (pos + declared < payload) return;
      yield [latin1(header.subarray(4, 8)), payload, Math.min(pos + declared, end)];
      pos += declared;
    }
  }
}

/**
 * `media.drm_problem_in`: {@link DRM_MESSAGE} when the bytes declare encrypted tracks — a
 * top-level `pssh`, a `pssh` among the `moov` children, or an `encv` / `enca` sample entry in
 * `moov/trak/mdia/minf/stbl/stsd` — else null. Box headers only, never the samples (the bytes
 * `encv` inside `mdat` are not a box); bounded; never throws (junk is "no DRM found").
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {string | null}
 */
export function drmProblem(input) {
  try {
    return new BoxWalk(bytesOf(input)).encrypted() ? DRM_MESSAGE : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------- the video body (downloader_browser.py)

/**
 * `downloader_browser._body_problem`: why a 200 answer is not a video — `<size> of <type>
 * instead of a video` under {@link MIN_VIDEO_BYTES}, or `<type> instead of a video` when neither
 * the content type (`video/*`, `application/octet-stream`) nor the first 32 bytes (`ftyp`) say
 * MP4 — else null.
 * @param {Uint8Array | ArrayBuffer} input
 * @param {string} [contentType]
 * @returns {string | null}
 */
export function bodyProblem(input, contentType = "") {
  const body = bytesOf(input);
  const kind = mediaType(contentType) || "an untyped body";
  if (body.length < MIN_VIDEO_BYTES)
    return `${formatSize(body.length)} of ${kind} instead of a video`;
  if (
    !VIDEO_CONTENT_TYPES.some((prefix) => kind.startsWith(prefix)) &&
    !contains(body.subarray(0, 32), MP4_MAGIC)
  ) {
    return `${kind} instead of a video`;
  }
  return null;
}

// --------------------------------------------------------------- the cover (thumbnails.py)

/**
 * `thumbnails.image_kind`: `jpeg`, `png` or `webp` for an image body, else null. The bytes
 * decide (JPEG, PNG or RIFF/WEBP magic); only bytes without one let the content type count —
 * `image/jpeg` and its aliases, `image/png`, `image/webp`, and any other `image/*` taken for a
 * JPEG (embedding re-sniffs the bytes alone and refuses it).
 * @param {Uint8Array | ArrayBuffer} input
 * @param {string} [contentType]
 * @returns {ImageKind | null}
 */
export function imageKind(input, contentType = "") {
  const data = bytesOf(input);
  if (startsWith(data, JPEG_MAGIC)) return "jpeg";
  if (startsWith(data, PNG_MAGIC)) return "png";
  if (startsWith(data, RIFF_MAGIC) && latin1(data.subarray(8, 12)) === "WEBP") return "webp";
  const kind = mediaType(contentType);
  const known = CONTENT_TYPES.get(kind);
  if (known !== undefined) return known;
  if (kind.startsWith("image/")) return "jpeg";
  return null;
}

/**
 * `thumbnails.image_problem`: why a 200 answer is not a cover — too small, or neither an image
 * type nor image bytes.
 * @param {Uint8Array | ArrayBuffer} input
 * @param {string} [contentType]
 * @returns {string}
 */
export function imageProblem(input, contentType = "") {
  const data = bytesOf(input);
  const kind = mediaType(contentType) || "an untyped body";
  if (data.length < MIN_IMAGE_BYTES)
    return `${formatSize(data.length)} of ${kind} instead of an image`;
  return `${kind} instead of an image`;
}

/**
 * `thumbnails.format_size`: `1536` → `1.5 KiB`; MiB from one mebibyte up, plain bytes under one
 * kibibyte (rounded half to even, like Python's `:.1f`).
 * @param {number} size
 * @returns {string}
 */
export function formatSize(size) {
  if (size >= MIB) return `${pyFixed1(size, MIB)} MiB`;
  if (size >= 1024) return `${pyFixed1(size, 1024)} KiB`;
  return `${size} bytes`;
}

/**
 * `thumbnails.extension_for`: `.jpg`, `.png` or `.webp`.
 * @param {string} kind
 * @returns {string}
 */
export function extensionFor(kind) {
  if (kind === "jpeg" || kind === "png" || kind === "webp") return IMAGE_EXTENSIONS[kind];
  throw new RangeError(`unknown image kind ${pyStrRepr(String(kind))}`);
}

/**
 * `thumbnails.mime_type_for`: `image/jpeg`, `image/png` or `image/webp`.
 * @param {string} kind
 * @returns {string}
 */
export function mimeTypeFor(kind) {
  if (kind === "jpeg" || kind === "png" || kind === "webp") return IMAGE_MIME_TYPES[kind];
  throw new RangeError(`unknown image kind ${pyStrRepr(String(kind))}`);
}

/**
 * `Atom.render`: a box of `name` around `payload` (a 64-bit size when 32 bits are not enough).
 * @param {string} name
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
function render(name, payload) {
  const size = payload.length + 8;
  if (size <= U32_MAX) {
    const head = new Uint8Array(8);
    setU32(head, 0, size);
    head.set(ascii(name), 4);
    return concat(head, payload);
  }
  const head = new Uint8Array(16);
  setU32(head, 0, 1);
  head.set(ascii(name), 4);
  setU64(head, 8, BigInt(size + 8));
  return concat(head, payload);
}

/**
 * `MP4Tags.__render_cover` of one cover: `covr` around one `data` atom whose flags are the image
 * format (13 JPEG, 14 PNG).
 * @param {Uint8Array} image
 * @param {number} format
 * @returns {Uint8Array}
 */
function coverAtom(image, format) {
  const fields = new Uint8Array(8);
  setU32(fields, 0, format);
  return render("covr", render("data", concat(fields, image)));
}

/**
 * @param {string} name
 * @returns {PyError}
 */
function wrongOffset(name) {
  return new PyError(`wrong offset inside ${pyBytesRepr(name)}`, "MP4MetadataError");
}

/**
 * The new `ilst`: its children byte for byte, every `covr` replaced by the new one (where the
 * first stood, else at the end).
 * @param {Uint8Array} video
 * @param {Atom} ilst
 * @param {Uint8Array} covr
 * @returns {Uint8Array}
 */
function rebuiltIlst(video, ilst, covr) {
  /** @type {Uint8Array[]} */
  const parts = [];
  let placed = false;
  for (const tag of ilst.children ?? []) {
    if (tag.offset + tag.length > ilst.offset + ilst.length) {
      throw new PyError(
        `${pyBytesRepr(tag.name)} runs past the end of its ilst`,
        "MP4MetadataError",
      );
    }
    if (tag.name === "covr") {
      if (!placed) parts.push(covr);
      placed = true;
    } else {
      parts.push(video.subarray(tag.offset, tag.offset + tag.length));
    }
  }
  if (!placed) parts.push(covr);
  return render("ilst", concat(...parts));
}

/**
 * Add `delta` to the size of an atom that contains the edit (its header lies before it); a size
 * of 0 ("to the end of the file", the last top-level atom only) still is.
 * @param {Uint8Array} out
 * @param {Atom} atom
 * @param {number} delta
 */
function grow(out, atom, delta) {
  const size = u32(out, atom.offset);
  if (size === 0) return;
  if (size === 1) {
    const grown = u64(out, atom.offset + 8) + BigInt(delta);
    if (grown < 16n || grown > U64_MAX)
      throw new PyError(`${pyBytesRepr(atom.name)} atom too large`, "MP4MetadataError");
    setU64(out, atom.offset + 8, grown);
    return;
  }
  const grown = size + delta;
  if (grown < 8 || grown > U32_MAX)
    throw new PyError(`${pyBytesRepr(atom.name)} atom too large`, "MP4MetadataError");
  setU32(out, atom.offset, grown);
}

/**
 * `MP4Tags.__update_offset_table`: every chunk offset of an `stco` (4-byte entries) or `co64`
 * (8-byte) that points past the edit at `at` moves by `delta`; a table whose entry count does not
 * fill it exactly, or an entry that would no longer fit, is `wrong offset inside b'stco'`.
 * @param {Uint8Array} out the edited file
 * @param {Atom} table where the table was in the original
 * @param {number} at the edit's offset in the original
 * @param {number} removed bytes the edit replaced
 * @param {number} delta
 * @param {Atom} moov
 */
function shiftChunkOffsets(out, table, at, removed, delta, moov) {
  // A box called `stco` inside the replaced `ilst` is a tag, not a table.
  if (removed > 0 && table.offset >= at && table.offset < at + removed) return;
  if (table.offset + table.length > moov.offset + moov.length) throw wrongOffset(table.name);
  const width = table.name === "co64" ? 8 : 4;
  const position = table.offset > at ? table.offset + delta : table.offset;
  const start = position + (table.dataOffset - table.offset); // version and flags, then the count
  const payload = table.length - (table.dataOffset - table.offset);
  if (payload < 8) throw wrongOffset(table.name);
  const count = u32(out, start + 4);
  if (payload - 8 !== count * width) throw wrongOffset(table.name);
  for (let index = 0; index < count; index += 1) {
    const entry = start + 8 + index * width;
    if (width === 4) {
      const offset = u32(out, entry);
      if (at < offset) {
        const moved = offset + delta;
        if (moved < 0 || moved > U32_MAX) throw wrongOffset(table.name);
        setU32(out, entry, moved);
      }
    } else {
      const offset = u64(out, entry);
      if (BigInt(at) < offset) {
        const moved = offset + BigInt(delta);
        if (moved < 0n || moved > U64_MAX) throw wrongOffset(table.name);
        setU64(out, entry, moved);
      }
    }
  }
}

/**
 * The structural edit behind {@link embedCover}; throws a PyError for anything it cannot do.
 * @param {Uint8Array} video
 * @param {Uint8Array} image
 * @param {number} format
 * @returns {Uint8Array}
 */
function writeCover(video, image, format) {
  // What `MP4(copy)` loads first: a file mutagen cannot read fails here.
  const before = readMp4(video);
  const atoms = before.atoms;
  if (atoms.some((atom) => atom.name === "moof")) {
    throw new PyError(
      "a fragmented MP4 (moof): its absolute offsets are not rewritten",
      "MP4MetadataError",
    );
  }
  const moov = top(atoms, ["moov"]);
  if (moov.offset + moov.length > video.length)
    throw new PyError("the moov atom is cut short", "MP4MetadataError");
  const covr = coverAtom(image, format);
  /** @type {{at: number, removed: number, insert: Uint8Array, parents: Atom[]}} */
  let edit;
  const ilstPath = pathOf(atoms, ["moov", "udta", "meta", "ilst"]);
  const udtaPath = pathOf(atoms, ["moov", "udta"]);
  if (ilstPath !== null) {
    const [, udta, meta, ilst] = ilstPath;
    edit = {
      at: ilst.offset,
      removed: ilst.length,
      insert: rebuiltIlst(video, ilst, covr),
      parents: [moov, udta, meta],
    };
  } else {
    const hdlr = render("hdlr", MDIR_HDLR_PAYLOAD);
    const meta = render("meta", concat(new Uint8Array(4), hdlr, render("ilst", covr)));
    if (udtaPath !== null) {
      // mutagen puts the new `meta` first in the `udta`, where its reader looks first.
      edit = { at: udtaPath[1].dataOffset, removed: 0, insert: meta, parents: [moov, udtaPath[1]] };
    } else {
      // A new `udta` goes last in the `moov` (mutagen puts it first): the tracks keep their order.
      edit = {
        at: moov.offset + moov.length,
        removed: 0,
        insert: render("udta", meta),
        parents: [moov],
      };
    }
  }
  for (const parent of edit.parents) {
    if (parent.offset + parent.length > video.length) {
      throw new PyError(`the ${parent.name} atom is cut short`, "MP4MetadataError");
    }
  }
  const delta = edit.insert.length - edit.removed;
  const out = new Uint8Array(video.length + delta);
  out.set(video.subarray(0, edit.at), 0);
  out.set(edit.insert, edit.at);
  out.set(video.subarray(edit.at + edit.removed), edit.at + edit.insert.length);
  if (delta !== 0) {
    for (const parent of edit.parents) grow(out, parent, delta);
    for (const table of findAll(moov, "stco", true))
      shiftChunkOffsets(out, table, edit.at, edit.removed, delta, moov);
    for (const table of findAll(moov, "co64", true))
      shiftChunkOffsets(out, table, edit.at, edit.removed, delta, moov);
  }
  const after = readMp4(out);
  const back = after.covers === null ? undefined : after.covers[0];
  if (
    back === undefined ||
    back.imageformat !== format ||
    !sameBytes(back.data, image) ||
    after.length !== before.length ||
    after.codec !== before.codec
  ) {
    throw new PyError("the edited file did not read back", "MP4MetadataError");
  }
  return out;
}

/**
 * `thumbnails.embed_cover` over bytes: a NEW buffer, `video` with `image` as its cover art (the
 * MP4 `covr` atom, where mutagen writes it; any existing `covr` replaced, every other atom kept,
 * every `stco` / `co64` offset that the edit moves rewritten, the samples untouched). `video` is
 * never modified. Throws a {@link ThumbnailError} with a printable reason — `webp cannot be
 * embedded`, `not a JPEG or PNG image`, `5,242,881 bytes is above the 5 MiB cover limit`, `could
 * not write the cover into <name> (MP4MetadataError: wrong offset inside b'stco')` — after which
 * the cover is saved as a file instead (the video is still the original).
 * @param {Uint8Array | ArrayBuffer} video
 * @param {Uint8Array | ArrayBuffer} image
 * @param {string | null} [kind] the caller's {@link imageKind} (with the content type): a `webp`
 *   is refused; otherwise the bytes alone decide, like Python's re-sniff
 * @param {string} [name] the file name the failure message names (Python's `video.name`)
 * @returns {Uint8Array}
 */
export function embedCover(video, image, kind = null, name = "the video") {
  const picture = bytesOf(image);
  const sniffed = imageKind(picture);
  if (kind === "webp" || sniffed === "webp") throw new ThumbnailError("webp cannot be embedded");
  if (sniffed !== "jpeg" && sniffed !== "png") throw new ThumbnailError("not a JPEG or PNG image");
  if (picture.length > MAX_COVER_BYTES) {
    throw new ThumbnailError(
      `${pyThousands(picture.length)} bytes is above the ${MAX_COVER_BYTES / MIB} MiB cover limit`,
    );
  }
  try {
    return writeCover(bytesOf(video), picture, COVER_FORMATS[sniffed]);
  } catch (error) {
    throw new ThumbnailError(`could not write the cover into ${name} (${describe(error)})`);
  }
}

/**
 * @typedef {object} EmbeddedCover A cover read back from a video (`thumbnails.extract_cover`).
 * @property {Uint8Array} data the image bytes (a copy)
 * @property {"image/jpeg" | "image/png"} mime
 */

/**
 * `thumbnails.extract_cover` over bytes: the first `covr` image as `{data, mime}`, or null —
 * never throws: null for bytes mutagen cannot read, without tags or `covr`, for a first cover
 * that is empty, over {@link MAX_COVER_BYTES} or neither a JPEG nor a PNG. The bytes decide the
 * kind; the atom's declared format (13 JPEG, 14 PNG) counts only for bytes without a known magic.
 * @param {Uint8Array | ArrayBuffer} video
 * @returns {EmbeddedCover | null}
 */
export function extractCover(video) {
  let covers;
  try {
    covers = readMp4(bytesOf(video)).covers;
  } catch {
    return null;
  }
  if (covers === null || covers.length === 0) return null;
  const first = covers[0];
  if (first.data.length === 0 || first.data.length > MAX_COVER_BYTES) return null;
  const declared =
    first.imageformat === COVER_FORMATS.jpeg
      ? "jpeg"
      : first.imageformat === COVER_FORMATS.png
        ? "png"
        : null;
  const kind = imageKind(first.data) ?? declared;
  if (kind !== "jpeg" && kind !== "png") return null;
  return { data: first.data.slice(), mime: kind === "jpeg" ? "image/jpeg" : "image/png" };
}

/**
 * `thumbnails.has_embedded_cover`: whether {@link extractCover} finds a cover.
 * @param {Uint8Array | ArrayBuffer} video
 * @returns {boolean}
 */
export function hasEmbeddedCover(video) {
  return extractCover(video) !== null;
}
