"use strict";

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const sharp = require("sharp");
const { EngineBridge, isRaw } = require("./engine");
const pipeline = require("./imaging/pipeline");
const dpx = require("./imaging/dpx");
const wideGamut = require("./imaging/wide-gamut");
const { SessionStore, atomicWrite } = require("./session-store");
const { sanitizeState } = require("./shared/params");

const APP_NAME = "几多筒菲林";
const projectRoot = path.resolve(__dirname, "..");
const media = new Map();
const STANDARD_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp"]);
const ALL_EXTENSIONS = new Set([...STANDARD_EXTENSIONS, ".arw", ".cr2", ".cr3", ".nef", ".dng", ".raf", ".orf", ".rw2"]);
let mainWindow = null;
let store = null;
let engine = null;
let settingsFile = null;
let settings = {};
const engineOutputs = new Map();

// Some Windows machines (VMs, remote sessions, locked-down GPU drivers, hybrid
// laptops whose driver refuses Chromium's GPU process) cannot start the GPU
// process at all: it exits with code 1 a few times and then Chromium aborts with
// "GPU process isn't usable. Goodbye." `disableHardwareAcceleration()` alone was
// not enough here — the sandboxed GPU helper still failed to launch — so safe
// mode also drops the GPU sandbox and pins ANGLE to SwiftShader.
const SAFE_MODE = process.argv.includes("--safe") || process.argv.includes("--disable-gpu") || process.env.JDTFL_SOFTWARE === "1";
if (SAFE_MODE) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("use-angle", "swiftshader");
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
  app.commandLine.appendSwitch("disable-features", "Vulkan,VaapiVideoDecoder");
}

// If the GPU process dies anyway, come back up in safe mode instead of showing
// a dead window. One automatic retry, then the flag is already on the command
// line and this handler stops firing.
app.on("child-process-gone", (_event, details) => {
  if (SAFE_MODE || !details || details.type !== "GPU") return;
  process.stderr.write(`GPU 进程退出（${details.reason}），以安全模式重启\n`);
  app.relaunch({ args: process.argv.slice(1).concat(["--safe"]) });
  app.exit(0);
});

protocol.registerSchemesAsPrivileged([
  { scheme: "media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch (_) {
    settings = { hostPath: "", resourcesPath: "", reducedMotion: false, libraryPaths: [] };
  }
  if (!Array.isArray(settings.libraryPaths)) settings.libraryPaths = [];
}

function saveSettings() {
  atomicWrite(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
}

function publicPhoto(record) {
  return {
    id: record.id,
    name: path.basename(record.path),
    path: record.path,
    extension: path.extname(record.path).toLowerCase(),
    size: record.size,
    modifiedAt: record.modifiedAt,
    raw: isRaw(record.path),
    previewable: STANDARD_EXTENSIONS.has(path.extname(record.path).toLowerCase()),
    url: `media://local/${record.id}`,
    width: record.width || 0,
    height: record.height || 0
  };
}

async function registerPhoto(filePath, options = {}) {
  const normalized = path.resolve(filePath);
  const extension = path.extname(normalized).toLowerCase();
  if (!ALL_EXTENSIONS.has(extension)) throw new Error(`不支持的文件类型：${extension || "无扩展名"}`);
  const stat = fs.statSync(normalized);
  if (!stat.isFile()) throw new Error("只能选择文件");
  for (const record of media.values()) {
    if (record.path === normalized) return publicPhoto(record);
  }
  const id = crypto.randomUUID();
  const record = {
    id,
    path: normalized,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString()
  };
  if (STANDARD_EXTENSIONS.has(extension)) {
    try {
      const metadata = await sharp(normalized, { limitInputPixels: 300000000 }).metadata();
      record.width = metadata.width || 0;
      record.height = metadata.height || 0;
    } catch (_) {
      record.previewError = "此文件无法由预览解码器读取";
    }
  }
  media.set(id, record);
  if (options.remember !== false && !settings.libraryPaths.includes(normalized)) {
    settings.libraryPaths.push(normalized);
    if (settings.libraryPaths.length > 200) settings.libraryPaths.splice(0, settings.libraryPaths.length - 200);
    saveSettings();
  }
  return publicPhoto(record);
}

async function registerPaths(paths, options = {}) {
  const accepted = [];
  const rejected = [];
  for (const filePath of paths || []) {
    try {
      accepted.push(await registerPhoto(filePath, options));
    } catch (error) {
      rejected.push({ path: filePath, error: error.message });
    }
  }
  return { accepted, rejected };
}

async function restoreLibrary() {
  const paths = settings.libraryPaths.filter((candidate) => fs.existsSync(candidate));
  settings.libraryPaths = paths;
  saveSettings();
  return registerPaths(paths, { remember: false });
}

function requirePhoto(id) {
  const record = media.get(id);
  if (!record) throw new Error("照片不在当前图库中");
  return record;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: "#111210",
    title: APP_NAME,
    icon: path.join(projectRoot, "assets", "icon.ico"),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#171816", symbolColor: "#ecebe5", height: 44 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.loadFile(path.join(projectRoot, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  if (process.argv.includes("--dev")) mainWindow.webContents.openDevTools({ mode: "detach" });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("did-finish-load", () => {
    if (!process.argv.includes("--capture")) return;
    // --capture-image <path> opens a real picture instead of the demo drawing,
    // so a capture shows what the pipeline actually renders.
    const index = process.argv.indexOf("--capture-image");
    const file = index > 0 ? process.argv[index + 1] : "";
    const delayIndex = process.argv.indexOf("--capture-delay");
    const delay = delayIndex > 0 ? Math.max(1000, Number(process.argv[delayIndex + 1]) || 0) : (file ? 5200 : 1800);
    if (file && fs.existsSync(file)) mainWindow.webContents.send("app:open", file);
    else mainWindow.webContents.send("app:demo");
    setTimeout(captureWindow, delay);
  });
}

