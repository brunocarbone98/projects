# DEMO.md — live-interview runbook

Twelve minutes, five acts, one browser. The goal: show a working product, the engineering behind it, how it is tested, and how it is maintained around the clock by Claude Code agents — and keep going if something breaks. Everything here is in English; a Spanish cue card is at the end.

## Before the interview

### T-1 day

- [ ] Open <https://shipping-hub.up.railway.app/en/tracking/PTY-2026-001001-0> — the tracking page renders with the timeline and the route map. If it does not, see "If something breaks" and fix it today, not tomorrow.
- [ ] Sign in as `ana@example.com` / `Password123!`, open the wallet, sign out.
- [ ] Actions tab → **Uptime patrol** → **Run workflow** → wait for the run and open its step summary: the probe table is what you will show. If every row says `🛡️ challenged`, Railway's edge bot protection answered the monitor instead of the app (the run is green with a warning and opens no incident): open the live app in your browser to prove it is up, and use it as a talking point about monitoring vantage.
- [ ] Issues → Labels shows `agent` · `incident` · `dependencies` · `security` · `maintenance` · `bug`; otherwise Actions → **Sync labels** → **Run workflow** (the `label:agent` / `label:incident` filters you will show are empty without them).
- [ ] Make sure at least one open agent PR (`label:agent`) or Dependabot PR (`label:dependencies`) exists. If none does, run a shift by hand from the repo root: `claude -p "$(cat .claude/shifts/nightly-maintenance.md)"`.
- [ ] Repository → Settings → Secrets and variables → Actions: `CLAUDE_CODE_OAUTH_TOKEN` is set (otherwise `@claude` only prints a setup notice).
- [ ] Open the scheduled-task list in claude.ai/code: the three `Autonomous maintenance · …` tasks are enabled and have recent runs you can open.
- [ ] Actions tab → **SecureGate CI**: if a banner says the workflow was disabled for inactivity, click **Enable workflow** (GitHub set it to `disabled_inactivity` on 2026-09-10 and a push does not bring it back; until you click, nothing from SecureGate runs, not even on pull requests). Then **Run workflow** on `main` and wait for the green run with its `securegate-reports` artifact.
- [ ] Optional, if you plan to show a local run: pull `main`, then `cd FullStackHub && pnpm install && pnpm test` once.

### T-10 min — tabs to have open, in this order

| # | Tab | URL |
| --- | --- | --- |
| 1 | Live app — landing | <https://shipping-hub.up.railway.app/en> |
| 2 | Tracking page | <https://shipping-hub.up.railway.app/en/tracking/PTY-2026-001001-0> |
| 3 | Quote calculator | <https://shipping-hub.up.railway.app/en/quote> |
| 4 | Sign-in | <https://shipping-hub.up.railway.app/en/login> |
| 5 | Repository README — architecture diagram | <https://github.com/brunocarbone98/projects> |
| 6 | `FullStackHub/CLAUDE.md` — the golden rules | <https://github.com/brunocarbone98/projects/blob/main/FullStackHub/CLAUDE.md> |
| 7 | Karate feature | <https://github.com/brunocarbone98/projects/blob/main/SecureGate/src/test/resources/karate/tracking.feature> |
| 8 | Screenplay task | <https://github.com/brunocarbone98/projects/blob/main/SecureGate/src/test/java/com/securegate/ui/screenplay/tasks/TrackParcel.java> |
| 9 | Actions | <https://github.com/brunocarbone98/projects/actions> |
| 10 | Agent PRs | <https://github.com/brunocarbone98/projects/pulls?q=is%3Apr+label%3Aagent> |
| 11 | New issue — templates | <https://github.com/brunocarbone98/projects/issues/new/choose> |
| 12 | `.claude/` folder | <https://github.com/brunocarbone98/projects/tree/main/.claude> |
| 13 | Scheduled tasks | claude.ai/code → the scheduled-task list |

Close everything else, sign out of the app (Act 1 signs in live) and zoom the browser to 125% if you share a laptop screen.

