"""engine: episode selection, deterministic download_series, pacing, early stops, engines, exit
codes, resolve."""

from __future__ import annotations

import copy
import json
import os
import random
import sys
import types
from dataclasses import replace
from pathlib import Path
from typing import ClassVar

import pytest

from dramafetch import engine
from dramafetch.catalog import parse_item_list_payload
from dramafetch.cooldown import (
    active_cooldown,
    clear_cooldown,
    clock_time,
    cooldown_message,
    read_cooldown,
    record_block,
)
from dramafetch.downloader import locked_result
from dramafetch.errors import ChallengeError, DiscoveryError, LoginRequiredError, RateLimitedError
from dramafetch.manifest import MANIFEST_FILENAME, Manifest, read_manifest, series_dir
from dramafetch.models import (
    DRM_MARK,
    DRM_MESSAGE,
    THUMBNAIL_MODES,
    DiscoveryOptions,
    DownloadOptions,
    DownloadResult,
    DownloadStatus,
    Episode,
    Series,
    SeriesRef,
)

SERIES_ID = "7699393770256782354"
NAME = "The Billionaire's Secret Heiress"


def _episode(number, hints=(), duration=None):
    return Episode(
        number=number,
        item_id=f"76994000000000000{number:02d}",
        title=f"{NAME} | Episode {number}",
        series_id=SERIES_ID,
        series_name=NAME,
        author="muffindrama_us",
        duration_s=duration,
        lock_hints=tuple(hints),
    )


def make_series(numbers=(1, 2, 3, 4, 5), locked=(), name=NAME, total=None, durations=None):
    durations = durations or {}
    episodes = [
        _episode(n, ("isFree=false",) if n in locked else (), durations.get(n)) for n in numbers
    ]
    return Series(series_id=SERIES_ID, name=name, episodes=episodes, total_hint=total)


class FakeDownloader:
    """Mimics YtDlpDownloader's no-network rules; `outcomes` maps numbers to statuses."""

    def __init__(self, outcomes=None):
        self.outcomes = outcomes or {}
        self.calls = []

    def download(self, episode, options):
        self.calls.append((episode.number, options.out_dir))
        if episode.locked and not options.include_locked:
            return locked_result(episode)
        if options.dry_run:
            return DownloadResult(episode, DownloadStatus.DRY_RUN, message="would download")
        status = self.outcomes.get(episode.number, DownloadStatus.DONE)
        if status is DownloadStatus.DONE:
            options.out_dir.mkdir(parents=True, exist_ok=True)
            path = options.out_dir / f"fake - Episode {episode.number:02d}.mp4"
            path.write_bytes(b"video")
            return DownloadResult(episode, status, path, "saved")
        return DownloadResult(episode, status, message=f"{status.value} happened")


class ClosingDownloader(FakeDownloader):
    """A downloader that holds a resource (like the browser engine) and counts its close() calls."""

    def __init__(self, outcomes=None, *, close_error=None):
        super().__init__(outcomes)
        self.closed = 0
        self.close_error = close_error

    def close(self):
        self.closed += 1
        if self.close_error is not None:
            raise self.close_error


class FixedRandom(random.Random):
    def uniform(self, a, b):
        return (a + b) / 2


def _run(series, options, downloader=None, **kwargs):
    """download_series over every episode of `series` with a fake sleep, the midpoint rng and
    recorders for sleeps and pauses; returns (results, sleeps, pauses)."""
    sleeps, pauses = [], []
    results = engine.download_series(
        series,
        series.episodes,
        options,
        downloader=downloader if downloader is not None else FakeDownloader(),
        sleep=sleeps.append,
        rng=FixedRandom(),
        on_pause=lambda kind, seconds: pauses.append((kind, seconds)),
        **kwargs,
    )
    return results, sleeps, pauses


# --------------------------------------------------------------------------- selection


@pytest.mark.parametrize(
    ("spec", "expected"),
    [
        (None, [1, 2, 3, 4, 5]),
        ("", [1, 2, 3, 4, 5]),
        ("all", [1, 2, 3, 4, 5]),
        ("  ALL ", [1, 2, 3, 4, 5]),
        ("1-3", [1, 2, 3]),
        ("2,4", [2, 4]),
        ("4-", [4, 5]),
        ("-2", [1, 2]),
        ("1-3,5", [1, 2, 3, 5]),
        (" 1 , 3 ", [1, 3]),
        ("3,1,3", [1, 3]),
        ("9", []),
        ("10-", []),
        ("2-99", [2, 3, 4, 5]),
        ("1,,", [1]),  # a trailing comma is tolerated
    ],
)
def test_select_episodes(spec, expected):
    series = make_series()
    series.episodes.reverse()  # input order must not matter
    assert [e.number for e in engine.select_episodes(series, spec)] == expected


@pytest.mark.parametrize(
    "spec",
    ["3-1", "0", "a", "1-2-3", ",", "--", "1-a", "0-5", "1 2", "1-99999999999", "10001", "10001-"],
)
def test_invalid_specs_raise_value_error(spec):
    with pytest.raises(ValueError, match="invalid episode spec"):
        engine.select_episodes(make_series(), spec)


def test_episode_numbers_are_bounded():
    assert engine.parse_episode_spec(f"1-{engine.MAX_EPISODE_NUMBER}") == [(1, 10_000)]
    with pytest.raises(ValueError, match="above 10000 are not accepted \\(use an open range"):
        engine.parse_episode_spec(f"5-{engine.MAX_EPISODE_NUMBER + 1}")


def test_missing_from_selection_and_range_formatting():
    series = make_series()
    assert engine.missing_from_selection(series, "1-7") == [(6, 7)]
    assert engine.missing_from_selection(series, "6,8-9") == [(6, 6), (8, 9)]
    assert engine.missing_from_selection(series, "10-") == []
    assert engine.missing_from_selection(series, "all") == []
    assert engine.missing_from_selection(series, "3") == []
    sparse = make_series(numbers=(1, 3, 5))
    assert engine.missing_from_selection(sparse, "1-3") == [(2, 2)]
    assert engine.missing_from_selection(sparse, "2-") == [(2, 2), (4, 4)]
    assert engine.missing_from_selection(sparse, "1-1000") == [(2, 2), (4, 4), (6, 1000)]
    assert engine.missing_from_selection(sparse, "4-6,2,6-8") == [(2, 2), (4, 4), (6, 8)]
    assert engine.missing_from_selection(Series(SERIES_ID, None, []), "1-3") == [(1, 3)]
    assert engine.compress_ranges([1, 2, 3, 7, 9, 10]) == [(1, 3), (7, 7), (9, 10)]
    assert engine.compress_ranges([]) == []
    assert engine.merge_ranges([(7, 9), (1, 3), (4, 5), (8, 12), (20, 20)]) == [
        (1, 5),
        (7, 12),
        (20, 20),
    ]
    assert engine.merge_ranges([]) == []
    assert engine.format_ranges([(1, 3), (7, 7), (9, 10)]) == "1-3, 7, 9-10"


def test_missing_from_selection_cost_does_not_depend_on_the_range_width():
    """Gaps are ranges, never materialised numbers: a hostile EpisodeNumber in the payload (or the
    widest allowed spec) must not cost seconds and gigabytes before the download starts."""
    hostile = make_series(numbers=(1, 2, 3, 10**12))
    assert engine.missing_from_selection(hostile, "1-") == [(4, 10**12 - 1)]
    assert engine.missing_from_selection(hostile, "2-5,7") == [(4, 5), (7, 7)]
    assert engine.missing_from_selection(make_series(), f"1-{engine.MAX_EPISODE_NUMBER}") == [
        (6, engine.MAX_EPISODE_NUMBER)
    ]


# --------------------------------------------------------------------------- download_series


def test_download_series_is_ordered_resumable_and_deterministic(tmp_path):
    series = make_series(locked=(5,))
    episodes = list(reversed(series.episodes))  # shuffled input, ascending downloads
    downloader = FakeDownloader()
    sleeps = []
    seen = []
    options = DownloadOptions(out_dir=tmp_path, delay_min_s=2.0, delay_max_s=4.0)
    results = engine.download_series(
        series,
        episodes,
        options,
        downloader=downloader,
        on_result=seen.append,
        sleep=sleeps.append,
        rng=FixedRandom(),
    )
    target = series_dir(tmp_path, series)
    assert target == tmp_path / f"{NAME} [{SERIES_ID}]"
    assert target.is_dir()
    assert [r.episode.number for r in results] == [1, 2, 3, 4, 5]
    assert [r.status for r in results] == [DownloadStatus.DONE] * 4 + [
        DownloadStatus.SKIPPED_LOCKED
    ]
    assert [call[0] for call in downloader.calls] == [1, 2, 3, 4, 5]
    assert all(call[1] == target for call in downloader.calls)  # out_dir is the SERIES dir
    assert sleeps == [3.0, 3.0, 3.0]  # between the 4 network attempts only, none after the last
    assert seen == results
    assert options.out_dir == tmp_path  # the caller's options are not mutated

    manifest = json.loads((target / MANIFEST_FILENAME).read_text(encoding="utf-8"))
    assert sorted(manifest["episodes"]) == ["1", "2", "3", "4", "5"]
    assert manifest["episodes"]["5"]["status"] == "skipped-locked"
    assert manifest["series_name"] == NAME
    assert engine.exit_code(results) == 0
    assert engine.summarize(results) == {"done": 4, "skipped-locked": 1}


def test_skips_do_not_add_sleeps_but_do_not_reset_them_either(tmp_path):
    series = make_series(numbers=(1, 2, 3, 4), locked=(1, 3))
    sleeps = []
    results = engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path, delay_min_s=1.0, delay_max_s=1.0),
        downloader=FakeDownloader(),
        sleep=sleeps.append,
        rng=FixedRandom(),
    )
    assert [r.status.value for r in results] == ["skipped-locked", "done", "skipped-locked", "done"]
    # network attempts: 2 and 4 -> exactly one pause, placed before 4 even though 3 was a skip
    assert sleeps == [1.0]


def test_manifest_done_episodes_are_skipped_without_network(tmp_path):
    series = make_series(numbers=(1, 2, 3))
    target = series_dir(tmp_path, series)
    target.mkdir(parents=True)
    done_file = target / "earlier run - Episode 02.mp4"
    done_file.write_bytes(b"v")
    manifest = Manifest(target / MANIFEST_FILENAME, SERIES_ID, NAME)
    manifest.record(DownloadResult(series.episodes[1], DownloadStatus.DONE, done_file, "saved"))
    manifest.record(DownloadResult(series.episodes[2], DownloadStatus.DONE, None, "file vanished"))

    downloader = FakeDownloader()
    sleeps = []
    results = engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path),
        downloader=downloader,
        sleep=sleeps.append,
        rng=FixedRandom(),
    )
    assert [r.status.value for r in results] == ["done", "skipped-exists", "done"]
    assert results[1].path == done_file
    assert "manifest" in results[1].message
    assert [call[0] for call in downloader.calls] == [1, 3]  # 2 never touched the downloader
    assert sleeps == [6.5]  # between the two network attempts (default 4-9 -> midpoint 6.5)

    overwrite = FakeDownloader()
    engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path, overwrite=True),
        downloader=overwrite,
        sleep=lambda s: None,
    )
    assert [call[0] for call in overwrite.calls] == [1, 2, 3]


def test_resumed_runs_keep_remembering_what_was_downloaded(tmp_path):
    series = make_series(numbers=(1, 2, 3))
    options = DownloadOptions(out_dir=tmp_path)
    first = FakeDownloader()
    engine.download_series(
        series, series.episodes[:2], options, downloader=first, sleep=lambda s: None
    )
    assert [call[0] for call in first.calls] == [1, 2]

    # second run: 1 and 2 come from the manifest, only 3 is downloaded ...
    second = FakeDownloader()
    results = engine.download_series(
        series, series.episodes, options, downloader=second, sleep=lambda s: None
    )
    assert [r.status.value for r in results] == ["skipped-exists", "skipped-exists", "done"]
    assert [call[0] for call in second.calls] == [3]
    # ... and recording those skips did not make the manifest forget the first run
    manifest = Manifest.load(series_dir(tmp_path, series) / MANIFEST_FILENAME, SERIES_ID, NAME)
    assert {n: e.status for n, e in manifest.entries.items()} == {1: "done", 2: "done", 3: "done"}

    # third run (and a dry run): nothing reaches the downloader, the manifest stays "done"
    third = FakeDownloader()
    results = engine.download_series(
        series, series.episodes, options, downloader=third, sleep=lambda s: None
    )
    assert [r.status.value for r in results] == ["skipped-exists"] * 3
    assert third.calls == []
    dry = FakeDownloader()
    engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path, dry_run=True),
        downloader=dry,
        sleep=lambda s: None,
    )
    assert dry.calls == []
    manifest = Manifest.load(series_dir(tmp_path, series) / MANIFEST_FILENAME, SERIES_ID, NAME)
    assert all(manifest.is_done(n) for n in (1, 2, 3))


def test_existing_file_on_disk_is_not_a_network_attempt(tmp_path):
    series = make_series(numbers=(1, 2, 3))
    target = series_dir(tmp_path, series)
    target.mkdir(parents=True)
    (target / f"{NAME} - Episode 02.mp4").write_bytes(b"v")  # matches episode_stem(ep 2)

    class SkipsExisting(FakeDownloader):
        def download(self, episode, options):
            from dramafetch.downloader import existing_episode_file

            existing = existing_episode_file(options.out_dir, episode, options)
            if existing is not None:
                self.calls.append((episode.number, options.out_dir))
                return DownloadResult(episode, DownloadStatus.SKIPPED_EXISTS, existing, "exists")
            return super().download(episode, options)

    sleeps = []
    results = engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path, delay_min_s=1, delay_max_s=1),
        downloader=SkipsExisting(),
        sleep=sleeps.append,
        rng=FixedRandom(),
    )
    assert [r.status.value for r in results] == ["done", "skipped-exists", "done"]
    assert sleeps == [1.0]


def test_dry_run_touches_nothing_and_never_sleeps(tmp_path):
    series = make_series(locked=(5,))
    sleeps = []
    results = engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path, dry_run=True),
        downloader=FakeDownloader(),
        sleep=sleeps.append,
    )
    assert [r.status.value for r in results] == ["dry-run"] * 4 + ["skipped-locked"]
    assert sleeps == []
    target = series_dir(tmp_path, series)
    assert sorted(p.name for p in target.iterdir()) == [MANIFEST_FILENAME]
    assert engine.exit_code(results) == 0


def test_early_stop_on_login_marks_the_rest_without_network(tmp_path):
    series = make_series(locked=(5,))
    downloader = FakeDownloader({2: DownloadStatus.FAILED_LOGIN})
    sleeps = []
    results = engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path),
        downloader=downloader,
        sleep=sleeps.append,
        rng=FixedRandom(),
    )
    assert [r.status.value for r in results] == [
        "done",
        "failed-login-required",
        "failed-login-required",
        "failed-login-required",
        "skipped-locked",
    ]
    assert (
        results[2].message
        == "stopped: episode 2 failed-login-required: failed-login-required happened"
    )
    assert results[3].message.startswith("stopped: ")
    assert [call[0] for call in downloader.calls] == [1, 2]
    assert sleeps == [6.5]  # default 4-9 s -> midpoint
    manifest = json.loads((series_dir(tmp_path, series) / MANIFEST_FILENAME).read_text("utf-8"))
    assert manifest["episodes"]["4"]["status"] == "failed-login-required"
    assert manifest["episodes"]["5"]["status"] == "skipped-locked"
    assert engine.exit_code(results) == 3


