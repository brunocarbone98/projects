// Loads and validates environment configuration once, at startup.
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: process.env.ENV_FILE ?? ".env" });

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  PUBLIC_WEB_URL: z.string().default("http://localhost:3000"),
  PRICING_SERVICE_URL: z.string().default("http://localhost:8001"),
  LABELS_SERVICE_URL: z.string().default("http://localhost:8002"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", z.treeifyError(parsed.error));
  throw new Error("Invalid environment configuration");
}

const raw = parsed.data;

export const env = {
  ...raw,
  corsOrigins: raw.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};
