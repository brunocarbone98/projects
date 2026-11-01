"""cli: parsing of every subcommand, info/download/video end-to-end with fakes, doctor, serve."""

from __future__ import annotations

import argparse
import copy
import io
import json
import re
import socket
import sys
import time
import types
from pathlib import Path
from typing import ClassVar

import pytest
from mutagen import version_string as mutagen_version

from dramafetch import __version__, cli, engine
from dramafetch.catalog import catalog_warnings
from dramafetch.cooldown import active_cooldown, clear_cooldown, record_block
from dramafetch.downloader import locked_result
from dramafetch.errors import (
    ChallengeError,
    DiscoveryError,
    LoginRequiredError,
    RateLimitedError,
)
from dramafetch.manifest import MANIFEST_FILENAME
from dramafetch.media import INCOMPLETE_PREFIX
from dramafetch.models import DownloadOptions, DownloadResult, DownloadStatus, Episode, Series

SERIES_ID = "7699393770256782354"
TINY_MP4 = (Path(__file__).parent / "fixtures" / "tiny.mp4").read_bytes()  # a real 3 s MP4
NAME = "The Billionaire's Secret Heiress"
SERIES_URL = f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1"
VIDEO_URL = "https://www.tiktok.com/@ana/video/7699400000000000001"


def _episode(number, hints=()):
    return Episode(
        number=number,
        item_id=f"76994000000000000{number:02d}",
        title=f"{NAME} | Episode {number}",
        series_id=SERIES_ID,
        series_name=NAME,
        author="muffindrama_us",
        duration_s=90 + number,
        lock_hints=tuple(hints),
    )


def make_series():
    episodes = [
        _episode(1),
        _episode(2),
        _episode(3),
        _episode(5, ("isFree=false", "isLocked=True")),
    ]
    series = Series(series_id=SERIES_ID, name=NAME, episodes=episodes, total_hint=5)
    series.warnings = catalog_warnings(episodes, 5)
    return series


class FakeDiscovery:
    def __init__(self, series=None, error=None):
        self.series = series
        self.error = error
        self.calls = []

    def discover(self, ref, options):
        self.calls.append((ref, options))
        if self.error is not None:
            raise self.error
        return self.series


@pytest.fixture
def fake_discovery(monkeypatch):
    """Installs a fake `dramafetch.discovery` module so engine.resolve's lazy import finds it."""
    discovery = FakeDiscovery(make_series())
    module = types.ModuleType("dramafetch.discovery")
    module.choose_discovery = lambda options: discovery
    monkeypatch.setitem(sys.modules, "dramafetch.discovery", module)
    return discovery


class FakeDownloader:
    """Replaces engine.YtDlpDownloader (what engine.make_downloader builds for the default engine):
    no network, creates files, outcomes per episode number."""

    outcomes: ClassVar[dict[int, DownloadStatus]] = {}
    instances: ClassVar[list[FakeDownloader]] = []

    def __init__(self, ydl_factory=None):
        self.calls = []
        FakeDownloader.instances.append(self)

    def download(self, episode, options):
        self.calls.append((episode, options))
        if episode.locked and not options.include_locked:
            return locked_result(episode)
        if options.dry_run:
            return DownloadResult(
                episode, DownloadStatus.DRY_RUN, message=f"would download {episode.page_url}"
            )
        status = self.outcomes.get(episode.number, DownloadStatus.DONE)
        if status is DownloadStatus.DONE:
            options.out_dir.mkdir(parents=True, exist_ok=True)
            path = options.out_dir / f"fake - Episode {episode.number:02d}.mp4"
            path.write_bytes(b"v")
            return DownloadResult(episode, status, path, f"saved {path.name} + cover embedded")
        return DownloadResult(episode, status, message=f"{status.value} from fake")


@pytest.fixture
def fake_downloader(monkeypatch):
    FakeDownloader.outcomes = {}
    FakeDownloader.instances = []
    monkeypatch.setattr(engine, "YtDlpDownloader", FakeDownloader)
    return FakeDownloader


@pytest.fixture
def no_sleep(monkeypatch):
    """Makes the CLI's engine.run_batch (the rest between series) and engine.download_series (the
    pauses inside a series) use an instant sleep; the pauses are still computed and announced
    through on_pause, so their printing can be tested. Returns the list of seconds "slept"."""
    slept: list[float] = []
    real_batch = engine.run_batch
    real_download = engine.download_series

    def instant_batch(*args, **kwargs):
        kwargs.setdefault("sleep", slept.append)
        return real_batch(*args, **kwargs)

    def instant_download(*args, **kwargs):
        kwargs.setdefault("sleep", slept.append)
        return real_download(*args, **kwargs)

    monkeypatch.setattr(engine, "run_batch", instant_batch)
    monkeypatch.setattr(engine, "download_series", instant_download)
    return slept


class FakeBrowserDownloader:
    """What a fake `dramafetch.downloader_browser` module hands out: counts close() calls."""

    instances: ClassVar[list[FakeBrowserDownloader]] = []

    def __init__(self):
        self.calls = []
        self.closed = 0
        FakeBrowserDownloader.instances.append(self)

    def download(self, episode, options):
        self.calls.append((episode, options))
        if episode.locked and not options.include_locked:
            return locked_result(episode)
        options.out_dir.mkdir(parents=True, exist_ok=True)
        path = options.out_dir / f"browser - Episode {episode.number:02d}.mp4"
        path.write_bytes(b"v")
        return DownloadResult(episode, DownloadStatus.DONE, path, "saved 0.1 MiB")

    def close(self):
        self.closed += 1


@pytest.fixture
def fake_browser_engine(monkeypatch):
    FakeBrowserDownloader.instances = []
    module = types.ModuleType("dramafetch.downloader_browser")
    module.BrowserDownloader = FakeBrowserDownloader
    monkeypatch.setitem(sys.modules, "dramafetch.downloader_browser", module)
    return FakeBrowserDownloader


# --------------------------------------------------------------------------- parsing


def test_parser_info_defaults_and_flags(tmp_path):
    parser = cli.build_parser()
    args = parser.parse_args(["info", SERIES_URL])
    assert args.command == "info"
    assert args.url == SERIES_URL
    assert args.as_json is False
    assert args.out == "downloads"
    assert args.cookies is None
    assert args.strategy == "auto"
    assert args.browser_channel is None
    assert args.browser_path is None
    assert args.headful is False
    assert args.dump_raw is None
    assert args.timeout == 45.0
    assert args.base_url == "https://www.tiktok.com"
    assert (args.page_count, args.max_pages, args.page_delay) == (30, 60, 0.8)
    args = parser.parse_args(
        [
            "info",
            SERIES_URL,
            "--json",
            "--cookies",
            "c.txt",
            "--strategy",
            "static",
            "--browser-channel",
            "msedge",
            "--browser-path",
            "/usr/bin/chromium",
            "--headful",
            "--dump-raw",
            str(tmp_path),
            "--timeout",
            "5",
            "--base-url",
            "http://127.0.0.1:1",
            "--page-count",
            "10",
            "--max-pages",
            "2",
            "--page-delay",
            "0.1",
        ]
    )
    assert args.as_json is True
    assert args.cookies == Path("c.txt")
    assert args.strategy == "static"
    assert args.browser_channel == "msedge"
    assert args.browser_path == Path("/usr/bin/chromium")
    assert args.headful is True
    assert args.dump_raw == tmp_path
    assert args.timeout == 5.0
    assert args.base_url == "http://127.0.0.1:1"
    assert (args.page_count, args.max_pages, args.page_delay) == (10, 2, 0.1)
    help_text = parser.format_help()
    for hidden in ("--base-url", "--page-count", "--max-pages", "--page-delay"):
        assert hidden not in help_text  # hidden: for tests and diagnostics against the fake server


def test_parser_download_flags():
    args = cli.build_parser().parse_args(
        [
            "download",
            SERIES_URL,
            "--episodes",
            "1-5,8",
            "--out",
            "/tmp/x",
            "--delay-min",
            "1",
            "--delay-max",
            "2",
            "--include-locked",
            "--overwrite",
            "--dry-run",
            "--no-impersonate",
            "--cookies-from-browser",
            "firefox",
            "--extractor-args",
            "tiktok:api_hostname=api22.tiktokv.com",
            "--extractor-args",
            "foo=bar",
            "--retries",
            "2",
            "--pace",
            "human",
            "--rest-every",
            "5",
            "--rest-min",
            "10",
            "--rest-max",
            "20",
            "--max-consecutive-failures",
            "2",
            "--engine",
            "browser",
            "--quality",
            "best",
            "--no-verify",
        ]
    )
    assert args.episodes == "1-5,8"
    assert args.quality == "best" and args.no_verify is True
    assert args.out == "/tmp/x"
    assert (args.delay_min, args.delay_max) == (1.0, 2.0)
    assert args.include_locked and args.overwrite and args.dry_run and args.no_impersonate
    assert args.cookies_from_browser == "firefox"
    assert args.extractor_args == ["tiktok:api_hostname=api22.tiktokv.com", "foo=bar"]
    assert args.retries == 2
    assert args.pace == "human"
    assert (args.rest_every, args.rest_min, args.rest_max) == (5, 10.0, 20.0)
    assert args.max_consecutive_failures == 2
    assert args.engine == "browser"
    defaults = cli.build_parser().parse_args(["download", SERIES_URL])
    assert defaults.episodes is None
    assert (defaults.delay_min, defaults.delay_max) == (4.0, 9.0)
    assert defaults.extractor_args is None
    assert defaults.retries == 3
    # the pacing defaults come from DownloadOptions, the single source of truth
    assert defaults.pace == DownloadOptions.pace == "fixed"
    assert (defaults.rest_every, defaults.rest_min, defaults.rest_max) == (10, 60.0, 120.0)
    assert defaults.max_consecutive_failures == DownloadOptions.max_consecutive_failures == 3
    assert defaults.engine == DownloadOptions.engine == "yt-dlp"
    assert defaults.quality == DownloadOptions.quality == "compatible"
    assert defaults.no_verify is False and DownloadOptions.verify is True
    for flag in (
        "--pace",
        "--rest-every",
        "--rest-min",
        "--rest-max",
        "--max-consecutive-failures",
    ):
        assert flag in _subcommand_help("download") and flag in _subcommand_help("serve")
        assert flag not in _subcommand_help("video")  # one file: nothing to pace
    assert "--engine {yt-dlp,browser}" in _subcommand_help("video")
    for command in ("download", "video", "serve"):
        assert "--quality {compatible,best}" in _subcommand_help(command)
        assert "--no-verify" in _subcommand_help(command)
    assert "--quality" not in _subcommand_help("info")


def _subcommand_help(command: str) -> str:
    parser = cli.build_parser()
    subparsers = next(
        action for action in parser._actions if isinstance(action, argparse._SubParsersAction)
    )
    return subparsers.choices[command].format_help()


