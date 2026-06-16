# CLAUDE.md — SecureGate

Automated **QA & security test suite for Shipping Hub** ([`../FullStackHub`](../FullStackHub), live at <https://shipping-hub.up.railway.app/>). The full phased plan lives in `ROADMAP.md`: when starting a phase, read its corresponding section.

**Current phase:** Phases 0–2 implemented. The Maven project, the config/support layer, the **REST Assured API suite** (tracking, quote, auth, shipments, wallet — JSON-schema contracts + authn/authz/validation negatives) and the **Cucumber BDD** layer run green against a local Shipping Hub (`./mvnw verify` — 37 tests), with a GitHub Actions pipeline (`/.github/workflows/securegate-ci.yml`) that stands the API up and runs them. Phases 3–6 (Selenium UI E2E, the SonarQube quality gate, Allure reporting, polish) are pending.

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
| `./mvnw verify` | Run the API + BDD suite against the configured Shipping Hub (default `env=local`, api `:4000`) |
| `./mvnw verify -DapiBaseUrl=http://host:4000` | Point at a specific API instance |
| `./mvnw verify -Dcucumber.filter.tags="@public"` | Run only the public (read-only) BDD scenarios |
| `./mvnw verify -Dit.test=RateLimitIT -DexcludedGroups=` | Run the opt-in rate-limit check |

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
