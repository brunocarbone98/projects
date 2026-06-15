import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Container } from "./Container";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { Logo } from "./Logo";

export function Header() {
  const t = useTranslations("Nav");
  const links = [
    { href: "/", label: t("home") },
    { href: "/tracking", label: t("track") },
    { href: "/quote", label: t("quote") },
    { href: "/coverage", label: t("coverage") },
    { href: "/faq", label: t("faq") },
  ] as const;

  return (
    <header className="sticky top-0 z-50 border-b border-slate-200/70 bg-white/85 backdrop-blur">
      <Container className="flex items-center justify-between gap-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-bold text-slate-900">
          <Logo />
          <span>Shipping Hub</span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-slate-600 transition hover:text-brand-700"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <LocaleSwitcher />
          <Link
            href="/login"
            className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
          >
            {t("signIn")}
          </Link>
        </div>
      </Container>
    </header>
  );
}
