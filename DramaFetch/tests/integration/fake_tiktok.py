"""A tiny stand-in for TikTok's web app, enough to drive the browser strategy end to end offline.

It serves three series: the main one (`SERIES_ID`, "The Billionaire's Secret Heiress", five
episodes on two `item_list` pages, episode 5 locked — `FakeOptions.series_id` can move it to
another id), a second one (`SECOND_SERIES_ID`, "Second Chance Bride": three free episodes on
one page, `fixtures/item_list_series2.json`) and a paid third one (`THIRD_SERIES_ID`, "Paid Love
Story": four episodes on one page whose answer depends on the session — with a `sessionid`
cookie `fixtures/item_list_series3_logged_in.json`, where episode 3 is sold but unlocked by this
account and carries play URLs, without one `item_list_series3_logged_out.json`, where it is
locked and carries none; episode 4 is locked either way), each with its own covers and play URLs
through the same fake CDN; the series page, `item_list` and `detail` answer per `dramaID`.

Routes (all GET):
  /shortdrama/episode/<id>/<n>   the series page: inline JS fetches `/api/drama/detail/` and then
                                 `/api/drama/episode/item_list/?dramaID=<id>&cursor=0&count=10&...`
                                 and renders the titles into `[data-testid="short-drama-detail"]`;
                                 302 to /login when `require_login` and no `sessionid` cookie;
                                 a "Verify to continue" page when `challenge`
  /api/drama/episode/item_list/  JSON built from the fixtures: for the main series cursor 0 -> page
                                 1, 3 -> page 2; for the second series cursor 0 -> its only page;
                                 for the third, its logged-in or logged-out page (the `sessionid`
                                 cookie decides; its value is never stored);
                                 empty for unknown `dramaID`, or when `require_login` and no cookie;
                                 with `lazy`, later pages are served only to the page's own scroll
                                 handler (header `X-Requested-By: scroll`); `lazy_empty` answers
                                 DramaFetch's own pagination fetch with a well-formed EMPTY page
                                 instead; `slow_pagination_s` delays that fetch (until shutdown at
                                 the latest); `rate_limit_pagination` answers it with HTTP 429
  /api/drama/detail/             the series name and total (per `dramaID`; the main series' for
                                 any id it does not know)
  /login                         a login page
  /cdn/<item_id>/<n>.mp4         the fake video CDN. Every `https://v16-webapp-prime.tiktok.com/...`
                                 play URL inside an item_list payload is rewritten to
                                 `{base}/cdn/{item_id}/{n}.mp4?expire=<now + media_ttl_s>` (`n`:
                                 order of first appearance within the item). Answers 200
                                 `video/mp4` with the real 3-second fixture `tiny.mp4` followed
                                 by one top-level `free` box that names the episode and pads the
                                 file to exactly 128 KiB — a valid MP4 (mutagen tags it, ffmpeg
                                 decodes it, so covers can be embedded), distinct per episode —
                                 403 when `expire` is in the past (or, with
                                 `require_login`, without the session cookie) and 429 when the
                                 server was started with `cdn_rate_limit`. `expired_media_first`
                                 makes the FIRST item_list response carry already-expired URLs and
                                 the later ones fresh URLs, to exercise the download engine's
                                 refresh; `expired_media_first_visit` expires every list served
                                 before the series page is loaded a second time (a discovery
                                 that repeats the page's first request, like the Chrome
                                 extension's, still sees expired URLs until it lists the series
                                 again). The media lasts 3 s, so the item_list payloads served
                                 say `video.duration = 3` (`MEDIA_DURATION_S`) for every item —
                                 unless `short_media`, which keeps the fixtures' own durations
                                 (92 s, 88 s, …) while the CDN still serves the 3-second file: a
                                 valid MP4 far shorter than announced, what a locked episode's
                                 preview looks like; the engines' verification must fail it.
                                 `truncate_media` announces the full `Content-Length` but sends
                                 only 60 % of the body (`TRUNCATE_RATIO`) and drops the
                                 connection: a transfer cut short by the network. `gzip_media`
                                 serves the body `Content-Encoding: gzip` with the COMPRESSED
                                 size as `Content-Length`: the client's decoded body is longer
                                 than announced, which is no truncation. `drm_media` — a set of
                                 (series id, episode number) — serves those episodes ENCRYPTED:
                                 tiny.mp4 with `encv`/`enca` sample entries and a top-level
                                 `pssh` (`tests/encrypted_mp4.py`, a structural edit), padded
                                 the same way; the engines must refuse it and keep nothing.
  /cover/<item_id>.jpg           the fake image CDN. Every `https://p16-sign-sg.tiktokcdn.com/...`
                                 cover URL inside an item_list payload (`video.cover`,
                                 `originCover`, `dynamicCover`) is rewritten to
                                 `{base}/cover/{item_id}.jpg`. Answers 200 `image/jpeg` with a
                                 real 16x16 JPEG (every decoder accepts it) carrying a COM
                                 segment that names the item and pads it past 600 bytes, 429
                                 with `cdn_rate_limit` like `/cdn/`;
                                 no login is needed (TikTok's covers are public).
                                 `redirect_media` / `redirect_covers` answer `/cdn/` / `/cover/`
                                 with a 302 to `http://localhost:<port>/elsewhere<path>` — a host
                                 the extension's test copy does not cover — which serves what the
                                 CDN would have (`elsewhere_requests`: whoever followed it).
                                 `media_hops` / `cover_hops` = n answer `/cdn/…` / `/cover/…` with a
                                 302 chain on the SAME origin first: `/hop/1/cdn/…` (path and
                                 query kept), …, `/hop/<n>/cdn/…`, which serves what `/cdn/…` would
                                 have (`hop_requests`); with `hops_then_elsewhere` the last hop
                                 redirects to `localhost` (`elsewhere_url`) instead.
                                 No answer of the fake carries a CORS header (`Access-Control-*`):
                                 the Chrome extension reaches it through its host permissions, as
                                 it reaches TikTok's CDN, never through CORS.
  /cookie-control/set            (`cookie_control`) sets `dramafetch_control=1; SameSite=None;
                                 Secure` for the host it is asked on; `/cookie-control/cross-site`
                                 is a page whose image is `http://localhost:<port>/cookie-control/
                                 pixel`, so loaded from 127.0.0.1 it is a THIRD-PARTY request: it
                                 carries that cookie (`control_cookie`) only while the profile
                                 allows third-party cookies.
  POST /origin-probe             (`origin_probe`) 204, recorded like any request: what `Origin` a
                                 request of the Chrome extension's page carries.
The request log keeps method, path and query, five booleans, the `Origin` and `Referer` values and
the NAMES of the headers sent; never another header's value, never a cookie value.
"""

