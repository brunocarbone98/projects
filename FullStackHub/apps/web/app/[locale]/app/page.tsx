import type { UserDto } from "@shipping-hub/shared";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card } from "@/components/Card";
import { Container } from "@/components/Container";
import { ShipmentsTable } from "@/components/app/ShipmentsTable";
import { Link } from "@/i18n/navigation";
import { getSession, isStaff } from "@/lib/auth/session";
import { serverApi } from "@/lib/server-api";
import { listShipments } from "@/lib/shipments";
import { cn } from "@/lib/cn";
import { primaryButton, secondaryButton } from "@/lib/ui";

export default async function OverviewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) return null;

  const t = await getTranslations("Dashboard.overview");
  const staff = isStaff(session.role);
  const [me, recent] = await Promise.all([
    serverApi<{ user: UserDto }>("/api/v1/auth/me"),
    listShipments({ pageSize: 5 }),
  ]);

  return (
    <Container className="py-10">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("title")}</h1>
      <p className="mt-1 text-slate-600">{t("welcome", { name: me.user.name })}</p>
      <p className="text-sm text-slate-500">{staff ? t("staffLead") : t("customerLead")}</p>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Card className="p-6 sm:col-span-1">
          <p className="text-sm text-slate-500">{t("totalShipments")}</p>
          <p className="mt-1 text-3xl font-bold text-slate-900">{recent.total}</p>
        </Card>
        <div className="flex items-center gap-3 sm:col-span-2">
          {!staff && (
            <Link href="/app/shipments/new" className={primaryButton}>
              {t("createCta")}
            </Link>
          )}
          <Link href="/app/shipments" className={cn(secondaryButton)}>
            {t("viewAll")}
          </Link>
        </div>
      </div>

      {recent.data.length > 0 && (
        <Card className="mt-6">
          <ShipmentsTable shipments={recent.data} />
        </Card>
      )}
    </Container>
  );
}
