#!/usr/bin/env bash
# =============================================================================
# .claude/hooks/format-on-save.sh — PostToolUse hook (matcher: Edit|Write)
#
# Formats a FullStackHub file with the project's own Prettier right after Claude
# edits it, so `pnpm format:check` (CI) stays green. The hook JSON arrives on
# stdin; `tool_input.file_path` (absolute) is the edited file.
#
# It only acts when the file is under a FullStackHub/ directory that has a
# package.json, exists, has a type Prettier owns in this repo, and is not one
# of the prettier-ignored files (ROADMAP.md, apps/web/src/lib/world-coastlines.ts,
# pnpm-lock.yaml) nor a secret (.env*). Everything else is left alone.
#
# It prints nothing on success and ALWAYS exits 0: a formatter must never block
# Claude — not even right after a fresh clone when Prettier is not installed yet.
# =============================================================================

main() {
  local input file fsh base
  input="$(cat 2>/dev/null || true)"
  [[ -n "$input" ]] || return 0
  command -v node >/dev/null 2>&1 || return 0

  file="$(printf '%s' "$input" | node -e '
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try {
        const json = JSON.parse(data);
        const path = json && json.tool_input && json.tool_input.file_path;
        if (typeof path === "string") process.stdout.write(path);
      } catch (_) {}
    });' 2>/dev/null || true)"
  [[ -n "$file" ]] || return 0

  # The FullStackHub workspace that contains the file (works from any launch directory).
  case "$file" in
    */FullStackHub/*) fsh="${file%%/FullStackHub/*}/FullStackHub" ;;
    *) return 0 ;;
  esac
  [[ -f "$fsh/package.json" && -f "$file" ]] || return 0

  case "$file" in
    */node_modules/*|*/.next/*|*/dist/*|*/.turbo/*|*/.venv/*|*/coverage/*) return 0 ;;
  esac
  base="$(basename "$file")"
  case "$base" in
    ROADMAP.md|world-coastlines.ts|pnpm-lock.yaml|next-env.d.ts|.env|.env.*) return 0 ;;
  esac
  case "$base" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.md|*.yml|*.yaml|*.css) ;;
    *) return 0 ;;
  esac

  [[ -x "$fsh/node_modules/.bin/prettier" ]] || return 0
  command -v pnpm >/dev/null 2>&1 || return 0
  if command -v timeout >/dev/null 2>&1; then
    timeout 25 pnpm --dir "$fsh" exec prettier --log-level silent --write "$file" >/dev/null 2>&1 || true
  else
    pnpm --dir "$fsh" exec prettier --log-level silent --write "$file" >/dev/null 2>&1 || true
  fi
  return 0
}

main "$@" || true
exit 0
