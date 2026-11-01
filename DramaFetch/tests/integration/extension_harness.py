"""Drive the DramaFetch Chrome extension in a real Chromium against the fake TikTok server.

`ExtensionHarness` copies the extension's runtime files (`manifest.json`, `_locales`, `icons`,
`src`) to a temporary directory and adds, to that COPY's manifest only, the two things the shipped
manifest must never have: `"dramafetch_test": true` (test overrides are honoured only then) and
the host permission `http://127.0.0.1/*` (the fake server). It writes `Default/Preferences` with
the download directory before launch, launches Chromium (`DRAMAFETCH_CHROMIUM` or
`/opt/pw-browsers/chromium`) headless with `--disable-extensions-except` / `--load-extension`,
resets Playwright's download interception with a CDP `Browser.setDownloadBehavior {"behavior":
"default"}` (so `chrome.downloads` saves under the real relative names), opens the extension's
app page and saves the test settings (the fake TikTok's base URL, pauses near 0) through the
page's test-mode panel. `page.wait_for_function` with a string predicate is blocked by the
extension page's CSP, so the harness polls from Python.

Element ids it relies on: `#links`, `#load-button`, `#download-all-button`,
`#download-available-button`, `#download-selected-button`, `#include-locked`, `#recheck`,
`#app-status` (`data-state` idle|running, `data-finished` = finished jobs), `#test-settings`,
`#test-settings-save`, `#test-settings-status`, `#cooldown-banner`, `#result-table`,
`#report-lines`, `#batch-table`. Storage keys it reads: `history` (most recent run first),
`cooldown`, `series:<id>`, `pacing`. A cookie value is never printed, logged or asserted on.
"""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from types import TracebackType
from typing import TYPE_CHECKING, Any

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
}
POLL_S = 0.1
JOB_TIMEOUT_S = 90.0


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


class ExtensionHarness:
    """`with ExtensionHarness(tmp_path, server.base_url) as ext: ext.download_all(...)`."""

    def __init__(
        self,
        tmp_path: Path,
        base_url: str,
        *,
        test_settings: dict[str, Any] | None = None,
        profile: Path | None = None,
    ) -> None:
        self.tmp_path = tmp_path
        self.base_url = base_url
        self.extension_dir = make_test_copy(tmp_path / "extension")
        self.profile = profile or tmp_path / "profile"
        self.downloads = tmp_path / "downloads"
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
        from playwright.sync_api import sync_playwright

        self.downloads.mkdir(parents=True, exist_ok=True)
        default = self.profile / "Default"
        default.mkdir(parents=True, exist_ok=True)
        preferences = default / "Preferences"
        if not preferences.exists():
            preferences.write_text(
                json.dumps(
                    {
                        "download": {
                            "default_directory": str(self.downloads),
                            "prompt_for_download": False,
                            "directory_upgrade": True,
                        }
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
            workers = self._context.service_workers
            worker = workers[0] if workers else self._context.wait_for_event("serviceworker")
            self.extension_id = worker.url.split("/")[2]
            page = self._context.new_page()
            cdp = self._context.new_cdp_session(page)
            cdp.send("Browser.setDownloadBehavior", {"behavior": "default"})
            page.goto(self.app_url)
            self._page = page
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
        return [page.url for page in self.context.pages]

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

    def add_session_cookie(self, value: str) -> None:
        """A `sessionid` cookie for the fake TikTok (the value is never printed or asserted on)."""
        self.context.add_cookies([{"name": "sessionid", "value": value, "url": self.base_url}])

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
