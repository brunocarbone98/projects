"""The browser download engine end to end: a real headless Chromium fetches episodes from the fake
TikTok's CDN inside one browser session (`pytest -m integration`; skipped without a browser) — and
the integrity checks against it: a transfer cut short, a video far shorter than announced, the
quality modes, the cooldown a rate limit starts and the CLI's refusal under it; the paid third
series with and without the session cookie (what THIS account unlocked downloads, what it did not
is never requested), an encrypted episode refused and remembered, and a batch of all three."""

from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from pathlib import Path
from typing import Any

import pytest
from mutagen.mp4 import MP4

from dramafetch import cli, engine
from dramafetch.catalog import (
    choose_rendition,
    merge_episodes,
    parse_item_list_payload,
    play_url_candidates,
    url_expiry,
)
from dramafetch.cooldown import active_cooldown, clear_cooldown
from dramafetch.downloader import existing_episode_file
from dramafetch.downloader_browser import BrowserDownloader
from dramafetch.manifest import read_manifest
from dramafetch.media import INCOMPLETE_PREFIX, drm_problem_in
from dramafetch.models import DRM_MARK, DRM_MESSAGE, DownloadOptions, DownloadStatus, Series
from dramafetch.thumbnails import EMBED_SUFFIX, cover_sidecar, extract_cover

from .fake_tiktok import (
    COVER_MIN_SIZE,
    JPEG_EOI,
    JPEG_SOI,
    MEDIA_SIZE,
    SECOND_ITEMS,
    SECOND_SERIES_ID,
    SECOND_SERIES_NAME,
    SERIES_ID,
    SERIES_NAME,
    THIRD_ITEMS,
    THIRD_SERIES_ID,
    THIRD_SERIES_NAME,
    TOTAL_EPISODES,
    FakeTikTok,
    cover_bytes,
    drm_media_bytes,
    media_bytes,
)

CHROMIUM = Path(os.environ.get("DRAMAFETCH_CHROMIUM") or "/opt/pw-browsers/chromium")
SESSION_VALUE = "fake-session-value-that-must-never-leak"
# The default name format, "{series} - Episode {number}"; a sidecar cover sits next to the video.
EPISODE_1 = f"{SERIES_NAME} - Episode 01.mp4"
EPISODE_2 = f"{SERIES_NAME} - Episode 02.mp4"
COVER_1 = f"{SERIES_NAME} - Episode 01.jpg"
COVER_2 = f"{SERIES_NAME} - Episode 02.jpg"
ITEM_1 = "7699400000000000001"
ITEM_2 = "7699400000000000002"
MEDIA_1 = f"/cdn/{ITEM_1}/0.mp4"
MEDIA_2 = f"/cdn/{ITEM_2}/0.mp4"
COVER_PATH_1 = "/cover/7699400000000000001.jpg"
COVER_PATH_2 = "/cover/7699400000000000002.jpg"

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not CHROMIUM.is_file(), reason=f"no Chromium at {CHROMIUM} (set DRAMAFETCH_CHROMIUM)"
    ),
]


