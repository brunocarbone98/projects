import { describe, expect, it } from "vitest";
import { isSessionEnded, SESSION_ENDED } from "./refresh-session";

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
