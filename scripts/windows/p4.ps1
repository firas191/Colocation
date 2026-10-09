# Phase 4 on Windows: Text service models and evaluation, P3 listing extractor evaluation.
# (Photos, ASR and vision steps are added as those parts are built.)
# Needs the stack running and up to date: run scripts\windows\verify.ps1 first. Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p4.ps1 -Step setup       # datasets and prompts; GlotLID and NER models (about 2.8 GB) into the text_models volume
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p4.ps1 -Step text-eval   # PII masking on both sets with and without NER; language ID on the P1 and P2 sets
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p4.ps1 -Step p3-eval     # P3 v3 and v4 on the 100 listings, one job per version (v1: about 74 s per listing on qwen3.5:4b, F-058)
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p4.ps1 -Step report      # docs\PROMPT_EVAL.md from the stored runs (P1, P2, P3)
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p4.ps1 -Step photos-fetch # candidate room photos from Wikimedia Commons into ..\photo_bench (D-069)
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p4.ps1 -Step p7-setup     # P7 golden set and prompts; labelled photos through the Media service into eval/p7/; vision check
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p4.ps1 -Step p7-eval      # P7 v1 and v2 on the labelled photos, one job per version; pHash threshold on the same photos
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p4.ps1 -Step agent-bench  # A3 Match agent: 27 conversations on the real model, then the fixed path (D-084)
#   powershell -ExecutionPolicy Bypass -File scripts\windows\p4.ps1 -Step all         # setup, text-eval, p3-eval, report
# Options: -Models "qwen3.5:4b"  -Versions "3,4"
# Output: reports\p4-<timestamp>\p4.log and summary.txt; reports\eval\text-*.json and prompts-*.json; docs\PROMPT_EVAL.md.
param([ValidateSet("setup", "text-eval", "p3-eval", "report", "photos-fetch", "p7-setup", "p7-eval", "agent-bench", "all")][string]$Step = "all",
      [string]$Models = "qwen3.5:4b", [string]$Versions = "3,4", [string]$P7Versions = "1,2")

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dir = Join-Path $root "reports\p4-$stamp"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir "p4.log"
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
foreach ($d in @("reports\eval", "docs")) { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }
$rw = @("-v", "${root}\docs:/flatshare/docs", "-v", "${root}\reports\eval:/flatshare/reports/eval")
$run = @("compose") + $files + @("--profile", "test", "run", "--rm", "--no-deps") + $rw + @("tests", "python")
$modelList = $Models.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }

# Photos (D-069): kept next to the repository, never committed. Needs internet only, not the stack.
$photoDir = Join-Path (Split-Path -Parent $root) "photo_bench"
if ($Step -eq "photos-fetch") {
  New-Item -ItemType Directory -Force -Path $photoDir | Out-Null
  $prun = @("compose") + $files + @("--profile", "test", "run", "--rm", "--no-deps", "-v", "${photoDir}:/photo_bench") + @("tests", "python")
  Step "photos: candidates from Wikimedia Commons into $photoDir (CC0, public domain, CC BY, CC BY-SA only)" { docker @prun scripts/photos.py fetch --out /photo_bench } | Out-Null
  Write-Host ""; Write-Host "Summary:"; Get-Content $summary | ForEach-Object { Write-Host "  $_" }; Write-Host "Log: $log"
  exit 0
}

$c = Step "stack is up (n8n healthy, migration 0011 applied, Text service healthy)" {
  docker inspect -f "{{.State.Health.Status}}" fs-n8n
  docker inspect -f "{{.State.Health.Status}}" fs-text
  $v = docker exec -u postgres fs-postgres psql -d flatshare -tAc "select count(*) from public.schema_migrations where version like '0011%'"
  if ("$v".Trim() -ne "1") { "migration 0011 is not applied: run scripts\windows\verify.ps1 first"; $global:LASTEXITCODE = 1 }
}
if ($c -ne 0) { Write-Host "Stopped: run scripts\windows\verify.ps1 first. Log: $log"; exit 1 }

if ($Step -in @("setup", "all")) {
  $c = Step "seed: datasets (p3_listing v1) and prompt registry (P3 v1, v2)" { docker @run scripts/p3.py seed }
  if ($c -ne 0) { Write-Host "Stopped: seed failed. Log: $log"; exit 1 }
  $c = Step "Text service models: GlotLID v3 and the NER model from Hugging Face (revisions in manifest.json)" {
    docker compose @files run --rm --no-deps text python fetch_models.py
  }
  if ($c -ne 0) { Write-Host "Stopped: model download failed. Log: $log"; exit 1 }
  Step "restart the Text service so it loads the models" {
    docker compose @files restart text
    $ok = $false
    for ($i = 0; $i -lt 60; $i++) { Start-Sleep 5; if ((docker inspect -f "{{.State.Health.Status}}" fs-text) -eq "healthy") { $ok = $true; break } }
    if (-not $ok) { "fs-text not healthy after 5 minutes; last log lines:"; docker logs fs-text --tail 30; $global:LASTEXITCODE = 1 }
  } | Out-Null
  Step "Text service uses GlotLID and the NER model" { docker exec fs-text python selfcheck.py } | Out-Null
}

