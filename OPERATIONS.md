# OPERATIONS.md — Autonomous maintenance

The operations manual for this repository: who does the work (the agent roster), when (the shifts), where (GitHub Actions and Claude Code cloud), under which rules (the guardrails), and how a human watches, audits and intervenes. The headline is literal — the three projects are maintained around the clock by Claude Code agents — and so is the last word: a human reviews and merges everything.

## 1. Why

A portfolio usually shows code. This one also shows operations: a live system (Shipping Hub on Railway), the suite that tests it black-box (SecureGate), and the routine work that keeps both healthy — uptime checks, regression runs, dependency updates, security reviews, documentation that matches the code — done by agents on a schedule and reviewed by a human.

The trigger was concrete. The last commit before this refresh was 2026-07-11. After 60 days without repository activity, GitHub automatically disabled the scheduled SecureGate nightly (its last scheduled run was 2026-09-10), so the regression suite silently stopped running. Nothing was broken, but nothing was being checked either. The agents remove that failure mode: they produce regular commits and pull requests (which keep GitHub schedules enabled), they probe the live app every 30 minutes, and they turn silent decay into visible issues and small PRs.

Design principles:

- Agents propose, humans decide: every change is a pull request, every judgement call is an issue.
- Small and boring: one PR per shift run, no empty PRs, no "all good" noise.
- Truthful reporting: skipped is not passed; a failing check is reported with its output.
- Each project keeps its own rules (`FullStackHub/CLAUDE.md`, `SecureGate/CLAUDE.md`); the agents follow them, they do not reinterpret them.

## 2. Roster

Subagents are Markdown files with YAML frontmatter (`name`, `description`, `tools`, `model`, `color`); the body is the agent's system prompt. Model policy: `inherit` (the session's model) for developer, reviewer and auditor agents; `haiku` for the two report-only `test-runner`s. "all" in the Tools column means the frontmatter omits `tools`, so the agent inherits every tool of the session. Root agents work from the repository root and read the relevant project `CLAUDE.md` before touching that project. Command restrictions ("read-only usage", "read-only `git diff`/`log`/`show`/`status`") are instructions in the agent body; hard blocks live in `.claude/settings.json`, seeded by a human from `.claude/settings.example.json` and committed (see *Project settings* below).

### 2.1 Root — `.claude/agents/`

| Agent | Scope | Tools | Model |
| --- | --- | --- | --- |
| `sre-patrol` (red) | Reads the latest *Uptime patrol*, *CI* and *SecureGate CI* runs (GitHub MCP tools when available, otherwise `gh api` or `curl https://api.github.com/...`), open `incident` issues and recent PR check states; diagnoses failures from logs; writes a severity-ordered status report and, when the cause is in-repo (a workflow bug, a flaky test, a broken script), the exact fix for `repo-steward` | Read, Grep, Glob, Bash (read-only usage) + read-only GitHub MCP tools (`mcp__github__actions_list`, `actions_get`, `get_job_logs`, `get_check_run`, `list_issues`, `issue_read`, `search_issues`, `list_pull_requests`, `pull_request_read`) | inherit |
| `repo-steward` (blue) | Repository hygiene: CI triage and small fixes, Dependabot PR review (reads changelogs and CI, comments a verdict), lockfile regeneration only with the project tooling (`pnpm install`, `./mvnw`), keeps the PR template filled, opens PRs following section 6 | all | inherit |
| `qa-regression` (green) | Runs Vitest (shared + API; PostgreSQL via `.claude/scripts/local-postgres.sh`), pytest (both services, in their `.venv`s) and the Karate API suite (`cd SecureGate && ./mvnw -q verify` after `.claude/scripts/local-api.sh`); reads `SecureGate/target/surefire-reports/*.xml` and `SecureGate/target/karate-reports/karate-summary-json.txt` to count passed/failed/skipped; reports only failures with file:line and a likely cause; never edits product code | Bash, Read, Grep, Glob | inherit |
| `security-auditor` (orange) | `pnpm audit --audit-level=moderate` (FullStackHub), `pip-audit` installed into each service `.venv` (or `pip list --outdated`), `./mvnw -q versions:display-dependency-updates` (SecureGate), a secret-pattern grep (AWS keys, `sk-`, `ghp_`, Slack tokens, PEM headers — the exact command is in 3.3), review of `apps/api/src/app.ts` (helmet, CORS, rate limits), `apps/api/src/auth/*`, `apps/api/src/env.ts`, the root `Dockerfile` base image and the workflow `permissions:` blocks; findings ordered by severity, each with a proposed patch; read-only | Read, Grep, Glob, Bash | inherit |
| `docs-keeper` (purple) | Verifies that README/CLAUDE/AGENTS/OPERATIONS/DEMO claims match the code — scenario counts via `grep -c "^\s*Scenario"`, commands that exist in `package.json`/`pom.xml`, workflow names and crons, agent names — fixes drift and keeps the roster and shift tables in sync; docs only | Read, Grep, Glob, Edit, Write | inherit |

