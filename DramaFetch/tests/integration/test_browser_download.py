"""The browser download engine end to end: a real headless Chromium fetches episodes from the fake
TikTok's CDN inside one browser session (`pytest -m integration`; skipped without a browser) — and
the integrity checks against it: a transfer cut short, a video far shorter than announced, the
quality modes, the cooldown a rate limit starts and the CLI's refusal under it."""

from __future__ import annotations

import json
import os
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
from dramafetch.media import INCOMPLETE_PREFIX
from dramafetch.models import DownloadOptions, DownloadStatus, Series
from dramafetch.thumbnails import EMBED_SUFFIX, cover_sidecar, extract_cover

from .fake_tiktok import (
    COVER_MIN_SIZE,
    JPEG_EOI,
    JPEG_SOI,
    MEDIA_SIZE,
    SERIES_ID,
    SERIES_NAME,
    TOTAL_EPISODES,
    FakeTikTok,
    cover_bytes,
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
