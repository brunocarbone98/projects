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

/**
 * The one algorithm access tokens are signed and verified with. Verification accepts nothing else,
 * so a token signed with another algorithm (HS384 or HS512 with the same key, `none`, an asymmetric
 * one) is refused whatever its header says.
 */
export const ACCESS_TOKEN_ALGORITHM = "HS256";

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: ACCESS_TOKEN_ALGORITHM,
    expiresIn: env.ACCESS_TOKEN_TTL,
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: [ACCESS_TOKEN_ALGORITHM] });
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

/** How long a refresh token lives, in seconds; the API sends it as `refreshExpiresIn`. */
export const REFRESH_TOKEN_TTL_SECONDS = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60;

export function generateRefreshToken(): GeneratedRefreshToken {
  const token = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  return { token, tokenHash: hashRefreshToken(token), expiresAt };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
