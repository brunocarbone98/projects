# ROADMAP — SecureGate (DevSecOps CI/CD Security Pipeline)

> **Project:** SecureGate — a DevSecOps pipeline that gates a Java microservices backend
> **Stack:** Java 21, Spring Boot 3, Maven, JUnit 5, REST Assured, Testcontainers, SonarQube/SonarCloud, JaCoCo, GitHub Actions, Docker, Trivy
> **How to use this file:** keep it at the project root. When starting each phase with Claude Code, open plan mode and ask it to read the corresponding section of this roadmap.

---

## 1. Product vision

SecureGate is a small but realistic **Java (Spring Boot) microservices backend** wrapped in a **DevSecOps pipeline**: every change must pass automated **security and quality gates** before it can ship. It demonstrates *shift-left* security — vulnerabilities, low coverage and risky API behaviour are caught in CI, not in production.

The backend itself is a **secrets / API-key vault**: an `auth-service` issues JWTs and manages accounts, and a `vault-service` lets an authenticated account create, rotate and revoke API keys under role-based access. The domain is deliberately compact — **the star of the project is the pipeline**, not the feature set.

**Success criterion:** a pull request that introduces a vulnerability, a failing API contract, or a coverage regression is **automatically blocked** by the pipeline (SonarQube quality gate + REST Assured suite + dependency/image scan), with a clear report — while a clean PR sails through to a published, hardened Docker image.

---

## 2. Where each piece of the stack fits

| Technology | Location in the repo | Responsibility |
|---|---|---|
| **Java 21 + Spring Boot 3** | `services/auth-service`, `services/vault-service` | The microservices backend: accounts + JWT, and the API-key vault with RBAC. |
| **Maven (multi-module)** | root `pom.xml` + module `pom.xml`s | Build orchestration, shared dependency management, the `verify` lifecycle. |
| **PostgreSQL + Spring Data JPA + Flyway** | each service (via Docker Compose) | Persistence + versioned schema migrations. |
| **JUnit 5 + Testcontainers** | `src/test` per service | Unit tests + integration tests against a real Postgres in a container. |
| **REST Assured** | `src/test` (integration) | Black-box API tests: happy paths, validation, authn/authz, security negatives. |
| **SonarQube / SonarCloud + JaCoCo** | CI + `sonar-project` config | Static analysis (bugs, vulnerabilities, hotspots) + coverage, behind a **Quality Gate**. |
| **GitHub Actions** | `/.github/workflows/securegate-ci.yml` (repo root) | The pipeline: build → test → scan → gate → image. |
| **Docker** | `Dockerfile` per service + `docker-compose.yml` | Multi-stage, non-root images; local orchestration. |
| **Trivy / OWASP Dependency-Check + gitleaks + CycloneDX** | CI | Dependency & image vulnerability scanning, secret scanning, SBOM. |

**Architectural golden rule:** the pipeline is the product. Each service stays small, conventional and well-tested so the **gates** (quality, security, coverage, supply-chain) are the interesting, demonstrable part.

> **Note:** GitHub Actions only runs workflows from the **repository root** `.github/workflows/`. SecureGate's pipeline therefore lives at `/.github/workflows/securegate-ci.yml` (scoped with `paths: ["SecureGate/**"]`), while everything else lives inside `SecureGate/`.

---

## 3. Project structure

```
SecureGate/
├── CLAUDE.md                   # Conventions for Claude Code
├── ROADMAP.md                  # This file
├── README.md                   # Overview + architecture + how to run
├── .gitignore
├── pom.xml                     # Parent POM (multi-module, dependency mgmt)
├── docker-compose.yml          # PostgreSQL + both services
├── .claude/
│   └── agents/                 # Task delegation (see section 7)
│       ├── backend-dev.md
│       ├── test-engineer.md
│       ├── devsecops.md
│       ├── code-reviewer.md
│       └── test-runner.md
├── common/                     # Shared module: DTOs, error model, JWT utils
│   ├── pom.xml
│   └── src/main/java/...
└── services/
    ├── auth-service/           # Accounts + JWT issuance/validation
    │   ├── pom.xml  Dockerfile
    │   └── src/{main,test}/java/...
    └── vault-service/          # API-key vault + RBAC
        ├── pom.xml  Dockerfile
        └── src/{main,test}/java/...

# At the repo root (GitHub requirement):
.github/workflows/securegate-ci.yml
```

**Base tooling:** Maven Wrapper (`./mvnw`), Spring Boot 3, Flyway, JaCoCo, GitHub Actions, Docker.

---

## 4. Domain & pipeline model

### The backend (kept intentionally small)

