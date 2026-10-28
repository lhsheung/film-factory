# 菲林工厂 · Film Factory

Windows 上的光谱胶片与暗房工作台。界面是 Electron，成像由两部分组成：上游 SpektraLab 的
81 波长 Vulkan 引擎（处理原生 RAW），以及本项目按上游源码逐行移植的本机管线（处理已解码图像，
并负责场景宽容度、对比度蒙版、胶片边缘、日期后背、半格配对与 Cineon 数字中间片）。

- 作者：Lau Hing Sheung
- 许可证：GPL-3.0-or-later（`LICENSE`）
- 上游：SpektraLab v1.3.3（`vendor/SpektraLab-1.3.3`，构建时获取）
- 胶片/相纸档案：来自上游，CC BY-SA 4.0（`THIRD-PARTY-NOTICES.txt`）

## 功能

| 功能 | 来源 |
|---|---|
| 81 波长光谱显影（RAW → 16 位 TIFF） | 上游引擎，本仓库从源码构建 |
| 胶片/相纸响应 | 直接读取上游档案里实测的密度曲线 |
| 场景宽容度 RFC-023 | `scene_latitude.metal` 的逐行移植 |
| 对比度蒙版 RFC-024 | `contrast_mask.metal` 的逐行移植 |
| 胶片边缘 / 日期后背 RFC-031/032 | `overscan.cpp` + `overscan.metal` 的移植（片门、齿孔、雾、漏光、DX 码、七段/点阵字模） |
| 半格配对 | 两张 18×24 合成一格，片门按 19.00 mm 进片 |
| Cineon 数字中间片 RFC-028 | 10 位对数 DPX |
| 宽色域输出 | 16 位 TIFF + 合成 ICC（sRGB / P3 / Rec.2020 / ProPhoto） |
| 精修层 | 曝光、对比、高光、阴影、饱和、色温、色调、旋转翻转 |
| CLI 与 MCP | 与界面共用同一套参数模型与引擎桥接 |

## 构建与运行

见 `BUILD-WINDOWS.md`：工具链全部装在项目的 `tools/` 内（MinGW GCC 15.2、CMake、Vulkan
头文件与 glslang），不修改系统 PATH。

```powershell
node scripts/fetch-toolchain.js          # 下载工具链压缩包
powershell -ExecutionPolicy Bypass -File scripts/build-engine.ps1 -Jobs 8
npm install
npm start
```

打包：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
node scripts/package.js
```

## 已知边界

- 上游 Qt 桌面壳 `SpektraLab.exe` 未构建：需要独立 Qt 6 工具链，本应用的界面不依赖它。
- 上游 Windows 后端拒绝 `overscan`、`contrast_mask`、`scene_latitude`、半格与 Cineon DI；
  这些功能由本机管线实现，其中的边缘/日期后背可以叠加到引擎出的成片上。
- Chromium 的 GPU 进程在部分机器上无法启动，`--safe`（或 `安全模式启动.cmd`）会切到软件渲染。
