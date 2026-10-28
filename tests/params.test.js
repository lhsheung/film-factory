"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../src/shared/params");

test("default state is independent between sessions", () => {
  const first = P.createState();
  const second = P.createState();
  first.film.exposure = 2;
  assert.equal(second.film.exposure, 0);
});

test("sanitize clamps numeric values and rejects unknown enums", () => {
  const state = P.sanitizeState({
    film: { stock: "not-a-stock", exposure: 99, grain: -2, whiteBalance: 100 },
    output: { format: "exe", colorSpace: "unknown", longEdge: 1 },
    edge: { frameNumber: 200, date: "not-a-date" }
  });
  assert.equal(state.film.stock, "kodak_portra_400");
  assert.equal(state.film.exposure, 3);
  assert.equal(state.film.grain, 0);
  assert.equal(state.film.whiteBalance, 2500);
  assert.equal(state.output.format, "png");
  assert.equal(state.output.colorSpace, "srgb");
  assert.equal(state.output.longEdge, 640);
  assert.equal(state.edge.frameNumber, 99);
  assert.match(state.edge.date, /^\d{4}-\d{2}-\d{2}$/);
});

test("missing engine is reported before advanced feature checks", () => {
  const issues = P.validateForEngine(P.createState(), { available: false });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /未连接/);
});

test("advanced features name the host's limit, not the app's", () => {
  const state = P.createState();
  state.edge.active = true;
  state.pair.active = true;
  state.latitude.active = true;
  state.contrastMask.active = true;
  state.output.colorSpace = "prophoto";
  state.output.bitDepth = 16;
  // The app renders every one of these itself; a connected Windows host that
  // cannot is still worth saying out loud, which is all these issues are.
  const issues = P.validateForEngine(state, { available: true, tiff16: true });
  assert.equal(issues.length, 5);
  assert.ok(issues.every((line) => /上游 Windows 引擎|上游引擎/.test(line)));
});

test("a full-featured state is valid whatever the host supports", () => {
  const state = P.createState();
  state.edge.active = true;
  state.pair.active = true;
  state.latitude.active = true;
  state.contrastMask.active = true;
  const issues = P.validateForEngine(state, { available: true, tiff16: true, sceneLatitude: true, contrastMask: true, filmEdge: true, halfFrame: true, wideGamut: true });
  assert.deepEqual(issues, []);
});

test("supported basic RAW render has no capability issue", () => {
  const issues = P.validateForEngine(P.createState(), { available: true, tiff16: true });
  assert.deepEqual(issues, []);
});
