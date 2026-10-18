#!/usr/bin/env bash
# Restore the databases written by scripts/db-backup.sh (platform P12, D-111) and check each one against the
# fingerprint taken with the dump: the row count of every table, and the owners, grants, row-level rules,
# functions, policies, triggers and extensions (scripts/db-fingerprint.sql). Same environment as the backup.
#   bash scripts/db-restore.sh <backup_dir>       # every <db>.dump in the folder, or only RESTORE_DBS="flatshare"
# Each database is dropped (connections are closed) and created again from its dump, with its owner and grants.
# Stop the services that write first (scripts/windows/restore.ps1 stops n8n and the website). The roles must exist:
# on a fresh machine run db-bootstrap once before restoring (it creates them with the passwords from .env).
#
# RESTORE_CHECK=1 restores each dump into a new database <db>_restorecheck instead, checks it and drops it: the live
# databases are not touched (scripts/windows/p12.ps1 -Step backup-check). In that mode the restored copy of
# RESTORE_PGTAP_DB (default flatshare_test, the database scripts/db-test.sh builds from the migrations) also runs
# the database tests, db/tests/*.sql (backend spec 15.1). The suite expects a database holding only what the
# migrations put there, so it is not run on a copy of the live database, where its fixtures collide with real rows.
set -euo pipefail
dir="${1:?usage: db-restore.sh <backup_dir>}"
here="$(cd "$(dirname "$0")" && pwd)"
export PGUSER="${PGUSER:-postgres}"

# roles the dump needs that this server does not have yet (no passwords; existing roles are left as they are)
for r in $(grep -oP '^CREATE ROLE \K[^;]+' "$dir/roles.sql" 2>/dev/null || true); do
  r="${r//\"/}"
  if [[ -z "$(psql -X -At -d postgres -c "select 1 from pg_roles where rolname = '$r'")" ]]; then
    psql -X -q -d postgres -c "create role \"$r\"" && echo "created role $r (no login, no password: run db-bootstrap to set it)"
  fi
done

dbs="${RESTORE_DBS:-$(cd "$dir" && ls *.dump | sed 's/\.dump$//')}"
bad=0
for db in $dbs; do
  if [[ -n "${RESTORE_CHECK:-}" ]]; then
    target="${db}_restorecheck"
    owner=$(psql -X -At -d postgres -c "select pg_get_userbyid(datdba) from pg_database where datname = '$db'")
    dropdb --if-exists --force "$target" 2>/dev/null
    createdb -O "${owner:-postgres}" "$target"
    pg_restore --exit-on-error -d "$target" "$dir/$db.dump"
  else
    target="$db"
    dropdb --if-exists --force "$db"
    pg_restore --create --exit-on-error -d postgres "$dir/$db.dump"
  fi
  psql -X -q -At -v ON_ERROR_STOP=1 -d "$target" -f "$here/db-fingerprint.sql" > "$dir/$db.restored.fingerprint"
  if diff -u "$dir/$db.fingerprint" "$dir/$db.restored.fingerprint" > "$dir/$db.diff"; then
    echo "$db: restored, $(grep -c '^rows ' "$dir/$db.fingerprint") tables; row counts, owners, grants, row-level rules and functions match the backup"
    rm -f "$dir/$db.diff"
  else
    echo "$db: restored but it differs from the backup, see $dir/$db.diff" >&2; bad=1
  fi
  if [[ -n "${RESTORE_CHECK:-}" && "$db" == "${RESTORE_PGTAP_DB:-flatshare_test}" ]]; then
    psql -X -q -d "$target" -c "set client_min_messages = warning; create extension if not exists pgtap"
    if (cd "$here/.." && pg_prove -d "$target" db/tests/[0-9]*.sql) > "$dir/$db.pgtap.txt" 2>&1; then
      echo "$db: database tests PASS on the restored copy ($(grep -o 'Tests=[0-9]*' "$dir/$db.pgtap.txt"))"
    else
      echo "$db: database tests FAIL on the restored copy, see $dir/$db.pgtap.txt" >&2; bad=1
    fi
  fi
  if [[ -n "${RESTORE_CHECK:-}" ]]; then dropdb --force "$target"; fi
done
exit $bad
