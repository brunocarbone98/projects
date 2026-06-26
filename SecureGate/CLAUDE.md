# CLAUDE.md — SecureGate

Automated **QA & security test suite for Shipping Hub** ([`../FullStackHub`](../FullStackHub), live at <https://shipping-hub.up.railway.app/>). The full phased plan lives in `ROADMAP.md`: when starting a phase, read its corresponding section.

**Current stack (modernized):** **Karate** for the API (Gherkin-native: tracking, quote, auth, shipments, wallet — `match` contracts + security negatives), **Serenity BDD + Screenplay** over **Selenium** for UI E2E (Actors performing Tasks / asking Questions — replaces the Page Object Model), **Cucumber/Gherkin** for the UI journeys (Serenity living documentation), and a **Postman/Newman** API collection. Java 21 (OOP), JUnit 5, Maven; **SonarQube** quality gate (token-gated). A GitHub Actions pipeline (`/.github/workflows/securegate-ci.yml`) stands up the API + web + Chrome and runs everything on every PR and nightly. **34 scenarios** (28 Karate API · 6 Serenity/Screenplay UI), plus an opt-in rate-limit check.

## Structure

- `src/test/resources/karate` — Karate API features (`*.feature`), `helpers/`, `data/` payloads; `src/test/resources/karate-config.js` holds env config + Java interop.
- `src/test/java/.../api` — Karate JUnit 5 runners (`ApiKarateTest` parallel entrypoint; `ApiFeatureRunners` for the IDE).
- `src/test/java/.../ui/screenplay/{ui,tasks,questions}` — Screenplay components: `Target`s (UI), `Task`s (actions), `Question`s (assertions).
- `src/test/java/.../ui/stepdefs` — Cucumber step definitions that drive Screenplay actors; `UiAcceptanceTest` is the Serenity/Cucumber runner.
- `src/test/resources/features/ui` — Gherkin UI feature files (living documentation).
- `src/test/java/.../support` — `Config` (env profiles), `SutPreflight` (readiness/auto-start), `TrackingCodes` (Luhn helper, reused from Karate via Java interop).
- `postman/` — Postman collection + environments + Newman docs.
- `/.github/workflows/securegate-ci.yml` (repo root) — the pipeline (GitHub only reads workflows from the repo root).
- Build: Maven (`./mvnw`). **System under test:** Shipping Hub ([`../FullStackHub`](../FullStackHub)).

## Commands

| Command | What it does |
|---|---|
| `./mvnw verify` | Run the **Karate API** suite against the configured Shipping Hub (default `env=local`, api `:4000`) |
| `./mvnw verify -Pui` | Full suite incl. **Serenity/Screenplay UI** (needs the web app on `:3000` + a browser) |
| `./mvnw verify -Pui -Dheadless.mode=true` | Same, headless (CI / no display) |
| `./mvnw serenity:aggregate` | Build the Serenity HTML report → `target/site/serenity` (Karate report is auto-written to `target/karate-reports`) |
| `./mvnw verify -DapiBaseUrl=http://host:4000` | Point the API suite at a specific instance |
| `./mvnw verify -Dsg.ratelimit=true` | Include the opt-in Karate rate-limit check |
| `cd postman && npx newman run SecureGate.postman_collection.json -e SecureGate.local.postman_environment.json` | Run the Postman collection headless |

## Conventions

- **Code language: English.** Identifiers, comments, commit messages — all in English.
- **Conventional commits** in English, imperative mood: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:`.
- Java 21; JUnit 5. **UI = Screenplay** (Actors/Tasks/Questions; no selectors in step definitions — they live in `screenplay/ui` `Target`s). Explicit waits only (never `Thread.sleep`).
- **API = Karate**: one feature per resource; reuse `helpers/*.feature` (register/login) via `call`; assert status + body with `match` contracts; never log secrets or tokens.
- Tests are deterministic and independent; data is created and cleaned up via the API.

## Architectural rules (non-negotiable)

1. **Black box:** test Shipping Hub only through its public API and UI — never its source or database. Create and clean test data via the API.
2. Every API endpoint gets happy path + validation + authn/authz negatives + (where relevant) rate-limit and contract (`match`) checks.
3. UI tests use the **Screenplay pattern** — one `Target` set per screen, Tasks for actions, Questions for assertions; capture a screenshot on failure (Serenity does this automatically).
4. No flaky waits: explicit/expected conditions only.
5. Secrets, tokens and demo credentials live in `src/test/resources/config` / `karate-config.js` and are never logged or hard-coded in tests.

## Subagents (`.claude/agents/`)

- `api-test-engineer` — Karate API features, `match` contracts, security negatives, Postman collection.
- `ui-test-engineer` — Serenity Screenplay (Tasks/Questions) over Selenium WebDriver.
- `bdd-engineer` — Cucumber features + Screenplay step definitions.
- `devsecops` — GitHub Actions pipeline, SonarQube gate, Serenity/Karate reporting, Selenium-in-CI.
- `code-reviewer` — reviews test code (flakiness, assertions, conventions); read-only.
- `test-runner` — runs `./mvnw verify` and reports only the failures.
