// @ts-check
// The service worker (src/app/background.js) over a fake chrome: the popup's hand-over — its
// **Download this series** has the DramaFetch tab download that series (1.7.0: the batch job a paste
// of it queues), its **Open DramaFetch** brings the tab to the front as it is — and only the
// extension's own pages and worker heard. DramaFetch 2.0.0 took the right-click items away: the fake
// chrome has no `contextMenus`, no `runtime.onInstalled` / `onStartup` and no `tabs.sendMessage`,
// so a worker that reached for any of them would throw at its start; DramaFetch 4.0.0 took away
// what it observed and kept of the user's TikTok tabs (their favorites list's address): the fake
// chrome has no `tabs.get` either, and its `webRequest` only records a listener added to any of
// its events (`chrome.webRequest?.…` included) — the worker adds none —, and the 3.x hand-overs of
// the favorites and the library are a plain **Open DramaFetch**. Every listener the worker adds is
// recorded once per call (`added`): its own three, each once, and nothing else. Ported
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
 * `state.tabs` the open tabs, `session` the browser session's memory, `on` its listeners, `added`
 * every listener it added — `runtime.onMessage`, `tabs.onRemoved`, `webRequest.onCompleted`, … —,
 * one entry per call, in order.
 * @param {{setAccessLevel?: AccessLevelMode}} [options]
 * @returns {Promise<{
 *   calls: unknown[][],
 *   levels: unknown[][],
 *   added: string[],
 *   state: {pages: unknown, tabs: {id: number, windowId: number, url: string}[]},
 *   session: Map<string, unknown>,
 *   on: {message?: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean, removed?: (tabId: number) => void},
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
  /** @type {{message?: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean, removed?: (tabId: number) => void}} */
  const on = {};
  /** @type {string[]} every listener the worker added, one entry per call */
  const added = [];
  const state = {
    /** @type {unknown} */
    pages: new Error("Could not establish connection. Receiving end does not exist."),
    /** @type {{id: number, windowId: number, url: string}[]} */
    tabs: [],
  };
  /** @type {Map<string, unknown>} chrome.storage.session */
  const session = new Map();
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
        onMessage: {
          addListener: (/** @type {NonNullable<typeof on.message>} */ listener) => {
            added.push("runtime.onMessage");
            on.message = listener;
          },
        },
      },
      i18n: { getMessage: () => "", getUILanguage: () => "en" },
      tabs: {
        query: async () => state.tabs,
        create: async (/** @type {unknown} */ properties) => void calls.push(["create", properties]),
        update: async (/** @type {number} */ id, /** @type {unknown} */ properties) => {
          calls.push(["update", id, properties]);
          return { id, windowId: 3, active: true, index: 0 };
        },
        remove: async () => undefined,
        onRemoved: {
          addListener: (/** @type {(tabId: number) => void} */ listener) => {
            added.push("tabs.onRemoved");
            on.removed = listener;
          },
        },
        onUpdated: { addListener: () => void added.push("tabs.onUpdated") },
      },
      // any event of it: a listener added is recorded, never thrown on — so that one added through
      // `chrome.webRequest?.…` is seen too
      webRequest: new Proxy({}, { get: (_target, event) => ({ addListener: () => void added.push(`webRequest.${String(event)}`) }) }),
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
  return { calls, levels, added, state, session, on, worker, settle };
}

test("the worker starts with no right-click menu (DramaFetch 2.0.0) and observes no request (4.0.0): no contextMenus, no install or start-up hook, no message to a tab, no webRequest listener — it asks nothing of Chrome at its start but its three listeners, each added once, and, since 2.0.1, the storage's access level", async () => {
  try {
    // the fake chrome has none of the menus' APIs and no tabs.get: a worker reaching for one would have
    // thrown here; its webRequest records any listener added to it (the worker adds none)
    const { calls, levels, added, on } = await fakeWorker();
    assert.deepEqual(calls, []);
    assert.deepEqual(levels, TRUSTED);
    assert.ok(on.message && on.removed, "the worker listens to the popup and to closed tabs");
    // each of its listeners once — the popup's messages, a closed tab, a tab that left the app or was
    // discarded — and nothing else: no webRequest listener, no second listener on any event
    assert.deepEqual([...added].sort(), ["runtime.onMessage", "tabs.onRemoved", "tabs.onUpdated"]);
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
    const { message, removed } = on;
    assert.ok(message && removed, "the worker listens to the popup and to closed tabs");
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
      const { message, removed } = on;
      assert.ok(message && removed, `${mode}: the worker listens to the popup and to closed tabs`);
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

test("the worker: only the extension's own pages and worker are heard — the popup, the DramaFetch tab (in a tab), the worker with or without its address —, never a TikTok page carrying the extension's id, nor another extension; a 3.x hand-over of the favorites or the library is a plain Open DramaFetch (4.0.0): no message to the pages, no address", async () => {
  try {
    const { calls, state, on, settle } = await fakeWorker();
    const { message } = on;
    assert.ok(message, "the worker listens to the popup");
    state.tabs = [{ id: 9, windowId: 4, url: APP }];
    const popup = { id: "dramafetch-test-id", url: `${ROOT}src/app/popup.html` };
    // what a 3.x popup sent for its Open my library — on a profile (that tab), or elsewhere —, and
    // anything else that names no series: the open DramaFetch tab comes to the front as it is
    for (const sent of [{ favorites: 6 }, { library: true }, { favorites: 6, load: null }, { library: true, load: "" }, {}]) {
      /** @type {unknown[]} */
      const answers = [];
      assert.equal(message({ type: "dramafetch:open", ...sent }, popup, (response) => void answers.push(response)), true, JSON.stringify(sent));
      await settle();
      assert.deepEqual(calls, [["update", 9, { active: true }], ["focus", 4, { focused: true }]], JSON.stringify(sent));
      assert.deepEqual(answers, [{ ok: true }], JSON.stringify(sent));
      calls.length = 0;
    }
    // no DramaFetch tab open: a new one, its address bare
    state.tabs = [];
    message({ type: "dramafetch:open", favorites: 6 }, popup, () => undefined);
    await settle();
    assert.deepEqual(calls, [["create", { url: APP }]]);
    calls.length = 0;
    state.tabs = [{ id: 9, windowId: 4, url: APP }];

    // only the extension's own pages and worker are heard: the popup, the DramaFetch tab (in a tab),
    // the worker with or without its address — never a TikTok page carrying the extension's id, nor
    // another extension
    const viewer = "https://www.tiktok.com/@invented_viewer";
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
      assert.equal(message({ type: "dramafetch:open", load: null }, sender, (response) => void said.push(response)), heard, JSON.stringify(sender));
      await settle();
      assert.equal(calls.length > 0, heard, JSON.stringify(sender));
      assert.deepEqual(said, heard ? [{ ok: true }] : [], JSON.stringify(sender));
      calls.length = 0;
    }
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});
