"""The automatic removal from the Favorites of DramaFetch 2.0.0 for Chrome, end to end (`pytest -m
integration`; skipped without a browser): the owner's decision of 2026-11-22 — "make the dramas
leave the bookmarks once every episode is downloaded, the ones that had to be retried included".

A real headless Chromium loads the extension's TEST copy (`extension_harness.ExtensionHarness`)
against the fake TikTok server, whose favorites are the server's own list
(`FakeTikTok.favorite_ids`) and whose drama pages carry a Bookmark button shaped like TikTok's,
with the settings' defaults —
**Remove a drama from my Favorites once all its episodes are downloaded**, **Retry on its own what
did not download** and **Alert me when a drama finishes** on —, every notification the DramaFetch
tab asks Chrome for recorded on its way (`extension_alerts.RECORD_ALERTS_JS`):

- (a) a paste of a drama the library holds (listed from the fake profile by the popup's **Open my
  library**): every episode downloads, then — after the rest between jobs — ONE removal job,
  `Remove “<drama>” from your Favorites (automatic)`, presses the drama page's own Bookmark once
  (one `collect` request, the page's own `action`), the reload shows it off, the background tab is
  closed, the fake's list loses it, the card says **Removed from your Favorites**, TikTok's new
  count comes from ONE first-page request of the profile tab, the journal's `bookmark.outcome` is
  `removed`, and the drama's `✓ … — downloaded` notification is replaced (the same id) by `✓ … —
  removed from your Favorites` / `Every episode is on disk.`;
- (b) an episode the fake cuts short once (`truncate_once`): the paste's job fails it, its automatic
  retry saves it, and only then the removal runs — the journal reads the batch, the automatic
  retry, the removal; one `collect`; `↻`, `✓ … — downloaded`, `✓ … — removed from your Favorites`
  under one id. The library was kept with no whole read (`keep_library`) and a selection sets no
  complete mark: what vouches for the count is when the retry found the drama complete;
- (c) a drama with a locked episode (the main series, its fifth): complete, yet no removal job —
  the account may unlock it later;
- (d) the setting unticked: a complete drama of the library is downloaded and stays a favorite;
- (e) a drama the library does not hold: downloaded, never removed;
- (f) **Stop** while the batch's second drama downloads, the first one's automatic removal waiting:
  out of the queue at once — the library's status line says so —, it never runs;
- (g) a fake that answers the press like TikTok but keeps the drama (`collect_ignored`): the
  automatic removal ends `not-kept` — a stop, never a second click —, the download queued behind it
  ends unstarted, the library's status line says the automatic removals halt until the tab is
  reloaded, its notification is `⚠ … — still in your Favorites` with the reason, and a later
  download of a complete drama queues no removal;
- (j) (b) for a drama TikTok's favorites list gives no episode count for: the automatic retry
  completes it with no complete mark, and the removal's gate checks the records against the count
  of the list the retry read — the drama leaves the Favorites all the same;
- (k) a paste of the main series — its E02 cut short twice: the batch and its automatic retry both
  fail it — and the second drama, saved whole: the batch, the retry, then the second drama's
  automatic removal, which leaves the progress card as it is — the retry's **Did not download**
  block with its **Retry** and the line of its report saved stay while the removal runs and after
  it ends;
- (l) a removal whose turn comes more than 24 hours after its drama was found complete: the second
  drama, on disk with a complete mark just under 24 hours old, pasted with the main series — its
  paste skips it as complete, the main series keeps its removal waiting past the mark's 24 hours —:
  the removal presses nothing and queues ONE re-listing of the drama (`not removed yet: …`); the
  drama, pasted again while that re-listing rests, is queued behind it as a job of its own; the
  re-listing lists it again, finds it complete and queues the removal NEXT, ahead of that paste:
  it presses once, then the paste skips the drama as complete — the drama leaves the fake's
  favorites, one `collect`, the drama's page three times, no `⚠` notification.

The other two scenarios of the 2.0.0 release are in `test_extension_ui.py`: (h) the **Waiting**
card of two pastes, and (i) a pause of a minute or more read in minutes and seconds.

No cookie value is set, printed or asserted on; nothing reaches TikTok.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from .extension_alerts import ALERTS_JS, RECORD_ALERTS_JS, recorded_alerts
from .extension_harness import CHROMIUM, ExtensionHarness
from .fake_tiktok import (
    CDN_PATH_RE,
    COLLECT_PATH,
    COVER_PATH_RE,
    DRAMA_LIST_PATH,
    EPISODE_OF_ITEM,
    FAVORITES,
    PROFILE_PATH,
    SECOND_SERIES_ID,
    SECOND_SERIES_NAME,
    SERIES_ID,
    SERIES_NAME,
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

MAIN_LINK = f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1"
SECOND_LINK = f"https://www.tiktok.com/shortdrama/episode/{SECOND_SERIES_ID}/1"
#: Looking at the drama's page often, and waiting a short while for the Bookmark to turn off.
SETTINGS: dict[str, Any] = {"bookmarkPollS": 0.1, "bookmarkWaitS": 3}
#: The label of DramaFetch's own removal of the second drama.
AUTO_LABEL = f"Remove “{SECOND_SERIES_NAME}” from your Favorites (automatic)"
#: Its row in the Waiting card (2.0.0: what it is, the drama's name, its whole id).
AUTO_ROW = f"Remove from Favorites (automatic) — {SECOND_SERIES_NAME} · {SECOND_SERIES_ID}"
#: What the library's status line adds once a removal TikTok did not keep halted the automatic ones.
HALTED_LINE = (
    "TikTok did not keep a removal, or refused one: DramaFetch removes no more dramas from your "
    "Favorites on its own until you reload this tab. Remove from Favorites on a card still works."
)
#: In the DramaFetch tab: the progress card as each change leaves it — `[#progress-current,
#: #failed-block hidden, #failed-heading, #failed-auto, #retry-button disabled]` — in
#: `globalThis.__progressLog`: a `MutationObserver`, whose callback runs right after each change,
#: before the page goes on to the next job. Nothing else changes.
RECORD_PROGRESS_JS = """() => {
  if (globalThis.__progressLog !== undefined) return;
  const log = [];
  globalThis.__progressLog = log;
  const byId = (id) => document.getElementById(id);
  const note = () => {
    const now = [
      byId("progress-current").textContent,
      byId("failed-block").hidden,
      byId("failed-heading").textContent,
      byId("failed-auto").textContent,
      byId("retry-button").disabled,
    ];
    const last = log.at(-1);
    if (last === undefined || now.some((value, index) => value !== last[index])) log.push(now);
  };
  note();
  new MutationObserver(note).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
}"""
#: What the worker kept of a TikTok tab's favorites list (`chrome.storage.session`), or null.
TEMPLATE_JS = "async (key) => (await chrome.storage.session.get(key))[key] ?? null"
#: The outcome of DramaFetch's own removal whose episode count was more than 24 hours old at its
#: turn: it queued a re-listing of its drama in its place (2.0.0).
RELISTED = (
    "not removed yet: its episode count was more than 24 hours old — DramaFetch lists the drama "
    "again first, then removes it"
)
#: The label of the re-listing of the second drama.
RELIST_LABEL = f"List “{SECOND_SERIES_NAME}” again, then remove it from your Favorites (automatic)"
#: In the DramaFetch tab: a series' stored records (`key`) with their complete mark set to `at` (an
#: ISO time, as the extension writes it), nothing else changed; their complete episodes.
COMPLETE_MARK_JS = """async ([key, at]) => {
  const state = (await chrome.storage.local.get(key))[key];
  state.complete_at = at;
  await chrome.storage.local.set({ [key]: state });
  return state.complete_episodes;
}"""
TAB_IDS_JS = (
    "async (prefix) => (await chrome.tabs.query({}))"
    ".filter((tab) => (tab.url || tab.pendingUrl || '').startsWith(prefix)).map((tab) => tab.id)"
)


def _open_library(ext: ExtensionHarness, base_url: str) -> None:
    """The user's profile in a tab of its own, its Favorites → Drama shown (the worker keeps the
    page's own first `drama_list` request), then the popup's **Open my library** on it: every
    favorite listed into the library, the job waited for to its end."""
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
    button = popup.locator("#popup-favorites")
    ext.wait_for(button.is_visible, 10, "no Open my library on the profile")
    jobs = ext.finished_jobs()
    button.click()
    ext.wait_for(
        lambda: ext.finished_jobs() > jobs and ext.idle(), 60, "the library was not listed"
    )


def _card(page: Page, series_id: str) -> Locator:
    return page.locator(f"#favorites-grid article[data-series-id='{series_id}']")


def _rows(entry: dict[str, Any]) -> list[tuple[str, list[tuple[int, str]]]]:
    """A journal entry's series and rows: `(series id, [(number, status)])`."""
    return [
        (series["series_id"], [(row["number"], row["status"]) for row in series.get("rows", [])])
        for series in entry["series"]
    ]


