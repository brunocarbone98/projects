"""The episode cover: what an image body is, where it is kept, and how it goes INTO the MP4.

By default the cover of an episode is embedded in the video file itself, as its cover art — the
``covr`` atom of the MP4 metadata, which is what iTunes, the Apple TV app, Infuse, VLC's media
library and most music-style players show for a file (Windows Explorer, Finder and phone galleries
show a frame of the video instead, hence the ``both`` mode of ``DownloadOptions.thumbnail``, which
also keeps a file next to the video for Plex, Jellyfin and Kodi). mutagen — pure Python, the
library yt-dlp itself uses for the job — does the writing: no ffmpeg, no AtomicParsley. Both
download engines call :func:`embed_cover`; the web UI reads the cover back with
:func:`extract_cover` and finds a sidecar with :func:`cover_sidecar`.

The one rule here: a downloaded video is never modified in place. :func:`embed_cover` copies it to
``<name>.embed.part`` in the same directory, writes the cover into the copy and ``os.replace``s the
copy over the original (atomic on the same file system); any failure deletes the copy and leaves
the original byte for byte as it was. mutagen is imported lazily, inside the two functions that
need it, so everything else works — and says so — when it is not installed.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from dramafetch.errors import ThumbnailError

log = logging.getLogger(__name__)

#: Extensions a cover file next to a video can have — yt-dlp's ``writethumbnail`` keeps the cover
#: URL's own (``.jpeg`` for TikTok), the browser engine names after the image type — in the order
#: :func:`cover_sidecar` looks for them.
COVER_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp")
#: Bigger "covers" are error pages or abuse, not an episode's cover: never kept, never embedded.
MAX_COVER_BYTES = 5 * 1024 * 1024
#: A cover is kilobytes; anything smaller than this is an error body, not an image.
MIN_IMAGE_BYTES = 200
#: Video containers whose metadata mutagen's ``MP4`` class writes (ISO base media files): the only
#: ones a cover can be embedded in.
EMBEDDABLE_SUFFIXES = frozenset({".mp4", ".m4v", ".mov"})
#: Appended to the video's name for the working copy :func:`embed_cover` edits.
EMBED_SUFFIX = ".embed.part"
#: The image kinds :func:`image_kind` tells apart, with the extension each is saved under and its
#: MIME type.
EXTENSIONS = {"jpeg": ".jpg", "png": ".png", "webp": ".webp"}
MIME_TYPES = {"jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
#: Content types a cover may come with, for bodies whose bytes carry no known magic.
_CONTENT_TYPES = {
    "image/jpeg": "jpeg",
    "image/jpg": "jpeg",
    "image/pjpeg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
}
_JPEG_MAGIC = b"\xff\xd8\xff"
_PNG_MAGIC = b"\x89PNG"
_RIFF_MAGIC = b"RIFF"
_WEBP_MAGIC = b"WEBP"  # bytes 8-12 of a RIFF container
#: The ``covr`` atom's data types (mutagen's ``MP4Cover.FORMAT_JPEG`` / ``FORMAT_PNG``): the only
#: two image formats the atom is defined for — a WEBP cannot live in it.
_COVER_FORMATS = {"jpeg": 13, "png": 14}
_KINDS_BY_FORMAT = {13: "jpeg", 14: "png"}
_MIB = 1024 * 1024
_MAX_REASON_LEN = 200


def image_kind(data: bytes, content_type: str = "") -> str | None:
    """``"jpeg"``, ``"png"`` or ``"webp"`` for an image body, else None.

    The bytes decide: JPEG (``FF D8 FF``), PNG (``89 'PNG'``) or WEBP (a ``RIFF`` container with
    ``WEBP`` at offset 8) magic. Only when they carry none of the three does ``content_type``
    count — ``image/jpeg`` and its aliases, ``image/png`` and ``image/webp`` name the kind, and any
    other ``image/*`` type is taken for a JPEG, so that an image the sniffer does not know is still
    saved (as ``.jpg``; embedding re-sniffs the bytes alone and refuses it). Size is not judged
    here (see :data:`MIN_IMAGE_BYTES` and :data:`MAX_COVER_BYTES`).
    """
    if data.startswith(_JPEG_MAGIC):
        return "jpeg"
    if data.startswith(_PNG_MAGIC):
        return "png"
    if data.startswith(_RIFF_MAGIC) and data[8:12] == _WEBP_MAGIC:
        return "webp"
    kind = content_type.split(";")[0].strip().lower()
    if kind in _CONTENT_TYPES:
        return _CONTENT_TYPES[kind]
    if kind.startswith("image/"):
        return "jpeg"
    return None


def extension_for(kind: str) -> str:
    """``".jpg"``, ``".png"`` or ``".webp"`` for a kind :func:`image_kind` returned."""
    try:
        return EXTENSIONS[kind]
    except KeyError:
        raise ValueError(f"unknown image kind {kind!r}") from None


def mime_type_for(kind: str) -> str:
    """``"image/jpeg"``, ``"image/png"`` or ``"image/webp"`` for a kind :func:`image_kind` gave."""
    try:
        return MIME_TYPES[kind]
    except KeyError:
        raise ValueError(f"unknown image kind {kind!r}") from None


def image_problem(data: bytes, content_type: str = "") -> str:
    """Why a 200 answer is not a cover: too small, or neither an image type nor image bytes."""
    kind = content_type.split(";")[0].strip().lower() or "an untyped body"
    if len(data) < MIN_IMAGE_BYTES:
        return f"{format_size(len(data))} of {kind} instead of an image"
    return f"{kind} instead of an image"


def format_size(size: int) -> str:
    """``1536`` -> ``"1.5 KiB"``; MiB from one mebibyte up, plain bytes under one kibibyte."""
    if size >= _MIB:
        return f"{size / _MIB:.1f} MiB"
    if size >= 1024:
        return f"{size / 1024:.1f} KiB"
    return f"{size} bytes"


def cover_sidecar(video: Path) -> Path | None:
    """The cover file next to a video: the first existing ``<stem>.jpg|.jpeg|.png|.webp``."""
    if not video.name:
        return None
    for suffix in COVER_SUFFIXES:
        candidate = video.with_suffix(suffix)
        if candidate.is_file():
            return candidate
    return None


def embed_cover(video: Path, image: bytes) -> None:
    """Write ``image`` into ``video`` as its cover art (the MP4 ``covr`` atom).

    Raises :class:`~dramafetch.errors.ThumbnailError` — with a message fit for the result line —
    when ``video`` is not an MP4 container (``.mp4``, ``.m4v``, ``.mov``), when ``image`` is not
    a JPEG or a PNG (a WEBP cannot live in a ``covr`` atom), when it exceeds
    :data:`MAX_COVER_BYTES`, when mutagen is not importable, or when mutagen fails. The video is
    never touched in place: a copy named ``<name>.embed.part`` in the same directory gets the cover
    and then replaces the original atomically (``os.replace``); on any failure the copy is deleted
    and the original is left exactly as it was.
    """
    suffix = video.suffix.lower()
    if suffix not in EMBEDDABLE_SUFFIXES:
        raise ThumbnailError(f"{suffix or 'a file without extension'} is not an MP4 container")
    kind = image_kind(image)
    if kind == "webp":
        raise ThumbnailError("webp cannot be embedded")
    if kind not in _COVER_FORMATS:
        raise ThumbnailError("not a JPEG or PNG image")
    if len(image) > MAX_COVER_BYTES:
        raise ThumbnailError(
            f"{len(image):,} bytes is above the {MAX_COVER_BYTES // _MIB} MiB cover limit"
        )
    try:
        from mutagen.mp4 import MP4, MP4Cover  # lazy: see the module docstring
    except ImportError as exc:
        raise ThumbnailError("mutagen is not installed: pip install mutagen") from exc
    image_format = MP4Cover.FORMAT_JPEG if kind == "jpeg" else MP4Cover.FORMAT_PNG
    copy = video.with_name(video.name + EMBED_SUFFIX)
    try:
        shutil.copy2(video, copy)
        # mutagen ships type hints, but FileType.__init__ and add_tags() are unannotated.
        tagged = MP4(copy)  # type: ignore[no-untyped-call]
        if tagged.tags is None:
            tagged.add_tags()  # type: ignore[no-untyped-call]
        tags = tagged.tags
        assert tags is not None  # add_tags() created them; stated for the type checker
        tags["covr"] = [MP4Cover(image, imageformat=image_format)]
        tagged.save()
        copy.replace(video)  # os.replace: atomic, same directory, same file system
    except BaseException as exc:
        copy.unlink(missing_ok=True)
        if not isinstance(exc, Exception):  # KeyboardInterrupt and friends: cleaned up, not ours
            raise
        raise ThumbnailError(
            f"could not write the cover into {video.name} ({_describe(exc)})"
        ) from exc


def extract_cover(video: Path) -> tuple[bytes, str] | None:
    """The cover embedded in ``video`` as ``(bytes, mime type)`` — ``"image/jpeg"`` or
    ``"image/png"`` — or None. Never raises: None for a file that is not an MP4 container, is
    missing, has no tags or no ``covr`` atom, whose first cover is not a JPEG or a PNG, is empty
    or exceeds :data:`MAX_COVER_BYTES`, and when mutagen is missing or fails. The bytes decide the
    kind (:func:`image_kind`); the atom's declared format (13 JPEG, 14 PNG) counts only for bytes
    without a known magic. Only the first ``covr`` entry is looked at."""
    if video.suffix.lower() not in EMBEDDABLE_SUFFIXES or not video.is_file():
        return None
    try:
        from mutagen.mp4 import MP4  # lazy: see the module docstring

        tags = MP4(video).tags  # type: ignore[no-untyped-call]  # unannotated __init__
    except Exception as exc:
        log.debug("no cover read from %s: %s", video.name, _describe(exc))
        return None
    covers = tags.get("covr") if tags is not None else None
    if not covers:
        return None
    first = covers[0]
    data = bytes(first)
    if not data or len(data) > MAX_COVER_BYTES:
        return None
    declared = _KINDS_BY_FORMAT.get(int(getattr(first, "imageformat", 0)))
    kind = image_kind(data) or declared
    if kind not in _COVER_FORMATS:
        return None
    return data, MIME_TYPES[kind]


def has_embedded_cover(video: Path) -> bool:
    """Whether :func:`extract_cover` finds a cover in ``video`` (the web UI's ``thumbnail``)."""
    return extract_cover(video) is not None


def _describe(exc: BaseException) -> str:
    """``ClassName: first line`` of an exception (the class name alone when it has no text), cut to
    200 characters. mutagen and OS errors name files at most, never cookies or tokens."""
    text = str(exc).strip()
    first = text.splitlines()[0].strip() if text else ""
    described = f"{exc.__class__.__name__}: {first}" if first else exc.__class__.__name__
    if len(described) > _MAX_REASON_LEN:
        described = described[: _MAX_REASON_LEN - 1] + "…"
    return described
