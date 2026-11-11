// @ts-check
/**
 * File and folder names under Chrome's Downloads folder, safe on Windows (the first platform),
 * macOS and Linux, and exactly the names Chrome's `downloads.download` saves at. Pure: no
 * `chrome.*`, no DOM.
 *
 * The layout (section 6 of the spec), every path relative to Downloads with forward slashes:
 *
 *     StreamFetch/Dailymotion/<title> [<id>].mp4
 *     StreamFetch/Bilibili/<title> [<bvid>].mp4                         one part
 *     StreamFetch/Bilibili/<title> [<bvid>]/P<nn> - <part title>.mp4   several parts
 *     StreamFetch/Bilibili.tv/<title> [<aid>].mp4                      a user video
 *     StreamFetch/Bilibili.tv/<series title>/<title> [<ep_id>].mp4      an episode (Addendum A.3;
 *                                         the folder is `season <season_id>` when the series'
 *                                         title is unknown)
 *     StreamFetch/reports/<YYYY-MM-DD HHMM> - did not download.json
 *
 * A name component is at most {@link MAX_NAME_LEN} UTF-16 units (what Windows counts), the
 * multi-part folder {@link MAX_FOLDER_LEN}, so that
 * `Downloads\StreamFetch\Bilibili\<folder>\<file>` stays well inside Windows' 260-character
 * path limit.
 */

/** The folder inside Chrome's Downloads folder that holds everything StreamFetch saves. */
export const ROOT_FOLDER = "StreamFetch";
/** One folder per site under the root. */
export const SITE_FOLDERS = Object.freeze(
  /** @type {Readonly<Record<"dailymotion" | "bilibili" | "bilibilitv", string>>} */ ({
    dailymotion: "Dailymotion",
    bilibili: "Bilibili",
    bilibilitv: "Bilibili.tv",
  }),
);
/** The folder of a Bilibili.tv episode whose series title is unknown: `season <season_id>`. */
export const SEASON_FOLDER_PREFIX = "season";
/** The folder under the root the reports go to. */
export const REPORTS_FOLDER = "reports";
/** How a report's file name ends. */
export const REPORT_NAME_SUFFIX = "did not download";
/** The longest file or folder name component produced (UTF-16 units). */
export const MAX_NAME_LEN = 120;
/** The longest multi-part folder name `<title> [<bvid>]` produced (UTF-16 units). */
export const MAX_FOLDER_LEN = 80;
/** The name of a video whose title cleans to nothing. */
export const UNTITLED = "untitled";

/**
 * A UTF-16 surrogate without its other half (a title cut in the middle of an emoji): Chrome takes
 * the name as UTF-8, where it turns into U+FFFD, so it is dropped. ES2022 has no `toWellFormed`.
 */
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/**
 * Windows' nine forbidden characters, plus `~` (Chrome's downloads API refuses it) and `%` (Chrome
 * rewrites it to `_` in every file name an extension passes, so a name with one would never be the
 * path saved): all become `_`.
 */
const FORBIDDEN_RE = /[<>:"/\\|?*~%]/g;
/**
 * Dropped outright: C0 controls other than the whitespace ones, DEL, C1 controls, format
 * characters (zero-width joiners, bidi marks, the BOM) and noncharacters — Chrome refuses them
 * all.
 */
const DROPPED_RE = /[\x00-\x08\x0e-\x1f\x7f-\x9f\p{Cf}\p{Noncharacter_Code_Point}]/gu;
/** Whitespace of every kind (the whitespace controls included) collapses to one space. */
const WHITESPACE_RE = /[\t\n\v\f\r\p{Zs}\u2028\u2029]+/gu;
/** Windows device names, refused as the head of a name (before the first dot), in any case. */
const RESERVED_HEADS = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  "CLOCK$",
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, "¹", "²", "³"].flatMap((i) => [`COM${i}`, `LPT${i}`]),
]);
/** Whole names Windows and Chrome refuse. */
const RESERVED_NAMES = new Set(["desktop.ini", "thumbs.db"]);

/**
 * At most `max` UTF-16 units of `text`, never splitting a surrogate pair (an emoji stays whole or
 * goes).
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function cutUtf16(text, max) {
  if (text.length <= max) return text;
  let end = max;
  const unit = text.charCodeAt(end - 1);
  // a high surrogate right at the cut: drop it too, so the pair stays whole
  if (unit >= 0xd800 && unit <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * The cleaning without the fallbacks: NFC, lone surrogates and refused characters dropped, the
 * forbidden ones `_`, whitespace collapsed, leading and trailing dots and spaces removed, the cut
 * at `max` (then the trailing dots and spaces again). May come back empty.
 * @param {string} text
 * @param {number} max 0 cuts nothing
 * @returns {string}
 */
