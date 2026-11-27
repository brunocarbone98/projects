// @ts-check
/**
 * The DramaFetch tab: the text box (one link or id per line, the CLI's `--from-file` rules) — a
 * paste into it, or Enter, queues the download of the series it names at once (DramaFetch 1.7.0,
 * the owner's decision of 2026-11-20) —, the episode list of one series (**See episodes** on a
 * drama of the library), the user's TikTok library (DramaFetch 1.6.0: their Bookmark — **Favorites**
 * → **Drama** — as cards, kept across sessions, its count TikTok's, with a search, a sort kept
 * across sessions, ticks, a **Download** button per drama and **Download selected dramas**; a card
 * says **Queued** or **Downloading · saved/total** while a job holds its drama, and nothing else:
 * DramaFetch 3.0.0 took the lasting statuses, their filters and the locked count away),
 * the jobs — one at a time, FIFO, the web job manager's rules — and their progress
 * (the episodes a job did not download shown apart from the ones that completed, with the button
 * that queues them again; a pause counted down in minutes and seconds, DramaFetch 2.0.0), the
 * Waiting card (2.0.0: each drama still to run by its name and whole ID, {@link queueRows}), the
 * cooldown banner, the settings, and (only in the test harness' copy)
 * the test settings and the journal of finished jobs the end-to-end tests read ({@link journal}).
 * DramaFetch 2.0.0 (the owner's decision of 2026-11-22) keeps no history of past runs: the one 1.x
 * stored is removed at the page's start. The engine runs here while the tab is open; one tab per
 * browser holds it (a Web Lock), a second one stays read-only.
 */

import { isLocked } from "../lib/catalog.js";
import { COOLDOWN_STORAGE_KEY, activeCooldown, clockTime, cooldownMessage, secondsLeft } from "../lib/cooldown.js";
import { buildReport, digestEntry, hasFailures, reportFilename, reportJson, reportStem, slimRows } from "../lib/diagnosis.js";
import { displayText, formatDuration, pauseLine, statusLabel } from "../lib/display.js";
import {
  FAVORITES_MAX_PAGES,
  durationParts,
  favoritesOfQuery,
  handoverOf,
  isProfilePageUrl,
  titleMatches,
} from "../lib/favorites.js";
import {
  LIBRARY_PIECE,
  ageOf,
  countsFresh,
  coverExpired,
  distinctItems,
  libraryRecord,
  librarySortOf,
  libraryStatus,
  progressOf,
  selectionEpisodes,
  sortedItems,
  twinIds,
  unchangedSince,
} from "../lib/library.js";
import { DONE, FAILED, SKIPPED_EXISTS, SKIPPED_LOCKED, STOPPED_PREFIX, TIKTOK_BASE_URL } from "../lib/messages.js";
import { displayName, fileBaseName } from "../lib/naming.js";
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
import {
  batchStatus,
  isGuessedLocked,
  isNotListed,
  listIncomplete,
  listMissing,
  listOtherItems,
  listUncertain,
  notStartedMessage,
  reportLine,
  reportToDict,
} from "../lib/report.js";
import { doneEntries, drmProtected, readState } from "../lib/state.js";
import { parseSeriesList, seriesPageUrl } from "../lib/urls.js";
import {
  PageAlerts,
  autoRetryAlert,
  dramaAlert,
  episodeLabel,
  guessedEpisodes,
  guessedHints,
  namedEpisodes,
  notRetriedAlert,
  stoppedAlert,
  stoppedRetryAlert,
} from "./alerts.js";
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
  SETTINGS_KEY,
  cooldownStore,
  isTestMode,
  loadPacing,
  loadSettings,
  loadTestSettings,
  readFavoritesTemplate,
  readLibrary,
  readLibraryCovers,
  readLibrarySort,
  readSeriesState,
  readSeriesStates,
  removeStoredHistory,
  savePacing,
  saveSettings,
  saveTestSettings,
  storedCooldownUntil,
  writeLibrary,
  writeLibraryCovers,
  writeLibrarySort,
  writeSeriesState,
} from "./storage.js";
import { TabKeeper } from "./tabkeeper.js";

/** The Web Lock that makes this tab the only engine of the browser. */
const ENGINE_LOCK = "dramafetch-engine";

/**
 * @typedef {import("../lib/catalog.js").Episode} Episode
 * @typedef {import("../lib/catalog.js").Series} Series
 * @typedef {import("../lib/urls.js").SeriesRef} SeriesRef
 * @typedef {import("../lib/urls.js").SeriesListLine} SeriesListLine
 * @typedef {import("../lib/report.js").DownloadResult} DownloadResult
 * @typedef {import("./engine.js").SeriesRun} SeriesRun
 * @typedef {import("./engine.js").Engine} Engine
 * @typedef {import("./storage.js").Settings} Settings
 * @typedef {import("./storage.js").TestSettings} TestSettings
 *
 * @typedef {import("../lib/favorites.js").FavoriteItem} FavoriteItem
 * @typedef {import("../lib/favorites.js").FavoritesHandover} FavoritesHandover
 * @typedef {import("./favorites.js").FavoritesListing} FavoritesListing
 *
 * @typedef {import("../lib/library.js").Progress} Progress
 * @typedef {import("../lib/library.js").LibraryEntry} LibraryEntry
 * @typedef {import("../lib/library.js").LibrarySort} LibrarySort
 * @typedef {import("../lib/library.js").LibraryStatus} LibraryStatus
 *
 * @typedef {object} Job
 * @property {number} id
 * @property {"load" | "batch" | "selection" | "favorites"} kind `load`: **See episodes** (a
 *   listing, {@link runLoad}); `batch`: a download of whole series — a paste, Enter, a card's
 *   **Download**, **Download selected dramas**, a hand-over; `selection`: some episodes of one
 *   series — **Download all available**, **Download selected**, a **Retry**, an automatic retry;
 *   `favorites`: **List favorites** (the library's refresh)
 * @property {string} label
 * @property {SeriesRef[]} refs the series it lists or downloads (none for `favorites`)
 * @property {Series | null} series
 * @property {number[]} numbers
 * @property {boolean} includeLocked
 * @property {boolean} recheck
 * @property {boolean} [overwrite] a `selection` job that downloads every chosen episode again in
 *   full, replacing what is on disk (DramaFetch 3.0.0, the owner's decision of 2026-11-25): the job
 *   **See episodes**' **Download all available** and **Download selected** queue
 *   ({@link startSelection}), and the retries of its failures — its automatic retry, the tab's
 *   **Retry**, its alert's **Retry** ({@link retryJobs}) —, so that an episode whose download
 *   again failed is never skipped for its old copy. Absent on every other job: a paste or Enter, a
 *   card's **Download**, **Download selected dramas** and the popup's hand-over keep what is on
 *   disk (the engine's `overwrite`, `Engine.overwrite` / `DownloaderConfig.overwrite`)
 * @property {boolean} [contacted] whether the job made a request to TikTok (set while it runs)
 * @property {number} [favoritesTab] the user's TikTok tab whose favorites a `favorites` job lists
 * @property {{count: number, skipped: number}} [listed] what a listing that filled the library
 *   listed — its dramas, and the list's items it left out for want of a readable series id —: what
 *   the job's status line and its record say, whatever became of the library
 *   ({@link fetchFavorites}: a listing that stops short of TikTok's end leaves a library that held
 *   dramas as it was)
 * @property {{alertId: string, name: string | null, guessed?: number[], hints?: string[]}} [autoRetry]
 *   a `selection` job DramaFetch queued on its own (DramaFetch 1.8.0, {@link queueAutoRetry}): the id
 *   of its drama's alert — “retrying”, then what came of it, under that one id — and the drama's name
 *   as its records had it; since 3.0.1 (the lead's D8) the drama's free episodes DramaFetch only
 *   guessed were locked (`guessed`, never asked for by it) and, for one, the lock hints its list gave
 *   (`hints`, engine texts): what its drama's alert names besides should it never run or be stopped
 *   before that alert ({@link alertNotRetried}) — absent when none. Never retried automatically
 *   again: its failures wait for the user's **Retry**.
 * @property {"available" | "selected"} [pick] which button of **See episodes** queued a `selection`
 *   job — **Download all available** or **Download selected** ({@link startSelection}) —, as its row
 *   in the Waiting card says (DramaFetch 2.0.0, {@link queueRows}); a **Retry** has none
 * @property {number[]} [missing] a retry's episodes that were not in TikTok's list when it was
 *   queued ({@link RetryTarget}.missing, 3.0.1): what its drama's alert names apart should it never
 *   run or be stopped before its alert ({@link alertNotRetried}); absent otherwise
 * @property {boolean} [askGuessed] a `selection` job a **Retry** queued for the free episodes
 *   DramaFetch only guessed were locked ({@link RetryTarget}.guessed, 3.0.1, the owner's report of
 *   2026-11-27): it asks TikTok for them anyway — one request each, the usual pace, TikTok decides
 *   (`DownloaderConfig.askGuessed`: what **Also ask for locked episodes** does, but only for the
 *   episodes its fresh list still marks guessed; one that list now shows with a price, a TikTok
 *   lock flag or DRM stays skipped as locked). Never queued by the automatic retry; absent otherwise
 *
 * @typedef {object} FavoritesShown The favorites list the library shows: read from one TikTok tab,
 *   or the library kept from an earlier session.
 * @property {FavoriteItem[]} items the list's dramas in its order (a drama listed twice: twice)
 * @property {number | null} total how many favorites TikTok counts
 * @property {boolean} complete the list's end was reached
 * @property {FavoritesListing["ended"]} ended why the listing ended before the list's end
 * @property {boolean} short TikTok stopped sending the list before its end (`favorites.cutShort`)
 * @property {number} skipped the list's items left out for want of a readable series id
 * @property {boolean} loading a listing is filling it now
 * @property {number} listedAt when the listing ended, seconds since the epoch
 *
 * @typedef {object} LibrarySnapshot The library as it was before a listing that fills it, when it
 *   held dramas ({@link fetchFavorites}): what comes back when that listing does not end as
 *   TikTok's whole list ({@link restoreKeptLibrary}).
 * @property {FavoritesShown} favorites `app.favorites` itself — the listing puts a new object in
 *   its place ({@link startFavorites}), and nothing changes this one meanwhile
 * @property {number} shown `library.shown`: how many cards the grid drew
 *
 * @typedef {object} FavoritesAddress A TikTok tab's favorites address, as the worker kept it
 *   (`storage.readFavoritesTemplate`).
 * @property {string} url the list's first page, replayed unchanged
 * @property {string | null} profile whose favorites it reads: the `@handle` of the profile page
 *   that asked for it, recorded with it — never the page the tab shows later; null when the worker
 *   could not tell
 *
 * @typedef {object} JobRecord What a job gathers while it runs, for its end: its alerts, its
 *   automatic retries, its report and — in test mode only — its {@link journal} entry.
 * @property {{kind: string, seconds: number, text: string}[]} pauses
 * @property {SeriesInput[]} inputs what the report reads of the first finished series of a batch,
 *   in the runs' order, each taken when its series was done ({@link releaseSeries})
 * @property {boolean} taking whether the next series' is still taken: false once one could not be
 *   (that run and the later ones stay whole, and the report reads them at the job's end)
 * @property {number} [begun] how many series of a batch it began — the last one whose list came
 *   (`onStart`) or that was done (`onSeriesDone`) —: those after them were never started when
 *   **Stop** ended it ({@link alertJobEnd}), the one Stop caught in the rest before it or while its
 *   list was read among them
 * @property {string[]} [autoRetried] the automatic retries it queued for its dramas (their
 *   `autoRetry.alertId`, {@link queueAutoRetry}): those still waiting at its end are what its
 *   **Did not download** block says will be retried ({@link waitingAutoRetries}, {@link renderFailed})
 * @property {number[]} [saved] an automatic retry's episodes on disk as it went — saved, or found
 *   saved already —: when **Stop** or an error ends it before its drama's alert, that alert names
 *   only the others ({@link alertNotRetried})
 * @property {Record<string, unknown>[]} [records] the per-series records ({@link runRecord}) of the
 *   dramas a batch finished, pushed as each one is done (`onSeriesDone`; 3.0.1, the lead's D11): what
 *   its **Did not download** block takes when **Stop** ends the batch before its end
 *   ({@link stoppedRecords})
 * @property {{seriesId: string, name: string | null, rows: Record<string, unknown>[]}} [current] the
 *   drama the job is in — its list came (`onStart`) — and its rows as they come (`onResult`;
 *   3.0.1, D11): a stopped selection job's record, and what a stopped batch's drama saved
 *
 * @typedef {object} JobOutcome How a job ended, as its report records it ({@link reportJobEnd}).
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
 * @property {string} status a `failed-*` status, or `skipped-locked` for a free episode DramaFetch
 *   only guessed was locked (`guessed`)
 * @property {string} message
 * @property {boolean} [overwrite] its job downloaded again in full (its record says `overwrite`)
 * @property {boolean} [guessed] a free episode DramaFetch did not ask for because its own rules
 *   guessed it was locked (3.0.1, `report.isGuessedLocked`: its record row says `guessed`)
 *
 * @typedef {object} RetryTarget What a retry queues for one series ({@link retryTargets}).
 * @property {string} seriesId
 * @property {string | null} name the series' stored name, when the job learnt it
 * @property {number[]} numbers the episodes that did not download, ascending, de-duplicated
 * @property {boolean} [overwrite] the failures of a job that downloads again in full (a
 *   {@link Job}.overwrite job): its retry does too (DramaFetch 3.0.0) — absent otherwise
 * @property {number[]} [missing] those of `numbers` that were not in TikTok's list (3.0.1: their
 *   rows say `not in TikTok's list…`, `report.isNotListed`), ascending — the alerts name them apart;
 *   absent when none
 * @property {number[]} [guessed] those of `numbers` that are free episodes DramaFetch only guessed
 *   were locked (3.0.1, {@link FailedRow}.guessed), ascending: their retry is a `selection` job of
 *   their own that asks for them anyway ({@link Job}.askGuessed, {@link retryJobs}); the alerts
 *   name them apart; absent when none
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
  /**
   * The episodes of the list on screen that an earlier download found encrypted (a remembered DRM
   * verdict), as {@link renderSeries} drew them: shown locked, and left out of what **Download all
   * available** takes ({@link availableNumbers}).
   * @type {{seriesId: string, numbers: Set<number>}}
   */
  listedDrm: { seriesId: "", numbers: new Set() },
  /** @type {FavoritesShown | null} the favorites the panel shows (**Your favorite dramas**) */
  favorites: null,
  /** @type {RetryTarget[] | null} the episodes of the Did not download block — every job's since 3.0.1 — that its Retry queues */
  failed: null,
  /**
   * The **Did not download** block's rows, every job's for the tab's life (3.0.1, the owner's report
   * of 2026-11-27): by drama, in the order the dramas first came, each drama's by episode number. A
   * job's end replaces only the rows of the episodes it took ({@link renderFailed}); reloading the
   * tab clears them.
   * @type {Map<string, {name: string | null, rows: Map<number, FailedRow>}>}
   */
  failedRows: new Map(),
  /**
   * The automatic retries the last finished job queued that still waited at its end (their
   * `autoRetry.alertId`): when one of them is the next job, that job's **Did not download** block
   * stays on screen while it runs — its line says they are retried — until its own end
   * ({@link startProgress}, {@link renderFailed}).
   * @type {Set<string>}
   */
  failedAuto: new Set(),
  /** @type {{report: Record<string, unknown>, stem: string} | null} the last finished job's "did not download" report (**Save the report**) */
  lastReport: null,
  /** @type {Job[]} */
  queue: [],
  /** @type {Job | null} */
  running: null,
  /**
   * The running job is done with its drama (DramaFetch 1.8.0): a `selection` job once its drama's
   * alert was made ({@link dramaDone}) or its end began — it asks for none of its episodes any more,
   * so it holds none ({@link heldNumbers}): a **Retry** pressed then is queued behind it.
   */
  runningDone: false,
  /**
   * DramaFetch's own automatic retries **Stop** took out of the queue ({@link dropAutoRetries}), said
   * once the job that ran then ends ({@link sayDroppedRetries}): their alerts (and, in test mode,
   * their journal entries).
   * @type {Job[]}
   */
  droppedRetries: [],
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
  /** the current pause as the engine announced it (`onPause`): its text (English), kind and length */
  pauseText: "",
  pauseKind: "",
  pauseSeconds: 0,
  /**
   * What the running job gathers while it runs — the record its engine was built with
   * ({@link buildEngine}) —: its `begun` tells which dramas of a running batch are not started yet,
   * the first rows of the Waiting card ({@link queueRows}). Null until then: all of them.
   * @type {JobRecord | null}
   */
  runningRecord: null,
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
 * The notifications this page made when a drama finished, and the retry behind each **Retry**
 * button (DramaFetch 1.7.0, {@link alertDrama}). (Exported for the unit tests.)
 */
export const alerts = new PageAlerts();

