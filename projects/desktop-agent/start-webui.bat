@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Douyin Agent Web UI ===
echo.
echo Server at http://127.0.0.1:5050
echo.
venv\Scripts\python.exe webui.py
pause
