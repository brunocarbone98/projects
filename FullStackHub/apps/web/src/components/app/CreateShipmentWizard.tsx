"use client";

import { SERVICE_LEVELS, type ServiceLevel } from "@shipping-hub/shared";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { createShipmentAction } from "@/lib/actions/create-shipment";
import { Card } from "@/components/Card";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/format";
import { estimateQuote } from "@/lib/quote-estimate";
import { primaryButton, secondaryButton } from "@/lib/ui";

const COUNTRIES = ["PA", "US", "CO", "MX", "PE", "CL", "CR", "AR", "EC"] as const;
const STEPS = ["addresses", "parcel", "service", "review"] as const;

const field =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 shadow-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-200";
const labelCls = "mb-1.5 block text-sm font-medium text-slate-700";

interface AddressForm {
  contactName: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
}

const emptyAddress = (country: string): AddressForm => ({
  contactName: "",
  line1: "",
  line2: "",
  city: "",
  state: "",
  postalCode: "",
  country,
  phone: "",
});

function toAddressInput(a: AddressForm) {
  return {
    contactName: a.contactName.trim(),
    line1: a.line1.trim(),
    line2: a.line2.trim() || undefined,
    city: a.city.trim(),
    state: a.state.trim() || undefined,
    postalCode: a.postalCode.trim(),
    country: a.country,
    phone: a.phone.trim() || undefined,
  };
}

const isAddressComplete = (a: AddressForm): boolean =>
  Boolean(
    a.contactName.trim() && a.line1.trim() && a.city.trim() && a.postalCode.trim() && a.country,
  );

