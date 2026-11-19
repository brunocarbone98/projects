"""The library of DramaFetch 1.6.0 for Chrome, end to end (`pytest -m integration`; skipped without
a browser): the user's TikTok Bookmark (**Favorites** → **Drama**) as cards in the DramaFetch tab.

A real headless Chromium loads the extension's TEST copy (`extension_harness.ExtensionHarness`)
against the fake TikTok server, whose favorites are the server's own list
(`FakeTikTok.favorite_ids`) and whose series pages carry a Bookmark button shaped like TikTok's:

- (a) the popup's **Open my library** on the fake profile lists every favorite into the library —
  cards with their covers from the fake's image CDN (each asked for once, none while the listing
  job runs; their addresses in the browser session's memory only), the filters' counts, TikTok's
  count —, keeps it with nothing signed in `chrome.storage.local`, and a second **Open my library**
  with nothing changed costs ONE `drama_list` request, and so does the page's own **Update from
  TikTok**;
- (b) two dramas ticked — each card framed in the accent while ticked — and **Download selected
  dramas** download exactly as **Download all** of their ids does in another profile (the same
  files, names, embedded covers and rows), and the cards end **On disk**;
- (c) **Remove from Favorites** on an on-disk drama presses the drama page's own Bookmark once (one
  `collect` request, the page's own `action`), the fake's list loses it, the card says so, the count
  is the fake's new total (one first-page request of the profile tab), the background tab is closed
  and nothing else is asked — no cover while the job runs;
- (d) a fake that answers the click but keeps the drama (`collect_ignored`): `not-kept`, the drama
  still in the library and on the fake, never a second click;
- (e) a `collect` answered HTTP 429 (`collect_rate_limit`): a stop with the 30-minute cooldown;
- (f) **Retry** after **Download selected dramas**: an episode whose first transfer the fake cuts
  short (`truncate_once`) is shown apart with its **Retry** button, the card says **Partly**; the
  retry — one selection job over that episode — saves it, byte for byte the file a clean
  **Download all** saves, and the card ends **On disk**.

No cookie value is set, printed or asserted on; nothing reaches TikTok.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from .extension_harness import CHROMIUM, ExtensionHarness
from .fake_tiktok import (
    CDN_PATH_RE,
    COLLECT_PATH,
    COVER_PATH_RE,
    DRAMA_LIST_PATH,
    EPISODE_OF_ITEM,
    FAVORITES,
    LIGHTHOUSE_ID,
    PROFILE_PATH,
    SECOND_ITEMS,
    SECOND_SERIES_ID,
    SECOND_SERIES_NAME,
    SERIES_ID,
    SERIES_PATH_RE,
    FakeTikTok,
)

if TYPE_CHECKING:
    from playwright.sync_api import Locator, Page

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not CHROMIUM.is_file(), reason=f"no Chromium at {CHROMIUM} (set DRAMAFETCH_CHROMIUM)"
    ),
]

#: Looking at the drama's page often, and waiting a short while for the Bookmark to turn off.
SETTINGS: dict[str, Any] = {"bookmarkPollS": 0.1, "bookmarkWaitS": 3}
#: What the worker kept of a TikTok tab's favorites list (`chrome.storage.session`), or null.
TEMPLATE_JS = "async (key) => (await chrome.storage.session.get(key))[key] ?? null"
TAB_IDS_JS = (
    "async (prefix) => (await chrome.tabs.query({}))"
    ".filter((tab) => (tab.url || tab.pendingUrl || '').startsWith(prefix)).map((tab) => tab.id)"
)
#: The English of the fake's favorites list: every drama's id, newest first.
FAVORITE_IDS = [series_id for series_id, _, _, _ in FAVORITES]
#: The page's accent colour as the browser computes it (a ticked card's frame is drawn in it).
ACCENT_JS = (
    "() => { const probe = document.createElement('div'); probe.style.color = 'var(--accent)';"
    " document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove();"
    " return color; }"
)


def _profile_and_popup(ext: ExtensionHarness, base_url: str) -> tuple[Page, Page, int]:
    """The user's profile in a tab of its own, its Favorites → Drama shown (the worker keeps the
    page's own first `drama_list` request) and in front, and the popup page, reloaded so that it
    reads the profile as the active tab: `(profile, popup, the profile tab's id)`."""
    profile = ext.context.new_page()
    profile.goto(f"{base_url}{PROFILE_PATH}")
    popup = ext.context.new_page()
    popup.goto(f"chrome-extension://{ext.extension_id}/src/app/popup.html")
    tab_ids: list[int] = popup.evaluate(TAB_IDS_JS, f"{base_url}{PROFILE_PATH}")
    (tab_id,) = tab_ids
    profile.click("#tab-favorites")
    profile.click("#favorites-drama")
    ext.wait_for(lambda: profile.locator("#drama-grid button").count() == 3, 10, "no cards")
    ext.wait_for(
        lambda: popup.evaluate(TEMPLATE_JS, f"favoritesTemplate:{tab_id}") is not None,
        10,
        "the worker kept no favorites address for the profile's tab",
    )
    profile.bring_to_front()
    popup.reload()
    return profile, popup, tab_id


def _new_popup(ext: ExtensionHarness, profile: Page) -> Page:
    """A fresh popup page that reads the profile as the active tab (a popup closes itself once its
    button sent its message)."""
    popup = ext.context.new_page()
    popup.goto(f"chrome-extension://{ext.extension_id}/src/app/popup.html")
    profile.bring_to_front()
    popup.reload()
    return popup


def _open_library(ext: ExtensionHarness, popup: Page) -> None:
    """The popup's **Open my library** on the profile: the hand-over, and its job to its end."""
    button = popup.locator("#popup-favorites")
    ext.wait_for(button.is_visible, 10, "no Open my library on the profile")
    jobs = ext.finished_jobs()
    button.click()
    ext.wait_for(
        lambda: ext.finished_jobs() > jobs and ext.idle(), 60, "the library was not listed"
    )


