#Requires -Version 5.1
<#
.SYNOPSIS
  Start Agent Overlay in the background (detached).

.DESCRIPTION
  Prefers a built agent-overlay.exe; falls back to npm run tauri dev.
  Safe to call multiple times - skips if HTTP health endpoint already responds.
#>

param(
  [string]$OverlayDir = "",
  [string]$HealthUrl = "http://127.0.0.1:9876/health",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not $OverlayDir) {
  $scriptRoot = if ($env:AGENT_TOOL_ROOT) {
    $env:AGENT_TOOL_ROOT
  } else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
  }
  $OverlayDir = Join-Path $scriptRoot "agent-overlay"
}

function Test-OverlayHealth {
  param([string]$Url)
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 1
    return $r.StatusCode -ge 200 -and $r.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Get-OverlayExe {
  param([string]$Dir)
  $candidates = @(
    (Join-Path $Dir "src-tauri\target\release\agent-overlay.exe"),
    (Join-Path $Dir "src-tauri\target\debug\agent-overlay.exe")
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }
  return $null
}

if (-not $Force -and (Test-OverlayHealth -Url $HealthUrl)) {
  Write-Host "[overlay] already running ($HealthUrl)"
  exit 0
}

$exe = Get-OverlayExe -Dir $OverlayDir
if ($exe) {
  Write-Host "[overlay] starting $exe"
  Start-Process -FilePath $exe -WorkingDirectory $OverlayDir -WindowStyle Hidden
} else {
  Write-Host "[overlay] no .exe found - starting npm run tauri dev (dev mode)"
  if (-not (Test-Path $OverlayDir)) {
    Write-Error "Overlay dir not found: $OverlayDir"
    exit 1
  }
  Start-Process -FilePath "npm" -ArgumentList @("run", "tauri", "dev") `
    -WorkingDirectory $OverlayDir `
    -WindowStyle Minimized
}

$max = 20
for ($i = 1; $i -le $max; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-OverlayHealth -Url $HealthUrl) {
    $sec = [math]::Round($i * 0.5, 1)
    Write-Host "[overlay] ready after ~${sec}s"
    exit 0
  }
}

$timeoutSec = $max * 0.5
Write-Warning "[overlay] started but health check did not pass within ${timeoutSec}s"
Write-Warning "Events may fail until the app finishes booting."
exit 0
