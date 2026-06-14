"""Unit tests for the pure label-rendering helpers."""

from label import (
    LABEL_HEIGHT_PT,
    LABEL_WIDTH_PT,
    Address,
    LabelData,
    render_barcode_png,
    render_label_pdf,
    render_qr_png,
)

SAMPLE = LabelData(
    tracking_code="PTY-2026-001011-9",
    service_level="EXPRESS",
    origin=Address(city="Panama City", country="PA"),
    destination=Address(city="Miami", country="US"),
    weight_grams=2000,
    tracking_url="https://example.com/en/tracking/PTY-2026-001011-9",
)


def test_label_dimensions_are_4x6_inches() -> None:
    # 4x6 inch at 72 pt/inch.
    assert LABEL_WIDTH_PT == 288
    assert LABEL_HEIGHT_PT == 432


def test_render_barcode_png_is_png() -> None:
    png = render_barcode_png("PTY-2026-001011-9")
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(png) > 100


def test_render_qr_png_is_png() -> None:
    png = render_qr_png("https://example.com/en/tracking/PTY-2026-001011-9")
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(png) > 100


def test_render_label_pdf_starts_with_pdf_magic() -> None:
    pdf = render_label_pdf(SAMPLE)
    assert pdf[:4] == b"%PDF"
    assert b"%%EOF" in pdf
    assert len(pdf) > 1000


def test_render_label_pdf_is_deterministic_size() -> None:
    # Two renders of identical data should be structurally equivalent in length.
    first = render_label_pdf(SAMPLE)
    second = render_label_pdf(SAMPLE)
    # ReportLab embeds a creation timestamp, so bytes differ; sizes stay close.
    assert abs(len(first) - len(second)) < 200


def test_render_label_handles_long_city_names() -> None:
    data = LabelData(
        tracking_code="ABC-123",
        service_level="STANDARD",
        origin=Address(city="San Pedro Sula", country="HN"),
        destination=Address(city="Rio de Janeiro", country="BR"),
        weight_grams=500,
        tracking_url="https://example.com/es/tracking/ABC-123",
    )
    pdf = render_label_pdf(data)
    assert pdf[:4] == b"%PDF"
