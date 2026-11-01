"""Tests for the web UI: the JSON API driven through ``http.client`` against fakes, and JobManager.

No network: a fake Discovery returns a five-episode series (episode 5 locked) and a fake Downloader
writes a tiny file instantly — optionally with a cover sidecar next to it, or as a copy of the real
``fixtures/tiny.mp4`` with a cover embedded in it (written with mutagen directly, the way the
engines do). The real ``engine.download_series`` and manifest run underneath. Every server here
binds to 127.0.0.1; the off-loopback rule is tested by the refusal that comes before any bind.
Build 5: the resolve cache is measured by how many discoveries the fake saw, and the cooldown
answers use the real cooldown file, written into the state directory the autouse fixture in
``conftest.py`` points at ``tmp_path`` — never ``~/.dramafetch``.
Build 6: batches of series run through the real ``engine.run_series``; the fake discovery also
knows the fake TikTok's second series ("Second Chance Bride", three free episodes), the fakes log
every discovery, download and pause in one ``events`` list (so "resolved right before its own
downloads" is an order of events), and the job manager's ``sleep`` is a recorder: the rest between
jobs is asserted, never slept.
"""

from __future__ import annotations

import http.client
import io
import json
import logging
import random
import shutil
import socket
import struct
import threading
import time
import tracemalloc
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any
from urllib.parse import quote

import pytest
from mutagen.mp4 import MP4, MP4Cover

from dramafetch import engine
from dramafetch.catalog import parse_item_list_payload
from dramafetch.cooldown import (
    Cooldown,
    active_cooldown,
    clear_cooldown,
    cooldown_message,
    record_block,
)
from dramafetch.errors import (
    ChallengeError,
    DiscoveryError,
    LoginRequiredError,
    RateLimitedError,
)
from dramafetch.models import (
    DiscoveryOptions,
    DownloadOptions,
    DownloadResult,
    DownloadStatus,
    Episode,
    Series,
    SeriesRef,
)
from dramafetch.thumbnails import cover_sidecar
from dramafetch.web import server as web_server
from dramafetch.web.jobs import GuardedDownloader, JobManager, redact_secrets, result_to_dict
from dramafetch.web.server import (
    MAX_BODY_BYTES,
    content_disposition,
    host_header_allowed,
    is_loopback_host,
    normalize_host,
    run_server,
    token_problem,
)

SERIES_ID = "7699393770256782354"
SERIES_NAME = "The Billionaire's Secret Heiress"
SERIES_URL = f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/3"
OTHER_SERIES_URL = "https://www.tiktok.com/shortdrama/episode/7600000000000000002/1"
VIDEO_URL = "https://www.tiktok.com/@muffindrama_us/video/7699400000000000001"
LOCK_HINTS = ("isFree=false", "isLocked=True", "unlockPrice=30", "no play address")
COVER_HOST = "https://p16-sign-sg.tiktokcdn.com"
# The fake TikTok's second series (tests/integration/fake_tiktok.py): three free episodes.
SECOND_SERIES_ID = "7699393770256782399"
SECOND_SERIES_NAME = "Second Chance Bride"
SECOND_SERIES_URL = f"https://www.tiktok.com/shortdrama/episode/{SECOND_SERIES_ID}/1"
TOKEN = "correct-horse-battery-staple"
NOT_FOUND = (404, {"error": "no such file", "kind": "HttpError"})
STILL_RUNNING = (409, {"error": "the job is still running", "kind": "HttpError"})
FINISHED = frozenset({"done", "error", "cancelled"})
# SOI + APP0 (JFIF) + padding + EOI: enough for a magic-number check, not a real picture.
JPEG_BYTES = (
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00H\x00H\x00\x00" + b"\x00" * 64 + b"\xff\xd9"
)
# The PNG signature and an IHDR chunk header, padded: again only the magic number is real.
PNG_BYTES = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + b"\x00" * 64
# A real 3 s MP4 (160x120, faststart) without any cover: what the fake downloader copies when a
# test needs a video mutagen can open.
FIXTURE_MP4 = Path(__file__).parent / "fixtures" / "tiny.mp4"


def embed_cover(
    video: Path, image: bytes = JPEG_BYTES, image_format: int = MP4Cover.FORMAT_JPEG
) -> None:
    """Put ``image`` into the video's ``covr`` atom with mutagen directly (``MP4Cover.FORMAT_JPEG``
    is 13, ``FORMAT_PNG`` 14), the way build 4's engines do through ``thumbnails.embed_cover``:
    these tests are about the web side, not about the embedding."""
    mp4 = MP4(video)
    if mp4.tags is None:
        mp4.add_tags()
    mp4.tags["covr"] = [MP4Cover(image, imageformat=image_format)]
    mp4.save()


def make_series(name: str | None = SERIES_NAME) -> Series:
    episodes = [
        Episode(
            number=number,
            item_id=f"76994000000000000{number:02d}",
            title=f"{SERIES_NAME} | Episode {number}",
            series_id=SERIES_ID,
            series_name=SERIES_NAME,
            author="muffindrama_us",
            duration_s=90 + number,
            cover_url=(
                f"{COVER_HOST}/tos-alisg-p-0037/cover{number:02d}~tplv-tiktokx-origin.jpeg"
                "?x-expires=1800000000&x-signature=abc"
            ),
        )
        for number in range(1, 6)
    ]
    episodes[4].lock_hints = LOCK_HINTS
    episodes[4].cover_url = None  # a locked item without a cover in the payload
    return Series(
        series_id=SERIES_ID,
        name=name,
        episodes=episodes,
        total_hint=5,
        warnings=["1 episodes look locked"],
    )


def make_second_series() -> Series:
    """The fake TikTok's second series: three free episodes, one page, TikTok announces 3."""
    episodes = [
        Episode(
            number=number,
            item_id=f"76994000000000001{number:02d}",
            title=f"{SECOND_SERIES_NAME} | Episode {number}",
            series_id=SECOND_SERIES_ID,
            series_name=SECOND_SERIES_NAME,
            author="muffindrama_us",
            duration_s=60 + number,
        )
        for number in range(1, 4)
    ]
    return Series(
        series_id=SECOND_SERIES_ID, name=SECOND_SERIES_NAME, episodes=episodes, total_hint=3
    )


class FakeDiscovery:
    """Implements the Discovery protocol: records the refs it gets (one per discovery, so the
    resolve cache is measured by their count) and answers instantly — or, with ``block`` set,
    once that event is set; ``entered`` is set when a discovery is in progress. The second series
    has its own list; any other id gets the first series' list. ``errors`` fails one series id;
    ``events`` (shared with the downloader) logs ``("discover", series_id)``."""

    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.errors: dict[str, Exception] = {}
        self.refs: list[SeriesRef] = []
        self.block: threading.Event | None = None
        self.entered = threading.Event()
        self.events: list[tuple[Any, ...]] = []

    def discover(self, ref: SeriesRef, options: DiscoveryOptions) -> Series:
        self.refs.append(ref)
        self.events.append(("discover", ref.series_id))
        self.entered.set()
        if self.block is not None:
            assert self.block.wait(10)
        if self.error is not None:
            raise self.error
        if ref.series_id in self.errors:
            raise self.errors[ref.series_id]
        return make_second_series() if ref.series_id == SECOND_SERIES_ID else make_series()


class FakeDownloader:
    """Implements the Downloader protocol: honours the locked rule, writes a tiny file instantly.

    ``write_dir`` (default: the series directory the engine passes in ``options.out_dir``) and
    ``name_format`` shape the path it reports; the episodes in ``cover_numbers`` also get a
    ``<stem>.jpg`` sidecar, the way the real engines save a thumbnail in the ``file`` and ``both``
    modes. The episodes in ``mp4_numbers`` are a copy of the real fixture instead of ``b"fake
    video"``, and those in ``embedded_numbers`` that copy with ``embedded_image`` written into its
    ``covr`` atom — the default ``embed`` mode's outcome.
    """

    def __init__(self) -> None:
        self.calls: list[int] = []
        self.write_dir: Path | None = None
        self.name_format = "E{number:02d}.mp4"
        self.cover_numbers: set[int] = set()
        self.mp4_numbers: set[int] = set()
        self.embedded_numbers: set[int] = set()
        self.embedded_image = JPEG_BYTES
        self.embedded_format = MP4Cover.FORMAT_JPEG
        self.block: threading.Event | None = None  # when set, every download waits for it
        # (series id, number) -> the status (and message) that episode fails with, no file written.
        self.outcomes: dict[tuple[str, int], tuple[DownloadStatus, str]] = {}
        self.series_calls: list[tuple[str, int]] = []
        self.events: list[tuple[Any, ...]] = []  # shared with the discovery: one order of events

    def download(self, episode: Episode, options: DownloadOptions) -> DownloadResult:
        self.calls.append(episode.number)
        self.series_calls.append((episode.series_id, episode.number))
        self.events.append(("download", episode.series_id, episode.number))
        if episode.locked and not options.include_locked:
            message = "locked: " + ", ".join(episode.lock_hints)
            return DownloadResult(episode, DownloadStatus.SKIPPED_LOCKED, message=message)
        if self.block is not None:
            assert self.block.wait(10)
        outcome = self.outcomes.get((episode.series_id, episode.number))
        if outcome is not None:
            return DownloadResult(episode, outcome[0], message=outcome[1])
        directory = self.write_dir or options.out_dir
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / self.name_format.format(number=episode.number)
        if episode.number in self.mp4_numbers | self.embedded_numbers:
            shutil.copyfile(FIXTURE_MP4, path)
            if episode.number in self.embedded_numbers:
                embed_cover(path, self.embedded_image, self.embedded_format)
        else:
            path.write_bytes(b"fake video")
        if episode.number in self.cover_numbers:
            path.with_suffix(".jpg").write_bytes(JPEG_BYTES)
        return DownloadResult(episode, DownloadStatus.DONE, path=path, message="ok")


