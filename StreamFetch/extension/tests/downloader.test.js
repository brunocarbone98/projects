// @ts-check
// app/downloader.js: the network rules (hosts, statuses, stalls, cut bodies, retries), the Referer
// rule, Chrome's downloads, and whole downloads over a fake network serving the ffmpeg fixtures of
// tests/helpers/media.js (DASH files with a cut and a Range resume, an expired URL refreshed once,
// encrypted media refused, MPEG-TS and fMP4 HLS) into an in-memory OPFS — the saved MP4 checked
// with ffprobe and framemd5 against the source clip.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import {
  DownloadsView,
  MEDIA_DOMAINS,
  REFERER_RULE_ID,
  SaveError,
  StepFailure,
  StopRequested,
  applyRefererRule,
  audioExpected,
  completeMoov,
  contentLength,
  contentRange,
  coverFailureReason,
  coverUrl,
  download,
  durationMatches,
  embeddedTitle,
  fetchText,
  hostCovered,
  jpegFromImage,
  keyMethodOf,
  mediaGap,
  mediaProblem,
  mp4SegmentProblem,
  oneLine,
  pathOf,
  pathRegex,
  refererRule,
  saveBlob,
  traceOf,
  tsSegmentProblem,
} from "../src/app/downloader.js";
import { WorkFiles } from "../src/app/files.js";
import { parseMedia } from "../src/lib/hls.js";
import { probe } from "../src/lib/mp4.js";
import {
  SOURCE_SECONDS,
  dashFixture,
  encryptedFixture,
  ffmpeg,
  ffprobe,
  framemd5,
  hlsFmp4Fixture,
  hlsTsFixture,
  mediaSkip,
  mp4Boxes,
  scratchPath,
  sourceClip,
} from "./helpers/media.js";

/** @type {string[]} */
const HOSTS = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"))
  .host_permissions;

/**
 * @typedef {import("../src/app/resolver.js").Target} Target
 * @typedef {import("../src/app/downloader.js").DownloadContext} DownloadContext
 */

// --------------------------------------------------------------------------- fakes

/** An in-memory OPFS directory (Chrome's semantics for what files.js uses). */
class FakeDir {
  constructor() {
    /** @type {"directory"} */
    this.kind = "directory";
    /** @type {Map<string, FakeDir | FakeFile>} */
    this.map = new Map();
  }
  /** @param {string} name @param {{ create?: boolean }} [options] @returns {Promise<FakeDir>} */
  async getDirectoryHandle(name, options = {}) {
    const found = this.map.get(name);
    if (found instanceof FakeDir) return found;
    if (!options.create) throw new Error(`NotFoundError: ${name}`);
    const dir = new FakeDir();
    this.map.set(name, dir);
    return dir;
  }
  /** @param {string} name @param {{ create?: boolean }} [options] @returns {Promise<FakeFile>} */
  async getFileHandle(name, options = {}) {
    const found = this.map.get(name);
    if (found instanceof FakeFile) return found;
    if (!options.create) throw new Error(`NotFoundError: ${name}`);
    const file = new FakeFile(name);
    this.map.set(name, file);
    return file;
  }
  /** @param {string} name */
  async removeEntry(name) {
    if (!this.map.delete(name)) throw new Error(`NotFoundError: ${name}`);
  }
  /** @returns {AsyncIterable<[string, FakeDir | FakeFile]>} */
  entries() {
    const list = [...this.map.entries()];
    return (async function* () {
      yield* list;
    })();
  }
}

/** One in-memory file: chunks kept as written, joined on close. */
class FakeFile {
  /** @param {string} name */
  constructor(name) {
    /** @type {"file"} */
    this.kind = "file";
    this.name = name;
    /** @type {Uint8Array<ArrayBuffer>} */
    this.bytes = new Uint8Array(0);
  }
  async getFile() {
    return new File([this.bytes.slice()], this.name, { lastModified: Date.now() });
  }
  async createWritable() {
    /** @type {Uint8Array[]} */
    let chunks = [];
    let size = 0;
    const file = this;
    return {
      /** @param {Uint8Array | { type: "seek", position: number } | { type: "truncate", size: number }} data */
      async write(data) {
        if (data instanceof Uint8Array) {
          chunks.push(data.slice());
          size += data.length;
        } else if (data.type === "truncate") {
          const joined = join(chunks).subarray(0, data.size);
          chunks = [joined];
          size = joined.length;
        }
      },
      async close() {
        file.bytes = join(chunks);
      },
      async abort() {},
    };
  }
}

/**
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array<ArrayBuffer>}
 */
function join(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** @type {chrome.declarativeNetRequest.Rule[][]} */
const installedRules = [];
Object.assign(globalThis, {
  chrome: {
    runtime: { id: "streamfetch-test-id" },
    declarativeNetRequest: {
      /** @param {{ addRules?: chrome.declarativeNetRequest.Rule[] }} options */
      updateSessionRules: async (options) => void installedRules.push(options.addRules ?? []),
    },
  },
});

/**
 * @typedef {{ status?: number, body?: Uint8Array | string, headers?: Record<string, string>,
 *   cutAt?: number, url?: string, never?: boolean }} Reply
 * @typedef {(url: string, headers: Record<string, string>, count: number) => Reply} Handler
 */

/**
 * A scripted network: handlers by URL without the query; every request recorded.
 * @param {Record<string, Handler>} routes
 */
function network(routes) {
  /** @type {{ url: string, headers: Record<string, string> }[]} */
  const calls = [];
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {typeof fetch} */
  const fakeFetch = async (input, init) => {
    const url = String(input);
    const headers = /** @type {Record<string, string>} */ (init?.headers ?? {});
    calls.push({ url, headers });
    const key = url.split("?")[0] ?? url;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const handler = routes[key];
    const reply = handler === undefined ? { status: 404 } : handler(url, headers, count);
    if (reply.never) {
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }
    const body = typeof reply.body === "string" ? new TextEncoder().encode(reply.body) : (reply.body ?? new Uint8Array(0));
    const cut = reply.cutAt;
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (cut === undefined) {
          if (body.length > 0) controller.enqueue(body);
          controller.close();
        } else if (pulls === 1) {
          controller.enqueue(body.slice(0, cut)); // what arrived before the connection dropped
        } else {
          controller.error(new Error("connection reset"));
        }
      },
    });
    const response = new Response(stream, { status: reply.status ?? 200, headers: reply.headers ?? {} });
    Object.defineProperty(response, "url", { value: reply.url ?? url });
    return response;
  };
  return { fetch: fakeFetch, calls };
}

/**
 * A static file with `Range` support (206 + Content-Range), the way the CDNs answer.
 * @param {Uint8Array} bytes
 * @param {{ type?: string }} [options]
 * @returns {Handler}
 */
function servedFile(bytes, options = {}) {
  return (_url, headers) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(headers["Range"] ?? "");
    const type = options.type ?? "video/mp4";
    /** @type {Reply} */
    let reply;
    if (range === null) {
      reply = { body: bytes, headers: { "content-length": String(bytes.length), "content-type": type } };
      return reply;
    }
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : bytes.length - 1;
    const part = bytes.slice(start, end + 1);
    reply = {
      status: 206,
      body: part,
      headers: {
        "content-length": String(part.length),
        "content-range": `bytes ${start}-${end}/${bytes.length}`,
        "content-type": type,
      },
    };
    return reply;
  };
}

/**
 * A downloads view and a `save` that keep the saved file's bytes.
 * @param {string[]} [existing] paths Chrome already has (relative)
 */
function fakeDownloads(existing = []) {
  /** @type {{ filename: string, bytes: Uint8Array }[]} */
  const saved = [];
  const api = /** @type {typeof chrome.downloads} */ (
    /** @type {unknown} */ ({
      search: async () =>
        existing.map((path, index) => ({
          id: index + 1,
          url: "",
          filename: `C:\\Users\\me\\Downloads\\${path.replace(/\//g, "\\")}`,
          state: "complete",
          exists: true,
          bytesReceived: 1,
          totalBytes: 1,
        })),
    })
  );
  const view = new DownloadsView({ api, rateLimitS: 0, existenceDelayMs: 0 });
  /** @param {Blob} blob @param {string} filename */
  const save = async (blob, filename) => {
    saved.push({ filename, bytes: new Uint8Array(await blob.arrayBuffer()) });
    return { id: saved.length, url: "", filename: `/home/me/Downloads/${filename}`, state: /** @type {const} */ ("complete"), exists: true, bytesReceived: 1, totalBytes: 1 };
  };
  return { view, save, saved };
}

