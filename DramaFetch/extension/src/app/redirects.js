// @ts-check
/**
 * The redirects answered to the extension's OWN requests (its media, cover and thumbnail GETs), and
 * the one way they are followed.
 *
 * The extension fetches with `redirect: "manual"`: Chrome never follows a redirect for it, and the
 * answer (an `opaqueredirect`: status 0, no headers, no body) does not say where it pointed. Chrome
 * does tell the extension through `chrome.webRequest.onBeforeRedirect` — observation only, like
 * every webRequest use of DramaFetch: no blocking, no request changed, no body read. A
 * {@link RedirectTracker} records, for the requests whose initiator is the extension itself and
 * whose URL the manifest's host permissions cover, `url → redirectUrl`; {@link fetchFollowing} then
 * requests the target ITSELF, exactly the same way (`credentials: "include"`, `cache: "no-store"`,
 * `redirect: "manual"`, the same headers), so the declarativeNetRequest rule of the extension's own
 * requests (`Referer` set, `Origin` removed) applies to every hop too — but only when the target is
 * known, allowed (the manifest's hosts; in test mode the test origin), not a downgrade from https,
 * not a URL of the chain already, and at most {@link MAX_REDIRECTS} hops from the URL requested
 * (what the Python browser engine's Playwright follows, `max_redirects=5`). Anything else is
 * {@link RedirectRefused}, whose message names hosts only — never a path or a query string, which
 * carry signatures — and whose `kind` tells a target the extension may not request (`target`)
 * from a loop or a chain longer than {@link MAX_REDIRECTS} (`loop`, `limit`: where Playwright's
 * request raises). The hops of one URL are not further candidate URLs: the caller's budget counts
 * the URLs it requested, as Python's `tried` does. The listener is registered for the DramaFetch
 * tab only ({@link initPageRedirects}): Chrome never hands it a redirect of another tab.
 */

/** Redirects followed per requested URL, at most (`downloader_browser.MAX_REDIRECTS`). */
export const MAX_REDIRECTS = 5;
/** How long a lookup waits for an `onBeforeRedirect` event that has not arrived yet. */
export const REDIRECT_EVENT_WAIT_MS = 1000;
/** The tracker keeps at most this many unclaimed redirects (the oldest go first). */
export const MAX_TRACKED_REDIRECTS = 32;

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
 * Whether a `redirect: "manual"` answer is a redirect the browser did not follow (an
 * `opaqueredirect`: status 0, no headers, no body — the target is not in it).
 * @param {Response} response
 * @returns {boolean}
 */
export function isRedirect(response) {
  return response.type === "opaqueredirect" || response.status === 0;
}

/**
 * Why a redirect is not followed: `target` — no target known, one the extension may not request,
 * or https down to http (like a refused URL: the next candidate); `loop` — the chain came back to
 * one of its URLs; `limit` — more than {@link MAX_REDIRECTS} hops. The last two are where
 * Playwright's request raises (`Max redirect count exceeded`): the episode fails.
 * @typedef {"target" | "loop" | "limit"} RefusalKind
 */

/** A redirect the extension does not follow; the message names hosts only. */
export class RedirectRefused extends Error {
  /**
   * @param {string} message
   * @param {RefusalKind} [kind]
   */
  constructor(message, kind = "target") {
    super(message);
    this.name = "RedirectRefused";
    /** @type {RefusalKind} */
    this.kind = kind;
  }
}

/**
 * @typedef {object} RedirectEvent What `onBeforeRedirect` reports (the fields the tracker reads).
 * @property {string} url the URL that answered the redirect
 * @property {string} redirectUrl where it points
 * @property {string} [initiator] the origin that made the request
 * @property {number} [timeStamp] when Chrome saw the redirect, in milliseconds since the epoch
 */

/**
 * The redirects answered to the extension's own requests, `url → redirectUrl`, from the moment the
 * request is about to go out ({@link expect}) until its lookup ({@link take}) claims it. Only events
 * whose initiator is the extension itself count, and only the current request's: an event Chrome
 * stamped before the request of its URL went out belongs to an earlier request of that URL (its
 * lookup gave up on it) and is dropped. At most {@link MAX_TRACKED_REDIRECTS} unclaimed ones are
 * kept.
 */
