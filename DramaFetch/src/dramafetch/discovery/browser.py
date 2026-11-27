"""Browser strategy: a real Chromium (Playwright) opens the series page and we read the episode
list from the `/api/drama/episode/item_list/` responses the page itself requests, then page through
the rest by re-issuing that request from inside the page (same cookies, same signature params).

The page is opened at episode 1 whatever episode a link names (3.0.1). Once the pagination is
over, what the list still lacks — a hole, the episodes up to TikTok's count, the rest of a list
that ended early — is asked for again with the same request, paced the same, at most
`GAP_FILL_REQUESTS` times; what is still missing, and every page asked for (cursors and counts,
never a query), stays on the `Series` (`missing_numbers`, `early_end`, `listing`).

Nothing here unlocks anything or touches DRM: the browser only does what the user's own browser
does when they scroll the episode list. The only automation-related setting is a normal Chrome
user agent (Playwright's default says "HeadlessChrome"); Chromium is launched with its default
flags, so `navigator.webdriver` stays true — nothing hides that this is automation. If TikTok asks
for a verification, run with `--headful` and pass it yourself. Cookies loaded from `cookies_file`
go to the browser context and nowhere else; messages, logs and dumps carry payloads and token-free
URLs only.
"""

from __future__ import annotations

import hashlib
import json
import logging
import random
import re
import time
import traceback
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, quote, urlsplit

from dramafetch.catalog import (
    Listing,
    PagePayload,
    catalog_warnings,
    fill_covered,
    fill_target,
    find_item_lists,
    merge_pages,
    missing_numbers,
    page_ends_list,
    parse_detail_payload,
    parse_item_list_payload,
    series_item_ids,
)
from dramafetch.discovery.cookies import load_netscape_cookies
from dramafetch.discovery.static import (
    DEFAULT_BROWSER_CHANNEL,
    chrome_user_agent,
    cookie_domain_filter,
    is_login_url,
    looks_like_challenge,
    redact_tokens,
    safe_url,
    write_dump,
)
from dramafetch.errors import (
    ChallengeError,
    DiscoveryError,
    DramaFetchError,
    LoginRequiredError,
    RateLimitedError,
)
from dramafetch.models import (
    MAX_EPISODE_NUMBER,
    DiscoveryOptions,
    ListingPage,
    ListingRecord,
    Series,
    SeriesRef,
)
from dramafetch.urls import series_page_url

if TYPE_CHECKING:
    from playwright.sync_api import Browser, BrowserContext, Page, Response, ViewportSize

log = logging.getLogger(__name__)

