"""The automatic retry of DramaFetch 1.8.0 for Chrome, end to end (`pytest -m integration`; skipped
without a browser): the owner's request of 2026-11-21 — "retry on its own a download that did not
work, and notify me of that too".

A real headless Chromium loads the extension's TEST copy (`extension_harness.ExtensionHarness`)
against the fake TikTok server, with the settings' defaults — **Retry on its own what did not
download** and **Alert me when a drama finishes** on —, every notification the DramaFetch tab asks
Chrome for recorded on its way (`extension_alerts.RECORD_ALERTS_JS`):

- (a) a paste of a drama whose episode 2's first transfer the fake cuts short (`truncate_once`):
  the paste's job fails E02 and queues ONE `Automatic retry: 1 of <drama>` job — a `selection`,
  after the rest between jobs, with one fresh listing —, which saves E02 whole with its cover:
  byte for byte what a clean paste saves in another profile, the fake CDN asked twice for E02 in
  all and the drama listed twice, a clean paste's listings and no more. Meanwhile the progress
  card's **Did not download (1)** says `1 of them will be retried automatically, once.`, and its
  **Retry** pressed then queues nothing (`Already queued — not queued twice.`). Notifications:
  `↻ <drama> — retrying 1 episode` (no button: the retry is queued), then — the same id, which
  Chrome replaces — `✓ <drama> — downloaded`, its context `After an automatic retry.`;
- (b) the same episode cut short on its first TWO transfers (`truncate_twice`): after the
  automatic retry, ONE notification `⚠ <drama> — 1 episode to retry` with **Retry** and the
  context `After an automatic retry.`, no second automatic retry (the CDN asked exactly twice for
  E02); that **Retry**, clicked as Chrome hands it to the service worker, queues the tab's own
  retry, which saves it;
- (c) a run with a plain failure (E01 cut short) that a 429 then stops (E02, `rate_limit_media`):
  no automatic retry at all — the project's rule after a refusal —, the ⚠ alert with its
  **Retry** and the stop's reason;
- (d) a batch whose first drama queued its automatic retry and whose second drama's list TikTok
  refuses (HTTP 429 on a later list page, `rate_limit_pagination`): the stop takes the automatic
  retry out of the queue — `not started: …` in the journal —, its drama's notification turns into
  the ⚠ alert with **Retry** and `Not retried automatically: rate limited (HTTP 429)`, and no
  `DramaFetch stopped` alert counts it as a drama never started;
- (e) a `selection` job the user asked for — **See episodes**, then **Download all available**,
  which downloads every episode in full (`overwrite`, 3.0.0) — whose E02 transfer is cut short
  once: its drama, done where the job ends, queues the same ONE automatic retry — downloading in
  full too —, which saves E02; `↻`, then `✓ … — downloaded` with `After an automatic retry.`;
- (e2) the same for the progress card's **Retry** (DramaFetch 4.0.0's (e)), the paste before it
  made with the automatic retry turned off and the setting turned back on before that **Retry**
  (`ExtensionHarness.turn_on_auto_retry`): E02 cut short again by the **Retry**, its drama queues
  ONE automatic retry, which saves E02 — the CDN asked three times for it in all —; the paste's ⚠
  with **Retry**, then `↻` and `✓ … — downloaded` with `After an automatic retry.`;
- (f) **Stop** pressed the instant the page asks for a batch's last episode (cut short too) — the
  engine past its last look at Stop, so the batch runs its course —: still a stop. The automatic
  retry the batch's first drama queued comes out of the queue at once (at the batch's end `not
  started: … (stopped by you)`, its notification the ⚠ alert with **Retry** and `Not retried
  automatically: stopped by you`), the second drama queues none (its plain ⚠ alert), and nothing
  more is asked of TikTok;
- (g) an automatic retry of E02 and E03 that **Stop** ends in its pause after it saved E02: its
  notification is the ⚠ alert of E03 alone with **Retry**, `stopped by you` its context — never
  `Not retried automatically`, it ran —, and that **Retry** saves E03;
- (h) **Stop** pressed at the very end of a job — as it saves its report of what did not download,
  its automatic retry waiting —: that retry never starts; once the job is over its journal entry
  says `not started: … (stopped by you)` and its notification is the ⚠ alert with **Retry** and
  `Not retried automatically: stopped by you`;
- (i) two pastes, the second while the first downloads, each drama with one transfer cut short
  once: the first drama's automatic retry waits behind the second job, the second's behind it.
  The second job's block says `1 of them will be retried automatically, once.` — its own
  automatic retry, never the first job's waiting too —, and that line goes the moment the first
  drama's automatic retry starts: it stays only for its own job's automatic retry. Since 3.0.1 the
  block itself keeps every job's rows (**Did not download (2)** at the second job's end) and stays
  while the automatic retries run, each one's end replacing only its own drama's retried number;
- (j) a paste of two dramas, the first's E02 cut short, **Stop** met in the second drama's pause
  after E01: the first drama's row stays in **Did not download** with its **Retry** (3.0.1: Stop
  keeps the block true), the automatic retry it queued taken out of the queue.

No cookie value is set, printed or asserted on; nothing reaches TikTok.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from dramafetch.media import INCOMPLETE_PREFIX

from .extension_alerts import (
    ALERTS_JS,
    CLEARED_JS,
    RECORD_ALERTS_JS,
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
#: A rest between jobs long enough to look at the page while the automatic retry waits in it:
#: its rest is due when the job before it ended at most `restMaxS` ago.
RESTING: dict[str, Any] = {"restMinS": 3, "restMaxS": 4}
#: In the DramaFetch tab: **Stop** — the page's own button, clicked — the instant the page asks the
#: fake CDN for the item `itemId` (a job's last episode: its transfer under way, the engine past
#: its last look at Stop); whether the button could be pressed then is kept. The request goes on
#: as asked; nothing else changes.
STOP_ON_FETCH_JS = """(itemId) => {
  if (globalThis.__stopOnFetch !== undefined) return;
  const probe = { pressed: false, enabled: null };
  globalThis.__stopOnFetch = probe;
  const fetchAsIs = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!probe.pressed && url.includes(`/cdn/${itemId}/`)) {
      const button = document.getElementById("stop-button");
      probe.enabled = !button.disabled;
      button.click();
      probe.pressed = true;
    }
    return fetchAsIs(input, init);
  };
}"""
#: In the DramaFetch tab: **Stop** — the page's own button, clicked — the instant the page asks
#: Chrome to save a report of what did not download (`DramaFetch/reports/…`): the very end of a
#: job, its journal entry and its **Did not download** block drawn already. The save goes on as
#: asked; nothing else changes.
STOP_ON_REPORT_JS = """() => {
  if (globalThis.__stopOnReport !== undefined) return;
  const probe = { pressed: false, enabled: null };
  globalThis.__stopOnReport = probe;
  const api = chrome.downloads;
  const download = api.download.bind(api);
  api.download = (options) => {
    if (!probe.pressed && String(options.filename).includes("/reports/")) {
      const button = document.getElementById("stop-button");
      probe.enabled = !button.disabled;
      button.click();
      probe.pressed = true;
    }
    return download(options);
  };
}"""
#: In the DramaFetch tab: what the progress card says of the job running and of the last job's
#: **Did not download** block — `[#progress-current, #failed-block hidden, #failed-heading,
#: #failed-auto, #failed-auto hidden]` — each time it changes, in `globalThis.__blockLog`: a
#: `MutationObserver` on the page, whose callback runs right after each change, before the page
#: can go on to the next job (no read timed against a rest between jobs). Nothing else changes.
RECORD_BLOCK_JS = """() => {
  if (globalThis.__blockLog !== undefined) return;
  const log = [];
  globalThis.__blockLog = log;
  const byId = (id) => document.getElementById(id);
  const note = () => {
    const now = [
      byId("progress-current").textContent,
      byId("failed-block").hidden,
      byId("failed-heading").textContent,
      byId("failed-auto").textContent,
      byId("failed-auto").hidden,
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


def _cdn_asked(server: FakeTikTok, series_id: str) -> dict[int, int]:
    """How many times the fake CDN was asked for each episode of `series_id` it was asked for."""
    asked: dict[int, int] = {}
    for request in server.requests:
        match = CDN_PATH_RE.match(request.path)
        episode = EPISODE_OF_ITEM.get(match.group("id")) if match is not None else None
        if episode is not None and episode[0] == series_id:
            asked[episode[1]] = asked.get(episode[1], 0) + 1
    return asked


def _rows(entry: dict[str, Any]) -> list[tuple[str, list[tuple[int, str, str]]]]:
    """A journal entry's series and rows: `(series id, [(number, status, message)])`."""
    return [
        (
            series["series_id"],
            [(row["number"], row["status"], row["message"]) for row in series.get("rows", [])],
        )
        for series in entry["series"]
    ]


def _videos(ext: ExtensionHarness) -> dict[str, bytes]:
    """Every episode saved under the download directory: its path there and its bytes."""
    return {
        str(path): (ext.downloads / path).read_bytes()
        for path in ext.saved_files()
        if path.suffix == ".mp4"
    }


def _until_jobs(ext: ExtensionHarness, count: int, timeout_s: float, what: str) -> None:
    """Wait until `count` jobs have finished in all and nothing runs or waits."""
    ext.wait_for(lambda: ext.finished_jobs() >= count and ext.idle(), timeout_s, what)


def _item_of(series_id: str, number: int) -> str:
    """The fake's item id of episode `number` of `series_id`."""
    (item,) = [item for item, episode in EPISODE_OF_ITEM.items() if episode == (series_id, number)]
    return item


def test_a_an_episode_cut_short_is_retried_on_its_own_and_saved_whole(tmp_path: Path) -> None:
    """(a) The paste's job fails E02 (its first transfer cut short), queues ONE automatic retry
    and says so — the block's line, the `↻` notification with no button; the progress card's
    **Retry** pressed meanwhile queues nothing twice —; the automatic retry rests, lists the drama
    once more and saves E02 whole with its cover, byte for byte a clean paste's; its notification
    replaces the first one: `✓ … — downloaded`, `After an automatic retry.`."""
    second = (SECOND_SERIES_ID, 2)
    with (
        FakeTikTok(truncate_once=frozenset({second})) as server,
        ExtensionHarness(tmp_path / "healed", server.base_url, test_settings=RESTING) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        ext.paste(SECOND_LINK)
        ext.wait_for(lambda: ext.finished_jobs() > jobs, 60, "the paste's download did not end")

        # the paste's job is over; its automatic retry, queued as its drama was done, now rests
        # before its listing (3-4 s): what the page says meanwhile
        assert page.locator("#failed-block").is_visible()
        assert page.locator("#failed-heading").text_content() == "Did not download (1)"
        line = page.locator("#failed-auto")
        assert line.is_visible()
        assert line.text_content() == "1 of them will be retried automatically, once."
        (retrying,) = recorded_alerts(ext, 1)
        assert retrying["id"].endswith(f":{SECOND_SERIES_ID}:retry")
        assert retrying["listed"] is True
        assert (retrying["options"]["title"], retrying["options"]["message"]) == (
            f"↻ {SECOND_SERIES_NAME} — retrying 1 episode",
            "E02 did not download — DramaFetch tries it once more on its own.",
        )
        assert "buttons" not in retrying["options"]  # the retry is queued already
        assert "contextMessage" not in retrying["options"]
        # the progress card's Retry, pressed while the automatic retry holds E02: nothing twice
        retry = page.locator("#retry-button")
        assert retry.is_enabled()
        retry.click()
        status = page.locator("#input-status")
        ext.wait_for(
            lambda: status.text_content() == "Already queued — not queued twice.",
            10,
            "the status line does not say the retry is queued already",
        )
        assert retry.is_disabled()  # spent, as any pressed Retry until the next job ends

        _until_jobs(ext, jobs + 2, 90, "the automatic retry did not end")
        journal = ext.journal()
        assert len(journal) == 2  # the paste's job and its automatic retry, nothing more
        automatic, pasted = journal
        assert pasted["kind"] == "batch"
        ((series_id, rows),) = _rows(pasted)
        assert series_id == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in rows] == [
            (1, "done"),
            (2, "failed"),
            (3, "done"),
        ]
        assert rows[1][2].startswith(f"{INCOMPLETE_PREFIX}truncated body (")
        assert automatic["kind"] == "selection"
        assert automatic["label"] == f"Automatic retry: 1 of {SECOND_SERIES_NAME}"
        assert automatic["stopped"] is None
        assert [pause["kind"] for pause in automatic["pauses"]] == ["job-rest"]
        ((series_id, rows),) = _rows(automatic)
        assert series_id == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in rows] == [(2, "done")]
        assert rows[0][2].endswith(" + cover embedded")
        assert _cdn_asked(server, SECOND_SERIES_ID) == {1: 1, 2: 2, 3: 1}  # E02 once more
        assert page.locator("#failed-block").is_hidden()
        assert line.is_hidden()

        retrying, done = recorded_alerts(ext, 2)
        assert len(page.evaluate(ALERTS_JS)) == 2
        assert done["id"] == retrying["id"]  # Chrome replaces it: one notification per drama
        assert done["listed"] is True
        assert (
            done["options"]["title"],
            done["options"]["message"],
            done["options"]["contextMessage"],
        ) == (
            f"✓ {SECOND_SERIES_NAME} — downloaded",
            "All 3 episodes are on disk.",
            "After an automatic retry.",
        )
        assert "buttons" not in done["options"]
        assert page.evaluate(CLEARED_JS) == []
        listings = (len(server.series_page_requests), len(server.item_list_requests))
        healed = _videos(ext)
    with (
        FakeTikTok() as clean,
        ExtensionHarness(tmp_path / "clean", clean.base_url) as box,
    ):
        box.paste_and_wait(SECOND_LINK, timeout_s=120)
        whole = _videos(box)
        once = (len(clean.series_page_requests), len(clean.item_list_requests))
    assert listings == (2 * once[0], 2 * once[1])  # one fresh listing more, and no more
    assert sorted(Path(path).name for path in healed) == [
        f"{SECOND_SERIES_NAME} - Episode {number:02d}.mp4" for number in (1, 2, 3)
    ]
    assert healed == whole


def test_b_an_episode_cut_short_twice_is_retried_once_then_left_to_the_alert_s_retry(
    tmp_path: Path,
) -> None:
    """(b) E02 cut short on its first TWO transfers: the automatic retry fails it again, its
    notification — the same id — is the ⚠ alert with **Retry** and `After an automatic retry.`,
    and nothing more is queued: the CDN asked exactly twice for E02. That **Retry**, clicked as
    Chrome hands it to the service worker, queues the tab's own retry and takes the alert away;
    E02 is saved whole and its drama's notification says so."""
    second = (SECOND_SERIES_ID, 2)
    with (
        FakeTikTok(truncate_twice=frozenset({second})) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        ext.paste(SECOND_LINK)
        _until_jobs(ext, jobs + 2, 120, "the paste and its automatic retry did not end")
        journal = ext.journal()
        assert len(journal) == 2  # no second automatic retry
        automatic, pasted = journal
        assert pasted["kind"] == "batch"
        assert [(n, status) for n, status, _ in _rows(pasted)[0][1]] == [
            (1, "done"),
            (2, "failed"),
            (3, "done"),
        ]
        assert automatic["kind"] == "selection"
        assert automatic["label"] == f"Automatic retry: 1 of {SECOND_SERIES_NAME}"
        ((series_id, rows),) = _rows(automatic)
        assert series_id == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in rows] == [(2, "failed")]
        assert rows[0][2].startswith(f"{INCOMPLETE_PREFIX}truncated body (")
        assert _cdn_asked(server, SECOND_SERIES_ID) == {1: 1, 2: 2, 3: 1}
        assert page.locator("#queue-list li").count() == 0
        assert page.locator("#failed-block").is_visible()
        assert page.locator("#failed-heading").text_content() == "Did not download (1)"
        assert page.locator("#failed-auto").is_hidden()  # nothing more is retried on its own
        assert page.locator("#retry-button").is_enabled()

        retrying, alert = recorded_alerts(ext, 2)
        assert len(page.evaluate(ALERTS_JS)) == 2
        assert retrying["options"]["title"] == f"↻ {SECOND_SERIES_NAME} — retrying 1 episode"
        assert "buttons" not in retrying["options"]
        assert alert["id"] == retrying["id"]
        assert alert["id"].endswith(f":{SECOND_SERIES_ID}:retry")
        assert alert["listed"] is True
        options = alert["options"]
        assert (
            options["title"],
            options["message"],
            options["buttons"],
            options["contextMessage"],
        ) == (
            f"⚠ {SECOND_SERIES_NAME} — 1 episode to retry",
            "E02 did not download.",
            [{"title": "Retry"}],
            "After an automatic retry.",
        )

        # the alert's Retry: the tab's own retry of E02, the alert taken away
        in_worker(ext, RETRY_CLICK_JS, alert["id"])
        _until_jobs(ext, jobs + 3, 90, "the alert's retry did not end")
        assert page.evaluate(CLEARED_JS) == [alert["id"]]
        entry = ext.journal()[0]
        assert entry["kind"] == "selection"
        assert entry["label"] == f"Retry 1 of {SECOND_SERIES_NAME}"
        ((series_id, rows),) = _rows(entry)
        assert [(number, status) for number, status, _ in rows] == [(2, "done")]
        assert rows[0][2].endswith(" + cover embedded")
        assert _cdn_asked(server, SECOND_SERIES_ID) == {1: 1, 2: 3, 3: 1}
        assert page.locator("#failed-block").is_hidden()
        _retrying, _alert, done = recorded_alerts(ext, 3)
        assert done["id"].endswith(f":{SECOND_SERIES_ID}:complete")
        assert (done["options"]["title"], done["options"]["message"]) == (
            f"✓ {SECOND_SERIES_NAME} — downloaded",
            "All 3 episodes are on disk.",
        )
        assert "contextMessage" not in done["options"]  # the user's own retry
        assert sorted(Path(path).name for path in _videos(ext)) == [
            f"{SECOND_SERIES_NAME} - Episode {number:02d}.mp4" for number in (1, 2, 3)
        ]


def test_c_a_run_stopped_by_a_429_queues_no_automatic_retry(tmp_path: Path) -> None:
    """(c) E01's transfer cut short — a plain failure, which alone would be retried —, then a 429
    on E02: the stop and the 30-minute cooldown, and no automatic retry (no `Automatic retry` job,
    nothing waiting, nothing more asked of the CDN); the drama's ⚠ alert keeps its **Retry** and
    says why the run stopped."""
    with (
        FakeTikTok(
            truncate_once=frozenset({(SERIES_ID, 1)}),
            rate_limit_media=frozenset({(SERIES_ID, 2)}),
        ) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        entry = ext.paste_and_wait(MAIN_LINK)
        assert ext.finished_jobs() == jobs + 1
        assert [item["label"] for item in ext.journal()] == [entry["label"]]  # nothing more
        assert entry["kind"] == "batch"
        assert entry["stopped"] == "episode 2 failed-rate-limited"
        ((series_id, rows),) = _rows(entry)
        assert series_id == SERIES_ID
        assert [(number, status) for number, status, _ in rows] == [
            (1, "failed"),
            (2, "failed-rate-limited"),
            (3, "failed-rate-limited"),
            (4, "failed-rate-limited"),
            (5, "skipped-locked"),
        ]
        assert rows[0][2].startswith(f"{INCOMPLETE_PREFIX}truncated body (")
        for _number, _status, message in rows[2:4]:
            assert message.startswith("stopped: episode 2 failed-rate-limited: ")
        cooldown = ext.cooldown()
        assert cooldown is not None and cooldown["source"] == "browser"
        assert _cdn_asked(server, SERIES_ID) == {1: 1, 2: 1}
        assert page.locator("#queue-list li").count() == 0
        assert page.locator("#failed-heading").text_content() == "Did not download (4)"
        assert page.locator("#failed-auto").is_hidden()

        (alert,) = recorded_alerts(ext, 1)
        assert len(page.evaluate(ALERTS_JS)) == 1
        assert alert["id"].endswith(f":{SERIES_ID}:retry")
        options = alert["options"]
        assert (
            options["title"],
            options["message"],
            options["buttons"],
            options["contextMessage"],
        ) == (
            f"⚠ {SERIES_NAME} — 4 episodes to retry",
            "E01, E02, E03, E04 did not download.",
            [{"title": "Retry"}],
            "episode 2 failed-rate-limited",
        )


def test_d_an_automatic_retry_a_later_stop_takes_out_of_the_queue_is_said_not_retried(
    tmp_path: Path,
) -> None:
    """(d) A paste of two dramas: the first's E02 cut short queues its automatic retry (`↻`); the
    second's list is refused (HTTP 429 on a later page): the stop and the cooldown take the
    automatic retry out of the queue before it asks anything — `not started: …` in the journal —,
    and the first drama's notification, under the same id, becomes the ⚠ alert with **Retry** and
    `Not retried automatically: rate limited (HTTP 429)`; no `DramaFetch stopped` alert counts it
    among dramas never started (the batch started both)."""
    second = (SECOND_SERIES_ID, 2)
    with (
        FakeTikTok(truncate_once=frozenset({second}), rate_limit_pagination=True) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        entry = ext.paste_and_wait(f"{SECOND_LINK}\n{MAIN_LINK}")
        assert ext.finished_jobs() == jobs + 1
        assert entry["kind"] == "batch"
        assert entry["stopped"] == "rate limited (HTTP 429)"
        first, refused = _rows(entry)
        assert first[0] == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in first[1]] == [
            (1, "done"),
            (2, "failed"),
            (3, "done"),
        ]
        assert refused == (SERIES_ID, [])  # its list refused: no row
        cancelled = ext.journal()[1]
        assert cancelled["label"] == f"Automatic retry: 1 of {SECOND_SERIES_NAME}"
        assert str(cancelled["error"]).startswith("not started: ")
        assert cancelled["series"] == []
        assert len(ext.journal()) == 2
        assert _cdn_asked(server, SECOND_SERIES_ID) == {1: 1, 2: 1, 3: 1}  # never asked again
        cooldown = ext.cooldown()
        assert cooldown is not None and cooldown["source"] == "discovery"
        assert page.locator("#failed-heading").text_content() == "Did not download (1)"
        assert page.locator("#failed-auto").is_hidden()  # nothing will be retried on its own

        retrying, incomplete, alert = recorded_alerts(ext, 3)
        assert len(page.evaluate(ALERTS_JS)) == 3
        assert retrying["options"]["title"] == f"↻ {SECOND_SERIES_NAME} — retrying 1 episode"
        assert incomplete["id"].endswith(f":{SERIES_ID}:incomplete")  # its list refused
        assert incomplete["options"]["title"].endswith(" — not complete")
        assert alert["id"] == retrying["id"]  # it replaces "retrying"
        options = alert["options"]
        assert (
            options["title"],
            options["message"],
            options["buttons"],
            options["contextMessage"],
        ) == (
            f"⚠ {SECOND_SERIES_NAME} — 1 episode to retry",
            "E02 did not download.",
            [{"title": "Retry"}],
            "Not retried automatically: rate limited (HTTP 429)",
        )
        assert not [seen for seen in page.evaluate(ALERTS_JS) if seen["id"].endswith(":stopped")]


def test_e_a_selection_job_s_plain_failure_gets_its_one_automatic_retry(tmp_path: Path) -> None:
    """(e) A `selection` job the user asked for — **See episodes** on the library's card, then
    **Download all available**, a job that downloads every chosen episode in full (`overwrite`,
    DramaFetch 3.0.0) — whose E02 transfer is cut short once: its drama, done where the job ends,
    queues ONE `Automatic retry: 1 of <drama>` behind it — a `selection` too, after the rest between
    jobs, and downloading in full as its job did (`overwrite` in both journal records) —, which
    saves E02 whole; the CDN asked twice for E02 in all. Notifications: `↻ … — retrying 1 episode`
    with no button, then — the same id — `✓ … — downloaded`, `After an automatic retry.`. Nothing
    follows: the drama, whole after its automatic retry, stays in the library as it was."""
    second = (SECOND_SERIES_ID, 2)
    with (
        FakeTikTok(truncate_once=frozenset({second})) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        page = ext.page
        ext.keep_library((SECOND_SERIES_ID, SECOND_SERIES_NAME, 3))
        ext.see_episodes(SECOND_SERIES_ID)
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        ext.download_available()
        _until_jobs(ext, jobs + 2, 90, "the download and its automatic retry did not end")
        journal = ext.journal()
        assert len(journal) == 3  # the listing, the download, its automatic retry: nothing more
        automatic, selected, listed = journal
        assert listed["kind"] == "load"
        assert (selected["kind"], selected["label"]) == (
            "selection",
            f"3 episodes of {SECOND_SERIES_NAME}",
        )
        ((series_id, rows),) = _rows(selected)
        assert series_id == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in rows] == [
            (1, "done"),
            (2, "failed"),
            (3, "done"),
        ]
        assert rows[1][2].startswith(f"{INCOMPLETE_PREFIX}truncated body (")
        assert selected["series"][0].get("overwrite") is True  # See episodes': in full (3.0.0)
        assert (automatic["kind"], automatic["label"]) == (
            "selection",
            f"Automatic retry: 1 of {SECOND_SERIES_NAME}",
        )
        assert automatic["stopped"] is None
        assert [pause["kind"] for pause in automatic["pauses"]] == ["job-rest"]
        ((series_id, rows),) = _rows(automatic)
        assert series_id == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in rows] == [(2, "done")]
        assert rows[0][2].endswith(" + cover embedded")
        assert automatic["series"][0].get("overwrite") is True  # in full, as its job was
        assert _cdn_asked(server, SECOND_SERIES_ID) == {1: 1, 2: 2, 3: 1}

        retrying, done = recorded_alerts(ext, 2)
        assert len(page.evaluate(ALERTS_JS)) == 2
        assert retrying["id"].endswith(f":{SECOND_SERIES_ID}:retry")
        assert retrying["options"]["title"] == f"↻ {SECOND_SERIES_NAME} — retrying 1 episode"
        assert "buttons" not in retrying["options"]
        assert done["id"] == retrying["id"]
        assert (
            done["options"]["title"],
            done["options"]["message"],
            done["options"]["contextMessage"],
        ) == (
            f"✓ {SECOND_SERIES_NAME} — downloaded",
            "All 3 episodes are on disk.",
            "After an automatic retry.",
        )
        assert sorted(Path(path).name for path in _videos(ext)) == [
            f"{SECOND_SERIES_NAME} - Episode {number:02d}.mp4" for number in (1, 2, 3)
        ]


def test_e2_a_failure_of_the_tab_s_own_retry_gets_its_one_automatic_retry(tmp_path: Path) -> None:
    """(e2) A `selection` job the user asked for — the progress card's **Retry**, a `selection` job
    that is no automatic retry — whose E02 transfer is cut short again: its drama, done where the
    job ends, queues ONE `Automatic retry: 1 of <drama>` behind it — a `selection` too, after the
    rest between jobs —, which saves E02 whole; the CDN asked three times for E02 in all (the
    paste's transfer, the Retry's, the automatic retry's). The paste before it ran with **Retry on
    its own what did not download** turned off — so that what retried its failure is the user's
    **Retry** —, and the setting was turned back on before that **Retry**. Notifications: the
    paste's ⚠ with its **Retry**; then the Retry's drama, `↻ … — retrying 1 episode` with no
    button, and — the same id — `✓ … — downloaded`, `After an automatic retry.`. Nothing
    follows. (DramaFetch 4.0.0's (e), where (e) takes **See episodes**' **Download all
    available**.)"""
    second = (SECOND_SERIES_ID, 2)
    with (
        FakeTikTok(truncate_twice=frozenset({second})) as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=RESTING) as ext,
    ):
        page = ext.page
        ext.turn_off_auto_retry()  # the paste's failure waits for the user's Retry
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        pasted = ext.paste_and_wait(SECOND_LINK)
        assert [entry["label"] for entry in ext.journal()] == [pasted["label"]]  # nothing queued
        assert [(number, status) for number, status, _ in _rows(pasted)[0][1]] == [
            (1, "done"),
            (2, "failed"),
            (3, "done"),
        ]
        assert page.locator("#failed-auto").is_hidden()  # nothing will be retried on its own
        ext.turn_on_auto_retry()
        retry = page.locator("#retry-button")
        assert retry.is_enabled()
        retry.click()  # the user's Retry: a selection job over E02
        _until_jobs(ext, jobs + 3, 120, "the retry and its automatic retry did not end")
        journal = ext.journal()
        assert len(journal) == 3  # the paste, its Retry, the Retry's automatic retry: no more
        automatic, retried, _pasted = journal
        assert (retried["kind"], retried["label"]) == (
            "selection",
            f"Retry 1 of {SECOND_SERIES_NAME}",
        )
        ((series_id, rows),) = _rows(retried)
        assert series_id == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in rows] == [(2, "failed")]
        assert rows[0][2].startswith(f"{INCOMPLETE_PREFIX}truncated body (")
        assert (automatic["kind"], automatic["label"]) == (
            "selection",
            f"Automatic retry: 1 of {SECOND_SERIES_NAME}",
        )
        assert automatic["stopped"] is None
        assert [pause["kind"] for pause in automatic["pauses"]] == ["job-rest"]
        ((series_id, rows),) = _rows(automatic)
        assert series_id == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in rows] == [(2, "done")]
        assert rows[0][2].endswith(" + cover embedded")
        assert _cdn_asked(server, SECOND_SERIES_ID) == {1: 1, 2: 3, 3: 1}
        assert page.locator("#failed-block").is_hidden()

        plain, retrying, done = recorded_alerts(ext, 3)
        assert len(page.evaluate(ALERTS_JS)) == 3
        assert plain["id"].endswith(f":{SECOND_SERIES_ID}:retry")  # the paste's own
        assert (plain["options"]["title"], plain["options"]["buttons"]) == (
            f"⚠ {SECOND_SERIES_NAME} — 1 episode to retry",
            [{"title": "Retry"}],
        )
        assert "contextMessage" not in plain["options"]
        assert retrying["id"].endswith(f":{SECOND_SERIES_ID}:retry")  # the Retry's
        assert retrying["id"] != plain["id"]
        assert retrying["options"]["title"] == f"↻ {SECOND_SERIES_NAME} — retrying 1 episode"
        assert "buttons" not in retrying["options"]
        assert done["id"] == retrying["id"]
        assert (
            done["options"]["title"],
            done["options"]["message"],
            done["options"]["contextMessage"],
        ) == (
            f"✓ {SECOND_SERIES_NAME} — downloaded",
            "All 3 episodes are on disk.",
            "After an automatic retry.",
        )
        assert sorted(Path(path).name for path in _videos(ext)) == [
            f"{SECOND_SERIES_NAME} - Episode {number:02d}.mp4" for number in (1, 2, 3)
        ]


