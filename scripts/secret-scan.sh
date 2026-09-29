#!/usr/bin/env bash
# Secret scan for the repository and for workflows exported from a running n8n.
#  1. detect-secrets against the audited baseline (.secrets.baseline): fails on
#     any new finding. Known entries are the published test vectors only.
#  2. exact-match scan: every secret value from the given env files (the real
#     passwords, keys, tokens and API secrets of this deployment) must appear
#     nowhere in tracked files or in the export directory. A variable is a
#     secret when its name matches SECRET_NAME_RE; configuration values such as
#     S3_BUCKET or OLLAMA_BASE_URL are defaults that legitimately appear in the
#     repository and are not scanned (FAILURES F-019).
# usage: scripts/secret-scan.sh [export_dir] [env_file ...]
# FS_SCAN_EXACT_ONLY=1 skips step 1 (used by tests/unit/test_secret_scan.py).
set -euo pipefail
cd "$(dirname "$0")/.."
EXPORT_DIR="${1:-}"; shift || true

# Files to scan: tracked files, or (without .git) every file except local secrets and outputs.
list_files() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files
  else find . -type f -not -path './.git/*' -not -path './secrets/*' -not -path './reports/*' \
         -not -path '*/node_modules/*' -not -path '*/__pycache__/*' -not -name '.env' | sed 's|^\./||'
  fi
}

SECRET_NAME_RE='^[A-Z0-9_]*(PASSWORD|SECRET|SECRET_KEY|SECRET_ACCESS_KEY|TOKEN|API_KEY|ENCRYPTION_KEY)$'

echo "== detect-secrets (baseline: .secrets.baseline)"
if [ "${FS_SCAN_EXACT_ONLY:-0}" = "1" ]; then
  echo "SKIPPED: FS_SCAN_EXACT_ONLY=1"
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git ls-files -z | xargs -0 detect-secrets-hook --baseline .secrets.baseline
  echo "no new findings"
else
  echo "SKIPPED: not a git checkout (detect-secrets-hook needs git); the exact-match scan still runs"
fi

echo "== exact-match scan of deployment secrets"
patterns="$(mktemp)"; trap 'rm -f "$patterns"' EXIT
names=""
for f in "$@"; do
  [ -f "$f" ] || continue
  while IFS= read -r line; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^([A-Z0-9_]+)=(.*)$ ]] || continue
    name="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ "$name" =~ $SECRET_NAME_RE ]] || continue
    [ "${#value}" -ge 12 ] || continue     # shorter values are placeholders or unset
    printf '%s\n' "$value" >> "$patterns"
    names="$names $name"
  done < <(cat "$f"; echo)
done
count=$(wc -l < "$patterns")
if [ "$count" -eq 0 ]; then echo "no secret values found in the env files given: skipped"; exit 0; fi
echo "secret variables checked:$names"
targets=$(list_files)
[ -n "$EXPORT_DIR" ] && targets="$targets $(find "$EXPORT_DIR" -type f)"
if echo "$targets" | xargs grep -l -F -f "$patterns" 2>/dev/null; then
  echo "FAIL: a deployment secret appears in the files above"; exit 1
fi
echo "checked $count secret values against $(echo "$targets" | wc -w) files: none found"
