"""Tests for the web UI: the JSON API driven through ``http.client`` against fakes, and JobManager.

No network: a fake Discovery returns a five-episode series (episode 5 locked) and a fake Downloader
writes a tiny file instantly — optionally with a cover sidecar next to it. The real
``engine.download_series`` and manifest run underneath. Every server here binds to 127.0.0.1; the
off-loopback rule is tested by the refusal that comes before any bind.
"""

from __future__ import annotations

import http.client
import json
import logging
import socket
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote

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
from dramafetch.web import server as web_server
from dramafetch.web.jobs import JobManager, cover_sidecar, redact_secrets, result_to_dict
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
VIDEO_URL = "https://www.tiktok.com/@muffindrama_us/video/7699400000000000001"
LOCK_HINTS = ("isFree=false", "isLocked=True", "unlockPrice=30", "no play address")
COVER_HOST = "https://p16-sign-sg.tiktokcdn.com"
TOKEN = "correct-horse-battery-staple"
NOT_FOUND = (404, {"error": "no such file", "kind": "HttpError"})
# SOI + APP0 (JFIF) + padding + EOI: enough for a magic-number check, not a real picture.
JPEG_BYTES = (
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00H\x00H\x00\x00" + b"\x00" * 64 + b"\xff\xd9"
)


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
    """Implements the Downloader protocol: honours the locked rule, writes a tiny file instantly.

    ``write_dir`` (default: the series directory the engine passes in ``options.out_dir``) and
    ``name_format`` shape the path it reports; the episodes in ``cover_numbers`` also get a
    ``<stem>.jpg`` sidecar, the way the real engines save a thumbnail.
    """

    def __init__(self) -> None:
        self.calls: list[int] = []
        self.write_dir: Path | None = None
        self.name_format = "E{number:02d}.mp4"
        self.cover_numbers: set[int] = set()

    def download(self, episode: Episode, options: DownloadOptions) -> DownloadResult:
        self.calls.append(episode.number)
        if episode.locked and not options.include_locked:
            message = "locked: " + ", ".join(episode.lock_hints)
            return DownloadResult(episode, DownloadStatus.SKIPPED_LOCKED, message=message)
        directory = self.write_dir or options.out_dir
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / self.name_format.format(number=episode.number)
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
    assert 'id="token-form"' in body and 'id="token" name="token" type="password"' in body
    assert "/api/session" in body and "error.kind !== 'auth'" in body
    assert "localStorage" not in body and "sessionStorage" not in body


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
