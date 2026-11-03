#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/dast-wait-stable.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Wait until a deployed instance of the app is the NEW build and stays up, before (or between) DAST
# scans. Used by .github/workflows/security-dast.yml; shape from
# PlainConceptsPlatform/Atlas scripts/dast-wait-stable.sh.
#
#   dast-wait-stable.sh <host> <streak> [expected-sha]
#
# With an expected SHA, first poll /api/v1/health until it reports that commit (the deploy's own
# build-identity gate). After a deploy the old process can keep answering 200 for about a minute
# before the new one takes over, with 502s in between, and a streak of 200s from the OLD process
# would start the scan on platform pages.
#
# Then require <streak> consecutive 200s on /login (the SPA shell) 10 s apart, within 6 minutes.
# Not /: with Entra SSO on, an anonymous GET / is redirected to the sign-in (SignInRedirect).
# Exits 0 when stable, 1 otherwise.
set -uo pipefail

host="$1"
streak_needed="$2"
sha="${3:-}"

# wait_build <url> <sha> <attempts>: poll every 15 s until the body names the commit.
wait_build() {
  local url="$1" expected="$2" attempts="$3" body
  for _ in $(seq 1 "$attempts"); do
    body="$(curl -s --max-time 20 "$url" || true)"
    case "$body" in *"$expected"*) return 0 ;; esac
    sleep 15
  done
  return 1
}

if [ -n "$sha" ]; then
  if ! wait_build "https://${host}/api/v1/health" "$sha" 24; then
    echo "::error::${host} never reported build ${sha} on /api/v1/health in 6 minutes: the deploy did not land, or the old process is still serving"
    exit 1
  fi
  echo "Build ${sha:0:7} is serving /api/v1/health"
fi

streak=0
for attempt in $(seq 1 36); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${host}/login" || echo 000)
  if [ "$code" = "200" ]; then streak=$((streak + 1)); else streak=0; fi
  if [ "$streak" -ge "$streak_needed" ]; then
    echo "SPA shell stable (${streak_needed} consecutive 200s by attempt ${attempt})"
    exit 0
  fi
  sleep 10
done
echo "::error::${host}/login never answered 200 ${streak_needed} times in a row in 6 minutes: the scan would read platform errors, not the app"
exit 1
