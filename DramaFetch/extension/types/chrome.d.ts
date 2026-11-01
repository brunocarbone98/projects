// Hand-written declarations of exactly the chrome.* APIs DramaFetch for Chrome uses — there is no
// @types/chrome because the extension has no dependencies at all. Only what src/app/* calls is
// declared, with the shapes Chrome documents (Manifest V3, Chrome 116+). Add a member here when the
// extension starts to use one; never declare an API the extension must not use (cookies,
// debugger, webRequestBlocking, proxy, …): their absence is part of the contract.

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
      dramafetch_test?: boolean;
      [key: string]: unknown;
    }
    interface MessageSender {
      id?: string;
      url?: string;
      tab?: tabs.Tab;
    }
    const id: string;
    function getManifest(): Manifest;
    function getURL(path: string): string;
    function sendMessage(message: unknown): Promise<unknown>;
    const onMessage: ChromeEvent<
      (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | void
    >;
    const onInstalled: ChromeEvent<(details: { reason: string; previousVersion?: string }) => void>;
  }

  // --------------------------------------------------------------------------------- i18n
  namespace i18n {
    function getMessage(messageName: string, substitutions?: string | string[]): string;
    function getUILanguage(): string;
  }

  // --------------------------------------------------------------------------------- tabs
  namespace tabs {
    interface Tab {
      id?: number;
      index: number;
      windowId: number;
      active: boolean;
      url?: string;
      pendingUrl?: string;
      title?: string;
      status?: "unloaded" | "loading" | "complete";
      mutedInfo?: { muted: boolean };
    }
    interface CreateProperties {
      url?: string;
      active?: boolean;
      windowId?: number;
      index?: number;
      openerTabId?: number;
    }
    interface UpdateProperties {
      url?: string;
      active?: boolean;
      muted?: boolean;
    }
    interface QueryInfo {
      url?: string | string[];
      active?: boolean;
      currentWindow?: boolean;
      lastFocusedWindow?: boolean;
      windowId?: number;
    }
    interface TabChangeInfo {
      status?: string;
      url?: string;
      title?: string;
    }
    function create(createProperties: CreateProperties): Promise<Tab>;
    function update(tabId: number, updateProperties: UpdateProperties): Promise<Tab | undefined>;
    function get(tabId: number): Promise<Tab>;
    function getCurrent(): Promise<Tab | undefined>;
    function remove(tabIds: number | number[]): Promise<void>;
    function query(queryInfo: QueryInfo): Promise<Tab[]>;
    const onRemoved: ChromeEvent<(tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void>;
    const onUpdated: ChromeEvent<(tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void>;
  }

  // ------------------------------------------------------------------------------ windows
  namespace windows {
    interface Window {
      id?: number;
      focused: boolean;
    }
    function update(windowId: number, updateInfo: { focused?: boolean }): Promise<Window>;
  }

  // ---------------------------------------------------------------------------- scripting
  namespace scripting {
    type ExecutionWorld = "ISOLATED" | "MAIN";
    interface InjectionTarget {
      tabId: number;
      frameIds?: number[];
      allFrames?: boolean;
    }
    interface ScriptInjection<Args extends unknown[], Result> {
      target: InjectionTarget;
      world?: ExecutionWorld;
      func: (...args: Args) => Result;
      args?: Args;
      injectImmediately?: boolean;
    }
    interface InjectionResult<Result> {
      frameId: number;
      documentId?: string;
      result?: Result;
    }
    function executeScript<Args extends unknown[], Result>(
      injection: ScriptInjection<Args, Result>,
    ): Promise<InjectionResult<Awaited<Result>>[]>;
  }

  // --------------------------------------------------------------------------- webRequest
  namespace webRequest {
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
    interface RequestFilter {
      urls: string[];
      types?: ResourceType[];
      tabId?: number;
      windowId?: number;
    }
    interface RequestDetails {
      requestId: string;
      url: string;
      method: string;
      tabId: number;
      type: ResourceType;
      timeStamp: number;
      initiator?: string;
    }
    interface CompletedDetails extends RequestDetails {
      statusCode: number;
      fromCache: boolean;
    }
    interface ErrorDetails extends RequestDetails {
      error: string;
      fromCache: boolean;
    }
    /** Observation only: DramaFetch never passes "blocking" / "requestBody" / "extraHeaders". */
    interface WebRequestEvent<Details> {
      addListener(callback: (details: Details) => void, filter: RequestFilter): void;
      removeListener(callback: (details: Details) => void): void;
      hasListener(callback: (details: Details) => void): boolean;
    }
    const onBeforeRequest: WebRequestEvent<RequestDetails>;
    const onCompleted: WebRequestEvent<CompletedDetails>;
    const onErrorOccurred: WebRequestEvent<ErrorDetails>;
  }

  // ----------------------------------------------------------------- declarativeNetRequest
  namespace declarativeNetRequest {
    type ResourceType = webRequest.ResourceType;
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
      tabIds?: number[];
    }
    interface Rule {
      id: number;
      priority?: number;
      action: RuleAction;
      condition: RuleCondition;
    }
    function updateSessionRules(options: { removeRuleIds?: number[]; addRules?: Rule[] }): Promise<void>;
    function getSessionRules(): Promise<Rule[]>;
  }

  // ---------------------------------------------------------------------------- downloads
  namespace downloads {
    type State = "in_progress" | "interrupted" | "complete";
    interface DownloadItem {
      id: number;
      url: string;
      finalUrl?: string;
      filename: string;
      mime?: string;
      state: State;
      error?: string;
      exists: boolean;
      bytesReceived: number;
      totalBytes: number;
      byExtensionId?: string;
      startTime: string;
      endTime?: string;
    }
    interface DownloadOptions {
      url: string;
      filename?: string;
      conflictAction?: "uniquify" | "overwrite" | "prompt";
      saveAs?: boolean;
    }
    interface DownloadQuery {
      id?: number;
      query?: string[];
      filenameRegex?: string;
      state?: State;
      exists?: boolean;
      limit?: number;
      orderBy?: string[];
    }
    interface StringDelta {
      current?: string;
      previous?: string;
    }
    interface BooleanDelta {
      current?: boolean;
      previous?: boolean;
    }
    interface DownloadDelta {
      id: number;
      state?: StringDelta;
      error?: StringDelta;
      filename?: StringDelta;
      exists?: BooleanDelta;
    }
    function download(options: DownloadOptions): Promise<number>;
    function search(query: DownloadQuery): Promise<DownloadItem[]>;
    function show(downloadId: number): void;
    function showDefaultFolder(): void;
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
    const onChanged: ChromeEvent<(changes: Record<string, StorageChange>, areaName: string) => void>;
  }
}
