// @ts-check
// Unit tests of src/lib/messages.js: the texts the engine writes and Python's text rules.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DRM_MARK,
  DRM_MESSAGE,
  DRM_REMEMBERED_MESSAGE,
  PAYLOAD_DRM_MESSAGE,
  STATUSES,
  caseless,
  decimalDigitValue,
  isOk,
  isStatus,
  pyDecimalInt,
  pyFormatFixed,
  pyFormatG,
  pyHead,
  pyLen,
  pyNumberText,
  pyRepr,
  pyScalarText,
  pyStrip,
} from "../src/lib/messages.js";

test("every DRM message starts with the DRM mark; the statuses are Python's, in order", () => {
  for (const message of [DRM_MESSAGE, DRM_REMEMBERED_MESSAGE, PAYLOAD_DRM_MESSAGE]) assert.ok(message.startsWith(DRM_MARK));
  assert.equal(DRM_MESSAGE, "protected by DRM (encrypted tracks): DramaFetch does not decrypt it");
  assert.deepEqual(STATUSES, [
    "done",
    "skipped-exists",
    "skipped-locked",
    "dry-run",
    "failed-login-required",
    "failed-unavailable",
    "failed-rate-limited",
    "failed-blocked",
    "failed",
  ]);
  assert.ok(isOk("skipped-locked") && !isOk("failed-unavailable"));
  assert.ok(isStatus("done") && !isStatus("Done") && !isStatus(3));
});

test("Python's strip, repr, number texts and decimal digits", () => {
  assert.equal(pyStrip("\x85\x1c a \ufeff\u3000"), "a \ufeff"); // U+0085 and U+001C go, the BOM stays
  assert.equal(pyRepr("it's"), "\"it's\"");
  assert.equal(pyRepr("a\x07é\u00a0\u200b\"'"), "'a\\x07é\\xa0\\u200b\"\\''");
  assert.equal(pyRepr("\u{1f600}\u{e0001}"), "'\u{1f600}\\U000e0001'");
  assert.equal(pyFormatG(1234567), "1.23457e+06");
  assert.equal(pyFormatG(0.00001), "1e-05");
  assert.equal(pyFormatG(60), "60");
  assert.equal(pyFormatFixed(6.5, 0), "6");
  assert.equal(pyFormatFixed(0.25, 1), "0.2");
  assert.equal(pyNumberText(0.00001), "1e-05");
  assert.equal(pyNumberText(30), "30");
  assert.equal(pyScalarText(true), "True");
  assert.equal(pyDecimalInt("-٣٤"), -34);
  assert.equal(pyDecimalInt("²"), null);
  assert.equal(pyDecimalInt("--1"), null);
  assert.equal(decimalDigitValue("\u{1d7d7}"), 9);
  assert.equal(pyLen("\u{1f600}ab"), 3);
  assert.equal(pyHead("\u{1f600}ab", 2), "\u{1f600}a");
  assert.equal(caseless("\u0130s\u212aEY\u017f\u0131"), "iskeysi");
});
