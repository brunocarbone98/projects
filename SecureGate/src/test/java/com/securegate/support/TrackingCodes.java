package com.securegate.support;

/**
 * Tracking-code helpers — a faithful port of Shipping Hub's
 * {@code packages/shared/src/tracking-code.ts} so the suite can build codes the API accepts
 * and codes it must reject.
 *
 * <p>Format {@code PTY-YYYY-NNNNNN-C}, where {@code C} is a Luhn (mod 10) check digit over the
 * 10-digit payload {@code YYYYNNNNNN} (the rightmost payload digit is doubled).
 */
public final class TrackingCodes {

  /** A structurally invalid code (wrong shape), rejected with 400 by the public endpoint. */
  public static final String MALFORMED = "PTY-2026-1-9";

  private TrackingCodes() {}

  /** Luhn (mod 10) check digit for a numeric payload string. */
  public static int luhnCheckDigit(String payload) {
    int sum = 0;
    boolean doubling = true; // the rightmost payload digit is doubled
    for (int i = payload.length() - 1; i >= 0; i--) {
      int digit = payload.charAt(i) - '0';
      if (digit < 0 || digit > 9) {
        throw new IllegalArgumentException("Non-digit character in payload \"" + payload + "\"");
      }
      if (doubling) {
        digit *= 2;
        if (digit > 9) {
          digit -= 9;
        }
      }
      sum += digit;
      doubling = !doubling;
    }
    return (10 - (sum % 10)) % 10;
  }

  /** Builds a valid tracking code (correct check digit) for a year and sequence number. */
  public static String build(int year, int sequence) {
    String yyyy = String.format("%04d", year);
    String nnnnnn = String.format("%06d", Math.floorMod(sequence, 1_000_000));
    return "PTY-" + yyyy + "-" + nnnnnn + "-" + luhnCheckDigit(yyyy + nnnnnn);
  }

  /**
   * A structurally well-formed code whose check digit is deliberately wrong. The public endpoint
   * accepts the shape but finds no shipment, so it answers 404 (never 200).
   */
  public static String withWrongCheckDigit(int year, int sequence) {
    String yyyy = String.format("%04d", year);
    String nnnnnn = String.format("%06d", Math.floorMod(sequence, 1_000_000));
    int correct = luhnCheckDigit(yyyy + nnnnnn);
    int wrong = (correct + 1) % 10;
    return "PTY-" + yyyy + "-" + nnnnnn + "-" + wrong;
  }
}
