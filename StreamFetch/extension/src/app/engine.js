// @ts-check
/**
 * The run: the pasted items one at a time — resolve one item (a Bilibili multi-part video: all its
 * parts; a Bilibili.tv series: every episode), then download its targets in order, so signed URLs
 * never wait — with the pauses of `lib/pacing.js` between every two network steps
 * (`VIDEO_PAUSE_S` before a download or a resolution that follows a download, `PAGE_PAUSE_S`
 * between two page steps), and the stop rules (`lib/pacing.afterResult`): a `failed-rate-limited`
 * or `failed-blocked` result stops the run at once and records the 30-minute cooldown (once), a
 * login wall stops it without one, three `failed` / `failed-unavailable` results in a row stop it,
 * Stop (the run's AbortSignal) ends the current request; every target the run did not reach is
 * `stopped` with the reason. A refusal met while an item resolves (a later part's page, an
 * episode's playurl) stops the run before any target of that item downloads — the parts resolved
 * before it are `stopped`, never fetched. A cooldown in force refuses the start, and one recorded
 * meanwhile stops the run right before its next request. {@link analyzeBatch} is the same
 * resolution without downloads (**Analyze**).
 *
 * The engine knows nothing of the DOM: it reports through `emit` and returns the run's record,
 * from which the report (`lib/report.js`) and the history are made.
 */

import {
  activeCooldown,
  cooldownFailure,
  cooldownStopReason,
  makeCooldown,
} from "../lib/cooldown.js";
import {
  FAILED,
  FAILED_BLOCKED,
  FAILED_RATE_LIMITED,
  STOPPED,
  failure,
  statusForFailure,
} from "../lib/messages.js";
import { afterResult, pagePauseS, videoPauseS } from "../lib/pacing.js";
import { StopRequested, isStop, oneLine, traceOf } from "./downloader.js";

/**
 * @typedef {import("./resolver.js").ResolveItem} ResolveItem
 * @typedef {import("./resolver.js").Target} Target
 * @typedef {import("./resolver.js").ResolveFailure} ResolveFailure
 * @typedef {import("./resolver.js").SiteName} SiteName
 * @typedef {import("./downloader.js").Result} Result
 * @typedef {import("./downloader.js").Progress} Progress
 * @typedef {import("../lib/messages.js").Failure} Failure
 * @typedef {import("../lib/messages.js").Status} Status
 * @typedef {import("../lib/cooldown.js").Cooldown} Cooldown
 * @typedef {Target[] | ResolveFailure} Resolved
 *
 * @typedef {object} Row One line of a run's record: a target, or an item that failed whole (the
 *   report's `RowInput`, plus what the page and the history show).
 * @property {string} key
 * @property {string} itemKey
 * @property {string} input
 * @property {string} site
 * @property {string} id
 * @property {number | null} part
 * @property {string | null} title
 * @property {string} status
 * @property {Failure | null} failure
 * @property {import("../lib/report.js").Attempt[]} attempts
 * @property {unknown} streams
 * @property {import("../lib/report.js").PageInput | null} page
 * @property {unknown} raw
 * @property {string | null} seasonId
 * @property {string | null} episodeId
 * @property {string | null} path
 * @property {import("./downloader.js").Note[]} notes
 * @property {import("./downloader.js").Verify | null} verify
 *
 * @typedef {object} Run The record of one run.
 * @property {Date} startedAt
 * @property {Date | null} finishedAt
 * @property {string | null} stopReason null when the run finished on its own
 * @property {unknown} settings
 * @property {Row[]} rows in input order
 *
 * @typedef {{ type: "item-resolving", item: ResolveItem } |
 *   { type: "item-resolved", item: ResolveItem, resolved: Resolved } |
 *   { type: "target-status", target: Target, status: Status, failure?: Failure } |
 *   { type: "target-duplicate", target: Target } |
 *   { type: "target-progress", target: Target, progress: Progress } |
 *   { type: "target-done", target: Target, result: Result } |
 *   { type: "item-stopped", item: ResolveItem, failure: Failure } |
 *   { type: "pause", kind: "video" | "page", seconds: number } |
 *   { type: "cooldown", cooldown: Cooldown } |
 *   { type: "stopped", reason: string } |
 *   { type: "finished", run: Run }} EngineEvent
 *
 * @typedef {object} EngineContext
 * @property {(item: ResolveItem) => Promise<Resolved>} resolve
 * @property {(target: Target, onProgress: (progress: Progress) => void,
 *   onStatus: (status: Status) => void) => Promise<Result>} download
 * @property {import("../lib/pacing.js").PacingSettings} pacing
 * @property {AbortSignal} signal the run's Stop
 * @property {(seconds: number) => Promise<void>} sleep rejects at once when the signal aborts
 * @property {() => Promise<unknown>} readCooldown the stored cooldown record
 * @property {(cooldown: Cooldown) => Promise<void>} writeCooldown
 * @property {(event: EngineEvent) => void} [emit]
 * @property {() => number} [rng]
 * @property {() => number} [now] milliseconds since the epoch
 * @property {Map<string, Resolved>} [resolved] items **Analyze** resolved already, by key
 * @property {unknown} [settings] recorded in the run (the report's `run.settings`)
 */

