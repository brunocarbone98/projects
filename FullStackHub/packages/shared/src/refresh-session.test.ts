import { describe, expect, it, vi } from "vitest";
import {
  isSessionEnded,
  REFRESH_REUSE_GRACE_MS,
  refreshShareKey,
  SESSION_ENDED,
  shareRefresh,
} from "./refresh-session";

const error = (code: string) => ({ error: { code, message: "Refused" } });

describe("isSessionEnded", () => {
  it("is true only for a 401 whose error code is SESSION_ENDED", () => {
    expect(isSessionEnded(401, error(SESSION_ENDED))).toBe(true);
    expect(isSessionEnded(401, { error: { code: SESSION_ENDED, message: "x", details: 1 } })).toBe(
      true,
    );
  });

  it("keeps the refresh cookie for a token used moments ago, a rate limit or a server error", () => {
    expect(isSessionEnded(401, error("INVALID_TOKEN"))).toBe(false);
    expect(isSessionEnded(429, error("RATE_LIMITED"))).toBe(false);
    expect(isSessionEnded(429, error(SESSION_ENDED))).toBe(false);
    expect(isSessionEnded(500, error(SESSION_ENDED))).toBe(false);
  });

  it("keeps the refresh cookie when the body is not the API's error shape", () => {
    for (const body of [null, undefined, "SESSION_ENDED", {}, { code: SESSION_ENDED }, []]) {
      expect(isSessionEnded(401, body)).toBe(false);
    }
  });
});

describe("refreshShareKey", () => {
  const browser = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

  it("is the same for every request one browser sends with its token", () => {
    expect(refreshShareKey("rt-1", "203.0.113.9", browser)).toBe(
      refreshShareKey("rt-1", "203.0.113.9", browser),
    );
    expect(refreshShareKey("rt-1", undefined, null)).toBe(refreshShareKey("rt-1", null, undefined));
  });

  it("differs for a copy of the token sent from another address or by another browser", () => {
    const own = refreshShareKey("rt-1", "203.0.113.9", browser);
    expect(refreshShareKey("rt-1", "198.51.100.7", browser)).not.toBe(own);
    expect(refreshShareKey("rt-1", "203.0.113.9", "curl/8.5.0")).not.toBe(own);
    expect(refreshShareKey("rt-1", undefined, browser)).not.toBe(own);
    expect(refreshShareKey("rt-1", "203.0.113.9", null)).not.toBe(own);
    expect(refreshShareKey("rt-2", "203.0.113.9", browser)).not.toBe(own);
  });

  it("cannot be matched by moving characters between the token, the address and the browser", () => {
    expect(refreshShareKey("a", "b|c", "d")).not.toBe(refreshShareKey("a|b", "c", "d"));
    expect(refreshShareKey('a","b', "c", "d")).not.toBe(refreshShareKey("a", 'b","c', "d"));
    expect(refreshShareKey("a", "", "")).not.toBe(refreshShareKey("a", null, null));
  });
});

describe("shareRefresh", () => {
  type Outcome = { tokens: { accessToken: string } | null };
  const own = {
    refreshToken: "rt-1",
    visitor: "203.0.113.9",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  };
  const pair: Outcome = { tokens: { accessToken: "new" } };
  // the end of the grace window is never reached unless a test runs it
  const never = () => {};

  it("asks the API once for every request one browser sends, and gives them the same pair", async () => {
    const pending = new Map<string, Promise<Outcome>>();
    const api = vi.fn(async () => pair);
    const [first, second] = await Promise.all([
      shareRefresh(pending, own, api, never),
      shareRefresh(pending, own, api, never),
    ]);
    expect(api).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("never shares with a copy of the token sent from another address or by another browser", async () => {
    const pending = new Map<string, Promise<Outcome>>();
    const api = vi.fn(async () => pair);
    await Promise.all([
      shareRefresh(pending, own, api, never),
      shareRefresh(pending, { ...own, visitor: "198.51.100.7" }, api, never),
      shareRefresh(pending, { ...own, userAgent: "curl/8.5.0" }, api, never),
      shareRefresh(pending, { ...own, visitor: undefined }, api, never),
    ]);
    expect(api).toHaveBeenCalledTimes(4);
  });

  it("keeps a new pair shared for the grace window, then asks again", async () => {
    const pending = new Map<string, Promise<Outcome>>();
    const timers: { run: () => void; ms: number }[] = [];
    const later = (run: () => void, ms: number) => {
      timers.push({ run, ms });
    };
    const api = vi.fn(async () => pair);
    await shareRefresh(pending, own, api, later);
    // a request the browser sent before the new cookies came back
    expect(await shareRefresh(pending, own, api, later)).toBe(pair);
    expect(api).toHaveBeenCalledTimes(1);
    expect(timers.map((timer) => timer.ms)).toEqual([REFRESH_REUSE_GRACE_MS]);
    timers[0]?.run();
    await shareRefresh(pending, own, api, later);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("drops a refusal or an error at once, so the next request asks again", async () => {
    const pending = new Map<string, Promise<Outcome>>();
    const refused = vi.fn(async (): Promise<Outcome> => ({ tokens: null }));
    await shareRefresh(pending, own, refused, never);
    await shareRefresh(pending, own, refused, never);
    expect(refused).toHaveBeenCalledTimes(2);
    const down = vi.fn(async (): Promise<Outcome> => {
      throw new Error("API down");
    });
    await expect(shareRefresh(pending, own, down, never)).rejects.toThrow("API down");
    expect(pending.size).toBe(0);
  });
});