@dataclass
class Harness:
    port: int
    out_dir: Path
    discovery: FakeDiscovery
    downloader: FakeDownloader
    # Headers every request carries, e.g. the Bearer token while driving a protected server.
    auth: dict[str, str] = field(default_factory=dict)
    # The bound DramaFetchServer, for the tests that reach into its series cache.
    server: Any = None
    # What the job manager was asked to sleep (the rest between jobs, any pause): never slept.
    sleeps: list[float] = field(default_factory=list)
    # Discoveries, downloads and sleeps in the order they happened.
    events: list[tuple[Any, ...]] = field(default_factory=list)

    def raw(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        raw: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        """Status, response headers and the body bytes, as sent."""
        payload = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        request_headers = {"Content-Type": "application/json"} if payload is not None else {}
        request_headers.update(self.auth)
        request_headers.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            connection.request(method, path, body=payload, headers=request_headers)
            response = connection.getresponse()
            data = response.read()
            return response.status, dict(response.getheaders()), data
        finally:
            connection.close()

    def status_with_header_lines(self, method: str, path: str, lines: list[tuple[str, str]]) -> int:
        """The status of a request whose header lines are sent exactly as given, repeated names
        included (``HTTPConnection.request`` takes a dict, so it cannot send two ``Cookie``s)."""
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            connection.putrequest(method, path)
            for name, value in lines:
                connection.putheader(name, value)
            connection.endheaders()
            response = connection.getresponse()
            response.read()
            return response.status
        finally:
            connection.close()

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        raw: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, Any]:
        """Status and the parsed JSON (or the text) of a response."""
        status, response_headers, data = self.raw(method, path, body, raw=raw, headers=headers)
        content_type = response_headers.get("Content-Type") or ""
        parsed = json.loads(data) if "json" in content_type else data.decode("utf-8")
        return status, parsed

    def start_download(self, **body: Any) -> dict[str, Any]:
        status, job = self.request("POST", "/api/download", {"url": SERIES_URL, **body})
        assert status == 202, job
        return job

    def start_batch(self, urls: list[str], **body: Any) -> dict[str, Any]:
        status, batch = self.request("POST", "/api/batch", {"urls": urls, **body})
        assert status == 202, batch
        return batch

    def wait_for_job(self, job_id: str, timeout: float = 15.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            status, snapshot = self.request("GET", f"/api/jobs/{job_id}")
            assert status == 200, snapshot
            if snapshot["state"] in FINISHED:
                return snapshot
            if time.monotonic() > deadline:
                pytest.fail(f"job {job_id} still {snapshot['state']} after {timeout}s")
            time.sleep(0.05)

    def wait_until_running(self, job_id: str, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while self.request("GET", f"/api/jobs/{job_id}")[1]["state"] != "running":
            assert time.monotonic() < deadline, f"job {job_id} never started"
            time.sleep(0.02)

    def wait_until_downloading(self, count: int = 1, timeout: float = 5.0) -> None:
        """Until the fake downloader has been handed ``count`` episodes: with ``block`` set, the
        running job is then inside that download, past the cooldown check made before it."""
        deadline = time.monotonic() + timeout
        while len(self.downloader.calls) < count:
            assert time.monotonic() < deadline, "the downloader was never reached"
            time.sleep(0.01)

    def batch_snapshots(self, batch: dict[str, Any]) -> list[dict[str, Any]]:
        """Wait for every job of a batch and return their snapshots, in batch order."""
        return [self.wait_for_job(job["job_id"]) for job in batch["jobs"]]

    def jobs(self) -> list[dict[str, Any]]:
        status, data = self.request("GET", "/api/jobs")
        assert status == 200, data
        jobs: list[dict[str, Any]] = data["jobs"]
        return jobs

    def finished_rows(self, **body: Any) -> tuple[str, dict[int, dict[str, Any]]]:
        """Run a job to the end; its id and its rows by episode number."""
        job_id: str = self.start_download(**body)["job_id"]
        snapshot = self.wait_for_job(job_id)
        assert snapshot["state"] == "done", snapshot
        return job_id, {row["number"]: row for row in snapshot["results"]}


@pytest.fixture
def make_harness(tmp_path: Path) -> Iterator[Callable[..., Harness]]:
    servers = []

    def factory(discovery: FakeDiscovery | None = None, *, token: str | None = None) -> Harness:
        discovery = discovery or FakeDiscovery()
        downloader = FakeDownloader()
        out_dir = tmp_path / "downloads"
        server = run_server(
            "127.0.0.1",
            0,
            out_dir,
            # A channel makes the doctor's browser check instant (no Playwright driver start).
            DiscoveryOptions(browser_channel="chromium"),
            # out_dir here is ignored on purpose: the server's out_dir argument is authoritative.
            DownloadOptions(out_dir=Path("ignored"), delay_min_s=0.0, delay_max_s=0.0),
            discovery=discovery,
            downloader=downloader,
            serve_forever=False,
            token=token,
        )
        harness = Harness(server.server_address[1], out_dir, discovery, downloader, server=server)
        # One log for the fakes and the job manager's sleep, which only records (the rest between
        # two jobs is 60-120 s with these options): no test sleeps for real.
        discovery.events = downloader.events = harness.events

        def recorded_sleep(seconds: float) -> None:
            harness.sleeps.append(seconds)
            harness.events.append(("sleep", seconds))

        server.jobs.sleep = recorded_sleep  # type: ignore[attr-defined]
        # A short poll interval keeps shutdown() (fixture teardown) fast.
        thread = threading.Thread(
            target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        thread.start()
        servers.append((server, thread))
        return harness

    yield factory
    for server, thread in servers:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture
def harness(make_harness: Callable[..., Harness]) -> Harness:
    return make_harness()


@pytest.fixture
def locked_harness(make_harness: Callable[..., Harness]) -> Harness:
    """A server started with an access token; requests carry nothing unless a test adds it."""
    return make_harness(token=TOKEN)


def bearer(token: str = TOKEN) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def cookie(token: str = TOKEN) -> dict[str, str]:
    return {"Cookie": f"dramafetch_session={token}"}


# ---------------------------------------------------------------------------- page


def test_index_page_is_served(harness: Harness) -> None:
    status, body = harness.request("GET", "/")
    assert status == 200
    assert "DramaFetch" in body
    assert "does not unlock paid episodes and does not bypass DRM" in body  # the legal notice
    assert 'name="viewport"' in body
    assert "prefers-color-scheme: dark" in body
    assert "<script src=" not in body and "https://cdn" not in body  # no CDN, everything inline
    # A `type="url"` field would make the browser reject a bare series id or a scheme-less address
    # before the request is sent, although /api/resolve accepts both: the server is the validator.
    assert 'id="url" name="url" type="text" required' in body
    assert 'type="url"' not in body
    # The SnapAny-style pieces: covers, the one-click button, Save links, the token form.
    assert "className: 'cover', loading: 'lazy', referrerpolicy: 'no-referrer', alt: ''" in body
    assert 'id="download-all-btn" class="primary">Download all free<' in body
    assert "'Save video'" in body and "'Cover'" in body and "/api/files/" in body
    assert "Files are saved on the computer running DramaFetch" in body
    # Build 4: the hint says where the cover lives and what the Cover link hands out.
    assert "Covers are embedded in the video by default" in body
    assert "the embedded one, or the file saved next to the video" in body
    assert 'id="token-form"' in body and 'id="token" name="token" type="password"' in body
    assert "/api/session" in body and "error.kind !== 'auth'" in body
    assert "localStorage" not in body and "sessionStorage" not in body
    # Build 5: the Refresh link next to the resolved title, the cache note, and the cooldown
    # answer — kind "cooldown" plus Retry-After — that disables the download buttons meanwhile.
    assert "'Refresh list'" in body and "refresh: true" in body and "from_cache" in body
    assert "kept for 15 minutes" in body
    assert "error.kind === 'cooldown'" in body
    assert "response.headers.get('Retry-After')" in body
    assert "|| cooldownActive()" in body and "Downloads are disabled for another" in body
    # Build 6: the "Several series" box, the Jobs panel (polled while a job is queued or running)
    # with its complete / incomplete badges, Save all (ZIP) and the on-disk badges.
    assert 'id="batch-urls"' in body and 'id="batch-btn" class="primary">Queue all<' in body
    assert "api('POST', '/api/batch'" in body and "api('GET', '/api/jobs')" in body
    assert "job.state === 'queued' || job.state === 'running'" in body
    assert "report.complete ? 'complete' : 'incomplete'" in body and "'Details'" in body
    assert "'Save all (ZIP)'" in body and "+ '/all'" in body and 'id="job-zip"' in body
    assert "stored, never recompressed" in body
    assert "className: 'badge ondisk', text: 'on disk'" in body
    assert "row.status === 'skipped-exists'" in body  # Save links for files already on disk


def test_security_headers(harness: Harness) -> None:
    status, headers, _ = harness.raw("GET", "/")
    assert status == 200
    assert headers["X-Content-Type-Options"] == "nosniff"
    csp = headers["Content-Security-Policy"]
    assert "connect-src 'self'" in csp
    assert "img-src 'self' data: https: http:" in csp  # covers come from TikTok's CDN
    assert "Python" not in headers.get("Server", "")


# ---------------------------------------------------------------------------- resolve


def test_resolve_ok(harness: Harness) -> None:
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 200, data
    assert data["series_id"] == SERIES_ID
    assert data["name"] == SERIES_NAME
    assert data["total_hint"] == 5
    assert data["warnings"] == ["1 episodes look locked"]
    assert [episode["number"] for episode in data["episodes"]] == [1, 2, 3, 4, 5]
    first, last = data["episodes"][0], data["episodes"][4]
    assert first["locked"] is False and first["lock_hints"] == []
    assert first["duration_s"] == 91 and first["item_id"] == "7699400000000000001"
    assert first["page_url"] == "https://www.tiktok.com/@muffindrama_us/video/7699400000000000001"
    assert first["cover_url"].startswith(f"{COVER_HOST}/tos-alisg-p-0037/cover01~")
    assert last["locked"] is True and "isFree=false" in last["lock_hints"]
    assert last["cover_url"] is None
    assert data["series_dir"].startswith(str(harness.out_dir))
    assert SERIES_ID in data["series_dir"]
    assert harness.discovery.refs[0] == SeriesRef(SERIES_ID, episode_hint=3, source_url=SERIES_URL)


def test_resolve_accepts_a_bare_series_id(harness: Harness) -> None:
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_ID})
    assert status == 200
    assert data["series_id"] == SERIES_ID


@pytest.mark.parametrize(
    "url",
    ["https://example.com/watch?v=1", "https://vm.tiktok.com/ZMabc123/", "", "   ", "not a url"],
)
def test_resolve_bad_url_is_400(harness: Harness, url: str) -> None:
    status, data = harness.request("POST", "/api/resolve", {"url": url})
    assert status == 400
    assert data["error"]
    assert harness.discovery.refs == []  # rejected before any discovery


def test_resolve_video_url_points_to_the_cli(harness: Harness) -> None:
    status, data = harness.request("POST", "/api/resolve", {"url": VIDEO_URL})
    assert status == 400
    assert "`video`" in data["error"]
    assert harness.discovery.refs == []


def test_resolve_rejects_malformed_bodies(harness: Harness) -> None:
    assert harness.request("POST", "/api/resolve", raw=b"{not json")[0] == 400
    assert harness.request("POST", "/api/resolve", raw=b"[1, 2]")[0] == 400
    assert harness.request("POST", "/api/resolve", raw=b"\xff\xfe")[0] == 400
    status, data = harness.request("POST", "/api/resolve", {"nourl": 1})
    assert status == 400
    assert '"url"' in data["error"]


def test_post_requires_json_content_type(harness: Harness) -> None:
    status, data = harness.request(
        "POST",
        "/api/resolve",
        raw=json.dumps({"url": SERIES_URL}).encode(),
        headers={"Content-Type": "text/plain"},
    )
    assert status == 415
    assert "application/json" in data["error"]


def test_body_too_large_is_413(harness: Harness) -> None:
    raw = b'{"url": "' + b"a" * (MAX_BODY_BYTES + 1) + b'"}'
    status, data = harness.request("POST", "/api/resolve", raw=raw)
    assert status == 413
    assert "64 KiB" in data["error"]


def test_resolve_login_required_is_401_with_cookie_hint(
    make_harness: Callable[..., Harness],
) -> None:
    harness = make_harness(FakeDiscovery(LoginRequiredError("TikTok redirected to /login")))
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 401
    assert data["error"] == "TikTok redirected to /login"
    assert data["kind"] == "LoginRequiredError"  # not "auth": the page must not ask for a token
    assert "--cookies" in data["hint"]


def test_resolve_challenge_is_503_with_headful_hint(make_harness: Callable[..., Harness]) -> None:
    harness = make_harness(FakeDiscovery(ChallengeError("Verify to continue")))
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 503
    assert "--headful" in data["hint"]
    assert "cooldown" in data["hint"]  # the rerun it recommends waits for the cooldown


def test_resolve_rate_limited_is_429_with_a_wait_hint(make_harness: Callable[..., Harness]) -> None:
    harness = make_harness(FakeDiscovery(RateLimitedError("TikTok is rate-limiting (HTTP 429)")))
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 429
    assert data["error"] == "TikTok is rate-limiting (HTTP 429)"
    assert data["kind"] == "RateLimitedError"
    assert "30-60 minutes" in data["hint"]


def test_resolve_discovery_error_is_502(make_harness: Callable[..., Harness]) -> None:
    harness = make_harness(FakeDiscovery(DiscoveryError("page has no episode data")))
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 502
    assert data["error"] == "page has no episode data"
    assert data["kind"] == "DiscoveryError"


# ---------------------------------------------------------------------------- resolve cache


def test_resolve_is_cached_for_fifteen_minutes(harness: Harness) -> None:
    """Resolving the same series twice within the window costs one discovery; the second answer
    says it came from the cache and when the list was fetched."""
    assert web_server.SERIES_CACHE_TTL_S == 15 * 60
    before = time.time()
    status, first = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 200, first
    assert first["from_cache"] is False
    assert before <= first["resolved_at"] <= time.time()
    # Any spelling of the same series — here the bare id — hits the same entry.
    status, second = harness.request("POST", "/api/resolve", {"url": SERIES_ID})
    assert status == 200 and second["from_cache"] is True
    assert second["resolved_at"] == first["resolved_at"]
    assert second["episodes"] == first["episodes"]
    assert second["series_dir"] == first["series_dir"]
    assert len(harness.discovery.refs) == 1
    # Another series is another entry (the fake answers the same list whatever the id).
    status, other = harness.request("POST", "/api/resolve", {"url": OTHER_SERIES_URL})
    assert status == 200 and other["from_cache"] is False
    assert len(harness.discovery.refs) == 2


def test_download_reuses_the_resolved_list(harness: Harness) -> None:
    """Resolve, then Download all free: one discovery, not two — the point of the cache; a
    download without a resolve first fills the cache for the next call."""
    assert harness.request("POST", "/api/resolve", {"url": SERIES_URL})[0] == 200
    job = harness.start_download(episodes="1-2")
    assert harness.wait_for_job(job["job_id"])["state"] == "done"
    assert len(harness.discovery.refs) == 1
    job = harness.start_download(episodes="3")
    assert harness.wait_for_job(job["job_id"])["state"] == "done"
    assert len(harness.discovery.refs) == 1
    # A download of a series never resolved fills the cache for the resolve that follows.
    harness.server.series_cache = web_server.SeriesCache()  # start from an empty cache
    job = harness.start_download(episodes="1")
    assert harness.wait_for_job(job["job_id"])["state"] == "done"
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 200 and data["from_cache"] is True
    assert len(harness.discovery.refs) == 2


def test_refresh_bypasses_the_cache(harness: Harness) -> None:
    status, first = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 200
    status, again = harness.request("POST", "/api/resolve", {"url": SERIES_URL, "refresh": False})
    assert status == 200 and again["from_cache"] is True
    assert len(harness.discovery.refs) == 1
    status, fresh = harness.request("POST", "/api/resolve", {"url": SERIES_URL, "refresh": True})
    assert status == 200 and fresh["from_cache"] is False
    assert fresh["resolved_at"] >= first["resolved_at"]
    assert len(harness.discovery.refs) == 2
    # The fresh list is what the cache holds now.
    status, cached = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert cached["from_cache"] is True and cached["resolved_at"] == fresh["resolved_at"]
    # "refresh" must be a boolean...
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL, "refresh": "yes"})
    assert status == 400 and '"refresh"' in data["error"]
    assert len(harness.discovery.refs) == 2
    # ...and /api/download never refreshes: it takes the list it has.
    harness.start_download(episodes="1", refresh=True)
    assert len(harness.discovery.refs) == 2


def test_a_failed_resolve_is_never_cached(make_harness: Callable[..., Harness]) -> None:
    harness = make_harness(FakeDiscovery(DiscoveryError("page has no episode data")))
    assert harness.request("POST", "/api/resolve", {"url": SERIES_URL})[0] == 502
    assert harness.request("POST", "/api/resolve", {"url": SERIES_URL})[0] == 502
    assert len(harness.discovery.refs) == 2  # tried again: nothing was kept
    harness.discovery.error = None
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 200 and data["from_cache"] is False
    assert harness.request("POST", "/api/resolve", {"url": SERIES_URL})[1]["from_cache"] is True
    assert len(harness.discovery.refs) == 3


def test_a_cached_list_expires_after_the_ttl(harness: Harness) -> None:
    clock = [1_000_000.0]
    harness.server.series_cache.clock = lambda: clock[0]
    status, first = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 200 and first["from_cache"] is False
    assert first["resolved_at"] == 1_000_000.0  # the cache's clock stamps the entry
    clock[0] += web_server.SERIES_CACHE_TTL_S - 1  # 14 min 59 s later: still the same list
    assert harness.request("POST", "/api/resolve", {"url": SERIES_URL})[1]["from_cache"] is True
    clock[0] += 1  # exactly 15 minutes: too old, resolved anew
    status, renewed = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 200 and renewed["from_cache"] is False
    assert renewed["resolved_at"] == clock[0]
    assert len(harness.discovery.refs) == 2


def test_series_cache_keeps_the_32_most_recently_resolved() -> None:
    clock = [0.0]
    cache = web_server.SeriesCache(clock=lambda: clock[0])
    assert web_server.SERIES_CACHE_SIZE == 32 and cache.size == 32
    assert cache.ttl_s == web_server.SERIES_CACHE_TTL_S
    for n in range(33):
        clock[0] += 1
        assert cache.put(f"s{n}", make_series(f"series {n}")) == clock[0]
    assert len(cache) == 32
    assert cache.get("s0") is None  # the oldest made room
    entry = cache.get("s1")
    assert entry is not None and entry[0] == 2.0 and entry[1].name == "series 1"
    # Resolving a series again moves it to the front; the next overflow drops the next oldest.
    clock[0] += 1
    cache.put("s1", make_series("series 1 again"))
    cache.put("s33", make_series("series 33"))
    assert len(cache) == 32 and cache.get("s2") is None
    entry = cache.get("s1")
    assert entry is not None and entry[1].name == "series 1 again"
    # An expired entry is dropped when it is asked for.
    clock[0] += web_server.SERIES_CACHE_TTL_S
    assert cache.get("s1") is None and len(cache) == 31
    assert cache.get("unknown") is None


def test_concurrent_resolves_of_one_series_cost_one_discovery(harness: Harness) -> None:
    """Discoveries run one at a time: a request for a series another request is resolving waits
    and then takes the cached list — never a second browser against TikTok."""
    harness.discovery.block = threading.Event()
    results: list[tuple[int, Any]] = []

    def resolve() -> None:
        results.append(harness.request("POST", "/api/resolve", {"url": SERIES_URL}))

    first = threading.Thread(target=resolve)
    first.start()
    assert harness.discovery.entered.wait(5)  # the first request is inside the discovery...
    second = threading.Thread(target=resolve)
    second.start()  # ...when the second arrives
    harness.discovery.block.set()
    first.join(10)
    second.join(10)
    assert [status for status, _ in results] == [200, 200]
    assert sorted(data["from_cache"] for _, data in results) == [False, True]
    assert len({data["resolved_at"] for _, data in results}) == 1
    assert len(harness.discovery.refs) == 1


def test_resolve_marks_the_episodes_already_on_disk(harness: Harness) -> None:
    """Build 6: every episode says whether its manifest knows it is on disk (done, file present),
    and the list counts them — the page's "on disk" badges. Read at every resolve, cached list or
    not; a file deleted since is no longer on disk."""
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 200
    assert data["on_disk_count"] == 0
    assert [episode["on_disk"] for episode in data["episodes"]] == [False] * 5
    _, rows = harness.finished_rows(episodes="1-2")
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 200 and data["from_cache"] is True
    assert data["on_disk_count"] == 2
    assert [episode["on_disk"] for episode in data["episodes"]] == [True, True, False, False, False]
    Path(rows[1]["path"]).unlink()
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert data["on_disk_count"] == 1
    assert [episode["on_disk"] for episode in data["episodes"]] == [
        False,
        True,
        False,
        False,
        False,
    ]
    assert len(harness.discovery.refs) == 1  # the badges cost no request


def test_on_disk_badges_never_touch_a_corrupt_manifest(harness: Harness) -> None:
    """The badges read the manifest without side effects: a corrupt `dramafetch.json` counts as
    nothing on disk and stays exactly where and what it is (no `.bak`, unlike a download run)."""
    _, rows = harness.finished_rows(episodes="1")
    manifest = Path(rows[1]["path"]).parent / "dramafetch.json"
    manifest.write_text("{not json", encoding="utf-8")
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 200
    assert data["on_disk_count"] == 0
    assert not any(episode["on_disk"] for episode in data["episodes"])
    assert manifest.read_text(encoding="utf-8") == "{not json"
    assert sorted(p.name for p in manifest.parent.iterdir()) == ["E01.mp4", "dramafetch.json"]


def test_on_disk_numbers_is_read_only_and_never_raises(tmp_path: Path) -> None:
    assert web_server.on_disk_numbers(tmp_path / "missing", SERIES_ID) == set()
    assert not (tmp_path / "missing").exists()  # nothing created
    assert web_server.on_disk_numbers(tmp_path, SERIES_ID) == set()


# ---------------------------------------------------------------------------- cooldown


def test_download_is_refused_during_a_cooldown(harness: Harness) -> None:
    """TikTok refused a request less than 30 minutes ago (the cooldown file the engines and the
    CLI write): the web contacts it neither for the list nor for a download — a 429 of kind
    "cooldown" with the engine's message, a hint naming the hour and a Retry-After in seconds,
    before any discovery or job."""
    now = time.time()
    record_block("blocked (HTTP 403): TikTok refused the request", "yt-dlp", now=now)
    status, headers, raw = harness.raw(
        "POST", "/api/download", {"url": SERIES_URL, "episodes": "1"}
    )
    data = json.loads(raw)
    assert status == 429, data
    assert data["kind"] == "cooldown"
    assert data["error"].startswith("TikTok refused a request at ")
    assert "(blocked (HTTP 403): TikTok refused the request)" in data["error"]
    assert "min left) before contacting TikTok again" in data["error"]
    assert "cooldown.json" in data["error"]  # the file to delete, so the user can lift it
    until = time.strftime("%H:%M", time.localtime(now + 30 * 60))
    assert data["hint"] == f"wait; the server refuses to contact TikTok until {until}"
    assert 1790 <= int(headers["Retry-After"]) <= 1800
    assert headers["Content-Type"] == "application/json"
    assert harness.discovery.refs == [] and harness.downloader.calls == []
    # /api/resolve without a cached list is refused the same way.
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 429 and data["kind"] == "cooldown"
    assert harness.discovery.refs == []


