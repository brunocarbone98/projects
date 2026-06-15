import { cn } from "@/lib/cn";

export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-base leading-none",
        className,
      )}
      aria-hidden
    >
      📦
    </span>
  );
}
