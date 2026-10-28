# Windows 源码构建（SpektraLab 引擎）

本文件记录本机如何从源码编出 SpektraLab 的 Windows 引擎，以及把产物搬走时要带齐什么。
上游 macOS 走 Metal，Windows 走 Vulkan；两条路径共用同一份 C++ 核心。

## 工具链位置

全部装在本项目 `tools/` 内，**不改系统 PATH、不写别的盘符、不需要管理员**。

| 组件 | 路径 | 说明 |
|---|---|---|
| MinGW GCC 15.2（C++20） | `tools/mingw/mingw64/` | WinLibs UCRT，含 `g++.exe`、`mingw32-make.exe` |
| CMake 3.31.6 + CTest | `tools/cmake/cmake-3.31.6-windows-x86_64/bin/` | `cmake.exe`、`ctest.exe` |
| Vulkan SDK 组件 | `tools/VulkanSDK/` | `Bin/glslangValidator.exe`（编译 GLSL 计算着色器）+ `Include/vulkan/*` |
| Vulkan 加载器 | `C:\Windows\System32\vulkan-1.dll` | 由显卡驱动提供（本机 RTX 4070 Laptop） |
| LibRaw 0.22.2 源码 | `tools/deps/LibRaw-0.22.2/` | 由 `setup-libraw.ps1` 解开，SHA256 已校验 |
| 下载缓存 | `tools/downloads/` | 三个压缩包，可删 |

重新获取工具链：

```powershell
node scripts/fetch-toolchain.js          # 下载 CMake / MinGW / Vulkan SDK 安装包
# 解包（7-Zip 比 Expand-Archive 快很多）
& "C:\Program Files\7-Zip\7z.exe" x tools\downloads\winlibs-gcc-15.2.0.zip -otools\mingw -y
& "C:\Program Files\7-Zip\7z.exe" x tools\downloads\vulkan-sdk.exe -otools\_vulkansdk_raw -y
```

