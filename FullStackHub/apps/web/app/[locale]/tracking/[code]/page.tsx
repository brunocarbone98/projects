import type { PublicTrackingDto } from "@shipping-hub/shared";
import { hasTrackingCodeShape } from "@shipping-hub/shared";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { cache } from "react";
import { Card } from "@/components/Card";
import { Container } from "@/components/Container";
import { ShareLink } from "@/components/ShareLink";
import { StatusBadge } from "@/components/StatusBadge";
import { Timeline } from "@/components/Timeline";
import { Link } from "@/i18n/navigation";
import { fetchTracking } from "@/lib/api";
import { siteUrl } from "@/lib/config";
import { formatDate } from "@/lib/format";
import { jsonLdString } from "@/lib/jsonld";

type Params = { locale: string; code: string };

type LoadResult =
  | { kind: "ok"; data: PublicTrackingDto }
  | { kind: "not_found" }
  | { kind: "invalid" }
  | { kind: "error" };

// Deduped per request so generateMetadata and the page share a single API call.
const loadTracking = cache(async (code: string): Promise<LoadResult> => {
  // Reject malformed codes before hitting the API.
  if (!hasTrackingCodeShape(code)) return { kind: "invalid" };
  try {
    const data = await fetchTracking(code);
    return data ? { kind: "ok", data } : { kind: "not_found" };
  } catch {
    // Network error or 5xx — distinct from a genuinely missing shipment.
    return { kind: "error" };
  }
});

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { locale, code } = await params;
  const t = await getTranslations({ locale, namespace: "Metadata" });
  const result = await loadTracking(code);

  if (result.kind !== "ok") {
    return { title: t("trackingTitle", { code }), robots: { index: false, follow: true } };
  }

  const { data } = result;
  const tStatus = await getTranslations({ locale, namespace: "Status" });
  const title = t("trackingTitle", { code: data.trackingCode });
  const description = t("trackingDescription", {
    code: data.trackingCode,
    status: tStatus(data.status),
    origin: data.origin.city,
    destination: data.destination.city,
  });
  const path = `/${locale}/tracking/${data.trackingCode}`;

  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", title, description, url: `${siteUrl}${path}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function TrackingResultPage({ params }: { params: Promise<Params> }) {
  const { locale, code } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Tracking.result");
  const result = await loadTracking(code);

  if (result.kind === "error") {
    const tError = await getTranslations("Tracking.error");
    return (
      <Container className="py-16 sm:py-24">
        <Card className="mx-auto max-w-xl p-8 text-center">
          <h1 className="text-2xl font-bold text-slate-900">{tError("title")}</h1>
          <p className="mt-3 text-slate-600">{tError("body")}</p>
        </Card>
      </Container>
    );
  }

  if (result.kind !== "ok") {
    const tNotFound = await getTranslations("Tracking.notFound");
    return (
      <Container className="py-16 sm:py-24">
        <Card className="mx-auto max-w-xl p-8 text-center">
          <h1 className="text-2xl font-bold text-slate-900">{tNotFound("title")}</h1>
          <p className="mt-3 text-slate-600">{tNotFound("body", { code })}</p>
          <Link
            href="/tracking"
            className="mt-6 inline-flex text-sm font-semibold text-brand-700 hover:underline"
          >
            {tNotFound("cta")} →
          </Link>
        </Card>
      </Container>
    );
  }

  const { data } = result;
  const tStatus = await getTranslations("Status");
  const tService = await getTranslations("ServiceLevel");
  const trackingUrl = `${siteUrl}/${locale}/tracking/${data.trackingCode}`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ParcelDelivery",
    trackingNumber: data.trackingCode,
    trackingUrl,
    ...(data.estimatedDeliveryAt ? { expectedArrivalUntil: data.estimatedDeliveryAt } : {}),
    originAddress: {
      "@type": "PostalAddress",
      addressLocality: data.origin.city,
      addressCountry: data.origin.country,
    },
    deliveryAddress: {
      "@type": "PostalAddress",
      addressLocality: data.destination.city,
      addressCountry: data.destination.country,
    },
    provider: { "@type": "Organization", name: "Shipping Hub" },
    deliveryStatus: { "@type": "DeliveryEvent", name: tStatus(data.status) },
  };

  return (
    <Container className="py-12">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(jsonLd) }} />

      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-500">{t("eyebrow")}</p>
            <h1 className="mt-1 font-mono text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              {data.trackingCode}
            </h1>
            <div className="mt-3">
              <StatusBadge status={data.status} />
            </div>
          </div>
          <ShareLink copyLabel={t("share")} copiedLabel={t("shared")} />
        </div>

        <Card className="mt-8 p-6">
          <dl className="grid gap-6 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-slate-500">{t("service")}</dt>
              <dd className="mt-1 font-medium text-slate-900">{tService(data.serviceLevel)}</dd>
            </div>
            <div>
              <dt className="text-sm text-slate-500">{t("estimated")}</dt>
              <dd className="mt-1 font-medium text-slate-900">
                {data.estimatedDeliveryAt
                  ? formatDate(data.estimatedDeliveryAt, locale)
                  : t("noEstimate")}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-slate-500">{t("from")}</dt>
              <dd className="mt-1 font-medium text-slate-900">
                {data.origin.city}, {data.origin.country}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-slate-500">{t("to")}</dt>
              <dd className="mt-1 font-medium text-slate-900">
                {data.destination.city}, {data.destination.country}
              </dd>
            </div>
          </dl>
        </Card>

        <Card className="mt-6 p-6">
          <h2 className="mb-6 text-lg font-semibold text-slate-900">{t("timelineTitle")}</h2>
          <Timeline events={data.events} />
        </Card>

        <div className="mt-8 text-center">
          <Link href="/tracking" className="text-sm font-semibold text-brand-700 hover:underline">
            ← {t("searchAnother")}
          </Link>
        </div>
      </div>
    </Container>
  );
}
