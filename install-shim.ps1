#Requires -Version 5.1
<#
.SYNOPSIS
  Install PATH shim so plain `opencode` is monitored automatically (Phase 3).

.DESCRIPTION
  - Detects real OpenCode binary
  - Writes .agent-bridge/config.json
  - Prepends C:\Work\Tool\shim to User PATH
  - Does NOT replace npm global install
#>

param(
  [string]$ToolRoot = "C:\Work\Tool",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$ShimDir = Join-Path $ToolRoot "shim"
$StateDir = Join-Path $ToolRoot ".agent-bridge"
$ConfigPath = Join-Path $StateDir "config.json"

function Get-UserPath { [Environment]::GetEnvironmentVariable("Path", "User") }
function Set-UserPath([string]$p) {
  [Environment]::SetEnvironmentVariable("Path", $p, "User")
  $env:Path = "$p;$([Environment]::GetEnvironmentVariable('Path','Machine'))"
}

if ($Uninstall) {
  $path = Get-UserPath
  $parts = $path -split ";" | Where-Object { $_ -and ($_ -ne $ShimDir) }
  Set-UserPath ($parts -join ";")
  Write-Host "[shim] removed $ShimDir from User PATH"
  Write-Host "Restart terminals for PATH to refresh."
  exit 0
}

# Find real opencode.exe (not the shim, prefer .exe over .cmd)
$real = $null
$candidates = @(
  "$env:APPDATA\npm\node_modules\opencode-ai\bin\opencode.exe",
  "$env:LOCALAPPDATA\npm\node_modules\opencode-ai\bin\opencode.exe",
  "$env:APPDATA\npm\opencode.cmd",
  "$env:LOCALAPPDATA\npm\opencode.cmd"
)
foreach ($c in $candidates) {
  if (-not (Test-Path $c)) { continue }
  if ($c -like "*.exe") {
    $real = (Resolve-Path $c).Path
    break
  }
  $exe = Join-Path (Split-Path $c -Parent) "node_modules\opencode-ai\bin\opencode.exe"
  if (Test-Path $exe) {
    $real = (Resolve-Path $exe).Path
    break
  }
  $real = (Resolve-Path $c).Path
  break
}
if (-not $real) {
  $found = & where.exe opencode 2>$null
  foreach ($line in @($found)) {
    $full = "$line".Trim()
    if ($full -and ($full -notlike "$ShimDir*") -and (Test-Path $full) -and ($full -like "*.exe")) {
      $real = $full
      break
    }
  }
}

if (-not $real) {
  Write-Error "OpenCode not found. Install OpenCode first, then re-run."
  exit 1
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
New-Item -ItemType Directory -Force -Path $ShimDir | Out-Null

$cfg = @{
  opencode_cmd        = $real
  tauri_event_url     = "http://127.0.0.1:9876/event"
  health_url          = "http://127.0.0.1:9876/health"
  enable_tauri_event  = $true
  monitoring_enabled  = $true
}
$cfg | ConvertTo-Json | Set-Content $ConfigPath -Encoding UTF8
# Enable monitoring flag
Set-Content (Join-Path $StateDir "monitoring.enabled") "1" -Encoding UTF8

# Prepend shim to User PATH
$path = Get-UserPath
if (-not $path) { $path = "" }
if ($path -notlike "*$ShimDir*") {
  $newPath = if ($path) { "$ShimDir;$path" } else { $ShimDir }
  Set-UserPath $newPath
  Write-Host "[shim] prepended to User PATH: $ShimDir"
} else {
  Write-Host "[shim] already on User PATH"
}

# Also put Tool root for oc.cmd
if ($path -notlike "*$ToolRoot*" -and (Get-UserPath) -notlike "*$ToolRoot*") {
  $p2 = Get-UserPath
  Set-UserPath "$ToolRoot;$p2"
  Write-Host "[shim] prepended Tool root for oc: $ToolRoot"
}

Write-Host "[shim] real OpenCode: $real"
Write-Host "[shim] config: $ConfigPath"
Write-Host ""
Write-Host "Done. Open a NEW terminal, then:"
Write-Host "  where opencode    # should show ...\shim\opencode.cmd first"
Write-Host "  opencode          # monitored session"
Write-Host ""
Write-Host "Uninstall:  powershell -File $PSCommandPath -Uninstall"
