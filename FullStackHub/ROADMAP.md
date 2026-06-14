# ROADMAP — Plataforma de Envíos y Rastreo de Paquetes (estilo UPS/FedEx)

> **Proyecto:** Digital Portfolio & Multilanguage Full-Stack Hub
> **Stack:** Next.js, React, TypeScript, Node.js (Express), Python, PostgreSQL, Tailwind CSS
> **Cómo usar este archivo:** guárdalo en la raíz del repo. Al iniciar cada fase con Claude Code, abre el modo plan y pídele que lea la sección correspondiente de este roadmap.

---

## 1. Visión del producto

Plataforma de mensajería y paquetería internacional (ejemplo: Panamá ↔ EE.UU. ↔ LatAm) con interfaz bilingüe español/inglés. Cualquier visitante puede rastrear un paquete con su número de guía sin registrarse (clave para demos a reclutadores). Los usuarios registrados crean envíos, pagan etiquetas con un wallet interno, y el personal de operaciones actualiza los estados que alimentan la línea de tiempo pública.

**Criterio de éxito del MVP:** un visitante entra al sitio, pega `PTY-2026-000123-4` y ve en menos de 2 segundos una línea de tiempo del envío renderizada con SSR, en su idioma, con metadata SEO correcta.

---

## 2. Dónde encaja cada pieza del stack

| Tecnología | Ubicación en el repo | Responsabilidad |
|---|---|---|
| **Next.js + React + TypeScript + Tailwind** | `apps/web` | Sitio público SEO (rastreo, cotizador, cobertura, FAQ) + dashboards de cliente y admin. SSR/SSG, i18n, metadata dinámica, sitemap. |
| **Node.js (Express) + TypeScript** | `apps/api` | API transaccional REST: autenticación, usuarios, envíos, eventos de tracking, wallet/ledger, facturas. Única capa que escribe en la base de datos. |
| **PostgreSQL** | Docker local → Neon/Supabase en prod | Fuente única de verdad: usuarios, envíos, eventos, tarifas, ledger contable. |
| **Python (FastAPI)** | `services/pricing` y `services/labels` | Microservicios sin estado: (1) cotización de tarifas + cálculo de ETA; (2) generación de etiquetas PDF con código de barras y QR. La API Node los consume por HTTP interno. |
| **Tipos compartidos** | `packages/shared` | Esquemas Zod + tipos TypeScript compartidos entre `web` y `api` (contratos de la API, enums de estados). |

**Regla de oro arquitectónica:** los microservicios Python nunca tocan la base de datos; reciben datos, calculan/generan, y devuelven el resultado. Solo `apps/api` escribe en PostgreSQL. Esto mantiene la "arquitectura distribuida" limpia y fácil de explicar en entrevistas.

---

## 3. Estructura del monorepo

```
shipping-hub/
├── CLAUDE.md                  # Convenciones del proyecto para Claude Code
├── ROADMAP.md                 # Este archivo
├── .claude/
│   └── agents/                # Subagentes de Claude Code (ver sección 7)
│       ├── frontend-dev.md
│       ├── backend-dev.md
│       ├── python-services.md
│       ├── code-reviewer.md
│       └── test-runner.md
├── apps/
│   ├── web/                   # Next.js 15 (App Router)
│   └── api/                   # Express + TypeScript + Prisma
├── services/
│   ├── pricing/               # FastAPI: cotización + ETA
│   └── labels/                # FastAPI: etiquetas PDF + barcode/QR
├── packages/
│   └── shared/                # Zod schemas + tipos TS
├── docker-compose.yml         # PostgreSQL + servicios Python
├── turbo.json                 # Orquestación del monorepo
└── pnpm-workspace.yaml
```

**Herramientas base:** pnpm workspaces + Turborepo, Prisma como ORM, `next-intl` para i18n, GitHub Actions para CI.

---

## 4. Modelo de dominio

### Máquina de estados del envío (el corazón del sistema)

```
CREATED → LABEL_PAID → PICKED_UP → IN_TRANSIT → AT_DESTINATION_HUB → OUT_FOR_DELIVERY → DELIVERED
```

Estados laterales: `EXCEPTION` (aduana, dirección incorrecta), `RETURNED_TO_SENDER`, `CANCELLED`.
Reglas: las transiciones válidas se definen en un mapa en `packages/shared`; cada transición genera un `tracking_event` inmutable con timestamp, ubicación y actor. La API rechaza transiciones inválidas (p. ej. `DELIVERED → IN_TRANSIT`).

### Entidades principales

