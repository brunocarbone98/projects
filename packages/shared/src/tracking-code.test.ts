import { describe, expect, it } from "vitest";
import {
  buildTrackingCode,
  hasTrackingCodeShape,
  isValidTrackingCode,
  luhnCheckDigit,
} from "./tracking-code.js";

describe("luhnCheckDigit", () => {
  it("computes a single check digit in [0,9]", () => {
    const digit = luhnCheckDigit("2026000123");
    expect(digit).toBeGreaterThanOrEqual(0);
    expect(digit).toBeLessThanOrEqual(9);
  });

  it("throws on non-numeric input", () => {
    expect(() => luhnCheckDigit("12x4")).toThrow();
  });
});

describe("buildTrackingCode / isValidTrackingCode", () => {
  it("builds a code matching the PTY-YYYY-NNNNNN-C shape", () => {
    expect(buildTrackingCode(2026, 123)).toMatch(/^PTY-2026-000123-\d$/);
  });

  it("round-trips: every built code validates", () => {
    for (let seq = 0; seq < 2000; seq += 7) {
      const code = buildTrackingCode(2026, seq);
      expect(isValidTrackingCode(code)).toBe(true);
    }
  });

  it("rejects a code with a corrupted check digit", () => {
    const code = buildTrackingCode(2026, 123);
    const wrong = Number(code.slice(-1)) === 0 ? "1" : "0";
    const corrupted = code.slice(0, -1) + wrong;
    // Guard against the unlikely case where the swap lands on the real digit.
    if (corrupted !== code) {
      expect(isValidTrackingCode(corrupted)).toBe(false);
    }
  });

  it("rejects malformed input", () => {
    expect(isValidTrackingCode("ABC-2026-000123-4")).toBe(false);
    expect(isValidTrackingCode("PTY-2026-123-4")).toBe(false);
    expect(hasTrackingCodeShape("PTY-2026-000123-4")).toBe(true);
    expect(hasTrackingCodeShape("nope")).toBe(false);
  });
});
