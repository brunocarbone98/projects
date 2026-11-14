"""The StreamFetch tab end to end (spec 6 and 9): Chrome in Spanish (`LANGUAGE=es`, how Chrome on
Linux picks its UI language) shows statuses, failure messages, the note of a file saved without
its cover (B.2) and the failed block in Spanish; a
second StreamFetch tab is read-only while the first holds the engine; **Retry** re-runs exactly
the inputs that did not download; **Stop** ends the run and marks the rest stopped; the page
shows its version and the legal notice; Chrome itself holds the two right-click items the worker
puts in place at install (**Download this video** on a video link, **Download this page's video**
on a video page); a link handed to the worker (the popup's **Download this video**, the
right-click) joins the engine's box, or reloads a StreamFetch tab whose page took nothing."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import pytest

from e2e_checks import NEEDS_CHROMIUM, assert_sequential
from extension_harness import ExtensionHarness, matches_message
from fake_sites import BILI_MAIN, DM_SHORT_ID, DM_TS_ID, FakeSites
from media_fixtures import MediaSet

pytestmark = [NEEDS_CHROMIUM]

DM = "https://www.dailymotion.com/video/{}"
BILI = "https://www.bilibili.com/video/{}"
GEO = "xgeo7b1"
DELETED = "BV1De7L1eT4d"
#: Spec 12, verbatim (the English notice of the app footer).
LEGAL_NOTICE = (
    "StreamFetch is a personal tool for saving, for your own offline viewing, videos that "
    "Dailymotion and Bilibili already play in your own browser session. It never bypasses DRM, "
    "paywalls, geo-restrictions, logins or any other access control, and it does not hide that "
    "it is a download tool. Downloading may be restricted by the sites' terms of service and by "
    "copyright law in your country; you are responsible for how you use it. Not affiliated with "
    "Dailymotion or Bilibili."
)
#: Whether each menu item exists, through Chrome itself: an update that changes nothing succeeds
#: for an item the extension created and fails for any other id (`chrome.runtime.lastError`).
MENU_ITEMS_JS = """async (ids) => {
  const found = [];
  for (const id of ids) {
    found.push(await new Promise((resolve) => chrome.contextMenus.update(id, {}, () =>
      resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : "ok"))));
  }
  return found;
}"""
MENU_IDS = ["streamfetch-download-link", "streamfetch-download-page"]
_PLACEHOLDER = re.compile(r"\$[A-Za-z0-9_@]+\$|\$\d")


def _status_key(status: str) -> str:
    """`status_<status>` as a `_locales` name (Chrome allows no `-` in one)."""
    return "status_" + status.replace("-", "_")


def _has_words(message: str) -> bool:
    return bool(re.search(r"[A-Za-zÀ-ÿ]{2,}", _PLACEHOLDER.sub("", message)))


def _assert_spanish(text: str, es: dict[str, str], en: dict[str, str]) -> None:
    """`text` is one of the Spanish messages (placeholders filled in) and none of the English
    ones that differ from their Spanish translation."""
    assert text, "empty text"
    spanish = [m for m in es.values() if _has_words(m)]
    assert any(matches_message(text, message) for message in spanish), f"not Spanish: {text!r}"
    english = [m for name, m in en.items() if _has_words(m) and m != es.get(name)]
    assert not any(matches_message(text, message) for message in english), f"English: {text!r}"


def _literal_chunks(message: str) -> list[str]:
    return [chunk.strip() for chunk in _PLACEHOLDER.split(message) if len(chunk.strip()) >= 4]


def test_the_page_shows_its_version_and_the_legal_notice(media: MediaSet, tmp_path: Path):
    with FakeSites(media) as sites, ExtensionHarness(tmp_path, sites) as ext:
        manifest = json.loads((ext.extension_dir / "manifest.json").read_text(encoding="utf-8"))
        assert manifest["version"] == "1.1.0"
        assert manifest["version"] in ext.text("#version")
        assert ext.text("#legal-notice") == LEGAL_NOTICE
        assert sites.requests == []  # opening the tab asks nothing of the sites


def test_the_right_click_items_are_in_chromes_menu(media: MediaSet, tmp_path: Path):
    """The right-click **Download this video** (`menus.js`): Chrome took both items the worker puts
    in place at install, so their contexts and match patterns are valid (a bad one makes
    `chrome.contextMenus.create` fail and leaves no item), and an id the extension never created is
    refused, so the check can fail. Playwright cannot open Chrome's own menu: a click is
    `linkOfClick` (`extension/tests/menus.test.js`, the worker's wiring too) handed to `openApp`,
    the popup's path."""
    with FakeSites(media) as sites, ExtensionHarness(tmp_path, sites) as ext:
        ext.wait_for(
            lambda: ext.page.evaluate(MENU_ITEMS_JS, MENU_IDS) == ["ok", "ok"],
            10,
            "the right-click items are not in Chrome's menu",
        )
        [missing] = ext.page.evaluate(MENU_ITEMS_JS, ["streamfetch-no-such-item"])
        assert missing != "ok"
        assert "streamfetch-no-such-item" in missing
        assert sites.requests == []  # putting the menu in place asks nothing of the sites


def test_a_link_handed_over_joins_the_engines_box_or_reloads_a_tab_nobody_runs(
    media: MediaSet, tmp_path: Path
):
    """What the popup's **Download this video** sends (`streamfetch:open`), and what the
    right-click hands to the same `openApp` in the worker: the worker hands the link to the
    engine's tab, which appends it to its box after the links already there and answers; no other
    tab opens, nothing is requested before **Analyze**. With no page taking it — here a read-only
    tab left alone once the engine's tab is closed — the open tab reloads with the link in its
    address (`app.html?links=`) and takes the engine."""
    with FakeSites(media) as sites, ExtensionHarness(tmp_path, sites) as ext:
        sender = ext.context.new_page()  # an extension page sends what the popup sends
        sender.goto(f"chrome-extension://{ext.extension_id}/src/app/popup.html")
        open_js = "(links) => chrome.runtime.sendMessage({type: 'streamfetch:open', links})"
        app_tabs_js = (
            "async (url) => (await chrome.runtime.getContexts({contextTypes: ['TAB']}))"
            ".filter((context) => context.documentUrl.startsWith(url)).length"
        )
        typed, first, second_link = (
            DM.format(DM_TS_ID),
            DM.format(DM_SHORT_ID),
            BILI.format(BILI_MAIN),
        )
        ext.paste(typed)
        assert sender.evaluate(open_js, first) == {"ok": True}
        ext.wait_for(
            lambda: ext.page.input_value("#links") == f"{typed}\n{first}",
            10,
            "the link did not join the engine's box",
        )
        assert sender.evaluate(app_tabs_js, ext.app_url) == 1

        second = ext.open_app_tab()
        ext.wait_for(
            lambda: second.is_visible("#readonly-banner"), 10, "the second tab is writable"
        )
        ext.page.close()  # the engine's tab is gone: the read-only one, left alone, takes nothing
        assert sender.evaluate(open_js, second_link) == {"ok": True}
        ext.wait_for(
            lambda: (
                not second.is_visible("#readonly-banner")
                and second.input_value("#links") == second_link
            ),
            20,
            "the read-only tab did not reload with the link",
        )
        assert second.evaluate("document.querySelector('#app-status').dataset.state") == "idle"
        assert sender.evaluate(app_tabs_js, ext.app_url) == 1
        assert sites.requests == []  # nothing is requested until Analyze or Download all


def test_the_spanish_ui_shows_statuses_failures_and_the_failed_block_in_spanish(
    media: MediaSet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("LANGUAGE", "es")  # Chrome on Linux takes its UI language from it
    with (
        FakeSites(media, dm_geo_blocked=frozenset({GEO}), cover_status=((DM_TS_ID, 404),)) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        es, en = ext.messages("es"), ext.messages("en")
        ext.download_all(f"{DM.format(GEO)}\n{DM.format(DM_TS_ID)}")
        geo, done = ext.row_of(GEO), ext.row_of(DM_TS_ID)
        assert (geo.status, done.status) == ("failed-unavailable", "done")
        for row in (geo, done):
            key = _status_key(row.status)
            assert row.status_text == es[key] != en[key], (row, es.get(key), en.get(key))
        # the failure message: the Spanish template, filled in; no English text
        template = es["failure_geo_blocked"]
        assert template != en["failure_geo_blocked"]
        chunks = _literal_chunks(template)
        assert chunks and all(chunk in geo.message for chunk in chunks), (geo.message, template)
        assert "not available in your country" not in geo.message
        # a done row saved without its cover (a 404 on it, B.2): the note in Spanish too
        assert "; " in done.message and "cover:" not in done.message, done.message
        _assert_spanish(done.message.rsplit("; ", 1)[-1], es, en)
        # the failed block, its buttons and the report line
        for selector in ("#failed-heading", "#retry-button", "#report-button"):
            _assert_spanish(ext.text(selector), es, en)
        ext.wait_for(lambda: ext.text("#failed-report"), 15, "no report line")
        _assert_spanish(ext.text("#failed-report"), es, en)
        (failed,) = ext.failed_rows()
        assert failed.status == "failed-unavailable"
        assert failed.status_text == es[_status_key("failed-unavailable")]
        # the legal notice in Spanish, not the English one
        assert ext.text("#legal-notice") and ext.text("#legal-notice") != LEGAL_NOTICE
        # the report stays English (message_en), whatever the UI language
        (path,) = ext.wait_reports(1)
        (row,) = json.loads(path.read_text(encoding="utf-8"))["not_downloaded"]
        assert "not available in your country" in row["message_en"]


def test_a_second_streamfetch_tab_is_read_only(media: MediaSet, tmp_path: Path):
    with FakeSites(media) as sites, ExtensionHarness(tmp_path, sites) as ext:
        second = ext.open_app_tab()
        ext.wait_for(
            lambda: not ext.enabled("#download-all-button", second),
            10,
            "the second tab can start a download",
        )
        assert not ext.enabled("#analyze-button", second)
        # even a forced click there — the buttons enabled by hand, so the clicks reach the page's
        # own handlers (a disabled button swallows a click) — starts nothing
        second.evaluate(
            "(link) => { document.querySelector('#links').value = link;"
            " for (const id of ['#download-all-button', '#analyze-button']) {"
            " const button = document.querySelector(id);"
            " button.disabled = false; button.click(); } }",
            DM.format(DM_SHORT_ID),
        )
        # the first tab holds the engine and works; its whole run is the window in which a run
        # started by the second tab would have asked for the second tab's link
        ext.download_all(DM.format(DM_TS_ID))
        assert ext.row_of(DM_TS_ID).status == "done"
        assert sites.about(DM_SHORT_ID) == [], "the second tab started a run"
        assert second.evaluate("document.querySelector('#app-status').dataset.state") == "readonly"
        assert ext.rows(second) == [], "the second tab resolved something"
        assert second.is_visible("#readonly-banner")


def test_retry_runs_again_exactly_the_inputs_that_did_not_download(media: MediaSet, tmp_path: Path):
    with (
        FakeSites(
            media, dm_geo_blocked=frozenset({GEO}), bili_deleted=frozenset({DELETED})
        ) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(f"{DM.format(GEO)}\n{DM.format(DM_TS_ID)}\n{BILI.format(DELETED)}")
        assert [ext.row_of(v).status for v in (GEO, DM_TS_ID, DELETED)] == [
            "failed-unavailable",
            "done",
            "failed-unavailable",
        ]
        summary = ext.text("#summary-line")
        assert re.search(r"\b3 videos\b", summary) and re.search(r"\b2 failed\b", summary), summary
        assert len(ext.failed_rows()) == 2
        assert "(2)" in ext.text("#retry-button") or "2" in ext.text("#failed-heading")

        # the causes are gone; Retry asks for those two only
        sites.set_options(dm_geo_blocked=frozenset(), bili_deleted=frozenset())
        sites.clear_log()
        ext.retry()
        asked = sites.site_requests()
        assert asked, "Retry asked nothing"
        retried = {id(r) for r in sites.about(GEO) + sites.about(DELETED)}
        assert all(id(r) in retried for r in asked), [r.path for r in asked]
        assert sites.about(DM_TS_ID) == []
        assert ext.row_of(GEO).status == "done"
        assert all(row.status == "done" for row in ext.rows_of(DELETED))
        assert len(ext.wait_saved(3)) == 3
        assert ext.failed_rows() == []
        assert_sequential(asked)


def test_stop_ends_the_current_request_and_marks_the_rest_stopped(media: MediaSet, tmp_path: Path):
    with FakeSites(media, media_delay_s=1.5) as sites, ExtensionHarness(tmp_path, sites) as ext:
        ext.paste(f"{DM.format(DM_TS_ID)}\n{BILI.format(BILI_MAIN)}")
        mark = ext.start("#download-all-button")
        ext.wait_for(
            lambda: any("/seg" in path for path in sites.started_paths()),
            60,
            "no media request started",
        )
        ext.page.click("#stop-button")
        ext.finish(mark, 30)
        assert [ext.row_of(DM_TS_ID).status] + [r.status for r in ext.rows_of(BILI_MAIN)] == [
            "stopped",
            "stopped",
        ]
        assert sites.about(BILI_MAIN) == []
        count = len(sites.site_requests())
        time.sleep(2)
        assert len(sites.site_requests()) == count, "requests went on after Stop"
        assert ext.saved_files() == []
        assert ext.cooldown() is None  # Stop is no refusal: no cooldown
