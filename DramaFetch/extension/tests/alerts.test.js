// @ts-check
// The alert when a drama finishes (DramaFetch 1.7.0, src/app/alerts.js): what each notification
// says — the drama complete, its episodes to retry, not complete, the job stopped with dramas never
// started —, Chrome's options, a notification Chrome refuses, and the worker's answer to a click
// (src/app/background.js): the body brings the DramaFetch tab forward, Retry goes to the page that
// made it, and with no such page only the tab opens. DramaFetch 1.8.0's automatic retry: “retrying”
// (no button), what came of it (`After an automatic retry.`), an automatic retry that never ran
// (`Not retried automatically: …`, with Retry) and one Stop or an error ended after it ran (the
// stop's reason, with Retry). DramaFetch 2.0.0's automatic removal from the Favorites: removed (✓)
// or still in the Favorites (⚠, the reason), never a button. The page's side is in app.test.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { makeEpisode } from "../src/lib/catalog.js";
import { MEDIA_RATE_LIMIT_MESSAGE } from "../src/lib/messages.js";
import { completeSkip, reportLine, seriesReport } from "../src/lib/report.js";
import { markComplete, newState, record } from "../src/lib/state.js";
import {
  ALERT_ID_PREFIX,
  MAX_NAMED_EPISODES,
  MAX_NAME_LENGTH,
  PageAlerts,
  autoRetryAlert,
  dramaAlert,
  isAlertId,
  notRemovedAlert,
  notRetriedAlert,
  notificationOptions,
  plainText,
  removedAlert,
  stoppedAlert,
  stoppedRetryAlert,
} from "../src/app/alerts.js";

const ROOT = "chrome-extension://dramafetch-test-id/";
const SERIES_ID = "7699393770256782354";

/**
 * @typedef {{message: string, placeholders?: Record<string, {content: string}>}} CatalogEntry
 * @param {"en" | "es"} language
 * @returns {(key: string, substitutions?: string[]) => string} Chrome's `getMessage` over that catalog
 */
function messagesOf(language) {
  /** @type {Record<string, CatalogEntry>} */
  const catalog = JSON.parse(readFileSync(new URL(`../_locales/${language}/messages.json`, import.meta.url), "utf8"));
  return (key, substitutions = []) => {
    const entry = catalog[key];
    if (entry === undefined) return "";
    return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (_match, name) => {
      const known = Object.entries(entry.placeholders ?? {}).find(([placeholder]) => placeholder.toLowerCase() === String(name).toLowerCase());
      return known === undefined ? "" : (substitutions[Number(known[1].content.slice(1)) - 1] ?? "");
    });
  };
}

/**
 * A fake `chrome` for the module: the extension's URLs, the messages of `language`, and — unless
 * `notifications` is null — a `chrome.notifications` that keeps what it shows and clears.
 * @param {{language?: "en" | "es", notifications?: Record<string, unknown> | null}} [options]
 */
function fakeChrome(options = {}) {
  /** @type {[string, string, unknown][]} */
  const calls = [];
  const notifications =
    options.notifications === null
      ? undefined
      : {
          create: async (/** @type {string} */ id, /** @type {unknown} */ notification) => {
            calls.push(["create", id, notification]);
            return id;
          },
          clear: async (/** @type {string} */ id) => {
            calls.push(["clear", id, null]);
            return true;
          },
          ...(options.notifications ?? {}),
        };
  Object.assign(globalThis, {
    chrome: {
      runtime: { id: "dramafetch-test-id", getURL: (/** @type {string} */ path) => `${ROOT}${path}` },
      i18n: { getMessage: messagesOf(options.language ?? "en"), getUILanguage: () => (options.language === "es" ? "es" : "en-US") },
      ...(notifications === undefined ? {} : { notifications }),
    },
  });
  return { calls, restore: () => Reflect.deleteProperty(globalThis, "chrome") };
}

/** An engine text as the English tab shows it: itself. @param {string} text */
const shownAsIs = (text) => text;

/**
 * @param {number} number
 * @param {{locked?: boolean}} [options]
 */
function episode(number, options = {}) {
  return makeEpisode({ number, itemId: `i${number}`, title: `Episode ${number}`, seriesId: SERIES_ID, seriesName: "Red Sapphire", durationS: 3, access: options.locked ? "locked" : "free", coverUrl: null, raw: {} });
}

/**
 * A finished run of the series “Red Sapphire” whose list held `count` episodes, over `rows`
 * (`[number, status, message?]`; every other listed episode with no row); `locked` the listed ones
 * the session may not play.
 * @param {number} count
 * @param {[number, string, string?][]} rows
 * @param {{locked?: number[], stopped?: string | null, error?: string | null, name?: string}} [options]
 * @returns {import("../src/app/engine.js").SeriesRun}
 */
function run(count, rows, options = {}) {
  const episodes = Array.from({ length: count }, (_, index) => episode(index + 1, { locked: options.locked?.includes(index + 1) }));
  const series = { seriesId: SERIES_ID, name: options.name ?? "Red Sapphire", episodes, totalHint: null, warnings: [] };
  const results = rows.map(([number, status, message]) => ({
    episode: /** @type {import("../src/lib/catalog.js").Episode} */ (episodes[number - 1]),
    status: /** @type {import("../src/lib/messages.js").Status} */ (status),
    path: status === "done" ? `/dl/E${number}.mp4` : null,
    message: message ?? `${status} ${number}`,
  }));
  return {
    ref: { kind: "series", seriesId: SERIES_ID, episodeHint: null, sourceUrl: SERIES_ID },
    series,
    results,
    report: seriesReport(series, results, { stopped: options.stopped ?? null }),
    error: options.error ?? null,
    stop: Boolean(options.stopped),
    exitCode: 0,
    errorKind: null,
    contacted: true,
  };
}

