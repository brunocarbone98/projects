"""Pure label-rendering logic for the labels microservice.

This module turns shipment data into a 4x6 inch (288x432 pt) PDF held entirely
in memory. It has no FastAPI or I/O dependencies (it returns raw ``bytes``), so
the rendering can be unit-tested directly.

The label is composed with ReportLab; the Code-128 barcode is produced with
``python-barcode`` rendered to a PNG, and the QR code with ``qrcode`` rendered
to a PNG. Both images are placed onto the ReportLab canvas.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import barcode
import qrcode
from barcode.writer import ImageWriter
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

# 4x6 inch thermal label in PostScript points (72 pt/inch) -> 288 x 432 pt.
LABEL_WIDTH_PT: float = 4 * inch
LABEL_HEIGHT_PT: float = 6 * inch

MARGIN_PT: float = 0.25 * inch
WORDMARK: str = "Shipping Hub"


@dataclass(frozen=True)
class Address:
    """A shipment endpoint: a city and an ISO alpha-2 country."""

    city: str
    country: str


@dataclass(frozen=True)
class LabelData:
    """Everything required to render a shipping label."""

    tracking_code: str
    service_level: str
    origin: Address
    destination: Address
    weight_grams: int
    tracking_url: str


def render_barcode_png(tracking_code: str) -> bytes:
    """Render a Code-128 barcode of ``tracking_code`` as PNG bytes."""
    code128 = barcode.get("code128", tracking_code, writer=ImageWriter())
    buffer = io.BytesIO()
    # Hide the human-readable text under the bars: the tracking code is already
    # printed separately on the label in a larger font.
    code128.write(buffer, options={"write_text": False, "module_height": 12.0})
    return buffer.getvalue()


def render_qr_png(tracking_url: str) -> bytes:
    """Render a QR code of ``tracking_url`` as PNG bytes."""
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(tracking_url)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _draw_divider(pdf: canvas.Canvas, y: float) -> None:
    pdf.setLineWidth(1)
    pdf.line(MARGIN_PT, y, LABEL_WIDTH_PT - MARGIN_PT, y)


def render_label_pdf(data: LabelData) -> bytes:
    """Render the full 4x6 shipping label as PDF bytes.

    Layout (top to bottom): the "Shipping Hub" wordmark and service level, the
    origin and destination blocks, the parcel weight, the Code-128 barcode with
    the tracking code text beneath it, and the QR code of the tracking URL.
    """
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(LABEL_WIDTH_PT, LABEL_HEIGHT_PT))
    pdf.setTitle(f"Shipping Hub label {data.tracking_code}")

    left = MARGIN_PT
    right = LABEL_WIDTH_PT - MARGIN_PT
    top = LABEL_HEIGHT_PT - MARGIN_PT

    # --- Header: wordmark + service level ---------------------------------
    pdf.setFont("Helvetica-Bold", 22)
    pdf.drawString(left, top - 18, WORDMARK)
    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawRightString(right, top - 16, data.service_level)
    _draw_divider(pdf, top - 28)

    # --- Origin / destination ---------------------------------------------
    section_top = top - 48
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawString(left, section_top, "FROM")
    pdf.setFont("Helvetica", 11)
    pdf.drawString(left, section_top - 15, f"{data.origin.city}, {data.origin.country}")

    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawString(left, section_top - 38, "TO")
    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawString(
        left, section_top - 56, f"{data.destination.city}, {data.destination.country}"
    )
    _draw_divider(pdf, section_top - 70)

    # --- Weight ------------------------------------------------------------
    weight_y = section_top - 92
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawString(left, weight_y, "WEIGHT")
    pdf.setFont("Helvetica", 11)
    pdf.drawString(left + 60, weight_y, f"{data.weight_grams} g")

    # --- Barcode (Code-128) + tracking code text ---------------------------
    barcode_img = ImageReader(io.BytesIO(render_barcode_png(data.tracking_code)))
    barcode_w = LABEL_WIDTH_PT - 2 * MARGIN_PT
    barcode_h = 0.9 * inch
    barcode_y = weight_y - 20 - barcode_h
    pdf.drawImage(
        barcode_img,
        left,
        barcode_y,
        width=barcode_w,
        height=barcode_h,
        preserveAspectRatio=True,
        anchor="n",
        mask="auto",
    )
    pdf.setFont("Helvetica-Bold", 14)
    pdf.drawCentredString(LABEL_WIDTH_PT / 2, barcode_y - 18, data.tracking_code)

    # --- QR code (tracking URL) -------------------------------------------
    qr_img = ImageReader(io.BytesIO(render_qr_png(data.tracking_url)))
    qr_size = 1.4 * inch
    qr_x = (LABEL_WIDTH_PT - qr_size) / 2
    qr_y = MARGIN_PT + 18
    pdf.drawImage(
        qr_img, qr_x, qr_y, width=qr_size, height=qr_size, preserveAspectRatio=True, mask="auto"
    )
    pdf.setFont("Helvetica", 7)
    pdf.drawCentredString(LABEL_WIDTH_PT / 2, MARGIN_PT + 6, "Scan to track your shipment")

    pdf.showPage()
    pdf.save()
    return buffer.getvalue()
