# Create .env from .env.example with fresh random secrets (Windows).
# Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
# Refuses to overwrite an existing .env. Writes UTF-8 without BOM and LF line
# endings, because docker compose would read a BOM or CR as part of the values.
# With -AddMissing on an existing .env: appends only the settings it lacks (new secrets
# get fresh random values, other new settings their .env.example value); existing
# lines are never changed.
param([switch]$AddMissing)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envPath = Join-Path $root ".env"
if ((Test-Path $envPath) -and -not $AddMissing) { Write-Host ".env already exists, not touching it"; exit 1 }

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
  INTERNAL_SERVICE_TOKEN = Hex 32
}

if (Test-Path $envPath) {
  $have = @{}
  Get-Content $envPath | ForEach-Object { if ($_ -match '^([A-Z0-9_]+)=(.+)$') { $have[$Matches[1]] = $true } }
  $add = @()
  Get-Content (Join-Path $root ".env.example") | ForEach-Object {
    $line = $_ -replace "`r", ""
    if ($line -match '^([A-Z0-9_]+)=(.*)$' -and -not $have.ContainsKey($Matches[1])) {
      $k = $Matches[1]
      if ($values.ContainsKey($k)) { $add += "$k=$($values[$k])" } elseif ($Matches[2] -ne "") { $add += $line }
    }
  }
  if ($add.Count -gt 0) {
    $text = "`n# added by setup.ps1 -AddMissing on " + (Get-Date -Format "yyyy-MM-dd") + "`n" + ($add -join "`n") + "`n"
    [System.IO.File]::AppendAllText($envPath, $text, (New-Object System.Text.UTF8Encoding $false))
  }
  if ($add.Count -gt 0) { Write-Host ("added to .env: " + (($add | ForEach-Object { ($_ -split "=")[0] }) -join ", ")) }
  else { Write-Host "added to .env: nothing" }
  exit 0
}

$lines = Get-Content (Join-Path $root ".env.example") | ForEach-Object {
  $line = $_ -replace "`r", ""
  if ($line -match '^([A-Z0-9_]+)=(.*)$' -and $values.ContainsKey($Matches[1])) { "$($Matches[1])=$($values[$Matches[1]])" }
  else { $line }
}
$text = ($lines -join "`n") + "`n"
[System.IO.File]::WriteAllText($envPath, $text, (New-Object System.Text.UTF8Encoding $false))
Write-Host "wrote $envPath"
