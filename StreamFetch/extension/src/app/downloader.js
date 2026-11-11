// @ts-check
/**
 * The network rules of every request StreamFetch makes, and the download of one target into a
 * verified progressive MP4 saved through `chrome.downloads`.
 *
 * Requests ({@link request}, {@link fetchText}): only to a host the manifest covers (any other is
 * never requested: `host_not_covered`), with the session's own cookies (`credentials: "include"`),
 * redirects followed by the browser but the final URL checked again (`redirect_refused`), a stall
 * guard (no byte for `stallMs`: aborted and retried), at most `MAX_RETRIES` retries with the
 * 1-2-4 s backoff on a network error, a stall or a 5xx; a 429 or 412 anywhere is `rate_limited`, a
 * 403 on a page, a manifest or a JSON answer `blocked` (both stop the run and start the cooldown),
 * a 403 / 404 / 410 on media `expired` (the downloader refreshes the target's URLs once). The only
 * header change is the declarativeNetRequest session rule of {@link refererRule}: `Referer` set to
 * the site's origin and `Origin` removed on the extension's own media requests — what the sites'
 * own players send.
 *
 * A download ({@link download}), one target at a time, one request at a time, each media request
 * after its pause: HLS segments in order (MPEG-TS through `lib/ts.js`'s demuxer into sample
 * files, fMP4 appended as served), or the two DASH files (video, then audio) streamed with
 * `Range` resume; everything streamed to the OPFS work files (`./files.js`); then the progressive
 * MP4 written by `lib/remux.js`, checked by `lib/mp4.probe` (progressive, one video and one audio
 * track, the duration within max(3 s, 5 %) of the site's) and only then saved; the work files
 * are removed whatever happens. Encrypted media (`encv`, `enca`, `pssh`, a key-protected
 * playlist) is refused and never saved.
 */

import { parseMedia } from "../lib/hls.js";
import { hostOf } from "../lib/json.js";
import {
  DONE,
  FAILED,
  SKIPPED_EXISTS,
  STOPPED,
  failure,
  render,
  statusForFailure,
} from "../lib/messages.js";
import { Mp4Error, collectMp4, drmProblem, imageType, probe } from "../lib/mp4.js";
import { partLabel, targetPath } from "../lib/naming.js";
import { MAX_RETRIES, mediaPauseMs, retryBackoffS } from "../lib/pacing.js";
import { coverProblem, writeProgressiveMp4 } from "../lib/remux.js";
import { TsDemuxer, tracksFromDemux } from "../lib/ts.js";

/**
 * @typedef {import("../lib/messages.js").Failure} Failure
 * @typedef {import("../lib/messages.js").Status} Status
 * @typedef {import("../lib/report.js").Attempt} Attempt
 * @typedef {import("../lib/mp4.js").TrackPlan} TrackPlan
 * @typedef {import("../lib/mp4.js").Mp4File} Mp4File
 * @typedef {import("../lib/hls.js").HlsMedia} HlsMedia
 * @typedef {import("../lib/hls.js").HlsByteRange} HlsByteRange
 * @typedef {import("../lib/bilibili.js").DashRep} DashRep
 * @typedef {import("./resolver.js").Target} Target
 * @typedef {import("./resolver.js").HlsChoice} HlsChoice
 * @typedef {import("./resolver.js").DashChoice} DashChoice
 * @typedef {import("./resolver.js").HlsRaw} HlsRaw
 * @typedef {import("./resolver.js").RefreshResult} RefreshResult
 * @typedef {import("./resolver.js").SiteName} SiteName
 * @typedef {import("./files.js").WorkFiles} WorkFiles
 * @typedef {import("./files.js").AppendWriter} AppendWriter
 *
 * @typedef {"page" | "short link" | "metadata" | "manifest" | "playlist" | "segment" | "media" |
 *   "cover"} RequestKind
 *
 * @typedef {object} NetContext The network rules of a run, shared by the resolver and the
 *   downloader.
 * @property {typeof fetch} fetch
 * @property {readonly string[]} hostPatterns the manifest's host permissions
 * @property {AbortSignal} signal the run's Stop
 * @property {number} stallMs no byte for this long: the request is aborted and retried
 * @property {(seconds: number) => Promise<void>} sleep a pause that ends at once on Stop
 * @property {readonly number[]} [backoffS] test mode only: the waits before retries 1, 2, 3
 *   (`lib/pacing.RETRY_BACKOFF_S` otherwise)
 *
 * @typedef {object} Progress What a running download tells the page (at most 4×/s shown).
 * @property {number} received bytes received
 * @property {number | null} total bytes expected, when known
 * @property {{ done: number, total: number } | null} segments HLS: segments done / total
 * @property {number} bytesPerS
 *
 * @typedef {{ code: "no_audio" | "browser_unreadable" | "cover", params: Record<string, unknown> }}
 *   Note An informational line of a finished row (`cover`: the file was saved without its cover,
 *   `params.reason` says why).
 *
 * @typedef {import("../lib/remux.js").Mp4Meta} Mp4Meta
 * @typedef {{ bytes: Uint8Array, type: "jpeg" | "png" }} Cover
 *
 * @typedef {object} Verify What the verification found (the report and the history keep it).
 * @property {boolean} progressive
 * @property {{ kind: string, codec: string, duration_s: number, samples: number }[]} tracks
 * @property {number} duration_s
 * @property {number | null} expected_duration_s
 * @property {number | null} browser_duration_s
 * @property {string | null} title the `©nam` the file carries
 * @property {{ type: string, bytes: number } | null} cover the `covr` the file carries
 *
 * @typedef {object} ImageTools What {@link jpegFromImage} needs of the browser (the page's own
 *   `createImageBitmap` and `OffscreenCanvas`; fakes in the unit tests).
 * @property {(blob: Blob) => Promise<{ width: number, height: number, close?: () => void }>}
 *   createImageBitmap
 * @property {new (width: number, height: number) => {
 *   getContext(kind: "2d"): { drawImage(image: unknown, x: number, y: number): void } | null,
 *   convertToBlob(options: { type: string, quality: number }): Promise<Blob> }} OffscreenCanvas
 *
 * @typedef {object} Result The outcome of one target.
 * @property {Status} status
 * @property {Failure | null} failure
 * @property {string | null} path where Chrome saved the file (or found it)
 * @property {number} bytes the saved file's size
 * @property {number | null} durationS the saved file's duration
 * @property {Attempt[]} attempts the downloader's requests
 * @property {Verify | null} verify
 * @property {Note[]} notes
 * @property {boolean} contacted whether a request went out
 *
 * @typedef {object} DownloadContext
 * @property {NetContext} net
 * @property {import("../lib/pacing.js").PacingSettings} pacing
 * @property {() => number} [rng]
 * @property {WorkFiles} files
 * @property {DownloadsView} view
 * @property {(blob: Blob, filename: string) => Promise<chrome.downloads.DownloadItem>} save
 * @property {(site: SiteName) => Promise<void>} applyReferer
 * @property {(target: Target) => Promise<RefreshResult>} refresh fresh URLs, once per video
 * @property {() => Promise<void>} pagePause before a playlist request the download makes itself
 * @property {(blob: Blob) => Promise<number | null>} [browserCheck] the browser's own reading of
 *   the file's duration (informational)
 * @property {"embed" | "none"} [cover] the `cover` setting: `embed` (the default) asks for the
 *   target's cover once its media is complete and embeds it with the title; `none` asks for no
 *   cover (the title is still embedded)
 * @property {(image: Blob) => Promise<Uint8Array>} [toJpeg] converts a cover the MP4 cannot carry
 *   as served (WebP, …) to JPEG — {@link jpegFromImage} in the page; without it such a cover is
 *   left out (and the row says why)
 * @property {(progress: Progress) => void} [onProgress]
 * @property {(status: Status) => void} [onStatus]
 * @property {() => number} [now] milliseconds (`Date.now`)
 */

/** The id of the one session rule. */
export const REFERER_RULE_ID = 1;
/** The origin each site's player sends as `Referer`. */
export const SITE_ORIGINS = Object.freeze(
  /** @type {Record<SiteName, string>} */ ({
    dailymotion: "https://www.dailymotion.com",
    bilibili: "https://www.bilibili.com",
    bilibilitv: "https://www.bilibili.tv",
  }),
);
/**
 * The domains (and their subdomains) whose requests by the extension carry the site's `Referer`:
 * the media hosts of the manifest's host permissions (a Bilibili.tv rule also covers its API, which
 * wants the same `Referer`, and the shared Bilibili CDNs its media may come from). Dailymotion's
 * player metadata, HLS master and media playlists live on the same `dailymotion.com` domain as its
 * media, so the extension's own requests for them carry the same `Referer` (and no `Origin`) —
 * what the site's player sends when it asks for them; the rule never touches another initiator.
 */
