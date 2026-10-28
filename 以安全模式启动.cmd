@echo off
setlocal
cd /d "%~dp0"
rem 当显卡/驱动或远程桌面环境无法启动 Chromium 的 GPU 进程时，用这个方式启动。
if exist "dist\几多筒菲林-win32-x64\几多筒菲林.exe" (
  start "" "dist\几多筒菲林-win32-x64\几多筒菲林.exe" --safe
  exit /b 0
)
if exist "release\几多筒菲林-win32-x64\几多筒菲林.exe" (
  start "" "release\几多筒菲林-win32-x64\几多筒菲林.exe" --safe
  exit /b 0
)
echo 未找到打包程序，请先执行：npm run package:win
pause