/** @param {number[]} numbers @returns {import("../src/app/app.js").RetryTarget} */
const target = (numbers) => ({ seriesId: SERIES_ID, name: "Red Sapphire", numbers });

test("a drama complete: ✓, its episodes on disk and the locked ones in its report line's words; one episode said so; none the account may play: no ✓ and no “downloaded” — nothing was saved", () => {
  const fake = fakeChrome();
  try {
    const whole = run(3, [[1, "done"], [2, "skipped-exists"], [3, "done"]]);
    assert.deepEqual(dramaAlert(whole, null, shownAsIs), { kind: "complete", title: "✓ Red Sapphire — downloaded", message: "All 3 episodes are on disk.", context: null });
    // two locked: left out of “all”, named as the report line names them
    const locked = run(62, [...Array.from({ length: 60 }, (_, index) => /** @type {[number, string]} */ ([index + 1, "done"])), [61, "skipped-locked"], [62, "skipped-locked"]], { locked: [61, 62] });
    assert.equal(locked.report.complete, true);
    assert.equal(dramaAlert(locked, null, shownAsIs)?.message, "All 60 episodes are on disk — 2 locked (61, 62).");
    assert.ok(reportLine(locked.report).endsWith(" — 2 locked (61, 62)"), "the report line's own words");
    assert.equal(dramaAlert(run(1, [[1, "done"]]), null, shownAsIs)?.message, "1 episode is on disk.");
    // one the account may play beside locked ones: never “its only episode”
    const oneOfThree = run(3, [[1, "done"], [2, "skipped-locked"], [3, "skipped-locked"]], { locked: [2, 3] });
    assert.equal(dramaAlert(oneOfThree, null, shownAsIs)?.message, "1 episode is on disk — 2 locked (2, 3).");
    assert.equal(dramaAlert(oneOfThree, null, shownAsIs)?.title, "✓ Red Sapphire — downloaded");
    const allLocked = run(2, [[1, "skipped-locked"], [2, "skipped-locked"]], { locked: [1, 2] });
    assert.equal(dramaAlert(allLocked, null, shownAsIs)?.message, "Your account may play none of its episodes — 2 locked (1, 2).");
    // every episode locked (a paid drama not unlocked, or every one short-headered): complete — nothing
    // is left to play —, but nothing is on disk, so the title claims no download
    const fiveLocked = run(5, [1, 2, 3, 4, 5].map((number) => /** @type {[number, string]} */ ([number, "skipped-locked"])), { locked: [1, 2, 3, 4, 5] });
    assert.equal(fiveLocked.report.complete, true);
    assert.equal(fiveLocked.report.done + fiveLocked.report.onDisk, 0);
    assert.deepEqual(dramaAlert(fiveLocked, null, shownAsIs), {
      kind: "complete",
      title: "Red Sapphire — nothing your account may play",
      message: "Your account may play none of its episodes — 5 locked (1-5).",
      context: null,
    });
    assert.equal(dramaAlert(allLocked, null, shownAsIs)?.title, "Red Sapphire — nothing your account may play");
  } finally {
    fake.restore();
  }
});

test("episodes to retry: ⚠ with their count, named — at most ten, then how many more —, the stop's reason as the tab shows it; ONE button, Retry", () => {
  const fake = fakeChrome();
  try {
    const three = run(12, [[3, "failed"], [7, "failed-unavailable"], [12, "failed"]]);
    const alert = dramaAlert(three, target([3, 7, 12]), shownAsIs);
    assert.deepEqual(alert, { kind: "retry", title: "⚠ Red Sapphire — 3 episodes to retry", message: "E03, E07, E12 did not download.", context: null });
    assert.deepEqual(notificationOptions(/** @type {import("../src/app/alerts.js").AlertTexts} */ (alert)), {
      type: "basic",
      iconUrl: `${ROOT}icons/icon128.png`, // the extension's own icon, read from its root
      title: "⚠ Red Sapphire — 3 episodes to retry",
      message: "E03, E07, E12 did not download.",
      priority: 0,
      requireInteraction: false,
      silent: false,
      buttons: [{ title: "Retry" }],
    });
    assert.equal(dramaAlert(run(3, [[2, "failed"]]), target([2]), shownAsIs)?.title, "⚠ Red Sapphire — 1 episode to retry");
    assert.equal(dramaAlert(run(3, [[2, "failed"]]), target([2]), shownAsIs)?.message, "E02 did not download.");
    // fourteen: the first ten named, then how many more
    const numbers = Array.from({ length: 14 }, (_, index) => index + 1);
    const many = dramaAlert(run(14, numbers.map((number) => /** @type {[number, string]} */ ([number, "failed"]))), target(numbers), shownAsIs);
    assert.equal(MAX_NAMED_EPISODES, 10);
    assert.equal(many?.message, "E01, E02, E03, E04, E05, E06, E07, E08, E09, E10 and 4 more did not download.");
    // stopped by a 429: the stop's reason is the context, shown as the tab shows it (here in Spanish)
    const stopped = run(3, [[1, "done"], [2, "failed-rate-limited", MEDIA_RATE_LIMIT_MESSAGE], [3, "failed-rate-limited", "stopped: episode 2 failed-rate-limited"]], { stopped: "episode 2 failed-rate-limited" });
    assert.equal(dramaAlert(stopped, target([2, 3]), shownAsIs)?.context, "episode 2 failed-rate-limited");
    assert.equal(dramaAlert(stopped, target([2, 3]), (text) => (text === "episode 2 failed-rate-limited" ? "episodio 2 (limitado por TikTok)" : text))?.context, "episodio 2 (limitado por TikTok)");
    assert.equal(notificationOptions(/** @type {import("../src/app/alerts.js").AlertTexts} */ (dramaAlert(stopped, target([2, 3]), shownAsIs))).contextMessage, "episode 2 failed-rate-limited");
  } finally {
    fake.restore();
  }
});