async function captureWindow() {
  try {
    if (!mainWindow) return;
    // Inside an asar package `projectRoot` is the archive file, so write to userData.
    const directory = app.isPackaged
      ? path.join(app.getPath("userData"), "captures")
      : path.join(projectRoot, "captures");
    fs.mkdirSync(directory, { recursive: true });
    const image = await mainWindow.webContents.capturePage();
    fs.writeFileSync(path.join(directory, "workbench.png"), image.toPNG());
    process.stdout.write(`capture: ${path.join(directory, "workbench.png")}\n`);
  } catch (error) {
    process.stderr.write(`capture failed: ${error.message}\n`);
  } finally {
    app.quit();
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setName(APP_NAME);
    app.setAppUserModelId("cn.jiduotong.feilin");
    settingsFile = path.join(app.getPath("userData"), "settings.json");
    loadSettings();
    store = new SessionStore(path.join(app.getPath("userData"), "Edits"));
    engine = new EngineBridge({ userData: app.getPath("userData"), settings });

    protocol.handle("media", (request) => {
      const id = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ""));
      const record = media.get(id);
      if (!record) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(record.path).toString());
    });

    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => app.quit());

ipcMain.handle("prefs:get", () => ({ reducedMotion: Boolean(settings.reducedMotion) }));

ipcMain.handle("prefs:set", (_event, payload) => {
  const allowed = new Set(["reducedMotion"]);
  if (!payload || !allowed.has(payload.key)) throw new Error("不支持的偏好设置");
  settings[payload.key] = Boolean(payload.value);
  saveSettings();
  return { reducedMotion: Boolean(settings.reducedMotion) };
});

ipcMain.handle("library:open", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "导入底片或照片",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "照片与 RAW", extensions: [...ALL_EXTENSIONS].map((item) => item.slice(1)) },
      { name: "RAW", extensions: ["arw", "cr2", "cr3", "nef", "dng", "raf", "orf", "rw2"] },
      { name: "普通图像", extensions: ["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp"] }
    ]
  });
  if (result.canceled) return { accepted: [], rejected: [] };
  return registerPaths(result.filePaths);
});

