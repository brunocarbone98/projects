// @ts-check
// Unit tests of src/lib/display.js: every text the engine can show, made by the REAL functions —
// report lines, the cooldown, the pacing and its announcements, the stops, the batch table, the
// list's warnings, the text box's and the settings' refusals, every exported message constant,
// the downloader's and the discovery's failures — read in Spanish without one English template word
// outside the data, in English without a command-line flag, the data byte for byte; unknown texts
// unchanged; random input never throws.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { NO_PLAY_ADDRESS, catalogWarnings, makeEpisode } from "../src/lib/catalog.js";
import { EXTENSION_LIFT_TEXT, cooldownMessage, cooldownStopReason, cooldownSummary, makeCooldown } from "../src/lib/cooldown.js";
import { DEFAULT_LABELS, STATUS_LABELS, displayLanguageOf, displayText, statusLabel } from "../src/lib/display.js";
import * as messages from "../src/lib/messages.js";
import { nameFormatProblem } from "../src/lib/naming.js";
import {
  JOB_REST,
  LONG_REST,
  PACE,
  PacingState,
  REST,
  SERIES_REST,
  afterResult,
  describeBatchPacing,
  describePacing,
  pacingOptions,
  pacingProblem,
  pauseMessage,
  seededRng,
} from "../src/lib/pacing.js";
import {
  batchStatus,
  completeSkip,
  drmMemorySkip,
  lockedResult,
  manifestSkip,
  notStartedMessage,
  reportLine,
  seriesReport,
  stoppedResult,
} from "../src/lib/report.js";
import { markComplete, newState, record } from "../src/lib/state.js";
import { parseInput, parseSeriesList } from "../src/lib/urls.js";
import {
  CHALLENGE_MESSAGE,
  DiscoveryError,
  EMPTY_LIST_MESSAGE,
  FIRST_PAGE_WARNING,
  LOGIN_REDIRECT_MESSAGE,
  NOTHING_NEW_WARNING,
  NO_CURSOR_WARNING,
  NO_LIST_WARNING,
  discoverSeries,
} from "../src/app/discovery.js";
import { Downloader, SaveError } from "../src/app/downloader.js";
import { RedirectTracker, fetchFollowing } from "../src/app/redirects.js";
import { StopRequested, resolve } from "../src/app/engine.js";
import { settingsProblem, DEFAULT_SETTINGS } from "../src/app/storage.js";

/** @param {string} relative @returns {URL} */
const file = (relative) => new URL(`../${relative}`, import.meta.url);
/** @param {string} language @returns {Record<string, {message: string}>} */
const locale = (language) => JSON.parse(readFileSync(file(`_locales/${language}/messages.json`), "utf8"));
const ES = locale("es");
const EN = locale("en");

/** The labels the app page passes (`i18n.displayLabels`): the Spanish UI's own words. */
const ES_LABELS = {
  recheck: String(ES["recheckLabel"]?.message),
  includeLocked: String(ES["includeLockedLabel"]?.message),
  fields: {
    delay_min_s: String(ES["settingDelayMin"]?.message),
    delay_max_s: String(ES["settingDelayMax"]?.message),
    rest_every: String(ES["settingRestEvery"]?.message),
    rest_min_s: String(ES["settingRestMin"]?.message),
    rest_max_s: String(ES["settingRestMax"]?.message),
  },
};
const EN_LABELS = { recheck: String(EN["recheckLabel"]?.message), includeLocked: String(EN["includeLockedLabel"]?.message) };

/** @param {string} text */
const es = (text) => displayText(text, { lang: "es", labels: ES_LABELS });
/** @param {string} text */
const en = (text) => displayText(text, { lang: "en", labels: EN_LABELS });

/**
 * The English template words no Spanish text may keep outside its data.
 * @type {readonly string[]}
 */
const ENGLISH_WORDS = [
  "downloaded",
  "locked",
  "episode",
  "complete",
  "pausing",
  "resting",
  "skipped",
  "failed",
  "stopped",
  "not started",
  "cooldown",
  "already",
  "unlocked",
  "looks again",
  "tries again",
  "--",
];

// The data of the corpus: none of it holds an English template word.
const SERIES_NAME = "Zafiro Rojo";
const NAME_FORMAT = "{series} - Capitulo {number}";
const FILE_01 = "Zafiro Rojo - Capitulo 01.mp4";
const MEDIA_HOST = "v16-webapp-prime.tiktok.com";
const COVER_HOST = "p16-sign-sg.tiktokcdn.com";
const HINTS = ["vipOnly=True", "coinCost=30"];
const SERIES_ID = "7699393770256782354";
/** Everything a corpus text may carry as data; URLs (TikTok's own paths) count as data too. */
const DATA = [SERIES_NAME, FILE_01, MEDIA_HOST, COVER_HOST, "evil.example.com", ...HINTS, SERIES_ID, "ERR_42"];

/**
 * `text` without its data: the data strings above, URLs and URL templates, `'quoted'` reprs.
 * @param {string} text
 * @returns {string}
 */
function withoutData(text) {
  let out = text;
  for (const data of DATA) out = out.split(data).join(" ");
  return out
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\S*\/shortdrama\/episode\/\S*/g, " ")
    .replace(/'[^']*'/g, " ");
}

/**
 * Assert that `text` reads in Spanish: different from the English, no English template word
 * outside its data, every data string of the English kept byte for byte.
 * @param {string} text the engine's text
 * @param {string} [label] what made it
 */
function assertSpanish(text, label = text) {
  const spanish = es(text);
  assert.notEqual(spanish, en(text), `${label}: not translated`);
  const bare = withoutData(spanish).toLowerCase();
  for (const word of ENGLISH_WORDS) assert.ok(!bare.includes(word), `${label}: "${word}" left in ${JSON.stringify(spanish)}`);
  for (const data of DATA) {
    if (text.includes(data)) assert.ok(spanish.includes(data), `${label}: the data ${data} changed in ${JSON.stringify(spanish)}`);
  }
  const english = en(text);
  for (const flag of ["--recheck", "--include-locked", "cookies.txt"]) assert.ok(!english.includes(flag), `${label}: ${flag} in English`);
}

