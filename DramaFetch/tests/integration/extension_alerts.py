"""The DramaFetch tab's notifications in the end-to-end scenarios (`pytest -m integration`): every
one the tab asks Chrome for, recorded on its way (`RECORD_ALERTS_JS`), and a click on one as Chrome
hands it to the extension's service worker (`BODY_CLICK_JS`, `RETRY_CLICK_JS`, run by `in_worker`).

Shared by `test_extension_library.py` (the 1.7.0 alerts of a library download and their **Retry**)
and `test_extension_autoretry.py` (the 1.8.0 automatic retry and its alerts). Nothing here changes
what the extension does: the recorder only wraps `chrome.notifications.create` / `clear` in the
DramaFetch tab, and a click is the worker's own listener run on a notification's id.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from playwright.sync_api import Worker

    from .extension_harness import ExtensionHarness

#: In the DramaFetch tab, recorded on their way to Chrome: every notification the page asks for —
#: its id and options, and whether `chrome.notifications.getAll()` listed it once Chrome made it
#: (headless Chromium drops a notification from that list about 9 s later — 8.6 s measured in the
#: sandbox's Chromium —, as a desktop's toast leaves the screen) — and every one the page takes
#: away. Nothing else changes.
RECORD_ALERTS_JS = """() => {
  if (globalThis.__alerts !== undefined) return;
  globalThis.__alerts = [];
  globalThis.__cleared = [];
  const api = chrome.notifications;
  const create = api.create.bind(api);
  const clear = api.clear.bind(api);
  api.create = (id, options) => {
    const seen = { id, options: JSON.parse(JSON.stringify(options)), listed: null };
    globalThis.__alerts.push(seen);
    const made = create(id, options);
    made.then(
      async () => { seen.listed = Object.hasOwn(await api.getAll(), id); },
      (error) => { seen.listed = String(error); },
    );
    return made;
  };
  api.clear = (id) => {
    globalThis.__cleared.push(id);
    return clear(id);
  };
}"""
ALERTS_JS = "() => globalThis.__alerts ?? []"
CLEARED_JS = "() => globalThis.__cleared ?? []"
#: In the extension's service worker, recorded on their way to Chrome: the notifications the worker
#: takes away. Nothing else changes.
RECORD_WORKER_CLEARS_JS = """() => {
  if (globalThis.__cleared !== undefined) return;
  globalThis.__cleared = [];
  const api = chrome.notifications;
  const clear = api.clear.bind(api);
  api.clear = (id) => {
    globalThis.__cleared.push(id);
    return clear(id);
  };
}"""
#: A click on a notification's body, or on its first button (**Retry**), as Chrome hands it to the
#: service worker: the worker's own listeners (`background.js`) run on it.
BODY_CLICK_JS = "(id) => chrome.notifications.onClicked.dispatch(id)"
RETRY_CLICK_JS = "(id) => chrome.notifications.onButtonClicked.dispatch(id, 0)"
#: A message from the DramaFetch tab that starts the service worker when Chrome stopped it (idle);
#: the worker answers nothing to it, and no other page hears it.
WAKE_JS = "() => chrome.runtime.sendMessage({ type: 'dramafetch:wake' }).catch(() => null)"


def recorded_alerts(ext: ExtensionHarness, count: int) -> list[dict[str, Any]]:
    """The notifications the DramaFetch tab asked Chrome for (`RECORD_ALERTS_JS`), once there are
    `count` and Chrome answered each."""

    def answered() -> bool:
        alerts: list[dict[str, Any]] = ext.page.evaluate(ALERTS_JS)
        return len(alerts) >= count and all(alert["listed"] is not None for alert in alerts)

    ext.wait_for(answered, 10, f"fewer than {count} notifications")
    alerts: list[dict[str, Any]] = ext.page.evaluate(ALERTS_JS)
    return alerts


def service_worker(ext: ExtensionHarness) -> Worker:
    """The extension's service worker, running: the DramaFetch tab wakes it first (Chrome stops an
    idle worker), then it is the one Playwright sees at the worker's address."""
    address = f"chrome-extension://{ext.extension_id}/src/app/background.js"
    ext.page.evaluate(WAKE_JS)
    ext.wait_for(
        lambda: any(worker.url == address for worker in ext.context.service_workers),
        10,
        "the extension's service worker is not running",
    )
    return [worker for worker in ext.context.service_workers if worker.url == address][-1]


def in_worker(ext: ExtensionHarness, script: str, arg: Any = None) -> Any:
    """`script(arg)` evaluated in the extension's service worker; a worker Chrome stopped between
    the wake-up and the call is woken and asked again, once."""
    from playwright.sync_api import Error as PlaywrightError

    try:
        return service_worker(ext).evaluate(script, arg)
    except PlaywrightError:
        return service_worker(ext).evaluate(script, arg)