/**
 * The context of one download over a network.
 * @param {typeof fetch} fakeFetch
 * @param {{ refresh?: DownloadContext["refresh"], signal?: AbortSignal, existing?: string[], stallMs?: number }} [options]
 */
function context(fakeFetch, options = {}) {
  const root = new FakeDir();
  const downloads = fakeDownloads(options.existing);
  /** @type {string[]} */
  const referers = [];
  /** @type {number[]} */
  const sleeps = [];
  /** @type {string[]} */
  const statuses = [];
  let refreshes = 0;
  /** @type {DownloadContext} */
  const ctx = {
    net: {
      fetch: fakeFetch,
      hostPatterns: HOSTS,
      signal: options.signal ?? new AbortController().signal,
      stallMs: options.stallMs ?? 2000,
      sleep: async (seconds) => void sleeps.push(seconds),
    },
    pacing: { videoPauseS: [3, 6], pagePauseS: [1, 2], mediaPauseMs: [100, 300] },
    rng: () => 0.5,
    files: new WorkFiles({ root: async () => root }),
    view: downloads.view,
    save: downloads.save,
    applyReferer: async (site) => void referers.push(site),
    refresh: async (target) => {
      refreshes += 1;
      if (options.refresh) return options.refresh(target);
      return { ok: false, failure: { code: "no_streams", params: {} }, status: "failed-unavailable" };
    },
    pagePause: async () => undefined,
    browserCheck: async () => 6,
    onStatus: (status) => void statuses.push(status),
  };
  return { ctx, root, saved: downloads.saved, referers, sleeps, statuses, refreshes: () => refreshes };
}

/**
 * The work files left in the fake OPFS.
 * @param {FakeDir} root
 * @returns {string[]}
 */
function leftovers(root) {
  const own = root.map.get("streamfetch");
  const work = own instanceof FakeDir ? own.map.get("work") : undefined;
  return work instanceof FakeDir ? [...work.map.keys()] : [];
}

/**
 * A DASH target (a Bilibili part) over `video` / `audio` URLs.
 * @param {string[]} videoUrls
 * @param {string[] | null} audioUrls
 * @param {Partial<Target>} [fields]
 * @returns {Target}
 */
