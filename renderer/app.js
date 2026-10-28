"use strict";

const P = window.FilmParams;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clone = P.clone;

if (!window.darkroom) {
  window.darkroom = {
    openLibrary: async () => ({ accepted: [], rejected: [] }),
    addPaths: async () => ({ accepted: [], rejected: [] }),
    restoreLibrary: async () => ({ accepted: [], rejected: [] }),
    engineStatus: async () => ({ available: false, hostPath: "", resourcesPath: "", capabilities: {} }),
    engineDiagnostics: async () => ({ available: false, hostPath: "", resourcesPath: "", capabilities: {}, rows: [] }),
    autoDetectEngine: async () => ({ detected: false, available: false, capabilities: {}, rows: [] }),
    importEnginePackage: async () => { throw new Error("浏览器预览模式不支持导入引擎"); },
    buildEngine: async () => { throw new Error("浏览器预览模式不支持构建引擎"); },
    chooseEngineHost: async () => ({ available: false, capabilities: {} }),
    chooseEngineResources: async () => ({ available: false, capabilities: {} }),
    saveSession: async () => ({}), loadSession: async () => null,
    exportPreview: async (dataUrl) => {
      const anchor = document.createElement("a"); anchor.href = dataUrl; anchor.download = "几多筒菲林-视觉预览.png"; anchor.click();
      return { canceled: false };
    },
    exportEngine: async () => ({ canceled: true })
  };
}

const ui = {
  photos: [], selected: new Set(), currentId: null,
  state: P.createState(), histories: new Map(),
  engine: { available: false, capabilities: {} },
  activeTab: "film", compare: false, zoom: 1,
  interactionSnapshot: null, saveTimer: null, loadingToken: 0,
  rendering: false
};

function currentPhoto() { return ui.photos.find((photo) => photo.id === ui.currentId) || null; }
function historyFor(id) {
  if (!ui.histories.has(id)) ui.histories.set(id, { undo: [], redo: [] });
  return ui.histories.get(id);
}
function toast(message, kind = "info") {
  const element = document.createElement("div");
  element.className = `toast ${kind === "error" ? "error" : ""}`;
  element.textContent = message;
  $("#toast-region").appendChild(element);
  setTimeout(() => element.remove(), kind === "error" ? 6500 : 3400);
}
function formatBytes(bytes) {
  if (!bytes) return "界面演示";
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}
function displaySource(photo) { return photo && (photo.localPreview || photo.displayUrl || photo.url); }
function isSlide() { return P.getFilm(ui.state).type === "slide"; }

function fillSelect(selector, items) {
  $(selector).innerHTML = items.map((item) => `<option value="${item.id}">${item.name}</option>`).join("");
}
fillSelect("#film-stock", P.FILMS);
fillSelect("#print-paper", P.PAPERS);
fillSelect("#film-format", P.FORMATS.map((format) => ({ id: format.id, name: `${format.name} · ${format.gate}` })));

function getBound(path) {
  const [section, key] = path.split(".");
  return ui.state[section][key];
}
function setBound(path, value) {
  const [section, key] = path.split(".");
  ui.state[section][key] = value;
}
function formatOutput(path, value) {
  if (path === "film.whiteBalance") return `${Math.round(value)} K`;
  if (path === "edge.frameNumber") return String(Math.round(value)).padStart(2, "0");
  if (path === "output.longEdge") return `${Math.round(value)} px`;
  if (path === "output.quality") return `${Math.round(value)}`;
  if (/exposure|temperature|tint|contrast|brightness|highlights|shadows|saturation|yellow|magenta|straighten/.test(path)) {
    const digits = /exposure|straighten/.test(path) ? 1 : 0;
    return `${value > 0 ? "+" : ""}${Number(value).toFixed(digits)}`;
  }
  if (/grain|halation|glare|lensBlur|boost|preFlash|contrastMask|fog|leaks/.test(path)) return `${Math.round(value * (path === "film.boost" ? 50 : 100))}%`;
  return String(value);
}
function updateControls() {
  $$('[data-bind]').forEach((control) => {
    const path = control.dataset.bind;
    const value = getBound(path);
    if (control.type === "checkbox") control.checked = Boolean(value);
    else control.value = value;
    const output = control.parentElement.querySelector("output");
    if (output) output.value = formatOutput(path, value);
  });
  const film = P.getFilm(ui.state);
  const reversal = film.type === "positive" || film.type === "slide";
  $("#stock-note").textContent = `${film.family} · ${reversal ? "反转片直接扫描，不经过相纸" : "实测密度曲线 · 本机成像管线"}`;
  $$('[data-page="print"] input, [data-page="print"] select').forEach((control) => { control.disabled = reversal; });
  $('[data-page="print"]').style.opacity = reversal ? ".45" : "1";
  $$("#rotation-control button").forEach((button) => button.classList.toggle("active", Number(button.dataset.rotation) === ui.state.adjust.rotation));
  $$("#pair-orientation button").forEach((button) => button.classList.toggle("active", button.dataset.value === ui.state.pair.orientation));
  $("#flip-h").classList.toggle("active", ui.state.adjust.flipH);
  $("#flip-v").classList.toggle("active", ui.state.adjust.flipV);
  // The app writes wide-gamut files itself, so every space is available
  // whether or not a host is connected.
  $("#latitude-b-group").hidden = !ui.state.latitude.bActive;
  updateOverlays();
  updateHistoryButtons();
  updateExportState();
}