export class RedirectTracker {
  /**
   * @param {{initiator: string, waitMs?: number, maxEntries?: number, now?: () => number}} options
   *   `initiator` the extension's origin, `chrome-extension://<id>`; `now` the clock the requests
   *   are stamped with, `Date.now` by default (Chrome stamps its events in epoch milliseconds too)
   */
  constructor(options) {
    this.initiator = options.initiator;
    this.waitMs = options.waitMs ?? REDIRECT_EVENT_WAIT_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? MAX_TRACKED_REDIRECTS);
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, string>} requested URL → where it redirected, oldest first */
    this.targets = new Map();
    /** @type {Map<string, (target: string) => void>} the lookup waiting for a URL's event */
    this.waiting = new Map();
    /** @type {Map<string, number>} requested URL → when its latest request was about to go out */
    this.expectedAt = new Map();
    /** The `onBeforeRedirect` listener. @param {RedirectEvent} details */
    this.listener = (details) => this.record(details);
  }

  /**
   * Whether an event belongs to an earlier request of its URL than the one expected now: Chrome
   * stamped it before that request went out. A late event of an earlier request is at least the
   * wait older than the next request of its URL (that request's lookup waited for it), the
   * current request's never older: half the wait leaves room for the clocks of Chrome's processes.
   * An event without a time stamp is not judged.
   * @param {RedirectEvent} details
   * @returns {boolean}
   */
  stale(details) {
    const expected = this.expectedAt.get(details.url);
    if (expected === undefined || typeof details.timeStamp !== "number") return false;
    return details.timeStamp < expected - this.waitMs / 2;
  }

  /**
   * One `onBeforeRedirect` event: kept when the extension itself made the request and it is the
   * current request's.
   * @param {RedirectEvent} details
   */
  record(details) {
    if (details.initiator !== this.initiator) return;
    if (typeof details.url !== "string" || typeof details.redirectUrl !== "string") return;
    if (this.stale(details)) return; // an earlier request's event, arrived late: never this one's answer
    const waiter = this.waiting.get(details.url);
    if (waiter !== undefined) {
      this.waiting.delete(details.url);
      waiter(details.redirectUrl); // the lookup waiting for it takes it at once
      return;
    }
    this.targets.delete(details.url);
    this.targets.set(details.url, details.redirectUrl);
    for (const oldest of this.targets.keys()) {
      if (this.targets.size <= this.maxEntries) break;
      this.targets.delete(oldest);
    }
  }

  /**
   * A request of `url` is about to go out: forget where an earlier one redirected and note when
   * this one left, so only this request's event can answer its lookup ({@link stale}).
   * @param {string} url
   */
  expect(url) {
    this.targets.delete(url);
    this.expectedAt.delete(url);
    this.expectedAt.set(url, this.now());
    for (const oldest of this.expectedAt.keys()) {
      if (this.expectedAt.size <= this.maxEntries) break;
      this.expectedAt.delete(oldest);
    }
  }

  /**
   * Where the request of `url` was redirected — claimed, so asked once — waiting up to `waitMs`
   * for an event that has not arrived yet (the answer may come before Chrome's event); null when
   * none comes.
   * @param {string} url
   * @param {number} [waitMs]
   * @returns {Promise<string | null>}
   */
  take(url, waitMs = this.waitMs) {
    const known = this.targets.get(url);
    if (known !== undefined) {
      this.targets.delete(url);
      return Promise.resolve(known);
    }
    if (waitMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiting.get(url) === claim) this.waiting.delete(url);
        resolve(null);
      }, waitMs);
      /** @param {string} target */
      const claim = (target) => {
        clearTimeout(timer);
        resolve(target);
      };
      this.waiting.set(url, claim);
    });
  }
}

