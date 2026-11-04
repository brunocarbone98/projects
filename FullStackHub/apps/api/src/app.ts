import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { errorHandler, notFoundHandler } from "./http/error-handler.js";
import { docsBootScriptHash, docsHtml, openapiDocument } from "./openapi.js";
import {
  createAuthRouter,
  DEFAULT_AUTH_LIMITS,
  type AuthRouterOptions,
} from "./routes/auth.routes.js";
import { createQuoteRouter } from "./routes/quote.routes.js";
import { createTrackingRouter } from "./routes/tracking.routes.js";
import { shipmentsRouter } from "./routes/shipments.routes.js";
import { walletRouter } from "./routes/wallet.routes.js";
import { env } from "./env.js";

export interface AppOptions {
  /** Max public-tracking requests per window (default 60). */
  publicRateLimitMax?: number;
  /** Public-tracking rate-limit window in ms (default 60000). */
  publicRateLimitWindowMs?: number;
  /** Login and registration limits (defaults: `DEFAULT_AUTH_LIMITS`). */
  authRateLimits?: Partial<AuthRouterOptions>;
}

// The docs page loads the Scalar reference from jsDelivr and runs one inline script (allowed by its
// hash); every other response is JSON under helmet's default policy.
const docsCsp = helmet.contentSecurityPolicy({
  useDefaults: false,
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", docsBootScriptHash, "https://cdn.jsdelivr.net"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.scalar.com"],
    fontSrc: ["'self'", "data:", "https://cdn.jsdelivr.net", "https://fonts.scalar.com"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'"],
    workerSrc: ["'self'", "blob:"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
  },
});

export function buildApp(options: AppOptions = {}): Express {
  const app = express();

  // In production the API listens on localhost behind the Next.js server, which forwards each
  // visitor's address in X-Forwarded-For. Trusting loopback makes that address req.ip, so the rate
  // limits apply per visitor; direct callers (local runs, CI) send no such header and keep their own.
  app.set("trust proxy", "loopback");
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "api", time: new Date().toISOString() });
  });

  app.use("/api/v1/auth", createAuthRouter({ ...DEFAULT_AUTH_LIMITS, ...options.authRateLimits }));
  app.use("/api/v1/shipments", shipmentsRouter);
  app.use("/api/v1/wallet", walletRouter);
  app.use(
    "/api/v1/tracking",
    createTrackingRouter({
      rateLimitMax: options.publicRateLimitMax ?? 60,
      rateLimitWindowMs: options.publicRateLimitWindowMs ?? 60_000,
    }),
  );
  app.use(
    "/api/v1/quote",
    createQuoteRouter({
      rateLimitMax: options.publicRateLimitMax ?? 60,
      rateLimitWindowMs: options.publicRateLimitWindowMs ?? 60_000,
    }),
  );

  app.get("/api/v1/openapi.json", (_req, res) => {
    res.json(openapiDocument);
  });
  app.get("/api/v1/docs", docsCsp, (_req, res) => {
    res.type("html").send(docsHtml);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
