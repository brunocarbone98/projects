// @ts-check
/**
 * One episode at a time, from the extension page: a port of `downloader_browser.BrowserDownloader`
 * and of the skip helpers it shares with the yt-dlp engine (`downloader.locked_result`,
 * `existing_file_result`).
 *
 * The item_list payload TikTok served to the user's own session already carries every episode's
 * signed play URLs; this module fetches them directly, one GET at a time and at most
 * {@link MAX_GETS_PER_EPISODE} candidate URLs per episode (an in-run re-discovery included), with
 * the session's cookies (`credentials: "include"` — the extension never reads them), `Referer:
 * https://www.tiktok.com/` and no `Origin`, which a declarativeNetRequest SESSION rule scoped to
 * the extension's own requests sees to ({@link applyRefererRule}; what `downloader_browser`'s
 * Playwright request and yt-dlp send). A URL whose host the manifest does not cover is never
 * requested, yet counts in the budget like a refused URL (Python's `tried` holds every candidate
 * it reached). A redirect is followed only to a target `onBeforeRedirect` named and the manifest
 * covers (the test origin in test mode), never from https down to http, at most five hops, each
 * requested the same way so the rule applies to it too (`./redirects.js`; the hops are no further
 * candidates: the budget counts the candidate URLs, as Python's `tried` does); a redirect to any
 * other target counts like a refused URL — the next candidate is tried —, while a loop, a sixth
 * hop or a request that throws fails the episode at once (`download failed: …`, no next mirror, no
 * fresh list), where Playwright's request raises in Python. The body is judged in memory, in this
 * order:
 * the transfer (a body shorter or longer than an identity-encoded `Content-Length`, or cut off →
 * `failed`, no next mirror), the content (`lib/mp4.bodyProblem` → next URL), encrypted tracks
 * (`lib/mp4.drmProblem` → `failed-unavailable` with `DRM_MESSAGE`, nothing saved, no other
 * mirror, no fresh list, no cover), the integrity check (`lib/mp4.verifyVideo`, always on → `failed`,
 * nothing saved: the next run retries). Only then the one cover GET (outside the media budget,
 * never retried), the cover embedded into the MP4 in memory (`lib/mp4.embedCover`) and/or kept as a
 * file, and the save through `chrome.downloads` under `DramaFetch/<series folder>/<stem>.mp4`.
 * Messages carry host names only — never a signed URL, never a cookie.
 */

import { accessOf, playUrlCandidates, urlExpiry } from "../lib/catalog.js";
import {
  DONE,
  DRM_MARK,
  FAILED,
  FAILED_BLOCKED,
  FAILED_LOGIN,
  FAILED_RATE_LIMITED,
  FAILED_UNAVAILABLE,
  INCOMPLETE_PREFIX,
  MEDIA_RATE_LIMIT_MESSAGE,
  SKIPPED_EXISTS,
  TIKTOK_BASE_URL,
  UNAVAILABLE_MESSAGE,
} from "../lib/messages.js";
import {
  MAX_COVER_BYTES,
  MIN_IMAGE_BYTES,
  ThumbnailError,
  bodyProblem,
  drmProblem,
  embedCover,
  extensionFor,
  imageKind,
  imageProblem,
  mebibytes,
  mimeTypeFor,
  verifyVideo,
} from "../lib/mp4.js";
import { downloadFilename, episodeStem, fileBaseName } from "../lib/naming.js";
import { EXPIRY_MARGIN_S, MAX_GETS_PER_EPISODE, sleepSeconds } from "../lib/pacing.js";
import { lockedResult } from "../lib/report.js";
import { ChallengeError, DiscoveryError, LoginRequiredError, RateLimitedError } from "./discovery.js";
import { RedirectRefused, fetchFollowing, hostOf, isRedirect, pageRedirects } from "./redirects.js";

export { MAX_GETS_PER_EPISODE, hostOf, isRedirect };

/** Answers that mean "not this URL": try the next candidate, then a fresh list (`_DENIED_STATUSES`). */
const DENIED_STATUSES = new Set([403, 404, 410]);
/** `Content-Encoding` values under which `Content-Length` is the body's own length. */
const IDENTITY_ENCODINGS = new Set(["", "identity"]);
/** A transfer that delivers nothing for this long is cut off (`REQUEST_TIMEOUT_MS`, 120 s). */
export const IDLE_TIMEOUT_MS = 120_000;
/**
 * The declarativeNetRequest session rule of the extension's own requests: `Referer` set, `Origin`
 * removed ({@link applyRefererRule}).
 */
export const REFERER_RULE_ID = 1;
/**
 * The domains of the manifest's host permissions, exactly (the rule's `requestDomains`; a unit test
 * compares them with `manifest.json`): every host the extension may contact is covered by the rule.
 */
export const TIKTOK_DOMAINS = Object.freeze([
  "tiktok.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokcdn-eu.com",
  "tiktokv.com",
  "tiktokv.us",
  "byteoversea.com",
  "ibytedtos.com",
  "ibyteimg.com",
  "muscdn.com",
]);
const MAX_MESSAGE_LEN = 300;

/**
 * @typedef {import("../lib/catalog.js").Episode} Episode
 * @typedef {import("../lib/catalog.js").Series} Series
 * @typedef {import("../lib/report.js").DownloadResult} DownloadResult
 * @typedef {import("../lib/urls.js").SeriesRef} SeriesRef
 *
 * @typedef {object} SavedFile What Chrome reports of a saved file.
 * @property {number} id
 * @property {string} filename the full path Chrome saved it at
 *
 * @typedef {object} EpisodeContext What the engine tells the downloader about the series.
 * @property {string} seriesName what `{series}` expands to (the series' display name)
 * @property {string} folder the series folder `<name> [<id>]`
 *
 * @typedef {object} Attempt Why one candidate URL gave no video (`_Attempt`; host names only).
 * @property {string} reason
 * @property {boolean} unavailable a denied status, a non-video body, a host (or a redirect target)
 *   not allowed: the next candidate, then a fresh list
 * @property {boolean} [incomplete] a truncated transfer
 */

