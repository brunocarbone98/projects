import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  checkLoginPassword,
  hashPassword,
  STORED_COST,
  verifyPassword,
} from "../src/auth/passwords.js";
import { nextReleaseHash } from "./helpers.js";

// Node's own scrypt behind a spy that changes nothing, so a test can see the derivations a check does.
vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, scrypt: vi.fn(crypto.scrypt) };
});

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

  it("reads the PHC hashes the next release writes, at its cost or another, in either alphabet", async () => {
    const next = nextReleaseHash("Password123!");
    expect(next).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{86}$/);
    expect(await verifyPassword("Password123!", next)).toBe(true);
    expect(await verifyPassword("wrong-password", next)).toBe(false);

    const salt = randomBytes(16);
    const key = scryptSync("Password123!", salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const other = `$scrypt$ln=14,r=8,p=1$${base64(salt)}$${base64(key)}`;
    expect(await verifyPassword("Password123!", other)).toBe(true);
    expect(await verifyPassword("wrong-password", other)).toBe(false);

    // Written with the URL-safe alphabet (Node's `base64url`): a salt whose encoding starts with
    // `-` and `_`, the two characters only that alphabet has.
    const urlSalt = Buffer.concat([Buffer.from("fbefbeffffff", "hex"), randomBytes(10)]);
    const urlKey = scryptSync("Password123!", urlSalt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const urlSafe = `$scrypt$ln=14,r=8,p=1$${urlSalt.toString("base64url")}$${urlKey.toString("base64url")}`;
    expect(urlSafe).toContain("$----____");
    expect(await verifyPassword("Password123!", urlSafe)).toBe(true);
    expect(await verifyPassword("wrong-password", urlSafe)).toBe(false);
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
    // A salt and a key really derived for the password at the cost Node would compute (it reads r=0
    // as r=8 and p=0 as p=1), so only the cost rule refuses the value: without it, the password matches.
    const realSalt = randomBytes(16);
    const saltAndKey = (cost: { N: number; r: number; p: number }) =>
      `${base64(realSalt)}$${base64(scryptSync("Password123!", realSalt, 64, { ...cost, maxmem: 2 ** 26 }))}`;
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
      `$scrypt$ln=9,r=8,p=3$${saltAndKey({ N: 2 ** 9, r: 8, p: 3 })}`,
      `$scrypt$ln=30,r=8,p=3$${salt}$${key}`,
      `$scrypt$ln=19,r=8,p=1$${salt}$${key}`,
      `$scrypt$ln=20,r=2,p=16$${salt}$${key}`,
      `$scrypt$ln=15,r=0,p=3$${saltAndKey({ N: 2 ** 15, r: 8, p: 3 })}`,
      `$scrypt$ln=15,r=8,p=0$${saltAndKey({ N: 2 ** 15, r: 8, p: 1 })}`,
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

  it("checks a login with one derivation at the stored cost, whether or not there is an account", async () => {
    const stored = await hashPassword("Password123!");
    expect(await checkLoginPassword("Password123!", stored)).toBe(true);
    expect(await checkLoginPassword("wrong-password", stored)).toBe(false);
    expect(await checkLoginPassword("Password123!", null)).toBe(false);
    expect(await checkLoginPassword("Password123!", "not a hash")).toBe(false);

    // The scrypt calls one check makes. The same single call on every path (same cost, salt and key
    // lengths) means the response time does not tell an account from no account; without the extra
    // derivation, no account (or an unreadable hash) made no call at all.
    const derivations = async (hash: string | null) => {
      const spy = vi.mocked(scrypt);
      spy.mockClear();
      await checkLoginPassword("wrong-password", hash);
      return spy.mock.calls.map(([password, salt, keyLength, options]) => ({
        password,
        saltLength: Buffer.byteLength(salt),
        keyLength,
        options,
      }));
    };
    const account = await derivations(stored);
    expect(account).toEqual([
      {
        password: "wrong-password",
        saltLength: 16,
        keyLength: 64,
        options: expect.objectContaining({ N: 2 ** 14, r: 8, p: 1 }),
      },
    ]);
    expect(await derivations(null)).toEqual(account);
    expect(await derivations("not a hash")).toEqual(account);
  });
});