/**
 * A tracker listening to `chrome.webRequest.onBeforeRedirect` for the URLs the manifest's host
 * permissions cover, in the tab `tabId` only — the DramaFetch tab, whose page makes the
 * extension's own requests: Chrome then never hands it a redirect of another tab, the user's
 * TikTok tabs and the discovery's included (observation only: no `blocking`, no `extraHeaders`).
 * @param {readonly string[]} hostPatterns
 * @param {number} tabId
 * @returns {RedirectTracker}
 */
export function chromeRedirectTracker(hostPatterns, tabId) {
  const tracker = new RedirectTracker({ initiator: chrome.runtime.getURL("").replace(/\/+$/, "") });
  if (hostPatterns.length > 0) {
    chrome.webRequest.onBeforeRedirect.addListener(tracker.listener, {
      urls: [...hostPatterns],
      types: ["xmlhttprequest", "other"],
      tabId,
    });
  }
  return tracker;
}

/** @type {RedirectTracker | null} the page's tracker, once made */
let pageTracker = null;

/**
 * Register the page's one tracker for its tab (the DramaFetch tab calls it once it knows its tab
 * id, before its first request of its own); the tracker, or null where `chrome.webRequest` does
 * not exist or the tab is unknown (no redirect is then followed).
 * @param {number | undefined} tabId
 * @returns {RedirectTracker | null}
 */
export function initPageRedirects(tabId) {
  if (pageTracker !== null) return pageTracker;
  if (tabId === undefined || typeof chrome === "undefined" || chrome.webRequest?.onBeforeRedirect === undefined) {
    return null;
  }
  pageTracker = chromeRedirectTracker(chrome.runtime.getManifest().host_permissions ?? [], tabId);
  return pageTracker;
}

/**
 * The extension page's one tracker, or null until {@link initPageRedirects} registered it — and
 * wherever it could not (Node, no tab): no redirect is then followed.
 * @returns {RedirectTracker | null}
 */
export function pageRedirects() {
  return pageTracker;
}

/**
 * @typedef {object} FollowOptions
 * @property {typeof fetch} fetch
 * @property {RequestInit} init the request, the same for every hop (`redirect: "manual"`)
 * @property {RedirectTracker | null} redirects where the redirects are learnt (null: none followed)
 * @property {(url: string) => boolean} allowed whether a redirect target may be requested
 * @property {number} [maxRedirects]
 */

/**
 * GET `url`, following a redirect only to a known, allowed target, at most `maxRedirects` hops
 * (each requested the same way); the first answer that is no redirect. A fetch that throws (a hop
 * included) throws as it is; a redirect not followed throws {@link RedirectRefused} — `limit`
 * past `maxRedirects` hops, `loop` back to a URL of the chain, `target` for the rest.
 * @param {string} url
 * @param {FollowOptions} options
 * @returns {Promise<{response: Response, url: string, hops: number}>}
 */
export async function fetchFollowing(url, options) {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const chain = new Set([url]);
  let current = url;
  for (let hops = 0; ; hops += 1) {
    options.redirects?.expect(current);
    const response = await options.fetch(current, options.init);
    if (!isRedirect(response)) return { response, url: current, hops };
    const from = hostOf(current);
    const target = options.redirects === null ? null : await options.redirects.take(current);
    if (hops >= maxRedirects) {
      throw new RedirectRefused(`more than ${maxRedirects} redirects from ${hostOf(url)}, not followed`, "limit");
    }
    /** @type {URL | null} */
    let parsed = null;
    try {
      parsed = target === null ? null : new URL(target);
    } catch {
      parsed = null;
    }
    if (parsed === null || target === null) throw new RedirectRefused(`a redirect from ${from}, not followed`);
    if (new URL(current).protocol === "https:" && parsed.protocol !== "https:") {
      throw new RedirectRefused(`a redirect from ${from} down to ${parsed.protocol.replace(/:$/, "")} on ${hostOf(target)}, not followed`);
    }
    if (!options.allowed(target)) throw new RedirectRefused(`a redirect from ${from}, not followed`);
    if (chain.has(target)) throw new RedirectRefused(`a redirect loop at ${from}, not followed`, "loop");
    chain.add(target);
    current = target;
  }
}
