// How the API and the web agree on a refused refresh token.
//
// A refresh token is single use. When the web refreshes an expired session, a browser can send
// several requests with the old token before the rotated cookies come back (a navigation and its
// prefetches, two tabs). The API accepts the token once; the web hands the browser's other requests
// the same new pair, and only that browser's (`refreshShareKey`). What the API answers to a token it
// refuses tells the web whether the browser's cookies may still be good (keep them) or can never
// work again (delete them, so the browser stops replaying them).

import { z } from "zod";

/**
 * How long after a refresh token was rotated or revoked a second use of it still counts as a race of
 * one browser rather than a replay of a copy. The API answers such a use with `INVALID_TOKEN` and
 * revokes nothing else; the web shares one refresh per token and browser for the same time, so every
 * request that browser sends with the old token in that window gets the new pair.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;

/**
 * The key under which the web shares one refresh: the refresh token together with the visitor's
 * address and the browser's `User-Agent`. The requests one browser sends with an expired session
 * carry all three, so they share one refresh and its new pair. A copy of the token sent from another
 * address or by another browser does not match: it reaches the API, which refuses it
 * (`INVALID_TOKEN` inside the grace window; after it `SESSION_ENDED`, and that sign-in's tokens are
 * revoked), so the new pair is never handed to it. A missing address or `User-Agent` is a value of
 * its own, never a wildcard.
 */
export function refreshShareKey(
  refreshToken: string,
  visitor: string | null | undefined,
  userAgent: string | null | undefined,
): string {
  // JSON keeps the three apart whatever characters they hold.
  return JSON.stringify([refreshToken, visitor ?? null, userAgent ?? null]);
}

/**
 * The error code of a refused refresh token that can never be used again: unknown, expired, or
 * revoked more than `REFRESH_REUSE_GRACE_MS` earlier (then the API also revokes the rest of that
 * sign-in's tokens). The caller drops it and signs in again. `INVALID_TOKEN` instead means the token
 * was used moments ago: a concurrent request may already hold its successor, so the caller keeps what
 * it has.
 */
export const SESSION_ENDED = "SESSION_ENDED";

const SessionEndedBody = z.object({ error: z.object({ code: z.literal(SESSION_ENDED) }) });

/** Whether the API's answer to a refresh says the session has ended for good. */
export function isSessionEnded(status: number, body: unknown): boolean {
  return status === 401 && SessionEndedBody.safeParse(body).success;
}
