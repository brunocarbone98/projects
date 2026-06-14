import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { errorHandler, notFoundHandler } from "./http/error-handler.js";
import { docsHtml, openapiDocument } from "./openapi.js";
import { authRouter } from "./routes/auth.routes.js";
import { createTrackingRouter } from "./routes/tracking.routes.js";
import { shipmentsRouter } from "./routes/shipments.routes.js";
import { env } from "./env.js";

export interface AppOptions {
  /** Max public-tracking requests per window (default 60). */
  publicRateLimitMax?: number;
  /** Public-tracking rate-limit window in ms (default 60000). */
  publicRateLimitWindowMs?: number;
}

export function buildApp(options: AppOptions = {}): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "api", time: new Date().toISOString() });
  });

  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/shipments", shipmentsRouter);
  app.use(
    "/api/v1/tracking",
    createTrackingRouter({
      rateLimitMax: options.publicRateLimitMax ?? 60,
      rateLimitWindowMs: options.publicRateLimitWindowMs ?? 60_000,
    }),
  );

  app.get("/api/v1/openapi.json", (_req, res) => {
    res.json(openapiDocument);
  });
  app.get("/api/v1/docs", (_req, res) => {
    res.type("html").send(docsHtml);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
