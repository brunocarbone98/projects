// @ts-check
// app/resolver.js over a fake network (the real lib parsers, a scripted `fetch`): every request
// one at a time with the session's cookies, paced, recorded; the sites' answers mapped to targets or
// failures; a refusal (429 / 412 / 403 on a document) a stop; nothing requested outside the
// manifest's hosts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { StopRequested } from "../src/app/downloader.js";
import {
  PRODUCTION_BASES,
  basesFor,
  bilibilitvPage,
  isResolveFailure,
  onBase,
  refreshStreams,
  resolve,
  selectStream,
} from "../src/app/resolver.js";
import { isRefused, parseLine } from "../src/lib/urls.js";

/** @type {string[]} */
const HOSTS = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"))
  .host_permissions;

/**
 * @typedef {import("../src/app/resolver.js").ResolveItem} ResolveItem
 * @typedef {import("../src/app/resolver.js").Target} Target
 * @typedef {{ status?: number, body?: string, headers?: Record<string, string>, url?: string }} Reply
 * @typedef {Reply | ((url: string, init: RequestInit | undefined) => Reply)} Route
 */

/**
 * A scripted network: `routes` by URL (exact, or the URL without its query), each a reply or a
 * function of the request; every request recorded with its init.
 * @param {Record<string, Route>} routes
 */
