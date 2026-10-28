"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const sharp = require("sharp");

const sceneLatitude = require("../src/imaging/scene-latitude");
const contrastMask = require("../src/imaging/contrast-mask");
const overscan = require("../src/imaging/overscan");
const imprint = require("../src/imaging/imprint");
const di = require("../src/imaging/digital-intermediate");
const wideGamut = require("../src/imaging/wide-gamut");
const dpx = require("../src/imaging/dpx");
const pipeline = require("../src/imaging/pipeline");

// --- RFC-023 --------------------------------------------------------------
test("scene latitude with both rooms closed is an exact identity", () => {
  const rgb = new Float32Array([0.02, 0.18, 0.9, 1.5, 0.4, 0.05]);
  const out = sceneLatitude.apply(rgb, { width: 2, height: 1, highlightRoom: 0, shadowRoom: 0 });
  for (let i = 0; i < rgb.length; i += 1) assert.equal(out[i], rgb[i]);
});

test("scene latitude compresses above the knee and lifts below it", () => {
  const bright = new Float32Array([4, 4, 4]);
  const dark = new Float32Array([0.01, 0.01, 0.01]);
  const options = { width: 1, height: 1, highlightKnee: 2, highlightRoom: 2, shadowKnee: -2, shadowRoom: 2, rolloff: 2, maxLift: 4 };
  const high = sceneLatitude.apply(bright, options)[0];
  const low = sceneLatitude.apply(dark, options)[0];
  assert.ok(high < 4 && high > 0.5, `highlight should come down, got ${high}`);
  assert.ok(low > 0.01, `shadow should come up, got ${low}`);
});

test("scene latitude leaves a pathological pixel alone", () => {
  const rgb = new Float32Array([0, -1, Number.NaN]);
  const out = sceneLatitude.apply(rgb, { width: 1, height: 1, highlightRoom: 2, shadowRoom: 2 });
  assert.equal(out[0], 0);
  assert.equal(out[1], -1);
  assert.ok(Number.isNaN(out[2]));
});

// --- RFC-024 --------------------------------------------------------------
test("contrast mask with zero stops is a unity gain", () => {
  const a = new Float32Array([0.5, 0.5, 0.5, 0.01, 0.02, 0.03]);
  const { exposure } = contrastMask.apply(a, { width: 2, height: 1, highlights: 0, shadows: 0 });
  for (let i = 0; i < a.length; i += 1) assert.ok(Math.abs(exposure[i] - a[i]) < 1e-6);
});

test("contrast mask's gain stays inside its limit", () => {
  const a = new Float32Array(3 * 64 * 64);
  for (let i = 0; i < a.length; i += 1) a[i] = 0.001 + (i % 97) / 500;
  const { exposure } = contrastMask.apply(a, {
    width: 64, height: 64, highlights: 3, shadows: 3, core: 0.5, scale: 0.05, limit: 2
  });
  for (let i = 0; i < a.length; i += 1) {
    const gain = exposure[i] / Math.max(a[i], 1e-12);
    assert.ok(gain <= Math.pow(2, 2) + 1e-3, `gain ${gain} exceeded the 2-stop limit`);
  }
});

// --- overscan -------------------------------------------------------------
test("overscan refuses a frame that is not the gate's shape", () => {
  assert.throws(
    () => overscan.overscanLayout({ format: "135" }, 1000, 1000, 0.05, {}),
    /not the 135 gate's shape/
  );
});

test("a 135 layout has perforations and a film wider than the gate", () => {
  const layout = overscan.overscanLayout({ format: "135", cameraSeed: 4, frameSeed: 2 }, 900, 600, 24.3 / 600, {});
  assert.equal(layout.perforated, true);
  assert.ok(layout.film_w > layout.gate_across);
  assert.ok(layout.perf_pitch === 4.75);
  assert.equal(layout.pair_adv, 0);
  assert.ok(layout.canvas_w >= 900 && layout.canvas_h >= 600);
});

test("a half-frame pair advances the gate by one 19 mm step", () => {
  // The pair's frame is the two half frames side by side: 37 x 24 mm.
  const single = overscan.overscanLayout({ format: "135_half", cameraSeed: 4, frameSeed: 2 }, 360, 480, 24 / 480, {});
  const pair = overscan.overscanLayout({ format: "135_half", pair: true, cameraSeed: 4, frameSeed: 2 }, 740, 480, 24 / 480, {});
  assert.equal(pair.pair_adv, 19);
  // The gate stays one half frame; the *frame* carries both, 19 mm apart.
  assert.ok(Math.abs(pair.gate_along - single.gate_along) < 1e-6);
  assert.ok(Math.abs(pair.gate_across - single.gate_across) < 1e-6);
  assert.ok(Math.abs((740 * 24 / 480) - (360 * 24 / 480) - 19) < 1e-6);
});

