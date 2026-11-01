"""The extension's media checks (`extension/src/lib/mp4.js`) against their Python originals.

Parity, word for word: `verifyVideo` / `drmProblem` / `probe` against `media.verify_video` /
`media.drm_problem` / `media.probe_video` on `tests/fixtures/tiny.mp4`, every truncation of it, a
video-only variant, wrong durations (rounded half to even, like Python's `:.0f`), the encrypted
variants of `tests/encrypted_mp4.py`, an `mdat` that spells `encv` (not DRM), hostile box sizes,
mutagen's own corner cases and a seeded fuzz; `bodyProblem`, `imageKind`, `imageProblem` and
`formatSize` against `downloader_browser._body_problem` and `thumbnails`; `extractCover` against
`thumbnails.extract_cover`; the refusals of `embedCover` against `thumbnails.embed_cover`.

The cover proof: a JPEG and a PNG embedded by the extension into every layout — `moov` before
`mdat` (TikTok's faststart files) and after it, with and without `udta` / `meta` / `ilst`, with
`co64` chunk offsets, over an existing cover — are read back by mutagen byte for byte with an
unchanged duration, every chunk offset still points at the same sample bytes, and ffmpeg decodes
every original stream to the same `framemd5` (the cover is one extra attached-picture stream).

The JavaScript runs in `node extension/tests/media_runner.js` (one process per test, every case
on stdin). Only a missing `node` skips this module; only a missing ffmpeg (one that decodes
H.264 and AAC, on PATH or in /opt/pw-browsers/ffmpeg-*/) skips the ffmpeg checks.
"""

from __future__ import annotations

import base64
import json
import random
import shutil
import struct
import subprocess
import tempfile
import zlib
from collections.abc import Iterator, Sequence
from functools import cache
from pathlib import Path
from typing import Any

import pytest
from mutagen.mp4 import MP4, MP4Cover

from dramafetch.downloader_browser import _body_problem
from dramafetch.errors import MediaError, ThumbnailError
from dramafetch.media import drm_problem, drm_problem_in, probe_video, verify_video
from dramafetch.models import DRM_MESSAGE
from dramafetch.thumbnails import (
    MAX_COVER_BYTES,
    embed_cover,
    extract_cover,
    format_size,
    has_embedded_cover,
    image_kind,
    image_problem,
)
from encrypted_mp4 import (
    TINY_MP4,
    boxes,
    child,
    encrypted_mp4,
    pssh_box,
    sample_entries,
    with_drm_words_in_mdat,
    with_moov_pssh,
    with_top_level_pssh,
)

EXTENSION = Path(__file__).resolve().parents[1] / "extension"
RUNNER = EXTENSION / "tests" / "media_runner.js"
NODE = shutil.which("node")
#: The durations every variant is verified against (None and 0: not judged).
DURATIONS: tuple[int | None, ...] = (None, 0, 3, 6, 7, 120)
#: The fixture's top-level atoms: ftyp (32 bytes), moov (3363), free (8), mdat (17128).
MOOV_END = 32 + 3363
#: Offsets inside the fixture (see `_layout_facts`, which checks every one of them).
MVHD = 40
AUDIO_TRAK = 1444
AUDIO_HDLR = 1620
AUDIO_MDHD = 1588
AUDIO_STSD = 1733
MP4A = 1749
ESDS = 1785
UDTA = 3297
TOO = 3358  # the `©too` tag in moov/udta/meta/ilst
#: The containers between `moov` and the chunk offset tables.
TABLE_CONTAINERS = frozenset({b"moov", b"trak", b"mdia", b"minf", b"stbl"})

pytestmark = pytest.mark.skipif(
    NODE is None, reason="node is not installed: the extension's media checks run in Node 22"
)


# --------------------------------------------------------------------------- the runner