function AddressFields({
  value,
  onChange,
}: {
  value: AddressForm;
  onChange: (next: AddressForm) => void;
}) {
  const t = useTranslations("Wizard.fields");
  const tCountries = useTranslations("Countries");
  const set =
    (key: keyof AddressForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      onChange({ ...value, [key]: event.target.value });

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label className={labelCls}>{t("contactName")}</label>
        <input value={value.contactName} onChange={set("contactName")} className={field} />
      </div>
      <div>
        <label className={labelCls}>{t("phone")}</label>
        <input value={value.phone} onChange={set("phone")} className={field} />
      </div>
      <div className="sm:col-span-2">
        <label className={labelCls}>{t("line1")}</label>
        <input value={value.line1} onChange={set("line1")} className={field} />
      </div>
      <div className="sm:col-span-2">
        <label className={labelCls}>{t("line2")}</label>
        <input value={value.line2} onChange={set("line2")} className={field} />
      </div>
      <div>
        <label className={labelCls}>{t("city")}</label>
        <input value={value.city} onChange={set("city")} className={field} />
      </div>
      <div>
        <label className={labelCls}>{t("state")}</label>
        <input value={value.state} onChange={set("state")} className={field} />
      </div>
      <div>
        <label className={labelCls}>{t("postalCode")}</label>
        <input value={value.postalCode} onChange={set("postalCode")} className={field} />
      </div>
      <div>
        <label className={labelCls}>{t("country")}</label>
        <select value={value.country} onChange={set("country")} className={field}>
          {COUNTRIES.map((c) => (
            <option key={c} value={c}>
              {tCountries(c)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function CreateShipmentWizard() {
  const t = useTranslations("Wizard");
  const tService = useTranslations("ServiceLevel");
  const locale = useLocale();
  const router = useRouter();

  const [step, setStep] = useState(0);
  const [origin, setOrigin] = useState<AddressForm>(emptyAddress("PA"));
  const [destination, setDestination] = useState<AddressForm>(emptyAddress("US"));
  const [parcel, setParcel] = useState({ weight: "2", length: "30", width: "20", height: "15" });
  const [serviceLevel, setServiceLevel] = useState<ServiceLevel>("EXPRESS");
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();

  const weightGrams = Math.round((Number(parcel.weight) || 0) * 1000);
  const lengthCm = Number(parcel.length) || 0;
  const widthCm = Number(parcel.width) || 0;
  const heightCm = Number(parcel.height) || 0;
  const estimate = estimateQuote({
    destinationCountry: destination.country,
    weightGrams,
    lengthCm,
    widthCm,
    heightCm,
    serviceLevel,
  });

  const canProceed = (() => {
    if (step === 0) return isAddressComplete(origin) && isAddressComplete(destination);
    if (step === 1) return weightGrams > 0 && lengthCm > 0 && widthCm > 0 && heightCm > 0;
    return true;
  })();

  function submit() {
    setError(false);
    const input = {
      origin: toAddressInput(origin),
      destination: toAddressInput(destination),
      serviceLevel,
      parcel: { weightGrams, lengthCm, widthCm, heightCm },
    };
    startTransition(async () => {
      const result = await createShipmentAction(input);
      if (result.ok && result.id) router.push(`/app/shipments/${result.id}`);
      else setError(true);
    });
  }

  return (
    <div className="mt-8">
      {/* Stepper */}
      <ol className="mb-8 flex flex-wrap gap-2 text-sm">
        {STEPS.map((name, index) => (
          <li
            key={name}
            className={cn(
              "flex items-center gap-2 rounded-full px-3 py-1",
              index === step
                ? "bg-brand-600 text-white"
                : index < step
                  ? "bg-brand-50 text-brand-700"
                  : "bg-slate-100 text-slate-500",
            )}
          >
            <span className="font-semibold">{index + 1}</span>
            {t(`steps.${name}`)}
          </li>
        ))}
      </ol>

      <Card className="p-6">
        {step === 0 && (
          <div className="space-y-8">
            <section>
              <h2 className="mb-4 font-semibold text-slate-900">{t("origin")}</h2>
              <AddressFields value={origin} onChange={setOrigin} />
            </section>
            <section>
              <h2 className="mb-4 font-semibold text-slate-900">{t("destination")}</h2>
              <AddressFields value={destination} onChange={setDestination} />
            </section>
          </div>
        )}

        {step === 1 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls}>{t("fields.weight")}</label>
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={parcel.weight}
                onChange={(e) => setParcel({ ...parcel, weight: e.target.value })}
                className={field}
              />
            </div>
            <div className="hidden sm:block" />
            <div>
              <label className={labelCls}>{t("fields.length")}</label>
              <input
                type="number"
                min="1"
                value={parcel.length}
                onChange={(e) => setParcel({ ...parcel, length: e.target.value })}
                className={field}
              />
            </div>
            <div>
              <label className={labelCls}>{t("fields.width")}</label>
              <input
                type="number"
                min="1"
                value={parcel.width}
                onChange={(e) => setParcel({ ...parcel, width: e.target.value })}
                className={field}
              />
            </div>
            <div>
              <label className={labelCls}>{t("fields.height")}</label>
              <input
                type="number"
                min="1"
                value={parcel.height}
                onChange={(e) => setParcel({ ...parcel, height: e.target.value })}
                className={field}
              />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-6 sm:grid-cols-5">
            <div className="sm:col-span-3">
              <label className={labelCls}>{t("fields.serviceLevel")}</label>
              <div className="space-y-2">
                {SERVICE_LEVELS.map((level) => {
                  const q = estimateQuote({
                    destinationCountry: destination.country,
                    weightGrams,
                    lengthCm,
                    widthCm,
                    heightCm,
                    serviceLevel: level,
                  });
                  return (
                    <label
                      key={level}
                      className={cn(
                        "flex cursor-pointer items-center justify-between rounded-xl border px-4 py-3",
                        serviceLevel === level
                          ? "border-brand-400 bg-brand-50"
                          : "border-slate-200 hover:border-slate-300",
                      )}
                    >
                      <span className="flex items-center gap-3">
                        <input
                          type="radio"
                          name="serviceLevel"
                          checked={serviceLevel === level}
                          onChange={() => setServiceLevel(level)}
                        />
                        <span className="font-medium text-slate-900">{tService(level)}</span>
                      </span>
                      <span className="text-right text-sm">
                        <span className="block font-semibold text-slate-900">
                          {formatMoney(q.priceCents, "USD", locale)}
                        </span>
                        <span className="text-slate-500">
                          {t("estimate.etaDays", { min: q.etaMinDays, max: q.etaMaxDays })}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="sm:col-span-2">
              <Card className="bg-slate-50 p-5">
                <p className="text-sm text-slate-500">{t("estimate.title")}</p>
                <p className="mt-1 text-3xl font-bold text-slate-900">
                  {formatMoney(estimate.priceCents, "USD", locale)}
                </p>
                <p className="mt-2 text-sm text-slate-500">
                  {t("estimate.eta")}:{" "}
                  {t("estimate.etaDays", { min: estimate.etaMinDays, max: estimate.etaMaxDays })}
                </p>
                <p className="mt-3 text-xs text-slate-400">{t("estimate.note")}</p>
              </Card>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4 text-sm">
            <h2 className="font-semibold text-slate-900">{t("review.title")}</h2>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">{t("origin")}</dt>
                <dd className="mt-1 text-slate-900">
                  {origin.contactName} — {origin.city}, {origin.country}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("destination")}</dt>
                <dd className="mt-1 text-slate-900">
                  {destination.contactName} — {destination.city}, {destination.country}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("steps.parcel")}</dt>
                <dd className="mt-1 text-slate-900">
                  {t("review.parcelSummary", {
                    weight: parcel.weight,
                    l: lengthCm,
                    w: widthCm,
                    h: heightCm,
                  })}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("steps.service")}</dt>
                <dd className="mt-1 text-slate-900">
                  {tService(serviceLevel)} · {formatMoney(estimate.priceCents, "USD", locale)}
                </dd>
              </div>
            </dl>
            {error && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-rose-700" role="alert">
                {t("error")}
              </p>
            )}
          </div>
        )}

        {/* Controls */}
        <div className="mt-8 flex justify-between">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || pending}
            className={cn(secondaryButton, step === 0 && "invisible")}
          >
            {t("back")}
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s + 1)}
              disabled={!canProceed}
              className={cn(primaryButton, !canProceed && "cursor-not-allowed opacity-50")}
            >
              {t("next")}
            </button>
          ) : (
            <button type="button" onClick={submit} disabled={pending} className={primaryButton}>
              {pending ? t("submitting") : t("submit")}
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}
