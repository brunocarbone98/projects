// @ts-check
// app/app.js: its pure helpers (durations, sizes, the quality selector's options, the summary, the
// history), the cover loader (only rows in view, one at a time, never during a job), and the page
// itself over a fake document, a fake `chrome` and a fake network: Analyze fills the rows, Download
// all moves what did not download to the failed block and saves the report, Retry runs exactly
// those inputs again, a cooldown refuses a start, a second tab is read-only, the settings refuse
// lighter pauses and switch the language.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CoverLoader,
  ENGINE_LOCK,
  formatBytes,
  formatDuration,
  fourcc,
  historyEntry,
  historyLine,
  notDownloaded,
  parseHistoryEntry,
  progressFraction,
  progressText,
  qualityLabel,
  qualityOptions,
  retryInputs,
  rowMessage,
  rowTitle,
  siteName,
  streamLabel,
  summaryCounts,
} from "../src/app/app.js";
import { StepFailure } from "../src/app/downloader.js";
import { setCatalogs, setLanguage } from "../src/app/i18n.js";
import { makeCooldown } from "../src/lib/cooldown.js";
import { failure, hintText } from "../src/lib/messages.js";

/**
 * @typedef {import("../src/app/resolver.js").StreamChoice} StreamChoice
 * @typedef {import("../src/app/engine.js").Run} Run
 * @typedef {import("../src/app/engine.js").Row} Row
 */

// ------------------------------------------------------------------------------ helpers

test("durations, sizes and the progress text", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(65.4), "1:05");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(Number.NaN), "—");
  assert.equal(formatBytes(12_345_678), "12.3 MB");
  assert.equal(progressText({ received: 12_300_000, total: null, segments: null, bytesPerS: 1_234_567 }), "12.3 MB · 1.2 MB/s");
  assert.equal(progressFraction({ received: 5, total: 10, segments: null, bytesPerS: 0 }), 0.5);
  assert.equal(progressFraction({ received: 5, total: null, segments: { done: 1, total: 4 }, bytesPerS: 0 }), 0.25);
  assert.equal(progressFraction({ received: 5, total: null, segments: null, bytesPerS: 0 }), null);
});

test("site names, codecs and the quality selector's options, the premium ones disabled", () => {
  assert.deepEqual(["dailymotion", "bilibilitv", "bilibili"].map(siteName), ["Dailymotion", "Bilibili.tv", "Bilibili"]);
  assert.equal(fourcc("avc1.640028,mp4a.40.2"), "avc1");
  assert.equal(fourcc("mp4a.40.2,hvc1.1.6.L120"), "hvc1");
  assert.equal(fourcc(null), "?");
  assert.equal(streamLabel({ height: 1080, width: 1920, codecs: "avc1.640032", bandwidth: 2_345_678 }), "1080p · avc1 · 2.3 Mbit/s");
  assert.equal(streamLabel({ height: 1920, width: 1080, codecs: "hev1.1", bandwidth: 0 }), "1080p · hev1", "a portrait video's height is its short side");
  /** @param {number} id @param {number} height @param {string} codecs */
  const rep = (id, height, codecs) => ({ id, codecs, codecFamily: /** @type {"avc"} */ ("avc"), bandwidth: height * 1000, width: null, height, frameRate: null, urls: ["u"], mimeType: null, size: null, label: null });
  const chosen = rep(64, 720, "avc1.640028");
  /** @type {StreamChoice} */
  const dash = { kind: "dash", video: chosen, audio: null, available: [rep(80, 1080, "hev1.1"), chosen], audioAvailable: [], missingPremium: ["1080P60"] };
  assert.deepEqual(qualityOptions(dash, (label) => `${label} — premium only`), [
    { value: "0", label: "1080p · hev1 · 1.1 Mbit/s", selected: false, disabled: false },
    { value: "1", label: "720p · avc1 · 0.7 Mbit/s", selected: true, disabled: false },
    { value: "", label: "1080P60 — premium only", selected: false, disabled: true },
  ]);
  assert.equal(qualityLabel(dash), "720p avc1");
  const variant = { url: "u", bandwidth: 5_000_000, width: 1920, height: 1080, frameRate: 25, codecs: "avc1.640028,mp4a.40.2", name: "1080", audioGroup: null };
  /** @type {StreamChoice} */
  const hls = { kind: "hls", master: "m", variant, audio: null, available: [variant], audioRenditions: [] };
  assert.deepEqual(qualityOptions(hls, String), [{ value: "0", label: "1080p · avc1 · 5.0 Mbit/s", selected: true, disabled: false }]);
  assert.equal(qualityLabel(null), "");
});

test("the summary counts, the rows a retry runs again and the history entry", () => {
  assert.deepEqual(
    summaryCounts([
      { status: "done", detected: true },
      { status: "queued", detected: true },
      { status: "failed-unavailable", detected: false },
      { status: "stopped", detected: false },
    ]),
    { videos: 4, detected: 2, failed: 1 },
  );
  /** @param {string} input @param {string} status @returns {Row} */
  const row = (input, status) => ({ key: input + status, itemKey: input, input, site: "dailymotion", id: "x", part: null, title: null, status, failure: null, attempts: [], streams: null, page: null, raw: null, seasonId: null, episodeId: null, path: null, notes: [], verify: null });
  /** @type {Run} */
  const run = {
    startedAt: new Date("2026-11-08T10:00:00Z"),
    finishedAt: new Date("2026-11-08T10:05:00Z"),
    stopReason: null,
    settings: null,
    rows: [row("a", "done"), row("b", "failed"), row("b", "stopped"), row("c", "skipped-exists"), row("d", "failed-unavailable")],
  };
  assert.deepEqual(notDownloaded(run).map((one) => one.status), ["failed", "stopped", "failed-unavailable"]);
  assert.deepEqual(retryInputs(notDownloaded(run)), ["b", "d"]);
  const entry = historyEntry(run);
  assert.deepEqual(entry, {
    started_at: "2026-11-08T10:00:00.000Z",
    finished_at: "2026-11-08T10:05:00.000Z",
    stop_reason: null,
    counts: { rows: 5, done: 1, skipped: 1, failed: 2, stopped: 1 },
    retry_inputs: ["b", "d"],
  });
  assert.deepEqual(parseHistoryEntry(JSON.parse(JSON.stringify(entry))), entry);
  assert.equal(parseHistoryEntry({ junk: true }), null);
});