def test_early_stop_on_rate_limit_keeps_done_episodes_as_skipped(tmp_path):
    series = make_series(numbers=(1, 2, 3, 4))
    target = series_dir(tmp_path, series)
    target.mkdir(parents=True)
    done_file = target / "earlier - Episode 03.mp4"
    done_file.write_bytes(b"v")
    Manifest(target / MANIFEST_FILENAME, SERIES_ID, NAME).record(
        DownloadResult(series.episodes[2], DownloadStatus.DONE, done_file, "saved")
    )
    downloader = FakeDownloader({1: DownloadStatus.FAILED_RATE_LIMITED})
    results = engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path),
        downloader=downloader,
        sleep=lambda s: None,
    )
    assert [r.status.value for r in results] == [
        "failed-rate-limited",
        "failed-rate-limited",
        "skipped-exists",
        "failed-rate-limited",
    ]
    assert results[2].path == done_file
    assert [call[0] for call in downloader.calls] == [1]
    assert engine.exit_code(results) == 5


def test_other_failures_do_not_stop_the_run(tmp_path):
    series = make_series(numbers=(1, 2, 3))
    downloader = FakeDownloader({1: DownloadStatus.FAILED_UNAVAILABLE, 2: DownloadStatus.FAILED})
    results = engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path),
        downloader=downloader,
        sleep=lambda s: None,
    )
    assert [r.status.value for r in results] == ["failed-unavailable", "failed", "done"]
    assert [call[0] for call in downloader.calls] == [1, 2, 3]
    assert engine.exit_code(results) == 2


def test_malformed_cookies_file_fails_network_episodes_up_front_without_pauses(tmp_path):
    """yt-dlp would quote a malformed cookies.txt line, value included; the engine checks the file
    once, fails every episode that would have needed the network and never sleeps or downloads."""
    cookies = tmp_path / "cookies.txt"
    cookies.write_text(
        "# Netscape HTTP Cookie File\n"
        ".tiktok.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tSECRET_SESSION\n"
        ".tiktok.com\tTRUE\t/\tTRUE\t1893456000\tttwid\tSECRET_TTWID\textra\n",
        encoding="utf-8",
    )
    series = make_series(numbers=(1, 2, 3), locked=(3,))
    downloader = FakeDownloader()
    sleeps = []
    results = engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path, cookies_file=cookies),
        downloader=downloader,
        sleep=sleeps.append,
    )
    assert [r.status for r in results] == [
        DownloadStatus.FAILED,
        DownloadStatus.FAILED,
        DownloadStatus.SKIPPED_LOCKED,
    ]
    assert "line 3: 8 fields (expected 7)" in results[0].message
    assert "SECRET" not in results[0].message
    assert sleeps == []
    assert [n for n, _ in downloader.calls] == [
        3
    ]  # only the locked skip went through the downloader
    assert engine.exit_code(results) == 2
    # a dry run never opens the cookies file, so it is not refused
    dry = engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path, cookies_file=cookies, dry_run=True),
        downloader=downloader,
        sleep=sleeps.append,
    )
    assert [r.status for r in dry] == [
        DownloadStatus.DRY_RUN,
        DownloadStatus.DRY_RUN,
        DownloadStatus.SKIPPED_LOCKED,
    ]


def test_download_series_with_an_injected_manifest_and_empty_selection(tmp_path):
    series = make_series(numbers=(1,))
    manifest = Manifest(tmp_path / "custom.json", SERIES_ID, NAME)
    results = engine.download_series(
        series,
        [],
        DownloadOptions(out_dir=tmp_path),
        downloader=FakeDownloader(),
        manifest=manifest,
    )
    assert results == []
    assert series_dir(tmp_path, series).is_dir()
    results = engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path),
        downloader=FakeDownloader(),
        manifest=manifest,
        sleep=lambda s: None,
    )
    assert results[0].status is DownloadStatus.DONE
    assert manifest.is_done(1)
    assert (tmp_path / "custom.json").exists()


def test_default_downloader_is_yt_dlp_but_dry_run_needs_no_network(tmp_path):
    series = make_series(numbers=(1, 2))
    results = engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path, dry_run=True),
        sleep=lambda s: None,
    )
    assert [r.status.value for r in results] == ["dry-run", "dry-run"]


# --------------------------------------------------------------------------- pacing


def test_rest_comes_after_the_tenth_network_attempt_not_after_skips(tmp_path):
    """14 episodes, 3 and 7 locked: 12 network attempts. The pause before the 11th attempt (episode
    13) is the rest; skips neither pause nor count."""
    series = make_series(numbers=range(1, 15), locked=(3, 7))
    options = DownloadOptions(
        out_dir=tmp_path, delay_min_s=1.0, delay_max_s=1.0, rest_min_s=60.0, rest_max_s=120.0
    )
    results, sleeps, pauses = _run(series, options)
    assert engine.summarize(results) == {"done": 12, "skipped-locked": 2}
    assert sleeps == [1.0] * 9 + [90.0] + [1.0]
    assert pauses == [("pace", 1.0)] * 9 + [("rest", 90.0)] + [("pace", 1.0)]
    assert [kind for kind, _ in pauses].count("rest") == 1


def test_rest_every_counts_network_attempts_including_failures(tmp_path):
    series = make_series(numbers=range(1, 8))
    downloader = FakeDownloader({2: DownloadStatus.FAILED_UNAVAILABLE, 5: DownloadStatus.FAILED})
    options = DownloadOptions(
        out_dir=tmp_path,
        delay_min_s=2.0,
        delay_max_s=2.0,
        rest_every=3,
        rest_min_s=10.0,
        rest_max_s=20.0,
        max_consecutive_failures=0,
    )
    _, sleeps, pauses = _run(series, options, downloader)
    # attempts 1-7: rests before the 4th and the 7th attempt (after 3 and 6 attempts)
    assert sleeps == [2.0, 2.0, 15.0, 2.0, 2.0, 15.0]
    assert [kind for kind, _ in pauses] == ["pace", "pace", "rest", "pace", "pace", "rest"]


def test_rest_every_zero_disables_the_rests(tmp_path):
    series = make_series(numbers=range(1, 13))
    options = DownloadOptions(out_dir=tmp_path, delay_min_s=1.0, delay_max_s=1.0, rest_every=0)
    _, sleeps, pauses = _run(series, options)
    assert sleeps == [1.0] * 11
    assert all(kind == "pace" for kind, _ in pauses)


def test_human_pace_waits_about_as_long_as_the_previous_episode(tmp_path):
    """max(delay_min, previous duration) + uniform(0, 3) (midpoint 1.5 here), capped at 300 s; an
    episode without a duration falls back to delay_min; the rest still takes precedence."""
    series = make_series(numbers=(1, 2, 3, 4, 5), durations={1: 100, 2: 400, 4: 10})
    options = DownloadOptions(
        out_dir=tmp_path, pace="human", delay_min_s=4.0, delay_max_s=9.0, rest_every=0
    )
    _, sleeps, pauses = _run(series, options)
    assert sleeps == [101.5, 300.0, 5.5, 11.5]
    assert pauses == [("pace", 101.5), ("pace", 300.0), ("pace", 5.5), ("pace", 11.5)]
    assert engine.MAX_HUMAN_PAUSE_S == 300.0 and engine.HUMAN_JITTER_S == 3.0

    rested = DownloadOptions(
        out_dir=tmp_path,
        pace="human",
        overwrite=True,
        rest_every=2,
        rest_min_s=50.0,
        rest_max_s=70.0,
    )
    _, sleeps, pauses = _run(series, rested)
    assert sleeps == [101.5, 60.0, 5.5, 60.0]
    assert [kind for kind, _ in pauses] == ["pace", "rest", "pace", "rest"]


def test_human_pace_skips_do_not_change_which_episode_was_watched_last(tmp_path):
    series = make_series(numbers=(1, 2, 3), locked=(2,), durations={1: 50, 2: 999})
    options = DownloadOptions(out_dir=tmp_path, pace="human", delay_min_s=4.0, rest_every=0)
    _, sleeps, _ = _run(series, options)
    assert sleeps == [51.5]  # episode 1 was the last one watched; the locked 2 does not count


def test_zero_pauses_are_neither_announced_nor_slept(tmp_path):
    series = make_series(numbers=(1, 2, 3))
    options = DownloadOptions(out_dir=tmp_path, delay_min_s=0.0, delay_max_s=0.0, rest_every=0)
    results, sleeps, pauses = _run(series, options)
    assert [r.status.value for r in results] == ["done"] * 3
    assert sleeps == [] and pauses == []


def test_on_pause_is_optional_and_called_before_sleep(tmp_path):
    series = make_series(numbers=(1, 2))
    order = []
    engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path, delay_min_s=1.0, delay_max_s=1.0),
        downloader=FakeDownloader(),
        sleep=lambda s: order.append(("sleep", s)),
        rng=FixedRandom(),
        on_pause=lambda kind, s: order.append((kind, s)),
    )
    assert order == [("pace", 1.0), ("sleep", 1.0)]
    engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path, overwrite=True),
        downloader=FakeDownloader(),
        sleep=lambda s: None,
    )  # no on_pause: fine


@pytest.mark.parametrize(
    ("options", "match"),
    [
        (DownloadOptions(delay_min_s=5.0, delay_max_s=4.0), "delay_max_s .* >= delay_min_s"),
        (DownloadOptions(delay_min_s=-1.0), "delay_min_s/delay_max_s must not be negative"),
        (DownloadOptions(rest_min_s=200.0, rest_max_s=100.0), "rest_max_s .* >= rest_min_s"),
        (DownloadOptions(rest_max_s=-1.0), "rest_min_s/rest_max_s must not be negative"),
        (DownloadOptions(pace="fast"), "unknown pace 'fast'"),
    ],
)
def test_inconsistent_pacing_is_refused_before_anything_is_written(tmp_path, options, match):
    series = make_series(numbers=(1, 2))
    options = DownloadOptions(**{**options.__dict__, "out_dir": tmp_path})
    with pytest.raises(ValueError, match=match):
        engine.validate_pacing(options)
    downloader = FakeDownloader()
    with pytest.raises(ValueError, match=match):
        engine.download_series(series, series.episodes, options, downloader=downloader)
    assert downloader.calls == []
    assert not series_dir(tmp_path, series).exists()
    engine.validate_pacing(DownloadOptions())  # the defaults are consistent
    engine.validate_pacing(DownloadOptions(delay_min_s=0.0, delay_max_s=0.0, rest_every=0))


@pytest.mark.parametrize(
    ("name_format", "match"),
    [
        ("{nope}", r"unknown placeholder \{nope\}"),
        ("{series} - Episode {number:02d}", r"unknown placeholder \{number:02d\}"),
        ("{series} - Episode {number", "unmatched brace"),
        ("{series}", "does not tell episodes apart"),
        ("", "does not tell episodes apart"),
    ],
)
def test_an_unusable_name_format_is_refused_before_the_series_directory_exists(
    tmp_path, name_format, match
):
    series = make_series(numbers=(1, 2))
    options = DownloadOptions(out_dir=tmp_path, name_format=name_format)
    with pytest.raises(ValueError, match=match):
        engine.validate_naming(options)
    downloader = ClosingDownloader()
    with pytest.raises(ValueError, match=match):
        engine.download_series(series, series.episodes, options, downloader=downloader)
    assert downloader.calls == [] and downloader.closed == 0
    assert not series_dir(tmp_path, series).exists()
    assert list(tmp_path.iterdir()) == []
    engine.validate_naming(DownloadOptions())  # the default is fine
    engine.validate_naming(DownloadOptions(name_format="{title}"))  # the bare-video default too


@pytest.mark.parametrize("mode", THUMBNAIL_MODES)
def test_thumbnail_modes_are_accepted_and_shape_the_options(mode):
    options = DownloadOptions(thumbnail=mode)
    engine.validate_thumbnail(options)
    assert options.thumbnails is (mode != "none")
    assert options.embed_cover is (mode in ("embed", "both"))
    assert options.keep_cover_file is (mode in ("both", "file"))
    assert THUMBNAIL_MODES == ("embed", "both", "file", "none")
    assert DownloadOptions().thumbnail == "embed"


@pytest.mark.parametrize("mode", ["sidecar", "EMBED", "", "yes"])
def test_an_unknown_thumbnail_mode_is_refused_before_the_series_directory_exists(tmp_path, mode):
    series = make_series(numbers=(1, 2))
    options = DownloadOptions(out_dir=tmp_path, thumbnail=mode)
    match = f"unknown thumbnail mode {mode!r}: expected one of embed, both, file, none"
    with pytest.raises(ValueError, match=match):
        engine.validate_thumbnail(options)
    downloader = ClosingDownloader()
    with pytest.raises(ValueError, match=match):
        engine.download_series(series, series.episodes, options, downloader=downloader)
    assert downloader.calls == [] and downloader.closed == 0
    assert not series_dir(tmp_path, series).exists()
    assert list(tmp_path.iterdir()) == []


def test_the_thumbnail_mode_reaches_the_downloader_untouched(tmp_path):
    series = make_series(numbers=(1,))
    seen = []

    class Recording(FakeDownloader):
        def download(self, episode, options):
            seen.append(options.thumbnail)
            return super().download(episode, options)

    for mode in THUMBNAIL_MODES:
        options = DownloadOptions(out_dir=tmp_path / mode, thumbnail=mode)
        _run(series, options, Recording())
    assert seen == list(THUMBNAIL_MODES)


def test_the_downloader_gets_the_series_name_for_the_series_placeholder(tmp_path):
    """`{series}` expands to the series' display name on every call, which is also what the
    engine's own skip rule (`existing_episode_file`) looks for; the caller's options are left
    alone."""
    series = make_series(numbers=(1, 2), name="Heiress: Part 1/2")
    options = DownloadOptions(out_dir=tmp_path, name_format="{series} - Ep {number}")
    calls = []

    class Recording(FakeDownloader):
        def download(self, episode, options):
            calls.append(options)
            return super().download(episode, options)

    results, _, _ = _run(series, options, Recording())
    assert [r.status.value for r in results] == ["done", "done"]
    assert [o.series_name for o in calls] == ["Heiress: Part 1/2"] * 2
    assert all(o.name_format == "{series} - Ep {number}" for o in calls)
    assert options.series_name is None  # not mutated

    unnamed = make_series(numbers=(1,), name=None)
    calls.clear()
    _run(unnamed, options, Recording())
    assert [o.series_name for o in calls] == [f"series-{SERIES_ID}"]

    # a file named the way the format and the series name say is a skip, not a network attempt
    second_out = tmp_path / "second"
    target = series_dir(second_out, series)
    target.mkdir(parents=True)
    on_disk = target / "Heiress Part 1 2 - Ep 01.mp4"
    on_disk.write_bytes(b"hand-made")

    class SkipsExisting(Recording):
        def download(self, episode, options):
            from dramafetch.downloader import existing_episode_file

            existing = existing_episode_file(options.out_dir, episode, options)
            if existing is not None:
                calls.append(options)
                return DownloadResult(episode, DownloadStatus.SKIPPED_EXISTS, existing, "exists")
            return super().download(episode, options)

    calls.clear()
    results, sleeps, _ = _run(
        series,
        DownloadOptions(out_dir=second_out, name_format="{series} - Ep {number}"),
        SkipsExisting(),
    )
    assert [r.status.value for r in results] == ["skipped-exists", "done"]
    assert results[0].path == on_disk
    assert sleeps == []  # one network attempt only: nothing to pause between


# --------------------------------------------------------------------------- early stops


