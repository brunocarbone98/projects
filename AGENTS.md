# AGENTS.md

Instructions for any coding agent — Claude Code, Codex, Cursor, Copilot — working in this repository; the same rules apply to humans. Claude Code sessions also load `CLAUDE.md`, which imports this file.

## Map

- `FullStackHub/` — **Shipping Hub**, a bilingual (es/en) parcel shipping & tracking platform: Next.js 16 web (`apps/web`), Express 5 + Prisma API (`apps/api`, the only layer touching PostgreSQL), two stateless FastAPI services (`services/pricing`, `services/labels`), shared Zod contracts (`packages/shared`); pnpm 10 workspaces + Turborepo. Live on Railway as one container (root `Dockerfile`, `start.sh`, `railway.json`).
- `SecureGate/` — the black-box QA & security suite for Shipping Hub: Java 21, Maven (`./mvnw`), Karate API features, Serenity BDD + Screenplay over Selenium for UI, Cucumber, a Postman/Newman collection, a token-gated SonarQube gate.
- `DramaFetch/` — **DramaFetch**, a TikTok short-drama series downloader for personal offline viewing: Python 3.11+, Playwright discovers the episode list, yt-dlp (or, with `--engine browser`, one Chromium session reusing the list's play URLs) downloads each episode, paced like one person watching, a stdlib `http.server` web UI; episodes the account has not unlocked are listed and skipped, never unlocked; paid episodes it has unlocked download like free ones.
- `DramaFetch/extension/` — **DramaFetch for Chrome**, the same downloader as a Manifest V3 extension for users without Python (Windows first, installed with **Load unpacked**): plain ES2022 modules with `// @ts-check` and JSDoc, no npm dependencies, no remote code; it re-implements the engine with the Python tool's rules, texts and constants (a parity test compares them) and downloads only what TikTok serves to the user's own logged-in Chrome session — it never reads cookies and never touches TikTok's page or its requests.
- `PersonalWebsite/` — static two-page portfolio (`MainPage.html`, `Portfolio.html`, `favicon.svg`), vanilla HTML/CSS/JS, served by GitHub Pages.

Per-project instructions: `FullStackHub/CLAUDE.md`, `SecureGate/CLAUDE.md` and `DramaFetch/CLAUDE.md` (rules and commands; the first two also define subagents) — read the one for the folder you change before you start. Deployment: `DEPLOY.md`. Agents, shifts and incidents: `OPERATIONS.md`. Never edit `FullStackHub/ROADMAP.md` or `SecureGate/ROADMAP.md`.

## Conventions

- Everything in English: code, comments, commits, docs. UI copy lives in the `next-intl` message files (`apps/web/messages/*.json`, both languages), never hardcoded.
- Conventional commits in the imperative: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:`.
- Strict TypeScript everywhere; `any` is forbidden; validate external input with Zod at the edge; shared contracts live in `packages/shared` and are never duplicated.
- Prettier (printWidth 100) is mandatory for every `.ts/.tsx/.md/.json/.yml` under `FullStackHub/`: `pnpm --dir FullStackHub exec prettier --write <files>`. Ignored on purpose: `ROADMAP.md`, `pnpm-lock.yaml`, `apps/web/src/lib/world-coastlines.ts`.
- Python services: type hints everywhere, Pydantic models are the contract, tests with pytest in each service's `.venv`.
- DramaFetch: Python 3.11+ with type hints everywhere; `ruff check`, `ruff format --check` and `mypy --strict` must pass (`DramaFetch/pyproject.toml`, rules never loosened); pytest runs against fixtures and the local fake TikTok server — nothing reaches tiktok.com from a sandbox or CI; parsing is pure functions, the network layer is thin and injectable, no runtime dependencies beyond yt-dlp, Playwright and mutagen (pure Python; it writes each episode's cover into the MP4); never log cookie values, never bypass paywalls, DRM or anti-bot checks (the only automation-related settings are a Chrome user agent without `Headless` and curl_cffi's Chrome TLS impersonation, listed in `DramaFetch/CLAUDE.md`; Chromium runs with its default flags; no proxies, no stealth plugins).
- SecureGate: black-box only (public API and UI, never source or database); Screenplay for UI with no selectors in step definitions; Karate for API with `match` contracts; explicit waits only, never `Thread.sleep`.

## Commands

| Project | Command | What it does |
| --- | --- | --- |
| FullStackHub | `pnpm install` | Install the workspaces (run from `FullStackHub/`) |
| FullStackHub | `pnpm dev` | Web on :3000 + API on :4000 via Turborepo |
| FullStackHub | `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` | The definition-of-done checks; `pnpm test` is Vitest (shared unit + API integration) and needs PostgreSQL on localhost:5432 |
| FullStackHub | `pnpm --filter @shipping-hub/api db:deploy` · `db:seed` · `db:migrate` | Apply migrations · seed the demo data · create a migration |
| FullStackHub | `cd services/pricing && . .venv/bin/activate && pytest` (same for `services/labels`) | Service tests; `pip install -r requirements.txt` into the `.venv` first |
| SecureGate | `./mvnw -q verify` | Karate API suite (28 scenarios) against `http://localhost:4000`; cleanly skipped when no stack is up |
| SecureGate | `./mvnw verify -Pui -Dheadless.mode=true` | Adds the 6 Serenity/Screenplay UI scenarios; needs the web on :3000 and Chrome (CI has both) |
| SecureGate | `./mvnw verify -Dsg.ratelimit=true` | Includes the opt-in `@ratelimit` scenario |
| SecureGate | `cd postman && npx newman run SecureGate.postman_collection.json -e SecureGate.local.postman_environment.json` | The Postman collection, headless |
| DramaFetch | `cd DramaFetch && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy && .venv/bin/pytest` | The definition-of-done checks (`python -m venv .venv && .venv/bin/pip install -e ".[impersonate,dev]"` once); unit tests use fixtures and a local fake TikTok server, never TikTok |
| DramaFetch | `cd DramaFetch && .venv/bin/pytest -m integration` | Drives a real Chromium against the fake TikTok server; skipped (not passed) unless `DRAMAFETCH_CHROMIUM=<path to a Chromium binary>` is set or `/opt/pw-browsers/chromium` exists — after `playwright install chromium`, point it at `p.chromium.executable_path` the way CI does |
| DramaFetch | `cd DramaFetch/extension && node --test && npx -y -p typescript@5.9.3 tsc -p jsconfig.json` | The Chrome extension's checks (Node 22, no npm dependencies): unit tests of every module plus the manifest (permissions) and locales tests, then the strict `checkJs` type check; its parity tests run inside `pytest`, its end-to-end scenarios inside `pytest -m integration` |
| Repo | `.claude/scripts/local-postgres.sh` | Throwaway PostgreSQL 16 on 127.0.0.1:5432 (`shipping`/`shipping`; `shipping_hub` + `shipping_hub_test`); idempotent; reuses a running cluster; Docker fallback |
| Repo | `.claude/scripts/local-api.sh` | Migrate + seed + start the API on :4000 in the background, wait for `/health`, print the PID file path |
| Repo | `.claude/scripts/run-checks.sh` | FullStackHub lint/format:check/typecheck/test + both pytest suites; one summary table; exit 1 on any failure |
| Website | open `PersonalWebsite/MainPage.html` | No build step, no dependencies |

## Definition of done

1. The relevant checks above ran and are green, with real output or counts in the PR. A SecureGate run whose `target/surefire-reports/*.xml` says `tests="0"` did not run — say so. For `DramaFetch/`, green means `ruff check`, `ruff format --check`, `mypy` and `pytest` all pass (plus `pytest -m integration` when a Chromium is available).
2. Prettier left no diff under `FullStackHub/`; no lint rule loosened, no test skipped, no `any` added.
3. Documentation that states what you changed — README, the CLAUDE.md files, `OPERATIONS.md`, counts, commands, links — is updated in the same PR.
4. The PR follows `.github/pull_request_template.md`: Summary · Changes · How I verified · Risks & rollback · `Opened by:`.
5. Nothing secret in the diff, the logs or the PR body.

## Guardrails

1. Never push to `main`. Always a branch + a pull request. Never force-push, rewrite history, or merge your own PR — a human merges.
2. One PR per shift run, small and reviewable (aim for under 200 changed lines excluding lockfiles). If nothing is needed, do nothing: no empty PRs, no "all good" issues or comments.
3. Run the project's own checks before opening a PR (FullStackHub: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`; services: `pytest`; SecureGate: `./mvnw -q verify` when a local stack is up). Report the real results.
4. Never weaken, skip or quarantine a test, loosen a lint rule, or add `any` to get green.
5. Respect each project's architectural rules (Shipping Hub: only `apps/api` touches the DB; `tracking_events` and `ledger_entries` are append-only; state transitions come from `packages/shared`; every money operation has an `idempotency_key` + transaction; public endpoints are rate-limited. SecureGate: black-box only; Screenplay for UI; Karate for API; explicit waits only).
6. Never commit or print secrets; use the seeded demo accounts only against local or CI stacks.
7. Report truthfully: failing is failing (with output), skipped is skipped (SecureGate skips when the stack is down — a run with 0 failures and N skipped is NOT a pass).
8. When a change needs a human decision (schema, money, auth, deploy config, dependency majors), open an issue instead of guessing.

## Branches, PRs and issues

- Branches for agent work: `agents/<shift>/<YYYY-MM-DD>`, e.g. `agents/nightly-maintenance/2026-10-29`. Humans use any descriptive branch name.
- PR titles are conventional commits: `chore(agents): nightly maintenance 2026-10-29`, `fix(agents): …`, `docs(agents): …`, `chore(deps): …`. Every agent PR carries the `agent` label and fills the template's `Opened by:` line with the shift name.
- Labels: `agent` (work by/for agents) · `incident` (uptime) · `dependencies` (Dependabot) · `security` · `maintenance` · `bug`.
- Issue titles: `🚨 Production incident: Shipping Hub is unhealthy` (label `incident`; opened, updated and closed by the Uptime patrol workflow) · `🧪 Nightly maintenance failed: <YYYY-MM-DD>` (labels `agent`, `maintenance`) · `🔐 Weekly security review: <YYYY-MM-DD>` (labels `agent`, `security`).
- To ask the on-call agent for something, mention `@claude` in an issue or PR comment, or open an issue with the "Ask the on-call agent" template (`.github/ISSUE_TEMPLATE/agent-task.yml`).
- Humans merge. Agents never merge, never force-push, never rewrite history.
