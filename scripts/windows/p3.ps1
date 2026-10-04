# Phase 3 on Windows: models, gazetteer, synthetic listings, prompt evaluation, search latency.
# Needs the stack running and up to date: run scripts\windows\verify.ps1 first (it applies the
# migrations, imports the workflows and runs the tests). Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p3.ps1 -Step setup   # pull the 3 LLMs (about 8 GB), seed datasets and prompts, exchange rates
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p3.ps1 -Step geo     # gazetteer from OpenStreetMap (about 6 min), synthetic listings, embeddings
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p3.ps1 -Step eval    # P1 and P2, versions 1 and 2, on the 3 models (long: about 1 to 3 h, not measured)
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p3.ps1 -Step bench   # 200 searches, latency percentiles
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p3.ps1 -Step all     # all of the above, in this order
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p3.ps1 -Step report  # apply the active prompt versions, then docs\PROMPT_EVAL.md from the stored runs
# Options: -Models "qwen3.5:4b,granite4.2:3b,phi4-mini:3.8b"  -Versions "1,2"  -Prompts "P1_router,P2_profile_extractor"
# Example, version 3 on the default model only (about 1.5 h, estimated from the v2 runs):
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p3.ps1 -Step eval -Models "qwen3.5:4b" -Versions "3"
# Output: reports\p3-<timestamp>\p3.log and summary.txt; geo\places_osm.csv; reports\eval\*.json; docs\PROMPT_EVAL.md.
param([ValidateSet("setup", "geo", "eval", "bench", "all", "report")][string]$Step = "all",
      [string]$Models = "qwen3.5:4b,granite4.2:3b,phi4-mini:3.8b", [string]$Versions = "1,2",
      [string]$Prompts = "P1_router,P2_profile_extractor", [int]$BenchN = 200)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dir = Join-Path $root "reports\p3-$stamp"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir "p3.log"
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
if (Test-Path "docker-compose.gpu.yml") {
  docker run --rm --gpus all ubuntu:24.04 nvidia-smi -L *> $null
  if ($LASTEXITCODE -eq 0) { $files += @("-f", "docker-compose.gpu.yml") }
}
# The repository is mounted read-only in the tests container; these folders are written.
foreach ($d in @("reports\eval", "geo", "docs")) { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }
$rw = @("-v", "${root}\geo:/flatshare/geo", "-v", "${root}\docs:/flatshare/docs", "-v", "${root}\reports\eval:/flatshare/reports/eval")
$p3 = @("compose") + $files + @("--profile", "test", "run", "--rm", "--no-deps") + $rw + @("tests", "python", "scripts/p3.py")
$reg = @("compose") + $files + @("--profile", "test", "run", "--rm", "--no-deps") + @("tests", "python", "scripts/prompts.py")
$modelList = $Models.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }

$c = Step "stack is up (n8n healthy, migration 0008 applied)" {
  docker inspect -f "{{.State.Health.Status}}" fs-n8n
  docker exec -u postgres fs-postgres psql -d flatshare -tAc "select max(version) from public.schema_migrations"
  $v = docker exec -u postgres fs-postgres psql -d flatshare -tAc "select count(*) from public.schema_migrations where version like '0008%'"
  if ("$v".Trim() -ne "1") { "migration 0008 is not applied: run scripts\windows\verify.ps1 first"; $global:LASTEXITCODE = 1 }
}
if ($c -ne 0) { Write-Host "Stopped: run scripts\windows\verify.ps1 first. Log: $log"; exit 1 }

if ($Step -in @("setup", "all")) {
  foreach ($m in $modelList) {
    Step "pull $m into Ollama" { docker exec fs-ollama ollama pull $m } | Out-Null
  }
  Step "installed models and digests" { docker @p3 models } | Out-Null
  $c = Step "seed: datasets and prompt registry" { docker @p3 seed }
  if ($c -ne 0) { Write-Host "Stopped: seed failed. Log: $log"; exit 1 }
  Step "exchange rates (ECB) through n8n" { docker @p3 fx } | Out-Null
}

if ($Step -in @("geo", "all")) {
  $c = Step "gazetteer: Nominatim, one request per 1.2 s, cached in geo\places_osm.csv" { docker @p3 geo-fetch }
  if ($c -ne 0) { Write-Host "Stopped: gazetteer fetch failed. Log: $log"; exit 1 }
  Step "gazetteer: load places" { docker @p3 geo-load } | Out-Null
  Step "gazetteer: coverage of the P2 golden-set anchors" { docker @p3 geo-coverage } | Out-Null
  Step "synthetic listings and their embeddings" { docker @p3 seed-listings } | Out-Null
}

if ($Step -in @("eval", "all")) {
  $c = Step "prompts: store new versions (prompts\*\v*.md)" { docker @reg sync }
  if ($c -ne 0) { Write-Host "Stopped: prompt registry sync failed. Log: $log"; exit 1 }
  foreach ($m in $modelList) {
    foreach ($p in ($Prompts.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
      Step "evaluate $p versions $Versions on $m" { docker @p3 eval --prompt $p --versions $Versions --models $m } | Out-Null
    }
    Step "Ollama memory placement after $m (GPU or CPU share)" { docker exec fs-ollama ollama ps } | Out-Null
  }
}

if ($Step -in @("eval", "all", "report")) {
  Step "prompts: active versions from prompts\*\prompt.json" { docker @reg sync } | Out-Null
  Step "report: docs\PROMPT_EVAL.md and reports\eval\prompts-*.json" { docker @p3 report } | Out-Null
}

if ($Step -in @("bench", "all")) {
  Step "unload the LLMs (search uses only the embedding model)" {
    foreach ($m in $modelList) { docker exec fs-ollama ollama stop $m 2>&1 | Out-Null }
    docker exec fs-ollama ollama ps
  } | Out-Null
  Step "search latency: $BenchN requests through the proxy" { docker @p3 search-bench --n $BenchN } | Out-Null
}

Write-Host ""
Write-Host "Summary:"
Get-Content $summary | ForEach-Object { Write-Host "  $_" }
Write-Host "Log: $log"
