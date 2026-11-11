// @ts-check
// app/engine.js over a scripted resolver and downloader: one item at a time, its targets in order,
// the pauses between network steps, the stop rules (a refusal stops at once and records the
// cooldown once, a login wall stops without one, three failures in a row stop), Stop, a cooldown
// that refuses the start or appears meanwhile, the rows of everything the run did not reach.
import assert from "node:assert/strict";
import { test } from "node:test";

import { makeCooldown } from "../src/lib/cooldown.js";
import { failure } from "../src/lib/messages.js";
import { StopRequested } from "../src/app/downloader.js";
import { analyzeBatch, cooldownReason, runBatch, streamsSummary } from "../src/app/engine.js";

/**
 * @typedef {import("../src/app/resolver.js").ResolveItem} ResolveItem
 * @typedef {import("../src/app/resolver.js").Target} Target
 * @typedef {import("../src/app/engine.js").Resolved} Resolved
 * @typedef {import("../src/app/engine.js").EngineEvent} EngineEvent
 * @typedef {import("../src/app/downloader.js").Result} Result
 */

/**
 * @param {string} id
 * @param {Partial<ResolveItem>} [fields]
 * @returns {ResolveItem}
 */
function item(id, fields = {}) {
  return {
    key: `dailymotion:${id}`,
    site: "dailymotion",
    kind: "video",
    id,
    part: null,
    shortLink: null,
    pageUrl: `https://www.dailymotion.com/video/${id}`,
    original: `https://www.dailymotion.com/video/${id}`,
    ...fields,
  };
}

/**
 * @param {string} key
 * @param {Partial<Target>} [fields]
 * @returns {Target}
 */