/**
 * The retry buttons already clicked (the progress card's): disabled until the next job ends, when
 * the progress card is rendered again.
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
  if (app.running !== null && app.running.id === job.id) app.runningRecord = jobRecord; // the Waiting card reads its `begun`
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
  /** the place of the batch's series that runs now (`onSeriesStart`): begun once its list came */
  let current = 0;
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
    askGuessed: job.askGuessed === true, // 3.0.1: a Retry of free episodes DramaFetch guessed were locked
    overwrite: job.overwrite === true, // See episodes' jobs and their retries: no existing-file skip, files replaced
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
    overwrite: job.overwrite === true, // and no done skip
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
      app.pauseKind = kind;
      app.pauseSeconds = seconds;
      renderPause();
    },
    onStart: (start) => {
      jobRecord.begun = current; // its list came (or it was skipped as complete): begun
      jobRecord.current = { seriesId: start.ref.seriesId, name: start.series?.name ?? null, rows: [] }; // its rows, as they come (D11)
      rememberName(start.ref.seriesId, start.series?.name ?? start.name); // read without asking TikTok for it
      renderQueue(); // the drama leaves the Waiting card
      clearPause();
      libraryRunning(start.ref.seriesId, job, start.episodes.map((episode) => episode.number));
      $("progress-current").textContent = t("progressSeries", start.name);
      const body = /** @type {HTMLTableSectionElement} */ ($("result-table").querySelector("tbody"));
      body.append(
        el("tr", { className: "series-row", attrs: { "data-series-id": start.ref.seriesId } }, [
          el("td", { attrs: { colspan: "3" }, text: start.skippedComplete ? t("seriesSkippedComplete", start.name) : start.name }),
        ]),
        ...warningRows(start.series, start.ref.seriesId),
      );
    },
    onResult: (result) => {
      clearPause();
      renderResult(result);
      // 3.0.1 (D11): kept for a Stop that ends the job before this drama's record is made
      if (jobRecord.current?.seriesId === result.episode.seriesId) jobRecord.current.rows.push(rowRecord(result));
      // an automatic retry's episode on disk now: never named as not downloaded should Stop end it
      if (job.autoRetry !== undefined && (result.status === DONE || result.status === SKIPPED_EXISTS)) (jobRecord.saved ??= []).push(result.episode.number);
      // the library's card of the series being downloaded: its count after every episode — one a
      // download in full saved anew counted again, and one it skipped as locked (no request: its
      // earlier download, if any, is kept)
      if (result.episode.seriesId === library.running) {
        if (result.status === DONE || result.status === SKIPPED_LOCKED) library.again?.delete(result.episode.number);
        void refreshLibraryProgress([result.episode.seriesId]);
      }
    },
    onSeriesStart: (index, total, ref) => {
      current = index; // not begun yet: the rest before it, the cooldown and its listing come first
      $("progress-current").textContent = t("progressBatch", [index, total, ref.seriesId]);
      libraryRunning(ref.seriesId, job);
    },
    onSeriesDone: (index, _total, run) => {
      jobRecord.begun = index; // done, whatever came of it: never counted as not started
      // 3.0.1 (D11): its record now, so that a Stop later in the batch keeps its rows in the block
      (jobRecord.records ??= []).push(runRecord(run, job.overwrite === true));
      jobRecord.current = undefined;
      renderQueue(); // refused before its list (a cooldown, a refused write), or not started: it leaves the Waiting card too
      clearPause();
      renderReportLine(run);
      releaseSeries(run, downloader, jobRecord);
      trimResultRows();
      libraryFinished(run.ref.seriesId);
      dramaDone(job, run, jobRecord); // its rows and records are stored: its automatic retry when due, its notification, now
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
 * The running job downloads `seriesId` now: its library card says **Downloading** — counting, when
 * the job downloads its episodes again in full (`overwrite`), the ones it takes only once it saved
 * them anew ({@link library}.again). Such a job's card is drawn once the records are read, with its
 * exact count; until then a redraw shows at most that count (the stored one lowered by the episodes
 * it takes again), never more — so the count only goes up while the job runs.
 * @param {string} seriesId
 * @param {Job} job the running job
 * @param {readonly number[]} [taken] the episodes it takes of that drama, as its fresh list gave them
 *   (`onStart`); the job's own numbers before that list (`onSeriesStart`: a batch, never in full)
 */
function libraryRunning(seriesId, job, taken = job.numbers) {
  if (library.running === seriesId) return;
  library.running = seriesId;
  library.again = job.overwrite === true ? new Set(taken) : null;
  if (app.favorites === null || !app.favorites.items.some((item) => item.seriesId === seriesId)) return;
  if (library.again === null) {
    renderLibrary();
    return;
  }
  const stored = library.progress.get(seriesId);
  if (stored !== undefined) library.progress.set(seriesId, { ...stored, saved: Math.max(0, stored.saved - library.again.size) });
  void refreshLibraryProgress([seriesId]); // drawn with its count without the episodes it takes again
}

/**
 * The running job finished `seriesId`: its library card reads the records again (its episode count)
 * and says nothing more once no job holds its drama.
 * @param {string} seriesId
 */
function libraryFinished(seriesId) {
  library.finished.add(seriesId);
  if (library.running === seriesId) {
    library.running = null;
    library.again = null;
  }
  void refreshLibraryProgress([seriesId]);
}

// --------------------------------------------------------------------------- progress

function clearPause() {
  app.pauseUntil = null;
  app.pauseText = "";
  app.pauseKind = "";
  app.pauseSeconds = 0;
  renderPause();
}

/**
 * The progress card's pause line, drawn when a pause starts and every second of it (DramaFetch
 * 2.0.0, the owner's request of 2026-11-22: the countdown in minutes and seconds): what the pause
 * is, its length and the time left — `Resting 1 min 35 s after 10 downloads — 1 min 07 s left`,
 * `Pausing 7 s before the next episode — 4 s left` ({@link pauseLine}, from the kind and length the
 * engine gave `onPause`); a pause the line has no text of its own for shows the engine's text
 * with the time left (`pauseInForce`). The engine's text stays the job's, in English, for its
 * report.
 */
function renderPause() {
  const element = $("progress-pause");
  if (app.pauseUntil === null) {
    element.hidden = true;
    element.textContent = "";
    return;
  }
  const left = Math.max(0, app.pauseUntil - now());
  const line = pauseLine(app.pauseKind, app.pauseSeconds, app.pauseText, left);
  element.hidden = false;
  element.textContent = line === null ? t("pauseInForce", [shownText(app.pauseText), formatDuration(left)]) : t(line.key, line.substitutions);
}

/**
 * @param {string} status
 * @param {boolean} [guessed] a free episode DramaFetch only guessed was locked (3.0.1): not
 *   downloaded, so the failure colour though its status is `skipped-locked`
 * @returns {string} the CSS class of a status badge
 */
function statusClass(status, guessed = false) {
  if (status === "done") return "done";
  if (guessed) return "failed";
  if (status.startsWith("skipped")) return "skipped";
  return "failed";
}

/**
 * A status badge: a short label in the page's language, the status code itself in its title.
 * @param {string} status
 * @param {string} message the result's message (a row the run stopped before reads “stopped”)
 * @param {boolean} [guessed] the row of a free episode DramaFetch only guessed was locked (3.0.1,
 *   `report.isGuessedLocked`): “not downloaded (free)”, failure-coloured
 * @returns {HTMLElement}
 */
function statusBadge(status, message, guessed = false) {
  return el("span", {
    className: `badge ${statusClass(status, guessed)}`,
    text: statusLabel(status, { lang: shown.lang, message, guessed }),
    title: status,
    attrs: guessed ? { "data-status": status, "data-guessed": "1" } : { "data-status": status },
  });
}

/**
 * The list's warnings under a drama's header row in the result table (3.0.1, the owner's report of
 * 2026-11-27): what **See episodes** shows under its title — a hole, TikTok's count against what
 * came, the pagination's fallbacks, the items DramaFetch could not read, a duplicate number —
 * shown for every job that lists the drama (a paste, a card's **Download**, a **Retry**…), as the
 * tab shows engine texts (`lib/display`). Muted information only when everything TikTok counts is
 * placed; warn-coloured when the list itself is incomplete (`report.listIncomplete`: a number
 * missing — whose episodes also get their rows —, an early end short of TikTok's count, or since
 * 3.0.1 TikTok counting more than the drama certainly has: the list may be incomplete). Each row carries the drama's id: it stays while the drama
 * has a row in the table, and the trimming may take it like an episode's ({@link trimResultRows}).
 * @param {Series | null} series the drama's fresh list; none for a drama skipped as complete
 * @param {string} seriesId
 * @returns {HTMLElement[]}
 */
function warningRows(series, seriesId) {
  if (series === null || series.warnings.length === 0) return [];
  const className = listIncomplete(series) ? "series-warning warn" : "series-warning";
  return series.warnings.map((warning) =>
    el("tr", { className, attrs: { "data-series-id": seriesId } }, [el("td", { attrs: { colspan: "3" }, text: shownText(warning) })]),
  );
}

/** @param {DownloadResult} result */
function renderResult(result) {
  const body = /** @type {HTMLTableSectionElement} */ ($("result-table").querySelector("tbody"));
  const key = `${result.episode.seriesId}:${result.episode.number}`;
  // 3.0.1: a free episode DramaFetch only guessed was locked is not downloaded: marked so
  const guessed = isGuessedLocked(result);
  /** @type {Record<string, string>} */
  const attrs = { "data-key": key, "data-series-id": result.episode.seriesId, "data-number": String(result.episode.number), "data-status": result.status };
  if (guessed) attrs["data-guessed"] = "1";
  const row = el("tr", { attrs }, [
    el("td", { text: episodeLabel(result.episode.number) }),
    el("td", {}, [statusBadge(result.status, result.message, guessed)]),
    el("td", { className: "message", text: shownText(result.message) }),
  ]);
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
 * of the series left with no row. A row of an episode that did not download never leaves — a
 * failure row, and (3.0.1) the row of a free episode DramaFetch only guessed was locked
 * (`data-guessed`) —: the job's end shows those apart ({@link renderFailed}), nor does its series'
 * header; every finished series keeps its report line, and `#result-trimmed` says so once rows
 * have left. A display matter only: the results, the job's records and the report are untouched.
 * (Exported for the unit tests, which cannot run a job.)
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
    if (isSeriesRow(row) || isFailure(row.getAttribute("data-status")) || row.getAttribute("data-guessed") === "1") continue;
    leaving.add(row);
    excess -= 1;
  }
  if (leaving.size === 0) return;
  body.replaceChildren();
  appendInPieces(body, withoutBareHeaders(rows.filter((row) => !leaving.has(row)))); // a header whose series has no row left goes too
  $("result-trimmed").hidden = false;
}

/**
 * At most this many report lines stay under the progress card (3.0.1): the newest; the oldest go
 * first. Every job's lines stay for the tab's life (a paste, then another, keeps both).
 */
export const MAX_REPORT_LINES = 500;

/**
 * A drama's report line under the progress card, after the lines of every earlier job (3.0.1, the
 * owner's report of 2026-11-27: pasting drama B no longer erases drama A's line), styled by its
 * outcome — `complete` (the drama complete, or found complete and skipped), else `incomplete` (not
 * complete, something not downloaded, an error) —; past {@link MAX_REPORT_LINES} the oldest go.
 * Reloading the tab clears them, as ever.
 * @param {SeriesRun} run
 */
function renderReportLine(run) {
  const name = run.report.name || run.series?.name || run.ref.seriesId;
  const text = `${name}: ${shownText(run.error !== null ? run.error : reportLine(run.report))}`;
  const outcome = run.error === null && run.report.complete ? "complete" : "incomplete";
  const lines = $("report-lines");
  lines.append(el("li", { text, className: outcome, attrs: { "data-series-id": run.ref.seriesId } }));
  while (lines.children.length > MAX_REPORT_LINES) lines.children[0]?.remove();
}

/**
 * The job's batch table under the progress card: one row per drama — its name, its status and its
 * counts: listed, downloaded, on disk, locked, not asked, failed. **Not asked** (3.0.1, the lead's
 * D12): the free episodes DramaFetch did not ask for because TikTok's list made them look locked
 * (`report.guessedLocked`, `not downloaded (free)`), no longer counted under **Locked**, which keeps
 * the paid, TikTok-flagged and DRM ones — the Python tool's batch table has the same column.
 * (Exported for the unit tests, which cannot run a job.)
 * @param {readonly SeriesRun[]} runs
 */
export function renderBatchTable(runs) {
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
        el("td", { text: String(report.guessedLocked) }),
        el("td", { text: String(report.failed) }),
      ]),
    );
  }
  table.hidden = runs.length === 0;
}

/**
 * A job starts: the progress card shows it, the last job's rows go (the result table shows the job
 * that runs). Since 3.0.1 (the owner's report of 2026-11-27: a paste erased the previous drama's
 * line, its missing rows and its **Retry**) the report lines under the table and the **Did not
 * download** block stay — every job's, for the tab's life ({@link renderReportLine},
 * {@link renderFailed}: a job's end replaces only the rows of the episodes it took). What goes is
 * the last job's own: its report (**Save the report** saves the last job's) and its `Report saved:
 * …` line, and the block's line saying what is retried automatically — except while the job is an
 * automatic retry that job queued (DramaFetch 1.8.0): its line, its **Save the report** and its
 * `Report saved: …` line stay until this job's end ({@link reportJobEnd}) — but the line, which a
 * **Stop** taking the other automatic retries it counted out of the queue takes away at once
 * ({@link dropAutoRetries}).
 * @param {Job} job
 */
function startProgress(job) {
  $("progress-card").hidden = false;
  /** @type {HTMLTableSectionElement} */ ($("result-table").querySelector("tbody")).textContent = "";
  $("result-trimmed").hidden = true;
  $("batch-table").hidden = true;
  const retrying = job.autoRetry !== undefined && app.failedAuto.has(job.autoRetry.alertId);
  app.failedAuto = new Set();
  if (!retrying) {
    $("failed-auto").hidden = true; // what the last job's block said it retries automatically
    $("failed-auto").textContent = "";
    app.lastReport = null;
    hideReportLine(); // the last job's report line: this job's report comes at its end
  }
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
 * Whether a stored row (`entry.series[].rows[]`, {@link runRecord}) is an episode that did not
 * download: a failure ({@link isFailure}), or (3.0.1) a free episode DramaFetch only guessed was
 * locked (`guessed: true` beside `skipped-locked`).
 * @param {unknown} status
 * @param {unknown} guessed
 * @returns {status is string}
 */
function notDownloaded(status, guessed) {
  return isFailure(status) || (status === SKIPPED_LOCKED && guessed === true);
}

/**
 * The rows of a finished job's per-series records (`entry.series`, {@link runRecord}) whose
 * episode did not download: in the order of the series, each series' ascending, one per episode
 * (the last row written for it) — a failure, and (3.0.1) a free episode DramaFetch only guessed was
 * locked ({@link notDownloaded}, `guessed` on the row). A record without rows — a failed resolve, a
 * series the batch never started, a listing — contributes nothing. A record that says `overwrite:
 * true` (its job downloaded again in full, DramaFetch 3.0.0) marks its rows so. Stored data:
 * anything malformed is skipped.
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
    const overwrite = record["overwrite"] === true;
    for (const raw of stored) {
      if (raw === null || typeof raw !== "object") continue;
      const row = /** @type {Record<string, unknown>} */ (raw);
      const status = row["status"];
      const number = row["number"];
      if (!notDownloaded(status, row["guessed"]) || typeof number !== "number" || !Number.isInteger(number)) continue;
      let series = bySeries.get(seriesId);
      if (series === undefined) {
        series = { name: typeof record["name"] === "string" && record["name"] !== "" ? record["name"] : null, rows: new Map() };
        bySeries.set(seriesId, series);
      }
      /** @type {FailedRow} */
      const failed = { seriesId, name: series.name, number, status, message: typeof row["message"] === "string" ? row["message"] : "" };
      if (overwrite) failed.overwrite = true;
      if (row["guessed"] === true && status === SKIPPED_LOCKED) failed.guessed = true;
      series.rows.set(number, failed);
    }
  }
  return [...bySeries.values()].flatMap((series) => [...series.rows.values()].sort((a, b) => a.number - b.number));
}

/**
 * @param {readonly FailedRow[]} rows
 * @returns {RetryTarget[]} one per series, in the rows' order — with `overwrite` when a row of it
 *   came from a job that downloaded again in full: its retry does the same —, `missing`, the
 *   numbers whose rows say they were not in TikTok's list (3.0.1, `report.isNotListed`), and
 *   `guessed`, those of free episodes DramaFetch only guessed were locked (3.0.1)
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
    if (row.overwrite === true) target.overwrite = true;
    if (isNotListed(row)) (target.missing ??= []).push(row.number);
    if (row.guessed === true) (target.guessed ??= []).push(row.number);
  }
  return [...targets.values()];
}

/**
 * `target` over `numbers` only: its `missing` and `guessed` kept to them (absent when none is left).
 * @param {RetryTarget} target
 * @param {number[]} numbers
 * @returns {RetryTarget}
 */
function withNumbers(target, numbers) {
  const { missing: allMissing, guessed: allGuessed, ...rest } = target;
  /** @type {RetryTarget} */
  const kept = { ...rest, numbers };
  const missing = (allMissing ?? []).filter((number) => numbers.includes(number));
  const guessed = (allGuessed ?? []).filter((number) => numbers.includes(number));
  if (missing.length > 0) kept.missing = missing;
  if (guessed.length > 0) kept.guessed = guessed;
  return kept;
}

/**
 * What a retry queues for the records of a finished job: the series with at least one episode
 * that did not download, in the order of the series, each with those episodes' numbers,
 * ascending and de-duplicated — and, for the records of a job that downloaded again in full
 * (`overwrite: true` in its record, {@link runRecord}: a **See episodes** job or a retry of one),
 * `overwrite` too: its retry downloads them again in full as well, never skipping one for the old
 * copy a failed download left on disk (DramaFetch 3.0.0). (Exported for the unit tests, which
 * cannot run a job.)
 * @param {readonly unknown[]} seriesRecords
 * @returns {RetryTarget[]}
 */
export function retryTargets(seriesRecords) {
  return targetsOf(failedRows(seriesRecords));
}

/**
 * The jobs a retry queues: one selection job per series and kind, in the order of the series, over
 * exactly that series' episodes that did not download — the job **Download selected** queues in
 * **See episodes** over those numbers ({@link runSelectionJob}: the cooldown gate, the rest between
 * jobs, a fresh resolve, then the downloads; an episode meanwhile on disk is skipped), but with
 * `includeLocked` false: a locked one is not asked for, nor one an earlier download found
 * encrypted, where **Download selected** asks for such a row ticked. A target with `overwrite`
 * (the failures of a job that downloaded again in full) queues a job with `overwrite` (DramaFetch
 * 3.0.0): its episodes are downloaded again in full even when an older copy is on disk. Since 3.0.1
 * a target's free episodes DramaFetch only guessed were locked (`guessed`) get a `selection` job of
 * their own, `askGuessed` ({@link Job}.askGuessed): it asks TikTok for them anyway — one request
 * each, the usual pace, TikTok decides — while its fresh list still only guesses they are locked;
 * the drama's other episodes (failures, those TikTok's list lacked) keep their own job, which asks
 * for no locked one.
 * @param {readonly RetryTarget[]} targets
 * @returns {Omit<Job, "id">[]}
 */
export function retryJobs(targets) {
  /** @type {Omit<Job, "id">[]} */
  const jobs = [];
  for (const target of targets) {
    const seriesId = target.seriesId;
    const guessed = new Set((target.guessed ?? []).filter((number) => target.numbers.includes(number)));
    const plain = target.numbers.filter((number) => !guessed.has(number));
    /**
     * @param {number[]} numbers
     * @returns {Omit<Job, "id">}
     */
    const jobOf = (numbers) => {
      /** @type {Omit<Job, "id">} */
      const job = {
        kind: "selection",
        label: t("jobRetry", [numbers.length, target.name ?? seriesId]),
        refs: [{ kind: "series", seriesId, episodeHint: null, sourceUrl: seriesId }],
        series: null,
        numbers,
        includeLocked: false,
        recheck: false,
      };
      if (target.overwrite === true) job.overwrite = true;
      return job;
    };
    if (plain.length > 0) {
      const job = jobOf(plain);
      // the episodes TikTok's list lacked (3.0.1): asked for the same way — a fresh list, then them
      const missing = (target.missing ?? []).filter((number) => plain.includes(number));
      if (missing.length > 0) job.missing = missing;
      jobs.push(job);
    }
    if (guessed.size > 0) jobs.push({ ...jobOf([...guessed].sort((a, b) => a - b)), askGuessed: true });
  }
  return jobs;
}

/**
 * The gate of every download button, the retries' too: this tab holds the engine, no cooldown is
 * in force and no write was refused.
 * @returns {boolean}
 */
function retryAllowed() {
  return app.owner && app.cooldown === null && app.unsaved === null;
}

/**
 * The episodes of `seriesId` a `selection` job holds already — one waiting, or the one running
 * until it is done with its drama ({@link app}.runningDone: from then on it asks for none of them,
 * and a retry of what it could not save is no duplicate) —: no retry queues them twice (DramaFetch
 * 1.8.0). `exceptId` is the job whose drama is being decided (it is done with it).
 * @param {string} seriesId
 * @param {number | null} [exceptId]
 * @returns {Set<number>}
 */