def test_consecutive_failures_stop_the_run_without_further_network(tmp_path):
    """FAILED and FAILED_UNAVAILABLE count; the locked skip in between neither counts nor resets;
    the third failure in a row stops the run and the rest is FAILED "stopped: …" untouched."""
    series = make_series(numbers=range(1, 8), locked=(3,))
    downloader = FakeDownloader(
        {1: DownloadStatus.FAILED, 2: DownloadStatus.FAILED_UNAVAILABLE, 4: DownloadStatus.FAILED}
    )
    results, sleeps, _ = _run(series, DownloadOptions(out_dir=tmp_path), downloader)
    assert [r.status.value for r in results] == [
        "failed",
        "failed-unavailable",
        "skipped-locked",
        "failed",
        "failed",
        "failed",
        "failed",
    ]
    assert results[4].message == "stopped: 3 consecutive failures (last: failed happened)"
    assert results[5].message == results[6].message == results[4].message
    assert [call[0] for call in downloader.calls] == [1, 2, 3, 4]  # 5-7 never reached a downloader
    assert sleeps == [6.5, 6.5]  # between the three network attempts only
    assert engine.exit_code(results) == 2
    manifest = json.loads((series_dir(tmp_path, series) / MANIFEST_FILENAME).read_text("utf-8"))
    assert manifest["episodes"]["7"]["status"] == "failed"
    assert manifest["episodes"]["7"]["message"].startswith("stopped: 3 consecutive failures")


def test_a_success_resets_the_failure_streak(tmp_path):
    series = make_series(numbers=range(1, 7))
    downloader = FakeDownloader(
        {
            1: DownloadStatus.FAILED,
            2: DownloadStatus.FAILED,
            4: DownloadStatus.FAILED_UNAVAILABLE,
            5: DownloadStatus.FAILED,
        }
    )
    results, _, _ = _run(series, DownloadOptions(out_dir=tmp_path), downloader)
    assert [r.status.value for r in results] == [
        "failed",
        "failed",
        "done",
        "failed-unavailable",
        "failed",
        "done",
    ]
    assert [call[0] for call in downloader.calls] == [1, 2, 3, 4, 5, 6]
    assert not any(r.message.startswith("stopped") for r in results)


def test_max_consecutive_failures_zero_never_stops_and_one_stops_at_once(tmp_path):
    series = make_series(numbers=range(1, 6))
    downloader = FakeDownloader(dict.fromkeys(range(1, 6), DownloadStatus.FAILED))
    results, _, _ = _run(
        series, DownloadOptions(out_dir=tmp_path, max_consecutive_failures=0), downloader
    )
    assert [r.status.value for r in results] == ["failed"] * 5
    assert [call[0] for call in downloader.calls] == [1, 2, 3, 4, 5]

    downloader = FakeDownloader({1: DownloadStatus.FAILED_UNAVAILABLE})
    results, _, _ = _run(
        series,
        DownloadOptions(out_dir=tmp_path, overwrite=True, max_consecutive_failures=1),
        downloader,
    )
    assert [r.status.value for r in results] == ["failed-unavailable"] + ["failed"] * 4
    assert results[1].message == (
        "stopped: 1 consecutive failures (last: failed-unavailable happened)"
    )
    assert [call[0] for call in downloader.calls] == [1]


def test_failure_stop_keeps_done_and_locked_episodes_as_skips(tmp_path):
    series = make_series(numbers=(1, 2, 3, 4, 5, 6), locked=(5,))
    target = series_dir(tmp_path, series)
    target.mkdir(parents=True)
    done_file = target / "earlier - Episode 04.mp4"
    done_file.write_bytes(b"v")
    Manifest(target / MANIFEST_FILENAME, SERIES_ID, NAME).record(
        DownloadResult(series.episodes[3], DownloadStatus.DONE, done_file, "saved")
    )
    downloader = FakeDownloader(dict.fromkeys((1, 2, 3), DownloadStatus.FAILED))
    results, _, _ = _run(series, DownloadOptions(out_dir=tmp_path), downloader)
    assert [r.status.value for r in results] == [
        "failed",
        "failed",
        "failed",
        "skipped-exists",
        "skipped-locked",
        "failed",
    ]
    assert results[3].path == done_file
    assert results[5].message.startswith("stopped: 3 consecutive failures")


def test_failure_stop_skips_an_episode_whose_file_is_already_on_disk(tmp_path):
    """A remaining episode whose file exists but is not in the manifest (deleted, rebuilt) would
    not have needed the network, so the stop leaves it skipped-exists, not failed — in the results,
    the summary and the manifest."""
    series = make_series(numbers=(1, 2, 3, 4, 5))
    target = series_dir(tmp_path, series)
    target.mkdir(parents=True)
    on_disk = target / f"{NAME} - Episode 05.mp4"  # matches episode_stem(ep 5)
    on_disk.write_bytes(b"v")
    downloader = FakeDownloader(dict.fromkeys((1, 2, 3), DownloadStatus.FAILED))

    results, _, _ = _run(series, DownloadOptions(out_dir=tmp_path), downloader)

    assert [r.status.value for r in results] == [
        "failed",
        "failed",
        "failed",
        "failed",
        "skipped-exists",
    ]
    assert results[3].message.startswith("stopped: 3 consecutive failures")
    assert results[4].path == on_disk
    assert results[4].message == f"already exists: {on_disk.name}"
    assert [call[0] for call in downloader.calls] == [1, 2, 3]
    assert engine.summarize(results) == {"skipped-exists": 1, "failed": 4}
    manifest = json.loads((target / MANIFEST_FILENAME).read_text("utf-8"))
    assert manifest["episodes"]["5"]["status"] == "skipped-exists"

    # --overwrite ignores the file on disk, as the download itself would have
    downloader = FakeDownloader(dict.fromkeys((1, 2, 3), DownloadStatus.FAILED))
    results, _, _ = _run(series, DownloadOptions(out_dir=tmp_path, overwrite=True), downloader)
    assert [r.status.value for r in results] == ["failed"] * 5
    assert results[4].message.startswith("stopped: ")


def test_a_stop_never_adopts_an_encrypted_file_as_the_episode(tmp_path):
    """The stop gives a remaining episode the result its downloader would have given
    (`downloader.existing_file_result`): a file under its name with encrypted tracks is deleted and
    FAILED_UNAVAILABLE with the DRM message — never `skipped-exists`, which the manifest would
    count as on disk, the web serve and a later run skip — and the manifest remembers it."""
    from encrypted_mp4 import encrypted_mp4

    series = make_series(numbers=(1, 2, 3, 4, 5))
    target = series_dir(tmp_path, series)
    target.mkdir(parents=True)
    encrypted = target / f"{NAME} - Episode 05.mp4"
    encrypted.write_bytes(encrypted_mp4())
    downloader = FakeDownloader(dict.fromkeys((1, 2, 3), DownloadStatus.FAILED))

    results, _, _ = _run(series, DownloadOptions(out_dir=tmp_path), downloader)

    assert [r.status.value for r in results] == ["failed"] * 4 + ["failed-unavailable"]
    assert (results[4].message, results[4].path) == (DRM_MESSAGE, None)
    assert not encrypted.exists() and [call[0] for call in downloader.calls] == [1, 2, 3]
    manifest = read_manifest(target, SERIES_ID)
    assert manifest.drm_protected(5) and manifest.done_entries() == []


def test_cookie_problem_failures_are_not_a_failure_streak(tmp_path):
    """The up-front cookies-file refusal fails every network episode without a request; it must
    not read as "3 consecutive failures" (the messages name the real cause)."""
    cookies = tmp_path / "cookies.txt"
    cookies.write_text(
        ".tiktok.com\tTRUE\t/\tTRUE\t1893456000\tttwid\tSECRET\textra\n", encoding="utf-8"
    )
    series = make_series(numbers=range(1, 6))
    results, sleeps, _ = _run(series, DownloadOptions(out_dir=tmp_path, cookies_file=cookies))
    assert [r.status.value for r in results] == ["failed"] * 5
    assert all("malformed lines" in r.message for r in results)
    assert not any(r.message.startswith("stopped") for r in results)
    assert sleeps == []


def test_blocked_stops_the_run_like_a_rate_limit_and_exits_5(tmp_path):
    series = make_series(numbers=(1, 2, 3, 4, 5), locked=(5,))
    downloader = FakeDownloader({2: DownloadStatus.FAILED_BLOCKED})
    results, sleeps, _ = _run(series, DownloadOptions(out_dir=tmp_path), downloader)
    assert [r.status.value for r in results] == [
        "done",
        "failed-blocked",
        "failed-blocked",
        "failed-blocked",
        "skipped-locked",
    ]
    assert results[2].message == "stopped: episode 2 failed-blocked: failed-blocked happened"
    assert results[3].message == results[2].message
    assert [call[0] for call in downloader.calls] == [1, 2]
    assert sleeps == [6.5]
    assert engine.exit_code(results) == 5
    assert engine.summarize(results) == {"done": 1, "skipped-locked": 1, "failed-blocked": 3}
    manifest = json.loads((series_dir(tmp_path, series) / MANIFEST_FILENAME).read_text("utf-8"))
    assert manifest["episodes"]["4"]["status"] == "failed-blocked"
    assert manifest["episodes"]["5"]["status"] == "skipped-locked"
    # the refusal started the global cooldown: the yt-dlp engine's own message, 30 minutes
    recorded = active_cooldown()
    assert recorded is not None and recorded.source == "yt-dlp"
    assert recorded.reason == "failed-blocked happened"
    assert recorded.recorded_at is not None and recorded.until == recorded.recorded_at + 1800


def test_a_refusal_records_the_global_cooldown_once_per_run(tmp_path, monkeypatch):
    calls = []
    real = engine.record_block

    def counting(reason, source, **kwargs):
        calls.append((reason, source))
        return real(reason, source, **kwargs)

    monkeypatch.setattr(engine, "record_block", counting)
    series = make_series(numbers=(1, 2, 3, 4))
    downloader = FakeDownloader({1: DownloadStatus.FAILED_RATE_LIMITED})
    results, _, _ = _run(series, DownloadOptions(out_dir=tmp_path, engine="browser"), downloader)
    assert [r.status.value for r in results] == ["failed-rate-limited"] * 4
    assert calls == [("failed-rate-limited happened", "browser")]  # not once per stopped episode
    assert active_cooldown().source == "browser"
    assert engine.check_cooldown() == active_cooldown()
    assert {
        DownloadStatus.FAILED_RATE_LIMITED,
        DownloadStatus.FAILED_BLOCKED,
    } == engine.BLOCK_STATUSES


def test_login_stops_and_failure_streaks_do_not_start_a_cooldown(tmp_path):
    series = make_series(numbers=(1, 2, 3, 4))
    results, _, _ = _run(
        series, DownloadOptions(out_dir=tmp_path), FakeDownloader({1: DownloadStatus.FAILED_LOGIN})
    )
    assert results[0].status is DownloadStatus.FAILED_LOGIN
    assert active_cooldown() is None and read_cooldown() is None
    streak = FakeDownloader(
        {1: DownloadStatus.FAILED, 2: DownloadStatus.FAILED_UNAVAILABLE, 3: DownloadStatus.FAILED}
    )
    results, _, _ = _run(series, DownloadOptions(out_dir=tmp_path / "b"), streak)
    assert results[3].message.startswith("stopped: 3 consecutive failures")
    assert active_cooldown() is None


def test_record_block_if_refused_and_an_empty_message_falls_back_to_the_status():
    episode = _episode(1)
    assert (
        engine.record_block_if_refused(DownloadResult(episode, DownloadStatus.DONE), "yt-dlp")
        is None
    )
    assert (
        engine.record_block_if_refused(
            DownloadResult(episode, DownloadStatus.FAILED_LOGIN), "yt-dlp"
        )
        is None
    )
    assert active_cooldown() is None
    recorded = engine.record_block_if_refused(
        DownloadResult(episode, DownloadStatus.FAILED_BLOCKED), "yt-dlp"
    )
    assert (
        recorded is not None and recorded.reason == "failed-blocked" and recorded.source == "yt-dlp"
    )
    assert active_cooldown() == recorded
    clear_cooldown()
    assert engine.check_cooldown() is None


# --------------------------------------------------------------------------- engines & close()


class FakeBrowserDownloader(ClosingDownloader):
    """What a fake `dramafetch.downloader_browser` module hands out."""

    instances: ClassVar[list[FakeBrowserDownloader]] = []

    def __init__(self):
        super().__init__()
        FakeBrowserDownloader.instances.append(self)


@pytest.fixture
def fake_browser_module(monkeypatch):
    FakeBrowserDownloader.instances = []
    module = types.ModuleType("dramafetch.downloader_browser")
    module.BrowserDownloader = FakeBrowserDownloader
    monkeypatch.setitem(sys.modules, "dramafetch.downloader_browser", module)
    return module


def test_make_downloader_knows_both_engines(fake_browser_module):
    from dramafetch.downloader import YtDlpDownloader

    assert isinstance(engine.make_downloader(DownloadOptions()), YtDlpDownloader)
    assert isinstance(engine.make_downloader(DownloadOptions(engine="yt-dlp")), YtDlpDownloader)
    browser = engine.make_downloader(DownloadOptions(engine="browser"))
    assert isinstance(browser, FakeBrowserDownloader)
    assert FakeBrowserDownloader.instances == [browser]
    with pytest.raises(ValueError, match="unknown download engine 'wget'"):
        engine.make_downloader(DownloadOptions(engine="wget"))
    with pytest.raises(ValueError, match="unknown download engine"):
        engine.make_downloader(DownloadOptions(engine=""))
    assert engine.ENGINES == ("yt-dlp", "browser")


def test_download_series_builds_the_browser_engine_and_closes_it(tmp_path, fake_browser_module):
    series = make_series(numbers=(1, 2, 3), locked=(3,))
    results = engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path, engine="browser", delay_min_s=0, delay_max_s=0),
    )
    assert [r.status.value for r in results] == ["done", "done", "skipped-locked"]
    (browser,) = FakeBrowserDownloader.instances
    assert [call[0] for call in browser.calls] == [1, 2, 3]
    assert browser.closed == 1


def test_an_injected_downloader_with_close_is_closed_even_when_it_raises(tmp_path):
    series = make_series(numbers=(1, 2))
    no_sleep = {"sleep": lambda s: None}
    downloader = ClosingDownloader()
    engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path),
        downloader=downloader,
        **no_sleep,
    )
    assert downloader.closed == 1

    class Exploding(ClosingDownloader):
        def download(self, episode, options):
            raise RuntimeError("browser crashed")

    exploding = Exploding()
    with pytest.raises(RuntimeError, match="browser crashed"):
        engine.download_series(
            series,
            series.episodes,
            DownloadOptions(out_dir=tmp_path, overwrite=True),
            downloader=exploding,
            **no_sleep,
        )
    assert exploding.closed == 1

    # a downloader without close() is fine, and a close() that fails does not hide the results
    plain = FakeDownloader()
    engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path, overwrite=True),
        downloader=plain,
        **no_sleep,
    )
    noisy = ClosingDownloader(close_error=OSError("sessionid=SECRET already gone"))
    results = engine.download_series(
        series,
        series.episodes,
        DownloadOptions(out_dir=tmp_path, overwrite=True),
        downloader=noisy,
        **no_sleep,
    )
    assert [r.status.value for r in results] == ["done", "done"]
    assert noisy.closed == 1


def test_close_downloader_logs_a_redacted_warning(caplog):
    noisy = ClosingDownloader(close_error=RuntimeError("Cookie: sessionid=SECRET123; boom"))
    with caplog.at_level("WARNING", logger="dramafetch.engine"):
        engine.close_downloader(noisy)
    assert noisy.closed == 1
    assert "closing the downloader failed" in caplog.text
    assert "SECRET123" not in caplog.text
    engine.close_downloader(FakeDownloader())  # nothing to close


# --------------------------------------------------------------------------- summaries


