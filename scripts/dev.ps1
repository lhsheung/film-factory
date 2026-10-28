#!/usr/bin/env pwsh
# 直接启动 Electron 工作台，绕开 npm 的路径问题。
param(
    [string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent),
    [switch]$Dev,
    [switch]$Capture
)

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$electron = Join-Path $ProjectRoot 'node_modules/electron/dist/electron.exe'
if (-not (Test-Path $electron)) {
    throw "Electron 运行时缺失，请先 npm install（GitHub 不通时用 npmmirror 镜像重跑 install.js）"
}
$arguments = @($ProjectRoot)
if ($Dev) { $arguments += '--dev' }
if ($Capture) { $arguments += '--capture' }
& $electron @arguments
