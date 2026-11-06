"""The DramaFetch Chrome extension end to end (`pytest -m integration`; skipped without a browser).

A real headless Chromium loads the extension's TEST copy (`extension_harness.ExtensionHarness`:
`dramafetch_test` and `http://127.0.0.1/*` added to the copy's manifest only) and drives the fake
TikTok server through the extension's own app page — discovery through the page's own request in
a background tab, downloads with the Referer rule, verification, DRM, covers, naming, the
per-series state, pacing, cooldown and stops, batches. Every scenario counts the requests the fake
server saw. No cookie value is ever printed or asserted on, beyond checking that it is stored
nowhere.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
from mutagen.mp4 import MP4, MP4Cover

from dramafetch.media import INCOMPLETE_PREFIX
from dramafetch.models import DRM_MESSAGE, DRM_REMEMBERED_MESSAGE

from .extension_harness import CHROMIUM, ExtensionHarness
from .fake_tiktok import (
    SECOND_ITEMS,
    SECOND_SERIES_ID,
    SECOND_SERIES_NAME,
    SERIES_ID,
    SERIES_NAME,
    THIRD_ITEMS,
    THIRD_SERIES_ID,
    THIRD_SERIES_NAME,
    TINY_MP4,
    FakeTikTok,
    cover_bytes,
    media_bytes,
)

if TYPE_CHECKING:
    from playwright.sync_api import Page

    from conftest import Tools

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not CHROMIUM.is_file(), reason=f"no Chromium at {CHROMIUM} (set DRAMAFETCH_CHROMIUM)"
    ),
]

SESSION_VALUE = "fake-session-value-that-must-never-leak"
MAIN_LINK = f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1"
SECOND_LINK = f"https://www.tiktok.com/shortdrama/episode/{SECOND_SERIES_ID}/2"
THIRD_LINK = THIRD_SERIES_ID  # a bare series id is a series too
MAIN_FOLDER = Path("DramaFetch") / f"{SERIES_NAME} [{SERIES_ID}]"
MAIN_ITEMS = {n: f"769940000000000000{n}" for n in range(1, 6)}
REPORTS_FOLDER = Path("DramaFetch") / "reports"
#: `<series name> - did not download YYYY-MM-DD HHMM.json` — and ` (1)` before `.json` when a
#: second report lands in the same minute (`conflictAction: "uniquify"`).
_REPORT_NAME_RE = re.compile(
    rf"^{re.escape(SERIES_NAME)} - did not download \d{{4}}-\d{{2}}-\d{{2}} \d{{4}}"
    r"(?: \(\d+\))?\.json$"
)
THIRD = dict(enumerate(THIRD_ITEMS, start=1))
MEDIA_RATE_LIMIT = (
    "rate limited (HTTP 429) by the video server: wait 30-60 minutes before trying again"
)
LOGIN_REDIRECT = (
    "TikTok redirected to its login page: log in to TikTok in a normal tab of this Chrome, then "
    "try again"
)


# ------------------------------------------------------------------------------- helpers


def _rows(series: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return {row["number"]: row for row in series["rows"]}


def _statuses(series: dict[str, Any]) -> list[str]:
    rows = _rows(series)
    return [rows[number]["status"] for number in sorted(rows)]


def _media_of(server: FakeTikTok, item_id: str) -> list[Any]:
    return [r for r in server.media_requests if r.path.startswith(f"/cdn/{item_id}/")]


def _downloader_covers(server: FakeTikTok, item_id: str | None = None) -> list[Any]:
    """Cover requests the extension made with its Referer rule: the downloader's — and, once
    **Load list** shows a series, the list's thumbnails, which the extension fetches itself, one at
    a time (only test_b lists a series before counting: it waits for them first)."""
    return [
        r
        for r in server.cover_requests
        if r.with_referer and (item_id is None or r.path == f"/cover/{item_id}.jpg")
    ]


def _episode_file(ext: ExtensionHarness, number: int) -> Path:
    return ext.downloads / MAIN_FOLDER / f"{SERIES_NAME} - Episode {number:02d}.mp4"


def _report_files(ext: ExtensionHarness) -> list[Path]:
    """The "did not download" reports saved so far (`DramaFetch/reports/*.json`), relative to the
    download directory, sorted: a run with a failed episode saves one by default."""
    return [path for path in ext.saved_files() if path.parent == REPORTS_FOLDER]


def _videos(ext: ExtensionHarness) -> list[Path]:
    """Every saved file but the reports: the episodes (and any cover sidecar)."""
    return [path for path in ext.saved_files() if path.parent != REPORTS_FOLDER]


def _ffmpeg() -> str | None:
    """The first ffmpeg that decodes the fixture (H.264 + AAC) without a word."""
    candidates = [shutil.which("ffmpeg")]
    candidates += [
        str(path) for path in sorted(Path("/opt/pw-browsers").glob("ffmpeg-*/ffmpeg-linux"))
    ]
    for candidate in candidates:
        if not candidate:
            continue
        proc = subprocess.run(
            [candidate, "-v", "error", "-i", "-", "-map", "0", "-f", "framemd5", "-"],
            input=TINY_MP4,
            capture_output=True,
            timeout=60,
            check=False,
        )
        if proc.returncode == 0 and not proc.stderr:
            return candidate
    return None


def _framemd5(ffmpeg: str, path: Path) -> list[str]:
    proc = subprocess.run(
        [ffmpeg, "-v", "error", "-i", str(path), "-map", "0", "-f", "framemd5", "-"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert proc.returncode == 0 and proc.stderr == "", proc.stderr
    return [line for line in proc.stdout.splitlines() if line and not line.startswith("#software")]


def _streams(lines: list[str], keep: set[int]) -> list[str]:
    """The framemd5 lines (stream headers and frames) of the streams in `keep` only."""
    kept = []
    for line in lines:
        if line.startswith("#"):
            name, _, index = line.split(":", 1)[0].rpartition(" ")
            if name and index.isdigit() and int(index) not in keep:
                continue
        elif int(line.split(",", 1)[0]) not in keep:
            continue
        kept.append(line)
    return kept


# ------------------------------------------------------------------------------ scenarios


def test_a_main_series_saved_verified_with_embedded_covers(tmp_path: Path, tools: Tools) -> None:
    """E01-E04 saved as `DramaFetch/<Name> [<id>]/<Name> - Episode 0N.mp4`, each with the fake
    CDN's cover embedded as `covr`, 3 s long with audio, decoding frame for frame like the CDN's
    original bytes; E05 (locked) skipped without a single request; the exact report line; the
    extension's Referer only on its own media and cover requests, never on the page's."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        entry = ext.download_all(MAIN_LINK)
        assert entry["error"] is None and entry["stopped"] is None
        (series,) = entry["series"]
        assert series["status"] == "complete"
        assert series["line"] == "complete: 4 of 5 (4 downloaded) — 1 locked (5)"
        assert _statuses(series) == ["done"] * 4 + ["skipped-locked"]
        rows = _rows(series)
        assert rows[5]["message"].startswith("looks locked: ")
        expected = [MAIN_FOLDER / f"{SERIES_NAME} - Episode {n:02d}.mp4" for n in range(1, 5)]
        assert ext.saved_files() == expected
        ffmpeg = _ffmpeg()
        for number in range(1, 5):
            item = MAIN_ITEMS[number]
            path = _episode_file(ext, number)
            message = rows[number]["message"]
            assert message.startswith(f"saved {path.name} (") and message.endswith(
                " + cover embedded"
            )
            mp4 = MP4(path)
            assert mp4.tags is not None
            (cover,) = mp4.tags["covr"]
            assert bytes(cover) == cover_bytes(item)
            assert cover.imageformat == MP4Cover.FORMAT_JPEG
            assert abs(mp4.info.length - 3) < 0.5
            assert str(mp4.info.codec).startswith("mp4a")
            if ffmpeg is not None:
                original = tmp_path / f"original-{number}.mp4"
                original.write_bytes(media_bytes(item, "0"))
                reference = _framemd5(ffmpeg, original)
                embedded = _framemd5(ffmpeg, path)
                assert _streams(embedded, {0, 1}) == _streams(reference, {0, 1})
                extra = [line for line in embedded if line.startswith("#dimensions 2:")]
                assert extra == ["#dimensions 2: 16x16"]  # the cover: one more stream
                assert len([line for line in embedded if line.startswith("2,")]) == 1
        state = ext.series_state(SERIES_ID)
        assert state is not None and state["complete_at"] and state["complete_episodes"] == 4
        assert all(isinstance(state["episodes"][str(n)]["download_id"], int) for n in range(1, 5))
    # requests: one page load, the page's list request, the extension's two pages and the detail
    assert len(server.series_page_requests) == 1
    assert [r.query["cursor"] for r in server.item_list_requests] == ["0", "0", "3"]
    # the first page is the page's own request replayed byte for byte (its count=10, so TikTok's
    # signature parameters still match their query); only the later pages ask for 30
    assert [r.query["count"] for r in server.item_list_requests[1:]] == ["10", "30"]
    assert not any(r.with_referer for r in server.item_list_requests)  # the page's own requests
    assert len(server.media_requests) == 4 and all(r.with_referer for r in server.media_requests)
    assert len(_downloader_covers(server)) == 4
    assert not _media_of(server, MAIN_ITEMS[5]) and not _downloader_covers(server, MAIN_ITEMS[5])
    no_ffmpeg = "saved and verified; no ffmpeg that decodes H.264 + AAC for the framemd5 check"
    tools.need("ffmpeg", ffmpeg is not None, no_ffmpeg)  # CI installs one: a failure there


