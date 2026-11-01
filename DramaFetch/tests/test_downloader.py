"""downloader: yt-dlp params, the no-network paths, success, and every error classification."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from mutagen.mp4 import MP4

from dramafetch.downloader import (
    BLOCKED_MESSAGE,
    H264_FORMAT,
    MAX_RETRIES,
    VIDEO_SUFFIXES,
    YtDlpDownloader,
    cookies_file_problem,
    curl_cffi_available,
    describe_failure,
    existing_episode_file,
    impersonate_target,
    is_partial_file,
    output_template,
    redact_secrets,
    sanitize_error,
)
from dramafetch.manifest import episode_stem
from dramafetch.models import DownloadOptions, DownloadStatus, Episode
from dramafetch.thumbnails import EMBED_SUFFIX, MAX_COVER_BYTES, extract_cover

SERIES_ID = "7699393770256782354"
EPISODE = Episode(
    number=3,
    item_id="7699400000000000003",
    title="Heiress | Episode 3",
    series_id=SERIES_ID,
    series_name="Heiress",
    author="muffindrama_us",
)
LOCKED = Episode(
    number=5,
    item_id="7699400000000000005",
    title="Ep 5",
    series_id=SERIES_ID,
    lock_hints=("isFree=false", "isLocked=True", "no play address"),
)
# The default name format, "{series} - Episode {number}", for EPISODE.
STEM = "Heiress - Episode 03"
OPTIONS = DownloadOptions()


class FakeYdl:
    """Stands in for yt_dlp.YoutubeDL: records params and URLs, creates a file or raises. With
    `sidecar=(".jpeg", bytes)` it also writes the cover `writethumbnail` would have written next to
    the video (named after the cover URL's extension, as yt-dlp does)."""

    def __init__(
        self,
        params,
        log,
        *,
        produce=".mp4",
        error=None,
        retcode=0,
        video_bytes=b"video",
        sidecar=None,
    ):
        self.params = params
        self.log = log
        self.produce = produce
        self.error = error
        self.retcode = retcode
        self.video_bytes = video_bytes
        self.sidecar = sidecar

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def download(self, urls):
        self.log.append({"params": self.params, "urls": list(urls)})
        if self.error is not None:
            raise self.error
        if self.produce:
            # yt-dlp templates are %-format strings: `%(ext)s` expands, `%%` is a literal `%`.
            target = Path(self.params["outtmpl"] % {"ext": self.produce.lstrip(".")})
            if self.sidecar is not None:  # yt-dlp fetches and writes the cover before the video
                suffix, data = self.sidecar
                target.with_suffix(suffix).write_bytes(data)
            target.write_bytes(self.video_bytes)
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
        retries=2,
        overwrite=True,
        extractor_args={"tiktok": {"api_hostname": ["api22-normal-c-useast2a.tiktokv.com"]}},
    )
    params = YtDlpDownloader(lambda p: None).build_options(EPISODE, options, "/tmp/x.%(ext)s")
    assert params["outtmpl"] == "/tmp/x.%(ext)s"
    assert params["noplaylist"] is True
    assert params["retries"] == 2
    assert params["fragment_retries"] == 2
    assert params["quiet"] is True
    assert params["no_warnings"] is True
    assert params["noprogress"] is True
    assert params["format"] == H264_FORMAT == "best[vcodec^=h264]/best[vcodec=avc1]/best"
    assert params["cookiefile"] == str(tmp_path / "cookies.txt")
    assert params["cookiesfrombrowser"] == ("chrome",)
    assert params["http_headers"] == {"Referer": "https://www.tiktok.com/"}
    assert params["restrictfilenames"] is False
    # Only on Windows (where yt-dlp sanitizes anyway): on POSIX the flag would rewrite a legal
    # `--out` such as `videos:tiktok` into a sibling directory DramaFetch never looks at.
    assert params["windowsfilenames"] is (sys.platform == "win32")
    assert params["overwrites"] is True
    assert params["sleep_interval_requests"] == 1
    assert params["writethumbnail"] is True  # the cover lands next to the video, by default
    assert params["extractor_args"] == {
        "tiktok": {"api_hostname": ["api22-normal-c-useast2a.tiktokv.com"]}
    }
    # curl_cffi is installed in the venv, so impersonation is on by default
    assert curl_cffi_available()
    from yt_dlp.networking.impersonate import ImpersonateTarget

    assert isinstance(params["impersonate"], ImpersonateTarget)
    assert params["impersonate"].client == "chrome"


