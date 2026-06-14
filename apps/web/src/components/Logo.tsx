import { cn } from "@/lib/cn";

export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white",
        className,
      )}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth={2}>
        <path
          d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9Z"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path d="M3.5 7.5 12 12m0 0 8.5-4.5M12 12v9" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </span>
  );
}
