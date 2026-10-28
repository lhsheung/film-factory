"use strict";

// RFC-031/032 overscan: the film outside the frame, as exposure.
//
// Port of vendor/SpektraLab-1.3.3/engine/src/pipeline/overscan.cpp (layout,
// gate, perforations, fog, leaks) and src/shaders/overscan.metal (the three
// kernels). Geometry is in film millimetres: `s` along the film, `t` across
// it, `t = 0` at the film's first long edge.

const { Rng, stream, LEVEL } = require("./rng");

const kMaxLeaks = 12;
const kCarrierMM = 0.40;
const kPairAdvanceMM = 19.0;
const kMaxQuads = 8;
const kIlfordCode = 2.85;
const kMidGrey = 0.184;
const kHoleEdgeSigma = 0.017;

// Kernel parameter-block indices; overscan.metal mirrors these.
const P = {
  CW: 0, CH: 1, PX: 2, FW: 3, FH: 4,
  A00: 5, A01: 6, A10: 7, A11: 8, CS: 9, CT: 10, CU: 11, CV: 12,
  VERTICAL: 13,
  GS0: 14, GT0: 15, GW: 16, GH: 17, CORNER: 18, PENUMBRA: 19,
  WOB_A: 20, WOB_PH: 32,
  FILM_W: 44, FOG_AMP: 45, FOG_WIDTH: 46, FOG_SEED: 47, FOG_PERIOD: 48,
  FOG_R: 49, FOG_G: 50, FOG_B: 51,
  N_LEAKS: 52,
  PERFORATED: 83, PERF_PITCH: 84, PERF_W: 85, PERF_H: 86, PERF_EDGE: 87, PERF_R: 88, PERF_PHASE: 89,
  HOLE_C: 90, HOLE_M: 91, HOLE_Y: 92,
  FLARE_AMP: 93, FLARE_WIDTH: 94,
  GATE_R: 95, N_Q: 99, Q: 100,
  ROUGH_AMP: 180, ROUGH_PERIOD: 181, ROUGH_SEED: 182,
  HOLES_LIGHT: 183, LIGHT_R: 184, LIGHT_G: 185, LIGHT_B: 186,
  PERF_SEED: 187, LIGHT_FALL: 188, LIGHT_DIR: 189,
  WALL_T: 190, WALL_VS: 191, WALL_VT: 192, WALL_PAR: 193,
  BASE_R: 194, BASE_G: 195, BASE_B: 196, WALL_GLOW: 197, WALL_SCATTER: 198,
  CARRIER: 199,
  LEAKS: 200,
  PAIR_ADV: 260,
  COUNT: 261
};
const kQStride = 10;

const FORMATS = [
  { name: "135", film_w: 35.0, across: 24.3, along: 36.25, perforated: true, families: "square" },
  { name: "135_half", film_w: 35.0, across: 24.0, along: 18.0, perforated: true, families: "square" },
  { name: "120_645", film_w: 61.0, across: 56.0, along: 41.5, perforated: false, families: "eared rounded" },
  { name: "120_6x6", film_w: 61.0, across: 56.0, along: 56.0, perforated: false, families: "kicked square" },
  { name: "120_6x7", film_w: 61.0, across: 56.0, along: 69.5, perforated: false, families: "square" },
  { name: "120_6x8", film_w: 61.0, across: 56.0, along: 76.0, perforated: false, families: "shouldered" },
  { name: "120_6x9", film_w: 61.0, across: 56.0, along: 84.0, perforated: false, families: "square" },
  { name: "135_xpan", film_w: 35.0, across: 24.0, along: 65.0, perforated: true, families: "square" },
  { name: "120_6x12", film_w: 61.0, across: 56.0, along: 112.0, perforated: false, families: "square" },
  { name: "120_6x17", film_w: 61.0, across: 56.0, along: 168.0, perforated: false, families: "square" }
];
const GATE_FAMILIES = ["square", "rounded", "eared", "shouldered", "kicked"];
const FORMAT_NAMES = FORMATS.map((f) => f.name).join(", ");

function findFormat(name) {
  return FORMATS.find((f) => f.name === name) || null;
}

// The manufacturer's edge print, per stock (measured on real strips).
const EDGE_135 = { Kodak: 0, FujiSlide: 1, FujiNeg: 2, Cine: 3, Ilford: 4 };
const EDGE_120 = { Kodak: 0, Fuji: 1 };
const EDGE_LOOKS = [
  ["kodak_gold_200", EDGE_135.Kodak, EDGE_120.Kodak, [1.0, 0.40, 0.26], 5.3, false, ""],
  ["kodak_portra_160", EDGE_135.Kodak, EDGE_120.Kodak, [1.0, 0.40, 0.26], 5.3, false, ""],
  ["kodak_portra_400", EDGE_135.Kodak, EDGE_120.Kodak, [1.0, 0.40, 0.26], 5.3, false, ""],
  ["kodak_portra_800", EDGE_135.Kodak, EDGE_120.Kodak, [1.0, 0.40, 0.26], 5.3, false, ""],
  ["kodak_portra_800_push1", EDGE_135.Kodak, EDGE_120.Kodak, [1.0, 0.40, 0.26], 5.3, false, ""],
  ["kodak_portra_800_push2", EDGE_135.Kodak, EDGE_120.Kodak, [1.0, 0.40, 0.26], 5.3, false, ""],
  ["kodak_ultramax_400", EDGE_135.Kodak, EDGE_120.Kodak, [1.0, 0.40, 0.26], 5.3, false, ""],
  ["kodak_ektar_100", EDGE_135.Kodak, EDGE_120.Kodak, [1.0, 0.40, 0.26], 5.3, false, ""],
  ["kodak_ektachrome_100", EDGE_135.Kodak, EDGE_120.Kodak, [1.0, 0.62, 0.70], 5.7, false, ""],
  ["fujifilm_c200", EDGE_135.Kodak, EDGE_120.Kodak, [1.0, 0.33, 0.27], 5.3, true, ""],
  ["fujifilm_xtra_400", EDGE_135.FujiNeg, EDGE_120.Fuji, [1.0, 0.72, 0.40], 5.3, false, ""],
  ["fujifilm_pro_400h", EDGE_135.FujiNeg, EDGE_120.Fuji, [1.0, 0.51, 0.025], 6.0, false, "EFCDCD"],
  ["fujifilm_provia_100f", EDGE_135.FujiSlide, EDGE_120.Fuji, [1.0, 0.10, 0.026], 6.4, false, ""],
  ["fujifilm_velvia_100", EDGE_135.FujiSlide, EDGE_120.Fuji, [1.0, 0.20, 0.08], 5.8, false, ""],
  ["kodak_tri_x_400", EDGE_135.Kodak, EDGE_120.Kodak, [1.0, 1.0, 1.0], 5.3, true, ""],
  ["kodak_tmax_100", EDGE_135.Kodak, EDGE_120.Kodak, [1.0, 1.0, 1.0], 5.3, false, ""],
  ["fujifilm_neopan_acros_100_ii", EDGE_135.FujiSlide, EDGE_120.Fuji, [1.0, 1.0, 1.0], 5.8, false, ""],
  ["ilford_hp5_plus_400", EDGE_135.Ilford, EDGE_120.Kodak, [1.0, 1.0, 1.0], 5.3, false, ""],
  ["kodak_vision3_250d", EDGE_135.Cine, EDGE_120.Kodak, [0.58, 0.60, 1.0], 4.5, false, ""],
  ["kodak_vision3_50d", EDGE_135.Cine, EDGE_120.Kodak, [0.58, 0.60, 1.0], 4.5, false, ""],
  ["kodak_vision3_200t", EDGE_135.Cine, EDGE_120.Kodak, [0.58, 0.60, 1.0], 4.5, false, ""],
  ["kodak_vision3_500t", EDGE_135.Cine, EDGE_120.Kodak, [0.58, 0.60, 1.0], 4.5, false, ""]
];
const EDGE_LOOK_DEFAULT = ["", EDGE_135.Kodak, EDGE_120.Kodak, [1.0, 0.40, 0.26], 5.3, false, ""];

