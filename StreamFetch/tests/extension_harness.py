"""Drive StreamFetch for Chrome in a real Chromium against the local fake sites.

`ExtensionHarness` copies the extension's runtime files (`manifest.json`, `_locales`, `icons`,
`src`) to a temporary directory and adds, to that COPY's manifest only, the two things the shipped
manifest must never have (`make_test_copy`): `"streamfetch_test": true` (`testSettings` are
honoured only then) and the host permission `http://127.0.0.1/*` (the fake sites; `localhost`
stays uncovered, which the host-not-covered scenario relies on). It writes `Default/Preferences`
with the download directory (`<tmp_path>/downloads`) before launch, launches Chromium
(`STREAMFETCH_CHROMIUM` or `/opt/pw-browsers/chromium`) headless as a persistent context with
`--disable-extensions-except` / `--load-extension`, resets Playwright's download interception with
a CDP `Browser.setDownloadBehavior {"behavior": "default"}` (so `chrome.downloads` saves under the
real relative names — Playwright's own `accept_downloads` would save GUID-named files), opens the
app tab under the id Chrome derives from the copy's path (`unpacked_extension_id`), waits until
that page sees the extension's service worker activated, writes `testSettings` into
`chrome.storage.local` from the page and reloads it.

`testSettings` (spec 6 `app/storage.js`): `baseUrls` (`FakeSites.base_urls()`: `dailymotion`,
`dmcdn`, `bilibili`, `b23`, `bilibilitv`, `bilibilitvApi`), the pacing near zero (`TEST_PACING`)
and a short stall timeout. In test mode the extension's media requests carry `Referer:
<baseUrls[site]>/` (`FakeSites.expected_referer`) and no `Origin`.

What the harness reads (spec 6 and addendum A.4 — binding DOM ids): `#links`, `#analyze-button`,
`#download-all-button`, `#stop-button`, `#clear-button`, `#items-table` (`tbody tr[data-key]`
with `.site`, `.title` (a link), `.duration`, `.quality` (`select.quality-select`), `.status`
(`span.badge[data-status]`), `.progress`, `.message`, `img.cover`; group headers
`tr.group[data-group]`), `#summary-line`, `#failed-block` (`#failed-heading`, `#failed-table`,
`#retry-button`, `#report-button`, `#failed-report`), `#history-list`, `#cooldown-banner`,
`#settings-form` (`#setting-report`, `#setting-language`, `#save-settings-button`, …),
`#version`, `#legal-notice`. Storage keys: `history` (the last runs, most recent first), `cooldown`,
`settings`, `testSettings`. A setting without a form id in the spec (B.2's `cover: "embed" |
"none"`) is changed in the stored `settings` (`update_settings`), then the page is reloaded.

Covers: a row's thumbnail (A.4) and the cover B.2 embeds in a saved file are both the extension's
own `fetch` of the same URL. Thumbnails are asked for only for rows in view, once each, never
during a job — so a scenario that counts embed requests lets the thumbnails settle first
(`settle_thumbnails`, in a window where every row is in view) and clears the log.

When a run is over: the spec defines no status attribute, so the harness waits for a CHANGE of the
stored `history` (a run writes its entry) and then for the page to be idle — `#stop-button`
disabled or hidden and no row in an active status (`resolving`, `downloading`, `finishing`,
`verifying`) — for `IDLE_POLLS` polls in a row. **Analyze** writes no history: it waits for the
rows and the same idle state. `page.wait_for_function` with a string predicate is blocked by the
extension page's CSP, so the harness polls from Python (as DramaFetch's harness does). A cookie
value is never printed, logged or asserted on, except to prove it is absent.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Page, Playwright

    from fake_sites import FakeSites

#: The extension to test: `StreamFetch/extension`, or `STREAMFETCH_EXTENSION_DIR` (another build
#: of it, e.g. an unpacked release, to run the same scenarios against).
EXTENSION_DIR = Path(
    os.environ.get("STREAMFETCH_EXTENSION_DIR") or Path(__file__).resolve().parents[1] / "extension"
)
RUNTIME_PARTS = ("manifest.json", "_locales", "icons", "src")
CHROMIUM = Path(os.environ.get("STREAMFETCH_CHROMIUM") or "/opt/pw-browsers/chromium")
TEST_HOST_PERMISSION = "http://127.0.0.1/*"
APP_PATH = "src/app/app.html"
#: Test pacing: pauses near zero (allowed only in test mode), retries fast, a short stall timeout.
#: `existenceRateLimitS: 0`: the `skipped-exists` look at Chrome's downloads before each target
#: does not wait out Chrome's 10 s between two file-existence checks (as DramaFetch's harness) —
#: no scenario deletes a saved file, so the answer never depends on it.
TEST_PACING: dict[str, Any] = {
    "videoPauseS": [0, 0.05],
    "pagePauseS": [0, 0.05],
    "mediaPauseMs": [0, 10],
    "retryBackoffS": [0.1, 0.2, 0.4],
    "stallTimeoutS": 3,
    "existenceRateLimitS": 0,
}
POLL_S = 0.1
#: Consecutive idle polls that make a run "over" (the page has settled).
IDLE_POLLS = 3
RUN_TIMEOUT_S = 120.0
WORKER_TIMEOUT_S = 30.0
ACTIVE_STATUSES = frozenset({"resolving", "downloading", "finishing", "verifying"})
FINAL_STATUSES = frozenset(
    {
        "done",
        "skipped-exists",
        "failed",
        "failed-unavailable",
        "failed-rate-limited",
        "failed-blocked",
        "stopped",
    }
)
ACTIVE_WORKER_JS = """async () => {
  const active = (await navigator.serviceWorker.getRegistration())?.active;
  return active ? [active.scriptURL, active.state] : null;
}"""
#: Every item row as plain data (see `Row`).
OPFS_ENTRIES_JS = """async () => {
  const found = [];
  const walk = async (dir, prefix) => {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "directory") {
        found.push(`${prefix}${name}/`);
        await walk(handle, `${prefix}${name}/`);
      } else {
        found.push(`${prefix}${name}`);
      }
    }
  };
  await walk(await navigator.storage.getDirectory(), "");
  return found;
}"""
ROWS_JS = """(selector) => [...document.querySelectorAll(selector)].map((tr) => {
  const text = (sel) => (tr.querySelector(sel)?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const badge = tr.querySelector('.status span.badge') ?? tr.querySelector('span.badge');
  const select = tr.querySelector('select.quality-select');
  const img = tr.querySelector('img.cover');
  const link = tr.querySelector('.title a');
  const options = select ? [...select.options].map((option) => ({
    value: option.value, text: option.textContent.replace(/\\s+/g, ' ').trim(),
    disabled: option.disabled, selected: option.selected })) : [];
  const chosen = options.find((option) => option.selected);
  return {
    key: tr.dataset.key ?? '',
    site: text('.site'),
    title: text('.title'),
    href: link ? link.href : null,
    target: link ? link.target : null,
    duration: text('.duration'),
    quality: chosen ? chosen.text : text('.quality'),
    options,
    status: badge?.dataset.status ?? '',
    statusText: badge ? badge.textContent.replace(/\\s+/g, ' ').trim() : '',
    progress: text('.progress'),
    message: text('.message'),
    cover: img ? img.getAttribute('src') : null,
    top: tr.getBoundingClientRect().top,
    bottom: tr.getBoundingClientRect().bottom,
  };
})"""
#: An extension id is hex written with the letters a-p.
_ID_ALPHABET = str.maketrans("0123456789abcdef", "abcdefghijklmnop")


def make_test_copy(target: Path) -> Path:
    """Copy the extension's runtime files to `target` and mark the COPY as the test build."""
    manifest_source = EXTENSION_DIR / "manifest.json"
    if not manifest_source.is_file():
        raise AssertionError(
            f"the extension is not there yet: no {manifest_source} (StreamFetch's app is built "
            "by another group; these scenarios run once it exists)"
        )
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    for part in RUNTIME_PARTS:
        source = EXTENSION_DIR / part
        if source.is_dir():
            shutil.copytree(source, target / part)
        elif source.is_file():
            shutil.copy2(source, target / part)
        else:
            raise AssertionError(f"the extension has no {part} (expected at {source})")
    manifest_path = target / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["streamfetch_test"] = True
    manifest["host_permissions"] = [*manifest["host_permissions"], TEST_HOST_PERMISSION]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return target


def unpacked_extension_id(directory: Path) -> str:
    """The id Chrome gives the unpacked extension loaded from `directory` (as DramaFetch's harness
    computes it): a manifest `key` wins; otherwise the SHA-256 of the absolute path (`realpath`
    on POSIX, UTF-16-LE on Windows), its first 16 bytes in hex written with the letters a-p.
    Known before the launch, so the harness never waits for a "serviceworker" event."""
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if isinstance(manifest.get("key"), str):
        data = base64.b64decode(manifest["key"])
    elif os.name == "nt":
        path = os.path.abspath(directory)  # noqa: PTH100 - GetFullPathNameW, as _wfullpath()
        data = (path[:1].upper() + path[1:] if path[1:2] == ":" else path).encode("utf-16-le")
    else:
        data = os.fsencode(directory.resolve())
    return hashlib.sha256(data).hexdigest()[:32].translate(_ID_ALPHABET)


@dataclass(frozen=True)
class Row:
    """One row of `#items-table` (or `#failed-table`) as the page shows it."""

    key: str
    site: str
    title: str
    href: str | None
    target: str | None
    duration: str
    quality: str
    options: tuple[dict[str, Any], ...]
    status: str
    status_text: str
    progress: str
    message: str
    cover: str | None
    top: float
    bottom: float

    @classmethod
    def of(cls, data: dict[str, Any]) -> Row:
        return cls(
            key=data["key"],
            site=data["site"],
            title=data["title"],
            href=data["href"],
            target=data["target"],
            duration=data["duration"],
            quality=data["quality"],
            options=tuple(data["options"]),
            status=data["status"],
            status_text=data["statusText"],
            progress=data["progress"],
            message=data["message"],
            cover=data["cover"],
            top=float(data["top"]),
            bottom=float(data["bottom"]),
        )


def locale_messages(extension_dir: Path, language: str) -> dict[str, str]:
    """`_locales/<language>/messages.json` as name → message (placeholders left as written)."""
    raw = json.loads((extension_dir / "_locales" / language / "messages.json").read_text("utf-8"))
    return {name: str(entry.get("message", "")) for name, entry in raw.items()}


def template_regex(message: str) -> re.Pattern[str]:
    """A `_locales` message as a regex: every placeholder (`$NAME$`, `$1`) matches any text."""
    pieces = re.split(r"\$[A-Za-z0-9_@]+\$|\$\d", message)
    return re.compile("^" + ".+?".join(re.escape(piece.strip()) for piece in pieces) + "$", re.S)


def matches_message(text: str, message: str) -> bool:
    """Whether `text` is `message` with its placeholders filled in (whitespace collapsed)."""
    collapsed = re.sub(r"\s+", " ", text).strip()
    template = re.sub(r"\s+", " ", message).strip()
    return bool(template) and template_regex(template).match(collapsed) is not None


class ExtensionHarness:
    """`with ExtensionHarness(tmp_path, sites) as ext: ext.download_all(links)`."""

    def __init__(
        self,
        tmp_path: Path,
        sites: FakeSites,
        *,
        test_settings: dict[str, Any] | None = None,
        preferences: dict[str, Any] | None = None,
        viewport: dict[str, int] | None = None,
    ) -> None:
        self.tmp_path = tmp_path
        self.sites = sites
        self.extension_dir = make_test_copy(tmp_path / "extension")
        self.profile = tmp_path / "profile"
        self.downloads = tmp_path / "downloads"
        self.preferences: dict[str, Any] = dict(preferences or {})
        self.viewport = viewport
        self.settings: dict[str, Any] = {
            "baseUrls": sites.base_urls(),
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
            download = {
                "default_directory": str(self.downloads),
                "prompt_for_download": False,
                "directory_upgrade": True,
            }
            preferences.write_text(
                json.dumps({**self.preferences, "download": download}), encoding="utf-8"
            )
        self._playwright = sync_playwright().start()
        try:
            language = os.environ.get("LANGUAGE", "en").split(":")[0] or "en"
            self._context = self._playwright.chromium.launch_persistent_context(
                str(self.profile),
                executable_path=str(CHROMIUM),
                headless=True,
                accept_downloads=False,
                locale=language,
                viewport=self.viewport or {"width": 1280, "height": 900},
                args=[
                    f"--disable-extensions-except={self.extension_dir}",
                    f"--load-extension={self.extension_dir}",
                    f"--lang={language}",
                ],
            )
            self.extension_id = unpacked_extension_id(self.extension_dir)
            page = self._context.new_page()
            cdp = self._context.new_cdp_session(page)
            cdp.send("Browser.setDownloadBehavior", {"behavior": "default"})
            try:
                page.goto(self.app_url)
            except PlaywrightError as error:
                if "ERR_BLOCKED_BY_CLIENT" not in error.message:
                    raise
                seen = [worker.url for worker in self._context.service_workers]
                reason = error.message.partition("\n")[0]
                raise AssertionError(
                    f"the extension's app page did not open ({reason}): Chrome did not load the "
                    f"extension from {self.extension_dir}, or gave it another id than "
                    f"{self.extension_id}; service workers Playwright saw: {seen or 'none'}"
                ) from error
            self._page = page
            self._wait_for_active_worker()
            self.wait_ready(page)
            self.write_test_settings(self.settings)
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

    def wait_for(
        self, predicate: Callable[[], object], timeout_s: float = RUN_TIMEOUT_S, message: str = ""
    ) -> None:
        """Poll `predicate()` from Python (the page's CSP blocks string predicates)."""
        deadline = time.monotonic() + timeout_s
        while not predicate():
            if time.monotonic() > deadline:
                raise AssertionError(message or "timed out waiting for the extension")
            time.sleep(POLL_S)

    def _wait_for_active_worker(self) -> None:
        manifest = json.loads((self.extension_dir / "manifest.json").read_text(encoding="utf-8"))
        script = (
            f"chrome-extension://{self.extension_id}/{manifest['background']['service_worker']}"
        )
        deadline = time.monotonic() + WORKER_TIMEOUT_S
        while (active := self.page.evaluate(ACTIVE_WORKER_JS)) != [script, "activated"]:
            if time.monotonic() > deadline:
                raise AssertionError(
                    f"the extension's service worker is not active after {WORKER_TIMEOUT_S:g} s: "
                    f"expected {script} activated, the app page sees {active!r}"
                )
            time.sleep(POLL_S)

    def wait_ready(self, page: Page, timeout_s: float = 20) -> None:
        """Wait until the app page's script has run: the buttons exist and `#version` is filled
        (the script writes the manifest's version there)."""

        def ready() -> bool:
            return bool(
                page.locator("#analyze-button").count()
                and page.locator("#download-all-button").count()
                and (page.locator("#version").text_content() or "").strip()
            )

        self.wait_for(ready, timeout_s, "the app page did not start (#analyze-button, #version)")

    def storage(self, keys: str | list[str] | None = None, page: Page | None = None) -> Any:
        """`chrome.storage.local.get(keys)` of the extension (it stores no cookie)."""
        return (page or self.page).evaluate("(keys) => chrome.storage.local.get(keys)", keys)

    def history(self) -> list[dict[str, Any]]:
        found = self.storage("history").get("history") or []
        assert isinstance(found, list), f"history is not a list: {found!r}"
        return found

    def cooldown(self) -> dict[str, Any] | None:
        record = self.storage("cooldown").get("cooldown")
        return record if isinstance(record, dict) else None

    def stored_settings(self) -> dict[str, Any]:
        found = self.storage("settings").get("settings") or {}
        assert isinstance(found, dict)
        return found

    def session_rules(self) -> list[dict[str, Any]]:
        """The extension's declarativeNetRequest session rules, as Chrome holds them."""
        rules: list[dict[str, Any]] = self.page.evaluate(
            "() => chrome.declarativeNetRequest.getSessionRules()"
        )
        return rules

    def own_fetches(self, page: Page | None = None) -> list[dict[str, Any]]:
        """The app page's own requests to the fake sites, from its Resource Timing, by start."""
        entries: list[dict[str, Any]] = (page or self.page).evaluate(
            """(base) => performance.getEntriesByType('resource')
              .filter((entry) => entry.name.startsWith(base))
              .map((entry) => ({name: new URL(entry.name).pathname, start: entry.startTime,
                                end: entry.responseEnd}))
              .sort((a, b) => a.start - b.start)""",
            self.sites.base_url,
        )
        return entries

    def messages(self, language: str) -> dict[str, str]:
        """The test copy's `_locales/<language>/messages.json` (name → message)."""
        return locale_messages(self.extension_dir, language)

    # -- the page ------------------------------------------------------------------------------

    def rows(self, page: Page | None = None) -> list[Row]:
        """Every item row of `#items-table`, in page order (group headers excluded)."""
        found = (page or self.page).evaluate(ROWS_JS, "#items-table tbody tr[data-key]")
        return [Row.of(data) for data in found]

    def rows_of(self, video_id: str, page: Page | None = None) -> list[Row]:
        """The rows whose `data-key` names `video_id` (a Bilibili video has one per part)."""
        pattern = re.compile(rf"(^|:){re.escape(video_id)}(:|$)")
        return [row for row in self.rows(page) if pattern.search(row.key)]

    def row_of(self, video_id: str) -> Row:
        found = self.rows_of(video_id)
        assert len(found) == 1, f"expected one row for {video_id}, found {found}"
        return found[0]

    def failed_rows(self) -> list[Row]:
        """The rows of `#failed-table` (what the run did not download)."""
        found = self.page.evaluate(ROWS_JS, "#failed-table tbody tr")
        return [Row.of(data) for data in found]

    def group_headers(self) -> list[dict[str, str]]:
        """`#items-table tr.group[data-group]`: the series headers (A.4)."""
        headers: list[dict[str, str]] = self.page.evaluate(
            """() => [...document.querySelectorAll('#items-table tr.group[data-group]')]
              .map((tr) => ({group: tr.dataset.group,
                             text: tr.textContent.replace(/\\s+/g, ' ').trim()}))"""
        )
        return headers

    def text(self, selector: str, page: Page | None = None) -> str:
        found = (page or self.page).locator(selector)
        if found.count() == 0:
            return ""
        return re.sub(r"\s+", " ", found.first.inner_text()).strip()

    def visible(self, selector: str, page: Page | None = None) -> bool:
        found = (page or self.page).locator(selector)
        return found.count() > 0 and found.first.is_visible()

    def enabled(self, selector: str, page: Page | None = None) -> bool:
        found = (page or self.page).locator(selector)
        return found.count() > 0 and found.first.is_visible() and found.first.is_enabled()

    def idle(self, page: Page | None = None) -> bool:
        """No run in progress: `#stop-button` disabled or hidden and no row in an active status."""
        page = page or self.page
        if self.enabled("#stop-button", page):
            return False
        return not any(row.status in ACTIVE_STATUSES for row in self.rows(page))

    def _settled(self, done: Callable[[], bool], timeout_s: float, message: str) -> None:
        """Wait for `done()` and then for `IDLE_POLLS` consecutive idle polls."""
        streak = 0

        def settled() -> bool:
            nonlocal streak
            streak = streak + 1 if done() and self.idle() else 0
            return streak >= IDLE_POLLS

        self.wait_for(settled, timeout_s, message)

    def _history_mark(self) -> str:
        history = self.history()
        return json.dumps([len(history), history[0] if history else None], sort_keys=True)

    # -- actions -------------------------------------------------------------------------------

    def write_test_settings(self, settings: dict[str, Any]) -> None:
        """Store `testSettings` from the page and reload it (the app reads them at start)."""
        self.page.evaluate("(value) => chrome.storage.local.set({testSettings: value})", settings)
        stored = self.storage("testSettings").get("testSettings")
        assert stored == settings, f"testSettings not stored: {stored!r}"
        self.settings = dict(settings)
        self.page.reload()
        self.wait_ready(self.page)

    def paste(self, links: str) -> None:
        self.page.fill("#links", links)

    def analyze(self, links: str, *, min_rows: int = 1, timeout_s: float = RUN_TIMEOUT_S) -> None:
        """Paste `links`, press **Analyze**, wait until at least `min_rows` rows are there and the
        page is idle (Analyze downloads nothing and writes no history)."""
        self.paste(links)
        self.page.click("#analyze-button")
        self._settled(
            lambda: len(self.rows()) >= min_rows,
            timeout_s,
            f"Analyze did not settle with {min_rows} rows: {self.rows()}",
        )

    def settle_thumbnails(self, count: int, timeout_s: float = 20) -> None:
        """Wait until the fake sites have answered exactly `count` cover requests for
        `IDLE_POLLS` polls in a row: the rows' lazy thumbnails (A.4) — one per row in view,
        fetched once, outside jobs. After that, and a `clear_log`, a cover request during a
        download run is the one B.2 makes to embed a file's cover (both are the extension's own
        `fetch` of the same URL: the log cannot tell them apart otherwise)."""
        streak = 0

        def settled() -> bool:
            nonlocal streak
            streak = streak + 1 if len(self.sites.cover_requests()) == count else 0
            return streak >= IDLE_POLLS

        self.wait_for(
            settled,
            timeout_s,
            f"expected {count} thumbnail request(s), the sites saw "
            f"{[r.path for r in self.sites.cover_requests()]}",
        )

    def start(self, click: str) -> str:
        """Click `click` (a button that starts a run); a mark for `finish`."""
        mark = self._history_mark()
        self.page.click(click)
        return mark

    def finish(self, mark: str, timeout_s: float = RUN_TIMEOUT_S) -> dict[str, Any]:
        """Wait for the run started after `mark` to write its history entry and for the page to
        be idle; the entry."""
        self._settled(
            lambda: self._history_mark() != mark,
            timeout_s,
            f"the run did not finish (no new history entry, or never idle): {self.rows()}",
        )
        history = self.history()
        assert history, "the finished run left no history entry"
        return history[0]

    def run(self, click: str, timeout_s: float = RUN_TIMEOUT_S) -> dict[str, Any]:
        """Click `click`, wait for the run; its history entry."""
        return self.finish(self.start(click), timeout_s)

    def download_all(self, links: str | None = None, timeout_s: float = RUN_TIMEOUT_S) -> Any:
        """Paste `links` (when given), press **Download all**, wait for the run; its history."""
        if links is not None:
            self.paste(links)
        return self.run("#download-all-button", timeout_s)

    def retry(self, timeout_s: float = RUN_TIMEOUT_S) -> dict[str, Any]:
        """**Retry** in the failed block: one new run over exactly the failed inputs."""
        return self.run("#retry-button", timeout_s)

    def click_and_settle(self, selector: str, settle_s: float = 2.0) -> None:
        """Click something that may start nothing (a run refused by the cooldown): click, give
        the page `settle_s`, then wait until it is idle."""
        self.page.click(selector)
        time.sleep(settle_s)
        self._settled(lambda: True, RUN_TIMEOUT_S, f"the page did not settle after {selector}")

    def select_quality(self, video_id: str, label: str) -> str:
        """Choose, in the row of `video_id`, the enabled quality option whose text contains
        `label`; its text."""
        row = self.row_of(video_id)
        wanted = [o for o in row.options if label in o["text"] and not o["disabled"]]
        assert len(wanted) == 1, f"no single enabled option with {label!r}: {row.options}"
        selector = f'#items-table tbody tr[data-key="{row.key}"] select.quality-select'
        self.page.locator(selector).select_option(value=wanted[0]["value"])
        return str(wanted[0]["text"])

    def update_settings(self, **changes: Any) -> None:
        """Change stored settings (spec 6: `chrome.storage.local` `settings`; B.2's `cover:
        "embed" | "none"` has no form id in the spec) over what is stored, then reload the page
        so the app reads them at start."""
        settings = {**self.stored_settings(), **changes}
        self.page.evaluate("(value) => chrome.storage.local.set({settings: value})", settings)
        self.wait_for(
            lambda: all(self.stored_settings().get(k) == v for k, v in changes.items()),
            10,
            f"the settings {changes} were not stored",
        )
        self.page.reload()
        self.wait_ready(self.page)
        stored = self.stored_settings()
        assert all(stored.get(k) == v for k, v in changes.items()), (
            f"the app dropped the settings {changes} at start: {stored}"
        )

    def set_report_setting(self, on: bool) -> None:
        """Tick or untick `#setting-report` and save the settings form."""
        box = self.page.locator("#setting-report")
        if on:
            box.check()
        else:
            box.uncheck()
        self.page.click("#save-settings-button")
        self.wait_for(
            lambda: self.stored_settings().get("report") is on, 10, "the setting was not saved"
        )

    def open_app_tab(self) -> Page:
        """Another StreamFetch tab (read-only while this one holds the engine's lock)."""
        page = self.context.new_page()
        page.goto(self.app_url)
        self.wait_ready(page)
        return page

    def add_cookie(self, name: str, value: str, path: str = "/") -> None:
        """A cookie for the fake sites' host (the value is never printed or asserted on)."""
        cookie: Any = {"name": name, "value": value, "url": self.sites.base_url + path}
        self.context.add_cookies([cookie])

    # -- files ---------------------------------------------------------------------------------

    def saved_files(self) -> list[str]:
        """Every saved video under Downloads, relative, forward slashes, sorted (no reports, no
        partial `.crdownload`)."""
        return sorted(
            path.relative_to(self.downloads).as_posix()
            for path in self.downloads.rglob("*")
            if path.is_file()
            and path.suffix != ".crdownload"
            and path.relative_to(self.downloads).parts[:2] != ("StreamFetch", "reports")
        )

    def reports(self) -> list[Path]:
        """The saved reports, `StreamFetch/reports/*.json`, sorted by name."""
        folder = self.downloads / "StreamFetch" / "reports"
        return sorted(folder.glob("*.json")) if folder.is_dir() else []

    def wait_reports(self, count: int, timeout_s: float = 15) -> list[Path]:
        """Wait until exactly `count` reports are on disk (Chrome finishes writing them)."""
        self.wait_for(
            lambda: len(self.reports()) == count,
            timeout_s,
            f"expected {count} report(s), found {self.reports()}",
        )
        return self.reports()

    def wait_saved(self, count: int, timeout_s: float = 15) -> list[str]:
        self.wait_for(
            lambda: len(self.saved_files()) == count,
            timeout_s,
            f"expected {count} saved file(s), found {self.saved_files()}",
        )
        return self.saved_files()

    def saved_path(self, relative: str) -> Path:
        return self.downloads / relative

    def private_files(self) -> list[str]:
        """Every entry of the extension's origin private file system, sorted: directories end
        with `/` (the downloader's work files live in `streamfetch/work/`)."""
        found: list[str] = self.page.evaluate(OPFS_ENTRIES_JS)
        return sorted(found)
