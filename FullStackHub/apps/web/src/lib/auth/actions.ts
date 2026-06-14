"use server";

import type { AuthResponseDto, AuthTokensDto } from "@shipping-hub/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError, serverApi } from "@/lib/server-api";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  accessCookieOptions,
  refreshCookieOptions,
} from "./cookies";

export interface AuthFormState {
  error?: "required" | "invalid_credentials" | "email_taken" | "weak_password" | "unknown";
}

async function persistTokens(tokens: AuthTokensDto): Promise<void> {
  const store = await cookies();
  store.set(ACCESS_COOKIE, tokens.accessToken, accessCookieOptions(tokens.expiresIn));
  store.set(REFRESH_COOKIE, tokens.refreshToken, refreshCookieOptions());
}

export async function login(
  locale: string,
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "required" };

  try {
    const data = await serverApi<AuthResponseDto>("/api/v1/auth/login", {
      method: "POST",
      auth: false,
      body: JSON.stringify({ email, password }),
    });
    await persistTokens(data.tokens);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return { error: "invalid_credentials" };
    return { error: "unknown" };
  }
  redirect(`/${locale}/app`);
}

export async function register(
  locale: string,
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!name || !email || !password) return { error: "required" };
  if (password.length < 8) return { error: "weak_password" };

  try {
    const data = await serverApi<AuthResponseDto>("/api/v1/auth/register", {
      method: "POST",
      auth: false,
      body: JSON.stringify({ name, email, password }),
    });
    await persistTokens(data.tokens);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return { error: "email_taken" };
    if (error instanceof ApiError && error.status === 400) return { error: "weak_password" };
    return { error: "unknown" };
  }
  redirect(`/${locale}/app`);
}

export async function logout(locale: string): Promise<void> {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_COOKIE)?.value;
  if (refreshToken) {
    try {
      await serverApi("/api/v1/auth/logout", {
        method: "POST",
        auth: false,
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      // best effort — clear cookies regardless
    }
  }
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
  redirect(`/${locale}`);
}
