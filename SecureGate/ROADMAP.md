# ROADMAP — SecureGate (Automated QA & Security Testing for Shipping Hub)

> **Project:** SecureGate — a professional QA automation suite that tests the **Shipping Hub** platform end to end.
> **System under test:** [`../FullStackHub`](../FullStackHub) — Shipping Hub, live at <https://shipping-hub.up.railway.app/>.
> **Stack:** Java 21 (OOP), Maven, **Karate** (API), **Serenity BDD + Screenplay** over **Selenium** (UI E2E), **Cucumber/Gherkin** (journeys), **Postman/Newman** (API collection), JUnit 5, SonarQube, GitHub Actions, Docker.
> **How to use this file:** keep it at the project root. When starting each phase with Claude Code, open plan mode and ask it to read the corresponding section.
>
> **Progress:** Phases 0–6 are **implemented** — Karate API features, Serenity/Screenplay UI E2E and Cucumber BDD journeys (34 scenarios) run against a local Shipping Hub with Serenity + Karate reporting and a token-gated SonarQube step, all orchestrated by a GitHub Actions pipeline (`/.github/workflows/securegate-ci.yml`) that stands up the API + web + Chrome on every PR and nightly. (Coverage/JaCoCo is intentionally not tracked: a black-box suite has no production code of its own to cover.)

---

## 1. Product vision

SecureGate is the **QA & security test suite for Shipping Hub** — the full-stack parcel platform in [`../FullStackHub`](../FullStackHub). It validates the running system the way a QA Automation Engineer would: **API contract & functional tests** (Karate) against the public and authenticated REST API, **end-to-end UI journeys** (Serenity + Screenplay over Selenium) against the bilingual web app, and **BDD scenarios** (Cucumber/Gherkin) that read like product specs — plus **security-oriented negative tests** (rate limiting, broken auth, tampered tokens) and a hand-runnable **Postman/Newman** collection.

It is a black-box client of Shipping Hub: it never edits Shipping Hub's code or database — it drives the system through its public API and UI, exactly as a real user does.

**Why this stack.** API checks are expressed in **Karate**, whose Gherkin-native syntax and `match` assertions make HTTP contracts concise and readable. UI E2E uses the **Screenplay pattern** (via Serenity): the earlier Page Object Model grew hard to maintain as the UI surface widened, so behaviour is now modelled as **Actors** performing **Tasks** and asking **Questions** — small, composable, reusable units of intent.

**Success criterion:** one `mvn verify` (or a CI run) executes the suite against a configured Shipping Hub environment (local or remote) and produces reports covering tracking, quoting, auth, shipments and wallet — including the security negatives — with a clear pass/fail and screenshots on UI failures.

---

## 2. What's tested, and with what

| Shipping Hub surface (the SUT) | What we verify | Tool |
|---|---|---|
| Public tracking — `GET /api/v1/tracking/:code` | valid Luhn code returns the timeline; bad check digit / unknown code → 4xx; **rate limiting** kicks in | Karate |
| Quote — `POST /api/v1/quote` | price + ETA for valid input; validation errors (400) for bad weight/zone/service | Karate |
| Auth — `/api/v1/auth/{register,login,refresh,me}` | token issuance & rotation; **invalid/expired/tampered JWT → 401** | Karate |
| Shipments & wallet (authenticated) | create/list shipments; wallet top-up; **idempotency** (no double charge); **authz** (no cross-account access) | Karate |
| Web UI (`/{es\|en}/...`) | landing, tracking page (SSR), quote calculator, login, dashboard, language switch | Serenity + Screenplay (Selenium) |
| User journeys | Track a parcel · Get a quote · Sign in · Switch language | Cucumber (Gherkin) |
| Same API, hand-runnable | shareable collection + CI smoke | Postman / Newman |
| The test framework itself | static analysis + a quality gate | SonarQube |
| The whole suite | orchestration + reporting | GitHub Actions + Serenity/Karate reports |

**Golden rule:** SecureGate is **black-box**. Test data is created and cleaned up **through Shipping Hub's API** (plus the seeded demo data: `PTY-2026-001001-0`, `ana@example.com` / `Password123!`). SecureGate never touches Shipping Hub's database or source directly.

---

## 3. Project structure