function heldNumbers(seriesId, exceptId = null) {
  /** @type {Set<number>} */
  const held = new Set();
  for (const job of [...(app.running === null || app.runningDone ? [] : [app.running]), ...app.queue]) {
    if (job.id === exceptId || job.kind !== "selection" || !job.refs.some((ref) => ref.seriesId === seriesId)) continue;
    for (const number of job.numbers) held.add(number);
  }
  return held;
}

/**
 * Queue the retry of `targets` — {@link retryJobs} → {@link enqueue}, at the end of the queue —
 * over the episodes no `selection` job holds already ({@link heldNumbers}: asked again before each,
 * so a series named twice is queued once); a target left with none queues nothing. Returns how
 * many jobs were queued.
 * @param {readonly RetryTarget[]} targets
 * @returns {number}
 */
function queueRetries(targets) {
  let queued = 0;
  for (const target of targets) {
    rememberName(target.seriesId, target.name); // its records' name: the Waiting card's row says it
    const held = heldNumbers(target.seriesId);
    const numbers = target.numbers.filter((number) => !held.has(number));
    if (numbers.length === 0) continue;
    for (const job of retryJobs([{ ...target, numbers }])) if (enqueue(job)) queued += 1; // `missing` kept to `numbers` there
  }
  return queued;
}

/**
 * Queue the retry of `targets` and spend `source`, the button that asked for it, until the next
 * job ends (the progress card is rendered again then: {@link spentRetries}). The gate of every
 * download button holds:
 * never from a read-only tab, never during a cooldown. The episodes a `selection` job of their
 * series holds already — a waiting one (a retry, **Download
 * selected**, **Download all available**), or the running one until it is done with its drama
 * ({@link heldNumbers}) — are not queued twice: with nothing left, the status line says so
 * (`retryAlreadyQueued`) — and no listing is asked for twice.
 * @param {readonly RetryTarget[]} targets
 * @param {HTMLButtonElement} source
 */
function startRetry(targets, source) {
  if (!retryAllowed() || spentRetries.has(source)) return;
  source.disabled = true;
  spentRetries.add(source);
  if (queueRetries(targets) === 0) setStatus($("input-status"), t("retryAlreadyQueued"), "error");
}

/**
 * The **Retry** button of a notification this page made, handed over by the worker
 * (`dramafetch:retry`): what the tab's **Retry** does for that drama — {@link queueRetries}, behind
 * the same gate, so the job then takes the cooldown gate, the rest between jobs and a fresh list
 * like any other —, and the notification is taken away. Its episodes queued already (a waiting
 * `selection` job of that series holds them, or the running one not yet done with its drama:
 * {@link heldNumbers}): nothing queued twice, and the answer is `queued` all the same — the work
 * waits in the queue. Refused by the gate (a cooldown in force, a refused write), nothing is
 * queued and the notification stays: the worker brings this tab to the front, where the banner or
 * the status line says why. Null when this page holds no such retry — the worker then only opens
 * or focuses the DramaFetch tab.
 * @param {string} notificationId
 * @returns {{ok: true, queued: boolean, tabId: number | null} | null}
 */
function retryFromAlert(notificationId) {
  const target = alerts.retryOf(notificationId);
  if (target === null) return null;
  if (!retryAllowed()) return { ok: true, queued: false, tabId: app.tabId ?? null };
  queueRetries([target]);
  alerts.clear(notificationId);
  return { ok: true, queued: true, tabId: app.tabId ?? null };
}

/**
 * The automatic retry of a drama a download job just finished (DramaFetch 1.8.0, the owner's
 * request of 2026-11-21: “retry on its own a download that did not work”) — ONE, queued when all of
 * these hold: the **Retry on its own what did not download** setting is on; the job is a `batch` or
 * a `selection` that is not itself an automatic retry (one automatic round per download); the
 * drama's run made a request and did NOT stop — any stop (a 429, a 403, a captcha, a login wall,
 * the cooldown, three failures in a row, a refused write, **Stop**, an error) means none:
 * DramaFetch/CLAUDE.md → Pacing, “do not retry … automatically after one” —, and **Stop** was not
 * pressed during the job (the engine looks at Stop between two episodes and in its pauses only: one
 * pressed while the drama's last episode downloaded ends no run, but it is a stop all the same,
 * {@link app}.stopRequested until the job's end); the run left episodes
 * whose last row is exactly `failed` and not `stopped: …` — a cut transfer, a file that failed its
 * check, a network error — or (3.0.1) says it was not in TikTok's list (`failed-unavailable`, `not in
 * TikTok's list…`, `report.isNotListed`: a fresh list may hold it), never another
 * `failed-unavailable` (short-served, DRM, gone: no retry changes it), a locked one or a stop's;
 * the tab may queue a download now ({@link retryAllowed}); and no
 * `selection` job holds those episodes already ({@link heldNumbers}). It is exactly what the alert's
 * **Retry** would queue the moment the alert appeared — {@link retryJobs} → {@link enqueue}, at the
 * END of the queue (after the rest of this job and every job waiting), `includeLocked` false — so
 * it takes the job gate, the cooldown, the rest between jobs, a fresh list and every pause like any
 * retry: nothing faster, no request a manual **Retry** would not make. Its label is `jobAutoRetry`;
 * `autoRetry` names its drama's alert and (3.0.1, the lead's D8) carries the drama's free episodes
 * DramaFetch only guessed were locked — never asked for by it — with the hints of one, which that
 * alert names ({@link alertDrama}, {@link alertNotRetried}). Returns what it queued, that alert's id
 * and those episodes, or null.
 * @param {Job} job
 * @param {SeriesRun} run
 * @param {Pick<JobRecord, "autoRetried">} jobRecord
 * @returns {{target: RetryTarget, alertId: string, guessed: number[], hints: string[]} | null}
 */
function queueAutoRetry(job, run, jobRecord) {
  if (!app.settings.autoRetry || job.autoRetry !== undefined) return null;
  if (job.kind !== "batch" && job.kind !== "selection") return null;
  if (!run.contacted || run.stop || run.report.stopped) return null;
  if (app.stopRequested) return null; // Stop pressed after the engine's last look at it: a stop too
  if (!retryAllowed()) return null;
  // the rows as the tab's Retry reads them (the last per episode), then only the plain failures and
  // (3.0.1) the episodes TikTok's list lacked; a job that downloaded again in full (See episodes)
  // gets a retry that does too (3.0.0)
  const rows = failedRows([runRecord(run, job.overwrite === true)]).filter(
    (row) => (row.status === FAILED && !row.message.startsWith(STOPPED_PREFIX)) || isNotListed(row),
  );
  const [failed] = targetsOf(rows);
  if (failed === undefined) return null;
  const held = heldNumbers(failed.seriesId, job.id);
  const target = withNumbers(failed, failed.numbers.filter((number) => !held.has(number)));
  if (target.numbers.length === 0) return null;
  const [retry] = retryJobs([target]);
  if (retry === undefined) return null;
  // the ⚠ alert's: “retrying” takes its place
  const alertId = alerts.idOf(job.id, `${run.ref.seriesId}:retry`);
  const label = t("jobAutoRetry", [target.numbers.length, target.name ?? target.seriesId]);
  // 3.0.1 (the lead's D8): the drama's free episodes DramaFetch only guessed were locked, never asked
  // for on its own — carried, so that its drama's alert names them whatever becomes of it
  const guessed = (dramaTarget(run, job.overwrite === true)?.guessed ?? []).filter((number) => !target.numbers.includes(number));
  const hints = guessed.length === 1 ? guessedHints(run, /** @type {number} */ (guessed[0])) : [];
  /** @type {NonNullable<Job["autoRetry"]>} */
  const autoRetry = { alertId, name: target.name };
  if (guessed.length > 0) Object.assign(autoRetry, { guessed, hints });
  if (!enqueue({ ...retry, label, autoRetry })) return null;
  if (jobRecord.autoRetried === undefined) jobRecord.autoRetried = [];
  jobRecord.autoRetried.push(alertId);
  return { target, alertId, guessed, hints };
}

/**
 * A drama of a download job is done — its rows and records stored —: its automatic retry when one
 * is due ({@link queueAutoRetry}, whatever the alert setting), then its notification
 * ({@link alertDrama}). A batch's from `onSeriesDone`, a selection job's from {@link runJob} — the
 * running selection job
 * holds its episodes no more ({@link app}.runningDone): a **Retry** of what it could not save, its
 * alert's included, is queued behind it. Never throws (the engine calls it between two series),
 * never waits. (Exported for the unit tests, which cannot run a selection job to its drama.)
 * @param {Job} job
 * @param {SeriesRun} run
 * @param {Pick<JobRecord, "autoRetried">} jobRecord
 */
export function dramaDone(job, run, jobRecord) {
  if (job.kind === "selection" && app.running !== null && app.running.id === job.id) app.runningDone = true;
  /** @type {{target: RetryTarget, alertId: string, guessed: number[], hints: string[]} | null} */
  let queued = null;
  try {
    queued = queueAutoRetry(job, run, jobRecord);
  } catch (error) {
    console.warn(error);
  }
  alertDrama(job, run, queued);
}

/**
 * What a drama's alert names and its **Retry** takes (3.0.1): the tab's own {@link retryTargets} of
 * the run's rows, plus every free episode its report counts as one DramaFetch only guessed was
 * locked (`report.guessedLockedNumbers`: a selection's report reads the whole series, so one outside
 * the selection too) — named apart and asked for anyway by the **Retry** ({@link retryJobs}); null
 * when there is nothing to retry.
 * @param {SeriesRun} run
 * @param {boolean} overwrite the job downloaded again in full ({@link Job}.overwrite)
 * @returns {RetryTarget | null}
 */
function dramaTarget(run, overwrite) {
  const target = retryTargets([runRecord(run, overwrite)])[0] ?? null;
  const extra = (run.report.guessedLockedNumbers ?? []).filter((number) => target === null || !target.numbers.includes(number));
  if (extra.length === 0) return target;
  /** @type {RetryTarget} */
  const merged = target ?? { seriesId: run.ref.seriesId, name: run.report.name || run.series?.name || null, numbers: [] };
  merged.numbers = [...merged.numbers, ...extra].sort((a, b) => a - b);
  merged.guessed = [...(merged.guessed ?? []), ...extra].sort((a, b) => a - b);
  if (overwrite) merged.overwrite = true;
  return merged;
}

/**
 * A drama of a download job is done — its rows and records stored —: its notification, while the
 * **Alert me when a drama finishes** setting is on (`alerts.dramaAlert`: complete, episodes to
 * retry — the tab's own {@link retryTargets} for that drama behind its **Retry**, and since 3.0.1
 * every free episode DramaFetch only guessed was locked ({@link dramaTarget}) —, or not
 * complete; none for a drama skipped as complete, refused before any request or never started).
 * DramaFetch 1.8.0: when its automatic retry was queued just now (`queued`), “retrying” instead of
 * the ⚠ alert, with no button (`alerts.autoRetryAlert`) — naming apart (3.0.1, the lead's D8) the
 * drama's free episodes DramaFetch only guessed were locked, which it does not retry —; an automatic
 * retry's own drama gets its alert under the id of its “retrying” one, which Chrome replaces, `After
 * an automatic retry.` its context unless it stopped. Never throws (the engine calls it between two
 * series), never waits.
 * @param {Job} job
 * @param {SeriesRun} run
 * @param {{target: RetryTarget, alertId: string, guessed: number[], hints: string[]} | null} [queued]
 */
function alertDrama(job, run, queued = null) {
  if (!app.settings.alerts) return;
  if (autoRetryUnlisted(job, run)) return; // its ⚠ alert, with its Retry, comes at the job's end
  try {
    if (queued !== null) {
      // its retry is queued: no button, none kept
      alerts.show(queued.alertId, autoRetryAlert(run, queued.target, guessedEpisodes(queued.guessed, queued.hints, shownText)));
      return;
    }
    const target = dramaTarget(run, job.overwrite === true); // its Retry: what the tab's takes, the guessed locks too
    const auto = job.autoRetry;
    const texts = dramaAlert(run, target, shownText, { afterAutoRetry: auto !== undefined });
    if (texts === null) return;
    const id = auto !== undefined ? auto.alertId : alerts.idOf(job.id, `${run.ref.seriesId}:${texts.kind}`);
    alerts.show(id, texts, texts.kind === "retry" ? target : null);
  } catch (error) {
    console.warn(error);
  }
}

/**
 * Whether `run` is an automatic retry's that never got its fresh list — no list and no row: its
 * listing failed (a login wall, no episode list in time, the tab closed, a 429 or a captcha on the
 * list) —; its drama's alert is then the ⚠ one of the episodes it carried, with its **Retry**, at the
 * job's end ({@link alertNotRetried}), never a `not complete` with no button (3.0.1).
 * @param {Pick<Job, "autoRetry">} job
 * @param {SeriesRun} run
 * @returns {boolean}
 */
function autoRetryUnlisted(job, run) {
  return job.autoRetry !== undefined && run.series === null && run.results.length === 0;
}

/**
 * An automatic retry that did not get to its drama's alert (DramaFetch 1.8.0), under the id of its
 * “retrying” one (Chrome replaces it), its drama's ⚠ alert WITH its **Retry**:
 * - one that never ran — **Stop** or a stop took it out of the queue, it was refused at its own
 *   gate, or **Stop** or an error ended it before any request (`saved` null) —: the job's own
 *   episodes, `Not retried automatically: <reason>` its context (`alerts.notRetriedAlert`);
 * - one that ran — asked TikTok for its list, maybe saved episodes — and that **Stop** or an error
 *   ended before its drama's alert, or whose fresh list never came (3.0.1: {@link autoRetryUnlisted}):
 *   the episodes it did not get on disk (`saved` the others), the stop's reason its context, as for
 *   an automatic retry whose run stopped (`alerts.stoppedRetryAlert`); none left — “retrying” goes.
 * What the alert's **Retry** queues is what it names — downloaded again in full when the
 * automatic retry was (`overwrite`, a **See episodes** job's: DramaFetch 3.0.0) —, the episodes
 * TikTok's list lacked named apart (`missing`, 3.0.1), and (3.0.1, the lead's D8) the drama's free
 * episodes DramaFetch only guessed were locked, which the automatic retry carried
 * (`autoRetry.guessed`, the hints of one with them): named apart, and its **Retry** queues their
 * job that asks for them anyway beside the others' ({@link retryJobs}) — with every episode it
 * retried on disk, the alert names those alone; with none left at all, “retrying” goes. Behind the
 * **Alert me when a drama finishes** setting; never throws, never waits. (Exported for the unit
 * tests, which cannot run an automatic retry through its job to a Stop.)
 * @param {Pick<Job, "refs" | "numbers" | "autoRetry" | "overwrite" | "missing">} job
 * @param {string} reason why it did not run, or why it ended: the stop's reason, an engine text
 * @param {readonly number[] | null} [saved] null: it never ran; else its episodes on disk
 *   ({@link JobRecord}.saved)
 */
export function alertNotRetried(job, reason, saved = null) {
  const auto = job.autoRetry;
  const ref = job.refs[0];
  if (auto === undefined || ref === undefined || job.numbers.length === 0 || !app.settings.alerts) return;
  try {
    const left = saved === null ? [...job.numbers] : job.numbers.filter((number) => !saved.includes(number));
    // 3.0.1 (D8): the drama's free episodes not asked for — never the automatic retry's own
    const guessed = (auto.guessed ?? []).filter((number) => !left.includes(number) && !(saved ?? []).includes(number));
    if (left.length === 0 && guessed.length === 0) {
      alerts.clear(auto.alertId); // every episode it retried is on disk: nothing to say “retrying” of
      return;
    }
    const numbers = [...left, ...guessed].sort((a, b) => a - b);
    /** @type {RetryTarget} */
    let target = { seriesId: ref.seriesId, name: auto.name, numbers };
    if (job.overwrite === true) target.overwrite = true; // its Retry downloads them again in full, as it would have
    if (guessed.length > 0) target.guessed = guessed; // its Retry asks for them anyway, in a job of their own
    if (job.missing !== undefined) target = withNumbers({ ...target, missing: job.missing }, numbers); // 3.0.1: named apart
    const hints = auto.hints ?? [];
    const texts = saved === null ? notRetriedAlert(target, reason, shownText, hints) : stoppedRetryAlert(target, reason, shownText, hints);
    alerts.show(auto.alertId, texts, target);
  } catch (error) {
    console.warn(error);
  }
}

/**
 * A job ended stopped — a refusal, a cooldown, three failures in a row, **Stop**, a write refused,
 * an error — after it made a request: when dramas were never started — a download job's own, and
 * those of the download jobs its stop took out of the queue, whatever job stopped (a listing too:
 * an alert's **Retry** may wait behind one) —, ONE more notification says so
 * (`alerts.stoppedAlert`: the reason as the tab shows it, how many). Nothing for a job that asked
 * TikTok for nothing (refused at its gate). An automatic retry (DramaFetch 1.8.0) is never among
 * `cancelled`: its drama gets its own ⚠ alert ({@link alertNotRetried}). Never throws, never
 * waits. (Exported for the unit tests.)
 * @param {Pick<Job, "id" | "kind" | "refs" | "contacted">} job
 * @param {string | null} stop why it stopped, or null
 * @param {readonly SeriesRun[] | null} runs the runs it produced; null when it ended before them
 *   (**Stop** in a batch: the series after the ones it began were never started)
 * @param {Pick<JobRecord, "begun">} jobRecord
 * @param {readonly Pick<Job, "kind" | "refs">[]} cancelled the jobs its stop took out of the queue,
 *   but the automatic retries
 */
export function alertJobEnd(job, stop, runs, jobRecord, cancelled) {
  if (stop === null || job.contacted !== true || !app.settings.alerts) return;
  try {
    /** @type {Set<string>} the series never started */
    const never = new Set();
    // the job's own dramas only when it downloads (a listing's series are no downloads)
    const downloads = job.kind === "batch" || job.kind === "selection";
    if (downloads && runs !== null) {
      // not started after the stop, or refused at its own gate: no request, no row
      for (const run of runs) if (!run.contacted && run.results.length === 0) never.add(run.ref.seriesId);
    } else if (downloads && job.kind === "batch") {
      for (const ref of job.refs.slice(jobRecord.begun ?? 0)) never.add(ref.seriesId);
    }
    for (const waiting of cancelled) {
      if (waiting.kind === "batch" || waiting.kind === "selection") for (const ref of waiting.refs) never.add(ref.seriesId);
    }
    if (never.size > 0) alerts.show(alerts.idOf(job.id, "stopped"), stoppedAlert(stop, never.size, shownText));
  } catch (error) {
    console.warn(error);
  }
}

/**
 * The episodes of `seriesRecords` each record's run took — every number it has a row for: a whole
 * drama's every listed episode and every number its list lacked, a selection's chosen numbers and
 * the wanted ones its list lacked — by series id ({@link renderFailed}: the block's rows of those
 * episodes are replaced, the others stay). Stored data: anything malformed is skipped.
 * @param {readonly unknown[]} seriesRecords
 * @returns {Map<string, {name: string | null, numbers: Set<number>}>}
 */
