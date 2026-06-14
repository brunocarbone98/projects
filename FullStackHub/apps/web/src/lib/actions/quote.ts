"use server";

import type { QuoteDto, QuoteRequestInput } from "@shipping-hub/shared";
import { apiUrl } from "@/lib/config";

/** Live quote from the API (which calls the pricing microservice). */
export async function getQuoteAction(input: QuoteRequestInput): Promise<QuoteDto | null> {
  try {
    const res = await fetch(`${apiUrl}/api/v1/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as QuoteDto;
  } catch {
    return null;
  }
}