// ------------------------------------------------------------------------ pure helpers

/**
 * Whether a URL is covered by one of the manifest's host permission patterns
 * (`<scheme>://<host>/<path>`; `*` scheme = http or https, `*.` host prefix = that domain and its
 * subdomains; the port is not part of a pattern). A URL outside them is never requested.
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
    if (patternScheme === "*" ? !["http", "https"].includes(scheme) : patternScheme !== scheme) continue;
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

/**
 * Whether a redirect target may be requested: a host the manifest covers that the rule of the
 * extension's own requests ({@link applyRefererRule}) covers as well — for TikTok's origin one of
 * {@link TIKTOK_DOMAINS} or a subdomain, for the test server's (test mode) that origin itself.
 * Without `base`, the manifest's hosts alone decide.
 * @param {string} url
 * @param {readonly string[]} patterns the manifest's host permissions
 * @param {string} [base] TikTok's origin, or the test server's
 * @returns {boolean}
 */
export function redirectTargetAllowed(url, patterns, base) {
  if (!hostCovered(url, patterns)) return false;
  if (base === undefined) return true;
  const origin = base.replace(/\/+$/, "");
  if (origin !== TIKTOK_BASE_URL) return url.startsWith(`${origin}/`);
  const host = hostOf(url).toLowerCase();
  return TIKTOK_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * The numeric `Content-Length` of an identity-encoded body, or null (`_content_length`): absent,
 * not a number, or under another `Content-Encoding` (the header then counts the encoded stream,
 * while the body handed over is the decoded one).
 * @param {{get(name: string): string | null}} headers
 * @returns {number | null}
 */
export function contentLength(headers) {
  const encoding = (headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (!IDENTITY_ENCODINGS.has(encoding)) return null;
  const value = (headers.get("content-length") ?? "").trim();
  return /^[0-9]+$/.test(value) ? Number(value) : null;
}

const SECRET_RE =
  /\b(cookies?|sessionid(?:_ss)?|sid_tt|sid_guard|uid_tt|mstoken|ttwid|tt_chain_token|passport_csrf_token|odin_tt|tt_csrf_token|_signature|x-bogus|verifyfp)\b\s*[:=]\s*[^\s;,&]+/gi;
const URL_RE = /https?:\/\/[^\s"'<>]+/g;

/**
 * The first non-empty line of an error text with every URL cut back to scheme, host and path and
 * every cookie- or token-like value blanked, at most 300 characters (`downloader.sanitize_error`).
 * @param {string} text
 * @returns {string}
 */
export function sanitizeError(text) {
  const redacted = text
    .replace(URL_RE, (url) => url.replace(/[?#].*$/s, ""))
    .replace(SECRET_RE, (_match, key) => `${key}=<redacted>`);
  const lines = redacted
    .trim()
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line);
  let first = lines[0] ?? "unknown error";
  if (first.length > MAX_MESSAGE_LEN) first = `${first.slice(0, MAX_MESSAGE_LEN - 1)}…`;
  return first;
}

/**
 * An error as one safe line (`_one_line`): its message, else its class name.
 * @param {unknown} error
 * @returns {string}
 */
export function oneLine(error) {
  if (error instanceof Error) return sanitizeError(error.message || error.name);
  return sanitizeError(String(error));
}

/** A transfer that stopped before its end: the body is incomplete. */
class TruncatedTransfer extends Error {
  constructor() {
    super("the transfer was cut short");
    this.name = "TruncatedTransfer";
  }
}

/**
 * The whole body of a response, read chunk by chunk; a stream that errors (the connection
 * dropped: Chrome checks the `Content-Length` itself) or stalls for `idleMs` throws
 * {@link TruncatedTransfer}; more than `maxBytes` stops reading and returns what came (the caller
 * then sees the length).
 * @param {Response} response
 * @param {{idleMs?: number, maxBytes?: number}} [limits]
 * @returns {Promise<Uint8Array>}
 */
export async function readBody(response, limits = {}) {
  const idleMs = limits.idleMs ?? IDLE_TIMEOUT_MS;
  const maxBytes = limits.maxBytes ?? Number.POSITIVE_INFINITY;
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const stalled = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new TruncatedTransfer()), idleMs);
      });
      let step;
      try {
        step = await Promise.race([reader.read(), stalled]);
      } catch {
        throw new TruncatedTransfer();
      } finally {
        clearTimeout(timer);
      }
      const { done, value } = /** @type {ReadableStreamReadResult<Uint8Array>} */ (step);
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > maxBytes) break;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/**
 * @typedef {{ok: true, data: Uint8Array, kind: import("../lib/mp4.js").ImageKind} | {ok: false, note: string}} ImageResult
 *
 * @typedef {object} ImageOptions
 * @property {typeof fetch} fetch
 * @property {readonly string[]} hostPatterns the manifest's host permissions
 * @property {number} [idleMs]
 * @property {import("./redirects.js").RedirectTracker | null} [redirects] where redirects are learnt
 *   (default: the page's tracker, `pageRedirects()`); null: none is followed
 * @property {string} [baseUrl] TikTok's origin, or the test server's: a redirect is followed only
 *   where the rule of the extension's own requests applies ({@link redirectTargetAllowed})
 */

/**
 * One image GET of the extension's own (the downloader's cover, a thumbnail of the episode list):
 * only to a host the manifest covers, a redirect followed only the safe way (`./redirects.js`:
 * a known, allowed target, at most five hops, each requested like the first), with the session's
 * cookies; at most {@link MAX_COVER_BYTES} read, accepted per `thumbnails.image_kind` (the bytes
 * first) from {@link MIN_IMAGE_BYTES} on. Never throws: a failure is `{ok: false, note: "; cover:
 * <reason>"}`, host names only.
 * @param {string} url
 * @param {ImageOptions} options
 * @returns {Promise<ImageResult>}
 */
export async function fetchImage(url, options) {
  const host = hostOf(url);
  if (!hostCovered(url, options.hostPatterns)) {
    return { ok: false, note: `; cover: ${host} is not a host this extension may contact` };
  }
  try {
    let response;
    try {
      ({ response } = await fetchFollowing(url, {
        fetch: options.fetch,
        init: { credentials: "include", cache: "no-store", redirect: "manual", headers: { Accept: "image/*,*/*" } },
        redirects: options.redirects === undefined ? pageRedirects() : options.redirects,
        allowed: (target) => redirectTargetAllowed(target, options.hostPatterns, options.baseUrl),
      }));
    } catch (error) {
      if (error instanceof RedirectRefused) return { ok: false, note: `; cover: ${error.message}` };
      throw error;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, note: `; cover: HTTP ${response.status} from ${host}` };
    }
    const contentType = response.headers.get("content-type") ?? "";
    const data = await readBody(response, { idleMs: options.idleMs, maxBytes: MAX_COVER_BYTES });
    const kind = imageKind(data, contentType);
    if (kind === null || data.length < MIN_IMAGE_BYTES) {
      return { ok: false, note: `; cover: ${imageProblem(data, contentType)} from ${host}` };
    }
    if (data.length > MAX_COVER_BYTES) return { ok: false, note: "; cover: too large, not kept" };
    return { ok: true, data, kind };
  } catch (error) {
    return { ok: false, note: `; cover: ${oneLine(error)}` };
  }
}