def test_summarize_and_exit_codes():
    ep = _episode(1)
    results = [
        DownloadResult(ep, DownloadStatus.FAILED),
        DownloadResult(ep, DownloadStatus.DONE),
        DownloadResult(ep, DownloadStatus.DONE),
        DownloadResult(ep, DownloadStatus.SKIPPED_EXISTS),
    ]
    assert engine.summarize(results) == {"done": 2, "skipped-exists": 1, "failed": 1}
    assert list(engine.summarize(results)) == ["done", "skipped-exists", "failed"]  # enum order
    assert engine.summarize([]) == {}
    assert engine.exit_code([]) == 0
    assert engine.exit_code([DownloadResult(ep, DownloadStatus.DRY_RUN)]) == 0
    assert engine.exit_code([DownloadResult(ep, DownloadStatus.SKIPPED_LOCKED)]) == 0
    assert engine.exit_code([DownloadResult(ep, DownloadStatus.FAILED_UNAVAILABLE)]) == 2
    assert engine.exit_code(results) == 2
    both = [
        DownloadResult(ep, DownloadStatus.FAILED_RATE_LIMITED),
        DownloadResult(ep, DownloadStatus.FAILED_LOGIN),
    ]
    assert engine.exit_code(both) == 3
    blocked = [
        DownloadResult(ep, DownloadStatus.DONE),
        DownloadResult(ep, DownloadStatus.FAILED_BLOCKED),
    ]
    assert engine.exit_code(blocked) == 5 == engine.EXIT_RATE_LIMITED  # blocked or rate limited
    assert engine.exit_code([*blocked, DownloadResult(ep, DownloadStatus.FAILED_LOGIN)]) == 3
    assert engine.summarize(blocked) == {"done": 1, "failed-blocked": 1}
    assert engine.result_to_dict(blocked[1])["status"] == "failed-blocked"
    assert DownloadStatus.FAILED_BLOCKED.ok is False


def test_json_views():
    series = make_series(numbers=(2, 1), locked=(2,), total=5)
    series.warnings.append("w")
    first = next(episode for episode in series.episodes if episode.number == 1)
    first.cover_url = "https://p16-sign-sg.tiktokcdn.com/tos-alisg-p-0037/cover01.jpeg"
    data = engine.series_to_dict(series)
    assert data["series_id"] == SERIES_ID
    assert data["name"] == NAME
    assert data["total_hint"] == 5
    assert data["warnings"] == ["w"]
    assert [e["number"] for e in data["episodes"]] == [1, 2]
    assert data["episodes"][1]["locked"] is True
    assert data["episodes"][1]["lock_hints"] == ["isFree=false"]
    assert data["episodes"][0]["page_url"].endswith("/video/7699400000000000001")
    assert data["episodes"][0]["cover_url"] == first.cover_url  # what the page shows as the cover
    assert "raw" not in data["episodes"][0]
    json.dumps(data)
    result = engine.result_to_dict(
        DownloadResult(_episode(1), DownloadStatus.DONE, Path("/x/y.mp4"), "saved")
    )
    assert result == {
        "number": 1,
        "item_id": "7699400000000000001",
        "title": f"{NAME} | Episode 1",
        "status": "done",
        "message": "saved",
        "path": "/x/y.mp4",
    }
    assert engine.result_to_dict(DownloadResult(_episode(1), DownloadStatus.FAILED))["path"] is None


# --------------------------------------------------------------------------- resolve


class FakeDiscovery:
    def __init__(self, series):
        self.series = series
        self.calls = []

    def discover(self, ref, options):
        self.calls.append((ref, options))
        return self.series


def test_resolve_with_injected_discovery_fills_the_name():
    series = make_series(name=None)
    discovery = FakeDiscovery(series)
    ref = SeriesRef(series_id=SERIES_ID, episode_hint=1)
    options = DiscoveryOptions(strategy="static")
    resolved = engine.resolve(ref, options, discovery)
    assert resolved is series
    assert resolved.name == NAME  # taken from the episodes
    assert discovery.calls == [(ref, options)]


class FailingDiscovery:
    def __init__(self, error):
        self.error = error

    def discover(self, ref, options):
        raise self.error


@pytest.mark.parametrize(
    ("error", "records"),
    [
        (RateLimitedError("HTTP 429 while listing the episodes"), True),
        (ChallengeError("TikTok showed a captcha page"), True),
        (LoginRequiredError("login page"), False),
        (DiscoveryError("no episode list within 45 s"), False),
    ],
)
def test_resolve_records_a_cooldown_on_a_rate_limit_or_a_captcha_and_re_raises(error, records):
    options = DiscoveryOptions(strategy="browser")
    with pytest.raises(type(error)) as excinfo:
        engine.resolve(SeriesRef(series_id=SERIES_ID), options, FailingDiscovery(error))
    assert excinfo.value is error  # re-raised as it was
    recorded = active_cooldown()
    if records:
        assert recorded is not None and recorded.source == "discovery"
        assert recorded.reason == str(error)
    else:
        assert recorded is None


def test_validate_quality_and_episode_to_dict_quality_hint(tmp_path):
    with pytest.raises(
        ValueError, match="unknown quality 'ultra': expected one of compatible, best"
    ):
        engine.validate_quality(DownloadOptions(quality="ultra"))
    engine.validate_quality(DownloadOptions(quality="best"))
    series = make_series()
    with pytest.raises(ValueError, match="unknown quality"):
        engine.download_series(
            series,
            series.episodes,
            DownloadOptions(out_dir=tmp_path, quality="ultra"),
            downloader=FakeDownloader(),
        )
    assert not series_dir(tmp_path, series).exists()  # refused before anything was created
    first = series.episodes[0]
    assert engine.episode_to_dict(first)["quality_hint"] is None
    first.quality_hint = "720p h264"
    assert engine.episode_to_dict(first)["quality_hint"] == "720p h264"
    assert engine.series_to_dict(series)["episodes"][0]["quality_hint"] == "720p h264"


def test_resolve_uses_choose_discovery_lazily(monkeypatch):
    chosen = []
    discovery = FakeDiscovery(make_series())
    module = types.ModuleType("dramafetch.discovery")

    def choose_discovery(options):
        chosen.append(options)
        return discovery

    module.choose_discovery = choose_discovery
    monkeypatch.setitem(sys.modules, "dramafetch.discovery", module)
    options = DiscoveryOptions(strategy="browser")
    series = engine.resolve(SeriesRef(series_id=SERIES_ID), options)
    assert series.name == NAME
    assert chosen == [options]
    assert discovery.calls[0][0] == SeriesRef(series_id=SERIES_ID)


# --------------------------------------------------------------------------- the run's long break


class FakeClock:
    """A monotonic clock that moves only when the fake sleep sleeps (or a test moves it)."""

    def __init__(self, now=10_000.0):
        self.now = now

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class RecordingDownloader(FakeDownloader):
    """FakeDownloader that also writes ("attempt", series id, number) into a shared event list for
    every call that would contact TikTok (a locked episode or a dry run would not)."""

    def __init__(self, events, outcomes=None):
        super().__init__(outcomes)
        self.events = events

    def download(self, episode, options):
        if not (episode.locked and not options.include_locked) and not options.dry_run:
            self.events.append(("attempt", episode.series_id, episode.number))
        status = self.outcomes.get((episode.series_id, episode.number))
        if status is not None and status is not DownloadStatus.DONE:
            return DownloadResult(episode, status, message=f"{status.value} happened")
        return super().download(episode, options)


def _numbered_series(count, series_id=SERIES_ID, name=NAME):
    episodes = [
        replace(_episode(n), series_id=series_id, series_name=name) for n in range(1, count + 1)
    ]
    return Series(series_id=series_id, name=name, episodes=episodes)


def _paced_run(count, options, *, pacing=None, clock=None):
    """download_series over `count` episodes with a fake clock whose sleep moves it; returns the
    results and, in order, every pause ("long-rest", s) and attempt ("attempt", id, n)."""
    series = _numbered_series(count)
    clock = clock or FakeClock()
    events = []
    results = engine.download_series(
        series,
        series.episodes,
        options,
        downloader=RecordingDownloader(events),
        sleep=clock.sleep,
        rng=FixedRandom(),
        on_pause=lambda kind, seconds: events.append((kind, seconds)),
        pacing=pacing,
        clock=clock,
    )
    return results, events


def _pause_before_each_attempt(events):
    """{attempt number: kind of the pause right before it}, for the attempts that had one."""
    before, pending = {}, None
    for event in events:
        if event[0] == "attempt":
            if pending is not None:
                before[event[2]] = pending
            pending = None
        else:
            pending = event[0]
    return before


def test_the_long_break_comes_before_attempts_101_and_201_and_replaces_that_pause(tmp_path):
    options = DownloadOptions(out_dir=tmp_path)  # the defaults, which no CLI flag lowers
    assert (options.long_rest_every, options.long_rest_min_s, options.long_rest_max_s) == (
        100,
        900.0,
        1800.0,
    )
    pacing = engine.PacingState()
    results, events = _paced_run(250, options, pacing=pacing)
    assert [result.status for result in results] == [DownloadStatus.DONE] * 250
    before = _pause_before_each_attempt(events)
    assert sorted(n for n, kind in before.items() if kind == "long-rest") == [101, 201]
    # exactly one pause before every attempt but the first: the long break REPLACES the rest
    # that the 100th and 200th attempts would have earned, it does not come on top of it
    assert sorted(before) == list(range(2, 251))
    assert sum(1 for event in events if event[0] != "attempt") == 249
    assert [n for n, kind in before.items() if kind == "rest"] == [
        n for n in range(11, 251, 10) if n not in (101, 201)
    ]
    assert ("long-rest", 1350.0) in events  # the midpoint of 15-30 min
    assert pacing.run_attempts == 250


def test_an_idle_gap_of_15_minutes_counts_as_the_long_break(tmp_path):
    options = DownloadOptions(out_dir=tmp_path / "a", delay_min_s=0, delay_max_s=0, rest_every=0)
    clock = FakeClock()
    pacing = engine.PacingState()
    _paced_run(100, options, pacing=pacing, clock=clock)
    assert pacing.run_attempts == 100 and pacing.last_network_at == clock.now
    # the next series of the same run, 899 s later: its first attempt gets the long break
    clock.now += 899
    _, events = _paced_run(2, replace(options, out_dir=tmp_path / "b"), pacing=pacing, clock=clock)
    assert events[0] == ("long-rest", 1350.0)
    assert pacing.run_attempts == 102
    # 15 min of nothing IS the break: the count starts again, no long break
    idle = engine.PacingState(run_attempts=100, last_network_at=clock.now)
    clock.now += 900
    _, events = _paced_run(2, replace(options, out_dir=tmp_path / "c"), pacing=idle, clock=clock)
    assert [event[0] for event in events] == ["attempt", "attempt"]
    assert idle.run_attempts == 2


def test_skips_never_count_towards_the_long_break(tmp_path):
    options = DownloadOptions(out_dir=tmp_path, delay_min_s=0, delay_max_s=0, rest_every=0)
    pacing = engine.PacingState(run_attempts=99, last_network_at=None)
    series = _numbered_series(3)
    series.episodes[0].lock_hints = ("isFree=false",)  # a skip: no attempt, no count
    events = []
    engine.download_series(
        series,
        series.episodes,
        options,
        downloader=RecordingDownloader(events),
        sleep=FakeClock().sleep,
        rng=FixedRandom(),
        on_pause=lambda kind, seconds: events.append((kind, seconds)),
        pacing=pacing,
        clock=FakeClock(),
    )
    # 99 + episode 2 = 100 attempts, so the break comes before episode 3, not before episode 2
    assert events == [
        ("attempt", SERIES_ID, 2),
        ("long-rest", 1350.0),
        ("attempt", SERIES_ID, 3),
    ]


# --------------------------------------------------------------------------- series and batches

SERIES_2 = "7699393770256782399"
NAME_2 = "Second Chance Bride"
WALL = 1_800_000_000.0  # the wall clock of these tests (2027-01-15T08:00:00Z)


class BatchDiscovery:
    """Answers per series id; every call is one resolve, i.e. requests to TikTok."""

    def __init__(self, *series, errors=None, events=None):
        self.series = {item.series_id: item for item in series}
        self.errors = errors or {}
        self.events = events if events is not None else []
        self.calls = []

    def discover(self, ref, options):
        self.calls.append(ref.series_id)
        self.events.append(("resolve", ref.series_id))
        if ref.series_id in self.errors:
            raise self.errors[ref.series_id]
        return copy.deepcopy(self.series[ref.series_id])


def _quiet(tmp_path, **overrides):
    settings = {"out_dir": tmp_path, "delay_min_s": 0, "delay_max_s": 0, "rest_every": 0}
    settings.update(overrides)
    return DownloadOptions(**settings)


def _run_series(series, options, discovery, *, wall=WALL, **kwargs):
    kwargs.setdefault("downloader", FakeDownloader())
    return engine.run_series(
        SeriesRef(series.series_id),
        DiscoveryOptions(),
        options,
        discovery=discovery,
        sleep=lambda seconds: None,
        rng=FixedRandom(),
        wall_clock=lambda: wall,
        **kwargs,
    )


def test_run_series_downloads_reports_and_marks_a_complete_series(tmp_path):
    series = make_series(numbers=(1, 2, 3))
    discovery = BatchDiscovery(series)
    starts = []
    run = _run_series(series, _quiet(tmp_path), discovery, on_start=starts.append)
    assert discovery.calls == [SERIES_ID]
    assert run.series is not None and run.error is None and run.error_kind is None
    assert run.stop is False and run.exit_code == 0 and run.contacted is True
    assert [result.status for result in run.results] == [DownloadStatus.DONE] * 3
    assert run.report == engine.series_report(run.series, run.results)
    assert run.report.complete and run.report.done == 3 and run.report.listed == 3
    assert engine.report_line(run.report) == "complete: 3 of 3 (3 downloaded)"
    ((start,),) = [starts]
    assert start.series is run.series and start.name == NAME and not start.skipped_complete
    assert start.directory == series_dir(tmp_path, series)
    assert [episode.number for episode in start.episodes] == [1, 2, 3]
    manifest = read_manifest(series_dir(tmp_path, series), SERIES_ID)
    assert manifest.complete_episodes == 3
    assert manifest.complete_since() == WALL
    assert manifest.complete_at == "2027-01-15T08:00:00Z"


def test_a_series_complete_less_than_24_h_ago_costs_no_request(tmp_path):
    series = make_series(numbers=(1, 2, 3))
    discovery = BatchDiscovery(series)
    _run_series(series, _quiet(tmp_path), discovery)
    rows, starts = [], []
    downloader = FakeDownloader()
    run = _run_series(
        series,
        _quiet(tmp_path),
        discovery,
        wall=WALL + 2 * 3600,
        downloader=downloader,
        on_result=rows.append,
        on_start=starts.append,
        before_network=lambda: pytest.fail("no rest: the series makes no request"),
    )
    assert discovery.calls == [SERIES_ID]  # the first run only: ZERO requests the second time
    assert downloader.calls == []
    assert run.series is None and run.error is None and run.stop is False and run.exit_code == 0
    assert run.contacted is False
    assert run.report.skipped_complete and run.report.complete and run.report.listed == 0
    assert run.report.on_disk == 3 and run.report.checked_ago_s == 2 * 3600
    target = series_dir(tmp_path, series)
    assert [(r.episode.number, r.status, r.path) for r in run.results] == [
        (n, DownloadStatus.SKIPPED_EXISTS, target / f"fake - Episode {n:02d}.mp4")
        for n in (1, 2, 3)
    ]
    assert run.results[0].message == "already downloaded (manifest): fake - Episode 01.mp4"
    assert run.results[0].episode.item_id == "7699400000000000001"  # from the manifest
    assert rows == run.results  # on_result saw every row (the web keeps them for its ZIP)
    ((start,),) = [starts]
    assert start.skipped_complete and start.series is None and start.directory == target
    assert start.name == NAME and len(start.episodes) == 3
    assert engine.report_line(run.report) == (
        "complete, nothing to do: 3 episodes already on disk (checked 2 h ago)"
    )


