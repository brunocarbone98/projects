#!/usr/bin/env bash
# =============================================================================
# .github/scripts/uptime-probe.sh — probe the live Shipping Hub and report it the way a
# GitHub Actions step does (step summary + step outputs).
#
# Called by .github/workflows/uptime-patrol.yml (every 30 minutes + manual). The logic lives
# here, not in the workflow, so it can be run and tested locally:
#
#   BASE_URL=https://shipping-hub.up.railway.app .github/scripts/uptime-probe.sh
#   BASE_URL=http://localhost:3000 .github/scripts/uptime-probe.sh        # a local stack
#
# Probes (every one must answer HTTP 200 with the app's own page):
#   /en                               landing page
#   /en/tracking/PTY-2026-001001-0    SSR tracking page — the body must also contain the
#                                     tracking code, which proves web + API + a real database
#                                     read of the seeded demo shipment
#   /es/quote                         Spanish quote page
#   /sitemap.xml                      generated sitemap
#
# Each probe is one curl with two retries, identified as this monitor (a well-behaved-bot
# User-Agent plus a browser-like Accept header, so edge/bot filters can tell it apart from
# anonymous scripted traffic):
#   curl -sS -o <tmp> -D <headers> -w '%{http_code} %{time_total}' --retry 2 --retry-delay 5 \
#        --retry-all-errors -m 30 -A "$USER_AGENT" -H "Accept: ..." <url>
# When a probe fails, the step log also prints the diagnostic response headers (server,
# retry-after, content-type, cf-ray, x-railway-*) and the first 200 characters of the body,
# so a 429/5xx can be attributed to the edge or to the app. The Markdown report stays as is.
#
# Environment:
#   BASE_URL             required — origin to probe, without a trailing slash
#   TRACKING_CODE        optional — tracking code to probe (default: PTY-2026-001001-0)
#   USER_AGENT           optional — User-Agent header (default: the monitor's own identity)
#   GITHUB_STEP_SUMMARY  when set, the Markdown report is appended to it (the run summary)
#   GITHUB_OUTPUT        when set, two step outputs are appended to it:
#                          healthy=true|false|unknown
#                          report=<the Markdown report, multi-line, heredoc delimiter>
#
# Railway's edge (server "railway-hikari") can answer automated clients with its bot
# protection instead of the app: HTTP 429, or an HTTP 200 "Checking your browser…" page. A
# probe that gets that page is reported as "challenged" — it is neither a pass nor a product
# failure, because the app was not observed. When every probe is challenged the overall state
# is `unknown` (the workflow then ends green with a warning annotation and opens no incident).
#
# The report is always printed to stdout too. Exit code: 0 whenever the probes could run,
# whatever the state — the workflow's last step fails the job only when healthy is 'false'. Non-zero
# only when the script cannot run at all (BASE_URL missing, curl missing).
# =============================================================================
set -euo pipefail
export LC_ALL=C

if [[ -z "${BASE_URL:-}" ]]; then
  echo "uptime-probe: BASE_URL is required, e.g. BASE_URL=https://shipping-hub.up.railway.app" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "uptime-probe: curl is required" >&2
  exit 2
fi

BASE_URL="${BASE_URL%/}"
TRACKING_CODE="${TRACKING_CODE:-PTY-2026-001001-0}"
USER_AGENT="${USER_AGENT:-Mozilla/5.0 (compatible; ShippingHub-UptimePatrol/1.0; +https://github.com/brunocarbone98/projects)}"
ACCEPT_HEADER="text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"

# "<path>|<extra expectation>" — the expectation is empty (HTTP 200 is enough) or
# "body:<text>" (HTTP 200 and the response body must contain <text>).
PROBES=(
  "/en|"
  "/en/tracking/${TRACKING_CODE}|body:${TRACKING_CODE}"
  "/es/quote|"
  "/sitemap.xml|"
)

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

checked_at="$(date -u +'%Y-%m-%d %H:%M:%S UTC')"
rows=()
failed=0
challenged=0

