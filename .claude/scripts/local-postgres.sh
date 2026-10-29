#!/usr/bin/env bash
# =============================================================================
# .claude/scripts/local-postgres.sh — a throwaway PostgreSQL 16 for Shipping Hub
#
# When this script exits 0 a PostgreSQL server answers on $PGHOST:$PGPORT, the
# role `shipping` (password `shipping`) can log in, and the databases
# `shipping_hub` and `shipping_hub_test` exist — exactly what
# FullStackHub/apps/api/.env.example, apps/api/.env.test and docker-compose.yml
# expect. It is idempotent: run it as often as you like.
#
# Strategy, in order:
#   1. Reuse — something already listens on $PGHOST:$PGPORT (the Docker container,
#      a system service, or a cluster started earlier by this script).
#   2. Docker — when the Docker daemon works: `docker compose up -d postgres` in
#      FullStackHub/ (the project's standard local database).
#   3. Local binaries — initdb + pg_ctl from $PG_BIN (default
#      /usr/lib/postgresql/16/bin) into $PGDATA_DIR, listening on 127.0.0.1 only.
#      PostgreSQL refuses to run as root, so as root every server command runs
#      as the `postgres` OS user through `su`.
#
# Usage:
#   .claude/scripts/local-postgres.sh            # start or reuse, then ensure role + databases
#   .claude/scripts/local-postgres.sh status     # report; exit 0 when ready, 1 when not
#   .claude/scripts/local-postgres.sh stop       # stop the cluster running from $PGDATA_DIR (not Docker)
#
# Environment (all optional):
#   PGHOST=127.0.0.1   PGPORT=5432
#   PGDATA_DIR         root: /var/lib/postgresql/claude-local · others: $HOME/.cache/shipping-hub/pgdata
#   PG_BIN             /usr/lib/postgresql/16/bin (falls back to the binaries on PATH)
#   PG_SOCKET_DIR=/tmp unix-socket directory of clusters started by this script
#   PG_USE_DOCKER=1    set to 0 to skip the Docker path
#
# Example (second, isolated cluster for experiments):
#   PGPORT=5433 PGDATA_DIR=/var/lib/postgresql/claude-test-5433 .claude/scripts/local-postgres.sh
#   PGPORT=5433 PGDATA_DIR=/var/lib/postgresql/claude-test-5433 .claude/scripts/local-postgres.sh stop
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FSH_DIR="$REPO_ROOT/FullStackHub"

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PG_SOCKET_DIR="${PG_SOCKET_DIR:-/tmp}"
PG_USE_DOCKER="${PG_USE_DOCKER:-1}"

APP_USER="shipping"
APP_PASSWORD="shipping"
DATABASES=(shipping_hub shipping_hub_test)

if [[ "$(id -u)" -eq 0 ]]; then
  RUN_AS_POSTGRES=1
  PGDATA_DIR="${PGDATA_DIR:-/var/lib/postgresql/claude-local}"
else
  RUN_AS_POSTGRES=0
  PGDATA_DIR="${PGDATA_DIR:-$HOME/.cache/shipping-hub/pgdata}"
fi

# Prefer the pinned PostgreSQL 16 binaries; fall back to whatever is on PATH.
if [[ ! -x "$PG_BIN/pg_ctl" ]]; then
  if command -v pg_ctl >/dev/null 2>&1; then
    PG_BIN="$(dirname "$(command -v pg_ctl)")"
  else
    PG_BIN=""
  fi
fi
bin() { # bin <tool> → absolute path when PG_BIN is known, else the PATH lookup
  if [[ -n "$PG_BIN" && -x "$PG_BIN/$1" ]]; then printf '%s/%s' "$PG_BIN" "$1"; else printf '%s' "$1"; fi
}
PSQL="$(bin psql)"
PG_ISREADY="$(bin pg_isready)"

log() { printf '[local-postgres] %s\n' "$*"; }
die() { printf '[local-postgres] ERROR: %s\n' "$*" >&2; exit 1; }

# Run a server-side command as the `postgres` OS user when we are root.
as_pg() {
  if [[ "$RUN_AS_POSTGRES" -eq 1 ]]; then
    local quoted
    quoted="$(printf '%q ' "$@")"
    su -s /bin/bash postgres -c "$quoted"
  else
    "$@"
  fi
}