test("covers: only rows in view, one request at a time, never while not allowed, never twice", async () => {
  /** @type {((entries: readonly { target: Element, isIntersecting: boolean }[]) => void) | null} */
  let callback = null;
  /** @type {string[]} */
  const fetched = [];
  let allowed = true;
  let inFlight = 0;
  let most = 0;
  const loader = new CoverLoader({
    allowed: () => allowed,
    fetchCover: async (url) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      fetched.push(url);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return url.includes("broken") ? null : new Blob(["img"]);
    },
    pause: async () => undefined,
    objectUrl: () => "blob:cover",
    watcher: (handler) => {
      callback = handler;
      return { observe: () => undefined, unobserve: () => undefined };
    },
  });
  /** @returns {HTMLImageElement} */
  const image = () => /** @type {HTMLImageElement} */ (/** @type {unknown} */ ({ src: "", className: "cover placeholder" }));
  const a = image();
  const b = image();
  const c = image();
  loader.watch(a, "a", "https://s1.dmcdn.net/a.jpg");
  loader.watch(b, "b", "https://i0.hdslb.com/broken.jpg");
  loader.watch(c, "c", "https://pic.bstarstatic.com/c.jpg");
  assert.deepEqual(fetched, [], "nothing before a row is in view");
  const show = /** @type {(entries: readonly { target: Element, isIntersecting: boolean }[]) => void} */ (/** @type {unknown} */ (callback));
  allowed = false;
  show([{ target: /** @type {Element} */ (/** @type {unknown} */ (a)), isIntersecting: true }]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(fetched, [], "nothing during a job or a cooldown");
  allowed = true;
  show([
    { target: /** @type {Element} */ (/** @type {unknown} */ (b)), isIntersecting: true },
    { target: /** @type {Element} */ (/** @type {unknown} */ (c)), isIntersecting: false },
  ]);
  while (loader.running !== null) await loader.running;
  assert.deepEqual(fetched, ["https://s1.dmcdn.net/a.jpg", "https://i0.hdslb.com/broken.jpg"]);
  assert.equal(most, 1, "one request at a time");
  assert.equal(a.src, "blob:cover");
  assert.equal(a.className, "cover");
  assert.equal(b.className, "cover placeholder", "a broken cover keeps the neutral frame");
  show([{ target: /** @type {Element} */ (/** @type {unknown} */ (a)), isIntersecting: true }]);
  while (loader.running !== null) await loader.running;
  assert.equal(fetched.length, 2, "never twice");
  const again = image();
  loader.watch(again, "a", "https://s1.dmcdn.net/a.jpg");
  assert.equal(again.src, "blob:cover", "a cover already fetched is shown at once");
});

test("covers: a 429 or 412 on a thumbnail stops the loader for the page's life and reports the refusal", async () => {
  /** @type {((entries: readonly { target: Element, isIntersecting: boolean }[]) => void) | null} */
  let callback = null;
  /** @type {string[]} */
  const fetched = [];
  /** @type {[import("../src/lib/messages.js").Failure, string][]} */
  const refused = [];
  const loader = new CoverLoader({
    allowed: () => true,
    fetchCover: async (url) => {
      fetched.push(url);
      if (url.includes("limited")) throw new StepFailure(failure("rate_limited", { detail: "HTTP 429 (cover)" }));
      if (url.includes("gone")) throw new StepFailure(failure("http_status", { status: 404, what: "cover" }));
      return new Blob(["img"]);
    },
    pause: async () => undefined,
    objectUrl: () => "blob:cover",
    onRefused: (fail, key) => void refused.push([fail, key]),
    watcher: (handler) => {
      callback = handler;
      return { observe: () => undefined, unobserve: () => undefined };
    },
  });
  /** @returns {HTMLImageElement} */
  const image = () => /** @type {HTMLImageElement} */ (/** @type {unknown} */ ({ src: "", className: "cover placeholder" }));
  const cells = [image(), image(), image(), image()];
  const urls = ["https://pic.bstarstatic.com/gone.jpg", "https://pic.bstarstatic.com/limited.jpg", "https://pic.bstarstatic.com/c.jpg", "https://pic.bstarstatic.com/d.jpg"];
  cells.forEach((cell, index) => loader.watch(cell, `bilibilitv:episode:${index + 1}`, /** @type {string} */ (urls[index])));
  const show = /** @type {(entries: readonly { target: Element, isIntersecting: boolean }[]) => void} */ (/** @type {unknown} */ (callback));
  show(cells.map((cell) => ({ target: /** @type {Element} */ (/** @type {unknown} */ (cell)), isIntersecting: true })));
  while (loader.running !== null) await loader.running;
  assert.deepEqual(fetched, urls.slice(0, 2), "a 404 is a broken cover; the 429 stops every later request");
  assert.equal(loader.halted, true);
  assert.deepEqual(refused, [[{ code: "rate_limited", params: { detail: "HTTP 429 (cover)" } }, "bilibilitv:episode:2"]]);
  show([{ target: /** @type {Element} */ (/** @type {unknown} */ (cells[3])), isIntersecting: true }]);
  loader.resume();
  while (loader.running !== null) await loader.running;
  assert.equal(fetched.length, 2, "nothing more for the page's life");
  assert.ok(cells.every((cell) => cell.className === "cover placeholder"));
});

