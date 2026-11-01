"""Output layout and the resumable per-series manifest (``dramafetch.json``).

Layout: ``<out_dir>/<series name> [<series id>]/<series name> - Episode 01.mp4`` (the episode
cover, when saved, sits next to it as ``<same stem>.jpg``) with the manifest next to the videos.
The file name comes from ``DownloadOptions.name_format`` (see :func:`episode_stem`; the default is
``models.DEFAULT_NAME_FORMAT``). The manifest records one entry per episode number (status, file,
message, timestamp) so a rerun skips what is already on disk and retries the rest, whatever name
format the run uses; it never contains cookies or URLs with tokens. Writes are atomic (temp file +
replace) so a Ctrl+C mid-run leaves a valid file. It also remembers when the series was last found
complete (``complete_at``, ``complete_episodes``): ``engine.run_series`` skips such a series without
a request for ``models.RECHECK_AFTER_S``, and any new attempt (a result that is not a skip) forgets
it. :func:`read_manifest` reads a manifest without any side effect (``Manifest.load`` moves a
corrupt file aside).
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from dramafetch.models import (
    DRM_MARK,
    DownloadOptions,
    DownloadResult,
    DownloadStatus,
    Episode,
    Series,
)

log = logging.getLogger(__name__)

MANIFEST_FILENAME = "dramafetch.json"
MANIFEST_VERSION = 1
#: The placeholders a name format may use (in braces); anything else in braces is refused.
NAME_PLACEHOLDERS = ("series", "number", "n", "title", "id")
#: Placeholders that tell one episode from another. A format needs at least one of them: with
#: ``"{series}"`` alone every episode of a series would get the same file name, and every episode
#: after the first would be skipped as already existing.
_EPISODE_PLACEHOLDERS = frozenset({"number", "n", "title", "id"})
_PLACEHOLDER_RE = re.compile(r"\{([^{}]*)\}")
#: Longest file stem produced from a name format; the extension comes on top.
MAX_STEM_LEN = 150
# Results that mean "nothing was attempted"; they never overwrite the memory of a finished download.
_NON_ATTEMPT_STATUSES = frozenset(
    {DownloadStatus.SKIPPED_EXISTS, DownloadStatus.SKIPPED_LOCKED, DownloadStatus.DRY_RUN}
)
#: Entry statuses that mean "the episode's file is on disk": downloaded (``done``), or found already
#: there by a run (``skipped-exists`` with the file it found).
_ON_DISK_STATUSES = frozenset({DownloadStatus.DONE.value, DownloadStatus.SKIPPED_EXISTS.value})
#: Entry statuses that carry a DRM verdict when their message starts with ``models.DRM_MARK``: the
#: download was encrypted (``failed-unavailable``), or a later run skipped it for that reason or
#: because the payload itself says DRM (``skipped-locked``).
_DRM_STATUSES = frozenset(
    {DownloadStatus.FAILED_UNAVAILABLE.value, DownloadStatus.SKIPPED_LOCKED.value}
)

_RESERVED_CHARS_RE = re.compile(r'[<>:"/\\|?*]')
# C0 controls except \t \n \v \f \r (those are whitespace and become spaces), plus DEL.
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0e-\x1f\x7f]")
_WHITESPACE_RE = re.compile(r"\s+")
_WINDOWS_RESERVED_NAMES = frozenset(
    {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        "CONIN$",
        "CONOUT$",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }
)


def safe_filename(text: str, max_len: int = 80) -> str:
    """A file-system-safe name on Linux, macOS and Windows; never empty (``"untitled"``).

    Path separators and the Windows-reserved characters ``<>:"/\\|?*`` become spaces, control
    characters are dropped, whitespace is collapsed, trailing dots and spaces are removed (also
    after truncating to ``max_len``), and a Windows device name (``CON``, ``COM1``...) gets a ``_``
    appended to the device-name segment itself: Windows reserves ``com1.txt`` and ``Aux. Stories``
    as much as ``COM1``, so ``com1_.txt`` and ``Aux_. Stories`` are the usable forms.
    """
    cleaned = _CONTROL_CHARS_RE.sub("", text)
    cleaned = _RESERVED_CHARS_RE.sub(" ", cleaned)
    cleaned = _WHITESPACE_RE.sub(" ", cleaned).strip()
    if max_len > 0 and len(cleaned) > max_len:
        cleaned = cleaned[:max_len]
    cleaned = cleaned.rstrip(" .")
    if not cleaned:
        return "untitled"
    head, dot, tail = cleaned.partition(".")
    if head.rstrip().upper() in _WINDOWS_RESERVED_NAMES:
        cleaned = f"{head.rstrip()}_{dot}{tail}"
    return cleaned


def series_dir(out_dir: Path, series: Series) -> Path:
    """``out_dir / "<series name> [<series id>]"`` — the id keeps renamed series apart."""
    return out_dir / f"{safe_filename(series.display_name)} [{series.series_id}]"


def validate_name_format(name_format: str) -> None:
    """Raise ValueError when ``name_format`` cannot name episodes.

    Refused: a placeholder outside :data:`NAME_PLACEHOLDERS` (``{number:02d}`` included — the
    padding is built in), a brace that does not close a placeholder, and a format without any of
    ``{number}``, ``{n}``, ``{title}`` or ``{id}`` — it would give every episode the same name.
    """
    allowed = ", ".join(f"{{{name}}}" for name in NAME_PLACEHOLDERS)
    found = _PLACEHOLDER_RE.findall(name_format)
    for name in found:
        if name not in NAME_PLACEHOLDERS:
            raise ValueError(
                f"unknown placeholder {{{name}}} in name format {name_format!r}: use {allowed}"
            )
    leftover = _PLACEHOLDER_RE.sub("", name_format)
    if "{" in leftover or "}" in leftover:
        raise ValueError(
            f"unmatched brace in name format {name_format!r}: placeholders are {allowed}"
        )
    if not _EPISODE_PLACEHOLDERS.intersection(found):
        raise ValueError(
            f"name format {name_format!r} does not tell episodes apart: use at least one of "
            "{number}, {n}, {title} or {id}"
        )


def episode_stem(episode: Episode, options: DownloadOptions) -> str:
    """The file name of an episode without its extension, from ``options.name_format``.

    The placeholders are replaced one by one (never ``str.format``: a format is user input and
    must not reach attributes or indexes): ``{series}`` is ``options.series_name``, else the
    episode's own series name, else ``series-<series id>`` (``video`` for a bare video), cut to 80
    safe characters; ``{number}`` is the episode number zero-padded to two digits (``01``, ``100``)
    and ``{n}`` the bare number; ``{title}`` is the title cut to 60 safe characters; ``{id}`` the
    TikTok item id. The whole stem then goes through :func:`safe_filename` (150 characters), so a
    series called ``CON`` or a format ending in a dot stays harmless on Windows. The default,
    ``"{series} - Episode {number}"``, gives ``The Billionaire's Secret Heiress - Episode 01``.
    Raises ValueError for an unusable format (see :func:`validate_name_format`).
    """
    validate_name_format(options.name_format)
    if options.series_name:
        series = options.series_name
    elif episode.series_name:
        series = episode.series_name
    elif episode.series_id:
        series = f"series-{episode.series_id}"
    else:
        series = "video"
    values = {
        "series": safe_filename(series, 80),
        "number": f"{episode.number:02d}",
        "n": str(episode.number),
        "title": safe_filename(episode.title, 60),
        "id": episode.item_id,
    }
    stem = _PLACEHOLDER_RE.sub(lambda match: values[match.group(1)], options.name_format)
    return safe_filename(stem, MAX_STEM_LEN)


def manifest_path(directory: Path) -> Path:
    """Where the manifest of a series directory lives."""
    return directory / MANIFEST_FILENAME


@dataclass
class ManifestEntry:
    """One recorded episode outcome. ``path`` is relative to the manifest's directory when the
    file lives inside it (so the folder can be moved), ``updated_at`` is ISO 8601 UTC."""

    number: int
    item_id: str
    status: str
    path: str | None
    message: str
    updated_at: str


class Manifest:
    """The ``dramafetch.json`` of one series directory.

    Format::

        {"version": 1, "series_id": "...", "series_name": "...", "episodes": {"1": {...}},
         "complete_at": "2026-11-01T05:00:00Z", "complete_episodes": 30}

    ``complete_at`` / ``complete_episodes`` are optional (written only while set): when a run
    last found the series complete and how many episodes were on disk then (:meth:`mark_complete`).
    """

    def __init__(self, path: Path, series_id: str, series_name: str | None) -> None:
        self.path = manifest_path(path) if path.is_dir() else path
        self.series_id = str(series_id)
        self.series_name = series_name
        self.entries: dict[int, ManifestEntry] = {}
        self.complete_at: str | None = None
        self.complete_episodes: int | None = None

    @classmethod
    def load(cls, path: Path, series_id: str, series_name: str | None) -> Manifest:
        """Read the manifest; a missing file gives an empty manifest, a corrupt or foreign one is
        moved to ``dramafetch.json.bak`` and an empty manifest is returned."""
        manifest = cls(path, series_id, series_name)
        try:
            text = manifest.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return manifest
        except UnicodeDecodeError:  # not UTF-8: as corrupt as bad JSON
            _keep_backup(manifest.path)
            return manifest
        except OSError as exc:
            log.warning("could not read %s: %s", manifest.path, exc)
            return manifest
        parsed = _parse_manifest(text, manifest.series_id)
        if parsed is None:
            _keep_backup(manifest.path)
            return manifest
        _apply(manifest, parsed)
        return manifest

    def save(self) -> None:
        """Atomic write (temp file in the same directory, then ``replace``); sorted keys."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data: dict[str, Any] = {
            "version": MANIFEST_VERSION,
            "series_id": self.series_id,
            "series_name": self.series_name,
            "episodes": {str(n): asdict(entry) for n, entry in sorted(self.entries.items())},
        }
        if self.complete_at is not None:
            data["complete_at"] = self.complete_at
            data["complete_episodes"] = self.complete_episodes
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(
            json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        tmp.replace(self.path)

    def resolve_path(self, recorded: str) -> Path:
        """Absolute path of a recorded file (relative entries are anchored at the manifest dir)."""
        path = Path(recorded)
        return path if path.is_absolute() else self.path.parent / path

    def done_path(self, number: int) -> Path | None:
        """The episode's file when the manifest says done and the file still exists."""
        entry = self.entries.get(number)
        if entry is None or entry.status != "done" or not entry.path:
            return None
        path = self.resolve_path(entry.path)
        return path if path.exists() else None

    def is_done(self, number: int) -> bool:
        """True when the episode was recorded as done AND the recorded file is still there."""
        return self.done_path(number) is not None

    def done_entries(self) -> list[tuple[int, Path]]:
        """``(number, file)`` for every episode the manifest knows to be on disk — a ``done``
        entry, or a ``skipped-exists`` entry with the file a run found already there — whose file
        still exists, ascending by number."""
        found: list[tuple[int, Path]] = []
        for number, entry in sorted(self.entries.items()):
            if entry.status not in _ON_DISK_STATUSES or not entry.path:
                continue
            path = self.resolve_path(entry.path)
            if path.exists():
                found.append((number, path))
        return found

    def missing_files(self) -> list[int]:
        """Numbers of the entries :meth:`done_entries` would count whose file is gone (deleted or
        moved since): a series with any of them is not complete any more."""
        return [
            number
            for number, entry in sorted(self.entries.items())
            if entry.status in _ON_DISK_STATUSES
            and entry.path
            and not self.resolve_path(entry.path).exists()
        ]

    def locked_numbers(self) -> list[int]:
        """Numbers of the entries recorded ``skipped-locked`` (an episode a run listed and skipped
        as locked, or as protected by DRM), ascending. Read-only: what the complete skip reports
        as still locked."""
        return [
            number
            for number, entry in sorted(self.entries.items())
            if entry.status == DownloadStatus.SKIPPED_LOCKED.value
        ]

    def drm_protected(self, number: int) -> bool:
        """True when an earlier run found the episode protected by DRM: its entry is
        ``failed-unavailable`` or ``skipped-locked`` and its message starts with
        ``models.DRM_MARK``. Retrying does not change that verdict, so ``engine.download_series``
        skips such an episode without a request unless ``include_locked``."""
        entry = self.entries.get(number)
        return (
            entry is not None
            and entry.status in _DRM_STATUSES
            and entry.message.startswith(DRM_MARK)
        )

    def mark_complete(self, when: float, episodes: int) -> None:
        """Remember that a run found the series complete at ``when`` (seconds since the epoch)
        with ``episodes`` episodes on disk, and save. Cleared by the next :meth:`record` of a
        result that is not a skip."""
        self.complete_at = _iso_utc(when)
        self.complete_episodes = int(episodes)
        self.save()

    def clear_complete(self) -> None:
        """Forget that the series was complete (a whole run found it incomplete) and save."""
        if self.complete_at is None and self.complete_episodes is None:
            return
        self.complete_at = None
        self.complete_episodes = None
        self.save()

    def complete_since(self) -> float | None:
        """``complete_at`` as seconds since the epoch, None when unset or unreadable."""
        if self.complete_at is None:
            return None
        return _epoch_of(self.complete_at)

    def record(self, result: DownloadResult) -> None:
        """Store one result (replacing any earlier entry for the number) and save immediately.

        Exception: a skip or a dry run never downgrades a ``done`` entry whose file still exists.
        Resumed runs report those episodes as ``skipped-exists``, and the manifest must keep
        remembering that they were downloaded, or the third run would forget the first.
        """
        if result.status in _NON_ATTEMPT_STATUSES and self.is_done(result.episode.number):
            return
        if result.status not in _NON_ATTEMPT_STATUSES:
            # A new attempt means the series changed (a new episode, a failure, an overwrite): it
            # has to be found complete again before a run may skip it.
            self.complete_at = None
            self.complete_episodes = None
        recorded_path: str | None = None
        if result.path is not None:
            recorded_path = _relative_or_absolute(result.path, self.path.parent)
        self.entries[result.episode.number] = ManifestEntry(
            number=result.episode.number,
            item_id=result.episode.item_id,
            status=str(result.status.value),
            path=recorded_path,
            message=result.message,
            updated_at=utc_now_iso(),
        )
        self.save()


def utc_now_iso() -> str:
    """Current time as ``YYYY-MM-DDTHH:MM:SSZ``."""
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _iso_utc(when: float) -> str:
    """``when`` (seconds since the epoch) as ``YYYY-MM-DDTHH:MM:SSZ``, the fraction dropped."""
    moment = datetime.fromtimestamp(when, UTC).replace(microsecond=0)
    return moment.isoformat().replace("+00:00", "Z")


def _epoch_of(text: str) -> float | None:
    """Seconds since the epoch of an ISO 8601 time written by :func:`_iso_utc` (any offset is
    honoured, a naive time is taken as UTC); None for anything unreadable."""
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.timestamp()


def read_manifest(directory: Path, series_id: str) -> Manifest | None:
    """The manifest of a series directory, read without any side effect: None when there is no
    ``dramafetch.json``, or it is unreadable, corrupt or another series' — and, unlike
    :meth:`Manifest.load`, a corrupt file is left exactly where it is (never moved to ``.bak``).
    Used by the complete skip, ``info``'s ``disk`` column and the web's on-disk badges."""
    path = manifest_path(directory)
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    parsed = _parse_manifest(text, str(series_id))
    if parsed is None:
        return None
    manifest = Manifest(path, str(series_id), None)
    _apply(manifest, parsed)
    return manifest


def _relative_or_absolute(path: Path, base: Path) -> str:
    try:
        return str(path.resolve().relative_to(base.resolve()))
    except (ValueError, OSError):
        return str(path)


@dataclass
class _Parsed:
    """What a valid ``dramafetch.json`` holds (see :func:`_parse_manifest`)."""

    series_name: str | None
    entries: dict[int, ManifestEntry]
    complete_at: str | None
    complete_episodes: int | None


def _apply(manifest: Manifest, parsed: _Parsed) -> None:
    if manifest.series_name is None:
        manifest.series_name = parsed.series_name
    manifest.entries = parsed.entries
    manifest.complete_at = parsed.complete_at
    manifest.complete_episodes = parsed.complete_episodes


def _parse_manifest(text: str, series_id: str) -> _Parsed | None:
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("version") != MANIFEST_VERSION:
        return None
    if str(data.get("series_id")) != series_id:
        return None
    episodes = data.get("episodes")
    if not isinstance(episodes, dict):
        return None
    stored_name = data.get("series_name")
    name = stored_name if isinstance(stored_name, str) and stored_name else None
    entries: dict[int, ManifestEntry] = {}
    for key, value in episodes.items():
        entry = _parse_entry(key, value)
        if entry is not None:
            entries[entry.number] = entry
    # The completeness memory is optional and never makes a manifest corrupt: an odd value is
    # simply forgotten (the next complete run writes it again).
    complete_at = data.get("complete_at")
    complete_episodes = data.get("complete_episodes")
    if not isinstance(complete_at, str) or _epoch_of(complete_at) is None:
        complete_at = None
    if (
        complete_at is None
        or isinstance(complete_episodes, bool)
        or not isinstance(complete_episodes, int)
        or complete_episodes < 0
    ):
        complete_at, complete_episodes = None, None
    return _Parsed(name, entries, complete_at, complete_episodes)


def _parse_entry(key: Any, value: Any) -> ManifestEntry | None:
    try:
        number = int(key)
    except (TypeError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    status = value.get("status")
    if not isinstance(status, str):
        return None
    path = value.get("path")
    message = value.get("message")
    updated_at = value.get("updated_at")
    return ManifestEntry(
        number=number,
        item_id=str(value.get("item_id", "")),
        status=status,
        path=path if isinstance(path, str) and path else None,
        message=message if isinstance(message, str) else "",
        updated_at=updated_at if isinstance(updated_at, str) else "",
    )


def _keep_backup(path: Path) -> None:
    backup = path.with_name(path.name + ".bak")
    try:
        path.replace(backup)
        log.warning("manifest %s was unreadable; kept a copy at %s", path, backup)
    except OSError as exc:
        log.warning("manifest %s was unreadable and could not be backed up: %s", path, exc)
