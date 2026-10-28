"use strict";

// The edge print and the date back: what the manufacturer printed on the
// rebate, and what the camera's back exposed onto the negative.
//
// Port of vendor/SpektraLab-1.3.3/engine/src/pipeline/overscan.cpp
// (`seven_seg_polys`, `matrix_text`, the Fujifilm dot faces, `dx_bits`,
// `imprint_groups`) and its rasteriser.
//
// One deliberate substitution: upstream draws the 135 name and frame numbers
// with CoreText (Helvetica Neue), which has no equivalent here. Every mark is
// therefore drawn with the film's own dot faces — the same faces upstream uses
// for Fujifilm's print and for the 5x7 data — instead of inventing a text
// shaper. Placement, sizes, baselines and the DX code are the source's own.

const OS = require("./overscan");
const { Rng, stream, LEVEL } = require("./rng");

const kMidGrey = OS.kMidGrey;
const kDotS = 0.1155;
const kDotT = 0.0984;
const kDotFill = 1.2;
const kDot = 0.114;

// --- the 5x7 dot face ------------------------------------------------------
const G5X7 = {
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x11, 0x1f, 0x11, 0x11], B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a], X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04], Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  m: [0x00, 0x00, 0x1a, 0x15, 0x15, 0x11, 0x11], v: [0x00, 0x00, 0x11, 0x11, 0x11, 0x0a, 0x04],
  s: [0x00, 0x00, 0x0e, 0x10, 0x0e, 0x01, 0x1e], ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  "+": [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00], ":": [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  "'": [0x0c, 0x04, 0x08, 0x00, 0x00, 0x00, 0x00], "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08]
};
const ZERO_UNSLASHED = [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e];

function glyph5x7(ch) {
  if (Object.prototype.hasOwnProperty.call(G5X7, ch)) return G5X7[ch];
  if (ch >= "a" && ch <= "z") return G5X7[ch.toUpperCase()];
  return null;
}

// --- Fujifilm's dot faces --------------------------------------------------
const ROMAN3 = ["#######", ".#.#.#.", ".#.#.#.", ".#.#.#.", ".#.#.#.", ".#.#.#.", ".#.#.#.", ".#.#.#.", "#######"];
const ROMAN2 = ["#######", ".#...#.", ".#...#.", ".#...#.", ".#...#.", ".#...#.", ".#...#.", ".#...#.", "#######"];