ipcMain.handle("library:addPaths", (_event, paths) => registerPaths(paths));
ipcMain.handle("library:restore", () => restoreLibrary());

ipcMain.handle("session:save", (_event, payload) => {
  const record = requirePhoto(payload.photoId);
  const result = store.save(record, sanitizeState(payload.state));
  return { savedAt: result.document.updatedAt };
});

ipcMain.handle("session:load", (_event, photoId) => {
  return store.load(requirePhoto(photoId));
});

ipcMain.handle("engine:status", () => engine.resolve());

function existingFile(candidate) {
  return Boolean(candidate && typeof candidate === "string" && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function existingDirectory(candidate) {
  return Boolean(candidate && typeof candidate === "string" && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());
}

function isAsciiPath(candidate) {
  return String(candidate || "").split("").every((char) => char.charCodeAt(0) < 128);
}

function resourcesLookValid(directory) {
  try {
    const entries = fs.readdirSync(directory);
    return entries.includes("profiles") && entries.some((entry) => /constants|print_luts/.test(entry));
  } catch (_) {
    return false;
  }
}

// Breadth-first search with a shallow depth limit: enough to find
// build/windows/engine/{spk_raw_render.exe,resources} without walking a disk.
function searchEngine(root, maxDepth) {
  if (!root || !existingDirectory(root)) return null;
  const depth = maxDepth || 4;
  let frontier = [root];
  let host = "";
  let resources = "";
  for (let level = 0; level <= depth && frontier.length; level += 1) {
    const next = [];
    for (const directory of frontier) {
      let entries = [];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === "spk_raw_render.exe" && !host) host = full;
        if (entry.isDirectory() && entry.name.toLowerCase() === "resources" && resourcesLookValid(full) && !resources) resources = full;
        if (entry.isDirectory()) next.push(full);
      }
      if (host && resources) return { hostPath: host, resourcesPath: resources };
    }
    frontier = next.slice(0, 400);
  }
  return host && resources ? { hostPath: host, resourcesPath: resources } : null;
}

function detectionRoots() {
  const roots = [
    path.join(projectRoot, "build", "windows"),
    path.join(projectRoot, "build"),
    path.join(projectRoot, "vendor", "SpektraLab-1.3.3", "build", "windows"),
    path.join(projectRoot, "vendor", "SpektraLab-1.3.3")
  ];
  // A packaged copy keeps the engine beside the executable, not inside the asar.
  if (process.execPath) roots.push(path.dirname(process.execPath));
  if (app.isPackaged) roots.push(path.join(process.resourcesPath, "engine"));
  return roots;
}

function buildDiagnostics() {
  const resolved = engine.resolve();
  const rows = [
    {
      label: "引擎宿主 spk_raw_render.exe",
      ok: existingFile(resolved.hostPath),
      detail: resolved.hostPath || "未选择"
    },
    {
      label: "resources 目录（profiles + 常量）",
      ok: existingDirectory(resolved.resourcesPath) && resourcesLookValid(resolved.resourcesPath),
      detail: resolved.resourcesPath || "未选择"
    },
    {
      label: "resources 全路径仅含 ASCII",
      ok: isAsciiPath(resolved.resourcesPath),
      detail: isAsciiPath(resolved.resourcesPath) ? "符合要求" : "上游 Windows 引擎会拒绝非 ASCII 路径"
    },
    {
      label: "可用 RAW 渲染",
      ok: resolved.available,
      detail: resolved.available ? "可以运行光谱显影" : "仍需完整宿主与 resources"
    }
  ];
  return Object.assign({}, resolved, { rows });
}

ipcMain.handle("engine:diagnostics", () => buildDiagnostics());

ipcMain.handle("engine:autoDetect", () => {
  for (const root of detectionRoots()) {
    const found = searchEngine(root, 4);
    if (found) {
      settings.hostPath = found.hostPath;
      settings.resourcesPath = found.resourcesPath;
      saveSettings();
      engine.configure(settings);
      return Object.assign({ detected: true }, buildDiagnostics());
    }
  }
  return Object.assign({ detected: false }, buildDiagnostics());
});

