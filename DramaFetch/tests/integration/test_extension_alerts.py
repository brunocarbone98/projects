"""The alerts of DramaFetch for Chrome (1.7.0), end to end (`pytest -m integration`; skipped
without a browser): one notification per drama a download job finishes — the owner's request of
2026-11-19 —, made by the DramaFetch tab and answered by the extension's service worker.

A real headless Chromium loads the extension's TEST copy (`extension_harness.ExtensionHarness`)
against the fake TikTok server, every notification the DramaFetch tab asks Chrome for recorded on
its way (`extension_alerts.RECORD_ALERTS_JS`):

- (a) a paste of two dramas: each drama, as it is done, gets its `✓ <drama> — downloaded`, its
  episodes on disk and its locked one in the report line's words, shown by Chrome
  (`chrome.notifications.getAll()` lists it), with the extension's own icon by its absolute
  address, no button, no context line and no web address; a click on one's body, dispatched to
  the service worker's own listener, brings the DramaFetch tab to the front — no job, no reload,
  no request — and takes that notification away;
- (b) an episode a paste could not save (its first transfer cut short, `truncate_once`; the
  automatic retry of 1.8.0 turned off first, so that the path proven is the user's own): shown
  apart with **Retry**, the records saying it failed, and the drama's notification `⚠ <drama> — 1
  episode to retry` / `E02 did not download.` with one button, **Retry**. That button, clicked as
  Chrome hands it to the service worker (its own `onButtonClicked` listener), goes to the page,
  which queues the tab's own retry of that episode and takes the notification away: the episode
  saved byte for byte as a clean paste of the drama saves it, the records whole, and the drama's
  notification `✓ … — downloaded`.

Both lived in the library's scenarios until DramaFetch 4.0.0 removed the library (the owner's
decision of 2026-11-27): an alert, its click and its **Retry** are the same whatever queued the
download. No cookie value is set, printed or asserted on; nothing reaches TikTok.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from dramafetch.media import INCOMPLETE_PREFIX

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
    EPISODE_OF_ITEM,
    SECOND_SERIES_ID,
    SECOND_SERIES_NAME,
    SERIES_ID,
    SERIES_NAME,
    FakeTikTok,
)

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not CHROMIUM.is_file(), reason=f"no Chromium at {CHROMIUM} (set DRAMAFETCH_CHROMIUM)"
    ),
]

MAIN_LINK = f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1"
SECOND_LINK = f"https://www.tiktok.com/shortdrama/episode/{SECOND_SERIES_ID}/1"
#: The address of the tab in front, as the extension sees it.
ACTIVE_TAB_JS = (
    "async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))"
    ".map((tab) => tab.url)"
)


def _rows(entry: dict[str, Any]) -> list[tuple[str, list[tuple[int, str, str]]]]:
    """A journal entry's series and rows: `(series id, [(number, status, message)])`."""
    return [
        (
            series["series_id"],
            [(row["number"], row["status"], row["message"]) for row in series.get("rows", [])],
        )
        for series in entry["series"]
    ]


def _saved(ext: ExtensionHarness) -> dict[str, bytes]:
    """Every file saved under the download directory: its path there and its bytes."""
    return {str(path): (ext.downloads / path).read_bytes() for path in ext.saved_files()}


def _cdn_asked(server: FakeTikTok, episode: tuple[str, int]) -> int:
    """How many times the fake CDN was asked for `episode` (series id, number)."""
    return sum(
        1
        for request in server.requests
        if (match := CDN_PATH_RE.match(request.path)) is not None
        and EPISODE_OF_ITEM.get(match.group("id")) == episode
    )


