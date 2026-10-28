"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { sanitizeState } = require("./shared/params");

function atomicWrite(filePath, contents) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.partial`
  );
  fs.writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, filePath);
}

class SessionStore {
  constructor(directory) {
    this.directory = directory;
  }

  keyFor(identity) {
    const source = typeof identity === "string" ? identity : identity.path;
    if (!source || typeof source !== "string") throw new Error("照片路径无效");
    return crypto.createHash("sha256").update(path.normalize(source).toLowerCase()).digest("hex");
  }

  fileFor(identity) {
    return path.join(this.directory, `${this.keyFor(identity)}.json`);
  }

  save(photo, state) {
    if (!photo || !photo.path) throw new Error("无法保存没有路径的照片");
    const document = {
      schema: "jiduo-tong-feilin/session",
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      photo: {
        path: photo.path,
        size: Number(photo.size) || 0,
        modifiedAt: photo.modifiedAt || null
      },
      state: sanitizeState(state)
    };
    const target = this.fileFor(photo.path);
    atomicWrite(target, `${JSON.stringify(document, null, 2)}\n`);
    return { file: target, document };
  }

  load(photo) {
    if (!photo || !photo.path) return null;
    const target = this.fileFor(photo.path);
    if (!fs.existsSync(target)) return null;
    let document;
    try {
      document = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (error) {
      throw new Error(`编辑记录无法读取，已保留原文件：${error.message}`);
    }
    if (!document || document.schema !== "jiduo-tong-feilin/session") {
      throw new Error("编辑记录格式不受支持，已保留原文件");
    }
    if (document.schemaVersion !== 1) {
      throw new Error(`编辑记录版本 ${document.schemaVersion} 不受支持`);
    }
    return {
      state: sanitizeState(document.state),
      savedAt: document.updatedAt,
      sourceChanged: Boolean(
        document.photo && Number(document.photo.size) &&
        Number(photo.size) && Number(document.photo.size) !== Number(photo.size)
      )
    };
  }
}

module.exports = { SessionStore, atomicWrite };
