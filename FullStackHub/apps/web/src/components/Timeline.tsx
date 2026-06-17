import type { PublicTrackingEventDto } from "@shipping-hub/shared";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { statusStyle } from "@/lib/status";

export function Timeline({ events }: { events: PublicTrackingEventDto[] }) {
  const t = useTranslations("Status");
  const locale = useLocale();
  // Newest first; the top entry is the current state.
  const ordered = [...events].reverse();

  return (
    <ol className="relative space-y-6">
      {ordered.map((event, index) => {
        const { dot } = statusStyle(event.status);
        const isLatest = index === 0;
        const isLast = index === ordered.length - 1;
        return (
          <li key={`${event.status}-${event.occurredAt}-${index}`} className="relative flex gap-4">
            {!isLast && (
              <span className="absolute left-[7px] top-5 -bottom-6 w-px bg-slate-200" aria-hidden />
            )}
            <span
              className={cn(
                "relative mt-1 h-3.5 w-3.5 shrink-0 rounded-full ring-4 ring-white",
                dot,
                isLatest && "shadow-[0_0_0_4px_rgba(99,102,241,0.15)]",
              )}
              aria-hidden
            />
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className={cn("font-medium text-slate-900", isLatest && "text-brand-700")}>
                  {t(event.status)}
                </p>
                <time className="text-sm text-slate-500" dateTime={event.occurredAt}>
                  {formatDateTime(event.occurredAt, locale)}
                </time>
              </div>
              {event.description && (
                <p className="mt-0.5 text-sm text-slate-600">{event.description}</p>
              )}
              {event.location && <p className="mt-0.5 text-sm text-slate-400">{event.location}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
