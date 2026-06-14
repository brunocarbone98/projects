"""Pure pricing and ETA logic.

These helpers intentionally mirror the Node API's ``apps/api/src/domain/pricing.ts``
and the seeded rate table in ``apps/api/prisma/reference.ts`` so quotes produced
by this microservice stay byte-for-byte consistent with the transactional API.

No FastAPI, no I/O, no database: just deterministic arithmetic over the inputs.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime

from holidays import add_business_days

# Supported service levels (kept in sync with packages/shared/src/enums.ts).
SERVICE_LEVELS: tuple[str, ...] = ("EXPRESS", "STANDARD", "ECONOMY")

# Currency is fixed for the whole rate table.
CURRENCY: str = "USD"

# [baseCents, perKgCents, etaMinDays, etaMaxDays] per zone & service level.
# Mirrors RATES in apps/api/prisma/reference.ts exactly.
Rate = tuple[int, int, int, int]
RATES: dict[str, dict[str, Rate]] = {
    "PA": {
        "EXPRESS": (800, 150, 1, 1),
        "STANDARD": (500, 100, 1, 2),
        "ECONOMY": (350, 70, 2, 3),
    },
    "US": {
        "EXPRESS": (2500, 600, 1, 3),
        "STANDARD": (1500, 400, 3, 6),
        "ECONOMY": (1000, 250, 6, 10),
    },
    "LATAM": {
        "EXPRESS": (3000, 800, 2, 4),
        "STANDARD": (1800, 500, 4, 8),
        "ECONOMY": (1200, 300, 8, 14),
    },
}


def resolve_zone_code(destination_country: str) -> str:
    """Map a destination country (ISO alpha-2) to a rate zone. Origin is Panama."""
    country = destination_country.upper()
    if country == "PA":
        return "PA"
    if country == "US":
        return "US"
    return "LATAM"


def volumetric_weight_grams(length_cm: float, width_cm: float, height_cm: float) -> int:
    """Volumetric weight in grams using the standard 5000 cm3/kg divisor."""
    return round((length_cm * width_cm * height_cm) / 5000 * 1000)


def billable_weight_grams(
    actual_grams: int, length_cm: float, width_cm: float, height_cm: float
) -> int:
    """The greater of the actual weight and the volumetric weight, in grams."""
    return max(actual_grams, volumetric_weight_grams(length_cm, width_cm, height_cm))


def chargeable_kg(billable_grams: int) -> int:
    """Chargeable kilograms: billable grams rounded up, with a one-kilo minimum."""
    return max(1, math.ceil(billable_grams / 1000))


def compute_price_cents(base_cents: int, per_kg_cents: int, billable_grams: int) -> int:
    """Price = base + ceil(billable kg) * perKg, with a minimum of one kilo."""
    return base_cents + chargeable_kg(billable_grams) * per_kg_cents


@dataclass(frozen=True)
class Quote:
    """The fully computed result of a quote request."""

    zone_code: str
    service_level: str
    billable_weight_grams: int
    price_cents: int
    currency: str
    eta_min_days: int
    eta_max_days: int
    estimated_delivery_at: datetime


def compute_quote(
    *,
    origin_country: str,
    destination_country: str,
    weight_grams: int,
    length_cm: float,
    width_cm: float,
    height_cm: float,
    service_level: str,
    now: datetime,
) -> Quote:
    """Compute a complete quote for the given shipment parameters.

    ``service_level`` must be one of :data:`SERVICE_LEVELS`; the caller (the
    Pydantic request model) is responsible for validating that, so an unknown
    value raises :class:`KeyError` here. ``now`` is injected (UTC) so the ETA is
    deterministic and testable.
    """
    zone_code = resolve_zone_code(destination_country)
    base_cents, per_kg_cents, eta_min_days, eta_max_days = RATES[zone_code][service_level]

    billable = billable_weight_grams(weight_grams, length_cm, width_cm, height_cm)
    price_cents = compute_price_cents(base_cents, per_kg_cents, billable)

    estimated_delivery_at = add_business_days(
        now, eta_max_days, destination_country=destination_country
    )

    return Quote(
        zone_code=zone_code,
        service_level=service_level,
        billable_weight_grams=billable,
        price_cents=price_cents,
        currency=CURRENCY,
        eta_min_days=eta_min_days,
        eta_max_days=eta_max_days,
        estimated_delivery_at=estimated_delivery_at,
    )