def test_parser_name_format_and_thumbnail_mode():
    """`--name-format FORMAT` and `--thumbnail {embed,both,file,none}` exist on download, video and
    serve; the format defaults to DEFAULT_NAME_FORMAT for a series and to "{title}" (the item id)
    for video, the thumbnail mode to `embed` (the cover goes into the MP4)."""
    parser = cli.build_parser()
    for argv in (["download", SERIES_URL], ["video", VIDEO_URL], ["serve"]):
        args = parser.parse_args(argv)
        assert args.name_format is None and args.thumbnail == "embed"
        for mode in ("embed", "both", "file", "none"):
            assert parser.parse_args([*argv, "--thumbnail", mode]).thumbnail == mode
        args = parser.parse_args([*argv, "--name-format", "{series} - {n}", "--thumbnail", "none"])
        assert args.name_format == "{series} - {n}" and args.thumbnail == "none"
        assert cli.name_format_for(args) == "{series} - {n}"
        with pytest.raises(SystemExit):
            parser.parse_args([*argv, "--thumbnail", "nope"])
    assert cli.name_format_for(parser.parse_args(["download", SERIES_URL])) == (
        cli.DEFAULT_NAME_FORMAT
    )
    assert cli.name_format_for(parser.parse_args(["serve"])) == "{series} - Episode {number}"
    assert cli.name_format_for(parser.parse_args(["video", VIDEO_URL])) == "{title}"
    assert cli.VIDEO_NAME_FORMAT == "{title}"
    for command in ("download", "video", "serve"):
        help_text = _subcommand_help(command)
        assert "--name-format FORMAT" in help_text
        assert "{series} {number} {n} {title} {id}" in help_text
        assert "{series} - Episode {number}" in help_text  # the default is spelled out
        assert "--thumbnail {embed,both,file,none}" in help_text
        # the help names what each mode does (argparse wraps lines: compare without the wrapping)
        unwrapped = " ".join(help_text.split())
        assert "embed (default) writes it into the MP4 as its cover art" in unwrapped
        assert "both also keeps it next to the video as <name>.jpeg|jpg|png|webp" in unwrapped
        assert "file keeps that file only" in unwrapped and "none fetches no cover" in unwrapped
        # --thumbnail is the only flag about the cover (the build-3 on/off flag is gone)
        assert help_text.count("thumbnail") == help_text.count("--thumbnail {embed,both,file,none}")
    for command in ("info", "doctor"):
        assert "--name-format" not in _subcommand_help(command)
        assert "--thumbnail" not in _subcommand_help(command)


def test_parser_video_doctor_serve():
    parser = cli.build_parser()
    video = parser.parse_args(
        ["video", VIDEO_URL, "--out", "v", "--cookies", "c.txt", "--overwrite"]
    )
    assert video.command == "video"
    assert video.out == "v"
    assert video.cookies == Path("c.txt")
    assert not hasattr(video, "episodes")
    assert not hasattr(video, "delay_min")
    assert not hasattr(video, "pace") and not hasattr(video, "rest_every")
    assert video.engine == "yt-dlp"  # the engine flag exists; `browser` is refused by _validate
    doctor = parser.parse_args(["doctor", "--cookies", "c.txt", "--browser-channel", "chrome"])
    assert doctor.command == "doctor"
    assert doctor.cookies == Path("c.txt")
    assert doctor.browser_channel == "chrome"
    assert doctor.browser_path is None
    serve = parser.parse_args(["serve"])
    assert (serve.host, serve.port, serve.out) == ("127.0.0.1", 8765, "downloads")
    serve = parser.parse_args(
        ["serve", "--host", "0.0.0.0", "--port", "9000", "--out", "o", "--cookies", "c"]
    )
    assert (serve.host, serve.port, serve.out) == ("0.0.0.0", 9000, "o")
    assert serve.cookies == Path("c")


def test_version_help_and_no_command(capsys):
    assert cli.main(["--version"]) == 0
    assert capsys.readouterr().out.strip() == f"dramafetch {__version__}"
    assert cli.main(["--help"]) == 0
    out = capsys.readouterr().out
    for command in ("info", "download", "video", "doctor", "serve"):
        assert command in out
    assert "locked episodes are listed and skipped" in out  # the legal notice is the epilog
    assert cli.main([]) == 2
    assert cli.main(["bogus"]) == 2


@pytest.mark.parametrize(
    "argv",
    [
        ["download", SERIES_URL, "--episodes", "3-1"],
        ["download", SERIES_URL, "--episodes", "x"],
        ["download", SERIES_URL, "--delay-min", "5", "--delay-max", "1"],
        ["download", SERIES_URL, "--delay-min", "-1"],
        ["download", SERIES_URL, "--retries", "-2"],
        ["download", SERIES_URL, "--extractor-args", "nonsense"],
        ["download", SERIES_URL, "--extractor-args", ""],
        ["download", SERIES_URL, "--episodes", "1-99999999999"],
        ["serve", "--port", "70000"],
        ["serve", "--host", ""],
        ["serve", "--host", "[]"],
        ["info", SERIES_URL, "--strategy", "magic"],
        ["info", SERIES_URL, "--page-count", "0"],
        ["info", SERIES_URL, "--max-pages", "0"],
        ["download", SERIES_URL, "--page-delay", "-0.5"],
        # pacing: ordering and sign are checked before any network, like the delays
        ["download", SERIES_URL, "--rest-min", "90", "--rest-max", "60"],
        ["download", SERIES_URL, "--rest-min", "-1"],
        ["download", SERIES_URL, "--rest-max", "-1"],
        ["download", SERIES_URL, "--rest-every", "-1"],
        ["download", SERIES_URL, "--max-consecutive-failures", "-1"],
        ["download", SERIES_URL, "--pace", "fast"],
        ["download", SERIES_URL, "--engine", "wget"],
        ["download", SERIES_URL, "--retries", "4"],  # more retries only knock again
        ["serve", "--rest-min", "5", "--rest-max", "1"],
        ["video", VIDEO_URL, "--engine", "browser"],  # the browser engine needs a series
        # the browser engine never reads --cookies-from-browser (a yt-dlp option): say so
        ["download", SERIES_URL, "--engine", "browser", "--cookies-from-browser", "chrome"],
        ["serve", "--engine", "browser", "--cookies-from-browser", "firefox"],
        # the name format is checked up front too: unknown placeholder, padding spelled by hand,
        # an unmatched brace, nothing that tells episodes apart
        ["download", SERIES_URL, "--name-format", "{nope}"],
        ["download", SERIES_URL, "--name-format", "{series} - Episode {number:02d}"],
        ["download", SERIES_URL, "--name-format", "{series} - Episode {number"],
        ["download", SERIES_URL, "--name-format", "{series}"],
        ["download", SERIES_URL, "--name-format", ""],
        ["video", VIDEO_URL, "--name-format", "{episode}"],
        ["serve", "--name-format", "{{n}}"],
        # the thumbnail mode is a closed choice
        ["download", SERIES_URL, "--thumbnail", "nope"],
        ["video", VIDEO_URL, "--thumbnail", "sidecar"],
        ["serve", "--thumbnail", "yes"],
    ],
)
def test_usage_errors_exit_2_before_any_network(argv, capsys, fake_discovery, fake_downloader):
    assert cli.main(argv) == 2
    assert fake_discovery.calls == []
    assert fake_downloader.instances == []
    assert capsys.readouterr().err  # argparse explained the problem


def test_usage_error_messages_say_what_to_do(capsys):
    assert cli.main(["download", SERIES_URL, "--retries", "4"]) == 2
    assert "--retries must be between 0 and 3" in capsys.readouterr().err
    assert cli.main(["video", VIDEO_URL, "--engine", "browser"]) == 2
    err = capsys.readouterr().err
    assert "--engine browser works on a series" in err and "yt-dlp" in err
    argv = ["download", SERIES_URL, "--engine", "browser", "--cookies-from-browser", "chrome"]
    assert cli.main(argv) == 2
    err = capsys.readouterr().err
    assert "--engine browser reads cookies from --cookies FILE only" in err
    assert "--cookies-from-browser is a yt-dlp option" in err
    assert cli.main(["download", SERIES_URL, "--rest-every", "-1"]) == 2
    assert "0 disables" in capsys.readouterr().err
    assert cli.main(["download", SERIES_URL, "--rest-min", "90", "--rest-max", "60"]) == 2
    assert "--rest-max must be >= --rest-min" in capsys.readouterr().err
    assert cli.main(["download", SERIES_URL, "--name-format", "{series} - {nope}"]) == 2
    err = capsys.readouterr().err
    assert "--name-format: unknown placeholder {nope} in name format '{series} - {nope}'" in err
    assert "use {series}, {number}, {n}, {title}, {id}" in err
    assert cli.main(["download", SERIES_URL, "--name-format", "{series}"]) == 2
    err = capsys.readouterr().err
    assert "does not tell episodes apart" in err and "{number}, {n}, {title} or {id}" in err
    assert cli.main(["download", SERIES_URL, "--thumbnail", "nope"]) == 2
    err = capsys.readouterr().err
    assert "--thumbnail: invalid choice: 'nope'" in err
    # argparse quotes the choices on some Python releases and not on others (3.12.15 prints
    # "choose from embed, both, file, none"), so look for every mode, not the punctuation.
    listed = err.split("choose from", 1)[1]
    assert all(mode in listed for mode in ("embed", "both", "file", "none"))


def test_parse_extractor_args():
    parsed = cli.parse_extractor_args(
        ["tiktok:api_hostname=api22.tiktokv.com;app_name=x,y", "foo=http://h/p", "generic:a=1"]
    )
    assert parsed == {
        "tiktok": {
            "api_hostname": ["api22.tiktokv.com"],
            "app_name": ["x", "y"],
            "foo": ["http://h/p"],
        },
        "generic": {"a": ["1"]},
    }
    assert cli.parse_extractor_args(["TikTok:k=v"]) == {"tiktok": {"k": ["v"]}}
    assert cli.parse_extractor_args(["k="]) == {"tiktok": {"k": []}}
    assert cli.parse_extractor_args([]) == {}
    for bad in ["", "tiktok:", "=v", "tiktok:=v", "tiktok:novalue"]:
        with pytest.raises(ValueError, match="extractor-args"):
            cli.parse_extractor_args([bad])


# --------------------------------------------------------------------------- info


def test_info_table(fake_discovery, tmp_path, capsys):
    code = cli.main(
        [
            "info",
            SERIES_URL,
            "--out",
            str(tmp_path),
            "--cookies",
            "c.txt",
            "--strategy",
            "static",
            "--timeout",
            "5",
            "--headful",
            "--browser-channel",
            "chrome",
            "--base-url",
            "http://127.0.0.1:1",
            "--page-count",
            "10",
            "--max-pages",
            "3",
            "--page-delay",
            "0",
        ]
    )
    assert code == 0
    out = capsys.readouterr().out
    assert f"Series: {NAME} [{SERIES_ID}]" in out
    assert "4 episodes listed (TikTok announces 5)" in out
    assert f"Output: {tmp_path / f'{NAME} [{SERIES_ID}]'}" in out
    assert "7699400000000000001" in out
    assert "1:31" in out  # 91 s
    assert "locked: isFree=false; isLocked=True" in out
    assert out.count(" free") == 3
    assert "Warnings:" in out
    assert "episode 4 missing (gap)" in out
    assert "1 episode looks locked" in out
    ((ref, options),) = fake_discovery.calls
    assert ref.series_id == SERIES_ID
    assert ref.episode_hint == 1
    assert options.cookies_file == Path("c.txt")
    assert options.strategy == "static"
    assert options.timeout_s == 5.0
    assert options.headful is True
    assert options.browser_channel == "chrome"
    assert options.base_url == "http://127.0.0.1:1"
    assert (options.page_count, options.max_pages, options.page_delay_s) == (10, 3, 0.0)


def test_info_defaults_reach_discovery_options(fake_discovery, tmp_path, capsys):
    assert cli.main(["info", SERIES_URL, "--out", str(tmp_path)]) == 0
    ((_, options),) = fake_discovery.calls
    assert (options.page_count, options.max_pages, options.page_delay_s) == (30, 60, 0.8)
    assert options.timeout_s == 45.0
    assert options.base_url == "https://www.tiktok.com"


