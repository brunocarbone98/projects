import { visitorAddress } from "@shipping-hub/shared";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";

/**
 * The visitor's address as a header for the API. The API trusts X-Forwarded-For only from loopback,
 * which is how this server reaches it, so its rate limits count per visitor instead of for the
 * whole site. The address is the public one Railway's edge puts in X-Real-IP (see
 * `visitorAddress`). Outside a request, or without a public address, there is nothing to forward
 * and the API falls back to its loopback rules.
 */
export async function forwardedFor(): Promise<Record<string, string>> {
  try {
    const visitor = visitorAddress((await headers()).get("x-real-ip"));
    return visitor ? { "x-forwarded-for": visitor } : {};
  } catch (error) {
    unstable_rethrow(error);
    return {};
  }
}