function takenBy(seriesRecords) {
  /** @type {Map<string, {name: string | null, numbers: Set<number>}>} */
  const taken = new Map();
  for (const item of seriesRecords) {
    if (item === null || typeof item !== "object") continue;
    const record = /** @type {Record<string, unknown>} */ (item);
    const seriesId = record["series_id"];
    const rows = record["rows"];
    if (typeof seriesId !== "string" || seriesId === "" || !Array.isArray(rows)) continue;
    let entry = taken.get(seriesId);
    if (entry === undefined) {
      entry = { name: typeof record["name"] === "string" && record["name"] !== "" ? record["name"] : null, numbers: new Set() };
      taken.set(seriesId, entry);
    }
    for (const raw of rows) {
      const number = raw !== null && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw)["number"] : undefined;
      if (typeof number === "number" && Number.isInteger(number)) entry.numbers.add(number);
    }
  }
  return taken;
}

/**
 * The job ended: its episodes that did not download, shown apart from the ones that completed.
 * Every failure row — a `failed-*` status, the rows a stop left `stopped: …` included, since 3.0.1
 * the row of every episode TikTok's list lacked (`missing from the list`, `report.isNotListed`) and
 * the row of every free episode DramaFetch only guessed was locked (`not downloaded (free)`,
 * `report.isGuessedLocked`) — leaves `#result-table` for `#failed-table`, under a heading with the
 * count and the button that queues them again ({@link retryJobs}: a fresh listing, then those
 * numbers — the guessed ones in a job of their own that asks for them anyway); the result table
 * keeps what completed (done, skipped, dry run) and the list's warnings under each drama's header.
 * Since 3.0.1 (the owner's report of 2026-11-27) the block keeps every job's rows for the tab's
 * life ({@link app}.failedRows): this job's end replaces only the rows of the episodes it took
 * ({@link takenBy} — a drama's retry replaces its retried numbers: the ones it saved leave, the ones
 * still not downloaded stay with their new message) and leaves every other drama's; the heading
 * counts every row and the button retries every row (one `selection` job per drama and kind). No
 * row at all: the block stays hidden. `retrying`: the automatic retries the job queued that still
 * wait (DramaFetch 1.8.0, {@link queueAutoRetry}) — when there are any, `#failed-auto` under the
 * heading says how many of those episodes will be retried automatically, once; hidden otherwise.
 * The button's retry of a job that downloaded again in full (its records say `overwrite`: **See
 * episodes**, DramaFetch 3.0.0) does too ({@link retryTargets}). (Exported for the unit tests,
 * which cannot run a job.)
 * @param {readonly unknown[]} seriesRecords the job's per-series records ({@link runRecord})
 * @param {readonly Pick<Job, "numbers" | "autoRetry">[]} [retrying]
 */
export function renderFailed(seriesRecords, retrying = []) {
  const fresh = failedRows(seriesRecords);
  // the block's rows of the episodes this job took give way to this job's; the others stay
  for (const [seriesId, taken] of takenBy(seriesRecords)) {
    let drama = app.failedRows.get(seriesId);
    if (drama !== undefined) for (const number of taken.numbers) drama.rows.delete(number);
    for (const row of fresh) {
      if (row.seriesId !== seriesId) continue;
      if (drama === undefined) {
        drama = { name: taken.name, rows: new Map() };
        app.failedRows.set(seriesId, drama);
      }
      if (taken.name !== null) drama.name = taken.name;
      drama.rows.set(row.number, row);
    }
    if (drama !== undefined && drama.rows.size === 0) app.failedRows.delete(seriesId);
  }
  /** @type {FailedRow[]} */
  const rows = [];
  for (const drama of app.failedRows.values()) {
    for (const row of [...drama.rows.values()].sort((a, b) => a.number - b.number)) rows.push({ ...row, name: drama.name ?? row.name });
  }
  const retry = button("retry-button");
  const body = /** @type {HTMLTableSectionElement} */ ($("failed-table").querySelector("tbody"));
  body.textContent = "";
  spentRetries.delete(retry);
  app.failed = rows.length > 0 ? targetsOf(rows) : null;
  const automatic = fresh.length > 0 ? retrying.reduce((count, job) => count + job.numbers.length, 0) : 0;
  const line = $("failed-auto");
  line.hidden = automatic === 0;
  line.textContent = automatic === 0 ? "" : automatic === 1 ? t("failedAutoRetryOne") : t("failedAutoRetry", [automatic]);
  // the block stays while the first of them runs (startProgress)
  app.failedAuto = new Set(automatic === 0 ? [] : retrying.flatMap((job) => (job.autoRetry === undefined ? [] : [job.autoRetry.alertId])));
  if (fresh.length > 0) {
    // this job's rows of episodes that did not download leave the result table for the block
    const leaving = new Set(fresh.map((row) => `${row.seriesId}:${row.number}`));
    const results = /** @type {HTMLTableSectionElement} */ ($("result-table").querySelector("tbody"));
    const kept = [...results.children].filter((row) => !leaving.has(`${row.getAttribute("data-series-id")}:${row.getAttribute("data-number")}`));
    results.replaceChildren();
    // a series' header with no row left goes too; never one spread of them all: a table of
    // 125 000 rows would overflow the call
    appendInPieces(results, withoutBareHeaders(kept));
  }
  if (rows.length > 0) {
    for (const row of rows) {
      /** @type {Record<string, string>} */
      const attrs = { "data-series-id": row.seriesId, "data-number": String(row.number), "data-status": row.status };
      if (row.guessed === true) attrs["data-guessed"] = "1";
      body.append(
        el("tr", { attrs }, [
          el("td", { text: row.name ?? row.seriesId }),
          el("td", { text: episodeLabel(row.number) }),
          el("td", {}, [statusBadge(row.status, row.message, row.guessed === true)]),
          el("td", { className: "message", text: shownText(row.message) }),
        ]),
      );
    }
    $("failed-heading").textContent = t("failedHeading", [rows.length]);
    retry.textContent = t("retryButton", [rows.length]);
  }
  showFailedBlock();
  updateButtons();
}

/**
 * What the **Did not download** block shows (3.0.1, the lead's D9): its heading with the count, its
 * **Retry** and its table while it holds a row ({@link app}.failedRows); its **Save the report** and
 * its `Report saved: …` line (`#failed-report`) while the last job left a report
 * ({@link app}.lastReport) or that line says something — with no row too: a drama whose list only
 * came short (an early end with no count from TikTok, a count it cannot place: `report.listIncomplete`)
 * has no row to retry, but its report is saved and said, and **Save the report** saves it again.
 * With neither, the block is hidden; a block with no row keeps no count (D14: a **Retry** that
 * emptied it leaves no `Did not download (2)` behind).
 */
function showFailedBlock() {
  let rows = 0;
  for (const drama of app.failedRows.values()) rows += drama.rows.size;
  const reported = app.lastReport !== null || $("failed-report").textContent !== ""; // a report, or what became of one
  $("failed-block").hidden = rows === 0 && !reported;
  for (const id of ["failed-heading", "retry-button", "failed-table"]) $(id).hidden = rows === 0;
  if (rows === 0) {
    $("failed-heading").textContent = "";
    button("retry-button").textContent = "";
  }
}

// ------------------------------------------------------- the "did not download" report

/**
 * What the report's `listing` section reads of a series' fresh list (3.0.1, `lib/diagnosis`
 * `listingSection`): the pages its listing asked for, the gap filling's among them, TikTok's count,
 * the items received, the numbers still missing, the early end, the items DramaFetch could not read
 * and the warnings — copies, never the list's raw items or a URL with its query.
 * @param {Series} series
 * @returns {import("../lib/diagnosis.js").ListingInput}
 */
function listingInput(series) {
  return {
    endpoint: series.listing?.endpoint ?? null,
    pages: (series.listing?.pages ?? []).map((page) => ({ ...page, numbers: [...page.numbers] })),
    totalHint: series.totalHint,
    itemsReceived: series.itemsReceived ?? null,
    otherItems: listOtherItems(series),
    uncertain: listUncertain(series),
    episodesListed: series.episodes.length,
    missingNumbers: listMissing(series),
    earlyEnd: series.earlyEnd ?? null,
    skippedItems: (series.skippedItems ?? []).map((item) => ({ reason: item.reason, itemId: item.itemId })),
    warnings: [...series.warnings],
    incomplete: listIncomplete(series),
  };
}

/**
 * What the report reads of one series of the job: the run's rows with their episodes and traces,
 * the list's size and access counts when the series was listed, and how that list was read.
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
    listing: run.series === null ? null : listingInput(run.series), // how its list was read (3.0.1)
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
        guessedLock: isGuessedLocked(result), // 3.0.1: a free episode DramaFetch only guessed was locked
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
 * at least one episode failed or (3.0.1) a drama's list itself was short (`diagnosis.hasFailures`,
 * the report's `listing` section saying how the list was read), and saved at once under
 * `DramaFetch/reports/` when the `report` setting is on. A listing, a job that produced no run (it
 * threw before, or the cooldown refused it) or a job in which nothing failed leaves no report. The report before it goes first, its
 * `Report saved: …` line too (an automatic retry's start keeps them on screen,
 * {@link startProgress}). Never throws: the save must not break the job's end. (Exported for the
 * unit tests, which cannot run a job.)
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
  hideReportLine();
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
    console.warn(error);
    showReportOutcome(t("reportNotSaved", [oneLine(error)]), true); // the block shows the reason, row or none
  }
  showFailedBlock(); // the report's line and Save the report, with no row too (D9)
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

/** `#failed-report`, the line of the last report saved (or not), hidden and emptied ({@link showFailedBlock}). */
function hideReportLine() {
  const line = $("failed-report");
  line.hidden = true;
  line.textContent = "";
  showFailedBlock();
}

/**
 * `#failed-report` says `text` — shown with its block, a row under it or none ({@link showFailedBlock}).
 * @param {string} text
 * @param {boolean} failed
 */
function showReportOutcome(text, failed) {
  const line = $("failed-report");
  line.hidden = false;
  line.className = failed ? "meta error" : "meta";
  line.textContent = text;
  showFailedBlock();
}

// --------------------------------------------------------------- the Waiting card (2.0.0)

/**
 * @typedef {"download" | "retry" | "autoretry" | "selected" | "available" | "load" | "favorites"} QueueRowKind
 *
 * @typedef {object} QueueRow One row of the Waiting card (DramaFetch 2.0.0, the owner's request of
 *   2026-11-22: “the queue of pending downloads shows each drama's name and whole ID number”).
 * @property {QueueRowKind} kind what the row is: a drama a batch downloads whole (a paste, Enter, a
 *   card's **Download**, **Download selected dramas**, a hand-over), a **Retry**, an automatic retry,
 *   **Download selected** / **Download all available** of **See episodes**, a **See episodes**
 *   listing, the listing of the favorites (**Update from TikTok**)
 * @property {string | null} seriesId the drama's whole series id; null for the favorites' listing
 * @property {string | null} name the drama's name when DramaFetch knows it without asking TikTok
 *   ({@link queueName}), else null
 * @property {number[]} numbers the episodes a retry or **Download selected** asks for (none for the
 *   other kinds)
 */

/**
 * The names this page's own work read of dramas — a list a run of this page read (`onStart`), the
 * list **See episodes** shows, the records a retry was made from —, by series id: what the Waiting
 * card names a drama by, beside the library and the stored records ({@link queueName}). Never
 * asked of TikTok.
 * @type {Map<string, string>}
 */
const learnedNames = new Map();
/**
 * The names the stored records (`series:<id>`'s `series_name`) give the dramas of the Waiting card
 * that nothing else names, each looked up once ({@link lookUpStoredNames}); null: none.
 * @type {Map<string, string | null>}
 */
const storedNames = new Map();
/** @type {Set<string>} the dramas whose stored records the Waiting card waits for */
const namesWanted = new Set();
/** whether a look at the stored records is under way ({@link lookUpStoredNames}) */
let namesLooking = false;
/** what the Waiting card shows now — its rows as JSON —: nothing is drawn again for the same rows */
let queueShown = "";

/**
 * A name as the Waiting card may show it: none for nothing, an empty name, the drama's own id or
 * the folder name the engine falls back to (`series-<id>`, `naming.displayName`).
 * @param {unknown} name
 * @param {string} seriesId
 * @returns {string | null}
 */
function realName(name, seriesId) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed === "" || trimmed === seriesId || trimmed === displayName(null, seriesId) ? null : trimmed;
}

/**
 * Remember the name this page's own work read of a drama ({@link learnedNames}), and draw the
 * Waiting card again when it names a drama there now.
 * @param {string} seriesId
 * @param {unknown} name
 */
function rememberName(seriesId, name) {
  const real = realName(name, seriesId);
  if (real === null || learnedNames.get(seriesId) === real) return;
  learnedNames.set(seriesId, real);
  renderQueue();
}

/**
 * The name of a drama as the Waiting card shows it, known WITHOUT asking TikTok: the job's own —
 * a retry's as its records had it, the list **See episodes** showed —, else the name a run of
 * this page read, else the library's title, else the stored records' (looked up once,
 * {@link lookUpStoredNames}); null while none is known.
 * @param {string} seriesId
 * @param {Job} job
 * @returns {string | null}
 */
function queueName(seriesId, job) {
  const own = job.kind === "selection" ? (job.autoRetry?.name ?? job.series?.name) : null;
  return (
    realName(own, seriesId) ??
    learnedNames.get(seriesId) ??
    realName(app.favorites?.items.find((item) => item.seriesId === seriesId)?.title, seriesId) ??
    storedNames.get(seriesId) ??
    null
  );
}

/**
 * The rows of one waiting job: a batch's, one per drama, in its order; any other job's, one.
 * @param {Job} job
 * @param {readonly SeriesRef[]} [refs] a batch's dramas still to run (all of them by default)
 * @returns {QueueRow[]}
 */
function rowsOf(job, refs = job.refs) {
  if (job.kind === "favorites") return [{ kind: "favorites", seriesId: null, name: null, numbers: [] }];
  if (job.kind === "batch") return refs.map((ref) => ({ kind: "download", seriesId: ref.seriesId, name: queueName(ref.seriesId, job), numbers: [] }));
  const ref = job.refs[0];
  if (ref === undefined) return [];
  /** @type {QueueRowKind} */
  const kind =
    job.kind === "load"
      ? "load"
      : job.autoRetry !== undefined
        ? "autoretry"
        : job.pick === "available"
          ? "available"
          : job.pick === "selected"
            ? "selected"
            : "retry";
  const numbers = kind === "retry" || kind === "autoretry" || kind === "selected" ? [...job.numbers] : [];
  return [{ kind, seriesId: ref.seriesId, name: queueName(ref.seriesId, job), numbers }];
}

/**
 * The Waiting card's rows (DramaFetch 2.0.0): one per drama still to run, in the order they will
 * run — the dramas of the running batch it has not begun yet (its record's `begun`: the drama
 * whose list has not come yet, after its rest, is still to run), then every waiting job's. A
 * download row is a drama by its name, when DramaFetch knows it without asking TikTok
 * ({@link queueName}), and its whole series id; the other rows say what they are — a **Retry** of
 * E02, E07, an automatic retry, **Download selected** of some episodes, **Download all available**,
 * **See episodes**, **Update from TikTok** (no drama). No request is made to learn a name.
 * (Exported for the unit tests.)
 * @returns {QueueRow[]}
 */
export function queueRows() {
  /** @type {QueueRow[]} */
  const rows = [];
  const running = app.running;
  if (running !== null && running.kind === "batch") rows.push(...rowsOf(running, running.refs.slice(app.runningRecord?.begun ?? 0)));
  for (const job of app.queue) rows.push(...rowsOf(job));
  return rows;
}

/**
 * What a row of the Waiting card says it is, before its drama: none for a drama a batch downloads
 * whole.
 * @param {QueueRow} row
 * @returns {string | null}
 */
function queueWhat(row) {
  const episodes = namedEpisodes(row.numbers);
  switch (row.kind) {
    case "retry":
      return t("queueRetry", [episodes]);
    case "autoretry":
      return t("queueAutoRetry", [episodes]);
    case "selected":
      return t("queueSelected", [episodes]);
    case "available":
      return t("queueAvailable");
    case "load":
      return t("queueSeeEpisodes");
    case "favorites":
      return t("queueFavorites");
    default:
      return null;
  }
}

/**
 * One row of the Waiting card: what it is (`.queue-what`), then its drama — its name
 * (`.queue-name`) and its whole id (`.queue-id`: every digit, never cut, one click selects it to
 * copy), or the id and, muted, `name shown once its list is read` (`.queue-note`). Plain text
 * only.
 * @param {QueueRow} row
 * @returns {HTMLElement}
 */
function queueRowElement(row) {
  /** @type {HTMLElement[]} */
  const parts = [];
  const what = queueWhat(row);
  if (what !== null) parts.push(el("span", { className: "queue-what", text: what }));
  if (row.seriesId !== null) {
    if (what !== null) parts.push(el("span", { className: "queue-sep", text: " — " }));
    if (row.name !== null) parts.push(el("span", { className: "queue-name", text: row.name }), el("span", { className: "queue-sep", text: " · " }));
    parts.push(el("span", { className: "queue-id", text: row.seriesId, title: t("queueIdTitle") }));
    if (row.name === null) parts.push(el("span", { className: "queue-sep", text: " · " }), el("span", { className: "queue-note", text: t("queueNameUnknown") }));
  }
  /** @type {Record<string, string>} */
  const attrs = { "data-kind": row.kind };
  if (row.seriesId !== null) attrs["data-series-id"] = row.seriesId;
  return el("li", { className: `queue-row ${row.kind}`, attrs }, parts);
}

/**
 * Draw the Waiting card ({@link queueRows}) — when a job is queued, starts or ends, when a batch's
 * drama starts, when a name becomes known —, hidden while nothing waits. The same rows are not
 * drawn again (an id the user is selecting stays selected). The dramas no name is known for are
 * looked up in the stored records ({@link wantStoredNames}).
 */
function renderQueue() {
  const rows = queueRows();
  const shownNow = JSON.stringify(rows);
  if (shownNow !== queueShown) {
    queueShown = shownNow;
    $("queue-list").replaceChildren(...rows.map(queueRowElement));
  }
  $("queue-card").hidden = rows.length === 0;
  wantStoredNames(rows.filter((row) => row.name === null && row.seriesId !== null).map((row) => /** @type {string} */ (row.seriesId)));
}

/**
 * Look up the stored records of `seriesIds` — those not looked up yet — for their names, after
 * the current turn (one read for every drama the Waiting card asked for meanwhile): the storage
 * only, nothing is asked of TikTok.
 * @param {readonly string[]} seriesIds
 */
function wantStoredNames(seriesIds) {
  for (const seriesId of seriesIds) if (!storedNames.has(seriesId)) namesWanted.add(seriesId);
  if (namesWanted.size === 0 || namesLooking) return;
  namesLooking = true;
  void Promise.resolve().then(lookUpStoredNames);
}

