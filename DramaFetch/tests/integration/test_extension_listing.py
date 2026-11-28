"""DramaFetch 3.0.1 for Chrome, end to end (`pytest -m integration`; skipped without a browser): the
owner's report of 2026-11-27 — in English, DramaFetch does not download every episode of some
dramas, sends no error message, simply skips one or two episodes, free ones, not behind a paywall,
and in the list of downloaded episodes they do not appear — and what 3.0.1 does about it.

A real headless Chromium loads the extension's TEST copy (`extension_harness.ExtensionHarness`)
against the fake TikTok server — its modes that leave episodes out of the list (`omit_once`,
`omit_always`, `lose_page_once`, `lose_page_always`, `opens_at_episode`), its fourth series (a free
episode whose list entry only LOOKS locked) and its fifth (a highlight numbered like its episode)
—, with the settings' defaults, every notification the DramaFetch tab asks Chrome for recorded on
its way (`extension_alerts.RECORD_ALERTS_JS`):

- (a) TikTok's answer for the second page leaves episode 4 out, once: the listing asks for that page
  again once the pagination is over (the gap filling: the very request, `cursor` 3) and gets it —
  every episode downloaded, no warning but the list's own (muted), ✓, the complete mark;
- (b) TikTok's list never holds episode 4: the drama ends incomplete — E04's row under **Did not
  download** (`missing from the list`), the list's warnings under the drama's header in the warning
  colour, its one automatic retry (1.8.0: one more listing, the number still missing), the ⚠ alert
  naming E04 with **Retry**, a report with the `listing` section (pages asked, the filling, the
  items skipped; no query string), no complete mark —; the tab's **Retry** lists the drama again;
- (c) the last page lost once — TikTok's JSON without a list, or an HTTP 500 —: filled, every
  episode downloaded, the pagination's fallback said (muted), no row, ✓;
- (d) the fifth series: the highlight listed before episode 2 is left out and the real episode
  kept — its own media and cover —, episode 3 numbered only in `dramaInfo.episodeNumber`
  downloads too;
- (e) a paste of a link to episode 3: the listing opens the drama at episode 1 (the fake's page
  opened at a later episode asks first for the window that holds it) and downloads E01-E04;
- (f) the fourth series (spec §9): E03, a free episode DramaFetch only GUESSED was locked (its
  list entry's sound plays 2 s of 3 s), is `not downloaded (free)` under **Did not download**, the
  ⚠ alert names it with the list's hint, a report is saved, the drama is not complete; the alert's
  **Retry** asks TikTok for E03 exactly once — the fake serves it whole — and saves it, ✓;
- (g) a complete mark written before 3.0.1 (§10): the next paste lists the drama again (every file
  on disk: nothing downloaded) and writes the mark anew; the paste after that is the complete skip;
- (h) two pastes queued (§11) — a drama whose list lacks episode 4, then another while it downloads
  —: after both, both dramas' lines and the first drama's row with **Retry** are on the page; that
  **Retry** lists the first drama again and keeps the row with its new message;
- (i) the last page never comes (`lose_page_always`, the owner's "sometimes the last one of the
  list"): the list ends early, in words — the line names the episode not received, it has its
  row, the ⚠ alert names it, the report's `listing` records the early end;
- (j) TikTok's list never holds the main series' E05 (3.0.1, the lead's D2): four episodes and a
  trailer for TikTok's 5 — the filling asks once past episode 4, no row, the drama `may be
  incomplete` (the line, the warn-coloured warnings, the ⚠ alert, the report), no complete mark;
- (k) the first page says `hasMore` with no cursor (`no_cursor_pages`, D6): an early end, the
  filling brings the rest, ✓;
- (l) the second page repeats the first (`repeat_pages`, D6): an early end, the filling's repeat
  brings nothing, E04's row, the list ended early;
- (m) 4.0.2, the owner's report of 2026-11-27: the item of episode 4 comes without its number
  (`unnumbered`) — once the gap filling asked for E04 again and got the same item, numbered 4 by
  its place, right before E05 (page 2 begins with E02 again): every episode downloaded, E04
  under its own name, the list's one more line muted, no row, ✓;
- (n) 4.0.2, the review's case: TikTok's list never holds E03 and the main series' trailer (no
  number, no play address) sits in its place — it is never taken for E03: E03 stays missing from
  the list.

No cookie value is set, printed or asserted on; nothing reaches TikTok.
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
from mutagen.mp4 import MP4

from dramafetch.catalog import PLACED_TEXT, SHORT_HEADER_HINT_PREFIX, uncertain_text
from dramafetch.discovery.browser import NO_CURSOR_WARNING, NO_LIST_WARNING, NOTHING_NEW_WARNING

from .extension_alerts import (
    CLEARED_JS,
    RECORD_ALERTS_JS,
    RETRY_CLICK_JS,
    in_worker,
    recorded_alerts,
)
from .extension_harness import CHROMIUM, ExtensionHarness
from .fake_tiktok import (
    FIFTH_HIGHLIGHT_ITEM,
    FIFTH_ITEMS,
    FIFTH_SERIES_ID,
    FIFTH_SERIES_NAME,
    FOURTH_ITEMS,
    FOURTH_SERIES_ID,
    FOURTH_SERIES_NAME,
    MEDIA_LABEL_PREFIX,
    SECOND_SERIES_ID,
    SECOND_SERIES_NAME,
    SERIES_ID,
    SERIES_NAME,
    FakeTikTok,
    cover_bytes,
)

if TYPE_CHECKING:
    from playwright.sync_api import Page

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not CHROMIUM.is_file(), reason=f"no Chromium at {CHROMIUM} (set DRAMAFETCH_CHROMIUM)"
    ),
]

MAIN_LINK = f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1"
SECOND_LINK = f"https://www.tiktok.com/shortdrama/episode/{SECOND_SERIES_ID}/1"
MAIN_FOLDER = Path("DramaFetch") / f"{SERIES_NAME} [{SERIES_ID}]"
FOURTH_FOLDER = Path("DramaFetch") / f"{FOURTH_SERIES_NAME} [{FOURTH_SERIES_ID}]"
FIFTH_FOLDER = Path("DramaFetch") / f"{FIFTH_SERIES_NAME} [{FIFTH_SERIES_ID}]"
REPORTS_FOLDER = Path("DramaFetch") / "reports"
MAIN_ITEMS = {number: f"769940000000000000{number}" for number in range(1, 6)}
FOURTH = dict(enumerate(FOURTH_ITEMS, start=1))
#: What the main series' whole list says (3.0.1): its trailer and the other drama's item are said,
#: never dropped without a word — information, no episode missing —, and so is its locked E05.
MAIN_WARNINGS = [
    "TikTok listed 1 item DramaFetch could not read (another drama's id)",
    "TikTok listed 1 item DramaFetch could not read (no episode number)",
    "1 episode looks locked",
]
#: … and when TikTok's list lacks episode 4: the hole, and (3.0.1, the lead's D2 — changed on
#: purpose) TikTok's count against the numbers listed, which other items never silence again.
MAIN_MISSING_4_WARNINGS = [
    "episode 4 missing (gap)",
    "TikTok listed 1 item DramaFetch could not read (another drama's id)",
    "TikTok listed 1 item DramaFetch could not read (no episode number)",
    "TikTok announces 5 episodes, 4 listed",
    "1 episode looks locked",
]
#: The main series' line when it came whole: E01-E04 saved, E05 locked.
MAIN_COMPLETE = "complete: 4 of 5 (4 downloaded) — 1 locked (5)"
#: … and when TikTok's list lacks episode 4.
MAIN_MISSING_4 = "incomplete: 3 of 5 — 1 locked (5); episode 4 missing from TikTok's list"
#: The extension's item_list requests for the main series when every page comes: the series page's
#: own, its replay (TikTok signs the whole query), the next page (`count` 30) — and, when the list
#: lacks something, the gap filling's request for the page that should hold it.
MAIN_LISTING = [("0", "10"), ("0", "10"), ("3", "30")]
MAIN_FILLED = [*MAIN_LISTING, ("3", "30")]
#: What the fourth series' list says of E03 (its sound plays 2 s of its 3 s): the SHORT-HEADER hint.
GUESSED_HINT = f"{SHORT_HEADER_HINT_PREFIX}2 s of 3 s"
NOT_ASKED = "1 free episode not asked for (3): TikTok's list made it look locked"


# ------------------------------------------------------------------------------- helpers


def _rows(series: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return {row["number"]: row for row in series["rows"]}


def _statuses(series: dict[str, Any]) -> list[tuple[int, str]]:
    """A journal series' rows as (number, status), by number."""
    rows = _rows(series)
    return [(number, rows[number]["status"]) for number in sorted(rows)]


