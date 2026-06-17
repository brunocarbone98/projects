# ROADMAP — SecureGate (Automated QA & Security Testing for Shipping Hub)

> **Project:** SecureGate — a professional QA automation suite that tests the **Shipping Hub** platform end to end.
> **System under test:** [`../FullStackHub`](../FullStackHub) — Shipping Hub, live at <https://shipping-hub.up.railway.app/>.
> **Stack:** Java 21, Maven, REST Assured, Selenium WebDriver, Cucumber (BDD), JUnit 5, Allure, SonarQube, GitHub Actions, Docker.
> **How to use this file:** keep it at the project root. When starting each phase with Claude Code, open plan mode and ask it to read the corresponding section.
>
> **Progress:** Phases 0–6 are **implemented** — REST Assured API tests, Cucumber BDD journeys and Selenium UI E2E (43 tests) run against a local Shipping Hub with Allure reporting and a token-gated SonarQube step, all orchestrated by a GitHub Actions pipeline (`/.github/workflows/securegate-ci.yml`) that stands up the API + web + Chrome on every PR and nightly. (Coverage/JaCoCo is intentionally not tracked: a black-box suite has no production code of its own to cover.)

---

## 1. Product vision

SecureGate is the **QA & security test suite for Shipping Hub** — the full-stack parcel platform in [`../FullStackHub`](../FullStackHub). It validates the running system the way a QA Automation Engineer would: **API contract & functional tests** (REST Assured) against the public and authenticated REST API, **end-to-end UI journeys** (Selenium + Page Object Model) against the bilingual web app, and **BDD scenarios** (Cucumber) that read like product specs — plus **security-oriented negative tests** (rate limiting, broken auth, tampered tokens). Everything runs in a **GitHub Actions pipeline** behind a **SonarQube quality gate**, producing an **Allure** report.

It is a black-box client of Shipping Hub: it never edits Shipping Hub's code or database — it drives the system through its public API and UI, exactly as a real user does.

**Success criterion:** one `mvn verify` (or a CI run) executes the full suite against a configured Shipping Hub environment (local or the live Railway URL) and produces a report covering tracking, quoting, auth, shipments and wallet — including the security negatives — with a clear pass/fail and screenshots on UI failures.

---

## 2. What's tested, and with what

| Shipping Hub surface (the SUT) | What we verify | Tool |
|---|---|---|
| Public tracking — `GET /api/v1/tracking/:code` | valid Luhn code returns the timeline; bad check digit / unknown code → 4xx; **rate limiting** kicks in | REST Assured |
| Quote — `POST /api/v1/quote` | price + ETA for valid input; validation errors (400) for bad weight/zone | REST Assured |
| Auth — `/api/v1/auth/{register,login,refresh}` | token issuance & refresh; **invalid/expired/tampered JWT → 401** | REST Assured |
| Shipments & wallet (authenticated) | create/list shipments; wallet top-up & label payment; **idempotency** (no double charge); **authz** (no cross-account access → 403) | REST Assured |
| Web UI (`/{es\|en}/...`) | landing, tracking page (SSR + map), quote calculator, login, dashboard, **create-shipment wizard**, wallet | Selenium + POM |
| User journeys | Track a parcel · Get a quote · Sign in · Create a shipment · Pay a label | Cucumber (Gherkin) |
| The test framework itself | static analysis + a quality gate | SonarQube + JaCoCo |
| The whole suite | orchestration + reporting | GitHub Actions + Allure |

**Golden rule:** SecureGate is **black-box**. Test data is created and cleaned up **through Shipping Hub's API** (plus the seeded demo data: `PTY-2026-001001-0`, `ana@example.com` / `Password123!`). SecureGate never touches Shipping Hub's database or source directly.

---

## 3. Project structure

```
SecureGate/
├── CLAUDE.md  ROADMAP.md  README.md  .gitignore
├── pom.xml                          # Maven (REST Assured, Selenium, Cucumber, Allure, JUnit)
├── docker-compose.yml               # optional: Selenium Grid (+ a local Shipping Hub)
├── .claude/agents/                  # task delegation (see section 7)
├── src/test/java/com/securegate/
│   ├── api/        # REST Assured tests + typed request clients
│   ├── ui/         # Selenium Page Objects + E2E tests
│   ├── bdd/        # Cucumber runners + step definitions
│   └── support/    # config, env profiles, REST/WebDriver factories, auth helper
└── src/test/resources/
    ├── features/   # Gherkin .feature files (living documentation)
    ├── schemas/    # JSON schemas for contract validation
    └── config/     # base URLs (api/web) per environment, test users

# At the repo root (GitHub requirement):
.github/workflows/securegate-ci.yml
```

