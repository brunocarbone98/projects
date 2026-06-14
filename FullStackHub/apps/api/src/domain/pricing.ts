// Pure pricing + ETA helpers. In Phase 4 a Python microservice takes over
// quoting; until then the API derives price and ETA from the seeded rate table.
import type { ServiceLevel } from "@shipping-hub/shared";

/** Maps a destination country (ISO alpha-2) to a rate zone. Origin is Panama. */
export function resolveZoneCode(country: string): string {
  const c = country.toUpperCase();
  if (c === "PA") return "PA";
  if (c === "US") return "US";
  return "LATAM";
}

/** Volumetric weight in grams using the standard 5000 cm³/kg divisor. */
export function volumetricWeightGrams(lengthCm: number, widthCm: number, heightCm: number): number {
  return Math.round(((lengthCm * widthCm * heightCm) / 5000) * 1000);
}

export function billableWeightGrams(
  actualGrams: number,
  lengthCm: number,
  widthCm: number,
  heightCm: number,
): number {
  return Math.max(actualGrams, volumetricWeightGrams(lengthCm, widthCm, heightCm));
}

export interface RateLike {
  serviceLevel: ServiceLevel;
  baseCents: number;
  perKgCents: number;
  etaMinDays: number;
  etaMaxDays: number;
}

/** Price = base + ceil(billable kg) * perKg. Minimum one chargeable kilo. */
export function computePriceCents(rate: RateLike, billableGrams: number): number {
  const chargeableKg = Math.max(1, Math.ceil(billableGrams / 1000));
  return rate.baseCents + chargeableKg * rate.perKgCents;
}

/** Adds N business days (Mon–Fri) to a date. Holidays arrive with Phase 4. */
export function addBusinessDays(start: Date, days: number): Date {
  const result = new Date(start.getTime());
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const weekday = result.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return result;
}