### 2.2 FullStackHub — `FullStackHub/.claude/agents/`

| Agent | Scope | Tools | Model |
| --- | --- | --- | --- |
| `frontend-dev` | `apps/web`: Next.js 15 App Router, Tailwind, next-intl (copy only in `messages/*.json`), SEO (metadata, OG, sitemap, JSON-LD), Server Components by default; definition of done = lint, format, typecheck, tests | all | inherit |
| `backend-dev` | `apps/api`: Express 5, Prisma, the state machine from `packages/shared`, append-only tracking events and ledger entries, idempotent money operations; Vitest + Supertest integration tests for every endpoint | all | inherit |
| `python-services` | `services/pricing` (`POST /quote`) and `services/labels` (`POST /label`): stateless FastAPI, Pydantic contracts, `GET /health`, pytest in each `.venv` | all | inherit |
| `code-reviewer` | Reviews the diff, read-only: hardcoded secrets, input validation, invalid state transitions, mutations of append-only tables, `any`, Prettier/format, i18n keys present in both `messages/*.json`, Zod at the edges | Read, Grep, Glob, Bash (read-only `git diff`/`log`/`show`/`status`) | inherit |
| `test-runner` | Vitest for `packages/shared` and `apps/api` (`pnpm test` from `FullStackHub/`; the API suite needs PostgreSQL on `localhost:5432` with the credentials in `apps/api/.env.test` → `../.claude/scripts/local-postgres.sh`) and pytest for `services/pricing` and `services/labels` in their own `.venv`s; reports only failures. There is no Playwright suite — E2E lives in SecureGate | Bash, Read | haiku |

### 2.3 SecureGate — `SecureGate/.claude/agents/`

| Agent | Scope | Tools | Model |
| --- | --- | --- | --- |
| `api-test-engineer` | Karate: one feature per resource, `helpers/*.feature` via `call`, `match` contracts, `karate-config.js` environments, `TrackingCodes` Java interop, `freshEmail()`; the Postman collection mirrors new endpoints; runs `./mvnw -q verify` against a local stack (`../.claude/scripts/local-postgres.sh` + `../.claude/scripts/local-api.sh`) | all | inherit |
| `ui-test-engineer` | Screenplay: `screenplay/ui` Targets, `tasks`, `questions`; no selectors in step definitions; explicit waits; `serenity.conf`; the headless flag. The UI suite needs Chrome — in the cloud environment it says so and hands the run to SecureGate CI | all | inherit |
| `bdd-engineer` | Gherkin in `features/ui/*.feature` (tags `@ui`/`@public`); step definitions delegate to Screenplay tasks and questions; Serenity living documentation | all | inherit |
| `devsecops` | The pipeline `.github/workflows/securegate-ci.yml`: SonarQube step, Serenity/Karate report artifacts, Chrome in CI, the Newman step; how to re-run it and read its artifacts | all | inherit |
| `code-reviewer` | Test-code review, read-only: flakiness (`Thread.sleep`, implicit waits), weak assertions (`status == 200` only), leaked secrets, naming | Read, Grep, Glob, Bash (read-only `git diff`/`log`/`show`/`status`) | inherit |
| `test-runner` | `./mvnw -q verify` (API) or `-Pui -Dheadless.mode=true` (UI, CI only); reads `target/surefire-reports/*.xml` and reports tests/failures/errors/skipped — "all skipped" means the stack was down and is reported as such | Bash, Read | haiku |

## 3. Shifts

A shift is a scheduled job. Its prompt is a complete, standalone Markdown file in `.claude/shifts/`: identity and goal, environment notes (cloud network limits, the helper scripts), step-by-step, decision rules, exact outputs (branch, PR and issue titles with labels), the guardrails of section 5, and the report format. The Claude Code cloud scheduled task tells a fresh cloud session to read `.claude/shifts/<name>.md` on the default branch and follow it (the stored prompt is described in 4.2); the session clones the repository, does the work and ends. GitHub Actions workflows cover what the cloud cannot reach (the live app, a browser) and what must react to events (`@claude` mentions, PRs, pushes).

