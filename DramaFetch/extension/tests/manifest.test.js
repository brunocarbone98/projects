// @ts-check
// The manifest is part of the line: exactly the permissions the README justifies, host access to
// TikTok and its CDNs only, no content script and no right-click menu (DramaFetch 2.0.0 took the
// right-click items and their favorites card reader away), no test key and no localhost in the
// shipped file (the test harness adds both to a temporary COPY), no remote code — and the sources
// never reach for an API the extension must not use (cookies, debugger, blocking webRequest) or no
// longer uses (contextMenus, a message to a content script), nor does a function it injects into a
// TikTok tab reach for an extension API or a storage (2.0.1), nor does anything press, read or
// observe TikTok's Bookmark button or its request any more (3.0.0: the removal from the Favorites
// is gone), nor does anything read, observe or keep the user's TikTok Favorites or their library, or
// inject anything into a tab of the user's (4.0.0: no library).
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { fetchInPage, pageTextInPage, scrollInPage } from "../src/app/discovery.js";
import { TIKTOK_DOMAINS, hostCovered } from "../src/app/downloader.js";

/** @param {string} relative @returns {URL} */
const file = (relative) => new URL(`../${relative}`, import.meta.url);
/** @type {Record<string, unknown>} */
const manifest = JSON.parse(readFileSync(file("manifest.json"), "utf8"));

const PERMISSIONS = [
  "downloads",
  "storage",
  "unlimitedStorage", // the series' progress is not held to chrome.storage.local's 10 MB (README: the permissions table)
  "scripting",
  "tabs",
  "webRequest",
  "declarativeNetRequestWithHostAccess",
  "notifications", // the alert when a drama finishes, the owner's request of 2026-11-19 (README: the permissions table)
];
const HOSTS = [
  "https://www.tiktok.com/*",
  "https://*.tiktok.com/*",
  "https://*.tiktokcdn.com/*",
  "https://*.tiktokcdn-us.com/*",
  "https://*.tiktokcdn-eu.com/*",
  "https://*.tiktokv.com/*",
  "https://*.tiktokv.us/*",
  "https://*.byteoversea.com/*",
  "https://*.ibytedtos.com/*",
  "https://*.ibyteimg.com/*",
  "https://*.muscdn.com/*",
];

/**
 * Every file under a directory, relative to the extension root.
 * @param {string} relative
 * @returns {string[]}
 */
function walk(relative) {
  /** @type {string[]} */
  const found = [];
  for (const name of readdirSync(file(relative))) {
    const path = `${relative}/${name}`;
    if (name.includes(".")) found.push(path);
    else found.push(...walk(path));
  }
  return found;
}

/**
 * The object literal each `executeScript(` of a source is called with — its braces matched, so a nested
 * `target: { tabId }` stays inside —, where it starts and where it ends; a call given anything but an object
 * literal gives none.
 * @param {string} text
 * @returns {{start: number, end: number, literal: string}[]}
 */
function injectionCalls(text) {
  /** @type {{start: number, end: number, literal: string}[]} */
  const calls = [];
  for (const match of text.matchAll(/\bexecuteScript\s*\(\s*\{/g)) {
    const start = match.index + match[0].length - 1;
    for (let at = start, depth = 0; at < text.length; at += 1) {
      if (text[at] === "{") depth += 1;
      else if (text[at] === "}" && --depth === 0) {
        calls.push({ start, end: at, literal: text.slice(start, at + 1) });
        break;
      }
    }
  }
  return calls;
}

test("a Manifest V3 extension named from _locales, English by default", () => {
  assert.equal(manifest["manifest_version"], 3);
  assert.equal(manifest["name"], "__MSG_extName__");
  assert.equal(manifest["description"], "__MSG_extDescription__");
  assert.equal(manifest["default_locale"], "en");
  assert.match(String(manifest["version"]), /^\d+\.\d+\.\d+$/);
});

test("one version for the whole of DramaFetch: the manifest, package.json, pyproject.toml and the package", () => {
  // the owner reads the version in chrome://extensions and in the tab's header: every user-visible change
  // bumps it (CHANGELOG.md), and the Python tool ships the same number
  const version = String(manifest["version"]);
  /** @type {Record<string, unknown>} */
  const pkg = JSON.parse(readFileSync(file("package.json"), "utf8"));
  assert.equal(pkg["version"], version);
  const pyproject = readFileSync(file("../pyproject.toml"), "utf8");
  assert.equal(/^version = "([^"]+)"$/m.exec(pyproject)?.[1], version);
  const init = readFileSync(file("../src/dramafetch/__init__.py"), "utf8");
  assert.equal(/^__version__ = "([^"]+)"$/m.exec(init)?.[1], version);
  const changelog = readFileSync(file("../CHANGELOG.md"), "utf8");
  assert.ok(changelog.includes(`## ${version} `), `CHANGELOG.md has no entry for ${version}`);
});