def _until_jobs(ext: ExtensionHarness, count: int, timeout_s: float, what: str) -> None:
    """Wait until `count` jobs have finished in all and nothing runs or waits."""
    ext.wait_for(lambda: ext.finished_jobs() >= count and ext.idle(), timeout_s, what)


def _still_idle(ext: ExtensionHarness, jobs: int) -> None:
    """Nothing more runs or waits a second later: no job was queued behind the last one."""
    time.sleep(1.0)
    assert ext.idle()
    assert ext.finished_jobs() == jobs


def _cdn_asked(server: FakeTikTok, series_id: str) -> dict[int, int]:
    """How many times the fake CDN was asked for each episode of `series_id` it was asked for."""
    asked: dict[int, int] = {}
    for request in server.requests:
        match = CDN_PATH_RE.match(request.path)
        episode = EPISODE_OF_ITEM.get(match.group("id")) if match is not None else None
        if episode is not None and episode[0] == series_id:
            asked[episode[1]] = asked.get(episode[1], 0) + 1
    return asked


def test_a_a_pasted_drama_the_library_holds_leaves_the_favorites_once_every_episode_is_on_disk(
    tmp_path: Path,
) -> None:
    """(a) A paste of the second drama, which the library holds: every episode downloads; then —
    after the rest between jobs — ONE automatic removal presses the drama page's own Bookmark once,
    checks it after a reload, closes its tab; the fake's list loses the drama, the card says so,
    TikTok's new count comes from one first-page request; the journal's `bookmark.outcome` is
    `removed`; the drama's ✓ notification becomes `✓ … — removed from your Favorites`."""
    settings = {**SETTINGS, "restMinS": 1, "restMaxS": 1.5}  # a rest between jobs always due
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=settings) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        _open_library(ext, server.base_url)
        card = _card(page, SECOND_SERIES_ID)
        assert card.get_attribute("data-status") == "none"
        assert page.evaluate(ALERTS_JS) == []  # a listing: no notification
        lists = len(server.drama_list_requests)
        jobs = ext.finished_jobs()
        ext.paste(SECOND_LINK)
        _until_jobs(ext, jobs + 2, 120, "the download and its removal did not end")
        removal, download, _listing = ext.journal()
        # the paste's batch: every episode on disk
        assert download["kind"] == "batch"
        assert _rows(download) == [(SECOND_SERIES_ID, [(1, "done"), (2, "done"), (3, "done")])]
        assert download["series"][0]["line"] == "complete: 3 of 3 (3 downloaded)"
        # then the removal, a job of its own after the rest between jobs: one press, checked
        assert (removal["kind"], removal["label"]) == ("unbookmark", AUTO_LABEL)
        assert removal["bookmark"] == {
            "series_id": SECOND_SERIES_ID,
            "title": SECOND_SERIES_NAME,
            "outcome": "removed",
        }
        assert (removal["error"], removal["stopped"]) == (None, None)
        assert [pause["kind"] for pause in removal["pauses"]] == ["job-rest"]
        assert server.collect_requests == [(COLLECT_PATH, "0")]  # one click, the page's own action
        assert SECOND_SERIES_ID not in server.favorite_ids
        assert card.get_attribute("data-status") == "removed"
        assert card.locator(".favorite-status").inner_text() == "Removed from your Favorites"
        total = len(FAVORITES) - 1
        assert page.locator("#library-total").inner_text() == f"TikTok counts {total} dramas"
        assert len(server.drama_list_requests) == lists + 1  # the profile's first page, once
        assert not [url for url in ext.tab_urls() if "/shortdrama/" in url]  # the tab closed
        stored = ext.storage("favoritesLibrary")["favoritesLibrary"]
        assert [drama["seriesId"] for drama in stored["removed"]] == [SECOND_SERIES_ID]
        # after the download's last transfer, nothing but the drama's page twice (its own list
        # requests), the one press and the count — no media, no other drama, no other page
        log = server.requests
        last_media = max(n for n, r in enumerate(log) if CDN_PATH_RE.match(r.path))
        after = log[last_media + 1 :]
        pages = [r.path for r in after if SERIES_PATH_RE.match(r.path)]
        assert pages == [f"/shortdrama/episode/{SECOND_SERIES_ID}/1"] * 2
        others = {r.path for r in after} - {
            f"/shortdrama/episode/{SECOND_SERIES_ID}/1",
            "/api/drama/detail/",
            "/api/drama/episode/item_list/",
            COLLECT_PATH,
            DRAMA_LIST_PATH,
        }
        assert {path for path in others if not COVER_PATH_RE.match(path)} == set()
        # the notifications: ✓ downloaded, then — the same id, which Chrome replaces — removed
        downloaded, removed = recorded_alerts(ext, 2)
        assert len(page.evaluate(ALERTS_JS)) == 2
        assert downloaded["id"].endswith(f":{SECOND_SERIES_ID}:complete")
        assert downloaded["options"]["title"] == f"✓ {SECOND_SERIES_NAME} — downloaded"
        assert removed["id"] == downloaded["id"]
        assert removed["listed"] is True
        assert (removed["options"]["title"], removed["options"]["message"]) == (
            f"✓ {SECOND_SERIES_NAME} — removed from your Favorites",
            "Every episode is on disk.",
        )
        assert "buttons" not in removed["options"]
        assert "contextMessage" not in removed["options"]


