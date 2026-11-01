"""The local web UI: a stdlib ``http.server`` that serves one page and a small JSON API.

Routes::

    GET  /                 the page (static/index.html, read through importlib.resources)
    POST /api/resolve      {"url": ...}                      -> the series and its episodes
    POST /api/download     {"url", "episodes", "include_locked"} -> 202 {"job_id": ...}
    GET  /api/jobs/<id>    the job snapshot (see jobs.py)     -> 200, or 404 when unknown
    GET  /api/doctor       the `dramafetch doctor` facts as JSON

Rules: the server binds to the host it is given and nothing else (the CLI defaults to 127.0.0.1;
an explicit wildcard such as 0.0.0.0 is honoured with a warning because the UI has no
authentication, an empty host is refused). JSON bodies are capped at 64 KiB (413). POSTs must carry
``Content-Type: application/json``, so a browser on another site cannot fire one without a CORS
preflight we never answer, and the ``Host`` header must name the bound host or localhost (a guard
against DNS rebinding). The output directory is fixed server-side: the page cannot choose paths.
Errors are ``{"error": message, "kind": ExceptionName}`` with a 4xx/5xx status, cookie values never
appear in responses or logs. Resolving a series runs synchronously inside the request: the
discovery opens TikTok in a browser and usually takes 10-40 s, so the page shows a waiting note.
"""

from __future__ import annotations

import functools
import json
import logging
import socket
from dataclasses import replace
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from dramafetch import __version__
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
    Series,
    VideoRef,
)
from dramafetch.web.jobs import JobManager, Runner, redact_secrets

log = logging.getLogger(__name__)

MAX_BODY_BYTES = 64 * 1024
# An oversized body up to this size is read and discarded so the client sees the 413 instead of a
# reset connection; anything bigger is answered and the connection is closed.
_DRAIN_LIMIT = 1024 * 1024
_WILDCARD_HOSTS = frozenset({"0.0.0.0", "::", "[::]"})
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "[::1]"})
_JOBS_PREFIX = "/api/jobs/"
_CSP = (
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    "connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'"
)

LOGIN_HINT = (
    "Export cookies.txt (Netscape format) from the browser where you are logged in to TikTok and "
    "restart the server: dramafetch serve --cookies cookies.txt"
)
CHALLENGE_HINT = (
    "TikTok wants a human check: restart with --headful, solve it in the window that opens and "
    "try again"
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
    """An error with the HTTP status it should be reported with."""

    def __init__(
        self, status: int, message: str, *, kind: str | None = None, hint: str | None = None
    ) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.kind = kind or type(self).__name__
        self.hint = hint


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
    ) -> None:
        self.bound_host = address[0]
        if ":" in self.bound_host:
            self.address_family = socket.AF_INET6
        self.out_dir = out_dir.expanduser().absolute()
        self.discovery_options = discovery_options
        self.download_options = replace(download_options, out_dir=self.out_dir)
        self.discovery = discovery
        self.downloader = downloader
        self.jobs = jobs or JobManager()
        super().__init__(address, _Handler)

    def runner(self) -> Runner:
        """``engine.download_series`` bound to the injected downloader (tests) or yt-dlp."""
        from dramafetch.engine import download_series  # lazy: pulls in yt-dlp

        if self.downloader is None:
            return download_series
        return functools.partial(download_series, downloader=self.downloader)

    def host_allowed(self, host_header: str | None) -> bool:
        """Accept only requests addressed to the bound host or localhost (DNS-rebinding guard)."""
        if self.bound_host in _WILDCARD_HOSTS:
            return True  # the operator exposed the server on purpose; any name may reach it
        if not host_header:
            return False
        name = host_header.strip().lower()
        if name.startswith("["):
            name = name.split("]", 1)[0] + "]"
        elif name.count(":") == 1:
            name = name.rsplit(":", 1)[0]
        return name in _LOCAL_HOSTS or name.strip("[]") == self.bound_host.lower()

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
        else:
            raise HttpError(HTTPStatus.NOT_FOUND, f"no such page: {path[:80]}")

    def _post(self, path: str) -> None:
        if path == "/api/resolve":
            body = self._read_json_body()
            series = self._resolve(body)
            self._send_json(HTTPStatus.OK, series_to_dict(series, self.app.out_dir))
        elif path == "/api/download":
            body = self._read_json_body()
            self._send_json(HTTPStatus.ACCEPTED, self._start_download(body))
        else:
            raise HttpError(HTTPStatus.NOT_FOUND, f"no such endpoint: {path[:80]}")

    # ------------------------------------------------------------------ handlers

    def _resolve(self, body: dict[str, Any]) -> Series:
        from dramafetch import engine  # lazy: sibling module, pulls in Playwright on demand
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
        series = self._resolve(body)
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

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        self._send_bytes(status, json.dumps(payload).encode("utf-8"), "application/json")

    def _send_error(self, error: HttpError) -> None:
        payload: dict[str, Any] = {"error": redact_secrets(error.message), "kind": error.kind}
        if error.hint:
            payload["hint"] = error.hint
        self._send_json(error.status, payload)

    def _send_html(self, html: str) -> None:
        self._send_bytes(HTTPStatus.OK, html.encode("utf-8"), "text/html; charset=utf-8")

    def _send_bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", _CSP)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        # Request lines only (method, path, status): never headers, never bodies.
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
) -> ThreadingHTTPServer:
    """Bind the web UI to ``host:port`` and, by default, serve until Ctrl+C.

    ``out_dir`` is the only place downloads can go (``download_options.out_dir`` is replaced by it).
    ``discovery``/``downloader`` override the engine's defaults — tests inject fakes. With
    ``serve_forever=False`` the bound server is returned without serving, so the caller can run
    ``server.serve_forever()`` in a thread and ``server.shutdown()`` later (``port=0`` picks a free
    port; read it from ``server.server_address``).
    """
    host = normalize_host(host)
    if host in _WILDCARD_HOSTS:
        log.warning(
            "binding to %s exposes the UI (it has no authentication) to every network you are on",
            host,
        )
    server = DramaFetchServer(
        (host, port),
        out_dir=out_dir,
        discovery_options=discovery_options,
        download_options=download_options,
        discovery=discovery,
        downloader=downloader,
    )
    log.info(
        "DramaFetch web UI on http://%s:%d/ (downloads go to %s)",
        host,
        server.server_address[1],
        server.out_dir,
    )
    if serve_forever:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
    return server