/**
 * @param {number} number
 * @param {{access?: "free" | "unlocked" | "locked", hints?: string[], drm?: boolean, urls?: string[], durationS?: number}} [options]
 */
function episode(number, options = {}) {
  const access = options.access ?? "free";
  const urls = options.urls ?? [`https://${MEDIA_HOST}/v/${number}.mp4`];
  return makeEpisode({
    number,
    itemId: `76994000000000000${String(number).padStart(2, "0")}`,
    title: `Capitulo ${number}`,
    seriesId: SERIES_ID,
    seriesName: SERIES_NAME,
    durationS: options.durationS ?? 3,
    access,
    paid: access !== "free",
    drm: options.drm ?? false,
    lockHints: access === "locked" ? options.hints ?? [...HINTS, NO_PLAY_ADDRESS] : [],
    coverUrl: `https://${COVER_HOST}/c/${number}.jpeg`,
    raw: { id: `item${number}`, video: { playAddr: access === "locked" ? "" : urls } },
  });
}

/** @param {import("../src/lib/catalog.js").Episode[]} episodes @param {number | null} [totalHint] */
const series = (episodes, totalHint = null) => ({ seriesId: SERIES_ID, name: SERIES_NAME, episodes, totalHint, warnings: [] });

/**
 * @param {import("../src/lib/catalog.js").Episode} ep
 * @param {import("../src/lib/messages.js").Status} status
 * @param {string} [message]
 */
const row = (ep, status, message = "") => ({ episode: ep, status, message, path: null });

// ------------------------------------------------------------------------ the corpus

/** @returns {string[]} report lines of every shape, made by reportLine */
function reportLines() {
  const four = [episode(1), episode(2), episode(3, { access: "unlocked" }), episode(4, { access: "locked" })];
  /** @type {string[]} */
  const lines = [];
  // complete: downloaded, on disk, a paid episode the account unlocked, locked ones
  lines.push(reportLine(seriesReport(series(four.slice(0, 2)), [row(four[0], "done"), row(four[1], "done")])));
  lines.push(reportLine(seriesReport(series(four.slice(0, 1)), [row(four[0], "done")])));
  lines.push(
    reportLine(
      seriesReport(series(four), [
        row(four[0], "done"),
        manifestSkip(four[1], `/home/me/Downloads/DramaFetch/${FILE_01}`),
        row(four[2], "done"),
        lockedResult(four[3]),
      ]),
    ),
  );
  const twoLocked = [...four, episode(5, { access: "locked" })];
  lines.push(
    reportLine(
      seriesReport(series(twoLocked), [
        manifestSkip(four[0], FILE_01),
        manifestSkip(four[1], FILE_01),
        row(four[2], "skipped-exists"),
        lockedResult(four[3]),
        lockedResult(twoLocked[4]),
      ]),
    ),
  );
  // DRM: a download found encrypted (failed), then remembered (skipped-locked)
  lines.push(reportLine(seriesReport(series(four.slice(0, 2)), [row(four[0], "done"), row(four[1], "failed-unavailable", messages.DRM_MESSAGE)])));
  lines.push(reportLine(seriesReport(series(four.slice(0, 2)), [row(four[0], "done"), drmMemorySkip(four[1])])));
  // partial: failures, not downloaded, gaps (one and several), more listed than announced, a stop
  const gappy = [episode(1), episode(2), episode(5), episode(9)];
  lines.push(
    reportLine(
      seriesReport(series(gappy, 3), [row(gappy[0], "done"), row(gappy[1], "failed-rate-limited", "stopped: x")], {
        stopped: "episode 2 failed-rate-limited",
      }),
    ),
  );
  lines.push(reportLine(seriesReport(series([episode(1), episode(3)]), [row(episode(1), "done")])));
  lines.push(reportLine(seriesReport(series(four), [row(four[0], "failed"), row(four[1], "failed")], { stopped: "3 consecutive failures" })));
  lines.push(reportLine(seriesReport(series(four), [], { stopped: cooldownStopReason(makeCooldown("x", "browser", { now: 1_800_000_000 }).cooldown) })));
  lines.push(reportLine(seriesReport(series(four), [row(four[0], "done"), lockedResult(four[3])])));
  lines.push(reportLine(seriesReport(null, [], { seriesId: SERIES_ID, stopped: "login required" })));
  lines.push(reportLine(seriesReport(null, [], { seriesId: SERIES_ID, stopped: "rate limited (HTTP 429)" })));
  lines.push(reportLine(seriesReport(null, [], { seriesId: SERIES_ID, stopped: "the episode list could not be fetched" })));
  lines.push(reportLine(seriesReport(series([]), [])));
  // the complete skip, with and without locked episodes (RECHECK_HINT), at every age
  for (const [locked, age] of /** @type {const} */ ([[true, 30], [true, 600], [false, 7200], [true, 90_000]])) {
    const state = newState(SERIES_ID, SERIES_NAME);
    const exists = () => true;
    for (const number of [1, 2]) {
      record(state, { episode: { number, itemId: `id-${number}` }, status: "done", path: `/d/${FILE_01}`, message: "saved" }, { exists, now: 1 });
    }
    if (locked) record(state, { episode: { number: 3, itemId: "id-3" }, status: "skipped-locked", message: "looks locked" }, { exists, now: 1 });
    markComplete(state, 1_761_200_000, 2);
    const skipped = completeSkip(state, { seriesId: SERIES_ID, nowS: 1_761_200_000 + Math.min(age, 80_000), exists });
    assert.ok(skipped !== null);
    lines.push(reportLine(skipped.report));
    const single = { ...skipped.report, onDisk: 1 };
    lines.push(reportLine(single));
  }
  return lines;
}

