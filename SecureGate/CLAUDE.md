# CLAUDE.md — SecureGate

Automated **QA & security test suite for Shipping Hub** ([`../FullStackHub`](../FullStackHub), live at <https://shipping-hub.up.railway.app/>). The full phased plan lives in `ROADMAP.md`: when starting a phase, read its corresponding section.

**Current phase:** Roadmap stage — **not yet built**. Phase 0 (foundations) is next. The suite tests Shipping Hub through its public API (REST Assured) and web UI (Selenium + Page Object Model), with Cucumber BDD scenarios and security negatives, run in GitHub Actions behind a SonarQube quality gate with Allure reporting.

## Structure

- `src/test/java/.../api` — REST Assured API tests + typed request clients.
- `src/test/java/.../ui` — Selenium Page Objects + E2E tests.
- `src/test/java/.../bdd` — Cucumber runners + step definitions.
- `src/test/java/.../support` — config, environment profiles, REST/WebDriver factories, auth helper.
- `src/test/resources/{features,schemas,config}` — Gherkin features, JSON schemas, env config.
- `/.github/workflows/securegate-ci.yml` (repo root) — the pipeline (GitHub only reads workflows from the repo root).
- Build: Maven (`./mvnw`). **System under test:** Shipping Hub ([`../FullStackHub`](../FullStackHub)).

## Commands (target)

| Command | What it does |
|---|---|
| `./mvnw verify` | Run the full suite (API + BDD + UI) against the configured environment |
| `./mvnw verify -Denv=live` | Target <https://shipping-hub.up.railway.app/> |
| `./mvnw verify -Denv=local` | Target a local Shipping Hub (web `:3000` / api `:4000`) |
| `./mvnw verify -Pui` | UI E2E only |

## Conventions

- **Code language: English.** Identifiers, comments, commit messages — all in English.
- **Conventional commits** in English, imperative mood: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:`.
- Java 21; JUnit 5; **Page Object Model** (no selectors in test methods); explicit waits only (never `Thread.sleep`).
- Tests are deterministic and independent; assert status + body + JSON-schema; never log secrets or tokens.

## Architectural rules (non-negotiable)

1. **Black box:** test Shipping Hub only through its public API and UI — never its source or database. Create and clean test data via the API.
2. Every API endpoint gets happy path + validation + authn/authz negatives + (where relevant) rate-limit and schema checks.
3. UI tests use the Page Object Model — one page object per screen; capture a screenshot on failure.
4. No flaky waits: explicit/expected conditions only.
5. Secrets, tokens and demo credentials live in `src/test/resources/config` and are never logged or hard-coded in tests.

## Subagents (`.claude/agents/`)

- `api-test-engineer` — REST Assured API tests, JSON-schema contracts, security negatives.
- `ui-test-engineer` — Selenium WebDriver + Page Object Model E2E.
- `bdd-engineer` — Cucumber features + step definitions.
- `devsecops` — GitHub Actions pipeline, SonarQube gate, Allure reporting, Selenium-in-Docker.
- `code-reviewer` — reviews test code (flakiness, assertions, conventions); read-only.
- `test-runner` — runs `./mvnw verify` and reports only the failures.