def test_a_each_drama_done_gets_its_alert_and_a_click_on_one_brings_the_tab_back(
    tmp_path: Path,
) -> None:
    """(a) A paste of two dramas — ONE batch job —: each drama, as it is done, gets its
    notification, `✓ <drama> — downloaded` with what is on disk and the locked episode in the report
    line's words, which Chrome shows (`getAll()` lists it): the extension's own icon by its
    absolute address, no button, no context line, no web address. Another tab in front, a click on
    the first one's body — as Chrome hands it to the service worker — brings the DramaFetch tab to
    the front as it is (no job, no reload, no request) and takes that notification away."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        entry = ext.paste_and_wait(f"{MAIN_LINK}\n{SECOND_LINK}", timeout_s=120)
        assert (entry["kind"], entry["label"]) == ("batch", "2 series")
        assert [series_id for series_id, _ in _rows(entry)] == [SERIES_ID, SECOND_SERIES_ID]
        alerts = recorded_alerts(ext, 2)
        assert len(page.evaluate(ALERTS_JS)) == 2  # one per drama, nothing more
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

        # another tab in front; a click on the first alert's body: the worker brings the DramaFetch
        # tab forward as it is and takes the notification away — nothing else
        other_url = f"{server.base_url}/login"
        other = ext.context.new_page()
        other.goto(other_url)
        other.bring_to_front()
        ext.wait_for(lambda: page.evaluate(ACTIVE_TAB_JS) == [other_url], 10, "no other tab")
        before, jobs, tabs = len(server.requests), ext.finished_jobs(), len(ext.tab_urls())
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
        assert len(server.requests) == before  # nothing asked of the fake TikTok


def test_b_an_alert_s_retry_after_a_plain_failure_retries_it_as_the_tab_s_retry_does(
    tmp_path: Path,
) -> None:
    """(b) The second drama pasted, the fake cutting the first transfer of its episode 2 short
    (`truncate_once`), the automatic retry turned off first — the manual path is what this proves
    (`test_extension_autoretry.py` has the automatic one): episodes 1 and 3 saved, episode 2 shown
    apart — **Did not download (1)** with its **Retry** —, the records saying it failed, and its
    notification `⚠ … — 1 episode to retry` / `E02 did not download.` with ONE button, **Retry**,
    and no context line. That button, clicked as Chrome hands the click to the service worker, is
    handed to the DramaFetch tab, which queues one selection job over that episode alone — the
    tab's own **Retry** — and takes the notification away: the episode requested once more, saved
    whole with its cover embedded — byte for byte what a clean paste of the drama saves in another
    profile —, the block gone, the records whole (the other episodes' downloads untouched) and the
    drama's notification `✓ … — downloaded`."""
    second = (SECOND_SERIES_ID, 2)
    with (
        FakeTikTok(truncate_once=frozenset({second})) as server,
        ExtensionHarness(tmp_path / "pasted", server.base_url) as ext,
    ):
        ext.turn_off_auto_retry()  # the manual Retry is what this scenario proves
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        first = ext.paste_and_wait(SECOND_LINK, timeout_s=120)
        assert first["kind"] == "batch"
        ((series_id, rows),) = _rows(first)
        assert series_id == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in rows] == [
            (1, "done"),
            (2, "failed"),
            (3, "done"),
        ]
        assert rows[1][2].startswith(f"{INCOMPLETE_PREFIX}truncated body (")
        assert _cdn_asked(server, second) == 1
        assert [entry["label"] for entry in ext.journal()] == [first["label"]]  # nothing queued
        assert page.locator("#failed-block").is_visible()
        assert page.locator("#failed-heading").text_content() == "Did not download (1)"
        assert page.locator("#failed-auto").is_hidden()  # nothing retried on its own
        retry = page.locator("#retry-button")
        assert retry.is_visible() and retry.is_enabled()
        assert retry.text_content() == "Retry the episodes that did not download (1)"
        records = ext.wait_for_records(SECOND_SERIES_ID, {1: "done", 2: "failed", 3: "done"})
        assert records[2]["message"] == rows[1][2] and records[2]["download_id"] is None
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
        assert (entry["kind"], entry["label"]) == ("selection", f"Retry 1 of {SECOND_SERIES_NAME}")
        ((series_id, rows),) = _rows(entry)
        assert series_id == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in rows] == [(2, "done")]
        assert rows[0][2].endswith(" + cover embedded")
        assert _cdn_asked(server, second) == 2  # requested once more, now whole
        assert page.locator("#failed-block").is_hidden()
        healed = ext.wait_for_records(SECOND_SERIES_ID, {1: "done", 2: "done", 3: "done"})
        assert healed[2]["message"] == rows[0][2] and isinstance(healed[2]["download_id"], int)
        assert [healed[n]["download_id"] for n in (1, 3)] == [
            records[n]["download_id"] for n in (1, 3)
        ]
        _first, done = recorded_alerts(ext, 2)  # the retry's own drama, now whole
        assert done["id"].endswith(f":{SECOND_SERIES_ID}:complete")
        assert (done["options"]["title"], done["options"]["message"]) == (
            f"✓ {SECOND_SERIES_NAME} — downloaded",
            "All 3 episodes are on disk.",
        )
        assert "contextMessage" not in done["options"]  # the user's own retry
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