@pytest.mark.parametrize(
    ("change", "overrides", "spec"),
    [
        ("25 hours later", {}, None),
        ("a file was deleted", {}, None),
        ("--recheck", {"recheck": True}, None),
        ("--overwrite", {"overwrite": True}, None),
        ("--include-locked", {"include_locked": True}, None),
        ("--dry-run", {"dry_run": True}, None),
        ("an episodes spec", {}, "1-3"),
        ("even the spec all", {}, "all"),
    ],
)
def test_the_complete_skip_never_fires_when(tmp_path, change, overrides, spec):
    series = make_series(numbers=(1, 2, 3))
    discovery = BatchDiscovery(series)
    _run_series(series, _quiet(tmp_path), discovery)
    wall = WALL + 3600
    if change == "25 hours later":
        wall = WALL + 25 * 3600
    if change == "a file was deleted":
        (series_dir(tmp_path, series) / "fake - Episode 02.mp4").unlink()
    run = _run_series(
        series, _quiet(tmp_path, **overrides), discovery, wall=wall, episodes_spec=spec
    )
    assert discovery.calls == [SERIES_ID, SERIES_ID]  # resolved again
    assert run.series is not None and not run.report.skipped_complete and run.contacted
    if change == "a file was deleted":
        assert [r.status.value for r in run.results] == ["skipped-exists", "done", "skipped-exists"]
        assert run.report.complete  # downloaded again, so complete again


def test_a_new_attempt_clears_the_complete_mark_and_an_incomplete_run_forgets_it(tmp_path):
    series = make_series(numbers=(1, 2, 3))
    _run_series(series, _quiet(tmp_path), BatchDiscovery(series))
    directory = series_dir(tmp_path, series)
    assert read_manifest(directory, SERIES_ID).complete_episodes == 3
    # TikTok now lists a fourth episode, and it fails: the series is not complete any more
    grown = make_series(numbers=(1, 2, 3, 4))
    run = _run_series(
        grown,
        _quiet(tmp_path, recheck=True),
        BatchDiscovery(grown),
        downloader=FakeDownloader({4: DownloadStatus.FAILED}),
    )
    assert not run.report.complete
    assert engine.report_line(run.report) == "incomplete: 3 of 4 — 1 failed (4)"
    manifest = read_manifest(directory, SERIES_ID)
    assert manifest.complete_at is None and manifest.complete_episodes is None
    # a recheck that finds a gap forgets the mark too, though nothing was attempted
    _run_series(
        series,
        _quiet(tmp_path, recheck=True),
        BatchDiscovery(series),
        downloader=FakeDownloader({4: DownloadStatus.FAILED}),
    )
    assert read_manifest(directory, SERIES_ID).complete_episodes == 3  # complete again
    announced = make_series(numbers=(1, 2, 3), total=4)  # TikTok now announces a 4th
    downloader = FakeDownloader()
    run = _run_series(
        announced, _quiet(tmp_path, recheck=True), BatchDiscovery(announced), downloader=downloader
    )
    assert [r.status.value for r in run.results] == ["skipped-exists"] * 3  # no new attempt
    assert run.report.gaps == (4,) and not run.report.complete
    assert read_manifest(directory, SERIES_ID).complete_at is None


def test_run_series_under_a_cooldown_makes_no_request(tmp_path):
    record_block("HTTP 429 from the CDN", "browser")
    series = make_series()
    discovery = BatchDiscovery(series)
    run = _run_series(series, _quiet(tmp_path), discovery)
    assert discovery.calls == []
    assert run.error_kind == "cooldown" and run.stop and run.exit_code == 5 and not run.contacted
    assert run.error == cooldown_message(active_cooldown())
    assert run.report.stopped.startswith("cooldown until ")
    assert not tmp_path.joinpath(f"{NAME} [{SERIES_ID}]").exists()


@pytest.mark.parametrize(
    ("error", "kind", "code", "stopped"),
    [
        (LoginRequiredError("TikTok redirected to /login"), "login", 3, "login required"),
        (ChallengeError("Verify to continue"), "captcha", 4, "captcha"),
        (RateLimitedError("HTTP 429 while listing"), "rate-limited", 5, "rate limited (HTTP 429)"),
        (DiscoveryError("no episode list within 45 s"), "discovery", 4, "the episode list could"),
    ],
)
def test_run_series_maps_every_discovery_error_to_a_stop(tmp_path, error, kind, code, stopped):
    series = make_series()
    run = _run_series(series, _quiet(tmp_path), BatchDiscovery(series, errors={SERIES_ID: error}))
    assert run.series is None and run.results == []
    assert run.error == str(error) and run.error_kind == kind and run.exit_code == code
    assert run.stop is True and run.contacted is True
    assert run.report.stopped.startswith(stopped)


def test_run_series_with_nothing_listed_or_nothing_selected(tmp_path):
    empty = Series(series_id=SERIES_ID, name=NAME, episodes=[])
    run = _run_series(empty, _quiet(tmp_path), BatchDiscovery(empty))
    assert run.error == "no episodes listed" and run.error_kind == "empty"
    assert run.stop is False and run.exit_code == 4 and run.contacted
    series = make_series()
    run = _run_series(series, _quiet(tmp_path), BatchDiscovery(series), episodes_spec="9-")
    assert run.error is None and run.results == [] and run.exit_code == 0
    assert not series_dir(tmp_path, series).exists()  # nothing selected: nothing written
    with pytest.raises(ValueError, match="invalid episode spec"):
        _run_series(series, _quiet(tmp_path), BatchDiscovery(series), episodes_spec="3-1")


@pytest.mark.parametrize(
    ("outcomes", "stopped", "code"),
    [
        ({2: DownloadStatus.FAILED_RATE_LIMITED}, "episode 2 failed-rate-limited", 5),
        ({1: DownloadStatus.FAILED_LOGIN}, "episode 1 failed-login-required", 3),
        ({1: DownloadStatus.FAILED_BLOCKED}, "episode 1 failed-blocked", 5),
        # the streak reached on the last episode still stops (nothing is left to mark)
        (
            {3: DownloadStatus.FAILED, 4: DownloadStatus.FAILED, 5: DownloadStatus.FAILED},
            "3 consecutive failures",
            2,
        ),
    ],
)
def test_run_series_stops_on_a_stop_status_or_a_failure_streak(tmp_path, outcomes, stopped, code):
    series = make_series()
    run = _run_series(
        series, _quiet(tmp_path), BatchDiscovery(series), downloader=FakeDownloader(outcomes)
    )
    assert run.stop is True and run.report.stopped == stopped and run.exit_code == code
    assert engine.report_line(run.report).endswith(f"; stopped: {stopped}")


def test_a_plain_failure_is_not_a_stop(tmp_path):
    series = make_series()
    run = _run_series(
        series,
        _quiet(tmp_path),
        BatchDiscovery(series),
        downloader=FakeDownloader({2: DownloadStatus.FAILED}),
    )
    assert run.stop is False and run.report.stopped is None and run.exit_code == 2


def _batch(refs, discovery, tmp_path, *, downloader=None, options=None, **kwargs):
    events = discovery.events
    clock = kwargs.pop("clock", FakeClock())
    return engine.run_batch(
        [SeriesRef(series_id) for series_id in refs],
        DiscoveryOptions(),
        options or _quiet(tmp_path, rest_min_s=95, rest_max_s=95),
        discovery=discovery,
        downloader=downloader or RecordingDownloader(events),
        sleep=clock.sleep,
        rng=FixedRandom(),
        clock=clock,
        wall_clock=lambda: WALL,
        on_pause=lambda kind, seconds: events.append((kind, seconds)),
        **kwargs,
    )


def test_run_batch_rests_between_two_series_that_contact_tiktok(tmp_path):
    first, second = make_series(numbers=(1, 2)), _numbered_series(2, SERIES_2, NAME_2)
    discovery = BatchDiscovery(first, second)
    runs = _batch([SERIES_ID, SERIES_2], discovery, tmp_path)
    assert [run.report.complete for run in runs] == [True, True]
    assert discovery.events == [
        ("resolve", SERIES_ID),  # the first series needs no rest
        ("attempt", SERIES_ID, 1),
        ("attempt", SERIES_ID, 2),
        ("series-rest", 95.0),  # rested BEFORE the second list was fetched
        ("resolve", SERIES_2),
        ("attempt", SERIES_2, 1),
        ("attempt", SERIES_2, 2),
    ]
    assert engine.batch_exit_code(runs) == 0


@pytest.mark.parametrize("skipped_first", [True, False])
def test_no_series_rest_around_a_series_that_makes_no_request(tmp_path, skipped_first):
    """A series skipped as complete costs nothing, so it needs no rest — but the series after it
    still rests after the last one that did contact TikTok (the rest is never skipped)."""
    a, b, c = (
        make_series(numbers=(1, 2)),
        _numbered_series(2, SERIES_2, NAME_2),
        _numbered_series(2, "7699393770256782300", "Third"),
    )
    complete = a if skipped_first else b
    _run_series(complete, _quiet(tmp_path), BatchDiscovery(complete))  # complete on disk
    discovery = BatchDiscovery(a, b, c)
    runs = _batch([a.series_id, b.series_id, c.series_id], discovery, tmp_path)
    kinds = [event[0] for event in discovery.events if event[0] not in ("attempt",)]
    if skipped_first:
        assert kinds == ["resolve", "series-rest", "resolve"]  # b (no rest), rest, c
    else:
        assert kinds == ["resolve", "series-rest", "resolve"]  # a, (b skipped), rest, c
    assert [run.report.skipped_complete for run in runs] == [
        skipped_first,
        not skipped_first,
        False,
    ]
    assert complete.series_id not in discovery.calls


def test_a_stop_ends_the_batch_and_the_rest_is_not_started_without_a_request(tmp_path):
    first, second, third = (
        make_series(numbers=(1, 2, 3)),
        _numbered_series(2, SERIES_2, NAME_2),
        _numbered_series(2, "7699393770256782300", "Third"),
    )
    discovery = BatchDiscovery(first, second, third)
    events = discovery.events
    downloader = RecordingDownloader(events, {(SERIES_ID, 2): DownloadStatus.FAILED_RATE_LIMITED})
    started, done = [], []
    runs = _batch(
        [SERIES_ID, SERIES_2, third.series_id],
        discovery,
        tmp_path,
        downloader=downloader,
        on_series_start=lambda index, total, ref: started.append((index, total, ref.series_id)),
        on_series_done=lambda index, total, run: done.append((index, run.error_kind)),
    )
    assert discovery.calls == [SERIES_ID]  # nothing after the stop: not even a list
    assert [event for event in events if event[0] == "attempt"] == [
        ("attempt", SERIES_ID, 1),
        ("attempt", SERIES_ID, 2),
    ]
    assert not any(event[0] == "series-rest" for event in events)
    assert runs[0].stop and runs[0].exit_code == 5
    message = f"not started: batch stopped in {NAME} (episode 2 failed-rate-limited)"
    for run in runs[1:]:
        assert run.series is None and run.results == [] and run.error == message
        assert run.error_kind == "not-started" and run.stop is False and run.exit_code == 5
        assert not run.contacted
    assert runs[1].report.series_id == SERIES_2
    assert started == [(1, 3, SERIES_ID), (2, 3, SERIES_2), (3, 3, third.series_id)]
    assert done == [(1, None), (2, "not-started"), (3, "not-started")]
    assert engine.batch_exit_code(runs) == 5
    assert active_cooldown() is not None  # the 429 started the cooldown, once


def test_a_failed_resolve_stops_the_batch_too(tmp_path):
    first, second = make_series(), _numbered_series(2, SERIES_2, NAME_2)
    discovery = BatchDiscovery(
        first, second, errors={SERIES_ID: LoginRequiredError("TikTok redirected to /login")}
    )
    runs = _batch([SERIES_ID, SERIES_2], discovery, tmp_path)
    assert discovery.calls == [SERIES_ID]
    assert runs[1].error == f"not started: batch stopped in {SERIES_ID} (login required)"
    assert engine.batch_exit_code(runs) == 3


def test_the_cooldown_is_checked_before_every_series(tmp_path):
    """A refusal recorded while the batch runs (here right after the first series, as another
    DramaFetch process would) turns the next series away with no request, and stops the batch."""
    series = [
        make_series(numbers=(1,)),
        _numbered_series(1, SERIES_2, NAME_2),
        _numbered_series(1, "7699393770256782300", "Third"),
    ]
    discovery = BatchDiscovery(*series)

    def refused_meanwhile(index, total, run):
        if index == 1:
            record_block("HTTP 403 from another run", "yt-dlp")

    runs = _batch(
        [item.series_id for item in series], discovery, tmp_path, on_series_done=refused_meanwhile
    )
    assert discovery.calls == [SERIES_ID]
    assert runs[1].error_kind == "cooldown" and runs[1].stop and runs[1].exit_code == 5
    assert runs[2].error_kind == "not-started" and runs[2].error.startswith(
        f"not started: batch stopped in {SERIES_2} (cooldown until "
    )
    assert not any(event[0] == "series-rest" for event in discovery.events)


def test_nothing_listed_is_no_stop_the_batch_rests_and_goes_on(tmp_path):
    empty = Series(series_id=SERIES_ID, name=NAME, episodes=[])
    second = _numbered_series(1, SERIES_2, NAME_2)
    discovery = BatchDiscovery(empty, second)
    runs = _batch([SERIES_ID, SERIES_2], discovery, tmp_path)
    assert discovery.calls == [SERIES_ID, SERIES_2]
    assert [event[0] for event in discovery.events] == [
        "resolve",
        "series-rest",  # the empty list was a request too: rest before the next one
        "resolve",
        "attempt",
    ]
    assert runs[0].error == "no episodes listed" and not runs[0].stop
    assert runs[1].report.complete
    assert engine.batch_exit_code(runs) == 4


def test_the_long_break_spans_the_series_of_a_batch(tmp_path):
    options = _quiet(tmp_path, rest_min_s=95, rest_max_s=95)
    discovery = BatchDiscovery(_numbered_series(60), _numbered_series(60, SERIES_2, NAME_2))
    pacing = engine.PacingState()
    _batch([SERIES_ID, SERIES_2], discovery, tmp_path, options=options, pacing=pacing)
    events = discovery.events
    long_break = events.index(("long-rest", 1350.0))
    assert events[long_break + 1] == ("attempt", SERIES_2, 41)  # the 101st attempt of the run
    assert events.count(("series-rest", 95.0)) == 1
    assert pacing.run_attempts == 120


def test_a_long_break_due_between_series_replaces_the_series_rest(tmp_path):
    """When the run's 100th attempt ends a series, the long break is taken before the next
    resolve — the fresh play URLs then never wait 15-30 minutes — and not again after it."""
    options = _quiet(tmp_path, rest_min_s=95, rest_max_s=95)
    discovery = BatchDiscovery(_numbered_series(100), _numbered_series(2, SERIES_2, NAME_2))
    _batch([SERIES_ID, SERIES_2], discovery, tmp_path, options=options)
    pauses_and_resolves = [event for event in discovery.events if event[0] != "attempt"]
    assert pauses_and_resolves == [
        ("resolve", SERIES_ID),
        ("long-rest", 1350.0),
        ("resolve", SERIES_2),
    ]


def test_run_batch_refuses_bad_options_before_any_request(tmp_path):
    discovery = BatchDiscovery(make_series())
    with pytest.raises(ValueError, match="rest_max_s"):
        _batch(
            [SERIES_ID], discovery, tmp_path, options=_quiet(tmp_path, rest_min_s=5, rest_max_s=1)
        )
    with pytest.raises(ValueError, match="invalid episode spec"):
        _batch([SERIES_ID], discovery, tmp_path, episodes_spec="x")
    assert discovery.calls == []


def test_dedupe_refs_keeps_the_first_of_each_series():
    refs = [
        SeriesRef(SERIES_ID, 3, "a"),
        SeriesRef(SERIES_2),
        SeriesRef(SERIES_ID, 1, "b"),
        SeriesRef(SERIES_2),
    ]
    kept, notes = engine.dedupe_refs(refs)
    assert kept == [SeriesRef(SERIES_ID, 3, "a"), SeriesRef(SERIES_2)]
    assert notes == [f"duplicate: {SERIES_ID}", f"duplicate: {SERIES_2}"]
    assert engine.dedupe_refs([]) == ([], [])


