// @ts-check
// The service worker (src/app/background.js) over a fake chrome: the popup's hand-overs — its
// **Download this series** has the DramaFetch tab download that series (1.7.0: the batch job a paste
// of it queues), its **Open my library** on a TikTok profile hands that tab's favorites over, its
// **Open my library** elsewhere shows the library, its **Open DramaFetch** brings the tab to the
// front as it is —, the favorites list's FIRST page kept per tab from the tab's own requests, and
// only the extension's own pages and worker heard. DramaFetch 2.0.0 took the right-click items
// away: the fake chrome has no `contextMenus`, no `runtime.onInstalled` / `onStartup` and no
// `tabs.sendMessage`, so a worker that reached for any of them would throw at its start. Ported
// from 1.x's tests/menus.test.js (its worker tests, the menus taken out); the notifications' clicks
// are driven in tests/alerts.test.js. DramaFetch 2.0.1 (issue #112): at its start the worker keeps
// `chrome.storage.local` to the extension's own pages and itself (`setAccessLevel`), and starts all
// the same where Chrome lacks that method, throws or refuses it.
import assert from "node:assert/strict";
import { test } from "node:test";

const SERIES = "7675706520839033876";
const ROOT = "chrome-extension://dramafetch-test-id/";
const APP = `${ROOT}src/app/app.html`;

/** How many workers the tests have loaded: each gets a module URL of its own. */
let workers = 0;

/** What Chrome 116–139 reject `chrome.storage.local.setAccessLevel` with (Chromium's `storage_api.cc`). */
const AREA_REFUSED = "This StorageArea is not available for setting access level";
/** The one access level DramaFetch asks for, on `chrome.storage.local` only (2.0.1). */
const TRUSTED = [["local", { accessLevel: "TRUSTED_CONTEXTS" }]];

/**
 * @typedef {"resolve" | "missing" | "throw" | "reject"} AccessLevelMode How the fake Chrome meets
 *   `setAccessLevel` on its storage areas: `resolve` as Chrome 140 and later do, `missing` (no such
 *   method), `throw` (a synchronous throw) or `reject` (Chrome 116–139's refusal for `local`).
 */

/**
 * A fresh worker (`background.js` loaded again under a URL of its own, so its listeners are
 * registered again) over a fake chrome: `calls` is what it asked of Chrome, `levels` the access
 * levels it asked for, one `[area, options]` per call of `setAccessLevel` on `local` or `session`
 * (`options.setAccessLevel` says how Chrome meets it; by default it resolves, as from Chrome 140
 * on), `state.pages` what the DramaFetch pages answer a message (an Error: no page is running),
 * `state.tabs` the open tabs, `session` the browser session's memory, `shows` the address each
 * TikTok tab shows (`chrome.tabs.get`; none: the tab is gone), `filter` the request filter of the
 * favorites observer, `on` its listeners.
 * @param {{setAccessLevel?: AccessLevelMode}} [options]
 * @returns {Promise<{
 *   calls: unknown[][],
 *   levels: unknown[][],
 *   state: {pages: unknown, tabs: {id: number, windowId: number, url: string}[]},
 *   session: Map<string, unknown>,
 *   shows: Map<number, string>,
 *   filter: () => chrome.webRequest.RequestFilter | undefined,
 *   on: {message?: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean, completed?: (details: chrome.webRequest.CompletedDetails) => void, removed?: (tabId: number) => void},
 *   worker: typeof import("../src/app/background.js"),
 *   settle: () => Promise<void>,
 * }>}
 */