def _card(page: Page, series_id: str) -> Locator:
    return page.locator(f"#favorites-grid article[data-series-id='{series_id}']")


def _border(card: Locator) -> str:
    """A card's frame colour, as the browser computes it."""
    color: str = card.evaluate("(element) => getComputedStyle(element).borderTopColor")
    return color


def _chips(page: Page) -> list[str]:
    return [
        page.locator(f"#library-chip-{name}").inner_text()
        for name in ("all", "none", "partly", "on-disk")
    ]


def _saved(ext: ExtensionHarness) -> dict[str, bytes]:
    """Every file saved under the download directory: its path there and its bytes."""
    return {str(path): (ext.downloads / path).read_bytes() for path in ext.saved_files()}


def _rows(entry: dict[str, Any]) -> list[tuple[str, list[tuple[int, str, str]]]]:
    """A history entry's series and rows: `(series id, [(number, status, message)])`."""
    return [
        (
            series["series_id"],
            [(row["number"], row["status"], row["message"]) for row in series.get("rows", [])],
        )
        for series in entry["series"]
    ]


def _remove(ext: ExtensionHarness, series_id: str) -> dict[str, Any]:
    """**Remove from Favorites** on the drama's card, confirmed; the job's history entry."""
    page = ext.page
    page.locator("#library").scroll_into_view_if_needed()
    _card(page, series_id).locator("[data-action='remove']").click()
    ext.wait_for(page.locator("#bookmark-dialog").is_visible, 10, "no confirmation")
    jobs = ext.finished_jobs()
    page.click("#bookmark-confirm")
    ext.wait_for(lambda: ext.finished_jobs() > jobs and ext.idle(), 60, "the removal did not end")
    history = ext.history()
    assert history
    return history[0]


