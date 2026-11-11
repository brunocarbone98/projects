// @ts-check
/**
 * From a pasted link to the downloadable targets: the site's own documents read the way the
 * user's browser receives them — Dailymotion's player metadata JSON, its HLS master and media
 * playlists; Bilibili's video page (`__INITIAL_STATE__`, `__playinfo__`), one page per part, a
 * `b23.tv` short link followed to its page; Bilibili.tv's page and its playurl API (and, for a
 * series, `season_info` and `episodes`) — every request one at a time, paced, with the session's
 * own cookies (`credentials: "include"`), recorded as an `Attempt` for the report. The lib parsers
 * (`lib/dailymotion.js`, `lib/hls.js`, `lib/bilibili.js`, `lib/bilibilitv.js`) decide; this module
 * only asks and maps their answers to targets or failures.
 *
 * Nothing here computes or replays a request signature: the URLs requested are the ones the
 * documents carry (Bilibili's playurl answer is the one the page itself embeds).
 */

import * as btv from "../lib/bilibilitv.js";
import {
  canonicalId,
  chooseStreams,
  extractEmbeddedJson,
  pageUrl as biliPageUrl,
  parsePage,
} from "../lib/bilibili.js";
import { metadataUrl, pageUrl as dmPageUrl, parseMetadata } from "../lib/dailymotion.js";
import {
  chooseVariant,
  isAudioOnlyCodecs,
  isMaster,
  parseMaster,
  parseMedia,
  pickAudio,
} from "../lib/hls.js";
import { hostOf, isRecord, safeParse } from "../lib/json.js";
import {
  FAILED,
  FAILED_UNAVAILABLE,
  STOPPED,
  failure,
  isFailureCode,
  statusForFailure,
} from "../lib/messages.js";
import { B23_PREFIX, isRefused, parseLine } from "../lib/urls.js";
import { StepFailure, fetchText, isStop, keyMethodOf, mediaProblem } from "./downloader.js";

/**
 * @typedef {"dailymotion" | "bilibili" | "bilibilitv"} SiteName
 *
 * @typedef {object} ResolveItem One pasted video, episode or series (`lib/urls.js` `Item`).
 * @property {string} key
 * @property {SiteName} site
 * @property {string} kind `video`, `episode` (Bilibili.tv) or `series` (Bilibili.tv)
 * @property {string} id the Dailymotion xid, the Bilibili bvid / `av…` / `b23:<code>`, the
 *   Bilibili.tv aid, ep_id or season_id — always a string (16-digit aids exceed 2^53)
 * @property {number | null} part
 * @property {string | null} [seasonId] a Bilibili.tv episode's season (a series' own id)
 * @property {true} [playlistIgnored] a Dailymotion video link that also named a playlist: only
 *   the video is downloaded and the row says so (Addendum A.8)
 * @property {string | null} shortLink
 * @property {string} pageUrl
 * @property {string} original
 *
 * @typedef {object} Bases Where each site lives: the real origins, or the fake sites in test mode.
 * @property {string} dailymotion
 * @property {string} bilibili
 * @property {string} b23
 * @property {string} bilibilitv
 * @property {string} bilibilitvApi
 *
 * @typedef {import("../lib/hls.js").HlsVariant} HlsVariant
 * @typedef {import("../lib/hls.js").HlsRendition} HlsRendition
 * @typedef {import("../lib/hls.js").HlsMedia} HlsMedia
 * @typedef {import("../lib/bilibili.js").DashRep} DashRep
 * @typedef {import("../lib/messages.js").Failure} Failure
 * @typedef {import("../lib/messages.js").Status} Status
 * @typedef {import("../lib/report.js").Attempt} Attempt
 * @typedef {import("../lib/report.js").PageInput} PageInput
 *
 * @typedef {{ kind: "hls", master: string, variant: HlsVariant, audio: HlsRendition | null,
 *   available: HlsVariant[], audioRenditions: HlsRendition[] }} HlsChoice
 * @typedef {{ kind: "dash", video: DashRep, audio: DashRep | null, available: DashRep[],
 *   audioAvailable: DashRep[], missingPremium: string[] }} DashChoice
 * @typedef {HlsChoice | DashChoice} StreamChoice
 *
 * @typedef {object} HlsRaw What a Dailymotion target keeps of what was served.
 * @property {unknown} metadata the metadata JSON as served
 * @property {HlsMedia | null} media the chosen variant's media playlist
 * @property {string | null} mediaUrl
 * @property {HlsMedia | null} audioMedia the audio rendition's media playlist, when separate
 * @property {string | null} audioMediaUrl
 * @property {string | null} keyMethod the `METHOD` of a protecting `#EXT-X-KEY`
 *
 * @typedef {object} Hint Something the row says next to a resolved target (not a failure).
 * @property {"premium" | "playlist_ignored"} code
 * @property {Record<string, unknown>} params
 *
 * @typedef {object} Target One downloadable unit: a Dailymotion video, one Bilibili part, one
 *   Bilibili.tv video or episode (the spec's `Target`, plus what the page and the report show).
 * @property {string} key unique in a run: the item's key, plus the part or the episode
 * @property {string} itemKey the canonical key of the item it came from (a resolved short link's)
 * @property {string} input the pasted line
 * @property {SiteName} site
 * @property {string} id
 * @property {number | null} part a Bilibili part or a series episode's position (1-based)
 * @property {number | null} partCount how many parts the video has (Bilibili)
 * @property {string | null} cid
 * @property {string} pageUrl
 * @property {string} title
 * @property {string | null} partTitle a part's or an episode's own title
 * @property {string | null} seasonId Bilibili.tv
 * @property {string | null} episodeId Bilibili.tv
 * @property {string | null} seriesTitle Bilibili.tv: the series' title when known
 * @property {number | null} durationS
 * @property {string | null} cover
 * @property {string | null} uploader
 * @property {StreamChoice | null} streams null only for a target that could not be resolved
 * @property {unknown} raw the metadata as served (for the report)
 * @property {Hint[]} hints
 * @property {Attempt[]} attempts the requests that resolved it
 * @property {PageInput | null} page the page or metadata request
 * @property {Failure | null} failure set when this target cannot be downloaded (a part the site
 *   refuses, an episode not reached before a stop): the engine records it without a request
 * @property {Status | null} status the status of that failure
 *
 * @typedef {object} ResolveFailure The whole item failed before any target was known.
 * @property {false} ok
 * @property {ResolveItem} item
 * @property {Failure} failure
 * @property {Status} status
 * @property {Attempt[]} attempts
 * @property {PageInput | null} page
 * @property {unknown} raw
 * @property {string | null} title
 *
 * @typedef {object} ResolveContext
 * @property {import("./downloader.js").NetContext} net the network rules of the run
 * @property {{ maxHeight: number | null, codec: "compatible" | "best" }} prefs
 * @property {Bases} bases
 * @property {() => Promise<void>} pagePause the pause between two page requests
 * @property {(text: string) => void} [log] what the resolver is doing (for the UI)
 *
 * @typedef {{ ok: true, streams: StreamChoice, raw: unknown } |
 *   { ok: false, failure: Failure, status: Status }} RefreshResult
 */

