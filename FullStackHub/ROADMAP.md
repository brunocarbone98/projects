# ROADMAP — Parcel Shipping & Tracking Platform (UPS/FedEx style)

> **Project:** Digital Portfolio & Multilanguage Full-Stack Hub
> **Stack:** Next.js, React, TypeScript, Node.js (Express), Python, PostgreSQL, Tailwind CSS
> **How to use this file:** keep it at the repo root. When starting each phase with Claude Code, open plan mode and ask it to read the corresponding section of this roadmap.

---

## 1. Product vision

International courier and parcel platform (example: Panama ↔ USA ↔ LatAm) with a bilingual Spanish/English interface. Any visitor can track a package with its tracking number without signing up (key for recruiter demos). Registered users create shipments, pay for labels with an internal wallet, and operations staff update the statuses that feed the public timeline.

**MVP success criterion:** a visitor lands on the site, pastes `PTY-2026-000123-4` and, in under 2 seconds, sees a shipment timeline rendered with SSR, in their language, with correct SEO metadata.

---

## 2. Where each piece of the stack fits

| Technology | Location in the repo | Responsibility |
|---|---|---|
| **Next.js + React + TypeScript + Tailwind** | `apps/web` | Public SEO site (tracking, quoter, coverage, FAQ) + customer and admin dashboards. SSR/SSG, i18n, dynamic metadata, sitemap. |
| **Node.js (Express) + TypeScript** | `apps/api` | Transactional REST API: authentication, users, shipments, tracking events, wallet/ledger, invoices. The only layer that writes to the database. |
| **PostgreSQL** | Local Docker → Railway-managed Postgres in prod | Single source of truth: users, shipments, events, rates, accounting ledger. |
| **Python (FastAPI)** | `services/pricing` and `services/labels` | Stateless microservices: (1) rate quoting + ETA calculation; (2) PDF label generation with barcode and QR. The Node API consumes them over internal HTTP. |
| **Shared types** | `packages/shared` | Zod schemas + TypeScript types shared between `web` and `api` (API contracts, status enums). |

**Architectural golden rule:** the Python microservices never touch the database; they receive data, compute/generate, and return the result. Only `apps/api` writes to PostgreSQL. This keeps the "distributed architecture" clean and easy to explain in interviews.

---

## 3. Monorepo structure

```
shipping-hub/
├── CLAUDE.md                  # Project conventions for Claude Code
├── ROADMAP.md                 # This file
├── .claude/
│   └── agents/                # Claude Code subagents (see section 7)
│       ├── frontend-dev.md
│       ├── backend-dev.md
│       ├── python-services.md
│       ├── code-reviewer.md
│       └── test-runner.md
├── apps/
│   ├── web/                   # Next.js 15 (App Router)
│   └── api/                   # Express + TypeScript + Prisma
├── services/
│   ├── pricing/               # FastAPI: quoting + ETA
│   └── labels/                # FastAPI: PDF labels + barcode/QR
├── packages/
│   └── shared/                # Zod schemas + TS types
├── docker-compose.yml         # PostgreSQL + Python services
├── turbo.json                 # Monorepo orchestration
└── pnpm-workspace.yaml
```

**Base tooling:** pnpm workspaces + Turborepo, Prisma as the ORM, `next-intl` for i18n, GitHub Actions for CI.

---

## 4. Domain model

### Shipment state machine (the heart of the system)

```
CREATED → LABEL_PAID → PICKED_UP → IN_TRANSIT → AT_DESTINATION_HUB → OUT_FOR_DELIVERY → DELIVERED
```

Side states: `EXCEPTION` (customs, wrong address), `RETURNED_TO_SENDER`, `CANCELLED`.
Rules: valid transitions are defined in a map in `packages/shared`; each transition generates an immutable `tracking_event` with a timestamp, location and actor. The API rejects invalid transitions (e.g. `DELIVERED → IN_TRANSIT`).

### Main entities