/** @returns {string[]} the stops, the stopped rows and the not-started series, made by the engine's functions */
function stopTexts() {
  /** @type {string[]} */
  const texts = [];
  const options = pacingOptions();
  for (const [status, message] of /** @type {const} */ ([
    ["failed-rate-limited", messages.MEDIA_RATE_LIMIT_MESSAGE],
    ["failed-blocked", CHALLENGE_MESSAGE],
    ["failed-login-required", LOGIN_REDIRECT_MESSAGE],
    ["failed-rate-limited", ""],
  ])) {
    const outcome = afterResult(options, new PacingState(), () => 0, { episode: { number: 2 }, status, message });
    assert.ok(outcome.stop !== null);
    texts.push(outcome.stop.reason, outcome.stop.summary);
    const state = newState(SERIES_ID);
    texts.push(stoppedResult(episode(3), status, outcome.stop.reason, { state, exists: () => false }).message);
  }
  const pacing = new PacingState({ consecutiveFailures: 2 });
  for (const message of [
    `${messages.INCOMPLETE_PREFIX}truncated body (78643 of 131072 bytes) from ${MEDIA_HOST}`,
    messages.DRM_MESSAGE,
    "",
  ]) {
    pacing.consecutiveFailures = 2;
    const outcome = afterResult(options, pacing, () => 0, { episode: { number: 4 }, status: "failed", message });
    assert.ok(outcome.stop !== null);
    texts.push(outcome.stop.reason, outcome.stop.summary, `stopped: ${outcome.stop.reason}`);
  }
  const cooldown = makeCooldown(messages.MEDIA_RATE_LIMIT_MESSAGE, "browser", { now: 1_800_000_000 }).cooldown;
  texts.push(`stopped: ${cooldownStopReason(cooldown)}`, cooldownStopReason(cooldown));
  for (const stopped of ["episode 1 failed-rate-limited", "login required", "captcha", "rate limited (HTTP 429)", cooldownStopReason(cooldown)]) {
    const report = { ...seriesReport(null, [], { seriesId: SERIES_ID, stopped }), name: SERIES_NAME };
    texts.push(notStartedMessage({ ref: { seriesId: SERIES_ID }, series: null, report, error: null }));
    texts.push(notStartedMessage({ ref: { seriesId: SERIES_ID }, series: null, report: { ...report, name: null }, error: null }));
  }
  const odd = { ...seriesReport(null, [], { seriesId: SERIES_ID, stopped: "rate limited (HTTP 429)" }), name: "Zafiro (2024)" };
  texts.push(notStartedMessage({ ref: { seriesId: SERIES_ID }, series: null, report: odd, error: null }));
  texts.push(`not started: batch stopped in Serie ${SERIES_ID} (${new StopRequested().message})`); // app.js, a job the user stopped
  texts.push(new StopRequested().message);
  return texts;
}

/** @returns {string[]} the batch table's status column (report.batchStatus) */
function batchStatuses() {
  const report = seriesReport(null, [], { seriesId: SERIES_ID });
  const run = { ref: { seriesId: SERIES_ID }, series: null, report, error: /** @type {string | null} */ (null) };
  return [
    batchStatus({ ...run, report: { ...report, complete: true } }),
    batchStatus(run),
    batchStatus({ ...run, report: { ...report, skippedComplete: true } }),
    batchStatus({ ...run, errorKind: "not-started" }),
    batchStatus({ ...run, error: LOGIN_REDIRECT_MESSAGE }),
    batchStatus({ ...run, error: "no episodes listed" }),
    batchStatus({ ...run, error: cooldownMessage(makeCooldown(CHALLENGE_MESSAGE, "discovery").cooldown) }),
  ];
}

/** @returns {string[]} the pacing in force and every pause announcement */
function pacingTexts() {
  return [
    describePacing(pacingOptions()),
    describePacing(pacingOptions({ pace: "human", delayMinS: 6.5 })),
    describePacing(pacingOptions({ restEvery: 0, maxConsecutiveFailures: 1 })),
    describePacing(pacingOptions({ maxConsecutiveFailures: 0, delayMinS: 9, delayMaxS: 9 })),
    describeBatchPacing(pacingOptions()),
    describeBatchPacing(pacingOptions({ longRestEvery: 0 })),
    pauseMessage(PACE, 7.4),
    pauseMessage(PACE, 0.25),
    pauseMessage(REST, 95.2, { downloads: 10 }),
    pauseMessage(REST, 61, { downloads: 1 }),
    pauseMessage(SERIES_REST, 95),
    pauseMessage(JOB_REST, 0.3),
    pauseMessage(LONG_REST, 1320, { runAttempts: 100 }),
    pauseMessage(LONG_REST, 900, { runAttempts: 1 }),
  ];
}

