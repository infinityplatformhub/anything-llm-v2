#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -n "$ROOT" && -f "$ROOT/e2e/scripts/mcp-ui.cjs" ]] || exit 1
exec node "$ROOT/e2e/scripts/mcp-ui.cjs" "$@"
