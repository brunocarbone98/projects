import { LoginSchema, RefreshSchema, RegisterSchema } from "@shipping-hub/shared";
import { Router, type Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireAuth } from "../auth/middleware.js";
import { unauthenticated } from "../http/errors.js";
import { isLoopback, rateLimitedHandler } from "../http/rate-limit.js";
import { parseOrThrow } from "../http/validate.js";
import * as authService from "../services/auth.service.js";

export interface AuthRouterOptions {
  /** Failed logins allowed per client address and email address per window. */
  loginFailuresPerAccountPerClient: number;
  /** Failed logins allowed per client address per window, across email addresses. */
  loginFailuresPerClient: number;
  /** Registrations allowed per client address per window. */
  registrationsPerClient: number;
  /** Refresh requests allowed per client address per window; logout has a budget of this size too. */
  sessionRequestsPerClient: number;
  /** The window of the limits, in milliseconds. */
  windowMs: number;
}

export const DEFAULT_AUTH_LIMITS: AuthRouterOptions = {
  loginFailuresPerAccountPerClient: 10,
  loginFailuresPerClient: 30,
  registrationsPerClient: 10,
  // A browser refreshes about once per access-token lifetime (15 minutes): 60 leaves room for many
  // tabs and devices behind one address and still caps the database updates one client can cause.
  // Logout gets a budget of the same size of its own.
  sessionRequestsPerClient: 60,
  windowMs: 15 * 60_000,
};

/**
 * The login's email as part of a key, so "Ana@x" and "ana@x " share an account's budget. It is read
 * before validation, so its length is checked before any string operation: a valid email has at
 * most 254 characters, and a substring of a longer value would keep the whole value (up to the
 * 100 kB body limit) in the limiter's memory for the window. Longer values share one key.
 */
function accountKey(req: Request): string {
  const body: unknown = req.body;
  const email =
    typeof body === "object" &&
    body !== null &&
    "email" in body &&
    typeof body.email === "string" &&
    body.email.length <= 254
      ? body.email.trim().toLowerCase()
      : "";
  return `login:${email}`;
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const router = Router();
  // Every limit here counts per client, so no one can lock anyone else out of an account (the
  // public demo accounts included); a client blocks only itself. A caller on loopback with no
  // visitor address (local runs, CI, the web server when it has none to forward) is never limited:
  // counting it would make one bucket for every visitor.
  const common = {
    windowMs: options.windowMs,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: rateLimitedHandler,
    skip: (req: Request) => isLoopback(req.ip),
  } as const;

  // Login limits count failed attempts only, so a user who signs in is never slowed down.
  // One client guessing one account's password:
  const loginPerAccountPerClient = rateLimit({
    ...common,
    limit: options.loginFailuresPerAccountPerClient,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `${accountKey(req)}|${ipKeyGenerator(req.ip ?? "")}`,
  });
  // One client trying many accounts (credential stuffing):
  const loginPerClient = rateLimit({
    ...common,
    limit: options.loginFailuresPerClient,
    skipSuccessfulRequests: true,
  });
  const registerPerClient = rateLimit({ ...common, limit: options.registrationsPerClient });
  // Refresh and logout each run a database update, valid token or not. Each has its own budget, so
  // no amount of refreshing from a shared address can turn someone's sign-out into a 429 that leaves
  // their refresh token live.
  const refreshPerClient = rateLimit({ ...common, limit: options.sessionRequestsPerClient });
  const logoutPerClient = rateLimit({ ...common, limit: options.sessionRequestsPerClient });

  router.post("/register", registerPerClient, async (req, res) => {
    const input = parseOrThrow(RegisterSchema, req.body ?? {});
    res.status(201).json(await authService.register(input));
  });

  router.post("/login", loginPerClient, loginPerAccountPerClient, async (req, res) => {
    const input = parseOrThrow(LoginSchema, req.body ?? {});
    res.json(await authService.login(input));
  });

  router.post("/refresh", refreshPerClient, async (req, res) => {
    const input = parseOrThrow(RefreshSchema, req.body ?? {});
    res.json(await authService.refresh(input));
  });

  router.post("/logout", logoutPerClient, async (req, res) => {
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