- **`auth-service`** — `accounts` (id, email, BCrypt password hash, role `USER`/`ADMIN`): `POST /auth/register`, `POST /auth/login` (returns a short-lived JWT), `GET /auth/me`.
- **`vault-service`** — `api_keys` (id, account_id, name, scope, hashed secret, status `ACTIVE`/`REVOKED`, created_at). Endpoints (all require a valid JWT): `POST /keys`, `GET /keys`, `POST /keys/{id}/rotate`, `DELETE /keys/{id}` (revoke). **RBAC:** an account only sees/acts on its own keys; `ADMIN` may list all.

**Security invariants (what the gates protect):**
- Passwords and API-key secrets are **never stored in plaintext** (BCrypt / hashed; the raw key is shown once on creation).
- JWTs are signed and validated; tampered/expired tokens → `401`.
- Cross-account access → `403` (authz negative tests enforce this).
- All input is validated at the edge (Bean Validation); errors use RFC 7807 `application/problem+json`.

### The pipeline (the star)

```
PR ─▶ build (mvn) ─▶ unit tests ─▶ REST Assured (Testcontainers) ─▶ JaCoCo
        └─▶ SonarQube scan ─▶ QUALITY GATE ─▶ Trivy/OWASP + gitleaks ─▶ SBOM
                                   │                                      │
                              (fail = block PR)              main ─▶ Docker image ─▶ GHCR
```

Each gate has a clear, demonstrable failure mode: a vulnerable dependency, an unreviewed security hotspot, a coverage drop, a leaked secret, or a broken API contract.

---

## 5. Project phases

> Each phase ends with something demonstrable and a commit/tag. Durations assume part-time work with Claude Code.

### Phase 0 — Foundations (2–4 days)
**Stack:** Maven, Spring Boot, Docker, GitHub Actions (skeleton).
- Multi-module Maven: parent `pom.xml` + `common`, `auth-service`, `vault-service`; Maven Wrapper; Java 21 + Spring Boot 3 BOM.
- Spring Boot skeletons exposing `/actuator/health`; multi-stage Dockerfiles; `docker-compose.yml` (Postgres + both services).
- Root `CLAUDE.md` (English code, conventional commits, how to run); `.claude/agents/`.
- Minimal CI: `securegate-ci.yml` running `./mvnw -q verify` on PRs that touch `SecureGate/**`.
- **Deliverable:** `docker compose up` brings up Postgres + both services (health OK); `./mvnw verify` is green; CI runs on PR.
- **Delegate:** `backend-dev` (Maven/Spring scaffolding) · `devsecops` (Docker + CI skeleton).
- **With Claude Code:** plan mode → *"Read ROADMAP.md, Phase 0, and create the multi-module skeleton."*

### Phase 1 — Core microservices (1–2 weeks)
**Stack:** Spring Boot, Spring Data JPA, Flyway, PostgreSQL, JWT.
- `auth-service`: register/login, BCrypt hashing, JWT issuance (`jjwt`/Nimbus), `/auth/me`, role model; Flyway migration for `accounts`.
- `vault-service`: API-key CRUD + rotate/revoke, owner-scoped RBAC, JWT validation (shared HMAC secret or JWKS); Flyway migration for `api_keys`; secrets hashed at rest.
- Layered architecture (controller/service/repository), Bean Validation, RFC 7807 error model, JUnit unit tests for domain/services.
- **Deliverable:** register → login → create/list/rotate/revoke keys via `curl`, end to end.
- **Delegate:** `backend-dev`.

### Phase 2 — Automated API testing with REST Assured (1 week)
**Stack:** REST Assured + Testcontainers (Postgres) + Spring Boot Test.
- Integration suites per service against the running app with a containerised Postgres.
- Cases: happy paths; validation `400`; missing/invalid JWT `401`; cross-account access `403`; not-found `404`; security negatives (tampered JWT, oversized/odd input, injection-style payloads rejected; secrets never echoed back).
- Bind to `mvn verify` via the Failsafe plugin (integration-test phase).
- **Deliverable:** `./mvnw verify` runs the full REST Assured suite green; a documented case matrix in the README.
- **Delegate:** `test-engineer`.

### Phase 3 — Static analysis & quality gate (1 week)
**Stack:** SonarQube/SonarCloud + JaCoCo.
- Aggregate JaCoCo coverage across modules; wire the Sonar scanner.
- Configure a **Quality Gate**: fail on new bugs, new vulnerabilities, unreviewed security hotspots, coverage-on-new-code below threshold, and duplication.
- Burn down the initial findings; capture a deliberately-introduced vulnerability being caught and fixed.
- **Deliverable:** Sonar dashboard green; a PR that *fails* the gate plus the fix that passes it (screenshot for the portfolio).
- **Delegate:** `devsecops` (Sonar + gate) · `backend-dev` (fix findings).

