"""Unit tests for the pure pricing helpers."""

from datetime import datetime, timezone

import pytest

from pricing import (
    RATES,
    billable_weight_grams,
    chargeable_kg,
    compute_price_cents,
    compute_quote,
    resolve_zone_code,
    volumetric_weight_grams,
)


@pytest.mark.parametrize(
    ("country", "expected"),
    [
        ("PA", "PA"),
        ("pa", "PA"),
        ("US", "US"),
        ("us", "US"),
        ("MX", "LATAM"),
        ("CO", "LATAM"),
        ("DE", "LATAM"),
    ],
)
def test_resolve_zone_code(country: str, expected: str) -> None:
    assert resolve_zone_code(country) == expected


def test_volumetric_weight_grams_rounds() -> None:
    # 30 * 20 * 15 = 9000 cm3 -> 9000 / 5000 * 1000 = 1800 g.
    assert volumetric_weight_grams(30, 20, 15) == 1800


def test_volumetric_weight_grams_rounding_behaviour() -> None:
    # 33 * 21 * 16 = 11088 -> /5000*1000 = 2217.6 -> round -> 2218.
    assert volumetric_weight_grams(33, 21, 16) == 2218


def test_billable_weight_prefers_volumetric_when_larger() -> None:
    # Light but bulky parcel: volumetric (1800) beats actual (500).
    assert billable_weight_grams(500, 30, 20, 15) == 1800


def test_billable_weight_prefers_actual_when_larger() -> None:
    assert billable_weight_grams(5000, 10, 10, 10) == 5000


@pytest.mark.parametrize(
    ("grams", "expected"),
    [
        (1, 1),
        (999, 1),
        (1000, 1),
        (1001, 2),
        (2000, 2),
        (2001, 3),
        (0, 1),  # the one-kilo minimum still applies
    ],
)
def test_chargeable_kg_minimum_and_ceiling(grams: int, expected: int) -> None:
    assert chargeable_kg(grams) == expected


def test_compute_price_cents_matches_formula() -> None:
    # US EXPRESS base 2500 + 2 kg * 600 = 3700.
    assert compute_price_cents(2500, 600, 2000) == 3700


def test_rate_table_matches_node_reference() -> None:
    # Guards against drift from apps/api/prisma/reference.ts.
    assert RATES["PA"]["EXPRESS"] == (800, 150, 1, 1)
    assert RATES["PA"]["STANDARD"] == (500, 100, 1, 2)
    assert RATES["PA"]["ECONOMY"] == (350, 70, 2, 3)
    assert RATES["US"]["EXPRESS"] == (2500, 600, 1, 3)
    assert RATES["US"]["STANDARD"] == (1500, 400, 3, 6)
    assert RATES["US"]["ECONOMY"] == (1000, 250, 6, 10)
    assert RATES["LATAM"]["EXPRESS"] == (3000, 800, 2, 4)
    assert RATES["LATAM"]["STANDARD"] == (1800, 500, 4, 8)
    assert RATES["LATAM"]["ECONOMY"] == (1200, 300, 8, 14)


def test_compute_quote_matches_spec_example() -> None:
    # The canonical example from the task spec.
    now = datetime(2026, 6, 14, 0, 0, 0, tzinfo=timezone.utc)  # a Sunday
    quote = compute_quote(
        origin_country="PA",
        destination_country="US",
        weight_grams=2000,
        length_cm=30,
        width_cm=20,
        height_cm=15,
        service_level="EXPRESS",
        now=now,
    )
    assert quote.zone_code == "US"
    assert quote.service_level == "EXPRESS"
    assert quote.billable_weight_grams == 2000
    assert quote.price_cents == 3700
    assert quote.currency == "USD"
    assert quote.eta_min_days == 1
    assert quote.eta_max_days == 3
    # Sun Jun 14 + 3 US business days: Mon 15, Tue 16, Wed 17 -> Jun 17.
    assert quote.estimated_delivery_at == datetime(2026, 6, 17, 0, 0, 0, tzinfo=timezone.utc)


def test_compute_quote_latam_zone_for_unknown_country() -> None:
    now = datetime(2026, 6, 14, 0, 0, 0, tzinfo=timezone.utc)
    quote = compute_quote(
        origin_country="PA",
        destination_country="CO",
        weight_grams=1000,
        length_cm=10,
        width_cm=10,
        height_cm=10,
        service_level="STANDARD",
        now=now,
    )
    assert quote.zone_code == "LATAM"
    # LATAM STANDARD base 1800 + 1 kg * 500 = 2300.
    assert quote.price_cents == 2300