def test_b_an_episode_retried_on_its_own_comes_first_then_the_drama_leaves_the_favorites(
    tmp_path: Path,
) -> None:
    """(b) E02 cut short on its first transfer: the paste's job fails it, its automatic retry saves
    it, and only then the automatic removal runs — the journal reads the batch, the automatic retry,
    the removal (`removed`); one press; the notifications `↻`, `✓ … — downloaded` (`After an
    automatic retry.`) and `✓ … — removed from your Favorites`, all under one id. The library holds
    the drama with no whole read and the retry sets no complete mark: when the retry found the drama
    complete is what lets its count count."""
    second = (SECOND_SERIES_ID, 2)
    with (
        FakeTikTok(truncate_once=frozenset({second})) as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=SETTINGS) as ext,
    ):
        ext.keep_library((SECOND_SERIES_ID, SECOND_SERIES_NAME, 3))
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        ext.paste(SECOND_LINK)
        _until_jobs(ext, jobs + 3, 180, "the download, its retry and its removal did not end")
        journal = ext.journal()
        assert len(journal) == 3  # nothing more
        removal, automatic, pasted = journal
        assert pasted["kind"] == "batch"
        assert _rows(pasted) == [(SECOND_SERIES_ID, [(1, "done"), (2, "failed"), (3, "done")])]
        assert (automatic["kind"], automatic["label"]) == (
            "selection",
            f"Automatic retry: 1 of {SECOND_SERIES_NAME}",
        )
        assert _rows(automatic) == [(SECOND_SERIES_ID, [(2, "done")])]
        assert (removal["kind"], removal["label"]) == ("unbookmark", AUTO_LABEL)
        assert removal["bookmark"]["outcome"] == "removed"
        assert removal["error"] is None
        assert _cdn_asked(server, SECOND_SERIES_ID) == {1: 1, 2: 2, 3: 1}
        assert server.collect_requests == [(COLLECT_PATH, "0")]
        assert SECOND_SERIES_ID not in server.favorite_ids
        assert _card(page, SECOND_SERIES_ID).get_attribute("data-status") == "removed"
        # the press came after the retry saved E02
        log = server.requests
        last_media = max(n for n, r in enumerate(log) if CDN_PATH_RE.match(r.path))
        assert min(n for n, r in enumerate(log) if r.path == COLLECT_PATH) > last_media
        retrying, downloaded, removed = recorded_alerts(ext, 3)
        assert len(page.evaluate(ALERTS_JS)) == 3
        assert retrying["id"].endswith(f":{SECOND_SERIES_ID}:retry")
        assert retrying["options"]["title"] == f"↻ {SECOND_SERIES_NAME} — retrying 1 episode"
        assert downloaded["id"] == retrying["id"]
        assert (downloaded["options"]["title"], downloaded["options"]["contextMessage"]) == (
            f"✓ {SECOND_SERIES_NAME} — downloaded",
            "After an automatic retry.",
        )
        assert removed["id"] == retrying["id"]
        assert (removed["options"]["title"], removed["options"]["message"]) == (
            f"✓ {SECOND_SERIES_NAME} — removed from your Favorites",
            "Every episode is on disk.",
        )


