"""The seam shared by the CLI and the web UI: resolve a series, select episodes, download them.

Pacing lives here, and it is the whole anti-bot strategy: behave like one person watching.
Episodes are downloaded one at a time in ascending order. Between two NETWORK attempts the run
pauses — a random 4-9 s by default, or with ``pace="human"`` about as long as the previous episode
lasted — and after every ``rest_every`` network attempts (failures count, skips do not) it rests
for 60-120 s. The run stops at the first sign of blocking: a login redirect, HTTP 429 (rate
limited), HTTP 403 or a captcha wall (blocked) or ``max_consecutive_failures`` failures in a row;
the remaining episodes are marked ``stopped: …`` without another request, because the right answer
is to wait 30-60 minutes and resume (the manifest remembers what is done), not to retry. Skips
never pause. The sleep function and the random source are injectable for tests. Locked episodes
are skipped, never unlocked.
"""

from __future__ import annotations

import logging
import random
import re
import time
from collections.abc import Callable
from dataclasses import replace
from typing import Any

from dramafetch.downloader import (
    YtDlpDownloader,
    cookies_file_problem,
    existing_episode_file,
    locked_result,
    sanitize_error,
)
from dramafetch.manifest import Manifest, manifest_path, series_dir, validate_name_format
from dramafetch.models import (
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
#: Blocked (HTTP 403) or rate limited (HTTP 429): wait 30-60 minutes, then run again to resume.
EXIT_RATE_LIMITED = 5

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

#: Inclusive episode-number interval; ``None`` as the upper bound means "to the last episode".
Interval = tuple[int, int | None]


def resolve(
    ref: SeriesRef, options: DiscoveryOptions, discovery: Discovery | None = None
) -> Series:
    """Resolve a series reference into its episode list.

    Without an explicit ``discovery`` the strategy comes from
    ``dramafetch.discovery.choose_discovery(options)`` (imported lazily: the discovery package
    pulls in Playwright).
    """
    if discovery is None:
        from dramafetch.discovery import choose_discovery

        discovery = choose_discovery(options)
    series = discovery.discover(ref, options)
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


def _next_pause(
    options: DownloadOptions, rng: random.Random, network_attempts: int, previous: Episode | None
) -> tuple[str, float]:
    """``(kind, seconds)`` to wait before the next network attempt, ``network_attempts`` > 0 made.

    ``("rest", …)`` when the attempts so far are a multiple of ``rest_every``; otherwise
    ``("pace", …)``: a random ``delay_min_s``-``delay_max_s``, or with ``pace="human"`` the
    previous episode's duration (at least ``delay_min_s``) plus 0-3 s, capped at 300 s.
    """
    if options.rest_every > 0 and network_attempts % options.rest_every == 0:
        return "rest", rng.uniform(options.rest_min_s, options.rest_max_s)
    if options.pace == "human":
        watched = float(previous.duration_s or 0) if previous is not None else 0.0
        pause = max(options.delay_min_s, watched) + rng.uniform(0.0, HUMAN_JITTER_S)
        return "pace", min(pause, MAX_HUMAN_PAUSE_S)
    return "pace", rng.uniform(options.delay_min_s, options.delay_max_s)


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
) -> list[DownloadResult]:
    """Download the given episodes of a series, one at a time, ascending, resumably, paced.

    Validates the pacing options and the name format first (ValueError, see
    :func:`validate_pacing` and :func:`validate_naming`), then creates the series directory, loads
    its manifest (unless one is given), builds the downloader for ``options.engine`` (unless one
    is given; see :func:`make_downloader`) and, for each episode: an episode the manifest says is
    done (file still present) is skipped without network unless ``options.overwrite``; otherwise
    the downloader runs with ``options.out_dir`` replaced by the series directory and
    ``options.series_name`` set to the series' display name (what ``{series}`` in the name format
    expands to).

    Pacing: before every NETWORK attempt except the first the run pauses (see :func:`_next_pause`):
    a longer rest after every ``rest_every`` attempts, else the fixed or "human" pace. Each pause
    is announced through ``on_pause(kind, seconds)`` (``kind`` is ``"rest"`` or ``"pace"``) and
    then slept with ``sleep``; skips (manifest, locked, existing file, dry run) never pause and
    never count. A zero-length pause is neither announced nor slept.

    Early stops: a FAILED_LOGIN, FAILED_RATE_LIMITED or FAILED_BLOCKED result stops the run, and
    so do ``max_consecutive_failures`` FAILED/FAILED_UNAVAILABLE results in a row (a DONE resets
    the count, skips neither count nor reset). The remaining episodes that would have needed the
    network get the stopping status (FAILED for the failure streak) with the message
    ``"stopped: <reason>"`` without contacting TikTok; done, locked and already-present ones keep
    their skips.
    Every result is recorded in the manifest and passed to ``on_result``. A cookies file yt-dlp
    would complain about (see :func:`dramafetch.downloader.cookies_file_problem`) is checked once
    up front: every episode that would have needed the network is FAILED with that message, with
    no pauses and no failure counted. Whatever happens, a downloader with a ``close()`` is closed
    at the end.
    """
    validate_pacing(options)
    validate_naming(options)
    target_dir = series_dir(options.out_dir, series)
    target_dir.mkdir(parents=True, exist_ok=True)
    if manifest is None:
        manifest = Manifest.load(manifest_path(target_dir), series.series_id, series.name)
    if downloader is None:
        downloader = make_downloader(options)
    if rng is None:
        rng = random.Random()
    episode_options = replace(options, out_dir=target_dir, series_name=series.display_name)
    cookie_problem = None if options.dry_run else cookies_file_problem(options.cookies_file)
    ordered = sorted(episodes, key=lambda episode: episode.number)
    results: list[DownloadResult] = []

    def emit(result: DownloadResult) -> None:
        results.append(result)
        manifest.record(result)
        if on_result is not None:
            on_result(result)

    def stop(remaining: list[Episode], status: DownloadStatus, reason: str) -> None:
        for episode in remaining:
            emit(_stopped_result(episode, status, reason, episode_options, manifest))

    network_attempts = 0
    previous_network_episode: Episode | None = None
    consecutive_failures = 0
    try:
        for index, episode in enumerate(ordered):
            done_path = None if options.overwrite else manifest.done_path(episode.number)
            if done_path is not None:
                emit(_manifest_skip(episode, done_path))
                continue
            needs_network = _needs_network(episode, episode_options)
            if needs_network and cookie_problem is not None:
                emit(
                    DownloadResult(
                        episode=episode, status=DownloadStatus.FAILED, message=cookie_problem
                    )
                )
                continue
            if needs_network and network_attempts > 0:
                kind, pause = _next_pause(options, rng, network_attempts, previous_network_episode)
                if pause > 0:
                    if on_pause is not None:
                        on_pause(kind, pause)
                    sleep(pause)
            result = downloader.download(episode, episode_options)
            emit(result)
            if result.status not in NO_NETWORK_STATUSES:
                network_attempts += 1
                previous_network_episode = episode
            if result.status in _STOP_STATUSES:
                reason = f"episode {episode.number} {result.status.value}"
                if result.message:
                    reason += f": {result.message}"
                stop(ordered[index + 1 :], result.status, reason)
                break
            if result.status in _COUNTED_FAILURES:
                consecutive_failures += 1
                if 0 < options.max_consecutive_failures <= consecutive_failures:
                    last = result.message or result.status.value
                    reason = f"{consecutive_failures} consecutive failures (last: {last})"
                    stop(ordered[index + 1 :], DownloadStatus.FAILED, reason)
                    break
            elif result.status is DownloadStatus.DONE:
                consecutive_failures = 0
    finally:
        close_downloader(downloader)
    return results