def _seed(ext: ExtensionHarness, series_id: str, episodes: int) -> None:
    """The library as an earlier session kept it (the fake's favorites, its whole list read a minute
    ago) and DramaFetch's records of `series_id`: all its `episodes` saved, the series found
    complete — then the tab reloaded, so that it shows them (no request)."""
    items = [
        {"seriesId": drama, "title": title, "episodes": count, "durationS": seconds}
        for drama, title, count, seconds in FAVORITES
    ]
    read_at = time.time() - 60
    library = {
        "v": 1,
        "listedAt": read_at,
        "total": len(items),
        "countedAt": None,
        "fullReadAt": read_at,  # the whole list read: its episode counts trusted for 24 h
        "unconfirmed": False,
        "complete": True,
        "short": False,
        "ended": None,
        "profile": "@invented_viewer",
        "items": items,
        "removed": [],
    }
    stamp = "2026-11-19T10:00:00Z"
    state = {
        "version": 1,
        "series_id": series_id,
        "series_name": SECOND_SERIES_NAME,
        "episodes": {
            str(n): {
                "number": n,
                "item_id": SECOND_ITEMS[n - 1],
                "status": "done",
                "path": f"/dl/{SECOND_SERIES_NAME} - Episode {n:02d}.mp4",
                "message": (
                    f"saved {SECOND_SERIES_NAME} - Episode {n:02d}.mp4 (0.1 MiB) + cover embedded"
                ),
                "updated_at": stamp,
                "download_id": n,
            }
            for n in range(1, episodes + 1)
        },
        "complete_at": stamp,
        "complete_episodes": episodes,
    }
    seeded = {"favoritesLibrary": library, f"series:{series_id}": state}
    ext.page.evaluate("(items) => chrome.storage.local.set(items)", seeded)
    ext.page.reload()
    ext.wait_for(ext.idle, 20, "the reloaded tab did not start")


def test_a_open_my_library_lists_every_favorite_and_an_unchanged_refresh_costs_one_request(
    tmp_path: Path,
) -> None:
    """(a) The popup's **Open my library** on the profile: every favorite as a card, in the list's
    order, with its cover from the fake's image CDN (each once, none while the listing job runs,
    the addresses in the browser session's memory and never on disk), the filters' counts and
    TikTok's count; the library kept with nothing signed; a second **Open my library** with nothing
    changed: ONE `drama_list` request, `No changes` — and the same from the page's own **Update
    from TikTok**."""
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=SETTINGS) as ext,
    ):
        profile, popup, _tab = _profile_and_popup(ext, server.base_url)
        assert popup.locator("#popup-favorites").inner_text() == "Open my library"
        own = len(server.drama_list_requests)
        _open_library(ext, popup)
        page = ext.page
        cards = page.locator("#favorites-grid article[data-series-id]")
        ids = [cards.nth(n).get_attribute("data-series-id") for n in range(cards.count())]
        assert ids == FAVORITE_IDS
        assert len(server.drama_list_requests) == own + 3  # the whole list: three pages
        total = len(FAVORITES)
        assert page.locator("#library-total").inner_text() == f"TikTok counts {total} dramas"
        assert _chips(page) == [
            f"All · {total}",
            f"Not downloaded · {total}",
            "Partly · 0",
            "On disk · 0",
        ]
        assert page.locator("#library-stale").is_hidden()
        # the covers of the cards in view: the fake's image CDN, each asked for once
        ext.wait_for(
            lambda: page.locator("#favorites-grid img.drama-img").count() > 0, 20, "no cover shown"
        )
        covers = [r.path for r in server.cover_requests]
        assert covers, "no cover requested"
        assert len(covers) == len(set(covers))  # each once
        asked_for = []
        for path in covers:
            match = COVER_PATH_RE.match(path)
            assert match is not None
            asked_for.append(match.group("id"))
        assert set(asked_for) <= set(FAVORITE_IDS)
        # never while the listing job ran: every cover after its last page
        log = server.requests
        listing_end = max(n for n, r in enumerate(log) if r.path == DRAMA_LIST_PATH)
        assert min(n for n, r in enumerate(log) if COVER_PATH_RE.match(r.path)) > listing_end
        # the covers' addresses: in the browser session's memory only, never on disk
        assert "/cover/" not in json.dumps(ext.storage())  # every key of chrome.storage.local
        in_session = page.evaluate(
            "async () => (await chrome.storage.session.get('favoritesCovers')).favoritesCovers"
        )
        assert set(in_session) == set(FAVORITE_IDS)
        assert all(
            COVER_PATH_RE.match(url.removeprefix(server.base_url)) for url in in_session.values()
        )
        # kept across sessions: the dramas and TikTok's count — no address, no cover, nothing signed
        stored = ext.storage("favoritesLibrary")["favoritesLibrary"]
        assert [item["seriesId"] for item in stored["items"]] == FAVORITE_IDS
        assert stored["total"] == total
        assert stored["profile"] == "@invented_viewer"
        assert "http" not in json.dumps(stored)
        entry = ext.history()[0]
        assert (entry["kind"], entry["favorites"]) == ("favorites", total)
        # a second time, nothing changed on TikTok: the first page says so — one request
        popup = _new_popup(ext, profile)
        button = popup.locator("#popup-favorites")
        ext.wait_for(button.is_visible, 10, "no Open my library the second time")
        assert button.inner_text() == f"Open my library · {total} dramas"
        lists = len(server.drama_list_requests)
        _open_library(ext, popup)
        assert len(server.drama_list_requests) == lists + 1
        assert (
            page.locator("#input-status").inner_text()
            == f"No changes: TikTok counts {total} dramas."
        )
        assert [cards.nth(n).get_attribute("data-series-id") for n in range(cards.count())] == ids
        # the page's own Update from TikTok: the same smart refresh of that tab — one request
        refresh = page.locator("#library-refresh")
        ext.wait_for(refresh.is_enabled, 20, "Update from TikTok stays disabled")
        assert page.locator("#library-refresh-hint").is_hidden()
        lists = len(server.drama_list_requests)
        jobs = ext.finished_jobs()
        refresh.click()
        ext.wait_for(lambda: ext.finished_jobs() > jobs and ext.idle(), 60, "no update")
        assert len(server.drama_list_requests) == lists + 1
        assert (
            page.locator("#input-status").inner_text()
            == f"No changes: TikTok counts {total} dramas."
        )
        assert not server.item_list_requests and not server.media_requests


