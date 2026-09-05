#!/usr/bin/env bash
set -euo pipefail

url="${1:?usage: wait-http.sh <url> [timeout-seconds]}"
timeout="${2:-120}"
[[ "$timeout" =~ ^[0-9]+$ ]] || { echo "wait-http: timeout must be a non-negative integer" >&2; exit 2; }

deadline=$((SECONDS + timeout))
while (( SECONDS <= deadline )); do
  if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done

echo "wait-http: timed out after ${timeout}s waiting for ${url}" >&2
exit 1
