"""The extension's memory in `chrome.storage.local`, end to end (`pytest -m integration`; skipped
without a browser): past Chrome's 10 MB quota with the `unlimitedStorage` permission, and what a
run does when Chrome refuses a write all the same.

A write is refused here in two ways. The real one a sandbox can make Chrome produce: a test copy
WITHOUT `unlimitedStorage` (`ExtensionHarness(drop_permissions=…)`) whose store is filled to the
quota. And, for a refusal that has to come at a precise moment of a run, the page's
`chrome.storage.local.set` / `remove` wrapped to reject, with the text Chrome 153 gives on a full
disk, from the moment the test chooses — the code under test (the engine and the page handling a
rejected write) is the shipped one either way. The fake TikTok counts every request; no cookie
value is involved.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from .extension_harness import CHROMIUM, ExtensionHarness
from .fake_tiktok import (
    SERIES_ID,
    SERIES_NAME,
    THIRD_SERIES_ID,
    FakeTikTok,
)

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not CHROMIUM.is_file(), reason=f"no Chromium at {CHROMIUM} (set DRAMAFETCH_CHROMIUM)"
    ),
]

MAIN_LINK = f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1"
THIRD_LINK = THIRD_SERIES_ID
MAIN_FOLDER = Path("DramaFetch") / f"{SERIES_NAME} [{SERIES_ID}]"
MAIN_ITEMS = {n: f"769940000000000000{n}" for n in range(1, 6)}
MAIN_LINE = "complete: 4 of 5 (4 downloaded) — 1 locked (5)"
#: `chrome.storage.local.QUOTA_BYTES`: what Chrome holds the area to without `unlimitedStorage`.
QUOTA_BYTES = 10 * 1024 * 1024
#: The engine's stop when the storage refuses a write (`engine.STORAGE_REFUSED_PREFIX`).
UNSAVED_PREFIX = "the progress could not be saved: "
#: What Chrome 153 rejects a `chrome.storage.local.set` with when the disk under its profile is
#: full (measured 2026-11-11; Chrome itself cuts the folder to `...`).
FULL_DISK = (
    "IO error: .../000003.log: FILE_ERROR_NO_SPACE (ChromeMethodBFE: 3::WritableFileAppend::8)"
)
MEDIA_RATE_LIMIT = (
    "rate limited (HTTP 429) by the video server: wait 30-60 minutes before trying again"
)
#: The page's own message around the engine's reason (`_locales/en/messages.json` `storageRefused`).
STOPPED_HEAD = "DramaFetch stopped: "
STOPPED_TAIL = (
    ". Chrome could not write to its profile folder — usually its disk is full. Free some space, "
    "restart Chrome and run again: what is already saved is skipped."
)


def _stopped_with_cooldown(reason: str, until: str) -> str:
    """The message when a cooldown is in force too (`storageRefusedCooldown`)."""
    return (
        f"{STOPPED_HEAD}{reason}. Chrome could not write to its profile folder — usually its disk "
        f"is full. TikTok also refused a request, and the wait until {until} could not be saved: "
        f"free some space, restart Chrome only after {until} and run again — what is already "
        "saved is skipped."
    )


#: Fill `chrome.storage.local` with the states of finished 60-episode series — invented ids, built
#: and written by the extension's own `lib/state.js` and `app/storage.js` — until the area holds
#: at least `untilBytes`, or until Chrome refuses a write (`refused`: its message). With `pad`, a
#: last key then takes what room is left, down to less than `pad` bytes.
FILL_JS = r"""
async ({ untilBytes, pad }) => {
  const base = chrome.runtime.getURL("src/");
  const state = await import(base + "lib/state.js");
  const storage = await import(base + "app/storage.js");
  const used = () => chrome.storage.local.getBytesInUse(null);
  const quota = chrome.storage.local.QUOTA_BYTES;
  let refused = null;
  let series = 0;
  while ((await used()) < untilBytes) {
    const seriesId = String(7599400000000000000n + BigInt(series));
    const name = `Invented Series Number ${series}`;
    const st = state.newState(seriesId, name);
    for (let number = 1; number <= 60; number += 1) {
      const file = `${name} - Episode ${String(number).padStart(2, "0")}.mp4`;
      const itemId = String(7699400000000000000n + BigInt(series) * 1000n + BigInt(number));
      state.record(st, {
        episode: { number, itemId },
        status: "done",
        path: `C:\\Users\\Owner\\Downloads\\DramaFetch\\${name} [${seriesId}]\\${file}`,
        message: `saved ${file} (12.3 MiB) + cover embedded`,
        downloadId: series * 100 + number,
      }, { exists: () => false, now: 1794400000 + series * 3600 + number * 20 });
    }
    state.markComplete(st, 1794400000 + series * 3600 + 1300, 60);
    try {
      await storage.writeSeriesState(st);
    } catch (error) {
      refused = String(error && error.message);
      break;
    }
    series += 1;
  }
  if (pad !== null) {
    // what is left goes to one key ("filler" + the JSON string and its quotes)
    let room = quota - (await used());
    while (room >= pad && room > 16) {
      const current = (await chrome.storage.local.get("filler")).filler ?? "";
      const more = Math.max(1, room - 16 - (current === "" ? 8 : 0));
      await chrome.storage.local.set({ filler: current + "x".repeat(more) }).catch(() => null);
      const left = quota - (await used());
      if (left === room) break; // nothing more fits
      room = left;
    }
  }
  const bytes = await used();
  const keys = (await chrome.storage.local.getKeys()).length;
  return { series, refused, bytes, quota, room: quota - bytes, keys };
}
"""

#: From the moment the page has made `acceptStateWrites` writes of a series' state, every write
#: of `chrome.storage.local` rejects as on a full disk — the state's, the pacing's, the cooldown's
#: and the history's alike. `globalThis.__refused()` counts them.
FULL_DISK_JS = r"""
({ acceptStateWrites, message }) => {
  const local = chrome.storage.local;
  const set = local.set.bind(local);
  const remove = local.remove.bind(local);
  let stateWrites = 0;
  let full = false;
  let refused = 0;
  const refuse = () => {
    refused += 1;
    return Promise.reject(new Error(message));
  };
  local.set = (items) => {
    if (!full && Object.keys(items).some((key) => key.startsWith("series:"))) {
      stateWrites += 1;
      if (stateWrites > acceptStateWrites) full = true;
    }
    return full ? refuse() : set(items);
  };
  local.remove = (keys) => (full ? refuse() : remove(keys));
  globalThis.__refused = () => refused;
  return true;
}
"""


# ------------------------------------------------------------------------------- helpers


def _watch_errors(ext: ExtensionHarness) -> list[str]:
    """Every uncaught error of the app page from now on."""
    errors: list[str] = []
    ext.page.on("pageerror", lambda error: errors.append(str(error)))
    return errors


def _click_and_wait(ext: ExtensionHarness, selector: str, finished: int) -> None:
    """Click, then wait until `finished` jobs have ended, nothing runs and nothing waits. (The
    harness' own `_run` reads the job's history entry: a storage that refuses has none.)"""
    ext.page.click(selector)
    ext.wait_for(
        lambda: (
            ext.finished_jobs() >= finished
            and ext.idle()
            and ext.page.locator("#queue-card").is_hidden()
        ),
        message=f"the job of {selector} did not finish",
    )


def _status_line(ext: ExtensionHarness) -> str:
    return ext.page.locator("#input-status").text_content() or ""


def _queue_two(ext: ExtensionHarness, first: str, second: str) -> None:
    """**Download all** for `first`, then for `second`, in one go: the second job is queued while
    the first runs, whatever the first does (no race with a quick refusal)."""
    ext.page.evaluate(
        """([first, second]) => {
          const links = document.getElementById("links");
          const button = document.getElementById("download-all-button");
          for (const value of [first, second]) {
            links.value = value;
            button.click();
          }
        }""",
        [first, second],
    )


def _wait_finished(ext: ExtensionHarness, finished: int) -> None:
    """Until `finished` jobs have ended, nothing runs and nothing waits."""
    ext.wait_for(
        lambda: (
            ext.finished_jobs() >= finished
            and ext.idle()
            and ext.page.locator("#queue-card").is_hidden()
        ),
        message=f"{finished} job(s) did not finish",
    )


def _popup_load(ext: ExtensionHarness, expected_status: str | None) -> None:
    """The popup's **Download this series** for the main series, as test_e of test_extension.py
    sends it; waits until the app page has the link (and, unless None, shows `expected_status`)."""
    ext.page.fill("#links", "")
    popup = ext.context.new_page()
    popup.goto(f"chrome-extension://{ext.extension_id}/src/app/popup.html")
    popup.evaluate(
        "(id) => chrome.runtime.sendMessage({type: 'dramafetch:open', load: id})", SERIES_ID
    )
    ext.wait_for(
        lambda: (
            ext.page.input_value("#links") == SERIES_ID
            and (expected_status is None or _status_line(ext) == expected_status)
        ),
        20,
        f"the popup's load did not end with {expected_status!r}",
    )
    popup.close()


def _table_rows(ext: ExtensionHarness, table: str) -> list[tuple[str, str]]:
    """(episode number, status) of every episode row of `table`, in order."""
    rows = ext.page.locator(f"{table} tbody tr[data-number]")
    return [
        (
            rows.nth(index).get_attribute("data-number") or "",
            rows.nth(index).get_attribute("data-status") or "",
        )
        for index in range(rows.count())
    ]


def _media_counts(server: FakeTikTok) -> list[int]:
    """How many times each episode of the main series was asked of the video server."""
    return [
        len([r for r in server.media_requests if r.path.startswith(f"/cdn/{MAIN_ITEMS[n]}/")])
        for n in range(1, 6)
    ]


def _videos(ext: ExtensionHarness) -> list[str]:
    return [path.name for path in ext.saved_files() if path.suffix == ".mp4"]


def _on_disk(state: dict[str, Any]) -> dict[int, str]:
    """The episodes a stored series state knows to be on disk, with the status that says so:
    `done`, or `skipped-exists` for a file a run found there."""
    return {
        int(number): entry["status"]
        for number, entry in sorted(state["episodes"].items(), key=lambda item: int(item[0]))
        if entry["status"] in ("done", "skipped-exists") and entry["path"]
    }


def _bytes_in_use(ext: ExtensionHarness) -> int:
    used: int = ext.page.evaluate("() => chrome.storage.local.getBytesInUse(null)")
    return used


# ----------------------------------------------------------------------------- scenarios


def test_a_progress_past_chromes_10_mb_is_stored_and_a_series_still_completes(
    tmp_path: Path,
) -> None:
    """With the shipped permissions (`unlimitedStorage`) the per-series progress is not held to
    `chrome.storage.local`'s 10 MB: about 510 finished 60-episode series are stored (11 MB), and
    on top of them a series downloads, is recorded and, run again, is skipped as complete without
    a request. Without the permission (DramaFetch 1.3.0) the store is full near 490 such series
    and nothing more can be recorded."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        errors = _watch_errors(ext)
        permissions = ext.page.evaluate("() => chrome.runtime.getManifest().permissions")
        assert "unlimitedStorage" in permissions
        filled = ext.page.evaluate(FILL_JS, {"untilBytes": QUOTA_BYTES + 512 * 1024, "pad": None})
        assert filled["refused"] is None, f"Chrome refused a write: {filled}"
        assert filled["quota"] == QUOTA_BYTES < filled["bytes"]
        assert filled["series"] > 400

        entry = ext.download_all(MAIN_LINK)
        (series,) = entry["series"]
        assert series["line"] == MAIN_LINE
        assert entry["stopped"] is None and entry["error"] is None
        state = ext.series_state(SERIES_ID)
        assert state is not None and _on_disk(state) == dict.fromkeys((1, 2, 3, 4), "done")
        assert state["complete_at"] is not None
        assert _bytes_in_use(ext) > filled["bytes"]
        assert _media_counts(server) == [1, 1, 1, 1, 0]
        assert len(_videos(ext)) == 4

        requests = len(server.requests)
        again = ext.download_all(MAIN_LINK)  # the memory works past the quota: the complete skip
        assert again["series"][0]["status"] == "skipped (complete)"
        assert len(server.requests) == requests
        assert errors == []


