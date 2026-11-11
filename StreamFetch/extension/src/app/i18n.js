// @ts-check
/**
 * Every UI string comes from `_locales` (`en` the default, `es` complete): elements carry
 * `data-i18n` (text), `data-i18n-title`, `data-i18n-placeholder` or `data-i18n-aria-label`, and
 * {@link localize} fills them. The engine writes statuses and `{ code, params }` failures, never
 * sentences; the page shows them in the display language — English through `lib/messages.js`
 * (`render`, `statusLabel`: the same texts the report stores), Spanish through the `_locales`
 * texts `failure_<code>` / `status_<status>` with the same `$1…$n` parameters.
 *
 * Chrome's own `chrome.i18n.getMessage` speaks the browser's language only; the Settings may
 * choose English or Spanish whatever it is, so the page loads both catalogs from the extension's
 * own files ({@link loadCatalogs}) and formats their messages itself, with Chrome's rules
 * (`$NAME$` placeholders whose content is `$1`…, `$$` a dollar sign). Chrome's function is the
 * fallback when a catalog could not be read.
 *
 * Chrome's message names allow `[A-Za-z0-9_@]` only: a status or a refusal reason with a hyphen
 * (`failed-unavailable`, `other-site`) is looked up with underscores ({@link messageKey}).
 */

import { failureSubstitutions, render, statusLabel as statusLabelEn } from "../lib/messages.js";

/** @typedef {"en" | "es"} Lang */
/**
 * @typedef {object} CatalogEntry One message of a `_locales/<lang>/messages.json`.
 * @property {string} message
 * @property {string} [description]
 * @property {Record<string, { content: string, example?: string }>} [placeholders]
 *
 * @typedef {Record<string, CatalogEntry>} Catalog
 */

/** The catalogs loaded so far, by language. */
const catalogs = /** @type {Partial<Record<Lang, Catalog>>} */ ({});
/** The language the page shows its texts in. */
let current = /** @type {Lang} */ ("en");

/** A Spanish language tag: `es`, `es-419`, `es_PA`, … */
const SPANISH_RE = /^es(?:[-_]|$)/i;

/**
 * The message name Chrome accepts for `<prefix>_<name>`: hyphens and spaces become underscores.
 * @param {string} prefix `failure`, `status`, `refused`, `stop_reason`, `hint`, `request_kind`, …
 * @param {string} name
 * @returns {string}
 */
export function messageKey(prefix, name) {
  return `${prefix}_${String(name).replace(/[^A-Za-z0-9_@]/g, "_")}`;
}

/**
 * Chrome's formatting of one message: each `$NAME$` replaced by its placeholder's content, in
 * which `$1`…`$9` are the substitutions; `$$` is a dollar sign.
 * @param {CatalogEntry} entry
 * @param {readonly string[]} substitutions
 * @returns {string}
 */
export function formatMessage(entry, substitutions) {
  /** @type {Map<string, string>} */
  const placeholders = new Map();
  for (const [name, value] of Object.entries(entry.placeholders ?? {})) {
    placeholders.set(name.toLowerCase(), value.content);
  }
  /** @param {string} text */
  const expand = (text) =>
    text.replace(/\$(\d)/g, (_match, digit) => substitutions[Number(digit) - 1] ?? "");
  return entry.message.replace(/\$\$|\$([A-Za-z0-9_@]+)\$/g, (match, name) => {
    if (match === "$$") return "$";
    const content = placeholders.get(String(name).toLowerCase());
    return content === undefined ? "" : expand(content);
  });
}

/**
 * Use these catalogs (the page loads them with {@link loadCatalogs}; tests hand them in).
 * @param {Partial<Record<Lang, Catalog>>} loaded
 */
export function setCatalogs(loaded) {
  for (const lang of /** @type {const} */ (["en", "es"])) {
    const catalog = loaded[lang];
    if (catalog !== undefined) catalogs[lang] = catalog;
  }
}