from __future__ import annotations

import gzip
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

from encrypted_mp4 import encrypted_mp4

SERIES_ID = "7699393770256782354"
SERIES_NAME = "The Billionaire's Secret Heiress"
TOTAL_EPISODES = 5
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
PAGES = {
    "0": json.loads((FIXTURES / "item_list_page1.json").read_text(encoding="utf-8")),
    "3": json.loads((FIXTURES / "item_list_page2.json").read_text(encoding="utf-8")),
}
#: The second series: three free episodes on one page, TikTok announces 3.
SECOND_SERIES_ID = "7699393770256782399"
SECOND_SERIES_NAME = "Second Chance Bride"
SECOND_TOTAL_EPISODES = 3
SECOND_PAGES = {
    "0": json.loads((FIXTURES / "item_list_series2.json").read_text(encoding="utf-8")),
}
#: The item ids of the second series' episodes 1-3 (what its CDN and cover paths carry).
SECOND_ITEMS = tuple(str(item["id"]) for item in SECOND_PAGES["0"]["itemList"])
#: The third series, a paid one whose answers depend on the session: episodes 1-2 free; episode 3
#: sold (`isFree: false`, `unlockPrice: 30`) and bought by the account the cookies belong to —
#: WITH a `sessionid` cookie its item says `isUnlocked: true` and carries play URLs, WITHOUT one
#: `isLocked: true` and none; episode 4 sold and locked for everyone (`isLocked: true` in
#: `dramaInfo` and at the top level of the item, no play URLs). TikTok announces 4. One page
#: each way: `fixtures/item_list_series3_logged_in.json` / `item_list_series3_logged_out.json`.
THIRD_SERIES_ID = "7699393770256782388"
THIRD_SERIES_NAME = "Paid Love Story"
THIRD_TOTAL_EPISODES = 4
THIRD_PAGES_LOGGED_IN = {
    "0": json.loads((FIXTURES / "item_list_series3_logged_in.json").read_text(encoding="utf-8")),
}
THIRD_PAGES_LOGGED_OUT = {
    "0": json.loads((FIXTURES / "item_list_series3_logged_out.json").read_text(encoding="utf-8")),
}
#: The item ids of the third series' episodes 1-4.
THIRD_ITEMS = tuple(str(item["id"]) for item in THIRD_PAGES_LOGGED_IN["0"]["itemList"])
SERIES_PATH_RE = re.compile(r"^/shortdrama/episode/(?P<id>\d+)/(?P<n>\d+)/?$")
CDN_PATH_RE = re.compile(r"^/cdn/(?P<id>\d+)/(?P<n>\d+)\.mp4$")
COVER_PATH_RE = re.compile(r"^/cover/(?P<id>\d+)\.jpg$")
#: A hop of `media_hops` / `cover_hops`: `/hop/<k>` + the CDN path it stands for.
HOP_PATH_RE = re.compile(r"^/hop/(?P<k>[1-9][0-9]*)(?P<path>/.*)$")
#: The path prefix a `redirect_media` / `redirect_covers` redirect points below (on `localhost`).
ELSEWHERE_PREFIX = "/elsewhere"
#: The third-party control of `cookie_control` (its cookie's name; never a session cookie).
CONTROL_COOKIE = "dramafetch_control"
CONTROL_PREFIX = "/cookie-control/"
#: A 1x1 transparent GIF: the control page's image.
PIXEL_GIF = bytes.fromhex(
    "47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b"
)
MEDIA_URL_PREFIX = "https://v16-webapp-prime.tiktok.com/"
COVER_URL_PREFIX = "https://p16-sign-sg.tiktokcdn.com/"
#: 20 531 bytes: 3 s of 160x120 H.264 with silent AAC, `moov` before `mdat` (faststart).
TINY_MP4 = (FIXTURES / "tiny.mp4").read_bytes()
#: What `drm_media` serves instead (before the same padding): `tiny.mp4` with its sample entries
#: renamed `encv`/`enca` and a top-level `pssh` — what an encrypted file declares.
ENCRYPTED_TINY_MP4 = encrypted_mp4(TINY_MP4)
MEDIA_SIZE = 128 * 1024
#: What `tiny.mp4` lasts; the lists served announce it (unless `short_media`), so the engines'
#: duration check passes for the fake CDN's episodes.
MEDIA_DURATION_S = 3
#: How much of the body `truncate_media` sends before dropping the connection.
TRUNCATE_RATIO = 0.6
FREE_BOX = b"free"
MEDIA_LABEL_PREFIX = b"dramafetch:"
JPEG_SOI = b"\xff\xd8"
JPEG_EOI = b"\xff\xd9"
COVER_MIN_SIZE = 600  # the COM segment pads every cover past this
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
    # Every item_list served before the series page is loaded a SECOND time carries expired URLs
    # (the first discovery's lists, however many requests it makes); a fresh visit's are fresh.
    expired_media_first_visit: bool = False
    cdn_rate_limit: bool = False  # every /cdn/ request answers HTTP 429
    # Integrity failures (both make the engines fail the episode without a retry):
    truncate_media: bool = False  # Content-Length says all, the body stops at 60 %, then EOF
    short_media: bool = False  # lists keep the fixtures' 92 s durations; the CDN serves 3 s
    # Not a failure: a gzip-encoded body whose Content-Length is the compressed size.
    gzip_media: bool = False
    # Episodes, as (series id, episode number), whose media the CDN serves ENCRYPTED: the
    # `encv`/`enca` + `pssh` variant of tiny.mp4 (`drm_media_bytes`), same size, same headers.
    drm_media: frozenset[tuple[str, int]] = frozenset()
    # A 302 to a host the Chrome extension's test copy does not cover — `localhost` (only
    # `http://127.0.0.1/*` is granted there), `/elsewhere` + the same path and query — instead of
    # the video (`redirect_media`) or the cover (`redirect_covers`); `/elsewhere/…` serves what
    # the CDN would have, so a client that followed the redirect shows up in `elsewhere_requests`.
    redirect_media: bool = False
    redirect_covers: bool = False
    # A 302 chain on this origin before `/cdn/…` / `/cover/…` answers: `/hop/1/…` … `/hop/<n>/…`
    # (the last one serves the CDN's answer, or — `hops_then_elsewhere` — redirects to `localhost`).
    media_hops: int = 0
    cover_hops: int = 0
    hops_then_elsewhere: bool = False
    # `POST /origin-probe` answers 204 (what Origin a request of the extension's page carries).
    origin_probe: bool = False
    # The `/cookie-control/…` routes: does the profile send a third-party cookie at all?
    cookie_control: bool = False

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
    origin: str | None = None  # the `Origin` header's value, None without one
    referer: str | None = None  # the `Referer` header's value, None without one
    header_names: tuple[str, ...] = ()  # the names of the headers sent, lower-cased and sorted
    control_cookie: bool = False  # the `cookie_control` cookie was present (never a session one)
    method: str = "GET"


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

    def elsewhere_url(self, path_and_query: str) -> str:
        """Where `redirect_media` / `redirect_covers` send a client: this server under another
        host name (`localhost`), below `ELSEWHERE_PREFIX`."""
        return f"http://localhost:{self.server_address[1]}{ELSEWHERE_PREFIX}{path_and_query}"

    @property
    def control_pixel_url(self) -> str:
        """The `cookie_control` image under the OTHER site's name (`localhost`): a third-party
        request from a page of 127.0.0.1."""
        return f"http://localhost:{self.server_address[1]}{CONTROL_PREFIX}pixel"

    def record(self, record: RequestRecord) -> None:
        with self.lock:
            self.requests.append(record)

    def handle_error(self, request: Any, client_address: Any) -> None:
        """A client that gave up (the browser aborted a deliberately slow answer) is not an error
        worth a traceback in the test output."""


