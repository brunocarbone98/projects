// @ts-check
/**
 * The StreamFetch tab: the text box (one link per line), **Analyze** (every link resolved one at a
 * time, paced, nothing downloaded: each row shows its cover, title, site, duration and a quality
 * selector), **Download all** (every row with its own selection, one after the other), **Stop**,
 * the rows the run did not download apart in the failed block with **Retry** and **Save the
 * report** (saved on its own at the end of a run with failures when the setting is on), the
 * history of the last 20 runs, the cooldown banner, the settings and — only in the test harness'
 * copy — the test settings. The engine runs here while the tab is open; one tab per browser holds
 * it (the Web Lock `streamfetch-engine`), a second one stays read-only.
 *
 * The page writes texts only through `./i18n.js` (both catalogs: the Settings may choose English
 * or Spanish whatever Chrome's language is) and keeps the engine's records (statuses, failure
 * codes) as data, so a language change re-renders every row.
 */

import { cooldownMessageParams, makeCooldown } from "../lib/cooldown.js";
import { codecFamily } from "../lib/hls.js";
import { stripUrlQueriesInText } from "../lib/json.js";
import { NOT_DOWNLOADED_STATUSES, hintSubstitutions, isHintCode } from "../lib/messages.js";
import { fileBaseName, reportPath } from "../lib/naming.js";
import { mediaPauseMs, pagePauseS, sleepSeconds, stallTimeoutS } from "../lib/pacing.js";
import { buildReport, hasFailures, reportJson } from "../lib/report.js";
import { isRefused, parseInput, parseLine } from "../lib/urls.js";
import {
  BROWSER_CHECK_TIMEOUT_S,
  DownloadsView,
  StepFailure,
  StopRequested,
  applyRefererRule,
  browserDuration,
  coverUrl,
  download,
  jpegFromImage,
  oneLine,
  readBody,
  request,
  saveBlob,
} from "./downloader.js";
import { analyzeBatch, cooldownReason, runBatch } from "./engine.js";
import { WorkFiles } from "./files.js";
import {
  cooldownReasonLabel,
  currentLanguage,
  displayLanguage,
  loadCatalogs,
  localize,
  messageKey,
  refusalLabel,
  renderFailure,
  setLanguage,
  statusLabel,
  stopReasonLabel,
  t,
} from "./i18n.js";
import { basesFor, isResolveFailure, refreshStreams, resolve, selectStream } from "./resolver.js";
import {
  COOLDOWN_STORAGE_KEY,
  DEFAULT_SETTINGS,
  appendHistory,
  clearCooldown,
  copySettings,
  effectivePacing,
  isTestMode,
  loadActiveCooldown,
  loadSettings,
  loadTestSettings,
  maxHeightOf,
  readCooldown,
  readHistory,
  saveSettings,
  saveTestSettings,
  settingsProblem,
  writeCooldown,
} from "./storage.js";

/**
 * @typedef {import("./resolver.js").Target} Target
 * @typedef {import("./resolver.js").ResolveItem} ResolveItem
 * @typedef {import("./resolver.js").ResolveFailure} ResolveFailure
 * @typedef {import("./resolver.js").StreamChoice} StreamChoice
 * @typedef {import("./resolver.js").SiteName} SiteName
 * @typedef {import("./engine.js").Run} Run
 * @typedef {import("./engine.js").Row} Row
 * @typedef {import("./engine.js").EngineEvent} EngineEvent
 * @typedef {import("./engine.js").Resolved} Resolved
 * @typedef {import("./downloader.js").Progress} Progress
 * @typedef {import("./downloader.js").Note} Note
 * @typedef {import("../lib/messages.js").Failure} Failure
 * @typedef {import("./storage.js").Settings} Settings
 * @typedef {import("./storage.js").TestSettings} TestSettings
 *
 * @typedef {object} RowView One row of the items table and what it shows.
 * @property {string} key
 * @property {"item" | "target" | "group"} kind
 * @property {HTMLTableRowElement} tr
 * @property {Record<string, HTMLElement>} cells
 * @property {ResolveItem | null} item
 * @property {Target | null} target
 * @property {string} status
 * @property {Failure | null} failure
 * @property {Note[]} notes
 * @property {string | null} path
 * @property {Progress | null} progress
 * @property {number} progressAt when the progress text was last written (ms)
 *
 * @typedef {object} HistoryEntry One past run, as the history keeps it.
 * @property {string | null} started_at
 * @property {string | null} finished_at
 * @property {string | null} stop_reason
 * @property {{ rows: number, done: number, skipped: number, failed: number,
 *   stopped: number }} counts
 * @property {string[]} retry_inputs the canonical links of the rows that did not download
 *   ({@link historyLine}: no share-link parameter is stored)
 */

/** The Web Lock that makes this tab the only engine of the browser. */
export const ENGINE_LOCK = "streamfetch-engine";
/** The progress text of a row is written at most this often (4×/s). */
export const PROGRESS_INTERVAL_MS = 250;
/** The largest list thumbnail read (the cover embedded in a file has its own limits:
 * `downloader.MAX_COVER_DOWNLOAD_BYTES`, `lib/remux.MAX_COVER_BYTES`). */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

// ------------------------------------------------------------------------- pure helpers

/** The site names the badge shows (not translated: they are names). */
export const SITE_NAMES = Object.freeze(
  /** @type {Record<string, string>} */ ({
    dailymotion: "Dailymotion",
    bilibilitv: "Bilibili.tv",
    bilibili: "Bilibili",
  }),
);

/**
 * The site's name for the badge.
 * @param {string} site
 * @returns {string}
 */
export function siteName(site) {
  return SITE_NAMES[site] ?? site;
}

/**
 * A duration as `m:ss`, or `h:mm:ss` from one hour on; `—` when unknown.
 * @param {number | null | undefined} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

/**
 * Bytes as megabytes with one decimal (`12.3 MB`).
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  return `${(Math.max(0, bytes) / 1e6).toFixed(1)} MB`;
}

/**
 * The progress text of a row: `12.3 MB · 1.2 MB/s`.
 * @param {Progress} progress
 * @returns {string}
 */
export function progressText(progress) {
  return `${formatBytes(progress.received)} · ${formatBytes(progress.bytesPerS)}/s`;
}

/**
 * The fraction a row's `<progress>` shows: segments done for HLS, bytes for DASH; null unknown.
 * @param {Progress} progress
 * @returns {number | null}
 */
export function progressFraction(progress) {
  if (progress.segments !== null && progress.segments.total > 0) {
    return progress.segments.done / progress.segments.total;
  }
  if (progress.total !== null && progress.total > 0) {
    return Math.min(1, progress.received / progress.total);
  }
  return null;
}

/**
 * The four-character code of a codecs string (`avc1.640028` → `avc1`; a list: its first video
 * codec).
 * @param {string | null | undefined} codecs
 * @returns {string}
 */