function edgeLookFor(stock) {
  const row = EDGE_LOOKS.find((e) => e[0] === stock) || EDGE_LOOK_DEFAULT;
  return {
    stock: row[0], k135: row[1], k120: row[2], layer: row[3].slice(), ev: row[4],
    lightNumbers: row[5], code: row[6]
  };
}

// DX numbers (part 1 x 16 + part 2) of the stocks we ship.
const DX_CODES = {
  kodak_portra_400: 1277, kodak_portra_800: 1278, kodak_portra_800_push1: 1278,
  kodak_portra_800_push2: 1278, kodak_portra_160: 1534, kodak_gold_200: 1548,
  kodak_ektar_100: 1307, kodak_ultramax_400: 1313, kodak_ektachrome_100: 382,
  fujifilm_c200: 1550, fujifilm_xtra_400: 628, fujifilm_pro_400h: 584,
  fujifilm_provia_100f: 557, fujifilm_velvia_100: 523, ilford_hp5_plus_400: 1753
};
function dxExtractFor(stock) {
  return Object.prototype.hasOwnProperty.call(DX_CODES, stock) ? DX_CODES[stock] : -1;
}

/** ISO 1007 frame-number DX bar code: 23 bits. */
function dxBits(dxExtract, frame, half) {
  const bits = new Array(23).fill(0);
  const p1 = (dxExtract >> 4) & 0x7f;
  const p2 = dxExtract & 0xf;
  for (let i = 0; i < 7; i += 1) bits[1 + i] = (p1 >> (6 - i)) & 1;
  for (let i = 0; i < 4; i += 1) bits[9 + i] = (p2 >> (3 - i)) & 1;
  const clamped = Math.min(63, Math.max(0, frame));
  for (let i = 0; i < 6; i += 1) bits[13 + i] = (clamped >> (5 - i)) & 1;
  bits[19] = half ? 1 : 0;
  let sum = 0;
  for (let i = 0; i < 21; i += 1) sum += bits[i];
  bits[21] = sum % 2;
  return bits;
}

// --- hash / noise ----------------------------------------------------------
function hashU(x) {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}
function hashF(i, seed) {
  return (hashU(Math.imul(i, 0x9e3779b9) ^ (seed >>> 0)) >>> 0) / 4294967295;
}
function valueNoise(x, seed) {
  const i0 = Math.floor(x);
  const f = x - i0;
  const w = f * f * (3 - 2 * f);
  return hashF(i0, seed) * (1 - w) + hashF(i0 + 1, seed) * w;
}

/** Abramowitz & Stegun 7.1.26, |error| < 1.5e-7. */
function erfAs(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x < 0 ? -y : y;
}

/** Signed distance to a convex quad (either winding), negative inside. */
function sdQuad(px, py, q) {
  const vx = [q[0], q[2], q[4], q[6]];
  const vy = [q[1], q[3], q[5], q[7]];
  let d = (px - vx[0]) * (px - vx[0]) + (py - vy[0]) * (py - vy[0]);
  let sgn = 1;
  for (let i = 0, j = 3; i < 4; j = i, i += 1) {
    const ex = vx[j] - vx[i];
    const ey = vy[j] - vy[i];
    const wx = px - vx[i];
    const wy = py - vy[i];
    const ee = ex * ex + ey * ey;
    if (ee < 1e-12) continue;
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / ee));
    const bx = wx - ex * t;
    const by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c0 = py >= vy[i];
    const c1 = py < vy[j];
    const c2 = ex * wy > ey * wx;
    if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) sgn = -sgn;
  }
  return sgn * Math.sqrt(d);
}

/** The gate's shadow from a circular aperture: the lit fraction of a disc. */
function penumbra(d, r) {
  if (r <= 1e-6) return d < 0 ? 1 : 0;
  const u = Math.min(1, Math.max(-1, -d / r));
  return 0.5 + (u * Math.sqrt(Math.max(1 - u * u, 0)) + Math.asin(u)) * (1 / Math.PI);
}

// --- layout ----------------------------------------------------------------

/**
 * Every random choice of the film, once per run, from the seeds.
 * @param {object} params  { active, format, mode, cameraSeed, frameSeed, fog,
 *   leaks, edgeText, fNumber, gate, holes, frameNumber, carrier, pair }
 * @param {number} frameW @param {number} frameH @param {number} px  mm per pixel
 * @param {object} film  { stock, channelDensity, baseDensity } for hole_cmy
 */
