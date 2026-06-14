import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Container } from "@/components/Container";
import { TrackingForm } from "@/components/TrackingForm";
import { Link } from "@/i18n/navigation";
import { demoTrackingCode } from "@/lib/config";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Tracking.search" });
  return {
    title: t("title"),
    description: t("subtitle"),
    alternates: { canonical: `/${locale}/tracking` },
  };
}

export default async function TrackingSearchPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Tracking.search");

  return (
    <Container className="py-16 sm:py-24">
      <div className="mx-auto max-w-xl text-center">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          {t("title")}
        </h1>
        <p className="mt-3 text-slate-600">{t("subtitle")}</p>
        <div className="mt-8">
          <TrackingForm
            autoFocus
            placeholder={t("placeholder")}
            buttonLabel={t("button")}
            invalidLabel={t("invalid")}
            ariaLabel={t("title")}
          />
        </div>
        <p className="mt-3 text-sm text-slate-500">
          {t("example")}{" "}
          <Link
            href={`/tracking/${demoTrackingCode}`}
            className="font-mono font-medium text-brand-700 underline-offset-2 hover:underline"
          >
            {demoTrackingCode}
          </Link>
        </p>
      </div>
    </Container>
  );
}
