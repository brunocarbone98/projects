// Password hashing with Node's built-in scrypt (no native dependency).
//
// Stored format: a PHC string, `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<key>` (salt and key in
// base64 without padding), so the cost travels with each hash and can be raised again later. The
// first release stored `scrypt$<saltHex>$<keyHex>` at Node's default cost (N=2^14, r=8, p=1): such a
// hash is still verified, and `needsRehash` tells the login to replace it.
//
// The new format starts with `$`, never with `scrypt$`: the first release's parser refuses it. A
// `scrypt$<N>$<r>$<p>$…` string would not be refused: that parser would read "8" as an empty key and
// accept any password, so a rollback to the first release would open every account re-hashed since.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** The cost of a scrypt hash: N (CPU and memory), r (block size) and p (parallelization). */
export interface ScryptCost {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/**
 * The cost of every new hash: one of the settings OWASP's Password Storage Cheat Sheet lists as
 * equivalent to N=2^17, r=8, p=1, at a quarter of its memory: 32 MiB per hash, not 128 MiB. Node
 * hashes on its libuv thread pool (4 threads by default), so the logins hashing at one moment hold
 * about 128 MiB at most, where N=2^17 would hold 512 MiB in a container that also runs the web and
 * the two Python services. About 0.2 s per hash on a current server CPU (0.04 s at the first cost).
 */
export const SCRYPT_COST: ScryptCost = Object.freeze({ N: 2 ** 15, r: 8, p: 3 });

/** The cost of the first release's hashes (`scrypt$<saltHex>$<keyHex>`): Node's defaults. */
const FIRST_RELEASE_COST: ScryptCost = Object.freeze({ N: 2 ** 14, r: 8, p: 1 });

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
/** No stored cost may make one check hold more memory than this (128 · N · r bytes). */
const MAX_SCRYPT_MEMORY = 256 * 1024 * 1024;

const FIRST_RELEASE_HASH = /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{128})$/;
const PHC_HASH =
  /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{86})$/;

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

const base64 = (bytes: Buffer): string => bytes.toString("base64").replace(/=+$/, "");

/** Reads a stored hash; `null` for anything this module did not write (never throws). */
function parse(stored: string): StoredHash | null {
  const first = FIRST_RELEASE_HASH.exec(stored);
  if (first) {
    const [, saltHex = "", keyHex = ""] = first;
    return {
      cost: FIRST_RELEASE_COST,
      salt: Buffer.from(saltHex, "hex"),
      key: Buffer.from(keyHex, "hex"),
    };
  }
  const phc = PHC_HASH.exec(stored);
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
    128 * cost.N * cost.r <= MAX_SCRYPT_MEMORY;
  if (!sane) return null;
  return { cost, salt: Buffer.from(salt, "base64"), key: Buffer.from(key, "base64") };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, SCRYPT_COST);
  const { N, r, p } = SCRYPT_COST;
  return `$scrypt$ln=${Math.log2(N)},r=${r},p=${p}$${base64(salt)}$${base64(key)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const hash = parse(stored);
  if (!hash) return false;
  const key = await derive(password, hash.salt, hash.cost);
  return timingSafeEqual(key, hash.key);
}

/** Whether a stored hash is below today's cost: the login replaces it once the password is known. */
export function needsRehash(stored: string): boolean {
  const cost = parse(stored)?.cost;
  return cost?.N !== SCRYPT_COST.N || cost.r !== SCRYPT_COST.r || cost.p !== SCRYPT_COST.p;
}

const NO_ACCOUNT_SALT = randomBytes(SALT_LENGTH);

/**
 * Does the scrypt work of checking a password against an account at today's cost, for a login whose
 * email has no account: the response then takes as long as a wrong password for an existing account,
 * so its time does not tell whether the email is registered.
 */
export async function spendPasswordCheck(password: string): Promise<void> {
  await derive(password, NO_ACCOUNT_SALT, SCRYPT_COST);
}
