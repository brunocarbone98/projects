// @ts-check
// Unit tests of src/lib/hls.js: the playlist fixtures, the junk cases and the selection matrix.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  chooseVariant,
  codecFamily,
  isAudioOnlyCodecs,
  isMaster,
  parseAttributes,
  parseMaster,
  parseMedia,
  pickAudio,
  resolveUrl,
} from "../src/lib/hls.js";

/** @typedef {import("../src/lib/hls.js").HlsVariant} HlsVariant */
/** @typedef {import("../src/lib/hls.js").HlsRendition} HlsRendition */

/** @param {string} name */
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const ROOT = "https://cdn.example-dm.test/sec(abc)/video/x8abcd1";
const MASTER_URL = `${ROOT}/manifest.m3u8`;
const MEDIA_URL = `${ROOT}/720/manifest.m3u8`;
/** A null or undefined handed to a function that expects text. */
const NOT_TEXT = /** @type {string} */ (/** @type {unknown} */ (null));

test("attribute lists: quoted values keep their commas, keys are upper-cased, junk is skipped", () => {
  assert.deepEqual(
    parseAttributes(
      'BANDWIDTH=255000,CODECS="avc1.42c01e,mp4a.40.2",name="240",FRAME-RATE=25,URI="a,b"',
    ),
    {
      BANDWIDTH: "255000",
      CODECS: "avc1.42c01e,mp4a.40.2",
      NAME: "240",
      "FRAME-RATE": "25",
      URI: "a,b",
    },
  );
  assert.deepEqual(parseAttributes(' A=1 , B = 2 ,BARE,C="unterminated'), {
    A: "1",
    B: "2",
    C: "unterminated",
  });
  assert.deepEqual(parseAttributes(""), {});
  assert.deepEqual(parseAttributes(",,,=5,"), {});
});

test("URIs resolve against the playlist's URL and lose their fragment", () => {
  assert.equal(resolveUrl("720/manifest.m3u8#cell=core", MASTER_URL), `${ROOT}/720/manifest.m3u8`);
  assert.equal(
    resolveUrl("/root.m3u8?x=1", MASTER_URL),
    "https://cdn.example-dm.test/root.m3u8?x=1",
  );
  assert.equal(
    resolveUrl("https://other.example.test/a.ts", MASTER_URL),
    "https://other.example.test/a.ts",
  );
  assert.equal(resolveUrl("seg.ts#frag", null), "seg.ts"); // no base: as written, fragment aside
  assert.equal(resolveUrl("seg.ts", "not a url"), "seg.ts");
});

test("a master is told from a media playlist by its tags", () => {
  assert.equal(isMaster(fixture("hls-master-ts.m3u8")), true);
  assert.equal(isMaster(fixture("hls-master-fmp4.m3u8")), true);
  const mediaFixtures = [
    "hls-media-ts.m3u8",
    "hls-media-fmp4.m3u8",
    "hls-media-live.m3u8",
    "hls-media-keyed.m3u8",
  ];
  for (const name of mediaFixtures) assert.equal(isMaster(fixture(name)), false, name);
  assert.equal(
    isMaster("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n#EXTINF:1,\nseg.ts\n"),
    false,
  );
  assert.equal(isMaster("hello"), false);
  assert.equal(isMaster(NOT_TEXT), false);
});