- `users` (roles: `customer`, `courier`, `admin`)
- `addresses` (address book, origin/destination)
- `shipments` (tracking number, service, current status, weight/dimensions, cost)
- `tracking_events` (immutable history, append-only)
- `service_levels` (express, standard, economy) and `zones` / `rates` (rates by zone-weight)
- `wallet_accounts` and `ledger_entries` (double-entry, immutable) — Phase 5
- `payments` with `idempotency_key` — Phase 5
- `webhook_subscriptions` — Phase 6
### Tracking number format

`PTY-YYYY-NNNNNN-C` where `C` is a check digit (Luhn-style algorithm). A small detail that adds realism and makes a good technical story.

---

## 5. Project phases

> Estimated durations working part-time with Claude's help. Each phase ends with something demonstrable and a commit/tag.

### Phase 0 — Foundations (2–4 days)
**Stack:** general tooling.
- Monorepo with pnpm + Turborepo; ESLint + Prettier; Docker Compose with PostgreSQL.
- Root `CLAUDE.md` with conventions (code language in English, conventional commits, how to run each app).
- Create the subagents in `.claude/agents/` (section 7).
- Minimal CI in GitHub Actions: lint + typecheck.
**Deliverable:** `pnpm dev` brings up empty web and api; `docker compose up` brings up Postgres.
**With Claude Code:** use plan mode and ask it: *"Read ROADMAP.md, Phase 0 section, and create the monorepo structure"*.

### Phase 1 — Transactional API (1–2 weeks)
**Stack:** Node.js (Express) + TypeScript + Prisma + PostgreSQL.
- Prisma schema of the core entities + migrations + seeds (10 demo shipments in different states).
- Auth with JWT (access + refresh) and role middleware.
- Endpoints: shipment CRUD, tracking-event registration (courier/admin only), and the public endpoint `GET /api/v1/tracking/:code` (no auth, with rate limiting).
- State machine validated in the service layer + integration tests (Vitest + Supertest).
- Generated OpenAPI documentation.
**Deliverable:** API running with seed data; you can track a shipment with `curl`.

### Phase 2 — Public web with SEO + i18n (1–2 weeks)
**Stack:** Next.js + React + TypeScript + Tailwind.
- App Router with localized routes `/{es|en}/...` using `next-intl`.
- Pages: landing, `/tracking/[code]` (SSR against the API, shipment timeline), quoter, coverage, FAQ.
- SEO: dynamic `generateMetadata` per shipment, OpenGraph, `sitemap.xml`, `robots.txt`, JSON-LD with the `ParcelDelivery` schema.
- Design system with Tailwind: brand palette, Timeline, StatusBadge, Card components.
**Deliverable:** Lighthouse SEO ≥ 95; a shareable tracking URL that looks good on WhatsApp/Twitter.

### Phase 3 — Dashboards (1–2 weeks)
**Stack:** Next.js (protected routes) + API.
- Login/registration against the API (httpOnly cookies).
- Customer: create-shipment wizard (addresses → parcel → service/quote → confirm), history, address book.
- Admin/courier: shipment search, a "register event" button that simulates warehouse scans.
**Deliverable:** full flow: create a shipment → admin advances its status → the public page reflects every change.

### Phase 4 — Python microservices (1 week)
**Stack:** Python + FastAPI + Docker.
- `services/pricing`: `POST /quote` receives origin/destination/weight/service and returns price + ETA (rules by zone, business days, holidays in Panama and the destination; optional: a scikit-learn model trained on synthetic data for the ETA).
- `services/labels`: `POST /label` receives the shipment data and returns a 4×6 PDF with a Code-128 barcode (`reportlab` + `python-barcode`) and a QR pointing to the tracking URL.
- The Node API consumes them over internal HTTP; both in Docker Compose; healthchecks.
**Deliverable:** paying for a shipment downloads the PDF label; the public quoter uses `pricing` live.

