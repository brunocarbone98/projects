// @ts-check
// The two catalogs (_locales/en, _locales/es): the same keys, the same placeholders, Chrome's rules
// for message names, every status / failure code / refusal / stop reason / request kind present,
// the English failure texts exactly lib/messages.js's (what the report says), Spanish really
// translated, the legal notice verbatim, and every key the pages and scripts use defined.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { formatMessage, messageKey } from "../src/app/i18n.js";
import {
  FAILURE_CODES,
  FAILURE_PARAMS,
  LINK_REFUSALS,
  REQUEST_KINDS,
  STATUSES,
  STATUS_LABELS_EN,
  STOP_REASONS,
  render,
} from "../src/lib/messages.js";

/** @typedef {import("../src/app/i18n.js").Catalog} Catalog */
/** @typedef {import("../src/app/i18n.js").CatalogEntry} CatalogEntry */

/**
 * @param {string} lang
 * @returns {Catalog}
 */
const catalog = (lang) =>
  JSON.parse(readFileSync(new URL(`../_locales/${lang}/messages.json`, import.meta.url), "utf8"));
const en = catalog("en");
const es = catalog("es");
const README = new URL("../../README.md", import.meta.url);

/** The legal notice of the spec (section 12), verbatim. */
const LEGAL_NOTICE =
  "StreamFetch is a personal tool for saving, for your own offline viewing, videos that " +
  "Dailymotion and Bilibili already play in your own browser session. It never bypasses DRM, " +
  "paywalls, geo-restrictions, logins or any other access control, and it does not hide that it " +
  "is a download tool. Downloading may be restricted by the sites' terms of service and by " +
  "copyright law in your country; you are responsible for how you use it. Not affiliated with " +
  "Dailymotion or Bilibili.";

/**
 * @param {Catalog} messages
 * @param {string} key
 * @returns {CatalogEntry}
 */
function entryOf(messages, key) {
  const entry = messages[key];
  assert.ok(entry !== undefined, `missing ${key}`);
  return entry;
}

/**
 * The substitution numbers a message uses (`$1`…), through its named placeholders.
 * @param {CatalogEntry} entry
 * @returns {number[]}
 */
function placeholderNumbers(entry) {
  /** @type {number[]} */
  const numbers = [];
  for (const match of entry.message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)) {
    const name = String(match[1]).toLowerCase();
    const declared = Object.entries(entry.placeholders ?? {}).find(
      ([key]) => key.toLowerCase() === name,
    );
    assert.ok(declared !== undefined, `placeholder ${name} is not declared in "${entry.message}"`);
    for (const digit of declared[1].content.matchAll(/\$(\d)/g)) numbers.push(Number(digit[1]));
  }
  return [...new Set(numbers)].sort();
}

test("both catalogs have the same keys, Chrome-valid names and the same placeholders", () => {
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
  for (const [key, entry] of Object.entries(en)) {
    assert.match(key, /^[A-Za-z0-9_@]+$/, `${key}: Chrome allows [A-Za-z0-9_@] in message names`);
    assert.equal(typeof entry.message, "string", key);
    assert.deepEqual(placeholderNumbers(entryOf(es, key)), placeholderNumbers(entry), key);
  }
});

test("Spanish is a translation: every text of more than three words differs from the English", () => {
  for (const [key, entry] of Object.entries(en)) {
    if (entry.message.trim().split(/\s+/).length <= 3) continue;
    assert.notEqual(entryOf(es, key).message, entry.message, `${key} is not translated`);
  }
});

test("every status, failure code, link refusal, stop reason and request kind has its text", () => {
  const keys = [
    ...STATUSES.map((status) => messageKey("status", status)),
    ...FAILURE_CODES.map((code) => messageKey("failure", code)),
    ...LINK_REFUSALS.map((reason) => messageKey("refused", reason)),
    ...STOP_REASONS.map((reason) => messageKey("stop_reason", reason)),
    ...REQUEST_KINDS.map((kind) => messageKey("request_kind", kind)),
  ];
  for (const key of keys) {
    assert.ok(Object.hasOwn(en, key), `en: ${key}`);
    assert.ok(Object.hasOwn(es, key), `es: ${key}`);
  }
  for (const status of STATUSES) {
    assert.equal(entryOf(en, messageKey("status", status)).message, STATUS_LABELS_EN[status]);
  }
  assert.equal(messageKey("status", "failed-rate-limited"), "status_failed_rate_limited");
});

test("the English failure texts are lib/messages.js's, parameter for parameter", () => {
  for (const code of FAILURE_CODES) {
    const names = FAILURE_PARAMS[code];
    const values = names.map((name, index) => `<${name}:${index + 1}>`);
    const params = Object.fromEntries(names.map((name, index) => [name, values[index]]));
    const english = entryOf(en, messageKey("failure", code));
    assert.equal(formatMessage(english, values), render(code, params), code);
    const shown = formatMessage(entryOf(es, messageKey("failure", code)), values);
    for (const value of values) assert.ok(shown.includes(value), `es ${code}: ${value} is shown`);
  }
});

test("the legal notice is verbatim in English, in the page's footer, and translated", () => {
  assert.equal(entryOf(en, "legalNotice").message, LEGAL_NOTICE);
  const spanish = entryOf(es, "legalNotice").message;
  assert.notEqual(spanish, LEGAL_NOTICE);
  for (const name of ["StreamFetch", "Dailymotion", "Bilibili", "DRM"]) {
    assert.ok(spanish.includes(name), name);
  }
  const html = readFileSync(new URL("../src/app/app.html", import.meta.url), "utf8");
  assert.ok(html.replace(/\s+/g, " ").includes(LEGAL_NOTICE), "app.html's footer");
});

test("the legal notice is the README's", () => {
  assert.ok(existsSync(README), "StreamFetch/README.md exists");
  const readme = readFileSync(README, "utf8").replace(/\s+/g, " ");
  assert.ok(readme.includes(LEGAL_NOTICE), "the README carries the notice verbatim");
});

test("every key the pages and the scripts use exists in both catalogs", () => {
  /** @type {Set<string>} */
  const used = new Set(["extName", "extDescription", "actionTitle", "uiLanguage"]);
  for (const page of ["app.html", "popup.html"]) {
    const html = readFileSync(new URL(`../src/app/${page}`, import.meta.url), "utf8");
    for (const match of html.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) used.add(String(match[1]));
  }
  for (const file of readdirSync(new URL("../src/app/", import.meta.url))) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(new URL(`../src/app/${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/\bt\(\s*"([A-Za-z0-9_@]+)"/g)) used.add(String(match[1]));
  }
  assert.ok(used.size > 60, "the scan found the keys");
  for (const key of used) {
    assert.ok(Object.hasOwn(en, key), `en: ${key}`);
    assert.ok(Object.hasOwn(es, key), `es: ${key}`);
  }
});
