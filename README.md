# Shipping Hub

International parcel shipping & tracking platform (UPS/FedEx style) with a bilingual
(es/en) public site. Anyone can track a package with its tracking number — no account
required. Built as a full-stack portfolio project.

> Full phased plan in [`ROADMAP.md`](./ROADMAP.md); project conventions in
> [`CLAUDE.md`](./CLAUDE.md). **Phases 0–2 are implemented.**

## Stack

| Area | Tech |
|---|---|
| Web (`apps/web`) | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS v4, next-intl (es/en) |
| API (`apps/api`) | Express 5, TypeScript, Prisma, PostgreSQL — the only layer that touches the DB |
| Shared (`packages/shared`) | Zod schemas, DTOs, enums and the shipment state machine |
| Services (`services/*`) | FastAPI microservices for pricing & labels (Phase 4) |
| Tooling | pnpm workspaces, Turborepo, ESLint, Prettier, Vitest, GitHub Actions |

## What works today

- **Transactional API**: JWT auth (access + rotating refresh tokens), role-based access
  (customer / courier / admin), shipment CRUD, append-only tracking events validated
  against a shipment **state machine**, and a public **rate-limited** tracking endpoint.
  Zone-based pricing, business-day ETAs, OpenAPI docs and 19 integration tests.
- **Public web**: bilingual landing, SSR tracking page (with a `ParcelDelivery` JSON-LD
  timeline), instant quote calculator, coverage and FAQ pages. Full SEO: dynamic
  metadata, OpenGraph + dynamic OG images, hreflang alternates, sitemap and robots.
- **Tracking number format**: `PTY-YYYY-NNNNNN-C` with a Luhn check digit.

## Prerequisites

- Node.js ≥ 20, pnpm 10
- PostgreSQL 16 (via Docker, or a local instance)

## Getting started

```bash
pnpm install

# 1. Start PostgreSQL (user/pass/db: shipping / shipping / shipping_hub)
docker compose up -d

# 2. Apply migrations and seed demo data (10 shipments across every state)
pnpm --filter @shipping-hub/api db:deploy
pnpm --filter @shipping-hub/api db:seed

# 3. Run web (http://localhost:3000) and api (http://localhost:4000)
pnpm dev
```

Demo accounts (password `Password123!`): `admin@shippinghub.test`,
`courier@shippinghub.test`, `ana@example.com`, `luis@example.com`.

Try tracking, no auth required:

```bash
curl http://localhost:4000/api/v1/tracking/PTY-2026-001001-0
# or open http://localhost:3000/en/tracking/PTY-2026-001001-0
```

API reference: <http://localhost:4000/api/v1/docs> (OpenAPI at `/api/v1/openapi.json`).

## Workspace scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Run web + api via Turborepo |
| `pnpm lint` / `pnpm typecheck` | ESLint / `tsc --noEmit` across the repo |
| `pnpm test` | Shared unit tests + API integration tests (needs PostgreSQL) |
| `pnpm --filter @shipping-hub/api db:migrate` | Create/apply a Prisma migration |