export function fourcc(codecs) {
  if (typeof codecs !== "string" || codecs === "") return "?";
  const entries = codecs.split(",").map((entry) => entry.trim().split(".")[0] ?? "");
  const video = entries.find((entry) => codecFamily(entry) !== "unknown");
  return (video ?? entries[0] ?? "?") || "?";
}

/**
 * The label of one video stream in the row's selector: `1080p · avc1 · 2.3 Mbit/s` (the bandwidth
 * in Mbit/s, one decimal; left out when unknown).
 * @param {{ height: number | null, width: number | null, codecs: string | null,
 *   bandwidth: number }} stream
 * @returns {string}
 */
export function streamLabel(stream) {
  const height =
    stream.height !== null && stream.width !== null
      ? Math.min(stream.height, stream.width)
      : stream.height;
  const parts = [height === null ? "?p" : `${height}p`, fourcc(stream.codecs)];
  if (stream.bandwidth > 0) parts.push(`${(stream.bandwidth / 1e6).toFixed(1)} Mbit/s`);
  return parts.join(" · ");
}

/**
 * The chosen quality of a target in short (`1080p avc1`), for the `.quality` cell's text.
 * @param {StreamChoice | null} streams
 * @returns {string}
 */
export function qualityLabel(streams) {
  if (streams === null) return "";
  const chosen = streams.kind === "hls" ? streams.variant : streams.video;
  const height =
    chosen.height !== null && chosen.width !== null
      ? Math.min(chosen.height, chosen.width)
      : chosen.height;
  return `${height === null ? "?p" : `${height}p`} ${fourcc(chosen.codecs)}`;
}

/**
 * @typedef {object} QualityOption One `<option>` of a row's quality selector.
 * @property {string} value the index into `streams.available`, or "" for a premium quality
 * @property {string} label
 * @property {boolean} selected
 * @property {boolean} disabled a quality this session is not served (premium only)
 */

/**
 * The options of a row's quality selector: one per available video stream (the chosen one
 * selected), then one disabled option per premium-only quality (`1080P60 — premium only`).
 * @param {StreamChoice} streams
 * @param {(label: string) => string} premiumText the text of a premium-only option
 * @returns {QualityOption[]}
 */
export function qualityOptions(streams, premiumText) {
  /** @type {QualityOption[]} */
  const options = [];
  if (streams.kind === "hls") {
    streams.available.forEach((variant, index) => {
      options.push({
        value: String(index),
        label: streamLabel(variant),
        selected: variant === streams.variant,
        disabled: false,
      });
    });
    return options;
  }
  streams.available.forEach((rep, index) => {
    options.push({
      value: String(index),
      label: streamLabel({
        height: rep.height,
        width: rep.width,
        codecs: rep.codecs,
        bandwidth: rep.bandwidth,
      }),
      selected: rep === streams.video,
      disabled: false,
    });
  });
  for (const label of streams.missingPremium) {
    options.push({ value: "", label: premiumText(label), selected: false, disabled: true });
  }
  return options;
}

/**
 * The summary line's counts: rows (videos), rows resolved to a downloadable stream (detected),
 * rows that failed (`failed*`).
 * @param {readonly { status: string, detected: boolean }[]} rows
 * @returns {{ videos: number, detected: number, failed: number }}
 */
export function summaryCounts(rows) {
  return {
    videos: rows.length,
    detected: rows.filter((row) => row.detected).length,
    failed: rows.filter((row) => row.status.startsWith("failed")).length,
  };
}

/**
 * The rows of a run that did not download (`failed*`, `stopped`), in input order.
 * @param {Run} run
 * @returns {Row[]}
 */
export function notDownloaded(run) {
  return run.rows.filter((row) => NOT_DOWNLOADED_STATUSES.has(row.status));
}

/**
 * The pasted lines a retry runs again: those of the rows that did not download, once each, in
 * order.
 * @param {readonly { input: string }[]} rows
 * @returns {string[]}
 */
export function retryInputs(rows) {
  /** @type {string[]} */
  const lines = [];
  for (const row of rows) if (!lines.includes(row.input)) lines.push(row.input);
  return lines;
}

/**
 * What the history keeps of a pasted line (it stays in `chrome.storage.local` across restarts):
 * the item's canonical link — a Bilibili `?p=N` kept, a `b23.tv` short link its own path, every
 * other query parameter and fragment dropped, so the per-user identifiers of share links
 * (`vd_source`, `buvid`, `mid`, `bstar_from`, …) are never stored; a line that names no item
 * without the query strings of the URLs in it.
 * @param {string} line
 * @returns {string}
 */
export function historyLine(line) {
  const parsed = parseLine(line);
  return isRefused(parsed) ? stripUrlQueriesInText(line) : parsed.pageUrl;
}

/**
 * The history entry of a run.
 * @param {Run} run
 * @returns {HistoryEntry}
 */
export function historyEntry(run) {
  const failed = run.rows.filter((row) => row.status.startsWith("failed")).length;
  return {
    started_at: run.startedAt.toISOString(),
    finished_at: run.finishedAt === null ? null : run.finishedAt.toISOString(),
    stop_reason: run.stopReason,
    counts: {
      rows: run.rows.length,
      done: run.rows.filter((row) => row.status === "done").length,
      skipped: run.rows.filter((row) => row.status === "skipped-exists").length,
      failed,
      stopped: run.rows.filter((row) => row.status === "stopped").length,
    },
    retry_inputs: retryInputs(notDownloaded(run).map((row) => ({ input: historyLine(row.input) }))),
  };
}

/**
 * A history entry read back from storage, or null when it is not one.
 * @param {Record<string, unknown>} raw
 * @returns {HistoryEntry | null}
 */
export function parseHistoryEntry(raw) {
  const counts = raw["counts"];
  if (counts === null || typeof counts !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (counts);
  /** @param {unknown} value */
  const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  /** @param {unknown} value */
  const text = (value) => (typeof value === "string" ? value : null);
  const inputs = raw["retry_inputs"];
  return {
    started_at: text(raw["started_at"]),
    finished_at: text(raw["finished_at"]),
    stop_reason: text(raw["stop_reason"]),
    counts: {
      rows: number(record["rows"]),
      done: number(record["done"]),
      skipped: number(record["skipped"]),
      failed: number(record["failed"]),
      stopped: number(record["stopped"]),
    },
    retry_inputs: Array.isArray(inputs) ? inputs.filter((line) => typeof line === "string") : [],
  };
}

// ----------------------------------------------------------------------------- the page

const app = {
  testMode: false,
  owner: false,
  /** @type {Settings} */
  settings: copySettings(DEFAULT_SETTINGS),
  /** @type {TestSettings} */
  testSettings: {},
  /** @type {ResolveItem[]} the items of the box, in order */
  items: [],
  /** @type {Map<string, Resolved>} what Analyze (or a run) resolved, by item key */
  resolved: new Map(),
  /** @type {Map<string, RowView>} */
  rows: new Map(),
  /** @type {string[]} the row keys of the items table, in order */
  order: [],
  /** @type {AbortController | null} the job running, if any */
  job: null,
  /** @type {Run | null} the last run (the failed block and the report) */
  lastRun: null,
  /** @type {Row[]} the last run's rows that did not download */
  failed: [],
  /** @type {import("../lib/cooldown.js").Cooldown | null} */
  cooldown: null,
  files: new WorkFiles(),
};

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function $(id) {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`#${id} is missing from app.html`);
  return element;
}
/** @param {string} id */
const button = (id) => /** @type {HTMLButtonElement} */ ($(id));
/** @param {string} id */
const input = (id) => /** @type {HTMLInputElement} */ ($(id));
/** @param {string} id */
const select = (id) => /** @type {HTMLSelectElement} */ ($(id));
/** @param {string} id */
const textarea = (id) => /** @type {HTMLTextAreaElement} */ ($(id));