/**
 * The stored records' names of the dramas the Waiting card waits for ({@link namesWanted}), each
 * read once — a record without a name, or a read the storage refuses, counts as looked up: no
 * second read —; the card drawn again when one names a drama. Never throws.
 * @returns {Promise<void>}
 */
async function lookUpStoredNames() {
  try {
    while (namesWanted.size > 0) {
      const seriesIds = [...namesWanted];
      namesWanted.clear();
      /** @type {Map<string, unknown>} */
      let states = new Map();
      try {
        states = await readSeriesStates(seriesIds);
      } catch {
        // refused: those dramas stay named by their ids — a name is never worth a second read
      }
      let named = false;
      for (const seriesId of seriesIds) {
        const name = realName(readState(states.get(seriesId), seriesId)?.series_name, seriesId);
        storedNames.set(seriesId, name);
        named ||= name !== null;
      }
      if (named) renderQueue();
    }
  } catch (error) {
    console.warn(error);
  } finally {
    namesLooking = false;
  }
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
  renderQueue(); // the Waiting card: each drama still to run
  renderLibrary(); // the library's cards: queued, downloading
  updateButtons();
  // never discarded while a job runs or waits; discardable again once the queue is done (a Stop
  // and an error end the job too). Only the engine's tab ever runs one: a read-only tab stays
  // discardable.
  void keeper.keep(app.tabId, app.owner && (running || app.queue.length > 0));
}

/**
 * Queue a job — in the engine's tab only: a read-only tab could never run it —, at the end of the
 * queue (FIFO). Returns whether it was queued.
 * @param {Omit<Job, "id">} job
 * @returns {boolean}
 */
function enqueue(job) {
  if (!app.owner) return false;
  if (app.unsaved !== null) {
    // the page cannot store anything any more: a job would only be refused, after clearing the
    // last one's results (the popup's "Download this series" and the retry buttons come here too)
    void showStorageRefused();
    return false;
  }
  app.queue.push({ ...job, id: app.nextJobId++ });
  renderAppStatus();
  void pump();
  return true;
}

/**
 * The job running and the jobs waiting, in order, as they were queued — what the unit tests read of
 * the queue. (Exported for the unit tests, which cannot see it otherwise.)
 * @returns {Job[]}
 */
export function queuedJobs() {
  return [...(app.running === null ? [] : [app.running]), ...app.queue].map((job) => ({ ...job, refs: [...job.refs] }));
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
  app.runningRecord = null; // none begun yet: a batch's dramas all wait (its engine gives its record)
  app.runningDone = false;
  app.stopRequested = false;
  library.running = null;
  library.again = null;
  library.finished.clear();
  renderAppStatus();
  try {
    await covers.idle(); // a thumbnail request in flight ends first: one request at a time
    await libraryCovers.idle();
    await runJob(job);
  } finally {
    // Stop pressed during the job's very end, after its own end said what it took out: said now
    if (app.droppedRetries.length > 0) sayDroppedRetries(job.label);
    app.running = null;
    app.runningRecord = null;
    app.runningDone = false;
    app.finished += 1;
    app.stopRequested = false;
    library.running = null;
    library.again = null;
    library.finished.clear();
    // the library's cards of what the job downloaded read the records again
    if (job.kind === "batch" || job.kind === "selection") void refreshLibraryProgress(job.refs.map((ref) => ref.seriesId));
    void updateLibrarySource();
    renderAppStatus();
    void refreshCooldown();
    void pump();
  }
}

/**
 * The journal of finished jobs — kept ONLY in the test harness' copy of the extension
 * (`app.testMode`), in place of the history of past runs DramaFetch 2.0.0 took away: one entry per
 * job that ended, and per job a stop took out of the queue (`not started: …`), the most recent
 * first, in the shape the history's entries had — `kind`, `label`, `started_at`, `finished_at`,
 * `error`, `stopped`, `refreshes`, `pauses`, `series` (every series' record, its rows included:
 * {@link runRecord}), and a listing's `favorites` / `favorites_skipped` —,
 * copied as JSON. In this page's memory only: never stored, never shown, gone with the page. The
 * end-to-end harness reads it with `page.evaluate` (`globalThis.dramafetchJournal`, set by
 * {@link setupTestMode}), the unit tests through {@link journal}. Outside test mode nothing records
 * jobs.
 * @type {Record<string, unknown>[]}
 */
const testJournal = [];

/**
 * A job that ended — or one that never started — in the test journal ({@link testJournal}), as a
 * JSON copy; nothing at all outside test mode.
 * @param {Record<string, unknown>} entry
 */
function noteJob(entry) {
  if (!app.testMode) return;
  testJournal.unshift(/** @type {Record<string, unknown>} */ (JSON.parse(JSON.stringify(entry))));
}

/**
 * The test journal of this page, the most recent job first — always empty outside test mode
 * ({@link testJournal}): a copy, so a reader changes nothing in it. (Exported for the unit tests.)
 * @returns {Record<string, unknown>[]}
 */
export function journal() {
  return testJournal.map((entry) => /** @type {Record<string, unknown>} */ (JSON.parse(JSON.stringify(entry))));
}

/**
 * The record of a queued job that never started, for the test journal ({@link noteJob}): `error`
 * says why (`not started: …`).
 * @param {Job} job
 * @param {string} error
 * @returns {Record<string, unknown>}
 */
function notStartedEntry(job, error) {
  const at = new Date().toISOString();
  return { id: Date.now(), kind: job.kind, label: job.label, started_at: at, finished_at: at, error, stopped: null, refreshes: 0, pauses: [], series: [] };
}

/**
 * Every queued job ends without a request (`not started: …` in the test journal).
 * @param {string} reason
 * @returns {Job[]} the jobs it took out of the queue
 */
function cancelQueue(reason) {
  const cancelled = app.queue.splice(0);
  for (const job of cancelled) noteJob(notStartedEntry(job, reason));
  return cancelled;
}

/**
 * **Stop** pressed (DramaFetch 1.8.0): DramaFetch's own automatic retries waiting in the queue come
 * out of it at once — none ever starts after a Stop (DramaFetch/CLAUDE.md → Pacing), not even when
 * the job running does not stop: the engine looks at Stop between two episodes and in its pauses,
 * so one pressed while the job's last episode downloads, or during its end, ends no run (the jobs
 * the user queued then start, as before; a Stop the engine meets takes them out too,
 * {@link cancelQueue}). The **Did not download** block's line that said they would be retried goes
 * now — drawn at the end of the job that queued them, or kept with its block while the first of
 * them runs ({@link startProgress}, which empties {@link app}.failedAuto then: every automatic retry
 * still waiting is that block's job's, and its line counted it) —; what is said of them — as of any
 * job a stop took out of the queue — waits for the running job's end ({@link sayDroppedRetries}),
 * so that an alert's **Retry** pressed then is never taken out by that same Stop. A drama whose
 * automatic retry was not queued yet gets none ({@link queueAutoRetry}).
 */
function dropAutoRetries() {
  const dropped = app.queue.filter((waiting) => waiting.autoRetry !== undefined);
  if (dropped.length === 0) return;
  for (let index = app.queue.length - 1; index >= 0; index -= 1) if (app.queue[index]?.autoRetry !== undefined) app.queue.splice(index, 1);
  app.droppedRetries.push(...dropped);
  renderAppStatus();
  dropFailedAutoLine(); // every one of them is out of the queue: the line that counted them goes
}

/**
 * The **Did not download** block's line that said how many of its episodes will be retried
 * automatically goes, and what it counted ({@link app}.failedAuto): every one of those retries left
 * the queue (**Stop**, {@link dropAutoRetries}). The block itself stays.
 */
function dropFailedAutoLine() {
  const line = $("failed-auto");
  if (app.failedAuto.size > 0 || !line.hidden) {
    app.failedAuto = new Set();
    line.hidden = true;
    line.textContent = "";
  }
}

/**
 * The automatic retries **Stop** took out of the queue ({@link dropAutoRetries}), said at the end of
 * the job that ran then, `where` its label: each one's drama gets the ⚠ alert WITH its **Retry**,
 * `Not retried automatically: stopped by you` ({@link alertNotRetried}) — and, in test mode, its
 * journal entry is any cancelled job's (`not started: batch stopped in <where> (stopped by you)`).
 * @param {string} where
 */
function sayDroppedRetries(where) {
  const reason = new StopRequested().message; // `stopped by you`: in English, like every engine text
  for (const job of app.droppedRetries.splice(0)) {
    noteJob(notStartedEntry(job, `not started: batch stopped in ${where} (${reason})`));
    alertNotRetried(job, reason);
  }
}

/**
 * The automatic retries `jobRecord`'s job queued for its dramas that still wait at its end — what
 * its **Did not download** block says will be retried ({@link renderFailed}) —, never another
 * job's. (Exported for the unit tests, which cannot run a job to its end with one waiting.)
 * @param {Pick<JobRecord, "autoRetried">} jobRecord
 * @returns {Job[]}
 */
export function waitingAutoRetries(jobRecord) {
  const queuedHere = new Set(jobRecord.autoRetried ?? []);
  return app.queue.filter((waiting) => waiting.autoRetry !== undefined && queuedHere.has(waiting.autoRetry.alertId));
}

/**
 * One row of a series' record ({@link runRecord}): the result's episode number, status, message,
 * file and download id — and (3.0.1) `guessed: true` on the row of a free episode DramaFetch only
 * guessed was locked: not downloaded ({@link notDownloaded}).
 * @param {DownloadResult} result
 * @returns {Record<string, unknown>}
 */
function rowRecord(result) {
  /** @type {Record<string, unknown>} */
  const row = {
    number: result.episode.number,
    status: result.status,
    message: result.message,
    path: result.path ?? null,
    download_id: result.downloadId ?? null,
  };
  if (isGuessedLocked(result)) row["guessed"] = true;
  return row;
}

/**
 * The per-series records of a download job **Stop** ended inside its engine — `runBatch` or the
 * selection's run threw `StopRequested`, so no run came back (3.0.1, the lead's D11: Stop keeps the
 * **Did not download** block true): a batch's dramas it finished, each one's whole record as it was
 * done ({@link JobRecord}.records) — their rows enter the block, as any finished drama's —, and of
 * the drama it was in ({@link JobRecord}.current) a record of the rows it had: a selection job's
 * every row (the episodes it saved leave the block, one that failed again keeps its row with its
 * new message, and the ones it never reached keep theirs), a batch's only the rows of episodes now
 * on disk (they leave the block; the drama Stop interrupted gets no new row — a run Stop cuts short
 * keeps none, as ever). (Exported for the unit tests, which cannot run a job to a Stop.)
 * @param {Pick<Job, "kind" | "overwrite">} job
 * @param {Pick<JobRecord, "records" | "current">} jobRecord
 * @returns {Record<string, unknown>[]}
 */
export function stoppedRecords(job, jobRecord) {
  const records = [...(jobRecord.records ?? [])];
  const current = jobRecord.current;
  if (current === undefined) return records;
  const rows = job.kind === "selection" ? current.rows : current.rows.filter((row) => row["status"] === DONE || row["status"] === SKIPPED_EXISTS);
  if (rows.length === 0) return records;
  /** @type {Record<string, unknown>} */
  const record = { series_id: current.seriesId, name: current.name, rows: [...rows] };
  if (job.overwrite === true) record["overwrite"] = true;
  records.push(record);
  return records;
}

/**
 * A series' record of a job, kept in memory while the job ends: what the retries
 * ({@link retryTargets}), the alerts, the automatic retry, the **Did not download** block and — in
 * test mode — the journal read of the drama's run (3.0.1: its list's warnings too, and `guessed:
 * true` on the row of a free episode DramaFetch only guessed was locked: {@link rowRecord}). `overwrite`: the
 * job downloaded every episode again in full ({@link Job}.overwrite, DramaFetch 3.0.0) — the record
 * says `overwrite: true`, and every retry read from it does the same; absent otherwise. (Exported
 * for the unit tests, which build the records a job's end reads with it.)
 * @param {SeriesRun} run
 * @param {boolean} [overwrite]
 * @returns {Record<string, unknown>}
 */
export function runRecord(run, overwrite = false) {
  /** @type {Record<string, unknown>} */
  const record = {
    series_id: run.ref.seriesId,
    name: run.report.name || run.series?.name || null,
    status: batchStatus({ ...run, errorKind: run.errorKind }),
    error: run.error,
    error_kind: run.errorKind,
    stop: run.stop,
    contacted: run.contacted,
    line: reportLine(run.report),
    report: reportToDict(run.report),
    warnings: [...(run.series?.warnings ?? [])], // 3.0.1: the list's, as the progress card showed them
    rows: run.results.map(rowRecord), // 3.0.1: a free episode DramaFetch only guessed was locked says so (`guessed`)
  };
  if (overwrite) record["overwrite"] = true;
  return record;
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
  /** @type {Series | null} a selection job's fresh list of its series, listed for this job */
  let fresh = null;
  /** whether a selection job's drama had its alert (an automatic retry's: what came of it) */
  let told = false;
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
    } else if (job.kind === "batch") {
      const lastContactAt = app.lastContactAt; // the previous job's: this one's own come later
      runs = await runBatch(engine, job.refs, {
        beforeFirstNetwork: () => restBetweenJobs(engine, { lastContactAt, batchJob: true }),
      });
      entry["series"] = runs.map((run) => runRecord(run));
      renderBatchTable(runs);
      stopping = runs.find((run) => run.stop) ?? null;
      if (stopping !== null) stop = stopping.report.stopped || stopping.error || "stopped";
    } else {
      // never the list shown (an earlier job's): listed again, for the session logged in now
      const run = await runSelectionJob(engine, /** @type {SeriesRef} */ (job.refs[0]), job.numbers, {
        lastContactAt: app.lastContactAt,
      });
      fresh = run.series;
      runs = [run];
      renderReportLine(run);
      renderBatchTable([run]);
      entry["series"] = [runRecord(run, job.overwrite === true)]; // See episodes' downloads again: the record says so
      dramaDone(job, run, jobRecord); // its rows are stored: its automatic retry when due, its notification, now
      // refused before any request: no alert of its own; an automatic retry whose fresh list never
      // came (3.0.1): its ⚠ alert, with its Retry, below
      told = !autoRetryUnlisted(job, run) && (run.contacted || run.results.length > 0);
      if (run.stop) {
        stopping = run;
        stop = run.report.stopped || run.error || "stopped";
      }
    }
    entry["refreshes"] = engine.downloader.refreshes;
    await redrawListed(job, fresh, runs, engine.view);
  } catch (error) {
    if (error instanceof StopRequested) {
      entry["error"] = stop = error.message; // in English, like every engine text
      // 3.0.1 (D11): what ran before the Stop — the dramas a batch finished, what the drama it was
      // in saved, a selection's rows — keeps the Did not download block true
      if (job.kind === "batch" || job.kind === "selection") entry["series"] = stoppedRecords(job, jobRecord);
    } else {
      entry["error"] = stop = oneLine(error);
      setStatus($("input-status"), shownText(stop), "error");
    }
  } finally {
    app.runningDone = true; // it asks for none of its episodes any more: a Retry pressed now queues behind it
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
    sayDroppedRetries(job.label); // the automatic retries a Stop pressed meanwhile took out of the queue
    /** @type {Job[]} */
    let cancelled = [];
    if (stopping !== null) cancelled = cancelQueue(notStartedMessage(stopping));
    else if (stop !== null) cancelled = cancelQueue(`not started: batch stopped in ${job.label} (${stop})`);
    if (stop !== null) {
      // an automatic retry without its drama's alert — this one, refused at its gate or ended by
      // Stop or an error before that alert (it never ran when it asked TikTok for nothing; else
      // what it saved is not named), and those the stop took out of the queue —: each drama's ⚠
      // alert with its Retry, in place of "retrying"
      if (job.autoRetry !== undefined && !told) alertNotRetried(job, stop, job.contacted === true ? (jobRecord.saved ?? []) : null);
      for (const waiting of cancelled) if (waiting.autoRetry !== undefined) alertNotRetried(waiting, stop);
    }
    // the dramas a stop left unstarted, said once — an automatic retry's said above, never counted
    alertJobEnd(job, stop, runs, jobRecord, cancelled.filter((waiting) => waiting.autoRetry === undefined));
    noteJob(entry); // the test journal (test mode only: nothing records jobs otherwise)
    $("progress-activity").textContent = "";
    // what did not download, apart, with its retry — and the automatic retries of it still waiting
    renderFailed(Array.isArray(entry["series"]) ? entry["series"] : [], waitingAutoRetries(jobRecord));
    // and the report of it
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
 * After a download job that ran its course — done, or stopped by a refusal its runs report (a 429,
 * a captcha, three failures) —, the episode list (**See episodes**) drawn again: a selection job's
 * fresh list of its series (listed again for this job: the list the page then acts on), else, when
 * the list on screen is a series the job downloaded, the batch's own fresh list of it (listed right
 * before its downloads: what TikTok lists now, for the session logged in now), or the list on
 * screen when the batch did not list it (found complete) — its "on disk" badges, its counts and
 * the DRM verdicts the job recorded, which **Download all available** then leaves out. A job stopped
 * by hand (**Stop**) or ended by an error is not: the list stays as the user left it, ticks
 * included, and the stop is not held up by Chrome's download history (its file checks can wait
 * seconds); the next listing of the drama, or the next job that ends on it, draws it again. A
 * failure here never fails the job.
 * @param {Job} job
 * @param {Series | null} fresh
 * @param {SeriesRun[] | null} runs
 * @param {DownloadsView} view
 */
async function redrawListed(job, fresh, runs, view) {
  if (job.kind !== "batch" && job.kind !== "selection") return;
  const listed = app.loaded;
  const onScreen = listed !== null && job.refs.some((ref) => ref.seriesId === listed.series.seriesId) ? listed.series : null;
  const listedAgain = onScreen === null ? null : ((runs ?? []).find((run) => run.series?.seriesId === onScreen.seriesId)?.series ?? null);
  const series = fresh ?? listedAgain ?? onScreen;
  if (series === null) return;
  try {
    await renderSeries(series, view);
  } catch {
    // the list stays as it was drawn; the job's end is said and stored already
  }
}

/**
 * A listing job — **See episodes** on a drama of the library: list one series (no download) and
 * show its episodes, a job like any other: the rest between jobs first (no long break: a listing
 * alone is no download attempt), the cooldown asked again after it. Returns why the job stopped (a
 * cooldown met meanwhile, a write that could not be stored), or null. (Exported for the unit tests,
 * which cannot run a job.)
 * @param {Job} job
 * @param {Engine} engine
 * @param {Record<string, unknown>} entry
 * @returns {Promise<string | null>}
 */
