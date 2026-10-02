# Knowledge base (phase 2) on Windows: load the pack sources, ingest a jurisdiction,
# export the cleaned texts, and run the retrieval evaluation. Needs the stack running
# (scripts\windows\verify.ps1 first). Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\kb.ps1 -Step ingest       # seed + ingest TN + export
#   powershell -ExecutionPolicy Bypass -File scripts\windows\kb.ps1 -Step eval         # seed + check gold + evaluate + report
#   powershell -ExecutionPolicy Bypass -File scripts\windows\kb.ps1 -Step all
#   powershell -ExecutionPolicy Bypass -File scripts\windows\kb.ps1 -Step report       # report + dump of the latest evaluation
# Options: -Jurisdiction TN, -Sources "key1,key2" (ingest only these), -Force (re-chunk unchanged sources),
#          -Version 2 (gold set version for -Step eval; default 1).
# Output: reports\kb-<timestamp>\kb.log and summary.txt; texts in kb\packs\<CODE>\documents\ (not committed);
# docs\RETRIEVAL_EVAL.md after -Step eval.
param([ValidateSet("ingest", "eval", "all", "report")][string]$Step = "ingest", [string]$Jurisdiction = "TN",
      [string]$Sources = "", [switch]$Force, [int]$Version = 1)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dir = Join-Path $root "reports\kb-$stamp"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir "kb.log"
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
New-Item -ItemType Directory -Force -Path (Join-Path $root "kb\packs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $root "reports\eval") | Out-Null
$rw = @("-v", "${root}\kb\packs:/flatshare/kb/packs", "-v", "${root}\docs:/flatshare/docs", "-v", "${root}\reports\eval:/flatshare/reports/eval")
$kb = @("compose") + $files + @("--profile", "test", "run", "--rm", "--no-deps") + $rw + @("tests", "python", "scripts/kb.py")

Step "stack is up (n8n healthy, TEI answers)" {
  docker inspect -f "{{.State.Health.Status}}" fs-n8n
  docker compose @files --profile test run --rm --no-deps tests python -c "import httpx; r = httpx.get('http://tei:80/health', timeout=10); print('TEI', r.status_code); raise SystemExit(0 if r.status_code == 200 else 1)"
} | Out-Null

$c = Step "seed: pack sources and evaluation datasets" { docker @kb seed }
if ($c -ne 0) { Write-Host "Stopped: seed failed. Log: $log"; exit 1 }

if ($Step -in @("ingest", "all")) {
  # Sources are fetched by n8n: check its container reaches the internet first (T-25: after the
  # PC slept, every robots.txt request failed without an HTTP answer and all sources were skipped).
  $c = Step "n8n container reaches the internet" {
    docker exec fs-n8n node -e "Promise.allSettled(['https://www.justice.gov.tn/robots.txt','https://www.jurisitetunisie.com/robots.txt'].map(u=>fetch(u,{signal:AbortSignal.timeout(15000)}).then(r=>u+' HTTP '+r.status))).then(rs=>{let ok=0;for(const r of rs){if(r.status==='fulfilled'){ok++;console.log(r.value)}else{console.log('network error: '+((r.reason.cause&&r.reason.cause.code)||r.reason.message))}}process.exit(ok?0:1)})"
  }
  if ($c -ne 0) {
    Write-Host "Stopped: n8n cannot reach the internet. Restart Docker Desktop (or check the PC's connection), then run this again. Log: $log"
    exit 1
  }
  $args2 = @("ingest", "--jurisdiction", $Jurisdiction)
  if ($Sources) { $args2 += @("--sources", $Sources) }
  if ($Force) { $args2 += "--force" }
  Step "ingest $Jurisdiction (fetch, clean, chunk, embed; can take long on CPU)" { docker @kb @args2 } | Out-Null
  Step "export current documents to kb\packs\*\documents" { docker @kb export } | Out-Null
}
if ($Step -in @("eval", "all")) {
  $c = Step "gold spans resolve against the current documents" { docker @kb check-gold --version $Version }
  if ($c -ne 0) { Write-Host "Stopped: the gold set does not match the corpus. Log: $log"; exit 1 }
  Step "retrieval evaluation (full matrix) and docs\RETRIEVAL_EVAL.md" { docker @kb eval --jurisdiction $Jurisdiction --version $Version } | Out-Null
}
if ($Step -eq "report") {
  Step "docs\RETRIEVAL_EVAL.md and reports\eval\<job>.json for the latest evaluation" { docker @kb report --job latest } | Out-Null
}

Write-Host ""
Write-Host "Summary ($summary):"
Get-Content $summary
Write-Host "Full log: $log"