def _series_from_server(server: FakeTikTok, *, session: bool = False) -> Series:
    """The series as a discovery would list it: both item_list pages, straight over HTTP (no
    browser, no proxy), so the request log afterwards shows only what the download engine does."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    pages = []
    for cursor in ("0", "3"):
        request = urllib.request.Request(
            f"{server.base_url}/api/drama/episode/item_list/?dramaID={SERIES_ID}"
            f"&cursor={cursor}&count=10"
        )
        if session:
            request.add_header("Cookie", f"sessionid={SESSION_VALUE}")
        with opener.open(request, timeout=10) as response:
            pages.append(parse_item_list_payload(json.load(response), SERIES_ID))
    episodes = merge_episodes(page.episodes for page in pages)
    assert [e.number for e in episodes] == [1, 2, 3, 4, 5]
    if not server.options.short_media:  # the lists say what the fake CDN's media lasts: 3 s
        assert [e.duration_s for e in episodes] == [3, 3, 3, 3, 3]
    return Series(SERIES_ID, SERIES_NAME, episodes, total_hint=TOTAL_EPISODES)


def _options(server: FakeTikTok, tmp_path: Path, **overrides: Any) -> DownloadOptions:
    settings: dict[str, Any] = {
        "out_dir": tmp_path / "series",
        "engine": "browser",
        "browser_executable": CHROMIUM,
        "base_url": server.base_url,
        "series_name": SERIES_NAME,  # what engine.download_series sets for {series}
    }
    settings.update(overrides)
    return DownloadOptions(**settings)


def _assert_cover_file(path: Path, item_id: str) -> None:
    """A JPEG by its magic bytes (`FF D8 FF` ... `FF D9`), the fake CDN's bytes for the item — a
    real picture (quantisation and Huffman tables, a frame header, a scan), not a bare shell."""
    assert path.is_file()
    data = path.read_bytes()
    assert data.startswith(JPEG_SOI + b"\xff") and data.endswith(JPEG_EOI)
    assert len(data) >= COVER_MIN_SIZE
    assert data == cover_bytes(item_id)
    assert all(
        m in data for m in (b"\xff\xdb", b"\xff\xc4", b"\xff\xc0", b"\xff\xda")
    )  # DQT DHT SOF0 SOS


def _cookies_txt(tmp_path: Path) -> Path:
    """A Netscape cookies.txt for the fake server (Playwright wants domain "127.0.0.1")."""
    path = tmp_path / "cookies.txt"
    expires = int(time.time()) + 86_400
    path.write_text(
        "# Netscape HTTP Cookie File\n"
        f"#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t{expires}\tsessionid\t{SESSION_VALUE}\n"
        f"127.0.0.1\tFALSE\t/\tFALSE\t0\ttt_csrf_token\tcsrf-value\n",
        encoding="utf-8",
    )
    return path


def _assert_video_file(path: Path | None, name: str, item_id: str, *, embedded: bool) -> None:
    """A real, playable MP4 under `name` (the `ftyp` box first, the fixture's 3 seconds), with no
    `.embed.part` left next to it. `embedded`: the fake CDN's JPEG for `item_id` sits in its `covr`
    atom; otherwise the file is byte for byte what the CDN sent and carries no cover."""
    assert path is not None and path.name == name and path.is_file()
    data = path.read_bytes()
    assert data[4:8] == b"ftyp"
    assert abs(MP4(path).info.length - 3.0) < 0.2
    assert not list(path.parent.glob(f"*{EMBED_SUFFIX}"))
    if embedded:
        assert extract_cover(path) == (cover_bytes(item_id), "image/jpeg")
        assert len(data) > MEDIA_SIZE  # the atom was added, nothing else changed
    else:
        assert data == media_bytes(item_id, "0") and len(data) == MEDIA_SIZE
        assert extract_cover(path) is None


def test_downloads_episodes_1_and_2_inside_one_browser_session(tmp_path: Path) -> None:
    with FakeTikTok() as server:
        series = _series_from_server(server)
        before = len(server.requests)
        options = _options(server, tmp_path)
        with BrowserDownloader() as downloader:
            first = downloader.download(series.episode(1), options)
            second = downloader.download(series.episode(2), options)
            assert downloader.browser_started
        after = server.requests[before:]

    assert first.status is DownloadStatus.DONE
    assert second.status is DownloadStatus.DONE
    # the default: the cover is embedded into each MP4 as its cover art; no sidecar file
    _assert_video_file(first.path, EPISODE_1, ITEM_1, embedded=True)
    _assert_video_file(second.path, EPISODE_2, ITEM_2, embedded=True)
    assert first.message == f"saved {EPISODE_1} (0.1 MiB) + cover embedded"
    assert second.message == f"saved {EPISODE_2} (0.1 MiB) + cover embedded"
    assert cover_sidecar(first.path) is None and cover_sidecar(second.path) is None
    assert sorted(p.name for p in options.out_dir.iterdir()) == [EPISODE_1, EPISODE_2]
    # exactly one CDN request and one cover request per episode, the cover right after its
    # video, all with the Referer of the series site; no page load
    assert [r.path for r in after] == [MEDIA_1, COVER_PATH_1, MEDIA_2, COVER_PATH_2]
    assert all(r.with_referer and not r.logged_in for r in after)
    assert len(server.cover_requests) == 2 and len(server.media_requests) == 2
    assert not downloader.browser_started  # closed by the context manager


def test_thumbnail_both_embeds_the_cover_and_keeps_the_sidecar(tmp_path: Path) -> None:
    with FakeTikTok() as server:
        series = _series_from_server(server)
        before = len(server.requests)
        options = _options(server, tmp_path, thumbnail="both")
        with BrowserDownloader() as downloader:
            results = [downloader.download(series.episode(n), options) for n in (1, 2)]
        after = server.requests[before:]

    assert [r.status for r in results] == [DownloadStatus.DONE, DownloadStatus.DONE]
    assert results[0].message == f"saved {EPISODE_1} (0.1 MiB) + cover embedded + file"
    _assert_video_file(results[0].path, EPISODE_1, ITEM_1, embedded=True)
    _assert_video_file(results[1].path, EPISODE_2, ITEM_2, embedded=True)
    _assert_cover_file(options.out_dir / COVER_1, ITEM_1)
    _assert_cover_file(options.out_dir / COVER_2, ITEM_2)
    assert cover_sidecar(results[0].path) == options.out_dir / COVER_1
    assert sorted(p.name for p in options.out_dir.iterdir()) == [
        COVER_1,
        EPISODE_1,
        COVER_2,
        EPISODE_2,
    ]
    assert [r.path for r in after] == [MEDIA_1, COVER_PATH_1, MEDIA_2, COVER_PATH_2]


def test_thumbnail_file_keeps_the_sidecar_only_and_the_video_as_the_cdn_sent_it(
    tmp_path: Path,
) -> None:
    with FakeTikTok() as server:
        series = _series_from_server(server)
        before = len(server.requests)
        options = _options(server, tmp_path, thumbnail="file")
        with BrowserDownloader() as downloader:
            results = [downloader.download(series.episode(n), options) for n in (1, 2)]
        after = server.requests[before:]

    assert [r.status for r in results] == [DownloadStatus.DONE, DownloadStatus.DONE]
    assert results[0].message == f"saved {EPISODE_1} (0.1 MiB) + cover file"
    _assert_video_file(results[0].path, EPISODE_1, ITEM_1, embedded=False)
    _assert_video_file(results[1].path, EPISODE_2, ITEM_2, embedded=False)
    _assert_cover_file(options.out_dir / COVER_1, ITEM_1)
    _assert_cover_file(options.out_dir / COVER_2, ITEM_2)
    assert sorted(p.name for p in options.out_dir.iterdir()) == [
        COVER_1,
        EPISODE_1,
        COVER_2,
        EPISODE_2,
    ]
    assert [r.path for r in after] == [MEDIA_1, COVER_PATH_1, MEDIA_2, COVER_PATH_2]


def test_thumbnail_none_saves_the_videos_only_and_asks_for_no_cover(tmp_path: Path) -> None:
    with FakeTikTok() as server:
        series = _series_from_server(server)
        assert all(e.cover_url and e.cover_url.startswith(server.base_url) for e in series.episodes)
        before = len(server.requests)
        options = _options(server, tmp_path, thumbnail="none")
        with BrowserDownloader() as downloader:
            results = [downloader.download(series.episode(n), options) for n in (1, 2)]
        after = server.requests[before:]

    assert [r.status for r in results] == [DownloadStatus.DONE, DownloadStatus.DONE]
    assert results[0].message == f"saved {EPISODE_1} (0.1 MiB)"
    _assert_video_file(results[0].path, EPISODE_1, ITEM_1, embedded=False)
    _assert_video_file(results[1].path, EPISODE_2, ITEM_2, embedded=False)
    assert sorted(p.name for p in options.out_dir.iterdir()) == [EPISODE_1, EPISODE_2]
    assert [r.path for r in after] == [MEDIA_1, MEDIA_2]
    assert server.cover_requests == []


def test_locked_episode_is_skipped_without_network(tmp_path: Path) -> None:
    with FakeTikTok() as server:
        series = _series_from_server(server)
        before = len(server.requests)
        downloader = BrowserDownloader()
        result = downloader.download(series.episode(5), _options(server, tmp_path))
        downloader.close()
        assert len(server.requests) == before

    assert result.status is DownloadStatus.SKIPPED_LOCKED
    assert "isFree=false" in result.message
    assert not downloader.browser_started
    assert not (tmp_path / "series").exists()


def test_expired_play_urls_are_refreshed_once_in_the_session(tmp_path: Path) -> None:
    with FakeTikTok(expired_media_first=True) as server:
        series = _series_from_server(server)  # page 1 (episodes 1-3) carries expired URLs
        now = int(time.time())
        for number in (1, 2, 3):
            urls = play_url_candidates(series.episode(number).raw)
            assert urls and all((url_expiry(url) or 0) < now for url in urls)
        before = len(server.requests)
        options = _options(server, tmp_path)
        with BrowserDownloader() as downloader:
            results = [downloader.download(series.episode(n), options) for n in (1, 2)]
            refreshes = downloader.refreshes
        after = server.requests[before:]

    assert [r.status for r in results] == [DownloadStatus.DONE, DownloadStatus.DONE]
    _assert_video_file(results[0].path, EPISODE_1, ITEM_1, embedded=True)
    _assert_video_file(results[1].path, EPISODE_2, ITEM_2, embedded=True)
    assert refreshes == 1  # episode 2 came from the refreshed list cached in the run
    series_pages = [r for r in after if r.path.startswith("/shortdrama/episode/")]
    assert [r.path for r in series_pages] == [f"/shortdrama/episode/{SERIES_ID}/1"]
    item_lists = [r for r in after if r.path == "/api/drama/episode/item_list/"]
    assert [r.query["cursor"] for r in item_lists] == ["0", "3"]  # the page's own, then ours
    media = [r for r in after if r.path.startswith("/cdn/")]
    assert [r.path for r in media] == [MEDIA_1, MEDIA_2]  # the expired URLs were never requested
    assert all(r.query["expire"].isdigit() and int(r.query["expire"]) > now for r in media)
    covers = [r for r in after if r.path.startswith("/cover/")]
    assert [r.path for r in covers] == [COVER_PATH_1, COVER_PATH_2]  # one per episode, after it
    assert [r.path for r in after][-2:] == [MEDIA_2, COVER_PATH_2]  # the cover follows its video
    assert sorted(p.name for p in options.out_dir.iterdir()) == [EPISODE_1, EPISODE_2]


def test_cdn_rate_limit_is_reported_as_rate_limited(tmp_path: Path) -> None:
    with FakeTikTok(cdn_rate_limit=True) as server:
        series = _series_from_server(server)
        before = len(server.requests)
        with BrowserDownloader() as downloader:
            result = downloader.download(series.episode(1), _options(server, tmp_path))
        after = server.requests[before:]

    assert result.status is DownloadStatus.FAILED_RATE_LIMITED
    assert "HTTP 429" in result.message and "30-60 minutes" in result.message
    assert [r.path for r in after] == ["/cdn/7699400000000000001/0.mp4"]  # one request, no refresh
    assert not list((tmp_path / "series").glob("*")) if (tmp_path / "series").exists() else True


def test_dry_run_touches_no_network_and_starts_no_browser(tmp_path: Path) -> None:
    with FakeTikTok() as server:
        series = _series_from_server(server)
        before = len(server.requests)
        downloader = BrowserDownloader()
        options = _options(server, tmp_path, dry_run=True)
        results = [downloader.download(episode, options) for episode in series.episodes]
        downloader.close()
        assert len(server.requests) == before

    assert [r.status for r in results] == [DownloadStatus.DRY_RUN] * 4 + [
        DownloadStatus.SKIPPED_LOCKED
    ]
    assert results[0].message == "would download from 127.0.0.1 + cover"
    assert not downloader.browser_started
    assert not (tmp_path / "series").exists()


def test_cookies_log_the_session_in_at_the_cdn_and_never_leak(tmp_path: Path) -> None:
    with FakeTikTok(require_login=True) as server:
        series = _series_from_server(server, session=True)
        before = len(server.requests)
        options = _options(server, tmp_path, cookies_file=_cookies_txt(tmp_path))
        with BrowserDownloader() as downloader:
            result = downloader.download(series.episode(1), options)
        after = server.requests[before:]

    assert result.status is DownloadStatus.DONE
    _assert_video_file(result.path, EPISODE_1, ITEM_1, embedded=True)
    assert result.message == f"saved {EPISODE_1} (0.1 MiB) + cover embedded"
    assert [r.path for r in after] == [MEDIA_1, COVER_PATH_1]
    assert all(r.logged_in and r.with_referer for r in after)  # the cover goes with the session
    assert SESSION_VALUE not in result.message and SESSION_VALUE not in repr(result)


def test_without_a_session_the_cdn_refuses_and_the_refresh_meets_the_login_page(
    tmp_path: Path,
) -> None:
    with FakeTikTok(require_login=True) as server:
        series = _series_from_server(server, session=True)  # the list itself needs the session
        before = len(server.requests)
        with BrowserDownloader() as downloader:
            result = downloader.download(series.episode(1), _options(server, tmp_path))
        after = server.requests[before:]

    assert result.status is DownloadStatus.FAILED_LOGIN
    assert "login page" in result.message and "--cookies" in result.message
    # the CDN said 403 (no session) for both renditions of episode 1 — the H.264 first, then the
    # bytevc1 mirror — so the refresh opened the series page and was sent to /login
    assert [r.path for r in after][:4] == [
        MEDIA_1,
        f"/cdn/{ITEM_1}/1.mp4",
        f"/shortdrama/episode/{SERIES_ID}/1",
        "/login",
    ]
    assert not any(r.path.startswith("/cdn/") for r in after[2:])
    assert not (tmp_path / "series").exists() or not list((tmp_path / "series").iterdir())


# --- integrity, quality and the cooldown --------------------------------------------------------

INCOMPLETE_1 = f"{SERIES_NAME} - Episode 01 (incomplete).mp4"


def test_quality_best_fetches_the_highest_bitrate_rendition_first(tmp_path: Path) -> None:
    """Episode 1 lists a 720p H.264 (`/cdn/<id>/0.mp4`) and a higher-bitrate 1080p bytevc1
    rendition (`/cdn/<id>/1.mp4`): `compatible` (the default, what `info` shows) takes the H.264,
    `best` the bytevc1 — the codec a capable player needs."""
    with FakeTikTok() as server:
        series = _series_from_server(server)
        episode = series.episode(1)
        assert episode.quality_hint == "720p h264"
        assert choose_rendition(episode.raw, "best").label == "1080p bytevc1"
        before = len(server.requests)
        options = _options(server, tmp_path, quality="best", thumbnail="none")
        with BrowserDownloader() as downloader:
            result = downloader.download(episode, options)
        after = server.requests[before:]

    assert result.status is DownloadStatus.DONE
    assert [r.path for r in after] == [f"/cdn/{ITEM_1}/1.mp4"]
    assert result.path is not None and result.path.read_bytes() == media_bytes(ITEM_1, "1")
    assert abs(MP4(result.path).info.length - 3.0) < 0.2


def test_a_truncated_transfer_fails_the_episode_without_a_retry_or_a_cover(
    tmp_path: Path,
) -> None:
    """The CDN announces the whole file and stops at 60 %: Chromium's request API reports the
    transfer as aborted before a single byte reaches DramaFetch, so nothing is on disk; the
    episode is FAILED with the truncation message, the episode's second rendition is NOT tried
    (the network failed, not the URL), no list is refreshed and no cover is requested."""
    with FakeTikTok(truncate_media=True) as server:
        series = _series_from_server(server)
        assert len(play_url_candidates(series.episode(1).raw)) == 2  # a mirror it must not try
        before = len(server.requests)
        with BrowserDownloader() as downloader:
            result = downloader.download(series.episode(1), _options(server, tmp_path))
            refreshes = downloader.refreshes
        after = server.requests[before:]

    assert result.status is DownloadStatus.FAILED and result.path is None
    assert result.message == (
        f"{INCOMPLETE_PREFIX}truncated body (the transfer was cut short) from 127.0.0.1"
    )
    assert [r.path for r in after] == [MEDIA_1]  # one request: no next mirror, no cover
    assert refreshes == 0
    series_dir = tmp_path / "series"
    assert not series_dir.exists() or list(series_dir.iterdir()) == []


def test_a_gzip_encoded_body_is_not_mistaken_for_a_truncation(tmp_path: Path) -> None:
    """`gzip_media`: the CDN compresses the body and announces the COMPRESSED size. Chromium's
    request API hands DramaFetch the decoded bytes with the headers as sent, so comparing the two
    would condemn every such episode as `truncated body (131072 of … bytes)`; the comparison is
    for identity-encoded bodies only — the episode is DONE, the file is the CDN's MP4 byte for
    byte, one request."""
    with FakeTikTok(gzip_media=True) as server:
        series = _series_from_server(server)
        before = len(server.requests)
        with BrowserDownloader() as downloader:
            result = downloader.download(
                series.episode(1), _options(server, tmp_path, thumbnail="none")
            )
        after = server.requests[before:]

    assert result.status is DownloadStatus.DONE
    _assert_video_file(result.path, EPISODE_1, ITEM_1, embedded=False)
    assert [r.path for r in after] == [MEDIA_1]


def test_a_video_far_shorter_than_announced_is_quarantined_and_a_rerun_tries_again(
    tmp_path: Path,
) -> None:
    """`short_media`: the list says episode 1 lasts 92 s (the fixture's value) while the CDN serves
    the 3-second file — a locked episode served as a preview looks exactly like this. The file is
    kept as `… (incomplete).mp4` untouched (no cover embedded, none requested), the episode is
    FAILED with the reason, and a rerun does not take the quarantined file for the episode."""
    with FakeTikTok(short_media=True) as server:
        series = _series_from_server(server)
        episode = series.episode(1)
        assert episode.duration_s == 92
        before = len(server.requests)
        options = _options(server, tmp_path)
        with BrowserDownloader() as downloader:
            first = downloader.download(episode, options)
            second = downloader.download(episode, options)
        after = server.requests[before:]

    assert first.status is DownloadStatus.FAILED and first.path is None
    assert first.message == (
        f"{INCOMPLETE_PREFIX}duration 3 s, expected 92 s (kept as {INCOMPLETE_1})"
    )
    kept = options.out_dir / INCOMPLETE_1
    assert kept.read_bytes() == media_bytes(ITEM_1, "0")  # as the CDN sent it: no cover in it
    assert extract_cover(kept) is None
    assert second.status is DownloadStatus.FAILED  # tried again, not skipped as existing
    assert second.message.endswith(f"(kept as {SERIES_NAME} - Episode 01 (incomplete 2).mp4)")
    assert sorted(p.name for p in options.out_dir.iterdir()) == [
        f"{SERIES_NAME} - Episode 01 (incomplete 2).mp4",
        INCOMPLETE_1,
    ]
    assert existing_episode_file(options.out_dir, episode, options) is None
    assert [r.path for r in after] == [MEDIA_1, MEDIA_1]  # no cover request for a bad download


def test_a_rate_limit_through_the_engine_starts_the_cooldown_and_the_cli_then_refuses(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The e2e of the cooldown: a 429 from the CDN stops the run (exit 5) and writes
    `cooldown.json` into DRAMAFETCH_STATE_DIR (tmp_path, through the conftest fixture); the CLI's
    `download` and `info` then exit 5 with the message and make ZERO requests to the server;
    deleting the file lets the next `info` run — with a real Chromium — go through."""
    with FakeTikTok(cdn_rate_limit=True) as server:
        series = _series_from_server(server)
        options = _options(server, tmp_path, delay_min_s=0, delay_max_s=0, rest_every=0)
        results = engine.download_series(
            series,
            [series.episode(1), series.episode(2)],
            options,
            downloader=BrowserDownloader(),
            sleep=lambda seconds: None,
        )
        assert [r.status.value for r in results] == ["failed-rate-limited"] * 2
        assert results[1].message.startswith("stopped: episode 1 failed-rate-limited")
        assert engine.exit_code(results) == 5
        recorded = active_cooldown()
        assert recorded is not None and recorded.source == "browser"
        assert recorded.reason.startswith("rate limited (HTTP 429) by the video server")
        assert (tmp_path / "cooldown.json").is_file()
        assert [r.path for r in server.requests[-1:]] == [MEDIA_1]  # the one refused request

        argv_tail = [
            "--strategy",
            "browser",
            "--base-url",
            server.base_url,
            "--browser-path",
            str(CHROMIUM),
            "--page-count",
            "10",
            "--page-delay",
            "0",
            "--out",
            str(tmp_path / "cli"),
        ]
        requests_before = len(server.requests)
        started = time.monotonic()
        assert cli.main(["download", SERIES_ID, "--engine", "browser", *argv_tail]) == 5
        assert cli.main(["info", SERIES_ID, *argv_tail]) == 5
        assert time.monotonic() - started < 5  # refused up front: no browser, no request
        captured = capsys.readouterr()
        assert captured.out == ""
        assert captured.err.count("error: TikTok refused a request at ") == 2
        assert f"delete {tmp_path / 'cooldown.json'} to lift it" in captured.err
        assert len(server.requests) == requests_before  # ZERO requests to TikTok under a cooldown

        clear_cooldown()  # what the message tells the user to do
        assert cli.main(["info", SERIES_ID, *argv_tail]) == 0
        out = capsys.readouterr().out
        assert f"Series: {SERIES_NAME} [{SERIES_ID}]" in out and "720p h264" in out
        assert len(server.item_list_requests) > 0  # the list was fetched again
        assert not (tmp_path / "cli").exists()  # info writes nothing


# --------------------------------------------------------------------------- several series

FIRST_FOLDER = f"{SERIES_NAME} [{SERIES_ID}]"
SECOND_FOLDER = f"{SECOND_SERIES_NAME} [{SECOND_SERIES_ID}]"


@pytest.fixture
def batch_sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """The seconds the CLI's batch would sleep, recorded instead of slept: `engine.run_batch`
    gets this `sleep` and hands it down to every series, so no test waits for real."""
    slept: list[float] = []
    real = engine.run_batch

    def recorded(*args: Any, **kwargs: Any) -> list[engine.SeriesRun]:
        kwargs.setdefault("sleep", slept.append)
        return real(*args, **kwargs)

    monkeypatch.setattr(engine, "run_batch", recorded)
    return slept


def _batch_argv(server: FakeTikTok, out: Path) -> list[str]:
    """Both series (a URL and a bare id), the browser engine, no pacing but a 1 s series rest."""
    return _download_argv(
        server, out, f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1", SECOND_SERIES_ID
    )


def _download_argv(
    server: FakeTikTok, out: Path, *refs: str, cookies: Path | None = None
) -> list[str]:
    """`download` of `refs` with the browser engine against the fake, no pacing but a 1 s series
    rest; with `cookies`, in the session of the account they belong to."""
    argv = [
        "download",
        *refs,
        "--engine",
        "browser",
        "--strategy",
        "browser",
        "--base-url",
        server.base_url,
        "--browser-path",
        str(CHROMIUM),
        "--page-count",
        "10",
        "--page-delay",
        "0",
        "--delay-min",
        "0",
        "--delay-max",
        "0",
        "--rest-every",
        "0",
        "--rest-min",
        "1",
        "--rest-max",
        "1",
        "--out",
        str(out),
    ]
    if cookies is not None:
        argv += ["--cookies", str(cookies)]
    return argv


def _table_statuses(out: str) -> list[str]:
    """The status column of the batch table `download` prints after several series."""
    lines = out.splitlines()
    start = next(i for i, line in enumerate(lines) if line.lstrip().startswith("series  "))
    return [re.split(r"\s{2,}", line.strip())[1] for line in lines[start + 1 :]]


def test_a_cli_batch_downloads_both_series_one_after_the_other_and_then_costs_nothing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], batch_sleeps: list[float]
) -> None:
    """Two series in one `download`: each resolved right before its own downloads (all requests of
    the first series come before any of the second), one 1 s rest between them, every file named
    after its own series and complete; the same batch again is skipped as complete with ZERO
    requests to the server — no list, no media, not even a browser."""
    out = tmp_path / "out"
    with FakeTikTok() as server:
        assert cli.main(_batch_argv(server, out)) == 0
        first_run = capsys.readouterr()
        log = server.requests
        first = {id(record) for record in server.series_requests(SERIES_ID)}
        second = {id(record) for record in server.series_requests(SECOND_SERIES_ID)}
        owners = "".join(
            "1" if id(record) in first else "2" for record in log if id(record) in first | second
        )
        assert owners == "1" * len(first) + "2" * len(second)  # never resolved up front
        assert len(second) > 0
        assert sorted(r.path for r in server.media_requests) == sorted(
            [f"/cdn/{item}/0.mp4" for item in (ITEM_1, ITEM_2, "7699400000000000003")]
            + ["/cdn/7699400000000000004/0.mp4"]
            + [f"/cdn/{item}/0.mp4" for item in SECOND_ITEMS]
        )
        requests_after_first_run = len(server.requests)

        started = time.monotonic()
        assert cli.main(_batch_argv(server, out)) == 0
        second_run = capsys.readouterr()
        assert len(server.requests) == requests_after_first_run  # ZERO requests the second time
        assert time.monotonic() - started < 5  # no browser was even started

    lines = first_run.out.splitlines()
    assert lines[0] == f"[1/2] {FIRST_FOLDER}: 5 episode(s) -> {out / FIRST_FOLDER}"
    assert f"[2/2] {SECOND_FOLDER}: 3 episode(s) -> {out / SECOND_FOLDER}" in lines
    assert "complete: 4 of 5 (4 downloaded) — 1 locked (5)" in lines
    assert "complete: 3 of 3 (3 downloaded)" in lines
    assert _table_statuses(first_run.out) == ["complete", "complete"]
    assert first_run.err.splitlines().count("  … resting 1 s before the next series") == 1
    assert batch_sleeps == [1.0]  # exactly one series rest, recorded, never slept
    for number, item in enumerate((ITEM_1, ITEM_2, "7699400000000000003", "7699400000000000004")):
        name = f"{SERIES_NAME} - Episode {number + 1:02d}.mp4"
        _assert_video_file(out / FIRST_FOLDER / name, name, item, embedded=True)
    for number, item in enumerate(SECOND_ITEMS, start=1):
        name = f"{SECOND_SERIES_NAME} - Episode {number:02d}.mp4"
        _assert_video_file(out / SECOND_FOLDER / name, name, item, embedded=True)
    assert not list((out / FIRST_FOLDER).glob("*Episode 05*"))  # the locked one: never fetched

    again = second_run.out.splitlines()
    assert f"[1/2] {FIRST_FOLDER}: 4 episode(s) -> {out / FIRST_FOLDER}" in again
    # the skip says that episode 5 was locked when the series was found complete, and how to
    # look again after unlocking it in the TikTok app; a series without locked ones says nothing
    assert (
        "complete, nothing to do: 4 episodes already on disk, 1 locked (5) (checked just now) — "
        "unlocked more in the TikTok app since? --recheck looks again"
    ) in again
    assert "complete, nothing to do: 3 episodes already on disk (checked just now)" in again
    assert _table_statuses(second_run.out) == ["skipped (complete)", "skipped (complete)"]
    assert "resting" not in second_run.err
    assert batch_sleeps == [1.0]  # nothing more


