// @ts-check
/**
 * Media fixtures and verification helpers for the extension's media tests (`ts.test.js`,
 * `mp4.test.js`, `remux.test.js`) and the e2e harness: every fixture is made by the system's
 * ffmpeg from lavfi test sources (no binary file in the repository), and every check asks
 * ffprobe / ffmpeg's `framemd5` muxer — the only external tools the tests call.
 *
 * Tool policy: {@link haveTools} says whether `ffmpeg` and `ffprobe` run; a media test passes
 * `{ skip: mediaSkip() }` to `node:test`, which skips it with {@link SKIP_MESSAGE} when they are
 * missing — unless `STREAMFETCH_REQUIRE_TOOLS=1` ({@link REQUIRE_TOOLS}, CI), where nothing is
 * skipped and the first builder throws, so a missing tool fails the run instead of passing it.
 *
 * Fixtures are built once per process (`node --test` runs each test file in its own process)
 * under one temporary directory ({@link mediaRoot}), which is removed when the process exits.
 * The `make*` builders take a directory and write into it; the cached accessors
 * ({@link sourceClip}, {@link hlsTsFixture}, {@link hlsFmp4Fixture}, {@link dashFixture},
 * {@link encryptedFixture}) build into {@link mediaRoot} on first use.
 *
 * The Node built-ins this module needs beyond `tests/node.d.ts` (child_process, os, path, crypto
 * and a few fs calls) are typed here, locally, by the shapes it uses, and reached through
 * `process.getBuiltinModule` (Node ≥ 22.3) — the extension has no @types/node.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * @typedef {object} NodeProcess
 * @property {Record<string, string | undefined>} env
 * @property {(event: "exit", listener: () => void) => void} on
 * @property {(id: string) => unknown} getBuiltinModule
 *
 * @typedef {object} SpawnResult
 * @property {number | null} status
 * @property {Uint8Array} stdout
 * @property {Uint8Array} stderr
 * @property {Error | undefined} error
 *
 * @typedef {{ cwd?: string, maxBuffer?: number }} SpawnOptions
 *
 * @typedef {object} ChildProcessModule
 * @property {(command: string, args: string[], options: SpawnOptions) => SpawnResult} spawnSync
 *
 * @typedef {object} FsExtraModule
 * @property {(prefix: string) => string} mkdtempSync
 * @property {(path: string, options: { recursive: boolean, force: boolean }) => void} rmSync
 * @property {(path: string, options: { recursive: boolean }) => void} mkdirSync
 *
 * @typedef {object} OsModule
 * @property {() => string} tmpdir
 *
 * @typedef {object} PathModule
 * @property {(...parts: string[]) => string} join
 *
 * @typedef {object} Hash
 * @property {(data: Uint8Array) => Hash} update
 * @property {(encoding: "hex") => string} digest
 *
 * @typedef {object} CryptoModule
 * @property {(algorithm: string) => Hash} createHash
 */

const proc = /** @type {NodeProcess} */ (Reflect.get(globalThis, "process"));
const childProcess = /** @type {ChildProcessModule} */ (
  proc.getBuiltinModule("node:child_process")
);
const fsExtra = /** @type {FsExtraModule} */ (proc.getBuiltinModule("node:fs"));
const os = /** @type {OsModule} */ (proc.getBuiltinModule("node:os"));
const path = /** @type {PathModule} */ (proc.getBuiltinModule("node:path"));
const crypto = /** @type {CryptoModule} */ (proc.getBuiltinModule("node:crypto"));

/** The message a media test is skipped with when ffmpeg or ffprobe is missing. */
export const SKIP_MESSAGE = "ffmpeg not found: media tests not run";

/** `STREAMFETCH_REQUIRE_TOOLS=1` (CI): a missing ffmpeg/ffprobe fails the media tests. */
export const REQUIRE_TOOLS = proc.env.STREAMFETCH_REQUIRE_TOOLS === "1";

/** The duration of the source clip, seconds. */
export const SOURCE_SECONDS = 6;

const decoder = new TextDecoder();

/** @type {boolean | null} */
let toolsFound = null;

/**
 * Whether `ffmpeg` and `ffprobe` are on the PATH and run (checked once per process).
 * @returns {boolean}
 */
export function haveTools() {
  if (toolsFound === null) {
    toolsFound = ["ffmpeg", "ffprobe"].every((tool) => {
      const result = childProcess.spawnSync(tool, ["-version"], {});
      return !result.error && result.status === 0;
    });
  }
  return toolsFound;
}

/**
 * The `skip` option of a media test: false when the tools are there or required (a required,
 * missing tool then fails the test), else {@link SKIP_MESSAGE}.
 * @returns {false | string}
 */
export function mediaSkip() {
  return haveTools() || REQUIRE_TOOLS ? false : SKIP_MESSAGE;
}