test("not complete with nothing to retry: the tab's report line, or the error it shows — never an address, only its host —; nothing at all for a drama skipped as complete, refused before any request or never started", () => {
  const fake = fakeChrome();
  try {
    // episode 2 missing from TikTok's list
    const gap = run(3, [[1, "done"], [3, "done"]]);
    gap.series = { ...(/** @type {import("../src/lib/catalog.js").Series} */ (gap.series)), episodes: [episode(1), episode(3)] };
    gap.report = seriesReport(gap.series, gap.results);
    assert.deepEqual(dramaAlert(gap, null, shownAsIs), {
      kind: "incomplete",
      title: "Red Sapphire — not complete",
      message: "incomplete: 2 of 3 — episode 2 missing from TikTok's list",
      context: null,
    });
    assert.equal(reportLine(gap.report), "incomplete: 2 of 3 — episode 2 missing from TikTok's list"); // the tab's line
    // a list TikTok did not send: the error the tab shows, its address cut to the host
    const failed = run(3, []);
    failed.series = null;
    failed.results = [];
    failed.report = seriesReport(null, [], { seriesId: SERIES_ID, stopped: "the episode list could not be fetched" });
    failed.error = `no episode list within 45 s (page: https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/1?is_from_webapp=1&sender_device=pc): if this Chrome is not logged in to TikTok, log in in a normal tab and try again`;
    const alert = dramaAlert(failed, null, shownAsIs);
    assert.equal(alert?.title, `${SERIES_ID} — not complete`); // no name learnt: its id, as the tab
    assert.equal(alert?.message, "no episode list within 45 s (page: www.tiktok.com): if this Chrome is not logged in to TikTok, log in in a normal tab and try again");
    // skipped as complete (no request), refused at its gate or never started (no request, no row)
    const state = newState(SERIES_ID, "Red Sapphire");
    for (const number of [1, 2]) record(state, { episode: { number, itemId: `i${number}` }, status: "done", path: `/dl/E${number}.mp4`, message: "saved" }, { exists: () => true, now: 1_800_000_000 });
    markComplete(state, 1_800_000_000, 2);
    const skip = /** @type {NonNullable<ReturnType<typeof completeSkip>>} */ (completeSkip(state, { seriesId: SERIES_ID, nowS: 1_800_000_060, exists: () => true }));
    const skipped = { ...run(2, []), series: null, results: skip.results, report: skip.report, contacted: false };
    assert.equal(dramaAlert(skipped, null, shownAsIs), null);
    const refused = { ...run(2, []), series: null, results: [], report: seriesReport(null, [], { seriesId: SERIES_ID, stopped: "cooldown until 12:30" }), contacted: false, errorKind: "cooldown" };
    assert.equal(dramaAlert(refused, null, shownAsIs), null);
    const notStarted = { ...refused, errorKind: "not-started", error: "not started: batch stopped in Other (episode 2 failed-rate-limited)" };
    assert.equal(dramaAlert(notStarted, null, shownAsIs), null);
  } finally {
    fake.restore();
  }
});

test("the job stopped with dramas never started: one more alert, its reason as the tab shows it; the drama's name and every text plain, one line, cut", () => {
  const fake = fakeChrome();
  try {
    assert.deepEqual(stoppedAlert("episode 2 failed-rate-limited", 3, shownAsIs), {
      kind: "stopped",
      title: "DramaFetch stopped: episode 2 failed-rate-limited",
      message: "3 dramas were not started — download them again later",
      context: null,
    });
    assert.equal(stoppedAlert("stopped by you", 1, shownAsIs).message, "1 drama was not started — download it again later");
    assert.equal(notificationOptions(stoppedAlert("stopped by you", 1, shownAsIs)).buttons, undefined);
    // a name of 70 characters, an emoji where it is cut: 60 code points with the ellipsis, the emoji whole or gone
    const long = `${"A".repeat(58)}😀${"B".repeat(11)}`;
    assert.equal(MAX_NAME_LENGTH, 60);
    assert.equal(plainText(long, MAX_NAME_LENGTH), `${"A".repeat(58)}😀…`);
    assert.equal(plainText("Red\nSapphire\t(2026)\u0007", 60), "Red Sapphire (2026)");
    assert.equal(plainText("see http://127.0.0.1:8123/shortdrama/episode/1/2?a=b and https://v16.tiktokcdn.com/x.mp4?sig=abc"), "see 127.0.0.1:8123 and v16.tiktokcdn.com");
    // an address with a user and a password before its host: the host alone, nothing of the rest
    assert.equal(plainText("(https://someone:s3cr3t@v16.tiktokcdn.com/v/1.mp4?expire=1#t=2) and ftp://anon@files.example/x"), "(v16.tiktokcdn.com) and files.example");
    const name = dramaAlert(run(1, [[1, "done"]], { name: long }), null, shownAsIs);
    assert.equal(name?.title, `✓ ${"A".repeat(58)}😀… — downloaded`);
  } finally {
    fake.restore();
  }
});

