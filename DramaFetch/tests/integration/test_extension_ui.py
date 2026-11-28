"""The DramaFetch tab's UI, end to end (`pytest -m integration`; skipped without a browser).

A real headless Chromium loads the extension's TEST copy (`extension_harness.ExtensionHarness`)
against the fake TikTok server:

- the list's thumbnails go out only for the rows in view — counted in the fake's log — one at a
  time (the app page's own Resource Timing: no two of its requests overlap), and none while a job
  runs;
- the DramaFetch tab is never discardable while a job runs or waits, and is again once nothing
  does (after the queue, after a Stop) — `chrome.tabs` of the app page itself —, and meanwhile a
  paste over a refused paste's wrong line keeps the rest of the box, which Enter later downloads
  (1.7.0); every request of the app page's own — the videos and covers of those jobs — goes out
  one at a time (its Resource Timing: no two of them overlap); a second, read-only DramaFetch tab
  never queues the popup's request, and stays discardable;
- the popup offers **Download this series** on a TikTok drama page only — on any other page (no
  profile, no library kept) **Open DramaFetch** and its hint alone —, and with no DramaFetch tab
  open its **Download this series** on a TikTok series tab opens the DramaFetch tab, which
  downloads that series (DramaFetch 1.7.0: the batch job a paste of it queues — one listing, right
  before its downloads; no button pressed there) — read through `chrome.extension.getViews`, since
  Playwright never sees a tab the extension opens;
- a series handed to the worker (the popup's **Download this series**): the engine's tab takes it
  — the box left as it is — downloads it and answers, and no other tab opens; with no page taking
  it (a read-only tab left alone once the engine's tab is closed; a tab whose page is not running
  — restored but not loaded yet, discarded — is the same), the open tab reloads with the series in
  its address, takes the engine and downloads it (here the complete skip: no request);
- the user's TikTok favorites (the profile's **Favorites** → **Drama**): the worker keeps the
  page's own FIRST `drama_list` request — the page's later pages, loaded as the user asks for more,
  never replace it — (the popup then offers **Open my library**, and before it a hint), the List
  favorites job reads every page from inside that tab — the first page that request replayed byte
  for byte, the later ones the same request with only its `cursor`'s value changed, paced, one at a
  time — into the DramaFetch tab's library (hidden until then: one card per drama, each with its
  **Download**), whose search and **Select all shown** tick the dramas shown, with nothing
  downloaded and nothing asked of TikTok but the covers in view (DramaFetch 2.0.0 took the
  right-click items and their favorites card reader away: no menu, no content script);
- the Waiting card (2.0.0, the owner's request of 2026-11-22): two pastes — the second drama
  waits under its name (the library's) and its WHOLE id, which one click selects to copy —, a third
  that nothing names under its id and `name shown once its list is read`, no request made for a
  name; each drama leaves the card as its own list is read (h); with no library, in a reopened
  tab, the second drama's name is the one an earlier run stored in its records (h2);
- the countdown in minutes and seconds (2.0.0): a pause of 65 s between two episodes reads
  `Pausing 1 min 05 s before the next episode — 1 min 05 s left`, counts down every second and,
  below a minute, reads in seconds; the job keeps the engine's English text (i);
- with Chrome's UI in Spanish (`LANGUAGE=es`: how Chrome on Linux picks its UI language), every
  outcome the fake offers reads in Spanish on screen — no English template word outside the data
  (series and file names, hosts, the payload's `key=value` hints) — while the journal of finished
  jobs keeps the engine's English, byte for byte the Python tool's.

No cookie value is set, printed or asserted on here.
"""

from __future__ import annotations

import itertools
import re
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from dramafetch.models import DRM_MESSAGE, DRM_REMEMBERED_MESSAGE

