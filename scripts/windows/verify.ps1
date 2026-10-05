# Build, start and verify the stack (phases 0 to 2) on Windows with Docker Desktop.
# Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\verify.ps1          # GPU if Docker can see one
#   powershell -ExecutionPolicy Bypass -File scripts\windows\verify.ps1 -Cpu     # force CPU
#   powershell -ExecutionPolicy Bypass -File scripts\windows\verify.ps1 -SkipOutages
# Every command and its full output go to reports\verify-<timestamp>\verify.log,
# with a one-line result per step in summary.txt. Nothing is deleted.
param([switch]$Cpu, [switch]$SkipOutages)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dir = Join-Path $root "reports\verify-$stamp"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir "verify.log"
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
  $out = & $block 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  foreach ($l in $out) { Write-Log $l }
  $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  Write-Log "exit=$code seconds=$secs"
  $result = if ($code -eq 0) { "PASS" } else { "FAIL" }
  [System.IO.File]::AppendAllText($summary, "$result  $name  (exit $code, $secs s)`n", $utf8)
  Write-Host "   $result (exit $code, $secs s)"
  return $code
}

Write-Log "verify.ps1 run $stamp on $env:COMPUTERNAME"

# The repository history arrives as flatshare.bundle (remote tools cannot write .git).
# With git installed, restore it once so the secret scan can use git.
# Later deliveries update the files and the bundle; the history then fast-forwards
# to the bundle (only if the local branch has no commits of its own).
if ((Test-Path "flatshare.bundle") -and (Get-Command git -ErrorAction SilentlyContinue)) {
  Step "sync git history with flatshare.bundle" {
    if (-not (Test-Path ".git")) { git init -q -b main }
    git fetch -q flatshare.bundle main
    $head = git rev-parse -q --verify HEAD 2>$null
    if (-not $head) { git reset -q --mixed FETCH_HEAD }
    else {
      git merge-base --is-ancestor HEAD FETCH_HEAD
      if ($LASTEXITCODE -eq 0) { git reset -q --mixed FETCH_HEAD } else { "local commits found: history left as it is" }
    }
    $global:LASTEXITCODE = 0
    git log --oneline -n 5
  } | Out-Null
}
if (-not (Test-Path ".env")) { & powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1 | Out-Null }
else { Step "add settings introduced by later phases to .env (existing lines unchanged)" { & powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1 -AddMissing } | Out-Null }

# Docker Desktop must be running; without this check the GPU step silently falls back to CPU
# and the version step passes with an empty server version (FAILURES F-021).
$c = Step "Docker engine is running" { docker info --format "server {{.ServerVersion}} os {{.OperatingSystem}}" }
if ($c -ne 0) {
  Write-Host ""
  Write-Host "Stopped: the Docker engine is not running. Start Docker Desktop, wait until it shows Engine running, then run this script again. Log: $log"
  exit 1
}
$files = @("-f", "docker-compose.yml")
$gpu = $false
if (-not $Cpu) {
  $c = Step "GPU visible to Docker (docker run --gpus all ... nvidia-smi)" { docker run --rm --gpus all ubuntu:24.04 nvidia-smi -L }
  if ($c -eq 0) { $gpu = $true; $files += @("-f", "docker-compose.gpu.yml") }
}
Write-Log "gpu_override=$gpu"
$env:N8N_IMPORT_TEST_WORKFLOWS = "1"

function Stop-OnFail([int]$code, [string]$what) {
  if ($code -ne 0) {
    Write-Host ""
    Write-Host "Stopped: '$what' failed. Nothing after it can work. Summary: $summary  Log: $log"
    exit 1
  }
}

Step "docker and compose versions" { docker version --format "client {{.Client.Version}} server {{.Server.Version}}"; docker compose version } | Out-Null
Step "free disk space (Docker Desktop stores images on C: by default; about 10 GB is needed)" {
  Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { "{0}: {1:N1} GB free" -f $_.Name, ($_.Free / 1GB) }
} | Out-Null
$c = Step "compose config is valid" { docker compose @files config -q }
Stop-OnFail $c "compose config"
$c = Step "every pinned image tag exists in its registry" {
  $bad = 0
  foreach ($img in @("postgis/postgis:18-3.6", "amacneil/dbmate:2.36.0", "dxflrs/garage:v2.4.1", "ollama/ollama:0.34.4",
                     "n8nio/n8n:2.41.3", "n8nio/runners:2.41.3", "caddy:2.11.4-alpine", "python:3.12.14-slim", "docker:29.8.1-cli",
                     "ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4")) {
    docker manifest inspect $img *> $null
    if ($LASTEXITCODE -eq 0) { "found    $img" } else { "MISSING  $img"; $bad++ }
  }
  $global:LASTEXITCODE = $bad
}
Stop-OnFail $c "image tag check"
$c = Step "pull service images (largest download: Ollama, n8n)" { docker compose @files pull --ignore-buildable }
Stop-OnFail $c "pull images"
$c = Step "build images" { docker compose @files --profile test build }
Stop-OnFail $c "build images"
# n8n-setup imports the workflows from this folder, n8n loads them at start and Caddy reads
# its config only at start: recreate the three so the code under test is the code in this folder.
# This restarts n8n: do not run verify.ps1 while a kb.ps1 job is running.
$c = Step "start stack" { docker compose @files up -d; docker compose @files up -d --force-recreate n8n-setup n8n proxy }
Stop-OnFail $c "start stack"

