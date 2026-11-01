# CLAUDE.md — projects monorepo

@AGENTS.md

For Claude Code sessions opened at the repository root. `AGENTS.md` (imported above) holds the shared rules — map, conventions, commands, definition of done, guardrails, branch/PR/issue conventions. This file adds only what is specific to Claude Code.

## Routing

- Working inside `FullStackHub/` → read `FullStackHub/CLAUDE.md` first (Shipping Hub rules, commands, subagents).
- Working inside `SecureGate/` → read `SecureGate/CLAUDE.md` first (black-box QA rules, Karate and Screenplay conventions, subagents).
- Working inside `DramaFetch/` → read `DramaFetch/CLAUDE.md` first (scope and legal limits, the owner's acceptance criteria, module map, the Chrome extension in `DramaFetch/extension/` and its rules, ruff/mypy/pytest and `node --test`/`tsc` commands, the DramaFetch agents, where the TikTok facts live).
- `PersonalWebsite/` has no CLAUDE.md — keep it dependency-free vanilla HTML/CSS/JS (`MainPage.html`, `Portfolio.html`, `favicon.svg`).
- Never edit `FullStackHub/ROADMAP.md` or `SecureGate/ROADMAP.md` (frozen plans, prettier-ignored).

## Claude Code specifics

- `.claude/settings.example.json` holds the project settings an agent must never grant itself. Copy it to `.claude/settings.json` once (a human decision) to pre-allow the safe recurring commands (the FullStackHub lint/format:check/typecheck/test scripts, `./mvnw`, `pytest`, read-only `git status/diff/log`, `.claude/scripts/*`), to hard-block force-pushes and pushes to `main`, and to run `.claude/hooks/format-on-save.sh` after every `Edit`/`Write` (files under `FullStackHub/` are formatted with Prettier, except `ROADMAP.md`, `world-coastlines.ts`, `pnpm-lock.yaml`; the hook always exits 0). Then commit `.claude/settings.json` — project config, not gitignored — so cloud sessions and clones get the allow-list and the hook. Personal overrides go in `.claude/settings.local.json` (gitignored).
- Subagents live in `.claude/agents/` at the root and inside each project. The definition closest to the working directory wins, which is why `FullStackHub/`, `SecureGate/` and `DramaFetch/` each have their own `code-reviewer` and `test-runner`.
- Delegate long suites to `test-runner` and run `code-reviewer` on the diff before opening a PR; both report, neither fixes.
- Imports: a bare `@path` line in a CLAUDE.md imports that file (this one imports `AGENTS.md`); paths in backticks are not imported.

## Fast path per project

The full command list is in `AGENTS.md` → Commands. Repo-level helpers (`set -euo pipefail`, documented at the top of each file):

| Script | Does |
| --- | --- |
| `.claude/scripts/local-postgres.sh` | Starts — or detects and reuses — a throwaway PostgreSQL 16 on 127.0.0.1:5432: user/password `shipping`/`shipping`, databases `shipping_hub` and `shipping_hub_test`; idempotent; runs as root (via `su postgres`) or as a normal user; falls back to `docker compose up -d postgres` when Docker works |
| `.claude/scripts/local-api.sh` | Migrates, seeds and starts the Shipping Hub API on :4000 in the background, waits for `/health`, prints the PID file path |
| `.claude/scripts/run-checks.sh` | FullStackHub `lint` + `format:check` + `typecheck` + `test` and both pytest suites; prints a one-table summary; exit 1 on any failure |
| `.claude/scripts/dramafetch-watch.sh` | DramaFetch's upstream watch (`DramaFetch/tools/upstream_watch.py`), one Markdown report on stdout: known vulnerabilities of every distribution in `DramaFetch/.venv` (PyPI's per-version OSV data), newer yt-dlp / Playwright / mutagen / curl_cffi releases next to the floors, yt-dlp's TikTok changelog entries, security notes and extractor changes, Chrome Stable next to `minimum_chrome_version`; sets up the venv when it is missing or its dependencies do not import; never contacts TikTok; exit 0 with a report even when a source is unreachable — what it could not check is an Attention item, never `nothing new` |

| Project | Done means |
| --- | --- |
| `FullStackHub/` | `.claude/scripts/run-checks.sh` green (equivalent to `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` plus `pytest` in each service `.venv`); the Prettier hook left no diff; i18n keys exist in both `messages/*.json` |
| `SecureGate/` | `./mvnw -q verify` against a running stack with `tests` greater than 0 in `target/surefire-reports/*.xml`; UI changes are verified by SecureGate CI, the only runtime with Chrome |
| `DramaFetch/` | `cd DramaFetch && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy && .venv/bin/pytest` green, plus `.venv/bin/pytest -m integration` when a Chromium is available (`/opt/pw-browsers/chromium` in the cloud sandbox, otherwise `DRAMAFETCH_CHROMIUM=<path>`), and the Chrome extension's `cd DramaFetch/extension && node --test && npx -y -p typescript@5.9.3 tsc -p jsconfig.json`; no test ever reaches tiktok.com |
| `PersonalWebsite/` | Both pages open from `file://` with zero console errors at desktop and phone widths; no new dependencies |

## Roster

