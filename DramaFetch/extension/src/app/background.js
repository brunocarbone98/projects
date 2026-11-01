// @ts-check
/**
 * The service worker: opens the DramaFetch tab — or re-focuses the one already open (one per
 * browser) — when the popup asks, and hands it a series to list. It holds no long-running work:
 * the engine runs in the DramaFetch tab while that tab is open.
 */

const APP_PATH = "src/app/app.html";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Open or focus the DramaFetch tab; with `load`, list that series there.
 * @param {string | null} load
 * @returns {Promise<void>}
 */
async function openApp(load) {
  const appUrl = chrome.runtime.getURL(APP_PATH);
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => (tab.url ?? "").startsWith(appUrl));
  if (existing !== undefined && existing.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    if (load) await chrome.runtime.sendMessage({ type: "dramafetch:load", input: load }).catch(() => undefined);
    return;
  }
  await chrome.tabs.create({ url: load ? `${appUrl}?load=${encodeURIComponent(load)}` : appUrl });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isRecord(message) || message["type"] !== "dramafetch:open") return false;
  const load = typeof message["load"] === "string" && message["load"] ? message["load"] : null;
  openApp(load).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true; // the answer comes asynchronously
});
