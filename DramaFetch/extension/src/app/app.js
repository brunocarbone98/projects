// @ts-check
/**
 * The DramaFetch tab: the text box (one link or id per line, the CLI's `--from-file` rules), the
 * episode list of one series (**Load list**), the jobs — one at a time, FIFO, the web job
 * manager's rules — and their progress (the episodes a job did not download shown apart from the
 * ones that completed, with the button that queues them again), the cooldown banner, the settings,
 * the history of the last 20 runs — each past run's failures retryable the same way —, and (only
 * in the test harness' copy) the test settings. The engine runs here while the tab is open; one
 * tab per browser holds it (a Web Lock), a second one stays read-only.
 */

import { isLocked } from "../lib/catalog.js";
import { COOLDOWN_STORAGE_KEY, activeCooldown, cooldownMessage, minutesLeft, secondsLeft } from "../lib/cooldown.js";
import { buildReport, hasFailures, reportFilename, reportJson, reportStem } from "../lib/diagnosis.js";
import { displayText, statusLabel } from "../lib/display.js";
import { TIKTOK_BASE_URL } from "../lib/messages.js";
import { fileBaseName } from "../lib/naming.js";
import {
  PAGE_DELAY_S,
  PacingState,
  defaultRng,
  describeBatchPacing,
  describePacing,
  pacingOptions,
  pagePause,
  sleepSeconds,
} from "../lib/pacing.js";
import { batchStatus, notStartedMessage, reportLine, reportToDict } from "../lib/report.js";
import { doneEntries, readState } from "../lib/state.js";
import { parseSeriesList } from "../lib/urls.js";
import { closeLeftoverDiscoveryTab, discoverSeries } from "./discovery.js";
import { CoverLoader, DownloadsView, Downloader, applyRefererRule, oneLine, saveFile } from "./downloader.js";
import { initPageRedirects } from "./redirects.js";
import {
  StopRequested,
  checkCooldown,
  episodeContext,
  resolve,
  restBetweenJobs,
  runBatch,
  runSelectionJob,
  storageRefusedReason,
} from "./engine.js";
import { displayLabels, displayLanguage, localize, t } from "./i18n.js";
import {
  DEFAULT_SETTINGS,
  appendHistory,
  cooldownStore,
  isTestMode,
  loadPacing,
  loadSettings,
  loadTestSettings,
  readHistory,
  readSeriesState,
  savePacing,
  saveSettings,
  saveTestSettings,
  writeSeriesState,
} from "./storage.js";
import { TabKeeper } from "./tabkeeper.js";

/** The Web Lock that makes this tab the only engine of the browser. */
const ENGINE_LOCK = "dramafetch-engine";

/**
 * @typedef {import("../lib/catalog.js").Episode} Episode
 * @typedef {import("../lib/catalog.js").Series} Series
 * @typedef {import("../lib/urls.js").SeriesRef} SeriesRef
 * @typedef {import("../lib/report.js").DownloadResult} DownloadResult
 * @typedef {import("./engine.js").SeriesRun} SeriesRun
 * @typedef {import("./engine.js").Engine} Engine
 * @typedef {import("./storage.js").Settings} Settings
 * @typedef {import("./storage.js").TestSettings} TestSettings
 *
 * @typedef {object} Job
 * @property {number} id
 * @property {"load" | "batch" | "selection"} kind
 * @property {string} label
 * @property {SeriesRef[]} refs
 * @property {Series | null} series
 * @property {number[]} numbers
 * @property {boolean} includeLocked
 * @property {boolean} recheck
 * @property {boolean} [contacted] whether the job made a request to TikTok (set while it runs)
 *
 * @typedef {object} JobRecord What a finished job leaves in the history.
 * @property {{kind: string, seconds: number, text: string}[]} pauses
 *
 * @typedef {object} JobOutcome How a job ended, as its history entry records it ({@link reportJobEnd}).
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {string | null} error
 * @property {string | null} stopped
 * @property {number} refreshes
 * @property {{kind: string, seconds: number, text: string}[]} pauses
 *
 * @typedef {import("../lib/diagnosis.js").EpisodeTrace} EpisodeTrace
 * @typedef {import("../lib/diagnosis.js").SeriesInput} SeriesInput
 *
 * @typedef {object} FailedRow An episode of a finished job that did not download ({@link failedRows}).
 * @property {string} seriesId
 * @property {string | null} name the series' stored name, when the job learnt it
 * @property {number} number
 * @property {string} status a `failed-*` status
 * @property {string} message
 *
 * @typedef {object} RetryTarget What a retry queues for one series ({@link retryTargets}).
 * @property {string} seriesId
 * @property {string | null} name the series' stored name, when the job learnt it
 * @property {number[]} numbers the episodes that did not download, ascending, de-duplicated
 */

const app = {
  testMode: false,
  owner: false,
  /** @type {Settings} */
  settings: { ...DEFAULT_SETTINGS },
  /** @type {TestSettings} */
  testSettings: {},
  /** @type {{series: Series, resolvedAt: number} | null} */
  loaded: null,
  /** @type {RetryTarget[] | null} the last finished job's episodes that did not download (the progress card's retry button) */
  failed: null,
  /** @type {{report: Record<string, unknown>, stem: string} | null} the last finished job's "did not download" report (**Save the report**) */
  lastReport: null,
  /** @type {Job[]} */
  queue: [],
  /** @type {Job | null} */
  running: null,
  finished: 0,
  nextJobId: 1,
  pacing: new PacingState(),
  /** @type {number | null} when DramaFetch last contacted TikTok (a request, or a finished job that made one) */
  lastContactAt: null,
  stopRequested: false,
  /**
   * Why `chrome.storage.local` refused a write of this page (the pacing, a series' state), once it
   * did ({@link storageRefusedReason}) — kept until the page is reloaded: what Chrome accepts after
   * a refused write may not survive its restart, so this page asks nothing more of TikTok.
   * @type {string | null}
   */
  unsaved: null,
  /** @type {Set<() => void>} */
  stopWaiters: new Set(),
  /** @type {import("../lib/cooldown.js").Cooldown | null} */
  cooldown: null,
  /** @type {number | undefined} */
  windowId: undefined,
  /** @type {number | undefined} */
  tabId: undefined,
  /** @type {number | null} when the current pause ends (seconds) */
  pauseUntil: null,
  pauseText: "",
};

/**
 * How the engine's texts are shown: their language and the UI's names of the controls they point
 * to (set once the page is localized, {@link main}).
 * @type {import("../lib/display.js").DisplayOptions}
 */
const shown = { lang: "en", labels: {} };

/**
 * An engine text (stored in English, byte for byte the Python tool's) as this page shows it.
 * @param {string} text
 * @returns {string}
 */
function shownText(text) {
  return displayText(text, shown);
}

/** Keeps Chrome from discarding this tab while a job runs or waits (Memory Saver would end the run). */
const keeper = new TabKeeper();

/**
 * The history's retry buttons as rendered last: `updateButtons` applies the download buttons' rule
 * to them (no engine in this tab, a cooldown in force) and lifts it when the cooldown ends.
 * @type {Set<HTMLButtonElement>}
 */
const historyRetryButtons = new Set();
/**
 * The retry buttons already clicked: disabled until the next job ends, when the progress card and
 * the history are rendered again, their buttons new.
 * @type {WeakSet<HTMLButtonElement>}
 */
const spentRetries = new WeakSet();