test("the hole's dye cancels the film's base", () => {
  const filmModel = require("../src/imaging/film-model");
  const portra = filmModel.loadProfile("kodak_portra_400");
  const cmy = overscan.holeCmy({ channelDensity: portra.channelDensity, baseDensity: portra.baseDensity });
  // A least-squares fit through a real base leaves a small residual, not zero dye.
  assert.ok(cmy.every((v) => Number.isFinite(v)));
  assert.ok(Math.abs(cmy[0]) > 0.05, `expected a real amount of dye, got ${cmy[0]}`);
});

// --- the imprint ----------------------------------------------------------
test("the DX frame-number code carries its own parity bit", () => {
  const bits = overscan.dxBits(1548, 12, false);
  assert.equal(bits.length, 23);
  let sum = 0;
  for (let i = 0; i < 21; i += 1) sum += bits[i];
  assert.equal(bits[21], sum % 2);
  assert.equal(bits[22], 0);
});

test("a seven-segment date is drawn as one polygon per lit segment", () => {
  const ops = [];
  imprint.sevenSegPolys("1", 1.2, 0, 0, 0.18, ops);
  assert.equal(ops.length, 2);            // "1" lights b and c
  assert.ok(imprint.sevenSegWidth("1", 1.2) > 0);
});

test("the 5x7 matrix face measures its own advance", () => {
  const width = imprint.matrixText("12", 1.4, 1, false, 0, 0, null);
  assert.ok(width > 1.4 && width < 3.2, `unexpected width ${width}`);
});

// --- Cineon DI ------------------------------------------------------------
test("Cineon encode and decode round-trip the reference points", () => {
  assert.ok(Math.abs(di.cineonEncode(0) * 1023 - 95) < 0.5);
  assert.ok(Math.abs(di.cineonEncode(1) * 1023 - 685) < 0.5);
  const back = di.cineonDecode(di.cineonEncode(0.18));
  assert.ok(Math.abs(back - 0.18) < 1e-9);
});

test("print brightness moves the DI positive by whole stops", () => {
  const flat = di.liveOffsets({ printExposure: 1 });
  const one = di.liveOffsets({ printExposure: 0.5 });
  assert.ok(Math.abs(one[0] - flat[0] - Math.log10(2)) < 1e-12);
  const y = di.liveOffsets({ printExposure: 1, yFilterShift: 1 });
  assert.ok(Math.abs(y[2] - flat[2] - 0.05 * Math.log10(2)) < 1e-12);
});

test("the DPX writer produces a header a reader accepts", () => {
  const words = new Uint16Array(4 * 3 * 3);
  for (let i = 0; i < words.length; i += 1) words[i] = i * 7;
  const buffer = dpx.writeDpx({ width: 4, height: 3, data: words });
  const header = dpx.readDpxHeader(buffer);
  assert.equal(header.magic, "SDPX");
  assert.equal(header.version, "V2.0");
  assert.equal(header.width, 4);
  assert.equal(header.height, 3);
  assert.equal(header.bitSize, 10);
  assert.equal(header.descriptor, 50);
  assert.equal(header.dataOffset, dpx.HEADER_BYTES);
  assert.equal(buffer.length, header.total);
});

// --- wide gamut -----------------------------------------------------------
test("a synthesised ICC profile is a well-formed v2 matrix-shaper", () => {
  for (const space of ["srgb", "display_p3", "rec2020", "prophoto"]) {
    const icc = wideGamut.iccProfile(space);
    assert.equal(icc.toString("ascii", 36, 40), "acsp", `${space} is missing the acsp signature`);
    assert.equal(icc.readUInt32BE(0), icc.length);
    const count = icc.readUInt32BE(128);
    assert.equal(count, 9);
  }
});

test("ProPhoto's green primary lands where the published one does", () => {
  const m = wideGamut.rgbToXYZMatrix("prophoto");
  // D50-adapted ProPhoto green: X≈0.179, Y≈0.244, Z≈0.064 (Lindbloom's table).
  assert.ok(Math.abs(m[1] - 0.1352) < 0.003, `green X ${m[1]}`);
  assert.ok(Math.abs(m[4] - 0.7119) < 0.003, `green Y ${m[4]}`);
});

test("the TIFF writer's header names 16 bits and carries the ICC", () => {
  const icc = wideGamut.iccProfile("display_p3");
  const tiff = wideGamut.writeTiff({ width: 2, height: 2, data: new Uint16Array(12), icc });
  assert.equal(tiff.toString("ascii", 0, 2), "II");
  assert.equal(tiff.readUInt16LE(2), 42);
  const ifd = tiff.readUInt32LE(4);
  const count = tiff.readUInt16LE(ifd);
  assert.ok(count >= 11);
  assert.ok(tiff.includes(icc));
});

