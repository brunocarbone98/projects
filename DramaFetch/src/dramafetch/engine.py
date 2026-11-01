"""The seam shared by the CLI and the web UI: resolve a series, select episodes, download them.

Pacing lives here, and it is the whole anti-bot strategy: behave like one person watching.
Episodes are downloaded one at a time in ascending order. Between two NETWORK attempts the run
pauses — a random 4-9 s by default, or with ``pace="human"`` about as long as the previous episode
lasted — and after every ``rest_every`` network attempts (failures count, skips do not) it rests
for 60-120 s. The run stops at the first sign of blocking: a login redirect, HTTP 429 (rate
limited), HTTP 403 or a captcha wall (blocked) or ``max_consecutive_failures`` failures in a row
(in a row across the series of a run: :class:`PacingState`); the remaining episodes are marked
``stopped: …`` without another request, because the right answer is to wait 30-60 minutes and
resume (the manifest remembers what is done), not to retry. A refusal (HTTP 403 / 429 from a
download, HTTP 429 or a captcha while resolving the list) is also recorded as the global cooldown
(``dramafetch.cooldown.record_block``): for 30 minutes every front end refuses to contact TikTok
at all (:func:`check_cooldown`), and a run already under way — which asks again right before
every request — stops before its next one. Skips never pause. The sleep function
and the random source are injectable for tests. Locked episodes are skipped, never unlocked.

Several series (:func:`run_batch`, one :func:`run_series` each) are strictly sequential, and each
series is resolved right before its downloads — never all lists up front, which would be a burst
and would let the signed play URLs expire. Between two series that contact TikTok the batch rests
like every ``rest_every`` episodes; across the whole run (:class:`PacingState`) a long break of
15-30 min comes every ``long_rest_every`` (100) network attempts; any stop ends the batch with no
further request; and a series whose manifest says it was complete less than
``models.RECHECK_AFTER_S`` (24 h) ago, every file still on disk, costs no request at all.
"""

from __future__ import annotations

import logging
import random
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from functools import partial
from pathlib import Path
from typing import Any

from dramafetch.cooldown import (
    Cooldown,
    active_cooldown,
    clock_time,
    cooldown_message,
    record_block,
)
from dramafetch.downloader import (
    YtDlpDownloader,
    cookies_file_problem,
    existing_episode_file,
    existing_file_result,
    locked_result,
    sanitize_error,
)
from dramafetch.errors import ChallengeError, DiscoveryError, LoginRequiredError, RateLimitedError
from dramafetch.manifest import (
    Manifest,
    manifest_path,
    read_manifest,
    series_dir,
    validate_name_format,
)
from dramafetch.models import (
    DRM_REMEMBERED_MESSAGE,
    QUALITY_MODES,
    RECHECK_AFTER_S,
    THUMBNAIL_MODES,
    Discovery,
    DiscoveryOptions,
    Downloader,
    DownloadOptions,
    DownloadResult,
    DownloadStatus,
    Episode,
    Series,
    SeriesRef,
)

log = logging.getLogger(__name__)

EXIT_OK = 0
EXIT_FAILED = 2
EXIT_LOGIN_REQUIRED = 3
#: The episode list could not be fetched (a captcha, an HTTP error, nothing listed).
EXIT_DISCOVERY = 4
#: Blocked (HTTP 403) or rate limited (HTTP 429): wait 30-60 minutes, then run again to resume.
EXIT_RATE_LIMITED = 5
#: :func:`batch_exit_code`: the worst exit code of a batch wins, in this order (a code not listed
#: ranks just above 0).
_EXIT_SEVERITY = {
    EXIT_RATE_LIMITED: 5,
    EXIT_LOGIN_REQUIRED: 4,
    EXIT_DISCOVERY: 3,
    EXIT_FAILED: 2,
    EXIT_OK: 0,
}

#: ``on_pause`` kinds: ``"pace"`` and ``"rest"`` inside a series, ``"long-rest"`` (the run's long
#: break, :class:`PacingState`) and ``"series-rest"`` (between two series of a batch).
PACE = "pace"
REST = "rest"
LONG_REST = "long-rest"
SERIES_REST = "series-rest"

#: ``DownloadOptions.pace`` values: a random ``delay_min_s``-``delay_max_s`` pause, or about the
#: previous episode's duration (a person watching).
PACES = ("fixed", "human")
#: ``DownloadOptions.engine`` values (see :func:`make_downloader`).
ENGINES = ("yt-dlp", "browser")
#: Upper bound of a "human" pause: a long episode does not mean a five-minute-plus wait.
MAX_HUMAN_PAUSE_S = 300.0
#: Random extra on top of a "human" pause, so that two runs never pace identically.
HUMAN_JITTER_S = 3.0
#: Every result written for an episode the run gave up on starts with this.
STOPPED_PREFIX = "stopped: "

_SPEC_TOKEN_RE = re.compile(r"^(?P<lo>\d+)?(?P<dash>-)?(?P<hi>\d+)?$")
#: Largest episode number an ``--episodes`` spec may name; short dramas have at most a few hundred
#: episodes (the series URL itself allows four digits), and the bound keeps a typo such as
#: ``1-99999999999`` from being taken seriously.
MAX_EPISODE_NUMBER = 10_000
#: Results that did not contact TikTok: they never pause, count or reset anything.
NO_NETWORK_STATUSES = frozenset(
    {DownloadStatus.SKIPPED_EXISTS, DownloadStatus.SKIPPED_LOCKED, DownloadStatus.DRY_RUN}
)
#: One of these stops the run at once: TikTok said no, and knocking again makes it worse.
_STOP_STATUSES = frozenset(
    {
        DownloadStatus.FAILED_LOGIN,
        DownloadStatus.FAILED_RATE_LIMITED,
        DownloadStatus.FAILED_BLOCKED,
    }
)
#: Failures counted towards ``max_consecutive_failures`` (a DONE resets the count, skips do not).
_COUNTED_FAILURES = frozenset({DownloadStatus.FAILED, DownloadStatus.FAILED_UNAVAILABLE})
#: The stop statuses that are TikTok refusing (HTTP 403 / a captcha, HTTP 429): besides stopping
#: the run they start the global cooldown (:func:`record_block_if_refused`). A login redirect stops
#: the run too but is not a refusal.
BLOCK_STATUSES = frozenset({DownloadStatus.FAILED_RATE_LIMITED, DownloadStatus.FAILED_BLOCKED})

#: Inclusive episode-number interval; ``None`` as the upper bound means "to the last episode".
Interval = tuple[int, int | None]
#: ``SeriesRun.error_kind`` values.
ERROR_KINDS = (
    "cooldown",
    "cookies",
    "login",
    "captcha",
    "rate-limited",
    "discovery",
    "empty",
    "not-started",
)
#: ``SeriesReport.stopped`` of a series refused before its resolve for a malformed cookies file.
COOKIES_STOP = "malformed cookies file"
#: Message of the rows synthesized for a series skipped as complete (and of manifest skips).
MANIFEST_SKIP_PREFIX = "already downloaded (manifest): "
#: What the report line of a series skipped as complete adds when locked episodes remain.
RECHECK_HINT = "unlocked more in the TikTok app since? --recheck looks again"


def resolve(
    ref: SeriesRef, options: DiscoveryOptions, discovery: Discovery | None = None
) -> Series:
    """Resolve a series reference into its episode list.

    Without an explicit ``discovery`` the strategy comes from
    ``dramafetch.discovery.choose_discovery(options)`` (imported lazily: the discovery package
    pulls in Playwright). A :class:`~dramafetch.errors.RateLimitedError` or
    :class:`~dramafetch.errors.ChallengeError` from the discovery records the global cooldown
    (source ``"discovery"``) and is re-raised.
    """
    if discovery is None:
        from dramafetch.discovery import choose_discovery

        discovery = choose_discovery(options)
    try:
        series = discovery.discover(ref, options)
    except (RateLimitedError, ChallengeError) as exc:
        # TikTok refused the list (HTTP 429, a captcha): nothing contacts it for a while.
        record_block(str(exc), "discovery")
        raise
    if series.name is None:
        series.name = next((e.series_name for e in series.episodes if e.series_name), None)
    return series