def test_retries_stay_modest_whatever_the_options_say():
    """After a refusal every retry is one more request against the same address: yt-dlp never
    gets more than MAX_RETRIES (3), and always sleeps a second between its own requests."""
    assert MAX_RETRIES == 3
    downloader = YtDlpDownloader(lambda p: None)
    params = downloader.build_options(EPISODE, DownloadOptions(retries=7), "o.%(ext)s")
    assert params["retries"] == 3 and params["fragment_retries"] == 3
    assert params["sleep_interval_requests"] == 1
    params = downloader.build_options(EPISODE, DownloadOptions(), "o.%(ext)s")
    assert params["retries"] == 3 and params["fragment_retries"] == 3
    params = downloader.build_options(EPISODE, DownloadOptions(retries=0), "o.%(ext)s")
    assert params["retries"] == 0 and params["fragment_retries"] == 0


def test_build_options_minimal_without_cookies_and_h264():
    options = DownloadOptions(prefer_h264=False, impersonate=False, thumbnail="none")
    params = YtDlpDownloader(lambda p: None).build_options(EPISODE, options, "o.%(ext)s")
    assert params["format"] == "best"
    assert "cookiefile" not in params
    assert "cookiesfrombrowser" not in params
    assert "impersonate" not in params
    assert "extractor_args" not in params
    assert "writethumbnail" not in params
    assert params["overwrites"] is False


def test_writethumbnail_follows_the_thumbnail_mode():
    """`--thumbnail none` leaves the key out entirely (yt-dlp's default is off); every other mode
    asks for the plain `writethumbnail` with no postprocessor — no ffmpeg, no conversion, no
    yt-dlp embedding: what happens to the file afterwards is DramaFetch's own `_finish_cover`."""
    downloader = YtDlpDownloader(lambda p: None)
    for mode in ("embed", "both", "file"):
        on = downloader.build_options(EPISODE, DownloadOptions(thumbnail=mode), "o.%(ext)s")
        assert on["writethumbnail"] is True
        assert "postprocessors" not in on and "convertthumbnails" not in on
        assert "embedthumbnail" not in on
    off = downloader.build_options(EPISODE, DownloadOptions(thumbnail="none"), "o.%(ext)s")
    assert "writethumbnail" not in off
    assert DownloadOptions().thumbnail == "embed" and DownloadOptions().thumbnails is True


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


def test_dry_run_reports_the_page_url_and_the_cover(tmp_path):
    factory, log = make_factory()
    result = YtDlpDownloader(factory).download(
        EPISODE, DownloadOptions(out_dir=tmp_path, dry_run=True)
    )
    assert result.status is DownloadStatus.DRY_RUN
    assert EPISODE.page_url in result.message
    assert result.message == (
        "would download https://www.tiktok.com/@muffindrama_us/video/7699400000000000003 + cover"
    )
    assert log == []
    for mode in ("both", "file"):
        with_cover = YtDlpDownloader(factory).download(
            EPISODE, DownloadOptions(out_dir=tmp_path, dry_run=True, thumbnail=mode)
        )
        assert with_cover.message == f"would download {EPISODE.page_url} + cover"
    plain = YtDlpDownloader(factory).download(
        EPISODE, DownloadOptions(out_dir=tmp_path, dry_run=True, thumbnail="none")
    )
    assert plain.message == f"would download {EPISODE.page_url}"
    assert log == []


# --------------------------------------------------------------------------- success


def test_success_creates_the_file_in_out_dir(tmp_path):
    out_dir = tmp_path / "series dir"
    factory, log = make_factory(produce=".mp4")
    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=out_dir))
    assert result.status is DownloadStatus.DONE
    assert result.path == out_dir / f"{STEM}.mp4"
    assert result.path.read_bytes() == b"video"
    # yt-dlp wrote no cover next to the video (it says nothing when it cannot get one): told
    assert result.message == f"saved {STEM}.mp4; cover: not available"
    assert log[0]["urls"] == [EPISODE.page_url]
    assert log[0]["params"]["outtmpl"] == str(out_dir / f"{STEM}.%(ext)s")