$c = Step "wait for n8n, proxy and model pull (max 20 min)" {
  $deadline = (Get-Date).AddMinutes(20)
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    $n8n = docker inspect -f "{{.State.Health.Status}}" fs-n8n 2>$null
    $proxy = docker inspect -f "{{.State.Status}}" fs-proxy 2>$null
    $pull = docker compose @files ps -a --format "{{.Service}} {{.State}} {{.ExitCode}}" 2>$null | Select-String "^ollama-pull "
    if ($n8n -eq "healthy" -and $proxy -eq "running" -and "$pull" -match "exited 0") { $ok = $true; break }
    $failed = docker compose @files ps -a --format "{{.Service}} {{.State}} {{.ExitCode}}" 2>$null | Select-String "exited [1-9]"
    if ($failed) { "one-shot service failed: $failed"; break }
    Start-Sleep -Seconds 10
  }
  docker compose @files ps -a
  if (-not $ok) { $global:LASTEXITCODE = 1 } else { $global:LASTEXITCODE = 0 }
}
if ($c -ne 0) {
  Step "logs of the failed start (last 200 lines per service)" { docker compose @files logs --no-color --tail 200 } | Out-Null
}
Stop-OnFail $c "wait for the stack"

# TEI downloads multilingual-e5-large (about 2.2 GB) from Hugging Face on its first start.
$c = Step "wait for TEI (multilingual-e5-large; first start downloads the model, max 45 min)" {
  docker compose @files --profile test run --rm --no-deps tests python -c @"
import time, httpx
t0 = time.time()
while time.time() - t0 < 2700:
    try:
        r = httpx.get('http://tei:80/health', timeout=5)
        if r.status_code == 200:
            print('TEI healthy after', round(time.time() - t0), 's'); raise SystemExit(0)
    except httpx.HTTPError:
        pass
    time.sleep(10)
print('TEI not healthy after 45 min'); raise SystemExit(1)
"@
}
if ($c -ne 0) { Step "TEI logs (last 100 lines)" { docker compose @files logs --no-color --tail 100 tei } | Out-Null }
Stop-OnFail $c "wait for TEI"

Step "one-shot service logs (db-bootstrap, n8n-setup, ollama-pull)" {
  docker compose @files logs --no-color db-bootstrap n8n-setup ollama-pull
} | Out-Null

Step "component versions" {
  docker compose @files images
  foreach ($i in @("flatshare/postgres:18-3.6-pgvector0.8", "dxflrs/garage:v2.4.1", "ollama/ollama:0.34.4", "n8nio/n8n:2.41.3", "n8nio/runners:2.41.3", "caddy:2.11.4-alpine", "flatshare/tests:py3.12.14", "ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4")) {
    docker image inspect --format "{{index .RepoTags 0}} id={{.Id}} digests={{.RepoDigests}}" $i
  }
  docker exec -u postgres fs-postgres psql -At -d flatshare -c "select version()" -c "select extname || ' ' || extversion from pg_extension order by 1" -c "select 'migration ' || max(version) from public.schema_migrations"
  docker exec fs-n8n n8n --version
  docker exec fs-ollama ollama --version
  docker exec fs-ollama ollama list
  docker compose @files --profile test run --rm --no-deps tests python -c "import httpx; print('TEI info', httpx.get('http://tei:80/info', timeout=10).text)"
} | Out-Null

Step "PHASE 0: embedding call returns 1024 numbers (bge-m3 via Ollama)" {
  docker compose @files --profile test run --rm --no-deps tests python -c @"
import httpx, math, time
texts = ['chambre meublee pres de la fac', '\u063a\u0631\u0641\u0629 \u0644\u0644\u0643\u0631\u0627\u0621', 'room to rent near campus', '7ajti b bit fi ariana']
t = time.time()
r = httpx.post('http://ollama:11434/api/embed', json={'model': 'bge-m3', 'input': texts}, timeout=600)
dt = time.time() - t
d = r.json()
dims = [len(e) for e in d['embeddings']]
norms = [round(math.sqrt(sum(x * x for x in e)), 4) for e in d['embeddings']]
print('status', r.status_code, 'model', d.get('model'), 'dims', dims, 'l2_norms', norms, 'seconds_for_4_texts', round(dt, 2))
raise SystemExit(0 if r.status_code == 200 and dims == [1024] * 4 else 1)
"@
} | Out-Null