def parse_episode_spec(spec: str | None) -> list[Interval] | None:
    """Parse ``"1-5,8,10-"`` into inclusive intervals; ``None``/``""``/``"all"`` give ``None``.

    Accepted tokens: ``N``, ``A-B`` (A <= B), ``A-`` (to the last episode) and ``-B`` (from 1).
    Anything else raises ValueError with a message fit for the terminal.
    """
    if spec is None or spec.strip() == "" or spec.strip().lower() == "all":
        return None
    intervals: list[Interval] = []
    for raw in spec.split(","):
        token = raw.strip()
        if not token:
            continue
        match = _SPEC_TOKEN_RE.match(token)
        if match is None or (match.group("lo") is None and match.group("hi") is None):
            raise ValueError(
                f"invalid episode spec {token!r}: use numbers and ranges like 1-5,8,10- (or all)"
            )
        low = int(match.group("lo")) if match.group("lo") else 1
        if match.group("dash") is None:
            high: int | None = low
        else:
            high = int(match.group("hi")) if match.group("hi") else None
        if low < 1:
            raise ValueError(f"invalid episode spec {token!r}: episodes start at 1")
        if high is not None and high < low:
            raise ValueError(f"invalid episode spec {token!r}: the range end is before its start")
        if max(low, high or 0) > MAX_EPISODE_NUMBER:
            raise ValueError(
                f"invalid episode spec {token!r}: episode numbers above {MAX_EPISODE_NUMBER} are "
                'not accepted (use an open range like "10-" or "all" for everything)'
            )
        intervals.append((low, high))
    if not intervals:
        raise ValueError(f"invalid episode spec {spec!r}: nothing selected")
    return intervals


def select_episodes(series: Series, spec: str | None) -> list[Episode]:
    """Episodes of the series matching the spec, ascending; numbers the series lacks are ignored
    silently (see :func:`missing_from_selection` to report them)."""
    intervals = parse_episode_spec(spec)
    ordered = sorted(series.episodes, key=lambda episode: episode.number)
    if intervals is None:
        return ordered
    return [episode for episode in ordered if _in_intervals(episode.number, intervals)]


def _in_intervals(number: int, intervals: list[Interval]) -> bool:
    return any(low <= number and (high is None or number <= high) for low, high in intervals)


def missing_from_selection(series: Series, spec: str | None) -> list[tuple[int, int]]:
    """Requested episode numbers the series does not list, as inclusive ranges (for messages).

    Open-ended ranges stop at the last listed episode, so ``"10-"`` on a 5-episode series requests
    nothing that can be missing. The gaps are computed as ranges, never as individual numbers, so
    the cost depends on how many episodes are listed, not on how wide the spec (or a hostile
    episode number in the payload) is.
    """
    intervals = parse_episode_spec(spec)
    if intervals is None:
        return []
    present = sorted(set(series.numbers))
    last = present[-1] if present else 0
    gaps: list[tuple[int, int]] = []
    for low, high in intervals:
        top = last if high is None else high
        if top < low:
            continue
        cursor = low
        for number in present:
            if number < cursor:
                continue
            if number > top:
                break
            if number > cursor:
                gaps.append((cursor, number - 1))
            cursor = number + 1
        if cursor <= top:
            gaps.append((cursor, top))
    return merge_ranges(gaps)


