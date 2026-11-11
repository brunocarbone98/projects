// How the API and the web agree on a refused refresh token.
//
// A refresh token is single use. When the web refreshes an expired session, a browser can send
// several requests with the old token before the rotated cookies come back (a navigation and its
// prefetches, two tabs). The API accepts the token once; the web hands the browser's other requests
// the same new pair, and only that browser's (`refreshShareKey`). What the API answers to a token it
// refuses tells the web whether the browser's refresh cookie may still be good (keep it: the expiring
// access cookie goes either way) or can never work again (delete both, so the browser stops
// replaying it).

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
 * One refresh per token and browser at a time. The requests a browser sends with an expired session
 * (a navigation and its prefetches, two tabs) share the first one's call to the API and its outcome,
 * under {@link refreshShareKey}, so a copy of the token sent from another address or by another
 * browser never shares it: it reaches the API, which refuses it. A new pair stays shared for
 * `graceMs` (the API's grace window, within which it would only refuse the old token, so a request
 * sent before the new cookies arrived still gets them); a refusal, or a call that throws, is dropped
 * as soon as it settles, so the next request asks the API again. `pending` is the caller's own map,
 * one per process; `later` runs a function after some milliseconds (the web passes `setTimeout`,
 * tests their own clock), which keeps this module free of any runtime's timers.
 */
export function shareRefresh<T extends { tokens: unknown }>(
  pending: Map<string, Promise<T>>,
  share: {
    refreshToken: string;
    visitor: string | null | undefined;
    userAgent: string | null | undefined;
  },
  refresh: () => Promise<T>,
  later: (run: () => void, ms: number) => void,
  graceMs: number = REFRESH_REUSE_GRACE_MS,
): Promise<T> {
  const key = refreshShareKey(share.refreshToken, share.visitor, share.userAgent);
  const shared = pending.get(key);
  if (shared) return shared;
  const outcome = refresh().then(
    (result) => {
      if (result.tokens) later(() => pending.delete(key), graceMs);
      else pending.delete(key);
      return result;
    },
    (error: unknown) => {
      pending.delete(key);
      throw error;
    },
  );
  pending.set(key, outcome);
  return outcome;
}

/**
 * The error code of a refused refresh token that can never be used again: unknown, expired, or
 * revoked more than `REFRESH_REUSE_GRACE_MS` earlier (then the API also revokes the rest of that
 * sign-in's tokens). The caller drops it and signs in again. `INVALID_TOKEN` instead means the token
 * was used moments ago: a concurrent request may already hold its successor, so the caller keeps the
 * refresh token it has.
 */
export const SESSION_ENDED = "SESSION_ENDED";

const SessionEndedBody = z.object({ error: z.object({ code: z.literal(SESSION_ENDED) }) });

/** Whether the API's answer to a refresh says the session has ended for good. */
export function isSessionEnded(status: number, body: unknown): boolean {
  return status === 401 && SessionEndedBody.safeParse(body).success;
}
