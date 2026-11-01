"""The local web UI: a stdlib ``http.server`` that serves one page and a small JSON API.

Routes::

    GET  /                          the page (static/index.html, read through importlib.resources)
    POST /api/session  {"token"}    -> 204 + the session cookie, or 401 (needs no token itself)
    POST /api/resolve  {"url", "refresh"?}  -> the series and its episodes (each with its
                                    cover_url) plus "from_cache" and "resolved_at" (epoch seconds)
    POST /api/download {"url", "episodes", "include_locked"} -> 202 {"job_id": ...}
    GET  /api/jobs/<id>             the job snapshot (see jobs.py) -> 200, or 404 when unknown
    GET  /api/files/<job>/<number>  the finished video of that job row -> the bytes, or 404
    GET  /api/files/<job>/<number>/cover   its cover: the <stem>.jpg|.jpeg|.png|.webp sidecar when
                                    one exists, else the one embedded in the video, or 404
    GET  /api/doctor                the `dramafetch doctor` facts as JSON

Rules: the server binds to the host it is given and nothing else (the CLI defaults to 127.0.0.1;
an empty host is refused), and binding to anything but loopback requires an access token
(``DramaFetchServer(..., token=...)``; ``dramafetch serve --token``). With a token, every request
except ``GET /`` and ``POST /api/session`` must carry ``Authorization: Bearer <token>`` or the
cookie ``dramafetch_session=<token>`` (compared with ``hmac.compare_digest``); otherwise it is
answered 401 ``{"error": "token required", "kind": "auth", ...}`` before anything else happens —
in particular before any request to TikTok. ``POST /api/session`` with the right token sets that
cookie (``HttpOnly; SameSite=Strict; Path=/; Max-Age=30 days``). Without a token (the loopback
default) nothing is checked. JSON bodies are capped at 64 KiB (413). POSTs must carry
``Content-Type: application/json``, so a browser on another site cannot fire one without a CORS
preflight we never answer, and the ``Host`` header must name the bound host or localhost (a guard
against DNS rebinding; bound to every interface — ``0.0.0.0`` / ``::`` — the server cannot know
its own addresses, so there any IP literal is accepted but still no other host name). The output
directory is fixed server-side: the page cannot choose paths, and the files endpoint serves
nothing but the path a finished (``done``) job row recorded — or, for ``/cover``, the sidecar next
to it, else the cover embedded in that video, read into memory only after the video passed the
same check — and only when it resolves to a regular file inside that directory (never a ``.part``):
anything else is a 404 that names no path. Errors are ``{"error": message, "kind": ExceptionName}``
with a 4xx/5xx status; cookie and token values never appear in responses or logs (the log says
``token: set`` or ``token: none``). Resolving a series runs synchronously inside the request: the
discovery opens TikTok in a browser and usually takes 10-40 s, so the page shows a waiting note.

Fewer requests to TikTok: a resolved episode list is kept in memory for ``SERIES_CACHE_TTL_S``
(15 minutes; the ``SERIES_CACHE_SIZE`` most recently resolved series) and reused by both
``POST /api/resolve`` and ``POST /api/download``, so "Resolve" followed by "Download all free"
costs one discovery, not two; ``{"url": ..., "refresh": true}`` on ``/api/resolve`` fetches the
list again, and a failed resolve is never cached. Discoveries run one at a time. And after TikTok
refused a request (HTTP 403, HTTP 429, a captcha — recorded by the engines and the CLI in the
cooldown file, see ``dramafetch.cooldown``) both routes refuse to contact TikTok until the cooldown
ends: ``429 {"error": <the cooldown message>, "kind": "cooldown", "hint": ...}`` with a
``Retry-After`` header in seconds. ``/api/resolve`` still serves a cached list then (no request
involved); ``/api/download`` is refused outright, and a job already queued behind one that met the
refusal is ended as ``error`` with the same message instead of knocking again (``JobManager``'s
gate).
"""

from __future__ import annotations

import functools
import hmac
import ipaddress
import json
import logging
import math
import os
import re
import shutil
import socket
import threading
import time
import unicodedata
from collections import OrderedDict
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, replace
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

from dramafetch import __version__
from dramafetch.cooldown import Cooldown, cooldown_message
from dramafetch.errors import (
    ChallengeError,
    DiscoveryError,
    LoginRequiredError,
    RateLimitedError,
    UnsupportedUrlError,
)
from dramafetch.models import (
    Discovery,
    DiscoveryOptions,
    Downloader,
    DownloadOptions,
    DownloadStatus,
    Series,
    SeriesRef,
    VideoRef,
)
from dramafetch.thumbnails import cover_sidecar
from dramafetch.web.jobs import JobManager, Runner, redact_secrets

log = logging.getLogger(__name__)