/** @returns {string[]} the settings' and the text box's refusals */
function refusals() {
  const base = pacingOptions();
  const problems = [
    pacingProblem({ ...base, delayMinS: Number.NaN }),
    pacingProblem({ ...base, restEvery: 2.5 }),
    pacingProblem({ ...base, delayMinS: -1 }),
    pacingProblem({ ...base, delayMinS: 12, delayMaxS: 10 }),
    pacingProblem({ ...base, restMaxS: 90_000 }),
    pacingProblem({ ...base, restEvery: -1 }),
    pacingProblem({ ...base, pace: "zigzag" }),
    pacingProblem({ ...base, delayMinS: 2 }),
    pacingProblem({ ...base, restMinS: 30 }),
    pacingProblem({ ...base, restEvery: 50 }),
    nameFormatProblem("{series} {numero}"),
    nameFormatProblem("{series} - {number"),
    nameFormatProblem("{series}"),
    settingsProblem({ ...DEFAULT_SETTINGS, quality: /** @type {never} */ ("x") }, false),
    settingsProblem({ ...DEFAULT_SETTINGS, thumbnail: /** @type {never} */ ("x") }, false),
    settingsProblem({ ...DEFAULT_SETTINGS, pace: /** @type {never} */ ("x") }, false),
    settingsProblem({ ...DEFAULT_SETTINGS, nameFormat: /** @type {never} */ (7) }, false),
    settingsProblem({ ...DEFAULT_SETTINGS, delayMinS: 1 }, false),
  ];
  /** @type {string[]} */
  const texts = problems.map((problem) => {
    assert.ok(problem !== null);
    return problem;
  });
  for (const junk of ["", "zzz", "https://vm.tiktok.com/ZMabc/"]) {
    try {
      parseInput(junk);
      assert.fail(`${junk} parsed`);
    } catch (error) {
      texts.push(/** @type {Error} */ (error).message);
    }
  }
  const box = parseSeriesList(`${SERIES_ID}\nzzz\nhttps://www.tiktok.com/@someone/video/7699393770256782355\n${SERIES_ID}\nhttps://vt.tiktok.com/x`);
  texts.push(...box.errors.map((error) => error.message), ...box.notes);
  return texts;
}

/** @returns {string[]} the list's warnings (catalog.catalogWarnings and the discovery's) */
function warnings() {
  const listed = [episode(2), episode(3), episode(3), episode(7), episode(8, { access: "locked" })];
  return [
    ...catalogWarnings(listed, 9),
    ...catalogWarnings([episode(1), episode(2, { access: "locked" }), episode(3, { access: "locked" })], null),
    NO_CURSOR_WARNING,
    NO_LIST_WARNING,
    NOTHING_NEW_WARNING,
    FIRST_PAGE_WARNING,
  ];
}

/** @returns {string[]} the cooldown's texts for every refusal the engine records */
function cooldownTexts() {
  /** @type {string[]} */
  const texts = [];
  for (const reason of [messages.MEDIA_RATE_LIMIT_MESSAGE, messages.LIST_RATE_LIMIT_MESSAGE, CHALLENGE_MESSAGE, "", "failed-blocked"]) {
    const { cooldown } = makeCooldown(reason, "browser", { now: 1_800_000_000 });
    texts.push(cooldownMessage(cooldown, { now: 1_800_000_000 + 125 }), cooldownSummary(cooldown, { now: 1_800_000_000 }));
  }
  texts.push(EXTENSION_LIFT_TEXT);
  return texts;
}

/** Every exported text of lib/messages.js (the URL, the default name format and a regex class aside). */
function messageConstants() {
  const notTexts = new Set(["TIKTOK_BASE_URL", "DEFAULT_NAME_FORMAT", "PY_SPACE"]);
  return Object.entries(messages)
    .filter(([name, value]) => typeof value === "string" && !notTexts.has(name))
    .map(([, value]) => /** @type {string} */ (value));
}

// ------------------------------------------------------- the downloader's and discovery's texts

const TINY = readFileSync(new URL("../../tests/fixtures/tiny.mp4", import.meta.url));

/** tiny.mp4 padded with a top-level `free` box to 128 KiB (>= 64 KiB, 3 s, audio). */
function video() {
  const size = 128 * 1024;
  const out = new Uint8Array(size);
  out.set(TINY, 0);
  new DataView(out.buffer).setUint32(TINY.length, size - TINY.length);
  out.set([0x66, 0x72, 0x65, 0x65], TINY.length + 4);
  return out;
}
/** A JPEG-looking cover of 600 bytes. */
const COVER = (() => {
  const out = new Uint8Array(600);
  out.set([0xff, 0xd8, 0xff, 0xe0]);
  out.set([0xff, 0xd9], 598);
  return out;
})();
/** A WEBP-looking cover (RIFF … WEBP). */
const WEBP = (() => {
  const out = new Uint8Array(600);
  out.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  return out;
})();
const opaqueRedirect = () =>
  /** @type {Response} */ (/** @type {unknown} */ ({ type: "opaqueredirect", status: 0, headers: new Headers(), body: null }));

/**
 * @param {Record<string, () => Response>} routes by URL prefix; anything else throws like a network error
 * @returns {typeof fetch}
 */
function fakeFetch(routes) {
  return /** @type {typeof fetch} */ (
    async (input) => {
      const url = String(input);
      const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      if (route === undefined) throw new TypeError("net::ERR_42");
      return route[1]();
    }
  );
}

/**
 * A real Downloader over fakes.
 * @param {{routes: Record<string, () => Response>, thumbnail?: string, save?: () => never, rediscover?: () => Promise<import("../src/lib/catalog.js").Series>, completedAt?: () => chrome.downloads.DownloadItem | null}} options
 */
function downloader(options) {
  return new Downloader({
    quality: "compatible",
    thumbnail: options.thumbnail ?? "embed",
    nameFormat: NAME_FORMAT,
    includeLocked: false,
    hostPatterns: ["https://*.tiktok.com/*", "https://*.tiktokcdn.com/*"],
    view: /** @type {never} */ ({ completedAt: options.completedAt ?? (() => null), remember() {} }),
    rediscover: options.rediscover ?? (async () => series([])),
    fetch: fakeFetch(options.routes),
    save:
      options.save ??
      (async (_bytes, _mime, filename) =>
        /** @type {never} */ ({ id: 1, filename: `/home/me/Downloads/${filename}`, state: "complete", exists: true })),
  });
}

const CONTEXT = { seriesName: SERIES_NAME, folder: `${SERIES_NAME} [${SERIES_ID}]` };
const MEDIA = `https://${MEDIA_HOST}/`;
const COVERS = `https://${COVER_HOST}/`;
const mp4 = () => new Response(video(), { headers: { "content-type": "video/mp4" } });