def test_info_json(fake_discovery, tmp_path, capsys):
    assert cli.main(["info", SERIES_ID, "--json", "--out", str(tmp_path)]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["series_id"] == SERIES_ID
    assert data["name"] == NAME
    assert data["total_hint"] == 5
    assert data["warnings"] == [
        "episode 4 missing (gap)",
        "TikTok announces 5 episodes, 4 listed",
        "1 episode looks locked",
    ]
    assert [e["number"] for e in data["episodes"]] == [1, 2, 3, 5]
    assert data["episodes"][3]["locked"] is True
    assert data["episodes"][3]["lock_hints"] == ["isFree=false", "isLocked=True"]
    assert (
        data["episodes"][0]["page_url"]
        == "https://www.tiktok.com/@muffindrama_us/video/7699400000000000001"
    )
    assert data["output_dir"] == str(tmp_path / f"{NAME} [{SERIES_ID}]")
    assert "raw" not in data["episodes"][0]


def test_info_with_a_video_url_points_to_the_video_command(fake_discovery, capsys):
    assert cli.main(["info", VIDEO_URL]) == 2
    assert "dramafetch video" in capsys.readouterr().err
    assert fake_discovery.calls == []


@pytest.mark.parametrize(
    ("error", "code", "hint"),
    [
        (LoginRequiredError("TikTok redirected to /login"), 3, "--cookies"),
        (ChallengeError("Verify to continue"), 4, "--headful"),
        (DiscoveryError("no episode list within 45 s"), 4, "no episode list"),
        (RateLimitedError("TikTok is rate-limiting this address (HTTP 429): wait"), 5, "wait"),
    ],
)
def test_discovery_errors_map_to_exit_codes(fake_discovery, capsys, error, code, hint):
    fake_discovery.error = error
    assert cli.main(["info", SERIES_URL]) == code
    err = capsys.readouterr().err
    assert str(error) in err
    assert hint in err


def test_the_captcha_help_defers_the_headful_rerun_to_after_the_cooldown(fake_discovery, capsys):
    """A captcha starts the 30-minute cooldown (engine.resolve records it), so the help must not
    send the user straight back to TikTok: it names the cooldown, and the rerun it recommends —
    `--headful` — is refused with exit 5 and no discovery call until the cooldown has ended."""
    fake_discovery.error = ChallengeError("Verify to continue")
    assert cli.main(["info", SERIES_URL]) == 4
    err = capsys.readouterr().err
    assert "30-minute cooldown" in err and "--headful" in err
    assert active_cooldown() is not None
    assert cli.main(["info", SERIES_URL, "--headful"]) == 5
    assert "error: TikTok refused a request at " in capsys.readouterr().err
    assert len(fake_discovery.calls) == 1  # the rerun made no request


def _cjk_series():
    episode = Episode(
        number=1,
        item_id="7699400000000000001",
        title="霸道总裁的秘密 | 第1集",
        series_id=SERIES_ID,
        series_name="霸道总裁",
        author="muffindrama_us",
    )
    return Series(series_id=SERIES_ID, name="霸道总裁", episodes=[episode], total_hint=1)


def _cp1252_stdout(monkeypatch):
    """Install a stdout that cannot encode CJK — a redirected or piped stdout on Windows (cp1252).

    Installed from the test body on purpose: pytest re-installs its own capture stream when the
    call phase starts, so a fixture-time replacement would be undone.
    """
    stream = io.TextIOWrapper(io.BytesIO(), encoding="cp1252")
    monkeypatch.setattr(sys, "stdout", stream)

    def text() -> str:
        stream.flush()
        return stream.buffer.getvalue().decode("cp1252")

    return text


def test_non_utf8_stdout_survives_cjk_titles(
    fake_discovery, fake_downloader, tmp_path, monkeypatch
):
    fake_discovery.series = _cjk_series()
    read_stdout = _cp1252_stdout(monkeypatch)
    assert cli.main(["info", SERIES_ID, "--out", str(tmp_path)]) == 0
    out = read_stdout()
    assert f"[{SERIES_ID}]" in out and "7699400000000000001" in out
    assert "\\u9738" in out  # backslashreplace keeps the information instead of raising

    assert cli.main(["info", SERIES_ID, "--json", "--out", str(tmp_path)]) == 0
    combined = read_stdout()  # the table from the first run, then the JSON document
    data = json.loads(combined[combined.index("{") :])
    assert data["name"] == "霸道总裁"  # exact JSON through \uXXXX escapes
    assert data["episodes"][0]["title"] == "霸道总裁的秘密 | 第1集"

    code = cli.main(
        ["download", SERIES_ID, "--out", str(tmp_path), "--delay-min", "0", "--delay-max", "0"]
    )
    assert code == 0
    assert "E01  done" in read_stdout()


def test_doctor_uses_ascii_marks_on_a_non_utf8_stdout(monkeypatch):
    read_stdout = _cp1252_stdout(monkeypatch)
    assert cli.main(["doctor", "--browser-channel", "chrome"]) == 0
    lines = read_stdout().strip().splitlines()
    assert len(lines) == 10
    assert all(line.split(" ", 1)[0] in {"OK", "X", "-"} for line in lines)
    assert lines[7].startswith("OK mutagen: ")
    assert lines[8] == "- cooldown: none"
    assert lines[9].startswith("- pace: 4")


def test_control_characters_from_tiktok_text_are_not_printed(capsys, tmp_path):
    episode = Episode(
        number=1,
        item_id="7699400000000000001",
        title="Ep 1\x1b[2K\x1b[1A\x1b]0;owned\x07 free",
        series_id=SERIES_ID,
        lock_hints=("isFree=false",),
    )
    series = Series(SERIES_ID, "N\x1b[31m", [episode], warnings=["odd\x9bthing"])
    cli._print_series_table(series, tmp_path / "N\x1b[31m [1]")
    cli._print_result(DownloadResult(episode, DownloadStatus.FAILED, None, "boom\x1b[2K‮"))
    cli._stderr("warning: first\x1b[2K line\nsecond line")
    captured = capsys.readouterr()
    for text in (captured.out, captured.err):
        assert "\x1b" not in text and "\x07" not in text and "\x9b" not in text
        assert "‮" not in text
    assert "Series: N[31m [" in captured.out
    assert "Ep 1[2K[1A]0;owned free  locked: isFree=false" in captured.out
    assert "  - oddthing" in captured.out
    assert "E01  failed                 boom[2K" in captured.out
    assert captured.err == "warning: first[2K line\nsecond line\n"  # newlines survive on stderr
    assert cli._printable("plain – text") == "plain – text"  # noqa: RUF001


def test_unsupported_url_exits_2(capsys):
    assert cli.main(["info", "https://vm.tiktok.com/ZMabc/"]) == 2
    assert "Short links" in capsys.readouterr().err


def test_keyboard_interrupt_exits_130(fake_discovery, capsys):
    fake_discovery.error = KeyboardInterrupt()
    assert cli.main(["download", SERIES_URL]) == 130
    assert "interrupted" in capsys.readouterr().err


# --------------------------------------------------------------------------- download


def test_download_end_to_end(fake_discovery, fake_downloader, tmp_path, capsys):
    code = cli.main(
        ["download", SERIES_URL, "--out", str(tmp_path), "--delay-min", "0", "--delay-max", "0"]
    )
    assert code == 0
    out = capsys.readouterr().out
    lines = out.splitlines()
    assert lines[0] == f"{NAME} [{SERIES_ID}]: 4 episode(s) -> {tmp_path / f'{NAME} [{SERIES_ID}]'}"
    assert lines[1].startswith("E01  done")
    # a done line: the path, then the cover outcome from the message
    assert lines[1].endswith(
        f"{tmp_path / f'{NAME} [{SERIES_ID}]' / 'fake - Episode 01.mp4'} + cover embedded"
    )
    assert lines[4].startswith("E05  skipped-locked")
    assert "looks locked: isFree=false; isLocked=True" in lines[4]
    assert lines[-2] == "Summary: 3 done, 1 skipped-locked"
    # then the report line: what is complete and what is not (episode 4 is a gap in the list)
    assert lines[-1] == "incomplete: 3 of 5 — 1 locked (5); episode 4 missing from TikTok's list"
    target = tmp_path / f"{NAME} [{SERIES_ID}]"
    assert sorted(p.name for p in target.iterdir()) == [
        MANIFEST_FILENAME,
        "fake - Episode 01.mp4",
        "fake - Episode 02.mp4",
        "fake - Episode 03.mp4",
    ]
    (downloader,) = fake_downloader.instances
    assert [episode.number for episode, _ in downloader.calls] == [1, 2, 3, 5]
    assert all(options.out_dir == target for _, options in downloader.calls)
    # the naming defaults: "{series} - Episode {number}" with the series name, covers on
    _, first_options = downloader.calls[0]
    assert first_options.name_format == "{series} - Episode {number}"
    assert first_options.series_name == NAME
    assert first_options.thumbnail == "embed" and first_options.thumbnails is True
    # a second run resumes: everything is skipped through the manifest, no downloader calls
    code = cli.main(["download", SERIES_URL, "--out", str(tmp_path)])
    assert code == 0
    second = fake_downloader.instances[1]
    assert [episode.number for episode, _ in second.calls] == [
        5
    ]  # the locked one is re-evaluated only
    assert "Summary: 3 skipped-exists, 1 skipped-locked" in capsys.readouterr().out


def test_download_selection_and_absent_numbers(fake_discovery, fake_downloader, tmp_path, capsys):
    code = cli.main(
        [
            "download",
            SERIES_URL,
            "--out",
            str(tmp_path),
            "--episodes",
            "2-4,9",
            "--delay-min",
            "0",
            "--delay-max",
            "0",
        ]
    )
    assert code == 0
    captured = capsys.readouterr()
    assert "requested episodes the series does not list (ignored): 4, 9" in captured.err
    assert "warning: episode 4 missing (gap)" in captured.err
    (downloader,) = fake_downloader.instances
    assert [episode.number for episode, _ in downloader.calls] == [2, 3]
    assert "Summary: 2 done" in captured.out


def test_download_nothing_selected(fake_discovery, fake_downloader, tmp_path, capsys):
    assert cli.main(["download", SERIES_URL, "--out", str(tmp_path), "--episodes", "40-"]) == 0
    assert "nothing to do" in capsys.readouterr().err
    assert fake_downloader.instances == []


def test_download_empty_series_exits_4(fake_discovery, fake_downloader, tmp_path, capsys):
    fake_discovery.series = Series(series_id=SERIES_ID, name=None, episodes=[])
    assert cli.main(["download", SERIES_URL, "--out", str(tmp_path)]) == 4
    assert "no episodes listed" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("outcomes", "code", "summary"),
    [
        ({1: DownloadStatus.FAILED_LOGIN}, 3, "Summary: 1 skipped-locked, 3 failed-login-required"),
        (
            {2: DownloadStatus.FAILED_RATE_LIMITED},
            5,
            "1 done, 1 skipped-locked, 2 failed-rate-limited",
        ),
        ({3: DownloadStatus.FAILED}, 2, "Summary: 2 done, 1 skipped-locked, 1 failed"),
        ({2: DownloadStatus.FAILED_UNAVAILABLE}, 2, "1 failed-unavailable"),
        ({2: DownloadStatus.FAILED_BLOCKED}, 5, "1 done, 1 skipped-locked, 2 failed-blocked"),
        (
            {
                1: DownloadStatus.FAILED,
                2: DownloadStatus.FAILED_UNAVAILABLE,
                3: DownloadStatus.FAILED,
            },
            2,
            "Summary: 1 skipped-locked, 1 failed-unavailable, 2 failed",
        ),
    ],
)
def test_download_exit_codes(
    fake_discovery, fake_downloader, tmp_path, capsys, outcomes, code, summary
):
    fake_downloader.outcomes = outcomes
    argv = ["download", SERIES_URL, "--out", str(tmp_path), "--delay-min", "0", "--delay-max", "0"]
    assert cli.main(argv) == code
    out = capsys.readouterr().out
    assert summary in out
    if code == 3:
        assert "3 failed-login-required" in out
        assert "stopped: episode 1 failed-login-required" in out
    if DownloadStatus.FAILED_BLOCKED in outcomes.values():
        assert "E03  failed-blocked         stopped: episode 2 failed-blocked" in out