MAX_BODY_BYTES = 64 * 1024
# An oversized body up to this size is read and discarded so the client sees the 413 instead of a
# reset connection; anything bigger is answered and the connection is closed.
_DRAIN_LIMIT = 1024 * 1024
_WILDCARD_HOSTS = frozenset({"0.0.0.0", "::", "[::]"})
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "[::1]"})
_JOBS_PREFIX = "/api/jobs/"
_FILES_PREFIX = "/api/files/"
# Covers are loaded by the browser from TikTok's CDN (https) — or the fake server (http) in tests;
# everything else stays same-origin and inline.
_CSP = (
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    "connect-src 'self'; img-src 'self' data: https: http:; form-action 'none'; base-uri 'none'"
)

#: How long a resolved episode list is reused by ``POST /api/resolve`` and ``POST /api/download``
#: (seconds): "Resolve" then "Download all free" costs one discovery, not two, and resolving the
#: same series again within the window costs nothing (``"refresh": true`` fetches it anew).
SERIES_CACHE_TTL_S = 15 * 60
#: How many series the cache keeps: the most recently resolved ones (per process, in memory).
SERIES_CACHE_SIZE = 32
#: ``kind`` of the 429 answered while TikTok is not to be contacted (see :func:`cooldown_error`).
COOLDOWN_KIND = "cooldown"
COOLDOWN_HINT_PREFIX = "wait; the server refuses to contact TikTok until "

SESSION_COOKIE = "dramafetch_session"
SESSION_MAX_AGE_S = 30 * 24 * 3600  # the cookie POST /api/session sets lasts a month
TOKEN_MIN_CHARS = 8
TOKEN_REQUIRED_MESSAGE = "token required"
TOKEN_HINT = "enter the token the server was started with"
#: The only requests a token does not protect: the page itself and the endpoint that turns the
#: token into the session cookie (which checks the token it is given).
_PUBLIC_ROUTES = frozenset({("GET", "/"), ("GET", "/index.html"), ("POST", "/api/session")})
# RFC 6265 cookie-octets (visible ASCII without space, double quote, comma, semicolon or
# backslash): the token travels back in `dramafetch_session=<token>` and after `Bearer `.
_TOKEN_RE = re.compile(r"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+")
#: What the files endpoint serves, by suffix; anything else is a generic byte stream.
_CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/x-m4v",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
#: The file name an embedded cover is offered under: ``<video stem>`` + the suffix of its MIME type
#: (``thumbnails.extract_cover`` yields JPEG or PNG; anything else is not served).
_COVER_SUFFIX_BY_TYPE = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
_CHUNK_BYTES = 64 * 1024
# Dropped from the ASCII fallback file name (RFC 6266): quotes and backslashes would end or escape
# the quoted-string, control characters have no place in a header.
_UNSAFE_ASCII_RE = re.compile(r'[\\"\x00-\x1f\x7f]')

LOGIN_HINT = (
    "Export cookies.txt (Netscape format) from the browser where you are logged in to TikTok and "
    "restart the server: dramafetch serve --cookies cookies.txt"
)
CHALLENGE_HINT = (
    "TikTok wants a human check, which also starts the 30-minute cooldown: once it has ended, "
    "restart with --headful, solve it in the window that opens and try again"
)
RATE_LIMIT_HINT = (
    "TikTok is rate-limiting this address: wait 30-60 minutes before resolving or downloading "
    "again, and never run two instances at once"
)
VIDEO_URL_MESSAGE = (
    "That is a single video: paste a series URL (…/shortdrama/episode/<series id>/<episode>) or "
    "use the CLI `video` command"
)


class HttpError(Exception):
    """An error with the HTTP status it should be reported with (and, for a few, extra response
    headers: the cooldown's ``Retry-After``)."""

    def __init__(
        self,
        status: int,
        message: str,
        *,
        kind: str | None = None,
        hint: str | None = None,
        headers: Iterable[tuple[str, str]] = (),
    ) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.kind = kind or type(self).__name__
        self.hint = hint
        self.headers = tuple(headers)


def _no_such_file() -> HttpError:
    """The files endpoint's only failure: it never says whether the job, row or path exists."""
    return HttpError(HTTPStatus.NOT_FOUND, "no such file")


def current_cooldown() -> Cooldown | None:
    """The cooldown in force — TikTok refused a request (HTTP 403, HTTP 429, a captcha) less than
    30 minutes ago, as the engines and the CLI record it in ``cooldown.json`` — read through the
    engine's seam ``engine.check_cooldown()``, or ``None`` when TikTok may be contacted. Never
    raises: a missing or corrupt file counts as no cooldown (``dramafetch.cooldown``)."""
    from dramafetch import engine  # lazy: sibling module, pulls in yt-dlp

    return engine.check_cooldown()