/**
 * The session rule of the extension's own requests to TikTok's hosts: `Referer: <base>/` set and
 * `Origin` removed — what the Python browser engine's Playwright request and yt-dlp send (no
 * `Origin`). Chrome may add `Origin: chrome-extension://<id>` to a request of an extension page (it
 * does to a POST; its GETs to a host the extension may contact carry none today): with the rule,
 * TikTok's CDN never sees one, whatever Chrome does. Its initiator is the extension itself, so no
 * request of TikTok's page is ever touched; production covers every one of {@link TIKTOK_DOMAINS},
 * test mode the test origin.
 * @param {string} base TikTok's origin (the fake server's in test mode)
 * @returns {chrome.declarativeNetRequest.Rule}
 */
export function refererRule(base) {
  const origin = base.replace(/\/+$/, "");
  /** @type {chrome.declarativeNetRequest.RuleCondition} */
  const condition = {
    initiatorDomains: [chrome.runtime.id],
    resourceTypes: ["xmlhttprequest", "other"],
  };
  if (origin === TIKTOK_BASE_URL) condition.requestDomains = [...TIKTOK_DOMAINS];
  else condition.urlFilter = `|${origin}/`;
  return {
    id: REFERER_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Referer", operation: "set", value: `${origin}/` },
        { header: "Origin", operation: "remove" },
      ],
    },
    condition,
  };
}

/**
 * Install (or replace) {@link refererRule}. Called before every job; session rules end with the
 * browser.
 * @param {string} base TikTok's origin (the fake server's in test mode)
 * @returns {Promise<void>}
 */
export async function applyRefererRule(base) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [REFERER_RULE_ID],
    addRules: [refererRule(base)],
  });
}

// ------------------------------------------------------------------- Chrome's downloads

/**
 * Chrome re-checks whether its downloaded files still exist when an extension searches its
 * downloads — but at most once every 10 s, counted in whole seconds (its
 * `kFileExistenceRateLimitSeconds`); a search sooner than that reads the old answer, so a file
 * deleted a moment ago would still count as on disk.
 */
export const EXISTENCE_CHECK_RATE_LIMIT_S = 10;

/**
 * @typedef {object} ExistenceChecks When one of this page's searches last made Chrome re-check its
 * files, as far as the page can tell (Chrome's own rule applied to the page's searches).
 * @property {number} lastMs milliseconds since the epoch; -Infinity before the first search
 */

/** @type {ExistenceChecks} the page's (every view and every save share it) */
const pageExistenceChecks = { lastMs: Number.NEGATIVE_INFINITY };

/**
 * `chrome.downloads.search`, noting whether this call makes Chrome re-check its files (Chrome's
 * rule: more than {@link EXISTENCE_CHECK_RATE_LIMIT_S} whole seconds since the last check).
 * @param {typeof chrome.downloads} api
 * @param {chrome.downloads.DownloadQuery} query
 * @param {ExistenceChecks} [checks]
 * @param {number} [nowMs]
 * @returns {Promise<chrome.downloads.DownloadItem[]>}
 */
function searchDownloads(api, query, checks = pageExistenceChecks, nowMs = Date.now()) {
  if (Math.floor(nowMs / 1000) - Math.floor(checks.lastMs / 1000) > EXISTENCE_CHECK_RATE_LIMIT_S) {
    checks.lastMs = nowMs;
  }
  return api.search(query);
}

/**
 * What Chrome's download history says, taken once per series (`refresh`) and kept up to date with
 * the files this run saves: which recorded download still exists (the state's {@link exists}
 * answer) and which completed download sits exactly at a target path ({@link completedAt}).
 */
export class DownloadsView {
  /**
   * @param {{api?: typeof chrome.downloads, sleep?: (seconds: number) => Promise<void>, existenceDelayMs?: number, rateLimitS?: number, now?: () => number, checks?: ExistenceChecks}} [options]
   *   `rateLimitS` Chrome's {@link EXISTENCE_CHECK_RATE_LIMIT_S} (0, test mode only: never wait for
   *   it); `now` in milliseconds (`Date.now`); `checks` the page's existence checks by default
   */
  constructor(options = {}) {
    this.api = options.api ?? chrome.downloads;
    this.sleep = options.sleep ?? ((seconds) => sleepSeconds(seconds));
    this.existenceDelayMs = options.existenceDelayMs ?? 300;
    this.rateLimitS = options.rateLimitS ?? EXISTENCE_CHECK_RATE_LIMIT_S;
    this.now = options.now ?? (() => Date.now());
    this.checks = options.checks ?? pageExistenceChecks;
    /** whether this view (one per job) made Chrome check its files already */
    this.checked = false;
    /** @type {Map<number, chrome.downloads.DownloadItem>} */
    this.byId = new Map();
  }