function dashTarget(videoUrls, audioUrls, fields = {}) {
  /** @param {string[]} urls @param {number} id */
  const rep = (urls, id) => ({ id, codecs: id > 1000 ? "mp4a.40.2" : "avc1.640028", codecFamily: /** @type {"unknown" | "avc"} */ (id > 1000 ? "unknown" : "avc"), bandwidth: 300000, width: 320, height: 180, frameRate: 25, urls, mimeType: null, size: null, label: null });
  const video = rep(videoUrls, 80);
  const audio = audioUrls === null ? null : rep(audioUrls, 30280);
  return {
    key: "bilibili:BV1Xx411c7mD:all",
    itemKey: "bilibili:BV1Xx411c7mD:all",
    input: "https://www.bilibili.com/video/BV1Xx411c7mD",
    site: "bilibili",
    id: "BV1Xx411c7mD",
    part: null,
    partCount: 1,
    cid: "9000",
    pageUrl: "https://www.bilibili.com/video/BV1Xx411c7mD",
    title: "An invented clip",
    partTitle: null,
    seasonId: null,
    episodeId: null,
    seriesTitle: null,
    durationS: SOURCE_SECONDS,
    cover: null,
    uploader: null,
    streams: { kind: "dash", video, audio, available: [video], audioAvailable: audio === null ? [] : [audio], missingPremium: [] },
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
 * An HLS target (a Dailymotion video) over a media playlist served at `mediaUrl`.
 * @param {string} mediaText
 * @param {string} mediaUrl
 * @returns {Target}
 */
function hlsTarget(mediaText, mediaUrl) {
  const variant = { url: mediaUrl, bandwidth: 300000, width: 320, height: 180, frameRate: 25, codecs: "avc1.64000d,mp4a.40.2", name: "180", audioGroup: null };
  return {
    ...dashTarget([], null),
    key: "dailymotion:xbq9z2k",
    itemKey: "dailymotion:xbq9z2k",
    site: "dailymotion",
    id: "xbq9z2k",
    partCount: null,
    cid: null,
    pageUrl: "https://www.dailymotion.com/video/xbq9z2k",
    streams: { kind: "hls", master: "https://www.dailymotion.com/cdn/manifest/video/xbq9z2k.m3u8", variant, audio: null, available: [variant], audioRenditions: [] },
    raw: { metadata: {}, media: parseMedia(mediaText, mediaUrl), mediaUrl, audioMedia: null, audioMediaUrl: null, keyMethod: null },
  };
}

/**
 * The saved file checked with ffprobe and framemd5 against the source clip.
 * @param {Uint8Array} bytes
 * @param {string} name
 */
function assertSameAsSource(bytes, name) {
  const path = scratchPath(name);
  writeFileSync(path, bytes);
  const probed = ffprobe(path);
  assert.deepEqual(probed.streams.map((stream) => stream.codec_type).sort(), ["audio", "video"]);
  assert.ok(Math.abs((probed.format.duration ?? 0) - SOURCE_SECONDS) < 0.15, `duration ${probed.format.duration}`);
  const source = sourceClip();
  assert.deepEqual(framemd5(path, { stream: "v:0" }), framemd5(source, { stream: "v:0" }), "video frames");
  // ffmpeg's fragmented and segmented outputs carry no AAC priming edit: every frame of the
  // source's audio, its priming frame included, is in the file (what remux.test.js asserts too)
  assert.deepEqual(
    framemd5(path, { stream: "a:0" }),
    framemd5(source, { stream: "a:0", ignoreEditList: true }),
    "audio frames",
  );
}

// ------------------------------------------------------------------------ the rules

test("hostCovered: the manifest's patterns, subdomains of a wildcard, the scheme exact", () => {
  assert.ok(hostCovered("https://upos-sz-mirrorcos.bilivideo.com/x.m4s", HOSTS));
  assert.ok(hostCovered("https://dai.ly/xbq9z2k", HOSTS));
  assert.ok(!hostCovered("http://www.dailymotion.com/", HOSTS));
  assert.ok(!hostCovered("https://www.dailymotion.com.evil.example/", HOSTS));
  assert.ok(!hostCovered("not a url", HOSTS));
  assert.ok(hostCovered("http://127.0.0.1:8123/dm/x", ["http://127.0.0.1/*"]), "the test copy's pattern, any port");
});

test("the Referer rule: initiator = the extension, the site's media domains, Referer set, Origin removed", async () => {
  const rule = refererRule("bilibili");
  assert.equal(rule.id, REFERER_RULE_ID);
  assert.deepEqual(rule.condition.initiatorDomains, ["streamfetch-test-id"]);
  assert.deepEqual(rule.condition.requestDomains, [...MEDIA_DOMAINS.bilibili]);
  assert.equal(rule.condition.urlFilter, undefined);
  assert.deepEqual(rule.action.requestHeaders, [
    { header: "Referer", operation: "set", value: "https://www.bilibili.com/" },
    { header: "Origin", operation: "remove" },
  ]);
  assert.equal(refererRule("dailymotion").action.requestHeaders?.[0]?.value, "https://www.dailymotion.com/");
  assert.equal(refererRule("bilibilitv").action.requestHeaders?.[0]?.value, "https://www.bilibili.tv/");
  const testRule = refererRule("bilibili", "http://127.0.0.1:8123/bili/");
  assert.equal(testRule.condition.urlFilter, "|http://127.0.0.1:8123/");
  assert.equal(testRule.condition.requestDomains, undefined);
  assert.equal(testRule.action.requestHeaders?.[0]?.value, "http://127.0.0.1:8123/bili/");
  installedRules.length = 0;
  await applyRefererRule("dailymotion");
  assert.equal(installedRules.length, 1);
  assert.deepEqual(installedRules[0]?.[0]?.condition.requestDomains, ["dailymotion.com", "dmcdn.net"]);
});

test("small helpers: Content-Length, Content-Range, the path regex, the moov finder, the tolerance", () => {
  assert.equal(contentLength(new Headers({ "content-length": "42" })), 42);
  assert.equal(contentLength(new Headers({ "content-length": "42", "content-encoding": "gzip" })), null);
  assert.equal(contentLength(new Headers({})), null);
  assert.deepEqual(contentRange("bytes 10-19/100"), { start: 10, end: 19, total: 100 });
  assert.deepEqual(contentRange("bytes 0-9/*"), { start: 0, end: 9, total: null });
  assert.equal(contentRange(null), null);
  const regex = new RegExp(pathRegex("StreamFetch/Bilibili/A (b) [BV1].mp4"));
  assert.ok(regex.test("C:\\Users\\me\\Downloads\\StreamFetch\\Bilibili\\A (b) [BV1].mp4"));
  assert.ok(regex.test("/home/me/Downloads/StreamFetch/Bilibili/A (b) [BV1].mp4"));
  assert.ok(!regex.test("/home/me/Downloads/StreamFetch/Bilibili/XA (b) [BV1].mp4"));
  const box = (/** @type {string} */ type, /** @type {number} */ size) => {
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    out.set([...type].map((char) => char.charCodeAt(0)), 4);
    return out;
  };
  const head = join([box("ftyp", 16), box("moov", 24), box("mdat", 40)]);
  assert.equal(completeMoov(head)?.length, 24);
  assert.equal(completeMoov(head.subarray(0, 30)), null, "a moov cut by the window is not complete yet");
  assert.equal(completeMoov(join([box("ftyp", 16), box("mdat", 4000)]).subarray(0, 100)), null);
  assert.ok(durationMatches(62.9, 60));
  assert.ok(!durationMatches(63.1, 60));
  assert.ok(durationMatches(1900, 2000), "5 % of a long video");
  assert.ok(!durationMatches(1899, 2000));
  assert.equal(oneLine(new Error("GET https://x.bilivideo.com/a.m4s?deadline=1&upsig=secret failed")), "GET https://x.bilivideo.com/a.m4s failed");
});

test("playlists: the key's METHOD, and the refusals before any media request", () => {
  assert.equal(keyMethodOf("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"k\"\n"), "SAMPLE-AES");
  assert.equal(keyMethodOf("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n"), null);
  const media = parseMedia("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST\n", "https://x.dailymotion.com/m.m3u8");
  assert.equal(mediaProblem(media, null), null);
  assert.equal(mediaProblem({ ...media, keyProtected: true }, "AES-128")?.code, "key_protected");
  assert.equal(mediaProblem({ ...media, endList: false }, null)?.code, "live_stream");
  assert.deepEqual(mediaProblem({ ...media, discontinuities: 2 }, null), { code: "discontinuous_stream", params: { count: 2 } });
  assert.equal(mediaProblem({ ...media, segments: [] }, null)?.code, "no_streams");
});

test("requests: a stall before the answer, a stall in the body and a cut body are retried, then fail", async () => {
  const url = "https://www.dailymotion.com/player/metadata/video/xbq9z2k";
  const silent = network({ [url]: () => ({ never: true }) });
  const { ctx } = context(silent.fetch, { stallMs: 20 });
  /** @type {import("../src/lib/report.js").Attempt[]} */
  const attempts = [];
  const stalled = await fetchText(url, "metadata", ctx.net, attempts).catch((error) => error);
  assert.ok(stalled instanceof StepFailure);
  assert.equal(stalled.failure.code, "no_response");
  assert.equal(silent.calls.length, 4, "the first try and three retries");
  assert.equal(attempts[0]?.outcome, "stalled before an answer");
  const cut = network({ [url]: () => ({ body: "0123456789", cutAt: 4, headers: { "content-length": "10" } }) });
  const cutError = await fetchText(url, "metadata", context(cut.fetch).ctx.net, []).catch((error) => error);
  assert.ok(cutError instanceof StepFailure);
  assert.equal(cutError.failure.code, "truncated_body");
  const short = network({ [url]: () => ({ body: "0123", headers: { "content-length": "10" } }) });
  const shortError = await fetchText(url, "metadata", context(short.fetch).ctx.net, []).catch((error) => error);
  assert.deepEqual(shortError.failure, { code: "truncated_body", params: { received: 4, expected: 10 } });
  const redirected = network({ [url]: () => ({ body: "{}", url: "https://evil.example/x" }) });
  const redirect = await fetchText(url, "metadata", context(redirected.fetch).ctx.net, []).catch((error) => error);
  assert.deepEqual(redirect.failure, { code: "redirect_refused", params: { host: "evil.example" } });
  const login = network({ [url]: () => ({ status: 401 }) });
  assert.equal((await fetchText(url, "page", context(login.fetch).ctx.net, []).catch((error) => error)).failure.code, "login_required");
});

// -------------------------------------------------------------------- Chrome's downloads

test("DownloadsView finds a completed download that still exists at exactly the target path", async () => {
  /** @type {chrome.downloads.DownloadQuery[]} */
  const queries = [];
  const items = [
    { id: 1, url: "", filename: "C:\\Users\\me\\Downloads\\StreamFetch\\Dailymotion\\A [x1].mp4", state: /** @type {const} */ ("complete"), exists: true, bytesReceived: 1, totalBytes: 1 },
    { id: 2, url: "", filename: "C:\\Users\\me\\Downloads\\StreamFetch\\Dailymotion\\B [x2].mp4", state: /** @type {const} */ ("complete"), exists: false, bytesReceived: 1, totalBytes: 1 },
  ];
  const api = /** @type {typeof chrome.downloads} */ (/** @type {unknown} */ ({
    /** @param {chrome.downloads.DownloadQuery} query */
    search: async (query) => {
      queries.push(query);
      if (query.filenameRegex === undefined) return [];
      const regex = new RegExp(query.filenameRegex);
      return items.filter((item) => regex.test(item.filename));
    },
  }));
  /** @type {number[]} */
  const waits = [];
  let now = 100_000;
  const view = new DownloadsView({ api, rateLimitS: 10, existenceDelayMs: 300, now: () => now, sleep: async (seconds) => void waits.push(seconds) });
  assert.equal((await view.completedAt("StreamFetch/Dailymotion/A [x1].mp4"))?.id, 1);
  assert.equal(await view.completedAt("StreamFetch/Dailymotion/B [x2].mp4"), null, "deleted since");
  assert.equal(await view.completedAt("StreamFetch/Dailymotion/C [x3].mp4"), null);
  assert.equal(queries[0]?.limit, 1, "first a search that makes Chrome re-check its files");
  assert.ok(waits.some((seconds) => seconds > 9), "the second look waits out Chrome's 10 s");
  now += 0;
});

test("saveBlob: uniquify, no Save As, waits for the end; an interrupted save is a SaveError", async () => {
  /** @type {chrome.downloads.DownloadOptions[]} */
  const asked = [];
  let state = /** @type {chrome.downloads.State} */ ("complete");
  const api = /** @type {typeof chrome.downloads} */ (/** @type {unknown} */ ({
    /** @param {chrome.downloads.DownloadOptions} options */
    download: async (options) => {
      asked.push(options);
      return 7;
    },
    search: async () => [{ id: 7, url: "", filename: "/d/StreamFetch/x.json", state, exists: true, bytesReceived: 1, totalBytes: 1, error: "FILE_FAILED" }],
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  }));
  const item = await saveBlob(new Blob(["{}"]), "StreamFetch/reports/x.json", api);
  assert.equal(item.filename, "/d/StreamFetch/x.json");
  assert.equal(asked[0]?.conflictAction, "uniquify");
  assert.equal(asked[0]?.saveAs, false);
  assert.equal(asked[0]?.filename, "StreamFetch/reports/x.json");
  assert.match(String(asked[0]?.url), /^blob:/);
  state = "interrupted";
  await assert.rejects(saveBlob(new Blob(["{}"]), "x.json", api), SaveError);
});

// ---------------------------------------------------------------------------- downloads

const VIDEO_URL = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/80.m4s";
const AUDIO_URL = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/30280.m4s";

test("a file already in Downloads is skipped without a request", async () => {
  const net = network({});
  const target = dashTarget([VIDEO_URL], [AUDIO_URL]);
  const { ctx, referers } = context(net.fetch, { existing: [pathOf(target)] });
  const result = await download(target, ctx);
  assert.equal(result.status, "skipped-exists");
  assert.match(String(result.path), /StreamFetch\\Bilibili\\An invented clip \[BV1Xx411c7mD\]\.mp4$/);
  assert.equal(net.calls.length, 0);
  assert.deepEqual(referers, [], "not even the Referer rule");
});

test("a target the resolver could not resolve fails with its own failure, without a request", async () => {
  const net = network({});
  const target = dashTarget([VIDEO_URL], null, { failure: { code: "geo_blocked", params: {} }, status: "failed-unavailable", streams: null });
  const result = await download(target, context(net.fetch).ctx);
  assert.equal(result.status, "failed-unavailable");
  assert.equal(result.failure?.code, "geo_blocked");
  assert.equal(result.contacted, false);
  assert.equal(net.calls.length, 0);
});

test("a media URL outside the manifest's hosts is never requested; the row names the host", async () => {
  const net = network({});
  const target = dashTarget(["https://cdn.unknown-mirror.example/80.m4s"], null);
  const result = await download(target, context(net.fetch).ctx);
  assert.equal(result.failure?.code, "host_not_covered");
  assert.equal(result.failure?.params["host"], "cdn.unknown-mirror.example");
  assert.equal(net.calls.length, 0);
  assert.deepEqual(result.attempts.map((attempt) => [attempt.requested, attempt.outcome]), [[false, "not requested: host not covered"]]);
});

test(
  "DASH: video then audio, a cut transfer resumed with Range, the progressive MP4 verified and saved",
  { skip: mediaSkip() },
  async () => {
    const dash = dashFixture();
    const video = readFileSync(dash.video);
    const audio = readFileSync(dash.audio);
    const videoHandler = servedFile(video);
    const net = network({
      [VIDEO_URL]: (url, headers, count) => {
        if (count === 1) return { body: video, cutAt: Math.floor(video.length / 2), headers: { "content-length": String(video.length) } };
        return videoHandler(url, headers, count);
      },
      [AUDIO_URL]: servedFile(audio),
    });
    const { ctx, saved, root, referers, sleeps, statuses } = context(net.fetch);
    const target = dashTarget([`${VIDEO_URL}?deadline=1&upsig=s`], [`${AUDIO_URL}?deadline=1`]);
    const result = await download(target, ctx);
    assert.equal(result.status, "done", JSON.stringify(result.failure));
    assert.deepEqual(referers, ["bilibili"]);
    assert.deepEqual(net.calls.map((call) => [call.url.split("?")[0], call.headers["Range"] ?? null]), [
      [VIDEO_URL, null],
      [VIDEO_URL, `bytes=${Math.floor(video.length / 2)}-`],
      [AUDIO_URL, null],
    ]);
    assert.deepEqual(statuses, ["downloading", "finishing", "verifying"]);
    assert.ok(sleeps.includes(1), "a backoff before the resume");
    assert.ok(sleeps.filter((seconds) => seconds === 0.2).length >= 2, "a media pause before every media request but the first");
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.filename, "StreamFetch/Bilibili/An invented clip [BV1Xx411c7mD].mp4");
    assert.equal(result.bytes, saved[0]?.bytes.length);
    assert.ok(result.verify?.progressive);
    assert.deepEqual(result.verify?.tracks.map((track) => track.kind), ["video", "audio"]);
    assert.equal(result.verify?.browser_duration_s, 6);
    assert.deepEqual(leftovers(root), [], "the work files are removed");
    assert.deepEqual(traceOf(target).map((attempt) => attempt.range), [null, `bytes=${Math.floor(video.length / 2)}-`, null]);
    assertSameAsSource(/** @type {Uint8Array} */ (saved[0]?.bytes), "saved-dash.mp4");
  },
);

test("DASH: a refused (expired) URL is refreshed once and the download goes on", { skip: mediaSkip() }, async () => {
  const dash = dashFixture();
  const audio = readFileSync(dash.audio);
  const fresh = `${AUDIO_URL.replace("30280", "30280-fresh")}`;
  const net = network({
    [VIDEO_URL]: servedFile(readFileSync(dash.video)),
    [AUDIO_URL]: () => ({ status: 403 }),
    [fresh]: servedFile(audio),
  });
  const target = dashTarget([VIDEO_URL], [AUDIO_URL]);
  const { ctx, saved, refreshes } = context(net.fetch, {
    refresh: async (stale) => {
      const streams = /** @type {import("../src/app/resolver.js").DashChoice} */ (stale.streams);
      const audioRep = /** @type {import("../src/lib/bilibili.js").DashRep} */ (streams.audio);
      return { ok: true, streams: { ...streams, audio: { ...audioRep, urls: [fresh] } }, raw: null };
    },
  });
  const result = await download(target, ctx);
  assert.equal(result.status, "done", JSON.stringify(result.failure));
  assert.equal(refreshes(), 1);
  assert.equal(saved.length, 1);
  const twice = network({ [VIDEO_URL]: () => ({ status: 403 }) });
  const again = context(twice.fetch, { refresh: async (stale) => ({ ok: true, streams: /** @type {import("../src/app/resolver.js").StreamChoice} */ (stale.streams), raw: null }) });
  const failed = await download(dashTarget([VIDEO_URL], [AUDIO_URL]), again.ctx);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.failure, { code: "http_status", params: { status: 403, what: "media" } });
  assert.equal(again.refreshes(), 1, "never a loop");
  assert.equal(again.saved.length, 0);
});

