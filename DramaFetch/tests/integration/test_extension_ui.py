"""The DramaFetch tab's UI, end to end (`pytest -m integration`; skipped without a browser).

A real headless Chromium loads the extension's TEST copy (`extension_harness.ExtensionHarness`)
against the fake TikTok server:

- the list's thumbnails go out only for the rows in view — counted in the fake's log — one at a
  time (the app page's own Resource Timing: no two of its requests overlap), and none while a job
  runs;
- the DramaFetch tab is never discardable while a job runs or waits, and is again once nothing
  does (after the queue, after a Stop) — `chrome.tabs` of the app page itself;
- with Chrome's UI in Spanish (`LANGUAGE=es`: how Chrome on Linux picks its UI language), every
  outcome the fake offers reads in Spanish on screen — no English template word outside the data
  (series and file names, hosts, the payload's `key=value` hints) — while the history keeps the
  engine's English, byte for byte the Python tool's.

No cookie value is set, printed or asserted on here.
"""

from __future__ import annotations

import itertools
import re
import time
from pathlib import Path
from typing import Any

import pytest

from dramafetch.models import DRM_MESSAGE, DRM_REMEMBERED_MESSAGE

from .extension_harness import CHROMIUM, EXTENSION_DIR, ExtensionHarness
from .fake_tiktok import (
    SECOND_ITEMS,
    SECOND_SERIES_ID,
    SECOND_SERIES_NAME,
    SERIES_ID,
    SERIES_NAME,
    THIRD_SERIES_ID,
    THIRD_SERIES_NAME,
    FakeTikTok,
    RequestRecord,
)

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
    value = ext.page.evaluate("async () => (await chrome.tabs.getCurrent()).autoDiscardable")
    assert isinstance(value, bool)
    return value


def _without_data(text: str) -> str:
    """`text` without its data: the series' names, file names, hosts, the payload's hints."""
    out = text
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


def _run(ext: ExtensionHarness, links: str, *, watch_pauses: bool = False) -> list[str]:
    """Paste `links`, press **Download all**, wait for the job; the pause texts seen meanwhile."""
    page = ext.page
    page.fill("#links", links)
    before = ext.finished_jobs()
    page.click("#download-all-button")
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
    """Every engine text the page shows now: the result rows, the report lines, the batch table,
    the status line, the cooldown banner."""
    texts = _texts(ext, "#result-table tbody tr")
    texts += _texts(ext, "#report-lines li")
    texts += _texts(ext, "#batch-table tbody tr")
    texts += _texts(ext, "#input-status")
    if ext.page.locator("#cooldown-banner").is_visible():
        texts += _texts(ext, "#cooldown-banner")
    return texts


def _badges(ext: ExtensionHarness) -> dict[int, tuple[str, str, str]]:
    """The result rows by episode number: `(label, the code in its title, message)`; the rows of
    the last series of the table win."""
    rows: list[list[str]] = ext.page.evaluate(
        """() => [...document.querySelectorAll('#result-table tbody tr[data-number]')].map((r) => [
          r.dataset.number, r.querySelector('.badge').textContent,
          r.querySelector('.badge').title, r.querySelector('td.message').textContent])"""
    )
    return {int(n): (label, code, message) for n, label, code, message in rows}


# ------------------------------------------------------------------------------ scenarios