export const MEDIA_DOMAINS = Object.freeze(
  /** @type {Record<SiteName, readonly string[]>} */ ({
    dailymotion: Object.freeze(["dailymotion.com", "dmcdn.net"]),
    bilibili: Object.freeze([
      "bilivideo.com",
      "bilivideo.cn",
      "upos-hz-mirrorakam.akamaized.net",
      "hdslb.com",
    ]),
    bilibilitv: Object.freeze([
      "bilibili.tv",
      "biliintl.com",
      "bstarstatic.com",
      "upos-bstar1-mirrorakam.akamaized.net",
      "bilivideo.com",
      "bilivideo.cn",
    ]),
  }),
);
/** Request kinds whose 403 means "blocked" (stop + cooldown) rather than an expired media URL. */
export const DOCUMENT_KINDS = Object.freeze(
  new Set(["page", "short link", "metadata", "manifest", "playlist"]),
);
/** The largest page, playlist or JSON answer read into memory. */
export const MAX_TEXT_BYTES = 16 * 1024 * 1024;
/** The largest HLS segment read into memory before it is demuxed or appended. */
export const MAX_SEGMENT_BYTES = 256 * 1024 * 1024;
/** How much of a DASH file's start is kept to find its `moov` for the DRM check. */
export const HEAD_BYTES = 4 * 1024 * 1024;
/** The browser decoder check's timeout. */
export const BROWSER_CHECK_TIMEOUT_S = 10;
/** The duration tolerance: max(3 s, 5 %) of the site's duration. */
export const DURATION_TOLERANCE_S = 3;
export const DURATION_TOLERANCE_RATIO = 0.05;
/** How far `mp4.probe`'s reading of a written track may be from what the writer wrote. */
export const WRITER_TOLERANCE_S = 0.002;
/**
 * The longest step between two consecutive samples of a track that is not a hole: a step longer
 * than {@link GAP_FACTOR} typical steps and {@link GAP_TOLERANCE_S} is media the file lacks (a
 * segment lost to an error page, a fragment that never came) — the file is never saved as the
 * video, even when its end-to-end duration still matches the site's.
 */
export const GAP_TOLERANCE_S = 0.5;
export const GAP_FACTOR = 4;
/** After the MPEG-TS demuxer met damaged data, any step longer than 1.5 typical ones is a hole. */
export const DAMAGED_GAP_FACTOR = 1.5;
/** The size of an MPEG-TS packet; a TS segment starts with one (sync byte `0x47`). */
const TS_PACKET_BYTES = 188;
/** The largest cover image read (a bigger one is left out; an embedded one must still fit
 * `lib/remux.MAX_COVER_BYTES`, after a conversion to JPEG if one is needed). */
export const MAX_COVER_DOWNLOAD_BYTES = 16 * 1024 * 1024;
/** The JPEG quality of a cover converted from another format (WebP, …). */
export const COVER_JPEG_QUALITY = 0.92;

// ---------------------------------------------------------------------------- errors

/** A failed step: the failure the row records, and whether a retry or a refresh may help. */
export class StepFailure extends Error {
  /**
   * @param {Failure} fail
   * @param {{ retryable?: boolean, expired?: boolean }} [options]
   */
  constructor(fail, options = {}) {
    super(render(fail.code, fail.params));
    this.name = "StepFailure";
    this.failure = fail;
    this.retryable = options.retryable ?? false;
    this.expired = options.expired ?? false;
  }
}

/** The reason a run's signal is aborted with when the user presses Stop. */
export class StopRequested extends Error {
  /** @param {string} [reason] a `lib/messages.js` stop reason */
  constructor(reason = "user") {
    super(`stopped: ${reason}`);
    this.name = "StopRequested";
    this.reason = reason;
  }
}

/**
 * Whether an error is the run's Stop (its signal aborted), not a failure of the step.
 * @param {unknown} error
 * @param {{ signal: AbortSignal }} net
 * @returns {boolean}
 */
export function isStop(error, net) {
  return error instanceof StopRequested || net.signal.aborted;
}

/**
 * An error as one safe line: its message, else its name; never a URL's query.
 * @param {unknown} error
 * @returns {string}
 */
export function oneLine(error) {
  const text = error instanceof Error ? error.message || error.name : String(error);
  return text.replace(/\?[^\s"')]*/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

// ------------------------------------------------------------------------ host checks

/**
 * Whether a URL is covered by one of the manifest's host permission patterns
 * (`<scheme>://<host>/<path>`; `*.` host prefix = that domain and its subdomains; the port is not
 * part of a pattern). A URL outside them is never requested.
 * @param {string} url
 * @param {readonly string[]} patterns
 * @returns {boolean}
 */
export function hostCovered(url, patterns) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  const host = parsed.hostname.toLowerCase();
  for (const pattern of patterns) {
    const match = /^(\*|https?):\/\/([^/]+)\//.exec(pattern);
    if (match === null) continue;
    const patternScheme = /** @type {string} */ (match[1]);
    const patternHost = /** @type {string} */ (match[2]).toLowerCase().replace(/:\d+$/, "");
    if (patternScheme === "*" ? !["http", "https"].includes(scheme) : patternScheme !== scheme) {
      continue;
    }
    if (patternHost === "*") return true;
    if (patternHost.startsWith("*.")) {
      const domain = patternHost.slice(2);
      if (host === domain || host.endsWith(`.${domain}`)) return true;
    } else if (host === patternHost) {
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------- the Referer rule

/**
 * The session rule of the extension's own requests to a site's media hosts: `Referer` set to the
 * site's origin (`https://www.bilibili.com/`) and `Origin` removed — what the site's own player
 * sends. Its initiator is the extension itself, so no request of any web page is ever touched;
 * production covers the site's {@link MEDIA_DOMAINS}, test mode every request to the fake sites'
 * origin, with the fake site's base as the `Referer`.
 * @param {SiteName} site
 * @param {string | null} [testBase] test mode: the fake site's base (`http://127.0.0.1:8123/bili`)
 * @returns {chrome.declarativeNetRequest.Rule}
 */
export function refererRule(site, testBase = null) {
  const base = testBase ? testBase.replace(/\/+$/, "") : SITE_ORIGINS[site];
  /** @type {chrome.declarativeNetRequest.RuleCondition} */
  const condition = {
    initiatorDomains: [chrome.runtime.id],
    resourceTypes: ["xmlhttprequest", "media", "other"],
  };
  if (testBase) condition.urlFilter = `|${new URL(base).origin}/`;
  else condition.requestDomains = [...MEDIA_DOMAINS[site]];
  return {
    id: REFERER_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Referer", operation: "set", value: `${base}/` },
        { header: "Origin", operation: "remove" },
      ],
    },
    condition,
  };
}

/**
 * Install (or replace) {@link refererRule} for `site`. Session rules end with the browser.
 * @param {SiteName} site
 * @param {string | null} [testBase]
 * @returns {Promise<void>}
 */
export async function applyRefererRule(site, testBase = null) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [REFERER_RULE_ID],
    addRules: [refererRule(site, testBase)],
  });
}

// --------------------------------------------------------------------------- requests

/**
 * A fresh attempt record (the report's `Attempt`); the URL keeps its query only in memory — the
 * report strips it.
 * @param {string} url
 * @param {string | null} range
 * @returns {Attempt}
 */
export function newAttempt(url, range) {
  return {
    url,
    host: hostOf(url),
    requested: false,
    http_status: null,
    content_type: null,
    content_length: null,
    received_bytes: null,
    range,
    outcome: "pending",
  };
}

/**
 * The numeric `Content-Length` of an identity-encoded body, or null (absent, not a number, or
 * under another `Content-Encoding`, where it counts the encoded stream).
 * @param {{ get(name: string): string | null }} headers
 * @returns {number | null}
 */
export function contentLength(headers) {
  const encoding = (headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  if (encoding !== "" && encoding !== "identity") return null;
  const raw = headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * `Content-Range: bytes <start>-<end>/<total>` parsed, or null.
 * @param {string | null} header
 * @returns {{ start: number, end: number, total: number | null } | null}
 */
export function contentRange(header) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec((header ?? "").trim());
  if (match === null) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === "*" ? null : Number(match[3]),
  };
}

/**
 * @typedef {object} Opened An answered request whose body is still to be read.
 * @property {Response} response
 * @property {Attempt} attempt
 * @property {AbortController} controller aborts the body
 * @property {() => void} release
 */

/**
 * One GET by the network rules (module doc): the host checked, the answer's status classified.
 * Throws a {@link StepFailure} (or the run's stop). The body is left to the caller.
 * @param {string} url
 * @param {RequestKind} kind
 * @param {NetContext} net
 * @param {Attempt[]} attempts where the attempt is recorded
 * @param {{ range?: string | null, accept?: string }} [options]
 * @returns {Promise<Opened>}
 */