test("covers: Clear lets go of the rows still watched; a forgotten row asks for nothing, a fetched cover is still never asked for twice", async () => {
  /** @type {((entries: readonly { target: Element, isIntersecting: boolean }[]) => void) | null} */
  let callback = null;
  /** @type {unknown[]} */
  const unobserved = [];
  /** @type {string[]} */
  const fetched = [];
  const loader = new CoverLoader({
    allowed: () => true,
    fetchCover: async (url) => {
      fetched.push(url);
      return new Blob(["img"]);
    },
    pause: async () => undefined,
    objectUrl: () => "blob:cover",
    watcher: (handler) => {
      callback = handler;
      return { observe: () => undefined, unobserve: (target) => void unobserved.push(target) };
    },
  });
  /** @returns {HTMLImageElement} */
  const image = () => /** @type {HTMLImageElement} */ (/** @type {unknown} */ ({ src: "", className: "cover placeholder" }));
  const seen = image();
  const never = [image(), image(), image()];
  loader.watch(seen, "a", "https://s1.dmcdn.net/a.jpg");
  never.forEach((cell, index) => loader.watch(cell, `n${index}`, `https://s1.dmcdn.net/n${index}.jpg`));
  const show = /** @type {(entries: readonly { target: Element, isIntersecting: boolean }[]) => void} */ (/** @type {unknown} */ (callback));
  show([{ target: /** @type {Element} */ (/** @type {unknown} */ (seen)), isIntersecting: true }]);
  while (loader.running !== null) await loader.running;
  assert.deepEqual(fetched, ["https://s1.dmcdn.net/a.jpg"]);
  assert.equal(loader.cells.size, 3, "the rows never in view are still watched (a fetched one is let go at once)");
  loader.forget();
  assert.equal(loader.cells.size, 0);
  assert.equal(loader.visible.size, 0);
  assert.deepEqual(loader.queue, []);
  assert.deepEqual(unobserved.slice(-3), never, "no row is observed any more");
  show([{ target: /** @type {Element} */ (/** @type {unknown} */ (never[0])), isIntersecting: true }]);
  while (loader.running !== null) await loader.running;
  assert.equal(fetched.length, 1, "a forgotten row asks for nothing");
  const again = image();
  loader.watch(again, "a", "https://s1.dmcdn.net/a.jpg");
  assert.equal(again.src, "blob:cover", "a cover already fetched is shown at once, never asked for twice");
  const later = image();
  loader.watch(later, "n0", "https://s1.dmcdn.net/n0.jpg"); // a row pasted again after Clear is watched again
  show([{ target: /** @type {Element} */ (/** @type {unknown} */ (later)), isIntersecting: true }]);
  while (loader.running !== null) await loader.running;
  assert.deepEqual(fetched, ["https://s1.dmcdn.net/a.jpg", "https://s1.dmcdn.net/n0.jpg"]);
});

test("the history keeps canonical links, never a share link's parameters", () => {
  assert.equal(
    historyLine("https://www.bilibili.com/video/BV1aa411x7h7/?vd_source=0123abcd&buvid=XY-ab12&mid=42&share_source=copy_web"),
    "https://www.bilibili.com/video/BV1aa411x7h7",
  );
  assert.equal(historyLine("https://m.bilibili.com/video/BV1aa411x7h7?p=2&spm_id_from=333.1&unique_k=abc"), "https://www.bilibili.com/video/BV1aa411x7h7?p=2");
  assert.equal(historyLine("https://b23.tv/AbCdEf1?share_medium=android&share_tag=s_i"), "https://b23.tv/AbCdEf1");
  assert.equal(historyLine("https://www.bilibili.tv/es/video/4801520000000001?bstar_from=bstar-web.ugc-video-detail.related-recommend.all"), "https://www.bilibili.tv/en/video/4801520000000001");
  assert.equal(historyLine("https://www.dailymotion.com/video/xbq9z2k?playlist=x6hynp"), "https://www.dailymotion.com/video/xbq9z2k");
  assert.equal(historyLine("https://dai.ly/xbq9z2k?t=10"), "https://www.dailymotion.com/video/xbq9z2k");
  assert.equal(historyLine("not a link"), "not a link");
  /** @param {string} input @returns {Row} */
  const row = (input) => ({ key: input, itemKey: input, input, site: "bilibili", id: "x", part: null, title: null, status: "failed-unavailable", failure: null, attempts: [], streams: null, page: null, raw: null, seasonId: null, episodeId: null, path: null, notes: [], verify: null });
  const entry = historyEntry({
    startedAt: new Date("2026-11-08T10:00:00Z"),
    finishedAt: null,
    stopReason: null,
    settings: null,
    rows: [row("https://www.bilibili.com/video/BV1aa411x7h7/?vd_source=0123abcd&buvid=XY-ab12"), row("bilibili.com/video/BV1aa411x7h7?mid=7")],
  });
  assert.deepEqual(entry.retry_inputs, ["https://www.bilibili.com/video/BV1aa411x7h7"], "once each, canonical");
  assert.doesNotMatch(JSON.stringify(entry), /vd_source|buvid|mid=/);
});

