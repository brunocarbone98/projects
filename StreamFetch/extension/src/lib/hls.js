// @ts-check
/**
 * HLS playlists (RFC 8216) as Dailymotion serves them: the master playlist that lists the
 * variants (`#EXT-X-STREAM-INF`) and audio renditions (`#EXT-X-MEDIA`), and the media playlist
 * that lists the segments (`#EXTINF`), their byte ranges, the initialization section of an fMP4
 * stream (`#EXT-X-MAP`), encryption (`#EXT-X-KEY`), discontinuities and the end marker. Pure text
 * in, plain objects out: no `chrome.*`, no DOM, no network, never a throw on junk (a text that is
 * not a playlist parses to an empty master or an empty media playlist).
 *
 * Facts (yt-dlp 2026.10.26 `_parse_m3u8_formats_and_subtitles` and `downloader/hls.py`, read
 * 2026-11-08): a media playlist carries `#EXT-X-TARGETDURATION` and a master never does;
 * Dailymotion names its variants with a `NAME="1080"` attribute next to `BANDWIDTH`,
 * `RESOLUTION`, `CODECS` and sometimes `FRAME-RATE`; attribute values may be quoted and a quoted
 * value may contain commas (`CODECS="avc1.640028,mp4a.40.2"`); a segment container is MPEG-TS or
 * fMP4 (`#EXT-X-MAP`); an
 * `#EXT-X-BYTERANGE` without an offset starts where the previous byte range ended; a media
 * playlist without `#EXT-X-ENDLIST` is live. StreamFetch never decrypts: any `#EXT-X-KEY` whose
 * METHOD is not `NONE` marks the playlist key-protected and the downloader refuses it before any
 * media request.
 */

/**
 * @typedef {object} HlsVariant One `#EXT-X-STREAM-INF` entry of a master playlist.
 * @property {string} url the media playlist, resolved against the master's URL
 * @property {number} bandwidth `BANDWIDTH` (else `AVERAGE-BANDWIDTH`), bits per second; 0 unknown
 * @property {number | null} width from `RESOLUTION`
 * @property {number | null} height from `RESOLUTION`
 * @property {number | null} frameRate `FRAME-RATE`
 * @property {string | null} codecs the `CODECS` attribute as written
 * @property {string | null} name the `NAME` attribute (Dailymotion: "1080", "720", …)
 * @property {string | null} audioGroup the `AUDIO` rendition group this variant plays with
 *
 * @typedef {object} HlsRendition One `#EXT-X-MEDIA:TYPE=AUDIO` entry.
 * @property {string} groupId `GROUP-ID`
 * @property {string} name `NAME`
 * @property {string | null} url `URI` resolved against the master's URL; null when the audio is
 *   muxed into the variant's own segments
 * @property {boolean} isDefault `DEFAULT=YES`
 * @property {string | null} language `LANGUAGE`
 *
 * @typedef {object} HlsByteRange A sub-range of a media file (`#EXT-X-BYTERANGE`, `BYTERANGE=`).
 * @property {number} length bytes
 * @property {number} offset first byte
 *
 * @typedef {object} HlsSegment One media segment.
 * @property {string} url resolved against the media playlist's URL
 * @property {number} durationS from `#EXTINF`; 0 when the tag is missing
 * @property {HlsByteRange | null} byteRange
 *
 * @typedef {object} HlsInit The initialization section of an fMP4 media playlist (`#EXT-X-MAP`).
 * @property {string} url
 * @property {HlsByteRange | null} byteRange
 *
 * @typedef {object} HlsMedia What a media playlist says.
 * @property {HlsSegment[]} segments in playlist order
 * @property {HlsInit | null} init the first `#EXT-X-MAP`
 * @property {"ts" | "fmp4"} container `fmp4` when a MAP exists or the first segment's path ends in
 *   `.m4s` / `.mp4`, else `ts`
 * @property {boolean} endList whether `#EXT-X-ENDLIST` is present (false → live, refused)
 * @property {boolean} keyProtected any `#EXT-X-KEY` with a METHOD other than NONE (or none given)
 * @property {number} discontinuities `#EXT-X-DISCONTINUITY` tags, plus every `#EXT-X-MAP` that
 *   changes the initialization section mid-stream (the fMP4 path assumes one init)
 * @property {number} targetDurationS `#EXT-X-TARGETDURATION`; 0 when missing
 *
 * @typedef {"avc" | "hevc" | "av1" | "unknown"} CodecFamily
 */