export async function request(url, kind, net, attempts, options = {}) {
  const attempt = newAttempt(url, options.range ?? null);
  attempts.push(attempt);
  if (net.signal.aborted) throw net.signal.reason ?? new StopRequested();
  if (!hostCovered(url, net.hostPatterns)) {
    attempt.outcome = "not requested: host not covered";
    throw new StepFailure(failure("host_not_covered", { host: hostOf(url) }));
  }
  attempt.requested = true;
  const controller = new AbortController();
  const onStop = () => controller.abort(net.signal.reason);
  net.signal.addEventListener("abort", onStop, { once: true });
  const release = () => net.signal.removeEventListener("abort", onStop);
  /** @type {Record<string, string>} */
  const headers = {};
  if (options.range) headers["Range"] = options.range;
  if (options.accept) headers["Accept"] = options.accept;
  let stalled = false;
  const timer = setTimeout(() => {
    stalled = true;
    controller.abort(new Error("stalled"));
  }, net.stallMs);
  /** @type {Response} */
  let response;
  try {
    response = await net.fetch(url, {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    release();
    if (net.signal.aborted) throw net.signal.reason ?? new StopRequested();
    attempt.outcome = stalled ? "stalled before an answer" : `no response: ${oneLine(error)}`;
    const detail = stalled ? `no answer for ${Math.round(net.stallMs / 1000)} s` : oneLine(error);
    throw new StepFailure(failure("no_response", { detail }), { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  attempt.http_status = response.status;
  attempt.content_type = response.headers.get("content-type");
  attempt.content_length = contentLength(response.headers);
  /** @param {string} outcome */
  const refuse = (outcome) => {
    attempt.outcome = outcome;
    controller.abort();
    release();
  };
  if (response.url && response.url !== url && !hostCovered(response.url, net.hostPatterns)) {
    refuse("redirect refused");
    throw new StepFailure(failure("redirect_refused", { host: hostOf(response.url) }));
  }
  const status = response.status;
  if (status === 200 || status === 206) return { response, attempt, controller, release };
  const detail = `HTTP ${status} (${kind})`;
  if (status === 429 || status === 412) {
    refuse("refused: rate limited");
    throw new StepFailure(failure("rate_limited", { detail }));
  }
  const document = DOCUMENT_KINDS.has(kind);
  if (status === 401 && document) {
    refuse("refused: login required");
    throw new StepFailure(failure("login_required"));
  }
  if (status === 403 && document) {
    refuse("refused: blocked");
    throw new StepFailure(failure("blocked", { detail }));
  }
  if (!document && (status === 403 || status === 404 || status === 410)) {
    refuse(`refused: HTTP ${status}`);
    throw new StepFailure(failure("http_status", { status, what: kind }), { expired: true });
  }
  if (status >= 500 || status === 408) {
    refuse(`retry: HTTP ${status}`);
    throw new StepFailure(failure("http_status", { status, what: kind }), { retryable: true });
  }
  refuse(`refused: HTTP ${status}`);
  throw new StepFailure(failure("http_status", { status, what: kind }));
}

/**
 * Read an answer's body chunk by chunk: each chunk to `onChunk`, a stall of `net.stallMs` aborts
 * (retryable), a cut stream or a body shorter than its `Content-Length` is `truncated_body`
 * (retryable), more than `maxBytes` stops reading. Resolves to the bytes read.
 * @param {Opened} opened
 * @param {NetContext} net
 * @param {(chunk: Uint8Array) => Promise<void> | void} onChunk
 * @param {{ maxBytes?: number, expected?: number | null }} [options]
 * @returns {Promise<number>}
 */
export async function readBody(opened, net, onChunk, options = {}) {
  const { response, attempt, controller } = opened;
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const expected = options.expected === undefined ? attempt.content_length : options.expected;
  let received = 0;
  if (response.body === null) {
    opened.release();
    attempt.received_bytes = 0;
    attempt.outcome = "ok";
    return 0;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const stall = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("stalled")), net.stallMs);
      });
      /** @type {ReadableStreamReadResult<Uint8Array>} */
      let step;
      try {
        step = /** @type {ReadableStreamReadResult<Uint8Array>} */ (
          await Promise.race([reader.read(), stall])
        );
      } catch (error) {
        if (net.signal.aborted) throw net.signal.reason ?? new StopRequested();
        const stalled = error instanceof Error && error.message === "stalled";
        attempt.received_bytes = received;
        attempt.outcome = `${stalled ? "stalled" : "cut"} after ${received} bytes`;
        if (stalled) {
          throw new StepFailure(
            failure("no_response", { detail: `no data for ${Math.round(net.stallMs / 1000)} s` }),
            { retryable: true },
          );
        }
        throw new StepFailure(
          failure("truncated_body", { received, expected: expected ?? "?" }),
          { retryable: true },
        );
      } finally {
        clearTimeout(timer);
      }
      if (step.done) break;
      const chunk = step.value;
      if (received + chunk.length > maxBytes) {
        await onChunk(chunk.subarray(0, maxBytes - received));
        received = maxBytes;
        break;
      }
      received += chunk.length;
      await onChunk(chunk);
    }
  } finally {
    reader.cancel().catch(() => undefined);
    controller.abort();
    opened.release();
  }
  attempt.received_bytes = received;
  if (expected !== null && received < expected && received < maxBytes) {
    attempt.outcome = `cut after ${received} bytes`;
    throw new StepFailure(failure("truncated_body", { received, expected }), { retryable: true });
  }
  attempt.outcome = "ok";
  return received;
}

/**
 * @param {Uint8Array[]} chunks
 * @param {number} total
 * @returns {Uint8Array}
 */
function joinChunks(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The wait before retry number `retry` (1-based): the test mode's table when it has one, else
 * `lib/pacing.retryBackoffS` (1, 2, 4 s).
 * @param {NetContext} net
 * @param {number} retry
 * @returns {number}
 */
export function backoffOf(net, retry) {
  const own = net.backoffS?.[Math.min(retry, net.backoffS.length) - 1];
  return typeof own === "number" ? own : retryBackoffS(retry);
}

/**
 * Run a step, retrying it on a retryable failure: at most {@link MAX_RETRIES} retries, waiting
 * 1, 2, 4 s before them.
 * @template T
 * @param {(retry: number) => Promise<T>} step
 * @param {NetContext} net
 * @returns {Promise<T>}
 */
export async function withRetries(step, net) {
  for (let retry = 0; ; retry += 1) {
    try {
      return await step(retry);
    } catch (error) {
      if (!(error instanceof StepFailure) || !error.retryable || retry >= MAX_RETRIES) throw error;
      await net.sleep(backoffOf(net, retry + 1));
    }
  }
}

/**
 * A whole answer in memory (a segment, an init section), retried by the rules; with a byte range
 * the `Range` header asks for it (`206` expected; a `200` with the whole file is sliced).
 * @param {string} url
 * @param {RequestKind} kind
 * @param {NetContext} net
 * @param {Attempt[]} attempts
 * @param {{ accept?: string, byteRange?: HlsByteRange | null, maxBytes?: number,
 *   check?: (bytes: Uint8Array) => string | null }} [options] `check` names what is wrong with a
 *   complete answer (an error page or an empty body served with a 200 where media belongs): the
 *   answer is `not_a_video`, retried by the rules
 * @returns {Promise<{ bytes: Uint8Array, url: string, contentType: string, attempt: Attempt }>}
 */
export async function fetchBytes(url, kind, net, attempts, options = {}) {
  const byteRange = options.byteRange ?? null;
  const range =
    byteRange === null
      ? null
      : `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
  return withRetries(async () => {
    /** @type {{ range: string | null, accept?: string }} */
    const requestOptions = { range };
    if (options.accept !== undefined) requestOptions.accept = options.accept;
    const opened = await request(url, kind, net, attempts, requestOptions);
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    await readBody(
      opened,
      net,
      (chunk) => {
        chunks.push(chunk.slice());
        total += chunk.length;
      },
      { maxBytes: options.maxBytes ?? MAX_TEXT_BYTES },
    );
    let bytes = joinChunks(chunks, total);
    if (byteRange !== null && opened.response.status === 200) {
      bytes = bytes.slice(byteRange.offset, byteRange.offset + byteRange.length);
    }
    if (byteRange !== null && bytes.length < byteRange.length) {
      opened.attempt.outcome = `cut after ${bytes.length} bytes`;
      throw new StepFailure(
        failure("truncated_body", { received: bytes.length, expected: byteRange.length }),
        { retryable: true },
      );
    }
    const wrong = options.check?.(bytes) ?? null;
    if (wrong !== null) {
      opened.attempt.outcome = `refused: ${wrong}`;
      const type = opened.attempt.content_type;
      const shown = type ? `${type} (${wrong})` : wrong;
      const contentType = bytes.length === 0 ? "an empty body" : shown;
      throw new StepFailure(failure("not_a_video", { content_type: contentType }), {
        retryable: true,
      });
    }
    return {
      bytes,
      url: opened.response.url || url,
      contentType: opened.attempt.content_type ?? "",
      attempt: opened.attempt,
    };
  }, net);
}

/**
 * A page, a playlist or a JSON answer as text (UTF-8), retried by the rules.
 * @param {string} url
 * @param {RequestKind} kind
 * @param {NetContext} net
 * @param {Attempt[]} attempts
 * @param {{ accept?: string }} [options]
 * @returns {Promise<{ text: string, url: string, contentType: string, attempt: Attempt }>}
 */
export async function fetchText(url, kind, net, attempts, options = {}) {
  const answer = await fetchBytes(url, kind, net, attempts, {
    ...options,
    maxBytes: MAX_TEXT_BYTES,
  });
  return {
    text: new TextDecoder("utf-8").decode(answer.bytes),
    url: answer.url,
    contentType: answer.contentType,
    attempt: answer.attempt,
  };
}

// ------------------------------------------------------------------------ playlists

/**
 * The `METHOD` of the first protecting `#EXT-X-KEY` of a playlist, or null.
 * @param {string} text
 * @returns {string | null}
 */
export function keyMethodOf(text) {
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line.startsWith("#EXT-X-KEY:")) continue;
    const method = /METHOD=([^,\s]+)/i.exec(line)?.[1] ?? null;
    if (method === null || method.toUpperCase() !== "NONE") return method;
  }
  return null;
}

/**
 * The refusal a media playlist earns before any media request: key-protected, live, spliced, or
 * empty; null when it can be downloaded.
 * @param {HlsMedia} media
 * @param {string | null} keyMethod
 * @returns {Failure | null}
 */