def test_download_dry_run_and_flags_reach_the_downloader(
    fake_discovery, fake_downloader, tmp_path, capsys
):
    code = cli.main(
        [
            "download",
            SERIES_URL,
            "--out",
            str(tmp_path),
            "--dry-run",
            "--include-locked",
            "--overwrite",
            "--no-impersonate",
            "--cookies",
            "c.txt",
            "--cookies-from-browser",
            "firefox",
            "--extractor-args",
            "tiktok:api_hostname=h",
            "--retries",
            "1",
            "--delay-min",
            "0.5",
            "--delay-max",
            "0.5",
            "--name-format",
            "{series} - E{number} - {title}",
            "--thumbnail",
            "none",
        ]
    )
    assert code == 0
    out = capsys.readouterr().out
    assert out.count("dry-run") == 4 + 1  # 4 episode lines + the summary
    assert "Summary: 4 dry-run" in out
    (downloader,) = fake_downloader.instances
    _, options = downloader.calls[0]
    assert options.dry_run and options.include_locked and options.overwrite
    assert options.name_format == "{series} - E{number} - {title}"
    assert options.thumbnail == "none" and options.thumbnails is False
    assert options.impersonate is False
    assert options.cookies_file == Path("c.txt")
    assert options.cookies_from_browser == "firefox"
    assert options.extractor_args == {"tiktok": {"api_hostname": ["h"]}}
    assert options.retries == 1
    assert options.delay_min_s == options.delay_max_s == 0.5
    target = tmp_path / f"{NAME} [{SERIES_ID}]"
    assert sorted(p.name for p in target.iterdir()) == [MANIFEST_FILENAME]


def test_download_announces_the_pace_and_prints_pauses_on_stderr(
    fake_discovery, fake_downloader, no_sleep, tmp_path, capsys
):
    """Episodes 1-3 are network attempts (5 is locked): a 7 s pace before the 2nd and, with
    --rest-every 2, a 95 s rest before the 3rd. stdout keeps the result lines only."""
    code = cli.main(
        [
            "download",
            SERIES_URL,
            "--out",
            str(tmp_path),
            "--delay-min",
            "7",
            "--delay-max",
            "7",
            "--rest-every",
            "2",
            "--rest-min",
            "95",
            "--rest-max",
            "95",
        ]
    )
    assert code == 0
    captured = capsys.readouterr()
    err = captured.err.splitlines()
    assert (
        "  pace: 7 s between episodes, 95 s rest every 2; stop after 3 failures / 403 / 429" in err
    )
    assert err.count("  … pausing 7 s") == 1
    assert err.count("  … resting 95 s after 2 downloads") == 1
    assert err.index("  … pausing 7 s") < err.index("  … resting 95 s after 2 downloads")
    for word in ("pausing", "resting", "pace:"):
        assert word not in captured.out
    assert [line[:12] for line in captured.out.splitlines()[1:5]] == [
        "E01  done   ",
        "E02  done   ",
        "E03  done   ",
        "E05  skipped",
    ]


def test_download_human_pace_dry_run_prints_no_pauses(
    fake_discovery, fake_downloader, no_sleep, tmp_path, capsys
):
    code = cli.main(
        ["download", SERIES_URL, "--out", str(tmp_path), "--pace", "human", "--dry-run"]
    )
    assert code == 0
    captured = capsys.readouterr()
    assert "pausing" not in captured.err and "resting" not in captured.err
    assert "pace:" not in captured.err  # a dry run never pauses, so nothing to announce
    assert "Summary: 1 skipped-locked, 3 dry-run" in captured.out
    (downloader,) = fake_downloader.instances
    assert downloader.calls[0][1].pace == "human"


def test_download_one_episode_never_pauses(
    fake_discovery, fake_downloader, no_sleep, tmp_path, capsys
):
    assert cli.main(["download", SERIES_URL, "--out", str(tmp_path), "--episodes", "1"]) == 0
    captured = capsys.readouterr()
    assert "pausing" not in captured.err and "pace:" not in captured.err
    assert "Summary: 1 done" in captured.out


def test_download_prints_the_stop_reason_once_on_stderr(
    fake_discovery, fake_downloader, no_sleep, tmp_path, capsys
):
    fake_downloader.outcomes = {1: DownloadStatus.FAILED_BLOCKED}
    assert cli.main(["download", SERIES_URL, "--out", str(tmp_path)]) == 5
    captured = capsys.readouterr()
    stop_line = "  … stopped: episode 1 failed-blocked: failed-blocked from fake"
    assert captured.err.splitlines().count(stop_line) == 1
    rows = [line for line in captured.out.splitlines() if line.startswith("E0")]
    assert sum("stopped: episode 1 failed-blocked" in row for row in rows) == 2  # episodes 2, 3
    assert captured.out.splitlines()[-1].endswith("; stopped: episode 1 failed-blocked")
    assert "Summary: 1 skipped-locked, 3 failed-blocked" in captured.out
    (downloader,) = fake_downloader.instances
    assert [episode.number for episode, _ in downloader.calls] == [1]  # nothing after the stop
    assert active_cooldown().source == "yt-dlp"  # the refusal started the global cooldown
    clear_cooldown()  # a failure streak is no refusal: the next run must not be turned away

    fake_downloader.outcomes = {1: DownloadStatus.FAILED, 2: DownloadStatus.FAILED_UNAVAILABLE}
    code = cli.main(
        ["download", SERIES_URL, "--out", str(tmp_path), "--max-consecutive-failures", "2"]
    )
    assert code == 2
    captured = capsys.readouterr()
    stop_line = "  … stopped: 2 consecutive failures (last: failed-unavailable from fake)"
    assert captured.err.splitlines().count(stop_line) == 1
    assert "stop after 2 failures / 403 / 429" in captured.err
    assert "E03  failed                 stopped: 2 consecutive failures" in captured.out
    assert "Summary: 1 skipped-locked, 1 failed-unavailable, 2 failed" in captured.out
    assert active_cooldown() is None  # three plain failures are not TikTok refusing


def test_download_engine_browser_gets_the_browser_flags_and_is_closed(
    fake_discovery, fake_browser_engine, tmp_path, capsys
):
    code = cli.main(
        [
            "download",
            SERIES_URL,
            "--out",
            str(tmp_path),
            "--engine",
            "browser",
            "--strategy",
            "browser",
            "--browser-channel",
            "chrome",
            "--browser-path",
            "/opt/chromium",
            "--headful",
            "--base-url",
            "http://127.0.0.1:1",
            "--cookies",
            "c.txt",
            "--delay-min",
            "0",
            "--delay-max",
            "0",
        ]
    )
    assert code == 0
    (browser,) = fake_browser_engine.instances
    assert [episode.number for episode, _ in browser.calls] == [1, 2, 3, 5]
    _, options = browser.calls[0]
    assert options.engine == "browser"
    assert options.browser_channel == "chrome"
    assert options.browser_executable == Path("/opt/chromium")
    assert options.browser_headful is True
    assert options.base_url == "http://127.0.0.1:1"
    assert options.cookies_file == Path("c.txt")
    assert options.out_dir == tmp_path / f"{NAME} [{SERIES_ID}]"
    assert browser.closed == 1  # the engine closed the browser at the end of the run
    ((_, discovery_options),) = fake_discovery.calls
    assert discovery_options.browser_channel == "chrome"  # the same browser flags, both steps
    assert discovery_options.executable_path == Path("/opt/chromium")
    out = capsys.readouterr().out
    assert "Summary: 3 done, 1 skipped-locked" in out
    assert sorted(p.name for p in (tmp_path / f"{NAME} [{SERIES_ID}]").glob("*.mp4")) == [
        "browser - Episode 01.mp4",
        "browser - Episode 02.mp4",
        "browser - Episode 03.mp4",
    ]


def test_default_engine_leaves_the_browser_fields_unset(
    fake_discovery, fake_downloader, tmp_path, capsys
):
    code = cli.main(
        [
            "download",
            SERIES_URL,
            "--out",
            str(tmp_path),
            "--browser-channel",
            "chrome",
            "--headful",
            "--base-url",
            "http://127.0.0.1:1",
            "--dry-run",
        ]
    )
    assert code == 0
    (downloader,) = fake_downloader.instances
    _, options = downloader.calls[0]
    assert options.engine == "yt-dlp"
    assert options.browser_channel is None and options.browser_executable is None
    assert options.browser_headful is False
    assert options.base_url == "https://www.tiktok.com"
    assert options.pace == "fixed"
    assert (options.rest_every, options.rest_min_s, options.rest_max_s) == (10, 60.0, 120.0)
    assert options.max_consecutive_failures == 3


def test_download_pacing_flags_reach_the_options(fake_discovery, fake_downloader, tmp_path):
    code = cli.main(
        [
            "download",
            SERIES_URL,
            "--out",
            str(tmp_path),
            "--dry-run",
            "--pace",
            "human",
            "--rest-every",
            "0",
            "--rest-min",
            "5",
            "--rest-max",
            "6",
            "--max-consecutive-failures",
            "0",
            "--delay-min",
            "1",
            "--delay-max",
            "2",
        ]
    )
    assert code == 0
    (downloader,) = fake_downloader.instances
    _, options = downloader.calls[0]
    assert options.pace == "human"
    assert (options.rest_every, options.rest_min_s, options.rest_max_s) == (0, 5.0, 6.0)
    assert options.max_consecutive_failures == 0
    assert (options.delay_min_s, options.delay_max_s) == (1.0, 2.0)


# --------------------------------------------------------------------------- video


# --------------------------------------------------------------------------- several series

SERIES_2 = "7699393770256782399"
NAME_2 = "Second Chance Bride"
SERIES_2_URL = f"https://www.tiktok.com/shortdrama/episode/{SERIES_2}/1"


def make_second_series():
    episodes = [
        Episode(
            number=n,
            item_id=f"76994100000000000{n:02d}",
            title=f"{NAME_2} | Episode {n}",
            series_id=SERIES_2,
            series_name=NAME_2,
            author="drama_us",
            duration_s=60 + n,
        )
        for n in (1, 2, 3)
    ]
    return Series(series_id=SERIES_2, name=NAME_2, episodes=episodes, total_hint=3)


class BatchDiscovery:
    """Answers per series id (a deep copy each time); every call is one resolve."""

    def __init__(self, *series):
        self.series = {item.series_id: item for item in series}
        self.errors = {}
        self.calls = []

    def discover(self, ref, options):
        self.calls.append(ref.series_id)
        if ref.series_id in self.errors:
            raise self.errors[ref.series_id]
        return copy.deepcopy(self.series[ref.series_id])


@pytest.fixture
def batch_discovery(monkeypatch):
    """Two series: make_series() (4 listed, a gap at 4, 5 locked) and the complete second one."""
    discovery = BatchDiscovery(make_series(), make_second_series())
    module = types.ModuleType("dramafetch.discovery")
    module.choose_discovery = lambda options: discovery
    monkeypatch.setitem(sys.modules, "dramafetch.discovery", module)
    return discovery


