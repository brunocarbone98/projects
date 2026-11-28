"""Static strategy: fetch the series page over plain HTTP and read the JSON TikTok embeds in it.

TikTok's web app ships its initial state in `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"
type="application/json">`. When the server renders the first page of episodes into it, no browser
is needed. The strategy sees only what the page embeds (no pagination), and a plain HTTP client may
be answered with a login redirect or a verification page, so `AutoDiscovery` falls back to the
browser strategy on any `DiscoveryError`. All network I/O goes through one injectable
`fetch(url, headers) -> (final_url, body)` callable.

The module also hosts the helpers both strategies share: the Chrome user agent, token redaction for
messages and logs, challenge-page detection and the `--dump-raw` writer.
"""

from __future__ import annotations

import json
import logging
import re
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from http.client import HTTPMessage
from pathlib import Path
from typing import IO, Any
from urllib.parse import urlsplit

from dramafetch.catalog import (
    PagePayload,
    catalog_warnings,
    merge_pages,
    missing_numbers,
    parse_detail_payload,
    parse_item_list_payload,
)
from dramafetch.discovery.cookies import cookie_header, load_netscape_cookies
from dramafetch.errors import DiscoveryError, DramaFetchError, LoginRequiredError, RateLimitedError
from dramafetch.models import (
    MAX_EPISODE_NUMBER,
    DiscoveryOptions,
    ListingPage,
    ListingRecord,
    Series,
    SeriesRef,
)
from dramafetch.urls import series_page_url

log = logging.getLogger(__name__)

Fetch = Callable[[str, dict[str, str]], tuple[str, str]]

STATIC_TIMEOUT_S = 20.0
DEFAULT_CHROME_MAJOR = "153"
#: The Playwright channel both Chromium launch sites use when neither ``--browser-path`` nor
#: ``--browser-channel`` is given: the full Chromium build, in its new headless mode. Without a
#: channel, Playwright 1.49 and later start ``chromium-headless-shell`` for a headless launch — a
#: build that announces itself as ``HeadlessChrome`` in ``Sec-CH-UA`` and
#: ``navigator.userAgentData`` whatever user agent the context sets, which defeats the one user
#: agent measure the Scope allows. Default flags all the same: ``navigator.webdriver`` stays true.
DEFAULT_BROWSER_CHANNEL = "chromium"
#: The request headers curl_cffi's Chrome impersonation sets itself (next to the client hints
#: and ``Sec-Fetch-*``): when it is used, DramaFetch's own values are left out so that the
#: headers agree with the TLS fingerprint and the hints — ``User-Agent: Chrome/153`` next to
#: ``sec-ch-ua: "Google Chrome";v="152"`` is the kind of contradiction a bot score counts.
#: ``Cookie`` is always DramaFetch's; the urllib fallback has no such set and keeps them all.
IMPERSONATED_HEADERS = frozenset({"user-agent", "accept", "accept-language"})
RATE_LIMIT_MESSAGE = (
    "TikTok is rate-limiting this address (HTTP 429): wait 30-60 minutes before trying again"
)
NO_DATA_MESSAGE = "page has no episode data; use --strategy browser"
PARTIAL_WARNING = "static strategy: only the embedded first page was read"
#: What the static strategy says of a list the page embeds whole (no ``hasMore``) that still lacks
#: an episode — a hole, or a number TikTok's count places past it (3.0.1): the page's list was not
#: cut short, TikTok's list lacks the episode; the browser asks again.
LACKING_WARNING = "static strategy: the episode list the page embeds lacks an episode"
HYDRATION_SCRIPT_RE = re.compile(
    r"<script\b[^>]*\bid=[\"'](?:__UNIVERSAL_DATA_FOR_REHYDRATION__|SIGI_STATE)[\"'][^>]*>"
    r"(?P<json>.*?)</script>",
    re.DOTALL | re.IGNORECASE,
)
CHALLENGE_MARKERS = (
    "verify to continue",
    "captcha",
    "checking your browser",
    "verify you are human",
)
# Query parameters and cookie names whose values must never reach a message, a log or a dump.
_TOKEN_RE = re.compile(
    r"(?i)\b(msToken|sessionid(?:_ss)?|sid_tt|sid_guard|ttwid|tt_csrf_token|passport_csrf_token|"
    r"uid_tt(?:_ss)?|odin_tt|s_v_web_id|verifyFp|_signature|X-Bogus|cookie)\s*[=:]\s*[^&;\s\"',]+"
)
_SENSITIVE_KEY_RE = re.compile(r"(?i)token|csrf|cookie|session|secret|password|^sid\b")
_MAX_DEPTH = 12
# The keys an item list lives under (``catalog.find_item_lists``) and the paging keys of the
# object that holds one (``catalog.parse_item_list_payload`` reads hasMore / has_more / cursor).
_ITEM_LIST_KEYS = ("itemList", "item_list")
_PAGING_KEYS = ("hasMore", "has_more", "cursor")


