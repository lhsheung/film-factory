@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron runtime is missing.
  echo Run: npm install
  echo Then retry START.cmd
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
