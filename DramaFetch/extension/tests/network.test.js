// @ts-check
// Unit tests of the extension's own network behaviour, over fakes (no browser, no network, no real
// sleep): the request-header rule (Referer set, Origin removed) and its domains, the redirects of
// the extension's own requests (src/app/redirects.js: learnt from onBeforeRedirect, followed only
// the safe way), and the in-run re-discovery's parity with `downloader_browser._refresh` /
// `_cache_spent`. The integration scenarios (tests/integration/test_extension_network.py) drive the
// same code in a real Chromium against the fake TikTok server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { makeEpisode } from "../src/lib/catalog.js";
import { TIKTOK_BASE_URL, UNAVAILABLE_MESSAGE } from "../src/lib/messages.js";
import { DiscoveryError } from "../src/app/discovery.js";
import {
  Downloader,
  REFERER_RULE_ID,
  TIKTOK_DOMAINS,
  applyRefererRule,
  fetchImage,
  redirectTargetAllowed,
  refererRule,
} from "../src/app/downloader.js";
import {
  MAX_REDIRECTS,
  MAX_TRACKED_REDIRECTS,
  RedirectRefused,
  RedirectTracker,
  fetchFollowing,
  initPageRedirects,
  pageRedirects,
} from "../src/app/redirects.js";

