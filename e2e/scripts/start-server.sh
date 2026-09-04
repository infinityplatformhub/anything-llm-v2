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
model_cache="$ROOT/e2e/.cache/models"
tmp_schema="$state/schema.prisma"
log="$ROOT/e2e/logs/server-$server_id.log"
mkdir -p "$state" "$ROOT/e2e/logs"

rm -rf "$storage" "$state/migrations"
mkdir -p "$storage" "$model_cache"
for static_dir in plugins assets comkey; do
  if [[ -d "$ROOT/server/storage/$static_dir" ]]; then
    cp -R "$ROOT/server/storage/$static_dir" "$storage/$static_dir"
  else
    mkdir -p "$storage/$static_dir"
  fi
done
ln -s "$model_cache" "$storage/models"
mkdir -p \
  "$storage/lancedb" \
  "$storage/vector-cache" \
  "$storage/documents" \
  "$storage/generated-files" \
  "$storage/anythingllm-fs"

sed 's#url *= *"file:[^"]*"#url = "file:'"$storage"'/anythingllm.db"#' \
  "$ROOT/server/prisma/schema.prisma" > "$tmp_schema"
cp -R "$ROOT/server/prisma/migrations" "$state/migrations"
(
  cd "$ROOT/server"
  npx prisma migrate deploy --schema "$tmp_schema"
)

tables="$(sqlite3 "$storage/anythingllm.db" '.tables')"
for required_table in workspace_agent_settings system_settings; do
  if [[ " $tables " != *" $required_table "* ]]; then
    echo "fresh E2E database missing table: $required_table" >&2
    exit 1
  fi
done
if [[ "$(sqlite3 "$storage/anythingllm.db" 'select count(*) from system_settings')" -ne 0 ]]; then
  echo "fresh E2E database unexpectedly contains system settings" >&2
  exit 1
fi

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
export ANYTHINGLLM_DATABASE_URL="file:$storage/anythingllm.db"
export AGENT_AUTO_APPROVED_SKILLS="filesystem-write-text-file,filesystem-read-text-file,create-text-file,create-scheduled-job"
export NODE_ENV="development"

(
  cd "$ROOT/server"
  exec node index.js
) >"$log" 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$state/pid"
