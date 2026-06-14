"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { topUpAction, type TopUpState } from "@/lib/actions/wallet";
import { cn } from "@/lib/cn";
import { primaryButton } from "@/lib/ui";

export function TopUpForm({ locale, idempotencyKey }: { locale: string; idempotencyKey: string }) {
  const t = useTranslations("Wallet");
  const [state, formAction, pending] = useActionState<TopUpState, FormData>(
    topUpAction.bind(null, locale),
    {},
  );

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div>
        <label htmlFor="amount" className="mb-1.5 block text-sm font-medium text-slate-700">
          {t("amount")}
        </label>
        <input
          id="amount"
          name="amount"
          type="number"
          min="1"
          step="1"
          defaultValue="50"
          className="w-36 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 shadow-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-200"
        />
      </div>
      <button type="submit" disabled={pending} className={cn(primaryButton, "py-2.5")}>
        {pending ? t("adding") : t("addFunds")}
      </button>
      {state.error && (
        <p className="w-full text-sm text-rose-600" role="alert">
          {t(state.error === "invalid" ? "invalidAmount" : "error")}
        </p>
      )}
    </form>
  );
}
