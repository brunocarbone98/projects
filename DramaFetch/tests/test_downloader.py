"""downloader: yt-dlp params, the no-network paths, success, every error classification, and DRM
(an encrypted file deleted, yt-dlp's "DRM protected", the payload's DRM flag)."""

from __future__ import annotations

import errno
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from mutagen.mp4 import MP4

from dramafetch import media as media_module
from dramafetch.downloader import (
    BEST_FORMAT,
    BLOCKED_MESSAGE,
    COMPATIBLE_FORMAT,
    H264_FORMAT,
    MAX_RETRIES,
    PAYLOAD_DRM_MESSAGE,
    VIDEO_SUFFIXES,
    YtDlpDownloader,
    cookies_file_problem,
    curl_cffi_available,
    describe_failure,
    existing_episode_file,
    format_for,
    impersonate_target,
    is_partial_file,
    locked_result,
    mentions_drm,
    output_template,
    redact_secrets,
    sanitize_error,
)
from dramafetch.manifest import episode_stem
from dramafetch.media import INCOMPLETE_PREFIX
from dramafetch.models import DRM_MARK, DRM_MESSAGE, DownloadOptions, DownloadStatus, Episode
from dramafetch.thumbnails import EMBED_SUFFIX, MAX_COVER_BYTES, extract_cover
from encrypted_mp4 import (
    encrypted_mp4,
    with_drm_words_in_mdat,
    with_moov_pssh,
    with_top_level_pssh,
)

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
FIXTURE = Path(__file__).parent / "fixtures" / "tiny.mp4"
# 3 s of 160x120 H.264 + silent AAC: a real MP4 (mutagen tags it, the verification accepts it),
# what the fake yt-dlp writes unless a test says otherwise. EPISODE has no duration, so only the
# container checks apply to it.
TINY_MP4 = FIXTURE.read_bytes()


