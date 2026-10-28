"use strict";

// RFC-023 Scene Latitude Mapping — a faithful port of
// vendor/SpektraLab-1.3.3/engine/src/shaders/scene_latitude.metal.
//
// One pointwise kernel applied before the spectral upsample: a positive scalar
// gain per pixel computed on the stop axis and applied to the linear triple.
// The signal never becomes log; log2/exp2 only compute the gain.

const MID_GREY = 0.184;

/** `g_m(D) - D`, the branch's departure, exactly 0 at D = 0. */
function slmDeparture(D, H, m) {
  if (!(D > 0)) return 0;
  if (m === 2) {
    const r = Math.sqrt(H * H + D * D);
    return -(D * D * D) / (r * (H + r));
  }
  if (m === 1) return -(D * D) / (H + D);
  return D * (H / Math.pow(Math.pow(H, m) + Math.pow(D, m), 1 / m) - 1);
}

function normValue(cr, cg, cb, norm, yRow) {
  if (norm === "y") return yRow[0] * cr + yRow[1] * cg + yRow[2] * cb;
  if (norm === "max") return Math.max(cr, Math.max(cg, cb));
  const s2 = cr * cr + cg * cg + cb * cb;
  return s2 > 0 ? (cr * cr * cr + cg * cg * cg + cb * cb * cb) / s2 : 0;
}

/**
 * @param {Float32Array} rgb  interleaved linear RGB, length 3 * n
 * @param {object} options
 *   width, height: the frame's size (a whole render, or the band's frame)
 *   row0: the band's first row in the frame (0 for a whole render)
 *   norm: "power" | "y" | "max"
 *   highlightKnee, highlightRoom, shadowKnee, shadowRoom, rolloff, maxLift
 *   split, bHighlightKnee, bHighlightRoom, bShadowKnee, bShadowRoom
 *   nRef: the metered mid-grey scalar (default 0.184)
 *   yRow: the working space's RGB -> XYZ Y row (default Rec.709)
 * @returns {Float32Array} a new buffer
 */
function apply(rgb, options = {}) {
  const n = Math.floor(rgb.length / 3);
  const out = new Float32Array(rgb.length);
  const width = Math.max(1, options.width || n);
  const height = Math.max(1, options.height || 1);
  const row0 = options.row0 || 0;
  const norm = options.norm || "power";
  const yRow = options.yRow || [0.2126, 0.7152, 0.0722];
  const nRef = options.nRef === undefined ? MID_GREY : options.nRef;
  const m = options.rolloff === undefined ? 2 : options.rolloff;
  const L = options.maxLift === undefined ? 4 : options.maxLift;
  const split = options.split || 0;
  const Kh = options.highlightKnee === undefined ? 2 : options.highlightKnee;
  const Hh = options.highlightRoom === undefined ? 0 : options.highlightRoom;
  const Ks = options.shadowKnee === undefined ? -2 : options.shadowKnee;
  const Hs = options.shadowRoom === undefined ? 0 : options.shadowRoom;
  const bKh = options.bHighlightKnee === undefined ? 2 : options.bHighlightKnee;
  const bHh = options.bHighlightRoom === undefined ? 0 : options.bHighlightRoom;
  const bKs = options.bShadowKnee === undefined ? -2 : options.bShadowKnee;
  const bHs = options.bShadowRoom === undefined ? 0 : options.bShadowRoom;

  for (let i = 0; i < n; i += 1) {
    const r = rgb[3 * i];
    const g = rgb[3 * i + 1];
    const b = rgb[3 * i + 2];
    const cr = Math.max(r, 0);
    const cg = Math.max(g, 0);
    const cb = Math.max(b, 0);

    const v = normValue(cr, cg, cb, norm, yRow);
    let k = 1;
    if (v > 0 && Number.isFinite(v)) {
      const E = Math.min(24, Math.max(-24, Math.log2(Math.max(v, nRef * Math.pow(2, -24)) / nRef)));
      let d = 0;
      // A half-frame pair: from `split` along the long edge, the second frame's
      // own knees and rooms.
      let kh = Kh;
      let hh = Hh;
      let ks = Ks;
      let hs = Hs;
      if (split > 0) {
        const along = width >= height
          ? ((i % width) + 0.5) / width
          : (Math.floor(i / width) + row0 + 0.5) / height;
        if (along >= split) { kh = bKh; hh = bHh; ks = bKs; hs = bHs; }
      }
      if (hh > 0 && E > kh) d = slmDeparture(E - kh, hh, m);
      else if (hs > 0 && E < ks) d = -slmDeparture(ks - E, hs, m);
      if (d > 0) d = (d * L) / Math.sqrt(L * L + d * d);
      k = Math.min(Math.pow(2, 30), Math.max(Math.pow(2, -30), Math.pow(2, d)));
    }
    out[3 * i] = r * k;
    out[3 * i + 1] = g * k;
    out[3 * i + 2] = b * k;
  }
  return out;
}

module.exports = { apply, slmDeparture, MID_GREY };
