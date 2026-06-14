import type { UserRole } from "@shipping-hub/shared";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { forbidden, unauthenticated } from "../http/errors.js";
import { verifyAccessToken } from "./tokens.js";

function readBearer(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

/** Requires a valid access token; attaches claims to req.auth. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = readBearer(req);
  if (!token) throw unauthenticated();
  req.auth = verifyAccessToken(token);
  next();
};

/** Attaches req.auth when a valid token is present, but never rejects. */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = readBearer(req);
  if (token) {
    try {
      req.auth = verifyAccessToken(token);
    } catch {
      // ignore — treated as anonymous
    }
  }
  next();
};

/** Requires the authenticated user to hold one of the given roles. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw unauthenticated();
    if (!roles.includes(req.auth.role)) throw forbidden();
    next();
  };
}
