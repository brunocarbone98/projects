"""engine: episode selection, deterministic download_series, pacing, early stops, engines, exit
codes, resolve."""

from __future__ import annotations

import json
import random
import sys
import types
from pathlib import Path
from typing import ClassVar

import pytest

from dramafetch import engine
from dramafetch.cooldown import active_cooldown, clear_cooldown, read_cooldown
from dramafetch.downloader import locked_result
from dramafetch.errors import ChallengeError, DiscoveryError, LoginRequiredError, RateLimitedError
from dramafetch.manifest import MANIFEST_FILENAME, Manifest, series_dir
from dramafetch.models import (
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
