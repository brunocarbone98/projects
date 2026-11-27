// @ts-check
/**
 * The alerts of DramaFetch 1.7.0 — the owner's request of 2026-11-19: “an alert that tells me a
 * drama has been downloaded completely, or that one or more episodes need a retry”. One Chrome
 * notification (a Windows toast) per drama a download job finishes — a paste or Enter, the popup's
 * **Download this series**, **Retry**, an automatic retry —, made by the DramaFetch tab that ran
 * the job (`app.js`, once the drama's rows and records are stored) and clicked in the worker
 * (`background.js`):
 *
 * - **complete** — `✓ <drama> — downloaded` / `All 60 episodes are on disk.`: the drama's report
 *   says complete, the locked episodes left out as its report line says (`— 2 locked (61, 62)`);
 *   when the account may play none of them (every one locked), `<drama> — nothing your account may
 *   play` / `Your account may play none of its episodes — 5 locked (1-5).`: nothing was saved;
 * - **retry** — `⚠ <drama> — 3 episodes to retry` / `E03, E07, E12 did not download.` (at most
 *   {@link MAX_NAMED_EPISODES} of them, then `and N more`): the rows the tab's **Retry** takes for
 *   that drama (`app.retryTargets`), the stop's reason as the context when the run stopped, and ONE
 *   button, **Retry**, which the worker hands to the page that holds it; since 3.0.1 (the owner's
 *   report of 2026-11-27) the episodes TikTok's list lacked have rows too, named apart: `E61, E62
 *   are not in TikTok's list.`, and so do the free episodes DramaFetch only guessed were locked —
 *   `E03 was not asked for: TikTok's list made it look locked (plays 2 s of 3 s).` (the hint for
 *   one episode) —: never ✓ while one is left, and the **Retry** asks TikTok for them anyway;
 * - **incomplete** — `<drama> — not complete` / the tab's report line: nothing to retry, but not
 *   complete either (episodes a selection did not take, a list it refused); `⚠ <drama> — TikTok's
 *   list may be incomplete` when the list itself is short with no row to retry (3.0.1: a number the
 *   job did not take is missing, the list ended early while TikTok's count is unknown, or TikTok
 *   counts more than the drama certainly has — its count may include a trailer or a highlight);
 * - **stopped** — at the end of a job that stopped with dramas never started — its own, or those of
 *   the download jobs its stop took out of the queue, never an automatic retry's (its drama gets the
 *   ⚠ of **not retried after all**, below) —, one more: `DramaFetch stopped: <reason>` /
 *   `N dramas were not started — download them again later`.
 *
 * The automatic retry of DramaFetch 1.8.0 (the owner's request of 2026-11-21: retry on its own a
 * download that did not work, and say so) adds these, all under one id per drama — the one its ⚠
 * alert would have had (Chrome replaces the notification: one per drama, which changes):
 *
 * - **autoretry** — `↻ <drama> — retrying 2 episodes` / `E03, E07 did not download — DramaFetch
 *   tries them once more on its own.` ({@link autoRetryAlert}), shown INSTEAD of the ⚠ alert when
 *   `app.js` queued that drama's automatic retry: no button (the retry waits in the queue already);
 *   the drama's free episodes DramaFetch only guessed were locked, which it never retries on its own,
 *   named after it (3.0.1, the lead's D8: `E05 … on its own. E03 was not asked for: …`) — and named
 *   again, with their **Retry**, by whichever ⚠ alert follows;
 * - the automatic retry's outcome — the retry job's own drama alert, `After an automatic retry.` as
 *   its context unless the retry stopped ({@link dramaAlert}'s `afterAutoRetry`): ✓, ⚠ with its
 *   **Retry**, or not complete, as above;
 * - **not retried after all** — an automatic retry that never ran: **Stop** or a stop took it out of
 *   the queue, it was refused at its own gate, or **Stop** or an error ended it before any request:
 *   the ⚠ alert with its **Retry** (the job's own episodes, and since 3.0.1 the drama's free episodes
 *   not asked for that it carried), `Not retried automatically: <reason>` its context
 *   ({@link notRetriedAlert});
 * - an automatic retry that ran — asked TikTok for its list — and that **Stop** or an error ended
 *   before its drama's alert: the ⚠ alert with its **Retry** of the episodes it did not get on disk
 *   (and the free ones not asked for, 3.0.1), the stop's reason its context, as for any automatic
 *   retry that stopped ({@link stoppedRetryAlert}); with none left, `app.js` takes “retrying” away.
 *
 * Beyond **not retried after all**, nothing for a drama skipped as complete or refused before any
 * request, nothing for a job refused at its gate (but an automatic retry's, above), nor while the
 * **Alert me when a drama finishes** setting is off.
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
 * @typedef {"complete" | "retry" | "incomplete" | "stopped" | "autoretry"} AlertKind
 *
 * @typedef {object} AlertTexts What one notification says.
 * @property {AlertKind} kind
 * @property {string} title
 * @property {string} message
 * @property {string | null} context Chrome's `contextMessage` (the stop's reason, what an
 *   automatic retry came to), or none
 *
 * @typedef {object} DramaAlertOptions
 * @property {boolean} [afterAutoRetry] the run is an automatic retry's (DramaFetch 1.8.0): its
 *   context says so — `After an automatic retry.` —, or, when the run stopped, gives the stop's reason
 */

