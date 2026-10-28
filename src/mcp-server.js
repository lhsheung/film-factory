"use strict";

const readline = require("node:readline");
const { createEngine, handleMcpRequest } = require("./automation");

function start(engine) {
  const bridge = engine || createEngine({}, process.env);
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  let buffer = "";
  input.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    buffer += trimmed;
    let request = null;
    try {
      request = JSON.parse(buffer);
      buffer = "";
    } catch (_) {
      return; // 多行 JSON：继续缓冲，直到能解析
    }
    const response = await handleMcpRequest(bridge, request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  input.on("close", () => process.exit(0));
}

module.exports = { start };

if (require.main === module) {
  start(createEngine({}, process.env));
}
