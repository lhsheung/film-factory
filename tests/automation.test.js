"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EngineBridge } = require("../src/engine");
const {
  parseCliArgs, buildEngineSettings, handleMcpRequest, runRender
} = require("../src/automation");

test("CLI arguments accept spaces, equals signs and boolean switches", () => {
  const parsed = parseCliArgs(["render", "--input", "D:\\a.arw", "--output=D:\\a.tif", "--verbose"]);
  assert.equal(parsed.command, "render");
  assert.equal(parsed.flags.input, "D:\\a.arw");
  assert.equal(parsed.flags.output, "D:\\a.tif");
  assert.equal(parsed.flags.verbose, true);
});

test("engine settings prefer explicit flags over environment variables", () => {
  const env = { SPEKTRALAB_RAW_HOST: "env.exe", SPEKTRALAB_ENGINE_RESOURCES: "env-dir" };
  assert.deepEqual(buildEngineSettings({}, env), { hostPath: "env.exe", resourcesPath: "env-dir" });
  assert.deepEqual(buildEngineSettings({ "engine-host": "flag.exe" }, env), { hostPath: "flag.exe", resourcesPath: "env-dir" });
});

test("MCP handshake exposes the render tool and rejects unknown tools", async () => {
  const bridge = new EngineBridge({ userData: "D:\\tmp", settings: {} });
  const init = await handleMcpRequest(bridge, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(init.result.serverInfo.name, "菲林工厂");
  const tools = await handleMcpRequest(bridge, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(tools.result.tools.some((tool) => tool.name === "render_raw"));
  const unknown = await handleMcpRequest(bridge, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } });
  assert.match(unknown.error.message, /未知工具/);
});

test("render requires an input and refuses to invent one", async () => {
  const bridge = new EngineBridge({ userData: "D:\\tmp", settings: {} });
  await assert.rejects(() => runRender(bridge, {}), /缺少 --input/);
});