def _run_with_code(code):
    report = engine.series_report(None, [], series_id=SERIES_ID)
    return engine.SeriesRun(SeriesRef(SERIES_ID), None, [], report, None, False, code)


@pytest.mark.parametrize(
    ("codes", "worst"),
    [
        ([], 0),
        ([0, 0], 0),
        ([0, 2], 2),
        ([2, 4, 0], 4),
        ([4, 3, 2], 3),
        ([3, 5, 4], 5),
        ([5, 0], 5),
        ([1, 0], 1),
        ([1, 2], 2),
    ],
)
def test_batch_exit_code_is_the_worst_series(codes, worst):
    assert engine.batch_exit_code([_run_with_code(code) for code in codes]) == worst


# --------------------------------------------------------------------------- series folders


def _manifest_in(directory, series_id=SERIES_ID, *, mtime=None):
    directory.mkdir(parents=True, exist_ok=True)
    manifest = Manifest(directory / MANIFEST_FILENAME, series_id, None)
    manifest.save()
    if mtime is not None:
        os.utime(directory / MANIFEST_FILENAME, (mtime, mtime))
    return directory


def test_find_series_dir_picks_the_newest_manifest_and_never_globs(tmp_path):
    old = _manifest_in(tmp_path / f"Old Name [{SERIES_ID}]", mtime=1_000_000)
    new = _manifest_in(tmp_path / f"Love [1-3] [Remastered] [{SERIES_ID}]", mtime=2_000_000)
    _manifest_in(tmp_path / f"Foreign [{SERIES_ID}]", series_id=SERIES_2, mtime=3_000_000)
    (tmp_path / f"No manifest [{SERIES_ID}]").mkdir()
    (tmp_path / f"A file [{SERIES_ID}]").write_text("x", encoding="utf-8")
    _manifest_in(tmp_path / f"Other [{SERIES_2}]", series_id=SERIES_2, mtime=500_000)
    assert engine.find_series_dir(tmp_path, SERIES_ID) == new  # "[" in a name is no glob
    os.utime(old / MANIFEST_FILENAME, (4_000_000, 4_000_000))
    assert engine.find_series_dir(tmp_path, SERIES_ID) == old  # the newest manifest wins
    assert engine.find_series_dir(tmp_path, SERIES_2) == tmp_path / f"Other [{SERIES_2}]"
    assert engine.find_series_dir(tmp_path, "7699393770256782300") is None
    assert engine.find_series_dir(tmp_path / "missing", SERIES_ID) is None
    assert not (tmp_path / "missing").exists()


def test_find_series_dir_leaves_a_corrupt_manifest_alone(tmp_path):
    broken = tmp_path / f"{NAME} [{SERIES_ID}]"
    broken.mkdir()
    (broken / MANIFEST_FILENAME).write_text("{not json", encoding="utf-8")
    assert engine.find_series_dir(tmp_path, SERIES_ID) is None
    assert (broken / MANIFEST_FILENAME).read_text(encoding="utf-8") == "{not json"
    assert not (broken / (MANIFEST_FILENAME + ".bak")).exists()
    assert engine.on_disk_numbers(tmp_path, SERIES_ID) == set()


def test_on_disk_numbers_come_from_the_manifest_and_the_files(tmp_path):
    series = make_series(numbers=(1, 2, 3))
    _run_series(series, _quiet(tmp_path), BatchDiscovery(series))
    assert engine.on_disk_numbers(tmp_path, SERIES_ID) == {1, 2, 3}
    (series_dir(tmp_path, series) / "fake - Episode 03.mp4").unlink()
    assert engine.on_disk_numbers(tmp_path, SERIES_ID) == {1, 2}
    assert engine.on_disk_numbers(tmp_path, SERIES_2) == set()


# --------------------------------------------------------------------------- series reports


def _rows(series, statuses):
    """Results for `series`: `statuses` maps numbers to statuses; the rest are DONE."""
    rows = []
    for episode in sorted(series.episodes, key=lambda episode: episode.number):
        status = statuses.get(episode.number, DownloadStatus.DONE)
        path = Path(f"/x/{episode.number}.mp4") if status.ok else None
        rows.append(DownloadResult(episode, status, path, ""))
    return rows


def test_report_lines_for_complete_skipped_and_incomplete_series():
    full = make_series(numbers=range(1, 31), total=30)
    rows = _rows(full, {29: DownloadStatus.SKIPPED_EXISTS, 30: DownloadStatus.SKIPPED_EXISTS})
    report = engine.series_report(full, rows)
    assert report.complete and (report.done, report.on_disk, report.listed) == (28, 2, 30)
    assert engine.report_line(report) == "complete: 30 of 30 (28 downloaded, 2 already on disk)"

    on_disk = [
        DownloadResult(_episode(n), DownloadStatus.SKIPPED_EXISTS, Path(f"/x/{n}.mp4"))
        for n in range(1, 31)
    ]
    skipped = engine.series_report(None, on_disk, skipped_complete=True, checked_ago_s=7300)
    assert skipped.series_id == SERIES_ID and skipped.name == NAME  # from the rows
    assert skipped.complete and skipped.listed == 0 and skipped.on_disk == 30
    assert engine.report_line(skipped) == (
        "complete, nothing to do: 30 episodes already on disk (checked 2 h ago)"
    )

    gappy = make_series(numbers=[n for n in range(1, 31) if n != 17], locked=(5, 6), total=30)
    rows = _rows(
        gappy,
        {
            5: DownloadStatus.SKIPPED_LOCKED,
            6: DownloadStatus.SKIPPED_LOCKED,
            12: DownloadStatus.FAILED,
        },
    )
    report = engine.series_report(gappy, rows)
    assert not report.complete and report.gaps == (17,) and report.failed_numbers == (12,)
    assert engine.report_line(report) == (
        "incomplete: 26 of 30 — 2 locked (5, 6), 1 failed (12); episode 17 missing from "
        "TikTok's list"
    )


def test_locked_episodes_do_not_make_a_series_incomplete_but_failures_and_gaps_do():
    series = make_series(numbers=(1, 2, 3), locked=(3,))
    locked_skip = {3: DownloadStatus.SKIPPED_LOCKED}
    report = engine.series_report(series, _rows(series, locked_skip))
    assert report.complete and report.locked_numbers == (3,)
    assert engine.report_line(report) == "complete: 2 of 3 (2 downloaded) — 1 locked (3)"
    # a locked episode tried with --include-locked that fails is a failure
    report = engine.series_report(series, _rows(series, {3: DownloadStatus.FAILED_UNAVAILABLE}))
    assert not report.complete and report.failed == 1
    # a free episode that was not selected is not on disk
    report = engine.series_report(series, _rows(series, locked_skip)[1:])
    assert not report.complete
    assert engine.report_line(report) == "incomplete: 1 of 3 — 1 locked (3), 1 not downloaded"
    # TikTok announces more than it lists: the missing numbers are the gaps
    short = make_series(numbers=(1, 2, 3), total=5)
    report = engine.series_report(short, _rows(short, {}))
    assert report.gaps == (4, 5) and not report.complete
    assert (
        engine.report_line(report)
        == "incomplete: 3 of 5 — episodes 4, 5 missing from TikTok's list"
    )
    # ... or lists more than it announces
    long = make_series(numbers=(1, 2, 3, 4), total=3)
    report = engine.series_report(long, _rows(long, {}))
    assert report.gaps == () and not report.complete
    assert engine.report_line(report) == (
        "incomplete: 4 of 4 — TikTok announces 3 episodes, 4 listed"
    )
    # nothing listed at all
    report = engine.series_report(Series(SERIES_ID, NAME, []), [])
    assert not report.complete and engine.report_line(report) == (
        "incomplete: 0 of 0 — no episodes listed"
    )


def test_report_numbers_are_compact_and_an_absurd_episode_number_costs_nothing():
    series = make_series(numbers=(1, 2, 3, 4, 5, 6, 8))
    rows = _rows(series, dict.fromkeys((1, 2, 3, 5, 6, 8), DownloadStatus.FAILED))
    report = engine.series_report(series, rows)
    assert engine.report_line(report) == (
        "incomplete: 1 of 8 — 6 failed (1-3, 5, 6, 8); episode 7 missing from TikTok's list"
    )
    hostile = make_series(numbers=(1, 10**12))
    report = engine.series_report(hostile, _rows(hostile, {}))
    assert len(report.gaps) == engine.MAX_EPISODE_NUMBER - 1  # bounded, not a trillion numbers
    assert "episodes 2-10000 missing from TikTok's list" in engine.report_line(report)
    odd = make_series(numbers=range(1, 42, 2))  # every even number missing: 20 single gaps
    line = engine.report_line(engine.series_report(odd, _rows(odd, {})))
    assert line.endswith(
        "episodes 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, … missing from TikTok's list"
    )


@pytest.mark.parametrize(
    ("seconds", "text"),
    [(0, "just now"), (59, "just now"), (60, "1 min ago"), (3599, "59 min ago"), (7200, "2 h ago")],
)
def test_report_line_says_when_the_series_was_checked(seconds, text):
    rows = [DownloadResult(_episode(1), DownloadStatus.SKIPPED_EXISTS, Path("/x/1.mp4"))]
    report = engine.series_report(None, rows, skipped_complete=True, checked_ago_s=seconds)
    assert engine.report_line(report) == (
        f"complete, nothing to do: 1 episode already on disk (checked {text})"
    )


def test_report_to_dict_is_json_ready():
    series = make_series(numbers=(1, 3), locked=(3,))
    report = engine.series_report(series, _rows(series, {3: DownloadStatus.SKIPPED_LOCKED}))
    data = engine.report_to_dict(report)
    assert data["gaps"] == [2] and data["locked_numbers"] == [3] and data["complete"] is False
    assert data["line"] == engine.report_line(report)
    assert json.loads(json.dumps(data)) == data


# --------------------------------------------------------------------------- what a run carries
# Build 6 review: the cooldown is asked before every request, the failure streak belongs to the
# run, a cookies file every download would refuse costs no list, a selection reports on the whole
# series, and --dump-raw keeps the series of a batch apart.


def test_a_cooldown_recorded_during_a_pause_stops_the_run_before_its_next_request(tmp_path):
    """Another front end (a resolve of the web server, a second CLI) meets a refusal while this
    run sleeps through its 15-30 min long break: the next episode is never requested."""
    clock, events, stops = FakeClock(), [], []

    def sleep(seconds):
        clock.sleep(seconds)
        if events[-1][0] == "long-rest":
            record_block("HTTP 429 met by the web server", "web")

    series = _numbered_series(5)
    results = engine.download_series(
        series,
        series.episodes,
        _quiet(tmp_path),
        downloader=RecordingDownloader(events),
        sleep=sleep,
        rng=FixedRandom(),
        on_pause=lambda kind, seconds: events.append((kind, seconds)),
        pacing=engine.PacingState(run_attempts=98),
        clock=clock,
        on_stop=stops.append,
    )
    assert events == [
        ("attempt", SERIES_ID, 1),
        ("attempt", SERIES_ID, 2),
        ("long-rest", 1350.0),  # the run's 100th attempt is behind it: then nothing more
    ]
    until = clock_time(active_cooldown().until)
    assert [(result.status, result.message) for result in results[2:]] == [
        (DownloadStatus.FAILED_RATE_LIMITED, f"stopped: cooldown until {until}")
    ] * 3
    assert stops == [f"cooldown until {until}"]  # once
    assert engine.exit_code(results) == 5
    assert read_cooldown().source == "web"  # the refusal is not recorded a second time


def test_a_cooldown_met_right_before_an_episode_ends_the_batch(tmp_path):
    """No pause is needed for the check: a refusal recorded by another DramaFetch process while
    episode 1 downloads stops the run before episode 2, and the batch with it."""
    events = []

    class RefusedMeanwhile(RecordingDownloader):
        def download(self, episode, options):
            result = super().download(episode, options)
            record_block("HTTP 403 met by another DramaFetch process", "yt-dlp")
            return result

    discovery = BatchDiscovery(
        _numbered_series(3), _numbered_series(2, SERIES_2, NAME_2), events=events
    )
    runs = _batch([SERIES_ID, SERIES_2], discovery, tmp_path, downloader=RefusedMeanwhile(events))
    assert [event for event in events if event[0] == "attempt"] == [("attempt", SERIES_ID, 1)]
    assert discovery.calls == [SERIES_ID]  # the second series is never resolved
    assert runs[0].stop and runs[0].exit_code == 5
    assert runs[0].report.stopped.startswith("cooldown until ")
    assert [result.status for result in runs[0].results] == [
        DownloadStatus.DONE,
        DownloadStatus.FAILED_RATE_LIMITED,
        DownloadStatus.FAILED_RATE_LIMITED,
    ]
    assert runs[1].error.startswith(f"not started: batch stopped in {NAME} (cooldown until ")
    assert engine.batch_exit_code(runs) == 5


def test_three_failures_in_a_row_stop_a_batch_across_its_series(tmp_path):
    """Each series has two episodes left and every request fails: the streak is the run's, so
    the third failure — the first episode of the second series — ends the batch."""
    third = "7699393770256782300"
    ids = [SERIES_ID, SERIES_2, third]
    discovery = BatchDiscovery(
        *(_numbered_series(2, series_id, f"Series {n}") for n, series_id in enumerate(ids, 1))
    )
    failing = {(series_id, n): DownloadStatus.FAILED for series_id in ids for n in (1, 2)}
    pacing = engine.PacingState()
    runs = _batch(
        ids,
        discovery,
        tmp_path,
        downloader=RecordingDownloader(discovery.events, failing),
        pacing=pacing,
    )
    attempts = [event[1:] for event in discovery.events if event[0] == "attempt"]
    assert attempts == [(SERIES_ID, 1), (SERIES_ID, 2), (SERIES_2, 1)]
    assert discovery.calls == [SERIES_ID, SERIES_2]  # the third series is never resolved
    assert [run.stop for run in runs] == [False, True, False]
    assert runs[1].report.stopped == "3 consecutive failures"
    assert runs[1].results[1].message == "stopped: 3 consecutive failures (last: failed happened)"
    assert runs[2].error == "not started: batch stopped in Series 2 (3 consecutive failures)"
    assert runs[2].error_kind == "not-started" and runs[2].results == []
    assert engine.batch_exit_code(runs) == 2
    assert pacing.consecutive_failures == 0  # the stop was acted on: a later run starts afresh


def test_the_run_streak_resets_on_a_done_and_after_an_idle_gap_not_between_series(tmp_path):
    clock, pacing = FakeClock(), engine.PacingState()
    failed, done = DownloadStatus.FAILED, DownloadStatus.DONE

    def series_run(series_id, statuses):
        series = _numbered_series(len(statuses), series_id)
        return engine.download_series(
            series,
            series.episodes,
            _quiet(tmp_path / series_id),
            downloader=FakeDownloader(dict(enumerate(statuses, start=1))),
            sleep=clock.sleep,
            rng=FixedRandom(),
            pacing=pacing,
            clock=clock,
        )

    series_run(SERIES_ID, [failed, failed])
    assert pacing.consecutive_failures == 2  # kept for the next series of the run
    series_run(SERIES_2, [done, failed])
    assert pacing.consecutive_failures == 1  # a done resets it
    clock.now += 900  # 15 minutes without a request: like the long break, the streak is over
    results = series_run("7699393770256782300", [failed, failed])
    assert pacing.consecutive_failures == 2
    assert not any(result.message.startswith("stopped: ") for result in results)