def test_b_again_skips_then_the_complete_skip(tmp_path: Path) -> None:
    """A second look (recheck, and Load list + Download all available) finds every episode on disk:
    skipped, zero media requests; a third run within 24 h is the complete skip — zero requests at
    all, no tab opened, and the line points at recheck for the locked episode."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        first = ext.download_all(MAIN_LINK)
        assert first["error"] is None and first["stopped"] is None  # a failed listing is no skip
        assert _statuses(first["series"][0]) == ["done"] * 4 + ["skipped-locked"]
        media = len(server.media_requests)
        covers = len(_downloader_covers(server))

        ext.watch_tabs()  # chrome.tabs.onCreated: Playwright never sees the extension's own tabs
        again = ext.download_all(MAIN_LINK, recheck=True)
        assert len(ext.opened_tabs()) == 1  # the recheck lists the series in a tab of its own
        (series,) = again["series"]
        assert _statuses(series) == ["skipped-exists"] * 4 + ["skipped-locked"]
        assert all(
            _rows(series)[n]["message"].startswith("already downloaded (manifest): ")
            for n in range(1, 5)
        )
        assert series["line"] == "complete: 4 of 5 (4 already on disk) — 1 locked (5)"
        assert len(server.media_requests) == media and len(_downloader_covers(server)) == covers

        listing = ext.load(MAIN_LINK)
        assert listing["series"][0]["episodes"] == 5
        table = ext.page.locator("#episode-table tbody")
        for number in range(1, 6):
            row = table.locator(f"tr[data-number='{number}']")
            assert row.locator(".badge.ondisk").count() == (1 if number < 5 else 0)
            assert row.locator("input[type=checkbox]").is_checked() is False  # on disk, or locked
        assert table.locator("tr[data-number='5']").get_attribute("data-access") == "locked"
        # the list's thumbnails: the extension's own requests, one per episode, each once its row
        # is in view (scrolled to, row by row), then none again
        for number in range(1, 6):
            row = table.locator(f"tr[data-number='{number}']")
            row.locator("td.cover-cell").scroll_into_view_if_needed()
            ext.wait_for(lambda row=row: row.locator("img.cover").count() == 1, 20, "no thumbnail")
        assert table.locator("img.cover").count() == 5
        assert len(_downloader_covers(server)) == covers + 5
        covers += 5
        selection = ext.download_available()
        (selected,) = selection["series"]
        assert _statuses(selected) == ["skipped-exists"] * 4
        assert selected["line"] == "complete: 4 of 5 (4 already on disk) — 1 locked (5)"
        assert len(server.media_requests) == media and len(_downloader_covers(server)) == covers

        requests = len(server.requests)
        tabs = len(ext.opened_tabs())
        third = ext.download_all(MAIN_LINK)
        (skipped,) = third["series"]
        assert skipped["status"] == "skipped (complete)"
        assert skipped["line"] == (
            "complete, nothing to do: 4 episodes already on disk, 1 locked (5) (checked just now)"
            " — unlocked more in the TikTok app since? --recheck looks again"
        )
        assert len(server.requests) == requests
        assert len(ext.opened_tabs()) == tabs  # the complete skip opens no tab
        assert len(ext.saved_files()) == 4


def test_c_paid_series_with_and_without_the_session(tmp_path: Path) -> None:
    """Without the session cookie the paid episode 3 is locked and never requested; with it (the
    account that bought it), episode 3 downloads like a free one and the report names it; episode
    4 stays locked either way, zero requests for it; the cookie is stored nowhere."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        logged_out = ext.download_all(THIRD_LINK)
        (series,) = logged_out["series"]
        assert series["name"] == THIRD_SERIES_NAME
        assert _statuses(series) == ["done", "done", "skipped-locked", "skipped-locked"]
        assert series["line"] == "complete: 2 of 4 (2 downloaded) — 2 locked (3, 4)"
        assert not _media_of(server, THIRD[3]) and not _media_of(server, THIRD[4])
        assert not any(r.logged_in for r in server.requests)

        ext.add_session_cookie(SESSION_VALUE)
        logged_in = ext.download_all(THIRD_LINK, recheck=True)
        (series,) = logged_in["series"]
        assert _statuses(series) == ["skipped-exists", "skipped-exists", "done", "skipped-locked"]
        assert series["line"] == (
            "complete: 3 of 4 (1 downloaded, 2 already on disk) — 1 paid episode your account "
            "unlocked (3), 1 locked (4)"
        )
        assert len(_media_of(server, THIRD[3])) == 1 and not _media_of(server, THIRD[4])
        assert server.item_list_requests[-1].logged_in  # the page's own request carried the session
        folder = Path("DramaFetch") / f"{THIRD_SERIES_NAME} [{THIRD_SERIES_ID}]"
        assert ext.saved_files() == [
            folder / f"{THIRD_SERIES_NAME} - Episode {n:02d}.mp4" for n in (1, 2, 3)
        ]
        assert SESSION_VALUE not in json.dumps(ext.storage())


