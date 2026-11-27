"""Static strategy with an injected fetch, the strategy chooser, and the shared helpers."""

from __future__ import annotations

import copy
import json
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from dramafetch import cooldown, engine
from dramafetch.catalog import uncertain_text
from dramafetch.discovery import (
    AutoDiscovery,
    PlaywrightDiscovery,
    StaticHtmlDiscovery,
    _partial,
    choose_discovery,
)
from dramafetch.discovery.browser import _build_series, _Capture, _with_query_params
from dramafetch.discovery.static import (
    DEFAULT_CHROME_MAJOR,
    IMPERSONATED_HEADERS,
    LACKING_WARNING,
    PARTIAL_WARNING,
    RATE_LIMIT_MESSAGE,
    _urllib_fetch,
    chrome_user_agent,
    cookie_domain_filter,
    default_fetch,
    ensure_same_site,
    extract_hydration_json,
    is_login_url,
    looks_like_challenge,
    redact_payload,
    redact_tokens,
    safe_url,
)
from dramafetch.errors import (
    ChallengeError,
    DiscoveryError,
    LoginRequiredError,
    RateLimitedError,
)
from dramafetch.models import (
    DiscoveryOptions,
    DownloadResult,
    DownloadStatus,
    Episode,
    Series,
    SeriesRef,
)

SERIES_ID = "7699393770256782354"
SERIES_NAME = "The Billionaire's Secret Heiress"
BASE = "https://www.tiktok.com"
SECRET = "SECRET-COOKIE-VALUE"


def _hydration_html(payload: Any, script_id: str = "__UNIVERSAL_DATA_FOR_REHYDRATION__") -> str:
    return (
        "<!DOCTYPE html><html><head><title>TikTok - Make Your Day</title>"
        f'<script type="application/json" id="{script_id}">{json.dumps(payload)}</script>'
        '</head><body><div id="app"></div><script>window.__captcha_sdk = {}</script></body></html>'
    )


def _embedded(item_lists: list[list[dict[str, Any]]], total: int | None, has_more: bool) -> dict:
    detail: dict[str, Any] = {"dramaName": SERIES_NAME}
    if total is not None:
        detail["totalEpisode"] = total
    scope: dict[str, Any] = {"dramaInfo": detail, "itemList": item_lists[0], "hasMore": has_more}
    if len(item_lists) > 1:
        scope["more"] = {"data": {"itemList": item_lists[1]}}
    return {
        "__DEFAULT_SCOPE__": {
            "webapp.app-context": {"language": "en"},
            "webapp.shortdrama-detail": scope,
        }
    }


class FakeFetch:
    """Records the request and answers with a canned page (or raises)."""

    def __init__(
        self, body: str = "", final_url: str | None = None, error: Exception | None = None
    ) -> None:
        self.body, self.final_url, self.error = body, final_url, error
        self.calls: list[tuple[str, dict[str, str]]] = []

    def __call__(self, url: str, headers: dict[str, str]) -> tuple[str, str]:
        self.calls.append((url, dict(headers)))
        if self.error is not None:
            raise self.error
        return self.final_url or url, self.body


def _cookies_txt(tmp_path: Path) -> Path:
    path = tmp_path / "cookies.txt"
    expires = int(time.time()) + 86_400
    path.write_text(
        "# Netscape HTTP Cookie File\n"
        f"#HttpOnly_.tiktok.com\tTRUE\t/\tTRUE\t{expires}\tsessionid\t{SECRET}\n",
        encoding="utf-8",
    )
    return path


# --- StaticHtmlDiscovery ----------------------------------------------------------------------


def test_embedded_first_page_becomes_a_partial_series(item_list_pages) -> None:
    fetch = FakeFetch(
        _hydration_html(_embedded([item_list_pages[0]["itemList"]], total=5, has_more=True))
    )

    series = StaticHtmlDiscovery(fetch=fetch).discover(
        SeriesRef(SERIES_ID, episode_hint=2), DiscoveryOptions(strategy="static")
    )

    assert series.series_id == SERIES_ID
    assert series.name == SERIES_NAME
    assert series.total_hint == 5
    assert series.numbers == [1, 2, 3]  # the trailer without an episode number is skipped
    assert all(e.item_id != "7699400000000000099" for e in series.episodes)
    assert "TikTok announces 5 episodes, 3 listed" in series.warnings
    assert any(w.startswith(PARTIAL_WARNING) for w in series.warnings)
    # 3.0.1: the embedded page's own `hasMore` is kept, and what the series lacks is in it —
    # since the lead's decision D2 (changed on purpose) only what it certainly lacks: TikTok counts
    # 5, three episodes and the trailer came, so E04 is missing and E05 may be the trailer
    assert series.early_end == PARTIAL_WARNING
    assert series.missing_numbers == [4]
    assert uncertain_text(5, 3, 1) in series.warnings

    ((url, headers),) = fetch.calls
    # 3.0.1: episode 1's page, whatever episode the reference names (2 here)
    assert url == f"{BASE}/shortdrama/episode/{SERIES_ID}/1"
    assert "Chrome/" in headers["User-Agent"] and "Headless" not in headers["User-Agent"]
    assert headers["Accept-Language"].startswith("en-US")
    assert "Cookie" not in headers


