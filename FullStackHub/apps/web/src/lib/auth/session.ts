import type { UserRole } from "@shipping-hub/shared";
import { cookies } from "next/headers";
import { ACCESS_COOKIE } from "./cookies";
import { decodeAccessToken } from "./jwt";

export interface Session {
  userId: string;
  email: string;
  role: UserRole;
  accessToken: string;
}

/** Reads the current session from the access-token cookie, or null if signed out. */
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return null;
  const claims = decodeAccessToken(token);
  if (!claims) return null;
  return { userId: claims.sub, email: claims.email, role: claims.role, accessToken: token };
}

export function isStaff(role: UserRole): boolean {
  return role === "ADMIN" || role === "COURIER";
}
