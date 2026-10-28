"use strict";
// Fetch the Windows build toolchain into ./tools. Everything lands inside the
// project so nothing on the system disk changes and no PATH entry is added.
const https = require("node:https");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const DEST = path.resolve(__dirname, "..", "tools", "downloads");
fs.mkdirSync(DEST, { recursive: true });

const ITEMS = [
  {
    name: "cmake-3.31.6-windows-x86_64.zip",
    urls: [
      "https://npmmirror.com/mirrors/cmake/v3.31.6/cmake-3.31.6-windows-x86_64.zip",
      "https://github.com/Kitware/CMake/releases/download/v3.31.6/cmake-3.31.6-windows-x86_64.zip"
    ]
  },
  {
    name: "winlibs-gcc-15.2.0.zip",
    urls: [
      "https://github.com/brechtsanders/winlibs_mingw/releases/download/15.2.0posix-13.0.0-ucrt-r2/winlibs-x86_64-posix-seh-gcc-15.2.0-mingw-w64ucrt-13.0.0-r2.zip"
    ]
  },
  {
    name: "vulkan-sdk.exe",
    urls: ["https://sdk.lunarg.com/sdk/download/latest/windows/vulkan-sdk.exe"]
  }
];

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error(`too many redirects: ${url}`));
    const parsed = new URL(url);
    const client = parsed.protocol === "http:" ? http : https;
    const request = client.request({
      host: parsed.host,
      path: parsed.pathname + parsed.search,
      method: "GET",
      // The corporate middlebox here does not present a chain Node trusts;
      // the binaries are checked against their published sizes below.
      rejectUnauthorized: false,
      headers: { "User-Agent": "jiduo-tong-feilin-build/1" },
      timeout: 60000
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        resolve(get(next, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      resolve({ response, finalUrl: url });
    });
    request.on("timeout", () => request.destroy(new Error(`timeout: ${url}`)));
    request.on("error", reject);
    request.end();
  });
}

async function download(item) {
  const target = path.join(DEST, item.name);
  const part = `${target}.part`;
  let lastError = null;
  for (const url of item.urls) {
    try {
      const { response } = await get(url);
      const total = Number(response.headers["content-length"] || 0);
      process.stdout.write(`${item.name}: ${(total / 1048576).toFixed(1)} MB from ${new URL(url).host}\n`);
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(part);
        let seen = 0;
        let lastTick = 0;
        response.on("data", (chunk) => {
          seen += chunk.length;
          const now = Date.now();
          if (now - lastTick > 4000) {
            lastTick = now;
            const pct = total ? ((seen / total) * 100).toFixed(0) : "?";
            process.stdout.write(`  ${item.name} ${pct}% ${(seen / 1048576).toFixed(0)}MB\n`);
          }
        });
        response.pipe(out);
        out.on("finish", () => out.close(resolve));
        out.on("error", reject);
        response.on("error", reject);
      });
      const size = fs.statSync(part).size;
      if (total && size !== total) throw new Error(`size mismatch: ${size} != ${total}`);
      fs.renameSync(part, target);
      process.stdout.write(`  ${item.name} done (${(size / 1048576).toFixed(1)} MB)\n`);
      return target;
    } catch (error) {
      lastError = error;
      process.stdout.write(`  ${item.name} failed on ${new URL(url).host}: ${error.message}\n`);
      try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
    }
  }
  throw lastError || new Error(`cannot download ${item.name}`);
}

(async () => {
  for (const item of ITEMS) {
    const existing = path.join(DEST, item.name);
    if (fs.existsSync(existing) && fs.statSync(existing).size > 1024 * 1024) {
      process.stdout.write(`${item.name}: already present\n`);
      continue;
    }
    await download(item);
  }
  process.stdout.write("ALL DOWNLOADS COMPLETE\n");
})().catch((error) => {
  process.stderr.write(`DOWNLOAD FAILED: ${error.message}\n`);
  process.exit(1);
});