/**
 * @param {string} notificationId
 * @returns {boolean} whether it is one of DramaFetch's alerts
 */
export function isAlertId(notificationId) {
  return notificationId.startsWith(ALERT_ID_PREFIX);
}

/**
 * `E01`: an episode number as the progress rows and the **Did not download** block show it.
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
 * A drama's name as a title carries it: its report's name, else its list's, else its id — plain
 * text, cut to {@link MAX_NAME_LENGTH}.
 * @param {SeriesRun} run
 * @returns {string}
 */
function nameOf(run) {
  return plainText(run.report.name || run.series?.name || run.ref.seriesId, MAX_NAME_LENGTH);
}

/**
 * `E03, E07, E12` — at most {@link MAX_NAMED_EPISODES} of them, then `and N more` (`alertMore`):
 * the episodes as the alerts name them, and as the Waiting card's rows do (DramaFetch 2.0.0,
 * `app.js` `queueRows`).
 * @param {readonly number[]} numbers
 * @returns {string}
 */
export function namedEpisodes(numbers) {
  const named = numbers.slice(0, MAX_NAMED_EPISODES).map(episodeLabel).join(", ");
  return numbers.length > MAX_NAMED_EPISODES ? t("alertMore", [named, numbers.length - MAX_NAMED_EPISODES]) : named;
}

/**
 * @typedef {object} GuessedEpisodes The free episodes DramaFetch only guessed were locked, as an
 *   alert names them (3.0.1).
 * @property {readonly number[]} numbers
 * @property {string} hint what the list said of the one there is — its lock hints as the tab shows
 *   them (`plays 2 s of 3 s`) —, empty for several or for none known
 */

/**
 * What an alert says of a drama's episodes to retry: `E03, E07, E12 did not download.`; those of
 * them TikTok's list lacked (`missing`, 3.0.1: their rows say `not in TikTok's list…`) named apart —
 * `E61, E62 are not in TikTok's list.` —, and those DramaFetch only guessed were locked (`guessed`,
 * 3.0.1) too — `E03 was not asked for: TikTok's list made it look locked (plays 2 s of 3 s).` (the
 * hint for one episode), `E03, E17 were not asked for: TikTok's list made them look locked.` —, one
 * sentence per kind there is; each part at most {@link MAX_NAMED_EPISODES} named, then `and N more`.
 * @param {readonly number[]} numbers at least one
 * @param {readonly number[]} [missing]
 * @param {GuessedEpisodes} [guessed]
 * @returns {string}
 */