ipcMain.handle("engine:importPackage", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择包含引擎宿主与 resources 的文件夹",
    properties: ["openDirectory"]
  });
  if (result.canceled || !result.filePaths.length) return Object.assign({ imported: false }, buildDiagnostics());
  const found = searchEngine(result.filePaths[0], 5);
  if (!found) throw new Error("该文件夹里没有找到 spk_raw_render.exe 与完整 resources");
  settings.hostPath = found.hostPath;
  settings.resourcesPath = found.resourcesPath;
  saveSettings();
  engine.configure(settings);
  return Object.assign({ imported: true }, buildDiagnostics());
});

ipcMain.handle("engine:build", async () => {
  const script = path.join(projectRoot, "scripts", "build-engine.ps1");
  if (!fs.existsSync(script)) throw new Error("构建脚本只存在于源码目录，打包版请用源码运行或手动构建");
  const output = await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true });
    let text = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("构建超过 20 分钟已停止"));
    }, 20 * 60 * 1000);
    child.stdout.on("data", (chunk) => { text += chunk.toString(); });
    child.stderr.on("data", (chunk) => { text += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output: text }); });
  });
  if (output.code === 0) {
    for (const root of detectionRoots()) {
      const found = searchEngine(root, 4);
      if (found) {
        settings.hostPath = found.hostPath;
        settings.resourcesPath = found.resourcesPath;
        saveSettings();
        engine.configure(settings);
        break;
      }
    }
  }
  return Object.assign({ code: output.code, output: output.output.slice(-8000) }, buildDiagnostics());
});

ipcMain.handle("engine:chooseHost", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 spk_raw_render.exe",
    properties: ["openFile"],
    filters: [{ name: "SpektraLab RAW host", extensions: ["exe"] }]
  });
  if (result.canceled) return engine.resolve();
  settings.hostPath = result.filePaths[0];
  saveSettings();
  engine.configure(settings);
  return engine.resolve();
});

ipcMain.handle("engine:chooseResources", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择完整 resources 目录",
    properties: ["openDirectory"]
  });
  if (result.canceled) return engine.resolve();
  settings.resourcesPath = result.filePaths[0];
  saveSettings();
  engine.configure(settings);
  return engine.resolve();
});

ipcMain.handle("engine:render", async (_event, payload) => {
  const record = requirePhoto(payload.photoId);
  const state = sanitizeState(payload.state);
  const result = await engine.renderRaw(record.path, state);
  engineOutputs.set(record.id, result.output);
  const previewPath = path.join(result.jobDirectory, "display.png");
  const notes = [];
  if (state.edge.active) {
    // The Windows host refuses `overscan`, so the rebate is added to the
    // developed frame here, from the same kernels the local pipeline uses.
    const edged = await pipeline.applyEdgeOnly(result.output, state, state.film.stock, 2200);
    await sharp(pipeline.toSrgb8(edged.rgb), { raw: { width: edged.width, height: edged.height, channels: 3 } })
      .png({ compressionLevel: 4 })
      .toFile(previewPath);
    notes.push(...edged.notes);
  } else {
    // The engine writes a 16-bit TIFF at the sensor's full size — 138 MB for a
    // 24 MP frame. The screen never needs more than a couple of thousand pixels,
    // and a full-size PNG took 62 MB and several seconds to encode.
    await sharp(result.output, { limitInputPixels: 300000000 })
      .resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .png({ compressionLevel: 4 })
      .toFile(previewPath);
  }
  if (state.contrastMask.active) notes.push("对比度蒙版未在上游引擎生效（Windows 后端拒绝该节点）");
  const preview = await registerPhoto(previewPath, { remember: false });
  return {
    preview,
    engineOutput: result.output,
    report: result.reportDocument,
    message: ["光谱渲染完成；预览由引擎 TIFF 转为 sRGB PNG 显示。", ...notes].join("\n")
  };
});

