import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card } from "@/components/Card";
import { Container } from "@/components/Container";
import { TopUpForm } from "@/components/app/TopUpForm";
import { getSession } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { formatDateTime, formatMoney } from "@/lib/format";
import { getWallet } from "@/lib/wallet";

export default async function WalletPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) return null;

  const t = await getTranslations("Wallet");
  const wallet = await getWallet();
  const idempotencyKey = crypto.randomUUID();

  return (
    <Container className="py-10">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("title")}</h1>

      <Card className="mt-6 p-6">
        <p className="text-sm text-slate-500">{t("balance")}</p>
        <p className="mt-1 text-4xl font-bold text-slate-900">
          {formatMoney(wallet.balanceCents, wallet.currency, locale)}
        </p>
        <div className="mt-6">
          <TopUpForm locale={locale} idempotencyKey={idempotencyKey} />
        </div>
      </Card>

      <Card className="mt-6">
        <h2 className="px-6 pt-6 text-lg font-semibold text-slate-900">{t("history")}</h2>
        {wallet.entries.length > 0 ? (
          <table className="mt-4 w-full text-left text-sm">
            <tbody className="divide-y divide-slate-100">
              {wallet.entries.map((entry) => {
                const positive = entry.amountCents >= 0;
                return (
                  <tr key={entry.id}>
                    <td className="px-6 py-3">
                      <p className="font-medium text-slate-900">{t(`kinds.${entry.kind}`)}</p>
                      {entry.description && <p className="text-slate-500">{entry.description}</p>}
                    </td>
                    <td className="px-6 py-3 text-right text-slate-500">
                      {formatDateTime(entry.createdAt, locale)}
                    </td>
                    <td
                      className={cn(
                        "px-6 py-3 text-right font-semibold",
                        positive ? "text-emerald-600" : "text-rose-600",
                      )}
                    >
                      {positive ? "+" : "−"}
                      {formatMoney(Math.abs(entry.amountCents), wallet.currency, locale)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="px-6 py-10 text-center text-sm text-slate-400">{t("empty")}</p>
        )}
      </Card>
    </Container>
  );
}
