#!/usr/bin/env bash
# Create .env from .env.example with fresh random secrets (Linux/macOS/WSL).
# Refuses to overwrite an existing .env.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -e .env ] && { echo ".env already exists, not touching it"; exit 1; }
hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
cp .env.example .env
set_var() { sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak; }
for v in POSTGRES_PASSWORD N8N_DB_PASSWORD N8N_WORKER_DB_PASSWORD API_USER_DB_PASSWORD \
         N8N_RUNNERS_AUTH_TOKEN GARAGE_ADMIN_TOKEN GARAGE_METRICS_TOKEN REDIS_PASSWORD; do
  set_var "$v" "$(hex 24)"
done
set_var N8N_ENCRYPTION_KEY "$(hex 32)"
set_var GARAGE_RPC_SECRET "$(hex 32)"
set_var S3_ACCESS_KEY_ID "GK$(hex 12)"
set_var S3_SECRET_ACCESS_KEY "$(hex 32)"
chmod 600 .env
echo "wrote .env"