/**
 * Whether a resolution is a failure of the whole item (`resolver.isResolveFailure`, without
 * importing the resolver).
 * @param {Resolved} resolved
 * @returns {resolved is ResolveFailure}
 */
function isResolveFailure(resolved) {
  return !Array.isArray(resolved);
}

/**
 * The report's `streams` of a target: the kind, the chosen streams, what was offered.
 * @param {Target} target
 * @returns {unknown}
 */
export function streamsSummary(target) {
  const streams = target.streams;
  if (streams === null) return null;
  if (streams.kind === "hls") {
    /** @param {import("../lib/hls.js").HlsVariant} variant */
    const variant = (variant) => ({
      name: variant.name,
      width: variant.width,
      height: variant.height,
      bandwidth: variant.bandwidth,
      codecs: variant.codecs,
      url: variant.url,
    });
    return {
      kind: "hls",
      chosen: {
        ...variant(streams.variant),
        audio: streams.audio === null ? null : { name: streams.audio.name, url: streams.audio.url },
      },
      available: streams.available.map(variant),
    };
  }
  /** @param {import("../lib/bilibili.js").DashRep} rep */
  const rep = (rep) => ({
    id: rep.id,
    label: rep.label,
    codecs: rep.codecs,
    width: rep.width,
    height: rep.height,
    bandwidth: rep.bandwidth,
    size: rep.size,
    url: rep.urls[0] ?? null,
  });
  return {
    kind: "dash",
    chosen: {
      video: rep(streams.video),
      audio: streams.audio === null ? null : rep(streams.audio),
    },
    available: streams.available.map(rep),
    audio_available: streams.audioAvailable.map(rep),
    missing_premium: [...streams.missingPremium],
  };
}

/**
 * The row of a target.
 * @param {Target} target
 * @param {Status} status
 * @param {Failure | null} fail
 * @param {Result | null} result
 * @returns {Row}
 */
export function targetRow(target, status, fail, result) {
  return {
    key: target.key,
    itemKey: target.itemKey,
    input: target.input,
    site: target.site,
    id: target.id,
    part: target.part,
    title: target.title || null,
    status,
    failure: fail,
    attempts: traceOf(target),
    streams: streamsSummary(target),
    page: target.page,
    raw: target.raw,
    seasonId: target.seasonId,
    episodeId: target.episodeId,
    path: result?.path ?? null,
    notes: result?.notes ?? [],
    verify: result?.verify ?? null,
  };
}

/**
 * The row of an item that failed whole, or that the run never reached.
 * @param {ResolveItem} item
 * @param {Status} status
 * @param {Failure | null} fail
 * @param {ResolveFailure | null} resolved
 * @returns {Row}
 */
export function itemRow(item, status, fail, resolved) {
  return {
    key: item.key,
    itemKey: item.key,
    input: item.original,
    site: item.site,
    id: item.id,
    part: item.part,
    title: resolved?.title ?? null,
    status,
    failure: fail,
    attempts: resolved?.attempts ?? [],
    streams: null,
    page: resolved?.page ?? null,
    raw: resolved?.raw ?? null,
    seasonId:
      item.kind === "episode" ? (item.seasonId ?? null) : item.kind === "series" ? item.id : null,
    episodeId: item.kind === "episode" ? item.id : null,
    path: null,
    notes: [],
    verify: null,
  };
}

/**
 * What a cooldown records as its reason: the refusal's short detail as the engine wrote it
 * (`HTTP 429 (manifest)`, `risk control (v_voucher) (page)`), else the failure's code — never a
 * rendered sentence, so the page shows it in its own language (`i18n.cooldownReasonLabel`).
 * @param {Failure} fail
 * @returns {string}
 */