function previewFilter(adjustOnly = false) {
  const a = ui.state.adjust;
  let exposure = a.exposure;
  let contrast = a.contrast;
  let temperature = a.temperature;
  if (!adjustOnly) {
    exposure += ui.state.film.exposure * .45 + ui.state.print.exposure * .55;
    contrast += ui.state.print.contrast * .25;
    temperature += (ui.state.film.whiteBalance - 5500) / 100 + ui.state.film.tint * .15;
  }
  const brightness = Math.max(.08, Math.pow(2, exposure * .42));
  const contrastValue = Math.max(.2, 1 + contrast / 135);
  const saturation = Math.max(0, 1 + a.saturation / 100);
  const sepia = Math.min(.32, Math.abs(temperature) / 500);
  const hue = temperature >= 0 ? -8 : 12;
  const blur = adjustOnly ? 0 : ui.state.film.lensBlur * .65;
  return `brightness(${brightness}) contrast(${contrastValue}) saturate(${saturation}) sepia(${sepia}) hue-rotate(${hue}deg) blur(${blur}px)`;
}
function photoTransform() {
  const a = ui.state.adjust;
  return `rotate(${a.rotation + a.straighten}deg) scale(${a.flipH ? -1 : 1}, ${a.flipV ? -1 : 1})`;
}
function applyPreview() {
  const photo = currentPhoto();
  if (!photo || !displaySource(photo)) return;
  const local = Boolean(photo.localPreview);
  const image = $("#photo");
  // A RAW file has no decoder here: Chromium cannot read .RW2/.ARW, and the
  // 81-wavelength host is what decodes them. Say so instead of showing a
  // broken picture.
  const undecodable = Boolean(photo.raw) && !local && !photo.engineRendered;
  image.hidden = undecodable;
  if (local && image.getAttribute("src") !== photo.localPreview) image.src = photo.localPreview;
  image.style.filter = local ? "none" : previewFilter(Boolean(photo.engineRendered));
  image.style.transform = photoTransform();
  $("#photo-before").style.transform = photoTransform();
  $("#image-stack").style.transform = `scale(${ui.zoom})`;
  const badge = $("#preview-badge");
  badge.classList.toggle("engine", Boolean(photo.engineRendered) || local);
  $("#preview-badge-text").textContent = photo.engineRendered
    ? (photo.engineStale ? "上次光谱结果 · 参数已修改" : "光谱引擎结果 · sRGB 显示")
    : local
      ? `本机成像管线${photo.localSize ? ` · ${photo.localSize}` : ""}`
      : undecodable
        ? "原生 RAW · 需要连接光谱引擎解码"
        : "视觉预览 · 正在渲染";
}

function updateOverlays() {
  const edge = ui.state.edge;
  const photo = currentPhoto();
  // The real render draws the rebate, the imprints and the date back itself;
  // the CSS overlays are only the placeholder before it lands.
  const real = Boolean(photo && photo.localPreview);
  $("#edge-overlay").hidden = real || !edge.active;
  $("#edge-stock-print").textContent = edge.edgeText || P.getFilm(ui.state).name.toUpperCase();
  $("#edge-frame-number").textContent = String(Math.round(edge.frameNumber || 1)).padStart(2, "0");
  $("#date-imprint").hidden = real || !edge.dateActive;
  $("#date-imprint").textContent = edge.date.replaceAll("-", " ").slice(2);
  const pair = ui.state.pair;
  $("#pair-guide").hidden = real || !pair.active;
  $("#pair-guide").classList.toggle("vertical", pair.orientation === "vertical");
}

