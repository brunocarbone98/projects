# CLAUDE.md — SecureGate

Automated **QA & security test suite for Shipping Hub** ([`../FullStackHub`](../FullStackHub), live at <https://shipping-hub.up.railway.app/>). The full phased plan lives in `ROADMAP.md`: when starting a phase, read its corresponding section.

**Current phase:** Phases 0–6 implemented. The full suite — **REST Assured API** (tracking, quote, auth, shipments, wallet — JSON-schema contracts + security negatives), **Cucumber BDD** journeys, and **Selenium UI E2E** (Page Object Model: tracking, quote, sign-in, language switch) — runs against a local Shipping Hub with **Allure** reporting and a token-gated **SonarQube** step. A GitHub Actions pipeline (`/.github/workflows/securegate-ci.yml`) stands up the API + web + Chrome and runs everything on every PR and nightly. **43 tests** (28 REST Assured · 9 Cucumber · 6 Selenium).

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
| `./mvnw verify -DexcludedGroups=ratelimit` | Full suite incl. **UI E2E** (needs the web app on `:3000` + a browser) |
| `./mvnw allure:report` | Build the Allure HTML report → `target/site/allure-maven-plugin` |
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
