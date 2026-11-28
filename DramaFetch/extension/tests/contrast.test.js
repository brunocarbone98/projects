// @ts-check
// The colours of the DramaFetch tab and its popup (DramaFetch 2.0.0, the owner's request of
// 2026-11-22: more vivid colours): every text of `src/app/app.css` at least 4.5:1 against what it
// sits on, every focus ring and field border at least 3:1, in the light and the dark scheme alike —
// `tools/contrast.js`, a dependency-free check that reads the stylesheet's tokens and the
// backgrounds each colour rule names — and the checker itself.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SCHEMES, TEXT_MIN, UI_MIN, check, contrastRatio, parseColor, parseCss, report, tokensOf } from "../tools/contrast.js";

/** @param {string} relative @returns {string} */
const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const CSS = read("src/app/app.css");

test("every text of the tab and the popup reaches 4.5:1 and every outline 3:1 against what it sits on, in both colour schemes; every colour rule says what it sits on", () => {
  const result = check(CSS);
  assert.deepEqual(result.problems, []);
  const low = result.rows.filter((row) => !row.ok).map((row) => `${row.scheme} ${row.fg} on ${row.bg}: ${row.ratio.toFixed(2)}`);
  assert.deepEqual(low, []);
  // both schemes, the same pairs in each, and many of them: the parser found the rules
  /** @param {string} scheme */
  const pairs = (scheme) => result.rows.filter((row) => row.scheme === scheme).map((row) => `${row.kind} ${row.fg} ${row.bg}`).sort();
  assert.deepEqual(pairs("dark"), pairs("light"));
  assert.ok(pairs("light").length >= 60, `${pairs("light").length} pairs`);
  for (const row of result.rows) assert.ok(row.ratio >= (row.kind === "text" ? TEXT_MIN : UI_MIN), `${row.scheme} ${row.fg} on ${row.bg}`);
  // the texts that matter most, by name: the body, the cards, the muted lines, the buttons, the
  // statuses, the pause line, the Waiting rows, the header, a series' header row and (3.0.1) the
  // list's warnings under it when the list is short, the text fields, the library's cards
  const names = new Set(result.rows.map((row) => `${row.fg} ${row.bg}`));
  for (const pair of [
    "--text --bg",
    "--text --card",
    "--muted --card",
    "--accent-text --accent",
    "--danger-text --danger",
    "--btn-text --btn",
    "--ok-fg --ok-bg",
    "--bad-fg --bad-bg",
    "--warn-fg --warn-bg",
    "--run-fg --run-bg",
    "--wait-fg --wait-bg",
    "--pause-fg --pause-bg",
    "--banner-fg --banner-bg",
    "--id-ink --queue-bg",
    "--muted --queue-retry-bg",
    "--gone-fg --gone-bg",
    "--text --queue-retry-bg",
    "--hero-text --hero-1",
    "--hero-text --hero-3",
    "--ph-text --ph-2",
    "--bar-text --bar-bg",
    "--row-head-fg --row-head-bg",
    "--warn --card",
    "--text --field",
  ]) {
    assert.ok(names.has(pair), pair);
  }
  // the summary the tool prints says so
  assert.match(report(result), /; 0 too low\.$/);
});

