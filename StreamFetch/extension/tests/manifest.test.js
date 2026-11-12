// @ts-check
// The permissions contract of StreamFetch for Chrome (spec section 6, Addendum A.1): exactly the
// permissions and host permissions the spec lists, no `tabs`, `scripting`, `webRequest`, `cookies`,
// `debugger` or `<all_urls>`, no remote code, one version everywhere — and the Referer rule's
// media domains all inside the host permissions.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { MEDIA_DOMAINS, hostCovered } from "../src/app/downloader.js";

/** @type {Record<string, unknown>} */
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
/** @type {Record<string, unknown>} */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const CHANGELOG = new URL("../../CHANGELOG.md", import.meta.url);

const HOSTS = [
  "https://www.dailymotion.com/*",
  "https://*.dailymotion.com/*",
  "https://dai.ly/*",
  "https://*.dmcdn.net/*",
  "https://www.bilibili.com/*",
  "https://*.bilibili.com/*",
  "https://b23.tv/*",
  "https://*.bilivideo.com/*",
  "https://*.bilivideo.cn/*",
  "https://upos-hz-mirrorakam.akamaized.net/*",
  "https://*.hdslb.com/*",
  "https://*.bilibili.tv/*",
  "https://*.biliintl.com/*",
  "https://*.bstarstatic.com/*",
  "https://upos-bstar1-mirrorakam.akamaized.net/*",
];

test("the manifest: MV3, the names from _locales, version 1.0.1, Chrome 116+", () => {
  assert.equal(manifest["manifest_version"], 3);
  assert.equal(manifest["name"], "__MSG_extName__");
  assert.equal(manifest["description"], "__MSG_extDescription__");
  assert.equal(manifest["default_locale"], "en");
  assert.equal(manifest["short_name"], "StreamFetch");
  assert.equal(manifest["version"], "1.0.1");
  assert.equal(manifest["minimum_chrome_version"], "116");
  assert.equal(manifest["streamfetch_test"], undefined, "the shipped manifest is never the test copy");
});

test("exactly the permissions of the spec, and none of the forbidden ones", () => {
  assert.deepEqual(manifest["permissions"], ["downloads", "storage", "declarativeNetRequestWithHostAccess"]);
  assert.deepEqual(manifest["host_permissions"], HOSTS);
  const everything = JSON.stringify(manifest);
  for (const forbidden of ["tabs", "scripting", "webRequest", "cookies", "debugger", "<all_urls>", "externally_connectable", "content_scripts", "web_accessible_resources", "optional_permissions", "optional_host_permissions"]) {
    assert.ok(!everything.includes(`"${forbidden}"`), `${forbidden} must not appear in the manifest`);
  }
});

test("no remote code: the CSP allows the extension's own scripts only; the worker is a module", () => {
  assert.deepEqual(manifest["content_security_policy"], {
    extension_pages: "script-src 'self'; object-src 'self'",
  });
  assert.deepEqual(manifest["background"], { service_worker: "src/app/background.js", type: "module" });
  const action = /** @type {Record<string, unknown>} */ (manifest["action"]);
  assert.equal(action["default_popup"], "src/app/popup.html");
  assert.equal(action["default_title"], "__MSG_actionTitle__");
  for (const page of ["src/app/app.html", "src/app/popup.html"]) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    for (const match of html.matchAll(/<script\b[^>]*>/g)) {
      assert.match(match[0], /src="[a-z]+\.js"/, `${page}: only the extension's own scripts`);
      assert.doesNotMatch(match[0], /https?:/, `${page}: no remote script`);
    }
    assert.doesNotMatch(html, /<script\b[^>]*>[^<]+<\/script>/, `${page}: no inline script`);
  }
});

test("the icons the manifest names exist and are PNG files", () => {
  const icons = /** @type {Record<string, string>} */ (manifest["icons"]);
  assert.deepEqual(Object.keys(icons), ["16", "48", "128"]);
  for (const path of Object.values(icons)) {
    const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], path);
  }
});

test("one version: the manifest's equals package.json's", () => {
  assert.equal(pkg["version"], manifest["version"]);
  assert.equal(pkg["dependencies"], undefined, "no npm dependency");
  assert.equal(pkg["devDependencies"], undefined, "no npm dependency");
});

test("CHANGELOG.md has the version's entry", () => {
  assert.ok(existsSync(CHANGELOG), "StreamFetch/CHANGELOG.md exists");
  const text = readFileSync(CHANGELOG, "utf8");
  assert.match(text, new RegExp(`^## ${String(manifest["version"]).replace(/\./g, "\\.")} `, "m"));
});

test("every domain the Referer rule names is inside the host permissions", () => {
  for (const [site, domains] of Object.entries(MEDIA_DOMAINS)) {
    for (const domain of domains) {
      assert.ok(hostCovered(`https://${domain}/x`, HOSTS), `${site}: ${domain}`);
      assert.ok(hostCovered(`https://upos-sz-mirror08c.${domain}/x`, HOSTS) || domain.includes("akamaized"), `${site}: *.${domain}`);
    }
  }
  // the sites' pages, APIs, CDNs and covers
  for (const url of [
    "https://www.dailymotion.com/player/metadata/video/xbq9z2k",
    "https://geo.dailymotion.com/player.html?video=xbq9z2k",
    "https://dai.ly/xbq9z2k",
    "https://s1.dmcdn.net/v/abc/x720",
    "https://cdndirector.dailymotion.com/cdn/manifest/video/xbq9z2k.m3u8",
    "https://www.bilibili.com/video/BV1GJ411x7h7",
    "https://b23.tv/abc123",
    "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/x.m4s",
    "https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/upgcxcode/x.m4s",
    "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/x.m4s",
    "https://i0.hdslb.com/bfs/archive/x.jpg",
    "https://www.bilibili.tv/en/video/4801520000000001",
    "https://bilibili.tv/video/4801520000000001",
    "https://api.bilibili.tv/intl/gateway/web/playurl?platform=web&aid=4801520000000001",
    "https://www.biliintl.com/en/video/4801520000000001",
    "https://pic.bstarstatic.com/ogv/x.png",
    "https://upos-bstar1-mirrorakam.akamaized.net/iupxcodeboss/x.mp4",
  ]) {
    assert.ok(hostCovered(url, HOSTS), url);
  }
  for (const url of ["https://evil.example/x.m4s", "http://www.bilibili.com/video/x", "https://akamaized.net/x"]) {
    assert.ok(!hostCovered(url, HOSTS), url);
  }
});
