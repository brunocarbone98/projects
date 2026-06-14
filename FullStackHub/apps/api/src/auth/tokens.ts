// Access tokens are short-lived JWTs. Refresh tokens are opaque random strings;
// only their SHA-256 hash is persisted, and they rotate on every use.
import { createHash, randomBytes } from "node:crypto";
import { USER_ROLES, type UserRole } from "@shipping-hub/shared";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../env.js";
import { AppError } from "../http/errors.js";

export interface AccessClaims {
  sub: string;
  email: string;
  role: UserRole;
}

const AccessClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().min(1),
  role: z.enum(USER_ROLES),
});

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL });
}

export function verifyAccessToken(token: string): AccessClaims {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch {
    throw new AppError(401, "INVALID_TOKEN", "Access token is invalid or expired");
  }
  const parsed = AccessClaimsSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new AppError(401, "INVALID_TOKEN", "Access token payload is malformed");
  }
  return parsed.data;
}

export interface GeneratedRefreshToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export function generateRefreshToken(): GeneratedRefreshToken {
  const token = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { token, tokenHash: hashRefreshToken(token), expiresAt };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