/**
 * A new element with a class and children.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [className]
 * @param {(Node | string)[]} [children]
 * @returns {HTMLElementTagNameMap[K]}
 */
function el(tag, className = "", children = []) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  for (const child of children) element.append(child);
  return element;
}

/**
 * @param {HTMLElement} element
 * @param {string} text
 * @param {"" | "ok" | "error"} [kind]
 */
function setText(element, text, kind = "") {
  element.textContent = text;
  element.className = kind ? `status ${kind}` : "status";
}

/** @returns {readonly string[]} the manifest's host permissions */
function hostPatterns() {
  return chrome.runtime.getManifest().host_permissions ?? [];
}

// ------------------------------------------------------------------------------ the rows

/**
 * The text of a row's hint (`hint_<code>` with `lib/messages.hintSubstitutions`: the same
 * parameters, in the same order, as the English `lib/messages.hintText`).
 * @param {string} code
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
function hintLine(code, params = {}) {
  return isHintCode(code) ? t(messageKey("hint", code), hintSubstitutions(code, params)) : code;
}

/**
 * The message of a row (the `.message` cell): its failure, its hints and notes, where it was
 * saved — `·`-separated — and, last, `; cover: <reason>` when the file was saved without its
 * cover (Addendum B.2).
 * @param {{ failure: Failure | null, site: string, hints: readonly { code: string,
 *   params: Record<string, unknown> }[], notes: readonly Note[], path: string | null,
 *   status: string }} row
 * @returns {string}
 */
export function rowMessage(row) {
  const lang = currentLanguage();
  /** @type {string[]} */
  const parts = [];
  if (row.failure !== null) parts.push(renderFailure(row.failure.code, row.failure.params, lang));
  if (row.failure?.code === "login_required" && row.site === "bilibilitv") {
    parts.push(hintLine("login_or_premium"));
  }
  for (const hint of row.hints) parts.push(hintLine(hint.code, hint.params));
  /** @type {string | null} */
  let cover = null;
  for (const note of row.notes) {
    if (note.code === "no_audio") parts.push(t("note_no_audio"));
    else if (note.code === "browser_unreadable") {
      parts.push(t("note_browser_unreadable", String(note.params["codec"] ?? "?")));
    } else if (note.code === "cover") {
      cover = t("note_cover", String(note.params["reason"] ?? "?"));
    }
  }
  if (row.path !== null && (row.status === "done" || row.status === "skipped-exists")) {
    parts.push(t("savedAs", fileBaseName(row.path)));
  }
  const text = parts.join(" · ");
  return cover === null ? text : `${text}; ${cover}`;
}

/**
 * @param {RowView} view
 * @returns {string} the row's message ({@link rowMessage})
 */
function messageOf(view) {
  return rowMessage({
    failure: view.failure,
    site: view.target?.site ?? view.item?.site ?? "",
    hints: view.target?.hints ?? [],
    notes: view.notes,
    path: view.path,
    status: view.status,
  });
}

/**
 * Write a row's status badge and message.
 * @param {RowView} view
 */
function renderStatus(view) {
  const badge = el("span", "badge", [statusLabel(view.status)]);
  badge.dataset["status"] = view.status;
  view.cells["status"]?.replaceChildren(badge);
  const message = view.cells["message"];
  if (message !== undefined) message.textContent = messageOf(view);
  view.tr.dataset["status"] = view.status;
}

/**
 * Write a row's progress (the bar and `12.3 MB · 1.2 MB/s`).
 * @param {RowView} view
 */
function renderProgress(view) {
  const cell = view.cells["progress"];
  if (cell === undefined) return;
  const bar = el("progress");
  const progress = view.progress;
  const fraction =
    progress === null ? (view.status === "done" ? 1 : null) : progressFraction(progress);
  if (view.status === "done") bar.value = 1;
  else if (fraction !== null) bar.value = fraction;
  else bar.removeAttribute("value");
  bar.max = 1;
  const text = el("span", "progress-text", [progress === null ? "" : progressText(progress)]);
  cell.replaceChildren(bar, text);
}

/**
 * The quality cell: the selector for a resolved row (disabled while a job runs), the chosen
 * label as text otherwise.
 * @param {RowView} view
 */
function renderQuality(view) {
  const cell = view.cells["quality"];
  const streams = view.target?.streams ?? null;
  if (cell === undefined) return;
  if (streams === null) {
    cell.textContent = "";
    return;
  }
  const selector = el("select", "quality-select");
  for (const option of qualityOptions(streams, (label) => t("premiumOption", label))) {
    const element = el("option", "", [option.label]);
    element.value = option.value;
    element.selected = option.selected;
    element.disabled = option.disabled;
    selector.append(element);
  }
  selector.disabled = app.job !== null || !app.owner || view.status !== "queued";
  selector.title = qualityLabel(streams);
  selector.addEventListener("change", () => {
    const target = view.target;
    if (target === null) return;
    if (selectStream(target, Number(selector.value))) renderQuality(view);
  });
  cell.replaceChildren(selector);
  cell.dataset["chosen"] = qualityLabel(streams);
}

/**
 * A new row of the items table.
 * @param {string} key
 * @param {"item" | "target"} kind
 * @param {{ item?: ResolveItem | null, target?: Target | null }} source
 * @returns {RowView}
 */
function makeRow(key, kind, source) {
  const tr = el("tr");
  tr.dataset["key"] = key;
  /** @type {Record<string, HTMLElement>} */
  const cells = {};
  const names = ["cover", "title", "site", "duration", "quality", "status", "progress", "message"];
  for (const name of names) {
    const cell = el("td", name);
    cells[name] = cell;
    tr.append(cell);
  }
  /** @type {RowView} */
  const view = {
    key,
    kind,
    tr,
    cells,
    item: source.item ?? null,
    target: source.target ?? null,
    status: "queued",
    failure: null,
    notes: [],
    path: null,
    progress: null,
    progressAt: 0,
  };
  fillRow(view);
  return view;
}

/**
 * Write every cell of a row from its item or target.
 * @param {RowView} view
 */