export function cooldownReason(fail) {
  const detail = fail.params["detail"];
  return typeof detail === "string" && detail.trim() !== "" ? detail : fail.code;
}

/**
 * The engine's shared state of one run.
 */
class RunState {
  /**
   * @param {EngineContext} ctx
   * @param {Run} run
   */
  constructor(ctx, run) {
    this.ctx = ctx;
    this.run = run;
    this.counters = { consecutiveFailures: 0 };
    /** @type {{ reason: string, failure: Failure } | null} */
    this.stop = null;
    /** @type {"page" | "download" | null} the last step that contacted a site */
    this.last = null;
    this.cooldownRecorded = false;
    /** @type {Set<string>} the targets of this run: the same video named twice is done once */
    this.seen = new Set();
  }

  /** @param {EngineEvent} event */
  emit(event) {
    this.ctx.emit?.(event);
  }

  /** @returns {number} */
  now() {
    return this.ctx.now ? this.ctx.now() : Date.now();
  }

  /**
   * Stop the run (the first reason wins).
   * @param {string} reason
   */
  halt(reason) {
    if (this.stop !== null) return;
    this.stop = { reason, failure: failure("stopped", { reason }) };
    this.emit({ type: "stopped", reason });
  }

  /**
   * The pause before a network step: after a download, the pause between videos (before the
   * next video's first request); after a page step, the pause between page requests (before the
   * next page or the first media request); none before the run's first request. Then the
   * cooldown is asked once more, right before the request.
   * @param {"page" | "download"} next
   * @returns {Promise<boolean>} false when the run must stop instead (a cooldown recorded
   *   meanwhile, Stop)
   */
  async beforeNetwork(next) {
    if (this.last !== null) {
      const kind = this.last === "download" ? "video" : "page";
      const seconds =
        kind === "video"
          ? videoPauseS(this.ctx.pacing, this.ctx.rng)
          : pagePauseS(this.ctx.pacing, this.ctx.rng);
      this.emit({ type: "pause", kind, seconds });
      await this.ctx.sleep(seconds);
    }
    const cooldown = activeCooldown(this.now(), await this.ctx.readCooldown());
    if (cooldown !== null) {
      this.halt(cooldownStopReason(cooldown));
      return false;
    }
    return true;
  }

  /**
   * What a result does to the run: the stop rules, the cooldown recorded once.
   * @param {Status} status
   * @param {Failure | null} fail
   * @param {string} site
   */
  async after(status, fail, site) {
    const decision = afterResult(this.counters, status, fail?.code ?? null);
    if (decision.stop === null) return;
    if (decision.stop.cooldown && !this.cooldownRecorded && fail !== null) {
      this.cooldownRecorded = true;
      const cooldown = makeCooldown(cooldownReason(fail), site, { now: this.now() });
      await this.ctx.writeCooldown(cooldown);
      this.emit({ type: "cooldown", cooldown });
    }
    this.counters.consecutiveFailures = 0;
    this.halt(decision.stop.reason);
  }
}

/**
 * The stop reason of an error thrown by a step: the user's Stop, or a bug (reported as a failure
 * of the step, never thrown out of the run).
 * @param {unknown} error
 * @returns {string}
 */
function stopReasonOf(error) {
  return error instanceof StopRequested ? error.reason : "user";
}

/**
 * The failure the rows the run did not reach carry: `stopped` with the run's stop reason.
 * @param {RunState} state
 * @returns {Failure}
 */
function stopFailure(state) {
  return state.stop?.failure ?? failure("stopped", { reason: "user" });
}

/**
 * The rows of a resolved item's targets the run did not reach.
 * @param {RunState} state
 * @param {Target[]} targets
 */
function stopTargets(state, targets) {
  for (const target of targets) {
    const reason = stopFailure(state);
    state.run.rows.push(targetRow(target, STOPPED, reason, null));
    state.emit({ type: "target-status", target, status: STOPPED, failure: reason });
  }
}

/**
 * Whether a target the resolver already failed means the site refused this session — a 429 / 412
 * / 403 or a risk-control page met on a later part's page or an episode's playurl, or a login wall
 * — so that nothing of its item may be downloaded: the run stops before any media request.
 * @param {Target} target
 * @returns {boolean}
 */
export function refusesTheSession(target) {
  if (target.failure === null) return false;
  const status = target.status ?? statusForFailure(target.failure.code);
  return (
    status === FAILED_RATE_LIMITED ||
    status === FAILED_BLOCKED ||
    target.failure.code === "login_required"
  );
}

