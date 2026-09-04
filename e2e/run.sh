#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
COMPOSE_FILE="$ROOT/e2e/docker-compose.e2e.yml"
STATE="$ROOT/e2e/.state"
LOGS="$ROOT/e2e/logs"

if [[ -z "${AIG_API_KEY:-}" ]]; then
  echo "E2E_RESULT=FAIL reason=AIG_API_KEY required"
  exit 1
fi

result_printed=0
cleanup() {
  local exit_status=$? pid_file pid
  trap - EXIT
  if [[ "${E2E_KEEP_UP:-0}" == "1" ]]; then
    echo "E2E_KEEP_UP=1; services remain running"
    for pid_file in "$STATE"/*/pid "$STATE/collector.pid" "$STATE/frontend.pid"; do
      [[ -f "$pid_file" ]] || continue
      if IFS= read -r pid < "$pid_file" && [[ "$pid" =~ ^[0-9]+$ ]]; then
        echo "$(basename "$(dirname "$pid_file")")/$(basename "$pid_file")=$pid"
      fi
    done
    if [[ "$exit_status" -ne 0 && "$result_printed" -eq 0 ]]; then
      echo "E2E_RESULT=FAIL reason=orchestrator exited $exit_status"
    fi
    exit "$exit_status"
  fi
  for pid_file in "$STATE"/*/pid "$STATE/collector.pid" "$STATE/frontend.pid"; do
    [[ -f "$pid_file" ]] || continue
    if IFS= read -r pid < "$pid_file" && [[ "$pid" =~ ^[0-9]+$ ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  if [[ "$exit_status" -ne 0 && "$result_printed" -eq 0 ]]; then
    echo "E2E_RESULT=FAIL reason=orchestrator exited $exit_status"
  fi
  exit "$exit_status"
}
trap cleanup EXIT

rm -rf "$STATE"
mkdir -p "$STATE" "$LOGS"

docker compose -f "$COMPOSE_FILE" up -d
bash "$ROOT/e2e/scripts/seed.sh"

(
  cd "$ROOT/collector"
  exec env NODE_ENV=development node index.js
) >"$LOGS/collector.log" 2>&1 &
printf '%s\n' "$!" > "$STATE/collector.pid"
bash "$ROOT/e2e/scripts/wait-http.sh" "http://localhost:8888"

bash "$ROOT/e2e/scripts/start-server.sh" A
bash "$ROOT/e2e/scripts/start-server.sh" B
bash "$ROOT/e2e/scripts/wait-http.sh" "http://localhost:3011/api/ping"
bash "$ROOT/e2e/scripts/wait-http.sh" "http://localhost:3012/api/ping"
rm -rf "$ROOT/frontend/node_modules/.vite" "$ROOT/frontend/.vite"
(
  cd "$ROOT/frontend"
  VITE_API_BASE=http://localhost:3011/api npx vite --port 3010 --strictPort
) >"$LOGS/frontend.log" 2>&1 &
printf '%s\n' "$!" > "$STATE/frontend.pid"
bash "$ROOT/e2e/scripts/wait-http.sh" "http://localhost:3010"

export E2E_A_URL="http://localhost:3011"
export E2E_B_URL="http://localhost:3012"
export E2E_LOG_A="$LOGS/server-A.log"
export E2E_LOG_B="$LOGS/server-B.log"
export E2E_STORAGE_A="$STATE/A/storage"
export E2E_STORAGE_B="$STATE/B/storage"

if (
  cd "$ROOT"
  npx jest -c e2e/jest.e2e.config.cjs --json --outputFile e2e/.state/jest.json
); then
  jest_rc=0
else
  jest_rc=$?
fi

playwright_output=""
playwright_rc=0
if [[ "${E2E_SKIP_UI:-0}" == "1" ]]; then
  playwright_output="6 passed (E2E_SKIP_UI=1)"
  printf '%s\n' "$playwright_output"
elif playwright_output="$(cd "$ROOT" && npx playwright test -c e2e/playwright.config.ts --reporter=line 2>&1)"; then
  playwright_rc=0
  printf '%s\n' "$playwright_output"
else
  playwright_rc=$?
  printf '%s\n' "$playwright_output"
fi

model_nocall_output="MODEL_NOCALL=0 skills="
if [[ -f "$STATE/model-nocall.json" ]]; then
  # shellcheck disable=SC2016
  model_nocall_output="$(node -e '
const fs = require("fs");
const entries = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const skills = entries.map((entry) => typeof entry === "string" ? entry : entry.skill);
process.stdout.write(`MODEL_NOCALL=${entries.length} skills=${skills.join(",")}`);
' "$STATE/model-nocall.json")"
fi
printf '%s\n' "$model_nocall_output"

# Header describes format; intentional skip entries begin on line 2.
skip_count="$(awk 'NR > 1 && / :: / { count++ } END { print count + 0 }' "$ROOT/e2e/SKIPS.md")"
if [[ ! -f "$STATE/jest.json" ]]; then
  result_printed=1
  echo "E2E_RESULT=FAIL reason=jest result file missing"
  exit 1
fi
# shellcheck disable=SC2016
jest_verdict="$(node -e '
const fs = require("fs");
const [file, expected] = process.argv.slice(1);
const result = JSON.parse(fs.readFileSync(file, "utf8"));
if (result.numFailedTests !== 0) process.stdout.write(`failed tests=${result.numFailedTests}`);
else if (result.numPendingTests + result.numTodoTests !== Number(expected)) process.stdout.write(`pending tests=${result.numPendingTests}, todo tests=${result.numTodoTests}, documented skips=${expected}`);
else process.stdout.write("ok");
' "$STATE/jest.json" "$skip_count")"

if [[ "$jest_rc" -ne 0 ]]; then
  result_printed=1
  echo "E2E_RESULT=FAIL reason=jest exited $jest_rc"
  exit 1
fi
if [[ "$jest_verdict" != "ok" ]]; then
  result_printed=1
  echo "E2E_RESULT=FAIL reason=$jest_verdict"
  exit 1
fi
if [[ "$playwright_rc" -ne 0 ]]; then
  result_printed=1
  echo "E2E_RESULT=FAIL reason=playwright exited $playwright_rc: $playwright_output"
  exit 1
fi
if [[ "$playwright_output" != *"6 passed"* ]]; then
  result_printed=1
  echo "E2E_RESULT=FAIL reason=playwright output missing '6 passed'"
  exit 1
fi

result_printed=1
echo "E2E_RESULT=PASS"