export function mediaProblem(media, keyMethod) {
  if (media.keyProtected) return failure("key_protected", { method: keyMethod ?? "?" });
  if (!media.endList) return failure("live_stream");
  if (media.discontinuities > 0) {
    return failure("discontinuous_stream", { count: media.discontinuities });
  }
  if (media.segments.length === 0) {
    return failure("no_streams", { detail: "the playlist lists no segment" });
  }
  return null;
}

// --------------------------------------------------------------- Chrome's downloads

/**
 * Chrome re-checks whether its downloaded files still exist at most once every 10 s (its
 * `kFileExistenceRateLimitSeconds`); a search sooner than that reads the old answer.
 */
export const EXISTENCE_CHECK_RATE_LIMIT_S = 10;

/**
 * @param {string} text
 * @returns {string} `text` with every regular-expression character escaped
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The regular expression `chrome.downloads.search` matches a target path with, below any
 * Downloads folder and with Windows' backslashes: `(^|[\\/])StreamFetch[\\/]Dailymotion[\\/]…$`.
 * @param {string} relative
 * @returns {string}
 */
export function pathRegex(relative) {
  return `(^|[\\\\/])${relative.split("/").map(escapeRegExp).join("[\\\\/]")}$`;
}

/** What Chrome's download history says of the files already saved (the `skipped-exists` check). */
export class DownloadsView {
  /**
   * @param {{ api?: typeof chrome.downloads, sleep?: (seconds: number) => Promise<void>,
   *   rateLimitS?: number, existenceDelayMs?: number, now?: () => number }} [options]
   *   `rateLimitS`: Chrome's {@link EXISTENCE_CHECK_RATE_LIMIT_S} (0 in tests: never wait)
   */
  constructor(options = {}) {
    this.api = options.api ?? chrome.downloads;
    this.sleep =
      options.sleep ?? ((seconds) => new Promise((done) => setTimeout(done, seconds * 1000)));
    this.rateLimitS = options.rateLimitS ?? EXISTENCE_CHECK_RATE_LIMIT_S;
    this.existenceDelayMs = options.existenceDelayMs ?? 300;
    this.now = options.now ?? (() => Date.now());
    /** when this view last made Chrome re-check its files (ms), -Infinity before */
    this.lastCheckMs = Number.NEGATIVE_INFINITY;
  }

  /**
   * Make Chrome re-check whether its files still exist (waiting out its rate limit first), then
   * read the newest completed download that still exists exactly at `relative`, or null.
   * @param {string} relative `StreamFetch/<site>/<file>.mp4`
   * @returns {Promise<chrome.downloads.DownloadItem | null>}
   */
  async completedAt(relative) {
    if (this.rateLimitS > 0) {
      const allowedAt = (Math.floor(this.lastCheckMs / 1000) + this.rateLimitS + 1) * 1000;
      const wait = allowedAt - this.now();
      if (wait > 0) await this.sleep(wait / 1000);
    }
    this.lastCheckMs = this.now();
    await this.api.search({ limit: 1 });
    if (this.existenceDelayMs > 0) await this.sleep(this.existenceDelayMs / 1000);
    const items = await this.api.search({ filenameRegex: pathRegex(relative), state: "complete" });
    /** @type {chrome.downloads.DownloadItem | null} */
    let found = null;
    for (const item of items) {
      if (item.state !== "complete" || !item.exists) continue;
      const path = item.filename.replace(/\\/g, "/");
      if (path !== relative && !path.endsWith(`/${relative}`)) continue;
      if (found === null || item.id > found.id) found = item;
    }
    return found;
  }
}

/** A save Chrome refused or interrupted; the message is Chrome's reason. */
export class SaveError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SaveError";
  }
}

/**
 * Wait until a download leaves `in_progress` (`onChanged`, and one look right away).
 * @param {number} id
 * @param {typeof chrome.downloads} api
 * @returns {Promise<chrome.downloads.DownloadItem>}
 */
function waitForDownload(id, api) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = async () => {
      try {
        const [item] = await api.search({ id });
        if (settled) return;
        if (item === undefined) {
          settled = true;
          api.onChanged.removeListener(listener);
          reject(new SaveError("the download disappeared"));
        } else if (item.state !== "in_progress") {
          settled = true;
          api.onChanged.removeListener(listener);
          resolve(item);
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          api.onChanged.removeListener(listener);
          reject(error);
        }
      }
    };
    /** @param {chrome.downloads.DownloadDelta} delta */
    const listener = (delta) => {
      if (delta.id === id && delta.state !== undefined) void settle();
    };
    api.onChanged.addListener(listener);
    void settle();
  });
}

/**
 * Save a blob through `chrome.downloads` at `filename` (relative to the Downloads folder;
 * `uniquify`: never overwrite a file; no Save As dialog), wait for it to complete, and return
 * what Chrome saved.
 * @param {Blob} blob
 * @param {string} filename
 * @param {typeof chrome.downloads} [api]
 * @returns {Promise<chrome.downloads.DownloadItem>}
 */
export async function saveBlob(blob, filename, api = chrome.downloads) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await api.download({ url, filename, conflictAction: "uniquify", saveAs: false });
    const item = await waitForDownload(id, api);
    if (item.state !== "complete") throw new SaveError(item.error || "INTERRUPTED");
    return item;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The browser's own reading of a file's duration: an offscreen `<video preload="metadata">` on a
 * blob URL, at most `timeoutS`. Null when it cannot read it (informational only).
 * @param {Blob} blob
 * @param {number} [timeoutS]
 * @returns {Promise<number | null>}
 */
export function browserDuration(blob, timeoutS = BROWSER_CHECK_TIMEOUT_S) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(blob);
    let done = false;
    /** @param {number | null} value */
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutS * 1000);
    video.preload = "metadata";
    video.muted = true;
    video.addEventListener("loadedmetadata", () =>
      finish(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null),
    );
    video.addEventListener("error", () => finish(null));
    video.src = url;
  });
}

// ---------------------------------------------------------------------- cover and title

/**
 * The URL a cover is asked for: as given, or — for an `http:` URL the manifest does not cover
 * whose `https:` twin it does (Bilibili's `pic` is often `http://i0.hdslb.com/…`) — that twin, the
 * same image over TLS. Any other URL as given (the host check then refuses it).
 * @param {string} url
 * @param {readonly string[]} patterns the manifest's host permissions
 * @returns {string}
 */
export function coverUrl(url, patterns) {
  if (hostCovered(url, patterns) || !/^http:\/\//i.test(url)) return url;
  const secure = `https://${url.slice("http://".length)}`;
  return hostCovered(secure, patterns) ? secure : url;
}

/**
 * The browser's own image tools of the page (`createImageBitmap`, `OffscreenCanvas`), or null
 * where there are none (Node).
 * @returns {ImageTools | null}
 */
function pageImageTools() {
  const scope = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
  const decode = scope["createImageBitmap"];
  const canvas = scope["OffscreenCanvas"];
  if (typeof decode !== "function" || typeof canvas !== "function") return null;
  return /** @type {ImageTools} */ (
    /** @type {unknown} */ ({ createImageBitmap: decode.bind(globalThis), OffscreenCanvas: canvas })
  );
}

/**
 * An image converted to JPEG by the browser itself — decoded with `createImageBitmap`, drawn on an
 * `OffscreenCanvas` of its own size, encoded with `convertToBlob({ type: "image/jpeg", quality:
 * 0.92 })` — for a cover served in a format the MP4's `covr` cannot carry (WebP, AVIF, GIF…).
 * Throws when the browser cannot decode or encode it.
 * @param {Blob} image
 * @param {ImageTools | null} [tools] the page's own by default
 * @returns {Promise<Uint8Array>}
 */
export async function jpegFromImage(image, tools = pageImageTools()) {
  if (tools === null) throw new Error("this page cannot convert images");
  const bitmap = await tools.createImageBitmap(image);
  try {
    const canvas = new tools.OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2D canvas to convert the image");
    context.drawImage(bitmap, 0, 0);
    const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: COVER_JPEG_QUALITY });
    return new Uint8Array(await jpeg.arrayBuffer());
  } finally {
    bitmap.close?.();
  }
}

/**
 * Why a cover request gave no image, in a few words (the row's `; cover: <reason>`): the site's
 * refusal of a cover is never a stop, so its run-stopping wording is not used.
 * @param {unknown} error
 * @returns {string}
 */
export function coverFailureReason(error) {
  if (!(error instanceof StepFailure)) return oneLine(error);
  const params = error.failure.params;
  switch (error.failure.code) {
    case "host_not_covered":
      return (
        `the image is on ${String(params["host"])}, ` +
        "a host the extension has no permission for"
      );
    case "redirect_refused":
      return `a redirect led to ${String(params["host"])}`;
    case "http_status":
      return `HTTP ${String(params["status"])}`;
    case "rate_limited":
    case "blocked":
      return String(params["detail"] ?? error.failure.code).replace(/\s*\(cover\)$/, "");
    case "no_response":
      return `no answer (${String(params["detail"] ?? "?")})`;
    case "truncated_body":
      return "the transfer was cut short";
    default:
      return oneLine(error);
  }
}

/**
 * The title a target's file carries (`©nam`): a Bilibili.tv episode's own title, a Bilibili part's
 * `<title> — P<nn> <part title>`, else the video's title.
 * @param {Target} target
 * @returns {string}
 */
export function embeddedTitle(target) {
  if (target.site === "bilibilitv") return (target.partTitle || target.title || target.id).trim();
  const title = (target.title || target.id).trim();
  if (target.site !== "bilibili" || target.part === null || (target.partCount ?? 2) < 2) {
    return title;
  }
  const own = (target.partTitle ?? "").trim();
  const label = partLabel(target.part);
  return own && own !== title ? `${title} — ${label} ${own}` : `${title} — ${label}`;
}

