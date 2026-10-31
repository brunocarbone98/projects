"""The browser strategy, end to end against the fake TikTok server with a real headless Chromium
(`pytest -m integration`; skipped without a browser binary), plus a few browser-free checks that
drive `PlaywrightDiscovery` with a fake Playwright object graph."""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

import pytest

from dramafetch.discovery.browser import (
    AUTOMATION_FLAG,
    FETCH_JS,
    SCROLL_JS,
    PlaywrightDiscovery,
)
from dramafetch.errors import ChallengeError, DiscoveryError, LoginRequiredError, RateLimitedError
from dramafetch.models import DiscoveryOptions, SeriesRef

from .fake_tiktok import SERIES_ID, SERIES_NAME, TOTAL_EPISODES, FakeTikTok

CHROMIUM = Path(os.environ.get("DRAMAFETCH_CHROMIUM") or "/opt/pw-browsers/chromium")
SESSION_VALUE = "fake-session-value-that-must-never-leak"
needs_chromium = pytest.mark.skipif(
    not CHROMIUM.is_file(), reason=f"no Chromium at {CHROMIUM} (set DRAMAFETCH_CHROMIUM)"
)


def _options(server: FakeTikTok, **overrides: Any) -> DiscoveryOptions:
    settings: dict[str, Any] = {
        "base_url": server.base_url,
        "executable_path": CHROMIUM,
        "page_count": 10,
        "timeout_s": 20.0,
        "page_delay_s": 0.3,
        "strategy": "browser",
    }
    settings.update(overrides)
    return DiscoveryOptions(**settings)


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


def _assert_full_series(series: Any) -> None:
    assert series.series_id == SERIES_ID
    assert series.name == SERIES_NAME
    assert series.total_hint == TOTAL_EPISODES
    assert series.numbers == [1, 2, 3, 4, 5]
    assert [e.item_id[-3:] for e in series.episodes] == ["001", "002", "003", "004", "005"]
    assert all(e.item_id != "7699400000000000777" for e in series.episodes)  # other series
    assert all(e.item_id != "7699400000000000099" for e in series.episodes)  # trailer
    fifth = series.episode(5)
    assert fifth.locked and "isFree=false" in fifth.lock_hints
    assert not any("gap" in w or "duplicate" in w or "announces" in w for w in series.warnings)
    assert not any("max_pages" in w for w in series.warnings)


