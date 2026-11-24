import { buildApp } from "./app.js";
import { env } from "./env.js";
import { prisma } from "./prisma.js";

const app = buildApp();

// The host in the startup lines: localhost when the API listens on every interface, else the
// address it listens on (an IPv6 one in brackets, as in a URL).
const urlHost =
  env.API_HOST === undefined
    ? "localhost"
    : env.API_HOST.includes(":")
      ? `[${env.API_HOST}]`
      : env.API_HOST;

// Express 5 hands a failed listen (an address this machine does not have, a port in use) to this
// callback rather than throwing: say why and exit 1, so start.sh's `wait -n` and the healthcheck
// see a dead API, never a "listening" line with nothing listening.
function onListening(error?: Error): void {
  if (error) {
    console.error(`[api] cannot listen on ${urlHost}:${env.PORT}: ${error.message}`);
    process.exit(1);
  }
  console.log(`[api] listening on http://${urlHost}:${env.PORT}`);
  console.log(`[api] docs at http://${urlHost}:${env.PORT}/api/v1/docs`);
}

// API_HOST set (the root Dockerfile: 127.0.0.1): that address only. Unset (local runs, CI): no host,
// so every interface, as before.
const server =
  env.API_HOST === undefined
    ? app.listen(env.PORT, onListening)
    : app.listen(env.PORT, env.API_HOST, onListening);

async function shutdown(signal: string): Promise<void> {
  console.log(`[api] received ${signal}, shutting down`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
