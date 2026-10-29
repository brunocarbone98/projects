<!--
Keep it small and reviewable: one topic (or one shift run) per PR, aim for under 200 changed lines
excluding lockfiles. Agent PRs carry the `agent` label and name their shift in "Opened by".
-->

## Summary

<!-- One or two sentences: what changes and why. Link the issue when there is one (Closes #123). -->

## Changes

-

## How I verified

Tick what you ran and paste the real results. Failing is failing (with the output); skipped is skipped.

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

**Not applicable**

- [ ] Docs or configuration only — say which checks you still ran (for example `pnpm format:check` for anything under `FullStackHub/`)

## Risks & rollback

<!-- What could break and how you would notice. How to roll back: revert this PR; for the live app, redeploy the previous Railway deployment. -->

---

**Opened by:** <!-- human · or the agent shift that opened it: sre-patrol / nightly-maintenance / weekly-security-review / claude-on-call -->

> Agents never merge. A human reviews and merges every pull request — see `AGENTS.md`.
