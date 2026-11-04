import { describe, expect, it } from "vitest";
import { isPublicAddress, visitorAddress } from "./visitor-address";

describe("isPublicAddress", () => {
  it("accepts public IPv4 and IPv6 addresses", () => {
    for (const ip of ["8.8.8.8", "203.0.113.9", "172.15.0.1", "172.32.0.1", "2001:db8::42"]) {
      expect(isPublicAddress(ip)).toBe(true);
    }
    expect(isPublicAddress("::ffff:203.0.113.8")).toBe(true);
    expect(isPublicAddress("1:2:3:4:5:6:7:8")).toBe(true);
  });

  it("rejects the host's and the platform's own addresses", () => {
    const internal = [
      "0.1.2.3",
      "10.0.0.1",
      "100.64.0.9",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "192.168.1.10",
      "224.0.0.1",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
    ];
    for (const ip of internal) expect(isPublicAddress(ip)).toBe(false);
  });

  it("rejects anything that is not one IP address", () => {
    const invalid = [
      "",
      "unknown",
      "999.1.1.1",
      "203.0.113.5:443",
      "203.0.113.5, 198.51.100.7",
      "1::2::3",
      "1:2:3:4:5:6:7:8:9",
      "fe80::1%eth0",
    ];
    for (const value of invalid) expect(isPublicAddress(value)).toBe(false);
  });
});

describe("visitorAddress", () => {
  it("forwards the public address Railway's edge puts in X-Real-IP", () => {
    expect(visitorAddress("203.0.113.9")).toBe("203.0.113.9");
    expect(visitorAddress("  2001:db8::1 ")).toBe("2001:db8::1");
  });

  it("forwards nothing without a public address", () => {
    // Local runs and CI have no proxy, so no X-Real-IP; an internal hop must never become one
    // shared bucket for every visitor behind it.
    expect(visitorAddress(null)).toBeUndefined();
    expect(visitorAddress(undefined)).toBeUndefined();
    expect(visitorAddress("10.0.0.5")).toBeUndefined();
    expect(visitorAddress("::1")).toBeUndefined();
    expect(visitorAddress("not-an-address")).toBeUndefined();
  });
});
