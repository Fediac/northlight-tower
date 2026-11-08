@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_shortcut.ps1"
echo.
echo A "NorthLight Tower" icon was created on your desktop. Double-click it to open the tower.
pause