class _Handler(BaseHTTPRequestHandler):
    def _record(self, server: FakeTikTokServer) -> tuple[str, dict[str, str], bool]:
        """Log this request (no header value but Origin's and Referer's, no cookie value); its
        path, its query and whether it carried the session cookie."""
        parts = urlsplit(self.path)
        query = {
            key: values[-1] for key, values in parse_qs(parts.query, keep_blank_values=True).items()
        }
        cookies = self._cookie_names()
        logged_in = "sessionid" in cookies
        referer = self.headers.get("Referer")
        server.record(
            RequestRecord(
                parts.path,
                query,
                logged_in,
                from_scroll=self.headers.get("X-Requested-By") == "scroll",
                with_referer=referer == server.base_url + "/",
                origin=self.headers.get("Origin"),
                referer=referer,
                header_names=tuple(sorted({name.lower() for name in self.headers})),
                control_cookie=CONTROL_COOKIE in cookies,
                method=self.command,
            )
        )
        return parts.path, query, logged_in

    def do_POST(self) -> None:
        server = self.server
        assert isinstance(server, FakeTikTokServer)
        length = self.headers.get("Content-Length", "0")
        self.rfile.read(int(length) if length.isdigit() else 0)
        path, _, _ = self._record(server)
        if server.options.origin_probe and path == "/origin-probe":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")

    def do_GET(self) -> None:
        server = self.server
        assert isinstance(server, FakeTikTokServer)
        options = server.options
        path, query, logged_in = self._record(server)
        from_scroll = self.headers.get("X-Requested-By") == "scroll"

        if (match := SERIES_PATH_RE.match(path)) is not None:
            if options.require_login and not logged_in:
                self._redirect("/login?redirect_url=" + path)
            elif options.challenge:
                self._send(HTTPStatus.OK, CHALLENGE_PAGE.encode(), "text/html; charset=utf-8")
            else:
                page = PAGE_TEMPLATE.replace("__SERIES_ID__", match.group("id"))
                page = page.replace("__LAZY__", "true" if options.page_scrolls else "false")
                self._send(HTTPStatus.OK, page.encode(), "text/html; charset=utf-8")
        elif path == "/api/drama/episode/item_list/":
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
        elif path.startswith(ELSEWHERE_PREFIX):
            self._elsewhere(path[len(ELSEWHERE_PREFIX) :])
        elif (match := HOP_PATH_RE.match(path)) is not None:
            hop = int(match.group("k"))
            self._hop(server, hop, self.path[len(f"/hop/{hop}") :], query, logged_in)
        elif (match := CDN_PATH_RE.match(path)) is not None:
            if options.redirect_media:
                self._redirect(server.elsewhere_url(self.path))
            elif options.media_hops > 0:
                self._redirect(f"/hop/1{self.path}")
            else:
                self._media(options, query, logged_in, match.group("id"), match.group("n"))
        elif (match := COVER_PATH_RE.match(path)) is not None:
            if options.redirect_covers:
                self._redirect(server.elsewhere_url(self.path))
            elif options.cover_hops > 0:
                self._redirect(f"/hop/1{self.path}")
            else:
                self._cover(options, match.group("id"))
        elif options.cookie_control and path.startswith(CONTROL_PREFIX):
            self._control(server, path[len(CONTROL_PREFIX) :])
        elif path == "/api/drama/detail/":
            if query.get("dramaID") == SECOND_SERIES_ID:
                name, total = SECOND_SERIES_NAME, SECOND_TOTAL_EPISODES
            elif query.get("dramaID") == THIRD_SERIES_ID:
                name, total = THIRD_SERIES_NAME, THIRD_TOTAL_EPISODES
            else:
                name, total = SERIES_NAME, TOTAL_EPISODES
            self._json({"dramaInfo": {"dramaName": name, "totalEpisode": total}})
        elif path.startswith("/login"):
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
        drama_id = query.get("dramaID")
        if drama_id == SECOND_SERIES_ID:
            pages = SECOND_PAGES
        elif drama_id == THIRD_SERIES_ID:  # what THIS session may play: the cookie decides
            pages = THIRD_PAGES_LOGGED_IN if logged_in else THIRD_PAGES_LOGGED_OUT
        elif drama_id == options.series_id:
            pages = PAGES
        else:
            return {"itemList": [], "hasMore": False, "cursor": 0, "statusCode": 0}
        if options.lazy_empty and cursor != "0" and not from_scroll:
            return {"itemList": [], "hasMore": False, "cursor": cursor, "statusCode": 0}
        if options.lazy and cursor != "0" and not from_scroll:
            return {"statusCode": 10201, "statusMsg": "pagination is only served to the page"}
        page = pages.get(cursor)
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
            visits = sum(1 for record in server.requests if SERIES_PATH_RE.match(record.path))
            if (options.expired_media_first and first) or (
                options.expired_media_first_visit and visits <= 1
            ):
                expire = now - EXPIRED_MEDIA_OFFSET_S
            else:
                expire = now + options.media_ttl_s
            duration = None if options.short_media else MEDIA_DURATION_S
            rewritten, count = rewrite_media_urls(payload, server.base_url, expire, duration)
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
        elif EPISODE_OF_ITEM.get(item_id) in options.drm_media:
            self._send(HTTPStatus.OK, drm_media_bytes(item_id, index), "video/mp4")
        elif options.truncate_media:
            self._send_truncated(media_bytes(item_id, index), "video/mp4")
        elif options.gzip_media:
            self._send_gzipped(media_bytes(item_id, index), "video/mp4")
        else:
            self._send(HTTPStatus.OK, media_bytes(item_id, index), "video/mp4")

    def _cover(self, options: FakeOptions, item_id: str) -> None:
        if options.cdn_rate_limit:
            self._send(
                HTTPStatus.TOO_MANY_REQUESTS,
                b'{"statusCode": 429, "statusMsg": "too many requests"}',
                "application/json",
            )
        else:
            self._send(HTTPStatus.OK, cover_bytes(item_id), "image/jpeg")

    def _elsewhere(self, path: str) -> None:
        """What a redirect of `redirect_media` / `redirect_covers` points at: the CDN's answer."""
        if (match := CDN_PATH_RE.match(path)) is not None:
            self._send(HTTPStatus.OK, media_bytes(match.group("id"), match.group("n")), "video/mp4")
        elif (match := COVER_PATH_RE.match(path)) is not None:
            self._send(HTTPStatus.OK, cover_bytes(match.group("id")), "image/jpeg")
        else:
            self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")

    def _hop(
        self, server: FakeTikTokServer, hop: int, rest: str, query: dict[str, str], logged_in: bool
    ) -> None:
        """Hop `hop` of `media_hops` / `cover_hops`; `rest` is the CDN path (and query) it stands
        for: the next hop, else the CDN's answer — or, `hops_then_elsewhere`, `localhost`."""
        options = server.options
        original = urlsplit(rest).path
        media = CDN_PATH_RE.match(original)
        cover = COVER_PATH_RE.match(original)
        hops = options.media_hops if media else options.cover_hops if cover else 0
        if hop > hops:
            self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")
        elif hop < hops:
            self._redirect(f"/hop/{hop + 1}{rest}")
        elif options.hops_then_elsewhere:
            self._redirect(server.elsewhere_url(rest))
        elif media is not None:
            self._media(options, query, logged_in, media.group("id"), media.group("n"))
        elif cover is not None:
            self._cover(options, cover.group("id"))

    def _control(self, server: FakeTikTokServer, name: str) -> None:
        """The `cookie_control` routes (see the module docstring)."""
        if name == "set":
            self.send_response(HTTPStatus.OK)
            self.send_header("Set-Cookie", f"{CONTROL_COOKIE}=1; SameSite=None; Secure; Path=/")
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "3")
            self.end_headers()
            self.wfile.write(b"set")
        elif name == "cross-site":
            image = f'<img src="{server.control_pixel_url}" alt="">'
            page = f"<!DOCTYPE html><html><body>{image}</body></html>"
            self._send(HTTPStatus.OK, page.encode(), "text/html; charset=utf-8")
        elif name == "pixel":
            self._send(HTTPStatus.OK, PIXEL_GIF, "image/gif")
        else:
            self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")

    def _cookie_names(self) -> set[str]:
        """The names of the cookies sent (never a value)."""
        jar: SimpleCookie = SimpleCookie()
        jar.load(self.headers.get("Cookie", ""))
        return set(jar)

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

    def _send_truncated(self, body: bytes, content_type: str) -> None:
        """Announce the whole body, send `TRUNCATE_RATIO` of it and drop the connection: what a
        transfer cut short by the network looks like to the client (Playwright reports it as
        `aborted`; a client that returned the partial body would see fewer bytes than announced)."""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body[: int(len(body) * TRUNCATE_RATIO)])
        self.wfile.flush()
        self.close_connection = True

    def _send_gzipped(self, body: bytes, content_type: str) -> None:
        """The body `Content-Encoding: gzip`, with the compressed size as `Content-Length` — as
        the HTTP spec has it. A browser's request API hands the client the decoded bytes while
        the headers stay as sent, so the body is LONGER than announced: not a truncation."""
        encoded = gzip.compress(body, compresslevel=6)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: Any) -> None:
        """Silence the default access log (it would echo request lines into the test output)."""


