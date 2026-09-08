@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-TermLens.ps1"
if errorlevel 1 pause