def _node(cases: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Run every case through `media_runner.js` in one Node process."""
    assert NODE is not None
    proc = subprocess.run(
        [NODE, str(RUNNER)],
        input=json.dumps({"cases": list(cases)}),
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr[-4000:]
    results: list[dict[str, Any]] = json.loads(proc.stdout)["results"]
    assert len(results) == len(cases)
    return results


def _outcome(result: dict[str, Any]) -> Any:
    """A runner result as the value it returned, or `{"error": <message>}` when it threw. A
    probe's duration is read back as a float: JSON writes a huge one as an integer
    (`3074457345618262500`) that Python would keep as an int."""
    if "error" in result:
        return {"error": result["error"]}
    value = result["value"]
    if isinstance(value, dict) and "durationS" in value:
        return {**value, "durationS": float(value["durationS"])}
    return value


def _values(cases: Sequence[dict[str, Any]]) -> list[Any]:
    """The values of cases that must not throw."""
    values = []
    for case, result in zip(cases, _node(cases), strict=True):
        assert "error" not in result, (case, result)
        values.append(result["value"])
    return values


def _python_probe(path: Path) -> Any:
    try:
        probe = probe_video(path)
    except MediaError as exc:
        return {"error": str(exc)}
    return {
        "durationS": probe.duration_s,
        "hasAudio": probe.has_audio,
        "audioCodec": probe.audio_codec,
    }


def _assert_parity(
    directory: Path,
    variants: Sequence[tuple[str, bytes]],
    durations: Sequence[int | None] = DURATIONS,
) -> list[Any]:
    """`verify` (at every duration), `drm` and `probe` give the same answer in both languages
    for every variant; returns the Python verdicts at the first duration, for the caller's own
    expectations."""
    cases: list[dict[str, Any]] = []
    expected: list[tuple[str, str, Any]] = []
    verdicts = []
    for index, (name, data) in enumerate(variants):
        path = directory / f"variant{index}.mp4"
        path.write_bytes(data)
        for duration in durations:
            cases.append({"op": "verify", "path": str(path), "expected": duration})
            expected.append((name, f"verify {duration}", verify_video(path, duration)))
        verdicts.append(verify_video(path, durations[0]))
        python_drm = drm_problem(path)
        assert python_drm == drm_problem_in(data), name  # the two Python walks agree
        cases.append({"op": "drm", "path": str(path)})
        expected.append((name, "drm", python_drm))
        cases.append({"op": "probe", "path": str(path)})
        expected.append((name, "probe", _python_probe(path)))
    results = _node(cases)
    mismatches = [
        (name, what, want, _outcome(result))
        for (name, what, want), result in zip(expected, results, strict=True)
        if _outcome(result) != want
    ]
    assert mismatches == []
    return verdicts


# --------------------------------------------------------------------- building variants


def _box(kind: bytes, payload: bytes) -> bytes:
    return (8 + len(payload)).to_bytes(4, "big") + kind + payload


def _written(path: Path, data: bytes) -> Path:
    path.write_bytes(data)
    return path


def _patched(data: bytes, offset: int, replacement: bytes) -> bytes:
    """`data` with `replacement` written over the bytes at `offset` (same length)."""
    assert offset + len(replacement) <= len(data)
    return data[:offset] + replacement + data[offset + len(replacement) :]


def _without_audio_track(data: bytes) -> bytes:
    """The audio `trak` replaced by a `free` box of its size: a playable video-only MP4."""
    size = int.from_bytes(data[AUDIO_TRAK : AUDIO_TRAK + 4], "big")
    return _patched(data, AUDIO_TRAK, _box(b"free", bytes(size - 8)))


def _nested(depth: int) -> bytes:
    inner = b""
    for _ in range(depth):
        inner = _box(b"udta", inner)
    return inner


def _tables(data: bytes, start: int = 0, end: int | None = None) -> Iterator[tuple[int, bytes]]:
    """`(offset, type)` of every `stco` / `co64` box under `moov`."""
    stop = len(data) if end is None else end
    for pos, size, kind in boxes(data, start, stop):
        if kind in TABLE_CONTAINERS:
            yield from _tables(data, pos + 8, pos + size)
        elif kind in (b"stco", b"co64"):
            yield pos, kind


def _chunk_offsets(data: bytes) -> list[int]:
    """Every chunk offset of every track, in table order."""
    offsets = []
    for pos, kind in _tables(data):
        width = 4 if kind == b"stco" else 8
        count = int.from_bytes(data[pos + 12 : pos + 16], "big")
        offsets.extend(
            int.from_bytes(data[at : at + width], "big")
            for at in range(pos + 16, pos + 16 + count * width, width)
        )
    return offsets


def _shift_chunks(data: bytes, delta: int) -> bytes:
    out = bytearray(data)
    for pos, kind in _tables(data):
        width = 4 if kind == b"stco" else 8
        count = int.from_bytes(data[pos + 12 : pos + 16], "big")
        for at in range(pos + 16, pos + 16 + count * width, width):
            value = int.from_bytes(data[at : at + width], "big") + delta
            out[at : at + width] = value.to_bytes(width, "big")
    return bytes(out)


def _moov_last(data: bytes) -> bytes:
    """The `moov` moved behind the `mdat` (a file that is not "faststart"), offsets fixed."""
    moov, size = child(data, b"moov")
    shifted = _shift_chunks(data, -size)
    return shifted[:moov] + shifted[moov + size :] + shifted[moov : moov + size]


def _without_udta(data: bytes) -> bytes:
    """The `moov` without its `udta` (no tags at all), offsets fixed."""
    moov, moov_size = child(data, b"moov")
    udta, udta_size = child(data, b"udta", moov + 8, moov + moov_size)
    shifted = bytearray(_shift_chunks(data, -udta_size))
    shifted[moov : moov + 4] = (moov_size - udta_size).to_bytes(4, "big")
    return bytes(shifted[:udta] + shifted[udta + udta_size :])


def _udta_without_meta(data: bytes) -> bytes:
    """`udta` keeps its size, its `meta` replaced by a `free` box (no offset moves)."""
    moov, moov_size = child(data, b"moov")
    udta, udta_size = child(data, b"udta", moov + 8, moov + moov_size)
    meta, meta_size = child(data, b"meta", udta + 8, udta + udta_size)
    return _patched(data, meta, _box(b"free", bytes(meta_size - 8)))


def _meta_without_ilst(data: bytes) -> bytes:
    """`meta` keeps its `hdlr` and size, its `ilst` replaced by a `free` box."""
    moov, moov_size = child(data, b"moov")
    udta, udta_size = child(data, b"udta", moov + 8, moov + moov_size)
    meta, meta_size = child(data, b"meta", udta + 8, udta + udta_size)
    ilst, ilst_size = child(data, b"ilst", meta + 12, meta + meta_size)
    return _patched(data, ilst, _box(b"free", bytes(ilst_size - 8)))


def _with_co64(data: bytes) -> bytes:
    """Every `stco` rebuilt as a `co64` (8-byte chunk offsets): the `moov` grows by four bytes
    per chunk, so the `mdat` and every offset move by that much."""
    moov, moov_size = child(data, b"moov")
    growth = sum(
        4 * int.from_bytes(data[pos + 12 : pos + 16], "big")
        for pos, kind in _tables(data)
        if kind == b"stco"
    )

    def rebuilt(start: int, end: int) -> bytes:
        out = b""
        for pos, size, kind in boxes(data, start, end):
            if kind in TABLE_CONTAINERS:
                out += _box(kind, rebuilt(pos + 8, pos + size))
            elif kind == b"stco":
                count = int.from_bytes(data[pos + 12 : pos + 16], "big")
                entries = b"".join(
                    (int.from_bytes(data[at : at + 4], "big") + growth).to_bytes(8, "big")
                    for at in range(pos + 16, pos + 16 + 4 * count, 4)
                )
                out += _box(b"co64", data[pos + 8 : pos + 16] + entries)
            else:
                out += data[pos : pos + size]
        return out

    new_moov = _box(b"moov", rebuilt(moov + 8, moov + moov_size))
    assert len(new_moov) == moov_size + growth
    return data[:moov] + new_moov + data[moov + moov_size :]


def _with_ilst_children(data: bytes, children: bytes) -> bytes:
    """`data` with the children of `moov/udta/meta/ilst` replaced and the four sizes adjusted —
    chunk offsets NOT moved: for checks of the metadata only."""
    moov, moov_size = child(data, b"moov")
    udta, udta_size = child(data, b"udta", moov + 8, moov + moov_size)
    meta, meta_size = child(data, b"meta", udta + 8, udta + udta_size)
    ilst, ilst_size = child(data, b"ilst", meta + 12, meta + meta_size)
    delta = len(children) - (ilst_size - 8)
    out = bytearray(data[: ilst + 8] + children + data[ilst + ilst_size :])
    for pos, size in ((moov, moov_size), (udta, udta_size), (meta, meta_size), (ilst, ilst_size)):
        out[pos : pos + 4] = (size + delta).to_bytes(4, "big")
    return bytes(out)


def _data_atom(image_format: int, payload: bytes) -> bytes:
    return _box(b"data", image_format.to_bytes(4, "big") + bytes(4) + payload)


def _with_udta_chpl(data: bytes, chapters: bytes) -> bytes:
    """The `udta` (same size) holding one `chpl` box of `chapters` (version, flags, reserved,
    count, then the chapters), padded with a `free` box."""
    chpl = _box(b"chpl", chapters)
    size = int.from_bytes(data[UDTA : UDTA + 4], "big")
    filler = size - 8 - len(chpl)
    assert filler >= 8
    return _patched(data, UDTA, _box(b"udta", chpl + _box(b"free", bytes(filler - 8))))


def _chapter(title: bytes) -> bytes:
    return bytes(8) + bytes([len(title)]) + title


def _png(width: int, height: int) -> bytes:
    """A real RGB PNG (stdlib only)."""

    def chunk(kind: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(kind + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", crc)

    rows = b"".join(
        b"\x00"
        + b"".join(
            bytes(((x * 37) % 256, (y * 53) % 256, ((x ^ y) * 11) % 256)) for x in range(width)
        )
        for y in range(height)
    )
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )


#: Bytes that start like a JPEG (mutagen and the embedding sniff the magic only).
FAKE_JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + bytes(range(256)) * 3 + b"\xff\xd9"


def test_the_layout_facts_the_variants_rely_on() -> None:
    """Every offset this module patches is where it says it is."""
    assert [(kind, pos) for pos, _, kind in boxes(TINY_MP4)] == [
        (b"ftyp", 0),
        (b"moov", 32),
        (b"free", MOOV_END),
        (b"mdat", MOOV_END + 8),
    ]
    assert TINY_MP4[MVHD + 4 : MVHD + 8] == b"mvhd"
    assert TINY_MP4[AUDIO_TRAK + 4 : AUDIO_TRAK + 8] == b"trak"
    assert TINY_MP4[AUDIO_HDLR + 16 : AUDIO_HDLR + 20] == b"soun"
    assert TINY_MP4[AUDIO_MDHD + 4 : AUDIO_MDHD + 8] == b"mdhd"
    assert TINY_MP4[AUDIO_STSD + 4 : AUDIO_STSD + 8] == b"stsd"
    assert [pos for pos, kind in sample_entries(TINY_MP4) if kind == b"mp4a"] == [MP4A]
    assert TINY_MP4[ESDS + 4 : ESDS + 8] == b"esds"
    assert TINY_MP4[UDTA + 4 : UDTA + 8] == b"udta"
    assert TINY_MP4[TOO + 4 : TOO + 8] == b"\xa9too"
    assert [kind for _, kind in _tables(TINY_MP4)] == [b"stco", b"stco"]


# ------------------------------------------------------------- verify / drm / probe parity


def test_the_fixture_and_its_variants_get_the_same_verdicts(tmp_path: Path) -> None:
    padded = TINY_MP4 + _box(b"free", bytes(128 * 1024 - len(TINY_MP4) - 8))
    variants = [
        ("tiny", TINY_MP4),
        ("padded like the fake CDN", padded),
        ("trailing junk", TINY_MP4 + b"JUNK" * 40),
        ("unknown trailing atom", TINY_MP4 + (1_000_000).to_bytes(4, "big") + b"zzzz" + bytes(16)),
        ("video only", _without_audio_track(TINY_MP4)),
        ("encv video entry", encrypted_mp4(audio=False, pssh=False)),
        ("enca audio entry", encrypted_mp4(video=False, pssh=False)),
        ("top-level pssh", with_top_level_pssh()),
        ("pssh in moov", with_moov_pssh()),
        ("all three", encrypted_mp4()),
        ("encrypted, video only", encrypted_mp4(_without_audio_track(TINY_MP4), audio=False)),
        ("drm words inside mdat", with_drm_words_in_mdat()),
        ("a top-level box named encv", TINY_MP4 + _box(b"encv", bytes(8))),
        ("pssh after 10 empty boxes", TINY_MP4[:32] + _box(b"free", b"") * 10 + pssh_box()),
        ("pssh after 1034 empty boxes", TINY_MP4[:32] + _box(b"free", b"") * 1034 + pssh_box()),
        ("moov last", _moov_last(TINY_MP4)),
        ("no udta", _without_udta(TINY_MP4)),
        ("co64 offsets", _with_co64(TINY_MP4)),
        ("random bytes", random.Random(7).randbytes(70_000)),
        ("empty", b""),
    ]
    verdicts = dict(
        zip([name for name, _ in variants], _assert_parity(tmp_path, variants), strict=True)
    )
    # what the Python side says, for the record: the JS side said exactly the same above
    assert verdicts["tiny"] is None and verdicts["video only"] == "no audio track"
    assert verdicts["empty"] == "not a valid MP4 (not a MP4 file)"
    assert all(
        verdicts[name] is None for name in ("all three", "drm words inside mdat", "co64 offsets")
    )
    results = _values(
        [{"op": "drm", "path": str(tmp_path / f"variant{i}.mp4")} for i in range(5, 11)]
    )
    assert results == [DRM_MESSAGE] * 6  # every encrypted variant, in JS too


def test_every_truncation_gets_the_same_verdict(tmp_path: Path) -> None:
    """Every cut inside `ftyp`, `moov`, `free` and the `mdat` header (where mutagen's answers
    differ from byte to byte), then every 61st byte of the samples: the same text in both
    languages. The encrypted variant: its DRM verdict at every cut, its integrity verdict at
    every 7th."""
    source = tmp_path / "tiny.mp4"
    source.write_bytes(TINY_MP4)
    encrypted = encrypted_mp4()
    source_encrypted = tmp_path / "encrypted.mp4"
    source_encrypted.write_bytes(encrypted)
    lengths = sorted({*range(MOOV_END + 25), *range(MOOV_END + 25, len(TINY_MP4) + 1, 61)})
    lengths.append(len(TINY_MP4))
    encrypted_verify = sorted(
        {*range(0, MOOV_END + 25, 7), *range(MOOV_END, len(encrypted) + 1, 389)}
    )
    encrypted_drm = range(len(encrypted) + 1)
    cases: list[dict[str, Any]] = []
    cases += [{"op": "verify", "path": str(source), "expected": 3, "length": n} for n in lengths]
    cases += [{"op": "drm", "path": str(source), "length": n} for n in lengths]
    cases += [
        {"op": "verify", "path": str(source_encrypted), "expected": 3, "length": n}
        for n in encrypted_verify
    ]
    cases += [{"op": "drm", "path": str(source_encrypted), "length": n} for n in encrypted_drm]
    got = iter(_values(cases))
    cut = tmp_path / "cut.mp4"
    mismatches = []
    for n in lengths:
        cut.write_bytes(TINY_MP4[:n])
        want = verify_video(cut, 3)
        if (have := next(got)) != want:
            mismatches.append(("verify", n, want, have))
    for n in lengths:
        if (have := next(got)) != (want := drm_problem_in(TINY_MP4[:n])):
            mismatches.append(("drm", n, want, have))
    for n in encrypted_verify:
        cut.write_bytes(encrypted[:n])
        if (have := next(got)) != (want := verify_video(cut, 3)):
            mismatches.append(("encrypted verify", n, want, have))
    drm_found = 0
    for n in encrypted_drm:
        want = drm_problem_in(encrypted[:n])
        drm_found += want is not None
        if (have := next(got)) != want:
            mismatches.append(("encrypted drm", n, want, have))
    assert mismatches == []
    assert drm_found > len(encrypted) // 2  # the cuts that still hold an encv entry: DRM


def test_wrong_durations_round_half_to_even_like_python(tmp_path: Path) -> None:
    """The reason prints the probed length with Python's `:.0f` (ties to even: 2.5 s is "2",
    3.5 s is "4") and the tolerance is max(3 s, 5 %)."""
    timescale_at = AUDIO_MDHD + 8 + 12

    def lasting(timescale: int, duration: int) -> bytes:
        fields = timescale.to_bytes(4, "big") + duration.to_bytes(4, "big")
        return _patched(TINY_MP4, timescale_at, fields)

    variants = [
        ("0.5 s", lasting(2, 1)),
        ("2.5 s", lasting(2, 5)),
        ("3.5 s", lasting(2, 7)),
        ("4.5 s", lasting(2, 9)),
        ("385 s", lasting(1, 385)),
        ("370.4 s", lasting(5, 1852)),
        ("400 s", lasting(1, 400)),
        ("no length (timescale 0)", lasting(0, 1000)),
    ]
    durations = (120, None, 0, 1, 3, 4, 6, 7, 380, 400, 420)
    verdicts = _assert_parity(tmp_path, variants, durations)
    assert verdicts[:4] == [
        "duration 0 s, expected 120 s",
        "duration 2 s, expected 120 s",
        "duration 4 s, expected 120 s",
        "duration 4 s, expected 120 s",
    ]
    assert verify_video(tmp_path / "variant4.mp4", 400) is None  # 385 s is within 5 % of 400 s
    assert verify_video(tmp_path / "variant5.mp4", 400) == "duration 370 s, expected 400 s"
    assert verdicts[7] == "no playable duration"


def test_hostile_box_sizes_get_the_same_verdicts(tmp_path: Path) -> None:
    def size_at(offset: int, value: int) -> bytes:
        return _patched(TINY_MP4, offset, value.to_bytes(4, "big"))

    variants = [
        ("top-level size 5", TINY_MP4 + b"\0\0\0\x05abcd"),
        ("top-level header cut in half", TINY_MP4 + b"\0\0\0\x10fr"),
        ("64-bit size cut short", TINY_MP4 + b"\0\0\0\x01mdat\0\0"),
        ("64-bit size below 16", TINY_MP4 + b"\0\0\0\x01mdat" + (8).to_bytes(8, "big")),
        (
            "64-bit size past the end",
            TINY_MP4 + b"\0\0\0\x01mdat" + (116).to_bytes(8, "big") + bytes(10),
        ),
        ("64-bit size 2**64 - 1", TINY_MP4 + b"\0\0\0\x01mdat" + (2**64 - 1).to_bytes(8, "big")),
        ("64-bit size 2**63", TINY_MP4 + b"\0\0\0\x01mdat" + (2**63).to_bytes(8, "big")),
        ("32-bit size 2**32 - 1", TINY_MP4 + b"\xff\xff\xff\xffmdat"),
        ("size 0 at the top: to the end", TINY_MP4 + b"\0\0\0\0mdat" + b"x" * 20),
        ("moov of size 0", size_at(32, 0)),
        ("ftyp of size 0", size_at(0, 0)),
        ("nested size 0 (mvhd)", size_at(MVHD, 0)),
        ("nested size 3 (mvhd)", size_at(MVHD, 3)),
        ("nested size 1 (mvhd)", size_at(MVHD, 1)),
        ("mvhd past the end", size_at(MVHD, 0xFFFFFFF0)),
        ("trak past the end", size_at(148, 0xFFFFFFF0)),
        ("moov smaller than its children", size_at(32, 200)),
        ("moov past the end", size_at(32, 50_000)),
        ("mdat past the end", size_at(MOOV_END + 8, 17_129)),
        ("free of size 7", size_at(MOOV_END, 7)),
        ("udta nested 300 deep", TINY_MP4 + _nested(300)),
        ("udta nested 2000 deep", TINY_MP4 + _nested(2000)),
        ("a size of 0 inside a deep box", TINY_MP4 + _box(b"udta", _box(b"udta", b"\0\0\0\0free"))),
    ]
    verdicts = _assert_parity(tmp_path, variants)
    assert verdicts[0] == "not a valid MP4 (atom length can only be 0, 1 or 8 and higher)"
    assert verdicts[5] == "not a valid MP4 (cannot fit 'int' into an offset-sized integer)"
    assert verdicts[21] == "not a valid MP4 (maximum recursion depth exceeded)"


def test_mutagen_corner_cases_get_the_same_verdicts(tmp_path: Path) -> None:
    """The places where mutagen itself gives up — the sound track's header boxes, its sample
    entry and the AAC descriptors, the tag list, the chapters — give the same text."""

    def byte_at(offset: int, value: int) -> bytes:
        return _patched(TINY_MP4, offset, bytes([value]))

    video_only = _without_audio_track(TINY_MP4)
    mvhd_fields = MVHD + 8 + 4  # after version and flags
    huge_v1 = _patched(
        _patched(video_only, MVHD + 8, b"\x01"),
        mvhd_fields + 16,
        (3).to_bytes(4, "big") + (2**63 + 12345).to_bytes(8, "big"),
    )
    too_size = int.from_bytes(TINY_MP4[TOO : TOO + 4], "big")
    covr_short = _box(b"covr", _data_atom(13, b"\xff\xd8\xff\xe0") + bytes(too_size - 8 - 20))
    freeform = _box(b"----", (0xFFFF).to_bytes(4, "big") + bytes(too_size - 12))
    trkn = _box(b"trkn", _box(b"data", bytes(8)) + bytes(too_size - 8 - 16))
    stray = _box(b"covr", _box(b"wxyz", bytes(4)) + bytes(too_size - 8 - 12))
    renamed = _patched(TINY_MP4, MP4A + 4, b"\xa9x'y")
    variants = [
        ("sound handler hidden", _patched(TINY_MP4, AUDIO_HDLR + 16, b"text")),
        ("mdhd version 2", byte_at(AUDIO_MDHD + 8, 2)),
        ("mdhd version 1, too short", byte_at(AUDIO_MDHD + 8, 1)),
        ("stsd version 1", byte_at(AUDIO_STSD + 8, 1)),
        ("stsd with no entry", _patched(TINY_MP4, AUDIO_STSD + 12, bytes(4))),
        ("sample entry too short", _patched(TINY_MP4, MP4A, (0x1000).to_bytes(4, "big"))),
        ("odd entry name, too short", _patched(renamed, MP4A, (0x1000).to_bytes(4, "big"))),
        ("sample entry of size 5", _patched(TINY_MP4, MP4A, (5).to_bytes(4, "big"))),
        ("entry renamed alac", _patched(TINY_MP4, MP4A + 4, b"alac")),
        ("entry renamed ac-3", _patched(TINY_MP4, MP4A + 4, b"ac-3")),
        ("no esds", _patched(TINY_MP4, ESDS + 4, b"free")),
        ("esds version 1", byte_at(ESDS + 8, 1)),
        ("not an ES descriptor", byte_at(ESDS + 12, 7)),
        ("descriptor length without end", _patched(TINY_MP4, ESDS + 13, b"\x80\x80\x80\x80")),
        ("not a DecoderConfigDescriptor", byte_at(ESDS + 20, 9)),
        ("MP3 object type", byte_at(ESDS + 25, 0x6B)),
        ("not an audio stream", byte_at(ESDS + 26, 0x11)),
        ("SBR object type", byte_at(ESDS + 43, 0x2A)),
        ("escape object type", byte_at(ESDS + 43, 0xFA)),
        ("no channel configuration", byte_at(ESDS + 44, 0x00)),
        ("video only, mvhd timescale 0", _patched(video_only, mvhd_fields + 8, bytes(4))),
        ("video only, mvhd version 2", _patched(video_only, MVHD + 8, b"\x02")),
        ("video only, huge mvhd v1", huge_v1),
        ("covr cut inside", _patched(TINY_MP4, TOO, covr_short)),
        ("a stray atom in covr", _patched(TINY_MP4, TOO, stray)),
        ("freeform cut inside", _patched(TINY_MP4, TOO, freeform)),
        ("trkn without a value", _patched(TINY_MP4, TOO, trkn)),
        ("an unknown tag", _patched(TINY_MP4, TOO + 4, b"zzzz")),
        ("tag past its ilst", _patched(TINY_MP4, TOO, (too_size + 4).to_bytes(4, "big"))),
        (
            "chapter title not UTF-8",
            _with_udta_chpl(TINY_MP4, bytes(8) + b"\x01" + _chapter(b"\xffab")),
        ),
        (
            "chapter title cut mid-character",
            _with_udta_chpl(TINY_MP4, bytes(8) + b"\x01" + _chapter(b"ab\xe2\x82")),
        ),
        (
            "chapter title bad continuation",
            _with_udta_chpl(TINY_MP4, bytes(8) + b"\x01" + _chapter(b"\xe2(\xa1")),
        ),
        (
            "chapter title surrogate",
            _with_udta_chpl(TINY_MP4, bytes(8) + b"\x01" + _chapter(b"\xed\xa0\x80z")),
        ),
        (
            "chapter title fine",
            _with_udta_chpl(TINY_MP4, bytes(8) + b"\x01" + _chapter("Épisode".encode())),
        ),
        ("chapters cut short", _with_udta_chpl(TINY_MP4, bytes(8) + b"\x05" + _chapter(b"x"))),
        ("chapter list too short", _with_udta_chpl(TINY_MP4, bytes(8))),
        ("chapters without timescale", _with_udta_chpl(byte_at(MVHD + 8, 2), bytes(8) + b"\x00")),
    ]
    verdicts = _assert_parity(tmp_path, variants)
    by_name = dict(zip([name for name, _ in variants], verdicts, strict=True))
    assert by_name["mdhd version 2"] == "not a valid MP4 (Unknown mdhd version 2)"
    assert by_name["odd entry name, too short"] == 'not a valid MP4 (too short b"\\xa9x\'y" atom)'
    assert by_name["video only, mvhd timescale 0"] == "not a valid MP4 (division by zero)"
    assert by_name["covr cut inside"] == "not a valid MP4 (unpack requires a buffer of 12 bytes)"
    assert by_name["chapter title not UTF-8"] == (
        "not a valid MP4 (chapter 0 title: 'utf-8' codec can't decode byte 0xff in position 0: "
        "invalid start byte)"
    )
    assert by_name["stsd with no entry"] == "no audio track"


def test_a_seeded_fuzz_gets_the_same_verdicts(tmp_path: Path) -> None:
    """Bytes flipped (mostly in `ftyp`/`moov`, where the structure is), sometimes cut: the
    fixture and its encrypted variant, 600 times."""
    rng = random.Random(20261101)
    sources = [TINY_MP4, encrypted_mp4()]
    variants = []
    for index in range(600):
        data = bytearray(rng.choice(sources))
        for _ in range(rng.randint(1, 8)):
            position = rng.randrange(MOOV_END) if rng.random() < 0.8 else rng.randrange(len(data))
            data[position] = rng.randrange(256)
        if rng.random() < 0.2:
            data = data[: rng.randrange(len(data) + 1)]
        variants.append((f"fuzz {index}", bytes(data)))
    verdicts = _assert_parity(tmp_path, variants, (3,))
    kinds = {(verdict or "fine").split(" (")[0] for verdict in verdicts}
    assert {"fine", "not a valid MP4", "truncated MP4", "no audio track"} <= kinds


# ------------------------------------------------------------ body, image and size helpers


def test_body_image_and_size_helpers_agree(tmp_path: Path) -> None:
    video = tmp_path / "video.bin"
    video.write_bytes(TINY_MP4 + bytes(64 * 1024))
    html = tmp_path / "page.bin"
    html.write_bytes(b"<html>" + b"x" * (70 * 1024))
    small = tmp_path / "small.bin"
    small.write_bytes(b"<html>nope</html>")
    jpeg = tmp_path / "cover.bin"
    jpeg.write_bytes(FAKE_JPEG)
    png = tmp_path / "cover.png.bin"
    png.write_bytes(_png(8, 8))
    webp = tmp_path / "cover.webp.bin"
    webp.write_bytes(b"RIFF" + (300).to_bytes(4, "little") + b"WEBPVP8 " + bytes(300))
    riff = tmp_path / "riff.bin"
    riff.write_bytes(b"RIFF" + bytes(4) + b"AVI " + bytes(300))
    files = {
        "video": video,
        "html": html,
        "small": small,
        "jpeg": jpeg,
        "png": png,
        "webp": webp,
        "riff": riff,
    }
    types = [
        "",
        "video/mp4",
        "VIDEO/MP4; charset=binary",
        "application/octet-stream",
        "text/html; charset=utf-8",
        "  image/JPEG ",
        "image/jpg",
        "image/pjpeg",
        "image/png",
        "image/webp",
        "image/avif",
        "\x85image/png\x1c",
        "\ufeffimage/png",
    ]
    cases: list[dict[str, Any]] = []
    expected = []
    for name, path in files.items():
        data = path.read_bytes()
        for content_type in types:
            cases.append({"op": "body", "path": str(path), "contentType": content_type})
            expected.append((name, content_type, "body", _body_problem(data, content_type)))
            cases.append({"op": "imageKind", "path": str(path), "contentType": content_type})
            expected.append((name, content_type, "kind", image_kind(data, content_type)))
            cases.append({"op": "imageProblem", "path": str(path), "contentType": content_type})
            expected.append((name, content_type, "problem", image_problem(data, content_type)))
    sizes = [0, 1, 199, 1023, 1024, 1280, 1536, 2560, 3840, 1024 * 1024 - 1, 1024 * 1024]
    sizes += [1_310_720, 1_572_864, 5 * 1024 * 1024 + 1, 123_456_789, 2**40 + 2**36]
    for size in sizes:
        cases.append({"op": "formatSize", "size": size})
        expected.append(("size", str(size), "format", format_size(size)))
    mismatches = [
        (*key, have)
        for (*key, want), have in zip(expected, _values(cases), strict=True)
        if have != want
    ]
    assert mismatches == []
    assert format_size(1280) == "1.2 KiB"  # Python rounds the tie to even; so does the JS above


# ------------------------------------------------------------------------- the cover proof


@cache
def _ffmpeg() -> str | None:
    """The first ffmpeg that decodes the fixture (H.264 + AAC) without a word — on PATH, then
    Playwright's in /opt/pw-browsers (a build that may know no MP4 at all) — else None."""
    candidates = [shutil.which("ffmpeg")]
    candidates += sorted(
        str(path) for path in Path("/opt/pw-browsers").glob("ffmpeg-*/ffmpeg-linux")
    )
    with tempfile.TemporaryDirectory() as scratch:
        fixture = _written(Path(scratch) / "tiny.mp4", TINY_MP4)
        for candidate in candidates:
            if candidate is None:
                continue
            proc = subprocess.run(
                [candidate, "-v", "error", "-i", str(fixture), "-map", "0", "-f", "framemd5", "-"],
                capture_output=True,
                timeout=60,
                check=False,
            )
            if proc.returncode == 0 and not proc.stderr and proc.stdout.count(b"\n") > 100:
                return candidate
    return None


