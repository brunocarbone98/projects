// @ts-check
// What the extension stores, and how it gives way: DramaFetch 2.0.0 keeps no history of past runs —
// the one 1.x stored is removed at the page's start, best effort, that key alone. A refusal's
// cooldown the storage will not take stays in force from memory. A TikTok tab's favorites address
// lives in the session's memory only, and is read back only as the first page of a favorites list.
import assert from "node:assert/strict";
import { test } from "node:test";

import { activeCooldown, clearCooldown, recordBlock } from "../src/lib/cooldown.js";
import { MEDIA_RATE_LIMIT_MESSAGE } from "../src/lib/messages.js";
import {
  DEFAULT_SETTINGS,
  RETIRED_HISTORY_KEY,
  cooldownStore,
  favoritesTemplateKey,
  forgetFavoritesTemplate,
  loadSettings,
  normalizeSettings,
  readFavoritesTemplate,
  LIBRARY_SORT_KEY,
  readLibrary,
  readLibraryCovers,
  readLibrarySort,
  rememberFavoritesTemplate,
  removeStoredHistory,
  saveSettings,
  settingsProblem,
  writeLibrary,
  writeLibraryCovers,
  writeLibrarySort,
} from "../src/app/storage.js";
import { libraryRecord } from "../src/lib/library.js";

/** What Chrome 153 rejects a `chrome.storage.local.set` with when the disk under its profile is full. */
const REFUSED = "IO error: .../000003.log: FILE_ERROR_NO_SPACE (ChromeMethodBFE: 3::WritableFileAppend::8)";

/**
 * A `chrome.storage.local` whose writes (`set`, `remove`) and reads (`get`) can be made to reject,
 * installed as the global `chrome` with a `chrome.storage.session` (the browser session's memory:
 * `session`, never refused).
 * @param {Record<string, unknown>} [stored]
 * @param {Record<string, unknown>} [session]
 */
function fakeLocal(stored = {}, session = {}) {
  const switches = { refuseWrites: false, refuseReads: false };
  const local = {
    /** @param {string} key */
    async get(key) {
      if (switches.refuseReads) throw new Error("IO error: the store cannot be read");
      return Object.hasOwn(stored, key) ? { [key]: stored[key] } : {};
    },
    /** @param {Record<string, unknown>} items */
    async set(items) {
      if (switches.refuseWrites) throw new Error(REFUSED);
      Object.assign(stored, items);
    },
    /** @param {string} key */
    async remove(key) {
      if (switches.refuseWrites) throw new Error(REFUSED);
      delete stored[key];
    },
  };
  const sessionArea = {
    /** @param {string} key */
    get: async (key) => (Object.hasOwn(session, key) ? { [key]: session[key] } : {}),
    /** @param {Record<string, unknown>} items */
    set: async (items) => void Object.assign(session, items),
    /** @param {string} key */
    remove: async (key) => void delete session[key],
  };
  Object.assign(globalThis, { chrome: { storage: { local, session: sessionArea } } });
  return { stored, session, switches };
}

test("the history 1.x kept of its past runs is removed at the page's start (DramaFetch 2.0.0: no history any more) — that key alone: the settings, the series' records, the pacing, the cooldown and the library stay —; best effort: a refusal never throws, and a key no longer there costs nothing", async () => {
  const kept = {
    settings: { ...DEFAULT_SETTINGS },
    "series:7699393770256782354": { series_id: "7699393770256782354", episodes: {} },
    pacing: { runAttempts: 3, lastNetworkAt: 1_800_000_000, consecutiveFailures: 0, lastContactAt: 1_800_000_000 },
    cooldown: { until: 1_800_001_800, reason: MEDIA_RATE_LIMIT_MESSAGE, source: "browser", recorded_at: 1_800_000_000 },
    favoritesLibrary: { version: 1 },
    [LIBRARY_SORT_KEY]: "title",
  };
  const { stored, switches } = fakeLocal({ ...kept, [RETIRED_HISTORY_KEY]: [{ id: 1, label: "Series 7699393770256782354" }] });
  assert.equal(RETIRED_HISTORY_KEY, "history"); // the key 1.x stored Past runs under
  // a refusal (a full disk) is ignored: nothing thrown, nothing removed — the next start tries again
  switches.refuseWrites = true;
  assert.equal(await removeStoredHistory(), false);
  assert.ok(Object.hasOwn(stored, RETIRED_HISTORY_KEY));
  switches.refuseWrites = false;
  assert.equal(await removeStoredHistory(), true);
  assert.deepEqual(stored, kept);
  // a key no longer there: nothing to do, nothing else touched
  assert.equal(await removeStoredHistory(), true);
  assert.deepEqual(stored, kept);
});