def test_a_cached_list_is_still_served_during_a_cooldown(harness: Harness) -> None:
    """Serving a list resolved before the refusal involves no request, so it stays available;
    anything that would contact TikTok — a refresh, another series, a download — is refused
    until the cooldown is lifted."""
    status, first = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 200
    record_block("TikTok is rate-limiting this address (HTTP 429 on the episode list)", "discovery")
    status, cached = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 200 and cached["from_cache"] is True
    assert cached["resolved_at"] == first["resolved_at"]
    for body in (
        {"url": SERIES_URL, "refresh": True},
        {"url": OTHER_SERIES_URL},
    ):
        status, data = harness.request("POST", "/api/resolve", body)
        assert (status, data["kind"]) == (429, "cooldown"), body
    status, data = harness.request("POST", "/api/download", {"url": SERIES_URL, "episodes": "1"})
    assert (status, data["kind"]) == (429, "cooldown")
    assert len(harness.discovery.refs) == 1 and harness.downloader.calls == []
    # Lifting the cooldown (its file deleted) makes everything possible again.
    clear_cooldown()
    status, fresh = harness.request("POST", "/api/resolve", {"url": SERIES_URL, "refresh": True})
    assert status == 200 and fresh["from_cache"] is False
    job = harness.start_download(episodes="1")
    assert harness.wait_for_job(job["job_id"])["state"] == "done"
    assert harness.downloader.calls == [1]


def test_cooldown_error_carries_the_message_the_kind_and_retry_after() -> None:
    now = 1_800_000_000.0
    cooldown = Cooldown(until=now + 90.2, reason="HTTP 429", source="web", recorded_at=now - 10)
    error = web_server.cooldown_error(cooldown, now=now)
    assert error.status == 429 and error.kind == "cooldown"
    assert error.message == cooldown_message(cooldown, now=now)
    assert error.hint == "wait; the server refuses to contact TikTok until " + time.strftime(
        "%H:%M", time.localtime(now + 90.2)
    )
    assert error.headers == (("Retry-After", "91"),)  # whole seconds, rounded up...
    nearly_over = Cooldown(until=now + 0.1, reason="HTTP 429", source="web")
    assert web_server.cooldown_error(nearly_over, now=now).headers == (("Retry-After", "1"),)
    assert web_server.COOLDOWN_KIND == "cooldown"  # ...never 0: the page counts from it


def test_current_cooldown_reads_the_engines_seam(monkeypatch: pytest.MonkeyPatch) -> None:
    """The web asks the engine (`engine.check_cooldown`, the seam every front end uses), which
    reads the cooldown file in the test's state directory."""
    assert web_server.current_cooldown() is None  # no refusal recorded here
    recorded = record_block("HTTP 429", "web")
    assert web_server.current_cooldown() == recorded
    marker = Cooldown(until=recorded.until + 1, reason="from the engine", source="web")
    monkeypatch.setattr(engine, "check_cooldown", lambda: marker, raising=False)
    assert web_server.current_cooldown() is marker
    monkeypatch.setattr(engine, "check_cooldown", lambda: None, raising=False)
    assert web_server.current_cooldown() is None


def test_a_job_queued_behind_a_refusal_does_not_knock_again(harness: Harness) -> None:
    """Job A is downloading when TikTok refuses (the engine records the cooldown); job B, queued
    behind it, is ended as `error` with the cooldown message instead of starting its download."""
    harness.downloader.block = threading.Event()
    first = harness.start_download(episodes="1")
    second = harness.start_download(episodes="2")
    deadline = time.monotonic() + 5
    while harness.request("GET", f"/api/jobs/{first['job_id']}")[1]["state"] != "running":
        assert time.monotonic() < deadline
        time.sleep(0.02)
    assert harness.request("GET", f"/api/jobs/{second['job_id']}")[1]["state"] == "queued"
    harness.wait_until_downloading()  # A holds episode 1: the refusal comes during its download
    record_block("blocked (HTTP 403): TikTok refused the request", "yt-dlp")
    harness.downloader.block.set()
    done = harness.wait_for_job(first["job_id"])
    assert done["state"] == "done"  # already running: its own results decide, not the gate
    refused = harness.wait_for_job(second["job_id"])
    assert refused["state"] == "error" and refused["results"] == []
    assert refused["error"] is not None
    assert refused["error"].startswith("TikTok refused a request at ")
    assert "cooldown.json" in refused["error"]
    assert refused["started_at"] and refused["finished_at"]
    assert harness.downloader.calls == [1]  # episode 2 was never handed to the downloader
    assert len(harness.discovery.refs) == 1  # and the second job reused the list


# ---------------------------------------------------------------------------- download jobs


def test_download_job_runs_to_completion(harness: Harness) -> None:
    job = harness.start_download(episodes=None, include_locked=False)
    assert job["total"] == 5 and job["numbers"] == [1, 2, 3, 4, 5]
    assert job["series_id"] == SERIES_ID

    snapshot = harness.wait_for_job(job["job_id"])
    assert snapshot["state"] == "done"
    assert snapshot["error"] is None
    assert snapshot["series_name"] == SERIES_NAME
    assert snapshot["started_at"] and snapshot["finished_at"]
    statuses = {row["number"]: row["status"] for row in snapshot["results"]}
    assert statuses == {1: "done", 2: "done", 3: "done", 4: "done", 5: "skipped-locked"}
    locked_row = snapshot["results"][4]
    assert "isFree=false" in locked_row["message"] and locked_row["path"] is None
    assert locked_row["file_name"] is None and locked_row["thumbnail"] is False
    assert harness.downloader.calls == [1, 2, 3, 4, 5]

    _, resolved = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    series_dir = Path(resolved["series_dir"])
    assert series_dir.parent == harness.out_dir  # the UI cannot choose paths
    assert sorted(p.name for p in series_dir.glob("*.mp4")) == [f"E0{n}.mp4" for n in range(1, 5)]
    assert (series_dir / "dramafetch.json").is_file()
    for row in snapshot["results"][:4]:
        assert Path(row["path"]).is_file()
        assert row["file_name"] == Path(row["path"]).name
        assert row["thumbnail"] is False  # this downloader saved no covers


def test_download_selection_and_include_locked(harness: Harness) -> None:
    job = harness.start_download(episodes="4-5", include_locked=True)
    assert job["numbers"] == [4, 5]
    snapshot = harness.wait_for_job(job["job_id"])
    assert snapshot["state"] == "done"
    assert {row["number"]: row["status"] for row in snapshot["results"]} == {4: "done", 5: "done"}


def test_download_defaults_to_the_servers_include_locked(harness: Harness) -> None:
    job = harness.start_download(episodes="5")
    snapshot = harness.wait_for_job(job["job_id"])
    assert [row["status"] for row in snapshot["results"]] == ["skipped-locked"]


def test_second_run_skips_what_the_manifest_knows(harness: Harness) -> None:
    first = harness.wait_for_job(harness.start_download()["job_id"])
    assert first["state"] == "done"
    second = harness.wait_for_job(harness.start_download()["job_id"])
    statuses = {row["number"]: row["status"] for row in second["results"]}
    assert statuses == {
        1: "skipped-exists",
        2: "skipped-exists",
        3: "skipped-exists",
        4: "skipped-exists",
        5: "skipped-locked",
    }
    # Episodes 1-4 were not handed to the downloader again; the locked one is re-evaluated.
    assert harness.downloader.calls == [1, 2, 3, 4, 5, 5]


@pytest.mark.parametrize(
    ("body", "fragment"),
    [
        ({"episodes": "abc"}, "invalid episode spec"),
        ({"episodes": "99"}, "no listed episode"),
        ({"episodes": 5}, '"episodes"'),
        ({"include_locked": "yes"}, '"include_locked"'),
        ({"url": VIDEO_URL}, "`video`"),
    ],
)
def test_download_rejects_bad_requests(
    harness: Harness, body: dict[str, Any], fragment: str
) -> None:
    status, data = harness.request("POST", "/api/download", {"url": SERIES_URL, **body})
    assert status == 400, data
    assert fragment in data["error"]


# ---------------------------------------------------------------------------- batches (build 6)


def test_the_second_series_is_the_one_the_fake_tiktok_serves() -> None:
    """The in-file second series is the fake TikTok's (tests/integration/fake_tiktok.py serves
    fixtures/item_list_series2.json, the one page of "Second Chance Bride"): the same episodes —
    numbers, item ids, titles, author, durations, none locked — and as many as TikTok announces,
    so the web tests and the integration tests talk about one series."""
    payload = json.loads(
        (Path(__file__).parent / "fixtures" / "item_list_series2.json").read_text(encoding="utf-8")
    )
    page = parse_item_list_payload(payload, SECOND_SERIES_ID)
    series = make_second_series()

    def identity(episode: Episode) -> tuple[Any, ...]:
        return (
            episode.number,
            episode.item_id,
            episode.title,
            episode.series_id,
            episode.series_name,
            episode.author,
            episode.duration_s,
            episode.locked,
        )

    assert [identity(e) for e in series.episodes] == [identity(e) for e in page.episodes]
    assert page.has_more is False and page.skipped_items == 0
    assert series.total_hint == len(page.episodes) == 3
    assert {episode.series_name for episode in page.episodes} == {SECOND_SERIES_NAME}


def test_batch_queues_one_job_per_series_and_resolves_nothing_in_the_request(
    harness: Harness,
) -> None:
    """POST /api/batch parses every entry and queues one job per series — duplicates dropped —
    each holding nothing but its reference: the request makes no discovery at all. The jobs then
    run one at a time; the series the download job resolved comes from the cache."""
    harness.downloader.block = threading.Event()
    first = harness.start_download(episodes="1")  # keeps the worker busy meanwhile
    harness.wait_until_running(first["job_id"])
    discoveries = len(harness.discovery.refs)
    urls = [SERIES_URL, SECOND_SERIES_URL, SERIES_ID, f"  {SECOND_SERIES_URL}  "]
    status, batch = harness.request("POST", "/api/batch", {"urls": urls})
    assert status == 202, batch
    assert len(harness.discovery.refs) == discoveries  # nothing resolved by the request
    assert set(batch) == {"batch_id", "jobs", "dropped"}
    assert [job["series_id"] for job in batch["jobs"]] == [SERIES_ID, SECOND_SERIES_ID]
    assert batch["dropped"] == [
        {"index": 2, "series_id": SERIES_ID, "reason": "duplicate of entry 1"},
        {"index": 3, "series_id": SECOND_SERIES_ID, "reason": "duplicate of entry 2"},
    ]
    for job in batch["jobs"]:
        status, queued = harness.request("GET", f"/api/jobs/{job['job_id']}")
        assert status == 200 and queued["state"] == "queued"
        assert queued["batch_id"] == batch["batch_id"] and queued["series_id"] == job["series_id"]
        assert queued["series_name"] is None and queued["total"] is None
        assert queued["report"] is None and queued["results"] == []
    harness.downloader.block.set()
    done = harness.batch_snapshots(batch)
    assert [snapshot["state"] for snapshot in done] == ["done", "done"]
    assert [snapshot["series_name"] for snapshot in done] == [SERIES_NAME, SECOND_SERIES_NAME]
    assert [snapshot["total"] for snapshot in done] == [5, 3]
    assert [ref.series_id for ref in harness.discovery.refs[discoveries:]] == [SECOND_SERIES_ID]
    assert harness.wait_for_job(first["job_id"])["batch_id"] is None  # a download job has none


def test_batch_jobs_run_one_after_the_other_with_a_rest_between_them(harness: Harness) -> None:
    """Each series is resolved right before its own downloads — never both lists up front — and
    between the two jobs, both of which contact TikTok, the worker rests rest_min_s-rest_max_s
    (60-120 s here: recorded, never slept). Both series end complete."""
    batch = harness.start_batch([SERIES_URL, SECOND_SERIES_URL])
    first, second = harness.batch_snapshots(batch)
    rests = [event for event in harness.events if event[0] == "sleep"]
    assert len(rests) == 1 and 60.0 <= rests[0][1] <= 120.0
    assert harness.events == [
        ("discover", SERIES_ID),
        *[("download", SERIES_ID, number) for number in range(1, 6)],
        rests[0],
        ("discover", SECOND_SERIES_ID),
        *[("download", SECOND_SERIES_ID, number) for number in range(1, 4)],
    ]
    for snapshot, name, total in ((first, SERIES_NAME, 5), (second, SECOND_SERIES_NAME, 3)):
        assert snapshot["state"] == "done" and snapshot["error"] is None
        assert snapshot["series_name"] == name and snapshot["total"] == total
        assert snapshot["processed"] == total and snapshot["pause"] is None
        assert snapshot["report"]["complete"] is True
        assert snapshot["report"]["skipped_complete"] is False
    assert first["report"]["line"] == "complete: 4 of 5 (4 downloaded) — 1 locked (5)"
    assert second["report"]["line"] == "complete: 3 of 3 (3 downloaded)"
    assert first["counts"] == {"done": 4, "skipped-locked": 1} and first["files"] == 4
    assert second["counts"] == {"done": 3} and second["files"] == 3
    assert first["finished_at"] <= second["started_at"]
    # The lists went into the cache: resolving either costs nothing now.
    status, data = harness.request("POST", "/api/resolve", {"url": SECOND_SERIES_URL})
    assert status == 200 and data["from_cache"] is True and data["on_disk_count"] == 3
    assert len(harness.discovery.refs) == 2


def test_the_long_break_comes_before_the_next_batch_jobs_resolve(harness: Harness) -> None:
    """The run's long break (every long_rest_every = 100 network attempts of the server's
    lifetime) falls between two batch jobs: it is taken right before the second job's resolve, in
    place of the rest between jobs — not after the resolve, where the fresh list would wait 15-30
    min, and not on top of that rest — and the count starts again, as engine.run_batch does
    between two series of a CLI batch."""
    jobs = harness.server.jobs
    jobs.clock = lambda: 1000.0  # no idle gap that would count as the break
    record = jobs.sleep
    kinds: list[str] = []

    def sleep(seconds: float) -> None:
        running = jobs.get(jobs.running)
        assert running is not None and running["pause"] is not None
        kinds.append(running["pause"]["kind"])
        record(seconds)

    jobs.sleep = sleep
    jobs.pacing.run_attempts = 96  # the first series' four free episodes make it 100
    batch = harness.start_batch([SERIES_URL, SECOND_SERIES_URL])
    first, second = harness.batch_snapshots(batch)
    rests = [event for event in harness.events if event[0] == "sleep"]
    assert len(rests) == 1 and 900.0 <= rests[0][1] <= 1800.0 and kinds == ["long-rest"]
    assert harness.events == [
        ("discover", SERIES_ID),
        *[("download", SERIES_ID, number) for number in range(1, 6)],
        rests[0],
        ("discover", SECOND_SERIES_ID),
        *[("download", SECOND_SERIES_ID, number) for number in range(1, 4)],
    ]
    assert jobs.pacing.run_attempts == 3  # counted again from the break: the second series' 3
    assert first["report"]["complete"] is True and second["report"]["complete"] is True
    assert second["pause"] is None


def test_a_series_complete_on_disk_costs_no_request_the_second_time(harness: Harness) -> None:
    """A batch run that found its series complete marked the manifest: queued again within 24 h
    the series is skipped without any request — no discovery, no download, no rest — and its rows
    are the files already on disk, servable like downloaded ones."""
    (first,) = harness.batch_snapshots(harness.start_batch([SERIES_URL]))
    assert first["report"]["complete"] is True
    seen = len(harness.events)
    (again,) = harness.batch_snapshots(harness.start_batch([SERIES_ID]))
    assert harness.events[seen:] == []  # no discovery, no download, no rest
    assert again["state"] == "done" and again["series_name"] == SERIES_NAME
    assert again["total"] == 4 and again["files"] == 4
    assert again["report"]["skipped_complete"] is True
    assert again["report"]["line"] == (
        "complete, nothing to do: 4 episodes already on disk (checked just now)"
    )
    assert [row["status"] for row in again["results"]] == ["skipped-exists"] * 4
    assert all(
        row["message"].startswith("already downloaded (manifest): ") for row in again["results"]
    )
    status, _, data = harness.raw("GET", f"/api/files/{again['id']}/1")
    assert status == 200 and data == b"fake video"


