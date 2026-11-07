"""Drive the DramaFetch Chrome extension in a real Chromium against the fake TikTok server.

`ExtensionHarness` copies the extension's runtime files (`manifest.json`, `_locales`, `icons`,
`src`) to a temporary directory and adds, to that COPY's manifest only, the two things the shipped
manifest must never have: `"dramafetch_test": true` (test overrides are honoured only then) and
the host permission `http://127.0.0.1/*` (the fake server). It writes `Default/Preferences` with
the download directory (and any `preferences` a scenario passes: third-party cookies blocked, say)
before launch, launches Chromium (`DRAMAFETCH_CHROMIUM` or
`/opt/pw-browsers/chromium`) headless with `--disable-extensions-except` / `--load-extension`,
resets Playwright's download interception with a CDP `Browser.setDownloadBehavior {"behavior":
"default"}` (so `chrome.downloads` saves under the real relative names), opens the extension's
app page under the id Chrome derives from the copy's path (`unpacked_extension_id`), waits until
that page sees the extension's service worker activated and saves the test settings (the fake
TikTok's base URL, pauses near 0) through the page's test-mode panel. `page.wait_for_function`
with a string predicate is blocked by the extension page's CSP, so the harness polls from Python.

Element ids it relies on: `#links`, `#load-button`, `#download-all-button`,
`#download-available-button`, `#download-selected-button`, `#include-locked`, `#recheck`,
`#app-status` (`data-state` idle|running, `data-finished` = finished jobs), `#test-settings`,
`#test-settings-save`, `#test-settings-status`, `#cooldown-banner`, `#episode-table` (one
`tr[data-number]` per listed episode with `data-access` free|unlocked|locked, its checkbox, the
`.badge` and the `.hints` span of a locked one — `plays 2 s of 10 s`, say — and the
`td.cover-cell` whose thumbnail arrives once the row is in view), `#result-table`,
`#report-lines`, `#batch-table`, `#failed-block`, `#failed-heading`, `#failed-table` (rows with
`data-number`, `data-status`, a `.badge` and a `td.message`), `#retry-button`, `#report-button`,
`#failed-report`, `#setting-report`, `#settings-save`, `#history-list`. Storage keys it reads:
`history` (most recent run first), `cooldown`, `series:<id>`, `pacing`. A cookie value is never
printed, logged or asserted on.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import time
from pathlib import Path
from types import TracebackType
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Page, Playwright

EXTENSION_DIR = Path(__file__).resolve().parents[2] / "extension"
RUNTIME_PARTS = ("manifest.json", "_locales", "icons", "src")
CHROMIUM = Path(os.environ.get("DRAMAFETCH_CHROMIUM") or "/opt/pw-browsers/chromium")
TEST_HOST_PERMISSION = "http://127.0.0.1/*"
APP_PATH = "src/app/app.html"
#: Test pacing: no pause between episodes, a short (announced) rest between series and jobs. The
#: long break keeps its defaults: it is due only every 100 attempts, and a shorter
#: `longRestMinS` would make every gap an "idle break" that resets the failure streak.
#: `existenceRateLimitS: 0`: a job's first look at Chrome's downloads does not wait out Chrome's
#: 10 s between two file-existence checks — no scenario deletes a file but the one that sets it
#: back to 10.
TEST_PACING: dict[str, float] = {
    "delayMinS": 0,
    "delayMaxS": 0,
    "restMinS": 0.2,
    "restMaxS": 0.3,
    "pageDelayS": 0,
    "discoveryTimeoutS": 15,
    "activateAfterS": 2,
    "detailGraceS": 0.5,
    "existenceDelayMs": 150,
    "existenceRateLimitS": 0,
}
POLL_S = 0.1
JOB_TIMEOUT_S = 90.0
#: How long the extension's service worker may take to be registered and activated.
WORKER_TIMEOUT_S = 30.0
#: What the app page sees of the extension's service worker — the active worker's script URL and
#: state, or null: `navigator.serviceWorker` keeps it whether the worker runs or is idle-stopped.
ACTIVE_WORKER_JS = """async () => {
  const active = (await navigator.serviceWorker.getRegistration())?.active;
  return active ? [active.scriptURL, active.state] : null;
}"""
#: An extension id is hex written with the letters a-p.
_ID_ALPHABET = str.maketrans("0123456789abcdef", "abcdefghijklmnop")


def make_test_copy(target: Path) -> Path:
    """Copy the extension's runtime files to `target` and mark the COPY as the test build."""
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    for part in RUNTIME_PARTS:
        source = EXTENSION_DIR / part
        if source.is_dir():
            shutil.copytree(source, target / part)
        else:
            shutil.copy2(source, target / part)
    manifest_path = target / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["dramafetch_test"] = True
    manifest["host_permissions"] = [*manifest["host_permissions"], TEST_HOST_PERMISSION]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return target


