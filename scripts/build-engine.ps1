#!/usr/bin/env pwsh
# 用源码构建 SpektraLab Windows 引擎（Vulkan 后端 + LibRaw + 原生 RAW 宿主）。
#
# 工具链默认取自本项目的 tools/ 目录（由 scripts/fetch-toolchain.js 下载），
# 所以不需要改动系统 PATH，也不需要在别的盘符安装任何东西。
#
# 为什么不直接调上游的 engine/build-windows.ps1：
# 它把 cmake 的 stderr 用 `2>&1` 汇进错误流，而 PowerShell 在
# $ErrorActionPreference='Stop' 下会把任何 stderr 输出（包括一条 CMake 警告）
# 当成终止错误，构建还没开始就退出。这里按同一组参数自己驱动 CMake，
# 通过 Start-Process 重定向日志，避免那条陷阱。
param(
    [string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$BuildDirectory,
    [string]$DependencyDirectory,
    [string]$CMakeExecutable,
    [string]$Compiler,
    [string]$MakeExecutable,
    [string]$CTestExecutable,
    [string]$VulkanIncludeDirectory,
    [string]$VulkanLibrary,
    [string]$GlslangExecutable,
    [switch]$Fresh,
    [switch]$SkipLibRaw,
    [switch]$SkipTests,
    [switch]$WithDesktop,
    [ValidateRange(1, 64)][int]$Jobs = 4
)

$ErrorActionPreference = 'Stop'
$vendor = Join-Path $ProjectRoot 'vendor/SpektraLab-1.3.3'
$engine = Join-Path $vendor 'engine'
if (-not (Test-Path (Join-Path $engine 'CMakeLists.txt'))) {
    throw "找不到上游引擎源码：$engine"
}
if (-not $BuildDirectory) { $BuildDirectory = Join-Path $ProjectRoot 'build/windows' }
if (-not $DependencyDirectory) { $DependencyDirectory = Join-Path $ProjectRoot 'tools/deps' }

$tools = Join-Path $ProjectRoot 'tools'
if (-not $CMakeExecutable) { $CMakeExecutable = Join-Path $tools 'cmake/cmake-3.31.6-windows-x86_64/bin/cmake.exe' }
if (-not $CTestExecutable) { $CTestExecutable = Join-Path (Split-Path $CMakeExecutable -Parent) 'ctest.exe' }
if (-not $Compiler) { $Compiler = Join-Path $tools 'mingw/mingw64/bin/g++.exe' }
if (-not $MakeExecutable) { $MakeExecutable = Join-Path (Split-Path $Compiler -Parent) 'mingw32-make.exe' }
if (-not $VulkanIncludeDirectory) { $VulkanIncludeDirectory = Join-Path $tools 'VulkanSDK/Include' }
if (-not $VulkanLibrary) { $VulkanLibrary = Join-Path $env:WINDIR 'System32\vulkan-1.dll' }
if (-not $GlslangExecutable) { $GlslangExecutable = Join-Path $tools 'VulkanSDK/Bin/glslangValidator.exe' }

foreach ($pair in @(
        @('CMake', $CMakeExecutable), @('CTest', $CTestExecutable), @('g++', $Compiler),
        @('mingw32-make', $MakeExecutable), @('glslangValidator', $GlslangExecutable))) {
    if (-not (Test-Path -LiteralPath $pair[1] -PathType Leaf)) {
        throw "缺少 $($pair[0])：$($pair[1])。先运行 node scripts/fetch-toolchain.js 并解压到 tools/。"
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $VulkanIncludeDirectory 'vulkan/vulkan_core.h') -PathType Leaf)) {
    throw "缺少 Vulkan 头文件：$VulkanIncludeDirectory。"
}
if (-not (Test-Path -LiteralPath $VulkanLibrary -PathType Leaf)) { throw "缺少 Vulkan 加载器：$VulkanLibrary" }

if (-not $SkipLibRaw) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $engine 'setup-libraw.ps1') -DependencyDirectory $DependencyDirectory
    if ($LASTEXITCODE -ne 0) { throw "LibRaw 准备失败（$LASTEXITCODE）" }
}

# 上游的 CMakeLists 只通过这个环境变量找头文件与 glslang。
$env:VULKAN_SDK = (Resolve-Path -LiteralPath (Join-Path $tools 'VulkanSDK')).Path
# Use the canonical `Path` casing: Windows exposes the variable case-insensitively,
# but Start-Process copies the environment into a case-sensitive dictionary and
# throws "Key in dictionary: 'Path'" if both spellings ever exist.
$env:Path = (Split-Path $Compiler -Parent) + [IO.Path]::PathSeparator + $env:Path

