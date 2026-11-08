@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Only removes the SendMessage permission rule (the plugin stays; messages are relayed through the main worker).
python plugin_setup.py permission-remove
echo.
pause
