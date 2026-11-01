"""downloader_browser: the browser engine driven through a fake Playwright object graph (no
browser, no socket): skip rules, candidate order and expiry, 403 -> next URL -> in-session refresh
(bounded by the per-episode request budget, cached per run), 429, a captcha wall during the
refresh, bad bodies, error sanitising, atomic writes and close()."""

from __future__ import annotations

import errno
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from dramafetch import downloader_browser, engine
from dramafetch import media as media_module
from dramafetch.discovery.browser import FETCH_JS
from dramafetch.downloader import redact_secrets
from dramafetch.downloader_browser import (
    EXPIRY_MARGIN_S,
    MAX_COVER_GETS,
    MAX_GETS_PER_EPISODE,
    MIN_IMAGE_BYTES,
    MIN_VIDEO_BYTES,
    BrowserDownloader,
)
from dramafetch.manifest import Manifest
from dramafetch.media import INCOMPLETE_PREFIX
from dramafetch.models import DownloadOptions, DownloadStatus, Episode, Series
from dramafetch.thumbnails import EMBED_SUFFIX, extract_cover

SERIES_ID = "7699393770256782354"
BASE = "https://www.tiktok.com"
CDN_HOST = "v16-webapp-prime.tiktok.com"
CDN = f"https://{CDN_HOST}/video/tos/useast2a"
NOW = 1_800_000_000.0
FRESH = int(NOW) + 3600
SESSION_VALUE = "secret-session-value-that-must-never-show"
TINY_MP4 = (Path(__file__).parent / "fixtures" / "tiny.mp4").read_bytes()  # 3 s, mutagen-taggable


def _padded_mp4(size: int) -> bytes:
    """The fixture followed by one top-level `free` box that pads it to `size` bytes — like the
    fake CDN's episodes: a valid MP4 above MIN_VIDEO_BYTES."""
    box = size - len(TINY_MP4)
    return TINY_MP4 + box.to_bytes(4, "big") + b"free" + b"\0" * (box - 8)


VIDEO = _padded_mp4(2 * MIN_VIDEO_BYTES)
# The default name format, "{series} - Episode {number}", for episode 1 of "Heiress".
STEM = "Heiress - Episode 01"
SAVED = f"saved {STEM}.mp4 ({len(VIDEO) / 1048576:.1f} MiB)"


def _url(name: str, expire: int | None = FRESH) -> str:
    query = f"?a=1988&expire={expire}" if expire is not None else "?a=1988"
    return f"{CDN}/{name}/{query}"


def _entry(codec: str, bitrate: int, *urls: str) -> dict[str, Any]:
    return {"Bitrate": bitrate, "CodecType": codec, "PlayAddr": {"UrlList": list(urls)}}


def _item(
    number: int,
    item_id: str,
    *urls: str,
    bitrate_info: list[dict[str, Any]] | None = None,
    free: bool = True,
) -> dict[str, Any]:
    """An item_list entry; `urls` go to `video.playAddr` (first) and h264 bitrateInfo entries."""
    entries = bitrate_info if bitrate_info is not None else []
    if urls and bitrate_info is None:
        entries = [_entry("h264", 1_000_000, *urls)]
    return {
        "id": item_id,
        "desc": f"Heiress | Episode {number}",
        "author": {"uniqueId": "muffindrama_us"},
        # 3 s: what VIDEO (the fixture) lasts, so the list and the file agree, as at the fake CDN
        "video": {"duration": 3, "playAddr": urls[0] if urls else "", "bitrateInfo": entries},
        "dramaInfo": {
            "dramaID": SERIES_ID,
            "dramaName": "Heiress",
            "DramaVideoData": {"EpisodeNumber": number, "isFree": free},
        },
    }


def _episode(number: int = 1, raw: dict[str, Any] | None = None, **overrides: Any) -> Episode:
    settings: dict[str, Any] = {
        "number": number,
        "item_id": f"76994000000000000{number:02d}",
        "title": f"Heiress | Episode {number}",
        "series_id": SERIES_ID,
        "series_name": "Heiress",
        "author": "muffindrama_us",
        "duration_s": 3,  # VIDEO lasts 3 s; a test about the duration check overrides it
        "raw": raw,
    }
    settings.update(overrides)
    return Episode(**settings)


def _list_payload(
    *items: dict[str, Any], has_more: bool = False, cursor: int = 0
) -> dict[str, Any]:
    return {"statusCode": 0, "itemList": list(items), "cursor": cursor, "hasMore": has_more}


# --- a fake Playwright object graph -------------------------------------------------------------