def test_output_template_escapes_literal_percent_signs():
    episode = Episode(
        number=1, item_id="1", title="Finale %(cookies)s 100%% | 50% off", series_id="s"
    )
    options = DownloadOptions(name_format="E{number} - {title}", series_name="50% off")
    template = output_template(Path("/tmp/50% off"), episode, options)
    assert template == "/tmp/50%% off/E01 - Finale %%(cookies)s 100%%%% 50%% off.%(ext)s"
    assert template % {"ext": "mp4"} == "/tmp/50% off/E01 - Finale %(cookies)s 100%% 50% off.mp4"
    # the series name is user- and TikTok-controlled text too
    with_series = output_template(Path("/tmp/o"), episode, DownloadOptions(series_name="50% off"))
    assert with_series == "/tmp/o/50%% off - Episode 01.%(ext)s"


def test_percent_sequences_in_titles_stay_literal_through_the_fake_ydl(tmp_path):
    episode = Episode(number=1, item_id="1", title="Ep %(id)s | %(cookies)s", series_id="s")
    factory, _ = make_factory()
    options = DownloadOptions(out_dir=tmp_path, name_format="E{number} - {title}")
    result = YtDlpDownloader(factory).download(episode, options)
    assert result.status is DownloadStatus.DONE
    assert result.path == tmp_path / "E01 - Ep %(id)s %(cookies)s.mp4"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX directory names")
@pytest.mark.parametrize(
    ("out_dir_name", "title"),
    [
        ("videos:tiktok", "Episode 1"),  # a colon is legal in a Linux/macOS directory name
        ("2026-10-31 12:00", "Episode 1"),
        ("My Videos.", "Episode 1"),  # trailing dot
        ("ok", "50%(off) sale | Episode 1"),  # `%(` would start a template field
        ("ok", "100%% sure | Episode 1"),
        ("ok", "100% sure | Episode 1"),
        ("ok", "Finale %(cookies)s"),  # yt-dlp fills a `cookies` field per format
        ("ok", "Ep %(id)s"),
        ("ok", "霸道总裁的秘密 | 第1集"),
    ],
)
def test_yt_dlp_writes_exactly_where_dramafetch_looks(tmp_path, out_dir_name, title):
    """The real YoutubeDL.prepare_filename (no network) must produce the path DramaFetch expects,
    whatever `--out` and the TikTok title contain, and never a cookie value."""
    import yt_dlp

    out_dir = tmp_path / out_dir_name / "Series [1]"
    episode = Episode(number=1, item_id="7699400000000000001", title=title, series_id="1")
    options = DownloadOptions(
        out_dir=out_dir, name_format="{series} - Episode {number} - {title}", series_name="100%"
    )
    template = output_template(out_dir, episode, options)
    params = YtDlpDownloader().build_options(episode, options, template)
    info = {
        "id": episode.item_id,
        "title": "t",
        "ext": "mp4",
        "cookies": "sessionid=SECRET_SESSION_VALUE; Domain=.tiktok.com",
    }
    with yt_dlp.YoutubeDL(params) as ydl:
        actual = ydl.prepare_filename(info)
    assert actual == str(out_dir / (episode_stem(episode, options) + ".mp4"))
    assert actual.rsplit("/", 1)[1].startswith("100% - Episode 01 - ")
    assert "SECRET_SESSION_VALUE" not in actual
    assert episode.item_id not in actual.rsplit("/", 1)[1]  # `%(id)s` in a title is not expanded


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
        ("Unable to download webpage: HTTP Error 429", DownloadStatus.FAILED_RATE_LIMITED),
        ("rate limit exceeded", DownloadStatus.FAILED_RATE_LIMITED),
        # "429" inside a video id is not a status code: ~1.6 % of TikTok ids contain it
        (
            "ERROR: [TikTok] 7429384756102938475: Video not available",
            DownloadStatus.FAILED_UNAVAILABLE,
        ),
        (
            "ERROR: [TikTok] 7312000000000429001: Unable to extract video data",
            DownloadStatus.FAILED,
        ),
        ("ERROR: [TikTok] 123: No video formats found!", DownloadStatus.FAILED_UNAVAILABLE),
        ("This video is not available", DownloadStatus.FAILED_UNAVAILABLE),
        ("Video is private", DownloadStatus.FAILED_UNAVAILABLE),
        ("The video has been removed", DownloadStatus.FAILED_UNAVAILABLE),
        ("This content is geo-restricted", DownloadStatus.FAILED_UNAVAILABLE),
        ("not available in your country", DownloadStatus.FAILED_UNAVAILABLE),
        # HTTP 403 is TikTok's protection saying no: its own status, and the run stops
        ("Unable to download webpage: HTTP Error 403: Forbidden", DownloadStatus.FAILED_BLOCKED),
        ("ERROR: [TikTok] 7699400000000000003: HTTP Error 403", DownloadStatus.FAILED_BLOCKED),
        ("HTTP Error 403: Forbidden", DownloadStatus.FAILED_BLOCKED),
        ("403 Forbidden", DownloadStatus.FAILED_BLOCKED),
        ("Forbidden", DownloadStatus.FAILED_BLOCKED),
        ("Access Denied", DownloadStatus.FAILED_BLOCKED),
        ("<h1>access denied</h1> you don't have permission", DownloadStatus.FAILED_BLOCKED),
        # login wording wins over a 403, and a 429 wins over "forbidden"
        ("HTTP Error 403: Forbidden; log in to continue", DownloadStatus.FAILED_LOGIN),
        ("HTTP Error 429: Too Many Requests (forbidden)", DownloadStatus.FAILED_RATE_LIMITED),
        # "403" inside a video id, or without the HTTP wording, is not a block
        (
            "ERROR: [TikTok] 7403000000000000001: Video not available",
            DownloadStatus.FAILED_UNAVAILABLE,
        ),
        ("ERROR: [TikTok] 7312000000000403001: Unable to extract", DownloadStatus.FAILED),
        ("Permission denied: '/downloads/Heiress - Episode 03.mp4'", DownloadStatus.FAILED),
        ("", DownloadStatus.FAILED),
    ],
)
def test_classify_error(message, status):
    assert YtDlpDownloader.classify_error(message) is status