function overscanLayout(params, frameW, frameH, px, film) {
  const o = Object.assign({
    format: "135", mode: "strip", cameraSeed: 1, frameSeed: 1, fog: 1, leaks: 0,
    edgeText: "", fNumber: 0, gate: "auto", holes: "white", frameNumber: 0,
    carrier: "none", pair: false
  }, params || {});
  const fmt = findFormat(o.format);
  if (!fmt) throw new Error(`overscan: unknown format '${o.format}' (${FORMAT_NAMES})`);
  if (o.mode !== "strip" && o.mode !== "filed") throw new Error("overscan: unknown mode (strip, filed)");
  if (o.gate !== "auto" && !GATE_FAMILIES.includes(o.gate)) {
    throw new Error(`overscan: unknown gate '${o.gate}' (auto, ${GATE_FAMILIES.join(", ")})`);
  }
  if (o.holes !== "white" && o.holes !== "black") throw new Error("overscan: unknown holes (white, black)");
  if (!["none", "black", "open"].includes(o.carrier)) throw new Error("overscan: unknown carrier (none, black, open)");

  // The frame must be the gate's shape, either way up.
  const gateLong = o.pair ? fmt.along + kPairAdvanceMM : Math.max(fmt.along, fmt.across);
  const gateShort = o.pair ? fmt.across : Math.min(fmt.along, fmt.across);
  const frameLong = Math.max(frameW, frameH);
  const frameShort = Math.max(1, Math.min(frameW, frameH));
  const ratio = (frameLong / frameShort) / (gateLong / gateShort);
  if (Math.abs(ratio - 1) > 0.05) {
    throw new Error(`overscan: a ${frameW} x ${frameH} frame is not the ${fmt.name} gate's shape (${gateLong} x ${gateShort}); crop the picture to the gate first`);
  }

  const L = {
    format: fmt.name, px, frame_w: frameW, frame_h: frameH,
    quads: [], leaks: [], gate_r: [0, 0, 0, 0], valid: false,
    wob_a: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
    wob_ph: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]
  };
  const imgW = frameW * px;
  const imgH = frameH * px;
  L.vertical = Math.abs(imgW - fmt.across) < Math.abs(imgH - fmt.across) && Math.abs(imgW - imgH) > 1e-6;
  L.gate_along = L.vertical ? imgH : imgW;
  L.pair_adv = 0;
  if (o.pair) {
    L.pair_adv = kPairAdvanceMM;
    L.gate_along -= L.pair_adv;
  }
  L.gate_across = L.vertical ? imgW : imgH;

  const cam = o.cameraSeed >>> 0;
  const frm = o.frameSeed >>> 0;
  const frameSeed64 = BigInt.asUintN(64, BigInt(frm) ^ (BigInt(cam) << 32n));
  const rc = new Rng(stream(cam, LEVEL.camera, 1));
  const rf = new Rng(stream(frameSeed64, LEVEL.frame, 1));

  // --- film and gate ---
  L.film_w = fmt.film_w + (fmt.perforated ? 0 : rc.uni(-0.15, 0.15));
  const tOff = (fmt.perforated ? rc.uni(-0.1, 0.1) : rc.uni(-0.45, 0.45)) + rf.normal() * 0.025;
  L.gate_t0 = 0.5 * (L.film_w - L.gate_across) + tOff;
  L.gate_s0 = 0;
  for (let side = 0; side < 4; side += 1) {
    for (let k = 0; k < 3; k += 1) {
      L.wob_a[side][k] = (rc.normal() * 0.012) / (k + 1);
      L.wob_ph[side][k] = rc.uni(0, 2 * Math.PI);
    }
  }
  const gateGap = rc.uni(0.18, 0.4);
  const N = o.fNumber > 0.5 ? o.fNumber : 5.6;
  L.penumbra = gateGap / (2 * N);

  {
    const rg = new Rng(stream(cam, LEVEL.camera, 2));
    let family = o.gate;
    if (family === "auto") {
      const fams = fmt.families.split(" ").filter(Boolean);
      family = fams[Math.floor(rg.uni(0, fams.length)) % fams.length];
    }
    gateShape(L, family, fmt.perforated, rg);
  }
  L.holes_light = o.holes === "white";
  L.carrier_open = o.carrier === "open";
  L.carrier_none = o.carrier === "none";

  L.perforated = fmt.perforated;
  if (L.perforated) {
    L.perf_pitch = 4.75;
    L.perf_w = 1.98;
    L.perf_h = 2.8;
    L.perf_edge = 2.0;
    L.perf_r = 0.5;
    L.perf_phase = Math.min(-2.6, Math.max(-4.1, -3.3 + rc.uni(-0.7, 0.7) + rf.normal() * 0.08));
  }

  // --- canvas ---
  let marginAlong;
  let tLo;
  let tHi;
  if (o.mode === "strip") {
    marginAlong = fmt.perforated
      ? (fmt.along < 20 ? rc.uni(0.4, 0.5) : rc.uni(0.75, 0.95))
      : rc.uni(1.3, 2.1) + rf.uni(-0.25, 0.25);
    const reach = L.carrier_none ? 0 : kCarrierMM;
    tLo = -reach;
    tHi = L.film_w + reach;
  } else {
    marginAlong = 0.9 + rf.uni(-0.1, 0.1);
    tLo = L.gate_t0 - 1.1;
    tHi = L.gate_t0 + L.gate_across + 1.1;
  }
  const mPx = Math.round(marginAlong / L.px);
  const alongPx = (L.vertical ? frameH : frameW) + 2 * mPx;
  const acrossPx = Math.round((tHi - tLo) / L.px);
  L.canvas_w = L.vertical ? acrossPx : alongPx;
  L.canvas_h = L.vertical ? alongPx : acrossPx;
  const tOrigin = L.gate_t0 - Math.round((L.gate_t0 - tLo) / L.px) * L.px;
  const sOrigin = -mPx * L.px;

  const halfAlong = 0.5 * alongPx * L.px;
  const tiltLim = Math.min(0.35, (Math.asin(Math.min(1, 0.27 / halfAlong)) * 180) / Math.PI);
  L.scan_rot = (Math.min(tiltLim, Math.max(-tiltLim, rf.normal() * 0.14)) * Math.PI) / 180;
  const ds = rf.normal() * 0.08;
  const dt = rf.normal() * 0.06;
  L.cu = 0.5 * L.canvas_w * L.px;
  L.cv = 0.5 * L.canvas_h * L.px;
  const c = Math.cos(L.scan_rot);
  const sn = Math.sin(L.scan_rot);
  if (!L.vertical) L.A = [c, -sn, sn, c];
  else L.A = [sn, c, -c, sn];
  const alongC = sOrigin + 0.5 * alongPx * L.px;
  const acrossC = tOrigin + 0.5 * acrossPx * L.px;
  L.cs = alongC + ds;
  L.ct = acrossC + dt;

  // --- fog and leaks ---
  const fogEvEdge = 0.3;
  L.fog_amp = o.fog > 0 ? o.fog * kMidGrey * Math.pow(2, fogEvEdge + rc.uni(-0.4, 0.4)) : 0;
  L.fog_width = fmt.perforated ? rc.uni(0.8, 1.8) : rc.uni(1.2, 2.6);
  L.flare_amp = rc.uni(0.1, 0.35);
  L.flare_width = rc.uni(0.03, 0.08);
  L.fog_seed = rf.nextU32() & 0xffffff;
  L.fog_period = rc.uni(5, 11);
  const leakLen = Math.max(1, (alongPx * L.px) / 90);
  const nLeaks = o.leaks > 0
    ? Math.min(kMaxLeaks, Math.round(Math.min(6, 1 + 2 * o.leaks) * leakLen))
    : 0;
  const leakSide = rc.uni() < 0.5 ? 0 : 1;
  const sLo = sOrigin;
  const sHi = sOrigin + alongPx * L.px;
  for (let k = 0; k < nLeaks; k += 1) {
    L.leaks.push({
      s: rf.uni(sLo, sHi),
      side: rf.uni() < 0.8 ? leakSide : 1 - leakSide,
      amp: o.leaks * kMidGrey * Math.pow(2, rf.uni(0.5, 2.5)),
      sig_s: rf.uni(1.2, 4),
      sig_t: rf.uni(0.4, 1.3)
    });
  }

  // --- light colours and the hole ---
  const look = edgeLookFor((film && film.stock) || "");
  L.edge_rgb = look.layer.slice();
  L.fog_rgb = [1.0, 0.45, 0.12];
  L.date_rgb = [1.0, 0.55, 0.10];
  L.hole_cmy = holeCmy(film);
  {
    const rl = new Rng(stream(frameSeed64, LEVEL.frame, 3));
    L.light_rgb = L.holes_light ? [1, 1, 1] : [0, 0, 0];
    L.light_fall = 0;
    L.light_dir = 0;
    L.perf_seed = rl.nextU32() & 0xffffff;
    L.wall_t = 0.125;
    const ang = rl.uni(0, 2 * Math.PI);
    L.wall_tilt = [Math.cos(ang), Math.sin(ang)];
    L.wall_parallax = 0;
    L.wall_glow = L.holes_light ? rl.uni(0.02, 0.06) : rl.uni(0.01, 0.03);
    L.wall_scatter = rl.uni(0.02, 0.035);
    L.base_rgb = (film && film.baseRgb) ? film.baseRgb.slice() : [0.62, 0.47, 0.30];
  }

  L.valid = true;
  return L;
}

