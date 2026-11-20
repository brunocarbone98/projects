// @ts-check
/**
 * The alerts of DramaFetch 1.7.0 — the owner's request of 2026-11-19: “an alert that tells me a
 * drama has been downloaded completely, or that one or more episodes need a retry”. One Chrome
 * notification (a Windows toast) per drama a download job finishes — **Download all**, **Download
 * selected dramas**, **Download selected**, **Download all available**, **Retry** —, made by the
 * DramaFetch tab that ran the job (`app.js`, once the drama's rows and records are stored) and
 * clicked in the worker (`background.js`):
 *
 * - **complete** — `✓ <drama> — downloaded` / `All 60 episodes are on disk.`: the drama's report
 *   says complete, the locked episodes left out as its report line says (`— 2 locked (61, 62)`);
 *   when the account may play none of them (every one locked), `<drama> — nothing your account may
 *   play` / `Your account may play none of its episodes — 5 locked (1-5).`: nothing was saved;
 * - **retry** — `⚠ <drama> — 3 episodes to retry` / `E03, E07, E12 did not download.` (at most
 *   {@link MAX_NAMED_EPISODES} of them, then `and N more`): the rows the tab's **Retry** takes for
 *   that drama (`app.retryTargets`), the stop's reason as the context when the run stopped, and ONE
 *   button, **Retry**, which the worker hands to the page that holds it;
 * - **incomplete** — `<drama> — not complete` / the tab's report line: nothing to retry, but not
 *   complete either (a gap in TikTok's list, an episode TikTok did not list, a list it refused);
 * - **stopped** — at the end of a job that stopped with dramas never started — its own, or those of
 *   the download jobs its stop took out of the queue —, one more: `DramaFetch stopped: <reason>` /
 *   `N dramas were not started — download them again later`.
 *
 * Nothing for a drama skipped as complete or refused before any request, nothing of their own for a
 * listing or a removal from the Bookmark (`app.js` asks only for download jobs' dramas), nothing for
 * a job refused at its gate, nor while the **Alert me when a drama finishes** setting is off.
 * Plain text in the page's display language
 * (`t()`, and the engine's English texts through `lib/display` as the tab shows them); the drama's
 * name cut to {@link MAX_NAME_LENGTH}; never a URL — an address in a text is replaced by its host
 * name ({@link plainText}) —, a cookie or anything signed. A notification Chrome refuses — a thrown
 * call, a rejected promise, no `chrome.notifications` in a copy without the permission — is noted
 * and dropped: the job never waits for one and never sees its fate.
 */

import { numbersText, reportLine } from "../lib/report.js";
import { t } from "./i18n.js";

/** What every DramaFetch notification id starts with (the worker answers only those). */
export const ALERT_ID_PREFIX = "dramafetch-alert:";
/** The notification's icon, shipped with the extension (resolved from its root, not the page's folder). */
export const ALERT_ICON = "icons/icon128.png";
/** At most this many characters of a drama's name in a title (the tab's title, cut with `…`). */
export const MAX_NAME_LENGTH = 60;
/** At most this many episodes named in a message; the rest is `and N more`. */
export const MAX_NAMED_EPISODES = 10;
/** At most this many characters of an engine text (a report line, a stop's reason) in a notification. */
export const MAX_TEXT_LENGTH = 200;

/**
 * @typedef {import("./engine.js").SeriesRun} SeriesRun
 * @typedef {import("./app.js").RetryTarget} RetryTarget
 *
 * @typedef {"complete" | "retry" | "incomplete" | "stopped"} AlertKind
 *
 * @typedef {object} AlertTexts What one notification says.
 * @property {AlertKind} kind
 * @property {string} title
 * @property {string} message
 * @property {string | null} context Chrome's `contextMessage` (the stop's reason), or none
 */

/**
 * @param {string} notificationId
 * @returns {boolean} whether it is one of DramaFetch's alerts
 */
export function isAlertId(notificationId) {
  return notificationId.startsWith(ALERT_ID_PREFIX);
}

/**
 * `E01`: an episode number as the progress rows and the history show it.
 * @param {number} number
 * @returns {string}
 */
export function episodeLabel(number) {
  return `E${String(number).padStart(2, "0")}`;
}

/**
 * `text` as a notification may carry it: one line (control characters and line breaks a space),
 * every address replaced by its host name (`page: https://www.tiktok.com/shortdrama/…` → `page:
 * www.tiktok.com`; a `user:password@` before the host goes with the path, the query and the
 * fragment), at most `max` characters — code points, so an emoji is never cut in half —, a longer
 * one cut with `…`.
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function plainText(text, max = MAX_TEXT_LENGTH) {
  const line = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^/\s?#)@]*@)?([^/\s?#)@]*)[^\s)]*/gi, "$1")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
  const points = [...line];
  return points.length <= max ? line : `${points.slice(0, max - 1).join("")}…`;
}

/**
 * The texts of the notification of a drama a download job finished, or null when it gets none:
 * skipped as complete (no request was made), or refused before any request (a cooldown or a write
 * the storage refused at its gate) or never started (after a stop). `target` is what the tab's
 * **Retry** takes for that drama (`app.retryTargets` over its record), null when nothing.
 * @param {SeriesRun} run
 * @param {RetryTarget | null} target
 * @param {(text: string) => string} show an engine text as the tab shows it (`lib/display`)
 * @returns {AlertTexts | null}
 */