### Phase 5 — Payments: wallet + ledger (1 week)
**Stack:** Node.js + PostgreSQL (serializable transactions).
- Per-user wallet with a double-entry ledger: append-only `ledger_entries` table; the balance is the sum, never an editable field.
- `idempotency_key` on every payment operation (safe retries).
- Flow: top up balance (simulated or Stripe test mode) → pay for a label → if generation fails, automatic reversal.
**Deliverable:** consistent transaction history; a test proving that a double-click does not charge twice.

### Phase 6 — Polish and deploy (1–2 weeks)
- Email notifications on status changes (Resend) + outbound webhooks for e-commerce.
- Route map on the tracking page (Leaflet + OpenStreetMap).
- E2E with Playwright (track, create shipment, pay); README with screenshots and an architecture diagram.
- Deploy: all-in-one on **Railway** (web · api · Python services · managed PostgreSQL).
**Deliverable:** a public URL in your portfolio + a documented repo.

---

## 6. Dependency order

```
Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 5
              ↘ Phase 4 (parallel from Phase 2) ↗ → Phase 6
```

Phase 4 (Python) only depends on Phase 1; you can pull it forward in parallel if you want a change of technology.

---

## 7. Claude Code subagents for this project

Subagents live in `.claude/agents/` (project-level, versioned in git) or `~/.claude/agents/` (personal, across all your projects). They are Markdown files with YAML frontmatter; create and manage them with the `/agents` command inside Claude Code. Docs: https://code.claude.com/docs/en/sub-agents

### Recommended agents

| Agent | Model | Tools | Role |
|---|---|---|---|
| `frontend-dev` | sonnet | all | Next.js, Tailwind, next-intl, SEO. Knows the design system. |
| `backend-dev` | sonnet | all | Express, Prisma, state machine, ledger. |
| `python-services` | sonnet | all | FastAPI, reportlab, barcode. Remember: never touch the DB. |
| `code-reviewer` | sonnet | Read, Grep, Glob | Diff review: security, types, conventions. Read-only. |
| `test-runner` | haiku | Bash, Read | Runs test suites and reports only the failures (saves context). |

### Example: `.claude/agents/backend-dev.md`

```markdown
---
name: backend-dev
description: Implements and modifies the Express API, Prisma schema and domain logic (shipments, tracking, ledger). Use for any task in apps/api.
model: sonnet
---

You are the backend developer of a shipping platform.

Domain rules:
- Shipment state transitions are validated against the map in packages/shared/src/shipment-states.ts. Never allow invalid transitions.
- tracking_events and ledger_entries are append-only: never generate UPDATE or DELETE on them.
- Every money operation requires an idempotency_key and a Prisma transaction.
- Public endpoints (tracking) have rate limiting.

Conventions: strict TypeScript, Zod to validate input, errors with consistent codes, integration tests with Vitest + Supertest for every new endpoint.
```

### Example: `.claude/agents/code-reviewer.md`

```markdown
---
name: code-reviewer
description: Reviews recent changes for bugs, security issues and project convention violations. Use proactively after implementing features.
model: sonnet
tools: Read, Grep, Glob
---

You are a senior code reviewer. Review the most recent diff and report
findings ordered by severity (critical/medium/minor). Check for:
hardcoded secrets, input validation, invalid state transitions,
mutations to append-only tables, and `any` types.
You do not modify files: you only report.
```

### Suggested per-phase workflow

1. `claude` at the repo root → plan mode (Shift+Tab) → *"Read Phase N of ROADMAP.md and propose a plan"*.
2. Approve the plan and let it delegate: backend tasks go to `backend-dev`, etc. (it delegates based on each agent's `description`; you can also ask explicitly: *"Use the python-services agent to..."*).
3. After finishing each block: *"Use code-reviewer on the changes"* → fix → commit.
4. `test-runner` to run long suites without filling the main context.
---

## 8. Portfolio extras (if there's time left)

- Dark mode and micro-animations in the timeline.
- A `/developers` page with docs for the public tracking API (positions you as someone who thinks about DX).
- A technical blog with 2–3 posts ("How I modeled the state machine", "Double-entry ledger in PostgreSQL") — more real SEO for the domain.
