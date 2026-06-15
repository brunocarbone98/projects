import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card } from "@/components/Card";
import { Container } from "@/components/Container";

// [min, max] transit days per zone & service — mirrors the seeded rate table.
const ETA: Record<string, { express: [number, number]; standard: [number, number]; economy: [number, number] }> = {
  PA: { express: [1, 1], standard: [1, 2], economy: [2, 3] },
  US: { express: [1, 3], standard: [3, 6], economy: [6, 10] },
  LATAM: { express: [2, 4], standard: [4, 8], economy: [8, 14] },
};

const ZONES = ["PA", "US", "LATAM"] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Coverage" });
  return {
    title: t("title"),
    description: t("subtitle"),
    alternates: { canonical: `/${locale}/coverage` },
  };
}

export default async function CoveragePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Coverage");

  const days = (range: [number, number]) => t("table.days", { min: range[0], max: range[1] });

  return (
    <Container className="py-16">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          {t("title")}
        </h1>
        <p className="mt-3 max-w-2xl text-slate-600">{t("subtitle")}</p>

        <Card className="mt-10 overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-5 py-3 font-medium">{t("table.zone")}</th>
                <th className="px-5 py-3 font-medium">{t("table.express")}</th>
                <th className="px-5 py-3 font-medium">{t("table.standard")}</th>
                <th className="px-5 py-3 font-medium">{t("table.economy")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ZONES.map((zone) => (
                <tr key={zone}>
                  <td className="px-5 py-4">
                    <p className="font-medium text-slate-900">{t(`zones.${zone}.name`)}</p>
                    <p className="text-slate-500">{t(`zones.${zone}.countries`)}</p>
                  </td>
                  <td className="px-5 py-4 text-slate-700">{days(ETA[zone].express)}</td>
                  <td className="px-5 py-4 text-slate-700">{days(ETA[zone].standard)}</td>
                  <td className="px-5 py-4 text-slate-700">{days(ETA[zone].economy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="mt-4 text-sm text-slate-500">{t("note")}</p>
      </div>
    </Container>
  );
}
