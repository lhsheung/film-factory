"use strict";

// The app's own CPU imaging pipeline.
//
// Node order follows upstream's graph:
//
//   scene latitude  ->  [overscan canvas: gate, fog, leaks, imprints]
//                   ->  film density (the profile's measured curves)
//                   ->  [overscan film present: the holes]
//                   ->  print: image exposure, [contrast mask], pre-flash,
//                       paper density
//                   ->  [overscan light: what the scan sees through the holes]
//                   ->  output transform
//
// What is faithful to the source and what is not, stated plainly:
//   * scene latitude, overscan and the Cineon encode are kernel-for-kernel.
//   * the film and paper stages evaluate the profiles' own measured density
//     curves, but in three channels, not in 81 wavelengths: there is no
//     spectral upsampling and no spectral integral here. The 81-wavelength
//     path remains the upstream GPU engine's.

const sharp = require("sharp");
const sceneLatitude = require("./scene-latitude");
const contrastMask = require("./contrast-mask");
const overscan = require("./overscan");
const imprint = require("./imprint");
const di = require("./digital-intermediate");
const wideGamut = require("./wide-gamut");
const filmModel = require("./film-model");

const MID_GREY = 0.184;

// The app's format ids map onto the overscan renderer's own names.
const GATE_FORMATS = {
  "135": "135", "135_half": "135_half", xpan: "135_xpan",
  "645": "120_645", "6x6": "120_6x6", "6x7": "120_6x7",
  "6x8": "120_6x8", "6x9": "120_6x9", "6x12": "120_6x12", "6x17": "120_6x17"
};

function gateFormatFor(params) {
  const pair = params.pair || {};
  if (pair.active) return "135_half";
  const id = params.film && params.film.format;
  return GATE_FORMATS[id] || "135";
}

function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v) {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * The second-layer adjustments (「精修」): tone, colour and geometry applied to
 * the linear print, after the darkroom stages and before the output transform.
 */
function applyAdjust(rgb, adjust) {
  if (!adjust) return rgb;
  const out = new Float32Array(rgb.length);
  const exposure = Math.pow(2, adjust.exposure || 0);
  const contrast = 1 + (adjust.contrast || 0) / 100;
  const saturation = Math.max(0, 1 + (adjust.saturation || 0) / 100);
  const highlights = (adjust.highlights || 0) / 100;
  const shadows = (adjust.shadows || 0) / 100;
  // Temperature and tint are handed to the pipeline as channel gains around
  // 5500 K / neutral, so a warm shift lifts red and drops blue.
  const warm = (adjust.temperature || 0) / 100;
  const tint = (adjust.tint || 0) / 100;
  const gains = [
    exposure * Math.pow(2, warm * 0.18),
    exposure * Math.pow(2, -tint * 0.12),
    exposure * Math.pow(2, -warm * 0.18)
  ];
  const pivot = MID_GREY;
  for (let i = 0; i < rgb.length; i += 3) {
    const r0 = rgb[i] * gains[0];
    const g0 = rgb[i + 1] * gains[1];
    const b0 = rgb[i + 2] * gains[2];
    const y = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0;
    // Contrast about the print's mid grey, then smooth highlight/shadow
    // shoulders on the luminance; the channels keep their ratios so hue holds.
    const yc = Math.max(1e-6, pivot + (y - pivot) * contrast);
    const hw = Math.min(1, Math.max(0, (yc - pivot) / pivot));
    const sw = Math.min(1, Math.max(0, (pivot - yc) / pivot));
    const yt = yc * (1 + highlights * hw * 0.6) * (1 + shadows * sw * 0.6);
    const k = yt / Math.max(1e-6, y);
    let rr = r0 * k;
    let gg = g0 * k;
    let bb = b0 * k;
    if (saturation !== 1) {
      const yy = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
      rr = yy + (rr - yy) * saturation;
      gg = yy + (gg - yy) * saturation;
      bb = yy + (bb - yy) * saturation;
    }
    out[i] = Math.max(0, rr);
    out[i + 1] = Math.max(0, gg);
    out[i + 2] = Math.max(0, bb);
  }
  return out;
}

/** Decode an image to linear-light float RGB. */
async function decodeLinear(inputPath, maxEdge, options = {}) {
  const pipeline = sharp(inputPath, { limitInputPixels: 300000000 });
  if (options.adjust) {
    const a = options.adjust;
    const angle = (Number(a.rotation) || 0) + (Number(a.straighten) || 0);
    if (angle) pipeline.rotate(angle, { background: { r: 0, g: 0, b: 0 } });
    if (a.flipH) pipeline.flop();
    if (a.flipV) pipeline.flip();
  } else {
    pipeline.rotate();
  }
  if (maxEdge) pipeline.resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
  const { data, info } = await pipeline
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const out = new Float32Array(n * 3);
  const channels = info.channels;
  const isSixteen = info.bitDepth === 16 || info.depth === "ushort";
  for (let i = 0; i < n; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      const src = channels === 1 ? i : i * channels + c;
      let v = isSixteen ? data[src * 2] / 257 + data[src * 2 + 1] * 0 : data[src] / 255;
      if (isSixteen) v = ((data[src * 2 + 1] << 8) | data[src * 2]) / 65535;
      out[3 * i + c] = options.linearInput ? v : srgbToLinear(v);
    }
  }
  return { rgb: out, width: info.width, height: info.height };
}

