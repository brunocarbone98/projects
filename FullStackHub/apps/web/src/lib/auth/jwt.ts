// Runtime-agnostic JWT decoding (no signature verification — the API verifies).
// Used to read the role/email and the expiry from the access token, including in
// Edge middleware, so we only depend on Web APIs (atob / TextDecoder).
import type { UserRole } from "@shipping-hub/shared";

export interface AccessClaims {
  sub: string;
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function decodeAccessToken(token: string): AccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(base64UrlDecode(parts[1])) as Partial<AccessClaims>;
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    return claims as AccessClaims;
  } catch {
    return null;
  }
}

/** True if the token is expired (or within `skewSeconds` of expiring). */
export function isTokenExpired(claims: AccessClaims, skewSeconds = 30): boolean {
  return claims.exp * 1000 <= Date.now() + skewSeconds * 1000;
}
