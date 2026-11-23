// @ts-check
/**
 * The colour contrast of the DramaFetch tab and its popup (DramaFetch 2.0.0, the owner's request of
 * 2026-11-22: more vivid colours — every text still readable): a dependency-free check of
 * `src/app/app.css`, the one stylesheet of both pages.
 *
 * It reads the colour tokens of `:root` (the light scheme) and of `@media (prefers-color-scheme:
 * dark)`'s `:root` (the dark one, over the light), then every rule that sets a colour:
 * - a rule that sets `color` pairs it with its own background (`background` / `background-color`:
 *   a token, or every token of a gradient), else with the backgrounds its comment names
 *   (`on: --card --bg`); a rule that sets `color` and says nothing of what it sits on is a problem;
 * - a rule whose background holds text and that sets no `color` names those texts (`text: --text`),
 *   or says it holds none (`no text`); one that says nothing is a problem;
 * - `ui: --focus on --card --bg` names an outline that must stand out of what it sits on (a focus
 *   ring, a field's border);
 * - a text colour or a background that holds text must be a token, solid (no alpha): a raw colour
 *   or a translucent one in a rule is a problem, and so is an `opacity` below 1 outside `:disabled`
 *   (it would blend a text into what is behind it).
 * Each pair is measured in both schemes with WCAG 2's contrast ratio — text at least
 * {@link TEXT_MIN}:1, outlines at least {@link UI_MIN}:1 — and printed, one line each.
 *
 * Usage: `node tools/contrast.js [app.css]` (from `DramaFetch/extension`): the table, then a summary;
 * exit 0 when every pair passes and every rule is accounted for, 1 otherwise. `tests/contrast.test.js`
 * runs the same check inside `node --test`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** WCAG 2.x AA: normal text. */
export const TEXT_MIN = 4.5;
/** WCAG 2.x AA: the boundary of a component, a focus indicator (1.4.11). */
export const UI_MIN = 3;
/** The colour schemes the page supports. */
export const SCHEMES = Object.freeze(/** @type {const} */ (["light", "dark"]));

/**
 * @typedef {object} Rule One rule of the stylesheet.
 * @property {string} selector
 * @property {string[]} media the at-rules around it, outermost first
 * @property {Map<string, string>} declarations property → value (comments taken out)
 * @property {string[]} notes the comments inside its block
 *
 * @typedef {{r: number, g: number, b: number, a: number}} Rgba channels 0–255, alpha 0–1
 *
 * @typedef {object} Pair A colour that must stand out of another.
 * @property {"text" | "ui"} kind
 * @property {string} fg its token (`--text`)
 * @property {string} bg the token it sits on
 * @property {string} selector where
 *
 * @typedef {object} Row One pair measured in one scheme.
 * @property {"light" | "dark"} scheme
 * @property {"text" | "ui"} kind
 * @property {string} fg
 * @property {string} fgValue
 * @property {string} bg
 * @property {string} bgValue
 * @property {number} ratio
 * @property {number} min
 * @property {boolean} ok
 * @property {string[]} selectors every rule the pair comes from
 */

/**
 * The rules of `css`, nested at-rules flattened (each rule keeps the at-rules around it).
 * @param {string} css
 * @returns {Rule[]}
 */
export function parseCss(css) {
  /** @type {Rule[]} */
  const rules = [];
  /**
   * @param {string} text
   * @param {string[]} media
   */
  const walk = (text, media) => {
    let index = 0;
    while (index < text.length) {
      const open = nextBrace(text, index);
      if (open === -1) break;
      const prelude = stripComments(text.slice(index, open)).trim();
      const close = matchingBrace(text, open);
      const body = text.slice(open + 1, close);
      if (prelude.startsWith("@")) walk(body, [...media, prelude]);
      else if (prelude !== "") rules.push({ selector: prelude.replace(/\s+/g, " "), media, declarations: declarationsOf(body), notes: commentsOf(body) });
      index = close + 1;
    }
  };
  walk(css, []);
  return rules;
}

