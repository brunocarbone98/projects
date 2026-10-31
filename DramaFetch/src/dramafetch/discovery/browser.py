"""Browser strategy: a real Chromium (Playwright) opens the series page and we read the episode
list from the `/api/drama/episode/item_list/` responses the page itself requests, then page through
the rest by re-issuing that request from inside the page (same cookies, same signature params).

Nothing here hides automation beyond a normal Chrome user agent, unlocks anything or touches DRM:
the browser only does what the user's own browser does when they scroll the episode list. Cookies
loaded from `cookies_file` go to the browser context and nowhere else; messages, logs and dumps
carry payloads and token-free URLs only.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
import traceback
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlsplit

from dramafetch.catalog import (
    PagePayload,
    catalog_warnings,
    merge_episodes,
    parse_detail_payload,
    parse_item_list_payload,
)
from dramafetch.discovery.cookies import load_netscape_cookies
from dramafetch.discovery.static import (
    chrome_user_agent,
    cookie_domain_filter,
    is_login_url,
    looks_like_challenge,
    redact_tokens,
    safe_url,
    write_dump,
)
from dramafetch.errors import ChallengeError, DiscoveryError, DramaFetchError, LoginRequiredError
from dramafetch.models import DiscoveryOptions, Series, SeriesRef
from dramafetch.urls import series_page_url

if TYPE_CHECKING:
    from playwright.sync_api import Browser, BrowserContext, Page, Response, ViewportSize

log = logging.getLogger(__name__)

ITEM_LIST_MARKER = "/api/drama/episode/item_list"
DETAIL_MARKER = "/api/drama/detail"
AUTOMATION_FLAG = "--disable-blink-features=AutomationControlled"
VIEWPORT: ViewportSize = {"width": 1280, "height": 900}
POLL_INTERVAL_S = 0.25
CHALLENGE_CHECK_INTERVAL_S = 2.0
DETAIL_GRACE_S = 2.0
SCROLL_ROUNDS_WITHOUT_NEWS = 4
SCROLL_WHEEL_PX = 1500
_MAX_DEPTH = 12

# Re-issues an item_list request from inside the page: same cookies, same signature parameters.
FETCH_JS = (
    "async (u) => { const r = await fetch(u, {credentials: 'include'}); const t = await r.text(); "
    'try { return JSON.parse(t) } catch { return {"__dramafetch_status": r.status, '
    '"__dramafetch_text": t.slice(0, 200)} } }'
)
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
    seen_payloads: set[str] = field(default_factory=set)
    template_url: str | None = None  # last item_list request URL; stays in memory only
    pending: list[tuple[str, Any]] = field(default_factory=list)
    detail: Any | None = None
    page_url: str = ""
    warnings: list[str] = field(default_factory=list)

    def ingest(self, url: str, payload: Any) -> tuple[PagePayload, int]:
        """Parse one item_list payload; return it with the number of episodes not seen before.

        A payload seen before (the listener also sees the fetches we issue ourselves, and the
        page may re-request a page) is parsed but not counted or stored again.
        """
        page = parse_item_list_payload(payload, self.series_id)
        key = _payload_key(payload)
        if key in self.seen_payloads:
            return page, 0
        self.seen_payloads.add(key)
        self.payloads.append(payload)
        self.pages.append(page)
        self.template_url = url
        new_ids = {episode.item_id for episode in page.episodes} - self.item_ids
        self.item_ids |= new_ids
        return page, len(new_ids)

    def drain(self) -> int:
        """Ingest what the response listener queued meanwhile; return the count of new episodes."""
        new = 0
        while self.pending:
            url, payload = self.pending.pop(0)
            new += self.ingest(url, payload)[1]
        return new

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

    def __init__(self, playwright_factory: Callable[[], Any] | None = None) -> None:
        self._factory = playwright_factory

    def discover(self, ref: SeriesRef, options: DiscoveryOptions) -> Series:
        factory = self._factory if self._factory is not None else _default_factory()
        capture = _Capture(series_id=ref.series_id)
        try:
            with factory() as playwright:
                browser: Browser = self._launch(playwright, options)
                try:
                    context = self._new_context(browser, options, capture)
                    try:
                        page = context.new_page()
                        page.on("response", capture.on_response)
                        self._open_series_page(page, ref, options, capture)
                        self._paginate(page, options, capture)
                        self._await_detail(page, capture)
                        capture.page_url = safe_url(page.url)
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

    # -- steps -----------------------------------------------------------------------------------

    def _launch(self, playwright: Any, options: DiscoveryOptions) -> Browser:
        kwargs: dict[str, Any] = {"headless": not options.headful, "args": [AUTOMATION_FLAG]}
        if options.executable_path is not None:
            kwargs["executable_path"] = str(options.executable_path)
        elif options.browser_channel:
            kwargs["channel"] = options.browser_channel
        browser: Browser = playwright.chromium.launch(**kwargs)
        return browser

    def _new_context(
        self, browser: Browser, options: DiscoveryOptions, capture: _Capture
    ) -> BrowserContext:
        context = browser.new_context(
            user_agent=chrome_user_agent(browser.version),
            locale="en-US",
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
        url = series_page_url(ref.series_id, ref.episode_hint or 1, options.base_url)
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
                    raise ChallengeError(
                        "TikTok is asking for a verification (captcha) instead of the series: "
                        "run again with --headful and solve it in the window"
                    )
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
        """Primary pagination: re-fetch the captured item_list URL with the next cursor."""
        current = capture.pages[-1]
        previous_cursor: int | str | None = None
        while current.has_more:
            if len(capture.pages) >= options.max_pages:
                capture.warnings.append(_max_pages_warning(options.max_pages))
                return
            cursor, template = current.cursor, capture.template_url
            if cursor is None or template is None or cursor == previous_cursor:
                capture.warnings.append(
                    "TikTok reported more episodes without a usable cursor; "
                    "scrolled the page instead"
                )
                self._scroll_for_more(page, options, capture)
                return
            next_url = _with_query_params(
                template, {"cursor": str(cursor), "count": str(options.page_count)}
            )
            _pause(page, options.page_delay_s)
            payload = self._fetch_in_page(page, next_url)
            if payload is None:
                capture.warnings.append(
                    "in-page pagination fetch returned no episode list; scrolled the page instead"
                )
                self._scroll_for_more(page, options, capture)
                return
            previous_cursor = cursor
            current, new = capture.ingest(next_url, payload)
            capture.drain()
            if new == 0 and current.has_more:
                capture.warnings.append(
                    "pagination stopped: TikTok kept reporting more episodes but returned none "
                    "that were new"
                )
                return

    def _fetch_in_page(self, page: Page, url: str) -> Any | None:
        try:
            payload = page.evaluate(FETCH_JS, url)
        except Exception as exc:
            log.debug("in-page fetch failed: %s", _one_line(exc))
            return None
        if not isinstance(payload, dict) or "__dramafetch_status" in payload:
            status = payload.get("__dramafetch_status") if isinstance(payload, dict) else None
            log.debug("in-page fetch did not return JSON (HTTP status %s)", status)
            return None
        if not _has_item_list(payload):
            log.debug("in-page fetch returned JSON without an itemList")
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
            _pause(page, options.page_delay_s)
            quiet_rounds = 0 if capture.drain() > 0 else quiet_rounds + 1

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
    episodes = merge_episodes(page.episodes for page in capture.pages)
    name, total = (
        parse_detail_payload(capture.detail) if capture.detail is not None else (None, None)
    )
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
    warnings = [*capture.warnings, *catalog_warnings(episodes, total)]
    return Series(
        series_id=ref.series_id, name=name, episodes=episodes, total_hint=total, warnings=warnings
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


def _has_item_list(payload: Any, depth: int = 0) -> bool:
    if depth > _MAX_DEPTH:
        return False
    if isinstance(payload, dict):
        if isinstance(payload.get("itemList"), list):
            return True
        return any(_has_item_list(value, depth + 1) for value in payload.values())
    if isinstance(payload, list):
        return any(_has_item_list(value, depth + 1) for value in payload)
    return False


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