| Shift | Cadence | Runtime | Definition | Output |
| --- | --- | --- | --- | --- |
| SRE patrol | every 6 hours — cron `28 */6 * * *` UTC | Claude Code cloud scheduled task `Autonomous maintenance · SRE patrol` | `.claude/shifts/sre-patrol.md` | status report; `fix(agents): …` PR, or one diagnosis comment on the incident issue, or one issue |
| Nightly maintenance | daily 08:40 UTC (03:40 Panama) — cron `40 8 * * *` | Claude Code cloud scheduled task `Autonomous maintenance · Nightly maintenance` | `.claude/shifts/nightly-maintenance.md` | `chore(agents): nightly maintenance <date>` PR, or `🧪 Nightly maintenance failed: <date>` issue, or nothing |
| Weekly security review | Mondays 10:20 UTC — cron `20 10 * * 1` | Claude Code cloud scheduled task `Autonomous maintenance · Weekly security review` | `.claude/shifts/weekly-security-review.md` | `chore(deps): weekly security bumps <date>` PR and/or `🔐 Weekly security review: <date>` issue, or nothing |
| Uptime patrol | every 30 minutes + manual | GitHub Actions `Uptime patrol` | `.github/workflows/uptime-patrol.yml` | `🚨 Production incident: Shipping Hub is unhealthy` issue — opened, updated once per failing run, closed on recovery |
| Claude on-call | on `@claude` in issues, PR comments and reviews | GitHub Actions `Claude on-call` | `.github/workflows/claude.yml` | comments; commits on a `claude/…` branch and posts a link to open the PR when code changes are needed |
| CI | push to `main`, every PR, manual | GitHub Actions `CI` | `.github/workflows/ci.yml` | check status |
| SecureGate CI | PRs touching `SecureGate/` or `FullStackHub/`; pushes to `main` touching SecureGate; nightly 06:00 UTC; manual | GitHub Actions `SecureGate CI` | `.github/workflows/securegate-ci.yml` | check status + the `securegate-reports` artifact |
| Dependabot | npm, pip and Maven weekly, Mondays 04:00 America/Panama (grouped minor/patch, at most 5 open PRs per ecosystem); GitHub Actions monthly, grouped | GitHub Dependabot | `.github/dependabot.yml` | PRs labelled `dependencies` |

### 3.1 SRE patrol

- **Trigger:** cloud scheduled task `Autonomous maintenance · SRE patrol`, cron `28 */6 * * *` (UTC), resuming the shift's standing session (the checkout is synced to the default branch first).
- **Runtime:** Claude Code cloud. It normally needs only the GitHub API (reachable from the cloud); it starts a local stack (`.claude/scripts/local-api.sh`, then `cd SecureGate && ./mvnw -q -B verify`) only to reproduce a SecureGate CI failure before proposing a fix.
- **Steps:** (1) through the GitHub API/MCP, read the last 24 hours of *Uptime patrol*, *CI* and *SecureGate CI* runs and any open `incident`, `maintenance` or `security` issues; (2) if everything is green and no incident is open, stop and report "no action"; (3) if an incident is open, read the failing probe output — when the cause is in-repo (a bad workflow, a bad URL, configuration in `start.sh`/`Dockerfile`) branch `agents/sre-patrol/<date>` and open a fix PR; when it is the hosting (Railway down, the database) comment once on the incident issue with the diagnosis and the human action needed (restart, check `DATABASE_URL`), and do not spam; (4) if CI or SecureGate CI failed on `main`, diagnose from the logs — a fix PR when it is a flaky or broken test or workflow, otherwise open or update one issue; (5) report.
- **Outputs:** a short bullet report in the session; at most one PR (`fix(agents): …`, label `agent`), one comment or one issue per run.
- **Expected cost/duration:** the cheapest shift — read-only API calls, a few minutes when everything is green; four runs a day.

### 3.2 Nightly maintenance