## The 12-minute flow

| Time | Act | Tabs |
| --- | --- | --- |
| 0:00 – 2:30 | 1 · The product | 1–4 |
| 2:30 – 5:00 | 2 · Architecture | 5–6 |
| 5:00 – 7:30 | 3 · Quality | 7–9 |
| 7:30 – 10:30 | 4 · Autonomous maintenance | 9–13 |
| 10:30 – 12:00 | 5 · Q&A talking points | — |

### Act 1 — the product (2:30)

1. **Landing** (tab 1): bilingual public site; switch es/en in the header once.
2. **Track** (tab 2): `PTY-2026-001001-0` — server-side rendered, no account needed, timeline plus route map. Tracking numbers (`PTY-YYYY-NNNNNN-C`) carry a Luhn check digit; the public endpoint is rate-limited.
3. **Quote** (tab 3): request a quote — the price comes from the `pricing` FastAPI service over internal HTTP.
4. **Sign in** (tab 4) as `ana@example.com` / `Password123!`: the shipments list, then the **wallet** — the balance is the sum of append-only ledger entries (double-entry), and every money movement carries an `idempotency_key`.

Say: "Everything you see is one container on Railway — Next.js web, Express API, two Python services — plus a managed PostgreSQL."

### Act 2 — architecture (2:30)

1. **README diagram** (tab 5): Production, Quality and Autonomous maintenance in one picture. Point at web :8080 → api :4000 → pricing :8001 / labels :8002.
2. **One container**: root `Dockerfile` + `start.sh` + `railway.json`; the web is the only public process, the rest stays on localhost; `prisma migrate deploy` runs on boot; four separate apps in code, one deploy unit (`DEPLOY.md`).
3. **The golden rules** (tab 6, "Architectural rules"): only `apps/api` touches the database; `tracking_events` and `ledger_entries` are append-only; state transitions are validated against the map in `packages/shared`; every money operation needs an `idempotency_key` and a transaction; public endpoints are rate-limited and need no auth.

### Act 3 — quality (2:30)

1. **Karate feature** (tab 7): Gherkin-native HTTP tests with `match` contracts — contract, 400 and 404 for public tracking (the 429 lives in the opt-in `ratelimit.feature`). 28 API scenarios plus one opt-in `@ratelimit` check.
2. **Screenplay task** (tab 8): `TrackParcel` — an Actor performs Tasks and asks Questions; no selectors in step definitions, explicit waits only; 6 UI scenarios written in Gherkin under `features/ui`.
3. **Actions → SecureGate CI** (tab 9): the pipeline stands up Postgres + API + web + Chrome, runs Karate + Serenity UI + Newman, and uploads `securegate-reports` — open the latest run → Artifacts (Serenity living documentation + Karate HTML report). Mention: the suite *skips*, it does not fail, when no Shipping Hub is reachable, so "0 failures" alone is never read as a pass — the agents check the `tests` count.

### Act 4 — autonomous maintenance (3:00)

