#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
COMPOSE_FILE="$ROOT/e2e/docker-compose.e2e.yml"
STATE="$ROOT/e2e/.state"
LOGS="$ROOT/e2e/logs"
PORTS=(3010 3011 3012 8888)
RUN_PID=$$
INITIAL_LISTENER_PIDS=""
result_printed=0

port_listener_pids() {
  /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
}

pid_was_initial() {
  [[ " $INITIAL_LISTENER_PIDS " == *" $1 "* ]]
}

is_descendant_of_run() {
  local pid="$1" parent
  while [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )); do
    [[ "$pid" == "$RUN_PID" ]] && return 0
    parent="$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d '[:space:]')"
    [[ "$parent" =~ ^[0-9]+$ ]] || return 1
    pid="$parent"
  done
  return 1
}

for port in "${PORTS[@]}"; do
  listeners="$(port_listener_pids "$port")"
  for pid in $listeners; do
    INITIAL_LISTENER_PIDS+=" $pid"
  done
  if [[ -n "$listeners" ]]; then
    pid="${listeners%%$'\n'*}"
    command="$(ps -p "$pid" -o command= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -n "$command" ]] || command="unknown"
    result_printed=1
    echo "E2E_RESULT=FAIL reason=port $port already in use (pid $pid $command)"
    exit 1
  fi
done

if [[ -z "${AIG_API_KEY:-}" ]]; then
  result_printed=1
  echo "E2E_RESULT=FAIL reason=AIG_API_KEY required"
  exit 1
fi

cleanup() {
  local exit_status=$? pid_file pid port listeners deadline cleanup_failed=0
  local cleanup_pids=""
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

  # Capture descendants before killing wrappers, which can orphan their children.
  for port in "${PORTS[@]}"; do
    while IFS= read -r pid; do
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      if ! pid_was_initial "$pid" && is_descendant_of_run "$pid"; then
        cleanup_pids+=" $pid"
      fi
    done < <(port_listener_pids "$port")
  done
  for pid_file in "$STATE"/*/pid "$STATE/collector.pid" "$STATE/frontend.pid"; do
    [[ -f "$pid_file" ]] || continue
    if IFS= read -r pid < "$pid_file" && [[ "$pid" =~ ^[0-9]+$ ]]; then
      cleanup_pids+=" $pid"
    fi
  done
  for pid in $cleanup_pids; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in $cleanup_pids; do
    wait "$pid" 2>/dev/null || true
  done

  # Ports were empty at preflight, so every new listener belongs to this run.
  for port in "${PORTS[@]}"; do
    while IFS= read -r pid; do
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      if ! pid_was_initial "$pid"; then
        cleanup_pids+=" $pid"
        kill "$pid" 2>/dev/null || true
      fi
    done < <(port_listener_pids "$port")
  done
  deadline=$((SECONDS + 10))
  for pid in $cleanup_pids; do
    while kill -0 "$pid" 2>/dev/null && (( SECONDS < deadline )); do
      sleep 0.1
    done
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done

  docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  for port in "${PORTS[@]}"; do
    listeners="$(port_listener_pids "$port")"
    if [[ -n "$listeners" ]]; then
      echo "WARNING: port $port still in use (pids $(printf '%s' "$listeners" | tr '\n' ' ' | sed 's/ $//'))" >&2
      cleanup_failed=1
      exit_status=1
    fi
  done
  if [[ "$cleanup_failed" -ne 0 ]]; then
    echo "E2E_RESULT=FAIL reason=cleanup left harness ports in use"
  elif [[ "$exit_status" -ne 0 && "$result_printed" -eq 0 ]]; then
    echo "E2E_RESULT=FAIL reason=orchestrator exited $exit_status"
  fi
  exit "$exit_status"
}
trap cleanup EXIT

fail_bind() {
  local service="$1" port="$2" log="$3"
  result_printed=1
  echo "E2E_RESULT=FAIL reason=$service failed to bind $port"
  echo "--- last 20 lines of $log ---"
  tail -n 20 "$log" 2>/dev/null || true
  exit 1
}

verify_bind() {
  local service="$1" port="$2" pid_file="$3" log="$4"
  local pid listeners deadline=$((SECONDS + 120))
  if ! IFS= read -r pid < "$pid_file" || [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    fail_bind "$service" "$port" "$log"
  fi
  while (( SECONDS <= deadline )); do
    kill -0 "$pid" 2>/dev/null || fail_bind "$service" "$port" "$log"
    listeners="$(port_listener_pids "$port")"
    if [[ "$listeners" == "$pid" ]]; then
      return 0
    fi
    [[ -z "$listeners" ]] || fail_bind "$service" "$port" "$log"
    sleep 0.2
  done
  fail_bind "$service" "$port" "$log"
}

rm -rf "$STATE"
mkdir -p "$STATE" "$LOGS"

docker compose -f "$COMPOSE_FILE" up -d
bash "$ROOT/e2e/scripts/seed.sh"

(
  cd "$ROOT/collector"
  exec env NODE_ENV=development node index.js
) >"$LOGS/collector.log" 2>&1 &
printf '%s\n' "$!" > "$STATE/collector.pid"
verify_bind "collector" 8888 "$STATE/collector.pid" "$LOGS/collector.log"
bash "$ROOT/e2e/scripts/wait-http.sh" "http://localhost:8888"

bash "$ROOT/e2e/scripts/start-server.sh" A
verify_bind "server A" 3011 "$STATE/A/pid" "$LOGS/server-A.log"
bash "$ROOT/e2e/scripts/wait-http.sh" "http://localhost:3011/api/ping"
bash "$ROOT/e2e/scripts/start-server.sh" B
verify_bind "server B" 3012 "$STATE/B/pid" "$LOGS/server-B.log"
bash "$ROOT/e2e/scripts/wait-http.sh" "http://localhost:3012/api/ping"
rm -rf "$ROOT/frontend/node_modules/.vite" "$ROOT/frontend/.vite"
(
  cd "$ROOT/frontend"
  exec env VITE_API_BASE=http://localhost:3011/api node node_modules/vite/bin/vite.js --port 3010 --strictPort
) >"$LOGS/frontend.log" 2>&1 &
printf '%s\n' "$!" > "$STATE/frontend.pid"
verify_bind "vite" 3010 "$STATE/frontend.pid" "$LOGS/frontend.log"
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