def test_b_a_write_refused_mid_series_stops_the_run_and_the_next_run_resumes(
    tmp_path: Path,
) -> None:
    """The disk under the Chrome profile fills while episode 3 downloads: its file is saved and
    keeps its row, nothing more is asked of TikTok — episode 4 is `stopped: the progress could not
    be saved: <Chrome's reason>`, shown apart with its retry button and in the report —, the page
    says what to do, the job waiting behind it never starts, the buttons that would start a job
    are disabled and the popup's **Download this series** makes no request. Once writes work again
    (the page reloaded) the same series resumes: the two recorded episodes
    from the state, episode 3 found on disk through Chrome's download history, episode 4
    downloaded — nothing twice, no `(1).mp4`."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        errors = _watch_errors(ext)
        page = ext.page
        assert page.evaluate(FULL_DISK_JS, {"acceptStateWrites": 2, "message": FULL_DISK})
        _queue_two(ext, MAIN_LINK, THIRD_LINK)  # a second job, waiting behind the first
        _wait_finished(ext, 1)

        reason = f"{UNSAVED_PREFIX}{FULL_DISK}"
        assert ext.finished_jobs() == 1  # the waiting job never ran
        assert not server.series_requests(THIRD_SERIES_ID)
        assert _media_counts(server) == [1, 1, 1, 0, 0]  # E03 was asked for and saved; E04 never
        assert len(_videos(ext)) == 3
        assert _table_rows(ext, "#result-table") == [
            ("1", "done"),
            ("2", "done"),
            ("3", "done"),
            ("5", "skipped-locked"),
        ]
        assert _table_rows(ext, "#failed-table") == [("4", "failed")]
        failed = page.locator("#failed-table tbody tr").first
        assert failed.locator("td.message").text_content() == f"stopped: {reason}"
        assert failed.locator(".badge").text_content() == "stopped"
        assert page.locator("#failed-heading").text_content() == "Did not download (1)"
        for button in ("#retry-button", "#download-all-button", "#load-button"):
            assert page.locator(button).is_disabled(), button  # nothing can start a job here now
        assert page.locator(
            "#report-button"
        ).is_enabled()  # a save of the report is no storage write
        assert _status_line(ext) == f"{STOPPED_HEAD}{reason}{STOPPED_TAIL}"
        assert "error" in (page.locator("#input-status").get_attribute("class") or "")
        ext.wait_for(lambda: page.locator("#failed-report").is_visible(), 10)
        reports = [p for p in ext.saved_files() if p.parts[:2] == ("DramaFetch", "reports")]
        assert len(reports) == 1  # the report is a download, not a storage write
        state = ext.series_state(SERIES_ID)
        assert state is not None and sorted(state["episodes"]) == ["1", "2"]  # E03's write: refused
        assert state.get("complete_at") is None
        assert ext.history() == []  # refused too: the history gives way, the job's end does not
        assert ext.cooldown() is None
        assert page.locator("#cooldown-banner").is_hidden()

        requests = len(server.requests)
        _popup_load(ext, f"{STOPPED_HEAD}{reason}{STOPPED_TAIL}")  # queued nowhere: no request
        assert len(server.requests) == requests
        assert ext.finished_jobs() == 1 and page.locator("#queue-card").is_hidden()
        assert _table_rows(ext, "#failed-table") == [("4", "failed")]  # the stopped run stays shown
        assert page.evaluate("() => globalThis.__refused()") > 0
        assert errors == []

        page.close()  # writes work again in a reloaded page (the wrapper was the old page's)
        ext.reopen_app()
        entry = ext.download_all(MAIN_LINK)
        (series,) = entry["series"]
        rows = {row["number"]: row for row in series["rows"]}
        assert [rows[n]["status"] for n in sorted(rows)] == [
            "skipped-exists",
            "skipped-exists",
            "skipped-exists",
            "done",
            "skipped-locked",
        ]
        assert rows[1]["message"].startswith("already downloaded (manifest): ")
        assert rows[3]["message"] == f"already exists: {SERIES_NAME} - Episode 03.mp4"
        assert series["line"] == "complete: 4 of 5 (1 downloaded, 3 already on disk) — 1 locked (5)"
        assert _media_counts(server) == [1, 1, 1, 1, 0]  # nothing was downloaded twice
        assert sorted(_videos(ext)) == [
            f"{SERIES_NAME} - Episode {n:02d}.mp4" for n in (1, 2, 3, 4)
        ]
        state = ext.series_state(SERIES_ID)
        assert state is not None and state["complete_at"] is not None
        # E03, whose record the storage had refused, is in the memory now: found on disk
        assert _on_disk(state) == {1: "done", 2: "done", 3: "skipped-exists", 4: "done"}


def test_c_a_429_while_the_storage_refuses_still_starts_the_cooldown(tmp_path: Path) -> None:
    """TikTok's video server answers HTTP 429 and the storage refuses every write from that
    result on: the cooldown cannot be stored — and is in force all the same, from the browser
    session's memory: the banner, the download buttons disabled, the popup's "Download this
    series" refused with no request, the page's advice naming the cooldown's end; and after a
    reload of the tab (writes work again) the banner is back, the cooldown is stored at last (a
    restart of Chrome keeps it now) and a listing is refused by the cooldown, still with no
    request. The rest of the series is `stopped` by the 429."""
    with (
        FakeTikTok(cdn_rate_limit=True) as server,
        ExtensionHarness(tmp_path, server.base_url) as ext,
    ):
        errors = _watch_errors(ext)
        page = ext.page
        assert page.evaluate(FULL_DISK_JS, {"acceptStateWrites": 0, "message": FULL_DISK})
        page.fill("#links", MAIN_LINK)
        _click_and_wait(ext, "#download-all-button", 1)

        assert _media_counts(server) == [1, 0, 0, 0, 0]
        assert _table_rows(ext, "#failed-table") == [
            ("1", "failed-rate-limited"),
            ("2", "failed-rate-limited"),
            ("3", "failed-rate-limited"),
            ("4", "failed-rate-limited"),
        ]
        messages = page.locator("#failed-table tbody tr td.message")
        assert messages.nth(0).text_content() == MEDIA_RATE_LIMIT
        assert messages.nth(1).text_content() == (
            f"stopped: episode 1 failed-rate-limited: {MEDIA_RATE_LIMIT}"
        )
        assert ext.cooldown() is None  # the storage would not take the record…
        ext.wait_for(lambda: page.locator("#cooldown-banner").is_visible(), 10)  # …it holds anyway
        banner = page.locator("#cooldown-text").text_content() or ""
        assert banner.startswith("TikTok refused a request at ") and MEDIA_RATE_LIMIT in banner
        assert page.locator("#download-all-button").is_disabled()
        assert page.locator("#load-button").is_disabled()
        assert page.locator("#retry-button").is_disabled()
        until = re.search(r"waits until (\d\d:\d\d)", banner)
        assert until is not None, banner
        advice = _stopped_with_cooldown(f"{UNSAVED_PREFIX}{FULL_DISK}", until.group(1))
        assert _status_line(ext) == advice  # restart Chrome only after the cooldown's end
        pacing = ext.storage("pacing").get("pacing")
        assert (
            pacing is not None and pacing["runAttempts"] == 0
        )  # stored before the 429: the old one
        assert page.locator("#app-status").get_attribute("data-finished") == "1"

        requests = len(server.requests)
        _popup_load(ext, advice)  # refused: nothing queued, nothing asked of TikTok
        assert len(server.requests) == requests
        assert errors == []

        page.close()  # the tab reloaded: its memory is gone, the browser session's is not
        page = ext.reopen_app()
        ext.wait_for(lambda: page.locator("#cooldown-banner").is_visible(), 10)
        assert page.locator("#download-all-button").is_disabled()
        # written to chrome.storage.local at the first reading that the storage takes
        ext.wait_for(lambda: ext.cooldown() is not None, 10)
        stored = ext.cooldown()
        assert stored is not None and MEDIA_RATE_LIMIT in str(stored["reason"])
        _popup_load(ext, None)  # accepted by this fresh page, then refused by the cooldown's gate
        ext.wait_for(lambda: ext.finished_jobs() >= 1 and ext.idle(), 20)
        assert str(ext.history()[0]["error"]).startswith("TikTok refused a request at ")
        assert len(server.requests) == requests


def test_d_a_store_that_takes_nothing_asks_tiktok_for_nothing_and_the_permission_frees_it(
    tmp_path: Path,
) -> None:
    """A copy WITHOUT `unlimitedStorage` whose store is at Chrome's 10 MB quota — DramaFetch 1.3.0
    after about 490 finished series: Chrome itself refuses the next write. Two jobs are queued:
    the first is refused before its series is even listed, the second never starts, the page says
    why, the buttons are disabled, the popup's load is refused, and a fresh tab's **Load list** is
    refused by its own question before the listing: no request reaches TikTok. The same profile
    reloaded with the shipped permissions has everything it had stored, and the series downloads
    and is recorded past the quota."""
    with FakeTikTok() as server:
        with ExtensionHarness(
            tmp_path, server.base_url, drop_permissions=("unlimitedStorage",)
        ) as ext:
            errors = _watch_errors(ext)
            page = ext.page
            assert "unlimitedStorage" not in page.evaluate(
                "() => chrome.runtime.getManifest().permissions"
            )
            filled = ext.page.evaluate(FILL_JS, {"untilBytes": 2 * QUOTA_BYTES, "pad": 64})
            assert filled["refused"] is not None  # Chrome's own words, whatever the version
            assert 0 <= filled["room"] < 64 and filled["series"] > 400
            assert "pacing" not in ext.storage("pacing")  # no job ran yet: the first save is new
            before = filled["keys"], filled["bytes"]

            _queue_two(ext, MAIN_LINK, THIRD_LINK)
            _wait_finished(ext, 1)
            assert ext.finished_jobs() == 1
            line = _status_line(ext)
            assert line.startswith(f"{STOPPED_HEAD}{UNSAVED_PREFIX}") and line.endswith(
                STOPPED_TAIL
            )
            chrome_reason = line[len(STOPPED_HEAD) + len(UNSAVED_PREFIX) : -len(STOPPED_TAIL)]
            assert chrome_reason == filled["refused"]
            report = page.locator("#report-lines li").first.text_content() or ""
            assert report == f"{SERIES_ID}: {UNSAVED_PREFIX}{chrome_reason}"
            assert page.locator("#failed-block").is_hidden()  # nothing was attempted
            assert page.locator("#download-all-button").is_disabled()
            _popup_load(ext, line)  # refused at once
            assert ext.finished_jobs() == 1
            # a fresh tab knows nothing of the refusal: its Load list asks first, and is refused
            page.close()
            page = ext.reopen_app()
            page.fill("#links", MAIN_LINK)
            _click_and_wait(ext, "#load-button", 1)
            assert _status_line(ext) == line
            assert page.locator("#episode-table tbody tr").count() == 0
            assert server.requests == []  # not one request, in all those jobs
            keys = page.evaluate("async () => (await chrome.storage.local.getKeys()).length")
            assert (keys, _bytes_in_use(ext)) == before
            assert errors == []

        # DramaFetch 1.3.1 over the same folder and profile: the same extension, its memory intact
        with ExtensionHarness(tmp_path, server.base_url) as upgraded:
            assert upgraded.extension_id == ext.extension_id
            keys = upgraded.page.evaluate(
                "async () => (await chrome.storage.local.getKeys()).length"
            )
            assert keys == before[0] and _bytes_in_use(upgraded) >= before[1]
            entry = upgraded.download_all(MAIN_LINK)
            assert entry["series"][0]["line"] == MAIN_LINE
            assert _bytes_in_use(upgraded) > QUOTA_BYTES
            state = upgraded.series_state(SERIES_ID)
            assert state is not None and state["complete_at"] is not None
            assert _media_counts(server) == [1, 1, 1, 1, 0]


def test_e_a_series_whose_memory_is_gone_is_found_on_disk_and_not_downloaded_again(
    tmp_path: Path,
) -> None:
    """The safety net under everything above: the progress of a series lost altogether (Chrome
    repaired or recreated its store after a full disk) while the files and Chrome's download
    history are intact. Run again, the series is listed, every episode is found at its place —
    `already exists: …`, no video request, no `(1).mp4` — and its memory is written anew, the
    complete mark included."""
    with FakeTikTok() as server, ExtensionHarness(tmp_path, server.base_url) as ext:
        first = ext.download_all(MAIN_LINK)
        assert first["series"][0]["line"] == MAIN_LINE
        assert _media_counts(server) == [1, 1, 1, 1, 0]
        ext.page.evaluate("(key) => chrome.storage.local.remove(key)", f"series:{SERIES_ID}")
        assert ext.series_state(SERIES_ID) is None

        pages = len(server.series_page_requests)
        again = ext.download_all(MAIN_LINK)
        (series,) = again["series"]
        rows = {row["number"]: row for row in series["rows"]}
        assert [rows[n]["status"] for n in sorted(rows)] == [
            "skipped-exists",
            "skipped-exists",
            "skipped-exists",
            "skipped-exists",
            "skipped-locked",
        ]
        for number in (1, 2, 3, 4):
            assert rows[number]["message"] == (
                f"already exists: {SERIES_NAME} - Episode {number:02d}.mp4"
            )
        assert series["line"] == "complete: 4 of 5 (4 already on disk) — 1 locked (5)"
        assert len(server.series_page_requests) == pages + 1  # listed once: no memory to skip by
        assert _media_counts(server) == [1, 1, 1, 1, 0]  # and nothing downloaded twice
        assert sorted(_videos(ext)) == [
            f"{SERIES_NAME} - Episode {n:02d}.mp4" for n in (1, 2, 3, 4)
        ]
        state = ext.series_state(SERIES_ID)
        assert state is not None and state["complete_at"] is not None
        assert _on_disk(state) == dict.fromkeys((1, 2, 3, 4), "skipped-exists")
