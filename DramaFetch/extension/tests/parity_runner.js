// @ts-check
/**
 * The parity runner of `DramaFetch/tests/test_extension_parity.py`: reads a JSON list of calls
 * `{"fn": …, "args": [...], "omit"?: [...]}` on stdin, runs them one after the other against the
 * extension's pure modules, and prints the results as a JSON list on stdout — `{"ok": true,
 * "value": …}` or `{"ok": false, "error": <message>, "name": <error class>}` per call — so that
 * pytest can compare every answer with the Python function's on the same input.
 *
 * `fn` is `<module>.<export>` of `src/lib/<module>.js` (`catalog.accessOf`, `mp4.verifyVideo`),
 * `$const` with `["<module>.<NAME>"]` (the exported value itself), or `parity.<adapter>` (below:
 * calls whose answer includes the state they mutate). Tagged arguments: `{"$bytes": <base64>}` → a
 * Uint8Array; `{"$rng": [r0, r1, …]}` → an Rng whose `uniform(a, b)` is `a + (b - a) * r_i`, like
 * Python's `random.Random.uniform` over a scripted `random()`; `{"$clock": [t0, t1, …]}` → a clock
 * returning those values in turn (then the last one); `{"$exists": [paths]}` → a FileExists that is
 * true for an entry whose `path` is listed; `{"$pacing": {…}}` → a PacingState. Results:
 * Uint8Array → `{"$bytes": …}`, Set → list, Map → object, undefined → null; `omit` drops those keys
 * at any depth (`["raw"]` keeps payloads out of the answer). Node built-ins only; reads stdin, writes
 * stdout, nothing else.
 */

import { readFileSync, writeSync } from "node:fs";
import { PacingState } from "../src/lib/pacing.js";
import {
  clearComplete,
  completeSince,
  doneEntries,
  drmProtected,
  isDone,
  loadState,
  lockedNumbers,
  markComplete,
  missingFiles,
  readState,
  record,
} from "../src/lib/state.js";
import { afterResult, longRestDue, pauseBeforeAttempt, pauseBetweenJobs, pauseBetweenSeries } from "../src/lib/pacing.js";
import { completeSkip, reportRows, reportToDict, seriesReport } from "../src/lib/report.js";

/** @typedef {{fn: string, args?: unknown[], omit?: string[]}} Call */

/** @type {Map<string, Record<string, unknown>>} */
const modules = new Map();

/**
 * @param {string} name
 * @returns {Promise<Record<string, unknown>>}
 */
async function moduleNamed(name) {
  if (!/^[a-z][a-z0-9]*$/.test(name)) throw new Error(`bad module name ${JSON.stringify(name)}`);
  let loaded = modules.get(name);
  if (loaded === undefined) {
    loaded = /** @type {Record<string, unknown>} */ (await import(new URL(`../src/lib/${name}.js`, import.meta.url).href));
    modules.set(name, loaded);
  }
  return loaded;
}

/**
 * @param {string} text
 * @returns {Uint8Array}
 */
function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The argument a tagged JSON value stands for (see the module comment); plain values as they are.
 * @param {unknown} value
 * @returns {unknown}
 */
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const [key] = keys;
    const inner = value[/** @type {string} */ (key)];
    if (key === "$bytes" && typeof inner === "string") return fromBase64(inner);
    if (key === "$rng" && Array.isArray(inner)) {
      const draws = inner.map(Number);
      let next = 0;
      return {
        /** @param {number} low @param {number} high */
        uniform(low, high) {
          if (next >= draws.length) throw new Error("the scripted rng ran out of values");
          return low + (high - low) * /** @type {number} */ (draws[next++]);
        },
      };
    }
    if (key === "$clock" && Array.isArray(inner)) {
      const times = inner.map(Number);
      let next = 0;
      return () => /** @type {number} */ (times[Math.min(next++, times.length - 1)]);
    }
    if (key === "$exists" && Array.isArray(inner)) {
      const present = new Set(inner.map(String));
      return (/** @type {{path: string | null}} */ entry) => entry.path !== null && present.has(entry.path);
    }
    if (key === "$pacing" && isObject(inner)) return new PacingState(/** @type {object} */ (inner));
  }
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, decode(inner)]));
}

