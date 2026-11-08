"""Encrypted variants of the fixture media, made by a STRUCTURAL edit — for the DRM refusal of the
fake Bilibili's `bili_drm` option; no binary fixture of its own.

What Common Encryption (ISO/IEC 23001-7) does to a file, reduced to what StreamFetch's DRM check
(`extension/src/lib/mp4.js` `drmProblem`, `parseInit(...).tracks[].encrypted`) looks at: the
protected track's sample entry in `moov/trak/mdia/minf/stbl/stsd` is renamed (`avc1` -> `encv`,
`mp4a` -> `enca`) and the DRM system's key information travels in a `pssh` box. Every edit here
keeps each box size and data offset right: a type renamed in place, and a `pssh` box inserted
right after the `moov` of a FRAGMENTED file (whose `moof`s address their samples relative to
themselves, `default-base-is-moof`, so moving them moves nothing they point at). A progressive
file (absolute `stco` offsets) is refused rather than silently broken. The samples are NOT
encrypted: nothing here encrypts or decrypts anything — the structure alone is what an encrypted
file declares. Ported from `DramaFetch/tests/encrypted_mp4.py` (copied, never imported).
"""

from __future__ import annotations

from collections.abc import Iterator

#: Widevine's DRM system id (the `SystemID` of its `pssh` boxes).
WIDEVINE_SYSTEM_ID = bytes.fromhex("edef8ba979d64acea3c827dcd51d21ed")
PSSH = b"pssh"
_TRACK_PATH = (b"mdia", b"minf", b"stbl", b"stsd")


def boxes(data: bytes, start: int = 0, end: int | None = None) -> Iterator[tuple[int, int, bytes]]:
    """`(offset, size, type)` of each box between `start` and `end` (32-bit sizes only, all that
    the fixtures use); a header that is not a box raises ValueError: these helpers edit known
    files and must never guess."""
    stop = len(data) if end is None else end
    pos = start
    while pos + 8 <= stop:
        size = int.from_bytes(data[pos : pos + 4], "big")
        if size < 8 or pos + size > stop:
            raise ValueError(f"not a box at offset {pos}")
        yield pos, size, data[pos + 4 : pos + 8]
        pos += size


def top_level_types(data: bytes) -> list[str]:
    """The types of the top-level boxes, in file order (`["ftyp", "moov", "moof", "mdat", ...]`)."""
    return [kind.decode("latin-1") for _, _, kind in boxes(data)]


def child(data: bytes, kind: bytes, start: int = 0, end: int | None = None) -> tuple[int, int]:
    """`(offset, size)` of the first box of type `kind` between `start` and `end`."""
    for pos, size, found in boxes(data, start, end):
        if found == kind:
            return pos, size
    raise ValueError(f"no {kind.decode()} box")


def sample_entries(data: bytes) -> list[tuple[int, bytes]]:
    """`(offset, type)` of every sample entry of every track: the boxes inside
    `moov/trak/mdia/minf/stbl/stsd`, after the `stsd`'s version, flags and entry count."""
    moov, moov_size = child(data, b"moov")
    found: list[tuple[int, bytes]] = []
    for trak, trak_size, kind in boxes(data, moov + 8, moov + moov_size):
        if kind != b"trak":
            continue
        start, end = trak + 8, trak + trak_size
        for container in _TRACK_PATH:
            pos, size = child(data, container, start, end)
            start, end = pos + 8, pos + size
        found.extend((pos, entry) for pos, _, entry in boxes(data, start + 8, end))
    return found


def rename_sample_entry(data: bytes, old: bytes, new: bytes) -> bytes:
    """`data` with the one sample entry of type `old` renamed `new`, in place (same size)."""
    out = bytearray(data)
    renamed = [pos for pos, kind in sample_entries(data) if kind == old]
    if len(renamed) != 1:
        raise ValueError(f"expected one {old.decode()} sample entry, found {len(renamed)}")
    out[renamed[0] + 4 : renamed[0] + 8] = new
    return bytes(out)


def pssh_box(payload: bytes = b"", system_id: bytes = WIDEVINE_SYSTEM_ID) -> bytes:
    """A valid version-0 `pssh` box: size, `pssh`, version and flags (0), the 16-byte system id,
    the payload size and the payload (a key id list in real files; anything here)."""
    body = bytes(4) + system_id + len(payload).to_bytes(4, "big") + payload
    return (8 + len(body)).to_bytes(4, "big") + PSSH + body


def with_pssh_after_moov(data: bytes) -> bytes:
    """`data`, a FRAGMENTED MP4, with a `pssh` box inserted right after its `moov`. Raises
    ValueError for a file without `moof` (a progressive file's absolute offsets would move)."""
    if "moof" not in top_level_types(data):
        raise ValueError("not a fragmented MP4: inserting a box would move its chunk offsets")
    moov, moov_size = child(data, b"moov")
    cut = moov + moov_size
    return data[:cut] + pssh_box(b"streamfetch test key id") + data[cut:]


def encrypted_fragmented(data: bytes, *, video: bool = True, audio: bool = False) -> bytes:
    """What an encrypted DASH track looks like to the DRM check: its `avc1` renamed `encv`
    (`video`) and/or its `mp4a` renamed `enca` (`audio`), and a `pssh` after the `moov`."""
    out = data
    if video:
        out = rename_sample_entry(out, b"avc1", b"encv")
    if audio:
        out = rename_sample_entry(out, b"mp4a", b"enca")
    return with_pssh_after_moov(out)