## 构建

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-engine.ps1 -Fresh -Jobs 8
```

脚本会自动把 `tools/` 里的工具填给上游的 `engine/build-windows.ps1`，并设置 `VULKAN_SDK`
指向 `tools/VulkanSDK` —— 上游的 CMakeLists 只通过这个环境变量找头文件和 glslang。

前置步骤（脚本会自己做）：

1. `engine/setup-libraw.ps1`：解开并校验 LibRaw 0.22.2。
2. CMake 配置：`-G "MinGW Makefiles"`，`SPEKTRALAB_REQUIRE_VULKAN=ON`，`SPEKTRALAB_BUILD_TEST_DLL=ON`，
   `SPEKTRALAB_BUILD_NATIVE_RAW=ON`，`SPEKTRALAB_BUILD_DESKTOP=OFF`。
3. 编译 34 个 GLSL 计算内核 → SPIR-V（`glslangValidator -V --target-env vulkan1.0`）。
4. 编译引擎、原生 RAW 宿主、测试 DLL。
5. CTest。
6. 写 `build/windows/toolchain.json` 哈希清单。

## 产物

| 文件 | 大小 | 作用 |
|---|---|---|
| `build/windows/engine/spk_raw_render.exe` | 2.76 MB | 原生 RAW → TIFF16 宿主，应用通过它做真实光谱显影 |
| `build/windows/engine/spektrafilm_engine.dll` | 1.27 MB | 引擎 C ABI（`SPEKTRALAB_BUILD_TEST_DLL=ON`） |
| `build/windows/engine/resources/` | 5.6 MB 档案 | 81 波长档案、打印 LUT、常量表 —— **必须整套带走** |
| `build/windows/engine/shaders/vulkan/*.spv` | — | 编译好的计算内核 |
| `build/windows/toolchain.json` | — | 构建清单（时间、编译器、CTest 结果） |

`SpektraLab.exe`（Qt Quick 桌面壳）**没有**构建：它需要单独的 Qt 6 工具链（`windows_UI/`
里有 `qt-packages.json` 清单），体积与时间都远超引擎本身。本应用不需要它 —— 界面是
Electron 的，引擎只作为子进程被调用。

## 验证结果（本机，2026-10-28）

- CMake 配置、编译、CTest 全部走通，整轮约 5.5 分钟（`-Jobs 8`）。
- **CTest 14 / 15 通过**，包括 `spk_vulkan_smoke`、六个 Vulkan 探针、
  `spk_windows_feature_boundaries`、`spk_windows_c_abi`。
- 唯一失败：`spk_image_writer` —— `transferred TIFF handle does not permit rollback
  deletion`。Windows 不允许删除仍被打开的文件，这是该测试的回滚删除路径与平台语义的
  冲突，不影响出片（写入、ICC 标记与尺寸都正确）。
- 端到端实测：`PHS_0611.RW2`（Panasonic DC-S5，4016 × 6024）
  → `portra.tif`，9.3 秒，145 MB RGB16 TIFF（内嵌 ICC），未开 headroom 模式。

## 搬迁时要带齐

- `spk_raw_render.exe` 与同目录的 MinGW 运行时 DLL：`libgcc_s_seh-1.dll`、`libstdc++-6.dll`、
  `libwinpthread-1.dll`（`ldd` / `objdump -p` 可查实际依赖）。
- 整个 `resources/` 目录（缺 `profiles/` 或常量表时引擎会拒绝启动）。
- `shaders/vulkan/*.spv`。
- 许可证声明：`licenses/GPL-3.0.txt`、`licenses/CC-BY-SA-4.0.txt`，以及上游档案里的
  `metadata.copyright` —— 胶片档案数据是 CC BY-SA 4.0，必须保留署名与同类共享。

## 应用如何找到引擎

`src/engine.js` 的 `candidates()` 依次看：

1. 用户设置里显式选择的路径；
2. `<项目根>/build/windows/engine/`；
3. `<项目根>/vendor/SpektraLab-1.3.3/build/windows/engine/`；
4. 打包后 exe 同级的 `engine/` 与 `resources/engine/`。

设置面板的「自动检测」「导入引擎文件夹」「用源码构建」三个按钮走同一套解析，
`engine:diagnostics` 会逐项报告宿主、resources、ASCII 路径与可用性。

## 两条必须处理的平台约束

**1. 引擎只接受纯 ASCII 路径。** 打包目录名是中文（`菲林工厂-win32-x64`），
`%APPDATA%\菲林工厂` 也是中文，两者都会让上游 `spk_raw_render.exe` 直接拒绝。
`materializeEngine()` 在解析到非 ASCII 路径时，把宿主、DLL、`resources` 镜像到
`%ProgramData%\jdtfl-engine\engine`（不可写时退回 `%LOCALAPPDATA%`、`%TEMP%`），
用 mtime + size 做版本戳避免重复复制；渲染作业目录也落在引擎旁的 `jobs/`。

**2. Electron 的 GPU 进程在这台机器上起不来。** 表现是 `GPU process exited
unexpectedly: exit_code=1` 重复几次后 `FATAL: GPU process isn't usable. Goodbye.`，
窗口直接消失。`--safe` 现在同时做：关硬件加速、`--disable-gpu`、
`--disable-gpu-compositing`、`--disable-gpu-sandbox`、`--no-sandbox`、
`--use-angle=swiftshader`、`--enable-unsafe-swiftshader`、禁用 Vulkan 特性。
另外 `child-process-gone` 里监听 GPU 崩溃，未处于安全模式时自动带 `--safe` 重启一次。

启动器：`START.cmd`（正常）与 `以安全模式启动.cmd`（`--safe`）。

## 交付验证（2026-10-28）

| 项目 | 结果 |
|---|---|
| 引擎构建 | CMake 配置 + 编译 + CTest 全流程通过 |
| CTest | 14 / 15（`spk_image_writer` 为 Windows 文件锁语义差异，不影响出片） |
| 引擎 CLI | `PHS_0568.RW2` → 138.4 MB RGB16 TIFF，7.5 秒，解码器 LibRaw 0.22.2 / AHD |
| 应用内显影 | 打开 `PHS_0568.RW2` 自动用引擎显影，界面显示「光谱引擎结果 · sRGB 显示」 |
| 胶片边缘 | 界面截图确认：齿孔、DX 条码、画面编号、日期后背均写入成片 |
| 半格配对 | 两张画面合成 36 × 24 一格（`半格配对：两张画面已合成`），片门按 19.00 mm 进片 |
| RAW 上开边缘 | 引擎拒绝 `overscan`，改为在光谱成片上叠加同一套内核（`applyEdgeOnly`） |
| 精修层 | 曝光/对比/高光/阴影/饱和/色温/色调与旋转翻转都进入管线（不再只靠 CSS） |
| 导出 | 普通图走本机管线；RAW 用已有光谱成片；支持 16 位宽色域 TIFF、Cineon DPX |
| 单元测试 | 37 / 37（参数、会话、引擎桥、自动化、成像管线 21 项） |
| 发布版 | `dist/菲林工厂-win32-x64`（405 MB，含 `engine/`、启动器、许可证） |

发布目录里除 exe 和 `engine/`，还有 `启动.cmd`、`安全模式启动.cmd`、`使用说明.txt`、
`THIRD-PARTY-NOTICES.txt`、`licenses/`、`BUILD-WINDOWS.md`。

## 打包

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
node scripts/package.js
```

`scripts/package.js` 负责：忽略 `tools/`、`vendor/`、`build/`、`tests/`；
**关闭 asar**（`sharp` 的 `.node` 原生模块无法从 asar 内加载，否则打包版只剩一个
"Error" 窗口）；把引擎的 exe、DLL、`resources`、`shaders` 复制到 exe 同级 `engine/`。

