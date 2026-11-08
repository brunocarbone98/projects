// @ts-check
/**
 * JSON and URL helpers shared by the lib and the app: a parse that never throws, the query strip
 * the privacy rules need (both sites sign their media URLs in the query string — Bilibili's
 * `deadline`, Dailymotion's `sec` —, so nothing stored or exported keeps one), the host of a URL
 * and a deep copy that strips the query of every URL inside a JSON value. Pure: no `chrome.*`,
 * no DOM — this module runs in Node and in the extension alike.
 */

/**
 * `JSON.parse(text)`, or undefined when `text` is not a string or not JSON — never throws. JSON
 * has no `undefined`, so undefined always means "not JSON".
 * @param {unknown} text
 * @returns {unknown}
 */
export function safeParse(text) {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Whether `value` is a plain object (not null, not an array): what a parsed JSON object is.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * `url` without its query string and fragment (`scheme://host/path`). Works on any string — the
 * cut is at the first `?` or `#` — and leaves a string without either as it is.
 * @param {string} url
 * @returns {string}
 */
export function stripQuery(url) {
  const cut = url.search(/[?#]/);
  return cut >= 0 ? url.slice(0, cut) : url;
}

/**
 * The lowercase host name of an absolute `http(s)` URL, without the port (`127.0.0.1` for the
 * test sites), or null for anything else (a relative path, another scheme, junk).
 * @param {string} url
 * @returns {string | null}
 */
export function hostOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Every URL inside a text (absolute `http(s)://…` or protocol-relative `//…`) followed by a
 * query string or a fragment: group 1 is the URL up to and excluding the `?` / `#`.
 */
const URL_WITH_QUERY_RE = /((?:https?:)?\/\/[^\s/?#"'<>]+[^\s?#"'<>]*)[?#][^\s"'<>]*/g;

/**
 * `text` with the query string and fragment of every URL in it removed — a whole URL, or URLs
 * quoted inside a sentence (`HTTP 403 on https://host/path?deadline=…` becomes
 * `HTTP 403 on https://host/path`). Text without a URL comes back unchanged.
 * @param {string} text
 * @returns {string}
 */
export function stripUrlQueriesInText(text) {
  return text.replace(URL_WITH_QUERY_RE, "$1");
}

/**
 * A deep copy of a JSON value with the query string and fragment of every URL in every string
 * removed ({@link stripUrlQueriesInText}): what the report does to the sites' metadata before
 * storing it (Bilibili's `__playinfo__` holds dozens of signed `baseUrl` / `backupUrl` strings,
 * Dailymotion's metadata a signed HLS master URL). Only own enumerable properties are copied;
 * other values (numbers, booleans, null) come back as they are.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function stripUrlQueries(value) {
  if (typeof value === "string") return /** @type {T} */ (stripUrlQueriesInText(value));
  if (Array.isArray(value)) return /** @type {T} */ (value.map((item) => stripUrlQueries(item)));
  if (isRecord(value)) {
    /** @type {Record<string, unknown>} */
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = stripUrlQueries(item);
    return /** @type {T} */ (copy);
  }
  return value;
}