test("a row's message: failure, hints, notes, where it was saved, and `; cover: <reason>` last", () => {
  /** @param {string} lang @returns {import("../src/app/i18n.js").Catalog} */
  const catalog = (lang) => JSON.parse(readFileSync(new URL(`../_locales/${lang}/messages.json`, import.meta.url), "utf8"));
  setCatalogs({ en: catalog("en"), es: catalog("es") });
  setLanguage("en");
  /** @type {Parameters<typeof rowMessage>[0]} */
  const done = {
    failure: null,
    site: "dailymotion",
    hints: [{ code: "playlist_ignored", params: {} }],
    notes: [{ code: "cover", params: { reason: "HTTP 429" } }, { code: "no_audio", params: {} }],
    path: "C:\\Users\\me\\Downloads\\StreamFetch\\Dailymotion\\A [xbq9z2k].mp4",
    status: "done",
  };
  assert.equal(
    rowMessage(done),
    "playlist ignored: only this video is downloaded · no audio in the source · saved as A [xbq9z2k].mp4; cover: HTTP 429",
  );
  const premium = { ...done, hints: [{ code: "premium", params: { labels: ["1080P60", "4K"] } }], notes: [] };
  assert.equal(rowMessage(premium).split(" · ")[0], hintText("premium", { labels: ["1080P60", "4K"] }));
  /** @type {Parameters<typeof rowMessage>[0]} */
  const login = { failure: { code: "login_required", params: {} }, site: "bilibilitv", hints: [], notes: [], path: null, status: "failed-unavailable" };
  assert.match(rowMessage(login), /log in to Bilibili\.tv in this browser; a premium episode stays unavailable$/);
  assert.doesNotMatch(rowMessage({ ...login, site: "bilibili" }), /premium/, "the login-or-premium hint is Bilibili.tv's");
  /** @type {Parameters<typeof rowMessage>[0]} */
  const gone = {
    failure: { code: "deleted", params: { site_message: "Dailymotion says: Video not found — The video was removed" } },
    site: "dailymotion",
    hints: [],
    notes: [],
    path: null,
    status: "failed-unavailable",
  };
  assert.equal(
    rowMessage(gone),
    "the video is gone or not available to this session (Dailymotion says: Video not found — The video was removed)",
  );
  /** @param {string} reason @returns {Parameters<typeof rowMessage>[0]} */
  const unverified = (reason) => ({ failure: { code: "verify_failed", params: { reason } }, site: "dailymotion", hints: [], notes: [], path: null, status: "failed" });
  assert.equal(rowMessage(unverified("audio track 1.2 s, the video's 6.0 s")), "the finished file failed verification (audio track 1.2 s, the video's 6.0 s); it was not saved");
  setLanguage("es");
  // the downloader's verification reasons in Spanish too, the numbers and the demuxer's own words as written
  assert.equal(rowMessage(unverified("duration 41.0 s, expected 60.0 s")), "el archivo terminado no pasó la verificación (duración 41.0 s; se esperaban 60.0 s); no se guardó");
  assert.match(rowMessage(unverified("audio track 1.2 s, the video's 6.0 s")), /\(pista de audio de 1\.2 s; la de video dura 6\.0 s\)/);
  assert.match(rowMessage(unverified("video track 3.0 s, expected 6.0 s")), /\(pista de video de 3\.0 s; se esperaban 6\.0 s\)/);
  assert.match(
    rowMessage(unverified("video: 2.0 s missing at 2.0 s; the MPEG-TS stream was damaged: lost MPEG-TS packet sync at byte 9")),
    /\(video: faltan 2\.0 s a partir de los 2\.0 s; la transmisión MPEG-TS llegó dañada: lost MPEG-TS packet sync at byte 9\)/,
  );
  assert.match(rowMessage(done), /; portada: HTTP 429$/);
  assert.match(rowMessage(done), /^lista ignorada/);
  assert.match(rowMessage(login), /inicia sesión en Bilibili\.tv/);
  assert.equal(
    rowMessage(gone),
    "el video ya no existe o no está disponible para esta sesión (Dailymotion dice: Video not found — The video was removed)",
    "the prefix in Spanish, the site's own words as it wrote them",
  );
  setLanguage("en");
});

test("a row's title: a Bilibili.tv episode's own title, a Bilibili part's P<nn>, else the video's", () => {
  assert.equal(rowTitle({ site: "bilibilitv", id: "13000002", title: "Fake Bstation Series", part: 2, partTitle: "E2 - The fake middle" }), "E2 - The fake middle");
  assert.equal(rowTitle({ site: "bilibilitv", id: "4801520000000001", title: "A clip", part: null, partTitle: null }), "A clip");
  assert.equal(rowTitle({ site: "bilibili", id: "BV1", title: "Anthology", part: 2, partTitle: "Second half" }), "P02 · Second half — Anthology");
  assert.equal(rowTitle({ site: "dailymotion", id: "xbq9z2k", title: "", part: null, partTitle: null }), "xbq9z2k");
});

// ---------------------------------------------------------------------------- the page

/**
 * One element of app.html, as far as app.js reads or writes it.
 */
class FakeElement {
  /** @param {string} tag */
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = "";
    this.title = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.selected = false;
    this.value = "";
    this.lang = "";
    this.text = "";
    this.href = "";
    this.target = "";
    this.src = "";
    /** @type {Record<string, string | undefined>} */
    this.dataset = {};
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {FakeElement[]} */
    this.children = [];
    /** @type {Map<string, ((event: unknown) => unknown)[]>} */
    this.listeners = new Map();
  }
  /** @returns {string} its own text and its children's */
  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  /** @param {string | null} value */
  set textContent(value) {
    this.text = value ?? "";
    this.children = [];
  }
  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  /** @param {string} name @returns {string | null} */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  /** @param {string} name */
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  /** @param {...(FakeElement | string)} nodes */
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeElement) this.children.push(node);
      else {
        const text = new FakeElement("#text");
        text.text = node;
        this.children.push(text);
      }
    }
  }
  /** @param {...(FakeElement | string)} nodes */
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  /**
   * The first descendant with this tag name (a plain tag selector); a `tbody` is created on
   * first use, as the page's tables have one.
   * @param {string} selector
   * @returns {FakeElement | null}
   */
  querySelector(selector) {
    const found = this.all().find((element) => element.tagName === selector.toUpperCase());
    if (found !== undefined) return found;
    if (selector === "tbody") {
      const body = new FakeElement("tbody");
      this.children.push(body);
      return body;
    }
    return null;
  }
  /** @returns {FakeElement[]} every descendant, depth first */
  all() {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  /** @returns {FakeElement[]} */
  querySelectorAll() {
    return [];
  }
  /** @param {string} type @param {(event: unknown) => unknown} listener */
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  /** @param {string} type */
  fire(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault: () => undefined });
  }
}

/** @typedef {import("../src/app/i18n.js").Catalog} Catalog */

const ROOT = "chrome-extension://streamfetch-test-id/";
/** @type {Record<string, unknown>} */
const MANIFEST = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const REAL_FETCH = globalThis.fetch;
let pages = 0;

/**
 * @typedef {object} PageOptions
 * @property {Record<string, unknown>} [storage] chrome.storage.local
 * @property {boolean} [lockTaken] another tab holds the engine
 * @property {(url: string) => { status?: number, body?: string, headers?: Record<string, string> } | undefined} [site]
 * @property {string[]} [existing] files Chrome already has, relative to Downloads
 * @property {string} [uiLanguage] chrome.i18n.getUILanguage()
 * @property {boolean} [production] the shipped manifest (no test mode: the pacing floors hold)
 */

/**
 * app.js loaded over a fake document, a fake `chrome` (test mode, no pauses) and a fake network
 * (`options.site`): a fresh instance each time, awaited until it is idle.
 * @param {PageOptions} [options]
 */
