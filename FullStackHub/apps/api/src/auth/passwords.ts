// Password hashing with Node's built-in scrypt (no native dependency).
//
// Written today: a PHC string, `$scrypt$ln=15,r=8,p=3$<salt>$<key>`, at N=2^15, r=8, p=3 (32 MiB
// and 6 times the work of Node's default cost), with a 16-byte salt and a 64-byte key in base64
// without padding, in the standard alphabet. The release before this one (#103) reads it, so rolling
// back to that release locks nobody out. Never roll back past it: earlier releases refuse PHC strings
// (and would read a `scrypt$<N>$<r>$<p>$…` string as an empty key that matches any password, the
// reason the cost is not stored that way).
//
// Also read: `scrypt$<saltHex>$<keyHex>` at Node's default cost (N=2^14, r=8, p=1), the format every
// release before #103 wrote, and PHC strings at other costs or in the URL-safe base64 alphabet (`-`
// and `_`). A sign-in re-hashes any of them at today's cost (`checkLoginPassword`).
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** The cost of a scrypt hash: N (CPU and memory), r (block size) and p (parallelization). */
export interface ScryptCost {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** The cost of the hashes this release writes: 128 · N · r = 32 MiB, 6 times the first format's work. */
export const STORED_COST: ScryptCost = Object.freeze({ N: 2 ** 15, r: 8, p: 3 });

/** The cost of the first format, `scrypt$<saltHex>$<keyHex>`: Node's defaults. */
export const FIRST_FORMAT_COST: ScryptCost = Object.freeze({ N: 2 ** 14, r: 8, p: 1 });

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
/** No stored cost may make one check hold more memory than this (128 · N · r bytes)… */
const MAX_SCRYPT_MEMORY = 256 * 1024 * 1024;
/** …or do more work than this (N · r · p): 32 times the first format's, about 1.3 s on a server CPU. */
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
      cost: FIRST_FORMAT_COST,
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

const base64 = (bytes: Buffer) => bytes.toString("base64").replace(/=+$/, "");

/** The PHC string of a key derived at today's cost. */
function phcString(salt: Buffer, key: Buffer): string {
  const { N, r, p } = STORED_COST;
  return `$scrypt$ln=${Math.log2(N)},r=${r},p=${p}$${base64(salt)}$${base64(key)}`;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  return phcString(salt, await derive(password, salt, STORED_COST));
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const hash = parse(stored);
  if (!hash) return false;
  return timingSafeEqual(await derive(password, hash.salt, hash.cost), hash.key);
}

/** Whether a stored hash's cost differs from today's, so that a sign-in re-hashes it. */
function isStale(cost: ScryptCost): boolean {
  return cost.N !== STORED_COST.N || cost.r !== STORED_COST.r || cost.p !== STORED_COST.p;
}

const NO_ACCOUNT_SALT = randomBytes(SALT_LENGTH);

export interface LoginPasswordCheck {
  /** Whether the password matches the stored hash. */
  readonly matches: boolean;
  /** When it matched a hash at another cost: the password hashed at today's cost, to store instead. */
  readonly rehash: string | null;
}

/**
 * A login's password check, with the same scrypt work whether or not the email has an account. Every
 * path derives once at `STORED_COST`, and the answer waits for that derivation:
 * - a hash at today's cost is checked with it;
 * - no stored hash (`null`), or one this module cannot read, gets it with a fixed salt;
 * - a hash at another cost (the first format, which every release before #103 wrote) is checked at
 *   its own cost alongside it, a fresh hash of the password that the login stores if it matched.
 * So the response time tells neither which emails are registered nor which accounts still hold an
 * older hash. After a rollback to #103, the accounts this release wrote or re-hashed answer a wrong
 * password more slowly than an unknown email there (6 times the work), until this release is back.
 */
export async function checkLoginPassword(
  password: string,
  stored: string | null,
): Promise<LoginPasswordCheck> {
  const hash = stored === null ? null : parse(stored);
  if (!hash) {
    await derive(password, NO_ACCOUNT_SALT, STORED_COST);
    return { matches: false, rehash: null };
  }
  if (!isStale(hash.cost)) {
    const matches = timingSafeEqual(await derive(password, hash.salt, hash.cost), hash.key);
    return { matches, rehash: null };
  }
  const salt = randomBytes(SALT_LENGTH);
  const [key, fresh] = await Promise.all([
    derive(password, hash.salt, hash.cost),
    derive(password, salt, STORED_COST),
  ]);
  const matches = timingSafeEqual(key, hash.key);
  return { matches, rehash: matches ? phcString(salt, fresh) : null };
}