def test_describe_failure_prefixes_blocked_results_only():
    assert BLOCKED_MESSAGE == (
        "blocked (HTTP 403): TikTok refused the request; wait 30-60 minutes before trying again"
    )
    text = "HTTP Error 403: Forbidden"
    assert describe_failure(DownloadStatus.FAILED_BLOCKED, text) == f"{BLOCKED_MESSAGE}: {text}"
    assert describe_failure(DownloadStatus.FAILED_BLOCKED, "") == BLOCKED_MESSAGE
    for status in (
        DownloadStatus.FAILED,
        DownloadStatus.FAILED_LOGIN,
        DownloadStatus.FAILED_RATE_LIMITED,
        DownloadStatus.FAILED_UNAVAILABLE,
    ):
        assert describe_failure(status, text) == text


def test_a_403_from_yt_dlp_is_a_blocked_result_with_advice(tmp_path):
    from yt_dlp.utils import DownloadError

    factory, log = make_factory(
        error=DownloadError("ERROR: Unable to download webpage: HTTP Error 403: Forbidden")
    )
    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert result.status is DownloadStatus.FAILED_BLOCKED
    assert result.status.ok is False
    assert result.message.startswith("blocked (HTTP 403): TikTok refused the request; wait 30-60")
    assert result.message.endswith(": ERROR: Unable to download webpage: HTTP Error 403: Forbidden")
    assert result.path is None
    assert len(log) == 1  # one attempt; the engine stops the run, nothing here retries


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


