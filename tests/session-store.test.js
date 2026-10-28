"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SessionStore } = require("../src/session-store");
const { createState } = require("../src/shared/params");

const directory = path.join(__dirname, ".tmp", `${Date.now()}-${process.pid}`);
const photo = { path: "D:\\photos\\example.arw", size: 100, modifiedAt: "2026-10-28T00:00:00.000Z" };

test("session round-trip sanitizes state and preserves identity", () => {
  const store = new SessionStore(directory);
  const state = createState();
  state.film.exposure = 1.25;
  state.film.grain = 50;
  const saved = store.save(photo, state);
  assert.equal(saved.document.photo.path, photo.path);
  assert.ok(fs.existsSync(saved.file));
  const loaded = store.load(photo);
  assert.equal(loaded.state.film.exposure, 1.25);
  assert.equal(loaded.state.film.grain, 1);
  assert.equal(loaded.sourceChanged, false);
});

test("source size change is visible to the caller", () => {
  const store = new SessionStore(directory);
  store.save(photo, createState());
  const loaded = store.load(Object.assign({}, photo, { size: 200 }));
  assert.equal(loaded.sourceChanged, true);
});

test("unknown records are absent and malformed records are preserved", () => {
  const store = new SessionStore(directory);
  assert.equal(store.load({ path: "D:\\photos\\missing.arw" }), null);
  const file = store.fileFor(photo.path);
  fs.writeFileSync(file, "{broken", "utf8");
  assert.throws(() => store.load(photo), /无法读取/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});
