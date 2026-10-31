"""The seam shared by the CLI and the web UI: resolve a series, select episodes, download them.

Politeness rules live here: episodes are downloaded one at a time in ascending order with a
randomized pause between network attempts (default 3-7 s, injectable for tests), and a run stops
early on a login redirect or on HTTP 429 — TikTok rate-limits aggressively and the right answer is
to wait 30-60 minutes, not to retry. Locked episodes are skipped, never unlocked.
"""

from __future__ import annotations

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
)
from dramafetch.manifest import Manifest, manifest_path, series_dir
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

EXIT_OK = 0
EXIT_FAILED = 2
EXIT_LOGIN_REQUIRED = 3
EXIT_RATE_LIMITED = 5

_SPEC_TOKEN_RE = re.compile(r"^(?P<lo>\d+)?(?P<dash>-)?(?P<hi>\d+)?$")
#: Largest episode number an ``--episodes`` spec may name; short dramas have at most a few hundred
#: episodes (the series URL itself allows four digits), and the bound keeps a typo such as
#: ``1-99999999999`` from being taken seriously.
MAX_EPISODE_NUMBER = 10_000
_NO_NETWORK_STATUSES = frozenset(
    {DownloadStatus.SKIPPED_EXISTS, DownloadStatus.SKIPPED_LOCKED, DownloadStatus.DRY_RUN}
)
_STOP_STATUSES = frozenset({DownloadStatus.FAILED_LOGIN, DownloadStatus.FAILED_RATE_LIMITED})

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
) -> list[DownloadResult]:
    """Download the given episodes of a series, one at a time, ascending, resumably.

    Creates the series directory, loads its manifest (unless one is given) and, for each episode:
    an episode the manifest says is done (file still present) is skipped without network unless
    ``options.overwrite``; otherwise the downloader runs with ``options.out_dir`` replaced by the
    series directory. ``sleep(rng.uniform(delay_min_s, delay_max_s))`` separates consecutive
    NETWORK attempts only (not after skips, dry runs or the last episode). Every result is recorded
    in the manifest and passed to ``on_result``. A FAILED_LOGIN or FAILED_RATE_LIMITED result stops
    the run: the remaining episodes that would have needed the network get the same status with the
    message ``"stopped: <reason>"`` without contacting TikTok. A cookies file yt-dlp would complain
    about (see :func:`dramafetch.downloader.cookies_file_problem`) is checked once up front: every
    episode that would have needed the network is FAILED with that message, with no pauses.
    """
    target_dir = series_dir(options.out_dir, series)
    target_dir.mkdir(parents=True, exist_ok=True)
    if manifest is None:
        manifest = Manifest.load(manifest_path(target_dir), series.series_id, series.name)
    if downloader is None:
        downloader = YtDlpDownloader()
    if rng is None:
        rng = random.Random()
    episode_options = replace(options, out_dir=target_dir)
    cookie_problem = None if options.dry_run else cookies_file_problem(options.cookies_file)
    ordered = sorted(episodes, key=lambda episode: episode.number)
    results: list[DownloadResult] = []

    def emit(result: DownloadResult) -> None:
        results.append(result)
        manifest.record(result)
        if on_result is not None:
            on_result(result)

    previous_used_network = False
    for index, episode in enumerate(ordered):
        done_path = None if options.overwrite else manifest.done_path(episode.number)
        if done_path is not None:
            emit(
                DownloadResult(
                    episode=episode,
                    status=DownloadStatus.SKIPPED_EXISTS,
                    path=done_path,
                    message=f"already downloaded (manifest): {done_path.name}",
                )
            )
            continue
        needs_network = _needs_network(episode, episode_options)
        if needs_network and cookie_problem is not None:
            emit(
                DownloadResult(
                    episode=episode, status=DownloadStatus.FAILED, message=cookie_problem
                )
            )
            continue
        if needs_network and previous_used_network:
            sleep(rng.uniform(options.delay_min_s, options.delay_max_s))
        result = downloader.download(episode, episode_options)
        emit(result)
        if result.status not in _NO_NETWORK_STATUSES:
            previous_used_network = True
        if result.status in _STOP_STATUSES:
            reason = f"episode {episode.number} {result.status.value}"
            if result.message:
                reason += f": {result.message}"
            for remaining in ordered[index + 1 :]:
                emit(_stopped_result(remaining, result.status, reason, options, manifest))
            break
    return results


def _needs_network(episode: Episode, options: DownloadOptions) -> bool:
    """Whether YtDlpDownloader.download would contact TikTok for this episode."""
    if episode.locked and not options.include_locked:
        return False
    if options.dry_run:
        return False
    return options.overwrite or existing_episode_file(options.out_dir, episode) is None


def _stopped_result(
    episode: Episode,
    status: DownloadStatus,
    reason: str,
    options: DownloadOptions,
    manifest: Manifest,
) -> DownloadResult:
    done_path = None if options.overwrite else manifest.done_path(episode.number)
    if done_path is not None:
        return DownloadResult(
            episode=episode,
            status=DownloadStatus.SKIPPED_EXISTS,
            path=done_path,
            message=f"already downloaded (manifest): {done_path.name}",
        )
    if episode.locked and not options.include_locked:
        return locked_result(episode)
    return DownloadResult(episode=episode, status=status, message=f"stopped: {reason}")


def summarize(results: list[DownloadResult]) -> dict[str, int]:
    """``{"done": 3, "skipped-locked": 1, ...}`` — statuses that occurred, in enum order."""
    counts = dict.fromkeys(DownloadStatus, 0)
    for result in results:
        counts[result.status] += 1
    return {status.value: count for status, count in counts.items() if count}


def exit_code(results: list[DownloadResult]) -> int:
    """0 when all ok; 3 on any login failure; 5 on any rate limit; 2 on other failures."""
    statuses = {result.status for result in results}
    if DownloadStatus.FAILED_LOGIN in statuses:
        return EXIT_LOGIN_REQUIRED
    if DownloadStatus.FAILED_RATE_LIMITED in statuses:
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
    """JSON-friendly view of a download result."""
    return {
        "number": result.episode.number,
        "item_id": result.episode.item_id,
        "title": result.episode.title,
        "status": result.status.value,
        "message": result.message,
        "path": str(result.path) if result.path is not None else None,
    }
