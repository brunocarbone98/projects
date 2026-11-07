"""A preview-window variant of `tests/fixtures/tiny.mp4`, made by a STRUCTURAL edit — for the
served-preview tests and the fake TikTok's `short_header_media` mode; no binary fixture of its own.

What TikTok's web session got for 7 episodes of a limited-free series on 2026-11-06: a file of
exactly the listed size (the whole episode by size) whose MP4 header declares a playback window of
about 70 s where the list announced 106 s. Here the same thing in miniature: `tiny.mp4` (3 s) with
its `mvhd` duration, every `tkhd` duration (movie timescale) and every `mdhd` duration (that
track's timescale) rewritten to say `seconds`, while the `mdat` and the sample tables stay as they
are — the same byte size, and both parsers (mutagen reads the sound track's `mdhd`; so does
`lib/mp4.probe`) report `seconds`. Nothing here rewrites a header the OTHER way: DramaFetch never
makes a file play past the window TikTok gave it.

Imported as `short_header_mp4` (pytest and the e2e scripts put `tests/` on `sys.path`).
"""

from __future__ import annotations

from encrypted_mp4 import TINY_MP4, boxes, child

#: The boxes whose durations a preview window changes, and where to find them under `moov`.
_MOVIE_HEADER = b"mvhd"
_TRACK_HEADER = b"tkhd"
_MEDIA_HEADER = b"mdhd"
#: How long the window of :func:`with_short_header` lasts by default — within the duration
#: tolerance of a 3-second episode, so the tests that need a mismatch announce a longer one.
SHORT_HEADER_SECONDS = 2.0


def _full_box_version(data: bytes, pos: int) -> int:
    """The version byte of a full box (right after its 8-byte header)."""
    return data[pos + 8]


def _set_mvhd(out: bytearray, pos: int, seconds: float) -> None:
    """`mvhd`: version 0 — creation (4), modification (4), timescale (4), duration (4); version 1
    — creation (8), modification (8), timescale (4), duration (8)."""
    version = _full_box_version(out, pos)
    if version == 0:
        timescale = int.from_bytes(out[pos + 20 : pos + 24], "big")
        out[pos + 24 : pos + 28] = round(seconds * timescale).to_bytes(4, "big")
    elif version == 1:
        timescale = int.from_bytes(out[pos + 28 : pos + 32], "big")
        out[pos + 32 : pos + 40] = round(seconds * timescale).to_bytes(8, "big")
    else:
        raise ValueError(f"unknown mvhd version {version}")


def _movie_timescale(data: bytes, mvhd: int) -> int:
    version = _full_box_version(data, mvhd)
    if version == 0:
        return int.from_bytes(data[mvhd + 20 : mvhd + 24], "big")
    return int.from_bytes(data[mvhd + 28 : mvhd + 32], "big")


def _set_tkhd(out: bytearray, pos: int, seconds: float, movie_timescale: int) -> None:
    """`tkhd`: version 0 — creation (4), modification (4), track id (4), reserved (4), duration
    (4); version 1 — creation (8), modification (8), track id (4), reserved (4), duration (8). The
    duration is in the MOVIE timescale."""
    version = _full_box_version(out, pos)
    ticks = round(seconds * movie_timescale)
    if version == 0:
        out[pos + 28 : pos + 32] = ticks.to_bytes(4, "big")
    elif version == 1:
        out[pos + 36 : pos + 44] = ticks.to_bytes(8, "big")
    else:
        raise ValueError(f"unknown tkhd version {version}")


def _set_mdhd(out: bytearray, pos: int, seconds: float) -> None:
    """`mdhd`: laid out like `mvhd` up to the duration, in the TRACK's own timescale."""
    _set_mvhd(out, pos, seconds)  # the same offsets: creation, modification, timescale, duration


def with_short_header(data: bytes = TINY_MP4, seconds: float = SHORT_HEADER_SECONDS) -> bytes:
    """`data` with every duration its headers declare — the `mvhd`, each track's `tkhd` and each
    track's `mdhd` — set to `seconds`, in place: the same byte size, the same `mdat`, the same
    sample tables (so the file still holds, and plays, its 3 s of samples; a player stops at the
    declared duration). mutagen and `lib/mp4.probe` then both report `seconds`."""
    out = bytearray(data)
    moov, moov_size = child(data, b"moov")
    mvhd, _ = child(data, _MOVIE_HEADER, moov + 8, moov + moov_size)
    movie_timescale = _movie_timescale(data, mvhd)
    _set_mvhd(out, mvhd, seconds)
    for trak, trak_size, kind in boxes(data, moov + 8, moov + moov_size):
        if kind != b"trak":
            continue
        tkhd, _ = child(data, _TRACK_HEADER, trak + 8, trak + trak_size)
        _set_tkhd(out, tkhd, seconds, movie_timescale)
        mdia, mdia_size = child(data, b"mdia", trak + 8, trak + trak_size)
        mdhd, _ = child(data, _MEDIA_HEADER, mdia + 8, mdia + mdia_size)
        _set_mdhd(out, mdhd, seconds)
    assert len(out) == len(data)
    return bytes(out)