def test_c_a_drama_with_a_locked_episode_is_complete_and_stays_a_favorite(tmp_path: Path) -> None:
    """(c) The main series — its fifth episode locked — held by the library and pasted: complete,
    every episode the account may play on disk, yet no removal job: the account may unlock the
    locked one later. Its card says **On disk**, the fake's list keeps it, nothing is pressed."""
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=SETTINGS) as ext,
    ):
        ext.keep_library((SERIES_ID, SERIES_NAME, 5))
        jobs = ext.finished_jobs()
        entry = ext.paste_and_wait(MAIN_LINK, timeout_s=120)
        _still_idle(ext, jobs + 1)
        assert [job["kind"] for job in ext.journal()] == ["batch"]
        assert entry["series"][0]["line"] == "complete: 4 of 5 (4 downloaded) — 1 locked (5)"
        assert server.collect_requests == []
        assert SERIES_ID in server.favorite_ids
        card = _card(ext.page, SERIES_ID)
        ext.wait_for(lambda: card.get_attribute("data-status") == "on-disk", 10, "not on disk")
        assert not [r for r in server.requests if r.path == DRAMA_LIST_PATH]


def test_d_with_the_setting_off_a_complete_drama_stays_a_favorite(tmp_path: Path) -> None:
    """(d) **Remove a drama from my Favorites once all its episodes are downloaded** unticked: the
    second drama, held by the library, downloads whole — its `✓` notification, and no removal job,
    nothing pressed, the fake's list keeps it, its card **On disk · 3/3** with its own **Remove from
    Favorites**."""
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=SETTINGS) as ext,
    ):
        ext.keep_library((SECOND_SERIES_ID, SECOND_SERIES_NAME, 3))
        ext.turn_off_auto_remove()
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        entry = ext.paste_and_wait(SECOND_LINK, timeout_s=120)
        _still_idle(ext, jobs + 1)
        assert [job["kind"] for job in ext.journal()] == ["batch"]
        assert entry["series"][0]["line"] == "complete: 3 of 3 (3 downloaded)"
        assert server.collect_requests == []
        assert SECOND_SERIES_ID in server.favorite_ids
        card = _card(page, SECOND_SERIES_ID)
        ext.wait_for(lambda: card.get_attribute("data-status") == "on-disk", 10, "not on disk")
        assert card.locator(".favorite-status").inner_text() == "On disk · 3/3"
        assert card.locator("[data-action='remove']").count() == 1
        (alert,) = recorded_alerts(ext, 1)
        assert alert["options"]["title"] == f"✓ {SECOND_SERIES_NAME} — downloaded"


def test_e_a_drama_the_library_does_not_hold_is_never_removed(tmp_path: Path) -> None:
    """(e) A library that holds only the main series, and a paste of the second drama — in the
    fake's favorites, but never listed: downloaded whole, never removed — nothing pressed, no
    removal job."""
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=SETTINGS) as ext,
    ):
        ext.keep_library((SERIES_ID, SERIES_NAME, 5))
        jobs = ext.finished_jobs()
        entry = ext.paste_and_wait(SECOND_LINK, timeout_s=120)
        _still_idle(ext, jobs + 1)
        assert [job["kind"] for job in ext.journal()] == ["batch"]
        assert entry["series"][0]["line"] == "complete: 3 of 3 (3 downloaded)"
        assert server.collect_requests == []
        assert SECOND_SERIES_ID in server.favorite_ids
        assert _card(ext.page, SECOND_SERIES_ID).count() == 0