def test_malformed_cookies_file_is_refused_before_yt_dlp_runs(tmp_path):
    """yt-dlp would skip the bad line with a WARNING quoting it whole (value included), which
    `quiet`/`no_warnings` do not silence; DramaFetch names the line number only and never starts."""
    cookies = tmp_path / "cookies.txt"
    cookies.write_text(
        "# Netscape HTTP Cookie File\n"
        ".tiktok.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tSECRET_SESSION_1\n"
        ".tiktok.com\tTRUE\t/\tTRUE\t1893456000\tttwid\tSECRET_TTWID_789\textra_field\n",
        encoding="utf-8",
    )
    factory, log = make_factory()
    result = YtDlpDownloader(factory).download(
        EPISODE, DownloadOptions(out_dir=tmp_path, cookies_file=cookies)
    )
    assert result.status is DownloadStatus.FAILED
    assert "line 3: 8 fields (expected 7)" in result.message
    assert "SECRET" not in result.message and "extra_field" not in result.message
    assert log == []  # yt-dlp was never constructed
    assert cookies_file_problem(cookies) == result.message

    cookies.write_text(
        "# Netscape HTTP Cookie File\n"
        "#HttpOnly_.tiktok.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tSECRET_SESSION_1\n",
        encoding="utf-8",
    )
    assert cookies_file_problem(cookies) is None
    assert cookies_file_problem(None) is None
    assert cookies_file_problem(tmp_path / "missing.txt") is None  # left to yt-dlp's own error
    result = YtDlpDownloader(factory).download(
        EPISODE, DownloadOptions(out_dir=tmp_path, cookies_file=cookies)
    )
    assert result.status is DownloadStatus.DONE
    assert log[0]["params"]["cookiefile"] == str(cookies)


def test_sanitize_error_keeps_harmless_mentions_of_cookies():
    text = "No video formats found; try passing cookies with --cookies"
    assert sanitize_error(text) == text
    assert sanitize_error("   \n\n  ") == "unknown error"
    assert sanitize_error("sid_tt: abc123; done") == "sid_tt=<redacted>; done"


def test_redact_secrets_covers_every_line_and_url_query_strings():
    """Playwright quotes the whole failed request below the first line of its message — the signed
    URL and the cookie header — so the redaction runs over all of it, not only the kept line."""
    text = (
        "APIRequestContext.get: Timeout 120000ms exceeded.\n"
        "Call log:\n"
        "  - → GET https://v16-webapp-prime.tiktok.com/video/tos/x/?expire=1&signature=SIGTOKEN"
        "&tk=tt_chain_token\n"
        "    - Referer: https://www.tiktok.com/\n"
        "    - cookie: sessionid=SECRETSESSION\n"
    )
    redacted = redact_secrets(text)
    assert "SIGTOKEN" not in redacted and "SECRETSESSION" not in redacted
    assert "GET https://v16-webapp-prime.tiktok.com/video/tos/x/\n" in redacted
    assert "Referer: https://www.tiktok.com/\n" in redacted  # a plain URL is left alone
    assert "cookie=<redacted>" in redacted
    assert sanitize_error(text) == "APIRequestContext.get: Timeout 120000ms exceeded."
    assert sanitize_error("\n   \n sid_guard: abc; sessionid=def\n") == (
        "sid_guard=<redacted>; sessionid=<redacted>"
    )


# --------------------------------------------------------------------------- helpers


def test_partial_detection_and_newest_existing_file(tmp_path):
    assert is_partial_file("Heiress - Episode 01.mp4.part")
    assert is_partial_file("Heiress - Episode 01.mp4.ytdl")
    assert is_partial_file("Heiress - Episode 01.mp4.part-Frag3")
    assert not is_partial_file("Heiress - Episode 01.mp4")
    assert existing_episode_file(tmp_path / "missing", EPISODE, OPTIONS) is None
    assert existing_episode_file(tmp_path, EPISODE, OPTIONS) is None
    older = tmp_path / f"{STEM}.webm"
    older.write_bytes(b"1")
    import os

    os.utime(older, (1_000_000, 1_000_000))
    newer = tmp_path / f"{STEM}.mp4"
    newer.write_bytes(b"2")
    (tmp_path / f"{STEM}x.mp4").write_bytes(b"other stem")  # prefix without the dot: not ours
    (tmp_path / f"{STEM}.mp4.part").write_bytes(b"partial")
    assert existing_episode_file(tmp_path, EPISODE, OPTIONS) == newer
    # the stem follows the name format of the run
    custom = DownloadOptions(name_format="{n} {title}")
    assert existing_episode_file(tmp_path, EPISODE, custom) is None
    (tmp_path / "3 Heiress Episode 3.mkv").write_bytes(b"3")
    assert existing_episode_file(tmp_path, EPISODE, custom) == tmp_path / "3 Heiress Episode 3.mkv"


