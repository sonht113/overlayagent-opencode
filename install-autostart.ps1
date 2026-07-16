#Requires -Version 5.1
<#
.SYNOPSIS
  Install/remove Windows Startup entries for Agent Overlay (+ optional daemon).

.EXAMPLE
  .\install-autostart.ps1
  .\install-autostart.ps1 -WithDaemon
  .\install-autostart.ps1 -Uninstall
#>

param(
  [string]$ToolRoot = "C:\Work\Tool",
  [switch]$WithDaemon,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$Startup = [Environment]::GetFolderPath("Startup")
$OverlayLnk = Join-Path $Startup "AgentOverlay.lnk"
$DaemonLnk = Join-Path $Startup "AgentOverlayDaemon.lnk"

function New-Shortcut([string]$Path, [string]$Target, [string]$Args, [string]$WorkDir) {
  $w = New-Object -ComObject WScript.Shell
  $s = $w.CreateShortcut($Path)
  $s.TargetPath = $Target
  $s.Arguments = $Args
  $s.WorkingDirectory = $WorkDir
  $s.WindowStyle = 7  # minimized
  $s.Save()
}

if ($Uninstall) {
  Remove-Item $OverlayLnk -ErrorAction SilentlyContinue
  Remove-Item $DaemonLnk -ErrorAction SilentlyContinue
  Write-Host "[autostart] removed Startup shortcuts"
  exit 0
}

$startOverlay = Join-Path $ToolRoot "start-overlay.ps1"
if (-not (Test-Path $startOverlay)) {
  Write-Error "Missing $startOverlay"
  exit 1
}

$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
New-Shortcut $OverlayLnk $ps "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startOverlay`"" $ToolRoot
Write-Host "[autostart] Overlay: $OverlayLnk"

if ($WithDaemon) {
  $py = "py"
  if (-not (Get-Command py -ErrorAction SilentlyContinue)) { $py = "python" }
  $daemonArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"Set-Location '$ToolRoot'; $py -3 -m opencode_bridge daemon`""
  New-Shortcut $DaemonLnk $ps $daemonArgs $ToolRoot
  Write-Host "[autostart] Daemon: $DaemonLnk"
}

Write-Host "[autostart] OK - will run at next login (or run start-overlay now)."