def test_parser_download_takes_several_series_a_file_and_recheck():
    parser = cli.build_parser()
    args = parser.parse_args(
        ["download", SERIES_URL, SERIES_2_URL, "--from-file", "series.txt", "--recheck"]
    )
    assert args.urls == [SERIES_URL, SERIES_2_URL]
    assert args.from_file == Path("series.txt") and args.recheck is True
    defaults = parser.parse_args(["download", SERIES_URL])
    assert defaults.urls == [SERIES_URL] and defaults.from_file is None
    assert defaults.recheck is False and DownloadOptions.recheck is False
    assert parser.parse_args(["download", "--from-file", "s.txt"]).urls == []  # a file alone
    serve = parser.parse_args(["serve", "--recheck"])
    assert serve.recheck is True and cli._download_options(serve).recheck is True
    help_text = " ".join(_subcommand_help("download").split())
    assert "--from-file FILE" in help_text and "--recheck" in help_text
    assert "anything after ' #' are ignored" in help_text
    assert "complete less than 24 h ago" in help_text
    assert "--recheck" in _subcommand_help("serve")
    for command in ("info", "video", "doctor"):
        assert "--recheck" not in _subcommand_help(command)
    assert "--from-file" not in _subcommand_help("serve")


def test_download_reads_series_from_a_file_after_the_command_line(
    batch_discovery, fake_downloader, no_sleep, tmp_path, capsys
):
    listing = tmp_path / "series.txt"
    listing.write_text(
        "﻿# my series (a byte-order mark is fine)\n"
        "\n"
        f"https://www.tiktok.com/shortdrama/episode/{SERIES_2}/3#comments  # the second one\n"
        "   # an indented comment\n"
        f"{SERIES_ID}\r\n",  # the first series again (CRLF line ends are fine too)
        encoding="utf-8",
    )
    argv = ["download", SERIES_URL, "--from-file", str(listing), "--out", str(tmp_path / "o")]
    assert cli.main(argv) == 0
    assert batch_discovery.calls == [SERIES_ID, SERIES_2]  # command line first, once each
    captured = capsys.readouterr()
    assert f"note: duplicate: {SERIES_ID} given more than once; it is downloaded once" in (
        captured.err
    )
    assert f"[2/2] {NAME_2} [{SERIES_2}]: 3 episode(s) -> " in captured.out


@pytest.mark.parametrize(
    ("lines", "where", "problem"),
    [
        (["# ok", SERIES_ID, "", "hello there"], 4, "Not a TikTok short-drama or video URL"),
        ([SERIES_ID, f"{VIDEO_URL}  # oops"], 2, f"'{VIDEO_URL}' is a single video, not a series"),
        (["https://vm.tiktok.com/ZMabc/"], 1, "Short links"),
        # the id in full-width digits (an IME): not an id TikTok can have, so no request either
        (
            [SERIES_2, "".join(chr(0xFF10 + int(digit)) for digit in SERIES_ID)],
            2,
            "Not a TikTok short-drama or video URL",
        ),
    ],
)
def test_a_bad_line_is_a_usage_error_naming_it_before_any_request(
    batch_discovery, fake_downloader, no_sleep, tmp_path, capsys, lines, where, problem
):
    listing = tmp_path / "series.txt"
    listing.write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert cli.main(["download", "--from-file", str(listing), "--out", str(tmp_path)]) == 2
    assert f"error: {listing}:{where}: {problem}" in capsys.readouterr().err
    assert batch_discovery.calls == [] and fake_downloader.instances == []
    assert no_sleep == []  # not even a pause


@pytest.mark.parametrize(
    ("argv", "problem"),
    [
        (["download", SERIES_URL, "nonsense"], "argument 2: Not a TikTok short-drama or video URL"),
        (["download", SERIES_URL, VIDEO_URL], f"argument 2: '{VIDEO_URL}' is a single video"),
        (["download", VIDEO_URL], f"'{VIDEO_URL}' is a single video, not a series"),
        (["download"], "no series given: pass one or more series URLs (or ids), or --from-file"),
        (
            ["download", SERIES_URL, SERIES_2_URL, "--episodes", "1-2"],
            "--episodes selects episodes of one series, and 2 series were given",
        ),
        (["download", "--from-file", "/nonexistent/series.txt"], "No such file or directory"),
    ],
)
def test_several_series_usage_errors_exit_2_before_any_request(
    batch_discovery, fake_downloader, capsys, argv, problem
):
    assert cli.main(argv) == 2
    assert problem in capsys.readouterr().err
    assert batch_discovery.calls == [] and fake_downloader.instances == []


def test_an_unreadable_or_empty_series_file_is_a_usage_error(batch_discovery, tmp_path, capsys):
    binary = tmp_path / "series.bin"
    binary.write_bytes(b"\xff\xfe\x00\x01")
    assert cli.main(["download", "--from-file", str(binary)]) == 2
    assert f"--from-file {binary}: not UTF-8 text (byte 0)" in capsys.readouterr().err
    comments = tmp_path / "comments.txt"
    comments.write_text("# nothing here\n\n   \n", encoding="utf-8")
    assert cli.main(["download", "--from-file", str(comments)]) == 2
    assert "no series given" in capsys.readouterr().err
    assert batch_discovery.calls == []


def test_the_same_series_twice_with_episodes_is_one_series(
    batch_discovery, fake_downloader, tmp_path, capsys
):
    argv = ["download", SERIES_URL, SERIES_ID, "--episodes", "1", "--out", str(tmp_path)]
    assert cli.main(argv) == 0
    assert batch_discovery.calls == [SERIES_ID]
    out = capsys.readouterr().out
    assert out.startswith(f"{NAME} [{SERIES_ID}]: 1 episode(s) -> ")  # one series: no [1/1]


def _batch_rows(out):
    """The rows of the batch table: everything after its header line, split on 2+ spaces."""
    lines = out.splitlines()
    start = next(i for i, line in enumerate(lines) if line.lstrip().startswith("series  "))
    return [re.split(r"\s{2,}", line.strip()) for line in lines[start + 1 :]]


def test_download_runs_several_series_one_after_the_other(
    batch_discovery, fake_downloader, no_sleep, tmp_path, capsys
):
    out_dir = tmp_path / "out"
    argv = [
        "download",
        SERIES_URL,
        SERIES_2_URL,
        "--out",
        str(out_dir),
        "--delay-min",
        "0",
        "--delay-max",
        "0",
        "--rest-min",
        "95",
        "--rest-max",
        "95",
    ]
    assert cli.main(argv) == 0
    assert batch_discovery.calls == [SERIES_ID, SERIES_2]
    captured = capsys.readouterr()
    lines = captured.out.splitlines()
    first_dir, second_dir = out_dir / f"{NAME} [{SERIES_ID}]", out_dir / f"{NAME_2} [{SERIES_2}]"
    assert lines[0] == f"[1/2] {NAME} [{SERIES_ID}]: 4 episode(s) -> {first_dir}"
    assert [line[:16] for line in lines[1:5]] == [
        "E01  done       ",
        "E02  done       ",
        "E03  done       ",
        "E05  skipped-loc",
    ]
    assert lines[5] == "incomplete: 3 of 5 — 1 locked (5); episode 4 missing from TikTok's list"
    assert lines[6] == f"[2/2] {NAME_2} [{SERIES_2}]: 3 episode(s) -> {second_dir}"
    assert lines[7].startswith("E01  done") and str(second_dir) in lines[7]
    assert lines[10] == "complete: 3 of 3 (3 downloaded)"
    assert "Summary:" not in captured.out  # several series: the table instead
    assert lines[11:13] == ["", "Batch: 2 series — 1 incomplete, 1 complete"]
    assert _batch_rows(captured.out) == [
        [f"{NAME} [{SERIES_ID}]", "incomplete", "4", "3", "0", "1", "0"],
        [f"{NAME_2} [{SERIES_2}]", "complete", "3", "3", "0", "0", "0"],
    ]
    err = captured.err.splitlines()
    assert err.count("  … resting 95 s before the next series") == 1
    assert (
        "  pace: 0 s between episodes, 95 s rest every 10; stop after 3 failures / 403 / 429; "
        "95 s rest between series, a 15–30 min break every 100 episodes"  # noqa: RUF001
    ) in err
    assert err.count("warning: [1/2] episode 4 missing (gap)") == 1
    assert no_sleep == [95.0]  # the rest between the two series, nothing else
    assert sorted(p.name for p in second_dir.iterdir()) == [
        MANIFEST_FILENAME,
        "fake - Episode 01.mp4",
        "fake - Episode 02.mp4",
        "fake - Episode 03.mp4",
    ]

    # the same batch again: the complete series costs no request, the other is resolved again
    assert cli.main(argv) == 0
    assert batch_discovery.calls == [SERIES_ID, SERIES_2, SERIES_ID]
    captured = capsys.readouterr()
    assert f"[2/2] {NAME_2} [{SERIES_2}]: 3 episode(s) -> {second_dir}" in captured.out
    assert "complete, nothing to do: 3 episodes already on disk (checked just now)" in captured.out
    assert [row[1] for row in _batch_rows(captured.out)] == ["incomplete", "skipped (complete)"]
    assert _batch_rows(captured.out)[1] == [
        f"{NAME_2} [{SERIES_2}]",
        "skipped (complete)",
        "-",
        "0",
        "3",
        "0",
        "0",
    ]
    assert "resting" not in captured.err  # no rest before a series that makes no request
    assert len(fake_downloader.instances[-1].calls) == 1  # series 1's locked episode only

    # --recheck resolves it anyway: every episode skipped as already downloaded, a rest before it
    assert cli.main([*argv, "--recheck"]) == 0
    assert batch_discovery.calls[-2:] == [SERIES_ID, SERIES_2]
    captured = capsys.readouterr()
    assert "complete: 3 of 3 (3 already on disk)" in captured.out
    assert captured.err.count("  … resting 95 s before the next series") == 1


def test_a_stop_in_the_first_series_ends_the_batch_without_a_request(
    batch_discovery, fake_downloader, no_sleep, tmp_path, capsys
):
    fake_downloader.outcomes = {2: DownloadStatus.FAILED_RATE_LIMITED}
    assert cli.main(["download", SERIES_URL, SERIES_2, "--out", str(tmp_path)]) == 5
    assert batch_discovery.calls == [SERIES_ID]  # nothing at all for the second series
    captured = capsys.readouterr()
    lines = captured.out.splitlines()
    assert (
        f"[2/2] {SERIES_2}: not started: batch stopped in {NAME} (episode 2 failed-rate-limited)"
    ) in lines
    assert [row[1] for row in _batch_rows(captured.out)] == ["incomplete", "not started"]
    assert _batch_rows(captured.out)[1][0] == f"[{SERIES_2}]"
    assert "resting" not in captured.err and "before the next series" not in captured.err
    assert active_cooldown() is not None  # the 429 started the cooldown
    # ... so the next run is refused before anything, however many series it names
    assert cli.main(["download", SERIES_URL, SERIES_2, "--out", str(tmp_path)]) == 5
    assert batch_discovery.calls == [SERIES_ID]


@pytest.mark.parametrize(
    ("error", "code", "hint"),
    [
        (LoginRequiredError("TikTok redirected to /login"), 3, "--cookies"),
        (ChallengeError("Verify to continue"), 4, "--headful"),
        (DiscoveryError("no episode list within 45 s"), 4, None),
    ],
)
def test_a_failed_resolve_in_a_batch_stops_it(
    batch_discovery, fake_downloader, no_sleep, tmp_path, capsys, error, code, hint
):
    batch_discovery.errors = {SERIES_ID: error}
    assert cli.main(["download", SERIES_URL, SERIES_2, "--out", str(tmp_path)]) == code
    assert batch_discovery.calls == [SERIES_ID]
    captured = capsys.readouterr()
    assert f"error: [1/2] {error}" in captured.err
    if hint is not None:
        assert hint in captured.err
    assert [row[1] for row in _batch_rows(captured.out)] == [f"failed: {error}", "not started"]