from .extension_harness import CHROMIUM, EXTENSION_DIR, ExtensionHarness
from .fake_tiktok import (
    DRAMA_LIST_PATH,
    DRAMA_LIST_QUERY,
    FAVORITES,
    FAVORITES_CURSORS,
    LIGHTHOUSE_ID,
    PROFILE_PATH,
    SECOND_ITEMS,
    SECOND_SERIES_ID,
    SECOND_SERIES_NAME,
    SERIES_ID,
    SERIES_NAME,
    SNOWFALL_IDS,
    THIRD_SERIES_ID,
    THIRD_SERIES_NAME,
    FakeTikTok,
    RequestRecord,
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
SECOND_LINK = f"https://www.tiktok.com/shortdrama/episode/{SECOND_SERIES_ID}/2"
THIRD_LINK = THIRD_SERIES_ID
MAIN_ITEMS = {n: f"769940000000000000{n}" for n in range(1, 6)}
#: `COVER_MARGIN_PX` of `src/app/downloader.js`: how far outside the window a row already counts
#: as in view (read from the source, so the test follows the extension).
_MARGIN = re.search(
    r"export const COVER_MARGIN_PX = (\d+);",
    (EXTENSION_DIR / "src" / "app" / "downloader.js").read_text(encoding="utf-8"),
)
assert _MARGIN is not None, "COVER_MARGIN_PX is not in src/app/downloader.js"
COVER_MARGIN_PX = int(_MARGIN.group(1))
#: Rows this close to the edge of the watched area are neither asserted in nor out.
EDGE_PX = 4
#: The "did not download" report's file name (`Informe guardado: <Series> - did not download
#: 2026-11-06 1930.json`), ` (1)` and up when a minute saw several.
_REPORT_FILE_RE = re.compile(
    r"[^\n:]+ - did not download \d{4}-\d{2}-\d{2} \d{4}(?: \(\d+\))?\.json"
)
#: A width at which the page's layout no longer depends on the window (`main` is 980 px at most).
WIDE_PX = 1100
#: The English template words no Spanish text may keep outside its data.
ENGLISH_WORDS = (
    "downloaded",
    "locked",
    "episode",
    "complete",
    "pausing",
    "resting",
    "skipped",
    "failed",
    "stopped",
    "not started",
    "cooldown",
    "already",
    "unlocked",
    "looks again",
    "tries again",
    "--",
)
#: What the worker kept of a TikTok tab's favorites list (`chrome.storage.session`), or null.
TEMPLATE_JS = "async (key) => (await chrome.storage.session.get(key))[key] ?? null"
#: The tabs whose address starts with a prefix, as `chrome.tabs` sees them (an extension page asks).
TAB_IDS_JS = (
    "async (prefix) => (await chrome.tabs.query({}))"
    ".filter((tab) => (tab.url || tab.pendingUrl || '').startsWith(prefix)).map((tab) => tab.id)"
)
#: The favorites list's requests a page made, from its own Resource Timing: the page's own and the
#: ones the extension replayed from inside it (`chrome.scripting`, the page's own `fetch`).
DRAMA_LIST_TIMING_JS = """() => performance.getEntriesByType('resource')
  .filter((entry) => new URL(entry.name).pathname.endsWith('/drama_list/'))
  .map((entry) => ({query: new URL(entry.name).search, start: entry.startTime,
                    end: entry.responseEnd}))
  .sort((a, b) => a.start - b.start)"""
#: In the popup page: what it shows once its own start-up has read the active tab and the library
#: kept — it reads the test settings, then the active tab, then the library; the same three calls
#: made here after its own are answered after them, in order — as `{series, download, favorites,
#: favorites_hint, library, open}` (each element's `hidden`) and the text of its general hint (the
#: one `.hint` without an id: the favorites hint is another).
POPUP_SHOWN_JS = """async () => {
  await chrome.storage.local.get("testSettings");
  await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.storage.local.get("favoritesLibrary");
  const hidden = (id) => document.getElementById(id).hidden;
  return {
    series: hidden("popup-series"),
    download: hidden("popup-download"),
    favorites: hidden("popup-favorites"),
    favorites_hint: hidden("popup-favorites-hint"),
    library: hidden("popup-library"),
    open: hidden("popup-open"),
    hint: document.querySelector(".popup p.hint:not([id])").textContent,
  };
}"""

STATUSES = {
    "done",
    "skipped-exists",
    "skipped-locked",
    "failed-login-required",
    "failed-unavailable",
    "failed-rate-limited",
    "failed-blocked",
    "failed",
}


# ------------------------------------------------------------------------------- helpers


def _cover_cells(ext: ExtensionHarness) -> tuple[list[tuple[int, float, float]], float]:
    """Every row's cover cell as `(episode number, top, bottom)` in window coordinates, and the
    window's height."""
    found: dict[str, Any] = ext.page.evaluate(
        """() => ({
          height: innerHeight,
          cells: [...document.querySelectorAll('#episode-table tbody td.cover-cell')].map((td) => {
            const box = td.getBoundingClientRect();
            return [Number(td.parentElement.dataset.number), box.top, box.bottom];
          }),
        })"""
    )
    cells = [(int(n), float(top), float(bottom)) for n, top, bottom in found["cells"]]
    return cells, float(found["height"])


def _in_view(ext: ExtensionHarness) -> tuple[list[int], list[int]]:
    """The rows clearly inside the watched area (the window and `COVER_MARGIN_PX` above and
    below it) and the rows clearly outside it; rows on its very edge are in neither list."""
    cells, height = _cover_cells(ext)
    inside: list[int] = []
    outside: list[int] = []
    low, high = -COVER_MARGIN_PX, height + COVER_MARGIN_PX
    for number, top, bottom in cells:
        if top < high - EDGE_PX and bottom > low + EDGE_PX:
            inside.append(number)
        elif top > high + EDGE_PX or bottom < low - EDGE_PX:
            outside.append(number)
    return inside, outside


def _thumbnails(server: FakeTikTok, items: dict[int, str]) -> list[int]:
    """The episodes (by number) whose cover the extension itself asked for, in order."""
    numbers = {f"/cover/{item}.jpg": n for n, item in items.items()}
    return [numbers[r.path] for r in server.cover_requests if r.with_referer and r.path in numbers]


def _positions(server: FakeTikTok, wanted: Any) -> list[int]:
    """The positions in the fake's request log of the records `wanted(record)` picks."""
    return [index for index, record in enumerate(server.requests) if wanted(record)]


def _of_second_series(record: RequestRecord) -> bool:
    return (
        SECOND_SERIES_ID in record.path
        or record.query.get("dramaID") == SECOND_SERIES_ID
        or any(f"/{item}" in record.path for item in SECOND_ITEMS)
    )


def _own_fetches(ext: ExtensionHarness, base_url: str) -> list[dict[str, Any]]:
    """The app page's own requests to the fake server (its downloads and thumbnails: the discovery
    fetches from inside the TikTok tab, not from here), from its Resource Timing."""
    entries: list[dict[str, Any]] = ext.page.evaluate(
        """(base) => performance.getEntriesByType('resource')
          .filter((entry) => entry.name.startsWith(base))
          .map((entry) => ({name: new URL(entry.name).pathname, start: entry.startTime,
                            end: entry.responseEnd}))
          .sort((a, b) => a.start - b.start)""",
        base_url,
    )
    return entries


def _assert_one_at_a_time(entries: list[dict[str, Any]]) -> None:
    for earlier, later in itertools.pairwise(entries):
        assert later["start"] >= earlier["end"], f"{later['name']} overlapped {earlier['name']}"


def _auto_discardable(ext: ExtensionHarness) -> bool:
    """`autoDiscardable` of the DramaFetch tab, as `chrome.tabs` tells the app page itself."""
    return _discardable(ext.page)


def _discardable(page: Page) -> bool:
    """`autoDiscardable` of the tab of `page`, an extension page, as `chrome.tabs` tells it."""
    value = page.evaluate("async () => (await chrome.tabs.getCurrent()).autoDiscardable")
    assert isinstance(value, bool)
    return value


def _without_data(text: str) -> str:
    """`text` without its data: the series' names, file names, hosts, the payload's hints."""
    out = _REPORT_FILE_RE.sub(" ", text)  # first: the report's file name starts with a series' name
    for name in (SERIES_NAME, SECOND_SERIES_NAME, THIRD_SERIES_NAME):
        out = out.replace(name, " ")
    out = re.sub(r" - Episode \d+(?: \(\d+\))?\.mp4", " ", out)  # the default file names
    out = re.sub(r"\b\w+=\w+\b", " ", out)  # isLocked=True, unlockPrice=30, …
    return out.replace("127.0.0.1", " ")


def _assert_spanish(texts: list[str]) -> None:
    for text in texts:
        bare = _without_data(text).lower()
        left = [word for word in ENGLISH_WORDS if word in bare]
        assert not left, f"English {left} in {text!r}"


def _texts(ext: ExtensionHarness, selector: str) -> list[str]:
    """The visible text of every element `selector` matches."""
    return [text for text in ext.page.locator(selector).all_inner_texts() if text.strip()]


def _titles(ext: ExtensionHarness, selector: str) -> list[str]:
    """The tooltip (`title`) of every element inside `selector`: shown on hover, so text too."""
    titles: list[str] = ext.page.evaluate(
        "(selector) => [...document.querySelectorAll(`${selector} [title]`)]"
        ".map((element) => element.title).filter((title) => title.trim())",
        selector,
    )
    return titles


def _run(ext: ExtensionHarness, links: str, *, watch_pauses: bool = False) -> list[str]:
    """Paste `links` (a real paste: the download starts with no button), wait for the job; the
    pause texts seen meanwhile."""
    page = ext.page
    before = ext.finished_jobs()
    ext.paste(links)
    pauses: list[str] = []
    deadline = time.monotonic() + 90
    while not (ext.finished_jobs() > before and ext.idle()):
        assert time.monotonic() < deadline, "the job did not finish"
        if watch_pauses:
            pause = page.locator("#progress-pause")
            if pause.is_visible():
                text = pause.text_content() or ""
                if text and text not in pauses:
                    pauses.append(text)
        time.sleep(0.05)
    return pauses


def _engine_texts(ext: ExtensionHarness) -> list[str]:
    """Every engine text the page shows now: the result rows, the rows of the episodes the job did
    not download (with their heading, the retry and report buttons and the report's line), the
    report lines, the batch table, the status line, the cooldown banner."""
    texts = _texts(ext, "#result-table tbody tr")
    texts += _texts(ext, "#failed-table tbody tr")
    if ext.page.locator("#failed-block").is_visible():
        texts += _texts(ext, "#failed-heading") + _texts(ext, "#retry-button")
        texts += _texts(ext, "#report-button")
        if ext.page.locator("#failed-report").is_visible():
            texts += _texts(ext, "#failed-report")
    texts += _texts(ext, "#report-lines li")
    texts += _texts(ext, "#batch-table tbody tr")
    texts += _titles(ext, "#batch-table")  # its tooltips too (the badges' titles are status codes)
    texts += _texts(ext, "#input-status")
    if ext.page.locator("#cooldown-banner").is_visible():
        texts += _texts(ext, "#cooldown-banner")
    return texts


def _badges(ext: ExtensionHarness) -> dict[int, tuple[str, str, str]]:
    """The result rows by episode number — the result table's and the failed block's, where the
    episodes a job did not download go: `(label, the code in its title, message)`; the rows of the
    last series win."""
    rows: list[list[str]] = ext.page.evaluate(
        """() => [...document.querySelectorAll(
          '#result-table tbody tr[data-number], #failed-table tbody tr[data-number]')].map((r) => [
          r.dataset.number, r.querySelector('.badge').textContent,
          r.querySelector('.badge').title, r.querySelector('td.message').textContent])"""
    )
    return {int(n): (label, code, message) for n, label, code, message in rows}


# ------------------------------------------------------------------------------ scenarios


def test_thumbnails_only_for_rows_in_view_one_at_a_time_and_never_during_a_job(
    tmp_path: Path,
) -> None:
    """**See episodes** in a window that shows only some rows asks for those rows' thumbnails
    only; a job started next gets every request to itself — the rows scrolled into view meanwhile
    wait — and once it is over the rest come, one at a time."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        ext.keep_library((SERIES_ID, SERIES_NAME, 5))  # its card's See episodes lists it
        page = ext.page
        page.set_viewport_size({"width": WIDE_PX, "height": 800})
        page.evaluate("() => window.scrollTo(0, 0)")
        ext.see_episodes(SERIES_ID)
        # the list below the library: its first row at the window's bottom, the rest below it
        page.evaluate(
            "() => document.querySelector('#episode-table tbody tr').scrollIntoView({block: 'end'})"
        )
        table = page.locator("#episode-table tbody")
        inside, outside = _in_view(ext)
        assert inside and outside, f"the window shows every row or none: {_cover_cells(ext)}"
        ext.wait_for(
            lambda: table.locator("img.cover").count() >= len(inside), 20, "no thumbnail shown"
        )
        time.sleep(1.0)  # nothing more goes out: the other rows are out of view
        asked = _thumbnails(server, MAIN_ITEMS)
        assert set(inside) <= set(asked), (inside, asked)
        assert not set(outside) & set(asked), (outside, asked)
        assert len(asked) == len(set(asked)) == table.locator("img.cover").count()
        assert table.locator("span.cover.placeholder").count() == 5 - len(asked)

        # a job: the list's rows scrolled into view meanwhile wait for its end
        jobs = ext.finished_jobs()
        ext.paste(SECOND_LINK)
        page.evaluate(
            "() => document.querySelector('#episode-table tbody tr:last-child')"
            ".scrollIntoView({block: 'end'})"
        )
        assert not ext.idle()  # scrolled while the job runs
        ext.wait_for(lambda: ext.finished_jobs() > jobs and ext.idle(), 60, "no job end")
        ext.wait_for(lambda: table.locator("img.cover").count() == 5, 20, "the rest not shown")
        assert sorted(_thumbnails(server, MAIN_ITEMS)) == [1, 2, 3, 4, 5]  # each asked once
        job_end = max(_positions(server, _of_second_series))
        later = _positions(
            server,
            lambda r: (
                r.path in {f"/cover/{MAIN_ITEMS[n]}.jpg" for n in range(1, 6) if n not in asked}
            ),
        )
        assert later and min(later) > job_end, "a thumbnail went out while the job ran"
        own = _own_fetches(ext, server.base_url)
        assert len([e for e in own if e["name"].startswith("/cover/76994")]) >= 5
        _assert_one_at_a_time(own)  # thumbnails, videos and covers: never two at once


def test_the_app_tab_is_never_discarded_while_a_job_runs_or_waits(tmp_path: Path) -> None:
    """`autoDiscardable` is false from the moment a job is queued until the queue is empty and
    nothing runs — a second job waiting included — and true again after it, also after a Stop.
    Meanwhile a paste into a box that holds text loses none of it (1.7.0): a refused paste lands,
    the right link pasted over its wrong line — Chrome's own selection — is taken (here a series
    already waiting: nothing queued twice), that line gone, the rest kept and said; Enter later
    downloads what the box kept — Ctrl+Z gives it back, Ctrl+Shift+Z empties it again —, and
    Enter in the emptied box changes nothing. Every request the app page made itself through
    those jobs — their videos and covers — went out one at a time (its Resource Timing)."""
    settings = {"delayMinS": 1, "delayMaxS": 1}  # a pause between episodes to look during
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=settings) as ext,
    ):
        page = ext.page
        status = page.locator("#input-status")
        assert _auto_discardable(ext) is True  # idle: Chrome's default
        jobs = ext.finished_jobs()
        ext.paste(MAIN_LINK)
        ext.paste(SECOND_LINK)  # queued behind the first
        ext.wait_for(lambda: page.locator("#queue-card").is_visible(), 10, "nothing queued")
        assert _auto_discardable(ext) is False  # one runs, one waits

        refused = f"{THIRD_LINK}\nhttps://www.tiktok.com/@invented_viewer/video/7699400000000000001"
        ext.paste(refused)  # a single video on line 2: nothing queued, the paste lands
        ext.wait_for(lambda: page.input_value("#links") == refused, 10, "the paste did not land")
        assert (status.text_content() or "").startswith("line 2: ")
        page.evaluate(
            """() => {
              const box = document.getElementById("links");
              box.focus();
              box.setSelectionRange(box.value.indexOf("\\n") + 1, box.value.length);
            }"""
        )
        ext.paste(SECOND_LINK)  # pasted over line 2: taken — that series waits already
        ext.wait_for(lambda: page.input_value("#links") == f"{THIRD_LINK}\n", 10, "box not kept")
        assert status.text_content() == (
            "Already being downloaded, or waiting to be — not queued twice: "
            f"{SECOND_SERIES_ID}. · What the box held before stays there: press Enter to "
            "download it."
        )

        ext.wait_for(lambda: ext.finished_jobs() == jobs + 1, 60, "the first job did not end")
        assert _auto_discardable(ext) is False  # the second runs now
        ext.wait_for(lambda: ext.finished_jobs() == jobs + 2 and ext.idle(), 60, "no end")
        ext.wait_for(lambda: _auto_discardable(ext) is True, 5, "still not discardable")

        assert page.input_value("#links") == f"{THIRD_LINK}\n"  # still there
        page.focus("#links")
        page.keyboard.press("Enter")  # what the box kept: the third series
        ext.wait_for(lambda: page.input_value("#links") == "", 10, "Enter did not take the box")
        queued = f"Series {THIRD_SERIES_ID} queued: it downloads whole, with the usual pauses."
        assert status.text_content() == queued
        page.keyboard.press("Enter")  # an empty box: nothing — no new line, the line unchanged
        assert page.input_value("#links") == "" and status.text_content() == queued
        # Enter emptied the box with an edit of Chrome's own: Ctrl+Z gives the text back, exactly
        # (nothing queued by it), and Ctrl+Shift+Z empties it again
        page.keyboard.press("ControlOrMeta+Z")
        ext.wait_for(
            lambda: page.input_value("#links") == f"{THIRD_LINK}\n", 10, "Ctrl+Z did not undo"
        )
        page.keyboard.press("ControlOrMeta+Shift+Z")
        ext.wait_for(lambda: page.input_value("#links") == "", 10, "Ctrl+Shift+Z did not redo")
        ext.wait_for(lambda: page.locator("#progress-pause").is_visible(), 30, "no pause")
        assert _auto_discardable(ext) is False
        page.click("#stop-button")
        ext.wait_for(lambda: ext.finished_jobs() == jobs + 3 and ext.idle(), 30, "not stopped")
        assert ext.journal()[0]["stopped"] == "stopped by you"  # stored in English
        ext.wait_for(lambda: _auto_discardable(ext) is True, 5, "not discardable after a Stop")
        assert server.media_requests  # the jobs really ran
        # the app page's own requests, the three jobs' videos and covers: never two at once
        own = _own_fetches(ext, server.base_url)
        assert len([entry for entry in own if entry["name"].startswith("/cdn/")]) >= 4 + 3
        assert len([entry for entry in own if entry["name"].startswith("/cover/")]) >= 4 + 3
        _assert_one_at_a_time(own)


def test_a_read_only_dramafetch_tab_queues_nothing_and_stays_discardable(tmp_path: Path) -> None:
    """A second DramaFetch tab is read-only — the first one holds the engine. The popup's
    **Download this series** reaches every DramaFetch tab: the engine's downloads the series, the
    read-only one queues nothing, and neither stays undiscardable once the download is over."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        second = ext.context.new_page()
        second.goto(ext.app_url)
        ext.wait_for(lambda: second.locator("#duplicate-banner").is_visible(), 10, "no banner")
        assert _discardable(second) is True
        popup = ext.context.new_page()
        popup.goto(f"chrome-extension://{ext.extension_id}/src/app/popup.html")
        jobs = ext.finished_jobs()
        popup.evaluate(
            "(id) => chrome.runtime.sendMessage({type: 'dramafetch:open', load: id})", SERIES_ID
        )
        ext.wait_for(lambda: ext.finished_jobs() > jobs and ext.idle(), 60, "nothing downloaded")
        entry = ext.journal()[0]  # the engine downloaded it
        assert (entry["kind"], entry["label"]) == ("batch", f"Series {SERIES_ID}")
        assert entry["series"][0]["line"] == "complete: 4 of 5 (4 downloaded) — 1 locked (5)"
        assert second.locator("#queue-list li").count() == 0
        assert second.locator("#queue-card").is_hidden()
        assert second.locator("#app-status").get_attribute("data-finished") == "0"
        assert _discardable(second) is True
        ext.wait_for(lambda: _auto_discardable(ext) is True, 5, "the engine's tab stayed pinned")