function densityOf(profile, logE, channel) {
  return filmModel.interpTable(profile.logExposure, profile.densityCurves, logE, 3, channel);
}

/** The table's anchor: the log10 exposure its mid scale sits at. */
function midAnchor(profile) {
  const n = profile.logExposure.length;
  if (!n) return 0;
  let best = 0;
  let bestGap = Infinity;
  const mid = n >> 1;
  for (let i = 0; i < n; i += 1) {
    const gap = Math.abs(i - mid);
    if (gap < bestGap && Number.isFinite(profile.logExposure[i])) {
      bestGap = gap;
      best = i;
    }
  }
  return profile.logExposure[best];
}

function paperWhite(profile) {
  let minD = Infinity;
  for (let i = 0; i < profile.logExposure.length; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      const d = densityOf(profile, profile.logExposure[i], c);
      if (Number.isFinite(d)) minD = Math.min(minD, d);
    }
  }
  return Number.isFinite(minD) ? Math.pow(10, -minD) : 1;
}

/**
 * Two half frames on one strip: A at the start, B one advance along. Both are
 * fitted to the half-frame's own 18 x 24 proportion and joined, so the gate the
 * overscan stage sees is the pair's 36 x 24 that a 135 half-frame camera makes.
 */
async function composePair(first, second, maxEdge, vertical) {
  const targetHeight = Math.max(240, maxEdge || 1400);
  const halfWidth = Math.round((targetHeight * 18) / 24);
  const fit = async (filePath) => {
    const buffer = await sharp(filePath, { limitInputPixels: 300000000 })
      .rotate()
      .resize({ width: halfWidth, height: targetHeight, fit: "cover", position: "centre" })
      .removeAlpha()
      .raw()
      .toBuffer();
    return buffer;
  };
  const a = await fit(first);
  const b = await fit(second);
  const width = vertical ? halfWidth : halfWidth * 2;
  const height = vertical ? targetHeight * 2 : targetHeight;
  const canvas = Buffer.alloc(width * height * 3);
  if (vertical) {
    a.copy(canvas, 0);
    b.copy(canvas, halfWidth * targetHeight * 3);
  } else {
    for (let row = 0; row < targetHeight; row += 1) {
      a.copy(canvas, row * width * 3, row * halfWidth * 3, (row + 1) * halfWidth * 3);
      b.copy(canvas, row * width * 3 + halfWidth * 3, row * halfWidth * 3, (row + 1) * halfWidth * 3);
    }
  }
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0; i < rgb.length; i += 1) rgb[i] = srgbToLinear(canvas[i] / 255);
  return { rgb, width, height };
}

/**
 * Run the whole pipeline.
 * @param {object} job
 *   input: file path
 *   secondary: a paired half frame's path (optional)
 *   maxEdge: preview long edge (0 = full)
 *   params: the app's state { film, print, adjust, edge, pair, output }
 *   filmStock, paperStock
 * @returns {{ rgb: Float32Array, width: number, height: number, notes: string[] }}
 */