/**
 * The cover of a target for its MP4: ONE request, after a media pause, outside the media budget —
 * never retried, and a refusal of it (a 429, a 403) is no stop and records no cooldown —, a JPEG
 * or PNG embedded as served, anything else converted to JPEG (`ctx.toJpeg`); at most
 * {@link MAX_COVER_DOWNLOAD_BYTES} read and `lib/remux.MAX_COVER_BYTES` (5 MiB) embedded
 * (`lib/remux.coverProblem` says why a cover cannot be). Resolves to the
 * cover, or to the reason there is none; only the run's Stop is thrown.
 * @param {string} url the cover the page or the metadata names
 * @param {DownloadContext} ctx
 * @param {Attempt[]} attempts the download's requests (the report lists the cover's too)
 * @param {{ count: number }} counter
 * @returns {Promise<{ cover: Cover } | { reason: string }>}
 */
export async function fetchCoverImage(url, ctx, attempts, counter) {
  try {
    await mediaPause(ctx, counter);
    const opened = await request(coverUrl(url, ctx.net.hostPatterns), "cover", ctx.net, attempts, {
      accept: "image/*",
    });
    const contentType = opened.attempt.content_type ?? "";
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    await readBody(
      opened,
      ctx.net,
      (chunk) => {
        chunks.push(chunk.slice());
        total += chunk.length;
      },
      { maxBytes: MAX_COVER_DOWNLOAD_BYTES + 1 },
    );
    if (total > MAX_COVER_DOWNLOAD_BYTES) {
      return { reason: `the image is larger than ${MAX_COVER_DOWNLOAD_BYTES} bytes` };
    }
    if (total === 0) return { reason: "the image is empty" };
    let bytes = joinChunks(chunks, total);
    let type = imageType(bytes);
    if (type === null) {
      if (ctx.toJpeg === undefined) return { reason: "the image cannot be converted to JPEG here" };
      const served = /** @type {BlobPart} */ (bytes);
      try {
        bytes = await ctx.toJpeg(new Blob([served], { type: contentType }));
      } catch (error) {
        const what = contentType.split(";")[0]?.trim() || "the image";
        return { reason: `${what} could not be converted to JPEG (${oneLine(error)})` };
      }
      type = imageType(bytes) === "jpeg" ? "jpeg" : null;
      if (type === null) return { reason: "the conversion to JPEG gave no JPEG image" };
    }
    /** @type {Cover} */
    const cover = { bytes, type };
    const problem = coverProblem(cover);
    return problem === null ? { cover } : { reason: problem };
  } catch (error) {
    if (isStop(error, ctx.net)) throw error;
    return { reason: coverFailureReason(error) };
  }
}

/**
 * What the file of a target carries besides its media: the title always, the cover when the
 * `cover` setting embeds it and the target names one (a cover that could not be had becomes a
 * `cover` note: the video is still saved).
 * @param {Target} target
 * @param {DownloadContext} ctx
 * @param {Attempt[]} attempts
 * @param {{ count: number }} counter
 * @param {Note[]} notes
 * @returns {Promise<Mp4Meta>}
 */
async function fileMeta(target, ctx, attempts, counter, notes) {
  /** @type {Mp4Meta} */
  const meta = {};
  const title = embeddedTitle(target);
  if (title) meta.title = title;
  if ((ctx.cover ?? "embed") !== "embed" || !target.cover) return meta;
  const got = await fetchCoverImage(target.cover, ctx, attempts, counter);
  if ("cover" in got) meta.cover = got.cover;
  else notes.push({ code: "cover", params: { reason: got.reason } });
  return meta;
}

/**
 * Whether the source of a target carries audio, as far as the site said before the download: a
 * DASH audio file, a separate HLS audio rendition, or an audio codec in the variant's `CODECS`.
 * @param {HlsChoice | DashChoice} streams
 * @returns {boolean}
 */
export function audioExpected(streams) {
  if (streams.kind === "dash") return streams.audio !== null;
  if (streams.audio !== null && streams.audio.url !== null) return true;
  return /(?:^|,)\s*(?:mp4a|ac-3|ec-3|opus)\b/i.test(streams.variant.codecs ?? "");
}

// ------------------------------------------------------------------------ the download

/** What the download's own requests are traced as, by target key (the report's attempts). */
const traces = new Map();

/**
 * Every request made for a target: the resolver's, then the downloader's last run of it.
 * @param {Target} target
 * @returns {Attempt[]}
 */
export function traceOf(target) {
  return [...target.attempts, ...(traces.get(target.key) ?? [])];
}

/**
 * The name fields `lib/naming.targetPath` reads of a target.
 * @param {Target} target
 * @returns {import("../lib/naming.js").NamingTarget}
 */
export function namingTarget(target) {
  return {
    site: target.site,
    id: target.id,
    title: target.title,
    part: target.part,
    partTitle: target.partTitle,
    partCount: target.partCount,
    seasonId: target.seasonId,
    episodeId: target.episodeId,
    seriesTitle: target.seriesTitle,
  };
}

/**
 * Where a target is saved, relative to the Downloads folder (`lib/naming.targetPath`).
 * @param {Target} target
 * @returns {string}
 */
export function pathOf(target) {
  return targetPath(namingTarget(target));
}

/**
 * The first top-level `moov` box of a file's head, when it is complete there; null otherwise.
 * @param {Uint8Array} head
 * @returns {Uint8Array | null}
 */
export function completeMoov(head) {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let at = 0;
  while (at + 8 <= head.length) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(...head.subarray(at + 4, at + 8));
    let header = 8;
    if (size === 1) {
      if (at + 16 > head.length) return null;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      return null; // runs to the end of the file: never a moov before its media
    }
    if (size < header) return null;
    if (type === "moov") return at + size <= head.length ? head.subarray(at, at + size) : null;
    at += size;
  }
  return null;
}

/** Tracks the progress of one download and tells the page. */
class ProgressMeter {
  /**
   * @param {DownloadContext} ctx
   * @param {number | null} total
   * @param {number | null} segments
   */
  constructor(ctx, total, segments) {
    this.ctx = ctx;
    this.now = ctx.now ?? (() => Date.now());
    this.started = this.now();
    this.received = 0;
    this.total = total;
    this.segments = segments === null ? null : { done: 0, total: segments };
  }

  /** @param {number} bytes */
  add(bytes) {
    this.received += bytes;
    this.emit();
  }

  segmentDone() {
    if (this.segments !== null) this.segments.done += 1;
    this.emit();
  }

  emit() {
    if (!this.ctx.onProgress) return;
    const seconds = Math.max(0.001, (this.now() - this.started) / 1000);
    this.ctx.onProgress({
      received: this.received,
      total: this.total,
      segments: this.segments === null ? null : { ...this.segments },
      bytesPerS: this.received / seconds,
    });
  }
}

/**
 * The pause before every media request but the first of a download.
 * @param {DownloadContext} ctx
 * @param {{ count: number }} counter
 * @returns {Promise<void>}
 */
async function mediaPause(ctx, counter) {
  if (counter.count > 0) await ctx.net.sleep(mediaPauseMs(ctx.pacing, ctx.rng) / 1000);
  counter.count += 1;
}

/**
 * A media playlist fetched again at download time (the row's selection changed it).
 * @param {string} url
 * @param {DownloadContext} ctx
 * @param {Attempt[]} attempts
 * @returns {Promise<{ media: HlsMedia, keyMethod: string | null }>}
 */
async function fetchMediaPlaylist(url, ctx, attempts) {
  await ctx.pagePause();
  const answer = await fetchText(url, "playlist", ctx.net, attempts);
  return { media: parseMedia(answer.text, answer.url), keyMethod: keyMethodOf(answer.text) };
}

/**
 * @typedef {object} HlsTrackSource One media playlist being downloaded.
 * @property {"main" | "audio"} role the variant's playlist, or a separate audio rendition's
 * @property {HlsMedia} media
 */

/**
 * The HLS path: every segment of the variant's playlist (and of a separate audio rendition's), in
 * order, one request at a time; TS through the demuxer into sample files, fMP4 appended as served
 * and read back with `lib/mp4.collectMp4`. One refresh of the URLs per video on a refused segment.
 * @param {Target} target
 * @param {DownloadContext} ctx
 * @param {{ key: string, name: (part: string) => string }} work
 * @param {Attempt[]} attempts
 * @param {{ count: number }} counter
 * @param {{ corrupt: string | null }} health what the MPEG-TS demuxer found wrong (the first
 *   `corrupt_stream` detail): the download goes on and the verification decides
 * @returns {Promise<TrackPlan[]>}
 */
