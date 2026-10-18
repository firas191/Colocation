# Back up the platform on Windows (platform P12, D-111). The stack must be running. Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\backup.ps1               # databases and photos/documents
#   powershell -ExecutionPolicy Bypass -File scripts\windows\backup.ps1 -NoMedia      # databases only (garage keeps running)
# Writes backups\<timestamp>\: flatshare.dump, n8n.dump, auth.dump with their .fingerprint (rows per table, owners,
# grants, row-level rules; same snapshot as the dump), roles.sql (no passwords) and garage.tgz (the object store,
# taken with garage stopped for about a minute).
# Not in the backup: .env and secrets\ (passwords, signing keys, the n8n encryption key). Keep a copy of those apart;
# n8n credentials in n8n.dump cannot be read without the same N8N_ENCRYPTION_KEY.
param([switch]$NoMedia)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dir = Join-Path $root "backups\$stamp"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host "== databases"
docker compose run --rm --no-deps -v "${dir}:/backup" --entrypoint bash db-bootstrap /flatshare/scripts/db-backup.sh /backup
if ($LASTEXITCODE -ne 0) { Write-Host "database backup FAILED"; exit 1 }

if (-not $NoMedia) {
  Write-Host "== photos and documents (garage stopped while copying)"
  docker compose stop garage
  docker run --rm --volumes-from fs-garage -v "${dir}:/backup" --entrypoint tar caddy:2.11.4-alpine czf /backup/garage.tgz -C /var/lib/garage meta data
  $code = $LASTEXITCODE
  docker compose start garage
  if ($code -ne 0) { Write-Host "media backup FAILED"; exit 1 }
}
Get-ChildItem $dir | Format-Table Name, Length -AutoSize
Write-Host "backup in $dir"