def rewrite_media_urls(
    node: Any, base: str, expire: int, duration: int | None = None
) -> tuple[Any, int]:
    """A copy of an item_list payload with every `https://v16-webapp-prime.tiktok.com/...` string
    replaced by `{base}/cdn/{item_id}/{index}.mp4?expire={expire}` and every
    `https://p16-sign-sg.tiktokcdn.com/...` string (the covers) by `{base}/cover/{item_id}.jpg`,
    plus the number of distinct MEDIA URLs rewritten (covers are not counted: the count tells
    whether the list carried play URLs). An item is a dict holding `video` or `dramaInfo`; `index`
    is the order of first appearance within the item, so a URL an item lists twice stays one
    URL. With `duration`, every item's `video.duration` becomes that many seconds (what the fake
    CDN's media really lasts); None leaves the fixtures' durations alone."""
    rewritten = 0

    def walk(value: Any, item_id: str, indexes: dict[str, int]) -> Any:
        nonlocal rewritten
        if isinstance(value, dict):
            if "video" in value or "dramaInfo" in value:
                item_id, indexes = str(value.get("id") or item_id), {}
            mapped = {key: walk(inner, item_id, indexes) for key, inner in value.items()}
            video = mapped.get("video")
            if duration is not None and isinstance(video, dict) and "duration" in video:
                video["duration"] = duration
            return mapped
        if isinstance(value, list):
            return [walk(inner, item_id, indexes) for inner in value]
        if isinstance(value, str) and value.startswith(MEDIA_URL_PREFIX):
            if value not in indexes:
                indexes[value] = len(indexes)
                rewritten += 1
            return f"{base}/cdn/{item_id}/{indexes[value]}.mp4?expire={expire}"
        if isinstance(value, str) and value.startswith(COVER_URL_PREFIX):
            return f"{base}/cover/{item_id}.jpg"
        return value

    return walk(node, "0", {}), rewritten