ITEM_LIST_MARKER = "/api/drama/episode/item_list"
DETAIL_MARKER = "/api/drama/detail"
VIEWPORT: ViewportSize = {"width": 1280, "height": 900}
POLL_INTERVAL_S = 0.25
CHALLENGE_CHECK_INTERVAL_S = 2.0
DETAIL_GRACE_S = 2.0
SCROLL_ROUNDS_WITHOUT_NEWS = 4
SCROLL_WHEEL_PX = 1500
#: The ``ChallengeError`` of a captcha met while the list is resolved — before the first page,
#: during the in-page pagination or during the scroll fallback alike: a captcha is a refusal
#: (a stop and the cooldown), never a partial list to download from, and DramaFetch never solves
#: it (the extension's ``CHALLENGE_MESSAGE`` names its own way out instead of ``--headful``).
CHALLENGE_MESSAGE = (
    "TikTok is asking for a verification (captcha) instead of the series: "
    "after the cooldown, run again with --headful and solve it in the window"
)
#: The pause before the next episode-list page (an in-page fetch or a scroll round) is
#: ``DiscoveryOptions.page_delay_s`` times a factor drawn uniformly from this range, so paging
#: never ticks like a metronome: with the default 0.8 s that is 0.8-1.6 s. ``page_delay_s`` (and
#: the hidden ``--page-delay``) stays the minimum; the random source and the sleep are injectable
#: (``PlaywrightDiscovery(rng=..., sleep=...)``), so no test waits for real.
PAGE_DELAY_JITTER = (1.0, 2.0)
RATE_LIMIT_MESSAGE = (
    "TikTok is rate-limiting this address (HTTP 429 on the episode list): wait 30-60 minutes "
    "before trying again"
)
#: The warnings of the pagination's fallbacks — each one an early end of the list
#: (``Series.early_end``) until a later page says ``hasMore`` false — word for word the extension's
#: (``discovery.js``; parity-tested), next to the max-pages warning (``_max_pages_warning``).
NO_CURSOR_WARNING = (
    "TikTok reported more episodes without a usable cursor; scrolled the page instead"
)
NO_LIST_WARNING = "in-page pagination fetch returned no episode list; scrolled the page instead"
NOTHING_NEW_WARNING = (
    "in-page pagination returned no new episodes although TikTok reported more; "
    "scrolled the page instead"
)
#: The gap filling (3.0.1, the owner's report of 2026-11-27): once the pagination is over, the
#: listing asks TikTok AGAIN for the pages that should hold what it lacks — a hole below the
#: highest number listed, the numbers up to TikTok's count less the drama's other items received,
#: once the page after the highest number listed when TikTok counts more than it can place, the
#: rest of a list that ended early (``catalog.fill_target``) — with the very request the
#: pagination makes (the template with ``cursor`` = the first missing number - 1 and the usual
#: ``count``), after the usual list-page pause, one at a time, and at most this many per listing
#: (the extension's ``discovery.GAP_FILL_REQUESTS``, parity-tested). A 429 or a captcha stops the
#: listing as anywhere else; an answer that brings no list ends the filling; what is still missing
#: stays in ``Series.missing_numbers`` / ``Series.early_end`` and is said.
GAP_FILL_REQUESTS = 4
# ``ListingPage.kind`` of what this strategy reads (``models.LISTING_KINDS``): the page's own
# requests read off the wire, the pagination's next pages, the gap filling's requests.
_PAGE = "page"
_NEXT = "next"
_FILL = "fill"

# Re-issues an item_list request from inside the page: same cookies, same signature parameters.
# Called as `page.evaluate(FETCH_JS, [url, timeout_ms])`. A non-2xx answer (whatever its body) and
# a non-JSON body come back as a `__dramafetch_status` marker, so a 429 is recognised even with a
# JSON body; the timeout aborts a stalled request (marker with status 0) so that `--timeout` bounds
# every page, not only the first, and the failure takes the fallback path instead of hanging.
FETCH_JS = """async ([u, ms]) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(u, {credentials: 'include', signal: controller.signal});
    const t = await r.text();
    if (!r.ok) { return {"__dramafetch_status": r.status, "__dramafetch_text": t.slice(0, 200)} }
    try { return JSON.parse(t) } catch {
      return {"__dramafetch_status": r.status, "__dramafetch_text": t.slice(0, 200)}
    }
  } catch (e) {
    return {"__dramafetch_status": 0, "__dramafetch_text": String((e && e.name) || e).slice(0, 200)}
  } finally { clearTimeout(timer); }
}"""
# Scrolls the episode list (or the first scrollable ancestor of an episode link) and the window.
SCROLL_JS = """() => {
  let el = document.querySelector('[data-testid="short-drama-detail"]');
  if (!el) {
    const links = document.querySelectorAll('a[href*="/shortdrama/episode/"], a[href*="/video/"]');
    outer: for (const a of links) {
      for (let p = a.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        const scrolls = /(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight;
        if (scrolls) { el = p; break outer; }
      }
    }
  }
  if (el) { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); }
  window.scrollTo(0, document.body.scrollHeight);
  return el ? (el.getAttribute('data-testid') || el.tagName.toLowerCase()) : null;
}"""
_BODY_TEXT_JS = "() => (document.body && document.body.innerText) || ''"


