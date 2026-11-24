// Loads and validates environment configuration once, at startup.
import { isIP } from "node:net";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: process.env.ENV_FILE ?? ".env" });

export const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // The access tokens' HS256 key: at least 32 characters (256 bits as hex is 64), e.g.
  // `openssl rand -hex 32`. Refresh tokens are opaque random strings stored as SHA-256 hashes, so
  // they need no key.
  JWT_ACCESS_SECRET: z.string().min(32, "must be at least 32 characters (openssl rand -hex 32)"),
  ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  PORT: z.coerce.number().int().positive().default(4000),
  // The address the API listens on. Unset (local runs, CI): every interface, as before. The root
  // Dockerfile sets 127.0.0.1, so in the container only its own processes (the web, through
  // API_INTERNAL_URL) reach the API. Only an IP address is taken, so a mistake stops the API here,
  // naming API_HOST: an empty value (listen() would read it as every interface too), a host name,
  // a host with a port or a URL is refused.
  API_HOST: z
    .string()
    .trim()
    .refine(
      (host) => isIP(host) !== 0,
      "must be an IP address such as 127.0.0.1; unset it to listen on every interface",
    )
    .optional(),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  PUBLIC_WEB_URL: z.string().default("http://localhost:3000"),
  PRICING_SERVICE_URL: z.string().default("http://localhost:8001"),
  LABELS_SERVICE_URL: z.string().default("http://localhost:8002"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Readable in a deploy log: "✖ must be at least 32 characters … → at JWT_ACCESS_SECRET". Zod
  // reports names and rules only, never a value.
  console.error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  throw new Error("Invalid environment configuration");
}

const raw = parsed.data;

export const env = {
  ...raw,
  corsOrigins: raw.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};
