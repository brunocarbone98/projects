"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { cn } from "@/lib/cn";

export function LocaleSwitcher() {
  const activeLocale = useLocale();
  const t = useTranslations("Locale");
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  // Single toggle that flips to the other locale.
  const other = routing.locales.find((locale) => locale !== activeLocale) ?? activeLocale;

  function switchTo(locale: string) {
    // pathname keeps the resolved route (e.g. /tracking/PTY-...); only the locale changes.
    startTransition(() => {
      router.replace(pathname, { locale });
    });
  }

  return (
    <button
      type="button"
      onClick={() => switchTo(other)}
      aria-label={t("label")}
      className={cn(
        "rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold uppercase text-slate-600 transition hover:bg-slate-50",
        isPending && "opacity-60",
      )}
    >
      {other}
    </button>
  );
}
