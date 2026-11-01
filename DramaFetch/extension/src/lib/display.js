// @ts-check
/**
 * What the DramaFetch tab SHOWS of the engine's texts. The engine writes its statuses, messages,
 * report lines, pause announcements and errors in English, byte for byte the Python tool's (they
 * are stored in the per-series state and the history, and the parity tests compare them); this
 * module only changes how they read on screen, never what is stored:
 *
 * - `lang: "es"` translates every text the extension can show into Spanish — through ordered rules
 *   built from the real constants and format strings of `src/lib/*.js` and
 *   `src/app/{engine,downloader,discovery,redirects}.js` (imported, never copied, wherever they are
 *   exported) — and translates the texts embedded in a text the same way (a stop reason, the
 *   message after `stopped: `, the reason of a cooldown, …);
 * - `lang: "en"` keeps the English;
 * - in BOTH languages, advice that names a command-line flag is replaced by what to do in the
 *   extension: {@link RECHECK_HINT}'s `--recheck looks again` points at the “Look again at series
 *   found complete…” checkbox, {@link DRM_REMEMBERED_MESSAGE}'s `--include-locked tries again` at
 *   the “Also ask for locked episodes…” checkbox (`labels.recheck`, `labels.includeLocked`: the
 *   UI's own words, from `chrome.i18n`). No text the extension shows names a cookies file: it has
 *   none, and its login advice already says to log in to TikTok in a normal Chrome tab.
 *
 * Data inside a text — series names, file names, host names, numbers, times, the payload's lock
 * hints, technical details — passes through unchanged; a text no rule knows passes through
 * unchanged, never half translated; {@link displayText} never throws. Pure: no `chrome.*`, no
 * DOM (the app page picks the language and the labels, `src/app/i18n.js`).
 */

import { NO_PLAY_ADDRESS } from "./catalog.js";
import { EXTENSION_LIFT_TEXT } from "./cooldown.js";
import {
  BLOCKED_MESSAGE,
  DONE,
  DRM_MARK,
  DRM_MESSAGE,
  DRM_REMEMBERED_MESSAGE,
  DRY_RUN,
  FAILED,
  FAILED_BLOCKED,
  FAILED_LOGIN,
  FAILED_RATE_LIMITED,
  FAILED_UNAVAILABLE,
  INCOMPLETE_PREFIX,
  LIST_RATE_LIMIT_MESSAGE,
  MANIFEST_SKIP_PREFIX,
  MEDIA_RATE_LIMIT_MESSAGE,
  NOT_STARTED_PREFIX,
  PAYLOAD_DRM_MESSAGE,
  RECHECK_HINT,
  SKIPPED_EXISTS,
  SKIPPED_LOCKED,
  STATUSES,
  STOPPED_PREFIX,
  UNAVAILABLE_MESSAGE,
} from "./messages.js";
import { NAME_PLACEHOLDERS } from "./naming.js";
import { MAX_PAUSE_S, PACES } from "./pacing.js";
import {
  CHALLENGE_MESSAGE,
  EMPTY_LIST_MESSAGE,
  FIRST_PAGE_WARNING,
  LOGIN_REDIRECT_MESSAGE,
  NOTHING_NEW_WARNING,
  NO_CURSOR_WARNING,
  NO_LIST_WARNING,
} from "../app/discovery.js";
import { StopRequested } from "../app/engine.js";

/**
 * @typedef {"en" | "es"} Lang
 *
 * @typedef {object} DisplayLabels What the UI calls the controls a text points to (`chrome.i18n`).
 * @property {string} [recheck] the “Look again at series found complete…” checkbox (`recheckLabel`)
 * @property {string} [includeLocked] the “Also ask for locked episodes…” checkbox (`includeLockedLabel`)
 * @property {Readonly<Record<string, string>>} [fields] the settings' labels by the Python names a
 *   pacing refusal uses (`delay_min_s`, `rest_every`, …); a name without one is shown as it is
 *
 * @typedef {object} DisplayOptions
 * @property {string} [lang] `es` translates; anything else keeps the English
 * @property {DisplayLabels} [labels]
 */

/** The languages the engine's texts are shown in. */
export const DISPLAY_LANGUAGES = Object.freeze(/** @type {const} */ (["en", "es"]));

/**
 * The labels used when the page passes none: `recheckLabel` and `includeLockedLabel` of
 * `_locales/<lang>/messages.json` (a unit test keeps them equal).
 * @type {Readonly<Record<Lang, Required<Pick<DisplayLabels, "recheck" | "includeLocked">>>>}
 */
export const DEFAULT_LABELS = Object.freeze({
  en: Object.freeze({
    recheck: "Look again at series found complete in the last 24 hours",
    includeLocked: "Also ask for locked episodes (TikTok decides; usually they fail)",
  }),
  es: Object.freeze({
    recheck: "Volver a revisar las series completas de las últimas 24 horas",
    includeLocked: "Pedir también los episodios bloqueados (TikTok decide; normalmente fallan)",
  }),
});

/** The status of a row the run gave up on before reaching it (`stopped: …`): its own label. */
export const STOPPED_LABEL_KEY = "stopped";

/**
 * A short human label per status code, per language (the code itself stays in a title attribute).
 * @type {Readonly<Record<Lang, Readonly<Record<string, string>>>>}
 */
export const STATUS_LABELS = Object.freeze({
  en: Object.freeze({
    [DONE]: "downloaded",
    [SKIPPED_EXISTS]: "already on disk",
    [SKIPPED_LOCKED]: "locked, skipped",
    [DRY_RUN]: "dry run",
    [FAILED_LOGIN]: "login required",
    [FAILED_UNAVAILABLE]: "unavailable",
    [FAILED_RATE_LIMITED]: "rate limited",
    [FAILED_BLOCKED]: "blocked by TikTok",
    [FAILED]: "failed",
    [STOPPED_LABEL_KEY]: "stopped",
  }),
  es: Object.freeze({
    [DONE]: "descargado",
    [SKIPPED_EXISTS]: "ya en disco",
    [SKIPPED_LOCKED]: "bloqueado, omitido",
    [DRY_RUN]: "simulación",
    [FAILED_LOGIN]: "falta iniciar sesión",
    [FAILED_UNAVAILABLE]: "no disponible",
    [FAILED_RATE_LIMITED]: "limitado por TikTok",
    [FAILED_BLOCKED]: "bloqueado por TikTok",
    [FAILED]: "falló",
    [STOPPED_LABEL_KEY]: "detenido",
  }),
});