/** @returns {Promise<string[]>} the downloader's results' messages, made by the real Downloader */
async function downloaderTexts() {
  /** @type {string[]} */
  const texts = [];
  /** @param {Downloader} subject @param {import("../src/lib/catalog.js").Episode} ep */
  const run = async (subject, ep) => texts.push((await subject.download(ep, CONTEXT)).message);
  const jpeg = () => new Response(COVER, { headers: { "content-type": "image/jpeg" } });
  await run(downloader({ routes: { [MEDIA]: mp4, [COVERS]: jpeg } }), episode(1));
  await run(downloader({ routes: { [MEDIA]: mp4, [COVERS]: jpeg }, thumbnail: "both" }), episode(1));
  await run(downloader({ routes: { [MEDIA]: mp4, [COVERS]: jpeg }, thumbnail: "file" }), episode(1));
  await run(downloader({ routes: { [MEDIA]: mp4, [COVERS]: () => new Response(WEBP, { headers: { "content-type": "image/webp" } }) } }), episode(1));
  await run(downloader({ routes: { [MEDIA]: mp4, [COVERS]: () => new Response("x", { status: 404 }) } }), episode(1));
  await run(downloader({ routes: { [MEDIA]: mp4, [COVERS]: opaqueRedirect } }), episode(1));
  await run(downloader({ routes: { [MEDIA]: mp4, [COVERS]: () => new Response("<html>".repeat(100), { headers: { "content-type": "text/html" } }) } }), episode(1));
  await run(downloader({ routes: { [MEDIA]: mp4, [COVERS]: () => new Response("tiny", { headers: { "content-type": "text/html" } }) } }), episode(1));
  await run(downloader({ routes: { [MEDIA]: mp4 } }), episode(1)); // the cover: no response
  await run(
    downloader({
      routes: { [MEDIA]: mp4, [COVERS]: jpeg },
      save: () => {
        throw new SaveError("the download disappeared");
      },
    }),
    episode(1),
  );
  const urls = [1, 2, 3, 4, 5].map((n) => `https://v${n}.tiktok.com/v.mp4`);
  await run(downloader({ routes: { "https://v": () => new Response("no", { status: 403 }) } }), episode(2, { urls }));
  await run(downloader({ routes: { "https://v": opaqueRedirect } }), episode(2, { urls }));
  await run(downloader({ routes: { "https://v": () => new Response("x", { status: 500 }) } }), episode(2, { urls }));
  await run(downloader({ routes: { "https://v": () => new Response("{}", { status: 429 }) } }), episode(2, { urls }));
  await run(downloader({ routes: { "https://v": () => new Response("<html>", { headers: { "content-type": "text/html" } }) } }), episode(2, { urls }));
  await run(downloader({ routes: { "https://v": () => new Response(new Uint8Array(70_000)) } }), episode(2, { urls }));
  await run(downloader({ routes: {} }), episode(2, { urls })); // no response at all
  await run(downloader({ routes: {} }), episode(2, { urls: ["https://evil.example.com/v.mp4"] }));
  await run(downloader({ routes: {} }), episode(2, { urls: [] }));
  const cut = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(video().subarray(0, 1000));
          controller.error(new TypeError("network"));
        },
      }),
      { headers: { "content-type": "video/mp4", "content-length": String(128 * 1024) } },
    );
  await run(downloader({ routes: { "https://v": cut } }), episode(2, { urls }));
  const short = () => new Response(video().subarray(0, 100_000), { headers: { "content-type": "video/mp4", "content-length": String(128 * 1024) } });
  await run(downloader({ routes: { "https://v": short } }), episode(2, { urls }));
  await run(downloader({ routes: { [MEDIA]: mp4 } }), episode(2, { durationS: 92 }));
  const encrypted = video();
  const text = new TextDecoder("latin1").decode(encrypted);
  encrypted.set([0x65, 0x6e, 0x63, 0x76], text.indexOf("avc1", text.indexOf("stsd")));
  await run(downloader({ routes: { [MEDIA]: () => new Response(encrypted.slice(), { headers: { "content-type": "video/mp4" } }) } }), episode(2));
  // a fresh list: locked there (a lapsed entitlement, a DRM flag), or the re-discovery failing
  const lockedFresh = { ...episode(2), raw: { id: "item2", vipOnly: true, coinCost: 30, video: { playAddr: [] } } };
  const drmFresh = { ...episode(2), raw: { id: "item2", isDrm: true, video: { playAddr: [] } } };
  for (const fresh of [lockedFresh, drmFresh]) {
    await run(
      downloader({ routes: { "https://v": () => new Response("no", { status: 403 }) }, rediscover: async () => series([fresh]) }),
      episode(2, { urls: [urls[0] ?? ""] }),
    );
  }
  await run(
    downloader({
      routes: { "https://v": () => new Response("no", { status: 403 }) },
      rediscover: async () => {
        throw new DiscoveryError("the TikTok tab DramaFetch opened was closed before the episode list arrived");
      },
    }),
    episode(2, { urls: [urls[0] ?? ""] }),
  );
  await run(
    downloader({ routes: {}, completedAt: () => /** @type {never} */ ({ id: 9, filename: `/home/me/Downloads/DramaFetch/${FILE_01}`, state: "complete", exists: true }) }),
    episode(1),
  );
  texts.push(lockedResult(episode(5, { access: "locked" })).message);
  texts.push(lockedResult(episode(5, { access: "locked", hints: [] })).message);
  texts.push(lockedResult({ ...episode(5, { access: "locked" }), drm: true }).message);
  texts.push(lockedResult({ ...episode(5, { access: "locked", hints: [] }), drm: true }).message);
  texts.push(manifestSkip(episode(1), `C:\\Users\\me\\Downloads\\DramaFetch\\${FILE_01}`).message, drmMemorySkip(episode(1)).message);
  return texts;
}