const NAMES = {
  A: ["...#...", "..#.#..", ".#...#.", "#.....#", "#.....#", "#######", "#.....#", "#.....#", "#.....#"],
  B: ["######.", "#.....#", "#.....#", "#.....#", "######.", "#.....#", "#.....#", "#.....#", "######."],
  C: [".#####.", "#.....#", "#......", "#......", "#......", "#......", "#......", "#.....#", ".#####."],
  D: ["#####..", ".#...#.", ".#....#", ".#....#", ".#....#", ".#....#", ".#....#", ".#...#.", "#####.."],
  E: ["#######", "#......", "#......", "#......", "#####..", "#......", "#......", "#......", "#######"],
  F: ["#######", "#......", "#......", "#......", "#####..", "#......", "#......", "#......", "#......"],
  G: [".#####.", "#.....#", "#......", "#......", "#..####", "#.....#", "#.....#", "#.....#", ".#####."],
  H: ["#.....#", "#.....#", "#.....#", "#.....#", "#######", "#.....#", "#.....#", "#.....#", "#.....#"],
  I: [".###...", "..#....", "..#....", "..#....", "..#....", "..#....", "..#....", "..#....", ".###..."],
  J: ["....###", ".....#.", ".....#.", ".....#.", ".....#.", ".....#.", "#....#.", ".#..#..", "..##..."],
  K: ["#.....#", "#....#.", "#...#..", "#..#...", "###....", "#..#...", "#...#..", "#....#.", "#.....#"],
  L: ["#......", "#......", "#......", "#......", "#......", "#......", "#......", "#......", "#######"],
  M: ["#.....#", "##...##", "#.#.#.#", "#..#..#", "#..#..#", "#.....#", "#.....#", "#.....#", "#.....#"],
  N: ["#.....#", "##....#", "#.#...#", "#.#...#", "#..#..#", "#...#.#", "#...#.#", "#....##", "#.....#"],
  O: [".#####.", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", ".#####."],
  P: ["######.", "#.....#", "#.....#", "#.....#", "######.", "#......", "#......", "#......", "#......"],
  Q: [".#####.", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#...#.#", "#....#.", ".####.#"],
  R: ["######.", "#.....#", "#.....#", "#.....#", "######.", "#..#...", "#...#..", "#....#.", "#.....#"],
  S: [".#####.", "#.....#", "#......", "#......", ".#####.", "......#", "......#", "#.....#", ".#####."],
  T: ["#######", "...#...", "...#...", "...#...", "...#...", "...#...", "...#...", "...#...", "...#..."],
  U: ["#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", ".#...#.", "..###.."],
  V: ["#.....#", "#.....#", "#.....#", ".#...#.", ".#...#.", "..#.#..", "..#.#..", "...#...", "...#..."],
  W: ["#.....#", "#.....#", "#.....#", "#.....#", "#..#..#", "#..#..#", "#.#.#.#", "##...##", "#.....#"],
  X: ["#.....#", "#.....#", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", "#.....#", "#.....#"],
  Y: ["#.....#", "#.....#", ".#...#.", "..#.#..", "...#...", "...#...", "...#...", "...#...", "...#..."],
  Z: ["#######", "......#", ".....#.", "....#..", "...#...", "..#....", ".#.....", "#......", "#######"],
  0: [".#####.", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", ".#####."],
  1: ["...#...", "..##...", ".#.#...", "...#...", "...#...", "...#...", "...#...", "...#...", ".#####."],
  2: [".#####.", "#.....#", "......#", ".....#.", "....#..", "...#...", "..#....", ".#.....", "#######"],
  3: [".#####.", "#.....#", "......#", "......#", "..####.", "......#", "......#", "#.....#", ".#####."],
  4: [".....#.", "....##.", "...#.#.", "..#..#.", ".#...#.", "#....#.", "#######", ".....#.", ".....#."],
  5: ["#######", "#......", "#......", "#......", "######.", "......#", "......#", "#.....#", ".#####."],
  6: [".#####.", "#.....#", "#......", "#......", "######.", "#.....#", "#.....#", "#.....#", ".#####."],
  7: ["#######", "......#", ".....#.", "....#..", "...#...", "...#...", "..#....", "..#....", "..#...."],
  8: [".#####.", "#.....#", "#.....#", "#.....#", ".#####.", "#.....#", "#.....#", "#.....#", ".#####."],
  9: [".#####.", "#.....#", "#.....#", "#.....#", ".######", "......#", "......#", "#.....#", ".#####."],
  "-": [".......", ".......", ".......", ".......", ".#####.", ".......", ".......", ".......", "......."],
  "+": [".......", "...#...", "...#...", "...#...", "#######", "...#...", "...#...", "...#...", "......."],
  ".": [".......", ".......", ".......", ".......", ".......", ".......", ".......", "..##...", "..##..."],
  "/": ["......#", ".....#.", ".....#.", "....#..", "...#...", "..#....", ".#.....", ".#.....", "#......"]
};

const NUMBERS = {
  0: ["..########..", ".##########.", "############", "####....####", "###......###", "###......###",
    "###......###", "###......###", "###......###", "###......###", "###......###", "###......###",
    "####....####", "############", ".##########.", "..########.."],
  1: [".....###....", "....####....", "...#####....", "..######....", "..######....", ".....###....",
    ".....###....", ".....###....", ".....###....", ".....###....", ".....###....", ".....###....",
    ".....###....", "..#########.", "..#########.", "..#########."],
  2: ["..########..", ".##########.", "############", "####....####", "###......###", ".........###",
    "........####", ".......####.", ".....#####..", "...#####....", "..#####.....", ".####.......",
    "####........", "############", "############", "############"],
  3: ["..########..", ".##########.", "############", "####....####", "###......###", ".........###",
    "........####", "....#######.", "....#######.", "........####", ".........###", "###......###",
    "####....####", "############", ".##########.", "..########.."],
  4: [".......###..", "......####..", ".....#####..", "....######..", "...#######..", "..####.###..",
    ".####..###..", "####...###..", "###....###..", "###....###..", "###....###..", "############",
    "############", "############", ".......###..", ".......###.."],
  5: ["############", "############", "############", "###.........", "###.........", "###.........",
    "##########..", "###########.", "############", "........####", ".........###", "###......###",
    "####....####", "############", ".##########.", "..########.."],
  6: ["..########..", ".##########.", "############", "####....####", "###......###", "###.........",
    "##########..", "###########.", "############", "####....####", "###......###", "###......###",
    "####....####", "############", ".##########.", "..########.."],
  7: ["############", "############", "############", ".........###", ".........###", "........####",
    ".......####.", "......####..", "......####..", ".....####...", ".....####...", "....####....",
    "....####....", "....####....", "....####....", "....####...."],
  8: ["..########..", ".##########.", "############", "####....####", "###......###", "####....####",
    ".##########.", ".##########.", "############", "####....####", "###......###", "###......###",
    "####....####", "############", ".##########.", "..########.."],
  9: ["..########..", ".##########.", "############", "####....####", "###......###", "###......###",
    "####....####", "############", ".###########", "..##########", ".........###", "###......###",
    "####....####", "############", ".##########.", "..########.."],
  A: ["....####....", "...######...", "..########..", ".####..####.", "####....####", "###......###",
    "###......###", "###......###", "###......###", "############", "############", "############",
    "###......###", "###......###", "###......###", "###......###"]
};

const SMALL = {
  0: [".######.", "########", "##....##", "##....##", "##....##", "##....##", "##....##", "##....##", "##....##", "##....##", "########", ".######."],
  1: ["...##...", "..###...", ".####...", "...##...", "...##...", "...##...", "...##...", "...##...", "...##...", "...##...", ".######.", ".######."],
  2: [".######.", "########", "##....##", "......##", ".....###", "....###.", "...###..", "..###...", ".###....", "###.....", "########", "########"],
  3: [".######.", "########", "##....##", "......##", "......##", "..######", "..######", "......##", "......##", "##....##", "########", ".######."],
  4: [".....###", "....####", "...#####", "..######", ".###.###", "###..###", "###..###", "###..###", "########", "########", ".....###", ".....###"],
  5: ["########", "########", "##......", "##......", "#######.", "########", "......##", "......##", "......##", "##....##", "########", ".######."],
  6: [".######.", "########", "##....##", "##......", "##......", "#######.", "########", "##....##", "##....##", "##....##", "########", ".######."],
  7: ["########", "########", "......##", "......##", ".....###", "....###.", "....##..", "...###..", "...##...", "...##...", "...##...", "...##..."],
  8: [".######.", "########", "##....##", "##....##", "##....##", ".######.", ".######.", "##....##", "##....##", "##....##", "########", ".######."],
  9: [".######.", "########", "##....##", "##....##", "##....##", "########", ".#######", "......##", "......##", "##....##", "########", ".######."],
  A: ["...##...", "..####..", ".######.", "###..###", "##....##", "##....##", "########", "########", "##....##", "##....##", "##....##", "##....##"]
};

const FACES = {
  names: { ncol: 7, nrow: 9, advance: 9, glyph: namesGlyph },
  numbers: { ncol: 12, nrow: 16, advance: 18, glyph: numbersGlyph },
  small: { ncol: 8, nrow: 12, advance: 14, glyph: smallGlyph },
  // Upstream has a dedicated 3x5 face for the tiniest marks; it is not ported
  // here, and those roles use the 5x7 face, which reads the same at 0.5 mm.
  tiny: { ncol: 5, nrow: 7, advance: 6, glyph: matrix57Glyph },
  f57: { ncol: 5, nrow: 7, advance: 6, glyph: matrix57Glyph }
};

function namesGlyph(text, i) {
  if (text.slice(i, i + 3) === "III" && (i + 3 === text.length || text[i + 3] === " ")
    && i > 0 && text[i - 1] !== " " && text[i - 1] !== "I") {
    return { rows: ROMAN3, consumed: 3 };
  }
  if (text.slice(i, i + 2) === "II" && (i + 2 === text.length || text[i + 2] === " ")
    && i > 0 && text[i - 1] === " ") {
    return { rows: ROMAN2, consumed: 2 };
  }
  const ch = text[i];
  const up = ch.toUpperCase();
  const rows = Object.prototype.hasOwnProperty.call(NAMES, up) ? NAMES[up] : null;
  return { rows, consumed: 1 };
}

function numbersGlyph(text, i) {
  const ch = text[i];
  const key = (ch >= "0" && ch <= "9") ? ch : (ch === "A" || ch === "a") ? "A" : null;
  return { rows: key ? NUMBERS[key] : null, consumed: 1 };
}

function smallGlyph(text, i) {
  const ch = text[i];
  const key = (ch >= "0" && ch <= "9") ? ch : (ch === "A" || ch === "a") ? "A" : null;
  return { rows: key ? SMALL[key] : null, consumed: 1 };
}

function matrix57Glyph(text, i) {
  const rows = glyph5x7(text[i]);
  return { rows: rows ? rows.map((byte) => {
    let s = "";
    for (let col = 0; col < 5; col += 1) s += (byte & (0x10 >> col)) ? "#" : ".";
    return s;
  }) : null, consumed: 1 };
}

// --- op helpers ------------------------------------------------------------
function polyOp(pts) { return { kind: "poly", pts }; }
function rectOp(s0, t0, s1, t1) { return polyOp([s0, t0, s1, t0, s1, t1, s0, t1]); }
function dotOp(s, t, r) { return { kind: "circle", s, t, r }; }
function textOp(face, cap, s, t, text, options) {
  return Object.assign({ kind: "text", face, cap, s, t, text, hscale: 1, tracking: 0, rot: 0 }, options || {});
}

/**
 * The 5x7 face as an edge printer's: each lit run of cells along a row is one
 * rectangle. `bold` widens every stroke by one cell to the right.
 */
function matrixText(text, cap, xscale, bold, s0, baseT, out) {
  const p = cap / 7;
  const cw = p * xscale;
  const ov = 0.02 * p;
  const ncol = bold ? 6 : 5;
  let x = 0;
  for (const ch of text) {
    const g = ch === "0" ? ZERO_UNSLASHED : glyph5x7(ch);
    if (ch === " " || !g) { x += 4 * cw; continue; }
    for (let row = 0; out && row < 7; row += 1) {
      const bits = bold ? ((g[row] << 1) | g[row]) : g[row];
      const top = bold ? 0x20 : 0x10;
      for (let c = 0; c < ncol;) {
        if (!(bits & (top >> c))) { c += 1; continue; }
        let e = c;
        while (e < ncol && (bits & (top >> e))) e += 1;
        out.push(rectOp(s0 + x + c * cw - ov, baseT - (7 - row) * p - ov,
          s0 + x + e * cw + ov, baseT - (6 - row) * p + ov));
        c = e;
      }
    }
    x += (ncol + 1) * cw;
  }
  return Math.max(0, x - cw);
}

/** Lay `text` out in a dot face; each lit cell becomes one dot. */
function dotText(text, face, ps, pt, d, space, s0, baseT, out) {
  let x = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " ") { x += (face.ncol + 1) * ps + space; i += 1; continue; }
    const g = face.glyph(text, i);
    if (!g || !g.rows) { x += (face.ncol + 1) * ps + space; i += 1; continue; }
    for (let row = 0; row < face.nrow; row += 1) {
      for (let col = 0; col < face.ncol; col += 1) {
        if (g.rows[row][col] !== "#") continue;
        const cs = s0 + x + (col + 0.5) * ps;
        const ct = baseT - (face.nrow - 1 - row + 0.5) * pt;
        if (out) out.push(dotOp(cs, ct, d / 2));
      }
    }
    x += face.advance * ps + space;
    i += g.consumed;
  }
  return Math.max(0, x - space);
}

/** Seven segments, as the data back's LCD (RFC-031 §8). */
function sevenSegPolys(text, h, s0, t0, skew, out) {
  const kSeg = ["abcdef", "bc", "abged", "abgcd", "fgbc", "afgcd", "afgedc", "abc", "abcdefg", "abcdfg"];
  const w = 0.52 * h;
  const th = 0.14 * h;
  let x = 0;
  const rect = (x0, y0, ww, hh) => {
    const pts = [];
    const xs = [x0, x0 + ww, x0 + ww, x0];
    const ys = [y0, y0, y0 + hh, y0 + hh];
    for (let k = 0; k < 4; k += 1) {
      pts.push(s0 + xs[k] + skew * ys[k]);
      pts.push(t0 - ys[k]);
    }
    out.push(polyOp(pts));
  };
  for (const ch of text) {
    if (ch === " ") { x += 0.45 * h; continue; }
    if (ch === "'") { rect(x, 0.72 * h, th, 0.28 * h); x += 0.35 * h; continue; }
    if (ch < "0" || ch > "9") { x += 0.45 * h; continue; }
    const segs = kSeg[Number(ch)];
    const gap = 0.6 * th;
    for (const p of segs) {
      switch (p) {
        case "a": rect(x + gap, h - th, w - 2 * gap, th); break;
        case "g": rect(x + gap, 0.5 * h - 0.5 * th, w - 2 * gap, th); break;
        case "d": rect(x + gap, 0, w - 2 * gap, th); break;
        case "f": rect(x, 0.5 * h + 0.3 * th, th, 0.5 * h - 0.9 * th); break;
        case "b": rect(x + w - th, 0.5 * h + 0.3 * th, th, 0.5 * h - 0.9 * th); break;
        case "e": rect(x, 0.6 * th, th, 0.5 * h - 0.9 * th); break;
        case "c": rect(x + w - th, 0.6 * th, th, 0.5 * h - 0.9 * th); break;
        default: break;
      }
    }
    x += w + 0.28 * h;
  }
}

function sevenSegWidth(text, h) {
  let x = 0;
  for (const ch of text) {
    if (ch === " ") x += 0.45 * h;
    else if (ch === "'") x += 0.35 * h;
    else x += 0.52 * h + 0.28 * h;
  }
  return Math.max(0, x - 0.28 * h);
}

function fitDots(text, slot, face, ps, d, space) {
  let t = text;
  while (t.length && dotText(t, face, ps, ps, d, space, 0, 0, null) > slot) {
    const cut = t.lastIndexOf(" ");
    t = cut > 0 ? t.slice(0, cut) : t.slice(0, t.length - 1);
  }
  return t;
}

// --- the imprint groups ----------------------------------------------------

/**
 * @param {object} L  an overscan layout
 * @param {object} params  { overscan, dateImprint }
 * @param {object} film  { stock }
 * @returns {Array} groups of ops with per-layer exposure
 */
function imprintGroups(L, params, film) {
  const o = params.overscan || {};
  const d = params.dateImprint || {};
  const out = [];
  if (!L || !L.valid) return out;

  const cam = (o.cameraSeed || 1) >>> 0;
  const frm = (o.frameSeed || 1) >>> 0;
  const rf = new Rng(stream(BigInt(frm) ^ (BigInt(cam) << 32n), LEVEL.frame, 7));

  const along = L.vertical ? L.canvas_h : L.canvas_w;
  const sMin = L.cs - 0.75 * along * L.px;
  const sMax = L.cs + 0.75 * along * L.px;
  const look = OS.edgeLookFor((film && film.stock) || "");
  const eEdge = kMidGrey * Math.pow(2, look.ev);
  const groupFor = (rgb, e, blurMm) => ({ ops: [], exposure: rgb.map((c) => c * e), blurMm });

  if (L.perforated) {
    const n0 = (o.frameNumber || 0) > 0 ? o.frameNumber : 1 + (frm % 34);
    const grid0 = L.perf_phase + 0.62;
    const e135 = look.k135 === OS.EDGE_135.FujiSlide ? eEdge * kDotFill : eEdge;
    const top = groupFor(L.edge_rgb, e135, 0.022);
    const bot = groupFor(L.edge_rgb, e135, 0.022);
    const W = L.film_w;
    const fujiNeg = look.k135 === OS.EDGE_135.FujiNeg;
    const ilford = look.k135 === OS.EDGE_135.Ilford;
    const dx = (look.k135 === OS.EDGE_135.Kodak || fujiNeg || ilford) ? OS.dxExtractFor((film && film.stock) || "") : -1;
    const mod = (fujiNeg ? 14.1 : ilford ? 13.06 : 12.7) / 31;
    const clockT0 = W - 2.17;
    const dataT0 = W - 0.87;
    const dataT1 = W + 0.1;

    const dxCode = (s, num, aHalf, dst) => {
      if (dx < 0) return;
      const bits = OS.dxBits(dx, Math.max(0, num), aHalf);
      const clock = new Array(31);
      const data = new Array(31);
      for (let i = 0; i < 31; i += 1) {
        clock[i] = i < 5 || i >= 28 ? 1 : (i - 5) % 2;
        data[i] = i < 5 ? (i % 2 === 0 ? 1 : 0) : (i >= 28 ? ((i - 28) % 2 === 0 ? 1 : 0) : bits[i - 5]);
      }
      for (let track = 0; track < 2; track += 1) {
        const row = track === 0 ? clock : data;
        const ta = track === 0 ? clockT0 : dataT0;
        const tb = (track === 0 ? dataT0 : dataT1) + (track === 0 ? 0.01 : 0);
        for (let i = 0; i < 31;) {
          if (!row[i]) { i += 1; continue; }
          let j = i;
          while (j < 31 && row[j]) j += 1;
          dst.push(rectOp(s + i * mod, ta, s + j * mod, tb));
          i = j;
        }
      }
    };
    const windArrow = (a0, a1, tc, head, halfH) => {
      bot.ops.push(rectOp(a0, tc - 0.09, a1 - 0.75 * head, tc + 0.09));
      bot.ops.push(polyOp([a1 - head, tc - halfH, a1, tc, a1 - head, tc + halfH]));
    };

    const mLo = Math.floor((sMin - grid0) / 19) - 1;
    const mHi = Math.ceil((sMax - grid0) / 19) + 1;
    for (let m = mLo; m <= mHi; m += 1) {
      const s = grid0 + 19 * m
        + (look.k135 === OS.EDGE_135.Kodak || fujiNeg ? 19 : 0);
      const half = 2 * n0 + m;
      const num = Math.floor(half / 2) - (half < 0 && half % 2 ? 1 : 0);
      const aHalf = half % 2 !== 0;

      if (look.k135 === OS.EDGE_135.Kodak || ilford) {
        // The stock name and the full-frame numbers on the top band; the DX
        // code, then the frame number, on the bottom one. Cap heights and
        // baselines are the source's, measured on real strips.
        const light = look.lightNumbers;
        const capT = light ? 1.07 : 1.22;
        const baseT = light ? 1.69 : 1.53;
        if (!aHalf) {
          top.ops.push(textOp(FACES.numbers, capT, s + 16.9, baseT, String(num), { hscale: light ? 1 : 1.25, tracking: light ? 0.04 : 0.25 }));
        } else if (o.edgeText) {
          const s0 = s + (light ? 5.1 : 6.4);
          const slot = 19 + 16.9 - (s0 - s) - 2;
          const text = fitDots(o.edgeText, slot, FACES.names, capT / 9, kDot, 0.3);
          top.ops.push(textOp(FACES.names, capT, s0, baseT, text, { tracking: 0.06 }));
        }
        dxCode(s, num, aHalf, bot.ops);
        if (aHalf) {
          bot.ops.push(textOp(FACES.small, 0.9, s + 15.3, W - 0.84, `${num}A`, { hscale: light ? 1 : 1.25, tracking: light ? 0.03 : 0.25 }));
          windArrow(s + 14.47, s + 18.07, W - 0.28, 0.6, 0.26);
        } else {
          bot.ops.push(textOp(FACES.numbers, 1.4, s + 16.0, W - 0.14, String(num), { hscale: light ? 1 : 1.25, tracking: light ? 0.03 : 0.25 }));
        }
      } else if (fujiNeg || look.k135 === OS.EDGE_135.FujiSlide || look.k135 === OS.EDGE_135.Cine) {
        // Fujifilm's and Eastman's own: numbers on both bands in the dot faces.
        const capBig = 1.22;
        const baseTop = 1.53;
        const baseBot = W - 0.84;
        const numText = aHalf ? `${num}A` : String(num);
        top.ops.push(textOp(FACES.numbers, capBig, s + 16.9, baseTop, numText, { tracking: 0.25 }));
        bot.ops.push(textOp(FACES.numbers, capBig, s + 16.0, baseBot, numText, { tracking: 0.25 }));
        if (o.edgeText) {
          const slot = 12;
          const text = fitDots(o.edgeText, slot, FACES.names, capBig / 9, kDot, 0.3);
          top.ops.push(textOp(FACES.names, capBig, s + 5.4, baseTop, text, { tracking: 0.3 }));
        }
        dxCode(s, num, aHalf, bot.ops);
      }
    }
    if (top.ops.length) out.push(top);
    if (bot.ops.length) out.push(bot);
  } else {
    // 120: numbers and the name on one edge, triangles and digits on the other.
    const W = L.film_w;
    const band = groupFor(L.edge_rgb, eEdge, 0.022);
    const n0 = (o.frameNumber || 0) > 0 ? o.frameNumber : 1 + (frm % 19);
    const s0 = L.gate_s0 + 1.2;
    const baseT = 1.6;
    band.ops.push(textOp(FACES.numbers, 1.5, s0, baseT, String(n0), { tracking: 0.25 }));
    if (o.edgeText) {
      const text = fitDots(o.edgeText, 22, FACES.names, 1.5 / 9, kDot, 0.3);
      band.ops.push(textOp(FACES.names, 1.5, s0 + 8, baseT, text, { tracking: 0.3 }));
    }
    const other = groupFor(L.edge_rgb, eEdge, 0.022);
    other.ops.push(polyOp([s0 + 0.0, W - 1.9, s0 + 1.6, W - 0.5, s0 + 3.2, W - 1.9]));
    other.ops.push(textOp(FACES.small, 1.1, s0 + 4.5, W - 1.4, String(n0), { tracking: 0.2 }));
    out.push(band);
    out.push(other);
  }

  // --- the date back (RFC-031) -------------------------------------------
  if (d.active) {
    const eDate = kMidGrey * Math.pow(2, (d.exposureEv === undefined ? 3.5 : d.exposureEv));
    const group = groupFor(L.date_rgb, eDate, 0.03);
    const frames = (d.pair && d.textB) ? [d.text, d.textB] : [d.text || ""];
    frames.forEach((text, index) => {
      if (!text) return;
      const cap = 1.35 * (d.size === undefined ? 1 : d.size);
      if (d.placement === "rebate") {
        // Between frames on 135, in the lower rebate on 120.
        const s0 = L.gate_s0 + (index === 1 ? L.pair_adv || OS.kPairAdvanceMM : 0) + 1.0;
        const baseT = L.gate_t0 + L.gate_across + (L.perforated ? 1.0 : 1.4);
        if (d.style === "dots") dotText(text, FACES.f57, cap / 7, cap / 7, kDot, 0.3, s0, baseT, group.ops);
        else if (d.style === "data") matrixText(d.dataText || text, cap, 1, false, s0, baseT, group.ops);
        else sevenSegPolys(text, cap, s0, baseT, 0.18, group.ops);
        return;
      }
      // In the picture: a corner of the gate, insets from its sides.
      const insetX = d.insetX === undefined ? 3 : d.insetX;
      const insetY = d.insetY === undefined ? 2.4 : d.insetY;
      const shift = index === 1 ? (L.pair_adv || OS.kPairAdvanceMM) : 0;
      const right = /r$/.test(d.corner || "br");
      const bottom = /^b/.test(d.corner || "br");
      let w;
      if (d.style === "dots") w = dotText(text, FACES.f57, cap / 7, cap / 7, kDot, 0.3, 0, 0, null);
      else if (d.style === "data") w = matrixText(d.dataText || text, cap, 1, false, 0, 0, null);
      else w = sevenSegWidth(text, cap);
      const sx = right
        ? L.gate_s0 + shift + L.gate_along - insetX - w
        : L.gate_s0 + shift + insetX;
      const ty = bottom
        ? L.gate_t0 + L.gate_across - insetY
        : L.gate_t0 + insetY + cap;
      if (d.style === "dots") dotText(text, FACES.f57, cap / 7, cap / 7, kDot, 0.3, sx, ty, group.ops);
      else if (d.style === "data") matrixText(d.dataText || text, cap, 1, false, sx, ty, group.ops);
      else sevenSegPolys(text, cap, sx, ty, 0.18, group.ops);
    });
    if (group.ops.length) out.push(group);
  }
  void rf;
  return out;
}

// --- rasterisation ---------------------------------------------------------

function filmToCanvasPx(L, s, t) {
  const a = L.A[0];
  const b = L.A[1];
  const c = L.A[2];
  const dd = L.A[3];
  const det = a * dd - b * c;
  const dsv = s - L.cs;
  const dtv = t - L.ct;
  const u = (dd * dsv - b * dtv) / det + L.cu;
  const v = (-c * dsv + a * dtv) / det + L.cv;
  return [u / L.px, v / L.px];
}

function pointInPolygon(px, py, pts) {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const xi = pts[2 * i];
    const yi = pts[2 * i + 1];
    const xj = pts[2 * j];
    const yj = pts[2 * j + 1];
    if ((yi > py) !== (yj > py)
      && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function blurMask(cov, w, h, sigma) {
  if (!(sigma > 0.3)) return cov;
  const r = Math.ceil(3 * sigma);
  const kernel = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i += 1) {
    kernel[i + r] = Math.exp((-0.5 * i * i) / (sigma * sigma));
    sum += kernel[i + r];
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;
  const tmp = new Float64Array(cov.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let acc = 0;
      for (let i = -r; i <= r; i += 1) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        acc += cov[y * w + xx] * kernel[i + r];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let acc = 0;
      for (let i = -r; i <= r; i += 1) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        cov[y * w + x] = 0;
        acc += tmp[yy * w + x] * kernel[i + r];
      }
      cov[y * w + x] = acc;
    }
  }
  return cov;
}

/** Collect the ops of a group into a list of film-space shapes (mm). */
function opShapes(L, group, ops) {
  for (const op of ops) {
    if (op.kind === "poly") { group.polys.push(op.pts); continue; }
    if (op.kind === "circle") {
      group.dots.push([op.s, op.t, op.r]);
      continue;
    }
    // Text: the film's own dot faces.
    const face = typeof op.face === "string" ? FACES[op.face] : op.face;
    const cap = op.cap;
    const ps = cap / (face.nrow === 16 ? 16 : face.nrow === 12 ? 12 : face.nrow === 9 ? 9 : 7);
    const emitted = [];
    if (face === FACES.f57) {
      matrixText(op.text, cap, op.hscale || 1, false, op.s, op.t, emitted);
    } else {
      dotText(op.text, face, ps * (op.hscale || 1), ps, kDot, op.tracking || 0, op.s, op.t, emitted);
    }
    for (const sub of emitted) {
      if (sub.kind === "poly") group.polys.push(sub.pts);
      else if (sub.kind === "circle") group.dots.push([sub.s, sub.t, sub.r]);
    }
  }
  void L;
}

/**
 * Rasterise a group into a canvas-aligned coverage bitmap (its bounding box).
 * @returns {{ cov: Float32Array, x0: number, y0: number, w: number, h: number } | null}
 */
function rasterise(L, group) {
  const shapes = { polys: [], dots: [] };
  opShapes(L, shapes, group.ops);
  let xmin = 1e30; let ymin = 1e30; let xmax = -1e30; let ymax = -1e30;
  const grow = (s, t) => {
    const [x, y] = filmToCanvasPx(L, s, t);
    xmin = Math.min(xmin, x);
    ymin = Math.min(ymin, y);
    xmax = Math.max(xmax, x);
    ymax = Math.max(ymax, y);
  };
  for (const pts of shapes.polys) {
    for (let k = 0; k + 1 < pts.length; k += 2) grow(pts[k], pts[k + 1]);
  }
  for (const [s, t, r] of shapes.dots) { grow(s - r, t - r); grow(s + r, t + r); }
  if (xmin > xmax) return null;
  const pad = 3 + (3 * group.blurMm) / L.px;
  const x0 = Math.max(0, Math.floor(xmin - pad));
  const y0 = Math.max(0, Math.floor(ymin - pad));
  const x1 = Math.min(L.canvas_w, Math.ceil(xmax + pad));
  const y1 = Math.min(L.canvas_h, Math.ceil(ymax + pad));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;

  // Shapes in canvas pixel space.
  const polysPx = shapes.polys.map((pts) => {
    const out = [];
    for (let k = 0; k + 1 < pts.length; k += 2) {
      const [x, y] = filmToCanvasPx(L, pts[k], pts[k + 1]);
      out.push(x - x0, y - y0);
    }
    return out;
  });
  const dotsPx = shapes.dots.map(([s, t, r]) => {
    const [x, y] = filmToCanvasPx(L, s, t);
    return [x - x0, y - y0, r / L.px];
  });

  const cov = new Float32Array(w * h);
  const SUB = 3;
  const inv = 1 / (SUB * SUB);
  const offsets = [];
  for (let sy = 0; sy < SUB; sy += 1) {
    for (let sx = 0; sx < SUB; sx += 1) offsets.push([(sx + 0.5) / SUB - 0.5, (sy + 0.5) / SUB - 0.5]);
  }
  // Each shape paints only its own bounding box: the edge print's bands are
  // wide but nearly empty, and a full-canvas scan over every glyph is what
  // made "Film Edge is slow" upstream too.
  const paint = (px, py, inside) => {
    if (!inside) return;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return;
    cov[iy * w + ix] += inv;
  };
  for (const pts of polysPx) {
    let bx0 = Infinity; let by0 = Infinity; let bx1 = -Infinity; let by1 = -Infinity;
    for (let k = 0; k + 1 < pts.length; k += 2) {
      bx0 = Math.min(bx0, pts[k]); bx1 = Math.max(bx1, pts[k]);
      by0 = Math.min(by0, pts[k + 1]); by1 = Math.max(by1, pts[k + 1]);
    }
    const x0p = Math.max(0, Math.floor(bx0));
    const x1p = Math.min(w - 1, Math.ceil(bx1));
    const y0p = Math.max(0, Math.floor(by0));
    const y1p = Math.min(h - 1, Math.ceil(by1));
    for (let y = y0p; y <= y1p; y += 1) {
      for (let x = x0p; x <= x1p; x += 1) {
        for (const [ox, oy] of offsets) {
          paint(x, y, pointInPolygon(x + 0.5 + ox, y + 0.5 + oy, pts));
        }
      }
    }
  }
  for (const [cx, cy, r] of dotsPx) {
    const x0p = Math.max(0, Math.floor(cx - r));
    const x1p = Math.min(w - 1, Math.ceil(cx + r));
    const y0p = Math.max(0, Math.floor(cy - r));
    const y1p = Math.min(h - 1, Math.ceil(cy + r));
    const rr = r * r;
    for (let y = y0p; y <= y1p; y += 1) {
      for (let x = x0p; x <= x1p; x += 1) {
        for (const [ox, oy] of offsets) {
          const dx = x + 0.5 + ox - cx;
          const dy = y + 0.5 + oy - cy;
          paint(x, y, dx * dx + dy * dy <= rr);
        }
      }
    }
  }
  for (let i = 0; i < cov.length; i += 1) if (cov[i] > 1) cov[i] = 1;
  blurMask(cov, w, h, group.blurMm / L.px);
  return { cov, x0, y0, w, h };
}

/** Add a rasterised group's coverage to the canvas as exposure. */
function addMask(canvas, L, group, bitmap) {
  const { cov, x0, y0, w, h } = bitmap;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const c = cov[y * w + x];
      if (c <= 0) continue;
      const px = x0 + x;
      const py = y0 + y;
      if (px < 0 || py < 0 || px >= L.canvas_w || py >= L.canvas_h) continue;
      const o = 3 * (py * L.canvas_w + px);
      for (let ch = 0; ch < 3; ch += 1) canvas[o + ch] += c * group.exposure[ch];
    }
  }
  return canvas;
}

module.exports = {
  FACES, NAMES, NUMBERS, SMALL, G5X7,
  glyph5x7, namesGlyph, numbersGlyph, smallGlyph, matrix57Glyph,
  matrixText, dotText, sevenSegPolys, sevenSegWidth, fitDots,
  imprintGroups, rasterise, addMask, filmToCanvasPx, pointInPolygon,
  kDotS, kDotT, kDot, kDotFill
};