def test_an_embedded_first_page_that_says_tiktok_has_more_is_partial_without_a_count(
    item_list_pages,
) -> None:
    """3.0.1: each embedded list is read with its own holder's `hasMore` and `cursor` — re-wrapped
    bare, a first page that says TikTok has more passed for the whole series when no count was
    known (no `totalEpisode`, no `numVideos`): complete, marked complete, skipped for 24 h."""
    fetch = FakeFetch(
        _hydration_html(_embedded([item_list_pages[0]["itemList"]], total=None, has_more=True))
    )
    series = StaticHtmlDiscovery(fetch=fetch).discover(SeriesRef(SERIES_ID), DiscoveryOptions())
    assert series.total_hint is None
    assert series.numbers == [1, 2, 3]
    assert series.early_end == PARTIAL_WARNING
    assert series.missing_numbers == []  # nothing to name them by
    assert f"{PARTIAL_WARNING}; use --strategy browser for the full list" in series.warnings
    assert series.listing is not None
    assert series.listing.endpoint == f"{BASE}/shortdrama/episode/{SERIES_ID}/1"
    assert [
        (p.kind, p.cursor_asked, p.listed, p.items, p.numbers, p.has_more, p.cursor)
        for p in series.listing.pages
    ] == [("embedded", None, True, 4, (1, 2, 3), True, None)]


def test_a_hole_in_the_embedded_list_is_partial_too(item_list_pages) -> None:
    """3.0.1: a number missing below the highest one listed makes the static result partial (the
    `auto` strategy then lets the browser list it, and ask again for what it lacks)."""
    without_two = [
        item for item in item_list_pages[0]["itemList"] if item["id"] != "7699400000000000002"
    ]
    fetch = FakeFetch(_hydration_html(_embedded([without_two], total=None, has_more=False)))
    series = StaticHtmlDiscovery(fetch=fetch).discover(SeriesRef(SERIES_ID), DiscoveryOptions())
    assert series.numbers == [1, 3]
    assert (series.missing_numbers, series.early_end) == ([2], None)
    assert "episode 2 missing (gap)" in series.warnings
    # 3.0.1 (changed on purpose): the page's list is whole, so it lacks the episode — never "only
    # the embedded first page was read"
    assert f"{LACKING_WARNING}; use --strategy browser to ask TikTok again" in series.warnings
    assert not any(w.startswith(PARTIAL_WARNING) for w in series.warnings)


def test_full_embedded_list_has_no_partial_warning(item_list_pages) -> None:
    lists = [item_list_pages[0]["itemList"], item_list_pages[1]["data"]["itemList"]]
    fetch = FakeFetch(_hydration_html(_embedded(lists, total=5, has_more=False)))

    series = StaticHtmlDiscovery(fetch=fetch).discover(SeriesRef(SERIES_ID), DiscoveryOptions())

    assert series.numbers == [1, 2, 3, 4, 5]  # duplicate 2 and the other-series item dropped
    assert series.episode(5) is not None and series.episode(5).locked
    assert "isFree=false" in series.episode(5).lock_hints
    assert not any(w.startswith(PARTIAL_WARNING) for w in series.warnings)
    assert not any("gap" in w or "duplicate" in w for w in series.warnings)
    assert (series.missing_numbers, series.early_end) == ([], None)


def test_series_name_falls_back_to_the_episodes(item_list_pages) -> None:
    payload = {"itemList": item_list_pages[0]["itemList"]}  # no dramaInfo holder with a total
    series = StaticHtmlDiscovery(fetch=FakeFetch(_hydration_html(payload))).discover(
        SeriesRef(SERIES_ID), DiscoveryOptions()
    )
    assert series.name == SERIES_NAME
    assert series.total_hint is None


FIFTH_SERIES_ID = "7699393770256782377"
FIXTURES = Path(__file__).parent / "fixtures"
#: The fifth series' duplicate and skipped items, as the warnings name them.
FIFTH_WARNINGS = [
    "duplicate episode number 2: item 7699400000000000692 left out (a highlight), "
    "item 7699400000000000602 kept",
    "TikTok listed 1 item DramaFetch could not read (another drama's id)",
    "TikTok listed 1 item DramaFetch could not read (no episode number)",
]