/**
 * @returns {Promise<string[]>} why a redirect is not followed (`redirects.fetchFollowing`), as the
 *   message of a video that found none (`no playable stream … (<why>)`) and as a cover's note
 */
async function redirectTexts() {
  const initiator = "chrome-extension://abc";
  /** @param {(url: string) => string} next where each URL redirects to */
  const refusal = async (next) => {
    const tracker = new RedirectTracker({ initiator, waitMs: 0 });
    const fetchFn = /** @type {typeof fetch} */ (
      async (input) => {
        tracker.record({ url: String(input), redirectUrl: next(String(input)), initiator });
        return opaqueRedirect();
      }
    );
    try {
      await fetchFollowing(`https://${MEDIA_HOST}/v/0.mp4`, { fetch: fetchFn, init: { redirect: "manual" }, redirects: tracker, allowed: () => true });
    } catch (error) {
      return /** @type {Error} */ (error).message;
    }
    return assert.fail("followed");
  };
  const reasons = [
    await refusal((url) => url), // a loop
    await refusal((url) => `${url}x`), // one hop after another, more than five
    await refusal(() => `http://${COVER_HOST}/c.jpeg`), // down from https
  ];
  return [...reasons, ...reasons.map((reason) => `${messages.UNAVAILABLE_MESSAGE} (${reason})`)];
}

/** @returns {Promise<string[]>} the discovery's failures, made by the real discoverSeries / resolve */
async function discoveryTexts() {
  const ref = { kind: /** @type {const} */ ("series"), seriesId: SERIES_ID, episodeHint: null, sourceUrl: SERIES_ID };
  let clock = 0;
  /**
   * @param {{observe?: boolean, answers?: unknown[], tabUrl?: () => Promise<string>}} script
   * @returns {import("../src/app/discovery.js").DiscoveryBrowser}
   */
  const browser = (script) => ({
    openTab: async () => 7,
    navigate: async () => undefined,
    tabUrl: script.tabUrl ?? (async () => `https://www.tiktok.com/shortdrama/episode/${SERIES_ID}/1?lang=x`),
    activate: async () => undefined,
    closeTab: async () => undefined,
    observe: (_tab, _urls, handlers) => {
      if (script.observe) {
        queueMicrotask(() => handlers.completed({ url: `https://www.tiktok.com/api/drama/episode/item_list/?dramaID=${SERIES_ID}&cursor=0&count=10`, status: 200 }));
      }
      return () => undefined;
    },
    fetchInTab: async () => (script.answers ?? []).shift(),
    scrollTab: async () => null,
    pageText: async () => "",
  });
  const options = { sleep: async () => void (clock += 1), clock: () => clock, rng: { uniform: (/** @type {number} */ low) => low }, timeoutS: 3, detailGraceS: 0 };
  /** @type {string[]} */
  const texts = [];
  /** @param {Promise<unknown>} promise */
  const failure = async (promise) => {
    try {
      await promise;
    } catch (error) {
      return /** @type {Error} */ (error).message;
    }
    assert.fail("no failure");
  };
  texts.push(await failure(discoverSeries(ref, { ...options, browser: browser({}) })));
  texts.push(
    await failure(
      discoverSeries(ref, {
        ...options,
        browser: browser({
          tabUrl: async () => {
            throw new Error("gone");
          },
        }),
      }),
    ),
  );
  texts.push(await failure(discoverSeries(ref, { ...options, browser: browser({ observe: true, answers: [{ itemList: [], hasMore: false }] }) })));
  const other = { itemList: [{ id: "i1", dramaInfo: { dramaID: "1", DramaVideoData: { EpisodeNumber: 1 } }, video: { playAddr: "https://v16.tiktok.com/x.mp4" } }], hasMore: false };
  texts.push(await failure(discoverSeries(ref, { ...options, browser: browser({ observe: true, answers: [other] }) })));
  const more = (/** @type {number} */ n) => ({
    itemList: [{ id: `i${n}`, dramaInfo: { dramaID: SERIES_ID, DramaVideoData: { EpisodeNumber: n } }, video: { playAddr: "https://v16.tiktok.com/x.mp4", duration: 3 } }],
    hasMore: true,
    cursor: n,
  });
  const capped = await discoverSeries(ref, { ...options, maxPages: 1, browser: browser({ observe: true, answers: [more(1)] }) });
  texts.push(...capped.warnings);
  const engine = /** @type {import("../src/app/engine.js").Engine} */ (
    /** @type {unknown} */ ({
      discover: async () => {
        throw new Error("ERR_42");
      },
      cooldownStore: { read: () => undefined, write: () => undefined },
      wallClock: () => 0,
    })
  );
  texts.push(await failure(resolve(engine, ref)));
  texts.push(LOGIN_REDIRECT_MESSAGE, CHALLENGE_MESSAGE, EMPTY_LIST_MESSAGE);
  return texts;
}

// ---------------------------------------------------------------------------- the tests

test("every report line reads in Spanish, numbers kept; the recheck advice names the checkbox", () => {
  const lines = reportLines();
  assert.ok(lines.length >= 20);
  for (const line of lines) assertSpanish(line);
  const skip = lines.find((line) => line.endsWith(messages.RECHECK_HINT));
  assert.ok(skip !== undefined);
  assert.ok(es(skip).endsWith(`marca “${ES_LABELS.recheck}”`), es(skip));
  assert.ok(en(skip).includes(`Tick “${EN_LABELS.recheck}” to look again`), en(skip));
  assert.equal(
    es("complete: 3 of 4 (1 downloaded, 2 already on disk) — 1 paid episode your account unlocked (3), 1 locked (4)"),
    "completa: 3 de 4 (1 descargado, 2 ya en disco) — 1 episodio de pago que tu cuenta desbloqueó (3), 1 bloqueado (4)",
  );
  assert.equal(
    es("incomplete: 26 of 30 — 2 locked (5, 6), 1 failed (12-14, …); episodes 17, 18 missing from TikTok's list; stopped: episode 9 failed-blocked"),
    "incompleta: 26 de 30 — 2 bloqueados (5, 6), 1 fallido (12-14, …); faltan los episodios 17, 18 en la lista de TikTok; " +
      "detenido: episodio 9 (bloqueado por TikTok)",
  );
});