/**
 * An item whose resolution met a refusal of the site: the refusal is recorded first (the stop, and
 * the cooldown once), then every target of the item gets its row without a request — the refused
 * one its failure, one the resolver failed otherwise its own failure, the others `stopped` — so
 * the parts or episodes resolved before the refusal are never downloaded.
 * @param {RunState} state
 * @param {Target[]} targets
 * @param {Target} refusal the first target that {@link refusesTheSession}
 */
async function refuseItem(state, targets, refusal) {
  /** @type {Map<Target, Result>} */
  const results = new Map();
  for (const target of targets) {
    if (target.failure === null || target.status === STOPPED) continue;
    // no request: the downloader records the resolver's failure as the target's result
    results.set(target, await state.ctx.download(target, () => undefined, () => undefined));
  }
  const refused = /** @type {Result} */ (results.get(refusal));
  await state.after(refused.status, refused.failure, refusal.site);
  for (const target of targets) {
    if (state.seen.has(target.key)) {
      state.emit({ type: "target-duplicate", target });
      continue;
    }
    state.seen.add(target.key);
    const result = results.get(target);
    if (result === undefined) {
      stopTargets(state, [target]);
      continue;
    }
    state.run.rows.push(targetRow(target, result.status, result.failure, result));
    state.emit({ type: "target-done", target, result });
  }
}

/**
 * Resolve one item (paced, the cooldown asked right before); null when the run stopped first.
 * @param {RunState} state
 * @param {ResolveItem} item
 * @returns {Promise<Resolved | null>}
 */
async function resolveItem(state, item) {
  const known = state.ctx.resolved?.get(item.key);
  if (known !== undefined) return known;
  try {
    if (!(await state.beforeNetwork("page"))) return null;
    state.emit({ type: "item-resolving", item });
    const resolved = await state.ctx.resolve(item);
    state.last = "page";
    state.ctx.resolved?.set(item.key, resolved);
    state.emit({ type: "item-resolved", item, resolved });
    return resolved;
  } catch (error) {
    if (isStop(error, state.ctx)) {
      state.halt(stopReasonOf(error));
      return null;
    }
    state.last = "page";
    /** @type {ResolveFailure} */
    const failed = {
      ok: false,
      item,
      failure: failure("no_response", { detail: oneLine(error) }),
      status: FAILED,
      attempts: [],
      page: null,
      raw: null,
      title: null,
    };
    state.emit({ type: "item-resolved", item, resolved: failed });
    return failed;
  }
}

/**
 * Refuse a start under a cooldown: every item `stopped` with the `cooldown` failure.
 * @param {RunState} state
 * @param {readonly ResolveItem[]} items
 * @returns {Promise<boolean>} whether the start was refused
 */
async function refusedByCooldown(state, items) {
  const stored = await state.ctx.readCooldown();
  const refusal = cooldownFailure(stored, state.now());
  const cooldown = activeCooldown(state.now(), stored);
  if (refusal === null || cooldown === null) return false;
  state.stop = { reason: cooldownStopReason(cooldown), failure: refusal };
  for (const item of items) {
    state.run.rows.push(itemRow(item, STOPPED, refusal, null));
    state.emit({ type: "item-stopped", item, failure: refusal });
  }
  state.emit({ type: "stopped", reason: state.stop.reason });
  return true;
}

/**
 * A new run's record.
 * @param {EngineContext} ctx
 * @returns {Run}
 */
function newRun(ctx) {
  return {
    startedAt: new Date(ctx.now ? ctx.now() : Date.now()),
    finishedAt: null,
    stopReason: null,
    settings: ctx.settings ?? null,
    rows: [],
  };
}

/**
 * Finish a run's record and tell the page.
 * @param {RunState} state
 * @returns {Run}
 */
function finish(state) {
  state.run.finishedAt = new Date(state.now());
  state.run.stopReason = state.stop?.reason ?? null;
  state.emit({ type: "finished", run: state.run });
  return state.run;
}

/**
 * Download every item (module doc). Never throws: Stop, a cooldown or a refusal end the run with
 * its record.
 * @param {readonly ResolveItem[]} items
 * @param {EngineContext} ctx
 * @returns {Promise<Run>}
 */