/** The real origins. */
export const PRODUCTION_BASES = Object.freeze(
  /** @type {Bases} */ ({
    dailymotion: "https://www.dailymotion.com",
    bilibili: "https://www.bilibili.com",
    b23: "https://b23.tv",
    bilibilitv: "https://www.bilibili.tv",
    bilibilitvApi: "https://api.bilibili.tv",
  }),
);

/** The hint of a Dailymotion link that also named a playlist (Addendum A.8). */
const PLAYLIST_IGNORED = Object.freeze(
  /** @type {Hint} */ ({ code: "playlist_ignored", params: Object.freeze({}) }),
);

/** The most episodes one series link may add to a run (Addendum A.2). */
export const MAX_SERIES_EPISODES = 200;
/** The largest page, playlist or JSON answer read (a bigger one is cut off: not a video page). */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

/**
 * The bases of a run: the real origins, each replaced by its test base in test mode.
 * @param {Partial<Bases> | undefined} test
 * @returns {Bases}
 */
export function basesFor(test) {
  return { ...PRODUCTION_BASES, ...(test ?? {}) };
}

/**
 * Whether `resolve` answered a failure of the whole item.
 * @param {Target[] | ResolveFailure} resolved
 * @returns {resolved is ResolveFailure}
 */
export function isResolveFailure(resolved) {
  return !Array.isArray(resolved);
}

/**
 * A copy of a failure with its status (`lib/messages.statusForFailure`, or the one given).
 * @param {Failure} fail
 * @param {Status} [status]
 * @returns {{ failure: Failure, status: Status }}
 */
function withStatus(fail, status) {
  return { failure: fail, status: status ?? statusForFailure(fail.code) };
}

/**
 * The failure a step threw, or null when it is not a step's (a stop, a bug): those are rethrown.
 * @param {unknown} error
 * @returns {StepFailure}
 */
function asStep(error) {
  if (error instanceof StepFailure) return error;
  throw error;
}

/**
 * A failure of the whole item.
 * @param {ResolveItem} item
 * @param {Failure} fail
 * @param {Attempt[]} attempts
 * @param {{ status?: Status, page?: PageInput | null, raw?: unknown,
 *   title?: string | null }} [extra]
 * @returns {ResolveFailure}
 */
function itemFailure(item, fail, attempts, extra = {}) {
  return {
    ok: false,
    item,
    failure: fail,
    status: extra.status ?? statusForFailure(fail.code),
    attempts: [...attempts],
    page: extra.page ?? null,
    raw: extra.raw ?? null,
    title: extra.title ?? null,
  };
}

/**
 * The page record of a request (the report's `page`).
 * @param {Attempt | undefined} attempt
 * @returns {PageInput | null}
 */
function pageOf(attempt) {
  if (attempt === undefined) return null;
  return {
    url: attempt.url,
    http_status: attempt.http_status,
    bytes: attempt.received_bytes,
  };
}

/**
 * A target with every field set to its default.
 * @param {ResolveItem} item
 * @param {Partial<Target>} fields
 * @returns {Target}
 */
function makeTarget(item, fields) {
  return {
    key: item.key,
    itemKey: item.key,
    input: item.original,
    site: item.site,
    id: item.id,
    part: null,
    partCount: null,
    cid: null,
    pageUrl: item.pageUrl,
    title: "",
    partTitle: null,
    seasonId: null,
    episodeId: null,
    seriesTitle: null,
    durationS: null,
    cover: null,
    uploader: null,
    streams: null,
    raw: null,
    hints: [],
    attempts: [],
    page: null,
    failure: null,
    status: null,
    ...fields,
  };
}

/**
 * Turn a page URL of a real site into the same path under a test base (identity in production).
 * @param {string} url
 * @param {string} origin the real origin (`https://www.bilibili.com`)
 * @param {string} base the base in force
 * @returns {string}
 */
export function onBase(url, origin, base) {
  const root = base.replace(/\/+$/, "");
  return url.startsWith(origin) ? root + url.slice(origin.length) : url;
}

// ------------------------------------------------------------------------- Dailymotion

