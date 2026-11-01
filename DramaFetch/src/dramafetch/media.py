"""Integrity of a saved video: does the file play as the episode it claims to be?

Both engines run :func:`verify_video` on every file they save — before the cover step — unless
``DownloadOptions.verify`` is off. The probe is mutagen's MP4 parser (the library that already
embeds the covers): the file must be an MP4 it can read, must not be cut short, must carry an
audio track and must last about as long as the episode list said (``Episode.duration_s``, a whole
number of seconds). mutagen reads the index at the front of the file (``moov``) and never notices
when the samples behind it (``mdat``) stop early, so :func:`atom_problem` also walks the top-level
atoms and reports one whose declared size runs past the end of the file. A file that fails is not
deleted but renamed ``<name> (incomplete).<ext>`` (:func:`quarantine`): the bytes stay for
inspection, the stem no longer matches the episode's, so a rerun downloads it again. Nothing here
decodes video; ffmpeg is not needed. A locked episode served as a short preview is exactly what the
duration check catches.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from dramafetch.errors import MediaError

if TYPE_CHECKING:
    from mutagen.mp4 import MP4

log = logging.getLogger(__name__)

#: Appended to the stem of a file that failed the verification (``quarantine``).
INCOMPLETE_MARK = " (incomplete)"
#: Prefix of the message of an episode whose saved file failed the verification.
INCOMPLETE_PREFIX = "download looks incomplete or wrong: "
#: Containers :func:`verify_video` judges; another suffix returns None (TikTok serves MP4 only).
MP4_SUFFIXES = frozenset({".mp4", ".m4v", ".mov"})
#: Duration tolerance: TikTok's ``duration`` is a whole number of seconds and the container's own
#: clock rounds too, so a few seconds — or 5 % of a long episode — are no problem; a 20-second
#: preview served for a locked 2-minute episode is.
DURATION_TOLERANCE_S = 3.0
DURATION_TOLERANCE_RATIO = 0.05
#: Top-level atoms a real MP4 is made of. The walk trusts no other header and stops there, so a
#: file with trailing junk is not condemned; a known atom cut short is.
KNOWN_ATOMS = frozenset(
    {
        b"ftyp",
        b"styp",
        b"moov",
        b"moof",
        b"mdat",
        b"free",
        b"skip",
        b"wide",
        b"junk",
        b"uuid",
        b"meta",
        b"mfra",
        b"sidx",
        b"pdin",
    }
)
_MAX_ATOMS = 1024
_MAX_DETAIL_LEN = 120
_warned_about_mutagen = False


@dataclass(frozen=True)
class VideoProbe:
    """What the container index says: the length in seconds and whether there is an audio track
    (``audio_codec`` is mutagen's name for it, e.g. ``mp4a.40.2`` for AAC, None without one)."""

    duration_s: float
    has_audio: bool
    audio_codec: str | None


def _mp4_class() -> type[MP4] | None:
    """mutagen's ``MP4`` (imported lazily, like ``thumbnails`` does), None when mutagen is not
    installed."""
    try:
        from mutagen.mp4 import MP4
    except ImportError:
        return None
    return MP4


def probe_video(path: Path) -> VideoProbe:
    """Read the container index with mutagen. Raises :class:`~dramafetch.errors.MediaError` —
    ``"not a valid MP4 (<detail>)"`` — when the file is not an MP4 mutagen can parse, cannot be
    read, or when mutagen is not installed. A video-only MP4 is fine: ``has_audio`` is False (its
    ``info.codec`` is empty), nothing raises."""
    mp4 = _mp4_class()
    if mp4 is None:
        raise MediaError("not a valid MP4 (mutagen is not installed: pip install mutagen)")
    try:
        info = mp4(path).info
    except Exception as exc:  # MP4StreamInfoError, mutagen's wrapped OSError, a struct error
        raise MediaError(f"not a valid MP4 ({_detail(exc)})") from exc
    codec = str(getattr(info, "codec", "") or "")
    return VideoProbe(
        duration_s=float(getattr(info, "length", 0.0) or 0.0),
        has_audio=bool(codec),
        audio_codec=codec or None,
    )


def verify_video(path: Path, expected_duration_s: int | None) -> str | None:
    """Why the saved video is not the episode, or None when it looks fine.

    Reasons, in the order they are checked: ``"not a valid MP4 (<detail>)"`` (mutagen cannot
    parse it), ``"truncated MP4 (<atom> atom cut short: <have> of <need> bytes)"`` (see
    :func:`atom_problem`), ``"no playable duration"``, ``"no audio track"``, ``"duration 61 s,
    expected 120 s"`` when ``|actual - expected| > max(3.0, 0.05 * expected)``. Without an
    expected duration (``None`` or 0: ``dramafetch video`` has no episode list) the duration is
    not judged. A suffix outside :data:`MP4_SUFFIXES` returns None: nothing here can judge it.
    Without mutagen only the atom walk runs (a WARNING says so, once): a missing library must not
    condemn every download.
    """
    global _warned_about_mutagen
    if path.suffix.lower() not in MP4_SUFFIXES:
        return None
    if _mp4_class() is None:
        if not _warned_about_mutagen:
            _warned_about_mutagen = True
            log.warning(
                "mutagen is not installed (pip install mutagen): saved videos are checked for "
                "truncation only, not parsed"
            )
        return atom_problem(path)
    try:
        probe = probe_video(path)
    except MediaError as exc:
        return str(exc)
    truncated = atom_problem(path)
    if truncated is not None:
        return truncated
    if probe.duration_s <= 0:
        return "no playable duration"
    if not probe.has_audio:
        return "no audio track"
    if expected_duration_s is not None and expected_duration_s > 0:
        tolerance = max(DURATION_TOLERANCE_S, DURATION_TOLERANCE_RATIO * expected_duration_s)
        if abs(probe.duration_s - expected_duration_s) > tolerance:
            return f"duration {probe.duration_s:.0f} s, expected {expected_duration_s} s"
    return None


def atom_problem(path: Path) -> str | None:
    """A top-level atom whose declared size runs past the end of the file — the download stopped
    early — as ``"truncated MP4 (mdat atom cut short: 1200000 of 13087000 bytes)"``, else None.

    Reads atom headers only (8 bytes, 16 for a 64-bit size): a header whose type is not in
    :data:`KNOWN_ATOMS`, or a size the format does not define, ends the walk without a verdict —
    trailing junk is not a truncation. A size of 0 means "to the end of the file" and is fine.
    An unreadable file is reported as ``"unreadable (<detail>)"``.
    """
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            offset = 0
            for _ in range(_MAX_ATOMS):
                if offset >= size:
                    return None
                handle.seek(offset)
                header = handle.read(16)
                if len(header) < 8:
                    return None
                kind = header[4:8]
                if kind not in KNOWN_ATOMS:
                    return None
                declared = int.from_bytes(header[:4], "big")
                if declared == 0:
                    return None
                if declared == 1:
                    if len(header) < 16:
                        return _cut_short(kind, size - offset, None)
                    declared = int.from_bytes(header[8:16], "big")
                if declared < 8:
                    return None
                if offset + declared > size:
                    return _cut_short(kind, size - offset, declared)
                offset += declared
    except OSError as exc:
        return f"unreadable ({exc.strerror or exc.__class__.__name__})"
    return None


def quarantine(path: Path) -> Path:
    """Rename ``<stem>.<ext>`` to ``<stem> (incomplete).<ext>`` — ``<stem> (incomplete 2).<ext>``
    and so on when that name is taken, never overwriting anything — and return the new path. The
    stem no longer matches the episode's, so ``existing_episode_file`` ignores it and a rerun tries
    the episode again, while the manifest records the failure with the reason."""
    attempt = 1
    while True:
        mark = INCOMPLETE_MARK if attempt == 1 else f" (incomplete {attempt})"
        target = path.with_name(f"{path.stem}{mark}{path.suffix}")
        if not target.exists():
            return path.rename(target)
        attempt += 1


def _cut_short(kind: bytes, have: int, need: int | None) -> str:
    name = kind.decode("ascii", "replace")
    if need is None:
        return f"truncated MP4 ({name} atom cut short: {have} bytes left for its header)"
    return f"truncated MP4 ({name} atom cut short: {have} of {need} bytes)"


def _detail(exc: BaseException) -> str:
    lines = [line.strip() for line in str(exc).splitlines() if line.strip()]
    text = lines[0] if lines else exc.__class__.__name__
    if len(text) > _MAX_DETAIL_LEN:
        text = text[: _MAX_DETAIL_LEN - 1] + "…"
    return text