class FakeAPIResponse:
    def __init__(
        self,
        status: int = 200,
        body: bytes = VIDEO,
        content_type: str | None = "video/mp4",
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status = status
        self._body = body
        self.headers = {"content-type": content_type} if content_type is not None else {}
        self.headers.update(headers or {})  # e.g. a content-length that does not match the body
        self.disposed = False

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def body(self) -> bytes:
        return self._body

    def dispose(self) -> None:
        self.disposed = True


class FakeRequest:
    """`context.request`: answers queued per URL (popped in order), `default` otherwise."""

    def __init__(self) -> None:
        self.queues: dict[str, list[FakeAPIResponse | Exception]] = {}
        self.default: FakeAPIResponse | Exception = FakeAPIResponse()
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.responses: list[FakeAPIResponse] = []

    def answer(self, url: str, *outcomes: FakeAPIResponse | Exception) -> None:
        self.queues.setdefault(url, []).extend(outcomes)

    def get(self, url: str, **kwargs: Any) -> FakeAPIResponse:
        self.calls.append((url, kwargs))
        queue = self.queues.get(url)
        outcome = queue.pop(0) if queue else self.default
        if isinstance(outcome, Exception):
            raise outcome
        self.responses.append(outcome)
        return outcome

    @property
    def urls(self) -> list[str]:
        return [url for url, _ in self.calls]


class FakeResponseEvent:
    """What `page.on("response")` hands the discovery capture."""

    def __init__(self, url: str, payload: Any) -> None:
        self.url, self._payload = url, payload

    def json(self) -> Any:
        return self._payload


def _refresh_events(*items: dict[str, Any], has_more: bool = False) -> list[FakeResponseEvent]:
    """The responses a series page produces: the detail, then the first item_list page."""
    return [
        FakeResponseEvent(
            f"{BASE}/api/drama/detail/?dramaID={SERIES_ID}",
            {"dramaInfo": {"dramaName": "Heiress", "totalEpisode": len(items)}},
        ),
        FakeResponseEvent(
            f"{BASE}/api/drama/episode/item_list/?aid=1988&count=30&cursor=0&dramaID={SERIES_ID}"
            "&msToken=abc",
            _list_payload(*items, has_more=has_more, cursor=len(items)),
        ),
    ]


class FakeMouse:
    def wheel(self, dx: float, dy: float) -> None:
        pass


class FakePage:
    def __init__(self, browser: FakeBrowser, events: list[FakeResponseEvent]) -> None:
        self._browser = browser
        self._events = events
        self._handlers: list[Any] = []
        self.url = "about:blank"
        self.mouse = FakeMouse()
        self.closed = False
        self.visited: list[tuple[str, str | None, float | None]] = []
        self.evaluated: list[tuple[str, Any]] = []

    def on(self, event: str, handler: Any) -> None:
        assert event == "response"
        self._handlers.append(handler)

    def goto(self, url: str, wait_until: str | None = None, timeout: float | None = None) -> None:
        self.visited.append((url, wait_until, timeout))
        self.url = self._browser.final_url or url
        for event in self._events:
            for handler in self._handlers:
                handler(event)

    def wait_for_timeout(self, ms: float) -> None:
        time.sleep(min(ms, 20) / 1000)  # keep the discovery's polling loops from spinning hot

    def evaluate(self, expression: str, arg: Any = None) -> Any:
        self.evaluated.append((expression, arg))
        if expression == FETCH_JS:
            results = self._browser.fetch_results
            return results.pop(0) if results else {}
        return ""

    def title(self) -> str:
        return self._browser.page_title

    def close(self) -> None:
        self.closed = True


class FakeContext:
    def __init__(self, browser: FakeBrowser) -> None:
        self._browser = browser
        self.request = browser.request
        self.pages: list[FakePage] = []
        self.cookies: list[dict[str, Any]] = []
        self.add_cookies_calls = 0
        self.closed = False

    def new_page(self) -> FakePage:
        queue = self._browser.refresh_events
        page = FakePage(self._browser, queue.pop(0) if queue else [])
        self.pages.append(page)
        return page

    def add_cookies(self, cookies: list[dict[str, Any]]) -> None:
        self.add_cookies_calls += 1
        self.cookies = list(cookies)

    def close(self) -> None:
        self.closed = True


class FakeBrowser:
    version = "153.0.7300.1"

    def __init__(self) -> None:
        self.request = FakeRequest()
        self.refresh_events: list[list[FakeResponseEvent]] = []  # one list per page opened
        self.fetch_results: list[Any] = []  # answers to the discovery's in-page pagination
        self.final_url: str | None = None  # where goto "lands" (login redirects)
        self.page_title = "Fake"  # a captcha wall reads "Verify to continue"
        self.contexts: list[FakeContext] = []
        self.context_kwargs: dict[str, Any] = {}
        self.closed = False

    def new_context(self, **kwargs: Any) -> FakeContext:
        self.context_kwargs = kwargs
        context = FakeContext(self)
        self.contexts.append(context)
        return context

    def close(self) -> None:
        self.closed = True


class FakePlaywright:
    """`sync_playwright()` stand-in: a context manager; `chromium.launch` gives the browser."""

    def __init__(self, launch_error: Exception | None = None) -> None:
        self.browser = FakeBrowser()
        self.launch_error = launch_error
        self.launch_kwargs: dict[str, Any] = {}
        self.launches = 0
        self.entered = 0
        self.exited = 0
        self.chromium = self

    def __enter__(self) -> FakePlaywright:
        self.entered += 1
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.exited += 1

    def launch(self, **kwargs: Any) -> FakeBrowser:
        self.launches += 1
        self.launch_kwargs = kwargs
        if self.launch_error is not None:
            raise self.launch_error
        return self.browser

    @property
    def request(self) -> FakeRequest:
        return self.browser.request

    @property
    def context(self) -> FakeContext:
        return self.browser.contexts[0]


@pytest.fixture
def playwright() -> FakePlaywright:
    return FakePlaywright()


def _downloader(playwright: FakePlaywright, clock: Any = lambda: NOW) -> BrowserDownloader:
    return BrowserDownloader(playwright_factory=lambda: playwright, clock=clock)


def _options(tmp_path: Path, **overrides: Any) -> DownloadOptions:
    settings: dict[str, Any] = {
        "out_dir": tmp_path,
        "engine": "browser",
        "browser_executable": Path("/fake/chromium"),
    }
    settings.update(overrides)
    return DownloadOptions(**settings)


# --- no-network paths ---------------------------------------------------------------------------


def test_locked_existing_and_dry_run_never_start_a_browser(playwright, tmp_path):
    downloader = _downloader(playwright)
    options = _options(tmp_path)

    locked = _episode(5, _item(5, "7699400000000000005", free=False), lock_hints=("isFree=false",))
    result = downloader.download(locked, options)
    assert result.status is DownloadStatus.SKIPPED_LOCKED
    assert result.message == "looks locked: isFree=false"

    (tmp_path / f"{STEM}.mp4").write_bytes(b"old")
    (tmp_path / f"{STEM}.mp4.part").write_bytes(b"partial")  # in-progress files do not count
    result = downloader.download(_episode(1, _item(1, "1", _url("a"))), options)
    assert result.status is DownloadStatus.SKIPPED_EXISTS
    assert result.path == tmp_path / f"{STEM}.mp4"
    assert result.message == f"already exists: {STEM}.mp4"

    dry = _options(tmp_path / "other", dry_run=True)
    result = downloader.download(_episode(1, _item(1, "1", _url("a"))), dry)
    assert result.status is DownloadStatus.DRY_RUN
    assert result.message == f"would download from {CDN_HOST}"
    result = downloader.download(_episode(2, _item(2, "2", _url("b", int(NOW) - 5))), dry)
    assert result.message == f"would download from {CDN_HOST} (play url expired: fresh list first)"
    result = downloader.download(_episode(3, None), dry)
    assert result.status is DownloadStatus.DRY_RUN
    assert "no play url" in result.message
    locked_dry = downloader.download(locked, dry)
    assert locked_dry.status is DownloadStatus.SKIPPED_LOCKED

    assert playwright.launches == 0
    assert not downloader.browser_started
    assert playwright.request.calls == []
    downloader.close()  # nothing to close is fine
    assert playwright.exited == 0


def test_include_locked_tries_the_episode_like_any_other(playwright, tmp_path):
    item = _item(5, "7699400000000000005", _url("locked"), free=False)
    locked = _episode(5, item, lock_hints=("isFree=false",))
    result = _downloader(playwright).download(locked, _options(tmp_path, include_locked=True))
    assert result.status is DownloadStatus.DONE
    assert playwright.request.urls == [_url("locked")]


# --- the browser session ------------------------------------------------------------------------


def test_one_lazy_browser_and_one_context_serve_the_whole_run(playwright, tmp_path):
    downloader = _downloader(playwright)
    options = _options(tmp_path)
    first = downloader.download(_episode(1, _item(1, "1", _url("ep1"))), options)
    second = downloader.download(_episode(2, _item(2, "2", _url("ep2"))), options)

    assert (first.status, second.status) == (DownloadStatus.DONE, DownloadStatus.DONE)
    assert first.path == tmp_path / f"{STEM}.mp4"
    assert first.path.read_bytes() == VIDEO
    assert first.message == SAVED  # no cover_url on these episodes: no thumbnail, no mention
    assert second.path == tmp_path / "Heiress - Episode 02.mp4"
    assert not list(tmp_path.glob("*.part"))

    assert playwright.launches == 1 and playwright.entered == 1
    assert len(playwright.browser.contexts) == 1
    assert downloader.browser_started
    # Chromium with its default flags: nothing hides the automation.
    assert playwright.launch_kwargs == {"headless": True, "executable_path": "/fake/chromium"}
    assert "args" not in playwright.launch_kwargs
    user_agent = playwright.browser.context_kwargs["user_agent"]
    assert "Chrome/153.0.0.0" in user_agent and "Headless" not in user_agent
    assert playwright.browser.context_kwargs["locale"] == "en-US"
    assert playwright.browser.context_kwargs["viewport"] == {"width": 1280, "height": 900}
    assert playwright.context.add_cookies_calls == 0  # no cookies file given

    assert playwright.request.urls == [_url("ep1"), _url("ep2")]
    for _, kwargs in playwright.request.calls:
        assert kwargs == {
            "headers": {"Referer": "https://www.tiktok.com/", "Accept": "*/*"},
            "max_redirects": 5,
            "timeout": 120_000,
        }
    assert all(response.disposed for response in playwright.request.responses)
    assert playwright.context.pages == []  # no refresh was needed


def test_channel_headful_and_base_url_reach_the_browser(playwright, tmp_path):
    options = _options(
        tmp_path,
        browser_executable=None,
        browser_channel="chrome",
        browser_headful=True,
        base_url="http://127.0.0.1:8123/",
    )
    result = _downloader(playwright).download(_episode(1, _item(1, "1", _url("ep1"))), options)
    assert result.status is DownloadStatus.DONE
    assert playwright.launch_kwargs == {"headless": False, "channel": "chrome"}
    assert playwright.request.calls[0][1]["headers"]["Referer"] == "http://127.0.0.1:8123/"


def _cookies_txt(tmp_path: Path, domain: str = ".tiktok.com") -> Path:
    path = tmp_path / "cookies.txt"
    expires = int(time.time()) + 86_400
    path.write_text(
        "# Netscape HTTP Cookie File\n"
        f"#HttpOnly_{domain}\tTRUE\t/\tTRUE\t{expires}\tsessionid\t{SESSION_VALUE}\n"
        f"{domain}\tTRUE\t/\tTRUE\t0\ttt_csrf_token\tcsrf-value\n",
        encoding="utf-8",
    )
    return path


def test_cookies_file_goes_into_the_context_only(playwright, tmp_path):
    options = _options(tmp_path, cookies_file=_cookies_txt(tmp_path))
    playwright.request.answer(_url("ep1"), FakeAPIResponse(403))  # forces a refresh too
    playwright.browser.refresh_events = [
        _refresh_events(_item(1, "7699400000000000001", _url("x")))
    ]

    result = _downloader(playwright).download(_episode(1, _item(1, "1", _url("ep1"))), options)

    assert result.status is DownloadStatus.DONE
    assert playwright.context.add_cookies_calls == 1
    assert [c["name"] for c in playwright.context.cookies] == ["sessionid", "tt_csrf_token"]
    assert playwright.context.cookies[0]["value"] == SESSION_VALUE  # Playwright gets the value...
    assert SESSION_VALUE not in result.message  # ...and nothing else does
    assert SESSION_VALUE not in repr(
        playwright.request.calls
    )  # context.request carries cookies itself
    assert SESSION_VALUE not in repr(playwright.context.pages[0].visited)


def test_cookies_file_problems_are_reported_without_values(playwright, tmp_path, caplog):
    other_domain = _options(tmp_path, cookies_file=_cookies_txt(tmp_path, domain=".example.com"))
    with caplog.at_level("WARNING", logger="dramafetch.downloader_browser"):
        result = _downloader(playwright).download(
            _episode(1, _item(1, "1", _url("a"))), other_domain
        )
    assert result.status is DownloadStatus.DONE  # no cookie for tiktok.com: download anyway
    assert playwright.context.add_cookies_calls == 0
    assert "no unexpired cookies for tiktok.com" in caplog.text
    assert SESSION_VALUE not in caplog.text

    junk = tmp_path / "junk.txt"
    junk.write_text(f"this is not a cookies file sessionid={SESSION_VALUE}\n", encoding="utf-8")
    second = FakePlaywright()
    result = _downloader(second).download(
        _episode(1, _item(1, "1", _url("a"))), _options(tmp_path / "fresh", cookies_file=junk)
    )
    assert result.status is DownloadStatus.FAILED
    assert result.message.startswith("could not start the browser: cookies file: ")
    assert "contains no cookies" in result.message
    assert SESSION_VALUE not in result.message
    assert second.exited == 1  # the half-open session was closed again


# --- candidates, expiry, refresh ----------------------------------------------------------------


def test_candidates_are_tried_in_catalog_order_until_one_plays(playwright, tmp_path):
    item = _item(
        1,
        "1",
        _url("play"),
        bitrate_info=[
            _entry("h265", 2_000_000, _url("h265")),
            _entry("h264", 500_000, _url("h264-lo")),
            _entry("avc1", 1_000_000, _url("h264-hi")),
        ],
    )
    playwright.request.answer(_url("h264-hi"), FakeAPIResponse(403, b"", "text/plain"))
    playwright.request.answer(_url("h264-lo"), FakeAPIResponse(404))
    playwright.request.answer(_url("h265"), FakeAPIResponse(410))

    result = _downloader(playwright).download(_episode(1, item), _options(tmp_path))

    assert result.status is DownloadStatus.DONE
    assert playwright.request.urls == [_url("h264-hi"), _url("h264-lo"), _url("h265"), _url("play")]
    assert playwright.context.pages == []  # a later candidate worked: no refresh


def test_expired_or_nearly_expired_urls_are_skipped_without_a_request(playwright, tmp_path):
    item = _item(
        1,
        "1",
        bitrate_info=[
            _entry("h264", 3_000_000, _url("expired", int(NOW) - 10)),
            _entry("h264", 2_000_000, _url("soon", int(NOW) + EXPIRY_MARGIN_S - 1)),
            _entry("h264", 1_000_000, _url("fresh", int(NOW) + EXPIRY_MARGIN_S + 1)),
            _entry("h264", 500_000, _url("forever", None)),
        ],
    )
    result = _downloader(playwright).download(_episode(1, item), _options(tmp_path))
    assert result.status is DownloadStatus.DONE
    assert playwright.request.urls == [_url("fresh", int(NOW) + EXPIRY_MARGIN_S + 1)]


def test_denied_candidates_lead_to_one_refresh_inside_the_session(playwright, tmp_path):
    episode = _episode(1, _item(1, "7699400000000000001", _url("old")))
    playwright.request.answer(_url("old"), FakeAPIResponse(403))
    fresh_item = _item(1, "7699400000000000001", _url("new"))
    playwright.browser.refresh_events = [
        _refresh_events(fresh_item, _item(2, "7699400000000000002"))
    ]
    downloader = _downloader(playwright)

    result = downloader.download(episode, _options(tmp_path, base_url="http://127.0.0.1:9"))

    assert result.status is DownloadStatus.DONE
    assert playwright.request.urls == [_url("old"), _url("new")]
    assert downloader.refreshes == 1
    (page,) = playwright.context.pages
    assert page.visited == [
        (f"http://127.0.0.1:9/shortdrama/episode/{SERIES_ID}/1", "domcontentloaded", 45_000)
    ]
    assert page.closed
    assert episode.raw is fresh_item  # the episode now carries the fresh item


def test_no_usable_url_refreshes_first_and_the_fresh_list_is_cached_for_the_run(
    playwright, tmp_path
):
    expired = int(NOW) - 100
    episodes = [
        _episode(1, _item(1, "7699400000000000001", _url("e1", expired))),
        _episode(2, _item(2, "7699400000000000002", _url("e2", expired))),
        _episode(3, _item(3, "7699400000000000003", _url("e3", expired))),
    ]
    first_refresh = _refresh_events(
        _item(1, "7699400000000000001", _url("f1")),
        _item(2, "7699400000000000002", _url("f2")),
        _item(3, "7699400000000000003", _url("f3", expired)),  # still stale after the refresh
    )
    second_refresh = _refresh_events(_item(3, "7699400000000000003", _url("g3")))
    playwright.browser.refresh_events = [first_refresh, second_refresh]
    downloader = _downloader(playwright)
    options = _options(tmp_path)

    results = [downloader.download(episode, options) for episode in episodes]

    assert [r.status for r in results] == [DownloadStatus.DONE] * 3
    assert playwright.request.urls == [_url("f1"), _url("f2"), _url("g3")]
    assert downloader.refreshes == 2  # episode 2 came from the cache; episode 3 needed a new list
    assert len(playwright.context.pages) == 2
    assert [p.visited[0][0].rsplit("/", 1)[1] for p in playwright.context.pages] == ["1", "3"]


def test_episode_missing_from_the_fresh_list_is_unavailable(playwright, tmp_path):
    playwright.browser.refresh_events = [
        _refresh_events(_item(2, "7699400000000000002", _url("x")))
    ]
    result = _downloader(playwright).download(_episode(1, None), _options(tmp_path))
    assert result.status is DownloadStatus.FAILED_UNAVAILABLE
    assert result.message == (
        "no playable stream: locked, region-restricted or not logged in "
        "(no play url, even in a fresh episode list)"
    )
    assert playwright.request.calls == []


def test_the_fresh_list_is_final_for_episodes_it_carries_without_a_play_url(playwright, tmp_path):
    """Three locked episodes tried with --include-locked: the fresh list says they have no play
    URL, and one more page load would not add one, so the run refreshes once, not once per
    episode; an episode the fresh list does not carry at all is final in the same way."""
    numbers = (6, 7, 8)
    locked_items = {n: _item(n, f"769940000000000000{n}", free=False) for n in numbers}
    playwright.browser.refresh_events = [
        _refresh_events(*locked_items.values()) for _ in range(len(numbers) + 1)
    ]
    downloader = _downloader(playwright)
    options = _options(tmp_path, include_locked=True)

    results = [
        downloader.download(_episode(n, locked_items[n], lock_hints=("isFree=false",)), options)
        for n in numbers
    ]

    assert [r.status for r in results] == [DownloadStatus.FAILED_UNAVAILABLE] * 3
    assert all(r.message.endswith("(no play url, even in a fresh episode list)") for r in results)
    assert downloader.refreshes == 1
    assert len(playwright.context.pages) == 1
    assert playwright.request.calls == []

    missing = downloader.download(_episode(9, None), options)
    assert missing.status is DownloadStatus.FAILED_UNAVAILABLE
    assert downloader.refreshes == 1  # not in the fresh list: another page load would not list it


def test_at_most_four_requests_per_episode_over_both_lists(playwright, tmp_path):
    """Twelve mirrors all answering 403 are not twelve requests: the budget stops the episode
    after MAX_GETS_PER_EPISODE, and a fresh list is only fetched while there is budget left to
    try it."""
    mirrors = [_url(f"mirror{i}") for i in range(12)]
    item = _item(
        1,
        "7699400000000000001",
        bitrate_info=[_entry("h264", 1000 - i, url) for i, url in enumerate(mirrors)],
    )
    for url in mirrors:
        playwright.request.answer(url, FakeAPIResponse(403, b"", "text/plain"))
    playwright.browser.refresh_events = [
        _refresh_events(_item(1, "7699400000000000001", _url("fresh")))
    ]
    downloader = _downloader(playwright)

    result = downloader.download(_episode(1, item), _options(tmp_path))

    assert MAX_GETS_PER_EPISODE == 4
    assert result.status is DownloadStatus.FAILED_UNAVAILABLE
    assert result.message.endswith(f"(HTTP 403 from {CDN_HOST})")
    assert playwright.request.urls == mirrors[:4]
    assert downloader.refreshes == 0 and playwright.context.pages == []

    # two denied URLs leave room for the fresh list: 2 + 2 requests and one refresh
    second = FakePlaywright()
    pair = [_url("p1"), _url("p2")]
    for url in pair:
        second.request.answer(url, FakeAPIResponse(403))
    fresh = [_url(f"f{i}") for i in range(5)]
    for url in fresh:
        second.request.answer(url, FakeAPIResponse(404))
    second.browser.refresh_events = [
        _refresh_events(
            _item(
                1,
                "7699400000000000001",
                bitrate_info=[_entry("h264", 10 - i, url) for i, url in enumerate(fresh)],
            )
        )
    ]
    downloader = _downloader(second)
    first_list = _item(
        1,
        "7699400000000000001",
        bitrate_info=[_entry("h264", 2, pair[0]), _entry("h264", 1, pair[1])],
    )

    result = downloader.download(_episode(1, first_list), _options(tmp_path / "b"))

    assert result.status is DownloadStatus.FAILED_UNAVAILABLE
    assert result.message.endswith(f"(HTTP 404 from {CDN_HOST})")
    assert second.request.urls == pair + fresh[:2]
    assert downloader.refreshes == 1


def test_still_denied_after_the_refresh_is_unavailable_with_the_last_answer(playwright, tmp_path):
    playwright.request.answer(_url("old"), FakeAPIResponse(403))
    playwright.request.answer(_url("new"), FakeAPIResponse(404))
    playwright.browser.refresh_events = [
        _refresh_events(_item(1, "7699400000000000001", _url("new")))
    ]
    downloader = _downloader(playwright)

    result = downloader.download(
        _episode(1, _item(1, "7699400000000000001", _url("old"))), _options(tmp_path)
    )

    assert result.status is DownloadStatus.FAILED_UNAVAILABLE
    assert result.message == (
        f"no playable stream: locked, region-restricted or not logged in (HTTP 404 from {CDN_HOST})"
    )
    assert playwright.request.urls == [_url("old"), _url("new")]
    assert downloader.refreshes == 1  # at most one refresh per episode
    assert not list(tmp_path.iterdir())


def test_a_refresh_that_returns_the_same_url_does_not_request_it_again(playwright, tmp_path):
    playwright.request.answer(_url("same"), FakeAPIResponse(403))
    playwright.browser.refresh_events = [
        _refresh_events(_item(1, "7699400000000000001", _url("same")))
    ]

    result = _downloader(playwright).download(
        _episode(1, _item(1, "7699400000000000001", _url("same"))), _options(tmp_path)
    )

    assert result.status is DownloadStatus.FAILED_UNAVAILABLE
    assert f"(HTTP 403 from {CDN_HOST})" in result.message
    assert playwright.request.urls == [_url("same")]


def test_http_429_stops_at_once_as_rate_limited(playwright, tmp_path):
    item = _item(
        1, "1", _url("a"), bitrate_info=[_entry("h264", 1, _url("a")), _entry("h264", 0, _url("b"))]
    )
    playwright.request.answer(
        _url("a"), FakeAPIResponse(429, b'{"statusCode": 429}', "application/json")
    )

    result = _downloader(playwright).download(_episode(1, item), _options(tmp_path))

    assert result.status is DownloadStatus.FAILED_RATE_LIMITED
    assert result.message == (
        "rate limited (HTTP 429) by the video server: wait 30-60 minutes before trying again"
    )
    assert playwright.request.urls == [_url("a")]  # no second candidate, no refresh
    assert playwright.context.pages == []


@pytest.mark.parametrize(
    ("response", "reason"),
    [
        (
            FakeAPIResponse(200, b"<html>Access Denied</html>", "text/html; charset=utf-8"),
            "26 bytes of text/html instead of a video",
        ),
        (
            FakeAPIResponse(200, b'{"statusCode": 10204}', "application/json"),
            "21 bytes of application/json instead of a video",
        ),
        (
            FakeAPIResponse(200, b"x" * (MIN_VIDEO_BYTES - 1), "video/mp4"),
            "64.0 KiB of video/mp4 instead of a video",
        ),
        (
            FakeAPIResponse(200, b"<html>" + b"x" * MIN_VIDEO_BYTES, "text/html"),
            "text/html instead of a video",
        ),
        (FakeAPIResponse(200, b"x" * MIN_VIDEO_BYTES, None), "an untyped body instead of a video"),
    ],
)
def test_bodies_that_are_not_videos_are_unavailable_and_write_nothing(
    playwright, tmp_path, response, reason
):
    playwright.request.answer(_url("a"), response)
    playwright.browser.refresh_events = [
        _refresh_events(_item(1, "7699400000000000001", _url("a")))
    ]

    result = _downloader(playwright).download(
        _episode(1, _item(1, "7699400000000000001", _url("a"))), _options(tmp_path)
    )

    assert result.status is DownloadStatus.FAILED_UNAVAILABLE
    assert result.message.endswith(f"({reason} from {CDN_HOST})")
    assert not list(tmp_path.iterdir())
    assert response.disposed


def test_large_bodies_count_as_video_by_type_or_by_magic(playwright, tmp_path):
    playwright.request.answer(
        _url("a"), FakeAPIResponse(200, b"x" * MIN_VIDEO_BYTES, "application/octet-stream")
    )
    playwright.request.answer(
        _url("b"), FakeAPIResponse(200, VIDEO, "text/plain")
    )  # MP4 bytes, odd type
    playwright.request.answer(
        _url("c"), FakeAPIResponse(200, b"x" * MIN_VIDEO_BYTES, "Video/MP4; codecs=avc1")
    )
    # what counts as a video BODY is one thing; whether the saved file is a sound MP4 is the
    # verification's (tested below), switched off here because `x` bytes are no MP4
    options = _options(tmp_path, verify=False)
    downloader = _downloader(playwright)
    for number, name in ((1, "a"), (2, "b"), (3, "c")):
        result = downloader.download(
            _episode(number, _item(number, str(number), _url(name))), options
        )
        assert result.status is DownloadStatus.DONE, name
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "Heiress - Episode 01.mp4",
        "Heiress - Episode 02.mp4",
        "Heiress - Episode 03.mp4",
    ]