/**
 * The HLS streams of a Dailymotion video from its master URL: master → chosen variant (+ audio
 * rendition) → their media playlists. Every request paced.
 * @param {string} masterUrl
 * @param {ResolveContext} ctx
 * @param {Attempt[]} attempts
 * @param {{ name: string | null, height: number | null, codecs: string | null } | null} keep
 *   a variant to keep (a refresh), else the preferences choose
 * @returns {Promise<{ ok: true, streams: HlsChoice, raw: Omit<HlsRaw, "metadata"> } |
 *   { ok: false, failure: Failure }>}
 */
async function hlsStreams(masterUrl, ctx, attempts, keep) {
  await ctx.pagePause();
  const master = await fetchText(masterUrl, "manifest", ctx.net, attempts);
  /** @type {HlsVariant[]} */
  let variants;
  /** @type {HlsRendition[]} */
  let renditions = [];
  if (isMaster(master.text)) {
    ({ variants, audioRenditions: renditions } = parseMaster(master.text, master.url));
  } else if (master.text.includes("#EXTINF")) {
    variants = [
      {
        url: master.url,
        bandwidth: 0,
        width: null,
        height: null,
        frameRate: null,
        codecs: null,
        name: null,
        audioGroup: null,
      },
    ];
  } else {
    return { ok: false, failure: failure("not_a_video", { content_type: master.contentType }) };
  }
  const video = variants.filter((variant) => !isAudioOnlyCodecs(variant.codecs));
  let variant =
    keep === null
      ? null
      : (video.find(
          (one) =>
            one.name === keep.name && one.height === keep.height && one.codecs === keep.codecs,
        ) ??
        video.find((one) => one.height === keep.height && one.codecs === keep.codecs) ??
        null);
  variant ??= chooseVariant(video, ctx.prefs);
  if (variant === null) {
    const none = failure("no_streams", { detail: "no video variant in the master" });
    return { ok: false, failure: none };
  }
  const audio = pickAudio(variant, renditions);
  await ctx.pagePause();
  const media = await fetchText(variant.url, "playlist", ctx.net, attempts);
  let keyMethod = keyMethodOf(media.text);
  const parsed = parseMedia(media.text, media.url);
  /** @type {HlsMedia | null} */
  let audioMedia = null;
  if (audio !== null && audio.url !== null) {
    await ctx.pagePause();
    const audioText = await fetchText(audio.url, "playlist", ctx.net, attempts);
    keyMethod ??= keyMethodOf(audioText.text);
    audioMedia = parseMedia(audioText.text, audioText.url);
  }
  return {
    ok: true,
    streams: {
      kind: "hls",
      master: master.url,
      variant,
      audio,
      available: video,
      audioRenditions: renditions,
    },
    raw: {
      media: parsed,
      mediaUrl: variant.url,
      audioMedia,
      audioMediaUrl: audio?.url ?? null,
      keyMethod,
    },
  };
}

/**
 * The site's own words for an error: its title, and its longer message when it says more
 * (`Content not available — This video does not exist or has been deleted.`).
 * @param {unknown} json
 * @param {string | undefined} title what `lib/dailymotion.parseMetadata` took
 * @returns {string}
 */
function siteMessage(json, title) {
  const error = isRecord(json) && isRecord(json["error"]) ? json["error"] : {};
  const raw = typeof error["raw_message"] === "string" ? error["raw_message"].trim() : "";
  const head = (title ?? "").trim();
  if (!raw || raw === head) return head || raw;
  return head ? `${head} — ${raw}` : raw;
}

/**
 * A Dailymotion metadata answer, mapped to the failure codes of the run: geo-blocking (`DM007`)
 * stays `geo_blocked`; any other error of the site makes the video unavailable to this session
 * (`deleted`, `failed-unavailable`) with the site's own words as `Dailymotion says: <message>`.
 * @param {unknown} json
 * @param {string} id
 * @param {string} contentType
 */
function dailymotionMetadata(json, id, contentType) {
  /** @param {Failure} fail @param {Status} [status] */
  const refused = (fail, status) => ({
    ok: /** @type {const} */ (false),
    ...withStatus(fail, status),
  });
  if (json === undefined) return refused(failure("not_a_video", { content_type: contentType }));
  const parsed = parseMetadata(json, id);
  if (parsed.ok) return parsed;
  if (parsed.code === "geo_blocked") return refused(failure("geo_blocked", parsed.params));
  if (parsed.code === "no_streams") {
    return refused(failure("no_streams", { detail: parsed.params["types"] || "no HLS master" }));
  }
  if (parsed.params["site_code"] !== undefined) {
    const message = `Dailymotion says: ${siteMessage(json, parsed.params["site_message"])}`;
    return refused(failure("deleted", { site_message: message }), FAILED_UNAVAILABLE);
  }
  return refused(failure("not_a_video", { content_type: contentType }));
}

/**
 * @param {ResolveItem} item
 * @param {ResolveContext} ctx
 * @returns {Promise<Target[] | ResolveFailure>}
 */
