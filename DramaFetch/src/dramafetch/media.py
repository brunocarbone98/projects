"""Integrity of a saved video: does the file play as the episode it claims to be?

Both engines run :func:`verify_video` on every file they save — before the cover step — unless
``DownloadOptions.verify`` is off. The probe is mutagen's MP4 parser (the library that already
embeds the covers): the file must be an MP4 it can read, must not be cut short, must carry an
audio track and must last about as long as the episode list said (``Episode.duration_s``, a whole
number of seconds). mutagen reads the index at the front of the file (``moov``) and never notices
when the samples behind it (``mdat``) stop early, so :func:`atom_problem` also walks the top-level
atoms and reports one whose declared size runs past the end of the file. A file that fails is not
deleted but renamed ``<name> (incomplete).<ext>`` (:func:`quarantine`): the bytes stay for
inspection, the stem no longer matches the episode's, so a rerun downloads it again — with one
exception, a file the OS refuses to rename even after a few retries, which :func:`quarantine_note`
deletes instead: left under the episode's name it would pass for the episode. Nothing here
decodes video; ffmpeg is not needed. A locked episode served as a short preview is exactly what the
duration check catches.

DRM is a separate check that ALWAYS runs, ``--no-verify`` or not: :func:`drm_problem` (a saved
file) and :func:`drm_problem_in` (a body still in memory) walk the box structure — box headers
only, never the samples — for encrypted tracks (an ``encv`` / ``enca`` sample entry, a ``pssh``
box). Encrypted media can never play and DramaFetch never decrypts it, so it is never kept: the
yt-dlp engine deletes such a file (:func:`discard_note`), the browser engine never writes it.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from dramafetch.errors import MediaError
from dramafetch.models import DRM_MESSAGE

if TYPE_CHECKING:
    from mutagen.mp4 import MP4

log = logging.getLogger(__name__)

#: Appended to the stem of a file that failed the verification (``quarantine``).
INCOMPLETE_MARK = " (incomplete)"
#: Prefix of the message of an episode whose saved file failed the verification.
INCOMPLETE_PREFIX = "download looks incomplete or wrong: "
#: A rename the OS refuses — on Windows, a just-written file that an antivirus or an indexer still
#: holds — is tried again this many times, :data:`RENAME_RETRY_DELAY_S` apart, before
#: :func:`quarantine_note` gives up and deletes the file instead.
RENAME_RETRIES = 2
RENAME_RETRY_DELAY_S = 0.5
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
#: Sample-entry types of an encrypted track (ISO/IEC 23001-7, Common Encryption — what Widevine,
#: PlayReady and FairPlay's ``cbcs`` all use): the track's own entry (``avc1``, ``mp4a``, …) is
#: renamed so that no player tries to decode samples it cannot decrypt. :func:`drm_problem` looks
#: for them in ``moov/trak/mdia/minf/stbl/stsd``.
ENCRYPTED_SAMPLE_ENTRIES = frozenset({b"encv", b"enca"})
#: The Protection System Specific Header box (a DRM system's key information), at the top level
#: of the file or among the ``moov`` children.
PSSH_BOX = b"pssh"
#: The boxes from a ``trak`` down to its sample descriptions, in order.
_TRACK_PATH = (b"mdia", b"minf", b"stbl", b"stsd")
#: Box headers one DRM walk reads at most, every level together (a real MP4 has a few dozen).
_MAX_DRM_BOXES = _MAX_ATOMS


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


def drm_problem(path: Path) -> str | None:
    """:data:`~dramafetch.models.DRM_MESSAGE` when the saved file carries encrypted tracks, else
    None.

    A STRUCTURAL walk of the MP4 boxes that reads box headers only (plus an ``stsd``'s version,
    flags and entry count), 8 bytes at a time with ``seek`` — never the samples in ``mdat``: a
    top-level ``pssh``, a ``pssh`` among the ``moov`` children, or an ``encv`` / ``enca`` sample
    entry (:data:`ENCRYPTED_SAMPLE_ENTRIES`) in ``moov/trak/mdia/minf/stbl/stsd`` means DRM.
    Bytes that merely spell ``encv`` somewhere — inside the samples, say — are not a box and mean
    nothing. At most :data:`_MAX_DRM_BOXES` headers are read. Never raises: a file that cannot be
    read or does not parse is "no DRM found" (judging a malformed file is :func:`verify_video`'s
    job). Both engines run it on every video they save, whatever ``DownloadOptions.verify``
    says: an encrypted file can never play, and DramaFetch never keeps encrypted media.
    """
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:

            def read(offset: int, count: int) -> bytes:
                handle.seek(offset)
                return handle.read(count)

            encrypted = _BoxWalk(read, size).encrypted()
    except Exception as exc:  # an unreadable file, or anything a hostile one could provoke
        log.debug("DRM check of %s gave up: %s", path.name, _detail(exc))
        return None
    return DRM_MESSAGE if encrypted else None


def drm_problem_in(data: bytes) -> str | None:
    """:func:`drm_problem` for a body still in memory (the browser engine checks it BEFORE
    anything is written): the same structural walk over ``data``, the same answer, never
    raises."""
    try:
        found = _BoxWalk(lambda offset, count: data[offset : offset + count], len(data)).encrypted()
    except Exception as exc:  # junk must never break a download: it is simply not DRM
        log.debug("DRM check of a %d-byte body gave up: %s", len(data), _detail(exc))
        return None
    return DRM_MESSAGE if found else None


class _BoxWalk:
    """The box structure of one MP4 (a file or a buffer behind ``read(offset, count)``), read one
    header at a time and only along the paths where encryption is declared. Every header read
    spends one of :data:`_MAX_DRM_BOXES`; when they are spent the walk ends with "no DRM found"."""

    def __init__(self, read: Callable[[int, int], bytes], size: int) -> None:
        self._read = read
        self._size = size
        self._budget = _MAX_DRM_BOXES

    def encrypted(self) -> bool:
        for kind, start, end in self._boxes(0, self._size):
            if kind == PSSH_BOX:
                return True
            if kind == b"moov" and self._movie_encrypted(start, end):
                return True
        return False

    def _movie_encrypted(self, start: int, end: int) -> bool:
        for kind, child_start, child_end in self._boxes(start, end):
            if kind == PSSH_BOX:
                return True
            if kind == b"trak" and self._track_encrypted(child_start, child_end):
                return True
        return False

    def _track_encrypted(self, start: int, end: int) -> bool:
        """``trak`` → ``mdia`` → ``minf`` → ``stbl`` → ``stsd``, then its sample entries."""
        for container in _TRACK_PATH:
            span = self._first(container, start, end)
            if span is None:
                return False
            start, end = span
        # `stsd` is a full box: version (1 byte), flags (3) and the entry count (4) come first.
        header = self._read(start, 8)
        if len(header) < 8:
            return False
        count = int.from_bytes(header[4:8], "big")
        for index, (kind, _, _) in enumerate(self._boxes(start + 8, end)):
            if index >= count:
                return False
            if kind in ENCRYPTED_SAMPLE_ENTRIES:
                return True
        return False

    def _first(self, kind: bytes, start: int, end: int) -> tuple[int, int] | None:
        for found, child_start, child_end in self._boxes(start, end):
            if found == kind:
                return child_start, child_end
        return None

    def _boxes(self, start: int, end: int) -> Iterator[tuple[bytes, int, int]]:
        """``(type, payload start, payload end)`` of each box between ``start`` and ``end``, in
        order. A size of 0 runs to ``end``; a size of 1 is followed by a 64-bit size; a size
        smaller than the header itself ends the walk at this level; a box declared to run past
        ``end`` is cut there (a file cut short is still examined as far as it goes)."""
        pos = start
        while pos + 8 <= end and self._budget > 0:
            self._budget -= 1
            header = self._read(pos, 8)
            if len(header) < 8:
                return
            declared = int.from_bytes(header[:4], "big")
            payload = pos + 8
            if declared == 1:
                large = self._read(payload, 8)
                if len(large) < 8:
                    return
                declared = int.from_bytes(large, "big")
                payload += 8
            elif declared == 0:
                declared = end - pos
            if pos + declared < payload:
                return
            yield header[4:8], payload, min(pos + declared, end)
            pos += declared


def discard(path: Path, *, sleep: Callable[[float], None] = time.sleep) -> None:
    """Delete a file DramaFetch must not keep: a download with encrypted tracks (see
    :func:`drm_problem`) — not quarantined like an incomplete one, because no rerun can make it
    play. A deletion the OS refuses is tried again :data:`RENAME_RETRIES` times,
    :data:`RENAME_RETRY_DELAY_S` apart (``sleep`` is injectable: no test waits for real); the
    last ``OSError`` propagates. A file that is already gone is fine."""
    for _ in range(RENAME_RETRIES):
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            log.debug("deleting %s refused (%s); trying again", path.name, exc.strerror)
            sleep(RENAME_RETRY_DELAY_S)
        else:
            return
    path.unlink(missing_ok=True)


def discard_note(path: Path, *, sleep: Callable[[float], None] = time.sleep) -> str | None:
    """Delete an encrypted download (:func:`discard`) and return None — or, when the OS refused
    even after the retries, the note the engine puts in parentheses after the DRM message:
    ``"could not delete <name>: <OS error> — delete it by hand: it cannot play, and left there it
    would pass for the episode"`` (logged at WARNING). Never raises for an OS error."""
    try:
        discard(path, sleep=sleep)
    except OSError as exc:
        reason = exc.strerror or exc.__class__.__name__
        log.warning(
            "could not delete %s (%s): an encrypted file would pass for the episode",
            path.name,
            reason,
        )
        return (
            f"could not delete {path.name}: {reason} — delete it by hand: it cannot play, and "
            "left there it would pass for the episode"
        )
    return None


