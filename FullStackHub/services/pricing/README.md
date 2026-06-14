# services/pricing

Stateless FastAPI quoting microservice. `POST /quote` receives
origin/destination/weight/service and returns price + ETA (rules by zone,
business days and holidays). Implemented in **Phase 4** — see `ROADMAP.md`.

**Golden rule:** this service is stateless and **never touches the database**.
It receives data over HTTP, computes, and returns a quote. Only `apps/api`
writes to PostgreSQL.

## Endpoints

- `GET /health` -> `{"status":"ok","service":"pricing"}`
- `POST /quote`

Request body:

```json
{
  "originCountry": "PA",
  "destinationCountry": "US",
  "weightGrams": 2000,
  "lengthCm": 30,
  "widthCm": 20,
  "heightCm": 15,
  "serviceLevel": "EXPRESS"
}
```

`serviceLevel` is one of `EXPRESS | STANDARD | ECONOMY`; country codes are ISO
alpha-2. Response:

```json
{
  "zoneCode": "US",
  "serviceLevel": "EXPRESS",
  "billableWeightGrams": 2000,
  "priceCents": 3700,
  "currency": "USD",
  "etaMinDays": 1,
  "etaMaxDays": 3,
  "estimatedDeliveryAt": "2026-06-17T19:44:51Z"
}
```

`estimatedDeliveryAt` is computed from the current UTC time, so its time-of-day
component reflects when the quote was requested. Invalid input (unknown
`serviceLevel`, non-positive weight/dimensions, bad country code) returns
HTTP 422.

## Pricing rules

The pricing math mirrors the Node API (`apps/api/src/domain/pricing.ts` and the
seeded rate table in `apps/api/prisma/reference.ts`) so quotes stay consistent:

- **Zone** from `destinationCountry`: `PA -> PA`, `US -> US`, anything else -> `LATAM`.
- **Rate table** `[baseCents, perKgCents, etaMinDays, etaMaxDays]` per zone & service level
  (see `pricing.py`).
- `volumetricGrams = round(lengthCm * widthCm * heightCm / 5000 * 1000)`
- `billableWeightGrams = max(weightGrams, volumetricGrams)`
- `chargeableKg = max(1, ceil(billableWeightGrams / 1000))`
- `priceCents = baseCents + chargeableKg * perKgCents`
- `estimatedDeliveryAt = now (UTC) + etaMaxDays business days`, skipping
  Saturdays, Sundays and public holidays. Panama holidays always apply; US
  holidays apply additionally when the destination is the US (see `holidays.py`).

## Layout

- `holidays.py` — holiday calendar + business-day arithmetic (pure, testable).
- `pricing.py` — zone resolution and pricing/ETA math (pure, testable).
- `main.py` — FastAPI app + Pydantic request/response models.
- `tests/` — pytest suite (pure helpers + FastAPI `TestClient`).

## Run locally

```bash
cd services/pricing
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
```

Then:

```bash
curl http://127.0.0.1:8001/health
curl -X POST http://127.0.0.1:8001/quote \
  -H 'Content-Type: application/json' \
  -d '{"originCountry":"PA","destinationCountry":"US","weightGrams":2000,"lengthCm":30,"widthCm":20,"heightCm":15,"serviceLevel":"EXPRESS"}'
```

## Test

```bash
cd services/pricing
source .venv/bin/activate
pytest
```

## Docker

```bash
cd services/pricing
docker build -t shipping-hub-pricing .
docker run --rm -p 8001:8001 shipping-hub-pricing
```

The image is based on `python:3.12-slim` and serves on port **8001**.