def test_the_popup_opens_the_dramafetch_tab_with_the_series_downloading_when_none_is_open(
    tmp_path: Path,
) -> None:
    """On a TikTok page that is no drama's (nor a profile, no library kept), the popup shows **Open
    DramaFetch** and its hint alone — no series, no **Download this series**, no **Open my
    library**, no favorites hint. No DramaFetch tab open — a first click: on a TikTok series tab,
    the popup's **Download this series** opens the DramaFetch tab (`app.html?load=<series id>`),
    which takes the engine and downloads that series — the batch job a paste of it queues, no
    button pressed there: ONE listing, in a tab of its own that it closes again, right before the
    downloads."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        pages = f"chrome-extension://{ext.extension_id}/src/app"
        series_tab = f"{server.base_url}/shortdrama/episode/{SERIES_ID}/3"
        other_tab = f"{server.base_url}/login"  # a TikTok page that is no drama's
        tiktok = ext.context.new_page()
        tiktok.goto(other_tab)
        popup = ext.context.new_page()
        popup.goto(f"{pages}/popup.html")
        ext.page.close()  # the harness's DramaFetch tab (the test settings are stored already)

        def active_tabs() -> list[str]:
            urls: list[str] = popup.evaluate(
                "async () => (await chrome.tabs.query({active: true, currentWindow: true}))"
                ".map((tab) => tab.url || '')"
            )
            return urls

        tiktok.bring_to_front()  # the popup reads the active tab of its window
        ext.wait_for(lambda: active_tabs() == [other_tab], 10, "the TikTok tab is not active")
        popup.reload()
        assert popup.evaluate(POPUP_SHOWN_JS) == {
            "series": True,
            "download": True,
            "favorites": True,
            "favorites_hint": True,
            "library": True,
            "open": False,
            "hint": (
                "Open a TikTok short drama to download its whole series, or paste links in the "
                "DramaFetch tab."
            ),
        }
        tiktok.goto(series_tab)
        # the user's own tab has listed its episodes: its requests are over before the count
        ext.wait_for(lambda: tiktok.locator("#detail a.ep").count() > 0, 20, "no TikTok page")
        tiktok.bring_to_front()  # the popup reads the active tab of its window: the series tab
        ext.wait_for(lambda: active_tabs() == [series_tab], 10, "the series tab is not active")
        popup.reload()
        download = popup.locator("#popup-download")
        ext.wait_for(download.is_visible, 10, "no Download this series on a series tab")
        assert popup.locator("#popup-series").text_content() == f"Series {SERIES_ID}"
        listed = len(server.series_page_requests)
        lists = len(server.item_list_requests)
        media = len(server.media_requests)
        download.click()

        # Playwright never sees the tabs the extension opens: an extension page reads that one
        watcher = ext.context.new_page()
        watcher.goto(f"{pages}/popup.html")

        def app_tabs() -> list[dict[str, Any]]:
            views: list[dict[str, Any]] = watcher.evaluate(
                """() => chrome.extension.getViews({type: 'tab'})
                  .filter((view) => view.location.pathname.endsWith('/app.html'))
                  .map((view) => {
                    const doc = view.document;
                    const status = doc.querySelector('#app-status');
                    return {
                      search: view.location.search,
                      state: status.dataset.state,
                      finished: Number(status.dataset.finished || 0),
                      engine: doc.querySelector('#duplicate-banner').hidden,
                      links: doc.querySelector('#links').value,
                      rows: [...doc.querySelectorAll('#episode-table tbody tr')]
                        .map((row) => Number(row.dataset.number)),
                    };
                  })"""
            )
            return views

        ext.wait_for(
            lambda: [(tab["state"], tab["finished"]) for tab in app_tabs()] == [("idle", 1)],
            90,
            "the DramaFetch tab did not download the series",
        )
        (app,) = app_tabs()
        assert popup.is_closed()  # the popup closed itself once the tab was asked for
        assert app["engine"] is True  # it holds the engine: no "already open" banner
        assert app["links"] == ""  # the box left as it was: the hand-over is no paste of its own
        assert app["search"] == ""  # `?load=` consumed: reloading the tab downloads nothing again
        assert app["rows"] == []  # no episode list: nothing to pick, the whole series downloaded
        # that tab's journal of finished jobs (test mode: in its memory), read through getViews
        journals: list[list[dict[str, Any]]] = watcher.evaluate(
            """() => chrome.extension.getViews({type: 'tab'})
              .filter((view) => view.location.pathname.endsWith('/app.html'))
              .map((view) => view.dramafetchJournal ?? [])"""
        )
        (journal,) = journals
        assert [(entry["kind"], entry["label"]) for entry in journal] == [
            ("batch", f"Series {SERIES_ID}")
        ]
        (series,) = journal[0]["series"]
        assert (series["series_id"], series["name"], series["error"]) == (
            SERIES_ID,
            SERIES_NAME,
            None,
        )
        assert series["line"] == "complete: 4 of 5 (4 downloaded) — 1 locked (5)"
        # ONE listing — the series page in a tab of its own, its first list page repeated, the
        # second page —, then the four episodes the session may play
        assert len(server.series_page_requests) == listed + 1
        assert len(server.item_list_requests) == lists + 3
        assert len(server.media_requests) == media + 4
        assert len([path for path in ext.saved_files() if path.suffix == ".mp4"]) == 4
        tabs: list[str] = watcher.evaluate(
            "async () => (await chrome.tabs.query({}))"
            ".map((tab) => tab.url || tab.pendingUrl || '')"
        )
        assert [url for url in tabs if url.endswith("/app.html")] == [f"{pages}/app.html"]
        # the listing's own TikTok tab is closed again: only the user's tab is left
        assert [url for url in tabs if url.startswith(server.base_url)] == [series_tab]


def test_a_series_handed_over_reaches_the_engines_tab_or_reloads_a_tab_nobody_runs(
    tmp_path: Path,
) -> None:
    """What the popup's **Download this series** sends (`dramafetch:open`): the worker hands the
    series to the engine's tab, which takes it — the box left as it is, what was typed there
    stays — downloads it (the batch job a paste of it queues) and answers; no other tab opens.
    With no page taking it — here a read-only tab left alone once the engine's tab is closed (a tab
    whose page is not running, restored by Chrome after a restart but not loaded yet or discarded,
    takes nothing either) — the open tab reloads with the series in its address
    (`app.html?load=`), takes the engine and downloads it: the series on disk by then, the complete
    skip — no request."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        sender = ext.context.new_page()  # an extension page sends what the popup sends
        sender.goto(f"chrome-extension://{ext.extension_id}/src/app/popup.html")
        open_js = "(load) => chrome.runtime.sendMessage({type: 'dramafetch:open', load})"
        app_tabs_js = (
            "async (url) => (await chrome.tabs.query({}))"
            ".filter((tab) => (tab.url || tab.pendingUrl || '').startsWith(url)).length"
        )
        typed = "https://www.tiktok.com/shortdrama/episode/7699393770256782300/1"
        ext.page.fill("#links", typed)
        jobs = ext.finished_jobs()
        assert sender.evaluate(open_js, SERIES_ID) == {"ok": True}
        ext.wait_for(lambda: ext.finished_jobs() > jobs and ext.idle(), 90, "nothing downloaded")
        assert ext.page.input_value("#links") == typed  # the box as the user left it
        entry = ext.journal()[0]
        assert (entry["kind"], entry["label"]) == ("batch", f"Series {SERIES_ID}")
        assert entry["series"][0]["line"] == "complete: 4 of 5 (4 downloaded) — 1 locked (5)"
        assert sender.evaluate(app_tabs_js, ext.app_url) == 1
        requests = len(server.requests)

        second = ext.context.new_page()
        second.goto(ext.app_url)
        ext.wait_for(lambda: second.locator("#duplicate-banner").is_visible(), 10, "no banner")
        ext.page.close()  # the engine's tab is gone: the read-only one, left alone, takes nothing
        assert sender.evaluate(open_js, SERIES_ID) == {"ok": True}

        def listed_there() -> bool:
            status = second.locator("#app-status")
            return (
                second.locator("#duplicate-banner").is_hidden()
                and status.get_attribute("data-state") == "idle"
                and status.get_attribute("data-finished") == "1"
            )

        ext.wait_for(listed_there, 60, "the read-only tab did not reload with the series")
        assert second.input_value("#links") == ""
        (again,) = ext.journal(second)  # the reloaded tab's journal: its own job alone
        assert (again["kind"], again["label"]) == ("batch", f"Series {SERIES_ID}")
        assert again["series"][0]["status"] == "skipped (complete)"
        assert sender.evaluate(app_tabs_js, ext.app_url) == 1
        assert len(server.requests) == requests  # on disk already: not one request
        assert len(server.media_requests) == 4