export async function runLoad(job, engine, entry) {
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
 * and cleared by **Download selected** of the dramas it queues, those only ({@link onLibraryDownload});
 * a card's own **Download** leaves them alone ({@link onLibraryDownloadOne}).
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
   * it (seconds since the epoch): the smart refresh's one-page shortcut trusts those counts for
   * 24 h after it (`lib/library.countsFresh`); a first page read since changes it not
   */
  fullReadAt: null,
  /** @type {Map<string, Progress>} what DramaFetch's own records say of each drama (`lib/library.progressOf`) */
  progress: new Map(),
  /** @type {string | null} the series the running job is downloading now */
  running: null,
  /**
   * @type {Set<number> | null} while the running job downloads `running` again in full (**See
   * episodes**' `overwrite` job, 3.0.0), the episodes it has still to save anew: its card counts
   * their earlier downloads, which the records still hold, only once this job saved them again, so
   * **Downloading · saved/total** follows the job (`lib/library.progressOf`); null otherwise
   */
  again: null,
  /** @type {Set<string>} the series the running job has finished */
  finished: new Set(),
  /** how many of the matching dramas the grid shows: pieces of `LIBRARY_PIECE` */
  shown: LIBRARY_PIECE,
  /** whether a write of the library `chrome.storage.local` refused was said already (once a page) */
  saveRefusedSaid: false,
  /** @type {{tabId: number, url: string, profile: string | null} | null} a TikTok tab with a favorites address, as last looked ({@link findFavoritesTab}) */
  source: null,
  /** when the connection line was drawn last (seconds) */
  drawnAt: 0,
  /** when the TikTok tabs were looked at last (seconds) */
  lookedAt: 0,
};

/**
 * The grid's cards as drawn last, by series id: the drama, its card, its tick, the buttons that
 * would start a job (disabled when no job may start: `updateButtons`) and its **Download** (also
 * disabled while the drama is queued or downloading).
 * @type {Map<string, {item: FavoriteItem, article: HTMLElement, box: HTMLInputElement, cover: HTMLElement, actions: HTMLButtonElement[], download: HTMLButtonElement}>}
 */
const libraryCards = new Map();

/** @returns {FavoriteItem[]} the library's dramas, each once, in the list's order */
function libraryItems() {
  return app.favorites === null ? [] : distinctItems(app.favorites.items);
}

/** @returns {number} how many dramas the library holds */
function libraryCount() {
  return libraryItems().length;
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
 * the list before its end (`favorites.cutShort`) the page says so, and the job's record keeps it —
 * TikTok refused nothing, so it is no stop. The status line and the job's record count what the
 * listing listed ({@link listedOf}); when a library that held dramas came back as it was, the status
 * line says so (`libraryKept`, `libraryKeptEmpty`: an error, no stop) and the record keeps why. Returns
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
      noteListed(entry, job); // the record keeps how many were listed before the Stop
      throw error;
    }
    return favoritesFailed(error, entry);
  }
  noteListed(entry, job);
  const { listing } = read;
  if (read.unchanged) {
    // the library is TikTok's list as it is: one request, and its count TikTok's
    setStatus($("input-status"), t("libraryUnchanged", [listing.total ?? libraryCount()]), "ok");
    return null;
  }
  if (!read.shown) {
    // a library that held dramas came back as it was — not TikTok's whole list ({@link fetchFavorites}):
    // the page says so, an error; TikTok refused nothing, so no stop. The record keeps why: TikTok
    // cutting the list short, as before, else this text
    const text = listing.items.length + listing.skipped === 0 ? t("libraryKeptEmpty") : t("libraryKept", [listedOf(job).count]);
    setStatus($("input-status"), text, "error");
    entry["error"] = cutShort(listing) ? t("favoritesCutShort", [listedOf(job).count]) : text;
    return null;
  }
  if (cutShort(listing)) {
    // TikTok sent no more than this: said, and kept in the record — it refused nothing, so no stop
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
  return job.listed ?? { count: libraryCount(), skipped: app.favorites?.skipped ?? 0 };
}

/**
 * A favorites listing's record (its test journal entry): how many dramas it listed, and — when some
 * were — how many of the list's items it left out for want of a readable series id ({@link listedOf}).
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
 * Read TikTok tab `tabId`'s favorites list (`favorites.listFavorites`: from inside that tab, from
 * its top, paced, one request at a time, the cooldown before every page, a refusal recorded) — all
 * of it (**List favorites**, into the library as pages arrive).
 * **List favorites** over a library read from this TikTok profile, its whole list read less than
 * 24 h ago (`lib/library.countsFresh`: the episode counts it holds), is the smart refresh: its
 * first page decides (`lib/library.unchangedSince`) — the list as it was, and the listing stops
 * there (one request: the library keeps its dramas and takes TikTok's count), else it reads on. A
 * library that shows a list keeps showing it until the listing's first page arrives (a refusal
 * before it leaves it as it was). What a listing that filled
 * the library read becomes the library kept across sessions (`favoritesLibrary`, with the profile
 * recorded with `template`: whose list it is) only when it may ({@link adoptable}): over a library
 * that held dramas, TikTok's whole list alone ({@link readWhole}) — with a drama, or with TikTok
 * counting none —; over one that held none, a drama at least (the list complete or not), or
 * TikTok's whole list counting none. A listing that stops short of that never shrinks a library that
 * held dramas — a refusal, a login wall, the tab gone or **Stop** on a later page, TikTok cutting
 * the list short, an empty first page (TikTok may answer a replay it no longer accepts so,
 * `favorites.js`) —: the library comes back as it was ({@link restoreKeptLibrary}), taking only what
 * the listing read of the library's own profile — TikTok's count, and the fresh entries of the dramas
 * it read —; over a library that held none, what was read stays shown, not kept. The job's contact
 * with TikTok is noted at both ends, as a listing's; nothing is asked when this page could not store
 * a write.
 * @param {Job} job
 * @param {Engine} engine
 * @param {number} tabId
 * @param {FavoritesAddress} template the tab's favorites address, and whose list it reads: the
 *   profile the library takes, never the page the tab shows by the listing's end
 * @returns {Promise<{listing: FavoritesListing, shown: boolean, unchanged: boolean}>} the listing,
 *   whether the library shows it, and whether its first page found the library unchanged
 */
async function fetchFavorites(job, engine, tabId, template) {
  await noteContact(job);
  if (app.unsaved !== null) throw new StorageRefusedError(app.unsaved); // that save refused: not one request
  const test = app.testMode ? app.testSettings : {};
  const before = app.favorites;
  const empty = before === null || before.items.length === 0;
  // a library that holds dramas, as it is before any request: what comes back unless the listing
  // that fills it ends as TikTok's whole list (the listing puts a new object in `app.favorites`)
  /** @type {LibrarySnapshot | null} */
  const snapshot = before !== null && !empty ? { favorites: before, shown: library.shown } : null;
  job.listed = undefined; // what THIS listing lists
  // the smart refresh: a library read from this TikTok profile may be TikTok's list as it is — while
  // its episode counts are fresh: a series that gained episodes moves neither TikTok's count nor its first page
  const { profile } = template;
  const smart = !empty && library.profile !== null && countsFresh(library.fullReadAt, now()) && profile === library.profile;
  const kept = smart ? libraryItems().map((item) => item.seriesId) : [];
  let unchanged = false;
  let started = false;
  let filled = 0;
  /** @type {import("./favorites.js").FavoritesOptions} */
  const options = {
    onPage: (listing, page) => {
      if (smart && listing.pages === 1) unchanged = unchangedSince(kept, page.items.map((item) => item.seriesId), listing.total);
      if (unchanged) {
        showListingProgress(listing); // the library stays as it was
        return;
      }
      if (!started) {
        started = true;
        startFavorites();
      }
      filled += 1;
      job.listed = { count: distinctItems(listing.items).length, skipped: listing.skipped };
      showFavoritesPage(listing);
    },
  };
  if (test.pageDelayS !== undefined) options.pageDelayS = test.pageDelayS;
  if (test.discoveryTimeoutS !== undefined) options.timeoutS = test.discoveryTimeoutS;
  if (smart) options.until = () => unchanged;
  if (empty) {
    started = true; // an empty library shows the listing from its start, as 1.5.0's panel did
    startFavorites();
  }
  /** @type {FavoritesListing | null} */
  let listing = null;
  let shown = false;
  try {
    listing = await listFavorites(engine, tabId, template.url, options);
    if (unchanged) {
      await keepLibrary(listing);
      return { listing, shown: true, unchanged: true };
    }
  } finally {
    // a listing that filled the library: kept, or the library as it was — on every path, errors and Stop included
    if (started) shown = await endListing(tabId, listing, filled, snapshot, profile);
    await noteContact(job);
  }
  return { listing, shown, unchanged: false };
}

/**
 * A listing that filled the library ended ({@link fetchFavorites}) — at TikTok's end, or before it
 * (the page cap, TikTok cutting the list short, an error, **Stop**):
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
 * missing (`favorites.cutShort` says the opposite). The page cap never counts; an empty answer
 * with TikTok counting none is whole only at the list's end.
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
 * ({@link adoptable}): the library comes back as it was — its dramas and their order, how many
 * cards the grid drew — and is not written again, but for what the listing read of the library's
 * own profile (another account's list and count are never this library's): every drama of the
 * library the listing read takes the listing's fresh entry (title, episodes, cover — an episode
 * count TikTok raised since the whole list was read is never put back), no drama added or
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
  library.shown = snapshot.shown;
  const listed = read === null ? [] : distinctItems(read.items);
  if (library.profile !== null && profile === library.profile) {
    const fresh = new Map(listed.map((item) => [item.seriesId, item]));
    const renewed = kept.items.some((item) => fresh.has(item.seriesId));
    if (renewed) kept.items = kept.items.map((item) => fresh.get(item.seriesId) ?? item);
    if (total !== null) {
      kept.total = total;
      library.countedAt = now();
    }
    if (renewed || total !== null) await saveLibrary();
  }
  renderLibrary();
  await refreshLibraryProgress(listed.map((item) => item.seriesId));
}

/**
 * Why a favorites listing ended without its list, said on the page and kept in the job's record:
 * TikTok's refusals, its login wall, a cooldown met and a refused write in
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
 * A listing of a TikTok tab's favorites takes the library's place: the library shows, emptied of
 * an earlier list's dramas (a new `app.favorites`: the one it replaces is left as it was, for a
 * listing that stops short of TikTok's end to put back,
 * {@link restoreKeptLibrary}); the ticks stay (another tab's list too: a card built for a ticked
 * drama shows ticked), until a complete listing that becomes the library prunes them
 * ({@link endFavorites}).
 */
function startFavorites() {
  app.favorites = { items: [], total: null, complete: false, ended: null, short: false, skipped: 0, loading: true, listedAt: now() };
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
  const added = distinctItems(listing.items)
    .map((item) => item.seriesId)
    .filter((seriesId) => !before.has(seriesId));
  renderLibrary();
  $("progress-activity").textContent = $("favorites-count").textContent ?? "";
  void refreshLibraryProgress(added);
}

/**
 * The listing ended — at the list's end, or before it (a limit, a refusal, **Stop**): the count says
 * how much the library holds. Only a listing of TikTok's whole
 * list ({@link readWhole}) that becomes the library (`prune`: {@link adoptable}) is the library's
 * whole list and prunes the ticks — a drama it does not hold is no favorite any more —; a partial
 * one may simply not have reached a ticked drama yet, and an empty one that is not kept (TikTok
 * counting dramas it did not send) says nothing of them.
 * @param {FavoritesListing | null} listing null when it ended without one (an error, a Stop)
 * @param {boolean} prune whether the listing becomes the library
 */