test("a cooldown the storage refuses to write is in force from memory until it ends; the next one stored replaces it", async () => {
  const { stored, switches } = fakeLocal();
  const now = 1_800_000_000;
  /** @type {unknown[]} */
  const errors = [];
  switches.refuseWrites = true;
  const recorded = await recordBlock(cooldownStore(), MEDIA_RATE_LIMIT_MESSAGE, "browser", { now, onError: (error) => errors.push(error) });
  assert.equal(recorded.until, now + 1800);
  assert.equal(errors.length, 1); // the write was refused…
  assert.equal(Object.hasOwn(stored, "cooldown"), false);
  const active = await activeCooldown(cooldownStore(), { now: now + 60 }); // …and another store object of the page still knows it
  assert.equal(active?.until, now + 1800);
  assert.equal(active?.reason, MEDIA_RATE_LIMIT_MESSAGE);
  assert.equal(active?.source, "browser");
  assert.equal(await activeCooldown(cooldownStore(), { now: now + 1801 }), null); // it ends when it would have
  switches.refuseReads = true;
  assert.equal((await activeCooldown(cooldownStore(), { now: now + 60 }))?.until, now + 1800); // an unreadable store too
  switches.refuseReads = false;
  // an older record the storage holds never hides the newer refusal it could not take, nor the other way round
  stored["cooldown"] = { until: now + 600, reason: "earlier", source: "discovery", recorded_at: now - 1200 };
  assert.equal((await activeCooldown(cooldownStore(), { now: now + 60 }))?.reason, MEDIA_RATE_LIMIT_MESSAGE);
  stored["cooldown"] = { until: now + 3000, reason: "another tab", source: "discovery", recorded_at: now + 1200 };
  assert.equal((await activeCooldown(cooldownStore(), { now: now + 60 }))?.reason, "another tab");
  // the next refusal the storage accepts is the record again: nothing is kept in memory
  switches.refuseWrites = false;
  await recordBlock(cooldownStore(), "later refusal", "discovery", { now: now + 100 });
  assert.equal(/** @type {Record<string, unknown>} */ (stored["cooldown"])["until"], now + 100 + 1800);
  delete stored["cooldown"];
  assert.equal(await activeCooldown(cooldownStore(), { now: now + 200 }), null);
  // clearing (the tests' and the expired record's only) forgets the one in memory as well
  switches.refuseWrites = true;
  await recordBlock(cooldownStore(), "refused again", "browser", { now: now + 300 });
  assert.equal((await activeCooldown(cooldownStore(), { now: now + 301 }))?.reason, "refused again");
  switches.refuseWrites = false;
  await clearCooldown(cooldownStore());
  assert.equal(await activeCooldown(cooldownStore(), { now: now + 302 }), null);
});

test("a cooldown the storage refuses survives a reload of the tab: the browser session's memory keeps it until Chrome closes", async () => {
  const { stored, session, switches } = fakeLocal();
  const now = 1_800_000_000;
  switches.refuseWrites = true;
  await recordBlock(cooldownStore(), MEDIA_RATE_LIMIT_MESSAGE, "browser", { now, onError: () => undefined });
  assert.equal(Object.hasOwn(stored, "cooldown"), false);
  assert.equal(/** @type {Record<string, unknown>} */ (session["cooldown"])["until"], now + 1800);
  // the page reloaded: a fresh instance of the module, its memory empty — the session still answers
  const reloaded = /** @type {typeof import("../src/app/storage.js")} */ (await import(`../src/app/storage.js?reload=${now}`));
  assert.equal((await activeCooldown(reloaded.cooldownStore(), { now: now + 60 }))?.reason, MEDIA_RATE_LIMIT_MESSAGE);
  assert.equal(Object.hasOwn(stored, "cooldown"), false); // read while the storage still refuses: stays in the session
  // Chrome restarted: the session's memory is gone, and so is that cooldown (the page's message says to wait it out first)
  const kept = session["cooldown"];
  delete session["cooldown"];
  const restarted = /** @type {typeof import("../src/app/storage.js")} */ (await import(`../src/app/storage.js?restart=${now}`));
  assert.equal(await activeCooldown(restarted.cooldownStore(), { now: now + 60 }), null);
  // unless the storage takes it first: once space is freed, the next reading stores it, and a restart keeps it
  session["cooldown"] = kept;
  switches.refuseWrites = false;
  assert.equal((await activeCooldown(reloaded.cooldownStore(), { now: now + 120 }))?.reason, MEDIA_RATE_LIMIT_MESSAGE);
  assert.deepEqual(stored["cooldown"], kept);
  assert.equal(Object.hasOwn(session, "cooldown"), false);
  const later = /** @type {typeof import("../src/app/storage.js")} */ (await import(`../src/app/storage.js?later=${now}`));
  assert.equal((await activeCooldown(later.cooldownStore(), { now: now + 180 }))?.reason, MEDIA_RATE_LIMIT_MESSAGE);
  assert.equal(await later.storedCooldownUntil(), now + 1800);
  switches.refuseWrites = true;
  // clearing removes the session's copy too
  await recordBlock(reloaded.cooldownStore(), "again", "browser", { now: now + 100, onError: () => undefined });
  switches.refuseWrites = false;
  await clearCooldown(reloaded.cooldownStore());
  assert.equal(Object.hasOwn(session, "cooldown"), false);
  // and this file's own module forgets the copy it kept at the start: no later test starts inside it
  await clearCooldown(cooldownStore());
  fakeLocal();
  assert.equal(await activeCooldown(cooldownStore(), { now: now + 60 }), null);
});

