// Phase 6 notifications. Best-effort and side-effect only — failures never break
// the request. Email uses Resend when RESEND_API_KEY is set (otherwise it logs);
// an outbound webhook is delivered (HMAC-signed) when WEBHOOK_URL is configured.
import { createHmac } from "node:crypto";

export interface StatusChangeEvent {
  trackingCode: string;
  status: string;
  recipientEmail: string | null;
  trackingUrl: string;
}

export function notifyStatusChange(event: StatusChangeEvent): void {
  // Fire-and-forget: do not await in the request path.
  void Promise.allSettled([sendEmail(event), deliverWebhook(event)]);
}

async function sendEmail(event: StatusChangeEvent): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !event.recipientEmail) {
    console.log(`[notifications] email (noop): ${event.trackingCode} -> ${event.status}`);
    return;
  }
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM ?? "Shipping Hub <noreply@shippinghub.test>",
      to: event.recipientEmail,
      subject: `Update on ${event.trackingCode}: ${event.status}`,
      html: `<p>Your shipment <strong>${event.trackingCode}</strong> is now <strong>${event.status}</strong>.</p><p><a href="${event.trackingUrl}">Track it here</a>.</p>`,
    }),
  });
}

async function deliverWebhook(event: StatusChangeEvent): Promise<void> {
  const url = process.env.WEBHOOK_URL;
  if (!url) return;
  const payload = JSON.stringify({
    type: "shipment.status_changed",
    trackingCode: event.trackingCode,
    status: event.status,
    trackingUrl: event.trackingUrl,
    occurredAt: new Date().toISOString(),
  });
  const secret = process.env.WEBHOOK_SECRET;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) {
    headers["x-shipping-hub-signature"] = createHmac("sha256", secret).update(payload).digest("hex");
  }
  await fetch(url, { method: "POST", headers, body: payload });
}