@dataclass
class _Capture:
    """Everything the page gave us, in arrival order: payloads only (no headers, no cookies)."""

    series_id: str
    payloads: list[Any] = field(default_factory=list)  # item_list payloads, dump order
    pages: list[PagePayload] = field(default_factory=list)
    item_ids: set[str] = field(default_factory=set)
    # the ids of the series' items any page brought (``catalog.page_ends_list``)
    seen_ids: set[str] = field(default_factory=set)
    seen_payloads: set[str] = field(default_factory=set)
    template_url: str | None = None  # last item_list request URL; stays in memory only
    pending: list[tuple[str, Any]] = field(default_factory=list)
    detail: Any | None = None
    page_url: str = ""
    warnings: list[str] = field(default_factory=list)
    # the warning of the fallback the pagination stopped on, None while it ended on a last page
    ended_early: str | None = None
    # a page said the list is over (``hasMore`` false, and no mere repeat): at any time
    end_reached: bool = False
    # the cursors pages announced with ``hasMore`` true: an answer to one of them with no item of
    # the series ends nothing (``catalog.page_ends_list``'s ``expected_more``, 3.0.1)
    announced: set[str] = field(default_factory=set)
    # the list request's scheme, host and path (never its query), and every page asked or read
    endpoint: str | None = None
    listing: list[ListingPage] = field(default_factory=list)

    @property
    def early_end(self) -> str | None:
        """Why the list ended early — the fallback the pagination stopped on — while no page has
        said since that the list is over; None otherwise."""
        return None if self.end_reached else self.ended_early

    def ingest(self, url: str, payload: Any, *, fill: bool = False) -> tuple[PagePayload, int]:
        """Parse one item_list payload; return it with the number of episodes not seen before.

        A payload seen before (the listener also sees the fetches we issue ourselves, and the
        page may re-request a page) is parsed but not counted or stored again. ``fill``: the
        answer to a gap-filling request, which more was expected of (3.0.1).
        """
        page, new, _fresh = self._take(url, payload, fill=fill)
        return page, new

    def _take(self, url: str, payload: Any, *, fill: bool = False) -> tuple[PagePayload, int, bool]:
        """:meth:`ingest`, and whether the payload was new (stored)."""
        page = parse_item_list_payload(payload, self.series_id)
        key = _payload_key(payload)
        if key in self.seen_payloads:
            return page, 0, False
        self.seen_payloads.add(key)
        self.payloads.append(payload)
        self.pages.append(page)
        self.template_url = url
        if self.endpoint is None:
            self.endpoint = safe_url(url)
        # An answer to a cursor an earlier page announced with hasMore true, or to a gap-filling
        # request, that brings no item of the series ends nothing (3.0.1, the review's L5): the
        # early end the pagination or the filling records stands.
        expected_more = fill or _query_value(url, "cursor") in self.announced
        if page_ends_list(
            page, self.seen_ids, listed=_has_item_list(payload), expected_more=expected_more
        ):
            self.end_reached = True
        if page.has_more and page.cursor is not None:
            self.announced.add(str(page.cursor))
        self.seen_ids.update(series_item_ids(page))
        new_ids = {episode.item_id for episode in page.episodes} - self.item_ids
        self.item_ids |= new_ids
        return page, len(new_ids), True

    def drain(self) -> int:
        """Ingest what the response listener queued meanwhile; return the count of new episodes.
        Each new payload that holds a list is a page the series page asked for itself (``page``
        in the listing): the echoes of our own requests are payloads seen already, and an answer
        without a list — TikTok's error to one of ours, read off the wire too — was recorded
        where we asked for it."""
        new = 0
        while self.pending:
            url, payload = self.pending.pop(0)
            page, added, fresh = self._take(url, payload)
            if fresh and _has_item_list(payload):
                self.note(_PAGE, url, page)
            new += added
        return new

    def note(self, kind: str, url: str, page: PagePayload | None) -> None:
        """Record one page of the listing (``Series.listing``): the ``cursor`` and ``count`` the
        request asked — read from its URL, nothing else of it — and what the answer said; ``page``
        None for an answer that held no list."""
        cursor_asked, count_asked = _query_value(url, "cursor"), _query_value(url, "count")
        if page is None:
            self.listing.append(ListingPage(kind, cursor_asked, count_asked, listed=False))
            return
        self.listing.append(
            ListingPage(
                kind,
                cursor_asked,
                count_asked,
                listed=True,
                items=page.seen_items,
                numbers=tuple(episode.number for episode in page.episodes),
                has_more=page.has_more,
                cursor=page.cursor,
            )
        )

    def end_early(self, warning: str) -> None:
        """The pagination stops on a fallback: its warning, and the early end (the first one)."""
        self.warnings.append(warning)
        if self.ended_early is None:
            self.ended_early = warning

    def count(self, listing: Listing) -> int | None:
        """TikTok's count of the series' episodes: the detail's total, else the items'
        ``numVideos`` (``_build_series`` reads it the same way)."""
        if self.detail is not None:
            total = parse_detail_payload(self.detail, self.series_id)[1]
            if total is not None:
                return total
        return listing.total_hint

    def on_response(self, response: Response) -> None:
        url = response.url
        if ITEM_LIST_MARKER in url:
            payload = _json_or_none(response)
            if payload is not None:
                self.pending.append((url, payload))
        elif DETAIL_MARKER in url:
            payload = _json_or_none(response)
            if payload is not None:
                self.detail = payload


