# services/labels

Stateless FastAPI label microservice. `POST /label` receives the shipment data
and returns a 4×6 PDF with a Code-128 barcode (`reportlab` + `python-barcode`)
and a QR code pointing to the public tracking URL. Implemented in **Phase 4** —
see `ROADMAP.md`.

**Golden rule:** this service is stateless and **never touches the database**.
It receives data over HTTP, renders a PDF, and returns it. Only `apps/api`
writes to PostgreSQL.

## Endpoints

- `GET /health` -> `{"status":"ok","service":"labels"}`
- `POST /label`

Request body:

```json
{
  "trackingCode": "PTY-2026-001011-9",
  "serviceLevel": "EXPRESS",
  "origin": { "city": "Panama City", "country": "PA" },
  "destination": { "city": "Miami", "country": "US" },
  "weightGrams": 2000,
  "trackingUrl": "https://example.com/en/tracking/PTY-2026-001011-9"
}
```

Response: a **4×6 inch (288×432 pt) PDF** as `application/pdf`, returned as an
attachment with `Content-Disposition: attachment; filename="label-<trackingCode>.pdf"`.

The label includes the **Shipping Hub** wordmark, the service level, the origin
and destination (city, country), the weight, a **Code-128** barcode of the
tracking code, the tracking code text, and a **QR code** of the tracking URL.

Invalid input (unknown `serviceLevel`, non-positive weight, bad country code,
missing fields) returns HTTP 422.

## Layout

- `label.py` — barcode/QR/PDF rendering (pure, returns `bytes`, testable).
- `main.py` — FastAPI app + Pydantic request model; streams the PDF response.
- `tests/` — pytest suite (pure rendering + FastAPI `TestClient`).

## Run locally

```bash
cd services/labels
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8002
```

Then:

```bash
curl http://127.0.0.1:8002/health
curl -X POST http://127.0.0.1:8002/label \
  -H 'Content-Type: application/json' \
  -o label.pdf \
  -d '{"trackingCode":"PTY-2026-001011-9","serviceLevel":"EXPRESS","origin":{"city":"Panama City","country":"PA"},"destination":{"city":"Miami","country":"US"},"weightGrams":2000,"trackingUrl":"https://example.com/en/tracking/PTY-2026-001011-9"}'
```

`label.pdf` is the generated 4×6 shipping label.

## Test

```bash
cd services/labels
source .venv/bin/activate
pytest
```

## Docker

```bash
cd services/labels
docker build -t shipping-hub-labels .
docker run --rm -p 8002:8002 shipping-hub-labels
```

The image is based on `python:3.12-slim` and serves on port **8002**.

## Notes

`httpx` is included in `requirements.txt` because FastAPI's `TestClient` (used by
the test suite) requires an HTTP client at import time.
