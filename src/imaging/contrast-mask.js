"use strict";

// RFC-024 virtual contrast mask — a faithful port of
// vendor/SpektraLab-1.3.3/engine/src/shaders/contrast_mask.metal.
//
// A neutral spatial gain on the enlarger's image exposure, applied *before*
// the pre-flash offset is added:
//
//     today:   E = max(a * gain + flash, 0) + 1e-10
//     masked:  E = max(2^delta * (a * gain) + flash, 0) + 1e-10
//
// The mask's coordinate `x` is the equal-weight mean over the three paper
// channels of log2(A_c / A_ref_c); x = 0 is the negative's own mid-grey.
//
// In this app `a` is the print-domain image exposure our own pipeline derives,
// not the 81-wavelength spectral exposure the upstream kernel integrates — the
// curve, the grid, the guided base and the epilogue are the kernel's own.

const LOG2_FLOOR = -20;

/** `mask_x`: the mask's coordinate, in stops relative to mid-grey. */
function maskX(a, invAref) {
  let s = 0;
  for (let c = 0; c < 3; c += 1) {
    const r = Math.max(a[c] * invAref[c], 0);
    const l = r > 0 ? Math.log2(r) : -Infinity;
    s += Math.max(Number.isFinite(l) ? l : -Infinity, LOG2_FLOOR);
  }
  return s / 3;
}

/** RFC-023's m = 2 branch: slope 1 at the knee, asymptote H. */
function maskG(d, h) {
  return (d * h) / Math.sqrt(h * h + d * d);
}

function maskDelta(b, p) {
  let delta = 0;
  if (p.loOn && b < p.kLo) {
    const d = p.kLo - b;
    delta = d - maskG(d, p.hLo);
  } else if (p.hiOn && b > p.kHi) {
    const d = b - p.kHi;
    delta = maskG(d, p.hHi) - d;
  }
  const lim = p.limit;
  return (delta * lim) / Math.sqrt(lim * lim + delta * delta);
}

/**
 * The analysis: the mean of `x` over each cell of a gw x gh grid. Cells
 * partition the frame, so every pixel is counted exactly once.
 */
function reduce(a, width, height, gw, gh, invAref) {
  const grid = new Float64Array(gw * gh);
  for (let cy = 0; cy < gh; cy += 1) {
    const y0 = Math.floor((cy * height) / gh);
    const y1 = Math.min(Math.max(Math.floor(((cy + 1) * height) / gh), y0 + 1), height);
    for (let cx = 0; cx < gw; cx += 1) {
      const x0 = Math.floor((cx * width) / gw);
      const x1 = Math.min(Math.max(Math.floor(((cx + 1) * width) / gw), x0 + 1), width);
      let acc = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = 3 * (y * width + x);
          acc += maskX([a[i], a[i + 1], a[i + 2]], invAref);
        }
      }
      grid[cy * gw + cx] = acc / Math.max(1, (x1 - x0) * (y1 - y0));
    }
  }
  return grid;
}

function sampleBilinear(coef, gw, gh, width, height, px, py) {
  const u = Math.min(gw - 1, Math.max(0, ((px + 0.5) * gw) / width - 0.5));
  const v = Math.min(gh - 1, Math.max(0, ((py + 0.5) * gh) / height - 0.5));
  const u0 = Math.floor(u);
  const v0 = Math.floor(v);
  const u1 = Math.min(u0 + 1, gw - 1);
  const v1 = Math.min(v0 + 1, gh - 1);
  const tu = u - u0;
  const tv = v - v0;
  const at = (x, y, k) => coef[2 * (y * gw + x) + k];
  const a = at(u0, v0, 0) * (1 - tu) + at(u1, v0, 0) * tu;
  const b = at(u0, v1, 0) * (1 - tu) + at(u1, v1, 0) * tu;
  const c = at(u0, v0, 1) * (1 - tu) + at(u1, v0, 1) * tu;
  const d = at(u0, v1, 1) * (1 - tu) + at(u1, v1, 1) * tu;
  return [a * (1 - tv) + b * tv, c * (1 - tv) + d * tv];
}

