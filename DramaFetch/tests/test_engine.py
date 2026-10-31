"""engine: episode selection, deterministic download_series, early stop, exit codes, resolve."""

from __future__ import annotations

import json
import random
import sys
import types
from pathlib import Path

import pytest

from dramafetch import engine
from dramafetch.downloader import locked_result
from dramafetch.manifest import MANIFEST_FILENAME, Manifest, series_dir
from dramafetch.models import (
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


def _episode(number, hints=()):
    return Episode(
        number=number,
        item_id=f"76994000000000000{number:02d}",
        title=f"{NAME} | Episode {number}",
        series_id=SERIES_ID,
        series_name=NAME,
        author="muffindrama_us",
        lock_hints=tuple(hints),
    )


def make_series(numbers=(1, 2, 3, 4, 5), locked=(), name=NAME, total=None):
    episodes = [_episode(n, ("isFree=false",) if n in locked else ()) for n in numbers]
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
            path = options.out_dir / f"E{episode.number:02d} - x.mp4"
            path.write_bytes(b"video")
            return DownloadResult(episode, status, path, "saved")
        return DownloadResult(episode, status, message=f"{status.value} happened")


class FixedRandom(random.Random):
    def uniform(self, a, b):
        return (a + b) / 2


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


@pytest.mark.parametrize("spec", ["3-1", "0", "a", "1-2-3", ",", "--", "1-a", "0-5", "1 2"])
def test_invalid_specs_raise_value_error(spec):
    with pytest.raises(ValueError, match="invalid episode spec"):
        engine.select_episodes(make_series(), spec)


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
    assert engine.missing_from_selection(Series(SERIES_ID, None, []), "1-3") == [(1, 3)]
    assert engine.compress_ranges([1, 2, 3, 7, 9, 10]) == [(1, 3), (7, 7), (9, 10)]
    assert engine.compress_ranges([]) == []
    assert engine.format_ranges([(1, 3), (7, 7), (9, 10)]) == "1-3, 7, 9-10"


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
    done_file = target / "E02 - earlier run.mp4"
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
    assert sleeps == [5.0]  # between the two network attempts (default 3-7 -> midpoint 5)

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
    (target / f"E02 - {NAME} Episode 2.mp4").write_bytes(b"v")  # matches episode_stem(ep 2)

    class SkipsExisting(FakeDownloader):
        def download(self, episode, options):
            from dramafetch.downloader import existing_episode_file

            existing = existing_episode_file(options.out_dir, episode)
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
    assert sleeps == [5.0]
    manifest = json.loads((series_dir(tmp_path, series) / MANIFEST_FILENAME).read_text("utf-8"))
    assert manifest["episodes"]["4"]["status"] == "failed-login-required"
    assert manifest["episodes"]["5"]["status"] == "skipped-locked"
    assert engine.exit_code(results) == 3


def test_early_stop_on_rate_limit_keeps_done_episodes_as_skipped(tmp_path):
    series = make_series(numbers=(1, 2, 3, 4))
    target = series_dir(tmp_path, series)
    target.mkdir(parents=True)
    done_file = target / "E03 - earlier.mp4"
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


def test_json_views():
    series = make_series(numbers=(2, 1), locked=(2,), total=5)
    series.warnings.append("w")
    data = engine.series_to_dict(series)
    assert data["series_id"] == SERIES_ID
    assert data["name"] == NAME
    assert data["total_hint"] == 5
    assert data["warnings"] == ["w"]
    assert [e["number"] for e in data["episodes"]] == [1, 2]
    assert data["episodes"][1]["locked"] is True
    assert data["episodes"][1]["lock_hints"] == ["isFree=false"]
    assert data["episodes"][0]["page_url"].endswith("/video/7699400000000000001")
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
