import { describe, expect, it } from "vitest";
import { EnvSchema } from "../src/env.js";

// The two variables without a default; nothing here connects to the database. Where the API then
// listens, set or unset, is test/listen.test.ts: it starts the API's own entry.
const required = {
  DATABASE_URL: "postgresql://shipping:shipping@localhost:5432/shipping_hub_test?schema=public",
  JWT_ACCESS_SECRET: "x".repeat(32),
};

/** The paths of the issues an API_HOST value gives; undefined when it is taken. */
function refusedAt(value: string): PropertyKey[][] | undefined {
  const result = EnvSchema.safeParse({ ...required, API_HOST: value });
  return result.success ? undefined : result.error.issues.map((issue) => issue.path);
}

describe("environment: API_HOST", () => {
  it("is unset by default", () => {
    const parsed = EnvSchema.parse(required);
    expect(parsed.API_HOST).toBeUndefined();
    expect(parsed.PORT).toBe(4000);
  });

  it("takes the address the root Dockerfile sets", () => {
    expect(EnvSchema.parse({ ...required, API_HOST: "127.0.0.1" }).API_HOST).toBe("127.0.0.1");
    expect(EnvSchema.parse({ ...required, API_HOST: "::1" }).API_HOST).toBe("::1");
  });

  it("trims spaces around the address", () => {
    expect(EnvSchema.parse({ ...required, API_HOST: " 127.0.0.1 " }).API_HOST).toBe("127.0.0.1");
  });

  it("refuses an empty value, which listen() would read as every interface", () => {
    expect(refusedAt("")).toEqual([["API_HOST"]]);
  });

  it("refuses spaces only, an empty value once trimmed", () => {
    expect(refusedAt("   ")).toEqual([["API_HOST"]]);
  });

  it("refuses what is not an IP address: a host with a port, a URL, a host name", () => {
    for (const value of ["127.0.0.1:4000", "http://127.0.0.1", "localhost"]) {
      expect(refusedAt(value), value).toEqual([["API_HOST"]]);
    }
  });
});
