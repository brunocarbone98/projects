"""The library of DramaFetch for Chrome (1.6.0), end to end (`pytest -m integration`; skipped
without a browser): the user's TikTok Bookmark (**Favorites** → **Drama**) as cards in the
DramaFetch tab. Since DramaFetch 3.0.0 (the owner's decision of 2026-11-25) a card shows no lasting
status — no **On disk**, **Partly** or **Not downloaded**, no locked count, no filter chips — and
nothing removes a drama from the Favorites: a card says **Queued** while a download job of its drama
waits and **Downloading · saved/total** with a progress bar while one runs, nothing otherwise (its
`data-status` `queued`, `running` or `idle`); what a download did lives in DramaFetch's records
(`series:<id>`), which every scenario here waits for once its job has ended.

A real headless Chromium loads the extension's TEST copy (`extension_harness.ExtensionHarness`)
against the fake TikTok server, whose favorites are `FAVORITES`:

- (a) the popup's **Open my library** on the fake profile lists every favorite into the library —
  cards with their covers from the fake's image CDN (each asked for once, none while the listing
  job runs; their addresses in the browser session's memory only), no status on any card, TikTok's
  count —, keeps it with nothing signed in `chrome.storage.local`, and a second **Open my library**
  with nothing changed costs ONE `drama_list` request, and so does the page's own **Update from
  TikTok**;
- (b) two dramas ticked — each card framed in the accent while ticked — and **Download selected
  dramas** download exactly as a paste of their ids does in another profile (the same files,
  names, embedded covers and rows); while the job runs each card says **Queued** — the second one
  while the first downloads — then **Downloading · saved/total** with its bar, counted from the
  records, its **Download** disabled meanwhile, and once the job has ended and its records are
  written no card says anything (the main series' meta line `5 episodes · 1m`, its locked episode
  counted nowhere); each drama, as it is done, gets its notification (1.7.0) — `✓ <drama> —
  downloaded`, its episodes on disk, its locked one in the report line's words —, shown by Chrome
  (`chrome.notifications.getAll()` lists it), none for the listing before; a click on one's body,
  dispatched to the service worker's own listener, brings the DramaFetch tab to the front — no
  job, no reload, no request — and takes it away;
- (c) a card's own **Download** (1.7.0) downloads that drama — the batch job **Download selected
  dramas** queues for it alone —: the card **Queued**, then **Downloading** with its **Download**
  disabled, its records written, the card idle again with its **Download** enabled; nothing asked
  of TikTok but that drama's own page, list, media and covers — and no library cover while the job
  runs; pressed again, it skips what is on disk as a paste does — the drama found complete, not one
  request (only **See episodes** downloads again in full, 3.0.0);
- (d) **Retry** after **Download selected dramas**: an episode whose first transfer the fake cuts
  short (`truncate_once`) is shown apart with its **Retry** button, the records say it failed (the
  card says nothing), and the drama's notification says `⚠ <drama> — 1 episode to retry` / `E02
  did not download.` with a **Retry** button; that button, clicked as Chrome hands it to the
  service worker (its own `onButtonClicked` listener,
  `chrome.notifications.onButtonClicked.dispatch` in the worker), goes to the page, which queues
  one selection job over that episode — the tab's own **Retry** — and takes the notification away:
  the episode saved byte for byte as a clean paste of its id saves it, the records whole and the
  drama's notification saying it is downloaded — with the automatic retry (1.8.0) turned off
  first: the path this scenario proves is the user's own.

No cookie value is set, printed or asserted on; nothing reaches TikTok.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from .extension_alerts import (
    ALERTS_JS,
    BODY_CLICK_JS,
    CLEARED_JS,
    RECORD_ALERTS_JS,
    RECORD_WORKER_CLEARS_JS,
    RETRY_CLICK_JS,
    in_worker,
    recorded_alerts,
)
from .extension_harness import CHROMIUM, ExtensionHarness
from .fake_tiktok import (
    CDN_PATH_RE,
    COVER_PATH_RE,
    DRAMA_LIST_PATH,
    EPISODE_OF_ITEM,
    FAVORITES,
    LIGHTHOUSE_ID,
    PROFILE_PATH,
    SECOND_SERIES_ID,
    SECOND_SERIES_NAME,
    SERIES_ID,
    SERIES_NAME,
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

#: What the worker kept of a TikTok tab's favorites list (`chrome.storage.session`), or null.
TEMPLATE_JS = "async (key) => (await chrome.storage.session.get(key))[key] ?? null"
TAB_IDS_JS = (
    "async (prefix) => (await chrome.tabs.query({}))"
    ".filter((tab) => (tab.url || tab.pendingUrl || '').startsWith(prefix)).map((tab) => tab.id)"
)
#: The English of the fake's favorites list: every drama's id, newest first.
FAVORITE_IDS = [series_id for series_id, _, _, _ in FAVORITES]
#: The library's covers on the fake image CDN (one per drama; an episode's cover is its item's).
LIBRARY_COVERS = {f"/cover/{series_id}.jpg" for series_id in FAVORITE_IDS}
#: The page's accent colour as the browser computes it (a ticked card's frame is drawn in it).
ACCENT_JS = (
    "() => { const probe = document.createElement('div'); probe.style.color = 'var(--accent)';"
    " document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove();"
    " return color; }"
)
#: The address of the tab in front, as the extension sees it.
ACTIVE_TAB_JS = (
    "async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))"
    ".map((tab) => tab.url)"
)
#: In the DramaFetch tab: what each library card says each time it changes — `[series id,
#: data-status, its status badge's text or null, its progress bar's [value, max] or null, whether
#: its Download is disabled]` — in `globalThis.__cardLog`: a `MutationObserver` on the grid, whose
#: callback runs right after each redraw, before the page goes on (no read timed against a job).
#: Nothing else changes.
RECORD_CARDS_JS = """() => {
  if (globalThis.__cardLog !== undefined) return;
  const log = [];
  globalThis.__cardLog = log;
  const grid = document.getElementById("favorites-grid");
  const note = () => {
    for (const card of grid.querySelectorAll("article[data-series-id]")) {
      const badge = card.querySelector(".favorite-status");
      const bar = card.querySelector("progress.drama-progress");
      const download = card.querySelector("[data-action='download']");
      const now = [
        card.getAttribute("data-series-id"),
        card.getAttribute("data-status"),
        badge === null ? null : badge.textContent,
        bar === null ? null : [Number(bar.getAttribute("value")), Number(bar.getAttribute("max"))],
        download === null ? null : download.disabled,
      ];
      const last = log.findLast((seen) => seen[0] === now[0]);
      if (last === undefined || JSON.stringify(last) !== JSON.stringify(now)) log.push(now);
    }
  };
  note();
  new MutationObserver(note).observe(grid, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
}"""


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


def _saved(ext: ExtensionHarness) -> dict[str, bytes]:
    """Every file saved under the download directory: its path there and its bytes."""
    return {str(path): (ext.downloads / path).read_bytes() for path in ext.saved_files()}


def _rows(entry: dict[str, Any]) -> list[tuple[str, list[tuple[int, str, str]]]]:
    """A journal entry's series and rows: `(series id, [(number, status, message)])`."""
    return [
        (
            series["series_id"],
            [(row["number"], row["status"], row["message"]) for row in series.get("rows", [])],
        )
        for series in entry["series"]
    ]


def _card_states(page: Page, series_id: str) -> list[tuple[str, str | None, Any, bool]]:
    """What the card of `series_id` said, change by change, since `RECORD_CARDS_JS`: `(status,
    badge text, bar [value, max], Download disabled)`."""
    log: list[list[Any]] = page.evaluate("() => globalThis.__cardLog ?? []")
    return [
        (status, badge, bar, disabled)
        for seen, status, badge, bar, disabled in log
        if seen == series_id
    ]


def _phases(states: list[tuple[str, str | None, Any, bool]]) -> list[str]:
    """The card's statuses in order, each run of the same one counted once."""
    phases: list[str] = []
    for status, *_ in states:
        if not phases or phases[-1] != status:
            phases.append(status)
    return phases


def _assert_job_shown(page: Page, series_id: str, total: int) -> None:
    """The card of `series_id` went `idle` → `queued` → `running` → `idle` over a job that
    downloaded its drama: **Queued** with its **Download** disabled; **Downloading · saved/total**
    with its bar at `saved` of `total` — counted from the records, so at least one episode saved
    was shown, and never counting down —, its **Download** disabled; and nothing at all, its
    **Download** enabled, before and after."""
    states = _card_states(page, series_id)
    assert _phases(states) == ["idle", "queued", "running", "idle"], states
    saved: list[int] = []
    for status, badge, bar, disabled in states:
        if status == "queued":
            assert (badge, bar, disabled) == ("Queued", None, True), states
        elif status == "running":
            match = re.fullmatch(rf"Downloading · (\d+)/{total}", badge or "")
            assert match is not None, states
            assert bar == [int(match.group(1)), total] and disabled is True, states
            saved.append(int(match.group(1)))
        else:
            assert (status, badge, bar, disabled) == ("idle", None, None, False), states
    assert saved == sorted(saved) and saved[-1] >= 1, states


def _assert_nothing_shown(card: Locator) -> None:
    """A card no job holds: `idle`, no status badge, no bar, its **Download** enabled."""
    assert card.get_attribute("data-status") == "idle"
    assert card.locator(".favorite-status").count() == 0
    assert card.locator("progress").count() == 0
    assert card.locator("[data-action='download']").is_enabled()


def test_a_open_my_library_lists_every_favorite_and_an_unchanged_refresh_costs_one_request(
    tmp_path: Path,
) -> None:
    """(a) The popup's **Open my library** on the profile: every favorite as a card, in the list's
    order, with its cover from the fake's image CDN (each once, none while the listing job runs,
    the addresses in the browser session's memory and never on disk), no status on any card and no
    filter chips (3.0.0), TikTok's count; the library kept with nothing signed; a second **Open my
    library** with nothing changed: ONE `drama_list` request, `No changes` — and the same from the
    page's own **Update from TikTok**."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
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
        assert page.locator("#library-shown").inner_text() == f"Showing {total} of {total}"
        # no lasting status on a card (3.0.0): every one `idle`, no badge, no bar, no chips
        statuses = [cards.nth(n).get_attribute("data-status") for n in range(cards.count())]
        assert statuses == ["idle"] * total
        assert page.locator("#favorites-grid .favorite-status").count() == 0
        assert page.locator("#favorites-grid progress").count() == 0
        assert page.locator("[id^='library-chip-']").count() == 0
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
        # kept across sessions: the dramas and TikTok's count — no address, no cover, nothing
        # signed, and nothing 2.x kept of the removals from the Favorites
        stored = ext.storage("favoritesLibrary")["favoritesLibrary"]
        assert [item["seriesId"] for item in stored["items"]] == FAVORITE_IDS
        assert stored["total"] == total
        assert stored["profile"] == "@invented_viewer"
        assert "removed" not in stored
        assert "http" not in json.dumps(stored)
        entry = ext.journal()[0]
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


def test_b_download_selected_dramas_downloads_exactly_as_a_paste_does(tmp_path: Path) -> None:
    """(b) The main series and the second one ticked in the library — each framed in the accent
    while ticked, as the approved sketch draws it —, **Download selected dramas**: ONE batch job,
    the same files (names and bytes: the covers embedded), the same rows and the same label as a
    paste of their ids in another profile. While it runs, each card says **Queued** (the second
    one while the first downloads), then **Downloading · saved/total** with its bar, its
    **Download** disabled; once the job has ended and the records hold every episode, no card says
    anything — the main series' meta line stays `5 episodes · 1m`, its locked episode counted
    nowhere (3.0.0). Each drama's notification says it is downloaded — none for the listing
    before —, and a click on one's body, as Chrome hands it to the service worker, brings the
    DramaFetch tab to the front (no job, no reload, no request) and takes that notification
    away."""
    with FakeTikTok() as server:
        with ExtensionHarness(tmp_path / "library", server.base_url) as ext:
            ext.page.evaluate(RECORD_ALERTS_JS)
            profile, popup, _tab = _profile_and_popup(ext, server.base_url)
            _open_library(ext, popup)
            page = ext.page
            assert page.evaluate(ALERTS_JS) == []  # a listing: no notification
            accent = page.evaluate(ACCENT_JS)
            plain = _border(_card(page, LIGHTHOUSE_ID))
            assert plain != accent
            for series_id in (SERIES_ID, SECOND_SERIES_ID):
                _card(page, series_id).locator("input[type=checkbox]").check()
                assert _border(_card(page, series_id)) == accent  # ticked: framed in the accent
            assert _border(_card(page, LIGHTHOUSE_ID)) == plain  # not ticked: as it was
            assert page.locator("#favorites-selection").inner_text() == "2 selected · 8 episodes"
            main_meta = _card(page, SERIES_ID).locator(".favorite-meta")
            assert main_meta.inner_text() == "5 episodes · 1m"  # TikTok's count and length
            assert main_meta.get_attribute("data-locked") is None
            page.evaluate(RECORD_CARDS_JS)
            jobs = ext.finished_jobs()
            page.click("#library-download")
            ext.wait_for(
                lambda: ext.finished_jobs() > jobs and ext.idle(), 120, "the downloads did not end"
            )
            library_entry = ext.journal()[0]
            library_files = _saved(ext)
            assert page.input_value("#links") == ""  # the box untouched
            # what the job did lives in the records: waited for, every episode of both dramas
            ext.wait_for_records(
                SERIES_ID, {1: "done", 2: "done", 3: "done", 4: "done", 5: "skipped-locked"}
            )
            ext.wait_for_records(SECOND_SERIES_ID, {1: "done", 2: "done", 3: "done"})
            # what the cards said meanwhile, as each change was drawn, and nothing now
            _assert_job_shown(page, SERIES_ID, 5)
            _assert_job_shown(page, SECOND_SERIES_ID, 3)
            for series_id in (SERIES_ID, SECOND_SERIES_ID):
                _assert_nothing_shown(_card(page, series_id))
            assert _phases(_card_states(page, LIGHTHOUSE_ID)) == ["idle"]  # never held
            assert _border(_card(page, SECOND_SERIES_ID)) == plain  # the ticks cleared with the job
            # each drama, as it was done, got its notification, which Chrome showed
            alerts = recorded_alerts(ext, 2)
            assert [alert["id"].split(":")[-2:] for alert in alerts] == [
                [SERIES_ID, "complete"],
                [SECOND_SERIES_ID, "complete"],
            ]
            assert [(a["options"]["title"], a["options"]["message"]) for a in alerts] == [
                (f"✓ {SERIES_NAME} — downloaded", "All 4 episodes are on disk — 1 locked (5)."),
                (f"✓ {SECOND_SERIES_NAME} — downloaded", "All 3 episodes are on disk."),
            ]
            icon = f"chrome-extension://{ext.extension_id}/icons/icon128.png"
            for alert in alerts:
                assert alert["listed"] is True  # chrome.notifications.getAll() listed it
                assert alert["options"]["iconUrl"] == icon
                assert "buttons" not in alert["options"]
                assert "contextMessage" not in alert["options"]
                assert "http" not in json.dumps(alert["options"]).replace(icon, "")
            # a click on the first one's body, the profile's tab in front: the worker brings the
            # DramaFetch tab forward as it is and takes the notification away; nothing else
            profile.bring_to_front()
            assert page.evaluate(ACTIVE_TAB_JS) == [f"{server.base_url}{PROFILE_PATH}"]

            def requests() -> int:
                """The fake's requests but the library's covers (the page may go on with those
                once a job ends, click or no click)."""
                return sum(1 for r in server.requests if not COVER_PATH_RE.match(r.path))

            before, jobs, tabs = requests(), ext.finished_jobs(), len(ext.tab_urls())
            in_worker(ext, RECORD_WORKER_CLEARS_JS)
            in_worker(ext, BODY_CLICK_JS, alerts[0]["id"])
            ext.wait_for(
                lambda: page.evaluate(ACTIVE_TAB_JS) == [ext.app_url],
                10,
                "the DramaFetch tab did not come to the front",
            )
            assert in_worker(ext, "() => globalThis.__cleared") == [alerts[0]["id"]]
            assert len(page.evaluate(ALERTS_JS)) == 2  # the same page: not reloaded
            assert (ext.finished_jobs(), ext.idle(), len(ext.tab_urls())) == (jobs, True, tabs)
            assert requests() == before  # nothing asked of the fake TikTok
            # the records read again since the job's end: the main series' card counts no locked
            # episode, and says why nowhere (1.7.0's count and tooltip are gone)
            assert main_meta.inner_text() == "5 episodes · 1m"
            assert main_meta.get_attribute("data-locked") is None
            assert main_meta.get_attribute("title") is None
        with ExtensionHarness(tmp_path / "box", server.base_url) as box:
            box_entry = box.paste_and_wait(f"{SERIES_ID}\n{SECOND_SERIES_ID}", timeout_s=120)
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


def test_c_a_card_s_own_download_downloads_that_drama_alone(tmp_path: Path) -> None:
    """(c) A card's own **Download** downloads that drama — ONE batch job, `Series <id>`, what
    **Download selected dramas** queues for it alone (1.7.0) —: its card **Queued**, then
    **Downloading · saved/3** with its bar, its **Download** disabled while the job holds it; the
    records then hold every episode, and the card says nothing again, its **Download** enabled;
    the other cards never move. Nothing is asked of TikTok but that drama's own page, list, media
    and covers — and no library cover while the job runs (one in flight before it may end first).
    Pressed again, the card's **Download** downloads as a paste does: it skips what is on disk —
    the drama found complete, not one request, the records as they were (only **See episodes**
    downloads again in full, 3.0.0)."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        _profile, popup, _tab = _profile_and_popup(ext, server.base_url)
        _open_library(ext, popup)
        page = ext.page
        page.evaluate(RECORD_CARDS_JS)
        before = len(server.requests)
        entry = ext.download_card(SECOND_SERIES_ID)
        assert (entry["kind"], entry["label"]) == ("batch", f"Series {SECOND_SERIES_ID}")
        assert entry["series"][0]["line"] == "complete: 3 of 3 (3 downloaded)"
        records = ext.wait_for_records(SECOND_SERIES_ID, {1: "done", 2: "done", 3: "done"})
        assert all(isinstance(records[n]["download_id"], int) for n in (1, 2, 3))
        assert sorted(Path(path).name for path in _saved(ext) if path.endswith(".mp4")) == [
            f"{SECOND_SERIES_NAME} - Episode {number:02d}.mp4" for number in (1, 2, 3)
        ]
        _assert_job_shown(page, SECOND_SERIES_ID, 3)
        _assert_nothing_shown(_card(page, SECOND_SERIES_ID))
        for series_id in FAVORITE_IDS:
            if series_id != SECOND_SERIES_ID:
                assert _phases(_card_states(page, series_id)) == ["idle"], series_id
        # nothing but the drama's own requests; the library's covers never while the job ran
        asked = server.requests[before:]
        own = server.series_requests(SECOND_SERIES_ID)
        assert [r for r in asked if r.path not in LIBRARY_COVERS and r not in own] == []
        assert any(CDN_PATH_RE.match(r.path) for r in asked)
        job = [n for n, r in enumerate(asked) if r.path not in LIBRARY_COVERS]
        assert not [r for r in asked[job[0] : job[-1] + 1] if r.path in LIBRARY_COVERS]
        # the card's Download again: the resume rules of a paste — complete, nothing asked
        before = len(server.requests)
        again = ext.download_card(SECOND_SERIES_ID)
        (series,) = again["series"]
        assert series["status"] == "skipped (complete)"
        assert [r for r in server.requests[before:] if r.path not in LIBRARY_COVERS] == []
        assert ext.episode_records(SECOND_SERIES_ID) == records
        _assert_nothing_shown(_card(page, SECOND_SERIES_ID))


def test_d_an_episode_a_library_download_could_not_save_is_retried_and_saved_whole(
    tmp_path: Path,
) -> None:
    """(d) The second drama ticked and **Download selected dramas**, the fake cutting the first
    transfer of its episode 2 short (`truncate_once`): episodes 1 and 3 saved, episode 2 shown apart
    — **Did not download (1)** with its **Retry** button —, the records saying so (the card says
    nothing: 3.0.0) — and its notification `⚠ … — 1 episode to retry` / `E02 did not download.`
    with ONE button, **Retry**. That button, clicked as Chrome hands the click to the service
    worker (its own `onButtonClicked` listener), is handed to the DramaFetch tab, which queues one
    selection job over that episode alone — the tab's own **Retry** — and takes the notification
    away: the episode requested once more, saved whole with its cover embedded — byte for byte what
    a clean paste of its id saves in another profile —, the block gone, the records whole and the
    drama's notification `✓ … — downloaded`. The manual path: **Retry on its own what did not
    download** (1.8.0, on by default) is unticked first, or DramaFetch would queue that retry
    itself (`test_extension_autoretry.py`)."""
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
        ExtensionHarness(tmp_path / "library", server.base_url) as ext,
    ):
        ext.turn_off_auto_retry()  # the manual Retry is what this scenario proves
        ext.page.evaluate(RECORD_ALERTS_JS)
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
        first = ext.journal()[0]
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
        records = ext.wait_for_records(SECOND_SERIES_ID, {1: "done", 2: "failed", 3: "done"})
        assert records[2]["message"] == rows[1][2] and records[2]["download_id"] is None
        _assert_nothing_shown(card)  # no Partly any more: the block and the records say it
        (alert,) = recorded_alerts(ext, 1)
        assert alert["id"].endswith(f":{SECOND_SERIES_ID}:retry")
        assert alert["listed"] is True
        options = alert["options"]
        assert (options["title"], options["message"], options["buttons"]) == (
            f"⚠ {SECOND_SERIES_NAME} — 1 episode to retry",
            "E02 did not download.",
            [{"title": "Retry"}],
        )
        assert "contextMessage" not in options  # the job did not stop

        # the notification's Retry, clicked: the worker hands it to the pages, and the page that
        # made it queues the retry — the tab's own Retry for that drama — and takes it away
        jobs = ext.finished_jobs()
        in_worker(ext, RETRY_CLICK_JS, alert["id"])
        ext.wait_for(lambda: ext.finished_jobs() > jobs and ext.idle(), 90, "the retry did not end")
        assert page.evaluate(CLEARED_JS) == [alert["id"]]
        entry = ext.journal()[0]
        assert entry["kind"] == "selection"
        assert entry["label"] == f"Retry 1 of {SECOND_SERIES_NAME}"
        ((series_id, rows),) = _rows(entry)
        assert series_id == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in rows] == [(2, "done")]
        assert rows[0][2].endswith(" + cover embedded")
        assert media_requests(server) == 2  # requested once more, now whole
        assert page.locator("#failed-block").is_hidden()
        healed = ext.wait_for_records(SECOND_SERIES_ID, {1: "done", 2: "done", 3: "done"})
        assert healed[2]["message"] == rows[0][2] and isinstance(healed[2]["download_id"], int)
        assert [healed[n]["download_id"] for n in (1, 3)] == [
            records[n]["download_id"] for n in (1, 3)
        ]
        _assert_nothing_shown(card)
        _first, done = recorded_alerts(ext, 2)  # the retry's own drama, now whole
        assert done["id"].endswith(f":{SECOND_SERIES_ID}:complete")
        assert (done["options"]["title"], done["options"]["message"]) == (
            f"✓ {SECOND_SERIES_NAME} — downloaded",
            "All 3 episodes are on disk.",
        )
        retried = _saved(ext)
    with (
        FakeTikTok() as clean,
        ExtensionHarness(tmp_path / "clean", clean.base_url) as box,
    ):
        box.paste_and_wait(SECOND_SERIES_ID, timeout_s=120)
        whole = _saved(box)
    episodes = sorted(path for path in retried if path.endswith(".mp4"))
    assert [Path(path).name for path in episodes] == [
        f"{SECOND_SERIES_NAME} - Episode {number:02d}.mp4" for number in (1, 2, 3)
    ]
    assert {path: retried[path] for path in episodes} == {path: whole[path] for path in episodes}