async function fakePage(options = {}) {
  /** @type {Map<string, FakeElement>} */
  const elements = new Map();
  /** @param {string} id @returns {FakeElement} */
  const element = (id) => {
    let found = elements.get(id);
    if (found === undefined) {
      found = new FakeElement("div");
      elements.set(id, found);
    }
    return found;
  };
  /** @type {Map<string, unknown>} */
  const local = new Map(
    Object.entries({
      testSettings: { videoPauseS: [0, 0], pagePauseS: [0, 0], mediaPauseMs: [0, 0], existenceRateLimitS: 0 },
      ...(options.storage ?? {}),
    }),
  );
  /** @type {((changes: Record<string, unknown>, area: string) => void)[]} */
  const changeListeners = [];
  /** @type {{ filename: string, text: string }[]} */
  const saved = [];
  /** @type {string[]} */
  const requests = [];
  /** @type {Catalog} */
  const en = JSON.parse(readFileSync(new URL("../_locales/en/messages.json", import.meta.url), "utf8"));
  const chrome = {
    runtime: {
      id: "streamfetch-test-id",
      getManifest: () => (options.production ? { ...MANIFEST } : { ...MANIFEST, streamfetch_test: true }),
      getURL: (/** @type {string} */ path) => `${ROOT}${path}`,
      onMessage: { addListener: () => undefined },
    },
    i18n: {
      getUILanguage: () => options.uiLanguage ?? "en-US",
      /** @param {string} key */
      getMessage: (key) => en[key]?.message ?? "",
    },
    storage: {
      local: {
        /** @param {string | string[]} keys */
        get: async (keys) => {
          /** @type {Record<string, unknown>} */
          const found = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) if (local.has(key)) found[key] = structuredClone(local.get(key));
          return found;
        },
        /** @param {Record<string, unknown>} items */
        set: async (items) => {
          for (const [key, value] of Object.entries(items)) local.set(key, structuredClone(value));
        },
        /** @param {string | string[]} keys */
        remove: async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) local.delete(key);
        },
      },
      onChanged: {
        /** @param {(changes: Record<string, unknown>, area: string) => void} listener */
        addListener: (listener) => void changeListeners.push(listener),
      },
    },
    downloads: {
      /** @param {{ url: string, filename: string }} request */
      download: async (request) => {
        saved.push({ filename: request.filename, text: await (await REAL_FETCH(request.url)).text() });
        return 1000 + saved.length;
      },
      /** @param {{ id?: number, filenameRegex?: string }} query */
      search: async (query) => {
        if (query.id !== undefined) {
          const file = saved[query.id - 1001];
          return file === undefined ? [] : [{ id: query.id, url: "", filename: `/home/me/Downloads/${file.filename}`, state: "complete", exists: true, bytesReceived: 1, totalBytes: 1 }];
        }
        if (query.filenameRegex === undefined) return [];
        const regex = new RegExp(query.filenameRegex);
        return (options.existing ?? [])
          .map((path, index) => ({ id: index + 1, url: "", filename: `/home/me/Downloads/${path}`, state: "complete", exists: true, bytesReceived: 1, totalBytes: 1 }))
          .filter((item) => regex.test(item.filename));
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    declarativeNetRequest: { updateSessionRules: async () => undefined },
  };
  /** @type {typeof fetch} */
  const fakeFetch = async (input) => {
    const url = String(input);
    if (url.startsWith(ROOT)) {
      const file = /** @type {Uint8Array<ArrayBuffer>} */ (readFileSync(new URL(`../${url.slice(ROOT.length)}`, import.meta.url)));
      return new Response(file);
    }
    requests.push(url);
    const reply = options.site?.(url);
    if (reply === undefined) return new Response("not found", { status: 404 });
    const response = new Response(reply.body ?? "", { status: reply.status ?? 200, headers: reply.headers ?? {} });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  const document = {
    documentElement: new FakeElement("html"),
    getElementById: element,
    querySelectorAll: () => [],
    /** @param {string} tag */
    createElement: (tag) => new FakeElement(tag),
  };
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const setIntervalBefore = globalThis.setInterval;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "FakeChrome/1",
      locks: {
        /** @param {string} name @param {object} _options @param {(lock: { name: string } | null) => unknown} callback */
        request: (name, _options, callback) => {
          assert.equal(name, ENGINE_LOCK);
          return Promise.resolve(callback(options.lockTaken ? null : { name }));
        },
      },
      storage: {
        getDirectory: async () => new FakeDir(),
        estimate: async () => ({ quota: 1e9, usage: 0 }),
      },
    },
  });
  Object.assign(globalThis, {
    document,
    chrome,
    fetch: fakeFetch,
    location: { search: "", pathname: "/src/app/app.html" },
    history: { replaceState: () => undefined },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    setInterval: () => 0,
  });
  const restore = () => {
    for (const name of ["document", "chrome", "location", "history", "IntersectionObserver"]) Reflect.deleteProperty(globalThis, name);
    Object.assign(globalThis, { setInterval: setIntervalBefore, fetch: REAL_FETCH });
    if (navigatorBefore !== undefined) Object.defineProperty(globalThis, "navigator", navigatorBefore);
  };
  /** @param {() => boolean} done @param {string} what */
  const until = async (done, what) => {
    for (let turn = 0; turn < 2000 && !done(); turn += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(done(), `timed out waiting for ${what}`);
  };
  try {
    const url = new URL("../src/app/app.js", import.meta.url);
    url.search = `?page=${(pages += 1)}`;
    await import(url.href);
    await until(() => element("app-status").dataset["state"] === "idle" || element("app-status").dataset["state"] === "readonly", "the page to load");
  } catch (error) {
    restore();
    throw error;
  }
  /** @returns {FakeElement[]} the rows of the items table */
  const rows = () => (element("items-table").querySelector("tbody")?.children ?? []);
  return { element, rows, local, saved, requests, until, restore, changed: (/** @type {string} */ key) => changeListeners.forEach((listener) => listener({ [key]: {} }, "local")) };
}

