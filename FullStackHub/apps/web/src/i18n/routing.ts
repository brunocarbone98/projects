import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["es", "en"],
  defaultLocale: "es",
  // The roadmap wants explicit /es and /en prefixes on every route.
  localePrefix: "always",
});

export type Locale = (typeof routing.locales)[number];