function target(key, fields = {}) {
  return {
    key,
    itemKey: key,
    input: `line ${key}`,
    site: "dailymotion",
    id: key.split(":").at(-1) ?? key,
    part: null,
    partCount: null,
    cid: null,
    pageUrl: "https://www.dailymotion.com/video/x",
    title: `Title ${key}`,
    partTitle: null,
    seasonId: null,
    episodeId: null,
    seriesTitle: null,
    durationS: 6,
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
 * @param {Partial<Result>} [fields]
 * @returns {Result}
 */
function result(fields = {}) {
  return {
    status: "done",
    failure: null,
    path: "/d/x.mp4",
    bytes: 1,
    durationS: 6,
    attempts: [],
    verify: null,
    notes: [],
    contacted: true,
    ...fields,
  };
}

/**
 * A scripted engine context: `resolutions` by item key (default: one target of the item's key),
 * `results` by target key (default: done); every step logged.
 * @param {{ resolutions?: Record<string, Resolved | ((item: ResolveItem) => Resolved)>,
 *   results?: Record<string, Result | ((target: Target) => Result)>, cooldown?: unknown,
 *   controller?: AbortController, resolved?: Map<string, Resolved> }} [options]
 */
function engine(options = {}) {
  /** @type {string[]} */
  const log = [];
  /** @type {EngineEvent[]} */
  const events = [];
  let stored = options.cooldown;
  /** @type {unknown[]} */
  const written = [];
  const controller = options.controller ?? new AbortController();
  /** @type {import("../src/app/engine.js").EngineContext} */
  const ctx = {
    resolve: async (pasted) => {
      log.push(`resolve ${pasted.key}`);
      const scripted = options.resolutions?.[pasted.key];
      if (scripted === undefined) return [target(pasted.key, { input: pasted.original, streams: null })];
      return typeof scripted === "function" ? scripted(pasted) : scripted;
    },
    download: async (one, onProgress, onStatus) => {
      log.push(`download ${one.key}`);
      if (one.failure !== null) return result({ status: one.status ?? "failed", failure: one.failure, path: null, contacted: false });
      onStatus("downloading");
      onProgress({ received: 10, total: 20, segments: null, bytesPerS: 5 });
      const scripted = options.results?.[one.key];
      if (scripted === undefined) return result();
      return typeof scripted === "function" ? scripted(one) : scripted;
    },
    pacing: { videoPauseS: [3, 6], pagePauseS: [1, 2], mediaPauseMs: [100, 300] },
    signal: controller.signal,
    sleep: async (seconds) => {
      log.push(`sleep ${seconds}`);
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    readCooldown: async () => stored,
    writeCooldown: async (cooldown) => {
      written.push(cooldown);
      stored = cooldown;
    },
    emit: (event) => void events.push(event),
    rng: () => 0,
    now: () => 1_800_000_000_000,
    resolved: options.resolved ?? new Map(),
    settings: { quality: "best" },
  };
  return { ctx, log, events, written, controller, setCooldown: (/** @type {unknown} */ value) => void (stored = value) };
}

test("one item at a time: resolve, then download; a page pause before the media, a video pause between videos", async () => {
  const { ctx, log, events } = engine();
  const run = await runBatch([item("x1"), item("x2")], ctx);
  assert.deepEqual(log, [
    "resolve dailymotion:x1",
    "sleep 1",
    "download dailymotion:x1",
    "sleep 3",
    "resolve dailymotion:x2",
    "sleep 1",
    "download dailymotion:x2",
  ]);
  assert.deepEqual(run.rows.map((row) => [row.key, row.status]), [
    ["dailymotion:x1", "done"],
    ["dailymotion:x2", "done"],
  ]);
  assert.equal(run.stopReason, null);
  assert.deepEqual(run.settings, { quality: "best" });
  assert.ok(run.finishedAt !== null);
  const types = events.map((event) => event.type);
  assert.deepEqual(types.slice(0, 4), ["item-resolving", "item-resolved", "pause", "target-status"]);
  assert.ok(types.includes("target-progress"));
  assert.equal(types.at(-1), "finished");
  assert.deepEqual(events.filter((event) => event.type === "pause").map((event) => event.type === "pause" && event.kind), ["page", "video", "page"]);
});

test("a skip (no request) neither pauses nor counts", async () => {
  const { ctx, log } = engine({
    results: { "dailymotion:x1": result({ status: "skipped-exists", contacted: false }) },
  });
  await runBatch([item("x1"), item("x2")], ctx);
  assert.deepEqual(log, [
    "resolve dailymotion:x1",
    "sleep 1",
    "download dailymotion:x1",
    "sleep 1",
    "resolve dailymotion:x2",
    "sleep 1",
    "download dailymotion:x2",
  ]);
});

test("a 429 stops the run at once, records the cooldown once, the rest is stopped without a request", async () => {
  const limited = failure("rate_limited", { detail: "HTTP 429 (segment)" });
  const { ctx, log, written, events } = engine({
    resolutions: {
      "dailymotion:x1": [target("bilibili:BV1:1", { site: "bilibili" }), target("bilibili:BV1:2", { site: "bilibili" })],
    },
    results: { "bilibili:BV1:1": result({ status: "failed-rate-limited", failure: limited }) },
  });
  const run = await runBatch([item("x1"), item("x2")], ctx);
  assert.deepEqual(log.filter((line) => !line.startsWith("sleep")), ["resolve dailymotion:x1", "download bilibili:BV1:1"]);
  assert.deepEqual(run.rows.map((row) => [row.key, row.status, row.failure?.code]), [
    ["bilibili:BV1:1", "failed-rate-limited", "rate_limited"],
    ["bilibili:BV1:2", "stopped", "stopped"],
    ["dailymotion:x2", "stopped", "stopped"],
  ]);
  assert.deepEqual(run.rows[2]?.failure, { code: "stopped", params: { reason: "rate_limited" } });
  assert.equal(run.stopReason, "rate_limited");
  assert.equal(written.length, 1);
  const cooldown = /** @type {import("../src/lib/cooldown.js").Cooldown} */ (written[0]);
  assert.equal(cooldown.source, "bilibili");
  assert.equal(cooldown.until, 1_800_000_000_000 + 30 * 60_000);
  assert.equal(cooldown.reason, "HTTP 429 (segment)", "the refusal's detail, never a rendered sentence");
  assert.ok(events.some((event) => event.type === "cooldown"));
});

test("a refusal met while resolving a later part stops the run before any part of the item downloads", async () => {
  const limited = failure("rate_limited", { detail: "HTTP 412 (page)" });
  const { ctx, log, written, events } = engine({
    resolutions: {
      "bilibili:BV1:all": [
        target("bilibili:BV1:1", { site: "bilibili" }),
        target("bilibili:BV1:2", { site: "bilibili", failure: failure("no_streams", { detail: "none" }), status: "failed" }),
        target("bilibili:BV1:3", { site: "bilibili", failure: limited, status: "failed-rate-limited" }),
        target("bilibili:BV1:4", { site: "bilibili", failure: failure("stopped", { reason: "rate_limited" }), status: "stopped" }),
      ],
    },
  });
  const run = await runBatch([item("BV1", { key: "bilibili:BV1:all", site: "bilibili" }), item("x2")], ctx);
  // the resolver's failures are recorded without a request; nothing is downloaded, nothing more resolved
  assert.deepEqual(log.filter((line) => !line.startsWith("sleep")), [
    "resolve bilibili:BV1:all",
    "download bilibili:BV1:2",
    "download bilibili:BV1:3",
  ]);
  assert.ok(!events.some((event) => event.type === "target-progress"), "no media request");
  assert.deepEqual(run.rows.map((row) => [row.key, row.status, row.failure?.code]), [
    ["bilibili:BV1:1", "stopped", "stopped"],
    ["bilibili:BV1:2", "failed", "no_streams"],
    ["bilibili:BV1:3", "failed-rate-limited", "rate_limited"],
    ["bilibili:BV1:4", "stopped", "stopped"],
    ["dailymotion:x2", "stopped", "stopped"],
  ]);
  assert.deepEqual(run.rows[0]?.failure, { code: "stopped", params: { reason: "rate_limited" } });
  assert.equal(run.stopReason, "rate_limited");
  assert.equal(written.length, 1, "the cooldown recorded once");
  assert.equal(/** @type {import("../src/lib/cooldown.js").Cooldown} */ (written[0]).reason, "HTTP 412 (page)");
  assert.equal(/** @type {import("../src/lib/cooldown.js").Cooldown} */ (written[0]).source, "bilibili");
  // a login wall on a later episode: the same stop, without a cooldown
  const wall = engine({
    resolutions: {
      "dailymotion:x1": [target("bilibilitv:episode:1"), target("bilibilitv:episode:2", { failure: failure("login_required"), status: "failed-unavailable" })],
    },
  });
  const walled = await runBatch([item("x1")], wall.ctx);
  assert.deepEqual(walled.rows.map((row) => row.status), ["stopped", "failed-unavailable"]);
  assert.equal(walled.stopReason, "login_required");
  assert.equal(wall.written.length, 0);
  assert.ok(!wall.log.includes("download bilibilitv:episode:1"));
});

test("cooldownReason: the refusal's detail, else its code", () => {
  assert.equal(cooldownReason(failure("rate_limited", { detail: "HTTP 429 (manifest)" })), "HTTP 429 (manifest)");
  assert.equal(cooldownReason(failure("blocked", {})), "blocked");
});

test("a refusal while resolving (a 403 on a page) stops the run the same way", async () => {
  const { ctx, log, written } = engine({
    resolutions: {
      "dailymotion:x1": {
        ok: false,
        item: item("x1"),
        failure: failure("blocked", { detail: "HTTP 403 (page)" }),
        status: "failed-blocked",
        attempts: [],
        page: null,
        raw: null,
        title: null,
      },
    },
  });
  const run = await runBatch([item("x1"), item("x2")], ctx);
  assert.deepEqual(log, ["resolve dailymotion:x1"]);
  assert.deepEqual(run.rows.map((row) => row.status), ["failed-blocked", "stopped"]);
  assert.equal(written.length, 1);
  assert.equal(run.stopReason, "blocked");
});

test("a login wall stops the run without a cooldown", async () => {
  const { ctx, written } = engine({
    results: { "dailymotion:x1": result({ status: "failed-unavailable", failure: failure("login_required") }) },
  });
  const run = await runBatch([item("x1"), item("x2")], ctx);
  assert.deepEqual(run.rows.map((row) => row.status), ["failed-unavailable", "stopped"]);
  assert.equal(run.stopReason, "login_required");
  assert.equal(written.length, 0);
});

test("three failures in a row stop the run; a done in between resets the count", async () => {
  const failed = result({ status: "failed", failure: failure("no_response", { detail: "reset" }) });
  const unavailable = result({ status: "failed-unavailable", failure: failure("geo_blocked") });
  const { ctx } = engine({
    results: {
      "dailymotion:x1": failed,
      "dailymotion:x2": unavailable,
      "dailymotion:x4": failed,
      "dailymotion:x5": failed,
      "dailymotion:x6": unavailable,
    },
  });
  const run = await runBatch(["x1", "x2", "x3", "x4", "x5", "x6", "x7"].map((id) => item(id)), ctx);
  assert.deepEqual(run.rows.map((row) => row.status), [
    "failed",
    "failed-unavailable",
    "done",
    "failed",
    "failed",
    "failed-unavailable",
    "stopped",
  ]);
  assert.equal(run.stopReason, "consecutive_failures");
});

test("a cooldown in force refuses the start: every row stopped with the minutes left, nothing requested", async () => {
  const now = 1_800_000_000_000;
  const { ctx, log } = engine({ cooldown: makeCooldown("HTTP 429 earlier", "dailymotion", { now: now - 10 * 60_000 }) });
  const run = await runBatch([item("x1"), item("x2")], ctx);
  assert.deepEqual(log, []);
  assert.deepEqual(run.rows.map((row) => [row.status, row.failure?.code, row.failure?.params["minutes_left"]]), [
    ["stopped", "cooldown", 20],
    ["stopped", "cooldown", 20],
  ]);
  assert.match(String(run.stopReason), /^cooldown until \d\d:\d\d$/);
  const analyzed = await analyzeBatch([item("x1")], engine({ cooldown: makeCooldown("x", "bilibili", { now }) }).ctx);
  assert.equal(analyzed.rows[0]?.failure?.code, "cooldown");
});

test("a cooldown recorded meanwhile stops the run right before its next request", async () => {
  const setup = engine({
    results: {
      "dailymotion:x1": () => {
        setup.setCooldown(makeCooldown("another tab", "dailymotion", { now: 1_800_000_000_000 }));
        return result();
      },
    },
  });
  const run = await runBatch([item("x1"), item("x2")], setup.ctx);
  assert.deepEqual(setup.log.filter((line) => !line.startsWith("sleep")), ["resolve dailymotion:x1", "download dailymotion:x1"]);
  assert.deepEqual(run.rows.map((row) => row.status), ["done", "stopped"]);
  assert.match(String(run.rows[1]?.failure?.params["reason"]), /^cooldown until/);
});

test("Stop: the current download ends stopped and every later row is stopped by the user", async () => {
  const controller = new AbortController();
  const { ctx, log } = engine({
    controller,
    results: {
      "dailymotion:x1": () => {
        controller.abort(new StopRequested("user"));
        return result({ status: "stopped", failure: failure("stopped", { reason: "user" }), contacted: true });
      },
    },
  });
  const run = await runBatch([item("x1"), item("x2"), item("x3")], ctx);
  assert.deepEqual(log.filter((line) => !line.startsWith("sleep")), ["resolve dailymotion:x1", "download dailymotion:x1"]);
  assert.deepEqual(run.rows.map((row) => [row.status, row.failure?.params["reason"]]), [
    ["stopped", "user"],
    ["stopped", "user"],
    ["stopped", "user"],
  ]);
  assert.equal(run.stopReason, "user");
});

test("Stop during a pause ends the run there", async () => {
  const controller = new AbortController();
  const { ctx, log } = engine({ controller });
  ctx.sleep = async () => {
    controller.abort(new StopRequested("user"));
    throw controller.signal.reason;
  };
  const run = await runBatch([item("x1")], ctx);
  assert.deepEqual(log, ["resolve dailymotion:x1"]);
  assert.deepEqual(run.rows.map((row) => row.status), ["stopped"]);
});

test("what Analyze resolved is used as it is; the same video named twice is downloaded once", async () => {
  const resolved = new Map([["dailymotion:x1", /** @type {Resolved} */ ([target("dailymotion:x1")])]]);
  const { ctx, log, events } = engine({
    resolved,
    resolutions: { "bilibili:b23:abc:all": [target("dailymotion:x1")] },
  });
  const run = await runBatch([item("x1"), item("b23:abc", { key: "bilibili:b23:abc:all", site: "bilibili" })], ctx);
  assert.deepEqual(log.filter((line) => !line.startsWith("sleep")), [
    "download dailymotion:x1",
    "resolve bilibili:b23:abc:all",
  ]);
  assert.equal(run.rows.length, 1);
  assert.ok(events.some((event) => event.type === "target-duplicate"));
});

test("a target the resolver could not resolve is recorded without a request or a pause", async () => {
  const { ctx, log } = engine({
    resolutions: {
      "dailymotion:x1": [
        target("bilibili:BV1:1"),
        target("bilibili:BV1:2", { failure: failure("trial_only"), status: "failed-unavailable" }),
      ],
    },
  });
  const run = await runBatch([item("x1")], ctx);
  assert.deepEqual(log, ["resolve dailymotion:x1", "sleep 1", "download bilibili:BV1:1", "download bilibili:BV1:2"]);
  assert.deepEqual(run.rows.map((row) => row.status), ["done", "failed-unavailable"]);
});

test("Analyze resolves every item, paced, downloads nothing and keeps the resolutions", async () => {
  const resolved = new Map();
  const { ctx, log } = engine({ resolved });
  const run = await analyzeBatch([item("x1"), item("x2")], ctx);
  assert.deepEqual(log, ["resolve dailymotion:x1", "sleep 1", "resolve dailymotion:x2"]);
  assert.deepEqual([...resolved.keys()], ["dailymotion:x1", "dailymotion:x2"]);
  assert.deepEqual(run.rows.map((row) => row.status), ["queued", "queued"]);
  const again = await analyzeBatch([item("x1"), item("x3")], ctx);
  assert.deepEqual(log.slice(3), ["resolve dailymotion:x3"], "an analysed item is not asked again");
  assert.equal(again.rows.length, 1);
});

test("Analyze stops at a refusal like a run", async () => {
  const { ctx, log, written } = engine({
    resolutions: {
      "dailymotion:x1": [target("dailymotion:x1", { failure: failure("rate_limited", { detail: "HTTP 412 (page)" }), status: "failed-rate-limited" })],
    },
  });
  const run = await analyzeBatch([item("x1"), item("x2")], ctx);
  assert.deepEqual(log, ["resolve dailymotion:x1"]);
  assert.deepEqual(run.rows.map((row) => row.status), ["failed-rate-limited", "stopped"]);
  assert.equal(written.length, 1);
});

test("streamsSummary: the chosen streams and what was offered, for the report", () => {
  const variant = { url: "https://x.dailymotion.com/1080.m3u8?sec=1", bandwidth: 5, width: 1920, height: 1080, frameRate: 25, codecs: "avc1", name: "1080", audioGroup: null };
  const hls = streamsSummary(target("k", { streams: { kind: "hls", master: "m", variant, audio: null, available: [variant], audioRenditions: [] } }));
  assert.deepEqual(hls, {
    kind: "hls",
    chosen: { name: "1080", width: 1920, height: 1080, bandwidth: 5, codecs: "avc1", url: variant.url, audio: null },
    available: [{ name: "1080", width: 1920, height: 1080, bandwidth: 5, codecs: "avc1", url: variant.url }],
  });
  assert.equal(streamsSummary(target("k")), null);
});
