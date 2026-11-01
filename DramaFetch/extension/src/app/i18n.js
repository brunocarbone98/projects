// @ts-check
/**
 * Every UI string goes through `chrome.i18n.getMessage` (`_locales/en` is the default, `_locales/es`
 * complete). Elements carry `data-i18n` (text), `data-i18n-placeholder`, `data-i18n-title` or
 * `data-i18n-aria-label`; {@link localize} fills them. The engine's statuses, messages and report
 * lines are data (English, like the Python tool's manifest) and are shown as they are.
 */

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

/** @type {readonly [string, string][]} */
const ATTRIBUTES = [
  ["data-i18n-placeholder", "placeholder"],
  ["data-i18n-title", "title"],
  ["data-i18n-aria-label", "aria-label"],
];

/**
 * Fill every `data-i18n*` element under `root` and set the document language.
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
  if (root === document) document.documentElement.lang = chrome.i18n.getUILanguage().split("-")[0] || "en";
}