/** Throws when ffmpeg or ffprobe cannot run: every builder and checker calls it first. */
function requireTools() {
  if (!haveTools()) {
    throw new Error(
      REQUIRE_TOOLS
        ? "ffmpeg/ffprobe not found on the PATH and STREAMFETCH_REQUIRE_TOOLS=1: install ffmpeg"
        : SKIP_MESSAGE,
    );
  }
}

/**
 * Runs a tool and returns its stdout; throws with the tool's stderr when it fails.
 * @param {string} tool "ffmpeg" or "ffprobe"
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {Uint8Array}
 */
function run(tool, args, cwd) {
  requireTools();
  const result = childProcess.spawnSync(tool, args, { cwd, maxBuffer: 512 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const stderr = decoder.decode(result.stderr).trim().split("\n").slice(-8).join("\n");
    throw new Error(`${tool} ${args.join(" ")} failed (${result.status}): ${stderr}`);
  }
  return result.stdout;
}

/**
 * Runs ffmpeg quietly (`-hide_banner -loglevel error -nostdin -y` first).
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {Uint8Array} stdout
 */
export function ffmpeg(args, cwd) {
  return run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], cwd);
}

// ------------------------------------------------------------------------------- the root

/** @type {string | null} */
let root = null;

/**
 * The per-process temporary directory the cached fixtures live in, created on first use and
 * removed (recursively) when the process exits.
 * @returns {string}
 */
export function mediaRoot() {
  if (root === null) {
    const dir = fsExtra.mkdtempSync(path.join(os.tmpdir(), "streamfetch-media-"));
    root = dir;
    proc.on("exit", () => fsExtra.rmSync(dir, { recursive: true, force: true }));
  }
  return root;
}

/**
 * Memoizes a fixture builder for the process.
 * @template T
 * @param {() => T} build
 * @returns {() => T}
 */
function once(build) {
  /** @type {{ value: T } | null} */
  let cached = null;
  return () => {
    if (cached === null) cached = { value: build() };
    return cached.value;
  };
}

/**
 * @param {string} dir
 * @returns {string} `dir`, created when missing
 */
function ensureDir(dir) {
  fsExtra.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------------------------------------------------------------------- builders

/**
 * The source clip of every media test (spec section 9), `<dir>/src.mp4`: 6 s of `testsrc`
 * 320×180 at 25 fps in H.264 (libx264 ultrafast, a keyframe every second) and a 440 Hz sine at
 * 48 kHz in AAC-LC 64 kbit/s, mono — exactly
 * `ffmpeg -f lavfi -i testsrc=size=320x180:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000
 * -t 6 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 25 -c:a aac -b:a 64k -shortest src.mp4`.
 * @param {string} dir
 * @returns {string} the path
 */
export function makeSourceClip(dir) {
  const out = path.join(ensureDir(dir), "src.mp4");
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", String(SOURCE_SECONDS),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "25",
    "-c:a", "aac", "-b:a", "64k", "-shortest", out,
  ]); // prettier-ignore
  return out;
}

/**
 * @typedef {object} ClipOptions A test clip other than the source one (B-frames, other codecs,
 *   other picture sizes); every field has a default.
 * @property {string} [size] `WxH`, default "320x180"
 * @property {number} [rate] frames per second, default 25
 * @property {number} [seconds] default 2
 * @property {string} [preset] libx264 preset, default "ultrafast"
 * @property {number} [bframes] libx264 B-frames (`-bf`); default: the preset's
 * @property {string} [pixFmt] default "yuv420p"
 * @property {string[]} [videoArgs] more video encoder arguments (e.g. `-flags +ildct+ilme`)
 * @property {"aac" | "mp3" | "ac3" | null} [audio] default "aac"; null = no audio
 * @property {number} [sampleRate] default 48000
 * @property {number} [channels] default 1
 * @property {"mp4" | "mpegts" | "h264"} [format] the container, default "mp4"
 */

/** @type {Record<string, string>} */
const FORMAT_EXTENSIONS = { mp4: "mp4", mpegts: "ts", h264: "h264" };
/** @type {Record<string, string[]>} */
const AUDIO_ENCODERS = {
  aac: ["-c:a", "aac", "-b:a", "64k"],
  mp3: ["-c:a", "libmp3lame", "-b:a", "64k"],
  ac3: ["-c:a", "ac3", "-b:a", "96k"],
};

/**
 * A synthetic clip `<dir>/<name>.<ext>` built from lavfi sources with libx264 (and AAC, MP3 or
 * AC-3 audio), for the cases the source clip does not cover.
 * @param {string} dir
 * @param {string} name file name without extension
 * @param {ClipOptions} [options]
 * @returns {string} the path
 */