def test_a_malformed_cookies_file_ends_the_batch_before_any_request(tmp_path):
    """Every download would refuse that file (yt-dlp would print its lines, values included), so
    the first series that needs TikTok stops the batch before its list is even loaded."""
    cookies = tmp_path / "cookies.txt"
    cookies.write_text("# Netscape HTTP Cookie File\n.tiktok.com\tTRUE\t/\n", encoding="utf-8")
    discovery = BatchDiscovery(make_series(numbers=(1, 2)), _numbered_series(2, SERIES_2, NAME_2))
    options = _quiet(tmp_path, cookies_file=cookies)
    runs = _batch([SERIES_ID, SERIES_2], discovery, tmp_path, options=options)
    assert discovery.events == []  # no resolve, no rest, no attempt
    first = runs[0]
    assert first.error_kind == "cookies" and first.stop and first.exit_code == 2
    assert not first.contacted and first.results == [] and first.series is None
    assert first.error == (
        "cookies file cookies.txt has malformed lines (line 2: 3 fields (expected 7)); yt-dlp "
        "would print them, cookie values included: fix or re-export the file"
    )
    assert first.report.stopped == engine.COOKIES_STOP == "malformed cookies file"
    assert runs[1].error == f"not started: batch stopped in {SERIES_ID} (malformed cookies file)"
    assert engine.batch_exit_code(runs) == 2
    # A dry run downloads nothing: it lists the series as usual.
    series = make_series(numbers=(1, 2))
    dry = _quiet(tmp_path / "dry", cookies_file=cookies, dry_run=True)
    run = _run_series(series, dry, BatchDiscovery(series))
    assert run.error is None and [r.status for r in run.results] == [DownloadStatus.DRY_RUN] * 2


def test_on_disk_numbers_of_the_folder_the_download_would_use(tmp_path):
    """info and the web's badges pass the folder a download would write to: after a rename the
    old folder's episodes are not "on disk" there — the download would fetch them again."""
    series = make_series(numbers=(1, 2, 3))
    _run_series(series, _quiet(tmp_path), BatchDiscovery(series))
    renamed = make_series(numbers=(1, 2, 3), name="The Heiress")
    assert engine.on_disk_numbers(tmp_path, SERIES_ID) == {1, 2, 3}  # found by id
    assert engine.on_disk_numbers(tmp_path, SERIES_ID, series_dir(tmp_path, series)) == {1, 2, 3}
    assert engine.on_disk_numbers(tmp_path, SERIES_ID, series_dir(tmp_path, renamed)) == set()
    assert not series_dir(tmp_path, renamed).exists()  # read-only


def test_the_report_of_a_selection_covers_the_whole_series(tmp_path):
    """`download --episodes 3` once the other free episodes are saved: the rows are the
    selection's, the report the series' — what an earlier run saved is on disk, the locked
    episode is locked, nothing is "not downloaded" — and a selection never marks it complete."""
    series = make_series(numbers=(1, 2, 3, 4, 5), locked=(5,), total=5)
    _run_series(series, _quiet(tmp_path), BatchDiscovery(series), episodes_spec="1-2,4")
    run = _run_series(series, _quiet(tmp_path), BatchDiscovery(series), episodes_spec="3")
    assert [(result.episode.number, result.status) for result in run.results] == [
        (3, DownloadStatus.DONE)
    ]
    assert (run.report.done, run.report.on_disk, run.report.locked) == (1, 3, 1)
    assert engine.report_line(run.report) == (
        "complete: 4 of 5 (1 downloaded, 3 already on disk) — 1 locked (5)"
    )
    assert read_manifest(series_dir(tmp_path, series), SERIES_ID).complete_at is None
    (series_dir(tmp_path, series) / "fake - Episode 04.mp4").unlink()
    run = _run_series(series, _quiet(tmp_path), BatchDiscovery(series), episodes_spec="1")
    assert engine.report_line(run.report) == "incomplete: 3 of 5 — 1 locked (5), 1 not downloaded"
    rows = [DownloadResult(_episode(2), DownloadStatus.DONE, Path("/x/2.mp4"))]
    assert engine.report_rows(series, rows, None)[1:] == [locked_result(series.episodes[4])]


def test_dump_raw_gives_each_series_of_a_batch_its_own_folder(tmp_path):
    """--dump-raw writes fixed file names (item_list_1.json, detail.json, …): in a batch each
    series gets DIR/<series id>/, so no series overwrites another's payloads."""

    class DumpingDiscovery(BatchDiscovery):
        def discover(self, ref, options):
            self.events.append(("dump", options.dump_dir))
            return super().discover(ref, options)

    raw = tmp_path / "raw"
    discovery = DumpingDiscovery(make_series(numbers=(1,)), _numbered_series(1, SERIES_2, NAME_2))
    common = {
        "discovery": discovery,
        "downloader": FakeDownloader(),
        "sleep": lambda seconds: None,
        "rng": FixedRandom(),
    }
    refs = [SeriesRef(SERIES_ID), SeriesRef(SERIES_2)]
    engine.run_batch(refs, DiscoveryOptions(dump_dir=raw), _quiet(tmp_path / "a"), **common)
    dumps = [event[1] for event in discovery.events if event[0] == "dump"]
    assert dumps == [raw / SERIES_ID, raw / SERIES_2]
    discovery.events.clear()
    engine.run_batch(refs[:1], DiscoveryOptions(dump_dir=raw), _quiet(tmp_path / "b"), **common)
    assert [event[1] for event in discovery.events if event[0] == "dump"] == [raw]  # one: DIR


# --------------------------------------------------------------------------- build 7
# Paid episodes the user's own account unlocked are downloaded like free ones and named in the
# report; a series skipped as complete still says what is locked (and that --recheck looks
# again); a DRM verdict is remembered, so the next run skips that episode without a request.

PAID_SERIES = "7699393770256782388"
PAID_NAME = "Paid Love Story"
FIXTURES = Path(__file__).parent / "fixtures"


def _paid_series(logged_in=True):
    """The fake TikTok's third series as the catalog reads its unit fixtures: episodes 1-2 free,
    3 paid (unlocked with the session of the account that bought it, locked without), 4 locked
    for everyone; TikTok announces 4."""
    name = "logged_in" if logged_in else "logged_out"
    payload = json.loads((FIXTURES / f"item_list_series3_{name}.json").read_text(encoding="utf-8"))
    episodes = parse_item_list_payload(payload, PAID_SERIES).episodes
    return Series(series_id=PAID_SERIES, name=PAID_NAME, episodes=episodes, total_hint=4)


def _paid_episode(number, access="unlocked"):
    return replace(_episode(number, ("isFree=false",)), access=access, paid=True)


class DrmDownloader(FakeDownloader):
    """FakeDownloader whose `drm` episodes come back the way both engines report an encrypted
    download: FAILED_UNAVAILABLE with models.DRM_MESSAGE (the file already deleted)."""

    def __init__(self, drm=(), outcomes=None):
        super().__init__(outcomes)
        self.drm = set(drm)

    def download(self, episode, options):
        if episode.number in self.drm and not (episode.locked and not options.include_locked):
            self.calls.append((episode.number, options.out_dir))
            return DownloadResult(episode, DownloadStatus.FAILED_UNAVAILABLE, message=DRM_MESSAGE)
        return super().download(episode, options)


def _seed_manifest(out_dir, series, *results):
    """The series' manifest with `results` recorded, as an earlier run would have left it."""
    directory = series_dir(out_dir, series)
    directory.mkdir(parents=True, exist_ok=True)
    manifest = Manifest.load(directory / MANIFEST_FILENAME, series.series_id, series.name)
    for result in results:
        manifest.record(result)
    return manifest


def _drm_failure(episode):
    return DownloadResult(episode, DownloadStatus.FAILED_UNAVAILABLE, message=DRM_MESSAGE)


def test_unlocked_paid_episodes_download_like_free_ones_and_the_report_names_them(tmp_path):
    series = _paid_series(logged_in=True)
    assert [episode.access for episode in series.episodes] == ["free", "free", "unlocked", "locked"]
    events = []
    downloader = RecordingDownloader(events)
    run = _run_series(series, _quiet(tmp_path), BatchDiscovery(series), downloader=downloader)
    assert events == [("attempt", PAID_SERIES, number) for number in (1, 2, 3)]  # 4: no request
    assert [result.status for result in run.results] == [DownloadStatus.DONE] * 3 + [
        DownloadStatus.SKIPPED_LOCKED
    ]
    report = run.report
    assert report.complete and (report.unlocked, report.unlocked_numbers) == (1, (3,))
    assert report.locked_numbers == (4,)
    assert engine.report_line(report) == (
        "complete: 3 of 4 (3 downloaded) — 1 paid episode your account unlocked (3), 1 locked (4)"
    )
    data = engine.report_to_dict(report)
    assert data["unlocked"] == 1 and data["unlocked_numbers"] == [3]
    assert json.loads(json.dumps(data)) == data
    view = engine.episode_to_dict(series.episodes[2])
    assert (view["access"], view["paid"], view["drm"], view["locked"]) == (
        "unlocked",
        True,
        False,
        False,
    )
    assert engine.episode_to_dict(series.episodes[3])["access"] == "locked"
    assert engine.episode_to_dict(series.episodes[0])["paid"] is False


def test_without_the_session_a_paid_episode_is_locked_and_never_requested(tmp_path):
    series = _paid_series(logged_in=False)
    assert [episode.access for episode in series.episodes] == ["free", "free", "locked", "locked"]
    events = []
    run = _run_series(
        series, _quiet(tmp_path), BatchDiscovery(series), downloader=RecordingDownloader(events)
    )
    assert events == [("attempt", PAID_SERIES, 1), ("attempt", PAID_SERIES, 2)]
    assert [result.status for result in run.results[2:]] == [DownloadStatus.SKIPPED_LOCKED] * 2
    assert run.report.unlocked == 0 and run.report.complete
    assert engine.report_line(run.report) == "complete: 2 of 4 (2 downloaded) — 2 locked (3, 4)"
    # --include-locked asks TikTok anyway, with the same session: TikTok decides, nothing more
    events.clear()
    _run_series(
        series,
        _quiet(tmp_path / "again", include_locked=True),
        BatchDiscovery(series),
        downloader=RecordingDownloader(events),
    )
    assert [event[2] for event in events] == [1, 2, 3, 4]


def test_report_lines_name_the_unlocked_episodes_before_the_locked_ones():
    series = Series(
        SERIES_ID,
        NAME,
        [_episode(1), _episode(2), _paid_episode(3), _paid_episode(4)],
        total_hint=4,
    )
    report = engine.series_report(series, _rows(series, {}))
    assert (report.unlocked, report.unlocked_numbers) == (2, (3, 4))
    assert engine.report_line(report) == (
        "complete: 4 of 4 (4 downloaded) — 2 paid episodes your account unlocked (3, 4)"
    )
    # one found already on disk counts as well: an unlocked episode the run did not need again
    rows = _rows(series, {4: DownloadStatus.SKIPPED_EXISTS})
    assert engine.report_line(engine.series_report(series, rows)) == (
        "complete: 4 of 4 (3 downloaded, 1 already on disk) — 2 paid episodes your account "
        "unlocked (3, 4)"
    )
    # an incomplete series lists them among its details, before the locked ones; an unlocked
    # episode that failed was not obtained and is a failure, not an unlocked one
    mixed = Series(
        SERIES_ID,
        NAME,
        [_episode(1), _episode(2), _paid_episode(3), _paid_episode(4, "locked"), _paid_episode(5)],
    )
    rows = _rows(mixed, {4: DownloadStatus.SKIPPED_LOCKED, 5: DownloadStatus.FAILED})
    report = engine.series_report(mixed, rows)
    assert report.unlocked_numbers == (3,) and not report.complete
    assert engine.report_line(report) == (
        "incomplete: 3 of 5 — 1 paid episode your account unlocked (3), 1 locked (4), 1 failed (5)"
    )
    assert engine.report_to_dict(report)["unlocked_numbers"] == [3]


def test_the_skipped_complete_line_names_the_locked_episodes_and_points_at_recheck():
    report = engine.SeriesReport(
        series_id=SERIES_ID,
        name=NAME,
        listed=0,
        done=0,
        on_disk=4,
        locked=1,
        failed=0,
        gaps=(),
        complete=True,
        skipped_complete=True,
        stopped=None,
        total=4,
        locked_numbers=(4,),
        checked_ago_s=7200,
    )
    assert engine.report_line(report) == (
        "complete, nothing to do: 4 episodes already on disk, 1 locked (4) (checked 2 h ago) — "
        "unlocked more in the TikTok app since? --recheck looks again"
    )
    assert engine.RECHECK_HINT == "unlocked more in the TikTok app since? --recheck looks again"
    # without locked episodes the line is the build-6 one
    assert engine.report_line(replace(report, locked=0, locked_numbers=())) == (
        "complete, nothing to do: 4 episodes already on disk (checked 2 h ago)"
    )


def test_a_series_skipped_as_complete_says_what_is_locked_and_recheck_gets_the_unlocked_one(
    tmp_path,
):
    before = _paid_series(logged_in=False)  # cookies of an account that has not bought 3 yet
    discovery = BatchDiscovery(before)
    first = _run_series(before, _quiet(tmp_path), discovery)
    assert first.report.complete and first.report.locked_numbers == (3, 4)
    downloader = FakeDownloader()
    again = _run_series(
        before, _quiet(tmp_path), discovery, wall=WALL + 2 * 3600, downloader=downloader
    )
    assert discovery.calls == [PAID_SERIES] and downloader.calls == []  # not one request
    assert again.report.skipped_complete and again.contacted is False
    assert [result.episode.number for result in again.results] == [1, 2]  # no rows for 3, 4
    assert (again.report.locked, again.report.locked_numbers) == (2, (3, 4))
    assert engine.report_line(again.report) == (
        "complete, nothing to do: 2 episodes already on disk, 2 locked (3, 4) (checked 2 h ago) "
        "— unlocked more in the TikTok app since? --recheck looks again"
    )
    manifest = read_manifest(series_dir(tmp_path, before), PAID_SERIES)
    assert manifest.locked_numbers() == [3, 4] and manifest.complete_episodes == 2  # read-only
    # the user bought episode 3 in the TikTok app and exported fresh cookies: --recheck
    after = _paid_series(logged_in=True)
    discovery.series[PAID_SERIES] = after
    events = []
    rechecked = _run_series(
        after,
        _quiet(tmp_path, recheck=True),
        discovery,
        wall=WALL + 3 * 3600,
        downloader=RecordingDownloader(events),
    )
    assert discovery.calls == [PAID_SERIES, PAID_SERIES]
    assert events == [("attempt", PAID_SERIES, 3)]  # 1-2 on disk, 4 still locked
    assert engine.report_line(rechecked.report) == (
        "complete: 3 of 4 (1 downloaded, 2 already on disk) — 1 paid episode your account "
        "unlocked (3), 1 locked (4)"
    )


def test_a_remembered_drm_verdict_costs_no_request_no_pause_and_no_count(tmp_path):
    series = make_series(numbers=(1, 2, 3, 4))
    _seed_manifest(tmp_path, series, _drm_failure(series.episodes[1]))
    options = DownloadOptions(out_dir=tmp_path)  # the default pacing: 4-9 s between attempts
    downloader = FakeDownloader()
    pacing = engine.PacingState()
    results, sleeps, pauses = _run(series, options, downloader, pacing=pacing)
    assert [number for number, _ in downloader.calls] == [1, 3, 4]
    skipped = results[1]
    assert skipped.status is DownloadStatus.SKIPPED_LOCKED and skipped.path is None
    assert (
        skipped.message
        == engine.DRM_REMEMBERED_MESSAGE
        == (
            "protected by DRM (found by an earlier run): DramaFetch does not decrypt it; "
            "--include-locked tries again"
        )
    )
    assert skipped.message.startswith(DRM_MARK)
    # one pause before attempts 2 and 3 of the run (episodes 3 and 4), none for the skip
    assert pauses == [("pace", 6.5), ("pace", 6.5)] and sleeps == [6.5, 6.5]
    assert pacing.run_attempts == 3
    # the skip keeps the memory: its message starts with the DRM mark too
    manifest = read_manifest(series_dir(tmp_path, series), SERIES_ID)
    assert manifest.entries[2].status == "skipped-locked" and manifest.drm_protected(2)
    # --include-locked asks TikTok again, with the same session (here it serves the episode)
    downloader = FakeDownloader()
    _run(series, replace(options, include_locked=True), downloader)
    assert [number for number, _ in downloader.calls] == [2]
    assert not read_manifest(series_dir(tmp_path, series), SERIES_ID).drm_protected(2)


