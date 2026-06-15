#!/usr/bin/env bash
# Run the whole Shipping Hub in one container: the two stateless Python services
# and the Express API on fixed localhost ports, and the Next.js web on Railway's
# $PORT (the single public port). PostgreSQL is Railway's managed database.
set -uo pipefail

# Stateless Python microservices on fixed localhost ports.
( cd services/pricing && exec /opt/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8001 ) &
( cd services/labels  && exec /opt/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8002 ) &

# Transactional API on a fixed localhost port (apply migrations first).
# Fail fast with a clear message if DATABASE_URL is missing, instead of letting
# `prisma migrate deploy` crash-loop with a cryptic P1012 "empty string" error.
(
  cd apps/api
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "FATAL: DATABASE_URL is empty — the API cannot connect to PostgreSQL." >&2
    echo 'Fix it on THIS Railway service: Variables -> New Variable, and in the' >&2
    echo 'value field type  ${{  then pick your Postgres service -> DATABASE_URL' >&2
    echo 'from the dropdown (the service name must match exactly). Then redeploy.' >&2
    exit 1
  fi
  pnpm db:deploy && exec env PORT="${API_PORT:-4000}" pnpm start
) &

# Public web on Railway's $PORT — the single exposed port / domain.
( cd apps/web && exec env PORT="${PORT:-8080}" pnpm start ) &

# If any process exits, stop the container so Railway restarts it.
wait -n
exit 1