/** A minimal in-memory OPFS root for the page. */
class FakeDir {
  constructor() {
    /** @type {"directory"} */
    this.kind = "directory";
    /** @type {Map<string, FakeDir>} */
    this.dirs = new Map();
  }
  /** @param {string} name @returns {Promise<FakeDir>} */
  async getDirectoryHandle(name) {
    const dir = this.dirs.get(name) ?? new FakeDir();
    this.dirs.set(name, dir);
    return dir;
  }
  /** @returns {Promise<never>} */
  async getFileHandle() {
    throw new Error("no file in this test");
  }
  async removeEntry() {}
  /** @returns {AsyncIterable<[string, FakeDir]>} */
  entries() {
    return (async function* () {})();
  }
}

const OK_ID = "xbq9z2k";
const GEO_ID = "xgeo001";
const MASTER = `https://www.dailymotion.com/cdn/manifest/video/${OK_ID}.m3u8?sec=1`;
const MEDIA = `https://proxy-01.dailymotion.com/sec(1)/${OK_ID}/media.m3u8`;

/**
 * The fake Dailymotion of the page tests: one playable video, one geo-blocked.
 * @param {string} url
 * @returns {{ status?: number, body?: string, headers?: Record<string, string> } | undefined}
 */
function dailymotion(url) {
  if (url.startsWith(`https://www.dailymotion.com/player/metadata/video/${OK_ID}?`)) {
    return {
      body: JSON.stringify({ id: OK_ID, title: "An invented video", duration: 125, posters: { 360: "https://s1.dmcdn.net/p/x360.jpg" }, qualities: { auto: [{ type: "application/x-mpegURL", url: MASTER }] } }),
      headers: { "content-type": "application/json" },
    };
  }
  if (url.startsWith(`https://www.dailymotion.com/player/metadata/video/${GEO_ID}?`)) {
    return { body: JSON.stringify({ error: { code: "DM007", title: "Geo-restricted" } }) };
  }
  if (url === MASTER) {
    return {
      body: [
        "#EXTM3U",
        '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",NAME="360"',
        MEDIA.replace("media", "media-360"),
        '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",NAME="720"',
        MEDIA,
        "",
      ].join("\n"),
    };
  }
  if (url === MEDIA) {
    return { body: "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n#EXT-X-ENDLIST\n" };
  }
  return undefined;
}

test("the page loads idle: version, the engine lock held, the history empty", async () => {
  const page = await fakePage();
  try {
    assert.equal(page.element("version").textContent, "1.0.1");
    assert.equal(page.element("readonly-banner").hidden, true);
    assert.equal(page.element("app-status").dataset["state"], "idle");
    assert.equal(page.element("analyze-button").disabled, false);
    assert.equal(page.element("stop-button").disabled, true);
    assert.equal(page.element("test-card").hidden, false, "the test copy shows its test settings");
    assert.equal(page.element("legal-notice").textContent, "", "app.html carries the notice; the page only localizes it");
    assert.match(page.element("history-list").textContent, /No run yet/);
    assert.equal(page.element("cooldown-banner").hidden, true);
    assert.equal(page.element("setting-quality").value, "best");
    assert.equal(page.element("setting-codec").value, "compatible");
    assert.equal(page.element("setting-cover").value, "embed");
  } finally {
    page.restore();
  }
});

test("a second tab is read-only: nothing can start there", async () => {
  const page = await fakePage({ lockTaken: true });
  try {
    assert.equal(page.element("readonly-banner").hidden, false);
    assert.equal(page.element("app-status").dataset["state"], "readonly");
    for (const id of ["analyze-button", "download-all-button", "clear-button", "retry-button"]) {
      assert.equal(page.element(id).disabled, true, id);
    }
  } finally {
    page.restore();
  }
});

test("Analyze fills the rows: title link, site, duration, a quality selector; refusals listed; nothing downloaded", async () => {
  const page = await fakePage({ site: dailymotion });
  try {
    page.element("links").value = [
      `https://www.dailymotion.com/video/${OK_ID}`,
      `https://www.dailymotion.com/video/${GEO_ID}`,
      "https://example.com/not-a-video",
      "",
    ].join("\n");
    page.element("analyze-button").fire("click");
    await page.until(() => page.element("app-status").dataset["state"] === "idle" && page.requests.length >= 4, "Analyze");
    assert.deepEqual(page.requests.map((url) => url.split("?")[0]), [
      `https://www.dailymotion.com/player/metadata/video/${OK_ID}`,
      `https://www.dailymotion.com/cdn/manifest/video/${OK_ID}.m3u8`,
      MEDIA,
      `https://www.dailymotion.com/player/metadata/video/${GEO_ID}`,
    ]);
    const rows = page.rows();
    assert.deepEqual(rows.map((row) => row.dataset["key"]), [`dailymotion:${OK_ID}`, `dailymotion:${GEO_ID}`]);
    const [ok, geo] = /** @type {[FakeElement, FakeElement]} */ (/** @type {unknown} */ (rows));
    /** @param {FakeElement} row @param {string} name */
    const cell = (row, name) => /** @type {FakeElement} */ (row.children.find((child) => child.className === name));
    assert.equal(cell(ok, "title").textContent, "An invented video");
    assert.equal(cell(ok, "title").children[0]?.href, `https://www.dailymotion.com/video/${OK_ID}`);
    assert.equal(cell(ok, "title").children[0]?.target, "_blank");
    assert.equal(cell(ok, "site").textContent, "Dailymotion");
    assert.equal(cell(ok, "duration").textContent, "2:05");
    const selector = /** @type {FakeElement} */ (cell(ok, "quality").children[0]);
    assert.equal(selector.className, "quality-select");
    assert.deepEqual(selector.children.map((option) => [option.textContent, option.selected]), [
      ["360p · avc1 · 0.9 Mbit/s", false],
      ["720p · avc1 · 2.5 Mbit/s", true],
    ]);
    assert.equal(cell(ok, "status").children[0]?.dataset["status"], "queued");
    assert.equal(cell(geo, "status").children[0]?.dataset["status"], "failed-unavailable");
    assert.match(cell(geo, "message").textContent, /not available in your country \(Geo-restricted\)/);
    assert.equal(page.element("summary-line").textContent, "2 videos · 1 detected · 1 failed");
    assert.match(page.element("input-notes").textContent, /example\.com\/not-a-video — not a Dailymotion, Bilibili\.tv or Bilibili link/);
    const img = cell(ok, "cover").children[0];
    assert.equal(img?.className, "cover placeholder", "a cover frame, loaded only once in view");
    assert.equal(page.saved.length, 0);
  } finally {
    page.restore();
  }
});

