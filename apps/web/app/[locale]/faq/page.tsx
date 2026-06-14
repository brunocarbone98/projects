import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card } from "@/components/Card";
import { Container } from "@/components/Container";
import { siteUrl } from "@/lib/config";

interface FaqItem {
  question: string;
  answer: string;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Faq" });
  return {
    title: t("title"),
    description: t("subtitle"),
    alternates: { canonical: `/${locale}/faq` },
  };
}

export default async function FaqPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Faq");
  const items = t.raw("items") as FaqItem[];

  // FAQPage structured data for rich results.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    url: `${siteUrl}/${locale}/faq`,
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };

  return (
    <Container className="py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          {t("title")}
        </h1>
        <p className="mt-3 text-slate-600">{t("subtitle")}</p>

        <div className="mt-10 space-y-4">
          {items.map((item, index) => (
            <Card key={index} className="p-0">
              <details className="group p-5 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer items-center justify-between gap-4 font-medium text-slate-900">
                  {item.question}
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    className="h-5 w-5 shrink-0 text-slate-400 transition group-open:rotate-180"
                  >
                    <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-slate-600">{item.answer}</p>
              </details>
            </Card>
          ))}
        </div>
      </div>
    </Container>
  );
}