const TINY = readFileSync(new URL("../../tests/fixtures/tiny.mp4", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const SERIES_ID = "7699393770256782354";
const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const HOSTS = ["https://*.tiktok.com/*", "https://*.tiktokcdn.com/*"];
const CONTEXT = { seriesName: "Test Series", folder: `Test Series [${SERIES_ID}]` };

/**
 * tiny.mp4 padded with a top-level `free` box to 128 KiB (a real video: >= 64 KiB, 3 s, audio).
 * @returns {Uint8Array<ArrayBuffer>}
 */
function video() {
  const size = 128 * 1024;
  const out = new Uint8Array(size);
  out.set(TINY, 0);
  new DataView(out.buffer).setUint32(TINY.length, size - TINY.length);
  out.set([0x66, 0x72, 0x65, 0x65], TINY.length + 4);
  return out;
}

/** A JPEG-looking cover of 600 bytes (the magic decides; nothing decodes it). */
const COVER = (() => {
  const out = new Uint8Array(600);
  out.set([0xff, 0xd8, 0xff, 0xe0]);
  out.set([0xff, 0xd9], 598);
  return out;
})();

const videoResponse = () => new Response(video(), { headers: { "content-type": "video/mp4" } });
const coverResponse = () => new Response(COVER, { headers: { "content-type": "image/jpeg" } });
const denied = () => new Response("no", { status: 403 });
/** What `fetch(url, {redirect: "manual"})` answers for a 3xx: an opaque redirect, target not in it. */
const opaqueRedirect = () =>
  /** @type {Response} */ (/** @type {unknown} */ ({ type: "opaqueredirect", status: 0, headers: new Headers(), body: null }));

/**
 * An item shaped like TikTok's: one URL as `video.playAddr`, several as one H.264 rendition's
 * `PlayAddr.UrlList` (in that order), none as an empty `playAddr` (no play address: locked).
 * @param {number} number
 * @param {string[]} urls
 * @returns {Record<string, unknown>}
 */
function item(number, urls) {
  if (urls.length <= 1) return { id: `item${number}`, video: { playAddr: urls[0] ?? "" } };
  const rendition = { Bitrate: 1_000_000, CodecType: "h264", GearName: "normal_720_0", PlayAddr: { UrlList: urls } };
  return { id: `item${number}`, video: { playAddr: "", bitrateInfo: [rendition] } };
}

/**
 * @param {number} number
 * @param {string[]} urls the play URLs of the item (none: no play address, a locked entry)
 */
function episode(number, urls) {
  return makeEpisode({
    number,
    itemId: `item${number}`,
    title: `Episode ${number}`,
    seriesId: SERIES_ID,
    seriesName: "Test Series",
    durationS: 3,
    coverUrl: `https://p16-sign-sg.tiktokcdn.com/c/${number}.jpeg`,
    raw: item(number, urls),
  });
}

/** @param {import("../src/lib/catalog.js").Episode[]} episodes */
const series = (episodes) => ({ seriesId: SERIES_ID, name: "Test Series", episodes, totalHint: null, warnings: [] });

/**
 * A route of the fake network: an answer, or a redirect to `to` — whose `onBeforeRedirect` event
 * Chrome delivers before the answer resolves (`late`: after it, the order Chrome does not promise).
 * @typedef {(() => Response) | {to: string, late?: boolean, silent?: boolean}} Route
 */

/**
 * A fake `fetch` over exact URLs (a missing one fails like a host Chrome cannot reach), logging
 * every request and its init, and reporting each redirect to `tracker` as Chrome would.
 * @param {Record<string, Route>} routes
 * @param {RedirectTracker | null} tracker
 */
function network(routes, tracker) {
  /** @type {string[]} */
  const log = [];
  /** @type {(RequestInit | undefined)[]} */
  const inits = [];
  const fetchFn = /** @type {typeof fetch} */ (
    async (input, init) => {
      const url = String(input);
      log.push(url);
      inits.push(init);
      const route = routes[url];
      if (route === undefined) throw new TypeError("Failed to fetch");
      if (typeof route === "function") return route();
      const event = { url, redirectUrl: route.to, initiator: EXTENSION_ORIGIN };
      if (tracker !== null && !route.silent) {
        if (route.late) setTimeout(() => tracker.record(event), 0);
        else tracker.record(event);
      }
      return opaqueRedirect();
    }
  );
  return { fetchFn, log, inits };
}

/**
 * @param {{fetch: typeof fetch, redirects: RedirectTracker | null, baseUrl?: string, hostPatterns?: string[],
 *   rediscover?: (ref: import("../src/lib/urls.js").SeriesRef) => Promise<import("../src/lib/catalog.js").Series>,
 *   now?: () => number, thumbnail?: string}} options
 */
function downloader(options) {
  /** @type {string[]} */
  const saved = [];
  let id = 0;
  const subject = new Downloader({
    baseUrl: options.baseUrl,
    quality: "compatible",
    thumbnail: options.thumbnail ?? "embed",
    nameFormat: "{series} - Episode {number}",
    includeLocked: false,
    hostPatterns: options.hostPatterns ?? HOSTS,
    view: /** @type {never} */ ({ completedAt: () => null, remember() {} }),
    rediscover:
      options.rediscover ??
      (async () => {
        throw new Error("no re-discovery expected");
      }),
    now: options.now,
    fetch: options.fetch,
    redirects: options.redirects,
    save: async (_bytes, _mime, filename) => {
      saved.push(filename);
      id += 1;
      return /** @type {never} */ ({ id, filename: `/home/me/Downloads/${filename}`, state: "complete", exists: true });
    },
  });
  return { subject, saved };
}

const tracker = () => new RedirectTracker({ initiator: EXTENSION_ORIGIN, waitMs: 20 });

/**
 * A fake global `chrome` for the rule (runtime.id, declarativeNetRequest) — removed by `restore`.
 * @param {Record<string, unknown>} [extra]
 */
function fakeChrome(extra = {}) {
  /** @type {unknown[]} */
  const updates = [];
  const chrome = {
    runtime: { id: "abcdefghijklmnopabcdefghijklmnop" },
    declarativeNetRequest: {
      updateSessionRules: async (/** @type {unknown} */ options) => {
        updates.push(options);
      },
    },
    ...extra,
  };
  Object.assign(globalThis, { chrome });
  return { updates, restore: () => Reflect.deleteProperty(globalThis, "chrome") };
}

// ------------------------------------------------------------------ the request-header rule

test("the rule of the extension's own requests sets the Referer and removes the Origin", async () => {
  const fake = fakeChrome();
  try {
    const production = refererRule(TIKTOK_BASE_URL);
    assert.equal(production.id, REFERER_RULE_ID);
    assert.deepEqual(production.action, {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Referer", operation: "set", value: "https://www.tiktok.com/" },
        { header: "Origin", operation: "remove" },
      ],
    });
    assert.deepEqual(production.condition, {
      initiatorDomains: ["abcdefghijklmnopabcdefghijklmnop"], // the extension itself: never TikTok's page
      resourceTypes: ["xmlhttprequest", "other"],
      requestDomains: [...TIKTOK_DOMAINS],
    });
    // test mode: the same two changes, on the test origin only
    const testing = refererRule("http://127.0.0.1:4321/");
    assert.deepEqual(testing.action.requestHeaders, [
      { header: "Referer", operation: "set", value: "http://127.0.0.1:4321/" },
      { header: "Origin", operation: "remove" },
    ]);
    assert.deepEqual(testing.condition, {
      initiatorDomains: ["abcdefghijklmnopabcdefghijklmnop"],
      resourceTypes: ["xmlhttprequest", "other"],
      urlFilter: "|http://127.0.0.1:4321/",
    });
    await applyRefererRule(TIKTOK_BASE_URL);
    assert.deepEqual(fake.updates, [{ removeRuleIds: [REFERER_RULE_ID], addRules: [production] }]);
  } finally {
    fake.restore();
  }
});

test("TIKTOK_DOMAINS are exactly the domains of the manifest's host permissions", () => {
  /** @type {string[]} */
  const patterns = MANIFEST.host_permissions;
  const hosts = patterns.map((pattern) => {
    const match = /^https:\/\/([^/]+)\/\*$/.exec(pattern);
    assert.ok(match !== null, `${pattern}: an https host pattern`);
    return /** @type {string} */ (match[1]).replace(/^\*\./, "");
  });
  // a host that is a subdomain of another listed one adds no domain (www.tiktok.com: tiktok.com)
  const domains = hosts.filter((host) => !hosts.some((other) => other !== host && host.endsWith(`.${other}`)));
  assert.deepEqual([...TIKTOK_DOMAINS].sort(), [...new Set(domains)].sort());
  assert.equal(new Set(TIKTOK_DOMAINS).size, TIKTOK_DOMAINS.length);
  for (const domain of TIKTOK_DOMAINS) assert.ok(patterns.includes(`https://*.${domain}/*`), domain);
});

test("a redirect target must be a host of the manifest the rule covers: TikTok's, or the test origin", () => {
  assert.equal(redirectTargetAllowed("https://v16m.tiktokcdn.com/x.mp4", HOSTS, TIKTOK_BASE_URL), true);
  assert.equal(redirectTargetAllowed("https://tiktok.com/x", HOSTS, TIKTOK_BASE_URL), true);
  assert.equal(redirectTargetAllowed("https://evil.example.com/x.mp4", HOSTS, TIKTOK_BASE_URL), false);
  assert.equal(redirectTargetAllowed("https://faketiktok.com/x", HOSTS, TIKTOK_BASE_URL), false);
  assert.equal(redirectTargetAllowed("http://v16m.tiktokcdn.com/x.mp4", HOSTS, TIKTOK_BASE_URL), false); // https only
  const testHosts = [...HOSTS, "http://127.0.0.1/*"];
  assert.equal(redirectTargetAllowed("http://127.0.0.1:4321/hop/1", testHosts, "http://127.0.0.1:4321"), true);
  assert.equal(redirectTargetAllowed("http://127.0.0.1:9999/hop/1", testHosts, "http://127.0.0.1:4321"), false);
  assert.equal(redirectTargetAllowed("http://localhost:4321/hop/1", testHosts, "http://127.0.0.1:4321"), false);
  assert.equal(redirectTargetAllowed("https://v16m.tiktokcdn.com/x", testHosts, "http://127.0.0.1:4321"), false);
  assert.equal(redirectTargetAllowed("http://127.0.0.1:9999/x", testHosts), true); // no base: the hosts decide
});

// -------------------------------------------------------------------------- the tracker

test("the tracker keeps the extension's own redirects only, each claimed once, and stays bounded", async () => {
  const subject = new RedirectTracker({ initiator: EXTENSION_ORIGIN, waitMs: 0, maxEntries: 3 });
  subject.record({ url: "https://a.tiktok.com/1", redirectUrl: "https://b.tiktok.com/1", initiator: "https://www.tiktok.com" });
  subject.record({ url: "https://a.tiktok.com/2", redirectUrl: "https://b.tiktok.com/2" }); // no initiator
  assert.equal(await subject.take("https://a.tiktok.com/1"), null); // TikTok's page's redirect: not ours
  assert.equal(await subject.take("https://a.tiktok.com/2"), null);
  subject.record({ url: "https://a.tiktok.com/3", redirectUrl: "https://b.tiktok.com/3", initiator: EXTENSION_ORIGIN });
  assert.equal(await subject.take("https://a.tiktok.com/3"), "https://b.tiktok.com/3");
  assert.equal(await subject.take("https://a.tiktok.com/3"), null); // claimed: asked once
  for (let n = 0; n < 10; n += 1) {
    subject.record({ url: `https://a.tiktok.com/x${n}`, redirectUrl: `https://b.tiktok.com/x${n}`, initiator: EXTENSION_ORIGIN });
  }
  assert.equal(subject.targets.size, 3); // never grows without bound: the oldest went first
  assert.equal(await subject.take("https://a.tiktok.com/x6"), null);
  assert.equal(await subject.take("https://a.tiktok.com/x9"), "https://b.tiktok.com/x9");
  // a request about to go out forgets what an earlier request of the same URL was told
  subject.expect("https://a.tiktok.com/x8");
  assert.equal(await subject.take("https://a.tiktok.com/x8"), null);
  assert.equal(new RedirectTracker({ initiator: EXTENSION_ORIGIN }).maxEntries, MAX_TRACKED_REDIRECTS);
});

test("a lookup waits for an event that has not arrived yet, and gives up after its wait", async () => {
  const subject = new RedirectTracker({ initiator: EXTENSION_ORIGIN, waitMs: 1000 });
  const started = Date.now();
  const pending = subject.take("https://a.tiktok.com/late");
  setTimeout(() => subject.record({ url: "https://a.tiktok.com/late", redirectUrl: "https://b.tiktok.com/late", initiator: EXTENSION_ORIGIN }), 0);
  assert.equal(await pending, "https://b.tiktok.com/late");
  assert.ok(Date.now() - started < 900, "the event ends the wait at once");
  assert.equal(subject.waiting.size, 0);
  assert.equal(await subject.take("https://a.tiktok.com/never", 5), null);
  assert.equal(subject.waiting.size, 0);
});

test("the page's tracker listens to onBeforeRedirect for the manifest's hosts in its own tab only, observing", () => {
  /** @type {unknown[][]} */
  const listeners = [];
  const fake = fakeChrome({
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      getURL: (/** @type {string} */ path) => `${EXTENSION_ORIGIN}/${path}`,
      getManifest: () => ({ host_permissions: HOSTS }),
    },
    webRequest: {
      onBeforeRedirect: { addListener: (/** @type {unknown[]} */ ...args) => void listeners.push(args) },
    },
  });
  try {
    assert.equal(pageRedirects(), null); // until the page knows its tab: no redirect followed
    assert.equal(initPageRedirects(undefined), null); // a tab it cannot name: no listener at all
    assert.equal(listeners.length, 0);
    const page = initPageRedirects(7);
    assert.ok(page !== null);
    assert.equal(pageRedirects(), page);
    assert.equal(initPageRedirects(7), page); // one per page
    assert.equal(listeners.length, 1);
    const [listener, filter, ...rest] = /** @type {unknown[]} */ (listeners[0]);
    // the DramaFetch tab only: Chrome never hands it a redirect of the user's TikTok tabs
    assert.deepEqual(filter, { urls: HOSTS, types: ["xmlhttprequest", "other"], tabId: 7 });
    assert.deepEqual(rest, []); // no "blocking", no "extraHeaders": observation only
    assert.equal(listener, page.listener);
    assert.equal(page.initiator, EXTENSION_ORIGIN);
  } finally {
    fake.restore();
  }
});

