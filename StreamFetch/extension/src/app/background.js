// @ts-check
/**
 * The service worker: opens the StreamFetch tab — or re-focuses the one already open (one per
 * browser) — when the popup asks, and hands it the link to add. It holds no long-running work: the
 * engine runs in the StreamFetch tab while that tab is open. The open tab is found with
 * `chrome.runtime.getContexts` (the extension's own documents, Chrome 116+), so no `tabs`
 * permission is needed.
 */

export const APP_PATH = "src/app/app.html";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Open or focus the StreamFetch tab; with `links`, add them to its box.
 * @param {string | null} links
 * @returns {Promise<void>}
 */
export async function openApp(links) {
  const appUrl = chrome.runtime.getURL(APP_PATH);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
  const existing = contexts.find((context) => (context.documentUrl ?? "").startsWith(appUrl));
  if (existing !== undefined && existing.tabId >= 0) {
    await chrome.tabs.update(existing.tabId, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    if (links) {
      await chrome.runtime.sendMessage({ type: "streamfetch:links", links }).catch(() => undefined);
    }
    return;
  }
  await chrome.tabs.create({ url: links ? `${appUrl}?links=${encodeURIComponent(links)}` : appUrl });
}

/**
 * The worker's message handler: only this extension's own pages may ask (web pages cannot reach
 * it: no `externally_connectable`), and only `streamfetch:open`.
 * @param {unknown} message
 * @param {chrome.runtime.MessageSender} sender
 * @param {(response?: unknown) => void} sendResponse
 * @returns {boolean} whether the answer comes asynchronously
 */
export function onMessage(message, sender, sendResponse) {
  if (sender.id !== chrome.runtime.id) return false;
  if (!isRecord(message) || message["type"] !== "streamfetch:open") return false;
  const links = typeof message["links"] === "string" && message["links"] ? message["links"] : null;
  openApp(links).then(
    () => sendResponse({ ok: true }),
    (error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(onMessage);
}
