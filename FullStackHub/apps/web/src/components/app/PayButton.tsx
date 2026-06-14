"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { payShipmentAction, type PayState } from "@/lib/actions/wallet";
import { cn } from "@/lib/cn";
import { primaryButton } from "@/lib/ui";

export function PayButton({
  locale,
  shipmentId,
  idempotencyKey,
  amountLabel,
}: {
  locale: string;
  shipmentId: string;
  idempotencyKey: string;
  amountLabel: string;
}) {
  const t = useTranslations("ShipmentDetail");
  const [state, formAction, pending] = useActionState<PayState, FormData>(
    payShipmentAction.bind(null, locale, shipmentId, idempotencyKey),
    {},
  );

  return (
    <form action={formAction}>
      <button type="submit" disabled={pending} className={cn(primaryButton, "py-2")}>
        {pending ? t("paying") : t("pay", { amount: amountLabel })}
      </button>
      {state.error && (
        <p className="mt-2 text-sm text-rose-600" role="alert">
          {t(state.error === "insufficient" ? "payInsufficient" : "payError")}
        </p>
      )}
    </form>
  );
}