def test_recheck_resolves_a_series_its_manifest_calls_complete(harness: Harness) -> None:
    """`serve --recheck`: a complete series is resolved again (here with no list in the cache, so
    one discovery), every episode skipped as on disk."""
    harness.batch_snapshots(harness.start_batch([SERIES_URL]))
    harness.server.series_cache = web_server.SeriesCache()  # no list kept: a resolve is a request
    harness.server.download_options = replace(harness.server.download_options, recheck=True)
    (again,) = harness.batch_snapshots(harness.start_batch([SERIES_URL]))
    assert [ref.series_id for ref in harness.discovery.refs] == [SERIES_ID, SERIES_ID]
    assert again["report"]["skipped_complete"] is False and again["report"]["complete"] is True
    statuses = [row["status"] for row in again["results"]]
    assert statuses == ["skipped-exists"] * 4 + ["skipped-locked"]


def test_batch_takes_up_to_fifty_entries(harness: Harness) -> None:
    assert web_server.MAX_BATCH_SERIES == 50
    batch = harness.start_batch([SERIES_URL, SECOND_SERIES_URL] * 25)
    assert len(batch["jobs"]) == 2 and len(batch["dropped"]) == 48
    assert [snapshot["state"] for snapshot in harness.batch_snapshots(batch)] == ["done", "done"]


@pytest.mark.parametrize(
    ("body", "fragment", "index"),
    [
        ({}, '"urls" must list 1 to 50 series URLs', None),
        ({"urls": SERIES_URL}, '"urls" must list', None),
        ({"urls": []}, '"urls" must list', None),
        ({"urls": [SERIES_URL] * 51}, '"urls" must list 1 to 50', None),
        ({"urls": [SERIES_URL, 7]}, "entry 2: not a series URL or id", 1),
        ({"urls": [SERIES_URL, "   "]}, "entry 2: not a series URL or id", 1),
        ({"urls": [SERIES_URL, VIDEO_URL]}, "entry 2: That is a single video", 1),
        (
            {"urls": [SERIES_URL, SECOND_SERIES_URL, "https://example.com/watch?v=1"]},
            "entry 3: Not a TikTok short-drama or video URL",
            2,
        ),
        ({"urls": ["https://vm.tiktok.com/ZMabc123/"]}, "entry 1: Short links", 0),
        ({"urls": [SERIES_URL], "include_locked": "yes"}, '"include_locked"', None),
        ({"urls": [SERIES_URL], "episodes": "1-3"}, '"episodes" does not apply to a batch', None),
    ],
)
def test_batch_refuses_bad_requests_naming_the_entry(
    harness: Harness, body: dict[str, Any], fragment: str, index: int | None
) -> None:
    status, data = harness.request("POST", "/api/batch", body)
    assert status == 400, data
    assert fragment in data["error"]
    assert data.get("index") == index
    assert harness.jobs() == [] and harness.discovery.refs == []  # nothing queued, nothing fetched


def test_batch_is_refused_during_a_cooldown(harness: Harness) -> None:
    """The same 429 as /api/download, before any job is queued; a malformed entry is still the 400
    that names it."""
    record_block("TikTok is rate-limiting this address (HTTP 429)", "browser")
    status, headers, raw = harness.raw(
        "POST", "/api/batch", {"urls": [SERIES_URL, SECOND_SERIES_URL]}
    )
    data = json.loads(raw)
    assert status == 429 and data["kind"] == "cooldown"
    assert data["error"].startswith("TikTok refused a request at ")
    assert data["hint"].startswith("wait; the server refuses to contact TikTok until ")
    assert 1790 <= int(headers["Retry-After"]) <= 1800
    status, data = harness.request("POST", "/api/batch", {"urls": [VIDEO_URL]})
    assert status == 400 and data["index"] == 0
    assert harness.jobs() == [] and harness.discovery.refs == []


def test_a_refusal_in_a_download_job_cancels_the_queued_batch(harness: Harness) -> None:
    """Job A meets HTTP 429 at its second episode: the engine stops it and records the cooldown,
    and every job queued behind A — a whole batch here — is cancelled with "not started: …"
    without a single request: no discovery, no download, no rest."""
    harness.downloader.block = threading.Event()
    harness.downloader.outcomes[(SERIES_ID, 2)] = (
        DownloadStatus.FAILED_RATE_LIMITED,
        "HTTP Error 429: Too Many Requests",
    )
    first = harness.start_download()
    harness.wait_until_running(first["job_id"])
    batch = harness.start_batch([SECOND_SERIES_URL, OTHER_SERIES_URL])
    harness.downloader.block.set()
    stopped = harness.wait_for_job(first["job_id"])
    assert stopped["state"] == "done"
    assert [row["status"] for row in stopped["results"]] == [
        "done",
        "failed-rate-limited",
        "failed-rate-limited",
        "failed-rate-limited",
        "skipped-locked",
    ]
    assert stopped["report"]["complete"] is False
    assert stopped["report"]["stopped"] == "episode 2 failed-rate-limited"
    expected = f"not started: batch stopped in {SERIES_NAME} (episode 2 failed-rate-limited)"
    for snapshot in harness.batch_snapshots(batch):
        assert snapshot["state"] == "cancelled" and snapshot["error"] == expected
        assert snapshot["results"] == [] and snapshot["report"] is None
        assert snapshot["started_at"] is None and snapshot["finished_at"]
    assert [ref.series_id for ref in harness.discovery.refs] == [SERIES_ID]  # A's own resolve
    assert harness.downloader.series_calls == [(SERIES_ID, 1), (SERIES_ID, 2)]
    assert harness.sleeps == []
    assert active_cooldown() is not None  # the engine recorded the refusal...
    status, data = harness.request("POST", "/api/batch", {"urls": [SECOND_SERIES_URL]})
    assert (status, data["kind"]) == (429, "cooldown")  # ...so nothing new is queued either


def test_a_refusal_in_a_batch_job_cancels_the_rest_of_the_batch(harness: Harness) -> None:
    harness.downloader.outcomes[(SERIES_ID, 3)] = (
        DownloadStatus.FAILED_BLOCKED,
        "blocked (HTTP 403): TikTok refused the request",
    )
    stopped, cancelled = harness.batch_snapshots(
        harness.start_batch([SERIES_URL, SECOND_SERIES_URL])
    )
    assert stopped["state"] == "done"
    assert stopped["report"]["stopped"] == "episode 3 failed-blocked"
    assert cancelled["state"] == "cancelled"
    assert cancelled["error"] == (
        f"not started: batch stopped in {SERIES_NAME} (episode 3 failed-blocked)"
    )
    assert [ref.series_id for ref in harness.discovery.refs] == [SERIES_ID]
    assert {series_id for series_id, _ in harness.downloader.series_calls} == {SERIES_ID}
    assert active_cooldown() is not None


def test_a_failed_resolve_in_a_batch_cancels_the_rest_of_it(harness: Harness) -> None:
    """A login wall met while resolving the first series ends the batch: that job is `error` with
    the discovery's message, the queued one is cancelled and never resolved — no cooldown is
    involved here, the cancellation alone keeps it quiet."""
    harness.discovery.errors[SERIES_ID] = LoginRequiredError("TikTok redirected to /login")
    failed, cancelled = harness.batch_snapshots(
        harness.start_batch([SERIES_URL, SECOND_SERIES_URL])
    )
    assert failed["state"] == "error" and failed["error"] == "TikTok redirected to /login"
    assert failed["report"]["stopped"] == "login required"
    assert failed["report"]["complete"] is False
    assert cancelled["state"] == "cancelled"
    assert cancelled["error"] == f"not started: batch stopped in {SERIES_ID} (login required)"
    assert [ref.series_id for ref in harness.discovery.refs] == [SERIES_ID]
    assert harness.downloader.calls == []
    assert active_cooldown() is None


def test_a_cooldown_recorded_meanwhile_ends_the_queued_jobs(harness: Harness) -> None:
    """TikTok refused a request (another process, a resolve of this server) while job A was
    downloading: B, next in line, is refused by the gate with the cooldown message before any
    request, and C behind it is cancelled."""
    harness.downloader.block = threading.Event()
    first = harness.start_download(episodes="1")
    harness.wait_until_running(first["job_id"])
    batch = harness.start_batch([SECOND_SERIES_URL, OTHER_SERIES_URL])
    harness.wait_until_downloading()  # A holds episode 1: the refusal comes during its download
    record_block("blocked (HTTP 403): TikTok refused the request", "yt-dlp")
    harness.downloader.block.set()
    assert harness.wait_for_job(first["job_id"])["state"] == "done"
    refused, cancelled = harness.batch_snapshots(batch)
    assert refused["state"] == "error" and refused["results"] == []
    assert refused["error"].startswith("TikTok refused a request at ")
    assert cancelled["state"] == "cancelled"
    assert cancelled["error"].startswith(
        f"not started: batch stopped in {SECOND_SERIES_ID} (TikTok refused a request at "
    )
    assert [ref.series_id for ref in harness.discovery.refs] == [SERIES_ID]
    assert harness.downloader.series_calls == [(SERIES_ID, 1)]


def test_two_download_jobs_rest_between_them_and_a_job_of_skips_does_not(
    harness: Harness,
) -> None:
    harness.wait_for_job(harness.start_download(episodes="1-2")["job_id"])
    assert harness.sleeps == []  # the first job of the server: nothing to rest after
    harness.wait_for_job(harness.start_download(episodes="3")["job_id"])
    assert len(harness.sleeps) == 1 and 60.0 <= harness.sleeps[0] <= 120.0
    # Everything this job selects is on disk already: no request, so no rest either.
    skipped = harness.wait_for_job(harness.start_download(episodes="1-3")["job_id"])
    assert [row["status"] for row in skipped["results"]] == ["skipped-exists"] * 3
    assert len(harness.sleeps) == 1
    assert skipped["report"]["complete"] is False  # 4 is not on disk yet
    assert skipped["report"]["line"].startswith("incomplete: 3 of 5")


def test_jobs_list_most_recent_first_without_rows(harness: Harness) -> None:
    single = harness.wait_for_job(harness.start_download(episodes="1")["job_id"])
    batch = harness.start_batch([SERIES_URL, SECOND_SERIES_URL])
    harness.batch_snapshots(batch)
    jobs = harness.jobs()
    assert [job["id"] for job in jobs] == [
        batch["jobs"][1]["job_id"],
        batch["jobs"][0]["job_id"],
        single["id"],
    ]
    for job in jobs:
        assert "results" not in job
        assert set(job) >= {"id", "batch_id", "state", "series_id", "series_name", "total"}
        assert set(job) >= {"processed", "counts", "files", "report", "error", "pause"}
    second, first, download = jobs
    assert second["batch_id"] == first["batch_id"] == batch["batch_id"]
    assert download["batch_id"] is None
    assert first["counts"] == {"done": 3, "skipped-exists": 1, "skipped-locked": 1}
    assert first["processed"] == 5 and first["files"] == 4
    assert download["report"]["line"].startswith("incomplete: 1 of 5")


def test_unknown_job_is_404(harness: Harness) -> None:
    status, data = harness.request("GET", "/api/jobs/nope")
    assert status == 404
    assert data == {"error": "unknown job", "kind": "HttpError"}
    assert harness.request("GET", "/api/jobs/")[0] == 404


def test_unknown_paths_are_404_json(harness: Harness) -> None:
    status, data = harness.request("GET", "/nope")
    assert status == 404 and "error" in data
    status, data = harness.request("POST", "/api/nope", {"url": SERIES_URL})
    assert status == 404 and "error" in data


def test_host_header_guard(harness: Harness) -> None:
    status, data = harness.request("GET", "/", headers={"Host": "evil.example"})
    assert status == 403
    assert data["error"] == "unexpected Host header"
    assert harness.request("GET", "/", headers={"Host": f"localhost:{harness.port}"})[0] == 200
    assert harness.request("GET", "/", headers={"Host": "127.0.0.1"})[0] == 200


def test_host_guard_for_a_wildcard_bind_accepts_addresses_but_no_other_name() -> None:
    """Bound to every interface the server cannot know its addresses, so any IP literal passes —
    `http://<pc-ip>:8765/` — but no other host name does: a DNS-rebinding attacker needs a name
    they control, never an address. A pure function, so nothing is bound off loopback here."""
    for bound in ("0.0.0.0", "::"):
        for host in (
            "192.168.1.20:8765",
            "192.168.1.20",
            "10.0.0.7:80",
            "0.0.0.0:8765",
            "[fe80::1]:8765",
            "[2001:db8::7]",
            "localhost",
            "LOCALHOST:8765",
            "127.0.0.1:8765",
            "[::1]:8765",
        ):
            assert host_header_allowed(bound, host), (bound, host)
        for host in (
            "evil.example:8765",
            "evil.example",
            "mypc.local",
            "192.168.1.20.evil.example",
            "localhost.evil.example:8765",
            "192.168.1.999",
            "[]",
            "",
            None,
        ):
            assert not host_header_allowed(bound, host), (bound, host)
    # A specific bind stays as strict as before: that host or localhost, the port ignored.
    assert host_header_allowed("192.168.1.20", "192.168.1.20:8765")
    assert host_header_allowed("192.168.1.20", "localhost:8765")
    assert not host_header_allowed("192.168.1.20", "192.168.1.21:8765")
    assert not host_header_allowed("192.168.1.20", "evil.example:8765")
    assert not host_header_allowed("127.0.0.1", "192.168.1.20:8765")
    assert host_header_allowed("::1", "[::1]:8765")
    assert host_header_allowed("example.lan", "example.lan")


def test_wildcard_bind_host_guard_through_the_handler(tmp_path: Path) -> None:
    """The handler consults the guard with the bound host: a loopback-bound server told it is bound
    to 0.0.0.0 answers IP literals and refuses a name with 403, before the token is looked at."""
    server = run_server(
        "127.0.0.1",
        0,
        tmp_path,
        DiscoveryOptions(),
        DownloadOptions(),
        serve_forever=False,
        token=TOKEN,
    )
    server.bound_host = "0.0.0.0"  # type: ignore[attr-defined] - the socket stays on loopback
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05})
    thread.start()
    try:
        harness = Harness(server.server_address[1], tmp_path, FakeDiscovery(), FakeDownloader())
        assert harness.request("GET", "/", headers={"Host": "192.168.1.20:8765"})[0] == 200
        assert harness.request("GET", "/", headers={"Host": "[fe80::1]:8765"})[0] == 200
        status, data = harness.request("GET", "/", headers={"Host": "evil.example:8765"})
        assert (status, data["error"]) == (403, "unexpected Host header")
        status, data = harness.request(
            "GET", "/api/doctor", headers={"Host": "mypc.local", **bearer()}
        )
        assert (status, data["error"]) == (403, "unexpected Host header")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


# ---------------------------------------------------------------------------- access token


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("POST", "/api/resolve", {"url": SERIES_URL}),
        ("POST", "/api/download", {"url": SERIES_URL, "episodes": "1"}),
        ("GET", "/api/jobs/nope", None),
        ("GET", "/api/doctor", None),
        ("GET", "/api/files/nope/1", None),
        ("GET", "/api/files/nope/1/cover", None),
        ("POST", "/api/batch", {"urls": [SERIES_URL, SECOND_SERIES_URL]}),
        ("GET", "/api/jobs", None),
        ("GET", "/api/files/nope/all", None),
        ("GET", "/api/nope", None),  # unknown routes are refused too: deny by default
        ("POST", "/index.html", {"url": SERIES_URL}),
    ],
)
def test_every_api_route_needs_the_token(
    locked_harness: Harness, method: str, path: str, body: Any
) -> None:
    status, data = locked_harness.request(method, path, body)
    assert status == 401
    assert data == {
        "error": "token required",
        "kind": "auth",
        "hint": "enter the token the server was started with",
    }
    assert locked_harness.discovery.refs == []  # refused before any request to TikTok