test("DASH: a 429 on media is a rate limit at once; encrypted media is refused and never saved", { skip: mediaSkip() }, async () => {
  const limited = network({ [VIDEO_URL]: () => ({ status: 429 }) });
  const rate = await download(dashTarget([VIDEO_URL], [AUDIO_URL]), context(limited.fetch).ctx);
  assert.equal(rate.status, "failed-rate-limited");
  assert.equal(limited.calls.length, 1);
  const encrypted = encryptedFixture();
  const net = network({ [VIDEO_URL]: servedFile(readFileSync(encrypted.video)), [AUDIO_URL]: servedFile(readFileSync(encrypted.audio)) });
  const { ctx, saved, root } = context(net.fetch);
  const result = await download(dashTarget([VIDEO_URL], [AUDIO_URL]), ctx);
  assert.equal(result.status, "failed-unavailable");
  assert.equal(result.failure?.code, "encrypted");
  assert.equal(saved.length, 0);
  assert.equal(net.calls.length, 1, "refused as soon as the moov arrived: the audio is never asked for");
  assert.deepEqual(leftovers(root), []);
});

test("DASH: a duration far from the site's fails verification and nothing is saved", { skip: mediaSkip() }, async () => {
  const dash = dashFixture();
  const net = network({ [VIDEO_URL]: servedFile(readFileSync(dash.video)), [AUDIO_URL]: servedFile(readFileSync(dash.audio)) });
  const { ctx, saved, root } = context(net.fetch);
  const result = await download(dashTarget([VIDEO_URL], [AUDIO_URL], { durationS: 60 }), ctx);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "verify_failed");
  assert.match(String(result.failure?.params["reason"]), /^duration 6\.\d s, expected 60\.0 s$/);
  assert.equal(saved.length, 0);
  assert.deepEqual(leftovers(root), []);
});

test("DASH: an audio file that ended early fails verification, against the site's or the video's duration", { skip: mediaSkip() }, async () => {
  const dash = dashFixture();
  const audio = new Uint8Array(readFileSync(dash.audio));
  // a clean cut at a fragment boundary, served with a matching Content-Length: only the
  // durations can tell (the file's own duration is still the video's 6 s)
  const boxes = mp4Boxes(audio);
  const fragments = boxes.filter((box) => box.type === "moof");
  const cut = /** @type {{ start: number }} */ (fragments[2]).start;
  const short = audio.slice(0, cut);
  for (const durationS of [6, null]) {
    const net = network({ [VIDEO_URL]: servedFile(readFileSync(dash.video)), [AUDIO_URL]: servedFile(short) });
    const { ctx, saved, root } = context(net.fetch);
    const result = await download(dashTarget([VIDEO_URL], [AUDIO_URL], { durationS }), ctx);
    assert.equal(result.failure?.code, "verify_failed", JSON.stringify(result.failure));
    const against = durationS === null ? "the video's" : "expected";
    const reason = new RegExp(`^audio track [12]\\.\\d s, ${against} 6\\.\\d s$`);
    assert.match(String(result.failure?.params["reason"]), reason);
    assert.equal(saved.length, 0);
    assert.deepEqual(leftovers(root), []);
  }
});

test("DASH: a source without audio is saved with the no-audio note", { skip: mediaSkip() }, async () => {
  const dash = dashFixture();
  const net = network({ [VIDEO_URL]: servedFile(readFileSync(dash.video)) });
  const { ctx, saved } = context(net.fetch);
  ctx.browserCheck = async () => null;
  const result = await download(dashTarget([VIDEO_URL], null), ctx);
  assert.equal(result.status, "done", JSON.stringify(result.failure));
  assert.deepEqual(result.notes.map((note) => note.code), ["no_audio", "browser_unreadable"]);
  assert.equal(result.notes[1]?.params["codec"], "avc1");
  assert.deepEqual(result.verify?.tracks.map((track) => track.kind), ["video"]);
  assert.equal(saved.length, 1);
});