test("a late event of an earlier request of a URL never answers a later request of it", async () => {
  let clock = 1_000_000;
  const subject = new RedirectTracker({ initiator: EXTENSION_ORIGIN, waitMs: 50, now: () => clock });
  const url = "https://v16.tiktok.com/a.mp4";
  // request 1 redirects to b at 1_000_010; its event comes later than its lookup waited
  subject.expect(url);
  clock += 10;
  const first = subject.take(url);
  clock += 60;
  assert.equal(await first, null); // given up on: refused, the next candidate
  // request 2 of the same URL goes out; request 1's event arrives during its wait
  subject.expect(url);
  const second = subject.take(url);
  subject.record({ url, redirectUrl: "https://v19.tiktokcdn.com/b.mp4", initiator: EXTENSION_ORIGIN, timeStamp: 1_000_010 });
  clock += 20;
  subject.record({ url, redirectUrl: "https://v19.tiktokcdn.com/d.mp4", initiator: EXTENSION_ORIGIN, timeStamp: clock });
  assert.equal(await second, "https://v19.tiktokcdn.com/d.mp4"); // its own redirect, not request 1's
  assert.equal(subject.targets.size, 0); // nothing stale left behind
  // a late event of request 2, after request 3 went out, is dropped too; request 3's own counts
  clock += 1_000;
  subject.expect(url);
  subject.record({ url, redirectUrl: "https://v19.tiktokcdn.com/d.mp4", initiator: EXTENSION_ORIGIN, timeStamp: clock - 1_000 });
  assert.equal(subject.targets.size, 0);
  subject.record({ url, redirectUrl: "https://v19.tiktokcdn.com/e.mp4", initiator: EXTENSION_ORIGIN, timeStamp: clock - 5 });
  assert.equal(await subject.take(url), "https://v19.tiktokcdn.com/e.mp4"); // within the clocks' slack
  // an event without a time stamp is not judged; the requests' stamps stay bounded
  subject.expect(url);
  subject.record({ url, redirectUrl: "https://v19.tiktokcdn.com/f.mp4", initiator: EXTENSION_ORIGIN });
  assert.equal(await subject.take(url), "https://v19.tiktokcdn.com/f.mp4");
  for (let n = 0; n < 100; n += 1) subject.expect(`${url}?n=${n}`);
  assert.equal(subject.expectedAt.size, MAX_TRACKED_REDIRECTS);
});