def test_the_page_needs_no_token(locked_harness: Harness) -> None:
    assert locked_harness.request("GET", "/")[0] == 200
    assert locked_harness.request("GET", "/index.html")[0] == 200
    status, headers, _ = locked_harness.raw("GET", "/api/doctor")
    assert status == 401
    assert headers["WWW-Authenticate"] == 'Bearer realm="DramaFetch"'
    assert headers["Content-Type"] == "application/json"


def test_bearer_header_works(locked_harness: Harness) -> None:
    status, data = locked_harness.request(
        "POST", "/api/resolve", {"url": SERIES_URL}, headers=bearer()
    )
    assert status == 200 and data["series_id"] == SERIES_ID
    assert locked_harness.request("GET", "/api/jobs/nope", headers=bearer())[0] == 404
    scheme_case = {"Authorization": f"bearer  {TOKEN} "}  # the scheme is case-insensitive
    assert locked_harness.request("GET", "/api/jobs/nope", headers=scheme_case)[0] == 404
    for wrong in (
        "Bearer not-the-token-at-all",
        "Bearer",
        f"Bearer {TOKEN}x",
        f"Bearer {TOKEN[:-1]}",
        f"Basic {TOKEN}",
        f"Token {TOKEN}",
        TOKEN,
    ):
        status, data = locked_harness.request(
            "GET", "/api/jobs/nope", headers={"Authorization": wrong}
        )
        assert (status, data["kind"]) == (401, "auth"), wrong


def test_session_cookie_is_set_by_the_right_token(locked_harness: Harness) -> None:
    status, headers, data = locked_harness.raw("POST", "/api/session", {"token": TOKEN})
    assert status == 204 and data == b""
    assert "Content-Length" not in headers and "Content-Type" not in headers  # a bare 204
    attributes = [part.strip() for part in headers["Set-Cookie"].split(";")]
    assert attributes[0] == f"dramafetch_session={TOKEN}"
    assert set(attributes[1:]) == {"HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=2592000"}
    assert headers["Cache-Control"] == "no-store"
    # The cookie now authorises every route, among other cookies too.
    assert locked_harness.request("GET", "/api/jobs/nope", headers=cookie())[0] == 404
    crowded = {"Cookie": f"theme=dark; dramafetch_session={TOKEN}; other=1"}
    assert locked_harness.request("GET", "/api/jobs/nope", headers=crowded)[0] == 404
    status, data = locked_harness.request(
        "POST", "/api/resolve", {"url": SERIES_URL}, headers=cookie()
    )
    assert status == 200 and data["series_id"] == SERIES_ID


def test_session_rejects_wrong_tokens_at_once(locked_harness: Harness) -> None:
    started = time.monotonic()
    status, data = locked_harness.request("POST", "/api/session", {"token": "not-the-token"})
    assert status == 401
    assert data == {
        "error": "wrong token",
        "kind": "auth",
        "hint": "enter the token the server was started with",
    }
    assert time.monotonic() - started < 2  # no sleep, no lockout
    for body in ({"token": 123}, {"nope": TOKEN}, {"token": None}, {"token": [TOKEN]}):
        assert locked_harness.request("POST", "/api/session", body)[0] == 400, body
    # A wrong cookie value is a 401 like a wrong header; an empty one counts as absent.
    assert locked_harness.request("GET", "/api/jobs/nope", headers=cookie("wrong-value"))[0] == 401
    assert locked_harness.request("GET", "/api/jobs/nope", headers=cookie(""))[0] == 401
    assert locked_harness.request("GET", "/api/jobs/nope", headers=cookie(TOKEN[:-1]))[0] == 401


def test_only_the_first_session_cookie_is_a_candidate(locked_harness: Harness) -> None:
    """A request presents at most two credentials: the Bearer token and the first session cookie.
    Checking every `dramafetch_session=` value of every `Cookie` header would let one request try
    some 180 000 guesses (http.server reads 100 header lines of 64 KiB), turning a dictionary
    attack on a weak token from hours into seconds."""
    assert locked_harness.request("GET", "/api/jobs/nope", headers=cookie())[0] == 404
    wrong_first = {"Cookie": f"dramafetch_session=wrong-value; dramafetch_session={TOKEN}"}
    assert locked_harness.request("GET", "/api/jobs/nope", headers=wrong_first)[0] == 401
    right_first = {"Cookie": f"dramafetch_session={TOKEN}; dramafetch_session=wrong-value"}
    assert locked_harness.request("GET", "/api/jobs/nope", headers=right_first)[0] == 404
    guesses = [f"dramafetch_session=guess{i}" for i in range(50)]
    many = {"Cookie": "; ".join([*guesses, f"dramafetch_session={TOKEN}"])}
    assert locked_harness.request("GET", "/api/jobs/nope", headers=many)[0] == 401
    # The same across several Cookie headers: only the first session cookie seen is checked...
    two_headers = [
        ("Cookie", "dramafetch_session=wrong-value"),
        ("Cookie", f"dramafetch_session={TOKEN}"),
    ]
    assert locked_harness.status_with_header_lines("GET", "/api/jobs/nope", two_headers) == 401
    # ...other cookies before it do not count, and an empty value is no candidate.
    crowded = [
        ("Cookie", "theme=dark; dramafetch_session="),
        ("Cookie", f"other=1; dramafetch_session={TOKEN}"),
    ]
    assert locked_harness.status_with_header_lines("GET", "/api/jobs/nope", crowded) == 404
    # A Bearer token is checked in its own right, whatever cookie comes with it.
    both = {**bearer(), **cookie("wrong-value")}
    assert locked_harness.request("GET", "/api/jobs/nope", headers=both)[0] == 404


def test_session_endpoint_without_a_server_token_is_400(harness: Harness) -> None:
    status, data = harness.request("POST", "/api/session", {"token": TOKEN})
    assert status == 400
    assert "without a token" in data["error"]


def test_host_guard_comes_before_the_token(locked_harness: Harness) -> None:
    status, data = locked_harness.request(
        "GET", "/api/doctor", headers={"Host": "evil.example", **bearer()}
    )
    assert status == 403 and data["error"] == "unexpected Host header"


def test_token_is_never_logged(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="dramafetch.web")
    server = run_server(
        "127.0.0.1",
        0,
        tmp_path,
        DiscoveryOptions(),
        DownloadOptions(),
        serve_forever=False,
        token=TOKEN,
    )
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05})
    thread.start()
    try:
        harness = Harness(server.server_address[1], tmp_path, FakeDiscovery(), FakeDownloader())
        assert harness.request("GET", "/api/jobs/nope")[0] == 401
        assert harness.request("GET", "/api/jobs/nope", headers=bearer())[0] == 404
        assert harness.raw("POST", "/api/session", {"token": TOKEN})[0] == 204
        assert harness.raw("POST", "/api/session", {"token": "wrong-token-value"})[0] == 401
        assert harness.request("GET", "/api/jobs/nope", headers=cookie())[0] == 404
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert "token: set" in caplog.text
    assert "/api/session" in caplog.text  # request lines are logged...
    assert TOKEN not in caplog.text and "wrong-token-value" not in caplog.text  # ...values never


def test_off_loopback_binding_needs_a_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    binds: list[Any] = []
    monkeypatch.setattr(web_server.DramaFetchServer, "server_bind", lambda self: binds.append(self))
    for host in ("0.0.0.0", "::", "[::]", "192.168.1.20", "example.lan"):
        with pytest.raises(ValueError, match="needs an access token"):
            run_server(
                host, 0, tmp_path, DiscoveryOptions(), DownloadOptions(), serve_forever=False
            )
    assert binds == []  # refused before any socket was bound


def test_server_refuses_an_unusable_token(tmp_path: Path) -> None:
    for bad in ("", "short", "has a space", 'quo"te-token', "semi;colon", "back\\slash", "com,ma"):
        with pytest.raises(ValueError, match="the token must"):
            run_server(
                "127.0.0.1",
                0,
                tmp_path,
                DiscoveryOptions(),
                DownloadOptions(),
                serve_forever=False,
                token=bad,
            )
    assert token_problem("short") == "the token must be at least 8 characters"
    assert token_problem("ünïcödé-token") is not None and "ASCII" in (
        token_problem("tab\there") or ""
    )
    assert token_problem("correct-horse-battery-staple") is None
    assert token_problem("A1!#$%&'()*+-./:<=>?@[]^_`{|}~") is None  # every cookie-safe punctuation


def test_is_loopback_host() -> None:
    for host in ("127.0.0.1", " 127.0.0.1 ", "127.0.0.2", "::1", "[::1]", "localhost", "LOCALHOST"):
        assert is_loopback_host(host), host
    for host in ("0.0.0.0", "::", "[::]", "192.168.1.20", "10.0.0.1", "example.lan", "", "[]"):
        assert not is_loopback_host(host), host


# ---------------------------------------------------------------------------- files endpoint


def test_files_endpoint_streams_the_finished_video_and_its_cover(harness: Harness) -> None:
    harness.downloader.cover_numbers = {1}
    job_id, rows = harness.finished_rows(episodes="1-2")
    assert rows[1]["file_name"] == "E01.mp4" and rows[1]["thumbnail"] is True
    assert rows[2]["file_name"] == "E02.mp4" and rows[2]["thumbnail"] is False

    status, headers, data = harness.raw("GET", f"/api/files/{job_id}/1")
    assert status == 200
    assert data == b"fake video" == Path(rows[1]["path"]).read_bytes()
    assert headers["Content-Type"] == "video/mp4"
    assert headers["Content-Length"] == str(len(data))
    assert headers["Cache-Control"] == "no-store"
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert (
        headers["Content-Disposition"]
        == "attachment; filename=\"E01.mp4\"; filename*=UTF-8''E01.mp4"
    )

    status, headers, data = harness.raw("GET", f"/api/files/{job_id}/1/cover")
    assert status == 200
    assert data == JPEG_BYTES and data[:3] == b"\xff\xd8\xff"
    assert headers["Content-Type"] == "image/jpeg"
    assert headers["Content-Disposition"].startswith('attachment; filename="E01.jpg"')
    assert harness.request("GET", f"/api/files/{job_id}/2/cover") == NOT_FOUND  # no sidecar
    assert harness.raw("GET", f"/api/files/{job_id}/01")[0] == 200  # a padded number is fine


def test_files_endpoint_serves_the_cover_embedded_in_the_video(harness: Harness) -> None:
    """Build 4's default (`--thumbnail embed`): no sidecar, the cover sits in the MP4's `covr`
    atom. The row says `thumbnail: true` and /cover answers the image from memory, with its own
    type, its length and the video's stem as file name."""
    harness.downloader.embedded_numbers = {1}
    harness.downloader.mp4_numbers = {2}  # a real MP4 without any cover
    job_id, rows = harness.finished_rows(episodes="1-2")
    video = Path(rows[1]["path"])
    assert cover_sidecar(video) is None
    assert [p.name for p in video.parent.glob("E01*")] == ["E01.mp4"]  # no sidecar at all
    assert rows[1]["thumbnail"] is True
    assert rows[2]["thumbnail"] is False

    status, headers, data = harness.raw("GET", f"/api/files/{job_id}/1/cover")
    assert status == 200
    assert data == JPEG_BYTES
    assert headers["Content-Type"] == "image/jpeg"
    assert headers["Content-Length"] == str(len(JPEG_BYTES))
    assert headers["Cache-Control"] == "no-store"
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert (
        headers["Content-Disposition"]
        == "attachment; filename=\"E01.jpg\"; filename*=UTF-8''E01.jpg"
    )
    # The video is served whole, cover inside; a cover-less MP4 has no cover to serve.
    status, headers, data = harness.raw("GET", f"/api/files/{job_id}/1")
    assert status == 200 and data == video.read_bytes() and headers["Content-Type"] == "video/mp4"
    assert MP4(video).info.length == pytest.approx(3.0, abs=0.1)  # still the 3 s fixture
    assert harness.request("GET", f"/api/files/{job_id}/2/cover") == NOT_FOUND
    # Reading the cover left nothing behind next to the video.
    assert [p.name for p in video.parent.glob("E01*")] == ["E01.mp4"]


def test_files_endpoint_names_an_embedded_png_cover_after_its_type(harness: Harness) -> None:
    harness.downloader.embedded_numbers = {1}
    harness.downloader.embedded_image = PNG_BYTES
    harness.downloader.embedded_format = MP4Cover.FORMAT_PNG
    job_id, rows = harness.finished_rows(episodes="1")
    assert rows[1]["thumbnail"] is True
    status, headers, data = harness.raw("GET", f"/api/files/{job_id}/1/cover")
    assert status == 200 and data == PNG_BYTES
    assert headers["Content-Type"] == "image/png"
    assert headers["Content-Length"] == str(len(PNG_BYTES))
    assert (
        headers["Content-Disposition"]
        == "attachment; filename=\"E01.png\"; filename*=UTF-8''E01.png"
    )


def test_files_endpoint_prefers_the_sidecar_over_the_embedded_cover(harness: Harness) -> None:
    """`--thumbnail both` leaves a sidecar AND an embedded cover: the file next to the video is
    what /cover serves (unchanged from build 3); the embedded one takes over only once the sidecar
    is gone — the flag recorded on the row stays true either way."""
    harness.downloader.cover_numbers = {1}  # E01.jpg holds JPEG_BYTES...
    harness.downloader.embedded_numbers = {1}  # ...and the covr atom a PNG, to tell them apart
    harness.downloader.embedded_image = PNG_BYTES
    harness.downloader.embedded_format = MP4Cover.FORMAT_PNG
    job_id, rows = harness.finished_rows(episodes="1")
    assert rows[1]["thumbnail"] is True
    status, headers, data = harness.raw("GET", f"/api/files/{job_id}/1/cover")
    assert status == 200 and data == JPEG_BYTES and headers["Content-Type"] == "image/jpeg"
    assert headers["Content-Disposition"].startswith('attachment; filename="E01.jpg"')
    Path(rows[1]["path"]).with_suffix(".jpg").unlink()
    status, headers, data = harness.raw("GET", f"/api/files/{job_id}/1/cover")
    assert status == 200 and data == PNG_BYTES and headers["Content-Type"] == "image/png"
    assert headers["Content-Disposition"].startswith('attachment; filename="E01.png"')