function endFavorites(listing, prune) {
  const shown = app.favorites;
  if (shown === null) return;
  shown.loading = false;
  shown.listedAt = now();
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
 * A smart refresh's first page that found the library unchanged says how far it read on the
 * progress card only: the library stays as it was.
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
 * TikTok's count as read, every drama's episode count as read when the listing reached
 * the list's end (`fullReadAt`, now; a partial list has none) —, the covers kept in the browser
 * session's memory, the library kept on disk without them (best effort).
 * @param {string | null} profile
 * @returns {Promise<void>}
 */
async function adoptListing(profile) {
  const listedAt = now();
  library.profile = profile;
  library.countedAt = listedAt;
  library.fullReadAt = app.favorites?.complete === true ? listedAt : null;
  await writeLibraryCovers(coversOf(libraryItems()));
  await saveLibrary();
  renderLibrary();
}

/**
 * The smart refresh's first page found the library unchanged (`lib/library.unchangedSince`): it is
 * TikTok's list as it is — the first page's own entries (title, episodes, cover) take their place,
 * TikTok's count — read now from the TikTok tab the listing went through — is the library's, and
 * the library is kept. When the whole list was last read
 * (`fullReadAt`) stays as it was: the other dramas' episode counts are that read's.
 * @param {FavoritesListing} listing the first page
 * @returns {Promise<void>}
 */
async function keepLibrary(listing) {
  const shown = app.favorites;
  if (shown === null) return;
  const fresh = new Map(listing.items.map((item) => [item.seriesId, item]));
  shown.items = shown.items.map((item) => fresh.get(item.seriesId) ?? item);
  shown.total = listing.total;
  shown.complete = true;
  shown.ended = null;
  shown.short = false;
  shown.loading = false;
  shown.listedAt = now();
  library.countedAt = now();
  const listed = new Set(shown.items.map((item) => item.seriesId));
  for (const seriesId of [...favoritesSelected]) if (!listed.has(seriesId)) favoritesSelected.delete(seriesId);
  await writeLibraryCovers(coversOf(libraryItems()));
  await saveLibrary();
  renderLibrary();
  void refreshLibraryProgress(listing.items.map((item) => item.seriesId));
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
  const record = libraryRecord({
    listedAt: shown.listedAt,
    total: shown.total,
    countedAt: library.countedAt,
    fullReadAt: library.fullReadAt,
    complete: shown.complete,
    short: shown.short,
    ended: shown.ended,
    profile: library.profile,
    items: shown.items,
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
 * with no TikTok tab, the covers from the browser session's memory — only those whose signature has not expired
 * (`lib/library.coverExpired`: an expired one would be refused; its card shows the title) —, then
 * one read of the stored progress ({@link refreshLibraryProgress}: each card's episode count and the
 * saved count of **Downloading · saved/total** — no status: since 3.0.0 a card's status comes from
 * the jobs alone).
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
    items: stored.items.map((item) => ({ ...item, coverUrl: liveCover(covers.get(item.seriesId) ?? null) })),
    total: stored.total,
    complete: stored.complete,
    ended: stored.ended,
    short: stored.short,
    skipped: 0,
    loading: false,
    listedAt: stored.listedAt,
  };
  library.profile = stored.profile;
  library.countedAt = stored.countedAt;
  library.fullReadAt = stored.fullReadAt;
  renderLibrary();
  await refreshLibraryProgress(stored.items.map((item) => item.seriesId));
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
 * What DramaFetch's own records say of these dramas (`lib/library.progressOf`: the episodes saved
 * and how many each has — its card's count, **Downloading · saved/total**, which leaves out the
 * episodes a download in full of the running drama has still to save anew: {@link library}.again):
 * one read of the stored progress, no request; the library drawn again. A read the storage refuses
 * changes nothing (the library is drawn again as it is).
 * @param {readonly string[]} seriesIds
 * @returns {Promise<void>}
 */
async function refreshLibraryProgress(seriesIds) {
  if (seriesIds.length === 0 || app.favorites === null) return;
  let states;
  try {
    states = await readSeriesStates(seriesIds);
  } catch {
    renderLibrary(); // what is known: a card a job just began says so all the same
    return;
  }
  const byId = new Map(libraryItems().map((item) => [item.seriesId, item]));
  for (const seriesId of seriesIds) {
    const item = byId.get(seriesId);
    const again = seriesId === library.running ? library.again : null;
    if (item !== undefined) library.progress.set(seriesId, progressOf(states.get(seriesId), seriesId, item.episodes, again));
  }
  renderLibrary();
}

/**
 * @returns {LibraryEntry[]} the library's dramas with what the records say (before the records were
 * read: what a drama never run has — TikTok's count, nothing saved)
 */
function libraryEntries() {
  return libraryItems().map((item) => ({
    item,
    progress: library.progress.get(item.seriesId) ?? progressOf(undefined, item.seriesId, item.episodes),
  }));
}

/**
 * @param {Job} job
 * @returns {boolean} whether it downloads — a `batch` or a `selection` job —: the dramas it names
 *   are being downloaded, or wait to be
 */
function isDownload(job) {
  return job.kind === "batch" || job.kind === "selection";
}

/**
 * The series a waiting `batch` or `selection` job will download, and those of the running one it
 * has not reached yet: their cards say **Queued**.
 * @returns {Set<string>}
 */
function queuedSeries() {
  /** @type {Set<string>} */
  const queued = new Set();
  for (const job of app.queue) if (isDownload(job)) for (const ref of job.refs) queued.add(ref.seriesId);
  if (app.running !== null && isDownload(app.running)) {
    for (const ref of app.running.refs) if (ref.seriesId !== library.running && !library.finished.has(ref.seriesId)) queued.add(ref.seriesId);
  }
  return queued;
}

/**
 * The series being downloaded or waiting to be: those a waiting `batch` or `selection` job will
 * download, those of the running one it has not finished — the one it downloads now included. A
 * paste, Enter and the popup's **Download this series** never queue one of them twice, and a
 * card's **Download** is disabled for them (its card says **Queued** or **Downloading**).
 * @returns {Set<string>}
 */
function pendingDownloads() {
  const pending = queuedSeries();
  const running = app.running;
  if (running !== null && isDownload(running) && library.running !== null) pending.add(library.running);
  return pending;
}

/** @returns {LibrarySort} the sort order chosen (the list's own when none) */
function librarySort() {
  return librarySortOf(select("library-sort").value);
}

/**
 * Draw the library: the section (or the line saying how to fill it), the connection and count
 * lines, the first dramas the search matches as cards (pieces of `LIBRARY_PIECE`: 946 dramas never
 * build 946 cards), their covers watched, the selection bar.
 */
function renderLibrary() {
  const shown = app.favorites;
  renderQueue(); // a title the library holds now names its drama in the Waiting card
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
  const search = input("favorites-filter").value;
  const matching = sortedItems(entries, librarySort()).filter((entry) => titleMatches(entry.item.title, search));
  const drawn = matching.slice(0, library.shown);
  const twins = twinIds(entries.map((entry) => entry.item));
  const queued = queuedSeries();
  const held = pendingDownloads(); // what a card's Download would queue twice
  libraryCovers.show(entries.map((entry) => ({ itemId: entry.item.seriesId, coverUrl: liveCover(entry.item.coverUrl) }))); // an expired signature: no request
  const cards = drawn.map((entry) => {
    const seriesId = entry.item.seriesId;
    const status = libraryStatus({ queued: queued.has(seriesId), running: library.running === seriesId });
    return libraryCard(entry, status, twins.has(seriesId), held.has(seriesId));
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
 * One drama's card: its cover (or a plain placeholder with the title), its tick, its title, its
 * episodes and length ({@link favoriteMeta}), **Queued** while a download job of it waits and
 * **Downloading · saved/total** with a thin progress bar while one runs — nothing otherwise
 * (DramaFetch 3.0.0: no status from the records, no locked count) —, the twins' badge, and its
 * actions — **Download** (DramaFetch 1.7.0: that drama alone, {@link onLibraryDownloadOne};
 * disabled while it is queued or downloading — `held` —), **See episodes** (its episode list, to
 * pick from: the one way left to list a series, so on every card) and **Open on TikTok**. The
 * card's `data-status` — `queued`, `running` or `idle` — is the tests' hook; an `idle` card has no
 * status badge.
 * @param {LibraryEntry} entry
 * @param {LibraryStatus} status from the jobs alone (`lib/library.libraryStatus`)
 * @param {boolean} twin another different drama of the library bears its title
 * @param {boolean} held a download job holds it ({@link pendingDownloads}): its **Download** would
 *   queue it twice
 * @returns {HTMLElement}
 */
function libraryCard(entry, status, twin, held) {
  const { item, progress } = entry;
  const seriesId = item.seriesId;
  const title = item.title ?? seriesId;
  const cover = el("div", { className: "drama-cover" });
  const loaded = libraryCovers.urlOf(seriesId);
  cover.append(loaded !== null ? el("img", { className: "drama-img", attrs: { src: loaded, alt: "" } }) : el("span", { className: "drama-placeholder", text: title }));
  const box = /** @type {HTMLInputElement} */ (el("input", { attrs: { type: "checkbox", "data-series-id": seriesId, "aria-label": t("libraryChooseLabel", [title]) } }));
  box.checked = favoritesSelected.has(seriesId);
  box.addEventListener("change", () => {
    if (box.checked) favoritesSelected.add(seriesId);
    else favoritesSelected.delete(seriesId);
    updateFavoritesSelection();
  });
  cover.append(el("label", { className: "pick" }, [box, el("span", { text: t("libraryChoose") })]));
  /** @type {HTMLElement[]} */
  const badges = [];
  if (status !== "idle") badges.push(el("span", { className: `badge favorite-status ${status}`, text: libraryStatusText(status, progress), attrs: { "data-status": status } }));
  if (twin) badges.push(el("span", { className: "badge twin", text: t("libraryTwin"), attrs: { "data-twin": "1" } }));
  const body = el("div", { className: "drama-body" }, [el("h3", { className: "favorite-title", text: title }), el("p", { className: "favorite-meta", text: favoriteMeta(item, progress) })]);
  if (badges.length > 0) body.append(el("p", { className: "drama-badges" }, badges));
  if (status === "running") {
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
  const download = action("download", t("libraryDownloadOne"), "primary", () => onLibraryDownloadOne(item));
  actions.push(action("browse", t("libraryBrowse"), "link", () => listSeries({ kind: "series", seriesId, episodeHint: null, sourceUrl: seriesId })));
  action("open", t("libraryOpen"), "link", () => void openOnTikTok(seriesId));
  body.append(row);
  const blocked = !app.owner || app.cooldown !== null || app.unsaved !== null;
  for (const made of actions) made.disabled = blocked;
  download.disabled = blocked || held;
  const article = el("article", { className: `drama-card ${status}`, attrs: { "data-series-id": seriesId, "data-status": status } }, [cover, body]);
  libraryCards.set(seriesId, { item, article, box, cover, actions, download });
  return article;
}

/**
 * A card's status while a job holds its drama, in the page's language: `Queued`, or `Downloading ·
 * 12/30` (saved / how many it has; the saved count alone when that is unknown).
 * @param {"queued" | "running"} status
 * @param {Progress} progress
 * @returns {string}
 */
function libraryStatusText(status, progress) {
  if (status === "queued") return t("libraryQueued");
  const fraction = progress.total === null ? String(progress.saved) : `${progress.saved}/${progress.total}`;
  return `${t("libraryRunning")} · ${fraction}`;
}

/**
 * `60 episodes · 1h 19m`: how many episodes the drama has — the number **Downloading · saved/total**
 * counts against (`lib/library.progressOf`'s total: TikTok's count, raised to what DramaFetch's
 * records hold when a run listed more), so the card never disagrees with itself — and its length
 * as TikTok's list gives it; `–` when nothing is known. No locked count (DramaFetch 3.0.0): **See
 * episodes** shows each episode's access.
 * @param {FavoriteItem} item
 * @param {Progress} progress
 * @returns {string}
 */
function favoriteMeta(item, progress) {
  /** @type {string[]} */
  const parts = [];
  if (progress.total !== null) parts.push(t("favoritesEpisodes", [progress.total]));
  const length = durationParts(item.durationS);
  if (length !== null) {
    parts.push(length.hours > 0 ? t("favoritesLengthHours", [length.hours, length.minutes]) : t("favoritesLengthMinutes", [length.minutes]));
  }
  return parts.length > 0 ? parts.join(" · ") : "–";
}

/** The count line: what is listed, while it loads and once it is done. */
function renderFavoritesCount() {
  const shown = app.favorites;
  if (shown === null) return;
  const listed = libraryCount();
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
 * dramas` (the count of the last read) —, the line saying the library holds another number than
 * TikTok counts, and
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
  $("library-total").textContent = shown.total === null ? t("libraryTotalUnknown") : t("libraryTotal", [shown.total]);
  const kept = libraryCount();
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
  favoritesFromOutside({ tabId: source.tabId });
}

/** The search box: only the dramas whose title holds its text are shown (letter case aside). */
function applyFavoritesFilter() {
  library.shown = LIBRARY_PIECE;
  input("favorites-select-all").checked = false;
  renderLibrary();
}

/** **Select all shown**: ticks (or unticks) every card the grid shows, and only those. */
function onFavoritesSelectShown() {
  const checked = input("favorites-select-all").checked;
  for (const [seriesId, { box }] of libraryCards) {
    box.checked = checked;
    if (checked) favoritesSelected.add(seriesId);
    else favoritesSelected.delete(seriesId);
  }
  updateFavoritesSelection();
}

/**
 * The ticked dramas the library holds, with what the records say of them, in the order the
 * library shows them (its sort; the list's own by default).
 * @returns {LibraryEntry[]}
 */
function selectedEntries() {
  const entries = libraryEntries().filter((entry) => favoritesSelected.has(entry.item.seriesId));
  return sortedItems(entries, librarySort());
}

/**
 * The ticked dramas the library holds, in the order the library shows them (its sort; the list's
 * own by default).
 * @returns {FavoriteItem[]}
 */
function selectedItems() {
  return selectedEntries().map((entry) => entry.item);
}

/**
 * The selection bar: `K selected · E episodes` — E the sum of the episode counts their cards show
 * (`lib/library.selectionEpisodes`) —, and the buttons that need a tick.
 */
function updateFavoritesSelection() {
  const entries = selectedEntries();
  const episodes = selectionEpisodes(entries, new Set(entries.map((entry) => entry.item.seriesId)));
  $("favorites-selection").textContent = t("librarySelection", [entries.length, episodes]);
  button("library-clear").disabled = entries.length === 0;
  updateButtons();
}

/** **Clear selection**: no drama ticked. */
function onLibraryClear() {
  favoritesSelected.clear();
  input("favorites-select-all").checked = false;
  renderLibrary();
}

/**
 * The job **Download selected dramas** queues for `items` — and a card's own **Download** for its
 * one drama ({@link onLibraryDownloadOne}): ONE `batch` job over exactly their series ids, in that
 * order — what a paste of those ids into the box queues with both checkboxes unticked (the same
 * refs, label, `includeLocked` false, `recheck` false) —, through `enqueue`, so the job gate, the
 * cooldown and a refused write behave as for a paste. Returns the refs queued: none for no items,
 * or when the page queues nothing (a read-only tab, a write refused: said).
 * @param {readonly FavoriteItem[]} items
 * @returns {SeriesRef[]}
 */
function queueDramas(items) {
  const parsed = parseSeriesList(items.map((item) => item.seriesId).join("\n"));
  if (parsed.refs.length === 0) return [];
  const label = parsed.refs.length === 1 ? t("jobSeries", /** @type {SeriesRef} */ (parsed.refs[0]).seriesId) : t("jobBatch", [parsed.refs.length]);
  const queued = enqueue({ kind: "batch", label, refs: parsed.refs, series: null, numbers: [], includeLocked: false, recheck: false });
  return queued ? parsed.refs : [];
}

/**
 * **Download selected dramas**: ONE `batch` job over exactly the ticked dramas' series ids, in the
 * order the library shows them ({@link queueDramas}). The box is not touched; the queued dramas'
 * ticks are cleared and their cards say **Queued** — theirs only: pressed while a listing refills
 * the library (**Update from TikTok**, the popup's **Open my library**), it queues the ticked
 * dramas read so far, what the selection bar counts, and a tick on one the listing has not read
 * back yet stays, its card ticked again once read, or once the library comes back as it was
 * ({@link restoreKeptLibrary}), for the next press. Nothing for an empty selection.
 */
function onLibraryDownload() {
  const items = selectedItems();
  if (items.length === 0 || !app.owner) return;
  const queued = queueDramas(items);
  if (queued.length === 0) return; // refused (a write the storage refused: said), nothing to untick
  for (const ref of queued) favoritesSelected.delete(ref.seriesId); // the queued ones only: a tick a listing has not read back yet stays
  input("favorites-select-all").checked = false;
  setStatus($("favorites-status"), t("libraryQueuedJob", [queued.length]), "ok");
  renderLibrary();
}

/**
 * A card's **Download** (DramaFetch 1.7.0, the owner's decision of 2026-11-20): that one drama
 * downloaded — exactly the job one tick and **Download selected dramas** queue for it
 * ({@link queueDramas}) —, the ticks left alone. Never for a drama already queued or downloading
 * (its button is disabled then; `alreadyDownloading` all the same), nor while no job may start (the
 * same gate as the cards' other job buttons, through `enqueue`).
 * @param {FavoriteItem} item
 */
function onLibraryDownloadOne(item) {
  if (!app.owner) return;
  const name = `“${item.title ?? item.seriesId}”`;
  if (pendingDownloads().has(item.seriesId)) {
    setStatus($("favorites-status"), t("alreadyDownloading", [name]), "error");
    return;
  }
  if (queueDramas([item]).length > 0) setStatus($("favorites-status"), t("libraryQueuedDrama", [name]), "ok");
}

/**
 * **Open on TikTok**: the drama's first episode in a normal tab of this Chrome, in front — nothing
 * else.
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

/** The library section in view (the popup's **Open my library**, **Update from TikTok**). */
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
 * Show `series` in **See episodes** — and make it the list the page acts on (`app.loaded`): what
 * Chrome's download history and the stored records say is read first; then, in ONE synchronous
 * step, the list the buttons act on, its DRM verdicts, title, counts and rows change together —
 * never one series' rows and counts on screen while the buttons act on another.
 * @param {Series} series
 * @param {DownloadsView} view
 */
async function renderSeries(series, view) {
  await view.refresh(); // what Chrome's download history says is still on disk
  const state = readState(await readSeriesState(series.seriesId), series.seriesId);
  app.loaded = { series, resolvedAt: now() };
  rememberName(series.seriesId, series.name); // the list on screen names it: the Waiting card too
  $("series-card").hidden = false;
  $("series-title").textContent = episodeContext(series).seriesName;
  const onDisk = new Set(state !== null ? doneEntries(state, (entry) => view.exists(entry)).map(([number]) => number) : []);
  // an episode an earlier download found encrypted (DRM): TikTok's list may call it free, but the
  // engine skips it again without a request — shown as the locked one it is, with that verdict
  // and what tries it again here (tick it, Download selected: a locked row ticked is asked for)
  const drmNumbers = new Set(
    series.episodes.filter((episode) => state !== null && drmProtected(state, episode.number)).map((episode) => episode.number),
  );
  app.listedDrm = { seriesId: series.seriesId, numbers: drmNumbers };
  /** @param {Episode} episode */
  const drmFound = (episode) => drmNumbers.has(episode.number);
  const available = series.episodes.filter((episode) => !isLocked(episode) && !drmFound(episode)).length;
  $("series-meta").textContent = t("seriesMeta", [series.episodes.length, available, onDisk.size]);
  const warnings = $("series-warnings");
  warnings.textContent = "";
  for (const warning of series.warnings) warnings.append(el("li", { text: shownText(warning) }));
  const body = /** @type {HTMLTableSectionElement} */ ($("episode-table").querySelector("tbody"));
  body.textContent = "";
  const episodes = [...series.episodes].sort((a, b) => a.number - b.number);
  covers.show(episodes); // this list's thumbnails, once their rows come into view
  for (const episode of episodes) {
    const drm = drmFound(episode);
    const box = /** @type {HTMLInputElement} */ (
      el("input", { attrs: { type: "checkbox", "data-number": String(episode.number), "data-locked": isLocked(episode) || drm ? "1" : "0" } })
    );
    box.checked = !isLocked(episode) && !drm && !onDisk.has(episode.number);
    box.addEventListener("change", updateSelection);
    const cover = el("td", { className: "cover-cell" });
    const thumbnail = covers.urlOf(episode.itemId); // fetched already: no request
    cover.append(thumbnail !== null ? coverImage(thumbnail) : el("span", { className: "cover placeholder" }));
    const access = el("td", {}, [accessBadge(episode)]);
    if (onDisk.has(episode.number)) {
      // on disk, unticked; this list's buttons download it again in full all the same (3.0.0)
      const title = t("badgeOnDiskTitle", [t("downloadAvailableButton"), t("downloadSelectedButton")]);
      access.append(el("span", { className: "badge ondisk", text: t("badgeOnDisk"), title }));
    }
    if (isLocked(episode) && episode.lockHints.length > 0) {
      access.append(el("span", { className: "hints", text: episode.lockHints.map(shownText).join("; ") }));
    }
    if (drm && !isLocked(episode)) access.append(el("span", { className: "hints", text: t("seriesDrmHint", [t("downloadSelectedButton")]) }));
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
  button("download-available-button").disabled = blocked || availableNumbers().length === 0;
  button("download-selected-button").disabled = blocked || !episodeBoxes().some((box) => box.checked);
  // the retry buttons: the same rule, and a clicked one stays disabled until the next job ends
  const retry = button("retry-button");
  retry.disabled = blocked || app.failed === null || spentRetries.has(retry);
  button("report-button").disabled = app.lastReport === null; // a save, no request: the cooldown does not matter
  // the library: Download selected and Update from TikTok queue jobs; See episodes too — the same
  // rule (Open on TikTok is a normal tab: never disabled) —, and a card's Download, also while its
  // drama is queued or downloading
  button("library-download").disabled = blocked || selectedItems().length === 0;
  button("library-refresh").disabled = blocked || library.source === null;
  const pending = pendingDownloads();
  for (const [seriesId, card] of libraryCards) {
    for (const action of card.actions) action.disabled = blocked;
    card.download.disabled = blocked || pending.has(seriesId);
  }
}

/**
 * The box's text as the parser reads it: a byte-order mark at the start of any line dropped — a
 * paste can bring one (copied from a file that starts with it), and once it lands below other
 * lines it is no longer the text's first character, the one place `parseSeriesList` drops it.
 * @param {string} text
 * @returns {string}
 */
function boxText(text) {
  return text.replace(/^\uFEFF/gm, "");
}

/**
 * `text` — the box's, or what was pasted into it — as series refs (the box's rules,
 * `lib/urls.parseSeriesList`: duplicates dropped with a note), or null with the reason on the
 * status line: a line the parser refuses (nothing may start while one is), or no series at all.
 * `offset`: how many of the box's lines come before the text's first line — a refused line is
 * named by the box's own number (`line 3: …`), the one the user sees it on.
 * @param {string} text
 * @param {number} [offset]
 * @returns {{refs: SeriesRef[], notes: string[]} | null}
 */
function parsedLinks(text, offset = 0) {
  const parsed = parseSeriesList(boxText(text));
  const status = $("input-status");
  if (parsed.errors.length > 0) {
    /** @param {SeriesListLine} error */
    const onBoxLine = (error) => (offset === 0 ? error.message : error.message.replace(/^line \d+: /, `line ${error.line + offset}: `));
    setStatus(status, parsed.errors.map((error) => shownText(onBoxLine(error))).join(" · "), "error");
    return null;
  }
  if (parsed.refs.length === 0) {
    setStatus(status, t("noLinks"), "error");
    return null;
  }
  return { refs: parsed.refs, notes: parsed.notes };
}

/**
 * Queue the download of whole series — what a paste, Enter and a hand-over queue (and **Download
 * all** queued until 1.7.0): ONE `batch` job — `parseSeriesList`'s refs,
 * label `jobSeries` / `jobBatch`, through `enqueue`, so the job gate, the cooldown, a refused write,
 * the rest between jobs, each series listed right before its own downloads and the alerts behave
 * as for any batch — over the series not being downloaded already ({@link pendingDownloads}: those
 * are named, never queued twice). Null when the page refused to queue (a read-only tab, a write
 * refused: said); else what was queued and what was left out.
 * @param {readonly SeriesRef[]} refs
 * @param {{includeLocked: boolean, recheck: boolean}} options
 * @returns {{queued: SeriesRef[], already: SeriesRef[]} | null}
 */
function queueDownload(refs, options) {
  const pending = pendingDownloads();
  const queued = refs.filter((ref) => !pending.has(ref.seriesId));
  const already = refs.filter((ref) => pending.has(ref.seriesId));
  if (queued.length > 0) {
    const label = queued.length === 1 ? t("jobSeries", /** @type {SeriesRef} */ (queued[0]).seriesId) : t("jobBatch", [queued.length]);
    const job = { kind: /** @type {const} */ ("batch"), label, refs: queued, series: null, numbers: [], includeLocked: options.includeLocked, recheck: options.recheck };
    if (!enqueue(job)) return null;
  }
  return { queued, already };
}

/**
 * What the status line says of a download queued ({@link queueDownload}): what was queued
 * (`queuedOne`: one series, by its id; `libraryQueuedJob`: several, one after the other) and what
 * was not, being downloaded already (`alreadyDownloading`, by their ids).
 * @param {{queued: readonly SeriesRef[], already: readonly SeriesRef[]}} result
 * @returns {string}
 */
function queuedText(result) {
  /** @type {string[]} */
  const parts = [];
  const [first] = result.queued;
  if (result.queued.length === 1 && first !== undefined) parts.push(t("queuedOne", first.seriesId));
  else if (result.queued.length > 1) parts.push(t("libraryQueuedJob", [result.queued.length]));
  if (result.already.length > 0) parts.push(t("alreadyDownloading", result.already.map((ref) => ref.seriesId).join(", ")));
  return parts.join(" · ");
}

/**
 * The box's own download (DramaFetch 1.7.0, the owner's decision of 2026-11-20, in place of **Load
 * list** and **Download all**): `text` — what was pasted, or the whole box on Enter — queued as
 * **Download all** queued the box: ONE `batch` job ({@link queueDownload}), `includeLocked` and
 * `recheck` from the two checkboxes for this run, which are then cleared. The gate of the download
 * buttons first, as **Download all**'s was (disabled otherwise): this tab holds the engine — a
 * read-only tab does nothing at all, its banner says why —, no cooldown is in force (the status
 * line names its end), no write was refused (the storage advice). Returns whether the text was
 * taken — queued, or every series of it found being downloaded already (named, nothing queued
 * twice) —: Enter's box is emptied then, a paste never lands in it; refused — a line the parser
 * refuses, no series, the gate — the text stays in the box, with the reason on the status line.
 * `where.rest`: what the box keeps besides a paste taken (null for Enter, which takes the whole
 * box, and for a paste over part of a line, whose line Enter should not take next) — said
 * (`linksKept`) only when Enter would download something of it ({@link enterTakes});
 * `where.offset`: the box's lines before the pasted text's first line ({@link parsedLinks}).
 * @param {string} text
 * @param {{rest?: string | null, offset?: number}} [where]
 * @returns {boolean}
 */
function downloadFromBox(text, where = {}) {
  if (!app.owner) return false;
  const parsed = parsedLinks(text, where.offset ?? 0);
  if (parsed === null) return false;
  if (app.unsaved !== null) {
    void showStorageRefused();
    return false;
  }
  if (app.cooldown !== null) {
    setStatus($("input-status"), shownText(cooldownMessage(app.cooldown, { now: now() })), "error");
    return false;
  }
  const result = queueDownload(parsed.refs, { includeLocked: input("include-locked").checked, recheck: input("recheck").checked });
  if (result === null) return false;
  if (result.queued.length > 0) {
    input("include-locked").checked = false; // per run, as Download all had them
    input("recheck").checked = false;
  }
  const said = [queuedText(result), ...parsed.notes.map(shownText), ...(enterTakes(where.rest ?? null) ? [t("linksKept")] : [])].join(" · ");
  setStatus($("input-status"), said, result.queued.length > 0 ? "ok" : "error");
  return true;
}

/**
 * Whether Enter would download something of `rest`, what the box keeps besides a paste taken: no
 * line the parser refuses (Enter would then queue nothing at all) and a series not being
 * downloaded already, as Enter's {@link queueDownload} reads it (asked once the paste is queued:
 * one the paste just queued counts as such). Null — Enter's own run, which takes the whole box, or
 * a paste over part of a line — never.
 * @param {string | null} rest
 * @returns {boolean}
 */
function enterTakes(rest) {
  if (rest === null) return false;
  const kept = parseSeriesList(boxText(rest));
  const pending = pendingDownloads();
  return kept.errors.length === 0 && kept.refs.some((ref) => !pending.has(ref.seriesId));
}

/**
 * Where a paste the page does not take lands in the box. With text selected, in its place, as any
 * paste: the user chose what it replaces (a wrong line, an id inside a link). With none, text that
 * names anything — a series, a video, a short link, other words: a line the parser reads — lands
 * on lines of its own after the caret's line, a line break put before it when that line does not
 * end with one: never glued onto, nor into, a line the box holds, so links pasted one after the
 * other while nothing may start (the cooldown) stay one per line, each taken by Enter later. Blank
 * lines and comments land as any paste does. `own`: the page puts it in place itself; `offset`: the
 * box's lines before the pasted text's first line.
 * @param {string} value the box's text
 * @param {number} start its selection's start (the caret)
 * @param {number} end its selection's end
 * @param {string} pasted
 * @returns {{from: number, to: number, text: string, own: boolean, offset: number}}
 */
function pasteLanding(value, start, end, pasted) {
  const breaks = (/** @type {string} */ text) => text.split("\n").length - 1;
  if (start !== end || parseSeriesList(pasted).lines === 0) {
    return { from: start, to: end, text: pasted, own: false, offset: breaks(value.slice(0, start)) };
  }
  const lineEnd = value.indexOf("\n", end);
  const at = lineEnd === -1 ? value.length : lineEnd;
  const before = value.slice(0, at);
  const lead = before !== "" && !before.endsWith("\n") && !pasted.startsWith("\n") ? "\n" : "";
  return { from: at, to: at, text: `${lead}${pasted}`, own: at !== start || lead !== "", offset: breaks(before) + (lead === "" ? 0 : 1) };
}

/**
 * Whether `start`..`end` selects whole lines of `value` — from a line's start to a line's end, its
 * line break included or not —, as a user selects the lines a paste is to replace. A selection
 * inside a line, or across part of one, is not.
 * @param {string} value
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
function selectsWholeLines(value, start, end) {
  return start < end && (start === 0 || value[start - 1] === "\n") && (end === value.length || value[end] === "\n" || value[end - 1] === "\n");
}

/**
 * Put `text` in place of `from`..`to` in the box, the caret after it, as typing does — through
 * Chrome's own editing command, so that Ctrl+Z takes it back like any edit; `setRangeText` (no
 * undo) only where that command does nothing. The caret is set again afterwards: that closes
 * Chrome's typing step, so what the user types next is an edit of its own — one Ctrl+Z takes it
 * back and never the page's edit with it —, and the box focused again, which scrolls it to the
 * caret.
 * @param {HTMLTextAreaElement} box
 * @param {string} text "" removes the range
 * @param {number} from
 * @param {number} to
 */
function editBox(box, text, from, to) {
  box.focus();
  box.setSelectionRange(from, to);
  const edited = text === "" ? from < to && document.execCommand("delete") : document.execCommand("insertText", false, text);
  if (!edited) box.setRangeText(text, from, to, "end");
  const caret = box.selectionEnd;
  box.setSelectionRange(caret, caret);
  // and the caret in view: an editing command the page runs does not scroll the box to it (a link
  // landed below its rows looked dropped); focusing the box again does, as Chrome's own paste
  box.blur();
  box.focus();
}

/**
 * A paste into the box: what was pasted — the clipboard's text, never the rest of the box — is
 * downloaded at once ({@link downloadFromBox}). Taken, it never lands in the box; whole lines it
 * was pasted over go, as with any paste, and any other selection is left as it was (the paste was
 * a download, not an edit: half a line removed could leave an id that names another series);
 * whatever else the box held — a refused paste's lines, typed ids — stays there, never lost, and
 * the status line says so when Enter would download something of it ({@link enterTakes}) — not
 * after a paste over part of a line: that line is one the user meant to replace.
 * Refused, it lands there for the user to correct (then Enter), the reason on the status line
 * ({@link pasteLanding}); in a read-only tab, as any paste does. Every change the page makes to the
 * box is an edit Ctrl+Z takes back ({@link editBox}).
 * @param {ClipboardEvent} event
 */
function onLinksPaste(event) {
  const pasted = (event.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
  const box = textarea("links");
  const { value, selectionStart: start, selectionEnd: end } = box;
  const replaced = selectsWholeLines(value, start, end);
  const rest = replaced ? value.slice(0, start) + value.slice(end) : value;
  const landing = pasteLanding(value, start, end, pasted);
  // pasted over part of a line, the box stays as it was, but that line is not what Enter should
  // download next: no note about what the box holds
  const kept = start === end || replaced ? rest : null;
  if (downloadFromBox(pasted, { rest: kept, offset: landing.offset })) {
    event.preventDefault(); // taken: it never lands in the box
    if (rest.trim() === "" && value !== "") editBox(box, "", 0, value.length); // only blanks left: emptied, one Ctrl+Z
    else if (replaced) editBox(box, "", start, end);
    return;
  }
  if (!app.owner || !landing.own) return; // it lands as any paste does
  event.preventDefault();
  editBox(box, landing.text, landing.from, landing.to);
}

/**
 * Enter in the box (typed ids): the whole box downloaded as a paste is ({@link downloadFromBox}),
 * and emptied once taken; in a blank box nothing at all — the status line (a paste's `queued`,
 * say) left as it is. Shift+Enter makes a new line, and so does Enter while an input method
 * composes a character — and in a read-only tab, which downloads nothing.
 * @param {KeyboardEvent} event
 */
function onLinksKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || !app.owner) return;
  event.preventDefault();
  const box = textarea("links");
  if (box.value.trim() === "") return; // nothing to download: no new line, nothing said
  if (downloadFromBox(box.value)) editBox(box, "", 0, box.value.length); // emptied: Ctrl+Z brings it back
}

/**
 * Whether a listing of `seriesId` (**See episodes**) is running or waiting: a second click must
 * not queue the same listing twice (two discoveries of one series, one after the other, for
 * nothing).
 * @param {string} seriesId
 * @returns {boolean}
 */
function loadPending(seriesId) {
  /** @param {Job} job */
  const listsIt = (job) => job.kind === "load" && job.refs[0]?.seriesId === seriesId;
  return (app.running !== null && listsIt(app.running)) || app.queue.some(listsIt);
}

/**
 * Queue the listing of one series — **See episodes** on a drama of the library: its episodes with
 * their covers, to download all available or pick from; one listing per series at a time.
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
 * The favorites of a TikTok tab handed over (the popup's **Open my library** on that profile —
 * 1.5.0's **Choose from your favorites** —, **Update from TikTok**), taken by the engine's tab only,
 * like a series ({@link downloadFromOutside}): it brings the library into view and updates it from
 * the tab's favorites (**List favorites**: the smart refresh). The tab still answers, so the worker
 * brings it to the front to say it. Nothing is queued twice (a listing of that tab waiting or
 * running: `favoritesAlreadyQueued`).
 * @param {FavoritesHandover} handover
 * @returns {boolean} whether this tab took it (the engine's tab)
 */
function favoritesFromOutside(handover) {
  if (!app.owner) return false;
  const status = $("input-status");
  const { tabId } = handover;
  showLibrarySection(); // the popup's Open my library: the library in view, updated by the job
  if (favoritesPending(tabId)) {
    setStatus(status, t("favoritesAlreadyQueued"), "error");
    return true;
  }
  setStatus(status, t("favoritesChoose"));
  enqueue({ kind: "favorites", label: t("jobFavorites"), refs: [], series: null, numbers: [], includeLocked: false, recheck: false, favoritesTab: tabId });
  return true;
}

/**
 * The `selection` job of **See episodes**' buttons over the list on screen; `pick` says which
 * button queued it (its row in the Waiting card, DramaFetch 2.0.0). It downloads every chosen
 * episode again in full (`overwrite`, DramaFetch 3.0.0, the owner's decision of 2026-11-25:
 * “permitir que se descarguen de nuevo completamente”), even one DramaFetch's records or Chrome's
 * history show on disk — its file replaced under the same name — and whatever an earlier attempt
 * left; a locked episode, or one remembered as DRM-protected, is still skipped unless a ticked
 * row asks for it (`includeLocked`).
 * @param {number[]} numbers
 * @param {boolean} includeLocked
 * @param {"available" | "selected"} pick
 */
function startSelection(numbers, includeLocked, pick) {
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
    overwrite: true,
    pick,
  });
}

/**
 * The episodes **Download all available** takes from the list on screen — exactly the ones its
 * `… available` counts ({@link renderSeries}): TikTok lists them free or unlocked, and no earlier
 * download found them encrypted (a remembered DRM verdict, which the engine would skip again
 * without a request). None: the button is disabled, and no job lists the series for nothing.
 * @returns {number[]}
 */
function availableNumbers() {
  if (app.loaded === null) return [];
  const series = app.loaded.series;
  const drm = app.listedDrm.seriesId === series.seriesId ? app.listedDrm.numbers : new Set();
  return series.episodes.filter((episode) => !isLocked(episode) && !drm.has(episode.number)).map((episode) => episode.number);
}

function onDownloadAvailable() {
  startSelection(availableNumbers(), false, "available");
}

function onDownloadSelected() {
  const checked = episodeBoxes().filter((box) => box.checked);
  const numbers = checked.map((box) => Number(box.dataset["number"]));
  startSelection(numbers, checked.some((box) => box.dataset["locked"] === "1"), "selected");
}

function onStop() {
  app.stopRequested = true;
  for (const cancel of [...app.stopWaiters]) cancel();
  app.stopWaiters.clear();
  dropAutoRetries(); // never an automatic retry after a Stop, even one the running job does not meet
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

/**
 * The cooldown banner's countdown, every second while a cooldown is in force: the time left in
 * minutes and seconds — `29 min 07 s left`, `45 s left` — as the pause line counts (DramaFetch
 * 2.0.0, `display.formatDuration`); at its end the banner goes.
 */
function tickCooldown() {
  if (app.cooldown === null) return;
  const left = secondsLeft(app.cooldown, now());
  if (left <= 0) {
    void refreshCooldown();
    return;
  }
  $("cooldown-left").textContent = t("cooldownLeft", [formatDuration(left)]);
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
  input("setting-alerts").checked = settings.alerts;
  input("setting-auto-retry").checked = settings.autoRetry;
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
    alerts: input("setting-alerts").checked,
    autoRetry: input("setting-auto-retry").checked,
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

/**
 * The settings stored again (`chrome.storage.onChanged`) — by this page's **Save settings** or
 * **Defaults**, or by another DramaFetch tab of this browser: a second one is read-only (its banner
 * says to use this one) but its form still saves (DramaFetch 2.0.0) —: this page follows what is
 * stored, so the tab that downloads acts on the settings the user saved wherever they saved them, as
 * after its own **Save settings**: the form shows them, and what the page does next follows them
 * (the next job, the next alert, the next automatic retry). Settings equal to this page's own — its
 * own save heard back — change nothing: its **Save settings** did that already, and the form is
 * left as the user may be editing it again. A storage that cannot be read leaves the settings as
 * they were.
 */
async function followStoredSettings() {
  /** @type {Settings} */
  let stored;
  try {
    stored = await loadSettings();
  } catch (error) {
    console.warn(error);
    return;
  }
  if (sameSettings(stored, app.settings)) return;
  app.settings = stored;
  fillSettings();
}

/**
 * @param {Settings} one
 * @param {Settings} other
 * @returns {boolean} whether every setting of `one` is `other`'s
 */
function sameSettings(one, other) {
  return /** @type {(keyof Settings)[]} */ (Object.keys(DEFAULT_SETTINGS)).every((key) => one[key] === other[key]);
}

// ---------------------------------------------------------------------------- test mode

async function setupTestMode() {
  if (!app.testMode) return;
  // the journal of finished jobs the end-to-end harness reads (`page.evaluate`): test mode only
  Object.assign(globalThis, { dramafetchJournal: testJournal });
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
 * A series handed from outside — the popup's **Download this series** — downloaded in the engine's
 * tab only (DramaFetch 1.7.0: it puts a drama in DramaFetch "like pasting it"): the request reaches
 * every DramaFetch page, and the engine's takes it. It queues the job a paste of it queues ({@link queueDownload}:
 * ONE `batch` job — no checkbox for a hand-over: `includeLocked` and `recheck` false —, never for a
 * series already being downloaded), so its one listing is the job's own, right before the
 * downloads, and the job gate refuses it during a cooldown as before. The box is left alone: it
 * holds what the user pastes or types, and empties once that is queued — a series queued already
 * has no place there; the status line says what was queued. An address that names no series
 * queues nothing and the tab says why (without the parser's `line 1: `).
 * @param {string} link
 * @returns {boolean} whether this tab took it (the engine's tab)
 */
function downloadFromOutside(link) {
  if (!app.owner) return false;
  const parsed = parseSeriesList(link);
  const status = $("input-status");
  if (parsed.errors.length > 0) {
    // about the link handed over, not about the box's first line
    setStatus(status, parsed.errors.map((error) => shownText(error.message.replace(/^line 1: /, ""))).join(" · "), "error");
    return true;
  }
  if (parsed.refs.length === 0) {
    setStatus(status, t("noLinks"), "error");
    return true;
  }
  const result = queueDownload(parsed.refs, { includeLocked: false, recheck: false });
  if (result !== null) setStatus(status, queuedText(result), result.queued.length > 0 ? "ok" : "error");
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
  // DramaFetch 2.0.0 keeps no history of past runs: the one 1.x stored goes, once, at the page's
  // start — best effort: a refusal is ignored, never a stop and never this page's refused write
  await removeStoredHistory();
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
  select("library-sort").value = await readLibrarySort(); // the sort picked last, before the library is drawn

  // the box: a paste downloads what was pasted, Enter the whole box (Shift+Enter: a new line)
  textarea("links").addEventListener("paste", (event) => onLinksPaste(/** @type {ClipboardEvent} */ (event)));
  textarea("links").addEventListener("keydown", (event) => onLinksKeydown(/** @type {KeyboardEvent} */ (event)));
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
  select("library-sort").addEventListener("change", () => {
    applyFavoritesFilter();
    void writeLibrarySort(librarySort()); // the next sessions start with it (a preference: a refused write changes nothing)
  });
  button("library-more").addEventListener("click", () => {
    library.shown += LIBRARY_PIECE;
    renderLibrary();
  });
  button("library-clear").addEventListener("click", onLibraryClear);
  button("library-download").addEventListener("click", onLibraryDownload);
  button("library-refresh").addEventListener("click", () => void onLibraryRefresh());
  // the section links of the header: Settings opens when one goes there
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
    // the settings saved — in another DramaFetch tab too: this page follows them (2.0.0)
    if (area === "local" && Object.hasOwn(changes, SETTINGS_KEY)) void followStoredSettings();
    // a TikTok tab showed its favorites list (or closed): Update from TikTok follows
    if (area === "session" && Object.keys(changes).some((key) => key.startsWith(FAVORITES_TEMPLATE_PREFIX))) void updateLibrarySource();
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isOwnSender(sender)) return; // only this extension's own pages and worker: never a web page
    if (message !== null && typeof message === "object") {
      const record = /** @type {Record<string, unknown>} */ (message);
      // the engine's tab takes it and answers with its tab, which the worker brings to the front;
      // a read-only tab stays silent (as does a tab that is not running: the worker then reloads
      // one with the series in its address)
      if (record["type"] === "dramafetch:load" && typeof record["input"] === "string" && downloadFromOutside(record["input"])) {
        sendResponse({ ok: true, tabId: app.tabId ?? null });
      }
      // the favorites of a TikTok tab (the popup's Open my library on a profile): the same hand-over
      const handover = record["type"] === "dramafetch:favorites" ? handoverOf(record) : null;
      if (handover !== null && favoritesFromOutside(handover)) sendResponse({ ok: true, tabId: app.tabId ?? null });
      // the popup's Open my library away from a TikTok profile: the library shown, no job, no request
      if (record["type"] === "dramafetch:library" && app.owner) {
        showLibrarySection();
        sendResponse({ ok: true, tabId: app.tabId ?? null });
      }
      // a notification's Retry, handed over by the worker: queued by the page that made it, else
      // no answer (the worker then only opens or focuses the DramaFetch tab)
      const retry = record["type"] === "dramafetch:retry" && typeof record["notificationId"] === "string" ? retryFromAlert(record["notificationId"]) : null;
      if (retry !== null) sendResponse(retry);
    }
  });
  setInterval(() => {
    tickCooldown();
    if (app.pauseUntil !== null) renderPause();
    if (now() - library.drawnAt >= 30) renderConnection(); // "2 min ago" moves on
    if (now() - library.lookedAt >= 15) void updateLibrarySource(); // a TikTok profile tab opened or closed
  }, 1000);

  await refreshCooldown();
  await restoreLibrary(); // the library kept from an earlier session, shown at once: no request
  await updateLibrarySource();
  renderAppStatus();
  const load = new URLSearchParams(location.search).get("load");
  const favorites = favoritesOfQuery(location.search); // a favorites hand-over no running page took
  const toLibrary = new URLSearchParams(location.search).get("library") === "1"; // the popup's Open my library no running page took
  if (load || favorites !== null || toLibrary) {
    history.replaceState(null, "", location.pathname);
    if (load) downloadFromOutside(load);
    if (favorites !== null) favoritesFromOutside(favorites);
    if (toLibrary) showLibrarySection();
  }
}

void main();
