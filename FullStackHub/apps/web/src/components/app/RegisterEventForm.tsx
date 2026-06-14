"use client";

import type { ShipmentStatus } from "@shipping-hub/shared";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { registerEvent, type EventFormState } from "@/lib/actions/tracking-events";
import { cn } from "@/lib/cn";
import { primaryButton } from "@/lib/ui";

const field =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 shadow-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-200";
const label = "mb-1.5 block text-sm font-medium text-slate-700";

export function RegisterEventForm({
  locale,
  shipmentId,
  allowedStatuses,
}: {
  locale: string;
  shipmentId: string;
  allowedStatuses: readonly ShipmentStatus[];
}) {
  const t = useTranslations("ShipmentDetail.registerEvent");
  const tStatus = useTranslations("Status");
  const action = registerEvent.bind(null, locale, shipmentId);
  const [state, formAction, pending] = useActionState<EventFormState, FormData>(action, {});

  if (allowedStatuses.length === 0) {
    return <p className="text-sm text-slate-500">{t("noTransitions")}</p>;
  }

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="status" className={label}>
          {t("status")}
        </label>
        <select id="status" name="status" required defaultValue={allowedStatuses[0]} className={field}>
          {allowedStatuses.map((status) => (
            <option key={status} value={status}>
              {tStatus(status)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="location" className={label}>
          {t("location")}
        </label>
        <input id="location" name="location" placeholder={t("locationPlaceholder")} className={field} />
      </div>
      <div>
        <label htmlFor="description" className={label}>
          {t("description")}
        </label>
        <input
          id="description"
          name="description"
          placeholder={t("descriptionPlaceholder")}
          className={field}
        />
      </div>

      {state.error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
          {t(state.error === "invalid" ? "errorInvalid" : "errorUnknown")}
        </p>
      )}

      <button type="submit" disabled={pending} className={cn(primaryButton, "w-full")}>
        {pending ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}
