"""Encrypted variants of `tests/fixtures/tiny.mp4`, made by a STRUCTURAL edit — for the DRM tests
and the fake TikTok's `drm_media` mode; no binary fixture of their own.

What Common Encryption (ISO/IEC 23001-7) does to a file, reduced to what DramaFetch's DRM check
(`dramafetch.media.drm_problem`) looks at: the protected track's sample entry in
`moov/trak/mdia/minf/stbl/stsd` is renamed (`avc1` -> `encv`, `mp4a` -> `enca`) and the DRM
system's key information travels in a `pssh` box — at the top level of the file or among the
`moov` children. Every edit here keeps each box size and chunk offset right (a type renamed in
place, a box appended after `mdat`, a `moov` child replaced by one of the same size), so the
variants are still well-formed MP4s that mutagen parses. The samples are NOT encrypted: nothing
here encrypts or decrypts anything — the structure alone is what an encrypted file declares.

`with_drm_words_in_mdat` is the negative case: the bytes `encv`, `enca` and `pssh` written INSIDE
the `mdat` (after the last sample, so the media still plays) — what a raw byte search would
condemn and a structural walk never reads.

Imported as `encrypted_mp4` (pytest and the e2e scripts put `tests/` on `sys.path`).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

TINY_MP4 = (Path(__file__).resolve().parent / "fixtures" / "tiny.mp4").read_bytes()
#: Widevine's DRM system id (the `SystemID` of its `pssh` boxes).
WIDEVINE_SYSTEM_ID = bytes.fromhex("edef8ba979d64acea3c827dcd51d21ed")
PSSH = b"pssh"
_TRACK_PATH = (b"mdia", b"minf", b"stbl", b"stsd")


def boxes(data: bytes, start: int = 0, end: int | None = None) -> Iterator[tuple[int, int, bytes]]:
    """`(offset, size, type)` of each box between `start` and `end` (32-bit sizes only, all that
    the fixture uses); a header that is not a box raises ValueError: these helpers edit known
    files and must never guess."""
    stop = len(data) if end is None else end
    pos = start
    while pos + 8 <= stop:
        size = int.from_bytes(data[pos : pos + 4], "big")
        if size < 8 or pos + size > stop:
            raise ValueError(f"not a box at offset {pos}")
        yield pos, size, data[pos + 4 : pos + 8]
        pos += size


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


def with_top_level_pssh(data: bytes = TINY_MP4) -> bytes:
    """`data` with a `pssh` box appended at the top level, after `mdat`: no offset moves."""
    return data + pssh_box(b"dramafetch test key id")


def with_moov_pssh(data: bytes = TINY_MP4) -> bytes:
    """`data` with the `moov`'s `udta` child replaced by a `pssh` box of exactly its size, so the
    `moov` keeps its size and every chunk offset stays right."""
    moov, moov_size = child(data, b"moov")
    pos, size = child(data, b"udta", moov + 8, moov + moov_size)
    box = pssh_box(bytes(size - 32))
    assert len(box) == size
    return data[:pos] + box + data[pos + size :]


def encrypted_mp4(
    data: bytes = TINY_MP4, *, video: bool = True, audio: bool = True, pssh: bool = True
) -> bytes:
    """What an encrypted episode looks like to the DRM check: the video track's `avc1` renamed
    `encv` (`video`), the audio's `mp4a` renamed `enca` (`audio`), a top-level `pssh` appended
    (`pssh`); all three by default — the fake TikTok's `drm_media` serves that."""
    out = data
    if video:
        out = rename_sample_entry(out, b"avc1", b"encv")
    if audio:
        out = rename_sample_entry(out, b"mp4a", b"enca")
    if pssh:
        out = with_top_level_pssh(out)
    return out


#: Bytes that spell the boxes an encrypted file declares: an `encv` and an `enca` sample-entry
#: header, then a whole `pssh` box.
DRM_WORDS = (
    (16).to_bytes(4, "big")
    + b"encv"
    + bytes(8)
    + (16).to_bytes(4, "big")
    + b"enca"
    + bytes(8)
    + pssh_box()
)


def with_drm_words_in_mdat(data: bytes = TINY_MP4) -> bytes:
    """`data` with its `mdat` (the last box) grown by :data:`DRM_WORDS` after the last sample —
    no chunk offset moves and the media still plays. NOT DRM: those bytes are samples, not
    boxes."""
    pos, size = child(data, b"mdat")
    if pos + size != len(data):
        raise ValueError("the mdat is not the last box")
    grown = (size + len(DRM_WORDS)).to_bytes(4, "big")
    return data[:pos] + grown + data[pos + 4 :] + DRM_WORDS
