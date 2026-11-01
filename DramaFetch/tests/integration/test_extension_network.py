"""The DramaFetch Chrome extension's own requests, end to end (`pytest -m integration`).

A real headless Chromium loads the extension's test copy (`extension_harness`) against the fake
TikTok server, which logs, per request, the `Origin` and `Referer` it carried (their values) and
whether it carried the session cookie (presence only, never a value):

- the extension's own media, cover and thumbnail GETs carry `Referer: <base>/` and no `Origin` —
  the one session declarativeNetRequest rule of the extension (`Referer` set, `Origin` removed;
  a POST of the app page, which Chrome sends with `Origin: chrome-extension://<id>`, is the control
  that the rule really removes one), while the TikTok tab's own `item_list` / `detail` requests
  carry exactly what they carry without the rule; the fake's CDN answers carry no CORS header at
  all (the host permissions give access, not CORS);
- a redirect is followed only on the covered hosts, hop by hop, each hop with the same two header
  changes, at most five hops; a chain that leaves the covered hosts is refused and nothing reaches
  the host it points at;
- the session cookie reaches the extension's own requests with `SameSite=Lax` or `Strict`, with
  third-party cookies allowed or blocked in the profile (a control proves the setting holds): the
  paid episode the account unlocked downloads with the session in every case.
"""

from __future__ import annotations

import http.client
import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import pytest
from mutagen.mp4 import MP4

from .extension_harness import CHROMIUM, ExtensionHarness
from .fake_tiktok import (
    SERIES_ID,
    SERIES_NAME,
    THIRD_ITEMS,
    THIRD_SERIES_ID,
    THIRD_SERIES_NAME,
    FakeTikTok,
    RequestRecord,
    cover_bytes,
)

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not CHROMIUM.is_file(), reason=f"no Chromium at {CHROMIUM} (set DRAMAFETCH_CHROMIUM)"
    ),
]

SESSION_VALUE = "fake-session-value-that-must-never-leak"
MAIN_LINK = f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1"
MAIN_ITEMS = {n: f"769940000000000000{n}" for n in range(1, 6)}
THIRD = dict(enumerate(THIRD_ITEMS, start=1))
MAIN_FOLDER = Path("DramaFetch") / f"{SERIES_NAME} [{SERIES_ID}]"
THIRD_PARTY_COOKIES_BLOCKED = {
    "profile": {"cookie_controls_mode": 1, "block_third_party_cookies": True}
}


def _own_requests(server: FakeTikTok) -> list[RequestRecord]:
    """The extension's own requests: media, covers and thumbnails, and their redirect hops."""
    return [*server.media_requests, *server.cover_requests, *server.hop_requests]


def _probe_origin(ext: ExtensionHarness, server: FakeTikTok) -> RequestRecord:
    """A POST of the app page to the fake (Chrome sends such a request with `Origin`); what the
    fake saw of it."""
    count = len(server.probe_requests)
    status = ext.page.evaluate(
        "async (url) => (await fetch(url, {method: 'POST', body: 'x'})).status",
        f"{server.base_url}/origin-probe",
    )
    assert status == 204
    probes = server.probe_requests
    assert len(probes) == count + 1, "the probe never reached the fake"
    return probes[-1]


def _fingerprint(record: RequestRecord) -> tuple[tuple[str, ...], str | None, str | None]:
    """What a header rule could change of a request: the header names, `Origin` and `Referer`."""
    return record.header_names, record.origin, record.referer


def _page_api_requests(server: FakeTikTok, since: int) -> list[RequestRecord]:
    """The series page's `item_list` / `detail` requests made from request number `since` on."""
    api = ("/api/drama/episode/item_list/", "/api/drama/detail/")
    return [r for r in server.requests[since:] if r.path in api]


def _each_thumbnail(ext: ExtensionHarness, asked: Callable[[str], bool]) -> None:
    """Bring the listed episodes' cover cells into view one row at a time, as a person scrolling
    does (the list may ask for a thumbnail only once its row is seen), and wait each time until
    `asked(item id)` holds — the row's thumbnail requested (and shown, or refused)."""
    rows = ext.page.locator("#episode-table tbody tr")
    for index in range(rows.count()):
        row = rows.nth(index)
        item = row.get_attribute("data-item-id") or ""
        row.locator("td.cover-cell").scroll_into_view_if_needed()
        ext.wait_for(lambda: asked(item), 20, f"no thumbnail for item {item}")  # noqa: B023