def test_files_endpoint_never_serves_an_oversize_embedded_cover(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A `covr` atom bigger than `thumbnails.MAX_COVER_BYTES` is not a cover (an error page, or
    abuse): it is never sent from memory. The cap is read when the request is answered."""
    import dramafetch.thumbnails as thumbnails

    harness.downloader.embedded_numbers = {1}
    job_id, _ = harness.finished_rows(episodes="1")
    assert harness.raw("GET", f"/api/files/{job_id}/1/cover")[0] == 200
    monkeypatch.setattr(thumbnails, "MAX_COVER_BYTES", len(JPEG_BYTES) - 1)
    assert harness.request("GET", f"/api/files/{job_id}/1/cover") == NOT_FOUND
    monkeypatch.setattr(thumbnails, "MAX_COVER_BYTES", len(JPEG_BYTES))
    assert harness.raw("GET", f"/api/files/{job_id}/1/cover")[0] == 200


def test_files_endpoint_checks_out_dir_before_reading_an_embedded_cover(
    make_harness: Callable[..., Harness], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A done row pointing outside --out at a real MP4 with an embedded cover: the row is honest
    (`thumbnail: true`), /cover is the one 404, and the file is never opened — the confinement
    check comes before `extract_cover`, exactly as before the video itself."""
    import dramafetch.thumbnails as thumbnails

    harness = make_harness()
    harness.downloader.write_dir = tmp_path / "elsewhere"
    harness.downloader.embedded_numbers = {1}
    outside_job, rows = harness.finished_rows(episodes="1")
    outside = Path(rows[1]["path"])
    assert outside.is_file() and not outside.resolve().is_relative_to(harness.out_dir.resolve())
    assert rows[1]["status"] == "done" and rows[1]["thumbnail"] is True
    harness.downloader.write_dir = None
    harness.downloader.embedded_numbers = set()
    inside_job, rows = harness.finished_rows(episodes="2")  # b"fake video", inside --out
    inside = Path(rows[2]["path"]).resolve()

    # From here on count what the files endpoint reads (recording the rows above went through the
    # real function: `has_embedded_cover` is `extract_cover` too).
    opened: list[Path] = []
    real_extract = thumbnails.extract_cover

    def counting_extract(video: Path) -> tuple[bytes, str] | None:
        opened.append(video)
        return real_extract(video)

    monkeypatch.setattr(thumbnails, "extract_cover", counting_extract)
    assert harness.request("GET", f"/api/files/{outside_job}/1/cover") == NOT_FOUND
    assert harness.request("GET", f"/api/files/{outside_job}/1") == NOT_FOUND
    assert opened == []  # never reached for a path outside --out
    # Inside --out the video is read, once per request and only after the check — still a 404 here.
    assert harness.request("GET", f"/api/files/{inside_job}/2/cover") == NOT_FOUND
    assert opened == [inside]


def test_files_endpoint_refuses_a_symlinked_video_with_an_embedded_cover(
    harness: Harness, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A link inside --out to an MP4 outside it: its embedded cover is not served either, and the
    file behind the link is never opened."""
    import dramafetch.thumbnails as thumbnails

    secret = tmp_path / "secret.mp4"
    shutil.copyfile(FIXTURE_MP4, secret)
    embed_cover(secret)
    job_id, rows = harness.finished_rows(episodes="1")
    inside = Path(rows[1]["path"])
    inside.unlink()
    try:
        inside.symlink_to(secret)
    except OSError:  # no symlink support here
        pytest.skip("symlinks are not available on this platform")
    assert inside.is_file()  # through the link...
    opened: list[Path] = []

    def recording_extract(video: Path) -> tuple[bytes, str] | None:
        opened.append(video)
        return None

    monkeypatch.setattr(thumbnails, "extract_cover", recording_extract)
    assert harness.request("GET", f"/api/files/{job_id}/1/cover") == NOT_FOUND  # ...but not served
    assert harness.request("GET", f"/api/files/{job_id}/1") == NOT_FOUND
    assert opened == []


def test_thumbnail_flag_is_computed_once_when_the_row_is_recorded(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The page polls every 2 s: the flag is read from the file system once per row, when the
    engine reports the episode, never while answering GET /api/jobs/<id>. A sidecar settles it
    without opening the video; otherwise the video is checked for an embedded cover — once."""
    import dramafetch.thumbnails as thumbnails

    checked: list[Path] = []
    real_has_embedded_cover = thumbnails.has_embedded_cover

    def counting_has_embedded_cover(video: Path) -> bool:
        checked.append(video)
        return real_has_embedded_cover(video)

    monkeypatch.setattr(thumbnails, "has_embedded_cover", counting_has_embedded_cover)
    harness.downloader.embedded_numbers = {1}
    harness.downloader.cover_numbers = {2}
    job_id, rows = harness.finished_rows(episodes="1-3")
    assert [rows[n]["thumbnail"] for n in (1, 2, 3)] == [True, True, False]
    assert sorted(p.name for p in checked) == ["E01.mp4", "E03.mp4"]
    for _ in range(5):
        status, snapshot = harness.request("GET", f"/api/jobs/{job_id}")
        assert status == 200
        assert [row["thumbnail"] for row in snapshot["results"]] == [True, True, False]
    assert len(checked) == 2  # polling never looked again
    # Nor does the flag follow later changes on disk: it describes the row as it was recorded.
    Path(rows[1]["path"]).unlink()
    assert harness.request("GET", f"/api/jobs/{job_id}")[1]["results"][0]["thumbnail"] is True
    assert len(checked) == 2


def test_files_endpoint_names_non_ascii_files_for_every_client(harness: Harness) -> None:
    # Accents, an en dash and CJK on purpose: the ASCII fallback must still name the file.
    harness.downloader.name_format = "Épisode {number:02d} – 测试.mp4"  # noqa: RUF001
    job_id, rows = harness.finished_rows(episodes="1")
    name = "Épisode 01 – 测试.mp4"  # noqa: RUF001 - the en dash is deliberate
    assert rows[1]["file_name"] == name
    status, headers, data = harness.raw("GET", f"/api/files/{job_id}/1")
    assert status == 200 and data == b"fake video"
    assert headers["Content-Disposition"] == (
        "attachment; filename=\"Episode 01 .mp4\"; filename*=UTF-8''" + quote(name, safe="")
    )
    assert content_disposition("测试.mp4") == (
        "attachment; filename=\"download.mp4\"; filename*=UTF-8''%E6%B5%8B%E8%AF%95.mp4"
    )
    assert content_disposition('a"b\\c\r\n.mp4') == (
        "attachment; filename=\"abc.mp4\"; filename*=UTF-8''a%22b%5Cc%0D%0A.mp4"
    )


def test_files_endpoint_answers_one_404_to_everything_else(harness: Harness) -> None:
    job_id, rows = harness.finished_rows(episodes="1,5")
    assert rows[5]["status"] == "skipped-locked"
    assert harness.request("GET", "/api/files/unknown-job/1") == NOT_FOUND
    assert harness.request("GET", f"/api/files/{job_id}/7") == NOT_FOUND  # no such row
    assert harness.request("GET", f"/api/files/{job_id}/5") == NOT_FOUND  # a row that is not done
    assert harness.request("GET", f"/api/files/{job_id}/5/cover") == NOT_FOUND
    assert harness.request("GET", f"/api/files/{job_id}/1/../../x") == NOT_FOUND  # traversal shape
    assert harness.request("GET", "/api/files")[0] == 404  # the bare prefix is no page
    for odd in (
        "/",
        f"/{job_id}",
        f"/{job_id}/",
        f"/{job_id}/one",
        f"/{job_id}/-1",
        f"/{job_id}/1/thumb",
        f"/{job_id}/1/cover/x",
        f"/{job_id}/1/cover/../1",
        f"//{job_id}/1",
    ):
        assert harness.request("GET", "/api/files" + odd) == NOT_FOUND, odd  # never a path
    # The row is served once it is done, and no longer once the file is gone.
    assert harness.raw("GET", f"/api/files/{job_id}/1")[0] == 200
    Path(rows[1]["path"]).unlink()
    assert harness.request("GET", f"/api/files/{job_id}/1") == NOT_FOUND


def test_files_endpoint_refuses_paths_outside_out_dir(
    make_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = make_harness()
    # A row whose path is a real file outside --out (think /etc/hostname): never served.
    harness.downloader.write_dir = tmp_path / "elsewhere"
    harness.downloader.cover_numbers = {1}
    job_id, rows = harness.finished_rows(episodes="1")
    outside = Path(rows[1]["path"])
    assert outside.is_file() and not outside.resolve().is_relative_to(harness.out_dir.resolve())
    assert rows[1]["status"] == "done" and rows[1]["thumbnail"] is True
    assert harness.request("GET", f"/api/files/{job_id}/1") == NOT_FOUND
    assert harness.request("GET", f"/api/files/{job_id}/1/cover") == NOT_FOUND


def test_files_endpoint_refuses_symlinks_escaping_out_dir(harness: Harness, tmp_path: Path) -> None:
    job_id, rows = harness.finished_rows(episodes="1")
    inside = Path(rows[1]["path"])
    secret = tmp_path / "secret.txt"
    secret.write_bytes(b"not for the network")
    inside.unlink()
    try:
        inside.symlink_to(secret)
    except OSError:  # no symlink support here
        pytest.skip("symlinks are not available on this platform")
    assert inside.is_file()  # through the link...
    assert harness.request("GET", f"/api/files/{job_id}/1") == NOT_FOUND  # ...but not served
    # A sidecar that is a link out of --out is refused the same way.
    inside.unlink()
    inside.write_bytes(b"fake video")
    inside.with_suffix(".jpg").symlink_to(secret)
    assert harness.raw("GET", f"/api/files/{job_id}/1")[0] == 200
    assert harness.request("GET", f"/api/files/{job_id}/1/cover") == NOT_FOUND


def test_files_endpoint_refuses_part_files_and_directories(harness: Harness) -> None:
    harness.downloader.name_format = "E{number:02d}.mp4.part"
    job_id, rows = harness.finished_rows(episodes="1")
    assert rows[1]["path"].endswith(".part") and rows[1]["status"] == "done"
    assert harness.request("GET", f"/api/files/{job_id}/1") == NOT_FOUND
    # A directory where the file should be is not a file either.
    directory = Path(rows[1]["path"])
    directory.unlink()
    directory.mkdir()
    assert harness.request("GET", f"/api/files/{job_id}/1") == NOT_FOUND


def test_files_endpoint_honours_the_session_cookie(locked_harness: Harness) -> None:
    locked_harness.auth = bearer()  # drive the job with the header...
    locked_harness.downloader.cover_numbers = {1}
    job_id, _ = locked_harness.finished_rows(episodes="1")
    locked_harness.auth = {}
    assert locked_harness.request("GET", f"/api/files/{job_id}/1")[0] == 401
    assert locked_harness.request("GET", f"/api/files/{job_id}/1/cover")[0] == 401
    # ...and fetch the files the way a browser's Save link does: with the cookie.
    status, headers, data = locked_harness.raw("GET", f"/api/files/{job_id}/1", headers=cookie())
    assert status == 200 and data == b"fake video"
    assert headers["Content-Type"] == "video/mp4"
    status, _, data = locked_harness.raw("GET", f"/api/files/{job_id}/1/cover", headers=cookie())
    assert status == 200 and data == JPEG_BYTES
    assert locked_harness.request("GET", f"/api/jobs/{job_id}", headers=cookie())[0] == 200


# ---------------------------------------------------------------------------- save all (ZIP)


def open_zip(data: bytes) -> zipfile.ZipFile:
    """The ZIP a response carried, every entry's CRC checked."""
    archive = zipfile.ZipFile(io.BytesIO(data))
    assert archive.testzip() is None
    return archive


def test_save_all_streams_every_file_as_a_stored_zip64(harness: Harness) -> None:
    """GET /api/files/<job>/all: every done row's video plus its cover sidecar, as
    `<series name>/<file>`, stored byte for byte (never recompressed), ZIP64 from the first entry
    on and written as a stream (sizes in data descriptors): no Content-Length, Connection: close."""
    harness.downloader.mp4_numbers = {1, 2}
    harness.downloader.cover_numbers = {1}
    job_id, rows = harness.finished_rows()  # 1-4 done, 5 locked
    status, headers, data = harness.raw("GET", f"/api/files/{job_id}/all")
    assert status == 200
    assert headers["Content-Type"] == "application/zip"
    assert headers["Content-Disposition"] == content_disposition(f"{SERIES_NAME}.zip")
    assert headers["Content-Disposition"].startswith(f'attachment; filename="{SERIES_NAME}.zip"')
    assert "Content-Length" not in headers and headers["Connection"] == "close"
    assert headers["Cache-Control"] == "no-store" and headers["X-Content-Type-Options"] == "nosniff"
    archive = open_zip(data)
    assert archive.namelist() == [
        f"{SERIES_NAME}/E01.mp4",
        f"{SERIES_NAME}/E01.jpg",
        f"{SERIES_NAME}/E02.mp4",
        f"{SERIES_NAME}/E03.mp4",
        f"{SERIES_NAME}/E04.mp4",
    ]
    for info in archive.infolist():
        assert info.compress_type == zipfile.ZIP_STORED  # stored: quality untouched
        assert info.flag_bits & 0x08  # CRC and sizes after the data: a stream, never seeked
    for number in (1, 2, 3, 4):
        video = Path(rows[number]["path"])
        assert archive.read(f"{SERIES_NAME}/{video.name}") == video.read_bytes()
    assert archive.read(f"{SERIES_NAME}/E01.jpg") == JPEG_BYTES
    assert archive.read(f"{SERIES_NAME}/E01.mp4") == FIXTURE_MP4.read_bytes()
    # ZIP64 in the first local header: version 4.5 needed, both sizes 0xFFFFFFFF.
    assert struct.unpack("<IH", data[:6]) == (0x04034B50, 45)
    assert struct.unpack("<II", data[18:26]) == (0xFFFFFFFF, 0xFFFFFFFF)


def test_save_all_includes_the_files_an_earlier_run_saved(harness: Harness) -> None:
    """A second run reports the episodes as skipped-exists: those rows are served now — Save video,
    Cover — and the second job's ZIP still holds every episode."""
    harness.downloader.cover_numbers = {2}
    first_job, _ = harness.finished_rows()
    second_job, rows = harness.finished_rows()
    assert [rows[n]["status"] for n in (1, 2, 3, 4)] == ["skipped-exists"] * 4
    assert rows[2]["thumbnail"] is True
    status, _, data = harness.raw("GET", f"/api/files/{second_job}/2")
    assert status == 200 and data == b"fake video"
    status, headers, data = harness.raw("GET", f"/api/files/{second_job}/2/cover")
    assert status == 200 and data == JPEG_BYTES and headers["Content-Type"] == "image/jpeg"
    names = [f"{SERIES_NAME}/E0{n}.mp4" for n in (1, 2, 3, 4)]
    names.insert(2, f"{SERIES_NAME}/E02.jpg")
    for job_id in (first_job, second_job):
        status, _, data = harness.raw("GET", f"/api/files/{job_id}/all")
        assert status == 200 and open_zip(data).namelist() == names
    assert harness.request("GET", f"/api/files/{second_job}/5") == NOT_FOUND  # locked: no file


def test_skipped_exists_rows_keep_the_confinement_rules(
    make_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """A skipped-exists row whose path lies outside --out (the manifest of an odd earlier run) is
    the one 404, alone or in a ZIP."""
    harness = make_harness()
    harness.downloader.write_dir = tmp_path / "elsewhere"
    harness.finished_rows(episodes="1")
    job_id, rows = harness.finished_rows(episodes="1")
    assert rows[1]["status"] == "skipped-exists"
    assert not Path(rows[1]["path"]).resolve().is_relative_to(harness.out_dir.resolve())
    assert harness.request("GET", f"/api/files/{job_id}/1") == NOT_FOUND
    assert harness.request("GET", f"/api/files/{job_id}/all") == NOT_FOUND


def test_save_all_never_includes_a_path_outside_out_dir(harness: Harness, tmp_path: Path) -> None:
    """Every entry passes the same confinement check as a single file: a video or a sidecar that
    is a link out of --out, or a `.part`, is left out — and a job with nothing left is the 404."""
    harness.downloader.cover_numbers = {1, 2}
    job_id, rows = harness.finished_rows(episodes="1-3")
    secret = tmp_path / "secret.txt"
    secret.write_bytes(b"not for the network")
    video = Path(rows[2]["path"])
    video.unlink()
    video.symlink_to(secret)  # a video that resolves outside --out
    sidecar = Path(rows[1]["path"]).with_suffix(".jpg")
    sidecar.unlink()
    sidecar.symlink_to(secret)  # a cover sidecar that does
    status, _, data = harness.raw("GET", f"/api/files/{job_id}/all")
    assert status == 200
    assert open_zip(data).namelist() == [f"{SERIES_NAME}/E01.mp4", f"{SERIES_NAME}/E03.mp4"]
    assert b"not for the network" not in data
    # Rows outside --out only: nothing qualifies, the one 404.
    harness.downloader.write_dir = tmp_path / "elsewhere"
    outside_job, _ = harness.finished_rows(episodes="4")
    assert harness.request("GET", f"/api/files/{outside_job}/all") == NOT_FOUND
    harness.downloader.write_dir = None
    harness.downloader.name_format = "E{number:02d}.mp4.part"
    part_job, rows = harness.finished_rows(episodes="5", include_locked=True)
    assert rows[5]["path"].endswith(".part")
    assert harness.request("GET", f"/api/files/{part_job}/all") == NOT_FOUND


def test_save_all_needs_a_finished_job(harness: Harness) -> None:
    """409 while the job is queued or running; the one 404 for an unknown job and for a finished
    job without a file (a cancelled one, here)."""
    harness.downloader.block = threading.Event()
    running = harness.start_download(episodes="1")
    harness.wait_until_running(running["job_id"])
    queued = harness.start_download(episodes="2")
    assert harness.request("GET", f"/api/files/{running['job_id']}/all") == STILL_RUNNING
    assert harness.request("GET", f"/api/files/{queued['job_id']}/all") == STILL_RUNNING
    assert harness.request("GET", "/api/files/nope/all") == NOT_FOUND
    for odd in ("/all", f"/{running['job_id']}/all/x", f"/{running['job_id']}/all/cover"):
        assert harness.request("GET", "/api/files" + odd) == NOT_FOUND, odd
    harness.downloader.block.set()
    harness.wait_for_job(queued["job_id"])
    assert harness.raw("GET", f"/api/files/{running['job_id']}/all")[0] == 200
    # A refusal at episode 3 stops that job (no file) and cancels the one queued behind it.
    harness.downloader.outcomes[(SERIES_ID, 3)] = (DownloadStatus.FAILED_BLOCKED, "HTTP 403")
    harness.downloader.block = threading.Event()
    stopping = harness.start_download(episodes="3")
    harness.wait_until_running(stopping["job_id"])
    cancelled = harness.start_download(episodes="4")
    harness.downloader.block.set()
    assert harness.wait_for_job(cancelled["job_id"])["state"] == "cancelled"
    assert harness.request("GET", f"/api/files/{cancelled['job_id']}/all") == NOT_FOUND
    assert harness.request("GET", f"/api/files/{stopping['job_id']}/all") == NOT_FOUND


def test_save_all_reads_every_file_in_chunks(harness: Harness, tmp_path: Path) -> None:
    """Memory stays bounded whatever the series weighs: a 32 MiB episode goes out with a traced
    peak far below its size — the handler never holds a whole file, the client here streams the
    answer to disk — and the archive is still exact."""
    job_id, rows = harness.finished_rows(episodes="1")
    video = Path(rows[1]["path"])
    block = bytes(range(256)) * 4096  # 1 MiB
    with video.open("wb") as handle:
        for _ in range(32):
            handle.write(block)
    saved = tmp_path / "saved.zip"
    connection = http.client.HTTPConnection("127.0.0.1", harness.port, timeout=30)
    tracemalloc.start()
    try:
        connection.request("GET", f"/api/files/{job_id}/all")
        response = connection.getresponse()
        assert response.status == 200
        with saved.open("wb") as handle:
            while chunk := response.read(64 * 1024):
                handle.write(chunk)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
        connection.close()
    assert peak < 8 * 1024 * 1024, peak
    with zipfile.ZipFile(saved) as archive:
        assert archive.testzip() is None
        (info,) = archive.infolist()
        assert info.filename == f"{SERIES_NAME}/E01.mp4"
        assert info.file_size == info.compress_size == 32 * 1024 * 1024


def test_save_all_needs_the_token(locked_harness: Harness) -> None:
    locked_harness.auth = bearer()
    job_id, _ = locked_harness.finished_rows(episodes="1")
    locked_harness.auth = {}
    status, data = locked_harness.request("GET", f"/api/files/{job_id}/all")
    assert (status, data["kind"]) == (401, "auth")
    status, headers, data = locked_harness.raw("GET", f"/api/files/{job_id}/all", headers=cookie())
    assert status == 200 and headers["Content-Type"] == "application/zip"
    assert open_zip(data).namelist() == [f"{SERIES_NAME}/E01.mp4"]


# ---------------------------------------------------------------------------- doctor


def test_doctor_reports_the_cli_facts(harness: Harness) -> None:
    status, data = harness.request("GET", "/api/doctor")
    assert status == 200, data
    assert data["out_dir"] == str(harness.out_dir)
    names = [check["name"] for check in data["checks"]]
    assert names == ["python", "yt-dlp", "curl_cffi", "playwright", "browser", "ffmpeg", "cookies"]
    for check in data["checks"]:
        assert check["state"] in {"ok", "fail", "skip"}
        assert isinstance(check["detail"], str)
    assert "sessionid=" not in json.dumps(data)


# ---------------------------------------------------------------------------- run_server


def test_run_server_refuses_an_empty_host(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="explicit host"):
        run_server("", 0, tmp_path, DiscoveryOptions(), DownloadOptions(), serve_forever=False)
    with pytest.raises(ValueError, match="explicit host"):
        run_server("[ ]", 0, tmp_path, DiscoveryOptions(), DownloadOptions(), serve_forever=False)


def test_normalize_host_strips_ipv6_brackets() -> None:
    assert normalize_host(" 127.0.0.1 ") == "127.0.0.1"
    assert normalize_host("[::1]") == "::1"
    assert normalize_host("::") == "::"
    assert normalize_host("localhost") == "localhost"
    with pytest.raises(ValueError, match="explicit host"):
        normalize_host("[]")


def test_bracketed_ipv6_host_binds_and_is_allowed_by_the_host_guard(tmp_path: Path) -> None:
    try:
        probe = socket.socket(socket.AF_INET6)
        probe.bind(("::1", 0))
        probe.close()
    except OSError:
        pytest.skip("no IPv6 loopback on this machine")
    server = run_server(
        "[::1]", 0, tmp_path, DiscoveryOptions(), DownloadOptions(), serve_forever=False
    )
    try:
        assert server.server_address[0] == "::1"
        assert server.bound_host == "::1"  # type: ignore[attr-defined]
        port = server.server_address[1]
        assert server.host_allowed(f"[::1]:{port}")  # type: ignore[attr-defined]
        assert server.host_allowed("localhost")  # type: ignore[attr-defined]
        assert not server.host_allowed("evil.example")  # type: ignore[attr-defined]
    finally:
        server.server_close()


def test_run_server_fixes_the_output_directory(tmp_path: Path) -> None:
    server = run_server(
        "127.0.0.1",
        0,
        tmp_path / "fixed",
        DiscoveryOptions(),
        DownloadOptions(out_dir=Path("elsewhere")),
        serve_forever=False,
    )
    try:
        assert server.out_dir == (tmp_path / "fixed").absolute()  # type: ignore[attr-defined]
        assert server.download_options.out_dir == server.out_dir  # type: ignore[attr-defined]
        assert server.token is None  # type: ignore[attr-defined]
    finally:
        server.server_close()


# ---------------------------------------------------------------------------- JobManager


def _episodes() -> list[Episode]:
    return make_series().episodes[:2]


def test_job_manager_runs_one_job_at_a_time_in_order() -> None:
    gate = threading.Event()
    order: list[str | None] = []

    def runner(
        series: Series,
        episodes: list[Episode],
        options: DownloadOptions,
        on_result: Callable[[DownloadResult], None],
    ) -> list[DownloadResult]:
        order.append(series.name)
        assert gate.wait(5)
        results = [
            DownloadResult(episode, DownloadStatus.DONE, message="ok") for episode in episodes
        ]
        for result in results:
            on_result(result)
        return results

    jobs = JobManager()
    first = jobs.start(make_series("A"), _episodes(), DownloadOptions(), runner=runner)
    second = jobs.start(make_series("B"), _episodes(), DownloadOptions(), runner=runner)
    deadline = time.monotonic() + 5
    while jobs.get(first)["state"] != "running":  # type: ignore[index]
        assert time.monotonic() < deadline
        time.sleep(0.01)
    assert jobs.running == first
    queued = jobs.get(second)
    assert queued is not None and queued["state"] == "queued" and queued["results"] == []

    gate.set()
    assert jobs.wait(first, timeout=5) and jobs.wait(second, timeout=5)
    assert order == ["A", "B"]
    done = jobs.get(second)
    assert done is not None
    assert done["state"] == "done" and done["error"] is None and done["total"] == 2
    assert [row["status"] for row in done["results"]] == ["done", "done"]
    assert set(done) >= {
        "id",
        "state",
        "series_id",
        "series_name",
        "started_at",
        "finished_at",
        "results",
        "error",
    }
    assert jobs.running is None


def test_job_manager_records_errors_redacted() -> None:
    def runner(*args: Any, **kwargs: Any) -> list[DownloadResult]:
        raise RuntimeError("boom sessionid=secret123; Cookie: sid_tt=alsosecret")

    jobs = JobManager()
    job_id = jobs.start(make_series(), _episodes(), DownloadOptions(), runner=runner)
    assert jobs.wait(job_id, timeout=5)
    snapshot = jobs.get(job_id)
    assert snapshot is not None
    assert snapshot["state"] == "error"
    assert snapshot["error"] is not None and snapshot["error"].startswith("RuntimeError: boom")
    assert "secret123" not in snapshot["error"] and "alsosecret" not in snapshot["error"]
    assert jobs.running is None  # a failed job frees the slot


def test_job_manager_unknown_ids() -> None:
    jobs = JobManager()
    assert jobs.get("nope") is None
    assert jobs.wait("nope", timeout=0.01) is False


def test_job_manager_gate_refuses_a_job_before_its_runner_runs() -> None:
    """The gate is asked when a job reaches the front of the queue: a reason ends it as `error`
    (redacted, like any error) without calling the runner; None lets the next one run."""
    reasons: list[str | None] = ["cooling down; Cookie: sessionid=abc123"]
    calls: list[str | None] = []

    def runner(
        series: Series,
        episodes: list[Episode],
        options: DownloadOptions,
        on_result: Callable[[DownloadResult], None],
    ) -> list[DownloadResult]:
        calls.append(series.name)
        return []

    jobs = JobManager(gate=lambda: reasons[0])
    refused = jobs.start(make_series("A"), _episodes(), DownloadOptions(), runner=runner)
    assert jobs.wait(refused, timeout=5)
    snapshot = jobs.get(refused)
    assert snapshot is not None
    assert snapshot["state"] == "error"
    assert snapshot["error"] == "cooling down; Cookie=<redacted>"
    assert snapshot["results"] == [] and snapshot["started_at"] and snapshot["finished_at"]
    reasons[0] = None
    allowed = jobs.start(make_series("B"), _episodes(), DownloadOptions(), runner=runner)
    assert jobs.wait(allowed, timeout=5)
    done = jobs.get(allowed)
    assert done is not None and done["state"] == "done" and done["error"] is None
    assert calls == ["B"] and jobs.running is None


class FakeSeriesRunner:
    """A series runner for the JobManager tests, standing in for ``engine.run_series``: records
    every call and its keywords, contacts TikTok — calls ``before_network`` — unless the series is
    in ``quiet``, waits for ``hold`` when set, names the series through ``on_start``, reports
    every episode done and ends with a stop for the ids in ``stops``. ``requests`` lists the series
    that got past ``before_network``."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.requests: list[str] = []
        self.kwargs: list[dict[str, Any]] = []
        self.quiet: set[str] = set()
        self.stops: dict[str, str] = {}
        self.hold: threading.Event | None = None

    def __call__(self, ref: SeriesRef, options: DownloadOptions, **kwargs: Any) -> engine.SeriesRun:
        self.calls.append(ref.series_id)
        self.kwargs.append(kwargs)
        if self.hold is not None:
            assert self.hold.wait(5)
        contacted = ref.series_id not in self.quiet
        if contacted:
            kwargs["before_network"]()  # may rest first, and may raise JobRefused
            self.requests.append(ref.series_id)
        series = make_second_series() if ref.series_id == SECOND_SERIES_ID else make_series()
        start = engine.SeriesStart(
            ref, series, series.display_name, Path("unused"), series.episodes
        )
        kwargs["on_start"](start)
        results = [DownloadResult(e, DownloadStatus.DONE, message="ok") for e in series.episodes]
        for result in results:
            kwargs["on_result"](result)
        stopped = self.stops.get(ref.series_id)
        return engine.SeriesRun(
            ref=ref,
            series=series,
            results=results,
            report=engine.series_report(series, results, stopped=stopped),
            error=None,
            stop=stopped is not None,
            exit_code=0,
            contacted=contacted,
        )


REST_OPTIONS = DownloadOptions(rest_min_s=60.0, rest_max_s=120.0)


def _all_finish(jobs: JobManager, job_ids: list[str]) -> list[dict[str, Any]]:
    assert all(jobs.wait(job_id, timeout=5) for job_id in job_ids)
    snapshots = [jobs.get(job_id) for job_id in job_ids]
    assert all(snapshot is not None for snapshot in snapshots)
    return [snapshot for snapshot in snapshots if snapshot is not None]


def test_job_manager_rests_between_two_jobs_that_contact_tiktok() -> None:
    """Right before the second job's first request — not before the first job's, not after it —
    the worker rests rng.uniform(rest_min_s, rest_max_s), through the injected sleep."""
    sleeps: list[float] = []
    jobs = JobManager(sleep=sleeps.append, clock=lambda: 1000.0, rng=random.Random(7))
    runner = FakeSeriesRunner()
    refs = [SeriesRef(SERIES_ID), SeriesRef(SECOND_SERIES_ID)]
    batch_id, ids = jobs.start_batch(refs, REST_OPTIONS, runner=runner)
    first, second = _all_finish(jobs, ids)
    assert sleeps == [random.Random(7).uniform(60.0, 120.0)]
    assert runner.requests == [SERIES_ID, SECOND_SERIES_ID]
    assert first["batch_id"] == second["batch_id"] == batch_id
    assert (first["series_name"], first["total"]) == (SERIES_NAME, 5)
    assert (second["series_name"], second["total"]) == (SECOND_SERIES_NAME, 3)
    assert second["report"]["line"] == "complete: 3 of 3 (3 downloaded)"
    assert second["pause"] is None


def test_job_manager_takes_no_rest_without_two_requests_close_together() -> None:
    """No rest before the first request of the manager, none for a job that makes no request (a
    series skipped as complete), none when the last job that made one finished more than
    rest_max_s ago — and one again at exactly rest_max_s, a quiet job in between or not."""
    sleeps: list[float] = []
    clock = [1000.0]
    jobs = JobManager(sleep=sleeps.append, clock=lambda: clock[0])
    runner = FakeSeriesRunner()
    runner.quiet = {SECOND_SERIES_ID}

    def run(series_id: str) -> None:
        _, ids = jobs.start_batch([SeriesRef(series_id)], REST_OPTIONS, runner=runner)
        _all_finish(jobs, ids)

    run(SERIES_ID)
    clock[0] += 120.5  # more than rest_max_s since that job finished
    run(SERIES_ID)
    run(SECOND_SERIES_ID)  # quiet: no request, so no rest
    assert sleeps == []
    clock[0] += 120.0  # exactly rest_max_s since the last job that made a request
    run(SERIES_ID)
    assert len(sleeps) == 1 and 60.0 <= sleeps[0] <= 120.0
    assert runner.requests == [SERIES_ID, SERIES_ID, SERIES_ID]


def test_job_manager_takes_a_due_long_break_before_a_batch_jobs_first_request() -> None:
    """A due long break comes right before a batch job's first request (its resolve) — also when
    the last job finished too long ago for the rest between jobs — the count starts again and the
    gate is asked once more after it; a download job's first request leaves the long break to
    engine.download_series, which takes it before that job's first episode."""
    sleeps: list[float] = []
    clock = [5000.0]
    refusal = "TikTok refused a request at 12:00 (HTTP 429); DramaFetch waits until 12:30"
    reason: list[str | None] = [None]

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        reason[0] = refusal  # TikTok refused another request during the break

    jobs = JobManager(
        gate=lambda: reason[0], sleep=sleep, clock=lambda: clock[0], rng=random.Random(3)
    )
    jobs.pacing.run_attempts, jobs.pacing.last_network_at = 100, clock[0]
    asked: list[str] = []

    def download_runner(
        series: Series,
        episodes: list[Episode],
        options: DownloadOptions,
        on_result: Callable[[DownloadResult], None],
    ) -> list[DownloadResult]:
        jobs.before_network()  # what its GuardedDownloader does before the first episode
        asked.append(series.series_id)
        return []

    clock[0] += 300.0
    download = jobs.start(make_series(), [], REST_OPTIONS, runner=download_runner)
    assert _all_finish(jobs, [download])[0]["state"] == "done" and asked == [SERIES_ID]
    assert sleeps == [] and jobs.pacing.run_attempts == 100  # left to engine.download_series
    clock[0] += 200.0  # more than rest_max_s after that job; less than long_rest_min_s idle
    runner = FakeSeriesRunner()
    _, ids = jobs.start_batch([SeriesRef(SECOND_SERIES_ID)], REST_OPTIONS, runner=runner)
    (refused,) = _all_finish(jobs, ids)
    assert sleeps == [random.Random(3).uniform(900.0, 1800.0)]  # the long break, not 60-120 s
    assert jobs.pacing.run_attempts == 0  # taken: the count starts again
    assert refused["state"] == "error" and refused["error"] == refusal
    assert runner.requests == []  # the gate, asked again after the break, refused the request


def test_job_manager_shows_the_rest_in_the_snapshot_while_it_lasts() -> None:
    seen: list[dict[str, Any] | None] = []
    jobs = JobManager(clock=lambda: 0.0)

    def sleep(seconds: float) -> None:
        running = jobs.running
        assert running is not None
        snapshot = jobs.get(running)
        assert snapshot is not None and snapshot["state"] == "running"
        seen.append(snapshot["pause"])

    jobs.sleep = sleep
    refs = [SeriesRef(SERIES_ID), SeriesRef(SECOND_SERIES_ID)]
    _, ids = jobs.start_batch(refs, REST_OPTIONS, runner=FakeSeriesRunner())
    _, second = _all_finish(jobs, ids)
    (pause,) = seen
    assert pause is not None and pause["kind"] == "job-rest"
    assert 60.0 <= pause["seconds"] <= 120.0 and pause["since"]
    assert second["pause"] is None  # cleared once the job went on


def test_job_manager_asks_the_gate_again_after_the_rest() -> None:
    """A cooldown recorded during the rest: the job ends before its request — `error` with the
    gate's reason, no rows, no report — and the queue behind it is cancelled."""
    reason: list[str | None] = [None]
    sleeps: list[float] = []
    clock = [0.0]
    refusal = "TikTok refused a request at 12:00 (HTTP 429); DramaFetch waits until 12:30"

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock[0] += 100.0
        reason[0] = refusal  # TikTok refused another request meanwhile

    jobs = JobManager(gate=lambda: reason[0], sleep=sleep, clock=lambda: clock[0])
    runner = FakeSeriesRunner()
    refs = [SeriesRef(SERIES_ID), SeriesRef(SECOND_SERIES_ID), SeriesRef("7600000000000000003")]
    _, ids = jobs.start_batch(refs, REST_OPTIONS, runner=runner)
    first, refused, cancelled = _all_finish(jobs, ids)
    assert first["state"] == "done" and len(sleeps) == 1
    assert refused["state"] == "error" and refused["error"] == refusal
    assert refused["results"] == [] and refused["report"] is None
    assert cancelled["state"] == "cancelled"
    assert cancelled["error"] == f"not started: batch stopped in {SECOND_SERIES_ID} ({refusal})"
    assert runner.calls == [SERIES_ID, SECOND_SERIES_ID]  # the third never ran
    assert runner.requests == [SERIES_ID]  # the second never made its request
    # ...so the next rest is measured from the first job (t=0), not the refused one (t=100).
    reason[0] = None
    clock[0] += 25.0
    _, again = jobs.start_batch([SeriesRef(SECOND_SERIES_ID)], REST_OPTIONS, runner=runner)
    assert _all_finish(jobs, again)[0]["state"] == "done"
    assert len(sleeps) == 1  # 125 s after the last request: no rest


def test_job_manager_cancels_every_queued_job_after_a_stop() -> None:
    """A run that ends with a stop cancels the whole queue — the rest of its batch, a download job,
    another batch — with "not started: …"; none of them runs, cancelled counts as finished, and
    the manager keeps working afterwards."""
    jobs = JobManager(sleep=lambda seconds: None)
    runner = FakeSeriesRunner()
    runner.stops = {SERIES_ID: "episode 2 failed-rate-limited"}
    runner.hold = threading.Event()
    downloads: list[str] = []

    def download_runner(
        series: Series,
        episodes: list[Episode],
        options: DownloadOptions,
        on_result: Callable[[DownloadResult], None],
    ) -> list[DownloadResult]:
        downloads.append(series.series_id)
        return []

    _, batch_ids = jobs.start_batch(
        [SeriesRef(SERIES_ID), SeriesRef(SECOND_SERIES_ID)], REST_OPTIONS, runner=runner
    )
    later = jobs.start(make_second_series(), [], REST_OPTIONS, runner=download_runner)
    _, other = jobs.start_batch([SeriesRef("7600000000000000003")], REST_OPTIONS, runner=runner)
    runner.hold.set()
    stopped, *rest = _all_finish(jobs, [*batch_ids, later, *other])
    assert stopped["state"] == "done"
    assert stopped["report"]["stopped"] == "episode 2 failed-rate-limited"
    message = f"not started: batch stopped in {SERIES_NAME} (episode 2 failed-rate-limited)"
    for snapshot in rest:
        assert snapshot["state"] == "cancelled" and snapshot["error"] == message
        assert snapshot["started_at"] is None and snapshot["finished_at"]
        assert snapshot["results"] == [] and snapshot["report"] is None
    assert runner.calls == [SERIES_ID] and downloads == []
    assert jobs.running is None
    runner.stops = {}
    _, fresh = jobs.start_batch([SeriesRef(SECOND_SERIES_ID)], REST_OPTIONS, runner=runner)
    assert _all_finish(jobs, fresh)[0]["state"] == "done"


def test_job_manager_hands_every_run_its_one_pacing_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """ONE engine.PacingState for the manager's whole lifetime — every batch run and every download
    run gets it, with the manager's sleep, clock and rng — so the long break every 100 network
    attempts spans jobs; the download runs also report pauses and stops to the manager and go
    through a GuardedDownloader."""
    jobs = JobManager(sleep=lambda seconds: None)
    runner = FakeSeriesRunner()
    refs = [SeriesRef(SERIES_ID), SeriesRef(SECOND_SERIES_ID)]
    _, ids = jobs.start_batch(refs, DownloadOptions(), runner=runner)
    _all_finish(jobs, ids)
    assert isinstance(jobs.pacing, engine.PacingState)
    assert jobs.pacing is jobs.pacing
    for kwargs in runner.kwargs:
        assert kwargs["pacing"] is jobs.pacing and kwargs["sleep"] is jobs.sleep
        assert kwargs["clock"] is jobs.clock and kwargs["rng"] is jobs.rng
    seen: list[dict[str, Any]] = []

    def fake_download_series(
        series: Series, episodes: list[Episode], options: DownloadOptions, **kwargs: Any
    ) -> list[DownloadResult]:
        seen.append(kwargs)
        return []

    monkeypatch.setattr(engine, "download_series", fake_download_series)
    job_id = jobs.start(make_series(), _episodes(), DownloadOptions())  # the manager's runner
    _all_finish(jobs, [job_id])
    (kwargs,) = seen
    assert kwargs["pacing"] is jobs.pacing and kwargs["sleep"] is jobs.sleep
    assert kwargs["clock"] is jobs.clock and kwargs["rng"] is jobs.rng
    assert kwargs["on_pause"] == jobs.note_pause and kwargs["on_stop"] == jobs.note_stop
    assert isinstance(kwargs["downloader"], GuardedDownloader)


def test_guarded_downloader_asks_before_every_request_but_not_before_a_skip(
    tmp_path: Path,
) -> None:
    asked: list[str] = []
    closed: list[bool] = []

    class Closable(FakeDownloader):
        def close(self) -> None:
            closed.append(True)

    guarded = GuardedDownloader(lambda: asked.append("asked"), Closable())
    locked, free = make_series().episodes[4], make_series().episodes[0]
    options = DownloadOptions(out_dir=tmp_path)
    assert guarded.download(locked, options).status is DownloadStatus.SKIPPED_LOCKED
    guarded.download(free, replace(options, dry_run=True))
    assert asked == []  # a locked episode left alone and a dry run make no request
    assert guarded.download(free, options).status is DownloadStatus.DONE
    guarded.download(locked, replace(options, include_locked=True))  # tried: a request
    assert asked == ["asked", "asked"]
    guarded.close()
    assert closed == [True]


def test_job_manager_lists_at_most_100_jobs_most_recent_first() -> None:
    jobs = JobManager()

    def runner(
        series: Series,
        episodes: list[Episode],
        options: DownloadOptions,
        on_result: Callable[[DownloadResult], None],
    ) -> list[DownloadResult]:
        return []

    ids = [
        jobs.start(make_series(str(n)), [], DownloadOptions(), runner=runner) for n in range(105)
    ]
    _all_finish(jobs, ids)
    listed = jobs.summaries()
    assert [job["id"] for job in listed] == ids[::-1][:100]
    assert [job["series_name"] for job in listed[:2]] == ["104", "103"]
    assert all("results" not in job for job in listed)
    assert [job["id"] for job in jobs.summaries(limit=2)] == [ids[104], ids[103]]
    assert jobs.summaries(limit=0) == []


def test_job_manager_batch_needs_a_series_runner_and_a_series() -> None:
    jobs = JobManager()
    with pytest.raises(ValueError, match="series runner"):
        jobs.start_batch([SeriesRef(SERIES_ID)], DownloadOptions())
    with pytest.raises(ValueError, match="at least one series"):
        jobs.start_batch([], DownloadOptions(), runner=FakeSeriesRunner())
    assert jobs.summaries() == []


def test_redact_secrets() -> None:
    assert (
        redact_secrets("sessionid=abc; msToken=xyz ok")
        == "sessionid=<redacted>; msToken=<redacted> ok"
    )
    assert redact_secrets("cookie: 123abc tail") == "cookie=<redacted> tail"
    assert redact_secrets("dramafetch_session=tok3n; x") == "dramafetch_session=<redacted>; x"
    assert redact_secrets("no secrets here") == "no secrets here"


def test_result_to_dict(tmp_path: Path) -> None:
    episode = make_series().episodes[0]
    row = result_to_dict(DownloadResult(episode, DownloadStatus.DRY_RUN, message="would fetch"))
    assert row == {
        "number": 1,
        "title": episode.title,
        "status": "dry-run",
        "message": "would fetch",
        "path": None,
        "file_name": None,
        "thumbnail": False,
    }
    video = tmp_path / "The Billionaire's Secret Heiress - Episode 01.mp4"
    video.write_bytes(b"v")
    with_path = result_to_dict(DownloadResult(episode, DownloadStatus.DONE, path=video))
    assert with_path["path"] == str(video)
    assert with_path["file_name"] == "The Billionaire's Secret Heiress - Episode 01.mp4"
    assert with_path["thumbnail"] is False
    video.with_suffix(".webp").write_bytes(b"RIFF\x00\x00\x00\x00WEBP")
    assert result_to_dict(DownloadResult(episode, DownloadStatus.DONE, path=video))["thumbnail"]
    # A path that does not exist (yet, or any more) simply has no thumbnail.
    missing = result_to_dict(DownloadResult(episode, DownloadStatus.DONE, path=tmp_path / "x.mp4"))
    assert missing["thumbnail"] is False and missing["file_name"] == "x.mp4"
    # Build 4's default: the cover embedded in the video, no sidecar at all.
    embedded = tmp_path / "Series - Episode 02.mp4"
    shutil.copyfile(FIXTURE_MP4, embedded)
    plain = result_to_dict(DownloadResult(episode, DownloadStatus.DONE, path=embedded))
    assert plain["thumbnail"] is False  # a real MP4 without a cover
    embed_cover(embedded)
    assert result_to_dict(DownloadResult(episode, DownloadStatus.DONE, path=embedded))["thumbnail"]


def test_cover_sidecar_prefers_jpg_then_jpeg_png_webp(tmp_path: Path) -> None:
    video = tmp_path / "Series - Episode 01.mp4"
    video.write_bytes(b"v")
    assert cover_sidecar(video) is None
    (tmp_path / "Series - Episode 01.webp").write_bytes(b"w")
    assert cover_sidecar(video) == tmp_path / "Series - Episode 01.webp"
    (tmp_path / "Series - Episode 01.png").write_bytes(b"p")
    assert cover_sidecar(video) == tmp_path / "Series - Episode 01.png"
    (tmp_path / "Series - Episode 01.jpg").write_bytes(b"j")
    assert cover_sidecar(video) == tmp_path / "Series - Episode 01.jpg"
    assert cover_sidecar(tmp_path / "missing.mp4") is None
    assert cover_sidecar(Path()) is None  # no name at all
    # Only the last suffix is swapped: a dotted series name keeps its dots.
    dotted = tmp_path / "Dr. Who v1.2 - Episode 01.mp4"
    (tmp_path / "Dr. Who v1.2 - Episode 01.jpeg").write_bytes(b"j")
    assert cover_sidecar(dotted) == tmp_path / "Dr. Who v1.2 - Episode 01.jpeg"


# ---------------------------------------------------------------------------- build 6 review


def test_a_cooldown_recorded_while_a_job_downloads_stops_it_before_its_next_request(
    harness: Harness,
) -> None:
    """TikTok refused a request elsewhere (another DramaFetch process, a resolve of this server)
    while job A downloads episode 1: A makes no further request — episode 2 on is `stopped:
    cooldown until …` — and the job queued behind it is cancelled, not even resolved."""
    harness.downloader.block = threading.Event()
    first = harness.start_download(episodes="1-3")
    harness.wait_until_running(first["job_id"])
    batch = harness.start_batch([SECOND_SERIES_URL])
    harness.wait_until_downloading()
    record_block("TikTok is rate-limiting this address (HTTP 429 on the episode list)", "discovery")
    harness.downloader.block.set()
    stopped = harness.wait_for_job(first["job_id"])
    assert [row["status"] for row in stopped["results"]] == [
        "done",
        "failed-rate-limited",
        "failed-rate-limited",
    ]
    assert stopped["results"][1]["message"].startswith("stopped: cooldown until ")
    assert stopped["report"]["stopped"].startswith("cooldown until ")
    (cancelled,) = harness.batch_snapshots(batch)
    assert cancelled["state"] == "cancelled"
    assert cancelled["error"].startswith(
        f"not started: batch stopped in {SERIES_NAME} (cooldown until "
    )
    assert harness.downloader.series_calls == [(SERIES_ID, 1)]
    assert [ref.series_id for ref in harness.discovery.refs] == [SERIES_ID]


def test_three_failures_in_a_row_across_jobs_stop_and_cancel_the_queue(harness: Harness) -> None:
    """The failure streak is the server's, like its long break: two failures at the end of one
    job and a third at the start of the next one stop it, and the job behind it is cancelled."""
    for key in ((SERIES_ID, 3), (SERIES_ID, 4), (SECOND_SERIES_ID, 1)):
        harness.downloader.outcomes[key] = (DownloadStatus.FAILED, "HTTP Error 500")
    first = harness.wait_for_job(harness.start_download(episodes="1-4")["job_id"])
    assert [row["status"] for row in first["results"]] == ["done", "done", "failed", "failed"]
    assert first["report"]["stopped"] is None  # two in a row: no stop yet
    stopped, cancelled = harness.batch_snapshots(
        harness.start_batch([SECOND_SERIES_URL, OTHER_SERIES_URL])
    )
    assert [row["status"] for row in stopped["results"]] == ["failed"] * 3
    assert stopped["results"][1]["message"].startswith("stopped: 3 consecutive failures")
    assert stopped["report"]["stopped"] == "3 consecutive failures"
    assert cancelled["state"] == "cancelled"
    assert cancelled["error"] == (
        f"not started: batch stopped in {SECOND_SERIES_NAME} (3 consecutive failures)"
    )
    assert (SECOND_SERIES_ID, 2) not in harness.downloader.series_calls
    assert active_cooldown() is None  # failures are no refusal


class RenamingDiscovery(FakeDiscovery):
    """A FakeDiscovery whose first series comes back under ``name`` (TikTok renamed it)."""

    def __init__(self) -> None:
        super().__init__()
        self.name = SERIES_NAME

    def discover(self, ref: SeriesRef, options: DiscoveryOptions) -> Series:
        series = super().discover(ref, options)
        if ref.series_id == SERIES_ID:
            series.name = self.name
        return series


def test_on_disk_badges_read_the_folder_a_download_would_use(
    make_harness: Callable[..., Harness],
) -> None:
    """A renamed series is downloaded into a new `<new name> [<id>]` folder: the episodes of its
    old folder get no "on disk" badge, since downloading them would cost requests again."""
    discovery = RenamingDiscovery()
    harness = make_harness(discovery)
    harness.finished_rows(episodes="1-2")
    discovery.name = "The Heiress, renamed"
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL, "refresh": True})
    assert status == 200 and data["from_cache"] is False
    assert data["series_dir"] == str(harness.out_dir / f"The Heiress, renamed [{SERIES_ID}]")
    assert data["on_disk_count"] == 0
    assert not any(episode["on_disk"] for episode in data["episodes"])


def test_the_report_of_a_selection_says_how_complete_the_series_is(harness: Harness) -> None:
    """**Download selected** (and **Download all free**, which selects the free episodes): the
    job's rows are its selection, its report the series' — the locked episode is named, what an
    earlier job saved is on disk, nothing else counts as "not downloaded"."""
    first_id, _ = harness.finished_rows(episodes="1,3-4")
    first = harness.wait_for_job(first_id)
    assert first["report"]["line"] == "incomplete: 3 of 5 — 1 locked (5), 1 not downloaded"
    snapshot = harness.wait_for_job(harness.start_download(episodes="2")["job_id"])
    assert [(row["number"], row["status"]) for row in snapshot["results"]] == [(2, "done")]
    report = snapshot["report"]
    assert report["complete"] is True
    assert (report["done"], report["on_disk"], report["locked"]) == (1, 3, 1)
    assert report["line"] == "complete: 4 of 5 (1 downloaded, 3 already on disk) — 1 locked (5)"