1. **Actions tab** (tab 9): `Uptime patrol` — click **Run workflow** (about 10 seconds) or open the run you dispatched in the pre-flight, and show its step summary (endpoint · status · time · result). It is scheduled every 30 minutes, but GitHub runs schedules best-effort — a few runs a day here, hours late — so do not promise a run every half hour; the Claude shifts run on Anthropic's scheduler and have fired on the minute.
2. **Agent PRs** (tab 10): `label:agent` — the nightly maintenance PR with its check-results table, Dependabot PRs with the shift's verdict comment. "Agents open PRs; I merge."
3. **Ask the on-call agent** (tab 11): pick the "Ask the on-call agent" template; the body already starts with `@claude ` — ask something small and concrete, for example `@claude summarise the latest SecureGate CI run and list any skipped scenarios`. Submit, switch to tab 9: the `Claude on-call` run starts within seconds and the agent answers in a comment on the issue.
4. **The configuration** (tab 12): `.claude/agents/` — seven root agents (`sre-patrol`, `repo-steward`, `qa-regression`, `security-auditor`, `docs-keeper`, and DramaFetch's `download-guardian` and `vuln-sentinel`); `.claude/shifts/` — three shift prompts (a shift is a Markdown file, reviewed like code); `.claude/scripts/` — the local-stack helpers and DramaFetch's upstream watch (`dramafetch-watch.sh`) the shifts use.
5. **The scheduled tasks** (tab 13): three Claude Code cloud tasks — SRE patrol every 6 h, nightly maintenance at 08:40 UTC, weekly security review on Mondays at 10:20 UTC — each resuming its standing session, whose transcript you can open run after run.

Close with the story: "The last commit was in July. After 60 days without activity GitHub disabled the SecureGate nightly — its last run was 2026-09-10 — and nobody noticed. Now the agents produce the activity, and silence turns into an issue or a PR."

### Act 5 — Q&A talking points (1:30, or as asked)

- **State machine** — transitions live in `packages/shared`; the API rejects invalid ones (e.g. `DELIVERED → IN_TRANSIT`); tracking events are append-only, so the public timeline is a faithful log.
- **Double-entry ledger + idempotency** — the balance is the sum of entries, never a mutable column; the `idempotency_key` makes double-clicks and retries safe; a failed label generation is reversed automatically.
- **Screenplay vs Page Object Model** — POM grew hard to maintain as the UI surface widened; Screenplay separates Targets (where), Tasks (what the actor does) and Questions (what we assert), so steps read like the business and selectors live in one place.
- **Black-box QA** — SecureGate knows only the public API and UI; it creates and cleans its own data through the API; the same suite runs against local, CI or any URL (`-DapiBaseUrl`).
- **Why one container** — a pragmatic packaging for a portfolio: four separate apps in code, one deploy unit on Railway, one public port; the trade-off is no independent scaling.
- **Guardrails and the cost of agents** — never push to `main`, one small PR per run, no empty PRs, truthful reporting, humans merge; GitHub Actions is free on a public repository, the cloud shifts cost Claude usage — the read-only SRE patrol is cheap, the nightly run is the expensive one and can be paused.
- **What I would do next** — branch protection with required checks; the SonarQube gate with a real token; a staging URL so the UI suite also runs against a deployment; measured run durations and costs in `OPERATIONS.md`.

## If something breaks

- **Railway is down** — the incident issue *is* the demo: open `label:incident`, show the probe table, the SRE patrol diagnosis comment and, after recovery, the auto-close comment. Restart from Railway (the service → Deployments → Restart) while you talk; `DEPLOY.md` → Monitoring & incidents has the steps.
- **CI is red** — show how an agent triages it: open the failing run and its logs, then explain the SRE patrol decision rule (a flaky or broken test or workflow → fix PR; anything else → an issue), or comment `@claude why did this run fail?` on the PR and let Claude on-call do it live.
- **No internet** — walk through `FullStackHub/screenshots/` (landing, tracking, quote, dashboard, wallet, shipments, the Railway deployment, the database schema and users) and the README diagram from a local clone.
- **The Actions tab shows only a few Uptime patrol runs a day** — GitHub runs `schedule` triggers best-effort and in this repository they start hours late (the SecureGate nightly set for 06:00 UTC has run between 10:23 and 12:03 UTC). It is GitHub's scheduler, not the monitor: **Run workflow** probes immediately, and a missing run is unobserved time, never a verdict on the app.
- **The Uptime patrol shows `🛡️ challenged` rows** — Railway's edge bot protection ("Checking your browser…", server `railway-hikari`) answered the monitor, not the app; the run stays green with a warning and no incident is opened. Show the live app in the browser, then the run summary: a monitor that cannot see is reported as *unobserved*, never as *healthy* — that honesty is the point. The decision to let monitors through lives in Railway's service settings.
- **`@claude` does not react** — open the `Claude on-call` run: if it printed the setup notice, the token secret is missing; show the notice itself ("this is the one thing that needs a human") and move on.

## Cheat-sheet

**URLs**

- Live app: <https://shipping-hub.up.railway.app/> · tracking `/en/tracking/PTY-2026-001001-0` · quote `/es/quote` · sitemap `/sitemap.xml`
- Repo: <https://github.com/brunocarbone98/projects> · Actions `/actions` · agent PRs `/pulls?q=is%3Apr+label%3Aagent` · incidents `/issues?q=label%3Aincident` · new issue `/issues/new/choose`

**Accounts** (seeded demo data; password `Password123!`)

- `ana@example.com` — customer · `admin@shippinghub.test` — admin · `courier@shippinghub.test` — courier

**Commands**

```bash
# Shipping Hub locally
cd FullStackHub && pnpm install && docker compose up -d
pnpm --filter @shipping-hub/api db:deploy && pnpm --filter @shipping-hub/api db:seed && pnpm dev
# without Docker, from the repo root:
.claude/scripts/local-postgres.sh && .claude/scripts/local-api.sh

# Checks
.claude/scripts/run-checks.sh                           # lint · format:check · typecheck · Vitest · pytest
cd SecureGate && ./mvnw -q verify                       # Karate API (stack on :4000)
./mvnw verify -Pui -Dheadless.mode=true                 # + Serenity UI (web on :3000 + Chrome)

# Agents
claude -p "$(cat .claude/shifts/sre-patrol.md)"         # run a shift by hand
gh workflow run "Uptime patrol"                         # or the Run workflow button in Actions
```

**Numbers** — 28 Karate API scenarios + 1 opt-in `@ratelimit`; 6 Serenity UI scenarios; pytest: pricing 41, labels 13; uptime probe scheduled every 30 min (GitHub runs it best-effort); SRE patrol every 6 h; nightly maintenance 08:40 UTC; weekly security review Mondays 10:20 UTC.

## Guion rápido (ES)

- Producto: Shipping Hub, plataforma bilingüe de envíos y rastreo de paquetes; rastreo público sin cuenta con `PTY-2026-001001-0`, cotizador, panel de cliente y billetera.
- Un contenedor en Railway: web Next.js (único puerto público) → API Express → servicios Python de precios y etiquetas; PostgreSQL gestionado.
- Reglas de oro: solo `apps/api` toca la base de datos; eventos de rastreo y asientos contables son append-only; transiciones de estado validadas en `packages/shared`; cada operación de dinero lleva `idempotency_key` y transacción.
- Billetera: libro de doble entrada, el saldo es la suma de asientos; la idempotencia hace seguros los dobles clics y los reintentos.
- Calidad: SecureGate prueba la plataforma como caja negra — 28 escenarios Karate de API, 6 escenarios de UI con Serenity Screenplay, colección Postman/Newman — en GitHub Actions en cada PR y cada noche.
- Screenplay en vez de Page Objects: Targets, Tasks y Questions; sin selectores en los step definitions; esperas explícitas, nunca `Thread.sleep`.
- Mantenimiento autónomo: agentes de Claude Code mantienen el repositorio 24/7 — patrulla de disponibilidad programada cada 30 min (GitHub la ejecuta a su ritmo; también se lanza a mano), patrulla SRE cada 6 h, mantenimiento nocturno, revisión de seguridad semanal, Dependabot y un agente de guardia al que se le escribe `@claude`.
- Límites (guardrails): nunca a `main`, un PR pequeño por turno, nada de PRs vacíos, reportes veraces (saltado no es aprobado), decisiones de esquema/dinero/auth/deploy van a un issue; un humano revisa y fusiona todo.
- La historia: el último commit fue en julio; a los 60 días sin actividad GitHub desactivó el nightly de SecureGate (última ejecución 2026-09-10) y nadie lo notó; ahora los agentes generan actividad y el silencio se convierte en issue o PR.
- Si algo falla: la caída de Railway es la demo (issue de incidente → diagnóstico → cierre automático); CI en rojo muestra cómo triagea un agente; sin internet, capturas en `FullStackHub/screenshots/`.
