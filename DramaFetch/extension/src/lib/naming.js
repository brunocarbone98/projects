// @ts-check
/**
 * File and folder names: a port of `manifest.py`'s naming (`safe_filename`,
 * `validate_name_format`, `episode_stem`, the series directory name), byte-identical to the
 * Python functions, plus what the extension adds for Chrome on Windows. Pure: no `chrome.*`.
 *
 * The extension's defaults: the stem is capped at {@link EXTENSION_MAX_STEM_LEN} (110) characters
 * and the series folder name `<name> [<id>]` at {@link MAX_FOLDER_LEN} (60), under the root
 * folder {@link ROOT_FOLDER} inside Chrome's Downloads folder; a stem that would be longer
 * shortens its `{series}` part first, so `Episode NN` is never cut; and names are made acceptable
 * to Chrome's downloads API (`chromeSafe`: no `~`, no control or format character, no
 * noncharacter, no leading dot, none of the extra names Windows reserves) and are the very names
 * it saves (no `%`, which Chrome turns into `_`; no lone UTF-16 surrogate). With
 * `{maxLen: 150, shortenSeries: false, chromeSafe: false}` {@link episodeStem} is
 * `manifest.episode_stem` exactly (`tests/test_extension_parity.py`).
 */

import { DEFAULT_NAME_FORMAT, PY_SPACE, pyHead, pyLen, pyRepr, pyRstrip, pyStrip } from "./messages.js";

/** The placeholders a name format may use (in braces); anything else in braces is refused. */
export const NAME_PLACEHOLDERS = Object.freeze(/** @type {const} */ (["series", "number", "n", "title", "id"]));
/** Placeholders that tell one episode from another; a format needs at least one. */
const EPISODE_PLACEHOLDERS = new Set(["number", "n", "title", "id"]);
const PLACEHOLDER_RE = /\{([^{}]*)\}/g;
/** Longest stem `manifest.episode_stem` produces (the Python tool). */
export const MAX_STEM_LEN = 150;
/** Longest stem the extension produces (Windows paths). */
export const EXTENSION_MAX_STEM_LEN = 110;
/** Longest series folder name `<name> [<id>]` the extension produces (Windows paths). */
export const MAX_FOLDER_LEN = 60;
/** The folder inside Chrome's Downloads folder that holds every series folder. */
export const ROOT_FOLDER = "DramaFetch";

const RESERVED_CHARS_RE = /[<>:"/\\|?*]/g;
// C0 controls except \t \n \v \f \r (those are whitespace and become spaces), plus DEL.
const CONTROL_CHARS_RE = /[\x00-\x08\x0e-\x1f\x7f]/g;
const WHITESPACE_RE = new RegExp(`[${PY_SPACE}]+`, "g");
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `COM${i}`),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `LPT${i}`),
]);

/**
 * A file-system-safe name on Linux, macOS and Windows, never empty (`untitled`) —
 * `manifest.safe_filename`: `<>:"/\|?*` become spaces, control characters are dropped,
 * whitespace is collapsed, trailing dots and spaces removed (also after cutting to `maxLen` code
 * points; `maxLen` <= 0 cuts nothing), and a Windows device name (`CON`, `COM1`, …) gets a `_`
 * appended to the device-name segment itself (`com1_.txt`, `Aux_. Stories`).
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string}
 */
export function safeFilename(text, maxLen = 80) {
  let cleaned = text.replace(CONTROL_CHARS_RE, "");
  cleaned = cleaned.replace(RESERVED_CHARS_RE, " ");
  cleaned = pyStrip(cleaned.replace(WHITESPACE_RE, " "));
  if (maxLen > 0 && pyLen(cleaned) > maxLen) cleaned = pyHead(cleaned, maxLen);
  cleaned = cleaned.replace(/[ .]+$/, "");
  if (!cleaned) return "untitled";
  return withDeviceNameFixed(cleaned);
}

/**
 * The last step of `safe_filename`: a Windows device name before the first dot gets a `_`.
 * @param {string} cleaned
 * @returns {string}
 */
function withDeviceNameFixed(cleaned) {
  const dot = cleaned.indexOf(".");
  const head = dot >= 0 ? cleaned.slice(0, dot) : cleaned;
  if (WINDOWS_RESERVED_NAMES.has(pyRstrip(head).toUpperCase())) {
    return `${pyRstrip(head)}_${dot >= 0 ? cleaned.slice(dot) : ""}`;
  }
  return cleaned;
}

/** What Chrome's downloads API refuses anywhere in a name besides what safeFilename replaces. */
const CHROME_REMOVED_RE = /[\p{Cf}\p{Noncharacter_Code_Point}\x80-\x84\x86-\x9f]/gu;
/**
 * What becomes a space, like `<>:"/\|?*`: `~` (Chrome refuses it) and `%`, which Chrome itself
 * rewrites to `_` in every file name an extension passes (`DownloadsDownloadFunction::Run` in
 * Chromium's `chrome/browser/extensions/api/downloads/downloads_api.cc`: "Strip "%" character
 * as it affects environment variables"), so a name with `%` would never be the path it saves.
 */