async function resolveDailymotion(item, ctx) {
  /** @type {Attempt[]} */
  const attempts = [];
  const url = metadataUrl(ctx.bases.dailymotion, item.id);
  let metadata;
  try {
    metadata = await fetchText(url, "metadata", ctx.net, attempts, { accept: "application/json" });
  } catch (error) {
    return itemFailure(item, asStep(error).failure, attempts, { page: pageOf(attempts.at(-1)) });
  }
  const json = safeParse(metadata.text);
  const page = pageOf(metadata.attempt);
  const decided = dailymotionMetadata(json, item.id, metadata.contentType);
  if (!decided.ok) {
    const extra = { status: decided.status, page, raw: json ?? null };
    return itemFailure(item, decided.failure, attempts, extra);
  }
  const info = decided.info;
  const base = {
    id: info.id ?? item.id,
    pageUrl: dmPageUrl(info.id ?? item.id),
    title: info.title || item.id,
    durationS: info.durationS,
    cover: info.cover,
    uploader: info.uploader,
    hints: item.playlistIgnored === true ? [PLAYLIST_IGNORED] : [],
    page,
  };
  /** @type {Awaited<ReturnType<typeof hlsStreams>>} */
  let streams;
  try {
    streams = await hlsStreams(info.masterUrl, ctx, attempts, null);
  } catch (error) {
    const step = asStep(error);
    return itemFailure(item, step.failure, attempts, { page, raw: json, title: base.title });
  }
  if (!streams.ok) {
    return itemFailure(item, streams.failure, attempts, { page, raw: json, title: base.title });
  }
  const raw = { metadata: json, ...streams.raw };
  const problem =
    mediaProblem(/** @type {HlsMedia} */ (raw.media), raw.keyMethod) ??
    (raw.audioMedia === null ? null : mediaProblem(raw.audioMedia, raw.keyMethod));
  return [
    makeTarget(item, {
      ...base,
      streams: streams.streams,
      raw,
      attempts: [...attempts],
      failure: problem,
      status: problem === null ? null : statusForFailure(problem.code),
    }),
  ];
}

// ---------------------------------------------------------------------------- Bilibili

/**
 * The failure `lib/bilibili.parsePage` reported, as a run failure.
 * @param {{ code: string, params: Record<string, string> }} refusal
 * @param {string} contentType
 * @returns {Failure}
 */
function bilibiliRefusal(refusal, contentType) {
  switch (refusal.code) {
    case "rate_limited":
      return failure("rate_limited", {
        detail: `${refusal.params["reason"] ?? "risk control"} (page)`,
      });
    case "unsupported_link":
      return failure("unsupported_link", { what: refusal.params["kind"] ?? "unsupported-path" });
    case "not_a_video":
      return failure("not_a_video", {
        content_type: contentType || "a page without the video's data",
      });
    case "login_required":
    case "deleted":
    case "interactive":
    case "supporter_only":
    case "trial_only":
    case "legacy_stream":
      return failure(refusal.code, refusal.params);
    default:
      return failure("not_a_video", { content_type: contentType });
  }
}

/**
 * The DASH choice of a Bilibili (or Bilibili.tv) stream selection.
 * @param {{ video: DashRep, audio: DashRep | null, missingPremium?: string[],
 *   available?: DashRep[], audioAvailable?: DashRep[] }} selection
 * @param {DashRep[]} videos
 * @param {DashRep[]} audios
 * @returns {DashChoice}
 */
function dashChoice(selection, videos, audios) {
  return {
    kind: "dash",
    video: selection.video,
    audio: selection.audio,
    available: selection.available ?? videos,
    audioAvailable: selection.audioAvailable ?? audios,
    missingPremium: selection.missingPremium ?? [],
  };
}

/**
 * The premium hint of a DASH choice (`1080P60 needs a premium membership`), when it applies.
 * @param {DashChoice} choice
 * @returns {Hint[]}
 */
function premiumHints(choice) {
  return choice.missingPremium.length > 0
    ? [{ code: "premium", params: { labels: [...choice.missingPremium] } }]
    : [];
}

/**
 * A Bilibili page fetched and parsed for one part.
 * @param {string} id
 * @param {number | null} part
 * @param {ResolveContext} ctx
 * @param {Attempt[]} attempts
 * @param {{ text: string, url: string, contentType: string, attempt: Attempt } | null} [given]
 *   the page already fetched (a followed short link)
 */
async function bilibiliPage(id, part, ctx, attempts, given = null) {
  const url = biliPageUrl(id, part, ctx.bases.bilibili);
  const page = given ?? (await fetchText(url, "page", ctx.net, attempts));
  const parsed = parsePage(page.text, { part });
  const playinfo = extractEmbeddedJson(page.text, "__playinfo__");
  const raw = isRecord(playinfo) ? (playinfo["data"] ?? playinfo) : null;
  return { page, parsed, raw };
}

/**
 * Follow a `b23.tv` short link: the final page must be a Bilibili video page (in test mode, one
 * under the fake site's base), else `redirect_refused`.
 * @param {ResolveItem} item
 * @param {ResolveContext} ctx
 * @param {Attempt[]} attempts
 * @returns {Promise<{ ok: true, item: ResolveItem, page: Awaited<ReturnType<typeof fetchText>> } |
 *   { ok: false, failure: Failure }>}
 */
async function followShortLink(item, ctx, attempts) {
  const code = item.id.slice(B23_PREFIX.length);
  const short = `${ctx.bases.b23.replace(/\/+$/, "")}/${encodeURIComponent(code)}`;
  const page = await fetchText(short, "short link", ctx.net, attempts);
  const fakeBilibili = ctx.bases.bilibili.replace(/\/+$/, "");
  const finalUrl = onBase(page.url, fakeBilibili, PRODUCTION_BASES.bilibili);
  const parsed = parseLine(finalUrl);
  if (isRefused(parsed) || parsed.site !== "bilibili" || parsed.id.startsWith(B23_PREFIX)) {
    const attempt = attempts.at(-1);
    if (attempt !== undefined) attempt.outcome = "redirect refused: not a Bilibili video page";
    return { ok: false, failure: failure("redirect_refused", { host: hostOf(page.url) }) };
  }
  return {
    ok: true,
    item: { ...parsed, shortLink: item.shortLink ?? item.pageUrl, original: item.original },
    page,
  };
}

/**
 * @param {ResolveItem} pasted
 * @param {ResolveContext} ctx
 * @returns {Promise<Target[] | ResolveFailure>}
 */
