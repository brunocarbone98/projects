import type { Express } from "express";
import supertest from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { DEFAULT_AUTH_LIMITS, type AuthRouterOptions } from "../src/routes/auth.routes.js";
import { api, DEFAULT_PASSWORD, registerCustomer } from "./helpers.js";

const RELAXED: AuthRouterOptions = {
  loginFailuresPerAccountPerClient: 1000,
  loginFailuresPerClient: 1000,
  registrationsPerClient: 1000,
  windowMs: 60_000,
};

/** An app whose auth limits are all relaxed except the ones a test sets. */
function appWith(limits: Partial<AuthRouterOptions>): Express {
  return buildApp({ publicRateLimitMax: 1000, authRateLimits: { ...RELAXED, ...limits } });
}

/** A login as the web server sends it: from loopback, with the visitor's address when it has one. */
function login(app: Express, email: string, password: string, visitor?: string) {
  const request = supertest(app).post("/api/v1/auth/login");
  return (visitor ? request.set("X-Forwarded-For", visitor) : request).send({ email, password });
}

function register(app: Express, email: string, visitor?: string) {
  const request = supertest(app).post("/api/v1/auth/register");
  return (visitor ? request.set("X-Forwarded-For", visitor) : request).send({
    email,
    password: DEFAULT_PASSWORD,
    name: "Rate Limit",
  });
}

