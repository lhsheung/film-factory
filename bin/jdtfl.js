#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { EngineBridge } = require("../src/engine");
const {
  parseCliArgs, buildEngineSettings, runRender, defaultWorkDirectory
} = require("../src/automation");

function usage() {
  return [
    "菲林工厂 CLI — 直接驱动 SpektraLab Windows 引擎",
    "",
    "  jdtfl capabilities [--engine-host <exe>] [--engine-resources <dir>]",
    "  jdtfl render --input <RAW> [--state params.json] [--output out.tif]",
    "                 [--engine-host <exe>] [--engine-resources <dir>] [--work-dir <dir>]",
    "  jdtfl mcp     启动 stdio MCP server（默认关闭，需要显式运行）",
    "",
    "环境变量：SPEKTRALAB_RAW_HOST、SPEKTRALAB_ENGINE_RESOURCES"
  ].join("\n");
}

async function main(argv) {
  const { command, flags } = parseCliArgs(argv);
  if (!command || flags.help || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const settings = buildEngineSettings(flags, process.env);
  const bridge = new EngineBridge({
    userData: flags["work-dir"] ? path.resolve(String(flags["work-dir"])) : defaultWorkDirectory(),
    settings
  });

  if (command === "capabilities") {
    const resolved = bridge.resolve();
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    return resolved.available ? 0 : 1;
  }

  if (command === "render") {
    if (!flags.input) {
      process.stderr.write("缺少 --input\n");
      process.stdout.write(`${usage()}\n`);
      return 2;
    }
    const result = await runRender({
      input: String(flags.input),
      output: flags.output ? String(flags.output) : null,
      statePath: flags.state ? String(flags.state) : null,
      flags,
      env: process.env,
      workDirectory: bridge.userData
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === "mcp") {
    await require("../src/mcp-server.js").start(bridge);
    return 0;
  }

  process.stderr.write(`未知命令：${command}\n`);
  process.stdout.write(`${usage()}\n`);
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code || 0; })
    .catch((error) => {
      process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

module.exports = { main, usage };
