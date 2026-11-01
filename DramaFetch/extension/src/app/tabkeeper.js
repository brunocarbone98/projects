// @ts-check
/**
 * Keeps the DramaFetch tab from being discarded while it works. Chrome's Memory Saver (and Chrome
 * short of memory) may discard a tab that is not in front — which would end a run in the middle of
 * an episode — unless the tab is marked `autoDiscardable: false`. While a job runs or waits, the
 * DramaFetch tab is marked so; once nothing runs and nothing waits (the queue done, a Stop, an
 * error), it is discardable again, Chrome's default. Only the tab's own property changes
 * (`chrome.tabs.update`, which needs no permission for it); nothing of any other tab.
 */

/**
 * @typedef {{update(tabId: number, properties: chrome.tabs.UpdateProperties): Promise<unknown>}} TabsApi
 */

export class TabKeeper {
  /**
   * @param {{tabs?: TabsApi, onError?: (error: unknown) => void}} [options] `tabs`: `chrome.tabs`
   *   by default; `onError` hears an update Chrome refused (the tab is gone, say)
   */
  constructor(options = {}) {
    /** @type {TabsApi} */
    this.tabs = options.tabs ?? chrome.tabs;
    this.onError = options.onError;
    /** @type {number | undefined} the tab Chrome was last told about */
    this.tabId = undefined;
    /** @type {boolean | null} what Chrome was last told: whether the tab may be discarded (null: nothing yet) */
    this.discardable = null;
    /** @type {Promise<void>} the updates, one after the other: the last one asked is the one that stays */
    this.pending = Promise.resolve();
  }

  /**
   * Tell Chrome whether the tab may be discarded: never while `busy` (a job runs or waits). The
   * same answer twice in a row costs no call.
   * @param {number | undefined} tabId the DramaFetch tab (none: nothing to tell)
   * @param {boolean} busy
   * @returns {Promise<void>} settles once Chrome has the answer (never rejects)
   */
  keep(tabId, busy) {
    const discardable = !busy;
    if (tabId === undefined || (tabId === this.tabId && discardable === this.discardable)) return this.pending;
    this.tabId = tabId;
    this.discardable = discardable;
    this.pending = this.pending
      .then(() => this.tabs.update(tabId, { autoDiscardable: discardable }))
      .then(
        () => undefined,
        (error) => this.onError?.(error),
      );
    return this.pending;
  }
}
