// @ts-check
/**
 * The DramaFetch tab: the text box (one link or id per line, the CLI's `--from-file` rules), the
 * episode list of one series (**Load list**), the jobs — one at a time, FIFO, the web job
 * manager's rules — and their progress, the cooldown banner, the settings, the history of the last
 * 20 runs, and (only in the test harness' copy) the test settings. The engine runs here while the
 * tab is open; one tab per browser holds it (a Web Lock), a second one stays read-only.
 */

import { isLocked } from "../lib/catalog.js";
import { COOLDOWN_STORAGE_KEY, activeCooldown, cooldownMessage, minutesLeft, secondsLeft } from "../lib/cooldown.js";
import { TIKTOK_BASE_URL } from "../lib/messages.js";
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
import { CoverLoader, DownloadsView, Downloader, applyRefererRule, oneLine } from "./downloader.js";
import { StopRequested, checkCooldown, episodeContext, resolve, restBetweenJobs, runBatch, runSelectionJob } from "./engine.js";
import { localize, t } from "./i18n.js";
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
  await savePacing(app.pacing, app.lastContactAt);
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
    writeState: writeSeriesState,
    persist: async () => {
      // after every network attempt (and pause): a download contacted TikTok at lastNetworkAt
      const network = app.pacing.lastNetworkAt;
      if (network !== null && network !== networkBefore) {
        job.contacted = true;
        if (app.lastContactAt === null || network > app.lastContactAt) app.lastContactAt = network;
      }
      await savePacing(app.pacing, app.lastContactAt);
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
  element.textContent = t("pauseInForce", [app.pauseText, left]);
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

/** @param {DownloadResult} result */
function renderResult(result) {
  const body = /** @type {HTMLTableSectionElement} */ ($("result-table").querySelector("tbody"));
  const key = `${result.episode.seriesId}:${result.episode.number}`;
  const row = el(
    "tr",
    { attrs: { "data-key": key, "data-series-id": result.episode.seriesId, "data-number": String(result.episode.number), "data-status": result.status } },
    [
      el("td", { text: `E${String(result.episode.number).padStart(2, "0")}` }),
      el("td", {}, [el("span", { className: `badge ${statusClass(result.status)}`, text: result.status })]),
      el("td", { className: "message", text: result.message }),
    ],
  );
  const existing = body.querySelector(`tr[data-key="${CSS.escape(key)}"]`);
  if (existing !== null) existing.replaceWith(row);
  else body.append(row);
}

/** @param {SeriesRun} run */
function renderReportLine(run) {
  const name = run.report.name || run.series?.name || run.ref.seriesId;
  const text = run.error !== null ? `${name}: ${run.error}` : `${name}: ${reportLine(run.report)}`;
  $("report-lines").append(el("li", { text, attrs: { "data-series-id": run.ref.seriesId } }));
}

/** @param {readonly SeriesRun[]} runs */
function renderBatchTable(runs) {
  const table = $("batch-table");
  const body = /** @type {HTMLTableSectionElement} */ (table.querySelector("tbody"));
  body.textContent = "";
  for (const run of runs) {
    const report = run.report;
    body.append(
      el("tr", { attrs: { "data-series-id": run.ref.seriesId } }, [
        el("td", { text: report.name || run.series?.name || run.ref.seriesId }),
        el("td", { text: batchStatus({ ...run, errorKind: run.errorKind }) }),
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
  $("progress-activity").textContent = "";
  $("progress-current").textContent = job.label;
  clearPause();
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
}

/** @param {Omit<Job, "id">} job */
function enqueue(job) {
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
  try {
    const cooldown = await checkCooldown(engine); // the gate, before the job's first request
    if (cooldown !== null) {
      entry["error"] = stop = cooldownMessage(cooldown, { now: now() });
      setStatus($("input-status"), stop, "error");
      return;
    }
    await applyRefererRule(baseUrl());
    if (job.kind === "load") {
      stop = await runLoad(job, engine, entry);
    } else if (job.kind === "batch") {
      const lastContactAt = app.lastContactAt; // the previous job's: this one's own come later
      const runs = await runBatch(engine, job.refs, {
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
      renderReportLine(run);
      renderBatchTable([run]);
      entry["series"] = [runToHistory(run)];
      if (run.stop) {
        stopping = run;
        stop = run.report.stopped || run.error || "stopped";
      }
    }
    entry["refreshes"] = engine.downloader.refreshes;
    const shown = app.loaded;
    if (job.kind !== "load" && shown !== null && job.refs.some((ref) => ref.seriesId === shown.series.seriesId)) {
      await renderSeries(shown.series, engine.view); // the "on disk" badges now (Chrome's history only)
    }
  } catch (error) {
    if (error instanceof StopRequested) {
      entry["error"] = stop = t("stoppedByYou");
    } else {
      entry["error"] = stop = oneLine(error);
      setStatus($("input-status"), oneLine(error), "error");
    }
  } finally {
    clearPause();
    entry["stopped"] = stop;
    entry["finished_at"] = new Date().toISOString();
    if (job.contacted) app.lastContactAt = now(); // the rest between jobs counts from the job's end
    await savePacing(app.pacing, app.lastContactAt);
    if (stopping !== null) await cancelQueue(notStartedMessage(stopping));
    else if (stop !== null) await cancelQueue(`not started: batch stopped in ${job.label} (${stop})`);
    await appendHistory(entry);
    $("progress-activity").textContent = "";
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
    setStatus($("input-status"), message, "error");
    entry["error"] = message;
    return message;
  }
  let series;
  try {
    series = await resolve(engine, ref);
  } catch (error) {
    if (error instanceof StopRequested) throw error;
    const message = oneLine(error);
    setStatus($("input-status"), message, "error");
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
  for (const warning of series.warnings) warnings.append(el("li", { text: warning }));
  const body = /** @type {HTMLTableSectionElement} */ ($("episode-table").querySelector("tbody"));
  body.textContent = "";
  const episodes = [...series.episodes].sort((a, b) => a.number - b.number);
  for (const episode of episodes) {
    const box = /** @type {HTMLInputElement} */ (
      el("input", { attrs: { type: "checkbox", "data-number": String(episode.number), "data-locked": isLocked(episode) ? "1" : "0" } })
    );
    box.checked = !isLocked(episode) && !onDisk.has(episode.number);
    box.addEventListener("change", updateSelection);
    const cover = el("td", { className: "cover-cell" });
    const thumbnail = covers.urlOf(episode.itemId); // fetched already: no request
    if (thumbnail !== null) cover.append(coverImage(thumbnail));
    const access = el("td", {}, [accessBadge(episode)]);
    if (onDisk.has(episode.number)) access.append(el("span", { className: "badge ondisk", text: t("badgeOnDisk"), title: t("badgeOnDiskTitle") }));
    if (isLocked(episode) && episode.lockHints.length > 0) access.append(el("span", { className: "hints", text: episode.lockHints.join("; ") }));
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
  }
  updateSelection();
  covers.show(episodes); // the missing thumbnails, one at a time, while no job runs
}

/**
 * @param {string} url a thumbnail's object URL
 * @returns {HTMLElement}
 */
function coverImage(url) {
  return el("img", { className: "cover", attrs: { src: url, alt: "" } });
}

/**
 * A thumbnail arrived: into its row, when the list still shows that episode.
 * @param {string} itemId
 * @param {string} url
 */
function showCover(itemId, url) {
  const cell = $("episode-table").querySelector(`tbody tr[data-item-id="${CSS.escape(itemId)}"] td.cover-cell`);
  if (cell !== null && cell.querySelector("img") === null) cell.append(coverImage(url));
}

/** The list's thumbnails: the extension's own requests, one at a time, never during a job or a cooldown. */
const covers = new CoverLoader({
  hostPatterns: chrome.runtime.getManifest().host_permissions ?? [],
  allowed: async () => app.owner && app.running === null && app.queue.length === 0 && (await checkCooldownNow()) === null,
  pause: () => sleepSeconds(pagePause(defaultRng, app.testMode ? (app.testSettings.pageDelayS ?? PAGE_DELAY_S) : PAGE_DELAY_S)),
  onCover: showCover,
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
    setStatus(status, parsed.errors.map((error) => error.message).join(" · "), "error");
    return null;
  }
  if (parsed.refs.length === 0) {
    setStatus(status, t("noLinks"), "error");
    return null;
  }
  setStatus(status, parsed.notes.join(" · "));
  return { refs: parsed.refs, notes: parsed.notes };
}

function onLoad() {
  const parsed = parsedLinks();
  if (parsed === null) return;
  if (parsed.refs.length !== 1) {
    setStatus($("input-status"), t("loadOneOnly"), "error");
    return;
  }
  const ref = /** @type {SeriesRef} */ (parsed.refs[0]);
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
  if (parsed.notes.length > 0) setStatus($("input-status"), parsed.notes.join(" · "));
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
    $("cooldown-text").textContent = cooldownMessage(app.cooldown, { now: now() });
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
  $("pacing-line").textContent = `${describePacing(effectivePacing())}; ${describeBatchPacing(effectivePacing())}`;
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
  };
  try {
    await saveSettings(settings);
    app.settings = settings;
    setStatus($("settings-status"), t("settingsSaved"), "ok");
  } catch (error) {
    setStatus($("settings-status"), t("settingsRefused", oneLine(error)), "error");
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
  const list = $("history-list");
  list.textContent = "";
  for (const entry of await readHistory()) {
    const finished = typeof entry["finished_at"] === "string" ? new Date(entry["finished_at"]).toLocaleString() : "";
    const item = el("li", {}, [el("strong", { text: `${finished} — ${String(entry["label"] ?? "")}` })]);
    if (typeof entry["error"] === "string") item.append(el("div", { className: "meta", text: entry["error"] }));
    const series = Array.isArray(entry["series"]) ? entry["series"] : [];
    for (const run of series) {
      if (run === null || typeof run !== "object") continue;
      const record = /** @type {Record<string, unknown>} */ (run);
      const line = typeof record["line"] === "string" ? record["line"] : String(record["error"] ?? "");
      item.append(el("div", { text: `${String(record["name"] ?? record["series_id"] ?? "")}: ${line}` }));
    }
    list.append(item);
  }
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
 * Put a link into the box and list it (the popup's "Download this series").
 * @param {string} link
 */
function loadFromOutside(link) {
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

async function main() {
  localize();
  app.testMode = isTestMode();
  app.owner = await acquireEngine();
  $("duplicate-banner").hidden = app.owner;
  // a TikTok tab an earlier DramaFetch page left listing (it was reloaded mid-listing): closed
  if (app.owner) await closeLeftoverDiscoveryTab().catch(() => undefined);
  const tab = await chrome.tabs.getCurrent().catch(() => undefined);
  app.tabId = tab?.id;
  app.windowId = tab?.windowId;
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
  input("select-all").addEventListener("change", () => {
    for (const box of episodeBoxes()) box.checked = input("select-all").checked;
    updateSelection();
  });
  $("settings-form").addEventListener("submit", (event) => void onSaveSettings(/** @type {SubmitEvent} */ (event)));
  button("settings-reset").addEventListener("click", () => void onResetSettings());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.hasOwn(changes, COOLDOWN_STORAGE_KEY)) void refreshCooldown();
  });
  chrome.runtime.onMessage.addListener((message) => {
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
