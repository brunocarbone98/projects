"""A tiny stand-in for TikTok's web app, enough to drive the browser strategy end to end offline.

Routes (all GET):
  /shortdrama/episode/<id>/<n>   the series page: inline JS fetches `/api/drama/detail/` and then
                                 `/api/drama/episode/item_list/?dramaID=<id>&cursor=0&count=10&...`
                                 and renders the titles into `[data-testid="short-drama-detail"]`;
                                 302 to /login when `require_login` and no `sessionid` cookie;
                                 a "Verify to continue" page when `challenge`
  /api/drama/episode/item_list/  JSON built from the two fixtures (cursor 0 -> page 1, 3 -> page 2);
                                 empty for unknown `dramaID`, or when `require_login` and no cookie;
                                 with `lazy`, later pages are served only to the page's own scroll
                                 handler (header `X-Requested-By: scroll`); `lazy_empty` answers
                                 DramaFetch's own pagination fetch with a well-formed EMPTY page
                                 instead; `slow_pagination_s` delays that fetch (until shutdown at
                                 the latest); `rate_limit_pagination` answers it with HTTP 429
  /api/drama/detail/             the series name and total
  /login                         a login page
  /cdn/<item_id>/<n>.mp4         the fake video CDN. Every `https://v16-webapp-prime.tiktok.com/...`
                                 play URL inside an item_list payload is rewritten to
                                 `{base}/cdn/{item_id}/{n}.mp4?expire=<now + media_ttl_s>` (`n`:
                                 order of first appearance within the item). Answers 200
                                 `video/mp4` with 128 KiB of deterministic bytes behind a plausible
                                 MP4 header, 403 when `expire` is in the past (or, with
                                 `require_login`, without the session cookie) and 429 when the
                                 server was started with `cdn_rate_limit`. `expired_media_first`
                                 makes the FIRST item_list response carry already-expired URLs and
                                 the later ones fresh URLs, to exercise the download engine's
                                 refresh.
The request log keeps method, path and query plus three booleans; never headers or cookie values.
"""

from __future__ import annotations

import json
import random
import re
import threading
import time
from dataclasses import dataclass, field
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

SERIES_ID = "7699393770256782354"
SERIES_NAME = "The Billionaire's Secret Heiress"
TOTAL_EPISODES = 5
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
PAGES = {
    "0": json.loads((FIXTURES / "item_list_page1.json").read_text(encoding="utf-8")),
    "3": json.loads((FIXTURES / "item_list_page2.json").read_text(encoding="utf-8")),
}
SERIES_PATH_RE = re.compile(r"^/shortdrama/episode/(?P<id>\d+)/(?P<n>\d+)/?$")
CDN_PATH_RE = re.compile(r"^/cdn/(?P<id>\d+)/(?P<n>\d+)\.mp4$")
MEDIA_URL_PREFIX = "https://v16-webapp-prime.tiktok.com/"
MP4_HEADER = b"\x00\x00\x00\x18ftypmp42"
MEDIA_SIZE = 128 * 1024
EXPIRED_MEDIA_OFFSET_S = 10  # `expired_media_first` dates the first list's URLs this far back

PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Fake TikTok short drama</title>
<style>
  body { margin: 0; min-height: 3000px; font-family: sans-serif; }
  [data-testid="short-drama-detail"] { height: 240px; overflow-y: auto; border: 1px solid #999; }
  .ep { display: block; height: 120px; }
</style></head>
<body>
<h1>Series __SERIES_ID__</h1>
<div data-testid="short-drama-detail" id="detail">loading</div>
<script>
(async () => {
  const seriesId = "__SERIES_ID__";
  const lazy = __LAZY__;
  const detail = document.querySelector('[data-testid="short-drama-detail"]');
  const state = { cursor: 0, hasMore: true, busy: false };
  const listOf = (j) => j.itemList || (j.data && j.data.itemList) || [];
  const render = (items) => {
    for (const it of items) {
      const a = document.createElement('a');
      a.className = 'ep';
      a.href = '/@' + ((it.author && it.author.uniqueId) || '_') + '/video/' + it.id;
      a.textContent = it.desc || it.id;
      detail.appendChild(a);
    }
  };
  const load = async (headers) => {
    if (state.busy || !state.hasMore) return;
    state.busy = true;
    const u = '/api/drama/episode/item_list/?dramaID=' + seriesId + '&cursor=' + state.cursor
      + '&count=10&aid=1988&app_language=en&X-Bogus=fake';
    const r = await fetch(u, { credentials: 'include', headers });
    const j = await r.json();
    render(listOf(j));
    state.cursor = j.cursor;
    state.hasMore = !!j.hasMore;
    state.busy = false;
  };
  const detailUrl = '/api/drama/detail/?dramaID=' + seriesId + '&aid=1988';
  const d = await fetch(detailUrl, { credentials: 'include' });
  const dj = await d.json();
  document.title = (dj.dramaInfo && dj.dramaInfo.dramaName) || document.title;
  detail.textContent = '';
  await load({});
  if (lazy) {
    const more = () => { load({ 'X-Requested-By': 'scroll' }); };
    detail.addEventListener('scroll', more);
    window.addEventListener('scroll', more);
    window.addEventListener('wheel', more);
  }
})();
</script>
</body></html>
"""
CHALLENGE_PAGE = (
    "<!DOCTYPE html><html><head><title>Security check</title></head><body>"
    "<h1>Verify to continue</h1><p>Drag the puzzle piece into place.</p></body></html>"
)
LOGIN_PAGE = (
    "<!DOCTYPE html><html><head><title>Log in | Fake TikTok</title></head><body>"
    "<h1>Log in to TikTok</h1></body></html>"
)


@dataclass(frozen=True)
class FakeOptions:
    series_id: str = SERIES_ID
    require_login: bool = False
    challenge: bool = False
    lazy: bool = False  # later pages only via the page's own scroll handler (scroll fallback)
    # The three below shape the answer to DramaFetch's OWN pagination fetch (cursor != 0, not from
    # the page's scroll handler); with `lazy` or `lazy_empty` the page's scroll handler serves the
    # real later pages, as TikTok's own web app does.
    lazy_empty: bool = False  # a well-formed but empty page: {"itemList": [], "hasMore": false}
    slow_pagination_s: float = 0.0  # hold the answer this long (released early at shutdown)
    rate_limit_pagination: bool = False  # HTTP 429 with a JSON body
    # The fake CDN (browser download engine).
    media_ttl_s: int = 3600  # `expire` of the rewritten play URLs, seconds from now
    expired_media_first: bool = False  # the FIRST item_list served carries expire=now-10
    cdn_rate_limit: bool = False  # every /cdn/ request answers HTTP 429

    @property
    def page_scrolls(self) -> bool:
        return self.lazy or self.lazy_empty


@dataclass(frozen=True)
class RequestRecord:
    path: str
    query: dict[str, str] = field(default_factory=dict)
    logged_in: bool = False  # a `sessionid` cookie was present (its value is never stored)
    from_scroll: bool = False  # carried the page's `X-Requested-By: scroll` header
    with_referer: bool = False  # carried the download engine's `Referer: <base>/` header


class FakeTikTokServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, options: FakeOptions) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.options = options
        self.requests: list[RequestRecord] = []
        self.media_lists_served = 0  # item_list responses that carried (rewritten) play URLs
        self.lock = threading.Lock()
        self.release = threading.Event()  # set at shutdown: wakes handlers sleeping on purpose

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"

    def record(self, record: RequestRecord) -> None:
        with self.lock:
            self.requests.append(record)

    def handle_error(self, request: Any, client_address: Any) -> None:
        """A client that gave up (the browser aborted a deliberately slow answer) is not an error
        worth a traceback in the test output."""


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        server = self.server
        assert isinstance(server, FakeTikTokServer)
        options = server.options
        parts = urlsplit(self.path)
        query = {
            key: values[-1] for key, values in parse_qs(parts.query, keep_blank_values=True).items()
        }
        logged_in = self._has_session_cookie()
        from_scroll = self.headers.get("X-Requested-By") == "scroll"
        with_referer = self.headers.get("Referer") == server.base_url + "/"
        server.record(RequestRecord(parts.path, query, logged_in, from_scroll, with_referer))

        if (match := SERIES_PATH_RE.match(parts.path)) is not None:
            if options.require_login and not logged_in:
                self._redirect("/login?redirect_url=" + parts.path)
            elif options.challenge:
                self._send(HTTPStatus.OK, CHALLENGE_PAGE.encode(), "text/html; charset=utf-8")
            else:
                page = PAGE_TEMPLATE.replace("__SERIES_ID__", match.group("id"))
                page = page.replace("__LAZY__", "true" if options.page_scrolls else "false")
                self._send(HTTPStatus.OK, page.encode(), "text/html; charset=utf-8")
        elif parts.path == "/api/drama/episode/item_list/":
            ours = (query.get("cursor", "0") or "0") != "0" and not from_scroll
            if ours and options.slow_pagination_s > 0:
                server.release.wait(options.slow_pagination_s)
            if ours and options.rate_limit_pagination:
                self._send(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    b'{"statusCode": 429, "statusMsg": "too many requests"}',
                    "application/json",
                )
            else:
                payload = self._item_list(options, query, logged_in, from_scroll)
                self._json(self._with_media_urls(server, payload))
        elif (match := CDN_PATH_RE.match(parts.path)) is not None:
            self._media(options, query, logged_in, match.group("id"), match.group("n"))
        elif parts.path == "/api/drama/detail/":
            self._json({"dramaInfo": {"dramaName": SERIES_NAME, "totalEpisode": TOTAL_EPISODES}})
        elif parts.path.startswith("/login"):
            self._send(HTTPStatus.OK, LOGIN_PAGE.encode(), "text/html; charset=utf-8")
        else:
            self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")

    @staticmethod
    def _item_list(
        options: FakeOptions, query: dict[str, str], logged_in: bool, from_scroll: bool
    ) -> dict[str, Any]:
        cursor = query.get("cursor", "0") or "0"
        if options.require_login and not logged_in:
            return {"itemList": [], "hasMore": False, "statusCode": 0}
        if query.get("dramaID") != options.series_id:
            return {"itemList": [], "hasMore": False, "cursor": 0, "statusCode": 0}
        if options.lazy_empty and cursor != "0" and not from_scroll:
            return {"itemList": [], "hasMore": False, "cursor": cursor, "statusCode": 0}
        if options.lazy and cursor != "0" and not from_scroll:
            return {"statusCode": 10201, "statusMsg": "pagination is only served to the page"}
        page = PAGES.get(cursor)
        if page is None:
            return {"itemList": [], "hasMore": False, "cursor": cursor, "statusCode": 0}
        return page

    @staticmethod
    def _with_media_urls(server: FakeTikTokServer, payload: dict[str, Any]) -> dict[str, Any]:
        """The payload with its TikTok play URLs pointing at this server's CDN (see the module
        docstring); the FIRST list served gets expired URLs when `expired_media_first`."""
        options = server.options
        now = int(time.time())
        with server.lock:
            first = server.media_lists_served == 0
            if options.expired_media_first and first:
                expire = now - EXPIRED_MEDIA_OFFSET_S
            else:
                expire = now + options.media_ttl_s
            rewritten, count = rewrite_media_urls(payload, server.base_url, expire)
            if count:
                server.media_lists_served += 1
        assert isinstance(rewritten, dict)
        return rewritten

    def _media(
        self, options: FakeOptions, query: dict[str, str], logged_in: bool, item_id: str, index: str
    ) -> None:
        if options.cdn_rate_limit:
            self._send(
                HTTPStatus.TOO_MANY_REQUESTS,
                b'{"statusCode": 429, "statusMsg": "too many requests"}',
                "application/json",
            )
        elif options.require_login and not logged_in:
            self._send(
                HTTPStatus.FORBIDDEN, b"<html><body>Access Denied</body></html>", "text/html"
            )
        elif not query.get("expire", "").isdigit() or int(query["expire"]) < int(time.time()):
            self._send(HTTPStatus.FORBIDDEN, b"url expired", "text/plain")
        else:
            self._send(HTTPStatus.OK, media_bytes(item_id, index), "video/mp4")

    def _has_session_cookie(self) -> bool:
        jar: SimpleCookie = SimpleCookie()
        jar.load(self.headers.get("Cookie", ""))
        return "sessionid" in jar

    def _json(self, payload: dict[str, Any]) -> None:
        self._send(HTTPStatus.OK, json.dumps(payload).encode(), "application/json")

    def _redirect(self, location: str) -> None:
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        """Silence the default access log (it would echo request lines into the test output)."""


def rewrite_media_urls(node: Any, base: str, expire: int) -> tuple[Any, int]:
    """A copy of an item_list payload with every `https://v16-webapp-prime.tiktok.com/...` string
    replaced by `{base}/cdn/{item_id}/{index}.mp4?expire={expire}`, plus the number of distinct
    URLs rewritten. An item is a dict holding `video` or `dramaInfo`; `index` is the order of first
    appearance within the item, so a URL an item lists twice stays one URL."""
    rewritten = 0

    def walk(value: Any, item_id: str, indexes: dict[str, int]) -> Any:
        nonlocal rewritten
        if isinstance(value, dict):
            if "video" in value or "dramaInfo" in value:
                item_id, indexes = str(value.get("id") or item_id), {}
            return {key: walk(inner, item_id, indexes) for key, inner in value.items()}
        if isinstance(value, list):
            return [walk(inner, item_id, indexes) for inner in value]
        if isinstance(value, str) and value.startswith(MEDIA_URL_PREFIX):
            if value not in indexes:
                indexes[value] = len(indexes)
                rewritten += 1
            return f"{base}/cdn/{item_id}/{indexes[value]}.mp4?expire={expire}"
        return value

    return walk(node, "0", {}), rewritten


def media_bytes(item_id: str, index: str) -> bytes:
    """128 KiB that start like an MP4 file (`ftypmp42`) and are the same on every call."""
    filler = random.Random(f"{item_id}/{index}").randbytes(MEDIA_SIZE - len(MP4_HEADER))
    return MP4_HEADER + filler


class FakeTikTok:
    """`with FakeTikTok(require_login=True) as server: ... server.base_url ...`."""

    def __init__(self, **options: Any) -> None:
        self.options = FakeOptions(**options)
        self._server: FakeTikTokServer | None = None
        self._thread: threading.Thread | None = None

    def __enter__(self) -> FakeTikTok:
        self._server = FakeTikTokServer(self.options)
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        self._thread.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        assert self._server is not None and self._thread is not None
        self._server.release.set()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    @property
    def base_url(self) -> str:
        assert self._server is not None
        return self._server.base_url

    @property
    def requests(self) -> list[RequestRecord]:
        assert self._server is not None
        with self._server.lock:
            return list(self._server.requests)

    @property
    def item_list_requests(self) -> list[RequestRecord]:
        return [r for r in self.requests if r.path == "/api/drama/episode/item_list/"]

    @property
    def series_page_requests(self) -> list[RequestRecord]:
        return [r for r in self.requests if SERIES_PATH_RE.match(r.path)]

    @property
    def media_requests(self) -> list[RequestRecord]:
        return [r for r in self.requests if CDN_PATH_RE.match(r.path)]
