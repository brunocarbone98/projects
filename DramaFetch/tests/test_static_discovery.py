"""Static strategy with an injected fetch, the strategy chooser, and the shared helpers."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest

from dramafetch.discovery import (
    AutoDiscovery,
    PlaywrightDiscovery,
    StaticHtmlDiscovery,
    choose_discovery,
)
from dramafetch.discovery.browser import _with_query_params
from dramafetch.discovery.static import (
    DEFAULT_CHROME_MAJOR,
    PARTIAL_WARNING,
    RATE_LIMIT_MESSAGE,
    chrome_user_agent,
    cookie_domain_filter,
    extract_hydration_json,
    is_login_url,
    looks_like_challenge,
    redact_payload,
    redact_tokens,
    safe_url,
)
from dramafetch.errors import ChallengeError, DiscoveryError, LoginRequiredError
from dramafetch.models import DiscoveryOptions, Episode, Series, SeriesRef

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

    ((url, headers),) = fetch.calls
    assert url == f"{BASE}/shortdrama/episode/{SERIES_ID}/2"
    assert "Chrome/" in headers["User-Agent"] and "Headless" not in headers["User-Agent"]
    assert headers["Accept-Language"].startswith("en-US")
    assert "Cookie" not in headers


def test_full_embedded_list_has_no_partial_warning(item_list_pages) -> None:
    lists = [item_list_pages[0]["itemList"], item_list_pages[1]["data"]["itemList"]]
    fetch = FakeFetch(_hydration_html(_embedded(lists, total=5, has_more=False)))

    series = StaticHtmlDiscovery(fetch=fetch).discover(SeriesRef(SERIES_ID), DiscoveryOptions())

    assert series.numbers == [1, 2, 3, 4, 5]  # duplicate 2 and the other-series item dropped
    assert series.episode(5) is not None and series.episode(5).locked
    assert "isFree=false" in series.episode(5).lock_hints
    assert not any(w.startswith(PARTIAL_WARNING) for w in series.warnings)
    assert not any("gap" in w or "duplicate" in w for w in series.warnings)


def test_series_name_falls_back_to_the_episodes(item_list_pages) -> None:
    payload = {"itemList": item_list_pages[0]["itemList"]}  # no dramaInfo holder with a total
    series = StaticHtmlDiscovery(fetch=FakeFetch(_hydration_html(payload))).discover(
        SeriesRef(SERIES_ID), DiscoveryOptions()
    )
    assert series.name == SERIES_NAME
    assert series.total_hint is None


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
    fetch = FakeFetch(error=DiscoveryError(RATE_LIMIT_MESSAGE))
    with pytest.raises(DiscoveryError, match="429") as info:
        StaticHtmlDiscovery(fetch=fetch).discover(SeriesRef(SERIES_ID), DiscoveryOptions())
    assert str(info.value) == RATE_LIMIT_MESSAGE


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


@pytest.mark.parametrize("error", [LoginRequiredError("log in"), ChallengeError("captcha")])
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