// ---------------------------------------------------------------------- following redirects

test("a redirect to a covered host is followed hop by hop, each requested the same way", async () => {
  const redirects = tracker();
  const net = network(
    {
      "https://v1.tiktok.com/a.mp4?expire=99999999999&sig=s1": { to: "https://v2.tiktokcdn.com/b.mp4?sig=s2" },
      "https://v2.tiktokcdn.com/b.mp4?sig=s2": { to: "https://v3.tiktokcdn.com/c.mp4?sig=s3", late: true },
      "https://v3.tiktokcdn.com/c.mp4?sig=s3": videoResponse,
      "https://p16-sign-sg.tiktokcdn.com/c/1.jpeg": { to: "https://p19.tiktokcdn.com/c/1.jpeg" },
      "https://p19.tiktokcdn.com/c/1.jpeg": coverResponse,
    },
    redirects,
  );
  const { subject, saved } = downloader({ fetch: net.fetchFn, redirects });
  const result = await subject.download(episode(1, ["https://v1.tiktok.com/a.mp4?expire=99999999999&sig=s1"]), CONTEXT);
  assert.equal(result.status, "done");
  assert.equal(result.message, "saved Test Series - Episode 01.mp4 (0.1 MiB) + cover embedded");
  assert.deepEqual(net.log, [
    "https://v1.tiktok.com/a.mp4?expire=99999999999&sig=s1",
    "https://v2.tiktokcdn.com/b.mp4?sig=s2",
    "https://v3.tiktokcdn.com/c.mp4?sig=s3",
    "https://p16-sign-sg.tiktokcdn.com/c/1.jpeg",
    "https://p19.tiktokcdn.com/c/1.jpeg",
  ]);
  const media = { credentials: "include", cache: "no-store", redirect: "manual", headers: { Accept: "*/*" } };
  assert.deepEqual(net.inits.slice(0, 3), [media, media, media]);
  const image = { credentials: "include", cache: "no-store", redirect: "manual", headers: { Accept: "image/*,*/*" } };
  assert.deepEqual(net.inits.slice(3), [image, image]);
  assert.equal(saved.length, 1);
  assert.equal(subject.refreshes, 0);
  assert.equal(redirects.targets.size, 0); // every redirect claimed
});

test("the budget counts requested URLs, not the hops of their redirects", async () => {
  const redirects = tracker();
  /** @type {Record<string, Route>} */
  const routes = {};
  const urls = [1, 2, 3, 4, 5].map((n) => `https://v${n}.tiktok.com/v.mp4`);
  for (const [index, url] of urls.entries()) {
    routes[url] = { to: `https://hop${index + 1}.tiktokcdn.com/v.mp4` };
    routes[`https://hop${index + 1}.tiktokcdn.com/v.mp4`] = denied;
  }
  const net = network(routes, redirects);
  const { subject } = downloader({ fetch: net.fetchFn, redirects });
  const result = await subject.download(episode(1, urls), CONTEXT);
  assert.equal(result.status, "failed-unavailable");
  assert.equal(result.message, `${UNAVAILABLE_MESSAGE} (HTTP 403 from v4.tiktok.com)`);
  assert.equal(net.log.length, 8); // four URLs requested, each with its hop; the fifth never
  assert.ok(!net.log.includes(urls[4]));
  assert.equal(subject.refreshes, 0); // the budget is spent: no fresh list either
});

