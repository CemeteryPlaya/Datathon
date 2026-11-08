@echo off
rem One-time setup: Node.js packages and the Python environment for the model.
rem ASCII only: Cyrillic text in .cmd files breaks cmd.exe parsing.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required: https://nodejs.org
  pause
  exit /b 1
)
where py >nul 2>nul
if errorlevel 1 (
  echo Python 3.10+ is required: https://www.python.org/downloads/
  pause
  exit /b 1
)

echo [1/4] App packages: npm install
call npm install
if errorlevel 1 goto fail

echo [2/4] Python environment for the model: local-model\.venv
if not exist "local-model\.venv\Scripts\python.exe" py -3 -m venv "local-model\.venv"
if not exist "local-model\.venv\Scripts\python.exe" goto fail

echo [3/4] PyTorch for CPU, about 200 MB, one time
"local-model\.venv\Scripts\python.exe" -m pip install torch --index-url https://download.pytorch.org/whl/cpu
if errorlevel 1 goto fail

echo [4/4] Other model packages
"local-model\.venv\Scripts\python.exe" -m pip install -r "local-model\requirements.txt"
if errorlevel 1 goto fail

if not exist ".env" copy ".env.example" ".env" >nul
echo.
echo Done. To start the app run start.cmd
pause
exit /b 0

:fail
echo.
echo Setup failed, see the messages above.
pause
exit /b 1