def _needs_network(episode: Episode, options: DownloadOptions) -> bool:
    """Whether a downloader would contact TikTok for this episode (both engines share the skip
    rules: locked unless ``include_locked``, dry run, an existing complete file)."""
    if episode.locked and not options.include_locked:
        return False
    if options.dry_run:
        return False
    return options.overwrite or existing_episode_file(options.out_dir, episode, options) is None


def _manifest_skip(episode: Episode, done_path: Any) -> DownloadResult:
    return DownloadResult(
        episode=episode,
        status=DownloadStatus.SKIPPED_EXISTS,
        path=done_path,
        message=f"already downloaded (manifest): {done_path.name}",
    )


def _stopped_result(
    episode: Episode,
    status: DownloadStatus,
    reason: str,
    options: DownloadOptions,
    manifest: Manifest,
) -> DownloadResult:
    """The result for an episode the run gave up on before reaching it: the skip it would have had
    anyway — done in the manifest, locked, its file already in ``options.out_dir`` (the series
    directory) — or ``status`` with ``"stopped: <reason>"``. Mirrors :func:`_needs_network`."""
    done_path = None if options.overwrite else manifest.done_path(episode.number)
    if done_path is not None:
        return _manifest_skip(episode, done_path)
    if episode.locked and not options.include_locked:
        return locked_result(episode)
    existing = (
        None if options.overwrite else existing_episode_file(options.out_dir, episode, options)
    )
    if existing is not None:
        return DownloadResult(
            episode=episode,
            status=DownloadStatus.SKIPPED_EXISTS,
            path=existing,
            message=f"already exists: {existing.name}",
        )
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
        "locked": episode.locked,
        "lock_hints": list(episode.lock_hints),
        "page_url": episode.page_url,
        "cover_url": episode.cover_url,
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
