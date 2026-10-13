@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop-Mira.ps1"
if errorlevel 1 pause