export async function runBatch(items, ctx) {
  const state = new RunState(ctx, newRun(ctx));
  if (await refusedByCooldown(state, items)) return finish(state);
  for (const item of items) {
    if (state.stop === null && ctx.signal.aborted) state.halt(stopReasonOf(ctx.signal.reason));
    if (state.stop !== null) {
      const known = ctx.resolved?.get(item.key);
      if (known !== undefined && !isResolveFailure(known)) stopTargets(state, known);
      else {
        state.run.rows.push(itemRow(item, STOPPED, state.stop.failure, null));
        state.emit({ type: "item-stopped", item, failure: state.stop.failure });
      }
      continue;
    }
    const resolved = await resolveItem(state, item);
    if (resolved === null) {
      state.run.rows.push(itemRow(item, STOPPED, stopFailure(state), null));
      state.emit({ type: "item-stopped", item, failure: stopFailure(state) });
      continue;
    }
    if (isResolveFailure(resolved)) {
      state.run.rows.push(itemRow(item, resolved.status, resolved.failure, resolved));
      await state.after(resolved.status, resolved.failure, item.site);
      continue;
    }
    const refusal = resolved.find(refusesTheSession);
    if (refusal !== undefined) {
      await refuseItem(state, resolved, refusal);
      continue;
    }
    for (const target of resolved) {
      if (state.seen.has(target.key)) {
        state.emit({ type: "target-duplicate", target });
        continue;
      }
      state.seen.add(target.key);
      if (state.stop === null && ctx.signal.aborted) state.halt(stopReasonOf(ctx.signal.reason));
      if (state.stop !== null) {
        stopTargets(state, [target]);
        continue;
      }
      /** @type {Result} */
      let result;
      if (target.failure !== null) {
        result = await ctx.download(target, () => undefined, () => undefined);
      } else {
        try {
          if (!(await state.beforeNetwork("download"))) {
            stopTargets(state, [target]);
            continue;
          }
        } catch (error) {
          if (!isStop(error, ctx)) throw error;
          state.halt(stopReasonOf(error));
          stopTargets(state, [target]);
          continue;
        }
        state.emit({ type: "target-status", target, status: "downloading" });
        result = await ctx.download(
          target,
          (progress) => state.emit({ type: "target-progress", target, progress }),
          (status) => state.emit({ type: "target-status", target, status }),
        );
        if (result.contacted) state.last = "download";
      }
      state.run.rows.push(targetRow(target, result.status, result.failure, result));
      state.emit({ type: "target-done", target, result });
      if (result.status === STOPPED) {
        const reason = result.failure?.params["reason"];
        state.halt(typeof reason === "string" ? reason : "user");
        continue;
      }
      await state.after(result.status, result.failure, target.site);
    }
  }
  return finish(state);
}

/**
 * **Analyze**: resolve every item, one at a time, paced, with the same stop rules and the same
 * cooldown, without downloading anything. The resolutions are kept in `ctx.resolved` (a later
 * **Download all** uses them) and reported through `emit`.
 * @param {readonly ResolveItem[]} items
 * @param {EngineContext} ctx
 * @returns {Promise<Run>}
 */
export async function analyzeBatch(items, ctx) {
  const state = new RunState(ctx, newRun(ctx));
  if (await refusedByCooldown(state, items)) return finish(state);
  for (const item of items) {
    if (state.stop === null && ctx.signal.aborted) state.halt(stopReasonOf(ctx.signal.reason));
    if (state.stop !== null) {
      state.run.rows.push(itemRow(item, STOPPED, state.stop.failure, null));
      state.emit({ type: "item-stopped", item, failure: state.stop.failure });
      continue;
    }
    if (ctx.resolved?.has(item.key)) continue;
    const resolved = await resolveItem(state, item);
    if (resolved === null) {
      const stopped = stopFailure(state);
      state.run.rows.push(itemRow(item, STOPPED, stopped, null));
      state.emit({ type: "item-stopped", item, failure: stopped });
      continue;
    }
    if (isResolveFailure(resolved)) {
      state.run.rows.push(itemRow(item, resolved.status, resolved.failure, resolved));
      await state.after(resolved.status, resolved.failure, item.site);
      continue;
    }
    for (const target of resolved) {
      if (state.seen.has(target.key)) {
        state.emit({ type: "target-duplicate", target });
        continue;
      }
      state.seen.add(target.key);
      const status = target.status ?? "queued";
      state.run.rows.push(targetRow(target, status, target.failure, null));
      if (target.failure !== null) {
        const failed = status === "queued" ? statusForFailure(target.failure.code) : status;
        await state.after(failed, target.failure, target.site);
      }
    }
  }
  return finish(state);
}