test("the TS master: six variants with NAME, RESOLUTION, CODECS, FRAME-RATE, resolved URLs", () => {
  const { variants, audioRenditions } = parseMaster(fixture("hls-master-ts.m3u8"), MASTER_URL);
  assert.deepEqual(audioRenditions, []);
  assert.deepEqual(
    variants.map((v) => [
      v.name,
      v.width,
      v.height,
      v.bandwidth,
      v.frameRate,
      v.codecs,
      v.audioGroup,
    ]),
    [
      ["240", 426, 240, 255000, 25, "avc1.42c01e,mp4a.40.2", null],
      ["380", 640, 380, 460000, 25, "avc1.4d401e,mp4a.40.2", null],
      ["480", 854, 480, 1200000, 25, "avc1.4d401f,mp4a.40.2", null],
      ["720", 1280, 720, 2500000, 25, "avc1.64001f,mp4a.40.2", null],
      ["720", 1280, 720, 1900000, 25, "hvc1.1.6.L93.B0,mp4a.40.2", null],
      ["1080", 1920, 1080, 5000000, 25, "avc1.640028,mp4a.40.2", null],
    ],
  );
  // absolute and relative URIs, the "#cell=core" fragment dropped, the I-FRAME line and the
  // comment ignored
  assert.equal(variants[0]?.url, `${ROOT}/240/manifest.m3u8`);
  assert.equal(variants[1]?.url, `${ROOT}/380/manifest.m3u8`);
  assert.equal(variants[5]?.url, `${ROOT}/1080/manifest.m3u8`);
  assert.equal(
    variants.some((v) => v.url.includes("iframes")),
    false,
  );
});

test("the fMP4 master: audio renditions, a muxed group, a subtitles group ignored, a dangling STREAM-INF dropped", () => {
  const { variants, audioRenditions } = parseMaster(fixture("hls-master-fmp4.m3u8"), MASTER_URL);
  assert.deepEqual(audioRenditions, [
    {
      groupId: "aac",
      name: "Español",
      url: `${ROOT}/audio/es/manifest.m3u8`,
      isDefault: false,
      language: "es",
    },
    {
      groupId: "aac",
      name: "English",
      url: `${ROOT}/audio/en/manifest.m3u8`,
      isDefault: true,
      language: "en",
    },
    { groupId: "muxed", name: "Stereo", url: null, isDefault: true, language: null },
  ]);
  assert.deepEqual(
    variants.map((v) => [v.name, v.height, v.bandwidth, v.frameRate, v.audioGroup]),
    [
      ["1080", 1080, 5200000, 29.97, "aac"],
      ["720", 720, 2600000, 29.97, "aac"],
      ["720", 720, 3000000, 29.97, "aac"],
      ["480", 480, 1300000, null, "muxed"],
      [null, null, 128000, null, "aac"], // the audio-only STREAM-INF: no RESOLUTION, no NAME
    ],
  );
  assert.equal(variants[4]?.codecs, "mp4a.40.2");
  assert.equal(variants[4]?.width, null);
});

test("master junk: no lines, no STREAM-INF, odd attributes, CRLF", () => {
  assert.deepEqual(parseMaster("hello\nworld", MASTER_URL), { variants: [], audioRenditions: [] });
  assert.deepEqual(parseMaster(NOT_TEXT, MASTER_URL), { variants: [], audioRenditions: [] });
  const odd = parseMaster(
    "#EXTM3U\r\n" +
      "#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=900000,RESOLUTION=junk,FRAME-RATE=fast\r\n" +
      "odd.m3u8\r\n" +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g"\r\n' +
      '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="v",NAME="alt"\r\n',
    MASTER_URL,
  );
  assert.deepEqual(odd.variants, [
    {
      url: `${ROOT}/odd.m3u8`,
      bandwidth: 900000,
      width: null,
      height: null,
      frameRate: null,
      codecs: null,
      name: null,
      audioGroup: null,
    },
  ]);
  assert.deepEqual(odd.audioRenditions, []); // a rendition without NAME, and a VIDEO one
  // a STREAM-INF without its URI line
  assert.deepEqual(parseMaster("#EXT-X-STREAM-INF:BANDWIDTH=1\n", MASTER_URL).variants, []);
});