// ------------------------------------------------------------------------ DOM helpers

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function $(id) {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`#${id} is missing`);
  return element;
}
/** @param {string} id @returns {HTMLInputElement} */
const input = (id) => /** @type {HTMLInputElement} */ ($(id));
/** @param {string} id @returns {HTMLButtonElement} */
const button = (id) => /** @type {HTMLButtonElement} */ ($(id));
/** @param {string} id @returns {HTMLSelectElement} */
const select = (id) => /** @type {HTMLSelectElement} */ ($(id));
/** @param {string} id @returns {HTMLTextAreaElement} */
const textarea = (id) => /** @type {HTMLTextAreaElement} */ ($(id));

/**
 * @param {string} tag
 * @param {{text?: string, className?: string, title?: string, attrs?: Record<string, string>}} [options]
 * @param {(Node | string)[]} [children]
 * @returns {HTMLElement}
 */
function el(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.text !== undefined) element.textContent = options.text;
  if (options.className) element.className = options.className;
  if (options.title) element.title = options.title;
  for (const [name, value] of Object.entries(options.attrs ?? {})) element.setAttribute(name, value);
  for (const child of children) element.append(child);
  return element;
}

/**
 * @param {HTMLElement} element
 * @param {string} text
 * @param {"" | "ok" | "error"} [kind]
 */
function setStatus(element, text, kind = "") {
  element.textContent = text;
  element.className = `status ${kind}`.trim();
}

/** @returns {number} seconds since the epoch */
const now = () => Date.now() / 1000;

/**
 * `m:ss` for an episode length.
 * @param {number | null} seconds
 * @returns {string}
 */
