"""Endpoint tests for the pricing service using FastAPI's TestClient."""

import re

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

SAMPLE_REQUEST = {
    "originCountry": "PA",
    "destinationCountry": "US",
    "weightGrams": 2000,
    "lengthCm": 30,
    "widthCm": 20,
    "heightCm": 15,
    "serviceLevel": "EXPRESS",
}

ISO_UTC_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "pricing"}


def test_quote_sample_payload() -> None:
    response = client.post("/quote", json=SAMPLE_REQUEST)
    assert response.status_code == 200
    body = response.json()
    assert body["zoneCode"] == "US"
    assert body["serviceLevel"] == "EXPRESS"
    assert body["billableWeightGrams"] == 2000
    assert body["priceCents"] == 3700
    assert body["currency"] == "USD"
    assert body["etaMinDays"] == 1
    assert body["etaMaxDays"] == 3
    # ISO 8601 UTC string with a trailing Z.
    assert ISO_UTC_Z.match(body["estimatedDeliveryAt"])


def test_quote_panama_domestic() -> None:
    response = client.post(
        "/quote",
        json={**SAMPLE_REQUEST, "destinationCountry": "PA", "serviceLevel": "STANDARD"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["zoneCode"] == "PA"
    # PA STANDARD base 500 + 2 kg * 100 = 700.
    assert body["priceCents"] == 700


def test_quote_latam_zone() -> None:
    response = client.post(
        "/quote",
        json={**SAMPLE_REQUEST, "destinationCountry": "CO", "serviceLevel": "ECONOMY"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["zoneCode"] == "LATAM"
    # LATAM ECONOMY base 1200 + 2 kg * 300 = 1800.
    assert body["priceCents"] == 1800


def test_quote_rejects_unknown_service_level() -> None:
    response = client.post("/quote", json={**SAMPLE_REQUEST, "serviceLevel": "PRIORITY"})
    assert response.status_code == 422


def test_quote_rejects_non_positive_weight() -> None:
    response = client.post("/quote", json={**SAMPLE_REQUEST, "weightGrams": 0})
    assert response.status_code == 422


def test_quote_rejects_non_positive_dimension() -> None:
    response = client.post("/quote", json={**SAMPLE_REQUEST, "heightCm": 0})
    assert response.status_code == 422


def test_quote_rejects_negative_dimension() -> None:
    response = client.post("/quote", json={**SAMPLE_REQUEST, "widthCm": -5})
    assert response.status_code == 422


def test_quote_rejects_invalid_country_code() -> None:
    response = client.post("/quote", json={**SAMPLE_REQUEST, "destinationCountry": "USA"})
    assert response.status_code == 422


def test_quote_rejects_missing_field() -> None:
    payload = dict(SAMPLE_REQUEST)
    del payload["weightGrams"]
    response = client.post("/quote", json=payload)
    assert response.status_code == 422