def test_the_name_format_of_the_run_decides_the_file_name(playwright, tmp_path):
    options = _options(
        tmp_path, name_format="{series} - Episode {n} - {title}", series_name="From the run"
    )
    result = _downloader(playwright).download(_episode(1, _item(1, "1", _url("a"))), options)
    assert result.status is DownloadStatus.DONE
    assert result.path == tmp_path / "From the run - Episode 1 - Heiress Episode 1.mp4"
    skipped = _downloader(playwright).download(_episode(1, _item(1, "1", _url("a"))), options)
    assert skipped.status is DownloadStatus.SKIPPED_EXISTS  # found again under the same format


def test_unexpected_statuses_fail_at_once_without_the_unavailable_label(playwright, tmp_path):
    """A 5xx is the server failing, not this URL being refused: no next mirror, no fresh list."""
    item = _item(
        1,
        "7699400000000000001",
        _url("a"),
        bitrate_info=[_entry("h264", 2, _url("a")), _entry("h264", 1, _url("b"))],
    )
    playwright.request.answer(_url("a"), FakeAPIResponse(503, b"busy", "text/plain"))
    playwright.browser.refresh_events = [
        _refresh_events(_item(1, "7699400000000000001", _url("c")))
    ]
    downloader = _downloader(playwright)

    result = downloader.download(_episode(1, item), _options(tmp_path))

    assert result.status is DownloadStatus.FAILED
    assert result.message == f"download failed: HTTP 503 from {CDN_HOST}"
    assert playwright.request.urls == [_url("a")]
    assert downloader.refreshes == 0 and playwright.context.pages == []
    assert all(response.disposed for response in playwright.request.responses)


