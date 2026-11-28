"""The browser strategy, end to end against the fake TikTok server with a real headless Chromium
(`pytest -m integration`; skipped without a browser binary) — since 3.0.1 also an episode TikTok's
list leaves out once (filled) or always (said missing), a last page lost once (filled) or always
(an early end, said), a highlight numbered like its episode (the episode kept) and a link to
episode 3 (the page opened at episode 1) —, plus browser-free checks that drive
`PlaywrightDiscovery` with a fake Playwright object graph — the gap filling of 3.0.1 among them."""

from __future__ import annotations

import json
import os
import random
import re
import time
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

import pytest

from dramafetch import cooldown, engine
from dramafetch.catalog import PLACED_TEXT, uncertain_text
from dramafetch.discovery.browser import (
    FETCH_JS,
    GAP_FILL_REQUESTS,
    NO_CURSOR_WARNING,
    NO_LIST_WARNING,
    NOTHING_NEW_WARNING,
    PAGE_DELAY_JITTER,
    POLL_INTERVAL_S,
    RATE_LIMIT_MESSAGE,
    SCROLL_JS,
    PlaywrightDiscovery,
    page_pause_s,
)
from dramafetch.errors import ChallengeError, DiscoveryError, LoginRequiredError, RateLimitedError
from dramafetch.models import (
    DiscoveryOptions,
    DownloadResult,
    DownloadStatus,
    SeriesRef,
    SkippedItem,
)

from .fake_tiktok import (
    FIFTH_HIGHLIGHT_ITEM,
    FIFTH_ITEMS,
    FIFTH_NUM_VIDEOS,
    FIFTH_OTHER_DRAMA_ITEM,
    FIFTH_SERIES_ID,
    FIFTH_SERIES_NAME,
    FIFTH_TRAILER_ITEM,
    SERIES_ID,
    SERIES_NAME,
    TOTAL_EPISODES,
    FakeTikTok,
)

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


#: What the main series' whole list says (3.0.1): its trailer and the other drama's item are said,
#: never dropped without a word — information: no episode is missing —, and so is its locked E05.
MAIN_WARNINGS = [
    "TikTok listed 1 item DramaFetch could not read (another drama's id)",
    "TikTok listed 1 item DramaFetch could not read (no episode number)",
    "1 episode looks locked",
]


def _asked(server: FakeTikTok) -> list[tuple[str, str]]:
    """The `cursor` and `count` of every item_list request the fake saw, in order."""
    return [(r.query["cursor"], r.query["count"]) for r in server.item_list_requests]


