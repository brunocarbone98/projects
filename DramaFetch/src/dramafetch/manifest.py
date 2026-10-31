"""Output layout and the resumable per-series manifest (``dramafetch.json``).

Layout: ``<out_dir>/<series name> [<series id>]/E01 - <title>.mp4`` with the manifest next to the
videos. The manifest records one entry per episode number (status, file, message, timestamp) so a
rerun skips what is already on disk and retries the rest; it never contains cookies or URLs with
tokens. Writes are atomic (temp file + replace) so a Ctrl+C mid-run leaves a valid file.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from dramafetch.models import DownloadResult, Episode, Series

log = logging.getLogger(__name__)

MANIFEST_FILENAME = "dramafetch.json"
MANIFEST_VERSION = 1

_RESERVED_CHARS_RE = re.compile(r'[<>:"/\\|?*]')
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
_WHITESPACE_RE = re.compile(r"\s+")
_WINDOWS_RESERVED_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
)


def safe_filename(text: str, max_len: int = 80) -> str:
    """A file-system-safe name on Linux, macOS and Windows; never empty (``"untitled"``).

    Path separators and the Windows-reserved characters ``<>:"/\\|?*`` become spaces, control
    characters are dropped, whitespace is collapsed, trailing dots and spaces are removed (also
    after truncating to ``max_len``), and Windows device names (``CON``, ``COM1``...) get a ``_``.
    """
    cleaned = _CONTROL_CHARS_RE.sub("", text)
    cleaned = _RESERVED_CHARS_RE.sub(" ", cleaned)
    cleaned = _WHITESPACE_RE.sub(" ", cleaned).strip()
    if max_len > 0 and len(cleaned) > max_len:
        cleaned = cleaned[:max_len]
    cleaned = cleaned.rstrip(" .")
    if not cleaned:
        return "untitled"
    if cleaned.split(".")[0].upper() in _WINDOWS_RESERVED_NAMES:
        cleaned += "_"
    return cleaned


def series_dir(out_dir: Path, series: Series) -> Path:
    """``out_dir / "<series name> [<series id>]"`` — the id keeps renamed series apart."""
    return out_dir / f"{safe_filename(series.display_name)} [{series.series_id}]"


def episode_stem(episode: Episode) -> str:
    """``E01 - <title>`` (three digits from episode 100 on); the extension comes from yt-dlp."""
    return f"E{episode.number:02d} - {safe_filename(episode.title, 60)}"


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

        {"version": 1, "series_id": "...", "series_name": "...", "episodes": {"1": {...}}}
    """

    def __init__(self, path: Path, series_id: str, series_name: str | None) -> None:
        self.path = manifest_path(path) if path.is_dir() else path
        self.series_id = str(series_id)
        self.series_name = series_name
        self.entries: dict[int, ManifestEntry] = {}

    @classmethod
    def load(cls, path: Path, series_id: str, series_name: str | None) -> Manifest:
        """Read the manifest; a missing file gives an empty manifest, a corrupt or foreign one is
        moved to ``dramafetch.json.bak`` and an empty manifest is returned."""
        manifest = cls(path, series_id, series_name)
        try:
            text = manifest.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return manifest
        except OSError as exc:
            log.warning("could not read %s: %s", manifest.path, exc)
            return manifest
        parsed = _parse_manifest(text, manifest.series_id)
        if parsed is None:
            _keep_backup(manifest.path)
            return manifest
        stored_name, entries = parsed
        if manifest.series_name is None:
            manifest.series_name = stored_name
        manifest.entries = entries
        return manifest

    def save(self) -> None:
        """Atomic write: temp file in the same directory, then ``replace``. Sorted keys, indent 2."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data: dict[str, Any] = {
            "version": MANIFEST_VERSION,
            "series_id": self.series_id,
            "series_name": self.series_name,
            "episodes": {str(n): asdict(entry) for n, entry in sorted(self.entries.items())},
        }
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
        """The downloaded file of an episode when the manifest says done and the file still exists."""
        entry = self.entries.get(number)
        if entry is None or entry.status != "done" or not entry.path:
            return None
        path = self.resolve_path(entry.path)
        return path if path.exists() else None

    def is_done(self, number: int) -> bool:
        """True when the episode was recorded as done AND the recorded file is still there."""
        return self.done_path(number) is not None

    def record(self, result: DownloadResult) -> None:
        """Store one result (replacing any earlier entry for the number) and save immediately."""
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


def _relative_or_absolute(path: Path, base: Path) -> str:
    try:
        return str(path.resolve().relative_to(base.resolve()))
    except (ValueError, OSError):
        return str(path)


def _parse_manifest(text: str, series_id: str) -> tuple[str | None, dict[int, ManifestEntry]] | None:
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
    return name, entries


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