test("the stops, the stopped rows, the not-started series and the batch table read in Spanish", () => {
  for (const text of [...stopTexts(), ...batchStatuses()]) assertSpanish(text);
  assert.equal(
    es(`not started: batch stopped in Zafiro (2024) (rate limited (HTTP 429))`),
    "no iniciada: el lote se detuvo en Zafiro (2024) (demasiadas solicitudes (HTTP 429))",
  );
});

test("the pacing in force and every pause announcement read in Spanish", () => {
  for (const text of pacingTexts()) assertSpanish(text);
  assert.equal(es(pauseMessage(REST, 61, { downloads: 1 })), "descanso de 61 s tras 1 descarga");
  assert.equal(
    es(describePacing(pacingOptions())),
    "4–9 s entre episodios, descanso de 60–120 s cada 10; se detiene tras 3 fallos / 403 / 429",
  );
});

test("the settings' and the text box's refusals read in Spanish; a setting is named as the form names it", () => {
  for (const text of refusals()) assertSpanish(text);
  const below = /** @type {string} */ (pacingProblem({ ...pacingOptions(), delayMinS: 2 }));
  assert.equal(es(below), `“${ES_LABELS.fields.delay_min_s}” (2) debe ser al menos 4: las pausas solo pueden alargarse`);
  assert.equal(en(below), below); // English as the engine wrote it
  assert.equal(displayText(below, { lang: "es" }), "delay_min_s (2) debe ser al menos 4: las pausas solo pueden alargarse");
});

