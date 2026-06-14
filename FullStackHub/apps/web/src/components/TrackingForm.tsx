"use client";

import { hasTrackingCodeShape } from "@shipping-hub/shared";
import { useState, type FormEvent } from "react";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/cn";
import { primaryButton } from "@/lib/ui";

interface TrackingFormProps {
  placeholder: string;
  buttonLabel: string;
  invalidLabel: string;
  ariaLabel: string;
  autoFocus?: boolean;
}

export function TrackingForm({
  placeholder,
  buttonLabel,
  invalidLabel,
  ariaLabel,
  autoFocus,
}: TrackingFormProps) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = value.trim().toUpperCase();
    if (!hasTrackingCodeShape(code)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    router.push(`/tracking/${code}`);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="w-full">
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          autoFocus={autoFocus}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={invalid}
          spellCheck={false}
          autoCapitalize="characters"
          className={cn(
            "w-full rounded-xl border bg-white px-4 py-3 font-mono text-slate-900 shadow-sm outline-none transition placeholder:font-sans placeholder:text-slate-400 focus:ring-2",
            invalid
              ? "border-rose-300 focus:ring-rose-200"
              : "border-slate-300 focus:border-brand-400 focus:ring-brand-200",
          )}
        />
        <button type="submit" className={cn(primaryButton, "shrink-0")}>
          {buttonLabel}
        </button>
      </div>
      {invalid && <p className="mt-2 text-sm text-rose-600">{invalidLabel}</p>}
    </form>
  );
}
