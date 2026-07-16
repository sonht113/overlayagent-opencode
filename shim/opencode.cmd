@echo off
REM PATH shim: intercepts `opencode` and runs the monitored wrapper.
REM Real binary path is stored in %AGENT_TOOL_ROOT%\.agent-bridge\config.json
set "AGENT_TOOL_ROOT=C:\Work\Tool"
set "AGENT_OPENCODE_SHIM_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0opencode.ps1" %*
