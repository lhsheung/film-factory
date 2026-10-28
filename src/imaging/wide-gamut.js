"use strict";

// Wide-gamut and 16-bit output: working-space primaries, a matrix-shaper ICC
// profile synthesised from them, and a minimal TIFF writer that carries it.
//
// Upstream converts through lcms (`spk_output_transform`). There is no colour
// management library here, so the primaries are the published ones, adapted to
// the ICC's D50 white with Bradford, and the profile is written directly.

const PRIMARIES = {
  srgb: { name: "sRGB", xy: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], white: "D65", gamma: 2.4 },
  display_p3: { name: "Display P3", xy: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], white: "D65", gamma: 2.4 },
  rec2020: { name: "Rec. 2020", xy: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]], white: "D65", gamma: 2.4 },
  prophoto: { name: "ProPhoto RGB", xy: [[0.7347, 0.2653], [0.1596, 0.8404], [0.0366, 0.0001]], white: "D50", gamma: 1.8 }
};

const WHITES = {
  D50: [0.96422, 1.0, 0.82521],
  D65: [0.95047, 1.0, 1.08883]
};

function xyToXYZ(x, y) {
  if (y === 0) return [0, 0, 0];
  return [x / y, 1, (1 - x - y) / y];
}

function mul3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  ];
}

function mul3x3(a, b) {
  const out = new Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[3 * r + c] = a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c];
    }
  }
  return out;
}

function inv3(m) {
  const c00 = m[4] * m[8] - m[5] * m[7];
  const c01 = -(m[3] * m[8] - m[5] * m[6]);
  const c02 = m[3] * m[7] - m[4] * m[6];
  const c10 = -(m[1] * m[8] - m[2] * m[7]);
  const c11 = m[0] * m[8] - m[2] * m[6];
  const c12 = -(m[0] * m[7] - m[1] * m[6]);
  const c20 = m[1] * m[5] - m[2] * m[4];
  const c21 = -(m[0] * m[5] - m[2] * m[3]);
  const c22 = m[0] * m[4] - m[1] * m[3];
  const det = m[0] * c00 + m[1] * c01 + m[2] * c02;
  if (Math.abs(det) < 1e-12) throw new Error("singular matrix");
  // The adjugate is the transpose of the cofactor matrix.
  return [
    c00 / det, c10 / det, c20 / det,
    c01 / det, c11 / det, c21 / det,
    c02 / det, c12 / det, c22 / det
  ];
}

// Bradford
const BRADFORD = [
  0.8951, 0.2664, -0.1614,
  -0.7502, 1.7135, 0.0367,
  0.0389, -0.0685, 1.0296
];

function bradfordAdapt(sourceWhite, targetWhite) {
  const s = mul3(BRADFORD, sourceWhite);
  const t = mul3(BRADFORD, targetWhite);
  const d = [
    t[0] / s[0], 0, 0,
    0, t[1] / s[1], 0,
    0, 0, t[2] / s[2]
  ];
  return mul3x3(mul3x3(inv3(BRADFORD), d), BRADFORD);
}

/** RGB -> XYZ for a space, primaries adapted to the ICC's D50. */
function rgbToXYZMatrix(space) {
  const spec = PRIMARIES[space];
  if (!spec) throw new Error(`unknown output space '${space}'`);
  const rx = xyToXYZ(spec.xy[0][0], spec.xy[0][1]);
  const gx = xyToXYZ(spec.xy[1][0], spec.xy[1][1]);
  const bx = xyToXYZ(spec.xy[2][0], spec.xy[2][1]);
  const M = [rx[0], gx[0], bx[0], rx[1], gx[1], bx[1], rx[2], gx[2], bx[2]];
  const white = WHITES[spec.white];
  const s = inv3(M);
  const scale = mul3(s, white);
  // Each column is a primary's XYZ, so each column is what gets scaled.
  const scaled = [
    M[0] * scale[0], M[1] * scale[1], M[2] * scale[2],
    M[3] * scale[0], M[4] * scale[1], M[5] * scale[2],
    M[6] * scale[0], M[7] * scale[1], M[8] * scale[2]
  ];
  const adapt = bradfordAdapt(white, WHITES.D50);
  return mul3x3(adapt, scaled);
}

// --- ICC -------------------------------------------------------------------
function s15Fixed16(value) {
  const v = Math.round(value * 65536);
  return v < 0 ? v + 0x100000000 : v;
}

function u8Fixed8(value) {
  return Math.round(Math.min(255, Math.max(0, value)) * 256);
}

function tag(signature, data) {
  return { signature, data };
}

function textType(text) {
  const body = Buffer.from(`${text}\u0000`, "ascii");
  const out = Buffer.alloc(8 + body.length);
  out.write("text", 0, "ascii");
  out.writeUInt32BE(0, 4);
  body.copy(out, 8);
  return out;
}