def test_f_stop_while_the_last_episode_downloads_leaves_no_automatic_retry(
    tmp_path: Path,
) -> None:
    """(f) **Stop** pressed the instant the page asks the CDN for a batch's last episode — its
    transfer under way, the engine past its last look at Stop, so the batch runs its course and
    ends unstopped —: a stop all the same. A paste of two dramas: the first's E02, cut short,
    queued its automatic retry (`↻`); the Stop takes it out of the queue at once — at the batch's
    end, `not started: … (stopped by you)` in the journal and its notification the ⚠ alert with
    **Retry** and `Not retried automatically: stopped by you` —, and the second drama, whose E03
    (that last episode) is cut short too, queues none: its plain ⚠ alert with **Retry**. Nothing
    more is asked of TikTok: every episode asked for once, no other job."""
    cut = frozenset({(SERIES_ID, 2), (SECOND_SERIES_ID, 3)})
    with (
        FakeTikTok(truncate_once=cut) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        page.evaluate(STOP_ON_FETCH_JS, _item_of(SECOND_SERIES_ID, 3))
        jobs = ext.finished_jobs()
        ext.paste(f"{MAIN_LINK}\n{SECOND_LINK}")
        _until_jobs(ext, jobs + 1, 120, "the paste's download did not end")
        probe = page.evaluate("() => globalThis.__stopOnFetch")
        assert probe == {"pressed": True, "enabled": True}  # pressed while the batch ran
        assert ext.finished_jobs() == jobs + 1  # no job after it
        journal = ext.journal()
        assert len(journal) == 2
        batch, cancelled = journal
        assert batch["kind"] == "batch"
        assert batch["stopped"] is None  # the engine never met the Stop
        first, last = _rows(batch)
        assert first[0] == SERIES_ID
        assert [(number, status) for number, status, _ in first[1]] == [
            (1, "done"),
            (2, "failed"),
            (3, "done"),
            (4, "done"),
            (5, "skipped-locked"),
        ]
        assert last[0] == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in last[1]] == [
            (1, "done"),
            (2, "done"),
            (3, "failed"),
        ]
        assert cancelled["label"] == f"Automatic retry: 1 of {SERIES_NAME}"
        assert cancelled["error"] == (
            f"not started: batch stopped in {batch['label']} (stopped by you)"
        )
        assert cancelled["series"] == []
        assert _cdn_asked(server, SERIES_ID) == {1: 1, 2: 1, 3: 1, 4: 1}
        assert _cdn_asked(server, SECOND_SERIES_ID) == {1: 1, 2: 1, 3: 1}
        assert page.locator("#queue-list li").count() == 0
        assert page.locator("#failed-heading").text_content() == "Did not download (2)"
        assert page.locator("#failed-auto").is_hidden()  # nothing is retried on its own

        # "retrying", the second drama's own alert as it is done, then — at the batch's end — what
        # the Stop made of the first drama's automatic retry, in the place of "retrying"
        retrying, plain, not_retried = recorded_alerts(ext, 3)
        assert len(page.evaluate(ALERTS_JS)) == 3
        assert retrying["id"].endswith(f":{SERIES_ID}:retry")
        assert retrying["options"]["title"] == f"↻ {SERIES_NAME} — retrying 1 episode"
        assert not_retried["id"] == retrying["id"]
        options = not_retried["options"]
        assert (
            options["title"],
            options["message"],
            options["buttons"],
            options["contextMessage"],
        ) == (
            f"⚠ {SERIES_NAME} — 1 episode to retry",
            "E02 did not download.",
            [{"title": "Retry"}],
            "Not retried automatically: stopped by you",
        )
        assert plain["id"].endswith(f":{SECOND_SERIES_ID}:retry")
        options = plain["options"]
        assert (options["title"], options["message"], options["buttons"]) == (
            f"⚠ {SECOND_SERIES_NAME} — 1 episode to retry",
            "E03 did not download.",
            [{"title": "Retry"}],
        )
        assert "contextMessage" not in options
        assert not [seen for seen in page.evaluate(ALERTS_JS) if seen["id"].endswith(":stopped")]