test("HLS in MPEG-TS: every segment in order through the demuxer, the result frame-exact", { skip: mediaSkip() }, async () => {
  const hls = hlsTsFixture();
  const base = "https://proxy-07.dailymotion.com/sec(1)/hls";
  /** @type {Record<string, Handler>} */
  const routes = {};
  hls.segments.forEach((segment, index) => {
    const name = `seg${String(index).padStart(3, "0")}.ts`;
    routes[`${base}/${name}`] = servedFile(readFileSync(segment), { type: "video/mp2t" });
  });
  const net = network(routes);
  const { ctx, saved, root, referers } = context(net.fetch);
  /** @type {import("../src/app/downloader.js").Progress[]} */
  const progress = [];
  ctx.onProgress = (step) => void progress.push(step);
  const target = hlsTarget(readFileSync(hls.media, "utf8"), `${base}/media.m3u8?sec=1`);
  const result = await download(target, ctx);
  assert.equal(result.status, "done", JSON.stringify(result.failure));
  assert.deepEqual(referers, ["dailymotion"]);
  assert.deepEqual(net.calls.map((call) => call.url.split("/").at(-1)), hls.segments.map((_s, index) => `seg${String(index).padStart(3, "0")}.ts`));
  assert.equal(progress.at(-1)?.segments?.done, hls.segments.length);
  assert.equal(saved[0]?.filename, "StreamFetch/Dailymotion/An invented clip [xbq9z2k].mp4");
  assert.deepEqual(leftovers(root), []);
  assertSameAsSource(/** @type {Uint8Array} */ (saved[0]?.bytes), "saved-hls-ts.mp4");
});

test("HLS in fMP4: the init then the segments, read back as one fragmented file", { skip: mediaSkip() }, async () => {
  const hls = hlsFmp4Fixture();
  const base = "https://proxy-07.dailymotion.com/sec(1)/fmp4";
  /** @type {Record<string, Handler>} */
  const routes = { [`${base}/init.mp4`]: servedFile(readFileSync(/** @type {string} */ (hls.init))) };
  hls.segments.forEach((segment, index) => {
    routes[`${base}/seg${String(index).padStart(3, "0")}.m4s`] = servedFile(readFileSync(segment));
  });
  const net = network(routes);
  const { ctx, saved } = context(net.fetch);
  const result = await download(hlsTarget(readFileSync(hls.media, "utf8"), `${base}/media.m3u8`), ctx);
  assert.equal(result.status, "done", JSON.stringify(result.failure));
  assert.equal(net.calls[0]?.url, `${base}/init.mp4`);
  assertSameAsSource(/** @type {Uint8Array} */ (saved[0]?.bytes), "saved-hls-fmp4.mp4");
});

test("HLS: an expired segment refreshes the playlist once (mapped by index) and goes on", { skip: mediaSkip() }, async () => {
  const hls = hlsTsFixture();
  const base = "https://proxy-07.dailymotion.com/sec(1)/hls";
  const freshBase = "https://proxy-07.dailymotion.com/sec(2)/hls";
  /** @type {Record<string, Handler>} */
  const routes = {};
  hls.segments.forEach((segment, index) => {
    const name = `seg${String(index).padStart(3, "0")}.ts`;
    routes[`${base}/${name}`] = index === 1 ? () => ({ status: 403 }) : servedFile(readFileSync(segment));
    routes[`${freshBase}/${name}`] = servedFile(readFileSync(segment));
  });
  const net = network(routes);
  const mediaText = readFileSync(hls.media, "utf8");
  const { ctx, saved, refreshes } = context(net.fetch, {
    refresh: async (stale) => {
      const raw = /** @type {import("../src/app/resolver.js").HlsRaw} */ (stale.raw);
      return { ok: true, streams: /** @type {import("../src/app/resolver.js").StreamChoice} */ (stale.streams), raw: { ...raw, media: parseMedia(mediaText, `${freshBase}/media.m3u8`) } };
    },
  });
  const result = await download(hlsTarget(mediaText, `${base}/media.m3u8`), ctx);
  assert.equal(result.status, "done", JSON.stringify(result.failure));
  assert.equal(refreshes(), 1);
  assert.deepEqual(net.calls.slice(0, 3).map((call) => call.url.split("/").slice(-2).join("/")), ["hls/seg000.ts", "hls/seg001.ts", "hls/seg001.ts"]);
  assert.match(String(net.calls[2]?.url), /sec\(2\)/, "the refused segment again, from the fresh playlist");
  assert.equal(saved.length, 1);
});

test("HLS: a key-protected or live playlist is refused before any media request", async () => {
  const net = network({});
  const keyed = hlsTarget("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST\n", "https://proxy-07.dailymotion.com/m.m3u8");
  const raw = /** @type {import("../src/app/resolver.js").HlsRaw} */ (keyed.raw);
  raw.keyMethod = "AES-128";
  const result = await download(keyed, context(net.fetch).ctx);
  assert.equal(result.failure?.code, "key_protected");
  assert.equal(result.failure?.params["method"], "AES-128");
  const live = hlsTarget("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n", "https://proxy-07.dailymotion.com/m.m3u8");
  assert.equal((await download(live, context(net.fetch).ctx)).failure?.code, "live_stream");
  assert.equal(net.calls.length, 0);
});

test("HLS: a refreshed playlist passes the same refusals — a key appearing after the refresh is refused before any request", { skip: mediaSkip() }, async () => {
  const hls = hlsTsFixture();
  const base = "https://proxy-07.dailymotion.com/sec(1)/hls";
  const freshBase = "https://proxy-07.dailymotion.com/sec(2)/hls";
  /** @type {Record<string, Handler>} */
  const routes = {};
  hls.segments.forEach((segment, index) => {
    const name = `seg${String(index).padStart(3, "0")}.ts`;
    routes[`${base}/${name}`] = index === 1 ? () => ({ status: 403 }) : servedFile(readFileSync(segment));
    routes[`${freshBase}/${name}`] = servedFile(readFileSync(segment));
  });
  const net = network(routes);
  const mediaText = readFileSync(hls.media, "utf8");
  const keyed = mediaText.replace("#EXTINF", '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"\n#EXTINF');
  const { ctx, saved, root } = context(net.fetch, {
    refresh: async (stale) => {
      const raw = /** @type {import("../src/app/resolver.js").HlsRaw} */ (stale.raw);
      const media = parseMedia(keyed, `${freshBase}/media.m3u8`);
      return { ok: true, streams: /** @type {import("../src/app/resolver.js").StreamChoice} */ (stale.streams), raw: { ...raw, media, keyMethod: "SAMPLE-AES" } };
    },
  });
  const result = await download(hlsTarget(mediaText, `${base}/media.m3u8`), ctx);
  assert.equal(result.failure?.code, "key_protected");
  assert.equal(result.failure?.params["method"], "SAMPLE-AES");
  assert.deepEqual(net.calls.map((call) => call.url.split("/").slice(-2).join("/")), ["hls/seg000.ts", "hls/seg001.ts"], "nothing of the protected stream requested");
  assert.equal(saved.length, 0);
  assert.deepEqual(leftovers(root), []);
});

test("HLS: the row's chosen variant is downloaded — its media playlist read again, then its segments", { skip: mediaSkip() }, async () => {
  const hls = hlsTsFixture();
  const base = "https://proxy-07.dailymotion.com/sec(1)/1080";
  const chosenBase = "https://proxy-07.dailymotion.com/sec(1)/480";
  const mediaText = readFileSync(hls.media, "utf8");
  /** @type {Record<string, Handler>} */
  const routes = { [`${chosenBase}/media.m3u8`]: () => ({ body: mediaText, headers: { "content-type": "application/vnd.apple.mpegurl" } }) };
  hls.segments.forEach((segment, index) => {
    routes[`${chosenBase}/seg${String(index).padStart(3, "0")}.ts`] = servedFile(readFileSync(segment));
  });
  const net = network(routes);
  const { ctx, saved } = context(net.fetch);
  const target = hlsTarget(mediaText, `${base}/media.m3u8`);
  const streams = /** @type {import("../src/app/resolver.js").HlsChoice} */ (target.streams);
  const chosen = { ...streams.variant, url: `${chosenBase}/media.m3u8`, height: 480, width: 854, name: "480" };
  target.streams = { ...streams, variant: chosen, available: [streams.variant, chosen] };
  const result = await download(target, ctx);
  assert.equal(result.status, "done", JSON.stringify(result.failure));
  assert.deepEqual(
    net.calls.map((call) => call.url.split("/").slice(-2).join("/")),
    ["480/media.m3u8", ...hls.segments.map((_s, index) => `480/seg${String(index).padStart(3, "0")}.ts`)],
    "the chosen variant's playlist and segments, never the first variant's",
  );
  assertSameAsSource(/** @type {Uint8Array} */ (saved[0]?.bytes), "saved-hls-chosen.mp4");
});

