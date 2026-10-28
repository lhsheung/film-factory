"use strict";

// The film and paper profiles, and their measured characteristic curves.
//
// Reads the upstream data in
// vendor/SpektraLab-1.3.3/engine/resources{,product}/profiles — the same files
// the C++ engine loads — and evaluates the density curves the way
// `core/curves.cpp` does: a table lookup with linear interpolation on
// log10 exposure, per channel.

const fs = require("node:fs");
const path = require("node:path");

const VENDOR = path.resolve(__dirname, "..", "..", "vendor", "SpektraLab-1.3.3", "engine");
// `assets/profiles` is the packaged copy of the same files, so the app does not
// have to ship the whole upstream source tree; `vendor` wins when both exist.
const BUNDLED = path.resolve(__dirname, "..", "..", "assets", "profiles");
const RESOURCE_DIRS = ["resources", "resources_product"];

function flattenTriplets(rows) {
  const out = new Float64Array(rows.length * 3);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    for (let c = 0; c < 3; c += 1) {
      const v = Array.isArray(row) ? row[c] : row;
      out[3 * i + c] = v === null || v === undefined ? NaN : Number(v);
    }
  }
  return out;
}

function flattenScalars(rows) {
  const out = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const v = rows[i];
    out[i] = v === null || v === undefined ? NaN : Number(v);
  }
  return out;
}

const cache = new Map();

function profileDirectories() {
  const dirs = [BUNDLED, ...RESOURCE_DIRS.map((dir) => path.join(VENDOR, dir, "profiles"))];
  return dirs.filter((dir) => fs.existsSync(dir));
}

function listStocks() {
  const names = [];
  for (const dir of profileDirectories()) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const stock = file.slice(0, -5);
      if (!names.includes(stock)) names.push(stock);
    }
  }
  return names.sort();
}

/**
 * Load one profile. The arrays the C++ flattens to (81, 3) are returned the
 * same way; missing measurements stay NaN, as `spectral.cpp` expects.
 */
function loadProfile(stock) {
  if (cache.has(stock)) return cache.get(stock);
  for (const dir of profileDirectories()) {
    const file = path.join(dir, `${stock}.json`);
    if (!fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const data = json.data || {};
    const profile = {
      stock,
      name: (json.info && json.info.name) || stock,
      type: (json.info && json.info.type) || "negative",
      support: (json.info && json.info.support) || "film",
      referenceIlluminant: (json.info && json.info.reference_illuminant) || "D55",
      viewingIlluminant: (json.info && json.info.viewing_illuminant) || "D50",
      wavelengths: flattenScalars(data.wavelengths || []),
      logSensitivity: flattenTriplets(data.log_sensitivity || []),
      channelDensity: flattenTriplets(data.channel_density || []),
      baseDensity: flattenScalars(data.base_density || []),
      logExposure: flattenScalars(data.log_exposure || []),
      densityCurves: flattenTriplets(data.density_curves || []),
      densityCurvesLayers: flattenTriplets(data.density_curves_layers || []),
      source: file
    };
    cache.set(stock, profile);
    return profile;
  }
  throw new Error(`找不到胶片档案：${stock}`);
}

/** Linear interpolation on a monotone table; NaN rows are skipped. */
function interpTable(xs, ys, x, stride, channel) {
  const n = xs.length;
  if (!n) return NaN;
  if (x <= xs[0]) return ys[stride * 0 + channel];
  if (x >= xs[n - 1]) return ys[stride * (n - 1) + channel];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const y0 = ys[stride * lo + channel];
  const y1 = ys[stride * hi + channel];
  if (!Number.isFinite(y0)) return y1;
  if (!Number.isFinite(y1)) return y0;
  const span = xs[hi] - xs[lo];
  if (span <= 0) return y0;
  const t = (x - xs[lo]) / span;
  return y0 + (y1 - y0) * t;
}

/**
 * The profile's density for a log10 exposure, per channel.
 * @returns {number[]} three densities (red-, green-, blue-sensitive layer)
 */
function density(profile, logE) {
  return [0, 1, 2].map((c) => interpTable(profile.logExposure, profile.densityCurves, logE, 3, c));
}

/** The film's neutral printing-density gamma (green), for the DI's reversal. */
function greenGamma(profile) {
  const n = profile.logExposure.length;
  if (n < 2) return 0;
  const lo = Math.floor(n * 0.35);
  const hi = Math.floor(n * 0.65);
  const dLo = interpTable(profile.logExposure, profile.densityCurves, profile.logExposure[lo], 3, 1);
  const dHi = interpTable(profile.logExposure, profile.densityCurves, profile.logExposure[hi], 3, 1);
  const span = profile.logExposure[hi] - profile.logExposure[lo];
  return Math.abs(span) > 1e-9 ? (dHi - dLo) / span : 0;
}

module.exports = { loadProfile, listStocks, density, greenGamma, interpTable, VENDOR, profileDirectories };