function cleanName(text, max) {
  let name = String(text).replace(LONE_SURROGATE_RE, "").normalize("NFC");
  name = name.replace(DROPPED_RE, "").replace(FORBIDDEN_RE, "_");
  name = name.replace(WHITESPACE_RE, " ").trim();
  name = name.replace(/^[. ]+/, "").replace(/[. ]+$/, "");
  if (max > 0 && name.length > max) name = cutUtf16(name, max).replace(/[. ]+$/, "");
  return name;
}

/**
 * The last step: a Windows device name before the first dot (`CON`, `COM1`, `clock$`, …) and the
 * whole names `desktop.ini` / `thumbs.db` get a `_` appended to that head (`CON_`, `com1_.txt`,
 * `desktop_.ini`), so the name is one more character long but saves.
 * @param {string} name
 * @returns {string}
 */
function withReservedNamesFixed(name) {
  const dot = name.indexOf(".");
  const head = (dot >= 0 ? name.slice(0, dot) : name).replace(/ +$/, "");
  const rest = dot >= 0 ? name.slice(dot) : "";
  if (RESERVED_HEADS.has(head.toUpperCase()) || RESERVED_NAMES.has(name.toLowerCase())) {
    return `${head}_${rest}`;
  }
  return name;
}

/**
 * A name Chrome's `downloads.download` saves at exactly, on Windows too: NFC; Windows' forbidden
 * characters `<>:"/\|?*` (and `~`, `%`) → `_`; controls, format characters, noncharacters and
 * lone surrogates dropped; whitespace collapsed; leading and trailing dots and spaces trimmed;
 * at most `max` UTF-16 units, never splitting an emoji; `untitled` when nothing is left; a
 * Windows device name (`CON`, `COM1`, `clock$`, `desktop.ini`, …) suffixed with `_`.
 * @param {string} name
 * @param {number} [max] default {@link MAX_NAME_LEN}; 0 cuts nothing
 * @returns {string}
 */
export function chromeSafeFilename(name, max = MAX_NAME_LEN) {
  return withReservedNamesFixed(cleanName(name, max) || UNTITLED);
}

/**
 * `<title> [<id>]`: the file stem of a video, or the folder of a multi-part one — the id keeps
 * same-named videos apart and is never cut; the title gives way (the whole stays within `max`).
 * @param {string} title
 * @param {string} id the Dailymotion xid or the Bilibili bvid / `av…`
 * @param {number} [max]
 * @returns {string}
 */
export function videoStem(title, id, max = MAX_NAME_LEN) {
  const suffix = ` [${String(id).replace(FORBIDDEN_RE, "_")}]`;
  return `${chromeSafeFilename(title, Math.max(1, max - suffix.length))}${suffix}`;
}

/**
 * `P<nn>`: the part number, two digits, three from 100 on (`P01`, `P12`, `P100`).
 * @param {number} part 1-based
 * @returns {string}
 */
export function partLabel(part) {
  return `P${String(Math.max(1, Math.floor(part))).padStart(2, "0")}`;
}

/**
 * The file stem of one part of a multi-part video: `P<nn> - <part title>`, or `P<nn>` alone when
 * the part has no title of its own (empty, equal to the video's title, or nothing left once
 * cleaned).
 * @param {number} part 1-based
 * @param {string | null | undefined} partTitle the part's own title (Bilibili `pages[].part`)
 * @param {string | null | undefined} title the video's title
 * @param {number} [max]
 * @returns {string}
 */
export function partStem(part, partTitle, title, max = MAX_NAME_LEN) {
  const label = partLabel(part);
  const own = (partTitle ?? "").trim();
  if (!own || own === (title ?? "").trim()) return label;
  const prefix = `${label} - `;
  const cleaned = cleanName(own, Math.max(1, max - prefix.length));
  return cleaned ? withReservedNamesFixed(`${prefix}${cleaned}`) : label;
}

/**
 * @typedef {object} NamingTarget What {@link targetPath} reads of a target.
 * @property {"dailymotion" | "bilibili" | "bilibilitv"} site
 * @property {string} id the Dailymotion xid, the Bilibili bvid (`av…` when the page gave none),
 *   the Bilibili.tv aid or ep_id
 * @property {string} title the video's title (a Bilibili.tv episode's `title_display`)
 * @property {number | null} part the Bilibili part (1-based), a Bilibili.tv episode's position;
 *   null for Dailymotion
 * @property {string | null} partTitle the part's own title (`pages[].part`), a Bilibili.tv
 *   episode's own title when the resolver keeps it apart from `title`; null when there is none
 * @property {number | null} [partCount] how many parts the video has (`pages.length`); absent or
 *   null when unknown — then a `part` above 1 still means a multi-part video
 * @property {string | null} [seasonId] Bilibili.tv: the episode's season
 * @property {string | null} [episodeId] Bilibili.tv: set for an episode, null for a user video
 * @property {string | null} [seriesTitle] Bilibili.tv: the series' title when known
 */