def chrome_user_agent(version: str | None = None) -> str:
    """A current Chrome user agent for this platform (never the default "HeadlessChrome").

    Chrome itself reports only the major version (`Chrome/153.0.0.0`), so `version` is reduced to
    its first component; without one the major of the Chromium this project is tested with is used.
    """
    major = (version or "").split(".")[0].strip()
    if not major.isdigit():
        major = DEFAULT_CHROME_MAJOR
    if sys.platform.startswith("win"):
        platform_token = "Windows NT 10.0; Win64; x64"
    elif sys.platform == "darwin":
        platform_token = "Macintosh; Intel Mac OS X 10_15_7"
    else:
        platform_token = "X11; Linux x86_64"
    return (
        f"Mozilla/5.0 ({platform_token}) AppleWebKit/537.36 (KHTML, like Gecko) "
        f"Chrome/{major}.0.0.0 Safari/537.36"
    )


def redact_tokens(text: str) -> str:
    """Blank the value of anything that looks like a session token or cookie inside free text."""
    return _TOKEN_RE.sub(lambda match: f"{match.group(1)}=<redacted>", text)


def looks_like_challenge(text: str) -> bool:
    """True when visible page text reads like TikTok's captcha / 'verify you are human' wall."""
    lowered = text.lower()
    return any(marker in lowered for marker in CHALLENGE_MARKERS)


def redact_payload(payload: Any, depth: int = 0) -> Any:
    """Copy a JSON payload with the values of token-like keys replaced (for `--dump-raw`)."""
    if depth > _MAX_DEPTH:
        return "<too deep>"
    if isinstance(payload, dict):
        return {
            str(key): "<redacted>"
            if _SENSITIVE_KEY_RE.search(str(key))
            else redact_payload(value, depth + 1)
            for key, value in payload.items()
        }
    if isinstance(payload, list):
        return [redact_payload(value, depth + 1) for value in payload]
    return payload


