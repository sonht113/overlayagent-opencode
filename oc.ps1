#Requires -Version 5.1
<#
.SYNOPSIS
  One-command OpenCode + Agent Overlay (Phase 1+2).
#>

param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$OpenCodeArgs
)

$ErrorActionPreference = "Stop"
$ToolRoot = "C:\Work\Tool"
$StartOverlay = Join-Path $ToolRoot "start-overlay.ps1"
$HealthUrl = "http://127.0.0.1:9876/health"

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

Push-Location $ToolRoot
try {
  Write-Host "[oc] OpenCode via monitor..."
  if ($usePyLauncher) {
    & py -3 -m opencode_bridge run @OpenCodeArgs
  } else {
    & $py -m opencode_bridge run @OpenCodeArgs
  }
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