/** The gate's shape family (RFC-032 §29). */
function gateShape(L, family, perforated, rg) {
  if (family === "shouldered") {
    L.gate_t0 = rg.uni(1.1, 1.35) + (L.gate_t0 - 0.5 * (L.film_w - L.gate_across));
  }
  const s0 = L.gate_s0;
  const t0 = L.gate_t0;
  const GW = L.gate_along;
  const GH = L.gate_across;
  const quad = (pts, round, sign) => {
    if (L.quads.length >= kMaxQuads) return;
    const p = pts.slice();
    while (p.length < 8) p.push(p[p.length - 2], p[p.length - 1]);
    L.quads.push({ pts: p.slice(0, 8), round, sign });
  };
  const sideCut = (top, earA, earB, depth, slope, round) => {
    const te = top ? t0 : t0 + GH;
    const out = top ? -1 : 1;
    const dIn = depth - round;
    const ext = 1;
    const k = slope / Math.max(depth, 1e-3);
    const saIn = s0 + earA + slope - round;
    const sbIn = s0 + GW - earB - slope + round;
    const saOut = s0 + earA - k * ext + round;
    const sbOut = s0 + GW - earB + k * ext - round;
    quad([saOut, te + out * ext, sbOut, te + out * ext, sbIn, te - out * dIn, saIn, te - out * dIn], round, -1);
  };
  const bandCut = (top, earA, earB, d0, d1, a0, a1) => {
    const te = top ? t0 : t0 + GH;
    const out = top ? -1 : 1;
    quad([s0 + earA + a0, te - out * d0, s0 + GW - earB - a0, te - out * d0,
      s0 + GW - earB - a1, te - out * d1, s0 + earA + a1, te - out * d1], 0.02, -1);
  };
  const radii = (lo, hi) => { for (let i = 0; i < 4; i += 1) L.gate_r[i] = rg.uni(lo, hi); };

  L.gate_family = family;
  if (family === "rounded") {
    const r = rg.uni(0.42, 0.62);
    for (let i = 0; i < 4; i += 1) L.gate_r[i] = Math.max(0.2, r + rg.uni(-0.08, 0.08));
  } else if (family === "eared") {
    radii(0.02, 0.08);
    for (const top of [true, false]) {
      const te = top ? t0 : t0 + GH;
      const out = top ? -1 : 1;
      const depth = rg.uni(0.48, 0.65);
      const ea = rg.uni(0, 0.05);
      const eb = rg.uni(0, 0.05);
      const la = rg.uni(1.5, 2.2);
      const lb = rg.uni(1.5, 2.2);
      quad([s0 + ea + la, te + out * 1, s0 + GW - eb - lb, te + out * 1,
        s0 + GW - eb - lb, te - out * depth, s0 + ea + la, te - out * depth], 0, -1);
      const Ra = (la * la + depth * depth) / (2 * depth);
      const Rb = (lb * lb + depth * depth) / (2 * depth);
      quad([s0 + ea + la, te + out * (Ra - depth), Ra, Ra], 0, -2);
      quad([s0 + GW - eb - lb, te + out * (Rb - depth), Rb, Rb], 0, -2);
    }
  } else if (family === "shouldered") {
    radii(0.04, 0.12);
    L.gate_r[0] = rg.uni(0.28, 0.5);
    L.gate_r[1] = rg.uni(0.28, 0.5);
    const ea = rg.uni(3.1, 3.8);
    const eb = rg.uni(3.1, 3.8);
    const depth = rg.uni(1.35, 1.6);
    const steep = rg.uni(0.35, 0.45);
    const knee = rg.uni(0.3, 0.4);
    const leg = rg.uni(2, 2.6);
    sideCut(true, ea, eb, knee * depth, steep, 0.03);
    bandCut(true, ea, eb, knee * depth - 0.05, depth, steep - 0.03, steep + leg);
    L.top_recess = depth;
  } else if (family === "kicked") {
    radii(0.02, 0.1);
    const first = Math.floor(rg.uni(0, 4)) % 4;
    for (let j = 0; j < 2; j += 1) {
      const cc = (first + 2 * j + (rg.uni() < 0.3 ? 1 : 0)) % 4;
      const right = cc === 1 || cc === 2;
      const bottom = cc === 2 || cc === 3;
      const sc = right ? s0 + GW : s0;
      const tc = bottom ? t0 + GH : t0;
      const len = rg.uni(0.6, 1);
      const kick = rg.uni(0.14, 0.26);
      const dir = right ? -1 : 1;
      const out = bottom ? 1 : -1;
      quad([sc + dir * len, tc - out * 0.05, sc, tc - out * 0.05, sc, tc + out * kick], 0.01, 1);
    }
  } else {
    if (perforated) radii(0.1, 0.38);
    else radii(0.06, 0.32);
  }
  const nicks = Math.floor(rg.uni(0, 2.6));
  for (let k = 0; k < nicks; k += 1) {
    const side = Math.floor(rg.uni(0, 4)) % 4;
    const sz = rg.uni(0.04, 0.12);
    const pos = rg.uni(0.08, 0.92);
    const sign = rg.uni() < 0.5 ? 1 : -1;
    let a0; let b0; let a1; let b1; let ax; let bx;
    if (side === 0 || side === 2) {
      const te = side === 0 ? t0 : t0 + GH;
      const out = (side === 0 ? -1 : 1) * sign;
      const sc = s0 + pos * GW;
      a0 = sc - sz; b0 = te; a1 = sc + sz; b1 = te;
      ax = sc + rg.uni(-0.5, 0.5) * sz; bx = te + out * sz;
    } else {
      const se = side === 3 ? s0 : s0 + GW;
      const out = (side === 3 ? -1 : 1) * sign;
      const tc = t0 + pos * GH;
      a0 = se; b0 = tc - sz; a1 = se; b1 = tc + sz;
      ax = se + out * sz; bx = tc + rg.uni(-0.5, 0.5) * sz;
    }
    quad([a0, b0, a1, b1, ax, bx], 0.005, sign);
  }
  L.rough_amp = rg.uni(0.003, 0.009);
  L.rough_period = rg.uni(0.08, 0.2);
  L.rough_seed = rg.nextU32() & 0xffffff;
}