test("the TS media playlist: segments, durations, a title with a comma, METHOD=NONE, ENDLIST", () => {
  const media = parseMedia(fixture("hls-media-ts.m3u8"), MEDIA_URL);
  assert.deepEqual(
    media.segments.map((s) => [s.url, s.durationS, s.byteRange]),
    [
      [`${ROOT}/720/seg-00000.ts?sec=abc`, 10, null],
      [`${ROOT}/720/seg-00001.ts?sec=abc`, 10, null],
      ["https://cdn2.example-dm.test/sec(abc)/video/x8abcd1/720/seg-00002.ts", 9.76, null],
      [`${ROOT}/720/seg-00003.ts`, 7.24, null],
    ],
  );
  assert.equal(media.init, null);
  assert.equal(media.container, "ts");
  assert.equal(media.endList, true);
  assert.equal(media.keyProtected, false);
  assert.equal(media.discontinuities, 0);
  assert.equal(media.targetDurationS, 10);
});

test("the fMP4 media playlist: MAP with BYTERANGE, explicit and implicit byte-range offsets", () => {
  const media = parseMedia(fixture("hls-media-fmp4.m3u8"), MEDIA_URL);
  assert.deepEqual(media.init, {
    url: `${ROOT}/720/main.mp4`,
    byteRange: { length: 720, offset: 0 },
  });
  assert.deepEqual(
    media.segments.map((s) => [s.durationS, s.byteRange]),
    [
      [6, { length: 1048576, offset: 720 }],
      [6, { length: 987654, offset: 1049296 }], // implicit: right after the previous range
      [6, { length: 1011000, offset: 2036950 }],
      [2.5, { length: 200000, offset: 4000000 }],
    ],
  );
  assert.equal(
    media.segments.every((s) => s.url === `${ROOT}/720/main.mp4`),
    true,
  );
  assert.equal(media.container, "fmp4");
  assert.equal(media.endList, true);
  assert.equal(media.targetDurationS, 6);
});

test("an audio rendition's playlist: MAP without BYTERANGE, .m4s segments", () => {
  const media = parseMedia(fixture("hls-media-audio.m3u8"), MEDIA_URL);
  assert.deepEqual(media.init, { url: `${ROOT}/720/init.mp4`, byteRange: null });
  assert.deepEqual(
    media.segments.map((s) => [s.url.slice(ROOT.length), s.durationS]),
    [
      ["/720/seg-0.m4s", 4.011],
      ["/720/seg-1.m4s", 4.011],
      ["/720/seg-2.m4s", 1.978],
    ],
  );
  assert.equal(media.container, "fmp4");
  assert.equal(media.discontinuities, 0);
});

test("discontinuities: the tags and every change of MAP count, DISCONTINUITY-SEQUENCE does not", () => {
  const media = parseMedia(fixture("hls-media-discontinuity.m3u8"), MEDIA_URL);
  assert.equal(media.discontinuities, 4); // 2 tags + init-a → init-b + init-b → init-a
  assert.deepEqual(media.init, { url: `${ROOT}/720/init-a.mp4`, byteRange: null }); // the first MAP
  assert.equal(media.segments.length, 3);
  assert.equal(media.endList, true);
  const repeated = parseMedia(
    '#EXT-X-MAP:URI="i.mp4"\n#EXTINF:1,\na.m4s\n' +
      '#EXT-X-MAP:URI="i.mp4"\n#EXTINF:1,\nb.m4s\n#EXT-X-ENDLIST',
    MEDIA_URL,
  );
  assert.equal(repeated.discontinuities, 0);
  const rangeChange = parseMedia(
    '#EXT-X-MAP:URI="i.mp4",BYTERANGE="10@0"\n#EXTINF:1,\na.m4s\n' +
      '#EXT-X-MAP:URI="i.mp4",BYTERANGE="10@5"\n#EXTINF:1,\nb.m4s\n',
    MEDIA_URL,
  );
  assert.equal(rangeChange.discontinuities, 1);
});

