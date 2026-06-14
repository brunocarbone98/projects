import type { ShipmentStatus } from "@shipping-hub/shared";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/cn";
import { statusStyle } from "@/lib/status";

export function StatusBadge({
  status,
  size = "md",
}: {
  status: ShipmentStatus;
  size?: "sm" | "md";
}) {
  const t = useTranslations("Status");
  const { badge, dot } = statusStyle(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset",
        badge,
        size === "sm" ? "px-2.5 py-0.5 text-xs" : "px-3 py-1 text-sm",
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} aria-hidden />
      {t(status)}
    </span>
  );
}