/**
 * The JSON form of a result: bytes tagged, Sets and Maps plain, `omit` keys dropped.
 * @param {unknown} value
 * @param {Set<string>} omit
 * @returns {unknown}
 */
function encode(value, omit) {
  if (value === undefined) return null;
  if (value instanceof Uint8Array) return { $bytes: toBase64(value) };
  if (value instanceof Set) return [...value].map((inner) => encode(inner, omit));
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([key, inner]) => [String(key), encode(inner, omit)]));
  }
  if (Array.isArray(value)) return value.map((inner) => encode(inner, omit));
  if (value !== null && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, inner] of Object.entries(value)) if (!omit.has(key)) out[key] = encode(inner, omit);
    return out;
  }
  if (typeof value === "function") return null;
  return value;
}

/**
 * @typedef {import("../src/lib/pacing.js").PacingOptions} PacingOptions
 * @typedef {import("../src/lib/pacing.js").Rng} Rng
 * @typedef {import("../src/lib/pacing.js").Clock} Clock
 * @typedef {import("../src/lib/state.js").RecordedResult} RecordedResult
 */

/**
 * A sequence of state operations, then everything the state answers.
 * @param {{raw?: unknown, seriesId: string, seriesName?: string | null, ops: Record<string, unknown>[],
 *   existing: string[], numbers: number[]}} plan
 */
function stateRun(plan) {
  const present = new Set(plan.existing);
  const exists = (/** @type {{path: string | null}} */ entry) => entry.path !== null && present.has(entry.path);
  const state = loadState(plan.raw ?? null, plan.seriesId, plan.seriesName ?? null);
  const recorded = [];
  for (const op of plan.ops) {
    if (op["op"] === "record") {
      const result = /** @type {RecordedResult} */ (op["result"]);
      recorded.push(record(state, result, { exists, now: Number(op["now"]) }));
    } else if (op["op"] === "markComplete") {
      markComplete(state, Number(op["when"]), Number(op["episodes"]));
    } else if (op["op"] === "clearComplete") {
      recorded.push(clearComplete(state));
    } else {
      throw new Error(`unknown state op ${JSON.stringify(op["op"])}`);
    }
  }
  return {
    state,
    recorded,
    reread: readState(JSON.parse(JSON.stringify(state)), plan.seriesId),
    doneEntries: doneEntries(state, exists),
    missingFiles: missingFiles(state, exists),
    lockedNumbers: lockedNumbers(state),
    drmProtected: plan.numbers.map((number) => drmProtected(state, number)),
    isDone: plan.numbers.map((number) => isDone(state, number, exists)),
    completeSince: completeSince(state),
  };
}

/**
 * Calls whose answer must include the state they changed (the PacingState, the series state).
 * @type {Record<string, (args: unknown[]) => unknown>}
 */