class PlaywrightDiscovery:
    """Resolve a series by letting a real Chromium load the page and paging its episode API."""

    def __init__(
        self,
        playwright_factory: Callable[[], Any] | None = None,
        *,
        rng: random.Random | None = None,
        sleep: Callable[[Page, float], None] | None = None,
    ) -> None:
        """``rng`` draws the jitter of the pause between episode-list pages and ``sleep(page,
        seconds)`` waits it out (default: :func:`_pause`, Playwright's own clock); tests inject a
        fixed ``random.Random`` and a recording fake so nothing waits for real."""
        self._factory = playwright_factory
        self._rng = rng if rng is not None else random.Random()
        self._sleep = sleep if sleep is not None else _pause

    def discover(self, ref: SeriesRef, options: DiscoveryOptions) -> Series:
        factory = self._factory if self._factory is not None else _default_factory()
        capture = _Capture(series_id=ref.series_id)
        try:
            with factory() as playwright:
                browser: Browser = self._launch(playwright, options)
                try:
                    context = self._new_context(browser, options, capture)
                    try:
                        self._capture_series(context.new_page(), ref, options, capture)
                    finally:
                        context.close()
                finally:
                    browser.close()
        except DramaFetchError:
            raise
        except Exception as exc:
            raise _wrap(exc) from exc
        finally:
            if options.dump_dir is not None:
                _dump(options.dump_dir, capture)
        return _build_series(ref, options, capture)

    def discover_in_page(self, page: Page, ref: SeriesRef, options: DiscoveryOptions) -> Series:
        """Resolve a series through a page the caller already opened, in the caller's browser.

        The browser download engine refreshes expired play URLs this way, inside the session that
        is downloading, instead of launching a second browser. The page's context supplies the
        cookies and the user agent, so ``options.cookies_file`` only shapes the error messages and
        the browser/channel/headful settings are the caller's. Everything else — waiting for the
        episode list, login and challenge detection, pagination, ``dump_dir``, the errors — is
        exactly :meth:`discover`. The page is left open for the caller to close.
        """
        capture = _Capture(series_id=ref.series_id)
        try:
            self._capture_series(page, ref, options, capture)
        except DramaFetchError:
            raise
        except Exception as exc:
            raise _wrap(exc) from exc
        finally:
            if options.dump_dir is not None:
                _dump(options.dump_dir, capture)
        return _build_series(ref, options, capture)

    def _capture_series(
        self, page: Page, ref: SeriesRef, options: DiscoveryOptions, capture: _Capture
    ) -> None:
        """Open the series page and page through its episode list, then ask again for what it
        lacks (:meth:`_fill_gaps`, once TikTok's count from the detail is in), filling
        ``capture``."""
        page.on("response", capture.on_response)
        self._open_series_page(page, ref, options, capture)
        self._paginate(page, options, capture)
        self._await_detail(page, capture)
        self._fill_gaps(page, options, capture)
        capture.page_url = safe_url(page.url)

    # -- steps -----------------------------------------------------------------------------------

    def _launch(self, playwright: Any, options: DiscoveryOptions) -> Browser:
        kwargs: dict[str, Any] = {"headless": not options.headful}
        if options.executable_path is not None:
            kwargs["executable_path"] = str(options.executable_path)
        else:
            # The full browser by default, never Playwright's headless shell (see
            # DEFAULT_BROWSER_CHANNEL); `chrome` / `msedge` launch the installed browser.
            kwargs["channel"] = options.browser_channel or DEFAULT_BROWSER_CHANNEL
        browser: Browser = playwright.chromium.launch(**kwargs)
        return browser

    def _new_context(
        self, browser: Browser, options: DiscoveryOptions, capture: _Capture
    ) -> BrowserContext:
        # No `locale`: Chromium keeps the machine's own, as the user's Chrome does (a forced
        # en-US gave an `Accept-Language: en-US` no real Chrome sends).
        context = browser.new_context(
            user_agent=chrome_user_agent(browser.version),
            viewport=VIEWPORT,
        )
        if options.cookies_file is None:
            return context
        domain = cookie_domain_filter(options.base_url)
        try:
            cookies = load_netscape_cookies(options.cookies_file, domain_filter=domain)
        except (OSError, ValueError) as exc:
            raise DiscoveryError(f"cookies file: {_one_line(exc)}") from exc
        if not cookies:
            capture.warnings.append(
                f"cookies file has no unexpired cookies for {domain}; continuing without a session"
            )
            return context
        cookie_params: Any = cookies  # Playwright types this with its private SetCookieParam
        try:
            context.add_cookies(cookie_params)
        except Exception as exc:
            # Fixed text on purpose: a protocol error could echo the cookie it rejected.
            raise DiscoveryError(
                f"could not load the cookies into the browser ({exc.__class__.__name__})"
            ) from None
        return context

    def _open_series_page(
        self, page: Page, ref: SeriesRef, options: DiscoveryOptions, capture: _Capture
    ) -> None:
        # Episode 1's page whatever episode the link names (3.0.1): a page opened at a later
        # episode may ask first for the window that holds it, and the pages before it were never
        # asked for. The episode in the link picks nothing — a paste downloads the whole drama.
        url = series_page_url(ref.series_id, 1, options.base_url)
        timeout_ms = max(1, int(options.timeout_s * 1000))
        page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        deadline = time.monotonic() + options.timeout_s
        next_challenge_check = 0.0
        while True:
            capture.drain()
            capture.page_url = safe_url(page.url)
            if capture.pages:
                return
            if is_login_url(page.url):
                raise LoginRequiredError(
                    "TikTok redirected to its login page: pass --cookies cookies.txt exported "
                    "from a logged-in browser"
                )
            now = time.monotonic()
            if now >= next_challenge_check:
                next_challenge_check = now + CHALLENGE_CHECK_INTERVAL_S
                if _page_shows_challenge(page):
                    raise ChallengeError(CHALLENGE_MESSAGE)
            if now >= deadline:
                if options.cookies_file is None:
                    raise LoginRequiredError(
                        "no episode list arrived; TikTok usually requires a logged-in session: "
                        "pass --cookies cookies.txt"
                    )
                raise DiscoveryError(
                    f"no episode list within {options.timeout_s:g} s (page: {capture.page_url})"
                )
            page.wait_for_timeout(POLL_INTERVAL_S * 1000)

    def _paginate(self, page: Page, options: DiscoveryOptions, capture: _Capture) -> None:
        """Primary pagination: re-fetch the captured item_list URL with the next cursor. Each
        fallback it stops on is an early end of the list (``_Capture.end_early``) until a later
        page says the list is over."""
        current = capture.pages[-1]
        previous_cursor: int | str | None = None
        while current.has_more:
            if len(capture.pages) >= options.max_pages:
                capture.end_early(_max_pages_warning(options.max_pages))
                return
            cursor, template = current.cursor, capture.template_url
            if cursor is None or template is None or cursor == previous_cursor:
                capture.end_early(NO_CURSOR_WARNING)
                self._scroll_for_more(page, options, capture)
                return
            next_url = _with_query_params(
                template, {"cursor": str(cursor), "count": str(options.page_count)}
            )
            self._page_pause(page, options)
            payload = self._fetch_in_page(page, next_url, options.timeout_s)
            if payload is None:
                capture.note(_NEXT, next_url, None)
                self._stop_if_challenged(page)  # a wall already up is a refusal, not a fallback
                capture.end_early(NO_LIST_WARNING)
                self._scroll_for_more(page, options, capture)
                return
            previous_cursor = cursor
            current, new = capture.ingest(next_url, payload)
            capture.note(_NEXT, next_url, current)
            new += capture.drain()
            if new == 0:
                # The previous page said hasMore, yet the re-issued request added nothing: TikTok
                # may answer a re-signed request with an empty list. Let the page itself load the
                # rest the way a user's scrolling would (bounded by SCROLL_ROUNDS_WITHOUT_NEWS).
                capture.end_early(NOTHING_NEW_WARNING)
                self._scroll_for_more(page, options, capture)
                return

    def _fill_gaps(self, page: Page, options: DiscoveryOptions, capture: _Capture) -> None:
        """Ask TikTok again, once the pagination is over, for the pages that should hold what the
        listing lacks (:data:`GAP_FILL_REQUESTS`): the next number :func:`catalog.fill_target`
        names — a hole, a number up to TikTok's count, the rest of a list that ended early —
        through the pagination's own request (the captured template with ``cursor`` = that
        number - 1 and ``count`` = ``page_count``), after the list-page pause, one at a time;
        each answer is ingested like any page and covers what it was asked for
        (:func:`catalog.fill_covered`), so no number is asked for twice. An HTTP 429 raises
        ``RateLimitedError`` and a captcha ``ChallengeError``, as in the pagination; an answer
        that brings no list ends the filling."""
        covered: list[tuple[int, int | None]] = []
        for _ in range(GAP_FILL_REQUESTS):
            capture.drain()
            listing = merge_pages(capture.pages)
            target = fill_target(
                (episode.number for episode in listing.episodes),
                capture.count(listing),
                listing.items_received,
                early_end=capture.early_end is not None,
                covered=covered,
                limit=MAX_EPISODE_NUMBER,
                highlights=listing.highlight_numbers,
            )
            if target is None or capture.template_url is None:
                return
            url = _with_query_params(
                capture.template_url,
                {"cursor": str(target - 1), "count": str(options.page_count)},
            )
            self._page_pause(page, options)
            payload = self._fetch_in_page(page, url, options.timeout_s)
            if payload is None:
                capture.note(_FILL, url, None)
                self._stop_if_challenged(page)  # a wall is a refusal, as during the pagination
                log.debug("the gap filling brought no episode list; the filling ends")
                return
            answer, _ = capture.ingest(url, payload, fill=True)
            capture.note(_FILL, url, answer)
            covered.append(fill_covered(target, options.page_count, answer))

    def _fetch_in_page(self, page: Page, url: str, timeout_s: float) -> Any | None:
        """The payload of an item_list request issued from inside the page, or None when the
        answer is unusable (the caller then scrolls); HTTP 429 stops discovery altogether."""
        timeout_ms = max(1, int(timeout_s * 1000))
        try:
            payload = page.evaluate(FETCH_JS, [url, timeout_ms])
        except Exception as exc:
            log.debug("in-page fetch failed: %s", _one_line(exc))
            return None
        if not isinstance(payload, dict) or "__dramafetch_status" in payload:
            status = payload.get("__dramafetch_status") if isinstance(payload, dict) else None
            if status == 429:
                raise RateLimitedError(RATE_LIMIT_MESSAGE)
            log.debug("in-page fetch did not return JSON (HTTP status %s)", status)
            return None
        if not _has_item_list(payload):
            log.debug("in-page fetch returned JSON without an item list")
            return None
        return payload

    def _scroll_for_more(self, page: Page, options: DiscoveryOptions, capture: _Capture) -> None:
        """Fallback pagination: scroll the episode list and collect what the page loads itself."""
        quiet_rounds = 0
        while quiet_rounds < SCROLL_ROUNDS_WITHOUT_NEWS:
            if len(capture.pages) >= options.max_pages:
                capture.warnings.append(_max_pages_warning(options.max_pages))
                return
            try:
                page.evaluate(SCROLL_JS)
                page.mouse.wheel(0, SCROLL_WHEEL_PX)
            except Exception as exc:
                log.debug("scrolling failed: %s", _one_line(exc))
                return
            self._page_pause(page, options)
            if capture.drain() > 0:
                quiet_rounds = 0
                continue
            quiet_rounds += 1
            # A round that loaded nothing may be the verification wall the page raises when ITS
            # own list request is refused: a captcha is a refusal (stop, cooldown), never a
            # partial list to download from.
            self._stop_if_challenged(page)

    @staticmethod
    def _stop_if_challenged(page: Page) -> None:
        """Raise ``ChallengeError`` when the page shows TikTok's verification wall — asked after an
        in-page fetch returned nothing usable and after every scroll round that loaded nothing,
        so a captcha met after the first page stops the run like one met before it."""
        if _page_shows_challenge(page):
            raise ChallengeError(CHALLENGE_MESSAGE)

    def _page_pause(self, page: Page, options: DiscoveryOptions) -> None:
        """Wait before asking for the next episode-list page: ``page_delay_s`` times a random
        1.0-2.0 (:func:`page_pause_s`), through the injectable sleep."""
        seconds = page_pause_s(options.page_delay_s, self._rng)
        log.debug("pausing %.2f s before the next episode-list page", seconds)
        self._sleep(page, seconds)

    def _await_detail(self, page: Page, capture: _Capture) -> None:
        """Give the series detail response a moment to arrive if the page has not sent it yet."""
        deadline = time.monotonic() + DETAIL_GRACE_S
        while capture.detail is None and time.monotonic() < deadline:
            page.wait_for_timeout(POLL_INTERVAL_S * 1000)
        capture.drain()