/** Line breaks of every flavour; a stray `\r` is stripped from each line as well. */
const LINE_BREAK_RE = /\r\n|\r|\n/;
/** `#EXT-X-STREAM-INF` tags belong to a master playlist only (RFC 8216 §4.3.4). */
const STREAM_INF_RE = /^#EXT-X-STREAM-INF\b/m;
/** `#EXTINF` and `#EXT-X-TARGETDURATION` belong to a media playlist only (§4.3.3, §4.3.2). */
const MEDIA_TAG_RE = /^#EXT(?:INF|-X-TARGETDURATION)\b/m;
/** A media segment is `fmp4` by its file extension when there is no `#EXT-X-MAP`. */
const FMP4_PATH_RE = /\.(?:m4s|mp4)$/i;
/** The four-character codes of the video codecs this version knows, lower-case. */
const VIDEO_CODEC_FAMILIES = /** @type {Record<string, CodecFamily>} */ ({
  avc1: "avc",
  avc3: "avc",
  hvc1: "hevc",
  hev1: "hevc",
  dvh1: "hevc",
  dvhe: "hevc",
  av01: "av1",
});
/** Codecs that carry audio only (a `CODECS` list made solely of these names no video variant). */
const AUDIO_ONLY_CODECS = new Set(["mp4a", "ec-3", "ac-3", "flac", "mp3", "aac"]);

/**
 * The lines of a playlist, trailing `\r` and surrounding whitespace removed, empty lines kept
 * (callers skip them) so that line numbers stay meaningful.
 * @param {string} text
 * @returns {string[]}
 */
function linesOf(text) {
  return text.split(LINE_BREAK_RE).map((line) => line.trim());
}

/**
 * The attribute list of a tag (`KEY=VALUE,KEY="quoted, value"`): keys upper-cased, quotes removed,
 * a quoted value kept whole even when it contains commas. Junk between attributes is skipped; a
 * key without `=` is ignored. Never throws.
 * @param {string} text the part after the tag's colon
 * @returns {Record<string, string>}
 */
export function parseAttributes(text) {
  /** @type {Record<string, string>} */
  const attributes = {};
  let index = 0;
  const length = text.length;
  while (index < length) {
    // skip separators and whitespace
    while (index < length && (text[index] === "," || text[index] === " " || text[index] === "\t")) {
      index += 1;
    }
    const keyStart = index;
    while (index < length && text[index] !== "=" && text[index] !== ",") index += 1;
    const key = text.slice(keyStart, index).trim().toUpperCase();
    if (index >= length || text[index] === ",") continue; // a bare word without a value
    index += 1; // the "="
    let value;
    if (text[index] === '"') {
      const close = text.indexOf('"', index + 1);
      if (close === -1) {
        value = text.slice(index + 1);
        index = length;
      } else {
        value = text.slice(index + 1, close);
        index = close + 1;
      }
    } else {
      const comma = text.indexOf(",", index);
      value = text.slice(index, comma === -1 ? length : comma).trim();
      index = comma === -1 ? length : comma;
    }
    if (key) attributes[key] = value;
  }
  return attributes;
}

/**
 * `uri` resolved against `base` the way a player does, its fragment dropped (Dailymotion appends
 * `#cell=core`; a fragment is never sent, yt-dlp strips it too). A URI that cannot be resolved (no
 * usable base) is returned as written, fragment aside.
 * @param {string} uri
 * @param {string | null | undefined} base
 * @returns {string}
 */
export function resolveUrl(uri, base) {
  try {
    const url = new URL(uri, base || undefined);
    url.hash = "";
    return url.href;
  } catch {
    return uri.split("#")[0] ?? uri;
  }
}

/**
 * A finite number parsed from an attribute, else null.
 * @param {string | undefined} text
 * @returns {number | null}
 */
