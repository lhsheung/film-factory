#!/usr/bin/env pwsh
# 本地验证：跑单测，再启动应用自动截图，确认窗口仍然画得出来。
param(
    [string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$testFiles = @(
    'tests/params.test.js',
    'tests/session-store.test.js',
    'tests/engine.test.js',
    'tests/automation.test.js'
) | ForEach-Object { Join-Path $ProjectRoot $_ }

& node --test @testFiles
if ($LASTEXITCODE -ne 0) { throw '单元测试失败' }

$electron = Join-Path $ProjectRoot 'node_modules/electron/dist/electron.exe'
if (Test-Path $electron) {
    & $electron $ProjectRoot --capture
    Write-Host "截图输出：$(Join-Path $ProjectRoot 'captures/workbench.png')" -ForegroundColor Yellow
} else {
    Write-Host '跳过截图：Electron 运行时未安装' -ForegroundColor DarkYellow
}