/** Embedded texts are translated this deep at most (a stop reason inside a stop reason…). */
const MAX_DEPTH = 12;
/** Where a name with parentheses meets its reason, this many splits are tried at most. */
const MAX_SPLITS = 16;

/**
 * `es` for a UI language that is Spanish (`es`, `es-419`, `es_PA`, …), else `en`.
 * @param {unknown} uiLanguage what `chrome.i18n.getUILanguage()` says
 * @returns {Lang}
 */
export function displayLanguageOf(uiLanguage) {
  return typeof uiLanguage === "string" && /^es(?:[-_]|$)/i.test(uiLanguage) ? "es" : "en";
}

/**
 * The short label of a status code (`done`, `skipped-locked`, …) in `lang`; a row whose message
 * says the run stopped before it (`stopped: …`) is labelled “stopped”. An unknown status is
 * shown as it is. Never throws.
 * @param {unknown} status
 * @param {{lang?: string, message?: unknown}} [options]
 * @returns {string}
 */
export function statusLabel(status, options = {}) {
  try {
    const labels = STATUS_LABELS[options.lang === "es" ? "es" : "en"];
    if (typeof options.message === "string" && options.message.startsWith(STOPPED_PREFIX) && status !== DONE) {
      return /** @type {string} */ (labels[STOPPED_LABEL_KEY]);
    }
    if (typeof status !== "string") return String(status ?? "");
    return Object.hasOwn(labels, status) ? /** @type {string} */ (labels[status]) : status;
  } catch {
    return typeof status === "string" ? status : "";
  }
}

/**
 * The text as the DramaFetch tab shows it (see the module comment). Never throws: anything it
 * cannot read comes back unchanged.
 * @param {unknown} text
 * @param {DisplayOptions} [options]
 * @returns {string}
 */