for probe in "${PROBES[@]}"; do
  path="${probe%%|*}"
  expect="${probe#*|}"
  url="${BASE_URL}${path}"
  body="${WORK_DIR}/body"
  headers="${WORK_DIR}/headers"
  errors="${WORK_DIR}/errors"
  : >"$body"
  : >"$headers"
  : >"$errors"

  # curl writes "<http_code> <time_total>" even when the transfer fails (http_code is then 000).
  curl_rc=0
  stats="$(curl -sS -o "$body" -D "$headers" -w '%{http_code} %{time_total}' \
    --retry 2 --retry-delay 5 --retry-all-errors -m 30 \
    -A "$USER_AGENT" -H "Accept: ${ACCEPT_HEADER}" \
    "$url" 2>"$errors")" || curl_rc=$?

  status="${stats%% *}"
  seconds="${stats##* }"
  [[ "$status" =~ ^[0-9]{3}$ ]] || status="000"
  if [[ "$seconds" =~ ^[0-9]*\.?[0-9]+$ ]]; then
    time_cell="$(printf '%.2f s' "$seconds")"
  else
    time_cell="-"
  fi

  verdict="✅ pass"
  if grep -qi "Checking your browser" "$body" 2>/dev/null; then
    # Railway's bot protection answered instead of the app (HTTP 200, "Checking your browser…").
    challenged=$((challenged + 1))
    verdict="🛡️ challenged — the edge answered with its browser check; the app was not observed"
  elif [[ "$status" != "200" ]]; then
    failed=$((failed + 1))
    if [[ "$status" == "000" ]]; then
      reason="no response (curl exit ${curl_rc})"
      last_error="$(tr -d '\r' <"$errors" | grep -v '^Warning:' | tail -n 1 || true)"
      [[ -n "$last_error" ]] && reason="${reason}: ${last_error#curl: }"
    else
      reason="expected HTTP 200"
    fi
    verdict="❌ fail — ${reason//|//}"
  elif [[ "$expect" == body:* ]] && ! grep -qF -- "${expect#body:}" "$body"; then
    failed=$((failed + 1))
    verdict="❌ fail — HTTP 200 but the body does not contain ${expect#body:}"
  fi

  echo "[uptime-probe] ${path}: HTTP ${status} in ${time_cell} — ${verdict}"
  if [[ "$verdict" != "✅ pass" ]]; then
    # Diagnostics for the step log only: which layer answered (edge vs app) and what it said.
    diag_headers="$(tr -d '\r' <"$headers" | grep -iE '^(HTTP/|server:|retry-after:|content-type:|cf-ray:|x-railway)' | tail -n 8 || true)"
    [[ -n "$diag_headers" ]] && printf '[uptime-probe]   response headers:\n%s\n' "$(sed 's/^/[uptime-probe]     /' <<<"$diag_headers")"
    diag_body="$(tr -d '\r\n' <"$body" | head -c 200 || true)"
    [[ -n "$diag_body" ]] && echo "[uptime-probe]   body (first 200 chars): ${diag_body}"
  fi
  rows+=("| [\`${path}\`](${url}) | ${status} | ${time_cell} | ${verdict} |")
done

total=${#PROBES[@]}
if ((failed == 0 && challenged == 0)); then
  healthy=true
  overall="**Healthy** — ${total}/${total} probes passed."
elif ((failed > 0)); then
  healthy=false
  overall="**Unhealthy** — ${failed} of ${total} probes failed."
  ((challenged > 0)) && overall="${overall} ${challenged} more answered by the edge's browser check."
else
  healthy=unknown
  overall="**Unobserved** — ${challenged} of ${total} probes were answered by Railway's edge browser check (bot protection) instead of the app, so the app could not be observed from this runner. No incident is opened or closed on this state."
fi

report="$(
  cat <<EOF
### Uptime patrol — ${checked_at}

Target: ${BASE_URL}

| Endpoint | Status | Time | Result |
| --- | --- | --- | --- |
$(printf '%s\n' "${rows[@]}")

${overall}
EOF
)"

echo
printf '%s\n' "$report"
echo
echo "uptime-probe: healthy=${healthy}"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '%s\n\n' "$report" >>"$GITHUB_STEP_SUMMARY"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  # Multi-line output: the delimiter is random so it can never appear in the report itself.
  delimiter="UPTIME_REPORT_$$_${RANDOM}${RANDOM}"
  {
    echo "healthy=${healthy}"
    echo "report<<${delimiter}"
    printf '%s\n' "$report"
    echo "${delimiter}"
  } >>"$GITHUB_OUTPUT"
fi

exit 0
