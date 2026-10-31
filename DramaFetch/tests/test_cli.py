"""cli: parsing of every subcommand, info/download/video end-to-end with fakes, doctor, serve."""

from __future__ import annotations

import json
import sys
import time
import types
from pathlib import Path
from typing import ClassVar

import pytest

from dramafetch import __version__, cli
from dramafetch.catalog import catalog_warnings
from dramafetch.downloader import locked_result
from dramafetch.errors import ChallengeError, DiscoveryError, LoginRequiredError
from dramafetch.manifest import MANIFEST_FILENAME
from dramafetch.models import DownloadResult, DownloadStatus, Episode, Series

SERIES_ID = "7699393770256782354"
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
    """Replaces cli.YtDlpDownloader: no network, creates files, outcomes per episode number."""

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
            path = options.out_dir / f"E{episode.number:02d} - fake.mp4"
            path.write_bytes(b"v")
            return DownloadResult(episode, status, path, "saved")
        return DownloadResult(episode, status, message=f"{status.value} from fake")


@pytest.fixture
def fake_downloader(monkeypatch):
    FakeDownloader.outcomes = {}
    FakeDownloader.instances = []
    monkeypatch.setattr(cli, "YtDlpDownloader", FakeDownloader)
    return FakeDownloader


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
            "9",
        ]
    )
    assert args.episodes == "1-5,8"
    assert args.out == "/tmp/x"
    assert (args.delay_min, args.delay_max) == (1.0, 2.0)
    assert args.include_locked and args.overwrite and args.dry_run and args.no_impersonate
    assert args.cookies_from_browser == "firefox"
    assert args.extractor_args == ["tiktok:api_hostname=api22.tiktokv.com", "foo=bar"]
    assert args.retries == 9
    defaults = cli.build_parser().parse_args(["download", SERIES_URL])
    assert defaults.episodes is None
    assert (defaults.delay_min, defaults.delay_max) == (3.0, 7.0)
    assert defaults.extractor_args is None
    assert defaults.retries == 3


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
        ["serve", "--port", "70000"],
        ["info", SERIES_URL, "--strategy", "magic"],
        ["info", SERIES_URL, "--page-count", "0"],
        ["info", SERIES_URL, "--max-pages", "0"],
        ["download", SERIES_URL, "--page-delay", "-0.5"],
    ],
)
def test_usage_errors_exit_2_before_any_network(argv, capsys, fake_discovery):
    assert cli.main(argv) == 2
    assert fake_discovery.calls == []
    assert capsys.readouterr().err  # argparse explained the problem


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
    ],
)
def test_discovery_errors_map_to_exit_codes(fake_discovery, capsys, error, code, hint):
    fake_discovery.error = error
    assert cli.main(["info", SERIES_URL]) == code
    err = capsys.readouterr().err
    assert str(error) in err
    assert hint in err


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
    assert lines[1].endswith("E01 - fake.mp4")
    assert lines[4].startswith("E05  skipped-locked")
    assert "looks locked: isFree=false; isLocked=True" in lines[4]
    assert lines[-1] == "Summary: 3 done, 1 skipped-locked"
    target = tmp_path / f"{NAME} [{SERIES_ID}]"
    assert sorted(p.name for p in target.iterdir()) == [
        "E01 - fake.mp4",
        "E02 - fake.mp4",
        "E03 - fake.mp4",
        MANIFEST_FILENAME,
    ]
    (downloader,) = fake_downloader.instances
    assert [episode.number for episode, _ in downloader.calls] == [1, 2, 3, 5]
    assert all(options.out_dir == target for _, options in downloader.calls)
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
        ]
    )
    assert code == 0
    out = capsys.readouterr().out
    assert out.count("dry-run") == 4 + 1  # 4 episode lines + the summary
    assert "Summary: 4 dry-run" in out
    (downloader,) = fake_downloader.instances
    _, options = downloader.calls[0]
    assert options.dry_run and options.include_locked and options.overwrite
    assert options.impersonate is False
    assert options.cookies_file == Path("c.txt")
    assert options.cookies_from_browser == "firefox"
    assert options.extractor_args == {"tiktok": {"api_hostname": ["h"]}}
    assert options.retries == 1
    assert options.delay_min_s == options.delay_max_s == 0.5
    target = tmp_path / f"{NAME} [{SERIES_ID}]"
    assert sorted(p.name for p in target.iterdir()) == [MANIFEST_FILENAME]


# --------------------------------------------------------------------------- video


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
    assert (tmp_path / "vids" / "E00 - fake.mp4").exists()
    out = capsys.readouterr().out
    assert out.startswith("E00  done")


def test_video_failure_exit_code_and_series_url_rejection(fake_downloader, tmp_path, capsys):
    fake_downloader.outcomes = {0: DownloadStatus.FAILED_LOGIN}
    assert cli.main(["video", VIDEO_URL, "--out", str(tmp_path)]) == 3
    assert cli.main(["video", SERIES_URL, "--out", str(tmp_path)]) == 2
    assert "dramafetch download" in capsys.readouterr().err


# --------------------------------------------------------------------------- doctor


def test_doctor_runs_without_a_browser_and_exits_0(capsys):
    assert cli.main(["doctor"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 7
    assert all(line[0] in "✓✗–" for line in lines)  # noqa: RUF001
    names = [line.split(" ", 1)[1].split(":")[0] for line in lines]
    assert names == ["python", "yt-dlp", "curl_cffi", "playwright", "browser", "ffmpeg", "cookies"]
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
        "garbage line\n",
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


def test_serve_wires_flags_into_run_server(monkeypatch, tmp_path, capsys):
    calls = []
    module = types.ModuleType("dramafetch.web.server")

    def run_server(**kwargs):
        calls.append(kwargs)

    module.run_server = run_server
    monkeypatch.setitem(sys.modules, "dramafetch.web.server", module)
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
        ]
    )
    assert code == 0
    (kwargs,) = calls
    assert kwargs["host"] == "127.0.0.1"
    assert kwargs["port"] == 9000
    assert kwargs["out_dir"] == tmp_path
    assert kwargs["discovery_options"].cookies_file == Path("c.txt")
    assert kwargs["discovery_options"].strategy == "browser"
    assert kwargs["download_options"].out_dir == tmp_path
    assert kwargs["download_options"].cookies_file == Path("c.txt")
    assert kwargs["download_options"].delay_min_s == 1.0
    assert kwargs["download_options"].impersonate is False
    err = capsys.readouterr().err
    assert "http://127.0.0.1:9000/" in err
    assert "warning" not in err  # the private default needs no warning
    assert cli.main(["serve", "--host", "0.0.0.0"]) == 0
    assert calls[1]["host"] == "0.0.0.0"
    assert "warning: --host 0.0.0.0 exposes the UI" in capsys.readouterr().err
