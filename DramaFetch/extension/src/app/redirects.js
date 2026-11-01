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
 * carry signatures. The hops of one URL are not further candidate URLs: the caller's budget counts
 * the URLs it requested, as Python's `tried` does.
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

/** A redirect the extension does not follow; the message names hosts only. */
export class RedirectRefused extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "RedirectRefused";
  }
}

/**
 * @typedef {object} RedirectEvent What `onBeforeRedirect` reports (the fields the tracker reads).
 * @property {string} url the URL that answered the redirect
 * @property {string} redirectUrl where it points
 * @property {string} [initiator] the origin that made the request
 */

/**
 * The redirects answered to the extension's own requests, `url → redirectUrl`, from the moment the
 * request is about to go out ({@link expect}) until its lookup ({@link take}) claims it. Only events
 * whose initiator is the extension itself count; at most {@link MAX_TRACKED_REDIRECTS} unclaimed
 * ones are kept.
 */
export class RedirectTracker {
  /**
   * @param {{initiator: string, waitMs?: number, maxEntries?: number}} options `initiator` the
   *   extension's origin, `chrome-extension://<id>`
   */
  constructor(options) {
    this.initiator = options.initiator;
    this.waitMs = options.waitMs ?? REDIRECT_EVENT_WAIT_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? MAX_TRACKED_REDIRECTS);
    /** @type {Map<string, string>} requested URL → where it redirected, oldest first */
    this.targets = new Map();
    /** @type {Map<string, (target: string) => void>} the lookup waiting for a URL's event */
    this.waiting = new Map();
    /** The `onBeforeRedirect` listener. @param {RedirectEvent} details */
    this.listener = (details) => this.record(details);
  }

  /**
   * One `onBeforeRedirect` event: kept when the extension itself made the request.
   * @param {RedirectEvent} details
   */
  record(details) {
    if (details.initiator !== this.initiator) return;
    if (typeof details.url !== "string" || typeof details.redirectUrl !== "string") return;
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
   * A request of `url` is about to go out: forget where an earlier one redirected, so only this
   * request's event can answer its lookup.
   * @param {string} url
   */
  expect(url) {
    this.targets.delete(url);
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
 * permissions cover (observation only: no `blocking`, no `extraHeaders`).
 * @param {readonly string[]} hostPatterns
 * @returns {RedirectTracker}
 */
export function chromeRedirectTracker(hostPatterns) {
  const tracker = new RedirectTracker({ initiator: chrome.runtime.getURL("").replace(/\/+$/, "") });
  if (hostPatterns.length > 0) {
    chrome.webRequest.onBeforeRedirect.addListener(tracker.listener, {
      urls: [...hostPatterns],
      types: ["xmlhttprequest", "other"],
    });
  }
  return tracker;
}

/** @type {RedirectTracker | null} the page's tracker, once made */
let pageTracker = null;

/**
 * The extension page's one tracker, registered on first use (before the page's first request of
 * its own), or null where `chrome.webRequest` does not exist (Node: no redirect is then followed).
 * @returns {RedirectTracker | null}
 */
export function pageRedirects() {
  if (pageTracker !== null) return pageTracker;
  if (typeof chrome === "undefined" || chrome.webRequest?.onBeforeRedirect === undefined) return null;
  pageTracker = chromeRedirectTracker(chrome.runtime.getManifest().host_permissions ?? []);
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
 * included) throws as it is; a redirect not followed throws {@link RedirectRefused}.
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
      throw new RedirectRefused(`more than ${maxRedirects} redirects from ${hostOf(url)}, not followed`);
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
    if (chain.has(target)) throw new RedirectRefused(`a redirect loop at ${from}, not followed`);
    chain.add(target);
    current = target;
  }
}
