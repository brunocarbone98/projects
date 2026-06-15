# projects

Personal monorepo with three folders:

- **[`FullStackHub/`](./FullStackHub)** — **Shipping Hub**: a full-stack international parcel
  shipping & tracking platform (Next.js · Express · PostgreSQL · FastAPI). The real
  distributed system, deployed **live on Railway** as a single container. Docs in
  [`FullStackHub/README.md`](./FullStackHub/README.md) and [`DEPLOY.md`](./DEPLOY.md).
- **[`ShippingHubDemo/`](./ShippingHubDemo)** — the **same Shipping Hub as a static,
  browser-only demo** you can open in one click. All logic runs client-side and data lives
  in `localStorage`, so it hosts as static files on GitHub Pages — no backend required.
- **[`PersonalWebsite/`](./PersonalWebsite)** — static personal / portfolio site.

## Two versions of Shipping Hub

| | [`FullStackHub/`](./FullStackHub) | [`ShippingHubDemo/`](./ShippingHubDemo) |
|---|---|---|
| What it is | The real distributed system | A browser-only simulation of it |
| Stack | Next.js · Express · PostgreSQL · FastAPI | Vanilla ES modules + `localStorage` |
| Hosting | **Railway** (needs a runtime) | **GitHub Pages** (static files) |
| Best for | Showing the architecture | Letting anyone try the UX instantly |
| Live URL | <https://shipping-hub.up.railway.app/> | <https://brunocarbone98.github.io/projects/ShippingHubDemo/> |

The demo reuses the full-stack app's **domain logic** (Luhn tracking codes, the shipment
state machine, zone pricing/ETA) and its **es/en copy**, so it behaves like the real thing
while running entirely in the browser.

**▶ Live app (Railway):** <https://shipping-hub.up.railway.app/>

**▶ Live demo (GitHub Pages):** <https://brunocarbone98.github.io/projects/ShippingHubDemo/>

CI (lint, typecheck, tests) runs against `FullStackHub/` via GitHub Actions
(`.github/workflows/ci.yml`).