export function makeClip(dir, name, options = {}) {
  const format = options.format ?? "mp4";
  const out = path.join(ensureDir(dir), `${name}.${FORMAT_EXTENSIONS[format]}`);
  const audio = format === "h264" ? null : options.audio === undefined ? "aac" : options.audio;
  const rate = options.rate ?? 25;
  const args = ["-f", "lavfi", "-i", `testsrc=size=${options.size ?? "320x180"}:rate=${rate}`];
  if (audio) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${options.sampleRate ?? 48000}`);
  }
  args.push("-t", String(options.seconds ?? 2), "-c:v", "libx264");
  args.push("-preset", options.preset ?? "ultrafast");
  if (options.bframes !== undefined) args.push("-bf", String(options.bframes));
  args.push("-pix_fmt", options.pixFmt ?? "yuv420p", "-g", String(rate));
  args.push(...(options.videoArgs ?? []));
  if (audio) args.push(...AUDIO_ENCODERS[audio], "-ac", String(options.channels ?? 1), "-shortest");
  args.push("-f", format, out);
  ffmpeg(args);
  return out;
}

/**
 * Remuxes a file to MPEG-TS without re-encoding (`-c copy -f mpegts`), next to it.
 * @param {string} input
 * @returns {string} the `.ts` path
 */
export function remuxToTs(input) {
  const out = input.replace(/\.[^./]+$/, "") + ".ts";
  ffmpeg(["-i", input, "-map", "0", "-c", "copy", "-f", "mpegts", out]);
  return out;
}

/**
 * @typedef {object} HlsFixture An HLS rendition of the source clip.
 * @property {string} dir
 * @property {string} master the master playlist the helper writes: two variants (NAME "180"
 *   320×180 and NAME "90" 160×90) pointing at the same media playlist
 * @property {string} media the media playlist ffmpeg writes
 * @property {string | null} init the fMP4 initialization section (`#EXT-X-MAP`), null for TS
 * @property {string[]} segments the segment files in playlist order
 * @property {string} codecs the master's CODECS value (from the source's avcC)
 */

/**
 * @param {string} dir
 * @returns {string} `<dir>/src.mp4`, built when missing
 */
function sourceIn(dir) {
  const src = path.join(dir, "src.mp4");
  return existsSync(src) ? src : makeSourceClip(dir);
}

/**
 * @param {string} folder
 * @param {string} src
 * @param {"ts" | "fmp4"} type
 * @returns {HlsFixture}
 */
function makeHls(folder, src, type) {
  const extension = type === "ts" ? "ts" : "m4s";
  const args = ["-i", src, "-c", "copy", "-f", "hls", "-hls_time", "2"];
  args.push("-hls_playlist_type", "vod");
  if (type === "fmp4") {
    args.push("-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4");
  }
  args.push("-hls_segment_filename", `seg%03d.${extension}`, "media.m3u8");
  ffmpeg(args, folder);
  const media = path.join(folder, "media.m3u8");
  const segments = readFileSync(media, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => path.join(folder, line));
  const codecs = `${avcCodecString(readFileSync(src))},mp4a.40.2`;
  const master = path.join(folder, "master.m3u8");
  writeFileSync(
    master,
    [
      "#EXTM3U",
      `#EXT-X-VERSION:${type === "ts" ? 3 : 7}`,
      "#EXT-X-INDEPENDENT-SEGMENTS",
      `#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,CODECS="${codecs}",NAME="180"`,
      "media.m3u8",
      `#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=160x90,CODECS="${codecs}",NAME="90"`,
      "media.m3u8",
      "",
    ].join("\n"),
  );
  return {
    dir: folder,
    master,
    media,
    init: type === "fmp4" ? path.join(folder, "init.mp4") : null,
    segments,
    codecs,
  };
}

/**
 * The source clip as a VOD HLS stream in MPEG-TS segments, `<dir>/hls-ts/`:
 * `ffmpeg -i src.mp4 -c copy -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_filename
 * seg%03d.ts media.m3u8`, plus the helper's two-variant master. Builds `<dir>/src.mp4` first
 * when it is missing.
 * @param {string} dir
 * @returns {HlsFixture}
 */
export function makeHlsTs(dir) {
  return makeHls(ensureDir(path.join(dir, "hls-ts")), sourceIn(dir), "ts");
}

/**
 * The same in fMP4 segments, `<dir>/hls-fmp4/`: `-hls_segment_type fmp4
 * -hls_fmp4_init_filename init.mp4` (segments `seg%03d.m4s`).
 * @param {string} dir
 * @returns {HlsFixture}
 */
export function makeHlsFmp4(dir) {
  return makeHls(ensureDir(path.join(dir, "hls-fmp4")), sourceIn(dir), "fmp4");
}

/**
 * @typedef {object} DashFixture The source clip as Bilibili-style DASH files: one complete
 *   fragmented MP4 per track.
 * @property {string} video `<dir>/dash/video.m4s` (video only)
 * @property {string} audio `<dir>/dash/audio.m4s` (audio only)
 */

/**
 * `ffmpeg -i src.mp4 -an -c:v copy -movflags frag_keyframe+empty_moov+default_base_moof
 * -frag_duration 1000000 -f mp4 video.m4s` and the same with `-vn -c:a copy` for `audio.m4s`
 * (`-f mp4` because ffmpeg does not infer a muxer from `.m4s`).
 * @param {string} dir
 * @returns {DashFixture}
 */
