#Requires -Version 5.1
<#
  PATH shim for `opencode`.
  Resolves the real OpenCode binary (not this shim), then runs monitor wrapper.
#>

param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = "Stop"
$ToolRoot = if ($env:AGENT_TOOL_ROOT) { $env:AGENT_TOOL_ROOT } else { "C:\Work\Tool" }
$ShimDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:AGENT_OPENCODE_SHIM_DIR = $ShimDir
$env:AGENT_TOOL_ROOT = $ToolRoot

$ConfigPath = Join-Path $ToolRoot ".agent-bridge\config.json"
$Real = $null

function Resolve-OpenCodeExe([string]$path) {
  if (-not $path) { return $null }
  if ($path -like "*.exe" -and (Test-Path $path)) { return $path }
  $exe = Join-Path (Split-Path $path -Parent) "node_modules\opencode-ai\bin\opencode.exe"
  if (Test-Path $exe) { return (Resolve-Path $exe).Path }
  if (Test-Path $path) { return (Resolve-Path $path).Path }
  return $null
}

if (Test-Path $ConfigPath) {
  try {
    $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    if ($cfg.opencode_cmd) {
      $Real = Resolve-OpenCodeExe $cfg.opencode_cmd
    }
  } catch {}
}

if (-not $Real) {
  # Prefer real .exe over npm .cmd
  $candidates = @(
    "$env:APPDATA\npm\node_modules\opencode-ai\bin\opencode.exe",
    "$env:LOCALAPPDATA\npm\node_modules\opencode-ai\bin\opencode.exe",
    "$env:APPDATA\npm\opencode.cmd",
    "$env:LOCALAPPDATA\npm\opencode.cmd"
  )
  foreach ($c in $candidates) {
    $resolved = Resolve-OpenCodeExe $c
    if ($resolved) { $Real = $resolved; break }
  }
}

if (-not $Real) {
  # where.exe may return the shim first — take first path outside ShimDir
  $found = & where.exe opencode 2>$null
  if ($found) {
    foreach ($line in ($found | ForEach-Object { $_ })) {
      $full = $line.Trim()
      if ($full -and ($full -notlike "$ShimDir*")) {
        $Real = $full
        break
      }
    }
  }
}

if (-not $Real) {
  Write-Error "Could not resolve real OpenCode binary. Run install-shim.ps1 or set opencode_cmd in config."
  exit 1
}

$env:OPENCODE_CMD = $Real
$env:OPENCODE_REAL = $Real

# Ensure config has the path
$bridgeDir = Join-Path $ToolRoot ".agent-bridge"
New-Item -ItemType Directory -Force -Path $bridgeDir | Out-Null
if (-not (Test-Path $ConfigPath)) {
  @{ opencode_cmd = $Real; tauri_event_url = "http://127.0.0.1:9876/event"; enable_tauri_event = $true } |
    ConvertTo-Json | Set-Content $ConfigPath -Encoding UTF8
}

# Ensure overlay is up
$startOverlay = Join-Path $ToolRoot "start-overlay.ps1"
if (Test-Path $startOverlay) {
  try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:9876/health" -UseBasicParsing -TimeoutSec 1
  } catch {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $startOverlay | Out-Null
  }
}

# Run monitored OpenCode
$usePy = Get-Command py -ErrorAction SilentlyContinue
$py = $null
if (-not $usePy) {
  foreach ($c in @("python", "python3")) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { $py = $cmd.Source; break }
  }
}
if (-not $usePy -and -not $py) {
  Write-Error "Python not found"
  exit 1
}

$monitor = Join-Path $ToolRoot "opencode_monitor.py"
Push-Location $ToolRoot
try {
  if (Test-Path (Join-Path $ToolRoot "opencode_bridge")) {
    if ($usePy) { & py -3 -m opencode_bridge run @Args }
    else { & $py -m opencode_bridge run @Args }
    exit $LASTEXITCODE
  }
  if ($usePy) { & py -3 $monitor @Args }
  else { & $py $monitor @Args }
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