async function downloadHls(target, ctx, work, attempts, counter, health) {
  let streams = /** @type {HlsChoice} */ (target.streams);
  let raw = /** @type {HlsRaw} */ (target.raw);
  let keyMethod = raw.keyMethod;
  let media =
    raw.media !== null && raw.mediaUrl === streams.variant.url ? raw.media : null;
  if (media === null) {
    const fresh = await fetchMediaPlaylist(streams.variant.url, ctx, attempts);
    media = fresh.media;
    keyMethod ??= fresh.keyMethod;
  }
  const audioUrl = streams.audio?.url ?? null;
  /** @type {HlsMedia | null} */
  let audioMedia = null;
  if (audioUrl !== null) {
    audioMedia = raw.audioMedia !== null && raw.audioMediaUrl === audioUrl ? raw.audioMedia : null;
    if (audioMedia === null) {
      const fresh = await fetchMediaPlaylist(audioUrl, ctx, attempts);
      audioMedia = fresh.media;
      keyMethod ??= fresh.keyMethod;
    }
  }
  for (const one of [media, audioMedia]) {
    if (one === null) continue;
    const problem = mediaProblem(one, keyMethod);
    if (problem !== null) throw new StepFailure(problem);
  }
  /** @type {HlsTrackSource[]} */
  const sources = [{ role: "main", media }];
  if (audioMedia !== null) sources.push({ role: "audio", media: audioMedia });
  const total = sources.reduce((sum, source) => sum + source.media.segments.length, 0);
  const meter = new ProgressMeter(ctx, null, total);
  let refreshed = false;
  /**
   * Fresh segment lists for both playlists, once per video.
   * @param {StepFailure} cause
   */
  const refresh = async (cause) => {
    if (refreshed) throw cause;
    refreshed = true;
    const answer = await ctx.refresh({ ...target, streams, raw });
    if (!answer.ok) throw new StepFailure(answer.failure);
    if (answer.streams.kind !== "hls") throw cause;
    streams = answer.streams;
    raw = /** @type {HlsRaw} */ (answer.raw);
    target.streams = streams;
    target.raw = raw;
    const fresh = { main: raw.media, audio: raw.audioMedia };
    // the refreshed playlists pass the same refusals as the first ones, before any request
    for (const one of [fresh.main, fresh.audio]) {
      const problem = one === null ? null : mediaProblem(one, raw.keyMethod);
      if (problem !== null) throw new StepFailure(problem);
    }
    for (const source of sources) {
      const next = fresh[source.role];
      if (next === null || next.segments.length !== source.media.segments.length) {
        throw new StepFailure(
          failure("no_streams", { detail: "the refreshed playlist lists other segments" }),
        );
      }
      source.media = next;
    }
  };
  /**
   * One segment (or init section), refreshed once when the site refuses it.
   * @param {HlsTrackSource} source
   * @param {(media: HlsMedia) => { url: string, byteRange: HlsByteRange | null }} pick
   * @param {RequestKind} kind
   */
  const fetchPart = async (source, pick, kind) => {
    for (;;) {
      const { url, byteRange } = pick(source.media);
      await mediaPause(ctx, counter);
      try {
        const answer = await fetchBytes(url, kind, ctx.net, attempts, {
          byteRange,
          maxBytes: MAX_SEGMENT_BYTES,
          check: source.media.container === "ts" ? tsSegmentProblem : mp4SegmentProblem,
        });
        meter.add(answer.bytes.length);
        return answer.bytes;
      } catch (error) {
        if (!(error instanceof StepFailure) || !error.expired) throw error;
        await refresh(error);
      }
    }
  };
  /** @type {TrackPlan[]} */
  const plans = [];
  for (const source of sources) {
    if (source.media.container === "ts") {
      plans.push(...(await demuxSource(source, work, fetchPart, meter, attempts, health)));
    } else {
      const name = work.name(source.role === "main" ? "hls.m4s" : "hls-audio.m4s");
      const writer = await ctx.files.appendWriter(name);
      try {
        let first = true;
        if (source.media.init !== null) {
          /** @param {HlsMedia} current */
          const pickInit = (current) =>
            /** @type {{ url: string, byteRange: HlsByteRange | null }} */ (current.init);
          const init = await fetchPart(source, pickInit, "segment");
          const drm = drmProblem(init);
          if (drm !== null) throw new StepFailure(failure("encrypted", { detail: drm }));
          await writer.write(init);
          first = false;
        }
        for (let index = 0; index < source.media.segments.length; index += 1) {
          /** @param {HlsMedia} current */
          const pickSegment = (current) =>
            /** @type {import("../lib/hls.js").HlsSegment} */ (current.segments[index]);
          const bytes = await fetchPart(source, pickSegment, "segment");
          if (first) {
            const drm = drmProblem(bytes);
            if (drm !== null) throw new StepFailure(failure("encrypted", { detail: drm }));
            first = false;
          }
          await writer.write(bytes);
          meter.segmentDone();
        }
        await writer.close();
      } catch (error) {
        await writer.abort();
        throw error;
      }
      const tracks = await collectMp4(await ctx.files.slicer(name));
      const wanted =
        source.role === "main" ? tracks : tracks.filter((plan) => plan.kind === "audio");
      plans.push(...wanted);
    }
  }
  return pickTracks(plans);
}

/**
 * The failure of a stream whose codec the demuxer cannot handle (`unsupported_codec`).
 * @param {{ code: string, params: Record<string, unknown> }} problem
 * @returns {StepFailure}
 */
function unsupportedCodec(problem) {
  return new StepFailure(
    failure("unsupported_codec", { stream_type: problem.params["stream_type"] }),
  );
}

/**
 * The TS path of one playlist: every segment through one demuxer, the samples' bytes appended to
 * `<key>.video.bin` / `<key>.audio.bin` (`<key>.rendition.bin` for a separate audio rendition).
 * @param {HlsTrackSource} source
 * @param {{ key: string, name: (part: string) => string }} work
 * @param {(source: HlsTrackSource, pick: (media: HlsMedia) => { url: string,
 *   byteRange: HlsByteRange | null }, kind: RequestKind) => Promise<Uint8Array>} fetchPart
 * @param {ProgressMeter} meter
 * @param {Attempt[]} attempts the segment whose bytes were found damaged says so in its outcome
 * @param {{ corrupt: string | null }} health
 * @returns {Promise<TrackPlan[]>}
 */
async function demuxSource(source, work, fetchPart, meter, attempts, health) {
  const files = meter.ctx.files;
  /** @type {Map<"video" | "audio", { writer: AppendWriter | null, offset: number,
   *   pending: Uint8Array[] }>} */
  const sinks = new Map();
  const nameOf = (/** @type {"video" | "audio"} */ kind) =>
    work.name(source.role === "audio" ? "rendition.bin" : `${kind}.bin`);
  /** @type {{ code: string, params: Record<string, unknown> } | null} */
  let unsupported = null;
  const collector = tracksFromDemux(
    (kind, bytes) => {
      let sink = sinks.get(kind);
      if (sink === undefined) {
        sink = { writer: null, offset: 0, pending: [] };
        sinks.set(kind, sink);
      }
      const at = sink.offset;
      sink.offset += bytes.length;
      sink.pending.push(bytes);
      return { file: nameOf(kind), offset: at };
    },
    (code, params) => {
      if (code === "unsupported_codec" && unsupported === null) unsupported = { code, params };
      if (code === "corrupt_stream" && health.corrupt === null) {
        health.corrupt = String(params["detail"] ?? "damaged MPEG-TS data");
        const attempt = attempts.at(-1);
        if (attempt !== undefined) attempt.outcome = `${attempt.outcome}; ${health.corrupt}`;
      }
    },
  );
  const demuxer = new TsDemuxer(collector.hooks);
  const flush = async () => {
    for (const [kind, sink] of sinks) {
      if (sink.writer === null) sink.writer = await files.appendWriter(nameOf(kind));
      for (const bytes of sink.pending.splice(0)) await sink.writer.write(bytes);
    }
  };
  try {
    for (let index = 0; index < source.media.segments.length; index += 1) {
      const bytes = await fetchPart(
        source,
        (current) => /** @type {import("../lib/hls.js").HlsSegment} */ (current.segments[index]),
        "segment",
      );
      demuxer.push(bytes);
      if (unsupported !== null) throw unsupportedCodec(unsupported);
      await flush();
      meter.segmentDone();
    }
    demuxer.flush();
    if (unsupported !== null) throw unsupportedCodec(unsupported);
    await flush();
    for (const sink of sinks.values()) await sink.writer?.close();
  } catch (error) {
    for (const sink of sinks.values()) if (sink.writer !== null) await sink.writer.abort();
    throw error;
  }
  const plans = collector.plans();
  return source.role === "audio" ? plans.filter((plan) => plan.kind === "audio") : plans;
}

/**
 * The one video track and at most one audio track the writer takes: the first of each kind (a
 * separate audio rendition comes after the variant's own tracks and wins over a muxed one).
 * @param {TrackPlan[]} plans
 * @returns {TrackPlan[]}
 */
function pickTracks(plans) {
  const video = plans.find((plan) => plan.kind === "video");
  const audios = plans.filter((plan) => plan.kind === "audio" && plan.samples.length > 0);
  const audio = audios.at(-1);
  return [video, audio].filter((plan) => plan !== undefined);
}

/**
 * One DASH file streamed to its work file: `urls` in order (the first is the site's `baseUrl`), a
 * cut transfer resumed with `Range: bytes=<received>-` up to {@link MAX_RETRIES} times on the
 * same URL (a `206` continues, a `200` restarts the file), then the next URL from the start; a
 * refused URL (403 / 404 / 410) refreshed once per video, continuing from the received offset;
 * the `moov` checked for DRM as soon as it is complete.
 * @param {"video" | "audio"} role
 * @param {DownloadContext} ctx
 * @param {{ target: Target, streams: () => DashChoice,
 *   refresh: (cause: StepFailure) => Promise<void> }} owner
 * @param {AppendWriter} writer
 * @param {Attempt[]} attempts
 * @param {{ count: number }} counter
 * @param {ProgressMeter} meter
 * @returns {Promise<void>}
 */
