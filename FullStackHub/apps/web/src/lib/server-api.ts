import { cookies } from "next/headers";
import { ACCESS_COOKIE } from "@/lib/auth/cookies";
import { apiUrl } from "@/lib/config";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ServerApiInit extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
  /** Attach the session bearer token (default true). Set false for auth endpoints. */
  auth?: boolean;
  /** Explicit bearer token (used right after login, before cookies are set). */
  token?: string;
}

/**
 * Server-side fetch to the transactional API. Attaches the access token from the
 * httpOnly cookie as a bearer. Throws ApiError on non-2xx responses.
 */
export async function serverApi<T>(path: string, init: ServerApiInit = {}): Promise<T> {
  const { auth = true, token, headers, ...rest } = init;
  const bearer = token ?? (auth ? (await cookies()).get(ACCESS_COOKIE)?.value : undefined);

  const res = await fetch(`${apiUrl}${path}`, {
    ...rest,
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiError(
      res.status,
      body?.error?.code ?? "ERROR",
      body?.error?.message ?? res.statusText,
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
