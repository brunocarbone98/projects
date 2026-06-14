import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { CreateShipmentWizard } from "@/components/app/CreateShipmentWizard";
import { Container } from "@/components/Container";
import { getSession, isStaff } from "@/lib/auth/session";

export default async function NewShipmentPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) return null;
  // Staff register events rather than create shipments.
  if (isStaff(session.role)) redirect(`/${locale}/app/shipments`);

  const t = await getTranslations("Wizard");

  return (
    <Container className="py-10">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("title")}</h1>
        <CreateShipmentWizard />
      </div>
    </Container>
  );
}
