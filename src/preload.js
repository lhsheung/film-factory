"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("darkroom", {
  openLibrary: () => ipcRenderer.invoke("library:open"),
  addPaths: (paths) => ipcRenderer.invoke("library:addPaths", paths),
  restoreLibrary: () => ipcRenderer.invoke("library:restore"),
  pathForFile: (file) => webUtils.getPathForFile(file),
  getPreferences: () => ipcRenderer.invoke("prefs:get"),
  setPreference: (key, value) => ipcRenderer.invoke("prefs:set", { key, value }),
  saveSession: (photoId, state) => ipcRenderer.invoke("session:save", { photoId, state }),
  loadSession: (photoId) => ipcRenderer.invoke("session:load", photoId),
  engineStatus: () => ipcRenderer.invoke("engine:status"),
  engineDiagnostics: () => ipcRenderer.invoke("engine:diagnostics"),
  autoDetectEngine: () => ipcRenderer.invoke("engine:autoDetect"),
  importEnginePackage: () => ipcRenderer.invoke("engine:importPackage"),
  buildEngine: () => ipcRenderer.invoke("engine:build"),
  chooseEngineHost: () => ipcRenderer.invoke("engine:chooseHost"),
  chooseEngineResources: () => ipcRenderer.invoke("engine:chooseResources"),
  renderWithEngine: (photoId, state) => ipcRenderer.invoke("engine:render", { photoId, state }),
  renderLocally: (photoId, state, maxEdge, partnerId) => ipcRenderer.invoke("image:render", { photoId, state, maxEdge, partnerId }),
  exportFull: (photoId, state, engineOutput) => ipcRenderer.invoke("export:full", { photoId, state, engineOutput }),
  exportPreview: (dataUrl, options, suggestedName) => ipcRenderer.invoke("export:preview", { dataUrl, options, suggestedName }),
  exportEngine: (photoId) => ipcRenderer.invoke("export:engine", { photoId }),
  reveal: (filePath) => ipcRenderer.invoke("app:reveal", filePath),
  onDemo: (callback) => ipcRenderer.on("app:demo", callback),
  onOpenPath: (callback) => ipcRenderer.on("app:open", (_event, filePath) => callback(filePath))
});