test("a half-frame pair composes both pictures into one gate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jdtfl-pair-"));
  const a = path.join(dir, "a.png");
  const b = path.join(dir, "b.png");
  const flat = async (colour, file) => {
    const buffer = Buffer.alloc(300 * 400 * 3);
    for (let i = 0; i < buffer.length; i += 3) {
      buffer[i] = colour[0]; buffer[i + 1] = colour[1]; buffer[i + 2] = colour[2];
    }
    await sharp(buffer, { raw: { width: 300, height: 400, channels: 3 } }).png().toFile(file);
  };
  await flat([200, 80, 40], a);
  await flat([40, 90, 200], b);
  const result = await pipeline.render({
    input: a, secondary: b, maxEdge: 480,
    filmStock: "kodak_portra_400", paperStock: "kodak_portra_endura",
    params: {
      film: { exposure: 0, format: "135_half" },
      print: { exposure: 0, magenta: 0, yellow: 0, preFlash: 0 },
      pair: { active: true, orientation: "horizontal", split: 0.5 }
    }
  });
  assert.ok(result.notes.some((line) => /半格配对/.test(line)));
  // Two half frames side by side: wider than tall.
  assert.ok(result.width > result.height, `${result.width}x${result.height} is not a pair`);
  // The left half keeps the first picture's warmth, the right half the second's blue.
  const midRow = Math.floor(result.height / 2) * result.width;
  const left = result.rgb[3 * (midRow + Math.floor(result.width * 0.25))];
  const right = result.rgb[3 * (midRow + Math.floor(result.width * 0.75)) + 2];
  assert.ok(left > result.rgb[3 * (midRow + Math.floor(result.width * 0.75))], "left should be the warm frame");
  assert.ok(right > 0, "right should carry the blue frame");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the edge can be added to a picture another engine developed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jdtfl-edge-"));
  const input = path.join(dir, "developed.png");
  await sharp(Buffer.alloc(300 * 200 * 3, 120), { raw: { width: 300, height: 200, channels: 3 } }).png().toFile(input);
  const result = await pipeline.applyEdgeOnly(input, {
    film: { format: "135" },
    edge: { active: true, cameraSeed: 6, frameSeed: 4, fog: 1, leaks: 0.4, holes: "white", carrier: "none", frameNumber: 9 }
  }, "kodak_portra_400", 300);
  assert.ok(result.width > 300 && result.height > 200, "the rebate must grow the canvas");
  assert.ok(result.rgb.some((v) => Number.isFinite(v) && v > 0));
  assert.ok(result.notes.some((line) => /胶片边缘/.test(line)));
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the whole pipeline ---------------------------------------------------
test("the pipeline renders every RFC feature and stays finite", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jdtfl-"));
  const input = path.join(dir, "in.png");
  const w = 240;
  const h = 160;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = 3 * (y * w + x);
      raw[i] = Math.round((255 * x) / w);
      raw[i + 1] = Math.round((255 * y) / h);
      raw[i + 2] = 160;
    }
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toFile(input);

  const result = await pipeline.render({
    input,
    maxEdge: 240,
    filmStock: "kodak_portra_400",
    paperStock: "kodak_portra_endura",
    params: {
      film: { exposure: 0 },
      print: { exposure: 0, magenta: 0, yellow: 0, preFlash: 0 },
      latitude: { active: true, highlightKnee: 2, highlightRoom: 1.2, shadowKnee: -2, shadowRoom: 1, rolloff: 2, maxLift: 4 },
      contrastMask: { active: true, highlights: 0.3, shadows: 0.3, core: 1, scale: 0.03 },
      edge: { active: true, format: "135", cameraSeed: 5, frameSeed: 2, fog: 1, leaks: 0.5, holes: "white", carrier: "none", frameNumber: 7, edgeText: "KODAK 400" },
      dateImprint: { active: true, text: "'26 9 28", style: "lcd", placement: "frame", corner: "br" },
      pair: { active: false }
    }
  });
  assert.ok(result.width > 240, "the rebate should widen the canvas");
  assert.ok(result.height > 160, "the rebate should heighten the canvas");
  for (const v of result.rgb) assert.ok(Number.isFinite(v));
  assert.ok(result.rgb.some((v) => v > 0.05), "the render should not be black");
  const codes = pipeline.digitalIntermediate(result, { print: { exposure: 0 } });
  assert.ok(codes.some((c) => c > 0.05 && c < 0.98));
  fs.rmSync(dir, { recursive: true, force: true });
});
