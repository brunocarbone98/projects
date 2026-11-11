import {
  REFRESH_REUSE_GRACE_MS,
  SESSION_ENDED,
  type AuthResponseDto,
  type AuthTokensDto,
  type UserDto,
} from "@shipping-hub/shared";
import type { User } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  signAccessToken,
} from "../auth/tokens.js";
import { env } from "../env.js";
import { AppError, conflict, invalidCredentials } from "../http/errors.js";
import { prisma } from "../prisma.js";

function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Issues an access token and a refresh token. A sign-in starts a new family; a rotation passes its
 * token's family on, so every token of one sign-in shares it (see `refusal`).
 */
async function issueTokens(user: User, familyId: string = randomUUID()): Promise<AuthTokensDto> {
  const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const refresh = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      tokenHash: refresh.tokenHash,
      familyId,
      userId: user.id,
      expiresAt: refresh.expiresAt,
    },
  });
  return {
    accessToken,
    refreshToken: refresh.token,
    tokenType: "Bearer",
    expiresIn: env.ACCESS_TOKEN_TTL,
    refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
  };
}

export async function register(input: {
  email: string;
  password: string;
  name: string;
}): Promise<AuthResponseDto> {
  const email = input.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw conflict("EMAIL_TAKEN", "That email is already registered");

  const user = await prisma.user.create({
    data: { email, name: input.name, passwordHash: await hashPassword(input.password) },
  });
  return { user: toUserDto(user), tokens: await issueTokens(user) };
}

export async function login(input: { email: string; password: string }): Promise<AuthResponseDto> {
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (!user) throw invalidCredentials();
  if (!(await verifyPassword(input.password, user.passwordHash))) throw invalidCredentials();
  return { user: toUserDto(user), tokens: await issueTokens(user) };
}

/**
 * Why a refresh token was refused, and what else that costs. A token revoked less than
 * `REFRESH_REUSE_GRACE_MS` ago was most likely rotated by a concurrent request of the same browser
 * (two tabs, or a navigation and its prefetches), which may already hold its successor: a plain
 * `INVALID_TOKEN`, nothing else revoked, and the web keeps the browser's cookies. Every other refused
 * token can never be used again, so the answer is `SESSION_ENDED` and the web deletes the cookies.
 *
 * A token presented again past the window may have been copied: then both the user and someone else
 * hold it, and which of them rotated it first cannot be told. So every live token of its family (the
 * tokens that one sign-in produced by rotation) is revoked too, and that sign-in has to sign in
 * again. The user's other sign-ins, and other people's sign-ins to a shared demo account, are left
 * alone. Access tokens already issued stay valid until they expire (`ACCESS_TOKEN_TTL`).
 */
async function refusal(tokenHash: string, now: Date): Promise<AppError> {
  const presented = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: { userId: true, familyId: true, revokedAt: true },
  });
  if (presented?.revokedAt) {
    if (now.getTime() - presented.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS) {
      return new AppError(401, "INVALID_TOKEN", "Refresh token has already been used");
    }
    const { count } = await prisma.refreshToken.updateMany({
      where: { familyId: presented.familyId, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });
    console.warn(
      `[auth] reuse of a revoked refresh token of user ${presented.userId}: revoked the ${count} live refresh token(s) of that sign-in`,
    );
  }
  return new AppError(401, SESSION_ENDED, "Session has ended; sign in again");
}

/**
 * Rotating refresh: the presented token is revoked and a fresh pair of the same family is issued.
 * A token that is unknown, expired or revoked is refused (see `refusal`).
 */
export async function refresh(input: { refreshToken: string }): Promise<AuthTokensDto> {
  const tokenHash = hashRefreshToken(input.refreshToken);
  const now = new Date();
  // One conditional UPDATE revokes the token, so two concurrent requests with the same token cannot
  // both get a new pair: only the request whose update still found it live goes on.
  const revoked = await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now },
  });
  if (revoked.count !== 1) throw await refusal(tokenHash, now);
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  // Only gone when its user was deleted in between (the tokens cascade).
  if (!stored) throw new AppError(401, SESSION_ENDED, "Session has ended; sign in again");
  return issueTokens(stored.user, stored.familyId);
}

export async function logout(input: { refreshToken: string }): Promise<void> {
  const tokenHash = hashRefreshToken(input.refreshToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getCurrentUser(userId: string): Promise<UserDto> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(401, "UNAUTHENTICATED", "User no longer exists");
  return toUserDto(user);
}
