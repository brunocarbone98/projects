import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:.]+$/i;

function isIpAddress(value: string): boolean {
  return IPV4.test(value) || (value.includes(":") && IPV6.test(value));
}

/**
 * The visitor's address as a header for the API. Railway's proxy, in front of this server, puts it in
 * X-Forwarded-For; the right-most entry is the address the proxy saw, so a visitor cannot forge it.
 * The API trusts the header only from loopback, which is how this server reaches it, so its rate
 * limits count per visitor instead of for the whole site. Outside a request, or without a usable
 * address, there is nothing to forward and the API falls back to its loopback rules.
 */
export async function forwardedFor(): Promise<Record<string, string>> {
  try {
    const chain = (await headers()).get("x-forwarded-for") ?? "";
    const visitor =
      chain
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .at(-1) ?? "";
    return isIpAddress(visitor) ? { "x-forwarded-for": visitor } : {};
  } catch (error) {
    unstable_rethrow(error);
    return {};
  }
}