test("a redirect is refused — the next URL — when its target is unknown, uncovered or a downgrade", async () => {
  const redirects = tracker();
  const good = "https://v9.tiktok.com/good.mp4";
  /**
   * @param {Record<string, Route>} routes
   * @param {string} first
   */
  const refusal = async (routes, first) => {
    const net = network({ ...routes, [good]: videoResponse }, redirects);
    const { subject } = downloader({ fetch: net.fetchFn, redirects, thumbnail: "none" });
    const result = await subject.download(episode(1, [first, good]), CONTEXT);
    assert.equal(result.status, "done"); // the next candidate came through
    return net.log;
  };
  /**
   * The reason of a refused redirect: the only candidate refused, `failed-unavailable`.
   * @param {Record<string, Route>} routes
   * @param {string} first
   */
  const reasonOf = async (routes, first) => {
    const net = network(routes, redirects);
    const { subject } = downloader({ fetch: net.fetchFn, redirects, thumbnail: "none", rediscover: async () => series([]) });
    const result = await subject.download(episode(1, [first]), CONTEXT);
    assert.equal(result.status, "failed-unavailable");
    return { message: result.message, log: net.log };
  };
  const unknown = { "https://v1.tiktok.com/a.mp4": { to: "https://v2.tiktok.com/b.mp4", silent: true } };
  assert.deepEqual(await refusal(unknown, "https://v1.tiktok.com/a.mp4"), ["https://v1.tiktok.com/a.mp4", good]);
  assert.equal((await reasonOf(unknown, "https://v1.tiktok.com/a.mp4")).message, `${UNAVAILABLE_MESSAGE} (a redirect from v1.tiktok.com, not followed)`);

  const uncovered = { "https://v1.tiktok.com/a.mp4": { to: "https://evil.example.com/b.mp4?token=secret" } };
  assert.deepEqual(await refusal(uncovered, "https://v1.tiktok.com/a.mp4"), ["https://v1.tiktok.com/a.mp4", good]);
  const away = await reasonOf(uncovered, "https://v1.tiktok.com/a.mp4");
  assert.equal(away.message, `${UNAVAILABLE_MESSAGE} (a redirect from v1.tiktok.com, not followed)`);
  assert.ok(!away.log.some((url) => url.includes("example.com")));

  const downgrade = { "https://v1.tiktok.com/a.mp4": { to: "http://v2.tiktok.com/b.mp4?sig=secret" } };
  assert.deepEqual(await refusal(downgrade, "https://v1.tiktok.com/a.mp4"), ["https://v1.tiktok.com/a.mp4", good]);
  const down = await reasonOf(downgrade, "https://v1.tiktok.com/a.mp4");
  assert.equal(down.message, `${UNAVAILABLE_MESSAGE} (a redirect from v1.tiktok.com down to http on v2.tiktok.com, not followed)`);
  assert.deepEqual(down.log, ["https://v1.tiktok.com/a.mp4"]);
  // no message names a path or a query: the hosts only
  for (const message of [away.message, down.message]) assert.ok(!/secret|sig=|token|\.mp4/.test(message), message);

  // without a tracker (where chrome.webRequest does not exist) no redirect is ever followed
  const blind = network({ "https://v1.tiktok.com/a.mp4": { to: "https://v2.tiktok.com/b.mp4" }, "https://v2.tiktok.com/b.mp4": videoResponse }, null);
  const { subject } = downloader({ fetch: blind.fetchFn, redirects: null, rediscover: async () => series([]) });
  const result = await subject.download(episode(2, ["https://v1.tiktok.com/a.mp4"]), CONTEXT);
  assert.equal(result.message, `${UNAVAILABLE_MESSAGE} (a redirect from v1.tiktok.com, not followed)`);
  assert.deepEqual(blind.log, ["https://v1.tiktok.com/a.mp4"]);
});

test("five redirects are followed, a sixth is refused", async () => {
  const redirects = tracker();
  /** @param {number} hops @returns {Record<string, Route>} */
  const chain = (hops) => {
    /** @type {Record<string, Route>} */
    const routes = {};
    for (let n = 0; n < hops; n += 1) routes[`https://h${n}.tiktokcdn.com/v.mp4`] = { to: `https://h${n + 1}.tiktokcdn.com/v.mp4` };
    routes[`https://h${hops}.tiktokcdn.com/v.mp4`] = videoResponse;
    return routes;
  };
  const five = network(chain(MAX_REDIRECTS), redirects);
  const followed = await fetchFollowing("https://h0.tiktokcdn.com/v.mp4", {
    fetch: five.fetchFn,
    init: { redirect: "manual" },
    redirects,
    allowed: (url) => redirectTargetAllowed(url, HOSTS, TIKTOK_BASE_URL),
  });
  assert.equal(followed.hops, 5);
  assert.equal(followed.url, "https://h5.tiktokcdn.com/v.mp4");
  assert.equal(five.log.length, 6);

  const six = network(chain(MAX_REDIRECTS + 1), redirects);
  await assert.rejects(
    fetchFollowing("https://h0.tiktokcdn.com/v.mp4", {
      fetch: six.fetchFn,
      init: { redirect: "manual" },
      redirects,
      allowed: (url) => redirectTargetAllowed(url, HOSTS, TIKTOK_BASE_URL),
    }),
    (error) => error instanceof RedirectRefused && error.message === "more than 5 redirects from h0.tiktokcdn.com, not followed",
  );
  assert.equal(six.log.length, 6); // the sixth target is never requested
  assert.equal(redirects.targets.size, 0); // its event was claimed all the same
});