async function fetchDashFile(role, ctx, owner, writer, attempts, counter, meter) {
  const repOf = () => {
    const streams = owner.streams();
    return /** @type {DashRep} */ (role === "video" ? streams.video : streams.audio);
  };
  let urlIndex = 0;
  let tries = 0;
  /** @type {number | null} */
  let total = null;
  let head = new Uint8Array(0);
  let drmChecked = false;
  /** @type {StepFailure | null} */
  let lastFailure = null;
  for (;;) {
    const urls = repOf().urls;
    const url = urls[urlIndex];
    if (url === undefined) {
      throw lastFailure ?? new StepFailure(failure("no_streams", { detail: `no ${role} URL` }));
    }
    const received = writer.size();
    const range = received > 0 ? `bytes=${received}-` : null;
    await mediaPause(ctx, counter);
    /** @type {Opened} */
    let opened;
    try {
      opened = await request(url, "media", ctx.net, attempts, { range });
    } catch (error) {
      if (!(error instanceof StepFailure)) throw error;
      lastFailure = error;
      if (error.expired) {
        await owner.refresh(error);
        urlIndex = 0;
        tries = 0;
        continue;
      }
      if (error.retryable && tries < MAX_RETRIES) {
        tries += 1;
        await ctx.net.sleep(backoffOf(ctx.net, tries));
        continue;
      }
      if (error.failure.code === "host_not_covered" || error.retryable) {
        urlIndex += 1;
        tries = 0;
        if (received > 0) await writer.truncate(0);
        meter.add(-received);
        head = new Uint8Array(0);
        continue;
      }
      throw error;
    }
    const { response } = opened;
    let expected = opened.attempt.content_length;
    if (received > 0 && response.status === 206) {
      const span = contentRange(response.headers.get("content-range"));
      if (span === null || span.start !== received) {
        opened.attempt.outcome = "refused: a range that does not continue the file";
        opened.controller.abort();
        opened.release();
        await writer.truncate(0);
        meter.add(-received);
        head = new Uint8Array(0);
        continue;
      }
      total = span.total ?? total;
    } else if (received > 0) {
      await writer.truncate(0); // a 200: the whole file again
      meter.add(-received);
      head = new Uint8Array(0);
      total = expected;
    } else if (response.status === 206) {
      const span = contentRange(response.headers.get("content-range"));
      total = span?.total ?? expected;
    } else {
      total = expected;
    }
    if (meter.total === null && total !== null && role === "video") meter.total = total;
    try {
      await readBody(opened, ctx.net, async (chunk) => {
        if (!drmChecked && head.length < HEAD_BYTES) {
          const grown = new Uint8Array(head.length + chunk.length);
          grown.set(head, 0);
          grown.set(chunk, head.length);
          head = grown.length > HEAD_BYTES ? grown.slice(0, HEAD_BYTES) : grown;
          const moov = completeMoov(head);
          if (moov !== null) {
            drmChecked = true;
            const drm = drmProblem(moov);
            if (drm !== null) throw new StepFailure(failure("encrypted", { detail: drm }));
          }
        }
        await writer.write(chunk);
        meter.add(chunk.length);
      }, { expected });
    } catch (error) {
      if (!(error instanceof StepFailure) || error.failure.code === "encrypted") throw error;
      lastFailure = error;
      if (error.retryable && tries < MAX_RETRIES) {
        tries += 1;
        await ctx.net.sleep(backoffOf(ctx.net, tries));
        continue; // resumed with a Range from what was written
      }
      urlIndex += 1;
      tries = 0;
      const had = writer.size();
      await writer.truncate(0);
      meter.add(-had);
      head = new Uint8Array(0);
      continue;
    }
    if (total !== null && writer.size() < total) {
      lastFailure = new StepFailure(
        failure("truncated_body", { received: writer.size(), expected: total }),
        { retryable: true },
      );
      if (tries < MAX_RETRIES) {
        tries += 1;
        await ctx.net.sleep(backoffOf(ctx.net, tries));
        continue;
      }
      throw lastFailure;
    }
    return;
  }
}

/**
 * The DASH path: the video file, then the audio file, each streamed to its work file
 * ({@link fetchDashFile}), then read back with `lib/mp4.collectMp4` (fragmented or progressive).
 * @param {Target} target
 * @param {DownloadContext} ctx
 * @param {{ key: string, name: (part: string) => string }} work
 * @param {Attempt[]} attempts
 * @param {{ count: number }} counter
 * @returns {Promise<TrackPlan[]>}
 */
async function downloadDash(target, ctx, work, attempts, counter) {
  let streams = /** @type {DashChoice} */ (target.streams);
  let refreshed = false;
  const owner = {
    target,
    streams: () => streams,
    /** @param {StepFailure} cause */
    refresh: async (cause) => {
      if (refreshed) throw cause;
      refreshed = true;
      const answer = await ctx.refresh({ ...target, streams });
      if (!answer.ok) throw new StepFailure(answer.failure);
      if (answer.streams.kind !== "dash") throw cause;
      streams = answer.streams;
      target.streams = streams;
      target.raw = answer.raw;
    },
  };
  const expected = (streams.video.size ?? 0) + (streams.audio?.size ?? 0);
  const meter = new ProgressMeter(ctx, expected > 0 ? expected : null, null);
  /** @type {TrackPlan[]} */
  const plans = [];
  for (const role of /** @type {const} */ (["video", "audio"])) {
    if (role === "audio" && streams.audio === null) continue;
    const name = work.name(`${role}.m4s`);
    const writer = await ctx.files.appendWriter(name);
    try {
      await fetchDashFile(role, ctx, owner, writer, attempts, counter, meter);
      await writer.close();
    } catch (error) {
      await writer.abort();
      throw error;
    }
    const tracks = await collectMp4(await ctx.files.slicer(name));
    const own = tracks.find((plan) => plan.kind === role);
    if (own !== undefined) plans.push(own);
  }
  return plans;
}

/**
 * The failure an error of a stage becomes: a step's own; an `Mp4Error` of the reader or the
 * writer `encrypted` when it says so, else `remux_failed` with its message as the reason; else the
 * stage's code with the error as its reason.
 * @param {unknown} error
 * @param {"download" | "finish" | "verify" | "save"} stage
 * @returns {Failure}
 */
function failureOf(error, stage) {
  if (error instanceof StepFailure) return error.failure;
  if (error instanceof Error && error.name === "QuotaExceededError") {
    // OPFS out of room: the work files need about twice the video's size until it is saved
    return failure("save_failed", { reason: `not enough free disk space (${oneLine(error)})` });
  }
  if (error instanceof Mp4Error && error.code === "encrypted") {
    return failure("encrypted", { detail: oneLine(error) });
  }
  if (error instanceof Mp4Error) return failure("remux_failed", { reason: oneLine(error) });
  if (stage === "download") return failure("no_response", { detail: oneLine(error) });
  if (stage === "finish") return failure("remux_failed", { reason: oneLine(error) });
  if (stage === "verify") return failure("verify_failed", { reason: oneLine(error) });
  return failure("save_failed", { reason: oneLine(error) });
}

/**
 * What is wrong with an MPEG-TS segment as served, or null: a TS segment starts with a packet
 * (sync byte `0x47`); an empty body or anything else — an error page served with a 200 — is not
 * one, and never reaches the demuxer.
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
export function tsSegmentProblem(bytes) {
  if (bytes.length === 0) return "an empty body";
  if (bytes.length < TS_PACKET_BYTES || bytes[0] !== 0x47) return "not MPEG-TS";
  return null;
}

/**
 * What is wrong with an fMP4 segment or init section as served, or null: it starts with a whole
 * ISO BMFF box whose type is four printable characters (`styp`, `moof`, `sidx`, `ftyp`, …); an
 * empty body or anything else is not one.
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
export function mp4SegmentProblem(bytes) {
  if (bytes.length === 0) return "an empty body";
  if (bytes.length < 8) return "not MP4 boxes";
  for (let at = 4; at < 8; at += 1) {
    const char = /** @type {number} */ (bytes[at]);
    if (char < 0x20 || char > 0x7e) return "not MP4 boxes";
  }
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (size === 0) return null; // the box runs to the end
  if (size === 1) return bytes.length >= 16 ? null : "not MP4 boxes";
  return size < 8 || size > bytes.length ? "not MP4 boxes" : null;
}

/**
 * The first hole in a track's timeline, or null: a step between two consecutive decode times
 * longer than {@link GAP_FACTOR} typical steps (the median) and {@link GAP_TOLERANCE_S} — or,
 * `damaged` (the MPEG-TS demuxer met damaged data), longer than {@link DAMAGED_GAP_FACTOR}
 * typical steps. `atS` is where the hole starts (from the track's first sample), `missingS` how
 * much media it lacks.
 * @param {TrackPlan} plan
 * @param {boolean} damaged
 * @returns {{ atS: number, missingS: number } | null}
 */
