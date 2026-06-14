import type { ServiceLevel } from "@shipping-hub/shared";

// Mirrors the seeded rate table in apps/api. The pricing microservice (Phase 4)
// is the source of truth in production; this is a fast client-side estimate.
export const RATES: Record<string, Record<ServiceLevel, [number, number, number, number]>> = {
  PA: { EXPRESS: [800, 150, 1, 1], STANDARD: [500, 100, 1, 2], ECONOMY: [350, 70, 2, 3] },
  US: { EXPRESS: [2500, 600, 1, 3], STANDARD: [1500, 400, 3, 6], ECONOMY: [1000, 250, 6, 10] },
  LATAM: { EXPRESS: [3000, 800, 2, 4], STANDARD: [1800, 500, 4, 8], ECONOMY: [1200, 300, 8, 14] },
};

export function resolveZone(country: string): string {
  const code = country.toUpperCase();
  if (code === "PA") return "PA";
  if (code === "US") return "US";
  return "LATAM";
}

export interface QuoteEstimate {
  zone: string;
  priceCents: number;
  billableKg: number;
  etaMinDays: number;
  etaMaxDays: number;
}

export function estimateQuote(params: {
  destinationCountry: string;
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  serviceLevel: ServiceLevel;
}): QuoteEstimate {
  const zone = resolveZone(params.destinationCountry);
  const [baseCents, perKgCents, etaMinDays, etaMaxDays] = RATES[zone][params.serviceLevel];
  const volumetricGrams = ((params.lengthCm * params.widthCm * params.heightCm) / 5000) * 1000;
  const billableGrams = Math.max(params.weightGrams, volumetricGrams);
  const billableKg = Math.max(1, Math.ceil(billableGrams / 1000));
  return {
    zone,
    priceCents: baseCents + billableKg * perKgCents,
    billableKg,
    etaMinDays,
    etaMaxDays,
  };
}
