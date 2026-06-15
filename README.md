# projects

Personal monorepo with two folders:

- **[`FullStackHub/`](./FullStackHub)** — **Shipping Hub**: a full-stack international parcel
  shipping & tracking platform (Next.js · Express · PostgreSQL · FastAPI). The real
  distributed system, deployed **live on Railway** as a single container. Docs in
  [`FullStackHub/README.md`](./FullStackHub/README.md) and [`DEPLOY.md`](./DEPLOY.md).
- **[`PersonalWebsite/`](./PersonalWebsite)** — static personal / portfolio site.

**▶ Live app:** <https://shipping-hub.up.railway.app/>

CI (lint, typecheck, tests) runs against `FullStackHub/` via GitHub Actions
(`.github/workflows/ci.yml`).