export function mediaGap(plan, damaged) {
  const samples = plan.samples;
  if (samples.length < 3 || !(plan.timescale > 0)) return null;
  const steps = new Float64Array(samples.length - 1);
  for (let index = 1; index < samples.length; index += 1) {
    const here = /** @type {TrackPlan["samples"][number]} */ (samples[index]);
    const before = /** @type {TrackPlan["samples"][number]} */ (samples[index - 1]);
    steps[index - 1] = here.dts - before.dts;
  }
  const typical = /** @type {number} */ (Float64Array.from(steps).sort()[steps.length >> 1]);
  if (!(typical > 0)) return null;
  const limit = damaged
    ? DAMAGED_GAP_FACTOR * typical
    : Math.max(GAP_FACTOR * typical, GAP_TOLERANCE_S * plan.timescale);
  const first = /** @type {TrackPlan["samples"][number]} */ (samples[0]).dts;
  for (let index = 0; index < steps.length; index += 1) {
    const step = /** @type {number} */ (steps[index]);
    if (step <= limit) continue;
    const start = /** @type {TrackPlan["samples"][number]} */ (samples[index]).dts + typical;
    return { atS: (start - first) / plan.timescale, missingS: (step - typical) / plan.timescale };
  }
  return null;
}

/**
 * Whether a probed duration is within max(3 s, 5 %) of the expected one.
 * @param {number} actual
 * @param {number} expected
 * @returns {boolean}
 */
export function durationMatches(actual, expected) {
  const tolerance = Math.max(DURATION_TOLERANCE_S, DURATION_TOLERANCE_RATIO * expected);
  return Math.abs(actual - expected) <= tolerance;
}

/**
 * @param {number} seconds
 * @returns {string} one decimal
 */
function oneDecimal(seconds) {
  return (Math.round(seconds * 10) / 10).toFixed(1);
}

/**
 * Download one target (module doc): a file already saved at its path is `skipped-exists` without a
 * request; a target the resolver could not resolve fails with its failure without a request;
 * otherwise the media, the progressive MP4, its verification and its save. Never throws: a Stop
 * ends the current request and the result is `stopped`.
 * @param {Target} target
 * @param {DownloadContext} ctx
 * @returns {Promise<Result>}
 */
export async function download(target, ctx) {
  /** @type {Attempt[]} */
  const attempts = [];
  traces.set(target.key, attempts);
  /** @type {Result} */
  const result = {
    status: DONE,
    failure: null,
    path: null,
    bytes: 0,
    durationS: null,
    attempts,
    verify: null,
    notes: [],
    contacted: false,
  };
  /** @param {Failure} reason @param {Status} [status] */
  const fail = (reason, status) => {
    result.status = status ?? statusForFailure(reason.code);
    result.failure = reason;
    result.contacted = attempts.some((attempt) => attempt.requested);
    return result;
  };
  if (target.failure !== null) return fail(target.failure, target.status ?? undefined);
  if (target.streams === null) {
    return fail(failure("no_streams", { detail: "nothing was resolved" }), FAILED);
  }
  const work = ctx.files.openWork(target.key);
  /** @type {"download" | "finish" | "verify" | "save"} */
  let stage = "download";
  try {
    const path = pathOf(target);
    const existing = await ctx.view.completedAt(path);
    if (existing !== null) {
      result.status = SKIPPED_EXISTS;
      result.path = existing.filename;
      return result;
    }
    await ctx.applyReferer(target.site);
    ctx.onStatus?.("downloading");
    const counter = { count: 0 };
    /** @type {{ corrupt: string | null }} */
    const health = { corrupt: null };
    const collected =
      target.streams.kind === "hls"
        ? await downloadHls(target, ctx, work, attempts, counter, health)
        : await downloadDash(target, ctx, work, attempts, counter);
    result.contacted = true;
    stage = "finish";
    /** @param {string} reason */
    const told = (reason) =>
      health.corrupt === null
        ? reason
        : `${reason}; the MPEG-TS stream was damaged: ${health.corrupt}`;
    // a track without a sample is never handed to the writer
    const plans = collected.filter((plan) => plan.samples.length > 0);
    const video = plans.find((plan) => plan.kind === "video");
    if (video === undefined) {
      return fail(failure("remux_failed", { reason: told("the source has no video samples") }));
    }
    const audio = plans.find((plan) => plan.kind === "audio");
    const streams = /** @type {HlsChoice | DashChoice} */ (target.streams);
    if (audio === undefined && audioExpected(streams)) {
      const reason = told("the source announced audio but carried no audio sample");
      return fail(failure("remux_failed", { reason }));
    }
    // a hole inside a track (lost media) fails the file even when its duration still matches
    for (const plan of plans) {
      const gap = mediaGap(plan, health.corrupt !== null);
      if (gap === null) continue;
      const missing = `${oneDecimal(gap.missingS)} s missing at ${oneDecimal(gap.atS)} s`;
      return fail(failure("verify_failed", { reason: told(`${plan.kind}: ${missing}`) }));
    }
    const meta = await fileMeta(target, ctx, attempts, counter, result.notes);
    ctx.onStatus?.("finishing");
    const finalName = work.name("final.mp4");
    const sink = await ctx.files.appendWriter(finalName);
    /** @type {Map<string, Mp4File>} */
    const sources = new Map();
    /** @type {Awaited<ReturnType<typeof writeProgressiveMp4>>} */
    let written;
    try {
      written = await writeProgressiveMp4(
        plans,
        async (ref, size) => {
          let source = sources.get(ref.file);
          if (source === undefined) {
            source = await ctx.files.slicer(ref.file);
            sources.set(ref.file, source);
          }
          return source.slice(ref.offset, ref.offset + size);
        },
        sink,
        { meta },
      );
      await sink.close();
    } catch (error) {
      await sink.abort();
      throw error;
    }
    stage = "verify";
    ctx.onStatus?.("verifying");
    const probed = await probe(await ctx.files.slicer(finalName));
    /** @param {string} reason */
    const refuse = (reason) => fail(failure("remux_failed", { reason: told(reason) }));
    if (!probed.progressive || probed.truncated || probed.encrypted) {
      return refuse("the written file is not a complete progressive MP4");
    }
    const videoTracks = probed.tracks.filter((track) => track.kind === "video");
    const audioTracks = probed.tracks.filter((track) => track.kind === "audio");
    const expectedAudio = audio === undefined ? 0 : 1;
    if (videoTracks.length !== 1 || audioTracks.length !== expectedAudio) {
      const counts = `${videoTracks.length} video and ${audioTracks.length} audio tracks`;
      return refuse(`the written file has ${counts}`);
    }
    for (const track of written.tracks) {
      const found = probed.tracks.find((one) => one.kind === track.kind);
      if (found === undefined) return refuse(`${track.kind}: the written file lacks the track`);
      if (found.sampleCount !== track.samples) {
        return refuse(`${track.kind}: ${found.sampleCount} samples written of ${track.samples}`);
      }
      if (Math.abs(found.durationS - track.durationS) > WRITER_TOLERANCE_S) {
        const read = `${found.durationS.toFixed(3)} s`;
        const wrote = `${track.durationS} s`;
        return refuse(`${track.kind}: the file says ${read}, the writer wrote ${wrote}`);
      }
    }
    if (meta.title !== undefined && probed.title !== meta.title) {
      return refuse("the written file does not carry its title");
    }
    if (meta.cover !== undefined && probed.cover === null) {
      return refuse("the written file does not carry its cover");
    }
    if (audio === undefined) result.notes.unshift({ code: "no_audio", params: {} });
    result.verify = {
      progressive: probed.progressive,
      tracks: probed.tracks.map((track) => ({
        kind: track.kind,
        codec: track.codec,
        duration_s: track.durationS,
        samples: track.sampleCount,
      })),
      duration_s: probed.durationS,
      expected_duration_s: target.durationS,
      browser_duration_s: null,
      title: probed.title,
      cover:
        probed.cover === null
          ? null
          : { type: probed.cover.type, bytes: probed.cover.bytes.length },
    };
    if (target.durationS !== null && !durationMatches(probed.durationS, target.durationS)) {
      const actual = oneDecimal(probed.durationS);
      const reason = `duration ${actual} s, expected ${oneDecimal(target.durationS)} s`;
      return fail(failure("verify_failed", { reason: told(reason) }));
    }
    // every track complete, not only the longest: a DASH audio file that ended early leaves a
    // file whose duration is still the video's
    const reference = target.durationS ?? videoTracks[0]?.durationS ?? null;
    for (const track of probed.tracks) {
      if (reference === null || durationMatches(track.durationS, reference)) continue;
      const against = target.durationS === null ? "the video's" : "expected";
      const actual = `${track.kind} track ${oneDecimal(track.durationS)} s`;
      const reason = `${actual}, ${against} ${oneDecimal(reference)} s`;
      return fail(failure("verify_failed", { reason: told(reason) }));
    }
    const blob = await ctx.files.file(finalName);
    if (ctx.browserCheck) {
      const seen = await ctx.browserCheck(blob).catch(() => null);
      result.verify.browser_duration_s = seen;
      if (seen === null) {
        const codec = videoTracks[0]?.codec ?? "?";
        const at = result.notes.findIndex((note) => note.code === "cover");
        const note = /** @type {Note} */ ({ code: "browser_unreadable", params: { codec } });
        if (at === -1) result.notes.push(note);
        else result.notes.splice(at, 0, note);
      }
    }
    stage = "save";
    const saved = await ctx.save(blob, path);
    result.path = saved.filename;
    result.bytes = written.bytes;
    result.durationS = probed.durationS;
    result.status = DONE;
    return result;
  } catch (error) {
    if (isStop(error, ctx.net)) {
      const reason = error instanceof StopRequested ? error.reason : "user";
      return fail(failure("stopped", { reason }), STOPPED);
    }
    return fail(failureOf(error, stage));
  } finally {
    await ctx.files.removeWork(target.key).catch(() => undefined);
  }
}