/**
 * Read both catalogs from the extension's own `_locales` files. A catalog that cannot be read is
 * left out: `chrome.i18n.getMessage` then speaks for it.
 * @param {(url: string) => Promise<Response>} [fetcher]
 * @returns {Promise<void>}
 */
export async function loadCatalogs(fetcher = (url) => fetch(url)) {
  for (const lang of /** @type {const} */ (["en", "es"])) {
    try {
      const response = await fetcher(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
      if (!response.ok) continue;
      const parsed = /** @type {unknown} */ (await response.json());
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        catalogs[lang] = /** @type {Catalog} */ (parsed);
      }
    } catch {
      // chrome.i18n.getMessage stays the fallback
    }
  }
}

/**
 * The language the page shows its texts in: the Settings' choice, or with `auto` Chrome's —
 * Spanish when Chrome's UI language is Spanish, or when Chrome serves this page the Spanish
 * messages (the `uiLanguage` message: Chrome's `--lang=es` switches the messages while
 * `getUILanguage()` may still say `en-US`), else English.
 * @param {{ language?: string } | null | undefined} settings
 * @returns {Lang}
 */
export function displayLanguage(settings) {
  const chosen = settings?.language;
  if (chosen === "en" || chosen === "es") return chosen;
  if (SPANISH_RE.test(chrome.i18n.getUILanguage())) return "es";
  return SPANISH_RE.test(chrome.i18n.getMessage("uiLanguage")) ? "es" : "en";
}

/**
 * Show the page's texts in `lang` from now on.
 * @param {Lang} lang
 */
export function setLanguage(lang) {
  current = lang;
}

/** @returns {Lang} the language the page shows its texts in */
export function currentLanguage() {
  return current;
}

/**
 * Whether the catalog of `lang` (or Chrome's) has the message `key`.
 * @param {string} key
 * @param {Lang} [lang]
 * @returns {boolean}
 */
export function hasMessage(key, lang = current) {
  const catalog = catalogs[lang];
  if (catalog !== undefined) return Object.hasOwn(catalog, key);
  return chrome.i18n.getMessage(key) !== "";
}

/**
 * The message `key` in `lang` (the page's language by default), with `$1…$n` substitutions; the
 * key itself when the message is missing (a bug the locales test catches).
 * @param {string} key
 * @param {string | number | readonly (string | number)[]} [substitutions]
 * @param {Lang} [lang]
 * @returns {string}
 */
export function t(key, substitutions, lang = current) {
  const list =
    substitutions === undefined
      ? []
      : (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String);
  const catalog = catalogs[lang];
  const entry = catalog === undefined ? undefined : catalog[key];
  if (entry !== undefined) return formatMessage(entry, list);
  return chrome.i18n.getMessage(key, list) || key;
}

/** The request kinds a detail text names in parentheses (`HTTP 429 (manifest)`). */
const KIND_IN_DETAIL_RE =
  /\((page|short link|metadata|manifest|playlist|segment|media|cover|api)\)/g;
/** The resolver's `<Site> says: ` before a site's own words (Dailymotion's error title). */
const SITE_SAYS_RE = /^(Dailymotion|Bilibili\.tv|Bilibili) says: /;

/**
 * A detail text the engine wrote in English (`HTTP 429 (manifest)`), its request kind translated,
 * and a leading `Dailymotion says: ` as `site_says` (the site's own words stay as it wrote them).
 * @param {string} text
 * @param {Lang} lang
 * @returns {string}
 */
export function localizeDetail(text, lang) {
  if (lang === "en") return text;
  return text
    .replace(SITE_SAYS_RE, (match, site) =>
      hasMessage("site_says", lang) ? `${t("site_says", site, lang)} ` : match,
    )
    .replace(KIND_IN_DETAIL_RE, (match, kind) => {
      const key = messageKey("request_kind", kind);
      return hasMessage(key, lang) ? `(${t(key, undefined, lang)})` : match;
    });
}

