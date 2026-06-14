"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Link } from "@/i18n/navigation";
import { login, register, type AuthFormState } from "@/lib/auth/actions";
import { cn } from "@/lib/cn";
import { primaryButton } from "@/lib/ui";

const field =
  "w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-slate-900 shadow-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200";
const label = "mb-1.5 block text-sm font-medium text-slate-700";

export function AuthForm({ mode, locale }: { mode: "login" | "register"; locale: string }) {
  const t = useTranslations("Auth");
  const action = (mode === "login" ? login : register).bind(null, locale);
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(action, {});

  return (
    <form action={formAction} className="mt-6 space-y-4">
      {mode === "register" && (
        <div>
          <label htmlFor="name" className={label}>
            {t("register.name")}
          </label>
          <input id="name" name="name" type="text" autoComplete="name" required className={field} />
        </div>
      )}

      <div>
        <label htmlFor="email" className={label}>
          {t(`${mode}.email`)}
        </label>
        <input id="email" name="email" type="email" autoComplete="email" required className={field} />
      </div>

      <div>
        <label htmlFor="password" className={label}>
          {t(`${mode}.password`)}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
          minLength={mode === "register" ? 8 : undefined}
          className={field}
        />
        {mode === "register" && (
          <p className="mt-1 text-xs text-slate-400">{t("register.passwordHint")}</p>
        )}
      </div>

      {state.error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
          {t(`errors.${state.error}`)}
        </p>
      )}

      <button type="submit" disabled={pending} className={cn(primaryButton, "w-full")}>
        {pending ? t(`${mode}.submitting`) : t(`${mode}.submit`)}
      </button>

      <p className="text-center text-sm text-slate-500">
        {mode === "login" ? t("login.noAccount") : t("register.hasAccount")}{" "}
        <Link
          href={mode === "login" ? "/register" : "/login"}
          className="font-semibold text-brand-700 hover:underline"
        >
          {mode === "login" ? t("login.registerLink") : t("register.loginLink")}
        </Link>
      </p>
    </form>
  );
}
