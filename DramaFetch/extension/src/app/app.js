// @ts-check
/**
 * The DramaFetch tab: the text box (one link or id per line, the CLI's `--from-file` rules), the
 * episode list of one series (**Load list**), the user's TikTok library (DramaFetch 1.6.0: their
 * Bookmark — **Favorites** → **Drama** — as cards, kept across sessions, its count TikTok's, with
 * filters, a search, ticks, **Download selected**, **Add selected to the box** and **Remove from
 * Favorites**), the jobs — one at a time, FIFO, the web job manager's rules — and their progress
 * (the episodes a job did not download shown apart from the ones that completed, with the button
 * that queues them again), the cooldown banner, the settings, the history of the last 20 runs —
 * each past run's failures retryable the same way —, and (only in the test harness' copy) the test
 * settings. The engine runs here while the tab is open; one tab per browser holds it (a Web Lock),
 * a second one stays read-only.
 */

import { isLocked } from "../lib/catalog.js";
import { COOLDOWN_STORAGE_KEY, activeCooldown, clockTime, cooldownMessage, minutesLeft, secondsLeft } from "../lib/cooldown.js";
import { buildReport, digestEntry, hasFailures, reportFilename, reportJson, reportStem, slimRows } from "../lib/diagnosis.js";
import { displayText, statusLabel } from "../lib/display.js";
import {
  FAVORITES_MAX_PAGES,
  boxWithFavorites,
  cleanTitle,
  coversCard,
  coversShift,
  durationParts,
  favoritesOfQuery,
  handoverOf,
  isProfilePageUrl,
  progressStatus,
  resolveCard,
  titleMatches,
} from "../lib/favorites.js";
import {
  LIBRARY_PIECE,
  LIBRARY_SORTS,
  ageOf,
  chipCounts,
  countsFresh,
  coverExpired,
  distinctItems,
  inFilter,
  libraryRecord,
  libraryStatus,
  progressOf,
  removalFacts,
  selectionEpisodes,
  sortedItems,
  twinIds,
  unchangedSince,
} from "../lib/library.js";
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
import { parseSeriesList, seriesPageUrl } from "../lib/urls.js";
import { BOOKMARK_MESSAGES, BookmarkCooldown, BookmarkError, countAfterRemoval, removeFromBookmark } from "./bookmark.js";
import { DiscoveryError, closeLeftoverDiscoveryTab, discoverSeries } from "./discovery.js";
import { CoverLane, CoverLoader, DownloadsView, Downloader, applyRefererRule, oneLine, saveFile } from "./downloader.js";
import { initPageRedirects } from "./redirects.js";
import {
  StopRequested,
  StorageRefusedError,
  checkCooldown,
  episodeContext,
  resolve,
  restBetweenJobs,
  runBatch,
  runSelectionJob,
  storageRefusedReason,
} from "./engine.js";
import { FavoritesError, checkFavoritesTab, cutShort, listFavorites } from "./favorites.js";
import { displayLabels, displayLanguage, localize, t } from "./i18n.js";
import { isOwnSender } from "./senders.js";
import {
  DEFAULT_SETTINGS,
  FAVORITES_TEMPLATE_PREFIX,
  appendHistory,
  cooldownStore,
  isTestMode,
  loadPacing,
  loadSettings,
  loadTestSettings,
  readFavoritesTemplate,
  readHistory,
  readLibrary,
  readLibraryCovers,
  readSeriesState,
  readSeriesStates,
  savePacing,
  saveSettings,
  saveTestSettings,
  storedCooldownUntil,
  writeLibrary,
  writeLibraryCovers,
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
 * @typedef {import("../lib/favorites.js").FavoriteItem} FavoriteItem
 * @typedef {import("../lib/favorites.js").Card} Card
 * @typedef {import("../lib/favorites.js").CardResolution} CardResolution
 * @typedef {import("../lib/favorites.js").FavoritesHandover} FavoritesHandover
 * @typedef {import("./favorites.js").FavoritesListing} FavoritesListing
 *
 * @typedef {import("../lib/library.js").Progress} Progress
 * @typedef {import("../lib/library.js").LibraryEntry} LibraryEntry
 * @typedef {import("../lib/library.js").LibraryFilter} LibraryFilter
 * @typedef {import("../lib/library.js").LibrarySort} LibrarySort
 * @typedef {import("../lib/library.js").LibraryStatus} LibraryStatus
 *
 * @typedef {object} Job
 * @property {number} id
 * @property {"load" | "batch" | "selection" | "favorites" | "unbookmark"} kind `favorites`: **List
 *   favorites** (the library's refresh); `unbookmark`: **Remove from Favorites**
 * @property {string} label
 * @property {SeriesRef[]} refs a `load` job from a favorites card has none until the card is resolved
 * @property {Series | null} series
 * @property {number[]} numbers
 * @property {boolean} includeLocked
 * @property {boolean} recheck
 * @property {boolean} [contacted] whether the job made a request to TikTok (set while it runs)
 * @property {number} [favoritesTab] the user's TikTok tab whose favorites a `favorites` job lists, or
 *   whose right-clicked card a `load` job resolves first
 * @property {Card | null} [card] the right-clicked favorites card a `load` job lists the drama of
 * @property {{seriesId: string, title: string | null, episodes: number | null}} [bookmark] the drama
 *   an `unbookmark` job removes from the Bookmark (`episodes`: the count its confirmation showed —
 *   the job's gate reads the library's own count when it runs, {@link runUnbookmark})
 * @property {{count: number, skipped: number}} [listed] what a listing that filled the library
 *   listed — its dramas, and the list's items it left out for want of a readable series id —: what
 *   the job's status line and history entry say, whatever became of the library
 *   ({@link fetchFavorites}: a listing that stops short of TikTok's end leaves a library that held
 *   dramas as it was)
 *
 * @typedef {object} FavoritesShown The favorites list the library shows: one TikTok tab's, or the
 *   library kept from an earlier session (no tab: a card's resolution never trusts it).
 * @property {number | null} tabId
 * @property {FavoriteItem[]} items the list's dramas in its order (a drama listed twice: twice)
 * @property {number | null} total how many favorites TikTok counts
 * @property {boolean} complete the list's end was reached
 * @property {FavoritesListing["ended"]} ended why the listing ended before the list's end
 * @property {boolean} short TikTok stopped sending the list before its end (`favorites.cutShort`)
 * @property {number} skipped the list's items left out for want of a readable series id
 * @property {number} perPage how many dramas a page of that list held (`FavoritesListing.perPage`)
 * @property {boolean} loading a listing is filling it now
 * @property {number} listedAt when the listing ended, seconds since the epoch
 *
 * @typedef {object} LibrarySnapshot The library as it was before a listing that fills it, when it
 *   held dramas ({@link fetchFavorites}): what comes back when that listing does not end as
 *   TikTok's whole list ({@link restoreKeptLibrary}).
 * @property {FavoritesShown} favorites `app.favorites` itself — the listing puts a new object in
 *   its place ({@link startFavorites}), and nothing changes this one meanwhile
 * @property {[string, number][]} removed `library.removed`'s entries
 * @property {number} shown `library.shown`: how many cards the grid drew
 * @property {KeptCardList | null} cardList {@link cardList}: the list a right-click read of a tab
 *
 * @typedef {object} FavoritesAddress A TikTok tab's favorites address, as the worker kept it
 *   (`storage.readFavoritesTemplate`).
 * @property {string} url the list's first page, replayed unchanged
 * @property {string | null} profile whose favorites it reads: the `@handle` of the profile page
 *   that asked for it, recorded with it — never the page the tab shows later; null when the worker
 *   could not tell
 *
 * @typedef {object} KeptCardList A card's listing of a tab's favorites kept apart from the library
 *   ({@link cardList}).
 * @property {number} tabId
 * @property {FavoritesListing} listing
 * @property {number} listedAt when it ended, seconds since the epoch
 * @property {string | null} profile whose favorites it read ({@link FavoritesAddress})
 *
 * @typedef {{item: FavoriteItem} | {template: FavoritesAddress} | {done: string | null}} CardStart What a
 *   right-clicked card's job has before its first request ({@link cardStart}): the drama itself
 *   (from the panel's list, no request), the tab's favorites address to read the list with, or the
 *   end of the job, said on the page — the job's stop (a login wall) or null
 *
 * @typedef {object} JobRecord What a finished job leaves in the history.
 * @property {{kind: string, seconds: number, text: string}[]} pauses
 * @property {SeriesInput[]} inputs what the report reads of the first finished series of a batch,
 *   in the runs' order, each taken when its series was done ({@link releaseSeries})
 * @property {boolean} taking whether the next series' is still taken: false once one could not be
 *   (that run and the later ones stay whole, and the report reads them at the job's end)
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
  /** @type {FavoritesShown | null} the favorites the panel shows (**Your favorite dramas**) */
  favorites: null,
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
  /** whether the storage advice on screen says the wait could not be saved ({@link showStorageRefused}) */
  unsavedWaitShown: false,
  /** when the page last looked whether its cooldown is stored ({@link lookAgainAtCooldown}) */
  cooldownLookedAt: 0,
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
 * `chrome.storage.local` refused a write: remembered in {@link app}.unsaved, the first reason kept,
 * and the buttons that would start a job disabled from now on.
 * @param {unknown} error what the write rejected with
 */
function noteRefusedWrite(error) {
  if (app.unsaved !== null) return;
  app.unsaved = storageRefusedReason(error);
  updateButtons();
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
 * Say, in the status line, that this page stopped because `chrome.storage.local` refused a write
 * ({@link app}.unsaved) and what to do. When a cooldown is in force too, the advice names its end:
 * a cooldown that could not be stored is only in this browser session's memory, and restarting
 * Chrome before then would forget it.
 * @returns {Promise<void>}
 */
async function showStorageRefused() {
  if (app.unsaved === null) return;
  const reason = shownText(app.unsaved);
  const cooldown = await checkCooldownNow();
  // A cooldown in force: its end is always named — what Chrome accepts after a refused write may
  // not survive its restart, so even a stored wait is waited out first. "could not be saved"
  // only when chrome.storage.local does not hold it.
  const unsavedWait = cooldown !== null && (await storedCooldownUntil()) < cooldown.until;
  app.unsavedWaitShown = unsavedWait;
  const text =
    cooldown === null
      ? t("storageRefused", [reason])
      : t(unsavedWait ? "storageRefusedCooldown" : "storageRefusedWait", [reason, clockTime(cooldown.until)]);
  setStatus($("input-status"), text, "error");
  updateButtons();
}

/**
 * The cooldown store of a job: a record the storage refuses is a refused write like any other
 * ({@link noteRefusedWrite}) — the cooldown stays in force from the page's and the browser
 * session's memory, and the job's end says the wait could not be saved.
 * @param {import("../lib/cooldown.js").CooldownStore} store
 * @returns {import("../lib/cooldown.js").CooldownStore}
 */
function noticedCooldownStore(store) {
  return {
    ...store,
    write: async (record) => {
      try {
        await store.write(record);
      } catch (error) {
        noteRefusedWrite(error);
        throw error; // `recordBlock` keeps the cooldown in force all the same
      }
    },
  };
}

/**
 * The engine of one job, wired to this page: its storage, its pacing, its downloader and the
 * progress card. (Exported for the unit tests, which cannot run a job but can call its hooks.)
 * @param {Job} job
 * @param {JobRecord} jobRecord
 * @returns {Engine}
 */
export function buildEngine(job, jobRecord) {
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
    // that save refused (or one before it): not one request of the listing
    if (app.unsaved !== null) throw new StorageRefusedError(app.unsaved);
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
    cooldownStore: noticedCooldownStore(cooldownStore()),
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
      libraryRunning(start.ref.seriesId);
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
      // the library's card of the series being downloaded: its count after every episode
      if (result.episode.seriesId === library.running) void refreshLibraryStatuses([result.episode.seriesId]);
    },
    onSeriesStart: (index, total, ref) => {
      $("progress-current").textContent = t("progressBatch", [index, total, ref.seriesId]);
      libraryRunning(ref.seriesId);
    },
    onSeriesDone: (_index, _total, run) => {
      clearPause();
      renderReportLine(run);
      releaseSeries(run, downloader, jobRecord);
      trimResultRows();
      libraryFinished(run.ref.seriesId);
    },
  };
}

/**
 * A series of a batch is done: take what the job's report reads of it ({@link seriesInput}), then
 * let go of what the run kept only for that — the downloader's traces and fresh list of the series
 * and every episode's raw list item (several kilobytes each: a batch of hundreds of series would
 * hold them all until its end). Nothing the engine does next reads them: a batch downloads a
 * series once. Never throws into the batch: when the report's input cannot be taken, the run is
 * left whole — it and every later one — and the report reads them at the job's end. (Exported for
 * the unit tests, which cannot run a job.)
 * @param {SeriesRun} run
 * @param {Pick<Downloader, "traceOf" | "forgetSeries">} downloader the job's
 * @param {Pick<JobRecord, "inputs" | "taking">} jobRecord
 */
export function releaseSeries(run, downloader, jobRecord) {
  if (!jobRecord.taking) return;
  try {
    jobRecord.inputs.push(seriesInput(run, (episode) => downloader.traceOf(episode)));
  } catch (error) {
    console.warn(error);
    jobRecord.taking = false;
    return;
  }
  downloader.forgetSeries(run.ref.seriesId);
  for (const episode of run.series?.episodes ?? []) episode.raw = null;
  for (const result of run.results) result.episode.raw = null;
}

/**
 * The running job downloads `seriesId` now: its library card says **Downloading**.
 * @param {string} seriesId
 */
function libraryRunning(seriesId) {
  if (library.running === seriesId) return;
  library.running = seriesId;
  if (app.favorites !== null && app.favorites.items.some((item) => item.seriesId === seriesId)) renderLibrary();
}

/**
 * The running job finished `seriesId`: its library card reads the records again (on disk, partly).
 * @param {string} seriesId
 */
function libraryFinished(seriesId) {
  library.finished.add(seriesId);
  if (library.running === seriesId) library.running = null;
  void refreshLibraryStatuses([seriesId]);
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

/**
 * At most this many rows stay in the result table while a job runs: about the last thirty series
 * of sixty episodes. A row costs some 40 KB of the tab's memory and every new row lays the whole
 * table out again, so a batch of hundreds of series would otherwise hold gigabytes and stutter.
 */
export const MAX_RESULT_ROWS = 2000;
/** How many nodes one `append(...nodes)` call is handed at most (a call takes about 124 000 arguments). */
const APPEND_CHUNK = 10_000;

/**
 * `parent.append(...nodes)` in pieces of {@link APPEND_CHUNK}: the same children in the same
 * order, however many there are.
 * @param {Element} parent
 * @param {readonly Element[]} nodes
 */
function appendInPieces(parent, nodes) {
  for (let index = 0; index < nodes.length; index += APPEND_CHUNK) parent.append(...nodes.slice(index, index + APPEND_CHUNK));
}

/**
 * @param {Element} row a row of the result table
 * @returns {boolean} whether it is a series' header row ({@link buildEngine} `onStart`)
 */
function isSeriesRow(row) {
  return ` ${row.className} `.includes(" series-row ");
}

/**
 * `rows` without the header rows of the series that have no row left among them (their rows all
 * failed and moved to the failed block, or the trimming took them).
 * @param {readonly Element[]} rows
 * @returns {Element[]}
 */
function withoutBareHeaders(rows) {
  const shown = new Set(rows.filter((row) => !isSeriesRow(row)).map((row) => row.getAttribute("data-series-id")));
  return rows.filter((row) => !isSeriesRow(row) || shown.has(row.getAttribute("data-series-id")));
}

/**
 * Keep the result table light (called when a series of a batch is done): over `limit` rows, the
 * OLDEST rows of episodes that completed — done, skipped, dry run — leave, then the header rows
 * of the series left with no row. A failure row never leaves (the job's end shows those apart,
 * {@link renderFailed}), nor does its series' header; every finished series keeps its report
 * line, and `#result-trimmed` says so once rows have left. A display matter
 * only: the results, the history and the report are untouched. (Exported for the unit tests,
 * which cannot run a job.)
 * @param {number} [limit] {@link MAX_RESULT_ROWS}; lower only in the test copy of the extension
 */
export function trimResultRows(limit = (app.testMode ? app.testSettings.maxResultRows : undefined) ?? MAX_RESULT_ROWS) {
  const body = /** @type {HTMLTableSectionElement} */ ($("result-table").querySelector("tbody"));
  const rows = [...body.children];
  let excess = rows.length - limit;
  if (excess <= 0) return;
  /** @type {Set<Element>} */
  const leaving = new Set();
  for (const row of rows) {
    if (excess <= 0) break;
    if (isSeriesRow(row) || isFailure(row.getAttribute("data-status"))) continue;
    leaving.add(row);
    excess -= 1;
  }
  if (leaving.size === 0) return;
  body.replaceChildren();
  appendInPieces(body, withoutBareHeaders(rows.filter((row) => !leaving.has(row)))); // a header whose series has no row left goes too
  $("result-trimmed").hidden = false;
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
  $("result-trimmed").hidden = true;
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
  if (!app.owner || app.cooldown !== null || app.unsaved !== null || spentRetries.has(source)) return;
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
    const kept = [...results.children].filter((row) => !leaving.has(`${row.getAttribute("data-series-id")}:${row.getAttribute("data-number")}`));
    results.replaceChildren();
    // a series' header with no row left goes too; never one spread of them all: a table of
    // 125 000 rows would overflow the call
    appendInPieces(results, withoutBareHeaders(kept));
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
    listedEpisodes: null,
    episodesDigest: episodes === null ? null : episodes.map(digestEntry), // of every listed episode, made now
    // the raw item and the trace only of the rows the report describes (`lib/diagnosis.slimRows`)
    episodes: slimRows(
      run.results.map((result) => ({
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
    ),
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
 * @param {readonly SeriesInput[]} [taken] what the report reads of the first runs, taken already
 *   (a batch: {@link releaseSeries}); the other runs are read now
 * @returns {Promise<void>}
 */
export async function reportJobEnd(job, outcome, runs, traceOf, taken = []) {
  app.lastReport = null;
  try {
    if (job.kind !== "load" && runs !== null) {
      const series = runs.map((run, index) => taken[index] ?? seriesInput(run, traceOf));
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
  renderLibrary(); // the library's cards: queued, downloading
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
  if (app.unsaved !== null) {
    // the page cannot store anything any more: a job would only be refused, after clearing the
    // last one's results (the popup's "Download this series" and the retry buttons come here too)
    void showStorageRefused();
    return;
  }
  app.queue.push({ ...job, id: app.nextJobId++ });
  renderAppStatus();
  void pump();
}

async function pump() {
  if (app.running !== null || !app.owner) return;
  if (app.queue.length === 0) {
    covers.resume(); // nothing to run: the list's thumbnails may go on
    libraryCovers.resume(); // and the library's
    return;
  }
  const job = /** @type {Job} */ (app.queue.shift());
  app.running = job;
  app.stopRequested = false;
  library.running = null;
  library.finished.clear();
  renderAppStatus();
  try {
    await covers.idle(); // a thumbnail request in flight ends first: one request at a time
    await libraryCovers.idle();
    await runJob(job);
  } finally {
    app.running = null;
    app.finished += 1;
    app.stopRequested = false;
    library.running = null;
    library.finished.clear();
    // the library's cards of what the job downloaded read the records again
    if (job.kind === "batch" || job.kind === "selection") void refreshLibraryStatuses(job.refs.map((ref) => ref.seriesId));
    void updateLibrarySource();
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
  const jobRecord = { pauses: [], inputs: [], taking: true };
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
    } else if (job.kind === "favorites") {
      stop = await runFavorites(job, engine, entry);
    } else if (job.kind === "unbookmark") {
      stop = await runUnbookmark(job, engine, entry);
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
    if ((job.kind === "batch" || job.kind === "selection") && listed !== null && job.refs.some((ref) => ref.seriesId === listed.series.seriesId)) {
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
      await showStorageRefused();
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
      jobRecord.inputs,
    );
  }
}

/**
 * **Load list**: list one series (no download) and show its episodes — a job like any other: the
 * rest between jobs first (no long break: a listing alone is no download attempt), the cooldown
 * asked again after it. A right-click on a drama of the user's TikTok favorites (`job.card`) is a
 * listing too, in ONE job (so no rest more): the card is resolved to its series first — from the
 * favorites the panel shows, with no request ({@link cardStart}), or else from the tab's favorites
 * list read from its top until it reaches the card ({@link fetchFavorites}, paced;
 * `lib/favorites.coversCard`: a page past the card's position when its drama is not where the card
 * sits) —, never by a guess between dramas of the same title (`lib/favorites.resolveCard`: those
 * are shown in the panel for the user to pick, nothing listed; `lib/favorites.coversShift` names
 * the limit),
 * the series joins the box like any series handed over, and the listing goes on as for **Load
 * list**. Returns why the job stopped (a cooldown met meanwhile, a refusal or a login wall met while
 * reading the list or before it), or null. (Exported for the unit tests, which cannot run a job.)
 * @param {Job} job
 * @param {Engine} engine
 * @param {Record<string, unknown>} entry
 * @returns {Promise<string | null>}
 */
export async function runLoad(job, engine, entry) {
  /** @type {CardStart | null} */
  let start = null;
  if (job.card) {
    start = await cardStart(job, entry); // before the rest: without what the card needs, no request at all
    if ("done" in start) return start.done; // said why, no request; a login wall seen there is the job's stop
  }
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
  if (start !== null) {
    /** @type {FavoriteItem | null} */
    let item = "item" in start ? start.item : null;
    if ("template" in start) {
      const card = /** @type {Card} */ (job.card);
      const tabId = /** @type {number} */ (job.favoritesTab);
      let read;
      try {
        read = await fetchFavorites(job, engine, tabId, start.template, card);
      } catch (error) {
        if (error instanceof StopRequested) throw error;
        return favoritesFailed(error, entry);
      }
      const { listing } = read;
      const resolved = resolveCard(listing.items, card);
      // TikTok stopped sending the list before it could tell the card's drama: no guess
      if (cutShort(listing) && stoppedShortOfCard(listing.items, card, listing.perPage, resolved)) {
        return cardCutShort(card, listing.items.length, entry);
      }
      if (resolved.kind === "missing") return cardNotFound(card, entry);
      if (resolved.kind === "shared") {
        // the list consulted, in the library — unless the library is larger and holds those dramas;
        // a library of another TikTok profile stays as it was, and offers nothing to pick from
        if (!read.shown && takesLibraryPlace(listing, card) && !(await showFavoritesListing(tabId, listing, start.template.profile))) return cardSharedElsewhere(card, entry);
        return cardShared(card, entry);
      }
      item = resolved.item;
    }
    const found = /** @type {FavoriteItem} */ (item);
    joinBox([found]);
    if (app.queue.some((queued) => queued.kind === "load" && queued.refs[0]?.seriesId === found.seriesId)) {
      setStatus($("input-status"), t("loadAlreadyQueued"), "error"); // a waiting Load list lists it: not twice
      return null;
    }
    job.refs = [{ kind: "series", seriesId: found.seriesId, episodeHint: null, sourceUrl: found.seriesId }];
    setStatus($("input-status"), t("loading"));
  }
  const ref = /** @type {SeriesRef} */ (job.refs[0]);
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

// ------------------------------------------------------------ the user's TikTok favorites

/**
 * The series ticked in the library, by series id: never cleared by another tab's listing (a card
 * built for a ticked id shows ticked), pruned only by a COMPLETE listing that becomes the library —
 * the ids it does not hold are dropped ({@link endFavorites}) —, emptied by **Clear selection**,
 * and cleared by **Download selected** of the dramas it queues, those only ({@link onLibraryDownload}).
 */
const favoritesSelected = new Set();

/**
 * The library around `app.favorites` (DramaFetch 1.6.0, the user's TikTok Bookmark): what is kept
 * with the list (`favoritesLibrary`) and what the grid shows of it.
 */
const library = {
  /** @type {string | null} the `@handle` of the TikTok tab the list was read from */
  profile: null,
  /** @type {number | null} when TikTok's count was last read (seconds since the epoch) */
  countedAt: null,
  /**
   * @type {number | null} when a listing last read the whole list, each drama's episode count with
   * it (seconds since the epoch): the smart refresh's one-page shortcut and the removal's gate trust
   * those counts for 24 h after it (`lib/library.countsFresh`); a first page read since changes it not
   */
  fullReadAt: null,
  /** whether the count is the last one minus DramaFetch's removals since — not read from TikTok */
  unconfirmed: false,
  /** @type {Map<string, number>} the dramas DramaFetch removed from the Bookmark since the list was read: series id → when */
  removed: new Map(),
  /** @type {Map<string, Progress>} what DramaFetch's own records say of each drama (`lib/library.progressOf`) */
  progress: new Map(),
  /** @type {string | null} the series the running job is downloading now */
  running: null,
  /** @type {Set<string>} the series the running job has finished */
  finished: new Set(),
  /** @type {LibraryFilter} the status filter (a chip) */
  filter: "all",
  /** how many of the matching dramas the grid shows: pieces of `LIBRARY_PIECE` */
  shown: LIBRARY_PIECE,
  /** whether a write of the library `chrome.storage.local` refused was said already (once a page) */
  saveRefusedSaid: false,
  /**
   * when the library last changed in this page (seconds since the epoch): a listing taken, a count
   * read, a removal — every change is kept at once ({@link saveLibrary}); a card's listing kept
   * apart that is older never enters it ({@link cardStart})
   */
  changedAt: 0,
  /** @type {{tabId: number, url: string, profile: string | null} | null} a TikTok tab with a favorites address, as last looked ({@link findFavoritesTab}) */
  source: null,
  /** when the connection line was drawn last (seconds) */
  drawnAt: 0,
  /** when the TikTok tabs were looked at last (seconds) */
  lookedAt: 0,
};

/**
 * The grid's cards as drawn last, by series id: the drama, its card, its tick and the buttons that
 * would start a job (disabled when no job may start: `updateButtons`).
 * @type {Map<string, {item: FavoriteItem, article: HTMLElement, box: HTMLInputElement | null, cover: HTMLElement, actions: HTMLButtonElement[]}>}
 */
const libraryCards = new Map();

/**
 * The last listing a right-clicked card read of a TikTok tab's favorites WITHOUT filling the
 * library — the library showing another list: one kept from an earlier session (no tab), or
 * another tab's —, kept apart from the library view: 1.5.0's panel list of that tab, which the
 * next right-click on that tab is resolved from under the same rules ({@link cardStart}: with no
 * request where it reaches the card). Replaced by a later card listing of another tab, extended by
 * a longer one of the same tab (1.5.0's rule), dropped once a listing of that tab fills the library
 * (and back when that listing leaves the library as it was: {@link restoreKeptLibrary}). It enters
 * the library — two dramas of a card's title the library lacks one of — only while the library has
 * learned nothing since it was read, dated from then; older, it is dropped and the list read again
 * ({@link cardStart}).
 * @type {KeptCardList | null}
 */
let cardList = null;

/**
 * {@link cardList} as the list a card's resolution reads ({@link FavoritesShown}).
 * @param {KeptCardList} kept
 * @returns {FavoritesShown}
 */
function cardListShown(kept) {
  const { listing } = kept;
  return {
    tabId: kept.tabId,
    items: listing.items,
    total: listing.total,
    complete: listing.complete,
    ended: listing.ended,
    short: cutShort(listing),
    skipped: listing.skipped,
    perPage: listing.perPage,
    loading: false,
    listedAt: kept.listedAt,
  };
}

/**
 * A card's listing of TikTok tab `tabId` that did not fill the library: kept as that tab's list for
 * the next right-clicks ({@link cardList}) — unless a list of that tab known whole, or one as long,
 * is kept already (a card listing extends it only when it holds more, as 1.5.0's panel).
 * @param {number} tabId
 * @param {FavoritesListing} listing
 * @param {string | null} profile whose favorites it read ({@link FavoritesAddress})
 */
function keepCardList(tabId, listing, profile) {
  const kept = cardList !== null && cardList.tabId === tabId ? cardList : null;
  if (kept !== null && (kept.listing.complete || listing.items.length <= kept.listing.items.length)) return;
  cardList = { tabId, listing: { ...listing, items: [...listing.items] }, listedAt: now(), profile };
}

/** @returns {FavoriteItem[]} the library's dramas, each once, in the list's order */
function libraryItems() {
  return app.favorites === null ? [] : distinctItems(app.favorites.items);
}

/** @returns {FavoriteItem[]} the library's dramas DramaFetch has not removed from the Bookmark */
function keptItems() {
  return libraryItems().filter((item) => !library.removed.has(item.seriesId));
}

/** @returns {number} how many dramas the library holds that are still in the Bookmark */
function keptCount() {
  return keptItems().length;
}

/**
 * **List favorites** — the popup's **Open my library** on a TikTok profile, and **Update from
 * TikTok**: the smart refresh of the library, a job like any other — nothing asked of TikTok
 * without that tab and its favorites address, then the rest between jobs, the cooldown before it
 * and before every page ({@link fetchFavorites}). When the library holds a list read from this
 * TikTok profile, the first page may say it is TikTok's list as it is (`lib/library.unchangedSince`):
 * one request, `libraryUnchanged`; otherwise every page, into the library as pages arrive — kept
 * only when it may be (a library that held dramas comes back as it was unless TikTok's whole list
 * was read: {@link fetchFavorites}). **Stop** ends it between two pages. When TikTok stopped sending
 * the list before its end (`favorites.cutShort`) the page says so, and the history keeps it — TikTok
 * refused nothing, so it is no stop. The status line and the history entry count what the listing
 * listed ({@link listedOf}); when a library that held dramas came back as it was, the status line
 * says so (`libraryKept`, `libraryKeptEmpty`: an error, no stop) and the history keeps why. Returns
 * why the job stopped (a cooldown met, a refusal, a login wall — also one met before the first
 * request), or null.
 * (Exported for the unit tests, which cannot run a job.)
 * @param {Job} job
 * @param {Engine} engine
 * @param {Record<string, unknown>} entry
 * @returns {Promise<string | null>}
 */
export async function runFavorites(job, engine, entry) {
  const tabId = /** @type {number} */ (job.favoritesTab);
  const template = await favoritesTemplate(tabId, entry);
  if ("stop" in template) return template.stop; // said why, no request; a login wall is the job's stop
  setStatus($("input-status"), t("favoritesListing"));
  await restBetweenJobs(engine, { lastContactAt: app.lastContactAt, batchJob: false });
  const refused = await checkCooldown(engine);
  if (refused !== null) {
    const message = cooldownMessage(refused, { now: now() });
    setStatus($("input-status"), shownText(message), "error");
    entry["error"] = message;
    return message;
  }
  await storePacing(); // can anything be stored? asked before the first request, as the engine does
  if (app.unsaved !== null) {
    entry["error"] = app.unsaved;
    return app.unsaved;
  }
  let read;
  try {
    read = await fetchFavorites(job, engine, tabId, template);
  } catch (error) {
    if (error instanceof StopRequested) {
      noteListed(entry, job); // the history keeps how many were listed before the Stop
      throw error;
    }
    return favoritesFailed(error, entry);
  }
  noteListed(entry, job);
  const { listing } = read;
  if (read.unchanged) {
    // the library is TikTok's list as it is: one request, and its count TikTok's
    setStatus($("input-status"), t("libraryUnchanged", [listing.total ?? keptCount()]), "ok");
    return null;
  }
  if (!read.shown) {
    // a library that held dramas came back as it was — not TikTok's whole list ({@link fetchFavorites}):
    // the page says so, an error; TikTok refused nothing, so no stop. The history keeps why: TikTok
    // cutting the list short, as before, else this text
    const text = listing.items.length + listing.skipped === 0 ? t("libraryKeptEmpty") : t("libraryKept", [listedOf(job).count]);
    setStatus($("input-status"), text, "error");
    entry["error"] = cutShort(listing) ? t("favoritesCutShort", [listedOf(job).count]) : text;
    return null;
  }
  if (cutShort(listing)) {
    // TikTok sent no more than this: said, and kept in the history — it refused nothing, so no stop
    const text = t("favoritesCutShort", [listedOf(job).count]);
    setStatus($("input-status"), text, "error");
    entry["error"] = text;
    return null;
  }
  setStatus($("input-status"), t("favoritesLoaded", [listedOf(job).count]), "ok");
  return null;
}

/**
 * What a favorites job's listing listed — its dramas, each once, and the list's items it left out
 * for want of a readable series id —, whatever became of the library (a listing that stops short
 * of TikTok's end leaves a library that held dramas as it was: {@link fetchFavorites}); the
 * library's own when no page of the listing filled it (the smart refresh's first page that found it
 * unchanged, a Stop before the first page).
 * @param {Job} job
 * @returns {{count: number, skipped: number}}
 */
function listedOf(job) {
  return job.listed ?? { count: keptCount(), skipped: app.favorites?.skipped ?? 0 };
}

/**
 * A favorites listing's history entry: how many dramas it listed, and — when some were — how many
 * of the list's items it left out for want of a readable series id ({@link listedOf}).
 * @param {Record<string, unknown>} entry
 * @param {Job} job
 */
function noteListed(entry, job) {
  const { count, skipped } = listedOf(job);
  entry["favorites"] = count;
  if (skipped > 0) entry["favorites_skipped"] = skipped;
}

/**
 * The favorites address of TikTok tab `tabId` — the first page of its favorites list, as the tab
 * asked for it and the worker saw it, with whose list it reads ({@link FavoritesAddress}) — once
 * that tab is still there and on TikTok; else the page says what to do and the job's stop comes back
 * instead (`favoritesFailed`: the login wall in the tab is a stop, the jobs waiting behind end
 * without a request; no address seen or the tab gone, null): no request either way.
 * @param {number} tabId
 * @param {Record<string, unknown>} entry
 * @returns {Promise<FavoritesAddress | {stop: string | null}>}
 */
async function favoritesTemplate(tabId, entry) {
  const template = await readFavoritesTemplate(tabId).catch(() => null);
  if (template === null) return { stop: favoritesFailed(new FavoritesError("no-template"), entry) };
  try {
    await checkFavoritesTab(tabId, template.url);
  } catch (error) {
    return { stop: favoritesFailed(error, entry) };
  }
  return { url: template.url, profile: template.profile };
}

/**
 * What a right-click on a favorites card needs before the job's first request — from the list the
 * library shows for that tab, or else the list an earlier card of that tab read ({@link cardList}:
 * 1.5.0's panel list), when it can tell, with no request at all (a list read from the top,
 * `lib/favorites.resolveCard`; a library restored from an earlier session is no tab's list:
 * `tabId` null, never trusted here):
 * - unless the tab has listed its favorites again since the library's list (its grid may have
 *   moved, and TikTok may send more of it now): TikTok stopped sending that list before it could
 *   tell the card's drama (`favorites.cutShort`, {@link stoppedShortOfCard}) →
 *   `favoritesCardCutShort`, since a new listing would end the same; several dramas of the card's
 *   title in it, the card's position covered → those dramas shown in the library for the user to
 *   pick ({@link cardShared}; a library of another TikTok profile than the tab's stays as it was:
 *   {@link cardSharedElsewhere}) — when that list is an earlier card's listing that would change
 *   the library ({@link takesLibraryPlace}), it goes into the library, dated from when it was read,
 *   only while the library has learned nothing since (`library.changedAt`: no listing, count or
 *   removal since); older, it would bring back a drama removed since or an old count, so it is
 *   dropped and the list read again; the list known whole without the title → `favoritesNotFound`;
 * - the one drama of the card's title, where a fresh listing would stop too
 *   (`lib/favorites.coversCard`: away from the card's position, a page past it read), or in a list
 *   known whole or one TikTok sent no more of → that drama; once the tab has listed its favorites
 *   again since, only when it sits at the card's very position (a drama of that title favorited
 *   since may be in the grid and not in the library's list: it moved every card).
 * Anything else — no list of that tab in the library, one that does not reach the card or lacks its
 * title, dramas of the same title in a list the tab has listed again since, the one drama of the
 * title away from the card's position in such a list — needs the list read again from its top: the
 * tab's favorites address, checked ({@link favoritesTemplate}).
 * @param {Job} job
 * @param {Record<string, unknown>} entry
 * @returns {Promise<CardStart>}
 */
async function cardStart(job, entry) {
  const tabId = /** @type {number} */ (job.favoritesTab);
  const card = /** @type {Card} */ (job.card);
  // the library's list when it is that tab's; else an earlier card's listing of that tab
  const kept = app.favorites?.tabId !== tabId && cardList !== null && cardList.tabId === tabId ? cardList : null;
  const shown = kept !== null ? cardListShown(kept) : app.favorites;
  if (shown !== null && shown.tabId === tabId && !shown.loading && shown.items.length > 0) {
    const latest = await readFavoritesTemplate(tabId).catch(() => null);
    const listedSince = latest !== null && latest.at > shown.listedAt;
    const reached = shown.complete || shown.items.length > card.index;
    const resolved = resolveCard(shown.items, card);
    if (!listedSince) {
      if (shown.short && stoppedShortOfCard(shown.items, card, shown.perPage, resolved)) return { done: cardCutShort(card, shown.items.length, entry) };
      if (resolved.kind === "shared" && reached) {
        if (kept === null || !takesLibraryPlace(kept.listing, card)) return { done: cardShared(card, entry) };
        // an earlier card's listing of that tab that would change the library was read at its own
        // time: into the library — stamped with that time — only while the library has learned
        // nothing since (no listing, count or removal: every change is kept at once,
        // `library.changedAt`), and never into a library of another TikTok profile, which stays as
        // it was — no request either way
        if (kept.listedAt > Math.max(library.changedAt, app.favorites?.listedAt ?? 0)) {
          if (!(await showFavoritesListing(tabId, kept.listing, kept.profile, kept.listedAt))) return { done: cardSharedElsewhere(card, entry) };
          return { done: cardShared(card, entry) };
        }
        if (libraryItems().length > 0 && library.profile !== null && kept.profile !== library.profile) return { done: cardSharedElsewhere(card, entry) };
        // older than what the library learned since — it would bring back a drama removed since,
        // or an old count —: the list is read again from its top (below), and that listing is the
        // tab's kept list from now on
        cardList = null;
      }
      if (resolved.kind === "missing" && shown.complete) return { done: cardNotFound(card, entry) };
    }
    // the tab listed its favorites again since: the grid may hold a drama of that title favorited
    // since, which the library's list lacks — its one drama of the title is still the card's only
    // where it sits at the card's very position (a favorite added or removed moves every card)
    if (
      resolved.kind === "found" &&
      (!listedSince || resolved.index === card.index) &&
      (shown.complete || (shown.short && !listedSince) || coversCard(shown.items, card, shown.perPage))
    ) {
      return { item: resolved.item };
    }
  }
  const template = await favoritesTemplate(tabId, entry);
  return "url" in template ? { template } : { done: template.stop };
}

/**
 * Whether a list of the favorites that TikTok stopped sending before its end (`favorites.cutShort`)
 * stops before it can tell a right-clicked card's drama: before the card's position, before the
 * card's title, or — the one drama of that title away from the card's position: the grid has moved
 * since it loaded — before a page past that position (`lib/favorites.coversShift`), where the
 * card's own drama, of the same title, may lie unseen. Two dramas of the title in it are shown
 * instead ({@link cardShared}).
 * @param {readonly FavoriteItem[]} items the list, read from its top
 * @param {Card} card
 * @param {number} perPage how many dramas a page of the list held
 * @param {CardResolution} resolved what `items` say of the card (`lib/favorites.resolveCard`)
 * @returns {boolean}
 */
function stoppedShortOfCard(items, card, perPage, resolved) {
  if (items.length <= card.index || resolved.kind === "missing") return true;
  return resolved.kind === "found" && !coversShift(items, card, perPage);
}

/**
 * Several of the user's favorites bear the right-clicked card's title: none is picked — its
 * position cannot tell them apart. The library shows them — its search box set to that title, every
 * status shown, the section scrolled into view —, each with its episodes and length, and the page
 * asks the user to tick the one they right-clicked and press **Add selected to the box**; the job
 * lists nothing, and its history entry keeps the text.
 * @param {Card} card
 * @param {Record<string, unknown>} entry
 * @returns {null}
 */
function cardShared(card, entry) {
  input("favorites-filter").value = cleanTitle(card.title);
  library.filter = "all";
  applyFavoritesFilter();
  $("favorites-card").hidden = false;
  showLibrarySection();
  const message = t("favoritesShared", card.title);
  setStatus($("input-status"), message, "error");
  entry["error"] = message;
  return null;
}

/**
 * Several dramas of the right-clicked tab's favorites bear the card's title, and the library is
 * another TikTok profile's ({@link showFavoritesListing} left it untouched: one account's list never
 * enters another's library): none is picked — DramaFetch never guesses —, the library stays exactly
 * as it was, and the page says to open the one wanted on TikTok and use the toolbar button →
 * **Download this series** (`favoritesSharedElsewhere`, an error); the job lists nothing, and its
 * history entry keeps the text.
 * @param {Card} card
 * @param {Record<string, unknown>} entry
 * @returns {null}
 */
function cardSharedElsewhere(card, entry) {
  const message = t("favoritesSharedElsewhere", card.title);
  setStatus($("input-status"), message, "error");
  entry["error"] = message;
  return null;
}

/**
 * Whether the listing in which a card's title was found shared by several dramas goes into the
 * library (so that the user sees them all to pick from; {@link showFavoritesListing} decides how:
 * in the library's place, joined into it, or — a library of another TikTok profile — not at all):
 * when it is TikTok's whole list ({@link readWhole}: newer than the library), or the library holds fewer
 * dramas than it, or the listing found a drama of that title the library does not hold among the
 * dramas still in the Bookmark (one favorited since, or one DramaFetch removed and the user
 * bookmarked again) — the library, filtered to the title, would not offer it. Otherwise the library
 * — larger, and holding every drama of that title the listing found — stays as it is, filtered to
 * the title. A partial listing never shrinks it either way.
 * @param {FavoritesListing} listing
 * @param {Card} card
 * @returns {boolean}
 */
function takesLibraryPlace(listing, card) {
  if (readWhole(listing)) return true;
  if (libraryItems().length < distinctItems(listing.items).length) return true;
  const wanted = cleanTitle(card.title);
  const held = new Set(keptItems().map((item) => item.seriesId));
  return listing.items.some((item) => item.title !== null && cleanTitle(item.title) === wanted && !held.has(item.seriesId));
}

/**
 * A right-clicked card names a drama the favorites list does not hold (any more): the page says so
 * and the job ends — nothing listed.
 * @param {Card} card
 * @param {Record<string, unknown>} entry
 * @returns {null}
 */
function cardNotFound(card, entry) {
  const message = t("favoritesNotFound", card.title);
  setStatus($("input-status"), message, "error");
  entry["error"] = message;
  return null;
}

/**
 * A right-clicked card lies further down the favorites than TikTok sent (`favorites.cutShort`): the
 * page says so and how to list that drama anyway, and the job ends — nothing listed.
 * @param {Card} card
 * @param {number} count the dramas TikTok sent
 * @param {Record<string, unknown>} entry
 * @returns {null}
 */
function cardCutShort(card, count, entry) {
  const message = t("favoritesCardCutShort", [card.title, count]);
  setStatus($("input-status"), message, "error");
  entry["error"] = message;
  return null;
}

/**
 * Read TikTok tab `tabId`'s favorites list (`favorites.listFavorites`: from inside that tab, from
 * its top, paced, one request at a time, the cooldown before every page, a refusal recorded) — all
 * of it (**List favorites**, into the library as pages arrive), or, for a right-clicked `card`,
 * until it reaches the card (`lib/favorites.coversCard`). A card's listing fills the library only
 * when it shows nothing yet, or — at its end — when the library shows the same tab's list, not
 * complete, and the listing holds more dramas than it (it extends it, {@link showFavoritesListing}:
 * never a library of another TikTok profile); otherwise the library — cards, count line, ticks —
 * stays exactly as it was, the card is resolved from the listing, and the listing is kept as that
 * tab's list for the next right-clicks ({@link keepCardList}).
 * **List favorites** over a library read from this TikTok profile, its whole list read less than
 * 24 h ago (`lib/library.countsFresh`: the episode counts it holds), is the smart refresh: its
 * first page decides (`lib/library.unchangedSince`) — the list as it was, and the listing stops
 * there (one request: the library keeps its dramas, without the ones DramaFetch removed, and takes
 * TikTok's count), else it reads on. A library that shows a list keeps showing it until the
 * listing's first page arrives (a refusal before it leaves it as it was). What a listing that filled
 * the library read becomes the library kept across sessions (`favoritesLibrary`, with the profile
 * recorded with `template`: whose list it is) only when it may ({@link adoptable}): over a library
 * that held dramas, TikTok's whole list alone ({@link readWhole}) — with a drama, or with TikTok
 * counting none —; over one that held none, a drama at least (the list complete or not), or
 * TikTok's whole list counting none. A listing that stops short of that never shrinks a library that
 * held dramas — a refusal, a login wall, the tab gone or **Stop** on a later page, TikTok cutting
 * the list short, an empty first page (TikTok may answer a replay it no longer accepts so,
 * `favorites.js`) —: the library comes back as it was ({@link restoreKeptLibrary}), taking only what
 * the listing read of the library's own profile — TikTok's count, and the fresh entries of the dramas
 * it read —; over a library that held none, what was read stays shown, not kept. The job's contact with TikTok is noted at both ends, as a listing's; nothing is asked when
 * this page could not store a write.
 * @param {Job} job
 * @param {Engine} engine
 * @param {number} tabId
 * @param {FavoritesAddress} template the tab's favorites address, and whose list it reads: the
 *   profile the library takes, never the page the tab shows by the listing's end
 * @param {Card} [card]
 * @returns {Promise<{listing: FavoritesListing, shown: boolean, unchanged: boolean}>} the listing,
 *   whether the library shows it, and whether its first page found the library unchanged
 */
async function fetchFavorites(job, engine, tabId, template, card) {
  await noteContact(job);
  if (app.unsaved !== null) throw new StorageRefusedError(app.unsaved); // that save refused: not one request
  const test = app.testMode ? app.testSettings : {};
  const before = app.favorites;
  const empty = before === null || before.items.length === 0;
  const fills = card === undefined || empty;
  // a library that holds dramas, as it is before any request: what comes back unless the listing
  // that fills it ends as TikTok's whole list (the listing puts a new object in `app.favorites`)
  /** @type {LibrarySnapshot | null} */
  const snapshot = fills && before !== null && !empty ? { favorites: before, removed: [...library.removed], shown: library.shown, cardList } : null;
  job.listed = undefined; // what THIS listing lists
  // the smart refresh: a library read from this TikTok profile may be TikTok's list as it is — while
  // its episode counts are fresh: a series that gained episodes moves neither TikTok's count nor its first page
  const { profile } = template;
  const smart = card === undefined && !empty && library.profile !== null && countsFresh(library.fullReadAt, now()) && profile === library.profile;
  const kept = smart ? keptItems().map((item) => item.seriesId) : [];
  let unchanged = false;
  let started = false;
  let filled = 0;
  /** @type {import("./favorites.js").FavoritesOptions} */
  const options = {
    onPage: (listing, page) => {
      if (smart && listing.pages === 1) unchanged = unchangedSince(kept, page.items.map((item) => item.seriesId), listing.total);
      if (unchanged || !fills) {
        showListingProgress(listing); // the library stays as it was
        return;
      }
      if (!started) {
        started = true;
        startFavorites(tabId);
      }
      filled += 1;
      job.listed = { count: distinctItems(listing.items).length, skipped: listing.skipped };
      showFavoritesPage(listing);
    },
  };
  if (test.pageDelayS !== undefined) options.pageDelayS = test.pageDelayS;
  if (test.discoveryTimeoutS !== undefined) options.timeoutS = test.discoveryTimeoutS;
  if (card !== undefined) options.until = (items, perPage) => coversCard(items, card, perPage);
  else if (smart) options.until = () => unchanged;
  if (fills && empty) {
    started = true; // an empty library shows the listing from its start, as 1.5.0's panel did
    startFavorites(tabId);
  }
  /** @type {FavoritesListing | null} */
  let listing = null;
  let shown = false;
  try {
    listing = await listFavorites(engine, tabId, template.url, options);
    if (unchanged) {
      await keepLibrary(tabId, listing);
      return { listing, shown: true, unchanged: true };
    }
    if (!fills) {
      const extending = before !== null && before.tabId === tabId && !before.complete && listing.items.length > before.items.length;
      if (extending) shown = await showFavoritesListing(tabId, listing, profile);
      else if (before !== null && before.tabId !== tabId) keepCardList(tabId, listing, profile); // the library is another list: kept apart
    }
  } finally {
    // a listing that filled the library: kept, or the library as it was — on every path, errors and Stop included
    if (fills && started) shown = await endListing(tabId, listing, filled, snapshot, profile);
    await noteContact(job);
  }
  return { listing, shown, unchanged: false };
}

/**
 * A listing that filled the library ended ({@link fetchFavorites}) — at TikTok's end, or before it
 * (a card's position reached, the page cap, TikTok cutting the list short, an error, **Stop**):
 * what it read becomes the library kept across sessions when it may ({@link adoptable}); else a
 * library that held dramas comes back as it was ({@link restoreKeptLibrary}), and one that held none
 * shows what was read without keeping it. Only a listing that becomes the library prunes the ticks
 * ({@link endFavorites}). Returns whether the library shows what the listing read.
 * @param {number} tabId
 * @param {FavoritesListing | null} listing null when it ended without one (an error, a Stop)
 * @param {number} filled how many of its pages the library showed
 * @param {LibrarySnapshot | null} snapshot the library before the listing, when it held dramas
 * @param {string | null} profile whose favorites the listing read ({@link FavoritesAddress})
 * @returns {Promise<boolean>}
 */
async function endListing(tabId, listing, filled, snapshot, profile) {
  const read = app.favorites;
  const adopt = filled > 0 && read !== null && adoptable(read, listing, snapshot !== null);
  endFavorites(listing, adopt);
  if (adopt) {
    await adoptListing(profile);
    return true;
  }
  if (filled > 0 && snapshot !== null) {
    await restoreKeptLibrary(snapshot, read, profile);
    return false;
  }
  return true; // a library that held none: what was read stays shown, and is not kept
}

/**
 * Whether what a listing that filled the library read may become the library kept across sessions:
 * over a library that held dramas (`held`), only TikTok's whole list ({@link readWhole}) with a
 * drama at least, or with TikTok counting none (the user really has no favorites left); over one
 * that held none, a drama at least (the list complete or not, as 1.5.0's panel kept what it read),
 * or TikTok's whole list counting none. An empty read is kept in no other case: TikTok may answer a
 * replay it no longer accepts with an empty list (`favorites.js`).
 * @param {FavoritesShown} read what the listing's pages filled the library with
 * @param {FavoritesListing | null} listing null when it ended without one (an error, a Stop)
 * @param {boolean} held whether the library held dramas before the listing
 * @returns {boolean}
 */
function adoptable(read, listing, held) {
  const whole = readWhole(listing);
  const dramas = read.items.length > 0;
  return held ? whole && (dramas || read.total === 0) : dramas || (whole && read.total === 0);
}

/**
 * Whether a listing read TikTok's whole list: it reached the list's end (`hasMore` false), or it
 * ended at a cursor that did not move or came again, a page TikTok served again, or empty pages
 * (`favorites.listFavorites`) once TikTok had sent every favorite it counts — one at least: its
 * distinct dramas and the items without a readable series id reach TikTok's count, so nothing is
 * missing (`favorites.cutShort` says the opposite). The page cap and a card's `until` never count;
 * an empty answer with TikTok counting none is whole only at the list's end.
 * @param {FavoritesListing | null} listing
 * @returns {boolean}
 */
function readWhole(listing) {
  if (listing === null) return false;
  if (listing.complete) return true;
  if (listing.ended !== "cursor" && listing.ended !== "empty") return false;
  return listing.total !== null && listing.total > 0 && distinctItems(listing.items).length + listing.skipped >= listing.total;
}

/**
 * A listing that filled a library which held dramas did not end as TikTok's whole list
 * ({@link adoptable}): the library comes back as it was — its dramas and their order, the dramas
 * DramaFetch removed, how many cards the grid drew, the list a right-click read of a tab — and is
 * not written again, but for what the listing read of the library's own profile (another account's
 * list and count are never this library's): every drama of the library the listing read takes the
 * listing's fresh entry (title, episodes, cover — an episode count TikTok raised since the whole
 * list was read is never put back: such a drama is Partly, never removed), no drama added or
 * dropped, the order kept; and TikTok's count, when the listing read one (`read.total`, as its pages
 * set it — also when it ended with an error), is the library's, read now; both kept. When its whole
 * list was last read (`fullReadAt`), its profile and its covers in the browser session's memory stay
 * as they were; what the records say of the dramas the listing showed is read again (their cards may
 * have been drawn from its entries).
 * @param {LibrarySnapshot} snapshot
 * @param {FavoritesShown | null} read what the listing's pages filled the library with
 * @param {string | null} profile whose favorites the listing read ({@link FavoritesAddress})
 * @returns {Promise<void>}
 */
async function restoreKeptLibrary(snapshot, read, profile) {
  const total = read?.total ?? null;
  const kept = snapshot.favorites;
  kept.loading = false;
  app.favorites = kept;
  library.removed = new Map(snapshot.removed);
  library.shown = snapshot.shown;
  cardList = snapshot.cardList;
  const listed = read === null ? [] : distinctItems(read.items);
  if (library.profile !== null && profile === library.profile) {
    const fresh = new Map(listed.map((item) => [item.seriesId, item]));
    const renewed = kept.items.some((item) => fresh.has(item.seriesId));
    if (renewed) kept.items = kept.items.map((item) => fresh.get(item.seriesId) ?? item);
    if (total !== null) {
      kept.total = total;
      library.countedAt = now();
      library.unconfirmed = false;
    }
    if (renewed || total !== null) await saveLibrary();
  }
  renderLibrary();
  await refreshLibraryStatuses(listed.map((item) => item.seriesId));
}

/**
 * Why a favorites listing (or a card's) ended without its list, said on the page and kept in the
 * job's history entry: TikTok's refusals, its login wall, a cooldown met and a refused write in
 * the engine's English (shown in the page's language), the rest in the page's own words. Returns
 * the job's stop — TikTok refused (HTTP 429 or 403, a captcha: the cooldown is recorded already),
 * its login wall, a cooldown met before a page, a refused write: a full stop, the jobs waiting
 * behind it end without a request —, or null when the list just could not be read (no address
 * seen, the tab gone, TikTok's own error, no list in the answer).
 * @param {unknown} error
 * @param {Record<string, unknown>} entry
 * @returns {string | null}
 */
function favoritesFailed(error, entry) {
  if (error instanceof FavoritesError && error.kind !== "cooldown") {
    const text = favoritesErrorText(error);
    setStatus($("input-status"), text, "error");
    entry["error"] = text;
    return null;
  }
  const stored = error instanceof FavoritesError ? error.detail : error instanceof DiscoveryError ? error.message : oneLine(error);
  setStatus($("input-status"), shownText(stored), "error");
  entry["error"] = stored;
  return stored;
}

/**
 * What the page says of a favorites list it could not read, in its own words.
 * @param {FavoritesError} error
 * @returns {string}
 */
function favoritesErrorText(error) {
  if (error.kind === "no-template") return t("favoritesNoTemplate");
  if (error.kind === "tab-gone") return t("favoritesTabGone");
  if (error.kind === "status") return t("favoritesStatusError", error.detail);
  if (error.detail === "0") return t("favoritesNoAnswer");
  return t("favoritesUnreadable", error.detail);
}

/**
 * A listing of TikTok tab `tabId`'s favorites takes the library's place: the library shows,
 * emptied of an earlier list's dramas and of the removals since (a new `app.favorites`: the one it
 * replaces is left as it was, for a listing that stops short of TikTok's end to put back,
 * {@link restoreKeptLibrary}); the ticks stay (another tab's list too: a card built for a ticked
 * drama shows ticked), until a complete listing that becomes the library prunes them
 * ({@link endFavorites}).
 * @param {number} tabId
 */
function startFavorites(tabId) {
  app.favorites = { tabId, items: [], total: null, complete: false, ended: null, short: false, skipped: 0, perPage: 0, loading: true, listedAt: now() };
  if (cardList?.tabId === tabId) cardList = null; // the library is that tab's list now
  library.removed.clear();
  library.shown = LIBRARY_PIECE;
  setStatus($("favorites-status"), "");
  input("favorites-select-all").checked = false;
  renderLibrary();
}

/**
 * A page of the list arrived: its dramas join the library (a drama listed already keeps its card),
 * with what DramaFetch's records say of them.
 * @param {FavoritesListing} listing
 */
function showFavoritesPage(listing) {
  const shown = app.favorites;
  if (shown === null) return;
  const before = new Set(shown.items.map((item) => item.seriesId));
  shown.items = [...listing.items];
  shown.total = listing.total;
  shown.skipped = listing.skipped;
  shown.perPage = listing.perPage;
  const added = distinctItems(listing.items)
    .map((item) => item.seriesId)
    .filter((seriesId) => !before.has(seriesId));
  renderLibrary();
  $("progress-activity").textContent = $("favorites-count").textContent ?? "";
  void refreshLibraryStatuses(added);
}

/**
 * The listing ended — at the list's end, or before it (a card's position reached, a limit, a
 * refusal, **Stop**): the count says how much the library holds. Only a listing of TikTok's whole
 * list ({@link readWhole}) that becomes the library (`prune`: {@link adoptable}) is the library's
 * whole list and prunes the ticks — a drama it does not hold is no favorite any more —; a partial
 * one may simply not have reached a ticked drama yet, and an empty one that is not kept (TikTok
 * counting dramas it did not send) says nothing of them.
 * @param {FavoritesListing | null} listing null when it ended without one (an error, a Stop)
 * @param {boolean} prune whether the listing becomes the library
 * @param {number} [listedAt] when the listing ended: now, or a card's listing kept apart since ({@link cardStart})
 */
function endFavorites(listing, prune, listedAt = now()) {
  const shown = app.favorites;
  if (shown === null) return;
  shown.loading = false;
  shown.listedAt = listedAt;
  if (listing !== null) {
    // a listing that becomes the library having read TikTok's whole list ({@link readWhole}) is its
    // whole list, though it ended at a cursor or on empty pages
    const whole = prune && readWhole(listing);
    shown.complete = listing.complete || whole;
    shown.ended = whole ? null : listing.ended;
    shown.short = cutShort(listing);
    if (whole) {
      const listed = new Set(shown.items.map((item) => item.seriesId));
      for (const seriesId of [...favoritesSelected]) if (!listed.has(seriesId)) favoritesSelected.delete(seriesId);
    }
  }
  renderLibrary();
}

/**
 * A finished listing of TikTok tab `tabId` the library is to show — a card's listing that extends
 * the library's list of that tab, or the list a card's dramas of the same title were found in
 * ({@link cardShared}, {@link takesLibraryPlace}) —; returns whether the library shows it:
 * - the library holds dramas of another TikTok profile than the tab's (its profile known, the
 *   tab's another one or unknown): the library stays exactly as it was — false (one account's list
 *   never enters another's library: {@link cardSharedElsewhere});
 * - the listing reached TikTok's end, or the library holds none, or the library is itself a partial
 *   list and the listing — read from the list's top too — holds at least as many dramas: it takes
 *   the library's place, in the list's order — cards and count line anew, the ticks kept — and
 *   becomes the library kept across sessions when it holds a drama, or is TikTok's whole list
 *   counting none ({@link adoptListing});
 * - otherwise — the library's own profile, a partial listing over a library that holds TikTok's
 *   whole list, or one smaller than a partial library (a right-click's: two dramas of a title, one
 *   of them not in the library) — it is joined into the library, which never shrinks
 *   ({@link joinListing}): a library that holds TikTok's whole list is never replaced by part of
 *   one.
 * The listing is the library's as read at `listedAt` — now, or when a card's listing kept apart
 * was read ({@link cardStart}): its count and, when it reached TikTok's end, its episode counts
 * date from then.
 * @param {number} tabId
 * @param {FavoritesListing} listing
 * @param {string | null} profile whose favorites the listing read ({@link FavoritesAddress})
 * @param {number} [listedAt] when it was read (seconds since the epoch)
 * @returns {Promise<boolean>}
 */
async function showFavoritesListing(tabId, listing, profile, listedAt = now()) {
  const held = libraryItems().length;
  if (held > 0 && library.profile !== null && profile !== library.profile) return false;
  if (readWhole(listing) || held === 0 || (app.favorites?.complete !== true && distinctItems(listing.items).length >= held)) {
    const adopt = listing.items.length > 0 || (listing.complete && listing.total === 0);
    startFavorites(tabId);
    showFavoritesPage(listing);
    endFavorites(listing, adopt, listedAt);
    if (listing.pages > 0 && adopt) await adoptListing(profile, listedAt);
    return true;
  }
  await joinListing(listing, listedAt);
  return true;
}

/**
 * A right-click's partial listing of the library's own profile, smaller than the library, joined
 * into it — the library never shrinks: the listing's dramas the library lacks go on top, in the
 * listing's order (TikTok lists the newest favorite first: a drama the library lacks was favorited
 * after the library was read); every drama the listing read takes its fresh entry (title, episodes,
 * cover); one DramaFetch removed that the listing holds (bookmarked again since) is no longer
 * marked removed; TikTok's count is the listing's, read now. The library is kept (its covers in the
 * browser session's memory), drawn again, and what the records say of the dramas the listing read
 * is read again. The tab whose list it is, whether its end was reached and when its whole list was
 * read stay as they were: a join is no list read from its top.
 * @param {FavoritesListing} listing
 * @param {number} [listedAt] when it was read (seconds since the epoch): TikTok's count dates from then
 * @returns {Promise<void>}
 */
async function joinListing(listing, listedAt = now()) {
  const shown = app.favorites;
  if (shown === null) return;
  const read = distinctItems(listing.items);
  const fresh = new Map(read.map((item) => [item.seriesId, item]));
  const held = new Set(shown.items.map((item) => item.seriesId));
  shown.items = [...read.filter((item) => !held.has(item.seriesId)), ...shown.items.map((item) => fresh.get(item.seriesId) ?? item)];
  for (const item of read) library.removed.delete(item.seriesId);
  if (listing.total !== null) {
    shown.total = listing.total;
    library.countedAt = listedAt;
    library.unconfirmed = false;
  }
  await writeLibraryCovers(coversOf(libraryItems()));
  await saveLibrary();
  renderLibrary();
  await refreshLibraryStatuses(read.map((item) => item.seriesId));
}

/**
 * A card's listing that does not fill the library — and a smart refresh's first page that found it
 * unchanged — says how far it read on the progress card only: the library stays as it was.
 * @param {FavoritesListing} listing
 */
function showListingProgress(listing) {
  const listed = new Set(listing.items.map((item) => item.seriesId)).size;
  $("progress-activity").textContent =
    listing.total !== null ? t("favoritesLoading", [listed, listing.total]) : t("favoritesLoadingCount", [listed]);
}

/**
 * The library's covers: series id → the cover URL its listing gave (signed: memory and
 * `chrome.storage.session` only).
 * @param {readonly FavoriteItem[]} items
 * @returns {Map<string, string>}
 */
function coversOf(items) {
  /** @type {Map<string, string>} */
  const covers = new Map();
  for (const item of items) if (item.coverUrl !== null) covers.set(item.seriesId, item.coverUrl);
  return covers;
}

/**
 * The library becomes the list a listing filled it with: its profile — whose favorites the
 * listing's address reads ({@link FavoritesAddress}), never the page its tab shows by then —,
 * TikTok's count as read (confirmed), every drama's episode count as read when the listing reached
 * the list's end (`fullReadAt`; a partial list has none) — read now, or when a card's listing kept
 * apart was read (`listedAt`) —, the covers kept in the browser session's memory, the library kept
 * on disk without them (best effort).
 * @param {string | null} profile
 * @param {number} [listedAt] when the listing was read (seconds since the epoch)
 * @returns {Promise<void>}
 */
async function adoptListing(profile, listedAt = now()) {
  library.profile = profile;
  library.countedAt = listedAt;
  library.fullReadAt = app.favorites?.complete === true ? listedAt : null;
  library.unconfirmed = false;
  await writeLibraryCovers(coversOf(libraryItems()));
  await saveLibrary();
  renderLibrary();
}

/**
 * The smart refresh's first page found the library unchanged (`lib/library.unchangedSince`): it is
 * TikTok's list as it is — the dramas DramaFetch removed leave it, the first page's own entries
 * (title, episodes, cover) take their place, TikTok's count is the library's, read now from TikTok
 * tab `tabId` (whose list it now is), and the library is kept. When the whole list was last read
 * (`fullReadAt`) stays as it was: the other dramas' episode counts are that read's.
 * @param {number} tabId
 * @param {FavoritesListing} listing the first page
 * @returns {Promise<void>}
 */
async function keepLibrary(tabId, listing) {
  const shown = app.favorites;
  if (shown === null) return;
  const fresh = new Map(listing.items.map((item) => [item.seriesId, item]));
  shown.items = shown.items.filter((item) => !library.removed.has(item.seriesId)).map((item) => fresh.get(item.seriesId) ?? item);
  shown.tabId = tabId;
  if (cardList?.tabId === tabId) cardList = null; // the library is that tab's list now
  shown.total = listing.total;
  shown.complete = true;
  shown.ended = null;
  shown.short = false;
  shown.loading = false;
  shown.perPage = Math.max(shown.perPage, listing.perPage);
  shown.listedAt = now();
  library.removed.clear();
  library.countedAt = now();
  library.unconfirmed = false;
  const listed = new Set(shown.items.map((item) => item.seriesId));
  for (const seriesId of [...favoritesSelected]) if (!listed.has(seriesId)) favoritesSelected.delete(seriesId);
  await writeLibraryCovers(coversOf(libraryItems()));
  await saveLibrary();
  renderLibrary();
  void refreshLibraryStatuses(listing.items.map((item) => item.seriesId));
}

/**
 * Keep the library in `chrome.storage.local` (`lib/library.libraryRecord`: no cover URL, nothing
 * signed). A cache, best effort: a refused write never stops anything and never counts as this
 * page's refused write (`app.unsaved`) — the library's status line says so, once.
 * @returns {Promise<void>}
 */
async function saveLibrary() {
  const shown = app.favorites;
  if (shown === null) return;
  library.changedAt = now(); // what the library learned, kept at once: a card's listing kept apart from before never enters it
  const record = libraryRecord({
    listedAt: shown.listedAt,
    total: shown.total,
    countedAt: library.countedAt,
    fullReadAt: library.fullReadAt,
    unconfirmed: library.unconfirmed,
    complete: shown.complete,
    short: shown.short,
    ended: shown.ended,
    profile: library.profile,
    items: shown.items,
    removed: library.removed,
  });
  try {
    await writeLibrary(record);
  } catch (error) {
    if (library.saveRefusedSaid) return;
    library.saveRefusedSaid = true;
    setStatus($("favorites-status"), t("librarySaveRefused", [oneLine(error)]), "error");
  }
}

/**
 * The library kept across sessions, shown at once with no request: `app.favorites` restored from it
 * with no tab (a card's resolution never trusts a restored list: it reads the list again), the
 * covers from the browser session's memory — only those whose signature has not expired
 * (`lib/library.coverExpired`: an expired one would be refused; its card shows the title) —, then
 * one read of the stored progress for the statuses.
 * @returns {Promise<void>}
 */
async function restoreLibrary() {
  const stored = await readLibrary();
  if (stored === null) {
    renderLibrary();
    return;
  }
  const covers = await readLibraryCovers();
  app.favorites = {
    tabId: null,
    items: stored.items.map((item) => ({ ...item, coverUrl: liveCover(covers.get(item.seriesId) ?? null) })),
    total: stored.total,
    complete: stored.complete,
    ended: stored.ended,
    short: stored.short,
    skipped: 0,
    perPage: 0,
    loading: false,
    listedAt: stored.listedAt,
  };
  library.profile = stored.profile;
  library.countedAt = stored.countedAt;
  library.fullReadAt = stored.fullReadAt;
  library.unconfirmed = stored.unconfirmed;
  library.removed = new Map(stored.removed.map((removal) => [removal.seriesId, removal.at]));
  renderLibrary();
  await refreshLibraryStatuses(stored.items.map((item) => item.seriesId));
}

/**
 * A cover address the library may still ask for: null when there is none or its signature has
 * expired (`lib/library.coverExpired`) — never requested, the card shows its title.
 * @param {string | null} url
 * @returns {string | null}
 */
function liveCover(url) {
  return url === null || coverExpired(url, now()) ? null : url;
}

/**
 * What DramaFetch's own records say of these dramas (`lib/library.progressOf`): one read of the
 * stored progress, no request; the library drawn again. A read the storage refuses changes nothing.
 * @param {readonly string[]} seriesIds
 * @returns {Promise<void>}
 */
async function refreshLibraryStatuses(seriesIds) {
  if (seriesIds.length === 0 || app.favorites === null) return;
  let states;
  try {
    states = await readSeriesStates(seriesIds);
  } catch {
    return;
  }
  const byId = new Map(libraryItems().map((item) => [item.seriesId, item]));
  for (const seriesId of seriesIds) {
    const item = byId.get(seriesId);
    if (item !== undefined) library.progress.set(seriesId, progressOf(states.get(seriesId), seriesId, item.episodes));
  }
  renderLibrary();
}

/** @returns {LibraryEntry[]} the library's dramas with what the records say and whether DramaFetch removed them */
function libraryEntries() {
  return libraryItems().map((item) => ({
    item,
    progress: library.progress.get(item.seriesId) ?? { status: /** @type {const} */ ("none"), saved: 0, total: item.episodes },
    removed: library.removed.has(item.seriesId),
  }));
}

/**
 * The series a waiting `batch` or `selection` job will download, and those of the running one it
 * has not reached yet: their cards say **Queued**.
 * @returns {Set<string>}
 */
function queuedSeries() {
  /** @type {Set<string>} */
  const queued = new Set();
  const downloads = (/** @type {Job} */ job) => job.kind === "batch" || job.kind === "selection";
  for (const job of app.queue) if (downloads(job)) for (const ref of job.refs) queued.add(ref.seriesId);
  if (app.running !== null && downloads(app.running)) {
    for (const ref of app.running.refs) if (ref.seriesId !== library.running && !library.finished.has(ref.seriesId)) queued.add(ref.seriesId);
  }
  return queued;
}

/** @returns {LibrarySort} the sort order chosen (the list's own when none) */
function librarySort() {
  const value = select("library-sort").value;
  return /** @type {readonly string[]} */ (LIBRARY_SORTS).includes(value) ? /** @type {LibrarySort} */ (value) : "recent";
}

/**
 * Draw the library: the section (or the line saying how to fill it), the connection and count
 * lines, the filters' counts, the removed line, the first matching dramas as cards (pieces of
 * `LIBRARY_PIECE`: 946 dramas never build 946 cards), their covers watched, the selection bar.
 */
function renderLibrary() {
  const shown = app.favorites;
  $("favorites-card").hidden = shown === null;
  $("library-empty").hidden = shown !== null;
  renderFavoritesCount();
  renderConnection();
  libraryCards.clear();
  if (shown === null) {
    $("favorites-grid").replaceChildren();
    updateFavoritesSelection();
    return;
  }
  const entries = libraryEntries();
  const counts = chipCounts(entries);
  /** @type {[LibraryFilter, string, number][]} */
  const chips = [
    ["all", "libraryChipAll", counts.all],
    ["none", "libraryChipNone", counts.none],
    ["partly", "libraryChipPartly", counts.partly],
    ["on-disk", "libraryChipOnDisk", counts.onDisk],
  ];
  for (const [filter, key, count] of chips) {
    const chip = button(`library-chip-${filter}`);
    chip.textContent = t(key, [count]);
    chip.setAttribute("aria-pressed", String(library.filter === filter));
    chip.className = library.filter === filter ? "chip pressed" : "chip";
  }
  const removedLine = $("library-removed");
  removedLine.hidden = counts.removed === 0;
  removedLine.textContent = counts.removed === 0 ? "" : t("libraryRemovedLine", [counts.removed]);
  const search = input("favorites-filter").value;
  const matching = sortedItems(entries, librarySort()).filter((entry) => inFilter(library.filter, entry) && titleMatches(entry.item.title, search));
  const drawn = matching.slice(0, library.shown);
  const twins = twinIds(entries.map((entry) => entry.item));
  const queued = queuedSeries();
  libraryCovers.show(entries.map((entry) => ({ itemId: entry.item.seriesId, coverUrl: liveCover(entry.item.coverUrl) }))); // an expired signature: no request
  const cards = drawn.map((entry) => {
    const seriesId = entry.item.seriesId;
    const status = libraryStatus(entry.progress, { queued: queued.has(seriesId), running: library.running === seriesId, removed: entry.removed });
    return libraryCard(entry, status, twins.has(seriesId));
  });
  $("favorites-grid").replaceChildren(...cards);
  for (const [seriesId, card] of libraryCards) if (libraryCovers.urlOf(seriesId) === null) libraryCovers.watch(card.cover, seriesId);
  $("library-shown").textContent = t("libraryShown", [drawn.length, matching.length]);
  const more = button("library-more");
  const left = matching.length - drawn.length;
  more.hidden = left <= 0;
  more.textContent = left > 0 ? t("libraryMore", [Math.min(LIBRARY_PIECE, left)]) : "";
  updateFavoritesSelection();
}

/**
 * One drama's card: its cover (or a plain placeholder with the title), its tick (none once it left
 * the Bookmark), its title, episodes and length, its status from the records and the jobs, the
 * twins' badge, a thin progress bar while it is partly saved or downloading, and its actions.
 * @param {LibraryEntry} entry
 * @param {LibraryStatus} status
 * @param {boolean} twin another different drama of the library bears its title
 * @returns {HTMLElement}
 */
function libraryCard(entry, status, twin) {
  const { item, progress } = entry;
  const seriesId = item.seriesId;
  const title = item.title ?? seriesId;
  const cover = el("div", { className: "drama-cover" });
  const loaded = libraryCovers.urlOf(seriesId);
  cover.append(loaded !== null ? el("img", { className: "drama-img", attrs: { src: loaded, alt: "" } }) : el("span", { className: "drama-placeholder", text: title }));
  /** @type {HTMLInputElement | null} */
  let box = null;
  if (status !== "removed") {
    const tick = /** @type {HTMLInputElement} */ (el("input", { attrs: { type: "checkbox", "data-series-id": seriesId, "aria-label": t("libraryChooseLabel", [title]) } }));
    tick.checked = favoritesSelected.has(seriesId);
    tick.addEventListener("change", () => {
      if (tick.checked) favoritesSelected.add(seriesId);
      else favoritesSelected.delete(seriesId);
      updateFavoritesSelection();
    });
    cover.append(el("label", { className: "pick" }, [tick, el("span", { text: t("libraryChoose") })]));
    box = tick;
  }
  const badges = el("p", { className: "drama-badges" }, [
    el("span", { className: `badge favorite-status ${status}`, text: libraryStatusText(status, progress), attrs: { "data-status": status } }),
  ]);
  if (twin) badges.append(el("span", { className: "badge twin", text: t("libraryTwin"), attrs: { "data-twin": "1" } }));
  const body = el("div", { className: "drama-body" }, [
    el("h3", { className: "favorite-title", text: title }),
    el("p", { className: "favorite-meta", text: favoriteMeta(item) }),
    badges,
  ]);
  if (status === "partly" || status === "running") {
    const total = progress.total ?? Math.max(progress.saved, 1);
    body.append(el("progress", { className: "drama-progress", attrs: { max: String(total), value: String(Math.min(progress.saved, total)), "aria-hidden": "true" } }));
  }
  /** @type {HTMLButtonElement[]} */
  const actions = [];
  const row = el("div", { className: "drama-actions" });
  /**
   * @param {string} action
   * @param {string} text
   * @param {string} className
   * @param {() => void} onClick
   * @returns {HTMLButtonElement}
   */
  const action = (action, text, className, onClick) => {
    const made = /** @type {HTMLButtonElement} */ (el("button", { className, text, attrs: { type: "button", "data-action": action } }));
    made.addEventListener("click", onClick);
    row.append(made);
    return made;
  };
  if (status === "removed") {
    row.append(el("span", { className: "meta", text: t("libraryRemovedNote") }));
  } else {
    if (status === "on-disk") actions.push(action("remove", t("libraryRemove"), "danger-outline", () => void openRemoval(item)));
    else actions.push(action("browse", t("libraryBrowse"), "link", () => listSeries({ kind: "series", seriesId, episodeHint: null, sourceUrl: seriesId })));
    action("open", t("libraryOpen"), "link", () => void openOnTikTok(seriesId));
  }
  body.append(row);
  const blocked = !app.owner || app.cooldown !== null || app.unsaved !== null;
  for (const made of actions) made.disabled = blocked;
  const article = el("article", { className: `drama-card ${status}`, attrs: { "data-series-id": seriesId, "data-status": status } }, [cover, body]);
  libraryCards.set(seriesId, { item, article, box, cover, actions });
  return article;
}

/**
 * A card's status, in the page's language: `On disk · 60/60`, `Partly · 23/44`, `Downloading ·
 * 12/30` (saved / how many it has; the saved count alone when that is unknown), `Not downloaded`,
 * `Queued`, `Removed from your Favorites`.
 * @param {LibraryStatus} status
 * @param {Progress} progress
 * @returns {string}
 */
function libraryStatusText(status, progress) {
  const fraction = progress.total === null ? String(progress.saved) : `${progress.saved}/${progress.total}`;
  if (status === "on-disk") return `${t("libraryOnDisk")} · ${fraction}`;
  if (status === "partly") return `${t("libraryPartly")} · ${fraction}`;
  if (status === "running") return `${t("libraryRunning")} · ${fraction}`;
  if (status === "queued") return t("libraryQueued");
  if (status === "removed") return t("libraryRemoved");
  return t("libraryNone");
}

/**
 * `60 episodes · 1h 19m`, as far as the list says.
 * @param {FavoriteItem} item
 * @returns {string}
 */
function favoriteMeta(item) {
  const parts = durationParts(item.durationS);
  const length =
    parts === null
      ? null
      : parts.hours > 0
        ? t("favoritesLengthHours", [parts.hours, parts.minutes])
        : t("favoritesLengthMinutes", [parts.minutes]);
  if (item.episodes === null) return length ?? "–";
  return length === null ? t("favoritesEpisodes", [item.episodes]) : t("favoritesEpisodesLength", [item.episodes, length]);
}

/** The count line: what is listed, while it loads and once it is done (the dramas DramaFetch removed left out). */
function renderFavoritesCount() {
  const shown = app.favorites;
  if (shown === null) return;
  const listed = keptCount();
  let text;
  if (shown.loading) text = shown.total !== null ? t("favoritesLoading", [listed, shown.total]) : t("favoritesLoadingCount", [listed]);
  else if (shown.complete || shown.total === null || listed >= shown.total) text = t("favoritesListed", [listed]);
  else text = t("favoritesListedOf", [listed, shown.total]);
  if (!shown.loading && shown.ended === "cap") text += ` ${t("favoritesCapped", [FAVORITES_MAX_PAGES])}`;
  if (!shown.loading && shown.short) text += ` ${t("favoritesCutShortNote")}`;
  if (shown.skipped > 0) text += ` ${t("favoritesSkipped", [shown.skipped])}`;
  $("favorites-count").textContent = text;
}

/**
 * The connection line — `Read from your TikTok tab (@handle) · 2 min ago · TikTok counts 946
 * dramas` (the count of the last read; not confirmed after a removal made with no TikTok tab to
 * read it from) —, the line saying the library holds another number than TikTok counts, and
 * **Update from TikTok** (disabled, with the hint to open the profile — the library's own, named,
 * when it knows it —, while no TikTok tab of it shows the favorites list: {@link findFavoritesTab}).
 */
function renderConnection() {
  const shown = app.favorites;
  const source = library.source;
  $("library-dot").className = source !== null ? "dot connected" : "dot";
  const hint = $("library-refresh-hint");
  hint.hidden = source !== null;
  hint.textContent = library.profile !== null ? t("libraryRefreshHintProfile", [library.profile]) : t("libraryRefreshHint");
  if (shown === null) return;
  library.drawnAt = now();
  $("library-source").textContent = library.profile !== null ? t("libraryReadFromProfile", [library.profile]) : t("libraryReadFrom");
  const age = ageOf(now(), Math.max(shown.listedAt, library.countedAt ?? 0));
  $("library-age").textContent =
    age.unit === "now"
      ? t("libraryAgeNow")
      : age.unit === "minutes"
        ? t("libraryAgeMinutes", [age.count])
        : age.unit === "hours"
          ? t("libraryAgeHours", [age.count])
          : t("libraryAgeDays", [age.count]);
  $("library-total").textContent =
    shown.total === null ? t("libraryTotalUnknown") : library.unconfirmed ? t("libraryTotalUnconfirmed", [shown.total]) : t("libraryTotal", [shown.total]);
  const kept = keptCount();
  const stale = $("library-stale");
  stale.hidden = shown.loading || shown.total === null || kept === shown.total;
  stale.textContent = stale.hidden ? "" : t("libraryStale", [kept]);
}

/**
 * The TikTok tab **Update from TikTok** reads the library from: a tab on a profile page (`/@…`)
 * whose favorites address the worker kept, the one whose list it saw last, with the `@handle` whose
 * list that address reads (recorded with it: {@link FavoritesAddress}). When the library knows its
 * profile, only an address of that profile: another account's list is never this library's source —
 * null while none is open, so the button is disabled and its hint names the profile
 * ({@link renderConnection}). Null when none is open. Reads the tabs' addresses and the session
 * storage only: no request.
 * @returns {Promise<{tabId: number, url: string, profile: string | null} | null>}
 */
async function findFavoritesTab() {
  /** @type {chrome.tabs.Tab[]} */
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return null;
  }
  /** @type {{tabId: number, url: string, profile: string | null, at: number} | null} */
  let best = null;
  for (const tab of tabs) {
    const page = tab.url || tab.pendingUrl || "";
    if (tab.id === undefined || !isProfilePageUrl(page, baseUrl())) continue;
    const template = await readFavoritesTemplate(tab.id).catch(() => null);
    if (template === null) continue;
    // whose list that address reads — recorded with it, never the page the tab shows now —: another account's is never this library's
    if (library.profile !== null && template.profile !== library.profile) continue;
    if (best === null || template.at > best.at) best = { tabId: tab.id, url: template.url, profile: template.profile, at: template.at };
  }
  return best === null ? null : { tabId: best.tabId, url: best.url, profile: best.profile };
}

/** Look again for a TikTok tab with the favorites list — of the library's own profile when it knows it (**Update from TikTok**'s source). */
async function updateLibrarySource() {
  library.lookedAt = now();
  library.source = await findFavoritesTab();
  renderConnection();
  updateButtons();
}

/** **Update from TikTok**: the smart refresh of the library from the TikTok tab that shows the list (the popup's hand-over). */
async function onLibraryRefresh() {
  await updateLibrarySource();
  const source = library.source;
  if (source === null) return;
  favoritesFromOutside({ tabId: source.tabId, card: null, menu: false, script: true });
}

/** The search box: only the dramas whose title holds its text are shown (letter case aside). */
function applyFavoritesFilter() {
  library.shown = LIBRARY_PIECE;
  input("favorites-select-all").checked = false;
  renderLibrary();
}

/**
 * A status filter (a chip): only the dramas of that status, `all` with the removed ones.
 * @param {LibraryFilter} filter
 */
function setLibraryFilter(filter) {
  library.filter = filter;
  applyFavoritesFilter();
}

/** **Select all shown**: ticks (or unticks) every card the grid shows, and only those. */
function onFavoritesSelectShown() {
  const checked = input("favorites-select-all").checked;
  for (const [seriesId, { box }] of libraryCards) {
    if (box === null) continue;
    box.checked = checked;
    if (checked) favoritesSelected.add(seriesId);
    else favoritesSelected.delete(seriesId);
  }
  updateFavoritesSelection();
}

/**
 * The ticked dramas the library holds, still in the Bookmark, in the order the library shows them
 * (its sort; the list's own by default).
 * @returns {FavoriteItem[]}
 */
function selectedItems() {
  const entries = libraryEntries().filter((entry) => !entry.removed && favoritesSelected.has(entry.item.seriesId));
  return sortedItems(entries, librarySort()).map((entry) => entry.item);
}

/** The selection bar: `K selected · E episodes`, and the buttons that need a tick. */
function updateFavoritesSelection() {
  const items = selectedItems();
  const episodes = selectionEpisodes(items, new Set(items.map((item) => item.seriesId)));
  $("favorites-selection").textContent = t("librarySelection", [items.length, episodes]);
  button("favorites-add-button").disabled = items.length === 0;
  button("library-clear").disabled = items.length === 0;
  updateButtons();
}

/** **Clear selection**: no drama ticked. */
function onLibraryClear() {
  favoritesSelected.clear();
  input("favorites-select-all").checked = false;
  renderLibrary();
}

/**
 * **Add selected to the box**: every ticked drama the box does not name yet joins it — a `#
 * <title>` comment line above its series id — and the page says how many, and that **Download
 * all** downloads them. Nothing is downloaded from the library itself, nothing asked of TikTok.
 */
function onFavoritesAdd() {
  const items = selectedItems();
  if (items.length === 0) return;
  const added = joinBox(items);
  if (added > 0) setStatus($("favorites-status"), t("favoritesAdded", [added]), "ok");
  else setStatus($("favorites-status"), t("favoritesNoneAdded"));
}

/**
 * **Download selected**: ONE `batch` job over exactly the ticked dramas' series ids, in the order
 * the library shows them — what **Download all** does with those ids in the box (the same refs,
 * label, `includeLocked` false, `recheck` false), through `enqueue`, so the job gate, the cooldown
 * and a refused write behave as for **Download all**. The box is not touched; the queued dramas'
 * ticks are cleared and their cards say **Queued** — theirs only: pressed while a listing refills
 * the library (**Update from TikTok**, the popup's **Open my library**), it queues the ticked
 * dramas read so far, what the selection bar counts, and a tick on one the listing has not read
 * back yet stays, its card ticked again once read, or once the library comes back as it was
 * ({@link restoreKeptLibrary}), for the next press. Nothing for an empty selection.
 */
function onLibraryDownload() {
  const items = selectedItems();
  if (items.length === 0 || !app.owner) return;
  if (app.unsaved !== null) {
    void showStorageRefused(); // as Download all: nothing queued
    return;
  }
  const parsed = parseSeriesList(items.map((item) => item.seriesId).join("\n"));
  if (parsed.refs.length === 0) return;
  const label = parsed.refs.length === 1 ? t("jobSeries", /** @type {SeriesRef} */ (parsed.refs[0]).seriesId) : t("jobBatch", [parsed.refs.length]);
  enqueue({ kind: "batch", label, refs: parsed.refs, series: null, numbers: [], includeLocked: false, recheck: false });
  for (const ref of parsed.refs) favoritesSelected.delete(ref.seriesId); // the queued ones only: a tick a listing has not read back yet stays
  input("favorites-select-all").checked = false;
  setStatus($("favorites-status"), t("libraryQueuedJob", [parsed.refs.length]), "ok");
  renderLibrary();
}

/**
 * **Open on TikTok**: the drama's first episode in a normal tab of this Chrome, in front — nothing
 * else (the user removes it from the Bookmark there by hand, or watches it).
 * @param {string} seriesId
 * @returns {Promise<void>}
 */
async function openOnTikTok(seriesId) {
  try {
    await chrome.tabs.create({ url: seriesPageUrl(seriesId, 1, baseUrl()), active: true });
  } catch {
    // no tab could be opened: nothing else happens
  }
}

/**
 * `items` join the box below what it holds — a `# <title>` comment line above each series id the
 * box does not name yet (`lib/favorites.boxWithFavorites`); how many joined.
 * @param {readonly FavoriteItem[]} items
 * @returns {number}
 */
function joinBox(items) {
  const box = textarea("links");
  const { text, added } = boxWithFavorites(box.value, items);
  box.value = text;
  return added.length;
}

/** The library section in view (the popup's **Open my library**, a card's shared title). */
function showLibrarySection() {
  const section = $("library");
  if (typeof section.scrollIntoView === "function") section.scrollIntoView({ block: "start" });
}

/**
 * A thumbnail of the library arrived: into its card (in place of the placeholder), when the grid
 * still shows that drama.
 * @param {string} seriesId
 * @param {string} url
 */
function showLibraryCover(seriesId, url) {
  const card = libraryCards.get(seriesId);
  if (card === undefined || card.cover.querySelector("img") !== null) return;
  const placeholder = card.cover.querySelector(".drama-placeholder");
  const image = el("img", { className: "drama-img", attrs: { src: url, alt: "" } });
  if (placeholder !== null) placeholder.replaceWith(image);
  else card.cover.prepend(image);
}

/**
 * The page's one lane for thumbnail requests: the episode list's ({@link covers}) and the
 * library's ({@link libraryCovers}) share it, so that the page never has two in flight at once —
 * a job's end resumes both loaders together.
 */
const coverLane = new CoverLane();

/**
 * The library's covers: the extension's own requests, as the episode list's thumbnails — only the
 * cards in view, one at a time (in the page's one lane, {@link coverLane}), a pause before each,
 * never during a job or a cooldown, nor after a refused write ({@link coversAllowed}), and never
 * one whose signed address has expired ({@link liveCover}, asked again right before the request: a
 * fresh address a later listing brings for that drama still loads); kept by series id for the
 * page's life.
 */
const libraryCovers = new CoverLoader({
  hostPatterns: chrome.runtime.getManifest().host_permissions ?? [],
  allowed: coversAllowed,
  pause: () => sleepSeconds(pagePause(defaultRng, app.testMode ? (app.testSettings.pageDelayS ?? PAGE_DELAY_S) : PAGE_DELAY_S)),
  onCover: showLibraryCover,
  baseUrl,
  lane: coverLane,
  usable: (url) => liveCover(url) !== null, // asked right before each request: the page may outlive a signature
});

// --------------------------------------------------------- Remove from Favorites (Quitar de Bookmark)

/** @type {FavoriteItem | null} the drama the confirmation is about, while it is open */
let pendingRemoval = null;

/**
 * Whether the removal of `seriesId` is running or waiting: a second one queues nothing.
 * @param {string} seriesId
 * @returns {boolean}
 */
function removalPending(seriesId) {
  /** @param {Job} job */
  const removesIt = (job) => job.kind === "unbookmark" && job.bookmark?.seriesId === seriesId;
  return (app.running !== null && removesIt(app.running)) || app.queue.some(removesIt);
}

/**
 * **Remove from Favorites** on an on-disk card: the confirmation, with what DramaFetch's records say
 * of the drama — `S of N episodes on disk`, that DramaFetch downloaded and checked each one (only
 * when every saved episode is its own download), when it was found complete, and the cover line
 * ONLY when every saved episode's stored message says its cover was embedded
 * (`lib/library.removalFacts`) — and what will happen. One read of the stored progress, no request.
 * @param {FavoriteItem} item
 * @returns {Promise<void>}
 */
async function openRemoval(item) {
  if (!app.owner) return;
  let raw;
  try {
    raw = await readSeriesState(item.seriesId);
  } catch {
    raw = undefined;
  }
  const facts = removalFacts(raw, item.seriesId, item.episodes);
  const title = item.title ?? item.seriesId;
  $("bookmark-dialog-name").textContent = title;
  $("bookmark-dialog-meta").textContent = favoriteMeta(item);
  const loaded = libraryCovers.urlOf(item.seriesId);
  $("bookmark-dialog-cover").replaceChildren(loaded !== null ? el("img", { className: "drama-img", attrs: { src: loaded, alt: "" } }) : el("span", { className: "drama-placeholder" }));
  /** @type {HTMLElement[]} */
  const lines = [];
  /** @param {string} fact @param {string} text */
  const line = (fact, text) => lines.push(el("li", { text, attrs: { "data-fact": fact } }));
  line("saved", facts.total === null ? t("bookmarkFactSavedCount", [facts.saved]) : t("bookmarkFactSaved", [facts.saved, facts.total]));
  if (facts.verified) line("verified", t("bookmarkFactVerified"));
  if (facts.completeAt !== null) line("complete", t("bookmarkFactComplete", [new Date(facts.completeAt * 1000).toLocaleDateString()]));
  if (facts.coverEmbedded) line("cover", t("bookmarkFactCover"));
  $("bookmark-dialog-facts").replaceChildren(...lines);
  pendingRemoval = item;
  const dialog = /** @type {HTMLDialogElement} */ ($("bookmark-dialog"));
  if (!dialog.open) dialog.showModal();
}

/** **Cancel** (or Esc): nothing queued. */
function closeRemoval() {
  pendingRemoval = null;
  const dialog = /** @type {HTMLDialogElement} */ ($("bookmark-dialog"));
  if (dialog.open) dialog.close();
}

/** **Remove from Favorites** in the confirmation: the removal job queued — once per drama. */
function onConfirmRemoval() {
  const item = pendingRemoval;
  closeRemoval();
  if (item === null || !app.owner) return;
  const title = item.title ?? item.seriesId;
  if (removalPending(item.seriesId)) {
    setStatus($("favorites-status"), t("bookmarkAlreadyQueued", [title]), "error");
    return;
  }
  enqueue({
    kind: "unbookmark",
    label: t("jobUnbookmark", [title]),
    refs: [{ kind: "series", seriesId: item.seriesId, episodeHint: null, sourceUrl: item.seriesId }],
    series: null,
    numbers: [],
    includeLocked: false,
    recheck: false,
    bookmark: { seriesId: item.seriesId, title: item.title, episodes: item.episodes },
  });
}

/**
 * The page's words for why a removal removed nothing, by the error's kind.
 * @type {Readonly<Record<import("./bookmark.js").BookmarkErrorKind, string>>}
 */
const BOOKMARK_TEXT_KEYS = Object.freeze({
  "not-on-disk": "bookmarkNotOnDisk",
  stale: "bookmarkStale",
  "no-count": "bookmarkNoCount",
  gone: "bookmarkGone",
  "bookmark-missing": "bookmarkMissing",
  "tab-gone": "bookmarkTabGone",
  "not-confirmed": "bookmarkNotConfirmed",
  "not-kept": "bookmarkNotKept",
  unknown: "bookmarkUnknown",
});

/**
 * A removal that removed nothing: the drama stays in the library as it was, the reason in the
 * library's status line in the page's language and in the history in the engine's English. Returns
 * the job's stop — TikTok refused (HTTP 429 or 403, a captcha: the cooldown is recorded), its login
 * wall, a cooldown met before a step, and TikTok not confirming or not keeping the change (no
 * second click on anything after TikTok ignored one: the jobs waiting behind end without a
 * request) —, or null (nothing was pressed: the records, an episode count older than 24 h, no
 * button, the tab closed).
 * @param {unknown} error
 * @param {string} title
 * @param {Record<string, unknown>} record the history entry's `bookmark`
 * @param {Record<string, unknown>} entry
 * @returns {string | null}
 */
function bookmarkFailed(error, title, record, entry) {
  if (error instanceof BookmarkError) {
    record["outcome"] = error.message;
    entry["error"] = error.message;
    setStatus($("favorites-status"), t(BOOKMARK_TEXT_KEYS[error.kind], [title]), "error");
    return error.kind === "not-confirmed" || error.kind === "not-kept" ? error.message : null;
  }
  const stored = error instanceof BookmarkCooldown || error instanceof DiscoveryError ? error.message : oneLine(error);
  record["outcome"] = stored;
  entry["error"] = stored;
  setStatus($("favorites-status"), shownText(stored), "error");
  return stored;
}

/**
 * **Remove from Favorites** — the `unbookmark` job (`bookmark.removeFromBookmark`): the gate first,
 * over the drama as the library holds it when the job runs — a listing queued before it may have
 * read another episode count since the confirmation; a drama the library no longer holds or marks
 * removed is `gone`, nothing asked —: DramaFetch's records say every episode is on disk (else
 * nothing is asked of TikTok) against an episode count read from TikTok less than 24 h ago (the
 * library's whole list, when it held a count for the drama, or a run that found the series
 * complete: else `stale`, or `no-count` for a drama TikTok's list gives no count for — nothing asked
 * either), the cooldown, the rest between jobs, the
 * cooldown again, a write that can be stored (asked again after the job's contact is noted) — then TikTok's own Bookmark
 * pressed once in a background tab and checked after a reload. Removed: the library marks the drama
 * removed at once — its card says so, the filters' counts follow — and is kept; then TikTok's count
 * ({@link countAfterRemoval}). The page showing the button off before anything was pressed
 * (`already`) changes nothing — no proof that TikTok's list lost the drama (a page may draw the
 * button before it knows): the status line says so and points to Update from TikTok, which reads
 * what TikTok lists. Every error leaves the drama as it was too.
 * The history entry carries `bookmark`: the drama's id and title and the outcome (`removed`,
 * `already`, or the reason in the engine's English) — never a URL. **Stop** after the click leaves
 * the outcome unknown, and the history says to check on TikTok. Returns the job's stop, or null.
 * (Exported for the unit tests, which cannot run a job.)
 * @param {Job} job
 * @param {Engine} engine
 * @param {Record<string, unknown>} entry
 * @returns {Promise<string | null>}
 */
export async function runUnbookmark(job, engine, entry) {
  const target = /** @type {NonNullable<Job["bookmark"]>} */ (job.bookmark);
  const title = target.title ?? target.seriesId;
  /** @type {Record<string, unknown>} */
  const record = { series_id: target.seriesId, title: target.title, outcome: null };
  entry["bookmark"] = record;
  let raw;
  try {
    raw = await readSeriesState(target.seriesId);
  } catch {
    raw = undefined;
  }
  // the drama as the library holds it NOW, never the count the dialog showed: a listing that ran
  // between the confirmation and this job (Update from TikTok, a card's listing joined) may have
  // read another episode count — new episodes, not on disk —; a drama the library no longer holds
  // (TikTok's whole list read without it) or marks removed is asked nothing (`gone`)
  const held = library.removed.has(target.seriesId) ? undefined : app.favorites?.items.find((item) => item.seriesId === target.seriesId);
  if (held === undefined) return bookmarkFailed(new BookmarkError("gone"), title, record, entry);
  if (progressStatus(raw, target.seriesId, held.episodes) !== "on-disk") return bookmarkFailed(new BookmarkError("not-on-disk"), title, record, entry);
  // that on disk compared the records with an episode count TikTok gave less than 24 h ago: the
  // library's whole list read since — only for a drama it holds a count for (above 0: what
  // `knownEpisodes` takes for one) —, or a run that found the series complete since — a series that
  // gained episodes changes neither TikTok's count nor its first page; without a count, only such a
  // run can vouch (`no-count`: an update cannot help)
  const completeAt = removalFacts(raw, target.seriesId, held.episodes).completeAt;
  const counted = held.episodes !== null && held.episodes > 0;
  const listed = counted && countsFresh(library.fullReadAt, now());
  if (!listed && !countsFresh(completeAt, now())) return bookmarkFailed(new BookmarkError(counted ? "stale" : "no-count"), title, record, entry);
  setStatus($("favorites-status"), t("bookmarkWorking", [title]));
  for (const rest of [false, true]) {
    const refused = await checkCooldown(engine);
    if (refused !== null) return bookmarkFailed(new BookmarkCooldown(cooldownMessage(refused, { now: now() })), title, record, entry);
    if (!rest) await restBetweenJobs(engine, { lastContactAt: app.lastContactAt, batchJob: false });
  }
  await storePacing(); // can anything be stored? asked before the first request, as the engine does
  if (app.unsaved !== null) {
    entry["error"] = app.unsaved;
    return app.unsaved;
  }
  const test = app.testMode ? app.testSettings : {};
  let pressed = false;
  /** @type {import("./bookmark.js").BookmarkOptions} */
  const options = { baseUrl: baseUrl(), onPressed: () => void (pressed = true) };
  if (app.windowId !== undefined) options.windowId = app.windowId;
  if (app.tabId !== undefined) options.appTabId = app.tabId;
  if (test.discoveryTimeoutS !== undefined) options.timeoutS = test.discoveryTimeoutS;
  if (test.bookmarkWaitS !== undefined) options.waitS = test.bookmarkWaitS;
  if (test.bookmarkPollS !== undefined) options.pollS = test.bookmarkPollS;
  if (test.pageDelayS !== undefined) options.pageDelayS = test.pageDelayS;
  await noteContact(job);
  if (app.unsaved !== null) {
    entry["error"] = app.unsaved; // that save refused: not one request
    return app.unsaved;
  }
  let outcome;
  /** @type {string | undefined} TikTok refused the drama page's own episode list after the click */
  let refused;
  try {
    ({ outcome, refused } = await removeFromBookmark(engine, target.seriesId, options));
  } catch (error) {
    if (error instanceof StopRequested) {
      if (pressed) {
        record["outcome"] = BOOKMARK_MESSAGES.unknown; // pressed, never checked: the history says to look
        setStatus($("favorites-status"), t("bookmarkUnknown", [title]), "error");
      }
      throw error;
    }
    return bookmarkFailed(error, title, record, entry);
  } finally {
    await noteContact(job);
  }
  record["outcome"] = outcome;
  if (outcome === "already") {
    // shown off before anything was pressed: nothing done here, and no proof TikTok's list lost it —
    // the library and the count stay as they were; Update from TikTok reads what TikTok lists
    setStatus($("favorites-status"), t("bookmarkAlready", [title]));
    return null;
  }
  library.removed.set(target.seriesId, now()); // the card says so at once, the counts follow
  await saveLibrary();
  renderLibrary();
  return countAfterRemovalStep(job, engine, target.seriesId, title, record, entry, refused ?? null);
}

/**
 * After a removal: TikTok's count. With a TikTok tab whose favorites
 * address the worker kept — a tab of the library's own profile, when the library knows it: another
 * account's list never counts for this one —, ONE request — that tab's first page, its address
 * replayed byte for byte (`bookmark.countAfterRemoval`: the pause, the cooldown, a refusal a stop
 * with the cooldown) —: the count becomes TikTok's new total; the drama still on that page means
 * TikTok did not keep the change after all (`not-kept`: its card back to on disk). Without such a
 * tab — or when that request brought no count: refused, a cooldown met, a write this page could not
 * store, **Stop** before it went out — the count is the last one minus one, shown as not confirmed;
 * `refused` (TikTok answered the drama page's own episode list 429 after the click, the cooldown
 * recorded) asks nothing more and is the job's stop.
 * @param {Job} job
 * @param {Engine} engine
 * @param {string} seriesId
 * @param {string} title
 * @param {Record<string, unknown>} record the history entry's `bookmark`
 * @param {Record<string, unknown>} entry
 * @param {string | null} refused
 * @returns {Promise<string | null>} the job's stop, or null
 */
async function countAfterRemovalStep(job, engine, seriesId, title, record, entry, refused) {
  const done = t("bookmarkRemoved", [title]);
  /** @param {string} [why] the reason the count could not be read, when it is the job's stop */
  const unconfirmed = async (why) => {
    const shown = app.favorites;
    if (shown !== null && shown.total !== null) shown.total = Math.max(0, shown.total - 1);
    library.unconfirmed = true;
    await saveLibrary();
    renderLibrary();
    setStatus($("favorites-status"), why === undefined ? `${done} ${t("bookmarkCountUnconfirmed")}` : `${done} ${shownText(why)}`, why === undefined ? "ok" : "error");
  };
  if (refused !== null) {
    // TikTok refused the drama page's own list meanwhile (the cooldown recorded): no request now — a stop
    entry["error"] = refused;
    await unconfirmed(refused);
    return refused;
  }
  await updateLibrarySource();
  const source = library.source;
  // the count of THIS library's profile only: another account's list (or none) counts nothing here
  if (source === null || (library.profile !== null && source.profile !== library.profile)) {
    await unconfirmed();
    return null;
  }
  const test = app.testMode ? app.testSettings : {};
  /** @type {Omit<import("./favorites.js").FavoritesOptions, "maxPages" | "until" | "onPage">} */
  const options = {};
  if (test.pageDelayS !== undefined) options.pageDelayS = test.pageDelayS;
  if (test.discoveryTimeoutS !== undefined) options.timeoutS = test.discoveryTimeoutS;
  await noteContact(job);
  if (app.unsaved !== null) {
    // a write this page could not store (during the removal, or just now): not one request more
    entry["error"] = app.unsaved;
    await unconfirmed(app.unsaved);
    return app.unsaved;
  }
  let counted;
  try {
    counted = await countAfterRemoval(engine, source.tabId, source.url, seriesId, options);
  } catch (error) {
    if (error instanceof StopRequested) {
      await unconfirmed(); // stopped before its one request went out: the last count minus one, not confirmed
      throw error;
    }
    // the removal stands (the reloaded page showed it); TikTok's count could not be read
    if (error instanceof FavoritesError && error.kind !== "cooldown") {
      await unconfirmed();
      return null;
    }
    const stored = error instanceof FavoritesError ? error.detail : error instanceof DiscoveryError ? error.message : oneLine(error);
    entry["error"] = stored;
    await unconfirmed(stored);
    return stored; // TikTok refused (the cooldown recorded), its login wall, a cooldown: a stop
  } finally {
    await noteContact(job);
  }
  const shown = app.favorites;
  if (counted.stillListed) {
    // TikTok still lists it first thing: it did not keep the change after all
    library.removed.delete(seriesId);
    if (shown !== null && counted.total !== null) shown.total = counted.total;
    library.countedAt = now();
    library.unconfirmed = false;
    await saveLibrary();
    renderLibrary();
    return bookmarkFailed(new BookmarkError("not-kept"), title, record, entry);
  }
  if (counted.total === null) {
    await unconfirmed();
    return null;
  }
  if (shown !== null) shown.total = counted.total;
  library.countedAt = now();
  library.unconfirmed = false;
  await saveLibrary();
  renderLibrary();
  setStatus($("favorites-status"), `${done} ${t("libraryTotal", [counted.total])}.`, "ok");
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
 * Whether the list's thumbnails may be requested now: in the engine's tab, while no job runs or
 * waits, no cooldown is in force and nothing was refused by `chrome.storage.local` — once a write
 * was refused, this page asks nothing of TikTok, not even a thumbnail. (Exported for the unit
 * tests.)
 * @returns {Promise<boolean>}
 */
export async function coversAllowed() {
  return app.owner && app.unsaved === null && app.running === null && app.queue.length === 0 && (await checkCooldownNow()) === null;
}

/**
 * The list's thumbnails: the extension's own requests, only for the rows in view, one at a time
 * (in the page's one lane with the library's, {@link coverLane}), never during a job or a
 * cooldown, nor after a refused write ({@link coversAllowed}).
 */
const covers = new CoverLoader({
  hostPatterns: chrome.runtime.getManifest().host_permissions ?? [],
  allowed: coversAllowed,
  pause: () => sleepSeconds(pagePause(defaultRng, app.testMode ? (app.testSettings.pageDelayS ?? PAGE_DELAY_S) : PAGE_DELAY_S)),
  onCover: showCover,
  baseUrl,
  lane: coverLane,
});

/**
 * The page's two thumbnail loaders — the episode list's and the library's —, which share one lane.
 * (Exported for the unit tests.)
 * @returns {{list: CoverLoader, library: CoverLoader}}
 */
export function coverLoaders() {
  return { list: covers, library: libraryCovers };
}

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
  const blocked = !app.owner || app.cooldown !== null || app.unsaved !== null;
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
  // the library: Download selected and Update from TikTok queue jobs; Remove from Favorites and See
  // episodes too — the same rule (Open on TikTok is a normal tab: never disabled)
  button("library-download").disabled = blocked || selectedItems().length === 0;
  button("library-refresh").disabled = blocked || library.source === null;
  for (const card of libraryCards.values()) for (const action of card.actions) action.disabled = blocked;
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

/**
 * Queue the listing of one series — **Load list**, or a series handed from outside
 * ({@link loadFromOutside}): one listing per series at a time.
 * @param {SeriesRef} ref
 */
function listSeries(ref) {
  if (loadPending(ref.seriesId)) {
    setStatus($("input-status"), t("loadAlreadyQueued"), "error");
    return;
  }
  enqueue({ kind: "load", label: t("jobLoad", ref.seriesId), refs: [ref], series: null, numbers: [], includeLocked: false, recheck: false });
}

/**
 * Whether a listing of TikTok tab `tabId`'s favorites is running or waiting: a second one queues
 * nothing.
 * @param {number} tabId
 * @returns {boolean}
 */
function favoritesPending(tabId) {
  /** @param {Job} job */
  const listsIt = (job) => job.kind === "favorites" && job.favoritesTab === tabId;
  return (app.running !== null && listsIt(app.running)) || app.queue.some(listsIt);
}

/**
 * Whether the drama of the same right-clicked card of tab `tabId` is being listed or waits to be.
 * @param {number} tabId
 * @param {Card} card
 * @returns {boolean}
 */
function cardPending(tabId, card) {
  /** @param {Job} job */
  const listsIt = (job) => job.kind === "load" && job.favoritesTab === tabId && job.card?.title === card.title && job.card.index === card.index;
  return (app.running !== null && listsIt(app.running)) || app.queue.some(listsIt);
}

/**
 * The favorites of a TikTok tab handed over (the popup's **Open my library** on that profile —
 * 1.5.0's **Choose from your favorites** —, **Update from TikTok**, the right-click **Download this
 * favorite drama** on a profile page), taken by the engine's tab only,
 * like a series ({@link loadFromOutside}): a right-click on a card lists that card's drama — one
 * **Load list** job that resolves the card first —; a right-click that names no card queues
 * nothing at all (no job, no request) and says why — the tab's content script answered that the
 * right-click was on no drama (`favoritesNoCard`), or no content script answered, the tab being
 * older than DramaFetch's load or update (`favoritesNoScript`) —; the popup's hand-over (**Open my
 * library**, **Update from TikTok**) brings the library into view and updates it from the tab's
 * favorites (**List favorites**: the smart refresh). The tab still answers, so the worker brings it
 * to the front to say it. Nothing is queued twice.
 * @param {FavoritesHandover} handover
 * @returns {boolean} whether this tab took it (the engine's tab)
 */
function favoritesFromOutside(handover) {
  if (!app.owner) return false;
  const status = $("input-status");
  const { tabId, card } = handover;
  if (card !== null) {
    if (cardPending(tabId, card)) setStatus(status, t("loadAlreadyQueued"), "error");
    else enqueue({ kind: "load", label: t("jobCard", card.title), refs: [], series: null, numbers: [], includeLocked: false, recheck: false, favoritesTab: tabId, card });
    return true;
  }
  if (handover.menu) {
    // a right-click that named no drama: nothing to list — never the whole list in its place
    if (handover.script) setStatus(status, t("favoritesNoCard"), "error");
    else setStatus(status, t("favoritesNoScript"), "error");
    return true;
  }
  showLibrarySection(); // the popup's Open my library: the library in view, updated by the job
  if (favoritesPending(tabId)) {
    setStatus(status, t("favoritesAlreadyQueued"), "error");
    return true;
  }
  setStatus(status, t("favoritesChoose"));
  enqueue({ kind: "favorites", label: t("jobFavorites"), refs: [], series: null, numbers: [], includeLocked: false, recheck: false, favoritesTab: tabId, card: null });
  return true;
}

/** **Load list**: the one series in the box. */
function onLoad() {
  const parsed = parsedLinks();
  if (parsed === null) return;
  if (parsed.refs.length !== 1) {
    setStatus($("input-status"), t("loadOneOnly"), "error");
    return;
  }
  listSeries(/** @type {SeriesRef} */ (parsed.refs[0]));
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
  if (app.cooldown === null && app.running === null) {
    covers.resume(); // the cooldown is over
    libraryCovers.resume();
  }
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
  if (now() - app.cooldownLookedAt >= COOLDOWN_LOOK_S) {
    app.cooldownLookedAt = now();
    void lookAgainAtCooldown();
  }
}

/** How often (seconds) a page with a cooldown in force looks whether the storage holds it. */
export const COOLDOWN_LOOK_S = 15;

/**
 * Store a cooldown in force that `chrome.storage.local` does not hold yet (its write was refused:
 * a full disk) as soon as the storage takes writes again, so that a restart of Chrome no longer
 * loses it — a reading does it ({@link cooldownStore}) — and drop "could not be saved" from the
 * advice on screen then. Only the storage is read: nothing is asked of TikTok. Called every
 * {@link COOLDOWN_LOOK_S} s while a cooldown is in force. (Exported for the unit tests, which
 * cannot run the page's timer.)
 * @returns {Promise<boolean>} whether the storage holds the cooldown in force
 */
export async function lookAgainAtCooldown() {
  const cooldown = app.cooldown;
  if (cooldown === null) return false;
  if ((await storedCooldownUntil()) < cooldown.until) await checkCooldownNow();
  const stored = (await storedCooldownUntil()) >= cooldown.until;
  if (stored && app.unsavedWaitShown) await showStorageRefused();
  return stored;
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
  try {
    await saveSettings({ ...DEFAULT_SETTINGS });
  } catch (error) {
    setStatus($("settings-status"), t("settingsRefused", shownText(oneLine(error))), "error");
    return;
  }
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
    // a removal from the Bookmark: what came of it (never a URL)
    const bookmark = entry["bookmark"];
    if (entry["kind"] === "unbookmark" && bookmark !== null && typeof bookmark === "object") {
      const outcome = /** @type {Record<string, unknown>} */ (bookmark)["outcome"];
      if (outcome === "removed") item.append(el("div", { text: t("historyBookmarkRemoved") }));
      else if (outcome === "already") item.append(el("div", { text: t("historyBookmarkAlready") }));
      else if (typeof outcome === "string" && outcome !== entry["error"]) item.append(el("div", { className: "meta", text: shownText(outcome) }));
    }
    // a run too large for its share of the history kept only some of its series (storage.js)
    // a favorites listing: how many dramas it listed
    if (typeof entry["favorites"] === "number") item.append(el("div", { text: t("favoritesListed", [entry["favorites"]]) }));
    const unreadable = entry["favorites_skipped"];
    if (typeof unreadable === "number" && unreadable > 0) item.append(el("div", { className: "meta", text: t("favoritesSkipped", [unreadable]) }));
    const omitted = entry["series_omitted"];
    if (typeof omitted === "number" && omitted > 0) item.append(el("div", { className: "meta", text: t("historySeriesOmitted", [omitted]) }));
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
 * A series handed from outside — the popup's **Download this series**, the right-click **Download
 * this drama** — listed in the engine's tab only: the request reaches every DramaFetch page, and
 * the engine's takes it. The link joins the box rather than replacing it, so a batch typed there
 * for **Download all** stays: on a line of its own, unless the box names that series already. A
 * link that names no series (or more than one) leaves the box as it is, and the tab says why it
 * lists nothing.
 * @param {string} link
 * @returns {boolean} whether this tab took it (the engine's tab)
 */
function loadFromOutside(link) {
  if (!app.owner) return false;
  const parsed = parseSeriesList(link);
  const status = $("input-status");
  if (parsed.errors.length > 0) {
    // about the link handed over, not about the box's first line
    setStatus(status, parsed.errors.map((error) => shownText(error.message.replace(/^line 1: /, ""))).join(" · "), "error");
    return true;
  }
  if (parsed.refs.length !== 1) {
    setStatus(status, t(parsed.refs.length === 0 ? "noLinks" : "loadOneOnly"), "error");
    return true;
  }
  const ref = /** @type {SeriesRef} */ (parsed.refs[0]);
  const box = textarea("links");
  if (!parseSeriesList(box.value).refs.some((listed) => listed.seriesId === ref.seriesId)) {
    box.value = box.value.trim() ? `${box.value.trimEnd()}\n${link}` : link;
  }
  setStatus(status, parsed.notes.map(shownText).join(" · "));
  listSeries(ref);
  return true;
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
  // the library
  input("favorites-filter").addEventListener("input", applyFavoritesFilter);
  input("favorites-select-all").addEventListener("change", onFavoritesSelectShown);
  button("favorites-add-button").addEventListener("click", onFavoritesAdd);
  for (const filter of /** @type {LibraryFilter[]} */ (["all", "none", "partly", "on-disk"])) {
    button(`library-chip-${filter}`).addEventListener("click", () => setLibraryFilter(filter));
  }
  select("library-sort").addEventListener("change", applyFavoritesFilter);
  button("library-more").addEventListener("click", () => {
    library.shown += LIBRARY_PIECE;
    renderLibrary();
  });
  button("library-clear").addEventListener("click", onLibraryClear);
  button("library-download").addEventListener("click", onLibraryDownload);
  button("library-refresh").addEventListener("click", () => void onLibraryRefresh());
  button("bookmark-cancel").addEventListener("click", closeRemoval);
  button("bookmark-confirm").addEventListener("click", onConfirmRemoval);
  $("bookmark-dialog").addEventListener("cancel", () => {
    pendingRemoval = null; // Esc: nothing queued
  });
  // the section links of the header: History and Settings open when one goes there
  for (const link of document.querySelectorAll("nav.sections a[href^='#']")) {
    link.addEventListener("click", () => {
      const target = document.getElementById((link.getAttribute("href") ?? "").slice(1));
      if (target instanceof HTMLDetailsElement) target.open = true;
    });
  }
  $("settings-form").addEventListener("submit", (event) => void onSaveSettings(/** @type {SubmitEvent} */ (event)));
  button("settings-reset").addEventListener("click", () => void onResetSettings());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.hasOwn(changes, COOLDOWN_STORAGE_KEY)) void refreshCooldown();
    // a TikTok tab showed its favorites list (or closed): Update from TikTok follows
    if (area === "session" && Object.keys(changes).some((key) => key.startsWith(FAVORITES_TEMPLATE_PREFIX))) void updateLibrarySource();
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isOwnSender(sender)) return; // only this extension's own pages and worker: never a content script
    if (message !== null && typeof message === "object") {
      const record = /** @type {Record<string, unknown>} */ (message);
      // the engine's tab takes it and answers with its tab, which the worker brings to the front;
      // a read-only tab stays silent (as does a tab that is not running: the worker then reloads
      // one with the series in its address)
      if (record["type"] === "dramafetch:load" && typeof record["input"] === "string" && loadFromOutside(record["input"])) {
        sendResponse({ ok: true, tabId: app.tabId ?? null });
      }
      // the favorites of a TikTok tab (the popup, the right-click on a profile): the same hand-over
      const handover = record["type"] === "dramafetch:favorites" ? handoverOf(record) : null;
      if (handover !== null && favoritesFromOutside(handover)) sendResponse({ ok: true, tabId: app.tabId ?? null });
      // the popup's Open my library away from a TikTok profile: the library shown, no job, no request
      if (record["type"] === "dramafetch:library" && app.owner) {
        showLibrarySection();
        sendResponse({ ok: true, tabId: app.tabId ?? null });
      }
    }
  });
  setInterval(() => {
    tickCooldown();
    if (app.pauseUntil !== null) renderPause();
    if (now() - library.drawnAt >= 30) renderConnection(); // "2 min ago" moves on
    if (now() - library.lookedAt >= 15) void updateLibrarySource(); // a TikTok profile tab opened or closed
  }, 1000);

  await refreshCooldown();
  await renderHistory();
  await restoreLibrary(); // the library kept from an earlier session, shown at once: no request
  await updateLibrarySource();
  renderAppStatus();
  const load = new URLSearchParams(location.search).get("load");
  const favorites = favoritesOfQuery(location.search); // a favorites hand-over no running page took
  const toLibrary = new URLSearchParams(location.search).get("library") === "1"; // the popup's Open my library no running page took
  if (load || favorites !== null || toLibrary) {
    history.replaceState(null, "", location.pathname);
    if (load) loadFromOutside(load);
    if (favorites !== null) favoritesFromOutside(favorites);
    if (toLibrary) showLibrarySection();
  }
}

void main();