function fillRow(view) {
  const target = view.target;
  const site = target?.site ?? view.item?.site ?? "";
  /** @type {Record<string, HTMLElement>} */
  const cells = view.cells;
  const image = el("img", "cover placeholder");
  image.alt = "";
  cells["cover"]?.replaceChildren(image);
  if (target !== null && target.cover) covers.watch(image, view.key, target.cover);
  const link = el("a", "", [target === null ? (view.item?.original ?? "") : rowTitle(target)]);
  link.href = target?.pageUrl ?? view.item?.pageUrl ?? "#";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  cells["title"]?.replaceChildren(link);
  if (cells["site"]) cells["site"].textContent = siteName(site);
  if (cells["duration"]) {
    cells["duration"].textContent = target === null ? "" : formatDuration(target.durationS);
  }
  renderQuality(view);
  renderStatus(view);
  renderProgress(view);
}

/**
 * A target's title as its row shows it: `P02 · <part title> — <title>` for a part of a multi-part
 * Bilibili video, a Bilibili.tv episode's own title (`E3 - …`), else the video's title.
 * @param {Pick<Target, "site" | "id" | "title" | "part" | "partTitle">} target
 * @returns {string}
 */
export function rowTitle(target) {
  if (target.site === "bilibilitv") return target.partTitle || target.title || target.id;
  if (target.partTitle && target.part !== null) {
    return `P${String(target.part).padStart(2, "0")} · ${target.partTitle} — ${target.title}`;
  }
  return target.title || target.id;
}

/**
 * The group header row of an item with several targets (a series, a multi-part video).
 * @param {string} itemKey
 * @param {Target[]} targets
 * @returns {RowView}
 */
function makeGroupRow(itemKey, targets) {
  const tr = el("tr", "group");
  tr.dataset["group"] = itemKey;
  const first = targets[0];
  const title = first?.seriesTitle ?? first?.title ?? itemKey;
  const series = first?.site === "bilibilitv";
  const count = series ? t("groupEpisodes", targets.length) : t("groupParts", targets.length);
  const cell = el("td", "", [`${title} · ${count}`]);
  cell.colSpan = 8;
  tr.append(cell);
  return {
    key: `group:${itemKey}`,
    kind: "group",
    tr,
    cells: {},
    item: null,
    target: null,
    status: "queued",
    failure: null,
    notes: [],
    path: null,
    progress: null,
    progressAt: 0,
  };
}

/** Put the rows of {@link app.order} into the table, in order. */
function renderTable() {
  const table = $("items-table");
  const body = /** @type {HTMLElement} */ (table.querySelector("tbody") ?? table);
  /** @type {HTMLElement[]} */
  const rows = [];
  for (const key of app.order) {
    const view = app.rows.get(key);
    if (view !== undefined) rows.push(view.tr);
  }
  // Putting every row back costs a layout of the whole table — seconds once thousands of rows
  // have piled up without **Clear**, at every resolved link —, so the rows already shown in their
  // place stay: only what follows the first row out of place is put back (a link read into its
  // parts or episodes and the rows after it, the newest rows), nothing when the list is the same.
  const shown = body.children;
  let kept = 0;
  while (kept < shown.length && kept < rows.length && shown[kept] === rows[kept]) kept += 1;
  while (shown.length > kept) body.removeChild(/** @type {Element} */ (shown[shown.length - 1]));
  if (kept < rows.length) body.append(...rows.slice(kept));
  renderSummary();
}

/** The summary line: `N videos · M detected · K failed`. */
function renderSummary() {
  /** @type {{ status: string, detected: boolean }[]} */
  const rows = [];
  for (const key of app.order) {
    const view = app.rows.get(key);
    if (view === undefined || view.kind === "group") continue;
    rows.push({ status: view.status, detected: (view.target?.streams ?? null) !== null });
  }
  const counts = summaryCounts(rows);
  $("summary-line").textContent =
    counts.videos === 0 ? "" : t("summaryLine", [counts.videos, counts.detected, counts.failed]);
}

/**
 * The rows of an item once resolved: its targets (under a group header when there are several),
 * or the item's own row with its failure. A target that has a row already (the same video pasted
 * again, now or in an earlier run) keeps that row, refreshed; new rows take the item row's place.
 * @param {ResolveItem} item
 * @param {Resolved} resolved
 */
function showResolved(item, resolved) {
  if (isResolveFailure(resolved)) {
    let view = app.rows.get(item.key);
    if (view === undefined) {
      view = makeRow(item.key, "item", { item });
      app.rows.set(item.key, view);
      app.order.push(item.key);
    }
    view.status = resolved.status;
    view.failure = resolved.failure;
    if (resolved.title) {
      const link = view.cells["title"]?.querySelector("a");
      if (link) link.textContent = resolved.title;
    }
    renderStatus(view);
    renderTable();
    return;
  }
  /** @type {string[]} */
  const keys = [];
  if (resolved.length > 1 || item.kind === "series") {
    const group = makeGroupRow(item.key, resolved);
    const old = app.rows.get(group.key);
    if (old !== undefined) old.tr.replaceChildren(...group.tr.children);
    else app.rows.set(group.key, group);
    keys.push(group.key);
  }
  for (const target of resolved) {
    const existing = app.rows.get(target.key);
    const view = existing ?? makeRow(target.key, "target", { item, target });
    if (existing !== undefined) {
      existing.item = item;
      existing.target = target;
      existing.notes = [];
      existing.path = null;
      existing.progress = null;
      fillRow(existing);
    }
    view.status = target.status ?? "queued";
    view.failure = target.failure;
    renderStatus(view);
    renderQuality(view);
    app.rows.set(target.key, view);
    keys.push(target.key);
  }
  const fresh = keys.filter((key) => !app.order.includes(key));
  const at = app.order.indexOf(item.key);
  if (at >= 0 && !keys.includes(item.key)) {
    app.order.splice(at, 1, ...fresh); // the item's row gives way to its targets'
    app.rows.delete(item.key);
  } else if (at >= 0) {
    app.order.splice(at + 1, 0, ...fresh); // the item's row is its (first) target's
  } else {
    app.order.push(...fresh);
  }
  renderTable();
}

/**
 * Forget what an earlier job could not resolve for these items (a failure, or a target that
 * failed): it is asked again; a successful resolution is kept (a later download reuses it).
 * @param {ResolveItem[]} items
 */
function dropFailedResolutions(items) {
  for (const item of items) {
    const resolved = app.resolved.get(item.key);
    if (resolved === undefined) continue;
    if (isResolveFailure(resolved) || resolved.some((target) => target.failure !== null)) {
      app.resolved.delete(item.key);
    }
  }
}

/**
 * The rows of the box: one per item, added to the rows already shown (earlier runs stay until
 * **Clear**); an item resolved already shows its targets, a row shown already is kept.
 * @param {ResolveItem[]} items
 */