**Base tooling:** Maven Wrapper (`./mvnw`), JUnit 5, REST Assured, Selenium + WebDriverManager, Cucumber, Allure, SonarQube, GitHub Actions.

---

## 4. Test strategy & the system under test

**System under test (SUT):** Shipping Hub — Next.js web + Express API + Python services + PostgreSQL ([`../FullStackHub`](../FullStackHub)).
- **Environments** (selected by a Maven profile / config): `live` → <https://shipping-hub.up.railway.app/>; `local` → `http://localhost:3000` (web) + `:4000` (api), brought up from `../FullStackHub` (`docker compose up` + `pnpm dev`).
- **Test data:** the seeded demo data (public code `PTY-2026-001001-0`; users `ana@example.com` / `Password123!`, `admin@shippinghub.test`) plus data created on the fly via the API and cleaned up afterwards.

**The testing pyramid:**
- **API tests (broad, fast)** — most of the coverage; assert status, headers, JSON body and JSON-schema contract.
- **BDD scenarios (readable)** — the key journeys as Gherkin, reusing the API clients; living documentation for non-engineers.
- **UI E2E (few, critical)** — real-browser happy paths for the journeys that only matter through the UI (tracking page render, the create-shipment wizard, the language switch).

**Security-oriented checks (the "Secure" in SecureGate):** public-endpoint **rate limiting**, **authz** (cross-account access → 403), **invalid/expired/tampered JWT** (401), input **validation** (400), and confirming **secrets are never leaked** in responses.

---

## 5. Project phases

> Each phase ends with something demonstrable and a commit/tag.

### Phase 0 — Foundations (2–4 days) — ✅ implemented
**Stack:** Maven, JUnit 5, REST Assured, Selenium (WebDriverManager).
- Maven project; a config layer with environment profiles (`local`/`live`) and base URLs for the Shipping Hub API + web; base test classes; REST Assured + WebDriver factories.
- `CLAUDE.md`; `.claude/agents/`; CI skeleton (`securegate-ci.yml`) running a **smoke test** against `GET /api/v1/tracking/PTY-2026-001001-0` on the live env.
- **Deliverable:** `./mvnw verify` runs the smoke test against the configured Shipping Hub; CI green.
- **Delegate:** `api-test-engineer` (config + smoke) · `devsecops` (CI skeleton).

### Phase 1 — API contract & functional tests (1–2 weeks) — ✅ implemented
**Stack:** REST Assured + JSON-schema validation.
- **Tracking:** valid Luhn code → timeline; bad check digit / unknown code → 4xx; rate-limit behaviour.
- **Quote:** valid price + ETA; validation errors.
- **Auth:** register/login/refresh; negative JWT cases.
- **Shipments & wallet:** create/list; top-up + label payment; **idempotency**; **authz** negatives.
- **Deliverable:** a green REST Assured suite covering the public + authenticated API, with schema contracts.
- **Delegate:** `api-test-engineer`.

### Phase 2 — BDD layer with Cucumber (1 week) — ✅ implemented
**Stack:** Cucumber (Gherkin) + JUnit.
- Feature files for **Track a parcel**, **Get a quote**, **Sign in**, **Create a shipment**, **Pay a label**; step definitions reusing the API clients; tags (`@smoke`, `@regression`, `@security`).
- **Deliverable:** readable BDD scenarios run via `mvn verify`; living documentation generated.
- **Delegate:** `bdd-engineer`.

### Phase 3 — UI end-to-end with Selenium + POM (1–2 weeks) — ✅ implemented
**Stack:** Selenium WebDriver + Page Object Model (headless Chrome).
- Page objects for landing, tracking, quote, login, dashboard, the **create-shipment wizard** and wallet; E2E flows for the critical journeys; an **es/en** language-switch check; screenshots on failure.
- **Deliverable:** the E2E suite drives the real web app for the critical journeys.
- **Delegate:** `ui-test-engineer`.

