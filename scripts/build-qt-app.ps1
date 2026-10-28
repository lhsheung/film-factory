#!/usr/bin/env pwsh
# 用源码构建上游 Qt Quick 编辑器（官方 Windows 前端）。
# 前置：scripts/build-engine.ps1 已成功；Qt 6.11.3 MinGW SDK 由 setup-qt.ps1 下载到本地 deps。
param(
    [string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$BuildDirectory,
    [string]$DependencyDirectory,
    [switch]$RunTests,
    [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
$vendor = Join-Path $ProjectRoot 'vendor/SpektraLab-1.3.3'
$frontend = Join-Path $vendor 'windows_UI'
if (-not (Test-Path (Join-Path $frontend 'build.ps1'))) {
    throw "找不到上游 Qt 前端源码：$frontend"
}
if (-not $BuildDirectory) { $BuildDirectory = Join-Path $ProjectRoot 'build/qt' }
if (-not $DependencyDirectory) { $DependencyDirectory = Join-Path (Split-Path $ProjectRoot -Parent) 'deps' }

& (Join-Path $frontend 'setup-qt.ps1') -DependencyDirectory $DependencyDirectory

$arguments = @{
    SourceDirectory     = $vendor
    BuildDirectory      = $BuildDirectory
    DependencyDirectory = $DependencyDirectory
}
if ($RunTests) { $arguments.RunTests = $true }
if ($Fresh) { $arguments.Fresh = $true }
& (Join-Path $frontend 'build.ps1') @arguments

Write-Host "前端输出目录：$(Join-Path $BuildDirectory 'app')" -ForegroundColor Yellow
