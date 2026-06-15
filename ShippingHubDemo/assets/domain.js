// Pure domain logic for the static demo — a faithful, dependency-free port of
// FullStackHub/packages/shared (tracking codes, enums, the shipment state
// machine) and FullStackHub/services/pricing (zone pricing + business-day ETA).
// Keeping the maths identical means the demo behaves like the real backend.

/* ------------------------------------------------------------------ enums -- */

export const USER_ROLES = ["CUSTOMER", "COURIER", "ADMIN"];
export const SERVICE_LEVELS = ["EXPRESS", "STANDARD", "ECONOMY"];
export const SHIPMENT_STATUSES = [
  "CREATED",
  "LABEL_PAID",
  "PICKED_UP",
  "IN_TRANSIT",
  "AT_DESTINATION_HUB",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "EXCEPTION",
  "RETURNED_TO_SENDER",
  "CANCELLED",
];
export const LEDGER_KINDS = ["TOPUP", "PAYMENT", "REVERSAL"];

/* --------------------------------------------------------- tracking codes -- */

export const TRACKING_CODE_PREFIX = "PTY";
export const TRACKING_CODE_REGEX = /^PTY-(\d{4})-(\d{6})-(\d)$/;

/** Luhn (mod 10) check digit for a numeric string payload. */
export function luhnCheckDigit(payload) {
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

/** Build a tracking code from a year and a sequence number. */
export function buildTrackingCode(year, sequence) {
  const yyyy = String(year).padStart(4, "0");
  const nnnnnn = String(sequence % 1_000_000).padStart(6, "0");
  return `${TRACKING_CODE_PREFIX}-${yyyy}-${nnnnnn}-${luhnCheckDigit(`${yyyy}${nnnnnn}`)}`;
}

/** Structural + check-digit validation of a tracking code. */
export function isValidTrackingCode(code) {
  const match = TRACKING_CODE_REGEX.exec(code);
  if (!match) return false;
  const [, yyyy, nnnnnn, check] = match;
  return luhnCheckDigit(`${yyyy}${nnnnnn}`) === Number(check);
}

/** True when a code is structurally well-formed, ignoring the check digit. */
export function hasTrackingCodeShape(code) {
  return TRACKING_CODE_REGEX.test(code);
}

/* ----------------------------------------------------- state transitions -- */

export const SHIPMENT_TRANSITIONS = {
  CREATED: ["LABEL_PAID", "CANCELLED"],
  LABEL_PAID: ["PICKED_UP", "CANCELLED"],
  PICKED_UP: ["IN_TRANSIT", "EXCEPTION"],
  IN_TRANSIT: ["AT_DESTINATION_HUB", "EXCEPTION"],
  AT_DESTINATION_HUB: ["OUT_FOR_DELIVERY", "EXCEPTION"],
  OUT_FOR_DELIVERY: ["DELIVERED", "EXCEPTION"],
  EXCEPTION: ["IN_TRANSIT", "OUT_FOR_DELIVERY", "RETURNED_TO_SENDER"],
  DELIVERED: [],
  RETURNED_TO_SENDER: [],
  CANCELLED: [],
};

export function canTransition(from, to) {
  return SHIPMENT_TRANSITIONS[from].includes(to);
}

export function nextStatuses(from) {
  return SHIPMENT_TRANSITIONS[from] ?? [];
}

export function isTerminalStatus(status) {
  return (SHIPMENT_TRANSITIONS[status] ?? []).length === 0;
}

/* ------------------------------------------------------------- pricing ---- */

// [baseCents, perKgCents, etaMinDays, etaMaxDays] per zone & service level.
// Mirrors RATES in apps/api/prisma/reference.ts / services/pricing exactly.
export const RATES = {
  PA: {
    EXPRESS: [800, 150, 1, 1],
    STANDARD: [500, 100, 1, 2],
    ECONOMY: [350, 70, 2, 3],
  },
  US: {
    EXPRESS: [2500, 600, 1, 3],
    STANDARD: [1500, 400, 3, 6],
    ECONOMY: [1000, 250, 6, 10],
  },
  LATAM: {
    EXPRESS: [3000, 800, 2, 4],
    STANDARD: [1800, 500, 4, 8],
    ECONOMY: [1200, 300, 8, 14],
  },
};

/** Map a destination country (ISO alpha-2) to a rate zone. Origin is Panama. */
export function resolveZoneCode(destinationCountry) {
  const country = String(destinationCountry).toUpperCase();
  if (country === "PA") return "PA";
  if (country === "US") return "US";
  return "LATAM";
}

/** Volumetric weight in grams using the standard 5000 cm3/kg divisor. */
export function volumetricWeightGrams(lengthCm, widthCm, heightCm) {
  return Math.round(((lengthCm * widthCm * heightCm) / 5000) * 1000);
}

/** The greater of the actual weight and the volumetric weight, in grams. */
export function billableWeightGrams(actualGrams, lengthCm, widthCm, heightCm) {
  return Math.max(actualGrams, volumetricWeightGrams(lengthCm, widthCm, heightCm));
}

/** Chargeable kilograms: billable grams rounded up, with a one-kilo minimum. */
export function chargeableKg(billableGrams) {
  return Math.max(1, Math.ceil(billableGrams / 1000));
}

/** Price = base + ceil(billable kg) * perKg, with a minimum of one kilo. */
export function computePriceCents(baseCents, perKgCents, billableGrams) {
  return baseCents + chargeableKg(billableGrams) * perKgCents;
}

/* --------------------------------------------------- business-day ETA ----- */

function ymd(date) {
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
}

// Monday=0 … Sunday=6 (Python's date.weekday convention).
function pyWeekday(date) {
  return (date.getUTCDay() + 6) % 7;
}

function nthWeekdayOfMonth(year, month1, weekday, n) {
  const first = new Date(Date.UTC(year, month1 - 1, 1));
  const offset = ((weekday - pyWeekday(first)) % 7 + 7) % 7;
  return new Date(Date.UTC(year, month1 - 1, 1 + offset + (n - 1) * 7));
}

function panamaHolidays(year) {
  return new Set(
    [
      [1, 1],
      [1, 9],
      [11, 3],
      [11, 4],
      [11, 5],
      [11, 10],
      [11, 28],
      [12, 8],
      [12, 25],
    ].map(([m, d]) => `${year}-${m}-${d}`),
  );
}

function usHolidays(year) {
  const thanksgiving = nthWeekdayOfMonth(year, 11, 3, 4); // 4th Thursday of Nov
  return new Set([
    `${year}-1-1`,
    `${year}-7-4`,
    ymd(thanksgiving),
    `${year}-12-25`,
  ]);
}

function isHoliday(date, destinationCountry) {
  const year = date.getUTCFullYear();
  if (panamaHolidays(year).has(ymd(date))) return true;
  if (String(destinationCountry).toUpperCase() === "US" && usHolidays(year).has(ymd(date))) {
    return true;
  }
  return false;
}

function isBusinessDay(date, destinationCountry) {
  if (pyWeekday(date) >= 5) return false; // Saturday or Sunday
  return !isHoliday(date, destinationCountry);
}

/** Add `days` business days to `start`, skipping weekends and holidays. */
export function addBusinessDays(start, days, destinationCountry) {
  const result = new Date(start.getTime());
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (isBusinessDay(result, destinationCountry)) remaining -= 1;
  }
  return result;
}

/** Compute a complete quote for the given parcel parameters. */
export function computeQuote({
  destinationCountry,
  weightGrams,
  lengthCm,
  widthCm,
  heightCm,
  serviceLevel,
  now = new Date(),
}) {
  const zoneCode = resolveZoneCode(destinationCountry);
  const [baseCents, perKgCents, etaMinDays, etaMaxDays] = RATES[zoneCode][serviceLevel];
  const billable = billableWeightGrams(weightGrams, lengthCm, widthCm, heightCm);
  return {
    zoneCode,
    serviceLevel,
    billableWeightGrams: billable,
    priceCents: computePriceCents(baseCents, perKgCents, billable),
    currency: "USD",
    etaMinDays,
    etaMaxDays,
    estimatedDeliveryAt: addBusinessDays(now, etaMaxDays, destinationCountry),
  };
}

/* -------------------------------------------------------------- ledger ---- */

/** Wallet balance is the sum of append-only ledger entries — never stored. */
export function balanceOfCents(entries) {
  return entries.reduce((sum, entry) => sum + entry.amountCents, 0);
}
