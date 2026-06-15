# CLAUDE.md — SecureGate

DevSecOps CI/CD security pipeline gating a small Java (Spring Boot) microservices backend. The full phased plan lives in `ROADMAP.md`: when starting a phase, read its corresponding section.

**Current phase:** Roadmap stage — **not yet built**. Phase 0 (foundations) is the next step. The target system is two Spring Boot services (`auth` + `vault`) behind a GitHub Actions pipeline whose gates — REST Assured, the SonarQube quality gate, Trivy/OWASP, gitleaks and an SBOM — must pass before any change ships.

## Structure

- `services/auth-service` — accounts + JWT issuance/validation (Spring Boot, JPA, Flyway).
- `services/vault-service` — API-key vault + RBAC (Spring Boot, JPA, Flyway).
- `common` — shared DTOs, error model, JWT utilities.
- `/.github/workflows/securegate-ci.yml` (repo root) — the pipeline (GitHub only reads workflows from the repo root).
- Build: Maven multi-module (`./mvnw`). Local infra: Docker Compose (Postgres + services).

## Commands (target)

| Command | What it does |
|---|---|
| `./mvnw verify` | Build + unit + REST Assured integration tests (Testcontainers) |
| `./mvnw -pl services/auth-service spring-boot:run` | Run a single service |
| `docker compose up -d` | PostgreSQL + both services |
| `./mvnw -q -DskipTests package` | Build the jars |

## Conventions

- **Code language: English.** Identifiers, comments, commit messages, API routes and error messages are all in English.
- **Conventional commits** in English, imperative mood: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:`.
- Java 21, Spring Boot 3; layered architecture (controller/service/repository); constructor injection only.
- Validate all external input with Bean Validation at the edge; return RFC 7807 `application/problem+json` on errors.
- No secrets in code or logs; passwords and API-key secrets are hashed (BCrypt); JWTs are signed.

## Architectural rules (non-negotiable)

1. **The pipeline is the product** — every gate fails the build on a real risk; never weaken a gate just to make a build pass.
2. Secrets and passwords are never stored or logged in plaintext (BCrypt / hashed; a raw key is shown once).
3. Authorization is owner-scoped: an account only touches its own keys (`ADMIN` excepted); enforced by tests.
4. Schema changes go through Flyway migrations; never hand-edit a live schema.
5. Every new endpoint ships with REST Assured coverage (happy path + validation + authz negatives).

## Subagents (`.claude/agents/`)

- `backend-dev` — Spring Boot services, JPA/Flyway, JWT, domain logic.
- `test-engineer` — REST Assured + Testcontainers suites, JUnit, coverage.
- `devsecops` — GitHub Actions, SonarQube gate, Docker hardening, Trivy/OWASP, SBOM.
- `code-reviewer` — diff review (security, conventions); read-only.
- `test-runner` — runs `./mvnw verify` and reports only the failures.
