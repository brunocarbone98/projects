import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card } from "@/components/Card";
import { Container } from "@/components/Container";
import { HeroGlobe } from "@/components/HeroGlobe";
import { TrackingForm } from "@/components/TrackingForm";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/cn";
import { demoTrackingCode } from "@/lib/config";
import { accentButton, secondaryButton } from "@/lib/ui";

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Home");
  const tSearch = await getTranslations("Tracking.search");

  const features = [
    { key: "tracking", emoji: "📍" },
    { key: "coverage", emoji: "🌎" },
    { key: "pricing", emoji: "🏷️" },
    { key: "api", emoji: "🧩" },
  ] as const;

  const steps = ["one", "two", "three"] as const;

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-b from-brand-950 via-brand-900 to-brand-800 text-white">
        {/* Animated globe filling the empty right half of the hero. */}
        <div className="pointer-events-none absolute inset-y-0 right-0 z-0 hidden w-[55%] lg:block xl:w-1/2">
          <HeroGlobe />
        </div>
        <Container className="relative z-10 py-20 sm:py-24">
          <div className="max-w-2xl">
            <span className="inline-flex items-center rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-brand-100 ring-1 ring-inset ring-white/15">
              {t("hero.badge")}
            </span>
            <h1 className="mt-5 text-4xl font-extrabold tracking-tight sm:text-5xl">
              {t("hero.title")}
            </h1>
            <p className="mt-4 max-w-xl text-lg text-brand-100">{t("hero.subtitle")}</p>

            <div className="mt-8 max-w-xl">
              <TrackingForm
                placeholder={t("hero.trackPlaceholder")}
                buttonLabel={t("hero.trackButton")}
                invalidLabel={tSearch("invalid")}
                ariaLabel={t("hero.trackLabel")}
                buttonClassName={accentButton}
              />
              <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-brand-200">
                <span>{t("hero.example")}</span>
                <Link
                  href={`/tracking/${demoTrackingCode}`}
                  className="font-mono font-medium text-accent-400 underline-offset-2 hover:underline"
                >
                  {demoTrackingCode}
                </Link>
                <Link href="/quote" className="font-semibold text-accent-400 hover:underline">
                  {t("hero.quoteButton")} →
                </Link>
              </p>
            </div>
          </div>
        </Container>
      </section>

      {/* Features */}
      <section className="py-20">
        <Container>
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">
            {t("features.title")}
          </h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((feature) => (
              <Card key={feature.key} className="p-6">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-xl">
                  {feature.emoji}
                </span>
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
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">{t("steps.title")}</h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-3">
            {steps.map((step, index) => (
              <Card key={step} className="relative p-6">
                <span className="absolute -top-3 left-6 inline-flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">
                  {index + 1}
                </span>
                <h3 className="mt-2 font-semibold text-slate-900">{t(`steps.${step}.title`)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  {t(`steps.${step}.description`)}
                </p>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      {/* CTA */}
      <section className="py-20">
        <Container>
          <div className="rounded-2xl bg-brand-600 px-8 py-12 text-center">
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
