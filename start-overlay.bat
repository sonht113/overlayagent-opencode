@echo off
REM Launch Agent Overlay in background (calls PowerShell script)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-overlay.ps1" %*