test("HLS: an error page or an empty body served with a 200 where a segment belongs is retried, never demuxed or appended", { skip: mediaSkip() }, async () => {
  for (const [kind, fixture] of /** @type {const} */ ([["ts", hlsTsFixture()], ["fmp4", hlsFmp4Fixture()]])) {
    const base = `https://proxy-07.dailymotion.com/sec(1)/${kind}`;
    const ext = kind === "ts" ? "ts" : "m4s";
    /** @type {Record<string, Handler>} */
    const routes = {};
    if (fixture.init !== null) routes[`${base}/init.mp4`] = servedFile(readFileSync(fixture.init));
    fixture.segments.forEach((segment, index) => {
      const file = servedFile(readFileSync(segment));
      // the middle segment: an error page the first time, an empty body the second, then itself
      routes[`${base}/seg${String(index).padStart(3, "0")}.${ext}`] =
        index !== 1
          ? file
          : (url, headers, count) =>
              count === 1
                ? { body: "<html><body>Service Unavailable</body></html>", headers: { "content-type": "text/html" } }
                : count === 2
                  ? { body: new Uint8Array(0), headers: { "content-length": "0" } }
                  : file(url, headers, count);
    });
    const net = network(routes);
    const { ctx, saved, sleeps } = context(net.fetch);
    const result = await download(hlsTarget(readFileSync(fixture.media, "utf8"), `${base}/media.m3u8`), ctx);
    assert.equal(result.status, "done", `${kind}: ${JSON.stringify(result.failure)}`);
    const middle = result.attempts.filter((attempt) => attempt.url.endsWith(`seg001.${ext}`));
    assert.deepEqual(middle.map((attempt) => attempt.outcome.split(":")[0]), ["refused", "refused", middle[2]?.outcome.split(":")[0]]);
    assert.match(String(middle[0]?.outcome), /not (MPEG-TS|MP4 boxes)/);
    assert.match(String(middle[1]?.outcome), /an empty body/);
    assert.deepEqual(sleeps.filter((seconds) => seconds >= 1), [1, 2], `${kind}: the retry back-off`);
    assertSameAsSource(/** @type {Uint8Array} */ (saved[0]?.bytes), `saved-hls-${kind}-retried.mp4`);
  }
  // an error page every time: the segment fails after its retries, nothing saved
  const hls = hlsTsFixture();
  const base = "https://proxy-07.dailymotion.com/sec(1)/broken";
  /** @type {Record<string, Handler>} */
  const routes = {};
  hls.segments.forEach((segment, index) => {
    routes[`${base}/seg${String(index).padStart(3, "0")}.ts`] =
      index === 1 ? () => ({ body: "<html>busy</html>", headers: { "content-type": "text/html" } }) : servedFile(readFileSync(segment));
  });
  const net = network(routes);
  const { ctx, saved } = context(net.fetch);
  const result = await download(hlsTarget(readFileSync(hls.media, "utf8"), `${base}/media.m3u8`), ctx);
  assert.deepEqual(result.failure, { code: "not_a_video", params: { content_type: "text/html (not MPEG-TS)" } });
  assert.equal(net.calls.filter((call) => call.url.endsWith("seg001.ts")).length, 4, "the request and its three retries");
  assert.equal(saved.length, 0);
});

test("HLS: a segment missing from the middle is a hole — verification fails although the duration matches", { skip: mediaSkip() }, async () => {
  const hls = hlsTsFixture();
  const base = "https://proxy-07.dailymotion.com/sec(1)/holed";
  /** @type {Record<string, Handler>} */
  const routes = {};
  hls.segments.forEach((segment, index) => {
    routes[`${base}/seg${String(index).padStart(3, "0")}.ts`] = servedFile(readFileSync(segment));
  });
  // a playlist that lacks its second segment: what a lost segment leaves in the track
  const lines = readFileSync(hls.media, "utf8").split("\n");
  const at = lines.findIndex((line) => line.startsWith("seg001.ts"));
  lines.splice(at - 1, 2);
  const net = network(routes);
  const { ctx, saved, root } = context(net.fetch);
  const result = await download(hlsTarget(lines.join("\n"), `${base}/media.m3u8`), ctx);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "verify_failed");
  assert.match(String(result.failure?.params["reason"]), /^video: 2\.\d s missing at 2\.\d s$/);
  assert.equal(saved.length, 0, "never saved as the video");
  assert.deepEqual(leftovers(root), []);
});

test("mediaGap: a step longer than four typical ones and half a second is a hole; after damage, 1.5 typical ones", () => {
  /** @param {number[]} dts @param {number} timescale @returns {import("../src/lib/mp4.js").TrackPlan} */
  const plan = (dts, timescale) => ({
    kind: "video",
    timescale,
    stsd: new Uint8Array(0),
    width: null,
    height: null,
    sampleRate: null,
    channelCount: null,
    language: "und",
    samples: dts.map((value) => ({ dts: value, cts: value, size: 1, sync: true, data: { file: "f", offset: 0 } })),
  });
  const steady = Array.from({ length: 50 }, (_v, index) => index * 3600); // 25 fps at 90 kHz
  assert.equal(mediaGap(plan(steady, 90000), false), null);
  assert.equal(mediaGap(plan(steady, 90000), true), null);
  // frames 0–19, then 70–99: two seconds (50 frames) lost after 0.8 s
  const holed = [...Array.from({ length: 20 }, (_v, index) => index * 3600), ...Array.from({ length: 30 }, (_v, index) => (70 + index) * 3600)];
  const gap = mediaGap(plan(holed, 90000), false);
  assert.ok(gap !== null);
  assert.equal(Math.round(gap.atS * 100) / 100, 0.8);
  assert.equal(Math.round(gap.missingS * 100) / 100, 2);
  // one lost frame: not a hole in a clean stream, a hole after the demuxer met damage
  const oneLost = [...steady.slice(0, 10), ...steady.slice(11)];
  assert.equal(mediaGap(plan(oneLost, 90000), false), null);
  assert.deepEqual(mediaGap(plan(oneLost, 90000), true), { atS: 0.4, missingS: 0.04 });
  // a low frame rate (1 fps): a 2 s step is not a hole, a 5 s one is
  assert.equal(mediaGap(plan([0, 1, 2, 3, 5, 6, 7].map((s) => s * 1000), 1000), false), null);
  assert.ok(mediaGap(plan([0, 1, 2, 3, 8, 9, 10].map((s) => s * 1000), 1000), false) !== null);
  assert.equal(mediaGap(plan([0, 1], 1000), false), null, "too short to tell");
});

test("segment checks: a TS packet, an MP4 box; anything else or nothing is not media", () => {
  const packet = new Uint8Array(188);
  packet[0] = 0x47;
  assert.equal(tsSegmentProblem(packet), null);
  assert.equal(tsSegmentProblem(new Uint8Array(0)), "an empty body");
  assert.equal(tsSegmentProblem(new TextEncoder().encode("<html><body>Service Unavailable</body></html>".repeat(5))), "not MPEG-TS");
  const styp = new Uint8Array([0, 0, 0, 16, 0x73, 0x74, 0x79, 0x70, 0x6d, 0x73, 0x64, 0x68, 0, 0, 0, 0, 0, 0]);
  assert.equal(mp4SegmentProblem(styp), null);
  assert.equal(mp4SegmentProblem(styp.slice(0, 12)), "not MP4 boxes", "a box longer than the body");
  assert.equal(mp4SegmentProblem(new TextEncoder().encode('{"error":"busy"}')), "not MP4 boxes");
  assert.equal(mp4SegmentProblem(new TextEncoder().encode("<html><body>x</body></html>")), "not MP4 boxes");
  assert.equal(mp4SegmentProblem(new Uint8Array(0)), "an empty body");
});

test("a full disk while the work files are written is save_failed, never a network failure", { skip: mediaSkip() }, async () => {
  const dash = dashFixture();
  const net = network({ [VIDEO_URL]: servedFile(readFileSync(dash.video)), [AUDIO_URL]: servedFile(readFileSync(dash.audio)) });
  const { ctx, saved, root } = context(net.fetch);
  const files = ctx.files;
  const open = files.appendWriter.bind(files);
  files.appendWriter = async (name) => {
    const writer = await open(name);
    return {
      name: writer.name,
      size: () => writer.size(),
      write: async () => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      },
      truncate: (size) => writer.truncate(size),
      close: () => writer.close(),
      abort: () => writer.abort(),
    };
  };
  const result = await download(dashTarget([VIDEO_URL], [AUDIO_URL]), ctx);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "save_failed");
  assert.match(String(result.failure?.params["reason"]), /^not enough free disk space \(.*quota.*\)$/i);
  assert.equal(saved.length, 0);
  assert.deepEqual(leftovers(root), []);
});