const CHROME_SPACED_RE = /[~%]/g;
/**
 * A UTF-16 surrogate without its other half (a title cut in the middle of an emoji): Chrome takes
 * the name as UTF-8, where it turns into U+FFFD, so it is dropped. ES2022 has no `toWellFormed`.
 */
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** Names Windows reserves that the Python rule does not cover (Chrome refuses them too). */
const CHROME_RESERVED_HEADS = new Set(["clock$"]);
const CHROME_RESERVED_NAMES = new Set(["desktop.ini", "thumbs.db"]);

/**
 * {@link safeFilename}, then what Chrome's `downloads.download` also needs of every component of
 * a path (`net::IsSafePortablePathComponent`): no `~` (it becomes a space), no format character
 * (zero-width joiners, bidi marks, the BOM), no C1 control, no noncharacter, no leading dot or
 * space, not `CLOCK$` / `desktop.ini` / `thumbs.db`; and at most `maxLen` UTF-16 units (what
 * Windows counts), never splitting a character. So that the name is exactly the path Chrome saves
 * at, also no `%` (a space too: Chrome would write `_`) and no lone surrogate (dropped).
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string}
 */
export function chromeSafeFilename(text, maxLen = 80) {
  const chromeText = text.replace(LONE_SURROGATE_RE, "").replace(CHROME_SPACED_RE, " ");
  let cleaned = safeFilename(chromeText.replace(CHROME_REMOVED_RE, ""), maxLen);
  cleaned = cleaned.replace(/^[. ]+/, "");
  if (maxLen > 0 && cleaned.length > maxLen) {
    const chars = Array.from(cleaned);
    while (chars.join("").length > maxLen) chars.pop();
    cleaned = chars.join("").replace(/[ .]+$/, "");
  }
  if (!cleaned) return "untitled";
  // the device-name rules last, on the name as it will be saved (".CON" is "CON" by now)
  cleaned = withDeviceNameFixed(cleaned);
  const dot = cleaned.indexOf(".");
  const head = dot >= 0 ? cleaned.slice(0, dot) : cleaned;
  if (CHROME_RESERVED_HEADS.has(head.toLowerCase()) || CHROME_RESERVED_NAMES.has(cleaned.toLowerCase())) {
    cleaned = `${head}_${dot >= 0 ? cleaned.slice(dot) : ""}`;
  }
  return cleaned;
}

/**
 * Why `nameFormat` cannot name episodes — the message `manifest.validate_name_format` raises —
 * or null when it can: a placeholder outside {@link NAME_PLACEHOLDERS} (`{number:02d}` included),
 * a brace that closes no placeholder, a format without `{number}`, `{n}`, `{title}` or `{id}`.
 * @param {string} nameFormat
 * @returns {string | null}
 */
export function nameFormatProblem(nameFormat) {
  const allowed = NAME_PLACEHOLDERS.map((name) => `{${name}}`).join(", ");
  const found = [...nameFormat.matchAll(PLACEHOLDER_RE)].map((match) => /** @type {string} */ (match[1]));
  for (const name of found) {
    if (!(/** @type {readonly string[]} */ (NAME_PLACEHOLDERS).includes(name))) {
      return `unknown placeholder {${name}} in name format ${pyRepr(nameFormat)}: use ${allowed}`;
    }
  }
  const leftover = nameFormat.replace(PLACEHOLDER_RE, "");
  if (leftover.includes("{") || leftover.includes("}")) {
    return `unmatched brace in name format ${pyRepr(nameFormat)}: placeholders are ${allowed}`;
  }
  if (!found.some((name) => EPISODE_PLACEHOLDERS.has(name))) {
    return (
      `name format ${pyRepr(nameFormat)} does not tell episodes apart: use at least one of ` +
      "{number}, {n}, {title} or {id}"
    );
  }
  return null;
}

/**
 * `manifest.validate_name_format`: throws an Error with {@link nameFormatProblem}'s message.
 * @param {string} nameFormat
 */
export function validateNameFormat(nameFormat) {
  const problem = nameFormatProblem(nameFormat);
  if (problem !== null) throw new Error(problem);
}

/**
 * @typedef {object} StemEpisode What {@link episodeStem} reads of an episode.
 * @property {number} number
 * @property {string} itemId
 * @property {string} title
 * @property {string} seriesId
 * @property {string | null} [seriesName]
 *
 * @typedef {object} StemOptions
 * @property {string} [nameFormat] default {@link DEFAULT_NAME_FORMAT}
 * @property {string | null} [seriesName] what `{series}` expands to (the series' display name)
 * @property {number} [maxLen] default {@link EXTENSION_MAX_STEM_LEN}; the Python tool's is 150
 * @property {boolean} [shortenSeries] default true: shorten `{series}` first when too long
 * @property {boolean} [chromeSafe] default true: {@link chromeSafeFilename} instead of safeFilename
 */

