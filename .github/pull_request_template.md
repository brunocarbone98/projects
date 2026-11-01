<!--
Keep it small and reviewable: one topic (or one shift run) per PR, aim for under 200 changed lines
excluding lockfiles. Agent PRs carry the `agent` label and name their shift in "Opened by".
-->

## Summary

<!-- One or two sentences: what changes and why. Link the issue when there is one (Closes #123). -->

## Changes

-

## How I verified

Tick what you ran and paste the real results. Failing is failing (with the output); skipped is skipped. Delete the sections of the projects this PR does not touch.

**FullStackHub — Shipping Hub** (from `FullStackHub/`; `.claude/scripts/run-checks.sh` runs all of these in one go)

- [ ] `pnpm lint`
- [ ] `pnpm format:check`
- [ ] `pnpm typecheck`
- [ ] `pnpm test` — Vitest, shared unit + API integration; needs PostgreSQL on `localhost:5432` (`.claude/scripts/local-postgres.sh`)
- [ ] `services/pricing`: `.venv/bin/python -m pytest` · `services/labels`: `.venv/bin/python -m pytest`

**SecureGate** (from `SecureGate/`, with a local stack up: `.claude/scripts/local-postgres.sh` then `.claude/scripts/local-api.sh`)

- [ ] `./mvnw -q verify` — Karate API suite. Check `target/surefire-reports/*.xml`: `tests="0"` means the stack was down and nothing ran, not a pass
- [ ] `./mvnw verify -Pui -Dheadless.mode=true` — Serenity/Screenplay UI suite (needs Chrome; in the cloud environment this runs only in SecureGate CI)

**PersonalWebsite**

- [ ] Opened `MainPage.html` and `Portfolio.html` in a browser at desktop and mobile widths: no console errors, no broken requests

**DramaFetch** (from `DramaFetch/`, in its `.venv`)

- [ ] `.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy && .venv/bin/pytest` — unit tests against the fixtures and the local fake TikTok server; nothing reaches tiktok.com
- [ ] `DRAMAFETCH_CHROMIUM=<path to a Chromium binary> .venv/bin/pytest -m integration` — a real Chromium against the fake server; skipped (not passed) when no Chromium is available
- [ ] Chrome extension, from `extension/` (Node 22, no npm dependencies): `node --test` — unit tests of every module plus the manifest (permissions) and locales tests — and `npx -y -p typescript@5.9.3 tsc -p jsconfig.json` (strict `checkJs`); its parity tests run inside `pytest`, its end-to-end scenarios inside `pytest -m integration`

**Not applicable**

- [ ] Docs or configuration only — say which checks you still ran (for example `pnpm format:check` for anything under `FullStackHub/`)

## Risks & rollback

<!-- What could break and how you would notice. How to roll back: revert this PR; for the live app, redeploy the previous Railway deployment. -->

---

**Opened by:** <!-- human · or the agent shift that opened it: sre-patrol / nightly-maintenance / weekly-security-review / merge-gate / claude-on-call -->

> Only `merge-steward`, inside the merge gate (`.claude/shifts/merge-gate.md`), merges a Dependabot or agent pull request that passes every check; a human reviews and merges every other one — see `AGENTS.md`.