### Phase 4 — CI/CD pipeline (1 week) — ✅ implemented
**Stack:** GitHub Actions + (optionally) Selenium in Docker.
- Pipeline: checkout → JDK + Maven cache → API + BDD + UI suites against the **live Railway** Shipping Hub (and/or spin Shipping Hub up locally from `../FullStackHub` in CI); headless browser / Selenium container; **nightly schedule** + on-demand; upload the Allure results.
- **Deliverable:** a green pipeline that produces a test report; a nightly run against production.
- **Delegate:** `devsecops`.

### Phase 5 — Quality gate & reporting (1 week) — ✅ implemented
**Stack:** SonarQube/SonarCloud + Allure.
- SonarQube static analysis of the **test framework** with a **quality gate** (token-gated CI step); an **Allure** report (`mvn allure:report`, uploaded as a CI artifact). Coverage/JaCoCo is intentionally omitted — a black-box suite has no production code of its own to cover. (Optional extras: publish the Allure report to GitHub Pages with history; flaky-test retries + quarantine.)
- **Deliverable:** Sonar gate green; a published Allure report with history; status/quality badges.
- **Delegate:** `devsecops` · `code-reviewer`.

### Phase 6 — Polish & docs (3–5 days) — ✅ implemented
- README with the **test strategy**, a **coverage matrix** (Shipping Hub feature → tests), the report link and screenshots; a short **test plan** + a sample bug report; tag a release; wire the portfolio entry.
- **Deliverable:** a documented QA repo + the SecureGate portfolio entry linking to the live report.
- **Delegate:** `code-reviewer` (final review) · `devsecops`.

---

## 6. Dependency order

```
Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6
```

API clients from Phase 1 are reused by the BDD steps (Phase 2); the UI suite (Phase 3) is independent and can run in parallel; Phase 4 orchestrates all three in CI; Phase 5 adds the gate + reporting.

---

## 7. Claude Code subagents (task delegation)

Subagents live in `.claude/agents/` (project-level, versioned). Markdown files with YAML frontmatter; manage them with `/agents`. Docs: https://code.claude.com/docs/en/sub-agents

| Agent | Model | Tools | Role |
|---|---|---|---|
| `api-test-engineer` | sonnet | all | REST Assured API tests, JSON-schema contracts, security negatives. |
| `ui-test-engineer` | sonnet | all | Selenium WebDriver + Page Object Model E2E. |
| `bdd-engineer` | sonnet | all | Cucumber feature files + step definitions. |
| `devsecops` | sonnet | all | GitHub Actions pipeline, SonarQube gate, Allure reporting, Selenium-in-Docker. |
| `code-reviewer` | sonnet | Read, Grep, Glob | Reviews test code for flakiness, weak assertions, conventions. Read-only. |
| `test-runner` | haiku | Bash, Read | Runs `./mvnw verify` and reports only the failures. |

### Example: `.claude/agents/api-test-engineer.md`
```markdown
---
name: api-test-engineer
description: Writes REST Assured API tests against the Shipping Hub REST API, with JSON-schema contracts and security-negative cases. Use for tasks under src/test/java/.../api.
model: sonnet
---
You write API tests for Shipping Hub (the system under test), in Java with REST Assured.
- Black box: drive the API only (no DB/source access). Use the seeded demo data and create/clean any extra data via the API.
- Cover, per endpoint: happy path, validation (400), authn (401), authz (403 cross-account), not-found (404), rate limiting, and JSON-schema contract.
- Deterministic and independent tests; assert status, headers and body; never log secrets or tokens.
```

### Suggested per-phase workflow
1. `claude` at the project root → plan mode → *"Read Phase N of ROADMAP.md and propose a plan."*
2. Approve and delegate: API → `api-test-engineer`, BDD → `bdd-engineer`, UI → `ui-test-engineer`, pipeline → `devsecops`.
3. After each block: *"Use code-reviewer on the changes"* → fix → commit.
4. `test-runner` for long Maven runs without filling the main context.

---

## 8. Portfolio extras (if there's time)

- Publish the **Allure report** to GitHub Pages + a nightly-run badge.
- A **bug log** documenting issues found in Shipping Hub (and the fixes that closed them).
- **Contract testing** (Pact) between the web and the API.
- A **load test** (k6 or Gatling) of the public tracking endpoint.
- **Accessibility** checks (axe) on the public pages.