  /**
   * Make Chrome check whether its downloaded files still exist, wait for the answer, then read the
   * completed downloads. The view's first refresh — a job's — first waits, when one of this page's
   * searches made Chrome check less than {@link EXISTENCE_CHECK_RATE_LIMIT_S} s ago, until its rate
   * limit lets a search check again (only waiting, never a request): a file deleted since the last
   * job is then seen as gone.
   * @returns {Promise<void>}
   */
  async refresh() {
    if (!this.checked && this.rateLimitS > 0) {
      const allowedAtMs = (Math.floor(this.checks.lastMs / 1000) + this.rateLimitS + 1) * 1000;
      const waitMs = allowedAtMs - this.now();
      if (waitMs > 0) await this.sleep(waitMs / 1000);
    }
    this.checked = true;
    await searchDownloads(this.api, { limit: 1 }, this.checks, this.now());
    await this.sleep(this.existenceDelayMs / 1000);
    const items = await searchDownloads(this.api, { state: "complete", limit: 0 }, this.checks, this.now());
    this.byId = new Map(items.map((item) => [item.id, item]));
  }

  /**
   * The state's "file still exists" answer: the entry's download is complete, is the very file the
   * entry recorded (Chrome hands its ids out again once its download history is cleared) and that
   * file still exists.
   * @param {{download_id?: number | null, path?: string | null}} entry
   * @returns {boolean}
   */
  exists(entry) {
    if (entry.download_id === null || entry.download_id === undefined) return false;
    const item = this.byId.get(entry.download_id);
    return item !== undefined && item.state === "complete" && item.exists && item.filename === entry.path;
  }

  /**
   * The newest completed download that still exists at exactly `relative` (`DramaFetch/<folder>/
   * <file>`, below any Downloads folder; Windows paths compared with `/`), or null.
   * @param {string} relative
   * @returns {chrome.downloads.DownloadItem | null}
   */
  completedAt(relative) {
    /** @type {chrome.downloads.DownloadItem | null} */
    let found = null;
    for (const item of this.byId.values()) {
      if (item.state !== "complete" || !item.exists) continue;
      const path = item.filename.replace(/\\/g, "/");
      if (path !== relative && !path.endsWith(`/${relative}`)) continue;
      if (found === null || item.id > found.id) found = item;
    }
    return found;
  }