/**
 * Whether a target is one part of a multi-part Bilibili video: `partCount` above 1, or — when the
 * count is unknown — a `part` above 1.
 * @param {NamingTarget} target
 * @returns {boolean}
 */
export function isMultiPart(target) {
  if (target.site !== "bilibili") return false;
  if (typeof target.partCount === "number") return target.partCount > 1;
  return (target.part ?? 1) > 1;
}

/**
 * Whether a Bilibili.tv target is an episode of a series (it has an episode id or a season), not
 * a user video.
 * @param {NamingTarget} target
 * @returns {boolean}
 */
export function isEpisode(target) {
  return target.site === "bilibilitv" && Boolean(target.episodeId || target.seasonId);
}

/**
 * The folder of a Bilibili.tv episode: the series' title, else `season <season_id>`, at most
 * {@link MAX_FOLDER_LEN}.
 * @param {NamingTarget} target
 * @returns {string}
 */
export function seriesFolder(target) {
  const title = (target.seriesTitle ?? "").trim();
  const name = title || `${SEASON_FOLDER_PREFIX} ${target.seasonId || UNTITLED}`;
  return chromeSafeFilename(name, MAX_FOLDER_LEN);
}

/**
 * The path Chrome saves a target at, relative to its Downloads folder (forward slashes, as
 * `downloads.download` takes them on every platform): `StreamFetch/Dailymotion/<title> [<id>].mp4`,
 * `StreamFetch/Bilibili/<title> [<bvid>].mp4`, or for a part of a multi-part video
 * `StreamFetch/Bilibili/<title> [<bvid>]/P<nn> - <part title>.mp4` (`P<nn>.mp4` when the part has
 * no title of its own); `StreamFetch/Bilibili.tv/<title> [<aid>].mp4` for a user video and
 * `StreamFetch/Bilibili.tv/<series title or "season <season_id>">/<title> [<ep_id>].mp4` for an
 * episode (its own title: `partTitle` when the resolver keeps one, else `title`). Throws for an
 * unknown site.
 * @param {NamingTarget} target
 * @param {{ rootFolder?: string }} [settings] the user's settings record; the only key read is
 *   an optional `rootFolder` (default {@link ROOT_FOLDER}) — nothing in the 1.0 settings changes
 *   a name
 * @returns {string}
 */
export function targetPath(target, settings = {}) {
  const site = SITE_FOLDERS[target.site];
  if (site === undefined) throw new Error(`unknown site ${JSON.stringify(target.site)}`);
  const root = settings.rootFolder || ROOT_FOLDER;
  if (isEpisode(target)) {
    const title = (target.partTitle ?? "").trim() || target.title;
    const stem = videoStem(title, target.episodeId || target.id);
    return `${root}/${site}/${seriesFolder(target)}/${stem}.mp4`;
  }
  if (!isMultiPart(target)) return `${root}/${site}/${videoStem(target.title, target.id)}.mp4`;
  const folder = videoStem(target.title, target.id, MAX_FOLDER_LEN);
  const stem = partStem(target.part ?? 1, target.partTitle, target.title);
  return `${root}/${site}/${folder}/${stem}.mp4`;
}

/**
 * @param {number} value
 * @returns {string} two digits
 */
function two(value) {
  return String(value).padStart(2, "0");
}

/**
 * `<YYYY-MM-DD HHMM> - did not download`: the report's file name without extension, in LOCAL time
 * — no colon, which Windows refuses in a file name.
 * @param {Date} now
 * @returns {string}
 */
export function reportStem(now) {
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  return `${date} ${two(now.getHours())}${two(now.getMinutes())} - ${REPORT_NAME_SUFFIX}`;
}

/**
 * The path a report is saved at, relative to the Downloads folder:
 * `StreamFetch/reports/<YYYY-MM-DD HHMM> - did not download.json` (local time).
 * @param {Date} [now]
 * @returns {string}
 */
export function reportPath(now = new Date()) {
  return `${ROOT_FOLDER}/${REPORTS_FOLDER}/${reportStem(now)}.json`;
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