def test_g_stop_during_an_automatic_retry_names_only_what_it_did_not_save(tmp_path: Path) -> None:
    """(g) An automatic retry of E02 and E03 (both cut short once in the paste) that **Stop** ends
    in its pause after it saved E02: its notification — the id of `↻` — is the ⚠ alert of E03
    alone with **Retry**, the stop's reason (`stopped by you`) its context, never `Not retried
    automatically` (it ran); that **Retry**, clicked as Chrome hands it to the service worker,
    queues the tab's retry of E03, which saves it."""
    cut = frozenset({(SECOND_SERIES_ID, 2), (SECOND_SERIES_ID, 3)})
    pauses = {"delayMinS": 3, "delayMaxS": 3}  # a pause between two episodes, to press Stop in
    with (
        FakeTikTok(truncate_once=cut) as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=pauses) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        jobs = ext.finished_jobs()
        ext.paste(SECOND_LINK)
        saved_again = page.locator("#result-table tbody tr[data-number='2'][data-status='done']")
        ext.wait_for(
            lambda: ext.finished_jobs() == jobs + 1 and saved_again.count() == 1,
            120,
            "the automatic retry did not save E02",
        )
        page.click("#stop-button")  # in its pause before E03
        _until_jobs(ext, jobs + 2, 60, "the Stop did not end the automatic retry")
        journal = ext.journal()
        assert len(journal) == 2
        automatic, pasted = journal
        assert [(number, status) for number, status, _ in _rows(pasted)[0][1]] == [
            (1, "done"),
            (2, "failed"),
            (3, "failed"),
        ]
        assert automatic["label"] == f"Automatic retry: 2 of {SECOND_SERIES_NAME}"
        assert automatic["stopped"] == "stopped by you"
        assert _cdn_asked(server, SECOND_SERIES_ID) == {1: 1, 2: 2, 3: 1}
        assert sorted(Path(path).name for path in _videos(ext)) == [
            f"{SECOND_SERIES_NAME} - Episode {number:02d}.mp4" for number in (1, 2)
        ]
        # 3.0.1 (the lead's D11): the Stop keeps the Did not download block true — the retry's
        # rows before the Stop are its record (E02 saved), so E02 leaves the block and E03, never
        # reached, keeps its row; the block's Retry takes E03 alone
        assert page.locator("#failed-heading").text_content() == "Did not download (1)"
        assert page.locator("#failed-table tbody tr").evaluate_all(
            "(rows) => rows.map((row) => row.dataset.number)"
        ) == ["3"]
        assert page.locator("#retry-button").text_content() == (
            "Retry the episodes that did not download (1)"
        )
        assert [(number, status) for number, status, _ in _rows(automatic)[0][1]] == [(2, "done")]

        retrying, alert = recorded_alerts(ext, 2)
        assert len(page.evaluate(ALERTS_JS)) == 2
        assert retrying["options"]["title"] == f"↻ {SECOND_SERIES_NAME} — retrying 2 episodes"
        assert alert["id"] == retrying["id"]
        options = alert["options"]
        assert (
            options["title"],
            options["message"],
            options["buttons"],
            options["contextMessage"],
        ) == (
            f"⚠ {SECOND_SERIES_NAME} — 1 episode to retry",
            "E03 did not download.",
            [{"title": "Retry"}],
            "stopped by you",
        )

        # its Retry: E03 alone, the alert taken away
        in_worker(ext, RETRY_CLICK_JS, alert["id"])
        _until_jobs(ext, jobs + 3, 90, "the alert's retry did not end")
        assert page.evaluate(CLEARED_JS) == [alert["id"]]
        entry = ext.journal()[0]
        assert entry["label"] == f"Retry 1 of {SECOND_SERIES_NAME}"
        assert [(number, status) for number, status, _ in _rows(entry)[0][1]] == [(3, "done")]
        assert _cdn_asked(server, SECOND_SERIES_ID) == {1: 1, 2: 2, 3: 2}
        assert sorted(Path(path).name for path in _videos(ext)) == [
            f"{SECOND_SERIES_NAME} - Episode {number:02d}.mp4" for number in (1, 2, 3)
        ]
        assert page.locator("#failed-block").is_hidden()  # every episode on disk: none left


