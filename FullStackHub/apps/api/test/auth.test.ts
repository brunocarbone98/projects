import {
  AuthTokensSchema,
  REFRESH_REUSE_GRACE_MS,
  SESSION_ENDED,
  type AuthResponseDto,
} from "@shipping-hub/shared";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/passwords.js";
import { generateRefreshToken, hashRefreshToken } from "../src/auth/tokens.js";
import { env } from "../src/env.js";
import { prisma } from "../src/prisma.js";
import { storeRehash } from "../src/services/auth.service.js";
import { api, DEFAULT_PASSWORD, firstFormatHash, registerCustomer } from "./helpers.js";
import { verifyPassword as release103Verify } from "./release-103-passwords.js";

const refresh = (refreshToken: string) => api().post("/api/v1/auth/refresh").send({ refreshToken });

const logout = (refreshToken: string) => api().post("/api/v1/auth/logout").send({ refreshToken });

async function loginAgain(email: string): Promise<AuthResponseDto> {
  const res = await api().post("/api/v1/auth/login").send({ email, password: DEFAULT_PASSWORD });
  expect(res.status).toBe(200);
  return res.body as AuthResponseDto;
}

/** Moves a refresh token's revocation back in time, past the reuse grace window. */
async function revokedLongAgo(refreshToken: string): Promise<void> {
  await prisma.refreshToken.update({
    where: { tokenHash: hashRefreshToken(refreshToken) },
    data: { revokedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1_000) },
  });
}

const liveTokens = (userId: string) =>
  prisma.refreshToken.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } });

async function familyOf(refreshToken: string): Promise<string | undefined> {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(refreshToken) },
  });
  return stored?.familyId;
}

