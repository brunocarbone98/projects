import type { UserRole } from "@shipping-hub/shared";
import { useTranslations } from "next-intl";
import { Container } from "@/components/Container";
import { Link } from "@/i18n/navigation";
import { logout } from "@/lib/auth/actions";
import { ghostButton } from "@/lib/ui";

export function DashboardNav({
  locale,
  email,
  role,
}: {
  locale: string;
  email: string;
  role: UserRole;
}) {
  const t = useTranslations("Dashboard");
  const isCustomer = role === "CUSTOMER";

  return (
    <div className="border-b border-slate-200 bg-white">
      <Container className="flex flex-wrap items-center justify-between gap-3 py-3">
        <nav className="flex items-center gap-1 text-sm">
          <Link href="/app" className="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100">
            {t("nav.overview")}
          </Link>
          <Link
            href="/app/shipments"
            className="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100"
          >
            {t("nav.shipments")}
          </Link>
          {isCustomer && (
            <Link
              href="/app/shipments/new"
              className="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100"
            >
              {t("nav.newShipment")}
            </Link>
          )}
          {isCustomer && (
            <Link
              href="/app/wallet"
              className="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100"
            >
              {t("nav.wallet")}
            </Link>
          )}
        </nav>

        <div className="flex items-center gap-3 text-sm">
          <span className="hidden text-slate-500 sm:inline">
            {t("signedInAs")} <span className="font-medium text-slate-700">{email}</span>
          </span>
          <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-inset ring-brand-200">
            {t(`roles.${role}`)}
          </span>
          <form action={logout.bind(null, locale)}>
            <button type="submit" className={`${ghostButton} px-3 py-1.5 text-sm`}>
              {t("signOut")}
            </button>
          </form>
        </div>
      </Container>
    </div>
  );
}
