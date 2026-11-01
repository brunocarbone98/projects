"""Background download jobs for the web UI.

Two kinds of job share one FIFO queue:

* a *download job* (``POST /api/download``) holds a series the request already resolved and a
  selection of its episodes; its runner has the shape of ``engine.download_series``;
* a *batch job* (``POST /api/batch``, one per series) holds nothing but its ``SeriesRef``: the
  worker resolves it lazily, right before its own downloads, through ``engine.run_series`` (or an
  injected series runner of the same shape) — never every list up front, which would be a burst of
  requests and would let the signed play URLs expire before their turn.

ONE worker thread runs the jobs, one at a time, in the order they were queued: TikTok rate-limits
aggressively and the engine already paces episodes. The manager owns ONE ``engine.PacingState``
for its whole lifetime, handed to every run, so the long break every ``long_rest_every`` network
attempts spans jobs, and so does the failure streak (three failures in a row stop the run, even
across jobs). Between two jobs that both contact TikTok the worker rests
``rng.uniform(rest_min_s, rest_max_s)`` — right before the second one's first request, which its
discovery and downloader announce through :meth:`JobManager.before_network` — unless the first
finished more than ``rest_max_s`` ago; a job that makes no request — a series skipped as
complete, a download job whose episodes are all on disk — takes no rest. A batch job counts as
contacting TikTok from its resolve on: it rests right before it (and the job after it may rest
too), even when its list then comes from the 15-minute cache and nothing is downloaded — the rest
errs on the slow side. When the long break is due right before a batch job's
resolve, it is taken there in place of that rest, as between two series of a CLI batch. ``sleep``,
``clock`` and ``rng`` are injectable: no test ever sleeps.

Right before a job starts, and again after that rest, the manager asks the optional ``gate``
whether it may contact TikTok: a reason refuses the job (state ``error`` with that reason, no
request made) — the web server uses it for the TikTok cooldown. A job whose run ended with a stop —
a refusal (HTTP 403 / 429 / a captcha), a login wall, the failure streak, a failed resolve, or the
gate — cancels every queued job: state ``cancelled``, ``error`` ``"not started: batch stopped in
<name> (<reason>)"``, and none of them makes a request.

``get()`` returns a JSON-ready snapshot that the page polls every couple of seconds; the engine's
``on_result`` callback updates it after each episode. Each row carries the file's ``path`` (what
the files endpoint serves), its ``file_name`` (for display) and ``thumbnail`` — whether a cover is
available, saved next to the video or embedded in it (see :func:`has_cover`); it is computed once,
when the row is recorded, never while polling. ``summaries()`` is the jobs list (most recent first,
at most :data:`MAX_LISTED_JOBS`): the snapshot without its rows, plus their counts. Nothing in this
module touches the network itself, and nothing in a snapshot can contain a cookie: error messages
are redacted defensively before they are stored.
"""

from __future__ import annotations

import logging
import random
import re
import threading
import time
import uuid
from collections import Counter, deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from dramafetch.models import (
    Downloader,
    DownloadOptions,
    DownloadResult,
    DownloadStatus,
    Episode,
    Series,
    SeriesRef,
)
from dramafetch.thumbnails import cover_sidecar

if TYPE_CHECKING:  # the engine pulls in yt-dlp: imported lazily, inside the worker
    from dramafetch.engine import PacingState, SeriesReport, SeriesRun, SeriesStart

log = logging.getLogger(__name__)

#: ``runner(series, episodes, options, on_result=callback) -> results`` — the shape of
#: :func:`dramafetch.engine.download_series`; tests inject an instant fake.
Runner = Callable[..., list[DownloadResult]]
#: ``series_runner(ref, options, *, on_result, on_start, on_pause, before_network, pacing, sleep,
#: clock, rng) -> SeriesRun`` — :func:`dramafetch.engine.run_series` bound to the server's
#: discovery options, resolve cache and downloader (``DramaFetchServer.series_runner``). It passes
#: every keyword on to ``run_series``: ``on_start(SeriesStart)`` names the series and its episode
#: count in the snapshot before the first row, ``before_network()`` is the rest between jobs.
SeriesRunner = Callable[..., "SeriesRun"]
#: ``gate() -> reason | None``: asked right before a job starts and again after the rest between
#: jobs; a reason refuses the job (see :class:`JobManager`). ``DramaFetchServer.job_refusal``
#: answers the cooldown message.
Gate = Callable[[], str | None]