/** The cmy that cancels this film's base, by least squares. */
function holeCmy(film) {
  const out = [0, 0, 0];
  if (!film || !film.channelDensity || !film.baseDensity) return out;
  const chd = film.channelDensity;
  const base = film.baseDensity;
  const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const Atb = [0, 0, 0];
  for (let l = 0; l < base.length; l += 1) {
    const b = base[l];
    if (!Number.isFinite(b)) continue;
    const a = [chd[3 * l], chd[3 * l + 1], chd[3 * l + 2]];
    if (!a.every(Number.isFinite)) continue;
    for (let i = 0; i < 3; i += 1) {
      Atb[i] += a[i] * -b;
      for (let j = 0; j < 3; j += 1) AtA[i][j] += a[i] * a[j];
    }
  }
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(AtA);
  for (let k = 0; k < 3; k += 1) {
    const M = AtA.map((row) => row.slice());
    for (let i = 0; i < 3; i += 1) M[i][k] = Atb[i];
    out[k] = Math.abs(D) > 1e-12 ? det3(M) / D : 0;
  }
  return out;
}

function paramsBlock(L) {
  const p = new Float64Array(P.COUNT);
  p[P.CW] = L.canvas_w;
  p[P.CH] = L.canvas_h;
  p[P.PX] = L.px;
  p[P.FW] = L.frame_w;
  p[P.FH] = L.frame_h;
  p[P.A00] = L.A[0]; p[P.A01] = L.A[1]; p[P.A10] = L.A[2]; p[P.A11] = L.A[3];
  p[P.CS] = L.cs; p[P.CT] = L.ct; p[P.CU] = L.cu; p[P.CV] = L.cv;
  p[P.VERTICAL] = L.vertical ? 1 : 0;
  p[P.GS0] = L.gate_s0; p[P.GT0] = L.gate_t0;
  p[P.GW] = L.gate_along; p[P.GH] = L.gate_across;
  p[P.CORNER] = L.corner || 0; p[P.PENUMBRA] = L.penumbra;
  for (let side = 0; side < 4; side += 1) {
    for (let k = 0; k < 3; k += 1) {
      p[P.WOB_A + side * 3 + k] = L.wob_a[side][k];
      p[P.WOB_PH + side * 3 + k] = L.wob_ph[side][k];
    }
  }
  p[P.FILM_W] = L.film_w;
  p[P.FOG_AMP] = L.fog_amp;
  p[P.FOG_WIDTH] = L.fog_width;
  p[P.FOG_SEED] = L.fog_seed;
  p[P.FOG_PERIOD] = L.fog_period;
  for (let c = 0; c < 3; c += 1) p[P.FOG_R + c] = L.fog_rgb[c];
  p[P.N_LEAKS] = Math.min(L.leaks.length, kMaxLeaks);
  for (let k = 0; k < L.leaks.length && k < kMaxLeaks; k += 1) {
    const b = P.LEAKS + 5 * k;
    p[b] = L.leaks[k].s;
    p[b + 1] = L.leaks[k].side;
    p[b + 2] = L.leaks[k].amp;
    p[b + 3] = L.leaks[k].sig_s;
    p[b + 4] = L.leaks[k].sig_t;
  }
  p[P.PERFORATED] = L.perforated ? 1 : 0;
  p[P.PERF_PITCH] = L.perf_pitch || 0;
  p[P.PERF_W] = L.perf_w || 0;
  p[P.PERF_H] = L.perf_h || 0;
  p[P.PERF_EDGE] = L.perf_edge || 0;
  p[P.PERF_R] = L.perf_r || 0;
  p[P.PERF_PHASE] = L.perf_phase || 0;
  for (let c = 0; c < 3; c += 1) p[P.HOLE_C + c] = L.hole_cmy[c];
  p[P.FLARE_AMP] = L.flare_amp;
  p[P.FLARE_WIDTH] = L.flare_width;
  for (let k = 0; k < 4; k += 1) p[P.GATE_R + k] = L.gate_r[k];
  const nq = Math.min(L.quads.length, kMaxQuads);
  p[P.N_Q] = nq;
  for (let k = 0; k < nq; k += 1) {
    for (let j = 0; j < 8; j += 1) p[P.Q + kQStride * k + j] = L.quads[k].pts[j];
    p[P.Q + kQStride * k + 8] = L.quads[k].round;
    p[P.Q + kQStride * k + 9] = L.quads[k].sign;
  }
  p[P.ROUGH_AMP] = L.rough_amp;
  p[P.ROUGH_PERIOD] = L.rough_period;
  p[P.ROUGH_SEED] = L.rough_seed;
  p[P.HOLES_LIGHT] = L.holes_light ? 1 : 0;
  p[P.CARRIER] = L.carrier_none ? 2 : (L.carrier_open ? 1 : 0);
  p[P.PAIR_ADV] = L.pair_adv || 0;
  for (let c = 0; c < 3; c += 1) p[P.LIGHT_R + c] = L.light_rgb[c];
  p[P.PERF_SEED] = L.perf_seed;
  p[P.LIGHT_FALL] = L.light_fall;
  p[P.LIGHT_DIR] = L.light_dir;
  p[P.WALL_T] = L.wall_t;
  p[P.WALL_VS] = L.wall_tilt[0];
  p[P.WALL_VT] = L.wall_tilt[1];
  p[P.WALL_PAR] = L.wall_parallax;
  for (let c = 0; c < 3; c += 1) p[P.BASE_R + c] = L.base_rgb[c];
  p[P.WALL_GLOW] = L.wall_glow;
  p[P.WALL_SCATTER] = L.wall_scatter;
  return p;
}