def _fifth_items(*names: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for name in names:
        page = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
        items.extend(page["itemList"])
    return items


def test_static_reads_tiktok_s_count_from_the_items_and_holds_the_items_received_against_it() -> (
    None
):
    """No detail total: the items' `numVideos` (7) is the count — never another drama's (12) —
    and the five episodes, the highlight and the trailer meet it; the highlight never takes
    episode 2; the skipped items keep their reasons. 3.0.1, the lead's decision D2 (changed on
    purpose): whether TikTok counts the highlight and the trailer is not known — no number is
    named missing, but the list is uncertain: said, and partial for ``auto``, whose browser listing
    asks once more."""
    every = _fifth_items("item_list_series5_page1.json", "item_list_series5_page2.json")
    # a related drama's object first in the page: its name and count are not this drama's
    related = {
        "dramaInfo": {"dramaID": "7600000000000000000", "dramaName": "Other", "numVideos": 12}
    }
    payload = {"recommended": related, "itemList": every}
    series = StaticHtmlDiscovery(fetch=FakeFetch(_hydration_html(payload))).discover(
        SeriesRef(FIFTH_SERIES_ID), DiscoveryOptions()
    )
    assert series.name == "Highlight Drama"
    assert series.total_hint == 7
    assert series.numbers == [1, 2, 3, 4, 5]
    episode_2 = series.episode(2)
    assert episode_2 is not None and episode_2.item_id == "7699400000000000602"
    assert series.warnings == [
        *FIFTH_WARNINGS,
        "TikTok announces 7 episodes, 5 listed",
        uncertain_text(7, 5, 2),
    ]
    assert (series.missing_numbers, series.early_end) == ([], None)
    assert _partial(series)  # `auto` completes it with the browser
    assert [(item.reason, item.item_id) for item in series.skipped_items] == [
        ("no episode number", "7699400000000000690"),
        ("another drama's id", "7699400000000000778"),
    ]
    assert series.items_received == 7

    # only the first page embedded: five of TikTok's seven items — partial, said with the count
    first = _fifth_items("item_list_series5_page1.json")
    series = StaticHtmlDiscovery(fetch=FakeFetch(_hydration_html({"itemList": first}))).discover(
        SeriesRef(FIFTH_SERIES_ID), DiscoveryOptions()
    )
    assert series.total_hint == 7 and series.items_received == 5
    assert series.numbers == [1, 2, 3]
    assert "TikTok announces 7 episodes, 3 listed" in series.warnings
    # 3.0.1 (changed on purpose): no `hasMore` reached this page, so to the static strategy its
    # list is whole and lacks what TikTok's count places past it — `auto` lists it again
    assert series.missing_numbers == [4, 5]
    assert f"{LACKING_WARNING}; use --strategy browser to ask TikTok again" in series.warnings
    assert _partial(series)


def test_the_browser_build_reads_the_items_count_when_the_detail_gives_none() -> None:
    """`browser._build_series`: the pages merged by the catalog's rules, the detail's count when
    it has one (a related drama's never), else the items' `numVideos`."""
    pages = [
        json.loads((FIXTURES / f"item_list_series5_page{n}.json").read_text(encoding="utf-8"))
        for n in (1, 2)
    ]
    capture = _Capture(series_id=FIFTH_SERIES_ID)
    for page in pages:
        capture.ingest("https://www.tiktok.com/api/drama/episode/item_list/?cursor=0", page)
    ref = SeriesRef(FIFTH_SERIES_ID)
    series = _build_series(ref, DiscoveryOptions(), capture)
    assert (series.name, series.total_hint, series.items_received) == ("Highlight Drama", 7, 7)
    assert series.numbers == [1, 2, 3, 4, 5]
    # 3.0.1, the lead's decision D2 (changed on purpose): TikTok's 7 may count the highlight and
    # the trailer — the list is uncertain and says so
    assert series.warnings == [
        *FIFTH_WARNINGS,
        "TikTok announces 7 episodes, 5 listed",
        uncertain_text(7, 5, 2),
    ]
    assert len(series.skipped_items) == 2
    # a detail that names its count wins; a related drama's object in it gives nothing
    capture.detail = {
        "related": [{"dramaInfo": {"dramaID": "1", "dramaName": "Other", "numVideos": 40}}],
        "dramaInfo": {"dramaID": FIFTH_SERIES_ID, "dramaName": "Detail Name", "numVideos": 9},
    }
    series = _build_series(ref, DiscoveryOptions(), capture)
    assert (series.name, series.total_hint) == ("Detail Name", 9)
    assert series.warnings == [
        *FIFTH_WARNINGS,
        "TikTok announces 9 episodes, 5 listed",
        uncertain_text(9, 5, 2),
    ]
    assert series.missing_numbers == [6, 7]  # 9 less the 2 other items: 6 and 7, not 8 and 9


def test_sigi_state_script_is_accepted_too(item_list_pages) -> None:
    html = _hydration_html(
        {"ItemList": {"x": {"itemList": item_list_pages[0]["itemList"]}}}, "SIGI_STATE"
    )
    series = StaticHtmlDiscovery(fetch=FakeFetch(html)).discover(
        SeriesRef(SERIES_ID), DiscoveryOptions()
    )
    assert series.numbers == [1, 2, 3]


def test_cookies_file_becomes_a_cookie_header_and_never_leaks(
    tmp_path: Path, item_list_pages
) -> None:
    fetch = FakeFetch(
        _hydration_html(_embedded([item_list_pages[0]["itemList"]], total=3, has_more=False))
    )
    options = DiscoveryOptions(cookies_file=_cookies_txt(tmp_path))

    series = StaticHtmlDiscovery(fetch=fetch).discover(SeriesRef(SERIES_ID), options)

    assert fetch.calls[0][1]["Cookie"] == f"sessionid={SECRET}"
    assert SECRET not in repr(series)
    assert SECRET not in " ".join(series.warnings)


def test_cookies_without_a_matching_domain_only_warn(tmp_path: Path, item_list_pages) -> None:
    path = tmp_path / "cookies.txt"
    path.write_text(f".example.com\tTRUE\t/\tTRUE\t{int(time.time()) + 999}\tsessionid\t{SECRET}\n")
    fetch = FakeFetch(_hydration_html({"itemList": item_list_pages[0]["itemList"]}))

    series = StaticHtmlDiscovery(fetch=fetch).discover(
        SeriesRef(SERIES_ID), DiscoveryOptions(cookies_file=path)
    )

    assert "Cookie" not in fetch.calls[0][1]
    assert any("no unexpired cookies for tiktok.com" in w for w in series.warnings)
    assert SECRET not in " ".join(series.warnings)


def test_unreadable_cookies_file_is_a_discovery_error(tmp_path: Path) -> None:
    with pytest.raises(DiscoveryError, match="cookies file"):
        StaticHtmlDiscovery(fetch=FakeFetch("<html></html>")).discover(
            SeriesRef(SERIES_ID), DiscoveryOptions(cookies_file=tmp_path / "missing.txt")
        )


def test_login_redirect_raises_login_required() -> None:
    fetch = FakeFetch("<html>Log in</html>", final_url=f"{BASE}/login?redirect_url=%2Fshortdrama")
    with pytest.raises(LoginRequiredError, match="--cookies"):
        StaticHtmlDiscovery(fetch=fetch).discover(SeriesRef(SERIES_ID), DiscoveryOptions())


def test_page_without_hydration_data_is_a_discovery_error() -> None:
    with pytest.raises(DiscoveryError, match="use --strategy browser"):
        StaticHtmlDiscovery(fetch=FakeFetch("<html><body>nothing here</body></html>")).discover(
            SeriesRef(SERIES_ID), DiscoveryOptions()
        )


def test_hydration_without_episodes_is_a_discovery_error() -> None:
    html = _hydration_html({"__DEFAULT_SCOPE__": {"webapp.app-context": {"language": "en"}}})
    with pytest.raises(DiscoveryError, match="no episode data"):
        StaticHtmlDiscovery(fetch=FakeFetch(html)).discover(
            SeriesRef(SERIES_ID), DiscoveryOptions()
        )


def test_verification_page_is_a_discovery_error_so_auto_can_fall_back() -> None:
    fetch = FakeFetch("<html><body><h1>Verify to continue</h1></body></html>")
    with pytest.raises(DiscoveryError, match="verification page") as info:
        StaticHtmlDiscovery(fetch=fetch).discover(SeriesRef(SERIES_ID), DiscoveryOptions())
    assert not isinstance(info.value, ChallengeError)


def test_fetch_failures_are_wrapped_without_the_headers(tmp_path: Path) -> None:
    fetch = FakeFetch(error=OSError("connection reset by peer"))
    with pytest.raises(DiscoveryError, match="could not fetch") as info:
        StaticHtmlDiscovery(fetch=fetch).discover(
            SeriesRef(SERIES_ID), DiscoveryOptions(cookies_file=_cookies_txt(tmp_path))
        )
    assert SECRET not in str(info.value)
    assert fetch.calls[0][1]["Cookie"].endswith(SECRET)  # it was sent to the fetch, and only there


def test_discovery_errors_from_the_fetch_pass_through() -> None:
    fetch = FakeFetch(error=RateLimitedError(RATE_LIMIT_MESSAGE))
    with pytest.raises(RateLimitedError, match="429") as info:
        StaticHtmlDiscovery(fetch=fetch).discover(SeriesRef(SERIES_ID), DiscoveryOptions())
    assert str(info.value) == RATE_LIMIT_MESSAGE


# --- the real fetchers against local servers (no network beyond 127.0.0.1) ----------------------


class _Route:
    def __init__(self, status: int, body: bytes = b"", location: str | None = None) -> None:
        self.status, self.body, self.location = status, body, location


class _LocalServer:
    """`with _LocalServer({"/page": _Route(302, location=...)}) as server:` records the Cookie
    header of every request (test-only values) and answers from the routes."""

    def __init__(self, routes: dict[str, _Route]) -> None:
        self.routes = routes
        self.cookies_seen: list[str | None] = []
        self.paths_seen: list[str] = []
        self.headers_seen: list[dict[str, str]] = []  # lower-cased names; test-only values
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                outer.paths_seen.append(self.path)
                outer.cookies_seen.append(self.headers.get("Cookie"))
                outer.headers_seen.append({k.lower(): v for k, v in self.headers.items()})
                route = outer.routes.get(self.path.split("?")[0], _Route(404, b"not found"))
                self.send_response(route.status)
                if route.location:
                    self.send_header("Location", route.location)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(route.body)))
                self.end_headers()
                self.wfile.write(route.body)

            def log_message(self, *args: Any) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> _LocalServer:
        self._thread.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._server.shutdown()
        self._server.server_close()

    @property
    def port(self) -> int:
        return int(self._server.server_address[1])