@needs_chromium
@pytest.mark.integration
class TestWithChromium:
    def test_resolves_every_episode_by_paging_inside_the_page(self) -> None:
        with FakeTikTok() as server:
            series = PlaywrightDiscovery().discover(
                SeriesRef(SERIES_ID, episode_hint=1), _options(server)
            )

            requests = server.item_list_requests
        _assert_full_series(series)
        assert [r.query["cursor"] for r in requests] == ["0", "3"]  # the page's own, then ours
        second = requests[1].query
        assert second["count"] == "10"
        assert second["dramaID"] == SERIES_ID
        assert (second["aid"], second["app_language"], second["X-Bogus"]) == ("1988", "en", "fake")
        assert not any(r.logged_in for r in requests)

    def test_login_redirect_without_cookies_raises_login_required(self) -> None:
        with (
            FakeTikTok(require_login=True) as server,
            pytest.raises(LoginRequiredError, match="cookies"),
        ):
            PlaywrightDiscovery().discover(SeriesRef(SERIES_ID), _options(server))

    def test_cookies_file_logs_the_browser_in_and_never_leaks(self, tmp_path: Path) -> None:
        with FakeTikTok(require_login=True) as server:
            options = _options(server, cookies_file=_cookies_txt(tmp_path))
            series = PlaywrightDiscovery().discover(SeriesRef(SERIES_ID), options)
            requests = server.item_list_requests
        _assert_full_series(series)
        assert all(r.logged_in for r in requests)
        assert SESSION_VALUE not in repr(series)
        assert SESSION_VALUE not in " ".join(series.warnings)

    def test_dump_dir_receives_the_raw_payloads(self, tmp_path: Path) -> None:
        dump_dir = tmp_path / "raw"
        with FakeTikTok(require_login=True) as server:
            options = _options(server, cookies_file=_cookies_txt(tmp_path), dump_dir=dump_dir)
            PlaywrightDiscovery().discover(SeriesRef(SERIES_ID, episode_hint=3), options)
            base_url = server.base_url

        assert sorted(p.name for p in dump_dir.iterdir()) == [
            "detail.json",
            "item_list_1.json",
            "item_list_2.json",
            "page_url.txt",
        ]
        page1 = json.loads((dump_dir / "item_list_1.json").read_text(encoding="utf-8"))
        page2 = json.loads((dump_dir / "item_list_2.json").read_text(encoding="utf-8"))
        assert len(page1["itemList"]) == 4 and page1["cursor"] == 3
        assert len(page2["data"]["itemList"]) == 4 and page2["hasMore"] is False
        detail = json.loads((dump_dir / "detail.json").read_text(encoding="utf-8"))
        assert detail["dramaInfo"]["totalEpisode"] == TOTAL_EPISODES
        assert (
            dump_dir / "page_url.txt"
        ).read_text() == f"{base_url}/shortdrama/episode/{SERIES_ID}/3\n"
        for path in dump_dir.iterdir():
            assert SESSION_VALUE not in path.read_text(encoding="utf-8")
            assert "csrf-value" not in path.read_text(encoding="utf-8")

    def test_verification_page_raises_challenge_error(self) -> None:
        with FakeTikTok(challenge=True) as server, pytest.raises(ChallengeError, match="--headful"):
            PlaywrightDiscovery().discover(SeriesRef(SERIES_ID), _options(server))

    def test_falls_back_to_scrolling_when_the_in_page_fetch_is_refused(self) -> None:
        with FakeTikTok(lazy=True) as server:
            series = PlaywrightDiscovery().discover(SeriesRef(SERIES_ID), _options(server))
            requests = server.item_list_requests
        _assert_full_series(series)
        assert any("scrolled the page instead" in w for w in series.warnings)
        # the page's first request, our refused fetch, then the page's own scroll-triggered request
        assert [(r.query["cursor"], r.from_scroll) for r in requests] == [
            ("0", False),
            ("3", False),
            ("3", True),
        ]

    def test_falls_back_to_scrolling_when_the_in_page_page_is_empty(self) -> None:
        """A well-formed but empty page for our re-signed request is not the end of the list."""
        with FakeTikTok(lazy_empty=True) as server:
            series = PlaywrightDiscovery().discover(SeriesRef(SERIES_ID), _options(server))
            requests = server.item_list_requests
        _assert_full_series(series)
        assert any("no new episodes although TikTok reported more" in w for w in series.warnings)
        assert [(r.query["cursor"], r.from_scroll) for r in requests] == [
            ("0", False),
            ("3", False),
            ("3", True),
        ]

    def test_a_stalled_pagination_fetch_is_bounded_by_the_timeout(self) -> None:
        """`--timeout` bounds every in-page page fetch, not only the first page."""
        with FakeTikTok(lazy=True, slow_pagination_s=30.0) as server:
            started = time.monotonic()
            series = PlaywrightDiscovery().discover(
                SeriesRef(SERIES_ID), _options(server, timeout_s=2.0)
            )
            elapsed = time.monotonic() - started
        _assert_full_series(series)  # the page's own scroll handler is not delayed
        assert elapsed < 12, elapsed  # 2 s abort + 4 quiet scroll rounds of 0.3 s + browser time
        assert any("scrolled the page instead" in w for w in series.warnings)

    def test_http_429_on_pagination_stops_discovery_as_rate_limited(self) -> None:
        with (
            FakeTikTok(rate_limit_pagination=True) as server,
            pytest.raises(RateLimitedError, match="30-60 minutes"),
        ):
            PlaywrightDiscovery().discover(SeriesRef(SERIES_ID), _options(server))
        # the page's own request and our one refused fetch: no scrolling, no further requests
        assert [r.query["cursor"] for r in server.item_list_requests] == ["0", "3"]


# --- browser-free checks with a fake Playwright -------------------------------------------------


class _FakeResponse:
    def __init__(self, url: str, payload: Any) -> None:
        self.url, self._payload = url, payload

    def json(self) -> Any:
        return self._payload


class _FakeMouse:
    def wheel(self, dx: float, dy: float) -> None:
        pass


class _FakePage:
    def __init__(self, browser: _FakeBrowser) -> None:
        self._browser = browser
        self._handlers: list[Any] = []
        self.url = "about:blank"
        self.mouse = _FakeMouse()
        self.evaluated: list[tuple[str, Any]] = []

    def on(self, event: str, handler: Any) -> None:
        assert event == "response"
        self._handlers.append(handler)

    def goto(self, url: str, wait_until: str | None = None, timeout: float | None = None) -> None:
        self._browser.visited.append((url, wait_until, timeout))
        self.url = self._browser.final_url or url
        for response in self._browser.responses:
            for handler in self._handlers:
                handler(response)

    def wait_for_timeout(self, ms: float) -> None:
        pass  # no real clock: the deadline is wall-clock time, kept short in these tests

    def evaluate(self, expression: str, arg: Any = None) -> Any:
        self.evaluated.append((expression, arg))
        if expression == FETCH_JS:
            return self._browser.fetch_results.pop(0) if self._browser.fetch_results else {}
        return ""

    def title(self) -> str:
        return "Fake"