def test_thumbnails_only_for_rows_in_view_one_at_a_time_and_never_during_a_job(
    tmp_path: Path,
) -> None:
    """**Load list** in a window that shows only some rows asks for those rows' thumbnails only;
    a job started next gets every request to itself — the rows scrolled into view meanwhile wait —
    and once it is over the rest come, one at a time."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        page = ext.page
        page.set_viewport_size({"width": WIDE_PX, "height": 800})
        page.evaluate("() => window.scrollTo(0, 0)")
        ext.load(MAIN_LINK)
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
        page.fill("#links", SECOND_LINK)
        jobs = ext.finished_jobs()
        page.click("#download-all-button")
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
    nothing runs — a second job waiting included — and true again after it, also after a Stop."""
    settings = {"delayMinS": 1, "delayMaxS": 1}  # a pause between episodes to look during
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=settings) as ext,
    ):
        page = ext.page
        assert _auto_discardable(ext) is True  # idle: Chrome's default
        jobs = ext.finished_jobs()
        page.fill("#links", MAIN_LINK)
        page.click("#download-all-button")
        page.fill("#links", SECOND_LINK)
        page.click("#download-all-button")  # queued behind the first
        ext.wait_for(lambda: page.locator("#queue-card").is_visible(), 10, "nothing queued")
        assert _auto_discardable(ext) is False  # one runs, one waits
        ext.wait_for(lambda: ext.finished_jobs() == jobs + 1, 60, "the first job did not end")
        assert _auto_discardable(ext) is False  # the second runs now
        ext.wait_for(lambda: ext.finished_jobs() == jobs + 2 and ext.idle(), 60, "no end")
        ext.wait_for(lambda: _auto_discardable(ext) is True, 5, "still not discardable")

        page.fill("#links", THIRD_LINK)
        page.click("#download-all-button")
        ext.wait_for(lambda: page.locator("#progress-pause").is_visible(), 30, "no pause")
        assert _auto_discardable(ext) is False
        page.click("#stop-button")
        ext.wait_for(lambda: ext.finished_jobs() == jobs + 3 and ext.idle(), 30, "not stopped")
        assert ext.history()[0]["stopped"] == "stopped by you"  # stored in English
        ext.wait_for(lambda: _auto_discardable(ext) is True, 5, "not discardable after a Stop")
        assert server.media_requests  # the jobs really ran


def test_the_spanish_ui_shows_every_outcome_in_spanish(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Chrome in Spanish: done, an episode found encrypted, a locked one, the series rest, episodes
    already on disk, the remembered DRM verdict, the complete skip with its hint, the list's
    warnings and hints, a 429 with its stop, cooldown and not-started series, the history — all
    on screen in Spanish, the status codes in the badges' titles; the stored texts stay English."""
    monkeypatch.setenv("LANGUAGE", "es")  # Chrome on Linux takes its UI language from it
    drm = frozenset({(SERIES_ID, 2)})
    settings = {"restMinS": 1.5, "restMaxS": 2}  # the series rest long enough to be read
    with (
        FakeTikTok(drm_media=drm) as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=settings) as ext,
    ):
        page = ext.page
        assert page.evaluate("() => document.documentElement.lang") == "es"
        assert page.locator("#app-status").text_content() == "en espera"
        seen: list[str] = []

        # a batch: E01, E03, E04 downloaded, E02 encrypted, E05 locked; the rest; the second series
        pauses = _run(ext, f"{MAIN_LINK}\n{SECOND_LINK}", watch_pauses=True)
        assert any(text.startswith("descanso de ") for text in pauses), pauses
        seen += pauses
        badges = _badges(ext)
        assert {code for _, code, _ in badges.values()} <= STATUSES
        texts = _engine_texts(ext)
        assert any("descargado" in text and "portada incrustada" in text for text in texts)
        assert any("protegido con DRM (pistas cifradas)" in text for text in texts)
        assert any(text.startswith(f"{SERIES_NAME}: incompleta: ") for text in texts)
        assert any(text.startswith(f"{SECOND_SERIES_NAME}: completa: 3 de 3") for text in texts)
        seen += texts
        entry = ext.history()[0]  # the stored texts: the engine's English
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
        main, _second = ext.history()[0]["series"]
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
        assert ext.history()[0]["series"][0]["line"].endswith("--recheck looks again")
        seen += _engine_texts(ext)

        # the list: its warnings, the lock hints, the badges
        ext.load(MAIN_LINK)
        warnings = _texts(ext, "#series-warnings li")
        assert "1 episodio parece bloqueado" in warnings
        hints = _texts(ext, "#episode-table .hints")
        assert hints and all("sin dirección de reproducción" in hint for hint in hints)
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
            texts = _engine_texts(ext)
            assert any("no iniciada" in text for text in texts)
            banner = page.locator("#cooldown-text").inner_text()
            assert banner.startswith("TikTok rechazó una solicitud a las ")
            assert "la extensión no tiene forma de levantarla antes de tiempo" in banner
            seen += texts
            assert ext.cooldown() is not None
            assert len(limited.media_requests) == 1

        # the history, opened
        page.click("#history-card > summary")
        history = _texts(ext, "#history-list > li")
        assert len(history) == 5  # three batches, a listing, the batch the 429 stopped
        seen += history
        _assert_spanish(seen)