if ($Step -in @("text-eval", "all")) {
  $c = Step "Text service is up and uses its models" { docker exec fs-text python selfcheck.py }
  if ($c -ne 0) { Write-Host "Stopped: the Text service is not ready (see the log above). Log: $log"; exit 1 }
  $u = @("--url", "http://text:8000")
  Step "language ID: P1 and P2 golden sets" { docker @run eval/runners/text_eval.py langid @u --label "pc langid" } | Out-Null
  Step "PII masking: pii_v1 with NER" { docker @run eval/runners/text_eval.py pii @u --label "pc pii_v1 ner" } | Out-Null
  Step "PII masking: pii_heldout_v1 with NER" { docker @run eval/runners/text_eval.py pii @u --dataset pii_heldout_v1.jsonl --label "pc heldout ner" } | Out-Null
  Step "PII masking: pii_v1 without NER" { docker @run eval/runners/text_eval.py pii @u --no-ner --label "pc pii_v1 no-ner" } | Out-Null
  Step "PII masking: pii_heldout_v1 without NER" { docker @run eval/runners/text_eval.py pii @u --no-ner --dataset pii_heldout_v1.jsonl --label "pc heldout no-ner" } | Out-Null
}

if ($Step -in @("p3-eval", "all")) {
  $c = Step "prompts: store new versions (prompts\*\v*.md)" { docker @run scripts/prompts.py sync }
  if ($c -ne 0) { Write-Host "Stopped: prompt registry sync failed. Log: $log"; exit 1 }
  foreach ($m in $modelList) {
    # One job per version: each is timed on its own, and a stop loses one version, not both (F-058).
    foreach ($v in ($Versions.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
      Step "evaluate P3_listing_extractor version $v on $m (waits up to 8 h)" { docker @run scripts/p3.py eval --prompt P3_listing_extractor --versions $v --models $m --timeout 28800 } | Out-Null
    }
    Step "Ollama memory placement after $m (GPU or CPU share)" { docker exec fs-ollama ollama ps } | Out-Null
  }
}

if ($Step -eq "p7-setup") {
  $c = Step "seed: datasets (p7_photos v1 with the others) and prompt registry (P7 v1, v2)" { docker @run scripts/p3.py seed }
  if ($c -ne 0) { Write-Host "Stopped: seed failed. Log: $log"; exit 1 }
  $prun = @("compose") + $files + @("--profile", "test", "run", "--rm", "--no-deps", "-v", "${photoDir}:/photo_bench:ro") + $rw + @("tests", "python")
  $c = Step "photos: the labelled photos through the Media service (EXIF strip, blurring) into eval/p7/" {
    docker @prun scripts/photos.py upload --dir /photo_bench --report "/flatshare/reports/eval/p7-upload-$stamp.json"
  }
  if ($c -ne 0) { Write-Host "Stopped: photo upload failed (photos in $photoDir ?). Log: $log"; exit 1 }
  Step "vision: the model accepts images (ollama show lists the vision capability)" {
    foreach ($m in $modelList) {
      $show = docker exec fs-ollama ollama show $m
      $show
      if (-not ($show -match "vision")) { "$m does not list the vision capability"; $global:LASTEXITCODE = 1 }
    }
  } | Out-Null
}

if ($Step -eq "p7-eval") {
  foreach ($m in $modelList) {
    foreach ($v in ($P7Versions.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
      Step "evaluate P7_photo_analyzer version $v on $m (waits up to 8 h)" { docker @run scripts/p3.py eval --prompt P7_photo_analyzer --versions $v --models $m --timeout 28800 } | Out-Null
    }
    Step "Ollama memory placement after $m with images" { docker exec fs-ollama ollama ps } | Out-Null
  }
  # pHash threshold (D-082): the Media service's own hashing code, in its container, on the original photos.
  Step "pHash threshold: near-duplicate and unrelated pairs of the labelled photos" {
    docker compose @files run --rm --no-deps -v "${photoDir}:/photo_bench:ro" -v "${root}:/flatshare:ro" -v "${root}\reports\eval:/out" --entrypoint python media /flatshare/eval/runners/phash_pairs.py --dir /photo_bench --dataset /flatshare/eval/datasets/p7_photos_v1.jsonl --out "/out/phash-pairs-$stamp.json"
  } | Out-Null
}

if ($Step -eq "agent-bench") {
  $c = Step "prompts: store new versions and the active ones (P6_match_agent)" { docker @run scripts/prompts.py sync }
  if ($c -ne 0) { Write-Host "Stopped: prompt registry sync failed. Log: $log"; exit 1 }
  Step "Match agent: conversations of match_agent_v1, then the first messages on the fixed path (about 30 to 60 min)" {
    docker @run scripts/agent_bench.py
  } | Out-Null
  Step "Ollama memory placement after the agent runs" { docker exec fs-ollama ollama ps } | Out-Null
}

if ($Step -in @("p3-eval", "p7-eval", "all", "report")) {
  Step "prompts: active versions from prompts\*\prompt.json" { docker @run scripts/prompts.py sync } | Out-Null
  Step "report: docs\PROMPT_EVAL.md and reports\eval\prompts-*.json" { docker @run scripts/p3.py report } | Out-Null
}

Write-Host ""
Write-Host "Summary:"
Get-Content $summary | ForEach-Object { Write-Host "  $_" }
Write-Host "Log: $log"