def test_existing_episode_file_never_mistakes_a_thumbnail_for_the_video(tmp_path):
    """A cover sidecar is `<stem>.jpg`: alone it means the video is still missing (so the episode
    is downloaded, not skipped); next to the video, the video is what is found."""
    assert sorted(VIDEO_SUFFIXES) == [".m4v", ".mkv", ".mov", ".mp4", ".webm"]
    for sidecar in (".jpg", ".jpeg", ".png", ".webp", ".image", ".json", ".description"):
        (tmp_path / f"{STEM}{sidecar}").write_bytes(b"not a video")
    assert existing_episode_file(tmp_path, EPISODE, OPTIONS) is None
    video = tmp_path / f"{STEM}.mp4"
    video.write_bytes(b"video")
    assert existing_episode_file(tmp_path, EPISODE, OPTIONS) == video
    video.unlink()
    upper = tmp_path / f"{STEM}.MP4"  # extensions are matched case-insensitively
    upper.write_bytes(b"video")
    assert existing_episode_file(tmp_path, EPISODE, OPTIONS) == upper
    for suffix in sorted(VIDEO_SUFFIXES):
        assert is_partial_file(f"{STEM}{suffix}.part")


def test_a_lone_thumbnail_does_not_skip_the_download(tmp_path):
    (tmp_path / f"{STEM}.jpg").write_bytes(b"cover")
    factory, log = make_factory()
    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert result.status is DownloadStatus.DONE
    assert result.path == tmp_path / f"{STEM}.mp4"
    assert len(log) == 1


def test_existing_episode_file_matches_the_whole_stem_not_a_prefix(tmp_path):
    """`{title}` tells episodes apart by title, and one title may extend another after a dot:
    `Ep 1` must not be reported as existing (and so never downloaded) because another episode's
    `Ep 1.5.mp4` is there. Only the last suffix is the extension, so a dotted series name still
    finds its own file, and yt-dlp's per-format intermediates (`<stem>.f123.mp4`) are no video."""
    by_title = DownloadOptions(name_format="{title}")
    first = Episode(number=1, item_id="7699400000000000001", title="Ep 1", series_id=SERIES_ID)
    (tmp_path / "Ep 1.5.mp4").write_bytes(b"video")
    assert episode_stem(first, by_title) == "Ep 1"
    assert existing_episode_file(tmp_path, first, by_title) is None
    (tmp_path / "Ep 1.mp4").write_bytes(b"video")
    assert existing_episode_file(tmp_path, first, by_title) == tmp_path / "Ep 1.mp4"
    finale = Episode(number=2, item_id="7699400000000000002", title="Finale", series_id=SERIES_ID)
    (tmp_path / "Finale.Part 2.mp4").write_bytes(b"video")
    assert existing_episode_file(tmp_path, finale, by_title) is None
    dotted = tmp_path / "Dr. Who v1.2 - Episode 03.mp4"
    dotted.write_bytes(b"video")
    dotted_options = DownloadOptions(series_name="Dr. Who v1.2")
    assert existing_episode_file(tmp_path, EPISODE, dotted_options) == dotted
    (tmp_path / f"{STEM}.f123.mp4").write_bytes(b"video")
    assert existing_episode_file(tmp_path, EPISODE, OPTIONS) is None


# --------------------------------------------------------------------------- the cover

FIXTURE = Path(__file__).parent / "fixtures" / "tiny.mp4"
TINY_MP4 = FIXTURE.read_bytes()  # 3 s, 160x120 H.264 + silent AAC: what mutagen can tag
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"j" * 600 + b"\xff\xd9"
PNG = b"\x89PNG\r\n\x1a\n" + b"p" * 600
WEBP = b"RIFF\x00\x10\x00\x00WEBPVP8 " + b"w" * 600


def _download(tmp_path, mode="embed", *, video_bytes=TINY_MP4, sidecar=(".jpeg", JPEG)):
    """One DONE download through the fake ydl, which writes the video and — unless `sidecar` is
    None — the `<stem>.<ext>` cover yt-dlp's `writethumbnail` would have written next to it."""
    factory, log = make_factory(video_bytes=video_bytes, sidecar=sidecar)
    result = YtDlpDownloader(factory).download(
        EPISODE, DownloadOptions(out_dir=tmp_path, thumbnail=mode)
    )
    assert result.status is DownloadStatus.DONE
    assert result.path == tmp_path / f"{STEM}.mp4"
    return result, log