def media_bytes(item_id: str, index: str, *, base: bytes = TINY_MP4) -> bytes:
    """The real fixture `tests/fixtures/tiny.mp4` (or `base`) followed by one top-level `free` box
    (a 4-byte big-endian size, `free`, the payload) whose payload starts with
    `dramafetch:<item_id>:<index>` and pads the file to exactly `MEDIA_SIZE`: a valid MP4 that
    mutagen and ffmpeg accept, at least `MIN_VIDEO_BYTES` long, distinct per episode and the same
    on every call."""
    label = MEDIA_LABEL_PREFIX + f"{item_id}:{index}".encode()
    box_size = MEDIA_SIZE - len(base)
    filler = random.Random(f"{item_id}/{index}").randbytes(box_size - 8 - len(label))
    return base + box_size.to_bytes(4, "big") + FREE_BOX + label + filler


def drm_media_bytes(item_id: str, index: str) -> bytes:
    """What `drm_media` serves for an episode: `ENCRYPTED_TINY_MP4` padded like `media_bytes` —
    `MEDIA_SIZE` bytes, a well-formed MP4 whose tracks are declared encrypted (ffmpeg finds no
    decoder for them; DramaFetch must never keep it)."""
    return media_bytes(item_id, index, base=ENCRYPTED_TINY_MP4)