- `users` (roles: `customer`, `courier`, `admin`)
- `addresses` (libreta de direcciones, origen/destino)
- `shipments` (guía, servicio, estado actual, peso/dimensiones, costo)
- `tracking_events` (histórico inmutable, append-only)
- `service_levels` (express, estándar, económico) y `zones` / `rates` (tarifas por zona-peso)
- `wallet_accounts` y `ledger_entries` (doble partida, inmutable) — Fase 5
- `payments` con `idempotency_key` — Fase 5
- `webhook_subscriptions` — Fase 6
### Formato del número de guía

`PTY-YYYY-NNNNNN-C` donde `C` es un dígito verificador (algoritmo tipo Luhn). Detalle pequeño que da realismo y es buena historia técnica.

---

## 5. Fases del proyecto

> Duraciones estimadas trabajando a tiempo parcial con ayuda de Claude. Cada fase termina con algo demostrable y un commit/tag.

### Fase 0 — Cimientos (2–4 días)
**Stack:** tooling general.
- Monorepo con pnpm + Turborepo; ESLint + Prettier; Docker Compose con PostgreSQL.
- `CLAUDE.md` raíz con convenciones (idioma de código en inglés, commits convencionales, cómo correr cada app).
- Crear los subagentes en `.claude/agents/` (sección 7).
- CI mínimo en GitHub Actions: lint + typecheck.
**Entregable:** `pnpm dev` levanta web y api vacías; `docker compose up` levanta Postgres.
**Con Claude Code:** usa el modo plan y pídele: *"Lee ROADMAP.md sección Fase 0 y crea la estructura del monorepo"*.

### Fase 1 — API transaccional (1–2 semanas)
**Stack:** Node.js (Express) + TypeScript + Prisma + PostgreSQL.
- Esquema Prisma de las entidades core + migraciones + seeds (10 envíos demo en distintos estados).
- Auth con JWT (access + refresh) y middleware de roles.
- Endpoints: CRUD de envíos, registro de eventos de tracking (solo courier/admin), y el endpoint público `GET /api/v1/tracking/:code` (sin auth, con rate limit).
- Máquina de estados validada en la capa de servicio + tests de integración (Vitest + Supertest).
- Documentación OpenAPI generada.
**Entregable:** API corriendo con datos seed; puedes rastrear un envío con `curl`.

### Fase 2 — Web pública con SEO + i18n (1–2 semanas)
**Stack:** Next.js + React + TypeScript + Tailwind.
- App Router con rutas localizadas `/{es|en}/...` usando `next-intl`.
- Páginas: landing, `/tracking/[code]` (SSR contra la API, línea de tiempo del envío), cotizador, cobertura, FAQ.
- SEO: `generateMetadata` dinámico por envío, OpenGraph, `sitemap.xml`, `robots.txt`, JSON-LD con schema `ParcelDelivery`.
- Design system con Tailwind: paleta de marca, componentes Timeline, StatusBadge, Card.
**Entregable:** Lighthouse SEO ≥ 95; URL de rastreo compartible que se ve bien en WhatsApp/Twitter.

### Fase 3 — Dashboards (1–2 semanas)
**Stack:** Next.js (rutas protegidas) + API.
- Login/registro contra la API (cookies httpOnly).
- Cliente: wizard de crear envío (direcciones → paquete → servicio/cotización → confirmar), historial, libreta de direcciones.
- Admin/courier: buscador de envíos, botón "registrar evento" que simula escaneos de bodega.
**Entregable:** flujo completo: crear envío → admin lo avanza de estado → la página pública refleja cada cambio.

### Fase 4 — Microservicios Python (1 semana)
**Stack:** Python + FastAPI + Docker.
- `services/pricing`: `POST /quote` recibe origen/destino/peso/servicio y devuelve precio + ETA (reglas por zona, días hábiles, festivos de Panamá y destino; opcional: modelo scikit-learn entrenado con datos sintéticos para el ETA).
- `services/labels`: `POST /label` recibe datos del envío y devuelve PDF 4×6 con código de barras Code-128 (`reportlab` + `python-barcode`) y QR a la URL de rastreo.
- La API Node los consume vía HTTP interno; ambos en Docker Compose; healthchecks.
**Entregable:** al pagar un envío se descarga la etiqueta PDF; el cotizador público usa `pricing` en vivo.

### Fase 5 — Pagos: wallet + ledger (1 semana)
**Stack:** Node.js + PostgreSQL (transacciones serializables).
- Wallet por usuario con ledger de doble partida: tabla `ledger_entries` append-only; el balance es la suma, nunca un campo editable.
- `idempotency_key` en cada operación de pago (reintentos seguros).
- Flujo: recargar saldo (simulado o Stripe test mode) → pagar etiqueta → si falla la generación, reverso automático.
**Entregable:** historial de transacciones consistente; test que demuestra que un doble-click no cobra dos veces.

