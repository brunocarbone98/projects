# services/labels

FastAPI label microservice: `POST /label` receives the shipment data and returns a 4×6 PDF with a Code-128 barcode (`reportlab` + `python-barcode`) and a QR pointing to the public tracking URL. Implemented in **Phase 4** — see `ROADMAP.md`.

**Golden rule:** this service is stateless and **never touches the database**. Only `apps/api` writes to PostgreSQL.