```
SecureGate/
├── CLAUDE.md  ROADMAP.md  README.md  .gitignore
├── pom.xml                              # Maven (Karate, Serenity Screenplay, Cucumber, JUnit)
├── .claude/agents/                      # task delegation (see section 7)
├── postman/                             # Postman collection + environments + Newman docs
├── src/test/java/com/securegate/
│   ├── api/        # Karate JUnit 5 runners (ApiKarateTest parallel; ApiFeatureRunners for the IDE)
│   ├── ui/
│   │   ├── screenplay/ui/        # UI components as Targets (replaces Page Objects)
│   │   ├── screenplay/tasks/     # Tasks: TrackParcel, RequestAQuote, SignIn, SwitchLanguage...
│   │   ├── screenplay/questions/ # Questions: TheTrackingResult, TheQuote, TheLogin...
│   │   ├── stepdefs/             # Cucumber steps driving Screenplay actors
│   │   └── UiAcceptanceTest.java # Serenity/Cucumber runner (profile `ui`)
│   └── support/    # Config (env profiles), SutPreflight (readiness/auto-start), TrackingCodes (Luhn)
└── src/test/resources/
    ├── karate/         # Karate features + helpers/ + data/ payloads
    ├── karate-config.js# env config + Java interop (TrackingCodes, fresh-email helper)
    ├── features/ui/    # Gherkin UI .feature files (living documentation)
    ├── serenity.conf   # Serenity/WebDriver config (Chrome, headless toggle)
    └── config/         # base URLs (api/web) per environment, test users (used by SutPreflight)

# At the repo root (GitHub requirement):
.github/workflows/securegate-ci.yml
```

**Base tooling:** Maven Wrapper (`./mvnw`), JUnit 5, Karate, Serenity (Screenplay + Cucumber), Selenium (Selenium Manager), Postman/Newman, SonarQube, GitHub Actions.

---

## 4. Test strategy & the system under test

**System under test (SUT):** Shipping Hub — Next.js web + Express API + Python services + PostgreSQL ([`../FullStackHub`](../FullStackHub)).
- **Environments** (selected by `-Denv`): `local` → `http://localhost:3000` (web) + `:4000` (api), brought up from `../FullStackHub`; `live` → the web app on Railway (the API is internal on the live deploy, so the API suite targets a local instance).
- **Test data:** the seeded demo data (public code `PTY-2026-001001-0`; users `ana@example.com` / `Password123!`, `admin@shippinghub.test`) plus data created on the fly via the API.

**The testing pyramid:**
- **API tests (broad, fast)** — most of the coverage, in Karate; assert status, headers, JSON body and `match` contract.
- **BDD scenarios (readable)** — the key journeys as Gherkin, driving Screenplay actors; living documentation for non-engineers.
- **UI E2E (few, critical)** — real-browser happy paths for the journeys that only matter through the UI (tracking page render, the quote calculator, sign-in, the language switch).

**Security-oriented checks (the "Secure" in SecureGate):** public-endpoint **rate limiting**, **authz** (cross-account access), **invalid/expired/tampered JWT** (401), input **validation** (400), and confirming **secrets are never leaked** in responses.

---

## 5. Project phases

> Each phase ends with something demonstrable and a commit/tag.

### Phase 0 — Foundations — ✅ implemented
**Stack:** Maven, JUnit 5, Karate, Serenity (Screenplay/Selenium).
- Maven project; a config layer with environment profiles (`local`/`live`); `SutPreflight` readiness/auto-start guard; Karate config (`karate-config.js`) and Serenity config (`serenity.conf`).
- `CLAUDE.md`; `.claude/agents/`; CI skeleton running a **smoke test** (`karate/health.feature`) against `GET /api/v1/tracking/PTY-2026-001001-0`.
- **Deliverable:** `./mvnw verify` runs the smoke test against the configured Shipping Hub; CI green.
- **Delegate:** `api-test-engineer` (config + smoke) · `devsecops` (CI skeleton).

### Phase 1 — API contract & functional tests — ✅ implemented
**Stack:** Karate (`match` contracts) + a Postman/Newman collection.
- **Tracking:** valid Luhn code → timeline; bad check digit / unknown code → 4xx; rate-limit behaviour (opt-in `@ratelimit`).
- **Quote:** valid price + ETA; validation errors.
- **Auth:** register/login/refresh/me; negative JWT cases.
- **Shipments & wallet:** create/list; top-up; **idempotency**; **authz** negatives.
- A **Postman** collection mirrors the same endpoints for hand-running and sharing (Newman in CI as a non-blocking smoke).
- **Deliverable:** a green Karate suite covering the public + authenticated API, with `match` contracts; a runnable Postman collection.
- **Delegate:** `api-test-engineer`.

### Phase 2 — BDD UI journeys with Cucumber + Serenity — ✅ implemented
**Stack:** Cucumber (Gherkin) + Serenity, driving Screenplay actors.
- Feature files for **Track a parcel**, **Get a quote**, **Sign in**, **Switch language**; step definitions that delegate to Screenplay Tasks/Questions; tags (`@ui`, `@public`).
- **Deliverable:** readable BDD scenarios run via `mvn verify -Pui`; Serenity living documentation generated.
- **Delegate:** `bdd-engineer`.

