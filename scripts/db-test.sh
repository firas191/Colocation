#!/usr/bin/env bash
# Build a throw-away database from the migrations and run the pgTAP suite.
# Runs inside the postgres container (compose) or on any host with psql,
# dbmate and pg_prove. Connection defaults to the local socket as postgres.
#   scripts/db-test.sh            # uses database flatshare_test
set -euo pipefail
cd "$(dirname "$0")/.."

TEST_DB="${TEST_DB:-flatshare_test}"
PGHOST="${PGHOST:-/var/run/postgresql}"
PGUSER="${PGUSER:-postgres}"
export PGHOST PGUSER
DBMATE="${DBMATE:-dbmate}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-db/migrations}"

if [[ "$PGHOST" == /* ]]; then
  URL="postgres://${PGUSER}@/${TEST_DB}?socket=${PGHOST}&sslmode=disable"
else
  URL="postgres://${PGUSER}:${PGPASSWORD:-}@${PGHOST}:${PGPORT:-5432}/${TEST_DB}?sslmode=disable"
fi

echo "== recreate ${TEST_DB}"
psql -d postgres -qc "drop database if exists ${TEST_DB} with (force)"
psql -d postgres -qc "create database ${TEST_DB}"

echo "== migrate"
"$DBMATE" --url "$URL" --migrations-dir "$MIGRATIONS_DIR" --no-dump-schema up

echo "== extension versions"
psql -d "$TEST_DB" -Atc "select extname || ' ' || extversion from pg_extension order by 1"
psql -d "$TEST_DB" -Atc "select version()"

echo "== pgTAP"
psql -d "$TEST_DB" -qc "create extension if not exists pgtap"
pg_prove -d "$TEST_DB" --verbose db/tests/[0-9]*.sql