listening() { "$PG_ISREADY" -h "$PGHOST" -p "$PGPORT" -q >/dev/null 2>&1; }

wait_ready() { # wait up to 60 s for the server to accept connections
  local i
  for i in $(seq 1 60); do
    if listening; then return 0; fi
    sleep 1
  done
  return 1
}

# psql as the application role over TCP (what the apps do).
app_psql() { PGPASSWORD="$APP_PASSWORD" "$PSQL" -h "$PGHOST" -p "$PGPORT" -U "$APP_USER" -d postgres -v ON_ERROR_STOP=1 -Atq "$@"; }
app_can_connect() { app_psql -c 'select 1' >/dev/null 2>&1; }

# Find a superuser connection for administrative statements (creating the role / databases).
ADMIN_KIND=""
ADMIN_SOCKET=""
find_admin() {
  local dir
  if [[ -n "$ADMIN_KIND" ]]; then return 0; fi
  for dir in "$PG_SOCKET_DIR" /var/run/postgresql /tmp; do
    if as_pg "$PSQL" -h "$dir" -p "$PGPORT" -U postgres -d postgres -Atqc 'select 1' >/dev/null 2>&1; then
      ADMIN_KIND="socket"; ADMIN_SOCKET="$dir"; return 0
    fi
  done
  if "$PSQL" -h "$PGHOST" -p "$PGPORT" -U postgres -d postgres -Atqc 'select 1' >/dev/null 2>&1; then
    ADMIN_KIND="tcp"; return 0
  fi
  return 1
}
admin_psql() {
  case "$ADMIN_KIND" in
    socket) as_pg "$PSQL" -h "$ADMIN_SOCKET" -p "$PGPORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq "$@" ;;
    tcp)    "$PSQL" -h "$PGHOST" -p "$PGPORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq "$@" ;;
    *)      return 1 ;;
  esac
}

ensure_role_and_databases() {
  local db exists
  if ! app_can_connect; then
    log "role '$APP_USER' cannot log in yet — creating it with a superuser connection"
    find_admin || die "a PostgreSQL answers on $PGHOST:$PGPORT but neither '$APP_USER' nor a superuser can connect. Use another port (PGPORT=5433) or fix that server."
    admin_psql -c "DO \$\$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_USER') THEN
        CREATE ROLE $APP_USER LOGIN CREATEDB PASSWORD '$APP_PASSWORD';
      ELSE
        ALTER ROLE $APP_USER WITH LOGIN CREATEDB PASSWORD '$APP_PASSWORD';
      END IF;
    END \$\$;"
    app_can_connect || die "created role '$APP_USER' but a password login over TCP still fails (check pg_hba.conf of that server)"
    log "role '$APP_USER' ready (password '$APP_PASSWORD')"
  fi
  for db in "${DATABASES[@]}"; do
    exists="$(app_psql -c "select 1 from pg_database where datname = '$db'" 2>/dev/null || true)"
    if [[ "$exists" == "1" ]]; then
      log "database '$db' exists"
      continue
    fi
    if app_psql -c "CREATE DATABASE $db OWNER $APP_USER" >/dev/null 2>&1; then
      log "database '$db' created"
    else
      find_admin || die "cannot create database '$db' as '$APP_USER' and no superuser connection is available"
      admin_psql -c "CREATE DATABASE $db OWNER $APP_USER" >/dev/null
      log "database '$db' created (as superuser)"
    fi
  done
}