# --- the cover (thumbnail) ----------------------------------------------------------------------

COVER_HOST = "p16-sign-sg.tiktokcdn.com"
COVER = (
    f"https://{COVER_HOST}/tos-alisg-p-0037/abc~tplv-tiktokx-origin.jpeg"
    "?x-expires=1800000000&x-signature=SIGNATURETOKEN"
)
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"j" * 600
PNG = b"\x89PNG\r\n\x1a\n" + b"p" * 600
WEBP = b"RIFF\x00\x10\x00\x00WEBPVP8 " + b"w" * 600


def _with_cover(number: int = 1, cover: str | None = COVER) -> Episode:
    item_id = f"76994000000000000{number:02d}"
    return _episode(number, _item(number, item_id, _url(f"ep{number}")), cover_url=cover)


def test_the_cover_is_fetched_once_after_the_video_and_embedded_into_it(playwright, tmp_path):
    playwright.request.answer(COVER, FakeAPIResponse(200, JPEG, "image/jpeg"))
    downloader = _downloader(playwright)

    result = downloader.download(_with_cover(), _options(tmp_path))

    assert result.status is DownloadStatus.DONE
    assert result.path == tmp_path / f"{STEM}.mp4"
    assert result.message == f"{SAVED} + cover embedded"
    assert extract_cover(result.path) == (JPEG, "image/jpeg")
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"{STEM}.mp4"]  # no sidecar, no .part
    assert playwright.request.urls == [_url("ep1"), COVER]  # the video first, then the cover
    _, kwargs = playwright.request.calls[1]
    assert kwargs == {
        "headers": {"Referer": "https://www.tiktok.com/", "Accept": "image/*,*/*"},
        "max_redirects": 5,
        "timeout": 120_000,
    }
    assert all(response.disposed for response in playwright.request.responses)
    assert downloader.refreshes == 0 and playwright.context.pages == []
    assert MAX_COVER_GETS == 1 and MIN_IMAGE_BYTES == 200


@pytest.mark.parametrize(
    ("body", "content_type", "extension"),
    [
        (JPEG, "image/jpeg", ".jpg"),
        (JPEG, "Image/JPEG; charset=binary", ".jpg"),
        (JPEG, "image/jpg", ".jpg"),
        (PNG, "image/png", ".png"),
        (WEBP, "image/webp", ".webp"),
        (PNG, "application/octet-stream", ".png"),  # the type says nothing: the magic decides
        (WEBP, None, ".webp"),
        (JPEG, "text/plain", ".jpg"),
        (PNG, "image/jpeg", ".png"),  # a conflict: the bytes win
        (b"i" * 600, "image/avif", ".jpg"),  # an image type without known magic: .jpg
    ],
)
def test_cover_extension_from_the_magic_then_the_content_type(
    playwright, tmp_path, body, content_type, extension
):
    playwright.request.answer(COVER, FakeAPIResponse(200, body, content_type))
    result = _downloader(playwright).download(_with_cover(), _options(tmp_path, thumbnail="file"))
    assert result.status is DownloadStatus.DONE
    assert result.message == f"{SAVED} + cover file"
    assert (tmp_path / f"{STEM}{extension}").read_bytes() == body
    assert not list(tmp_path.glob("*.part"))
    assert result.path.read_bytes() == VIDEO  # mode file: nothing embedded


@pytest.mark.parametrize(
    ("response", "reason"),
    [
        (FakeAPIResponse(404, b"", "text/plain"), f"HTTP 404 from {COVER_HOST}"),
        (FakeAPIResponse(403, b"denied", "text/html"), f"HTTP 403 from {COVER_HOST}"),
        (FakeAPIResponse(503, b"busy", "text/plain"), f"HTTP 503 from {COVER_HOST}"),
        (
            FakeAPIResponse(200, b"<html>no</html>", "text/html"),
            f"15 bytes of text/html instead of an image from {COVER_HOST}",
        ),
        (
            FakeAPIResponse(200, b"x" * (MIN_IMAGE_BYTES - 1), "image/jpeg"),
            f"199 bytes of image/jpeg instead of an image from {COVER_HOST}",
        ),
        (
            FakeAPIResponse(200, b"<html>" + b"x" * 600, "text/html"),
            f"text/html instead of an image from {COVER_HOST}",
        ),
        (
            FakeAPIResponse(200, b"x" * 600, None),
            f"an untyped body instead of an image from {COVER_HOST}",
        ),
        (
            RuntimeError(f"apiRequestContext.get: boom; Cookie: sessionid={SESSION_VALUE}"),
            "apiRequestContext.get: boom; Cookie=<redacted>",
        ),
    ],
)
def test_a_cover_that_cannot_be_had_never_changes_the_status(
    playwright, tmp_path, caplog, response, reason
):
    playwright.request.answer(COVER, response)
    with caplog.at_level("DEBUG", logger="dramafetch.downloader_browser"):
        result = _downloader(playwright).download(_with_cover(), _options(tmp_path))

    assert result.status is DownloadStatus.DONE
    assert result.path == tmp_path / f"{STEM}.mp4"
    assert result.message == f"{SAVED}; cover: {reason}"
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"{STEM}.mp4"]  # no sidecar, no .part
    assert result.path.read_bytes() == VIDEO  # nothing embedded either
    assert playwright.request.urls == [_url("ep1"), COVER]  # one attempt, no second try
    for secret in (SESSION_VALUE, "SIGNATURETOKEN"):
        assert secret not in result.message and secret not in caplog.text
    assert COVER_HOST in caplog.text  # the host is all a log line says about the cover