test("a live playlist has no ENDLIST; a keyed playlist is protected unless METHOD=NONE", () => {
  const live = parseMedia(fixture("hls-media-live.m3u8"), MEDIA_URL);
  assert.equal(live.endList, false);
  assert.equal(live.segments.length, 3);
  assert.equal(live.keyProtected, false);
  const keyed = parseMedia(fixture("hls-media-keyed.m3u8"), MEDIA_URL);
  assert.equal(keyed.keyProtected, true);
  assert.equal(keyed.endList, true);
  assert.equal(keyed.segments.length, 2);
  const sampleAes = '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:1,\na.ts\n';
  assert.equal(parseMedia(sampleAes, MEDIA_URL).keyProtected, true);
  const noMethod = '#EXT-X-KEY:URI="k"\n#EXTINF:1,\na.ts\n';
  assert.equal(parseMedia(noMethod, MEDIA_URL).keyProtected, true); // no METHOD: refused
  const none = "#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\na.ts\n";
  assert.equal(parseMedia(none, MEDIA_URL).keyProtected, false);
});

test("media junk and edge cases: defaults, a bare URI, bad numbers, the container by extension", () => {
  const empty = {
    segments: [],
    init: null,
    container: "ts",
    endList: false,
    keyProtected: false,
    discontinuities: 0,
    targetDurationS: 0,
  };
  assert.deepEqual(parseMedia(NOT_TEXT, MEDIA_URL), empty);
  assert.deepEqual(parseMedia("", MEDIA_URL), empty);
  assert.deepEqual(parseMedia("#EXTM3U\n# just a comment\n", MEDIA_URL), empty);
  const bare = parseMedia("hello", MEDIA_URL);
  assert.deepEqual(bare.segments, [{ url: `${ROOT}/720/hello`, durationS: 0, byteRange: null }]);
  assert.equal(bare.endList, false);
  const bad = parseMedia(
    "#EXT-X-TARGETDURATION:x\n#EXTINF:-3,\n#EXT-X-BYTERANGE:junk\na.ts\n" +
      '#EXTINF:abc,\nb.ts\n#EXT-X-MAP:BYTERANGE="1@2"\n',
    MEDIA_URL,
  );
  assert.equal(bad.targetDurationS, 0);
  assert.deepEqual(
    bad.segments.map((s) => [s.durationS, s.byteRange]),
    [
      [0, null],
      [0, null],
    ],
  );
  assert.equal(bad.init, null); // a MAP without URI is ignored
  assert.equal(bad.container, "ts");
  assert.equal(parseMedia("#EXTINF:1,\nclip.mp4?x=1\n", MEDIA_URL).container, "fmp4");
  assert.equal(parseMedia("#EXTINF:1,\nCLIP.M4S\n", MEDIA_URL).container, "fmp4");
  assert.equal(parseMedia("#EXTINF:1,\nclip.aac\n", MEDIA_URL).container, "ts");
  // CRLF, and an implicit byte range after a segment without one: it continues from the last range
  const crlf = parseMedia(
    "#EXTM3U\r\n#EXTINF:1,\r\n#EXT-X-BYTERANGE:100@50\r\na.mp4\r\n#EXTINF:1,\r\nb.mp4\r\n" +
      "#EXTINF:1,\r\n#EXT-X-BYTERANGE:10\r\na.mp4\r\n#EXT-X-ENDLIST\r\n",
    MEDIA_URL,
  );
  assert.deepEqual(
    crlf.segments.map((s) => s.byteRange),
    [{ length: 100, offset: 50 }, null, { length: 10, offset: 150 }],
  );
  assert.equal(crlf.endList, true);
});