async function resolveBilibili(pasted, ctx) {
  /** @type {Attempt[]} */
  const attempts = [];
  let item = pasted;
  /** @type {Awaited<ReturnType<typeof fetchText>> | null} */
  let given = null;
  try {
    if (item.id.startsWith(B23_PREFIX)) {
      const followed = await followShortLink(item, ctx, attempts);
      if (!followed.ok) return itemFailure(pasted, followed.failure, attempts);
      item = followed.item;
      // the page the redirect ended on is the part the link names (or the first part)
      given = followed.page;
    }
    const first = await bilibiliPage(item.id, item.part, ctx, attempts, given);
    const page = pageOf(first.page.attempt);
    if (!first.parsed.ok) {
      const fail = bilibiliRefusal(first.parsed, first.page.contentType);
      return itemFailure(item, fail, attempts, { page, raw: first.raw });
    }
    const info = first.parsed.info;
    const id = canonicalId(info.id) ?? item.id;
    const pages =
      info.pages.length > 0
        ? info.pages
        : [{ part: 1, cid: "", title: "", durationS: info.durationS }];
    const multi = pages.length > 1;
    const wanted = item.part === null ? pages : pages.filter((one) => one.part === item.part);
    if (wanted.length === 0) {
      const fail = failure("unsupported_link", { what: "unsupported-path" });
      return itemFailure(item, fail, attempts, { page, title: info.title });
    }
    const itemKey = item.key;
    /** @type {Target[]} */
    const targets = [];
    let stopped = /** @type {Failure | null} */ (null);
    for (const part of wanted) {
      /** @type {Attempt[]} */
      const own = [];
      const common = {
        key: multi ? `bilibili:${id}:${part.part}` : `bilibili:${id}:all`,
        itemKey,
        input: pasted.original,
        id,
        part: multi ? part.part : null,
        partCount: pages.length,
        cid: part.cid || null,
        pageUrl: biliPageUrl(id, multi ? part.part : null),
        title: info.title || id,
        partTitle: multi ? part.title || null : null,
        durationS: (multi ? part.durationS : (info.durationS ?? part.durationS)) ?? null,
        cover: info.cover,
        uploader: info.uploader,
        page,
      };
      if (stopped !== null) {
        const fields = { ...common, attempts: [...attempts] };
        targets.push(makeTarget(item, { ...fields, ...withStatus(stopped, STOPPED) }));
        continue;
      }
      let play = first.parsed.play;
      let raw = first.raw;
      if (part.part !== info.selectedPart) {
        /** @type {{ fail: Failure, raw: unknown } | null} */
        let refused = null;
        try {
          await ctx.pagePause();
          const more = await bilibiliPage(id, part.part, ctx, own);
          if (more.parsed.ok) {
            play = more.parsed.play;
            raw = more.raw;
          } else {
            refused = { fail: bilibiliRefusal(more.parsed, more.page.contentType), raw: more.raw };
          }
        } catch (error) {
          refused = { fail: asStep(error).failure, raw: null };
        }
        if (refused !== null) {
          const fields = { ...common, attempts: [...attempts, ...own], raw: refused.raw };
          targets.push(makeTarget(item, { ...fields, ...withStatus(refused.fail) }));
          const reason = stopReasonAfter(refused.fail);
          if (reason !== null) stopped = failure("stopped", { reason });
          continue;
        }
      }
      const selection = chooseStreams(play, ctx.prefs);
      if (selection === null) {
        const fail = failure("no_streams", { detail: "the page embeds no DASH stream" });
        const fields = { ...common, attempts: [...attempts, ...own], raw };
        targets.push(makeTarget(item, { ...fields, ...withStatus(fail) }));
        continue;
      }
      const streams = dashChoice(selection, play?.videos ?? [], play?.audios ?? []);
      targets.push(
        makeTarget(item, {
          ...common,
          durationS: common.durationS ?? play?.timelengthS ?? null,
          streams,
          raw,
          hints: premiumHints(streams),
          attempts: [...attempts, ...own],
        }),
      );
    }
    return targets;
  } catch (error) {
    const step = asStep(error);
    return itemFailure(item, step.failure, attempts, { page: pageOf(attempts.at(-1)) });
  }
}

// ------------------------------------------------------------------------- Bilibili.tv

/**
 * A Bilibili.tv playurl refusal as a run failure: the parser's own code when it is one of the
 * run's codes (`geo_blocked`, `login_required`, `no_streams`, …), else the site's message as an
 * unavailable video.
 * @param {{ code: unknown, params?: unknown }} refusal
 * @returns {{ failure: Failure, status: Status }}
 */
function bilibilitvRefusal(refusal) {
  const params = isRecord(refusal.params) ? refusal.params : {};
  if (isFailureCode(refusal.code)) {
    const fail = failure(refusal.code, params);
    const status = statusForFailure(fail.code);
    return { failure: fail, status: status === FAILED ? FAILED_UNAVAILABLE : status };
  }
  const message = params["site_message"] ?? params["message"];
  return withStatus(failure("deleted", { site_message: message }), FAILED_UNAVAILABLE);
}

/**
 * The page URL of a Bilibili.tv video or episode under `base` (`/en/video/<aid>`,
 * `/en/play/<season>/<ep>`: `lib/bilibilitv.pageUrl`), or null for an episode whose season is not
 * known (`lib/urls.js` always gives one; the page is then not asked for — the playurl answer
 * suffices).
 * @param {string} base
 * @param {{ aid?: string, epId?: string, seasonId?: string | null }} ids
 * @returns {string | null}
 */
export function bilibilitvPage(base, ids) {
  if (ids.aid !== undefined) return btv.pageUrl({ kind: "video", id: ids.aid }, base);
  if (!ids.seasonId || ids.epId === undefined) return null;
  return btv.pageUrl({ kind: "episode", id: ids.epId, seasonId: ids.seasonId }, base);
}