### Phase 4 — CI/CD pipeline in GitHub Actions (1 week)
**Stack:** GitHub Actions + GHCR.
- Full pipeline: checkout → JDK + Maven cache → `verify` (unit + REST Assured) → JaCoCo → SonarCloud scan + **gate** → build multi-stage Docker images → push to GHCR on `main`.
- Branch protection: PRs require the pipeline + Sonar gate to merge.
- Status / quality-gate / coverage badges in the README.
- **Deliverable:** green pipeline on PR; images published to GHCR on merge; live badges.
- **Delegate:** `devsecops`.

### Phase 5 — Supply-chain & container hardening (1 week)
**Stack:** Docker, Trivy / OWASP Dependency-Check, gitleaks, CycloneDX.
- Multi-stage, non-root, minimal/distroless images with pinned base digests.
- CI scanning: Trivy (image + filesystem) and/or OWASP Dependency-Check — fail on HIGH/CRITICAL; gitleaks secret scan; CycloneDX **SBOM** as a build artifact.
- **Deliverable:** hardened images; CI blocks a known-vulnerable dependency; SBOM attached to releases.
- **Delegate:** `devsecops`.

### Phase 6 — Polish & docs (3–5 days)
- README: architecture + pipeline diagram (Mermaid), badges, "what each gate enforces", a sample security report; a short threat-model note; tag a release.
- Final `code-reviewer` pass; wire the portfolio entry to the repo.
- **Deliverable:** a documented repo + the SecureGate portfolio entry.
- **Delegate:** `backend-dev` / `devsecops` · `code-reviewer` (final review).

---

## 6. Dependency order

```
Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6
```

Mostly linear: Phase 3's gate needs Phase 2's tests for coverage; Phase 4 wires Phase 3's gate into CI; Phase 5 adds scanning steps to Phase 4's pipeline. The two services in Phase 1 (`auth` and `vault`) can be split across sessions if desired.

---

## 7. Claude Code subagents (task delegation)

Subagents live in `.claude/agents/` (project-level, versioned in git). They are Markdown files with YAML frontmatter; create and manage them with the `/agents` command. Docs: https://code.claude.com/docs/en/sub-agents

| Agent | Model | Tools | Role |
|---|---|---|---|
| `backend-dev` | sonnet | all | Spring Boot services, JPA/Flyway, JWT, domain logic. |
| `test-engineer` | sonnet | all | REST Assured + Testcontainers suites; JUnit; coverage. |
| `devsecops` | sonnet | all | GitHub Actions, SonarQube gate, Docker hardening, Trivy/OWASP, SBOM. |
| `code-reviewer` | sonnet | Read, Grep, Glob | Diff review: security (OWASP), types, conventions. Read-only. |
| `test-runner` | haiku | Bash, Read | Runs `./mvnw verify` and reports only the failures (saves context). |

### Example: `.claude/agents/devsecops.md`

```markdown
---
name: devsecops
description: Owns the CI/CD pipeline, SonarQube quality gate, Docker hardening and supply-chain scanning. Use for tasks in .github/workflows, Dockerfiles, or the security gates.
model: sonnet
---

You are the DevSecOps engineer for SecureGate.

Principles:
- Shift left: every gate fails the build on a real risk (new vulnerability, unreviewed
  hotspot, coverage drop, HIGH/CRITICAL dependency or image CVE, leaked secret).
- Pipelines are reproducible and cached; images are multi-stage, non-root, pinned by digest.
- A failing gate must produce a clear, actionable report.

Conventions: pin action versions, least-privilege GITHUB_TOKEN, never echo secrets in logs.
```

### Example: `.claude/agents/code-reviewer.md`

```markdown
---
name: code-reviewer
description: Reviews recent changes for security issues, bugs and convention violations. Use proactively after implementing features.
model: sonnet
tools: Read, Grep, Glob
---

You are a senior application-security reviewer. Review the latest diff and report
findings by severity (critical/medium/minor). Check for: secrets in code, missing
input validation, broken authz (cross-account access), plaintext secrets/passwords,
SQL/JPA injection and missing tests. You do not modify files: you only report.
```

### Suggested per-phase workflow

1. `claude` at the project root → plan mode → *"Read Phase N of ROADMAP.md and propose a plan."*
2. Approve and let it delegate: Spring work → `backend-dev`, tests → `test-engineer`, pipeline/security → `devsecops`.
3. After each block: *"Use code-reviewer on the changes"* → fix → commit.
4. `test-runner` for long Maven runs without filling the main context.

---

## 8. Portfolio extras (if there's time)

- A deliberately-vulnerable branch + the pipeline blocking it (a great demo GIF).
- A `SECURITY.md` with the threat model and the gate policy.
- Renovate/Dependabot for automated dependency PRs that re-run the gates.
- A small badge wall summarising build, quality gate, coverage and the last scan.