test("Stop ends the current request and the download is stopped; the work files go", { skip: mediaSkip() }, async () => {
  const dash = dashFixture();
  const controller = new AbortController();
  const net = network({
    [VIDEO_URL]: () => {
      controller.abort(new StopRequested("user"));
      return { never: true };
    },
  });
  const { ctx, root, saved } = context(net.fetch, { signal: controller.signal });
  const result = await download(dashTarget([VIDEO_URL], [AUDIO_URL]), ctx);
  assert.equal(result.status, "stopped");
  assert.deepEqual(result.failure, { code: "stopped", params: { reason: "user" } });
  assert.equal(saved.length, 0);
  assert.deepEqual(leftovers(root), []);
  assert.ok(dash.video.length > 0);
});

// ------------------------------------------------------------------- cover and title

test("cover and title helpers: the https twin, the reasons, the embedded title, the audio expected", async () => {
  assert.equal(coverUrl("http://i0.hdslb.com/bfs/archive/a.jpg", HOSTS), "https://i0.hdslb.com/bfs/archive/a.jpg");
  assert.equal(coverUrl("https://s1.dmcdn.net/v/x720", HOSTS), "https://s1.dmcdn.net/v/x720");
  assert.equal(coverUrl("http://127.0.0.1:8123/btv-cover/1.jpg", ["http://127.0.0.1/*"]), "http://127.0.0.1:8123/btv-cover/1.jpg");
  assert.equal(coverUrl("http://evil.example/a.jpg", HOSTS), "http://evil.example/a.jpg", "no twin: as given");
  /** @param {import("../src/lib/messages.js").Failure} fail */
  const reason = (fail) => coverFailureReason(new StepFailure(fail));
  assert.equal(reason({ code: "rate_limited", params: { detail: "HTTP 429 (cover)" } }), "HTTP 429");
  assert.equal(reason({ code: "http_status", params: { status: 404, what: "cover" } }), "HTTP 404");
  assert.match(reason({ code: "host_not_covered", params: { host: "evil.example" } }), /evil\.example, a host the extension has no permission for/);
  assert.equal(coverFailureReason(new Error("boom")), "boom");
  const dash = dashTarget([VIDEO_URL], [AUDIO_URL]);
  assert.equal(embeddedTitle(dash), "An invented clip");
  assert.equal(embeddedTitle({ ...dash, part: 2, partCount: 3, partTitle: "Second" }), "An invented clip — P02 Second");
  assert.equal(embeddedTitle({ ...dash, part: 2, partCount: 3, partTitle: null }), "An invented clip — P02");
  assert.equal(embeddedTitle({ ...dash, site: "bilibilitv", title: "Page title", partTitle: "E2 - Middle" }), "E2 - Middle");
  const streams = /** @type {import("../src/app/resolver.js").DashChoice} */ (dash.streams);
  assert.equal(audioExpected(streams), true);
  assert.equal(audioExpected({ ...streams, audio: null }), false);
  const hls = /** @type {import("../src/app/resolver.js").HlsChoice} */ (hlsTarget("#EXTM3U\n", "https://x.dailymotion.com/m.m3u8").streams);
  assert.equal(audioExpected(hls), true, "mp4a in the variant's CODECS");
  assert.equal(audioExpected({ ...hls, variant: { ...hls.variant, codecs: "avc1.64001f" } }), false);
  assert.equal(audioExpected({ ...hls, variant: { ...hls.variant, codecs: null } }), false);
});

test("audioExpected: every audio codec a site can name in CODECS is audio; video codecs alone are not", () => {
  const target = hlsTarget("#EXTM3U\n", "https://x.dailymotion.com/m.m3u8");
  const hls = /** @type {import("../src/app/resolver.js").HlsChoice} */ (target.streams);
  /** @param {string} codecs */
  const expected = (codecs) => audioExpected({ ...hls, variant: { ...hls.variant, codecs } });
  for (const codecs of [
    "avc1.640028,mp4a.40.2",
    "hvc1.1.6.L120.90,ec-3",
    "hev1.1.6.L120.90,ac-3",
    "av01.0.08M.08,Opus",
    "av01.0.08M.08,opus",
    "avc1.640028,fLaC",
    "hvc1.1.6.L120.90, flac",
    "mp4a.40.2,avc1.640028",
  ]) {
    assert.equal(expected(codecs), true, codecs);
  }
  for (const codecs of [
    "avc1.640028",
    "hvc1.1.6.L120.90",
    "hev1.1.6.L120.90",
    "av01.0.08M.08",
    "",
    "avc1.640028,stpp.ttml.im1t",
  ]) {
    assert.equal(expected(codecs), false, codecs);
  }
});

test("jpegFromImage: decoded, drawn at its own size, encoded as JPEG 0.92 by the browser's tools", async () => {
  /** @type {unknown[][]} */
  const calls = [];
  const tools = /** @type {import("../src/app/downloader.js").ImageTools} */ ({
    createImageBitmap: async (blob) => {
      calls.push(["decode", blob.type]);
      return { width: 64, height: 36, close: () => void calls.push(["close"]) };
    },
    OffscreenCanvas: class {
      /** @param {number} width @param {number} height */
      constructor(width, height) {
        calls.push(["canvas", width, height]);
      }
      getContext() {
        return { drawImage: (/** @type {unknown} */ _image, /** @type {number} */ x, /** @type {number} */ y) => void calls.push(["draw", x, y]) };
      }
      /** @param {{ type: string, quality: number }} options */
      async convertToBlob(options) {
        calls.push(["encode", options.type, options.quality]);
        return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]);
      }
    },
  });
  const jpeg = await jpegFromImage(new Blob(["RIFF"], { type: "image/webp" }), tools);
  assert.deepEqual([...jpeg], [0xff, 0xd8, 0xff, 0xe0]);
  assert.deepEqual(calls, [["decode", "image/webp"], ["canvas", 64, 36], ["draw", 0, 0], ["encode", "image/jpeg", 0.92], ["close"]]);
  await assert.rejects(jpegFromImage(new Blob(["x"]), null), /cannot convert images/);
});

const COVER_URL = "https://i0.hdslb.com/bfs/archive/cover.jpg";

/**
 * An image made by ffmpeg (a 64×36 red frame), once per name.
 * @param {"jpg" | "png"} ext
 * @returns {Uint8Array}
 */
function coverImage(ext) {
  const path = scratchPath(`cover-fixture.${ext}`);
  ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x36", "-frames:v", "1", "-f", "image2", path]);
  return readFileSync(path);
}

/**
 * What ffmpeg reads of a saved file's cover and title: its streams' codecs (`ffprobe`), its
 * `title` tag (`-f ffmetadata`) and the picture of its second video stream — the attached
 * picture — copied out as served.
 * @param {Uint8Array} bytes
 * @param {string} name
 * @returns {{ codecs: (string | null)[], title: string | null, picture: Uint8Array }}
 */
function probeCover(bytes, name) {
  const path = scratchPath(name);
  writeFileSync(path, bytes);
  const metadata = new TextDecoder().decode(ffmpeg(["-i", path, "-f", "ffmetadata", "-"]));
  const title = /^title=(.*)$/m.exec(metadata)?.[1] ?? null;
  const picture = ffmpeg(["-i", path, "-map", "0:v:1", "-c", "copy", "-frames:v", "1", "-f", "image2pipe", "-"]);
  return { codecs: ffprobe(path).streams.map((stream) => stream.codec_name), title, picture };
}