def test_f_stop_while_an_automatic_removal_waits_takes_it_out_and_it_never_runs(
    tmp_path: Path,
) -> None:
    """(f) A paste of the second drama and the main series, both held by the library: the second is
    done — its automatic removal queued behind the batch — and **Stop** is pressed while the batch
    downloads the main series: the removal leaves the queue at once, the library's status line says
    so, the batch stops, and the removal never runs — `not started: …` in the journal, nothing
    pressed, the fake's list keeps the drama, its card keeps **Remove from Favorites**, no
    notification says anything of it."""
    settings = {**SETTINGS, "delayMinS": 1, "delayMaxS": 1}  # the main series takes a while
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=settings) as ext,
    ):
        ext.keep_library((SECOND_SERIES_ID, SECOND_SERIES_NAME, 3), (SERIES_ID, SERIES_NAME, 5))
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        ext.paste(f"{SECOND_LINK}\n{MAIN_LINK}")
        waiting = page.locator("#queue-list li")
        ext.wait_for(
            lambda: waiting.all_inner_texts() == [AUTO_ROW], 90, "no automatic removal waits"
        )
        assert not ext.idle()  # the batch goes on with the main series
        page.click("#stop-button")
        status = page.locator("#favorites-status")
        dropped = (
            "1 automatic removal from your Favorites taken out of the queue: its card keeps "
            "Remove from Favorites."
        )
        ext.wait_for(
            lambda: status.inner_text() == dropped,
            10,
            "the status line does not say the removal left the queue",
        )
        assert waiting.count() == 0
        _until_jobs(ext, jobs + 1, 60, "the stopped batch did not end")
        _still_idle(ext, jobs + 1)
        batch, removal = ext.journal()
        assert batch["kind"] == "batch"
        assert batch["stopped"] == "stopped by you"
        assert (removal["kind"], removal["label"]) == ("unbookmark", AUTO_LABEL)
        stopped = f"not started: batch stopped in {batch['label']} (stopped by you)"
        assert removal["error"] == stopped
        assert "bookmark" not in removal
        assert server.collect_requests == []
        assert SECOND_SERIES_ID in server.favorite_ids
        card = _card(page, SECOND_SERIES_ID)
        ext.wait_for(lambda: card.get_attribute("data-status") == "on-disk", 10, "not on disk")
        assert card.locator("[data-action='remove']").count() == 1
        alerts = page.evaluate(ALERTS_JS)
        assert alerts  # the second drama's ✓, at least
        assert not [a for a in alerts if "Favorites" in a["options"]["title"]]


def test_g_a_removal_tiktok_does_not_keep_stops_and_halts_the_automatic_removals(
    tmp_path: Path,
) -> None:
    """(g) A fake that answers the press like TikTok but keeps the drama (`collect_ignored`): the
    automatic removal ends `not-kept` — a stop without a cooldown, one press, never a second —, the
    download pasted while it rested ends unstarted; the library's status line gives the reason and
    says DramaFetch removes no more dramas on its own until the tab is reloaded; the drama's ✓
    notification becomes `⚠ … — still in your Favorites` with that reason; and a later download that
    finds the drama complete queues no removal."""
    settings = {**SETTINGS, "restMinS": 2, "restMaxS": 2.5}  # time to paste while the removal rests
    with (
        FakeTikTok(collect_ignored=True) as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=settings) as ext,
    ):
        ext.keep_library((SECOND_SERIES_ID, SECOND_SERIES_NAME, 3), (SERIES_ID, SERIES_NAME, 5))
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        ext.paste(SECOND_LINK)
        current = page.locator("#progress-current")
        ext.wait_for(
            lambda: ext.finished_jobs() == jobs + 1 and current.inner_text() == AUTO_LABEL,
            90,
            "the automatic removal did not start",
        )
        ext.paste(MAIN_LINK)  # while the removal rests: queued behind it
        ext.wait_for(
            lambda: (
                page.locator("#queue-list li").all_inner_texts() == [f"{SERIES_NAME} · {SERIES_ID}"]
            ),
            10,
            "the download is not queued behind the removal",
        )
        _until_jobs(ext, jobs + 2, 60, "the removal did not end")
        _still_idle(ext, jobs + 2)
        removal, behind, download = ext.journal()
        not_kept = (
            "TikTok did not keep the change: the drama is still in your Favorites — remove it on "
            "TikTok yourself"
        )
        assert download["kind"] == "batch"
        assert (removal["kind"], removal["label"]) == ("unbookmark", AUTO_LABEL)
        assert removal["bookmark"]["outcome"] == not_kept
        assert removal["stopped"] == not_kept
        assert (behind["kind"], behind["label"]) == ("batch", f"Series {SERIES_ID}")
        assert behind["error"] == f"not started: batch stopped in {AUTO_LABEL} ({not_kept})"
        assert server.collect_requests == [(COLLECT_PATH, "0")]  # never a second click
        assert SECOND_SERIES_ID in server.favorite_ids
        assert ext.cooldown() is None
        assert not _cdn_asked(server, SERIES_ID)  # the download behind it asked nothing
        reason = (
            f"TikTok did not keep the change: “{SECOND_SERIES_NAME}” is still in your Favorites. "
            "Remove it yourself: Open on TikTok."
        )
        assert page.locator("#favorites-status").inner_text() == f"{reason} {HALTED_LINE}"
        card = _card(page, SECOND_SERIES_ID)
        ext.wait_for(lambda: card.get_attribute("data-status") == "on-disk", 10, "not on disk")
        downloaded, kept, stopped = recorded_alerts(ext, 3)
        assert len(page.evaluate(ALERTS_JS)) == 3
        assert downloaded["options"]["title"] == f"✓ {SECOND_SERIES_NAME} — downloaded"
        assert kept["id"] == downloaded["id"]
        assert (kept["options"]["title"], kept["options"]["message"]) == (
            f"⚠ {SECOND_SERIES_NAME} — still in your Favorites",
            reason,
        )
        assert "buttons" not in kept["options"]
        assert "contextMessage" not in kept["options"]
        # as for any stop that took a download out of the queue: ONE more says it was not started
        assert (stopped["options"]["title"], stopped["options"]["message"]) == (
            f"DramaFetch stopped: {not_kept}",
            "1 drama was not started — download it again later",
        )
        # halted: a later download that finds the drama complete queues no removal
        again = ext.paste_and_wait(SECOND_LINK, recheck=True, timeout_s=120)
        _still_idle(ext, jobs + 3)
        assert again["series"][0]["line"] == "complete: 3 of 3 (3 already on disk)"
        assert [job["kind"] for job in ext.journal()] == ["batch", "unbookmark", "batch", "batch"]
        assert server.collect_requests == [(COLLECT_PATH, "0")]
        assert SECOND_SERIES_ID in server.favorite_ids
        *_, last = recorded_alerts(ext, 4)
        assert len(page.evaluate(ALERTS_JS)) == 4  # its ✓ alone: no removal followed it
        assert last["options"]["title"] == f"✓ {SECOND_SERIES_NAME} — downloaded"


