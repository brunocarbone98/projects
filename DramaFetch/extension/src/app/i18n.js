// @ts-check
/**
 * Every UI string goes through `chrome.i18n.getMessage` (`_locales/en` is the default, `_locales/es`
 * complete). Elements carry `data-i18n` (text), `data-i18n-placeholder`, `data-i18n-title` or
 * `data-i18n-aria-label`; {@link localize} fills them. The engine's statuses, messages and report
 * lines are data, stored in English like the Python tool's manifest; the page SHOWS them through
 * `lib/display.displayText` in {@link displayLanguage}, with {@link displayLabels} (the UI's own
 * names of the checkboxes and settings a text points to).
 */

/**
 * A Spanish UI language (`es`, `es-419`, `es_PA`, …): `lib/display.displayLanguageOf`'s rule, kept
 * here so that the popup, which shows no engine text, loads none of the engine's modules.
 */
const SPANISH_RE = /^es(?:[-_]|$)/i;

/**
 * @param {string} language
 * @returns {"en" | "es"}
 */
function languageOf(language) {
  return SPANISH_RE.test(language) ? "es" : "en";
}

/**
 * The message `key` in the browser's language, with `$1`… substitutions; the key itself when the
 * message is missing (a bug the locales test catches).
 * @param {string} key
 * @param {string | number | (string | number)[]} [substitutions]
 * @returns {string}
 */
export function t(key, substitutions) {
  const list = substitutions === undefined ? undefined : (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String);
  return chrome.i18n.getMessage(key, list) || key;
}

/**
 * The language the engine's texts are shown in: Spanish when Chrome's UI language is Spanish
 * (`chrome.i18n.getUILanguage()`: `es`, `es-419`, …), else — the page's own messages decide —
 * Spanish when `chrome.i18n` serves this page the Spanish messages (the `uiLanguage` message: on
 * Linux, Chrome's `--lang=es` switches the messages while `getUILanguage()` still says `en-US`),
 * else English. So the engine's texts are always in the language of the page around them.
 * @returns {"en" | "es"}
 */
export function displayLanguage() {
  if (languageOf(chrome.i18n.getUILanguage()) === "es") return "es";
  return languageOf(chrome.i18n.getMessage("uiLanguage"));
}

/**
 * What the UI calls the controls an engine text points to: the per-run checkboxes (a complete
 * series' “look again” advice, a remembered DRM verdict's “try again”) and the settings a pacing
 * refusal names (`delay_min_s` → the form's own label).
 * @returns {import("../lib/display.js").DisplayLabels}
 */
export function displayLabels() {
  return {
    recheck: t("recheckLabel"),
    includeLocked: t("includeLockedLabel"),
    fields: {
      delay_min_s: t("settingDelayMin"),
      delay_max_s: t("settingDelayMax"),
      rest_every: t("settingRestEvery"),
      rest_min_s: t("settingRestMin"),
      rest_max_s: t("settingRestMax"),
    },
  };
}

/** @type {readonly [string, string][]} */
const ATTRIBUTES = [
  ["data-i18n-placeholder", "placeholder"],
  ["data-i18n-title", "title"],
  ["data-i18n-aria-label", "aria-label"],
];

/**
 * Fill every `data-i18n*` element under `root` and set the document language (the language the
 * page's texts are shown in, {@link displayLanguage}).
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
  if (root === document) document.documentElement.lang = displayLanguage();
}
