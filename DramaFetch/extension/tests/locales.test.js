// @ts-check
// Every UI string goes through chrome.i18n: _locales/en (default) and _locales/es must be complete
// and consistent — the same keys, the same placeholders, every key the pages, the scripts and the
// manifest use — and the legal notice is the README's, verbatim.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

/** @param {string} relative @returns {URL} */
const file = (relative) => new URL(`../${relative}`, import.meta.url);

/**
 * @typedef {{message: string, description?: string, placeholders?: Record<string, {content: string}>}} Entry
 * @param {string} language
 * @returns {Record<string, Entry>}
 */
function messages(language) {
  return JSON.parse(readFileSync(file(`_locales/${language}/messages.json`), "utf8"));
}

const en = messages("en");
const es = messages("es");
/** Keys whose text is the same in both languages on purpose. */
const SAME_IN_BOTH = new Set([
  "extName",
  "actionTitle",
  "appTitle",
  "colNumber",
  "linksPlaceholder",
  "jobBatch", // "$count$ series" is Spanish too
  "legalNotice",
  "legalNoticeSpanish",
]);

test("English and Spanish exist and nothing else", () => {
  assert.deepEqual(readdirSync(file("_locales")).sort(), ["en", "es"]);
});

test("both locales have exactly the same keys, each with a message", () => {
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
  for (const [language, table] of [["en", en], ["es", es]]) {
    for (const [key, entry] of Object.entries(/** @type {Record<string, Entry>} */ (table))) {
      assert.match(key, /^[A-Za-z0-9_]+$/, `${language}: ${key}`);
      assert.equal(typeof entry.message, "string", `${language}: ${key}`);
      assert.ok(entry.message.trim().length > 0, `${language}: ${key} is empty`);
    }
  }
});

test("the placeholders match: the same names in both, each one defined and used", () => {
  for (const key of Object.keys(en)) {
    const english = /** @type {Entry} */ (en[key]);
    const spanish = /** @type {Entry} */ (es[key]);
    const names = Object.keys(english.placeholders ?? {}).sort();
    assert.deepEqual(Object.keys(spanish.placeholders ?? {}).sort(), names, key);
    for (const entry of [english, spanish]) {
      const used = [...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((match) => String(match[1]).toLowerCase());
      assert.deepEqual([...new Set(used)].sort(), names.map((name) => name.toLowerCase()), key);
      for (const name of names) assert.match(String(entry.placeholders?.[name]?.content), /^\$[1-9]$/, `${key}: ${name}`);
    }
  }
});

test("the Spanish is a translation, not a copy", () => {
  for (const key of Object.keys(en)) {
    if (SAME_IN_BOTH.has(key)) continue;
    assert.notEqual(es[key]?.message, en[key]?.message, `${key} is not translated`);
  }
});

test("every key the manifest, the pages and the scripts use exists", () => {
  /** @type {Set<string>} */
  const used = new Set();
  for (const match of readFileSync(file("manifest.json"), "utf8").matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(String(match[1]));
  const app = readdirSync(file("src/app"));
  for (const name of app.filter((entry) => entry.endsWith(".html"))) {
    const html = readFileSync(file(`src/app/${name}`), "utf8");
    for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)) used.add(String(match[1]));
  }
  for (const name of app.filter((entry) => entry.endsWith(".js"))) {
    const script = readFileSync(file(`src/app/${name}`), "utf8");
    for (const match of script.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) used.add(String(match[1]));
  }
  assert.ok(used.size > 50);
  for (const key of used) assert.ok(Object.hasOwn(en, key), `missing message ${key}`);
});

test("Chrome's limits: a short name and a description of at most 132 characters", () => {
  for (const table of [en, es]) {
    assert.ok(String(table["extName"]?.message).length <= 45);
    assert.ok(String(table["extDescription"]?.message).length <= 132);
  }
});

test("the legal notice is the README's, verbatim, in both locales and in the page footer", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const match = /^> \*\*Legal notice\.\*\* (.+)$/m.exec(readme);
  assert.ok(match, "the README's legal notice");
  const notice = String(match[1]);
  assert.equal(en["legalNotice"]?.message, notice);
  assert.equal(es["legalNotice"]?.message, notice);
  const html = readFileSync(file("src/app/app.html"), "utf8");
  assert.ok(html.includes(`>${notice}</p>`), "app.html footer");
  assert.ok(html.includes(`>${es["legalNoticeSpanish"]?.message}</p>`), "app.html Spanish footer");
});