/**
 * The file name of an episode without its extension (`manifest.episode_stem`): the placeholders
 * are replaced one by one, never by a template engine — `{series}` is `seriesName`, else the
 * episode's own series name, else `series-<series id>` (`video` without one), cut to 80 safe
 * characters; `{number}` the number zero-padded to two digits and `{n}` the bare number;
 * `{title}` the title cut to 60 safe characters; `{id}` the TikTok item id — and the whole stem
 * goes through the safe-name rule at `maxLen`. Throws for an unusable format.
 * @param {StemEpisode} episode
 * @param {StemOptions} [options]
 * @returns {string}
 */
export function episodeStem(episode, options = {}) {
  const nameFormat = options.nameFormat ?? DEFAULT_NAME_FORMAT;
  const maxLen = options.maxLen ?? EXTENSION_MAX_STEM_LEN;
  const shorten = options.shortenSeries ?? true;
  const safe = (options.chromeSafe ?? true) ? chromeSafeFilename : safeFilename;
  validateNameFormat(nameFormat);
  let series;
  if (options.seriesName) series = options.seriesName;
  else if (episode.seriesName) series = episode.seriesName;
  else if (episode.seriesId) series = `series-${episode.seriesId}`;
  else series = "video";
  /** @type {Map<string, string>} */
  const values = new Map([
    ["series", safe(series, 80)],
    ["number", episode.number < 0 ? String(episode.number) : String(episode.number).padStart(2, "0")],
    ["n", String(episode.number)],
    ["title", safe(episode.title, 60)],
    ["id", episode.itemId],
  ]);
  const expand = () =>
    nameFormat.replace(PLACEHOLDER_RE, (_match, name) => /** @type {string} */ (values.get(name)));
  let stem = expand();
  const seriesCount = [...nameFormat.matchAll(PLACEHOLDER_RE)].filter((match) => match[1] === "series").length;
  // Too long: shorten {series} first (its share of the excess), so "Episode NN" is never cut.
  while (shorten && seriesCount > 0) {
    const length = measure(safe(stem, 0));
    if (length <= maxLen) break;
    const current = /** @type {string} */ (values.get("series"));
    const keep = measure(current) - Math.ceil((length - maxLen) / seriesCount);
    const shorter = cutTo(current, Math.max(1, keep)).replace(/[ .]+$/, "");
    if (!shorter || measure(shorter) >= measure(current)) break;
    values.set("series", shorter);
    stem = expand();
  }
  return safe(stem, maxLen);

  /**
   * The length the safe-name rule in force counts: code points, or UTF-16 units for Chrome.
   * @param {string} text
   * @returns {number}
   */
  function measure(text) {
    return safe === chromeSafeFilename ? text.length : pyLen(text);
  }

  /**
   * @param {string} text
   * @param {number} length
   * @returns {string}
   */
  function cutTo(text, length) {
    if (safe !== chromeSafeFilename) return pyHead(text, length);
    const chars = Array.from(text);
    while (chars.join("").length > length) chars.pop();
    return chars.join("");
  }
}

/**
 * A series' display name (`models.Series.display_name`): its name, else `series-<id>`.
 * @param {string | null | undefined} name
 * @param {string} seriesId
 * @returns {string}
 */
export function displayName(name, seriesId) {
  return name || `series-${seriesId}`;
}

/**
 * The series folder name `<name> [<series id>]` — the id keeps renamed series apart, as in
 * `manifest.series_dir` — capped at `maxLen` characters in all (the name is cut, never the id).
 * @param {string} name the series' display name ({@link displayName})
 * @param {string} seriesId
 * @param {{maxLen?: number, chromeSafe?: boolean}} [options]
 * @returns {string}
 */
export function seriesFolder(name, seriesId, options = {}) {
  const suffix = ` [${seriesId}]`;
  const room = Math.max(1, (options.maxLen ?? MAX_FOLDER_LEN) - suffix.length);
  const safe = (options.chromeSafe ?? true) ? chromeSafeFilename : safeFilename;
  return `${safe(name, room)}${suffix}`;
}

/**
 * The path Chrome saves a file at, relative to its Downloads folder:
 * `DramaFetch/<series folder>/<stem>.<extension>` (forward slashes, as `downloads.download`
 * takes them on every platform).
 * @param {string} folder {@link seriesFolder}
 * @param {string} stem {@link episodeStem}
 * @param {string} extension without the dot: `mp4`, `jpg`, `png`, `webp`
 * @param {string} [root]
 * @returns {string}
 */
export function downloadFilename(folder, stem, extension, root = ROOT_FOLDER) {
  return `${root}/${folder}/${stem}.${extension}`;
}

/**
 * The last component of a path written with `/` or `\` (Chrome reports Windows paths with `\`).
 * @param {string} path
 * @returns {string}
 */
export function fileBaseName(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/**
 * The base name without its last suffix, as `pathlib.PurePath.stem` (`a.b.mp4` → `a.b`; a name
 * that starts with its only dot, or ends with it, keeps it).
 * @param {string} path
 * @returns {string}
 */
export function fileStem(path) {
  const name = fileBaseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name;
}