def merge_ranges(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Sort inclusive ranges and merge the ones that overlap or touch: ``[(7, 9), (1, 3), (4, 5)]``
    -> ``[(1, 5), (7, 9)]``."""
    merged: list[tuple[int, int]] = []
    for low, high in sorted(ranges):
        if merged and low <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], high))
        else:
            merged.append((low, high))
    return merged


def compress_ranges(numbers: list[int]) -> list[tuple[int, int]]:
    """``[1, 2, 3, 7, 9, 10]`` -> ``[(1, 3), (7, 7), (9, 10)]`` (input must be sorted)."""
    ranges: list[tuple[int, int]] = []
    for number in numbers:
        if ranges and number == ranges[-1][1] + 1:
            ranges[-1] = (ranges[-1][0], number)
        elif not ranges or number > ranges[-1][1]:
            ranges.append((number, number))
    return ranges


def format_ranges(ranges: list[tuple[int, int]]) -> str:
    """``[(1, 3), (7, 7)]`` -> ``"1-3, 7"``."""
    return ", ".join(f"{low}-{high}" if low != high else str(low) for low, high in ranges)


# --------------------------------------------------------------------------- pacing & engines


def validate_pacing(options: DownloadOptions) -> None:
    """Raise ValueError when the pacing options cannot be honoured: a negative or inverted
    delay or rest range, or an unknown pace. Checked before anything touches the disk."""
    _check_range("delay_min_s", options.delay_min_s, "delay_max_s", options.delay_max_s)
    _check_range("rest_min_s", options.rest_min_s, "rest_max_s", options.rest_max_s)
    _check_range(
        "long_rest_min_s", options.long_rest_min_s, "long_rest_max_s", options.long_rest_max_s
    )
    if options.rest_every < 0 or options.long_rest_every < 0:
        raise ValueError("rest_every/long_rest_every must not be negative (0 disables)")
    if options.pace not in PACES:
        raise ValueError(f"unknown pace {options.pace!r}: expected one of {', '.join(PACES)}")


def _check_range(low_name: str, low: float, high_name: str, high: float) -> None:
    if low < 0 or high < 0:
        raise ValueError(f"{low_name}/{high_name} must not be negative (got {low:g} and {high:g})")
    if high < low:
        raise ValueError(f"{high_name} ({high:g}) must be >= {low_name} ({low:g})")


def validate_naming(options: DownloadOptions) -> None:
    """Raise ValueError when ``options.name_format`` cannot name episodes: an unknown placeholder
    (the allowed ones are ``{series}``, ``{number}``, ``{n}``, ``{title}`` and ``{id}``), an
    unmatched brace, or nothing that tells one episode from another (see
    :func:`~dramafetch.manifest.validate_name_format`). Checked, like the pacing, before the
    series directory is created."""
    validate_name_format(options.name_format)


def validate_thumbnail(options: DownloadOptions) -> None:
    """Raise ValueError when ``options.thumbnail`` is not one of ``models.THUMBNAIL_MODES``
    (``embed``, ``both``, ``file``, ``none``). Checked, like the pacing and the naming, before the
    series directory is created; the CLI's ``--thumbnail`` choices refuse it even earlier."""
    if options.thumbnail not in THUMBNAIL_MODES:
        raise ValueError(
            f"unknown thumbnail mode {options.thumbnail!r}: expected one of "
            f"{', '.join(THUMBNAIL_MODES)}"
        )


def validate_quality(options: DownloadOptions) -> None:
    """Raise ValueError when ``options.quality`` is not one of ``models.QUALITY_MODES``
    (``compatible``, ``best``). Checked before the series directory is created; the CLI's
    ``--quality`` choices refuse it even earlier."""
    if options.quality not in QUALITY_MODES:
        raise ValueError(
            f"unknown quality {options.quality!r}: expected one of {', '.join(QUALITY_MODES)}"
        )


def check_cooldown() -> Cooldown | None:
    """The global cooldown in force, if any (``dramafetch.cooldown.active_cooldown``): every front
    end asks before contacting TikTok and refuses while one is active — the CLI with exit 5, the
    web with a 429. The browser engine's in-session list refresh does not ask: it runs inside a
    download that already passed the check."""
    return active_cooldown()


def record_block_if_refused(result: DownloadResult, source: str) -> Cooldown | None:
    """Start the global cooldown when ``result`` is a refusal (:data:`BLOCK_STATUSES`: HTTP 403 /
    a captcha, HTTP 429) — ``dramafetch.cooldown.record_block(result.message or status,
    source)`` — and return it; None for any other result. ``source`` is the engine name."""
    if result.status not in BLOCK_STATUSES:
        return None
    return record_block(result.message or result.status.value, source=source)


def make_downloader(options: DownloadOptions) -> Downloader:
    """The downloader for ``options.engine``.

    ``"yt-dlp"`` -> :class:`~dramafetch.downloader.YtDlpDownloader` (one page load plus the media
    per episode); ``"browser"`` -> ``dramafetch.downloader_browser.BrowserDownloader``, imported
    lazily because it pulls in Playwright (it fetches the play URLs the episode list already
    carries, inside one browser session). Anything else raises ValueError.
    """
    name = (options.engine or "").strip().lower()
    if name == "yt-dlp":
        return YtDlpDownloader()
    if name == "browser":
        from dramafetch.downloader_browser import BrowserDownloader  # lazy: pulls in Playwright

        return BrowserDownloader()
    raise ValueError(
        f"unknown download engine {options.engine!r}: expected one of {', '.join(ENGINES)}"
    )


def close_downloader(downloader: Downloader) -> None:
    """Call ``downloader.close()`` when it has one (the browser engine holds a Chromium open for
    the whole run). A failure to close is logged, never raised: the results matter more."""
    close = getattr(downloader, "close", None)
    if not callable(close):
        return
    try:
        close()
    except Exception as exc:  # the run is over; a stuck browser must not hide its results
        log.warning(
            "closing the downloader failed: %s", sanitize_error(str(exc) or type(exc).__name__)
        )


@dataclass
class PacingState:
    """The pacing of one RUN — a CLI batch of series, or the web job manager's whole lifetime —
    on top of each series' own pauses and rests, shared by every series of the run.

    ``run_attempts`` counts the network attempts of the run (all series; skips never count) and
    ``last_network_at`` is ``clock()`` right after the last of them. Every
    ``DownloadOptions.long_rest_every`` (100) attempts the run takes its long break, 15-30 min
    (``"long-rest"``), instead of that step's pause: nobody watches 100 episodes without one. An
    idle gap of ``long_rest_min_s`` or more between two attempts IS that break, so the count
    starts again from 0. :func:`download_series` creates a fresh one when none is given (one
    series = one run); no flag lowers the long break.

    ``consecutive_failures`` is the run's failure streak (``failed`` / ``failed-unavailable`` in a
    row, ACROSS the series of the run, so a batch whose series each have one or two episodes left
    still stops at ``max_consecutive_failures``): a ``done`` resets it, skips neither count nor
    reset, and it starts again from 0 after a stop (the stop has been acted on) and after the same
    idle gap of ``long_rest_min_s``.
    """

    run_attempts: int = 0
    last_network_at: float | None = None
    consecutive_failures: int = 0


def _long_rest_due(options: DownloadOptions, pacing: PacingState, now: float | None) -> bool:
    """Whether the run's long break is due before the next network attempt; first forgets the
    count — and the failure streak — when the run has been idle for ``long_rest_min_s`` (``now``
    is ``clock()``, None when the run has made no attempt yet)."""
    if (
        now is not None
        and pacing.last_network_at is not None
        and now - pacing.last_network_at >= options.long_rest_min_s
    ):
        pacing.run_attempts = 0  # the break already happened naturally
        pacing.consecutive_failures = 0  # and failures before it are not "in a row" any more
    return (
        options.long_rest_every > 0
        and pacing.run_attempts > 0
        and pacing.run_attempts % options.long_rest_every == 0
    )


def long_rest_due(
    options: DownloadOptions, pacing: PacingState, clock: Callable[[], float]
) -> bool:
    """Whether the run's long break is due before its next network attempt (an idle gap of
    ``long_rest_min_s`` first starts the count again, see :class:`PacingState`). What a front end
    asks right before a series' first request, so that the break comes BEFORE the series is
    resolved, in place of the rest between series (:func:`run_batch`) or between web jobs
    (``web.jobs.JobManager.before_network``) — the fresh play URLs then never wait through it.
    The caller takes ``rng.uniform(long_rest_min_s, long_rest_max_s)`` and then sets
    ``pacing.run_attempts`` to 0."""
    now = clock() if pacing.last_network_at is not None else None
    return _long_rest_due(options, pacing, now)


def _pause_before_attempt(
    options: DownloadOptions,
    rng: random.Random,
    pacing: PacingState,
    clock: Callable[[], float],
    network_attempts: int,
    previous: Episode | None,
) -> tuple[str, float]:
    """``(kind, seconds)`` to wait before a network attempt: the run's long break when it is due
    (it REPLACES the pause of that step, and also comes before the first attempt of a series),
    else the series' own pause (:func:`_next_pause`), none before its first attempt."""
    now = clock() if pacing.last_network_at is not None else None
    if _long_rest_due(options, pacing, now):
        return LONG_REST, rng.uniform(options.long_rest_min_s, options.long_rest_max_s)
    if network_attempts > 0:
        return _next_pause(options, rng, network_attempts, previous)
    return PACE, 0.0


def _next_pause(
    options: DownloadOptions, rng: random.Random, network_attempts: int, previous: Episode | None
) -> tuple[str, float]:
    """``(kind, seconds)`` to wait before the next network attempt, ``network_attempts`` > 0 made.

    ``("rest", …)`` when the attempts so far are a multiple of ``rest_every``; otherwise
    ``("pace", …)``: a random ``delay_min_s``-``delay_max_s``, or with ``pace="human"`` the
    previous episode's duration (at least ``delay_min_s``) plus 0-3 s, capped at 300 s.
    """
    if options.rest_every > 0 and network_attempts % options.rest_every == 0:
        return REST, rng.uniform(options.rest_min_s, options.rest_max_s)
    if options.pace == "human":
        watched = float(previous.duration_s or 0) if previous is not None else 0.0
        pause = max(options.delay_min_s, watched) + rng.uniform(0.0, HUMAN_JITTER_S)
        return PACE, min(pause, MAX_HUMAN_PAUSE_S)
    return PACE, rng.uniform(options.delay_min_s, options.delay_max_s)


# --------------------------------------------------------------------------- download_series


def download_series(
    series: Series,
    episodes: list[Episode],
    options: DownloadOptions,
    *,
    downloader: Downloader | None = None,
    manifest: Manifest | None = None,
    on_result: Callable[[DownloadResult], None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    rng: random.Random | None = None,
    on_pause: Callable[[str, float], None] | None = None,
    pacing: PacingState | None = None,
    clock: Callable[[], float] = time.monotonic,
    on_stop: Callable[[str], None] | None = None,
) -> list[DownloadResult]:
    """Download the given episodes of a series, one at a time, ascending, resumably, paced.

    Validates the pacing options, the name format, the thumbnail mode and the quality mode first
    (ValueError, see :func:`validate_pacing`, :func:`validate_naming`, :func:`validate_thumbnail`
    and :func:`validate_quality`), then creates the series directory, loads
    its manifest (unless one is given), builds the downloader for ``options.engine`` (unless one
    is given; see :func:`make_downloader`) and, for each episode: an episode the manifest says is
    done (file still present) is skipped without network unless ``options.overwrite``; one an
    earlier run's download found protected by DRM (``Manifest.drm_protected``: the verdict of a
    file or of yt-dlp, never a payload flag) is ``skipped-locked`` with
    :data:`~dramafetch.models.DRM_REMEMBERED_MESSAGE` — no request, no pause, nothing counted:
    retrying cannot change that verdict — unless ``options.include_locked``; otherwise
    the downloader runs with ``options.out_dir`` replaced by the series directory and
    ``options.series_name`` set to the series' display name (what ``{series}`` in the name format
    expands to).

    Pacing: before every NETWORK attempt except the first the run pauses (see :func:`_next_pause`):
    a longer rest after every ``rest_every`` attempts, else the fixed or "human" pace. On top of
    that the RUN's pacing (``pacing``, a :class:`PacingState` shared by every series of a batch;
    a fresh one when not given, measured with ``clock``): when ``long_rest_every`` network
    attempts of the run have been made the long break (``"long-rest"``,
    ``long_rest_min_s``-``long_rest_max_s``) replaces the pause of that step — also before the
    first attempt of a series —, and an idle gap of ``long_rest_min_s`` counts as that break.
    Each pause is announced through ``on_pause(kind, seconds)`` (``kind`` is ``"pace"``,
    ``"rest"`` or ``"long-rest"``) and then slept with ``sleep``; skips (manifest, locked,
    existing file, dry run) never pause and never count. A zero-length pause is neither
    announced nor slept.

    Early stops: a FAILED_LOGIN, FAILED_RATE_LIMITED or FAILED_BLOCKED result stops the run, and
    so do ``max_consecutive_failures`` FAILED/FAILED_UNAVAILABLE results in a row — the RUN's
    streak, ``pacing.consecutive_failures``, so it spans the series of a batch (a DONE resets the
    count, skips neither count nor reset, a stop starts it again). A FAILED_RATE_LIMITED or
    FAILED_BLOCKED result is also recorded as the global cooldown, once per run, before the rest is
    marked (:func:`record_block_if_refused` with ``options.engine`` as the source). Right before
    every network attempt, after its pause, the cooldown is asked again (:func:`check_cooldown`):
    one recorded meanwhile — by another DramaFetch process or a resolve of the web server, during
    a long break, say — stops the run there, that episode included, as FAILED_RATE_LIMITED with
    ``"stopped: cooldown until HH:MM"`` (not recorded again). The remaining episodes that would
    have needed the network get the stopping status (FAILED for the failure streak) with the
    message ``"stopped: <reason>"`` without contacting TikTok; done, locked and already-present
    ones keep their skips. ``on_stop(summary)`` is then called once with the short reason
    (``"episode 2 failed-rate-limited"``, ``"3 consecutive failures"``, ``"cooldown until
    14:32"``) — also when the streak is reached on the last episode, where no row is left to mark.
    Every result is recorded in the manifest and passed to ``on_result``. A cookies file yt-dlp
    would complain about (see :func:`dramafetch.downloader.cookies_file_problem`) is checked once
    up front: every episode that would have needed the network is FAILED with that message, with
    no pauses and no failure counted. Whatever happens, a downloader with a ``close()`` is closed
    at the end.
    """
    validate_download_options(options)
    target_dir = series_dir(options.out_dir, series)
    target_dir.mkdir(parents=True, exist_ok=True)
    if manifest is None:
        manifest = Manifest.load(manifest_path(target_dir), series.series_id, series.name)
    if downloader is None:
        downloader = make_downloader(options)
    if rng is None:
        rng = random.Random()
    if pacing is None:
        pacing = PacingState()
    episode_options = replace(options, out_dir=target_dir, series_name=series.display_name)
    cookie_problem = None if options.dry_run else cookies_file_problem(options.cookies_file)
    ordered = sorted(episodes, key=lambda episode: episode.number)
    results: list[DownloadResult] = []

    def emit(result: DownloadResult) -> None:
        results.append(result)
        manifest.record(result)
        if on_result is not None:
            on_result(result)

    def stop(remaining: list[Episode], status: DownloadStatus, reason: str, summary: str) -> None:
        """Mark ``remaining`` (``stopped: <reason>``, or the skip each would have had anyway),
        forget the run's failure streak — the stop has been acted on — and tell ``on_stop``."""
        for episode in remaining:
            emit(_stopped_result(episode, status, reason, episode_options, manifest))
        pacing.consecutive_failures = 0
        if on_stop is not None:
            on_stop(summary)

    network_attempts = 0
    previous_network_episode: Episode | None = None
    try:
        for index, episode in enumerate(ordered):
            done_path = None if options.overwrite else manifest.done_path(episode.number)
            if done_path is not None:
                emit(_manifest_skip(episode, done_path))
                continue
            if not options.include_locked and manifest.drm_protected(episode.number):
                # an earlier run found it encrypted: no request, no pause, nothing counted
                emit(_drm_memory_skip(episode))
                continue
            needs_network = _needs_network(episode, episode_options)
            if needs_network and cookie_problem is not None:
                emit(
                    DownloadResult(
                        episode=episode, status=DownloadStatus.FAILED, message=cookie_problem
                    )
                )
                continue
            if needs_network:
                kind, pause = _pause_before_attempt(
                    options, rng, pacing, clock, network_attempts, previous_network_episode
                )
                if pause > 0:
                    if on_pause is not None:
                        on_pause(kind, pause)
                    sleep(pause)
                if (active := check_cooldown()) is not None:
                    # TikTok refused a request meanwhile — another DramaFetch process, a resolve
                    # of the web server — maybe during that very pause (the 15-30 min long break
                    # included): not one more request until the cooldown ends. Already recorded.
                    summary = f"cooldown until {clock_time(active.until)}"
                    stop(ordered[index:], DownloadStatus.FAILED_RATE_LIMITED, summary, summary)
                    break
            result = downloader.download(episode, episode_options)
            emit(result)
            if result.status not in NO_NETWORK_STATUSES:
                network_attempts += 1
                previous_network_episode = episode
                pacing.run_attempts += 1
                pacing.last_network_at = clock()
            if result.status in _STOP_STATUSES:
                summary = f"episode {episode.number} {result.status.value}"
                reason = f"{summary}: {result.message}" if result.message else summary
                record_block_if_refused(result, options.engine)
                stop(ordered[index + 1 :], result.status, reason, summary)
                break
            if result.status in _COUNTED_FAILURES:
                pacing.consecutive_failures += 1  # the RUN's streak: it spans the series
                if 0 < options.max_consecutive_failures <= pacing.consecutive_failures:
                    last = result.message or result.status.value
                    summary = f"{pacing.consecutive_failures} consecutive failures"
                    reason = f"{summary} (last: {last})"
                    stop(ordered[index + 1 :], DownloadStatus.FAILED, reason, summary)
                    break
            elif result.status is DownloadStatus.DONE:
                pacing.consecutive_failures = 0
    finally:
        close_downloader(downloader)
    return results


def validate_download_options(options: DownloadOptions) -> None:
    """All four checks :func:`download_series` makes before anything touches the disk
    (:func:`validate_pacing`, :func:`validate_naming`, :func:`validate_thumbnail`,
    :func:`validate_quality`); :func:`run_batch` makes them before its first request."""
    validate_pacing(options)
    validate_naming(options)
    validate_thumbnail(options)
    validate_quality(options)


def _needs_network(episode: Episode, options: DownloadOptions) -> bool:
    """Whether a downloader would contact TikTok for this episode (both engines share the skip
    rules: locked unless ``include_locked``, dry run, an existing complete file)."""
    if episode.locked and not options.include_locked:
        return False
    if options.dry_run:
        return False
    return options.overwrite or existing_episode_file(options.out_dir, episode, options) is None


def _manifest_skip(episode: Episode, done_path: Path) -> DownloadResult:
    return DownloadResult(
        episode=episode,
        status=DownloadStatus.SKIPPED_EXISTS,
        path=done_path,
        message=f"{MANIFEST_SKIP_PREFIX}{done_path.name}",
    )


def _drm_memory_skip(episode: Episode) -> DownloadResult:
    """``skipped-locked`` with :data:`~dramafetch.models.DRM_REMEMBERED_MESSAGE`: the manifest says
    an earlier run's download found the episode protected by DRM (the message is one
    ``Manifest.drm_protected`` reads back, so the memory stays)."""
    return DownloadResult(
        episode=episode, status=DownloadStatus.SKIPPED_LOCKED, message=DRM_REMEMBERED_MESSAGE
    )


def _stopped_result(
    episode: Episode,
    status: DownloadStatus,
    reason: str,
    options: DownloadOptions,
    manifest: Manifest,
) -> DownloadResult:
    """The result for an episode the run gave up on before reaching it: the skip it would have had
    anyway — done in the manifest, remembered as DRM-protected, locked, its file already in
    ``options.out_dir`` (the series directory; an encrypted one is deleted and FAILED_UNAVAILABLE,
    as both downloaders do: ``downloader.existing_file_result``) — or ``status`` with
    ``"stopped: <reason>"``. Mirrors :func:`download_series` and :func:`_needs_network` (so a stop
    never overwrites the DRM memory of an episode with a ``stopped`` entry)."""
    done_path = None if options.overwrite else manifest.done_path(episode.number)
    if done_path is not None:
        return _manifest_skip(episode, done_path)
    if not options.include_locked and manifest.drm_protected(episode.number):
        return _drm_memory_skip(episode)
    if episode.locked and not options.include_locked:
        return locked_result(episode)
    existing = (
        None if options.overwrite else existing_episode_file(options.out_dir, episode, options)
    )
    if existing is not None:  # skipped-exists, or deleted as encrypted: what a downloader says
        return existing_file_result(episode, existing, options)
    return DownloadResult(episode=episode, status=status, message=f"{STOPPED_PREFIX}{reason}")


def summarize(results: list[DownloadResult]) -> dict[str, int]:
    """``{"done": 3, "skipped-locked": 1, ...}`` — statuses that occurred, in enum order."""
    counts = dict.fromkeys(DownloadStatus, 0)
    for result in results:
        counts[result.status] += 1
    return {status.value: count for status, count in counts.items() if count}


def exit_code(results: list[DownloadResult]) -> int:
    """0 when all ok; 3 on any login failure; 5 when blocked (HTTP 403) or rate limited (HTTP
    429); 2 on other failures."""
    statuses = {result.status for result in results}
    if DownloadStatus.FAILED_LOGIN in statuses:
        return EXIT_LOGIN_REQUIRED
    if statuses & {DownloadStatus.FAILED_RATE_LIMITED, DownloadStatus.FAILED_BLOCKED}:
        return EXIT_RATE_LIMITED
    if any(not status.ok for status in statuses):
        return EXIT_FAILED
    return EXIT_OK


def episode_to_dict(episode: Episode) -> dict[str, Any]:
    """JSON-friendly view of an episode (no raw payload)."""
    return {
        "number": episode.number,
        "item_id": episode.item_id,
        "title": episode.title,
        "series_id": episode.series_id,
        "series_name": episode.series_name,
        "author": episode.author,
        "duration_s": episode.duration_s,
        "access": episode.access,
        "paid": episode.paid,
        "drm": episode.drm,
        "locked": episode.locked,
        "lock_hints": list(episode.lock_hints),
        "page_url": episode.page_url,
        "cover_url": episode.cover_url,
        "quality_hint": episode.quality_hint,
    }


def series_to_dict(series: Series) -> dict[str, Any]:
    """JSON-friendly view of a series, episodes ascending."""
    return {
        "series_id": series.series_id,
        "name": series.name,
        "total_hint": series.total_hint,
        "warnings": list(series.warnings),
        "episodes": [
            episode_to_dict(episode)
            for episode in sorted(series.episodes, key=lambda episode: episode.number)
        ],
    }


def result_to_dict(result: DownloadResult) -> dict[str, Any]:
    """JSON-friendly view of a download result (``status`` is the enum value, e.g.
    ``"failed-blocked"``)."""
    return {
        "number": result.episode.number,
        "item_id": result.episode.item_id,
        "title": result.episode.title,
        "status": result.status.value,
        "message": result.message,
        "path": str(result.path) if result.path is not None else None,
    }


# --------------------------------------------------------------------------- series reports


@dataclass(frozen=True)
class SeriesReport:
    """How complete a series is after a run of it (:func:`series_report`, :func:`report_line`).

    The counts are per episode number: ``done`` downloaded in this run, ``on_disk`` already there
    (``skipped-exists``: the manifest or the file), ``locked`` skipped as locked, ``failed`` every
    ``failed-*`` status (``stopped: …`` included). ``listed`` is the length of TikTok's list (0
    when the series was skipped as complete: see ``on_disk``) and ``gaps`` the numbers missing
    from it between 1 and ``max(highest listed number, total_hint)``. ``complete``: something is
    listed, every listed episode that can be downloaded is done or on disk — every one that is
    not ``locked`` and was not skipped as locked by the run (``skipped-locked``: an episode an
    earlier run's download found protected by DRM, which the manifest remembers, although its
    payload reads as playable) —, nothing failed, no gaps, and as many listed as TikTok announced
    (when it announced a total) — or the series was skipped as complete (``skipped_complete``: its
    manifest said so less than ``RECHECK_AFTER_S`` ago and every file is still there; no request
    was made; ``locked`` then counts the episodes its manifest recorded ``skipped-locked``).
    ``stopped`` says why the run stopped in this series (a stop status, a failure streak, a
    cooldown, a failed resolve), shortly.

    The fields after ``stopped`` complete the picture for :func:`report_line`: ``total`` (the
    episodes the series has as far as anyone knows: the largest of the count listed, the highest
    number listed and TikTok's total — for a skipped series, the episodes on disk), the numbers
    behind ``locked`` and ``failed``, TikTok's announced ``total_hint``, for a series skipped as
    complete how long ago its manifest found it complete (``checked_ago_s``), and ``unlocked`` /
    ``unlocked_numbers``: the episodes done or on disk in this run whose ``Episode.access`` is
    ``"unlocked"`` — paid episodes the user's own account unlocked.
    """

    series_id: str
    name: str | None
    listed: int
    done: int
    on_disk: int
    locked: int
    failed: int
    gaps: tuple[int, ...]
    complete: bool
    skipped_complete: bool
    stopped: str | None
    total: int = 0
    locked_numbers: tuple[int, ...] = ()
    failed_numbers: tuple[int, ...] = ()
    total_hint: int | None = None
    checked_ago_s: float | None = None
    unlocked: int = 0
    unlocked_numbers: tuple[int, ...] = ()


def series_report(
    series: Series | None,
    results: list[DownloadResult],
    *,
    skipped_complete: bool = False,
    stopped: str | None = None,
    series_id: str | None = None,
    name: str | None = None,
    checked_ago_s: float | None = None,
) -> SeriesReport:
    """The :class:`SeriesReport` of a series and the results of its run.

    ``series`` is None when it was never resolved (skipped as complete, refused by a cooldown, a
    failed resolve, not started); the id and name then come from ``series_id`` / ``name``, else
    from the first result's episode. The gaps are computed up to :data:`MAX_EPISODE_NUMBER` at
    most, so an absurd episode number in a payload costs nothing.
    """
    first = results[0].episode if results else None
    if series is not None:
        report_id, report_name = series.series_id, series.name
    else:
        report_id = series_id or (first.series_id if first is not None else "")
        report_name = name if name is not None else (first.series_name if first else None)
    rows: dict[int, DownloadResult] = {}
    for result in results:
        rows[result.episode.number] = result
    statuses = {number: row.status for number, row in rows.items()}
    done = sorted(n for n, status in statuses.items() if status is DownloadStatus.DONE)
    on_disk = sorted(n for n, status in statuses.items() if status is DownloadStatus.SKIPPED_EXISTS)
    locked = sorted(n for n, status in statuses.items() if status is DownloadStatus.SKIPPED_LOCKED)
    failed = sorted(n for n, status in statuses.items() if not status.ok)
    # paid episodes the user's own account unlocked, among those obtained (downloaded or on disk)
    unlocked = tuple(n for n in sorted({*done, *on_disk}) if rows[n].episode.access == "unlocked")
    if series is None:
        return SeriesReport(
            series_id=report_id,
            name=report_name,
            listed=0,
            done=len(done),
            on_disk=len(on_disk),
            locked=len(locked),
            failed=len(failed),
            gaps=(),
            complete=skipped_complete,
            skipped_complete=skipped_complete,
            stopped=stopped,
            total=len(done) + len(on_disk) if skipped_complete else 0,
            locked_numbers=tuple(locked),
            failed_numbers=tuple(failed),
            checked_ago_s=checked_ago_s,
            unlocked=len(unlocked),
            unlocked_numbers=unlocked,
        )
    numbers = {episode.number for episode in series.episodes}
    listed = len(series.episodes)
    hint = series.total_hint if series.total_hint and series.total_hint > 0 else None
    highest = max(max(numbers, default=0), hint or 0)
    gaps = tuple(n for n in range(1, min(highest, MAX_EPISODE_NUMBER) + 1) if n not in numbers)
    obtained = set(done) | set(on_disk)
    # What cannot be downloaded is left out of "every downloadable episode is on disk": a locked
    # episode, and one this run skipped as locked although its payload reads as playable — a DRM
    # verdict the manifest remembers (it is counted in `locked` all the same). With
    # --include-locked such an episode is attempted instead, and a failure is a failure.
    skipped_locked = set(locked)
    complete = (
        listed > 0
        and all(
            episode.number in obtained
            for episode in series.episodes
            if not episode.locked and episode.number not in skipped_locked
        )
        and not failed
        and not gaps
        and (hint is None or listed == hint)
    )
    return SeriesReport(
        series_id=report_id,
        name=report_name,
        listed=listed,
        done=len(done),
        on_disk=len(on_disk),
        locked=len(locked),
        failed=len(failed),
        gaps=gaps,
        complete=complete,
        skipped_complete=False,
        stopped=stopped,
        total=max(listed, highest),
        locked_numbers=tuple(locked),
        failed_numbers=tuple(failed),
        total_hint=hint,
        checked_ago_s=checked_ago_s,
        unlocked=len(unlocked),
        unlocked_numbers=unlocked,
    )


def report_rows(
    series: Series, results: list[DownloadResult], manifest: Manifest | None
) -> list[DownloadResult]:
    """What the report of a run of a SELECTION counts (``download --episodes``, the web UI's
    **Download selected** and **Download all available**, which selects the free and unlocked
    episodes): ``results`` plus, for every listed episode they do not cover, a ``skipped-exists``
    row (``already downloaded (manifest): <file>``) when ``manifest`` knows it to be on disk
    (``Manifest.done_entries``: the file still there), else a ``skipped-locked`` row when the
    manifest remembers it as protected by DRM (``Manifest.drm_protected``) or it is locked. The
    report then says how complete the series is, as a whole-series run would — what an earlier
    run saved is ``already on disk`` (an unlocked one counted as such) and a locked episode
    ``locked``, not ``not downloaded``. Read-only; ``results`` itself is not changed."""
    covered = {result.episode.number for result in results}
    on_disk = dict(manifest.done_entries()) if manifest is not None else {}
    extra: list[DownloadResult] = []
    for episode in sorted(series.episodes, key=lambda episode: episode.number):
        if episode.number in covered:
            continue
        if episode.number in on_disk:
            extra.append(_manifest_skip(episode, on_disk[episode.number]))
        elif manifest is not None and manifest.drm_protected(episode.number):
            extra.append(_drm_memory_skip(episode))
        elif episode.locked:
            extra.append(locked_result(episode))
    return [*results, *extra]


#: At most this many ranges of numbers in a report line; the rest becomes "…".
_MAX_REPORT_RANGES = 10


def _numbers_text(numbers: tuple[int, ...] | list[int]) -> str:
    """``(5, 6)`` -> ``"5, 6"``, ``(1, 2, 3, 9)`` -> ``"1-3, 9"``: runs of three or more as ranges,
    at most :data:`_MAX_REPORT_RANGES` of them."""
    parts: list[str] = []
    for low, high in compress_ranges(sorted(set(numbers))):
        if low == high:
            parts.append(str(low))
        elif high == low + 1:
            parts.extend((str(low), str(high)))
        else:
            parts.append(f"{low}-{high}")
    if len(parts) > _MAX_REPORT_RANGES:
        parts = [*parts[:_MAX_REPORT_RANGES], "…"]
    return ", ".join(parts)


def _ago(seconds: float) -> str:
    """``"just now"``, ``"5 min ago"``, ``"2 h ago"``."""
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{int(seconds // 60)} min ago"
    return f"{int(seconds // 3600)} h ago"


def report_line(report: SeriesReport) -> str:
    """One line on how complete a series is, e.g.::

        complete: 30 of 30 (28 downloaded, 2 already on disk)
        complete, nothing to do: 30 episodes already on disk (checked 2 h ago)
        incomplete: 26 of 30 — 2 locked (5, 6), 1 failed (12); episode 17 missing from TikTok's list

    A complete series with locked episodes says so (``complete: 28 of 30 (28 downloaded) — 2
    locked (5, 6)``), and so do the paid episodes the user's own account unlocked, named before
    the locked ones (``complete: 3 of 4 (3 downloaded) — 1 paid episode your account unlocked
    (3), 1 locked (4)``); an incomplete one lists the unlocked, locked, failed and not downloaded
    episodes, the gaps in TikTok's list, a total TikTok exceeded, and why the run stopped. A series
    skipped as complete while its manifest recorded locked episodes points at ``--recheck``
    (``complete, nothing to do: 3 episodes already on disk, 1 locked (4) (checked 2 h ago) —
    unlocked more in the TikTok app since? --recheck looks again``)."""
    locked = f"{report.locked} locked ({_numbers_text(report.locked_numbers)})"
    if report.skipped_complete:
        noun = "episode" if report.on_disk == 1 else "episodes"
        line = f"complete, nothing to do: {report.on_disk} {noun} already on disk"
        if report.locked:
            line += f", {locked}"
        if report.checked_ago_s is not None:
            line += f" (checked {_ago(report.checked_ago_s)})"
        if report.locked:
            line += f" — {RECHECK_HINT}"
        return line
    have = report.done + report.on_disk
    total = max(report.total, have)
    noun = "episode" if report.unlocked == 1 else "episodes"
    unlocked = (
        f"{report.unlocked} paid {noun} your account unlocked "
        f"({_numbers_text(report.unlocked_numbers)})"
    )
    if report.complete:
        obtained = []
        if report.done:
            obtained.append(f"{report.done} downloaded")
        if report.on_disk:
            obtained.append(f"{report.on_disk} already on disk")
        line = f"complete: {have} of {total}"
        if obtained:
            line += f" ({', '.join(obtained)})"
        notes = [unlocked] if report.unlocked else []
        if report.locked:
            notes.append(locked)
        if notes:
            line += f" — {', '.join(notes)}"
        return line
    details = []
    if report.unlocked:
        details.append(unlocked)
    if report.locked:
        details.append(locked)
    if report.failed:
        details.append(f"{report.failed} failed ({_numbers_text(report.failed_numbers)})")
    rest = report.listed - have - report.locked - report.failed
    if rest > 0:
        details.append(f"{rest} not downloaded")
    groups = [", ".join(details)] if details else []
    if report.gaps:
        noun = "episode" if len(report.gaps) == 1 else "episodes"
        groups.append(f"{noun} {_numbers_text(report.gaps)} missing from TikTok's list")
    if report.total_hint and report.listed > report.total_hint:
        groups.append(f"TikTok announces {report.total_hint} episodes, {report.listed} listed")
    if report.listed == 0:
        groups.append("no episodes listed")
    if report.stopped:
        groups.append(f"stopped: {report.stopped}")
    line = f"incomplete: {have} of {total}"
    if groups:
        line += " — " + "; ".join(groups)
    return line


def report_to_dict(report: SeriesReport) -> dict[str, Any]:
    """JSON-friendly view of a :class:`SeriesReport` (tuples become lists) plus its
    :func:`report_line` as ``"line"``."""
    return {
        "series_id": report.series_id,
        "name": report.name,
        "listed": report.listed,
        "done": report.done,
        "on_disk": report.on_disk,
        "locked": report.locked,
        "failed": report.failed,
        "gaps": list(report.gaps),
        "complete": report.complete,
        "skipped_complete": report.skipped_complete,
        "stopped": report.stopped,
        "total": report.total,
        "locked_numbers": list(report.locked_numbers),
        "failed_numbers": list(report.failed_numbers),
        "total_hint": report.total_hint,
        "checked_ago_s": report.checked_ago_s,
        "unlocked": report.unlocked,
        "unlocked_numbers": list(report.unlocked_numbers),
        "line": report_line(report),
    }


# --------------------------------------------------------------------------- series runs & batches


@dataclass(frozen=True)
class SeriesStart:
    """What :func:`run_series` hands ``on_start`` once it knows what it will do with a series, and
    before any row: the resolved ``series`` and the ``episodes`` it will download (an empty list
    when nothing is listed or nothing matches the episodes spec), or — ``skipped_complete`` — no
    series and the episodes rebuilt from the manifest. ``name`` is the display name (from the list,
    else the manifest) and ``directory`` where the files are."""

    ref: SeriesRef
    series: Series | None
    name: str
    directory: Path
    episodes: list[Episode]
    skipped_complete: bool = False


@dataclass
class SeriesRun:
    """The outcome of one series of a batch (:func:`run_series`).

    ``series`` is None when the series was skipped as complete, refused by a cooldown, its resolve
    failed or the batch stopped before it. ``error`` is the resolve / cooldown / "not started"
    text (token-free, printable), None when the series ran; ``error_kind`` names it (one of
    :data:`ERROR_KINDS`). ``stop`` is True when this series ended the batch: a cooldown (also one
    met right before an episode), a failed resolve, a stop status (login, 403, 429), a failure
    streak or a malformed cookies file. ``contacted`` is True when the
    series made at least one request to TikTok (its list was resolved, successfully or not).
    """

    ref: SeriesRef
    series: Series | None
    results: list[DownloadResult]
    report: SeriesReport
    error: str | None
    stop: bool
    exit_code: int
    error_kind: str | None = None
    contacted: bool = False


def find_series_dir(out_dir: Path, series_id: str) -> Path | None:
    """The directory of ``out_dir`` holding a series' files: the child whose name ends with
    ``" [<series_id>]"`` (``iterdir`` and ``str.endswith``, never a glob: ``[`` is special in
    globs and series names contain it) and that holds a ``dramafetch.json`` for that id. When a
    renamed series left several, the one whose manifest was written last wins. Read-only: no
    directory is created, no manifest moved; None when there is none (or ``out_dir`` is missing).
    """
    suffix = f" [{series_id}]"
    best: tuple[float, str, Path] | None = None
    try:
        children = sorted(out_dir.iterdir())
    except OSError:
        return None
    for child in children:
        if not child.name.endswith(suffix):
            continue
        try:
            if not child.is_dir():
                continue
            written = manifest_path(child).stat().st_mtime
        except OSError:
            continue
        if read_manifest(child, series_id) is None:
            continue
        if best is None or (written, child.name) > best[:2]:
            best = (written, child.name, child)
    return best[2] if best is not None else None


def on_disk_numbers(out_dir: Path, series_id: str, directory: Path | None = None) -> set[int]:
    """Episode numbers of a series that are on disk according to its manifest
    (``Manifest.done_entries``: recorded done or found on disk, and the file still there).
    Read-only; an empty set when there is no manifest.

    ``directory`` is the series directory to read — ``info`` and the web's badges pass the one a
    download would use, ``manifest.series_dir(out_dir, series)``, so that an episode shown as on
    disk is one the download skips without a request (a renamed series' old folder is not where
    the download goes); without it, the directory :func:`find_series_dir` finds by id."""
    if directory is None:
        directory = find_series_dir(out_dir, series_id)
    manifest = read_manifest(directory, series_id) if directory is not None else None
    if manifest is None:
        return set()
    return {number for number, _ in manifest.done_entries()}


def dedupe_refs(refs: list[SeriesRef]) -> tuple[list[SeriesRef], list[str]]:
    """The refs without repeated series (the first occurrence of each ``series_id`` is kept, in
    order) and one note per dropped one: ``"duplicate: <series id>"``."""
    kept: list[SeriesRef] = []
    notes: list[str] = []
    seen: set[str] = set()
    for ref in refs:
        if ref.series_id in seen:
            notes.append(f"duplicate: {ref.series_id}")
            continue
        seen.add(ref.series_id)
        kept.append(ref)
    return kept, notes


def batch_exit_code(runs: list[SeriesRun]) -> int:
    """The worst exit code of a batch: 5 (blocked, rate limited, a cooldown) > 3 (login) > 4 (the
    list could not be fetched) > 2 (some episode failed) > 0; 0 for an empty batch."""
    worst = EXIT_OK
    for run in runs:
        if _EXIT_SEVERITY.get(run.exit_code, 1) > _EXIT_SEVERITY.get(worst, 1):
            worst = run.exit_code
    return worst


def not_started_message(stopping: SeriesRun) -> str:
    """``not started: batch stopped in <name or id> (<reason>)`` — the error of every series a
    stop left untouched (the web's cancelled jobs say the same)."""
    where = stopping.report.name or (stopping.series.name if stopping.series else None)
    reason = stopping.report.stopped or stopping.error or "stopped"
    return f"not started: batch stopped in {where or stopping.ref.series_id} ({reason})"


def _not_started(ref: SeriesRef, stopping: SeriesRun) -> SeriesRun:
    return SeriesRun(
        ref=ref,
        series=None,
        results=[],
        report=series_report(None, [], series_id=ref.series_id),
        error=not_started_message(stopping),
        stop=False,
        exit_code=stopping.exit_code,
        error_kind="not-started",
    )


#: Resolve errors -> (error kind, exit code, short reason for the report), most specific first.
_RESOLVE_ERRORS: tuple[tuple[type[DiscoveryError], str, int, str], ...] = (
    (LoginRequiredError, "login", EXIT_LOGIN_REQUIRED, "login required"),
    (ChallengeError, "captcha", EXIT_DISCOVERY, "captcha"),
    (RateLimitedError, "rate-limited", EXIT_RATE_LIMITED, "rate limited (HTTP 429)"),
    (DiscoveryError, "discovery", EXIT_DISCOVERY, "the episode list could not be fetched"),
)


def _resolve_failure(ref: SeriesRef, exc: DiscoveryError) -> SeriesRun:
    kind, code, reason = "discovery", EXIT_DISCOVERY, "the episode list could not be fetched"
    for error_type, error_kind, error_code, error_reason in _RESOLVE_ERRORS:
        if isinstance(exc, error_type):
            kind, code, reason = error_kind, error_code, error_reason
            break
    return SeriesRun(
        ref=ref,
        series=None,
        results=[],
        report=series_report(None, [], series_id=ref.series_id, stopped=reason),
        error=str(exc) or type(exc).__name__,
        stop=True,
        exit_code=code,
        error_kind=kind,
        contacted=True,
    )


def _cooldown_refusal(ref: SeriesRef, cooldown: Cooldown) -> SeriesRun:
    reason = f"cooldown until {clock_time(cooldown.until)}"
    return SeriesRun(
        ref=ref,
        series=None,
        results=[],
        report=series_report(None, [], series_id=ref.series_id, stopped=reason),
        error=cooldown_message(cooldown),
        stop=True,
        exit_code=EXIT_RATE_LIMITED,
        error_kind="cooldown",
    )


def _complete_skip_allowed(episodes_spec: str | None, options: DownloadOptions) -> bool:
    """The complete skip applies to a whole-series run only: never with an episodes spec (any,
    even ``"all"``), ``recheck``, ``overwrite``, ``include_locked`` or ``dry_run``."""
    if episodes_spec is not None:
        return False
    return not (options.recheck or options.overwrite or options.include_locked or options.dry_run)


def _skip_if_complete(
    ref: SeriesRef, options: DownloadOptions, wall_clock: Callable[[], float]
) -> tuple[SeriesRun, SeriesStart] | None:
    """The run of a series its manifest says was complete less than ``RECHECK_AFTER_S`` ago with
    every file it counted still on disk — rows rebuilt from the manifest, no request — or None
    when anything is missing, stale or unreadable (then the series is resolved as usual). The
    entries the manifest recorded ``skipped-locked`` become the report's ``locked`` /
    ``locked_numbers`` (no rows), so its line can say that ``--recheck`` looks again: the user may
    have unlocked them in the TikTok app since."""
    directory = find_series_dir(options.out_dir, ref.series_id)
    if directory is None:
        return None
    manifest = read_manifest(directory, ref.series_id)
    if manifest is None or manifest.complete_episodes is None:
        return None
    since = manifest.complete_since()
    if since is None:
        return None
    age = wall_clock() - since
    if not 0 <= age < RECHECK_AFTER_S:
        return None
    if manifest.missing_files():
        return None  # a file was deleted or moved: download it again
    entries = manifest.done_entries()
    if not entries or len(entries) < manifest.complete_episodes:
        return None
    name = manifest.series_name
    results = []
    for number, path in entries:
        episode = Episode(
            number=number,
            item_id=manifest.entries[number].item_id,
            title=path.stem,
            series_id=ref.series_id,
            series_name=name,
        )
        results.append(_manifest_skip(episode, path))
    report = series_report(
        None,
        results,
        skipped_complete=True,
        series_id=ref.series_id,
        name=name,
        checked_ago_s=age,
    )
    on_disk = {number for number, _ in entries}
    still_locked = tuple(n for n in manifest.locked_numbers() if n not in on_disk)
    if still_locked:
        report = replace(report, locked=len(still_locked), locked_numbers=still_locked)
    run = SeriesRun(
        ref=ref,
        series=None,
        results=results,
        report=report,
        error=None,
        stop=False,
        exit_code=EXIT_OK,
    )
    start = SeriesStart(
        ref=ref,
        series=None,
        name=name or f"series-{ref.series_id}",
        directory=directory,
        episodes=[result.episode for result in results],
        skipped_complete=True,
    )
    return run, start


def run_series(
    ref: SeriesRef,
    discovery_options: DiscoveryOptions,
    download_options: DownloadOptions,
    *,
    episodes_spec: str | None = None,
    discovery: Discovery | None = None,
    downloader: Downloader | None = None,
    on_result: Callable[[DownloadResult], None] | None = None,
    on_pause: Callable[[str, float], None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    rng: random.Random | None = None,
    pacing: PacingState | None = None,
    clock: Callable[[], float] = time.monotonic,
    wall_clock: Callable[[], float] = time.time,
    on_start: Callable[[SeriesStart], None] | None = None,
    before_network: Callable[[], None] | None = None,
) -> SeriesRun:
    """One series, start to finish, resolved right before its downloads.

    1. A cooldown in force (:func:`check_cooldown`) -> ``error`` = the cooldown message, ``stop``,
       exit 5, no request.
    2. The complete skip (only without an episodes spec and without ``recheck`` / ``overwrite`` /
       ``include_locked`` / ``dry_run``): the manifest found by :func:`find_series_dir`, read
       without side effects, says the series was complete less than ``RECHECK_AFTER_S`` before
       ``wall_clock()`` and every file it counted is still on disk -> its rows rebuilt from the
       manifest (``skipped-exists``, ``already downloaded (manifest): <file>``), passed to
       ``on_result``, ``report.skipped_complete``, no request. Anything missing -> step 3.
       Then, unless it is a dry run, a cookies file every download would refuse
       (:func:`~dramafetch.downloader.cookies_file_problem`: malformed lines yt-dlp would print)
       -> ``error`` = that problem, ``error_kind`` ``"cookies"``, ``stop``, exit 2, no request —
       not one list load per series for downloads that cannot happen.
    3. ``before_network()`` (:func:`run_batch` rests there), the cooldown asked again, then
       :func:`resolve` (which records a refusal as the cooldown). A discovery error -> ``error``,
       ``stop``, exit 3 (login), 4 (captcha, anything else) or 5 (HTTP 429). Zero episodes listed
       -> ``error`` "no episodes listed", no stop, exit 4.
    4. :func:`select_episodes` and :func:`download_series` with ``pacing`` / ``clock`` / ``sleep`` /
       ``rng``; ``on_start`` is called first (also for an empty selection, which downloads
       nothing).
    5. The report; ``stop`` when a stop status occurred or the failure streak stopped the series.
       With an episodes spec the report also counts the listed episodes outside the selection
       that the manifest knows to be on disk (:func:`report_rows`); ``results`` stays the rows
       of the run.
    6. A whole-series run (no episodes spec, no dry run) that found the series complete marks its
       manifest complete (``wall_clock()``, done + on disk); one that found it incomplete forgets
       an older mark.
    """
    parse_episode_spec(episodes_spec)  # a bad spec is a ValueError before any request
    if (cooldown := check_cooldown()) is not None:
        return _cooldown_refusal(ref, cooldown)
    if _complete_skip_allowed(episodes_spec, download_options):
        skipped = _skip_if_complete(ref, download_options, wall_clock)
        if skipped is not None:
            run, start = skipped
            if on_start is not None:
                on_start(start)
            if on_result is not None:
                for result in run.results:
                    on_result(result)
            return run
    if not download_options.dry_run and (
        problem := cookies_file_problem(download_options.cookies_file)
    ):
        return SeriesRun(
            ref=ref,
            series=None,
            results=[],
            report=series_report(None, [], series_id=ref.series_id, stopped=COOKIES_STOP),
            error=problem,
            stop=True,
            exit_code=EXIT_FAILED,
            error_kind="cookies",
        )
    if before_network is not None:
        before_network()
        if (cooldown := check_cooldown()) is not None:  # another process may have met a refusal
            return _cooldown_refusal(ref, cooldown)
    try:
        series = resolve(ref, discovery_options, discovery)
    except DiscoveryError as exc:
        return _resolve_failure(ref, exc)
    selected = select_episodes(series, episodes_spec) if series.episodes else []
    directory = series_dir(download_options.out_dir, series)
    if on_start is not None:
        on_start(SeriesStart(ref, series, series.display_name, directory, selected))
    if not series.episodes:
        return SeriesRun(
            ref=ref,
            series=series,
            results=[],
            report=series_report(series, []),
            error="no episodes listed",
            stop=False,
            exit_code=EXIT_DISCOVERY,
            error_kind="empty",
            contacted=True,
        )
    if not selected:
        return SeriesRun(
            ref=ref,
            series=series,
            results=[],
            report=series_report(series, []),
            error=None,
            stop=False,
            exit_code=EXIT_OK,
            contacted=True,
        )
    manifest = Manifest.load(manifest_path(directory), series.series_id, series.name)
    stops: list[str] = []
    results = download_series(
        series,
        selected,
        download_options,
        downloader=downloader,
        manifest=manifest,
        on_result=on_result,
        sleep=sleep,
        rng=rng,
        on_pause=on_pause,
        pacing=pacing,
        clock=clock,
        on_stop=stops.append,
    )
    stopped = stops[0] if stops else _stop_status_summary(results)
    # A selection's report covers the whole series: what an earlier run saved counts as on disk.
    counted = results if episodes_spec is None else report_rows(series, results, manifest)
    report = series_report(series, counted, stopped=stopped)
    if episodes_spec is None and not download_options.dry_run:
        if report.complete:
            manifest.mark_complete(wall_clock(), report.done + report.on_disk)
        elif manifest.complete_at is not None:
            manifest.clear_complete()
    return SeriesRun(
        ref=ref,
        series=series,
        results=results,
        report=report,
        error=None,
        stop=stopped is not None,
        exit_code=exit_code(results),
        contacted=True,
    )


def _stop_status_summary(results: list[DownloadResult]) -> str | None:
    """``"episode N <status>"`` for the first stop status (login, 403, 429) among the results,
    None without one: a stop the engine did not report through ``on_stop`` (a replaced
    ``download_series``) still ends the batch."""
    for result in results:
        if result.status in _STOP_STATUSES:
            return f"episode {result.episode.number} {result.status.value}"
    return None


def _pause_between_series(
    options: DownloadOptions,
    rng: random.Random,
    pacing: PacingState,
    clock: Callable[[], float],
    on_pause: Callable[[str, float], None] | None,
    sleep: Callable[[float], None],
) -> None:
    """Before a series that will contact TikTok when an earlier one of the batch did: the rest
    between series (``rest_min_s``-``rest_max_s``, like every ``rest_every`` episodes) — or, when
    the run's long break is due, the long break instead, taken BEFORE the resolve so that the
    fresh play URLs do not wait 15-30 minutes (the count then starts again)."""
    if long_rest_due(options, pacing, clock):
        kind, seconds = LONG_REST, rng.uniform(options.long_rest_min_s, options.long_rest_max_s)
    else:
        kind, seconds = SERIES_REST, rng.uniform(options.rest_min_s, options.rest_max_s)
    if seconds > 0:
        if on_pause is not None:
            on_pause(kind, seconds)
        sleep(seconds)
    if kind == LONG_REST:
        pacing.run_attempts = 0


def run_batch(
    refs: list[SeriesRef],
    discovery_options: DiscoveryOptions,
    download_options: DownloadOptions,
    *,
    on_series_start: Callable[[int, int, SeriesRef], None] | None = None,
    on_series_done: Callable[[int, int, SeriesRun], None] | None = None,
    on_result: Callable[[DownloadResult], None] | None = None,
    on_pause: Callable[[str, float], None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    rng: random.Random | None = None,
    pacing: PacingState | None = None,
    clock: Callable[[], float] = time.monotonic,
    wall_clock: Callable[[], float] = time.time,
    discovery: Discovery | None = None,
    downloader: Downloader | None = None,
    on_start: Callable[[SeriesStart], None] | None = None,
    episodes_spec: str | None = None,
) -> list[SeriesRun]:
    """Several series, strictly one after the other (:func:`run_series` each); ``refs`` are
    de-duplicated by the caller (:func:`dedupe_refs`). The download options are validated before
    the first request (ValueError).

    Each series is resolved right before its own downloads, never up front. Before a series that
    contacts TikTok, when an earlier series of the batch did, the batch rests
    (``on_pause("series-rest", s)`` then ``sleep(s)``, ``s`` = ``rng.uniform(rest_min_s,
    rest_max_s)``) — or takes the run's long break instead when it is due; the first series to
    contact TikTok, and a series that makes no request (skipped as complete, a cooldown), need no
    rest. One :class:`PacingState` spans the batch, so the long break spans series. After a run
    with ``stop``, every remaining series gets ``error`` = :func:`not_started_message`, the same
    exit code, no stop and NO request. ``on_series_start(index, total, ref)`` and
    ``on_series_done(index, total, run)`` (1-based) frame every series, the not started ones
    included; ``on_start`` / ``on_result`` / ``on_pause`` are passed to each :func:`run_series`.
    ``episodes_spec`` applies to every series (the CLI allows it with one series only). With
    several series, ``discovery_options.dump_dir`` (``--dump-raw DIR``) becomes ``DIR/<series
    id>`` for each of them.
    """
    validate_download_options(download_options)
    parse_episode_spec(episodes_spec)  # ValueError before the first request, not mid-batch
    if rng is None:
        rng = random.Random()
    if pacing is None:
        pacing = PacingState()
    runs: list[SeriesRun] = []
    contacted = False
    stopping: SeriesRun | None = None
    total = len(refs)
    for index, ref in enumerate(refs, start=1):
        if on_series_start is not None:
            on_series_start(index, total, ref)
        if stopping is not None:
            run = _not_started(ref, stopping)
        else:
            rest = (
                partial(
                    _pause_between_series, download_options, rng, pacing, clock, on_pause, sleep
                )
                if contacted
                else None
            )
            series_discovery = discovery_options
            if total > 1 and discovery_options.dump_dir is not None:
                # --dump-raw: each series' payloads in their own folder (fixed file names, so one
                # shared folder would mix and overwrite the series of the batch)
                series_discovery = replace(
                    discovery_options, dump_dir=discovery_options.dump_dir / ref.series_id
                )
            run = run_series(
                ref,
                series_discovery,
                download_options,
                episodes_spec=episodes_spec,
                discovery=discovery,
                downloader=downloader,
                on_result=on_result,
                on_pause=on_pause,
                sleep=sleep,
                rng=rng,
                pacing=pacing,
                clock=clock,
                wall_clock=wall_clock,
                on_start=on_start,
                before_network=rest,
            )
            contacted = contacted or run.contacted
            if run.stop:
                stopping = run
        runs.append(run)
        if on_series_done is not None:
            on_series_done(index, total, run)
    return runs
