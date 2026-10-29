#!/usr/bin/env bash
# =============================================================================
# .claude/scripts/run-checks.sh — run every project check, print one summary table
#
# Checks, in order (names usable as arguments to run a subset):
#   lint            FullStackHub  pnpm lint
#   format          FullStackHub  pnpm format:check
#   typecheck       FullStackHub  pnpm typecheck
#   test            FullStackHub  pnpm test  (Vitest: packages/shared + apps/api; the API
#                   suite needs PostgreSQL on localhost:5432 with apps/api/.env.test's
#                   credentials → local-postgres.sh is run when nothing listens there)
#   pytest-pricing  FullStackHub/services/pricing  .venv/bin/python -m pytest
#   pytest-labels   FullStackHub/services/labels   .venv/bin/python -m pytest
#   (a service .venv is created and its requirements installed when missing)
#
# Output: a Markdown table (check · result · duration · summary · log) ready to paste
# into a PR body, then the last 40 lines of every failing log. Exit code 1 when any
# check failed. Full outputs are kept in $RUN_DIR/<check>.log.
#
# Usage:
#   .claude/scripts/run-checks.sh                   # everything
#   .claude/scripts/run-checks.sh lint typecheck    # a subset
#
# Environment (optional):
#   RUN_DIR=/tmp/shipping-hub-checks    SKIP_INSTALL=1 (never run pnpm install)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FSH_DIR="$REPO_ROOT/FullStackHub"
RUN_DIR="${RUN_DIR:-/tmp/shipping-hub-checks}"
ALL_CHECKS=(lint format typecheck test pytest-pricing pytest-labels)

log() { printf '[run-checks] %s\n' "$*"; }
die() { printf '[run-checks] ERROR: %s\n' "$*" >&2; exit 1; }

# Table rows.
NAMES=(); LABELS=(); RESULTS=(); DURATIONS=(); SUMMARIES=(); LOGS=()
FAILED=0

# run_check <name> <label> <dir> <summary-fn> <command...>
run_check() {
  local name="$1" label="$2" dir="$3" summarize="$4"; shift 4
  local logf="$RUN_DIR/$name.log" start end rc=0 summary
  printf '[run-checks] %-34s ' "$label"
  start=$(date +%s)
  if (cd "$dir" && "$@") >"$logf" 2>&1; then rc=0; else rc=$?; fi
  end=$(date +%s)
  summary="$("$summarize" "$logf" "$rc" 2>/dev/null || true)"
  NAMES+=("$name"); LABELS+=("$label"); DURATIONS+=("$((end - start))s"); LOGS+=("$logf")
  SUMMARIES+=("${summary:-see log}")
  if [[ $rc -eq 0 ]]; then
    RESULTS+=("PASS"); printf 'PASS  (%ss)\n' "$((end - start))"
  else
    RESULTS+=("FAIL"); FAILED=1; printf 'FAIL  (%ss, exit %s)\n' "$((end - start))" "$rc"
  fi
}

# Summaries: one short phrase extracted from each log.
sum_lint() {
  local hits; hits="$(grep -oE '[0-9]+ problems?' "$1" | tail -1 || true)"
  if [[ "$2" -eq 0 ]]; then echo "no ESLint problems"; else echo "${hits:-ESLint failed}"; fi
}
sum_format() {
  if grep -q 'All matched files use Prettier code style' "$1"; then echo "all files formatted"
  else echo "$(grep -cE '^\[warn\] [^ ]' "$1" || true) file(s) need formatting"; fi
}
sum_typecheck() {
  local tasks; tasks="$(grep -oE 'Tasks: +[0-9]+ successful, +[0-9]+ total' "$1" | tail -1 | sed 's/ \{2,\}/ /g' || true)"
  local errs; errs="$(grep -cE 'error TS[0-9]+' "$1" || true)"
  if [[ "$2" -eq 0 ]]; then echo "${tasks:-tsc clean}"; else echo "${errs:-?} TypeScript error(s)"; fi
}
sum_vitest() {
  # Turbo prefixes every line with the workspace name, e.g. "@shipping-hub/api:test:  Tests  27 passed (27)".
  grep -oE '@shipping-hub/[a-z]+:test: +Tests +[0-9]+ [a-z]+( \| [0-9]+ [a-z]+)*' "$1" \
    | sed -E 's/@shipping-hub\/([a-z]+):test: +Tests +/\1: /; s/ +/ /g' | paste -sd ';' - | sed 's/;/; /g'
}
sum_pytest() {
  # pytest -q ends with e.g. "41 passed, 1 warning in 1.14s" (decorated with ==== without -q).
  grep -E '^(=+ )?[0-9]+ (passed|failed|error|errors|skipped|xfailed|deselected).* in [0-9.]+s' "$1" \
    | tail -1 | sed -E 's/^=+ *//; s/ *=+$//'
}