function showItems(items) {
  app.items = items;
  dropFailedResolutions(items);
  for (const item of items) {
    const resolved = app.resolved.get(item.key);
    if (resolved !== undefined) {
      showResolved(item, resolved);
      continue;
    }
    const existing = app.rows.get(item.key);
    if (existing !== undefined) {
      existing.status = "queued";
      existing.failure = null;
      renderStatus(existing);
      continue;
    }
    app.rows.set(item.key, makeRow(item.key, "item", { item }));
    app.order.push(item.key);
  }
  renderTable();
}

/**
 * The rows of a target (or of an item before it is resolved).
 * @param {string} key
 * @returns {RowView | undefined}
 */
function rowOf(key) {
  return app.rows.get(key);
}

/**
 * Re-write every row's texts (a language change).
 */
function rerenderAll() {
  for (const view of app.rows.values()) {
    if (view.kind === "group") continue;
    renderStatus(view);
  }
  renderFailedBlock();
  renderSummary();
  void renderHistory();
  void refreshCooldown();
}

// ---------------------------------------------------------------------- input and notes

/**
 * Parse the box; the refused and dropped lines listed under it.
 * @returns {ResolveItem[]}
 */
function parsedItems() {
  const parsed = parseInput(textarea("links").value);
  const notes = $("input-notes");
  /** @type {HTMLElement[]} */
  const lines = [];
  for (const refused of parsed.refused) {
    lines.push(el("li", "", [`${refused.original} — ${refusalLabel(refused.reason)}`]));
  }
  for (const dropped of parsed.dropped) lines.push(el("li", "", [t("droppedLine", dropped)]));
  notes.replaceChildren(...lines);
  return /** @type {ResolveItem[]} */ (/** @type {unknown} */ (parsed.items));
}

// ----------------------------------------------------------------------------- the jobs

/** The test base a site's Referer rule uses in test mode, else null. */
/**
 * @param {SiteName} site
 * @returns {string | null}
 */
function testBaseOf(site) {
  if (!app.testMode) return null;
  const bases = app.testSettings.baseUrls ?? {};
  return bases[site] ?? null;
}

/**
 * The engine's context of a job.
 * @param {AbortController} controller
 * @returns {import("./engine.js").EngineContext}
 */
function engineContext(controller) {
  const pacing = effectivePacing(app.settings, app.testSettings, app.testMode);
  const signal = controller.signal;
  /** @type {import("./downloader.js").NetContext} */
  const net = {
    fetch: (resource, init) => fetch(resource, init),
    hostPatterns: hostPatterns(),
    signal,
    stallMs: stallTimeoutS(pacing, app.testMode) * 1000,
    sleep: (seconds) => sleepSeconds(seconds, signal),
  };
  if (app.testMode && app.testSettings.retryBackoffS) net.backoffS = app.testSettings.retryBackoffS;
  const bases = basesFor(app.testMode ? app.testSettings.baseUrls : undefined);
  /** @type {import("./resolver.js").ResolveContext} */
  const resolveCtx = {
    net,
    prefs: { maxHeight: maxHeightOf(app.settings.quality), codec: app.settings.codec },
    bases,
    pagePause: () => net.sleep(pagePauseS(pacing)),
  };
  const applyReferer = (/** @type {SiteName} */ site) => applyRefererRule(site, testBaseOf(site));
  const view = new DownloadsView({
    rateLimitS: app.testMode ? (app.testSettings.existenceRateLimitS ?? 10) : 10,
    sleep: (seconds) => sleepSeconds(seconds, signal),
  });
  const browserTimeout = app.testMode
    ? (app.testSettings.browserCheckTimeoutS ?? BROWSER_CHECK_TIMEOUT_S)
    : BROWSER_CHECK_TIMEOUT_S;
  return {
    resolve: async (item) => {
      await applyReferer(item.site);
      return resolve(item, resolveCtx);
    },
    download: (target, onProgress, onStatus) =>
      download(target, {
        net,
        pacing,
        files: app.files,
        view,
        save: (blob, filename) => saveBlob(blob, filename),
        applyReferer,
        refresh: (stale) => refreshStreams(stale, resolveCtx),
        pagePause: resolveCtx.pagePause,
        browserCheck: (blob) => browserDuration(blob, browserTimeout),
        cover: app.settings.cover,
        toJpeg: (image) => jpegFromImage(image),
        onProgress,
        onStatus,
      }),
    pacing,
    signal,
    sleep: net.sleep,
    readCooldown,
    writeCooldown,
    emit: onEngineEvent,
    resolved: app.resolved,
    settings: copySettings(app.settings),
  };
}

/**
 * What the engine reports, on the page.
 * @param {EngineEvent} event
 */
function onEngineEvent(event) {
  switch (event.type) {
    case "item-resolving": {
      const view = rowOf(event.item.key);
      if (view !== undefined) {
        view.status = "resolving";
        renderStatus(view);
      }
      setText($("activity"), t("activityResolving", event.item.original));
      break;
    }
    case "item-resolved":
      showResolved(event.item, event.resolved);
      break;
    case "item-stopped": {
      const view = rowOf(event.item.key);
      if (view !== undefined) {
        view.status = "stopped";
        view.failure = event.failure;
        renderStatus(view);
        renderSummary();
      }
      break;
    }
    case "target-status": {
      const view = rowOf(event.target.key);
      if (view === undefined) break;
      view.status = event.status;
      if (event.failure !== undefined) view.failure = event.failure;
      renderStatus(view);
      renderQuality(view);
      if (event.status === "downloading") {
        setText($("activity"), t("activityDownloading", rowTitle(event.target)));
      }
      break;
    }
    case "target-progress": {
      const view = rowOf(event.target.key);
      if (view === undefined) break;
      view.progress = event.progress;
      const now = Date.now();
      if (now - view.progressAt >= PROGRESS_INTERVAL_MS) {
        view.progressAt = now;
        renderProgress(view);
      }
      break;
    }
    case "target-done": {
      const view = rowOf(event.target.key);
      if (view === undefined) break;
      view.status = event.result.status;
      view.failure = event.result.failure;
      view.notes = event.result.notes;
      view.path = event.result.path;
      renderStatus(view);
      renderProgress(view);
      renderQuality(view);
      renderSummary();
      break;
    }
    case "pause":
      setText(
        $("activity"),
        t(
          event.kind === "video" ? "activityPauseVideo" : "activityPausePage",
          event.seconds.toFixed(1),
        ),
      );
      break;
    case "cooldown":
      void refreshCooldown();
      break;
    case "stopped":
      setText($("activity"), t("activityStopped", stopReasonLabel(event.reason)));
      break;
    case "finished":
      break;
    default:
      break;
  }
}

/**
 * The buttons as the page's state allows them: nothing starts in a read-only tab or while a job
 * runs; Stop only while one does.
 */
