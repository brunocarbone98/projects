import type { ApiErrorDto } from "@shipping-hub/shared";
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "./errors.js";

export function notFoundHandler(_req: Request, res: Response): void {
  const body: ApiErrorDto = {
    error: { code: "NOT_FOUND", message: "Route not found" },
  };
  res.status(404).json(body);
}

// Central error handler. Express 5 forwards rejected async handlers here.
// Express identifies error handlers by their 4-argument signature, so _next stays.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  if (err instanceof AppError) {
    const body: ApiErrorDto = {
      error: { code: err.code, message: err.message, details: err.details },
    };
    res.status(err.status).json(body);
    return;
  }

  if (err instanceof ZodError) {
    const body: ApiErrorDto = {
      error: { code: "VALIDATION_ERROR", message: "Invalid request", details: err.issues },
    };
    res.status(400).json(body);
    return;
  }

  console.error("Unhandled error:", err);
  const body: ApiErrorDto = {
    error: { code: "INTERNAL", message: "Internal server error" },
  };
  res.status(500).json(body);
}
