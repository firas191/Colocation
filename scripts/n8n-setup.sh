#!/usr/bin/env sh
# Load credentials and workflows into n8n, then publish the workflows.
# Runs with n8n stopped (compose service "n8n-setup", same image as n8n) and
# with the same DB_* / N8N_ENCRYPTION_KEY environment as n8n. Idempotent:
# re-importing replaces workflows and credentials with the same ids.
# POSIX sh: the n8n image has no bash.
set -eu
N8N="${N8N_BIN:-n8n}"
WF_DIR="${WF_DIR:-/flatshare/n8n/workflows}"
WF_TEST_DIR="${WF_TEST_DIR:-/flatshare/n8n/workflows-test}"
: "${N8N_WORKER_DB_PASSWORD:?}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
umask 077

# Credential values come from the environment and exist only in this temp file
# until n8n encrypts them with N8N_ENCRYPTION_KEY. Nothing is written to the repo.
cat > "$TMP/credentials.json" <<EOF
[{
  "id": "fsCredPgWorker01",
  "name": "Flatshare DB (n8n_worker)",
  "type": "postgres",
  "data": {
    "host": "${APP_DB_HOST:-postgres}",
    "port": ${APP_DB_PORT:-5432},
    "database": "${FLATSHARE_DB:-flatshare}",
    "user": "n8n_worker",
    "password": "${N8N_WORKER_DB_PASSWORD}",
    "ssl": "disable",
    "maxConnections": 20,
    "allowUnauthorizedCerts": false
  }
}]
EOF

echo "== import credentials"
"$N8N" import:credentials --input="$TMP/credentials.json"

# One file at a time: importing several workflows that share a new tag in one
# call fails on n8n 2.41.3 (duplicate key on tag_entity.name, docs/FAILURES.md F-005).
echo "== import workflows"
for f in "$WF_DIR"/*.json; do "$N8N" import:workflow --input="$f"; done
if [ "${N8N_IMPORT_TEST_WORKFLOWS:-0}" = "1" ]; then
  echo "== import test workflows"
  for f in "$WF_TEST_DIR"/*.json; do "$N8N" import:workflow --input="$f"; done
fi

echo "== publish"
for f in "$WF_DIR"/*.json; do
  id=$(sed -n 's/^  "id": "\([A-Za-z0-9]*\)",$/\1/p' "$f" | head -n 1)
  "$N8N" publish:workflow --id="$id" 2>&1 | grep -v -i "restart n8n\|will not take effect" || true
done
if [ "${N8N_IMPORT_TEST_WORKFLOWS:-0}" = "1" ]; then
  for f in "$WF_TEST_DIR"/*.json; do
    id=$(sed -n 's/^  "id": "\([A-Za-z0-9]*\)",$/\1/p' "$f" | head -n 1)
    "$N8N" publish:workflow --id="$id" 2>&1 | grep -v -i "restart n8n\|will not take effect" || true
  done
fi
echo "== done"