def _media_of(server: FakeTikTok, item_id: str) -> list[Any]:
    return [r for r in server.media_requests if r.path.startswith(f"/cdn/{item_id}/")]


def _asked(server: FakeTikTok) -> list[tuple[str, str]]:
    """The `cursor` and `count` of every item_list request the fake saw, in order."""
    return [(r.query["cursor"], r.query["count"]) for r in server.item_list_requests]


def _report_files(ext: ExtensionHarness) -> list[Path]:
    """The "did not download" reports saved so far, relative to the download directory."""
    return [
        path
        for path in ext.saved_files()
        if path.parent == REPORTS_FOLDER and path.suffix == ".json"  # no `.crdownload` in flight
    ]


def _videos(ext: ExtensionHarness) -> list[Path]:
    """Every saved file but the reports: the episodes."""
    return [path for path in ext.saved_files() if path.parent != REPORTS_FOLDER]


def _episodes(folder: Path, name: str, numbers: range | tuple[int, ...]) -> list[Path]:
    return [folder / f"{name} - Episode {number:02d}.mp4" for number in numbers]


def _table_rows(page: Page, table: str) -> list[tuple[str, str]]:
    """The episode rows of a progress-card table as (number, status), in order."""
    rows = page.locator(f"{table} tbody tr[data-number]")
    return [
        (str(row.get_attribute("data-number")), str(row.get_attribute("data-status")))
        for row in rows.all()
    ]


def _failed_cells(page: Page) -> list[list[str]]:
    """The cells of each row of **Did not download**: drama, episode, badge, message."""
    return [
        [str(cell.text_content()) for cell in row.locator("td").all()]
        for row in page.locator("#failed-table tbody tr").all()
    ]


def _report_lines(page: Page) -> list[tuple[str, str]]:
    """The report lines under the progress card (3.0.1: every job's, for the tab's life): each
    one's outcome class and text."""
    return [
        (str(line.get_attribute("class")), str(line.text_content()))
        for line in page.locator("#report-lines li").all()
    ]


def _warning_rows(page: Page) -> list[tuple[str, str]]:
    """The list's warnings under the drama's header row of the result table (3.0.1): each row's
    class — `series-warning`, muted information, or `series-warning warn` when the list itself is
    short — and text."""
    return [
        (str(row.get_attribute("class")), str(row.text_content()))
        for row in page.locator("#result-table tr.series-warning").all()
    ]


def _until_jobs(ext: ExtensionHarness, count: int, timeout_s: float, what: str) -> None:
    """Wait until `count` jobs have finished in all and nothing runs or waits."""
    ext.wait_for(lambda: ext.finished_jobs() >= count and ext.idle(), timeout_s, what)


def _labels(ext: ExtensionHarness) -> list[str]:
    return [entry["label"] for entry in ext.journal()]


def _report_only(ext: ExtensionHarness, name: str) -> None:
    """3.0.1 (the lead's D9, the review's V3): the **Did not download** block of a job that left no
    row there but saved a report — its drama's list may be incomplete —: no heading, no **Retry**,
    no table, but the report's `Report saved: …` line and **Save the report**, enabled."""
    page = ext.page
    ext.wait_for(lambda: page.locator("#failed-report").is_visible(), 10, "no Report saved line")
    assert page.locator("#failed-block").is_visible()
    for hidden in ("#failed-heading", "#retry-button", "#failed-table"):
        assert page.locator(hidden).is_hidden(), hidden
    saved = page.locator("#failed-report").text_content() or ""
    assert saved.startswith(f"Report saved: {name} - did not download "), saved
    assert saved.endswith(".json"), saved
    button = page.locator("#report-button")
    assert button.is_visible() and button.is_enabled()


def _reports_by_kind(ext: ExtensionHarness, count: int) -> dict[str, dict[str, Any]]:
    """The `count` reports saved so far, once they are all there, by their job's kind."""
    ext.wait_for(lambda: len(_report_files(ext)) == count, 20, f"not {count} reports saved")
    reports = [
        json.loads((ext.downloads / path).read_text(encoding="utf-8"))
        for path in _report_files(ext)
    ]
    return {report["job"]["kind"]: report for report in reports}


def _page_html(server: FakeTikTok, series_id: str, episode: int) -> str:
    """The fake's series page opened at `episode`, straight over HTTP (no browser, no proxy)."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    url = f"{server.base_url}/shortdrama/episode/{series_id}/{episode}"
    with opener.open(url, timeout=10) as response:
        return str(response.read().decode("utf-8"))


def _set_series_state(ext: ExtensionHarness, series_id: str, state: dict[str, Any]) -> None:
    """Put `state` in `chrome.storage.local` as DramaFetch's record of `series_id`."""
    ext.page.evaluate(
        "([key, value]) => chrome.storage.local.set({ [key]: value })",
        [f"series:{series_id}", state],
    )


# ------------------------------------------------------------------------------ scenarios