def test_a_rate_limited_cover_is_a_warning_not_a_stop(playwright, tmp_path, caplog):
    """A 429 on the cover is reported like any other refusal, at WARNING: the video came through,
    and if TikTok is really limiting, the next VIDEO request stops the run as usual."""
    playwright.request.answer(
        COVER,
        FakeAPIResponse(429, b'{"statusCode": 429}', "application/json"),
        FakeAPIResponse(200, JPEG, "image/jpeg"),
    )
    downloader = _downloader(playwright)
    options = _options(tmp_path)

    with caplog.at_level("WARNING", logger="dramafetch.downloader_browser"):
        first = downloader.download(_with_cover(1), options)
    second = downloader.download(_with_cover(2), options)

    assert first.status is DownloadStatus.DONE
    assert first.message == f"{SAVED}; cover: HTTP 429 from {COVER_HOST}"
    assert f"HTTP 429 for the cover from {COVER_HOST}" in caplog.text
    assert "SIGNATURETOKEN" not in caplog.text
    assert second.status is DownloadStatus.DONE and second.message.endswith(" + cover embedded")
    assert playwright.request.urls == [_url("ep1"), COVER, _url("ep2"), COVER]
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "Heiress - Episode 01.mp4",
        "Heiress - Episode 02.mp4",
    ]
    assert extract_cover(first.path) is None and extract_cover(second.path) == (JPEG, "image/jpeg")


def test_the_cover_request_is_outside_the_media_budget(playwright, tmp_path):
    """Three denied mirrors and a fourth that plays spend the whole media budget; the cover is
    still fetched — it is not a media request — and the episode is DONE with its thumbnail."""
    mirrors = [_url(f"m{i}") for i in range(MAX_GETS_PER_EPISODE)]
    item = _item(
        1,
        "7699400000000000001",
        bitrate_info=[_entry("h264", 10 - i, url) for i, url in enumerate(mirrors)],
    )
    for url in mirrors[:-1]:
        playwright.request.answer(url, FakeAPIResponse(403, b"", "text/plain"))
    playwright.request.answer(COVER, FakeAPIResponse(200, JPEG, "image/jpeg"))
    downloader = _downloader(playwright)

    result = downloader.download(_episode(1, item, cover_url=COVER), _options(tmp_path))

    assert result.status is DownloadStatus.DONE
    assert result.message.endswith(" + cover embedded")
    assert playwright.request.urls == [*mirrors, COVER]
    assert len(playwright.request.urls) == MAX_GETS_PER_EPISODE + MAX_COVER_GETS
    assert extract_cover(result.path) == (JPEG, "image/jpeg")
    assert downloader.refreshes == 0


def test_no_cover_request_in_mode_none_without_a_cover_url_or_without_a_video(playwright, tmp_path):
    downloader = _downloader(playwright)

    off = downloader.download(_with_cover(1), _options(tmp_path, thumbnail="none"))
    assert off.status is DownloadStatus.DONE
    assert off.message == SAVED
    assert playwright.request.urls == [_url("ep1")]
    assert off.path.read_bytes() == VIDEO

    none = downloader.download(_with_cover(2, cover=None), _options(tmp_path))
    assert none.status is DownloadStatus.DONE and "cover" not in none.message
    assert playwright.request.urls == [_url("ep1"), _url("ep2")]

    # a failed video never asks for its cover ...
    playwright.request.answer(_url("ep3"), FakeAPIResponse(503, b"busy", "text/plain"))
    failed = downloader.download(_with_cover(3), _options(tmp_path))
    assert failed.status is DownloadStatus.FAILED and "cover" not in failed.message
    assert playwright.request.urls == [_url("ep1"), _url("ep2"), _url("ep3")]

    # ... and neither does an episode skipped for its existing video: a missing cover stays missing
    skipped = downloader.download(_with_cover(1), _options(tmp_path))
    assert skipped.status is DownloadStatus.SKIPPED_EXISTS
    assert playwright.request.urls == [_url("ep1"), _url("ep2"), _url("ep3")]
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "Heiress - Episode 01.mp4",
        "Heiress - Episode 02.mp4",
    ]


def test_dry_run_announces_the_cover_when_one_would_be_fetched(playwright, tmp_path):
    downloader = _downloader(playwright)
    dry = _options(tmp_path, dry_run=True)
    message = downloader.download(_with_cover(1), dry).message
    assert message == f"would download from {CDN_HOST} + cover"
    assert downloader.download(_with_cover(2, cover=None), dry).message == (
        f"would download from {CDN_HOST}"
    )
    for mode in ("both", "file"):
        with_cover = _options(tmp_path, dry_run=True, thumbnail=mode)
        assert downloader.download(_with_cover(1), with_cover).message.endswith(" + cover")
    off = _options(tmp_path, dry_run=True, thumbnail="none")
    assert downloader.download(_with_cover(1), off).message == f"would download from {CDN_HOST}"
    expired = _episode(3, _item(3, "3", _url("c", int(NOW) - 5)), cover_url=COVER)
    assert downloader.download(expired, dry).message == (
        f"would download from {CDN_HOST} (play url expired: fresh list first) + cover"
    )
    no_url = _episode(4, None, cover_url=COVER)
    assert downloader.download(no_url, dry).message.endswith(
        "(it would be refreshed first) + cover"
    )
    assert playwright.launches == 0 and playwright.request.calls == []
    assert not (tmp_path / f"{STEM}.jpg").exists()


def test_the_cover_is_written_as_part_then_renamed(playwright, tmp_path, monkeypatch):
    replaced: list[tuple[Path, Path]] = []
    original = Path.replace

    def recording_replace(self: Path, target: Path) -> Path:
        replaced.append((Path(self), Path(target)))
        return original(self, target)

    monkeypatch.setattr(Path, "replace", recording_replace)
    playwright.request.answer(COVER, FakeAPIResponse(200, JPEG, "image/jpeg"))
    playwright.request.answer(COVER, FakeAPIResponse(200, JPEG, "image/jpeg"))
    downloader = _downloader(playwright)

    result = downloader.download(_with_cover(1), _options(tmp_path, thumbnail="file"))
    assert result.status is DownloadStatus.DONE
    assert replaced == [
        (tmp_path / f"{STEM}.mp4.part", tmp_path / f"{STEM}.mp4"),
        (tmp_path / f"{STEM}.jpg.part", tmp_path / f"{STEM}.jpg"),
    ]

    # embedding edits a copy of the video and renames it over the original: never in place
    replaced.clear()
    embedded = downloader.download(_with_cover(2), _options(tmp_path, thumbnail="both"))
    assert embedded.status is DownloadStatus.DONE
    assert replaced == [
        (tmp_path / "Heiress - Episode 02.mp4.part", tmp_path / "Heiress - Episode 02.mp4"),
        (tmp_path / "Heiress - Episode 02.mp4.embed.part", tmp_path / "Heiress - Episode 02.mp4"),
        (tmp_path / "Heiress - Episode 02.jpg.part", tmp_path / "Heiress - Episode 02.jpg"),
    ]


def test_a_failed_cover_write_leaves_no_partial_file_and_keeps_the_video(
    playwright, tmp_path, monkeypatch
):
    original = Path.replace

    def failing_for_images(self: Path, target: Path) -> Path:
        if self.name.endswith(".jpg.part"):
            raise OSError(28, "No space left on device")
        return original(self, target)

    monkeypatch.setattr(Path, "replace", failing_for_images)
    playwright.request.answer(COVER, FakeAPIResponse(200, JPEG, "image/jpeg"))

    result = _downloader(playwright).download(_with_cover(), _options(tmp_path, thumbnail="file"))

    assert result.status is DownloadStatus.DONE
    assert result.message == f"{SAVED}; cover: [Errno 28] No space left on device"
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"{STEM}.mp4"]


# --- the cover: modes ---------------------------------------------------------------------------


def test_both_embeds_the_cover_and_keeps_the_file(playwright, tmp_path):
    playwright.request.answer(COVER, FakeAPIResponse(200, JPEG, "image/jpeg"))
    result = _downloader(playwright).download(_with_cover(), _options(tmp_path, thumbnail="both"))
    assert result.status is DownloadStatus.DONE
    assert result.message == f"{SAVED} + cover embedded + file"
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"{STEM}.jpg", f"{STEM}.mp4"]
    assert (tmp_path / f"{STEM}.jpg").read_bytes() == JPEG
    assert extract_cover(result.path) == (JPEG, "image/jpeg")


def test_file_saves_the_sidecar_and_leaves_the_video_as_the_cdn_sent_it(playwright, tmp_path):
    playwright.request.answer(COVER, FakeAPIResponse(200, PNG, "image/png"))
    result = _downloader(playwright).download(_with_cover(), _options(tmp_path, thumbnail="file"))
    assert result.status is DownloadStatus.DONE
    assert result.message == f"{SAVED} + cover file"
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"{STEM}.mp4", f"{STEM}.png"]
    assert result.path.read_bytes() == VIDEO
    assert extract_cover(result.path) is None