def test_d_drm_media_is_refused_remembered_and_never_requested_again(tmp_path: Path) -> None:
    """An encrypted episode: failed-unavailable with DRM_MESSAGE, nothing saved, no other mirror,
    no fresh list, no cover; the state remembers it, so the next run skips it without a request."""
    drm = frozenset({(SERIES_ID, 2)})
    with FakeTikTok(drm_media=drm) as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        first = ext.download_all(MAIN_LINK)
        (series,) = first["series"]
        assert _statuses(series) == ["done", "failed-unavailable", "done", "done", "skipped-locked"]
        assert _rows(series)[2]["message"] == DRM_MESSAGE
        assert not _episode_file(ext, 2).exists()
        assert len(_media_of(server, MAIN_ITEMS[2])) == 1
        assert not _downloader_covers(server, MAIN_ITEMS[2])
        assert len(server.series_page_requests) == 1  # no fresh list for it
        state = ext.series_state(SERIES_ID)
        assert state is not None and state["episodes"]["2"]["message"] == DRM_MESSAGE

        media = len(server.media_requests)
        second = ext.download_all(MAIN_LINK)
        (series,) = second["series"]
        assert _statuses(series) == [
            "skipped-exists",
            "skipped-locked",
            "skipped-exists",
            "skipped-exists",
            "skipped-locked",
        ]
        assert _rows(series)[2]["message"] == DRM_REMEMBERED_MESSAGE
        assert len(server.media_requests) == media
        assert series["line"] == "complete: 3 of 5 (3 already on disk) — 2 locked (2, 5)"


