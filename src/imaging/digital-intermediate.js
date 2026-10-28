"use strict";

// RFC-028 Digital Intermediate: the Cineon-style log the DI writes, and the
// live print controls' per-channel offset.
//
// Port of vendor/SpektraLab-1.3.3/engine/src/core/digital_intermediate.hpp/.cpp.
//
// Kodak's Cineon convention, exactly as the standard decoders apply it:
//
//     code = (685 + 300 * log10(L * (1 - b) + b)) / 1023,  b = 10^((95 - 685) / 300)
//
// reference white 685 (L = 1), reference black 95 (L = 0: the film base),
// 0.002 density per code and a negative gamma of 0.6 (300 codes per decade).

const kDiCineonWhite = 685.0;
const kDiCineonBlack = 95.0;
const kDiCineonPerDecade = 300.0;
const kDiCineonMax = 1023.0;
const kDiCineonNegativeGamma = 0.002 * kDiCineonPerDecade;

function cineonBlackOffset() {
  return Math.pow(10, (kDiCineonBlack - kDiCineonWhite) / kDiCineonPerDecade);
}

function cineonDecode(code01) {
  const b = cineonBlackOffset();
  return (Math.pow(10, (code01 * kDiCineonMax - kDiCineonWhite) / kDiCineonPerDecade) - b) / (1 - b);
}

function cineonEncode(L) {
  const b = cineonBlackOffset();
  const v = Math.max(0, L) * (1 - b) + b;
  return (kDiCineonWhite + kDiCineonPerDecade * Math.log10(Math.max(v, 1e-12))) / kDiCineonMax;
}

/**
 * The per-channel log10 offset the live print controls give the DI positive.
 * Print brightness: `print_exposure = 2^-stops`, so one UI stop is one stop of
 * the positive. The filter shifts move blue against green by 0.050 stop (Y)
 * and green against red and blue by ~0.03 stop (M) at mid grey.
 */
function liveOffsets(params = {}) {
  const printExposure = Math.max(1e-6, params.printExposure === undefined ? 1 : params.printExposure);
  const k = -Math.log10(printExposure);
  const stop = Math.log10(2);
  const scale = params.filterShiftScale === undefined ? 1 : params.filterShiftScale;
  const m = params.mFilterShift || 0;
  const y = params.yFilterShift || 0;
  return [k, k + m * scale * 0.03 * stop, k + y * scale * 0.05 * stop];
}

/**
 * Encode the DI positive as Cineon.
 * @param {Float32Array|Float64Array} positive  linear positive, 3 per pixel,
 *   the film base already subtracted.
 * @param {object} options  { offsets: [3] log10 offsets, floor: positive of
 *   clear film base }
 * @returns {Float32Array} code values in [0, 1], 3 per pixel
 */
function encode(positive, options = {}) {
  const offsets = options.offsets || [0, 0, 0];
  const floor = options.floor || 0;
  const out = new Float32Array(positive.length);
  for (let i = 0; i < positive.length; i += 3) {
    for (let c = 0; c < 3; c += 1) {
      const l = Math.max(0, positive[i + c] - floor) * Math.pow(10, offsets[c]);
      out[i + c] = Math.min(1, Math.max(0, cineonEncode(l)));
    }
  }
  return out;
}

/** Decode Cineon code values back to the linear positive. */
function decode(codes) {
  const out = new Float32Array(codes.length);
  for (let i = 0; i < codes.length; i += 1) out[i] = cineonDecode(codes[i]);
  return out;
}

/** Pack code01 values into 10-bit Cineon words (a DPX/Cineon writer's payload). */
function pack10bit(codes) {
  const out = new Uint32Array(codes.length);
  for (let i = 0; i < codes.length; i += 1) {
    out[i] = Math.min(1023, Math.max(0, Math.round(codes[i] * kDiCineonMax)));
  }
  return out;
}

module.exports = {
  kDiCineonWhite, kDiCineonBlack, kDiCineonPerDecade, kDiCineonMax, kDiCineonNegativeGamma,
  cineonBlackOffset, cineonEncode, cineonDecode,
  liveOffsets, encode, decode, pack10bit
};