/**
 * The index of the next `{` outside a comment, or -1.
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
function nextBrace(text, from) {
  let index = from;
  while (index < text.length) {
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (text[index] === "{") return index;
    index += 1;
  }
  return -1;
}

/**
 * The index of the `}` that closes the `{` at `open` (comments and strings skipped).
 * @param {string} text
 * @param {number} open
 * @returns {number}
 */
function matchingBrace(text, open) {
  let depth = 0;
  let index = open;
  while (index < text.length) {
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    const char = text[index];
    if (char === '"' || char === "'") {
      const end = text.indexOf(char, index + 1);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  throw new Error(`unbalanced braces after offset ${open}`);
}

/** @param {string} text @returns {string} */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** @param {string} body @returns {string[]} */
function commentsOf(body) {
  return [...body.matchAll(/\/\*([\s\S]*?)\*\//g)].map((match) => String(match[1]).trim());
}

/** @param {string} body @returns {Map<string, string>} */
function declarationsOf(body) {
  /** @type {Map<string, string>} */
  const declarations = new Map();
  for (const part of stripComments(body).split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (name !== "" && value !== "") declarations.set(name, value);
  }
  return declarations;
}

/**
 * A colour written as `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` or `rgba(r, g, b, a)`;
 * null for anything else.
 * @param {string} value
 * @returns {Rgba | null}
 */
export function parseColor(value) {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex !== null) {
    let digits = String(hex[1]);
    if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join("");
    const channel = (/** @type {number} */ at) => Number.parseInt(digits.slice(at, at + 2), 16);
    return { r: channel(0), g: channel(2), b: channel(4), a: digits.length === 8 ? channel(6) / 255 : 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text);
  if (rgb !== null) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) };
  return null;
}

/**
 * WCAG 2's relative luminance of an opaque colour.
 * @param {Rgba} color
 * @returns {number}
 */
export function luminance(color) {
  /** @param {number} channel */
  const linear = (channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/**
 * WCAG 2's contrast ratio of two opaque colours, from 1 to 21.
 * @param {Rgba} first
 * @param {Rgba} second
 * @returns {number}
 */
export function contrastRatio(first, second) {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (Number(light) + 0.05) / (Number(dark) + 0.05);
}

/**
 * The colour tokens of a scheme — `:root`'s, and for `dark` the dark media block's over them —,
 * each resolved through the `var()` it names.
 * @param {readonly Rule[]} rules
 * @param {"light" | "dark"} scheme
 * @returns {Map<string, string>}
 */
export function tokensOf(rules, scheme) {
  /** @type {Map<string, string>} */
  const raw = new Map();
  for (const rule of rules) {
    if (rule.selector !== ":root") continue;
    const dark = rule.media.some((media) => /prefers-color-scheme\s*:\s*dark/.test(media));
    if (rule.media.length > 0 && !dark) continue;
    if (dark && scheme !== "dark") continue;
    for (const [name, value] of rule.declarations) if (name.startsWith("--")) raw.set(name, value);
  }
  /** @type {Map<string, string>} */
  const resolved = new Map();
  for (const name of raw.keys()) {
    let value = raw.get(name) ?? "";
    for (let depth = 0; depth < 10; depth += 1) {
      const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
      if (reference === null) break;
      value = raw.get(String(reference[1])) ?? value;
    }
    resolved.set(name, value);
  }
  return resolved;
}

/**
 * The tokens a colour value names (`var(--x)`), in order.
 * @param {string} value
 * @returns {string[]}
 */
function tokensIn(value) {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => String(match[1]));
}

/**
 * What a note says: its `on:` / `text:` tokens, its `ui:` pairs, `no text`.
 * @param {readonly string[]} notes
 */
function notesOf(notes) {
  /** @type {string[]} */
  const on = [];
  /** @type {string[]} */
  const text = [];
  /** @type {{fg: string, on: string[]}[]} */
  const ui = [];
  let noText = false;
  for (const note of notes) {
    for (const match of note.matchAll(/\bon:\s*((?:--[\w-]+\s*)+)/g)) on.push(...String(match[1]).trim().split(/\s+/));
    for (const match of note.matchAll(/\btext:\s*((?:--[\w-]+\s*)+)/g)) text.push(...String(match[1]).trim().split(/\s+/));
    for (const match of note.matchAll(/\bui:\s*(--[\w-]+)\s+on\s+((?:--[\w-]+\s*)+)/g)) ui.push({ fg: String(match[1]), on: String(match[2]).trim().split(/\s+/) });
    if (/\bno text\b/.test(note)) noText = true;
  }
  return { on, text, ui, noText };
}

/** Values of `color` / `background` that set no colour of their own. */
const NEUTRAL = new Set(["none", "transparent", "inherit", "initial", "unset", "currentcolor"]);

/**
 * Every pair the stylesheet's rules make, and what is wrong with the rules that do not say enough.
 * @param {readonly Rule[]} rules
 * @returns {{pairs: Pair[], problems: string[]}}
 */
export function pairsOf(rules) {
  /** @type {Pair[]} */
  const pairs = [];
  /** @type {string[]} */
  const problems = [];
  for (const rule of rules) {
    if (rule.selector === ":root") continue;
    const where = [...rule.media, rule.selector].join(" ");
    const notes = notesOf(rule.notes);
    const color = rule.declarations.get("color");
    const background = rule.declarations.get("background") ?? rule.declarations.get("background-color");
    const fg = color === undefined ? [] : tokensIn(color);
    const bgs = background === undefined ? [] : tokensIn(background);
    if (color !== undefined && fg.length === 0 && !NEUTRAL.has(color.toLowerCase())) problems.push(`${where}: color ${color} is not a token`);
    if (background !== undefined && bgs.length === 0 && !NEUTRAL.has(background.toLowerCase()) && !notes.noText) {
      problems.push(`${where}: background ${background} is not a token`);
    }
    const opacity = rule.declarations.get("opacity");
    if (opacity !== undefined && Number(opacity) < 1 && !rule.selector.includes(":disabled")) {
      problems.push(`${where}: opacity ${opacity} blends its text into what is behind it`);
    }
    if (fg.length > 0) {
      const under = bgs.length > 0 ? bgs : notes.on;
      if (under.length === 0) problems.push(`${where}: color ${color} says nothing of what it sits on (on: …)`);
      for (const token of fg) for (const bg of under) pairs.push({ kind: "text", fg: token, bg, selector: where });
    } else if (bgs.length > 0 && !notes.noText && (color === undefined || NEUTRAL.has(color.toLowerCase()))) {
      if (notes.text.length === 0) problems.push(`${where}: background ${background} holds text it does not name (text: … or no text)`);
      for (const token of notes.text) for (const bg of bgs) pairs.push({ kind: "text", fg: token, bg, selector: where });
    }
    for (const outline of notes.ui) for (const bg of outline.on) pairs.push({ kind: "ui", fg: outline.fg, bg, selector: where });
  }
  return { pairs, problems };
}

/**
 * The whole check of a stylesheet: every pair in both schemes — the same pair from several rules
 * once —, and the problems (rules that do not say enough, tokens missing, translucent colours).
 * @param {string} css
 * @returns {{rows: Row[], problems: string[]}}
 */
export function check(css) {
  const rules = parseCss(css);
  const { pairs, problems } = pairsOf(rules);
  /** @type {Map<string, Row>} */
  const rows = new Map();
  for (const scheme of SCHEMES) {
    const tokens = tokensOf(rules, scheme);
    for (const pair of pairs) {
      const key = `${scheme} ${pair.kind} ${pair.fg} ${pair.bg}`;
      const seen = rows.get(key);
      if (seen !== undefined) {
        if (!seen.selectors.includes(pair.selector)) seen.selectors.push(pair.selector);
        continue;
      }
      const fgValue = tokens.get(pair.fg);
      const bgValue = tokens.get(pair.bg);
      if (fgValue === undefined || bgValue === undefined) {
        problems.push(`${pair.selector}: ${fgValue === undefined ? pair.fg : pair.bg} is no token of the ${scheme} scheme`);
        continue;
      }
      const fgColor = parseColor(fgValue);
      const bgColor = parseColor(bgValue);
      if (fgColor === null || bgColor === null) {
        problems.push(`${pair.selector}: ${fgColor === null ? `${pair.fg} ${fgValue}` : `${pair.bg} ${bgValue}`} is not a colour (${scheme})`);
        continue;
      }
      if (fgColor.a < 1 || bgColor.a < 1) {
        problems.push(`${pair.selector}: ${fgColor.a < 1 ? pair.fg : pair.bg} is translucent (${scheme}): its contrast depends on what is behind it`);
        continue;
      }
      const ratio = contrastRatio(fgColor, bgColor);
      const min = pair.kind === "text" ? TEXT_MIN : UI_MIN;
      rows.set(key, { scheme, kind: pair.kind, fg: pair.fg, fgValue, bg: pair.bg, bgValue, ratio, min, ok: ratio >= min, selectors: [pair.selector] });
    }
  }
  return { rows: [...rows.values()], problems };
}

/**
 * The check as a table, one line per pair and scheme, the worst first within each scheme, then a
 * summary line.
 * @param {{rows: Row[], problems: string[]}} result
 * @returns {string}
 */
export function report(result) {
  const lines = [`${"scheme".padEnd(6)}  ${"kind".padEnd(4)}  ${"ratio".padStart(6)}  ${"min".padStart(4)}  ${"".padEnd(4)}  ${"colour".padEnd(26)}  ${"on".padEnd(26)}  rules`];
  for (const scheme of SCHEMES) {
    const rows = result.rows.filter((row) => row.scheme === scheme).sort((a, b) => a.ratio / a.min - b.ratio / b.min);
    for (const row of rows) {
      const shown = (/** @type {string[]} */ selectors) => (selectors.length <= 3 ? selectors.join(" | ") : `${selectors.slice(0, 3).join(" | ")} | +${selectors.length - 3} more`);
      lines.push(
        `${row.scheme.padEnd(6)}  ${row.kind.padEnd(4)}  ${row.ratio.toFixed(2).padStart(6)}  ${row.min.toFixed(1).padStart(4)}  ${(row.ok ? "ok" : "LOW").padEnd(4)}  ${`${row.fg} ${row.fgValue}`.padEnd(26)}  ${`${row.bg} ${row.bgValue}`.padEnd(26)}  ${shown(row.selectors)}`,
      );
    }
  }
  const low = result.rows.filter((row) => !row.ok);
  const text = result.rows.filter((row) => row.kind === "text");
  const ui = result.rows.filter((row) => row.kind === "ui");
  const lowest = (/** @type {Row[]} */ rows, /** @type {string} */ scheme) =>
    Math.min(...rows.filter((row) => row.scheme === scheme).map((row) => row.ratio)).toFixed(2);
  lines.push("");
  lines.push(
    `${text.length} text pairs (at least ${TEXT_MIN}:1) and ${ui.length} outline pairs (at least ${UI_MIN}:1) in the light and the dark scheme; ` +
      `lowest text ratio ${lowest(text, "light")}:1 light, ${lowest(text, "dark")}:1 dark; ${low.length} too low.`,
  );
  for (const problem of result.problems) lines.push(`problem: ${problem}`);
  return lines.join("\n");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.argv[2] ?? fileURLToPath(new URL("../src/app/app.css", import.meta.url));
  const result = check(readFileSync(path, "utf8"));
  console.log(report(result));
  process.exitCode = result.problems.length === 0 && result.rows.every((row) => row.ok) ? 0 : 1;
}