Step "PHASE 2: TEI embeds 1024 numbers with multilingual-e5-large and tokenizes with offsets" {
  docker compose @files --profile test run --rm --no-deps tests python -c @"
import httpx, math, time
texts = ['passage: chambre meublee pres de la fac', 'passage: \u063a\u0631\u0641\u0629 \u0644\u0644\u0643\u0631\u0627\u0621', 'query: room to rent near campus', 'query: 7ajti b bit fi ariana']
t = time.time()
r = httpx.post('http://tei:80/embed', json={'inputs': texts, 'normalize': True}, timeout=600)
dt = time.time() - t
e = r.json()
dims = [len(x) for x in e]
norms = [round(math.sqrt(sum(v * v for v in x)), 4) for x in e]
print('embed status', r.status_code, 'dims', dims, 'l2_norms', norms, 'seconds_for_4_texts', round(dt, 2))
s = 'Le d\u00e9p\u00f4t est restitu\u00e9. \u0627\u0644\u0643\u0631\u0627\u0621 \u0639\u0642\u062f'
k = httpx.post('http://tei:80/tokenize', json={'inputs': [s], 'add_special_tokens': False}, timeout=60).json()[0]
stop = max(t['stop'] for t in k)
unit = 'char' if stop <= len(s) else 'byte'
print('tokenize tokens', len(k), 'max stop', stop, 'chars', len(s), 'utf8 bytes', len(s.encode()), 'offset unit', unit)
print('tokens', [(t['text'], t['start'], t['stop']) for t in k])
raise SystemExit(0 if r.status_code == 200 and dims == [1024] * 4 and len(k) > 0 else 1)
"@
} | Out-Null

Step "PHASE 1 and 2: database tests (pgTAP on the compose PostgreSQL)" {
  docker exec -u postgres fs-postgres bash /flatshare/scripts/db-test.sh
} | Out-Null

Step "unit tests, JavaScript (Code-node helpers, chunkers, metrics, workflow checks)" {
  docker compose @files run --rm --no-deps -v "${root}:/flatshare:ro" --entrypoint sh n8n -c "node --test /flatshare/n8n/tests/*.test.js /flatshare/kb/tests/*.test.js /flatshare/eval/tests/*.test.js"
} | Out-Null

Step "workflow JSON matches n8n/build.py" {
  docker compose @files --profile test run --rm --no-deps tests python n8n/build.py --check
} | Out-Null

$pytestArgs = @("pytest", "-v", "-rs", "tests/unit", "tests/contract")
if ($SkipOutages) { $pytestArgs += @("-k", "not down and not unreachable") }
Step "PHASE 4: Media service tests in its container (photo pipeline: validation, EXIF, hashes, blur, storage)" {
  docker compose @files run --rm --no-deps media python -m pytest -q -p no:cacheprovider tests
} | Out-Null
Step "PHASE 4: Text service tests in its container (language ID, PII masking)" {
  docker compose @files run --rm --no-deps -e TEXT_WARM=0 text python -m pytest -q -p no:cacheprovider tests
} | Out-Null
Step "PHASE 4: Telegram relay tests in its container (order, retry, no token in logs)" {
  docker compose @files run --rm --no-deps telegram python -m pytest -q -p no:cacheprovider tests
} | Out-Null
Step "start the test fixture server (ingestion tests)" { docker compose @files --profile test up -d fixtures } | Out-Null
Step "PHASE 1 and 2: unit and contract tests through the proxy (includes outage tests unless -SkipOutages)" {
  docker compose @files --profile test run --rm --no-deps tests @pytestArgs
} | Out-Null

Step "export workflows from n8n and scan for secrets" {
  docker exec fs-n8n sh -c "rm -rf /tmp/export && mkdir -p /tmp/export && n8n export:workflow --all --separate --output=/tmp/export/"
  $exp = Join-Path $dir "n8n-export"
  docker cp "fs-n8n:/tmp/export" $exp
  docker compose @files --profile test run --rm --no-deps -v "${exp}:/export:ro" tests bash scripts/secret-scan.sh /export .env secrets/api-clients.env
} | Out-Null

Step "final state" { docker compose @files ps -a } | Out-Null

Write-Host ""
Write-Host "Summary ($summary):"
Get-Content $summary
Write-Host "Full log: $log"