def unpacked_extension_id(directory: Path) -> str:
    """The id Chrome gives the unpacked extension loaded from `directory`: the first 16 bytes of a
    SHA-256, in hex written with the letters a-p. A manifest `key` wins (`ComputeExtensionID`
    hashes the decoded public key); otherwise `--load-extension` makes the path absolute
    (`base::MakeAbsoluteFilePath`: `realpath()` on POSIX, `_wfullpath()` on Windows) and
    `crx_file::id_util::GenerateIdForPath` hashes the path's native bytes (UTF-16-LE on Windows,
    the drive letter upper-cased).

    Known before the launch, so the harness never waits for Playwright's "serviceworker" event: the
    sync API can dispatch that event between a read of `context.service_workers` and the moment
    `wait_for_event` starts listening, and the wait then times out while the worker runs.
    """
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if isinstance(manifest.get("key"), str):
        data = base64.b64decode(manifest["key"])
    elif os.name == "nt":
        path = os.path.abspath(directory)  # noqa: PTH100 - GetFullPathNameW, as _wfullpath()
        data = (path[:1].upper() + path[1:] if path[1:2] == ":" else path).encode("utf-16-le")
    else:
        data = os.fsencode(directory.resolve())
    return hashlib.sha256(data).hexdigest()[:32].translate(_ID_ALPHABET)