function duration(seconds) {
  if (seconds === null || seconds <= 0) return "–";
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * `E01`: an episode number as the progress rows and the history show it.
 * @param {number} number
 * @returns {string}
 */
function episodeLabel(number) {
  return `E${String(number).padStart(2, "0")}`;
}

// ------------------------------------------------------------------- effective options

/** @returns {string} TikTok's origin, or the test server's (test mode only) */
function baseUrl() {
  return app.testMode && app.testSettings.baseUrl ? app.testSettings.baseUrl : TIKTOK_BASE_URL;
}

/** @returns {import("../lib/pacing.js").PacingOptions} the user's pauses over the floors (+ test overrides) */
function effectivePacing() {
  const settings = app.settings;
  /** @type {Partial<import("../lib/pacing.js").PacingOptions>} */
  const options = {
    pace: settings.pace,
    delayMinS: settings.delayMinS,
    delayMaxS: settings.delayMaxS,
    restEvery: settings.restEvery,
    restMinS: settings.restMinS,
    restMaxS: settings.restMaxS,
  };
  if (app.testMode) {
    const test = app.testSettings;
    for (const key of /** @type {const} */ ([
      "delayMinS",
      "delayMaxS",
      "restEvery",
      "restMinS",
      "restMaxS",
      "maxConsecutiveFailures",
      "longRestEvery",
      "longRestMinS",
      "longRestMaxS",
    ])) {
      const value = test[key];
      if (value !== undefined) options[key] = value;
    }
  }
  return pacingOptions(options);
}

/**
 * The cancellable sleep of every pause (timer-sized pieces up to its deadline: never shorter, even
 * for a pause longer than one timer can hold): Stop ends it at once.
 * @param {number} seconds
 * @returns {Promise<void>}
 */
function sleep(seconds) {
  if (app.stopRequested) return Promise.reject(new StopRequested());
  const controller = new AbortController();
  const cancel = () => controller.abort(new StopRequested());
  app.stopWaiters.add(cancel);
  return sleepSeconds(seconds, { signal: controller.signal }).finally(() => app.stopWaiters.delete(cancel));
}

/**
 * The job made (or is about to make) a request to TikTok: remember when, in storage too, so the
 * rest between jobs holds even when this tab is closed mid-job.
 * @param {Job} job
 * @returns {Promise<void>}
 */
async function noteContact(job) {
  job.contacted = true;
  app.lastContactAt = now();
  await storePacing();
}

/**
 * `chrome.storage.local` refused a write: remembered in {@link app}.unsaved, the first reason kept.
 * @param {unknown} error what the write rejected with
 */
function noteRefusedWrite(error) {
  app.unsaved = app.unsaved ?? storageRefusedReason(error);
}

/**
 * Save the run's pacing. A write the storage refuses never throws — the pacing in force is this
 * page's own, `app.pacing`, so no pause gets shorter — but it is remembered: the engine stops
 * before its next request and the job's end says why.
 * @returns {Promise<void>}
 */
async function storePacing() {
  try {
    await savePacing(app.pacing, app.lastContactAt);
  } catch (error) {
    noteRefusedWrite(error);
  }
}

/**
 * @param {Job} job
 * @param {JobRecord} jobRecord
 * @returns {Engine}
 */
function buildEngine(job, jobRecord) {
  const base = baseUrl();
  const test = app.testMode ? app.testSettings : {};
  const networkBefore = app.pacing.lastNetworkAt;
  const view = new DownloadsView({ existenceDelayMs: test.existenceDelayMs ?? 300, rateLimitS: test.existenceRateLimitS });
  /** @type {import("./discovery.js").DiscoveryOptions} */
  const discoveryOptions = { baseUrl: base, rng: defaultRng, sleep, windowId: app.windowId, returnTabId: app.tabId };
  if (test.discoveryTimeoutS !== undefined) discoveryOptions.timeoutS = test.discoveryTimeoutS;
  if (test.activateAfterS !== undefined) discoveryOptions.activateAfterS = test.activateAfterS;
  if (test.detailGraceS !== undefined) discoveryOptions.detailGraceS = test.detailGraceS;
  if (test.pageDelayS !== undefined) discoveryOptions.pageDelayS = test.pageDelayS;
  /** A listing contacts TikTok from its first request to its last: noted at both ends. */
  const discover = async (/** @type {SeriesRef} */ ref) => {
    await noteContact(job);
    try {
      return await discoverSeries(ref, discoveryOptions);
    } finally {
      await noteContact(job);
    }
  };
  const downloader = new Downloader({
    baseUrl: base,
    quality: app.settings.quality,
    thumbnail: app.settings.thumbnail,
    nameFormat: app.settings.nameFormat,
    includeLocked: job.includeLocked,
    hostPatterns: chrome.runtime.getManifest().host_permissions ?? [],
    view,
    rediscover: discover,
    onStatus: (text) => {
      $("progress-activity").textContent = text;
    },
  });
  return {
    pacing: effectivePacing(),
    testMode: app.testMode,
    includeLocked: job.includeLocked,
    recheck: job.recheck,
    pacingState: app.pacing,
    rng: defaultRng,
    sleep,
    clock: now,
    wallClock: now,
    cooldownStore: cooldownStore(),
    discover,
    downloader,
    view,
    readState: readSeriesState,
    writeState: async (state) => {
      try {
        await writeSeriesState(state);
      } catch (error) {
        noteRefusedWrite(error);
        throw error; // the engine makes it the run's stop
      }
    },
    unsaved: () => app.unsaved,
    persist: async () => {
      // after every network attempt (and pause): a download contacted TikTok at lastNetworkAt
      const network = app.pacing.lastNetworkAt;
      if (network !== null && network !== networkBefore) {
        job.contacted = true;
        if (app.lastContactAt === null || network > app.lastContactAt) app.lastContactAt = network;
      }
      await storePacing();
    },
    stopRequested: () => app.stopRequested,
    onPause: (kind, seconds, text) => {
      jobRecord.pauses.push({ kind, seconds: Math.round(seconds * 10) / 10, text });
      app.pauseUntil = now() + seconds;
      app.pauseText = text;
      renderPause();
    },
    onStart: (start) => {
      clearPause();
      $("progress-current").textContent = t("progressSeries", start.name);
      const body = /** @type {HTMLTableSectionElement} */ ($("result-table").querySelector("tbody"));
      body.append(
        el("tr", { className: "series-row", attrs: { "data-series-id": start.ref.seriesId } }, [
          el("td", { attrs: { colspan: "3" }, text: start.skippedComplete ? t("seriesSkippedComplete", start.name) : start.name }),
        ]),
      );
    },
    onResult: (result) => {
      clearPause();
      renderResult(result);
    },
    onSeriesStart: (index, total, ref) => {
      $("progress-current").textContent = t("progressBatch", [index, total, ref.seriesId]);
    },
    onSeriesDone: (_index, _total, run) => {
      clearPause();
      renderReportLine(run);
    },
  };
}

// --------------------------------------------------------------------------- progress

function clearPause() {
  app.pauseUntil = null;
  app.pauseText = "";
  renderPause();
}

function renderPause() {
  const element = $("progress-pause");
  if (app.pauseUntil === null) {
    element.hidden = true;
    element.textContent = "";
    return;
  }
  const left = Math.max(0, Math.ceil(app.pauseUntil - now()));
  element.hidden = false;
  element.textContent = t("pauseInForce", [shownText(app.pauseText), left]);
}

/**
 * @param {string} status
 * @returns {string} the CSS class of a status badge
 */
function statusClass(status) {
  if (status === "done") return "done";
  if (status.startsWith("skipped")) return "skipped";
  return "failed";
}

/**
 * A status badge: a short label in the page's language, the status code itself in its title.
 * @param {string} status
 * @param {string} message the result's message (a row the run stopped before reads “stopped”)
 * @returns {HTMLElement}
 */
function statusBadge(status, message) {
  return el("span", {
    className: `badge ${statusClass(status)}`,
    text: statusLabel(status, { lang: shown.lang, message }),
    title: status,
    attrs: { "data-status": status },
  });
}

/** @param {DownloadResult} result */
function renderResult(result) {
  const body = /** @type {HTMLTableSectionElement} */ ($("result-table").querySelector("tbody"));
  const key = `${result.episode.seriesId}:${result.episode.number}`;
  const row = el(
    "tr",
    { attrs: { "data-key": key, "data-series-id": result.episode.seriesId, "data-number": String(result.episode.number), "data-status": result.status } },
    [
      el("td", { text: episodeLabel(result.episode.number) }),
      el("td", {}, [statusBadge(result.status, result.message)]),
      el("td", { className: "message", text: shownText(result.message) }),
    ],
  );
  const existing = body.querySelector(`tr[data-key="${CSS.escape(key)}"]`);
  if (existing !== null) existing.replaceWith(row);
  else body.append(row);
}

/** @param {SeriesRun} run */
function renderReportLine(run) {
  const name = run.report.name || run.series?.name || run.ref.seriesId;
  const text = `${name}: ${shownText(run.error !== null ? run.error : reportLine(run.report))}`;
  $("report-lines").append(el("li", { text, attrs: { "data-series-id": run.ref.seriesId } }));
}

/** @param {readonly SeriesRun[]} runs */
function renderBatchTable(runs) {
  const table = $("batch-table");
  const body = /** @type {HTMLTableSectionElement} */ (table.querySelector("tbody"));
  body.textContent = "";
  for (const run of runs) {
    const report = run.report;
    const status = batchStatus({ ...run, errorKind: run.errorKind });
    body.append(
      el("tr", { attrs: { "data-series-id": run.ref.seriesId } }, [
        el("td", { text: report.name || run.series?.name || run.ref.seriesId }),
        el("td", { text: shownText(status), attrs: { "data-status": status } }), // the stored English: data, not shown
        el("td", { text: String(report.listed) }),
        el("td", { text: String(report.done) }),
        el("td", { text: String(report.onDisk) }),
        el("td", { text: String(report.locked) }),
        el("td", { text: String(report.failed) }),
      ]),
    );
  }
  table.hidden = runs.length === 0;
}

/** @param {Job} job */
function startProgress(job) {
  $("progress-card").hidden = false;
  /** @type {HTMLTableSectionElement} */ ($("result-table").querySelector("tbody")).textContent = "";
  $("report-lines").textContent = "";
  $("batch-table").hidden = true;
  $("failed-block").hidden = true; // the last job's episodes that did not download; this job's come at its end
  /** @type {HTMLTableSectionElement} */ ($("failed-table").querySelector("tbody")).textContent = "";
  $("failed-heading").textContent = "";
  app.failed = null;
  const report = $("failed-report"); // the last job's report line: this job's report comes at its end
  report.hidden = true;
  report.textContent = "";
  app.lastReport = null;
  updateButtons(); // `#report-button` disabled while no report exists
  $("progress-activity").textContent = "";
  $("progress-current").textContent = job.label;
  clearPause();
}

// ------------------------------------------------- the episodes that did not download

/**
 * Whether a row's status is a failure: every `failed-*` status of `lib/messages.STATUSES` — the
 * rows a stop left `stopped: …` keep one too. Done, skipped and dry-run rows are not.
 * @param {unknown} status
 * @returns {status is string}
 */
function isFailure(status) {
  return typeof status === "string" && status.startsWith("failed");
}

/**
 * The rows of a finished job's per-series records (`entry.series`, {@link runToHistory}) whose
 * episode did not download: in the order of the series, each series' ascending, one per episode
 * (the last row written for it). A record without rows — a failed resolve, a series the batch
 * never started, a listing — contributes nothing. Stored data: anything malformed is skipped.
 * @param {readonly unknown[]} seriesRecords
 * @returns {FailedRow[]}
 */
function failedRows(seriesRecords) {
  /** @type {Map<string, {name: string | null, rows: Map<number, FailedRow>}>} */
  const bySeries = new Map();
  for (const item of seriesRecords) {
    if (item === null || typeof item !== "object") continue;
    const record = /** @type {Record<string, unknown>} */ (item);
    const seriesId = record["series_id"];
    const stored = record["rows"];
    if (typeof seriesId !== "string" || seriesId === "" || !Array.isArray(stored)) continue;
    for (const raw of stored) {
      if (raw === null || typeof raw !== "object") continue;
      const row = /** @type {Record<string, unknown>} */ (raw);
      const status = row["status"];
      const number = row["number"];
      if (!isFailure(status) || typeof number !== "number" || !Number.isInteger(number)) continue;
      let series = bySeries.get(seriesId);
      if (series === undefined) {
        series = { name: typeof record["name"] === "string" && record["name"] !== "" ? record["name"] : null, rows: new Map() };
        bySeries.set(seriesId, series);
      }
      series.rows.set(number, { seriesId, name: series.name, number, status, message: typeof row["message"] === "string" ? row["message"] : "" });
    }
  }
  return [...bySeries.values()].flatMap((series) => [...series.rows.values()].sort((a, b) => a.number - b.number));
}

/**
 * @param {readonly FailedRow[]} rows
 * @returns {RetryTarget[]} one per series, in the rows' order
 */
function targetsOf(rows) {
  /** @type {Map<string, RetryTarget>} */
  const targets = new Map();
  for (const row of rows) {
    let target = targets.get(row.seriesId);
    if (target === undefined) {
      target = { seriesId: row.seriesId, name: row.name, numbers: [] };
      targets.set(row.seriesId, target);
    }
    target.numbers.push(row.number);
  }
  return [...targets.values()];
}

/**
 * What a retry queues for the records of a finished job: the series with at least one episode
 * that did not download, in the order of the series, each with those episodes' numbers,
 * ascending and de-duplicated. (Exported for the unit tests, which cannot run a job.)
 * @param {readonly unknown[]} seriesRecords
 * @returns {RetryTarget[]}
 */
export function retryTargets(seriesRecords) {
  return targetsOf(failedRows(seriesRecords));
}

/**
 * The jobs a retry queues: one selection job per series, in the order of the series, over exactly
 * that series' episodes that did not download — what pasting the link and **Download selected**
 * with those numbers does ({@link runSelectionJob}: the cooldown gate, the rest between jobs, a
 * fresh resolve, then the downloads; an episode meanwhile on disk is skipped), the locked ones
 * not asked for.
 * @param {readonly RetryTarget[]} targets
 * @returns {Omit<Job, "id">[]}
 */
export function retryJobs(targets) {
  /** @type {Omit<Job, "id">[]} */
  const jobs = [];
  for (const target of targets) {
    const seriesId = target.seriesId;
    jobs.push({
      kind: "selection",
      label: t("jobRetry", [target.numbers.length, target.name ?? seriesId]),
      refs: [{ kind: "series", seriesId, episodeHint: null, sourceUrl: seriesId }],
      series: null,
      numbers: [...target.numbers],
      includeLocked: false,
      recheck: false,
    });
  }
  return jobs;
}

/**
 * `E02, E07` (one series), or `<name>: E02, E07` series after series when `named`.
 * @param {readonly RetryTarget[]} targets
 * @param {boolean} named
 * @returns {string}
 */
function failedEpisodesText(targets, named) {
  return targets
    .map((target) => {
      const episodes = target.numbers.map(episodeLabel).join(", ");
      return named ? `${target.name ?? target.seriesId}: ${episodes}` : episodes;
    })
    .join("; ");
}

/**
 * Queue the retry of `targets` and spend `source`, the button that asked for it, until the next
 * job ends (the progress card and the history are rendered again then, their buttons new). The
 * gate of every download button holds: never from a read-only tab, never during a cooldown.
 * @param {readonly RetryTarget[]} targets
 * @param {HTMLButtonElement} source
 */
function startRetry(targets, source) {
  if (!app.owner || app.cooldown !== null || spentRetries.has(source)) return;
  source.disabled = true;
  spentRetries.add(source);
  for (const job of retryJobs(targets)) enqueue(job);
}

/**
 * A past run's retry button: the progress card's text and behaviour, over that run's stored rows.
 * @param {readonly RetryTarget[]} targets
 * @returns {HTMLButtonElement}
 */
function historyRetryButton(targets) {
  const count = targets.reduce((sum, target) => sum + target.numbers.length, 0);
  const retry = /** @type {HTMLButtonElement} */ (el("button", { className: "retry", text: t("retryButton", [count]), attrs: { type: "button" } }));
  retry.addEventListener("click", () => startRetry(targets, retry));
  historyRetryButtons.add(retry);
  return retry;
}

/**
 * The job ended: its episodes that did not download, shown apart from the ones that completed.
 * Every failure row — a `failed-*` status, the rows a stop left `stopped: …` included — leaves
 * `#result-table` for `#failed-table`, under a heading with their count and the button that
 * queues them again ({@link retryJobs}); the result table keeps what completed (done, skipped,
 * dry run). Nothing failed, or nothing was downloaded (a listing, a job the cooldown refused):
 * the block stays hidden. (Exported for the unit tests, which cannot run a job.)
 * @param {readonly unknown[]} seriesRecords the job's per-series records ({@link runToHistory})
 */
export function renderFailed(seriesRecords) {
  const rows = failedRows(seriesRecords);
  const retry = button("retry-button");
  const body = /** @type {HTMLTableSectionElement} */ ($("failed-table").querySelector("tbody"));
  body.textContent = "";
  spentRetries.delete(retry);
  app.failed = rows.length > 0 ? targetsOf(rows) : null;
  $("failed-block").hidden = rows.length === 0;
  if (rows.length > 0) {
    const leaving = new Set(rows.map((row) => `${row.seriesId}:${row.number}`));
    const results = /** @type {HTMLTableSectionElement} */ ($("result-table").querySelector("tbody"));
    results.replaceChildren(
      ...[...results.children].filter((row) => !leaving.has(`${row.getAttribute("data-series-id")}:${row.getAttribute("data-number")}`)),
    );
    for (const row of rows) {
      body.append(
        el("tr", { attrs: { "data-series-id": row.seriesId, "data-number": String(row.number), "data-status": row.status } }, [
          el("td", { text: row.name ?? row.seriesId }),
          el("td", { text: episodeLabel(row.number) }),
          el("td", {}, [statusBadge(row.status, row.message)]),
          el("td", { className: "message", text: shownText(row.message) }),
        ]),
      );
    }
    $("failed-heading").textContent = t("failedHeading", [rows.length]);
    retry.textContent = t("retryButton", [rows.length]);
  }
  updateButtons();
}

// ------------------------------------------------------- the "did not download" report

/**
 * What the report reads of one series of the job: the run's rows with their episodes and traces,
 * and the list's size and access counts when the series was listed.
 * @param {SeriesRun} run
 * @param {(episode: Episode) => EpisodeTrace | null} traceOf
 * @returns {SeriesInput}
 */
function seriesInput(run, traceOf) {
  const episodes = run.series?.episodes ?? null;
  /** @type {{free: number, unlocked: number, locked: number} | null} */
  let access = null;
  if (episodes !== null) {
    access = { free: 0, unlocked: 0, locked: 0 };
    for (const episode of episodes) access[episode.access] += 1;
  }
  return {
    seriesId: run.ref.seriesId,
    name: run.report.name || run.series?.name || null,
    line: run.error !== null ? null : reportLine(run.report),
    status: batchStatus({ ...run, errorKind: run.errorKind }),
    error: run.error,
    stop: run.stop,
    contacted: run.contacted,
    listed: episodes?.length ?? null,
    access,
    listedEpisodes: episodes, // the raw items of every listed episode: the report's digest
    episodes: run.results.map((result) => ({
      number: result.episode.number,
      itemId: result.episode.itemId,
      title: result.episode.title,
      durationS: result.episode.durationS,
      access: result.episode.access,
      paid: result.episode.paid,
      drm: result.episode.drm,
      lockHints: result.episode.lockHints,
      qualityHint: result.episode.qualityHint,
      raw: result.episode.raw,
      status: result.status,
      message: result.message,
      path: result.path ?? null,
      trace: traceOf(result.episode),
    })),
  };
}

/**
 * The job ended: the report of the episodes it did not download (`lib/diagnosis`), from the runs
 * it produced and the downloader's traces — kept in `app.lastReport` for **Save the report** when
 * at least one episode failed, and saved at once under `DramaFetch/reports/` when the `report`
 * setting is on. A listing, a job that produced no run (it threw before, or the cooldown refused
 * it) or a job in which nothing failed leaves no report. Never throws: the save must not break the
 * job's end. (Exported for the unit tests, which cannot run a job.)
 * @param {Pick<Job, "kind" | "label">} job
 * @param {JobOutcome} outcome
 * @param {readonly SeriesRun[] | null} runs the `SeriesRun`s the job produced, in order
 * @param {(episode: Episode) => EpisodeTrace | null} traceOf the downloader's traces
 * @returns {Promise<void>}
 */
export async function reportJobEnd(job, outcome, runs, traceOf) {
  app.lastReport = null;
  try {
    if (job.kind !== "load" && runs !== null) {
      const series = runs.map((run) => seriesInput(run, traceOf));
      if (hasFailures(series)) {
        const generatedAt = new Date();
        const report = buildReport({
          generatedAt: generatedAt.toISOString(),
          extensionVersion: chrome.runtime.getManifest().version,
          userAgent: navigator.userAgent,
          language: shown.lang ?? "en",
          testMode: app.testMode,
          job: { kind: job.kind, label: job.label, ...outcome },
          series,
        });
        app.lastReport = { report, stem: reportStem(series, generatedAt) };
      }
    }
  } catch (error) {
    console.warn(error); // `#failed-block` may be hidden when the job had no failed row: keep the reason
    showReportOutcome(t("reportNotSaved", [oneLine(error)]), true);
  }
  updateButtons();
  if (app.lastReport !== null && app.settings.report) await saveReport();
}

/**
 * Save `app.lastReport` as `DramaFetch/reports/<stem>.json` (never overwriting: `uniquify`) and
 * say so in `#failed-report` — the file's name as Chrome saved it, or why it could not. Never
 * throws.
 * @returns {Promise<void>}
 */
async function saveReport() {
  const pending = app.lastReport;
  if (pending === null) return;
  try {
    const saved = await saveFile(reportJson(pending.report), "application/json", reportFilename(pending.stem));
    showReportOutcome(t("reportSaved", [fileBaseName(saved.filename)]), false);
  } catch (error) {
    showReportOutcome(t("reportNotSaved", [oneLine(error)]), true);
  }
}

/**
 * @param {string} text
 * @param {boolean} failed
 */
function showReportOutcome(text, failed) {
  const line = $("failed-report");
  line.hidden = false;
  line.className = failed ? "meta error" : "meta";
  line.textContent = text;
}

// ------------------------------------------------------------------------ the job queue

function renderAppStatus() {
  const status = $("app-status");
  const running = app.running !== null;
  status.dataset["state"] = running ? "running" : "idle";
  status.dataset["finished"] = String(app.finished);
  status.textContent = running ? t("statusRunning") : t("statusIdle");
  status.className = `badge ${running ? "running" : "idle"}`;
  button("stop-button").disabled = !running;
  const list = $("queue-list");
  list.textContent = "";
  for (const job of app.queue) list.append(el("li", { text: job.label }));
  $("queue-card").hidden = app.queue.length === 0;
  updateButtons();
  // never discarded while a job runs or waits; discardable again once the queue is done (a Stop
  // and an error end the job too). Only the engine's tab ever runs one: a read-only tab stays
  // discardable.
  void keeper.keep(app.tabId, app.owner && (running || app.queue.length > 0));
}

/**
 * Queue a job — in the engine's tab only: a read-only tab could never run it.
 * @param {Omit<Job, "id">} job
 */
function enqueue(job) {
  if (!app.owner) return;
  app.queue.push({ ...job, id: app.nextJobId++ });
  renderAppStatus();
  void pump();
}

async function pump() {
  if (app.running !== null || !app.owner) return;
  if (app.queue.length === 0) {
    covers.resume(); // nothing to run: the list's thumbnails may go on
    return;
  }
  const job = /** @type {Job} */ (app.queue.shift());
  app.running = job;
  app.stopRequested = false;
  renderAppStatus();
  try {
    await covers.idle(); // a thumbnail request in flight ends first: one request at a time
    await runJob(job);
  } finally {
    app.running = null;
    app.finished += 1;
    app.stopRequested = false;
    renderAppStatus();
    void refreshCooldown();
    void renderHistory();
    void pump();
  }
}

/**
 * Every queued job ends without a request: `not started: …` in the history.
 * @param {string} reason
 */
async function cancelQueue(reason) {
  const cancelled = app.queue.splice(0);
  for (const job of cancelled) {
    await appendHistory({
      id: Date.now(),
      kind: job.kind,
      label: job.label,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      error: reason,
      stopped: null,
      refreshes: 0,
      pauses: [],
      series: [],
    });
  }
}

/**
 * @param {SeriesRun} run
 * @returns {Record<string, unknown>}
 */
function runToHistory(run) {
  return {
    series_id: run.ref.seriesId,
    name: run.report.name || run.series?.name || null,
    status: batchStatus({ ...run, errorKind: run.errorKind }),
    error: run.error,
    error_kind: run.errorKind,
    stop: run.stop,
    contacted: run.contacted,
    line: reportLine(run.report),
    report: reportToDict(run.report),
    rows: run.results.map((result) => ({
      number: result.episode.number,
      status: result.status,
      message: result.message,
      path: result.path ?? null,
      download_id: result.downloadId ?? null,
    })),
  };
}

/** @param {Job} job */
async function runJob(job) {
  /** @type {JobRecord} */
  const jobRecord = { pauses: [] };
  const startedAt = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const entry = { id: Date.now(), kind: job.kind, label: job.label, started_at: startedAt, error: null, stopped: null, refreshes: 0, pauses: jobRecord.pauses, series: [] };
  startProgress(job);
  const tab = await chrome.tabs.getCurrent().catch(() => undefined); // the tab may have moved
  app.windowId = tab?.windowId ?? app.windowId;
  const engine = buildEngine(job, jobRecord);
  /** @type {string | null} why the job stopped (then every queued job ends unstarted) */
  let stop = null;
  /** @type {SeriesRun | null} the series that stopped it, when one did */
  let stopping = null;
  /** @type {SeriesRun[] | null} the runs the job produced (none when it threw before producing them) */
  let runs = null;
  try {
    const cooldown = await checkCooldown(engine); // the gate, before the job's first request
    if (cooldown !== null) {
      entry["error"] = stop = cooldownMessage(cooldown, { now: now() });
      setStatus($("input-status"), shownText(stop), "error");
      return;
    }
    if (app.unsaved !== null) {
      entry["error"] = stop = app.unsaved; // a write was refused earlier in this page: no request (the finally says why)
      return;
    }
    await applyRefererRule(baseUrl());
    if (job.kind === "load") {
      stop = await runLoad(job, engine, entry);
    } else if (job.kind === "batch") {
      const lastContactAt = app.lastContactAt; // the previous job's: this one's own come later
      runs = await runBatch(engine, job.refs, {
        beforeFirstNetwork: () => restBetweenJobs(engine, { lastContactAt, batchJob: true }),
      });
      entry["series"] = runs.map(runToHistory);
      renderBatchTable(runs);
      stopping = runs.find((run) => run.stop) ?? null;
      if (stopping !== null) stop = stopping.report.stopped || stopping.error || "stopped";
    } else {
      // never the list shown (an earlier job's): listed again, for the session logged in now
      const run = await runSelectionJob(engine, /** @type {SeriesRef} */ (job.refs[0]), job.numbers, {
        lastContactAt: app.lastContactAt,
      });
      if (run.series !== null) app.loaded = { series: run.series, resolvedAt: now() };
      runs = [run];
      renderReportLine(run);
      renderBatchTable([run]);
      entry["series"] = [runToHistory(run)];
      if (run.stop) {
        stopping = run;
        stop = run.report.stopped || run.error || "stopped";
      }
    }
    entry["refreshes"] = engine.downloader.refreshes;
    const listed = app.loaded;
    if (job.kind !== "load" && listed !== null && job.refs.some((ref) => ref.seriesId === listed.series.seriesId)) {
      await renderSeries(listed.series, engine.view); // the "on disk" badges now (Chrome's history only)
    }
  } catch (error) {
    if (error instanceof StopRequested) {
      entry["error"] = stop = error.message; // stored in English, like every engine text
    } else {
      entry["error"] = stop = oneLine(error);
      setStatus($("input-status"), shownText(stop), "error");
    }
  } finally {
    clearPause();
    if (job.contacted) app.lastContactAt = now(); // the rest between jobs counts from the job's end
    await storePacing();
    if (app.unsaved !== null) {
      // chrome.storage.local refused a write: a stop (no waiting job starts), and what to do about it
      if (stop === null) entry["error"] = stop = app.unsaved;
      setStatus($("input-status"), t("storageRefused", [shownText(app.unsaved)]), "error");
    }
    entry["stopped"] = stop;
    entry["finished_at"] = new Date().toISOString();
    if (stopping !== null) await cancelQueue(notStartedMessage(stopping));
    else if (stop !== null) await cancelQueue(`not started: batch stopped in ${job.label} (${stop})`);
    await appendHistory(entry);
    $("progress-activity").textContent = "";
    renderFailed(Array.isArray(entry["series"]) ? entry["series"] : []); // what did not download, apart, with its retry
    // and the report of it (nothing goes into the history entry: its 1 MiB cap)
    await reportJobEnd(
      job,
      {
        startedAt,
        finishedAt: String(entry["finished_at"]),
        error: typeof entry["error"] === "string" ? entry["error"] : null,
        stopped: stop,
        refreshes: engine.downloader.refreshes,
        pauses: jobRecord.pauses,
      },
      runs,
      (episode) => engine.downloader.traceOf(episode),
    );
  }
}

/**
 * **Load list**: list one series (no download) and show its episodes — a job like any other: the
 * rest between jobs first (no long break: a listing alone is no download attempt), the cooldown
 * asked again after it. Returns why the job stopped (a cooldown met meanwhile), or null.
 * @param {Job} job
 * @param {Engine} engine
 * @param {Record<string, unknown>} entry
 * @returns {Promise<string | null>}
 */
async function runLoad(job, engine, entry) {
  const ref = /** @type {SeriesRef} */ (job.refs[0]);
  setStatus($("input-status"), t("loading"));
  await restBetweenJobs(engine, { lastContactAt: app.lastContactAt, batchJob: false });
  const refused = await checkCooldown(engine);
  if (refused !== null) {
    const message = cooldownMessage(refused, { now: now() });
    setStatus($("input-status"), shownText(message), "error");
    entry["error"] = message;
    return message;
  }
  await storePacing(); // can anything be stored? asked before the listing's first request, as the engine does
  if (app.unsaved !== null) {
    entry["error"] = app.unsaved;
    return app.unsaved;
  }
  let series;
  try {
    series = await resolve(engine, ref);
  } catch (error) {
    if (error instanceof StopRequested) throw error;
    const message = oneLine(error);
    setStatus($("input-status"), shownText(message), "error");
    entry["error"] = message;
    entry["series"] = [{ series_id: ref.seriesId, name: null, error: message, episodes: 0 }];
    return null;
  }
  app.loaded = { series, resolvedAt: now() };
  entry["series"] = [
    { series_id: series.seriesId, name: series.name, error: null, episodes: series.episodes.length, warnings: series.warnings },
  ];
  setStatus($("input-status"), t("loaded", [series.episodes.length]), "ok");
  await renderSeries(series, engine.view);
  return null;
}

// ------------------------------------------------------------------ the loaded series

/**
 * @param {Episode} episode
 * @returns {HTMLElement}
 */
function accessBadge(episode) {
  if (episode.access === "unlocked") return el("span", { className: "badge unlocked", text: t("badgeUnlocked"), title: t("badgeUnlockedTitle") });
  if (episode.access === "locked") return el("span", { className: "badge locked", text: t("badgeLocked"), title: t("badgeLockedTitle") });
  return el("span", { className: "badge free", text: t("badgeFree"), title: t("badgeFreeTitle") });
}

/**
 * @param {Series} series
 * @param {DownloadsView} view
 */
async function renderSeries(series, view) {
  $("series-card").hidden = false;
  const name = episodeContext(series).seriesName;
  $("series-title").textContent = name;
  await view.refresh(); // what Chrome's download history says is still on disk
  const state = readState(await readSeriesState(series.seriesId), series.seriesId);
  const onDisk = new Set(state !== null ? doneEntries(state, (entry) => view.exists(entry)).map(([number]) => number) : []);
  const available = series.episodes.filter((episode) => !isLocked(episode)).length;
  $("series-meta").textContent = t("seriesMeta", [series.episodes.length, available, onDisk.size]);
  const warnings = $("series-warnings");
  warnings.textContent = "";
  for (const warning of series.warnings) warnings.append(el("li", { text: shownText(warning) }));
  const body = /** @type {HTMLTableSectionElement} */ ($("episode-table").querySelector("tbody"));
  body.textContent = "";
  const episodes = [...series.episodes].sort((a, b) => a.number - b.number);
  covers.show(episodes); // this list's thumbnails, once their rows come into view
  for (const episode of episodes) {
    const box = /** @type {HTMLInputElement} */ (
      el("input", { attrs: { type: "checkbox", "data-number": String(episode.number), "data-locked": isLocked(episode) ? "1" : "0" } })
    );
    box.checked = !isLocked(episode) && !onDisk.has(episode.number);
    box.addEventListener("change", updateSelection);
    const cover = el("td", { className: "cover-cell" });
    const thumbnail = covers.urlOf(episode.itemId); // fetched already: no request
    cover.append(thumbnail !== null ? coverImage(thumbnail) : el("span", { className: "cover placeholder" }));
    const access = el("td", {}, [accessBadge(episode)]);
    if (onDisk.has(episode.number)) access.append(el("span", { className: "badge ondisk", text: t("badgeOnDisk"), title: t("badgeOnDiskTitle") }));
    if (isLocked(episode) && episode.lockHints.length > 0) {
      access.append(el("span", { className: "hints", text: episode.lockHints.map(shownText).join("; ") }));
    }
    body.append(
      el("tr", { attrs: { "data-number": String(episode.number), "data-access": episode.access, "data-item-id": episode.itemId } }, [
        el("td", {}, [box]),
        cover,
        el("td", { text: String(episode.number) }),
        el("td", { text: episode.title }),
        el("td", { text: duration(episode.durationS) }),
        el("td", { text: episode.qualityHint ?? "–" }),
        access,
      ]),
    );
    if (thumbnail === null) covers.watch(cover, episode.itemId); // wanted once the row is in view
  }
  updateSelection();
}

/**
 * @param {string} url a thumbnail's object URL
 * @returns {HTMLElement}
 */
function coverImage(url) {
  return el("img", { className: "cover", attrs: { src: url, alt: "" } });
}

/**
 * A thumbnail arrived: into its row (in place of the empty frame), when the list still shows that
 * episode.
 * @param {string} itemId
 * @param {string} url
 */
function showCover(itemId, url) {
  const cell = $("episode-table").querySelector(`tbody tr[data-item-id="${CSS.escape(itemId)}"] td.cover-cell`);
  if (cell !== null && cell.querySelector("img") === null) cell.replaceChildren(coverImage(url));
}

/**
 * The list's thumbnails: the extension's own requests, only for the rows in view, one at a time,
 * never during a job or a cooldown.
 */
const covers = new CoverLoader({
  hostPatterns: chrome.runtime.getManifest().host_permissions ?? [],
  allowed: async () => app.owner && app.running === null && app.queue.length === 0 && (await checkCooldownNow()) === null,
  pause: () => sleepSeconds(pagePause(defaultRng, app.testMode ? (app.testSettings.pageDelayS ?? PAGE_DELAY_S) : PAGE_DELAY_S)),
  onCover: showCover,
  baseUrl,
});

/** @returns {HTMLInputElement[]} */
function episodeBoxes() {
  return [.../** @type {NodeListOf<HTMLInputElement>} */ ($("episode-table").querySelectorAll("tbody input[type=checkbox]"))];
}

function updateSelection() {
  const boxes = episodeBoxes();
  const checked = boxes.filter((box) => box.checked);
  const locked = checked.filter((box) => box.dataset["locked"] === "1").length;
  let text = t("selectionCount", [checked.length, boxes.length]);
  if (locked > 0) text += ` ${t("selectionLocked", [locked])}`;
  $("selection-count").textContent = text;
  updateButtons();
}

// ------------------------------------------------------------------------- the buttons

function updateButtons() {
  const blocked = !app.owner || app.cooldown !== null;
  button("load-button").disabled = blocked;
  button("download-all-button").disabled = blocked;
  const loaded = app.loaded !== null;
  const available = loaded ? app.loaded?.series.episodes.some((episode) => !isLocked(episode)) : false;
  button("download-available-button").disabled = blocked || !available;
  button("download-selected-button").disabled = blocked || !episodeBoxes().some((box) => box.checked);
  // the retry buttons: the same rule, and a clicked one stays disabled until the next job ends
  const retry = button("retry-button");
  retry.disabled = blocked || app.failed === null || spentRetries.has(retry);
  for (const historyButton of historyRetryButtons) historyButton.disabled = blocked || spentRetries.has(historyButton);
  button("report-button").disabled = app.lastReport === null; // a save, no request: the cooldown does not matter
}

/**
 * The text box as series refs, or null with the reason shown (nothing may start while a line is
 * refused).
 * @returns {{refs: SeriesRef[], notes: string[]} | null}
 */
function parsedLinks() {
  const parsed = parseSeriesList(textarea("links").value);
  const status = $("input-status");
  if (parsed.errors.length > 0) {
    setStatus(status, parsed.errors.map((error) => shownText(error.message)).join(" · "), "error");
    return null;
  }
  if (parsed.refs.length === 0) {
    setStatus(status, t("noLinks"), "error");
    return null;
  }
  setStatus(status, parsed.notes.map(shownText).join(" · "));
  return { refs: parsed.refs, notes: parsed.notes };
}

/**
 * Whether a **Load list** job for `seriesId` is running or waiting: a second click, or the popup's
 * "Download this series" for a series already being listed, must not queue the same listing twice
 * (two discoveries of one series, one after the other, for nothing).
 * @param {string} seriesId
 * @returns {boolean}
 */
function loadPending(seriesId) {
  /** @param {Job} job */
  const listsIt = (job) => job.kind === "load" && job.refs[0]?.seriesId === seriesId;
  return (app.running !== null && listsIt(app.running)) || app.queue.some(listsIt);
}

/** **Load list**, also reached through {@link loadFromOutside}: one listing per series at a time. */
function onLoad() {
  const parsed = parsedLinks();
  if (parsed === null) return;
  if (parsed.refs.length !== 1) {
    setStatus($("input-status"), t("loadOneOnly"), "error");
    return;
  }
  const ref = /** @type {SeriesRef} */ (parsed.refs[0]);
  if (loadPending(ref.seriesId)) {
    setStatus($("input-status"), t("loadAlreadyQueued"), "error");
    return;
  }
  enqueue({ kind: "load", label: t("jobLoad", ref.seriesId), refs: [ref], series: null, numbers: [], includeLocked: false, recheck: false });
}

function onDownloadAll() {
  const parsed = parsedLinks();
  if (parsed === null) return;
  const includeLocked = input("include-locked").checked;
  const recheck = input("recheck").checked;
  input("include-locked").checked = false; // per run
  input("recheck").checked = false;
  const label =
    parsed.refs.length === 1 ? t("jobSeries", /** @type {SeriesRef} */ (parsed.refs[0]).seriesId) : t("jobBatch", [parsed.refs.length]);
  enqueue({ kind: "batch", label, refs: parsed.refs, series: null, numbers: [], includeLocked, recheck });
  if (parsed.notes.length > 0) setStatus($("input-status"), parsed.notes.map(shownText).join(" · "));
}

/**
 * @param {number[]} numbers
 * @param {boolean} includeLocked
 */
function startSelection(numbers, includeLocked) {
  if (app.loaded === null || numbers.length === 0) return;
  const series = app.loaded.series;
  const ref = { kind: /** @type {const} */ ("series"), seriesId: series.seriesId, episodeHint: null, sourceUrl: series.seriesId };
  enqueue({
    kind: "selection",
    label: t("jobSelection", [numbers.length, episodeContext(series).seriesName]),
    refs: [ref],
    series,
    numbers,
    includeLocked,
    recheck: false,
  });
}

function onDownloadAvailable() {
  if (app.loaded === null) return;
  startSelection(
    app.loaded.series.episodes.filter((episode) => !isLocked(episode)).map((episode) => episode.number),
    false,
  );
}

function onDownloadSelected() {
  const checked = episodeBoxes().filter((box) => box.checked);
  const numbers = checked.map((box) => Number(box.dataset["number"]));
  startSelection(numbers, checked.some((box) => box.dataset["locked"] === "1"));
}

function onStop() {
  app.stopRequested = true;
  for (const cancel of [...app.stopWaiters]) cancel();
  app.stopWaiters.clear();
}

// -------------------------------------------------------------------------- the cooldown

async function refreshCooldown() {
  app.cooldown = await checkCooldownNow();
  const banner = $("cooldown-banner");
  if (app.cooldown === null) {
    banner.hidden = true;
  } else {
    banner.hidden = false;
    $("cooldown-text").textContent = shownText(cooldownMessage(app.cooldown, { now: now() }));
  }
  tickCooldown();
  updateButtons();
  if (app.cooldown === null && app.running === null) covers.resume(); // the cooldown is over
}

/** @returns {Promise<import("../lib/cooldown.js").Cooldown | null>} */
function checkCooldownNow() {
  return activeCooldown(cooldownStore(), { now: now() });
}

function tickCooldown() {
  if (app.cooldown === null) return;
  const left = secondsLeft(app.cooldown, now());
  if (left <= 0) {
    void refreshCooldown();
    return;
  }
  $("cooldown-left").textContent = t("cooldownLeft", [minutesLeft(app.cooldown, now())]);
}

// --------------------------------------------------------------------------- settings

function fillSettings() {
  const settings = app.settings;
  select("setting-quality").value = settings.quality;
  select("setting-thumbnail").value = settings.thumbnail;
  input("setting-name-format").value = settings.nameFormat;
  select("setting-pace").value = settings.pace;
  input("setting-delay-min").value = String(settings.delayMinS);
  input("setting-delay-max").value = String(settings.delayMaxS);
  input("setting-rest-every").value = String(settings.restEvery);
  input("setting-rest-min").value = String(settings.restMinS);
  input("setting-rest-max").value = String(settings.restMaxS);
  input("setting-report").checked = settings.report;
  const pacing = effectivePacing();
  $("pacing-line").textContent = `${shownText(describePacing(pacing))}; ${shownText(describeBatchPacing(pacing))}`;
}

/** @param {SubmitEvent} event */
async function onSaveSettings(event) {
  event.preventDefault();
  /** @type {Settings} */
  const settings = {
    quality: /** @type {Settings["quality"]} */ (select("setting-quality").value),
    thumbnail: /** @type {Settings["thumbnail"]} */ (select("setting-thumbnail").value),
    nameFormat: input("setting-name-format").value,
    pace: /** @type {Settings["pace"]} */ (select("setting-pace").value),
    delayMinS: Number(input("setting-delay-min").value),
    delayMaxS: Number(input("setting-delay-max").value),
    restEvery: Number(input("setting-rest-every").value),
    restMinS: Number(input("setting-rest-min").value),
    restMaxS: Number(input("setting-rest-max").value),
    report: input("setting-report").checked,
  };
  try {
    await saveSettings(settings);
    app.settings = settings;
    setStatus($("settings-status"), t("settingsSaved"), "ok");
  } catch (error) {
    setStatus($("settings-status"), t("settingsRefused", shownText(oneLine(error))), "error");
  }
  fillSettings();
}

async function onResetSettings() {
  await saveSettings({ ...DEFAULT_SETTINGS });
  app.settings = { ...DEFAULT_SETTINGS };
  fillSettings();
  setStatus($("settings-status"), t("settingsSaved"), "ok");
}

// ---------------------------------------------------------------------------- history

async function renderHistory() {
  const entries = await readHistory();
  const list = $("history-list");
  list.textContent = "";
  historyRetryButtons.clear();
  for (const entry of entries) {
    const finished = typeof entry["finished_at"] === "string" ? new Date(entry["finished_at"]).toLocaleString() : "";
    const item = el("li", {}, [el("strong", { text: `${finished} — ${String(entry["label"] ?? "")}` })]);
    if (typeof entry["error"] === "string") item.append(el("div", { className: "meta", text: shownText(entry["error"]) }));
    const series = Array.isArray(entry["series"]) ? entry["series"] : [];
    for (const run of series) {
      if (run === null || typeof run !== "object") continue;
      const record = /** @type {Record<string, unknown>} */ (run);
      // as the report lines show it: the error of a series that failed or never started, else its line
      let line;
      if (typeof record["error"] === "string") line = shownText(record["error"]);
      else if (typeof record["line"] === "string") line = shownText(record["line"]);
      else if (typeof record["episodes"] === "number") line = t("loaded", [record["episodes"]]); // a listing
      else line = "";
      item.append(el("div", { text: `${String(record["name"] ?? record["series_id"] ?? "")}: ${line}` }));
    }
    // the episodes that did not download, and the button that queues them again (one selection job
    // per series): a run from yesterday can be retried too
    const targets = retryTargets(series);
    if (targets.length > 0) {
      const episodes = failedEpisodesText(targets, series.length > 1);
      item.append(el("div", { className: "retry-line" }, [el("span", { text: t("historyFailed", [episodes]) }), " ", historyRetryButton(targets)]));
    }
    list.append(item);
  }
  updateButtons();
}

// ---------------------------------------------------------------------------- test mode

async function setupTestMode() {
  if (!app.testMode) return;
  $("test-card").hidden = false;
  textarea("test-settings").value = JSON.stringify(app.testSettings);
  button("test-settings-save").addEventListener("click", async () => {
    try {
      app.testSettings = await saveTestSettings(JSON.parse(textarea("test-settings").value || "{}"));
      textarea("test-settings").value = JSON.stringify(app.testSettings);
      setStatus($("test-settings-status"), `saved: ${JSON.stringify(app.testSettings)}`, "ok");
      fillSettings();
    } catch (error) {
      setStatus($("test-settings-status"), oneLine(error), "error");
    }
  });
}

// ------------------------------------------------------------------------------- start

/**
 * Put a link into the box and list it (the popup's "Download this series") — in the engine's tab
 * only: the popup's request reaches every DramaFetch tab, and the engine's lists it.
 * @param {string} link
 */
function loadFromOutside(link) {
  if (!app.owner) return;
  textarea("links").value = link;
  onLoad();
}

/** @returns {Promise<boolean>} whether this tab holds the engine (the only one per browser) */
function acquireEngine() {
  return new Promise((resolveLock) => {
    void navigator.locks.request(ENGINE_LOCK, { ifAvailable: true }, (lock) => {
      resolveLock(lock !== null);
      return lock !== null ? new Promise(() => undefined) : undefined; // held while the tab lives
    });
  });
}

/**
 * The downloader's activity line (`E01: <host>`, `E01: fresh episode list`) is written straight
 * into `#progress-activity`; shown in the page's language all the same, whoever writes it.
 */
function translateActivity() {
  const element = $("progress-activity");
  let written = "";
  new MutationObserver(() => {
    const text = element.textContent ?? "";
    if (text === written) return; // the translation this observer wrote itself
    const translated = shownText(text);
    if (translated === text) return;
    written = translated;
    element.textContent = translated;
  }).observe(element, { childList: true, characterData: true, subtree: true });
}

async function main() {
  localize();
  $("version").textContent = chrome.runtime.getManifest().version; // which build is loaded, as chrome://extensions names it
  shown.lang = displayLanguage();
  shown.labels = displayLabels();
  translateActivity();
  app.testMode = isTestMode();
  app.owner = await acquireEngine();
  $("duplicate-banner").hidden = app.owner;
  // a TikTok tab an earlier DramaFetch page left listing (it was reloaded mid-listing): closed
  if (app.owner) await closeLeftoverDiscoveryTab().catch(() => undefined);
  const tab = await chrome.tabs.getCurrent().catch(() => undefined);
  app.tabId = tab?.id;
  app.windowId = tab?.windowId;
  initPageRedirects(app.tabId); // the redirects of this tab's own requests, before its first one
  app.settings = await loadSettings();
  app.testSettings = await loadTestSettings();
  const stored = await loadPacing();
  app.pacing = stored.pacing;
  app.lastContactAt = stored.lastContactAt;
  fillSettings();
  await setupTestMode();

  button("load-button").addEventListener("click", onLoad);
  button("download-all-button").addEventListener("click", onDownloadAll);
  button("download-available-button").addEventListener("click", onDownloadAvailable);
  button("download-selected-button").addEventListener("click", onDownloadSelected);
  button("stop-button").addEventListener("click", onStop);
  button("retry-button").addEventListener("click", () => {
    if (app.failed !== null) startRetry(app.failed, button("retry-button"));
  });
  button("report-button").addEventListener("click", () => void saveReport()); // again, or with the setting off
  input("select-all").addEventListener("change", () => {
    for (const box of episodeBoxes()) box.checked = input("select-all").checked;
    updateSelection();
  });
  $("settings-form").addEventListener("submit", (event) => void onSaveSettings(/** @type {SubmitEvent} */ (event)));
  button("settings-reset").addEventListener("click", () => void onResetSettings());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.hasOwn(changes, COOLDOWN_STORAGE_KEY)) void refreshCooldown();
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id) return; // only this extension's own code
    if (message !== null && typeof message === "object") {
      const record = /** @type {Record<string, unknown>} */ (message);
      if (record["type"] === "dramafetch:load" && typeof record["input"] === "string") loadFromOutside(record["input"]);
    }
  });
  setInterval(() => {
    tickCooldown();
    if (app.pauseUntil !== null) renderPause();
  }, 1000);

  await refreshCooldown();
  await renderHistory();
  renderAppStatus();
  const load = new URLSearchParams(location.search).get("load");
  if (load) {
    history.replaceState(null, "", location.pathname);
    loadFromOutside(load);
  }
}

void main();
