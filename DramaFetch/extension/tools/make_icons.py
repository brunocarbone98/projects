"""Generate the extension's toolbar icons (icons/icon16.png, icon48.png, icon128.png).

Standard library only (zlib + struct): a rounded square in DramaFetch's rose colour with a white
"download" arrow over a bar, drawn with 4x4 supersampling so the small sizes stay smooth. The
PNGs are committed; run this again only to change the artwork:

    python extension/tools/make_icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ICONS_DIR = Path(__file__).resolve().parents[1] / "icons"
SIZES = (16, 48, 128)
SUPERSAMPLE = 4
BACKGROUND = (225, 29, 92)  # rose
FOREGROUND = (255, 255, 255)
CORNER_RATIO = 0.22  # corner radius / side


def _inside_rounded_square(x: float, y: float, side: float) -> bool:
    radius = side * CORNER_RATIO
    nearest_x = min(max(x, radius), side - radius)
    nearest_y = min(max(y, radius), side - radius)
    return (x - nearest_x) ** 2 + (y - nearest_y) ** 2 <= radius**2


def _inside_arrow(x: float, y: float, side: float) -> bool:
    """The white mark, in units of the side: a shaft, an arrow head and a bar under it."""
    u, v = x / side, y / side
    shaft = 0.43 <= u <= 0.57 and 0.18 <= v <= 0.52
    head = 0.42 <= v <= 0.68 and abs(u - 0.5) <= (0.68 - v) * 1.05
    bar = 0.24 <= u <= 0.76 and 0.74 <= v <= 0.84
    return shaft or head or bar


def _pixel(px: int, py: int, size: int) -> tuple[int, int, int, int]:
    """The anti-aliased RGBA colour of one output pixel (an average of its subsamples)."""
    side = float(size)
    covered = 0
    marked = 0
    for sy in range(SUPERSAMPLE):
        for sx in range(SUPERSAMPLE):
            x = px + (sx + 0.5) / SUPERSAMPLE
            y = py + (sy + 0.5) / SUPERSAMPLE
            if _inside_rounded_square(x, y, side):
                covered += 1
                if _inside_arrow(x, y, side):
                    marked += 1
    total = SUPERSAMPLE * SUPERSAMPLE
    if covered == 0:
        return (0, 0, 0, 0)
    mix = marked / covered
    rgb = tuple(
        round(back * (1 - mix) + fore * mix)
        for back, fore in zip(BACKGROUND, FOREGROUND, strict=True)
    )
    return (rgb[0], rgb[1], rgb[2], round(255 * covered / total))


def _chunk(kind: bytes, data: bytes) -> bytes:
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def render_png(size: int) -> bytes:
    """One icon as PNG bytes: 8-bit RGBA, no interlacing, filter 0 on every row."""
    rows = bytearray()
    for py in range(size):
        rows.append(0)
        for px in range(size):
            rows.extend(_pixel(px, py, size))
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + _chunk(b"IEND", b"")
    )


def main() -> None:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        (ICONS_DIR / f"icon{size}.png").write_bytes(render_png(size))


if __name__ == "__main__":
    main()