# -- module helpers ------------------------------------------------------------------------------


def _default_factory() -> Callable[[], Any]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise DiscoveryError(
            "playwright is not installed: pip install playwright && playwright install chromium"
        ) from exc
    return sync_playwright


def _build_series(ref: SeriesRef, options: DiscoveryOptions, capture: _Capture) -> Series:
    """The series of the captured pages (``catalog.merge_pages``: one episode per number by the
    preference order; the items left out and the skipped ones said in the warnings), the detail's
    name and count — the items' ``numVideos`` when the detail gives none —, and what the listing
    still lacks once the gap filling is over: the missing numbers (``catalog.missing_numbers``),
    the early end (``_Capture.early_end``) and the pages it asked for (``Series.listing``)."""
    listing = merge_pages(capture.pages)
    episodes = listing.episodes
    name = (
        parse_detail_payload(capture.detail, ref.series_id)[0]
        if capture.detail is not None
        else None
    )
    total = capture.count(listing)
    if name is None:
        name = next((e.series_name for e in episodes if e.series_name), None)
    if not episodes:
        seen = sum(page.seen_items for page in capture.pages)
        if seen == 0:
            hint = (
                "a logged-in session is required: pass --cookies cookies.txt"
                if options.cookies_file is None
                else "the cookies may have expired: export a fresh cookies.txt"
            )
            raise LoginRequiredError(f"TikTok returned an empty episode list; {hint}")
        raise DiscoveryError(
            f"TikTok listed {seen} items but none belongs to series {ref.series_id} "
            "(is this a short-drama series URL?)"
        )
    warnings = [
        *capture.warnings,
        *catalog_warnings(
            episodes,
            total,
            duplicates=listing.duplicates,
            skipped=listing.skipped,
            items_received=listing.items_received,
            highlights=listing.highlight_numbers,
        ),
    ]
    return Series(
        series_id=ref.series_id,
        name=name,
        episodes=episodes,
        total_hint=total,
        warnings=warnings,
        skipped_items=listing.skipped,
        items_received=listing.items_received,
        highlight_numbers=listing.highlight_numbers,
        missing_numbers=missing_numbers(
            (episode.number for episode in episodes),
            total,
            listing.items_received,
            limit=MAX_EPISODE_NUMBER,
            highlights=listing.highlight_numbers,
        ),
        early_end=capture.early_end,
        listing=ListingRecord(endpoint=capture.endpoint, pages=list(capture.listing)),
    )


