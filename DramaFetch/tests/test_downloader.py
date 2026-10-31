"""downloader: yt-dlp params, the no-network paths, success, and every error classification."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from dramafetch.downloader import (
    H264_FORMAT,
    YtDlpDownloader,
    curl_cffi_available,
    existing_episode_file,
    impersonate_target,
    is_partial_file,
    sanitize_error,
)
from dramafetch.models import DownloadOptions, DownloadStatus, Episode

SERIES_ID = "7699393770256782354"
EPISODE = Episode(
    number=3,
    item_id="7699400000000000003",
    title="Heiress | Episode 3",
    series_id=SERIES_ID,
    author="muffindrama_us",
)
LOCKED = Episode(
    number=5,
    item_id="7699400000000000005",
    title="Ep 5",
    series_id=SERIES_ID,
    lock_hints=("isFree=false", "isLocked=True", "no play address"),
)
STEM = "E03 - Heiress Episode 3"


class FakeYdl:
    """Stands in for yt_dlp.YoutubeDL: records params and URLs, creates a file or raises."""

    def __init__(self, params, log, *, produce=".mp4", error=None, retcode=0):
        self.params = params
        self.log = log
        self.produce = produce
        self.error = error
        self.retcode = retcode

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def download(self, urls):
        self.log.append({"params": self.params, "urls": list(urls)})
        if self.error is not None:
            raise self.error
        if self.produce:
            target = Path(self.params["outtmpl"].replace("%(ext)s", self.produce.lstrip(".")))
            target.write_bytes(b"video")
        return self.retcode


def make_factory(**kwargs):
    log = []

    def factory(params):
        return FakeYdl(params, log, **kwargs)

    return factory, log


# --------------------------------------------------------------------------- build_options


def test_build_options_full(tmp_path):
    options = DownloadOptions(
        out_dir=tmp_path,
        cookies_file=tmp_path / "cookies.txt",
        cookies_from_browser="chrome",
        retries=7,
        overwrite=True,
        extractor_args={"tiktok": {"api_hostname": ["api22-normal-c-useast2a.tiktokv.com"]}},
    )
    params = YtDlpDownloader(lambda p: None).build_options(EPISODE, options, "/tmp/x.%(ext)s")
    assert params["outtmpl"] == "/tmp/x.%(ext)s"
    assert params["noplaylist"] is True
    assert params["retries"] == 7
    assert params["fragment_retries"] == 7
    assert params["quiet"] is True
    assert params["no_warnings"] is True
    assert params["noprogress"] is True
    assert params["format"] == H264_FORMAT == "best[vcodec^=h264]/best[vcodec=avc1]/best"
    assert params["cookiefile"] == str(tmp_path / "cookies.txt")
    assert params["cookiesfrombrowser"] == ("chrome",)
    assert params["http_headers"] == {"Referer": "https://www.tiktok.com/"}
    assert params["restrictfilenames"] is False
    assert params["windowsfilenames"] is True
    assert params["overwrites"] is True
    assert params["sleep_interval_requests"] == 1
    assert params["extractor_args"] == {
        "tiktok": {"api_hostname": ["api22-normal-c-useast2a.tiktokv.com"]}
    }
    # curl_cffi is installed in the venv, so impersonation is on by default
    assert curl_cffi_available()
    from yt_dlp.networking.impersonate import ImpersonateTarget

    assert isinstance(params["impersonate"], ImpersonateTarget)
    assert params["impersonate"].client == "chrome"


def test_build_options_minimal_without_cookies_and_h264():
    options = DownloadOptions(prefer_h264=False, impersonate=False)
    params = YtDlpDownloader(lambda p: None).build_options(EPISODE, options, "o.%(ext)s")
    assert params["format"] == "best"
    assert "cookiefile" not in params
    assert "cookiesfrombrowser" not in params
    assert "impersonate" not in params
    assert "extractor_args" not in params
    assert params["overwrites"] is False


def test_build_options_omits_impersonation_when_curl_cffi_is_missing(monkeypatch):
    monkeypatch.setitem(sys.modules, "curl_cffi", None)  # makes `import curl_cffi` fail
    assert not curl_cffi_available()
    assert impersonate_target() is None
    params = YtDlpDownloader(lambda p: None).build_options(EPISODE, DownloadOptions(), "o.%(ext)s")
    assert "impersonate" not in params


# --------------------------------------------------------------------------- no-network paths


def test_locked_episode_is_skipped_without_calling_yt_dlp(tmp_path):
    factory, log = make_factory()
    result = YtDlpDownloader(factory).download(LOCKED, DownloadOptions(out_dir=tmp_path))
    assert result.status is DownloadStatus.SKIPPED_LOCKED
    assert result.path is None
    assert result.message == "looks locked: isFree=false; isLocked=True; no play address"
    assert log == []
    assert not tmp_path.exists() or not any(tmp_path.iterdir())


def test_include_locked_tries_the_download(tmp_path):
    factory, log = make_factory()
    result = YtDlpDownloader(factory).download(
        LOCKED, DownloadOptions(out_dir=tmp_path, include_locked=True)
    )
    assert result.status is DownloadStatus.DONE
    assert len(log) == 1


def test_existing_file_is_skipped_and_partials_do_not_count(tmp_path):
    factory, log = make_factory()
    downloader = YtDlpDownloader(factory)
    (tmp_path / f"{STEM}.mp4.part").write_bytes(b"partial")
    result = downloader.download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert result.status is DownloadStatus.DONE  # the .part file was ignored
    assert len(log) == 1
    result = downloader.download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert result.status is DownloadStatus.SKIPPED_EXISTS
    assert result.path == tmp_path / f"{STEM}.mp4"
    assert result.message == f"already exists: {STEM}.mp4"
    assert len(log) == 1  # not called again
    result = downloader.download(EPISODE, DownloadOptions(out_dir=tmp_path, overwrite=True))
    assert result.status is DownloadStatus.DONE
    assert len(log) == 2
    assert log[1]["params"]["overwrites"] is True


def test_dry_run_reports_the_page_url(tmp_path):
    factory, log = make_factory()
    result = YtDlpDownloader(factory).download(
        EPISODE, DownloadOptions(out_dir=tmp_path, dry_run=True)
    )
    assert result.status is DownloadStatus.DRY_RUN
    assert EPISODE.page_url in result.message
    assert "https://www.tiktok.com/@muffindrama_us/video/7699400000000000003" in result.message
    assert log == []


# --------------------------------------------------------------------------- success


def test_success_creates_the_file_in_out_dir(tmp_path):
    out_dir = tmp_path / "series dir"
    factory, log = make_factory(produce=".mp4")
    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=out_dir))
    assert result.status is DownloadStatus.DONE
    assert result.path == out_dir / f"{STEM}.mp4"
    assert result.path.read_bytes() == b"video"
    assert result.message == f"saved {STEM}.mp4"
    assert log[0]["urls"] == [EPISODE.page_url]
    assert log[0]["params"]["outtmpl"] == str(out_dir / f"{STEM}.%(ext)s")


def test_success_without_a_file_is_a_failure(tmp_path):
    factory, _ = make_factory(produce=None)
    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert result.status is DownloadStatus.FAILED
    assert "no file" in result.message


def test_non_zero_return_code_is_a_failure(tmp_path):
    factory, _ = make_factory(retcode=1)
    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert result.status is DownloadStatus.FAILED
    assert result.message == "yt-dlp exited with code 1"


# --------------------------------------------------------------------------- errors


@pytest.mark.parametrize(
    ("message", "status"),
    [
        (
            "ERROR: [TikTok] 123: Unable to extract video data; requiring login",
            DownloadStatus.FAILED_LOGIN,
        ),
        ("Login required to view this video", DownloadStatus.FAILED_LOGIN),
        ("Please Log in to continue", DownloadStatus.FAILED_LOGIN),
        ("only logged-in users can view", DownloadStatus.FAILED_LOGIN),
        ("HTTP Error 429: Too Many Requests", DownloadStatus.FAILED_RATE_LIMITED),
        ("rate limit exceeded", DownloadStatus.FAILED_RATE_LIMITED),
        ("ERROR: [TikTok] 123: No video formats found!", DownloadStatus.FAILED_UNAVAILABLE),
        ("This video is not available", DownloadStatus.FAILED_UNAVAILABLE),
        ("Video is private", DownloadStatus.FAILED_UNAVAILABLE),
        ("The video has been removed", DownloadStatus.FAILED_UNAVAILABLE),
        ("This content is geo-restricted", DownloadStatus.FAILED_UNAVAILABLE),
        ("not available in your country", DownloadStatus.FAILED_UNAVAILABLE),
        ("Unable to download webpage: HTTP Error 403: Forbidden", DownloadStatus.FAILED),
        ("", DownloadStatus.FAILED),
    ],
)
def test_classify_error(message, status):
    assert YtDlpDownloader.classify_error(message) is status


@pytest.mark.parametrize(
    ("message", "status"),
    [
        ("ERROR: [TikTok] 7699400000000000003: requiring login", DownloadStatus.FAILED_LOGIN),
        ("HTTP Error 429: Too Many Requests", DownloadStatus.FAILED_RATE_LIMITED),
        ("No video formats found!; please report this issue", DownloadStatus.FAILED_UNAVAILABLE),
        ("something odd happened", DownloadStatus.FAILED),
    ],
)
def test_download_errors_are_classified_never_raised(tmp_path, message, status):
    from yt_dlp.utils import DownloadError

    factory, _ = make_factory(error=DownloadError(message))
    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert result.status is status
    assert result.message == message
    assert result.path is None


def test_any_exception_is_caught(tmp_path):
    factory, _ = make_factory(error=RuntimeError("boom\nsecond line"))
    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert result.status is DownloadStatus.FAILED
    assert result.message == "boom"  # first line only
    factory, _ = make_factory(error=ValueError())
    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert result.status is DownloadStatus.FAILED
    assert result.message == "ValueError"


def test_error_messages_are_redacted_and_truncated(tmp_path):
    from yt_dlp.utils import DownloadError

    leak = (
        "ERROR: request failed with Cookie: sessionid=SECRETSESSION; sid_tt=SECRETSID; "
        "msToken=SECRETTOKEN&ttwid=SECRETTTWID " + "x" * 400
    )
    factory, _ = make_factory(error=DownloadError(leak))
    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=tmp_path))
    for secret in ("SECRETSESSION", "SECRETSID", "SECRETTOKEN", "SECRETTTWID"):
        assert secret not in result.message
    assert "<redacted>" in result.message
    assert len(result.message) <= 300
    assert result.message.endswith("…")


def test_sanitize_error_keeps_harmless_mentions_of_cookies():
    text = "No video formats found; try passing cookies with --cookies"
    assert sanitize_error(text) == text
    assert sanitize_error("   \n\n  ") == "unknown error"
    assert sanitize_error("sid_tt: abc123; done") == "sid_tt=<redacted>; done"


# --------------------------------------------------------------------------- helpers


def test_partial_detection_and_newest_existing_file(tmp_path):
    assert is_partial_file("E01 - x.mp4.part")
    assert is_partial_file("E01 - x.mp4.ytdl")
    assert is_partial_file("E01 - x.mp4.part-Frag3")
    assert not is_partial_file("E01 - x.mp4")
    assert existing_episode_file(tmp_path / "missing", EPISODE) is None
    assert existing_episode_file(tmp_path, EPISODE) is None
    older = tmp_path / f"{STEM}.webm"
    older.write_bytes(b"1")
    import os

    os.utime(older, (1_000_000, 1_000_000))
    newer = tmp_path / f"{STEM}.mp4"
    newer.write_bytes(b"2")
    (tmp_path / f"{STEM}x.mp4").write_bytes(b"other stem")  # prefix without the dot: not ours
    (tmp_path / f"{STEM}.mp4.part").write_bytes(b"partial")
    assert existing_episode_file(tmp_path, EPISODE) == newer