class ExtensionHarness:
    """`with ExtensionHarness(tmp_path, server.base_url) as ext: ext.download_all(...)`."""

    def __init__(
        self,
        tmp_path: Path,
        base_url: str,
        *,
        test_settings: dict[str, Any] | None = None,
        profile: Path | None = None,
        preferences: dict[str, Any] | None = None,
    ) -> None:
        """`preferences`: more top-level keys of the profile's `Default/Preferences`, written with
        the download directory before the first launch (e.g. `{"profile": {"cookie_controls_mode":
        1, "block_third_party_cookies": True}}`: third-party cookies blocked)."""
        self.tmp_path = tmp_path
        self.base_url = base_url
        self.extension_dir = make_test_copy(tmp_path / "extension")
        self.profile = profile or tmp_path / "profile"
        self.downloads = tmp_path / "downloads"
        self.preferences: dict[str, Any] = dict(preferences or {})
        self.settings: dict[str, Any] = {
            "baseUrl": base_url,
            **TEST_PACING,
            **(test_settings or {}),
        }
        self._playwright: Playwright | None = None
        self._context: BrowserContext | None = None
        self._page: Page | None = None
        self.extension_id = ""

    # -- lifecycle -----------------------------------------------------------------------------

    def __enter__(self) -> ExtensionHarness:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import sync_playwright

        self.downloads.mkdir(parents=True, exist_ok=True)
        default = self.profile / "Default"
        default.mkdir(parents=True, exist_ok=True)
        preferences = default / "Preferences"
        if not preferences.exists():
            preferences.write_text(
                json.dumps(
                    {
                        **self.preferences,
                        "download": {
                            "default_directory": str(self.downloads),
                            "prompt_for_download": False,
                            "directory_upgrade": True,
                        },
                    }
                ),
                encoding="utf-8",
            )
        self._playwright = sync_playwright().start()
        try:
            self._context = self._playwright.chromium.launch_persistent_context(
                str(self.profile),
                executable_path=str(CHROMIUM),
                headless=True,
                accept_downloads=False,
                args=[
                    f"--disable-extensions-except={self.extension_dir}",
                    f"--load-extension={self.extension_dir}",
                ],
            )
            # from the path, never from a "serviceworker" event (see `unpacked_extension_id`)
            self.extension_id = unpacked_extension_id(self.extension_dir)
            page = self._context.new_page()
            cdp = self._context.new_cdp_session(page)
            cdp.send("Browser.setDownloadBehavior", {"behavior": "default"})
            try:
                page.goto(self.app_url)
            except PlaywrightError as error:
                if "ERR_BLOCKED_BY_CLIENT" not in error.message:
                    raise  # a timeout or a crash, not a question of the id
                # what Playwright saw tells a wrong id (another one listed) from no extension at all
                seen = [worker.url for worker in self._context.service_workers]
                reason = error.message.partition("\n")[0]  # the call log stays in the chain
                raise AssertionError(
                    f"the extension's app page did not open ({reason}): Chrome did not "
                    f"load the extension from {self.extension_dir}, or gave it another id than "
                    f"{self.extension_id}; service workers Playwright saw: {seen or 'none'}"
                ) from error
            self._page = page
            self._wait_for_active_worker()
            self.wait_for(
                lambda: self.page.locator("#app-status").get_attribute("data-state") == "idle"
            )
            self.save_test_settings(self.settings)
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if self._context is not None:
            self._context.close()
            self._context = None
        if self._playwright is not None:
            self._playwright.stop()
            self._playwright = None

    # -- access --------------------------------------------------------------------------------

    @property
    def app_url(self) -> str:
        return f"chrome-extension://{self.extension_id}/{APP_PATH}"

    @property
    def page(self) -> Page:
        assert self._page is not None, "the harness is not running"
        return self._page

    @property
    def context(self) -> BrowserContext:
        assert self._context is not None, "the harness is not running"
        return self._context

    def wait_for(self, predicate: Any, timeout_s: float = JOB_TIMEOUT_S, message: str = "") -> None:
        """Poll `predicate()` from Python (the page's CSP blocks string predicates)."""
        deadline = time.monotonic() + timeout_s
        while not predicate():
            if time.monotonic() > deadline:
                raise AssertionError(message or "timed out waiting for the extension")
            time.sleep(POLL_S)

    def _wait_for_active_worker(self) -> None:
        """Wait until the app page sees the extension's service worker registered and activated —
        a state, kept while the worker sleeps, so it cannot be missed the way an event can. A
        worker whose script throws never gets there (Playwright still lists it), and the scenario
        fails here, saying what the page sees."""
        manifest = json.loads((self.extension_dir / "manifest.json").read_text(encoding="utf-8"))
        worker = manifest["background"]["service_worker"]
        script = f"chrome-extension://{self.extension_id}/{worker}"
        deadline = time.monotonic() + WORKER_TIMEOUT_S
        while (active := self.page.evaluate(ACTIVE_WORKER_JS)) != [script, "activated"]:
            if time.monotonic() > deadline:
                raise AssertionError(
                    f"the extension's service worker is not active after {WORKER_TIMEOUT_S:g} s: "
                    f"expected {script} activated, the app page sees {active!r}"
                )
            time.sleep(POLL_S)

    def storage(self, keys: str | list[str] | None = None) -> dict[str, Any]:
        """`chrome.storage.local.get(keys)` of the extension (never a cookie: it stores none)."""
        result: dict[str, Any] = self.page.evaluate(
            "(keys) => chrome.storage.local.get(keys)", keys
        )
        return result

    def history(self) -> list[dict[str, Any]]:
        found = self.storage("history").get("history") or []
        assert isinstance(found, list)
        return found

    def series_state(self, series_id: str) -> dict[str, Any] | None:
        key = f"series:{series_id}"
        state = self.storage(key).get(key)
        return state if isinstance(state, dict) else None

    def cooldown(self) -> dict[str, Any] | None:
        record = self.storage("cooldown").get("cooldown")
        return record if isinstance(record, dict) else None

    def finished_jobs(self) -> int:
        return int(self.page.locator("#app-status").get_attribute("data-finished") or "0")

    def idle(self) -> bool:
        return self.page.locator("#app-status").get_attribute("data-state") == "idle"

    def tab_urls(self) -> list[str]:
        """Every open tab's URL as `chrome.tabs.query` sees it: Playwright's `context.pages` never
        lists the tabs the extension opens itself (`chrome.tabs.create`: the discovery's tab)."""
        urls: list[str] = self.page.evaluate(
            "async () => (await chrome.tabs.query({}))"
            ".map((tab) => tab.url || tab.pendingUrl || '')"
        )
        return urls

    def watch_tabs(self) -> None:
        """Start recording every tab opened from now on (`chrome.tabs.onCreated`, in the app page);
        `opened_tabs()` reads them. Playwright's own `page` events miss the extension's tabs."""
        self.page.evaluate(
            "() => { if (globalThis.__openedTabs) return; globalThis.__openedTabs = [];"
            " chrome.tabs.onCreated.addListener((tab) =>"
            " globalThis.__openedTabs.push(tab.pendingUrl || tab.url || '')); }"
        )

    def opened_tabs(self) -> list[str]:
        """The tabs opened since `watch_tabs()`, by their first URL (`about:blank` for the
        discovery's tab, which navigates to the series afterwards)."""
        opened: list[str] = self.page.evaluate("() => globalThis.__openedTabs ?? []")
        return opened

    # -- actions -------------------------------------------------------------------------------

    def save_test_settings(self, settings: dict[str, Any]) -> None:
        page = self.page
        page.fill("#test-settings", json.dumps(settings))
        page.click("#test-settings-save")
        self.wait_for(
            lambda: (page.locator("#test-settings-status").text_content() or "").startswith(
                "saved"
            ),
            10,
            "the test settings were not saved",
        )

    def reopen_app(self) -> Page:
        """Open the app page in a new tab (the test closed the old one) and make it `page`, once
        it is idle; the test settings are in storage already."""
        page = self.context.new_page()
        page.goto(self.app_url)
        self._page = page
        self.wait_for(
            lambda: page.locator("#app-status").get_attribute("data-state") == "idle",
            20,
            "the reopened app page did not start",
        )
        return page

    def add_session_cookie(
        self, value: str, *, same_site: Literal["Lax", "Strict"] | None = None
    ) -> None:
        """A `sessionid` cookie for the fake TikTok (the value is never printed or asserted on);
        `same_site` sets its SameSite attribute (Chrome's default, Lax, without one)."""
        # Playwright types it with its private SetCookieParam
        cookie: Any = {"name": "sessionid", "value": value, "url": self.base_url}
        if same_site is not None:
            cookie["sameSite"] = same_site
        self.context.add_cookies([cookie])

    def session_rules(self) -> list[dict[str, Any]]:
        """The extension's declarativeNetRequest session rules, as Chrome holds them."""
        rules: list[dict[str, Any]] = self.page.evaluate(
            "() => chrome.declarativeNetRequest.getSessionRules()"
        )
        return rules

    def _run(self, click: str, timeout_s: float) -> dict[str, Any]:
        before = self.finished_jobs()
        self.page.click(click)
        self.wait_for(
            lambda: self.finished_jobs() > before and self.idle(),
            timeout_s,
            f"the job of {click} did not finish",
        )
        history = self.history()
        assert history, "the finished job left no history entry"
        return history[0]

    def download_all(
        self,
        links: str,
        *,
        include_locked: bool = False,
        recheck: bool = False,
        timeout_s: float = JOB_TIMEOUT_S,
    ) -> dict[str, Any]:
        """Paste `links`, press **Download all**, wait for the job; its history entry."""
        page = self.page
        page.fill("#links", links)
        if include_locked:
            page.check("#include-locked")
        if recheck:
            page.check("#recheck")
        return self._run("#download-all-button", timeout_s)

    def load(self, link: str, timeout_s: float = JOB_TIMEOUT_S) -> dict[str, Any]:
        """Paste one link and press **Load list**; the history entry of the listing."""
        self.page.fill("#links", link)
        return self._run("#load-button", timeout_s)

    def download_available(self, timeout_s: float = JOB_TIMEOUT_S) -> dict[str, Any]:
        """**Download all available** of the loaded series; its history entry."""
        return self._run("#download-available-button", timeout_s)

    def saved_files(self) -> list[Path]:
        """Every file under the download directory, relative to it, sorted."""
        return sorted(
            path.relative_to(self.downloads) for path in self.downloads.rglob("*") if path.is_file()
        )