def _dump(dump_dir: Path, capture: _Capture) -> None:
    try:
        dump_dir.mkdir(parents=True, exist_ok=True)
        for index, payload in enumerate(capture.payloads, start=1):
            write_dump(dump_dir / f"item_list_{index}.json", payload)
        if capture.detail is not None:
            write_dump(dump_dir / "detail.json", capture.detail)
        (dump_dir / "page_url.txt").write_text(capture.page_url + "\n", encoding="utf-8")
    except OSError as exc:
        log.warning("could not write the raw dump to %s: %s", dump_dir, _one_line(exc))


def _wrap(exc: Exception) -> DiscoveryError:
    """Any Playwright failure becomes a one-line DiscoveryError; details go to the debug log."""
    detail = "".join(traceback.format_exception(exc))
    log.debug("browser discovery failed:\n%s", redact_tokens(detail))
    first = _one_line(exc)
    hint = ""
    if "executable doesn't exist" in first.lower() or "executable_path" in first.lower():
        hint = (
            " (run `playwright install chromium`, or pass --browser-channel chrome "
            "or --browser-path PATH)"
        )
    return DiscoveryError(f"browser discovery failed: {first}{hint}")


def _one_line(exc: BaseException) -> str:
    text = redact_tokens(str(exc)).strip() or exc.__class__.__name__
    return text.splitlines()[0][:300]


