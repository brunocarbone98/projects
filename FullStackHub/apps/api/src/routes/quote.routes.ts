import type { ApiErrorDto } from "@shipping-hub/shared";
import { QuoteRequestSchema } from "@shipping-hub/shared";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { parseOrThrow } from "../http/validate.js";
import { getQuote } from "../services/quote.service.js";

export interface QuoteRouterOptions {
  rateLimitMax: number;
  rateLimitWindowMs: number;
}

// Public, unauthenticated quoting endpoint — rate-limited like tracking.
export function createQuoteRouter(options: QuoteRouterOptions): Router {
  const router = Router();

  const limiter = rateLimit({
    windowMs: options.rateLimitWindowMs,
    limit: options.rateLimitMax,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => {
      const body: ApiErrorDto = {
        error: { code: "RATE_LIMITED", message: "Too many requests, please slow down" },
      };
      res.status(429).json(body);
    },
  });

  router.post("/", limiter, async (req, res) => {
    const input = parseOrThrow(QuoteRequestSchema, req.body ?? {});
    res.json(await getQuote(input));
  });

  return router;
}
