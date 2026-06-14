"use server";

import { isShipmentStatus } from "@shipping-hub/shared";
import { revalidatePath } from "next/cache";
import { ApiError } from "@/lib/server-api";
import { addTrackingEvent } from "@/lib/shipments";

export interface EventFormState {
  ok?: boolean;
  error?: "invalid" | "unknown";
}

export async function registerEvent(
  locale: string,
  shipmentId: string,
  _prev: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const status = String(formData.get("status") ?? "");
  if (!isShipmentStatus(status)) return { error: "invalid" };

  const location = String(formData.get("location") ?? "").trim() || undefined;
  const description = String(formData.get("description") ?? "").trim() || undefined;

  try {
    await addTrackingEvent(shipmentId, { status, location, description });
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return { error: "invalid" };
    return { error: "unknown" };
  }

  revalidatePath(`/${locale}/app/shipments/${shipmentId}`);
  return { ok: true };
}