test("Spanish: every text of an alert in the page's language, the engine's words as the tab shows them", () => {
  const fake = fakeChrome({ language: "es" });
  try {
    /** @param {string} text */
    const es = (text) => ({ "2 locked (61, 62)": "2 bloqueados (61, 62)", "stopped by you": "detenido por ti" })[text] ?? text;
    const locked = run(62, [...Array.from({ length: 60 }, (_, index) => /** @type {[number, string]} */ ([index + 1, "done"])), [61, "skipped-locked"], [62, "skipped-locked"]], { locked: [61, 62] });
    assert.deepEqual(dramaAlert(locked, null, es), { kind: "complete", title: "✓ Red Sapphire — descargado", message: "Los 60 episodios están en el disco — 2 bloqueados (61, 62).", context: null });
    // every episode locked: nothing saved, so neither ✓ nor “descargado”
    const allLocked = run(2, [[1, "skipped-locked"], [2, "skipped-locked"]], { locked: [1, 2] });
    const none = dramaAlert(allLocked, null, (text) => (text === "2 locked (1, 2)" ? "2 bloqueados (1, 2)" : text));
    assert.equal(none?.title, "Red Sapphire — nada que tu cuenta pueda reproducir");
    assert.equal(none?.message, "Tu cuenta no puede reproducir ninguno de sus episodios — 2 bloqueados (1, 2).");
    const retry = /** @type {import("../src/app/alerts.js").AlertTexts} */ (dramaAlert(run(12, [[3, "failed"], [7, "failed"]]), target([3, 7]), es));
    assert.equal(retry.title, "⚠ Red Sapphire — 2 episodios por reintentar");
    assert.equal(retry.message, "E03, E07 no se descargaron.");
    assert.deepEqual(notificationOptions(retry).buttons, [{ title: "Reintentar" }]);
    assert.equal(stoppedAlert("stopped by you", 2, es).title, "DramaFetch se detuvo: detenido por ti");
    assert.equal(stoppedAlert("stopped by you", 2, es).message, "2 dramas no se iniciaron: descárgalos de nuevo más tarde");
  } finally {
    fake.restore();
  }
});