def test_a_png_cover_is_embedded_as_png(playwright, tmp_path):
    playwright.request.answer(COVER, FakeAPIResponse(200, PNG, "image/png"))
    result = _downloader(playwright).download(_with_cover(), _options(tmp_path))
    assert result.message == f"{SAVED} + cover embedded"
    assert extract_cover(result.path) == (PNG, "image/png")
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"{STEM}.mp4"]


@pytest.mark.parametrize("mode", ["embed", "both"])
def test_a_webp_cover_is_saved_as_a_file_because_it_cannot_be_embedded(playwright, tmp_path, mode):
    playwright.request.answer(COVER, FakeAPIResponse(200, WEBP, "image/webp"))
    result = _downloader(playwright).download(_with_cover(), _options(tmp_path, thumbnail=mode))
    assert result.status is DownloadStatus.DONE
    assert result.message == f"{SAVED}; cover: webp cannot be embedded; saved as file"
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"{STEM}.mp4", f"{STEM}.webp"]
    assert (tmp_path / f"{STEM}.webp").read_bytes() == WEBP
    assert result.path.read_bytes() == VIDEO


@pytest.mark.parametrize("mode", ["embed", "both"])
def test_a_video_mutagen_cannot_tag_keeps_the_cover_as_a_file(playwright, tmp_path, mode):
    """With the verification off (`--no-verify`; on, such a body is quarantined before the cover
    step — see the integrity tests): the CDN body passed the video checks but is not an MP4
    mutagen can write to, so the cover is saved next to it instead, the video stays exactly as
    downloaded and no `.embed.part` is left."""
    not_an_mp4 = b"\x00\x00\x00\x18ftypmp42" + b"v" * (2 * MIN_VIDEO_BYTES)
    playwright.request.answer(_url("ep1"), FakeAPIResponse(200, not_an_mp4, "video/mp4"))
    playwright.request.answer(COVER, FakeAPIResponse(200, JPEG, "image/jpeg"))

    result = _downloader(playwright).download(
        _with_cover(), _options(tmp_path, thumbnail=mode, verify=False)
    )

    assert result.status is DownloadStatus.DONE
    saved = f"saved {STEM}.mp4 ({len(not_an_mp4) / 1048576:.1f} MiB)"
    assert result.message.startswith(
        f"{saved}; cover: could not embed (could not write the cover into {STEM}.mp4 "
        "(MP4StreamInfoError: "
    )
    assert result.message.endswith(")); saved as file")
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"{STEM}.jpg", f"{STEM}.mp4"]
    assert (tmp_path / f"{STEM}.jpg").read_bytes() == JPEG
    assert result.path.read_bytes() == not_an_mp4


def test_a_directory_in_the_way_of_the_working_copy_saves_the_cover_as_a_file(playwright, tmp_path):
    """The engine never raises: a directory named `<video>.embed.part` makes the embed a
    `ThumbnailError`, so the cover is saved next to the video and nothing is copied into it."""
    in_the_way = tmp_path / f"{STEM}.mp4{EMBED_SUFFIX}"
    in_the_way.mkdir()
    playwright.request.answer(COVER, FakeAPIResponse(200, JPEG, "image/jpeg"))
    result = _downloader(playwright).download(_with_cover(), _options(tmp_path))
    assert result.status is DownloadStatus.DONE
    assert result.message == (
        f"{SAVED}; cover: could not embed ({in_the_way.name} is a directory in the way of the "
        "working copy); saved as file"
    )
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        f"{STEM}.jpg",
        f"{STEM}.mp4",
        in_the_way.name,
    ]
    assert list(in_the_way.iterdir()) == [] and result.path.read_bytes() == VIDEO


def test_without_mutagen_the_cover_is_saved_as_a_file_and_the_message_says_so(
    playwright, tmp_path, monkeypatch
):
    monkeypatch.setitem(sys.modules, "mutagen.mp4", None)  # `import mutagen.mp4` now fails
    playwright.request.answer(COVER, FakeAPIResponse(200, JPEG, "image/jpeg"))
    result = _downloader(playwright).download(_with_cover(), _options(tmp_path))
    assert result.status is DownloadStatus.DONE
    assert result.message == (
        f"{SAVED}; cover: could not embed (mutagen is not installed: pip install mutagen); "
        "saved as file"
    )
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"{STEM}.jpg", f"{STEM}.mp4"]
    assert result.path.read_bytes() == VIDEO


@pytest.mark.parametrize("mode", ["embed", "both", "file"])
def test_an_oversize_cover_is_not_kept_in_any_mode(playwright, tmp_path, monkeypatch, mode):
    monkeypatch.setattr(downloader_browser, "MAX_COVER_BYTES", 1000)
    playwright.request.answer(COVER, FakeAPIResponse(200, JPEG + b"j" * 1000, "image/jpeg"))
    result = _downloader(playwright).download(_with_cover(), _options(tmp_path, thumbnail=mode))
    assert result.status is DownloadStatus.DONE
    assert result.message == f"{SAVED}; cover: too large, not kept"
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"{STEM}.mp4"]
    assert result.path.read_bytes() == VIDEO


# --- errors -------------------------------------------------------------------------------------


def test_exceptions_become_one_sanitised_line(playwright, tmp_path):
    error = RuntimeError(
        f"apiRequestContext.get: connection reset; Cookie: sessionid={SESSION_VALUE}; msToken=tok\n"
        "    at Request.get (playwright/_impl/_fetch.py:1)"
    )
    playwright.request.answer(_url("a"), error)
    playwright.request.answer(_url("b"), RuntimeError(""))
    downloader = _downloader(playwright)

    first = downloader.download(_episode(1, _item(1, "1", _url("a"))), _options(tmp_path))
    second = downloader.download(_episode(2, _item(2, "2", _url("b"))), _options(tmp_path))

    assert first.status is DownloadStatus.FAILED
    assert "\n" not in first.message
    # sanitize_error redacts from the first secret-like token on: the shape is not promised,
    # the absence of the values is
    assert first.message.startswith("apiRequestContext.get: connection reset; Cookie=<redacted>")
    assert SESSION_VALUE not in first.message
    assert "tok" not in first.message.split("msToken")[-1]
    assert second.status is DownloadStatus.FAILED
    assert second.message == "RuntimeError"
    assert downloader.browser_started  # the session survives a failed request


def test_playwrights_call_log_never_reaches_messages_manifest_or_logs(playwright, tmp_path, caplog):
    """A failed context.request.get() quotes the whole request below its first line — the signed
    URL and the cookie header. Neither value may survive, whichever line a message keeps."""
    signed = _url("a") + "&signature=SIGNATURETOKEN&tk=tt_chain_token"
    error = TimeoutError(
        "APIRequestContext.get: Timeout 120000ms exceeded.\n"
        "Call log:\n"
        f"  - → GET {signed}\n"
        "    - user-agent: Mozilla/5.0 (X11; Linux x86_64) Chrome/153.0.0.0\n"
        "    - accept: */*\n"
        "    - Referer: https://www.tiktok.com/\n"
        f"    - cookie: sessionid={SESSION_VALUE}\n"
    )
    playwright.request.answer(_url("a"), error)
    downloader = _downloader(playwright)

    with caplog.at_level("DEBUG"):
        result = downloader.download(_episode(1, _item(1, "1", _url("a"))), _options(tmp_path))
    manifest = Manifest(tmp_path / "dramafetch.json", SERIES_ID, "Heiress")
    manifest.record(result)
    written = (tmp_path / "dramafetch.json").read_text(encoding="utf-8")

    assert result.status is DownloadStatus.FAILED
    assert result.message == "APIRequestContext.get: Timeout 120000ms exceeded."
    for secret in (SESSION_VALUE, "SIGNATURETOKEN"):
        assert secret not in result.message
        assert secret not in written
        assert secret not in caplog.text
    # the redaction covers every line, not only the one the message keeps
    redacted = redact_secrets(str(error))
    assert SESSION_VALUE not in redacted and "SIGNATURETOKEN" not in redacted
    assert "cookie=<redacted>" in redacted
    assert f"GET {CDN}/a/\n" in redacted  # the signed URL survives as host and path only


def test_a_failed_launch_is_reported_once_and_not_retried(tmp_path):
    error = RuntimeError(
        "BrowserType.launch: Executable doesn't exist at /fake/chromium\n"
        "╔══════╗\n║ Looks like Playwright was just installed ║\n╚══════╝"
    )
    playwright = FakePlaywright(launch_error=error)
    downloader = _downloader(playwright)
    options = _options(tmp_path)

    first = downloader.download(_episode(1, _item(1, "1", _url("a"))), options)
    second = downloader.download(_episode(2, _item(2, "2", _url("b"))), options)

    assert first.status is second.status is DownloadStatus.FAILED
    assert first.message == second.message
    assert first.message.startswith(
        "could not start the browser: BrowserType.launch: Executable doesn't exist at /fake/chrom"
    )
    assert "playwright install chromium" in first.message and "\n" not in first.message
    assert playwright.launches == 1  # not retried for the second episode
    assert playwright.exited == 1  # the half-started Playwright was stopped
    assert not downloader.browser_started
    downloader.close()
    assert playwright.exited == 1


def test_refresh_login_redirect_is_a_login_failure(playwright, tmp_path):
    playwright.request.answer(_url("a"), FakeAPIResponse(403))
    playwright.browser.final_url = f"{BASE}/login?redirect_url=%2F"
    result = _downloader(playwright).download(
        _episode(1, _item(1, "1", _url("a"))), _options(tmp_path)
    )
    assert result.status is DownloadStatus.FAILED_LOGIN
    assert "login page" in result.message and "--cookies" in result.message