def test_b_download_selected_dramas_downloads_exactly_as_download_all_does(tmp_path: Path) -> None:
    """(b) The main series and the second one ticked in the library — each framed in the accent
    while ticked, as the approved sketch draws it —, **Download selected dramas**: ONE batch job,
    the same files (names and bytes: the covers embedded), the same rows and the same label as
    **Download all** of their ids in another profile; the cards end **On disk**."""
    with FakeTikTok() as server:
        with ExtensionHarness(tmp_path / "library", server.base_url, test_settings=SETTINGS) as ext:
            _profile, popup, _tab = _profile_and_popup(ext, server.base_url)
            _open_library(ext, popup)
            page = ext.page
            accent = page.evaluate(ACCENT_JS)
            plain = _border(_card(page, LIGHTHOUSE_ID))
            assert plain != accent
            for series_id in (SERIES_ID, SECOND_SERIES_ID):
                _card(page, series_id).locator("input[type=checkbox]").check()
                assert _border(_card(page, series_id)) == accent  # ticked: framed in the accent
            assert _border(_card(page, LIGHTHOUSE_ID)) == plain  # not ticked: as it was
            assert page.locator("#favorites-selection").inner_text() == "2 selected · 8 episodes"
            jobs = ext.finished_jobs()
            page.click("#library-download")
            ext.wait_for(
                lambda: ext.finished_jobs() > jobs and ext.idle(), 120, "the downloads did not end"
            )
            library_entry = ext.history()[0]
            library_files = _saved(ext)
            assert page.input_value("#links") == ""  # the box untouched
            for series_id in (SERIES_ID, SECOND_SERIES_ID):
                card = _card(page, series_id)
                ext.wait_for(
                    lambda card=card: card.get_attribute("data-status") == "on-disk",
                    10,
                    f"{series_id} is not on disk",
                )
            assert _card(page, SECOND_SERIES_ID).locator(".favorite-status").inner_text() == (
                "On disk · 3/3"
            )
            assert _border(_card(page, SECOND_SERIES_ID)) == plain  # the ticks cleared with the job
        with ExtensionHarness(tmp_path / "box", server.base_url, test_settings=SETTINGS) as box:
            box_entry = box.download_all(f"{SERIES_ID}\n{SECOND_SERIES_ID}", timeout_s=120)
            box_files = _saved(box)
    assert (library_entry["kind"], library_entry["label"]) == ("batch", "2 series")
    assert (box_entry["kind"], box_entry["label"]) == ("batch", "2 series")
    assert _rows(library_entry) == _rows(box_entry)
    assert [series_id for series_id, _ in _rows(library_entry)] == [SERIES_ID, SECOND_SERIES_ID]
    assert library_files == box_files  # the same files, byte for byte
    assert any(path.endswith(".mp4") for path in library_files)
    done = [row for _, rows in _rows(library_entry) for row in rows if row[1] == "done"]
    assert len(done) == 7  # four of the main series (its fifth is locked) and three
    assert all(message.endswith(" + cover embedded") for _, _, message in done)


