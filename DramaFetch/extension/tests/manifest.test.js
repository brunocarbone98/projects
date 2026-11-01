// @ts-check
// The manifest is part of the line: exactly the permissions the README justifies, host access to
// TikTok and its CDNs only, no test key and no localhost in the shipped file (the test harness
// adds both to a temporary COPY), no remote code — and the sources never reach for an API the
// extension must not use (cookies, debugger, blocking webRequest).
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { TIKTOK_DOMAINS, hostCovered } from "../src/app/downloader.js";

/** @param {string} relative @returns {URL} */
const file = (relative) => new URL(`../${relative}`, import.meta.url);
/** @type {Record<string, unknown>} */
const manifest = JSON.parse(readFileSync(file("manifest.json"), "utf8"));

const PERMISSIONS = ["downloads", "storage", "scripting", "tabs", "webRequest", "declarativeNetRequestWithHostAccess"];
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

test("a Manifest V3 extension named from _locales, English by default", () => {
  assert.equal(manifest["manifest_version"], 3);
  assert.equal(manifest["name"], "__MSG_extName__");
  assert.equal(manifest["description"], "__MSG_extDescription__");
  assert.equal(manifest["default_locale"], "en");
  assert.match(String(manifest["version"]), /^\d+\.\d+\.\d+$/);
});

test("exactly the permissions the README justifies: no cookies, no debugger, no blocking", () => {
  assert.deepEqual([...(/** @type {string[]} */ (manifest["permissions"]))].sort(), [...PERMISSIONS].sort());
  for (const key of ["optional_permissions", "optional_host_permissions", "content_scripts", "externally_connectable", "web_accessible_resources", "key", "update_url"]) {
    assert.equal(Object.hasOwn(manifest, key), false, `${key} must not be in the manifest`);
  }
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