def test_h_stop_at_a_job_s_very_end_leaves_no_automatic_retry(tmp_path: Path) -> None:
    """(h) **Stop** pressed at the very end of a job — as it saves its report of what did not
    download, its journal entry and **Did not download** block drawn, the automatic retry of its
    drama waiting (`#failed-auto` said so) —: that retry leaves the queue at once and never
    starts; once the job is over, its journal entry says `not started: … (stopped by you)` and its
    notification, in the place of `↻`, is the ⚠ alert with **Retry** and `Not retried
    automatically: stopped by you`. E02 asked for once; no job after the paste's."""
    second = (SECOND_SERIES_ID, 2)
    with (
        FakeTikTok(truncate_once=frozenset({second})) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_ALERTS_JS)
        page.evaluate(STOP_ON_REPORT_JS)
        jobs = ext.finished_jobs()
        ext.paste(SECOND_LINK)
        _until_jobs(ext, jobs + 1, 90, "the paste's download did not end")
        probe = page.evaluate("() => globalThis.__stopOnReport")
        assert probe == {"pressed": True, "enabled": True}  # pressed while the job ended
        assert ext.finished_jobs() == jobs + 1  # no job after it
        journal = ext.journal()
        assert len(journal) == 2
        cancelled, pasted = journal
        assert pasted["kind"] == "batch"
        assert pasted["stopped"] is None  # the job had run its course
        assert [(number, status) for number, status, _ in _rows(pasted)[0][1]] == [
            (1, "done"),
            (2, "failed"),
            (3, "done"),
        ]
        assert cancelled["label"] == f"Automatic retry: 1 of {SECOND_SERIES_NAME}"
        assert cancelled["error"] == (
            f"not started: batch stopped in {pasted['label']} (stopped by you)"
        )
        assert cancelled["series"] == []
        assert _cdn_asked(server, SECOND_SERIES_ID) == {1: 1, 2: 1, 3: 1}
        assert page.locator("#queue-list li").count() == 0
        assert page.locator("#failed-heading").text_content() == "Did not download (1)"
        assert page.locator("#failed-auto").is_hidden()  # it said the retry would come: no more
        assert [path.suffix for path in ext.saved_files() if "reports" in path.parts] == [".json"]

        retrying, not_retried = recorded_alerts(ext, 2)
        assert len(page.evaluate(ALERTS_JS)) == 2
        assert retrying["options"]["title"] == f"↻ {SECOND_SERIES_NAME} — retrying 1 episode"
        assert not_retried["id"] == retrying["id"]
        options = not_retried["options"]
        assert (
            options["title"],
            options["message"],
            options["buttons"],
            options["contextMessage"],
        ) == (
            f"⚠ {SECOND_SERIES_NAME} — 1 episode to retry",
            "E02 did not download.",
            [{"title": "Retry"}],
            "Not retried automatically: stopped by you",
        )


