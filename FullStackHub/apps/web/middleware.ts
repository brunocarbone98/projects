import type { AuthTokensDto } from "@shipping-hub/shared";
import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "./src/i18n/routing";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  accessCookieOptions,
  refreshCookieOptions,
} from "./src/lib/auth/cookies";
import { decodeAccessToken, isTokenExpired } from "./src/lib/auth/jwt";
import { apiUrl } from "./src/lib/config";

const intlMiddleware = createMiddleware(routing);

// Protect the dashboard under /<locale>/app.
const PROTECTED = /^\/(es|en)\/app(?:\/|$)/;

async function refreshTokens(refreshToken: string): Promise<AuthTokensDto | null> {
  try {
    const res = await fetch(`${apiUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    return (await res.json()) as AuthTokensDto;
  } catch {
    return null;
  }
}

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PROTECTED.test(pathname)) {
    const locale = pathname.split("/")[1] || routing.defaultLocale;
    const accessToken = req.cookies.get(ACCESS_COOKIE)?.value;
    const claims = accessToken ? decodeAccessToken(accessToken) : null;
    const valid = claims !== null && !isTokenExpired(claims);

    if (!valid) {
      const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value;
      const refreshed = refreshToken ? await refreshTokens(refreshToken) : null;
      const refreshedClaims = refreshed ? decodeAccessToken(refreshed.accessToken) : null;

      // Only redirect-to-refresh when the new token is actually usable; otherwise
      // go to login. This prevents an infinite refresh→redirect loop.
      if (!refreshed || !refreshedClaims || isTokenExpired(refreshedClaims)) {
        const loginUrl = req.nextUrl.clone();
        loginUrl.pathname = `/${locale}/login`;
        loginUrl.search = `?next=${encodeURIComponent(pathname)}`;
        return NextResponse.redirect(loginUrl);
      }

      // Re-run the request with the fresh access cookie in place.
      const res = NextResponse.redirect(req.nextUrl);
      res.cookies.set(
        ACCESS_COOKIE,
        refreshed.accessToken,
        accessCookieOptions(refreshed.expiresIn),
      );
      res.cookies.set(REFRESH_COOKIE, refreshed.refreshToken, refreshCookieOptions());
      return res;
    }
  }

  return intlMiddleware(req);
}

export const config = {
  // Match all paths except API routes, Next internals and files with an extension.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