def test_the_favorites_list_is_observed_listed_paced_and_ticked(tmp_path: Path) -> None:
    """The profile's **Favorites** → **Drama**: before the page asked for the list the popup shows
    a hint; once it did, the worker has the list's FIRST page's URL (session storage, never local)
    — the page's own later pages, loaded with **More**, never replace it — and the popup offers
    **Open my library**. Its click lists every favorite in the DramaFetch tab's library — every
    page fetched from inside the profile's tab, the first one the page's own first request
    replayed byte for byte, the later ones that request with only `cursor` changed, one at a time,
    each after the list-page pause — and the library's search and **Select all shown** tick the
    dramas shown, every card with its own **Download** (1.7.0). Nothing is downloaded, no series
    listed."""
    settings = {"pageDelayS": 0.3}  # the list-page pause long enough to measure: 0.3 to 0.6 s
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=settings) as ext,
    ):
        profile = ext.context.new_page()
        profile.goto(f"{server.base_url}{PROFILE_PATH}")
        popup = ext.context.new_page()
        popup.goto(f"chrome-extension://{ext.extension_id}/src/app/popup.html")

        def active_tabs() -> list[str]:
            urls: list[str] = popup.evaluate(
                "async () => (await chrome.tabs.query({active: true, currentWindow: true}))"
                ".map((tab) => tab.url || '')"
            )
            return urls

        profile.bring_to_front()  # the popup reads the active tab of its window: the profile
        ext.wait_for(
            lambda: active_tabs() == [f"{server.base_url}{PROFILE_PATH}"], 10, "no active profile"
        )
        popup.reload()
        hint = popup.locator("#popup-favorites-hint")
        ext.wait_for(hint.is_visible, 10, "no hint on a profile whose favorites were not shown")
        assert popup.locator("#popup-favorites").is_hidden()
        assert popup.locator("#popup-download").is_hidden()

        # the user opens Favorites → Drama: the page's own request, which the worker observes
        profile.click("#tab-favorites")
        profile.click("#favorites-drama")
        ext.wait_for(lambda: profile.locator("#drama-grid button").count() == 3, 10, "no cards")
        tab_ids: list[int] = popup.evaluate(TAB_IDS_JS, f"{server.base_url}{PROFILE_PATH}")
        (tab_id,) = tab_ids
        key = f"favoritesTemplate:{tab_id}"
        ext.wait_for(lambda: popup.evaluate(TEMPLATE_JS, key) is not None, 10, "nothing kept")
        template = popup.evaluate(TEMPLATE_JS, key)
        assert template["url"].startswith(f"{server.base_url}{DRAMA_LIST_PATH}?")
        assert "cursor=0" in template["url"]
        # with whose list it reads: the handle of the profile page that asked for it
        assert template["profile"] == PROFILE_PATH.removeprefix("/")
        assert "drama_list" not in str(ext.storage())  # in the session's memory, never on disk
        # the user scrolls the grid for more: the page's own later pages, which the worker observes
        # too — they never replace the first page it keeps
        for cards in (6, len(FAVORITES)):
            profile.click("#more-dramas")
            ext.wait_for(
                lambda cards=cards: profile.locator("#drama-grid button").count() == cards,
                10,
                "no more cards",
            )
        assert [r.query["cursor"] for r in server.drama_list_requests] == list(FAVORITES_CURSORS)
        deadline = time.monotonic() + 1.5  # the later pages' completions reach the worker meanwhile
        while time.monotonic() < deadline:
            assert popup.evaluate(TEMPLATE_JS, key) == template, "a later page replaced the first"
            time.sleep(0.1)
        page_own = server.drama_list_requests[0].raw_query  # the page's own first request
        assert template["url"].split("?", 1)[1] == page_own
        popup.reload()
        choose = popup.locator("#popup-favorites")
        ext.wait_for(choose.is_visible, 10, "no Open my library")
        assert hint.is_hidden()
        own = len(server.drama_list_requests)
        assert own == len(FAVORITES_CURSORS)  # the page's own three pages
        assert ext.page.locator("#favorites-card").is_hidden()  # the library: hidden until listed
        jobs = ext.finished_jobs()
        choose.click()  # the popup's dramafetch:open with the tab: the engine's tab takes it
        ext.wait_for(lambda: ext.finished_jobs() > jobs and ext.idle(), 60, "nothing listed")

        page = ext.page
        assert page.locator("#favorites-card").is_visible()  # shown by the listing
        rows = page.locator("#favorites-grid article[data-series-id]")
        assert rows.count() == len(FAVORITES)
        titles = page.locator("#favorites-grid .favorite-title").all_inner_texts()
        assert titles == [title for _, title, _, _ in FAVORITES]  # the list's order
        ids = [rows.nth(n).get_attribute("data-series-id") for n in range(rows.count())]
        assert ids == [series_id for series_id, _, _, _ in FAVORITES]
        lighthouse = page.locator(f"#favorites-grid article[data-series-id='{LIGHTHOUSE_ID}']")
        assert lighthouse.locator(".favorite-meta").inner_text() == "60 episodes · 1h 19m"
        assert page.locator("#favorites-count").inner_text() == "8 favorite dramas listed."
        assert page.locator("#input-status").inner_text().startswith("8 favorite dramas listed")
        entry = ext.journal()[0]
        assert (entry["kind"], entry["favorites"], entry["error"]) == ("favorites", 8, None)
        assert "drama_list" not in str(entry)

        # every page from inside the profile's tab: the page's own first request replayed, then
        # `cursor` alone changed, from 0 to the last page
        ours = server.drama_list_requests[own:]
        assert [r.query["cursor"] for r in ours] == list(FAVORITES_CURSORS)
        for record in server.drama_list_requests:
            assert {k: v for k, v in record.query.items() if k != "cursor"} == DRAMA_LIST_QUERY
        # byte for byte: DramaFetch's first request IS the page's own first request; the later ones
        # its query with only the cursor's value changed — no parameter added, dropped, repeated,
        # reordered or re-encoded (`browser_version` is percent-encoded)
        assert "browser_version=5.0%20%28Windows%29" in page_own
        assert ours[0].raw_query == page_own
        for record in ours:
            cursor = record.query["cursor"]
            assert record.raw_query == page_own.replace("cursor=0", f"cursor={cursor}")
        # one at a time, each after its pause (the profile page's own Resource Timing)
        timing: list[dict[str, Any]] = profile.evaluate(DRAMA_LIST_TIMING_JS)
        replayed = timing[own:]
        assert len(replayed) == len(FAVORITES_CURSORS)
        for earlier, later in itertools.pairwise(replayed):
            assert later["start"] - earlier["end"] >= 280, (earlier, later)  # 0.3 s at least

        # every card has its own Download; the search and Select all shown tick the shown ones
        assert page.locator("#favorites-grid [data-action='download']").count() == len(FAVORITES)
        before = len(server.requests)
        page.fill("#favorites-filter", "SNOWFALL")
        shown = [rows.nth(n).get_attribute("data-series-id") for n in range(rows.count())]
        assert shown == list(SNOWFALL_IDS)  # only the dramas the search matches are drawn
        assert page.locator("#library-shown").inner_text() == "Showing 2 of 2"
        assert (
            page.locator("#library-total").inner_text() == f"TikTok counts {len(FAVORITES)} dramas"
        )
        page.check("#favorites-select-all")
        assert page.locator("#favorites-selection").inner_text() == "2 selected · 120 episodes"
        assert page.locator("#library-download").is_enabled()
        assert page.input_value("#links") == ""  # nothing goes into the box
        # the library asks nothing of TikTok but the covers of the cards in view (the fake's image
        # CDN, one at a time, never during a job): no list, no series, no media
        asked = [r.path for r in server.requests[before:]]
        favorite_covers = {f"/cover/{series_id}.jpg" for series_id, _, _, _ in FAVORITES}
        assert set(asked) <= favorite_covers, asked
        assert ext.idle()
        assert not server.item_list_requests and not server.media_requests
        assert ext.saved_files() == []
        # the search narrows what is shown, never the library: emptied, every drama is back, the
        # two ticked still ticked
        page.fill("#favorites-filter", "")
        ext.wait_for(lambda: rows.count() == len(FAVORITES), 10, "the search did not clear")
        everything = len(FAVORITES)
        assert (
            page.locator("#library-shown").inner_text() == f"Showing {everything} of {everything}"
        )
        assert page.locator("#favorites-selection").inner_text() == "2 selected · 120 episodes"


