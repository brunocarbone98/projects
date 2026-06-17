import type { AuthResponseDto } from "@shipping-hub/shared";
import { describe, expect, it } from "vitest";
import { api, DEFAULT_PASSWORD, registerCustomer } from "./helpers.js";

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
