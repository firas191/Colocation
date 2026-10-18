# Platform P12 on Windows (D-111): load test of search and messages, and a backup that is restored to check it.
# Needs the stack running and up to date: run scripts\windows\verify.ps1 first. Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p12.ps1 -Step load           # 1, 5, 10, 20 workers, 30 s each, search then messages
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p12.ps1 -Step backup-check   # databases backed up, each restored into a scratch database and compared; database tests on the restored flatshare_test
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p12.ps1 -Step all
# Options: -Levels "1,5,10,20"  -Seconds 30
# Output: reports\p12-<timestamp>\p12.log and summary.txt; reports\load\load-*.json; backups\<timestamp>\.
param([ValidateSet("load", "backup-check", "all")][string]$Step = "all", [string]$Levels = "1,5,10,20", [int]$Seconds = 30)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dir = Join-Path $root "reports\p12-$stamp"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir "p12.log"
$summary = Join-Path $dir "summary.txt"
$utf8 = New-Object System.Text.UTF8Encoding $false

function Write-Log([string]$text) { [System.IO.File]::AppendAllText($log, $text + "`n", $utf8) }
function Step([string]$name, [scriptblock]$block) {
  Write-Host "== $name"
  Write-Log "`n===== $name ====="
  Write-Log ("command: " + $block.ToString().Trim())
  Write-Log ("started: " + (Get-Date -Format o))
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $global:LASTEXITCODE = 0
  & $block 2>&1 | ForEach-Object { $l = "$_"; Write-Log $l; Write-Host "   $l" }
  $code = $LASTEXITCODE
  $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  Write-Log "exit=$code seconds=$secs"
  $result = if ($code -eq 0) { "PASS" } else { "FAIL" }
  [System.IO.File]::AppendAllText($summary, "$result  $name  (exit $code, $secs s)`n", $utf8)
  Write-Host "   $result (exit $code, $secs s)"
  return $code
}

$files = @("-f", "docker-compose.yml")
New-Item -ItemType Directory -Force -Path (Join-Path $root "reports\load") | Out-Null
$rw = @("-v", "${root}\reports\load:/flatshare/reports/load", "-e", "COMPUTERNAME=$env:COMPUTERNAME")
$run = @("compose") + $files + @("--profile", "test", "run", "--rm", "--no-deps") + $rw + @("tests", "python")

if ($Step -in @("load", "all")) {
  Step "machine (for the report)" {
    Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores, NumberOfLogicalProcessors | Format-List | Out-String
    "RAM GB: " + [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
    docker stats --no-stream --format "{{.Name}} {{.CPUPerc}} {{.MemUsage}}"
  } | Out-Null
  Step "load: search and messages at $Levels workers, $Seconds s each" {
    docker @run scripts/load_bench.py --levels $Levels --seconds $Seconds
  } | Out-Null
  Step "containers after the load" { docker stats --no-stream --format "{{.Name}} {{.CPUPerc}} {{.MemUsage}}" } | Out-Null
}

if ($Step -in @("backup-check", "all")) {
  $bdir = Join-Path $root "backups\$stamp"
  New-Item -ItemType Directory -Force -Path $bdir | Out-Null
  # flatshare_test is the database verify.ps1 builds from the migrations (scripts/db-test.sh); the database tests
  # run on its restored copy (backend spec 15.1). The live databases are compared by fingerprint only.
  $c = Step "backup: flatshare, n8n, auth, flatshare_test into backups\$stamp" {
    docker compose run --rm --no-deps -e "BACKUP_DBS=flatshare n8n auth flatshare_test" -v "${bdir}:/backup" --entrypoint bash db-bootstrap /flatshare/scripts/db-backup.sh /backup
  }
  if ($c -eq 0) {
    Step "restore check: each dump into a scratch database, compared with its fingerprint, database tests on flatshare_test, scratch databases dropped" {
      docker compose run --rm --no-deps -e RESTORE_CHECK=1 -v "${bdir}:/backup" --entrypoint bash db-bootstrap /flatshare/scripts/db-restore.sh /backup
    } | Out-Null
  }
}

Write-Host ""; Write-Host "Summary:"; Get-Content $summary | ForEach-Object { Write-Host "  $_" }; Write-Host "Log: $log"