def test_c_remove_from_favorites_presses_the_bookmark_once_and_the_count_follows(
    tmp_path: Path,
) -> None:
    """(c) **Remove from Favorites** on a drama downloaded whole: the confirmation shows what the
    records say; confirmed, the drama's page opens in a background tab, its own Bookmark is pressed
    once (one `collect` request with the page's own `action`), the reload shows it off, the tab is
    closed; the fake's list loses it, the card says **Removed from your Favorites**, the count is
    the fake's new total from ONE first-page request of the profile tab; nothing else is asked."""
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=SETTINGS) as ext,
    ):
        _profile, popup, _tab = _profile_and_popup(ext, server.base_url)
        _open_library(ext, popup)
        ext.download_all(SECOND_SERIES_ID)
        page = ext.page
        card = _card(page, SECOND_SERIES_ID)
        ext.wait_for(lambda: card.get_attribute("data-status") == "on-disk", 10, "not on disk")
        files = _saved(ext)
        before = len(server.requests)
        lists = len(server.drama_list_requests)
        page.locator("#library").scroll_into_view_if_needed()
        card.locator("[data-action='remove']").click()
        ext.wait_for(page.locator("#bookmark-dialog").is_visible, 10, "no confirmation")
        facts = page.locator("#bookmark-dialog-facts li")
        assert [facts.nth(n).get_attribute("data-fact") for n in range(facts.count())] == [
            "saved",
            "verified",
            "complete",
            "cover",
        ]
        assert facts.nth(0).inner_text() == "3 of 3 episodes on disk"
        jobs = ext.finished_jobs()
        page.click("#bookmark-confirm")
        ext.wait_for(lambda: ext.finished_jobs() > jobs and ext.idle(), 60, "no removal")
        assert server.collect_requests == [(COLLECT_PATH, "0")]  # one click, the page's own action
        assert SECOND_SERIES_ID not in server.favorite_ids
        assert card.get_attribute("data-status") == "removed"
        assert card.locator(".favorite-status").inner_text() == "Removed from your Favorites"
        total = len(FAVORITES) - 1
        assert page.locator("#library-total").inner_text() == f"TikTok counts {total} dramas"
        assert page.locator("#library-chip-all").inner_text() == f"All · {total}"
        assert len(server.drama_list_requests) == lists + 1  # the profile's first page, once
        assert not [url for url in ext.tab_urls() if "/shortdrama/" in url]  # the tab closed
        # nothing else: the drama's page twice (its own list requests), the click, the count
        asked = server.requests[before:]
        pages = [r for r in asked if SERIES_PATH_RE.match(r.path)]
        assert [r.path for r in pages] == [f"/shortdrama/episode/{SECOND_SERIES_ID}/1"] * 2
        others = {r.path for r in asked} - {
            f"/shortdrama/episode/{SECOND_SERIES_ID}/1",
            "/api/drama/detail/",
            "/api/drama/episode/item_list/",
            COLLECT_PATH,
            "/api/user/favorite/drama_list/",
        }
        assert {path for path in others if not COVER_PATH_RE.match(path)} == set()
        # a cover may go out before the job starts (it waits for one in flight), never while it runs
        job = [n for n, r in enumerate(asked) if not COVER_PATH_RE.match(r.path)]
        assert not [r for r in asked[job[0] : job[-1] + 1] if COVER_PATH_RE.match(r.path)]
        assert not [r for r in asked if CDN_PATH_RE.match(r.path)]  # no media asked for
        assert _saved(ext) == files  # no file changed
        entry = ext.history()[0]
        assert entry["kind"] == "unbookmark"
        assert entry["bookmark"] == {
            "series_id": SECOND_SERIES_ID,
            "title": SECOND_SERIES_NAME,
            "outcome": "removed",
        }
        assert "http" not in json.dumps(entry)
        stored = ext.storage("favoritesLibrary")["favoritesLibrary"]
        assert stored["total"] == total
        assert stored["removed"][0]["seriesId"] == SECOND_SERIES_ID