/** Separate Gaussian on a gw x gh grid, edges extended. */
function blurGrid(grid, gw, gh, sigma) {
  const out = new Float64Array(grid.length);
  if (!(sigma > 0.05)) { out.set(grid); return out; }
  const r = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i += 1) {
    kernel[i + r] = Math.exp((-0.5 * i * i) / (sigma * sigma));
    sum += kernel[i + r];
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;
  const tmp = new Float64Array(grid.length);
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      let acc = 0;
      for (let i = -r; i <= r; i += 1) {
        const xx = Math.min(gw - 1, Math.max(0, x + i));
        acc += grid[y * gw + xx] * kernel[i + r];
      }
      tmp[y * gw + x] = acc;
    }
  }
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      let acc = 0;
      for (let i = -r; i <= r; i += 1) {
        const yy = Math.min(gh - 1, Math.max(0, y + i));
        acc += tmp[yy * gw + x] * kernel[i + r];
      }
      out[y * gw + x] = acc;
    }
  }
  return out;
}

/**
 * @param {Float32Array} a  interleaved image exposure (3 per pixel), the
 *   enlarger's `A` before pre-flash.
 * @param {object} options
 *   width, height, row0
 *   gain[3]: the enlarger's setup gain
 *   invAref[3]: 1 / A_ref (the negative's mid-grey through the same enlarger)
 *   flash[3]: the pre-flash offset
 *   core: half-width of the identity core, stops
 *   highlights, shadows: stops, print-highlight / print-shadow sides
 *   scale: the base extractor's sigma as a fraction of the long edge
 *   limit: the gain limit, stops
 *   scheme: "gaussian" (the only product scheme)
 * @returns {{ exposure: Float32Array, logOut: Float32Array, grid: Float64Array }}
 */
function apply(a, options = {}) {
  const width = options.width;
  const height = options.height;
  const row0 = options.row0 || 0;
  const gain = options.gain || [1, 1, 1];
  const invAref = options.invAref || [1, 1, 1];
  const flash = options.flash || [0, 0, 0];
  const core = options.core === undefined ? 1 : options.core;
  const highlights = options.highlights || 0;
  const shadows = options.shadows || 0;
  const scale = options.scale === undefined ? 0.03 : options.scale;
  const limit = options.limit === undefined ? 4 : options.limit;
  const longEdge = Math.max(width, height);
  const side = Math.max(2, Math.round(longEdge * Math.min(0.5, scale)));
  const gw = side;
  const gh = Math.max(2, Math.round((side * Math.min(width, height)) / longEdge));

  const scaled = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 3) {
    for (let c = 0; c < 3; c += 1) scaled[i + c] = a[i + c] * gain[c];
  }

  const grid = reduce(scaled, width, height, gw, gh, invAref);
  // The classic unsharp mask: the base is the blurred coordinate itself, so the
  // guided filter's coefficients are a = 0, b = blur(x).
  const blurred = blurGrid(grid, gw, gh, Math.max(1, side * 0.06));
  const coef = new Float64Array(gw * gh * 2);
  for (let i = 0; i < gw * gh; i += 1) {
    coef[2 * i] = 0;
    coef[2 * i + 1] = blurred[i];
  }

  const p = {
    kLo: -core,
    hLo: Math.max(1e-6, Math.abs(highlights)),
    loOn: Math.abs(highlights) > 0,
    kHi: core,
    hHi: Math.max(1e-6, Math.abs(shadows)),
    hiOn: Math.abs(shadows) > 0,
    limit
  };

  const exposure = new Float32Array(a.length);
  const logOut = new Float32Array(a.length);
  const rows = Math.floor(a.length / 3 / width);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = 3 * (y * width + x);
      const av = [scaled[i], scaled[i + 1], scaled[i + 2]];
      const ab = sampleBilinear(coef, gw, gh, width, height, x, row0 + y);
      const base = ab[0] * maskX(av, invAref) + ab[1];
      const k = Math.pow(2, maskDelta(base, p));
      for (let c = 0; c < 3; c += 1) {
        const e = Math.max(k * av[c] + flash[c], 0) + 1e-10;
        exposure[i + c] = e;
        logOut[i + c] = Math.log10(e);
      }
    }
  }
  return { exposure, logOut, grid };
}

module.exports = { apply, reduce, maskX, maskDelta, maskG, LOG2_FLOOR };