test("codec families and audio-only codec lists", () => {
  assert.equal(codecFamily("avc1.640028,mp4a.40.2"), "avc");
  assert.equal(codecFamily("mp4a.40.2,avc3.4d401f"), "avc");
  assert.equal(codecFamily("hvc1.1.6.L93.B0"), "hevc");
  assert.equal(codecFamily("hev1.1.6.L150.90"), "hevc");
  assert.equal(codecFamily("dvh1.05.06"), "hevc");
  assert.equal(codecFamily("AV01.0.08M.08"), "av1");
  assert.equal(codecFamily("mp4a.40.2"), "unknown");
  assert.equal(codecFamily(null), "unknown");
  assert.equal(codecFamily(""), "unknown");
  assert.equal(isAudioOnlyCodecs("mp4a.40.2"), true);
  assert.equal(isAudioOnlyCodecs("mp4a.40.2,ec-3"), true);
  assert.equal(isAudioOnlyCodecs("Opus"), true, "RFC 6381 writes it Opus");
  assert.equal(isAudioOnlyCodecs("fLaC,opus"), true);
  assert.equal(isAudioOnlyCodecs("avc1.640028,Opus"), false);
  assert.equal(isAudioOnlyCodecs("avc1.640028,mp4a.40.2"), false);
  assert.equal(isAudioOnlyCodecs(null), false);
  assert.equal(isAudioOnlyCodecs(""), false);
});

/**
 * @param {number | null} height
 * @param {string | null} codecs
 * @param {number} bandwidth
 * @param {string} [name]
 * @returns {HlsVariant}
 */
function variant(height, codecs, bandwidth, name = `${height ?? "x"}-${codecs ?? "none"}`) {
  return {
    url: `https://cdn.example-dm.test/${name}.m3u8`,
    bandwidth,
    width: height === null ? null : Math.round((height * 16) / 9),
    height,
    frameRate: 25,
    codecs,
    name,
    audioGroup: null,
  };
}

const AVC = "avc1.640028,mp4a.40.2";
const HEVC = "hvc1.1.6.L120.90,mp4a.40.2";
/** @type {Record<string, HlsVariant[]>} */
const SETS = {
  avcOnly: [
    variant(1080, AVC, 5000000),
    variant(720, AVC, 2500000),
    variant(480, AVC, 1200000),
    variant(360, AVC, 800000),
  ],
  hevcOnly: [variant(1080, HEVC, 3500000), variant(720, HEVC, 1900000), variant(480, HEVC, 900000)],
  mixedHevcLower: [
    variant(1080, AVC, 5000000),
    variant(1080, HEVC, 3500000),
    variant(720, AVC, 2500000),
    variant(720, HEVC, 1900000),
    variant(480, AVC, 1200000),
  ],
  mixedHevcHigher: [
    variant(1080, AVC, 5000000),
    variant(1080, HEVC, 6000000),
    variant(720, AVC, 2500000),
    variant(720, HEVC, 3000000),
    variant(480, AVC, 1200000),
    variant(480, HEVC, 1400000),
  ],
};
/**
 * set, cap, mode → the expected height and codec family.
 * @type {[string, number | null, "compatible" | "best", number, "avc" | "hevc"][]}
 */