export function makeDash(dir) {
  const src = sourceIn(dir);
  const folder = ensureDir(path.join(dir, "dash"));
  const fragmented = [
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration",
    "1000000",
    "-f",
    "mp4",
  ];
  const video = path.join(folder, "video.m4s");
  const audio = path.join(folder, "audio.m4s");
  ffmpeg(["-i", src, "-an", "-c:v", "copy", ...fragmented, video]);
  ffmpeg(["-i", src, "-vn", "-c:a", "copy", ...fragmented, audio]);
  return { video, audio };
}

// ------------------------------------------------------------------- the sites' codecs

/** The duration of every codec clip, seconds. */
export const CODEC_SECONDS = 2;

/**
 * @typedef {object} SiteCodec One codec the sites serve at high quality, as an MP4 sample entry.
 * @property {"video" | "audio"} kind
 * @property {string} entry the sample entry type (`hvc1`, `fLaC`, `ec-3` …), also the fixture's
 *   file name
 * @property {string} codecName ffprobe's `codec_name`
 * @property {string} config the codec configuration box inside the sample entry
 * @property {string} what in words, for the test names
 */

/**
 * The codecs of the sites' high-quality streams (spec section 3 and Addendum B.1): H.264 with
 * B-frames (Bilibili.tv's progressive files, Bilibili's `avc1`), HEVC as `hvc1` and as `hev1`
 * (Bilibili's `hev1.…` / `hvc1.…`), AV1 (`av01.…`); AAC, FLAC (Bilibili's Hi-Res `flac`),
 * E-AC-3 (its Dolby `ec-3`), AC-3 and Opus.
 * @type {Readonly<Record<string, SiteCodec>>}
 */
export const SITE_CODECS = Object.freeze({
  avc1: siteCodec("video", "avc1", "h264", "avcC", "H.264 High with B-frames"),
  hvc1: siteCodec("video", "hvc1", "hevc", "hvcC", "HEVC (hvc1)"),
  hev1: siteCodec("video", "hev1", "hevc", "hvcC", "HEVC (hev1)"),
  av01: siteCodec("video", "av01", "av1", "av1C", "AV1"),
  mp4a: siteCodec("audio", "mp4a", "aac", "esds", "AAC-LC stereo"),
  fLaC: siteCodec("audio", "fLaC", "flac", "dfLa", "FLAC 24-bit 96 kHz"),
  "ec-3": siteCodec("audio", "ec-3", "eac3", "dec3", "E-AC-3 5.1"),
  "ac-3": siteCodec("audio", "ac-3", "ac3", "dac3", "AC-3 stereo"),
  Opus: siteCodec("audio", "Opus", "opus", "dOps", "Opus stereo"),
});

/**
 * @param {"video" | "audio"} kind
 * @param {string} entry
 * @param {string} codecName
 * @param {string} config
 * @param {string} what
 * @returns {SiteCodec}
 */
function siteCodec(kind, entry, codecName, config, what) {
  return Object.freeze({ kind, entry, codecName, config, what });
}

/** @type {string | null} */
let av1Encoder = null;

/**
 * The AV1 encoder ffmpeg has: `libsvtav1` (fast), else `libaom-av1`.
 * @returns {string}
 */
function av1EncoderName() {
  if (av1Encoder === null) {
    const list = decoder.decode(ffmpeg(["-encoders"]));
    av1Encoder = /\blibsvtav1\b/.test(list) ? "libsvtav1" : "libaom-av1";
  }
  return av1Encoder;
}

/**
 * The ffmpeg input and encoder arguments of a codec clip: lavfi `testsrc` 160×96 at 25 fps (a
 * keyframe every second) or a 440 Hz sine, {@link CODEC_SECONDS} long, at a tiny size and the
 * fastest presets.
 * @param {string} entry a key of {@link SITE_CODECS}
 * @returns {string[]}
 */
