#!/usr/bin/env bash
# Smoke test of a deployed app (docs/operations.md "After a deploy"): the Worker answers, it
# reaches its database (/api/ready), the app's page and its script load, and an API call without a
# session gets a clean 401 in JSON. Read-only: it signs in to nothing and changes nothing. Retries
# for up to SMOKE_WAIT seconds (default 120) while a new version spreads.
#
# With an expected commit (second argument, or EXPECTED_SHA), /api/ready must also name that
# commit, so the check is of the version just deployed and not the one before it. Without one,
# the commit is not compared.
#
# Usage: scripts/smoke.sh https://staging.mezonas.com [expected-commit]

set -euo pipefail

base=${1:?usage: scripts/smoke.sh <origin>}
base=${base%/}
expected=${2:-${EXPECTED_SHA:-}}
expected=$(tr '[:upper:]' '[:lower:]' <<<"$expected")
wait=${SMOKE_WAIT:-120}
deadline=$((SECONDS + wait))

check() {
  local problems=()

  local health
  health=$(curl -fsS --max-time 10 "$base/api/health" 2>&1) || problems+=("/api/health: $health")
  [[ $health == *'"ok":true'* ]] || problems+=("/api/health did not say ok: ${health:0:200}")

  # Readiness: 200 with "db":"ok" only when the Worker's own database connection answers.
  local ready ready_code ready_body
  ready=$(curl -sS --max-time 10 -w '\n%{http_code}' "$base/api/ready" 2>&1) || true
  ready_code=${ready##*$'\n'}
  ready_body=${ready%$'\n'*}
  [ "$ready_code" = 200 ] || problems+=("/api/ready answered $ready_code: ${ready_body:0:200}")
  [[ $ready_body == *'"db":"ok"'* ]] || problems+=("/api/ready did not say the database is ok")
  if [ -n "$expected" ]; then
    local sha
    sha=$(grep -oE '"sha":"[0-9a-f]+"' <<<"$ready_body" | cut -d'"' -f4 || true)
    # A short expected id matches the start of the full one.
    [[ -n $sha && $sha == "$expected"* ]] ||
      problems+=("/api/ready names commit '${sha:-none}', not the expected $expected")
  fi

  local page
  page=$(curl -fsS --max-time 10 "$base/" 2>&1) || problems+=("/: ${page:0:200}")
  [[ $page == *'id="root"'* ]] || problems+=("/ is not the app (no #root)")
  local script
  script=$(grep -oE 'src="/assets/[^"]+\.js"' <<<"$page" | head -1 | cut -d'"' -f2 || true)
  if [ -z "$script" ]; then
    problems+=("/ names no /assets script")
  else
    local code
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$base$script")
    [ "$code" = 200 ] || problems+=("$script answered $code")
  fi

  local session code body
  session=$(curl -sS --max-time 10 -w '\n%{http_code}' "$base/api/session")
  code=${session##*$'\n'}
  body=${session%$'\n'*}
  [ "$code" = 401 ] || problems+=("/api/session without a session answered $code, not 401")
  [[ $body == *'"error"'* ]] || problems+=("/api/session's 401 is not the API's JSON error: ${body:0:200}")

  if [ ${#problems[@]} -eq 0 ]; then return 0; fi
  printf '%s\n' "${problems[@]}" > "${TMPDIR:-/tmp}/smoke-problems"
  return 1
}

while true; do
  if check; then
    echo "Smoke test passed: $base answers, reaches its database${expected:+ at $expected}, the app loads, the API refuses without a session."
    exit 0
  fi
  if [ $SECONDS -ge $deadline ]; then
    echo "::error::Smoke test failed for $base after ${wait}s:"
    sed 's/^/  /' "${TMPDIR:-/tmp}/smoke-problems"
    exit 1
  fi
  sleep 10
done