def _real_jpeg(directory: Path, png: bytes) -> bytes | None:
    """A real 64x48 JPEG made by ffmpeg (its test pattern, else the PNG converted), or None."""
    ffmpeg = _ffmpeg()
    assert ffmpeg is not None
    target = directory / "cover.jpg"
    source = _written(directory / "source.png", png)
    for arguments in (
        ["-f", "lavfi", "-i", "testsrc=size=64x48:rate=1"],
        ["-i", str(source), "-vf", "scale=64:48"],
    ):
        proc = subprocess.run(
            [ffmpeg, "-v", "error", "-y", *arguments, "-frames:v", "1", str(target)],
            capture_output=True,
            timeout=60,
            check=False,
        )
        if proc.returncode == 0 and target.is_file() and image_kind(target.read_bytes()) == "jpeg":
            return target.read_bytes()
    return None


def _framemd5(path: Path) -> list[str]:
    """`ffmpeg -v error -i <file> -map 0 -f framemd5 -`: one line per decoded frame of every
    stream (and the stream headers); ffmpeg must decode it silently."""
    ffmpeg = _ffmpeg()
    assert ffmpeg is not None
    proc = subprocess.run(
        [ffmpeg, "-v", "error", "-i", str(path), "-map", "0", "-f", "framemd5", "-"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stderr == ""  # decoded silently
    return [line for line in proc.stdout.splitlines() if line and not line.startswith("#software")]


def _stream_lines(lines: list[str], index: int) -> list[str]:
    header = f" {index}:"
    return [
        line
        for line in lines
        if (line.startswith("#") and header in line) or line.startswith(f"{index},")
    ]


def _streams(lines: list[str]) -> int:
    return sum(1 for line in lines if line.startswith("#media_type "))


def _layouts() -> list[tuple[str, bytes]]:
    return [
        ("faststart, existing ilst", TINY_MP4),
        ("moov after mdat", _moov_last(TINY_MP4)),
        ("no udta", _without_udta(TINY_MP4)),
        ("moov after mdat, no udta", _moov_last(_without_udta(TINY_MP4))),
        ("udta without meta", _udta_without_meta(TINY_MP4)),
        ("meta without ilst", _meta_without_ilst(TINY_MP4)),
        ("co64 chunk offsets", _with_co64(TINY_MP4)),
    ]


def _embed_all(
    directory: Path, sources: Sequence[tuple[str, bytes]], images: Sequence[tuple[str, bytes]]
) -> list[tuple[str, str, Path, Path, bytes]]:
    """Embed every image into every source with the extension; `(layout, image, source path,
    embedded path, image bytes)` for each."""
    directory.mkdir(parents=True, exist_ok=True)
    cases = []
    made = []
    for index, (layout, data) in enumerate(sources):
        source = directory / f"layout{index}.mp4"
        source.write_bytes(data)
        for image_name, image in images:
            image_path = directory / f"{image_name}.img"
            image_path.write_bytes(image)
            out = directory / f"layout{index}-{image_name}.mp4"
            cases.append(
                {"op": "embed", "video": str(source), "image": str(image_path), "out": str(out)}
            )
            made.append((layout, image_name, source, out, image))
    sizes = _values(cases)
    for (_, _, _, out, _), size in zip(made, sizes, strict=True):
        assert out.stat().st_size == size["size"]
    return made


def _mdat_end(data: bytes) -> int:
    pos, size = child(data, b"mdat")
    return pos + size


def _assert_samples_untouched(source: bytes, embedded: bytes) -> None:
    """Every chunk offset of the embedded file points at the bytes the original's pointed at
    (64 of them, or up to the end of the `mdat`)."""
    before, after = _chunk_offsets(source), _chunk_offsets(embedded)
    assert len(before) == len(after) > 0
    end = _mdat_end(source)
    for old, new in zip(before, after, strict=True):
        length = min(64, end - old)
        assert length > 0
        assert embedded[new : new + length] == source[old : old + length]


def test_embedded_covers_read_back_in_every_layout(tmp_path: Path) -> None:
    """mutagen reads the cover the extension wrote back byte for byte, with its type; the
    duration mutagen reads is unchanged; the file still verifies, has no DRM, and every chunk
    offset still points at the same samples; Python's and the extension's extract agree."""
    images = [("jpeg", FAKE_JPEG), ("png", _png(48, 64))]
    made = _embed_all(tmp_path, _layouts(), images)
    extracted = _values([{"op": "extract", "path": str(out)} for *_, out, _ in made])
    for (layout, image_name, source, out, image), js_cover in zip(made, extracted, strict=True):
        where = (layout, image_name)
        tags = MP4(out).tags
        assert tags is not None, where
        covers = tags["covr"]
        assert [bytes(cover) for cover in covers] == [image], where
        want_format = MP4Cover.FORMAT_JPEG if image_name == "jpeg" else MP4Cover.FORMAT_PNG
        assert covers[0].imageformat == want_format, where
        assert MP4(out).info.length == MP4(source).info.length, where
        assert verify_video(out, 3) is None and drm_problem(out) is None, where
        mime = "image/jpeg" if image_name == "jpeg" else "image/png"
        assert extract_cover(out) == (image, mime), where
        assert js_cover == {"mime": mime, "base64": base64.b64encode(image).decode()}, where
        assert has_embedded_cover(out), where
        _assert_samples_untouched(source.read_bytes(), out.read_bytes())
        if layout == "faststart, existing ilst":
            assert tags["\xa9too"] == ["Lavf60.16.100"]  # every other tag kept
    sources = {layout: source.read_bytes() for layout, _, source, _, _ in made}
    assert sources["faststart, existing ilst"] == TINY_MP4  # the input is never modified


def test_embedded_covers_decode_like_the_original_with_ffmpeg(tmp_path: Path) -> None:
    """`framemd5` of every stream of the original equals the embedded file's (audio and video
    decode to the same frames: nothing moved out of sync); the cover is one more stream, the
    last, a single picture of the image's size; ffmpeg decodes every file silently."""
    if _ffmpeg() is None:
        pytest.skip("no ffmpeg that decodes H.264 + AAC on PATH or in /opt/pw-browsers/ffmpeg-*/")
    jpeg = _real_jpeg(tmp_path, _png(64, 48))
    if jpeg is None:
        pytest.skip(f"{_ffmpeg()} cannot write a JPEG for the cover stream to decode")
    images = [("jpeg", jpeg), ("png", _png(48, 64))]
    dimensions = {"jpeg": "64x48", "png": "48x64"}
    original = tmp_path / "original.mp4"
    original.write_bytes(TINY_MP4)
    reference = _framemd5(original)
    assert _streams(reference) == 2
    for index, (layout, data) in enumerate(_layouts()):
        path = tmp_path / f"plain{index}.mp4"
        path.write_bytes(data)
        assert _framemd5(path) == reference, layout  # the layout itself plays like the fixture
    for layout, image_name, _, out, _ in _embed_all(tmp_path, _layouts(), images):
        lines = _framemd5(out)
        assert _streams(lines) == 3, (layout, image_name)
        cover = _stream_lines(lines, 2)
        assert f"#dimensions 2: {dimensions[image_name]}" in cover, (layout, image_name)
        assert len([line for line in cover if not line.startswith("#")]) == 1
        assert [line for line in lines if line not in cover] == reference, (layout, image_name)


def test_an_existing_cover_is_replaced(tmp_path: Path) -> None:
    """A cover over the extension's own, and over one mutagen embedded (with its padding): one
    `covr` holds the new image only, every other tag stays, the samples stay put, and (with
    ffmpeg) the media decodes the same."""
    jpeg, png = FAKE_JPEG, _png(48, 64)
    mutagen_made = _written(tmp_path / "mutagen.mp4", TINY_MP4)
    embed_cover(mutagen_made, jpeg)  # Python's embedding
    ((*_, jpeg_embedded, _),) = _embed_all(
        tmp_path / "first", [("plain", TINY_MP4)], [("jpeg", jpeg)]
    )
    made = _embed_all(
        tmp_path / "second",
        [("over ours", jpeg_embedded.read_bytes()), ("over mutagen's", mutagen_made.read_bytes())],
        [("png", png)],
    )
    length = MP4(_written(tmp_path / "tiny.mp4", TINY_MP4)).info.length
    for layout, _, source, out, _ in made:
        tags = MP4(out).tags
        assert tags is not None, layout
        assert [bytes(cover) for cover in tags["covr"]] == [png], layout
        assert tags["covr"][0].imageformat == MP4Cover.FORMAT_PNG, layout
        assert tags["\xa9too"] == ["Lavf60.16.100"], layout
        assert MP4(out).info.length == length, layout
        assert verify_video(out, 3) is None, layout
        _assert_samples_untouched(source.read_bytes(), out.read_bytes())
    # the cover box was replaced in place: the file changed by the difference of the two images
    assert made[0][3].stat().st_size == jpeg_embedded.stat().st_size - len(jpeg) + len(png)
    if _ffmpeg() is not None:
        reference = _framemd5(tmp_path / "tiny.mp4")
        for layout, _, _, out, _ in made:
            lines = _framemd5(out)
            assert [line for line in lines if line not in _stream_lines(lines, 2)] == reference, (
                layout
            )


def test_co64_offsets_move_with_the_cover(tmp_path: Path) -> None:
    """A file with 8-byte chunk offsets: every one moves by exactly the size of the cover box,
    since every chunk lies behind the `moov`."""
    source = _with_co64(TINY_MP4)
    assert [kind for _, kind in _tables(source)] == [b"co64", b"co64"]
    assert verify_video(_written(tmp_path / "co64.mp4", source), 3) is None
    ((_, _, _, out, image),) = _embed_all(tmp_path, [("co64", source)], [("png", _png(48, 64))])
    embedded = out.read_bytes()
    cover_box = 8 + 16 + len(image)
    assert len(embedded) == len(source) + cover_box
    assert [kind for _, kind in _tables(embedded)] == [b"co64", b"co64"]
    assert _chunk_offsets(embedded) == [offset + cover_box for offset in _chunk_offsets(source)]
    _assert_samples_untouched(source, embedded)


def test_embed_refusals_say_what_python_says(tmp_path: Path) -> None:
    """Every refusal of `embedCover` reads like `thumbnails.embed_cover`'s (given the file's
    name), the cover is not written anywhere, and the video is the original."""
    stco_audio = next(
        pos for pos, kind in _tables(TINY_MP4) if kind == b"stco" and pos > AUDIO_TRAK
    )
    count = int.from_bytes(TINY_MP4[stco_audio + 12 : stco_audio + 16], "big")
    overflow = _patched(
        TINY_MP4, stco_audio + 16 + 4 * (count - 1), (0xFFFFFFF0).to_bytes(4, "big")
    )
    webp = b"RIFF" + (300).to_bytes(4, "little") + b"WEBPVP8 " + bytes(300)
    cases_in = [
        ("a webp", TINY_MP4, webp),
        ("not an image", TINY_MP4, b"GIF89a" + bytes(400)),
        ("too large", TINY_MP4, FAKE_JPEG[:4] + bytes(MAX_COVER_BYTES + 1 - 4)),
        ("not an MP4", random.Random(3).randbytes(4096), FAKE_JPEG),
        ("cut inside the moov", TINY_MP4[:2000], FAKE_JPEG),
        ("a chunk offset that would overflow", overflow, FAKE_JPEG),
    ]
    cases = []
    expected = []
    for index, (name, video, image) in enumerate(cases_in):
        video_path = _written(tmp_path / f"ep{index}.mp4", video)
        image_path = _written(tmp_path / f"cover{index}.img", image)
        out = tmp_path / f"out{index}.mp4"
        cases.append(
            {
                "op": "embed",
                "video": str(video_path),
                "image": str(image_path),
                "out": str(out),
                "name": video_path.name,
            }
        )
        with pytest.raises(ThumbnailError) as excinfo:
            embed_cover(video_path, image)
        assert video_path.read_bytes() == video, name  # Python leaves it as it was, too
        expected.append((name, str(excinfo.value), out))
    results = _node(cases)
    for (name, want, out), result in zip(expected, results, strict=True):
        assert result.get("error") == want, (name, result)
        assert result.get("type") == "ThumbnailError"
        assert not out.exists(), name
    assert expected[5][1] == (
        "could not write the cover into ep5.mp4 (MP4MetadataError: wrong offset inside b'stco')"
    )
    webp_case = {
        "op": "embed",
        "video": str(tmp_path / "ep0.mp4"),
        "image": str(tmp_path / "cover1.img"),
        "kind": "webp",
        "out": str(tmp_path / "x.mp4"),
    }
    assert _node([webp_case])[0]["error"] == "webp cannot be embedded"  # the caller's kind counts


def test_extract_cover_agrees(tmp_path: Path) -> None:
    """`extractCover` returns what `thumbnails.extract_cover` returns — the first cover, the
    bytes deciding its type — for every way a `covr` can be written."""
    png = _png(8, 8)
    plain = b"no magic at all, just bytes" * 10
    webp = b"RIFF" + (300).to_bytes(4, "little") + b"WEBPVP8 " + bytes(300)
    covr = _box
    variants = [
        ("no cover", TINY_MP4),
        ("jpeg", _with_ilst_children(TINY_MP4, covr(b"covr", _data_atom(13, FAKE_JPEG)))),
        ("png declared implicit", _with_ilst_children(TINY_MP4, covr(b"covr", _data_atom(0, png)))),
        (
            "png bytes declared jpeg",
            _with_ilst_children(TINY_MP4, covr(b"covr", _data_atom(13, png))),
        ),
        (
            "no magic, declared png",
            _with_ilst_children(TINY_MP4, covr(b"covr", _data_atom(14, plain))),
        ),
        (
            "no magic, declared other",
            _with_ilst_children(TINY_MP4, covr(b"covr", _data_atom(27, plain))),
        ),
        ("webp bytes", _with_ilst_children(TINY_MP4, covr(b"covr", _data_atom(13, webp)))),
        ("empty data", _with_ilst_children(TINY_MP4, covr(b"covr", _data_atom(13, b"")))),
        (
            "name atom first",
            _with_ilst_children(TINY_MP4, covr(b"covr", _box(b"name", b"x") + _data_atom(14, png))),
        ),
        (
            "two images",
            _with_ilst_children(
                TINY_MP4, covr(b"covr", _data_atom(14, png) + _data_atom(13, FAKE_JPEG))
            ),
        ),
        (
            "two covr boxes",
            _with_ilst_children(
                TINY_MP4,
                covr(b"covr", _data_atom(13, FAKE_JPEG)) + covr(b"covr", _data_atom(14, png)),
            ),
        ),
        (
            "a covr too short to parse first",
            _with_ilst_children(
                TINY_MP4, covr(b"covr", _box(b"wxyz", b"")) + covr(b"covr", _data_atom(14, png))
            ),
        ),
        (
            "a broken covr first",
            _with_ilst_children(
                TINY_MP4,
                covr(b"covr", _box(b"wxyz", bytes(4))) + covr(b"covr", _data_atom(14, png)),
            ),
        ),
        (
            "tags that fail to load",
            _with_ilst_children(
                TINY_MP4, covr(b"covr", _data_atom(14, png)) + _box(b"----", b"\0\0\xff\xff")
            ),
        ),
        ("not an MP4", b"\0" * 100),
    ]
    cases = []
    expected = []
    for index, (name, data) in enumerate(variants):
        path = _written(tmp_path / f"cover{index}.mp4", data)
        cases.append({"op": "extract", "path": str(path)})
        cases.append({"op": "hasCover", "path": str(path)})
        found = extract_cover(path)
        want = (
            None
            if found is None
            else {"mime": found[1], "base64": base64.b64encode(found[0]).decode()}
        )
        expected.append((name, want, has_embedded_cover(path)))
    results = _values(cases)
    for index, (name, want, has_cover) in enumerate(expected):
        assert results[2 * index] == want, name
        assert results[2 * index + 1] is has_cover, name
    assert expected[3][1] == {"mime": "image/png", "base64": base64.b64encode(png).decode()}
    by_name = {name: want for name, want, _ in expected}
    assert by_name["webp bytes"] is None
    # a covr whose 12-byte header cannot even be unpacked fails the whole tag list, while a
    # stray atom inside one only marks that covr as failed: the next covr is the cover
    assert by_name["a covr too short to parse first"] is None
    assert by_name["a broken covr first"] == by_name["png declared implicit"]