def _names(directory):
    return sorted(p.name for p in directory.iterdir())


def test_embed_is_the_default_the_cover_goes_into_the_mp4_and_the_sidecar_goes(tmp_path):
    result, log = _download(tmp_path)
    assert log[0]["params"]["writethumbnail"] is True
    assert result.message == f"saved {STEM}.mp4 + cover embedded"
    assert _names(tmp_path) == [f"{STEM}.mp4"]  # no .jpeg left, no .embed.part
    assert extract_cover(result.path) == (JPEG, "image/jpeg")
    assert abs(MP4(result.path).info.length - 3.0) < 0.2  # still the 3-second video


def test_both_embeds_the_cover_and_keeps_the_file(tmp_path):
    result, _ = _download(tmp_path, "both")
    assert result.message == f"saved {STEM}.mp4 + cover embedded + file"
    assert _names(tmp_path) == [f"{STEM}.jpeg", f"{STEM}.mp4"]
    assert (tmp_path / f"{STEM}.jpeg").read_bytes() == JPEG
    assert extract_cover(result.path) == (JPEG, "image/jpeg")


def test_file_keeps_the_sidecar_and_leaves_the_video_as_yt_dlp_wrote_it(tmp_path):
    result, _ = _download(tmp_path, "file")
    assert result.message == f"saved {STEM}.mp4 + cover file"
    assert _names(tmp_path) == [f"{STEM}.jpeg", f"{STEM}.mp4"]
    assert result.path.read_bytes() == TINY_MP4
    assert extract_cover(result.path) is None


def test_none_asks_yt_dlp_for_no_cover_and_leaves_a_stale_sidecar_alone(tmp_path):
    (tmp_path / f"{STEM}.jpeg").write_bytes(JPEG)  # from an earlier run
    result, log = _download(tmp_path, "none", sidecar=None)
    assert "writethumbnail" not in log[0]["params"]
    assert result.message == f"saved {STEM}.mp4"
    assert _names(tmp_path) == [f"{STEM}.jpeg", f"{STEM}.mp4"]
    assert result.path.read_bytes() == TINY_MP4


def test_a_png_cover_is_embedded_as_png(tmp_path):
    result, _ = _download(tmp_path, sidecar=(".png", PNG))
    assert result.message == f"saved {STEM}.mp4 + cover embedded"
    assert extract_cover(result.path) == (PNG, "image/png")
    assert _names(tmp_path) == [f"{STEM}.mp4"]


@pytest.mark.parametrize("mode", ["embed", "both"])
def test_a_webp_cover_cannot_be_embedded_and_is_kept_as_a_file(tmp_path, mode):
    result, _ = _download(tmp_path, mode, sidecar=(".webp", WEBP))
    assert result.message == f"saved {STEM}.mp4; cover: webp cannot be embedded; file kept"
    assert _names(tmp_path) == [f"{STEM}.mp4", f"{STEM}.webp"]
    assert result.path.read_bytes() == TINY_MP4


def test_yt_dlps_image_extension_is_renamed_after_the_bytes(tmp_path):
    """A `dynamicCover` URL ends in `.image` (TikTok's own extension), so yt-dlp lands the cover
    as `<stem>.image`; the bytes say what it is, so it is renamed first — and then embedded, kept
    or both like any other cover."""
    both, _ = _download(tmp_path, "both", sidecar=(".image", JPEG))
    assert both.message == f"saved {STEM}.mp4 + cover embedded + file"
    assert _names(tmp_path) == [f"{STEM}.jpg", f"{STEM}.mp4"]
    embed_only, _ = _download(tmp_path / "e", "embed", sidecar=(".image", PNG))
    assert embed_only.message == f"saved {STEM}.mp4 + cover embedded"
    assert _names(tmp_path / "e") == [f"{STEM}.mp4"]
    assert extract_cover(embed_only.path) == (PNG, "image/png")
    kept, _ = _download(tmp_path / "f", "file", sidecar=(".image", WEBP))
    assert kept.message == f"saved {STEM}.mp4 + cover file"
    assert _names(tmp_path / "f") == [f"{STEM}.mp4", f"{STEM}.webp"]


