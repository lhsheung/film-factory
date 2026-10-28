"use strict";
// Package the app for Windows and put the built engine beside the executable.
//
// electron-packager is driven through its JS API rather than the CLI string in
// package.json: the ignore patterns contain `|`, `^` and `$`, and every shell
// this project is built from mangles them differently.
const path = require("node:path");
const fs = require("node:fs");
const packagerModule = require("@electron/packager");
// v20 exports `{ packager }`; older builds exported the function directly.
const packager = typeof packagerModule === "function" ? packagerModule : packagerModule.packager;

const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.JDTFL_OUT || path.join(ROOT, "dist");

const IGNORE = [
  /^\/tools(\/|$)/,
  /^\/vendor(\/|$)/,
  /^\/build(\/|$)/,
  /^\/dist(\/|$)/,
  /^\/release(\/|$)/,
  /^\/captures(\/|$)/,
  /^\/tests(\/|$)/,
  /^\/_upstream(\/|$)/,
  /^\/_[^/]+\.(txt|log|png|js)$/,
  /^\/(test-results|capture-log)[^/]*\.txt$/,
  /^\/BUILD-WINDOWS\.md$/
];

// The engine is shipped as loose files next to the exe: it is a child process
// that needs its resources directory and its MinGW runtime DLLs on disk.
const ENGINE_FILES = ["spk_raw_render.exe", "spektrafilm_engine.dll", "libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll"];

function copyEngine(targetRoot) {
  const source = path.join(ROOT, "build", "windows", "engine");
  if (!fs.existsSync(path.join(source, "spk_raw_render.exe"))) {
    console.log("engine not built; packaging the app without it");
    return false;
  }
  const target = path.join(targetRoot, "engine");
  fs.mkdirSync(target, { recursive: true });
  for (const name of ENGINE_FILES) {
    const from = path.join(source, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(target, name));
  }
  fs.cpSync(path.join(source, "resources"), path.join(target, "resources"), { recursive: true });
  const shaders = path.join(source, "shaders");
  if (fs.existsSync(shaders)) fs.cpSync(shaders, path.join(target, "shaders"), { recursive: true });
  return true;
}

// Launchers, notice and licences belong beside the exe: GPL-3.0 and the film
// profiles' CC BY-SA 4.0 both require the notices to travel with the program.
function copyExtras(targetRoot) {
  const launchers = [
    ["启动.cmd", '@echo off\r\ncd /d "%~dp0"\r\nstart "" "%~dp0几多筒菲林.exe"\r\n'],
    ["安全模式启动.cmd", '@echo off\r\nrem 显卡驱动或远程桌面导致窗口闪退时用这个。\r\ncd /d "%~dp0"\r\nstart "" "%~dp0几多筒菲林.exe" --safe\r\n']
  ];
  for (const [name, body] of launchers) {
    fs.writeFileSync(path.join(targetRoot, name), body.replace(/\n/g, "\r\n"), "utf8");
  }
  for (const name of ["THIRD-PARTY-NOTICES.txt", "BUILD-WINDOWS.md"]) {
    const from = path.join(ROOT, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(targetRoot, name));
  }
  const licenses = path.join(ROOT, "licenses");
  if (fs.existsSync(licenses)) fs.cpSync(licenses, path.join(targetRoot, "licenses"), { recursive: true });
  const readme = [
    "几多筒菲林 — Windows 光谱胶片与暗房工作台",
    "",
    "启动：双击「启动.cmd」，或直接运行 几多筒菲林.exe。",
    "若窗口闪退（Chromium 的 GPU 进程无法启动），改用「安全模式启动.cmd」。",
    "",
    "RAW：选中 RAW 后会自动用引擎做 81 波长光谱显影（本机 RTX 4070，24MP 约 7-8 秒）。",
    "普通图像（TIFF/JPEG/PNG）：由本机成像管线显影，胶片/相纸使用上游实测密度曲线。",
    "",
    "引擎：engine\\spk_raw_render.exe + engine\\resources。移动本目录时请整套带走，",
    "包括 engine 下的 DLL 与 licenses 里的许可证。",
    "",
    "详细说明见 BUILD-WINDOWS.md。"
  ].join("\r\n");
  fs.writeFileSync(path.join(targetRoot, "使用说明.txt"), `${readme}\r\n`, "utf8");
}

(async () => {
  const built = await packager({
    dir: ROOT,
    name: "几多筒费林".replace("费", "菲"),
    platform: "win32",
    arch: "x64",
    out: OUT,
    overwrite: !process.env.JDTFL_OUT,
    icon: path.join(ROOT, "assets", "icon.ico"),
    ignore: IGNORE,
    prune: true,
    quiet: true,
    // sharp ships a prebuilt .node binary, and a native module cannot be
    // dlopen'd from inside an asar archive — the packaged app died on require
    // with a bare "Error" window. Loose files cost a little size and nothing else.
    asar: false,
    // GitHub is not reachable through this network's TLS middlebox; the
    // Electron zip comes from the same mirror `npm install` used.
    download: {
      mirrorOptions: {
        mirror: "https://npmmirror.com/mirrors/electron/",
        customDir: undefined
      }
    }
  });
  const target = built[0];
  const withEngine = copyEngine(target);
  copyExtras(target);
  const size = (dir) => {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      total += entry.isDirectory() ? size(full) : fs.statSync(full).size;
    }
    return total;
  };
  console.log(`packaged: ${target}`);
  console.log(`size: ${(size(target) / 1048576).toFixed(0)} MB`);
  console.log(withEngine ? "engine: copied next to the exe" : "engine: not included");
})().catch((error) => {
  console.error(`packaging failed: ${error.message}`);
  process.exit(1);
});
