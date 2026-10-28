#!/usr/bin/env pwsh
# 检查构建 SpektraLab Windows 引擎所需的工具链是否齐全。
# 只读：不安装任何东西、不写工作区之外的目录。结果以 JSON 写到 stdout。
param(
    [string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Continue'
$vendor = Join-Path $ProjectRoot 'vendor/SpektraLab-1.3.3'
$workspace = Split-Path $ProjectRoot -Parent
$dependencyDirectory = Join-Path $workspace 'deps'

function Find-App([string]$Name, [string[]]$Candidates) {
    $found = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    return $null
}

function Test-Version([string]$Executable, [string]$Arguments) {
    if (-not $Executable) { return $null }
    try {
        $text = & $Executable $Arguments 2>&1 | Out-String
        if ($text -match '(\d+)\.(\d+)(?:\.(\d+))?') { return $Matches[0] }
    } catch { }
    return $null
}

$cmakeBin = @(
    (Join-Path $dependencyDirectory 'cmake-3.25.0-windows-x86_64\bin\cmake.exe'),
    (Join-Path $env:ProgramFiles 'CMake\bin\cmake.exe')
)
$cmake = Find-App 'cmake.exe' $cmakeBin
$gpp = Find-App 'g++.exe' @()
$make = Find-App 'mingw32-make.exe' @($(if ($gpp) { Join-Path (Split-Path $gpp -Parent) 'mingw32-make.exe' }))
$ctest = Find-App 'ctest.exe' @($(if ($cmake) { Join-Path (Split-Path $cmake -Parent) 'ctest.exe' }))
$glslang = Find-App 'glslangValidator.exe' @()

$vulkanInclude = $null
$includeCandidates = @((Join-Path $dependencyDirectory 'Vulkan-Headers\include'))
if ($env:VULKAN_SDK) { $includeCandidates = @((Join-Path $env:VULKAN_SDK 'Include')) + $includeCandidates }
foreach ($candidate in $includeCandidates) {
    if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'vulkan\vulkan.h'))) { $vulkanInclude = $candidate; break }
}

$libraw = Join-Path $dependencyDirectory 'LibRaw-0.22.2'
$sourcePresent = Test-Path -LiteralPath (Join-Path $vendor 'engine\build-windows.ps1')

$requirements = @(
    [ordered]@{ key = 'source';    label = '上游引擎源码 vendor/SpektraLab-1.3.3';  ok = [bool]$sourcePresent; detail = $(if ($sourcePresent) { $vendor } else { '缺失：源码未随应用分发' });                       fix = '重新获取 SpektraLab v1.3.3 源码并放到 vendor/SpektraLab-1.3.3' },
    [ordered]@{ key = 'cmake';     label = 'CMake 3.25+';                           ok = [bool]$cmake;         detail = $(if ($cmake) { "$cmake（$(Test-Version $cmake '--version')）" } else { '未找到' }); fix = 'winget install Kitware.CMake 后重开终端' },
    [ordered]@{ key = 'ctest';     label = 'CTest';                                 ok = [bool]$ctest;         detail = $(if ($ctest) { $ctest } else { '未找到' });                                             fix = '随 CMake 一起安装' },
    [ordered]@{ key = 'gpp';       label = 'MinGW g++ 15.2（C++20）';               ok = [bool]$gpp;           detail = $(if ($gpp) { "$gpp（$(Test-Version $gpp '--version')）" } else { '未找到' });       fix = 'winget install BrechtSanders.WinLibs.POSIX.UCRT 或安装 MSYS2 MinGW 工具链' },
    [ordered]@{ key = 'make';      label = 'mingw32-make';                          ok = [bool]$make;          detail = $(if ($make) { $make } else { '未找到' });                                             fix = '随 MinGW 工具链一起安装' },
    [ordered]@{ key = 'vulkan';    label = 'Vulkan 头文件（vulkan/vulkan.h）';      ok = [bool]$vulkanInclude; detail = $(if ($vulkanInclude) { $vulkanInclude } else { '未找到' });                           fix = '安装 Vulkan SDK（winget install KhronosGroup.VulkanSDK）或把 Vulkan-Headers 放到 deps' },
    [ordered]@{ key = 'glslang';   label = 'glslangValidator';                      ok = [bool]$glslang;       detail = $(if ($glslang) { $glslang } else { '未找到' });                                       fix = '随 Vulkan SDK 一起安装' },
    [ordered]@{ key = 'libraw';    label = 'LibRaw 0.22.2 源码';                    ok = (Test-Path -LiteralPath $libraw); detail = $(if (Test-Path -LiteralPath $libraw) { $libraw } else { '未准备好，构建脚本会自动下载' }); fix = '由 scripts/build-engine.ps1 自动准备' }
)

$optionalMissing = @($requirements | Where-Object { -not $_.ok -and $_.key -ne 'libraw' })
$ready = ($optionalMissing.Count -eq 0)

[ordered]@{
    ready        = $ready
    projectRoot  = $ProjectRoot
    missing      = @($optionalMissing | ForEach-Object { $_.key })
    requirements = $requirements
} | ConvertTo-Json -Depth 6