test("the table keeps the rows already shown: Analyze appends the new ones, a run never puts them all back, Clear empties it", async () => {
  const page = await fakePage({ site: dailymotion });
  try {
    const body = /** @type {FakeElement} */ (page.element("items-table").querySelector("tbody"));
    let replaced = 0;
    const replace = body.replaceChildren.bind(body);
    body.replaceChildren = (...nodes) => {
      replaced += 1;
      replace(...nodes);
    };
    /** @param {string} what */
    const analyze = async (what) => {
      page.element("activity").textContent = "";
      page.element("analyze-button").fire("click");
      await page.until(() => page.element("app-status").dataset["state"] === "idle" && /^analyzed: /.test(page.element("activity").textContent), what);
    };
    page.element("links").value = `https://www.dailymotion.com/video/${OK_ID}`;
    await analyze("Analyze");
    assert.equal(page.rows().length, 1);
    const first = page.rows()[0];
    page.element("links").value = [`https://www.dailymotion.com/video/${OK_ID}`, `https://www.dailymotion.com/video/${GEO_ID}`].join("\n");
    await analyze("Analyze again");
    assert.equal(page.rows()[0], first, "the row already shown is the same element, left in place");
    assert.deepEqual(page.rows().map((row) => row.dataset["key"]), [`dailymotion:${OK_ID}`, `dailymotion:${GEO_ID}`]);
    assert.equal(replaced, 0, "rows new at the end are appended, nothing is put back");
    page.element("clear-button").fire("click");
    assert.deepEqual(page.rows(), []);
    assert.equal(replaced, 1, "Clear empties the table");
  } finally {
    page.restore();
  }
});

test("Download all: a file already there is skipped, the failures are listed in the failed block, the report is saved once", async () => {
  const page = await fakePage({ site: dailymotion, existing: ["StreamFetch/Dailymotion/An invented video [xbq9z2k].mp4"] });
  try {
    const okLine = `https://www.dailymotion.com/video/${OK_ID}`;
    const geoLine = `https://www.dailymotion.com/video/${GEO_ID}`;
    page.element("links").value = `${okLine}\n${geoLine}`;
    page.element("download-all-button").fire("click");
    await page.until(() => page.element("failed-block").hidden === false && page.saved.length === 1, "the end of the run");
    assert.deepEqual(page.rows().map((row) => [row.dataset["key"], row.dataset["status"]]), [
      [`dailymotion:${OK_ID}`, "skipped-exists"],
      [`dailymotion:${GEO_ID}`, "failed-unavailable"],
    ], "every row keeps its place in the table");
    assert.equal(page.element("failed-heading").textContent, "Did not download (1)");
    const failedRows = page.element("failed-table").querySelector("tbody")?.children ?? [];
    assert.deepEqual(failedRows.map((row) => row.dataset["key"]), [`dailymotion:${GEO_ID}`]);
    const report = page.saved[0];
    assert.match(String(report?.filename), /^StreamFetch\/reports\/\d{4}-\d\d-\d\d \d{4} - did not download\.json$/);
    const parsed = JSON.parse(String(report?.text));
    assert.equal(parsed.report_version, 1);
    assert.equal(parsed.test_mode, true);
    assert.deepEqual(parsed.not_downloaded.map((/** @type {{ input: string, failure: { code: string } }} */ row) => [row.input, row.failure.code]), [[geoLine, "geo_blocked"]]);
    assert.equal(parsed.skipped_exists_count, 1);
    assert.match(page.element("failed-report").textContent, /^Report saved: \d{4}-\d\d-\d\d \d{4} - did not download\.json$/);
    assert.equal(page.element("retry-button").disabled, false);
    const history = /** @type {Record<string, unknown>[]} */ (page.local.get("history"));
    assert.equal(history.length, 1);
    assert.deepEqual(history[0]?.["retry_inputs"], [geoLine]);
    assert.match(page.element("history-list").textContent, /2 rows: 0 done, 1 already there, 1 failed, 0 stopped/);
    // Retry: exactly the failed input, as a new run (and its report: the setting is on)
    const before = page.requests.length;
    page.element("retry-button").fire("click");
    await page.until(() => page.saved.length === 2, "the retry's report");
    assert.equal(page.element("links").value, geoLine);
    assert.deepEqual(page.requests.slice(before).map((url) => url.split("?")[0]), [`https://www.dailymotion.com/player/metadata/video/${GEO_ID}`]);
    assert.equal(page.rows().length, 2, "the rows of the earlier run stay until Clear");
    // Save the report again on demand
    page.element("report-button").fire("click");
    await page.until(() => page.saved.length === 3, "the report on demand");
    page.element("clear-button").fire("click");
    assert.equal(page.rows().length, 0);
    assert.equal(page.element("failed-block").hidden, true);
    assert.deepEqual(page.element("failed-table").querySelector("tbody")?.children, []);
  } finally {
    page.restore();
  }
});

test("with the report setting off nothing is saved at the end of a run", async () => {
  const page = await fakePage({ site: dailymotion, storage: { settings: { report: false } } });
  try {
    page.element("links").value = `https://www.dailymotion.com/video/${GEO_ID}`;
    page.element("download-all-button").fire("click");
    await page.until(() => page.element("failed-block").hidden === false, "the end of the run");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(page.saved.length, 0);
    assert.equal(page.element("failed-report").textContent, "");
  } finally {
    page.restore();
  }
});