export function displayText(text, options = {}) {
  if (typeof text !== "string") return text === null || text === undefined ? "" : safeString(text);
  try {
    const lang = options.lang === "es" ? "es" : "en";
    const labels = options.labels ?? {};
    /** @type {Context} */
    const context = {
      recheck: nonEmpty(labels.recheck) ?? DEFAULT_LABELS[lang].recheck,
      includeLocked: nonEmpty(labels.includeLocked) ?? DEFAULT_LABELS[lang].includeLocked,
      fields: labels.fields ?? {},
    };
    return lang === "es" ? spanish(text, context, 0) : english(text, context);
  } catch {
    return text;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeString(value) {
  try {
    return String(value);
  } catch {
    return "";
  }
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * @typedef {object} Context
 * @property {string} recheck
 * @property {string} includeLocked
 * @property {Readonly<Record<string, string>>} fields
 */

// ------------------------------------------------------------------ the parts of constants

/** `RECHECK_HINT` up to its question mark: `unlocked more in the TikTok app since?`. */
const RECHECK_QUESTION = RECHECK_HINT.slice(0, RECHECK_HINT.indexOf("?") + 1);
/** `DRM_REMEMBERED_MESSAGE` without its flag advice: `protected by DRM (found by …): … decrypt it`. */
const DRM_REMEMBERED_VERDICT = DRM_REMEMBERED_MESSAGE.slice(0, DRM_REMEMBERED_MESSAGE.lastIndexOf("; "));
/** What every DRM message says after its parenthesis: `: DramaFetch does not decrypt it`. */
const DRM_TAIL = DRM_MESSAGE.slice(DRM_MESSAGE.indexOf("): ") + 1);
/**
 * The parenthesis of a DRM message: `encrypted tracks` (`DRM_MESSAGE`), `found by an earlier run`
 * (`DRM_REMEMBERED_MESSAGE`), `flagged in the episode list` (`PAYLOAD_DRM_MESSAGE`).
 * @param {string} message
 * @returns {string}
 */
function drmInner(message) {
  return message.slice(DRM_MARK.length + 2, message.indexOf("): "));
}
const DRM_ENCRYPTED_TRACKS = drmInner(DRM_MESSAGE);
const DRM_FLAGGED = drmInner(PAYLOAD_DRM_MESSAGE);
/** The placeholders a name format may use, as `nameFormatProblem` lists them. */
const ALLOWED_PLACEHOLDERS = NAME_PLACEHOLDERS.map((name) => `{${name}}`).join(", ");

/**
 * @param {string} text
 * @returns {string} `text` as a literal in a regular expression
 */
function esc(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ------------------------------------------------------------------------------- English

/**
 * The English texts with the flag advice replaced by the extension's own controls.
 * @param {string} text
 * @param {Context} context
 * @returns {string}
 */
function english(text, context) {
  if (!text.includes(DRM_REMEMBERED_MESSAGE) && !text.includes(RECHECK_HINT)) return text;
  return text
    .split(DRM_REMEMBERED_MESSAGE)
    .join(`${DRM_REMEMBERED_VERDICT}; tick “${context.includeLocked}” to try again`)
    .split(RECHECK_HINT)
    .join(`${RECHECK_QUESTION} Tick “${context.recheck}” to look again`);
}

// ------------------------------------------------------------------------------- Spanish

/**
 * @param {string} count digits
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
function plural(count, one, many) {
  return count === "1" ? one : many;
}

/**
 * Lock hints (`isLocked=True; no play address`): the payload's own `key=value` hints are data;
 * only the extension's own hint, {@link NO_PLAY_ADDRESS}, is translated.
 * @param {string} hints
 * @returns {string}
 */
function hintsEs(hints) {
  return hints
    .split("; ")
    .map((hint) => (hint === NO_PLAY_ADDRESS ? "sin dirección de reproducción" : hint))
    .join("; ");
}

/**
 * A settings name of a pacing refusal (`delay_min_s`) as the settings call it, quoted.
 * @param {string} name
 * @param {Context} context
 * @returns {string}
 */
function fieldEs(name, context) {
  const label = Object.hasOwn(context.fields, name) ? context.fields[name] : undefined;
  return typeof label === "string" && label ? `“${label}”` : name;
}

/** `just now`, `5 min ago`, `2 h ago` (`report.ago`). @param {string} ago @returns {string | null} */
function agoEs(ago) {
  if (ago === "just now") return "hace un momento";
  const match = /^(\d+) (min|h) ago$/.exec(ago);
  return match ? `hace ${match[1]} ${match[2]}` : null;
}

/**
 * The exact texts, English → Spanish.
 * @type {ReadonlyMap<string, string | ((context: Context) => string)>}
 */
const EXACT = new Map(
  /** @type {[string, string | ((context: Context) => string)][]} */ ([
    [DRM_MESSAGE, "protegido con DRM (pistas cifradas): DramaFetch no lo descifra"],
    [
      DRM_REMEMBERED_MESSAGE,
      (context) =>
        "protegido con DRM (lo detectó una ejecución anterior): DramaFetch no lo descifra; para " +
        `intentarlo de nuevo, marca “${context.includeLocked}”`,
    ],
    [PAYLOAD_DRM_MESSAGE, "protegido con DRM (así lo marca la lista de episodios): DramaFetch no lo descifra"],
    [
      RECHECK_HINT,
      (context) => `¿desbloqueaste más en la app de TikTok desde entonces? Para revisarla de nuevo, marca “${context.recheck}”`,
    ],
    [
      BLOCKED_MESSAGE,
      "bloqueado (HTTP 403): TikTok rechazó la solicitud; espera de 30 a 60 minutos antes de volver a intentarlo",
    ],
    [UNAVAILABLE_MESSAGE, "no hay ningún video reproducible: bloqueado, restringido en tu región o sin sesión iniciada"],
    [
      MEDIA_RATE_LIMIT_MESSAGE,
      "el servidor de video está limitando las solicitudes (HTTP 429): espera de 30 a 60 minutos antes de volver a intentarlo",
    ],
    [
      LIST_RATE_LIMIT_MESSAGE,
      "TikTok está limitando las solicitudes de esta dirección (HTTP 429 en la lista de episodios): espera de 30 a " +
        "60 minutos antes de volver a intentarlo",
    ],
    [
      LOGIN_REDIRECT_MESSAGE,
      "TikTok redirigió a su página de inicio de sesión: inicia sesión en TikTok en una pestaña normal de este " +
        "Chrome y vuelve a intentarlo",
    ],
    [
      CHALLENGE_MESSAGE,
      "TikTok pide una verificación (captcha) en lugar de la serie: cuando termine la espera obligatoria, abre la " +
        "serie en una pestaña normal de este Chrome, resuélvela ahí y vuelve a intentarlo",
    ],
    [
      EMPTY_LIST_MESSAGE,
      "TikTok devolvió una lista de episodios vacía; hace falta una sesión iniciada: inicia sesión en TikTok en " +
        "una pestaña normal de este Chrome",
    ],
    [NO_CURSOR_WARNING, "TikTok indicó que hay más episodios, pero sin un cursor utilizable; en su lugar se desplazó la página"],
    [NO_LIST_WARNING, "la consulta de la página siguiente no devolvió ninguna lista de episodios; en su lugar se desplazó la página"],
    [
      NOTHING_NEW_WARNING,
      "la consulta de la página siguiente no trajo episodios nuevos aunque TikTok indicó que había más; en su " +
        "lugar se desplazó la página",
    ],
    [
      FIRST_PAGE_WARNING,
      "no se pudo volver a pedir la primera página de la lista de episodios desde la página; en su lugar se " +
        "desplazó la página",
    ],
    [EXTENSION_LIFT_TEXT, "la extensión no tiene forma de levantarla antes de tiempo"],
    [DRM_MARK, "protegido con DRM"],
    [NOT_STARTED_PREFIX, "no iniciada: "],
    [new StopRequested().message, "detenido por ti"],
    [NO_PLAY_ADDRESS, "sin dirección de reproducción"],
    // engine.js: the error of a series listed empty, the short reasons of a failed listing
    ["no episodes listed", "no se listó ningún episodio"],
    ["login required", "hace falta iniciar sesión"],
    ["rate limited (HTTP 429)", "demasiadas solicitudes (HTTP 429)"],
    ["the episode list could not be fetched", "no se pudo obtener la lista de episodios"],
    // app.js: why a job stopped when nothing says more
    ["stopped", "detenido"],
    // report.batchStatus
    ["complete", "completa"],
    ["incomplete", "incompleta"],
    ["skipped (complete)", "omitida (completa)"],
    ["not started", "no iniciada"],
    // catalog.catalogWarnings
    ["1 episode looks locked", "1 episodio parece bloqueado"],
    // discovery.js
    ["Chrome did not open a tab for the series", "Chrome no abrió una pestaña para la serie"],
    [
      "the TikTok tab DramaFetch opened was closed before the episode list arrived",
      "la pestaña de TikTok que abrió DramaFetch se cerró antes de que llegara la lista de episodios",
    ],
    // urls.parseInput
    ["Paste a TikTok short-drama URL (…/shortdrama/episode/<id>/<n>).", "Pega un enlace de microdrama de TikTok (…/shortdrama/episode/<id>/<n>)."],
    [
      "Short links (vm.tiktok.com, vt.tiktok.com, tiktok.com/t/…) are not resolved: open the link in your browser " +
        "and paste the full address, which contains /shortdrama/episode/.",
      "Los enlaces cortos (vm.tiktok.com, vt.tiktok.com, tiktok.com/t/…) no se resuelven: abre el enlace en tu " +
        "navegador y pega la dirección completa, que contiene /shortdrama/episode/.",
    ],
    // storage.settingsProblem
    ["unknown quality", "calidad desconocida"],
    ["unknown cover mode", "modo de portada desconocido"],
    ["unknown pace", "ritmo desconocido"],
    ["the name format must be text", "el formato de nombre debe ser texto"],
    // cooldown.js: a refusal recorded without a reason
    ["request refused", "solicitud rechazada"],
    // lib/mp4.verifyVideo and embedCover
    ["no playable duration", "sin duración reproducible"],
    ["no audio track", "sin pista de audio"],
    ["webp cannot be embedded", "una imagen WEBP no se puede incrustar"],
    ["not a JPEG or PNG image", "no es una imagen JPEG ni PNG"],
    // downloader.js
    ["no play url could be requested", "no se pudo pedir ninguna URL de reproducción"],
    ["no play url, even in a fresh episode list", "no hay ninguna URL de reproducción, ni siquiera en una lista de episodios nueva"],
    ["the transfer was cut short", "la transferencia se cortó"],
    ["the download disappeared", "la descarga desapareció"],
    ["too large, not kept", "demasiado grande, no se guardó"],
    ["webp cannot be embedded; saved as file", "una imagen WEBP no se puede incrustar; se guardó como archivo"],
    ["an untyped body", "un cuerpo sin tipo"],
    // every status code: its label
    ...STATUSES.map((status) => /** @type {[string, string]} */ ([status, /** @type {string} */ (STATUS_LABELS.es[status])])),
  ]),
);

/**
 * @typedef {(match: RegExpExecArray, inner: (text: string) => string, context: Context) => string | null} Builder
 */

/** The statuses, longest first (so `failed` never matches the start of `failed-blocked`). */
const STATUS_ALTERNATIVES = [...STATUSES].sort((a, b) => b.length - a.length).map(esc).join("|");
/** A count of a report line. */
const N = String.raw`(\d+)`;
/** The episode numbers of a report line (`report.numbersText`): `5, 6`, `1-3, 9`, `…`. */
const NUMS = String.raw`([^()]*)`;
/** A host name (no spaces). */
const HOST = String.raw`(\S+)`;

/**
 * The details of a report line (`3 downloaded`… are not details): unlocked, locked, failed and
 * not-downloaded counts, in that order, each at most once, joined by `, `; null for anything else.
 * @param {string} text
 * @returns {string | null}
 */
function detailsEs(text) {
  /** @type {[RegExp, (match: RegExpExecArray) => string][]} */
  const pieces = [
    [
      new RegExp(String.raw`^${N} paid (?:episode|episodes) your account unlocked \(${NUMS}\)`),
      (m) => `${m[1]} ${plural(String(m[1]), "episodio de pago", "episodios de pago")} que tu cuenta desbloqueó (${m[2]})`,
    ],
    [new RegExp(String.raw`^${N} locked \(${NUMS}\)`), (m) => `${m[1]} ${plural(String(m[1]), "bloqueado", "bloqueados")} (${m[2]})`],
    [new RegExp(String.raw`^${N} failed \(${NUMS}\)`), (m) => `${m[1]} ${plural(String(m[1]), "fallido", "fallidos")} (${m[2]})`],
    [new RegExp(String.raw`^${N} not downloaded`), (m) => `${m[1]} sin descargar`],
  ];
  /** @type {string[]} */
  const out = [];
  let rest = text;
  let next = 0;
  while (rest !== "") {
    let found = false;
    for (let index = next; index < pieces.length; index += 1) {
      const [pattern, build] = /** @type {[RegExp, (match: RegExpExecArray) => string]} */ (pieces[index]);
      const match = pattern.exec(rest);
      if (match === null) continue;
      out.push(build(match));
      rest = rest.slice(match[0].length);
      next = index + 1;
      found = true;
      break;
    }
    if (!found) return null;
    if (rest === "") break;
    if (!rest.startsWith(", ")) return null;
    rest = rest.slice(2);
    if (rest === "") return null;
  }
  return out.length > 0 ? out.join(", ") : null;
}

/**
 * One `; ` group of an incomplete line that is not its details: the gaps, the announced total,
 * the empty list; null for anything else.
 * @param {string} group
 * @returns {string | null}
 */
function lineGroupEs(group) {
  let match = /^(episode|episodes) ([^;]+) missing from TikTok's list$/.exec(group);
  if (match !== null) {
    return match[1] === "episode"
      ? `falta el episodio ${match[2]} en la lista de TikTok`
      : `faltan los episodios ${match[2]} en la lista de TikTok`;
  }
  match = /^TikTok announces (\d+) episodes, (\d+) listed$/.exec(group);
  if (match !== null) return `TikTok anuncia ${match[1]} episodios, ${match[2]} listados`;
  if (group === "no episodes listed") return "no se listó ningún episodio";
  return null;
}

/**
 * `report.reportLine` in Spanish, or null when the line is not one it writes.
 * @param {string} line
 * @param {(text: string) => string} inner
 * @returns {string | null}
 */
function reportLineEs(line, inner) {
  let match = new RegExp(
    String.raw`^complete, nothing to do: ${N} (episode|episodes) already on disk` +
      String.raw`(?:, ${N} locked \(${NUMS}\))?(?: \(checked (just now|\d+ min ago|\d+ h ago)\))?(?: — (.*))?$`,
    "s",
  ).exec(line);
  if (match !== null) {
    const [, count, noun, locked, numbers, ago, hint] = match;
    let out = `completa, nada que hacer: ${count} ${noun === "episode" ? "episodio" : "episodios"} ya en disco`;
    if (locked !== undefined) out += `, ${locked} ${plural(locked, "bloqueado", "bloqueados")} (${numbers})`;
    if (ago !== undefined) {
      const when = agoEs(ago);
      if (when === null) return null;
      out += ` (revisada ${when})`;
    }
    if (hint !== undefined) {
      if (hint !== RECHECK_HINT) return null;
      out += ` — ${inner(hint)}`;
    }
    return out;
  }
  match = new RegExp(
    String.raw`^complete: ${N} of ${N}(?: \((?:${N} downloaded(?:, ${N} already on disk)?|${N} already on disk)\))?(?: — (.*))?$`,
    "s",
  ).exec(line);
  if (match !== null) {
    const [, have, total, done, onDiskAfterDone, onDiskOnly, notes] = match;
    let out = `completa: ${have} de ${total}`;
    /** @type {string[]} */
    const obtained = [];
    if (done !== undefined) obtained.push(`${done} ${plural(done, "descargado", "descargados")}`);
    const onDisk = onDiskAfterDone ?? onDiskOnly;
    if (onDisk !== undefined) obtained.push(`${onDisk} ya en disco`);
    if (obtained.length > 0) out += ` (${obtained.join(", ")})`;
    if (notes !== undefined) {
      const details = detailsEs(notes);
      if (details === null) return null;
      out += ` — ${details}`;
    }
    return out;
  }
  match = new RegExp(String.raw`^incomplete: ${N} of ${N}(?: — (.*))?$`, "s").exec(line);
  if (match !== null) {
    const [, have, total, rest] = match;
    let out = `incompleta: ${have} de ${total}`;
    if (rest === undefined) return out;
    let body = rest;
    /** @type {string | null} */
    let stopped = null;
    const stopAt = body.startsWith(STOPPED_PREFIX) ? 0 : body.indexOf(`; ${STOPPED_PREFIX}`);
    if (stopAt >= 0) {
      stopped = body.slice(stopAt === 0 ? STOPPED_PREFIX.length : stopAt + 2 + STOPPED_PREFIX.length);
      body = body.slice(0, stopAt);
    }
    /** @type {string[]} */
    const groups = [];
    const parts = body === "" ? [] : body.split("; ");
    for (const [index, part] of parts.entries()) {
      const translated = (index === 0 ? detailsEs(part) : null) ?? lineGroupEs(part);
      if (translated === null) return null;
      groups.push(translated);
    }
    if (stopped !== null) groups.push(`detenido: ${inner(stopped)}`);
    if (groups.length === 0) return null;
    return `${out} — ${groups.join("; ")}`;
  }
  return null;
}

/**
 * The note a DONE message ends with (`downloader.keep`): ` + cover embedded`, ` + cover embedded
 * + file`, ` + cover file`, `; cover: <reason>` (also after ` + cover embedded`), or nothing.
 * @param {string} note
 * @param {(text: string) => string} inner
 * @returns {string | null}
 */
function coverNoteEs(note, inner) {
  if (note === "") return "";
  const embedded = " + cover embedded";
  if (note === `${embedded} + file`) return " + portada incrustada + archivo";
  if (note === " + cover file") return " + portada como archivo aparte";
  if (note === embedded) return " + portada incrustada";
  let rest = note;
  let out = "";
  if (rest.startsWith(`${embedded}; cover: `)) {
    out = " + portada incrustada";
    rest = rest.slice(embedded.length);
  }
  if (!rest.startsWith("; cover: ")) return null;
  return `${out}; portada: ${coverReasonEs(rest.slice("; cover: ".length), inner)}`;
}

/**
 * Why there is no cover (after `; cover: `): the downloader's and `fetchImage`'s reasons.
 * @param {string} reason
 * @param {(text: string) => string} inner
 * @returns {string}
 */
function coverReasonEs(reason, inner) {
  let match = /^could not embed \((.*)\); saved as file$/s.exec(reason);
  if (match !== null) return `no se pudo incrustar (${inner(String(match[1]))}); se guardó como archivo`;
  match = /^could not save the file \((.*)\)$/s.exec(reason);
  if (match !== null) return `no se pudo guardar el archivo (${inner(String(match[1]))})`;
  return inner(reason);
}

/**
 * `saved <file> (<size> MiB)<note>` (`downloader.keep`), the file name being data: the first
 * ` (<size> MiB)` after which a known note follows.
 * @param {string} text
 * @param {(text: string) => string} inner
 * @returns {string | null}
 */
function savedEs(text, inner) {
  if (!text.startsWith("saved ")) return null;
  const sizeRe = / \((\d+(?:\.\d+)?) MiB\)/g;
  for (let match = sizeRe.exec(text); match !== null; match = sizeRe.exec(text)) {
    const file = text.slice("saved ".length, match.index);
    if (file === "") continue;
    const note = coverNoteEs(text.slice(match.index + match[0].length), inner);
    if (note !== null) return `guardado ${file} (${match[1]} MiB)${note}`;
  }
  return null;
}

/**
 * `not started: batch stopped in <name or id> (<reason>)`: the split whose reason a rule knows
 * (a series name may hold parentheses too), else the first.
 * @param {string} text
 * @param {(text: string) => string} inner
 * @returns {string | null}
 */
function notStartedEs(text, inner) {
  const prefix = `${NOT_STARTED_PREFIX}batch stopped in `;
  if (!text.startsWith(prefix) || !text.endsWith(")")) return null;
  const body = text.slice(prefix.length, -1);
  /** @type {[string, string] | null} */
  let first = null;
  let tries = 0;
  for (let at = body.indexOf(" ("); at >= 0 && tries < MAX_SPLITS; at = body.indexOf(" (", at + 1), tries += 1) {
    const where = body.slice(0, at);
    const reason = body.slice(at + 2);
    if (where === "") continue;
    first = first ?? [where, reason];
    const translated = inner(reason);
    if (translated !== reason) return `no iniciada: el lote se detuvo en ${where} (${translated})`;
  }
  if (first === null) return null;
  return `no iniciada: el lote se detuvo en ${first[0]} (${inner(first[1])})`;
}

/**
 * `<size> of <type>` / `<type>` of a body that is no video or no image (`lib/mp4`).
 * @param {string} what
 * @param {(text: string) => string} inner
 * @returns {string}
 */
function bodyKindEs(what, inner) {
  const match = /^(\d+(?:\.\d+)? (?:MiB|KiB)|\d+ bytes) of (.*)$/s.exec(what);
  if (match !== null) return `${match[1]} de ${inner(String(match[2]))}`;
  return inner(what);
}

/**
 * The pattern rules, in order; the first whose builder answers wins.
 * @type {readonly [RegExp, Builder][]}
 */
const RULES = [
  // prefixes the engine puts in front of another text
  [new RegExp(`^${esc(STOPPED_PREFIX)}(.*)$`, "s"), (m, inner) => `detenido: ${inner(String(m[1]))}`],
  [new RegExp(`^${esc(NOT_STARTED_PREFIX)}batch stopped in `, "s"), (m, inner) => notStartedEs(String(m.input), inner)],
  [/^line (\d+): (.*)$/s, (m, inner) => `línea ${m[1]}: ${inner(String(m[2]))}`],
  [/^duplicate: (.*)$/s, (m) => `repetida: ${m[1]}`],
  [/^failed: (.*)$/s, (m, inner) => `falló: ${inner(String(m[1]))}`],
  [/^could not list the series: (.*)$/s, (m, inner) => `no se pudo listar la serie: ${inner(String(m[1]))}`],
  [/^download failed: (.*)$/s, (m, inner) => `la descarga falló: ${inner(String(m[1]))}`],
  [
    new RegExp(`^${esc(INCOMPLETE_PREFIX)}(.*)$`, "s"),
    (m, inner) => `la descarga parece incompleta o incorrecta: ${inner(String(m[1]))}`,
  ],
  [
    new RegExp(`^${esc(UNAVAILABLE_MESSAGE)} \\((.*)\\)$`, "s"),
    (m, inner) => `${inner(UNAVAILABLE_MESSAGE)} (${inner(String(m[1]))})`,
  ],
  [
    /^(.*); refreshing the episode list failed: (.*)$/s,
    (m, inner) => `${inner(String(m[1]))}; falló la actualización de la lista de episodios: ${inner(String(m[2]))}`,
  ],
  // the cooldown (cooldown.js)
  [
    /^TikTok refused a request at (\d{2}:\d{2}) \((.*)\); DramaFetch waits until (\d{2}:\d{2}) \((\d+) min left\) before contacting TikTok again — (.*)$/s,
    (m, inner) =>
      `TikTok rechazó una solicitud a las ${m[1]} (${inner(String(m[2]))}); DramaFetch espera hasta las ${m[3]} ` +
      `(faltan ${m[4]} min) antes de volver a contactar a TikTok — ${inner(String(m[5]))}`,
  ],
  [/^cooldown until (\d{2}:\d{2})$/, (m) => `espera obligatoria hasta las ${m[1]}`],
  [/^until (\d{2}:\d{2}) \((\d+) min left\): (.*)$/s, (m, inner) => `hasta las ${m[1]} (faltan ${m[2]} min): ${inner(String(m[3]))}`],
  // the report line (report.reportLine) and the stops (pacing.afterResult)
  [/^(?:complete, nothing to do|complete|incomplete): /, (m, inner) => reportLineEs(String(m.input), inner)],
  [
    new RegExp(`^episode (-?\\d+) (${STATUS_ALTERNATIVES})(?:: (.*))?$`, "s"),
    (m, inner) => `episodio ${m[1]} (${inner(String(m[2]))})${m[3] === undefined ? "" : `: ${inner(m[3])}`}`,
  ],
  [
    /^(\d+) consecutive failures(?: \(last: (.*)\))?$/s,
    (m, inner) => `${m[1]} fallos seguidos${m[2] === undefined ? "" : ` (el último: ${inner(m[2])})`}`,
  ],
  // DRM (messages.js, report.lockedResult, downloader.refresh)
  [
    new RegExp(`^${esc(DRM_MARK)} \\((.*)\\)${esc(DRM_TAIL)}$`, "s"),
    (m) => {
      const inside = String(m[1]);
      let text;
      if (inside === DRM_ENCRYPTED_TRACKS) text = "pistas cifradas";
      else if (inside === DRM_FLAGGED) text = "así lo marca la lista de episodios";
      else if (inside.startsWith("in a fresh episode list: ")) {
        text = `en una lista de episodios nueva: ${hintsEs(inside.slice("in a fresh episode list: ".length))}`;
      } else text = hintsEs(inside);
      return `protegido con DRM (${text}): DramaFetch no lo descifra`;
    },
  ],
  [/^looks locked(?:: (.*))?$/s, (m) => (m[1] === undefined ? "parece bloqueado" : `parece bloqueado: ${hintsEs(m[1])}`)],
  [/^locked in a fresh episode list: (.*)$/s, (m) => `bloqueado en una lista de episodios nueva: ${hintsEs(String(m[1]))}`],
  // the downloader's results
  [/^already exists: (.*)$/s, (m) => `ya existe: ${m[1]}`],
  [new RegExp(`^${esc(MANIFEST_SKIP_PREFIX)}(.*)$`, "s"), (m) => `ya descargado (según el registro): ${m[1]}`],
  [/^saved /, (m, inner) => savedEs(String(m.input), inner)],
  [/^could not save (.+?\.mp4): (.*)$/s, (m, inner) => `no se pudo guardar ${m[1]}: ${inner(String(m[2]))}`],
  [/^E(\d+): fresh episode list$/, (m) => `E${m[1]}: lista de episodios nueva`],
  // why a URL gave no video, or no cover (downloader.js, redirects.js, lib/mp4)
  [new RegExp(`^${HOST} is not a host this extension may contact$`), (m) => `${m[1]} no es un servidor que esta extensión pueda contactar`],
  [new RegExp(`^no response \\((.*)\\) from ${HOST}$`, "s"), (m, inner) => `sin respuesta (${inner(String(m[1]))}) de ${m[2]}`],
  [new RegExp(`^a redirect from ${HOST}, not followed$`), (m) => `una redirección de ${m[1]}, que no se siguió`],
  [
    new RegExp(`^a redirect from ${HOST} down to (\\S+) on ${HOST}, not followed$`),
    (m) => `una redirección de ${m[1]} que bajaba a ${m[2]} en ${m[3]}, que no se siguió`,
  ],
  [new RegExp(`^a redirect loop at ${HOST}, not followed$`), (m) => `un bucle de redirecciones en ${m[1]}, que no se siguió`],
  [new RegExp(`^more than (\\d+) redirects from ${HOST}, not followed$`), (m) => `más de ${m[1]} redirecciones desde ${m[2]}, que no se siguieron`],
  [new RegExp(`^HTTP (\\d+) from ${HOST}$`), (m) => `HTTP ${m[1]} de ${m[2]}`],
  [
    new RegExp(`^truncated body \\((.*)\\) from ${HOST}$`, "s"),
    (m, inner) => {
      const inside = String(m[1]);
      const counts = /^(\d+) of (\d+) bytes$/.exec(inside);
      return `cuerpo truncado (${counts ? `${counts[1]} de ${counts[2]} bytes` : inner(inside)}) de ${m[2]}`;
    },
  ],
  [new RegExp(`^(.*) instead of a video from ${HOST}$`, "s"), (m, inner) => `${bodyKindEs(String(m[1]), inner)} en lugar de un video, de ${m[2]}`],
  [new RegExp(`^(.*) instead of an image from ${HOST}$`, "s"), (m, inner) => `${bodyKindEs(String(m[1]), inner)} en lugar de una imagen, de ${m[2]}`],
  [/^(.*) instead of a video$/s, (m, inner) => `${bodyKindEs(String(m[1]), inner)} en lugar de un video`],
  [/^(.*) instead of an image$/s, (m, inner) => `${bodyKindEs(String(m[1]), inner)} en lugar de una imagen`],
  [/^not a valid MP4 \((.*)\)$/s, (m) => `no es un MP4 válido (${m[1]})`],
  [
    /^truncated MP4 \((\S+) atom cut short: (\d+) of (\d+) bytes\)$/,
    (m) => `MP4 truncado (el átomo ${m[1]} está cortado: ${m[2]} de ${m[3]} bytes)`,
  ],
  [
    /^truncated MP4 \((\S+) atom cut short: (\d+) bytes left for its header\)$/,
    (m) => `MP4 truncado (el átomo ${m[1]} está cortado: quedan ${m[2]} bytes para su cabecera)`,
  ],
  [/^duration (\S+) s, expected (\S+) s$/, (m) => `dura ${m[1]} s; se esperaban ${m[2]} s`],
  [/^([\d,]+) bytes is above the (\S+) MiB cover limit$/, (m) => `${m[1]} bytes superan el límite de ${m[2]} MiB de una portada`],
  [/^could not write the cover into (the video|.*?\.mp4) \((.*)\)$/s, (m) => `no se pudo escribir la portada en ${m[1]} (${m[2]})`],
  // the pauses (pacing.pauseMessage) and the pacing in force (describePacing / describeBatchPacing)
  [/^pausing (\S+) s$/, (m) => `pausa de ${m[1]} s`],
  [/^resting (\S+) s after (\d+) downloads$/, (m) => `descanso de ${m[1]} s tras ${m[2]} ${plural(String(m[2]), "descarga", "descargas")}`],
  [/^resting (\S+) s before the next series$/, (m) => `descanso de ${m[1]} s antes de la siguiente serie`],
  [/^long break (\S+) min after (\d+) episodes$/, (m) => `descanso prolongado de ${m[1]} min tras ${m[2]} ${plural(String(m[2]), "episodio", "episodios")}`],
  [
    /^(?:human pace \(about one episode's length, at least (\S+) s\) between episodes|(\S+) s between episodes), (?:(\S+) s rest every (\d+)|no long rests); (?:stop after (\d+) (failure|failures) \/ 403 \/ 429|stop on 403 \/ 429)$/,
    (m) => {
      const between =
        m[1] !== undefined
          ? `ritmo humano (más o menos lo que dura un episodio, al menos ${m[1]} s) entre episodios`
          : `${m[2]} s entre episodios`;
      const rest = m[3] !== undefined ? `descanso de ${m[3]} s cada ${m[4]}` : "sin descansos largos";
      const stop =
        m[5] !== undefined
          ? `se detiene tras ${m[5]} ${m[6] === "failure" ? "fallo" : "fallos"} / 403 / 429`
          : "se detiene ante un 403 / 429";
      return `${between}, ${rest}; ${stop}`;
    },
  ],
  [
    /^(\S+) s rest between series(?:, a (\S+) min break every (\d+) episodes)?$/,
    (m) =>
      `descanso de ${m[1]} s entre series` +
      (m[2] === undefined ? "" : `, un descanso prolongado de ${m[2]} min cada ${m[3]} episodios`),
  ],
  // the settings' refusals (pacing.pacingProblem, naming.nameFormatProblem)
  [/^([a-z_]+) must be a number$/, (m, _inner, context) => `${fieldEs(String(m[1]), context)} debe ser un número`],
  [/^([a-z_]+) must be a whole number$/, (m, _inner, context) => `${fieldEs(String(m[1]), context)} debe ser un número entero`],
  [
    /^([a-z_]+)\/([a-z_]+) must not be negative \(got (\S+) and (\S+)\)$/,
    (m, _inner, context) =>
      `${fieldEs(String(m[1]), context)} y ${fieldEs(String(m[2]), context)} no pueden ser negativos (valen ${m[3]} y ${m[4]})`,
  ],
  [
    /^([a-z_]+) \((\S+)\) must be >= ([a-z_]+) \((\S+)\)$/,
    (m, _inner, context) =>
      `${fieldEs(String(m[1]), context)} (${m[2]}) debe ser mayor o igual que ${fieldEs(String(m[3]), context)} (${m[4]})`,
  ],
  [
    new RegExp(String.raw`^([a-z_]+) \((\S+)\) must be at most ${MAX_PAUSE_S} s \(one day\)$`),
    (m, _inner, context) => `${fieldEs(String(m[1]), context)} (${m[2]}) debe ser como máximo ${MAX_PAUSE_S} s (un día)`,
  ],
  [
    /^rest_every\/long_rest_every must not be negative \(0 disables\)$/,
    (_m, _inner, context) =>
      `${fieldEs("rest_every", context)} y ${fieldEs("long_rest_every", context)} no pueden ser negativos (0 los desactiva)`,
  ],
  [
    new RegExp(`^unknown pace (.*): expected one of ${esc(PACES.join(", "))}$`, "s"),
    (m) => `ritmo desconocido ${m[1]}: se esperaba uno de ${PACES.join(", ")}`,
  ],
  [
    /^([a-z_]+) \((\S+)\) must be at least (\S+): pauses may only be made longer$/,
    (m, _inner, context) => `${fieldEs(String(m[1]), context)} (${m[2]}) debe ser al menos ${m[3]}: las pausas solo pueden alargarse`,
  ],
  [
    /^([a-z_]+) \((\S+)\) must be between 1 and (\d+): never less often than the defaults$/,
    (m, _inner, context) =>
      `${fieldEs(String(m[1]), context)} (${m[2]}) debe estar entre 1 y ${m[3]}: nunca con menos frecuencia que la predeterminada`,
  ],
  [
    new RegExp(`^unknown placeholder \\{([^{}]*)\\} in name format (.*): use ${esc(ALLOWED_PLACEHOLDERS)}$`, "s"),
    (m) => `marcador desconocido {${m[1]}} en el formato de nombre ${m[2]}: usa ${ALLOWED_PLACEHOLDERS}`,
  ],
  [
    new RegExp(`^unmatched brace in name format (.*): placeholders are ${esc(ALLOWED_PLACEHOLDERS)}$`, "s"),
    (m) => `llave sin pareja en el formato de nombre ${m[1]}: los marcadores son ${ALLOWED_PLACEHOLDERS}`,
  ],
  [
    /^name format (.*) does not tell episodes apart: use at least one of \{number\}, \{n\}, \{title\} or \{id\}$/s,
    (m) => `el formato de nombre ${m[1]} no distingue los episodios: usa al menos uno de {number}, {n}, {title} o {id}`,
  ],
  // the text box (urls.parseInput, urls.parseSeriesList)
  [
    /^(.*) is a single video, not a series: paste the link of a series \(…\/shortdrama\/episode\/<series id>\/<episode>\)$/s,
    (m) => `${m[1]} es un solo video, no una serie: pega el enlace de una serie (…/shortdrama/episode/<id de la serie>/<episodio>)`,
  ],
  [
    /^Not a TikTok short-drama or video URL: (.*)\. Expected https:\/\/www\.tiktok\.com\/shortdrama\/episode\/<series id>\/<episode> or https:\/\/www\.tiktok\.com\/@user\/video\/<id>\.$/s,
    (m) =>
      `No es un enlace de microdrama ni de video de TikTok: ${m[1]}. Se esperaba ` +
      "https://www.tiktok.com/shortdrama/episode/<id de la serie>/<episodio> o https://www.tiktok.com/@user/video/<id>.",
  ],
  // the episode list (catalog.catalogWarnings, discovery.js)
  [/^episode (-?\d+) missing \(gap\)$/, (m) => `falta el episodio ${m[1]} (hay un hueco)`],
  [/^episodes (-?\d+)-(-?\d+) missing \(gap\)$/, (m) => `faltan los episodios ${m[1]}-${m[2]} (hay un hueco)`],
  [/^duplicate episode number (-?\d+)$/, (m) => `número de episodio repetido: ${m[1]}`],
  [/^TikTok announces (\d+) episodes, (\d+) listed$/, (m) => `TikTok anuncia ${m[1]} episodios, ${m[2]} listados`],
  [/^(\d+) episodes look locked$/, (m) => `${m[1]} episodios parecen bloqueados`],
  [
    /^no episode list within (\S+) s \(page: (.*)\): if this Chrome is not logged in to TikTok, log in in a normal tab and try again$/s,
    (m) =>
      `no llegó ninguna lista de episodios en ${m[1]} s (página: ${m[2]}): si este Chrome no tiene una sesión ` +
      "iniciada en TikTok, inicia sesión en una pestaña normal y vuelve a intentarlo",
  ],
  [
    /^TikTok listed (\d+) items but none belongs to series (\S+) \(is this a short-drama series URL\?\)$/,
    (m) =>
      `TikTok listó ${m[1]} ${plural(String(m[1]), "elemento", "elementos")}, pero ninguno pertenece a la serie ${m[2]} ` +
      "(¿es este el enlace de una serie de microdramas?)",
  ],
  [
    /^pagination stopped at max_pages \((\d+)\); the list may be incomplete$/,
    (m) =>
      `la paginación se detuvo al llegar al máximo de ${m[1]} ${plural(String(m[1]), "página", "páginas")}; puede que ` +
      "la lista esté incompleta",
  ],
];

/**
 * The Spanish of `text`: an exact text, else the first rule that knows it, else `text` itself.
 * @param {string} text
 * @param {Context} context
 * @param {number} depth
 * @returns {string}
 */
function spanish(text, context, depth) {
  if (depth > MAX_DEPTH || text === "") return text;
  const exact = EXACT.get(text);
  if (exact !== undefined) return typeof exact === "function" ? exact(context) : exact;
  const inner = (/** @type {string} */ part) => spanish(part, context, depth + 1);
  for (const [pattern, build] of RULES) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const translated = build(match, inner, context);
    if (translated !== null) return translated;
  }
  return text;
}