def test_h_the_waiting_card_names_each_drama_still_to_run_by_its_name_and_whole_id(
    tmp_path: Path,
) -> None:
    """(h) Two pastes, a third behind them: while the first downloads, the Waiting card lists the
    second drama by the name the library holds (DramaFetch knows it without asking TikTok) and its
    WHOLE id — nineteen digits, never cut, one click selects it all —, then the third, which nothing
    names, by its id and `name shown once its list is read`; the first drama, whose list is read,
    is not there; no request names a drama that waits. **Stop**: the card goes."""
    settings = {"delayMinS": 1, "delayMaxS": 1}  # the first drama takes a few seconds
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=settings) as ext,
    ):
        ext.keep_library((SECOND_SERIES_ID, SECOND_SERIES_NAME, 3))
        page = ext.page
        rows = page.locator("#queue-list li")
        assert page.locator("#queue-card").is_hidden()  # nothing waits
        jobs = ext.finished_jobs()
        ext.paste(MAIN_LINK)
        ext.paste(SECOND_LINK)
        ext.paste(THIRD_LINK)
        second = f"{SECOND_SERIES_NAME} · {SECOND_SERIES_ID}"
        third = f"{THIRD_SERIES_ID} · name shown once its list is read"
        # the first drama's list read (its first episode asked for): it left the card
        ext.wait_for(lambda: bool(server.media_requests), 30, "the first drama did not start")
        ext.wait_for(lambda: rows.all_inner_texts() == [second, third], 10, "not the two waiting")
        assert page.locator("#queue-card").is_visible()
        first_row = rows.nth(0)
        assert first_row.get_attribute("data-kind") == "download"
        assert first_row.get_attribute("data-series-id") == SECOND_SERIES_ID
        assert first_row.locator(".queue-name").inner_text() == SECOND_SERIES_NAME
        whole = first_row.locator(".queue-id")
        assert whole.inner_text() == SECOND_SERIES_ID and len(SECOND_SERIES_ID) == 19
        # never cut: the id is drawn whole, on one line, inside its row
        assert whole.evaluate("(element) => getComputedStyle(element).whiteSpace") == "nowrap"
        assert whole.evaluate(
            """(element) => {
              const box = element.closest("li").getBoundingClientRect();
              const id = element.getBoundingClientRect();
              return element.getClientRects().length === 1 && id.left >= box.left
                && id.right <= box.right && id.width > 0;
            }"""
        )
        # one click selects it all, to copy
        whole.click()
        assert page.evaluate("() => getSelection().toString()") == SECOND_SERIES_ID
        note = rows.nth(1).locator(".queue-note")
        assert note.inner_text() == "name shown once its list is read"
        assert note.evaluate("(element) => getComputedStyle(element).fontStyle") == "italic"
        # no request was made to learn a name: nothing names the dramas that wait
        for record in server.requests:
            for waiting in (SECOND_SERIES_ID, THIRD_SERIES_ID):
                assert waiting not in record.path and waiting not in record.raw_query, record
        page.click("#stop-button")
        ext.wait_for(
            lambda: ext.finished_jobs() > jobs and ext.idle(), 30, "the Stop did not end the jobs"
        )
        ext.wait_for(lambda: page.locator("#queue-card").is_hidden(), 10, "the card stayed")
        by_label = {entry["label"]: entry for entry in ext.journal()}
        assert by_label[f"Series {SERIES_ID}"]["stopped"] == "stopped by you"
        not_started = f"not started: batch stopped in Series {SERIES_ID} (stopped by you)"
        for waiting in (SECOND_SERIES_ID, THIRD_SERIES_ID):
            assert by_label[f"Series {waiting}"]["error"] == not_started


