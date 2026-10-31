"""Background download jobs for the web UI.

A job is one call to ``engine.download_series`` (or any injected runner with the same shape) for a
resolved series and a selection of its episodes. Every job gets its own worker thread, but only ONE
job downloads at a time: TikTok rate-limits aggressively and the engine already paces episodes, so
queued jobs wait their turn in FIFO order. ``get()`` returns a JSON-ready snapshot that the page
polls every couple of seconds; the engine's ``on_result`` callback updates it after each episode.
Nothing in this module touches the network itself, and nothing in a snapshot can contain a cookie:
error messages are redacted defensively before they are stored.
"""

from __future__ import annotations

import logging
import re
import threading
import uuid
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from dramafetch.models import DownloadOptions, DownloadResult, Episode, Series

log = logging.getLogger(__name__)

#: ``runner(series, episodes, options, on_result=callback) -> results`` — the shape of
#: :func:`dramafetch.engine.download_series`; tests inject an instant fake.
Runner = Callable[..., list[DownloadResult]]

QUEUED = "queued"
RUNNING = "running"
DONE = "done"
ERROR = "error"
FINISHED_STATES = frozenset({DONE, ERROR})

# Anything that looks like `sessionid=...`, `Cookie: ...` or `msToken=...` in a message is blanked.
# The engine never puts cookie values in messages, but a snapshot is shown in a browser, so a cheap
# second line of defence costs nothing.
_SECRET_RE = re.compile(
    r"(?i)\b(sessionid|sid_tt|sid_guard|ssid_ucp_v1|msToken|tt_csrf_token|passport_csrf_token|"
    r"cookies?)\b\s*[=:]\s*[^\s;,]+"
)
_MAX_ERROR_CHARS = 500


def redact_secrets(text: str) -> str:
    """Blank the value after a cookie-like name: ``sessionid=abc`` -> ``sessionid=<redacted>``."""
    return _SECRET_RE.sub(lambda match: f"{match.group(1)}=<redacted>", text)


def result_to_dict(result: DownloadResult) -> dict[str, Any]:
    """The per-episode row of a job snapshot."""
    return {
        "number": result.episode.number,
        "title": result.episode.title,
        "status": result.status.value,
        "message": redact_secrets(result.message),
        "path": str(result.path) if result.path is not None else None,
    }


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


@dataclass
class _Job:
    id: str
    series: Series
    episodes: list[Episode]
    options: DownloadOptions
    runner: Runner
    state: str = QUEUED
    created_at: str = field(default_factory=_now)
    started_at: str | None = None
    finished_at: str | None = None
    results: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "state": self.state,
            "series_id": self.series.series_id,
            "series_name": self.series.name,
            "total": len(self.episodes),
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "results": [dict(row) for row in self.results],
            "error": self.error,
        }


class JobManager:
    """Thread-safe registry of download jobs; at most one job runs at a time, the rest queue."""

    def __init__(self, default_runner: Runner | None = None) -> None:
        self._cond = threading.Condition()
        self._jobs: dict[str, _Job] = {}
        self._queue: deque[str] = deque()
        self._running: str | None = None
        self._default_runner = default_runner

    def start(
        self,
        series: Series,
        episodes: list[Episode],
        options: DownloadOptions,
        runner: Runner | None = None,
    ) -> str:
        """Register a job and start its worker thread; returns the job id immediately.

        The worker waits until no other job is running (FIFO), then calls
        ``runner(series, episodes, options, on_result=...)``. Without a runner the engine's
        :func:`download_series` is used (imported lazily so the web package loads without yt-dlp).
        """
        if runner is None:
            runner = self._default_runner or _engine_runner()
        job = _Job(
            id=uuid.uuid4().hex,
            series=series,
            episodes=list(episodes),
            options=options,
            runner=runner,
        )
        with self._cond:
            self._jobs[job.id] = job
            self._queue.append(job.id)
        worker = threading.Thread(
            target=self._run, args=(job,), name=f"dramafetch-job-{job.id[:8]}", daemon=True
        )
        worker.start()
        return job.id

    def get(self, job_id: str) -> dict[str, Any] | None:
        """A JSON-ready snapshot of the job, or ``None`` for an unknown id."""
        with self._cond:
            job = self._jobs.get(job_id)
            return None if job is None else job.snapshot()

    def wait(self, job_id: str, timeout: float | None = None) -> bool:
        """Block until the job is done or errored; ``False`` on timeout or unknown id."""
        with self._cond:
            if job_id not in self._jobs:
                return False
            return self._cond.wait_for(
                lambda: self._jobs[job_id].state in FINISHED_STATES, timeout=timeout
            )

    @property
    def running(self) -> str | None:
        """Id of the job currently downloading, if any."""
        with self._cond:
            return self._running

    def _run(self, job: _Job) -> None:
        with self._cond:
            self._cond.wait_for(lambda: self._running is None and self._queue[0] == job.id)
            self._queue.popleft()
            self._running = job.id
            job.state = RUNNING
            job.started_at = _now()
        error: str | None = None
        try:
            job.runner(job.series, job.episodes, job.options, on_result=self._recorder(job))
        except Exception as exc:  # a job must never take the server down
            error = redact_secrets(f"{type(exc).__name__}: {exc}")[:_MAX_ERROR_CHARS]
            log.warning("job %s failed: %s", job.id, error)
            log.debug("job %s traceback", job.id, exc_info=True)
        with self._cond:
            job.error = error
            job.state = ERROR if error is not None else DONE
            job.finished_at = _now()
            self._running = None
            self._cond.notify_all()

    def _recorder(self, job: _Job) -> Callable[[DownloadResult], None]:
        def on_result(result: DownloadResult) -> None:
            row = result_to_dict(result)
            with self._cond:
                job.results.append(row)

        return on_result


def _engine_runner() -> Runner:
    from dramafetch.engine import download_series  # lazy: pulls in yt-dlp

    return download_series