function descType(text) {
  const ascii = Buffer.from(`${text}\u0000`, "ascii");
  const out = Buffer.alloc(4 + 4 + 4 + 4 + 1 + 67 + ascii.length);
  out.write("desc", 0, "ascii");
  out.writeUInt32BE(0, 4);
  out.writeUInt32BE(ascii.length, 8);
  out.write(text.slice(0, 67), 12, "ascii");
  ascii.copy(out, 12 + 67);
  return out;
}

function xyzType(xyz) {
  const out = Buffer.alloc(20);
  out.write("XYZ ", 0, "ascii");
  out.writeUInt32BE(0, 4);
  out.writeUInt32BE(s15Fixed16(xyz[0]), 8);
  out.writeUInt32BE(s15Fixed16(xyz[1]), 12);
  out.writeUInt32BE(s15Fixed16(xyz[2]), 16);
  return out;
}

function curvGamma(gamma) {
  const out = Buffer.alloc(12 + 2);
  out.write("curv", 0, "ascii");
  out.writeUInt32BE(0, 4);
  out.writeUInt32BE(1, 8);
  out.writeUInt16BE(u8Fixed8(gamma), 12);
  return out;
}

/**
 * A matrix-shaper ICC v2 profile for one of the working spaces.
 * @param {string} space  srgb | display_p3 | rec2020 | prophoto
 * @returns {Buffer}
 */
function iccProfile(space) {
  const spec = PRIMARIES[space];
  if (!spec) throw new Error(`unknown output space '${space}'`);
  const m = rgbToXYZMatrix(space);
  const tags = [
    tag("cprt", textType("Public domain — 几多筒菲林")),
    tag("desc", descType(spec.name)),
    tag("wtpt", xyzType(WHITES.D50)),
    tag("rXYZ", xyzType([m[0], m[3], m[6]])),
    tag("gXYZ", xyzType([m[1], m[4], m[7]])),
    tag("bXYZ", xyzType([m[2], m[5], m[8]])),
    tag("rTRC", curvGamma(spec.gamma)),
    tag("gTRC", curvGamma(spec.gamma)),
    tag("bTRC", curvGamma(spec.gamma))
  ];

  let dataSize = 0;
  for (const t of tags) dataSize += (4 - (t.data.length % 4)) % 4 + t.data.length;
  const header = Buffer.alloc(128);
  const total = 128 + 4 + tags.length * 12 + dataSize;
  header.writeUInt32BE(total, 0);
  header.write("none", 4, "ascii");
  header.writeUInt32BE(0x02100000, 8);          // display, ICC v2.1
  header.write("RGB ", 12, "ascii");
  header.write("XYZ ", 16, "ascii");
  // date/time
  const now = new Date();
  header.writeUInt16BE(now.getUTCFullYear(), 24);
  header.writeUInt16BE(now.getUTCMonth() + 1, 26);
  header.writeUInt16BE(now.getUTCDate(), 28);
  header.writeUInt16BE(now.getUTCHours(), 30);
  header.writeUInt16BE(now.getUTCMinutes(), 32);
  header.writeUInt16BE(now.getUTCSeconds(), 34);
  header.write("acsp", 36, "ascii");
  header.write("APPL", 40, "ascii");
  header.writeUInt32BE(0, 44);
  header.write("none", 48, "ascii");
  header.writeUInt32BE(0, 64);                  // rendering intent: perceptual
  header.writeInt32BE(s15Fixed16(WHITES.D50[0]), 68);
  header.writeInt32BE(s15Fixed16(WHITES.D50[1]), 72);
  header.writeInt32BE(s15Fixed16(WHITES.D50[2]), 76);
  header.write("none", 80, "ascii");

  const out = Buffer.alloc(total);
  header.copy(out, 0);
  let offset = 128;
  out.writeUInt32BE(tags.length, offset);
  offset += 4;
  let dataOffset = offset + tags.length * 12;
  for (const t of tags) {
    out.write(t.signature, offset, "ascii");
    out.writeUInt32BE(dataOffset, offset + 4);
    out.writeUInt32BE(t.data.length, offset + 8);
    t.data.copy(out, dataOffset);
    dataOffset += t.data.length + ((4 - (t.data.length % 4)) % 4);
    offset += 12;
  }
  return out;
}

// --- TIFF ------------------------------------------------------------------
const TIFF_TAGS = {
  IMAGE_WIDTH: 256, IMAGE_LENGTH: 257, BITS_PER_SAMPLE: 258, COMPRESSION: 259,
  PHOTOMETRIC: 262, STRIP_OFFSETS: 273, SAMPLES_PER_PIXEL: 277, ROWS_PER_STRIP: 278,
  STRIP_BYTE_COUNTS: 279, PLANAR_CONFIG: 284, SAMPLE_FORMAT: 339, ICC_PROFILE: 34675
};