function episodesMessage(numbers, missing = [], guessed = { numbers: [], hint: "" }) {
  const notListed = new Set(missing);
  const notAsked = new Set(guessed.numbers);
  const failed = numbers.filter((number) => !notListed.has(number) && !notAsked.has(number));
  const absent = numbers.filter((number) => notListed.has(number) && !notAsked.has(number));
  const free = numbers.filter((number) => notAsked.has(number));
  /** @type {string[]} */
  const parts = [];
  if (failed.length > 0) parts.push(t(failed.length === 1 ? "alertRetryMessageOne" : "alertRetryMessage", [namedEpisodes(failed)]));
  if (absent.length > 0) parts.push(t(absent.length === 1 ? "alertMissingMessageOne" : "alertMissingMessage", [namedEpisodes(absent)]));
  if (free.length === 1 && guessed.hint !== "") parts.push(t("alertGuessedMessageOneHint", [namedEpisodes(free), guessed.hint]));
  else if (free.length === 1) parts.push(t("alertGuessedMessageOne", [namedEpisodes(free)]));
  else if (free.length > 1) parts.push(t("alertGuessedMessage", [namedEpisodes(free)]));
  return parts.join(" ");
}

/**
 * The ⚠ alert of a drama's episodes to retry: `⚠ <drama> — 3 episodes to retry` / `E03, E07, E12
 * did not download.` — or, for those TikTok's list lacked (3.0.1), `E61, E62 are not in TikTok's
 * list.`, and for the free ones DramaFetch only guessed were locked (3.0.1) `E03 was not asked for:
 * …` ({@link episodesMessage}); its **Retry** button is {@link notificationOptions}'.
 * @param {string} name the drama's name, plain already
 * @param {readonly number[]} numbers at least one
 * @param {string | null} context
 * @param {readonly number[]} [missing] those of `numbers` TikTok's list lacked
 * @param {GuessedEpisodes} [guessed] those of `numbers` DramaFetch only guessed were locked
 * @returns {AlertTexts}
 */
function retryTexts(name, numbers, context, missing = [], guessed = undefined) {
  const one = numbers.length === 1;
  return {
    kind: "retry",
    title: one ? t("alertRetryTitleOne", [name]) : t("alertRetryTitle", [name, numbers.length]),
    message: episodesMessage(numbers, missing, guessed),
    context,
  };
}

/**
 * The free episodes DramaFetch only guessed were locked as an alert names them (3.0.1): `numbers`,
 * and — for one episode — `hints`, the lock hints its list entry gave (`plays 2 s of 3 s`, `no play
 * address`: engine texts), as the tab shows them.
 * @param {readonly number[]} numbers
 * @param {readonly string[]} hints those of the one episode there is (ignored for several)
 * @param {(text: string) => string} show
 * @returns {GuessedEpisodes}
 */
export function guessedEpisodes(numbers, hints, show) {
  return { numbers, hint: numbers.length === 1 ? hints.map((one) => plainText(show(one))).join("; ") : "" };
}

/**
 * The free episodes of `target` DramaFetch only guessed were locked (3.0.1), with what the list said
 * of the one there is: its lock hints (`plays 2 s of 3 s`, `no play address`) as the tab shows them,
 * read off the run's rows, else its fresh list.
 * @param {SeriesRun} run
 * @param {RetryTarget} target
 * @param {(text: string) => string} show
 * @returns {GuessedEpisodes}
 */
function guessedOf(run, target, show) {
  const numbers = (target.guessed ?? []).filter((number) => target.numbers.includes(number));
  return guessedEpisodes(numbers, numbers.length === 1 ? guessedHints(run, /** @type {number} */ (numbers[0])) : [], show);
}

/**
 * The lock hints a run's list gave episode `number` (engine texts, as stored): off the run's rows,
 * else its fresh list; none when neither holds it.
 * @param {SeriesRun} run
 * @param {number} number
 * @returns {string[]}
 */
export function guessedHints(run, number) {
  const episode =
    run.results.find((result) => result.episode.number === number)?.episode ?? run.series?.episodes.find((listed) => listed.number === number) ?? null;
  return [...(episode?.lockHints ?? [])];
}

