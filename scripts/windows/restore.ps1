# Restore a backup made by backup.ps1 (platform P12, D-111). This REPLACES the current databases and photos.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\restore.ps1 -From backups\20261017-150000
#   powershell -ExecutionPolicy Bypass -File scripts\windows\restore.ps1 -From backups\20261017-150000 -NoMedia
# On a fresh machine: same .env and secrets\ as when the backup was taken, then
#   docker compose up -d postgres garage ; docker compose run --rm db-bootstrap      (creates the roles and passwords)
# and run this script. It stops n8n, the website and the Telegram relay, restores, checks each database against the
# fingerprint taken with its dump (row counts, owners, grants, row-level rules), and starts them again. Exit code 1 if
# anything differs.
param([Parameter(Mandatory = $true)][string]$From, [switch]$NoMedia)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$dir = (Resolve-Path $From).Path
if (-not (Test-Path (Join-Path $dir "flatshare.dump"))) { Write-Host "no flatshare.dump in $dir"; exit 1 }

docker compose stop n8n n8n-runners web telegram
Write-Host "== databases"
docker compose run --rm --no-deps -v "${dir}:/backup" --entrypoint bash db-bootstrap /flatshare/scripts/db-restore.sh /backup
$code = $LASTEXITCODE

if (-not $NoMedia -and (Test-Path (Join-Path $dir "garage.tgz"))) {
  Write-Host "== photos and documents"
  docker compose stop garage
  docker run --rm --volumes-from fs-garage -v "${dir}:/backup" --entrypoint sh caddy:2.11.4-alpine -c "rm -rf /var/lib/garage/meta/* /var/lib/garage/data/* && tar xzf /backup/garage.tgz -C /var/lib/garage"
  if ($LASTEXITCODE -ne 0) { $code = 1 }
  docker compose start garage
}
docker compose up -d n8n n8n-runners web telegram
if ($code -ne 0) { Write-Host "restore finished WITH ERRORS (see the .diff files in $dir)"; exit 1 }
Write-Host "restore done; every database matches its backup"
