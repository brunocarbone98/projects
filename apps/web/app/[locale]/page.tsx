import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { Card } from "@/components/Card";
import { Container } from "@/components/Container";
import { TrackingForm } from "@/components/TrackingForm";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/cn";
import { demoTrackingCode } from "@/lib/config";
import { secondaryButton } from "@/lib/ui";

function FeatureIcon({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
        {children}
      </svg>
    </span>
  );
}

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Home");
  const tSearch = await getTranslations("Tracking.search");

  const features = [
    {
      key: "tracking",
      icon: (
        <path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 1 1 18 0Z M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" strokeLinejoin="round" />
      ),
    },
    {
      key: "coverage",
      icon: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" strokeLinejoin="round" />,
    },
    {
      key: "pricing",
      icon: <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" strokeLinecap="round" />,
    },
    {
      key: "api",
      icon: <path d="m8 9-4 3 4 3m8-6 4 3-4 3M14 5l-4 14" strokeLinecap="round" strokeLinejoin="round" />,
    },
  ] as const;

  const steps = ["one", "two", "three"] as const;

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-slate-200 bg-gradient-to-b from-brand-50/60 to-slate-50">
        <Container className="py-20 sm:py-24">
          <div className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center rounded-full bg-white px-3 py-1 text-xs font-medium text-brand-700 ring-1 ring-inset ring-brand-200">
              {t("hero.badge")}
            </span>
            <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
              {t("hero.title")}
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-pretty text-lg text-slate-600">
              {t("hero.subtitle")}
            </p>

            <div className="mx-auto mt-8 max-w-xl">
              <TrackingForm
                placeholder={t("hero.trackPlaceholder")}
                buttonLabel={t("hero.trackButton")}
                invalidLabel={tSearch("invalid")}
                ariaLabel={t("hero.trackLabel")}
              />
              <p className="mt-3 text-sm text-slate-500">
                {t("hero.example")}{" "}
                <Link
                  href={`/tracking/${demoTrackingCode}`}
                  className="font-mono font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  {demoTrackingCode}
                </Link>
              </p>
            </div>
          </div>
        </Container>
      </section>

      {/* Features */}
      <section className="py-20">
        <Container>
          <h2 className="text-center text-3xl font-bold tracking-tight text-slate-900">
            {t("features.title")}
          </h2>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((feature) => (
              <Card key={feature.key} className="p-6">
                <FeatureIcon>{feature.icon}</FeatureIcon>
                <h3 className="mt-4 font-semibold text-slate-900">
                  {t(`features.${feature.key}.title`)}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  {t(`features.${feature.key}.description`)}
                </p>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      {/* Steps */}
      <section className="border-y border-slate-200 bg-white py-20">
        <Container>
          <h2 className="text-center text-3xl font-bold tracking-tight text-slate-900">
            {t("steps.title")}
          </h2>
          <ol className="mt-12 grid gap-8 sm:grid-cols-3">
            {steps.map((step, index) => (
              <li key={step} className="relative">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 font-semibold text-white">
                  {index + 1}
                </span>
                <h3 className="mt-4 font-semibold text-slate-900">{t(`steps.${step}.title`)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  {t(`steps.${step}.description`)}
                </p>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      {/* CTA */}
      <section className="py-20">
        <Container>
          <div className="rounded-3xl bg-brand-600 px-8 py-14 text-center">
            <h2 className="text-3xl font-bold tracking-tight text-white">{t("cta.title")}</h2>
            <p className="mx-auto mt-3 max-w-xl text-brand-100">{t("cta.subtitle")}</p>
            <Link href="/tracking" className={cn(secondaryButton, "mt-8")}>
              {t("cta.button")}
            </Link>
          </div>
        </Container>
      </section>
    </>
  );
}