def _episodes_of_items() -> dict[str, tuple[str, int]]:
    """item id -> (series id, episode number), from every fixture page the fake serves (an item
    without an episode number, a trailer, is left out)."""
    found: dict[str, tuple[str, int]] = {}
    for pages in (PAGES, SECOND_PAGES, THIRD_PAGES_LOGGED_IN):
        for page in pages.values():
            for item in page.get("itemList") or page.get("data", {}).get("itemList", []):
                drama = item.get("dramaInfo") or {}
                number = (drama.get("DramaVideoData") or {}).get("EpisodeNumber")
                if isinstance(number, int) and drama.get("dramaID"):
                    found[str(item["id"])] = (str(drama["dramaID"]), number)
    return found


#: Which episode an item id of the fixtures is: how `drm_media` (series id, number) pairs reach
#: the CDN, whose paths carry item ids only.
EPISODE_OF_ITEM = _episodes_of_items()


#: A real 16x16 baseline JPEG, 222 bytes, made once with ffmpeg (`-f lavfi -i color=c=0x404040:
#: s=16x16 -frames:v 1 -pix_fmt yuvj420p -q:v 31`): SOI, JFIF APP0, ffmpeg's own COM, then the
#: quantisation and Huffman tables, the frame header and the scan up to EOI — the smallest cover
#: every decoder accepts (a shell of bare markers has the magic bytes but no picture in it).
_REAL_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010200000100010000fffe00104c61766336302e33312e31303200ffdb0043"
    "00083e3e493e49555555555555645d6468686864646464686868707070838383707070686870707c7c83"
    "838f938f8787838793939b9b9bbabab2b2d9d9e0ffffffffc4004b000101000000000000000000000000"
    "000000070101000000000000000000000000000000001001000000000000000000000000000000001101"
    "00000000000000000000000000000000ffc00011080010001003012200021100031100ffda000c030100"
    "02110311003f009f800fffd9"
)
_APP0_END = 4 + int.from_bytes(_REAL_JPEG[4:6], "big")  # SOI + the whole APP0 segment


