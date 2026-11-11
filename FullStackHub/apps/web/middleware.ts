import {
  AuthTokensSchema,
  isSessionEnded,
  shareRefresh,
  visitorAddress,
  type AuthTokensDto,
} from "@shipping-hub/shared";
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

/**
 * What a refresh got: a new token pair, or none, and then whether the API said the session has
 * ended for good (`SESSION_ENDED`: the token is unknown, expired or was revoked earlier). Only then
 * is the refresh cookie deleted; a token used moments ago (`INVALID_TOKEN`), a rate limit or an
 * outage leaves it, because the browser may already hold the rotated pair or may retry later.
 */
type RefreshOutcome = { tokens: AuthTokensDto } | { tokens: null; sessionEnded: boolean };

async function refreshTokens(
  refreshToken: string,
  visitor: string | undefined,
): Promise<RefreshOutcome> {
  try {
    const res = await fetch(`${apiUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The visitor's address, as every other call to the API forwards it (src/lib/client-ip.ts),
        // so the API's refresh limit counts per visitor instead of for the whole site.
        ...(visitor ? { "x-forwarded-for": visitor } : {}),
      },
      body: JSON.stringify({ refreshToken }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) return { tokens: null, sessionEnded: isSessionEnded(res.status, body) };
    // The cookies' lifetimes come from this body, so it is checked before anything is set.
    const parsed = AuthTokensSchema.safeParse(body);
    return parsed.success ? { tokens: parsed.data } : { tokens: null, sessionEnded: false };
  } catch {
    return { tokens: null, sessionEnded: false };
  }
}

// A browser can send several requests with the same expired session at once: a navigation and the
// prefetches of the links in view. The API accepts a refresh token exactly once, so those requests
// share one refresh, and one that arrives a moment later (sent before the new cookies came back)
// gets the same new tokens instead of a trip to the login page. The pair is kept for the API's whole
// grace window (REFRESH_REUSE_GRACE_MS, 30 seconds, from @shipping-hub/shared): within it the API
// would only refuse the old token, so every request the browser sends with it before the new
// cookies arrive is answered here. Only that browser's: the pair is shared under the token together
// with the visitor's address and User-Agent (shareRefresh, keyed by refreshShareKey), so a copy of
// the token sent from elsewhere reaches the API and is refused there, never handed the new pair. A
// later use, which a browser that stored the new cookies never sends, ends that sign-in: the API
// revokes its tokens and answers SESSION_ENDED, and the cookies go.
const refreshes = new Map<string, Promise<RefreshOutcome>>();
const later = (run: () => void, ms: number) => {
  setTimeout(run, ms);
};

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PROTECTED.test(pathname)) {
    const locale = pathname.split("/")[1] || routing.defaultLocale;
    const accessToken = req.cookies.get(ACCESS_COOKIE)?.value;
    const claims = accessToken ? decodeAccessToken(accessToken) : null;
    const valid = claims !== null && !isTokenExpired(claims);

    if (!valid) {
      const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value;
      const visitor = visitorAddress(req.headers.get("x-real-ip"));
      const userAgent = req.headers.get("user-agent");
      const outcome = refreshToken
        ? await shareRefresh(
            refreshes,
            { refreshToken, visitor, userAgent },
            () => refreshTokens(refreshToken, visitor),
            later,
          )
        : null;
      const refreshed = outcome?.tokens ?? null;
      const refreshedClaims = refreshed ? decodeAccessToken(refreshed.accessToken) : null;

      // Only redirect-to-refresh when the new token is actually usable; otherwise
      // go to login. This prevents an infinite refresh→redirect loop.
      if (!refreshed || !refreshedClaims || isTokenExpired(refreshedClaims)) {
        const loginUrl = req.nextUrl.clone();
        loginUrl.pathname = `/${locale}/login`;
        loginUrl.search = `?next=${encodeURIComponent(pathname)}`;
        const res = NextResponse.redirect(loginUrl);
        // The access token is expired or about to be, so it goes: the login page sends any browser
        // that still has one back here, which would bounce it between the two pages until the token
        // expires. A refresh token that can never work again is deleted too, so the browser stops
        // sending it; any other refusal (a rate limit, a token used moments ago, an outage) keeps
        // it, and the next visit tries again.
        res.cookies.delete(ACCESS_COOKIE);
        if (outcome && !outcome.tokens && outcome.sessionEnded) res.cookies.delete(REFRESH_COOKIE);
        return res;
      }

      // Re-run the request with the fresh access cookie in place.
      const res = NextResponse.redirect(req.nextUrl);
      res.cookies.set(
        ACCESS_COOKIE,
        refreshed.accessToken,
        accessCookieOptions(refreshed.expiresIn),
      );
      res.cookies.set(
        REFRESH_COOKIE,
        refreshed.refreshToken,
        refreshCookieOptions(refreshed.refreshExpiresIn),
      );
      return res;
    }
  }

  return intlMiddleware(req);
}

export const config = {
  // Match all paths except API routes, Next internals and files with an extension.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