def test_h2_the_waiting_card_names_a_drama_its_stored_records_name_and_its_whole_id(
    tmp_path: Path,
) -> None:
    """(h2) No library: the second drama downloaded once — DramaFetch's records of it keep its
    name —, then the DramaFetch tab reopened: a new page, which has read no list yet. Two pastes, a
    third behind them: while the first downloads, the Waiting card lists the second drama by the
    name its records hold (DramaFetch knows it without asking TikTok, as from the library's title
    in (h)) and its WHOLE id — nineteen digits, never cut, one click selects it all —, then the
    third, which nothing names, by its id and `name shown once its list is read`; the first drama,
    whose list is read, is not there; no request names a drama that waits. **Stop**: the card
    goes. (DramaFetch 4.0.0's (h).)"""
    settings = {"delayMinS": 1, "delayMaxS": 1}  # the first drama takes a few seconds
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=settings) as ext,
    ):
        earlier = ext.paste_and_wait(SECOND_LINK)
        assert earlier["series"][0]["name"] == SECOND_SERIES_NAME
        state = ext.series_state(SECOND_SERIES_ID)
        assert state is not None and state["series_name"] == SECOND_SERIES_NAME
        ext.page.close()
        page = ext.reopen_app()  # a new page: no list read in it, nothing learned of any name
        rows = page.locator("#queue-list li")
        assert page.locator("#queue-card").is_hidden()  # nothing waits
        start = len(server.requests)
        jobs = ext.finished_jobs()
        ext.paste(MAIN_LINK)
        ext.paste(SECOND_LINK)
        ext.paste(THIRD_LINK)
        second = f"{SECOND_SERIES_NAME} · {SECOND_SERIES_ID}"
        third = f"{THIRD_SERIES_ID} · name shown once its list is read"
        # the first drama's list read (its first episode asked for): it left the card
        ext.wait_for(lambda: bool(server.media_requests), 30, "the first drama did not start")
        ext.wait_for(lambda: rows.all_inner_texts() == [second, third], 10, "not the two waiting")
        assert page.locator("#queue-card").is_visible()
        first_row = rows.nth(0)
        assert first_row.get_attribute("data-kind") == "download"
        assert first_row.get_attribute("data-series-id") == SECOND_SERIES_ID
        assert first_row.locator(".queue-name").inner_text() == SECOND_SERIES_NAME
        whole = first_row.locator(".queue-id")
        assert whole.inner_text() == SECOND_SERIES_ID and len(SECOND_SERIES_ID) == 19
        # never cut: the id is drawn whole, on one line, inside its row
        assert whole.evaluate("(element) => getComputedStyle(element).whiteSpace") == "nowrap"
        assert whole.evaluate(
            """(element) => {
              const box = element.closest("li").getBoundingClientRect();
              const id = element.getBoundingClientRect();
              return element.getClientRects().length === 1 && id.left >= box.left
                && id.right <= box.right && id.width > 0;
            }"""
        )
        # one click selects it all, to copy
        whole.click()
        assert page.evaluate("() => getSelection().toString()") == SECOND_SERIES_ID
        note = rows.nth(1).locator(".queue-note")
        assert note.inner_text() == "name shown once its list is read"
        assert note.evaluate("(element) => getComputedStyle(element).fontStyle") == "italic"
        # no request was made to learn a name: nothing names the dramas that wait
        for record in server.requests[start:]:
            for waiting in (SECOND_SERIES_ID, THIRD_SERIES_ID):
                assert waiting not in record.path and waiting not in record.raw_query, record
        page.click("#stop-button")
        ext.wait_for(
            lambda: ext.finished_jobs() > jobs and ext.idle(), 30, "the Stop did not end the jobs"
        )
        ext.wait_for(lambda: page.locator("#queue-card").is_hidden(), 10, "the card stayed")
        by_label = {entry["label"]: entry for entry in ext.journal()}
        assert by_label[f"Series {SERIES_ID}"]["stopped"] == "stopped by you"
        not_started = f"not started: batch stopped in Series {SERIES_ID} (stopped by you)"
        for waiting in (SECOND_SERIES_ID, THIRD_SERIES_ID):
            assert by_label[f"Series {waiting}"]["error"] == not_started


