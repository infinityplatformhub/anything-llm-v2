#!/bin/sh
# Creates/refreshes the two Secrets anythingllm.yaml needs. Values are read from
# files/env, never echoed. Run once per cluster; re-running keeps existing JWT/SIG
# values unless the files are replaced (changing SIG_KEY breaks encrypted DB rows).
#
#   KUBECONFIG=~/.kube/infi-jorhor-dev2.yaml \
#   JWT_FILE=/tmp/k.jwt SIG_FILE=/tmp/k.sig SALT_FILE=/tmp/k.salt \
#   AIG_KEY_FILE=/tmp/k.aig SERVER_URL=https://workspace.approof.studio \
#   PULL_FROM=tdc-staging/pp-4c2d16b0-tdc-revam-pull sh secrets.sh
set -eu
NS=anythingllm
: "${JWT_FILE:?}" "${SIG_FILE:?}" "${SALT_FILE:?}" "${AIG_KEY_FILE:?}" "${SERVER_URL:?}"

kubectl get ns "$NS" >/dev/null 2>&1 || kubectl create ns "$NS"

# Seed for storage/.env (applied only on first boot; UI edits persist afterwards).
SEED=$(cat <<EOF
LLM_PROVIDER='generic-openai'
GENERIC_OPEN_AI_BASE_PATH='https://aig.infinityplatform.tech/v1'
GENERIC_OPEN_AI_MODEL_PREF='aix-qwen3.8-flash-next'
GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT='128000'
GENERIC_OPEN_AI_API_KEY='$(cat "$AIG_KEY_FILE")'
GENERIC_OPEN_AI_MAX_TOKENS='4096'
EMBEDDING_ENGINE='native'
VECTOR_DB='lancedb'
DISABLE_TELEMETRY='true'
EOF
)

kubectl -n "$NS" create secret generic anythingllm-env \
  --from-file=JWT_SECRET="$JWT_FILE" \
  --from-file=SIG_KEY="$SIG_FILE" \
  --from-file=SIG_SALT="$SALT_FILE" \
  --from-literal=SERVER_URL="$SERVER_URL" \
  --from-literal=ENV_SEED="$SEED" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
echo "secret/anythingllm-env applied"

# Registry pull secret: copy an existing PodPilot-made one from another namespace.
if [ -n "${PULL_FROM:-}" ]; then
  SRC_NS=${PULL_FROM%%/*}; SRC_NAME=${PULL_FROM#*/}
  kubectl -n "$SRC_NS" get secret "$SRC_NAME" -o json \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(json.dumps({"apiVersion":"v1","kind":"Secret","type":d["type"],"metadata":{"name":"regcred","namespace":"'"$NS"'"},"data":d["data"]}))' \
    | kubectl apply -f - >/dev/null
  echo "secret/regcred applied (copied from $PULL_FROM)"
fi
