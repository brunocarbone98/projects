import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/cn";
import { secondaryButton } from "@/lib/ui";
import { Container } from "./Container";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { Logo } from "./Logo";

export function Header() {
  const t = useTranslations("Nav");
  const links = [
    { href: "/tracking", label: t("track") },
    { href: "/quote", label: t("quote") },
    { href: "/coverage", label: t("coverage") },
    { href: "/faq", label: t("faq") },
  ] as const;

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur">
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2 font-semibold text-slate-900">
          <Logo />
          <span>Shipping Hub</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-lg px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <LocaleSwitcher />
          <Link href="/tracking" className={cn(secondaryButton, "hidden py-2 sm:inline-flex")}>
            {t("trackCta")}
          </Link>
        </div>
      </Container>
    </header>
  );
}
