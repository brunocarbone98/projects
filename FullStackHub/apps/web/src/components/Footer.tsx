import { useTranslations } from "next-intl";
import { Container } from "./Container";

export function Footer() {
  const t = useTranslations("Footer");
  const year = new Date().getFullYear();

  return (
    <footer className="mt-16 border-t border-slate-200 bg-white">
      <Container className="py-8 text-sm text-slate-500">
        <div className="flex flex-col items-start justify-between gap-3 md:flex-row md:items-center">
          <div>
            <p className="font-semibold text-slate-700">Shipping Hub</p>
            <p>{t("tagline")}</p>
          </div>
          <div className="text-left md:text-right">
            <p>{t("rights", { year })}</p>
            <p className="text-xs text-slate-400">{t("builtWith")}</p>
          </div>
        </div>
      </Container>
    </footer>
  );
}