docker_works() {
  [[ "$PG_USE_DOCKER" == "1" ]] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

start_docker() {
  log "starting the project's PostgreSQL container (docker compose up -d postgres)"
  (cd "$FSH_DIR" && docker compose up -d postgres)
  wait_ready || die "the postgres container did not become ready within 60 s"
}

start_local_cluster() {
  [[ -n "$PG_BIN" ]] || die "no PostgreSQL binaries found (expected $PG_BIN or pg_ctl on PATH). Install postgresql-16 or set PG_BIN."
  local initlog="$PGDATA_DIR.initdb.log"
  if [[ ! -s "$PGDATA_DIR/PG_VERSION" ]]; then
    log "initialising a new cluster in $PGDATA_DIR (PostgreSQL $("$PG_BIN/pg_ctl" --version | awk '{print $3}'))"
    if [[ "$RUN_AS_POSTGRES" -eq 1 ]]; then
      install -d -m 700 -o postgres -g postgres "$PGDATA_DIR"
    else
      mkdir -p "$PGDATA_DIR" && chmod 700 "$PGDATA_DIR"
    fi
    # Superuser `postgres`, trust on the unix socket (admin), passwords over TCP (apps).
    if ! as_pg "$PG_BIN/initdb" -D "$PGDATA_DIR" -U postgres -E UTF8 --locale=C \
        --auth-local=trust --auth-host=scram-sha-256 >"$initlog" 2>&1; then
      cat "$initlog" >&2
      die "initdb failed (log: $initlog)"
    fi
  fi
  if as_pg "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1; then
    log "a server is already running from $PGDATA_DIR"
  else
    log "starting PostgreSQL from $PGDATA_DIR on $PGHOST:$PGPORT (socket dir $PG_SOCKET_DIR)"
    as_pg "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" -l "$PGDATA_DIR/server.log" -w -t 60 \
      -o "-p $PGPORT -c listen_addresses=$PGHOST -c unix_socket_directories=$PG_SOCKET_DIR" start
  fi
  wait_ready || die "the server did not accept connections within 60 s (see $PGDATA_DIR/server.log)"
}

stop_local_cluster() {
  if [[ -s "$PGDATA_DIR/postmaster.pid" ]] && as_pg "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1; then
    log "stopping the cluster in $PGDATA_DIR"
    as_pg "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" -m fast -w stop
    log "stopped. Data kept in $PGDATA_DIR (delete the directory to discard it)."
  else
    log "no cluster started by this script is running from $PGDATA_DIR"
    if listening; then
      log "note: something else still answers on $PGHOST:$PGPORT (Docker or a system service) — not touched"
    fi
  fi
}

describe() {
  local version datadir
  version="$(app_psql -c 'select version()' 2>/dev/null | awk '{print $1, $2}' || true)"
  datadir="$(app_psql -c 'show data_directory' 2>/dev/null || echo 'n/a (needs superuser)')"
  log "ready: ${version:-PostgreSQL} on $PGHOST:$PGPORT · data directory: $datadir"
  log "DATABASE_URL=postgresql://$APP_USER:$APP_PASSWORD@$PGHOST:$PGPORT/shipping_hub?schema=public"
  log "test DB: postgresql://$APP_USER:$APP_PASSWORD@$PGHOST:$PGPORT/shipping_hub_test?schema=public (apps/api/.env.test)"
}

status() {
  if ! listening; then
    log "nothing accepts connections on $PGHOST:$PGPORT"
    return 1
  fi
  if ! app_can_connect; then
    log "a server answers on $PGHOST:$PGPORT but role '$APP_USER' cannot log in"
    return 1
  fi
  local db missing=0
  for db in "${DATABASES[@]}"; do
    if [[ "$(app_psql -c "select 1 from pg_database where datname = '$db'")" != "1" ]]; then
      log "database '$db' is missing"; missing=1
    fi
  done
  describe
  return "$missing"
}

usage() { sed -n '2,/^# ====*$/p' "${BASH_SOURCE[0]}" | sed -n '2,$p' | sed 's/^# \{0,1\}//'; }

case "${1:-start}" in
  start|up) ;;
  status) status; exit $? ;;
  stop) stop_local_cluster; exit 0 ;;
  -h|--help|help) usage; exit 0 ;;
  *) die "unknown argument '$1' (use: start | status | stop)" ;;
esac

if listening; then
  log "reusing the PostgreSQL that already listens on $PGHOST:$PGPORT"
elif docker_works; then
  start_docker
else
  if command -v docker >/dev/null 2>&1 && [[ "$PG_USE_DOCKER" == "1" ]]; then
    log "Docker is installed but its daemon is not available — using the local PostgreSQL binaries"
  fi
  start_local_cluster
fi

ensure_role_and_databases
describe