def _page_html(server: FakeTikTok, episode: int) -> str:
    """The fake's page of the main series opened at `episode`, straight over HTTP (no browser, no
    proxy): what its own script would ask TikTok for first."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    url = f"{server.base_url}/shortdrama/episode/{SERIES_ID}/{episode}"
    with opener.open(url, timeout=10) as response:
        return str(response.read().decode("utf-8"))


def _listed(series: Any) -> list[tuple[str, str | None, tuple[int, ...], bool | None]]:
    """The listing record (3.0.1): each page's kind, the cursor it asked, the numbers it brought
    and its `hasMore` (None for an answer without a list)."""
    return [(p.kind, p.cursor_asked, p.numbers, p.has_more) for p in series.listing.pages]


@needs_chromium
@pytest.mark.integration
class TestWithChromium:
    def test_resolves_every_episode_by_paging_inside_the_page(self) -> None:
        pauses: list[float] = []

        def recording_sleep(page: Any, seconds: float) -> None:
            pauses.append(seconds)
            page.wait_for_timeout(seconds * 1000)  # the real wait, through Playwright's clock

        with FakeTikTok() as server:
            series = PlaywrightDiscovery(sleep=recording_sleep).discover(
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
        # One pause before our page, randomised between page_delay_s (0.3 here) and twice that.
        assert len(pauses) == 1 and 0.3 <= pauses[0] <= 0.6, pauses

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
        # 3.0.1: episode 1's page, whatever episode the reference names (3 here)
        assert (
            dump_dir / "page_url.txt"
        ).read_text() == f"{base_url}/shortdrama/episode/{SERIES_ID}/1\n"
        for path in dump_dir.iterdir():
            assert SESSION_VALUE not in path.read_text(encoding="utf-8")
            assert "csrf-value" not in path.read_text(encoding="utf-8")

    def test_verification_page_raises_challenge_error(self) -> None:
        with FakeTikTok(challenge=True) as server, pytest.raises(ChallengeError, match="--headful"):
            PlaywrightDiscovery().discover(SeriesRef(SERIES_ID), _options(server))

    def test_a_captcha_after_the_first_page_stops_the_discovery(self) -> None:
        """TikTok's wall raised AFTER the first list page — every later page answered with the
        captcha page — is a refusal like one met before it, never a partial list to download
        from: our one in-page fetch is refused (the page shows no wall yet, so DramaFetch scrolls),
        the page's own scroll request is refused too and the page shows the wall, and the quiet
        scroll round that follows sees it and stops. Three list requests in all."""
        with FakeTikTok(challenge_after_first_page=True) as server:
            with pytest.raises(ChallengeError, match="--headful"):
                PlaywrightDiscovery().discover(SeriesRef(SERIES_ID), _options(server))
            requests = server.item_list_requests
        assert [(r.query["cursor"], r.from_scroll) for r in requests] == [
            ("0", False),
            ("3", False),
            ("3", True),
        ]

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
        # 2 s abort + 4 quiet scroll rounds of 0.3-0.6 s (randomised) + browser time
        assert elapsed < 12, elapsed
        assert any("scrolled the page instead" in w for w in series.warnings)

    def test_http_429_on_pagination_stops_discovery_as_rate_limited(self) -> None:
        with (
            FakeTikTok(rate_limit_pagination=True) as server,
            pytest.raises(RateLimitedError, match="30-60 minutes"),
        ):
            PlaywrightDiscovery().discover(SeriesRef(SERIES_ID), _options(server))
        # the page's own request and our one refused fetch: no scrolling, no further requests
        assert [r.query["cursor"] for r in server.item_list_requests] == ["0", "3"]

    # -- 3.0.1, the owner's report of 2026-11-27: no episode left out of the list without a word

    def test_an_episode_left_out_of_one_page_once_is_asked_for_again_and_no_warning_is_left(
        self,
    ) -> None:
        """TikTok's answer for the second page leaves episode 4 out, once (`omit_once`): E01-E03
        then E05 — a hole below the highest number listed. Once the pagination is over the gap
        filling asks for it again with the very request the pagination made (`cursor` = 4 - 1,
        the same `count`), and that answer holds it: every episode listed, nothing missing, no
        early end, and no warning but the list's own (its trailer, the other drama's item, the
        locked E05) — no gap, no count."""
        with FakeTikTok(omit_once=frozenset({(SERIES_ID, 4)})) as server:
            series = PlaywrightDiscovery().discover(SeriesRef(SERIES_ID), _options(server))
            asked = _asked(server)
        _assert_full_series(series)
        assert (series.missing_numbers, series.early_end) == ([], None)
        assert series.warnings == MAIN_WARNINGS
        # the page's own request, our next page (E04 left out), the filling's one request
        assert asked == [("0", "10"), ("3", "10"), ("3", "10")]
        assert _listed(series) == [
            ("page", "0", (1, 2, 3), True),
            ("next", "3", (2, 5), False),
            ("fill", "3", (2, 4, 5), False),
        ]
        assert series.listing.fill_requests == 1

    def test_an_episode_served_without_its_number_is_numbered_by_its_place(self) -> None:
        """4.0.2, the owner's report of 2026-11-27: TikTok's list serves episode 4 without its
        number, in its place (`unnumbered`) — the second page begins with episode 2 again, then
        that item, then episode 5. The listing asks TikTok again for episode 4 (the gap filling's
        one request), the answer brings the same item, and only then is it episode 4 by its place:
        every episode listed, nothing missing, the item gone from the skipped ones, and one more
        warning saying how it was numbered."""
        with FakeTikTok(unnumbered=frozenset({(SERIES_ID, 4)})) as server:
            series = PlaywrightDiscovery().discover(SeriesRef(SERIES_ID), _options(server))
            asked = _asked(server)
        _assert_full_series(series)
        assert series.episode(4).item_id == "7699400000000000004"
        assert (series.missing_numbers, series.early_end) == ([], None)
        assert series.warnings == [
            f"episode 4 {PLACED_TEXT} (between episodes 3 and 5)",
            *MAIN_WARNINGS,
        ]
        assert asked == [("0", "10"), ("3", "10"), ("3", "10")]
        assert _listed(series) == [
            ("page", "0", (1, 2, 3), True),
            ("next", "3", (2, 5), False),
            ("fill", "3", (2, 5), False),
        ]

    def test_an_episode_always_left_out_is_asked_for_once_then_said_missing(self) -> None:
        """TikTok's list never holds episode 4 (`omit_always`): the filling asks for its page
        once — its answer went on past it, so never twice — and episode 4 stays missing: in
        `missing_numbers` and in a warning of its own, never dropped without a word."""
        with FakeTikTok(omit_always=frozenset({(SERIES_ID, 4)})) as server:
            series = PlaywrightDiscovery().discover(SeriesRef(SERIES_ID), _options(server))
            asked = _asked(server)
        assert series.numbers == [1, 2, 3, 5]
        assert series.total_hint == TOTAL_EPISODES
        assert (series.missing_numbers, series.early_end) == ([4], None)
        # 3.0.1, the lead's decision D2 (changed on purpose): TikTok's count against the numbers
        # listed stays said whenever a number is certainly missing — other items never silence it
        assert series.warnings == [
            "episode 4 missing (gap)",
            *MAIN_WARNINGS[:2],
            "TikTok announces 5 episodes, 4 listed",
            *MAIN_WARNINGS[2:],
        ]
        assert asked == [("0", "10"), ("3", "10"), ("3", "10")]
        assert series.listing.fill_requests == 1
        assert _listed(series)[-1] == ("fill", "3", (2, 5), False)

    @pytest.mark.parametrize("status", [200, 500], ids=["no-list", "http-500"])
    def test_a_lost_last_page_is_asked_for_again_once_the_pagination_is_over(
        self, status: int
    ) -> None:
        """The last page is lost the first time it is asked for (`lose_page_once`: TikTok's JSON
        without a list, or an HTTP 500): the pagination says so and scrolls (the page loads
        nothing more), the detail gives TikTok's count (5), and the filling asks for the page
        again — the very request — which comes: every episode listed, no early end left (that
        page said the list is over), nothing missing."""
        lost = frozenset({(SERIES_ID, "3")})
        with FakeTikTok(lose_page_once=lost, lost_page_status=status) as server:
            series = PlaywrightDiscovery().discover(SeriesRef(SERIES_ID), _options(server))
            asked = _asked(server)
        _assert_full_series(series)
        assert (series.missing_numbers, series.early_end) == ([], None)
        assert series.warnings == [NO_LIST_WARNING, *MAIN_WARNINGS]
        assert asked == [("0", "10"), ("3", "10"), ("3", "10")]
        assert _listed(series) == [
            ("page", "0", (1, 2, 3), True),
            ("next", "3", (), None),
            ("fill", "3", (2, 4, 5), False),
        ]

    def test_a_last_page_tiktok_never_brings_ends_the_list_early_and_is_said(self) -> None:
        """The last page never comes (`lose_page_always`, the owner's "sometimes the last one of
        the list"): the pagination says so and scrolls, the filling asks for it once more — lost
        again, so the filling ends — and the list ends EARLY: E04 is missing, the early end and the
        count are said, never a list taken for whole. 3.0.1, the lead's decision D2 (changed on
        purpose): three episodes and the trailer came for TikTok's 5 — E05 may be the trailer
        TikTok counts, so it is not named missing: the list is uncertain, and says so."""
        lost = frozenset({(SERIES_ID, "3")})
        with FakeTikTok(lose_page_always=lost) as server:
            series = PlaywrightDiscovery().discover(SeriesRef(SERIES_ID), _options(server))
            asked = _asked(server)
        assert series.numbers == [1, 2, 3]
        assert (series.total_hint, series.items_received) == (TOTAL_EPISODES, 4)
        assert (series.missing_numbers, series.early_end) == ([4], NO_LIST_WARNING)
        assert series.warnings == [
            NO_LIST_WARNING,
            "TikTok listed 1 item DramaFetch could not read (no episode number)",
            "TikTok announces 5 episodes, 3 listed",
            uncertain_text(5, 3, 1),
        ]
        assert asked == [("0", "10"), ("3", "10"), ("3", "10")]
        assert _listed(series) == [
            ("page", "0", (1, 2, 3), True),
            ("next", "3", (), None),
            ("fill", "3", (), None),
        ]

    def test_a_highlight_numbered_like_its_episode_is_left_out_and_the_episode_kept(self) -> None:
        """The fifth series, the owner's real item shape: a highlight numbered 2 and listed BEFORE
        episode 2 is left out — the real episode is kept, whatever the order —, episode 3, whose
        `EpisodeNumber` is 0, is numbered from `dramaInfo.episodeNumber`, and the trailer and the
        other drama's item are said, not dropped silently. TikTok's count (`numVideos` 7, in the
        detail and on every item) may count the highlight and the trailer: seven items of this
        drama came, so no number is named missing. 3.0.1, the lead's decision D2 (changed on
        purpose): it may also mean two episodes past 5 — the list is uncertain: the filling asks
        once for the page after episode 5, and the warnings say what TikTok counts."""
        with FakeTikTok() as server:
            series = PlaywrightDiscovery().discover(SeriesRef(FIFTH_SERIES_ID), _options(server))
            asked = _asked(server)
        assert (series.series_id, series.name) == (FIFTH_SERIES_ID, FIFTH_SERIES_NAME)
        assert series.numbers == [1, 2, 3, 4, 5]
        assert {e.number: e.item_id for e in series.episodes} == FIFTH_ITEMS
        assert not any(e.locked for e in series.episodes)
        assert (series.total_hint, series.items_received) == (FIFTH_NUM_VIDEOS, FIFTH_NUM_VIDEOS)
        assert (series.missing_numbers, series.early_end) == ([], None)
        assert series.warnings == [
            f"duplicate episode number 2: item {FIFTH_HIGHLIGHT_ITEM} left out (a highlight), "
            f"item {FIFTH_ITEMS[2]} kept",
            "TikTok listed 1 item DramaFetch could not read (another drama's id)",
            "TikTok listed 1 item DramaFetch could not read (no episode number)",
            "TikTok announces 7 episodes, 5 listed",
            uncertain_text(7, 5, 2),
        ]
        assert sorted((s.reason, s.item_id) for s in series.skipped_items) == [
            ("another drama's id", FIFTH_OTHER_DRAMA_ITEM),
            ("no episode number", FIFTH_TRAILER_ITEM),
        ]
        assert asked == [("0", "10"), ("5", "10"), ("5", "10")]  # its two pages, one filling
        assert series.listing.fill_requests == 1

    def test_a_link_to_episode_3_opens_episode_1_and_lists_the_whole_drama(self) -> None:
        """A reference to episode 3 opens the series page at episode 1: the fake's page opened at
        episode n asks first for the window that holds it (`opens_at_episode`: `cursor=n-1`, as
        TikTok's player page may), so opened at 3 its first list would start at episode 3. At 1
        it starts at the beginning: the whole drama listed by the pagination alone, no request
        more."""
        with FakeTikTok(opens_at_episode=True) as server:
            series = PlaywrightDiscovery().discover(
                SeriesRef(SERIES_ID, episode_hint=3), _options(server)
            )
            pages = [r.path for r in server.series_page_requests]
            asked = _asked(server)
            opened_at_3 = _page_html(server, 3)  # the fake's own page at episode 3, asked last
        assert "cursor: 2," in opened_at_3  # what the page at episode 3 would have asked first
        assert pages == [f"/shortdrama/episode/{SERIES_ID}/1"]
        _assert_full_series(series)
        assert asked == [("0", "10"), ("3", "10")]
        assert (series.listing.fill_requests, series.missing_numbers) == (0, [])


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
        self.waited: list[float] = []  # every wait_for_timeout(ms), never slept

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
        self.waited.append(ms)  # no real clock: the deadline is wall-clock time, kept short here

    def evaluate(self, expression: str, arg: Any = None) -> Any:
        self.evaluated.append((expression, arg))
        if expression == FETCH_JS:
            self._browser.events.append(f"fetch {arg[0]}")
            if self._browser.respond is not None:
                return self._browser.respond(arg[0])
            return self._browser.fetch_results.pop(0) if self._browser.fetch_results else {}
        if expression == SCROLL_JS:
            return ""
        texts = self._browser.texts  # the page's text, read for the verification wall
        return texts.pop(0) if len(texts) > 1 else texts[0]

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
        # answers the in-page fetches by URL instead of `fetch_results` when set (`_FakeList`)
        self.respond: Any = None
        self.texts: list[str] = [""]  # the page's text, in turn (the last one stays)
        self.events: list[str] = []  # every in-page fetch, in order (and the test's own entries)
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
    # Nothing hides the automation: Chromium runs with its default flags.
    assert not any("AutomationControlled" in a for a in playwright.launch_kwargs.get("args", []))
    # 3.0.1: episode 1's page, whatever episode the reference names (4 here)
    assert browser.visited[0] == (
        f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1",
        "domcontentloaded",
        300,
    )
    user_agent = browser.context_kwargs["user_agent"]
    assert "Chrome/150.0.0.0" in user_agent and "Headless" not in user_agent
    # no `locale`: Chromium keeps the machine's own, as the user's Chrome does
    assert "locale" not in browser.context_kwargs
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


class _FixedRng(random.Random):
    """A random source whose `uniform` always answers `value`."""

    def __init__(self, value: float) -> None:
        super().__init__(0)
        self.value = value

    def uniform(self, a: float, b: float) -> float:
        return self.value


def test_the_pause_between_pages_is_randomised_from_the_minimum(item_list_pages) -> None:
    """`page_delay_s` is the minimum: the pause before the next page is it times a random 1.0-2.0
    drawn from the injected rng and waited through the injected sleep — nothing waits for real."""
    browser = _first_page_browser(item_list_pages)
    browser.fetch_results = [item_list_pages[1]]
    pauses: list[tuple[Any, float]] = []
    discovery = PlaywrightDiscovery(
        playwright_factory=lambda: _FakePlaywright(browser),
        rng=random.Random(7),
        sleep=lambda page, seconds: pauses.append((page, seconds)),
    )

    series = discovery.discover(SeriesRef(SERIES_ID), _fake_options(page_delay_s=0.8))

    assert series.numbers == [1, 2, 3, 4, 5]
    assert PAGE_DELAY_JITTER == (1.0, 2.0)
    assert [seconds for _, seconds in pauses] == [
        pytest.approx(0.8 * random.Random(7).uniform(1.0, 2.0))
    ]
    assert 0.8 <= pauses[0][1] <= 1.6
    assert isinstance(pauses[0][0], _FakePage)  # the sleep gets the page: Playwright's clock
    assert pauses[0][0].waited == []  # the injected sleep replaced it entirely
    # The bounds, and the zero delay the fast tests use.
    assert page_pause_s(0.8, _FixedRng(1.0)) == 0.8
    assert page_pause_s(0.8, _FixedRng(2.0)) == pytest.approx(1.6)
    assert page_pause_s(0.0, random.Random(1)) == 0.0
    assert page_pause_s(-1.0, random.Random(1)) == 0.0
    draws = {page_pause_s(0.8, random.Random(seed)) for seed in range(50)}
    assert len(draws) > 40 and all(0.8 <= draw <= 1.6 for draw in draws)  # spread, in range


def test_the_default_sleep_waits_through_the_page_clock(item_list_pages) -> None:
    """Without an injected sleep the pause goes through `page.wait_for_timeout`, so Playwright
    keeps dispatching responses meanwhile; `time.sleep` would stall the listener."""
    browser = _first_page_browser(item_list_pages)
    browser.fetch_results = [item_list_pages[1]]

    series, pages = _discover_with_fake_browser(browser, page_delay_s=0.8)

    assert series.numbers == [1, 2, 3, 4, 5]
    waits = [ms for ms in pages[0].waited if ms != POLL_INTERVAL_S * 1000]  # polling ticks aside
    assert len(waits) == 1 and 800 <= waits[0] <= 1600, waits


def test_an_empty_in_page_page_triggers_the_scroll_fallback(item_list_pages) -> None:
    browser = _first_page_browser(item_list_pages)
    browser.fetch_results = [{"itemList": [], "hasMore": False, "cursor": 3, "statusCode": 0}]

    series, pages = _discover_with_fake_browser(browser, page_delay_s=0.5)

    assert series.numbers == [1, 2, 3]  # the fake page loads nothing more when scrolled
    assert any(
        "no new episodes although TikTok reported more; scrolled" in w for w in series.warnings
    )
    assert any(expression == SCROLL_JS for expression, _ in pages[0].evaluated)
    assert "TikTok announces 5 episodes, 3 listed" in series.warnings
    # 3.0.1: the gap filling asks once more for the page that should hold episodes 4-5 (the
    # template with cursor 3 and the usual count), which brings no list here: the filling ends.
    fetches = [arg[0] for expression, arg in pages[0].evaluated if expression == FETCH_JS]
    assert len(fetches) == 2 and fetches[1] == fetches[0]  # cursor=3&count=10, asked again
    # 3.0.1, the lead's decision D2 (changed on purpose): TikTok counts 5, three episodes and the
    # trailer came — E04 is certainly missing, E05 may be the trailer TikTok counts: the list is
    # uncertain, said, and E05 gets no row
    assert series.missing_numbers == [4]
    assert uncertain_text(5, 3, 1) in series.warnings
    # The pause before our page, one per scroll round (4 quiet rounds) and one before the
    # filling's request (3.0.1), each randomised.
    waits = [ms for ms in pages[0].waited if ms != POLL_INTERVAL_S * 1000]
    assert len(waits) == 6 and all(500 <= ms <= 1000 for ms in waits), waits


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


# --- the gap filling (3.0.1), with a fake Playwright ---------------------------------------------

#: The list request's scheme, host and path, as the listing record keeps it (never the query).
ENDPOINT = "https://www.tiktok.com/api/drama/episode/item_list/"
NO_LIST = {"__dramafetch_status": 500, "__dramafetch_text": ""}
WALL_TEXT = "Security check\nVerify to continue\nDrag the puzzle piece into place."


def _list_item(number: int, num_videos: int | None) -> dict[str, Any]:
    """One episode of the fake drama in TikTok's item shape (``numVideos`` unless None)."""
    drama_info: dict[str, Any] = {
        "dramaID": SERIES_ID,
        "dramaName": "Fake Drama",
        "DramaVideoData": {"EpisodeNumber": number, "IsHighlight": False, "LinkedEpisodeID": "0"},
    }
    if num_videos is not None:
        drama_info["numVideos"] = num_videos
    return {
        "id": f"7699400000{500000 + number:09d}",
        "dramaInfo": drama_info,
        "video": {"playAddr": f"https://v16-webapp-prime.tiktok.com/v/{number}.mp4", "duration": 3},
    }


class _FakeList:
    """TikTok's list as the investigation's reproduction models it: ``cursor`` the episodes before
    a page, the answer's ``cursor`` the end of the window it served, ``hasMore`` while episodes are
    left; ``page_size`` caps a page whatever ``count`` asks; ``lose(cursor, attempt)`` answers
    something else for the attempt-th request of a cursor; ``leave(number, cursor)`` leaves an
    episode out of the page of that cursor; ``extras`` puts an item that is no episode right before
    an episode, on every page that holds it (``(number, item)`` pairs)."""

    def __init__(
        self,
        total: int,
        *,
        num_videos: int | None = -1,
        page_size: int = 10**9,
        lose: Any = None,
        leave: Any = None,
        extras: tuple[tuple[int, dict[str, Any]], ...] = (),
    ) -> None:
        self.total = total
        self.num_videos = total if num_videos == -1 else num_videos
        self.page_size, self.lose, self.leave, self.extras = page_size, lose, leave, extras
        self.attempts: dict[int, int] = {}

    def page(self, cursor: int, count: int) -> dict[str, Any]:
        end = min(self.total, cursor + min(count, self.page_size))
        items: list[dict[str, Any]] = []
        for number in range(cursor + 1, end + 1):
            items.extend(item for before, item in self.extras if before == number)
            if self.leave is None or not self.leave(number, cursor):
                items.append(_list_item(number, self.num_videos))
        return {"statusCode": 0, "cursor": end, "hasMore": end < self.total, "itemList": items}

    def respond(self, url: str) -> Any:
        query = dict(parse_qsl(urlsplit(url).query))
        cursor, count = int(query.get("cursor", "0")), int(query.get("count", "30"))
        attempt = self.attempts[cursor] = self.attempts.get(cursor, 0) + 1
        if self.lose is not None:
            other = self.lose(cursor, attempt)
            if other is not None:
                return other
        return self.page(cursor, count)


def _listing_browser(fake: _FakeList, detail: dict[str, Any] | None = None) -> _FakeBrowser:
    """The series page's own first item_list response (10 episodes from cursor 0) and its detail
    (no count by default: the items' ``numVideos`` is TikTok's count); the in-page fetches answered
    by ``fake``."""
    first_url = FIRST_PAGE_URL.replace("&count=30&", "&count=10&")
    browser = _FakeBrowser(
        responses=[
            _FakeResponse(
                f"https://www.tiktok.com/api/drama/detail/?dramaID={SERIES_ID}",
                detail if detail is not None else {"dramaInfo": {"dramaName": "Fake Drama"}},
            ),
            _FakeResponse(first_url, fake.page(0, 10)),
        ]
    )
    browser.respond = fake.respond
    return browser


def _list_url(cursor: int, count: int = 10) -> str:
    return FIRST_PAGE_URL.replace("&count=30&cursor=0&", f"&count={count}&cursor={cursor}&")


def _lose_once(lost: int) -> Any:
    """The page of cursor ``lost`` brings no list the first time it is asked for, then comes."""
    return lambda cursor, attempt: NO_LIST if (cursor, attempt) == (lost, 1) else None


def _fetched(browser: _FakeBrowser) -> list[str]:
    return [event[len("fetch ") :] for event in browser.events if event.startswith("fetch ")]


def _fills(series: Any) -> list[Any]:
    return [page for page in series.listing.pages if page.kind == "fill"]


def _paced(browser: _FakeBrowser, *, ref: SeriesRef | None = None, **overrides: Any) -> Any:
    """Discover through ``browser`` with every list-page pause (0.8 s: the floor of the jitter)
    recorded in ``browser.events`` next to the fetches — nothing waits for real."""
    discovery = PlaywrightDiscovery(
        playwright_factory=lambda: _FakePlaywright(browser),
        rng=_FixedRng(1.0),
        sleep=lambda page, seconds: browser.events.append(f"sleep {seconds}"),
    )
    options = _fake_options(page_delay_s=0.8, **overrides)
    return discovery.discover(ref or SeriesRef(SERIES_ID), options)


def _paused_before_each(events: list[str]) -> bool:
    return all(
        not event.startswith("fetch") or (index > 0 and events[index - 1] == "sleep 0.8")
        for index, event in enumerate(events)
    )


def test_a_lost_last_page_is_asked_for_again_once_the_pagination_is_over() -> None:
    """The page that held episodes 21-25 brought no list: once the pagination (and its scroll
    fallback) is over, the gap filling asks for it again — the very request, after the usual
    pause — and every episode is listed; nothing missing, the list's end reached."""
    fake = _FakeList(25, lose=_lose_once(20))
    browser = _listing_browser(fake)
    series = _paced(browser)
    assert series.numbers == list(range(1, 26))
    assert (series.missing_numbers, series.early_end) == ([], None)
    assert series.warnings == [NO_LIST_WARNING]  # the fallback's, as before: no gap, no count
    assert _fetched(browser) == [_list_url(10), _list_url(20), _list_url(20)]
    assert _paused_before_each(browser.events), browser.events
    assert series.listing.endpoint == ENDPOINT
    assert [
        (p.kind, p.cursor_asked, p.count_asked, p.listed, p.items, p.has_more, p.cursor)
        for p in series.listing.pages
    ] == [
        ("page", "0", "10", True, 10, True, 10),
        ("next", "10", "10", True, 10, True, 20),
        ("next", "20", "10", False, 0, None, None),
        ("fill", "20", "10", True, 5, False, 25),
    ]
    assert series.listing.fill_requests == 1
    assert _fills(series)[0].numbers == (21, 22, 23, 24, 25)
    # TikTok's count unknown (no numVideos): the early end asks for the episode after the highest
    uncounted = _FakeList(25, num_videos=None, lose=_lose_once(20))
    listed = _paced(_listing_browser(uncounted))
    assert listed.numbers == list(range(1, 26))
    assert (listed.total_hint, listed.early_end, listed.missing_numbers) == (None, None, [])
    # the detail's count is TikTok's count when it names one
    counted = _FakeList(25, num_videos=None, lose=_lose_once(20))
    detail = {"dramaInfo": {"dramaID": SERIES_ID, "dramaName": "Fake Drama", "numVideos": 25}}
    assert _paced(_listing_browser(counted, detail)).numbers == list(range(1, 26))


def test_a_lost_middle_page_is_filled_from_the_first_missing_episode_on() -> None:
    fake = _FakeList(25, lose=_lose_once(10))
    browser = _listing_browser(fake)
    series = _paced(browser)
    assert series.numbers == list(range(1, 26))
    assert (series.missing_numbers, series.early_end) == ([], None)
    assert _fetched(browser) == [_list_url(10), _list_url(10), _list_url(20)]
    assert [(p.cursor_asked, len(p.numbers), p.has_more) for p in _fills(series)] == [
        ("10", 10, True),
        ("20", 5, False),
    ]
    assert _paused_before_each(browser.events), browser.events


def test_an_episode_left_out_of_one_page_once_comes_with_the_filling_and_no_warning_is_left() -> (
    None
):
    fake = _FakeList(25, leave=lambda number, cursor: number == 17 and cursor == 10)
    browser = _listing_browser(fake)
    series = _paced(browser)
    assert series.numbers == list(range(1, 26))
    assert series.warnings == []
    assert (series.missing_numbers, series.early_end) == ([], None)
    assert _fetched(browser) == [_list_url(10), _list_url(20), _list_url(16)]
    assert [(p.cursor_asked, p.count_asked, p.numbers[0]) for p in _fills(series)] == [
        ("16", "10", 17)
    ]
    assert browser.events[-2:] == ["sleep 0.8", f"fetch {_list_url(16)}"]


def test_an_episode_always_left_out_is_asked_for_once_then_stays_missing_and_is_said() -> None:
    fake = _FakeList(25, leave=lambda number, cursor: number == 17)
    series = _paced(_listing_browser(fake))
    assert series.numbers == [n for n in range(1, 26) if n != 17]
    assert len(_fills(series)) == 1  # its answer went on past it: never asked for twice
    assert (series.missing_numbers, series.early_end) == ([17], None)
    assert series.warnings == [
        "episode 17 missing (gap)",
        "TikTok announces 25 episodes, 24 listed",
    ]


def test_a_page_that_stays_lost_ends_the_filling_after_one_request_and_the_early_end_says_it() -> (
    None
):
    fake = _FakeList(25, lose=lambda cursor, attempt: NO_LIST if cursor == 20 else None)
    browser = _listing_browser(fake)
    series = _paced(browser)
    assert series.numbers == list(range(1, 21))
    assert series.missing_numbers == [21, 22, 23, 24, 25]
    assert series.early_end == NO_LIST_WARNING
    assert series.warnings == [NO_LIST_WARNING, "TikTok announces 25 episodes, 20 listed"]
    assert [(p.cursor_asked, p.listed) for p in _fills(series)] == [("20", False)]


def test_the_filling_makes_at_most_gap_fill_requests_requests_each_after_the_pause() -> None:
    assert GAP_FILL_REQUESTS == 4
    # TikTok serves 5 episodes a page whatever is asked; the pagination stops at its page cap
    browser = _listing_browser(_FakeList(100, page_size=5))
    series = _paced(browser, max_pages=2)
    assert len(_fills(series)) == GAP_FILL_REQUESTS
    assert [p.cursor_asked for p in _fills(series)] == ["10", "15", "20", "25"]
    assert series.numbers == list(range(1, 31))
    assert series.missing_numbers == list(range(31, 101))
    assert series.early_end == "pagination stopped at max_pages (2); the list may be incomplete"
    assert _paused_before_each(browser.events), browser.events
    assert browser.events.count("sleep 0.8") == 1 + GAP_FILL_REQUESTS


def test_no_filling_request_for_a_list_that_came_whole() -> None:
    browser = _listing_browser(_FakeList(25))
    series = _paced(browser)
    assert series.numbers == list(range(1, 26))
    assert _fetched(browser) == [_list_url(10), _list_url(20)]
    assert (series.listing.fill_requests, series.missing_numbers, series.early_end) == (0, [], None)


def test_a_429_on_a_filling_request_stops_the_listing_and_records_the_cooldown() -> None:
    def lose(cursor: int, attempt: int) -> Any:
        if cursor != 20:
            return None
        return NO_LIST if attempt == 1 else {"__dramafetch_status": 429, "__dramafetch_text": ""}

    browser = _listing_browser(_FakeList(25, lose=lose))
    with pytest.raises(RateLimitedError, match="HTTP 429"):
        _paced(browser)
    assert _fetched(browser)[-2:] == [_list_url(20), _list_url(20)]  # the filling's, the last one
    assert browser.closed
    # through the engine's resolve, as a run lists a series: the cooldown, source discovery
    second = _listing_browser(_FakeList(25, lose=lose))
    discovery = PlaywrightDiscovery(
        playwright_factory=lambda: _FakePlaywright(second),
        rng=_FixedRng(1.0),
        sleep=lambda page, seconds: None,
    )
    assert cooldown.active_cooldown() is None
    with pytest.raises(RateLimitedError):
        engine.resolve(SeriesRef(SERIES_ID), _fake_options(page_delay_s=0.8), discovery)
    recorded = cooldown.active_cooldown()
    assert recorded is not None
    assert (recorded.reason, recorded.source) == (RATE_LIMIT_MESSAGE, "discovery")


def test_the_verification_wall_behind_a_filling_request_is_a_stop() -> None:
    browser = _listing_browser(_FakeList(25, lose=lambda c, a: NO_LIST if c == 20 else None))
    # the listless page, the four quiet scroll rounds: an ordinary page; the filling's: the wall
    browser.texts = [""] * 5 + [WALL_TEXT]
    with pytest.raises(ChallengeError, match="--headful"):
        _paced(browser)
    assert len(_fetched(browser)) == 3  # the filling's one request, then the stop
    assert browser.closed


def test_a_link_to_episode_3_opens_episode_1_and_a_later_first_window_is_filled() -> None:
    """The listing page opens at episode 1 whatever episode the link names, and costs nothing
    more; were the page's own first request still the window that holds episode 3, the episodes
    before it are a hole the filling asks for from cursor 0."""
    browser = _listing_browser(_FakeList(25))
    link = f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/3"
    series = _paced(browser, ref=SeriesRef(SERIES_ID, episode_hint=3, source_url=link))
    assert browser.visited[0][0] == f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1"
    assert series.numbers == list(range(1, 26))  # the episode in the link picks nothing
    assert series.listing.fill_requests == 0
    # the page's own first request is the window from cursor 2 (episodes 3-12)
    fake = _FakeList(25)
    window = _listing_browser(fake)
    window.responses[1] = _FakeResponse(_list_url(2), fake.page(2, 10))
    filled = _paced(window, ref=SeriesRef(SERIES_ID, episode_hint=3, source_url=link))
    assert filled.numbers == list(range(1, 26))
    assert (filled.missing_numbers, filled.warnings) == ([], [])
    assert _fetched(window) == [_list_url(12), _list_url(22), _list_url(0)]


def test_the_listing_record_names_no_query_no_cookie_no_signature() -> None:
    fake = _FakeList(25, leave=lambda number, cursor: number == 17 and cursor == 10)
    series = _paced(_listing_browser(fake))
    record = repr(series.listing)
    for secret in ("?", "msToken", "abc", "X-Bogus", "DFSz", "aid=", "dramaID"):
        assert secret not in record, (secret, record)


# --- 3.0.1: the review's listing fixes (D2, D4, D5, D6), with a fake Playwright ----------------

#: An answer with a list in it and nothing of the series: TikTok's empty last page.
EMPTY_END = {"statusCode": 0, "itemList": [], "hasMore": False, "cursor": 0}


def _line_of(series: Any) -> str:
    """The report line of a run that saved every listed episode."""
    results = [DownloadResult(episode, DownloadStatus.DONE) for episode in series.episodes]
    return engine.report_line(engine.series_report(series, results))


def _trailer(num_videos: int | None) -> dict[str, Any]:
    drama_info: dict[str, Any] = {"dramaID": SERIES_ID, "DramaVideoData": {}}
    if num_videos is not None:
        drama_info["numVideos"] = num_videos
    return {"id": "7699400000000000690", "dramaInfo": drama_info, "video": {"duration": 30}}


def test_the_review_case_a_asks_once_past_the_highest_and_says_the_list_may_be_incomplete() -> None:
    """66 episodes and a trailer, TikTok counts 66, E66 never listed: nothing named missing, one
    filling request at cursor 65, the list uncertain — never complete (3.0.1, the lead's D2)."""
    fake = _FakeList(66, leave=lambda number, cursor: number == 66, extras=((1, _trailer(66)),))
    browser = _listing_browser(fake)
    series = _paced(browser)
    assert series.numbers == list(range(1, 66))
    assert (series.missing_numbers, series.early_end, series.items_received) == ([], None, 66)
    assert [(p.cursor_asked, p.count_asked) for p in _fills(series)] == [("65", "10")]
    assert _paused_before_each(browser.events), browser.events
    assert series.warnings == [
        "TikTok listed 1 item DramaFetch could not read (no episode number)",
        "TikTok announces 66 episodes, 65 listed",
        uncertain_text(66, 65, 1),
    ]
    results = [DownloadResult(episode, DownloadStatus.DONE) for episode in series.episodes]
    report = engine.series_report(series, results)
    assert (report.complete, report.uncertain, report.gaps, report.other_items) == (
        False,
        True,
        (),
        1,
    )
    assert engine.report_line(report) == (
        "incomplete: 65 of 65 — TikTok's list may be incomplete: TikTok counts 66 episodes, 65 "
        "listed and 1 other item (a trailer or a highlight)"
    )


def test_the_review_case_b_names_the_hole_only_and_case_c_the_last_episode() -> None:
    """(b) 6 episodes and a trailer, TikTok counts 7, E04 never listed: E04 only — no phantom
    E07 —, also uncertain; (c) no other item, TikTok counts 66, E66 never listed: E66, as before."""
    fake = _FakeList(
        6, num_videos=7, leave=lambda number, cursor: number == 4, extras=((1, _trailer(7)),)
    )
    series = _paced(_listing_browser(fake))
    assert series.numbers == [1, 2, 3, 5, 6]
    assert series.missing_numbers == [4]
    assert [p.cursor_asked for p in _fills(series)] == ["3"]  # its answer ends the list: once
    assert _line_of(series) == (
        "incomplete: 5 of 6 — episode 4 missing from TikTok's list; TikTok's list may be "
        "incomplete: TikTok counts 7 episodes, 5 listed and 1 other item (a trailer or a highlight)"
    )
    last = _paced(_listing_browser(_FakeList(66, leave=lambda number, cursor: number == 66)))
    assert last.missing_numbers == [66]
    assert [p.cursor_asked for p in _fills(last)] == ["65"]
    assert _line_of(last) == "incomplete: 65 of 66 — episode 66 missing from TikTok's list"


def _marked(number: int, num_videos: int | None) -> dict[str, Any]:
    """Episode ``number`` of the fake drama carrying TikTok's highlight mark (``IsHighlight``
    true): a full episode TikTok marks as a highlight, as on episodes 9 and 17 of the owner's
    drama of 2026-11-27."""
    item = _list_item(number, num_videos)
    item["dramaInfo"]["DramaVideoData"]["IsHighlight"] = True
    return item


def test_the_owners_drama_lists_and_counts_the_episodes_tiktok_marks_as_highlights() -> None:
    """4.0.1, the owner's report of 2026-11-27 ("y los episodios existen"): TikTok's list holds 66
    items for 66 episodes, TikTok counts 66, and the items of episodes 9 and 17 carry TikTok's
    highlight marks with no other item of their numbers — full episodes that play on TikTok. Every
    episode is listed (9 and 17 the marked items), nothing is missing, no gap filling request, no
    warning, and the report line is complete."""
    marked = {9: _marked(9, 66), 17: _marked(17, 66)}
    fake = _FakeList(
        66,
        leave=lambda number, cursor: number in marked,
        extras=tuple(marked.items()),
    )
    series = _paced(_listing_browser(fake))
    assert series.numbers == list(range(1, 67))
    assert [series.episode(n).item_id for n in marked] == [item["id"] for item in marked.values()]
    assert (series.total_hint, series.items_received) == (66, 66)
    assert (series.missing_numbers, series.early_end, series.skipped_items) == ([], None, [])
    assert series.warnings == []
    assert _fills(series) == []
    assert _line_of(series) == "complete: 66 of 66 (66 downloaded)"


def _without_its_number(number: int, num_videos: int | None, duration: int = 3) -> dict[str, Any]:
    """Episode ``number`` of the fake drama served without a usable number (``EpisodeNumber`` 0) —
    the shape 4.0.2 infers for episode 53 of the owner's drama of 56 (2026-11-27)."""
    item = _list_item(number, num_videos)
    item["dramaInfo"]["DramaVideoData"]["EpisodeNumber"] = 0
    item["video"]["duration"] = duration
    return item


@pytest.mark.parametrize(
    "number", [53, 51, 50], ids=["mid-page", "at a page's start", "at a page's end"]
)
def test_an_episode_listed_without_its_number_is_numbered_by_its_place(number: int) -> None:
    """4.0.2, the owner's report of 2026-11-27 (a drama of 56: "episode 53 missing (gap)" beside
    one item without a number): the item TikTok lists without its number, in the middle of a page,
    at a page's start or at its end (pages of 10), leaves its number a hole until the gap filling
    asks TikTok for that page again — ONE request, `cursor` = the number - 1 — and the answer still
    holds no item numbered so; then it is the episode of its place: every episode listed, nothing
    missing, no skipped item, the report line complete, and one warning saying how it was
    numbered."""
    loose = _without_its_number(number, 56)
    fake = _FakeList(56, leave=lambda n, cursor: n == number, extras=((number, loose),))
    browser = _listing_browser(fake)
    series = _paced(browser)
    assert series.numbers == list(range(1, 57))
    assert series.episode(number).item_id == loose["id"]
    assert (series.total_hint, series.items_received) == (56, 56)
    assert (series.missing_numbers, series.early_end, series.skipped_items) == ([], None, [])
    assert series.warnings == [
        f"episode {number} {PLACED_TEXT} (between episodes {number - 1} and {number + 1})"
    ]
    assert [(p.cursor_asked, p.numbers[:1]) for p in _fills(series)] == [
        (str(number - 1), (number + 1,))
    ]
    assert _fetched(browser)[-1] == _list_url(number - 1)
    assert _line_of(series) == "complete: 56 of 56 (56 downloaded)"


def test_a_trailer_beside_an_episode_left_out_once_never_takes_its_number() -> None:
    """4.0.2, the review's case: TikTok's first answer leaves episode 3 out, and a trailer as long
    as an episode sits in its place (between episodes 2 and 4). Nothing is numbered before the gap
    filling: it asks TikTok again for episode 3, the answer brings episode 3 itself, and the trailer
    stays an item without a number — said, never downloaded."""
    trailer = _without_its_number(3, 20)
    trailer["id"] = "7699400000000009003"
    fake = _FakeList(20, leave=lambda n, cursor: n == 3 and cursor == 0, extras=((3, trailer),))
    browser = _listing_browser(fake)
    series = _paced(browser)
    assert series.numbers == list(range(1, 21))
    assert series.episode(3).item_id == _list_item(3, 20)["id"]
    assert [item.item_id for item in series.skipped_items] == [trailer["id"]]
    assert [(p.cursor_asked, p.numbers[:1]) for p in _fills(series)] == [("2", (3,))]
    assert series.warnings == ["TikTok listed 1 item DramaFetch could not read (no episode number)"]


def test_a_filling_answer_that_never_reaches_the_hole_numbers_nothing() -> None:
    """4.0.2, the review's case: TikTok's list never holds episode 3, a trailer as long as an
    episode sits in its place, and TikTok answers the gap filling's request for episode 3 with an
    earlier page again (episodes 1 and 2). That answer never reached episode 3's place, so it
    confirms nothing: the trailer stays an item without a number and episode 3 stays missing."""
    trailer = _without_its_number(3, 20)
    trailer["id"] = "7699400000000009003"
    earlier = {
        "statusCode": 0,
        "cursor": 2,
        "hasMore": True,
        "itemList": [_list_item(1, 20), _list_item(2, 20)],
    }
    fake = _FakeList(
        20,
        leave=lambda n, cursor: n == 3,
        extras=((3, trailer),),
        lose=lambda cursor, attempt: earlier if cursor == 2 else None,
    )
    series = _paced(_listing_browser(fake))
    assert series.numbers == [n for n in range(1, 21) if n != 3]
    assert [item.item_id for item in series.skipped_items] == [trailer["id"]]
    assert series.missing_numbers == [3]
    assert [(p.cursor_asked, p.numbers) for p in _fills(series)] == [("2", (1, 2))]
    assert not any(PLACED_TEXT in warning for warning in series.warnings)


@pytest.mark.parametrize("num_videos", [None, 66], ids=["no count", "a count of 66"])
def test_a_highlight_alone_with_the_last_number_is_the_last_episode(
    num_videos: int | None,
) -> None:
    """4.0.1: TikTok lists the drama's last episode (E66) only as an item it marks as a highlight
    (``IsHighlight`` and a ``LinkedEpisodeID``) — that item is episode 66: every episode listed,
    nothing missing, no filling request, no warning, the line complete — with no count and with
    TikTok's count of 66."""
    last = _marked(66, num_videos)
    last["dramaInfo"]["DramaVideoData"]["LinkedEpisodeID"] = "7699400000000000066"
    fake = _FakeList(
        66, num_videos=num_videos, leave=lambda number, cursor: number == 66, extras=((66, last),)
    )
    series = _paced(_listing_browser(fake))
    assert series.numbers == list(range(1, 67))
    episode_66 = series.episode(66)
    assert episode_66 is not None and episode_66.item_id == last["id"]
    assert (series.missing_numbers, series.early_end, series.skipped_items) == ([], None, [])
    assert series.warnings == []
    assert _fills(series) == []
    assert _line_of(series) == "complete: 66 of 66 (66 downloaded)"


def test_an_id_less_item_served_again_by_a_filling_page_counts_once() -> None:
    """3.0.1, the lead's D4: the id-less item before E15 comes back with the filling's page for
    E12 — one item, so TikTok's count still asks for the lost E66 and the warning says 1 item."""
    idless = {"dramaInfo": {"dramaID": SERIES_ID, "numVideos": 66, "DramaVideoData": {}}}
    fake = _FakeList(66, leave=lambda number, cursor: number in (12, 66), extras=((15, idless),))
    series = _paced(_listing_browser(fake))
    assert series.missing_numbers == [12]
    assert series.items_received == 65  # 64 episodes and the one id-less item, once
    assert [p.cursor_asked for p in _fills(series)] == ["11", "65"]
    assert series.skipped_items == [SkippedItem("no id")]
    assert "TikTok listed 1 item DramaFetch could not read (no id)" in series.warnings
    assert uncertain_text(66, 64, 1) in series.warnings


def test_an_empty_last_answer_to_an_announced_cursor_ends_nothing() -> None:
    """3.0.1, the lead's D5: TikTok's count unknown, the page of cursor 20 always an empty list
    with hasMore false — the early end stands, the filling asks once (cursor 20), the line says the
    list ended early; with TikTok's count the filling brings the rest; a last page that brings
    items of the series still ends the list."""
    fake = _FakeList(
        45, num_videos=None, lose=lambda cursor, attempt: EMPTY_END if cursor == 20 else None
    )
    series = _paced(_listing_browser(fake))
    assert series.numbers == list(range(1, 21))
    assert series.early_end == NOTHING_NEW_WARNING
    assert [(p.cursor_asked, p.listed, p.has_more) for p in _fills(series)] == [("20", True, False)]
    assert _line_of(series) == "incomplete: 20 of 20 — TikTok's list ended early after episode 20"
    counted = _FakeList(
        45, lose=lambda cursor, attempt: EMPTY_END if (cursor, attempt) == (20, 1) else None
    )
    whole = _paced(_listing_browser(counted))
    assert whole.numbers == list(range(1, 46))
    assert (whole.missing_numbers, whole.early_end) == ([], None)
    assert _line_of(whole) == "complete: 45 of 45 (45 downloaded)"
    ordinary = _paced(_listing_browser(_FakeList(25, num_videos=None)))
    assert (ordinary.early_end, ordinary.listing.fill_requests) == (None, 0)


def test_the_exact_multiple_end_is_complete_with_a_count_and_ended_early_without_one() -> None:
    """3.0.1, the lead's D5: 20 episodes; the page of cursor 10 holds 11-20 and still says hasMore;
    cursor 20 answers an empty list — no request more and complete with TikTok's count; without
    it, one filling request (cursor 20) and the line says the list ended early."""

    def lose(cursor: int, attempt: int) -> Any:
        if cursor == 10:
            items = [_list_item(number, None) for number in range(11, 21)]
            return {"statusCode": 0, "cursor": 20, "hasMore": True, "itemList": items}
        return EMPTY_END if cursor == 20 else None

    known = _paced(_listing_browser(_FakeList(20, lose=lose)))
    assert known.early_end == NOTHING_NEW_WARNING
    assert known.listing.fill_requests == 0
    assert _line_of(known) == "complete: 20 of 20 (20 downloaded)"
    unknown = _paced(_listing_browser(_FakeList(20, num_videos=None, lose=lose)))
    assert [p.cursor_asked for p in _fills(unknown)] == ["20"]
    assert _line_of(unknown) == "incomplete: 20 of 20 — TikTok's list ended early after episode 20"


@pytest.mark.parametrize("has_more", [True, False], ids=["with hasMore", "without hasMore"])
def test_a_repeated_page_is_an_early_end_and_the_filling_asks_past_the_highest(
    has_more: bool,
) -> None:
    """3.0.1, the lead's D6 (the review's T1): TikTok's count unknown, the page of cursor 10
    repeats the first one — with hasMore, or without (``page_ends_list``: a repeat ends nothing)
    —: the early end is NOTHING_NEW_WARNING, the filling asks for the page after the highest
    (cursor 10), and the line says the list ended early when it brings nothing."""

    def lose(cursor: int, attempt: int) -> Any:
        if cursor != 10:
            return None
        items = [_list_item(number, None) for number in range(1, 11)]
        return {"statusCode": 0, "cursor": 20, "hasMore": has_more, "itemList": items}

    series = _paced(_listing_browser(_FakeList(45, num_videos=None, lose=lose)))
    assert series.numbers == list(range(1, 11))
    assert series.early_end == NOTHING_NEW_WARNING
    assert [p.cursor_asked for p in _fills(series)] == ["10"]
    assert _line_of(series) == "incomplete: 10 of 10 — TikTok's list ended early after episode 10"


def test_a_page_with_more_and_no_cursor_is_an_early_end_and_the_filling_asks_past_the_highest() -> (
    None
):
    """3.0.1, the lead's D6 (the review's T1): TikTok's count unknown, the page of cursor 10 says
    hasMore without a cursor — the early end is NO_CURSOR_WARNING, the filling asks for the page
    after the highest (cursor 20): the line says the list ended early when it brings nothing — no
    list, or (D5's filling half) an empty last page: an answer to a filling request ends nothing,
    although no page announced its cursor —, and the drama is whole when it brings the rest."""

    def no_cursor(filled: Any) -> Any:
        """The page of cursor 10 says hasMore without a cursor; the filling's request (cursor
        20) gets ``filled`` when it is not None."""

        def lose(cursor: int, attempt: int) -> Any:
            if cursor == 10:
                items = [_list_item(number, None) for number in range(11, 21)]
                return {"statusCode": 0, "hasMore": True, "itemList": items}
            return filled if cursor == 20 else None

        return lose

    series = _paced(_listing_browser(_FakeList(45, num_videos=None, lose=no_cursor(NO_LIST))))
    assert series.early_end == NO_CURSOR_WARNING
    assert [(p.cursor_asked, p.listed) for p in _fills(series)] == [("20", False)]
    assert _line_of(series) == "incomplete: 20 of 20 — TikTok's list ended early after episode 20"
    empty = _paced(_listing_browser(_FakeList(45, num_videos=None, lose=no_cursor(EMPTY_END))))
    assert empty.early_end == NO_CURSOR_WARNING
    assert [(p.cursor_asked, p.listed, p.has_more) for p in _fills(empty)] == [("20", True, False)]
    assert _line_of(empty) == "incomplete: 20 of 20 — TikTok's list ended early after episode 20"
    whole = _paced(_listing_browser(_FakeList(25, num_videos=None, lose=no_cursor(None))))
    assert (whole.numbers, whole.early_end) == (list(range(1, 26)), None)
    assert _line_of(whole) == "complete: 25 of 25 (25 downloaded)"
