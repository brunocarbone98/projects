// @ts-check
/**
 * One episode at a time, from the extension page: a port of `downloader_browser.BrowserDownloader`
 * and of the skip helpers it shares with the yt-dlp engine (`downloader.locked_result`,
 * `existing_file_result`).
 *
 * The item_list payload TikTok served to the user's own session already carries every episode's
 * signed play URLs; this module fetches them directly, one GET at a time and at most
 * {@link MAX_GETS_PER_EPISODE} per episode (an in-run re-discovery included), with the session's
 * cookies (`credentials: "include"` — the extension never reads them) and `Referer:
 * https://www.tiktok.com/`, which a declarativeNetRequest SESSION rule scoped to the extension's
 * own requests sets ({@link applyRefererRule}; what `downloader_browser` sends). A URL whose host
 * the manifest does not cover is never requested. The body is judged in memory, in this order:
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
import { EXPIRY_MARGIN_S, MAX_GETS_PER_EPISODE } from "../lib/pacing.js";
import { lockedResult } from "../lib/report.js";
import { ChallengeError, DiscoveryError, LoginRequiredError, RateLimitedError } from "./discovery.js";

export { MAX_GETS_PER_EPISODE };

/** Answers that mean "not this URL": try the next candidate, then a fresh list (`_DENIED_STATUSES`). */
const DENIED_STATUSES = new Set([403, 404, 410]);
/** `Content-Encoding` values under which `Content-Length` is the body's own length. */
const IDENTITY_ENCODINGS = new Set(["", "identity"]);
/** A transfer that delivers nothing for this long is cut off (`REQUEST_TIMEOUT_MS`, 120 s). */
export const IDLE_TIMEOUT_MS = 120_000;
/** The declarativeNetRequest session rule that sets the Referer on the extension's own requests. */
export const REFERER_RULE_ID = 1;
/** The domains of the manifest's host permissions (the rule's `requestDomains`). */
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
 * @property {boolean} unavailable a denied status, a non-video body, a host not allowed
 * @property {boolean} [incomplete] a truncated transfer
 */

// ------------------------------------------------------------------------ pure helpers

/**
 * The host of a URL — the only part of a signed play URL a message may name (`_host`).
 * @param {string} url
 * @returns {string}
 */
export function hostOf(url) {
  try {
    return new URL(url).hostname || "unknown host";
  } catch {
    return "unknown host";
  }
}

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
 * Install (or replace) the session rule that sets `Referer: <base>/` on the requests the
 * extension's own pages make to TikTok's hosts — never on TikTok's page's requests (the rule's
 * initiator is the extension itself). Called before every job; session rules end with the browser.
 * @param {string} base TikTok's origin (the fake server's in test mode)
 * @returns {Promise<void>}
 */
export async function applyRefererRule(base) {
  const origin = base.replace(/\/+$/, "");
  /** @type {chrome.declarativeNetRequest.RuleCondition} */
  const condition = {
    initiatorDomains: [chrome.runtime.id],
    resourceTypes: ["xmlhttprequest", "other"],
  };
  if (origin === TIKTOK_BASE_URL) condition.requestDomains = [...TIKTOK_DOMAINS];
  else condition.urlFilter = `|${origin}/`;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [REFERER_RULE_ID],
    addRules: [
      {
        id: REFERER_RULE_ID,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "Referer", operation: "set", value: `${origin}/` }] },
        condition,
      },
    ],
  });
}

// ------------------------------------------------------------------- Chrome's downloads

/**
 * What Chrome's download history says, taken once per series (`refresh`) and kept up to date with
 * the files this run saves: which recorded download still exists (the state's {@link exists}
 * answer) and which completed download sits exactly at a target path ({@link completedAt}).
 */