def cooldown_error(cooldown: Cooldown, *, now: float | None = None) -> HttpError:
    """The 429 ``/api/resolve`` (on a cache miss) and ``/api/download`` answer during a cooldown:
    the full cooldown message (when TikTok refused, until when, the file to delete), ``kind``
    ``"cooldown"`` — the page disables its download buttons and counts the minutes down — a hint
    naming the hour, and a ``Retry-After`` header with the seconds left (at least 1)."""
    current = time.time() if now is None else now
    seconds = max(1, math.ceil(cooldown.until - current))
    until = time.strftime("%H:%M", time.localtime(cooldown.until))
    return HttpError(
        HTTPStatus.TOO_MANY_REQUESTS,
        cooldown_message(cooldown, now=current),
        kind=COOLDOWN_KIND,
        hint=f"{COOLDOWN_HINT_PREFIX}{until}",
        headers=(("Retry-After", str(seconds)),),
    )


@dataclass(frozen=True)
class ResolvedSeries:
    """What ``/api/resolve`` answers with: the series, when its list was fetched (seconds since the
    epoch) and whether it came from the cache rather than from a discovery just now."""

    series: Series
    resolved_at: float
    from_cache: bool


class SeriesCache:
    """The resolved episode lists by series id, each kept for ``ttl_s`` seconds after its discovery.

    In memory, per process, bounded to the ``size`` most recently resolved series (the oldest
    entry makes room), thread-safe (requests are handled in threads). Only successful resolves are
    stored — a failure never is — and an entry older than ``ttl_s`` is dropped when it is asked
    for. ``clock`` is ``time.time`` unless a test injects one.
    """

    def __init__(
        self,
        ttl_s: float = SERIES_CACHE_TTL_S,
        size: int = SERIES_CACHE_SIZE,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.ttl_s = ttl_s
        self.size = size
        self.clock = clock
        self._entries: OrderedDict[str, tuple[float, Series]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, series_id: str) -> tuple[float, Series] | None:
        """``(resolved_at, series)`` when the series was resolved less than ``ttl_s`` ago."""
        with self._lock:
            entry = self._entries.get(series_id)
            if entry is None:
                return None
            if self.clock() - entry[0] >= self.ttl_s:
                del self._entries[series_id]
                return None
            return entry

    def put(self, series_id: str, series: Series) -> float:
        """Store a series resolved just now (replacing an older entry) and return its
        ``resolved_at``; beyond ``size`` entries the least recently resolved one is dropped."""
        resolved_at = self.clock()
        with self._lock:
            self._entries.pop(series_id, None)
            self._entries[series_id] = (resolved_at, series)
            while len(self._entries) > self.size:
                self._entries.popitem(last=False)
        return resolved_at

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


@dataclass(frozen=True)
class EmbeddedCover:
    """A cover read out of the video's ``covr`` atom, served from memory: the image bytes, their
    MIME type (``image/jpeg`` or ``image/png``) and the ``<video stem>.jpg|.png`` name to offer."""

    data: bytes
    content_type: str
    file_name: str


def is_loopback_host(host: str) -> bool:
    """``localhost`` or a loopback address (``127.x.x.x``, ``::1``), IPv6 brackets tolerated.

    Only such a host may be bound without an access token: anything else is reachable from the
    network. A host *name* other than ``localhost`` cannot be checked, so it counts as not loopback.
    """
    cleaned = host.strip()
    if cleaned.startswith("[") and cleaned.endswith("]"):
        cleaned = cleaned[1:-1].strip()
    if cleaned.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(cleaned).is_loopback
    except ValueError:
        return False


def _is_ip_literal(name: str) -> bool:
    """``192.168.1.20`` or ``[fe80::1]`` (port already removed): an address, not a host name."""
    try:
        ipaddress.ip_address(name.strip("[]"))
    except ValueError:
        return False
    return True


def host_header_allowed(bound_host: str, host_header: str | None) -> bool:
    """Whether a server bound to ``bound_host`` may answer a request with this ``Host`` header.

    The guard against DNS rebinding: a page on an attacker's site reaches this server only under
    a name the attacker controls, so the header must name the bound host or localhost (the port
    is ignored). Bound to every interface (``0.0.0.0`` / ``::``) the server cannot know its own
    addresses, so there it accepts any IP literal — ``http://<pc-ip>:8765/``, the way the README
    says to reach it — and the local names, but still no other host name. No header, no answer.
    """
    if not host_header:
        return False
    name = host_header.strip().lower()
    if name.startswith("["):
        name = name.split("]", 1)[0] + "]"
    elif name.count(":") == 1:
        name = name.rsplit(":", 1)[0]
    if name in _LOCAL_HOSTS:
        return True
    if bound_host in _WILDCARD_HOSTS:
        return _is_ip_literal(name)
    return name.strip("[]") == bound_host.lower()


def token_problem(token: str) -> str | None:
    """Why ``token`` cannot be the access token, or ``None`` when it can; never echoes the token."""
    if len(token) < TOKEN_MIN_CHARS:
        return f"the token must be at least {TOKEN_MIN_CHARS} characters"
    if not _TOKEN_RE.fullmatch(token):
        return (
            "the token must be visible ASCII without spaces, quotes, commas, semicolons or "
            "backslashes (it travels in a cookie)"
        )
    return None


def content_type_for(path: Path) -> str:
    """The ``Content-Type`` of a served file, from its suffix."""
    return _CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")


def content_disposition(name: str) -> str:
    """``attachment`` with an ASCII fallback ``filename`` and the UTF-8 ``filename*`` (RFC 6266)."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    ascii_name = re.sub(r"\s+", " ", _UNSAFE_ASCII_RE.sub("", ascii_name)).strip()
    if not ascii_name or ascii_name.startswith("."):  # nothing but the suffix survived
        suffix = Path(name).suffix
        ascii_name = "download" + (suffix if suffix.isascii() else "")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name, safe='')}"


def index_html() -> str:
    """The page, read from the package so it works from a wheel as well as from a checkout."""
    return (resources.files("dramafetch.web") / "static" / "index.html").read_text(encoding="utf-8")


def series_to_dict(series: Series, out_dir: Path) -> dict[str, Any]:
    """The JSON the page renders after `/api/resolve`."""
    from dramafetch.manifest import series_dir  # lazy: sibling module, engine side

    return {
        "series_id": series.series_id,
        "name": series.name,
        "display_name": series.display_name,
        "total_hint": series.total_hint,
        "warnings": list(series.warnings),
        "series_dir": str(series_dir(out_dir, series)),
        "episodes": [
            {
                "number": episode.number,
                "item_id": episode.item_id,
                "title": episode.title,
                "duration_s": episode.duration_s,
                "locked": episode.locked,
                "lock_hints": list(episode.lock_hints),
                "page_url": episode.page_url,
                "cover_url": episode.cover_url,
            }
            for episode in sorted(series.episodes, key=lambda episode: episode.number)
        ],
    }


class DramaFetchServer(ThreadingHTTPServer):
    """``ThreadingHTTPServer`` carrying the fixed configuration every request handler needs."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        *,
        out_dir: Path,
        discovery_options: DiscoveryOptions,
        download_options: DownloadOptions,
        discovery: Discovery | None,
        downloader: Downloader | None,
        jobs: JobManager | None = None,
        token: str | None = None,
    ) -> None:
        self.bound_host = address[0]
        # Both checks come before the bind: a wrongly protected server never opens a socket.
        if token is not None:
            problem = token_problem(token)
            if problem is not None:
                raise ValueError(problem)
        elif not is_loopback_host(self.bound_host):
            raise ValueError(
                f"binding to {self.bound_host} needs an access token: without one the UI would be "
                "open to everyone on the network"
            )
        self.token = token
        if ":" in self.bound_host:
            self.address_family = socket.AF_INET6
        self.out_dir = out_dir.expanduser().absolute()
        self.discovery_options = discovery_options
        self.download_options = replace(download_options, out_dir=self.out_dir)
        self.discovery = discovery
        self.downloader = downloader
        self.series_cache = SeriesCache()
        # One discovery at a time: a request for a series another request is resolving waits for
        # it and then takes the cached list, instead of opening a second browser against TikTok.
        self.resolve_lock = threading.Lock()
        self.jobs = jobs or JobManager(gate=self.job_refusal)
        super().__init__(address, _Handler)

    def job_refusal(self) -> str | None:
        """Why a job may not start now — the cooldown message while TikTok refused a request less
        than 30 minutes ago — or ``None``. The ``JobManager`` asks right before a job would start
        downloading, so a job queued behind one that met a 429 is ended instead of knocking again
        (``POST /api/download`` itself is already refused while the cooldown lasts)."""
        cooldown = current_cooldown()
        return None if cooldown is None else cooldown_message(cooldown)

    def runner(self) -> Runner:
        """``engine.download_series`` bound to the injected downloader (tests) or yt-dlp."""
        from dramafetch.engine import download_series  # lazy: pulls in yt-dlp

        if self.downloader is None:
            return download_series
        return functools.partial(download_series, downloader=self.downloader)

    def host_allowed(self, host_header: str | None) -> bool:
        """Accept only requests addressed to the bound host or localhost (any IP literal for a
        wildcard bind), never another host name: :func:`host_header_allowed`, the DNS-rebinding
        guard."""
        return host_header_allowed(self.bound_host, host_header)

    def served_file(self, job_id: str, number: int, *, cover: bool = False) -> Path | None:
        """The video (or, with ``cover``, the cover sidecar) a finished job row points at, if it may
        be served: the row must be ``done`` with a path, and that path — or its first existing
        ``<stem>.jpg|.jpeg|.png|.webp`` sidecar — must resolve (symlinks followed) to a regular file
        inside ``out_dir`` that is no ``.part`` (:meth:`_confined_file`). ``None`` otherwise; the
        caller answers 404 without saying why. The URL only ever selects a row: no part of it
        touches the file system. A cover embedded in the video is :meth:`served_cover`'s job."""
        path = self._recorded_path(job_id, number)
        if path is None:
            return None
        if cover:
            sidecar = cover_sidecar(path)
            if sidecar is None:
                return None
            path = sidecar
        return self._confined_file(path)

    def served_cover(self, job_id: str, number: int) -> Path | EmbeddedCover | None:
        """The cover of a finished job row: the sidecar's path when one sits next to the video
        (:meth:`served_file` with ``cover=True`` — a sidecar that exists but may not be served is
        never replaced by the embedded one), else the cover embedded in the video itself, read into
        memory with ``thumbnails.extract_cover`` — but only once the video passed the very same
        confinement check, so nothing outside ``out_dir`` is ever opened. ``None`` when there is
        neither (or the row may not be served): the caller answers the one 404."""
        path = self._recorded_path(job_id, number)
        if path is None:
            return None
        if cover_sidecar(path) is not None:
            return self.served_file(job_id, number, cover=True)
        video = self._confined_file(path)
        if video is None:
            return None
        from dramafetch.thumbnails import MAX_COVER_BYTES, extract_cover  # lazy: may load mutagen

        extracted = extract_cover(video)
        if extracted is None:
            return None
        data, content_type = extracted
        suffix = _COVER_SUFFIX_BY_TYPE.get(content_type)
        if suffix is None or len(data) > MAX_COVER_BYTES:  # not an image we name, or not a cover
            return None
        return EmbeddedCover(data, content_type, video.stem + suffix)

    def _recorded_path(self, job_id: str, number: int) -> Path | None:
        """The path a ``done`` row of the job recorded, as recorded (not yet checked), or ``None``
        for an unknown job, an unknown row, or a row that is not ``done`` with a path."""
        snapshot = self.jobs.get(job_id)
        if snapshot is None:
            return None
        row = next((row for row in snapshot["results"] if row["number"] == number), None)
        if row is None or row["status"] != DownloadStatus.DONE.value or not row["path"]:
            return None
        return Path(row["path"])

    def _confined_file(self, path: Path) -> Path | None:
        """``path`` resolved (symlinks followed) when it is a regular file inside ``out_dir`` and no
        ``.part`` before or after resolving; ``None`` otherwise. Nothing is opened here: this is
        the check that must pass before any file is read for a response."""
        if path.suffix.lower() == ".part":
            return None
        try:
            resolved = path.resolve(strict=True)
        except (OSError, RuntimeError):  # gone, unreadable, or a symlink loop
            return None
        if resolved.suffix.lower() == ".part" or not resolved.is_file():
            return None
        if not resolved.is_relative_to(self.out_dir.resolve()):
            return None
        return resolved

    def handle_error(self, request: Any, client_address: Any) -> None:
        log.debug("error while handling a request from %s", client_address, exc_info=True)


