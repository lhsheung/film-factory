(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FilmParams = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // The stocks are the profile ids in the vendored upstream resources, so the
  // imaging pipeline reads the same measured curves the engine does.
  var FILMS = [
    { id: "kodak_portra_160", name: "Kodak Portra 160", family: "彩色负片", type: "negative" },
    { id: "kodak_portra_400", name: "Kodak Portra 400", family: "彩色负片", type: "negative" },
    { id: "kodak_portra_800", name: "Kodak Portra 800", family: "彩色负片", type: "negative" },
    { id: "kodak_portra_800_push1", name: "Portra 800 +1", family: "彩色负片", type: "negative" },
    { id: "kodak_portra_800_push2", name: "Portra 800 +2", family: "彩色负片", type: "negative" },
    { id: "kodak_gold_200", name: "Kodak Gold 200", family: "彩色负片", type: "negative" },
    { id: "kodak_ektar_100", name: "Kodak Ektar 100", family: "彩色负片", type: "negative" },
    { id: "kodak_ultramax_400", name: "Kodak UltraMax 400", family: "彩色负片", type: "negative" },
    { id: "kodak_verita_200d", name: "Kodak Verita 200D", family: "彩色负片", type: "negative" },
    { id: "fujifilm_c200", name: "Fujifilm C200", family: "彩色负片", type: "negative" },
    { id: "fujifilm_xtra_400", name: "Fujifilm X-Tra 400", family: "彩色负片", type: "negative" },
    { id: "fujifilm_pro_400h", name: "Fujifilm Pro 400H", family: "彩色负片", type: "negative" },
    { id: "kodak_ektachrome_100", name: "Kodak Ektachrome 100", family: "彩色反转片", type: "positive" },
    { id: "kodak_kodachrome_64", name: "Kodak Kodachrome 64", family: "彩色反转片", type: "positive" },
    { id: "fujifilm_provia_100f", name: "Fujifilm Provia 100F", family: "彩色反转片", type: "positive" },
    { id: "fujifilm_velvia_100", name: "Fujifilm Velvia 100", family: "彩色反转片", type: "positive" },
    { id: "kodak_vision3_50d", name: "Kodak Vision3 50D", family: "电影负片", type: "negative" },
    { id: "kodak_vision3_250d", name: "Kodak Vision3 250D", family: "电影负片", type: "negative" },
    { id: "kodak_vision3_200t", name: "Kodak Vision3 200T", family: "电影负片", type: "negative" },
    { id: "kodak_vision3_500t", name: "Kodak Vision3 500T", family: "电影负片", type: "negative" },
    { id: "kodak_2383", name: "Kodak Vision 2383", family: "电影正片", type: "negative" },
    { id: "kodak_2393", name: "Kodak Vision Premier 2393", family: "电影正片", type: "negative" },
    { id: "kodak_tri_x_400", name: "Kodak Tri-X 400", family: "黑白负片", type: "bw" },
    { id: "kodak_tmax_100", name: "Kodak T-Max 100", family: "黑白负片", type: "bw" },
    { id: "ilford_hp5_plus_400", name: "Ilford HP5 Plus 400", family: "黑白负片", type: "bw" },
    { id: "fujifilm_neopan_acros_100_ii", name: "Fujifilm Acros II", family: "黑白负片", type: "bw" }
  ];

  var PAPERS = [
    { id: "kodak_portra_endura", name: "Kodak Portra Endura", family: "彩色相纸" },
    { id: "kodak_supra_endura", name: "Kodak Supra Endura", family: "彩色相纸" },
    { id: "kodak_ultra_endura", name: "Kodak Ultra Endura", family: "彩色相纸" },
    { id: "kodak_endura_premier", name: "Kodak Endura Premier", family: "彩色相纸" },
    { id: "kodak_ektacolor_edge", name: "Kodak Ektacolor Edge", family: "彩色相纸" },
    { id: "fujifilm_crystal_archive_typeii", name: "Fuji Crystal Archive II", family: "彩色相纸" },
    { id: "ilford_multigrade_iv_rc", name: "Ilford Multigrade IV RC", family: "黑白相纸" }
  ];

  // `gate` is the overscan format id the edge renderer expects.
  var FORMATS = [
    { id: "135", name: "135 全幅", gate: "36.25 × 24.3 mm", overscan: "135" },
    { id: "135_half", name: "135 半格", gate: "18 × 24 mm", overscan: "135_half" },
    { id: "xpan", name: "XPan", gate: "65 × 24 mm", overscan: "135_xpan" },
    { id: "645", name: "120 · 645", gate: "56 × 41.5 mm", overscan: "120_645" },
    { id: "6x6", name: "120 · 6×6", gate: "56 × 56 mm", overscan: "120_6x6" },
    { id: "6x7", name: "120 · 6×7", gate: "56 × 69.5 mm", overscan: "120_6x7" },
    { id: "6x8", name: "120 · 6×8", gate: "56 × 76 mm", overscan: "120_6x8" },
    { id: "6x9", name: "120 · 6×9", gate: "56 × 84 mm", overscan: "120_6x9" },
    { id: "6x12", name: "120 · 6×12", gate: "56 × 112 mm", overscan: "120_6x12" },
    { id: "6x17", name: "120 · 6×17", gate: "56 × 168 mm", overscan: "120_6x17" }
  ];

  var NORMS = [
    { id: "power", name: "幂均值（默认）" },
    { id: "y", name: "亮度 Y" },
    { id: "max", name: "最大值" }
  ];

  var DATE_STYLES = [
    { id: "lcd", name: "七段 LCD" },
    { id: "dots", name: "点阵" },
    { id: "data", name: "拍摄数据 5×7" }
  ];

  var DEFAULTS = {
    schemaVersion: 2,
    film: {
      stock: "kodak_portra_400", format: "135", exposure: 0,
      whiteBalance: 5500, tint: 0, grain: 0.65, halation: 0.55,
      glare: 0.25, lensBlur: 0.15, boost: 0, autoExposure: true
    },
    // RFC-023: a pointwise gain compressing the scene's two ends.
    latitude: {
      active: false, norm: "power",
      highlightKnee: 2, highlightRoom: 0, shadowKnee: -2, shadowRoom: 0,
      rolloff: 2, maxLift: 4, split: 0,
      bActive: false, bHighlightKnee: 2, bHighlightRoom: 0,
      bShadowKnee: -2, bShadowRoom: 0
    },
    print: {
      paper: "kodak_portra_endura", exposure: 0, yellow: 0,
      magenta: 0, contrast: 0, brightness: 0, preFlash: 0, effects: true
    },
    adjust: {
      exposure: 0, contrast: 0, highlights: 0, shadows: 0,
      saturation: 0, temperature: 0, tint: 0, rotation: 0,
      flipH: false, flipV: false, straighten: 0
    },
    // RFC-024: stops of paper exposure relative to the negative's mid grey.
    contrastMask: {
      active: false, highlights: 0, shadows: 0, core: 1, scale: 0.03, limit: 4
    },
    edge: {
      active: false, mode: "strip", gate: "auto", holes: "white", carrier: "none",
      cameraSeed: 1, frameSeed: 1, frameNumber: 0, fNumber: 0,
      fog: 1, leaks: 0, edgeText: "",
      dateActive: false, date: "2026-10-28", dateStyle: "lcd",
      datePlacement: "frame", dateCorner: "br", dateSize: 1, dateEv: 3.5,
      insetX: 3, insetY: 2.4
    },
    pair: {
      active: false, orientation: "horizontal", linked: false,
      slot: "A", partnerId: null, partnerPath: "", split: 0.5
    },
    output: {
      format: "png", colorSpace: "srgb", longEdge: 2560, quality: 90,
      softProof: true, bitDepth: 8, di: false
    }
  };

  var RULES = {
    "film.exposure": [-3, 3], "film.whiteBalance": [2500, 10000],
    "film.tint": [-100, 100], "film.grain": [0, 1],
    "film.halation": [0, 1], "film.glare": [0, 1],
    "film.lensBlur": [0, 1], "film.boost": [0, 2],
    "latitude.highlightKnee": [-8, 8], "latitude.highlightRoom": [0, 8],
    "latitude.shadowKnee": [-8, 8], "latitude.shadowRoom": [0, 8],
    "latitude.rolloff": [1, 4], "latitude.maxLift": [0.25, 8],
    "latitude.split": [0, 0.95],
    "latitude.bHighlightKnee": [-8, 8], "latitude.bHighlightRoom": [0, 8],
    "latitude.bShadowKnee": [-8, 8], "latitude.bShadowRoom": [0, 8],
    "print.exposure": [-3, 3], "print.yellow": [-100, 100],
    "print.magenta": [-100, 100], "print.contrast": [-100, 100],
    "print.brightness": [-100, 100], "print.preFlash": [0, 1],
    "contrastMask.highlights": [-4, 4], "contrastMask.shadows": [-4, 4],
    "contrastMask.core": [0, 4], "contrastMask.scale": [0.005, 0.25],
    "contrastMask.limit": [0.5, 8],
    "adjust.exposure": [-3, 3], "adjust.contrast": [-100, 100],
    "adjust.highlights": [-100, 100], "adjust.shadows": [-100, 100],
    "adjust.saturation": [-100, 100], "adjust.temperature": [-100, 100],
    "adjust.tint": [-100, 100], "adjust.straighten": [-45, 45],
    "edge.cameraSeed": [1, 9999], "edge.frameSeed": [1, 9999],
    "edge.frameNumber": [0, 99], "edge.fNumber": [0, 64],
    "edge.fog": [0, 2], "edge.leaks": [0, 1],
    "edge.dateSize": [0.4, 3], "edge.dateEv": [0, 8],
    "edge.insetX": [0, 20], "edge.insetY": [0, 20],
    "pair.split": [0, 0.95],
    "output.longEdge": [640, 12000], "output.quality": [1, 100]
  };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function createState() { return clone(DEFAULTS); }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function finite(value, fallback) {
    var number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  function enumValue(value, list, fallback) {
    return list.some(function (item) { return item.id === value; }) ? value : fallback;
  }
  function oneOf(value, list, fallback) {
    return list.indexOf(value) >= 0 ? value : fallback;
  }

  var SECTIONS = ["film", "latitude", "print", "adjust", "contrastMask", "edge", "pair", "output"];

  function sanitizeState(input) {
    var source = input && typeof input === "object" ? input : {};
    var state = createState();
    SECTIONS.forEach(function (section) {
      var incoming = source[section];
      if (!incoming || typeof incoming !== "object") return;
      Object.keys(state[section]).forEach(function (key) {
        if (incoming[key] === undefined) return;
        var rule = RULES[section + "." + key];
        var fallback = state[section][key];
        if (rule) state[section][key] = clamp(finite(incoming[key], fallback), rule[0], rule[1]);
        else if (typeof fallback === "boolean") state[section][key] = incoming[key] === true;
        else if (typeof fallback === "number") state[section][key] = finite(incoming[key], fallback);
        else state[section][key] = incoming[key];
      });
    });
    state.film.stock = enumValue(state.film.stock, FILMS, DEFAULTS.film.stock);
    state.film.format = enumValue(state.film.format, FORMATS, DEFAULTS.film.format);
    state.print.paper = enumValue(state.print.paper, PAPERS, DEFAULTS.print.paper);
    state.latitude.norm = enumValue(state.latitude.norm, NORMS, DEFAULTS.latitude.norm);
    state.edge.dateStyle = enumValue(state.edge.dateStyle, DATE_STYLES, DEFAULTS.edge.dateStyle);
    state.edge.mode = oneOf(state.edge.mode, ["strip", "filed"], "strip");
    state.edge.gate = oneOf(state.edge.gate, ["auto", "square", "rounded", "eared", "shouldered", "kicked"], "auto");
    state.edge.holes = oneOf(state.edge.holes, ["white", "black"], "white");
    state.edge.carrier = oneOf(state.edge.carrier, ["none", "black", "open"], "none");
    state.edge.datePlacement = oneOf(state.edge.datePlacement, ["frame", "rebate"], "frame");
    state.edge.dateCorner = oneOf(state.edge.dateCorner, ["br", "bl", "tr", "tl"], "br");
    state.edge.edgeText = typeof state.edge.edgeText === "string" ? state.edge.edgeText.slice(0, 40) : "";
    state.edge.date = /^\d{4}-\d{2}-\d{2}$/.test(state.edge.date) ? state.edge.date : DEFAULTS.edge.date;
    state.adjust.rotation = [0, 90, 180, 270].indexOf(Number(state.adjust.rotation)) >= 0 ? Number(state.adjust.rotation) : 0;
    state.pair.orientation = oneOf(state.pair.orientation, ["horizontal", "vertical"], "horizontal");
    state.pair.slot = state.pair.slot === "B" ? "B" : "A";
    state.pair.partnerId = typeof state.pair.partnerId === "string" ? state.pair.partnerId : null;
    // The media id changes every launch; the path is what survives a restart.
    state.pair.partnerPath = typeof state.pair.partnerPath === "string" ? state.pair.partnerPath : "";
    state.output.format = oneOf(state.output.format, ["png", "jpeg", "tiff"], "png");
    state.output.colorSpace = oneOf(state.output.colorSpace, ["srgb", "display-p3", "rec2020", "prophoto"], "srgb");
    state.output.bitDepth = state.output.bitDepth === 16 ? 16 : 8;
    state.schemaVersion = 2;
    return state;
  }

  function getFilm(state) {
    var id = state && state.film ? state.film.stock : DEFAULTS.film.stock;
    return FILMS.find(function (film) { return film.id === id; }) || FILMS[0];
  }

  function getPaper(state) {
    var id = state && state.print ? state.print.paper : DEFAULTS.print.paper;
    return PAPERS.find(function (paper) { return paper.id === id; }) || PAPERS[0];
  }

  function getFormat(state) {
    var id = state && state.film ? state.film.format : DEFAULTS.film.format;
    return FORMATS.find(function (format) { return format.id === id; }) || FORMATS[0];
  }

  /** The overscan format id for the picture's format, and whether it is half frame. */
  function overscanFormat(state) {
    var format = getFormat(state);
    var half = state && state.pair && state.pair.active;
    return half ? "135_half" : format.overscan;
  }

  /**
   * What the *upstream GPU engine* would refuse. The app's own CPU pipeline
   * runs these features itself, so a refusal here is not a missing feature —
   * it only says the connected host cannot be the one to render it.
   */
  function validateForEngine(state, capabilities) {
    var issues = [];
    var caps = capabilities || {};
    if (!caps.available) {
      issues.push("未连接 SpektraLab 引擎；本机成像管线仍会完整渲染。");
      return issues;
    }
    if (state.latitude.active && !caps.sceneLatitude) issues.push("上游 Windows 引擎不支持场景宽容度映射；本机管线会自行处理。");
    if (state.contrastMask.active && !caps.contrastMask) issues.push("上游 Windows 引擎不支持对比度蒙版；本机管线会自行处理。");
    if (state.edge.active && !caps.filmEdge) issues.push("上游 Windows 引擎不支持 Film Edge / Date Back；本机管线会自行处理。");
    if (state.pair.active && !caps.halfFrame) issues.push("上游 Windows 引擎不支持半格配对；本机管线会自行处理。");
    if (state.output.bitDepth === 16 && !caps.wideGamut) issues.push("上游引擎未验证 16 位宽色域输出；本机导出会自行写入 ICC。");
    return issues;
  }

  return {
    FILMS: FILMS, PAPERS: PAPERS, FORMATS: FORMATS, NORMS: NORMS, DATE_STYLES: DATE_STYLES,
    DEFAULTS: DEFAULTS, RULES: RULES,
    createState: createState, sanitizeState: sanitizeState,
    clone: clone, clamp: clamp, finite: finite,
    getFilm: getFilm, getPaper: getPaper, getFormat: getFormat,
    overscanFormat: overscanFormat,
    validateForEngine: validateForEngine
  };
});