const MATRIX = [
  ["avcOnly", 1080, "compatible", 1080, "avc"],
  ["avcOnly", 1080, "best", 1080, "avc"],
  ["avcOnly", 720, "compatible", 720, "avc"],
  ["avcOnly", 720, "best", 720, "avc"],
  ["avcOnly", 480, "compatible", 480, "avc"],
  ["avcOnly", 480, "best", 480, "avc"],
  ["avcOnly", null, "compatible", 1080, "avc"],
  ["avcOnly", null, "best", 1080, "avc"],
  ["hevcOnly", 1080, "compatible", 1080, "hevc"], // no avc1 at all: hevc it is
  ["hevcOnly", 1080, "best", 1080, "hevc"],
  ["hevcOnly", 720, "compatible", 720, "hevc"],
  ["hevcOnly", 720, "best", 720, "hevc"],
  ["hevcOnly", 480, "compatible", 480, "hevc"],
  ["hevcOnly", 480, "best", 480, "hevc"],
  ["hevcOnly", null, "compatible", 1080, "hevc"],
  ["hevcOnly", null, "best", 1080, "hevc"],
  ["mixedHevcLower", 1080, "compatible", 1080, "avc"],
  ["mixedHevcLower", 1080, "best", 1080, "avc"], // avc has the higher bandwidth here
  ["mixedHevcLower", 720, "compatible", 720, "avc"],
  ["mixedHevcLower", 720, "best", 720, "avc"],
  ["mixedHevcLower", 480, "compatible", 480, "avc"],
  ["mixedHevcLower", 480, "best", 480, "avc"],
  ["mixedHevcLower", null, "compatible", 1080, "avc"],
  ["mixedHevcLower", null, "best", 1080, "avc"],
  ["mixedHevcHigher", 1080, "compatible", 1080, "avc"], // compatible: avc1 even at less bandwidth
  ["mixedHevcHigher", 1080, "best", 1080, "hevc"], // best takes the bandwidth
  ["mixedHevcHigher", 720, "compatible", 720, "avc"],
  ["mixedHevcHigher", 720, "best", 720, "hevc"],
  ["mixedHevcHigher", 480, "compatible", 480, "avc"],
  ["mixedHevcHigher", 480, "best", 480, "hevc"],
  ["mixedHevcHigher", null, "compatible", 1080, "avc"],
  ["mixedHevcHigher", null, "best", 1080, "hevc"],
];

test("the selection matrix: caps 1080/720/480/best × compatible/best × avc-only/hevc-only/mixed", () => {
  for (const [set, maxHeight, codec, height, family] of MATRIX) {
    const chosen = chooseVariant(/** @type {HlsVariant[]} */ (SETS[set]), { maxHeight, codec });
    assert.ok(chosen, `${set} ${maxHeight} ${codec}`);
    assert.equal(chosen.height, height, `${set} ${maxHeight} ${codec}: height`);
    assert.equal(codecFamily(chosen.codecs), family, `${set} ${maxHeight} ${codec}: codec`);
  }
});

test("selection edge cases: a cap below every height, unknown heights, audio-only and URL-less variants, ties", () => {
  /** @type {{ maxHeight: null, codec: "best" }} */
  const best = { maxHeight: null, codec: "best" };
  const noList = /** @type {HlsVariant[]} */ (/** @type {unknown} */ (null));
  assert.equal(chooseVariant([], best), null);
  assert.equal(chooseVariant(noList, best), null);
  // every variant is taller than the cap: the lowest one, not nothing
  const avcOnly = /** @type {HlsVariant[]} */ (SETS["avcOnly"]);
  assert.equal(chooseVariant(avcOnly, { maxHeight: 240, codec: "best" })?.height, 360);
  // no RESOLUTION anywhere: the highest bandwidth
  const unknown = [variant(null, AVC, 1000), variant(null, AVC, 3000), variant(null, AVC, 2000)];
  assert.equal(chooseVariant(unknown, { maxHeight: 720, codec: "compatible" })?.bandwidth, 3000);
  // a variant without RESOLUTION loses to any with one, even at a higher bandwidth
  const halfKnown = [variant(null, AVC, 9000000), variant(480, AVC, 1000)];
  assert.equal(chooseVariant(halfKnown, best)?.height, 480);
  // audio-only variants are never the video; a variant without a URL is skipped
  const audioOnly = variant(null, "mp4a.40.2", 128000);
  assert.equal(chooseVariant([audioOnly], best), null);
  const noUrl = { ...variant(1080, AVC, 9000000), url: "" };
  assert.equal(chooseVariant([noUrl, variant(720, AVC, 2500000), audioOnly], best)?.height, 720);
  // equal bandwidths keep the playlist's order
  const tie = [variant(720, AVC, 2500000, "first"), variant(720, AVC, 2500000, "second")];
  assert.equal(chooseVariant(tie, best)?.name, "first");
  // at a height offered only in hevc under a cap, compatible takes it (the cap wins over the codec)
  const only = [
    variant(1080, AVC, 5000000),
    variant(720, HEVC, 1900000),
    variant(480, AVC, 1200000),
  ];
  const under720 = chooseVariant(only, { maxHeight: 720, codec: "compatible" });
  assert.equal(codecFamily(under720?.codecs), "hevc");
});

