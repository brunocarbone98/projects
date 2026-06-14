// Public site URL (canonical, OpenGraph, sitemap).
export const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);

// Internal API base URL used for server-side fetches. Never rendered to the client.
export const apiUrl = (process.env.API_INTERNAL_URL ?? "http://localhost:4000").replace(/\/$/, "");

// Public-facing API URL safe to embed in the browser (e.g. the docs link).
export const publicApiUrl = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(
  /\/$/,
  "",
);

// A seeded demo code recruiters can paste to see the tracking page instantly.
export const demoTrackingCode = "PTY-2026-001001-0";