/**
 * The playurl request of a video (`aid`) or an episode (`ep_id`), the ids as text.
 * @param {ResolveContext} ctx
 * @param {{ aid?: string, epId?: string }} ids
 * @returns {string}
 */
function playurlOf(ctx, ids) {
  const base = ctx.bases.bilibilitvApi;
  return ids.aid !== undefined
    ? btv.playurlUrl(base, { aid: ids.aid })
    : btv.playurlUrl(base, { epId: String(ids.epId) });
}

/**
 * A JSON answer of an API (`Accept: application/json`) as text.
 * @param {string} url
 * @param {ResolveContext} ctx
 * @param {Attempt[]} attempts
 */
function fetchJson(url, ctx, attempts) {
  return fetchText(url, "metadata", ctx.net, attempts, { accept: "application/json" });
}

/**
 * The streams of one Bilibili.tv video or episode: the playurl API (`aid` or `ep_id`, as text).
 * @param {{ aid?: string, epId?: string }} ids
 * @param {ResolveContext} ctx
 * @param {Attempt[]} attempts
 * @returns {Promise<{ ok: true, streams: DashChoice, raw: unknown } |
 *   { ok: false, failure: Failure, status: Status, raw: unknown }>}
 */
async function bilibilitvStreams(ids, ctx, attempts) {
  const answer = await fetchJson(playurlOf(ctx, ids), ctx, attempts);
  const json = safeParse(answer.text);
  if (json === undefined) {
    const fail = failure("not_a_video", { content_type: answer.contentType });
    return { ok: false, ...withStatus(fail), raw: null };
  }
  const play = btv.parsePlayurl(json);
  if (!play.ok) return { ok: false, ...bilibilitvRefusal(play), raw: json };
  const selection = btv.chooseStreams(play, ctx.prefs);
  if (selection === null || selection === undefined) {
    const fail = failure("no_streams", { detail: "the playurl answer lists no video" });
    return { ok: false, ...withStatus(fail, FAILED_UNAVAILABLE), raw: json };
  }
  const streams = dashChoice(selection, play.videos ?? [], play.audios ?? []);
  return { ok: true, streams, raw: json };
}

/**
 * Whether a step's failure means the site refused this session (a 429 / 412 / 403 on a document,
 * a risk-control page): such a failure stops everything, even where a step may otherwise fail
 * quietly.
 * @param {StepFailure} step
 * @returns {boolean}
 */
function refusedBySite(step) {
  return step.failure.code === "rate_limited" || step.failure.code === "blocked";
}

/**
 * The stop reason a failure of one part or episode gives every part after it — the site refused
 * this session or asked for a login — or null when the next ones may still be asked.
 * @param {Failure} fail
 * @returns {string | null}
 */
function stopReasonAfter(fail) {
  const code = fail.code;
  return code === "rate_limited" || code === "blocked" || code === "login_required" ? code : null;
}

/**
 * A Bilibili.tv page read for its title, cover and duration; never fatal unless the site refused
 * the request (a 429 / 412 / 403 stops the run like anywhere else).
 * @param {string} url
 * @param {ResolveContext} ctx
 * @param {Attempt[]} attempts
 * @returns {Promise<{ title: string | null, cover: string | null, durationS: number | null,
 *   page: PageInput | null }>}
 */
async function bilibilitvPageInfo(url, ctx, attempts) {
  try {
    const page = await fetchText(url, "page", ctx.net, attempts);
    const parsed = btv.parsePage(page.text);
    return {
      title: typeof parsed?.title === "string" && parsed.title ? parsed.title : null,
      cover: typeof parsed?.cover === "string" && parsed.cover ? parsed.cover : null,
      durationS: typeof parsed?.durationS === "number" ? parsed.durationS : null,
      page: pageOf(page.attempt),
    };
  } catch (error) {
    const step = asStep(error);
    if (refusedBySite(step)) throw step;
    return { title: null, cover: null, durationS: null, page: pageOf(attempts.at(-1)) };
  }
}

/**
 * @typedef {object} BilibilitvWhat One Bilibili.tv video or episode to resolve.
 * @property {string} [aid] a user video
 * @property {string} [epId] an episode
 * @property {string | null} seasonId
 * @property {number | null} index the episode's position in its series
 * @property {string | null} seriesTitle
 * @property {string | null} title what the series' episode list says
 * @property {string | null} cover
 * @property {number | null} durationS
 */

/**
 * The fields of a Bilibili.tv target that do not depend on its answers: a series episode's own
 * title is its `partTitle` (the list's `title_display`, A.3), its position its `part`.
 * @param {BilibilitvWhat} what
 * @param {string} fallbackPage the pasted item's canonical page (when no page URL can be built)
 * @returns {Partial<Target>}
 */
function bilibilitvFields(what, fallbackPage) {
  const id = what.aid ?? String(what.epId);
  return {
    key: what.aid !== undefined ? `bilibilitv:video:${id}` : `bilibilitv:episode:${id}`,
    id,
    part: what.index,
    pageUrl: bilibilitvPage(PRODUCTION_BASES.bilibilitv, what) ?? fallbackPage,
    title: what.title ?? id,
    partTitle: what.index !== null ? what.title : null,
    seasonId: what.seasonId,
    episodeId: what.epId ?? null,
    seriesTitle: what.seriesTitle,
    cover: what.cover,
    durationS: what.durationS,
  };
}

/**
 * One Bilibili.tv video or episode: its page (title, cover, duration), then its playurl answer.
 * @param {ResolveItem} item
 * @param {BilibilitvWhat} what
 * @param {ResolveContext} ctx
 * @param {Attempt[]} shared attempts every target of the item carries (a series' lists)
 * @returns {Promise<Target>}
 */