export function dramaAlert(run, target, show) {
  const report = run.report;
  if (report.skippedComplete) return null;
  if (!run.contacted && run.results.length === 0) return null;
  const name = plainText(report.name || run.series?.name || run.ref.seriesId, MAX_NAME_LENGTH);
  if (target !== null && target.numbers.length > 0) {
    const numbers = target.numbers;
    const named = numbers.slice(0, MAX_NAMED_EPISODES).map(episodeLabel).join(", ");
    const episodes = numbers.length > MAX_NAMED_EPISODES ? t("alertMore", [named, numbers.length - MAX_NAMED_EPISODES]) : named;
    const one = numbers.length === 1;
    return {
      kind: "retry",
      title: one ? t("alertRetryTitleOne", [name]) : t("alertRetryTitle", [name, numbers.length]),
      message: t(one ? "alertRetryMessageOne" : "alertRetryMessage", [episodes]),
      context: report.stopped ? plainText(show(report.stopped)) : null,
    };
  }
  if (report.complete) {
    const have = report.done + report.onDisk;
    // the locked ones in the words of the report line (`2 locked (61, 62)`), as the tab shows them
    const locked = report.locked > 0 ? ` — ${plainText(show(`${report.locked} locked (${numbersText(report.lockedNumbers)})`))}` : "";
    // one on disk: `1 episode is on disk` — never “its only episode”: locked ones may sit beside it;
    // none: every episode is locked (complete all the same: there is nothing the session may play),
    // and its title says so — no ✓, no “downloaded”: nothing was saved
    const message = have > 1 ? t("alertAllOnDisk", [have, locked]) : t(have === 1 ? "alertOneOnDisk" : "alertNoneOnDisk", [locked]);
    const title = have === 0 ? t("alertNothingPlayableTitle", [name]) : t("alertCompleteTitle", [name]);
    return { kind: "complete", title, message, context: null };
  }
  return {
    kind: "incomplete",
    title: t("alertIncompleteTitle", [name]),
    message: plainText(show(run.error !== null ? run.error : reportLine(report))), // what the tab's report line shows
    context: null,
  };
}

/**
 * The texts of the one notification at the end of a job that stopped with dramas never started —
 * a download job's own, or those of the download jobs its stop took out of the queue.
 * @param {string} reason why the job stopped (an engine text: `stopped by you`, a stop summary, …)
 * @param {number} notStarted how many dramas were not started (at least one)
 * @param {(text: string) => string} show
 * @returns {AlertTexts}
 */
export function stoppedAlert(reason, notStarted, show) {
  return {
    kind: "stopped",
    title: t("alertStoppedTitle", [plainText(show(reason))]),
    message: notStarted === 1 ? t("alertNotStartedOne") : t("alertNotStarted", [notStarted]),
    context: null,
  };
}

/**
 * Chrome's options for `texts`: a basic notification with DramaFetch's icon, an ordinary priority,
 * not held on screen (Windows keeps it in its notification centre), with Windows' sound; the
 * **Retry** button on a retry alert only.
 * @param {AlertTexts} texts
 * @returns {chrome.notifications.NotificationOptions}
 */
export function notificationOptions(texts) {
  /** @type {chrome.notifications.NotificationOptions} */
  const options = {
    type: "basic",
    iconUrl: chrome.runtime.getURL(ALERT_ICON),
    title: texts.title,
    message: texts.message,
    priority: 0,
    requireInteraction: false,
    silent: false,
  };
  if (texts.context !== null && texts.context !== "") options.contextMessage = texts.context;
  if (texts.kind === "retry") options.buttons = [{ title: t("alertRetryButton") }];
  return options;
}

/**
 * Call `chrome.notifications` and let go: a thrown call or a rejected promise is noted and
 * `onRefused` runs; without the API (a copy without the permission) nothing happens at all.
 * Nobody waits for the answer.
 * @param {(api: typeof chrome.notifications) => unknown} call
 * @param {() => void} [onRefused]
 */
function send(call, onRefused) {
  const api = chrome.notifications;
  if (api === undefined) {
    onRefused?.();
    return;
  }
  /** @param {unknown} error */
  const refused = (error) => {
    console.warn("DramaFetch: a notification was refused:", error);
    onRefused?.();
  };
  try {
    Promise.resolve(call(api)).catch(refused);
  } catch (error) {
    refused(error);
  }
}

/**
 * The notifications one DramaFetch page made, and the retry each **Retry** button stands for. Its
 * ids are this page's own (`dramafetch-alert:<page>:<job>:<drama>:<kind>`): a page reloaded since
 * — or another one — never holds an earlier page's retry, and the worker then only opens or focuses
 * the DramaFetch tab.
 */
export class PageAlerts {
  constructor() {
    /** this page's mark in its ids: when it started, and a few random letters */
    this.page = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    /** @type {Map<string, RetryTarget>} the retry of each retry alert shown, by notification id */
    this.retries = new Map();
  }

  /**
   * @param {number} jobId
   * @param {string} part `<series id>:<kind>`, or `stopped`
   * @returns {string}
   */
  idOf(jobId, part) {
    return `${ALERT_ID_PREFIX}${this.page}:${jobId}:${part}`;
  }

  /**
   * Show a notification (never throws, never waits); `target` is what its **Retry** queues.
   * @param {string} id
   * @param {AlertTexts} texts
   * @param {RetryTarget | null} [target]
   */
  show(id, texts, target = null) {
    if (target !== null) this.retries.set(id, target);
    send(
      (api) => api.create(id, notificationOptions(texts)),
      () => this.retries.delete(id),
    );
  }

  /**
   * @param {string} id
   * @returns {RetryTarget | null} the retry a retry alert of this page stands for
   */
  retryOf(id) {
    return this.retries.get(id) ?? null;
  }

  /**
   * Take a notification away (its retry queued); never throws.
   * @param {string} id
   */
  clear(id) {
    this.retries.delete(id);
    send((api) => api.clear(id));
  }
}