def write_dump(path: Path, payload: Any) -> None:
    """Write one raw payload as pretty JSON with token-like values redacted (never cookies)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(redact_payload(payload), indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def safe_url(url: str) -> str:
    """A URL fit for messages: scheme, host and path only (query strings can carry tokens)."""
    parts = urlsplit(url)
    return parts._replace(query="", fragment="").geturl()


def is_login_url(url: str) -> bool:
    return urlsplit(url).path.rstrip("/").lower().startswith("/login")


def cookie_domain_filter(base_url: str) -> str:
    """The cookie domain to load for a base URL: `www.tiktok.com` -> `tiktok.com`, IPs unchanged."""
    host = (urlsplit(base_url).hostname or "tiktok.com").lower()
    if re.fullmatch(r"[\d.]+|\[?[0-9a-f:]+\]?", host) or host.count(".") < 2:
        return host
    return ".".join(host.split(".")[-2:])


def default_fetch(url: str, headers: dict[str, str]) -> tuple[str, str]:
    """GET `url` following same-site redirects: curl_cffi with Chrome's TLS fingerprint when
    installed, plain urllib otherwise. Returns `(final_url, body)`; HTTP errors become
    `DiscoveryError` (429: `RateLimitedError`). The `Cookie` header is for TikTok only, so a
    redirect that leaves the site of `url` (or drops from https to http) is refused, not
    followed. With curl_cffi the headers in :data:`IMPERSONATED_HEADERS` are its own (the
    impersonated Chrome's), never DramaFetch's: one consistent client."""
    try:
        from curl_cffi import requests as curl_requests
    except ImportError:
        return _urllib_fetch(url, headers)
    try:
        response = curl_requests.get(
            url,
            headers={k: v for k, v in headers.items() if k.lower() not in IMPERSONATED_HEADERS},
            impersonate="chrome",
            timeout=STATIC_TIMEOUT_S,
            allow_redirects=True,
        )
    except Exception as exc:
        raise DiscoveryError(f"could not fetch the series page: {_describe(exc)}") from exc
    status = int(response.status_code)
    if status == 429:
        raise RateLimitedError(RATE_LIMIT_MESSAGE)
    if status >= 400:
        raise DiscoveryError(f"TikTok answered HTTP {status} for the series page")
    final_url = str(response.url)
    ensure_same_site(url, final_url)
    return final_url, str(response.text)


def _urllib_fetch(url: str, headers: dict[str, str]) -> tuple[str, str]:
    request = urllib.request.Request(url, headers=headers)
    opener = urllib.request.build_opener(_SameSiteRedirectHandler(url))
    try:
        with opener.open(request, timeout=STATIC_TIMEOUT_S) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            body = response.read().decode(charset, errors="replace")
            return str(response.geturl()), body
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise RateLimitedError(RATE_LIMIT_MESSAGE) from exc
        raise DiscoveryError(f"TikTok answered HTTP {exc.code} for the series page") from exc
    except OSError as exc:  # URLError, timeouts, DNS and connection failures
        raise DiscoveryError(f"could not fetch the series page: {_describe(exc)}") from exc


def ensure_same_site(original_url: str, target_url: str) -> None:
    """Raise `DiscoveryError` when `target_url` is outside the site of `original_url` (the cookie
    domain of its host, e.g. `tiktok.com` for `www.tiktok.com`) or downgrades https to http."""
    original, target = urlsplit(original_url), urlsplit(target_url)
    site = cookie_domain_filter(original_url)
    host = (target.hostname or "").lower()
    same_site = host == site or host.endswith("." + site)
    downgrade = original.scheme.lower() == "https" and target.scheme.lower() != "https"
    if not same_site or downgrade:
        raise DiscoveryError(
            f"the series page redirected off-site to {safe_url(target_url)}; not following it "
            "(cookies are only ever sent to TikTok)"
        )


class _SameSiteRedirectHandler(urllib.request.HTTPRedirectHandler):
    """urllib forwards every request header, `Cookie` included, to a redirect target on any host;
    this handler follows only same-site, non-downgrading redirects (see `ensure_same_site`)."""

    def __init__(self, original_url: str) -> None:
        super().__init__()
        self._original_url = original_url

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: HTTPMessage,
        newurl: str,
    ) -> urllib.request.Request | None:
        ensure_same_site(self._original_url, newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def extract_hydration_json(html: str) -> list[Any]:
    """Every parseable hydration blob in the page, in document order."""
    blobs: list[Any] = []
    for match in HYDRATION_SCRIPT_RE.finditer(html):
        try:
            blobs.append(json.loads(match.group("json")))
        except ValueError:
            log.debug("hydration script is not valid JSON; skipped")
    return blobs


class StaticHtmlDiscovery:
    """Resolve a series from the JSON embedded in its page, without a browser."""

    def __init__(self, fetch: Fetch | None = None) -> None:
        self._fetch: Fetch = fetch if fetch is not None else default_fetch

    def discover(self, ref: SeriesRef, options: DiscoveryOptions) -> Series:
        # Episode 1's page whatever episode the link names (3.0.1), as the browser strategy
        # opens it: the episode in the link picks nothing — a paste downloads the whole drama.
        url = series_page_url(ref.series_id, 1, options.base_url)
        headers, warnings = self._headers(options)
        final_url, body = self._get(url, headers)
        if is_login_url(final_url):
            raise LoginRequiredError(
                "TikTok redirected the series page to its login page: pass --cookies cookies.txt "
                "exported from a logged-in browser"
            )
        blobs = extract_hydration_json(body)
        if options.dump_dir is not None:
            self._dump(options.dump_dir, final_url, blobs)
        if not blobs:
            raise DiscoveryError(self._no_data_message(body))

        # Each embedded list with its own holder's `hasMore` and `cursor` (3.0.1): re-wrapped bare,
        # a first page that says TikTok has more passed for the whole series.
        pages: list[PagePayload] = []
        for blob in blobs:
            pages.extend(
                parse_item_list_payload(embedded, ref.series_id)
                for embedded in _embedded_lists(blob)
            )
        # no item without a number is numbered by its place here (4.0.2): nothing asks TikTok
        # again, and the hole makes the result partial — `auto` lists the drama with the browser
        listing = merge_pages(pages)
        episodes = listing.episodes
        if not episodes:
            raise DiscoveryError(self._no_data_message(body))

        name, total = _detail_from_blobs(blobs, ref.series_id)
        if total is None:
            total = listing.total_hint
        if name is None:
            name = next((e.series_name for e in episodes if e.series_name), None)
        warnings.extend(
            catalog_warnings(
                episodes,
                total,
                duplicates=listing.duplicates,
                skipped=listing.skipped,
                items_received=listing.items_received,
            )
        )
        # What the page does not embed: a number missing (a hole below the highest one listed, or
        # one up to TikTok's count less the drama's other items: catalog.missing_numbers), or a list
        # that says TikTok has more. Partial: `auto` completes it with the browser, whose listing
        # asks again for what it lacks.
        missing = missing_numbers(
            (episode.number for episode in episodes),
            total,
            listing.items_received,
            limit=MAX_EPISODE_NUMBER,
        )
        early_end = PARTIAL_WARNING if any(p.has_more for p in pages) else None
        if early_end is not None:
            warnings.append(f"{PARTIAL_WARNING}; use --strategy browser for the full list")
        elif missing:
            # the page's list is whole (3.0.1): TikTok's list is what lacks the episode
            warnings.append(f"{LACKING_WARNING}; use --strategy browser to ask TikTok again")
        return Series(
            series_id=ref.series_id,
            name=name,
            episodes=episodes,
            total_hint=total,
            warnings=warnings,
            skipped_items=listing.skipped,
            items_received=listing.items_received,
            missing_numbers=missing,
            early_end=early_end,
            listing=ListingRecord(
                endpoint=safe_url(final_url),
                pages=[
                    ListingPage(
                        "embedded",
                        None,
                        None,
                        listed=True,
                        items=page.seen_items,
                        numbers=tuple(episode.number for episode in page.episodes),
                        has_more=page.has_more,
                        cursor=page.cursor,
                    )
                    for page in pages
                ],
            ),
        )

    def _headers(self, options: DiscoveryOptions) -> tuple[dict[str, str], list[str]]:
        headers = {
            "User-Agent": chrome_user_agent(),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
        warnings: list[str] = []
        if options.cookies_file is not None:
            try:
                cookies = load_netscape_cookies(
                    options.cookies_file, domain_filter=cookie_domain_filter(options.base_url)
                )
            except (OSError, ValueError) as exc:
                raise DiscoveryError(f"cookies file: {_describe(exc)}") from exc
            if cookies:
                headers["Cookie"] = cookie_header(cookies)
            else:
                warnings.append(
                    f"cookies file has no unexpired cookies for "
                    f"{cookie_domain_filter(options.base_url)}; continuing without a session"
                )
        return headers, warnings

    def _get(self, url: str, headers: dict[str, str]) -> tuple[str, str]:
        try:
            final_url, body = self._fetch(url, headers)
        except DramaFetchError:
            raise
        except Exception as exc:
            raise DiscoveryError(f"could not fetch the series page: {_describe(exc)}") from exc
        return str(final_url), str(body)

    @staticmethod
    def _no_data_message(body: str) -> str:
        if looks_like_challenge(body):
            return f"{NO_DATA_MESSAGE} (TikTok served a verification page to the plain request)"
        return NO_DATA_MESSAGE

    @staticmethod
    def _dump(dump_dir: Path, final_url: str, blobs: list[Any]) -> None:
        try:
            dump_dir.mkdir(parents=True, exist_ok=True)
            (dump_dir / "page_url.txt").write_text(safe_url(final_url) + "\n", encoding="utf-8")
            for index, blob in enumerate(blobs, start=1):
                write_dump(dump_dir / f"hydration_{index}.json", blob)
        except OSError as exc:
            log.warning("could not write the raw dump to %s: %s", dump_dir, _describe(exc))


def _detail_from_blobs(blobs: list[Any], series_id: str) -> tuple[str | None, int | None]:
    """Series name and announced total from any `dramaInfo`-bearing object in the hydration data
    (an item's too: its `numVideos` is TikTok's count) — never one that names another drama."""
    name: str | None = None
    total: int | None = None
    for blob in blobs:
        for holder in _objects_with_key(blob, "dramaInfo"):
            found_name, found_total = parse_detail_payload(
                {"dramaInfo": holder["dramaInfo"]}, series_id
            )
            name = name or found_name
            total = total if total is not None else found_total
            if name is not None and total is not None:
                return name, total
    return name, total


def _embedded_lists(payload: Any, depth: int = 0) -> Iterator[dict[str, Any]]:
    """Every item list the hydration data holds (``catalog.find_item_lists``' walk: depth-limited,
    never into a list once found), each as a payload of its own — the list under ``itemList`` and
    the ``hasMore`` / ``has_more`` / ``cursor`` of the object that holds it, nothing else of it —
    so that a page that says TikTok has more keeps saying so."""
    if depth > _MAX_DEPTH:
        return
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in _ITEM_LIST_KEYS and isinstance(value, list):
                embedded: dict[str, Any] = {
                    "itemList": [entry for entry in value if isinstance(entry, dict)]
                }
                for field_name in _PAGING_KEYS:
                    if field_name in payload:
                        embedded[field_name] = payload[field_name]
                yield embedded
            else:
                yield from _embedded_lists(value, depth + 1)
    elif isinstance(payload, list):
        for value in payload:
            yield from _embedded_lists(value, depth + 1)


def _objects_with_key(payload: Any, key: str, depth: int = 0) -> Iterator[dict[str, Any]]:
    if depth > _MAX_DEPTH:
        return
    if isinstance(payload, dict):
        if isinstance(payload.get(key), dict):
            yield payload
        for value in payload.values():
            yield from _objects_with_key(value, key, depth + 1)
    elif isinstance(payload, list):
        for value in payload:
            yield from _objects_with_key(value, key, depth + 1)


def _describe(exc: BaseException) -> str:
    """One redacted line for an exception; never the headers that were sent."""
    text = redact_tokens(str(exc)).strip() or exc.__class__.__name__
    return text.splitlines()[0][:300]