class FakeYdl:
    """Stands in for yt_dlp.YoutubeDL: records params and URLs, creates a file (the real 3-second
    fixture by default) or raises. With `sidecar=(".jpeg", bytes)` it also writes the cover
    `writethumbnail` would have written next to the video (named after the cover URL's extension,
    as yt-dlp does)."""

    def __init__(
        self,
        params,
        log,
        *,
        produce=".mp4",
        error=None,
        retcode=0,
        video_bytes=TINY_MP4,
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
    # the default quality, "compatible": the highest-bitrate H.264, then anything
    assert params["format"] == COMPATIBLE_FORMAT == "best[vcodec^=h264]/best[vcodec=avc1]/best"
    assert H264_FORMAT == COMPATIBLE_FORMAT  # the former name
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


def test_build_options_minimal_with_best_quality_and_without_cookies():
    options = DownloadOptions(quality="best", impersonate=False, thumbnail="none")
    params = YtDlpDownloader(lambda p: None).build_options(EPISODE, options, "o.%(ext)s")
    assert params["format"] == BEST_FORMAT == "best"  # the highest bitrate whatever the codec
    assert format_for("compatible") == COMPATIBLE_FORMAT and format_for("best") == BEST_FORMAT
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
    assert result.path.read_bytes() == TINY_MP4
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

JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"j" * 600 + b"\xff\xd9"
PNG = b"\x89PNG\r\n\x1a\n" + b"p" * 600
WEBP = b"RIFF\x00\x10\x00\x00WEBPVP8 " + b"w" * 600


def _download(
    tmp_path, mode="embed", *, video_bytes=TINY_MP4, sidecar=(".jpeg", JPEG), verify=True
):
    """One DONE download through the fake ydl, which writes the video and — unless `sidecar` is
    None — the `<stem>.<ext>` cover yt-dlp's `writethumbnail` would have written next to it.
    `verify=False` is `--no-verify`: the only way a file that is not an MP4 reaches the cover step
    (with the check on it is quarantined first, see the integrity tests)."""
    factory, log = make_factory(video_bytes=video_bytes, sidecar=sidecar)
    result = YtDlpDownloader(factory).download(
        EPISODE, DownloadOptions(out_dir=tmp_path, thumbnail=mode, verify=verify)
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
    """yt-dlp produced something mutagen cannot tag and the verification is off (`--no-verify`;
    with it on the file never reaches the cover step: it is quarantined, see below): the cover
    stays a file, whatever the mode, and nothing is half done — no `.embed.part`, the video
    exactly as yt-dlp wrote it."""
    junk = b"\x00\x00\x00\x18ftypmp42" + b"v" * 4000
    for mode in ("embed", "both"):
        directory = tmp_path / mode
        result, _ = _download(directory, mode, video_bytes=junk, verify=False)
        assert result.message.startswith(
            f"saved {STEM}.mp4; cover: could not embed (could not write the cover into "
            f"{STEM}.mp4 (MP4StreamInfoError: "
        )
        assert result.message.endswith(")); file kept")
        assert _names(directory) == [f"{STEM}.jpeg", f"{STEM}.mp4"]
        assert result.path.read_bytes() == junk


# --------------------------------------------------------------------------- integrity


def test_a_file_that_fails_the_verification_is_quarantined_with_its_cover_deleted(tmp_path):
    """The default: the produced file is verified BEFORE the cover step. One that is not an MP4 is
    renamed `<stem> (incomplete).mp4`, the `.jpeg` yt-dlp wrote is deleted (no cover for a bad
    download, nothing embedded), the episode is FAILED with the reason — and a rerun tries again,
    quarantining a second bad file under the next free name."""
    junk = b"\x00\x00\x00\x18ftypmp42" + b"v" * 4000
    factory, log = make_factory(video_bytes=junk, sidecar=(".jpeg", JPEG))
    options = DownloadOptions(out_dir=tmp_path)
    result = YtDlpDownloader(factory).download(EPISODE, options)
    assert result.status is DownloadStatus.FAILED and result.path is None
    assert result.message.startswith(f"{INCOMPLETE_PREFIX}not a valid MP4 (")
    assert result.message.endswith(f") (kept as {STEM} (incomplete).mp4)")
    assert _names(tmp_path) == [f"{STEM} (incomplete).mp4"]
    assert (tmp_path / f"{STEM} (incomplete).mp4").read_bytes() == junk
    assert existing_episode_file(tmp_path, EPISODE, options) is None  # a rerun downloads again
    again = YtDlpDownloader(factory).download(EPISODE, options)
    assert again.status is DownloadStatus.FAILED and len(log) == 2
    assert again.message.endswith(f"(kept as {STEM} (incomplete 2).mp4)")
    assert _names(tmp_path) == [f"{STEM} (incomplete 2).mp4", f"{STEM} (incomplete).mp4"]


def test_a_short_video_fails_the_duration_check_unless_verification_is_off(tmp_path):
    """The list said 120 s, the file lasts 3 s: what a locked episode's preview looks like."""
    long_episode = replace(EPISODE, duration_s=120)
    factory, log = make_factory(sidecar=None)
    result = YtDlpDownloader(factory).download(
        long_episode, DownloadOptions(out_dir=tmp_path, thumbnail="none")
    )
    assert result.status is DownloadStatus.FAILED
    assert result.message == (
        f"{INCOMPLETE_PREFIX}duration 3 s, expected 120 s (kept as {STEM} (incomplete).mp4)"
    )
    assert _names(tmp_path) == [f"{STEM} (incomplete).mp4"]
    # about the right length, or no length known (``dramafetch video``): fine
    episodes = (replace(EPISODE, duration_s=3), replace(EPISODE, duration_s=5), EPISODE)
    for index, episode in enumerate(episodes):
        ok = YtDlpDownloader(factory).download(
            episode, DownloadOptions(out_dir=tmp_path / str(index), thumbnail="none")
        )
        assert ok.status is DownloadStatus.DONE and ok.message == f"saved {STEM}.mp4"
    # --no-verify: the same short file is accepted as it is (a debugging aid)
    off = YtDlpDownloader(factory).download(
        long_episode, DownloadOptions(out_dir=tmp_path / "off", thumbnail="none", verify=False)
    )
    assert off.status is DownloadStatus.DONE and off.message == f"saved {STEM}.mp4"
    assert len(log) == 5


def test_a_bad_file_the_os_will_not_rename_is_deleted_so_that_a_rerun_tries_again(
    tmp_path, monkeypatch
):
    """A rename refused for good (on Windows, a file an antivirus still holds) must not leave the
    bad file under the episode's name: `existing_episode_file` would take it for the episode and
    the next run would skip it as done. It is deleted instead — the one case in which a download
    is deleted —, the message says so, and the rerun downloads the episode again."""

    def refuse(path, **_):
        raise OSError(errno.EACCES, "Permission denied", str(path))

    monkeypatch.setattr(media_module, "quarantine", refuse)
    factory, log = make_factory(sidecar=None)
    options = DownloadOptions(out_dir=tmp_path, thumbnail="none")
    result = YtDlpDownloader(factory).download(replace(EPISODE, duration_s=120), options)
    assert result.status is DownloadStatus.FAILED and result.path is None
    assert result.message == (
        f"{INCOMPLETE_PREFIX}duration 3 s, expected 120 s (could not rename {STEM}.mp4: "
        "Permission denied; deleted, so that it does not pass for the episode)"
    )
    assert _names(tmp_path) == []
    again = YtDlpDownloader(factory).download(replace(EPISODE, duration_s=120), options)
    assert again.status is DownloadStatus.FAILED and len(log) == 2  # tried again, not skipped


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


# --------------------------------------------------------------------------- DRM

#: `encv` + `enca` sample entries and a top-level `pssh`: what an encrypted episode declares.
ENCRYPTED = encrypted_mp4()


def test_build_options_never_allows_unplayable_formats(tmp_path):
    """yt-dlp drops the formats it knows to be DRM-protected unless `allow_unplayable_formats` is
    set; DramaFetch never sets it, whatever the options — every thumbnail mode, both qualities,
    include_locked, cookies, overwrite, extractor args, --no-verify."""
    downloader = YtDlpDownloader(lambda p: None)
    variants = [
        DownloadOptions(),
        DownloadOptions(include_locked=True, quality="best", verify=False, overwrite=True),
        DownloadOptions(
            cookies_file=tmp_path / "cookies.txt",
            cookies_from_browser="chrome",
            extractor_args={"tiktok": {"api_hostname": ["api22-normal-c-useast2a.tiktokv.com"]}},
            impersonate=False,
        ),
        *(DownloadOptions(thumbnail=mode) for mode in ("embed", "both", "file", "none")),
    ]
    for options in variants:
        params = downloader.build_options(EPISODE, options, "o.%(ext)s")
        assert "allow_unplayable_formats" not in params
        assert [key for key in params if "unplayable" in key or "drm" in key.lower()] == []


@pytest.mark.parametrize(
    "message",
    [
        "ERROR: [TikTok] 7699400000000000003: This video is DRM protected",
        "This video is DRM protected",
        "drm-protected stream",
        # DRM comes before the "unavailable" family: the DRM message goes first either way
        "ERROR: [TikTok] 123: This video is DRM protected and not available",
        "No video formats found! (DRM)",
    ],
)
def test_drm_wordings_are_unavailable_with_the_drm_message_first(message):
    assert mentions_drm(message)
    assert YtDlpDownloader.classify_error(message) is DownloadStatus.FAILED_UNAVAILABLE
    described = describe_failure(DownloadStatus.FAILED_UNAVAILABLE, message)
    assert described == f"{DRM_MESSAGE}: {message}"
    assert described.startswith(DRM_MESSAGE)  # how the manifest remembers a DRM verdict


@pytest.mark.parametrize(
    ("message", "status"),
    [
        # the anti-bot rules come first: a refusal that also names DRM stops the run (and a 403 /
        # 429 starts the cooldown) instead of passing for a DRM verdict
        ("HTTP Error 403: Forbidden (DRM protected?)", DownloadStatus.FAILED_BLOCKED),
        ("HTTP Error 403: Forbidden (DRM)", DownloadStatus.FAILED_BLOCKED),
        ("Access Denied: DRM license server", DownloadStatus.FAILED_BLOCKED),
        ("HTTP Error 429: Too Many Requests (drm)", DownloadStatus.FAILED_RATE_LIMITED),
        ("HTTP Error 429 while fetching the DRM license", DownloadStatus.FAILED_RATE_LIMITED),
        ("rate limit exceeded on the DRM endpoint", DownloadStatus.FAILED_RATE_LIMITED),
        (
            "ERROR: [TikTok] 123: This video is DRM protected; log in for more",
            DownloadStatus.FAILED_LOGIN,
        ),
        # the order among the refusals is unchanged: login, then 429, then 403
        ("HTTP Error 403: Forbidden; DRM; log in to continue", DownloadStatus.FAILED_LOGIN),
        ("HTTP Error 429 (forbidden, drm)", DownloadStatus.FAILED_RATE_LIMITED),
    ],
)
def test_a_refusal_wins_over_drm_wording(message, status):
    assert mentions_drm(message)
    assert YtDlpDownloader.classify_error(message) is status
    described = describe_failure(status, message)
    assert not described.startswith(DRM_MARK)  # never stored, nor remembered, as a DRM verdict
    if status is DownloadStatus.FAILED_BLOCKED:
        assert described == f"{BLOCKED_MESSAGE}: {message}"
    else:
        assert described == message


def test_a_403_from_yt_dlp_that_names_drm_is_blocked_with_advice(tmp_path):
    from yt_dlp.utils import DownloadError

    error = "ERROR: [TikTok] 7699400000000000003: HTTP Error 403: Forbidden (DRM protected?)"
    factory, log = make_factory(error=DownloadError(error))
    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert result.status is DownloadStatus.FAILED_BLOCKED and result.path is None
    assert result.message == f"{BLOCKED_MESSAGE}: {error}"
    assert len(log) == 1  # one attempt; the engine stops the run and records the cooldown


def test_the_letters_drm_inside_a_word_or_an_id_are_not_drm():
    for message in (
        "ERROR: [TikTok] 123: Unable to extract; hydrmetric",
        "eDRMs",
        "ERROR: [TikTok] 7699400000000000003: Video not available",
    ):
        assert not mentions_drm(message)
    assert YtDlpDownloader.classify_error("Unable to extract; hydrmetric") is DownloadStatus.FAILED
    # an unavailable failure that does not name DRM keeps yt-dlp's own words
    text = "ERROR: [TikTok] 123: No video formats found!"
    assert describe_failure(DownloadStatus.FAILED_UNAVAILABLE, text) == text


def test_yt_dlps_drm_error_is_unavailable_with_the_drm_message(tmp_path):
    from yt_dlp.utils import DownloadError

    error = "ERROR: [TikTok] 7699400000000000003: This video is DRM protected"
    factory, log = make_factory(error=DownloadError(error))
    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert result.status is DownloadStatus.FAILED_UNAVAILABLE and result.path is None
    assert result.message == f"{DRM_MESSAGE}: {error}"
    assert len(log) == 1  # one attempt; nothing here retries
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("verify", [True, False], ids=["verify", "no-verify"])
def test_an_encrypted_file_is_deleted_with_its_cover_and_partials_whatever_verify_says(
    tmp_path, monkeypatch, verify
):
    """The DRM check runs right after yt-dlp returns — before the verification and the cover
    step, and whatever `--no-verify` says: the encrypted video, the cover yt-dlp wrote next to it
    and the in-progress files of that video are deleted (not quarantined: no rerun makes it
    play), nothing is embedded, and the episode is FAILED_UNAVAILABLE with the DRM message.
    Other files in the series directory stay, even this episode's earlier `(incomplete)` one."""
    import dramafetch.downloader as downloader_module

    def no_embedding(video, image):
        raise AssertionError("an encrypted file must never reach the cover step")

    monkeypatch.setattr(downloader_module, "embed_cover", no_embedding)
    (tmp_path / f"{STEM}.mp4.part").write_bytes(b"left by an earlier attempt")
    (tmp_path / f"{STEM}.mp4.part-Frag2").write_bytes(b"a fragment")
    neighbours = [
        "Heiress - Episode 04.mp4",
        "Heiress - Episode 04.mp4.part",
        "Heiress - Episode 04.jpeg",
        f"{STEM} (incomplete).mp4",
    ]
    for name in neighbours:
        (tmp_path / name).write_bytes(b"another file")
    factory, log = make_factory(video_bytes=ENCRYPTED, sidecar=(".jpeg", JPEG))
    options = DownloadOptions(out_dir=tmp_path, verify=verify)

    result = YtDlpDownloader(factory).download(EPISODE, options)

    assert result.status is DownloadStatus.FAILED_UNAVAILABLE and result.path is None
    assert result.message == DRM_MESSAGE
    assert _names(tmp_path) == sorted(neighbours)
    assert len(log) == 1
    assert existing_episode_file(tmp_path, EPISODE, options) is None


def test_drm_comes_before_the_integrity_check_so_nothing_encrypted_is_ever_quarantined(tmp_path):
    """An encrypted file that would ALSO fail the verification (120 s announced, 3 s served) is
    deleted as encrypted — never kept as `(incomplete)`: a quarantined file stays on disk."""
    factory, _ = make_factory(video_bytes=ENCRYPTED, sidecar=None)
    result = YtDlpDownloader(factory).download(
        replace(EPISODE, duration_s=120), DownloadOptions(out_dir=tmp_path, thumbnail="none")
    )
    assert (result.status, result.message) == (DownloadStatus.FAILED_UNAVAILABLE, DRM_MESSAGE)
    assert _names(tmp_path) == []


@pytest.mark.parametrize(
    "video_bytes",
    [
        pytest.param(encrypted_mp4(audio=False, pssh=False), id="encv"),
        pytest.param(encrypted_mp4(video=False, pssh=False), id="enca"),
        pytest.param(with_top_level_pssh(), id="top-level-pssh"),
        pytest.param(with_moov_pssh(), id="pssh-in-moov"),
    ],
)
def test_every_declared_encryption_is_refused(tmp_path, video_bytes):
    factory, _ = make_factory(video_bytes=video_bytes, sidecar=(".jpeg", JPEG))
    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert (result.status, result.message) == (DownloadStatus.FAILED_UNAVAILABLE, DRM_MESSAGE)
    assert _names(tmp_path) == []


def test_drm_words_inside_the_samples_are_an_ordinary_download(tmp_path):
    """No false positive: the bytes `encv`/`enca`/`pssh` inside the `mdat` are samples, not boxes —
    the episode is DONE and gets its cover like any other."""
    result, _ = _download(tmp_path, video_bytes=with_drm_words_in_mdat())
    assert result.message == f"saved {STEM}.mp4 + cover embedded"
    assert extract_cover(result.path) == (JPEG, "image/jpeg")


def test_an_encrypted_file_the_os_will_not_delete_is_reported_with_what_to_do(
    tmp_path, monkeypatch
):
    def refuse(path, **_):
        raise PermissionError(errno.EACCES, "Permission denied", str(path))

    monkeypatch.setattr(media_module, "discard", refuse)
    factory, _ = make_factory(video_bytes=ENCRYPTED, sidecar=(".jpeg", JPEG))
    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert result.status is DownloadStatus.FAILED_UNAVAILABLE
    assert result.message == (
        f"{DRM_MESSAGE} (could not delete {STEM}.mp4: Permission denied — delete it by hand: it "
        "cannot play, and left there it would pass for the episode)"
    )
    assert result.message.startswith(DRM_MARK)
    assert _names(tmp_path) == [f"{STEM}.mp4"]  # the cover went; the video is left to the user


def test_an_encrypted_file_already_under_the_episodes_name_is_deleted_never_adopted(
    tmp_path, monkeypatch
):
    """A file found under the episode's name is checked for encrypted tracks before it is taken
    for the episode (one a failed run or a refused deletion left there): deleted with its cover
    and FAILED_UNAVAILABLE with the DRM message — no request, never `skipped-exists`, so it is
    never counted as on disk, served or zipped. A dry run changes nothing; a plain file is
    skipped as ever; a file the OS will not delete is reported again with what to do."""
    video = tmp_path / f"{STEM}.mp4"
    video.write_bytes(ENCRYPTED)
    (tmp_path / f"{STEM}.jpeg").write_bytes(JPEG)
    factory, log = make_factory()
    downloader = YtDlpDownloader(factory)

    dry = downloader.download(EPISODE, DownloadOptions(out_dir=tmp_path, dry_run=True))
    assert dry.status is DownloadStatus.SKIPPED_EXISTS and video.exists()

    result = downloader.download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert (result.status, result.message) == (DownloadStatus.FAILED_UNAVAILABLE, DRM_MESSAGE)
    assert result.path is None and log == [] and _names(tmp_path) == []

    video.write_bytes(TINY_MP4)  # an ordinary file under that name: skipped as ever
    plain = downloader.download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert (plain.status, plain.path) == (DownloadStatus.SKIPPED_EXISTS, video)

    def refuse(path, **_):
        raise PermissionError(errno.EACCES, "Permission denied", str(path))

    video.write_bytes(ENCRYPTED)
    monkeypatch.setattr(media_module, "discard", refuse)
    again = downloader.download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert again.status is DownloadStatus.FAILED_UNAVAILABLE
    assert again.message.startswith(f"{DRM_MESSAGE} (could not delete {STEM}.mp4: ")
    assert log == []


class _WritesThenFails(FakeYdl):
    """yt-dlp writing the video under the episode's name and only then raising (or exiting
    non-zero): a postprocessor, a rename, an error after the transfer."""

    def download(self, urls):
        error, self.error = self.error, None
        retcode = super().download(urls)
        if error is not None:
            raise error
        return retcode


@pytest.mark.parametrize(
    ("error", "retcode", "status"),
    [
        pytest.param(
            RuntimeError("ERROR: Postprocessing: Conversion failed!"),
            0,
            DownloadStatus.FAILED_UNAVAILABLE,
            id="raises",
        ),
        pytest.param(None, 1, DownloadStatus.FAILED_UNAVAILABLE, id="exit-code"),
        pytest.param(
            RuntimeError("ERROR: [TikTok] x: No video formats found!"),
            0,
            DownloadStatus.FAILED_UNAVAILABLE,
            id="unavailable",
        ),
        # a status that stops the run is kept (the stop and the cooldown matter more)
        pytest.param(
            RuntimeError("ERROR: HTTP Error 403: Forbidden"),
            0,
            DownloadStatus.FAILED_BLOCKED,
            id="403",
        ),
    ],
)
def test_a_failed_run_never_leaves_an_encrypted_file_under_the_episodes_name(
    tmp_path, error, retcode, status
):
    log = []

    def factory(params):
        return _WritesThenFails(
            params,
            log,
            error=error,
            retcode=retcode,
            video_bytes=ENCRYPTED,
            sidecar=(".jpeg", JPEG),
        )

    result = YtDlpDownloader(factory).download(EPISODE, DownloadOptions(out_dir=tmp_path))
    assert result.status is status and result.path is None
    if status is DownloadStatus.FAILED_UNAVAILABLE:
        assert result.message == DRM_MESSAGE  # the verdict the manifest remembers
    else:
        assert result.message.startswith(BLOCKED_MESSAGE)
    assert _names(tmp_path) == [] and len(log) == 1
    # a plain file left by a failed run stays (a rerun skips it, as before): no false verdict
    plain_log = []
    plain = YtDlpDownloader(
        lambda params: _WritesThenFails(params, plain_log, error=error, retcode=retcode)
    ).download(EPISODE, DownloadOptions(out_dir=tmp_path / "plain"))
    assert plain.status is not DownloadStatus.DONE and not plain.message.startswith(DRM_MARK)
    assert _names(tmp_path / "plain") == [f"{STEM}.mp4"]


def test_a_payload_flagged_drm_episode_is_skipped_with_the_drm_wording(tmp_path):
    drm = Episode(
        number=6,
        item_id="7699400000000000006",
        title="Ep 6",
        series_id=SERIES_ID,
        lock_hints=("drmProtected=true", "isFree=false"),
        drm=True,
    )
    assert drm.locked and drm.access == "locked"
    factory, log = make_factory()
    result = YtDlpDownloader(factory).download(drm, DownloadOptions(out_dir=tmp_path))
    assert result.status is DownloadStatus.SKIPPED_LOCKED and result.path is None
    assert result.message == (
        "protected by DRM (drmProtected=true; isFree=false): DramaFetch does not decrypt it"
    )
    assert log == [] and list(tmp_path.iterdir()) == []
    # without hints (the catalog always gives one) the wording still is a payload flag's, never
    # DRM_MESSAGE — the verdict of a download, which the manifest remembers
    assert locked_result(replace(drm, lock_hints=())).message == PAYLOAD_DRM_MESSAGE == (
        "protected by DRM (flagged in the episode list): DramaFetch does not decrypt it"
    )
    assert not PAYLOAD_DRM_MESSAGE.startswith(DRM_MESSAGE)
    assert locked_result(LOCKED).message == (
        "looks locked: isFree=false; isLocked=True; no play address"
    )
    assert locked_result(replace(EPISODE, access="locked")).message == "looks locked"


def test_include_locked_asks_for_a_drm_flagged_episode_and_keeps_nothing_encrypted(tmp_path):
    """`--include-locked` asks TikTok anyway, with the user's own session — TikTok decides, and
    nothing is unlocked; what comes back encrypted is deleted like any encrypted download."""
    drm = replace(EPISODE, drm=True, access="locked", lock_hints=("isDrm=true",))
    factory, log = make_factory(video_bytes=ENCRYPTED, sidecar=(".jpeg", JPEG))
    result = YtDlpDownloader(factory).download(
        drm, DownloadOptions(out_dir=tmp_path, include_locked=True)
    )
    assert len(log) == 1
    assert (result.status, result.message) == (DownloadStatus.FAILED_UNAVAILABLE, DRM_MESSAGE)
    assert _names(tmp_path) == []


def test_a_paid_episode_the_account_unlocked_downloads_like_a_free_one(tmp_path):
    """`access == "unlocked"`: TikTok gave THIS session the episode it sells — no skip, the same
    download, the same verification, the same cover."""
    unlocked = replace(
        EPISODE,
        access="unlocked",
        paid=True,
        lock_hints=("isFree=false", "unlockPrice=30", "isUnlocked=True"),
    )
    assert not unlocked.locked
    factory, log = make_factory(sidecar=(".jpeg", JPEG))
    result = YtDlpDownloader(factory).download(unlocked, DownloadOptions(out_dir=tmp_path))
    assert result.status is DownloadStatus.DONE and len(log) == 1
    assert result.message == f"saved {STEM}.mp4 + cover embedded"
