# CLAUDE.md — SecureGate

Automated **QA & security test suite for Shipping Hub** ([`../FullStackHub`](../FullStackHub), live at <https://shipping-hub.up.railway.app/>). The full phased plan lives in `ROADMAP.md`: when starting a phase, read its corresponding section.

**Current stack (modernized):** **Karate** for the API (Gherkin-native: tracking, quote, auth, shipments, wallet — `match` contracts + security negatives), **Serenity BDD + Screenplay** over **Selenium** for UI E2E (Actors performing Tasks / asking Questions — replaces the Page Object Model), **Cucumber/Gherkin** for the UI journeys (Serenity living documentation), and a **Postman/Newman** API collection. Java 21 (OOP), JUnit 5, Maven; **SonarQube** quality gate (token-gated). A GitHub Actions pipeline (`/.github/workflows/securegate-ci.yml`) stands up the API + web + Chrome and runs everything on PRs touching `SecureGate/**` or `FullStackHub/**` and nightly at 06:00 UTC. **34 scenarios** (28 Karate API · 6 Serenity/Screenplay UI), plus an opt-in rate-limit check.

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

- `api-test-engineer` — Karate API features (`match` contracts, validation and security negatives, `helpers/*.feature` via `call`, `TrackingCodes` interop) and the Postman/Newman collection.
- `ui-test-engineer` — Serenity Screenplay (`screenplay/ui` Targets, Tasks, Questions) over Selenium WebDriver; explicit waits only; the UI suite needs Chrome, so in the cloud it hands the run to SecureGate CI.
- `bdd-engineer` — Cucumber features in `features/ui` (`@ui`/`@public`) and thin step definitions that delegate to Screenplay.
- `devsecops` — the pipeline `/.github/workflows/securegate-ci.yml`, Chrome in CI, Serenity/Karate report artifacts, Newman step, token-gated SonarQube gate.
- `code-reviewer` — reviews test code (read-only): `Thread.sleep`/implicit waits, status-only assertions, order dependence, selectors outside Targets, leaked secrets, naming.
- `test-runner` — runs `./mvnw -q verify` (API) or `-Pui -Dheadless.mode=true` (UI, CI only), reads `target/surefire-reports/*.xml` and the Karate summary; `tests="0"` / all skipped = the stack was down, reported as such (`model: haiku`).

Repo-wide agents live in `/.claude/agents/` (`sre-patrol`, `repo-steward`, `qa-regression`, `security-auditor`, `docs-keeper`, DramaFetch's `download-guardian` and `vuln-sentinel`, and the merge gate's `merge-steward`) and work from the repository root.

## Autonomous maintenance

- SecureGate is maintained around the clock by Claude Code agents; humans review and merge every PR, except the Dependabot and agent PRs that pass the merge gate. **SecureGate CI** runs the full suite (Karate API + Serenity UI with Chrome + Newman) nightly at 06:00 UTC and on PRs touching `SecureGate/**` or `FullStackHub/**`.
- Shifts covering this project (`/.claude/shifts/`): **nightly maintenance** (08:40 UTC) starts a local Shipping Hub and runs `./mvnw -q -B verify`, reading `target/surefire-reports/TEST-com.securegate.api.ApiKarateTest.xml` and `target/karate-reports/karate-summary-json.txt` — `tests="0"` means the suite did not run (no reachable stack) and is never reported as a pass; **SRE patrol** (every 6 h) triages red SecureGate CI runs; the **weekly security review** checks Maven dependency updates; the **merge gate** (daily 11:47 UTC) merges the Dependabot and agent PRs that pass its checks, SecureGate CI green with tests above 0 among them.
- Helper scripts (`/.claude/scripts/`): `local-postgres.sh` (PostgreSQL 16 on 127.0.0.1:5432), `local-api.sh` (migrate + seed + API on :4000; `stop` ends it), `run-checks.sh` (FullStackHub checks + pytest). The Selenium UI suite needs Chrome and runs only in SecureGate CI.
- Operations manual, roster and guardrails: [`../OPERATIONS.md`](../OPERATIONS.md).
