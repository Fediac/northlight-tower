@echo off
chcp 65001 >nul
cd /d "%~dp0"
python plugin_setup.py remove
echo.
pause
