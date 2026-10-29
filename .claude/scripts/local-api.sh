#!/usr/bin/env bash
# =============================================================================
# .claude/scripts/local-api.sh — run the Shipping Hub API locally, in the background
#
# `start` (the default):
#   1. Makes sure PostgreSQL answers on 127.0.0.1:5432 (runs local-postgres.sh otherwise).
#   2. Installs FullStackHub dependencies when node_modules is missing
#      (`pnpm install --frozen-lockfile`).
#   3. Applies the Prisma migrations (`db:deploy`) and loads the demo data
#      (`db:seed`; re-runnable — it clears and recreates the demo set, so the
#      public demo code PTY-2026-001001-0 always exists).
#   4. Starts `@shipping-hub/api` on http://localhost:$API_PORT (default 4000) in
#      its own process group (nohup + setsid), waits for GET /health and for a
#      real database read (GET /api/v1/tracking/PTY-2026-001001-0 → 200), and
#      prints the log and PID file paths.
#   An API that already answers on the port is reused (never a second instance).
#
# The pricing/labels Python services are not started: the API falls back to its
# built-in pricing when services/pricing is unreachable — the same setup
# SecureGate CI uses for the Karate API suite.
#
# Usage:
#   .claude/scripts/local-api.sh            # start (or reuse)
#   .claude/scripts/local-api.sh status     # exit 0 when the API answers /health
#   .claude/scripts/local-api.sh logs       # last 60 log lines
#   .claude/scripts/local-api.sh stop       # stop the instance started by this script
#
# Environment (all optional):
#   API_PORT=4000
#   DATABASE_URL=postgresql://shipping:shipping@127.0.0.1:5432/shipping_hub?schema=public
#   RUN_DIR=/tmp/shipping-hub-api           api.log and api.pid live here
#   SKIP_SEED=1                             keep the current data (no db:seed)
#   JWT_ACCESS_SECRET / JWT_REFRESH_SECRET  local-only throwaway values by default
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FSH_DIR="$REPO_ROOT/FullStackHub"

API_PORT="${API_PORT:-4000}"
RUN_DIR="${RUN_DIR:-/tmp/shipping-hub-api}"
LOG_FILE="$RUN_DIR/api.log"
PID_FILE="$RUN_DIR/api.pid"
BASE_URL="http://localhost:$API_PORT"
DEMO_CODE="PTY-2026-001001-0"

export DATABASE_URL="${DATABASE_URL:-postgresql://shipping:shipping@127.0.0.1:5432/shipping_hub?schema=public}"
export JWT_ACCESS_SECRET="${JWT_ACCESS_SECRET:-local-access-secret-change-me}"
export JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-local-refresh-secret-change-me}"
export PORT="$API_PORT"
export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:3000}"
export PUBLIC_WEB_URL="${PUBLIC_WEB_URL:-http://localhost:3000}"

log() { printf '[local-api] %s\n' "$*"; }
die() { printf '[local-api] ERROR: %s\n' "$*" >&2; exit 1; }

api_up() { curl -fsS -m 5 -o /dev/null "$BASE_URL/health" 2>/dev/null; }
http_code() { curl -sS -m 10 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo "000"; }

ensure_postgres() {
  local pg_isready=/usr/lib/postgresql/16/bin/pg_isready
  [[ -x "$pg_isready" ]] || pg_isready="$(command -v pg_isready || true)"
  if [[ -n "$pg_isready" ]] && "$pg_isready" -h 127.0.0.1 -p 5432 -q >/dev/null 2>&1; then
    return 0
  fi
  log "PostgreSQL is not answering on 127.0.0.1:5432 — starting it"
  "$SCRIPT_DIR/local-postgres.sh"
}

ensure_dependencies() {
  if [[ ! -d "$FSH_DIR/node_modules" || ! -d "$FSH_DIR/apps/api/node_modules" ]]; then
    log "installing FullStackHub dependencies (pnpm install --frozen-lockfile)"
    (cd "$FSH_DIR" && pnpm install --frozen-lockfile)
  fi
}

migrate_and_seed() {
  log "applying migrations (pnpm --filter @shipping-hub/api db:deploy)"
  (cd "$FSH_DIR" && pnpm --filter @shipping-hub/api db:deploy) >"$RUN_DIR/db-deploy.log" 2>&1 \
    || { tail -n 40 "$RUN_DIR/db-deploy.log" >&2; die "migrations failed (log: $RUN_DIR/db-deploy.log)"; }
  if [[ "${SKIP_SEED:-0}" == "1" ]]; then
    log "SKIP_SEED=1 — keeping the current data"
    return 0
  fi
  log "loading the demo data (pnpm --filter @shipping-hub/api db:seed)"
  (cd "$FSH_DIR" && pnpm --filter @shipping-hub/api db:seed) >"$RUN_DIR/db-seed.log" 2>&1 \
    || { tail -n 40 "$RUN_DIR/db-seed.log" >&2; die "seed failed (log: $RUN_DIR/db-seed.log)"; }
}