def test_a_rate_limit_in_the_first_series_stops_the_cli_batch_before_the_second(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], batch_sleeps: list[float]
) -> None:
    """`cdn_rate_limit`: the first media request of the first series answers 429, which stops
    the series and the whole batch (exit 5) and writes the cooldown file; the second series is
    "not started" and costs nothing — not its page, not its list, not one media request."""
    with FakeTikTok(cdn_rate_limit=True) as server:
        assert cli.main(_batch_argv(server, tmp_path / "out")) == 5
        captured = capsys.readouterr()
        assert server.series_requests(SECOND_SERIES_ID) == []
        assert [r.path for r in server.media_requests] == [MEDIA_1]  # the one refused request
        assert server.cover_requests == []
    recorded = active_cooldown()
    assert recorded is not None and recorded.source == "browser"
    assert (tmp_path / "cooldown.json").is_file()
    lines = captured.out.splitlines()
    assert (
        f"[2/2] {SECOND_SERIES_ID}: not started: batch stopped in {SERIES_NAME} "
        "(episode 1 failed-rate-limited)"
    ) in lines
    assert _table_statuses(captured.out) == ["incomplete", "not started"]
    assert any(line.endswith("; stopped: episode 1 failed-rate-limited") for line in lines)
    assert batch_sleeps == [] and "resting" not in captured.err  # no rest: the batch ended