test("the report switch: on by default, a stored non-boolean falls back to it, and it must be a boolean to save", () => {
  assert.equal(DEFAULT_SETTINGS.report, true);
  assert.equal(normalizeSettings({ report: false }, false).report, false);
  assert.equal(normalizeSettings({ report: "yes" }, false).report, true); // not a boolean: dropped, the default stays
  assert.equal(normalizeSettings({ report: 0 }, false).report, true);
  assert.equal(settingsProblem({ ...DEFAULT_SETTINGS, report: false }, false), null);
  assert.equal(settingsProblem({ ...DEFAULT_SETTINGS, report: /** @type {never} */ ("x") }, false), "the report switch must be on or off");
  // checked before the pacing: a bad switch is named even when the pauses are bad too
  assert.equal(settingsProblem({ ...DEFAULT_SETTINGS, report: /** @type {never} */ (1), delayMinS: 0 }, false), "the report switch must be on or off");
});

test("the favorites address: kept per TikTok tab in the session's memory with whose list it reads (an @handle, else null), read back only when it is the first page of a favorites list — anything else is no address", async () => {
  const { stored, session } = fakeLocal();
  const first = "https://www.tiktok.com/api/user/favorite/drama_list/?WebIdLastTime=1794300000&aid=1988&count=19&cursor=0&X-Bogus=DFSzswVOxQ";
  // the stored record carries the profile since 1.6.0's review (it was `{url, at}`)
  await rememberFavoritesTemplate(42, first, 1_794_351_568, "@invented_viewer");
  assert.deepEqual(session[favoritesTemplateKey(42)], { url: first, at: 1_794_351_568, profile: "@invented_viewer" });
  assert.deepEqual(stored, {}); // never chrome.storage.local
  assert.deepEqual(await readFavoritesTemplate(42), { url: first, at: 1_794_351_568, profile: "@invented_viewer" });
  assert.equal(await readFavoritesTemplate(43), null); // none seen in that tab
  // whose list it reads not known (the tab on no profile page): null; anything but an @handle read back as null
  await rememberFavoritesTemplate(42, first, 1_794_351_569);
  assert.deepEqual(await readFavoritesTemplate(42), { url: first, at: 1_794_351_569, profile: null });
  for (const profile of ["invented_viewer", "@", "@a b", "@a/b", 5, null, undefined]) {
    session[favoritesTemplateKey(42)] = { url: first, at: 1_794_351_568, profile };
    assert.deepEqual(await readFavoritesTemplate(42), { url: first, at: 1_794_351_568, profile: null }, String(profile));
  }
  // a stored address that is no first page of a favorites list — a later page, another list, junk —
  // is no address: the list is only ever read from its first page, replayed as the page asked for it
  for (const url of [
    first.replace("cursor=0", "cursor=1794351568"),
    "https://www.tiktok.com/api/drama/recommend/drama_list/?aid=1988&cursor=0",
    "https://www.tiktok.com/api/drama/episode/item_list/?dramaID=7699393770256782354&cursor=0",
  ]) {
    session[favoritesTemplateKey(42)] = { url, at: 1_794_351_568 };
    assert.equal(await readFavoritesTemplate(42), null, url);
  }
  for (const junk of [{ url: first }, { url: 5, at: 1 }, "x", null]) {
    session[favoritesTemplateKey(42)] = junk;
    assert.equal(await readFavoritesTemplate(42), null, JSON.stringify(junk));
  }
  // forgotten when the tab closes
  session[favoritesTemplateKey(42)] = { url: first, at: 1 };
  await forgetFavoritesTemplate(42);
  assert.equal(Object.hasOwn(session, favoritesTemplateKey(42)), false);
});

