#!/usr/bin/env bash
# The names of a Worker's secrets, one per line, read with `wrangler secret list` from the Worker's
# directory (docs/operations.md, "Secrets"). The deploy generates ENCRYPTION_KEY, MFA_ENCRYPTION_KEY
# and the other once-only secrets only when this list lacks them, so a wrong list replaces keys that
# can never be recovered. It fails unless the list can be trusted: it must be a JSON array, and it
# must name every secret given as an argument (the ones the step has just put, which the Worker
# certainly has). Retries a few times while a just-put secret spreads.
#
# Staging, 2026-11-21 (Sentry MEZONAS-API-C): one deploy's list came back without ENCRYPTION_KEY,
# WORKOS_COOKIE_PASSWORD and OAUTH_STATE_SECRET though wrangler exited 0, and the step generated new
# ones over the old: every client key on staging became unreadable.
#
# Usage: scripts/worker-secrets.sh <env> [name the list must contain ...]

set -euo pipefail

env_name=${1:?usage: scripts/worker-secrets.sh <env> [expected-name ...]}
shift
attempts=${SECRET_LIST_ATTEMPTS:-4}

for attempt in $(seq 1 "$attempts"); do
  names=""
  if json=$(pnpm exec wrangler secret list --env "$env_name" --format json) &&
    names=$(jq -r 'if type == "array" then .[].name else error("not a list of secrets") end' <<<"$json"); then
    missing=()
    for name in "$@"; do
      grep -qx -- "$name" <<<"$names" || missing+=("$name")
    done
    if [ ${#missing[@]} -eq 0 ]; then
      printf '%s\n' "$names"
      exit 0
    fi
    echo "secret list (attempt $attempt) lacks secrets just set: ${missing[*]}" >&2
  else
    echo "secret list (attempt $attempt) could not be read" >&2
  fi
  [ "$attempt" -lt "$attempts" ] && sleep 5
done
echo "the Worker's secrets could not be read reliably; generating nothing" >&2
exit 1