// --- kernels ---------------------------------------------------------------

function canvasToFilm(Pb, x, y) {
  const u = (x + 0.5) * Pb[P.PX] - Pb[P.CU];
  const v = (y + 0.5) * Pb[P.PX] - Pb[P.CV];
  return [Pb[P.A00] * u + Pb[P.A01] * v + Pb[P.CS], Pb[P.A10] * u + Pb[P.A11] * v + Pb[P.CT]];
}

function gateSdf(Pb, sx, sy) {
  const hw = 0.5 * Pb[P.GW];
  const hh = 0.5 * Pb[P.GH];
  const ds = sx - (Pb[P.GS0] + hw);
  const dt = sy - (Pb[P.GT0] + hh);
  const r = ds > 0 ? (dt > 0 ? Pb[P.GATE_R + 2] : Pb[P.GATE_R + 1])
    : (dt > 0 ? Pb[P.GATE_R + 3] : Pb[P.GATE_R + 0]);
  const qs = Math.abs(ds) - (hw - r);
  const qt = Math.abs(dt) - (hh - r);
  let d = Math.hypot(Math.max(qs, 0), Math.max(qt, 0)) + Math.min(Math.max(qs, qt), 0) - r;
  let side;
  let along;
  let len;
  if (qs > qt) { side = ds > 0 ? 1 : 3; along = dt + hh; len = 2 * hh; }
  else { side = dt > 0 ? 2 : 0; along = ds + hw; len = 2 * hw; }
  const u = Math.min(1, Math.max(0, along / len));
  let w = 0;
  for (let k = 0; k < 3; k += 1) {
    w += Pb[P.WOB_A + side * 3 + k] * Math.sin((k + 1) * Math.PI * u + Pb[P.WOB_PH + side * 3 + k]);
  }
  d -= w * Math.sin(Math.PI * u);
  const nq = Pb[P.N_Q];
  for (let k = 0; k < nq; k += 1) {
    const base = P.Q + kQStride * k;
    let dq;
    if (Math.abs(Pb[base + 9]) > 1.5) {
      const rx = Math.max(Pb[base + 2], 1e-4);
      const ry = Math.max(Pb[base + 3], 1e-4);
      dq = (Math.hypot((sx - Pb[base]) / rx, (sy - Pb[base + 1]) / ry) - 1) * Math.min(rx, ry);
    } else {
      const q = [];
      for (let j = 0; j < 8; j += 1) q.push(Pb[base + j]);
      dq = sdQuad(sx, sy, q) - Pb[base + 8];
    }
    d = Pb[base + 9] > 0 ? Math.min(d, dq) : Math.max(d, -dq);
  }
  if (Pb[P.ROUGH_AMP] > 0) {
    const seed = Pb[P.ROUGH_SEED] >>> 0;
    const per = Math.max(Pb[P.ROUGH_PERIOD], 1e-3);
    d += Pb[P.ROUGH_AMP] * (valueNoise(sx / per, seed) + valueNoise(sy / per, (seed ^ 0x5bd1e995) >>> 0) - 1);
  }
  return d;
}

