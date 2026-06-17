import type { AuthResponseDto, AuthTokensDto, UserDto } from "@shipping-hub/shared";
import type { User } from "@prisma/client";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { generateRefreshToken, hashRefreshToken, signAccessToken } from "../auth/tokens.js";
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

async function issueTokens(user: User): Promise<AuthTokensDto> {
  const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const refresh = generateRefreshToken();
  await prisma.refreshToken.create({
    data: { tokenHash: refresh.tokenHash, userId: user.id, expiresAt: refresh.expiresAt },
  });
  return {
    accessToken,
    refreshToken: refresh.token,
    tokenType: "Bearer",
    expiresIn: env.ACCESS_TOKEN_TTL,
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

/** Rotating refresh: the presented token is revoked and a fresh pair is issued. */
export async function refresh(input: { refreshToken: string }): Promise<AuthTokensDto> {
  const tokenHash = hashRefreshToken(input.refreshToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!stored || stored.revokedAt || stored.expiresAt.getTime() < Date.now()) {
    throw new AppError(401, "INVALID_TOKEN", "Refresh token is invalid or expired");
  }
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });
  return issueTokens(stored.user);
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