test("a redirect loop, a sixth hop or a request that throws fails the episode at once: no next URL, no fresh list", async () => {
  const redirects = tracker();
  const good = "https://v9.tiktok.com/good.mp4";
  const hops = (/** @type {number} */ n) => `https://h${n}.tiktokcdn.com/v.mp4`;
  /** @type {Record<string, Route>} */
  const routes = {
    // a loop: A -> B -> A
    "https://v1.tiktok.com/a.mp4": { to: "https://v2.tiktok.com/b.mp4" },
    "https://v2.tiktok.com/b.mp4": { to: "https://v1.tiktok.com/a.mp4" },
    [good]: videoResponse,
    // "https://v3.tiktok.com/gone.mp4" has no route: the request throws ("Failed to fetch")
  };
  for (let n = 0; n <= MAX_REDIRECTS; n += 1) routes[hops(n)] = { to: hops(n + 1) }; // six hops and more
  const net = network(routes, redirects);
  let listings = 0;
  const { subject, saved } = downloader({
    fetch: net.fetchFn,
    redirects,
    thumbnail: "none",
    // a fresh list repeating the same signed URLs (they stay the same until they expire)
    rediscover: async () => {
      listings += 1;
      return series([episode(1, ["https://v1.tiktok.com/a.mp4", good])]);
    },
  });
  // Python: Playwright's request raises ("Max redirect count exceeded", a network error) and
  // `_try_candidates` re-raises it: FAILED, no next mirror, no `_refresh`
  const looped = await subject.download(episode(1, ["https://v1.tiktok.com/a.mp4", good]), CONTEXT);
  assert.equal(looped.status, "failed");
  assert.equal(looped.message, "download failed: a redirect loop at v2.tiktok.com, not followed");
  assert.deepEqual(net.log, ["https://v1.tiktok.com/a.mp4", "https://v2.tiktok.com/b.mp4"]); // never the good one

  net.log.length = 0;
  const chained = await subject.download(episode(2, [hops(0), good]), CONTEXT);
  assert.equal(chained.status, "failed");
  assert.equal(chained.message, "download failed: more than 5 redirects from h0.tiktokcdn.com, not followed");
  assert.deepEqual(net.log, [0, 1, 2, 3, 4, 5].map(hops)); // the sixth target never, nor the next URL

  net.log.length = 0;
  const thrown = await subject.download(episode(3, ["https://v3.tiktok.com/gone.mp4", good]), CONTEXT);
  assert.equal(thrown.status, "failed");
  assert.equal(thrown.message, "download failed: no response (Failed to fetch) from v3.tiktok.com");
  assert.deepEqual(net.log, ["https://v3.tiktok.com/gone.mp4"]);

  assert.equal(listings, 0); // the series was never listed again
  assert.equal(subject.refreshes, 0);
  assert.deepEqual(saved, []);
  // the refusals say why, so the downloader can tell them from a target it may not request
  await assert.rejects(
    fetchFollowing("https://v1.tiktok.com/a.mp4", { fetch: net.fetchFn, init: { redirect: "manual" }, redirects, allowed: () => true }),
    (error) => error instanceof RedirectRefused && error.kind === "loop",
  );
  await assert.rejects(
    fetchFollowing(hops(0), { fetch: net.fetchFn, init: { redirect: "manual" }, redirects, allowed: () => true }),
    (error) => error instanceof RedirectRefused && error.kind === "limit",
  );
  await assert.rejects(
    fetchFollowing("https://v1.tiktok.com/a.mp4", { fetch: net.fetchFn, init: { redirect: "manual" }, redirects, allowed: () => false }),
    (error) => error instanceof RedirectRefused && error.kind === "target",
  );
});

test("in test mode a redirect is followed on the test origin only", async () => {
  const redirects = tracker();
  const base = "http://127.0.0.1:4321";
  const hosts = [...HOSTS, "http://127.0.0.1/*"];
  const net = network(
    {
      [`${base}/cdn/1/0.mp4`]: { to: `${base}/hop/1/cdn/1/0.mp4` },
      [`${base}/hop/1/cdn/1/0.mp4`]: videoResponse,
      [`${base}/cdn/2/0.mp4`]: { to: "http://127.0.0.1:9999/cdn/2/0.mp4" },
      "http://127.0.0.1:9999/cdn/2/0.mp4": videoResponse,
    },
    redirects,
  );
  const { subject } = downloader({ fetch: net.fetchFn, redirects, baseUrl: base, hostPatterns: hosts, thumbnail: "none", rediscover: async () => series([]) });
  assert.equal((await subject.download(episode(1, [`${base}/cdn/1/0.mp4`]), CONTEXT)).status, "done");
  const other = await subject.download(episode(2, [`${base}/cdn/2/0.mp4`]), CONTEXT);
  assert.equal(other.message, `${UNAVAILABLE_MESSAGE} (a redirect from 127.0.0.1, not followed)`);
  assert.ok(!net.log.includes("http://127.0.0.1:9999/cdn/2/0.mp4"));
});