def test_d_tiktok_not_keeping_the_change_is_not_kept_and_never_clicked_twice(
    tmp_path: Path,
) -> None:
    """(d) A fake that answers the click like TikTok but keeps the drama (`collect_ignored`): the
    button turns off, the reload shows it saved — `not-kept`: the drama stays in the library (on
    disk) and on the fake, one `collect` request, a stop without a cooldown."""
    with (
        FakeTikTok(collect_ignored=True) as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=SETTINGS) as ext,
    ):
        _seed(ext, SECOND_SERIES_ID, 3)
        page = ext.page
        card = _card(page, SECOND_SERIES_ID)
        assert card.get_attribute("data-status") == "on-disk"
        entry = _remove(ext, SECOND_SERIES_ID)
        assert server.collect_requests == [(COLLECT_PATH, "0")]
        assert SECOND_SERIES_ID in server.favorite_ids
        assert card.get_attribute("data-status") == "on-disk"
        assert page.locator("#favorites-status").inner_text() == (
            f"TikTok did not keep the change: “{SECOND_SERIES_NAME}” is still in your Favorites. "
            "Remove it yourself: Open on TikTok."
        )
        assert entry["error"] == (
            "TikTok did not keep the change: the drama is still in your Favorites — remove it on "
            "TikTok yourself"
        )
        assert entry["stopped"] == entry["error"]
        assert ext.cooldown() is None
        assert not [url for url in ext.tab_urls() if "/shortdrama/" in url]  # the tab closed


def test_e_a_collect_answered_429_is_a_stop_with_the_cooldown(tmp_path: Path) -> None:
    """(e) The page's own `collect` answered HTTP 429 (`collect_rate_limit`): a stop, the 30-minute
    cooldown recorded with its reason and shown in the banner; the drama stays in the library."""
    with (
        FakeTikTok(collect_rate_limit=True) as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=SETTINGS) as ext,
    ):
        _seed(ext, SECOND_SERIES_ID, 3)
        page = ext.page
        entry = _remove(ext, SECOND_SERIES_ID)
        assert server.collect_requests == [(COLLECT_PATH, "0")]
        cooldown = ext.cooldown()
        assert cooldown is not None
        assert cooldown["reason"].startswith(
            "TikTok is rate-limiting this address (HTTP 429 on the Bookmark"
        )
        assert cooldown["source"] == "discovery"
        ext.wait_for(page.locator("#cooldown-banner").is_visible, 10, "no cooldown banner")
        assert entry["stopped"] == cooldown["reason"]
        assert _card(page, SECOND_SERIES_ID).get_attribute("data-status") == "on-disk"
        assert SECOND_SERIES_ID in server.favorite_ids
        assert not [url for url in ext.tab_urls() if "/shortdrama/" in url]