def test_e_rate_limit_stops_records_the_cooldown_and_refuses_the_next_action(
    tmp_path: Path,
) -> None:
    """HTTP 429 from the CDN: the stop, the 30-minute cooldown stored, the rest of the series
    `stopped`, the batch's next series `not started` with no request, and the next action —
    the popup's "Download this series" — refused by the cooldown with zero requests."""
    with (
        FakeTikTok(cdn_rate_limit=True) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        entry = ext.download_all(f"{MAIN_LINK}\n{SECOND_LINK}")
        main, second = entry["series"]
        rows = _rows(main)
        assert rows[1]["status"] == "failed-rate-limited" and rows[1]["message"] == MEDIA_RATE_LIMIT
        for number in (2, 3, 4):
            assert rows[number]["status"] == "failed-rate-limited"
            assert rows[number]["message"] == (
                f"stopped: episode 1 failed-rate-limited: {MEDIA_RATE_LIMIT}"
            )
        assert rows[5]["status"] == "skipped-locked"
        assert len(server.media_requests) == 1 and not _downloader_covers(server)
        assert second["status"] == "not started"
        assert second["error"] == (
            f"not started: batch stopped in {SERIES_NAME} (episode 1 failed-rate-limited)"
        )
        assert not server.series_requests(SECOND_SERIES_ID)
        cooldown = ext.cooldown()
        assert cooldown is not None and cooldown["source"] == "browser"
        assert cooldown["reason"] == MEDIA_RATE_LIMIT
        assert abs(cooldown["until"] - (time.time() + 1800)) < 300
        assert entry["stopped"] == "episode 1 failed-rate-limited"

        page = ext.page
        ext.wait_for(lambda: page.locator("#cooldown-banner").is_visible(), 10)
        assert page.locator("#download-all-button").is_disabled()
        assert page.locator("#load-button").is_disabled()
        requests = len(server.requests)
        jobs = ext.finished_jobs()
        popup = ext.context.new_page()
        popup.goto(f"chrome-extension://{ext.extension_id}/src/app/popup.html")
        popup.evaluate(
            "(id) => chrome.runtime.sendMessage({type: 'dramafetch:open', load: id})", SERIES_ID
        )
        ext.wait_for(lambda: ext.finished_jobs() > jobs and ext.idle(), 30)
        refused = ext.history()[0]
        assert refused["kind"] == "load"
        assert str(refused["error"]).startswith("TikTok refused a request at ")
        assert len(server.requests) == requests
        assert [url for url in ext.tab_urls() if url.endswith("/app.html")] == [ext.app_url]


def test_f_batch_of_three_series_rests_between_them_and_never_interleaves(tmp_path: Path) -> None:
    """Three series, strictly one after the other, each listed right before its own downloads,
    with one announced series rest between two series that contact TikTok."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        entry = ext.download_all("\n".join([MAIN_LINK, f"# a comment\n{SECOND_LINK}", THIRD_LINK]))
        lines = [series["line"] for series in entry["series"]]
        assert lines == [
            "complete: 4 of 5 (4 downloaded) — 1 locked (5)",
            "complete: 3 of 3 (3 downloaded)",
            "complete: 2 of 4 (2 downloaded) — 2 locked (3, 4)",
        ]
        assert [series["name"] for series in entry["series"]] == [
            SERIES_NAME,
            SECOND_SERIES_NAME,
            THIRD_SERIES_NAME,
        ]
        rests = [pause for pause in entry["pauses"] if pause["kind"] == "series-rest"]
        assert len(rests) == 2 and len(entry["pauses"]) == 2
        assert all(pause["text"].endswith(" s before the next series") for pause in rests)
        spans = []
        for series_id in (SERIES_ID, SECOND_SERIES_ID, THIRD_SERIES_ID):
            records = server.series_requests(series_id)
            indexes = [server.requests.index(record) for record in records]
            spans.append((min(indexes), max(indexes)))
        assert spans[0][1] < spans[1][0] and spans[1][1] < spans[2][0]  # never interleaved
        assert len(_media_of(server, SECOND_ITEMS[0])) == 1
        assert len(ext.saved_files()) == 4 + 3 + 2


def test_g_truncated_transfer_fails_without_a_second_mirror(tmp_path: Path) -> None:
    """A body cut short by the network: `failed` "download looks incomplete or wrong: truncated
    body …", nothing saved, no next mirror, no cover; three in a row stop the run."""
    with (
        FakeTikTok(truncate_media=True) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        entry = ext.download_all(MAIN_LINK)
        (series,) = entry["series"]
        rows = _rows(series)
        for number in (1, 2, 3):
            assert rows[number]["status"] == "failed"
            message = rows[number]["message"]
            assert message.startswith(f"{INCOMPLETE_PREFIX}truncated body (")
            assert message.endswith(" from 127.0.0.1")
        assert rows[4]["status"] == "failed"
        assert rows[4]["message"].startswith("stopped: 3 consecutive failures (last: ")
        assert rows[5]["status"] == "skipped-locked"
        assert [len(_media_of(server, MAIN_ITEMS[n])) for n in (1, 2, 3, 4)] == [1, 1, 1, 0]
        assert not _downloader_covers(server)
        assert _videos(ext) == []  # only the report of the failures (test_q)
        assert entry["stopped"] == "3 consecutive failures"


def test_h_expired_play_urls_cost_one_rediscovery_then_save(tmp_path: Path) -> None:
    """Every play URL of the first listing has expired: one in-run re-discovery of the series
    (cached for the rest of the run), then every episode saved; no expired URL is requested."""
    with (
        FakeTikTok(expired_media_first_visit=True) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        entry = ext.download_all(MAIN_LINK)
        (series,) = entry["series"]
        assert _statuses(series) == ["done"] * 4 + ["skipped-locked"]
        assert entry["refreshes"] == 1
        assert len(server.series_page_requests) == 2
        assert len(server.media_requests) == 4
        assert len(ext.saved_files()) == 4


def test_i_captcha_stops_and_starts_the_cooldown(tmp_path: Path) -> None:
    """A verification page instead of the series: the batch stops (`captcha`), the cooldown
    starts (source `discovery`), the next series is not started, and the tab is closed."""
    with FakeTikTok(challenge=True) as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        entry = ext.download_all(f"{MAIN_LINK}\n{SECOND_LINK}")
        main, second = entry["series"]
        assert main["error_kind"] == "captcha"
        assert str(main["error"]).startswith("TikTok is asking for a verification (captcha)")
        assert second["error"] == f"not started: batch stopped in {SERIES_ID} (captcha)"
        cooldown = ext.cooldown()
        assert cooldown is not None and cooldown["source"] == "discovery"
        assert not server.item_list_requests and not server.media_requests
        assert len(server.series_page_requests) == 1
        assert not any(url.startswith(server.base_url) for url in ext.tab_urls())


def test_i_captcha_after_the_first_page_stops_and_starts_the_cooldown(tmp_path: Path) -> None:
    """TikTok's wall raised AFTER the first list page (every later page answered with the captcha
    page): the extension's own fetch of the second page is refused while the page shows no wall
    yet, so it scrolls; the page's own scroll request is refused too and the page shows the wall;
    the quiet scroll round sees it — `captcha`, the cooldown, the next series not started, and
    not one download from the partial list. The list requests: the page's first one, the
    extension's replay of it, its second-page fetch and the page's scroll request — plus, when
    the observer saw that scroll request complete before the round looked for the page's own
    URLs, one re-fetch of that URL (refused the same way; the fallback re-fetches each of the
    page's URLs once, as always): four or five, never a download."""
    with (
        FakeTikTok(challenge_after_first_page=True) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        entry = ext.download_all(f"{MAIN_LINK}\n{SECOND_LINK}")
        main, second = entry["series"]
        assert main["error_kind"] == "captcha"
        assert str(main["error"]).startswith("TikTok is asking for a verification (captcha)")
        assert second["error"] == f"not started: batch stopped in {SERIES_ID} (captcha)"
        cooldown = ext.cooldown()
        assert cooldown is not None and cooldown["source"] == "discovery"
        requests = [(r.query["cursor"], r.from_scroll) for r in server.item_list_requests]
        assert requests[:4] == [("0", False), ("0", False), ("3", False), ("3", True)]
        assert requests[4:] in ([], [("3", False)])  # the page's own URL re-fetched once, at most
        assert not server.media_requests and len(server.series_page_requests) == 1
        assert not any(url.startswith(server.base_url) for url in ext.tab_urls())


def test_i_login_redirect_stops_without_a_cooldown(tmp_path: Path) -> None:
    """TikTok's login wall: the batch stops (`login required`), no cooldown (not a refusal)."""
    with (
        FakeTikTok(require_login=True) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        entry = ext.download_all(f"{MAIN_LINK}\n{SECOND_LINK}")
        main, second = entry["series"]
        assert main["error_kind"] == "login" and main["error"] == LOGIN_REDIRECT
        assert second["error"] == f"not started: batch stopped in {SERIES_ID} (login required)"
        assert ext.cooldown() is None
        assert not server.media_requests and not server.series_requests(SECOND_SERIES_ID)
        assert not any(url.startswith(server.base_url) for url in ext.tab_urls())


def _job_rests(entry: dict[str, Any]) -> list[str]:
    """The rests between jobs a finished job announced (`resting N s before the next series`)."""
    return [pause["text"] for pause in entry["pauses"] if pause["kind"] == "job-rest"]


def test_j_a_redirect_is_never_followed(tmp_path: Path) -> None:
    """A 302 from the fake CDN to a host the test copy does not cover (`localhost`) is never
    followed: not for a video — refused like a 403, the next URL, `failed-unavailable`, nothing
    saved — and not for a thumbnail of **Load list** (none shown): no request reaches that host."""
    with (
        FakeTikTok(redirect_media=True, redirect_covers=True) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        ext.load(MAIN_LINK)
        for number, item in MAIN_ITEMS.items():  # each row's thumbnail is asked for once in view
            row = ext.page.locator(f"#episode-table tbody tr[data-number='{number}']")
            row.locator("td.cover-cell").scroll_into_view_if_needed()
            asked = f"/cover/{item}.jpg"
            ext.wait_for(
                lambda asked=asked: any(r.path == asked for r in server.cover_requests),
                20,
                "no thumbnail was asked for",
            )
        ext.wait_for(lambda: len(server.cover_requests) == 5, 20, "no thumbnail was asked for")
        entry = ext.download_all(MAIN_LINK)
        (series,) = entry["series"]
        rows = _rows(series)
        assert _statuses(series) == ["failed-unavailable"] * 3 + ["failed", "skipped-locked"]
        assert rows[1]["message"].endswith("(a redirect from 127.0.0.1, not followed)")
        assert rows[4]["message"].startswith("stopped: 3 consecutive failures (last: ")
        assert ext.page.locator("#episode-table img.cover").count() == 0
        assert _videos(ext) == []  # only the report of the failures (test_q)
        assert len(server.cover_requests) == 5  # each thumbnail asked for once; no cover GET
    assert server.media_requests and not server.elsewhere_requests


def test_k_a_selection_lists_the_series_again_for_the_session_logged_in_now(
    tmp_path: Path,
) -> None:
    """**Download all available** never takes the list shown — someone else, or nobody, may be
    logged in by now: listed with the session (episode 3 unlocked), logged out, the selection lists
    the series again after the rest between jobs, and that list decides — episode 3 is skipped
    without a request; nothing of the earlier session's list is used."""
    settings = {"restMinS": 0.5, "restMaxS": 6}
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=settings) as ext,
    ):
        ext.add_session_cookie(SESSION_VALUE)
        ext.load(THIRD_LINK)
        table = ext.page.locator("#episode-table tbody")
        assert table.locator("tr[data-number='3']").get_attribute("data-access") == "unlocked"
        ext.context.clear_cookies()  # logged out of the fake TikTok
        pages = len(server.series_page_requests)
        entry = ext.download_available()
        (series,) = entry["series"]
        assert _statuses(series) == ["done", "done", "skipped-locked"]
        assert _rows(series)[3]["message"].startswith("looks locked: ")
        assert not _media_of(server, THIRD[3])
        assert len(server.series_page_requests) == pages + 1  # listed again, without the session
        assert not server.item_list_requests[-1].logged_in
        assert len(_job_rests(entry)) == 1  # the rest came first: the list follows right after it
        assert table.locator("tr[data-number='3']").get_attribute("data-access") == "locked"


def test_l_the_rest_between_jobs_holds_after_a_listing_a_stop_and_a_closed_tab(
    tmp_path: Path,
) -> None:
    """The rest between two jobs that contact TikTok counts from the last contact, whatever ended
    the job — a **Load list**, a run the user stopped, a run whose tab was closed (the contact is
    stored as it happens) — so the next job rests before its first request."""
    settings = {"delayMinS": 1, "delayMaxS": 1, "restMinS": 0.5, "restMaxS": 6}
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=settings) as ext,
    ):

        def contact() -> float:
            stored = ext.storage("pacing")["pacing"]["lastContactAt"]
            assert isinstance(stored, (int, float))
            return float(stored)

        started = time.time()
        ext.load(SECOND_LINK)
        assert contact() >= started  # a listing contacts TikTok too
        assert len(_job_rests(ext.download_all(SECOND_LINK))) == 1

        page = ext.page
        page.fill("#links", MAIN_LINK)
        jobs = ext.finished_jobs()
        page.click("#download-all-button")
        ext.wait_for(lambda: bool(_media_of(server, MAIN_ITEMS[1])), 30, "no first episode")
        seen = time.time()
        ext.wait_for(lambda: page.locator("#progress-pause").is_visible(), 30, "no pause")
        page.click("#stop-button")
        ext.wait_for(lambda: ext.finished_jobs() > jobs and ext.idle(), 30, "not stopped")
        assert ext.history()[0]["stopped"] is not None
        assert contact() >= seen  # the stopped run's end
        assert len(_job_rests(ext.download_all(THIRD_LINK))) == 1

        page.fill("#links", MAIN_LINK)
        page.click("#download-all-button")
        ext.wait_for(lambda: bool(_media_of(server, MAIN_ITEMS[2])), 30, "no second episode")
        seen = time.time()
        ext.wait_for(lambda: page.locator("#progress-pause").is_visible(), 30, "no pause")
        page.close()  # mid-run: the job's own clean-up never runs
        ext.reopen_app()
        assert contact() >= seen - 1  # stored when the episode was fetched
        assert len(_job_rests(ext.download_all(MAIN_LINK))) == 1


def test_m_the_tiktok_tab_is_closed_when_the_app_tab_goes_away_mid_listing(tmp_path: Path) -> None:
    """The DramaFetch tab closed — or reloaded — while a series is being listed: its own clean-up
    never runs, yet the muted TikTok tab it opened is closed (by the background worker; by the
    reloaded page)."""
    with (
        FakeTikTok(slow_pagination_s=20) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        series_page = f"{server.base_url}/shortdrama/episode/"
        watcher = ext.context.new_page()
        watcher.goto(f"chrome-extension://{ext.extension_id}/src/app/popup.html")

        def tiktok_tabs() -> list[str]:
            urls: list[str] = watcher.evaluate(
                "async () => (await chrome.tabs.query({}))"
                ".map((tab) => tab.url || tab.pendingUrl || '')"
            )
            return [url for url in urls if url.startswith(series_page)]

        for how in ("close", "reload"):
            lists = len(server.item_list_requests)
            ext.page.fill("#links", MAIN_LINK)
            ext.page.click("#load-button")
            # the page's own list request, the repeated first page, then the slow second page
            ext.wait_for(lambda: len(server.item_list_requests) >= lists + 3, 30, "not listing")  # noqa: B023
            assert len(tiktok_tabs()) == 1
            if how == "close":
                ext.page.close()
                ext.wait_for(lambda: not tiktok_tabs(), 10, "the TikTok tab stayed open")
                ext.reopen_app()
            else:
                ext.page.reload()
                ext.wait_for(lambda: not tiktok_tabs(), 10, "the TikTok tab stayed open")


def test_n_a_file_deleted_right_after_a_run_is_downloaded_again(tmp_path: Path) -> None:
    """Chrome re-checks whether its downloads still exist at most once every 10 s: the run right
    after an episode's file was deleted waits that out (no request meanwhile), finds the file gone
    and downloads that episode again — never the complete skip over a missing file."""
    chrome_rate_limit = {"existenceRateLimitS": 10}
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=chrome_rate_limit) as ext,
    ):
        assert ext.download_all(MAIN_LINK)["series"][0]["status"] == "complete"
        _episode_file(ext, 2).unlink()
        media = len(server.media_requests)
        (series,) = ext.download_all(MAIN_LINK)["series"]
        assert _statuses(series) == [
            "skipped-exists",
            "done",
            "skipped-exists",
            "skipped-exists",
            "skipped-locked",
        ]
        assert series["line"] == "complete: 4 of 5 (1 downloaded, 3 already on disk) — 1 locked (5)"
        assert [r.path for r in server.media_requests[media:]] == [f"/cdn/{MAIN_ITEMS[2]}/0.mp4"]
        assert _episode_file(ext, 2).is_file()


def test_o_a_download_id_chrome_hands_out_again_is_not_the_episode(tmp_path: Path) -> None:
    """Once Chrome's download history is cleared and Chrome restarts, it hands its download ids out
    again — here to four unrelated downloads: the episodes recorded under those ids are not on disk
    (the recorded file decides, not the id), so the next run downloads them again."""
    profile = tmp_path / "profile"
    with FakeTikTok() as server:
        with ExtensionHarness(tmp_path, server.base_url, profile=profile) as ext:
            ext.download_all(MAIN_LINK)
            state = ext.series_state(SERIES_ID)
            assert state is not None
            ids = sorted(state["episodes"][str(n)]["download_id"] for n in range(1, 5))
            ext.page.evaluate("() => chrome.downloads.erase({})")
            shutil.rmtree(ext.downloads / "DramaFetch")
        with ExtensionHarness(tmp_path, server.base_url, profile=profile) as ext:
            reused: list[int] = ext.page.evaluate(
                """async () => {
                  const ids = [];
                  for (let i = 0; i < 4; i += 1) {
                    const url = URL.createObjectURL(new Blob(['unrelated ' + i]));
                    const filename = 'unrelated-' + i + '.txt';
                    ids.push(await chrome.downloads.download({url, filename}));
                  }
                  return ids;
                }"""
            )
            assert sorted(reused) == ids  # the very ids the episodes were saved under
            media = len(server.media_requests)
            (series,) = ext.download_all(MAIN_LINK)["series"]
            assert _statuses(series) == ["done"] * 4 + ["skipped-locked"]
            assert len(server.media_requests) == media + 4
            assert [path.name for path in ext.saved_files() if path.suffix == ".mp4"] == [
                f"{SERIES_NAME} - Episode {n:02d}.mp4" for n in range(1, 5)
            ]


def _table_rows(page: Page, table: str) -> list[tuple[str, str]]:
    """The episode rows of a progress-card table as (number, status), in order — never a series'
    header row, which carries no number."""
    rows = page.locator(f"{table} tbody tr[data-number]")
    return [
        (str(row.get_attribute("data-number")), str(row.get_attribute("data-status")))
        for row in rows.all()
    ]


def test_p_the_episodes_that_did_not_download_are_shown_apart_and_retried(tmp_path: Path) -> None:
    """A run whose downloads fail — transfers cut short (`download looks incomplete or wrong`), an
    encrypted episode, then the stop after three failures in a row — shows the episodes that did
    not download apart from the ones that completed, with their count and a retry button, and so
    does its history entry. The retry is one selection job over exactly those episodes (never the
    locked one): a fresh resolve, the state's DRM memory respected (episode 2 skipped without a
    request), the others requested once more and failing again; nothing saved; the block then
    shows what failed again, the result table keeping only the skip."""
    drm = frozenset({(SERIES_ID, 2)})
    with (
        FakeTikTok(truncate_media=True, drm_media=drm) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        first = ext.download_all(MAIN_LINK)
        (series,) = first["series"]
        assert _statuses(series) == [
            "failed",
            "failed-unavailable",
            "failed",
            "failed",
            "skipped-locked",
        ]
        rows = _rows(series)
        assert rows[1]["message"].startswith(f"{INCOMPLETE_PREFIX}truncated body (")
        assert rows[2]["message"] == DRM_MESSAGE
        assert rows[4]["message"].startswith("stopped: 3 consecutive failures (last: ")
        assert _videos(ext) == []  # the report of the failures is saved by default: test_q
        assert [len(_media_of(server, MAIN_ITEMS[n])) for n in range(1, 6)] == [1, 1, 1, 0, 0]

        page = ext.page
        assert page.locator("#failed-block").is_visible()
        assert _table_rows(page, "#failed-table") == [
            ("1", "failed"),
            ("2", "failed-unavailable"),
            ("3", "failed"),
            ("4", "failed"),
        ]
        assert _table_rows(page, "#result-table") == [("5", "skipped-locked")]
        failed_rows = page.locator("#failed-table tbody tr")
        cells = failed_rows.first.locator("td")
        assert cells.nth(0).text_content() == SERIES_NAME
        assert cells.nth(1).text_content() == "E01"
        assert cells.nth(2).locator(".badge").get_attribute("data-status") == "failed"
        assert failed_rows.nth(1).locator(".badge").text_content() == "unavailable"
        assert failed_rows.nth(3).locator(".badge").text_content() == "stopped"
        assert page.locator("#failed-heading").text_content() == "Did not download (4)"
        retry = page.locator("#retry-button")
        assert retry.is_visible() and retry.is_enabled()
        assert retry.text_content() == "Retry the episodes that did not download (4)"
        history = page.locator("#history-list li")
        ext.wait_for(lambda: history.count() == 1, 10, "the run is not in the history yet")
        assert history.first.locator(".retry-line span").text_content() == (
            "Did not download: E01, E02, E03, E04"
        )
        assert history.first.locator("button.retry").text_content() == (
            "Retry the episodes that did not download (4)"
        )

        pages = len(server.series_page_requests)
        entry = ext._run("#retry-button", 90)
        assert entry["kind"] == "selection" and entry["label"] == f"Retry 4 of {SERIES_NAME}"
        (retried,) = entry["series"]
        assert [(row["number"], row["status"]) for row in retried["rows"]] == [
            (1, "failed"),
            (2, "skipped-locked"),
            (3, "failed"),
            (4, "failed"),
        ]
        assert _rows(retried)[2]["message"] == DRM_REMEMBERED_MESSAGE
        assert _rows(retried)[4]["message"].startswith(f"{INCOMPLETE_PREFIX}truncated body (")
        assert entry["stopped"] == "3 consecutive failures"
        assert len(server.series_page_requests) == pages + 1  # listed again, right before
        assert [len(_media_of(server, MAIN_ITEMS[n])) for n in range(1, 6)] == [2, 1, 2, 1, 0]
        assert _videos(ext) == []
        assert page.locator("#failed-block").is_visible()
        assert _table_rows(page, "#failed-table") == [
            ("1", "failed"),
            ("3", "failed"),
            ("4", "failed"),
        ]
        assert _table_rows(page, "#result-table") == [("2", "skipped-locked")]
        assert page.locator("#failed-heading").text_content() == "Did not download (3)"
        assert retry.is_enabled()
        assert retry.text_content() == "Retry the episodes that did not download (3)"
        ext.wait_for(lambda: history.count() == 2, 10, "the retry is not in the history yet")
        assert history.first.locator(".retry-line span").text_content() == (
            "Did not download: E01, E03, E04"
        )


def test_q_a_report_of_the_episodes_that_did_not_download_is_saved(tmp_path: Path) -> None:
    """The same failing run as test_p (**Download all**: a batch, so the locked episode has a row
    too), with a session cookie set: at its end exactly one report is saved as
    `DramaFetch/reports/<Series> - did not download <date time>.json` — a JSON document with the
    job, the series, every episode that did not download (the failed ones and the locked one)
    with its probable cause and the attempts the downloader made (hosts, HTTP statuses, sizes;
    never a query string), the raw list item TikTok served, no reference row (nothing downloaded)
    — and never the cookie's value nor its name; the page says so, and the **Save the report**
    button is enabled. With the setting turned off the retry (a selection job) saves no report;
    the button then saves the retry's one."""
    drm = frozenset({(SERIES_ID, 2)})
    with (
        FakeTikTok(truncate_media=True, drm_media=drm) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        ext.add_session_cookie(SESSION_VALUE)  # so that the privacy check means something
        entry = ext.download_all(MAIN_LINK)
        (series,) = entry["series"]
        assert _statuses(series) == [
            "failed",
            "failed-unavailable",
            "failed",
            "failed",
            "skipped-locked",
        ]
        assert server.item_list_requests[-1].logged_in  # the session reached the fake TikTok
        page = ext.page
        line = page.locator("#failed-report")
        ext.wait_for(lambda: len(_report_files(ext)) == 1, 20, "the report was not saved")
        (report_path,) = _report_files(ext)
        assert _REPORT_NAME_RE.match(report_path.name), report_path.name
        assert "(" not in report_path.name  # the first report: no uniquify suffix
        assert _videos(ext) == []
        text = (ext.downloads / report_path).read_text(encoding="utf-8")
        assert SESSION_VALUE not in text and "sessionid" not in text
        report = json.loads(text)
        assert report["dramafetch_report"] == 1
        assert report["test_mode"] is True
        assert report["job"]["kind"] == "batch" and report["job"]["label"]
        assert report["job"]["stopped"] == "3 consecutive failures"
        (reported,) = report["series"]
        assert reported["series_id"] == SERIES_ID and reported["name"] == SERIES_NAME
        assert reported["listed"] == 5
        assert reported["access_counts"] == {"free": 4, "unlocked": 0, "locked": 1}
        assert reported["reference"] is None  # nothing downloaded to compare with
        rows = {row["number"]: row for row in reported["not_downloaded"]}
        assert [row["number"] for row in reported["not_downloaded"]] == [1, 2, 3, 4, 5]
        assert [rows[n]["status"] for n in range(1, 6)] == _statuses(series)
        assert len(report["summary"]) == 5
        assert report["summary"][0].startswith(f"E01 failed — {INCOMPLETE_PREFIX}truncated body (")
        assert " — probable cause: the transfer was cut short (" in report["summary"][0]

        # E01: one truncated transfer — Chromium's network stack checks the Content-Length itself
        # and drops the transfer (`ERR_CONTENT_LENGTH_MISMATCH`) before the body reaches the page,
        # so no byte count: the announced size, the host, never the signed query
        (attempt,) = rows[1]["attempts"]
        assert rows[1]["attempted"] is True
        assert attempt["requested"] is True and attempt["http_status"] == 200
        assert attempt["content_length"] == 128 * 1024 and attempt["received_bytes"] is None
        assert attempt["outcome"] == "truncated body (the transfer was cut short)"
        assert attempt["content_type"] == "video/mp4" and attempt["redirect_hops"] == 0
        assert "?" not in attempt["url"] and attempt["host"] == "127.0.0.1"
        assert attempt["url"].startswith(f"{server.base_url}/cdn/{MAIN_ITEMS[1]}/")
        assert rows[1]["message"].startswith(f"{INCOMPLETE_PREFIX}truncated body (")
        assert rows[1]["probable_cause"].startswith("the transfer was cut short (")
        assert rows[1]["raw"]["id"] == MAIN_ITEMS[1]
        # E02: the encrypted body, refused at once
        (attempt,) = rows[2]["attempts"]
        assert attempt["outcome"] == "encrypted (DRM)" and attempt["http_status"] == 200
        assert rows[2]["message"] == DRM_MESSAGE
        assert rows[2]["probable_cause"].startswith("encrypted media (DRM)")
        # E04: the stop came first — nothing asked
        assert rows[4]["status"] == "failed"
        assert rows[4]["message"].startswith("stopped: ")
        assert rows[4]["attempts"] == [] and rows[4]["attempted"] is False
        assert rows[4]["probable_cause"].startswith("not attempted")
        # E05: locked in the list, never attempted, its list item as served
        assert rows[5]["status"] == "skipped-locked" and rows[5]["attempted"] is False
        assert rows[5]["attempts"] == [] and rows[5]["access"] == "locked"
        assert rows[5]["lock_hints"] and rows[5]["raw"]["id"] == MAIN_ITEMS[5]
        assert rows[5]["probable_cause"].startswith("listed as locked for this session: ")
        # the page: the file's name, the button
        assert line.is_visible()
        assert line.text_content() == f"Report saved: {report_path.name}"
        report_button = page.locator("#report-button")
        assert report_button.is_visible() and report_button.is_enabled()
        assert report_button.text_content() == "Save the report"

        # the setting off: the retry saves no report, the button saves the retry's
        page.click("#settings-card > summary")
        assert page.locator("#setting-report").is_checked()  # on by default
        page.uncheck("#setting-report")
        page.click("#settings-save")
        ext.wait_for(
            lambda: page.locator("#settings-status").text_content() == "Settings saved.",
            10,
            "the settings were not saved",
        )
        assert ext.storage("settings")["settings"]["report"] is False
        retry = ext._run("#retry-button", 90)
        assert retry["kind"] == "selection" and retry["stopped"] == "3 consecutive failures"
        assert len(_report_files(ext)) == 1  # no new report
        assert line.is_hidden()  # this job's line: nothing was saved
        assert report_button.is_enabled()
        report_button.click()
        ext.wait_for(lambda: len(_report_files(ext)) == 2, 20, "the report was not saved")
        second = [path for path in _report_files(ext) if path != report_path]
        (second_path,) = second
        assert _REPORT_NAME_RE.match(second_path.name), second_path.name
        assert line.is_visible()
        assert line.text_content() == f"Report saved: {second_path.name}"
        retried = json.loads((ext.downloads / second_path).read_text(encoding="utf-8"))
        assert [row["number"] for row in retried["series"][0]["not_downloaded"]] == [1, 2, 3, 4]
        assert retried["series"][0]["not_downloaded"][1]["status"] == "skipped-locked"
        assert retried["job"]["kind"] == "selection"
        assert retried["job"]["label"] == f"Retry 4 of {SERIES_NAME}"
        assert SESSION_VALUE not in json.dumps(retried) and "sessionid" not in json.dumps(retried)
        assert ext.saved_files() == sorted([report_path, second_path])  # still no video