QUEUED = "queued"
RUNNING = "running"
DONE = "done"
ERROR = "error"
#: Never started: a job before it stopped (a refusal, a login wall, ...) — see :class:`JobManager`.
CANCELLED = "cancelled"
FINISHED_STATES = frozenset({DONE, ERROR, CANCELLED})
#: ``GET /api/jobs`` lists at most this many jobs, the most recent first.
MAX_LISTED_JOBS = 100
#: The rows the files endpoint (and the save-all ZIP) may serve: what a run downloaded, and what it
#: found already on disk — still only after the path resolves inside ``--out``.
SERVED_STATUSES = frozenset({DownloadStatus.DONE.value, DownloadStatus.SKIPPED_EXISTS.value})
#: ``kind`` of the pause the worker takes between two jobs that both contact TikTok.
JOB_REST = "job-rest"
#: Every ``error`` of a cancelled job starts with this (the CLI's batch says the same).
NOT_STARTED_PREFIX = "not started: "
# The statuses that stop a run at once (engine._STOP_STATUSES): TikTok said no.
_STOP_STATUSES = frozenset(
    {DownloadStatus.FAILED_LOGIN, DownloadStatus.FAILED_RATE_LIMITED, DownloadStatus.FAILED_BLOCKED}
)

# Anything that looks like `sessionid=...`, `Cookie: ...`, `msToken=...` or our own session cookie
# in a message is blanked. The engine never puts cookie values in messages, but a snapshot is shown
# in a browser, so a cheap second line of defence costs nothing.
_SECRET_RE = re.compile(
    r"(?i)\b(sessionid|sid_tt|sid_guard|ssid_ucp_v1|msToken|tt_csrf_token|passport_csrf_token|"
    r"dramafetch_session|cookies?)\b\s*[=:]\s*[^\s;,]+"
)
_MAX_ERROR_CHARS = 500


def redact_secrets(text: str) -> str:
    """Blank the value after a cookie-like name: ``sessionid=abc`` -> ``sessionid=<redacted>``."""
    return _SECRET_RE.sub(lambda match: f"{match.group(1)}=<redacted>", text)


def _safe_text(text: str) -> str:
    """``text`` redacted and capped, fit for a snapshot."""
    return redact_secrets(text)[:_MAX_ERROR_CHARS]


def has_cover(path: Path) -> bool:
    """Whether a cover is available for the video at ``path``: a sidecar next to it (any engine in
    the ``file``/``both`` modes) or one embedded in the file itself (the default ``embed`` mode).

    Looks at the file system, so it is called once per row, by :func:`result_to_dict` when the
    engine reports the episode — a snapshot never calls it: the page polls every couple of seconds.
    """
    if cover_sidecar(path) is not None:
        return True
    from dramafetch.thumbnails import has_embedded_cover  # lazy: the only web import near mutagen

    return has_embedded_cover(path)


def result_to_dict(result: DownloadResult) -> dict[str, Any]:
    """The per-episode row of a job snapshot.

    ``file_name`` is the basename, for display; ``thumbnail`` says whether a cover is available —
    a sidecar next to the file or one embedded in it (:func:`has_cover`) — so the page knows
    whether to offer a Cover link next to Save video. Computed here, once, when the row is made.
    """
    path = result.path
    return {
        "number": result.episode.number,
        "title": result.episode.title,
        "status": result.status.value,
        "message": redact_secrets(result.message),
        "path": str(path) if path is not None else None,
        "file_name": path.name if path is not None else None,
        "thumbnail": path is not None and has_cover(path),
    }


def report_to_dict(report: SeriesReport) -> dict[str, Any]:
    """A ``engine.SeriesReport`` as the JSON of a snapshot's ``report``: ``engine.report_to_dict``
    — its fields (tuples as lists) plus ``line``, ``engine.report_line``: ``complete: 30 of 30 (28
    downloaded, 2 already on disk)`` — with ``line`` and ``stopped`` redacted like every message."""
    from dramafetch import engine  # lazy: pulls in yt-dlp

    data = engine.report_to_dict(report)
    for key in ("line", "stopped"):
        if isinstance(data.get(key), str):
            data[key] = _safe_text(data[key])
    return data