@pytest.fixture(params=[_urllib_fetch, default_fetch], ids=["urllib", "default_fetch"])
def real_fetch(request: pytest.FixtureRequest) -> Iterator[Any]:
    pytest.importorskip("curl_cffi") if request.param is default_fetch else None
    yield request.param


def test_cookies_never_follow_a_redirect_to_another_host(real_fetch: Any) -> None:
    with _LocalServer({"/landing": _Route(200, b"<html>other site</html>")}) as other:
        location = f"http://localhost:{other.port}/landing"  # a different hostname
        with _LocalServer({"/page": _Route(302, location=location)}) as origin:
            headers = {"User-Agent": "x", "Cookie": f"sessionid={SECRET}"}
            with pytest.raises(DiscoveryError, match="redirected off-site") as info:
                real_fetch(f"http://127.0.0.1:{origin.port}/page", headers)
        assert SECRET not in str(info.value)
        assert f"localhost:{other.port}/landing" in str(info.value)
        assert origin.cookies_seen == [f"sessionid={SECRET}"]
        assert SECRET not in " ".join(c or "" for c in other.cookies_seen)  # never reached it


def test_same_site_redirects_are_followed_with_the_cookie(real_fetch: Any) -> None:
    routes = {"/page": _Route(302, location="/landing"), "/landing": _Route(200, b"<p>ok</p>")}
    with _LocalServer(routes) as server:
        final_url, body = real_fetch(
            f"http://127.0.0.1:{server.port}/page", {"User-Agent": "x", "Cookie": "sessionid=v"}
        )
    assert final_url == f"http://127.0.0.1:{server.port}/landing"
    assert body == "<p>ok</p>"
    assert server.paths_seen == ["/page", "/landing"]
    assert server.cookies_seen == ["sessionid=v", "sessionid=v"]