function codecArgs(entry) {
  const video = ["-f", "lavfi", "-i", "testsrc=size=160x96:rate=25", "-t", String(CODEC_SECONDS)];
  /** @param {number} rate */
  const sine = (rate) => [
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${rate}`, "-t", String(CODEC_SECONDS),
  ]; // prettier-ignore
  const picture = ["-pix_fmt", "yuv420p", "-g", "25"];
  const x265 = ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error"];
  switch (entry) {
    case "avc1":
      return [...video, "-c:v", "libx264", "-preset", "veryfast", "-bf", "2", ...picture];
    case "hvc1":
    case "hev1":
      return [...video, ...x265, ...picture, "-tag:v", entry];
    case "av01": {
      const encoder = av1EncoderName();
      const speed =
        encoder === "libsvtav1" ? ["-preset", "12"] : ["-cpu-used", "8", "-row-mt", "1"];
      return [...video, "-c:v", encoder, ...speed, ...picture];
    }
    case "mp4a":
      return [...sine(48000), "-c:a", "aac", "-b:a", "128k", "-ac", "2"];
    case "fLaC":
      return [...sine(96000), "-c:a", "flac", "-sample_fmt", "s32", "-ac", "2"];
    case "ec-3":
      return [...sine(48000), "-c:a", "eac3", "-b:a", "384k", "-ac", "6"];
    case "ac-3":
      return [...sine(48000), "-c:a", "ac3", "-b:a", "192k", "-ac", "2"];
    case "Opus":
      return [...sine(48000), "-c:a", "libopus", "-b:a", "96k", "-ac", "2"];
    default:
      throw new Error(`no codec clip for ${entry}`);
  }
}

/**
 * @typedef {object} CodecFixture One codec in both layouts the sites serve, the same samples.
 * @property {SiteCodec} codec
 * @property {string} progressive `<dir>/codecs/<entry>.mp4`: ffmpeg's default layout, the `moov`
 *   after the `mdat` (as Bilibili.tv's progressive files), with ffmpeg's edit list (B-frame delay,
 *   encoder delay, Opus pre-skip)
 * @property {string} fragmented `<dir>/codecs/<entry>.m4s`: the same samples (`-c copy`) as a
 *   Bilibili DASH file — `-movflags frag_keyframe+empty_moov+default_base_moof`, plus
 *   `delay_moov` for AC-3 and E-AC-3, whose `moov` ffmpeg cannot write before it read a frame
 */

/**
 * Builds the fixture of one codec of {@link SITE_CODECS} in `<dir>/codecs/`.
 * @param {string} dir
 * @param {string} entry
 * @returns {CodecFixture}
 */
export function makeCodecFixture(dir, entry) {
  const codec = SITE_CODECS[entry];
  if (codec === undefined) throw new Error(`unknown codec ${entry}`);
  const folder = ensureDir(path.join(dir, "codecs"));
  const progressive = path.join(folder, `${entry}.mp4`);
  const fragmented = path.join(folder, `${entry}.m4s`);
  ffmpeg([...codecArgs(entry), "-f", "mp4", progressive]);
  const delay = entry === "ac-3" || entry === "ec-3" ? "+delay_moov" : "";
  const flags = `frag_keyframe+empty_moov+default_base_moof${delay}`;
  const only = codec.kind === "video" ? ["-an", "-c:v", "copy"] : ["-vn", "-c:a", "copy"];
  const layout = ["-movflags", flags, "-frag_duration", "1000000", "-f", "mp4"];
  ffmpeg(["-i", progressive, ...only, ...layout, fragmented]);
  return { codec, progressive, fragmented };
}

/** @type {Map<string, CodecFixture>} */
const codecFixtures = new Map();

/**
 * {@link makeCodecFixture} in {@link mediaRoot}, built once per process and codec.
 * @param {string} entry
 * @returns {CodecFixture}
 */
export function codecFixture(entry) {
  let fixture = codecFixtures.get(entry);
  if (fixture === undefined) {
    fixture = makeCodecFixture(mediaRoot(), entry);
    codecFixtures.set(entry, fixture);
  }
  return fixture;
}

// -------------------------------------------------------------------- MP4 structure edits

/**
 * @typedef {object} BoxRef A box found by {@link mp4Boxes}.
 * @property {string} type
 * @property {number} start offset of the size field
 * @property {number} size the whole box
 * @property {number} headerSize 8, or 16 with a 64-bit size
 * @property {number} end start + size
 */

/** Container boxes {@link findBox} descends into: their children start right after the header. */
const CONTAINERS = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "mvex",
  "moof",
  "traf",
  "edts",
  "dinf",
  "udta",
]);

/**
 * The boxes between `start` and `end` (32-bit and 64-bit sizes; a size of 0 runs to `end`).
 * Throws on a header that is not a box: these helpers edit known files and never guess.
 * @param {Uint8Array} bytes
 * @param {number} [start]
 * @param {number} [end]
 * @returns {BoxRef[]}
 */
export function mp4Boxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** @type {BoxRef[]} */
  const found = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    let headerSize = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) throw new Error(`not a box at offset ${pos}`);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    found.push({ type, start: pos, size, headerSize, end: pos + size });
    pos += size;
  }
  return found;
}

/**
 * The first box at a path of types below `within` (or the file's top level), e.g.
 * `["moov", "trak", "mdia", "minf", "stbl", "stsd"]`; a path may step into a sample entry by its
 * type (`[..., "stsd", "avc1", "avcC"]`). Null when absent.
 * @param {Uint8Array} bytes
 * @param {string[]} types
 * @param {BoxRef | null} [within]
 * @returns {BoxRef | null}
 */
export function findBox(bytes, types, within = null) {
  let current = within;
  for (const type of types) {
    const start = current ? current.start + current.headerSize + childOffset(current.type) : 0;
    const end = current ? current.end : bytes.length;
    current = mp4Boxes(bytes, start, end).find((box) => box.type === type) ?? null;
    if (current === null) return null;
  }
  return current;
}

/**
 * The `trak` boxes of the file's `moov`, in order.
 * @param {Uint8Array} bytes
 * @returns {BoxRef[]}
 */
export function trackBoxes(bytes) {
  const moov = findBox(bytes, ["moov"]);
  if (!moov) return [];
  const children = mp4Boxes(bytes, moov.start + moov.headerSize, moov.end);
  return children.filter((box) => box.type === "trak");
}

/**
 * Where the children of a box start after its header: containers at once, `stsd` after its
 * version, flags and entry count, a visual sample entry after its 78 bytes, an audio one after 28.
 * @param {string} type
 * @returns {number}
 */
function childOffset(type) {
  if (CONTAINERS.has(type)) return 0;
  if (type === "stsd") return 8;
  if (["avc1", "avc3", "hvc1", "hev1", "encv", "av01"].includes(type)) return 78;
  if (["mp4a", "enca", "ac-3", "ec-3", ".mp3", "fLaC", "Opus"].includes(type)) return 28;
  throw new Error(`no children known for ${type}`);
}

/**
 * The payload of a box (after its header).
 * @param {Uint8Array} bytes
 * @param {BoxRef} box
 * @returns {Uint8Array}
 */
export function boxPayload(bytes, box) {
  return bytes.subarray(box.start + box.headerSize, box.end);
}

/**
 * The `avcC` payload of the first `avc1` track of an MP4, or null.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array | null}
 */
export function avcConfig(bytes) {
  for (const trak of trackBoxes(bytes)) {
    const avcC = findBox(bytes, ["mdia", "minf", "stbl", "stsd", "avc1", "avcC"], trak);
    if (avcC) return boxPayload(bytes, avcC);
  }
  return null;
}

/**
 * The RFC 6381 codec string of the first `avc1` track of an MP4 (`avc1.PPCCLL` from its avcC).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function avcCodecString(bytes) {
  const config = avcConfig(bytes);
  if (!config) throw new Error("no avc1 track");
  const hex = [config[1], config[2], config[3]].map((byte) => byte.toString(16).padStart(2, "0"));
  return `avc1.${hex.join("")}`;
}

/** Widevine's DRM system id (the SystemID of its `pssh` boxes). */
export const WIDEVINE_SYSTEM_ID = Uint8Array.from(
  "edef8ba979d64acea3c827dcd51d21ed".match(/../g) ?? [],
  (pair) => Number.parseInt(pair, 16),
);

/**
 * A valid version-0 `pssh` box: size, `pssh`, version and flags 0, the system id, the payload
 * size and the payload (a key id list in real files; anything here).
 * @param {Uint8Array} [payload]
 * @param {Uint8Array} [systemId]
 * @returns {Uint8Array}
 */
export function psshBox(payload = new Uint8Array(0), systemId = WIDEVINE_SYSTEM_ID) {
  const out = new Uint8Array(32 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  out.set([0x70, 0x73, 0x73, 0x68], 4); // "pssh"
  out.set(systemId, 12);
  view.setUint32(28, payload.length);
  out.set(payload, 32);
  return out;
}

/**
 * @typedef {object} EncryptOptions
 * @property {boolean} [video] rename every `avc1` sample entry `encv` (default true)
 * @property {boolean} [audio] rename every `mp4a` sample entry `enca` (default true)
 * @property {"moov" | "end" | "none"} [pssh] where a `pssh` box goes: appended inside the
 *   `moov` (its size grows: only for an init section or a fragmented file whose fragments use
 *   moof-relative offsets — refused otherwise), appended at the end of the file (no offset
 *   moves), or nowhere; default "moov"
 */

/**
 * What an encrypted file declares to a DRM check, made by a STRUCTURAL edit (DramaFetch's
 * `tests/encrypted_mp4.py`, ported): the sample entries renamed in place and a `pssh` box added.
 * The samples are not encrypted — nothing here encrypts or decrypts anything.
 * @param {Uint8Array} bytes an MP4 (init section, fragmented or progressive)
 * @param {EncryptOptions} [options]
 * @returns {Uint8Array} a new array
 */
export function markEncrypted(bytes, options = {}) {
  const out = bytes.slice();
  const moov = findBox(out, ["moov"]);
  if (!moov) throw new Error("no moov box");
  let renamed = 0;
  for (const trak of trackBoxes(out)) {
    const stsd = findBox(out, ["mdia", "minf", "stbl", "stsd"], trak);
    if (!stsd) throw new Error("a trak without an stsd");
    for (const entry of mp4Boxes(out, stsd.start + stsd.headerSize + 8, stsd.end)) {
      const rename =
        entry.type === "avc1" && options.video !== false
          ? "encv"
          : entry.type === "mp4a" && options.audio !== false
            ? "enca"
            : null;
      if (rename) {
        for (let i = 0; i < 4; i += 1) out[entry.start + 4 + i] = rename.charCodeAt(i);
        renamed += 1;
      }
    }
  }
  if (renamed === 0) throw new Error("no sample entry to rename");
  const placement = options.pssh ?? "moov";
  if (placement === "none") return out;
  const pssh = psshBox(new TextEncoder().encode("streamfetch test key id"));
  if (placement === "end") return concatBytes([out, pssh]);
  const fragmented = findBox(out, ["moov", "mvex"]) !== null;
  const mediaAfter = mp4Boxes(out).some((box) => box.type === "mdat" && box.start > moov.start);
  if (mediaAfter && !fragmented) {
    throw new Error("a pssh inside the moov would move this progressive file's chunk offsets");
  }
  const grown = concatBytes([out.subarray(0, moov.end), pssh, out.subarray(moov.end)]);
  new DataView(grown.buffer).setUint32(moov.start, moov.size + pssh.length);
  return grown;
}

/**
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
export function concatBytes(parts) {
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
 * @typedef {object} EncryptedFixture Encrypted-looking copies of the fMP4 fixtures, in
 *   `<dir>/encrypted/`: `encv`/`enca` sample entries and a `pssh` inside the `moov`.
 * @property {string} init the fMP4 HLS init section (`avc1` → `encv`, `mp4a` → `enca`)
 * @property {string} video the DASH video file (`avc1` → `encv`)
 * @property {string} audio the DASH audio file (`mp4a` → `enca`)
 */

/**
 * Builds the encrypted fixtures for the DRM refusal from `<dir>/hls-fmp4/init.mp4` and
 * `<dir>/dash/*.m4s` (built first when missing).
 * @param {string} dir
 * @returns {EncryptedFixture}
 */
export function makeEncryptedInit(dir) {
  const initPath = path.join(dir, "hls-fmp4", "init.mp4");
  const init = existsSync(initPath) ? initPath : /** @type {string} */ (makeHlsFmp4(dir).init);
  const dashVideo = path.join(dir, "dash", "video.m4s");
  const dash = existsSync(dashVideo)
    ? { video: dashVideo, audio: path.join(dir, "dash", "audio.m4s") }
    : makeDash(dir);
  const folder = ensureDir(path.join(dir, "encrypted"));
  const out = {
    init: path.join(folder, "init.mp4"),
    video: path.join(folder, "video.m4s"),
    audio: path.join(folder, "audio.m4s"),
  };
  writeFileSync(out.init, markEncrypted(readFileSync(init)));
  writeFileSync(out.video, markEncrypted(readFileSync(dash.video)));
  writeFileSync(out.audio, markEncrypted(readFileSync(dash.audio)));
  return out;
}

// --------------------------------------------------------------------------- cached fixtures

/** `src.mp4` in {@link mediaRoot}, built once per process. */
export const sourceClip = once(() => makeSourceClip(mediaRoot()));
/** {@link makeHlsTs} in {@link mediaRoot}, built once per process. */
export const hlsTsFixture = once(() => {
  sourceClip();
  return makeHlsTs(mediaRoot());
});
/** {@link makeHlsFmp4} in {@link mediaRoot}, built once per process. */
export const hlsFmp4Fixture = once(() => {
  sourceClip();
  return makeHlsFmp4(mediaRoot());
});
/** {@link makeDash} in {@link mediaRoot}, built once per process. */
export const dashFixture = once(() => {
  sourceClip();
  return makeDash(mediaRoot());
});
/** {@link makeEncryptedInit} in {@link mediaRoot}, built once per process. */
export const encryptedFixture = once(() => {
  hlsFmp4Fixture();
  dashFixture();
  return makeEncryptedInit(mediaRoot());
});

// ----------------------------------------------------------------------------- verification

/**
 * @param {unknown} value
 * @returns {number | null} a finite number (ffprobe writes many numbers as strings), else null
 */
function numberOrNull(value) {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function record(value) {
  if (typeof value !== "object" || value === null) return {};
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @typedef {object} ProbedStream
 * @property {number} index
 * @property {string | null} codec_type "video", "audio", …
 * @property {string | null} codec_name
 * @property {string | null} codec_tag_string the MP4 sample entry type (`hvc1`, `fLaC` …)
 * @property {string | null} profile
 * @property {number | null} start_time seconds
 * @property {number | null} duration seconds
 * @property {number | null} duration_ts the duration in the stream's time base
 * @property {number | null} width
 * @property {number | null} height
 * @property {number | null} sample_rate
 * @property {number | null} channels
 * @property {number | null} nb_read_packets with `countPackets` only
 *
 * @typedef {object} ProbeResult
 * @property {ProbedStream[]} streams
 * @property {{ duration: number | null, format_name: string | null }} format
 */

/**
 * `ffprobe -show_streams -show_format` (and `-count_packets` when asked), numbers parsed;
 * `ignoreEditList` reads an MP4 without its edit list (`-ignore_editlist 1`), so a stream's
 * duration is its sample tables' total.
 * @param {string} file
 * @param {{ countPackets?: boolean, ignoreEditList?: boolean }} [options]
 * @returns {ProbeResult}
 */
export function ffprobe(file, options = {}) {
  const args = ["-v", "error", "-print_format", "json", "-show_streams", "-show_format"];
  if (options.countPackets) args.push("-count_packets");
  if (options.ignoreEditList) args.push("-ignore_editlist", "1");
  /** @type {unknown} */
  const parsed = JSON.parse(decoder.decode(run("ffprobe", [...args, file])));
  const top = record(parsed);
  const streams = Array.isArray(top.streams) ? top.streams : [];
  const format = record(top.format);
  return {
    streams: streams.map((value) => {
      const stream = record(value);
      return {
        index: numberOrNull(stream.index) ?? -1,
        codec_type: stringOrNull(stream.codec_type),
        codec_name: stringOrNull(stream.codec_name),
        codec_tag_string: stringOrNull(stream.codec_tag_string),
        profile: stringOrNull(stream.profile),
        start_time: numberOrNull(stream.start_time),
        duration: numberOrNull(stream.duration),
        duration_ts: numberOrNull(stream.duration_ts),
        width: numberOrNull(stream.width),
        height: numberOrNull(stream.height),
        sample_rate: numberOrNull(stream.sample_rate),
        channels: numberOrNull(stream.channels),
        nb_read_packets: numberOrNull(stream.nb_read_packets),
      };
    }),
    format: {
      duration: numberOrNull(format.duration),
      format_name: stringOrNull(format.format_name),
    },
  };
}

/**
 * @typedef {object} ProbedPacket One packet of `ffprobe -show_packets`, in the stream's time base.
 * @property {number | null} pts
 * @property {number | null} dts
 * @property {number | null} duration
 * @property {number} size bytes
 * @property {number | null} pos byte position in the file
 * @property {boolean} keyframe the `K` flag
 */

/**
 * The packets of one stream (`-select_streams v:0`, `a:0`, …), in demux order.
 * @param {string} file
 * @param {string} select an ffprobe stream specifier
 * @returns {ProbedPacket[]}
 */
export function ffprobePackets(file, select) {
  /** @type {unknown} */
  const parsed = JSON.parse(
    decoder.decode(
      run("ffprobe", [
        "-v", "error", "-select_streams", select, "-show_packets",
        "-show_entries", "packet=pts,dts,duration,size,pos,flags", "-print_format", "json", file,
      ]), // prettier-ignore
    ),
  );
  const packets = record(parsed).packets;
  return (Array.isArray(packets) ? packets : []).map((value) => {
    const packet = record(value);
    return {
      pts: numberOrNull(packet.pts),
      dts: numberOrNull(packet.dts),
      duration: numberOrNull(packet.duration),
      size: numberOrNull(packet.size) ?? 0,
      pos: numberOrNull(packet.pos),
      keyframe: (stringOrNull(packet.flags) ?? "").includes("K"),
    };
  });
}

/**
 * @typedef {object} Framemd5Options
 * @property {string} [stream] the `-map` specifier inside input 0, default "v:0"
 * @property {boolean} [copy] hash the packets as stored (`-c copy`) instead of the decoded frames
 * @property {boolean} [ignoreEditList] read an MP4 without its edit list (`-ignore_editlist 1`),
 *   so the AAC priming frame is decoded like a raw stream's
 * @property {string} [inputFormat] force the input format (`-f h264`, `-f aac`)
 */

/**
 * The hash column of ffmpeg's `framemd5` muxer for one stream of a file: one MD5 per decoded
 * frame (or per packet with `copy`), bit-exact flags on.
 * @param {string} file
 * @param {Framemd5Options} [options]
 * @returns {string[]}
 */
export function framemd5(file, options = {}) {
  const args = [];
  if (options.ignoreEditList) args.push("-ignore_editlist", "1");
  if (options.inputFormat) args.push("-f", options.inputFormat);
  args.push("-i", file, "-map", `0:${options.stream ?? "v:0"}`);
  if (options.copy) args.push("-c", "copy");
  args.push("-flags", "+bitexact", "-fflags", "+bitexact", "-f", "framemd5", "-");
  return decoder
    .decode(ffmpeg(args))
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => (line.split(",")[5] ?? "").trim());
}

/**
 * The hex MD5 of some bytes (what `framemd5` with `copy` prints for a packet).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function md5Hex(bytes) {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

/**
 * The files' bytes, concatenated (HLS segments, as one stream).
 * @param {string[]} files
 * @returns {Uint8Array}
 */
export function readConcat(files) {
  return concatBytes(files.map((file) => readFileSync(file)));
}

/**
 * A path inside {@link mediaRoot} for a file a test writes.
 * @param {string} name
 * @returns {string}
 */
export function scratchPath(name) {
  return path.join(ensureDir(path.join(mediaRoot(), "scratch")), name);
}