def quarantine(path: Path, *, sleep: Callable[[float], None] = time.sleep) -> Path:
    """Rename ``<stem>.<ext>`` to ``<stem> (incomplete).<ext>`` — ``<stem> (incomplete 2).<ext>``
    and so on when that name is taken, never overwriting anything — and return the new path. The
    stem no longer matches the episode's, so ``existing_episode_file`` ignores it and a rerun tries
    the episode again, while the manifest records the failure with the reason. A rename the OS
    refuses is tried again :data:`RENAME_RETRIES` times, :data:`RENAME_RETRY_DELAY_S` apart
    (``sleep`` is injectable: no test waits for real); the last ``OSError`` propagates."""
    attempt = 1
    while True:
        mark = INCOMPLETE_MARK if attempt == 1 else f" (incomplete {attempt})"
        target = path.with_name(f"{path.stem}{mark}{path.suffix}")
        if not target.exists():
            break
        attempt += 1
    for _ in range(RENAME_RETRIES):
        try:
            return path.rename(target)
        except OSError as exc:
            log.debug("renaming %s refused (%s); trying again", path.name, exc.strerror)
            sleep(RENAME_RETRY_DELAY_S)
    return path.rename(target)


def quarantine_note(path: Path, *, sleep: Callable[[float], None] = time.sleep) -> str:
    """Move a file that failed :func:`verify_video` out of the episode's way and say what became
    of it — the parenthesised end of the engines' FAILED message, after the reason:

    * ``"kept as <stem> (incomplete).<ext>"`` — the normal case (:func:`quarantine`);
    * ``"could not rename <name>: <OS error>; deleted, so that it does not pass for the
      episode"`` — the OS refused the rename even after the retries, so the file was deleted: the
      one case in which DramaFetch deletes a download, because a bad file left under the
      episode's name would be taken for the episode (``existing_episode_file``) and the next run
      would skip it as done;
    * ``"could not rename or delete <name>: <OS error> — delete it by hand, or the next run skips
      the episode as already downloaded"`` — not even that worked (a file another program holds
      open, on Windows); the file is still there, under the episode's name.

    Both failures are logged at WARNING. Never raises for an OS error.
    """
    try:
        kept = quarantine(path, sleep=sleep)
    except OSError as exc:
        reason = exc.strerror or exc.__class__.__name__
        try:
            path.unlink(missing_ok=True)
        except OSError:
            log.warning(
                "could not rename or delete %s (%s): it would pass for the episode",
                path.name,
                reason,
            )
            return (
                f"could not rename or delete {path.name}: {reason} — delete it by hand, or the "
                "next run skips the episode as already downloaded"
            )
        log.warning(
            "could not rename %s (%s): deleted, so that it does not pass for the episode",
            path.name,
            reason,
        )
        return (
            f"could not rename {path.name}: {reason}; deleted, so that it does not pass for the "
            "episode"
        )
    return f"kept as {kept.name}"


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