def test_nothing_listed_in_one_series_does_not_stop_the_batch(
    batch_discovery, fake_downloader, no_sleep, tmp_path, capsys
):
    batch_discovery.series[SERIES_ID] = Series(series_id=SERIES_ID, name=NAME, episodes=[])
    assert cli.main(["download", SERIES_URL, SERIES_2, "--out", str(tmp_path)]) == 4
    assert batch_discovery.calls == [SERIES_ID, SERIES_2]
    captured = capsys.readouterr()
    assert f"[1/2] no episodes listed for series {SERIES_ID}; try `info --dump-raw DIR`" in (
        captured.err
    )
    assert [row[1] for row in _batch_rows(captured.out)] == [
        "failed: no episodes listed",
        "complete",
    ]


def test_the_pauses_of_a_batch_are_announced(capsys):
    printer = cli._RunPrinter(engine.PacingState(run_attempts=100))
    printer.pause("long-rest", 1320.0)
    printer.pause("series-rest", 95.0)
    printer.pause("rest", 60.0)
    printer.pause("pace", 7.0)
    assert capsys.readouterr().err.splitlines() == [
        "  … long break 22 min after 100 episodes",
        "  … resting 95 s before the next series",
        "  … resting 60 s after 0 downloads",
        "  … pausing 7 s",
    ]
    assert cli.describe_batch_pacing(DownloadOptions()) == (
        "60–120 s rest between series, a 15–30 min break every 100 episodes"  # noqa: RUF001
    )


def test_info_shows_what_is_on_disk_without_writing_anything(
    fake_discovery, fake_downloader, tmp_path, capsys
):
    out = str(tmp_path)
    argv = ["download", SERIES_URL, "--out", out, "--episodes", "1-2", "--delay-min", "0"]
    assert cli.main([*argv, "--delay-max", "0"]) == 0
    capsys.readouterr()
    series_folder = tmp_path / f"{NAME} [{SERIES_ID}]"
    manifest_before = (series_folder / MANIFEST_FILENAME).read_bytes()
    assert cli.main(["info", SERIES_URL, "--out", out]) == 0
    rows = {
        line.split()[0]: line
        for line in capsys.readouterr().out.splitlines()
        if line.strip()[:1].isdigit()
    }
    assert "  ✓     " in rows["1"] and "  ✓     " in rows["2"]
    assert "✓" not in rows["3"] and "✓" not in rows["5"]
    assert cli.main(["info", SERIES_URL, "--json", "--out", out]) == 0
    data = json.loads(capsys.readouterr().out)
    assert [episode["on_disk"] for episode in data["episodes"]] == [True, True, False, False]
    assert data["on_disk_count"] == 2
    (series_folder / "fake - Episode 02.mp4").unlink()  # gone from disk: not counted
    assert cli.main(["info", SERIES_URL, "--json", "--out", out]) == 0
    assert json.loads(capsys.readouterr().out)["on_disk_count"] == 1
    assert (series_folder / MANIFEST_FILENAME).read_bytes() == manifest_before  # read-only
    assert cli.main(["info", SERIES_URL, "--json", "--out", str(tmp_path / "none")]) == 0
    assert json.loads(capsys.readouterr().out)["on_disk_count"] == 0
    assert not (tmp_path / "none").exists()


def test_info_disk_column_reads_the_folder_the_download_would_use(
    fake_discovery, fake_downloader, tmp_path, capsys
):
    """A renamed series is downloaded into `<new name> [<id>]`: the episodes in its old folder
    get no ✓ — a download would fetch them again — and the JSON names the new folder."""
    out = str(tmp_path)
    argv = ["download", SERIES_URL, "--out", out, "--delay-min", "0", "--delay-max", "0"]
    assert cli.main(argv) == 0
    capsys.readouterr()
    fake_discovery.series = make_series()
    fake_discovery.series.name = "The Heiress, renamed"
    assert cli.main(["info", SERIES_URL, "--json", "--out", out]) == 0
    data = json.loads(capsys.readouterr().out)
    renamed = tmp_path / f"The Heiress, renamed [{SERIES_ID}]"
    assert data["output_dir"] == str(renamed)
    assert data["on_disk_count"] == 0
    assert not any(episode["on_disk"] for episode in data["episodes"])
    assert cli.main(["info", SERIES_URL, "--out", out]) == 0
    assert "✓" not in capsys.readouterr().out
    assert not renamed.exists()  # info writes nothing


def test_a_malformed_cookies_file_stops_a_batch_before_any_request(
    batch_discovery, fake_downloader, no_sleep, tmp_path, capsys
):
    cookies = tmp_path / "cookies.txt"
    cookies.write_text(".tiktok.com\tTRUE\t/\n", encoding="utf-8")  # 3 fields, no value
    argv = ["download", SERIES_URL, SERIES_2_URL, "--cookies", str(cookies)]
    assert cli.main([*argv, "--out", str(tmp_path / "out")]) == 2
    captured = capsys.readouterr()
    assert batch_discovery.calls == [] and fake_downloader.instances == []  # not even a list
    assert no_sleep == []  # and no rest between series: none of them contacted TikTok
    assert (
        "error: [1/2] cookies file cookies.txt has malformed lines (line 1: 3 fields (expected "
        "7)); yt-dlp would print them, cookie values included: fix or re-export the file"
    ) in captured.err
    assert (
        f"[2/2] {SERIES_2}: not started: batch stopped in {SERIES_ID} (malformed cookies file)"
    ) in captured.out


def test_video_downloads_directly_into_out_dir(fake_downloader, tmp_path, capsys):
    assert cli.main(["video", VIDEO_URL, "--out", str(tmp_path / "vids")]) == 0
    (downloader,) = fake_downloader.instances
    ((episode, options),) = downloader.calls
    assert episode.number == 0
    assert episode.item_id == "7699400000000000001"
    assert episode.title == "7699400000000000001"
    assert episode.author == "ana"
    assert episode.page_url == VIDEO_URL
    assert options.out_dir == tmp_path / "vids"
    assert options.name_format == "{title}"  # one file, named after its item id: <id>.mp4
    assert options.thumbnail == "embed"  # the cover goes into the MP4 here too
    assert (tmp_path / "vids" / "fake - Episode 00.mp4").exists()
    out = capsys.readouterr().out
    assert out.startswith("E00  done")


def test_video_names_its_file_after_the_item_id_unless_told_otherwise(tmp_path):
    """Through the real yt-dlp downloader with a fake YoutubeDL: `{title}` is the item id, so the
    default is `<id>.mp4`; `--name-format` and `--thumbnail` apply to `video` too."""
    from dramafetch import downloader as downloader_module

    written = []

    class FakeYdl:
        def __init__(self, params):
            self.params = params

        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

        def download(self, urls):
            target = Path(self.params["outtmpl"] % {"ext": "mp4"})
            target.write_bytes(TINY_MP4)  # a real MP4: the verification runs on it
            written.append((target, self.params))
            return 0

    real_factory = downloader_module.YtDlpDownloader.__init__

    def init_with_fake(self, ydl_factory=None):
        real_factory(self, ydl_factory=FakeYdl)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(downloader_module.YtDlpDownloader, "__init__", init_with_fake)
        assert cli.main(["video", VIDEO_URL, "--out", str(tmp_path)]) == 0
        argv = ["video", VIDEO_URL, "--out", str(tmp_path), "--thumbnail", "none"]
        assert cli.main([*argv, "--name-format", "{id} - by {series}"]) == 0
    assert [target.name for target, _ in written] == [
        "7699400000000000001.mp4",
        "7699400000000000001 - by video.mp4",  # no series: {series} is the word "video"
    ]
    assert written[0][1]["writethumbnail"] is True
    assert "writethumbnail" not in written[1][1]


def test_video_failure_exit_code_and_series_url_rejection(fake_downloader, tmp_path, capsys):
    fake_downloader.outcomes = {0: DownloadStatus.FAILED_LOGIN}
    assert cli.main(["video", VIDEO_URL, "--out", str(tmp_path)]) == 3
    fake_downloader.outcomes = {0: DownloadStatus.FAILED_BLOCKED}
    assert cli.main(["video", VIDEO_URL, "--out", str(tmp_path)]) == 5
    assert cli.main(["video", SERIES_URL, "--out", str(tmp_path)]) == 2
    assert "dramafetch download" in capsys.readouterr().err


def test_video_builds_the_downloader_through_the_engine_and_closes_it(monkeypatch, tmp_path):
    closed = []

    class Closing(FakeDownloader):
        def close(self):
            closed.append(True)

    FakeDownloader.outcomes = {}
    FakeDownloader.instances = []
    monkeypatch.setattr(engine, "YtDlpDownloader", Closing)
    assert cli.main(["video", VIDEO_URL, "--out", str(tmp_path), "--engine", "yt-dlp"]) == 0
    assert closed == [True]
    (downloader,) = FakeDownloader.instances
    assert downloader.calls[0][1].engine == "yt-dlp"


# --------------------------------------------------------------------------- doctor


