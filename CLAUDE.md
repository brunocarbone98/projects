# CLAUDE.md — Shipping Hub

Plataforma de envíos y rastreo de paquetes (estilo UPS/FedEx) con web bilingüe es/en. El plan completo por fases vive en `ROADMAP.md`: al iniciar una fase, lee su sección correspondiente.

**Fase actual:** Fase 0 completada (estructura + tooling). Lo siguiente es la Fase 1 (API transaccional con Prisma). Todavía no hay base de datos conectada ni lógica de dominio.

## Estructura del monorepo

- `apps/web` — Next.js 15 (App Router) + Tailwind: sitio público SEO + dashboards.
- `apps/api` — Express + TypeScript: API REST transaccional. **Única capa que toca PostgreSQL** (Prisma a partir de la Fase 1).
- `services/pricing` y `services/labels` — microservicios FastAPI sin estado (se implementan en la Fase 4).
- `packages/shared` — esquemas Zod + tipos TS compartidos entre web y api (contratos de API, enums y máquina de estados a partir de la Fase 1).
- Orquestación: pnpm workspaces + Turborepo. PostgreSQL local vía Docker Compose.

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm install` | Instala todas las dependencias del workspace |
| `pnpm dev` | Levanta web (http://localhost:3000) y api (http://localhost:4000) vía Turborepo |
| `pnpm --filter @shipping-hub/web dev` | Solo la web |
| `pnpm --filter @shipping-hub/api dev` | Solo la API |
| `pnpm lint` | ESLint (flat config en la raíz) sobre todo el repo |
| `pnpm typecheck` | `tsc --noEmit` en cada workspace, vía Turborepo |
| `pnpm format` / `pnpm format:check` | Prettier |
| `docker compose up -d` | PostgreSQL local (puerto 5432; user/pass/db: `shipping` / `shipping` / `shipping_hub`) |

## Convenciones

- **Idioma del código: inglés.** Identificadores, comentarios, mensajes de commit, rutas de API y mensajes de error, todo en inglés. El copy visible de la UI nunca se hardcodea: vive en los archivos de mensajes de `next-intl` (es/en) a partir de la Fase 2.
- **Commits convencionales** en inglés e imperativo: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:`.
- **TypeScript estricto** en todos los paquetes; prohibido `any`. Validar toda entrada externa con Zod en el borde (route handlers / controladores).
- Los contratos compartidos entre web y api viven en `packages/shared`; no dupliques tipos ni enums.

## Reglas arquitectónicas (no negociables)

1. Solo `apps/api` lee y escribe en PostgreSQL. Los microservicios Python reciben datos, calculan/generan y devuelven el resultado: **nunca tocan la base de datos**.
2. `tracking_events` y `ledger_entries` son append-only: jamás UPDATE ni DELETE sobre ellas.
3. Las transiciones de estado de un envío se validan contra el mapa de `packages/shared`; la API rechaza transiciones inválidas (p. ej. `DELIVERED → IN_TRANSIT`).
4. Toda operación de dinero exige `idempotency_key` y transacción.
5. Los endpoints públicos (tracking) llevan rate limiting y no requieren auth.

## Subagentes (`.claude/agents/`)

- `frontend-dev` — tareas de `apps/web` (Next.js, Tailwind, next-intl, SEO).
- `backend-dev` — tareas de `apps/api` (Express, Prisma, máquina de estados, ledger).
- `python-services` — tareas de `services/` (FastAPI, pricing, labels).
- `code-reviewer` — revisar el diff después de implementar features (solo lectura).
- `test-runner` — correr suites de tests y reportar solo los fallos.