async function render(job) {
  const params = job.params || {};
  const film = job.filmStock ? filmModel.loadProfile(job.filmStock) : null;
  const paper = job.paperStock ? filmModel.loadProfile(job.paperStock) : null;
  const notes = [];

  let decoded;
  const pair = params.pair || {};
  if (pair.active && job.secondary) {
    const composed = await composePair(job.input, job.secondary, job.maxEdge, pair.orientation === "vertical");
    decoded = composed;
    notes.push("半格配对：两张画面已合成 36 × 24 一格");
  } else {
    decoded = await decodeLinear(job.input, job.maxEdge || 0, { linearInput: Boolean(job.linearInput), adjust: params.adjust });
  }
  let rgb = decoded.rgb;
  let width = decoded.width;
  let height = decoded.height;

  // --- 1. scene latitude ---------------------------------------------------
  const lat = (params.latitude || {});
  if (lat.active) {
    rgb = sceneLatitude.apply(rgb, {
      width, height, row0: 0,
      norm: lat.norm || "power",
      highlightKnee: lat.highlightKnee, highlightRoom: lat.highlightRoom,
      shadowKnee: lat.shadowKnee, shadowRoom: lat.shadowRoom,
      rolloff: lat.rolloff, maxLift: lat.maxLift,
      split: lat.split || 0,
      bHighlightKnee: lat.bHighlightKnee, bHighlightRoom: lat.bHighlightRoom,
      bShadowKnee: lat.bShadowKnee, bShadowRoom: lat.bShadowRoom,
      nRef: lat.nRef
    });
    notes.push("场景宽容度已按 RFC-023 内核施加");
  }

  // --- 2. overscan: the film outside the frame ------------------------------
  let layout = null;
  let block = null;
  const os = params.edge || {};
  if (os.active) {
    const px = 24.3 / Math.max(1, Math.min(width, height));
    try {
      layout = overscan.overscanLayout({
        format: gateFormatFor(params),
        mode: os.mode || "strip",
        cameraSeed: os.cameraSeed || 1,
        frameSeed: os.frameSeed || 1,
        fog: os.fog === undefined ? 1 : os.fog,
        leaks: os.leaks || 0,
        edgeText: os.edgeText || (film ? film.name : ""),
        fNumber: os.fNumber || 0,
        gate: os.gate || "auto",
        holes: os.holes || "white",
        frameNumber: os.frameNumber || 0,
        carrier: os.carrier || "none",
        pair: Boolean(pair.active)
      }, width, height, px, { stock: job.filmStock });
      block = overscan.paramsBlock(layout);
      const canvas = new Float32Array(layout.canvas_w * layout.canvas_h * 3);
      overscan.kernelCanvas(block, rgb, canvas);
      const groups = imprint.imprintGroups(layout, {
        overscan: Object.assign({}, os, { pair: Boolean(pair.active) }),
        dateImprint: params.dateImprint || {}
      }, { stock: job.filmStock || "" });
      for (const group of groups) {
        const bitmap = imprint.rasterise(layout, group);
        if (bitmap) imprint.addMask(canvas, layout, group, bitmap);
      }
      rgb = canvas;
      width = layout.canvas_w;
      height = layout.canvas_h;
      notes.push(`胶片边缘已渲染：${layout.format}，画布 ${width} x ${height}`);
    } catch (error) {
      notes.push(`胶片边缘未渲染：${error.message}`);
      layout = null;
      block = null;
    }
  }

  // --- 3. the film's density ------------------------------------------------
  const n = width * height;
  const cmy = new Float32Array(n * 3);
  if (film) {
    const anchor = midAnchor(film);
    const exposureStops = (params.film && params.film.exposure) || 0;
    const shift = exposureStops * Math.log10(2);
    for (let i = 0; i < n * 3; i += 1) {
      const c = i % 3;
      const linear = Math.max(1e-9, rgb[i]);
      const logE = Math.log10(linear) - Math.log10(MID_GREY) + anchor + shift;
      cmy[i] = densityOf(film, logE, c);
    }
  } else {
    for (let i = 0; i < n * 3; i += 1) cmy[i] = -Math.log10(Math.max(1e-9, rgb[i]));
  }

  // --- 4. the holes: where there is no film ---------------------------------
  if (layout && block) overscan.kernelFilmPresent(block, cmy, cmy);

  // --- 5. the print ---------------------------------------------------------
  const print = params.print || {};
  const printExposure = Math.min(20, Math.max(0.05, Math.pow(2, print.exposure === undefined ? 0 : print.exposure)));
  const mShift = (print.magenta || 0) / 100;
  const yShift = (print.yellow || 0) / 100;
  const preflash = print.preFlash || 0;
  // The enlarger's setup gain: one stop of blue per unit of Y, green per M.
  const gain = [printExposure, printExposure * Math.pow(2, -mShift * 0.03), printExposure * Math.pow(2, -yShift * 0.05)];

  const imageExposure = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    for (let c = 0; c < 3; c += 1) imageExposure[3 * i + c] = Math.pow(10, -cmy[3 * i + c]) * gain[c];
  }

  let exposure = imageExposure;
  const mask = params.contrastMask || {};
  if (mask.active) {
    // A_ref: the negative's own mid grey through the same enlarger.
    const aRef = [0, 0, 0];
    if (film) {
      const anchor = midAnchor(film);
      for (let c = 0; c < 3; c += 1) {
        aRef[c] = Math.pow(10, -densityOf(film, anchor, c)) * gain[c];
      }
    } else {
      for (let c = 0; c < 3; c += 1) aRef[c] = Math.pow(10, -(-Math.log10(MID_GREY))) * gain[c];
    }
    const result = contrastMask.apply(imageExposure, {
      width, height, row0: 0,
      gain: [1, 1, 1],
      invAref: aRef.map((v) => (v > 0 ? 1 / v : 1)),
      flash: [preflash, preflash, preflash],
      core: mask.core, highlights: mask.highlights, shadows: mask.shadows,
      scale: mask.scale, limit: mask.limit || 4
    });
    exposure = result.exposure;
    notes.push("对比度蒙版已按 RFC-024 内核施加");
  } else {
    for (let i = 0; i < n * 3; i += 1) {
      exposure[i] = Math.max(exposure[i] + preflash, 0) + 1e-10;
    }
  }

  const out = new Float32Array(n * 3);
  if (paper) {
    const anchor = midAnchor(paper);
    const white = paperWhite(paper);
    for (let i = 0; i < n; i += 1) {
      for (let c = 0; c < 3; c += 1) {
        const logE = Math.log10(Math.max(1e-12, exposure[3 * i + c])) + anchor - Math.log10(Math.max(1e-12, gain[c] * 0.184));
        const d = densityOf(paper, logE, c);
        out[3 * i + c] = Math.min(1, Math.pow(10, -d) / Math.max(1e-9, white));
      }
    }
  } else {
    for (let i = 0; i < n * 3; i += 1) out[i] = Math.min(1, Math.max(0, exposure[i]));
  }

  // --- 6. what the scan sees through the holes ------------------------------
  if (layout && block) overscan.kernelLight(block, out, out);

  // --- 7. the second-layer adjustments --------------------------------------
  const adjusted = applyAdjust(out, params.adjust);
  return { rgb: adjusted, width, height, notes, layout };
}

