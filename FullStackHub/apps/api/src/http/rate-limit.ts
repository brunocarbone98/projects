import type { ApiErrorDto } from "@shipping-hub/shared";
import type { Request, Response } from "express";

/** The 429 body every rate limiter sends, in the API's error envelope. */
export function rateLimitedHandler(_req: Request, res: Response): void {
  const body: ApiErrorDto = {
    error: { code: "RATE_LIMITED", message: "Too many attempts, please try again later" },
  };
  res.status(429).json(body);
}

/**
 * True when the caller is this machine itself: the web server when it forwarded no visitor address,
 * or a local run and CI. Per-client limits skip it, so they never turn into one site-wide limit.
 */
export function isLoopback(ip: string | undefined): boolean {
  return ip === undefined || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