function updateButtons() {
  const idle = app.job === null && app.owner;
  button("analyze-button").disabled = !idle;
  button("download-all-button").disabled = !idle;
  button("clear-button").disabled = !idle;
  button("retry-button").disabled = !idle || app.failed.length === 0;
  button("report-button").disabled = !app.owner || app.lastRun === null || app.failed.length === 0;
  button("stop-button").disabled = app.job === null;
  const status = $("app-status");
  status.dataset["state"] = app.job !== null ? "running" : app.owner ? "idle" : "readonly";
  status.textContent = t(
    app.job !== null ? "appStatusRunning" : app.owner ? "appStatusIdle" : "appStatusReadonly",
  );
}

/**
 * Whether a start is refused by the cooldown in force (the activity line says how long).
 * @returns {Promise<boolean>}
 */
async function refusedByCooldown() {
  const params = cooldownMessageParams(await readCooldown());
  if (params === null) return false;
  setText($("activity"), renderFailure("cooldown", params), "error");
  return true;
}

/**
 * Run a job (Analyze or a download run) with its own Stop.
 * @param {(ctx: import("./engine.js").EngineContext) => Promise<Run>} work
 * @returns {Promise<Run | null>}
 */
async function runJob(work) {
  if (app.job !== null || !app.owner) return null;
  if (await refusedByCooldown()) return null;
  const controller = new AbortController();
  app.job = controller;
  updateButtons();
  await covers.idle(); // a cover request in flight ends before the job's first request
  for (const view of app.rows.values()) renderQuality(view);
  try {
    return await work(engineContext(controller));
  } catch (error) {
    setText($("activity"), oneLine(error), "error");
    return null;
  } finally {
    app.job = null;
    updateButtons();
    for (const view of app.rows.values()) renderQuality(view);
    void refreshCooldown();
    covers.resume();
  }
}

/** **Analyze**: every row resolved, nothing downloaded. */
async function onAnalyze() {
  if (app.job !== null || !app.owner) return;
  const items = parsedItems();
  showItems(items);
  if (items.length === 0) {
    setText($("activity"), t("noLinks"), "error");
    return;
  }
  const run = await runJob((ctx) => analyzeBatch(items, ctx));
  if (run !== null) setText($("activity"), t("activityAnalyzed", run.rows.length), "ok");
}

/** **Download all**: every row of the box with its own selection. */
async function onDownloadAll() {
  if (app.job !== null || !app.owner) return;
  const items = parsedItems();
  showItems(items);
  if (items.length === 0) {
    setText($("activity"), t("noLinks"), "error");
    return;
  }
  await startRun(items);
}

/**
 * A download run over `items`; at its end the failed block, the report and the history.
 * @param {ResolveItem[]} items
 */
async function startRun(items) {
  clearFailedBlock();
  const run = await runJob((ctx) => runBatch(items, ctx));
  if (run === null) return;
  await endOfRun(run);
}

/** **Stop**: the current request ends, the rest of the run is `stopped`. */
function onStop() {
  app.job?.abort(new StopRequested("user"));
}

/** **Clear**: the box, the rows and the failed block emptied. */
function onClear() {
  if (app.job !== null) return;
  textarea("links").value = "";
  app.items = [];
  app.resolved.clear();
  app.rows = new Map();
  app.order = [];
  covers.forget();
  $("input-notes").replaceChildren();
  clearFailedBlock();
  renderTable();
  setText($("activity"), "");
}

// --------------------------------------------------------------------- the failed block

function clearFailedBlock() {
  app.failed = [];
  app.lastRun = null;
  renderFailedBlock();
  setText($("failed-report"), "");
  updateButtons();
}

/** The failed block: the rows the last run did not download, with Retry and the report. */
function renderFailedBlock() {
  const block = $("failed-block");
  const table = $("failed-table");
  const body = /** @type {HTMLElement} */ (table.querySelector("tbody") ?? table);
  if (app.failed.length === 0) {
    block.hidden = true;
    body.replaceChildren();
    return;
  }
  block.hidden = false;
  $("failed-heading").textContent = t("failedHeading", app.failed.length);
  const lang = currentLanguage();
  body.replaceChildren(
    ...app.failed.map((row) => {
      const tr = el("tr");
      tr.dataset["key"] = row.key;
      const badge = el("span", "badge", [statusLabel(row.status, lang)]);
      badge.dataset["status"] = row.status;
      const status = el("td", "status", [badge]);
      tr.append(
        el("td", "title", [row.title ?? row.input]),
        el("td", "site", [siteName(row.site)]),
        status,
        el("td", "message", [
          row.failure === null ? "" : renderFailure(row.failure.code, row.failure.params, lang),
        ]),
      );
      return tr;
    }),
  );
  updateButtons();
}

/**
 * The end of a download run: the rows it did not download are listed again in the failed block
 * (they keep their row in the table, with its status and message), the report is saved (setting
 * on, failures present), the run joins the history.
 * @param {Run} run
 */
async function endOfRun(run) {
  app.lastRun = run;
  app.failed = notDownloaded(run);
  renderTable();
  renderFailedBlock();
  if (app.failed.length > 0 && app.settings.report && hasFailures(run)) await saveReport();
  const entry = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (historyEntry(run)));
  await appendHistory(entry);
  await renderHistory();
  const done = run.rows.filter((row) => row.status === "done").length;
  setText($("activity"), t("activityFinished", [done, run.rows.length]), "ok");
}

/** Save the last run's report under `StreamFetch/reports/`; the outcome under the block. */
async function saveReport() {
  const run = app.lastRun;
  if (run === null) return;
  try {
    const report = buildReport(run, {
      extensionVersion: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      language: currentLanguage(),
      testMode: app.testMode,
    });
    const blob = new Blob([reportJson(report)], { type: "application/json" });
    const saved = await saveBlob(blob, reportPath(new Date()));
    setText($("failed-report"), t("reportSaved", fileBaseName(saved.filename)), "ok");
  } catch (error) {
    setText($("failed-report"), t("reportNotSaved", oneLine(error)), "error");
  }
}

/**
 * **Retry**: one new run over exactly the given pasted lines.
 * @param {string[]} lines
 */
async function retryLines(lines) {
  if (app.job !== null || !app.owner || lines.length === 0) return;
  textarea("links").value = lines.join("\n");
  const items = parsedItems();
  for (const item of items) app.resolved.delete(item.key);
  showItems(items);
  await startRun(items);
}

// ------------------------------------------------------------------------------ history

/** The history list: the last runs, each with its counts and a Retry of what did not download. */
async function renderHistory() {
  const list = $("history-list");
  const entries = (await readHistory()).map(parseHistoryEntry).filter((entry) => entry !== null);
  if (entries.length === 0) {
    list.replaceChildren(el("li", "hint", [t("historyEmpty")]));
    return;
  }
  list.replaceChildren(
    ...entries.map((entry) => {
      const when = entry.started_at === null ? "?" : new Date(entry.started_at).toLocaleString();
      const counts = t("historyCounts", [
        entry.counts.rows,
        entry.counts.done,
        entry.counts.skipped,
        entry.counts.failed,
        entry.counts.stopped,
      ]);
      const item = el("li", "", [`${when} — ${counts}`]);
      if (entry.stop_reason) item.append(` — ${stopReasonLabel(entry.stop_reason)}`);
      if (entry.retry_inputs.length > 0) {
        const retry = el("button", "retry", [t("historyRetry", entry.retry_inputs.length)]);
        retry.type = "button";
        retry.disabled = app.job !== null || !app.owner;
        retry.addEventListener("click", () => void retryLines(entry.retry_inputs));
        item.append(retry);
      }
      return item;
    }),
  );
}

