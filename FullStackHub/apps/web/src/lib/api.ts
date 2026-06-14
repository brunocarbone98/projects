import type { PublicTrackingDto } from "@shipping-hub/shared";
import { apiUrl } from "./config";

/**
 * Server-side fetch of a public tracking record.
 * Returns null when the shipment is not found or the code is malformed.
 */
export async function fetchTracking(code: string): Promise<PublicTrackingDto | null> {
  const res = await fetch(`${apiUrl}/api/v1/tracking/${encodeURIComponent(code)}`, {
    // Tracking changes over time — always fetch fresh.
    cache: "no-store",
    headers: { accept: "application/json" },
  });

  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`Tracking request failed with status ${res.status}`);

  return (await res.json()) as PublicTrackingDto;
}