New-Item -ItemType Directory -Path $BuildDirectory -Force | Out-Null
$configureLog = Join-Path $BuildDirectory 'configure.log'
$buildLog = Join-Path $BuildDirectory 'build.log'

# Start-Process copies the environment into a case-sensitive dictionary and dies
# on machines that carry both `http_proxy` and `HTTP_PROXY` (this one does).
# A ProcessStartInfo inherits the environment as-is and redirects the streams.
function Invoke-Captured([string]$exe, [string[]]$arguments, [string]$logPath, [string]$title) {
    $quoted = $arguments | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $exe
    $info.Arguments = ($quoted -join ' ')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $text = $stdout.Result + "`n" + $stderr.Result
    Set-Content -Path $logPath -Value $text -Encoding UTF8
    Write-Host "$title exit=$($process.ExitCode)  (log: $logPath)" -ForegroundColor $(if ($process.ExitCode -eq 0) { 'Green' } else { 'Red' })
    return $process.ExitCode
}

$configure = @(
    # Upstream's top-level CMakeLists is the repository root; engine/ is a
    # subdirectory of it (`add_subdirectory(engine)`), which is where the
    # `engine` output folder comes from.
    '-S', (Split-Path $engine -Parent), '-B', $BuildDirectory,
    '-G', 'MinGW Makefiles',
    '-DCMAKE_BUILD_TYPE=Release',
    "-DCMAKE_CXX_COMPILER=$($Compiler.Replace('\', '/'))",
    "-DCMAKE_MAKE_PROGRAM=$($MakeExecutable.Replace('\', '/'))",
    '-DBUILD_TESTING=ON',
    '-DSPEKTRALAB_REQUIRE_VULKAN=ON',
    '-DSPEKTRALAB_BUILD_TEST_DLL=ON',
    "-DSPEKTRALAB_VULKAN_INCLUDE_DIR=$($VulkanIncludeDirectory.Replace('\', '/'))",
    "-DSPEKTRALAB_VULKAN_LIBRARY=$($VulkanLibrary.Replace('\', '/'))",
    "-DSPEKTRALAB_GLSLANG=$($GlslangExecutable.Replace('\', '/'))",
    "-DSPEKTRALAB_BUILD_DESKTOP=$(if ($WithDesktop) { 'ON' } else { 'OFF' })",
    '-DSPEKTRALAB_BUILD_NATIVE_RAW=ON',
    "-DSPEKTRALAB_LIBRAW_SOURCE=$((Join-Path $DependencyDirectory 'LibRaw-0.22.2').Replace('\', '/'))",
    '-Wno-dev'
)
if ($Fresh) { $configure = @('--fresh') + $configure }

$code = Invoke-Captured $CMakeExecutable $configure $configureLog 'cmake configure'
if ($code -ne 0) { throw "CMake 配置失败（$code），见 $configureLog" }

$code = Invoke-Captured $CMakeExecutable @('--build', $BuildDirectory, '--parallel', "$Jobs") $buildLog 'cmake build'
if ($code -ne 0) { throw "编译失败（$code），见 $buildLog" }

if (-not $SkipTests) {
    $testLog = Join-Path $BuildDirectory 'ctest.log'
    # `--test-dir` rather than a working directory: Push-Location changes the
    # PowerShell provider's location, not the child process's cwd, and ctest
    # would look for CTestTestfile.cmake somewhere else entirely.
    $code = Invoke-Captured $CTestExecutable @('--test-dir', $BuildDirectory, '--output-on-failure') $testLog 'ctest'
    if ($code -ne 0) { throw "CTest 未通过（$code），见 $testLog" }
}

$manifest = [ordered]@{
    built_utc      = [DateTime]::UtcNow.ToString('o')
    compiler       = $Compiler
    cmake          = $CMakeExecutable
    glslang        = $GlslangExecutable
    vulkan_headers = $VulkanIncludeDirectory
    vulkan_loader  = $VulkanLibrary
    build_directory = $BuildDirectory
    ctest_passed   = (-not $SkipTests)
}
$manifest | ConvertTo-Json | Set-Content -Path (Join-Path $BuildDirectory 'toolchain.json') -Encoding UTF8

$output = Join-Path $BuildDirectory 'engine'
Write-Host "引擎输出目录：$output" -ForegroundColor Yellow
Get-ChildItem $output -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host ("  {0}  {1:N1} MB" -f $_.Name, ($(if ($_.PSIsContainer) { 0 } else { $_.Length }) / 1MB)) }