// ------------------------------------------------------------------------------ cooldown

/** Read the cooldown and show (or hide) the banner. */
async function refreshCooldown() {
  app.cooldown = await loadActiveCooldown();
  tickCooldown();
}

/** The banner's text, once a second while a cooldown is in force. */
function tickCooldown() {
  const banner = $("cooldown-banner");
  const params = app.cooldown === null ? null : cooldownMessageParams(app.cooldown);
  if (params === null) {
    banner.hidden = true;
    if (app.cooldown !== null) {
      app.cooldown = null;
      covers.resume();
    }
    return;
  }
  banner.hidden = false;
  const substitutions = [params.until, params.minutes_left, cooldownReasonLabel(params.reason)];
  $("cooldown-text").textContent = t("cooldownText", substitutions);
}

// ------------------------------------------------------------------------------ settings

/** The form from the settings. */
function fillSettings() {
  const settings = app.settings;
  select("setting-quality").value = settings.quality;
  select("setting-codec").value = settings.codec;
  input("setting-video-pause-min").value = String(settings.videoPauseS[0]);
  input("setting-video-pause-max").value = String(settings.videoPauseS[1]);
  input("setting-page-pause-min").value = String(settings.pagePauseS[0]);
  input("setting-page-pause-max").value = String(settings.pagePauseS[1]);
  input("setting-media-pause-min").value = String(settings.mediaPauseMs[0]);
  input("setting-media-pause-max").value = String(settings.mediaPauseMs[1]);
  input("setting-report").checked = settings.report;
  select("setting-cover").value = settings.cover;
  select("setting-language").value = settings.language;
}

/**
 * The settings the form holds.
 * @returns {Record<string, unknown>}
 */
function formSettings() {
  /** @param {string} id */
  const number = (id) => Number(input(id).value);
  return {
    quality: select("setting-quality").value,
    codec: select("setting-codec").value,
    videoPauseS: [number("setting-video-pause-min"), number("setting-video-pause-max")],
    pagePauseS: [number("setting-page-pause-min"), number("setting-page-pause-max")],
    mediaPauseMs: [number("setting-media-pause-min"), number("setting-media-pause-max")],
    report: input("setting-report").checked,
    cover: select("setting-cover").value,
    language: select("setting-language").value,
  };
}

/**
 * **Save settings**: checked first (pauses only longer than the floors); the language applied at
 * once.
 * @param {Event} event
 */
async function onSaveSettings(event) {
  event.preventDefault();
  const candidate = formSettings();
  const problem = settingsProblem(candidate, app.testMode);
  if (problem !== null) {
    setText($("settings-problem"), problem, "error");
    return;
  }
  try {
    const settings = copySettings(/** @type {Settings} */ (/** @type {unknown} */ (candidate)));
    await saveSettings(settings);
    app.settings = settings;
    setLanguage(displayLanguage(settings));
    localize();
    rerenderAll();
    updateButtons();
    setText($("settings-problem"), t("settingsSaved"), "ok");
  } catch (error) {
    setText($("settings-problem"), oneLine(error), "error");
  }
}

// -------------------------------------------------------------------------------- covers

/**
 * The cover thumbnails of the rows, fetched by the extension itself and only for rows in view:
 * one request at a time, each after a media pause, never while a job runs or a cooldown is in
 * force, only to a host the manifest covers; a broken or missing cover keeps the neutral frame.
 * A 429 or 412 on a thumbnail (`fetchCover` rejects with that `rate_limited` step) is a refusal
 * like anywhere else: the loader asks for nothing more for the page's life and `onRefused` records
 * the cooldown. Only the one cover embedded in a file is exempt (Addendum B.2), not the list's.
 */
export class CoverLoader {
  /**
   * @param {{ allowed: () => boolean, fetchCover: (url: string) => Promise<Blob | null>,
   *   pause: () => Promise<void>, objectUrl?: (blob: Blob) => string,
   *   onRefused?: (failure: import("../lib/messages.js").Failure, key: string) => unknown,
   *   watcher?: (callback: (entries: readonly { target: Element,
   *     isIntersecting: boolean }[]) => void) =>
   *     { observe: (target: Element) => void, unobserve: (target: Element) => void } }} options
   */
  constructor(options) {
    this.options = options;
    this.objectUrl = options.objectUrl ?? ((blob) => URL.createObjectURL(blob));
    /** @type {Map<string, string>} key → object URL, for the page's life */
    this.loaded = new Map();
    /** @type {Set<string>} keys asked for already (loaded or failed) */
    this.asked = new Set();
    /** @type {Map<string, { image: HTMLImageElement, url: string }>} rows watched */
    this.cells = new Map();
    /** @type {WeakMap<Element, string>} */
    this.keyOf = new WeakMap();
    /** @type {Set<string>} rows in view */
    this.visible = new Set();
    /** @type {string[]} rows in view, in the order they came into view */
    this.queue = [];
    /** @type {{ observe: (target: Element) => void,
     *   unobserve: (target: Element) => void } | null} */
    this.watcher = null;
    /** @type {Promise<void> | null} */
    this.running = null;
    /** a thumbnail was refused (429 / 412): nothing more is asked for the page's life */
    this.halted = false;
  }

  /**
   * Watch a row's cover: wanted while the row is in view.
   * @param {HTMLImageElement} image
   * @param {string} key
   * @param {string} url
   */
  watch(image, key, url) {
    const known = this.loaded.get(key);
    if (known !== undefined) {
      image.src = known;
      image.className = "cover";
      return;
    }
    if (this.asked.has(key)) return;
    this.cells.set(key, { image, url });
    this.keyOf.set(image, key);
    if (this.watcher === null) {
      const make =
        this.options.watcher ??
        ((callback) => new IntersectionObserver(callback, { rootMargin: "64px 0px" }));
      this.watcher = make((entries) => {
        for (const entry of entries) {
          const id = this.keyOf.get(entry.target);
          if (id === undefined) continue;
          if (entry.isIntersecting) {
            this.visible.add(id);
            if (!this.queue.includes(id)) this.queue.push(id);
          } else {
            this.visible.delete(id);
          }
        }
        this.resume();
      });
    }
    this.watcher.observe(image);
  }

  /**
   * Forget the rows still watched (**Clear**): their images — and through them the rows and their
   * targets — are let go. What was asked for stays asked: a thumbnail is never requested twice.
   */
  forget() {
    for (const cell of this.cells.values()) this.watcher?.unobserve(cell.image);
    this.cells.clear();
    this.visible.clear();
    this.queue.length = 0;
  }