async function bilibilitvTarget(item, what, ctx, shared) {
  /** @type {Attempt[]} */
  const own = [];
  const base = bilibilitvFields(what, item.pageUrl);
  const pageUrl = bilibilitvPage(ctx.bases.bilibilitv, what);
  const info =
    pageUrl === null
      ? { title: null, cover: null, durationS: null, page: null }
      : await bilibilitvPageInfo(pageUrl, ctx, own);
  if (pageUrl !== null) await ctx.pagePause();
  const streams = await bilibilitvStreams(what, ctx, own);
  const fields = {
    ...base,
    title: info.title ?? base.title,
    durationS: info.durationS ?? what.durationS,
    cover: info.cover ?? what.cover,
    page: info.page,
    raw: streams.raw,
    attempts: [...shared, ...own],
  };
  if (!streams.ok) {
    return makeTarget(item, { ...fields, failure: streams.failure, status: streams.status });
  }
  const hints = premiumHints(streams.streams);
  return makeTarget(item, { ...fields, streams: streams.streams, hints });
}

/**
 * A series: its title (`season_info`, not fatal), its episodes (`episodes`), then one page and
 * one playurl answer per episode, in order; after a refusal or a login wall the episodes not
 * reached are `stopped`.
 * @param {ResolveItem} item
 * @param {ResolveContext} ctx
 * @param {Attempt[]} attempts
 * @returns {Promise<Target[] | ResolveFailure>}
 */
async function resolveSeries(item, ctx, attempts) {
  const seasonId = item.id;
  let seriesTitle = /** @type {string | null} */ (null);
  try {
    const url = btv.seasonInfoUrl(ctx.bases.bilibilitvApi, seasonId);
    const info = await fetchJson(url, ctx, attempts);
    const parsed = btv.parseSeasonInfo(safeParse(info.text));
    seriesTitle = typeof parsed?.title === "string" && parsed.title ? parsed.title : null;
  } catch (error) {
    const step = asStep(error);
    if (refusedBySite(step)) throw step;
  }
  await ctx.pagePause();
  const list = await fetchJson(btv.episodesUrl(ctx.bases.bilibilitvApi, seasonId), ctx, attempts);
  const json = safeParse(list.text);
  const page = pageOf(list.attempt);
  if (json === undefined) {
    const fail = failure("not_a_video", { content_type: list.contentType });
    return itemFailure(item, fail, attempts, { page, title: seriesTitle });
  }
  const listed = btv.parseEpisodes(json);
  if (listed.refusal !== null) {
    // the site's own code (geo, login, …): the series is refused as its episodes would be
    const refused = bilibilitvRefusal(listed.refusal);
    const extra = { status: refused.status, page, raw: json, title: seriesTitle };
    return itemFailure(item, refused.failure, attempts, extra);
  }
  const episodes = listed.episodes.slice(0, MAX_SERIES_EPISODES);
  if (episodes.length === 0) {
    const fail = failure("no_streams", { detail: "the series lists no episode" });
    /** @type {{ status: Status, page: PageInput | null, raw: unknown, title: string | null }} */
    const extra = { status: FAILED_UNAVAILABLE, page, raw: json, title: seriesTitle };
    return itemFailure(item, fail, attempts, extra);
  }
  /** @type {Target[]} */
  const targets = [];
  /** @type {Failure | null} */
  let stopped = null;
  for (const [position, episode] of episodes.entries()) {
    /** @type {BilibilitvWhat} */
    const what = {
      epId: String(episode.epId),
      seasonId,
      index: position + 1,
      seriesTitle,
      title: typeof episode.title === "string" ? episode.title : null,
      cover: typeof episode.cover === "string" ? episode.cover : null,
      durationS: typeof episode.durationS === "number" ? episode.durationS : null,
    };
    if (stopped !== null) {
      const fields = { ...bilibilitvFields(what, item.pageUrl), attempts: [...attempts] };
      targets.push(makeTarget(item, { ...fields, ...withStatus(stopped, STOPPED) }));
      continue;
    }
    await ctx.pagePause();
    /** @type {Target} */
    let target;
    try {
      target = await bilibilitvTarget(item, what, ctx, attempts);
    } catch (error) {
      const step = asStep(error);
      const fields = { ...bilibilitvFields(what, item.pageUrl), attempts: [...attempts] };
      target = makeTarget(item, { ...fields, ...withStatus(step.failure) });
    }
    targets.push(target);
    const reason = target.failure === null ? null : stopReasonAfter(target.failure);
    if (reason !== null) stopped = failure("stopped", { reason });
  }
  return targets;
}

/**
 * @param {ResolveItem} item
 * @param {ResolveContext} ctx
 * @returns {Promise<Target[] | ResolveFailure>}
 */
async function resolveBilibilitv(item, ctx) {
  /** @type {Attempt[]} */
  const attempts = [];
  try {
    if (item.kind === "series") return await resolveSeries(item, ctx, attempts);
    if (item.kind !== "video" && item.kind !== "episode") {
      const fail = failure("unsupported_link", { what: "unsupported-path" });
      return itemFailure(item, fail, attempts);
    }
    /** @type {BilibilitvWhat} */
    const what = {
      ...(item.kind === "video" ? { aid: item.id } : { epId: item.id }),
      seasonId: item.kind === "episode" ? (item.seasonId ?? null) : null,
      index: null,
      seriesTitle: null,
      title: null,
      cover: null,
      durationS: null,
    };
    const target = await bilibilitvTarget(item, what, ctx, attempts);
    if (target.failure !== null && target.streams === null && target.status !== null) {
      return itemFailure(item, target.failure, target.attempts, {
        status: target.status,
        page: target.page,
        raw: target.raw,
        title: target.title === item.id ? null : target.title,
      });
    }
    return [target];
  } catch (error) {
    const step = asStep(error);
    return itemFailure(item, step.failure, attempts, { page: pageOf(attempts.at(-1)) });
  }
}

