import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  checkLoginPassword,
  FIRST_FORMAT_COST,
  hashPassword,
  STORED_COST,
  verifyPassword,
} from "../src/auth/passwords.js";
import { firstFormatHash } from "./helpers.js";
import { verifyPassword as release103Verify } from "./release-103-passwords.js";

// Node's own scrypt behind a spy that changes nothing, so a test can see the derivations a check does.
vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, scrypt: vi.fn(crypto.scrypt) };
});

const base64 = (bytes: Buffer) => bytes.toString("base64").replace(/=+$/, "");

/** `verifyPassword` of the releases before #103, verbatim: what rolling back past #103 would run. */
async function before103Verify(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = (await promisify(scrypt)(password, salt, expected.length)) as Buffer;
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

describe("password hashes", () => {
  it("writes PHC at today's cost, which the release before this one (#103) verifies too", async () => {
    expect(STORED_COST).toEqual({ N: 2 ** 15, r: 8, p: 3 });
    const stored = await hashPassword("Password123!");

    expect(stored).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{86}$/);
    expect(await verifyPassword("Password123!", stored)).toBe(true);
    expect(await verifyPassword("Password123?", stored)).toBe(false);
    // Rolled back to #103, the same account signs in, and only with its password.
    expect(await release103Verify("Password123!", stored)).toBe(true);
    expect(await release103Verify("Password123?", stored)).toBe(false);
    // A fresh salt every time.
    expect(await hashPassword("Password123!")).not.toBe(stored);
  });

  it("reads the first format, and PHC strings at other costs, in either alphabet", async () => {
    expect(FIRST_FORMAT_COST).toEqual({ N: 2 ** 14, r: 8, p: 1 });
    const first = firstFormatHash("Password123!");
    expect(await verifyPassword("Password123!", first)).toBe(true);
    expect(await verifyPassword("wrong-password", first)).toBe(false);

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

  it("never lets a release before #103 read a PHC hash as a match", async () => {
    const stored = await hashPassword("Password123!");
    expect(await before103Verify("any password at all", stored)).toBe(false);
    expect(await before103Verify("Password123!", stored)).toBe(false);
    // Those releases read `scrypt$<N>$<r>$<p>$<salt>$<key>` as an empty key and let any password
    // in: the reason the cost is never stored that way.
    const unsafe = `scrypt$32768$8$3$${randomBytes(16).toString("hex")}$${randomBytes(64).toString("hex")}`;
    expect(await before103Verify("any password at all", unsafe)).toBe(true);
    expect(await verifyPassword("any password at all", unsafe)).toBe(false);
  });

  it("refuses, without throwing or hashing, any stored value it did not write", async () => {
    const saltHex = randomBytes(16).toString("hex");
    const keyHex = randomBytes(64).toString("hex");
    const salt = base64(randomBytes(16));
    const key = base64(randomBytes(64));
    // A salt and a key really derived for the password at the cost Node would compute (it reads r=0
    // as r=8 and p=0 as p=1). Without the floor the ln=9 value matches; without `p >= 1` the p=0 one
    // does. Two rules refuse r=0 (`r >= 1`, and OpenSSL's N < 2^(16 · r) = 1), so neither alone can
    // be pinned; without both, the check throws, or matches once Node can derive at that cost.
    const realSalt = randomBytes(16);
    const saltAndKey = (cost: { N: number; r: number; p: number }) =>
      `${base64(realSalt)}$${base64(scryptSync("Password123!", realSalt, 64, { ...cost, maxmem: 2 ** 26 }))}`;
    const values = [
      "",
      "scrypt$",
      "scrypt$$",
      `scrypt$${saltHex}$`,
      // The releases before #103 match any password against these two (an empty key).
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
      // the first format's: ln=20, r=2, p=16 is 256 MiB but 256 times its work), no block size or lanes.
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

  it("checks a login with the same two derivations on every path, and re-hashes an older hash", async () => {
    const current = await hashPassword("Password123!");
    const older = firstFormatHash("Password123!");
    const refused = { matches: false, rehash: null };
    expect(await checkLoginPassword("Password123!", current)).toEqual({
      matches: true,
      rehash: null,
    });
    expect(await checkLoginPassword("wrong-password", current)).toEqual(refused);
    expect(await checkLoginPassword("Password123!", null)).toEqual(refused);
    expect(await checkLoginPassword("Password123!", "not a hash")).toEqual(refused);
    expect(await checkLoginPassword("wrong-password", older)).toEqual(refused);
    // The right password for an older hash: a new hash at today's cost, which #103 reads too.
    const upgraded = await checkLoginPassword("Password123!", older);
    expect(upgraded.matches).toBe(true);
    const rehash = upgraded.rehash ?? "";
    expect(rehash).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{86}$/);
    expect(await verifyPassword("Password123!", rehash)).toBe(true);
    expect(await verifyPassword("wrong-password", rehash)).toBe(false);
    expect(await release103Verify("Password123!", rehash)).toBe(true);
    // Any other cost is re-hashed too, a higher one included: one term changed at a time.
    for (const cost of [
      { N: 2 ** 14, r: 8, p: 3 },
      { N: 2 ** 15, r: 4, p: 3 },
      { N: 2 ** 15, r: 8, p: 4 },
    ]) {
      const salt = randomBytes(16);
      const key = scryptSync("Password123!", salt, 64, { ...cost, maxmem: 2 ** 26 });
      const stored = `$scrypt$ln=${Math.log2(cost.N)},r=${cost.r},p=${cost.p}$${base64(salt)}$${base64(key)}`;
      const check = await checkLoginPassword("Password123!", stored);
      expect(check.matches, stored).toBe(true);
      expect(check.rehash ?? "", stored).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$/);
    }

    // The scrypt calls one check makes, run by Node's own scrypt: all started together, and each
    // finished before the check answers. Every path makes the same calls in the same order, one at
    // the first format's cost and then one at today's, with the same salt and key lengths. Node's
    // pool runs jobs in the order they come, so the response time tells neither an account from no
    // account nor an older hash from a current one, even with every core and pool thread busy.
    // Without the first call on the other paths, an older hash's check was extra work that showed
    // whenever the pool or the CPU was busy; with the two calls the other way round, it still did.
    const { scrypt: nodeScrypt } =
      await vi.importActual<typeof import("node:crypto")>("node:crypto");
    const derivations = async (hash: string | null) => {
      const spy = vi.mocked(scrypt);
      spy.mockClear();
      const events: string[] = [];
      spy.mockImplementation((password, salt, keyLength, options, done) => {
        events.push("started");
        nodeScrypt(password, salt, keyLength, options, (error, key) => {
          events.push("derived");
          done(error, key);
        });
      });
      try {
        await checkLoginPassword("wrong-password", hash);
      } finally {
        spy.mockImplementation(nodeScrypt);
      }
      events.push("answered");
      const calls = spy.mock.calls.map(([password, salt, keyLength, options]) => ({
        password,
        saltLength: Buffer.byteLength(salt),
        keyLength,
        options,
      }));
      expect(events).toEqual([
        ...calls.map(() => "started"),
        ...calls.map(() => "derived"),
        "answered",
      ]);
      return calls;
    };
    const call = (cost: { N: number; r: number; p: number }) => ({
      password: "wrong-password",
      saltLength: 16,
      keyLength: 64,
      options: expect.objectContaining(cost),
    });
    const account = await derivations(current);
    expect(account).toEqual([call({ N: 2 ** 14, r: 8, p: 1 }), call({ N: 2 ** 15, r: 8, p: 3 })]);
    // No account, an unreadable hash, and an older hash (checked with the first call) alike.
    for (const hash of [null, "not a hash", older]) {
      expect(await derivations(hash), String(hash)).toEqual(account);
    }

    // Either call failing fails the check on every path, and the login answers 500. A call left
    // running unawaited would instead leave its error unhandled, which stops the API.
    const failure = new Error("scrypt failed");
    const spy = vi.mocked(scrypt);
    try {
      for (const failing of [0, 1]) {
        for (const hash of [current, null, "not a hash", older]) {
          let call = 0;
          spy.mockImplementation((_password, _salt, keyLength, _options, done) => {
            if (call++ === failing) done(failure, Buffer.alloc(0));
            else done(null, Buffer.alloc(keyLength));
          });
          await expect(checkLoginPassword("wrong-password", hash), String(hash)).rejects.toBe(
            failure,
          );
        }
      }
    } finally {
      spy.mockImplementation(nodeScrypt);
    }
  });
});