- **Trigger:** cloud scheduled task `Autonomous maintenance · Nightly maintenance`, cron `40 8 * * *` (08:40 UTC = 03:40 Panama), resuming the shift's standing session (the checkout is synced to the default branch first).
- **Runtime:** Claude Code cloud, against a stack the shift starts itself (PostgreSQL 16 + the API; no Docker, no browser).
- **Steps:** (1) fresh branch `agents/nightly-maintenance/<date>`; (2) `pnpm install --frozen-lockfile`, `.claude/scripts/local-postgres.sh`, `.claude/scripts/run-checks.sh` (lint, format:check, typecheck, Vitest, pytest); (3) `.claude/scripts/local-api.sh`, then `cd SecureGate && ./mvnw -q verify` (Karate API) and read the surefire and Karate summaries — `tests="0"` means the suite did not run; (4) review the open Dependabot PRs: read the CI state and the changelog, comment a one-paragraph verdict (safe to merge / needs attention), never merge; (5) docs drift pass (counts, commands, links); (6) pick at most one small improvement when there is obvious value — a missing edge-case test, a typo, a doc fix, a dead link — never a behaviour change in money, state-machine or auth code; (7) if anything changed, run the checks again and open one PR titled `chore(agents): nightly maintenance <date>` with the check results table in the body; if a check failed and cannot be fixed safely, open or update `🧪 Nightly maintenance failed: <date>` (labels `agent`, `maintenance`); if nothing changed and nothing failed, no PR and no issue; (8) report.
- **Outputs:** at most one PR and/or one issue; verdict comments on Dependabot PRs.
- **Expected cost/duration:** the longest and most expensive shift — a dependency install, a database start, the four FullStackHub checks, two pytest suites and the Karate suite, twice when something changed. Baseline measured in the cloud environment on 2026-10-28 with a stack up: `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and `pnpm test` green; pytest pricing 41 passed, labels 13 passed.

### 3.3 Weekly security review

- **Trigger:** cloud scheduled task `Autonomous maintenance · Weekly security review`, cron `20 10 * * 1` (Mondays 10:20 UTC), resuming the shift's standing session (the checkout is synced to the default branch first).
- **Runtime:** Claude Code cloud (npm, PyPI and Maven Central are reachable for the audits).
- **Steps:** `pnpm audit` (FullStackHub); `pip-audit` in each service `.venv`; `./mvnw -q versions:display-dependency-updates` (SecureGate); the secret grep below; configuration review — helmet, CORS, rate limits, JWT TTLs, cookie flags in `apps/web/src/lib/auth/cookies.ts`; the root `Dockerfile` base image; the workflow `permissions:` blocks.

  ```bash
  git grep -nE "(AKIA|sk-|ghp_|xox[bp]-|-----BEGIN)"
  ```

- **Outputs:** patch/minor bumps whose checks are green → PR `chore(deps): weekly security bumps <date>` on `agents/weekly-security-review/<date>`; everything else → issue `🔐 Weekly security review: <date>` (labels `agent`, `security`) with severity-ordered findings and a proposed patch each; no findings → no issue.
- **Expected cost/duration:** moderate — the audits are quick, a bump PR adds a full check run; once a week.

### 3.4 Workflows that behave like shifts

- **Uptime patrol** (`.github/workflows/uptime-patrol.yml`; every 30 minutes and on demand) probes `https://shipping-hub.up.railway.app` — `/en`, `/en/tracking/PTY-2026-001001-0` (the body must contain the code), `/es/quote`, `/sitemap.xml` — with retries, writes an endpoint · status · time · result table to the step summary, opens/updates or closes the incident issue, and fails the run when unhealthy so the badge turns red. A one-commit checkout only to run `.github/scripts/uptime-probe.sh` (the probe logic, runnable locally: `BASE_URL=https://shipping-hub.up.railway.app .github/scripts/uptime-probe.sh`); no repository secrets. See section 8 and `DEPLOY.md` → Monitoring & incidents.
- **Claude on-call** (`.github/workflows/claude.yml`) runs `anthropics/claude-code-action@v1` in interactive mode: it answers `@claude` mentions in issue comments, PR comments and PR reviews, and new issues whose body or title contains `@claude`. Until a token secret exists it writes a setup notice to the step summary and exits green (section 4.1).
- **CI** and **SecureGate CI** are unchanged in purpose; both now accept `workflow_dispatch`, so they can be run by hand from the Actions tab.
- **Dependabot** (`.github/dependabot.yml`): npm (`/FullStackHub`), pip (`/FullStackHub/services/pricing`, `/FullStackHub/services/labels`) and Maven (`/SecureGate`) weekly on Mondays at 04:00 America/Panama with grouped minor-and-patch updates, at most 5 open PRs per ecosystem, label `dependencies`, commit prefix `chore(deps)`; GitHub Actions (`/`) monthly, grouped, same limit and label. The nightly maintenance shift reviews these PRs; a human merges.
- **Sync labels** (`.github/workflows/labels.yml`) creates or updates the six labels of section 6 — name, colour, description — from `.github/labels.json`; it never deletes a label. It runs on `workflow_dispatch` and on a push to `main` that touches `.github/labels.json` or the workflow itself, so the merge that adds the file runs it once. A fresh repository has only GitHub's default labels; if Issues → Labels does not show `agent`, `incident`, `dependencies`, `security` and `maintenance`, run it by hand (Actions → Sync labels → **Run workflow**) — without them the issue templates, Dependabot and the shifts silently drop their labels and every `label:agent` / `label:incident` filter shows nothing.

