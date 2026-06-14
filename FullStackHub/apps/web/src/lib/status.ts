import type { ShipmentStatus } from "@shipping-hub/shared";

export type StatusTone = "neutral" | "progress" | "positive" | "warning" | "danger";

interface StatusStyle {
  tone: StatusTone;
  badge: string; // classes for the StatusBadge pill
  dot: string; // classes for the Timeline dot
}

const TONE_BADGE: Record<StatusTone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
  progress: "bg-brand-50 text-brand-700 ring-brand-200",
  positive: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warning: "bg-amber-50 text-amber-700 ring-amber-200",
  danger: "bg-rose-50 text-rose-700 ring-rose-200",
};

const TONE_DOT: Record<StatusTone, string> = {
  neutral: "bg-slate-400",
  progress: "bg-brand-500",
  positive: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
};

const STATUS_TONE: Record<ShipmentStatus, StatusTone> = {
  CREATED: "neutral",
  LABEL_PAID: "progress",
  PICKED_UP: "progress",
  IN_TRANSIT: "progress",
  AT_DESTINATION_HUB: "progress",
  OUT_FOR_DELIVERY: "progress",
  DELIVERED: "positive",
  EXCEPTION: "warning",
  RETURNED_TO_SENDER: "danger",
  CANCELLED: "danger",
};

export function statusStyle(status: ShipmentStatus): StatusStyle {
  const tone = STATUS_TONE[status];
  return { tone, badge: TONE_BADGE[tone], dot: TONE_DOT[tone] };
}
