import { nextStatuses } from "@shipping-hub/shared";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Card } from "@/components/Card";
import { Container } from "@/components/Container";
import { RegisterEventForm } from "@/components/app/RegisterEventForm";
import { StatusBadge } from "@/components/StatusBadge";
import { Timeline } from "@/components/Timeline";
import { Link } from "@/i18n/navigation";
import { getSession, isStaff } from "@/lib/auth/session";
import { formatDate, formatMoney } from "@/lib/format";
import { ApiError } from "@/lib/server-api";
import { getShipment } from "@/lib/shipments";

export default async function ShipmentDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) return null;

  let shipment;
  try {
    shipment = await getShipment(id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const staff = isStaff(session.role);
  const t = await getTranslations("ShipmentDetail");
  const tService = await getTranslations("ServiceLevel");

  return (
    <Container className="py-10">
      <Link href="/app/shipments" className="text-sm font-medium text-brand-700 hover:underline">
        ← {t("back")}
      </Link>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-mono text-2xl font-bold tracking-tight text-slate-900">
          {shipment.trackingCode}
        </h1>
        <StatusBadge status={shipment.status} />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-6">
            <dl className="grid gap-5 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-slate-500">{t("service")}</dt>
                <dd className="mt-1 font-medium text-slate-900">{tService(shipment.serviceLevel)}</dd>
              </div>
              <div>
                <dt className="text-sm text-slate-500">{t("estimated")}</dt>
                <dd className="mt-1 font-medium text-slate-900">
                  {shipment.estimatedDeliveryAt
                    ? formatDate(shipment.estimatedDeliveryAt, locale)
                    : t("noEstimate")}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-slate-500">{t("from")}</dt>
                <dd className="mt-1 font-medium text-slate-900">
                  {shipment.origin.city}, {shipment.origin.country}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-slate-500">{t("to")}</dt>
                <dd className="mt-1 font-medium text-slate-900">
                  {shipment.destination.city}, {shipment.destination.country}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-slate-500">{t("price")}</dt>
                <dd className="mt-1 font-medium text-slate-900">
                  {formatMoney(shipment.priceCents, shipment.currency, locale)}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-slate-500">{t("weight")}</dt>
                <dd className="mt-1 font-medium text-slate-900">
                  {(shipment.parcel.weightGrams / 1000).toFixed(2)} kg ·{" "}
                  {shipment.parcel.lengthCm}×{shipment.parcel.widthCm}×{shipment.parcel.heightCm} cm
                </dd>
              </div>
            </dl>
          </Card>

          <Card className="p-6">
            <h2 className="mb-6 text-lg font-semibold text-slate-900">{t("timeline")}</h2>
            <Timeline events={shipment.events} />
          </Card>
        </div>

        {staff && (
          <div className="lg:col-span-1">
            <Card className="p-6">
              <h2 className="mb-4 text-lg font-semibold text-slate-900">
                {t("registerEvent.title")}
              </h2>
              <RegisterEventForm
                locale={locale}
                shipmentId={shipment.id}
                allowedStatuses={nextStatuses(shipment.status)}
              />
            </Card>
          </div>
        )}
      </div>
    </Container>
  );
}