function perfSdf(Pb, sx, sy) {
  const W = Pb[P.FILM_W];
  const pitch = Pb[P.PERF_PITCH];
  const ph = Pb[P.PERF_PHASE];
  const k = Math.floor((sx - ph - 0.5 * Pb[P.PERF_W]) / pitch + 0.5);
  const top = sy < 0.5 * W;
  const seed = Pb[P.PERF_SEED] >>> 0;
  const hole = hashU((k * 2 + (top ? 0 : 1)) * 0x9e3779b9 ^ seed);
  const h = hole & 0xffff;
  const j0 = hashF(h, (seed ^ 1) >>> 0) - 0.5;
  const j1 = hashF(h, (seed ^ 2) >>> 0) - 0.5;
  const j2 = hashF(h, (seed ^ 3) >>> 0) - 0.5;
  const j3 = hashF(h, (seed ^ 4) >>> 0) - 0.5;
  const j4 = hashF(h, (seed ^ 5) >>> 0) - 0.5;
  const wa = Pb[P.PERF_W] + 0.016 * j2;
  const hc = Pb[P.PERF_H] + 0.016 * j3;
  const r = Math.min(0.6, Math.max(0.3, Pb[P.PERF_R] + 0.08 * j4));
  const sc = ph + k * pitch + 0.5 * Pb[P.PERF_W] + 0.02 * j0;
  const tc = (top ? Pb[P.PERF_EDGE] + 0.5 * Pb[P.PERF_H] : W - Pb[P.PERF_EDGE] - 0.5 * Pb[P.PERF_H]) + 0.024 * j1;
  const qx = Math.abs(sx - sc) - (0.5 * wa - r);
  const qy = Math.abs(sy - tc) - (0.5 * hc - r);
  let d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  const rough = 0.001 + 0.003 * hashF(h, (seed ^ 6) >>> 0);
  d += rough * (valueNoise(sx / 0.05, (seed ^ 0x77) >>> 0) + valueNoise(sy / 0.05, (seed ^ 0x99) >>> 0) - 1) * 2;
  if (hashF(h, (seed ^ 7) >>> 0) < 0.25) {
    const ang = 6.2831853 * hashF(h, (seed ^ 8) >>> 0);
    const pbx = sc + Math.cos(ang) * 0.5 * wa;
    const pby = tc + Math.sin(ang) * 0.5 * hc;
    const sig = 0.02 + 0.03 * hashF(h, (seed ^ 9) >>> 0);
    const amp = (hashF(h, (seed ^ 0xa) >>> 0) < 0.5 ? -1 : 1) * (0.006 + 0.01 * hashF(h, (seed ^ 0xb) >>> 0));
    d += amp * Math.exp(-((sx - pbx) * (sx - pbx) + (sy - pby) * (sy - pby)) / (sig * sig));
  }
  return { d, hole };
}

function filmAlpha(Pb, sx, sy) {
  const W = Pb[P.FILM_W];
  const pxmm = Pb[P.PX];
  let a = Pb[P.CARRIER] > 1.5 ? 1 : Math.min(1, Math.max(0, Math.min(sy, W - sy) / pxmm + 0.5));
  if (Pb[P.PERFORATED] > 0.5) {
    const sigma = Math.sqrt(kHoleEdgeSigma * kHoleEdgeSigma + 0.0961 * pxmm * pxmm);
    a *= 0.5 + 0.5 * erfAs(perfSdf(Pb, sx, sy).d / (1.41421356 * sigma));
  }
  return a;
}

function sampleFrame(frame, fx, fy, fw, fh) {
  fx = Math.min(fw - 1, Math.max(0, fx));
  fy = Math.min(fh - 1, Math.max(0, fy));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, fw - 1);
  const y1 = Math.min(y0 + 1, fh - 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    const a = frame[3 * (y0 * fw + x0) + c];
    const b = frame[3 * (y0 * fw + x1) + c];
    const d = frame[3 * (y1 * fw + x0) + c];
    const e = frame[3 * (y1 * fw + x1) + c];
    out[c] = (a * (1 - ax) + b * ax) * (1 - ay) + (d * (1 - ax) + e * ax) * ay;
  }
  return out;
}

/** ① + ② + the fog of ③: raw exposure on the film canvas. */
function kernelCanvas(Pb, frame, out) {
  const cw = Pb[P.CW];
  const chh = Pb[P.CH];
  const W = Pb[P.FILM_W];
  const fw = Pb[P.FW];
  const fh = Pb[P.FH];
  for (let i = 0; i < cw * chh; i += 1) {
    const st = canvasToFilm(Pb, i % cw, Math.floor(i / cw));
    let e = [0, 0, 0];
    if (Pb[P.CARRIER] > 1.5 || (st[1] >= 0 && st[1] <= W)) {
      let sgx = st[0];
      let shift = 0;
      if (Pb[P.PAIR_ADV] > 0 && st[0] > Pb[P.GS0] + 0.5 * (Pb[P.GW] + Pb[P.PAIR_ADV])) {
        shift = Pb[P.PAIR_ADV];
        sgx -= shift;
      }
      const dGate = gateSdf(Pb, sgx, st[1]);
      const cov = penumbra(dGate, Pb[P.PENUMBRA]);
      if (cov > 0) {
        const pxmm = Pb[P.PX];
        let fx;
        let fy;
        if (Pb[P.VERTICAL] < 0.5) {
          fx = (st[0] - Pb[P.GS0]) / pxmm - 0.5;
          fy = (st[1] - Pb[P.GT0]) / pxmm - 0.5;
        } else {
          fx = (Pb[P.GT0] + Pb[P.GH] - st[1]) / pxmm - 0.5;
          fy = (st[0] - Pb[P.GS0]) / pxmm - 0.5;
        }
        const s = sampleFrame(frame, fx, fy, fw, fh);
        for (let c = 0; c < 3; c += 1) e[c] += cov * s[c];
      }
      if (Pb[P.FLARE_AMP] > 0 && dGate > -0.02 && dGate < 6 * Pb[P.FLARE_WIDTH]) {
        const pxmm = Pb[P.PX];
        const inS = Math.min(Pb[P.GS0] + Pb[P.GW] - 0.12, Math.max(Pb[P.GS0] + 0.12, sgx)) + shift;
        const inT = Math.min(Pb[P.GT0] + Pb[P.GH] - 0.12, Math.max(Pb[P.GT0] + 0.12, st[1]));
        let fx;
        let fy;
        if (Pb[P.VERTICAL] < 0.5) {
          fx = (inS - Pb[P.GS0]) / pxmm - 0.5;
          fy = (inT - Pb[P.GT0]) / pxmm - 0.5;
        } else {
          fx = (Pb[P.GT0] + Pb[P.GH] - inT) / pxmm - 0.5;
          fy = (inS - Pb[P.GS0]) / pxmm - 0.5;
        }
        const edgeLight = sampleFrame(frame, fx, fy, fw, fh);
        const prof = Math.exp(-Math.max(dGate, 0) / Pb[P.FLARE_WIDTH]);
        for (let c = 0; c < 3; c += 1) e[c] += Pb[P.FLARE_AMP] * prof * edgeLight[c];
      }
      const dTop = Math.max(st[1], 0);
      const dBot = Math.max(W - st[1], 0);
      const seed = Pb[P.FOG_SEED] >>> 0;
      const period = Math.max(Pb[P.FOG_PERIOD], 0.1);
      const nz = 0.6 * valueNoise(st[0] / period, seed)
        + 0.4 * valueNoise(st[0] / (0.37 * period), (seed ^ 0xa5a5a5a5) >>> 0);
      let fog = Pb[P.FOG_AMP] * Math.exp(-Math.min(dTop, dBot) / Math.max(Pb[P.FOG_WIDTH], 1e-3)) * (0.3 + 0.7 * nz);
      const nl = Pb[P.N_LEAKS];
      for (let k = 0; k < nl; k += 1) {
        const b = P.LEAKS + 5 * k;
        const dd = Pb[b + 1] < 0.5 ? dTop : dBot;
        const dsv = st[0] - Pb[b];
        fog += Pb[b + 2] * Math.exp((-dsv * dsv) / (2 * Pb[b + 3] * Pb[b + 3])) * Math.exp(-dd / Pb[b + 4]);
      }
      for (let c = 0; c < 3; c += 1) e[c] += fog * Pb[P.FOG_R + c];
    }
    out[3 * i] = e[0];
    out[3 * i + 1] = e[1];
    out[3 * i + 2] = e[2];
  }
  return out;
}