def test_http_429_is_a_rate_limited_error(real_fetch: Any) -> None:
    with _LocalServer({"/page": _Route(429, b"slow down")}) as server:
        with pytest.raises(RateLimitedError, match="30-60 minutes"):
            real_fetch(f"http://127.0.0.1:{server.port}/page", {"User-Agent": "x"})
        with pytest.raises(DiscoveryError, match="HTTP 404") as info:
            real_fetch(f"http://127.0.0.1:{server.port}/nope", {"User-Agent": "x"})
    assert not isinstance(info.value, RateLimitedError)


def test_default_fetch_lets_curl_cffi_send_its_own_chrome_headers() -> None:
    """With curl_cffi the impersonated Chrome's User-Agent, Accept and Accept-Language go out, not
    DramaFetch's (`IMPERSONATED_HEADERS`): one client whose headers, client hints and TLS
    fingerprint agree (a Chrome/153 user agent next to `sec-ch-ua: …v="152"` would not). The
    Cookie header is still DramaFetch's. The urllib fallback keeps every header it is given."""
    pytest.importorskip("curl_cffi")
    ours = {
        "User-Agent": "Mozilla/5.0 Chrome/999.0.0.0",
        "Accept": "text/x-dramafetch",
        "Accept-Language": "xx-XX",
        "Cookie": "sessionid=v",
    }
    with _LocalServer({"/page": _Route(200, b"<p>ok</p>")}) as server:
        default_fetch(f"http://127.0.0.1:{server.port}/page", dict(ours))
        _urllib_fetch(f"http://127.0.0.1:{server.port}/page", dict(ours))
    curl, urllib = server.headers_seen
    assert "Chrome/999" not in curl["user-agent"] and "Chrome/" in curl["user-agent"]
    assert "Headless" not in curl["user-agent"]
    assert curl["accept"] != "text/x-dramafetch" and "text/html" in curl["accept"]
    assert curl.get("accept-language", "") not in ("", "xx-XX")
    assert "chrom" in curl.get("sec-ch-ua", "").lower()  # the profile's own client hints
    assert urllib["user-agent"] == "Mozilla/5.0 Chrome/999.0.0.0"
    assert urllib["accept"] == "text/x-dramafetch" and urllib["accept-language"] == "xx-XX"
    assert server.cookies_seen == ["sessionid=v", "sessionid=v"]
    assert frozenset({"user-agent", "accept", "accept-language"}) == IMPERSONATED_HEADERS


def test_ensure_same_site_rules() -> None:
    ensure_same_site("https://www.tiktok.com/a", "https://www.tiktok.com/login?x=1")
    # the same registrable domain counts as the same site
    ensure_same_site("https://m.tiktok.com/a", "https://www.tiktok.com/b")
    ensure_same_site("http://127.0.0.1:9/a", "http://127.0.0.1:9/b")
    for target in (
        "https://tiktokcdn.com/a",
        "https://evil.example/tiktok.com",
        "http://www.tiktok.com/a",  # https -> http downgrade
        "https://nottiktok.com/a",
    ):
        with pytest.raises(DiscoveryError, match="off-site"):
            ensure_same_site("https://www.tiktok.com/a?msToken=secret", target + "?msToken=t")


def test_dump_dir_receives_redacted_hydration_and_page_url(tmp_path: Path, item_list_pages) -> None:
    payload = {"itemList": item_list_pages[0]["itemList"], "msToken": "token-value", "cursor": 3}
    fetch = FakeFetch(
        _hydration_html(payload), final_url=f"{BASE}/shortdrama/episode/{SERIES_ID}/1?lang=en"
    )
    dump_dir = tmp_path / "dump"

    StaticHtmlDiscovery(fetch=fetch).discover(
        SeriesRef(SERIES_ID), DiscoveryOptions(dump_dir=dump_dir)
    )

    dumped = json.loads((dump_dir / "hydration_1.json").read_text(encoding="utf-8"))
    assert dumped["msToken"] == "<redacted>"
    assert dumped["cursor"] == 3
    assert len(dumped["itemList"]) == 4
    assert (dump_dir / "page_url.txt").read_text() == f"{BASE}/shortdrama/episode/{SERIES_ID}/1\n"


def test_extract_hydration_json_skips_broken_blobs() -> None:
    html = (
        '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{not json</script>'
        "<script id='SIGI_STATE' type='application/json'>{\"ok\": 1}</script>"
    )
    assert extract_hydration_json(html) == [{"ok": 1}]
    assert extract_hydration_json("<html></html>") == []


# --- choose_discovery / AutoDiscovery -----------------------------------------------------------


class RecordingDiscovery:
    def __init__(self, result: Series | None = None, error: Exception | None = None) -> None:
        self.result, self.error, self.calls = result, error, 0

    def discover(self, ref: SeriesRef, options: DiscoveryOptions) -> Series:
        self.calls += 1
        if self.error is not None:
            raise self.error
        assert self.result is not None
        return self.result


def _series(numbers: list[int], warnings: list[str] | None = None) -> Series:
    episodes = [
        Episode(number=n, item_id=f"id{n}", title=f"E{n}", series_id=SERIES_ID) for n in numbers
    ]
    return Series(series_id=SERIES_ID, name="S", episodes=episodes, warnings=list(warnings or []))


