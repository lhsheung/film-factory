"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { sanitizeState, validateForEngine, getFilm } = require("./shared/params");

const RAW_EXTENSIONS = new Set([".arw", ".cr2", ".cr3", ".nef", ".dng", ".raf", ".orf", ".rw2"]);

function isRaw(filePath) {
  return RAW_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function existingFile(candidate) {
  return Boolean(candidate && typeof candidate === "string" && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function existingDirectory(candidate) {
  return Boolean(candidate && typeof candidate === "string" && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());
}

// Source-first: when the app has no configured host, prefer the engine built
// from the vendored upstream source over asking the user for a stray binary.
const PROJECT_ROOT = path.resolve(__dirname, "..");
const LOCAL_BUILD_CANDIDATES = [
  {
    hostPath: path.join(PROJECT_ROOT, "build", "windows", "engine", "spk_raw_render.exe"),
    resourcesPath: path.join(PROJECT_ROOT, "build", "windows", "engine", "resources")
  },
  {
    hostPath: path.join(PROJECT_ROOT, "vendor", "SpektraLab-1.3.3", "build", "windows", "engine", "spk_raw_render.exe"),
    resourcesPath: path.join(PROJECT_ROOT, "vendor", "SpektraLab-1.3.3", "build", "windows", "engine", "resources")
  }
];

function isAscii(text) {
  return [...String(text || "")].every((char) => char.charCodeAt(0) < 128);
}

/** A writable root whose own path is pure ASCII, or null. */
function asciiEngineRoot() {
  const candidates = [
    process.env.ProgramData ? path.join(process.env.ProgramData, "jdtfl-engine") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "jdtfl-engine") : "",
    path.join(os.tmpdir(), "jdtfl-engine")
  ].filter(Boolean);
  return candidates.find((candidate) => isAscii(candidate)) || null;
}

/**
 * The upstream Windows host refuses any path that is not pure ASCII, so an app
 * installed under a Chinese folder name — `…\几多筒菲林-win32-x64\engine` — could
 * never run it. When the engine sits somewhere non-ASCII, mirror it once into an
 * ASCII directory and run from there.
 */
function materializeEngine(hostPath, resourcesPath) {
  if (isAscii(hostPath) && isAscii(resourcesPath)) return { hostPath, resourcesPath, relocated: false };
  const root = asciiEngineRoot();
  if (!root) {
    throw new Error(`引擎路径含非 ASCII 字符且找不到可写的中转目录：${resourcesPath}`);
  }
  const engineDir = path.join(root, "engine");
  const targetHost = path.join(engineDir, path.basename(hostPath));
  const targetResources = path.join(engineDir, "resources");
  const stamp = `${fs.statSync(hostPath).mtimeMs}-${fs.statSync(hostPath).size}`;
  const stampFile = path.join(engineDir, ".stamp");
  const current = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, "utf8").trim() : "";
  if (current !== stamp || !fs.existsSync(targetHost)) {
    fs.mkdirSync(engineDir, { recursive: true });
    for (const entry of fs.readdirSync(path.dirname(hostPath), { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(exe|dll)$/i.test(entry.name)) continue;
      fs.copyFileSync(path.join(path.dirname(hostPath), entry.name), path.join(engineDir, entry.name));
    }
    fs.cpSync(resourcesPath, targetResources, { recursive: true });
    fs.writeFileSync(stampFile, stamp);
  }
  return { hostPath: targetHost, resourcesPath: targetResources, relocated: true };
}

class EngineBridge {
  constructor(options) {
    this.userData = options.userData;
    this.settings = options.settings || {};
    this.projectRoot = options.projectRoot || PROJECT_ROOT;
  }

  // Where a source-built engine is expected: build/windows/engine next to the
  // app project root, inside the vendored upstream checkout, or shipped beside
  // the packaged executable.
  candidates() {
    const roots = [this.projectRoot, PROJECT_ROOT, path.join(PROJECT_ROOT, "vendor", "SpektraLab-1.3.3")];
    if (process.execPath) roots.push(path.dirname(process.execPath));
    if (process.resourcesPath) roots.push(process.resourcesPath);
    return roots.map((root) => ({
      hostPath: path.join(root, "build", "windows", "engine", "spk_raw_render.exe"),
      resourcesPath: path.join(root, "build", "windows", "engine", "resources")
    })).concat(roots.map((root) => ({
      hostPath: path.join(root, "engine", "spk_raw_render.exe"),
      resourcesPath: path.join(root, "engine", "resources")
    })));
  }

  configure(settings) {
    this.settings = Object.assign({}, this.settings, settings || {});
  }

  resolve() {
    let hostPath = this.settings.hostPath || process.env.SPEKTRALAB_RAW_HOST || "";
    let resourcesPath = this.settings.resourcesPath || process.env.SPEKTRALAB_ENGINE_RESOURCES || "";
    let source = hostPath || resourcesPath ? "设置" : "未配置";
    if (!(existingFile(hostPath) && existingDirectory(resourcesPath))) {
      const found = LOCAL_BUILD_CANDIDATES.find((candidate) => existingFile(candidate.hostPath) && existingDirectory(candidate.resourcesPath));
      if (found) {
        hostPath = found.hostPath;
        resourcesPath = found.resourcesPath;
        source = "源码构建";
      }
    }
    const available = existingFile(hostPath) && existingDirectory(resourcesPath);
    let relocated = false;
    let relocateError = "";
    if (available) {
      try {
        const placed = materializeEngine(hostPath, resourcesPath);
        hostPath = placed.hostPath;
        resourcesPath = placed.resourcesPath;
        relocated = placed.relocated;
      } catch (error) {
        relocateError = error.message;
      }
    }
    return {
      available,
      hostPath,
      resourcesPath,
      source,
      relocated,
      relocateError,
      reason: available
        ? (source === "源码构建"
          ? `已连接由上游源码构建的 Windows 引擎${relocated ? "（已镜像到 ASCII 目录）" : ""}`
          : `已连接 Windows 引擎宿主${relocated ? "（已镜像到 ASCII 目录）" : ""}`)
        : "未找到引擎：先用 scripts/build-engine.ps1 构建上游源码，或在设置中选择 spk_raw_render.exe 与完整 resources",
      capabilities: {
        available,
        tiff16: available,
        filmEdge: false,
        halfFrame: false,
        sceneLatitude: false,
        contrastMask: false,
        wideGamut: false
      }
    };
  }

  toEngineParams(state) {
    const safe = sanitizeState(state);
    const film = safe.film;
    const print = safe.print;
    const adjust = safe.adjust;
    const filmWidthMm = /^135/.test(film.format) || film.format === "xpan" ? 35 : 61.5;
    const printExposure = Math.min(20, Math.max(0.05, Math.pow(2, print.exposure)));
    const lensBlurUm = Math.min(200, Math.max(0, film.lensBlur * 40));
    // Upstream calls a reversal stock a direct scan (`scan_film`); the profile's
    // own `info.type` for those is "positive" (Velvia, Provia, Ektachrome…).
    const directScan = ["slide", "positive"].includes(getFilm(safe).type);
    const params = {
      // Names and ranges follow engine/src/core/params.cpp's verified schema table.
      film_stock: film.stock,
      print_stock: print.paper,
      exposure_compensation_ev: film.exposure,
      auto_exposure: film.autoExposure,
      auto_exposure_method: "center_weighted",
      film_format_mm: filmWidthMm,
      lens_blur_um: lensBlurUm,
      halation_active: film.halation > 0,
      halation_amount: film.halation * 2,
      grain_active: film.grain > 0,
      grain_amount: film.grain * 2,
      dir_couplers_active: true,
      dir_couplers_amount: 1,
      density_curve_gamma: 1,
      input_color_space: "ProPhoto RGB",
      input_cctf_decoding: false,
      geometry_crop_x: 0,
      geometry_crop_y: 0,
      geometry_crop_w: 1,
      geometry_crop_h: 1,
      geometry_rotation_deg: adjust.straighten,
      geometry_quarter_turns: Math.round(adjust.rotation / 90),
      geometry_flip_h: adjust.flipH,
      geometry_flip_v: adjust.flipV,
      print_exposure: printExposure,
      m_filter_shift: print.magenta / 100,
      y_filter_shift: print.yellow / 100,
      preflash_exposure: print.preFlash,
      glare_active: print.effects && film.glare > 0,
      glare_amount: film.glare * 30,
      // A reversal stock is scanned directly, and the native host refuses the
      // black/white correction on a direct scan ("not implemented by the native
      // engine"), so those two must follow the film type rather than always be on.
      scanner_white_correction: !directScan,
      scanner_black_correction: !directScan,
      scanner_lens_blur: 0,
      scan_film: directScan,
      extended_dynamic_range: false
    };
    return params;
  }

  buildArguments(input, output, report, paramsFile, resourcesPath) {
    return [
      "--input", input,
      "--output", output,
      "--report", report,
      "--resources", resourcesPath,
      "--params", paramsFile
    ];
  }

  async renderRaw(input, state) {
    const resolved = this.resolve();
    if (!resolved.available) throw new Error(resolved.reason);
    // `validateForEngine` lists what the *host* cannot do; the app handles
    // scene latitude, the contrast mask, the film edge and pairs itself, so
    // those notes must not stop a spectral render.
    this.lastNotes = validateForEngine(state, resolved.capabilities)
      .filter((line) => !/本机管线|自行处理|未连接/.test(line));
    if (!isRaw(input)) throw new Error("原生 RAW 宿主只接受 RAW 文件；普通图像需要 C ABI 像素输入适配器。");
    if (!fs.existsSync(input)) throw new Error("输入 RAW 不存在");
    if (!resolved.resourcesPath.split("").every((char) => char.charCodeAt(0) < 128)) {
      throw new Error("上游 Windows 引擎要求 resources 完整路径只包含 ASCII 字符");
    }

    // The upstream Windows host refuses any path that is not pure ASCII, and
    // `userData` is `…\AppData\Roaming\几多筒菲林` — the app's own name breaks it.
    // The engine's own directory has to be ASCII for the host to run at all, so
    // job files live beside it.
    const jobRoot = path.join(path.dirname(resolved.hostPath), "jobs");
    let jobDirectory = path.join(jobRoot, `${Date.now()}-${process.pid}`);
    try {
      fs.mkdirSync(jobDirectory, { recursive: true });
    } catch (_) {
      jobDirectory = path.join(os.tmpdir(), "jdtfl-renders", `${Date.now()}-${process.pid}`);
      fs.mkdirSync(jobDirectory, { recursive: true });
    }
    if (!jobDirectory.split("").every((char) => char.charCodeAt(0) < 128)) {
      throw new Error(`引擎要求作业目录只含 ASCII 字符；当前为 ${jobDirectory}。请把引擎放到纯英文字符的目录，例如 D:\\jdtfl-engine。`);
    }
    const output = path.join(jobDirectory, "print.tif");
    const report = path.join(jobDirectory, "print.json");
    const paramsFile = path.join(jobDirectory, "params.json");
    fs.writeFileSync(paramsFile, JSON.stringify(this.toEngineParams(state)), { flag: "wx" });
    const args = this.buildArguments(input, output, report, paramsFile, resolved.resourcesPath);

    await new Promise((resolve, reject) => {
      const child = spawn(resolved.hostPath, args, { windowsHide: true });
      let stderr = "";
      let stdout = "";
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("光谱渲染超时，进程已停止"));
      }, 120000);
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`引擎退出码 ${code}\n${(stderr || stdout).trim()}`.trim()));
      });
    });

    if (!fs.existsSync(output)) throw new Error("引擎未生成 TIFF 输出");
    let reportDocument = null;
    if (fs.existsSync(report)) reportDocument = JSON.parse(fs.readFileSync(report, "utf8"));
    return { output, report, reportDocument, jobDirectory };
  }
}

module.exports = { EngineBridge, isRaw, RAW_EXTENSIONS };