test("exactly the permissions the README justifies: no cookies, no debugger, no blocking", () => {
  assert.deepEqual([...(/** @type {string[]} */ (manifest["permissions"]))].sort(), [...PERMISSIONS].sort());
  for (const key of ["optional_permissions", "optional_host_permissions", "externally_connectable", "web_accessible_resources", "key", "update_url"]) {
    assert.equal(Object.hasOwn(manifest, key), false, `${key} must not be in the manifest`);
  }
});

test("no content script and no right-click menu (DramaFetch 2.0.0, the owner's decision of 2026-11-22): no content_scripts, no contextMenus, and no source that reaches for either", () => {
  assert.equal(Object.hasOwn(manifest, "content_scripts"), false);
  assert.ok(!(/** @type {string[]} */ (manifest["permissions"]).includes("contextMenus")));
  assert.equal(existsSync(file("src/content")), false, "src/content: the favorites card reader is gone");
  assert.equal(existsSync(file("src/app/menus.js")), false, "src/app/menus.js: the right-click items are gone");
  const sources = [...walk("src/app"), ...walk("src/lib")].filter((path) => path.endsWith(".js"));
  for (const path of sources) {
    const text = readFileSync(file(path), "utf8");
    assert.doesNotMatch(text, /chrome\s*\.\s*contextMenus/, `${path}: chrome.contextMenus`);
    assert.doesNotMatch(text, /chrome\s*\.\s*tabs\s*\.\s*sendMessage/, `${path}: a message to a content script`);
    assert.doesNotMatch(text, /chrome\s*\.\s*runtime\s*\.\s*on(Installed|Startup)/, `${path}: an install or start-up hook (the menu's)`);
  }
  // the type declarations follow: no API the extension stopped using
  const declared = readFileSync(file("types/chrome.d.ts"), "utf8");
  assert.doesNotMatch(declared, /namespace contextMenus|function sendMessage\(tabId|onInstalled|onStartup|lastError/);
});

test("what DramaFetch injects into a TikTok tab — fetchInPage in the MAIN world, scrollInPage and pageTextInPage in the ISOLATED world, nothing else — uses no extension API and no storage (2.0.1: from Chrome 140 on, chrome.storage.local refuses a script run there)", () => {
  /** @type {Record<string, Function>} */
  const injected = { fetchInPage, scrollInPage, pageTextInPage };
  // every `func` of the sources reads `func: <one of these three>` — an inline, shorthand, quoted or spaced one reads
  // "not a plain name" and fails —, and no file is injected nor a content script registered
  const sources = walk("src").filter((path) => path.endsWith(".js"));
  const named = new Set(sources.flatMap((path) => [...readFileSync(file(path), "utf8").matchAll(/\bfunc\b(?::\s*([A-Za-z_$][\w$]*))?/g)].map((match) => match[1] ?? `${path}: not a plain name`)));
  assert.deepEqual([...named].sort(), Object.keys(injected).sort());
  // each in its own world, named in the `executeScript({…})` call itself: the page's own `fetch` in the MAIN world,
  // the scroll and the page's text in the ISOLATED world (Chrome's default when no `world` is given) — no `func`
  // outside such a call, no spread in one, no `world` but a quoted MAIN or ISOLATED, and only one
  /** @type {Record<string, string>} */
  const worlds = { fetchInPage: "MAIN", scrollInPage: "ISOLATED", pageTextInPage: "ISOLATED" };
  for (const path of sources) {
    const text = readFileSync(file(path), "utf8");
    const calls = injectionCalls(text).filter((call) => /\bfunc\b/.test(call.literal));
    for (const match of text.matchAll(/\bfunc\b/g)) {
      assert.ok(calls.some((call) => call.start < match.index && match.index < call.end), `${path}: a \`func\` outside an executeScript({…}) call`);
    }
    for (const { literal } of calls) {
      const name = /\bfunc:\s*([A-Za-z_$][\w$]*)/.exec(literal)?.[1] ?? "";
      assert.doesNotMatch(literal, /\.\.\./, `${path}: ${name} injected with a spread`);
      const given = [...literal.matchAll(/\bworld\b(?:\s*:\s*["'](MAIN|ISOLATED)["'])?/g)].map((world) => world[1] ?? "not a quoted world");
      assert.ok(given.length <= 1, `${path}: ${name} given more than one world`);
      assert.equal(given[0] ?? "ISOLATED", worlds[name], `${path}: ${name} injected in the wrong world`);
    }
  }
  // and only discovery.js injects any — the module that defines the three functions this test and the next one read: a
  // function of the same name declared and injected in another module would escape both
  assert.deepEqual(sources.filter((path) => injectionCalls(readFileSync(file(path), "utf8")).some((call) => /\bfunc\b/.test(call.literal))), ["src/app/discovery.js"]);
  for (const path of sources) {
    assert.doesNotMatch(readFileSync(file(path), "utf8"), /\bfiles\b["']?\s*:|\bregisterContentScripts\b/, `${path}: no injected file and no registered content script`);
  }
  for (const [name, inject] of Object.entries(injected)) {
    assert.doesNotMatch(String(inject), /\bchrome\b|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bcaches\b|\bcookie/, `${name}: no extension API or storage in a TikTok tab`);
  }
});

test("nothing presses, reads or observes TikTok's Bookmark any more (DramaFetch 3.0.0, the owner's decision of 2026-11-25): no src/app/bookmark.js, no source that looks for the button or its `collect` request, nothing that clicks an element — and nothing injected into a TikTok tab presses, focuses or submits anything or dispatches an event but the list's scroll —, no removal dialog or setting on the page", () => {
  assert.equal(existsSync(file("src/app/bookmark.js")), false, "src/app/bookmark.js: the removal from the Favorites is gone");
  for (const path of walk("src").filter((name) => name.endsWith(".js"))) {
    const text = readFileSync(file(path), "utf8");
    assert.doesNotMatch(text, /favorite-icon|action_favorite|FACE15/i, `${path}: TikTok's Bookmark button`);
    assert.doesNotMatch(text, /\/collect\b|isCollectUrl/, `${path}: the Bookmark's collect request`);
    assert.doesNotMatch(text, /\.click\s*(\?\.\s*)?\(|\[\s*["'`]click["'`]\s*\]/, `${path}: a click on an element`);
  }
  // only these three run in a TikTok tab (the test above pins every `func` to them, with no file and no
  // registered script): none presses, focuses or submits anything there or looks for the Bookmark — the one
  // event any of them makes is scrollInPage's `scroll`, on the list it scrolls
  for (const [name, inject] of Object.entries({ fetchInPage, scrollInPage, pageTextInPage })) {
    const body = String(inject);
    assert.doesNotMatch(body, /click|submit|focus|createEvent|(Mouse|Pointer|Keyboard|Touch|Wheel|Drag|Input|UI|Custom)Event|__react|aria-|favorite|bookmark|collect|data-e2e/i, `${name}: nothing pressed or looked for in TikTok's page`);
    const made = [...body.matchAll(/\bnew\s+([\w$.]*Event)\s*\(\s*([^),]*)/g)].map((match) => `${match[1]}(${match[2]})`);
    assert.deepEqual(made, name === "scrollInPage" ? ['Event("scroll")'] : [], `${name}: the events it makes in a TikTok tab`);
    const dispatched = [...body.matchAll(/\bdispatchEvent\b[^;\n]*/g)].map((match) => match[0]);
    assert.deepEqual(dispatched, name === "scrollInPage" ? ['dispatchEvent(new Event("scroll"))'] : [], `${name}: the events it dispatches in a TikTok tab`);
  }
  const html = readFileSync(file("src/app/app.html"), "utf8");
  assert.doesNotMatch(html, /<dialog|setting-auto-remove|library-removed|bookmark/i, "app.html: no removal dialog, setting or line");
});

test("nothing reads, observes or keeps the user's TikTok Favorites any more, and nothing is injected into a tab of theirs (DramaFetch 4.0.0, the owner's decision of 2026-11-27): no library or favorites module, no favorites request observed, no address of theirs kept, no hand-over of them; the worker observes no request at all; only the discovery's own tab is injected into; the library 3.x kept is named only to be removed", () => {
  for (const gone of ["src/lib/favorites.js", "src/lib/library.js", "src/app/favorites.js"]) assert.equal(existsSync(file(gone)), false, `${gone}: gone with the library`);
  const sources = walk("src").filter((path) => path.endsWith(".js") || path.endsWith(".html"));
  for (const path of sources) {
    const text = readFileSync(file(path), "utf8");
    assert.doesNotMatch(text, /drama_list|favoritesTemplate|favoritesCovers|dramafetch:(favorites|library)|[?&](favorites|library)=|isProfilePageUrl|profileHandleOf/, `${path}: the Favorites or the library`);
    // the library's keys only where they are removed (storage.RETIRED_KEYS), and nowhere read or written
    if (path !== "src/app/storage.js") assert.doesNotMatch(text, /favoritesLibrary|librarySort/, `${path}: the library's stored keys`);
    // the discovery alone runs its browser — the tab it opens, nothing else, is injected into
    if (path !== "src/app/discovery.js") assert.doesNotMatch(text, /\bchromeBrowser\b|\bfetchInTab\b|\bscrollTab\b|\bpageText\(/, `${path}: an injection outside the discovery`);
  }
  const storage = readFileSync(file("src/app/storage.js"), "utf8");
  assert.equal(storage.match(/"favoritesLibrary"|"librarySort"/g)?.length, 2, "storage.js: each retired key named once, in RETIRED_KEYS");
  assert.match(storage, /export const RETIRED_KEYS = Object\.freeze\(\["history", "favoritesLibrary", "librarySort"\]\);/);
  const discovery = readFileSync(file("src/app/discovery.js"), "utf8");
  assert.equal(discovery.match(/\bchromeBrowser\(/g)?.length, 2, "discovery.js: chromeBrowser declared once and called once, by discoverSeries for the tab it opens");
  // `chrome.x`, `chrome?.x` and `chrome["x"]` alike; its `tabs.query` / `tabs.onUpdated` compare
  // addresses with the DramaFetch tab's only, and keep nothing
  assert.doesNotMatch(
    readFileSync(file("src/app/background.js"), "utf8"),
    /chrome\s*(?:\?\.|\.)\s*(?:webRequest|tabs\s*(?:\?\.|\.)\s*get\b)|chrome\s*(?:\?\.)?\s*\[\s*["'`]webRequest/,
    "background.js: the worker observes no request and looks up no tab by id (no chrome.webRequest, no chrome.tabs.get)",
  );
  const popup = readFileSync(file("src/app/popup.html"), "utf8");
  assert.doesNotMatch(popup, /popup-favorites|popup-library/);
});

test("host access to TikTok and its media and image CDNs only, https, never localhost", () => {
  const hosts = /** @type {string[]} */ (manifest["host_permissions"]);
  assert.deepEqual(hosts, HOSTS);
  for (const host of hosts) {
    assert.match(host, /^https:\/\/(www\.tiktok\.com|\*\.[a-z0-9-]+\.[a-z]+)\/\*$/);
    assert.doesNotMatch(host, /localhost|127\.0\.0\.1|<all_urls>|\*:\/\//);
  }
  // the Referer rule's request domains are the same domains, nothing more
  const domains = hosts.map((host) => host.replace(/^https:\/\/(\*\.|www\.)?/, "").replace(/\/\*$/, ""));
  assert.deepEqual([...new Set(domains)].sort(), [...TIKTOK_DOMAINS].sort());
});

test("the shipped manifest is never the test build", () => {
  assert.equal(Object.hasOwn(manifest, "dramafetch_test"), false);
  assert.doesNotMatch(readFileSync(file("manifest.json"), "utf8"), /dramafetch_test|localhost|127\.0\.0\.1/);
});

test("no remote code: a strict CSP, a module service worker, local files only", () => {
  assert.deepEqual(manifest["content_security_policy"], { extension_pages: "script-src 'self'; object-src 'self'" });
  const background = /** @type {{service_worker: string, type: string}} */ (manifest["background"]);
  assert.equal(background.type, "module");
  assert.ok(existsSync(file(background.service_worker)));
  const action = /** @type {{default_popup: string, default_icon: Record<string, string>}} */ (manifest["action"]);
  assert.ok(existsSync(file(action.default_popup)));
  for (const page of walk("src/app").filter((path) => path.endsWith(".html"))) {
    const html = readFileSync(file(page), "utf8");
    assert.doesNotMatch(html, /<(script|link|img|iframe)[^>]+(src|href)="(https?:)?\/\//i, `${page} loads a remote resource`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${page} has an inline script`);
  }
});

test("the icons are PNGs of the declared sizes", () => {
  const icons = /** @type {Record<string, string>} */ (manifest["icons"]);
  assert.deepEqual(Object.keys(icons).sort(), ["128", "16", "48"]);
  for (const [size, path] of Object.entries(icons)) {
    const png = readFileSync(file(path));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], path);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    assert.equal(view.getUint32(16), Number(size), `${path} width`);
    assert.equal(view.getUint32(20), Number(size), `${path} height`);
  }
});

test("the sources never use an API or a trick the line forbids", () => {
  const sources = [...walk("src/app"), ...walk("src/lib")].filter((path) => path.endsWith(".js"));
  assert.ok(sources.length > 10);
  const forbidden = [
    [/chrome\s*\.\s*cookies/, "chrome.cookies"],
    [/chrome\s*\.\s*debugger/, "chrome.debugger"],
    [/document\s*\.\s*cookie/, "document.cookie"],
    [/["']blocking["']/, "blocking webRequest"],
    [/webRequestBlocking/, "webRequestBlocking"],
    [/\beval\s*\(/, "eval"],
    [/new\s+Function\s*\(/, "new Function"],
    [/navigator\s*\.\s*webdriver/, "navigator.webdriver"],
    [/Object\s*\.\s*defineProperty\s*\(\s*(window|navigator|globalThis)/, "patching the page"],
    [/window\s*\.\s*fetch\s*=/, "replacing fetch"],
  ];
  for (const path of sources) {
    const text = readFileSync(file(path), "utf8");
    for (const [pattern, what] of forbidden) assert.doesNotMatch(text, /** @type {RegExp} */ (pattern), `${path}: ${what}`);
  }
});

test("a media URL outside the manifest's hosts is never requested", () => {
  assert.equal(hostCovered("https://v16-webapp-prime.tiktok.com/video/x?expire=1", HOSTS), true);
  assert.equal(hostCovered("https://p16-sign-sg.tiktokcdn.com/obj/cover.jpeg", HOSTS), true);
  assert.equal(hostCovered("https://tiktok.com/x", HOSTS), true);
  assert.equal(hostCovered("http://v16-webapp-prime.tiktok.com/video/x", HOSTS), false); // http
  assert.equal(hostCovered("https://example.com/video.mp4", HOSTS), false);
  assert.equal(hostCovered("https://tiktok.com.example.com/x", HOSTS), false);
  assert.equal(hostCovered("https://eviltiktok.com/x", HOSTS), false);
  assert.equal(hostCovered("http://127.0.0.1:8080/cdn/1.mp4", HOSTS), false);
  assert.equal(hostCovered("http://127.0.0.1:8080/cdn/1.mp4", [...HOSTS, "http://127.0.0.1/*"]), true);
  assert.equal(hostCovered("not a url", HOSTS), false);
});
