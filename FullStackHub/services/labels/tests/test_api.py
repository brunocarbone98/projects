"""Endpoint tests for the labels service using FastAPI's TestClient."""

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

SAMPLE_REQUEST = {
    "trackingCode": "PTY-2026-001011-9",
    "serviceLevel": "EXPRESS",
    "origin": {"city": "Panama City", "country": "PA"},
    "destination": {"city": "Miami", "country": "US"},
    "weightGrams": 2000,
    "trackingUrl": "https://example.com/en/tracking/PTY-2026-001011-9",
}


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "labels"}


def test_label_returns_pdf() -> None:
    response = client.post("/label", json=SAMPLE_REQUEST)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content[:4] == b"%PDF"


def test_label_content_disposition_filename() -> None:
    response = client.post("/label", json=SAMPLE_REQUEST)
    assert response.status_code == 200
    disposition = response.headers["content-disposition"]
    assert "attachment" in disposition
    assert 'filename="label-PTY-2026-001011-9.pdf"' in disposition


def test_label_rejects_unknown_service_level() -> None:
    response = client.post("/label", json={**SAMPLE_REQUEST, "serviceLevel": "PRIORITY"})
    assert response.status_code == 422


def test_label_rejects_non_positive_weight() -> None:
    response = client.post("/label", json={**SAMPLE_REQUEST, "weightGrams": 0})
    assert response.status_code == 422


def test_label_rejects_missing_tracking_code() -> None:
    payload = dict(SAMPLE_REQUEST)
    del payload["trackingCode"]
    response = client.post("/label", json=payload)
    assert response.status_code == 422


def test_label_rejects_bad_country_code() -> None:
    payload = {**SAMPLE_REQUEST, "destination": {"city": "Miami", "country": "USA"}}
    response = client.post("/label", json=payload)
    assert response.status_code == 422
