# services/pricing

FastAPI quoting microservice: `POST /quote` receives origin/destination/weight/service and returns price + ETA (rules by zone, business days, holidays). Implemented in **Phase 4** — see `ROADMAP.md`.

**Golden rule:** this service is stateless and **never touches the database**. Only `apps/api` writes to PostgreSQL.