### Fase 6 — Pulido y deploy (1–2 semanas)
- Notificaciones email en cambios de estado (Resend) + webhooks salientes para e-commerce.
- Mapa del recorrido en la página de tracking (Leaflet + OpenStreetMap).
- E2E con Playwright (rastrear, crear envío, pagar); README con capturas y diagrama de arquitectura.
- Deploy: **Vercel** (web) · **Railway o Render** (api + servicios Python) · **Neon** (PostgreSQL).
**Entregable:** URL pública en tu portafolio + repo documentado.

---

## 6. Orden de dependencias

```
Fase 0 → Fase 1 → Fase 2 → Fase 3 → Fase 5
              ↘ Fase 4 (paralela desde Fase 2) ↗ → Fase 6
```

La Fase 4 (Python) solo depende de la 1; puedes adelantarla en paralelo si quieres variar de tecnología.

---

## 7. Subagentes de Claude Code para este proyecto

Los subagentes viven en `.claude/agents/` (proyecto, versionados en git) o `~/.claude/agents/` (personales, todos tus proyectos). Son archivos Markdown con frontmatter YAML; se crean y gestionan con el comando `/agents` dentro de Claude Code. Docs: https://code.claude.com/docs/en/sub-agents

### Agentes recomendados

| Agente | Modelo | Herramientas | Rol |
|---|---|---|---|
| `frontend-dev` | sonnet | todas | Next.js, Tailwind, next-intl, SEO. Conoce el design system. |
| `backend-dev` | sonnet | todas | Express, Prisma, máquina de estados, ledger. |
| `python-services` | sonnet | todas | FastAPI, reportlab, barcode. Recuerda: nunca tocar la DB. |
| `code-reviewer` | sonnet | Read, Grep, Glob | Revisión de diffs: seguridad, tipos, convenciones. Solo lectura. |
| `test-runner` | haiku | Bash, Read | Corre suites de tests y reporta solo los fallos (ahorra contexto). |

### Ejemplo: `.claude/agents/backend-dev.md`

```markdown
---
name: backend-dev
description: Implementa y modifica la API Express, esquema Prisma y lógica de dominio (envíos, tracking, ledger). Usar para cualquier tarea de apps/api.
model: sonnet
---

Eres el desarrollador backend de una plataforma de envíos.

Reglas del dominio:
- Las transiciones de estado de un envío se validan contra el mapa en packages/shared/src/shipment-states.ts. Nunca permitas transiciones inválidas.
- tracking_events y ledger_entries son append-only: jamás generes UPDATE o DELETE sobre ellas.
- Toda operación de dinero exige idempotency_key y transacción de Prisma.
- Endpoints públicos (tracking) llevan rate limiting.

Convenciones: TypeScript estricto, Zod para validar entrada, errores con códigos consistentes, tests de integración con Vitest + Supertest para cada endpoint nuevo.
```

### Ejemplo: `.claude/agents/code-reviewer.md`

```markdown
---
name: code-reviewer
description: Revisa cambios recientes en busca de bugs, problemas de seguridad y violaciones de las convenciones del proyecto. Usar proactivamente después de implementar features.
model: sonnet
tools: Read, Grep, Glob
---

Eres un revisor de código senior. Revisa el diff más reciente y reporta
hallazgos ordenados por severidad (crítico/medio/menor). Verifica:
secretos hardcodeados, validación de entrada, transiciones de estado
inválidas, mutaciones a tablas append-only, y tipos `any`.
No modificas archivos: solo reportas.
```

### Flujo de trabajo sugerido por fase

1. `claude` en la raíz del repo → modo plan (Shift+Tab) → *"Lee la Fase N del ROADMAP.md y proponme un plan"*.
2. Aprueba el plan y deja que delegue: las tareas de backend irán a `backend-dev`, etc. (delega solo según la `description` de cada agente; también puedes pedirlo explícito: *"Usa el agente python-services para..."*).
3. Al terminar cada bloque: *"Usa code-reviewer sobre los cambios"* → corrige → commit.
4. `test-runner` para correr suites largas sin llenar el contexto principal.
---

## 8. Extras para el portafolio (si sobra tiempo)

- Modo oscuro y micro-animaciones en la línea de tiempo.
- Página `/developers` con docs del API público de tracking (te posiciona como alguien que piensa en DX).
- Blog técnico de 2–3 posts ("Cómo modelé la máquina de estados", "Ledger de doble partida en PostgreSQL") — más SEO real para el dominio.
