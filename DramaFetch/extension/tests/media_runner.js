// @ts-check
/**
 * The media parity runner for `tests/test_extension_media.py`: it reads one JSON request on
 * stdin, runs `src/lib/mp4.js` on the files it names and writes one JSON answer on stdout. Node
 * built-ins only; it never opens a socket and writes only the `out` paths a request names.
 *
 * Request: `{"cases": [<case>, ...]}`. Answer: `{"results": [<result>, ...]}`, one per case, in
 * order; a result is `{"value": ...}`, or `{"error": <message>, "type": <class>}` when the call
 * threw. Cases (`path` / `video` / `image` / `out` are file paths; `length`, when given, takes
 * only the first `length` bytes of the file — a truncation without a file of its own):
 *
 * - `{"op": "verify", "path", "expected": <seconds or null>, "length"?}` → `verifyVideo`
 * - `{"op": "drm", "path", "length"?}` → `drmProblem`
 * - `{"op": "probe", "path", "length"?}` → `probe` (`{durationS, hasAudio, audioCodec}`)
 * - `{"op": "atom", "path", "length"?}` → `atomProblem`
 * - `{"op": "body", "path", "contentType"}` → `bodyProblem`
 * - `{"op": "imageKind", "path", "contentType"}` → `imageKind`
 * - `{"op": "imageProblem", "path", "contentType"}` → `imageProblem`
 * - `{"op": "formatSize", "size"}` → `formatSize`
 * - `{"op": "embed", "video", "image", "kind"?, "name"?, "out"}` → `embedCover`, the result
 *   written to `out` (nothing is written when it throws); the value is `{"size": <bytes>}`
 * - `{"op": "extract", "path"}` → `extractCover`: `{"mime", "base64"}` or null
 * - `{"op": "hasCover", "path"}` → `hasEmbeddedCover`
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  atomProblem,
  bodyProblem,
  drmProblem,
  embedCover,
  extractCover,
  formatSize,
  hasEmbeddedCover,
  imageKind,
  imageProblem,
  probe,
  verifyVideo,
} from "../src/lib/mp4.js";

/** @typedef {{op: string, path?: string, length?: number, expected?: number | null, contentType?: string, size?: number, video?: string, image?: string, kind?: string | null, name?: string, out?: string}} Case */

/** @type {Map<string, Uint8Array>} */
const files = new Map();

/**
 * The bytes of a file (read once per run), or their first `length` bytes.
 * @param {string | undefined} path
 * @param {number} [length]
 * @returns {Uint8Array}
 */
function bytesOf(path, length) {
  if (typeof path !== "string") throw new TypeError("a case needs a path");
  let data = files.get(path);
  if (data === undefined) {
    data = new Uint8Array(readFileSync(path));
    files.set(path, data);
  }
  return typeof length === "number" ? data.subarray(0, length) : data;
}

/**
 * @param {Case} item
 * @returns {unknown}
 */
function run(item) {
  switch (item.op) {
    case "verify":
      return verifyVideo(bytesOf(item.path, item.length), item.expected ?? null);
    case "drm":
      return drmProblem(bytesOf(item.path, item.length));
    case "probe":
      return probe(bytesOf(item.path, item.length));
    case "atom":
      return atomProblem(bytesOf(item.path, item.length));
    case "body":
      return bodyProblem(bytesOf(item.path), item.contentType ?? "");
    case "imageKind":
      return imageKind(bytesOf(item.path), item.contentType ?? "");
    case "imageProblem":
      return imageProblem(bytesOf(item.path), item.contentType ?? "");
    case "formatSize":
      return formatSize(Number(item.size));
    case "embed": {
      if (typeof item.out !== "string") throw new TypeError("an embed case needs an out path");
      const embedded = embedCover(bytesOf(item.video), bytesOf(item.image), item.kind ?? null, item.name);
      writeFileSync(item.out, embedded);
      return { size: embedded.length };
    }
    case "extract": {
      const cover = extractCover(bytesOf(item.path));
      return cover === null ? null : { mime: cover.mime, base64: base64Of(cover.data) };
    }
    case "hasCover":
      return hasEmbeddedCover(bytesOf(item.path));
    default:
      throw new TypeError(`unknown op ${JSON.stringify(item.op)}`);
  }
}

/**
 * @param {Uint8Array} data
 * @returns {string}
 */
function base64Of(data) {
  let binary = "";
  for (let start = 0; start < data.length; start += 0x8000) {
    binary += String.fromCharCode(...data.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

function main() {
  const request = /** @type {{cases: Case[]}} */ (JSON.parse(readFileSync(0, "utf8")));
  const results = request.cases.map((item) => {
    try {
      return { value: run(item) };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      return { error: failure.message, type: failure.name };
    }
  });
  writeFileSync(1, JSON.stringify({ results }));
}

main();
