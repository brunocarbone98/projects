# CLAUDE.md — Shipping Hub

International parcel shipping & tracking platform (UPS/FedEx style) with a bilingual es/en web app. The full phased plan lives in `ROADMAP.md`: when starting a phase, read its corresponding section.

**Current phase:** Phases 0–6 are complete. The transactional API (`apps/api`) runs on Prisma + PostgreSQL (JWT auth, state machine, rate-limited public tracking + quote endpoints, and a wallet backed by a double-entry ledger with idempotent payments). The web app (`apps/web`) has the bilingual es/en public site (SSR, SEO, Leaflet route map) plus authenticated customer/staff dashboards and a wallet (httpOnly-cookie auth). The Python microservices (`services/pricing`, `services/labels`) are consumed by the API over HTTP. Notifications (email + webhooks) fire on status changes; container/Railway deploy configs are in place.

## Monorepo structure

- `apps/web` — Next.js 16 (App Router) + Tailwind: public SEO site + dashboards.
- `apps/api` — Express + TypeScript: transactional REST API. **The only layer that touches PostgreSQL** (Prisma from Phase 1 onwards).
- `services/pricing` and `services/labels` — stateless FastAPI microservices (pricing/ETA quotes and PDF labels); the API consumes them over internal HTTP.
- `packages/shared` — Zod schemas + TS types shared between web and api (API contracts, enums and the state machine from Phase 1 onwards).
- Orchestration: pnpm workspaces + Turborepo. Local PostgreSQL via Docker Compose.

## Commands

| Command                               | What it does                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm install`                        | Install all workspace dependencies                                                   |
| `pnpm dev`                            | Start web (http://localhost:3000) and api (http://localhost:4000) via Turborepo      |
| `pnpm --filter @shipping-hub/web dev` | Web only                                                                             |
| `pnpm --filter @shipping-hub/api dev` | API only                                                                             |
| `pnpm lint`                           | ESLint (flat config at the root) over the whole repo                                 |
| `pnpm typecheck`                      | `tsc --noEmit` in each workspace, via Turborepo                                      |
| `pnpm format` / `pnpm format:check`   | Prettier                                                                             |
| `docker compose up -d`                | Local PostgreSQL (port 5432; user/pass/db: `shipping` / `shipping` / `shipping_hub`) |

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

- `frontend-dev` — tasks in `apps/web` (Next.js 16 App Router, Tailwind v4, next-intl es/en, SEO); done when lint, format:check and typecheck pass and both message files have the new keys.
- `backend-dev` — tasks in `apps/api` (Express 5, Prisma, state machine, ledger, auth); every endpoint gets a Vitest + Supertest integration test.
- `python-services` — tasks in `services/pricing` and `services/labels` (FastAPI, Pydantic, pytest in each service's `.venv`).
- `code-reviewer` — reviews the diff (read-only): secrets, Zod at the edges, append-only tables, state transitions, idempotency, i18n keys in both message files, Prettier, no `any`.
- `test-runner` — runs Vitest (`pnpm test`, needs PostgreSQL → `../.claude/scripts/local-postgres.sh`) and pytest for both services; reports only failures (`model: haiku`). There is no Playwright suite — browser E2E lives in `../SecureGate`.

Repo-wide agents live in `/.claude/agents/` (`sre-patrol`, `repo-steward`, `qa-regression`, `security-auditor`, `docs-keeper`) and work from the repository root.

## Autonomous maintenance

- Shipping Hub is maintained around the clock by Claude Code agents; humans review and merge every PR. **CI** runs lint, format:check, typecheck and Vitest on every push to `main` and every PR; **Uptime patrol** probes the live app every 30 minutes and opens an `incident` issue when it is unhealthy; **SecureGate CI** runs the black-box suite nightly and on PRs.
- Shifts covering this project (`/.claude/shifts/`): **nightly maintenance** (08:40 UTC — every check plus the Karate API suite against a local stack, at most one small `chore(agents)` PR), **weekly security review** (Mondays — `pnpm audit`, `pip-audit`, helmet/CORS/rate-limit/cookie review) and **SRE patrol** (every 6 h — incidents and red pipelines).
- Helper scripts (`/.claude/scripts/`): `local-postgres.sh` (PostgreSQL 16 on 127.0.0.1:5432, `shipping`/`shipping`, `shipping_hub` + `shipping_hub_test`), `local-api.sh` (migrate + seed + API on :4000), `run-checks.sh` (every check, one summary table).
- Operations manual, roster and guardrails: [`../OPERATIONS.md`](../OPERATIONS.md).
