# Create .env from .env.example with fresh random secrets (Windows).
# Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
# Refuses to overwrite an existing .env. Writes UTF-8 without BOM and LF line
# endings, because docker compose would read a BOM or CR as part of the values.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envPath = Join-Path $root ".env"
if (Test-Path $envPath) { Write-Host ".env already exists, not touching it"; exit 1 }

$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
function Hex([int]$bytes) {
  $b = New-Object byte[] $bytes
  $rng.GetBytes($b)
  ($b | ForEach-Object { $_.ToString("x2") }) -join ""
}

$values = @{
  POSTGRES_PASSWORD      = Hex 24
  N8N_DB_PASSWORD        = Hex 24
  N8N_WORKER_DB_PASSWORD = Hex 24
  API_USER_DB_PASSWORD   = Hex 24
  N8N_RUNNERS_AUTH_TOKEN = Hex 24
  GARAGE_ADMIN_TOKEN     = Hex 24
  GARAGE_METRICS_TOKEN   = Hex 24
  REDIS_PASSWORD         = Hex 24
  N8N_ENCRYPTION_KEY     = Hex 32
  GARAGE_RPC_SECRET      = Hex 32
  S3_ACCESS_KEY_ID       = "GK" + (Hex 12)
  S3_SECRET_ACCESS_KEY   = Hex 32
}

$lines = Get-Content (Join-Path $root ".env.example") | ForEach-Object {
  $line = $_ -replace "`r", ""
  if ($line -match '^([A-Z0-9_]+)=(.*)$' -and $values.ContainsKey($Matches[1])) { "$($Matches[1])=$($values[$Matches[1]])" }
  else { $line }
}
$text = ($lines -join "`n") + "`n"
[System.IO.File]::WriteAllText($envPath, $text, (New-Object System.Text.UTF8Encoding $false))
Write-Host "wrote $envPath"
