import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/AuthForm";
import { Card } from "@/components/Card";
import { Container } from "@/components/Container";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Auth.login" });
  return { title: t("title"), robots: { index: false, follow: false } };
}

export default async function LoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (await getSession()) redirect(`/${locale}/app`);
  const t = await getTranslations("Auth.login");

  return (
    <Container className="py-16 sm:py-24">
      <div className="mx-auto max-w-md">
        <Card className="p-8">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("title")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("subtitle")}</p>
          <AuthForm mode="login" locale={locale} />
        </Card>
      </div>
    </Container>
  );
}
