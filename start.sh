#!/usr/bin/env bash
# Run the whole Shipping Hub in one container: the two stateless Python services
# and the Express API on fixed localhost ports, and the Next.js web on Railway's
# $PORT (the single public port). PostgreSQL is Railway's managed database.
set -uo pipefail

# Stateless Python microservices on fixed localhost ports.
( cd services/pricing && exec /opt/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8001 ) &
( cd services/labels  && exec /opt/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8002 ) &

# Transactional API on a fixed localhost port (apply migrations first).
( cd apps/api && pnpm db:deploy && exec env PORT="${API_PORT:-4000}" pnpm start ) &

# Public web on Railway's $PORT — the single exposed port / domain.
( cd apps/web && exec env PORT="${PORT:-8080}" pnpm start ) &

# If any process exits, stop the container so Railway restarts it.
wait -n
exit 1