function network(routes) {
  /** @type {{ url: string, init: RequestInit | undefined }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fakeFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url] ?? routes[url.split("?")[0] ?? url];
    if (route === undefined) return new Response("not found", { status: 404 });
    const reply = typeof route === "function" ? route(url, init) : route;
    const response = new Response(reply.body ?? "", {
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
    });
    Object.defineProperty(response, "url", { value: reply.url ?? url });
    return response;
  };
  return { fetch: fakeFetch, calls };
}

/**
 * The resolver's context over a network; `pauses` counts the page pauses.
 * @param {typeof fetch} fakeFetch
 * @param {{ maxHeight?: number | null, codec?: "compatible" | "best", signal?: AbortSignal }} [options]
 */
function context(fakeFetch, options = {}) {
  const pauses = { count: 0 };
  /** @type {import("../src/app/resolver.js").ResolveContext} */
  const ctx = {
    net: {
      fetch: fakeFetch,
      hostPatterns: HOSTS,
      signal: options.signal ?? new AbortController().signal,
      stallMs: 2000,
      sleep: async () => undefined,
    },
    prefs: { maxHeight: options.maxHeight ?? null, codec: options.codec ?? "compatible" },
    bases: basesFor(undefined),
    pagePause: async () => {
      pauses.count += 1;
    },
  };
  return { ctx, pauses };
}

/**
 * @param {Partial<ResolveItem> & { site: ResolveItem["site"], id: string }} fields
 * @returns {ResolveItem}
 */
function item(fields) {
  return {
    key: `${fields.site}:${fields.id}`,
    kind: "video",
    part: null,
    shortLink: null,
    pageUrl: "https://example.invalid/",
    original: `https://example.invalid/${fields.id}`,
    ...fields,
  };
}

/**
 * @param {Target[] | import("../src/app/resolver.js").ResolveFailure} resolved
 * @returns {Target[]}
 */
function targetsOf(resolved) {
  assert.ok(!isResolveFailure(resolved), `resolved to a failure: ${JSON.stringify(resolved)}`);
  return /** @type {Target[]} */ (resolved);
}

/**
 * @param {Target[] | import("../src/app/resolver.js").ResolveFailure} resolved
 * @returns {import("../src/app/resolver.js").ResolveFailure}
 */
function failureOf(resolved) {
  assert.ok(isResolveFailure(resolved), "a failure was expected");
  return /** @type {import("../src/app/resolver.js").ResolveFailure} */ (resolved);
}

// ------------------------------------------------------------------------- Dailymotion

const DM_ID = "xbq9z2k";
const METADATA = `https://www.dailymotion.com/player/metadata/video/${DM_ID}?app=com.dailymotion.neon`;
const MASTER = `https://www.dailymotion.com/cdn/manifest/video/${DM_ID}.m3u8?sec=abc`;
const CDN = `https://proxy-07.dailymotion.com/sec(abc)/video/${DM_ID}`;

/**
 * @param {Record<string, unknown>} [extra]
 * @returns {string}
 */
function metadata(extra = {}) {
  return JSON.stringify({
    id: DM_ID,
    title: "An invented video",
    duration: 6,
    owner: { id: "xowner1", screenname: "Someone" },
    posters: { 360: "https://s1.dmcdn.net/v/abc/x360", 720: "https://s2.dmcdn.net/v/abc/x720" },
    qualities: {
      auto: [
        { type: "application/x-mpegURL", url: MASTER },
        { type: "application/vnd.lumberjack.manifest", url: `${MASTER}.lumberjack` },
      ],
    },
    ...extra,
  });
}

const MASTER_TEXT = [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",NAME="360"',
  `${CDN}/360/media.m3u8`,
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="hvc1.1.6.L120.B0,mp4a.40.2",NAME="1080"',
  `${CDN}/1080-hevc/media.m3u8`,
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",NAME="1080"',
  `${CDN}/1080/media.m3u8`,
  "",
].join("\n");

/**
 * @param {string[]} [extraTags]
 * @param {boolean} [endList]
 */
function mediaText(extraTags = [], endList = true) {
  return [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:2",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    ...extraTags,
    "#EXTINF:2.0,",
    "seg000.ts?sec=abc",
    "#EXTINF:2.0,",
    "seg001.ts?sec=abc",
    "#EXTINF:2.0,",
    "seg002.ts?sec=abc",
    ...(endList ? ["#EXT-X-ENDLIST"] : []),
    "",
  ].join("\n");
}

test("Dailymotion: metadata, master, media playlist — paced, with cookies, recorded", async () => {
  const net = network({
    [METADATA]: { body: metadata(), headers: { "content-type": "application/json" } },
    [MASTER]: { body: MASTER_TEXT, headers: { "content-type": "application/vnd.apple.mpegurl" } },
    [`${CDN}/1080/media.m3u8`]: { body: mediaText() },
  });
  const { ctx, pauses } = context(net.fetch);
  const original = `https://www.dailymotion.com/video/${DM_ID}`;
  const [target] = targetsOf(await resolve(item({ site: "dailymotion", id: DM_ID, original }), ctx));
  assert.ok(target !== undefined);
  assert.deepEqual(
    net.calls.map((call) => call.url),
    [METADATA, MASTER, `${CDN}/1080/media.m3u8`],
  );
  assert.equal(pauses.count, 2, "a page pause before each request after the first");
  for (const call of net.calls) {
    assert.equal(call.init?.credentials, "include");
    assert.equal(call.init?.redirect, "follow");
    assert.equal(call.init?.method, "GET");
  }
  assert.equal(target.key, `dailymotion:${DM_ID}`);
  assert.equal(target.title, "An invented video");
  assert.equal(target.durationS, 6);
  assert.equal(target.cover, "https://s2.dmcdn.net/v/abc/x720");
  assert.equal(target.pageUrl, `https://www.dailymotion.com/video/${DM_ID}`);
  assert.equal(target.failure, null);
  assert.equal(target.input, original);
  const streams = target.streams;
  assert.ok(streams !== null && streams.kind === "hls");
  assert.equal(streams.variant.codecs, "avc1.640028,mp4a.40.2", "compatible: H.264 at the best height");
  assert.equal(streams.available.length, 3);
  assert.equal(streams.audio, null, "the audio is muxed");
  const raw = /** @type {import("../src/app/resolver.js").HlsRaw} */ (target.raw);
  assert.equal(raw.media?.segments.length, 3);
  assert.equal(raw.mediaUrl, `${CDN}/1080/media.m3u8`);
  assert.deepEqual(
    target.attempts.map((attempt) => [attempt.http_status, attempt.requested, attempt.outcome]),
    [
      [200, true, "ok"],
      [200, true, "ok"],
      [200, true, "ok"],
    ],
  );
  assert.equal(target.page?.url, METADATA);
  assert.deepEqual(target.hints, []);
});

test("Dailymotion: the quality cap and the codec preference choose the variant", async () => {
  const routes = {
    [METADATA]: { body: metadata() },
    [MASTER]: { body: MASTER_TEXT },
    [`${CDN}/360/media.m3u8`]: { body: mediaText() },
    [`${CDN}/1080-hevc/media.m3u8`]: { body: mediaText() },
    [`${CDN}/1080/media.m3u8`]: { body: mediaText() },
  };
  const capped = targetsOf(
    await resolve(item({ site: "dailymotion", id: DM_ID }), context(network(routes).fetch, { maxHeight: 720 }).ctx),
  );
  const cappedStreams = capped[0]?.streams;
  assert.ok(cappedStreams?.kind === "hls");
  assert.equal(cappedStreams.variant.name, "360");
});

test("Dailymotion: a playlist parameter is ignored and said so (the item's playlistIgnored)", async () => {
  const routes = {
    [METADATA]: { body: metadata() },
    [MASTER]: { body: MASTER_TEXT },
    [`${CDN}/1080/media.m3u8`]: { body: mediaText() },
  };
  /** @param {string} line */
  const pasted = (line) => {
    const parsed = parseLine(line);
    assert.ok(!isRefused(parsed), line);
    return /** @type {ResolveItem} */ (/** @type {unknown} */ (parsed));
  };
  const withPlaylist = pasted(`https://www.dailymotion.com/video/${DM_ID}?playlist=x6hynp`);
  assert.equal(withPlaylist.playlistIgnored, true);
  const [target] = targetsOf(await resolve(withPlaylist, context(network(routes).fetch).ctx));
  assert.deepEqual(target?.hints, [{ code: "playlist_ignored", params: {} }]);
  const plain = pasted(`https://www.dailymotion.com/video/${DM_ID}?autoplay=1`);
  const [other] = targetsOf(await resolve(plain, context(network(routes).fetch).ctx));
  assert.deepEqual(other?.hints, [], "no playlist named: no hint");
});

test("Dailymotion refusals: geo-blocked and gone are unavailable after one request", async () => {
  const geo = network({
    [METADATA]: { body: JSON.stringify({ error: { code: "DM007", title: "Not available in your country" } }) },
  });
  const blocked = failureOf(await resolve(item({ site: "dailymotion", id: DM_ID }), context(geo.fetch).ctx));
  assert.equal(blocked.status, "failed-unavailable");
  assert.equal(blocked.failure.code, "geo_blocked");
  assert.equal(blocked.failure.params["site_message"], "Not available in your country");
  assert.equal(geo.calls.length, 1, "no manifest, no media request");
  const gone = network({
    [METADATA]: { body: JSON.stringify({ error: { code: "DM002", title: "This video has been removed" } }) },
  });
  const removed = failureOf(await resolve(item({ site: "dailymotion", id: DM_ID }), context(gone.fetch).ctx));
  assert.equal(removed.status, "failed-unavailable");
  assert.equal(removed.failure.code, "deleted");
  assert.equal(removed.failure.params["site_message"], "Dailymotion says: This video has been removed");
  const junk = network({ [METADATA]: { body: "<html>verify you are human</html>", headers: { "content-type": "text/html" } } });
  const notJson = failureOf(await resolve(item({ site: "dailymotion", id: DM_ID }), context(junk.fetch).ctx));
  assert.equal(notJson.failure.code, "not_a_video");
  assert.equal(notJson.failure.params["content_type"], "text/html");
});

test("Dailymotion: 429 on the manifest is a rate limit, 403 on the metadata a block — no retry", async () => {
  const limited = network({ [METADATA]: { body: metadata() }, [MASTER]: { status: 429 } });
  const rate = failureOf(await resolve(item({ site: "dailymotion", id: DM_ID }), context(limited.fetch).ctx));
  assert.equal(rate.status, "failed-rate-limited");
  assert.equal(rate.failure.code, "rate_limited");
  assert.equal(rate.failure.params["detail"], "HTTP 429 (manifest)");
  assert.equal(limited.calls.length, 2, "never asked again");
  const forbidden = network({ [METADATA]: { status: 403 } });
  const block = failureOf(await resolve(item({ site: "dailymotion", id: DM_ID }), context(forbidden.fetch).ctx));
  assert.equal(block.status, "failed-blocked");
  assert.equal(block.failure.params["detail"], "HTTP 403 (metadata)");
  const precondition = network({ [METADATA]: { status: 412 } });
  assert.equal(failureOf(await resolve(item({ site: "dailymotion", id: DM_ID }), context(precondition.fetch).ctx)).status, "failed-rate-limited");
});

test("Dailymotion: a 5xx is retried with backoff, at most three times", async () => {
  let answers = 0;
  const net = network({
    [METADATA]: () => {
      answers += 1;
      return answers < 3 ? { status: 503 } : { body: metadata() };
    },
    [MASTER]: { body: MASTER_TEXT },
    [`${CDN}/1080/media.m3u8`]: { body: mediaText() },
  });
  const { ctx } = context(net.fetch);
  /** @type {number[]} */
  const slept = [];
  ctx.net.sleep = async (seconds) => void slept.push(seconds);
  const targets = targetsOf(await resolve(item({ site: "dailymotion", id: DM_ID }), ctx));
  assert.equal(targets.length, 1);
  assert.deepEqual(slept, [1, 2], "the 1-2-4 s backoff");
  assert.deepEqual(targets[0]?.attempts.map((attempt) => attempt.outcome).slice(0, 3), [
    "retry: HTTP 503",
    "retry: HTTP 503",
    "ok",
  ]);
  const down = network({ [METADATA]: { status: 500 } });
  const gaveUp = failureOf(await resolve(item({ site: "dailymotion", id: DM_ID }), context(down.fetch).ctx));
  assert.equal(down.calls.length, 4, "the first try and three retries");
  assert.equal(gaveUp.status, "failed");
  assert.equal(gaveUp.failure.code, "http_status");
});

test("Dailymotion: key-protected, live and spliced playlists are refused before any media request", async () => {
  for (const [tags, endList, code] of /** @type {const} */ ([
    [['#EXT-X-KEY:METHOD=AES-128,URI="https://x.dailymotion.com/key"'], true, "key_protected"],
    [[], false, "live_stream"],
    [["#EXT-X-DISCONTINUITY"], true, "discontinuous_stream"],
  ])) {
    const net = network({
      [METADATA]: { body: metadata() },
      [MASTER]: { body: MASTER_TEXT },
      [`${CDN}/1080/media.m3u8`]: { body: mediaText([...tags], endList) },
    });
    const [target] = targetsOf(await resolve(item({ site: "dailymotion", id: DM_ID }), context(net.fetch).ctx));
    assert.equal(target?.failure?.code, code);
    assert.equal(target?.status, "failed-unavailable");
    assert.equal(net.calls.length, 3, `${code}: the three documents, no segment`);
    if (code === "key_protected") assert.equal(target?.failure?.params["method"], "AES-128");
  }
});

test("a manifest on a host outside the manifest's permissions is never requested", async () => {
  const net = network({
    [METADATA]: {
      body: metadata({ qualities: { auto: [{ type: "application/x-mpegURL", url: "https://cdn.evil.example/m.m3u8" }] } }),
    },
  });
  const failed = failureOf(await resolve(item({ site: "dailymotion", id: DM_ID }), context(net.fetch).ctx));
  assert.equal(failed.failure.code, "host_not_covered");
  assert.equal(failed.failure.params["host"], "cdn.evil.example");
  assert.equal(net.calls.length, 1);
  assert.equal(failed.attempts.at(-1)?.requested, false);
});

test("Stop during a resolution is rethrown, never a failure of the item", async () => {
  const controller = new AbortController();
  const net = network({
    [METADATA]: () => {
      controller.abort(new StopRequested("user"));
      return { body: metadata() };
    },
    [MASTER]: { body: MASTER_TEXT },
  });
  const { ctx } = context(net.fetch, { signal: controller.signal });
  await assert.rejects(resolve(item({ site: "dailymotion", id: DM_ID }), ctx), StopRequested);
});

// ---------------------------------------------------------------------------- Bilibili

const BVID = "BV1Xx411c7mD";

/**
 * A Bilibili video page as the browser receives it.
 * @param {{ part?: number, pages?: number, state?: Record<string, unknown> | null, play?: Record<string, unknown> | null }} [options]
 * @returns {string}
 */
function biliPage(options = {}) {
  const count = options.pages ?? 2;
  const state =
    options.state === undefined
      ? {
          p: options.part ?? 1,
          videoData: {
            bvid: BVID,
            aid: 170001,
            title: "An invented anthology",
            pic: "https://i0.hdslb.com/bfs/archive/cover.jpg",
            duration: 12,
            pages: Array.from({ length: count }, (_value, index) => ({
              cid: 9000 + index,
              page: index + 1,
              part: `Part title ${index + 1}`,
              duration: 6,
            })),
            rights: { is_stein_gate: 0 },
          },
          upData: { name: "Uploader", mid: 42 },
        }
      : options.state;
  const cdn = `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/${options.part ?? 1}`;
  const play =
    options.play === undefined
      ? {
          code: 0,
          data: {
            timelength: 6000,
            accept_quality: [116, 80, 64],
            accept_description: ["高清 1080P60", "高清 1080P", "高清 720P"],
            support_formats: [
              { quality: 116, new_description: "1080P 高帧率" },
              { quality: 80, new_description: "1080P 高清" },
              { quality: 64, new_description: "720P 准高清" },
            ],
            dash: {
              video: [
                { id: 80, codecs: "hev1.1.6.L120.90", bandwidth: 900000, width: 1920, height: 1080, baseUrl: `${cdn}/80-hevc.m4s?deadline=1`, backupUrl: [] },
                { id: 80, codecs: "avc1.640032", bandwidth: 1500000, width: 1920, height: 1080, baseUrl: `${cdn}/80.m4s?deadline=1`, backupUrl: [`${cdn}/80b.m4s`] },
                { id: 64, codecs: "avc1.640028", bandwidth: 800000, width: 1280, height: 720, baseUrl: `${cdn}/64.m4s?deadline=1` },
              ],
              audio: [
                { id: 30280, codecs: "mp4a.40.2", bandwidth: 192000, baseUrl: `${cdn}/30280.m4s?deadline=1` },
                { id: 30216, codecs: "mp4a.40.2", bandwidth: 64000, baseUrl: `${cdn}/30216.m4s?deadline=1` },
              ],
            },
          },
        }
      : options.play;
  return [
    "<!DOCTYPE html><html><head><script>",
    state === null ? "" : `window.__INITIAL_STATE__=${JSON.stringify(state)};(function(){})();`,
    play === null ? "" : `window.__playinfo__=${JSON.stringify(play)}`,
    "</script></head><body></body></html>",
  ].join("\n");
}

test("Bilibili: every part of a bare link, one page per part, paced; streams and the premium hint", async () => {
  const page1 = `https://www.bilibili.com/video/${BVID}`;
  const page2 = `https://www.bilibili.com/video/${BVID}?p=2`;
  const net = network({ [page1]: { body: biliPage({ part: 1 }) }, [page2]: { body: biliPage({ part: 2 }) } });
  const { ctx, pauses } = context(net.fetch);
  const targets = targetsOf(
    await resolve(item({ site: "bilibili", id: BVID, key: `bilibili:${BVID}:all` }), ctx),
  );
  assert.deepEqual(net.calls.map((call) => call.url), [page1, page2]);
  assert.equal(pauses.count, 1);
  assert.deepEqual(targets.map((target) => target.key), [`bilibili:${BVID}:1`, `bilibili:${BVID}:2`]);
  assert.deepEqual(targets.map((target) => target.part), [1, 2]);
  assert.deepEqual(targets.map((target) => target.cid), ["9000", "9001"]);
  assert.deepEqual(targets.map((target) => target.partTitle), ["Part title 1", "Part title 2"]);
  assert.deepEqual(targets.map((target) => target.pageUrl), [`${page1}?p=1`, page2]);
  const first = /** @type {Target} */ (targets[0]);
  assert.equal(first.title, "An invented anthology");
  assert.equal(first.partCount, 2);
  assert.equal(first.durationS, 6);
  assert.equal(first.uploader, "Uploader");
  const streams = first.streams;
  assert.ok(streams?.kind === "dash");
  assert.equal(streams.video.codecs, "avc1.640032", "compatible: H.264 at 1080p");
  assert.deepEqual(streams.video.urls.length, 2, "the base URL then its backup");
  assert.equal(streams.audio?.id, 30280, "the highest-bandwidth AAC");
  assert.deepEqual(streams.missingPremium, ["1080P60"]);
  assert.deepEqual(first.hints, [{ code: "premium", params: { labels: ["1080P60"] } }]);
  assert.match(String(targets[1]?.streams?.kind === "dash" && targets[1].streams.video.urls[0]), /upgcxcode\/2\//);
});

test("Bilibili: ?p=2 selects that part only", async () => {
  const page2 = `https://www.bilibili.com/video/${BVID}?p=2`;
  const net = network({ [page2]: { body: biliPage({ part: 2 }) } });
  const targets = targetsOf(await resolve(item({ site: "bilibili", id: BVID, part: 2 }), context(net.fetch).ctx));
  assert.equal(net.calls.length, 1);
  assert.deepEqual(targets.map((target) => target.part), [2]);
});

test("Bilibili refusals: login wall, deleted, risk control, interactive, no DASH", async () => {
  const page = `https://www.bilibili.com/video/${BVID}`;
  const cases = /** @type {const} */ ([
    [{ state: { error: { trueCode: -403, message: "need login" } }, play: null }, "login_required", "failed-unavailable"],
    [{ state: { error: { trueCode: -404, message: "gone" } }, play: null }, "deleted", "failed-unavailable"],
    [{ state: null, play: null }, "not_a_video", "failed"],
    [{ play: { code: 0, data: { durl: [{ url: "https://x.bilivideo.com/a.flv" }] } } }, "legacy_stream", "failed-unavailable"],
  ]);
  for (const [options, code, status] of cases) {
    const net = network({ [page]: { body: biliPage({ pages: 1, ...options }) } });
    const failed = failureOf(await resolve(item({ site: "bilibili", id: BVID }), context(net.fetch).ctx));
    assert.equal(failed.failure.code, code);
    assert.equal(failed.status, status, code);
  }
  const risk = network({
    [page]: { body: '<html><script>window._riskdata_={"v_voucher":"voucher_x"}</script></html>' },
  });
  const limited = failureOf(await resolve(item({ site: "bilibili", id: BVID }), context(risk.fetch).ctx));
  assert.equal(limited.status, "failed-rate-limited");
  assert.equal(limited.failure.code, "rate_limited");
});

test("Bilibili: a 429 on a later part's page fails it and stops the parts after it", async () => {
  const page1 = `https://www.bilibili.com/video/${BVID}`;
  const page2 = `https://www.bilibili.com/video/${BVID}?p=2`;
  const net = network({ [page1]: { body: biliPage({ part: 1, pages: 3 }) }, [page2]: { status: 429 } });
  const targets = targetsOf(await resolve(item({ site: "bilibili", id: BVID }), context(net.fetch).ctx));
  assert.deepEqual(targets.map((target) => target.status), [null, "failed-rate-limited", "stopped"]);
  assert.equal(net.calls.length, 2, "part 3 is never asked for");
  assert.deepEqual(targets[2]?.failure, { code: "stopped", params: { reason: "rate_limited" } });
});

test("Bilibili: a b23.tv short link is followed to its video page and re-keyed", async () => {
  const short = "https://b23.tv/AbC123";
  const page = `https://www.bilibili.com/video/${BVID}?p=2&share_source=copy`;
  const net = network({ [short]: { body: biliPage({ part: 2 }), url: page } });
  const pasted = item({ site: "bilibili", id: "b23:AbC123", key: "bilibili:b23:AbC123:all", shortLink: short, pageUrl: short, original: short });
  const targets = targetsOf(await resolve(pasted, context(net.fetch).ctx));
  assert.equal(net.calls.length, 1, "the page the redirect ended on is the page");
  assert.deepEqual(targets.map((target) => target.key), [`bilibili:${BVID}:2`]);
  assert.equal(targets[0]?.itemKey, `bilibili:${BVID}:2`);
  assert.equal(targets[0]?.input, short);
  const elsewhere = network({ [short]: { body: "<html></html>", url: "https://www.bilibili.com/" } });
  const refused = failureOf(await resolve(pasted, context(elsewhere.fetch).ctx));
  assert.equal(refused.failure.code, "redirect_refused");
  assert.equal(refused.failure.params["host"], "www.bilibili.com");
  const away = network({ [short]: { body: "x", url: "https://phish.example/video/BV1Xx411c7mD" } });
  const off = failureOf(await resolve(pasted, context(away.fetch).ctx));
  assert.equal(off.failure.code, "redirect_refused");
  assert.equal(off.failure.params["host"], "phish.example");
});

// ------------------------------------------------------------------------- Bilibili.tv

const AID = "4801520000000001";
const API = "https://api.bilibili.tv/intl/gateway/web";
const BTV_CDN = "https://upos-bstar1-mirrorakam.akamaized.net/iupxcodeboss";

/**
 * A playurl answer.
 * @param {number} [code]
 * @param {number} [durationMs] the answer's `playurl.duration` (none when omitted)
 * @returns {string}
 */
function playurl(code = 0, durationMs) {
  if (code !== 0) return JSON.stringify({ code, message: `code ${code}` });
  return JSON.stringify({
    code: 0,
    message: "0",
    data: {
      playurl: {
        ...(durationMs === undefined ? {} : { duration: durationMs }),
        video: [
          { video_resource: { url: `${BTV_CDN}/1080.mp4?e=1`, codecs: "avc1.640032", width: 1920, height: 1080, bandwidth: 2000000, size: 1000 }, stream_info: { quality: 80, desc_words: "1080P" } },
          { video_resource: { url: `${BTV_CDN}/480.mp4?e=1`, codecs: "avc1.64001e", width: 852, height: 480, bandwidth: 500000, size: 400 }, stream_info: { quality: 32, desc_words: "480P" } },
          { video_resource: { url: "", codecs: "avc1.640033", width: 1920, height: 1080 }, stream_info: { quality: 112, desc_words: "1080P (HD+)" } },
        ],
        audio_resource: [
          { url: `${BTV_CDN}/audio-64.mp4?e=1`, codecs: "mp4a.40.2", bandwidth: 64000, quality: 30216 },
          { url: `${BTV_CDN}/audio-192.mp4?e=1`, codecs: "mp4a.40.2", bandwidth: 192000, quality: 30280 },
        ],
      },
    },
  });
}

/**
 * @param {string} title
 * @returns {string}
 */
function btvPage(title) {
  const state = { UgcVideo: { videoData: { title_display: title, cover: "https://pic.bstarstatic.com/ugc/x.jpg", duration: 6 } } };
  return `<html><head><meta property="og:title" content="${title}"></head><script>window.__INITIAL_DATA__=${JSON.stringify(state)};</script></html>`;
}

test("Bilibili.tv: a user video — its page, then its playurl answer, the aid as text", async () => {
  const page = `https://www.bilibili.tv/en/video/${AID}`;
  const api = `${API}/playurl?platform=web&aid=${AID}`;
  const net = network({ [page]: { body: btvPage("An invented clip") }, [api]: { body: playurl() } });
  const { ctx, pauses } = context(net.fetch);
  const original = `https://www.bilibili.tv/en/video/${AID}?bstar_from=bstar-web.ugc-video-detail.related-recommend.all`;
  const targets = targetsOf(
    await resolve(item({ site: "bilibilitv", id: AID, key: `bilibilitv:video:${AID}`, original }), ctx),
  );
  assert.deepEqual(net.calls.map((call) => call.url), [page, api]);
  assert.equal(pauses.count, 1);
  const target = /** @type {Target} */ (targets[0]);
  assert.equal(target.key, `bilibilitv:video:${AID}`);
  assert.equal(target.id, AID, "16 digits, never a number");
  assert.equal(target.title, "An invented clip");
  assert.equal(target.pageUrl, page);
  assert.equal(target.durationS, 6);
  const streams = target.streams;
  assert.ok(streams?.kind === "dash");
  assert.equal(streams.video.height, 1080);
  assert.equal(streams.audio?.bandwidth, 192000);
  assert.ok(net.calls.every((call) => call.init?.credentials === "include"));
});

test("Bilibili.tv: a page that states no duration — the playurl answer's is the one checked", async () => {
  const page = `https://www.bilibili.tv/en/video/${AID}`;
  const api = `${API}/playurl?platform=web&aid=${AID}`;
  const ogOnly = `<html><head><meta property="og:title" content="Only og tags"></head></html>`;
  /**
   * @param {{ body?: string, status?: number }} pageAnswer
   * @param {number} [durationMs]
   */
  const durationOf = async (pageAnswer, durationMs) => {
    const net = network({ [page]: pageAnswer, [api]: { body: playurl(0, durationMs) } });
    const [target] = targetsOf(await resolve(item({ site: "bilibilitv", id: AID }), context(net.fetch).ctx));
    return target?.durationS;
  };
  assert.equal(await durationOf({ body: ogOnly }, 95500), 95.5, "the answer's milliseconds");
  assert.equal(await durationOf({ status: 404 }, 95500), 95.5, "an unreadable page too");
  assert.equal(await durationOf({ body: btvPage("Stated") }, 95500), 6, "the page's own comes first");
  assert.equal(await durationOf({ body: ogOnly }), null, "neither states one");
  assert.equal(await durationOf({ body: ogOnly }, 1440), null, "seconds or milliseconds: none");
});

test("Bilibili.tv: an episode whose page states no duration — the series list's comes before the answer's", async () => {
  const season = "2090003";
  const net = network({
    [`${API}/v2/ogv/play/season_info?season_id=${season}&platform=web`]: { body: JSON.stringify({ code: 0, data: { season: { title: "An invented series" } } }) },
    [`${API}/v2/ogv/play/episodes?season_id=${season}&platform=web`]: {
      body: JSON.stringify({ code: 0, data: { sections: [{ episodes: [{ episode_id: 21, title_display: "E1", duration_ms: 1440000 }] }] } }),
    },
    [`https://www.bilibili.tv/en/play/${season}/21`]: { status: 404 },
    [`${API}/playurl?platform=web&ep_id=21`]: { body: playurl(0, 95500) },
  });
  const series = item({ site: "bilibilitv", id: season, kind: "series", key: `bilibilitv:series:${season}` });
  const [target] = targetsOf(await resolve(series, context(net.fetch).ctx));
  assert.equal(target?.durationS, 1440, "the list's 24 minutes, not the answer's unverified 95.5 s");
});

test("Bilibili.tv: a page that cannot be read is not fatal; a 403 on the API is a block", async () => {
  const page = `https://www.bilibili.tv/en/video/${AID}`;
  const api = `${API}/playurl?platform=web&aid=${AID}`;
  const net = network({ [page]: { status: 404 }, [api]: { body: playurl() } });
  const [target] = targetsOf(await resolve(item({ site: "bilibilitv", id: AID }), context(net.fetch).ctx));
  assert.equal(target?.title, AID, "the title falls back to the id");
  assert.ok(target?.streams !== null);
  const forbidden = network({ [page]: { body: btvPage("x") }, [api]: { status: 403 } });
  const blocked = failureOf(await resolve(item({ site: "bilibilitv", id: AID }), context(forbidden.fetch).ctx));
  assert.equal(blocked.status, "failed-blocked");
});

test("Bilibili.tv: the API's codes — geo, login (or premium), others unavailable; no media request", async () => {
  const page = `https://www.bilibili.tv/en/video/${AID}`;
  const api = `${API}/playurl?platform=web&aid=${AID}`;
  for (const [code, expected] of /** @type {const} */ ([
    [10004001, "geo_blocked"],
    [10004004, "login_required"],
    [10023006, "login_required"],
    [10003003, "deleted"],
  ])) {
    const net = network({ [page]: { body: btvPage("x") }, [api]: { body: playurl(code) } });
    const failed = failureOf(await resolve(item({ site: "bilibilitv", id: AID }), context(net.fetch).ctx));
    assert.equal(failed.failure.code, expected, String(code));
    assert.equal(failed.status, "failed-unavailable");
    assert.equal(net.calls.length, 2);
  }
});

test("Bilibili.tv: a series — season_info, episodes, then one page and playurl per episode", async () => {
  const season = "2090001";
  const routes = {
    [`${API}/v2/ogv/play/season_info?season_id=${season}&platform=web`]: { body: JSON.stringify({ code: 0, data: { season: { title: "An invented series" } } }) },
    [`${API}/v2/ogv/play/episodes?season_id=${season}&platform=web`]: {
      body: JSON.stringify({
        code: 0,
        data: {
          sections: [
            { episodes: [{ episode_id: 11, title_display: "E1 - Start" }, { episode_id: 12, title_display: "E2 - Middle" }] },
            { episodes: [{ episode_id: 13, title_display: "E3 - End" }] },
          ],
        },
      }),
    },
  };
  for (const ep of ["11", "12", "13"]) {
    Object.assign(routes, {
      [`https://www.bilibili.tv/en/play/${season}/${ep}`]: { body: btvPage(`Episode ${ep}`) },
      [`${API}/playurl?platform=web&ep_id=${ep}`]: { body: playurl() },
    });
  }
  const net = network(routes);
  const { ctx, pauses } = context(net.fetch);
  const targets = targetsOf(
    await resolve(item({ site: "bilibilitv", id: season, kind: "series", key: `bilibilitv:series:${season}` }), ctx),
  );
  assert.equal(net.calls.length, 2 + 3 * 2);
  assert.equal(pauses.count, net.calls.length - 1, "every request after the first is paced");
  assert.deepEqual(targets.map((target) => target.key), ["bilibilitv:episode:11", "bilibilitv:episode:12", "bilibilitv:episode:13"]);
  assert.deepEqual(targets.map((target) => target.part), [1, 2, 3]);
  assert.deepEqual(targets.map((target) => target.seriesTitle), ["An invented series", "An invented series", "An invented series"]);
  assert.deepEqual(targets.map((target) => target.seasonId), [season, season, season]);
  assert.deepEqual(targets.map((target) => target.episodeId), ["11", "12", "13"]);
  assert.equal(targets[0]?.pageUrl, `https://www.bilibili.tv/en/play/${season}/11`);
  assert.deepEqual(
    targets.map((target) => target.partTitle),
    ["E1 - Start", "E2 - Middle", "E3 - End"],
    "an episode's own title is the list's title_display",
  );
});

test("Bilibili.tv: a series whose episode list the site refuses fails with the site's code", async () => {
  const season = "2090002";
  const info = `${API}/v2/ogv/play/season_info?season_id=${season}&platform=web`;
  const list = `${API}/v2/ogv/play/episodes?season_id=${season}&platform=web`;
  const series = item({ site: "bilibilitv", id: season, kind: "series", key: `bilibilitv:series:${season}` });
  for (const [code, expected] of /** @type {const} */ ([
    [10004001, "geo_blocked"],
    [10004004, "login_required"],
  ])) {
    const net = network({
      [info]: { body: JSON.stringify({ code, message: String(code) }) },
      [list]: { body: JSON.stringify({ code, message: String(code) }) },
    });
    const failed = failureOf(await resolve(series, context(net.fetch).ctx));
    assert.equal(failed.failure.code, expected, String(code));
    assert.equal(failed.status, "failed-unavailable");
    assert.equal(net.calls.length, 2, "no episode page, no playurl request");
  }
  const empty = network({
    [info]: { body: JSON.stringify({ code: 0, data: { season: { title: "Empty" } } }) },
    [list]: { body: JSON.stringify({ code: 0, data: { sections: [] } }) },
  });
  const none = failureOf(await resolve(series, context(empty.fetch).ctx));
  assert.equal(none.failure.code, "no_streams");
  assert.equal(none.status, "failed-unavailable");
  assert.equal(none.title, "Empty");
  const junk = network({ [info]: { status: 404 }, [list]: { body: "<html>", headers: { "content-type": "text/html" } } });
  const notJson = failureOf(await resolve(series, context(junk.fetch).ctx));
  assert.equal(notJson.failure.code, "not_a_video");
});

test("Bilibili.tv: a single episode keeps its season; its row title is the page's", async () => {
  const page = `https://www.bilibili.tv/en/play/2090001/13000003`;
  const api = `${API}/playurl?platform=web&ep_id=13000003`;
  const net = network({ [page]: { body: btvPage("E3 - The end") }, [api]: { body: playurl() } });
  const episode = item({
    site: "bilibilitv",
    id: "13000003",
    kind: "episode",
    seasonId: "2090001",
    key: "bilibilitv:episode:13000003",
  });
  const [target] = targetsOf(await resolve(episode, context(net.fetch).ctx));
  assert.deepEqual(net.calls.map((call) => call.url), [page, api]);
  assert.equal(target?.title, "E3 - The end");
  assert.equal(target?.partTitle, null);
  assert.equal(target?.seasonId, "2090001");
  assert.equal(target?.episodeId, "13000003");
});

// --------------------------------------------------------------------------- the rest

test("refreshStreams keeps the chosen variant and the chosen representations", async () => {
  const dm = network({
    [METADATA]: { body: metadata() },
    [MASTER]: { body: MASTER_TEXT },
    [`${CDN}/360/media.m3u8`]: { body: mediaText() },
    [`${CDN}/1080/media.m3u8`]: { body: mediaText() },
  });
  const { ctx } = context(dm.fetch);
  const [target] = targetsOf(await resolve(item({ site: "dailymotion", id: DM_ID }), ctx));
  assert.ok(target !== undefined && target.streams?.kind === "hls");
  assert.ok(selectStream(target, 0), "the row's selector chose 360p");
  const fresh = await refreshStreams(target, ctx);
  assert.ok(fresh.ok && fresh.streams.kind === "hls");
  assert.equal(fresh.streams.variant.name, "360");
  const page1 = `https://www.bilibili.com/video/${BVID}?p=1`;
  const bili = network({ [`https://www.bilibili.com/video/${BVID}`]: { body: biliPage({ pages: 1 }) }, [page1]: { body: biliPage({ pages: 1 }) } });
  const biliCtx = context(bili.fetch).ctx;
  const [part] = targetsOf(await resolve(item({ site: "bilibili", id: BVID }), biliCtx));
  assert.ok(part !== undefined && part.streams?.kind === "dash");
  assert.ok(selectStream(part, 2), "720p chosen");
  const again = await refreshStreams(part, biliCtx);
  assert.ok(again.ok && again.streams.kind === "dash");
  assert.equal(again.streams.video.id, 64);
  assert.equal(again.streams.audio?.id, 30280);
});

test("refreshStreams never switches to another rendition: a renamed variant of the same encode is kept, a missing one is no_streams", async () => {
  /** @type {string} */
  let master = MASTER_TEXT;
  const dm = network({
    [METADATA]: { body: metadata() },
    [MASTER]: () => ({ body: master }),
    [`${CDN}/360/media.m3u8`]: { body: mediaText() },
    [`${CDN}/1080/media.m3u8`]: { body: mediaText() },
    [`${CDN}/1080b/media.m3u8`]: { body: mediaText() },
  });
  const { ctx } = context(dm.fetch);
  const [target] = targetsOf(await resolve(item({ site: "dailymotion", id: DM_ID }), ctx));
  assert.ok(target !== undefined && target.streams?.kind === "hls");
  assert.equal(target.streams.variant.url, `${CDN}/1080/media.m3u8`, "the policy's 1080p avc1");
  // the same encode under another NAME (and URL): kept
  master = MASTER_TEXT.replace('NAME="1080"\n' + `${CDN}/1080/media.m3u8`, `NAME="1080p"\n${CDN}/1080b/media.m3u8`);
  assert.notEqual(master, MASTER_TEXT);
  const renamed = await refreshStreams(target, ctx);
  assert.ok(renamed.ok && renamed.streams.kind === "hls");
  assert.equal(renamed.streams.variant.url, `${CDN}/1080b/media.m3u8`);
  // the chosen 1080p avc1 gone (only 360p and the HEVC 1080p left): never another rendition
  master = MASTER_TEXT.split("\n").slice(0, 5).join("\n");
  const before = dm.calls.length;
  const gone = await refreshStreams(target, ctx);
  assert.ok(!gone.ok);
  assert.deepEqual(gone.failure, { code: "no_streams", params: { detail: "the refreshed master no longer offers the chosen quality" } });
  assert.deepEqual(dm.calls.slice(before).map((call) => call.url.split("?")[0]), [METADATA.split("?")[0], MASTER.split("?")[0]], "no media playlist asked");
  // the row's own choice (360p) is kept the same way
  assert.ok(selectStream(target, 0));
  master = MASTER_TEXT;
  const chosen = await refreshStreams(target, ctx);
  assert.ok(chosen.ok && chosen.streams.kind === "hls");
  assert.equal(chosen.streams.variant.name, "360");
});

test("selectStream changes the row's video stream and re-picks nothing else; out of range changes nothing", () => {
  const rep = (/** @type {number} */ id) => ({ id, codecs: "avc1", codecFamily: /** @type {const} */ ("avc"), bandwidth: id, width: null, height: id, frameRate: null, urls: [`https://x.bilivideo.com/${id}`], mimeType: null, size: null, label: null });
  /** @type {Target} */
  const target = {
    key: "k", itemKey: "k", input: "", site: "bilibili", id: "BV", part: null, partCount: 1, cid: null, pageUrl: "", title: "t", partTitle: null,
    seasonId: null, episodeId: null, seriesTitle: null, durationS: 1, cover: null, uploader: null,
    streams: { kind: "dash", video: rep(1080), audio: null, available: [rep(1080), rep(720)], audioAvailable: [], missingPremium: [] },
    raw: null, hints: [], attempts: [], page: null, failure: null, status: null,
  };
  assert.equal(selectStream(target, 9), false);
  assert.equal(selectStream(target, 1), true);
  assert.equal(target.streams?.kind === "dash" && target.streams.video.height, 720);
});

test("bases: the real origins, or the fake sites' in test mode; onBase maps a page onto them", () => {
  assert.deepEqual(basesFor(undefined), PRODUCTION_BASES);
  const bases = basesFor({ bilibili: "http://127.0.0.1:8123/bili" });
  assert.equal(bases.bilibili, "http://127.0.0.1:8123/bili");
  assert.equal(bases.dailymotion, "https://www.dailymotion.com");
  assert.equal(onBase("https://www.bilibili.com/video/BV1?p=2", "https://www.bilibili.com", bases.bilibili), "http://127.0.0.1:8123/bili/video/BV1?p=2");
  assert.equal(bilibilitvPage("http://127.0.0.1:1/btv/", { aid: AID }), `http://127.0.0.1:1/btv/en/video/${AID}`);
  assert.equal(bilibilitvPage("https://www.bilibili.tv", { epId: "7", seasonId: "9" }), "https://www.bilibili.tv/en/play/9/7");
  assert.equal(bilibilitvPage("https://www.bilibili.tv", { epId: "7", seasonId: null }), null, "no season: no page");
});