export class DownloadsView {
  /**
   * @param {{api?: typeof chrome.downloads, sleep?: (seconds: number) => Promise<void>, existenceDelayMs?: number}} [options]
   */
  constructor(options = {}) {
    this.api = options.api ?? chrome.downloads;
    this.sleep = options.sleep ?? ((seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)));
    this.existenceDelayMs = options.existenceDelayMs ?? 300;
    /** @type {Map<number, chrome.downloads.DownloadItem>} */
    this.byId = new Map();
  }

  /**
   * Ask Chrome to check whether its downloaded files still exist (any search does; the answer
   * arrives a moment later), wait for it, then read the completed downloads.
   * @returns {Promise<void>}
   */
  async refresh() {
    await this.api.search({ limit: 1 });
    await this.sleep(this.existenceDelayMs / 1000);
    const items = await this.api.search({ state: "complete", limit: 0 });
    this.byId = new Map(items.map((item) => [item.id, item]));
  }

  /**
   * The state's "file still exists" answer: the entry's download is complete and its file exists.
   * @param {{download_id?: number | null}} entry
   * @returns {boolean}
   */
  exists(entry) {
    if (entry.download_id === null || entry.download_id === undefined) return false;
    const item = this.byId.get(entry.download_id);
    return item !== undefined && item.state === "complete" && item.exists;
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
 */

/** Downloads one episode at a time from the play URLs its item carries (`BrowserDownloader`). */
export class Downloader {
  /** @param {DownloaderConfig} config */
  constructor(config) {
    this.config = config;
    this.now = config.now ?? (() => Date.now() / 1000);
    this.fetch = config.fetch ?? ((input, init) => fetch(input, init));
    this.save = config.save ?? ((bytes, mime, filename) => saveFile(bytes, mime, filename));
    /** @type {Map<string, Map<string, Record<string, unknown>>>} series id → item id → fresh item */
    this.freshItems = new Map();
    /** @type {Set<string>} series re-discovered in this run (at most once each) */
    this.refreshed = new Set();
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
      const refused = await this.refresh(episode);
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
        refused = await this.refresh(episode);
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
      if (!hostCovered(url, this.config.hostPatterns)) {
        last = { reason: `${host} is not a host this extension may contact`, unavailable: true };
        continue; // never requested, so not counted either
      }
      tried.add(url);
      this.config.onStatus?.(`E${String(episode.number).padStart(2, "0")}: ${host}`);
      /** @type {Response} */
      let response;
      try {
        response = await this.fetch(url, { credentials: "include", cache: "no-store", headers: { Accept: "*/*" } });
      } catch (error) {
        last = { reason: `no response (${oneLine(error)}) from ${host}`, unavailable: true };
        continue;
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
   * @returns {Promise<{ok: true, data: Uint8Array, kind: import("../lib/mp4.js").ImageKind} | {ok: false, note: string}>}
   */
  async fetchCover(url) {
    const host = hostOf(url);
    if (!hostCovered(url, this.config.hostPatterns)) {
      return { ok: false, note: `; cover: ${host} is not a host this extension may contact` };
    }
    try {
      const response = await this.fetch(url, {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "image/*,*/*" },
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, note: `; cover: HTTP ${response.status} from ${host}` };
      }
      const contentType = response.headers.get("content-type") ?? "";
      const data = await readBody(response, { idleMs: this.config.idleMs, maxBytes: MAX_COVER_BYTES });
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
   * `_refresh`: replace `episode.raw` with the item of a fresh episode list and return null — at
   * most ONE re-discovery per series and run (cached for the run). A fresh entry that reads as
   * `locked` (a lapsed entitlement, a lock, preview or paywall flag, DRM) is not adopted unless
   * includeLocked: FAILED_UNAVAILABLE, none of its URLs requested.
   * @param {Episode} episode
   * @returns {Promise<DownloadResult | null>}
   */
  async refresh(episode) {
    let fresh = this.freshItems.get(episode.seriesId);
    if (fresh === undefined) {
      if (this.refreshed.has(episode.seriesId)) return null; // the one re-discovery failed already
      this.refreshed.add(episode.seriesId);
      this.refreshes += 1;
      this.config.onStatus?.(`E${String(episode.number).padStart(2, "0")}: fresh episode list`);
      const series = await this.config.rediscover({
        kind: "series",
        seriesId: episode.seriesId,
        episodeHint: episode.number,
        sourceUrl: episode.seriesId,
      });
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