def test_choose_discovery_maps_every_strategy() -> None:
    assert isinstance(choose_discovery(DiscoveryOptions(strategy="browser")), PlaywrightDiscovery)
    assert isinstance(choose_discovery(DiscoveryOptions(strategy="static")), StaticHtmlDiscovery)
    assert isinstance(choose_discovery(DiscoveryOptions(strategy="auto")), AutoDiscovery)
    assert isinstance(choose_discovery(DiscoveryOptions(strategy=" Auto ")), AutoDiscovery)
    with pytest.raises(ValueError, match="unknown discovery strategy 'magic'"):
        choose_discovery(DiscoveryOptions(strategy="magic"))


def test_auto_uses_the_browser_when_static_fails_and_records_why() -> None:
    static = RecordingDiscovery(error=DiscoveryError("page has no episode data"))
    browser = RecordingDiscovery(result=_series([1, 2], ["1 episode looks locked"]))

    series = AutoDiscovery(static=static, browser=browser).discover(
        SeriesRef(SERIES_ID), DiscoveryOptions()
    )

    assert (static.calls, browser.calls) == (1, 1)
    assert series.numbers == [1, 2]
    assert (
        series.warnings[0] == "static strategy failed (page has no episode data); used the browser"
    )
    assert series.warnings[1] == "1 episode looks locked"


@pytest.mark.parametrize(
    "error",
    [LoginRequiredError("log in"), ChallengeError("captcha"), RateLimitedError("HTTP 429")],
)
def test_auto_propagates_login_and_challenge_errors_without_a_browser(error: Exception) -> None:
    browser = RecordingDiscovery(result=_series([1]))
    with pytest.raises(type(error)):
        AutoDiscovery(static=RecordingDiscovery(error=error), browser=browser).discover(
            SeriesRef(SERIES_ID), DiscoveryOptions()
        )
    assert browser.calls == 0


def test_auto_keeps_a_complete_static_result_without_a_browser() -> None:
    browser = RecordingDiscovery(result=_series([1, 2, 3]))
    series = AutoDiscovery(
        static=RecordingDiscovery(result=_series([1, 2])), browser=browser
    ).discover(SeriesRef(SERIES_ID), DiscoveryOptions())
    assert series.numbers == [1, 2]
    assert browser.calls == 0


def test_auto_completes_a_partial_static_result_with_the_browser() -> None:
    partial = _series([1, 2], [f"{PARTIAL_WARNING}; use --strategy browser for the full list"])
    browser = RecordingDiscovery(result=_series([1, 2, 3, 4]))

    series = AutoDiscovery(static=RecordingDiscovery(result=partial), browser=browser).discover(
        SeriesRef(SERIES_ID), DiscoveryOptions()
    )

    assert series.numbers == [1, 2, 3, 4]
    assert browser.calls == 1
    assert "completed with the browser" in series.warnings[0]


def test_auto_returns_the_partial_static_result_when_the_browser_fails_too() -> None:
    partial = _series([1, 2], [PARTIAL_WARNING])
    browser = RecordingDiscovery(error=LoginRequiredError("no episode list arrived"))

    series = AutoDiscovery(static=RecordingDiscovery(result=partial), browser=browser).discover(
        SeriesRef(SERIES_ID), DiscoveryOptions()
    )

    assert series.numbers == [1, 2]
    assert series.warnings[0] == PARTIAL_WARNING
    assert (
        "browser strategy could not complete the list (no episode list arrived)"
        in series.warnings[1]
    )


@pytest.mark.parametrize(
    "error",
    [ChallengeError("captcha"), RateLimitedError("HTTP 429 on the episode list")],
    ids=["a captcha", "an HTTP 429"],
)
def test_auto_stops_on_a_refusal_the_browser_meets_while_completing_a_partial_result(
    error: Exception,
) -> None:
    """3.0.1 (the review's L1): a 429 or a captcha the browser meets while it completes a partial
    static result — its pagination or its gap filling — is a refusal, as it is on the static path:
    it propagates (a stop, and through ``engine.resolve`` the 30-minute cooldown), never a warning
    over the embedded first page. A login wall keeps its pinned swallow (above)."""
    partial = _series([1, 2], [PARTIAL_WARNING])
    partial.early_end = PARTIAL_WARNING
    browser = RecordingDiscovery(error=error)
    with pytest.raises(type(error)):
        AutoDiscovery(static=RecordingDiscovery(result=partial), browser=browser).discover(
            SeriesRef(SERIES_ID), DiscoveryOptions()
        )
    assert browser.calls == 1
    # through the engine's resolve, as a run lists a series: the cooldown, source discovery
    assert cooldown.active_cooldown() is None
    again = AutoDiscovery(static=RecordingDiscovery(result=partial), browser=browser)
    with pytest.raises(type(error)):
        engine.resolve(SeriesRef(SERIES_ID), DiscoveryOptions(), again)
    recorded = cooldown.active_cooldown()
    assert recorded is not None
    assert (recorded.reason, recorded.source) == (str(error), "discovery")


