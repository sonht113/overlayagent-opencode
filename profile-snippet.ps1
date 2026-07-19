# =============================================================================
# Agent Overlay + OpenCode helpers - paste into PowerShell profile:
#   notepad $PROFILE
#   . C:\Work\Tool\profile-snippet.ps1
# =============================================================================

$AgentToolRoot = "C:\Work\Tool"

if (Test-Path $AgentToolRoot) {
  # Prefer shim first (monitored opencode), then Tool root (oc.cmd)
  $shim = Join-Path $AgentToolRoot "shim"
  $parts = @()
  if (Test-Path $shim) { $parts += $shim }
  $parts += $AgentToolRoot
  foreach ($p in $parts) {
    if ($env:Path -notlike "*$p*") {
      $env:Path = "$p;$env:Path"
    }
  }
  $env:AGENT_TOOL_ROOT = $AgentToolRoot
}

function oc {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & "$AgentToolRoot\oc.ps1" @Args
}

function Start-AgentOverlay {
  & "$AgentToolRoot\start-overlay.ps1"
}

function Enable-AgentMonitor {
  Set-Location $AgentToolRoot
  python -m opencode_bridge enable
}

function Disable-AgentMonitor {
  Set-Location $AgentToolRoot
  python -m opencode_bridge disable
}

function Get-AgentStatus {
  Set-Location $AgentToolRoot
  python -m opencode_bridge status
}

Write-Host "Agent Overlay: oc | Start-AgentOverlay | Enable/Disable-AgentMonitor | Get-AgentStatus" -ForegroundColor DarkGray
