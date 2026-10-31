"""Tests for the web UI: the JSON API driven through ``http.client`` against fakes, and JobManager.

No network: a fake Discovery returns a five-episode series (episode 5 locked) and a fake Downloader
writes an empty file instantly. The real ``engine.download_series`` and manifest run underneath.
"""

from __future__ import annotations

import http.client
import json
import socket
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

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
from dramafetch.web.jobs import JobManager, redact_secrets, result_to_dict
from dramafetch.web.server import MAX_BODY_BYTES, normalize_host, run_server

SERIES_ID = "7699393770256782354"
SERIES_NAME = "The Billionaire's Secret Heiress"
SERIES_URL = f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/3"
VIDEO_URL = "https://www.tiktok.com/@muffindrama_us/video/7699400000000000001"
LOCK_HINTS = ("isFree=false", "isLocked=True", "unlockPrice=30", "no play address")


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
        )
        for number in range(1, 6)
    ]
    episodes[4].lock_hints = LOCK_HINTS
    return Series(
        series_id=SERIES_ID,
        name=name,
        episodes=episodes,
        total_hint=5,
        warnings=["1 episodes look locked"],
    )


class FakeDiscovery:
    """Implements the Discovery protocol: records the refs it gets, answers instantly."""

    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.refs: list[SeriesRef] = []

    def discover(self, ref: SeriesRef, options: DiscoveryOptions) -> Series:
        self.refs.append(ref)
        if self.error is not None:
            raise self.error
        return make_series()


class FakeDownloader:
    """Implements the Downloader protocol: honours the locked rule, writes a tiny file instantly."""

    def __init__(self) -> None:
        self.calls: list[int] = []

    def download(self, episode: Episode, options: DownloadOptions) -> DownloadResult:
        self.calls.append(episode.number)
        if episode.locked and not options.include_locked:
            message = "locked: " + ", ".join(episode.lock_hints)
            return DownloadResult(episode, DownloadStatus.SKIPPED_LOCKED, message=message)
        path = options.out_dir / f"E{episode.number:02d}.mp4"
        path.write_bytes(b"fake video")
        return DownloadResult(episode, DownloadStatus.DONE, path=path, message="ok")


@dataclass
class Harness:
    port: int
    out_dir: Path
    discovery: FakeDiscovery
    downloader: FakeDownloader

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        raw: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, Any]:
        payload = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        request_headers = {"Content-Type": "application/json"} if payload is not None else {}
        request_headers.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            connection.request(method, path, body=payload, headers=request_headers)
            response = connection.getresponse()
            data = response.read()
            content_type = response.getheader("Content-Type") or ""
            parsed = json.loads(data) if "json" in content_type else data.decode("utf-8")
            return response.status, parsed
        finally:
            connection.close()

    def start_download(self, **body: Any) -> dict[str, Any]:
        status, job = self.request("POST", "/api/download", {"url": SERIES_URL, **body})
        assert status == 202, job
        return job

    def wait_for_job(self, job_id: str, timeout: float = 15.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            status, snapshot = self.request("GET", f"/api/jobs/{job_id}")
            assert status == 200, snapshot
            if snapshot["state"] in {"done", "error"}:
                return snapshot
            if time.monotonic() > deadline:
                pytest.fail(f"job {job_id} still {snapshot['state']} after {timeout}s")
            time.sleep(0.05)


@pytest.fixture
def make_harness(tmp_path: Path) -> Iterator[Callable[..., Harness]]:
    servers = []

    def factory(discovery: FakeDiscovery | None = None) -> Harness:
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
        )
        # A short poll interval keeps shutdown() (fixture teardown) fast.
        thread = threading.Thread(
            target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        thread.start()
        servers.append((server, thread))
        return Harness(server.server_address[1], out_dir, discovery, downloader)

    yield factory
    for server, thread in servers:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture
def harness(make_harness: Callable[..., Harness]) -> Harness:
    return make_harness()


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


def test_security_headers(harness: Harness) -> None:
    connection = http.client.HTTPConnection("127.0.0.1", harness.port, timeout=15)
    try:
        connection.request("GET", "/")
        response = connection.getresponse()
        response.read()
    finally:
        connection.close()
    assert response.getheader("X-Content-Type-Options") == "nosniff"
    assert "connect-src 'self'" in (response.getheader("Content-Security-Policy") or "")
    assert "Python" not in (response.getheader("Server") or "")


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
    assert last["locked"] is True and "isFree=false" in last["lock_hints"]
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
    assert data["kind"] == "LoginRequiredError"
    assert "--cookies" in data["hint"]


def test_resolve_challenge_is_503_with_headful_hint(make_harness: Callable[..., Harness]) -> None:
    harness = make_harness(FakeDiscovery(ChallengeError("Verify to continue")))
    status, data = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    assert status == 503
    assert "--headful" in data["hint"]


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
    assert harness.downloader.calls == [1, 2, 3, 4, 5]

    _, resolved = harness.request("POST", "/api/resolve", {"url": SERIES_URL})
    series_dir = Path(resolved["series_dir"])
    assert series_dir.parent == harness.out_dir  # the UI cannot choose paths
    assert sorted(p.name for p in series_dir.glob("*.mp4")) == [f"E0{n}.mp4" for n in range(1, 5)]
    assert (series_dir / "dramafetch.json").is_file()
    for row in snapshot["results"][:4]:
        assert Path(row["path"]).is_file()


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


def test_redact_secrets() -> None:
    assert (
        redact_secrets("sessionid=abc; msToken=xyz ok")
        == "sessionid=<redacted>; msToken=<redacted> ok"
    )
    assert redact_secrets("cookie: 123abc tail") == "cookie=<redacted> tail"
    assert redact_secrets("no secrets here") == "no secrets here"


def test_result_to_dict() -> None:
    episode = make_series().episodes[0]
    row = result_to_dict(DownloadResult(episode, DownloadStatus.DRY_RUN, message="would fetch"))
    assert row == {
        "number": 1,
        "title": episode.title,
        "status": "dry-run",
        "message": "would fetch",
        "path": None,
    }
    with_path = result_to_dict(
        DownloadResult(episode, DownloadStatus.DONE, path=Path("/tmp/E01.mp4"), message="")
    )
    assert with_path["path"] == "/tmp/E01.mp4"