def test_j_a_drama_the_favorites_list_gives_no_count_for_leaves_them_after_its_automatic_retry(
    tmp_path: Path,
) -> None:
    """(j) (b) for a drama TikTok's favorites list gives no episode count for (the library keeps it
    with none): E02 cut short once, its automatic retry saves it — a selection, which sets no
    complete mark, the only thing the records could vouch with for such a drama —, and the removal's
    gate checks the records against the count of the list the retry read: every episode on disk, so
    the drama leaves the Favorites — `removed`, one press, its card **Removed from your
    Favorites**, `✓ … — removed from your Favorites` under the retry's alert id."""
    second = (SECOND_SERIES_ID, 2)
    with (
        FakeTikTok(truncate_once=frozenset({second})) as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=SETTINGS) as ext,
    ):
        ext.keep_library((SECOND_SERIES_ID, SECOND_SERIES_NAME, None))
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        ext.paste(SECOND_LINK)
        _until_jobs(ext, jobs + 3, 180, "the download, its retry and its removal did not end")
        journal = ext.journal()
        assert len(journal) == 3  # nothing more
        removal, automatic, pasted = journal
        assert _rows(pasted) == [(SECOND_SERIES_ID, [(1, "done"), (2, "failed"), (3, "done")])]
        assert automatic["kind"] == "selection"
        assert _rows(automatic) == [(SECOND_SERIES_ID, [(2, "done")])]
        assert (removal["kind"], removal["label"]) == ("unbookmark", AUTO_LABEL)
        assert removal["error"] is None
        assert removal["bookmark"]["outcome"] == "removed"
        assert server.collect_requests == [(COLLECT_PATH, "0")]
        assert SECOND_SERIES_ID not in server.favorite_ids
        assert _card(page, SECOND_SERIES_ID).get_attribute("data-status") == "removed"
        retrying, downloaded, removed = recorded_alerts(ext, 3)
        assert len(page.evaluate(ALERTS_JS)) == 3
        assert downloaded["id"] == retrying["id"] == removed["id"]
        assert downloaded["options"]["title"] == f"✓ {SECOND_SERIES_NAME} — downloaded"
        assert (removed["options"]["title"], removed["options"]["message"]) == (
            f"✓ {SECOND_SERIES_NAME} — removed from your Favorites",
            "Every episode is on disk.",
        )