def test_f_an_episode_a_library_download_could_not_save_is_retried_and_saved_whole(
    tmp_path: Path,
) -> None:
    """(f) The second drama ticked and **Download selected dramas**, the fake cutting the first
    transfer of its episode 2 short (`truncate_once`): episodes 1 and 3 saved, episode 2 shown apart
    — **Did not download (1)** with its **Retry** button, in the history too — and the card
    **Partly · 2/3**. **Retry** is one selection job over that episode alone, requested once more:
    saved whole with its cover embedded — byte for byte what a clean **Download all** saves in
    another profile —, the block gone, the card **On disk · 3/3**."""
    second = (SECOND_SERIES_ID, 2)

    def media_requests(server: FakeTikTok) -> int:
        """How many times the fake CDN was asked for the second drama's episode 2."""
        return sum(
            1
            for request in server.requests
            if (match := CDN_PATH_RE.match(request.path)) is not None
            and EPISODE_OF_ITEM.get(match.group("id")) == second
        )

    with (
        FakeTikTok(truncate_once=frozenset({second})) as server,
        ExtensionHarness(tmp_path / "library", server.base_url, test_settings=SETTINGS) as ext,
    ):
        _profile, popup, _tab = _profile_and_popup(ext, server.base_url)
        _open_library(ext, popup)
        page = ext.page
        card = _card(page, SECOND_SERIES_ID)
        card.locator("input[type=checkbox]").check()
        jobs = ext.finished_jobs()
        page.click("#library-download")
        ext.wait_for(
            lambda: ext.finished_jobs() > jobs and ext.idle(), 120, "the download did not end"
        )
        first = ext.history()[0]
        assert first["kind"] == "batch"
        ((series_id, rows),) = _rows(first)
        assert series_id == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in rows] == [
            (1, "done"),
            (2, "failed"),
            (3, "done"),
        ]
        assert rows[1][2].startswith("download looks incomplete or wrong: truncated body (")
        assert media_requests(server) == 1
        assert page.locator("#failed-block").is_visible()
        assert page.locator("#failed-heading").text_content() == "Did not download (1)"
        retry = page.locator("#retry-button")
        assert retry.is_visible() and retry.is_enabled()
        assert retry.text_content() == "Retry the episodes that did not download (1)"
        history = page.locator("#history-list li")
        ext.wait_for(lambda: history.count() >= 1, 10, "the run is not in the history yet")
        assert history.first.locator(".retry-line span").text_content() == "Did not download: E02"
        ext.wait_for(
            lambda: card.get_attribute("data-status") == "partly", 10, "the card is not partly"
        )
        assert card.locator(".favorite-status").inner_text() == "Partly · 2/3"

        entry = ext._run("#retry-button", 90)
        assert entry["kind"] == "selection"
        assert entry["label"] == f"Retry 1 of {SECOND_SERIES_NAME}"
        ((series_id, rows),) = _rows(entry)
        assert series_id == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in rows] == [(2, "done")]
        assert rows[0][2].endswith(" + cover embedded")
        assert media_requests(server) == 2  # requested once more, now whole
        assert page.locator("#failed-block").is_hidden()
        ext.wait_for(
            lambda: card.get_attribute("data-status") == "on-disk",
            10,
            "not on disk after the retry",
        )
        assert card.locator(".favorite-status").inner_text() == "On disk · 3/3"
        retried = _saved(ext)
    with (
        FakeTikTok() as clean,
        ExtensionHarness(tmp_path / "clean", clean.base_url, test_settings=SETTINGS) as box,
    ):
        box.download_all(SECOND_SERIES_ID, timeout_s=120)
        whole = _saved(box)
    episodes = sorted(path for path in retried if path.endswith(".mp4"))
    assert [Path(path).name for path in episodes] == [
        f"{SECOND_SERIES_NAME} - Episode {number:02d}.mp4" for number in (1, 2, 3)
    ]
    assert {path: retried[path] for path in episodes} == {path: whole[path] for path in episodes}
