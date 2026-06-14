"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { ghostButton } from "@/lib/ui";

export function ShareLink({ copyLabel, copiedLabel }: { copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — silently ignore.
    }
  }

  return (
    <button type="button" onClick={copy} className={cn(ghostButton, "py-2 text-sm")}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
        {copied ? (
          <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path
            d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1m-1 8a5 5 0 0 1-7 0 5 5 0 0 1 0-7l2-2a5 5 0 0 1 7 0"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
      {copied ? copiedLabel : copyLabel}
    </button>
  );
}
