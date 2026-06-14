import { setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardNav } from "@/components/app/DashboardNav";
import { getSession } from "@/lib/auth/session";

// The dashboard renders per-request from the session cookie.
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  return (
    <div>
      <DashboardNav locale={locale} email={session.email} role={session.role} />
      {children}
    </div>
  );
}