@pytest.mark.parametrize(
    "lacking",
    [{"missing_numbers": [3]}, {"early_end": PARTIAL_WARNING}],
    ids=["a missing number", "an early end"],
)
def test_auto_completes_a_static_result_that_lacks_part_of_the_list(
    lacking: dict[str, Any],
) -> None:
    """3.0.1: what the static result lacks — a missing number, an early end — makes it partial on
    its own, warning or not: the browser lists the series (and asks again for what it lacks)."""
    partial = _series([1, 2, 4])
    for name, value in lacking.items():
        setattr(partial, name, value)
    browser = RecordingDiscovery(result=_series([1, 2, 3, 4]))
    series = AutoDiscovery(static=RecordingDiscovery(result=partial), browser=browser).discover(
        SeriesRef(SERIES_ID), DiscoveryOptions()
    )
    assert browser.calls == 1
    assert series.numbers == [1, 2, 3, 4]


def test_auto_completes_an_uncertain_static_result_with_the_browser() -> None:
    """3.0.1 (the lead's D2): a static result TikTok counts more items of than it can place — its
    count may include the trailer it lists — is partial: the static strategy asks nothing, so the
    browser lists the series and its gap filling asks once for the page after the highest number;
    a count everything listed accounts for keeps the static result. The warnings say what
    happened — the page's list was whole, TikTok counts more —, never that the static strategy saw
    only the first page; when the browser fails, the list the page embeds is shown."""
    uncertain = _series([1, 2, 3])
    uncertain.total_hint, uncertain.items_received = 4, 4  # three episodes and a trailer
    browser = RecordingDiscovery(result=_series([1, 2, 3, 4]))
    series = AutoDiscovery(static=RecordingDiscovery(result=uncertain), browser=browser).discover(
        SeriesRef(SERIES_ID), DiscoveryOptions()
    )
    assert (browser.calls, series.numbers) == (1, [1, 2, 3, 4])
    assert series.warnings[0] == (
        "static strategy: TikTok counts more episodes than the page lists; listed again with the "
        "browser"
    )
    whole = _series([1, 2, 3])
    whole.total_hint, whole.items_received = 4, 4
    failed = RecordingDiscovery(error=LoginRequiredError("no episode list arrived"))
    series = AutoDiscovery(static=RecordingDiscovery(result=whole), browser=failed).discover(
        SeriesRef(SERIES_ID), DiscoveryOptions()
    )
    assert (failed.calls, series.numbers) == (1, [1, 2, 3])
    assert series.warnings[-1] == (
        "browser strategy could not list it again (no episode list arrived); showing the list the "
        "page embeds"
    )
    placed = _series([1, 2, 3])
    placed.total_hint, placed.items_received = 3, 4
    kept = RecordingDiscovery(result=_series([1, 2, 3, 4]))
    series = AutoDiscovery(static=RecordingDiscovery(result=placed), browser=kept).discover(
        SeriesRef(SERIES_ID), DiscoveryOptions()
    )
    assert (kept.calls, series.numbers) == (0, [1, 2, 3])


def test_a_whole_embedded_list_lacking_an_episode_says_so_and_auto_lists_it_again(
    item_list_pages,
) -> None:
    """3.0.1 (the owner's report of 2026-11-27): a list the page embeds whole (no ``hasMore``)
    that lacks an episode — here E02, which TikTok left out — names the episode missing (a
    ``--strategy static`` run never calls the drama complete) and says the page's list lacks it,
    never that only the first page was read; `auto` lists the drama again with the browser, and
    when the browser fails it shows the list the page embeds."""
    items = [item for item in item_list_pages[0]["itemList"] if item["id"] != "7699400000000000002"]
    page = _hydration_html(_embedded([items], total=None, has_more=False))
    series = StaticHtmlDiscovery(fetch=FakeFetch(page)).discover(
        SeriesRef(SERIES_ID), DiscoveryOptions(strategy="static")
    )
    assert series.numbers == [1, 3]
    assert (series.missing_numbers, series.early_end) == ([2], None)
    assert "episode 2 missing (gap)" in series.warnings
    assert f"{LACKING_WARNING}; use --strategy browser to ask TikTok again" in series.warnings
    assert not any(w.startswith(PARTIAL_WARNING) for w in series.warnings)
    report = engine.series_report(series, [])
    assert (report.gaps, report.complete) == ((2,), False)
    # auto: listed again with the browser, said for what it was
    browser = RecordingDiscovery(result=_series([1, 2, 3]))
    completed = AutoDiscovery(
        static=StaticHtmlDiscovery(fetch=FakeFetch(page)), browser=browser
    ).discover(SeriesRef(SERIES_ID), DiscoveryOptions())
    assert (browser.calls, completed.numbers) == (1, [1, 2, 3])
    assert completed.warnings[0] == (
        "static strategy: the episode list the page embeds lacks an episode; listed again with "
        "the browser"
    )
    failed = RecordingDiscovery(error=LoginRequiredError("no episode list arrived"))
    shown = AutoDiscovery(
        static=StaticHtmlDiscovery(fetch=FakeFetch(page)), browser=failed
    ).discover(SeriesRef(SERIES_ID), DiscoveryOptions())
    assert (failed.calls, shown.numbers, shown.missing_numbers) == (1, [1, 3], [2])
    assert shown.warnings[-1] == (
        "browser strategy could not list it again (no episode list arrived); showing the list the "
        "page embeds"
    )


