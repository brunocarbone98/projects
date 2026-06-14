# CLAUDE.md — Shipping Hub

International parcel shipping & tracking platform (UPS/FedEx style) with a bilingual es/en web app. The full phased plan lives in `ROADMAP.md`: when starting a phase, read its corresponding section.

**Current phase:** Phases 0, 1 and 2 are complete. The transactional API (`apps/api`) runs on Prisma + PostgreSQL, with JWT auth, the state machine and a rate-limited public tracking endpoint. The web app (`apps/web`) has the bilingual es/en public site with SSR, SEO and a design system. Next up is Phase 3 (dashboards) or Phase 4 (Python microservices, parallelizable).

## Monorepo structure

- `apps/web` — Next.js 15 (App Router) + Tailwind: public SEO site + dashboards.
- `apps/api` — Express + TypeScript: transactional REST API. **The only layer that touches PostgreSQL** (Prisma from Phase 1 onwards).
- `services/pricing` and `services/labels` — stateless FastAPI microservices (implemented in Phase 4).
- `packages/shared` — Zod schemas + TS types shared between web and api (API contracts, enums and the state machine from Phase 1 onwards).
- Orchestration: pnpm workspaces + Turborepo. Local PostgreSQL via Docker Compose.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm dev` | Start web (http://localhost:3000) and api (http://localhost:4000) via Turborepo |
| `pnpm --filter @shipping-hub/web dev` | Web only |
| `pnpm --filter @shipping-hub/api dev` | API only |
| `pnpm lint` | ESLint (flat config at the root) over the whole repo |
| `pnpm typecheck` | `tsc --noEmit` in each workspace, via Turborepo |
| `pnpm format` / `pnpm format:check` | Prettier |
| `docker compose up -d` | Local PostgreSQL (port 5432; user/pass/db: `shipping` / `shipping` / `shipping_hub`) |

## Conventions

- **Code language: English.** Identifiers, comments, commit messages, API routes and error messages are all in English. Visible UI copy is never hardcoded: it lives in the `next-intl` message files (es/en) from Phase 2 onwards.
- **Conventional commits** in English, imperative mood: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:`.
- **Strict TypeScript** in every package; `any` is forbidden. Validate all external input with Zod at the edge (route handlers / controllers).
- Contracts shared between web and api live in `packages/shared`; never duplicate types or enums.

## Architectural rules (non-negotiable)

1. Only `apps/api` reads and writes PostgreSQL. The Python microservices receive data, compute/generate and return the result: they **never touch the database**.
2. `tracking_events` and `ledger_entries` are append-only: never UPDATE or DELETE them.
3. Shipment state transitions are validated against the map in `packages/shared`; the API rejects invalid transitions (e.g. `DELIVERED → IN_TRANSIT`).
4. Every money operation requires an `idempotency_key` and a transaction.
5. Public endpoints (tracking) have rate limiting and require no auth.

## Subagents (`.claude/agents/`)

- `frontend-dev` — tasks in `apps/web` (Next.js, Tailwind, next-intl, SEO).
- `backend-dev` — tasks in `apps/api` (Express, Prisma, state machine, ledger).
- `python-services` — tasks in `services/` (FastAPI, pricing, labels).
- `code-reviewer` — review the diff after implementing features (read-only).
- `test-runner` — run test suites and report only the failures.