def _max_pages_warning(max_pages: int) -> str:
    return f"pagination stopped at max_pages ({max_pages}); the list may be incomplete"


def page_pause_s(page_delay_s: float, rng: random.Random) -> float:
    """The randomised pause before the next episode-list page: ``page_delay_s`` — the minimum —
    times a factor drawn uniformly from :data:`PAGE_DELAY_JITTER` (0.8 s -> 0.8-1.6 s); a zero or
    negative delay (tests against the fake server) stays 0."""
    low, high = PAGE_DELAY_JITTER
    return max(0.0, page_delay_s) * rng.uniform(low, high)


def _pause(page: Page, seconds: float) -> None:
    """Sleep while still dispatching Playwright events (`time.sleep` would stall the listener)."""
    page.wait_for_timeout(max(0.0, seconds) * 1000)


def _page_shows_challenge(page: Page) -> bool:
    try:
        text = page.evaluate(_BODY_TEXT_JS)
        title = page.title()
    except Exception:  # navigating or context destroyed: check again next round
        return False
    return looks_like_challenge(f"{title}\n{text}")


def _payload_key(payload: Any) -> str:
    """Content hash used to ingest each page once, whichever way it reached us."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.blake2b(canonical.encode("utf-8"), digest_size=16).hexdigest()


def _json_or_none(response: Response) -> Any | None:
    try:
        return response.json()
    except Exception:
        return None


def _has_item_list(payload: Any) -> bool:
    """Same definition of "an item list" as the parser (``itemList`` or ``item_list``, nested)."""
    return bool(find_item_lists(payload))


def _query_value(url: str, name: str) -> str | None:
    """The first value of query parameter ``name`` (percent-decoded), or None — a request's
    ``cursor`` or ``count`` for the listing record; nothing else of the query is read."""
    values = parse_qs(urlsplit(url).query, keep_blank_values=True).get(name)
    return values[0] if values else None


def _with_query_params(url: str, params: dict[str, str]) -> str:
    """Replace (or append) query parameters in place, leaving every other parameter byte-for-byte
    untouched: the rest of the query carries TikTok's signature parameters."""
    parts = urlsplit(url)
    query = parts.query
    for key, value in params.items():
        encoded = f"{key}={quote(value, safe='')}"
        match = re.search(rf"(^|&){re.escape(key)}=[^&]*", query)
        if match is not None:
            query = f"{query[: match.start()]}{match.group(1)}{encoded}{query[match.end() :]}"
        else:
            query = f"{query}&{encoded}" if query else encoded
    return parts._replace(query=query).geturl()
