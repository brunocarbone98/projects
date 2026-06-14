import type { ServiceLevel } from "@shipping-hub/shared";
import { fetchPricingQuote, type PricingQuote } from "../clients/pricing.js";
import {
  addBusinessDays,
  billableWeightGrams,
  computePriceCents,
  resolveZoneCode,
} from "../domain/pricing.js";
import { badRequest } from "../http/errors.js";
import { prisma } from "../prisma.js";

export interface QuoteInput {
  originCountry: string;
  destinationCountry: string;
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  serviceLevel: ServiceLevel;
}

/**
 * Gets a quote from the pricing microservice, falling back to the local rate
 * table (same math) if the service is unreachable, so shipment creation and the
 * public quoter stay available.
 */
export async function getQuote(input: QuoteInput): Promise<PricingQuote> {
  try {
    return await fetchPricingQuote(input);
  } catch {
    return localQuote(input);
  }
}

async function localQuote(input: QuoteInput): Promise<PricingQuote> {
  const zoneCode = resolveZoneCode(input.destinationCountry);
  const zone = await prisma.zone.findUnique({
    where: { code: zoneCode },
    include: { rates: { where: { serviceLevel: input.serviceLevel } } },
  });
  const rate = zone?.rates[0];
  if (!zone || !rate) {
    throw badRequest(`No rate configured for ${zoneCode}/${input.serviceLevel}`);
  }
  const billable = billableWeightGrams(
    input.weightGrams,
    input.lengthCm,
    input.widthCm,
    input.heightCm,
  );
  return {
    zoneCode,
    serviceLevel: input.serviceLevel,
    billableWeightGrams: billable,
    priceCents: computePriceCents(rate, billable),
    currency: "USD",
    etaMinDays: rate.etaMinDays,
    etaMaxDays: rate.etaMaxDays,
    estimatedDeliveryAt: addBusinessDays(new Date(), rate.etaMaxDays).toISOString(),
  };
}
