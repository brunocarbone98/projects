import type { ShipmentDto } from "@shipping-hub/shared";
import { useLocale, useTranslations } from "next-intl";
import { StatusBadge } from "@/components/StatusBadge";
import { Link } from "@/i18n/navigation";
import { formatDate, formatMoney } from "@/lib/format";

export function ShipmentsTable({ shipments }: { shipments: ShipmentDto[] }) {
  const t = useTranslations("Shipments.table");
  const tView = useTranslations("Shipments");
  const tService = useTranslations("ServiceLevel");
  const locale = useLocale();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-slate-500">
          <tr>
            <th className="px-4 py-3 font-medium">{t("code")}</th>
            <th className="px-4 py-3 font-medium">{t("status")}</th>
            <th className="px-4 py-3 font-medium">{t("route")}</th>
            <th className="px-4 py-3 font-medium">{t("service")}</th>
            <th className="px-4 py-3 font-medium">{t("created")}</th>
            <th className="px-4 py-3 text-right font-medium">{t("price")}</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {shipments.map((shipment) => (
            <tr key={shipment.id} className="hover:bg-slate-50">
              <td className="px-4 py-3">
                <Link
                  href={`/app/shipments/${shipment.id}`}
                  className="font-mono font-medium text-brand-700 hover:underline"
                >
                  {shipment.trackingCode}
                </Link>
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={shipment.status} size="sm" />
              </td>
              <td className="px-4 py-3 text-slate-600">
                {shipment.origin.country} → {shipment.destination.city},{" "}
                {shipment.destination.country}
              </td>
              <td className="px-4 py-3 text-slate-600">{tService(shipment.serviceLevel)}</td>
              <td className="px-4 py-3 text-slate-600">{formatDate(shipment.createdAt, locale)}</td>
              <td className="px-4 py-3 text-right font-medium text-slate-900">
                {formatMoney(shipment.priceCents, shipment.currency, locale)}
              </td>
              <td className="px-4 py-3 text-right">
                <Link
                  href={`/app/shipments/${shipment.id}`}
                  className="text-sm font-medium text-brand-700 hover:underline"
                >
                  {tView("view")}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
