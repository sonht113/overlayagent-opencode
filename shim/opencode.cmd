@echo off
REM PATH shim: intercepts `opencode` and runs the monitored wrapper.
REM Real binary path is stored in %AGENT_TOOL_ROOT%\.agent-bridge\config.json
REM Default root = parent of this shim dir (override with AGENT_TOOL_ROOT).
if not defined AGENT_TOOL_ROOT (
  for %%I in ("%~dp0..") do set "AGENT_TOOL_ROOT=%%~fI"
)
set "AGENT_OPENCODE_SHIM_DIR=%~dp0"
REM --%% becomes --% for PowerShell (stops -v being rewritten as -Verbose).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0opencode.ps1" --%% %*
