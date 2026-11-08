@echo off
chcp 65001 >nul
title NorthLight Tower
cd /d "%~dp0"
rem Starts the server if it is not running (only a real NorthLight Tower counts, never another program on the port),
rem then opens the app window. All logic lives in _tower.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_tower.ps1" start
exit /b %errorlevel%
