"use server";

import { CreateShipmentSchema } from "@shipping-hub/shared";
import { createShipment } from "@/lib/shipments";

export interface CreateResult {
  ok: boolean;
  id?: string;
}

export async function createShipmentAction(input: unknown): Promise<CreateResult> {
  const parsed = CreateShipmentSchema.safeParse(input);
  if (!parsed.success) return { ok: false };
  try {
    const shipment = await createShipment(parsed.data);
    return { ok: true, id: shipment.id };
  } catch {
    return { ok: false };
  }
}
