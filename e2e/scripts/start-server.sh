#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
server_id="${1:-}"
case "$server_id" in
  A) port=3011 ;;
  B) port=3012 ;;
  *) echo "usage: start-server.sh <A|B>" >&2; exit 2 ;;
esac
: "${AIG_API_KEY:?AIG_API_KEY required}"

state="$ROOT/e2e/.state/$server_id"
storage="$state/storage"
log="$ROOT/e2e/logs/server-$server_id.log"
mkdir -p "$state" "$ROOT/e2e/logs"

# Prisma hardcodes file:../storage/anythingllm.db, so migrate source before copying.
(
  cd "$ROOT/server"
  env -u DATABASE_URL npx prisma migrate deploy
)
rm -rf "$storage"
cp -R "$ROOT/server/storage" "$storage"

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  case "$line" in
    LLM_PROVIDER=*|GENERIC_OPEN_AI_*=*|EMBEDDING_ENGINE=*|VECTOR_DB=*|SERVER_PORT=*|STORAGE_DIR=*) continue ;;
  esac
  [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
  key="${BASH_REMATCH[1]}"
  value="${BASH_REMATCH[2]}"
  if [[ ${#value} -ge 2 && ( ( "$value" == \"*\" ) || ( "$value" == \'*\' ) ) ]]; then
    value="${value:1:${#value}-2}"
  fi
  export "$key=$value"
done < "$ROOT/server/.env.development"

export LLM_PROVIDER="generic-openai"
export GENERIC_OPEN_AI_BASE_PATH="https://aig.infinityplatform.tech/v1"
export GENERIC_OPEN_AI_MODEL_PREF="aix-qwen3.8-flash-next"
export GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT="16000"
export GENERIC_OPEN_AI_API_KEY="$AIG_API_KEY"
export EMBEDDING_ENGINE="native"
export VECTOR_DB="lancedb"
export SERVER_PORT="$port"
export STORAGE_DIR="$storage"
export NODE_ENV="development"

(
  cd "$ROOT/server"
  exec node index.js
) >"$log" 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$state/pid"