/**
 * The texts of the notification of a drama a download job finished, or null when it gets none:
 * skipped as complete (no request was made), or refused before any request (a cooldown or a write
 * the storage refused at its gate) or never started (after a stop). `target` is what the tab's
 * **Retry** takes for that drama (`app.retryTargets` over its record), null when nothing. With
 * `afterAutoRetry` (the run of an automatic retry, DramaFetch 1.8.0) the context — of whichever
 * kind — is `After an automatic retry.`, or the stop's reason when the run stopped.
 * @param {SeriesRun} run
 * @param {RetryTarget | null} target
 * @param {(text: string) => string} show an engine text as the tab shows it (`lib/display`)
 * @param {DramaAlertOptions} [options]
 * @returns {AlertTexts | null}
 */
export function dramaAlert(run, target, show, options = {}) {
  const report = run.report;
  if (report.skippedComplete) return null;
  if (!run.contacted && run.results.length === 0) return null;
  const name = nameOf(run);
  const stopped = report.stopped ? plainText(show(report.stopped)) : null;
  /** @param {string | null} context what the alert says as its context outside an automatic retry */
  const contextOf = (context) => (options.afterAutoRetry === true ? (stopped ?? t("alertAfterAutoRetry")) : context);
  if (target !== null && target.numbers.length > 0) {
    return retryTexts(name, target.numbers, contextOf(stopped), target.missing ?? [], guessedOf(run, target, show));
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
    return { kind: "complete", title, message, context: contextOf(null) };
  }
  // 3.0.1: TikTok's list itself short — a number missing, an early end short of TikTok's count, or
  // TikTok counting more than the drama certainly has (`uncertain`: the list may be incomplete) —
  // with no row to retry (a number the job did not take, TikTok's count unknown or uncertain) is a ⚠
  const listShort = report.gaps.length > 0 || report.endedEarly === true || report.uncertain === true;
  return {
    kind: "incomplete",
    title: t(listShort ? "alertListIncompleteTitle" : "alertIncompleteTitle", [name]),
    message: plainText(show(run.error !== null ? run.error : reportLine(report))), // what the tab's report line shows
    context: contextOf(null),
  };
}

/**
 * The texts of the notification shown INSTEAD of the ⚠ alert when DramaFetch queued an automatic
 * retry of a drama's episodes (DramaFetch 1.8.0): `↻ <drama> — retrying 2 episodes` / `E03, E07
 * did not download — DramaFetch tries them once more on its own.` (at most
 * {@link MAX_NAMED_EPISODES} named, then `and N more`); no context, and no button
 * ({@link notificationOptions}): the retry waits in the queue already. `target` is what the
 * automatic retry takes — episodes the tab's **Retry** would take besides (a short-served one, say)
 * are not named here, but the drama's free episodes DramaFetch only guessed were locked are
 * (`guessed`, 3.0.1, the lead's D8: never retried on their own — their **Retry** is the user's, on
 * the ⚠ alert that follows): `E03 was not asked for: TikTok's list made it look locked (…).` after
 * what it retries.
 * @param {SeriesRun} run
 * @param {RetryTarget} target at least one episode
 * @param {GuessedEpisodes} [guessed] the drama's free episodes DramaFetch only guessed were locked
 * @returns {AlertTexts}
 */
export function autoRetryAlert(run, target, guessed = { numbers: [], hint: "" }) {
  const name = nameOf(run);
  const numbers = target.numbers;
  const one = numbers.length === 1;
  const missing = target.missing ?? [];
  // 3.0.1: the episodes TikTok's list lacked named apart (`E61 is not in TikTok's list.`), then
  // that DramaFetch tries once more on its own
  const retried =
    missing.length > 0
      ? `${episodesMessage(numbers, missing)} ${t("alertAutoRetryAgain")}`
      : t(one ? "alertAutoRetryMessageOne" : "alertAutoRetryMessage", [namedEpisodes(numbers)]);
  // 3.0.1 (D8): the free episodes not asked for, after it — not retried on their own
  const message = guessed.numbers.length > 0 ? `${retried} ${episodesMessage(guessed.numbers, [], guessed)}` : retried;
  return {
    kind: "autoretry",
    title: one ? t("alertAutoRetryTitleOne", [name]) : t("alertAutoRetryTitle", [name, numbers.length]),
    message,
    context: null,
  };
}

