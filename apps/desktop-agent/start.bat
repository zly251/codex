@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Douyin Agent MVP ===
echo.
echo [1/3] Creating venv...
if not exist "venv\Scripts\python.exe" (
    "C:\Users\asus\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m venv venv
)
echo [2/3] Installing deps...
call venv\Scripts\python.exe -m pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/
call venv\Scripts\python.exe -m playwright install chromium
echo [3/3] Starting agent...
echo.
venv\Scripts\python.exe main.py
pause
