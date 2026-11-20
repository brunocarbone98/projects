import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  hashPassword,
  needsRehash,
  SCRYPT_COST,
  spendPasswordCheck,
  verifyPassword,
} from "../src/auth/passwords.js";
import { firstReleaseHash } from "./helpers.js";

const base64 = (bytes: Buffer) => bytes.toString("base64").replace(/=+$/, "");

/** The first release's `verifyPassword`, verbatim: what a rollback to it would run. */
async function firstReleaseVerify(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = (await promisify(scrypt)(password, salt, expected.length)) as Buffer;
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

describe("password hashes", () => {
  it("stores a PHC string at today's cost and verifies only the right password", async () => {
    expect(SCRYPT_COST).toEqual({ N: 2 ** 15, r: 8, p: 3 });
    const stored = await hashPassword("Password123!");

    expect(stored).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{86}$/);
    expect(await verifyPassword("Password123!", stored)).toBe(true);
    expect(await verifyPassword("Password123?", stored)).toBe(false);
    expect(needsRehash(stored)).toBe(false);
    // A fresh salt every time.
    expect(await hashPassword("Password123!")).not.toBe(stored);
  });

  it("still verifies the first release's hashes and asks for them to be replaced", async () => {
    const stored = firstReleaseHash("Password123!");

    expect(await verifyPassword("Password123!", stored)).toBe(true);
    expect(await verifyPassword("wrong-password", stored)).toBe(false);
    expect(needsRehash(stored)).toBe(true);
  });

  it("verifies a hash stored at another cost and asks for it to be replaced", async () => {
    const salt = randomBytes(16);
    const key = scryptSync("Password123!", salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const stored = `$scrypt$ln=14,r=8,p=1$${base64(salt)}$${base64(key)}`;

    expect(await verifyPassword("Password123!", stored)).toBe(true);
    expect(await verifyPassword("wrong-password", stored)).toBe(false);
    expect(needsRehash(stored)).toBe(true);
  });

  it("writes a format the first release refuses, so a rollback opens no account", async () => {
    const stored = await hashPassword("Password123!");

    expect(await firstReleaseVerify("any password at all", stored)).toBe(false);
    expect(await firstReleaseVerify("Password123!", stored)).toBe(false);
    // The first release reads `scrypt$<N>$<r>$<p>$<salt>$<key>` as an empty key and lets any password
    // in: the reason the cost is not stored that way.
    const unsafe = `scrypt$32768$8$3$${randomBytes(16).toString("hex")}$${randomBytes(64).toString("hex")}`;
    expect(await firstReleaseVerify("any password at all", unsafe)).toBe(true);
    expect(await verifyPassword("any password at all", unsafe)).toBe(false);
  });

  it("refuses, without throwing or hashing, any stored value it did not write", async () => {
    const saltHex = randomBytes(16).toString("hex");
    const keyHex = randomBytes(64).toString("hex");
    const salt = base64(randomBytes(16));
    const key = base64(randomBytes(64));
    const values = [
      "",
      "scrypt$",
      "scrypt$$",
      `scrypt$${saltHex}$`,
      // The first release would match any password against these two (an empty key).
      `scrypt$${saltHex}$8`,
      `scrypt$${saltHex}$zz`,
      `scrypt$${saltHex}$${keyHex.slice(2)}`,
      `scrypt$${saltHex.toUpperCase()}$${keyHex}`,
      `bcrypt$${saltHex}$${keyHex}`,
      `$scrypt$ln=15,r=8,p=3$${salt}$`,
      `$scrypt$ln=15,r=8,p=3$${salt}$${key.slice(1)}`,
      `$scrypt$ln=15,r=8,p=3$${salt}$${key}$`,
      `$scrypt$ln=15,r=8$${salt}$${key}`,
      // Below the floor, above the range, above the memory cap (512 MiB), or no block size / lanes.
      `$scrypt$ln=9,r=8,p=3$${salt}$${key}`,
      `$scrypt$ln=30,r=8,p=3$${salt}$${key}`,
      `$scrypt$ln=19,r=8,p=1$${salt}$${key}`,
      `$scrypt$ln=15,r=0,p=3$${salt}$${key}`,
      `$scrypt$ln=15,r=8,p=0$${salt}$${key}`,
      `$argon2id$v=19$m=65536,t=3,p=4$${salt}$${key}`,
    ];
    for (const value of values) {
      const started = performance.now();
      expect(await verifyPassword("Password123!", value), value).toBe(false);
      // Refused before any scrypt work: a 512 MiB scrypt (ln=19) would take a second or more.
      expect(performance.now() - started, value).toBeLessThan(100);
    }
  });

  it("spends about the time of a real check when there is no account to check", async () => {
    const stored = await hashPassword("Password123!");
    const timed = async (check: () => Promise<unknown>) => {
      const started = performance.now();
      await check();
      return performance.now() - started;
    };
    const real: number[] = [];
    const none: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      real.push(await timed(() => verifyPassword("wrong-password", stored)));
      none.push(await timed(() => spendPasswordCheck("wrong-password")));
    }
    const median = (times: number[]) => [...times].sort((a, b) => a - b)[1] ?? 0;

    expect(median(none) / median(real)).toBeGreaterThan(0.5);
    expect(median(none) / median(real)).toBeLessThan(2);
  });
});