test("the library's covers: signed addresses kept in the browser session's memory only — never chrome.storage.local —, read back as http(s) addresses only; the library itself, nothing signed in it, kept on disk — a refused write thrown for its caller to say", async () => {
  const { stored, session, switches } = fakeLocal();
  const signed = "https://p16-common-sign.tiktokcdn.com/c/1.avif?x-expires=1794895200&x-signature=INVENTED%3D";
  await writeLibraryCovers(new Map([["7712345678901234561", signed]]));
  assert.deepEqual(stored, {}); // never chrome.storage.local
  assert.deepEqual(session["favoritesCovers"], { "7712345678901234561": signed });
  assert.deepEqual(await readLibraryCovers(), new Map([["7712345678901234561", signed]]));
  // anything else stored there is no cover address
  session["favoritesCovers"] = { "7712345678901234561": signed, "7712345678901234562": "javascript:alert(1)", "7712345678901234563": 5 };
  assert.deepEqual(await readLibraryCovers(), new Map([["7712345678901234561", signed]]));
  session["favoritesCovers"] = "junk";
  assert.deepEqual(await readLibraryCovers(), new Map());
  // the library: on disk, read back checked; a write the storage refuses is thrown — a cache, the caller says so once
  const record = libraryRecord({ listedAt: 1_800_000_000, total: 1, complete: true, short: false, ended: null, profile: "@invented_viewer", items: [{ seriesId: "7712345678901234561", title: "A drama", episodes: 3, durationS: 237, coverUrl: signed }] });
  await writeLibrary(record);
  assert.doesNotMatch(JSON.stringify(stored["favoritesLibrary"]), /https?:|x-signature/);
  assert.deepEqual(await readLibrary(), record);
  switches.refuseWrites = true;
  await assert.rejects(writeLibrary(record), new RegExp("FILE_ERROR_NO_SPACE"));
  switches.refuseWrites = false;
});

test("the alert switch: on by default, a stored non-boolean falls back to it, and it must be a boolean to save", () => {
  assert.equal(DEFAULT_SETTINGS.alerts, true);
  assert.equal(normalizeSettings({ alerts: false }, false).alerts, false);
  assert.equal(normalizeSettings({ alerts: "no" }, false).alerts, true); // not a boolean: dropped, the default stays
  assert.equal(normalizeSettings({ alerts: false, report: false }, false).report, false); // each switch its own
  assert.equal(settingsProblem({ ...DEFAULT_SETTINGS, alerts: false }, false), null);
  assert.equal(settingsProblem({ ...DEFAULT_SETTINGS, alerts: /** @type {never} */ ("x") }, false), "the alert switch must be on or off");
  // checked before the pacing: a bad switch is named even when the pauses are bad too
  assert.equal(settingsProblem({ ...DEFAULT_SETTINGS, alerts: /** @type {never} */ (1), delayMinS: 0 }, false), "the alert switch must be on or off");
});