def test_i_a_job_s_line_counts_and_stays_for_its_own_automatic_retry_only(
    tmp_path: Path,
) -> None:
    """(i) Two pastes — the second while the first downloads —, each drama with one transfer cut
    short once: the first drama's automatic retry waits behind the second job, the second's behind
    it. At the second job's end its block's line says `1 of them will be retried automatically,
    once.` — its own automatic retry, never the first job's waiting too —, and the line goes the
    moment the first drama's automatic retry starts, staying gone while it runs: it stays only for
    its own job's automatic retry. Since 3.0.1 (the owner's report of 2026-11-27; renamed from
    `test_i_a_job_s_block_counts_…`) the block itself keeps every job's rows: at the second job's
    end it is **Did not download (2)** — the first drama's E02 is still there —, and it stays while
    the automatic retries run, each one's end replacing only its own drama's retried number. What
    the card says is recorded as it changes (`RECORD_BLOCK_JS`)."""
    cut = frozenset({(SECOND_SERIES_ID, 2), (SERIES_ID, 3)})
    with (
        FakeTikTok(truncate_once=cut) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        page = ext.page
        page.evaluate(RECORD_BLOCK_JS)
        jobs = ext.finished_jobs()
        ext.paste(SECOND_LINK)
        ext.wait_for(lambda: not ext.idle(), 10, "the first paste's download did not start")
        ext.paste(MAIN_LINK)  # behind it — before the first drama's automatic retry is queued
        _until_jobs(ext, jobs + 4, 180, "the downloads and their automatic retries did not end")
        first_retry = f"Automatic retry: 1 of {SECOND_SERIES_NAME}"
        second_retry = f"Automatic retry: 1 of {SERIES_NAME}"
        journal = ext.journal()
        assert [entry["label"] for entry in journal] == [
            second_retry,
            first_retry,
            f"Series {SERIES_ID}",
            f"Series {SECOND_SERIES_ID}",
        ]
        pasted_second = journal[2]
        assert [(number, status) for number, status, _ in _rows(pasted_second)[0][1]] == [
            (1, "done"),
            (2, "done"),
            (3, "failed"),
            (4, "done"),
            (5, "skipped-locked"),
        ]
        assert all(entry["stopped"] is None for entry in journal)
        assert _cdn_asked(server, SECOND_SERIES_ID) == {1: 1, 2: 2, 3: 1}
        assert _cdn_asked(server, SERIES_ID) == {1: 1, 2: 1, 3: 2, 4: 1}

        log: list[list[Any]] = page.evaluate("() => globalThis.__blockLog")
        starts = [index for index, (current, *_) in enumerate(log) if current == first_retry]
        assert starts, log
        started = starts[0]
        # the second job's end, right before: its block, its line counting its own retry alone.
        # 3.0.1 changes this ON PURPOSE (was `Did not download (1)`): the block keeps the first
        # drama's E02 too — every job's rows stay —, so its heading counts both rows; the line is
        # 1.8.0's, unchanged
        assert log[started - 1][1:] == [
            False,
            "Did not download (2)",
            "1 of them will be retried automatically, once.",
            False,
        ], log
        # the first drama's automatic retry starts: that line goes, and stays gone while it runs —
        # until the second drama's own automatic retry starts. 3.0.1 changes the block ON PURPOSE
        # (it went with the line before): it stays shown — both rows while the retry runs, the
        # second drama's E03 alone once the retry's end replaced the first drama's E02, saved
        later = [index for index, (current, *_) in enumerate(log) if current == second_retry]
        until = next((index for index in later if index > started), len(log))
        assert all(line_hidden for *_, line_hidden in log[started:until]), log[started:until]
        assert all(not hidden for _, hidden, *_ in log[started:until]), log[started:until]
        assert log[started][2] == "Did not download (2)", log[started:until]
        assert log[until - 1][2] == "Did not download (1)", log[started:until]
        # and once the second drama's automatic retry saved E03, nothing is left: the block goes
        assert log[-1][1] is True, log
        # never a line counting another job's automatic retry
        assert all(line != "2 of them will be retried automatically, once." for *_, line, _ in log)


def test_j_stop_in_a_batch_s_second_drama_keeps_the_first_drama_s_rows(tmp_path: Path) -> None:
    """(j) 3.0.1 (the owner's report of 2026-11-27): **Stop** met by the engine in a batch's second
    drama — in its pause after E01 — keeps the **Did not download** block true: the first drama,
    finished with E02 cut short (its automatic retry queued, then taken out of the queue by the
    Stop), keeps its row there with the block's **Retry**; the second drama's E01, saved before
    the Stop, has none, and the drama Stop cut short gets no new row. Nothing more is asked of
    TikTok."""
    cut = frozenset({(SERIES_ID, 2)})
    pauses = {"delayMinS": 3, "delayMaxS": 3}  # a pause between two episodes, to press Stop in
    with (
        FakeTikTok(truncate_once=cut) as server,
        ExtensionHarness(tmp_path, server.base_url, test_settings=pauses) as ext,
    ):
        page = ext.page
        jobs = ext.finished_jobs()
        ext.paste(f"{MAIN_LINK}\n{SECOND_LINK}")
        ext.wait_for(
            lambda: (
                _cdn_asked(server, SECOND_SERIES_ID).get(1, 0) > 0
                and page.locator("#progress-pause").is_visible()
            ),
            120,
            "the second drama's pause after E01 never came",
        )
        page.click("#stop-button")  # in that pause: the engine meets it
        _until_jobs(ext, jobs + 1, 60, "the Stop did not end the batch")
        journal = ext.journal()
        (batch,) = [entry for entry in journal if entry["kind"] == "batch"]
        assert batch["stopped"] == "stopped by you"
        # the first drama's automatic retry was queued, then taken out of the queue by the Stop
        (cancelled,) = [
            entry for entry in journal if entry["label"] == f"Automatic retry: 1 of {SERIES_NAME}"
        ]
        assert cancelled["error"] == (
            f"not started: batch stopped in {batch['label']} (stopped by you)"
        )
        assert cancelled["series"] == []
        # the first drama's record — every row —, the second's rows of what it saved
        first, second = _rows(batch)
        assert first[0] == SERIES_ID
        assert [(number, status) for number, status, _ in first[1]] == [
            (1, "done"),
            (2, "failed"),
            (3, "done"),
            (4, "done"),
            (5, "skipped-locked"),
        ]
        assert second[0] == SECOND_SERIES_ID
        assert [(number, status) for number, status, _ in second[1]] == [(1, "done")]
        assert page.locator("#failed-block").is_visible()
        assert page.locator("#failed-heading").text_content() == "Did not download (1)"
        assert page.locator("#failed-table tbody tr").evaluate_all(
            "(rows) => rows.map((row) => [row.dataset.seriesId, row.dataset.number])"
        ) == [[SERIES_ID, "2"]]
        assert page.locator("#retry-button").text_content() == (
            "Retry the episodes that did not download (1)"
        )
        assert page.locator("#failed-auto").is_hidden()  # its automatic retry left the queue
        assert _cdn_asked(server, SERIES_ID) == {1: 1, 2: 1, 3: 1, 4: 1}  # E02 never asked again
        assert _cdn_asked(server, SECOND_SERIES_ID) == {1: 1}
