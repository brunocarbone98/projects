import {
  AuthTokensSchema,
  REFRESH_REUSE_GRACE_MS,
  SESSION_ENDED,
  type AuthResponseDto,
} from "@shipping-hub/shared";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashRefreshToken } from "../src/auth/tokens.js";
import { env } from "../src/env.js";
import { prisma } from "../src/prisma.js";
import { api, DEFAULT_PASSWORD, registerCustomer } from "./helpers.js";

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