def test_a_failed_embed_keeps_the_file_and_the_video_byte_for_byte(tmp_path):
    """yt-dlp produced something mutagen cannot tag: the cover stays a file, whatever the mode,
    and nothing is half done — no `.embed.part`, the video exactly as yt-dlp wrote it."""
    junk = b"\x00\x00\x00\x18ftypmp42" + b"v" * 4000
    for mode in ("embed", "both"):
        directory = tmp_path / mode
        result, _ = _download(directory, mode, video_bytes=junk)
        assert result.message.startswith(
            f"saved {STEM}.mp4; cover: could not embed (could not write the cover into "
            f"{STEM}.mp4 (MP4StreamInfoError: "
        )
        assert result.message.endswith(")); file kept")
        assert _names(directory) == [f"{STEM}.jpeg", f"{STEM}.mp4"]
        assert result.path.read_bytes() == junk


def test_a_directory_in_the_way_of_the_working_copy_is_reported_never_raised(tmp_path):
    """`download` never raises: a directory named `<video>.embed.part` in the series directory is
    a `ThumbnailError` the engine turns into the message, with no stray copy of the video in it."""
    in_the_way = tmp_path / f"{STEM}.mp4{EMBED_SUFFIX}"
    in_the_way.mkdir()
    result, _ = _download(tmp_path)
    assert result.message == (
        f"saved {STEM}.mp4; cover: could not embed ({in_the_way.name} is a directory in the way "
        "of the working copy); file kept"
    )
    assert _names(tmp_path) == [f"{STEM}.jpeg", f"{STEM}.mp4", in_the_way.name]
    assert list(in_the_way.iterdir()) == [] and result.path.read_bytes() == TINY_MP4


def test_without_mutagen_the_cover_stays_a_file_and_the_message_says_how_to_install_it(
    tmp_path, monkeypatch
):
    monkeypatch.setitem(sys.modules, "mutagen.mp4", None)
    result, _ = _download(tmp_path)
    assert result.message == (
        f"saved {STEM}.mp4; cover: could not embed (mutagen is not installed: pip install "
        "mutagen); file kept"
    )
    assert _names(tmp_path) == [f"{STEM}.jpeg", f"{STEM}.mp4"]
    assert result.path.read_bytes() == TINY_MP4


def test_an_oversize_sidecar_is_deleted_not_kept(tmp_path):
    huge = b"\xff\xd8\xff" + b"\0" * MAX_COVER_BYTES  # three bytes over the limit
    result, _ = _download(tmp_path, sidecar=(".jpeg", huge))
    assert result.message == f"saved {STEM}.mp4; cover: too large, not kept"
    assert _names(tmp_path) == [f"{STEM}.mp4"]
    assert result.path.read_bytes() == TINY_MP4


def test_a_sidecar_that_is_not_an_image_is_kept_but_never_embedded(tmp_path):
    result, _ = _download(tmp_path, sidecar=(".jpeg", b"<html>access denied</html>" * 20))
    assert result.message == f"saved {STEM}.mp4; cover: not a JPEG, PNG or WEBP image; file kept"
    assert _names(tmp_path) == [f"{STEM}.jpeg", f"{STEM}.mp4"]
    assert result.path.read_bytes() == TINY_MP4


@pytest.mark.parametrize("mode", ["embed", "both", "file"])
def test_no_sidecar_means_the_cover_was_not_available(tmp_path, mode):
    result, log = _download(tmp_path, mode, sidecar=None)
    assert log[0]["params"]["writethumbnail"] is True
    assert result.message == f"saved {STEM}.mp4; cover: not available"
    assert _names(tmp_path) == [f"{STEM}.mp4"]


def test_the_embed_goes_through_a_copy_that_replaces_the_video(tmp_path, monkeypatch):
    replaced = []
    original = Path.replace

    def recording(self, target):
        replaced.append((Path(self).name, Path(target).name))
        return original(self, target)

    monkeypatch.setattr(Path, "replace", recording)
    _download(tmp_path)
    assert replaced == [(f"{STEM}.mp4.embed.part", f"{STEM}.mp4")]
