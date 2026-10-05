#!/usr/bin/env bash
# Prepare PostgreSQL for the stack. Idempotent: safe to run on every start.
#  1. n8n's own database and role (n8n_app)
#  2. application database: migrations (dbmate), role passwords
#  3. settings that depend on the deployment (Ollama, TEI and storage health URLs)
#  4. API client keys for the website server and the test client (created once;
#     secrets written to $SECRETS_DIR/api-clients.env, never printed)
# Runs inside the postgres container (compose service "db-bootstrap") or any
# host with psql and dbmate. All inputs come from the environment.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${PGHOST:?}" "${PGPASSWORD:?}" "${N8N_DB_PASSWORD:?}" "${N8N_WORKER_DB_PASSWORD:?}" "${API_USER_DB_PASSWORD:?}"
export PGUSER="${PGUSER:-postgres}" PGPORT="${PGPORT:-5432}"
FLATSHARE_DB="${FLATSHARE_DB:-flatshare}"
N8N_DB="${N8N_DB:-n8n}"
N8N_DB_USER="${N8N_DB_USER:-n8n_app}"
SECRETS_DIR="${SECRETS_DIR:-./secrets}"
DBMATE="${DBMATE:-dbmate}"

psql_admin() { psql -v ON_ERROR_STOP=1 -X -q -d postgres "$@"; }

echo "== wait for postgres"
for i in $(seq 1 60); do pg_isready -q -d postgres && break; sleep 1; done
pg_isready -d postgres

echo "== n8n database and role"
psql_admin -v u="$N8N_DB_USER" -v pw="$N8N_DB_PASSWORD" <<'SQL'
select format('create role %I login', :'u') where not exists (select 1 from pg_roles where rolname = :'u') \gexec
alter role :"u" with login password :'pw';
SQL
psql_admin -v db="$N8N_DB" -v u="$N8N_DB_USER" <<'SQL'
select format('create database %I owner %I', :'db', :'u') where not exists (select 1 from pg_database where datname = :'db') \gexec
SQL

echo "== application database"
psql_admin -v db="$FLATSHARE_DB" <<'SQL'
select format('create database %I', :'db') where not exists (select 1 from pg_database where datname = :'db') \gexec
SQL
# The password is not put in the URL: dbmate's driver reads PGPASSWORD.
URL="postgres://${PGUSER}@${PGHOST}:${PGPORT}/${FLATSHARE_DB}?sslmode=disable"
if [[ "$PGHOST" == /* ]]; then URL="postgres://${PGUSER}@/${FLATSHARE_DB}?socket=${PGHOST}&sslmode=disable"; fi
"$DBMATE" --url "$URL" --migrations-dir db/migrations --no-dump-schema up

echo "== reference data"
psql -v ON_ERROR_STOP=1 -X -q -d "$FLATSHARE_DB" -f db/seed/jurisdictions.sql

echo "== role passwords"
psql -v ON_ERROR_STOP=1 -X -q -d "$FLATSHARE_DB" -v w="$N8N_WORKER_DB_PASSWORD" -v a="$API_USER_DB_PASSWORD" <<'SQL'
alter role n8n_worker with password :'w';
alter role api_user with password :'a';
SQL

echo "== deployment settings"
psql -v ON_ERROR_STOP=1 -X -q -d "$FLATSHARE_DB" \
  -v ollama="${OLLAMA_BASE_URL:-http://ollama:11434}" \
  -v model="${EMBED_MODEL:-bge-m3}" \
  -v s3h="${S3_HEALTH_URL:-http://garage:3903/health}" \
  -v tei="${TEI_BASE_URL:-http://tei:80}" \
  -v media="${MEDIA_URL:-http://media:8000}" \
  -v text="${TEXT_URL:-http://text:8000}" \
  -v asr="${ASR_URL:-http://asr:8000}" \
  -v api="${API_URL:-http://proxy:8080}" <<'SQL'
update app.settings set value = to_jsonb(:'api'::text)    where key = 'services.api_url';
update app.settings set value = to_jsonb(:'ollama'::text) where key = 'ollama.base_url';
update app.settings set value = to_jsonb(:'media'::text)  where key = 'services.media_url';
update app.settings set value = to_jsonb(:'text'::text)   where key = 'services.text_url';
update app.settings set value = to_jsonb(:'asr'::text)    where key = 'services.asr_url';
update app.settings set value = to_jsonb(:'tei'::text)    where key = 'kb.tei_base_url';
update app.settings set value = to_jsonb(:'model'::text)  where key = 'ollama.embed_model';
update app.settings set value = to_jsonb(:'s3h'::text)    where key = 's3.health_url';
SQL

echo "== API client keys"
mkdir -p "$SECRETS_DIR"
umask 077
OUT="$SECRETS_DIR/api-clients.env"
for client in website tests; do
  exists=$(psql -X -At -d "$FLATSHARE_DB" -c "select count(*) from sec.api_clients where key_id = '$client'")
  if [[ "$exists" == "0" ]]; then
    secret=$(psql -X -At -d "$FLATSHARE_DB" -c "select secret from sec.create_api_client('$client', '$client client')")
    upper=$(echo "$client" | tr '[:lower:]' '[:upper:]')
    { echo "FLATSHARE_${upper}_KEY_ID=$client"; echo "FLATSHARE_${upper}_SECRET=$secret"; } >> "$OUT"
    echo "created API client '$client' (secret written to $OUT)"
  else
    echo "API client '$client' already exists"
  fi
done
echo "== done"