# ------------------------------------------------------- paid episodes, the session, and DRM

THIRD_FOLDER = f"{THIRD_SERIES_NAME} [{THIRD_SERIES_ID}]"
#: What an episode an earlier run found encrypted gets instead of a request.
REMEMBERED_DRM = (
    "protected by DRM (found by an earlier run): DramaFetch does not decrypt it; "
    "--include-locked tries again"
)
RECHECK = "unlocked more in the TikTok app since? --recheck looks again"


def _row(number: int, status: str, detail: str) -> str:
    """One episode line of the CLI: `E03  done                   <path> + cover embedded`."""
    return f"E{number:02d}  {status:<22} {detail}"


def _third_name(number: int) -> str:
    return f"{THIRD_SERIES_NAME} - Episode {number:02d}.mp4"


def _media_paths(records: list[Any]) -> list[str]:
    return [r.path for r in records if r.path.startswith(("/cdn/", "/cover/"))]


def test_with_the_session_the_paid_episode_the_account_unlocked_downloads_like_a_free_one(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The paid third series with the cookies file. The list TikTok serves THIS session says
    episode 3 is sold (`isFree: false`, `unlockPrice: 30`) but unlocked by the account
    (`isUnlocked: true`) and carries its play URLs, so it downloads like episodes 1-2 — in the
    session, one media and one cover request each — and the report names it as a paid episode
    the account unlocked; episode 4, locked for everyone, is never requested. The session cookie
    arrived with every request (the fake records that it came, never its value)."""
    out = tmp_path / "out"
    with FakeTikTok() as server:
        code = cli.main(
            _download_argv(server, out, THIRD_SERIES_ID, cookies=_cookies_txt(tmp_path))
        )
        captured = capsys.readouterr()
        requests = server.series_requests(THIRD_SERIES_ID)
        media = _media_paths(server.requests)

    assert code == 0
    folder = out / THIRD_FOLDER
    lines = captured.out.splitlines()
    for number, item in enumerate(THIRD_ITEMS[:3], start=1):
        name = _third_name(number)
        _assert_video_file(folder / name, name, item, embedded=True)
        assert _row(number, "done", f"{folder / name} + cover embedded") in lines
    fourth = next(line for line in lines if line.startswith("E04  "))
    assert fourth.startswith(_row(4, "skipped-locked", "looks locked: "))
    assert "isLocked=True" in fourth
    assert (
        "complete: 3 of 4 (3 downloaded) — 1 paid episode your account unlocked (3), 1 locked (4)"
    ) in lines
    assert media == [
        path for item in THIRD_ITEMS[:3] for path in (f"/cdn/{item}/0.mp4", f"/cover/{item}.jpg")
    ]
    assert requests and all(r.logged_in for r in requests)  # the cookie arrived, every time
    assert not [r.path for r in requests if THIRD_ITEMS[3] in r.path]  # episode 4: never asked
    assert sorted(p.name for p in folder.iterdir()) == [
        *(_third_name(n) for n in (1, 2, 3)),
        "dramafetch.json",
    ]


def test_without_the_session_the_paid_episodes_are_locked_and_never_requested(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The same series without a cookies file: the list TikTok serves an anonymous session marks
    episode 3 `isLocked: true` and carries no play URL for it — nor for 4 — so both are listed as
    locked and skipped without a single request (not their media, not their covers); episodes 1-2
    download. Every episode this session may play is on disk: the series is complete, and the
    report names the two locked ones."""
    out = tmp_path / "out"
    with FakeTikTok() as server:
        code = cli.main(_download_argv(server, out, THIRD_SERIES_ID))
        captured = capsys.readouterr()
        requests = server.series_requests(THIRD_SERIES_ID)

    assert code == 0
    folder = out / THIRD_FOLDER
    lines = captured.out.splitlines()
    for number, item in enumerate(THIRD_ITEMS[:2], start=1):
        name = _third_name(number)
        _assert_video_file(folder / name, name, item, embedded=True)
        assert _row(number, "done", f"{folder / name} + cover embedded") in lines
    for number in (3, 4):
        row = next(line for line in lines if line.startswith(f"E{number:02d}  "))
        assert row.startswith(_row(number, "skipped-locked", "looks locked: "))
        assert "isLocked=True" in row
    assert "complete: 2 of 4 (2 downloaded) — 2 locked (3, 4)" in lines
    assert _media_paths(requests) == [
        path for item in THIRD_ITEMS[:2] for path in (f"/cdn/{item}/0.mp4", f"/cover/{item}.jpg")
    ]
    assert not [r.path for r in requests if THIRD_ITEMS[2] in r.path or THIRD_ITEMS[3] in r.path]
    assert requests and not any(r.logged_in for r in requests)
    assert sorted(p.name for p in folder.iterdir()) == [
        _third_name(1),
        _third_name(2),
        "dramafetch.json",
    ]


def test_the_browser_engine_refuses_encrypted_media_even_without_verification(
    tmp_path: Path,
) -> None:
    """`drm_media` on episode 1 of the main series, with `verify=False` (`--no-verify`): the DRM
    check is no part of the verification, it always runs. One request — the H.264 rendition; the
    bytevc1 mirror is not tried (it would serve the same encrypted file), no list is refreshed,
    no cover is requested — and nothing is written."""
    with FakeTikTok(drm_media=frozenset({(SERIES_ID, 1)})) as server:
        series = _series_from_server(server)
        assert len(play_url_candidates(series.episode(1).raw)) == 2
        before = len(server.requests)
        with BrowserDownloader() as downloader:
            result = downloader.download(
                series.episode(1), _options(server, tmp_path, verify=False)
            )
            refreshes = downloader.refreshes
        after = server.requests[before:]

    assert result.status is DownloadStatus.FAILED_UNAVAILABLE and result.path is None
    assert result.message == DRM_MESSAGE and result.message.startswith(DRM_MARK)
    assert [r.path for r in after] == [MEDIA_1]
    assert refreshes == 0
    series_dir = tmp_path / "series"
    assert not series_dir.exists() or list(series_dir.iterdir()) == []
    assert drm_problem_in(drm_media_bytes(ITEM_1, "0")) == DRM_MESSAGE  # what the CDN sent


def test_an_encrypted_episode_is_refused_kept_nowhere_and_skipped_next_time_without_a_request(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`drm_media`: the CDN serves episode 3 — the one the account bought — encrypted (`encv` /
    `enca` sample entries, a `pssh` box). The browser engine checks the body in memory before
    writing anything: failed-unavailable with the DRM message, nothing of it on disk (no video, no
    `.part`, no cover), neither its second rendition nor its cover requested; the run goes on (one
    failure is no streak). The manifest remembers the verdict, so the next run — which lists the
    series again, as it is not complete — skips episode 3 as locked without one media request."""
    out = tmp_path / "out"
    folder = out / THIRD_FOLDER
    third = THIRD_ITEMS[2]
    with FakeTikTok(drm_media=frozenset({(THIRD_SERIES_ID, 3)})) as server:
        argv = _download_argv(server, out, THIRD_SERIES_ID, cookies=_cookies_txt(tmp_path))
        assert cli.main(argv) == 2  # a failed episode
        first = capsys.readouterr()
        first_media = _media_paths(server.requests)
        before = len(server.requests)
        assert cli.main(argv) == 0
        second = capsys.readouterr()
        rerun = server.requests[before:]

    lines = first.out.splitlines()
    assert _row(3, "failed-unavailable", DRM_MESSAGE) in lines
    assert "incomplete: 2 of 4 — 1 locked (4), 1 failed (3)" in lines
    assert [path for path in first_media if third in path] == [f"/cdn/{third}/0.mp4"]
    assert sorted(p.name for p in folder.iterdir()) == [
        _third_name(1),
        _third_name(2),
        "dramafetch.json",
    ]
    manifest = read_manifest(folder, THIRD_SERIES_ID)
    assert manifest is not None and manifest.drm_protected(3)

    again = second.out.splitlines()
    assert _row(3, "skipped-locked", REMEMBERED_DRM) in again
    assert any(r.path == "/api/drama/episode/item_list/" for r in rerun)  # listed again
    assert _media_paths(rerun) == []  # and not one media or cover request
    assert sorted(p.name for p in folder.iterdir()) == [
        _third_name(1),
        _third_name(2),
        "dramafetch.json",
    ]


def test_a_cli_batch_of_all_three_series_with_the_session_then_costs_nothing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], batch_sleeps: list[float]
) -> None:
    """The three series in one `download` with the cookies file: each resolved right before its
    own downloads (all requests of one series before any of the next), a 1 s rest between two
    series, every free episode and the one the account unlocked on disk, every series complete;
    the same batch again is skipped as complete with ZERO requests, and the two series with
    locked episodes say how to look again."""
    out = tmp_path / "out"
    refs = (
        f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1",
        SECOND_SERIES_ID,
        f"https://www.tiktok.com/shortdrama/episode/{THIRD_SERIES_ID}/3",
    )
    with FakeTikTok() as server:
        argv = _download_argv(server, out, *refs, cookies=_cookies_txt(tmp_path))
        assert cli.main(argv) == 0
        first_run = capsys.readouterr()
        groups = [
            {id(record) for record in server.series_requests(series_id)}
            for series_id in (SERIES_ID, SECOND_SERIES_ID, THIRD_SERIES_ID)
        ]
        owners = "".join(
            str(index + 1)
            for record in server.requests
            for index, group in enumerate(groups)
            if id(record) in group
        )
        assert all(groups)
        assert owners == "".join(str(i + 1) * len(group) for i, group in enumerate(groups))
        locked_items = ("7699400000000000005", THIRD_ITEMS[3])
        assert not [r.path for r in server.requests if any(i in r.path for i in locked_items)]
        requests_after_first_run = len(server.requests)

        started = time.monotonic()
        assert cli.main(argv) == 0
        second_run = capsys.readouterr()
        assert len(server.requests) == requests_after_first_run  # ZERO requests the second time
        assert time.monotonic() - started < 5  # no browser was even started

    lines = first_run.out.splitlines()
    assert lines[0] == f"[1/3] {FIRST_FOLDER}: 5 episode(s) -> {out / FIRST_FOLDER}"
    assert f"[2/3] {SECOND_FOLDER}: 3 episode(s) -> {out / SECOND_FOLDER}" in lines
    assert f"[3/3] {THIRD_FOLDER}: 4 episode(s) -> {out / THIRD_FOLDER}" in lines
    assert "complete: 4 of 5 (4 downloaded) — 1 locked (5)" in lines
    assert "complete: 3 of 3 (3 downloaded)" in lines
    assert (
        "complete: 3 of 4 (3 downloaded) — 1 paid episode your account unlocked (3), 1 locked (4)"
    ) in lines
    assert _table_statuses(first_run.out) == ["complete", "complete", "complete"]
    assert first_run.err.splitlines().count("  … resting 1 s before the next series") == 2
    assert batch_sleeps == [1.0, 1.0]  # one rest between two series, recorded, never slept
    main_items = (ITEM_1, ITEM_2, "7699400000000000003", "7699400000000000004")
    for folder, series_name, items in (
        (FIRST_FOLDER, SERIES_NAME, main_items),
        (SECOND_FOLDER, SECOND_SERIES_NAME, SECOND_ITEMS),
        (THIRD_FOLDER, THIRD_SERIES_NAME, THIRD_ITEMS[:3]),
    ):
        for number, item in enumerate(items, start=1):
            name = f"{series_name} - Episode {number:02d}.mp4"
            _assert_video_file(out / folder / name, name, item, embedded=True)

    again = second_run.out.splitlines()
    assert f"[3/3] {THIRD_FOLDER}: 3 episode(s) -> {out / THIRD_FOLDER}" in again
    assert (
        "complete, nothing to do: 4 episodes already on disk, 1 locked (5) (checked just now) — "
        f"{RECHECK}"
    ) in again
    assert "complete, nothing to do: 3 episodes already on disk (checked just now)" in again
    assert (
        "complete, nothing to do: 3 episodes already on disk, 1 locked (4) (checked just now) — "
        f"{RECHECK}"
    ) in again
    assert _table_statuses(second_run.out) == ["skipped (complete)"] * 3
    assert "resting" not in second_run.err
    assert batch_sleeps == [1.0, 1.0]  # nothing more