def stop_reason(results: Iterable[DownloadResult]) -> str | None:
    """Why a download run stopped, read off its results — the first stop status (a refusal, a
    login wall: ``"episode 3 failed-rate-limited: <message>"``) or the first ``stopped: <reason>``
    row (the failure streak) — or None when it ran to its end. The fallback for a runner that does
    not report its stop through ``on_stop`` (the engine's runner does, to
    :meth:`JobManager.note_stop`)."""
    from dramafetch.engine import STOPPED_PREFIX  # lazy: pulls in yt-dlp

    for result in results:
        if result.message.startswith(STOPPED_PREFIX):
            return result.message[len(STOPPED_PREFIX) :]
        if result.status in _STOP_STATUSES:
            reason = f"episode {result.episode.number} {result.status.value}"
            return f"{reason}: {result.message}" if result.message else reason
    return None


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


class JobRefused(Exception):  # noqa: N818 - a refusal, not an error of the code
    """Raised by :meth:`JobManager.before_network` (and the web's cached discovery) when the gate
    refuses a job that is about to contact TikTok: the job ends as ``error`` with ``reason``, no
    request is made, and the queued jobs are cancelled."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class GuardedDownloader:
    """A ``Downloader`` that calls ``before_network()`` right before every episode that may contact
    TikTok — anything but a dry run or a locked episode left alone, the downloaders' own no-request
    skips — and then hands the episode to ``downloader`` (or, when None, to the engine's downloader
    for ``options.engine``, made on the first episode that needs one). ``close()`` closes the
    downloader it wraps, the way ``engine.download_series`` closes the one it is given."""

    def __init__(
        self, before_network: Callable[[], None], downloader: Downloader | None = None
    ) -> None:
        self._before_network = before_network
        self._downloader = downloader

    def download(self, episode: Episode, options: DownloadOptions) -> DownloadResult:
        if not options.dry_run and not (episode.locked and not options.include_locked):
            self._before_network()  # may rest first, and may raise JobRefused
        if self._downloader is None:
            from dramafetch.engine import make_downloader  # lazy: pulls in yt-dlp / Playwright

            self._downloader = make_downloader(options)
        return self._downloader.download(episode, options)

    def close(self) -> None:
        if self._downloader is not None:
            from dramafetch.engine import close_downloader

            close_downloader(self._downloader)


@dataclass
class _Job:
    id: str
    options: DownloadOptions
    # A download job: the series the request resolved, the episodes it selected, its runner.
    series: Series | None = None
    episodes: list[Episode] = field(default_factory=list)
    runner: Runner | None = None
    # A batch job: only the reference, resolved by the worker through the series runner.
    ref: SeriesRef | None = None
    series_runner: SeriesRunner | None = None
    batch_id: str | None = None
    series_id: str = ""
    series_name: str | None = None
    total: int | None = None
    state: str = QUEUED
    created_at: str = field(default_factory=_now)
    started_at: str | None = None
    finished_at: str | None = None
    results: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    report: dict[str, Any] | None = None
    # The pause in progress (``{"kind", "seconds", "since"}``), cleared by the next row.
    pause: dict[str, Any] | None = None
    # Whether the job made (or was about to make) a request to TikTok: the rest between jobs.
    contacted: bool = False
    # Why its download run stopped, as ``download_series`` reports it through ``on_stop``.
    stopped: str | None = None
    # The results themselves, for the report when the runner did not return; dropped at the end.
    recorded: list[DownloadResult] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        """The job without its rows: what ``GET /api/jobs`` lists. ``counts`` has the rows per
        status, ``processed`` their number, ``files`` how many recorded a file (``done`` or
        ``skipped-exists`` with a path: what Save all may hold)."""
        tally = Counter(row["status"] for row in self.results)
        counts = {status.value: tally[status.value] for status in DownloadStatus if tally[status]}
        files = sum(1 for row in self.results if row["status"] in SERVED_STATUSES and row["path"])
        return {
            "id": self.id,
            "batch_id": self.batch_id,
            "state": self.state,
            "series_id": self.series_id,
            "series_name": self.series_name,
            "total": self.total,
            "processed": len(self.results),
            "counts": counts,
            "files": files,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
            "report": _copy_report(self.report),
            "pause": dict(self.pause) if self.pause is not None else None,
        }

    def snapshot(self) -> dict[str, Any]:
        """The summary plus every row (``GET /api/jobs/<id>``)."""
        return {**self.summary(), "results": [dict(row) for row in self.results]}


def _copy_report(report: dict[str, Any] | None) -> dict[str, Any] | None:
    """A copy a caller may change without touching the job (its lists copied too)."""
    if report is None:
        return None
    return {key: list(value) if isinstance(value, list) else value for key, value in report.items()}


class JobManager:
    """Thread-safe registry of download jobs; ONE worker thread runs them one at a time, in order.

    ``gate`` is asked when a job reaches the front of the queue, right before its runner would
    contact TikTok, and again after the rest between jobs: a reason (the cooldown message) ends
    the job as ``error`` with that reason, nothing is downloaded, and the queued jobs are
    cancelled; ``None`` lets it run. ``series_runner`` is the default runner of batch jobs.
    ``sleep``, ``clock`` (monotonic seconds) and ``rng`` drive the rest between jobs and are handed
    to every run together with :attr:`pacing`; tests replace them (they are plain attributes).
    """

    def __init__(
        self,
        default_runner: Runner | None = None,
        gate: Gate | None = None,
        *,
        series_runner: SeriesRunner | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        rng: random.Random | None = None,
    ) -> None:
        self._cond = threading.Condition()
        self._jobs: dict[str, _Job] = {}  # in the order they were queued
        self._queue: deque[str] = deque()
        self._running: str | None = None
        self._worker: threading.Thread | None = None
        self._default_runner = default_runner
        self._series_runner = series_runner
        self._gate = gate
        self.sleep = sleep
        self.clock = clock
        self.rng = rng if rng is not None else random.Random()
        self._pacing: PacingState | None = None
        # clock() when the last job that contacted TikTok finished (the rest between jobs).
        self._last_contact_at: float | None = None

    # ------------------------------------------------------------------ queueing

    def start(
        self,
        series: Series,
        episodes: list[Episode],
        options: DownloadOptions,
        runner: Runner | None = None,
    ) -> str:
        """Queue a download job and return its id immediately.

        The worker calls ``runner(series, episodes, options, on_result=...)`` when the job's turn
        comes. Without a runner the manager's own :meth:`engine_runner` is used (the engine is
        imported lazily, so the web package loads without yt-dlp).
        """
        if runner is None:
            runner = self._default_runner or self.engine_runner()
        job = _Job(
            id=uuid.uuid4().hex,
            options=options,
            series=series,
            episodes=list(episodes),
            runner=runner,
            series_id=series.series_id,
            series_name=series.name,
            total=len(episodes),
        )
        self._enqueue([job])
        return job.id

    def start_batch(
        self,
        refs: list[SeriesRef],
        options: DownloadOptions,
        runner: SeriesRunner | None = None,
    ) -> tuple[str, list[str]]:
        """Queue one batch job per reference, all with one new ``batch_id``; return the batch id
        and the job ids, in order. Nothing is resolved here: each job holds only its ``SeriesRef``
        until the worker reaches it. ValueError for an empty list or without a series runner."""
        series_runner = runner or self._series_runner
        if series_runner is None:
            raise ValueError("a batch needs a series runner (engine.run_series)")
        if not refs:
            raise ValueError("a batch needs at least one series")
        batch_id = uuid.uuid4().hex
        jobs = [
            _Job(
                id=uuid.uuid4().hex,
                options=options,
                ref=ref,
                series_runner=series_runner,
                batch_id=batch_id,
                series_id=ref.series_id,
            )
            for ref in refs
        ]
        self._enqueue(jobs)
        return batch_id, [job.id for job in jobs]

    def _enqueue(self, jobs: list[_Job]) -> None:
        with self._cond:
            for job in jobs:
                self._jobs[job.id] = job
                self._queue.append(job.id)
            if self._worker is None:  # the worker exits (and clears this) once the queue is empty
                self._worker = threading.Thread(
                    target=self._work, name="dramafetch-jobs", daemon=True
                )
                self._worker.start()

    # ------------------------------------------------------------------ reading

    def get(self, job_id: str) -> dict[str, Any] | None:
        """A JSON-ready snapshot of the job, or ``None`` for an unknown id."""
        with self._cond:
            job = self._jobs.get(job_id)
            return None if job is None else job.snapshot()

    def summaries(self, limit: int = MAX_LISTED_JOBS) -> list[dict[str, Any]]:
        """The jobs without their rows (see ``_Job.summary``), the most recent first, at most
        ``limit`` of them."""
        with self._cond:
            recent = list(self._jobs.values())[-limit:] if limit > 0 else []
            return [job.summary() for job in reversed(recent)]

    def wait(self, job_id: str, timeout: float | None = None) -> bool:
        """Block until the job is done, errored or cancelled; ``False`` on timeout or unknown id."""
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

    @property
    def pacing(self) -> PacingState:
        """The ONE ``engine.PacingState`` of this manager's lifetime, handed to every run (the long
        break every ``long_rest_every`` network attempts spans jobs); made on first use."""
        with self._cond:
            if self._pacing is None:
                from dramafetch.engine import PacingState  # lazy: pulls in yt-dlp

                self._pacing = PacingState()
            return self._pacing

    # ------------------------------------------------------------------ hooks for the runs

    def engine_runner(self, downloader: Downloader | None = None) -> Runner:
        """``engine.download_series`` bound to this manager: its :attr:`pacing`, ``sleep``,
        ``clock`` and ``rng``, :meth:`note_pause` as ``on_pause``, :meth:`note_stop` as
        ``on_stop``, and a :class:`GuardedDownloader` around ``downloader`` (None: the engine's for
        ``options.engine``), so that the job's first request settles the rest between jobs
        (:meth:`before_network`)."""

        def run(
            series: Series,
            episodes: list[Episode],
            options: DownloadOptions,
            *,
            on_result: Callable[[DownloadResult], None] | None = None,
        ) -> list[DownloadResult]:
            from dramafetch import engine  # lazy: pulls in yt-dlp

            return engine.download_series(
                series,
                episodes,
                options,
                downloader=GuardedDownloader(self.before_network, downloader),
                on_result=on_result,
                on_pause=self.note_pause,
                sleep=self.sleep,
                rng=self.rng,
                pacing=self.pacing,
                clock=self.clock,
                on_stop=self.note_stop,
            )

        return run

    def before_network(self) -> None:
        """Called by the running job's discovery and downloader right before a request to TikTok.

        The first call of a job settles the rest between jobs: when another job contacted TikTok
        and finished at most ``rest_max_s`` ago, the worker rests ``rng.uniform(rest_min_s,
        rest_max_s)`` — a ``"job-rest"`` pause in the snapshot — and then asks the gate again: a
        reason (a cooldown that started meanwhile) raises :class:`JobRefused`, so the job ends
        before its request. For a batch job that first call comes right before its resolve, so
        when the run's long break is due then (``engine.long_rest_due`` on :attr:`pacing`) it is
        taken there instead — ``"long-rest"``, ``rng.uniform(long_rest_min_s, long_rest_max_s)``,
        the count started again, the gate asked again — as between two series of a CLI batch: the
        fresh list never waits through it. Later calls of the same job return at once, and so does
        a call outside a running job (a runner used on its own).
        """
        with self._cond:
            job = self._current()
            if job is None or job.contacted:
                return
            job.contacted = True
            last = self._last_contact_at
        options = job.options
        long_break = job.ref is not None and self._long_break_due(options)
        if long_break:
            from dramafetch.engine import LONG_REST  # lazy: loaded already by the run calling this

            kind = LONG_REST
            seconds = self.rng.uniform(options.long_rest_min_s, options.long_rest_max_s)
        elif last is None or self.clock() - last > options.rest_max_s:
            return
        else:
            kind, seconds = JOB_REST, self.rng.uniform(options.rest_min_s, options.rest_max_s)
        if seconds > 0:
            log.info("job %s rests %.0f s (%s) before contacting TikTok", job.id[:8], seconds, kind)
            self.note_pause(kind, seconds)
            self.sleep(seconds)
            with self._cond:
                job.pause = None
        if long_break:
            self.pacing.run_attempts = 0  # the break is taken: the count starts again
        if seconds <= 0:
            return
        reason = self._refusal()
        if reason is not None:
            with self._cond:
                job.contacted = False  # refused before its request: it never contacted TikTok
            raise JobRefused(reason)

    def _long_break_due(self, options: DownloadOptions) -> bool:
        """Whether the run's long break is due before the running job's first request."""
        from dramafetch.engine import long_rest_due  # lazy: pulls in yt-dlp

        return long_rest_due(options, self.pacing, self.clock)

    def note_pause(self, kind: str, seconds: float) -> None:
        """``on_pause`` for the running job: its snapshot shows ``{"kind", "seconds", "since"}``
        until the next row arrives (``pace``, ``rest``, ``long-rest`` from the engine,
        ``job-rest`` from :meth:`before_network`)."""
        with self._cond:
            job = self._current()
            if job is not None:
                job.pause = {"kind": kind, "seconds": round(float(seconds), 1), "since": _now()}

    def note_stop(self, reason: str) -> None:
        """``on_stop`` for the running job's ``download_series``: why it stopped (``"episode 2
        failed-rate-limited"``, ``"3 consecutive failures"``) — the job then cancels the queue."""
        with self._cond:
            job = self._current()
            if job is not None and job.stopped is None:
                job.stopped = _safe_text(reason)

    def _current(self) -> _Job | None:
        """The running job (the lock is held by the caller)."""
        return None if self._running is None else self._jobs.get(self._running)

    # ------------------------------------------------------------------ the worker

    def _work(self) -> None:
        try:
            while True:
                with self._cond:
                    if not self._queue:  # checked and cleared under one lock: see _enqueue
                        self._worker = None
                        return
                    job = self._jobs[self._queue.popleft()]
                    self._running = job.id
                    job.started_at = _now()  # still "queued" until the gate let it through
                try:
                    error, stop, report = self._execute(job)
                except Exception as exc:  # a bug in the bookkeeping must not stall the queue
                    error, stop, report = _safe_text(f"{type(exc).__name__}: {exc}"), None, None
                    log.warning("job %s failed: %s", job.id[:8], error)
                    log.debug("job %s traceback", job.id[:8], exc_info=True)
                self._finish(job, error, stop, report)
        finally:
            with self._cond:  # only reached with the slot still taken on an abnormal exit
                if self._worker is threading.current_thread():
                    self._worker = None
                    self._running = None
                    self._cond.notify_all()

    def _execute(self, job: _Job) -> tuple[str | None, str | None, dict[str, Any] | None]:
        """Run one job: ``(error, stop reason, report)``. The gate first: a reason refuses the job
        (and is its stop, so the queue is cancelled too); only then is the job ``running`` — a job
        seen running has passed the gate. Runner errors are caught here."""
        refusal = self._refusal()
        if refusal is not None:
            log.warning("job %s refused before any request: %s", job.id[:8], refusal)
            return refusal, refusal, None
        with self._cond:
            job.state = RUNNING
        if job.ref is not None:
            return self._run_series(job)
        return self._run_download(job)

    def _finish(
        self,
        job: _Job,
        error: str | None,
        stop: str | None,
        report: dict[str, Any] | None,
    ) -> None:
        """Record the outcome and free the slot in one locked step (``wait()`` and ``running``
        never see a finished job still running), then cancel the queue after a stop."""
        with self._cond:
            job.error = error
            job.report = report
            job.pause = None
            job.state = ERROR if error is not None else DONE
            job.finished_at = _now()
            if job.contacted:
                self._last_contact_at = self.clock()
            if stop is not None:
                self._cancel_queued(job, stop)
            # The lists, the raw payloads and the runners are not needed any more.
            job.series, job.episodes, job.recorded = None, [], []
            job.runner = job.series_runner = None
            self._running = None
            self._cond.notify_all()

    def _run_download(self, job: _Job) -> tuple[str | None, str | None, dict[str, Any] | None]:
        """A download job: ``(error, stop reason, report)``."""
        assert job.series is not None and job.runner is not None
        error: str | None = None
        stop: str | None = None
        results: list[DownloadResult] | None = None
        try:
            results = job.runner(
                job.series, job.episodes, job.options, on_result=self._recorder(job)
            )
        except JobRefused as exc:
            error = stop = _safe_text(exc.reason)
            log.warning("job %s refused before its first request: %s", job.id[:8], error)
        except Exception as exc:  # a job must never take the server down
            error = _safe_text(f"{type(exc).__name__}: {exc}")
            log.warning("job %s failed: %s", job.id[:8], error)
            log.debug("job %s traceback", job.id[:8], exc_info=True)
        with self._cond:
            done = list(results) if results is not None else list(job.recorded)
            reported = job.stopped
        if stop is None:
            found = reported or stop_reason(done)
            stop = _safe_text(found) if found is not None else None
        return error, stop, self._report(job.series, done, stop, job.options.out_dir)

    def _run_series(self, job: _Job) -> tuple[str | None, str | None, dict[str, Any] | None]:
        """A batch job — ``engine.run_series`` resolves the series right before its downloads:
        ``(error, stop reason, report)``."""
        assert job.ref is not None and job.series_runner is not None
        try:
            run = job.series_runner(
                job.ref,
                job.options,
                on_result=self._recorder(job),
                on_start=self._started(job),
                on_pause=self.note_pause,
                before_network=self.before_network,
                pacing=self.pacing,
                sleep=self.sleep,
                clock=self.clock,
                rng=self.rng,
            )
        except JobRefused as exc:
            reason = _safe_text(exc.reason)
            log.warning("job %s refused before its first request: %s", job.id[:8], reason)
            return reason, reason, None
        except Exception as exc:  # a job must never take the server down
            failure = _safe_text(f"{type(exc).__name__}: {exc}")
            log.warning("job %s failed: %s", job.id[:8], failure)
            log.debug("job %s traceback", job.id[:8], exc_info=True)
            return failure, None, None
        error = _safe_text(run.error) if run.error is not None else None
        stop: str | None = None
        if run.stop:
            stop = _safe_text(run.report.stopped or run.error or "stopped")
        report = report_to_dict(run.report)
        with self._cond:
            name = run.series.name if run.series is not None else None
            job.series_name = job.series_name or name or run.report.name
            if run.results:  # a failed resolve leaves the total unknown (None)
                job.total = len(run.results)
            job.contacted = job.contacted or run.contacted
        return error, stop, report

    def _report(
        self,
        series: Series | None,
        results: list[DownloadResult],
        stopped: str | None,
        out_dir: Path,
    ) -> dict[str, Any] | None:
        """``engine.series_report`` of a download job as a dict, or None when it cannot be made.
        A selection (**Download selected**) reports on the whole series: the listed episodes it
        did not cover count as on disk when the manifest of the series directory under
        ``out_dir`` says so (``engine.report_rows``; read-only)."""
        if series is None:
            return None
        try:
            from dramafetch.engine import report_rows, series_report  # lazy: pulls in yt-dlp
            from dramafetch.manifest import read_manifest, series_dir

            manifest = read_manifest(series_dir(out_dir, series), series.series_id)
            rows = report_rows(series, results, manifest)
            return report_to_dict(series_report(series, rows, stopped=stopped))
        except Exception as exc:  # the job's own outcome matters more than its summary
            log.warning("no report for series %s: %s", series.series_id, _safe_text(str(exc)))
            log.debug("report traceback", exc_info=True)
            return None

    def _cancel_queued(self, stopped_in: _Job, reason: str) -> None:
        """Cancel every queued job after ``stopped_in`` ended with a stop (the lock is held): none
        of them makes a request."""
        name = stopped_in.series_name or stopped_in.series_id
        message = _safe_text(f"{NOT_STARTED_PREFIX}batch stopped in {name} ({reason})")
        now = _now()
        for job_id in self._queue:
            queued = self._jobs[job_id]
            queued.state = CANCELLED
            queued.error = message
            queued.finished_at = now
            queued.series, queued.episodes = None, []
            queued.runner = queued.series_runner = None
        if self._queue:
            log.warning("cancelled %d queued job(s): %s", len(self._queue), message)
        self._queue.clear()

    def _refusal(self) -> str | None:
        """The gate's reason to refuse the job about to start (redacted, capped), or ``None``. A
        gate that fails is logged and lets the job run, the way a corrupt cooldown file counts as
        no cooldown; it never takes the server down."""
        if self._gate is None:
            return None
        try:
            reason = self._gate()
        except Exception as exc:  # defensive: the cooldown check never raises by contract
            log.warning("job gate failed: %s", redact_secrets(f"{type(exc).__name__}: {exc}")[:300])
            log.debug("job gate traceback", exc_info=True)
            return None
        if reason is None:
            return None
        return _safe_text(reason)

    def _recorder(self, job: _Job) -> Callable[[DownloadResult], None]:
        def on_result(result: DownloadResult) -> None:
            row = result_to_dict(result)  # looks at the file system: outside the lock
            with self._cond:
                job.results.append(row)
                job.recorded.append(result)
                job.pause = None

        return on_result

    def _started(self, job: _Job) -> Callable[[SeriesStart], None]:
        """``on_start`` of a batch job: the series' name and episode count, known before the first
        row — from the list just resolved (or cached), or from the manifest of a series skipped as
        complete."""

        def on_start(start: SeriesStart) -> None:
            name = start.series.name if start.series is not None else None
            with self._cond:
                job.series_name = name or start.name
                job.total = len(start.episodes)

        return on_start
