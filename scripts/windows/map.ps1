# Map tiles for the website (platform P2, PLATFORM_SPEC 6.5). Cuts one country out of the Protomaps daily build of the
# OpenStreetMap basemap into geo\tiles\<country>.pmtiles, which the proxy serves to the search page's map.
# Runs on the owner's PC: the cloud sandbox cannot reach build.protomaps.com.
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\map.ps1                 # Tunisia, zoom 0 to 14
#   powershell -ExecutionPolicy Bypass -File scripts\windows\map.ps1 -Country FR     # France (metropolitan)
#   powershell -ExecutionPolicy Bypass -File scripts\windows\map.ps1 -MaxZoom 15     # full detail (bigger file)
#
# The pmtiles tool (go-pmtiles, BSD-3-Clause) is downloaded once into geo\tiles\tools and checked against the
# SHA-256 written below (computed from the GitHub release on 2026-10-16; the release publishes no checksum file).
# Log and file size: reports\map-<date>\map.log.
param([ValidateSet("TN", "FR", "GB")][string]$Country = "TN", [ValidateRange(8, 15)][int]$MaxZoom = 14, [string]$Build = "")

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dir = Join-Path $root "reports\map-$stamp"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir "map.log"
$utf8 = New-Object System.Text.UTF8Encoding $false
function Write-Log([string]$text) { [System.IO.File]::AppendAllText($log, $text + "`n", $utf8); Write-Host $text }

$Version = "1.31.2"
$ZipSha256 = "a658baa4d7e55020aef6ca17bd9ff9faa1582671266b36f58c52db0ac8e785a1"   # pragma: allowlist secret (a checksum, not a secret)
$Boxes = @{ TN = "7.4,30.1,11.7,37.6"; FR = "-5.3,41.2,9.7,51.2"; GB = "-8.7,49.8,1.9,60.9" }   # min_lng,min_lat,max_lng,max_lat

$tiles = Join-Path $root "geo\tiles"
$tools = Join-Path $tiles "tools"
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$exe = Join-Path $tools "pmtiles.exe"
Write-Log "map.ps1 $stamp country=$Country maxzoom=$MaxZoom"

# 1. the pmtiles tool
if (-not (Test-Path $exe)) {
  $zip = Join-Path $tools "go-pmtiles_${Version}_Windows_x86_64.zip"
  $url = "https://github.com/protomaps/go-pmtiles/releases/download/v$Version/go-pmtiles_${Version}_Windows_x86_64.zip"
  Write-Log "== download $url"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  $sha = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
  if ($sha -ne $ZipSha256) { Write-Log "Stopped: checksum $sha is not the expected $ZipSha256"; Remove-Item $zip; exit 1 }
  Expand-Archive -Path $zip -DestinationPath $tools -Force
  Remove-Item $zip
}
Write-Log ("== tool: " + (& $exe version 2>&1 | Out-String).Trim())

# 2. the newest daily build that still exists (builds are named by date)
if (-not $Build) {
  for ($d = 0; $d -lt 10; $d++) {
    $name = (Get-Date).ToUniversalTime().AddDays(-$d).ToString("yyyyMMdd")
    try {
      $r = Invoke-WebRequest -Uri "https://build.protomaps.com/$name.pmtiles" -Method Head -UseBasicParsing -TimeoutSec 30
      if ($r.StatusCode -eq 200) { $Build = "https://build.protomaps.com/$name.pmtiles"; break }
    } catch { }
  }
}
if (-not $Build) { Write-Log "Stopped: no Protomaps daily build found in the last 10 days (https://build.protomaps.com)"; exit 1 }
Write-Log "== build: $Build"

# 3. the extract (range requests on the remote file; only the tiles inside the box are downloaded)
$out = Join-Path $tiles ($Country.ToLower() + ".pmtiles")
$tmp = "$out.part"
$sw = [Diagnostics.Stopwatch]::StartNew()
& $exe extract $Build $tmp "--bbox=$($Boxes[$Country])" "--maxzoom=$MaxZoom" 2>&1 | ForEach-Object { Write-Log "   $_" }
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmp)) { Write-Log "Stopped: pmtiles extract failed (exit $LASTEXITCODE)"; exit 1 }
Move-Item -Force $tmp $out
$mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Log ("== wrote {0}: {1} MB in {2} s" -f $out, $mb, [math]::Round($sw.Elapsed.TotalSeconds))
& $exe show $out 2>&1 | ForEach-Object { Write-Log "   $_" }

# 4. served by the proxy?
try {
  $h = Invoke-WebRequest -Uri ("http://localhost:3000/tiles/" + $Country.ToLower() + ".pmtiles") -Method Head -UseBasicParsing -TimeoutSec 10
  Write-Log "== served at http://localhost:3000/tiles/$($Country.ToLower()).pmtiles (HTTP $($h.StatusCode))"
} catch {
  Write-Log "== not served yet (is the stack running? docker compose up -d proxy): $($_.Exception.Message)"
}
Write-Log "Done. Open http://localhost:3000/fr/search?view=map"