/**
 * The text of a failure in `lang`: English is `lib/messages.render` (the report's text); Spanish
 * the `failure_<code>` message with the same parameters, the parts that are themselves codes —
 * the `reason` of `stopped`, the `what` of `unsupported_link` and `http_status`, request kinds in
 * a `detail` — translated as well.
 * @param {string} code
 * @param {Record<string, unknown>} [params]
 * @param {Lang} [lang]
 * @returns {string}
 */
export function renderFailure(code, params = {}, lang = current) {
  if (lang === "en") return render(code, params);
  const key = messageKey("failure", code);
  if (!hasMessage(key, lang)) return render(code, params);
  const substitutions = failureSubstitutions(code, params);
  if (code === "stopped") {
    substitutions[0] = stopReasonLabel(String(params["reason"] ?? ""), lang);
  } else if (code === "unsupported_link") {
    const what = String(params["what"] ?? "");
    const refusal = messageKey("refused", what);
    if (hasMessage(refusal, lang)) substitutions[0] = t(refusal, undefined, lang);
  } else if (code === "http_status") {
    const kind = messageKey("request_kind", String(params["what"] ?? ""));
    if (hasMessage(kind, lang)) substitutions[1] = t(kind, undefined, lang);
  } else if (code === "encrypted" && (params["detail"] === undefined || params["detail"] === "")) {
    substitutions[0] = t("encrypted_default_detail", undefined, lang);
  }
  return t(
    key,
    substitutions.map((text) => localizeDetail(text, lang)),
    lang,
  );
}

/**
 * A stop reason in `lang` (`stop_reason_<reason>`; `cooldown until HH:MM` through
 * `stop_reason_cooldown_until`); an unknown one as it is.
 * @param {string} reason
 * @param {Lang} [lang]
 * @returns {string}
 */
export function stopReasonLabel(reason, lang = current) {
  const until = /^cooldown until (\d{1,2}:\d{2})$/.exec(reason);
  if (until !== null) return t("stop_reason_cooldown_until", until[1] ?? "", lang);
  const key = messageKey("stop_reason", reason);
  return hasMessage(key, lang) ? t(key, undefined, lang) : reason;
}

/**
 * A status label in `lang`: English from `lib/messages.js`, Spanish `status_<status>`.
 * @param {string} status
 * @param {Lang} [lang]
 * @returns {string}
 */
export function statusLabel(status, lang = current) {
  if (lang === "en") return statusLabelEn(status);
  const key = messageKey("status", status);
  return hasMessage(key, lang) ? t(key, undefined, lang) : statusLabelEn(status);
}

/**
 * Why a pasted line was refused, in `lang` (`refused_<reason>`).
 * @param {string} reason
 * @param {Lang} [lang]
 * @returns {string}
 */
export function refusalLabel(reason, lang = current) {
  const key = messageKey("refused", reason);
  return hasMessage(key, lang) ? t(key, undefined, lang) : reason;
}

/** @type {readonly [string, string][]} */
const ATTRIBUTES = [
  ["data-i18n-placeholder", "placeholder"],
  ["data-i18n-title", "title"],
  ["data-i18n-aria-label", "aria-label"],
];

/**
 * Fill every `data-i18n*` element under `root` and, for the whole document, set its language.
 * @param {ParentNode} [root]
 */
export function localize(root = document) {
  for (const element of root.querySelectorAll("[data-i18n]")) {
    const key = element.getAttribute("data-i18n");
    if (key) element.textContent = t(key);
  }
  for (const [data, attribute] of ATTRIBUTES) {
    for (const element of root.querySelectorAll(`[${data}]`)) {
      const key = element.getAttribute(data);
      if (key) element.setAttribute(attribute, t(key));
    }
  }
  if (root === document) document.documentElement.lang = current;
}
