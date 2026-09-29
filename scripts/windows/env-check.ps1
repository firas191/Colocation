# Environment check for the flatshare backend (Windows host).
# Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\env-check.ps1
# Writes reports\env-check.txt. Read-only: it changes nothing on the machine,
# except pulling the small ubuntu image if the GPU-in-Docker test runs.

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$out = Join-Path $root "reports\env-check.txt"
New-Item -ItemType Directory -Force -Path (Join-Path $root "reports") | Out-Null

function Section($name, [scriptblock]$block) {
  "`n===== $name =====" | Out-File -FilePath $out -Append -Encoding utf8
  try { & $block 2>&1 | Out-String -Width 200 | Out-File -FilePath $out -Append -Encoding utf8 }
  catch { "ERROR: $($_.Exception.Message)" | Out-File -FilePath $out -Append -Encoding utf8 }
}

"env-check run at $(Get-Date -Format o)" | Out-File -FilePath $out -Encoding utf8

Section "OS" { Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture }
Section "CPU" { Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors }
Section "RAM (GB)" { [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1) }
Section "Disks" { Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter, FileSystemLabel, @{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}}, @{n='FreeGB';e={[math]::Round($_.SizeRemaining/1GB,1)}} }
Section "GPU (Windows)" { Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, @{n='AdapterRAM_GB';e={[math]::Round($_.AdapterRAM/1GB,1)}} }
Section "nvidia-smi (host)" { if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv } else { "nvidia-smi not found" } }
Section "WSL" { wsl --status; wsl -l -v }
Section ".wslconfig" { $p = Join-Path $env:USERPROFILE ".wslconfig"; if (Test-Path $p) { Get-Content $p } else { "no .wslconfig (WSL default memory limit applies)" } }
Section "Docker version" { docker version }
Section "Docker info (resources)" { docker info --format "CPUs={{.NCPU}} Mem={{.MemTotal}} Server={{.ServerVersion}} OS={{.OperatingSystem}} Runtimes={{json .Runtimes}}" }
Section "Docker compose" { docker compose version }
Section "GPU inside Docker" { docker run --rm --gpus all ubuntu:24.04 nvidia-smi --query-gpu=name,memory.total --format=csv }
Section "Ollama (host)" {
  if (Get-Command ollama -ErrorAction SilentlyContinue) { ollama --version; ollama list } else { "ollama CLI not found on host" }
  try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://localhost:11434/api/version).Content } catch { "Ollama API not reachable on localhost:11434" }
}
Section "Ports in use (5432 5678 6379 8080 3900 11434)" { Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 5432,5678,6379,8080,3900,3903,11434 } | Select-Object LocalAddress, LocalPort, OwningProcess }

"`nDone. File: $out" | Out-File -FilePath $out -Append -Encoding utf8
Write-Host "Wrote $out"