const REFRESH_TTL_SECONDS = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth", () => {
  it("registers a customer and returns tokens", async () => {
    const res = await api()
      .post("/api/v1/auth/register")
      .send({ email: "new@example.com", password: DEFAULT_PASSWORD, name: "New User" });

    expect(res.status).toBe(201);
    const body = res.body as AuthResponseDto;
    expect(body.user.role).toBe("CUSTOMER");
    expect(body.user.email).toBe("new@example.com");
    expect(body.tokens.accessToken).toBeTruthy();
    expect(body.tokens.refreshToken).toBeTruthy();
    expect(AuthTokensSchema.parse(body.tokens).refreshExpiresIn).toBe(REFRESH_TTL_SECONDS);
  });

  it("tells login and refresh callers how long each token lives", async () => {
    await registerCustomer("ttl@example.com");
    const { tokens } = await loginAgain("ttl@example.com");
    expect(AuthTokensSchema.parse(tokens)).toMatchObject({
      tokenType: "Bearer",
      expiresIn: env.ACCESS_TOKEN_TTL,
      refreshExpiresIn: REFRESH_TTL_SECONDS,
    });

    const rotated = await refresh(tokens.refreshToken);
    expect(rotated.status).toBe(200);
    expect(AuthTokensSchema.parse(rotated.body)).toMatchObject({
      expiresIn: env.ACCESS_TOKEN_TTL,
      refreshExpiresIn: REFRESH_TTL_SECONDS,
    });
  });

  it("rejects a short password with VALIDATION_ERROR", async () => {
    const res = await api()
      .post("/api/v1/auth/register")
      .send({ email: "short@example.com", password: "123", name: "Nope" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a duplicate email", async () => {
    await registerCustomer("dupe@example.com");
    const res = await api()
      .post("/api/v1/auth/register")
      .send({ email: "dupe@example.com", password: DEFAULT_PASSWORD, name: "Dupe" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("rejects bad credentials", async () => {
    await registerCustomer("login@example.com");
    const res = await api()
      .post("/api/v1/auth/login")
      .send({ email: "login@example.com", password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("returns the current user with a valid token and 401 without one", async () => {
    const { tokens } = await registerCustomer("me@example.com");

    const ok = await api()
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${tokens.accessToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe("me@example.com");

    const anon = await api().get("/api/v1/auth/me");
    expect(anon.status).toBe(401);
  });

  it("rotates refresh tokens and invalidates the used one", async () => {
    const { tokens } = await registerCustomer("rotate@example.com");

    const first = await api()
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: tokens.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(tokens.refreshToken);

    // Reusing the original (now revoked) refresh token must fail.
    const reuse = await api()
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: tokens.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe("INVALID_TOKEN");
  });
});

describe("refresh token families", () => {
  it("keeps one family across rotations and starts a new one at each sign-in", async () => {
    const first = await registerCustomer("family@example.com");
    const rotated = await refresh(first.tokens.refreshToken);
    expect(rotated.status).toBe(200);
    const again = await refresh(rotated.body.refreshToken);
    expect(again.status).toBe(200);
    const otherSignIn = await loginAgain("family@example.com");

    const family = await familyOf(first.tokens.refreshToken);
    expect(family).toBeTruthy();
    expect(await familyOf(rotated.body.refreshToken)).toBe(family);
    expect(await familyOf(again.body.refreshToken)).toBe(family);
    expect(await familyOf(otherSignIn.tokens.refreshToken)).not.toBe(family);
  });

  it("gives a token stored without a family (the previous release's insert) one of its own", async () => {
    const { user } = await registerCustomer("previous-release@example.com");
    // The insert of the release before the families, which knows no familyId column: it still
    // serves while a deploy boots and again after a rollback, so it must keep signing people in.
    const tokens = [generateRefreshToken(), generateRefreshToken()];
    for (const token of tokens) {
      await prisma.$executeRaw`INSERT INTO "refresh_tokens" ("id", "tokenHash", "userId", "expiresAt") VALUES (${randomUUID()}, ${token.tokenHash}, ${user.id}, ${token.expiresAt})`;
    }
    const [first, second] = await Promise.all(tokens.map((token) => familyOf(token.token)));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);

    // The current release rotates such a token within its family.
    const rotated = await refresh(tokens[0]?.token ?? "");
    expect(rotated.status).toBe(200);
    expect(await familyOf(rotated.body.refreshToken)).toBe(first);
  });
});

describe("refresh token reuse", () => {
  it("revokes that sign-in's tokens when a revoked token comes back after the grace window, and nothing else", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const victim = await registerCustomer("reused@example.com");
    // The same account signed in elsewhere (another device, or another visitor of a shared demo
    // account): replaying one sign-in's old token never signs this one out.
    const otherSignIn = await loginAgain("reused@example.com");
    const bystander = await registerCustomer("bystander@example.com");

    const rotated = await refresh(victim.tokens.refreshToken);
    expect(rotated.status).toBe(200);
    await revokedLongAgo(victim.tokens.refreshToken);

    const replay = await refresh(victim.tokens.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe(SESSION_ENDED);

    // The replayed sign-in's live token is revoked; the user's other sign-in and other users are not.
    expect((await refresh(rotated.body.refreshToken)).status).toBe(401);
    expect(await liveTokens(victim.user.id)).toBe(1);
    expect((await refresh(otherSignIn.tokens.refreshToken)).status).toBe(200);
    expect(await liveTokens(bystander.user.id)).toBe(1);
    expect((await refresh(bystander.tokens.refreshToken)).status).toBe(200);

    // One warning line that names the user and the event, and no token.
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain(victim.user.id);
    expect(line).toContain("reuse");
    expect(line).toContain("revoked the 1 live refresh token(s)");
    for (const token of [
      victim.tokens.refreshToken,
      rotated.body.refreshToken,
      otherSignIn.tokens.refreshToken,
    ]) {
      expect(line).not.toContain(token);
      expect(line).not.toContain(hashRefreshToken(token));
    }
  });

  it("refuses a reuse inside the grace window with INVALID_TOKEN and revokes nothing else", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const user = await registerCustomer("twotabs@example.com");
    const otherSignIn = await loginAgain("twotabs@example.com");

    const rotated = await refresh(user.tokens.refreshToken);
    expect(rotated.status).toBe(200);

    const second = await refresh(user.tokens.refreshToken);
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe("INVALID_TOKEN");

    expect(await liveTokens(user.user.id)).toBe(2);
    expect((await refresh(rotated.body.refreshToken)).status).toBe(200);
    expect((await refresh(otherSignIn.tokens.refreshToken)).status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  it("ends the session of an unknown token, revoking and logging nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const user = await registerCustomer("unknown@example.com");

    const res = await refresh("not-a-refresh-token-the-api-issued");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(SESSION_ENDED);
    expect(await liveTokens(user.user.id)).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("ends the session of an expired token without touching the user's other sessions", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const user = await registerCustomer("expired@example.com");
    const otherSignIn = await loginAgain("expired@example.com");
    await prisma.refreshToken.update({
      where: { tokenHash: hashRefreshToken(user.tokens.refreshToken) },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const res = await refresh(user.tokens.refreshToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(SESSION_ENDED);
    expect((await refresh(otherSignIn.tokens.refreshToken)).status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a session out and leaves the user's other sessions signed in", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const user = await registerCustomer("logout@example.com");
    const otherSignIn = await loginAgain("logout@example.com");

    expect((await logout(user.tokens.refreshToken)).status).toBe(204);
    const after = await refresh(user.tokens.refreshToken);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("INVALID_TOKEN");
    expect((await logout(user.tokens.refreshToken)).status).toBe(204);

    // Past the grace window a signed-out token's session has ended for good.
    await revokedLongAgo(user.tokens.refreshToken);
    const later = await refresh(user.tokens.refreshToken);
    expect(later.status).toBe(401);
    expect(later.body.error.code).toBe(SESSION_ENDED);

    expect((await refresh(otherSignIn.tokens.refreshToken)).status).toBe(200);
  });
});

describe("access token algorithm", () => {
  const claims = (user: AuthResponseDto["user"]) => ({
    sub: user.id,
    email: user.email,
    role: user.role,
  });
  const me = (token: string) =>
    api().get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);

  it("signs access tokens with HS256", async () => {
    const { tokens } = await registerCustomer("hs256@example.com");
    expect(jwt.decode(tokens.accessToken, { complete: true })?.header.alg).toBe("HS256");
  });

  it("refuses a token signed with the right secret but another algorithm", async () => {
    const { user } = await registerCustomer("alg@example.com");
    for (const algorithm of ["HS384", "HS512"] as const) {
      const token = jwt.sign(claims(user), env.JWT_ACCESS_SECRET, { algorithm, expiresIn: 60 });
      const res = await me(token);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_TOKEN");
    }
  });

  it("refuses an unsigned token", async () => {
    const { user } = await registerCustomer("none@example.com");
    const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({
      ...claims(user),
      iat: now,
      exp: now + 60,
    })}.`;

    const res = await me(unsigned);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });
});

describe("password checks at login", () => {
  const login = (email: string, password: string) =>
    api().post("/api/v1/auth/login").send({ email, password });
  const storedHash = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id } })).passwordHash;
  /** An account whose password is stored in the first format, as every release before #103 did. */
  const olderAccount = (email: string) =>
    prisma.user.create({
      data: { email, name: "Older Hash", passwordHash: firstFormatHash(DEFAULT_PASSWORD) },
    });
  const todaysFormat = /^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{86}$/;

  it("answers an unknown email like a wrong password, for current and older hashes alike", async () => {
    await registerCustomer("known@example.com");
    await olderAccount("older@example.com");
    const timed = async (email: string) => {
      const started = performance.now();
      const res = await login(email, "wrong-password");
      return { res, ms: performance.now() - started };
    };
    const known: Awaited<ReturnType<typeof timed>>[] = [];
    const older: Awaited<ReturnType<typeof timed>>[] = [];
    const unknown: Awaited<ReturnType<typeof timed>>[] = [];
    for (let i = 0; i < 5; i += 1) {
      known.push(await timed("known@example.com"));
      older.push(await timed("older@example.com"));
      unknown.push(await timed(`nobody-${i}@example.com`));
    }
    for (const { res } of [...known, ...older, ...unknown]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(known[0]?.res.body);
    }

    // Each answer waits for one scrypt derivation at today's cost (about 0.2 s). Without it, an
    // unknown email was answered after one database read (a ratio of about 0.02) and an older hash
    // after its own, cheaper check (about 0.2). The wide bounds keep a machine busy with other work
    // from failing the test with the derivation in place.
    const median = (runs: { ms: number }[]) =>
      runs.map((run) => run.ms).sort((a, b) => a - b)[2] ?? 0;
    for (const other of [unknown, older]) {
      expect(median(other) / median(known)).toBeGreaterThan(0.3);
      expect(median(other) / median(known)).toBeLessThan(3);
    }
  });

  it("re-hashes an older hash at today's cost when the account signs in, and only then", async () => {
    const user = await olderAccount("rehash@example.com");

    expect((await login("rehash@example.com", "wrong-password")).status).toBe(401);
    expect(await storedHash(user.id)).toBe(user.passwordHash);

    expect((await login("Rehash@example.com", DEFAULT_PASSWORD)).status).toBe(200);
    const upgraded = await storedHash(user.id);
    expect(upgraded).toMatch(todaysFormat);
    // Rolled back to #103, the account still signs in.
    expect(await release103Verify(DEFAULT_PASSWORD, upgraded)).toBe(true);

    // A hash at today's cost stays as it is.
    expect((await login("rehash@example.com", DEFAULT_PASSWORD)).status).toBe(200);
    expect(await storedHash(user.id)).toBe(upgraded);
  });

  it("never overwrites a hash changed in between, and never fails a sign-in on the write", async () => {
    // The stored hash changed after the sign-in read it: the re-hash is not stored.
    const raced = await olderAccount("raced@example.com");
    const changed = await hashPassword("Another-Password1!");
    await prisma.user.update({ where: { id: raced.id }, data: { passwordHash: changed } });
    await storeRehash(raced, await hashPassword(DEFAULT_PASSWORD));
    expect(await storedHash(raced.id)).toBe(changed);

    // The write fails with an error that repeats the query's values, as a Prisma error can: the
    // sign-in still succeeds, the older hash stays, and the warning names the account but neither
    // the password nor a hash.
    const failing = await olderAccount("write-fails@example.com");
    const echoed = `Invalid prisma.user.updateMany() invocation: passwordHash "${failing.passwordHash}"`;
    vi.spyOn(prisma.user, "updateMany").mockRejectedValueOnce(new Error(echoed));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await login("write-fails@example.com", DEFAULT_PASSWORD)).status).toBe(200);
    expect(await storedHash(failing.id)).toBe(failing.passwordHash);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = (warn.mock.calls[0] ?? []).map(String).join(" ");
    expect(logged).toContain(failing.id);
    expect(logged).not.toContain(DEFAULT_PASSWORD);
    expect(logged).not.toContain("scrypt$");
  });

  it("stores a new account's password at today's cost, which #103 reads too", async () => {
    const { user } = await registerCustomer("format@example.com");
    const stored = await storedHash(user.id);
    expect(stored).toMatch(todaysFormat);
    expect(await release103Verify(DEFAULT_PASSWORD, stored)).toBe(true);
  });
});