def cover_bytes(item_id: str) -> bytes:
    """A small JPEG every decoder accepts (a real 16x16 picture), the same on every call for an
    item: the SOI and JFIF APP0 of `_REAL_JPEG`, one COM segment naming the item and padding the
    file past `COVER_MIN_SIZE`, then its tables, frame header and scan up to EOI (`FF D8 FF` at
    the start, `FF D9` at the end); no image library is needed to produce or recognise it."""
    comment = f"DramaFetch fake cover for item {item_id}".encode().ljust(COVER_MIN_SIZE, b".")
    com = b"\xff\xfe" + (len(comment) + 2).to_bytes(2, "big") + comment
    return _REAL_JPEG[:_APP0_END] + com + _REAL_JPEG[_APP0_END:]


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

    @property
    def cover_requests(self) -> list[RequestRecord]:
        return [r for r in self.requests if COVER_PATH_RE.match(r.path)]

    @property
    def elsewhere_requests(self) -> list[RequestRecord]:
        """Requests that followed a `redirect_media` / `redirect_covers` redirect."""
        return [r for r in self.requests if r.path.startswith(ELSEWHERE_PREFIX)]

    @property
    def hop_requests(self) -> list[RequestRecord]:
        """Requests of the `/hop/<k>/…` chain of `media_hops` / `cover_hops`."""
        return [r for r in self.requests if HOP_PATH_RE.match(r.path)]

    @property
    def control_requests(self) -> list[RequestRecord]:
        """Requests of the `cookie_control` image (`control_cookie`: the third-party cookie)."""
        return [r for r in self.requests if r.path == f"{CONTROL_PREFIX}pixel"]

    @property
    def probe_requests(self) -> list[RequestRecord]:
        """`POST /origin-probe` requests (`origin_probe`)."""
        return [r for r in self.requests if r.path == "/origin-probe"]

    def series_requests(self, series_id: str) -> list[RequestRecord]:
        """Every request about one series: its page, its `item_list` / `detail` (by `dramaID`)
        and the media and covers of its items."""
        if series_id == SECOND_SERIES_ID:
            items = set(SECOND_ITEMS)
        elif series_id == THIRD_SERIES_ID:
            items = set(THIRD_ITEMS)
        else:
            items = _main_items(series_id)
        found = []
        for record in self.requests:
            page = SERIES_PATH_RE.match(record.path)
            media = CDN_PATH_RE.match(record.path) or COVER_PATH_RE.match(record.path)
            if (
                (page is not None and page.group("id") == series_id)
                or record.query.get("dramaID") == series_id
                or (media is not None and media.group("id") in items)
            ):
                found.append(record)
        return found


def _main_items(series_id: str) -> set[str]:
    """The item ids of the main series' pages that belong to it (not the other drama's item)."""
    if series_id != SERIES_ID:
        return set()
    items = set()
    for page in PAGES.values():
        listed = page.get("itemList") or page.get("data", {}).get("itemList", [])
        for item in listed:
            if item.get("dramaInfo", {}).get("dramaID") == SERIES_ID:
                items.add(str(item["id"]))
    return items