def test_i_a_pause_of_a_minute_or_more_reads_in_minutes_and_seconds(tmp_path: Path) -> None:
    """(i) A pause of 65 s between two episodes (test pacing: longer than the default, never
    shorter): the progress card's pause line reads `Pausing 1 min 05 s before the next episode —
    1 min 05 s left`, counts down every second, and below a minute reads `… — 59 s left`; **Stop**
    ends it, and the job keeps the engine's own text, `pausing 65 s`, for its report."""
    settings = {"delayMinS": 65, "delayMaxS": 65}
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=settings) as ext,
    ):
        page = ext.page
        pause = page.locator("#progress-pause")
        jobs = ext.finished_jobs()
        ext.paste(MAIN_LINK)
        ext.wait_for(lambda: pause.is_visible(), 60, "no pause after the first episode")
        line = re.compile(
            r"Pausing 1 min 05 s before the next episode — (\d+ min \d{2} s|\d+ s) left"
        )
        first = line.fullmatch(pause.inner_text())
        assert first is not None, pause.inner_text()
        assert first.group(1) in ("1 min 05 s", "1 min 04 s"), first.group(1)
        # counted down every second, in minutes and seconds while a minute or more is left
        ext.wait_for(lambda: pause.inner_text().endswith("— 1 min 02 s left"), 10, "no countdown")
        # below a minute: seconds
        ext.wait_for(lambda: pause.inner_text().endswith("— 59 s left"), 15, "never below a minute")
        assert line.fullmatch(pause.inner_text())
        # the pause holds: the first episode asked for, never the second yet
        assert server.media_requests
        assert not [r for r in server.media_requests if r.path.startswith(f"/cdn/{MAIN_ITEMS[2]}/")]
        page.click("#stop-button")
        ext.wait_for(lambda: ext.finished_jobs() > jobs and ext.idle(), 30, "not stopped")
        assert pause.is_hidden()
        entry = ext.journal()[0]
        assert entry["stopped"] == "stopped by you"
        assert {"kind": "pace", "seconds": 65, "text": "pausing 65 s"} in entry["pauses"]


