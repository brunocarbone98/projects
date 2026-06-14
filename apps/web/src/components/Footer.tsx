import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { apiUrl } from "@/lib/config";
import { Container } from "./Container";
import { Logo } from "./Logo";

export function Footer() {
  const t = useTranslations("Footer");
  const tNav = useTranslations("Nav");
  const year = new Date().getFullYear();

  const product = [
    { href: "/tracking", label: tNav("track") },
    { href: "/quote", label: tNav("quote") },
    { href: "/coverage", label: tNav("coverage") },
    { href: "/faq", label: tNav("faq") },
  ] as const;

  return (
    <footer className="mt-20 border-t border-slate-200 bg-white">
      <Container className="grid gap-8 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <div className="flex items-center gap-2 font-semibold text-slate-900">
            <Logo />
            <span>Shipping Hub</span>
          </div>
          <p className="mt-3 max-w-sm text-sm text-slate-500">{t("tagline")}</p>
          <p className="mt-4 text-xs text-slate-400">{t("builtWith")}</p>
        </div>

        <nav aria-label={t("product")}>
          <h2 className="text-sm font-semibold text-slate-900">{t("product")}</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {product.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="text-slate-500 transition hover:text-slate-900">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <nav aria-label={t("resources")}>
          <h2 className="text-sm font-semibold text-slate-900">{t("resources")}</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <li>
              <a
                href={`${apiUrl}/api/v1/docs`}
                className="text-slate-500 transition hover:text-slate-900"
                rel="noreferrer"
              >
                {t("developers")}
              </a>
            </li>
          </ul>
        </nav>
      </Container>
      <div className="border-t border-slate-100 py-6">
        <Container>
          <p className="text-center text-xs text-slate-400">{t("rights", { year })}</p>
        </Container>
      </div>
    </footer>
  );
}
