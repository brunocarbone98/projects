import { useTranslations } from "next-intl";
import { Container } from "@/components/Container";
import { Link } from "@/i18n/navigation";

export default function NotFound() {
  const t = useTranslations("NotFound");
  return (
    <Container className="py-24 text-center">
      <p className="text-6xl font-bold text-brand-600">404</p>
      <h1 className="mt-4 text-2xl font-bold text-slate-900">{t("title")}</h1>
      <p className="mt-2 text-slate-600">{t("body")}</p>
      <Link href="/" className="mt-6 inline-flex text-sm font-semibold text-brand-700 hover:underline">
        {t("home")} →
      </Link>
    </Container>
  );
}
