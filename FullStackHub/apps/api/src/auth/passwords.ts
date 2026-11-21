// Password hashing with Node's built-in scrypt (no native dependency).
//
// Written today: `scrypt$<saltHex>$<keyHex>` at Node's default cost (N=2^14, r=8, p=1), the format
// every release so far writes and reads, so rolling this release back locks nobody out.
//
// Also read: a PHC string, `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<key>`, the format the next
// release writes at a higher cost: a 16-byte salt and a 64-byte key in base64 without padding, in the
// standard alphabet (`+` and `/`). The URL-safe alphabet (`-` and `_`, Node's `base64url`) is read
// too, so a writer that picks it still lands on a release that reads it. Reading PHC first means
// that release can be rolled back to this one without locking out the accounts it re-hashed. It is
// not written yet: the release before this one refuses it (and would read a `scrypt$<N>$<r>$<p>$…`
// string as an empty key that matches any password, the reason the cost is not stored that way).
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** The cost of a scrypt hash: N (CPU and memory), r (block size) and p (parallelization). */
export interface ScryptCost {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** The cost of the hashes this release writes (`scrypt$<saltHex>$<keyHex>`): Node's defaults. */
export const STORED_COST: ScryptCost = Object.freeze({ N: 2 ** 14, r: 8, p: 1 });

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
/** No stored cost may make one check hold more memory than this (128 · N · r bytes)… */
const MAX_SCRYPT_MEMORY = 256 * 1024 * 1024;
/** …or do more work than this (N · r · p): 32 times `STORED_COST`, about 1.3 s on a server CPU. */
const MAX_SCRYPT_WORK = 2 ** 22;

const FIRST_FORMAT = /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{128})$/;
// Node's base64 decoder reads either alphabet; 22 and 86 characters are exactly 16 and 64 bytes.
const PHC_FORMAT =
  /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/_-]{22})\$([A-Za-z0-9+/_-]{86})$/;

interface StoredHash {
  cost: ScryptCost;
  salt: Buffer;
  key: Buffer;
}

function derive(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  // Node refuses a cost above `maxmem` (32 MiB by default); OpenSSL needs 128 · r · (N + p + 2) bytes.
  const maxmem = 2 * 128 * cost.N * cost.r;
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { ...cost, maxmem }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Reads a stored hash; `null` for anything in neither format, or beyond the caps (never throws). */
function parse(stored: string): StoredHash | null {
  const first = FIRST_FORMAT.exec(stored);
  if (first) {
    const [, saltHex = "", keyHex = ""] = first;
    return {
      cost: STORED_COST,
      salt: Buffer.from(saltHex, "hex"),
      key: Buffer.from(keyHex, "hex"),
    };
  }
  const phc = PHC_FORMAT.exec(stored);
  if (!phc) return null;
  const [, ln = "", r = "", p = "", salt = "", key = ""] = phc;
  const cost: ScryptCost = { N: 2 ** Number(ln), r: Number(r), p: Number(p) };
  const sane =
    Number(ln) >= 10 &&
    Number(ln) <= 20 &&
    cost.r >= 1 &&
    cost.r <= 16 &&
    cost.p >= 1 &&
    cost.p <= 16 &&
    128 * cost.N * cost.r <= MAX_SCRYPT_MEMORY &&
    cost.N * cost.r * cost.p <= MAX_SCRYPT_WORK &&
    // OpenSSL's own rule, which Node enforces by throwing: N < 2^(16 · r) (only r = 1 meets it here).
    cost.N < 2 ** (16 * cost.r);
  if (!sane) return null;
  return { cost, salt: Buffer.from(salt, "base64"), key: Buffer.from(key, "base64") };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, STORED_COST);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const hash = parse(stored);
  if (!hash) return false;
  return timingSafeEqual(await derive(password, hash.salt, hash.cost), hash.key);
}

const NO_ACCOUNT_SALT = randomBytes(SALT_LENGTH);

/**
 * A login's password check, with the same scrypt work whether or not the email has an account: no
 * stored hash (`null`), or one this module cannot read, costs one derivation at `STORED_COST`, as a
 * wrong password for an account with a hash this release writes does, so the response time does not
 * tell which emails are registered. The one exception: a PHC hash the next release wrote is checked
 * at its own, higher cost, so after a rollback from that release the accounts it re-hashed answer a
 * wrong password more slowly than an unknown email (6 times the work at N=2^15, r=8, p=3) until it
 * is back.
 */
export async function checkLoginPassword(
  password: string,
  stored: string | null,
): Promise<boolean> {
  const hash = stored === null ? null : parse(stored);
  if (!hash) {
    await derive(password, NO_ACCOUNT_SALT, STORED_COST);
    return false;
  }
  return timingSafeEqual(await derive(password, hash.salt, hash.cost), hash.key);
}
