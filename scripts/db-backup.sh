#!/usr/bin/env bash
# Back up the databases (platform P12, D-111). Runs where the PostgreSQL client tools are, with PGHOST, PGUSER and
# PGPASSWORD set; on the PC scripts/windows/backup.ps1 runs it in the db-bootstrap container.
#   bash scripts/db-backup.sh <out_dir>           # databases from BACKUP_DBS, default "flatshare n8n auth"
# For each database it writes <db>.dump (pg_dump custom format) and <db>.fingerprint (rows per table, and owners,
# grants, row-level rules, functions, policies: scripts/db-fingerprint.sql). Both come from the same snapshot, so the
# fingerprint is exactly what the dump holds even while n8n keeps writing; the restore is checked against it.
# roles.sql lists the roles without passwords (the passwords are in .env; db-bootstrap sets them).
set -euo pipefail
out="${1:?usage: db-backup.sh <out_dir>}"
mkdir -p "$out"
dbs="${BACKUP_DBS:-flatshare n8n auth}"
fp="$(cd "$(dirname "$0")" && pwd)/db-fingerprint.sql"
export PGUSER="${PGUSER:-postgres}"

pg_dumpall --globals-only --no-role-passwords > "$out/roles.sql"
for db in $dbs; do
  if [[ -z "$(psql -X -At -d postgres -c "select 1 from pg_database where datname = '$db'")" ]]; then
    echo "skip $db (no such database)"; continue
  fi
  # one transaction holds the snapshot open while pg_dump uses it, then reads the fingerprint in it
  coproc PSQL { psql -X -q -At -v ON_ERROR_STOP=1 -d "$db"; }
  echo "begin isolation level repeatable read; select pg_export_snapshot();" >&"${PSQL[1]}"
  read -r snap <&"${PSQL[0]}"
  pg_dump -Fc --snapshot="$snap" -d "$db" -f "$out/$db.dump"
  printf '%s\n' "\\o $out/$db.fingerprint" "\\i $fp" "\\o" "select 'done';" >&"${PSQL[1]}"
  read -r done <&"${PSQL[0]}"
  echo "commit;" >&"${PSQL[1]}"
  exec {PSQL[1]}>&-
  wait "$PSQL_PID" || true
  [[ "$done" == "done" ]] || { echo "reading the fingerprint of $db failed" >&2; exit 1; }
  echo "$db: $(stat -c %s "$out/$db.dump") bytes, $(grep -c '^rows ' "$out/$db.fingerprint") tables," \
       "$(awk '/^rows /{s+=$3} END {print s+0}' "$out/$db.fingerprint") rows"
done
date -u +%Y-%m-%dT%H:%M:%SZ > "$out/taken_at.txt"
echo "backup written to $out"