| Agent | Where | Scope |
| --- | --- | --- |
| `sre-patrol` | `.claude/agents/` | Reads Uptime patrol / CI / SecureGate CI runs and open incidents, diagnoses from logs, proposes the exact fix (read-only) |
| `repo-steward` | `.claude/agents/` | Repository hygiene: CI triage and small fixes, Dependabot PR verdicts, lockfiles only via project tooling, PRs per the conventions |
| `qa-regression` | `.claude/agents/` | Runs Vitest, pytest and the Karate API suite against a local stack; reports failures with file:line; never edits product code |
| `security-auditor` | `.claude/agents/` | `pnpm audit`, `pip-audit`, Maven updates, secret grep, auth/CORS/rate-limit/Dockerfile/workflow-permissions review (read-only) |
| `docs-keeper` | `.claude/agents/` | Keeps README, CLAUDE.md, AGENTS.md, OPERATIONS.md and DEMO.md in sync with the code: counts, commands, names, crons |
| `download-guardian` | `.claude/agents/` | Keeps DramaFetch's downloads meeting the owner's acceptance criteria: runs `dramafetch-watch.sh` and DramaFetch's checks, reads upstream changes (yt-dlp's TikTok extractor and changelog, Playwright, mutagen, curl_cffi, Chrome) from primary sources only, ships small cited fixes in both front ends; never commits or crosses DramaFetch's Scope |
| `vuln-sentinel` | `.claude/agents/` | DramaFetch's vulnerability watch (read-only): every installed distribution against PyPI's OSV data, yt-dlp's security notes, the extension's permissions, CSP and message handling, the web UI's token, Host guard and `--out` confinement, cookie values in the repository, the `dramafetch` CI job |
| `frontend-dev` · `backend-dev` · `python-services` | `FullStackHub/.claude/agents/` | `apps/web` · `apps/api` · `services/pricing` and `services/labels` |
| `code-reviewer` · `test-runner` | `FullStackHub/.claude/agents/` | Diff review, read-only · Vitest + pytest runner (`haiku`), failures only |
| `api-test-engineer` · `ui-test-engineer` · `bdd-engineer` · `devsecops` | `SecureGate/.claude/agents/` | Karate API features · Serenity Screenplay · Gherkin + step definitions · the SecureGate CI pipeline |
| `code-reviewer` · `test-runner` | `SecureGate/.claude/agents/` | Test-code review, read-only · `./mvnw -q verify` runner (`haiku`) that reads the surefire counts |
| `code-reviewer` · `test-runner` | `DramaFetch/.claude/agents/` | DramaFetch diff review against the owner's acceptance criteria and the Scope, read-only · ruff, format, mypy, pytest, `pytest -m integration`, `node --test` and `tsc` runner (`haiku`); a skipped suite is "not run" |

Root agents work from the repository root and read the relevant project `CLAUDE.md` before touching that project. Tools and models per agent: `OPERATIONS.md` → Roster.

## Shifts

| Shift | Cron (UTC) | Prompt file |
| --- | --- | --- |
| SRE patrol | `28 */6 * * *` | `.claude/shifts/sre-patrol.md` |
| Nightly maintenance | `40 8 * * *` (03:40 Panama) | `.claude/shifts/nightly-maintenance.md` |
| Weekly security review | `20 10 * * 1` | `.claude/shifts/weekly-security-review.md` |

Each shift is a Claude Code cloud scheduled task that resumes the shift's standing session with a stored prompt that boils down to "sync the checkout to the default branch, read `.claude/shifts/<name>.md` and follow it" (the full prompt: `OPERATIONS.md` → 4.2). The three tasks already exist — do not create them again. To run one by hand: `claude -p "$(cat .claude/shifts/nightly-maintenance.md)"` from the repo root, or ask "run the nightly maintenance shift" in an interactive session. Runtimes, outputs and the incident flow: `OPERATIONS.md`.

Guardrails: the eight rules in `AGENTS.md` → Guardrails apply to every session and every shift — follow them, do not restate them.

## Autonomous runs (cloud sessions)

- Network: the cloud environment reaches npm, PyPI, Maven Central, GitHub (api/raw/web) and code.claude.com, but not `railway.app`, `github.io`, `shields.io`, `tiktok.com` or the Chrome-for-Testing downloads. Its GitHub access is scoped to this repository: other repositories answer 403 on `api.github.com` and `github.com`, while `raw.githubusercontent.com` serves their files — with `pypi.org` and `versionhistory.googleapis.com`, the sources DramaFetch's upstream watch reads; `osv.dev` and `developer.chrome.com` do not answer. Therefore live-app probes and the Selenium UI suite run only in GitHub Actions; Vitest, pytest and the Karate API suite run in the cloud against a locally started stack, and DramaFetch is tested only against its fixtures and local fake TikTok server (Chromium for its integration test: `/opt/pw-browsers/chromium`).
- DramaFetch's checks run with `DRAMAFETCH_REQUIRE_TOOLS=1` in CI and in the nightly shift: a test that would skip for a missing node, full ffmpeg or Chromium fails instead (an environment fact such as "no IPv6 loopback" stays a skip). The cloud image has all three (`/opt/pw-browsers/chromium`); never `playwright install` there.
- Start PostgreSQL with `.claude/scripts/local-postgres.sh` (PostgreSQL 16 binaries in `/usr/lib/postgresql/16/bin`; as root it switches to the `postgres` user; no Docker daemon), then `.claude/scripts/local-api.sh` for the API on :4000. Vitest reads `apps/api/.env.test` (database `shipping_hub_test`).
- SecureGate skips, it does not fail, when nothing answers on `http://localhost:4000`: `./mvnw -q verify` exits 0 and `SecureGate/target/surefire-reports/TEST-com.securegate.api.ApiKarateTest.xml` reports `tests="0"`. Always read the `tests`/`skipped` counts there and in `SecureGate/target/karate-reports/karate-summary-json.txt`; `tests="0"` means "did not run", never "passed".
- Demo accounts (`ana@example.com`, `admin@shippinghub.test`, password `Password123!`) are for local and CI stacks only — never run write operations against production.