def test_a_captcha_wall_during_the_refresh_is_blocked_after_one_page_load(playwright, tmp_path):
    """TikTok's verification page instead of the series: the first sign of blocking, so the
    episode is FAILED_BLOCKED (the engine stops on it) with the --headful advice, after exactly
    one page load and no further request."""
    playwright.request.answer(_url("a"), FakeAPIResponse(403))
    playwright.browser.page_title = "Verify to continue"
    downloader = _downloader(playwright)
    options = _options(tmp_path)

    result = downloader.download(_episode(1, _item(1, "1", _url("a"))), options)

    assert result.status is DownloadStatus.FAILED_BLOCKED
    assert result.message.startswith("TikTok is asking for a verification (captcha)")
    assert "--headful" in result.message and "\n" not in result.message
    assert playwright.request.urls == [_url("a")]
    assert downloader.refreshes == 1 and len(playwright.context.pages) == 1
    assert playwright.context.pages[0].closed

    # the same wall when the episode had no usable URL to begin with (refresh first)
    expired = _episode(2, _item(2, "2", _url("b", int(NOW) - 5)))
    second = downloader.download(expired, options)
    assert second.status is DownloadStatus.FAILED_BLOCKED
    assert playwright.request.urls == [_url("a")]  # nothing else was requested


def test_the_engine_stops_at_the_first_captcha_wall_without_another_page_load(playwright, tmp_path):
    """Five episodes with expired URLs behind a captcha wall: one page load, no media request,
    no pause, every remaining episode stopped as failed-blocked, exit code 5."""
    expired = int(NOW) - 100
    episodes = [
        _episode(n, _item(n, f"769940000000000000{n}", _url(f"e{n}", expired))) for n in range(1, 6)
    ]
    series = Series(SERIES_ID, "Heiress", episodes)
    playwright.browser.page_title = "Verify to continue"
    downloader = _downloader(playwright)
    sleeps: list[float] = []

    results = engine.download_series(
        series, episodes, _options(tmp_path), downloader=downloader, sleep=sleeps.append
    )

    assert [r.status for r in results] == [DownloadStatus.FAILED_BLOCKED] * 5
    assert results[0].message.startswith("TikTok is asking for a verification (captcha)")
    stop = "stopped: episode 1 failed-blocked: TikTok is asking for a verification (captcha)"
    assert all(r.message.startswith(stop) for r in results[1:])
    assert downloader.refreshes == 1 and len(playwright.context.pages) == 1
    assert sleeps == [] and playwright.request.calls == []
    assert engine.exit_code(results) == 5
    assert playwright.exited == 1  # closed by the engine at the end of the run


def test_refresh_with_an_empty_list_is_a_login_failure(playwright, tmp_path):
    playwright.browser.refresh_events = [_refresh_events()]  # no items at all
    result = _downloader(playwright).download(_episode(1, None), _options(tmp_path))
    assert result.status is DownloadStatus.FAILED_LOGIN
    assert result.message.startswith("TikTok returned an empty episode list")


def test_refresh_rate_limited_on_pagination_is_rate_limited(playwright, tmp_path):
    playwright.browser.refresh_events = [_refresh_events(_item(2, "2", _url("x")), has_more=True)]
    playwright.browser.fetch_results = [{"__dramafetch_status": 429, "__dramafetch_text": "slow"}]
    result = _downloader(playwright).download(_episode(1, None), _options(tmp_path))
    assert result.status is DownloadStatus.FAILED_RATE_LIMITED
    assert "HTTP 429" in result.message


def test_refresh_failure_after_denied_urls_reports_both_reasons(playwright, tmp_path, monkeypatch):
    monkeypatch.setattr(downloader_browser, "REFRESH_TIMEOUT_S", 0.2)
    playwright.request.answer(_url("a"), FakeAPIResponse(403))
    # no refresh events: the series page never yields a list; with a cookies file that is a plain
    # discovery error (without one the discovery calls it a login problem)
    options = _options(tmp_path, cookies_file=_cookies_txt(tmp_path))

    result = _downloader(playwright).download(_episode(1, _item(1, "1", _url("a"))), options)

    assert result.status is DownloadStatus.FAILED
    assert result.message.startswith(
        f"HTTP 403 from {CDN_HOST}; refreshing the episode list failed: no episode list within 0.2"
    )
    assert SESSION_VALUE not in result.message


# --- files and close() --------------------------------------------------------------------------


def test_the_file_is_written_as_part_then_renamed(playwright, tmp_path, monkeypatch):
    replaced: list[tuple[Path, Path]] = []
    original = Path.replace

    def recording_replace(self: Path, target: Path) -> Path:
        replaced.append((Path(self), Path(target)))
        assert self.exists() and self.read_bytes() == VIDEO  # fully written before the rename
        return original(self, target)

    monkeypatch.setattr(Path, "replace", recording_replace)
    out_dir = tmp_path / "series"  # created on demand
    result = _downloader(playwright).download(
        _episode(1, _item(1, "1", _url("a"))), _options(out_dir)
    )

    assert result.status is DownloadStatus.DONE
    assert replaced == [(out_dir / f"{STEM}.mp4.part", out_dir / f"{STEM}.mp4")]
    assert sorted(p.name for p in out_dir.iterdir()) == [f"{STEM}.mp4"]


def test_a_failed_rename_leaves_no_partial_file(playwright, tmp_path, monkeypatch):
    def failing_replace(self: Path, target: Path) -> Path:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(Path, "replace", failing_replace)
    result = _downloader(playwright).download(
        _episode(1, _item(1, "1", _url("a"))), _options(tmp_path)
    )
    assert result.status is DownloadStatus.FAILED
    assert result.message == "[Errno 28] No space left on device"
    assert not list(tmp_path.iterdir())


def test_close_closes_everything_once_and_a_later_download_starts_afresh(playwright, tmp_path):
    downloader = _downloader(playwright)
    options = _options(tmp_path)
    assert (
        downloader.download(_episode(1, _item(1, "1", _url("a"))), options).status
        is DownloadStatus.DONE
    )

    downloader.close()
    assert playwright.context.closed and playwright.browser.closed and playwright.exited == 1
    assert not downloader.browser_started
    downloader.close()
    assert playwright.exited == 1  # idempotent

    assert (
        downloader.download(_episode(2, _item(2, "2", _url("b"))), options).status
        is DownloadStatus.DONE
    )
    assert playwright.launches == 2 and playwright.entered == 2
    downloader.close()
    assert playwright.exited == 2


def test_context_manager_form_closes_on_exit(playwright, tmp_path):
    with _downloader(playwright) as downloader:
        result = downloader.download(_episode(1, _item(1, "1", _url("a"))), _options(tmp_path))
    assert result.status is DownloadStatus.DONE
    assert playwright.context.closed and playwright.browser.closed and playwright.exited == 1


def test_close_survives_a_failing_browser(playwright, tmp_path, caplog):
    downloader = _downloader(playwright)
    downloader.download(_episode(1, _item(1, "1", _url("a"))), _options(tmp_path))

    def boom() -> None:
        raise RuntimeError(f"Target closed; sessionid={SESSION_VALUE}")

    playwright.browser.close = boom  # type: ignore[method-assign]
    with caplog.at_level("DEBUG", logger="dramafetch.downloader_browser"):
        downloader.close()  # does not raise
    assert playwright.context.closed and playwright.exited == 1  # the other steps still ran
    assert SESSION_VALUE not in caplog.text


# --- integrity: truncation, verification, quarantine; the quality order ------------------------

ITEM_1 = "7699400000000000001"


def test_a_body_shorter_than_the_content_length_fails_without_a_next_mirror_or_a_refresh(
    playwright, tmp_path
):
    """A truncation is the network's doing, not the URL's: the episode fails at once — the
    second mirror is not tried, no fresh list is fetched, nothing is written."""
    announced = len(VIDEO) + 4096
    short = FakeAPIResponse(headers={"content-length": str(announced)})
    playwright.request.answer(_url("a"), short)
    playwright.request.answer(_url("b"), FakeAPIResponse())  # a mirror that would have worked
    item = _item(1, ITEM_1, _url("a"), _url("b"))
    playwright.browser.refresh_events = [_refresh_events(item)]
    downloader = _downloader(playwright)

    result = downloader.download(_episode(1, item), _options(tmp_path))

    assert result.status is DownloadStatus.FAILED and result.path is None
    assert result.message == (
        f"{INCOMPLETE_PREFIX}truncated body ({len(VIDEO)} of {announced} bytes) from {CDN_HOST}"
    )
    assert playwright.request.urls == [_url("a")]
    assert downloader.refreshes == 0 and playwright.context.pages == []
    assert not list(tmp_path.iterdir())
    assert short.disposed
    # a Content-Length that matches, or none at all, is no problem
    playwright.request.answer(
        _url("c"), FakeAPIResponse(headers={"content-length": str(len(VIDEO))})
    )
    ok = downloader.download(_episode(2, _item(2, "2", _url("c"))), _options(tmp_path))
    assert ok.status is DownloadStatus.DONE


