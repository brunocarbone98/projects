# projects

Personal monorepo with three folders:

- **[`FullStackHub/`](./FullStackHub)** — **Shipping Hub**: a full-stack international parcel
  shipping & tracking platform (Next.js · Express · PostgreSQL · FastAPI). The real
  distributed system, deployed **live on Railway** as a single container. Docs in
  [`FullStackHub/README.md`](./FullStackHub/README.md) and [`DEPLOY.md`](./DEPLOY.md).
- **[`SecureGate/`](./SecureGate)** — an automated **QA & security test suite** that tests
  Shipping Hub end to end (Java · Karate · Serenity Screenplay · Selenium · Cucumber, in CI). Roadmap in
  [`SecureGate/ROADMAP.md`](./SecureGate/ROADMAP.md). *(Complete: Karate API + Serenity/Screenplay UI + BDD — 34 scenarios in CI.)*
- **[`PersonalWebsite/`](./PersonalWebsite)** — static personal / portfolio site.

**▶ Live app:** <https://shipping-hub.up.railway.app/>

CI (lint, typecheck, tests) runs against `FullStackHub/` via GitHub Actions
(`.github/workflows/ci.yml`).
