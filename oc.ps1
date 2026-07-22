#Requires -Version 5.1
<#
.SYNOPSIS
  One-command OpenCode + Agent Overlay (Phase 1+2).
#>

# Use $args (not param()) so PowerShell never steals -v as -Verbose.
$OpenCodeArgs = @($args)
if ($OpenCodeArgs.Count -gt 0 -and $OpenCodeArgs[0] -eq "--") {
  $OpenCodeArgs = @($OpenCodeArgs | Select-Object -Skip 1)
}

$ErrorActionPreference = "Stop"
# Script-relative root (override with AGENT_TOOL_ROOT)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolRoot = if ($env:AGENT_TOOL_ROOT) { $env:AGENT_TOOL_ROOT } else { $ScriptDir }
$StartOverlay = Join-Path $ToolRoot "start-overlay.ps1"
$HealthUrl = "http://127.0.0.1:9876/health"
$ConfigPath = Join-Path $ToolRoot ".agent-bridge\config.json"
function Resolve-OpenCodeExe([string]$path) {
  if (-not $path) { return $null }
  if ($path -like "*.exe" -and (Test-Path $path)) { return $path }
  $exe = Join-Path (Split-Path $path -Parent) "node_modules\opencode-ai\bin\opencode.exe"
  if (Test-Path $exe) { return (Resolve-Path $exe).Path }
  if (Test-Path $path) { return (Resolve-Path $path).Path }
  return $null
}

function Get-RealOpenCode {
  if ($env:OPENCODE_REAL -and (Test-Path $env:OPENCODE_REAL)) { return $env:OPENCODE_REAL }
  if ($env:OPENCODE_CMD) {
    $r = Resolve-OpenCodeExe $env:OPENCODE_CMD
    if ($r) { return $r }
  }
  if (Test-Path $ConfigPath) {
    try {
      $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
      if ($cfg.opencode_cmd) {
        $r = Resolve-OpenCodeExe $cfg.opencode_cmd
        if ($r) { return $r }
      }
    } catch {}
  }
  foreach ($c in @(
    "$env:APPDATA\npm\node_modules\opencode-ai\bin\opencode.exe",
    "$env:LOCALAPPDATA\npm\node_modules\opencode-ai\bin\opencode.exe"
  )) {
    $r = Resolve-OpenCodeExe $c
    if ($r) { return $r }
  }
  return $null
}

# Meta flags: skip overlay/monitor.
$metaFlags = @("-v", "--version", "-h", "--help")
if ($OpenCodeArgs -and $OpenCodeArgs.Count -ge 1) {
  $first = $OpenCodeArgs[0]
  $allMeta = $true
  foreach ($a in $OpenCodeArgs) {
    if ($metaFlags -notcontains $a) { $allMeta = $false; break }
  }
  if ($allMeta -and ($metaFlags -contains $first)) {
    $real = Get-RealOpenCode
    if (-not $real) {
      Write-Error "Could not resolve real OpenCode binary."
      exit 1
    }
    & $real @OpenCodeArgs
    exit $LASTEXITCODE
  }
}

function Test-OverlayHealth {
  try {
    $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 1
    return $r.StatusCode -ge 200 -and $r.StatusCode -lt 300
  } catch {
    return $false
  }
}

if (-not (Test-OverlayHealth)) {
  Write-Host "[oc] Overlay not detected - starting..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File $StartOverlay
  for ($i = 1; $i -le 15; $i++) {
    Start-Sleep -Milliseconds 400
    if (Test-OverlayHealth) { break }
  }
  if (-not (Test-OverlayHealth)) {
    Write-Warning "[oc] Overlay health still failing - events may be dropped."
  }
} else {
  Write-Host "[oc] Overlay OK"
}

$usePyLauncher = $false
$py = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
  $usePyLauncher = $true
} else {
  foreach ($c in @("python", "python3")) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { $py = $cmd.Source; break }
  }
}
if (-not $usePyLauncher -and -not $py) {
  Write-Error "Python not found on PATH (tried py, python, python3)"
  exit 1
}

# Keep caller's cwd so OpenCode opens the project the user is in.
$env:AGENT_TOOL_ROOT = $ToolRoot
$env:PYTHONPATH = if ($env:PYTHONPATH) { "$ToolRoot$([IO.Path]::PathSeparator)$env:PYTHONPATH" } else { $ToolRoot }
Write-Host "[oc] OpenCode via monitor..."
if ($usePyLauncher) {
  & py -3 -m opencode_bridge run @OpenCodeArgs
} else {
  & $py -m opencode_bridge run @OpenCodeArgs
}
exit $LASTEXITCODE