test("a cover and a thumbnail follow a covered redirect, and only a covered one", async () => {
  const redirects = tracker();
  const net = network(
    {
      "https://p16.tiktokcdn.com/c/1.jpeg": { to: "https://p19.tiktokcdn.com/c/1.jpeg" },
      "https://p19.tiktokcdn.com/c/1.jpeg": coverResponse,
      "https://p16.tiktokcdn.com/c/2.jpeg": { to: "https://images.example.com/c/2.jpeg" },
      "https://images.example.com/c/2.jpeg": coverResponse,
    },
    redirects,
  );
  const fetched = await fetchImage("https://p16.tiktokcdn.com/c/1.jpeg", { fetch: net.fetchFn, hostPatterns: HOSTS, redirects });
  assert.equal(fetched.ok, true);
  const refused = await fetchImage("https://p16.tiktokcdn.com/c/2.jpeg", { fetch: net.fetchFn, hostPatterns: HOSTS, redirects });
  assert.deepEqual(refused, { ok: false, note: "; cover: a redirect from p16.tiktokcdn.com, not followed" });
  assert.ok(!net.log.includes("https://images.example.com/c/2.jpeg"));
  // the downloader's cover: a refused redirect only becomes the note, the video is saved
  const media = network(
    {
      "https://v1.tiktok.com/a.mp4": videoResponse,
      "https://p16-sign-sg.tiktokcdn.com/c/3.jpeg": { to: "http://p16-sign-sg.tiktokcdn.com/c/3.jpeg" },
    },
    redirects,
  );
  const { subject, saved } = downloader({ fetch: media.fetchFn, redirects });
  const result = await subject.download(episode(3, ["https://v1.tiktok.com/a.mp4"]), CONTEXT);
  assert.equal(result.status, "done");
  assert.equal(
    result.message,
    "saved Test Series - Episode 03.mp4 (0.1 MiB); cover: a redirect from p16-sign-sg.tiktokcdn.com down to http on p16-sign-sg.tiktokcdn.com, not followed",
  );
  assert.equal(saved.length, 1);
});

// ------------------------------------------------------------ re-discovery (Python parity)

/**
 * A fake re-discovery: each call lists the series again with the next entry of `lists` (item
 * number → its play URLs; a number missing from the map is missing from the list).
 * @param {Map<number, string[]>[]} lists
 */
function relister(lists) {
  let calls = 0;
  const rediscover = async () => {
    const list = lists[calls];
    calls += 1;
    if (list === undefined) throw new Error("no further re-discovery expected");
    return series([...list.entries()].map(([number, urls]) => episode(number, urls)));
  };
  return { rediscover, calls: () => calls };
}

test("a long run whose fresh list expires lists the series again for a later episode", async () => {
  let clock = 2_000_000_000;
  const expired = (/** @type {number} */ n) => `https://v16.tiktok.com/old/${n}.mp4?expire=${clock - 100}`;
  const fresh = (/** @type {string} */ tag, /** @type {number} */ n, /** @type {number} */ expire) =>
    `https://v16.tiktok.com/${tag}/${n}.mp4?expire=${expire}`;
  const firstList = new Map([
    [1, [fresh("a", 1, clock + 600)]],
    [2, [fresh("a", 2, clock + 600)]],
  ]);
  const secondList = new Map([
    [1, [fresh("b", 1, clock + 7200)]],
    [2, [fresh("b", 2, clock + 7200)]],
  ]);
  const lister = relister([firstList, secondList]);
  /** @type {string[]} */
  const log = [];
  const fetchFn = /** @type {typeof fetch} */ (
    async (input) => {
      log.push(String(input));
      return videoResponse();
    }
  );
  const { subject } = downloader({ fetch: fetchFn, redirects: null, rediscover: lister.rediscover, now: () => clock, thumbnail: "none" });
  const first = await subject.download(episode(1, [expired(1)]), CONTEXT);
  assert.equal(first.status, "done");
  assert.equal(lister.calls(), 1);
  clock += 1_000; // the first fresh list has expired meanwhile
  const second = await subject.download(episode(2, [expired(2)]), CONTEXT);
  assert.equal(second.status, "done");
  assert.equal(lister.calls(), 2);
  assert.equal(subject.refreshes, 2);
  assert.deepEqual(log, [fresh("a", 1, 2_000_000_600), fresh("b", 2, 2_000_007_200)]); // no expired URL requested
});

test("an entry without play URLs, or an episode the fresh list lacks, never costs a re-discovery", async () => {
  const clock = 2_000_000_000;
  const expired = (/** @type {number} */ n) => `https://v16.tiktok.com/old/${n}.mp4?expire=${clock - 100}`;
  const lister = relister([
    new Map([
      [1, [`https://v16.tiktok.com/a/1.mp4?expire=${clock + 600}`]],
      [2, []], // listed without a play URL
      // 3: not in the fresh list at all
    ]),
  ]);
  const fetchFn = /** @type {typeof fetch} */ (async () => videoResponse());
  const { subject } = downloader({ fetch: fetchFn, redirects: null, rediscover: lister.rediscover, now: () => clock, thumbnail: "none" });
  assert.equal((await subject.download(episode(1, [expired(1)]), CONTEXT)).status, "done");
  const locked = await subject.download(episode(2, [expired(2)]), CONTEXT);
  assert.equal(locked.status, "failed-unavailable");
  assert.equal(locked.message, `${UNAVAILABLE_MESSAGE} (locked in a fresh episode list: no play address)`);
  const missing = await subject.download(episode(3, [expired(3)]), CONTEXT);
  assert.equal(missing.message, `${UNAVAILABLE_MESSAGE} (no play url, even in a fresh episode list)`);
  assert.equal(lister.calls(), 1);
  assert.equal(subject.refreshes, 1);
});