test("compatible prefers avc, then hevc, then av1 at the chosen height; best takes the bandwidth (B.1)", () => {
  const AV1 = "av01.0.08M.08,mp4a.40.2";
  const noAvc = [variant(1080, AV1, 6000000), variant(1080, HEVC, 4000000), variant(720, AVC, 9000000)];
  const compatible = chooseVariant(noAvc, { maxHeight: null, codec: "compatible" });
  assert.equal(compatible?.height, 1080, "the resolution is never lowered to get H.264");
  assert.equal(codecFamily(compatible?.codecs), "hevc", "hevc before av1");
  const best = chooseVariant(noAvc, { maxHeight: null, codec: "best" });
  assert.equal(codecFamily(best?.codecs), "av1", "best: the highest bandwidth at that height");
  const all = [...noAvc, variant(1080, AVC, 3000000)];
  assert.equal(codecFamily(chooseVariant(all, { maxHeight: null, codec: "compatible" })?.codecs), "avc");
  const av1Only = [variant(1080, AV1, 6000000), variant(720, HEVC, 9000000)];
  assert.equal(codecFamily(chooseVariant(av1Only, { maxHeight: null, codec: "compatible" })?.codecs), "av1");
});

test("the audio rendition: DEFAULT first, else the first with a URI, null when muxed", () => {
  /** @type {HlsRendition[]} */
  const renditions = [
    {
      groupId: "aac",
      name: "Español",
      url: "https://cdn.example-dm.test/es.m3u8",
      isDefault: false,
      language: "es",
    },
    {
      groupId: "aac",
      name: "English",
      url: "https://cdn.example-dm.test/en.m3u8",
      isDefault: true,
      language: "en",
    },
    { groupId: "muxed", name: "Stereo", url: null, isDefault: true, language: null },
    { groupId: "mixed", name: "Described", url: null, isDefault: true, language: "en" },
    {
      groupId: "mixed",
      name: "Plain",
      url: "https://cdn.example-dm.test/plain.m3u8",
      isDefault: false,
      language: "en",
    },
  ];
  const withGroup = { ...variant(720, "avc1.64001f", 2500000), audioGroup: "aac" };
  assert.equal(pickAudio(withGroup, renditions)?.name, "English");
  // the DEFAULT of "mixed" has no URI: the first with one
  assert.equal(pickAudio({ ...withGroup, audioGroup: "mixed" }, renditions)?.name, "Plain");
  assert.equal(pickAudio({ ...withGroup, audioGroup: "muxed" }, renditions), null);
  assert.equal(pickAudio({ ...withGroup, audioGroup: "nope" }, renditions), null);
  // no AUDIO attribute: muxed
  assert.equal(pickAudio(variant(720, AVC, 2500000), renditions), null);
  assert.equal(pickAudio(withGroup, []), null);
  const noDefault = renditions
    .filter((r) => r.groupId === "aac")
    .map((r) => ({ ...r, isDefault: false }));
  assert.equal(pickAudio(withGroup, noDefault)?.name, "Español");
  // over the fixture: the 1080 variant plays with the English rendition
  const master = parseMaster(fixture("hls-master-fmp4.m3u8"), MASTER_URL);
  const chosen = chooseVariant(master.variants, { maxHeight: null, codec: "compatible" });
  assert.equal(chosen?.name, "1080");
  assert.equal(
    pickAudio(/** @type {HlsVariant} */ (chosen), master.audioRenditions)?.url,
    `${ROOT}/audio/en/manifest.m3u8`,
  );
  const muxed = chooseVariant(master.variants, { maxHeight: 480, codec: "compatible" });
  assert.equal(pickAudio(/** @type {HlsVariant} */ (muxed), master.audioRenditions), null);
});
