import { isShipmentStatus, SHIPMENT_STATUSES } from "@shipping-hub/shared";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card } from "@/components/Card";
import { Container } from "@/components/Container";
import { ShipmentsTable } from "@/components/app/ShipmentsTable";
import { Link } from "@/i18n/navigation";
import { getSession, isStaff } from "@/lib/auth/session";
import { listShipments } from "@/lib/shipments";
import { primaryButton } from "@/lib/ui";

export default async function ShipmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) return null;

  const sp = await searchParams;
  const rawStatus = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status = rawStatus && isShipmentStatus(rawStatus) ? rawStatus : undefined;

  const staff = isStaff(session.role);
  const t = await getTranslations("Shipments");
  const tStatus = await getTranslations("Status");
  const data = await listShipments({ status, pageSize: 50 });

  return (
    <Container className="py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            {staff ? t("allTitle") : t("mineTitle")}
          </h1>
          <p className="text-sm text-slate-500">{t("resultCount", { count: data.total })}</p>
        </div>
        {!staff && (
          <Link href="/app/shipments/new" className={primaryButton}>
            {t("newShipment")}
          </Link>
        )}
      </div>

      <form method="get" className="mt-6 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="status" className="mb-1.5 block text-sm font-medium text-slate-700">
            {t("search.statusLabel")}
          </label>
          <select
            id="status"
            name="status"
            defaultValue={status ?? ""}
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-200"
          >
            <option value="">{t("search.all")}</option>
            {SHIPMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {tStatus(s)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
        >
          {t("search.apply")}
        </button>
      </form>

      <Card className="mt-6">
        {data.data.length > 0 ? (
          <ShipmentsTable shipments={data.data} />
        ) : (
          <p className="px-6 py-10 text-center text-sm text-slate-400">{t("empty")}</p>
        )}
      </Card>
    </Container>
  );
}