## 4. Runtimes

### 4.1 GitHub Actions

| Workflow file | `name:` | Trigger |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `CI` | push to `main`; every pull request; `workflow_dispatch` |
| `.github/workflows/securegate-ci.yml` | `SecureGate CI` | PRs touching `SecureGate/**` or `FullStackHub/**`; pushes to `main` touching `SecureGate/**`; nightly `0 6 * * *` UTC; `workflow_dispatch` |
| `.github/workflows/uptime-patrol.yml` | `Uptime patrol` | `*/30 * * * *` (every 30 minutes); `workflow_dispatch` |
| `.github/workflows/claude.yml` | `Claude on-call` | `issue_comment` created, `pull_request_review_comment` created, `pull_request_review` submitted, `issues` opened — only when the text contains `@claude` |
| `.github/workflows/labels.yml` | `Sync labels` | `workflow_dispatch`; push to `main` touching `.github/labels.json` or the workflow itself — creates or updates the six labels from `.github/labels.json`, never deletes one |
| `.github/dependabot.yml` | Dependabot | weekly Mondays 04:00 America/Panama (npm, pip, Maven — grouped minor/patch, at most 5 open PRs each); GitHub Actions monthly, grouped |

**Enabling Claude on-call.** The workflow needs one secret:

1. On your machine, with a Claude Pro or Max subscription, run `claude setup-token` and copy the token.
2. GitHub → the repository → Settings → Secrets and variables → Actions → New repository secret → name `CLAUDE_CODE_OAUTH_TOKEN`. Alternative: `ANTHROPIC_API_KEY` from the Anthropic Console, billed per token.
3. The Claude GitHub App must be installed on the repository — it already is; it is what the cloud sessions use. The job authenticates as that app (no `github_token` is passed), so CI runs on the commits it pushes.
4. Mention `@claude` in any issue or PR comment, or open an issue from the "Ask the on-call agent" template. Only humans with write access trigger it; bots are ignored unless allow-listed.

Until the secret exists, the job's `Not configured yet` step writes these instructions to its summary and the job still succeeds, so the badge is never red for configuration reasons.

**Schedules and inactivity.** GitHub disables scheduled workflows in a public repository after 60 days without repository activity — this is exactly what happened to the SecureGate nightly (last scheduled run 2026-09-10, last commit 2026-07-11). A workflow in that state (`disabled_inactivity`) does not come back by itself: a push does not re-enable it (verified on 2026-10-29 — after this refresh was pushed, SecureGate CI stayed disabled and did not run on its pull request). A human re-enables it once; from then on the agents' pushes provide the activity that keeps it enabled. To re-enable one by hand: Actions tab → select the workflow in the left sidebar → the banner says the scheduled workflow was disabled for inactivity → **Enable workflow**. CI, SecureGate CI, Uptime patrol and Sync labels also have `workflow_dispatch`, so they can be run on demand with **Run workflow**; Claude on-call is event-driven only — mention `@claude` again (or re-run a past run from its page).

### 4.2 Claude Code cloud scheduled tasks

A scheduled task in Claude Code (claude.ai/code) resumes a standing cloud session on a cron, with a stored prompt — one standing session per shift, created with the repository as its source, which is what gives it the checkout, the git credentials and the GitHub MCP tools (a fresh session started by a task cannot attach the repository; verified on 2026-10-29, when the first version of the tasks could reach neither the GitHub API nor the MCP tools). Each firing is treated as an independent run: the session syncs the checkout to the default branch (`git fetch origin && git checkout -B main origin/main`), works with the repository's `.claude/` configuration (agents, settings, hooks, scripts), and ends when the prompt is done. Every run is an ordinary session: you can open it, read each command and output, and reply to it.

| Task name | Cron (UTC) | Panama (UTC−5) | Prompt (summary) |
| --- | --- | --- | --- |
| `Autonomous maintenance · SRE patrol` | `28 */6 * * *` | 19:28 · 01:28 · 07:28 · 13:28 | Sync the checkout, then read `.claude/shifts/sre-patrol.md` on the default branch and follow it |
| `Autonomous maintenance · Nightly maintenance` | `40 8 * * *` | 03:40 daily | Sync the checkout, then read `.claude/shifts/nightly-maintenance.md` on the default branch and follow it |
| `Autonomous maintenance · Weekly security review` | `20 10 * * 1` | Mondays 05:20 | Sync the checkout, then read `.claude/shifts/weekly-security-review.md` on the default branch and follow it |