test("a cooldown shows its banner and refuses every start without a request", async () => {
  const cooldown = makeCooldown("the site is rate-limiting this session", "dailymotion", { now: Date.now() });
  const page = await fakePage({ site: dailymotion, storage: { cooldown } });
  try {
    assert.equal(page.element("cooldown-banner").hidden, false);
    assert.match(page.element("cooldown-text").textContent, /Nothing is requested until \d\d:\d\d \(30 min left\)/);
    page.element("links").value = `https://www.dailymotion.com/video/${OK_ID}`;
    page.element("analyze-button").fire("click");
    await page.until(() => page.element("activity").textContent !== "", "the refusal");
    assert.match(page.element("activity").textContent, /a cooldown is in force until/);
    assert.deepEqual(page.requests, []);
    page.element("clear-cooldown-button").fire("click");
    await page.until(() => page.element("cooldown-banner").hidden, "the banner to go");
    assert.equal(page.local.has("cooldown"), false);
  } finally {
    page.restore();
  }
});

test("settings: lighter pauses are refused, the language switches the rows' texts", async () => {
  const page = await fakePage({ site: dailymotion, production: true });
  try {
    page.element("links").value = `https://www.dailymotion.com/video/${GEO_ID}`;
    page.element("analyze-button").fire("click");
    await page.until(() => page.rows()[0]?.dataset["status"] === "failed-unavailable", "Analyze");
    page.element("setting-video-pause-min").value = "1";
    page.element("settings-form").fire("submit");
    await page.until(() => page.element("settings-problem").textContent !== "", "the refusal");
    assert.match(page.element("settings-problem").textContent, /pauses may only be made longer/);
    assert.equal(page.local.has("settings"), false);
    page.element("setting-video-pause-min").value = "3";
    page.element("setting-language").value = "es";
    page.element("settings-form").fire("submit");
    await page.until(() => page.element("settings-problem").textContent === "Ajustes guardados.", "the save");
    assert.equal(/** @type {{ language: string }} */ (page.local.get("settings")).language, "es");
    const row = /** @type {FakeElement} */ (page.rows()[0]);
    const status = /** @type {FakeElement} */ (row.children.find((child) => child.className === "status"));
    const message = /** @type {FakeElement} */ (row.children.find((child) => child.className === "message"));
    assert.equal(status.textContent, "No disponible");
    assert.match(message.textContent, /^no disponible en tu país \(Geo-restricted\)/);
    assert.equal(page.element("settings-problem").textContent, "Ajustes guardados.");
  } finally {
    page.restore();
  }
});

// ------------------------------------------------------------------- popup and worker

test("the popup offers a video page of the three sites only (test bases mapped onto them)", async () => {
  const { linkOfTab } = await import("../src/app/popup.js");
  assert.equal(linkOfTab("https://www.dailymotion.com/video/xbq9z2k", {}), "https://www.dailymotion.com/video/xbq9z2k");
  assert.equal(linkOfTab("https://www.bilibili.com/video/BV1Xx411c7mD?p=2", {}), "https://www.bilibili.com/video/BV1Xx411c7mD?p=2");
  assert.equal(linkOfTab("https://www.youtube.com/watch?v=x", {}), null);
  assert.equal(linkOfTab(undefined, {}), null);
  assert.equal(linkOfTab("http://127.0.0.1:8123/dm/video/xbq9z2k", { dailymotion: "http://127.0.0.1:8123/dm" }), "https://www.dailymotion.com/video/xbq9z2k");
  const aid = "4801520000000001";
  const bstar = "?bstar_from=bstar-web.ugc-video-detail.related-recommend.all";
  assert.equal(linkOfTab(`https://www.bilibili.tv/es/video/${aid}${bstar}`, {}), `https://www.bilibili.tv/en/video/${aid}`);
  assert.equal(linkOfTab("https://www.bilibili.tv/en/play/2090001/13000002", {}), "https://www.bilibili.tv/en/play/2090001/13000002");
  assert.equal(linkOfTab("https://www.bilibili.tv/en/play/2090001", {}), "https://www.bilibili.tv/en/play/2090001", "a series page");
  assert.equal(linkOfTab("https://www.bilibili.tv/en/trending", {}), null);
  assert.equal(linkOfTab(`http://127.0.0.1:8123/btv/en/video/${aid}`, { bilibilitv: "http://127.0.0.1:8123/btv" }), `https://www.bilibili.tv/en/video/${aid}`);
});

test("the worker opens the StreamFetch tab, or focuses the one open and hands it the link", async () => {
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {chrome.runtime.ExtensionContext[]} */
  let contexts = [];
  Object.assign(globalThis, {
    chrome: {
      runtime: {
        id: "streamfetch-test-id",
        getURL: (/** @type {string} */ path) => `${ROOT}${path}`,
        getContexts: async () => contexts,
        sendMessage: async (/** @type {unknown} */ message) => void calls.push(["sendMessage", message]),
      },
      tabs: {
        create: async (/** @type {unknown} */ properties) => void calls.push(["create", properties]),
        update: async (/** @type {number} */ id, /** @type {unknown} */ properties) => void calls.push(["update", id, properties]),
      },
      windows: { update: async (/** @type {number} */ id, /** @type {unknown} */ info) => void calls.push(["focus", id, info]) },
    },
  });
  try {
    const { onMessage, openApp } = await import("../src/app/background.js");
    await openApp("https://dai.ly/xbq9z2k");
    assert.deepEqual(calls, [["create", { url: `${ROOT}src/app/app.html?links=${encodeURIComponent("https://dai.ly/xbq9z2k")}` }]]);
    calls.length = 0;
    contexts = [{ contextType: "TAB", contextId: "c", tabId: 7, windowId: 3, documentUrl: `${ROOT}src/app/app.html`, frameId: 0, incognito: false }];
    await openApp("https://dai.ly/xbq9z2k");
    assert.deepEqual(calls, [
      ["update", 7, { active: true }],
      ["focus", 3, { focused: true }],
      ["sendMessage", { type: "streamfetch:links", links: "https://dai.ly/xbq9z2k" }],
    ]);
    /** @type {unknown[]} */
    const answers = [];
    assert.equal(onMessage({ type: "streamfetch:open", links: null }, { id: "another-extension" }, (answer) => void answers.push(answer)), false, "only this extension may ask");
    assert.equal(onMessage({ type: "other" }, { id: "streamfetch-test-id" }, () => undefined), false);
    assert.equal(onMessage({ type: "streamfetch:open", links: null }, { id: "streamfetch-test-id" }, (answer) => void answers.push(answer)), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(answers, [{ ok: true }]);
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});