test("every colour is a token of both schemes, and the popup's own style sets none: app.css is the one place colours are chosen and checked", () => {
  const rules = parseCss(CSS);
  for (const scheme of SCHEMES) {
    const tokens = tokensOf(rules, scheme);
    for (const name of ["--bg", "--card", "--text", "--muted", "--accent", "--accent-text", "--hero-1", "--queue-bg", "--id-ink"]) {
      assert.ok(parseColor(tokens.get(name) ?? "") !== null, `${scheme}: ${name}`);
    }
  }
  // the dark scheme changes the surfaces and their inks, not the header's gradient
  const [light, dark] = SCHEMES.map((scheme) => tokensOf(rules, scheme));
  assert.notEqual(dark?.get("--bg"), light?.get("--bg"));
  for (const name of ["--hero-1", "--hero-2", "--hero-3", "--hero-text"]) assert.equal(dark?.get(name), light?.get(name), name);
  const popup = read("src/app/popup.html");
  const style = /<style>([\s\S]*?)<\/style>/.exec(popup)?.[1] ?? "";
  assert.doesNotMatch(style, /\b(?:color|background)\s*:/);
  assert.match(popup, /<link rel="stylesheet" href="app\.css">/);
  // a ticked library card is framed in the accent itself (the library's end-to-end test compares them)
  assert.match(CSS, /\.drama-card:has\(\.pick input:checked\) \{ border-color: var\(--accent\); \}/);
  // 3.0.1's warning rows under a drama's header in the progress table: warn-coloured when the list is short
  assert.match(CSS, /tr\.series-warning\.warn td \{ color: var\(--warn\);/);
});

test("the checker: WCAG 2's contrast ratio, the colours it reads, and the rules it refuses — a text colour with nothing said of what it sits on, a background holding unnamed text, a raw or translucent colour, an opacity", () => {
  const white = /** @type {import("../tools/contrast.js").Rgba} */ (parseColor("#fff"));
  const black = /** @type {import("../tools/contrast.js").Rgba} */ (parseColor("rgb(0, 0, 0)"));
  assert.equal(contrastRatio(black, white), 21);
  assert.equal(contrastRatio(white, white), 1);
  assert.equal(Number(contrastRatio(/** @type {import("../tools/contrast.js").Rgba} */ (parseColor("#777777")), white).toFixed(2)), 4.48); // the classic just-too-light grey
  assert.deepEqual(parseColor("#11223380"), { r: 17, g: 34, b: 51, a: 128 / 255 });
  assert.deepEqual(parseColor("rgba(1, 2, 3, 0.5)"), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.equal(parseColor("var(--x)"), null);
  assert.equal(parseColor("red"), null);
  const sheet = `
    :root { --bg: #ffffff; --ink: #777777; --ok: #1d1433; --veil: rgba(0, 0, 0, 0.5); --ring: #eeeeee; }
    @media (prefers-color-scheme: dark) { :root { --bg: #000000; --ink: #888888; --ok: #ffffff; --ring: #111111; } }
    .low { color: var(--ink); background: var(--bg); }
    .fine { color: var(--ok); /* on: --bg */ }
    .lost { color: var(--ok); }
    .silent { background: var(--bg); }
    .raw { color: #123456; background: var(--bg); }
    .veiled { color: var(--ok); background: var(--veil); }
    .faded { color: var(--ok); background: var(--bg); opacity: 0.8; }
    button:disabled { opacity: 0.45; }
    .frame { background: var(--bg); /* no text */ }
    .ring { outline: 2px solid var(--ring); /* ui: --ring on --bg */ }
    @media (max-width: 500px) { .narrow { color: var(--ok); background: var(--bg); } }
  `;
  const result = check(sheet);
  /** @param {string} scheme @param {string} fg */
  const ratio = (scheme, fg) => result.rows.find((row) => row.scheme === scheme && row.fg === fg && row.bg === "--bg")?.ratio;
  assert.equal(Number(ratio("light", "--ink")?.toFixed(2)), 4.48);
  assert.equal(result.rows.find((row) => row.scheme === "light" && row.fg === "--ink")?.ok, false);
  assert.equal(result.rows.find((row) => row.scheme === "dark" && row.fg === "--ink")?.ok, true); // #888 on black: 5.92
  assert.equal(result.rows.find((row) => row.scheme === "light" && row.kind === "ui")?.ok, false); // #eee on white
  assert.ok((ratio("light", "--ok") ?? 0) > 4.5);
  assert.deepEqual(result.problems, [
    ".lost: color var(--ok) says nothing of what it sits on (on: …)",
    ".silent: background var(--bg) holds text it does not name (text: … or no text)",
    ".raw: color #123456 is not a token",
    ".faded: opacity 0.8 blends its text into what is behind it",
    ".veiled: --veil is translucent (light): its contrast depends on what is behind it",
    ".veiled: --veil is translucent (dark): its contrast depends on what is behind it", // the dark scheme keeps a token it does not change
  ]);
  assert.match(report(result), /; 3 too low\.\n/); // #777 on white, and both rings
});