def test_three_drm_failures_in_a_row_stop_the_run_and_the_next_run_skips_them(tmp_path):
    series = make_series(numbers=(1, 2, 3, 4, 5))
    options = _quiet(tmp_path)
    first, _, _ = _run(series, options, DrmDownloader(drm=(1, 2, 3)))
    assert [result.status for result in first] == [DownloadStatus.FAILED_UNAVAILABLE] * 3 + [
        DownloadStatus.FAILED
    ] * 2
    assert {result.message for result in first[:3]} == {DRM_MESSAGE}
    assert first[3].message.startswith("stopped: 3 consecutive failures (last: protected by DRM")
    # the next run: 1-3 skipped without a request, and the skips neither count nor reset
    pacing = engine.PacingState(consecutive_failures=1)
    downloader = FakeDownloader()
    skips = engine.download_series(
        series,
        series.episodes[:3],
        options,
        downloader=downloader,
        sleep=lambda seconds: pytest.fail("a skip never pauses"),
        rng=FixedRandom(),
        pacing=pacing,
    )
    assert [result.status for result in skips] == [DownloadStatus.SKIPPED_LOCKED] * 3
    assert {result.message for result in skips} == {engine.DRM_REMEMBERED_MESSAGE}
    assert downloader.calls == [] and pacing.run_attempts == 0
    assert pacing.consecutive_failures == 1
    results, _, _ = _run(series, options, downloader)
    assert [number for number, _ in downloader.calls] == [4, 5]
    assert [result.status for result in results[3:]] == [DownloadStatus.DONE] * 2


def test_a_stop_keeps_the_drm_memory_of_the_episodes_it_did_not_reach(tmp_path):
    series = make_series(numbers=(1, 2, 3))
    _seed_manifest(tmp_path, series, _drm_failure(series.episodes[2]))
    results, _, _ = _run(series, _quiet(tmp_path), FakeDownloader({1: DownloadStatus.FAILED_LOGIN}))
    assert [result.status for result in results] == [
        DownloadStatus.FAILED_LOGIN,
        DownloadStatus.FAILED_LOGIN,
        DownloadStatus.SKIPPED_LOCKED,
    ]
    assert results[1].message.startswith("stopped: episode 1 failed-login-required")
    assert results[2].message == engine.DRM_REMEMBERED_MESSAGE  # not "stopped: …"
    assert read_manifest(series_dir(tmp_path, series), SERIES_ID).drm_protected(3)


def test_a_failure_without_the_drm_mark_is_tried_again(tmp_path):
    series = make_series(numbers=(1, 2))
    unavailable = DownloadResult(
        series.episodes[0], DownloadStatus.FAILED_UNAVAILABLE, message="no video formats found"
    )
    payload_drm = DownloadResult(
        series.episodes[1], DownloadStatus.DONE, path=None, message=f"{DRM_MARK} but done"
    )
    _seed_manifest(tmp_path, series, unavailable, payload_drm)
    downloader = FakeDownloader()
    _run(series, _quiet(tmp_path), downloader)
    assert [number for number, _ in downloader.calls] == [1, 2]  # neither entry is a DRM verdict


def test_the_report_of_a_selection_counts_a_remembered_drm_episode_as_locked(tmp_path):
    series = make_series(numbers=(1, 2, 3), total=3)
    _seed_manifest(tmp_path, series, _drm_failure(series.episodes[2]))
    run = _run_series(series, _quiet(tmp_path), BatchDiscovery(series), episodes_spec="1-2")
    assert run.report.locked_numbers == (3,)
    rows = engine.report_rows(
        series, run.results, read_manifest(series_dir(tmp_path, series), SERIES_ID)
    )
    assert rows[-1].message == engine.DRM_REMEMBERED_MESSAGE
    # TikTok lists it as free, but it cannot be downloaded: like a locked episode it is left out
    # of "every downloadable episode is on disk" (build 7b) — as a whole run says
    assert run.report.complete
    assert engine.report_line(run.report) == "complete: 2 of 3 (2 downloaded) — 1 locked (3)"
    # a selection never marks the series complete for the 24-hour skip, though
    assert read_manifest(series_dir(tmp_path, series), SERIES_ID).complete_at is None


# --------------------------------------------------------------------------- build 7b
# The DRM memory holds only what a DOWNLOAD found (a payload flag is read again on every run);
# what cannot be downloaded is left out of completeness, so a series whose only missing episodes
# are DRM-protected is marked complete and skipped; and a refusal wins over DRM wording.

DONE = DownloadStatus.DONE
ON_DISK = DownloadStatus.SKIPPED_EXISTS
SKIPPED_LOCKED = DownloadStatus.SKIPPED_LOCKED
UNAVAILABLE = DownloadStatus.FAILED_UNAVAILABLE
BLOCKED = DownloadStatus.FAILED_BLOCKED


def test_models_hold_the_drm_memory_message_the_engine_writes():
    from dramafetch import models

    assert engine.DRM_REMEMBERED_MESSAGE is models.DRM_REMEMBERED_MESSAGE
    assert models.DRM_REMEMBERED_MESSAGE == (
        "protected by DRM (found by an earlier run): DramaFetch does not decrypt it; "
        "--include-locked tries again"
    )


def test_a_series_whose_only_missing_episode_is_remembered_drm_is_complete_and_then_skipped(
    tmp_path,
):
    """A first run finds episode 3 encrypted — the verdict of a download, remembered. The next
    whole-series run (every other episode already on disk, 3 skipped from the memory: not one
    download request) is complete, says what is locked and marks the manifest complete; so the
    run after it is skipped with ZERO requests — not even the list — and its line names 3 as
    locked with the --recheck hint (R-4). Before build 7b such a series stayed incomplete forever
    and every whole-series run listed it again, for nothing."""
    series = make_series(numbers=(1, 2, 3, 4), total=4)
    discovery = BatchDiscovery(series)
    first = _run_series(series, _quiet(tmp_path), discovery, downloader=DrmDownloader(drm=(3,)))
    assert [result.status for result in first.results] == [DONE, DONE, UNAVAILABLE, DONE]
    assert first.results[2].message == DRM_MESSAGE
    assert engine.report_line(first.report) == "incomplete: 3 of 4 — 1 failed (3)"
    manifest = read_manifest(series_dir(tmp_path, series), SERIES_ID)
    assert manifest.drm_protected(3) and manifest.complete_at is None

    downloader = FakeDownloader()
    second = _run_series(
        series, _quiet(tmp_path), discovery, downloader=downloader, wall=WALL + 60
    )
    assert discovery.calls == [SERIES_ID, SERIES_ID]  # listed again: it was not complete yet
    assert downloader.calls == []  # 1, 2, 4 on disk, 3 remembered: no download request at all
    assert [result.status for result in second.results] == [
        ON_DISK,
        ON_DISK,
        SKIPPED_LOCKED,
        ON_DISK,
    ]
    assert second.results[2].message == engine.DRM_REMEMBERED_MESSAGE
    report = second.report
    assert report.complete and (report.locked, report.locked_numbers) == (1, (3,))
    assert engine.report_line(report) == "complete: 3 of 4 (3 already on disk) — 1 locked (3)"
    manifest = read_manifest(series_dir(tmp_path, series), SERIES_ID)
    assert manifest.complete_episodes == 3 and manifest.complete_since() == WALL + 60
    assert manifest.locked_numbers() == [3] and manifest.drm_protected(3)

    third_downloader = FakeDownloader()
    third = _run_series(
        series,
        _quiet(tmp_path),
        discovery,
        downloader=third_downloader,
        wall=WALL + 60 + 2 * 3600,
    )
    assert discovery.calls == [SERIES_ID, SERIES_ID]  # zero requests: not even the list
    assert third_downloader.calls == [] and third.contacted is False
    assert third.report.skipped_complete and third.report.locked_numbers == (3,)
    assert [result.episode.number for result in third.results] == [1, 2, 4]  # no row for 3
    assert engine.report_line(third.report) == (
        "complete, nothing to do: 3 episodes already on disk, 1 locked (3) (checked 2 h ago) "
        "— unlocked more in the TikTok app since? --recheck looks again"
    )


def test_with_include_locked_a_remembered_drm_episode_is_attempted_and_a_failure_counts(tmp_path):
    """`--include-locked` asks TikTok again for an episode the memory would skip — with the same
    session: TikTok decides. Encrypted again, it is a failure as before (the series incomplete,
    its complete mark forgotten); served playable, it downloads and the memory is gone."""
    series = make_series(numbers=(1, 2, 3), total=3)
    discovery = BatchDiscovery(series)
    _run_series(series, _quiet(tmp_path), discovery, downloader=DrmDownloader(drm=(3,)))
    marked = _run_series(series, _quiet(tmp_path), discovery)
    assert marked.report.complete
    assert read_manifest(series_dir(tmp_path, series), SERIES_ID).complete_at is not None

    downloader = DrmDownloader(drm=(3,))
    again = _run_series(
        series, _quiet(tmp_path, include_locked=True), discovery, downloader=downloader
    )
    assert [number for number, _ in downloader.calls] == [3]  # only the remembered one is asked
    assert [result.status for result in again.results] == [ON_DISK, ON_DISK, UNAVAILABLE]
    assert not again.report.complete
    assert engine.report_line(again.report) == "incomplete: 2 of 3 — 1 failed (3)"
    manifest = read_manifest(series_dir(tmp_path, series), SERIES_ID)
    assert manifest.complete_at is None and manifest.drm_protected(3)

    served = FakeDownloader()
    last = _run_series(series, _quiet(tmp_path, include_locked=True), discovery, downloader=served)
    assert [number for number, _ in served.calls] == [3]
    assert engine.report_line(last.report) == "complete: 3 of 3 (1 downloaded, 2 already on disk)"
    assert not read_manifest(series_dir(tmp_path, series), SERIES_ID).drm_protected(3)


def _payload_item(number, **drama):
    """An item_list entry as TikTok's web app serves it (free, with a play address); `drama`
    goes into `dramaInfo.DramaVideoData`."""
    return {
        "id": f"76994000000000000{number:02d}",
        "desc": f"{NAME} | Episode {number}",
        "author": {"uniqueId": "muffindrama_us"},
        "video": {
            "duration": 3,
            "playAddr": "https://v16-webapp-prime.tiktok.com/video/tos/x/?a=1988&expire=1",
        },
        "dramaInfo": {
            "dramaID": SERIES_ID,
            "dramaName": NAME,
            "DramaVideoData": {"EpisodeNumber": number, **drama},
        },
    }


def _payload_series(*items):
    payload = {"itemList": list(items), "hasMore": False}
    return Series(SERIES_ID, NAME, parse_item_list_payload(payload, SERIES_ID).episodes)


def test_a_payload_drm_flag_is_not_remembered_the_next_run_reads_the_payload_again(tmp_path):
    """The payload is read again on every run, so its DRM flag is never remembered: a run that
    still finds it skips the episode for the payload's reason, and once TikTok stops flagging it
    the next run asks for it — with the same session."""
    flagged = _payload_series(_payload_item(1), _payload_item(2, isDrm=True))
    assert [episode.drm for episode in flagged.episodes] == [False, True]
    events = []
    results, _, _ = _run(flagged, _quiet(tmp_path), RecordingDownloader(events))
    assert events == [("attempt", SERIES_ID, 1)]  # the flagged one: no request
    flag = "protected by DRM (isDrm=True): DramaFetch does not decrypt it"
    assert (results[1].status, results[1].message) == (SKIPPED_LOCKED, flag)
    manifest = read_manifest(series_dir(tmp_path, flagged), SERIES_ID)
    assert manifest.entries[2].status == "skipped-locked" and manifest.entries[2].message == flag
    assert not manifest.drm_protected(2)

    # still flagged: skipped again, for the payload's reason — not "found by an earlier run"
    events.clear()
    results, _, _ = _run(flagged, _quiet(tmp_path), RecordingDownloader(events))
    assert events == [] and results[1].message == flag

    # TikTok stopped flagging it: the next run asks for it
    clear = _payload_series(_payload_item(1), _payload_item(2))
    assert not clear.episodes[1].locked
    results, _, _ = _run(clear, _quiet(tmp_path), RecordingDownloader(events))
    assert events == [("attempt", SERIES_ID, 2)]  # 1 is on disk
    assert [result.status for result in results] == [ON_DISK, DONE]


class _FailingYdl:
    """A yt-dlp stand-in whose every download raises the next of the shared `errors`."""

    def __init__(self, errors, asked):
        self.errors, self.asked = errors, asked

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def download(self, urls):
        self.asked.append(urls[0])
        raise self.errors.pop(0)


def test_yt_dlps_drm_error_is_remembered_and_a_403_naming_drm_stops_with_the_cooldown(tmp_path):
    """Through the real yt-dlp downloader: "This video is DRM protected" is FAILED_UNAVAILABLE
    with DRM_MESSAGE first (describe_failure), which the manifest remembers; an HTTP 403 whose
    message also names DRM is a refusal — FAILED_BLOCKED, the run stops there and the 30-minute
    cooldown is recorded — and is never remembered as DRM."""
    from yt_dlp.utils import DownloadError

    from dramafetch.downloader import BLOCKED_MESSAGE, YtDlpDownloader

    drm_error = "ERROR: [TikTok] 7699400000000000001: This video is DRM protected"
    blocked_error = (
        "ERROR: [TikTok] 7699400000000000002: HTTP Error 403: Forbidden (DRM protected?)"
    )
    errors = [DownloadError(drm_error), DownloadError(blocked_error)]
    asked = []
    downloader = YtDlpDownloader(lambda params: _FailingYdl(errors, asked))
    series = make_series(numbers=(1, 2, 3))
    results, _, _ = _run(series, _quiet(tmp_path), downloader)
    assert [result.status for result in results] == [UNAVAILABLE, BLOCKED, BLOCKED]
    assert results[0].message == f"{DRM_MESSAGE}: {drm_error}"
    assert results[1].message == f"{BLOCKED_MESSAGE}: {blocked_error}"
    assert results[2].message.startswith("stopped: episode 2 failed-blocked")
    assert asked == [series.episodes[0].page_url, series.episodes[1].page_url]  # 3: no request
    recorded = active_cooldown()
    assert recorded is not None and recorded.source == "yt-dlp"
    assert recorded.reason.startswith("blocked (HTTP 403): TikTok refused the request")
    manifest = read_manifest(series_dir(tmp_path, series), SERIES_ID)
    assert manifest.drm_protected(1)
    assert not manifest.drm_protected(2) and not manifest.drm_protected(3)

    # after the cooldown: 1 is skipped from the memory without a request, 2 and 3 are tried again
    clear_cooldown()
    errors[:] = [DownloadError("Video not available"), DownloadError("Video not available")]
    asked.clear()
    results, _, _ = _run(series, _quiet(tmp_path), downloader)
    assert asked == [series.episodes[1].page_url, series.episodes[2].page_url]
    assert (results[0].status, results[0].message) == (
        SKIPPED_LOCKED,
        engine.DRM_REMEMBERED_MESSAGE,
    )
    assert [result.status for result in results[1:]] == [UNAVAILABLE, UNAVAILABLE]
    assert active_cooldown() is None
