@echo off
rem Start: model service and the app in two windows, then the browser. To stop, close both windows.
rem ASCII only: Cyrillic text in .cmd files breaks cmd.exe parsing.
cd /d "%~dp0"

if not exist "local-model\.venv\Scripts\python.exe" goto need_setup
if not exist "node_modules" goto need_setup

start "CQA model" "local-model\.venv\Scripts\python.exe" "local-model\serve.py"
start "CQA app" cmd /k npm start
ping -n 5 127.0.0.1 >nul
start "" "http://localhost:3000"
exit /b 0

:need_setup
echo Run setup.cmd first.
pause
exit /b 1