class _Handler(BaseHTTPRequestHandler):
    server_version = f"DramaFetch/{__version__}"
    sys_version = ""  # do not advertise the Python version

    @property
    def app(self) -> DramaFetchServer:
        server = self.server
        if not isinstance(server, DramaFetchServer):  # pragma: no cover - wiring error
            raise TypeError("handler mounted on a server without DramaFetch configuration")
        return server

    # ------------------------------------------------------------------ routing

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def _dispatch(self, method: str) -> None:
        path = urlsplit(self.path).path
        try:
            if not self.app.host_allowed(self.headers.get("Host")):
                raise HttpError(HTTPStatus.FORBIDDEN, "unexpected Host header")
            self._require_token(method, path)
            if method == "GET":
                self._get(path)
            else:
                self._post(path)
        except HttpError as exc:
            self._send_error(exc)
        except Exception as exc:  # never leak a traceback to the page
            log.warning("%s %s failed: %s", method, path, redact_secrets(str(exc))[:300])
            log.debug("traceback", exc_info=True)
            self._send_error(
                HttpError(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    redact_secrets(f"{type(exc).__name__}: {exc}")[:300],
                    kind=type(exc).__name__,
                )
            )

    def _get(self, path: str) -> None:
        if path in {"/", "/index.html"}:
            self._send_html(index_html())
        elif path == "/api/doctor":
            self._send_json(HTTPStatus.OK, self._doctor())
        elif path.startswith(_JOBS_PREFIX):
            job_id = path[len(_JOBS_PREFIX) :].strip("/")
            snapshot = self.app.jobs.get(job_id) if job_id else None
            if snapshot is None:
                raise HttpError(HTTPStatus.NOT_FOUND, "unknown job")
            self._send_json(HTTPStatus.OK, snapshot)
        elif path.startswith(_FILES_PREFIX):
            self._send_file(path[len(_FILES_PREFIX) :])
        else:
            raise HttpError(HTTPStatus.NOT_FOUND, f"no such page: {path[:80]}")

    def _post(self, path: str) -> None:
        if path == "/api/session":
            self._open_session(self._read_json_body())
        elif path == "/api/resolve":
            body = self._read_json_body()
            resolved = self._resolve(body, allow_refresh=True)
            payload = series_to_dict(resolved.series, self.app.out_dir)
            payload["from_cache"] = resolved.from_cache
            payload["resolved_at"] = resolved.resolved_at
            self._send_json(HTTPStatus.OK, payload)
        elif path == "/api/download":
            body = self._read_json_body()
            self._send_json(HTTPStatus.ACCEPTED, self._start_download(body))
        else:
            raise HttpError(HTTPStatus.NOT_FOUND, f"no such endpoint: {path[:80]}")

    # ------------------------------------------------------------------ access token

    def _require_token(self, method: str, path: str) -> None:
        """401 for everything but the page and ``POST /api/session`` when the server has a token and
        the request carries neither ``Authorization: Bearer <token>`` nor the session cookie."""
        token = self.app.token
        if token is None or (method, path) in _PUBLIC_ROUTES:
            return
        expected = token.encode("utf-8")
        for presented in self._presented_tokens():
            if hmac.compare_digest(presented.encode("utf-8"), expected):
                return
        raise HttpError(
            HTTPStatus.UNAUTHORIZED, TOKEN_REQUIRED_MESSAGE, kind="auth", hint=TOKEN_HINT
        )

    def _presented_tokens(self) -> Iterator[str]:
        """The credentials a request carries: the Bearer token, then the FIRST session cookie.

        At most two candidates per request. A browser holds one ``dramafetch_session`` cookie for
        this host (``Path=/``, no ``Domain``; a new ``POST /api/session`` replaces it), whereas
        taking every value of every ``Cookie`` header would let one request test some 180 000
        guesses: ``http.server`` reads up to 100 header lines of 64 KiB each.
        """
        authorization = str(self.headers.get("Authorization") or "")
        scheme, _, credentials = authorization.strip().partition(" ")
        if scheme.lower() == "bearer" and credentials.strip():
            yield credentials.strip()
        for header in self.headers.get_all("Cookie") or []:
            for part in str(header).split(";"):
                name, separator, value = part.strip().partition("=")
                if separator and name.strip() == SESSION_COOKIE and value.strip():
                    yield value.strip()
                    return

    def _open_session(self, body: dict[str, Any]) -> None:
        """Turn the right token into the session cookie (204); a wrong one is a 401 at once."""
        token = self.app.token
        if token is None:
            raise HttpError(
                HTTPStatus.BAD_REQUEST, "this server was started without a token; no session needed"
            )
        presented = body.get("token")
        if not isinstance(presented, str):
            raise HttpError(HTTPStatus.BAD_REQUEST, 'the JSON body needs a string "token"')
        if not hmac.compare_digest(presented.encode("utf-8"), token.encode("utf-8")):
            raise HttpError(HTTPStatus.UNAUTHORIZED, "wrong token", kind="auth", hint=TOKEN_HINT)
        cookie = (
            f"{SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; "
            f"Max-Age={SESSION_MAX_AGE_S}"
        )
        self._send_headers(HTTPStatus.NO_CONTENT, [("Set-Cookie", cookie)])

    # ------------------------------------------------------------------ handlers

    def _resolve(self, body: dict[str, Any], *, allow_refresh: bool) -> ResolvedSeries:
        """The series the body's ``url`` names: the cached list when it was resolved less than
        ``SERIES_CACHE_TTL_S`` ago (``from_cache``), else one discovery — refused with the
        cooldown's 429 while TikTok is not to be contacted. ``"refresh": true`` (honoured on
        ``/api/resolve`` only) skips the cache. Discoveries run one at a time: a request for a
        series another request is resolving waits and then takes the fresh entry."""
        from dramafetch.urls import parse_input

        url = body.get("url")
        if not isinstance(url, str) or not url.strip():
            raise HttpError(HTTPStatus.BAD_REQUEST, 'the JSON body needs a non-empty "url"')
        try:
            ref = parse_input(url)
        except UnsupportedUrlError as exc:
            raise HttpError(HTTPStatus.BAD_REQUEST, str(exc), kind=type(exc).__name__) from exc
        if isinstance(ref, VideoRef):
            raise HttpError(HTTPStatus.BAD_REQUEST, VIDEO_URL_MESSAGE, kind="UnsupportedUrlError")
        refresh = body.get("refresh", False) if allow_refresh else False
        if not isinstance(refresh, bool):
            raise HttpError(HTTPStatus.BAD_REQUEST, '"refresh" must be true or false')
        app = self.app
        cached = None if refresh else app.series_cache.get(ref.series_id)
        if cached is not None:  # served without any request, cooldown or not
            return ResolvedSeries(cached[1], cached[0], from_cache=True)
        with app.resolve_lock:
            cached = None if refresh else app.series_cache.get(ref.series_id)
            if cached is not None:  # the request that held the lock resolved this very series
                return ResolvedSeries(cached[1], cached[0], from_cache=True)
            cooldown = current_cooldown()
            if cooldown is not None:
                raise cooldown_error(cooldown)
            series = self._discover(ref)
            resolved_at = app.series_cache.put(ref.series_id, series)
        return ResolvedSeries(series, resolved_at, from_cache=False)

    def _discover(self, ref: SeriesRef) -> Series:
        """One discovery through the engine (which records the cooldown after a rate limit or a
        captcha, so the next request meets it), its errors mapped to HTTP answers."""
        from dramafetch import engine  # lazy: sibling module, pulls in Playwright on demand

        app = self.app
        try:
            return engine.resolve(ref, app.discovery_options, discovery=app.discovery)
        except LoginRequiredError as exc:
            raise HttpError(
                HTTPStatus.UNAUTHORIZED, str(exc), kind=type(exc).__name__, hint=LOGIN_HINT
            ) from exc
        except ChallengeError as exc:
            raise HttpError(
                HTTPStatus.SERVICE_UNAVAILABLE,
                str(exc),
                kind=type(exc).__name__,
                hint=CHALLENGE_HINT,
            ) from exc
        except RateLimitedError as exc:
            raise HttpError(
                HTTPStatus.TOO_MANY_REQUESTS,
                str(exc),
                kind=type(exc).__name__,
                hint=RATE_LIMIT_HINT,
            ) from exc
        except DiscoveryError as exc:
            raise HttpError(HTTPStatus.BAD_GATEWAY, str(exc), kind=type(exc).__name__) from exc

    def _start_download(self, body: dict[str, Any]) -> dict[str, Any]:
        from dramafetch import engine  # lazy: sibling module

        app = self.app
        spec = body.get("episodes")
        if spec is not None and not isinstance(spec, str):
            raise HttpError(
                HTTPStatus.BAD_REQUEST, '"episodes" must be a string like "1-5,8" or null'
            )
        include_locked = body.get("include_locked", app.download_options.include_locked)
        if not isinstance(include_locked, bool):
            raise HttpError(HTTPStatus.BAD_REQUEST, '"include_locked" must be true or false')
        cooldown = current_cooldown()
        if cooldown is not None:  # a cached list changes nothing: the job itself would knock
            raise cooldown_error(cooldown)
        series = self._resolve(body, allow_refresh=False).series
        try:
            episodes = engine.select_episodes(series, spec)
        except ValueError as exc:
            raise HttpError(HTTPStatus.BAD_REQUEST, str(exc), kind="ValueError") from exc
        if not episodes:
            raise HttpError(
                HTTPStatus.BAD_REQUEST,
                f"no listed episode matches {spec!r} (the series lists {len(series.episodes)})",
            )
        options = replace(app.download_options, include_locked=include_locked)
        job_id = app.jobs.start(series, episodes, options, runner=app.runner())
        return {
            "job_id": job_id,
            "series_id": series.series_id,
            "series_name": series.name,
            "total": len(episodes),
            "numbers": [episode.number for episode in episodes],
        }

    def _doctor(self) -> dict[str, Any]:
        from dramafetch.cli import doctor_as_dicts  # lazy: the CLI owns the doctor checks

        options = self.app.discovery_options
        return {
            "checks": doctor_as_dicts(
                browser_channel=options.browser_channel,
                browser_path=options.executable_path,
                cookies_file=options.cookies_file,
            ),
            "out_dir": str(self.app.out_dir),
            "version": __version__,
        }

    def _send_file(self, rest: str) -> None:
        """``<job id>/<number>`` or ``<job id>/<number>/cover`` after ``/api/files/``: stream the
        file the job row points at (:meth:`DramaFetchServer.served_file`) — for ``/cover`` the
        sidecar, or the embedded cover sent from memory (:meth:`DramaFetchServer.served_cover`) —
        or the one 404."""
        parts = rest.split("/")
        if len(parts) not in {2, 3} or (len(parts) == 3 and parts[2] != "cover"):
            raise _no_such_file()
        job_id, number = parts[0], parts[1]
        if not job_id or not (number.isascii() and number.isdigit()):
            raise _no_such_file()
        target: Path | EmbeddedCover | None
        if len(parts) == 3:
            target = self.app.served_cover(job_id, int(number))
        else:
            target = self.app.served_file(job_id, int(number))
        if target is None:
            raise _no_such_file()
        if isinstance(target, EmbeddedCover):
            # Already in memory (capped at MAX_COVER_BYTES): Content-Length, no-store and the
            # other fixed headers come from _send_bytes / _send_headers like for any response.
            self._send_bytes(
                HTTPStatus.OK,
                target.data,
                target.content_type,
                [("Content-Disposition", content_disposition(target.file_name))],
            )
            return
        with target.open("rb") as handle:
            size = os.fstat(handle.fileno()).st_size
            self._send_headers(
                HTTPStatus.OK,
                [
                    ("Content-Type", content_type_for(target)),
                    ("Content-Length", str(size)),
                    ("Content-Disposition", content_disposition(target.name)),
                ],
            )
            try:
                shutil.copyfileobj(handle, self.wfile, _CHUNK_BYTES)  # 64 KiB at a time
            except OSError:  # the client went away mid-download (or the file did)
                self.close_connection = True
                log.debug("download of %s was cut short", target.name, exc_info=True)

    # ------------------------------------------------------------------ plumbing

    def _read_json_body(self) -> dict[str, Any]:
        content_type = self.headers.get("Content-Type", "") or ""
        if content_type.split(";", 1)[0].strip().lower() != "application/json":
            raise HttpError(
                HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "send JSON with Content-Type: application/json"
            )
        try:
            length = int(self.headers.get("Content-Length") or "")
        except ValueError:
            raise HttpError(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required") from None
        if length < 0:
            raise HttpError(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            if length <= _DRAIN_LIMIT:
                self.rfile.read(length)
            else:
                self.close_connection = True
            raise HttpError(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                f"request body over {MAX_BODY_BYTES // 1024} KiB",
            )
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HttpError(HTTPStatus.BAD_REQUEST, "the body is not valid JSON") from None
        if not isinstance(data, dict):
            raise HttpError(HTTPStatus.BAD_REQUEST, "the JSON body must be an object")
        return data

    def _send_json(
        self, status: int, payload: dict[str, Any], extra: Iterable[tuple[str, str]] = ()
    ) -> None:
        self._send_bytes(status, json.dumps(payload).encode("utf-8"), "application/json", extra)

    def _send_error(self, error: HttpError) -> None:
        payload: dict[str, Any] = {"error": redact_secrets(error.message), "kind": error.kind}
        if error.hint:
            payload["hint"] = error.hint
        extra: list[tuple[str, str]] = list(error.headers)
        if error.status == HTTPStatus.UNAUTHORIZED and error.kind == "auth":
            extra.append(("WWW-Authenticate", 'Bearer realm="DramaFetch"'))
        self._send_json(error.status, payload, extra)

    def _send_html(self, html: str) -> None:
        self._send_bytes(HTTPStatus.OK, html.encode("utf-8"), "text/html; charset=utf-8")

    def _send_bytes(
        self, status: int, body: bytes, content_type: str, extra: Iterable[tuple[str, str]] = ()
    ) -> None:
        headers = [("Content-Type", content_type), ("Content-Length", str(len(body))), *extra]
        self._send_headers(status, headers)
        self.wfile.write(body)

    def _send_headers(self, status: int, headers: Iterable[tuple[str, str]] = ()) -> None:
        """The status line, ``headers`` and the fixed security headers; no body (a 204 has none)."""
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", _CSP)
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        # Request lines only (method, path, status): never headers, never bodies, so never a token.
        log.info("%s %s", self.address_string(), format % args)


def normalize_host(host: str) -> str:
    """The host as the socket layer wants it: trimmed, IPv6 brackets removed (``[::1]`` -> ``::1``);
    an empty host raises ``ValueError`` (the server never guesses an interface)."""
    cleaned = (host or "").strip()
    if cleaned.startswith("[") and cleaned.endswith("]"):
        cleaned = cleaned[1:-1].strip()
    if not cleaned:
        raise ValueError("pass an explicit host; 127.0.0.1 keeps the UI private to this machine")
    return cleaned


def run_server(
    host: str,
    port: int,
    out_dir: Path,
    discovery_options: DiscoveryOptions,
    download_options: DownloadOptions,
    *,
    discovery: Discovery | None = None,
    downloader: Downloader | None = None,
    serve_forever: bool = True,
    token: str | None = None,
) -> ThreadingHTTPServer:
    """Bind the web UI to ``host:port`` and, by default, serve until Ctrl+C.

    ``out_dir`` is the only place downloads can go (``download_options.out_dir`` is replaced by it).
    ``discovery``/``downloader`` override the engine's defaults — tests inject fakes. ``token`` is
    the access token every ``/api/*`` request must then carry (see the module docstring); it is
    required for any ``host`` but loopback and is never logged. With ``serve_forever=False`` the
    bound server is returned without serving, so the caller can run ``server.serve_forever()`` in a
    thread and ``server.shutdown()`` later (``port=0`` picks a free port; read it from
    ``server.server_address``). ``ValueError`` for an empty host, an off-loopback host without a
    token, or a token that is too short or not cookie-safe — all before anything is bound.
    """
    host = normalize_host(host)
    server = DramaFetchServer(
        (host, port),
        out_dir=out_dir,
        discovery_options=discovery_options,
        download_options=download_options,
        discovery=discovery,
        downloader=downloader,
        token=token,
    )
    log.info(
        "DramaFetch web UI on http://%s:%d/ (downloads go to %s; token: %s)",
        host,
        server.server_address[1],
        server.out_dir,
        "set" if server.token is not None else "none",
    )
    if serve_forever:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
    return server