running_pid() { # prints the PID from the pid file when that process is alive
  local pid
  [[ -s "$PID_FILE" ]] || return 1
  pid="$(<"$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

start_api() {
  mkdir -p "$RUN_DIR"
  if api_up; then
    if pid="$(running_pid)"; then
      log "the API already answers on $BASE_URL (pid $pid, started by this script) — reusing it"
    else
      log "an API already answers on $BASE_URL (not started by this script) — reusing it"
    fi
    return 0
  fi
  rm -f "$PID_FILE"
  : >"$LOG_FILE"
  log "starting the API on $BASE_URL (log: $LOG_FILE)"
  (
    cd "$FSH_DIR"
    # setsid → the API becomes its own session/process-group leader, so `stop` can
    # terminate pnpm, tsx and node together. The child records its own PID.
    nohup setsid bash -c 'echo $$ >"$1"; exec pnpm --filter @shipping-hub/api start' _ "$PID_FILE" \
      >>"$LOG_FILE" 2>&1 </dev/null &
  )
  local i pid=""
  for i in $(seq 1 90); do
    if [[ -z "$pid" && -s "$PID_FILE" ]]; then pid="$(<"$PID_FILE")"; fi
    if api_up; then break; fi
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      tail -n 40 "$LOG_FILE" >&2
      die "the API process exited before answering /health (log: $LOG_FILE)"
    fi
    sleep 1
  done
  api_up || { tail -n 40 "$LOG_FILE" >&2; die "the API did not answer $BASE_URL/health within 90 s (log: $LOG_FILE)"; }
  log "GET /health → ok (pid $(<"$PID_FILE"), pid file: $PID_FILE)"
}

check_demo_data() {
  local code
  code="$(http_code "$BASE_URL/api/v1/tracking/$DEMO_CODE")"
  case "$code" in
    200) log "GET /api/v1/tracking/$DEMO_CODE → 200 (database and demo data OK)" ;;
    404) log "WARNING: GET /api/v1/tracking/$DEMO_CODE → 404: the demo data is missing (run again without SKIP_SEED=1)" ;;
    5*)  tail -n 40 "$LOG_FILE" >&2; die "GET /api/v1/tracking/$DEMO_CODE → $code: the API cannot reach its database (check DATABASE_URL)" ;;
    *)   die "GET /api/v1/tracking/$DEMO_CODE → $code (unexpected)" ;;
  esac
}

stop_api() {
  local pid i
  if pid="$(running_pid)"; then
    log "stopping the API (process group $pid)"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for i in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      log "still alive after 10 s — sending SIGKILL"
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
    log "stopped"
  else
    log "no running instance recorded in $PID_FILE"
  fi
  rm -f "$PID_FILE"
  if api_up; then
    log "note: something still answers on $BASE_URL — it was not started by this script, so it was left alone"
  fi
}

status() {
  if api_up; then
    if pid="$(running_pid)"; then
      log "API up at $BASE_URL (pid $pid, log: $LOG_FILE)"
    else
      log "API up at $BASE_URL (not started by this script)"
    fi
    log "GET /api/v1/tracking/$DEMO_CODE → $(http_code "$BASE_URL/api/v1/tracking/$DEMO_CODE")"
    return 0
  fi
  log "no API answers on $BASE_URL"
  return 1
}

usage() { sed -n '2,/^# ====*$/p' "${BASH_SOURCE[0]}" | sed -n '2,$p' | sed 's/^# \{0,1\}//'; }

case "${1:-start}" in
  start|up) ;;
  status) status; exit $? ;;
  logs) [[ -f "$LOG_FILE" ]] && tail -n 60 "$LOG_FILE" || log "no log at $LOG_FILE"; exit 0 ;;
  stop) stop_api; exit 0 ;;
  -h|--help|help) usage; exit 0 ;;
  *) die "unknown argument '$1' (use: start | status | logs | stop)" ;;
esac

mkdir -p "$RUN_DIR"
ensure_postgres
ensure_dependencies
if api_up; then
  log "an API already answers on $BASE_URL — skipping migrate/seed and reusing it"
else
  migrate_and_seed
fi
start_api
check_demo_data
log "done. Stop it with: $SCRIPT_DIR/local-api.sh stop"