class _FakeContext:
    def __init__(self, browser: _FakeBrowser) -> None:
        self._browser = browser
        self.closed = False
        self.cookie_count = 0

    def new_page(self) -> _FakePage:
        return _FakePage(self._browser)

    def add_cookies(self, cookies: list[dict[str, Any]]) -> None:
        self.cookie_count = len(cookies)

    def close(self) -> None:
        self.closed = True


class _FakeBrowser:
    version = "150.0.7000.1"

    def __init__(self, responses: list[_FakeResponse], final_url: str | None = None) -> None:
        self.responses, self.final_url = responses, final_url
        self.fetch_results: list[Any] = []
        self.visited: list[tuple[str, str | None, float | None]] = []
        self.context_kwargs: dict[str, Any] = {}
        self.contexts: list[_FakeContext] = []
        self.closed = False

    def new_context(self, **kwargs: Any) -> _FakeContext:
        self.context_kwargs = kwargs
        context = _FakeContext(self)
        self.contexts.append(context)
        return context

    def close(self) -> None:
        self.closed = True


class _FakePlaywright:
    def __init__(self, browser: _FakeBrowser, launch_error: Exception | None = None) -> None:
        self._browser, self._launch_error = browser, launch_error
        self.launch_kwargs: dict[str, Any] = {}
        self.chromium = self

    def launch(self, **kwargs: Any) -> _FakeBrowser:
        self.launch_kwargs = kwargs
        if self._launch_error is not None:
            raise self._launch_error
        return self._browser

    def __enter__(self) -> _FakePlaywright:
        return self

    def __exit__(self, *exc_info: object) -> None:
        pass


def _fake_options(**overrides: Any) -> DiscoveryOptions:
    settings: dict[str, Any] = {
        "base_url": "https://www.tiktok.com",
        "executable_path": Path("/fake/chromium"),
        "page_count": 10,
        "timeout_s": 0.3,
        "page_delay_s": 0.0,
    }
    settings.update(overrides)
    return DiscoveryOptions(**settings)


def test_timeout_without_cookies_is_login_required_and_the_browser_is_closed() -> None:
    browser = _FakeBrowser(responses=[])
    playwright = _FakePlaywright(browser)

    with pytest.raises(LoginRequiredError, match="--cookies"):
        PlaywrightDiscovery(playwright_factory=lambda: playwright).discover(
            SeriesRef(SERIES_ID, episode_hint=4), _fake_options()
        )

    assert browser.closed and all(c.closed for c in browser.contexts)
    assert playwright.launch_kwargs["headless"] is True
    assert playwright.launch_kwargs["executable_path"] == "/fake/chromium"
    assert AUTOMATION_FLAG in playwright.launch_kwargs["args"]
    assert browser.visited[0] == (
        f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/4",
        "domcontentloaded",
        300,
    )
    user_agent = browser.context_kwargs["user_agent"]
    assert "Chrome/150.0.0.0" in user_agent and "Headless" not in user_agent
    assert browser.context_kwargs["locale"] == "en-US"
    assert browser.context_kwargs["viewport"] == {"width": 1280, "height": 900}


def test_timeout_with_cookies_is_a_plain_discovery_error(tmp_path: Path) -> None:
    cookies = tmp_path / "cookies.txt"
    cookies.write_text(
        f".tiktok.com\tTRUE\t/\tTRUE\t{int(time.time()) + 999}\tsessionid\t{SESSION_VALUE}\n"
    )
    browser = _FakeBrowser(responses=[])
    playwright = _FakePlaywright(browser)

    with pytest.raises(DiscoveryError, match=re.escape("no episode list within 0.3 s")) as info:
        PlaywrightDiscovery(playwright_factory=lambda: playwright).discover(
            SeriesRef(SERIES_ID),
            _fake_options(cookies_file=cookies, headful=True, browser_channel="chrome"),
        )

    assert not isinstance(info.value, LoginRequiredError)
    assert SESSION_VALUE not in str(info.value)
    assert browser.contexts[0].cookie_count == 1
    assert playwright.launch_kwargs["headless"] is False
    assert playwright.launch_kwargs["executable_path"] == "/fake/chromium"  # wins over the channel
    assert browser.closed


def test_login_url_after_navigation_is_login_required() -> None:
    browser = _FakeBrowser(responses=[], final_url="https://www.tiktok.com/login?redirect_url=%2F")
    with pytest.raises(LoginRequiredError, match="login page"):
        PlaywrightDiscovery(playwright_factory=lambda: _FakePlaywright(browser)).discover(
            SeriesRef(SERIES_ID), _fake_options()
        )
    assert browser.closed


