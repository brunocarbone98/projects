"use server";

import { revalidatePath } from "next/cache";
import { ApiError, serverApi } from "@/lib/server-api";

export interface TopUpState {
  ok?: boolean;
  error?: "invalid" | "unknown";
}

export async function topUpAction(
  locale: string,
  _prev: TopUpState,
  formData: FormData,
): Promise<TopUpState> {
  const amount = Number(formData.get("amount"));
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "");
  if (!amount || amount <= 0 || !idempotencyKey) return { error: "invalid" };

  try {
    await serverApi("/api/v1/wallet/topup", {
      method: "POST",
      body: JSON.stringify({ amountCents: Math.round(amount * 100), idempotencyKey }),
    });
  } catch {
    return { error: "unknown" };
  }
  revalidatePath(`/${locale}/app/wallet`);
  return { ok: true };
}

export interface PayState {
  ok?: boolean;
  error?: "insufficient" | "unknown";
}

export async function payShipmentAction(
  locale: string,
  shipmentId: string,
  idempotencyKey: string,
  _prev: PayState,
  _formData: FormData,
): Promise<PayState> {
  try {
    await serverApi(`/api/v1/shipments/${shipmentId}/pay`, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "INSUFFICIENT_FUNDS") {
      return { error: "insufficient" };
    }
    return { error: "unknown" };
  }
  revalidatePath(`/${locale}/app/shipments/${shipmentId}`);
  return { ok: true };
}