/**
 * Write a 16-bit (or 32-bit float) RGB TIFF with an embedded ICC profile.
 * @param {object} options { width, height, data (Uint16Array|Float32Array),
 *   float (bool), icc (Buffer), description }
 */
function writeTiff(options) {
  const { width, height, data } = options;
  const isFloat = Boolean(options.float);
  const channels = 3;
  const bytesPerSample = isFloat ? 4 : 2;
  const stripBytes = width * height * channels * bytesPerSample;
  const icc = options.icc || null;

  const entries = [];
  const push = (tag, type, count, value) => entries.push({ tag, type, count, value });
  push(TIFF_TAGS.IMAGE_WIDTH, 3, 1, width);
  push(TIFF_TAGS.IMAGE_LENGTH, 3, 1, height);
  push(TIFF_TAGS.BITS_PER_SAMPLE, 3, 3, null);           // needs an array
  push(TIFF_TAGS.COMPRESSION, 3, 1, 1);
  push(TIFF_TAGS.PHOTOMETRIC, 3, 1, 2);
  push(TIFF_TAGS.STRIP_OFFSETS, 4, 1, null);              // filled later
  push(TIFF_TAGS.SAMPLES_PER_PIXEL, 3, 1, channels);
  push(TIFF_TAGS.ROWS_PER_STRIP, 3, 1, height);
  push(TIFF_TAGS.STRIP_BYTE_COUNTS, 4, 1, stripBytes);
  push(TIFF_TAGS.PLANAR_CONFIG, 3, 1, 1);
  push(TIFF_TAGS.SAMPLE_FORMAT, 3, 3, null);              // array
  if (icc) push(TIFF_TAGS.ICC_PROFILE, 1, icc.length, null);

  const headerSize = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  const bitsOffset = headerSize + ifdSize;
  const formatOffset = bitsOffset + 6;
  let dataStart = formatOffset + 6;
  let iccOffset = 0;
  if (icc) {
    dataStart += (4 - (dataStart % 4)) % 4;
    iccOffset = dataStart;
    dataStart += icc.length;
  }
  dataStart += (4 - (dataStart % 4)) % 4;
  const pixelOffset = dataStart;
  const total = pixelOffset + stripBytes;

  const out = Buffer.alloc(total);
  out.write("II", 0, "ascii");
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(headerSize, 4);
  out.writeUInt16LE(entries.length, headerSize);
  let cursor = headerSize + 2;
  for (const entry of entries) {
    let value = entry.value;
    if (entry.tag === TIFF_TAGS.BITS_PER_SAMPLE) value = bitsOffset;
    if (entry.tag === TIFF_TAGS.SAMPLE_FORMAT) value = formatOffset;
    if (entry.tag === TIFF_TAGS.STRIP_OFFSETS) value = pixelOffset;
    if (entry.tag === TIFF_TAGS.ICC_PROFILE) value = iccOffset;
    out.writeUInt16LE(entry.tag, cursor);
    out.writeUInt16LE(entry.type, cursor + 2);
    out.writeUInt32LE(entry.count, cursor + 4);
    if (entry.type === 3 && entry.count === 1) {
      out.writeUInt16LE(value, cursor + 8);
      out.writeUInt16LE(0, cursor + 10);
    } else {
      out.writeUInt32LE(value, cursor + 8);
    }
    cursor += 12;
  }
  out.writeUInt32LE(0, cursor);
  for (let i = 0; i < 3; i += 1) out.writeUInt16LE(bytesPerSample * 8, bitsOffset + 2 * i);
  const format = isFloat ? 3 : 1;
  for (let i = 0; i < 3; i += 1) out.writeUInt16LE(format, formatOffset + 2 * i);
  if (icc) icc.copy(out, iccOffset);

  if (isFloat) {
    const view = new DataView(out.buffer, out.byteOffset + pixelOffset, stripBytes);
    for (let i = 0; i < data.length; i += 1) view.setFloat32(i * 4, data[i], true);
  } else {
    const view = new DataView(out.buffer, out.byteOffset + pixelOffset, stripBytes);
    for (let i = 0; i < data.length; i += 1) view.setUint16(i * 2, Math.max(0, Math.min(65535, Math.round(data[i]))), true);
  }
  return out;
}

module.exports = {
  PRIMARIES, WHITES,
  xyToXYZ, rgbToXYZMatrix, bradfordAdapt, inv3, mul3, mul3x3,
  iccProfile, writeTiff
};