def test_a_an_episode_left_out_of_one_page_once_is_asked_for_again_and_downloaded(
    tmp_path: Path,
) -> None:
    """(a) TikTok's answer for the second page leaves E04 out, once: the list E01-E03, E05 has a
    hole, and once the pagination is over the listing asks for that page again — the very request
    the pagination made (`cursor` 3, `count` 30) —, which holds E04. Every episode downloads, the
    drama is complete and marked so, no automatic retry, no row, no report, the ✓ alert, and no
    warning but the list's own, muted: nothing is missing."""
    with (
        FakeTikTok(omit_once=frozenset({(SERIES_ID, 4)})) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        entry = ext.paste_and_wait(MAIN_LINK)
        assert _labels(ext) == [entry["label"]]  # nothing queued after it
        (series,) = entry["series"]
        assert (series["status"], series["line"]) == ("complete", MAIN_COMPLETE)
        assert series["warnings"] == MAIN_WARNINGS
        assert _statuses(series) == [(n, "done") for n in range(1, 5)] + [(5, "skipped-locked")]
        assert _asked(server) == MAIN_FILLED  # one request more than a whole list: the filling's
        assert [len(_media_of(server, MAIN_ITEMS[n])) for n in range(1, 6)] == [1, 1, 1, 1, 0]
        assert _videos(ext) == _episodes(MAIN_FOLDER, SERIES_NAME, range(1, 5))
        assert _warning_rows(page) == [("series-warning", text) for text in MAIN_WARNINGS]
        assert _report_lines(page) == [("complete", f"{SERIES_NAME}: {MAIN_COMPLETE}")]
        assert page.locator("#failed-block").is_hidden()
        assert _report_files(ext) == []
        state = ext.series_state(SERIES_ID)
        assert state is not None
        assert (state["complete_episodes"], state["complete_rule"]) == (4, 2)
        (alert,) = recorded_alerts(ext, 1)
        assert (alert["options"]["title"], alert["options"]["message"]) == (
            f"✓ {SERIES_NAME} — downloaded",
            "All 4 episodes are on disk — 1 locked (5).",
        )


def test_b_an_episode_tiktok_s_list_never_holds_is_shown_alerted_retried_and_reported(
    tmp_path: Path,
) -> None:
    """(b) TikTok's list never holds E04: the filling asks for its page once, then the paste's job
    downloads E01-E03 and ends incomplete — E04 gets a row of its own (`failed-unavailable`, `not in
    TikTok's list`), never asked of the CDN. Its one automatic retry (1.8.0) lists the drama once
    more and E04 is still missing (`not in TikTok's list this time`); no second one. The page shows
    both jobs' lines, the list's warnings in the warning colour, E04 under **Did not download**
    (`missing from the list`) with **Retry**; the notification goes from `↻` to the ⚠ alert naming
    E04 with **Retry**; each job saves a report whose `listing` section shows the pages asked —
    host and path only — and what each brought, the filling's request among them; no complete
    mark. The tab's **Retry** then lists the drama again, its filling included, and keeps the row
    — a new download, whose still-missing E04 gets its own one automatic retry, and no more."""
    with (
        FakeTikTok(omit_always=frozenset({(SERIES_ID, 4)})) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        ext.paste(MAIN_LINK)
        _until_jobs(ext, jobs + 2, 120, "the paste and its automatic retry did not end")
        journal = ext.journal()
        assert len(journal) == 2  # the paste's job and its one automatic retry
        automatic, pasted = journal

        assert pasted["kind"] == "batch" and pasted["stopped"] is None
        (series,) = pasted["series"]
        assert (series["status"], series["line"]) == ("incomplete", MAIN_MISSING_4)
        assert series["warnings"] == MAIN_MISSING_4_WARNINGS
        assert _statuses(series) == [
            (1, "done"),
            (2, "done"),
            (3, "done"),
            (4, "failed-unavailable"),
            (5, "skipped-locked"),
        ]
        assert _rows(series)[4]["message"] == "not in TikTok's list"
        assert automatic["kind"] == "selection" and automatic["stopped"] is None
        assert automatic["label"] == f"Automatic retry: 1 of {SERIES_NAME}"
        (retried,) = automatic["series"]
        assert [(row["number"], row["status"], row["message"]) for row in retried["rows"]] == [
            (4, "failed-unavailable", "not in TikTok's list this time")
        ]
        # two listings, each with its one filling request; E04 never asked of the CDN
        assert len(server.series_page_requests) == 2
        assert _asked(server) == MAIN_FILLED * 2
        assert [len(_media_of(server, MAIN_ITEMS[n])) for n in range(1, 6)] == [1, 1, 1, 0, 0]
        assert _videos(ext) == _episodes(MAIN_FOLDER, SERIES_NAME, range(1, 4))

        # the page: both jobs' lines, the warnings in the warning colour, E04's row and Retry
        assert _report_lines(page) == [("incomplete", f"{SERIES_NAME}: {MAIN_MISSING_4}")] * 2
        assert _warning_rows(page) == [
            ("series-warning warn", text) for text in MAIN_MISSING_4_WARNINGS
        ]
        assert page.locator("#failed-block").is_visible()
        assert page.locator("#failed-heading").text_content() == "Did not download (1)"
        assert _table_rows(page, "#failed-table") == [("4", "failed-unavailable")]
        assert _failed_cells(page) == [
            [SERIES_NAME, "E04", "missing from the list", "not in TikTok's list this time"]
        ]
        badge = page.locator("#failed-table tbody tr").first.locator(".badge")
        assert badge.get_attribute("class") == "badge failed"
        assert page.locator("#failed-auto").is_hidden()  # nothing more is retried on its own
        retry = page.locator("#retry-button")
        assert retry.is_visible() and retry.is_enabled()
        assert retry.text_content() == "Retry the episodes that did not download (1)"

        # the notification: ↻ while the automatic retry waits, then the ⚠ alert with Retry
        retrying, alert = recorded_alerts(ext, 2)
        assert (retrying["options"]["title"], retrying["options"]["message"]) == (
            f"↻ {SERIES_NAME} — retrying 1 episode",
            "E04 is not in TikTok's list. DramaFetch tries once more on its own.",
        )
        assert "buttons" not in retrying["options"]
        assert alert["id"] == retrying["id"] and alert["id"].endswith(f":{SERIES_ID}:retry")
        assert alert["listed"] is True
        options = alert["options"]
        assert (
            options["title"],
            options["message"],
            options["buttons"],
            options["contextMessage"],
        ) == (
            f"⚠ {SERIES_NAME} — 1 episode to retry",
            "E04 is not in TikTok's list.",
            [{"title": "Retry"}],
            "After an automatic retry.",
        )

        # no complete mark: the next paste lists the drama again
        state = ext.series_state(SERIES_ID)
        assert state is not None
        assert (state["complete_at"], state["complete_rule"]) == (None, None)

        # the reports: the paste's (E04, and the locked E05) and the automatic retry's (E04)
        reports = _reports_by_kind(ext, 2)
        (reported,) = reports["batch"]["series"]
        not_downloaded = reported["not_downloaded"]
        assert [(row["number"], row["status"], row["message"]) for row in not_downloaded] == [
            (4, "failed-unavailable", "not in TikTok's list"),
            (5, "skipped-locked", _rows(series)[5]["message"]),
        ]
        assert not_downloaded[0]["attempted"] is False and not_downloaded[0]["attempts"] == []
        # 3.0.1 (the lead's D10, changed on purpose): the cause says what is true whether or not the
        # gap filling reached the episode's page — the listing section shows the pages asked
        assert not_downloaded[0]["probable_cause"].startswith(
            "missing from the episode list TikTok served to your session (this series' listing "
            "section shows each page asked, the gap filling's included, and what it brought)"
        )
        listing = reported["listing"]
        assert listing["endpoint"] == f"{server.base_url}/api/drama/episode/item_list/"
        assert (
            listing["tiktok_count"],
            listing["items_received"],
            listing["episodes_listed"],
            listing["missing_numbers"],
            listing["ended_early"],
            listing["incomplete"],
            listing["fill_requests"],
        ) == (5, 5, 4, [4], None, True, 1)
        assert [
            (p["kind"], p["cursor_asked"], p["count_asked"], p["numbers"], p["has_more"])
            for p in listing["pages"]
        ] == [
            ("first", "0", "10", [1, 2, 3], True),
            ("next", "3", "30", [2, 5], False),
            ("fill", "3", "30", [2, 5], False),
        ]
        assert listing["skipped_items"] == [
            {"reason": "no episode number", "item_id": "7699400000000000099"},
            {"reason": "another drama's id", "item_id": "7699400000000000777"},
        ]
        assert listing["warnings"] == series["warnings"]
        for secret in ("?", "X-Bogus", "aid=", "dramaID", "sessionid"):
            assert secret not in json.dumps(listing), secret
        (again,) = reports["selection"]["series"]
        assert [row["number"] for row in again["not_downloaded"]] == [4]
        assert again["listing"]["fill_requests"] == 1

        # the tab's Retry: E04 alone, a fresh listing with its filling, the row kept — a new
        # download, so E04, still missing, gets that download's one automatic retry (1.8.0: once
        # per download, never for an automatic retry's own rows), and no more
        jobs = ext.finished_jobs()
        page.click("#retry-button")
        _until_jobs(ext, jobs + 2, 120, "the Retry and its automatic retry did not end")
        automatic, manual = ext.journal()[:2]
        assert manual["kind"] == "selection" and manual["label"] == f"Retry 1 of {SERIES_NAME}"
        assert automatic["label"] == f"Automatic retry: 1 of {SERIES_NAME}"
        for entry in (manual, automatic):
            (retried,) = entry["series"]
            assert [(row["number"], row["status"], row["message"]) for row in retried["rows"]] == [
                (4, "failed-unavailable", "not in TikTok's list this time")
            ]
        assert len(ext.journal()) == 4
        assert len(server.series_page_requests) == 4
        assert _asked(server) == MAIN_FILLED * 4
        assert [len(_media_of(server, MAIN_ITEMS[n])) for n in range(1, 6)] == [1, 1, 1, 0, 0]
        assert _table_rows(page, "#failed-table") == [("4", "failed-unavailable")]
        assert len(_report_lines(page)) == 4  # every job's line stays


@pytest.mark.parametrize("status", [200, 500], ids=["no-list", "http-500"])
def test_c_a_lost_last_page_is_asked_for_again_and_every_episode_downloads(
    tmp_path: Path, status: int
) -> None:
    """(c) The last page is lost the first time it is asked for — TikTok's JSON without a list, or
    an HTTP 500 —: the pagination says so and scrolls (the page loads nothing more), and once it is
    over the filling asks for that page again, which comes. Every episode downloads, the drama is
    complete and marked so, ✓, no row, no report; the pagination's fallback stays said, muted:
    the list came whole in the end."""
    lost = frozenset({(SERIES_ID, "3")})
    with (
        FakeTikTok(lose_page_once=lost, lost_page_status=status) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        entry = ext.paste_and_wait(MAIN_LINK)
        assert _labels(ext) == [entry["label"]]
        (series,) = entry["series"]
        assert (series["status"], series["line"]) == ("complete", MAIN_COMPLETE)
        assert series["warnings"] == [NO_LIST_WARNING, *MAIN_WARNINGS]
        assert _statuses(series) == [(n, "done") for n in range(1, 5)] + [(5, "skipped-locked")]
        assert _asked(server) == MAIN_FILLED  # the lost request, then the filling's
        assert _videos(ext) == _episodes(MAIN_FOLDER, SERIES_NAME, range(1, 5))
        assert _warning_rows(page) == [
            ("series-warning", text) for text in [NO_LIST_WARNING, *MAIN_WARNINGS]
        ]
        assert page.locator("#failed-block").is_hidden()
        assert _report_files(ext) == []
        state = ext.series_state(SERIES_ID)
        assert state is not None and state["complete_rule"] == 2
        (alert,) = recorded_alerts(ext, 1)
        assert alert["options"]["title"] == f"✓ {SERIES_NAME} — downloaded"


def test_d_a_highlight_numbered_like_its_episode_is_left_out_and_the_episode_kept(
    tmp_path: Path,
) -> None:
    """(d) The fifth series, the owner's real item shape: a highlight numbered 2 is listed BEFORE
    episode 2. DramaFetch keeps the real episode — its media and its cover, never the
    highlight's —, numbers episode 3 from `dramaInfo.episodeNumber` (its `EpisodeNumber` is 0) and
    says what it left out (the highlight, the trailer, another drama's item). 3.0.1, the lead's
    decision D2 (changed on purpose): TikTok's count of 7 may count the highlight and the trailer,
    or two episodes past 5 may be missing — the list is uncertain: the filling asks once for the
    page after episode 5, no number gets a row, and the drama reads `may be incomplete`, its
    warnings in the warning colour, no complete mark."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        page = ext.page
        entry = ext.paste_and_wait(FIFTH_SERIES_ID)
        (series,) = entry["series"]
        assert (series["name"], series["status"]) == (FIFTH_SERIES_NAME, "incomplete")
        assert series["line"] == (
            "incomplete: 5 of 5 — TikTok's list may be incomplete: TikTok counts 7 episodes, 5 "
            "listed and 2 other items (trailers or highlights)"
        )
        warnings = [
            f"duplicate episode number 2: item {FIFTH_HIGHLIGHT_ITEM} left out (a highlight), "
            f"item {FIFTH_ITEMS[2]} kept",
            "TikTok listed 1 item DramaFetch could not read (another drama's id)",
            "TikTok listed 1 item DramaFetch could not read (no episode number)",
            "TikTok announces 7 episodes, 5 listed",
            uncertain_text(7, 5, 2),
        ]
        assert series["warnings"] == warnings
        assert _statuses(series) == [(n, "done") for n in range(1, 6)]
        assert [r.path for r in server.media_requests] == [
            f"/cdn/{FIFTH_ITEMS[n]}/0.mp4" for n in range(1, 6)
        ]
        assert not [r for r in server.requests if FIFTH_HIGHLIGHT_ITEM in r.path]
        # the page's own, its replay, the next page and the filling's one request: the page after 5
        assert _asked(server) == [("0", "10"), ("0", "10"), ("5", "30"), ("5", "30")]
        assert _videos(ext) == _episodes(FIFTH_FOLDER, FIFTH_SERIES_NAME, range(1, 6))
        for number, item in FIFTH_ITEMS.items():
            path = ext.downloads / FIFTH_FOLDER / f"{FIFTH_SERIES_NAME} - Episode {number:02d}.mp4"
            assert MEDIA_LABEL_PREFIX + item.encode() in path.read_bytes()  # its own media
            mp4 = MP4(path)
            assert mp4.tags is not None
            (cover,) = mp4.tags["covr"]
            assert bytes(cover) == cover_bytes(item)  # and its own cover
        assert _warning_rows(page) == [("series-warning warn", text) for text in warnings]
        # no row: nothing to retry — 3.0.1 (the lead's D9, changed on purpose: the block was
        # hidden): the report saved for a list that may be incomplete is said all the same
        _report_only(ext, FIFTH_SERIES_NAME)
        state = ext.series_state(FIFTH_SERIES_ID)
        assert state is not None and state["complete_at"] is None


def test_e_a_paste_of_a_link_to_episode_3_downloads_the_whole_drama(tmp_path: Path) -> None:
    """(e) A link to episode 3 pasted: the listing opens the drama's page at episode 1 — the fake's
    page opened at a later episode asks first for the window that holds it (`opens_at_episode`),
    as TikTok's player page may — so the list starts at the beginning and needs no filling: E01-E04
    downloaded, E05 locked. The episode in the link picks nothing."""
    link = f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/3"
    with (
        FakeTikTok(opens_at_episode=True) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        entry = ext.paste_and_wait(link)
        (series,) = entry["series"]
        assert (series["status"], series["line"]) == ("complete", MAIN_COMPLETE)
        assert _statuses(series) == [(n, "done") for n in range(1, 5)] + [(5, "skipped-locked")]
        assert [r.path for r in server.series_page_requests] == [
            f"/shortdrama/episode/{SERIES_ID}/1"
        ]
        assert _asked(server) == MAIN_LISTING
        assert _videos(ext) == _episodes(MAIN_FOLDER, SERIES_NAME, range(1, 5))
        # what the fake's page opened at episode 3 would have asked first: the window from E03
        assert "cursor: 2," in _page_html(server, SERIES_ID, 3)


def test_f_a_free_episode_only_guessed_locked_is_shown_alerted_and_its_retry_saves_it(
    tmp_path: Path,
) -> None:
    """(f) The fourth series, the owner's real shape: E03's list entry has no price, no lock flag
    from TikTok and no DRM clue — only DramaFetch's own SHORT-HEADER rule guesses it is locked (its
    sound plays 2 s of 3 s). The paste saves E01-E02 and asks nothing for E03 (`skipped-locked`, no
    automatic retry: DramaFetch never asks on its own for an episode it judged locked), but E03 is
    `not downloaded (free)` under **Did not download**, failure-coloured, with **Retry**; the line
    says the drama is incomplete; the ⚠ alert names E03 with the list's hint; a report is saved; no
    complete mark. The alert's **Retry** asks TikTok for E03 exactly once — the fake serves it
    whole — and saves it: the drama complete, ✓, and every job's line on the page."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        entry = ext.paste_and_wait(FOURTH_SERIES_ID)
        assert _labels(ext) == [entry["label"]]  # no automatic retry for a guessed lock
        (series,) = entry["series"]
        line = f"incomplete: 2 of 3 — {NOT_ASKED}"
        assert (series["status"], series["line"]) == ("incomplete", line)
        assert _statuses(series) == [(1, "done"), (2, "done"), (3, "skipped-locked")]
        third = _rows(series)[3]
        assert third["message"] == f"looks locked: {GUESSED_HINT}"
        assert third.get("guessed") is True
        assert [len(_media_of(server, FOURTH[n])) for n in (1, 2, 3)] == [1, 1, 0]

        # the page: E03 under Did not download, failure-coloured, with Retry; the line
        assert _report_lines(page) == [("incomplete", f"{FOURTH_SERIES_NAME}: {line}")]
        assert page.locator("#failed-block").is_visible()
        assert page.locator("#failed-heading").text_content() == "Did not download (1)"
        assert _table_rows(page, "#failed-table") == [("3", "skipped-locked")]
        assert _failed_cells(page) == [
            [FOURTH_SERIES_NAME, "E03", "not downloaded (free)", f"looks locked: {GUESSED_HINT}"]
        ]
        row = page.locator("#failed-table tbody tr").first
        assert row.locator(".badge").get_attribute("class") == "badge failed"
        assert row.locator(".badge").get_attribute("data-guessed") == "1"
        assert page.locator("#retry-button").is_enabled()
        # the batch table counts E03 under `Not asked`, never under Locked (3.0.1, the lead's D12)
        assert page.locator("#batch-table thead th").all_inner_texts() == [
            "Series",
            "Status",
            "Listed",
            "Downloaded",
            "On disk",
            "Locked",
            "Not asked",
            "Failed",
        ]
        assert page.locator("#batch-table tbody td").all_inner_texts() == [
            FOURTH_SERIES_NAME,
            "incomplete",
            "3",
            "2",
            "0",
            "0",
            "1",
            "0",
        ]

        # the ⚠ alert naming E03 with the list's hint, and its Retry
        (alert,) = recorded_alerts(ext, 1)
        assert alert["id"].endswith(f":{FOURTH_SERIES_ID}:retry") and alert["listed"] is True
        options = alert["options"]
        assert (options["title"], options["message"], options["buttons"]) == (
            f"⚠ {FOURTH_SERIES_NAME} — 1 episode to retry",
            f"E03 was not asked for: TikTok's list made it look locked ({GUESSED_HINT}).",
            [{"title": "Retry"}],
        )
        assert "contextMessage" not in options

        # the report: E03 not asked for, why, and the digest's guessed flag
        report = _reports_by_kind(ext, 1)["batch"]
        (reported,) = report["series"]
        (not_downloaded,) = reported["not_downloaded"]
        assert (not_downloaded["number"], not_downloaded["status"]) == (3, "skipped-locked")
        assert not_downloaded["guessed_lock"] is True and not_downloaded["attempted"] is False
        assert not_downloaded["probable_cause"].startswith(
            "not asked for: free in the list TikTok served, but DramaFetch's own rules guessed it "
            f"was locked: {GUESSED_HINT}"
        )
        assert [item["guessed_lock"] for item in reported["episodes_digest"]] == [
            False,
            False,
            True,
        ]
        state = ext.series_state(FOURTH_SERIES_ID)
        assert state is not None and state["complete_at"] is None

        # the alert's Retry: one request for E03, which TikTok serves whole, saved
        in_worker(ext, RETRY_CLICK_JS, alert["id"])
        _until_jobs(ext, jobs + 2, 90, "the alert's retry did not end")
        assert page.evaluate(CLEARED_JS) == [alert["id"]]
        retry = ext.journal()[0]
        assert retry["kind"] == "selection"
        assert retry["label"] == f"Retry 1 of {FOURTH_SERIES_NAME}"
        (retried,) = retry["series"]
        assert [(row["number"], row["status"]) for row in retried["rows"]] == [(3, "done")]
        assert retried["rows"][0]["message"].endswith(" + cover embedded")
        complete = "complete: 3 of 3 (1 downloaded, 2 already on disk)"
        assert (retried["status"], retried["line"]) == ("complete", complete)
        assert [len(_media_of(server, FOURTH[n])) for n in (1, 2, 3)] == [1, 1, 1]  # E03: once
        assert _videos(ext) == _episodes(FOURTH_FOLDER, FOURTH_SERIES_NAME, (1, 2, 3))
        saved = ext.downloads / FOURTH_FOLDER / f"{FOURTH_SERIES_NAME} - Episode 03.mp4"
        assert MEDIA_LABEL_PREFIX + FOURTH[3].encode() in saved.read_bytes()
        assert abs(MP4(saved).info.length - 3) < 0.5  # the whole episode
        assert page.locator("#failed-block").is_hidden()
        # its batch table: nothing left not asked for (D12)
        cells = page.locator("#batch-table tbody td").all_inner_texts()
        assert cells == [FOURTH_SERIES_NAME, "complete", "3", "1", "2", "0", "0", "0"]
        assert _report_lines(page) == [
            ("incomplete", f"{FOURTH_SERIES_NAME}: {line}"),
            ("complete", f"{FOURTH_SERIES_NAME}: {complete}"),
        ]
        records = ext.episode_records(FOURTH_SERIES_ID)
        assert {number: entry["status"] for number, entry in records.items()} == {
            1: "done",
            2: "done",
            3: "done",
        }
        _alert, done = recorded_alerts(ext, 2)
        assert done["id"].endswith(f":{FOURTH_SERIES_ID}:complete")
        assert (done["options"]["title"], done["options"]["message"]) == (
            f"✓ {FOURTH_SERIES_NAME} — downloaded",
            "All 3 episodes are on disk.",
        )


def test_g_a_complete_mark_written_before_3_0_1_lists_the_drama_again(tmp_path: Path) -> None:
    """(g) DramaFetch's record of a drama found complete by 3.0.0 carries no `complete_rule`: the
    old completeness rule may have hidden its last episodes or a free one guessed locked, so the
    next paste does not trust it — it lists the drama again in a tab of its own (one ordinary
    listing), finds every episode on disk (no media request) and writes the mark anew under the
    rule in force; the paste after that is the complete skip: not one request, no tab."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        ext.paste_and_wait(MAIN_LINK)
        state = ext.series_state(SERIES_ID)
        assert state is not None
        assert (state["complete_episodes"], state["complete_rule"]) == (4, 2)
        del state["complete_rule"]  # the record as DramaFetch 3.0.0 wrote it
        _set_series_state(ext, SERIES_ID, state)
        old = ext.series_state(SERIES_ID)
        assert old is not None and old["complete_at"] and "complete_rule" not in old
        pages, media = len(server.series_page_requests), len(server.media_requests)
        lists = len(server.item_list_requests)

        ext.watch_tabs()
        again = ext.paste_and_wait(MAIN_LINK)
        (series,) = again["series"]
        assert series["status"] == "complete"  # listed and checked, not `skipped (complete)`
        assert series["line"] == "complete: 4 of 5 (4 already on disk) — 1 locked (5)"
        assert _statuses(series) == [(n, "skipped-exists") for n in range(1, 5)] + [
            (5, "skipped-locked")
        ]
        assert len(ext.opened_tabs()) == 1  # the listing's tab
        assert len(server.series_page_requests) == pages + 1
        assert _asked(server)[lists:] == MAIN_LISTING
        assert len(server.media_requests) == media  # every file on disk: nothing downloaded
        marked = ext.series_state(SERIES_ID)
        assert marked is not None and marked["complete_rule"] == 2  # the mark written anew

        requests, tabs = len(server.requests), len(ext.opened_tabs())
        third = ext.paste_and_wait(MAIN_LINK)
        assert third["series"][0]["status"] == "skipped (complete)"
        assert len(server.requests) == requests  # the complete skip: not one request
        assert len(ext.opened_tabs()) == tabs


def test_h_two_pastes_queued_keep_both_lines_and_the_first_drama_s_missing_row(
    tmp_path: Path,
) -> None:
    """(h) A drama whose list lacks E04 is pasted, then — while it downloads — another drama: the
    second paste waits in the queue and runs after it. With the automatic retry off (it would take
    E04 once on its own: `test_b`), after both jobs the page still shows the first drama's line
    next to the second's, and the first drama's E04 under **Did not download** with **Retry** —
    the second job no longer wipes them (3.0.1, §11); the result table shows the job that ran last.
    That **Retry** lists the first drama again and keeps E04's row, with its new message."""
    # a pace between episodes long enough to paste the second drama while the first downloads
    with (
        FakeTikTok(omit_always=frozenset({(SERIES_ID, 4)})) as server,
        ExtensionHarness(
            tmp_path, server.base_url, test_settings={"delayMinS": 1, "delayMaxS": 1}
        ) as ext,
    ):
        page = ext.page
        ext.turn_off_auto_retry()
        jobs = ext.finished_jobs()
        ext.paste(MAIN_LINK)
        ext.wait_for(lambda: page.input_value("#links") == "", 10, "the first paste was refused")
        ext.wait_for(lambda: not ext.idle(), 10, "the first paste's job did not start")
        ext.paste(SECOND_LINK)
        ext.wait_for(lambda: page.input_value("#links") == "", 10, "the second paste was refused")
        waiting = page.locator(f"#queue-list li[data-series-id='{SECOND_SERIES_ID}']")
        assert waiting.count() == 1  # the second drama waits behind the first job
        assert not ext.idle()
        _until_jobs(ext, jobs + 2, 120, "the two pastes did not end")

        second, first = ext.journal()
        assert [s["series_id"] for s in first["series"]] == [SERIES_ID]
        assert [s["series_id"] for s in second["series"]] == [SECOND_SERIES_ID]
        assert first["series"][0]["line"] == MAIN_MISSING_4
        second_line = "complete: 3 of 3 (3 downloaded)"
        assert second["series"][0]["line"] == second_line
        assert first["finished_at"] <= second["started_at"]  # one after the other

        assert _report_lines(page) == [
            ("incomplete", f"{SERIES_NAME}: {MAIN_MISSING_4}"),
            ("complete", f"{SECOND_SERIES_NAME}: {second_line}"),
        ]
        assert page.locator("#failed-block").is_visible()
        assert page.locator("#failed-heading").text_content() == "Did not download (1)"
        assert _failed_cells(page) == [
            [SERIES_NAME, "E04", "missing from the list", "not in TikTok's list"]
        ]
        failed = page.locator("#failed-table tbody tr").first
        assert failed.get_attribute("data-series-id") == SERIES_ID
        retry = page.locator("#retry-button")
        assert retry.is_visible() and retry.is_enabled()
        assert retry.text_content() == "Retry the episodes that did not download (1)"
        # the result table: the job that ran last, the second drama
        assert _table_rows(page, "#result-table") == [("1", "done"), ("2", "done"), ("3", "done")]

        pages = len(server.series_page_requests)
        entry = ext._run("#retry-button", 90)
        assert entry["kind"] == "selection" and entry["label"] == f"Retry 1 of {SERIES_NAME}"
        (retried,) = entry["series"]
        assert retried["series_id"] == SERIES_ID
        assert [(row["number"], row["status"], row["message"]) for row in retried["rows"]] == [
            (4, "failed-unavailable", "not in TikTok's list this time")
        ]
        assert len(server.series_page_requests) == pages + 1  # the first drama listed again
        assert _failed_cells(page) == [
            [SERIES_NAME, "E04", "missing from the list", "not in TikTok's list this time"]
        ]
        assert [text for _, text in _report_lines(page)] == [
            f"{SERIES_NAME}: {MAIN_MISSING_4}",
            f"{SECOND_SERIES_NAME}: {second_line}",
            f"{SERIES_NAME}: {MAIN_MISSING_4}",
        ]


def test_i_a_last_page_tiktok_never_brings_ends_the_list_early_and_says_so(
    tmp_path: Path,
) -> None:
    """(i) The owner's "sometimes the last one of the list": TikTok never brings the second page
    (`lose_page_always`). The pagination and then the gap filling ask for it, once each; the
    paste's job saves E01-E03 and ends EARLY, in words — its line says which episode was not
    received; E04 gets a row of its own (`not in TikTok's list: it ended early`) under **Did not
    download**; the list's warnings show in the warning colour —; its one automatic retry lists the
    drama once more and E04 is still missing; the ⚠ alert names it with **Retry**; the report's
    `listing` says the list ended early and shows the pages that brought no list; no complete
    mark. 3.0.1, the lead's decision D2 (changed on purpose): TikTok counts 5, three episodes and
    the trailer came — E04 is certainly missing, E05 may be the trailer TikTok counts: no row for
    E05, the line says the list may be incomplete."""
    early = (
        "incomplete: 3 of 4 — TikTok's list ended early: episode 4 not received; TikTok's list may "
        "be incomplete: TikTok counts 5 episodes, 3 listed and 1 other item (a trailer or a "
        "highlight)"
    )
    warnings = [
        NO_LIST_WARNING,
        "TikTok listed 1 item DramaFetch could not read (no episode number)",
        "TikTok announces 5 episodes, 3 listed",
        uncertain_text(5, 3, 1),
    ]
    with (
        FakeTikTok(lose_page_always=frozenset({(SERIES_ID, "3")})) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        ext.paste(MAIN_LINK)
        _until_jobs(ext, jobs + 2, 120, "the paste and its automatic retry did not end")
        journal = ext.journal()
        assert len(journal) == 2  # the paste's job and its one automatic retry
        automatic, pasted = journal
        (series,) = pasted["series"]
        assert (series["status"], series["line"]) == ("incomplete", early)
        assert series["warnings"] == warnings
        assert _statuses(series) == [
            (1, "done"),
            (2, "done"),
            (3, "done"),
            (4, "failed-unavailable"),
        ]
        rows = _rows(series)
        assert rows[4]["message"] == "not in TikTok's list: it ended early"
        assert automatic["label"] == f"Automatic retry: 1 of {SERIES_NAME}"
        (retried,) = automatic["series"]
        assert [(row["number"], row["message"]) for row in retried["rows"]] == [
            (4, "not in TikTok's list this time"),
        ]
        # each listing: the page's own request, its replay, the lost next page, the filling's
        # request (lost again)
        assert _asked(server) == MAIN_FILLED * 2
        assert [len(_media_of(server, MAIN_ITEMS[n])) for n in range(1, 6)] == [1, 1, 1, 0, 0]

        # the page: both jobs' lines, the warnings in the warning colour, a row each and Retry
        assert _report_lines(page) == [("incomplete", f"{SERIES_NAME}: {early}")] * 2
        assert _warning_rows(page) == [("series-warning warn", text) for text in warnings]
        assert page.locator("#failed-heading").text_content() == "Did not download (1)"
        assert _failed_cells(page) == [
            [SERIES_NAME, "E04", "missing from the list", "not in TikTok's list this time"],
        ]
        assert page.locator("#retry-button").is_enabled()

        # the notification: ↻, then the ⚠ alert naming E04 with Retry
        retrying, alert = recorded_alerts(ext, 2)
        assert retrying["options"]["title"] == f"↻ {SERIES_NAME} — retrying 1 episode"
        options = alert["options"]
        assert (
            options["title"],
            options["message"],
            options["buttons"],
            options["contextMessage"],
        ) == (
            f"⚠ {SERIES_NAME} — 1 episode to retry",
            "E04 is not in TikTok's list.",
            [{"title": "Retry"}],
            "After an automatic retry.",
        )

        # the paste's report: the early end in its listing section
        (reported,) = _reports_by_kind(ext, 2)["batch"]["series"]
        listing = reported["listing"]
        assert (
            listing["tiktok_count"],
            listing["items_received"],
            listing["other_items"],
            listing["uncertain"],
            listing["missing_numbers"],
            listing["ended_early"],
            listing["incomplete"],
            listing["fill_requests"],
        ) == (5, 4, 1, True, [4], NO_LIST_WARNING, True, 1)
        assert [
            (p["kind"], p["cursor_asked"], p["listed"], p["numbers"]) for p in listing["pages"]
        ] == [
            ("first", "0", True, [1, 2, 3]),
            ("next", "3", False, []),
            ("fill", "3", False, []),
        ]
        assert [(row["number"], row["message"]) for row in reported["not_downloaded"]] == [
            (4, "not in TikTok's list: it ended early"),
        ]
        state = ext.series_state(SERIES_ID)
        assert state is not None and state["complete_at"] is None


def test_j_the_main_series_without_its_last_episode_may_be_incomplete_and_says_so(
    tmp_path: Path,
) -> None:
    """(j) 3.0.1, the lead's decision D2 (the review's L2): TikTok's list never holds E05 of the
    main series, whose detail counts 5 and whose list also holds a trailer. Four episodes and the
    trailer make five items: whether TikTok's 5 counts the trailer nothing tells, so no number is
    named missing and no row is made — the filling asks once for the page after episode 4 — and
    the drama reads `may be incomplete`: its line says so with the numbers, its warnings show in
    the warning colour, the ⚠ alert says `TikTok's list may be incomplete` (no Retry), a report is
    saved with the numbers in its `listing` section, and there is no complete mark."""
    line = (
        "incomplete: 4 of 4 — TikTok's list may be incomplete: TikTok counts 5 episodes, 4 listed "
        "and 1 other item (a trailer or a highlight)"
    )
    warnings = [
        "TikTok listed 1 item DramaFetch could not read (another drama's id)",
        "TikTok listed 1 item DramaFetch could not read (no episode number)",
        "TikTok announces 5 episodes, 4 listed",
        uncertain_text(5, 4, 1),
    ]
    with (
        FakeTikTok(omit_always=frozenset({(SERIES_ID, 5)})) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        entry = ext.paste_and_wait(MAIN_LINK)
        (series,) = entry["series"]
        assert (series["status"], series["line"]) == ("incomplete", line)
        assert series["warnings"] == warnings
        assert _statuses(series) == [(n, "done") for n in range(1, 5)]  # no row for E05
        assert _asked(server) == [*MAIN_LISTING, ("4", "30")]  # the filling: the page after 4
        assert [len(_media_of(server, MAIN_ITEMS[n])) for n in range(1, 6)] == [1, 1, 1, 1, 0]
        assert len(ext.journal()) == 1  # no row, so no automatic retry

        # the page: the line, the warnings in the warning colour, no row under Did not download —
        # 3.0.1 (the lead's D9, changed on purpose: the block was hidden): its report is said
        # there, `Report saved: …`, and Save the report saves it again
        assert _report_lines(page) == [("incomplete", f"{SERIES_NAME}: {line}")]
        assert _warning_rows(page) == [("series-warning warn", text) for text in warnings]
        _report_only(ext, SERIES_NAME)

        # the ⚠ alert: the list may be incomplete, the line its message, no Retry
        (alert,) = recorded_alerts(ext, 1)
        options = alert["options"]
        assert (options["title"], options["message"]) == (
            f"⚠ {SERIES_NAME} — TikTok's list may be incomplete",
            line,
        )
        assert not options.get("buttons")

        # the report: saved, the numbers in its listing section
        (reported,) = _reports_by_kind(ext, 1)["batch"]["series"]
        listing = reported["listing"]
        assert (
            listing["tiktok_count"],
            listing["items_received"],
            listing["other_items"],
            listing["uncertain"],
            listing["missing_numbers"],
            listing["incomplete"],
            listing["fill_requests"],
        ) == (5, 5, 1, True, [], True, 1)
        assert [(p["kind"], p["cursor_asked"], p["numbers"]) for p in listing["pages"]] == [
            ("first", "0", [1, 2, 3]),
            ("next", "3", [2, 4]),  # E02 again (the fixture's repeat), E04 — no E05
            ("fill", "4", []),
        ]
        assert reported["not_downloaded"] == []
        state = ext.series_state(SERIES_ID)
        assert state is not None and state["complete_at"] is None
        # Save the report: the same report once more (` (1)` after its name)
        page.click("#report-button")
        ext.wait_for(lambda: len(_report_files(ext)) == 2, 20, "Save the report saved nothing")


def test_k_a_page_with_more_and_no_cursor_ends_the_pagination_early_and_the_filling_asks_on(
    tmp_path: Path,
) -> None:
    """(k) 3.0.1, the lead's decision D6 (the review's T1): TikTok answers the first page with
    `hasMore` and no cursor at all (`no_cursor_pages`). The pagination cannot ask for the next page
    — an early end, its fallback said — and the gap filling asks for the page that should hold
    E04 (`cursor` 3), which brings the rest: every episode the session may play downloads, ✓."""
    with (
        FakeTikTok(no_cursor_pages=frozenset({(SERIES_ID, "0")})) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        entry = ext.paste_and_wait(MAIN_LINK)
        (series,) = entry["series"]
        assert (series["status"], series["line"]) == ("complete", MAIN_COMPLETE)
        assert series["warnings"] == [NO_CURSOR_WARNING, *MAIN_WARNINGS]
        assert _statuses(series) == [*((n, "done") for n in range(1, 5)), (5, "skipped-locked")]
        # the page's own, its replay (no cursor: no next page), the filling's request for E04
        assert _asked(server) == [("0", "10"), ("0", "10"), ("3", "30")]
        state = ext.series_state(SERIES_ID)
        assert state is not None and state["complete_rule"] == 2


def test_l_a_page_that_repeats_the_first_one_ends_the_pagination_early_and_is_said(
    tmp_path: Path,
) -> None:
    """(l) 3.0.1, the lead's decision D6 (the review's T1): TikTok answers the second page with
    the first one again (`repeat_pages`) — a repeat says nothing new: an early end, its fallback
    said. The gap filling asks once for the page that should hold E04 (`cursor` 3) and gets the
    repeat again: E04 is certainly missing (TikTok counts 5, three episodes and the trailer came)
    — its row, in the line `TikTok's list ended early` —, E05 may be the trailer TikTok counts:
    the list may be incomplete; no complete mark."""
    early = (
        "incomplete: 3 of 4 — TikTok's list ended early: episode 4 not received; TikTok's list may "
        "be incomplete: TikTok counts 5 episodes, 3 listed and 1 other item (a trailer or a "
        "highlight)"
    )
    with (
        FakeTikTok(repeat_pages=frozenset({(SERIES_ID, "3")})) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        jobs = ext.finished_jobs()
        ext.paste(MAIN_LINK)
        _until_jobs(ext, jobs + 2, 120, "the paste and its automatic retry did not end")
        automatic, pasted = ext.journal()
        (series,) = pasted["series"]
        assert (series["status"], series["line"]) == ("incomplete", early)
        assert series["warnings"][0] == NOTHING_NEW_WARNING
        assert _statuses(series) == [
            (1, "done"),
            (2, "done"),
            (3, "done"),
            (4, "failed-unavailable"),
        ]
        assert _rows(series)[4]["message"] == "not in TikTok's list: it ended early"
        # each listing: the page's own, its replay, the repeated next page, the filling's request
        assert _asked(server) == [("0", "10"), ("0", "10"), ("3", "30"), ("3", "30")] * 2
        assert automatic["label"] == f"Automatic retry: 1 of {SERIES_NAME}"
        state = ext.series_state(SERIES_ID)
        assert state is not None and state["complete_at"] is None


def test_m_an_episode_listed_without_its_number_is_downloaded_under_its_own_number(
    tmp_path: Path,
) -> None:
    """(m) 4.0.2, the owner's report of 2026-11-27 (a drama of 56 whose list read `episode 53
    missing (gap)` and `TikTok listed 1 item DramaFetch could not read (no episode number)`): the
    main series' E04 comes without its number in every answer (`unnumbered`). E04 is a hole until
    the gap filling asks for its page again (`cursor` 3) and the answer brings the same item; then
    its place numbers it — right before E05, after E03 on the page before (page 2 begins with E02
    again) —: E04 is downloaded under its own name, from its own media, the drama complete and
    marked so, no row, no report, the ✓ alert, and one line more under the drama's header, muted,
    saying how E04 was numbered."""
    with (
        FakeTikTok(unnumbered=frozenset({(SERIES_ID, 4)})) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        entry = ext.paste_and_wait(MAIN_LINK)
        (series,) = entry["series"]
        placed = f"episode 4 {PLACED_TEXT} (between episodes 3 and 5)"
        assert series["warnings"] == [placed, *MAIN_WARNINGS]
        assert (series["status"], series["line"]) == ("complete", MAIN_COMPLETE)
        assert _statuses(series) == [(n, "done") for n in range(1, 5)] + [(5, "skipped-locked")]
        assert _asked(server) == MAIN_FILLED  # the filling asked for E04 again: the same item
        assert [len(_media_of(server, MAIN_ITEMS[n])) for n in range(1, 6)] == [1, 1, 1, 1, 0]
        assert _videos(ext) == _episodes(MAIN_FOLDER, SERIES_NAME, range(1, 5))
        assert _warning_rows(page) == [("series-warning", text) for text in series["warnings"]]
        assert _report_lines(page) == [("complete", f"{SERIES_NAME}: {MAIN_COMPLETE}")]
        assert page.locator("#failed-block").is_hidden()
        assert _report_files(ext) == []
        state = ext.series_state(SERIES_ID)
        assert state is not None
        assert (state["complete_episodes"], state["complete_rule"]) == (4, 2)
        (alert,) = recorded_alerts(ext, 1)
        assert (alert["options"]["title"], alert["options"]["message"]) == (
            f"✓ {SERIES_NAME} — downloaded",
            "All 4 episodes are on disk — 1 locked (5).",
        )


def test_n_a_trailer_in_the_place_of_an_episode_tiktok_never_lists_never_takes_its_number(
    tmp_path: Path,
) -> None:
    """(n) 4.0.2, the review's case: TikTok's list never holds the main series' E03, and the
    drama's trailer — no number, no play address — sits right after E02, in E03's place (the fake
    serves every item as long as the others: its 3 s). The gap filling asks for E03 again and gets
    none; the trailer, which carries no play address, is never taken for E03: nothing is numbered
    by its place, E03 stays missing from the list (its own row, `episode 3 missing (gap)`), and the
    trailer stays an item DramaFetch could not read."""
    with (
        FakeTikTok(omit_always=frozenset({(SERIES_ID, 3)})) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        ext.turn_off_auto_retry()  # the paste's own job alone (test_b covers the retry)
        entry = ext.paste_and_wait(MAIN_LINK)
        (series,) = entry["series"]
        assert not any(PLACED_TEXT in text for text in series["warnings"])
        assert "episode 3 missing (gap)" in series["warnings"]
        assert (
            "TikTok listed 1 item DramaFetch could not read (no episode number)"
            in (series["warnings"])
        )
        assert series["status"] == "incomplete"
        statuses = dict(_statuses(series))
        assert statuses[3] == "failed-unavailable" and _rows(series)[3]["message"].startswith(
            "not in TikTok's list"
        )
        assert [statuses[n] for n in (1, 2, 4)] == ["done"] * 3
        assert not _media_of(server, "7699400000000000099")  # the trailer: never asked for
        assert _videos(ext) == _episodes(MAIN_FOLDER, SERIES_NAME, (1, 2, 4))
