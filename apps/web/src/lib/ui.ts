// Shared button class strings for a consistent design system.
const base =
  "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

export const primaryButton = `${base} bg-brand-600 text-white shadow-sm hover:bg-brand-700 focus-visible:outline-brand-600`;

export const secondaryButton = `${base} bg-white text-brand-700 ring-1 ring-inset ring-brand-200 hover:bg-brand-50 focus-visible:outline-brand-600`;

export const ghostButton = `${base} text-slate-700 hover:bg-slate-100 focus-visible:outline-slate-400`;