/**
 * A retry target's drama name as a title carries it: its name, else its id — plain text, cut to
 * {@link MAX_NAME_LENGTH}, as {@link nameOf} gives a run's.
 * @param {RetryTarget} target
 * @returns {string}
 */
function targetName(target) {
  return plainText(target.name || target.seriesId, MAX_NAME_LENGTH);
}

/**
 * The texts of the notification of an automatic retry that never ran (DramaFetch 1.8.0): **Stop**
 * or a stop took it out of the queue, it was refused at its own gate, or **Stop** or an error ended
 * it before any request. The ⚠ alert of the episodes it would have retried — `target`, the job's
 * own, and (3.0.1, the lead's D8) the drama's free episodes DramaFetch only guessed were locked
 * (`target.guessed`, `hints` the lock hints of the one there is) — with its **Retry**, and `Not
 * retried automatically: <reason>` as its context (`reason` an engine text, shown as the tab shows it).
 * @param {RetryTarget} target at least one episode
 * @param {string} reason
 * @param {(text: string) => string} show
 * @param {readonly string[]} [hints]
 * @returns {AlertTexts}
 */
export function notRetriedAlert(target, reason, show, hints = []) {
  const context = t("alertAutoRetryNotRun", [plainText(show(reason))]);
  return retryTexts(targetName(target), target.numbers, context, target.missing ?? [], guessedIn(target, hints, show));
}

/**
 * The texts of the notification of an automatic retry that ran — asked TikTok for its list, maybe
 * saved episodes — and that **Stop** or an error ended before its drama's alert (DramaFetch 1.8.0):
 * the ⚠ alert of the episodes it did not get on disk — `target`, with (3.0.1, the lead's D8) the
 * drama's free episodes DramaFetch only guessed were locked — with its **Retry**, the stop's
 * reason as its context (`reason` an engine text, shown as the tab shows it), as for an automatic
 * retry whose run stopped ({@link dramaAlert}); never `Not retried automatically`: it ran.
 * @param {RetryTarget} target at least one episode
 * @param {string} reason
 * @param {(text: string) => string} show
 * @param {readonly string[]} [hints] the lock hints of the one guessed episode there is
 * @returns {AlertTexts}
 */
export function stoppedRetryAlert(target, reason, show, hints = []) {
  return retryTexts(targetName(target), target.numbers, plainText(show(reason)), target.missing ?? [], guessedIn(target, hints, show));
}

/**
 * The free episodes of `target` DramaFetch only guessed were locked (`target.guessed`, 3.0.1), as an
 * alert names them: `hints` those of the one there is.
 * @param {RetryTarget} target
 * @param {readonly string[]} hints
 * @param {(text: string) => string} show
 * @returns {GuessedEpisodes}
 */
function guessedIn(target, hints, show) {
  return guessedEpisodes(
    (target.guessed ?? []).filter((number) => target.numbers.includes(number)),
    hints,
    show,
  );
}

/**
 * The texts of the one notification at the end of a job that stopped with dramas never started —
 * a download job's own, or those of the download jobs its stop took out of the queue (never an
 * automatic retry's: its drama gets its own ⚠, {@link notRetriedAlert}).
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
 * **Retry** button on a retry alert only — never on an `autoretry` one, whose retry is queued.
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
   * Show a notification (never throws, never waits); `target` is what its **Retry** queues. One
   * shown under the id of an earlier one replaces it in Chrome (an automatic retry's alerts, one id
   * per drama): without a target, the earlier one's retry goes with its button.
   * @param {string} id
   * @param {AlertTexts} texts
   * @param {RetryTarget | null} [target]
   */
  show(id, texts, target = null) {
    if (target !== null) this.retries.set(id, target);
    else this.retries.delete(id);
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
