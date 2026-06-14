// HTTP client for the stateless pricing microservice (services/pricing).
import type { ServiceLevel } from "@shipping-hub/shared";
import { env } from "../env.js";

export interface PricingQuoteRequest {
  originCountry: string;
  destinationCountry: string;
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  serviceLevel: ServiceLevel;
}

export interface PricingQuote {
  zoneCode: string;
  serviceLevel: ServiceLevel;
  billableWeightGrams: number;
  priceCents: number;
  currency: string;
  etaMinDays: number;
  etaMaxDays: number;
  estimatedDeliveryAt: string;
}

export async function fetchPricingQuote(request: PricingQuoteRequest): Promise<PricingQuote> {
  const res = await fetch(`${env.PRICING_SERVICE_URL}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`pricing service responded ${res.status}`);
  return (await res.json()) as PricingQuote;
}
