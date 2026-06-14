"""FastAPI wiring for the stateless pricing microservice.

Responsibilities are limited to HTTP concerns: request validation (Pydantic v2),
calling the pure helpers in :mod:`pricing`, and shaping the JSON response. This
service never touches a database; it receives data, computes, and returns a quote.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import FastAPI
from pydantic import BaseModel, Field, field_serializer

from holidays import utc_now
from pricing import compute_quote

app = FastAPI(
    title="Shipping Hub Pricing Service",
    description="Stateless quoting microservice: price + ETA by zone, business days and holidays.",
    version="1.0.0",
)

ServiceLevel = Literal["EXPRESS", "STANDARD", "ECONOMY"]

# ISO alpha-2 country code: exactly two ASCII letters.
CountryCode = Annotated[str, Field(min_length=2, max_length=2, pattern=r"^[A-Za-z]{2}$")]


class QuoteRequest(BaseModel):
    """Inbound payload for ``POST /quote``.

    Pydantic enforces the contract: an unknown ``serviceLevel`` or a
    non-positive weight/dimension fails validation and FastAPI returns 422.
    Field aliases keep the wire format camelCase while the Python attributes
    stay snake_case.
    """

    origin_country: CountryCode = Field(alias="originCountry")
    destination_country: CountryCode = Field(alias="destinationCountry")
    weight_grams: int = Field(alias="weightGrams", gt=0, le=70_000)
    length_cm: float = Field(alias="lengthCm", gt=0)
    width_cm: float = Field(alias="widthCm", gt=0)
    height_cm: float = Field(alias="heightCm", gt=0)
    service_level: ServiceLevel = Field(alias="serviceLevel")

    model_config = {"populate_by_name": True, "extra": "forbid"}


class QuoteResponse(BaseModel):
    """Outbound payload for ``POST /quote`` (camelCase on the wire)."""

    zone_code: str = Field(serialization_alias="zoneCode")
    service_level: ServiceLevel = Field(serialization_alias="serviceLevel")
    billable_weight_grams: int = Field(serialization_alias="billableWeightGrams")
    price_cents: int = Field(serialization_alias="priceCents")
    currency: str
    eta_min_days: int = Field(serialization_alias="etaMinDays")
    eta_max_days: int = Field(serialization_alias="etaMaxDays")
    estimated_delivery_at: datetime = Field(serialization_alias="estimatedDeliveryAt")

    model_config = {"populate_by_name": True}

    @field_serializer("estimated_delivery_at")
    def _serialize_eta(self, value: datetime) -> str:
        """Render the ETA as an ISO 8601 UTC string with a trailing ``Z``."""
        as_utc = value.astimezone(timezone.utc).replace(microsecond=0)
        return as_utc.isoformat().replace("+00:00", "Z")


class HealthResponse(BaseModel):
    status: str
    service: str


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness probe."""
    return HealthResponse(status="ok", service="pricing")


@app.post("/quote", response_model=QuoteResponse, response_model_by_alias=True)
def create_quote(payload: QuoteRequest) -> QuoteResponse:
    """Compute price and ETA for a shipment. Stateless; no persistence."""
    quote = compute_quote(
        origin_country=payload.origin_country,
        destination_country=payload.destination_country,
        weight_grams=payload.weight_grams,
        length_cm=payload.length_cm,
        width_cm=payload.width_cm,
        height_cm=payload.height_cm,
        service_level=payload.service_level,
        now=utc_now(),
    )
    return QuoteResponse(
        zone_code=quote.zone_code,
        service_level=quote.service_level,  # type: ignore[arg-type]
        billable_weight_grams=quote.billable_weight_grams,
        price_cents=quote.price_cents,
        currency=quote.currency,
        eta_min_days=quote.eta_min_days,
        eta_max_days=quote.eta_max_days,
        estimated_delivery_at=quote.estimated_delivery_at,
    )
