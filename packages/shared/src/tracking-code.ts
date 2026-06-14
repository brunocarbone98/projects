// Tracking number format: PTY-YYYY-NNNNNN-C
// where NNNNNN is a zero-padded sequence and C is a Luhn (mod 10) check digit
// computed over the 10-digit payload YYYYNNNNNN. See ROADMAP.md section 4.

export const TRACKING_CODE_PREFIX = "PTY";
export const TRACKING_CODE_REGEX = /^PTY-(\d{4})-(\d{6})-(\d)$/;

/** Luhn (mod 10) check digit for a numeric string payload. */
export function luhnCheckDigit(payload: string): number {
  let sum = 0;
  let double = true; // the rightmost payload digit is doubled
  for (let i = payload.length - 1; i >= 0; i--) {
    let digit = payload.charCodeAt(i) - 48; // '0' === 48
    if (digit < 0 || digit > 9) {
      throw new Error(`luhnCheckDigit: non-digit character in payload "${payload}"`);
    }
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Builds a tracking code from a year and a sequence number.
 * @param year four-digit year, e.g. 2026
 * @param sequence positive integer, rendered as 6 digits (wraps at 1_000_000)
 */
export function buildTrackingCode(year: number, sequence: number): string {
  const yyyy = String(year).padStart(4, "0");
  const nnnnnn = String(sequence % 1_000_000).padStart(6, "0");
  const payload = `${yyyy}${nnnnnn}`;
  return `${TRACKING_CODE_PREFIX}-${yyyy}-${nnnnnn}-${luhnCheckDigit(payload)}`;
}

/** Structural + check-digit validation of a tracking code. */
export function isValidTrackingCode(code: string): boolean {
  const match = TRACKING_CODE_REGEX.exec(code);
  if (!match) return false;
  const [, yyyy, nnnnnn, check] = match;
  return luhnCheckDigit(`${yyyy}${nnnnnn}`) === Number(check);
}

/** True when a code is structurally well-formed, ignoring the check digit. */
export function hasTrackingCodeShape(code: string): boolean {
  return TRACKING_CODE_REGEX.test(code);
}