// --- the app's own imaging pipeline ---------------------------------------
// Film edge, date back, scene latitude, contrast mask, wide gamut and the
// Cineon DI all run here, in-process, so none of them depends on a GPU host.
function previewDirectory() {
  const dir = path.join(app.getPath("userData"), "previews");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A pair can hold two RAWs, and the composition runs through sharp, which has
// no RAW decoder. Any RAW half therefore goes through the spectral host first,
// exactly as a single RAW would; the result is cached per photo.
async function decodableSource(record, state) {
  if (!isRaw(record.path)) return record.path;
  const cached = record.id ? engineOutputs.get(record.id) : null;
  if (cached && fs.existsSync(cached)) return cached;
  const spectral = await engine.renderRaw(record.path, state);
  if (record.id) engineOutputs.set(record.id, spectral.output);
  return spectral.output;
}

async function renderLocally(record, state, maxEdge, partnerPath) {
  const pairing = Boolean(state.pair && state.pair.active && partnerPath && fs.existsSync(partnerPath));
  if (isRaw(record.path) && !pairing) {
    throw new Error("原生 RAW 需要 SpektraLab 引擎解码；请先「运行光谱显影」，或把它作为半格配对的一半。");
  }
  const input = pairing ? await decodableSource(record, state) : record.path;
  const secondary = pairing ? await decodableSource({ path: partnerPath, id: null }, state) : "";
  return pipeline.render({
    input,
    maxEdge,
    secondary,
    filmStock: state.film.stock,
    paperStock: state.print.paper,
    params: state
  });
}

ipcMain.handle("image:render", async (_event, payload) => {
  const record = requirePhoto(payload.photoId);
  const state = sanitizeState(payload.state);
  const maxEdge = Math.max(480, Math.min(3000, Number(payload.maxEdge) || 1400));
  // The media id is per-launch; the path saved with the session survives.
  const partner = (state.pair.partnerPath && fs.existsSync(state.pair.partnerPath))
    ? { path: state.pair.partnerPath }
    : (payload.partnerId ? media.get(payload.partnerId) : null);
  const result = await renderLocally(record, state, maxEdge, partner ? partner.path : "");
  const file = path.join(previewDirectory(), `render-${record.id.slice(0, 8)}-${Date.now()}.png`);
  await sharp(pipeline.toSrgb8(result.rgb), { raw: { width: result.width, height: result.height, channels: 3 } })
    .png({ compressionLevel: 6 })
    .toFile(file);
  const preview = await registerPhoto(file, { remember: false });
  return { preview, width: result.width, height: result.height, notes: result.notes };
});

ipcMain.handle("export:full", async (_event, payload) => {
  const record = requirePhoto(payload.photoId);
  const state = sanitizeState(payload.state);
  const output = state.output;
  const baseName = path.basename(record.path, path.extname(record.path));
  const isDi = Boolean(output.di);
  const extension = isDi ? "dpx" : output.format === "jpeg" ? "jpg" : output.format === "tiff" ? "tif" : "png";
  const result = await dialog.showSaveDialog(mainWindow, {
    title: isDi ? "导出 Cineon 数字中间片" : "导出成片",
    defaultPath: `${baseName}-几多筒菲林.${extension}`,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  const exportPartner = (state.pair && state.pair.active)
    ? ((state.pair.partnerPath && fs.existsSync(state.pair.partnerPath))
      ? { path: state.pair.partnerPath }
      : (state.pair.partnerId ? media.get(state.pair.partnerId) : null))
    : null;
  let rendered;
  if (isRaw(record.path) && !exportPartner) {
    // A RAW has already been through the spectral host; export what it
    // produced rather than refusing. The edge is added here if it is on.
    const spectral = payload.engineOutput || engineOutputs.get(record.id);
    if (!spectral || !fs.existsSync(spectral)) {
      throw new Error("这张 RAW 还没有光谱成片：请先「运行光谱显影」，再导出。");
    }
    if (state.edge.active) {
      const edged = await pipeline.applyEdgeOnly(spectral, state, state.film.stock, output.longEdge || 0);
      rendered = { rgb: edged.rgb, width: edged.width, height: edged.height, notes: edged.notes };
    } else {
      const decoded = await pipeline.decodeLinear(spectral, output.longEdge || 0, { adjust: state.adjust });
      rendered = { rgb: decoded.rgb, width: decoded.width, height: decoded.height, notes: [] };
    }
  } else {
    rendered = await renderLocally(record, state, output.longEdge || 3000, exportPartner ? exportPartner.path : "");
  }

  if (isDi) {
    const codes = pipeline.digitalIntermediate(rendered, state);
    const words = new Uint16Array(codes.length);
    for (let i = 0; i < codes.length; i += 1) words[i] = Math.min(1023, Math.max(0, Math.round(codes[i] * 1023)));
    const dpxBuffer = dpx.writeDpx({
      width: rendered.width,
      height: rendered.height,
      data: words,
      filename: path.basename(result.filePath)
    });
    fs.writeFileSync(result.filePath, dpxBuffer);
    return { canceled: false, path: result.filePath, width: rendered.width, height: rendered.height, notes: rendered.notes.concat(["Cineon 10 位对数编码已写入 DPX"]) };
  }

  if (output.format === "tiff" || output.bitDepth === 16 || output.colorSpace !== "srgb") {
    const space = output.bitDepth === 16 || output.colorSpace !== "srgb" ? output.colorSpace : "srgb";
    const { data, icc } = pipeline.toWideGamut(rendered.rgb, rendered.width, rendered.height, space);
    const tiff = wideGamut.writeTiff({ width: rendered.width, height: rendered.height, data, icc });
    fs.writeFileSync(result.filePath, tiff);
    return { canceled: false, path: result.filePath, width: rendered.width, height: rendered.height, notes: rendered.notes.concat([`16 位 ${space} TIFF，已内嵌 ICC`]) };
  }

  const bytes = pipeline.toSrgb8(rendered.rgb);
  const image = sharp(bytes, { raw: { width: rendered.width, height: rendered.height, channels: 3 } });
  if (output.format === "jpeg") await image.jpeg({ quality: output.quality || 90 }).toFile(result.filePath);
  else await image.png().toFile(result.filePath);
  return { canceled: false, path: result.filePath, width: rendered.width, height: rendered.height, notes: rendered.notes };
});

ipcMain.handle("export:preview", async (_event, payload) => {
  const options = payload.options || {};
  const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(payload.dataUrl || "");
  if (!match) throw new Error("导出数据无效");
  const extension = options.format === "jpeg" ? "jpg" : options.format === "tiff" ? "tif" : "png";
  const suggestedName = payload.suggestedName || `几多筒菲林-视觉预览.${extension}`;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出视觉预览（非光谱引擎成片）",
    defaultPath: suggestedName,
    filters: [{ name: options.format || "png", extensions: [extension] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const longEdge = Math.max(640, Math.min(12000, Number(options.longEdge) || 2560));
  let pipeline = sharp(Buffer.from(match[2], "base64"))
    .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb");
  if (extension === "jpg") pipeline = pipeline.jpeg({ quality: Math.max(1, Math.min(100, Number(options.quality) || 90)) });
  else if (extension === "tif") pipeline = pipeline.tiff({ compression: "none" });
  else pipeline = pipeline.png();
  const buffer = await pipeline.toBuffer();
  fs.writeFileSync(result.filePath, buffer, { flag: "wx" });
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("export:engine", async (_event, payload) => {
  const record = requirePhoto(payload.photoId);
  const source = engineOutputs.get(record.id);
  if (!source || !fs.existsSync(source)) throw new Error("没有可导出的光谱成片，请先运行光谱显影");
  const base = path.basename(record.path, path.extname(record.path));
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出光谱成片（16-bit TIFF，sRGB）",
    defaultPath: `${base}-光谱成片.tif`,
    filters: [{ name: "TIFF 16-bit", extensions: ["tif", "tiff"] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.copyFileSync(source, result.filePath, fs.constants.COPYFILE_EXCL);
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("app:reveal", async (_event, filePath) => {
  if (typeof filePath === "string" && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});