def test_k_dramafetch_s_own_removal_leaves_the_progress_card_s_did_not_download_block(
    tmp_path: Path,
) -> None:
    """(k) One paste of the main series — its E02 cut short twice: the batch fails it, and so does
    its automatic retry — and the second drama, saved whole, both of the library: the batch, the
    main series' automatic retry, then the second drama's automatic removal. From the removal's
    start to its end, and after it, the progress card keeps the retry's **Did not download (1)**
    block — its table, its **Retry**, the line of its report saved —: DramaFetch's own removal
    takes nothing of the card away (2.0.0; the user's own still does, as any job). What the card
    says is recorded as it changes (`RECORD_PROGRESS_JS`)."""
    with (
        FakeTikTok(truncate_twice=frozenset({(SERIES_ID, 2)})) as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=SETTINGS) as ext,
    ):
        ext.keep_library((SERIES_ID, SERIES_NAME, 5), (SECOND_SERIES_ID, SECOND_SERIES_NAME, 3))
        page = ext.page
        page.evaluate(RECORD_PROGRESS_JS)
        jobs = ext.finished_jobs()
        ext.paste(f"{MAIN_LINK}\n{SECOND_LINK}")
        _until_jobs(ext, jobs + 3, 180, "the download, its retry and the removal did not end")
        journal = ext.journal()
        assert len(journal) == 3  # nothing more
        removal, retry, batch = journal
        assert batch["kind"] == "batch"
        assert _rows(batch) == [
            (
                SERIES_ID,
                [(1, "done"), (2, "failed"), (3, "done"), (4, "done"), (5, "skipped-locked")],
            ),
            (SECOND_SERIES_ID, [(1, "done"), (2, "done"), (3, "done")]),
        ]
        assert (retry["kind"], retry["label"]) == (
            "selection",
            f"Automatic retry: 1 of {SERIES_NAME}",
        )
        assert _rows(retry) == [(SERIES_ID, [(2, "failed")])]
        assert (removal["kind"], removal["label"]) == ("unbookmark", AUTO_LABEL)
        assert removal["bookmark"]["outcome"] == "removed"
        assert SECOND_SERIES_ID not in server.favorite_ids
        # the card as the retry's end left it, unchanged from the removal's start on
        log: list[list[Any]] = page.evaluate("() => globalThis.__progressLog")
        start = next(
            (index for index, (current, *_) in enumerate(log) if current == AUTO_LABEL), None
        )
        assert start is not None and start > 0, log
        # shown, its heading, no line (no automatic retry waits any more), its Retry enabled
        kept = [False, "Did not download (1)", "", False]
        assert log[start - 1][1:] == kept, log
        assert all(state[1:] == kept for state in log[start:]), log[start:]
        # and once everything ended: the retry's E02 in the table, its Retry, its report saved
        assert page.locator("#progress-current").text_content() == AUTO_LABEL
        assert page.locator("#failed-block").is_visible()
        rows = page.locator("#failed-table tbody tr")
        assert rows.count() == 1
        assert rows.first.get_attribute("data-series-id") == SERIES_ID
        assert rows.first.get_attribute("data-number") == "2"
        retry_button = page.locator("#retry-button")
        assert retry_button.is_enabled()
        assert retry_button.text_content() == "Retry the episodes that did not download (1)"
        report = page.locator("#failed-report")
        assert report.is_visible()
        assert (report.text_content() or "").startswith("Report saved: ")


