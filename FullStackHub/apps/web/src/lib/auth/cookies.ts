// Cookie names + options for the session tokens. Kept free of next/headers so it
// can be imported from both Server Actions and Edge middleware.

export const ACCESS_COOKIE = "sh_at";
export const REFRESH_COOKIE = "sh_rt";

const REFRESH_MAX_AGE = 60 * 60 * 24 * 7; // 7 days, matches the API refresh TTL

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

function baseOptions(maxAge: number): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

export const accessCookieOptions = (expiresInSeconds: number): SessionCookieOptions =>
  baseOptions(expiresInSeconds);

export const refreshCookieOptions = (): SessionCookieOptions => baseOptions(REFRESH_MAX_AGE);
