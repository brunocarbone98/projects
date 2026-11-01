"""The global TikTok cooldown: after a refusal (HTTP 403, HTTP 429, a captcha page) DramaFetch
refuses to contact TikTok again for :data:`COOLDOWN_MINUTES`, from the CLI and the web alike.

Knocking again right after a refusal is what makes TikTok's protections escalate, so the rule has
no flag that skips it. The cooldown is one small JSON file — ``{"until": <epoch float>,
"reason": str, "source": str, "recorded_at": <epoch float>}`` — named ``cooldown.json`` in the
state directory (``$DRAMAFETCH_STATE_DIR``, default ``~/.dramafetch``), written atomically.
Deleting that file is the only way to lift the cooldown early. Reading never raises: a missing,
unreadable or corrupt file counts as no cooldown. Nothing here contains cookies or tokens; the
reason is a printable message that already passed through the engines' sanitising.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

#: How long DramaFetch refuses to contact TikTok after a refusal.
COOLDOWN_MINUTES = 30
#: Environment variable naming the state directory; tests point it at ``tmp_path``.
STATE_DIR_ENV = "DRAMAFETCH_STATE_DIR"
#: The state directory under the home directory when :data:`STATE_DIR_ENV` is not set.
DEFAULT_STATE_DIR_NAME = ".dramafetch"
#: The cooldown file inside the state directory.
COOLDOWN_FILE_NAME = "cooldown.json"
#: Where a block can be recorded from (informative; stored as given, never validated).
COOLDOWN_SOURCES = ("yt-dlp", "browser", "discovery", "web")
_MAX_REASON_LEN = 200
_WHITESPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class Cooldown:
    """A recorded refusal: TikTok is not contacted again before ``until`` (seconds since the epoch).

    ``source`` is where the refusal was met: ``"yt-dlp"``, ``"browser"``, ``"discovery"`` or
    ``"web"``. ``recorded_at`` is when it was met (None for a cooldown built by hand).
    """

    until: float
    reason: str
    source: str
    recorded_at: float | None = None

    @property
    def started(self) -> float:
        """When TikTok refused: ``recorded_at`` when known, else ``until`` minus the default."""
        if self.recorded_at is not None:
            return self.recorded_at
        return self.until - COOLDOWN_MINUTES * 60

    def seconds_left(self, now: float | None = None) -> int:
        """Whole seconds until the cooldown ends (0 once it has), e.g. for a ``Retry-After``."""
        current = time.time() if now is None else now
        return max(0, math.ceil(self.until - current))

    def minutes_left(self, now: float | None = None) -> int:
        """Whole minutes until the cooldown ends, rounded up (0 once it has)."""
        return math.ceil(self.seconds_left(now) / 60)

    def active(self, now: float | None = None) -> bool:
        current = time.time() if now is None else now
        return self.until > current


def state_dir() -> Path:
    """The state directory: ``$DRAMAFETCH_STATE_DIR`` when set, else ``~/.dramafetch``."""
    raw = os.environ.get(STATE_DIR_ENV, "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path.home() / DEFAULT_STATE_DIR_NAME


def cooldown_path() -> Path:
    """The cooldown file (``<state dir>/cooldown.json``); deleting it lifts the cooldown."""
    return state_dir() / COOLDOWN_FILE_NAME


def record_block(
    reason: str, source: str, *, now: float | None = None, minutes: int = COOLDOWN_MINUTES
) -> Cooldown:
    """Record a refusal: TikTok is not contacted again for ``minutes`` from ``now``.

    A newer refusal replaces an older cooldown (the window restarts). The file is written
    atomically (``cooldown.json.tmp`` then ``os.replace``); when it cannot be written the cooldown
    is still returned and the problem is logged — the run is already stopping.
    """
    recorded_at = time.time() if now is None else now
    cooldown = Cooldown(
        until=recorded_at + minutes * 60,
        reason=_clean_reason(reason),
        source=str(source),
        recorded_at=recorded_at,
    )
    payload = {
        "until": cooldown.until,
        "reason": cooldown.reason,
        "source": cooldown.source,
        "recorded_at": recorded_at,
    }
    path = cooldown_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        log.warning("could not write the cooldown file %s: %s", path, exc)
    return cooldown


def read_cooldown() -> Cooldown | None:
    """The stored cooldown, active or expired; None when there is none or the file is missing,
    unreadable or not the expected JSON. Never raises."""
    path = cooldown_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):  # missing/unreadable file, bad JSON, bad UTF-8
        return None
    if not isinstance(raw, dict):
        return None
    until = _as_epoch(raw.get("until"))
    if until is None:
        return None
    reason = raw.get("reason")
    source = raw.get("source")
    return Cooldown(
        until=until,
        reason=_clean_reason(reason) if isinstance(reason, str) else "",
        source=source if isinstance(source, str) else "",
        recorded_at=_as_epoch(raw.get("recorded_at")),
    )


def active_cooldown(*, now: float | None = None) -> Cooldown | None:
    """The cooldown in force at ``now`` (default: the current time), None when there is none or it
    has expired. Never raises: a corrupt or unreadable file counts as no cooldown."""
    cooldown = read_cooldown()
    if cooldown is None or not cooldown.active(now):
        return None
    return cooldown


def clear_cooldown() -> None:
    """Lift the cooldown by deleting its file (nothing to do when there is none)."""
    cooldown_path().unlink(missing_ok=True)


def clock_time(epoch: float) -> str:
    """``HH:MM`` in local time for a moment in seconds since the epoch."""
    return time.strftime("%H:%M", time.localtime(epoch))


def cooldown_summary(cooldown: Cooldown, *, now: float | None = None) -> str:
    """``until HH:MM (N min left): <reason>`` — the ``doctor`` line and status displays."""
    left = cooldown.minutes_left(now)
    return f"until {clock_time(cooldown.until)} ({left} min left): {cooldown.reason}"


def cooldown_message(cooldown: Cooldown, *, now: float | None = None) -> str:
    """The full explanation the CLI prints and the web UI returns, naming the file to delete."""
    return (
        f"TikTok refused a request at {clock_time(cooldown.started)} ({cooldown.reason}); "
        f"DramaFetch waits until {clock_time(cooldown.until)} "
        f"({cooldown.minutes_left(now)} min left) before contacting TikTok again "
        f"— delete {cooldown_path()} to lift it, at your own risk"
    )


def _clean_reason(reason: str) -> str:
    text = _WHITESPACE_RE.sub(" ", str(reason)).strip()
    if not text:
        return "request refused"
    if len(text) > _MAX_REASON_LEN:
        return text[: _MAX_REASON_LEN - 1] + "…"
    return text


def _as_epoch(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) else None
