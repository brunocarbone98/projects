import type { ApiErrorDto } from "@shipping-hub/shared";
import { hasTrackingCodeShape } from "@shipping-hub/shared";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { badRequest } from "../http/errors.js";
import * as shipmentService from "../services/shipment.service.js";

export interface TrackingRouterOptions {
  rateLimitMax: number;
  rateLimitWindowMs: number;
}

// Public, unauthenticated tracking endpoint — protected by rate limiting.
export function createTrackingRouter(options: TrackingRouterOptions): Router {
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

  router.get("/:code", limiter, async (req, res) => {
    const code = String(req.params.code);
    if (!hasTrackingCodeShape(code)) {
      throw badRequest("Malformed tracking code. Expected format PTY-YYYY-NNNNNN-C");
    }
    res.json(await shipmentService.getPublicTracking(code));
  });

  return router;
}