test("the automatic retry switch (1.8.0): on by default — a 1.7.0 install's settings too —, a stored non-boolean falls back to it, it must be a boolean to save; saved and read back", async () => {
  assert.equal(DEFAULT_SETTINGS.autoRetry, true);
  assert.equal(normalizeSettings({}, false).autoRetry, true);
  assert.equal(normalizeSettings({ report: true, alerts: true }, false).autoRetry, true); // stored by 1.7.0: no such key
  assert.equal(normalizeSettings({ autoRetry: false }, false).autoRetry, false);
  for (const odd of ["no", 0, 1, null, [], {}]) assert.equal(normalizeSettings({ autoRetry: odd }, false).autoRetry, true, JSON.stringify(odd)); // dropped: the default stays
  assert.equal(normalizeSettings({ autoRetry: false, alerts: true }, false).alerts, true); // each switch its own
  assert.equal(normalizeSettings({ autoRetry: true, alerts: false }, false).autoRetry, true);
  assert.equal(normalizeSettings({ autoRetry: false, delayMinS: 0 }, false).autoRetry, false); // a bad pause never takes the switch with it
  assert.equal(settingsProblem({ ...DEFAULT_SETTINGS, autoRetry: false }, false), null);
  assert.equal(settingsProblem({ ...DEFAULT_SETTINGS, autoRetry: /** @type {never} */ ("x") }, false), "the automatic retry switch must be on or off");
  // checked before the pacing: a bad switch is named even when the pauses are bad too
  assert.equal(settingsProblem({ ...DEFAULT_SETTINGS, autoRetry: /** @type {never} */ (1), delayMinS: 0 }, false), "the automatic retry switch must be on or off");
  // saved with the settings and read back; refused, nothing is saved
  const { stored } = fakeLocal();
  Object.assign(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis.chrome)), { runtime: { getManifest: () => ({ manifest_version: 3, name: "DramaFetch", version: "1.8.0" }) } });
  assert.equal((await loadSettings()).autoRetry, true); // nothing stored yet: the default
  await saveSettings({ ...DEFAULT_SETTINGS, autoRetry: false });
  assert.deepEqual(stored["settings"], { ...DEFAULT_SETTINGS, autoRetry: false });
  assert.equal((await loadSettings()).autoRetry, false);
  await assert.rejects(saveSettings({ ...DEFAULT_SETTINGS, autoRetry: /** @type {never} */ ("off") }), /the automatic retry switch must be on or off/);
  assert.equal(/** @type {Record<string, unknown>} */ (stored["settings"])["autoRetry"], false);
  stored["settings"] = { ...(/** @type {Record<string, unknown>} */ (stored["settings"])), autoRetry: "off" }; // written by something else
  assert.equal((await loadSettings()).autoRetry, true);
  assert.equal((await loadSettings()).alerts, true); // the rest as stored
});

test("a 2.x install's settings that still carry the automatic removal switch (3.0.0: DramaFetch removes nothing from the Favorites): read as if the key were absent — never an error, every other setting as stored —, and never written back", async () => {
  assert.equal(Object.hasOwn(DEFAULT_SETTINGS, "autoRemove"), false);
  // as 2.x stored it — on, off or anything else —: the key gone, the rest as stored
  for (const autoRemove of [true, false, "off", 1, null]) {
    const read = normalizeSettings({ ...DEFAULT_SETTINGS, alerts: false, autoRetry: false, autoRemove }, false);
    assert.deepEqual(read, { ...DEFAULT_SETTINGS, alerts: false, autoRetry: false }, JSON.stringify(autoRemove));
    assert.equal(Object.hasOwn(read, "autoRemove"), false, JSON.stringify(autoRemove));
  }
  // loaded from the storage and saved again (Save settings, Defaults): the key is not written back
  const { stored } = fakeLocal({ settings: { ...DEFAULT_SETTINGS, report: false, autoRemove: false } });
  Object.assign(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis.chrome)), { runtime: { getManifest: () => ({ manifest_version: 3, name: "DramaFetch", version: "3.0.0" }) } });
  const loaded = await loadSettings();
  assert.deepEqual(loaded, { ...DEFAULT_SETTINGS, report: false });
  await saveSettings(loaded);
  assert.deepEqual(stored["settings"], { ...DEFAULT_SETTINGS, report: false });
  assert.equal(Object.hasOwn(/** @type {Record<string, unknown>} */ (stored["settings"]), "autoRemove"), false);
});

test("the library's sort order: kept in chrome.storage.local under its own key and read back checked; best effort — a refused write or read never throws (the list's own order then)", async () => {
  const { stored, switches } = fakeLocal();
  assert.equal(LIBRARY_SORT_KEY, "librarySort");
  assert.equal(await readLibrarySort(), "recent"); // nothing kept yet: the list's own
  assert.equal(await writeLibrarySort("title"), true);
  assert.deepEqual(stored, { librarySort: "title" }); // its own small key: nothing else written
  assert.equal(await readLibrarySort(), "title");
  assert.equal(await writeLibrarySort("episodes"), true);
  assert.equal(await readLibrarySort(), "episodes");
  // anything else stored there is no sort order
  stored["librarySort"] = "by colour";
  assert.equal(await readLibrarySort(), "recent");
  stored["librarySort"] = { sort: "title" };
  assert.equal(await readLibrarySort(), "recent");
  // a refused write: false, nothing thrown, what was kept stays; a refused read: the list's own order
  stored["librarySort"] = "title";
  switches.refuseWrites = true;
  assert.equal(await writeLibrarySort("episodes"), false);
  assert.equal(stored["librarySort"], "title");
  switches.refuseWrites = false;
  switches.refuseReads = true;
  assert.equal(await readLibrarySort(), "recent");
  switches.refuseReads = false;
  assert.equal(await readLibrarySort(), "title");
});