def _shown(ext: ExtensionHarness) -> Callable[[str], bool]:
    """Whether a row's thumbnail is on screen."""
    table = ext.page.locator("#episode-table tbody")
    return lambda item: table.locator(f"tr[data-item-id='{item}'] img.cover").count() == 1


def _cdn_headers(server: FakeTikTok, path: str) -> dict[str, str]:
    """The response headers of one GET of the fake (over loopback, not through any proxy)."""
    port = urlsplit(server.base_url).port
    assert port is not None
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        response.read()
        assert response.status == 200, (path, response.status)
        return {name.lower(): value for name, value in response.getheaders()}
    finally:
        connection.close()


# ------------------------------------------------------------------------------ the header rule


def test_the_extension_s_own_requests_carry_the_referer_and_no_origin(tmp_path: Path) -> None:
    """Every media, cover and thumbnail GET of the extension: `Referer: <base>/`, no `Origin`. The
    control: before any job no rule exists and a POST of the app page carries `Origin:
    chrome-extension://<id>`; once the rule is in force the same POST carries none — Chromium does
    remove it. The fake CDN sends no CORS header, and every file still comes through."""
    with (
        FakeTikTok(origin_probe=True) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        base = server.base_url
        assert ext.session_rules() == []
        before = _probe_origin(ext, server)
        assert before.origin == f"chrome-extension://{ext.extension_id}"
        assert before.referer is None

        ext.load(MAIN_LINK)  # the rule goes in before the job's first request
        (rule,) = ext.session_rules()
        assert rule["action"]["requestHeaders"] == [
            {"header": "Referer", "operation": "set", "value": f"{base}/"},
            {"header": "Origin", "operation": "remove"},
        ]
        assert rule["condition"]["initiatorDomains"] == [ext.extension_id]
        assert rule["condition"]["urlFilter"] == f"|{base}/"
        after = _probe_origin(ext, server)
        assert after.origin is None and after.referer == f"{base}/"

        _each_thumbnail(ext, _shown(ext))  # the list's five thumbnails, row by row
        entry = ext.download_all(MAIN_LINK)
        (series,) = entry["series"]
        assert series["line"] == "complete: 4 of 5 (4 downloaded) — 1 locked (5)"
        # no CORS on the fake CDN: the extension reached it through its host permissions
        expire = int(time.time()) + 600
        item = MAIN_ITEMS[1]
        for path in (
            f"/cdn/{item}/0.mp4?expire={expire}&probe=cors",
            f"/cover/{item}.jpg?probe=cors",
        ):
            headers = _cdn_headers(server, path)
            assert not [name for name in headers if name.startswith("access-control-")], path
    own = [r for r in _own_requests(server) if not r.query.get("probe")]  # not the CORS check's
    assert len([r for r in own if r in server.media_requests]) == 4
    assert len([r for r in own if r in server.cover_requests]) == 5 + 4  # thumbnails, covers
    for record in own:
        assert record.origin is None, record.path
        assert record.referer == f"{base}/", record.path
        assert record.with_referer
    # the page's own requests never get the extension's Referer (they carry the page's)
    assert all(r.referer != f"{base}/" for r in _page_api_requests(server, 0))


def test_the_tiktok_tab_s_own_requests_are_untouched_by_the_rule(tmp_path: Path) -> None:
    """The series page's own `item_list` and `detail` requests — and the list pages the extension
    fetches from inside that page — carry the same headers with the rule in force as without it:
    a page in a normal tab before any job (no rule), the discovery's tab, a normal tab again."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        series_page = f"{server.base_url}/shortdrama/episode/{SERIES_ID}/1"

        def visit() -> list[RequestRecord]:
            start = len(server.requests)
            page = ext.context.new_page()
            try:
                page.goto(series_page)
                ext.wait_for(
                    lambda: (
                        {r.path for r in _page_api_requests(server, start)}
                        == {"/api/drama/episode/item_list/", "/api/drama/detail/"}
                    ),
                    20,
                    "the series page made no list request",
                )
            finally:
                page.close()
            return _page_api_requests(server, start)

        assert ext.session_rules() == []
        without = visit()
        start = len(server.requests)
        ext.load(MAIN_LINK)
        assert ext.session_rules() != []
        discovery = _page_api_requests(server, start)
        with_rule = visit()
    fingerprints = {_fingerprint(r) for r in without}
    assert len(fingerprints) == 1  # item_list and detail: the same headers
    (expected,) = fingerprints
    assert expected[1] is None and expected[2] == series_page  # no Origin, the page as Referer
    assert {_fingerprint(r) for r in with_rule} == fingerprints
    # the discovery's tab: its own two requests, the extension's list pages and the detail fetched
    # from inside it — all with the page's headers
    assert len(discovery) >= 4
    assert {_fingerprint(r) for r in discovery} == fingerprints


# ----------------------------------------------------------------------------- redirects


def test_a_redirect_on_a_covered_host_is_followed_hop_by_hop(tmp_path: Path) -> None:
    """`/cdn/…` and `/cover/…` answer a 302 to `/hop/1/…` on the same (covered) origin: every
    episode and its cover come through, the thumbnails of **Load list** too; both requests of each
    are the extension's own — `Referer` set, no `Origin` — and nothing leaves the covered host."""
    with (
        FakeTikTok(media_hops=1, cover_hops=1) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        ext.load(MAIN_LINK)
        _each_thumbnail(ext, _shown(ext))  # each thumbnail behind its hop, shown
        entry = ext.download_all(MAIN_LINK)
        (series,) = entry["series"]
        rows = {row["number"]: row for row in series["rows"]}
        assert [rows[n]["status"] for n in range(1, 6)] == ["done"] * 4 + ["skipped-locked"]
        for number in range(1, 5):
            assert rows[number]["message"].endswith(" + cover embedded")
            path = ext.downloads / MAIN_FOLDER / f"{SERIES_NAME} - Episode {number:02d}.mp4"
            tags = MP4(path).tags
            assert tags is not None
            assert bytes(tags["covr"][0]) == cover_bytes(MAIN_ITEMS[number])
    base = server.base_url
    for number in range(1, 5):
        item = MAIN_ITEMS[number]
        assert [r.path for r in server.media_requests if f"/{item}/" in r.path] == [
            f"/cdn/{item}/0.mp4"
        ]
        assert [
            r.path for r in server.hop_requests if r.path.startswith(f"/hop/1/cdn/{item}/")
        ] == [f"/hop/1/cdn/{item}/0.mp4"]
    cover_hops = [r for r in server.hop_requests if "/cover/" in r.path]
    # the thumbnails, then the downloader's covers: each request with its hop
    assert len(server.cover_requests) == len(cover_hops) == 5 + 4
    for record in _own_requests(server):
        assert record.origin is None and record.referer == f"{base}/", record.path
    assert not server.elsewhere_requests


def test_five_redirects_are_followed_and_a_sixth_is_refused(tmp_path: Path) -> None:
    """A video behind five hops is saved; a cover behind six is refused after the fifth — its sixth
    target never requested — and only noted, the video kept."""
    with (
        FakeTikTok(media_hops=5, cover_hops=6) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        entry = ext.download_all(MAIN_LINK)
        (series,) = entry["series"]
        rows = {row["number"]: row for row in series["rows"]}
        for number in range(1, 5):
            assert rows[number]["status"] == "done"
            assert rows[number]["message"].endswith(
                "; cover: more than 5 redirects from 127.0.0.1, not followed"
            )
    for number in range(1, 5):
        item = MAIN_ITEMS[number]
        media_hops = [r.path for r in server.hop_requests if f"/cdn/{item}/" in r.path]
        assert media_hops == [f"/hop/{k}/cdn/{item}/0.mp4" for k in range(1, 6)]
        cover_hops = [r.path for r in server.hop_requests if f"/cover/{item}" in r.path]
        assert cover_hops == [f"/hop/{k}/cover/{item}.jpg" for k in range(1, 6)]  # never /hop/6
    for record in _own_requests(server):
        assert record.origin is None and record.with_referer, record.path


def test_a_chain_that_leaves_the_covered_hosts_is_refused(tmp_path: Path) -> None:
    """covered → covered → `localhost` (not covered): refused at the second redirect, like a 403 —
    the next URL, `failed-unavailable` — for videos and thumbnails alike; not one request reaches
    `localhost`, nothing is saved."""
    with (
        FakeTikTok(media_hops=1, cover_hops=1, hops_then_elsewhere=True) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        ext.load(MAIN_LINK)

        def refused(item: str) -> bool:  # its thumbnail's hop was requested, nothing beyond it
            return any(r.path == f"/hop/1/cover/{item}.jpg" for r in server.hop_requests)

        _each_thumbnail(ext, refused)
        entry = ext.download_all(MAIN_LINK)
        (series,) = entry["series"]
        rows = {row["number"]: row for row in series["rows"]}
        assert [rows[n]["status"] for n in range(1, 6)] == ["failed-unavailable"] * 3 + [
            "failed",
            "skipped-locked",
        ]
        for number in (1, 2, 3):
            assert rows[number]["message"].endswith("(a redirect from 127.0.0.1, not followed)")
        assert rows[4]["message"].startswith("stopped: 3 consecutive failures (last: ")
        assert ext.page.locator("#episode-table img.cover").count() == 0
        assert ext.saved_files() == []
    assert server.hop_requests and not server.elsewhere_requests
    for record in _own_requests(server):
        assert record.origin is None and record.with_referer, record.path


# ------------------------------------------------------------------------------- cookies


@pytest.mark.parametrize(
    ("same_site", "blocked"),
    [("Lax", False), ("Strict", False), ("Lax", True), ("Strict", True)],
)
def test_the_session_reaches_the_extension_s_own_requests_whatever_the_cookie_settings(
    tmp_path: Path, same_site: Literal["Lax", "Strict"], blocked: bool
) -> None:
    """The paid series with the session cookie `SameSite=<same_site>`, third-party cookies allowed
    or blocked in the profile (`Default/Preferences` before launch; the control — a third-party
    image of `localhost` on a 127.0.0.1 page — carries its cookie exactly when they are allowed,
    while a first-party request always does): the unlocked episode 3 downloads, and every media
    and cover GET of the extension carried the session (presence only). The cookie is stored
    nowhere by the extension."""
    preferences = THIRD_PARTY_COOKIES_BLOCKED if blocked else None
    with (
        FakeTikTok(cookie_control=True) as server,
        ExtensionHarness(tmp_path, server.base_url, preferences=preferences) as ext,
    ):
        port = urlsplit(server.base_url).port
        control = ext.context.new_page()
        try:
            control.goto(f"http://localhost:{port}/cookie-control/set")
            control.goto(f"http://localhost:{port}/cookie-control/pixel")  # first party
            control.goto(f"{server.base_url}/cookie-control/cross-site")  # third party
            ext.wait_for(lambda: len(server.control_requests) == 2, 20, "no control image")
        finally:
            control.close()
        first_party, third_party = server.control_requests
        assert first_party.control_cookie
        assert third_party.control_cookie is not blocked  # the profile's setting holds

        ext.add_session_cookie(SESSION_VALUE, same_site=same_site)
        entry = ext.download_all(THIRD_SERIES_ID)
        (series,) = entry["series"]
        assert series["name"] == THIRD_SERIES_NAME
        assert series["line"] == (
            "complete: 3 of 4 (3 downloaded) — 1 paid episode your account unlocked (3), "
            "1 locked (4)"
        )
        assert SESSION_VALUE not in json.dumps(ext.storage())
    paid_media = [r for r in server.media_requests if r.path.startswith(f"/cdn/{THIRD[3]}/")]
    assert len(paid_media) == 1 and paid_media[0].logged_in
    paid_cover = [r for r in server.cover_requests if r.path == f"/cover/{THIRD[3]}.jpg"]
    assert len(paid_cover) == 1 and paid_cover[0].logged_in
    assert all(r.logged_in for r in server.media_requests + server.cover_requests)
    assert all(r.logged_in for r in server.item_list_requests)  # the page's own, and the pages