def test_an_aborted_transfer_is_a_truncation_and_other_request_errors_stay_plain_failures(
    playwright, tmp_path
):
    """Playwright's request API checks the Content-Length itself and reports a transfer the server
    cut short as `aborted`: the same truncation failure, no next mirror, no refresh; any other
    request error is still the plain failure it was (its first line, redacted)."""
    playwright.request.answer(
        _url("a"),
        RuntimeError(
            "APIRequestContext.get: aborted\nCall log:\n"
            f"  - → GET {_url('a')}&sessionid=secret-session-value-that-must-never-show"
        ),
    )
    item = _item(1, ITEM_1, _url("a"), _url("b"))
    playwright.browser.refresh_events = [_refresh_events(item)]
    downloader = _downloader(playwright)

    result = downloader.download(_episode(1, item), _options(tmp_path))

    assert result.status is DownloadStatus.FAILED
    assert result.message == (
        f"{INCOMPLETE_PREFIX}truncated body (the transfer was cut short) from {CDN_HOST}"
    )
    assert SESSION_VALUE not in result.message
    assert playwright.request.urls == [_url("a")] and downloader.refreshes == 0
    assert not list(tmp_path.iterdir())
    playwright.request.answer(_url("c"), RuntimeError("Timeout 120000ms exceeded.\nCall log:"))
    other = downloader.download(_episode(2, _item(2, "2", _url("c"))), _options(tmp_path))
    assert other.status is DownloadStatus.FAILED
    assert other.message == "Timeout 120000ms exceeded."


def test_a_video_far_shorter_than_the_list_says_is_quarantined_and_gets_no_cover(
    playwright, tmp_path
):
    """The written file is verified BEFORE the cover step: a 3-second file for a 120-second
    episode (a locked episode's preview looks like this) is renamed `<stem> (incomplete).mp4`,
    the episode is FAILED with the reason, no cover is requested, and a rerun tries again — into
    `(incomplete 2)`, never over the first file."""
    playwright.request.answer(COVER, FakeAPIResponse(200, JPEG, "image/jpeg"))
    episode = _episode(1, _item(1, ITEM_1, _url("ep1")), cover_url=COVER, duration_s=120)
    downloader = _downloader(playwright)

    result = downloader.download(episode, _options(tmp_path))

    assert result.status is DownloadStatus.FAILED and result.path is None
    assert result.message == (
        f"{INCOMPLETE_PREFIX}duration 3 s, expected 120 s (kept as {STEM} (incomplete).mp4)"
    )
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"{STEM} (incomplete).mp4"]
    assert (tmp_path / f"{STEM} (incomplete).mp4").read_bytes() == VIDEO  # untouched, no cover
    assert playwright.request.urls == [_url("ep1")]  # no cover request for a bad download
    again = downloader.download(episode, _options(tmp_path))
    assert again.status is DownloadStatus.FAILED
    assert again.message.endswith(f"(kept as {STEM} (incomplete 2).mp4)")
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        f"{STEM} (incomplete 2).mp4",
        f"{STEM} (incomplete).mp4",
    ]
    assert playwright.request.urls == [_url("ep1"), _url("ep1")]
    # --no-verify accepts the same file (a debugging aid), and the cover follows as usual
    off = downloader.download(episode, _options(tmp_path / "off", verify=False))
    assert off.status is DownloadStatus.DONE and off.message == f"{SAVED} + cover embedded"


def test_a_bad_file_the_os_will_not_rename_is_deleted_so_that_a_rerun_tries_again(
    playwright, tmp_path, monkeypatch
):
    """The same rule as the yt-dlp engine's: a rename refused for good must not leave the bad file
    under the episode's name, where the next run would skip it as `skipped-exists`; it is deleted,
    the message says so, no cover is requested, and a rerun downloads the episode again."""

    def refuse(path, **_):
        raise PermissionError(errno.EACCES, "Permission denied", str(path))

    monkeypatch.setattr(media_module, "quarantine", refuse)
    playwright.request.answer(COVER, FakeAPIResponse(200, JPEG, "image/jpeg"))
    episode = _episode(1, _item(1, ITEM_1, _url("ep1")), cover_url=COVER, duration_s=120)
    downloader = _downloader(playwright)

    result = downloader.download(episode, _options(tmp_path))

    assert result.status is DownloadStatus.FAILED and result.path is None
    assert result.message == (
        f"{INCOMPLETE_PREFIX}duration 3 s, expected 120 s (could not rename {STEM}.mp4: "
        "Permission denied; deleted, so that it does not pass for the episode)"
    )
    assert not list(tmp_path.iterdir())
    again = downloader.download(episode, _options(tmp_path))
    assert again.status is DownloadStatus.FAILED  # tried again, not skipped-exists
    assert playwright.request.urls == [_url("ep1"), _url("ep1")]  # and still no cover request


def test_a_content_encoded_body_is_not_compared_with_the_announced_length(playwright, tmp_path):
    """Playwright's request API hands over the DECODED body while `content-length` counts the
    encoded stream, so under `Content-Encoding: gzip` (br, deflate) the two differ by design:
    no truncation, the episode is DONE. `identity`, or no encoding at all, keeps the check."""
    gzipped = FakeAPIResponse(
        headers={"content-length": str(len(VIDEO) - 1000), "content-encoding": "gzip"}
    )
    playwright.request.answer(_url("gz"), gzipped)
    downloader = _downloader(playwright)

    result = downloader.download(
        _episode(1, _item(1, ITEM_1, _url("gz"))), _options(tmp_path, thumbnail="none")
    )

    assert result.status is DownloadStatus.DONE and result.message == SAVED
    assert (tmp_path / f"{STEM}.mp4").read_bytes() == VIDEO
    content_length = downloader_browser._content_length
    assert content_length({"content-length": "10", "content-encoding": "br"}) is None
    assert content_length({"content-length": "10", "content-encoding": " Identity "}) == 10
    assert content_length({"content-length": "10"}) == 10
    identity = FakeAPIResponse(
        headers={"content-length": str(len(VIDEO) + 1), "content-encoding": "identity"}
    )
    playwright.request.answer(_url("id"), identity)
    short = downloader.download(
        _episode(2, _item(2, "2", _url("id"))), _options(tmp_path, thumbnail="none")
    )
    assert short.status is DownloadStatus.FAILED
    assert short.message == (
        f"{INCOMPLETE_PREFIX}truncated body ({len(VIDEO)} of {len(VIDEO) + 1} bytes) "
        f"from {CDN_HOST}"
    )


def test_a_body_that_is_not_an_mp4_is_quarantined_before_any_cover_request(playwright, tmp_path):
    not_an_mp4 = b"\x00\x00\x00\x18ftypmp42" + b"v" * (2 * MIN_VIDEO_BYTES)
    playwright.request.answer(_url("ep1"), FakeAPIResponse(200, not_an_mp4, "video/mp4"))
    playwright.request.answer(COVER, FakeAPIResponse(200, JPEG, "image/jpeg"))

    result = _downloader(playwright).download(_with_cover(), _options(tmp_path))

    assert result.status is DownloadStatus.FAILED
    assert result.message.startswith(f"{INCOMPLETE_PREFIX}not a valid MP4 (")
    assert result.message.endswith(f") (kept as {STEM} (incomplete).mp4)")
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"{STEM} (incomplete).mp4"]
    assert (tmp_path / f"{STEM} (incomplete).mp4").read_bytes() == not_an_mp4
    assert COVER not in playwright.request.urls


def test_the_engine_marks_a_quarantined_episode_failed_and_a_rerun_tries_it_again(
    playwright, tmp_path
):
    """Through engine.download_series: the manifest records `failed` with the reason, the
    quarantined file never passes for the episode, so the next run downloads it again."""
    series = Series(
        SERIES_ID, "Heiress", [_episode(1, _item(1, ITEM_1, _url("ep1")), duration_s=120)]
    )
    options = _options(tmp_path, engine="browser")
    results = engine.download_series(
        series, series.episodes, options, downloader=_downloader(playwright), sleep=lambda s: None
    )
    assert [r.status for r in results] == [DownloadStatus.FAILED]
    assert results[0].message.startswith(f"{INCOMPLETE_PREFIX}duration 3 s, expected 120 s")
    target = tmp_path / "Heiress [7699393770256782354]"
    manifest = Manifest.load(target / "dramafetch.json", SERIES_ID, "Heiress")
    assert manifest.done_path(1) is None
    rerun = engine.download_series(
        series, series.episodes, options, downloader=_downloader(playwright), sleep=lambda s: None
    )
    assert [r.status for r in rerun] == [DownloadStatus.FAILED]  # tried again, not skipped-exists
    assert sorted(p.name for p in target.iterdir()) == [
        f"{STEM} (incomplete 2).mp4",
        f"{STEM} (incomplete).mp4",
        "dramafetch.json",
    ]


def test_quality_best_tries_the_highest_bitrate_rendition_first(playwright, tmp_path):
    """`compatible` (the default) requests the H.264 rendition first, `best` the highest bitrate
    whatever the codec — here a bytevc1 on another host, which the dry run names too."""
    bytevc1 = f"https://v19-webapp-prime.tiktok.com/video/tos/useast2a/hi/?a=1988&expire={FRESH}"
    entries = [_entry("h264", 1_000_000, _url("h264")), _entry("bytevc1", 2_000_000, bytevc1)]
    downloader = _downloader(playwright)

    compatible = downloader.download(
        _episode(1, _item(1, ITEM_1, _url("h264"), bitrate_info=entries)),
        _options(tmp_path, thumbnail="none"),
    )
    best = downloader.download(
        _episode(2, _item(2, "2", _url("h264"), bitrate_info=entries)),
        _options(tmp_path, thumbnail="none", quality="best"),
    )

    assert compatible.status is best.status is DownloadStatus.DONE
    assert playwright.request.urls == [_url("h264"), bytevc1]
    dry = downloader.download(
        _episode(3, _item(3, "3", _url("h264"), bitrate_info=entries)),
        _options(tmp_path, dry_run=True, quality="best"),
    )
    assert dry.message == "would download from v19-webapp-prime.tiktok.com"