/**
 * The film edge as a post stage, for a picture another engine developed.
 *
 * The spectral host refuses `overscan` on Windows, so when a RAW is developed
 * by the upstream engine the rebate is added here instead: the developed frame
 * becomes the exposure that the gate passes, then the same canvas, imprint and
 * hole kernels run. It is the edge, not the spectral model, so nothing about
 * the negative changes.
 */
async function applyEdgeOnly(inputPath, params, filmStock, maxEdge) {
  const os = params.edge || {};
  const pair = params.pair || {};
  const decoded = await decodeLinear(inputPath, maxEdge || 0, { adjust: params.adjust });
  const px = 24.3 / Math.max(1, Math.min(decoded.width, decoded.height));
  const layout = overscan.overscanLayout({
    format: gateFormatFor(params),
    mode: os.mode || "strip",
    cameraSeed: os.cameraSeed || 1,
    frameSeed: os.frameSeed || 1,
    fog: os.fog === undefined ? 1 : os.fog,
    leaks: os.leaks || 0,
    edgeText: os.edgeText || "",
    fNumber: os.fNumber || 0,
    gate: os.gate || "auto",
    holes: os.holes || "white",
    frameNumber: os.frameNumber || 0,
    carrier: os.carrier || "none",
    pair: Boolean(pair.active)
  }, decoded.width, decoded.height, px, { stock: filmStock || "" });
  const block = overscan.paramsBlock(layout);
  const canvas = new Float32Array(layout.canvas_w * layout.canvas_h * 3);
  overscan.kernelCanvas(block, decoded.rgb, canvas);
  const groups = imprint.imprintGroups(layout, {
    overscan: Object.assign({}, os, { pair: Boolean(pair.active) }),
    dateImprint: params.dateImprint || {}
  }, { stock: filmStock || "" });
  for (const group of groups) {
    const bitmap = imprint.rasterise(layout, group);
    if (bitmap) imprint.addMask(canvas, layout, group, bitmap);
  }
  overscan.kernelLight(block, canvas, canvas);
  return {
    rgb: canvas,
    width: layout.canvas_w,
    height: layout.canvas_h,
    notes: [`胶片边缘已在成片上叠加：${layout.format}，${layout.canvas_w} x ${layout.canvas_h}`]
  };
}

