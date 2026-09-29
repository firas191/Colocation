#!/usr/bin/env bash
# Secret scan for the repository and for workflows exported from a running n8n.
#  1. detect-secrets against the audited baseline (.secrets.baseline): fails on
#     any new finding. Known entries are the published test vectors only.
#  2. exact-match scan: every value from the given env files (the real
#     passwords, keys and API secrets of this deployment) must appear nowhere
#     in tracked files or in the export directory.
# usage: scripts/secret-scan.sh [export_dir] [env_file ...]
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

echo "== detect-secrets (baseline: .secrets.baseline)"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git ls-files -z | xargs -0 detect-secrets-hook --baseline .secrets.baseline
  echo "no new findings"
else
  echo "SKIPPED: not a git checkout (detect-secrets-hook needs git); the exact-match scan still runs"
fi

echo "== exact-match scan of deployment secrets"
patterns="$(mktemp)"; trap 'rm -f "$patterns"' EXIT
for f in "$@"; do
  [ -f "$f" ] || continue
  grep -E '^[A-Z0-9_]+=' "$f" | cut -d= -f2- | awk 'length($0) >= 12' >> "$patterns" || true
done
count=$(wc -l < "$patterns")
if [ "$count" -eq 0 ]; then echo "no env files given: skipped"; exit 0; fi
targets=$(list_files)
[ -n "$EXPORT_DIR" ] && targets="$targets $(find "$EXPORT_DIR" -type f)"
if echo "$targets" | xargs grep -l -F -f "$patterns" 2>/dev/null; then
  echo "FAIL: a deployment secret appears in the files above"; exit 1
fi
echo "checked $count secret values against $(echo "$targets" | wc -w) files: none found"
