@echo off
REM Short entrypoint: oc → ensure overlay → opencode_monitor.py
REM Add C:\Work\Tool to PATH, or call with full path.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0oc.ps1" %*