test(
  "DASH with a JPEG cover: one cover request after the media, embedded with the title; the frames unchanged",
  { skip: mediaSkip() },
  async () => {
    const dash = dashFixture();
    const jpeg = coverImage("jpg");
    const routes = {
      [VIDEO_URL]: servedFile(readFileSync(dash.video)),
      [AUDIO_URL]: servedFile(readFileSync(dash.audio)),
      [COVER_URL]: servedFile(jpeg, { type: "image/jpeg" }),
    };
    const net = network(routes);
    const { ctx, saved, sleeps } = context(net.fetch);
    const target = dashTarget([VIDEO_URL], [AUDIO_URL], { cover: COVER_URL.replace("https:", "http:") });
    const result = await download(target, ctx);
    assert.equal(result.status, "done", JSON.stringify(result.failure));
    assert.deepEqual(net.calls.map((call) => call.url), [VIDEO_URL, AUDIO_URL, COVER_URL], "the cover after the media, over https");
    assert.equal(sleeps.filter((seconds) => seconds === 0.2).length, 2, "a media pause before the audio and before the cover");
    assert.deepEqual(result.notes, []);
    assert.deepEqual(result.verify?.cover, { type: "jpeg", bytes: jpeg.length });
    assert.equal(result.verify?.title, "An invented clip");
    const bytes = /** @type {Uint8Array} */ (saved[0]?.bytes);
    const probed = await probe(bytes);
    assert.deepEqual([...(probed.cover?.bytes ?? [])], [...jpeg], "the JPEG as served");
    const seen = probeCover(bytes, "saved-cover.mp4");
    assert.deepEqual(seen.codecs, ["h264", "aac", "mjpeg"], "ffmpeg reads the cover as a picture stream");
    assert.equal(seen.title, "An invented clip");
    assert.deepEqual([...seen.picture], [...jpeg], "ffmpeg reads back the JPEG as served");
    // the same download without the cover: the same frames, no cover request
    const plain = network(routes);
    const without = context(plain.fetch);
    without.ctx.cover = "none";
    const bare = await download(dashTarget([VIDEO_URL], [AUDIO_URL], { cover: COVER_URL }), without.ctx);
    assert.equal(bare.status, "done");
    assert.deepEqual(plain.calls.map((call) => call.url), [VIDEO_URL, AUDIO_URL], "cover: none asks for no cover");
    assert.equal(bare.verify?.cover, null);
    assert.equal(bare.verify?.title, "An invented clip", "the title is embedded all the same");
    const barePath = scratchPath("saved-no-cover.mp4");
    writeFileSync(barePath, /** @type {Uint8Array} */ (without.saved[0]?.bytes));
    const coverPath = scratchPath("saved-cover.mp4");
    for (const stream of ["v:0", "a:0"]) {
      assert.deepEqual(framemd5(coverPath, { stream }), framemd5(barePath, { stream }), stream);
    }
    assert.deepEqual(framemd5(coverPath, { stream: "v:0" }), framemd5(sourceClip(), { stream: "v:0" }));
  },
);

test("a WebP cover is converted to JPEG; a PNG is embedded as served", { skip: mediaSkip() }, async () => {
  const dash = dashFixture();
  const jpeg = coverImage("jpg");
  const png = coverImage("png");
  const webp = new TextEncoder().encode("RIFF\x00\x00\x00\x00WEBPVP8 not really");
  const net = network({
    [VIDEO_URL]: servedFile(readFileSync(dash.video)),
    [AUDIO_URL]: servedFile(readFileSync(dash.audio)),
    [COVER_URL]: servedFile(webp, { type: "image/webp" }),
    [COVER_URL.replace(".jpg", ".png")]: servedFile(png, { type: "image/png" }),
  });
  /** @type {string[]} */
  const converted = [];
  const { ctx, saved } = context(net.fetch);
  ctx.toJpeg = async (image) => {
    converted.push(image.type);
    return jpeg;
  };
  const result = await download(dashTarget([VIDEO_URL], [AUDIO_URL], { cover: COVER_URL }), ctx);
  assert.equal(result.status, "done", JSON.stringify(result.failure));
  assert.deepEqual(converted, ["image/webp"]);
  assert.deepEqual(result.verify?.cover, { type: "jpeg", bytes: jpeg.length });
  assert.deepEqual([...((await probe(/** @type {Uint8Array} */ (saved[0]?.bytes))).cover?.bytes ?? [])], [...jpeg]);
  const second = await download(dashTarget([VIDEO_URL], [AUDIO_URL], { cover: COVER_URL.replace(".jpg", ".png") }), ctx);
  assert.equal(second.status, "done");
  assert.deepEqual(second.verify?.cover, { type: "png", bytes: png.length });
  assert.deepEqual(converted, ["image/webp"], "a PNG is never converted");
});

test("a cover that cannot be had leaves the video saved, the row saying why — never a stop", { skip: mediaSkip() }, async () => {
  const dash = dashFixture();
  const media = {
    [VIDEO_URL]: servedFile(readFileSync(dash.video)),
    [AUDIO_URL]: servedFile(readFileSync(dash.audio)),
  };
  for (const [reply, cover, reason, requests] of /** @type {const} */ ([
    [{ status: 429 }, COVER_URL, "HTTP 429", 3],
    [{ status: 403 }, COVER_URL, "HTTP 403", 3],
    [{ body: "<html>", headers: { "content-type": "text/html" } }, COVER_URL, "the image cannot be converted to JPEG here", 3],
    [{ status: 200 }, "https://evil.example/cover.jpg", "the image is on evil.example, a host the extension has no permission for", 2],
  ])) {
    const net = network({ ...media, [COVER_URL]: () => reply });
    const { ctx, saved } = context(net.fetch);
    const result = await download(dashTarget([VIDEO_URL], [AUDIO_URL], { cover }), ctx);
    assert.equal(result.status, "done", `${reason}: ${JSON.stringify(result.failure)}`);
    assert.deepEqual(result.notes, [{ code: "cover", params: { reason } }]);
    assert.equal(net.calls.length, requests, `${reason}: asked once, never retried`);
    assert.equal(result.verify?.cover, null);
    assert.equal(saved.length, 1);
  }
  const converter = network({ ...media, [COVER_URL]: () => ({ body: "GIF89a", headers: { "content-type": "image/gif" } }) });
  const failing = context(converter.fetch);
  failing.ctx.toJpeg = async () => {
    throw new Error("decode failed");
  };
  const result = await download(dashTarget([VIDEO_URL], [AUDIO_URL], { cover: COVER_URL }), failing.ctx);
  assert.equal(result.status, "done");
  assert.deepEqual(result.notes, [{ code: "cover", params: { reason: "image/gif could not be converted to JPEG (decode failed)" } }]);
});

test("B.4: a file the MP4 reader refuses is remux_failed; announced audio that never came fails the file", { skip: mediaSkip() }, async () => {
  const dash = dashFixture();
  const html = network({ [VIDEO_URL]: () => ({ body: "<html>not a video</html>", headers: { "content-type": "text/html" } }) });
  const { ctx, saved, root } = context(html.fetch);
  const result = await download(dashTarget([VIDEO_URL], null), ctx);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "remux_failed");
  assert.equal(saved.length, 0);
  assert.deepEqual(leftovers(root), []);
  const mute = network({
    [VIDEO_URL]: servedFile(readFileSync(dash.video)),
    [AUDIO_URL]: servedFile(readFileSync(dash.video)), // the "audio" file holds video only
  });
  const second = context(mute.fetch);
  const failed = await download(dashTarget([VIDEO_URL], [AUDIO_URL]), second.ctx);
  assert.equal(failed.failure?.code, "remux_failed");
  assert.match(String(failed.failure?.params["reason"]), /announced audio but carried no audio sample/);
  assert.equal(second.saved.length, 0);
});

test("Bilibili.tv: progressive video and audio files (moov after mdat) download, verify and carry the Bilibili.tv Referer", { skip: mediaSkip() }, async () => {
  const source = sourceClip();
  const videoPath = scratchPath("btv-progressive-video.mp4");
  const audioPath = scratchPath("btv-progressive-audio.mp4");
  ffmpeg(["-i", source, "-an", "-c:v", "copy", "-f", "mp4", videoPath]);
  ffmpeg(["-i", source, "-vn", "-c:a", "copy", "-f", "mp4", audioPath]);
  const cdn = "https://upos-bstar1-mirrorakam.akamaized.net/iupxcodeboss";
  const net = network({
    [`${cdn}/80.mp4`]: servedFile(readFileSync(videoPath)),
    [`${cdn}/audio-30280.mp4`]: servedFile(readFileSync(audioPath)),
  });
  const { ctx, saved, referers } = context(net.fetch);
  const target = {
    ...dashTarget([`${cdn}/80.mp4?e=1`], [`${cdn}/audio-30280.mp4?e=1`]),
    key: "bilibilitv:video:4801520000000001",
    site: /** @type {const} */ ("bilibilitv"),
    id: "4801520000000001",
    partCount: null,
    cid: null,
    title: "An invented Bstation clip",
    pageUrl: "https://www.bilibili.tv/en/video/4801520000000001",
  };
  const result = await download(target, ctx);
  assert.equal(result.status, "done", JSON.stringify(result.failure));
  assert.deepEqual(referers, ["bilibilitv"]);
  assert.equal(saved[0]?.filename, "StreamFetch/Bilibili.tv/An invented Bstation clip [4801520000000001].mp4");
  const path = scratchPath("saved-btv-progressive.mp4");
  writeFileSync(path, /** @type {Uint8Array} */ (saved[0]?.bytes));
  assert.deepEqual(framemd5(path, { stream: "v:0" }), framemd5(source, { stream: "v:0" }), "video frames");
  // a progressive source keeps its AAC priming edit: the audio frames are the source's own
  assert.deepEqual(framemd5(path, { stream: "a:0" }), framemd5(source, { stream: "a:0" }), "audio frames");
});