test("a fresh entry whose every URL this episode tried calls for a newer list", async () => {
  const lister = relister([
    new Map([[1, ["https://v1.tiktok.com/1.mp4"]], [2, ["https://v1.tiktok.com/2.mp4"]]]), // the same URLs again
    new Map([[2, ["https://v2.tiktok.com/2-new.mp4"]]]),
  ]);
  /** @type {string[]} */
  const log = [];
  const fetchFn = /** @type {typeof fetch} */ (
    async (input) => {
      log.push(String(input));
      return String(input).includes("-new") ? videoResponse() : denied();
    }
  );
  const { subject } = downloader({ fetch: fetchFn, redirects: null, rediscover: lister.rediscover, thumbnail: "none" });
  const first = await subject.download(episode(1, ["https://v1.tiktok.com/1.mp4"]), CONTEXT);
  assert.equal(first.message, `${UNAVAILABLE_MESSAGE} (HTTP 403 from v1.tiktok.com)`);
  assert.equal(lister.calls(), 1);
  const second = await subject.download(episode(2, ["https://v1.tiktok.com/2.mp4"]), CONTEXT);
  assert.equal(second.status, "done");
  assert.equal(lister.calls(), 2); // its entry in the first fresh list named only what it had tried
  assert.deepEqual(log, ["https://v1.tiktok.com/1.mp4", "https://v1.tiktok.com/2.mp4", "https://v2.tiktok.com/2-new.mp4"]);
});

test("a re-discovery that failed is not tried again for that series in the run", async () => {
  const clock = 2_000_000_000;
  const expired = (/** @type {number} */ n) => `https://v16.tiktok.com/old/${n}.mp4?expire=${clock - 100}`;
  let calls = 0;
  const rediscover = async () => {
    calls += 1;
    throw new DiscoveryError("no episode list within 45 s (page: https://www.tiktok.com/shortdrama/episode/1/1)");
  };
  /** @type {string[]} */
  const log = [];
  const fetchFn = /** @type {typeof fetch} */ (
    async (input) => {
      log.push(String(input));
      return denied();
    }
  );
  const { subject } = downloader({ fetch: fetchFn, redirects: null, rediscover, now: () => clock, thumbnail: "none" });
  const first = await subject.download(episode(1, [expired(1)]), CONTEXT);
  assert.equal(first.status, "failed");
  assert.match(first.message, /^no episode list within 45 s/);
  const second = await subject.download(episode(2, [expired(2)]), CONTEXT);
  assert.equal(second.message, `${UNAVAILABLE_MESSAGE} (no play url, even in a fresh episode list)`);
  const third = await subject.download(episode(3, ["https://v1.tiktok.com/3.mp4"]), CONTEXT);
  assert.equal(third.message, `${UNAVAILABLE_MESSAGE} (HTTP 403 from v1.tiktok.com)`);
  assert.equal(calls, 1);
  assert.equal(subject.refreshes, 1);
  assert.deepEqual(log, ["https://v1.tiktok.com/3.mp4"]);
});

test("URLs on hosts the manifest does not cover count in the budget, never requested: Python's fresh-list condition", async () => {
  const covered = "https://v16-webapp-prime.tiktok.com/v/1.mp4";
  const elsewhere = [1, 2, 3].map((n) => `https://v${n}.newcdn.example/v/1.mp4`);
  /** @type {string[]} */
  const log = [];
  const fetchFn = /** @type {typeof fetch} */ (
    async (input) => {
      log.push(String(input));
      return denied();
    }
  );
  const lister = relister([new Map([[1, ["https://v16-webapp-prime.tiktok.com/v/fresh.mp4"]]])]);
  const { subject } = downloader({ fetch: fetchFn, redirects: null, rediscover: lister.rediscover, thumbnail: "none" });
  // Python requests all four, its budget is then spent and it lists nothing again
  const result = await subject.download(episode(1, [covered, ...elsewhere]), CONTEXT);
  assert.equal(result.status, "failed-unavailable");
  assert.equal(result.message, `${UNAVAILABLE_MESSAGE} (v3.newcdn.example is not a host this extension may contact)`);
  assert.deepEqual(log, [covered]);
  assert.equal(lister.calls(), 0);
  // the other way round: three such URLs first leave room for one TikTok GET, as in Python
  log.length = 0;
  const second = await subject.download(episode(2, [...elsewhere, covered, "https://v19.tiktok.com/v/1.mp4"]), CONTEXT);
  assert.equal(second.message, `${UNAVAILABLE_MESSAGE} (HTTP 403 from v16-webapp-prime.tiktok.com)`);
  assert.deepEqual(log, [covered]);
  assert.equal(lister.calls(), 0);
});

test("cacheSpent: tried or expired, all of them; never for an entry without URLs or none at all", () => {
  let now = 1_000;
  const { subject } = downloader({ fetch: /** @type {typeof fetch} */ (async () => denied()), redirects: null, now: () => now });
  const item = { video: { playAddr: ["https://v1.tiktok.com/a.mp4?expire=2000", "https://v1.tiktok.com/b.mp4"] } };
  assert.equal(subject.cacheSpent(null, new Set()), false);
  assert.equal(subject.cacheSpent({ video: { playAddr: "" } }, new Set()), false);
  assert.equal(subject.cacheSpent(item, new Set()), false);
  assert.equal(subject.cacheSpent(item, new Set(["https://v1.tiktok.com/b.mp4"])), false);
  assert.equal(subject.cacheSpent(item, new Set(["https://v1.tiktok.com/a.mp4?expire=2000", "https://v1.tiktok.com/b.mp4"])), true);
  now = 1_950; // a.mp4 expires within the 60 s margin: spent once b.mp4 was tried
  assert.equal(subject.cacheSpent(item, new Set(["https://v1.tiktok.com/b.mp4"])), true);
});