describe("login and registration limits", () => {
  it("limits one client's failed logins to an account, in any letter case", async () => {
    await registerCustomer("victim@example.com");
    const app = appWith({ loginFailuresPerAccountPerClient: 3 });

    expect((await login(app, "victim@example.com", "wrong-1", "203.0.113.1")).status).toBe(401);
    expect((await login(app, "VICTIM@example.com", "wrong-2", "203.0.113.1")).status).toBe(401);
    expect((await login(app, "Victim@Example.COM", "wrong-3", "203.0.113.1")).status).toBe(401);

    const blocked = await login(app, "victim@example.com", DEFAULT_PASSWORD, "203.0.113.1");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });

  it("never lets clients lock anyone else out of an account", async () => {
    await registerCustomer("ana@example.com");
    const app = appWith({ loginFailuresPerAccountPerClient: 2 });

    for (const visitor of ["203.0.113.40", "203.0.113.41", "203.0.113.42"]) {
      expect((await login(app, "ana@example.com", "wrong", visitor)).status).toBe(401);
      expect((await login(app, "ana@example.com", "wrong", visitor)).status).toBe(401);
      expect((await login(app, "ana@example.com", DEFAULT_PASSWORD, visitor)).status).toBe(429);
    }
    expect((await login(app, "ana@example.com", DEFAULT_PASSWORD, "198.51.100.43")).status).toBe(
      200,
    );
  });

  it("with the default limits, blocks a guessing client after 10 failures and no one else", async () => {
    await registerCustomer("demo@example.com");
    const app = buildApp({ publicRateLimitMax: 1000, authRateLimits: DEFAULT_AUTH_LIMITS });

    for (let i = 0; i < DEFAULT_AUTH_LIMITS.loginFailuresPerAccountPerClient; i++) {
      expect((await login(app, "demo@example.com", `wrong-${i}`, "203.0.113.30")).status).toBe(401);
    }
    expect((await login(app, "demo@example.com", DEFAULT_PASSWORD, "203.0.113.30")).status).toBe(
      429,
    );
    expect((await login(app, "demo@example.com", DEFAULT_PASSWORD, "198.51.100.31")).status).toBe(
      200,
    );
  });

  it("never counts a successful login", async () => {
    await registerCustomer("regular@example.com");
    const app = appWith({ loginFailuresPerAccountPerClient: 2, loginFailuresPerClient: 2 });

    for (let i = 0; i < 5; i++) {
      expect(
        (await login(app, "regular@example.com", DEFAULT_PASSWORD, "203.0.113.5")).status,
      ).toBe(200);
    }
  });

  it("keeps each account's budget separate", async () => {
    const app = appWith({ loginFailuresPerAccountPerClient: 1 });

    expect((await login(app, "a@example.com", "wrong", "203.0.113.6")).status).toBe(401);
    expect((await login(app, "b@example.com", "wrong", "203.0.113.6")).status).toBe(401);
    expect((await login(app, "a@example.com", "wrong", "203.0.113.6")).status).toBe(429);
  });

  it("counts every email longer than a valid one under a single key", async () => {
    const app = appWith({ loginFailuresPerAccountPerClient: 1 });
    const long = `${"x".repeat(254)}@example.com`;

    expect((await login(app, `${long}-first`, "wrong", "203.0.113.12")).status).toBe(400);
    expect((await login(app, `${long}-second`, "wrong", "203.0.113.12")).status).toBe(429);
  });

  it("limits failed logins per forwarded client across accounts", async () => {
    const app = appWith({ loginFailuresPerClient: 2 });

    expect((await login(app, "one@example.com", "wrong", "203.0.113.7")).status).toBe(401);
    expect((await login(app, "two@example.com", "wrong", "203.0.113.7")).status).toBe(401);
    expect((await login(app, "three@example.com", "wrong", "203.0.113.7")).status).toBe(429);
    expect((await login(app, "four@example.com", "wrong", "198.51.100.9")).status).toBe(401);
  });

  it("limits registrations per forwarded client", async () => {
    const app = appWith({ registrationsPerClient: 2 });

    expect((await register(app, "r1@example.com", "203.0.113.8")).status).toBe(201);
    expect((await register(app, "r2@example.com", "203.0.113.8")).status).toBe(201);
    expect((await register(app, "r3@example.com", "203.0.113.8")).status).toBe(429);
    expect((await register(app, "r4@example.com", "198.51.100.10")).status).toBe(201);
  });

  it("never limits a caller on loopback with no forwarded address", async () => {
    await registerCustomer("local@example.com");
    const app = appWith({
      loginFailuresPerAccountPerClient: 1,
      loginFailuresPerClient: 1,
      registrationsPerClient: 1,
    });

    for (const email of ["x1@example.com", "x2@example.com", "x3@example.com"]) {
      expect((await login(app, "local@example.com", "wrong")).status).toBe(401);
      expect((await register(app, email)).status).toBe(201);
    }
    expect((await login(app, "local@example.com", DEFAULT_PASSWORD)).status).toBe(200);
  });

  it("keys the public rate limits by the forwarded visitor address", async () => {
    const app = buildApp({ publicRateLimitMax: 1, publicRateLimitWindowMs: 60_000 });
    const track = (visitor: string) =>
      supertest(app).get("/api/v1/tracking/PTY-2026-000999-0").set("X-Forwarded-For", visitor);

    expect((await track("203.0.113.20")).status).toBe(404);
    expect((await track("203.0.113.20")).status).toBe(429);
    expect((await track("198.51.100.21")).status).toBe(404);
  });
});

describe("refresh token rotation", () => {
  it("lets only one of two concurrent refreshes with the same token succeed", async () => {
    const { tokens } = await registerCustomer("race@example.com");
    const refresh = () =>
      api().post("/api/v1/auth/refresh").send({ refreshToken: tokens.refreshToken });

    const statuses = (await Promise.all([refresh(), refresh()])).map((res) => res.status).sort();
    expect(statuses).toEqual([200, 401]);
  });
});

describe("content security policy", () => {
  it("sends helmet's default policy with JSON responses", async () => {
    const res = await api().get("/health");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("lets the docs page run only its own inline script and the Scalar bundle", async () => {
    const res = await api().get("/api/v1/docs");
    const policy = String(res.headers["content-security-policy"]);
    expect(policy).toMatch(
      /script-src 'self' 'sha256-[A-Za-z0-9+/]+=*' https:\/\/cdn\.jsdelivr\.net/,
    );
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("upgrade-insecure-requests");
  });
});
