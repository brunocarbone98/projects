// Runs once before the suite: applies migrations to the test database.
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export default function setup(): void {
  const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const parsed = dotenv.config({ path: resolve(apiDir, ".env.test") }).parsed ?? {};
  if (!parsed.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL in apps/api/.env.test");
  }
  execSync("pnpm exec prisma migrate deploy", {
    cwd: apiDir,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: parsed.DATABASE_URL },
  });
}
