@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Stops the NorthLight Tower server (closing the window does not stop the server; the server uses very few resources).
rem It only ever stops this tower's own server, never another program that uses the same port.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_tower.ps1" stop
timeout /t 2 >nul
