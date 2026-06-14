// HTTP client for the stateless labels microservice (services/labels).
import { env } from "../env.js";

export interface LabelRequest {
  trackingCode: string;
  serviceLevel: string;
  origin: { city: string; country: string };
  destination: { city: string; country: string };
  weightGrams: number;
  trackingUrl: string;
}

export async function fetchLabelPdf(request: LabelRequest): Promise<Buffer> {
  const res = await fetch(`${env.LABELS_SERVICE_URL}/label`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`labels service responded ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