FIRST_PAGE_URL = (
    "https://www.tiktok.com/api/drama/episode/item_list/?aid=1988&count=30&cursor=0"
    f"&dramaID={SERIES_ID}&msToken=abc&X-Bogus=DFSz"
)


def _discover_with_fake_browser(
    browser: _FakeBrowser, **overrides: Any
) -> tuple[Any, list[_FakePage]]:
    pages: list[_FakePage] = []
    original_new_page = _FakeContext.new_page

    def tracking_new_page(self: _FakeContext) -> _FakePage:
        page = original_new_page(self)
        pages.append(page)
        return page

    _FakeContext.new_page = tracking_new_page  # type: ignore[method-assign]
    try:
        series = PlaywrightDiscovery(playwright_factory=lambda: _FakePlaywright(browser)).discover(
            SeriesRef(SERIES_ID), _fake_options(**overrides)
        )
    finally:
        _FakeContext.new_page = original_new_page  # type: ignore[method-assign]
    return series, pages


def _first_page_browser(item_list_pages: list[dict[str, Any]]) -> _FakeBrowser:
    return _FakeBrowser(
        responses=[
            _FakeResponse(
                "https://www.tiktok.com/api/drama/detail/?dramaID=1",
                {"dramaInfo": {"dramaName": "N", "totalEpisode": 5}},
            ),
            _FakeResponse(FIRST_PAGE_URL, item_list_pages[0]),
        ]
    )


@pytest.mark.parametrize("list_key", ["itemList", "item_list"])
def test_captured_payload_is_paged_with_the_captured_url(item_list_pages, list_key: str) -> None:
    browser = _first_page_browser(item_list_pages)
    second = json.loads(json.dumps(item_list_pages[1]).replace('"itemList"', f'"{list_key}"'))
    browser.fetch_results = [second]  # the in-page fetch must accept both spellings, like catalog

    series, pages = _discover_with_fake_browser(browser)

    assert series.numbers == [1, 2, 3, 4, 5]
    assert series.name == "N" and series.total_hint == 5
    assert not any("scrolled" in w for w in series.warnings)
    fetches = [arg for expression, arg in pages[0].evaluated if expression == FETCH_JS]
    assert fetches == [
        [
            "https://www.tiktok.com/api/drama/episode/item_list/?aid=1988&count=10&cursor=3"
            f"&dramaID={SERIES_ID}&msToken=abc&X-Bogus=DFSz",
            300,  # --timeout bounds every in-page fetch too (0.3 s here), not only the first page
        ]
    ]
    assert browser.closed


def test_an_empty_in_page_page_triggers_the_scroll_fallback(item_list_pages) -> None:
    browser = _first_page_browser(item_list_pages)
    browser.fetch_results = [{"itemList": [], "hasMore": False, "cursor": 3, "statusCode": 0}]

    series, pages = _discover_with_fake_browser(browser)

    assert series.numbers == [1, 2, 3]  # the fake page loads nothing more when scrolled
    assert any(
        "no new episodes although TikTok reported more; scrolled" in w for w in series.warnings
    )
    assert any(expression == SCROLL_JS for expression, _ in pages[0].evaluated)
    assert "TikTok announces 5 episodes, 3 listed" in series.warnings


def test_http_429_from_the_in_page_fetch_is_rate_limited(item_list_pages) -> None:
    browser = _first_page_browser(item_list_pages)
    browser.fetch_results = [{"__dramafetch_status": 429, "__dramafetch_text": "Too Many Requests"}]

    with pytest.raises(RateLimitedError, match="HTTP 429"):
        _discover_with_fake_browser(browser)
    assert browser.closed


def test_a_timed_out_in_page_fetch_takes_the_fallback_path(item_list_pages) -> None:
    browser = _first_page_browser(item_list_pages)
    browser.fetch_results = [{"__dramafetch_status": 0, "__dramafetch_text": "AbortError"}]

    series, pages = _discover_with_fake_browser(browser)

    assert series.numbers == [1, 2, 3]
    assert any("returned no episode list; scrolled" in w for w in series.warnings)
    assert any(expression == SCROLL_JS for expression, _ in pages[0].evaluated)


def test_playwright_failures_become_one_line_discovery_errors() -> None:
    error = RuntimeError(
        "BrowserType.launch: Executable doesn't exist at /fake/chromium\n"
        "╔══════╗\n║ Looks like Playwright was just installed ║\n╚══════╝"
    )
    with pytest.raises(DiscoveryError) as info:
        PlaywrightDiscovery(
            playwright_factory=lambda: _FakePlaywright(_FakeBrowser([]), error)
        ).discover(SeriesRef(SERIES_ID), _fake_options())
    message = str(info.value)
    assert "\n" not in message
    assert message.startswith(
        "browser discovery failed: BrowserType.launch: Executable doesn't exist"
    )
    assert "playwright install chromium" in message
