// Public site URL (canonical, OpenGraph, sitemap) and internal API base URL.
export const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);

export const apiUrl = (process.env.API_INTERNAL_URL ?? "http://localhost:4000").replace(/\/$/, "");

// A seeded demo code recruiters can paste to see the tracking page instantly.
export const demoTrackingCode = "PTY-2026-001001-0";