/** ④: where there is no film, the density goes to the hole's cmy. */
function kernelFilmPresent(Pb, cmy, out) {
  const cw = Pb[P.CW];
  const n = cw * Pb[P.CH];
  const hole = [Pb[P.HOLE_C], Pb[P.HOLE_M], Pb[P.HOLE_Y]];
  for (let i = 0; i < n; i += 1) {
    const st = canvasToFilm(Pb, i % cw, Math.floor(i / cw));
    const a = filmAlpha(Pb, st[0], st[1]);
    for (let c = 0; c < 3; c += 1) out[3 * i + c] = a * cmy[3 * i + c] + (1 - a) * hole[c];
  }
  return out;
}

/** ⑤: the scan's view of the holes. */
function kernelLight(Pb, rgb, out) {
  const cw = Pb[P.CW];
  const n = cw * Pb[P.CH];
  const W = Pb[P.FILM_W];
  const pxmm = Pb[P.PX];
  const white = Pb[P.HOLES_LIGHT] > 0.5;
  for (let i = 0; i < n; i += 1) {
    const st = canvasToFilm(Pb, i % cw, Math.floor(i / cw));
    const a = filmAlpha(Pb, st[0], st[1]);
    let light = [Pb[P.LIGHT_R], Pb[P.LIGHT_G], Pb[P.LIGHT_B]];
    const c = [rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]];
    if (Pb[P.PERFORATED] > 0.5) {
      const { d, hole } = perfSdf(Pb, st[0], st[1]);
      const seed = Pb[P.PERF_SEED] >>> 0;
      const h = hole & 0xffff;
      if (d > -0.03 && d < 0.15) {
        const e = 0.003;
        const gx = perfSdf(Pb, st[0] + e, st[1]).d - perfSdf(Pb, st[0] - e, st[1]).d;
        const gy = perfSdf(Pb, st[0], st[1] + e).d - perfSdf(Pb, st[0], st[1] - e).d;
        const gl = Math.max(Math.hypot(gx, gy), 1e-6);
        const nx = gx / gl;
        const ny = gy / gl;
        const perHole = 0.4 + 0.6 * hashF(h, (seed ^ 0xe1) >>> 0);
        const smooth = (edge0, edge1, v) => {
          const t = Math.min(1, Math.max(0, (v - edge0) / (edge1 - edge0)));
          return t * t * (3 - 2 * t);
        };
        const patch = smooth(0.25, 0.75, 0.5 * (valueNoise(st[0] / 0.35, (seed ^ h) >>> 0)
          + valueNoise(st[1] / 0.35, ((seed ^ h) >>> 0) ^ 0x3c)));
        const side = 0.6 + 0.8 * Math.max(0, nx * Pb[P.WALL_VS] + ny * Pb[P.WALL_VT]);
        const k = perHole * patch * side;
        const tint = [
          0.7 + 0.3 * Pb[P.BASE_R], 0.7 + 0.3 * Pb[P.BASE_G], 0.7 + 0.3 * Pb[P.BASE_B]
        ];
        const lam = Pb[P.WALL_SCATTER];
        if (d >= 0) {
          const lift = Pb[P.WALL_GLOW] * k * Math.exp(-d / lam);
          for (let cc = 0; cc < 3; cc += 1) {
            c[cc] += lift * tint[cc] * (white ? light[cc] : 1);
          }
        } else if (white && hashF(h, (seed ^ 0xe4) >>> 0) < 0.5) {
          for (let cc = 0; cc < 3; cc += 1) {
            light[cc] *= 1 - 0.12 * k * (1 - tint[cc]) * Math.exp(d / 0.012);
          }
        }
      }
      if (white && d >= 0) {
        const fl = 0.012 * hashF(h, (seed ^ 0xc4) >>> 0) * (hashF(h, (seed ^ 0xc5) >>> 0) >= 0.5 ? 1 : 0);
        for (let cc = 0; cc < 3; cc += 1) c[cc] += fl * Math.exp(-d / 0.025) * light[cc];
      }
    }
    const onStrip = Pb[P.CARRIER] > 1.5 ? 1 : Math.min(1, Math.max(0, Math.min(st[1], W - st[1]) / pxmm + 0.5));
    const inFilm = onStrip > 0 ? a / onStrip : 0;
    for (let cc = 0; cc < 3; cc += 1) {
      out[3 * i + cc] = Pb[P.CARRIER] * (1 - onStrip) + onStrip * (light[cc] * (1 - inFilm) + c[cc] * inFilm);
    }
  }
  return out;
}

module.exports = {
  P, kQStride, FORMATS, FORMAT_NAMES, GATE_FAMILIES,
  kMaxLeaks, kCarrierMM, kPairAdvanceMM, kMidGrey, kIlfordCode,
  findFormat, edgeLookFor, EDGE_135, EDGE_120,
  dxExtractFor, dxBits,
  overscanLayout, gateShape, holeCmy, paramsBlock,
  canvasToFilm, filmAlpha, gateSdf, perfSdf, penumbra, sdQuad, erfAs,
  hashU, hashF, valueNoise,
  kernelCanvas, kernelFilmPresent, kernelLight
};