ensure_node_modules() {
  if [[ -d "$FSH_DIR/node_modules" ]]; then return 0; fi
  [[ "${SKIP_INSTALL:-0}" == "1" ]] && die "FullStackHub/node_modules is missing and SKIP_INSTALL=1"
  log "FullStackHub/node_modules is missing — running pnpm install --frozen-lockfile"
  (cd "$FSH_DIR" && pnpm install --frozen-lockfile) >"$RUN_DIR/install.log" 2>&1 \
    || { tail -n 30 "$RUN_DIR/install.log" >&2; die "pnpm install failed (log: $RUN_DIR/install.log)"; }
}

ensure_postgres() {
  local pg_isready=/usr/lib/postgresql/16/bin/pg_isready
  [[ -x "$pg_isready" ]] || pg_isready="$(command -v pg_isready || true)"
  if [[ -n "$pg_isready" ]] && "$pg_isready" -h 127.0.0.1 -p 5432 -q >/dev/null 2>&1; then return 0; fi
  log "PostgreSQL is not answering on 127.0.0.1:5432 — running local-postgres.sh"
  "$SCRIPT_DIR/local-postgres.sh" >"$RUN_DIR/local-postgres.log" 2>&1 \
    || { tail -n 30 "$RUN_DIR/local-postgres.log" >&2; die "could not start PostgreSQL (log: $RUN_DIR/local-postgres.log)"; }
}

ensure_venv() { # <service dir>
  local dir="$1"
  if [[ -x "$dir/.venv/bin/python" ]] && "$dir/.venv/bin/python" -c 'import pytest' >/dev/null 2>&1; then return 0; fi
  log "creating $dir/.venv and installing requirements"
  python3 -m venv "$dir/.venv" && "$dir/.venv/bin/pip" install -q -r "$dir/requirements.txt" >"$RUN_DIR/venv-$(basename "$dir").log" 2>&1 \
    || die "could not prepare $dir/.venv (log: $RUN_DIR/venv-$(basename "$dir").log)"
}

# Which checks to run.
if [[ $# -gt 0 ]]; then
  CHECKS=("$@")
  for c in "${CHECKS[@]}"; do
    case " ${ALL_CHECKS[*]} " in *" $c "*) ;; *) die "unknown check '$c' (known: ${ALL_CHECKS[*]})" ;; esac
  done
else
  CHECKS=("${ALL_CHECKS[@]}")
fi

mkdir -p "$RUN_DIR"
STARTED_AT="$(date -u +'%Y-%m-%d %H:%M:%S UTC')"
log "repo: $REPO_ROOT · logs: $RUN_DIR · started $STARTED_AT"

for check in "${CHECKS[@]}"; do
  case "$check" in
    lint)      ensure_node_modules; run_check lint "FullStackHub pnpm lint" "$FSH_DIR" sum_lint pnpm lint ;;
    format)    ensure_node_modules; run_check format "FullStackHub pnpm format:check" "$FSH_DIR" sum_format pnpm format:check ;;
    typecheck) ensure_node_modules; run_check typecheck "FullStackHub pnpm typecheck" "$FSH_DIR" sum_typecheck pnpm typecheck ;;
    test)      ensure_node_modules; ensure_postgres; run_check test "FullStackHub pnpm test (Vitest)" "$FSH_DIR" sum_vitest pnpm test ;;
    pytest-pricing)
      ensure_venv "$FSH_DIR/services/pricing"
      run_check pytest-pricing "services/pricing pytest" "$FSH_DIR/services/pricing" sum_pytest .venv/bin/python -m pytest -q ;;
    pytest-labels)
      ensure_venv "$FSH_DIR/services/labels"
      run_check pytest-labels "services/labels pytest" "$FSH_DIR/services/labels" sum_pytest .venv/bin/python -m pytest -q ;;
  esac
done

echo
echo "| Check | Result | Duration | Summary | Log |"
echo "|---|---|---|---|---|"
for i in "${!NAMES[@]}"; do
  printf '| %s | %s | %s | %s | `%s` |\n' "${LABELS[$i]}" "${RESULTS[$i]}" "${DURATIONS[$i]}" "${SUMMARIES[$i]}" "${LOGS[$i]}"
done
echo

if [[ $FAILED -eq 1 ]]; then
  for i in "${!NAMES[@]}"; do
    if [[ "${RESULTS[$i]}" == "FAIL" ]]; then
      echo "----- ${LABELS[$i]} — last 40 lines of ${LOGS[$i]} -----"
      tail -n 40 "${LOGS[$i]}"
      echo
    fi
  done
  log "RESULT: FAIL (at least one check failed)"
  exit 1
fi
log "RESULT: PASS (${#NAMES[@]} checks)"
