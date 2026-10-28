"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EngineBridge, isRaw } = require("../src/engine");
const { createState } = require("../src/shared/params");

test("RAW detection is case-insensitive and does not treat previews as RAW", () => {
  assert.equal(isRaw("D:\\photos\\A.ARW"), true);
  assert.equal(isRaw("D:\\photos\\A.NEF"), true);
  assert.equal(isRaw("D:\\photos\\A.jpg"), false);
});

test("engine arguments preserve paths as separate argv entries", () => {
  const bridge = new EngineBridge({ userData: "D:\\tmp" });
  const args = bridge.buildArguments("D:\\my photos\\a.arw", "D:\\out\\a.tif", "D:\\out\\a.json", "D:\\out\\params.json", "D:\\engine\\resources");
  assert.equal(args.length, 10);
  assert.ok(args.includes("D:\\my photos\\a.arw"));
  assert.ok(args.includes("D:\\engine\\resources"));
});

test("parameter bridge maps UI values into the verified upstream schema", () => {
  const bridge = new EngineBridge({ userData: "D:\\tmp" });
  const state = createState();
  state.film.stock = "kodak_gold_200";
  state.print.paper = "fujifilm_crystal_archive_typeii";
  state.print.exposure = 1;
  state.film.grain = 1;
  state.film.halation = 0;
  const params = bridge.toEngineParams(state);
  assert.equal(params.film_stock, "kodak_gold_200");
  assert.equal(params.print_stock, "fujifilm_crystal_archive_typeii");
  assert.equal(params.print_exposure, 2);
  assert.equal(params.grain_amount, 2);
  assert.equal(params.halation_active, false);
  assert.equal(params.input_color_space, "ProPhoto RGB");
  assert.equal(params.extended_dynamic_range, false);
  assert.equal(params.geometry_quarter_turns, 0);
});

test("slide films switch the engine into direct scan mode", () => {
  const bridge = new EngineBridge({ userData: "D:\\tmp" });
  const state = createState();
  state.film.stock = "fujifilm_velvia_100";
  const scan = bridge.toEngineParams(state);
  assert.equal(scan.scan_film, true);
  // The native host refuses black/white correction on a direct scan, so the
  // two flags must follow the film type instead of always being on.
  assert.equal(scan.scanner_white_correction, false);
  assert.equal(scan.scanner_black_correction, false);
  state.film.stock = "kodak_portra_400";
  const negative = bridge.toEngineParams(state);
  assert.equal(negative.scan_film, false);
  assert.equal(negative.scanner_white_correction, true);
  assert.equal(negative.scanner_black_correction, true);
});

test("an unusable engine fails honestly instead of guessing", async () => {
  // A machine with a source build has a working engine, so this asserts the
  // contract rather than a particular state: given a path that does not exist,
  // the bridge must refuse — either because no engine is reachable or because
  // the input is missing — and never invent a render.
  const bridge = new EngineBridge({
    userData: "D:\\tmp",
    settings: {
      hostPath: "D:\\no-such-engine\\spk_raw_render.exe",
      resourcesPath: "D:\\no-such-engine\\resources"
    }
  });
  await assert.rejects(
    () => bridge.renderRaw("D:\\missing.arw", createState()),
    /未找到引擎|引擎宿主|输入 RAW 不存在/
  );
});
