#!/usr/bin/env bash
# Create .env from .env.example with fresh random secrets (Linux/macOS/WSL).
# Refuses to overwrite an existing .env.
# --add-missing: on an existing .env, append only the settings it lacks.
set -euo pipefail
cd "$(dirname "$0")/.."
hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
if [ "${1:-}" = "--add-missing" ] && [ -e .env ]; then
  added=""
  while IFS= read -r line; do
    case "$line" in [A-Z]*=*) ;; *) continue;; esac
    k="${line%%=*}"; v="${line#*=}"
    grep -q "^$k=." .env && continue
    case "$k" in
      INTERNAL_SERVICE_TOKEN) v="$(hex 32)";;
      *) [ -z "$v" ] && continue;;
    esac
    printf '%s=%s\n' "$k" "$v" >> .env; added="$added $k"
  done < .env.example
  echo "added to .env:${added:- nothing}"; exit 0
fi
[ -e .env ] && { echo ".env already exists, not touching it"; exit 1; }
cp .env.example .env
set_var() { sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak; }
for v in POSTGRES_PASSWORD N8N_DB_PASSWORD N8N_WORKER_DB_PASSWORD API_USER_DB_PASSWORD \
         N8N_RUNNERS_AUTH_TOKEN GARAGE_ADMIN_TOKEN GARAGE_METRICS_TOKEN REDIS_PASSWORD INTERNAL_SERVICE_TOKEN; do
  set_var "$v" "$(hex 24)"
done
set_var N8N_ENCRYPTION_KEY "$(hex 32)"
set_var GARAGE_RPC_SECRET "$(hex 32)"
set_var S3_ACCESS_KEY_ID "GK$(hex 12)"
set_var S3_SECRET_ACCESS_KEY "$(hex 32)"
chmod 600 .env
echo "wrote .env"