const ADAPTERS = {
  pauseBeforeAttempt([options, rng, pacing, clock, attempts, previous]) {
    const state = /** @type {PacingState} */ (pacing);
    const pause = pauseBeforeAttempt(
      /** @type {PacingOptions} */ (options),
      /** @type {Rng} */ (rng),
      state,
      /** @type {Clock} */ (clock),
      Number(attempts),
      /** @type {{durationS: number | null} | null} */ (previous),
    );
    return { pause, pacing: state };
  },
  longRestDue([options, pacing, clock]) {
    const state = /** @type {PacingState} */ (pacing);
    return { due: longRestDue(/** @type {PacingOptions} */ (options), state, /** @type {Clock} */ (clock)), pacing: state };
  },
  pauseBetweenSeries([options, rng, pacing, clock]) {
    const state = /** @type {PacingState} */ (pacing);
    const pause = pauseBetweenSeries(/** @type {PacingOptions} */ (options), /** @type {Rng} */ (rng), state, /** @type {Clock} */ (clock));
    return { pause, pacing: state };
  },
  pauseBetweenJobs([options, rng, pacing, clock, job]) {
    const state = /** @type {PacingState} */ (pacing);
    const pause = pauseBetweenJobs(
      /** @type {PacingOptions} */ (options),
      /** @type {Rng} */ (rng),
      state,
      /** @type {Clock} */ (clock),
      /** @type {{lastContactAt: number | null, batchJob: boolean}} */ (job),
    );
    return { pause, pacing: state };
  },
  afterResult([options, pacing, clock, result]) {
    const state = /** @type {PacingState} */ (pacing);
    const outcome = afterResult(
      /** @type {PacingOptions} */ (options),
      state,
      /** @type {Clock} */ (clock),
      /** @type {{episode: {number: number}, status: string, message: string}} */ (result),
    );
    return { ...outcome, pacing: state };
  },
  stateRun([plan]) {
    return stateRun(/** @type {Parameters<typeof stateRun>[0]} */ (plan));
  },
  reportRows([series, results, raw, seriesId, exists]) {
    const state = readState(raw, String(seriesId));
    return reportRows(
      /** @type {import("../src/lib/catalog.js").Series} */ (series),
      /** @type {import("../src/lib/report.js").DownloadResult[]} */ (results),
      state,
      /** @type {import("../src/lib/state.js").FileExists} */ (exists),
    );
  },
  completeSkip([raw, context, exists]) {
    const where = /** @type {{seriesId: string, nowS: number}} */ (context);
    const skipped = completeSkip(readState(raw, where.seriesId), {
      seriesId: where.seriesId,
      nowS: where.nowS,
      exists: /** @type {import("../src/lib/state.js").FileExists} */ (exists),
    });
    if (skipped === null) return null;
    return {
      results: skipped.results.map((r) => [r.episode.number, r.episode.itemId, r.episode.title, r.status, r.message]),
      report: reportToDict(skipped.report),
      name: skipped.name,
    };
  },
  afterResults([options, pacing, clock, results]) {
    const state = /** @type {PacingState} */ (pacing);
    let made = 0;
    for (const result of /** @type {{episode: {number: number}, status: string, message: string}[]} */ (results)) {
      made += 1;
      const outcome = afterResult(/** @type {PacingOptions} */ (options), state, /** @type {Clock} */ (clock), result);
      if (outcome.stop !== null) return { stop: outcome.stop, made, pacing: state };
    }
    return { stop: null, made, pacing: state };
  },
  seriesReportToDict([series, results, options]) {
    const report = seriesReport(
      /** @type {import("../src/lib/catalog.js").Series | null} */ (series),
      /** @type {import("../src/lib/report.js").DownloadResult[]} */ (results),
      /** @type {Parameters<typeof seriesReport>[2]} */ (options),
    );
    return reportToDict(report);
  },
};

/**
 * @param {Call} call
 * @returns {Promise<unknown>}
 */
async function run(call) {
  const args = (call.args ?? []).map(decode);
  if (call.fn === "$const") {
    const [module, name] = String(args[0]).split(".");
    const loaded = await moduleNamed(String(module));
    if (!Object.hasOwn(loaded, String(name))) throw new Error(`${String(args[0])} is not exported`);
    return loaded[String(name)];
  }
  const [module, name] = call.fn.split(".");
  if (module === "parity") {
    const adapter = Object.hasOwn(ADAPTERS, String(name)) ? ADAPTERS[String(name)] : undefined;
    if (adapter === undefined) throw new Error(`no adapter ${call.fn}`);
    return adapter(args);
  }
  const loaded = await moduleNamed(String(module));
  const fn = Object.hasOwn(loaded, String(name)) ? loaded[String(name)] : undefined;
  if (typeof fn !== "function") throw new Error(`${call.fn} is not an exported function`);
  return await /** @type {(...args: unknown[]) => unknown} */ (fn)(...args);
}

/** @type {unknown} */
const calls = JSON.parse(readFileSync(0, "utf8"));
if (!Array.isArray(calls)) throw new Error("expected a JSON list of calls on stdin");
const results = [];
for (const call of /** @type {Call[]} */ (calls)) {
  const omit = new Set(call.omit ?? []);
  try {
    results.push({ ok: true, value: encode(await run(call), omit) });
  } catch (error) {
    results.push({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : typeof error,
    });
  }
}
writeAll(new TextEncoder().encode(JSON.stringify(results)));

/**
 * Write every byte to stdout: a pipe may take a large answer in several writes (or ask to wait).
 * @param {Uint8Array} bytes
 */
function writeAll(bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset, bytes.length - offset);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EAGAIN")) throw error;
    }
  }
}