function updateHistoryButtons() {
  const history = historyFor(ui.currentId || "none");
  $("#undo-button").disabled = history.undo.length === 0;
  $("#redo-button").disabled = history.redo.length === 0;
}
function updateExportState() {
  const photo = currentPhoto();
  const hasDisplay = Boolean(photo && displaySource(photo));
  $("#export-button").disabled = !hasDisplay || ui.rendering;
  $("#compare-button").disabled = !hasDisplay;
  $("#engine-render-button").disabled = !photo || !photo.raw || !ui.engine.available || ui.rendering;
  $("#engine-render-button").title = !photo || !photo.raw ? "原生 RAW 宿主只处理 RAW 文件" : ui.engine.available ? "使用上游 Windows 引擎" : "请先在设置中连接引擎";
  const hasEnginePrint = Boolean(photo && photo.engineRendered && photo.engineOutput && !photo.engineStale);
  const engineButton = $("#export-engine-button");
  engineButton.hidden = !hasEnginePrint;
  engineButton.disabled = !hasEnginePrint || ui.rendering;
  if (photo && photo.engineStale) engineButton.textContent = "参数已修改 · 请重新显影";
}

function scheduleSave() {
  const photo = currentPhoto();
  if (!photo || photo.demo) return;
  clearTimeout(ui.saveTimer);
  $("#save-state").textContent = "正在保存…";
  ui.saveTimer = setTimeout(async () => {
    try {
      photo.state = clone(ui.state);
      const result = await window.darkroom.saveSession(photo.id, photo.state);
      $("#save-state").textContent = `已保存 ${new Date(result.savedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    } catch (error) {
      $("#save-state").textContent = "保存失败";
      toast(error.message, "error");
    }
  }, 650);
}
function markPhysicalDirty(path) {
  const photo = currentPhoto();
  if (photo && photo.engineRendered && /^(film|print)\./.test(path)) photo.engineStale = true;
}
function commitChange(path, value) {
  setBound(path, value);
  markPhysicalDirty(path);
  applyPreview();
  updateControls();
  scheduleSave();
  scheduleLocalRender();
}

// The preview the app shows is the pipeline's own output, debounced so a
// slider drag does not queue a render per pixel of travel.
ui.localTimer = null;
ui.localBusy = false;
ui.localPending = false;
ui.localToken = 0;

function scheduleLocalRender(delay) {
  const photo = currentPhoto();
  // A RAW on its own needs the spectral host; as one half of a pair the local
  // pipeline develops both halves through it and composes the strip.
  if (!photo || photo.demo || (photo.raw && !ui.state.pair.active)) return;
  clearTimeout(ui.localTimer);
  ui.localTimer = setTimeout(runLocalRender, delay === undefined ? 320 : delay);
}

async function runLocalRender() {
  const photo = currentPhoto();
  if (!photo || photo.demo || !window.darkroom.renderLocally) return;
  if (photo.raw && !ui.state.pair.active) return;
  if (ui.localBusy) { ui.localPending = true; return; }
  ui.localBusy = true;
  const token = ++ui.localToken;
  const state = clone(ui.state);
  try {
    const partner = state.pair.active && state.pair.partnerId ? state.pair.partnerId : "";
    const result = await window.darkroom.renderLocally(photo.id, state, 1400, partner);
    if (token !== ui.localToken) return;
    photo.localPreview = result.preview.url;
    photo.localSize = `${result.width}×${result.height}`;
    photo.localNotes = result.notes || [];
    $("#stock-note").textContent = photo.localNotes.length
      ? photo.localNotes.join(" · ")
      : `${P.getFilm(state).family} · 实测密度曲线`;
    applyPreview();
    updateOverlays();
  } catch (error) {
    if (token !== ui.localToken) return;
    photo.localPreview = null;
    toast(`本机渲染失败：${error.message}`, "error");
    applyPreview();
  } finally {
    ui.localBusy = false;
    if (ui.localPending) { ui.localPending = false; scheduleLocalRender(80); }
  }
}
function pushHistory(snapshot) {
  const history = historyFor(ui.currentId || "none");
  if (!snapshot || JSON.stringify(snapshot) === JSON.stringify(ui.state)) return;
  history.undo.push(snapshot);
  if (history.undo.length > 64) history.undo.shift();
  history.redo = [];
  updateHistoryButtons();
}

$$('[data-bind]').forEach((control) => {
  const begin = () => { if (!ui.interactionSnapshot) ui.interactionSnapshot = clone(ui.state); };
  control.addEventListener("pointerdown", begin);
  control.addEventListener("focus", begin);
  control.addEventListener("input", () => {
    begin();
    const value = control.type === "checkbox" ? control.checked : control.type === "range" ? Number(control.value) : control.value;
    commitChange(control.dataset.bind, value);
  });
  control.addEventListener("change", () => {
    pushHistory(ui.interactionSnapshot);
    ui.interactionSnapshot = null;
  });
  control.addEventListener("blur", () => {
    if (ui.interactionSnapshot) pushHistory(ui.interactionSnapshot);
    ui.interactionSnapshot = null;
  });
});

function mutate(path, value) {
  const snapshot = clone(ui.state);
  commitChange(path, value);
  pushHistory(snapshot);
}
function undo() {
  const history = historyFor(ui.currentId || "none");
  if (!history.undo.length) return;
  history.redo.push(clone(ui.state));
  ui.state = history.undo.pop();
  updateControls(); applyPreview(); scheduleSave();
}
function redo() {
  const history = historyFor(ui.currentId || "none");
  if (!history.redo.length) return;
  history.undo.push(clone(ui.state));
  ui.state = history.redo.pop();
  updateControls(); applyPreview(); scheduleSave();
}
$("#undo-button").addEventListener("click", undo);
$("#redo-button").addEventListener("click", redo);

$$('.reset-section').forEach((button) => button.addEventListener("click", () => {
  const section = button.dataset.section;
  const snapshot = clone(ui.state);
  ui.state[section] = clone(P.DEFAULTS[section]);
  const photo = currentPhoto(); if (photo) photo.engineStale = Boolean(photo.engineRendered);
  updateControls(); applyPreview(); pushHistory(snapshot); scheduleSave();
}));
$$('#rotation-control button').forEach((button) => button.addEventListener("click", () => mutate("adjust.rotation", Number(button.dataset.rotation))));
$("#flip-h").addEventListener("click", () => mutate("adjust.flipH", !ui.state.adjust.flipH));
$("#flip-v").addEventListener("click", () => mutate("adjust.flipV", !ui.state.adjust.flipV));
$$('#pair-orientation button').forEach((button) => button.addEventListener("click", () => mutate("pair.orientation", button.dataset.value)));
$("#pair-slot-a").addEventListener("click", () => { $("#pair-slot-a").classList.add("selected"); $("#pair-slot-b").classList.remove("selected"); mutate("pair.slot", "A"); });
$("#pair-slot-b").addEventListener("click", () => { $("#pair-slot-b").classList.add("selected"); $("#pair-slot-a").classList.remove("selected"); mutate("pair.slot", "B"); });

function openTab(tab) {
  const actual = tab === "pair" ? "pair" : tab;
  ui.activeTab = actual;
  $$('[data-tab]').forEach((button) => button.classList.toggle("active", button.dataset.tab === actual));
  $$('[data-page]').forEach((page) => page.classList.toggle("active", page.dataset.page === actual));
  $$('[data-open-tab]').forEach((button) => button.classList.toggle("active", button.dataset.openTab === actual || (actual === "print" && button.dataset.openTab === "film")));
}
$$('[data-tab]').forEach((button) => button.addEventListener("click", () => openTab(button.dataset.tab)));
$$('[data-open-tab]').forEach((button) => button.addEventListener("click", () => openTab(button.dataset.openTab)));

function renderLibrary() {
  const query = $("#library-search").value.trim().toLowerCase();
  const visible = ui.photos.filter((photo) => photo.name.toLowerCase().includes(query));
  $("#photo-count").textContent = ui.photos.length;
  $("#library-empty").hidden = ui.photos.length > 0;
  $$('.photo-item', $("#photo-list")).forEach((element) => element.remove());
  visible.forEach((photo) => {
    const item = document.createElement("div");
    item.className = `photo-item ${photo.id === ui.currentId ? "current" : ""} ${ui.selected.has(photo.id) ? "selected" : ""}`;
    item.dataset.id = photo.id;
    const media = photo.previewable || photo.displayUrl
      ? `<img class="photo-thumb" src="${displaySource(photo)}" alt="">`
      : `<div class="photo-thumb raw-thumb">${photo.extension.replace(".", "").toUpperCase()}</div>`;
    item.innerHTML = `${media}<div class="photo-meta"><strong>${photo.name}</strong><small>${formatBytes(photo.size)}${photo.engineRendered ? " · 已显影" : ""}</small></div>`;
    item.addEventListener("click", (event) => selectPhoto(photo.id, event.ctrlKey || event.metaKey));
    $("#photo-list").appendChild(item);
  });
  $("#selection-tools").hidden = ui.selected.size < 2;
  $("#selection-count").textContent = `已选 ${ui.selected.size} 张`;
  renderFilmstrip();
}
function renderFilmstrip() {
  $$('.strip-item', $("#filmstrip")).forEach((element) => element.remove());
  ui.photos.forEach((photo) => {
    const item = document.createElement("button");
    item.className = `strip-item ${photo.id === ui.currentId ? "current" : ""} ${ui.selected.has(photo.id) ? "selected" : ""}`;
    item.title = photo.name;
    item.innerHTML = photo.previewable || photo.displayUrl
      ? `<img src="${displaySource(photo)}" alt="${photo.name}">`
      : `<div class="strip-raw">${photo.extension.replace(".", "").toUpperCase()}</div>`;
    item.addEventListener("click", (event) => selectPhoto(photo.id, event.ctrlKey || event.metaKey));
    $("#filmstrip").insertBefore(item, $("#strip-add"));
  });
}

function showEmpty(title, description) {
  $("#drop-zone").hidden = false;
  $("#canvas-wrap").hidden = true;
  $("#preview-badge").hidden = true;
  $("#drop-zone h1").textContent = title;
  $("#drop-zone p").textContent = description;
}
function showPhoto() {
  const photo = currentPhoto();
  $("#document-name").textContent = photo ? photo.name : "未打开底片";
  $("#save-state").textContent = photo ? (photo.demo ? "内置界面演示" : "正在读取编辑记录…") : "本地工作区";
  if (!photo) return showEmpty("把一筒菲林放上灯箱", "导入 RAW 开始光谱显影，或先用普通照片熟悉工作台。");
  const source = displaySource(photo);
  if (!source) return showEmpty("RAW 已放入底片夹", "连接 SpektraLab Windows 引擎后，在“输出”页运行光谱显影。");
  $("#drop-zone").hidden = true;
  $("#canvas-wrap").hidden = false;
  $("#preview-badge").hidden = false;
  ui.zoom = 1; $("#zoom-label").textContent = "适合";
  const image = $("#photo");
  image.src = source;
  $("#photo-before").src = source;
  image.onload = () => { applyPreview(); };
  $("#compare-button").classList.remove("active");
  ui.compare = false; $("#photo-before").hidden = true; $("#split-line").hidden = true;
  applyPreview();
}

async function selectPhoto(id, additive = false) {
  const photo = ui.photos.find((item) => item.id === id);
  if (!photo) return;
  if (additive) {
    if (ui.selected.has(id) && id !== ui.currentId) ui.selected.delete(id);
    else ui.selected.add(id);
    renderLibrary();
    return;
  }
  ui.selected = new Set([id]);
  ui.currentId = id;
  ui.interactionSnapshot = null;
  const token = ++ui.loadingToken;
  ui.state = photo.state ? clone(photo.state) : P.createState();
  renderLibrary(); showPhoto(); updateControls();
  if (!photo.demo) {
    try {
      const saved = await window.darkroom.loadSession(id);
      if (token !== ui.loadingToken || ui.currentId !== id) return;
      if (saved) {
        ui.state = saved.state; photo.state = clone(saved.state);
        $("#save-state").textContent = saved.sourceChanged ? "源文件已变化 · 请检查" : "已恢复编辑记录";
        if (saved.sourceChanged) toast("源文件大小与上次编辑时不同，请检查照片。", "error");
      } else $("#save-state").textContent = "新编辑会话";
      updateControls(); applyPreview();
    } catch (error) {
      $("#save-state").textContent = "编辑记录未载入";
      toast(error.message, "error");
    }
    scheduleLocalRender(40);
    // A RAW has no decoder of its own: with an engine connected, selecting one
    // is the request to develop it. Slider changes still wait for the button.
    if (photo.raw && ui.engine.available && !ui.state.pair.active) runEngineRender(photo);
    else scheduleLocalRender(40);
  }
}

async function importPhotos() {
  try {
    const result = await window.darkroom.openLibrary();
    await acceptImported(result);
  } catch (error) { toast(error.message, "error"); }
}
async function acceptImported(result) {
  const accepted = result.accepted || [];
  for (const photo of accepted) {
    if (ui.photos.some((item) => item.path && item.path === photo.path)) continue;
    ui.photos.push(photo);
  }
  if (result.rejected && result.rejected.length) toast(result.rejected.map((item) => item.error).join("\n"), "error");
  if (accepted.length) {
    renderLibrary();
    await selectPhoto(accepted[accepted.length - 1].id);
    toast(`已导入 ${accepted.length} 张照片`);
  }
}
$("#import-button").addEventListener("click", importPhotos);
$("#empty-import").addEventListener("click", importPhotos);
$("#strip-add").addEventListener("click", importPhotos);
$("#library-search").addEventListener("input", renderLibrary);

function loadDemo() {
  let demo = ui.photos.find((photo) => photo.id === "demo");
  if (!demo) {
    demo = { id: "demo", name: "界面演示 · 湖光.svg", path: "", url: "../assets/demo.svg", extension: ".svg", size: 0, raw: false, previewable: true, demo: true };
    ui.photos.push(demo);
  }
  selectPhoto("demo");
  ui.state.film.halation = .7;
  ui.state.edge.active = false;
  updateControls(); applyPreview();
}
$("#demo-button").addEventListener("click", loadDemo);
if (window.darkroom.onDemo) window.darkroom.onDemo(loadDemo);
if (window.darkroom.onOpenPath) {
  window.darkroom.onOpenPath(async (filePath) => {
    try {
      const result = await window.darkroom.addPaths([filePath]);
      await acceptImported(result);
      // Library restore may have selected something else while this was in
      // flight; the file the user opened is the one they asked to see.
      if (result.accepted && result.accepted.length) await selectPhoto(result.accepted[result.accepted.length - 1].id);
    } catch (error) {
      toast(`打开失败：${error.message}`, "error");
    }
  });
}

$("#sync-button").addEventListener("click", async () => {
  const source = currentPhoto();
  if (!source || ui.selected.size < 2) return;
  const recipients = ui.photos.filter((photo) => ui.selected.has(photo.id) && photo.id !== source.id);
  for (const recipient of recipients) {
    const previous = recipient.state || P.createState();
    const next = clone(ui.state);
    next.adjust.rotation = previous.adjust.rotation;
    next.adjust.straighten = previous.adjust.straighten;
    next.adjust.flipH = previous.adjust.flipH;
    next.adjust.flipV = previous.adjust.flipV;
    recipient.state = next;
    if (!recipient.demo) await window.darkroom.saveSession(recipient.id, next);
  }
  toast(`已同步到 ${recipients.length} 张照片，保留各自几何调整`);
});

$("#make-pair").addEventListener("click", () => {
  if (ui.selected.size !== 2) return toast("请先用 Ctrl 单击选择恰好两张照片", "error");
  const partner = ui.photos.find((photo) => ui.selected.has(photo.id) && photo.id !== ui.currentId);
  mutate("pair.partnerId", partner ? partner.id : null);
  mutate("pair.partnerPath", partner ? partner.path : "");
  mutate("pair.active", true);
  toast(partner ? `已与「${partner.name}」建立半格配对` : "已建立半格配对");
});

$("#compare-button").addEventListener("click", () => {
  ui.compare = !ui.compare;
  $("#compare-button").classList.toggle("active", ui.compare);
  $("#photo-before").hidden = !ui.compare;
  $("#split-line").hidden = !ui.compare;
});
function setZoom(value, label) {
  ui.zoom = Math.max(.2, Math.min(8, value));
  $("#zoom-label").textContent = label || `${Math.round(ui.zoom * 100)}%`;
  applyPreview();
}
$("#fit-button").addEventListener("click", () => setZoom(1, "适合"));
$("#zoom-in").addEventListener("click", () => setZoom(ui.zoom * 1.2));
$("#zoom-out").addEventListener("click", () => setZoom(ui.zoom / 1.2));
$("#actual-button").addEventListener("click", () => {
  const image = $("#photo");
  if (!image.naturalWidth) return;
  setZoom(image.naturalWidth / Math.max(1, image.clientWidth), "100%");
});

async function readEngineDiagnostics() {
  if (window.darkroom.engineDiagnostics) return window.darkroom.engineDiagnostics();
  return window.darkroom.engineStatus();
}

function renderDiagnostics(rows) {
  const list = $("#diagnostic-list");
  if (!rows || !rows.length) { list.innerHTML = ""; return; }
  list.innerHTML = rows.map((row) => `
    <div class="diagnostic-item ${row.ok ? "ok" : "warn"}">
      <span class="diagnostic-mark" aria-hidden="true"><svg><use href="#${row.ok ? "i-check" : "i-close"}"/></svg></span>
      <span class="diagnostic-text"><strong>${row.label}</strong><small>${row.detail || ""}</small></span>
    </div>`).join("");
}

function refreshEngine(snapshot) {
  const ready = Boolean(snapshot && snapshot.available);
  ui.engine = snapshot || { available: false, capabilities: {} };
  $("#engine-pill").classList.toggle("engine-ready", ready);
  $("#engine-card").classList.toggle("engine-ready", ready);
  $("#engine-pill-text").textContent = ready ? "光谱引擎已连接" : "光谱引擎未连接";
  $("#engine-card-title").textContent = ready ? "光谱引擎已连接" : "光谱引擎未连接";
  $("#engine-card-detail").textContent = ready ? "RAW 物理显影可用" : "界面与视觉预览可用";
  $("#output-engine-title").textContent = ready ? "光谱引擎已连接" : "光谱引擎未连接";
  $("#output-engine-copy").textContent = ready ? "RAW 可运行物理显影；高级能力仍按后端能力表拒绝。" : "可导出视觉预览，物理显影需连接引擎。";
  $("#host-path").textContent = ui.engine.hostPath || "未选择引擎宿主";
  $("#resources-path").textContent = ui.engine.resourcesPath || "未选择资源目录";

  const banner = $("#engine-banner");
  banner.classList.toggle("engine-ready", ready);
  $("#engine-banner-text").textContent = ready
    ? "引擎已就绪 · RAW 可以运行 81 波长光谱显影"
    : "引擎未连接 · 视觉预览可用，物理显影需宿主与 resources";

  renderDiagnostics(snapshot && snapshot.rows);

  const caps = (snapshot && snapshot.capabilities) || {};
  const rows = [
    ["场景宽容度 · RFC-023", true],
    ["对比度蒙版 · RFC-024", true],
    ["胶片边缘 / 日期后背 · RFC-031/032", true],
    ["半格配对 · 19.00 mm", true],
    ["16 位宽色域 TIFF + ICC", true],
    ["Cineon 数字中间片 · 10 位 DPX", true],
    ["81 波长光谱积分", caps.tiff16],
    ["引擎原生 RAW 解码", caps.tiff16]
  ];
  $("#capability-list").innerHTML = rows.map(([name, supported]) => `<div class="capability-item"><span>${name}</span><span class="tag">${supported ? "可用" : "需引擎"}</span></div>`).join("");
  updateControls();
  updateExportState();
}

async function loadEngineSnapshot(fallbackMessage) {
  try {
    return await readEngineDiagnostics();
  } catch (error) {
    refreshEngine({ available: false, capabilities: {}, reason: error.message, rows: [] });
    if (fallbackMessage) toast(fallbackMessage, "error");
    return null;
  }
}

function setEngineBusy(busy, label) {
  for (const id of ["#engine-autodetect", "#engine-import", "#engine-build"]) $(id).disabled = busy;
  $("#engine-action-hint").textContent = busy ? label : "自动检测会查找源码目录下的 build\\windows；导入可以选中任意含 spk_raw_render.exe 与 resources 的文件夹。";
}

function showBuildLog(text) {
  const log = $("#build-log");
  if (!text) { log.hidden = true; log.textContent = ""; return; }
  log.hidden = false;
  log.textContent = text;
  log.scrollTop = log.scrollHeight;
}

async function openSettings() {
  showBuildLog("");
  const snapshot = await loadEngineSnapshot("读取引擎状态失败");
  if (snapshot) refreshEngine(snapshot);
  $("#settings-dialog").showModal();
}
$("#engine-pill").addEventListener("click", openSettings);
$("#engine-card").addEventListener("click", openSettings);

$("#engine-autodetect").addEventListener("click", async () => {
  setEngineBusy(true, "正在扫描源码构建目录…");
  try {
    const snapshot = await window.darkroom.autoDetectEngine();
    refreshEngine(snapshot);
    toast(snapshot.detected ? "已找到并连接引擎。" : "没有在源码目录里找到构建产物，可改用「导入引擎文件夹」或「用源码构建」。", snapshot.detected ? "info" : "error");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setEngineBusy(false);
  }
});

$("#engine-import").addEventListener("click", async () => {
  setEngineBusy(true, "请选择包含 spk_raw_render.exe 与 resources 的文件夹…");
  try {
    const snapshot = await window.darkroom.importEnginePackage();
    refreshEngine(snapshot);
    toast(snapshot.imported ? "引擎已导入并连接。" : "已取消导入。");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setEngineBusy(false);
  }
});

$("#engine-build").addEventListener("click", async () => {
  setEngineBusy(true, "正在用源码构建引擎，首次构建需要较长时间…");
  showBuildLog("构建已启动（最长 20 分钟），输出会在结束后显示在这里。\n");
  try {
    const snapshot = await window.darkroom.buildEngine();
    refreshEngine(snapshot);
    showBuildLog((snapshot.output || "").trim() || "构建结束，但没有捕获到输出。");
    if (snapshot.code === 0) toast(snapshot.available ? "构建完成，引擎已连接。" : "构建结束，但未自动找到产物，请点「自动检测」或手动指定路径。");
    else toast(`构建退出码 ${snapshot.code}，请查看下方日志。`, "error");
  } catch (error) {
    toast(error.message, "error");
    showBuildLog(error.message);
  } finally {
    setEngineBusy(false);
  }
});

$("#choose-host").addEventListener("click", async () => {
  try { refreshEngine(await window.darkroom.chooseEngineHost()); }
  catch (error) { toast(error.message, "error"); }
});
$("#choose-resources").addEventListener("click", async () => {
  try { refreshEngine(await window.darkroom.chooseEngineResources()); }
  catch (error) { toast(error.message, "error"); }
});
$("#reduced-motion").addEventListener("change", async (event) => {
  document.body.classList.toggle("reduce-motion", event.target.checked);
  try { await window.darkroom.setPreference("reducedMotion", event.target.checked); }
  catch (error) { toast(error.message, "error"); }
});

async function applyPreferences() {
  try {
    const preferences = await window.darkroom.getPreferences();
    document.body.classList.toggle("reduce-motion", Boolean(preferences.reducedMotion));
    $("#reduced-motion").checked = Boolean(preferences.reducedMotion);
  } catch (_) { /* 偏好不可用时沿用系统设置 */ }
}

async function runEngineRender(photo) {
  if (!photo || ui.rendering || !ui.engine.available) return;
  ui.rendering = true;
  $("#render-progress").hidden = false;
  updateExportState();
  try {
    const result = await window.darkroom.renderWithEngine(photo.id, ui.state);
    photo.displayUrl = result.preview.url;
    photo.engineRendered = true;
    photo.engineStale = false;
    photo.engineOutput = result.engineOutput;
    showPhoto(); renderLibrary();
    toast(result.message || "光谱显影完成");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    ui.rendering = false;
    $("#render-progress").hidden = true;
    updateExportState();
  }
}

$("#engine-render-button").addEventListener("click", () => runEngineRender(currentPhoto()));

$("#export-button").addEventListener("click", async () => {
  const photo = currentPhoto();
  if (!photo || photo.demo) return toast("演示画面不能导出，请导入一张照片。", "error");
  const button = $("#export-button");
  button.disabled = true;
  button.textContent = "正在渲染…";
  try {
    // The export always re-renders at the output size: the on-screen preview is
    // a 1400 px proxy, and scaling that up would throw away the pipeline's work.
    const result = await window.darkroom.exportFull(photo.id, ui.state, photo.engineOutput || "");
    if (!result.canceled) {
      toast(`已导出 ${result.width}×${result.height}：${result.path}${result.notes && result.notes.length ? `\n${result.notes.join("\n")}` : ""}`);
    }
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "导出成片";
    updateExportState();
  }
});

$("#export-engine-button").addEventListener("click", async () => {
  const photo = currentPhoto();
  if (!photo || !photo.engineOutput) return;
  if (photo.engineStale) return toast("显影参数已修改，请先重新运行光谱显影。", "error");
  try {
    const result = await window.darkroom.exportEngine(photo.id);
    if (!result.canceled) toast(`已导出 16-bit 光谱成片：${result.filePath}`);
  } catch (error) { toast(error.message, "error"); }
});

const viewport = $("#viewport");
["dragenter", "dragover"].forEach((name) => viewport.addEventListener(name, (event) => { event.preventDefault(); viewport.classList.add("drag-over"); }));
["dragleave", "drop"].forEach((name) => viewport.addEventListener(name, (event) => { event.preventDefault(); viewport.classList.remove("drag-over"); }));
viewport.addEventListener("drop", async (event) => {
  const files = [...event.dataTransfer.files];
  if (!files.length || !window.darkroom.pathForFile) return;
  const paths = files.map((file) => window.darkroom.pathForFile(file)).filter(Boolean);
  try { await acceptImported(await window.darkroom.addPaths(paths)); }
  catch (error) { toast(error.message, "error"); }
});

document.addEventListener("keydown", (event) => {
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === "o") { event.preventDefault(); importPhotos(); }
  if (modifier && event.key.toLowerCase() === "z" && !event.shiftKey) { event.preventDefault(); undo(); }
  if (modifier && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))) { event.preventDefault(); redo(); }
  if (modifier && event.key === "0") { event.preventDefault(); setZoom(1, "适合"); }
  if (modifier && event.key === "1") { event.preventDefault(); $("#actual-button").click(); }
  if (modifier && event.key.toLowerCase() === "e") { event.preventDefault(); openTab("output"); }
});

(async function restoreLibrary() {
  try {
    const restored = await window.darkroom.restoreLibrary();
    if (restored && restored.accepted && restored.accepted.length) {
      // A file can be registered twice across restarts (restore + an explicit
      // open); the library shows each path once.
      for (const photo of restored.accepted) {
        if (ui.photos.some((item) => item.path && item.path === photo.path)) continue;
        ui.photos.push(photo);
      }
      renderLibrary();
      if (!ui.currentId) await selectPhoto(restored.accepted[restored.accepted.length - 1].id);
    }
  } catch (error) {
    toast(`图库未能恢复：${error.message}`, "error");
  }
})();
updateControls();
renderLibrary();
(async function bootstrapEngine() {
  const snapshot = await loadEngineSnapshot();
  if (!snapshot) return;
  if (!snapshot.available && window.darkroom.autoDetectEngine) {
    // 首次启动先静默找一遍源码构建产物，避免用户手动翻目录。
    try {
      const detected = await window.darkroom.autoDetectEngine();
      if (detected && detected.detected) { refreshEngine(detected); return; }
    } catch (_) { /* 静默失败，保持未连接状态 */ }
  }
  refreshEngine(snapshot);
})();