  /** @returns {string | null} the next cover to fetch: a row in view, not asked yet */
  next() {
    const wanted = (/** @type {string} */ key) =>
      this.visible.has(key) && !this.asked.has(key) && this.cells.has(key);
    return this.queue.find(wanted) ?? null;
  }

  /** @returns {Promise<void>} once no cover request is in flight */
  async idle() {
    while (this.running !== null) await this.running;
  }

  /** Go on fetching (a row came into view, a job ended, a cooldown ran out); one loop at a time. */
  resume() {
    if (this.running !== null || this.halted || !this.options.allowed()) return;
    if (this.next() === null) return;
    this.running = this.loop()
      .catch(() => undefined)
      .finally(() => {
        this.running = null;
      });
  }

  /** @returns {Promise<void>} */
  async loop() {
    while (!this.halted && this.options.allowed() && this.next() !== null) {
      await this.options.pause();
      if (this.halted || !this.options.allowed()) return; // asked again right before the request
      const key = this.next();
      if (key === null) return;
      this.asked.add(key);
      const cell = /** @type {{ image: HTMLImageElement, url: string }} */ (this.cells.get(key));
      this.cells.delete(key);
      this.watcher?.unobserve(cell.image);
      /** @type {Blob | null} */
      let blob = null;
      try {
        blob = await this.options.fetchCover(cell.url);
      } catch (error) {
        if (error instanceof StepFailure && error.failure.code === "rate_limited") {
          this.halted = true;
          await this.options.onRefused?.(error.failure, key);
          return;
        }
      }
      if (blob === null) continue;
      const url = this.objectUrl(blob);
      this.loaded.set(key, url);
      cell.image.src = url;
      cell.image.className = "cover";
    }
  }
}

/**
 * One cover GET of the extension's own (the manifest's hosts, the session's cookies), at most
 * {@link MAX_THUMBNAIL_BYTES}; null for anything that is not an image or did not arrive; a 429 or
 * 412 rejects with its `rate_limited` step (the loader stops and the cooldown starts).
 * @param {string} url
 * @returns {Promise<Blob | null>}
 */
async function fetchCover(url) {
  const controller = new AbortController();
  const pacing = effectivePacing(app.settings, app.testSettings, app.testMode);
  /** @type {import("./downloader.js").NetContext} */
  const net = {
    fetch: (resource, init) => fetch(resource, init),
    hostPatterns: hostPatterns(),
    signal: controller.signal,
    stallMs: stallTimeoutS(pacing, app.testMode) * 1000,
    sleep: (seconds) => sleepSeconds(seconds, controller.signal),
  };
  try {
    const opened = await request(coverUrl(url, net.hostPatterns), "cover", net, [], {
      accept: "image/*",
    });
    const type = opened.attempt.content_type ?? "";
    /** @type {Uint8Array[]} */
    const chunks = [];
    await readBody(opened, net, (chunk) => void chunks.push(chunk.slice()), {
      maxBytes: MAX_THUMBNAIL_BYTES,
    });
    if (!type.toLowerCase().startsWith("image/")) return null;
    return new Blob(/** @type {BlobPart[]} */ (chunks), { type });
  } catch (error) {
    if (error instanceof StepFailure && error.failure.code === "rate_limited") throw error;
    return null;
  }
}

/**
 * A thumbnail the site refused (429 / 412): the cooldown is recorded, as for any refusal, and the
 * banner shows it.
 * @param {import("../lib/messages.js").Failure} refused
 * @param {string} key the row's key (`<site>:…`)
 */
async function onCoverRefused(refused, key) {
  const site = key.split(":")[0] ?? "";
  await writeCooldown(makeCooldown(cooldownReason(refused), site));
  await refreshCooldown();
}

const covers = new CoverLoader({
  allowed: () => app.job === null && app.cooldown === null && app.owner,
  fetchCover,
  onRefused: onCoverRefused,
  pause: () => {
    const pacing = effectivePacing(app.settings, app.testSettings, app.testMode);
    return sleepSeconds(mediaPauseMs(pacing) / 1000);
  },
});

// ---------------------------------------------------------------------------- test mode

async function setupTestMode() {
  if (!app.testMode) return;
  $("test-card").hidden = false;
  textarea("test-settings").value = JSON.stringify(app.testSettings);
  button("test-settings-save").addEventListener("click", async () => {
    try {
      const raw = JSON.parse(textarea("test-settings").value || "{}");
      app.testSettings = await saveTestSettings(raw);
      textarea("test-settings").value = JSON.stringify(app.testSettings);
      setText($("test-settings-status"), `saved: ${JSON.stringify(app.testSettings)}`, "ok");
    } catch (error) {
      setText($("test-settings-status"), oneLine(error), "error");
    }
  });
}

// --------------------------------------------------------------------------------- start

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
 * Put links into the box (the popup's "Download this video"): appended to what is there, in the
 * engine's tab only.
 * @param {string} links
 */
function addLinks(links) {
  if (!app.owner) return;
  const box = textarea("links");
  box.value = box.value.trim() ? `${box.value.trim()}\n${links}` : links;
}

async function main() {
  await loadCatalogs();
  app.settings = await loadSettings();
  setLanguage(displayLanguage(app.settings));
  localize();
  $("version").textContent = chrome.runtime.getManifest().version;
  app.testMode = isTestMode();
  app.owner = await acquireEngine();
  $("readonly-banner").hidden = app.owner;
  app.testSettings = await loadTestSettings();
  fillSettings();
  await setupTestMode();

  button("analyze-button").addEventListener("click", () => void onAnalyze());
  button("download-all-button").addEventListener("click", () => void onDownloadAll());
  button("stop-button").addEventListener("click", onStop);
  button("clear-button").addEventListener("click", onClear);
  button("retry-button").addEventListener("click", () => void retryLines(retryInputs(app.failed)));
  button("report-button").addEventListener("click", () => void saveReport());
  $("settings-form").addEventListener("submit", (event) => void onSaveSettings(event));
  button("clear-cooldown-button").addEventListener("click", async () => {
    await clearCooldown();
    await refreshCooldown();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.hasOwn(changes, COOLDOWN_STORAGE_KEY)) void refreshCooldown();
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id) return; // only this extension's own code
    if (message !== null && typeof message === "object") {
      const record = /** @type {Record<string, unknown>} */ (message);
      if (record["type"] === "streamfetch:links" && typeof record["links"] === "string") {
        addLinks(record["links"]);
      }
    }
  });
  setInterval(tickCooldown, 1000);

  await refreshCooldown();
  await renderHistory();
  renderTable();
  updateButtons();
  if (app.owner) void app.files.sweep().catch(() => undefined);
  const links = new URLSearchParams(location.search).get("links");
  if (links) {
    history.replaceState(null, "", location.pathname);
    addLinks(links);
  }
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") void main();
