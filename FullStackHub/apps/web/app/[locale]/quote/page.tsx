import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Container } from "@/components/Container";
import { QuoteCalculator } from "@/components/QuoteCalculator";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Quote" });
  return {
    title: t("title"),
    description: t("subtitle"),
    alternates: { canonical: `/${locale}/quote` },
  };
}

export default async function QuotePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Quote");

  return (
    <Container className="py-16">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          {t("title")}
        </h1>
        <p className="mt-3 max-w-2xl text-slate-600">{t("subtitle")}</p>
        <div className="mt-10">
          <QuoteCalculator />
        </div>
      </div>
    </Container>
  );
}
