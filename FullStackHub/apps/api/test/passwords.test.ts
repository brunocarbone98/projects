import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  checkLoginPassword,
  hashPassword,
  STORED_COST,
  verifyPassword,
} from "../src/auth/passwords.js";
import { nextReleaseHash } from "./helpers.js";

const base64 = (bytes: Buffer) => bytes.toString("base64").replace(/=+$/, "");

/** The release before this one's `verifyPassword`, verbatim: what a rollback to it runs. */
async function previousReleaseVerify(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = (await promisify(scrypt)(password, salt, expected.length)) as Buffer;
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

const median = (times: number[]) =>
  [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)] ?? 0;

async function timed(check: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await check();
  return performance.now() - started;
}

describe("password hashes", () => {
  it("writes the format every release reads, which the previous release verifies too", async () => {
    expect(STORED_COST).toEqual({ N: 2 ** 14, r: 8, p: 1 });
    const stored = await hashPassword("Password123!");

    expect(stored).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(await verifyPassword("Password123!", stored)).toBe(true);
    expect(await verifyPassword("Password123?", stored)).toBe(false);
    // Rolled back, the previous release signs the same account in, and only with its password.
    expect(await previousReleaseVerify("Password123!", stored)).toBe(true);
    expect(await previousReleaseVerify("Password123?", stored)).toBe(false);
    // A fresh salt every time.
    expect(await hashPassword("Password123!")).not.toBe(stored);
  });

  it("reads the PHC hashes the next release writes, at its cost or another", async () => {
    const next = nextReleaseHash("Password123!");
    expect(next).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{86}$/);
    expect(await verifyPassword("Password123!", next)).toBe(true);
    expect(await verifyPassword("wrong-password", next)).toBe(false);

    const salt = randomBytes(16);
    const key = scryptSync("Password123!", salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const other = `$scrypt$ln=14,r=8,p=1$${base64(salt)}$${base64(key)}`;
    expect(await verifyPassword("Password123!", other)).toBe(true);
    expect(await verifyPassword("wrong-password", other)).toBe(false);
  });

  it("never lets the previous release read a PHC hash as a match", async () => {
    const next = nextReleaseHash("Password123!");
    expect(await previousReleaseVerify("any password at all", next)).toBe(false);
    expect(await previousReleaseVerify("Password123!", next)).toBe(false);
    // The previous release reads `scrypt$<N>$<r>$<p>$<salt>$<key>` as an empty key and lets any
    // password in: the reason the cost is never stored that way.
    const unsafe = `scrypt$32768$8$3$${randomBytes(16).toString("hex")}$${randomBytes(64).toString("hex")}`;
    expect(await previousReleaseVerify("any password at all", unsafe)).toBe(true);
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
      // The previous release matches any password against these two (an empty key).
      `scrypt$${saltHex}$8`,
      `scrypt$${saltHex}$zz`,
      `scrypt$${saltHex}$${keyHex.slice(2)}`,
      `scrypt$${saltHex.toUpperCase()}$${keyHex}`,
      `bcrypt$${saltHex}$${keyHex}`,
      `$scrypt$ln=15,r=8,p=3$${salt}$`,
      `$scrypt$ln=15,r=8,p=3$${salt}$${key.slice(1)}`,
      `$scrypt$ln=15,r=8,p=3$${salt}$${key}$`,
      `$scrypt$ln=15,r=8$${salt}$${key}`,
      // Below the floor, above the range, above the memory cap (512 MiB), above the work cap (32 times
      // the stored cost: ln=20, r=2, p=16 is 256 MiB but 256 times the work), no block size or lanes.
      `$scrypt$ln=9,r=8,p=3$${salt}$${key}`,
      `$scrypt$ln=30,r=8,p=3$${salt}$${key}`,
      `$scrypt$ln=19,r=8,p=1$${salt}$${key}`,
      `$scrypt$ln=20,r=2,p=16$${salt}$${key}`,
      `$scrypt$ln=15,r=0,p=3$${salt}$${key}`,
      `$scrypt$ln=15,r=8,p=0$${salt}$${key}`,
      // Within the caps, but OpenSSL refuses N ≥ 2^(16 · r): Node would throw, and the login answer 500.
      `$scrypt$ln=16,r=1,p=1$${salt}$${key}`,
      `$scrypt$ln=20,r=01,p=1$${salt}$${key}`,
      `$argon2id$v=19$m=65536,t=3,p=4$${salt}$${key}`,
    ];
    for (const value of values) {
      const started = performance.now();
      expect(await verifyPassword("Password123!", value), value).toBe(false);
      // Refused before any scrypt work: either cap's case would take a second or more.
      expect(performance.now() - started, value).toBeLessThan(100);
    }
  });

  it("checks a login with the same work whether or not there is an account to check", async () => {
    const stored = await hashPassword("Password123!");
    expect(await checkLoginPassword("Password123!", stored)).toBe(true);
    expect(await checkLoginPassword("wrong-password", stored)).toBe(false);
    expect(await checkLoginPassword("Password123!", null)).toBe(false);
    expect(await checkLoginPassword("Password123!", "not a hash")).toBe(false);

    const account: number[] = [];
    const none: number[] = [];
    const unreadable: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      account.push(await timed(() => checkLoginPassword("wrong-password", stored)));
      none.push(await timed(() => checkLoginPassword("wrong-password", null)));
      unreadable.push(await timed(() => checkLoginPassword("wrong-password", "not a hash")));
    }
    // Without the extra derivation, no account (or an unreadable hash) is answered at once, an
    // account after a scrypt derivation (about 40 ms).
    for (const other of [none, unreadable]) {
      expect(median(other) / median(account)).toBeGreaterThan(0.5);
      expect(median(other) / median(account)).toBeLessThan(2);
    }
  });
});