### Phase 3 — UI end-to-end with Selenium + Screenplay — ✅ implemented
**Stack:** Selenium WebDriver via Serenity Screenplay (visible Chrome by default; headless on CI).
- `Target`s per screen (landing, tracking result, quote, login, header); `Task`s for the critical journeys; `Question`s for the assertions; an **es/en** language-switch check; screenshots on failure (Serenity, automatic).
- **Deliverable:** the E2E suite drives the real web app for the critical journeys, in the maintainable Screenplay style.
- **Delegate:** `ui-test-engineer`.

### Phase 4 — CI/CD pipeline — ✅ implemented
**Stack:** GitHub Actions.
- Pipeline: checkout → JDK + Maven cache → stand Shipping Hub up locally from `../FullStackHub` (Postgres + API + web + Chrome) → run the **Karate API** suite, the **Serenity/Screenplay UI** suite (`-Pui`), and the **Newman** collection; **nightly schedule** + on-demand; upload the Serenity + Karate reports.
- **Deliverable:** a green pipeline that produces test reports; a nightly run.
- **Delegate:** `devsecops`.

### Phase 5 — Quality gate & reporting — ✅ implemented
**Stack:** SonarQube/SonarCloud + Serenity + Karate reports.
- SonarQube static analysis of the **test framework** with a **quality gate** (token-gated CI step); **Serenity** living documentation (`mvn serenity:aggregate` → `target/site/serenity`) and the **Karate** HTML report (`target/karate-reports`), both uploaded as CI artifacts. Coverage/JaCoCo is intentionally omitted — a black-box suite has no production code of its own to cover.
- **Deliverable:** Sonar gate green; published Serenity + Karate reports; status/quality badges.
- **Delegate:** `devsecops` · `code-reviewer`.

### Phase 6 — Polish & docs — ✅ implemented
- README with the **test strategy**, a **coverage matrix** (Shipping Hub feature → tests), the report links and screenshots; a short **test plan** + a sample bug report; tag a release; wire the portfolio entry.
- **Deliverable:** a documented QA repo + the SecureGate portfolio entry linking to the live report.
- **Delegate:** `code-reviewer` (final review) · `devsecops`.

---

## 6. Dependency order

```
Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6
```

The Karate API features (Phase 1) and the Screenplay UI (Phases 2–3) are independent and can be built in parallel; the BDD step definitions (Phase 2) reuse the Screenplay Tasks/Questions (Phase 3); Phase 4 orchestrates everything in CI; Phase 5 adds the gate + reporting.

---

## 7. Claude Code subagents (task delegation)

Subagents live in `.claude/agents/` (project-level, versioned). Markdown files with YAML frontmatter; manage them with `/agents`. Docs: https://code.claude.com/docs/en/sub-agents

| Agent | Model | Tools | Role |
|---|---|---|---|
| `api-test-engineer` | sonnet | all | Karate API features, `match` contracts, security negatives, Postman collection. |
| `ui-test-engineer` | sonnet | all | Serenity Screenplay (Tasks/Questions) over Selenium WebDriver. |
| `bdd-engineer` | sonnet | all | Cucumber feature files + Screenplay step definitions. |
| `devsecops` | sonnet | all | GitHub Actions pipeline, SonarQube gate, Serenity/Karate reporting, Selenium-in-CI. |
| `code-reviewer` | sonnet | Read, Grep, Glob | Reviews test code for flakiness, weak assertions, conventions. Read-only. |
| `test-runner` | haiku | Bash, Read | Runs `./mvnw verify` and reports only the failures. |

### Suggested per-phase workflow
1. `claude` at the project root → plan mode → *"Read Phase N of ROADMAP.md and propose a plan."*
2. Approve and delegate: API → `api-test-engineer`, BDD → `bdd-engineer`, UI → `ui-test-engineer`, pipeline → `devsecops`.
3. After each block: *"Use code-reviewer on the changes"* → fix → commit.
4. `test-runner` for long Maven runs without filling the main context.

---

## 8. Portfolio extras (if there's time)

- Publish the **Serenity report** to GitHub Pages + a nightly-run badge.
- A **bug log** documenting issues found in Shipping Hub (and the fixes that closed them).
- **Contract testing** (Pact) between the web and the API.
- A **load test** (k6 or Gatling) of the public tracking endpoint.
- **Accessibility** checks (axe) on the public pages.