The prompt is deliberately short and the shift file in the repository is the source of truth, so changing a shift is a normal reviewed PR, not a settings change. The stored prompt bootstraps the checkout (attaches `brunocarbone98/projects` with push access, loads the GitHub MCP tools), tells the session to read and follow `.claude/shifts/<name>.md` on the default branch — after the root `CLAUDE.md` and `AGENTS.md` — repeats the hard guardrails (never push to `main`, never force-push, never merge, never weaken a test, never print secrets), and, if the file is missing because the refresh is not merged yet, does nothing else and ends with a one-line "waiting for the merge" report. Everything written to the repository or to GitHub is in English; the final report to the maintainer is in Spanish.

**Managing the tasks.** The three tasks already exist: they were created on 2026-10-29 together with this refresh and are listed in claude.ai/code → scheduled tasks. Do not create them again — a second task per shift would race the first for the same `agents/<shift>/<date>` branch and duplicate verdict comments and issues, against guardrail 2. Until the pull request that introduces the shifts (#35) is merged, each run only reports that it is waiting for that merge. From the scheduled-task list a task can be paused, resumed, edited or deleted; prefer pausing over deleting to keep its run history. A paused task never fires; a resumed one fires at its next cron slot.

**Running a shift by hand.** From the repository root, non-interactively:

```bash
claude -p "$(cat .claude/shifts/nightly-maintenance.md)"
```

or, in an interactive Claude Code session at the repository root: "run the nightly maintenance shift". The same guardrails apply, and the result is still a branch and a PR for a human to review.

**Network limits of the cloud environment.** It reaches npm, PyPI, Maven Central, GitHub (api/raw/web) and code.claude.com; it cannot reach `railway.app`, `github.io`, `shields.io` or the Chrome-for-Testing downloads. Hence live-app probes and the Selenium UI suite run only in GitHub Actions, while Vitest, pytest and the Karate API suite run in the cloud against a stack the shift starts with `.claude/scripts/local-postgres.sh` and `.claude/scripts/local-api.sh` (PostgreSQL 16 binaries at `/usr/lib/postgresql/16/bin`, run as the `postgres` user when the session is root; no Docker daemon).

### 4.3 Project settings — `.claude/settings.example.json`

Claude Code reads a committed `.claude/settings.json` for permission rules and hooks. This repository
ships that file as **`.claude/settings.example.json`** on purpose: an agent must never grant itself
permissions, so no agent here ever writes `settings.json`. A human enables it once:

```bash
cp .claude/settings.example.json .claude/settings.json
```

then commit `.claude/settings.json`: it is project configuration and deliberately not gitignored (only
`settings.local.json` is), and cloud sessions and fresh clones get the allow-list and the hook only from
the committed file — until then the cloud shifts run without them.

What it does: pre-allows the safe recurring commands (FullStackHub `pnpm lint` / `format:check` /
`typecheck` / `test`, `./mvnw`, `pytest`, read-only `git status` / `diff` / `log`,
`.claude/scripts/*`); hard-blocks force-pushes, pushes to `main` and reads of real `.env` files (the
committed `.env.example` and `.env.test` stay readable); and wires `.claude/hooks/format-on-save.sh`
as a `PostToolUse` hook so every `Edit`/`Write` under `FullStackHub/` is formatted with Prettier (the
hook always exits 0, so it can never block a session). Allow rules in a committed project file take
effect after you trust the workspace; deny rules apply immediately. Personal overrides go in
`.claude/settings.local.json` (gitignored). Cloud sessions on this single repository read the
committed `settings.json` too.

## 5. Guardrails

Quoted verbatim; the same text is in `AGENTS.md` and in every shift prompt.

1. Never push to `main`. Always a branch + a pull request. Never force-push, rewrite history, or merge your own PR — a human merges.
2. One PR per shift run, small and reviewable (aim for under 200 changed lines excluding lockfiles). If nothing is needed, do nothing: no empty PRs, no "all good" issues or comments.
3. Run the project's own checks before opening a PR (FullStackHub: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`; services: `pytest`; SecureGate: `./mvnw -q verify` when a local stack is up). Report the real results.
4. Never weaken, skip or quarantine a test, loosen a lint rule, or add `any` to get green.
5. Respect each project's architectural rules (Shipping Hub: only `apps/api` touches the DB; `tracking_events` and `ledger_entries` are append-only; state transitions come from `packages/shared`; every money operation has an `idempotency_key` + transaction; public endpoints are rate-limited. SecureGate: black-box only; Screenplay for UI; Karate for API; explicit waits only).
6. Never commit or print secrets; use the seeded demo accounts only against local or CI stacks.
7. Report truthfully: failing is failing (with output), skipped is skipped (SecureGate skips when the stack is down — a run with 0 failures and N skipped is NOT a pass).
8. When a change needs a human decision (schema, money, auth, deploy config, dependency majors), open an issue instead of guessing.

Verified behaviour behind rule 7: with no Shipping Hub reachable, `./mvnw -q verify` exits 0 and `SecureGate/target/surefire-reports/TEST-com.securegate.api.ApiKarateTest.xml` reports `tests="0"` — the preflight aborts the suite before any scenario runs. `tests="0"` means "did not run", never "passed"; every runner and shift checks that count.

## 6. Conventions

| Item | Convention |
| --- | --- |
| Labels | `agent` (work by/for agents) · `incident` (uptime) · `dependencies` (Dependabot) · `security` · `maintenance` · `bug` — defined in `.github/labels.json` and created/updated by the `Sync labels` workflow (`.github/workflows/labels.yml`), which runs on the merge that adds the file and on **Run workflow**; if Issues → Labels does not show them, run it once from the Actions tab, otherwise the issue templates, Dependabot and the shifts cannot apply them |
| Branches | `agents/<shift>/<YYYY-MM-DD>`, e.g. `agents/nightly-maintenance/2026-10-29`; Claude on-call uses the action's default `claude/` prefix |
| PR titles | `chore(agents): nightly maintenance 2026-10-29` · `fix(agents): …` · `docs(agents): …` · `chore(deps): …` (the weekly review uses `chore(deps): weekly security bumps <date>`; Dependabot uses its `chore(deps)` prefix) |
| PR body | `.github/pull_request_template.md`: Summary · Changes · How I verified (a checkbox list with the exact commands per project) · Risks & rollback · `Opened by:` (human, or the shift name) · the reminder that agents never merge. Every agent PR carries the `agent` label |
| Issue titles | `🚨 Production incident: Shipping Hub is unhealthy` (label `incident`; at most one open, managed by Uptime patrol) · `🧪 Nightly maintenance failed: <YYYY-MM-DD>` (labels `agent`, `maintenance`) · `🔐 Weekly security review: <YYYY-MM-DD>` (labels `agent`, `security`) |
| Issue templates | `.github/ISSUE_TEMPLATE/agent-task.yml` — "Ask the on-call agent", title prefix `[agent] `, label `agent`, a task field that starts with `@claude ` · `bug-report.yml` — "Bug report", label `bug` · `config.yml` — blank issues allowed, contact links to the live app and the SecureGate reports in Actions |
| Commits | Conventional commits in English, imperative mood |

## 7. Watching & auditing

| What | Where |
| --- | --- |
| Every workflow run with its step summary (the Uptime patrol probe table, the Claude on-call setup notice) | <https://github.com/brunocarbone98/projects/actions> |
| Agent pull requests | <https://github.com/brunocarbone98/projects/pulls?q=is%3Apr+label%3Aagent> |
| Dependabot pull requests | <https://github.com/brunocarbone98/projects/pulls?q=is%3Apr+label%3Adependencies> |
| Incidents, open and closed | <https://github.com/brunocarbone98/projects/issues?q=label%3Aincident> |
| Security findings | <https://github.com/brunocarbone98/projects/issues?q=label%3Asecurity> |
| Failed nightly runs | <https://github.com/brunocarbone98/projects/issues?q=label%3Amaintenance> |
| Shift sessions — the full transcript: every command, output and decision | the scheduled-task list in claude.ai/code → the task → its sessions |
| SecureGate reports from CI | a SecureGate CI run → Artifacts → `securegate-reports` (Serenity HTML, Karate HTML, surefire XML) |
| Badges | the top of `README.md`: CI, SecureGate CI, Uptime patrol, Claude on-call |

Rules of thumb when auditing: a PR without the `agent` label and a filled `Opened by:` line was not opened by a shift; many comments on an incident issue mean Uptime patrol kept failing (one comment per failing run) — look for the SRE patrol diagnosis among them; a shift session that produced neither a PR nor an issue should end with a "no action" report.

## 8. Incident flow

1. **Detect** — `Uptime patrol` probes the live app every 30 minutes: `/en`, `/en/tracking/PTY-2026-001001-0` (the body must contain the code), `/es/quote`, `/sitemap.xml`, each with retries. Any failure fails the run and turns the badge red.
2. **Open** — the workflow opens `🚨 Production incident: Shipping Hub is unhealthy` (label `incident`) with the probe table, the run link and what a human should check. While the outage lasts, each failing run adds one comment with the new table; there is never a second open incident issue.
3. **Diagnose** — the next `SRE patrol` run (at most six hours later) reads the failing probe output. In-repo cause (a workflow bug, a wrong URL, `start.sh`/`Dockerfile` configuration) → branch `agents/sre-patrol/<date>` and a `fix(agents): …` PR. Hosting cause (Railway down, the database) → one diagnosis comment on the incident issue with the human action needed.
4. **Act (human)** — Railway → the service → Deployments → read the latest log, then Restart or redeploy; the usual culprit is `DATABASE_URL` resolving to an empty string (`DEPLOY.md` → Environment variables). Merge the fix PR if there is one; Railway redeploys from `main` (watch paths `FullStackHub/**`, `Dockerfile`, `start.sh`).
5. **Recover** — the first green `Uptime patrol` run comments `Recovered — all probes green at <UTC time>` with the run link and closes the issue as completed. The badge turns green.

If an incident is open during a demo, it is the demo: the issue, the SRE patrol comment and the recovery comment show the whole loop (`DEMO.md` → If something breaks).

**Unobserved runs.** When Railway's edge answers the monitor with its bot-protection page
("Checking your browser…") instead of the app, the probe reports `🛡️ challenged` and the run ends
as **Unobserved** (`healthy=unknown`): the job fails with a distinct "patrol is blind" message and
touches no incident, because the app's state is simply not known. The SRE patrol treats it as a
monitoring gap, not as an outage: it verifies the app another way when it can and reports the
gap; the human decision is whether Railway should let automated monitors through.

## 9. FAQ

**What does this cost?** GitHub Actions minutes are free for public repositories on the standard runners; Uptime patrol is a few seconds of `curl` 48 times a day. The Claude Code cloud shifts are billed against the maintainer's Claude plan, and Claude on-call against the same subscription token (or per token with `ANTHROPIC_API_KEY`). The SRE patrol is read-only and cheap; the nightly maintenance is the expensive one because it runs every suite — pause that task in claude.ai/code to cut most of the cost.

**Is this safe?** Agents never push to `main` and never merge; everything lands as a PR or an issue for a human. The workflows run with the minimum permissions (Uptime patrol: `contents: read`, `issues: write`). Secrets live in GitHub Actions secrets, never in the repository; the demo accounts are used only against local or CI stacks. Branch protection on `main` (require a pull request and a green `CI`) turns the convention into a hard rule — recommended.

**What if an agent breaks something?** It cannot reach production without a human merge. If a merged agent PR turns out to be wrong, revert it (GitHub → the PR → **Revert**) — that is a normal PR too, and Railway redeploys the previous state. If a session misbehaves, pause its scheduled task and read the transcript.

**Who merges?** Always a human. Dependabot PRs get a verdict comment from the nightly shift; the human merges or closes them.

**How do I add a new shift?** (1) Write `.claude/shifts/<name>.md` — identity and goal, environment notes, steps, decision rules, exact outputs (branch, PR and issue titles with labels from section 6), the guardrails verbatim, the report format. (2) Add it to the tables in `README.md`, `CLAUDE.md` and this file; `docs-keeper` checks that they agree. (3) Merge it through a PR. (4) For the new shift only — the three existing tasks already exist (section 4.2) — create in claude.ai/code a scheduled task named `Autonomous maintenance · <Shift name>` with its cron and a prompt modelled on the existing ones: the bootstrap, "read `.claude/shifts/<name>.md` on the default branch and follow it", the hard rules. (5) If the shift needs the live app or a browser, make it a GitHub Actions workflow instead.

**How do I ask the on-call agent for something?** Comment `@claude <request>` in any issue or PR, or open an issue from the "Ask the on-call agent" template. It answers in a comment and, when code changes are needed, pushes a `claude/…` branch and posts a link to open the PR (the action never opens PRs itself).

**Why did the SecureGate nightly stop in September?** GitHub disabled it after 60 days without repository activity (last scheduled run 2026-09-10; last commit 2026-07-11). It stays disabled until a human re-enables it once (Actions → SecureGate CI → **Enable workflow**; section 4.1); from then on the shifts produce the activity that keeps it enabled.
