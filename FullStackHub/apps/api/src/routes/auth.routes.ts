import { LoginSchema, RefreshSchema, RegisterSchema } from "@shipping-hub/shared";
import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../auth/middleware.js";
import { unauthenticated } from "../http/errors.js";
import { isLoopback, rateLimitedHandler } from "../http/rate-limit.js";
import { parseOrThrow } from "../http/validate.js";
import * as authService from "../services/auth.service.js";

export interface AuthRouterOptions {
  /** Failed logins allowed per email address per window, from any client. */
  loginFailuresPerAccount: number;
  /** Failed logins allowed per client address per window, across accounts; loopback is exempt. */
  loginFailuresPerClient: number;
  /** Registrations allowed per client address per window; loopback is exempt. */
  registrationsPerClient: number;
  /** The window of the three limits, in milliseconds. */
  windowMs: number;
}

export const DEFAULT_AUTH_LIMITS: AuthRouterOptions = {
  loginFailuresPerAccount: 10,
  loginFailuresPerClient: 30,
  registrationsPerClient: 10,
  windowMs: 15 * 60_000,
};

/** The login's email as one key, so "Ana@x" and "ana@x " share an account's budget. */
function accountKey(req: Request): string {
  const body: unknown = req.body;
  const email =
    typeof body === "object" && body !== null && "email" in body && typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : "";
  return `login:${email}`;
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const router = Router();
  const common = {
    windowMs: options.windowMs,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: rateLimitedHandler,
  } as const;

  // Password guessing against one account, whatever the source: only failed attempts count, so a
  // user who signs in is never slowed down.
  const loginPerAccount = rateLimit({
    ...common,
    limit: options.loginFailuresPerAccount,
    skipSuccessfulRequests: true,
    keyGenerator: accountKey,
  });
  // One client trying many accounts (credential stuffing).
  const loginPerClient = rateLimit({
    ...common,
    limit: options.loginFailuresPerClient,
    skipSuccessfulRequests: true,
    skip: (req) => isLoopback(req.ip),
  });
  const registerPerClient = rateLimit({
    ...common,
    limit: options.registrationsPerClient,
    skip: (req) => isLoopback(req.ip),
  });

  router.post("/register", registerPerClient, async (req, res) => {
    const input = parseOrThrow(RegisterSchema, req.body ?? {});
    res.status(201).json(await authService.register(input));
  });

  router.post("/login", loginPerClient, loginPerAccount, async (req, res) => {
    const input = parseOrThrow(LoginSchema, req.body ?? {});
    res.json(await authService.login(input));
  });

  router.post("/refresh", async (req, res) => {
    const input = parseOrThrow(RefreshSchema, req.body ?? {});
    res.json(await authService.refresh(input));
  });

  router.post("/logout", async (req, res) => {
    const input = parseOrThrow(RefreshSchema, req.body ?? {});
    await authService.logout(input);
    res.status(204).end();
  });

  router.get("/me", requireAuth, async (req, res) => {
    if (!req.auth) throw unauthenticated();
    res.json({ user: await authService.getCurrentUser(req.auth.sub) });
  });

  return router;
}