test("a page's notifications: ids of its own (the page, the job, the drama), the retry behind each kept until taken away; one Chrome refuses — a throw, a rejected promise — is dropped, its retry forgotten; without the API (no permission) nothing happens, and nothing ever throws", async () => {
  let fake = fakeChrome();
  const warn = console.warn;
  /** @type {unknown[][]} */
  const warned = [];
  console.warn = (...args) => void warned.push(args);
  try {
    const page = new PageAlerts();
    const other = new PageAlerts();
    const id = page.idOf(4, `${SERIES_ID}:retry`);
    assert.ok(id.startsWith(`${ALERT_ID_PREFIX}${page.page}:4:${SERIES_ID}:retry`));
    assert.notEqual(page.page, other.page); // a page reloaded never holds an earlier page's retry
    assert.ok(isAlertId(id) && !isAlertId("another-extension-notification"));
    const texts = /** @type {import("../src/app/alerts.js").AlertTexts} */ (dramaAlert(run(3, [[2, "failed"]]), target([2]), shownAsIs));
    page.show(id, texts, target([2]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(fake.calls.map(([call, shown]) => [call, shown]), [["create", id]]);
    assert.deepEqual(page.retryOf(id), target([2]));
    assert.equal(other.retryOf(id), null);
    page.clear(id);
    assert.equal(page.retryOf(id), null);
    assert.deepEqual(fake.calls.at(-1), ["clear", id, null]);
    fake.restore();
    // Chrome refuses: a throw, then a rejected promise — dropped, the retry forgotten, nothing thrown
    for (const create of [
      () => {
        throw new TypeError("Error in invocation of notifications.create");
      },
      () => Promise.reject(new Error("Unable to download all specified images.")),
    ]) {
      fake = fakeChrome({ notifications: { create } });
      page.show(id, texts, target([2]));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(page.retryOf(id), null);
      fake.restore();
    }
    assert.equal(warned.length, 2);
    // a copy without the permission: no API, nothing to do, nothing said
    fake = fakeChrome({ notifications: null });
    page.show(id, texts, target([2]));
    page.clear(id);
    assert.equal(page.retryOf(id), null);
    assert.equal(warned.length, 2);
  } finally {
    console.warn = warn;
    fake.restore();
  }
});

/** @param {number[]} numbers every one `failed` @returns {[number, string][]} */
const failedRowsOf = (numbers) => numbers.map((number) => /** @type {[number, string]} */ ([number, "failed"]));

test("the automatic retry's alert (1.8.0): ↻ retrying its episodes — one, several, at most ten named then how many more —, the drama's name plain and cut as every alert's; no context and NO button: the retry is queued already", () => {
  const fake = fakeChrome();
  try {
    const one = autoRetryAlert(run(3, [[1, "done"], [2, "failed"], [3, "done"]]), target([2]));
    assert.deepEqual(one, { kind: "autoretry", title: "↻ Red Sapphire — retrying 1 episode", message: "E02 did not download — DramaFetch tries it once more on its own.", context: null });
    assert.deepEqual(notificationOptions(one), {
      type: "basic",
      iconUrl: `${ROOT}icons/icon128.png`,
      title: "↻ Red Sapphire — retrying 1 episode",
      message: "E02 did not download — DramaFetch tries it once more on its own.",
      priority: 0,
      requireInteraction: false,
      silent: false,
    });
    const two = autoRetryAlert(run(12, [[3, "failed"], [7, "failed"]]), target([3, 7]));
    assert.equal(two.title, "↻ Red Sapphire — retrying 2 episodes");
    assert.equal(two.message, "E03, E07 did not download — DramaFetch tries them once more on its own.");
    assert.equal(notificationOptions(two).buttons, undefined);
    assert.equal(notificationOptions(two).contextMessage, undefined);
    // thirteen: the first ten named, then how many more
    const numbers = Array.from({ length: 13 }, (_, index) => index + 1);
    const many = autoRetryAlert(run(13, failedRowsOf(numbers)), target(numbers));
    assert.equal(many.title, "↻ Red Sapphire — retrying 13 episodes");
    assert.equal(many.message, "E01, E02, E03, E04, E05, E06, E07, E08, E09, E10 and 3 more did not download — DramaFetch tries them once more on its own.");
    // the drama's name as every alert's: one line, an address cut to its host, 60 code points at most
    const long = `${"A".repeat(58)}😀${"B".repeat(11)}`;
    assert.equal(autoRetryAlert(run(2, [[2, "failed"]], { name: long }), target([2])).title, `↻ ${"A".repeat(58)}😀… — retrying 1 episode`);
    assert.equal(autoRetryAlert(run(2, [[2, "failed"]], { name: "Red\nSapphire https://www.tiktok.com/@a/x?sig=1" }), target([2])).title, "↻ Red Sapphire www.tiktok.com — retrying 1 episode");
    // only what the automatic retry takes is named: a short-served episode beside it (which the tab's
    // Retry would take) is not
    const mixed = autoRetryAlert(run(4, [[2, "failed"], [4, "failed-unavailable"]]), target([2]));
    assert.equal(mixed.message, "E02 did not download — DramaFetch tries it once more on its own.");
  } finally {
    fake.restore();
  }
});

test("what came of an automatic retry (1.8.0): the drama's alert as ever — ✓, ⚠ with its Retry, not complete —, `After an automatic retry.` its context unless the retry stopped, then the stop's reason as the tab shows it; outside an automatic retry the 1.7.0 contexts", () => {
  const fake = fakeChrome();
  try {
    const after = { afterAutoRetry: true };
    const whole = run(3, [[1, "done"], [2, "done"], [3, "done"]]);
    assert.deepEqual(dramaAlert(whole, null, shownAsIs, after), { kind: "complete", title: "✓ Red Sapphire — downloaded", message: "All 3 episodes are on disk.", context: "After an automatic retry." });
    assert.equal(notificationOptions(/** @type {import("../src/app/alerts.js").AlertTexts} */ (dramaAlert(whole, null, shownAsIs, after))).contextMessage, "After an automatic retry.");
    // still not downloaded: ⚠, its Retry, the context
    const again = /** @type {import("../src/app/alerts.js").AlertTexts} */ (dramaAlert(run(3, [[1, "done"], [2, "failed"], [3, "done"]]), target([2]), shownAsIs, after));
    assert.deepEqual(again, { kind: "retry", title: "⚠ Red Sapphire — 1 episode to retry", message: "E02 did not download.", context: "After an automatic retry." });
    assert.deepEqual(notificationOptions(again).buttons, [{ title: "Retry" }]);
    assert.equal(notificationOptions(again).contextMessage, "After an automatic retry.");
    // not complete, nothing to retry (episode 2 gone from TikTok's list): the same context
    const gap = run(3, [[1, "done"], [3, "done"]]);
    gap.series = { ...(/** @type {import("../src/lib/catalog.js").Series} */ (gap.series)), episodes: [episode(1), episode(3)] };
    gap.report = seriesReport(gap.series, gap.results);
    assert.deepEqual(dramaAlert(gap, null, shownAsIs, after), {
      kind: "incomplete",
      title: "Red Sapphire — not complete",
      message: "incomplete: 2 of 3 — episode 2 missing from TikTok's list",
      context: "After an automatic retry.",
    });
    // the retry stopped (a 429): the stop's reason, as the tab shows it, as for any download
    const stopped = run(3, [[1, "done"], [2, "failed-rate-limited", MEDIA_RATE_LIMIT_MESSAGE], [3, "failed-rate-limited", "stopped: episode 2 failed-rate-limited"]], { stopped: "episode 2 failed-rate-limited" });
    const spanishStop = (/** @type {string} */ text) => (text === "episode 2 failed-rate-limited" ? "episodio 2 (limitado por TikTok)" : text);
    assert.equal(dramaAlert(stopped, target([2, 3]), spanishStop, after)?.context, "episodio 2 (limitado por TikTok)");
    // refused before any request: no alert of its own here either (the page says it was not retried)
    const refused = { ...run(2, []), series: null, results: [], report: seriesReport(null, [], { seriesId: SERIES_ID, stopped: "cooldown until 12:30" }), contacted: false, stop: true };
    assert.equal(dramaAlert(refused, null, shownAsIs, after), null);
    // outside an automatic retry: no such context
    assert.equal(dramaAlert(whole, null, shownAsIs)?.context, null);
    assert.equal(dramaAlert(whole, null, shownAsIs, { afterAutoRetry: false })?.context, null);
    assert.equal(dramaAlert(run(3, [[1, "done"], [2, "failed"], [3, "done"]]), target([2]), shownAsIs)?.context, null);
    assert.equal(dramaAlert(gap, null, shownAsIs)?.context, null);
  } finally {
    fake.restore();
  }
});

test("an automatic retry that never ran (1.8.0): ⚠ with its Retry over the job's own episodes, `Not retried automatically: <reason>` its context — the reason as the tab shows it, one line, its addresses cut to their host, cut to 200 code points", () => {
  const fake = fakeChrome();
  try {
    const texts = notRetriedAlert(target([2, 5]), "episode 3 failed-rate-limited", shownAsIs);
    assert.deepEqual(texts, { kind: "retry", title: "⚠ Red Sapphire — 2 episodes to retry", message: "E02, E05 did not download.", context: "Not retried automatically: episode 3 failed-rate-limited" });
    assert.deepEqual(notificationOptions(texts), {
      type: "basic",
      iconUrl: `${ROOT}icons/icon128.png`,
      title: "⚠ Red Sapphire — 2 episodes to retry",
      message: "E02, E05 did not download.",
      contextMessage: "Not retried automatically: episode 3 failed-rate-limited",
      priority: 0,
      requireInteraction: false,
      silent: false,
      buttons: [{ title: "Retry" }],
    });
    assert.equal(notRetriedAlert(target([2]), "stopped by you", shownAsIs).title, "⚠ Red Sapphire — 1 episode to retry");
    assert.equal(notRetriedAlert(target([2]), "stopped by you", shownAsIs).message, "E02 did not download.");
    // fourteen: the first ten named, then how many more
    const numbers = Array.from({ length: 14 }, (_, index) => index + 1);
    assert.equal(notRetriedAlert(target(numbers), "stopped by you", shownAsIs).message, "E01, E02, E03, E04, E05, E06, E07, E08, E09, E10 and 4 more did not download.");
    // the drama's name unknown: its id, as the tab
    assert.equal(notRetriedAlert({ seriesId: SERIES_ID, name: null, numbers: [2] }, "stopped by you", shownAsIs).title, `⚠ ${SERIES_ID} — 1 episode to retry`);
    // the drama's name as every alert's: one line, an address cut to its host, 60 code points at most
    assert.equal(notRetriedAlert({ seriesId: SERIES_ID, name: "Red\nSapphire https://www.tiktok.com/@a/x?sig=1", numbers: [2] }, "stopped by you", shownAsIs).title, "⚠ Red Sapphire www.tiktok.com — 1 episode to retry");
    const long = `${"A".repeat(58)}😀${"B".repeat(11)}`;
    assert.equal(notRetriedAlert({ seriesId: SERIES_ID, name: long, numbers: [2] }, "stopped by you", shownAsIs).title, `⚠ ${"A".repeat(58)}😀… — 1 episode to retry`);
    // a reason with an address and of any length: plain, cut
    const reason = `could not list the series: no episode list within 45 s (page: https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/1?is_from_webapp=1)\n${"z".repeat(300)}`;
    const context = String(notRetriedAlert(target([2]), reason, shownAsIs).context);
    assert.ok(context.startsWith("Not retried automatically: could not list the series: no episode list within 45 s (page: www.tiktok.com) zzz"), context);
    assert.equal([...context].length, "Not retried automatically: ".length + 200);
    assert.ok(context.endsWith("z…"));
    assert.ok(!context.includes("is_from_webapp"));
  } finally {
    fake.restore();
  }
});

test("an automatic retry Stop or an error ended after it ran (1.8.0): ⚠ with its Retry over the episodes it did not get on disk, the stop's reason alone its context — as the tab shows it, one line, its addresses cut to their host, cut to 200 code points — never `Not retried automatically`; the drama's name plain and cut", () => {
  const fake = fakeChrome();
  try {
    const texts = stoppedRetryAlert(target([3]), "stopped by you", shownAsIs);
    assert.deepEqual(texts, { kind: "retry", title: "⚠ Red Sapphire — 1 episode to retry", message: "E03 did not download.", context: "stopped by you" });
    assert.deepEqual(notificationOptions(texts), {
      type: "basic",
      iconUrl: `${ROOT}icons/icon128.png`,
      title: "⚠ Red Sapphire — 1 episode to retry",
      message: "E03 did not download.",
      contextMessage: "stopped by you",
      priority: 0,
      requireInteraction: false,
      silent: false,
      buttons: [{ title: "Retry" }],
    });
    assert.equal(stoppedRetryAlert(target([3, 7]), "stopped by you", shownAsIs).title, "⚠ Red Sapphire — 2 episodes to retry");
    assert.equal(stoppedRetryAlert({ seriesId: SERIES_ID, name: null, numbers: [2] }, "stopped by you", shownAsIs).title, `⚠ ${SERIES_ID} — 1 episode to retry`);
    assert.equal(stoppedRetryAlert({ seriesId: SERIES_ID, name: "Red\nSapphire https://www.tiktok.com/@a/x?sig=1", numbers: [2] }, "stopped by you", shownAsIs).title, "⚠ Red Sapphire www.tiktok.com — 1 episode to retry");
    const long = `${"A".repeat(58)}😀${"B".repeat(11)}`;
    assert.equal(stoppedRetryAlert({ seriesId: SERIES_ID, name: long, numbers: [2] }, "stopped by you", shownAsIs).title, `⚠ ${"A".repeat(58)}😀… — 1 episode to retry`);
    const reason = `Internal error at https://www.tiktok.com/api/x?sig=1\n${"z".repeat(300)}`;
    const context = String(stoppedRetryAlert(target([2]), reason, shownAsIs).context);
    assert.ok(context.startsWith("Internal error at www.tiktok.com zzz"), context);
    assert.equal([...context].length, 200);
    assert.ok(!context.includes("sig=") && !context.includes("Not retried"));
    // the stop's reason as the tab shows it
    /** @param {string} text */
    const es = (text) => ({ "stopped by you": "detenido por ti" })[text] ?? text;
    assert.equal(stoppedRetryAlert(target([3]), "stopped by you", es).context, "detenido por ti");
  } finally {
    fake.restore();
  }
});

test("Spanish (1.8.0): retrying, after an automatic retry and not retried automatically in the page's language, the engine's words as the tab shows them", () => {
  const fake = fakeChrome({ language: "es" });
  try {
    const one = autoRetryAlert(run(3, [[2, "failed"]]), target([2]));
    assert.deepEqual(one, { kind: "autoretry", title: "↻ Red Sapphire — reintentando 1 episodio", message: "E02 no se descargó: DramaFetch lo intenta una vez más por su cuenta.", context: null });
    const two = autoRetryAlert(run(12, [[3, "failed"], [7, "failed"]]), target([3, 7]));
    assert.equal(two.title, "↻ Red Sapphire — reintentando 2 episodios");
    assert.equal(two.message, "E03, E07 no se descargaron: DramaFetch los intenta una vez más por su cuenta.");
    assert.equal(notificationOptions(two).buttons, undefined);
    const numbers = Array.from({ length: 11 }, (_, index) => index + 1);
    assert.equal(autoRetryAlert(run(11, failedRowsOf(numbers)), target(numbers)).message, "E01, E02, E03, E04, E05, E06, E07, E08, E09, E10 y 1 más no se descargaron: DramaFetch los intenta una vez más por su cuenta.");
    assert.equal(dramaAlert(run(3, [[1, "done"], [2, "done"], [3, "done"]]), null, shownAsIs, { afterAutoRetry: true })?.context, "Tras un reintento automático.");
    /** @param {string} text */
    const es = (text) => ({ "stopped by you": "detenido por ti" })[text] ?? text;
    const notRun = notRetriedAlert(target([2, 5]), "stopped by you", es);
    assert.equal(notRun.title, "⚠ Red Sapphire — 2 episodios por reintentar");
    assert.equal(notRun.message, "E02, E05 no se descargaron.");
    assert.equal(notRun.context, "No se reintentó automáticamente: detenido por ti");
    assert.deepEqual(notificationOptions(notRun).buttons, [{ title: "Reintentar" }]);
  } finally {
    fake.restore();
  }
});

test("the automatic removal's alerts (2.0.0): removed — ✓ the drama, removed from your Favorites, every episode on disk —, or still in the Favorites — ⚠ the drama, the reason as the library's status line shows it, one line, its addresses cut to their host, cut to 200 code points —; the drama's name plain and cut as every alert's; never a context, never a button; in Spanish too", () => {
  const fake = fakeChrome();
  try {
    const removed = removedAlert("Red Sapphire");
    assert.deepEqual(removed, { kind: "removed", title: "✓ Red Sapphire — removed from your Favorites", message: "Every episode is on disk.", context: null });
    assert.deepEqual(notificationOptions(removed), {
      type: "basic",
      iconUrl: `${ROOT}icons/icon128.png`,
      title: "✓ Red Sapphire — removed from your Favorites",
      message: "Every episode is on disk.",
      priority: 0,
      requireInteraction: false,
      silent: false,
    });
    const reason = "TikTok did not keep the change: “Red Sapphire” is still in your Favorites. Remove it yourself: Open on TikTok.";
    const kept = notRemovedAlert("Red Sapphire", reason);
    assert.deepEqual(kept, { kind: "notremoved", title: "⚠ Red Sapphire — still in your Favorites", message: reason, context: null });
    assert.deepEqual(notificationOptions(kept), {
      type: "basic",
      iconUrl: `${ROOT}icons/icon128.png`,
      title: "⚠ Red Sapphire — still in your Favorites",
      message: reason,
      priority: 0,
      requireInteraction: false,
      silent: false,
    });
    // the drama's name as every alert's: one line, an address cut to its host, 60 code points at most
    assert.equal(removedAlert("Red\nSapphire https://www.tiktok.com/@a/x?sig=1").title, "✓ Red Sapphire www.tiktok.com — removed from your Favorites");
    const long = `${"A".repeat(58)}😀${"B".repeat(11)}`;
    assert.equal(notRemovedAlert(long, reason).title, `⚠ ${"A".repeat(58)}😀… — still in your Favorites`);
    // a reason with an address and of any length: plain, cut
    const message = notRemovedAlert("Red Sapphire", `could not open https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/1?is_from_webapp=1\n${"z".repeat(300)}`).message;
    assert.ok(message.startsWith("could not open www.tiktok.com zzz"), message);
    assert.equal([...message].length, 200);
    assert.ok(message.endsWith("z…") && !message.includes("is_from_webapp"));
  } finally {
    fake.restore();
  }
  const es = fakeChrome({ language: "es" });
  try {
    assert.deepEqual(removedAlert("Red Sapphire"), { kind: "removed", title: "✓ Red Sapphire — quitado de tu Bookmark", message: "Todos sus episodios están en el disco.", context: null });
    const reason = "TikTok no guardó el cambio: “Red Sapphire” sigue en tu Bookmark. Quítalo tú mismo: Abrir en TikTok.";
    assert.deepEqual(notRemovedAlert("Red Sapphire", reason), { kind: "notremoved", title: "⚠ Red Sapphire — sigue en tu Bookmark", message: reason, context: null });
    assert.equal(notificationOptions(notRemovedAlert("Red Sapphire", reason)).buttons, undefined);
  } finally {
    es.restore();
  }
});

test("an alert shown under the id of an earlier one replaces it in Chrome (1.8.0: “retrying”, then what came of it, one id per drama): one without a button takes the earlier one's retry away with it", async () => {
  const fake = fakeChrome();
  try {
    const page = new PageAlerts();
    const id = page.idOf(5, `${SERIES_ID}:retry`);
    // not retried: ⚠ with its Retry
    page.show(id, notRetriedAlert(target([2]), "stopped by you", shownAsIs), target([2]));
    assert.deepEqual(page.retryOf(id), target([2]));
    // “retrying” under that id: no button, no retry behind it
    page.show(id, autoRetryAlert(run(3, [[2, "failed"]]), target([2])));
    assert.equal(page.retryOf(id), null);
    // what came of it: ⚠ again, its Retry kept; then ✓, none
    page.show(id, /** @type {import("../src/app/alerts.js").AlertTexts} */ (dramaAlert(run(3, [[2, "failed"]]), target([2]), shownAsIs, { afterAutoRetry: true })), target([2]));
    assert.deepEqual(page.retryOf(id), target([2]));
    page.show(id, /** @type {import("../src/app/alerts.js").AlertTexts} */ (dramaAlert(run(3, [[1, "done"], [2, "done"], [3, "done"]]), null, shownAsIs, { afterAutoRetry: true })));
    assert.equal(page.retryOf(id), null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      fake.calls.map(([call, shown]) => [call, shown]),
      [1, 2, 3, 4].map(() => ["create", id]),
    );
  } finally {
    fake.restore();
  }
});

/**
 * The worker over a fake `chrome`: `on` holds its listeners, `calls` what it asked of Chrome, and
 * `answer` is what the DramaFetch pages answer a message (an Error: no page is running).
 */
async function worker() {
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {{clicked?: (id: string) => void, button?: (id: string, index: number) => void}} */
  const on = {};
  const state = {
    /** @type {unknown} */
    answer: new Error("Could not establish connection. Receiving end does not exist."),
    /** @type {{id: number, windowId: number, url: string}[]} */
    tabs: [],
  };
  const ignored = { addListener: () => undefined };
  Object.assign(globalThis, {
    chrome: {
      runtime: {
        id: "dramafetch-test-id",
        getURL: (/** @type {string} */ path) => `${ROOT}${path}`,
        getManifest: () => ({ manifest_version: 3, name: "DramaFetch", version: "1.7.0", host_permissions: ["https://www.tiktok.com/*"] }),
        sendMessage: async (/** @type {unknown} */ message) => {
          calls.push(["sendMessage", message]);
          if (state.answer instanceof Error) throw state.answer;
          return state.answer;
        },
        onMessage: ignored,
      },
      i18n: { getMessage: () => "", getUILanguage: () => "en" },
      tabs: {
        query: async () => state.tabs,
        create: async (/** @type {unknown} */ properties) => void calls.push(["create", properties]),
        update: async (/** @type {number} */ id, /** @type {unknown} */ properties) => {
          calls.push(["update", id, properties]);
          return { id, windowId: 3, active: true, index: 0 };
        },
        onRemoved: ignored,
        onUpdated: ignored,
      },
      windows: { update: async (/** @type {number} */ id, /** @type {unknown} */ info) => void calls.push(["focus", id, info]) },
      storage: { local: { get: async () => ({}) }, session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined } },
      webRequest: { onCompleted: ignored },
      notifications: {
        clear: async (/** @type {string} */ id) => {
          calls.push(["clear", id]);
          return true;
        },
        onClicked: { addListener: (/** @type {(id: string) => void} */ listener) => void (on.clicked = listener) },
        onButtonClicked: { addListener: (/** @type {(id: string, index: number) => void} */ listener) => void (on.button = listener) },
      },
    },
  });
  const url = new URL("../src/app/background.js", import.meta.url);
  url.search = "?alerts"; // a fresh worker over this fake
  await import(url.href);
  const settle = async () => {
    for (let round = 0; round < 30; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { calls, on, state, settle };
}

test("the worker: a click on an alert brings the DramaFetch tab to the front — no hand-over, nothing reloaded — and takes the alert away; Retry goes to the page that made it: queued there, nothing more; refused there (a cooldown), that tab comes forward; no page holds it, the tab only opens or comes forward — the worker never asks anything of TikTok", async () => {
  const fetchBefore = globalThis.fetch;
  /** @type {unknown[]} */
  const fetched = [];
  globalThis.fetch = async (input) => {
    fetched.push(input);
    throw new Error("no request");
  };
  try {
    const { calls, on, state, settle } = await worker();
    const { clicked, button } = on;
    assert.ok(clicked && button, "the worker listens to the alerts' clicks");
    const id = `${ALERT_ID_PREFIX}lf0x1a2b:3:${SERIES_ID}:retry`;
    const app = `${ROOT}src/app/app.html`;
    // the body: the one DramaFetch tab to the front as it is, the alert taken away
    state.tabs = [{ id: 9, windowId: 4, url: app }];
    clicked(id);
    await settle();
    assert.deepEqual(calls, [["clear", id], ["update", 9, { active: true }], ["focus", 4, { focused: true }]]);
    calls.length = 0;
    // no DramaFetch tab: a new one, on nothing in particular
    state.tabs = [];
    clicked(id);
    await settle();
    assert.deepEqual(calls, [["clear", id], ["create", { url: app }]]);
    calls.length = 0;
    // another extension's notification (none exists): not ours
    clicked("another-notification");
    button?.("another-notification", 0);
    await settle();
    assert.deepEqual(calls, []);
    // Retry: handed to the pages; the one that made it queued the retry (and took the alert away)
    state.tabs = [{ id: 9, windowId: 4, url: app }];
    state.answer = { ok: true, queued: true, tabId: 9 };
    button(id, 0);
    await settle();
    assert.deepEqual(calls, [["sendMessage", { type: "dramafetch:retry", notificationId: id }]]);
    calls.length = 0;
    // refused by its gate (a cooldown in force): that tab comes forward, where the banner says until when
    state.answer = { ok: true, queued: false, tabId: 9 };
    button(id, 0);
    await settle();
    assert.deepEqual(calls, [["sendMessage", { type: "dramafetch:retry", notificationId: id }], ["update", 9, { active: true }], ["focus", 3, { focused: true }]]);
    calls.length = 0;
    // no running page holds it (closed or reloaded since): the tab only opens or comes forward
    for (const answer of [new Error("Could not establish connection. Receiving end does not exist."), undefined]) {
      state.answer = answer;
      button(id, 0);
      await settle();
      assert.deepEqual(calls, [["sendMessage", { type: "dramafetch:retry", notificationId: id }], ["clear", id], ["update", 9, { active: true }], ["focus", 4, { focused: true }]]);
      calls.length = 0;
    }
    // a second button (none is ever shown): nothing
    button(id, 1);
    await settle();
    assert.deepEqual(calls, []);
    assert.deepEqual(fetched, []);
  } finally {
    globalThis.fetch = fetchBefore;
    Reflect.deleteProperty(globalThis, "chrome");
  }
});