test("the list's warnings and the cooldown read in Spanish", () => {
  for (const text of [...warnings(), ...cooldownTexts()]) assertSpanish(text);
  const { cooldown } = makeCooldown(messages.MEDIA_RATE_LIMIT_MESSAGE, "browser", { now: 1_800_000_000 });
  const spanish = es(cooldownMessage(cooldown, { now: 1_800_000_000 }));
  assert.match(spanish, /^TikTok rechazó una solicitud a las \d{2}:\d{2} \(el servidor de video está limitando las solicitudes \(HTTP 429\): /);
  assert.match(spanish, /\(faltan 30 min\) antes de volver a contactar a TikTok — la extensión no tiene forma de levantarla antes de tiempo$/);
});

test("every exported message constant reads in Spanish; the remembered DRM verdict names the checkbox", () => {
  const constants = messageConstants();
  assert.ok(constants.length >= 20);
  for (const text of constants) assertSpanish(text);
  assert.ok(es(messages.DRM_REMEMBERED_MESSAGE).endsWith(`marca “${ES_LABELS.includeLocked}”`));
  assert.equal(
    en(messages.DRM_REMEMBERED_MESSAGE),
    `protected by DRM (found by an earlier run): DramaFetch does not decrypt it; tick “${EN_LABELS.includeLocked}” to try again`,
  );
  assert.equal(es(messages.DRM_MESSAGE), "protegido con DRM (pistas cifradas): DramaFetch no lo descifra");
});

test("the downloader's results read in Spanish: file and host names, sizes and lock hints kept", async () => {
  const texts = [...(await downloaderTexts()), ...(await redirectTexts())];
  assert.ok(texts.length >= 36);
  for (const text of texts) assertSpanish(text);
  const saved = texts[0] ?? "";
  assert.equal(saved, `saved ${FILE_01} (0.1 MiB) + cover embedded`);
  assert.equal(es(saved), `guardado ${FILE_01} (0.1 MiB) + portada incrustada`);
  assert.equal(es(lockedResult(episode(5, { access: "locked" })).message), `parece bloqueado: ${HINTS.join("; ")}; sin dirección de reproducción`);
});

test("the discovery's failures read in Spanish; the login advice stays the extension's own", async () => {
  const texts = await discoveryTexts();
  for (const text of texts) assertSpanish(text);
  for (const text of [LOGIN_REDIRECT_MESSAGE, EMPTY_LIST_MESSAGE, CHALLENGE_MESSAGE]) {
    assert.match(es(text), /pestaña normal de este Chrome/);
    assert.doesNotMatch(en(text), /cookies|--/);
  }
});

test("English stays English, but never names a command-line flag", () => {
  const corpus = [...reportLines(), ...stopTexts(), ...pacingTexts(), ...refusals(), ...warnings(), ...cooldownTexts(), ...messageConstants()];
  for (const text of corpus) {
    const english = en(text);
    for (const flag of ["--recheck", "--include-locked", "cookies.txt"]) assert.ok(!english.includes(flag), english);
    if (!text.includes(messages.RECHECK_HINT) && !text.includes(messages.DRM_REMEMBERED_MESSAGE)) assert.equal(english, text);
    assert.equal(displayText(text), english.split(EN_LABELS.recheck).join(DEFAULT_LABELS.en.recheck)); // the default language
  }
});

test("status codes get a short label per language, a stopped row its own", () => {
  for (const status of messages.STATUSES) {
    const english = statusLabel(status, { lang: "en" });
    const spanish = statusLabel(status, { lang: "es" });
    assert.ok(english && spanish && english !== spanish, status);
    assert.ok(!ENGLISH_WORDS.some((word) => spanish.toLowerCase().includes(word)), spanish);
    assert.equal(es(status), spanish); // a bare status inside a text reads the same
  }
  assert.equal(statusLabel("failed-rate-limited", { lang: "es", message: "stopped: episode 1 failed-rate-limited" }), "detenido");
  assert.equal(statusLabel("failed", { lang: "en", message: "stopped: 3 consecutive failures" }), "stopped");
  assert.equal(statusLabel("done", { lang: "es", message: "stopped: odd" }), "descargado");
  assert.equal(statusLabel("whatever", { lang: "es" }), "whatever");
  assert.deepEqual(Object.keys(STATUS_LABELS.es).sort(), Object.keys(STATUS_LABELS.en).sort());
});

test("data and unknown texts pass through unchanged, in both languages", () => {
  for (const unknown of [
    "",
    "something new the engine may say one day",
    "completa: 4 de 5",
    "complete: four of five",
    "incomplete: 1 of 2 — something unexpected",
    "stopped",
    "saved",
    "saved nothing (big MiB)",
    "episode 1 is fine",
    "TikTok refused a request at noon",
    "not started: batch stopped in",
    "😀 ñandú — «comillas»",
  ]) {
    if (unknown === "stopped") continue; // a known text (a job's fallback stop reason)
    assert.equal(en(unknown), unknown);
    assert.equal(es(unknown), unknown, unknown);
  }
  // a known template keeps an unknown part as it is, translating only what it knows
  assert.equal(es("stopped: something new"), "detenido: something new");
  assert.equal(es(`saved ${FILE_01} (1.0 MiB); cover: odd`), `guardado ${FILE_01} (1.0 MiB); portada: odd`);
  assert.equal(es("looks locked: isLocked=True"), "parece bloqueado: isLocked=True");
});

test("the UI language: Spanish for es and its regions, English otherwise; the default labels are the locales'", () => {
  for (const language of ["es", "es-419", "es-PA", "es_MX", "ES"]) assert.equal(displayLanguageOf(language), "es", language);
  for (const language of ["en", "en-US", "", "est", "pt-BR", null, 7]) assert.equal(displayLanguageOf(language), "en", String(language));
  assert.equal(DEFAULT_LABELS.en.recheck, EN["recheckLabel"]?.message);
  assert.equal(DEFAULT_LABELS.en.includeLocked, EN["includeLockedLabel"]?.message);
  assert.equal(DEFAULT_LABELS.es.recheck, ES["recheckLabel"]?.message);
  assert.equal(DEFAULT_LABELS.es.includeLocked, ES["includeLockedLabel"]?.message);
});

test("random input never throws and always gives a string", () => {
  const rng = seededRng(20261101);
  const corpus = [...reportLines(), ...stopTexts(), ...pacingTexts(), ...refusals(), ...warnings(), ...cooldownTexts(), ...messageConstants()];
  const pieces = [
    ...corpus,
    "complete: ",
    "incomplete: ",
    " of ",
    " — ",
    "; ",
    ", ",
    "(",
    ")",
    "stopped: ",
    "not started: batch stopped in ",
    "saved ",
    " MiB)",
    " (",
    "episode ",
    "failed-blocked",
    "\ud800",
    "\u0000",
    "\n",
    "ñ",
    "…",
    "{",
    "}",
    "'",
    "$&",
    "\\",
  ];
  const pick = () => /** @type {string} */ (pieces[Math.floor(rng.uniform(0, pieces.length))]);
  for (let round = 0; round < 3000; round += 1) {
    let text = "";
    const parts = Math.floor(rng.uniform(1, 8));
    for (let index = 0; index < parts; index += 1) {
      text += rng.uniform(0, 1) < 0.2 ? String.fromCharCode(Math.floor(rng.uniform(0, 0x3000))) : pick();
    }
    for (const lang of ["es", "en", "fr", undefined]) {
      const shown = displayText(text, { lang, labels: rng.uniform(0, 1) < 0.5 ? ES_LABELS : {} });
      assert.equal(typeof shown, "string");
    }
    assert.equal(typeof statusLabel(text, { lang: "es", message: text }), "string");
  }
  for (const odd of [null, undefined, 7, {}, [], Symbol("x"), () => 1]) {
    assert.equal(typeof displayText(/** @type {never} */ (odd), { lang: "es" }), "string");
    assert.equal(typeof statusLabel(odd, { lang: "es" }), "string");
  }
  assert.equal(typeof displayText("stopped: ".repeat(500), { lang: "es" }), "string");
  assert.equal(typeof displayText(`not started: batch stopped in ${"a (".repeat(400)}x)`, { lang: "es" }), "string");
});

test("the page's display language: Chrome's UI language first, else the language of the messages chrome.i18n serves", async () => {
  const { displayLabels, displayLanguage } = await import("../src/app/i18n.js");
  /** @param {string} ui @param {Record<string, {message: string}>} catalog */
  const fake = (ui, catalog) => {
    Object.assign(globalThis, {
      chrome: { i18n: { getUILanguage: () => ui, getMessage: (/** @type {string} */ key) => catalog[key]?.message ?? "" } },
    });
  };
  try {
    fake("es-419", EN); // a Spanish Chrome: Spanish (the messages would be Spanish too)
    assert.equal(displayLanguage(), "es");
    fake("en-US", ES); // Linux `--lang=es`: Spanish messages, an English UI language
    assert.equal(displayLanguage(), "es");
    fake("en-US", EN);
    assert.equal(displayLanguage(), "en");
    fake("fr", EN); // a language DramaFetch has no messages for: English, the default
    assert.equal(displayLanguage(), "en");
    for (const language of ["es", "es-419", "es_PA", "en-US", "est", ""]) {
      fake(language, EN);
      assert.equal(displayLanguage(), displayLanguageOf(language), language); // one rule
    }
    fake("es", ES);
    const labels = displayLabels();
    assert.equal(labels.recheck, ES["recheckLabel"]?.message);
    assert.equal(labels.includeLocked, ES["includeLockedLabel"]?.message);
    assert.equal(labels.fields?.["delay_min_s"], ES["settingDelayMin"]?.message);
    assert.equal(EN["uiLanguage"]?.message, "en");
    assert.equal(ES["uiLanguage"]?.message, "es");
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});