  /**
   * A file this run saved.
   * @param {chrome.downloads.DownloadItem} item
   */
  remember(item) {
    this.byId.set(item.id, item);
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
 * Wait until a download leaves `in_progress`; the final item.
 * @param {number} id
 * @param {typeof chrome.downloads} api
 * @returns {Promise<chrome.downloads.DownloadItem>}
 */
function waitForDownload(id, api) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = async () => {
      try {
        const [item] = await searchDownloads(api, { id });
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
    void settle(); // it may be complete already
  });
}

/**
 * Save bytes through `chrome.downloads` at `filename` (relative to the Downloads folder;
 * `uniquify`: never overwrite a file), wait for it to complete, and return what Chrome saved.
 * @param {Uint8Array} bytes
 * @param {string} mime
 * @param {string} filename
 * @param {typeof chrome.downloads} [api]
 * @returns {Promise<chrome.downloads.DownloadItem>}
 */
export async function saveFile(bytes, mime, filename, api = chrome.downloads) {
  const url = URL.createObjectURL(new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (bytes)], { type: mime }));
  try {
    const id = await api.download({ url, filename, conflictAction: "uniquify", saveAs: false });
    const item = await waitForDownload(id, api);
    if (item.state !== "complete") throw new SaveError(item.error || "INTERRUPTED");
    return item;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------------------------------- the engine

/**
 * @typedef {object} DownloaderConfig
 * @property {string} [baseUrl] TikTok's origin (the fake server's in test mode)
 * @property {string} quality `compatible` or `best`
 * @property {string} thumbnail `embed`, `both`, `file` or `none`
 * @property {string} nameFormat
 * @property {boolean} includeLocked
 * @property {readonly string[]} hostPatterns the manifest's host permissions
 * @property {DownloadsView} view
 * @property {(ref: SeriesRef) => Promise<Series>} rediscover the in-run re-discovery
 * @property {() => number} [now] wall-clock seconds (play URL expiry)
 * @property {typeof fetch} [fetch]
 * @property {(bytes: Uint8Array, mime: string, filename: string) => Promise<chrome.downloads.DownloadItem>} [save]
 * @property {(text: string) => void} [onStatus] what the downloader is doing (for the UI)
 * @property {number} [idleMs]
 * @property {import("./redirects.js").RedirectTracker | null} [redirects] where the redirects of its
 *   requests are learnt (default: the page's tracker, `pageRedirects()`); null: none is followed
 */

/** Downloads one episode at a time from the play URLs its item carries (`BrowserDownloader`). */
export class Downloader {
  /** @param {DownloaderConfig} config */
  constructor(config) {
    this.config = config;
    this.now = config.now ?? (() => Date.now() / 1000);
    this.fetch = config.fetch ?? ((input, init) => fetch(input, init));
    this.save = config.save ?? ((bytes, mime, filename) => saveFile(bytes, mime, filename));
    this.redirects = config.redirects === undefined ? pageRedirects() : config.redirects;
    /** @type {Map<string, Map<string, Record<string, unknown>>>} series id → item id → its newest fresh item */
    this.freshItems = new Map();
    /** @type {Set<string>} series whose re-discovery failed in this run: never asked again */
    this.failedRefreshes = new Set();
    /** in-run re-discoveries made so far */
    this.refreshes = 0;
  }

  /**
   * The episode's file name without extension (the extension's limits: `lib/naming`).
   * @param {Episode} episode
   * @param {EpisodeContext} context
   * @returns {string}
   */
  stem(episode, context) {
    return episodeStem(episode, { nameFormat: this.config.nameFormat, seriesName: context.seriesName });
  }

  /**
   * The path the episode's video is saved at, relative to the Downloads folder.
   * @param {Episode} episode
   * @param {EpisodeContext} context
   * @returns {string}
   */
  target(episode, context) {
    return downloadFilename(context.folder, this.stem(episode, context), "mp4");
  }

  /**
   * The SKIPPED_EXISTS result of an episode whose video Chrome's history shows completed at
   * exactly its target path and still there (`existing_file_result`), or null. No request.
   * @param {Episode} episode
   * @param {EpisodeContext} context
   * @returns {DownloadResult | null}
   */
  existingResult(episode, context) {
    const item = this.config.view.completedAt(this.target(episode, context));
    if (item === null) return null;
    return {
      episode,
      status: SKIPPED_EXISTS,
      path: item.filename,
      message: `already exists: ${fileBaseName(item.filename)}`,
      downloadId: item.id,
    };
  }

  /**
   * Whether the episode needs the network (`engine._needs_network`): not locked (unless
   * includeLocked) and not already saved.
   * @param {Episode} episode
   * @param {EpisodeContext} context
   * @returns {boolean}
   */
  needsNetwork(episode, context) {
    if (episode.access === "locked" && !this.config.includeLocked) return false;
    return this.existingResult(episode, context) === null;
  }

  /**
   * Download one episode. Never throws: every failure is a result.
   * @param {Episode} episode
   * @param {EpisodeContext} context
   * @returns {Promise<DownloadResult>}
   */
  async download(episode, context) {
    if (episode.access === "locked" && !this.config.includeLocked) return lockedResult(episode);
    const existing = this.existingResult(episode, context);
    if (existing !== null) return existing;
    try {
      return await this.downloadEpisode(episode, context);
    } catch (error) {
      if (error instanceof Error && error.name === "StopRequested") throw error; // the user's Stop
      let status = /** @type {import("../lib/messages.js").Status} */ (FAILED);
      if (error instanceof LoginRequiredError) status = FAILED_LOGIN;
      else if (error instanceof RateLimitedError) status = FAILED_RATE_LIMITED;
      else if (error instanceof ChallengeError) status = FAILED_BLOCKED;
      return { episode, status, path: null, message: oneLine(error) };
    }
  }

  /**
   * `BrowserDownloader._download`.
   * @param {Episode} episode
   * @param {EpisodeContext} context
   * @returns {Promise<DownloadResult>}
   */
  async downloadEpisode(episode, context) {
    /** @type {Set<string>} every URL requested for this episode: its budget */
    const tried = new Set();
    let refreshed = false;
    let candidates = this.usableCandidates(episode.raw);
    if (candidates.length === 0) {
      refreshed = true;
      const refused = await this.refresh(episode, tried);
      if (refused !== null) return refused;
      candidates = this.usableCandidates(episode.raw);
      if (candidates.length === 0) {
        return failure(episode, FAILED_UNAVAILABLE, `${UNAVAILABLE_MESSAGE} (no play url, even in a fresh episode list)`);
      }
    }
    let { result, last } = await this.tryCandidates(episode, context, candidates, tried);
    if (result !== null) return result;
    /** @type {Attempt} */
    let attempt = last ?? { reason: "no play url could be requested", unavailable: true };
    if (!refreshed && attempt.unavailable && tried.size < MAX_GETS_PER_EPISODE) {
      let refused;
      try {
        refused = await this.refresh(episode, tried);
      } catch (error) {
        if (error instanceof LoginRequiredError || error instanceof RateLimitedError || error instanceof ChallengeError) {
          throw error;
        }
        if (error instanceof DiscoveryError) {
          return failure(episode, FAILED, `${attempt.reason}; refreshing the episode list failed: ${oneLine(error)}`);
        }
        throw error;
      }
      if (refused !== null) return refused;
      const fresh = this.usableCandidates(episode.raw).filter((url) => !tried.has(url));
      if (fresh.length > 0) {
        ({ result, last } = await this.tryCandidates(episode, context, fresh, tried));
        if (result !== null) return result;
        attempt = last ?? attempt;
      }
    }
    if (attempt.unavailable) return failure(episode, FAILED_UNAVAILABLE, `${UNAVAILABLE_MESSAGE} (${attempt.reason})`);
    if (attempt.incomplete) return failure(episode, FAILED, `${INCOMPLETE_PREFIX}${attempt.reason}`);
    return failure(episode, FAILED, `download failed: ${attempt.reason}`);
  }

  /**
   * `_try_candidates`: GET the candidates in order within the episode's budget, until one yields a
   * video that passes every check (saved: DONE) or the server rate-limits; else why the last one
   * was no good.
   * @param {Episode} episode
   * @param {EpisodeContext} context
   * @param {string[]} candidates
   * @param {Set<string>} tried
   * @returns {Promise<{result: DownloadResult | null, last: Attempt | null}>}
   */
  async tryCandidates(episode, context, candidates, tried) {
    /** @type {Attempt | null} */
    let last = null;
    for (const url of candidates) {
      if (tried.size >= MAX_GETS_PER_EPISODE) break;
      const host = hostOf(url);
      tried.add(url); // the hops of its redirects are no further candidates
      if (!hostCovered(url, this.config.hostPatterns)) {
        // never requested, yet counted like Python's `tried` (which requests every candidate):
        // the budget, the fresh-list condition and `cacheSpent` see the same set
        last = { reason: `${host} is not a host this extension may contact`, unavailable: true };
        continue;
      }
      this.config.onStatus?.(`E${String(episode.number).padStart(2, "0")}: ${host}`);
      /** @type {Response} */
      let response;
      try {
        ({ response } = await fetchFollowing(url, {
          fetch: this.fetch,
          init: { credentials: "include", cache: "no-store", redirect: "manual", headers: { Accept: "*/*" } },
          redirects: this.redirects,
          allowed: (target) => this.redirectAllowed(target),
        }));
      } catch (error) {
        if (error instanceof RedirectRefused && error.kind === "target") {
          // a redirect to a target the extension may not request counts like a denied URL: the
          // next candidate (this URL is spent)
          last = { reason: error.message, unavailable: true };
          continue;
        }
        // a redirect loop, more than MAX_REDIRECTS hops, or a fetch that threw: where Playwright's
        // request raises in `_try_candidates` — FAILED at once, no next mirror, no fresh list
        last = {
          reason: error instanceof RedirectRefused ? error.message : `no response (${oneLine(error)}) from ${host}`,
          unavailable: false,
        };
        break;
      }
      const status = response.status;
      if (status === 429) {
        await response.body?.cancel().catch(() => undefined);
        return { result: failure(episode, FAILED_RATE_LIMITED, MEDIA_RATE_LIMIT_MESSAGE), last: null };
      }
      if (status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        last = { reason: `HTTP ${status} from ${host}`, unavailable: DENIED_STATUSES.has(status) };
        if (DENIED_STATUSES.has(status)) continue;
        break; // the server failing, not this URL: no next mirror, no fresh list
      }
      const contentType = response.headers.get("content-type") ?? "";
      const announced = contentLength(response.headers);
      /** @type {Uint8Array} */
      let body;
      try {
        body = await readBody(response, { idleMs: this.config.idleMs });
      } catch {
        last = { reason: `truncated body (the transfer was cut short) from ${host}`, unavailable: false, incomplete: true };
        break; // the network, not this URL: no next mirror, no fresh list
      }
      if (announced !== null && announced !== body.length) {
        last = {
          reason: `truncated body (${body.length} of ${announced} bytes) from ${host}`,
          unavailable: false,
          incomplete: true,
        };
        break;
      }
      const problem = bodyProblem(body, contentType);
      if (problem !== null) {
        last = { reason: `${problem} from ${host}`, unavailable: true };
        continue;
      }
      const encrypted = drmProblem(body); // always: DramaFetch never keeps encrypted media
      if (encrypted !== null) return { result: failure(episode, FAILED_UNAVAILABLE, encrypted), last: null };
      const invalid = verifyVideo(body, episode.durationS); // always on: a bad file is never saved
      if (invalid !== null) return { result: failure(episode, FAILED, `${INCOMPLETE_PREFIX}${invalid}`), last: null };
      return { result: await this.keep(episode, context, body), last: null };
    }
    return { result: null, last };
  }

  /**
   * The verified video: the cover (one GET, unless `none`), embedded and/or kept as a file per
   * the cover mode, then the save; DONE with `saved <name> (<n> MiB)` and the cover note.
   * @param {Episode} episode
   * @param {EpisodeContext} context
   * @param {Uint8Array} body
   * @returns {Promise<DownloadResult>}
   */
  async keep(episode, context, body) {
    const stem = this.stem(episode, context);
    let video = body;
    let note = "";
    /** @type {{data: Uint8Array, kind: import("../lib/mp4.js").ImageKind} | null} */
    let coverFile = null;
    const thumbnail = this.config.thumbnail;
    if (thumbnail !== "none" && episode.coverUrl) {
      const cover = await this.fetchCover(episode.coverUrl);
      if (cover.ok) {
        const embed = thumbnail === "embed" || thumbnail === "both";
        if (!embed) {
          coverFile = cover;
          note = " + cover file";
        } else if (cover.kind === "webp") {
          coverFile = cover;
          note = "; cover: webp cannot be embedded; saved as file";
        } else {
          try {
            video = embedCover(body, cover.data, cover.kind, `${stem}.mp4`);
            if (thumbnail === "both") {
              coverFile = cover;
              note = " + cover embedded + file";
            } else {
              note = " + cover embedded";
            }
          } catch (error) {
            if (!(error instanceof ThumbnailError)) throw error;
            video = body;
            coverFile = cover;
            note = `; cover: could not embed (${error.message}); saved as file`;
          }
        }
      } else {
        note = cover.note;
      }
    }
    /** @type {chrome.downloads.DownloadItem} */
    let saved;
    try {
      saved = await this.save(video, "video/mp4", downloadFilename(context.folder, stem, "mp4"));
    } catch (error) {
      return failure(episode, FAILED, `could not save ${stem}.mp4: ${oneLine(error)}`);
    }
    this.config.view.remember(saved);
    if (coverFile !== null) {
      const extension = extensionFor(coverFile.kind).slice(1);
      try {
        const coverSaved = await this.save(
          coverFile.data,
          mimeTypeFor(coverFile.kind),
          downloadFilename(context.folder, stem, extension),
        );
        this.config.view.remember(coverSaved);
      } catch (error) {
        note = `${note.startsWith(" + cover embedded") ? " + cover embedded" : ""}; cover: could not save the file (${oneLine(error)})`;
      }
    }
    return {
      episode,
      status: DONE,
      path: saved.filename,
      message: `saved ${fileBaseName(saved.filename)} (${mebibytes(body.length)} MiB)${note}`,
      downloadId: saved.id,
    };
  }

  /**
   * The one cover GET (`_thumbnail`): outside the media budget, no pause before it, never retried;
   * a failure only ever becomes the note `; cover: <reason>` (a 429 included: the video came
   * through, and the next video request stops the run if TikTok is really limiting).
   * @param {string} url
   * @returns {Promise<ImageResult>}
   */
  fetchCover(url) {
    return fetchImage(url, {
      fetch: this.fetch,
      hostPatterns: this.config.hostPatterns,
      idleMs: this.config.idleMs,
      redirects: this.redirects,
      baseUrl: this.config.baseUrl ?? TIKTOK_BASE_URL,
    });
  }

  /**
   * Whether a redirect of one of its requests may be followed to `url` ({@link redirectTargetAllowed}
   * for its base: TikTok's hosts, or the test origin).
   * @param {string} url
   * @returns {boolean}
   */
  redirectAllowed(url) {
    return redirectTargetAllowed(url, this.config.hostPatterns, this.config.baseUrl ?? TIKTOK_BASE_URL);
  }

  /**
   * The item's play URLs in the order the quality gives them, minus the expired ones
   * (`_usable_candidates`).
   * @param {Record<string, unknown> | null} item
   * @returns {string[]}
   */
  usableCandidates(item) {
    if (item === null) return [];
    return playUrlCandidates(item, this.config.quality).filter((url) => this.usable(url));
  }

  /**
   * False when the URL's `expire` is in the past or within {@link EXPIRY_MARGIN_S} (`_usable`).
   * @param {string} url
   * @returns {boolean}
   */
  usable(url) {
    const expiry = urlExpiry(url);
    return expiry === null || expiry > this.now() + EXPIRY_MARGIN_S;
  }

  /**
   * `_refresh`: replace `episode.raw` with the item of a fresh episode list and return null. The
   * series is listed again only when this run holds no fresh list for it yet, or when that list's
   * entry for the episode is spent ({@link cacheSpent}: it names play URLs, and every one was
   * tried for this episode — `stale` — or has expired); the newest list is cached for the run, so a
   * long series is listed again only as often as its play URLs run out. The extension's own extra:
   * a re-discovery that FAILED is not tried again for that series in the run. A fresh entry that
   * reads as `locked` (a lapsed entitlement, a lock, preview or paywall flag, DRM) is not adopted
   * unless includeLocked: FAILED_UNAVAILABLE, none of its URLs requested.
   * @param {Episode} episode
   * @param {ReadonlySet<string>} stale the URLs requested for this episode so far
   * @returns {Promise<DownloadResult | null>}
   */
  async refresh(episode, stale) {
    let fresh = this.freshItems.get(episode.seriesId);
    if (fresh === undefined || this.cacheSpent(fresh.get(episode.itemId) ?? null, stale)) {
      if (this.failedRefreshes.has(episode.seriesId)) return null; // it failed once in this run: not again
      this.refreshes += 1;
      this.config.onStatus?.(`E${String(episode.number).padStart(2, "0")}: fresh episode list`);
      let series;
      try {
        series = await this.config.rediscover({
          kind: "series",
          seriesId: episode.seriesId,
          episodeHint: episode.number,
          sourceUrl: episode.seriesId,
        });
      } catch (error) {
        this.failedRefreshes.add(episode.seriesId);
        throw error;
      }
      fresh = new Map();
      for (const item of series.episodes) if (item.raw !== null) fresh.set(item.itemId, item.raw);
      this.freshItems.set(episode.seriesId, fresh);
    }
    const cached = fresh.get(episode.itemId);
    if (cached === undefined) return null;
    const { access, drm, hints } = accessOf(cached);
    if (access === "locked" && !this.config.includeLocked) {
      const listed = hints.join("; ") || "locked";
      const message = drm
        ? `${DRM_MARK} (in a fresh episode list: ${listed}): DramaFetch does not decrypt it`
        : `${UNAVAILABLE_MESSAGE} (locked in a fresh episode list: ${listed})`;
      return failure(episode, FAILED_UNAVAILABLE, message);
    }
    episode.raw = cached;
    return null;
  }

  /**
   * `_cache_spent`: whether the fresh list's entry for an episode calls for a newer list — it names
   * play URLs, but every one of them was tried for this episode (`stale`) or has expired. An entry
   * without any play URL (a locked episode) and an episode the fresh list does not carry at all are
   * final — one more listing would add no URL — so they never cost one.
   * @param {Record<string, unknown> | null} item
   * @param {ReadonlySet<string>} stale
   * @returns {boolean}
   */
  cacheSpent(item, stale) {
    if (item === null) return false;
    const candidates = playUrlCandidates(item);
    if (candidates.length === 0) return false;
    return candidates.every((url) => stale.has(url) || !this.usable(url));
  }
}

/**
 * @param {Episode} episode
 * @param {import("../lib/messages.js").Status} status
 * @param {string} message
 * @returns {DownloadResult}
 */
function failure(episode, status, message) {
  return { episode, status, path: null, message };
}

// ---------------------------------------------------------------- the list's thumbnails

/**
 * How far outside the window a cover cell already counts as in view, in CSS pixels, above and
 * below (the `rootMargin` of the loader's IntersectionObserver): about one row ahead, so a slow
 * scroll finds the next thumbnail there — no more, so nobody's unseen rows cost a request.
 */
export const COVER_MARGIN_PX = 64;

/**
 * @typedef {object} CoverWatcher What {@link CoverLoader} needs of an IntersectionObserver.
 * @property {(target: Element) => void} observe
 * @property {(target: Element) => void} unobserve
 * @property {() => void} disconnect
 *
 * @typedef {(callback: (entries: readonly {target: Element, isIntersecting: boolean}[]) => void,
 *   init: {rootMargin: string}) => CoverWatcher} CoverWatcherFactory
 *
 * @typedef {object} CoverLoaderOptions
 * @property {readonly string[]} hostPatterns the manifest's host permissions
 * @property {() => Promise<boolean>} allowed whether a request may go out now — no job running or
 *   waiting, no cooldown in force — asked before each pause and again right before each request
 * @property {() => Promise<void>} pause the pause before each request (the list-page pause)
 * @property {(itemId: string, url: string) => void} onCover a thumbnail is ready (an object URL)
 * @property {() => string} [baseUrl] TikTok's origin (the test server's in test mode): a redirect
 *   is followed only where the rule of the extension's own requests applies ({@link fetchImage})
 * @property {typeof fetch} [fetch]
 * @property {(blob: Blob) => string} [objectUrl] `URL.createObjectURL`
 * @property {CoverWatcherFactory} [watcher] how cover cells are watched: an IntersectionObserver
 *   with a {@link COVER_MARGIN_PX} root margin by default
 */

/**
 * The cover thumbnails of the episode list (**Load list**), fetched by the extension itself — not
 * by the page's own `<img>` loads, which go out all at once, follow a redirect to any host and know
 * nothing of a cooldown or a running job — and only for the rows someone can see: a row's
 * thumbnail is wanted once its cover cell comes into view ({@link watch}: an IntersectionObserver,
 * {@link COVER_MARGIN_PX} around the window), and no longer once it leaves before its request went
 * out. The wanted ones go out in the list's order, ONE request at a time, each after its pause,
 * only while `allowed()` — asked before the pause and again right before the request, so nothing
 * goes out during a job or a cooldown — through {@link fetchImage} (the manifest's hosts, the
 * extension's own request rule). Each thumbnail is kept by item id for the page's life, so showing
 * the list again costs no request; one that failed is not asked for again.
 */
export class CoverLoader {
  /** @param {CoverLoaderOptions} options */
  constructor(options) {
    this.options = options;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.objectUrl = options.objectUrl ?? ((blob) => URL.createObjectURL(blob));
    /** @type {CoverWatcherFactory} */
    this.makeWatcher = options.watcher ?? ((callback, init) => new IntersectionObserver(callback, init));
    /** @type {Map<string, string>} item id → object URL, for the page's life */
    this.loaded = new Map();
    /** @type {Set<string>} item ids asked for already (shown or failed): never twice */
    this.asked = new Set();
    /** @type {string[]} the item ids of the list shown that have a cover URL, in its order */
    this.order = [];
    /** @type {Map<string, string>} item id → cover URL, of the list shown */
    this.urls = new Map();
    /** @type {Set<string>} the item ids whose cover cell is in view now */
    this.visible = new Set();
    /** @type {Map<string, Element>} item id → its cover cell, while watched */
    this.cells = new Map();
    /** @type {WeakMap<Element, string>} cover cell → item id */
    this.itemOf = new WeakMap();
    /** @type {CoverWatcher | null} the list's watcher, once a cell is watched */
    this.watcher = null;
    /** @type {Promise<void> | null} the loop, while it runs */
    this.running = null;
  }

  /**
   * The list shown now (instead of an earlier one's): its covers, in order. Nothing is wanted
   * until a row's cover cell comes into view ({@link watch}).
   * @param {readonly {itemId: string, coverUrl: string | null}[]} episodes
   */
  show(episodes) {
    this.watcher?.disconnect();
    this.watcher = null;
    this.order = [];
    this.urls = new Map();
    this.visible = new Set();
    this.cells = new Map();
    this.itemOf = new WeakMap();
    for (const episode of episodes) {
      if (!episode.coverUrl || this.urls.has(episode.itemId)) continue;
      this.urls.set(episode.itemId, episode.coverUrl);
      this.order.push(episode.itemId);
    }
  }

  /**
   * Watch a row's cover cell: its thumbnail is wanted while the cell is in view. A thumbnail
   * fetched already, asked for already, or without a URL needs no watching.
   * @param {Element} cell
   * @param {string} itemId
   */
  watch(cell, itemId) {
    if (!this.urls.has(itemId) || this.loaded.has(itemId) || this.asked.has(itemId)) return;
    if (this.watcher === null) {
      this.watcher = this.makeWatcher(
        (entries) => {
          for (const entry of entries) {
            const id = this.itemOf.get(entry.target);
            if (id !== undefined) this.setVisible(id, entry.isIntersecting);
          }
        },
        { rootMargin: `${COVER_MARGIN_PX}px 0px` },
      );
    }
    this.cells.set(itemId, cell);
    this.itemOf.set(cell, itemId);
    this.watcher.observe(cell);
  }

  /**
   * A row's cover cell came into view (or left it): wanted, and fetching goes on — or no longer.
   * @param {string} itemId
   * @param {boolean} visible
   */
  setVisible(itemId, visible) {
    if (!this.urls.has(itemId)) return;
    if (!visible) {
      this.visible.delete(itemId);
      return;
    }
    this.visible.add(itemId);
    this.resume();
  }

  /**
   * The thumbnails wanted now, in the order they go out: the rows in view, in the list's order,
   * not asked for yet.
   * @returns {string[]} item ids
   */
  wanted() {
    return this.order.filter((id) => this.visible.has(id) && !this.asked.has(id));
  }

  /**
   * @param {string} itemId
   * @returns {string | null} the item's thumbnail (an object URL), once fetched
   */
  urlOf(itemId) {
    return this.loaded.get(itemId) ?? null;
  }

  /** Go on fetching what is wanted (a row came into view, a job ended, a cooldown ran out); one loop at a time. */
  resume() {
    if (this.running !== null || this.next() === null) return;
    this.running = this.loop()
      .catch(() => undefined)
      .finally(() => {
        this.running = null;
      });
  }

  /** @returns {Promise<void>} once no thumbnail request is in flight (a job waits for it) */
  async idle() {
    while (this.running !== null) await this.running;
  }

  /**
   * The next thumbnail to ask for, or null; one whose host the manifest does not cover is marked
   * asked on the way (never requested, so no pause either).
   * @returns {string | null}
   */
  next() {
    for (const id of this.wanted()) {
      if (hostCovered(/** @type {string} */ (this.urls.get(id)), this.options.hostPatterns)) return id;
      this.asked.add(id);
      this.forget(id);
    }
    return null;
  }

  /**
   * Stop watching a row whose thumbnail needs no more looking at.
   * @param {string} itemId
   */
  forget(itemId) {
    const cell = this.cells.get(itemId);
    if (cell === undefined) return;
    this.cells.delete(itemId);
    this.watcher?.unobserve(cell);
  }

  /** @returns {Promise<void>} */
  async loop() {
    while (this.next() !== null) {
      if (!(await this.options.allowed())) return;
      await this.options.pause();
      if (!(await this.options.allowed())) return; // asked again right before the request
      const id = this.next(); // what is in view NOW: the list may have scrolled during the pause
      if (id === null) return;
      const url = /** @type {string} */ (this.urls.get(id));
      this.asked.add(id);
      this.forget(id);
      /** @type {ImageOptions} */
      const request = { fetch: this.fetch, hostPatterns: this.options.hostPatterns };
      if (this.options.baseUrl !== undefined) request.baseUrl = this.options.baseUrl();
      const image = await fetchImage(url, request);
      if (!image.ok) continue;
      const blob = new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (image.data)], { type: mimeTypeFor(image.kind) });
      const objectUrl = this.objectUrl(blob);
      this.loaded.set(id, objectUrl);
      this.options.onCover(id, objectUrl);
    }
  }
}