def test_doctor_runs_without_a_browser_and_exits_0(capsys):
    assert cli.main(["doctor"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 10
    assert all(line[0] in "✓✗–" for line in lines)  # noqa: RUF001
    names = [line.split(" ", 1)[1].split(":")[0] for line in lines]
    assert names == [
        "python",
        "yt-dlp",
        "curl_cffi",
        "playwright",
        "browser",
        "ffmpeg",
        "cookies",
        "mutagen",
        "cooldown",
        "pace",
    ]
    # whether covers can be embedded into the MP4 (mutagen is a runtime dependency)
    assert lines[7] == f"✓ mutagen: {mutagen_version} (covers are embedded into the MP4)"
    # whether TikTok may be contacted at all (no refusal in the last 30 minutes)
    assert lines[8] == "– cooldown: none"  # noqa: RUF001
    # the pacing defaults, in one line, so a user knows what to expect before the first run
    assert lines[9] == (
        "– pace: 4–9 s between episodes, 60–120 s rest every 10; "  # noqa: RUF001
        "stop after 3 failures / 403 / 429"
    )
    assert lines[0].startswith("✓ python: Python 3.")
    assert lines[1].startswith("✓ yt-dlp: yt-dlp 20")
    assert lines[2].startswith("✓ curl_cffi")
    assert lines[3].startswith("✓ playwright")
    browser = lines[4]
    if browser.startswith("✗"):
        assert "playwright install chromium" in browser
        assert "--browser-channel chrome" in browser
    else:
        assert "Playwright Chromium at" in browser
    assert lines[6].startswith("– cookies: no --cookies given")  # noqa: RUF001
    # the web UI's /api/doctor keeps the seven environment checks only (see test_web)
    assert [check["name"] for check in cli.doctor_as_dicts(browser_channel="chrome")] == names[:7]


def test_doctor_without_mutagen_says_covers_stay_files(monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "mutagen", None)  # `import mutagen` now fails
    assert cli.main(["doctor", "--browser-channel", "chrome"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 10
    assert lines[7] == (
        "✗ mutagen: not importable — covers are saved as files only (pip install mutagen)"
    )


def test_doctor_shows_an_active_cooldown(capsys):
    record_block("blocked (HTTP 403): TikTok refused the request", "yt-dlp")
    assert cli.main(["doctor", "--browser-channel", "chrome"]) == 0  # doctor itself never refuses
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 10
    assert re.fullmatch(
        r"✗ cooldown: until \d\d:\d\d \((29|30) min left\): blocked \(HTTP 403\): TikTok refused "
        r"the request",
        lines[8],
    ), lines[8]
    assert cli.doctor_as_dicts(browser_channel="chrome")[-1]["name"] == "cookies"  # web: 7 only


# --------------------------------------------------------------------------- the cooldown


def test_commands_refuse_to_contact_tiktok_under_a_cooldown(
    fake_discovery, fake_downloader, tmp_path, capsys
):
    """After a refusal, info/download/video exit 5 with the cooldown message and make no request
    at all — a dry run of `download` resolves the list, so it is refused too; `video --dry-run`
    needs no network and is not. An expired cooldown refuses nothing."""
    record_block("HTTP 429 from the video server", "browser")
    out = str(tmp_path)
    for argv in (
        ["info", SERIES_URL, "--out", out],
        ["info", SERIES_URL, "--json", "--out", out],
        ["download", SERIES_URL, "--out", out],
        ["download", SERIES_URL, "--out", out, "--dry-run"],
        # several series: refused once, up front, before the first list
        ["download", SERIES_URL, "7699393770256782399", "--out", out],
        ["video", VIDEO_URL, "--out", out],
    ):
        assert cli.main(argv) == 5, argv
        captured = capsys.readouterr()
        assert captured.out == ""
        assert captured.err.startswith("error: TikTok refused a request at ")
        assert "(HTTP 429 from the video server); DramaFetch waits until " in captured.err
        assert f"delete {tmp_path / 'cooldown.json'} to lift it, at your own risk" in captured.err
    assert fake_discovery.calls == []  # the list was never asked for
    assert fake_downloader.instances == []  # no downloader was even built
    assert not any(tmp_path.iterdir()) or [p.name for p in tmp_path.iterdir()] == ["cooldown.json"]
    # a dry run of `video` needs no network: not refused
    assert cli.main(["video", VIDEO_URL, "--out", out, "--dry-run"]) == 0
    assert "E00  dry-run" in capsys.readouterr().out
    # deleting the file (what the message says) lifts it; so does its expiry
    clear_cooldown()
    assert cli.main(["info", SERIES_URL, "--out", out]) == 0
    assert len(fake_discovery.calls) == 1
    record_block("old", "web", now=time.time() - 3600)  # expired half an hour ago
    assert cli.main(["info", SERIES_URL, "--out", out]) == 0
    assert len(fake_discovery.calls) == 2


def test_video_records_the_cooldown_on_a_refusal(fake_downloader, tmp_path, capsys):
    fake_downloader.outcomes = {0: DownloadStatus.FAILED_RATE_LIMITED}
    assert cli.main(["video", VIDEO_URL, "--out", str(tmp_path)]) == 5
    assert "E00  failed-rate-limited" in capsys.readouterr().out
    recorded = active_cooldown()
    assert recorded is not None and recorded.source == "yt-dlp"
    assert recorded.reason == "failed-rate-limited from fake"
    assert cli.main(["video", VIDEO_URL, "--out", str(tmp_path)]) == 5  # now refused up front
    assert "error: TikTok refused a request at" in capsys.readouterr().err
    assert len(fake_downloader.instances) == 1


# --------------------------------------------------------------------------- quality & verify


def test_quality_and_no_verify_flags_reach_the_options(fake_discovery, fake_downloader, tmp_path):
    argv = ["--out", str(tmp_path), "--dry-run"]
    assert cli.main(["download", SERIES_URL, *argv]) == 0
    assert cli.main(["video", VIDEO_URL, *argv]) == 0
    assert cli.main(["download", SERIES_URL, *argv, "--quality", "best", "--no-verify"]) == 0
    assert cli.main(["video", VIDEO_URL, *argv, "--quality", "best", "--no-verify"]) == 0
    defaults_series, defaults_video, best_series, best_video = fake_downloader.instances
    for run in (defaults_series, defaults_video):
        _, options = run.calls[0]
        assert options.quality == "compatible" and options.verify is True
    for run in (best_series, best_video):
        _, options = run.calls[0]
        assert options.quality == "best" and options.verify is False


def test_quality_must_be_compatible_or_best(capsys, fake_discovery, fake_downloader):
    assert cli.main(["download", SERIES_URL, "--quality", "ultra"]) == 2
    assert "--quality: invalid choice: 'ultra'" in capsys.readouterr().err
    assert fake_discovery.calls == [] and fake_downloader.instances == []


def test_info_shows_the_quality_column_and_json_carries_the_hint(fake_discovery, tmp_path, capsys):
    fake_discovery.series.episodes[0].quality_hint = "720p h264"
    fake_discovery.series.episodes[1].quality_hint = "1080p bytevc1"
    assert cli.main(["info", SERIES_ID, "--out", str(tmp_path)]) == 0
    lines = capsys.readouterr().out.splitlines()
    header = next(line for line in lines if line.lstrip().startswith("#"))
    assert header.split() == ["#", "item", "id", "duration", "quality", "disk", "title", "status"]
    row1 = next(line for line in lines if line.lstrip().startswith("1 "))
    assert "  1:31  720p h264      " in row1  # 91 s, then the rendition the default takes
    row3 = next(line for line in lines if line.lstrip().startswith("3 "))
    assert "  1:33  -              " in row3  # no rendition listed
    assert cli.main(["info", SERIES_ID, "--json", "--out", str(tmp_path)]) == 0
    data = json.loads(capsys.readouterr().out)
    assert [e["quality_hint"] for e in data["episodes"]] == [
        "720p h264",
        "1080p bytevc1",
        None,
        None,
    ]


def test_print_result_shows_the_path_then_the_cover_note_for_done_rows(capsys):
    episode = _episode(1)
    path = Path("/tmp/x/Heiress - Episode 01.mp4")
    for message, note in (
        (f"saved {path.name} + cover embedded", " + cover embedded"),
        (f"saved {path.name} (0.1 MiB) + cover embedded + file", " + cover embedded + file"),
        (f"saved {path.name} + cover file", " + cover file"),
        (f"saved {path.name}; cover: not available", "; cover: not available"),
        (
            f"saved {path.name} (0.1 MiB); cover: HTTP 429 from p16.tiktokcdn.com",
            "; cover: HTTP 429 from p16.tiktokcdn.com",
        ),
        (f"saved {path.name} (0.1 MiB)", ""),
    ):
        cli._print_result(DownloadResult(episode, DownloadStatus.DONE, path, message))
        assert capsys.readouterr().out == f"E01  done                   {path}{note}\n", message
    # a failure has no path: its message, as before; a skip shows its path, nothing appended
    cli._print_result(
        DownloadResult(episode, DownloadStatus.FAILED, None, f"{INCOMPLETE_PREFIX}no audio track")
    )
    assert (
        capsys.readouterr().out
        == f"E01  failed                 {INCOMPLETE_PREFIX}no audio track\n"
    )
    cli._print_result(
        DownloadResult(episode, DownloadStatus.SKIPPED_EXISTS, path, f"already exists: {path.name}")
    )
    assert capsys.readouterr().out == f"E01  skipped-exists         {path}\n"


@pytest.mark.parametrize("mode", ["embed", "both", "file", "none"])
def test_the_thumbnail_mode_reaches_download_and_video(
    fake_downloader, fake_discovery, tmp_path, mode
):
    argv = ["--out", str(tmp_path), "--thumbnail", mode]
    assert cli.main(["download", SERIES_URL, "--delay-min", "0", "--delay-max", "0", *argv]) == 0
    assert cli.main(["video", VIDEO_URL, *argv]) == 0
    series_run, video_run = fake_downloader.instances
    assert {options.thumbnail for _, options in series_run.calls} == {mode}
    assert video_run.calls[0][1].thumbnail == mode


def test_describe_pacing():
    defaults = "4–9 s between episodes, 60–120 s rest every 10; stop after 3 failures / 403 / 429"  # noqa: RUF001
    assert cli.describe_pacing() == defaults
    assert cli.describe_pacing(DownloadOptions()) == defaults
    assert cli.describe_pacing(
        DownloadOptions(pace="human", delay_min_s=5.0, rest_every=0, max_consecutive_failures=0)
    ) == (
        "human pace (about one episode's length, at least 5 s) between episodes, no long rests; "
        "stop on 403 / 429"
    )
    assert (
        cli.describe_pacing(
            DownloadOptions(
                delay_min_s=2.5,
                delay_max_s=2.5,
                rest_every=4,
                rest_min_s=30.0,
                rest_max_s=45.0,
                max_consecutive_failures=1,
            )
        )
        == "2.5 s between episodes, 30–45 s rest every 4; stop after 1 failure / 403 / 429"  # noqa: RUF001
    )


def test_doctor_browser_flags(tmp_path):
    channel = cli.doctor_checks(browser_channel="chrome")[4]
    assert channel.state == "skip"
    assert "chrome" in channel.detail
    missing = cli.doctor_checks(browser_path=tmp_path / "nope")[4]
    assert missing.state == "fail"
    binary = tmp_path / "chrome"
    binary.write_bytes(b"")
    present = cli.doctor_checks(browser_path=binary)[4]
    assert present.state == "ok"
    assert str(binary) in present.detail
    assert cli.format_doctor([present]) == [f"✓ browser: --browser-path {binary}"]
    assert cli.format_doctor([channel], ascii_marks=True)[0].startswith("- browser:")
    assert present.as_dict() == {
        "name": "browser",
        "state": "ok",
        "detail": f"--browser-path {binary}",
    }


def test_doctor_cookies_report_names_only(tmp_path, capsys):
    cookies = tmp_path / "cookies.txt"
    cookies.write_text(
        "# Netscape HTTP Cookie File\n"
        "#HttpOnly_.tiktok.com\tTRUE\t/\tTRUE\t9999999999\tsessionid\tSECRETSESSIONVALUE\n"
        ".tiktok.com\tTRUE\t/\tTRUE\t9999999999\tsid_tt\tSECRETSIDVALUE\n"
        ".tiktok.com\tTRUE\t/\tFALSE\t9999999999\tttwid\tSECRETTTWID\n"
        ".example.com\tTRUE\t/\tFALSE\t0\tsessionid\tNOTTIKTOK\n"
        "# a trailing comment\n",
        encoding="utf-8",
    )
    assert cli.main(["doctor", "--cookies", str(cookies), "--browser-channel", "chrome"]) == 0
    out = capsys.readouterr().out
    line = next(ln for ln in out.splitlines() if "cookies:" in ln)
    assert line.startswith("✓ cookies: cookies.txt:")
    assert "3 tiktok.com cookie line(s)" in line
    assert "session cookie names present: sessionid, sid_tt" in line
    assert "days old" in line
    for secret in ("SECRETSESSIONVALUE", "SECRETSIDVALUE", "SECRETTTWID", "NOTTIKTOK"):
        assert secret not in out
    checks = cli.doctor_as_dicts(cookies_file=cookies, browser_channel="chrome")
    assert checks[6]["state"] == "ok"
    assert not any("SECRET" in json.dumps(check) for check in checks)


def test_doctor_flags_malformed_cookie_lines_by_number_only(tmp_path, capsys):
    """yt-dlp would skip such lines with a WARNING that quotes them, cookie values included."""
    cookies = tmp_path / "cookies.txt"
    cookies.write_text(
        "# Netscape HTTP Cookie File\n"
        "#HttpOnly_.tiktok.com\tTRUE\t/\tTRUE\t9999999999\tsessionid\tSECRETSESSIONVALUE\n"
        ".tiktok.com\tTRUE\t/\tFALSE\t9999999999\tttwid\tSECRETTTWID\textra_field\n"
        "garbage line with SECRETGARBAGE\n",
        encoding="utf-8",
    )
    assert cli.main(["doctor", "--cookies", str(cookies), "--browser-channel", "chrome"]) == 0
    out = capsys.readouterr().out
    line = next(ln for ln in out.splitlines() if "cookies:" in ln)
    assert line.startswith("✗ cookies: cookies.txt:")
    assert "malformed (line 3: 8 fields (expected 7); line 4: 1 fields (expected 7))" in line
    assert "yt-dlp would print those lines" in line
    for secret in ("SECRETSESSIONVALUE", "SECRETTTWID", "SECRETGARBAGE", "extra_field"):
        assert secret not in out
    assert cli.doctor_checks(browser_channel="chrome", cookies_file=cookies)[6].state == "fail"


def test_doctor_cookies_without_session_or_missing(tmp_path):
    cookies = tmp_path / "cookies.txt"
    cookies.write_text(".tiktok.com\tTRUE\t/\tFALSE\t0\tttwid\tV\n", encoding="utf-8")
    check = cli.doctor_checks(browser_channel="chrome", cookies_file=cookies)[6]
    assert check.state == "fail"
    assert "no sessionid/sid_tt cookie" in check.detail
    assert "V" not in check.detail.split("cookie line(s)")[1].split(";")[0]
    empty = tmp_path / "empty.txt"
    empty.write_text("# nothing\n", encoding="utf-8")
    assert cli.doctor_checks(browser_channel="chrome", cookies_file=empty)[6].state == "fail"
    assert (
        cli.doctor_checks(browser_channel="chrome", cookies_file=tmp_path / "missing")[6].state
        == "fail"
    )
    old = tmp_path / "old.txt"
    old.write_text(".tiktok.com\tTRUE\t/\tTRUE\t1\tsessionid\tX\n", encoding="utf-8")
    import os

    os.utime(old, (time.time() - 3 * 86400, time.time() - 3 * 86400))
    check = cli.doctor_checks(browser_channel="chrome", cookies_file=old)[6]
    assert check.state == "ok"
    assert "3.0 days old" in check.detail


# --------------------------------------------------------------------------- serve


class _StubServer:
    """What a fake `run_server(..., serve_forever=False)` hands back to the CLI."""

    def __init__(self, host, port):
        self.server_address = (host, port or 8765)
        self.served = False
        self.closed = False

    def serve_forever(self):
        self.served = True

    def server_close(self):
        self.closed = True


def _stub_run_server(monkeypatch):
    """Replace `run_server` with a stub that records its kwargs and binds nothing; the CLI's lazy
    `from dramafetch.web.server import run_server` picks it up. Clears DRAMAFETCH_TOKEN as well, so
    the tests see the loopback default whatever the developer's shell exports."""
    from dramafetch.web import server as web_server

    calls = []
    servers = []

    def run_server(**kwargs):
        calls.append(kwargs)
        servers.append(_StubServer(kwargs["host"], kwargs["port"]))
        return servers[-1]

    monkeypatch.setattr(web_server, "run_server", run_server)
    monkeypatch.delenv("DRAMAFETCH_TOKEN", raising=False)
    return calls, servers


def test_serve_wires_flags_into_run_server(monkeypatch, tmp_path, capsys):
    calls, servers = _stub_run_server(monkeypatch)
    code = cli.main(
        [
            "serve",
            "--port",
            "9000",
            "--out",
            str(tmp_path),
            "--cookies",
            "c.txt",
            "--strategy",
            "browser",
            "--delay-min",
            "1",
            "--delay-max",
            "2",
            "--no-impersonate",
            "--pace",
            "human",
            "--rest-every",
            "5",
            "--rest-min",
            "10",
            "--rest-max",
            "20",
            "--max-consecutive-failures",
            "2",
            "--engine",
            "browser",
            "--browser-channel",
            "msedge",
            "--thumbnail",
            "both",
            "--recheck",
        ]
    )
    assert code == 0
    (kwargs,) = calls
    assert kwargs["host"] == "127.0.0.1"
    assert kwargs["port"] == 9000
    assert kwargs["out_dir"] == tmp_path
    assert kwargs["serve_forever"] is False  # the CLI serves itself, after announcing the bind
    assert kwargs["token"] is None  # the loopback default needs no token
    assert kwargs["discovery_options"].cookies_file == Path("c.txt")
    assert kwargs["discovery_options"].strategy == "browser"
    download_options = kwargs["download_options"]
    assert download_options.out_dir == tmp_path
    assert download_options.cookies_file == Path("c.txt")
    assert download_options.delay_min_s == 1.0
    assert download_options.impersonate is False
    # the same pacing and engine options as `download`, so the web UI paces like the CLI
    assert download_options.pace == "human"
    assert (download_options.rest_every, download_options.rest_min_s) == (5, 10.0)
    assert download_options.rest_max_s == 20.0
    assert download_options.max_consecutive_failures == 2
    assert download_options.engine == "browser"
    assert download_options.browser_channel == "msedge"
    # the cover mode too: the web UI's jobs embed, keep or skip covers exactly like `download`
    assert download_options.thumbnail == "both"
    assert download_options.embed_cover and download_options.keep_cover_file
    # build 6: batch jobs resolve a series their manifest calls complete only with --recheck
    assert download_options.recheck is True
    assert cli.build_parser().parse_args(["serve"]).recheck is False
    assert servers[0].served and servers[0].closed
    err = capsys.readouterr().err
    assert "http://127.0.0.1:9000/" in err
    assert "token: none (loopback only)" in err
    assert "warning" not in err  # the private default needs no warning


def test_serve_off_loopback_without_a_token_is_a_usage_error(monkeypatch, capsys):
    calls, _ = _stub_run_server(monkeypatch)
    for host in ("0.0.0.0", "::", "[::]", "192.168.1.20", "example.lan"):
        assert cli.main(["serve", "--host", host]) == 2
        err = capsys.readouterr().err
        assert f"--host {host} needs --token (or DRAMAFETCH_TOKEN)" in err
        assert "without it the UI would be open to everyone on the network" in err
    assert calls == []  # refused before run_server, so before any bind
    for host in ("127.0.0.1", "localhost", "[::1]", "127.0.0.2"):  # loopback needs none
        assert cli.main(["serve", "--host", host]) == 0
        assert "token: none (loopback only)" in capsys.readouterr().err
    assert [call["token"] for call in calls] == [None] * 4


def test_serve_token_flag_and_environment(monkeypatch, capsys):
    calls, _ = _stub_run_server(monkeypatch)
    assert cli.main(["serve", "--host", "0.0.0.0", "--token", "flag-token-123"]) == 0
    assert calls[-1]["host"] == "0.0.0.0" and calls[-1]["token"] == "flag-token-123"
    err = capsys.readouterr().err
    assert "token: set" in err and "warning" not in err
    assert "flag-token-123" not in err  # the value is never printed
    monkeypatch.setenv("DRAMAFETCH_TOKEN", "env-token-4567")
    assert cli.main(["serve", "--host", "0.0.0.0"]) == 0
    assert calls[-1]["token"] == "env-token-4567"
    err = capsys.readouterr().err
    assert "token: set" in err and "env-token-4567" not in err
    assert cli.main(["serve", "--host", "0.0.0.0", "--token", "flag-token-123"]) == 0
    assert calls[-1]["token"] == "flag-token-123"  # the flag wins over the variable
    capsys.readouterr()
    assert cli.main(["serve"]) == 0  # a token on loopback: honoured, the page is protected
    assert calls[-1]["token"] == "env-token-4567"
    assert "token: set" in capsys.readouterr().err
    monkeypatch.setenv("DRAMAFETCH_TOKEN", "")  # an empty variable counts as unset
    assert cli.main(["serve"]) == 0
    assert calls[-1]["token"] is None
    assert cli.main(["serve", "--host", "0.0.0.0"]) == 2


def test_serve_refuses_an_unusable_token(monkeypatch, capsys):
    calls, _ = _stub_run_server(monkeypatch)
    assert cli.main(["serve", "--token", "tiny1"]) == 2
    err = capsys.readouterr().err
    assert "--token (or DRAMAFETCH_TOKEN): the token must be at least 8 characters" in err
    assert "tiny1" not in err
    assert cli.main(["serve", "--token", "has a space in it"]) == 2
    assert "visible ASCII" in capsys.readouterr().err
    assert cli.main(["serve", "--token", ""]) == 2
    capsys.readouterr()
    monkeypatch.setenv("DRAMAFETCH_TOKEN", "tiny1")
    assert cli.main(["serve", "--host", "0.0.0.0"]) == 2
    err = capsys.readouterr().err
    assert "DRAMAFETCH_TOKEN" in err and "tiny1" not in err
    assert calls == []


def test_serve_starts_during_a_cooldown_and_leaves_the_answer_to_the_web(monkeypatch, capsys):
    """`serve` itself contacts nobody: a cooldown recorded earlier must not stop it from binding
    (the web answers 429 of kind `cooldown` per request; `info`/`download`/`video` exit 5)."""
    from dramafetch.cooldown import record_block  # the autouse fixture points its file at tmp_path

    calls, servers = _stub_run_server(monkeypatch)
    record_block("blocked (HTTP 403): TikTok refused the request", "yt-dlp")
    assert cli.main(["serve"]) == 0
    assert len(calls) == 1 and servers[0].served and servers[0].closed
    err = capsys.readouterr().err
    assert "DramaFetch web UI on http://127.0.0.1:8765/" in err
    assert "error:" not in err


def test_serve_help_mentions_the_token():
    help_text = _subcommand_help("serve")
    assert "--token TOKEN" in help_text and "DRAMAFETCH_TOKEN" in help_text
    assert "needs --token" in help_text  # the --host help says when it is required
    parser = cli.build_parser()
    assert parser.parse_args(["serve"]).token is None
    assert parser.parse_args(["serve", "--token", "abcdefgh"]).token == "abcdefgh"


def test_serve_reports_a_busy_port_instead_of_a_traceback(tmp_path, capsys):
    taken = socket.socket()
    try:
        taken.bind(("127.0.0.1", 0))
        taken.listen(1)
        port = taken.getsockname()[1]
        code = cli.main(["serve", "--port", str(port), "--out", str(tmp_path)])
    finally:
        taken.close()
    assert code == 1
    err = capsys.readouterr().err
    assert f"error: cannot start the web UI on 127.0.0.1:{port}:" in err
    assert "Traceback" not in err
    assert "web UI on http://" not in err  # no banner before a successful bind


def test_serve_announces_the_port_it_bound_and_stops_on_ctrl_c(monkeypatch, tmp_path, capsys):
    from dramafetch.web import server as web_server

    def interrupted(self):
        raise KeyboardInterrupt

    monkeypatch.setattr(web_server.DramaFetchServer, "serve_forever", interrupted)
    assert cli.main(["serve", "--port", "0", "--out", str(tmp_path)]) == 0
    err = capsys.readouterr().err
    assert "DramaFetch web UI on http://127.0.0.1:" in err
    assert "http://127.0.0.1:0/" not in err  # the real port, not the requested 0
    assert "interrupted: results so far" not in err  # Ctrl+C is the normal way to stop `serve`


def test_serve_accepts_a_bracketed_ipv6_host(monkeypatch, tmp_path, capsys):
    try:
        probe = socket.socket(socket.AF_INET6)
        probe.bind(("::1", 0))
        probe.close()
    except OSError:
        pytest.skip("no IPv6 loopback on this machine")
    from dramafetch.web import server as web_server

    def interrupted(self):
        raise KeyboardInterrupt

    monkeypatch.setattr(web_server.DramaFetchServer, "serve_forever", interrupted)
    assert cli.main(["serve", "--host", "[::1]", "--port", "0", "--out", str(tmp_path)]) == 0
    assert "DramaFetch web UI on http://[::1]:" in capsys.readouterr().err
