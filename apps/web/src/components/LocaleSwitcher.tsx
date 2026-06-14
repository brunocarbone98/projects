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

  function switchTo(locale: string) {
    if (locale === activeLocale) return;
    // pathname keeps the resolved route (e.g. /tracking/PTY-...); only the locale changes.
    startTransition(() => {
      router.replace(pathname, { locale });
    });
  }

  return (
    <div
      className={cn(
        "inline-flex rounded-lg border border-slate-200 bg-white p-0.5",
        isPending && "opacity-60",
      )}
      role="group"
      aria-label={t("label")}
    >
      {routing.locales.map((locale) => (
        <button
          key={locale}
          type="button"
          onClick={() => switchTo(locale)}
          aria-current={locale === activeLocale}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-semibold uppercase transition",
            locale === activeLocale
              ? "bg-brand-600 text-white"
              : "text-slate-500 hover:text-slate-800",
          )}
        >
          {locale}
        </button>
      ))}
    </div>
  );
}