/** Encode a float RGB buffer to 8-bit sRGB bytes. */
function toSrgb8(rgb) {
  const out = Buffer.alloc(rgb.length);
  for (let i = 0; i < rgb.length; i += 1) out[i] = Math.round(linearToSrgb(rgb[i]) * 255);
  return out;
}

/** Encode to 16-bit in the chosen working space, with its ICC profile. */
function toWideGamut(rgb, width, height, space) {
  const target = space || "srgb";
  if (target === "srgb") {
    const data = new Uint16Array(rgb.length);
    for (let i = 0; i < rgb.length; i += 1) data[i] = Math.round(Math.min(1, Math.max(0, rgb[i])) * 65535);
    return { data, icc: wideGamut.iccProfile("srgb") };
  }
  const m = wideGamut.rgbToXYZMatrix(target);
  const inv = wideGamut.inv3(wideGamut.rgbToXYZMatrix("srgb"));
  // sRGB linear -> XYZ -> target linear
  const data = new Uint16Array(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    const xyz = [
      inv[0] * rgb[i] + inv[1] * rgb[i + 1] + inv[2] * rgb[i + 2],
      inv[3] * rgb[i] + inv[4] * rgb[i + 1] + inv[5] * rgb[i + 2],
      inv[6] * rgb[i] + inv[7] * rgb[i + 1] + inv[8] * rgb[i + 2]
    ];
    const mInv = wideGamut.inv3(m);
    for (let c = 0; c < 3; c += 1) {
      const v = mInv[3 * c] * xyz[0] + mInv[3 * c + 1] * xyz[1] + mInv[3 * c + 2] * xyz[2];
      data[i + c] = Math.round(Math.min(1, Math.max(0, v)) * 65535);
    }
  }
  return { data, icc: wideGamut.iccProfile(target) };
}

/** The Digital Intermediate: the Cineon encode of the developed negative. */
function digitalIntermediate(renderResult, params) {
  const offsets = di.liveOffsets({
    printExposure: Math.pow(2, (params.print && params.print.exposure) || 0),
    mFilterShift: (params.print && params.print.magenta) || 0,
    yFilterShift: (params.print && params.print.yellow) || 0,
    filterShiftScale: 1
  });
  // The positive: the print's own reflectance, before the output transform.
  return di.encode(renderResult.rgb, { offsets, floor: 0 });
}

module.exports = {
  applyAdjust, applyEdgeOnly, render, decodeLinear, toSrgb8, toWideGamut, digitalIntermediate,
  srgbToLinear, linearToSrgb, midAnchor, paperWhite, MID_GREY
};
