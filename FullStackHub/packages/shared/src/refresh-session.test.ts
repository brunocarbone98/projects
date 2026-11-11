import { describe, expect, it } from "vitest";
import { isSessionEnded, refreshShareKey, SESSION_ENDED } from "./refresh-session";

const error = (code: string) => ({ error: { code, message: "Refused" } });

describe("isSessionEnded", () => {
  it("is true only for a 401 whose error code is SESSION_ENDED", () => {
    expect(isSessionEnded(401, error(SESSION_ENDED))).toBe(true);
    expect(isSessionEnded(401, { error: { code: SESSION_ENDED, message: "x", details: 1 } })).toBe(
      true,
    );
  });

  it("keeps the cookies for a token used moments ago, a rate limit or a server error", () => {
    expect(isSessionEnded(401, error("INVALID_TOKEN"))).toBe(false);
    expect(isSessionEnded(429, error("RATE_LIMITED"))).toBe(false);
    expect(isSessionEnded(429, error(SESSION_ENDED))).toBe(false);
    expect(isSessionEnded(500, error(SESSION_ENDED))).toBe(false);
  });

  it("keeps the cookies when the body is not the API's error shape", () => {
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
