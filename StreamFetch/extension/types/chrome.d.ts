// Hand-written declarations of exactly the chrome.* APIs StreamFetch for Chrome uses — there is no
// @types/chrome because the extension has no dependencies at all. Only what src/app/* calls is
// declared, with the shapes Chrome documents (Manifest V3, Chrome 116+). Add a member here when the
// extension starts to use one; never declare an API the extension must not use (scripting,
// webRequest, cookies, debugger, proxy, …): their absence is part of the contract.

declare namespace chrome {
  // ------------------------------------------------------------------------------- events
  interface ChromeEvent<Callback extends (...args: never[]) => unknown> {
    addListener(callback: Callback): void;
    removeListener(callback: Callback): void;
    hasListener(callback: Callback): boolean;
  }

  // ------------------------------------------------------------------------------ runtime
  namespace runtime {
    interface Manifest {
      manifest_version: number;
      name: string;
      version: string;
      host_permissions?: string[];
      permissions?: string[];
      /** Set only in the test harness' temporary copy of the extension. */
      streamfetch_test?: boolean;
      [key: string]: unknown;
    }
    interface MessageSender {
      id?: string;
      url?: string;
    }
    /** One of the extension's own open documents (`getContexts`, Chrome 116+). */
    interface ExtensionContext {
      contextType: "TAB" | "POPUP" | "BACKGROUND" | "OFFSCREEN_DOCUMENT" | "SIDE_PANEL";
      contextId: string;
      tabId: number;
      windowId: number;
      documentUrl?: string;
      frameId: number;
      incognito: boolean;
    }
    interface ContextFilter {
      contextTypes?: ExtensionContext["contextType"][];
      documentUrls?: string[];
    }
    const id: string;
    function getManifest(): Manifest;
    function getURL(path: string): string;
    function getContexts(filter: ContextFilter): Promise<ExtensionContext[]>;
    function sendMessage(message: unknown): Promise<unknown>;
    const onMessage: ChromeEvent<
      (
        message: unknown,
        sender: MessageSender,
        sendResponse: (response?: unknown) => void,
      ) => boolean | void
    >;
    const onInstalled: ChromeEvent<(details: { reason: string; previousVersion?: string }) => void>;
    const onStartup: ChromeEvent<() => void>;
    /** Set while a callback of a callback-style API (contextMenus) runs after a failure. */
    const lastError: { message?: string } | undefined;
  }

  // ------------------------------------------------------------------------- contextMenus
  /** The right-click menu ("Download this video"): its items and their clicks, never the page's content. */
  namespace contextMenus {
    type ContextType = "page" | "link";
    interface CreateProperties {
      id: string;
      title: string;
      contexts: ContextType[];
      /** Where the item shows: the right-clicked page's (or frame's) URL must match (match patterns). */
      documentUrlPatterns?: string[];
      /** For a link: its `href` must match (match patterns). */
      targetUrlPatterns?: string[];
    }
    interface OnClickData {
      menuItemId: string | number;
      linkUrl?: string;
      /** The tab's top page. */
      pageUrl?: string;
      /** The right-clicked frame's address (Chrome 116 sends it only from inside a frame). */
      frameUrl?: string;
      /** The selected text, when there is one (never read). */
      selectionText?: string;
    }
    // callback forms only: removeAll returns a promise only from Chrome 123 on; create never does
    // (it returns the item's id at once and reports its outcome only to the callback)
    function create(properties: CreateProperties, callback: () => void): string | number;
    function removeAll(callback: () => void): void;
    const onClicked: ChromeEvent<(info: OnClickData, tab?: unknown) => void>;
  }

  // --------------------------------------------------------------------------------- i18n
  namespace i18n {
    function getMessage(messageName: string, substitutions?: string | string[]): string;
    function getUILanguage(): string;
  }

  // --------------------------------------------------------------------------------- tabs
  // Only what needs no `tabs` permission: the popup reads the active tab's URL, which Chrome
  // fills in for the hosts of `host_permissions` only; the worker opens, focuses or reloads the
  // app tab; the app page asks for its own tab.
  namespace tabs {
    interface Tab {
      id?: number;
      windowId: number;
      active: boolean;
      url?: string;
    }
    interface CreateProperties {
      url?: string;
      active?: boolean;
    }
    interface UpdateProperties {
      active?: boolean;
      /** Only ever StreamFetch's own page, to a tab of it that is not running. */
      url?: string;
    }
    interface QueryInfo {
      active?: boolean;
      currentWindow?: boolean;
    }
    function create(createProperties: CreateProperties): Promise<Tab>;
    function update(tabId: number, updateProperties: UpdateProperties): Promise<Tab | undefined>;
    function query(queryInfo: QueryInfo): Promise<Tab[]>;
    function getCurrent(): Promise<Tab | undefined>;
  }

  // ------------------------------------------------------------------------------ windows
  namespace windows {
    interface Window {
      id?: number;
      focused: boolean;
    }
    function update(windowId: number, updateInfo: { focused?: boolean }): Promise<Window>;
  }

  // ----------------------------------------------------------------- declarativeNetRequest
  namespace declarativeNetRequest {
    type ResourceType =
      | "main_frame"
      | "sub_frame"
      | "stylesheet"
      | "script"
      | "image"
      | "font"
      | "object"
      | "xmlhttprequest"
      | "ping"
      | "csp_report"
      | "media"
      | "websocket"
      | "webbundle"
      | "other";
    interface ModifyHeaderInfo {
      header: string;
      operation: "set" | "append" | "remove";
      value?: string;
    }
    interface RuleAction {
      type: "modifyHeaders";
      requestHeaders?: ModifyHeaderInfo[];
    }
    interface RuleCondition {
      urlFilter?: string;
      initiatorDomains?: string[];
      requestDomains?: string[];
      resourceTypes?: ResourceType[];
    }
    interface Rule {
      id: number;
      priority?: number;
      action: RuleAction;
      condition: RuleCondition;
    }
    function updateSessionRules(options: {
      removeRuleIds?: number[];
      addRules?: Rule[];
    }): Promise<void>;
    function getSessionRules(): Promise<Rule[]>;
  }

  // ---------------------------------------------------------------------------- downloads
  namespace downloads {
    type State = "in_progress" | "interrupted" | "complete";
    interface DownloadItem {
      id: number;
      url: string;
      filename: string;
      state: State;
      error?: string;
      exists: boolean;
      bytesReceived: number;
      totalBytes: number;
    }
    interface DownloadOptions {
      url: string;
      filename?: string;
      conflictAction?: "uniquify" | "overwrite" | "prompt";
      saveAs?: boolean;
    }
    interface DownloadQuery {
      id?: number;
      filenameRegex?: string;
      state?: State;
      exists?: boolean;
      limit?: number;
    }
    interface StringDelta {
      current?: string;
      previous?: string;
    }
    interface DownloadDelta {
      id: number;
      state?: StringDelta;
      error?: StringDelta;
    }
    function download(options: DownloadOptions): Promise<number>;
    function search(query: DownloadQuery): Promise<DownloadItem[]>;
    const onChanged: ChromeEvent<(downloadDelta: DownloadDelta) => void>;
  }

  // ------------------------------------------------------------------------------ storage
  namespace storage {
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    const onChanged: ChromeEvent<
      (changes: Record<string, StorageChange>, areaName: string) => void
    >;
  }
}