function numberOf(text) {
  if (text === undefined || text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * A non-negative integer parsed from an attribute, else null.
 * @param {string | undefined} text
 * @returns {number | null}
 */
function integerOf(text) {
  const value = numberOf(text);
  return value !== null && value >= 0 ? Math.floor(value) : null;
}

/**
 * `WxH` (`RESOLUTION`) → width and height, else nulls.
 * @param {string | undefined} text
 * @returns {{ width: number | null, height: number | null }}
 */
function resolutionOf(text) {
  const match = text === undefined ? null : /^\s*(\d+)\s*[xX]\s*(\d+)\s*$/.exec(text);
  if (match === null) return { width: null, height: null };
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * `n@o` or `n` (`#EXT-X-BYTERANGE`, `BYTERANGE=`) → a byte range; the offset defaults to
 * `implicitOffset` (the end of the previous range) when `@o` is absent. Null for junk.
 * @param {string} text
 * @param {number} implicitOffset
 * @returns {HlsByteRange | null}
 */
function byteRangeOf(text, implicitOffset) {
  const match = /^\s*(\d+)(?:@(\d+))?\s*$/.exec(text);
  if (match === null) return null;
  const length = Number(match[1]);
  const offset = match[2] === undefined ? implicitOffset : Number(match[2]);
  if (!Number.isSafeInteger(length) || !Number.isSafeInteger(offset)) return null;
  return { length, offset };
}

/**
 * Whether `text` is a master playlist: it lists variants (`#EXT-X-STREAM-INF`) and carries no
 * media-playlist tag (`#EXTINF`, `#EXT-X-TARGETDURATION`), which RFC 8216 forbids in a master.
 * @param {string} text
 * @returns {boolean}
 */
export function isMaster(text) {
  if (typeof text !== "string") return false;
  return STREAM_INF_RE.test(text) && !MEDIA_TAG_RE.test(text);
}

/**
 * The variants and audio renditions of a master playlist. Relative URIs are resolved against
 * `baseUrl` (the master's own URL). `#EXT-X-MEDIA` entries of a TYPE other than AUDIO, and
 * `#EXT-X-I-FRAME-STREAM-INF` entries, are ignored. An `#EXT-X-STREAM-INF` whose URI line is
 * missing is dropped. Junk parses to empty lists.
 * @param {string} text
 * @param {string | null} [baseUrl]
 * @returns {{ variants: HlsVariant[], audioRenditions: HlsRendition[] }}
 */
export function parseMaster(text, baseUrl = null) {
  /** @type {HlsVariant[]} */
  const variants = [];
  /** @type {HlsRendition[]} */
  const audioRenditions = [];
  if (typeof text !== "string") return { variants, audioRenditions };
  /** @type {Record<string, string> | null} */
  let pending = null;
  for (const line of linesOf(text)) {
    if (line === "") continue;
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const media = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
      const groupId = media["GROUP-ID"];
      const name = media["NAME"];
      if (media["TYPE"] !== "AUDIO" || !groupId || !name) continue;
      audioRenditions.push({
        groupId,
        name,
        url: media["URI"] ? resolveUrl(media["URI"], baseUrl) : null,
        isDefault: media["DEFAULT"] === "YES",
        language: media["LANGUAGE"] || null,
      });
      continue;
    }
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pending = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      continue;
    }
    if (line.startsWith("#")) continue; // another tag or a comment
    if (pending === null) continue; // a URI without its #EXT-X-STREAM-INF
    const { width, height } = resolutionOf(pending["RESOLUTION"]);
    variants.push({
      url: resolveUrl(line, baseUrl),
      bandwidth: integerOf(pending["BANDWIDTH"]) ?? integerOf(pending["AVERAGE-BANDWIDTH"]) ?? 0,
      width,
      height,
      frameRate: numberOf(pending["FRAME-RATE"]),
      codecs: pending["CODECS"] || null,
      name: pending["NAME"] || null,
      audioGroup: pending["AUDIO"] || null,
    });
    pending = null;
  }
  return { variants, audioRenditions };
}

/**
 * The segments and properties of a media playlist. `#EXTINF` gives the next segment's duration,
 * `#EXT-X-BYTERANGE` its byte range (an omitted offset continues the previous range),
 * `#EXT-X-MAP` the initialization section (`URI`, optional `BYTERANGE`), `#EXT-X-KEY` the
 * protection (`METHOD=NONE` is none), `#EXT-X-DISCONTINUITY` is counted, `#EXT-X-ENDLIST` ends a
 * VOD playlist. Relative URIs are resolved against `baseUrl`. Junk parses to no segments, no end
 * marker (the resolver then refuses it as live), container `ts`.
 * @param {string} text
 * @param {string | null} [baseUrl]
 * @returns {HlsMedia}
 */
export function parseMedia(text, baseUrl = null) {
  /** @type {HlsMedia} */
  const media = {
    segments: [],
    init: null,
    container: "ts",
    endList: false,
    keyProtected: false,
    discontinuities: 0,
    targetDurationS: 0,
  };
  if (typeof text !== "string") return media;
  let pendingDuration = 0;
  /** @type {HlsByteRange | null} */
  let pendingRange = null;
  let nextOffset = 0;
  /** @type {HlsInit | null} */
  let lastInit = null;
  for (const line of linesOf(text)) {
    if (line === "") continue;
    if (line.startsWith("#EXTINF:")) {
      const duration = numberOf(line.slice("#EXTINF:".length).split(",")[0]);
      pendingDuration = duration !== null && duration > 0 ? duration : 0;
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = byteRangeOf(line.slice("#EXT-X-BYTERANGE:".length), nextOffset);
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const map = parseAttributes(line.slice("#EXT-X-MAP:".length));
      if (!map["URI"]) continue;
      /** @type {HlsInit} */
      const init = {
        url: resolveUrl(map["URI"], baseUrl),
        byteRange: map["BYTERANGE"] ? byteRangeOf(map["BYTERANGE"], 0) : null,
      };
      if (media.init === null) media.init = init;
      else if (lastInit !== null && !sameInit(lastInit, init)) media.discontinuities += 1;
      lastInit = init; // a change of initialization section counts: one init per download
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const key = parseAttributes(line.slice("#EXT-X-KEY:".length));
      if (key["METHOD"] !== "NONE") media.keyProtected = true;
    } else if (
      line.startsWith("#EXT-X-DISCONTINUITY") &&
      !line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE")
    ) {
      media.discontinuities += 1;
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      media.endList = true;
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      media.targetDurationS = integerOf(line.slice("#EXT-X-TARGETDURATION:".length)) ?? 0;
    } else if (line.startsWith("#")) {
      // another tag or a comment
    } else {
      media.segments.push({
        url: resolveUrl(line, baseUrl),
        durationS: pendingDuration,
        byteRange: pendingRange,
      });
      if (pendingRange !== null) nextOffset = pendingRange.offset + pendingRange.length;
      pendingDuration = 0;
      pendingRange = null;
    }
  }
  const first = media.segments[0];
  if (media.init !== null || (first !== undefined && FMP4_PATH_RE.test(pathOf(first.url)))) {
    media.container = "fmp4";
  }
  return media;
}

/**
 * Whether two `#EXT-X-MAP` tags name the same initialization section.
 * @param {HlsInit} a
 * @param {HlsInit} b
 * @returns {boolean}
 */
function sameInit(a, b) {
  if (a.url !== b.url) return false;
  if (a.byteRange === null || b.byteRange === null) return a.byteRange === b.byteRange;
  return a.byteRange.length === b.byteRange.length && a.byteRange.offset === b.byteRange.offset;
}

/**
 * The path of a URL without its query and fragment (the file extension decides the container).
 * @param {string} url
 * @returns {string}
 */
function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

/**
 * The video codec family a `CODECS` attribute (HLS: a comma-separated list; DASH: one codec)
 * names: `avc1`/`avc3` → `avc`, `hvc1`/`hev1` (and Dolby Vision's `dvh1`/`dvhe`) → `hevc`,
 * `av01` → `av1`, anything else (audio-only lists included) → `unknown`.
 * @param {string | null | undefined} codecs
 * @returns {CodecFamily}
 */
export function codecFamily(codecs) {
  if (typeof codecs !== "string") return "unknown";
  for (const entry of codecs.split(",")) {
    const fourcc = entry.trim().split(".")[0]?.toLowerCase() ?? "";
    const family = VIDEO_CODEC_FAMILIES[fourcc];
    if (family !== undefined) return family;
  }
  return "unknown";
}

/**
 * Whether a `CODECS` attribute names audio codecs only (an audio-only variant, never chosen as
 * the video). A missing attribute is not audio-only.
 * @param {string | null | undefined} codecs
 * @returns {boolean}
 */
export function isAudioOnlyCodecs(codecs) {
  if (typeof codecs !== "string" || codecs.trim() === "") return false;
  return codecs.split(",").every((entry) => {
    const fourcc = entry.trim().split(".")[0]?.toLowerCase() ?? "";
    return AUDIO_ONLY_CODECS.has(fourcc);
  });
}

/**
 * The variant to download: the highest height not above `maxHeight` (no cap when null), and
 * among the variants at that height the highest bandwidth; in `compatible` mode the `avc1`
 * variants at that height win when the height is offered in several codecs (every Windows Chrome
 * plays H.264; HEVC and AV1 depend on the machine). When every variant is taller than the cap, the
 * lowest height is taken (the cap is a preference, not a reason to fail). Variants without a
 * RESOLUTION rank below every variant with one and are chosen only when nothing else exists (by
 * bandwidth); audio-only variants are never chosen. Null for an empty list.
 * @param {HlsVariant[]} variants
 * @param {{ maxHeight: number | null, codec: "compatible" | "best" }} preferences
 * @returns {HlsVariant | null}
 */
export function chooseVariant(variants, preferences) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const videoVariants = variants.filter(
    (variant) =>
      typeof variant.url === "string" && variant.url !== "" && !isAudioOnlyCodecs(variant.codecs),
  );
  const known = videoVariants.filter((variant) => variant.height !== null && variant.height > 0);
  if (known.length === 0) {
    const unknown = videoVariants.length > 0 ? videoVariants : [];
    return unknown.length === 0 ? null : (byBandwidth(unknown)[0] ?? null);
  }
  const cap = preferences.maxHeight;
  const heights = known.map((variant) => /** @type {number} */ (variant.height));
  const fitting = cap === null ? heights : heights.filter((height) => height <= cap);
  const chosenHeight = fitting.length > 0 ? Math.max(...fitting) : Math.min(...heights);
  let atHeight = known.filter((variant) => variant.height === chosenHeight);
  if (preferences.codec === "compatible") {
    const avc = atHeight.filter((variant) => codecFamily(variant.codecs) === "avc");
    if (avc.length > 0) atHeight = avc;
  }
  return byBandwidth(atHeight)[0] ?? null;
}

/**
 * `variants` sorted by bandwidth, highest first; equal bandwidths keep the playlist's order.
 * @param {HlsVariant[]} variants
 * @returns {HlsVariant[]}
 */
function byBandwidth(variants) {
  return variants
    .map((variant, index) => ({ variant, index }))
    .sort((a, b) => b.variant.bandwidth - a.variant.bandwidth || a.index - b.index)
    .map((entry) => entry.variant);
}

/**
 * The audio rendition to download next to `variant`: the DEFAULT rendition of the variant's
 * `AUDIO` group, else the group's first rendition that has a URI. Null when the variant names no
 * audio group or when no rendition of the group has a URI — the audio is then muxed into the
 * variant's own segments.
 * @param {HlsVariant} variant
 * @param {HlsRendition[]} renditions
 * @returns {HlsRendition | null}
 */
export function pickAudio(variant, renditions) {
  if (!variant || variant.audioGroup === null || !Array.isArray(renditions)) return null;
  const group = renditions.filter(
    (rendition) =>
      rendition.groupId === variant.audioGroup &&
      typeof rendition.url === "string" &&
      rendition.url !== "",
  );
  if (group.length === 0) return null;
  return group.find((rendition) => rendition.isDefault) ?? group[0] ?? null;
}