def test_an_embedded_episode_tiktok_marks_as_a_highlight_is_listed_and_the_list_is_whole(
    item_list_pages,
) -> None:
    """4.0.1 (the owner's report of 2026-11-27: TikTok marks some full episodes as highlights):
    E04's item, the only one numbered 4, carries ``IsHighlight`` — it is episode 4. The list the
    page embeds is whole: nothing missing, no gap, no lacking warning, the drama complete once
    every episode is saved, and `auto` keeps the page's list without starting the browser."""
    items = list(item_list_pages[0]["itemList"])
    marked = copy.deepcopy(next(item for item in items if item["id"] == "7699400000000000003"))
    marked["id"] = "7699400000000000904"
    marked["dramaInfo"]["DramaVideoData"]["EpisodeNumber"] = 4
    marked["dramaInfo"]["DramaVideoData"]["IsHighlight"] = True
    page = _hydration_html(_embedded([[*items, marked]], total=4, has_more=False))
    series = StaticHtmlDiscovery(fetch=FakeFetch(page)).discover(
        SeriesRef(SERIES_ID), DiscoveryOptions(strategy="static")
    )
    assert series.numbers == [1, 2, 3, 4]
    episode_4 = series.episode(4)
    assert episode_4 is not None and episode_4.item_id == "7699400000000000904"
    assert (series.missing_numbers, series.early_end) == ([], None)
    assert not any("gap" in w or w.startswith(LACKING_WARNING) for w in series.warnings)
    assert not _partial(series)
    results = [DownloadResult(episode, DownloadStatus.DONE) for episode in series.episodes]
    report = engine.series_report(series, results)
    assert (report.gaps, report.complete) == ((), True)
    assert engine.report_line(report) == "complete: 4 of 4 (4 downloaded)"
    browser = RecordingDiscovery(result=_series([1, 2, 3, 4]))
    kept = AutoDiscovery(static=StaticHtmlDiscovery(fetch=FakeFetch(page)), browser=browser)
    assert kept.discover(SeriesRef(SERIES_ID), DiscoveryOptions()).numbers == [1, 2, 3, 4]
    assert browser.calls == 0


# --- helpers shared by both strategies ----------------------------------------------------------


def test_chrome_user_agent_uses_the_major_version_and_never_says_headless() -> None:
    ua = chrome_user_agent("153.0.8010.12")
    assert "Chrome/153.0.0.0 Safari/537.36" in ua
    assert ua.startswith("Mozilla/5.0 (")
    assert "Headless" not in ua
    assert f"Chrome/{DEFAULT_CHROME_MAJOR}.0.0.0" in chrome_user_agent(None)
    assert f"Chrome/{DEFAULT_CHROME_MAJOR}.0.0.0" in chrome_user_agent("garbage")


def test_redact_tokens_blanks_cookie_like_values_only() -> None:
    text = (
        "GET ?aid=1988&msToken=abc.DEF-123&cursor=30&X-Bogus=DFSz; Cookie: sessionid=xyz; sid_tt=q"
    )
    redacted = redact_tokens(text)
    assert "abc.DEF-123" not in redacted and "xyz" not in redacted and "DFSz" not in redacted
    assert "aid=1988" in redacted and "cursor=30" in redacted
    assert redacted.count("<redacted>") == 4


def test_redact_payload_replaces_sensitive_keys_recursively() -> None:
    payload = {
        "msToken": "a",
        "data": [{"sessionid": "b", "csrfToken": "c", "cursor": 3}],
        "itemList": [],
    }
    assert redact_payload(payload) == {
        "msToken": "<redacted>",
        "data": [{"sessionid": "<redacted>", "csrfToken": "<redacted>", "cursor": 3}],
        "itemList": [],
    }


def test_challenge_login_and_safe_url_helpers() -> None:
    assert looks_like_challenge("Please Verify to Continue")
    assert looks_like_challenge("Checking your browser before accessing")
    assert looks_like_challenge("Slide to complete the CAPTCHA")
    assert not looks_like_challenge("The Billionaire's Secret Heiress | Episode 1")
    assert is_login_url("https://www.tiktok.com/login?redirect_url=x")
    assert is_login_url("http://127.0.0.1:9/login/phone-or-email")
    assert not is_login_url("https://www.tiktok.com/shortdrama/episode/1/1?from=login")
    assert (
        safe_url("https://www.tiktok.com/a/b?msToken=secret#frag") == "https://www.tiktok.com/a/b"
    )


def test_cookie_domain_filter_for_tiktok_and_test_servers() -> None:
    assert cookie_domain_filter("https://www.tiktok.com") == "tiktok.com"
    assert cookie_domain_filter("https://m.tiktok.com/") == "tiktok.com"
    assert cookie_domain_filter("http://127.0.0.1:8123") == "127.0.0.1"
    assert cookie_domain_filter("http://localhost:1") == "localhost"


def test_with_query_params_touches_only_cursor_and_count() -> None:
    url = (
        "https://www.tiktok.com/api/drama/episode/item_list/?WebIdLastTime=1&aid=1988&count=30"
        "&cursor=0&dramaID=7699393770256782354&pcursor=5&X-Bogus=DFSzsw%2Fabc%3D&_signature=_02B4Z"
    )
    out = _with_query_params(url, {"cursor": "30", "count": "10"})
    assert out == (
        "https://www.tiktok.com/api/drama/episode/item_list/?WebIdLastTime=1&aid=1988&count=10"
        "&cursor=30&dramaID=7699393770256782354&pcursor=5&X-Bogus=DFSzsw%2Fabc%3D&_signature=_02B4Z"
    )
    assert _with_query_params("https://h/p?a=1", {"cursor": "3"}) == "https://h/p?a=1&cursor=3"
    assert _with_query_params("https://h/p", {"cursor": "3"}) == "https://h/p?cursor=3"