def test_l_a_removal_whose_count_is_more_than_a_day_old_at_its_turn_lists_its_drama_again_first(
    tmp_path: Path,
) -> None:
    """(l) The second drama is downloaded whole while the library holds nothing (no removal);
    then the library is kept with it — no whole read, so its count vouches for nothing — and its
    records' complete mark is set to 8 s less than 24 h ago, right before ONE paste of it and the
    main series, with 4 s between episodes and 2 to 2.5 s of rest between jobs. The 24 h edge is
    reached for real, never seeded past it: the paste's batch skips the drama as complete (its
    mark less than 24 h old: no request), so its automatic removal carries that mark as when it
    was found complete, at the end of the queue; the main series' four downloads — 12 s of pauses
    at least — keep it waiting past the mark's 24 h. At its turn the removal presses nothing and
    queues ONE re-listing (`not removed yet: …`, no notification). While that re-listing rests
    before its first request, the drama is pasted again (as the owner pastes the next block of a
    long queue): queued behind it as a job of its own, never folded into DramaFetch's re-listing
    (which the setting unticked or **Stop** could take out). The re-listing — what a paste of the
    drama queues, `recheck` on — lists it again (the drama's page once, no media: every episode on
    disk), finds it complete and queues its removal NEXT, ahead of that paste: the removal presses
    the Bookmark once, then the paste runs and skips the drama as complete — no request. The drama
    leaves the fake's favorites; the journal reads the batch, the removal (`RELISTED`), the
    re-listing, the removal (`removed`), the paste; one `collect`; the drama's page three times
    since the first paste; no `⚠` notification."""
    margin_s = 8
    with (
        FakeTikTok() as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=SETTINGS) as ext,
    ):
        # the second drama on disk, while the library holds nothing: no removal
        first = ext.paste_and_wait(SECOND_LINK, timeout_s=120)
        assert first["series"][0]["line"] == "complete: 3 of 3 (3 downloaded)"
        ext.keep_library((SECOND_SERIES_ID, SECOND_SERIES_NAME, 3))  # a reload: a fresh journal
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        # 2 to 2.5 s of rest between jobs: time to paste while the re-listing rests
        pacing = {"delayMinS": 4, "delayMaxS": 4, "restMinS": 2, "restMaxS": 2.5}
        ext.save_test_settings({**ext.settings, **pacing})
        jobs = ext.finished_jobs()
        asked = len(server.requests)
        at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 24 * 3600 + margin_s))
        assert page.evaluate(COMPLETE_MARK_JS, [f"series:{SECOND_SERIES_ID}", at]) == 3
        ext.paste(f"{SECOND_LINK}\n{MAIN_LINK}")
        # the batch and the removal ended: the re-listing rests before its first request
        ext.wait_for(
            lambda: ext.finished_jobs() >= jobs + 2, 180, "the batch and the removal did not end"
        )
        assert ext.journal()[0]["error"] == RELISTED  # the removal: a re-listing queued
        ext.paste(SECOND_LINK)  # the drama pasted again, the re-listing waiting
        # queued as the user's own job, behind the re-listing: never folded into it
        expected = f"Series {SECOND_SERIES_ID} queued: it downloads whole, with the usual pauses."
        assert page.locator("#input-status").text_content() == expected
        _until_jobs(
            ext,
            jobs + 5,
            180,
            "the re-listing, its removal and the paste after it did not end",
        )
        journal = ext.journal()
        assert len(journal) == 5  # nothing more
        again, removal, relist, relisted, batch = journal
        # the paste: the second drama skipped as complete (no request), the main series downloaded
        assert batch["kind"] == "batch"
        on_disk = [(1, "skipped-exists"), (2, "skipped-exists"), (3, "skipped-exists")]
        main = [(1, "done"), (2, "done"), (3, "done"), (4, "done"), (5, "skipped-locked")]
        assert _rows(batch) == [(SECOND_SERIES_ID, on_disk), (SERIES_ID, main)]
        assert batch["series"][0]["report"]["skipped_complete"] is True
        # its removal, at its turn more than 24 h after the mark: nothing pressed, ONE re-listing
        assert (relisted["kind"], relisted["label"]) == ("unbookmark", AUTO_LABEL)
        assert relisted["bookmark"] == {
            "series_id": SECOND_SERIES_ID,
            "title": SECOND_SERIES_NAME,
            "outcome": RELISTED,
        }
        assert (relisted["error"], relisted["stopped"]) == (RELISTED, None)
        assert relisted["pauses"] == []  # ended at its gate, before the rest between jobs
        # the re-listing: the drama listed again, every episode on disk
        assert (relist["kind"], relist["label"]) == ("batch", RELIST_LABEL)
        assert (relist["error"], relist["stopped"]) == (None, None)
        assert _rows(relist) == [(SECOND_SERIES_ID, on_disk)]
        assert relist["series"][0]["line"] == "complete: 3 of 3 (3 already on disk)"
        assert relist["series"][0]["report"]["skipped_complete"] is False
        # and the removal its drama queued, run NEXT — ahead of the paste made meanwhile: one press
        assert (removal["kind"], removal["label"]) == ("unbookmark", AUTO_LABEL)
        assert removal["bookmark"]["outcome"] == "removed"
        assert (removal["error"], removal["stopped"]) == (None, None)
        # the paste made while the re-listing rested, run after that removal — a complete skip, the
        # drama listed a moment before: no request
        assert (again["kind"], again["label"]) == ("batch", f"Series {SECOND_SERIES_ID}")
        assert (again["error"], again["stopped"]) == (None, None)
        assert _rows(again) == [(SECOND_SERIES_ID, on_disk)]
        assert again["series"][0]["report"]["skipped_complete"] is True
        assert server.collect_requests == [(COLLECT_PATH, "0")]
        assert SECOND_SERIES_ID not in server.favorite_ids
        assert _card(page, SECOND_SERIES_ID).get_attribute("data-status") == "removed"
        # since the paste: the drama's page three times — the re-listing's listing, then the
        # removal's page and its reload around the one press; none for the paste after them —, and
        # none of its media
        after = server.requests[asked:]
        pages = [
            index
            for index, record in enumerate(after)
            if (match := SERIES_PATH_RE.match(record.path))
            and match.group("id") == SECOND_SERIES_ID
        ]
        presses = [index for index, record in enumerate(after) if record.path == COLLECT_PATH]
        assert len(pages) == 3
        assert pages[1] < presses[0] < pages[2]
        # the re-listing's own listing: the drama's episode list, asked for from its page before
        # the removal's page opened
        lists = [
            index
            for index, record in enumerate(after)
            if record.path == "/api/drama/episode/item_list/"
            and record.query.get("dramaID") == SECOND_SERIES_ID
        ]
        assert lists
        assert pages[0] < lists[0] < pages[1]
        second_media = [
            record
            for record in after
            if (match := CDN_PATH_RE.match(record.path))
            and EPISODE_OF_ITEM.get(match.group("id"), ("", 0))[0] == SECOND_SERIES_ID
        ]
        assert second_media == []
        # the notifications: the main series' ✓; the re-listing's ✓, then — the same id — removed
        main_done, downloaded, removed = recorded_alerts(ext, 3)
        alerts = page.evaluate(ALERTS_JS)
        assert len(alerts) == 3
        assert not [alert for alert in alerts if alert["options"]["title"].startswith("⚠")]
        assert main_done["options"]["title"] == f"✓ {SERIES_NAME} — downloaded"
        assert downloaded["id"].endswith(f":{SECOND_SERIES_ID}:complete")
        assert downloaded["options"]["title"] == f"✓ {SECOND_SERIES_NAME} — downloaded"
        assert removed["id"] == downloaded["id"]
        assert (removed["options"]["title"], removed["options"]["message"]) == (
            f"✓ {SECOND_SERIES_NAME} — removed from your Favorites",
            "Every episode is on disk.",
        )