// ---------------------------------------------------------------------------- dispatch

/**
 * Resolve one pasted item into its targets — one per Dailymotion video, per Bilibili part, per
 * Bilibili.tv video or episode (a series: every episode, in order, at most
 * {@link MAX_SERIES_EPISODES}) — or a failure of the whole item. The caller pauses before the
 * item's first request; the resolver paces every further one (`ctx.pagePause`). A stop (the run's
 * signal) is rethrown.
 * @param {ResolveItem} item
 * @param {ResolveContext} ctx
 * @returns {Promise<Target[] | ResolveFailure>}
 */
export async function resolve(item, ctx) {
  try {
    if (item.site === "dailymotion") return await resolveDailymotion(item, ctx);
    if (item.site === "bilibili") return await resolveBilibili(item, ctx);
    if (item.site === "bilibilitv") return await resolveBilibilitv(item, ctx);
    return itemFailure(item, failure("unsupported_link", { what: "other-site" }), []);
  } catch (error) {
    if (isStop(error, ctx.net)) throw error;
    if (error instanceof StepFailure) return itemFailure(item, error.failure, []);
    throw error;
  }
}

/**
 * Fresh streams for a target whose media URLs the site refused (expired signed URLs): the same
 * documents read again, the same choice kept — the same HLS variant (name, height, codecs), the
 * same DASH representations (quality id and codecs). Used once per video by the downloader.
 * @param {Target} target
 * @param {ResolveContext} ctx
 * @returns {Promise<RefreshResult>}
 */
export async function refreshStreams(target, ctx) {
  const streams = target.streams;
  if (streams === null) {
    return { ok: false, ...withStatus(failure("no_streams", { detail: "nothing to refresh" })) };
  }
  try {
    if (streams.kind === "hls") {
      const url = metadataUrl(ctx.bases.dailymotion, target.id);
      const accept = { accept: "application/json" };
      const metadata = await fetchText(url, "metadata", ctx.net, target.attempts, accept);
      const json = safeParse(metadata.text);
      const decided = dailymotionMetadata(json, target.id, metadata.contentType);
      if (!decided.ok) return { ok: false, failure: decided.failure, status: decided.status };
      const { name, height, codecs } = streams.variant;
      const fresh = await hlsStreams(decided.info.masterUrl, ctx, target.attempts, {
        name,
        height,
        codecs,
      });
      if (!fresh.ok) return { ok: false, ...withStatus(fresh.failure) };
      return { ok: true, streams: fresh.streams, raw: { metadata: json, ...fresh.raw } };
    }
    /** @type {{ videos: DashRep[], audios: DashRep[], raw: unknown } |
     *   { failure: Failure, status: Status }} */
    let offered;
    if (target.site === "bilibili") {
      const fresh = await bilibiliPage(target.id, target.part, ctx, target.attempts);
      if (!fresh.parsed.ok) {
        offered = withStatus(bilibiliRefusal(fresh.parsed, fresh.page.contentType));
      } else {
        const play = fresh.parsed.play;
        offered = { videos: play?.videos ?? [], audios: play?.audios ?? [], raw: fresh.raw };
      }
    } else {
      const ids = target.episodeId !== null ? { epId: target.episodeId } : { aid: target.id };
      const answer = await fetchJson(playurlOf(ctx, ids), ctx, target.attempts);
      const json = safeParse(answer.text);
      const play = json === undefined ? null : btv.parsePlayurl(json);
      if (play === null) {
        offered = withStatus(failure("not_a_video", { content_type: answer.contentType }));
      } else if (!play.ok) {
        offered = bilibilitvRefusal(play);
      } else {
        offered = { videos: play.videos ?? [], audios: play.audios ?? [], raw: json };
      }
    }
    if ("failure" in offered) {
      return { ok: false, failure: offered.failure, status: offered.status };
    }
    /** @param {DashRep | null} rep @param {DashRep[]} pool */
    const same = (rep, pool) =>
      rep === null
        ? null
        : (pool.find((one) => one.id === rep.id && one.codecs === rep.codecs) ?? null);
    const video = same(streams.video, offered.videos);
    const audio = same(streams.audio, offered.audios);
    if (video === null || (streams.audio !== null && audio === null)) {
      const detail = "the refreshed answer no longer offers the chosen quality";
      return { ok: false, ...withStatus(failure("no_streams", { detail })) };
    }
    return {
      ok: true,
      streams: {
        ...streams,
        video,
        audio,
        available: offered.videos,
        audioAvailable: offered.audios,
      },
      raw: offered.raw,
    };
  } catch (error) {
    if (isStop(error, ctx.net)) throw error;
    const step = asStep(error);
    return { ok: false, failure: step.failure, status: statusForFailure(step.failure.code) };
  }
}

// ------------------------------------------------------------------- the row's selector

/**
 * Choose another video stream for a resolved target (the row's quality selector): `index` into
 * `streams.available`. HLS: the variant changes and its audio rendition is picked again by the
 * same rules (its media playlist is read again at download time); DASH: the video representation
 * changes (the audio does not depend on it). An index out of range changes nothing.
 * @param {Target} target
 * @param {number} index
 * @returns {boolean} whether the selection changed
 */
export function selectStream(target, index) {
  const streams = target.streams;
  if (streams === null || !Number.isInteger(index)) return false;
  if (streams.kind === "hls") {
    const variant = streams.available[index];
    if (variant === undefined || variant === streams.variant) return false;
    target.streams = { ...streams, variant, audio: pickAudio(variant, streams.audioRenditions) };
    return true;
  }
  const video = streams.available[index];
  if (video === undefined || video === streams.video) return false;
  target.streams = { ...streams, video };
  return true;
}