async function fakeWorker(options = {}) {
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {unknown[][]} */
  const levels = [];
  const mode = options.setAccessLevel ?? "resolve";
  /**
   * `setAccessLevel` of storage area `area` as the fake Chrome meets it — none for `missing`.
   * @param {string} area
   * @returns {{setAccessLevel?: (accessOptions: unknown) => Promise<void>}}
   */
  const accessLevelOf = (area) => {
    if (mode === "missing") return {};
    return {
      setAccessLevel: (accessOptions) => {
        levels.push([area, accessOptions]);
        if (mode === "throw") throw new TypeError("Error in invocation of storage.StorageArea.setAccessLevel");
        if (mode === "reject") return Promise.reject(new Error(AREA_REFUSED));
        return Promise.resolve();
      },
    };
  };
  /** @type {{message?: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean, completed?: (details: chrome.webRequest.CompletedDetails) => void, removed?: (tabId: number) => void}} */
  const on = {};
  /** @type {chrome.webRequest.RequestFilter | undefined} */
  let filter;
  const state = {
    /** @type {unknown} */
    pages: new Error("Could not establish connection. Receiving end does not exist."),
    /** @type {{id: number, windowId: number, url: string}[]} */
    tabs: [],
  };
  /** @type {Map<string, unknown>} chrome.storage.session */
  const session = new Map();
  /** @type {Map<number, string>} */
  const shows = new Map();
  Object.assign(globalThis, {
    chrome: {
      runtime: {
        id: "dramafetch-test-id",
        getURL: (/** @type {string} */ path) => `${ROOT}${path}`,
        getManifest: () => ({ manifest_version: 3, name: "DramaFetch", version: "2.0.0", host_permissions: ["https://www.tiktok.com/*"] }),
        sendMessage: async (/** @type {unknown} */ message) => {
          calls.push(["sendMessage", message]);
          if (state.pages instanceof Error) throw state.pages;
          return state.pages;
        },
        onMessage: { addListener: (/** @type {NonNullable<typeof on.message>} */ listener) => void (on.message = listener) },
      },
      i18n: { getMessage: () => "", getUILanguage: () => "en" },
      tabs: {
        query: async () => state.tabs,
        get: async (/** @type {number} */ id) => {
          const url = shows.get(id);
          if (url === undefined) throw new Error(`No tab with id: ${id}.`);
          return { id, index: 0, windowId: 3, active: false, url };
        },
        create: async (/** @type {unknown} */ properties) => void calls.push(["create", properties]),
        update: async (/** @type {number} */ id, /** @type {unknown} */ properties) => {
          calls.push(["update", id, properties]);
          return { id, windowId: 3, active: true, index: 0 };
        },
        remove: async () => undefined,
        onRemoved: { addListener: (/** @type {(tabId: number) => void} */ listener) => void (on.removed = listener) },
        onUpdated: { addListener: () => undefined },
      },
      windows: { update: async (/** @type {number} */ id, /** @type {unknown} */ info) => void calls.push(["focus", id, info]) },
      storage: {
        local: { get: async () => ({}), ...accessLevelOf("local") },
        session: {
          get: async (/** @type {string} */ key) => (session.has(key) ? { [key]: session.get(key) } : {}),
          set: async (/** @type {Record<string, unknown>} */ items) => {
            for (const [key, value] of Object.entries(items)) session.set(key, value);
          },
          remove: async (/** @type {string} */ key) => void session.delete(key),
          ...accessLevelOf("session"),
        },
      },
      webRequest: {
        onCompleted: {
          addListener: (/** @type {NonNullable<typeof on.completed>} */ listener, /** @type {chrome.webRequest.RequestFilter} */ given) => {
            on.completed = listener;
            filter = given;
          },
        },
      },
    },
  });
  const url = new URL("../src/app/background.js", import.meta.url);
  url.search = `?worker=${(workers += 1)}`; // a fresh worker over this fake: its listeners are registered again
  /** @type {typeof import("../src/app/background.js")} */
  const worker = await import(url.href);
  const settle = async () => {
    for (let round = 0; round < 30; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await settle();
  return { calls, levels, state, session, shows, filter: () => filter, on, worker, settle };
}

test("the worker starts with no right-click menu (DramaFetch 2.0.0): no contextMenus, no install or start-up hook, no message to a tab — it asks nothing of Chrome at its start but its listeners and, since 2.0.1, the storage's access level", async () => {
  try {
    // the fake chrome has none of those APIs: a worker reaching for one would have thrown here
    const { calls, levels, on } = await fakeWorker();
    assert.deepEqual(calls, []);
    assert.deepEqual(levels, TRUSTED);
    assert.ok(on.message && on.completed && on.removed, "the worker listens to the popup, completed requests and closed tabs");
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("DramaFetch 2.0.1 (issue #112): at its start the worker keeps chrome.storage.local to the extension's own pages and itself — setAccessLevel called ONCE, at load, on `local` only (session is Chrome's trusted-only already), with exactly {accessLevel: TRUSTED_CONTEXTS} — and its listeners are registered all the same", async () => {
  try {
    const { calls, levels, on, settle } = await fakeWorker();
    // at load: one call, on `local`, exactly that level — nothing asked of `session`, nothing else
    assert.deepEqual(levels, TRUSTED);
    assert.deepEqual(calls, []);
    // the worker works as before: the popup's Open DramaFetch opens the tab — and asks for no level again
    const { message, completed, removed } = on;
    assert.ok(message && completed && removed, "the worker listens to the popup, completed requests and closed tabs");
    /** @type {unknown[]} */
    const answers = [];
    assert.equal(message({ type: "dramafetch:open", load: null }, { id: "dramafetch-test-id", url: `${ROOT}src/app/popup.html` }, (response) => void answers.push(response)), true);
    removed(5);
    await settle();
    assert.deepEqual(calls, [["create", { url: APP }]]);
    assert.deepEqual(answers, [{ ok: true }]);
    assert.deepEqual(levels, TRUSTED, "asked once, at the worker's start, never again");
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("DramaFetch 2.0.1: a Chrome without setAccessLevel, one that throws it and one that refuses it for `local` (Chrome 116–139) — the worker loads all the same, its listeners registered and answering, no unhandled rejection, and restrictStorageToTrustedContexts never throws or rejects", async () => {
  // node:test fails the test during which a promise rejects unhandled (`failureType:
  // 'unhandledRejection'`): the promise of the worker's own top-level call is checked that way
  for (const mode of /** @type {AccessLevelMode[]} */ (["missing", "throw", "reject"])) {
    try {
      const { calls, levels, on, worker, settle } = await fakeWorker({ setAccessLevel: mode });
      // asked for (where Chrome has the method), and nothing came of its failure
      assert.deepEqual(levels, mode === "missing" ? [] : TRUSTED, mode);
      const { message, completed, removed } = on;
      assert.ok(message && completed && removed, `${mode}: the worker listens to the popup, completed requests and closed tabs`);
      /** @type {unknown[]} */
      const answers = [];
      assert.equal(message({ type: "dramafetch:open", load: null }, { id: "dramafetch-test-id", url: `${ROOT}src/app/popup.html` }, (response) => void answers.push(response)), true, mode);
      await settle();
      assert.deepEqual(calls, [["create", { url: APP }]], mode);
      assert.deepEqual(answers, [{ ok: true }], mode);
      // the function itself, called again: no throw, and a promise that resolves whatever Chrome did
      /** @type {Promise<void> | undefined} */
      let again;
      assert.doesNotThrow(() => void (again = worker.restrictStorageToTrustedContexts()), mode);
      assert.ok(again instanceof Promise, mode);
      assert.equal(await again, undefined, mode);
      await settle();
      assert.deepEqual(levels, mode === "missing" ? [] : [...TRUSTED, ...TRUSTED], mode);
    } finally {
      Reflect.deleteProperty(globalThis, "chrome");
    }
  }
});

test("the popup's Download this series has the series downloaded like the 1.x right-click did — no page running: a tab opens with it; the engine's tab takes it and comes to the front; an address that names no series is handed over as it is; a tab whose page is not running reloads with it —; the popup's Open DramaFetch leaves the open tab as it is", async () => {
  try {
    const { calls, state, on, settle } = await fakeWorker();
    const { message } = on;
    assert.ok(message, "the worker listens to the popup");
    const popup = { id: "dramafetch-test-id", url: `${ROOT}src/app/popup.html` };
    /** @type {unknown[]} */
    const answers = [];
    /** @param {unknown} sent */
    const send = (sent) => message(sent, popup, (response) => void answers.push(response));

    // no DramaFetch page running, no tab: one opens with the series to download (`app.html?load=<series id>`)
    const load = { type: "dramafetch:load", input: SERIES };
    assert.equal(send({ type: "dramafetch:open", load: SERIES }), true);
    await settle();
    assert.deepEqual(calls, [["sendMessage", load], ["create", { url: `${APP}?load=${SERIES}` }]]);
    assert.deepEqual(answers, [{ ok: true }]);
    calls.length = 0;

    // the engine's tab takes the series and names itself: that tab comes to the front, nothing reloads
    state.tabs = [{ id: 9, windowId: 4, url: APP }];
    state.pages = { ok: true, tabId: 7 };
    send({ type: "dramafetch:open", load: SERIES });
    await settle();
    assert.deepEqual(calls, [["sendMessage", load], ["update", 7, { active: true }], ["focus", 3, { focused: true }]]);
    calls.length = 0;

    // an address that names no series: handed over as it is, the tab says why it downloads nothing
    send({ type: "dramafetch:open", load: "https://www.tiktok.com/shortdrama/foryou" });
    await settle();
    assert.deepEqual(calls[0], ["sendMessage", { type: "dramafetch:load", input: "https://www.tiktok.com/shortdrama/foryou" }]);
    calls.length = 0;

    // the DramaFetch tab open but its page not running (restored by Chrome after a restart but not
    // loaded yet, or discarded): it reloads with the series in its address
    state.pages = undefined;
    send({ type: "dramafetch:open", load: SERIES });
    await settle();
    assert.deepEqual(calls, [["sendMessage", load], ["update", 9, { active: true, url: `${APP}?load=${SERIES}` }], ["focus", 4, { focused: true }]]);
    calls.length = 0;

    // the popup's Open DramaFetch (no series): the open tab comes to the front as it is — nothing is
    // sent to the pages, nothing reloads
    answers.length = 0;
    assert.equal(send({ type: "dramafetch:open", load: null }), true);
    await settle();
    assert.deepEqual(calls, [["update", 9, { active: true }], ["focus", 4, { focused: true }]]);
    assert.deepEqual(answers, [{ ok: true }]);
    calls.length = 0;
    // another extension, or another message: not heard
    assert.equal(message({ type: "dramafetch:open", load: null }, { id: "another-extension", url: "chrome-extension://another-extension/popup.html" }, (response) => void answers.push(response)), false);
    assert.equal(send({ type: "dramafetch:load", input: SERIES }), false);
    await settle();
    assert.deepEqual(calls, []);
    assert.deepEqual(answers, [{ ok: true }]);
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("the worker: the favorites list's FIRST page kept per tab from the tab's own requests, never replaced by a later page, and forgotten when the tab closes; the popup's Open my library on a profile hands that tab over (the tab alone: no card, no menu); only the extension's own pages and worker are heard", async () => {
  const FAVORITES = "https://www.tiktok.com/api/user/favorite/drama_list/?WebIdLastTime=1794300000&aid=1988&count=19&cursor=0&X-Bogus=DFSzswVO";
  try {
    const { calls, state, session, shows, filter, on, worker, settle } = await fakeWorker();
    const { message, removed } = on;
    const hear = on.completed;
    assert.ok(message && removed && hear, "the worker listens to the popup, closed tabs and completed requests");
    /**
     * What webRequest reports when a request of a tab completes (URL, status, tab, time: no body, no header).
     * @param {Partial<chrome.webRequest.CompletedDetails>} details
     * @returns {chrome.webRequest.CompletedDetails}
     */
    const completed = (details) => ({ requestId: "1", url: FAVORITES, method: "GET", tabId: 5, type: "xmlhttprequest", timeStamp: 1794351568000, statusCode: 200, fromCache: false, ...details });

    // the observer: the URLs holding drama_list on TikTok's hosts, xmlhttprequest only — Chrome hands
    // the worker no other request of the user's TikTok tabs; observation (no "blocking", no
    // "requestBody", no "extraHeaders" in the filter's place); in the test copy the fake's host too
    assert.deepEqual(filter(), { urls: ["https://www.tiktok.com/*drama_list*", "https://*.tiktok.com/*drama_list*"], types: ["xmlhttprequest"] });
    assert.deepEqual(worker.favoritesObserverUrls({ manifest_version: 3, name: "x", version: "1", host_permissions: ["https://www.tiktok.com/*", "http://127.0.0.1/*"] }), [
      "https://www.tiktok.com/*drama_list*",
      "https://*.tiktok.com/*drama_list*",
    ]);
    assert.deepEqual(
      worker.favoritesObserverUrls({ manifest_version: 3, name: "x", version: "1", dramafetch_test: true, host_permissions: ["https://www.tiktok.com/*", "http://127.0.0.1/*"] }),
      ["https://www.tiktok.com/*drama_list*", "https://*.tiktok.com/*drama_list*", "http://127.0.0.1/*drama_list*"],
    );
    // kept per tab: the list's first page of a tab, answered 200 — its URL and when, nothing else —,
    // with whose list it reads: the @handle of the profile page that asked for it
    const viewer = "https://www.tiktok.com/@invented_viewer";
    shows.set(5, viewer);
    shows.set(6, viewer);
    hear(completed({}));
    await settle();
    assert.deepEqual([...session.entries()], [["favoritesTemplate:5", { url: FAVORITES, at: 1794351568, profile: "@invented_viewer" }]]);
    // never kept, never replacing it: a later page — the page's own as its grid scrolls, or one the
    // DramaFetch tab asked for (cursor ≠ 0) —, a drama_list without `favorite`, another status, no
    // tab (the extension's own worker or a request of no tab), another list
    const next = FAVORITES.replace("cursor=0", "cursor=1794351568");
    hear(completed({ url: next, timeStamp: 1794351570500 }));
    hear(completed({ url: FAVORITES.replace("cursor=0", "cursor=1794350100"), timeStamp: 1794351571500 }));
    hear(completed({ url: "https://www.tiktok.com/api/drama/recommend/drama_list/?aid=1988&cursor=0", timeStamp: 1794351572000 }));
    hear(completed({ statusCode: 429 }));
    hear(completed({ statusCode: 403 }));
    hear(completed({ statusCode: 304 }));
    hear(completed({ tabId: -1 }));
    hear(completed({ url: `https://www.tiktok.com/api/drama/episode/item_list/?dramaID=${SERIES}&cursor=0` }));
    hear(completed({ url: "https://www.tiktok.com/api/user/detail/?from=favorite_drama_list" })); // drama_list in the query only
    await settle();
    assert.deepEqual([...session.entries()], [["favoritesTemplate:5", { url: FAVORITES, at: 1794351568, profile: "@invented_viewer" }]]);
    // the most recent FIRST page wins (the profile shown again, or the DramaFetch tab's own replay of
    // it, byte for byte); a first page without a cursor counts; another tab has its own
    const noCursor = FAVORITES.replace("&cursor=0", "");
    hear(completed({ timeStamp: 1794351573000 }));
    hear(completed({ tabId: 6, url: noCursor, timeStamp: 1794351574000 }));
    await settle();
    assert.deepEqual(session.get("favoritesTemplate:5"), { url: FAVORITES, at: 1794351573, profile: "@invented_viewer" });
    assert.deepEqual(session.get("favoritesTemplate:6"), { url: noCursor, at: 1794351574, profile: "@invented_viewer" });
    hear(completed({ tabId: 6, url: next.replace("&cursor=0", ""), timeStamp: 1794351575000 })); // a later page of tab 6
    await settle();
    assert.deepEqual(session.get("favoritesTemplate:6"), { url: noCursor, at: 1794351574, profile: "@invented_viewer" });
    // whose list an address reads is the profile that asked for it, never the page the tab shows
    // later: DramaFetch's own replay of tab 5's address, byte for byte, made while the tab shows
    // another creator's video (the user browsed on during a listing) keeps the handle kept with it
    shows.set(5, "https://www.tiktok.com/@some_creator/video/7412345678901234567");
    hear(completed({ timeStamp: 1794351576000 }));
    await settle();
    assert.deepEqual(session.get("favoritesTemplate:5"), { url: FAVORITES, at: 1794351576, profile: "@invented_viewer" });
    // a new first page that tab asks for on another profile: that profile's list, and its handle
    const other = FAVORITES.replace("X-Bogus=DFSzswVO", "X-Bogus=OtHeRsIgN");
    shows.set(5, "https://www.tiktok.com/@some_creator");
    hear(completed({ url: other, timeStamp: 1794351577000 }));
    await settle();
    assert.deepEqual(session.get("favoritesTemplate:5"), { url: other, at: 1794351577, profile: "@some_creator" });
    // asked for on no profile page, or by a tab already gone: whose list it is cannot be told
    shows.set(6, "https://www.tiktok.com/foryou");
    hear(completed({ tabId: 6, url: other, timeStamp: 1794351578000 }));
    hear(completed({ tabId: 7, timeStamp: 1794351579000 }));
    await settle();
    assert.deepEqual(session.get("favoritesTemplate:6"), { url: other, at: 1794351578, profile: null });
    assert.deepEqual(session.get("favoritesTemplate:7"), { url: FAVORITES, at: 1794351579, profile: null });
    session.delete("favoritesTemplate:7");
    // forgotten when its tab closes
    removed(5);
    await settle();
    assert.deepEqual([...session.keys()], ["favoritesTemplate:6"]);
    assert.deepEqual(calls, []); // observing asks nothing of the pages or the tabs but their addresses

    // the popup's Open my library on a profile: that tab handed over — the tab alone (2.0.0: no card,
    // no menu, no script) —; no page running: the open DramaFetch tab reloads with it in its address
    state.tabs = [{ id: 9, windowId: 4, url: APP }];
    /** @type {unknown[]} */
    const answers = [];
    const popup = { id: "dramafetch-test-id", url: `${ROOT}src/app/popup.html` };
    assert.equal(message({ type: "dramafetch:open", favorites: 6 }, popup, (response) => void answers.push(response)), true);
    await settle();
    assert.deepEqual(calls, [
      ["sendMessage", { type: "dramafetch:favorites", tabId: 6 }],
      ["update", 9, { active: true, url: `${APP}?favorites=6` }],
      ["focus", 4, { focused: true }],
    ]);
    assert.deepEqual(answers, [{ ok: true }]);
    calls.length = 0;
    // the engine's tab takes it and comes to the front
    state.pages = { ok: true, tabId: 9 };
    message({ type: "dramafetch:open", favorites: 6 }, popup, () => undefined);
    await settle();
    assert.deepEqual(calls, [["sendMessage", { type: "dramafetch:favorites", tabId: 6 }], ["update", 9, { active: true }], ["focus", 3, { focused: true }]]);
    calls.length = 0;
    // a tab id that is none: the popup's Open DramaFetch, as before
    state.pages = undefined;
    assert.equal(message({ type: "dramafetch:open", favorites: -3, load: null }, popup, () => undefined), true);
    await settle();
    assert.deepEqual(calls, [["update", 9, { active: true }], ["focus", 4, { focused: true }]]);
    calls.length = 0;

    // only the extension's own pages and worker are heard: the popup, the DramaFetch tab (in a tab),
    // the worker with or without its address — never a TikTok page carrying the extension's id, nor
    // another extension
    const tiktokTab = { id: 6, index: 0, windowId: 2, active: true, url: viewer };
    for (const [sender, heard] of /** @type {[chrome.runtime.MessageSender, boolean][]} */ ([
      [popup, true],
      [{ id: "dramafetch-test-id", url: `${APP}?load=1`, tab: { id: 9, index: 0, windowId: 4, active: true, url: APP } }, true],
      [{ id: "dramafetch-test-id", url: `${ROOT}src/app/background.js` }, true],
      [{ id: "dramafetch-test-id" }, true],
      [{ id: "dramafetch-test-id", url: viewer, tab: tiktokTab }, false],
      [{ id: "dramafetch-test-id", url: "https://www.tiktok.com/@x/video/1" }, false],
      [{ id: "dramafetch-test-id", tab: tiktokTab }, false], // a tab and no address: never the worker
      [{ id: "dramafetch-test-id", url: "" }, false],
      [{ id: "dramafetch-test-id", url: "chrome-extension://another-extension/popup.html" }, false],
      [{ id: "another-extension", url: `${ROOT}src/app/popup.html` }, false],
      [{ url: `${ROOT}src/app/popup.html` }, false],
    ])) {
      /** @type {unknown[]} */
      const said = [];
      assert.equal(message({ type: "dramafetch:open", favorites: 6 }, sender, (response) => void said.push(response)), heard, JSON.stringify(sender));
      await settle();
      assert.equal(calls.length > 0, heard, JSON.stringify(sender));
      assert.deepEqual(said, heard ? [{ ok: true }] : [], JSON.stringify(sender));
      calls.length = 0;
    }
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("the worker: the popup's Open my library away from a TikTok profile shows the library — the engine's tab answers and comes to the front; with no page to answer, the open DramaFetch tab (or a new one) opens on the library: no job, no request", async () => {
  try {
    const { calls, state, on, settle } = await fakeWorker();
    const { message } = on;
    assert.ok(message, "the worker listens to the popup");
    state.pages = { ok: true, tabId: 9 };
    const popup = { id: "dramafetch-test-id", url: `${ROOT}src/app/popup.html` };
    /** @type {unknown[]} */
    const answers = [];
    // the engine's tab takes it (it scrolls to its library) and comes to the front
    assert.equal(message({ type: "dramafetch:open", library: true }, popup, (response) => void answers.push(response)), true);
    await settle();
    assert.deepEqual(calls, [["sendMessage", { type: "dramafetch:library" }], ["update", 9, { active: true }], ["focus", 3, { focused: true }]]);
    assert.deepEqual(answers, [{ ok: true }]);
    calls.length = 0;
    // no page running to answer: the open DramaFetch tab on the library
    state.pages = new Error("Could not establish connection. Receiving end does not exist.");
    state.tabs = [{ id: 9, windowId: 4, url: APP }];
    message({ type: "dramafetch:open", library: true }, popup, () => undefined);
    await settle();
    assert.deepEqual(calls.slice(1), [["update", 9, { active: true, url: `${APP}?library=1` }], ["focus", 4, { focused: true }]]);
    calls.length = 0;
    // no DramaFetch tab at all: a new one, on the library
    state.tabs = [];
    message({ type: "dramafetch:open", library: true }, popup, () => undefined);
    await settle();
    assert.deepEqual(calls.slice(1), [["create", { url: `${APP}?library=1` }]]);
    calls.length = 0;
    // only `library: true` asks for it; anything else is the plain Open DramaFetch
    message({ type: "dramafetch:open", library: "yes" }, popup, () => undefined);
    await settle();
    assert.deepEqual(calls, [["create", { url: APP }]]);
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});
