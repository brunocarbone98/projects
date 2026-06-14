"""FastAPI wiring for the stateless labels microservice.

Validates the request (Pydantic v2), renders a 4x6 PDF label with the pure
helpers in :mod:`label`, and streams it back as ``application/pdf``. This
service never touches a database; it receives data, generates a PDF, returns it.
"""

from __future__ import annotations

from typing import Literal

from fastapi import FastAPI, Response
from pydantic import BaseModel, Field

from label import Address, LabelData, render_label_pdf

app = FastAPI(
    title="Shipping Hub Labels Service",
    description="Stateless label microservice: renders a 4x6 PDF with a Code-128 barcode and a QR code.",
    version="1.0.0",
)

ServiceLevel = Literal["EXPRESS", "STANDARD", "ECONOMY"]


class AddressModel(BaseModel):
    """A shipment endpoint on the wire."""

    city: str = Field(min_length=1)
    country: str = Field(min_length=2, max_length=2, pattern=r"^[A-Za-z]{2}$")


class LabelRequest(BaseModel):
    """Inbound payload for ``POST /label`` (camelCase on the wire)."""

    tracking_code: str = Field(alias="trackingCode", min_length=1)
    service_level: ServiceLevel = Field(alias="serviceLevel")
    origin: AddressModel
    destination: AddressModel
    weight_grams: int = Field(alias="weightGrams", gt=0, le=70_000)
    tracking_url: str = Field(alias="trackingUrl", min_length=1)

    model_config = {"populate_by_name": True, "extra": "forbid"}


class HealthResponse(BaseModel):
    status: str
    service: str


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness probe."""
    return HealthResponse(status="ok", service="labels")


@app.post(
    "/label",
    responses={200: {"content": {"application/pdf": {}}}},
    response_class=Response,
)
def create_label(payload: LabelRequest) -> Response:
    """Render a 4x6 PDF shipping label and return it as an attachment."""
    data = LabelData(
        tracking_code=payload.tracking_code,
        service_level=payload.service_level,
        origin=Address(city=payload.origin.city, country=payload.origin.country),
        destination=Address(
            city=payload.destination.city, country=payload.destination.country
        ),
        weight_grams=payload.weight_grams,
        tracking_url=payload.tracking_url,
    )
    pdf_bytes = render_label_pdf(data)
    filename = f"label-{payload.tracking_code}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