def test_the_spanish_ui_shows_every_outcome_in_spanish(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Chrome in Spanish: done, an episode found encrypted, a locked one with its lock hints in its
    row, the series rest, episodes already on disk, the remembered DRM verdict, the complete skip
    with its hint, the list's warnings and hints, a 429 with its stop, cooldown and not-started
    series, the episodes a job did not download shown apart with their retry button, the report of
    them saved (its line and button), the report setting — all on screen in Spanish, the status
    codes in the badges' titles; the texts the journal of finished jobs keeps stay English."""
    monkeypatch.setenv("LANGUAGE", "es")  # Chrome on Linux takes its UI language from it
    drm = frozenset({(SERIES_ID, 2)})
    settings = {"restMinS": 1.5, "restMaxS": 2}  # the series rest long enough to be read
    with (
        FakeTikTok(drm_media=drm) as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=settings) as ext,
    ):
        ext.keep_library((SERIES_ID, SERIES_NAME, 5))  # its card's See episodes lists it
        page = ext.page
        assert page.evaluate("() => document.documentElement.lang") == "es"
        assert page.locator("#app-status").text_content() == "en espera"
        seen: list[str] = []

        # a batch: E01, E03, E04 downloaded, E02 encrypted, E05 locked; the rest; the second series
        pauses = _run(ext, f"{MAIN_LINK}\n{SECOND_LINK}", watch_pauses=True)
        # the series rest, in Spanish, its length and the time left counted down (2.0.0)
        rest = re.compile(r"Descanso de \d+ s antes del siguiente drama — tiempo restante: \d+ s")
        assert any(rest.fullmatch(text) for text in pauses), pauses
        seen += pauses
        badges = _badges(ext)
        assert {code for _, code, _ in badges.values()} <= STATUSES
        texts = _engine_texts(ext)
        assert any("descargado" in text and "portada incrustada" in text for text in texts)
        assert any("protegido con DRM (pistas cifradas)" in text for text in texts)
        assert any(text.startswith(f"{SERIES_NAME}: incompleta: ") for text in texts)
        assert any(text.startswith(f"{SECOND_SERIES_NAME}: completa: 3 de 3") for text in texts)
        seen += texts
        # the encrypted episode is the one the job did not download: apart, under its heading,
        # with the retry button; the result table keeps the rest
        assert page.locator("#failed-heading").inner_text() == "No se descargaron (1)"
        assert page.locator("#retry-button").inner_text() == (
            "Reintentar los episodios que no se descargaron (1)"
        )
        assert badges[2][1] == "failed-unavailable"
        assert "protegido con DRM (pistas cifradas)" in badges[2][2]
        # the locked episode: skipped, its lock hints in Spanish (the payload's own words aside)
        assert badges[5][:2] == ("bloqueado, omitido", "skipped-locked")
        assert badges[5][2].startswith("parece bloqueado: ")
        assert "sin dirección de reproducción" in badges[5][2]
        failed_row = f"tbody tr[data-series-id='{SERIES_ID}'][data-number='2']"
        assert page.locator("#failed-table tbody tr").count() == 1
        assert page.locator(f"#failed-table {failed_row}").count() == 1
        assert (
            page.locator(f"#result-table {failed_row}").count() == 0
        )  # the second series' E02 stays
        # the report of it, saved at the job's end (the setting is on by default), in Spanish
        report_line = page.locator("#failed-report")
        ext.wait_for(report_line.is_visible, 10, "no report line")
        assert report_line.inner_text().startswith("Informe guardado: ")
        assert report_line.inner_text().endswith(".json")
        assert page.locator("#report-button").inner_text() == "Guardar el informe"
        assert page.locator("label[for=setting-report]").text_content() == (
            "Guardar un informe de los episodios que no se descargaron"
        )
        entry = ext.journal()[0]  # the journal keeps the engine's English
        main, _second = entry["series"]
        rows = {row["number"]: row for row in main["rows"]}
        assert rows[2]["message"] == DRM_MESSAGE
        assert main["line"].startswith("incomplete: ")

        # again: on disk, the DRM verdict remembered (its advice names the checkbox), locked;
        # the second series skipped as complete
        _run(ext, f"{MAIN_LINK}\n{SECOND_LINK}")
        texts = _engine_texts(ext)
        include_locked = page.locator("label:has(#include-locked) span").inner_text()
        assert any(f"marca “{include_locked}”" in text for text in texts), texts
        assert any("ya descargado (según el registro): " in text for text in texts)
        assert any("omitida (completa)" in text for text in texts)
        seen += texts
        main, _second = ext.journal()[0]["series"]
        assert {row["number"]: row for row in main["rows"]}[2]["message"] == DRM_REMEMBERED_MESSAGE

        # a third time: the complete skip with its hint, pointing at the recheck checkbox
        _run(ext, MAIN_LINK)
        recheck = page.locator("label:has(#recheck) span").inner_text()
        lines = _texts(ext, "#report-lines li")
        assert any(
            line.startswith(f"{SERIES_NAME}: completa, nada que hacer: ")
            and line.endswith(f"marca “{recheck}”")
            for line in lines
        ), lines
        assert ext.journal()[0]["series"][0]["line"].endswith("--recheck looks again")
        seen += _engine_texts(ext)

        # the list (See episodes): its warnings, the lock hints, the badges
        ext.see_episodes(SERIES_ID)
        warnings = _texts(ext, "#series-warnings li")
        assert "1 episodio parece bloqueado" in warnings
        hints = _texts(ext, "#episode-table .hints")
        # E2's remembered DRM verdict (TikTok's list calls it free) and E5's lock hints, in Spanish
        drm_hint, lock_hint = hints
        # what tries it again THERE: tick it and Download selected — never the box's checkbox
        selected = page.locator("#download-selected-button").inner_text()
        assert drm_hint == (
            "protegido con DRM (lo detectó una ejecución anterior): DramaFetch no lo descifra; "
            f"para intentarlo de nuevo, márcalo y pulsa “{selected}”"
        )
        assert include_locked not in drm_hint
        assert "sin dirección de reproducción" in lock_hint
        seen += warnings + hints + _texts(ext, "#series-meta") + _texts(ext, "#pacing-line")

        # a 429 from the video server: the stop, the rest stopped, the next series not started,
        # the cooldown banner
        with FakeTikTok(cdn_rate_limit=True) as limited:
            ext.save_test_settings({**ext.settings, "baseUrl": limited.base_url})
            _run(ext, f"{THIRD_LINK}\n{MAIN_LINK}")
            ext.wait_for(lambda: page.locator("#cooldown-banner").is_visible(), 10, "no banner")
            badges = _badges(ext)
            assert badges[1][:2] == ("limitado por TikTok", "failed-rate-limited")
            assert badges[2][:2] == ("detenido", "failed-rate-limited")
            assert badges[2][2].startswith("detenido: episodio 1 (limitado por TikTok): ")
            assert page.locator("#failed-heading").inner_text() == "No se descargaron (2)"
            texts = _engine_texts(ext)
            assert any("no iniciada" in text for text in texts)
            banner = page.locator("#cooldown-text").inner_text()
            assert banner.startswith("TikTok rechazó una solicitud a las ")
            # its countdown in minutes and seconds (2.0.0), ticking every second
            left = page.locator("#cooldown-left").inner_text()
            assert re.fullmatch(
                r"Tiempo restante: \d+ min \d{2} s — nada contacta a TikTok hasta entonces\.", left
            )
            seen.append(left)
            assert "la extensión no tiene forma de levantarla antes de tiempo" in banner
            seen += texts
            assert ext.cooldown() is not None
            assert len(limited.media_requests) == 1

        _assert_spanish(seen)
