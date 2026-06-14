"use client";

import { isServiceLevel, SERVICE_LEVELS, type ServiceLevel } from "@shipping-hub/shared";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Card } from "@/components/Card";
import { getQuoteAction } from "@/lib/actions/quote";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/format";
import { estimateQuote, type QuoteEstimate } from "@/lib/quote-estimate";
import { primaryButton } from "@/lib/ui";

const DESTINATIONS = ["PA", "US", "CO", "MX", "PE", "CL", "CR", "AR", "EC"] as const;

const inputClasses =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 shadow-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-200";

export function QuoteCalculator() {
  const t = useTranslations("Quote");
  const tCountries = useTranslations("Countries");
  const tService = useTranslations("ServiceLevel");
  const locale = useLocale();

  const [country, setCountry] = useState<string>("US");
  const [weight, setWeight] = useState("2");
  const [length, setLength] = useState("30");
  const [width, setWidth] = useState("20");
  const [height, setHeight] = useState("15");
  const [service, setService] = useState<ServiceLevel>("EXPRESS");
  const [result, setResult] = useState<QuoteEstimate | null>(null);
  const [pending, startTransition] = useTransition();

  function calculate() {
    const params = {
      destinationCountry: country,
      weightGrams: Math.round((Number(weight) || 0) * 1000),
      lengthCm: Number(length) || 0,
      widthCm: Number(width) || 0,
      heightCm: Number(height) || 0,
      serviceLevel: service,
    };
    startTransition(async () => {
      // Live quote via the pricing service; fall back to a local estimate.
      const dto = await getQuoteAction({ originCountry: "PA", ...params });
      setResult(
        dto
          ? {
              zone: dto.zoneCode,
              priceCents: dto.priceCents,
              billableKg: Math.max(1, Math.ceil(dto.billableWeightGrams / 1000)),
              etaMinDays: dto.etaMinDays,
              etaMaxDays: dto.etaMaxDays,
            }
          : estimateQuote(params),
      );
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="p-6 lg:col-span-3">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            calculate();
          }}
          className="space-y-4"
        >
          <div>
            <label htmlFor="destination" className="mb-1.5 block text-sm font-medium text-slate-700">
              {t("form.destination")}
            </label>
            <select
              id="destination"
              value={country}
              onChange={(event) => setCountry(event.target.value)}
              className={inputClasses}
            >
              {DESTINATIONS.map((code) => (
                <option key={code} value={code}>
                  {tCountries(code)}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="weight" className="mb-1.5 block text-sm font-medium text-slate-700">
                {t("form.weight")}
              </label>
              <input
                id="weight"
                type="number"
                min="0.1"
                step="0.1"
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
                className={inputClasses}
              />
            </div>
            <div>
              <label htmlFor="service" className="mb-1.5 block text-sm font-medium text-slate-700">
                {t("form.service")}
              </label>
              <select
                id="service"
                value={service}
                onChange={(event) => {
                  if (isServiceLevel(event.target.value)) setService(event.target.value);
                }}
                className={inputClasses}
              >
                {SERVICE_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {tService(level)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <fieldset>
            <legend className="mb-1.5 block text-sm font-medium text-slate-700">
              {t("form.dimensions")}
            </legend>
            <div className="grid grid-cols-3 gap-3">
              <input
                aria-label={t("form.length")}
                type="number"
                min="1"
                value={length}
                onChange={(event) => setLength(event.target.value)}
                className={inputClasses}
              />
              <input
                aria-label={t("form.width")}
                type="number"
                min="1"
                value={width}
                onChange={(event) => setWidth(event.target.value)}
                className={inputClasses}
              />
              <input
                aria-label={t("form.height")}
                type="number"
                min="1"
                value={height}
                onChange={(event) => setHeight(event.target.value)}
                className={inputClasses}
              />
            </div>
          </fieldset>

          <button type="submit" disabled={pending} className={cn(primaryButton, "w-full")}>
            {t("form.calculate")}
          </button>
        </form>
      </Card>

      <div className="lg:col-span-2">
        {result ? (
          <Card className="h-full p-6">
            <p className="text-sm font-medium text-slate-500">{t("result.title")}</p>
            <p className="mt-2 text-4xl font-bold tracking-tight text-slate-900">
              {formatMoney(result.priceCents, "USD", locale)}
            </p>
            <dl className="mt-5 space-y-3 text-sm">
              <div className="flex justify-between border-t border-slate-100 pt-3">
                <dt className="text-slate-500">{t("result.eta")}</dt>
                <dd className="font-medium text-slate-900">
                  {t("result.etaDays", { min: result.etaMinDays, max: result.etaMaxDays })}
                </dd>
              </div>
              <div className="flex justify-between border-t border-slate-100 pt-3">
                <dt className="text-slate-500">{t("result.zone")}</dt>
                <dd className="font-medium text-slate-900">{result.zone}</dd>
              </div>
              <div className="flex justify-between border-t border-slate-100 pt-3">
                <dt className="text-slate-500">{t("result.billable")}</dt>
                <dd className="font-medium text-slate-900">{result.billableKg} kg</dd>
              </div>
            </dl>
            <p className="mt-5 text-xs leading-relaxed text-slate-400">{t("result.disclaimer")}</p>
          </Card>
        ) : (
          <Card className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-400">
            {t("subtitle")}
          </Card>
        )}
      </div>
    </div>
  );
}
