"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EngineBridge } = require("./engine");
const { sanitizeState } = require("./shared/params");

const MCP_TOOLS = [
  {
    name: "engine_status",
    description: "报告 SpektraLab Windows 引擎宿主的可用性与已验证能力",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "render_raw",
    description: "对一张 RAW 运行光谱显影，可写入指定 TIFF",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "RAW 文件绝对路径" },
        output: { type: "string", description: "TIFF 保存路径，父目录必须已存在且文件不存在" },
        params: { type: "object", description: "扁平引擎参数增量，例如 {\"film_stock\":\"kodak_gold_200\"}" }
      },
      required: ["input"]
    }
  }
];

function parseCliArgs(argv) {
  const flags = {};
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { rest.push(token); continue; }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) flags[body.slice(0, equals)] = body.slice(equals + 1);
    else if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) { flags[body] = argv[index + 1]; index += 1; }
    else flags[body] = true;
  }
  return { command: rest[0] || "", rest, flags };
}

function buildEngineSettings(flags, env) {
  return {
    hostPath: typeof flags["engine-host"] === "string" ? flags["engine-host"] : (env.SPEKTRALAB_RAW_HOST || ""),
    resourcesPath: typeof flags["engine-resources"] === "string" ? flags["engine-resources"] : (env.SPEKTRALAB_ENGINE_RESOURCES || "")
  };
}

function defaultWorkDirectory() {
  return path.join(os.tmpdir(), "jiduo-tong-feilin-cli");
}

function createEngine(flags, env) {
  const userData = typeof flags["work-dir"] === "string" ? path.resolve(flags["work-dir"]) : defaultWorkDirectory();
  fs.mkdirSync(userData, { recursive: true });
  return new EngineBridge({ userData, settings: buildEngineSettings(flags, env || process.env) });
}

function readParams(flags) {
  if (typeof flags.params !== "string") return null;
  const raw = fs.readFileSync(path.resolve(flags.params), "utf8");
  return sanitizeState(JSON.parse(raw));
}

async function runRender(engine, flags) {
  const input = typeof flags.input === "string" ? path.resolve(flags.input) : "";
  if (!input) throw new Error("缺少 --input <RAW>");
  const state = readParams(flags) || sanitizeState({});
  const result = await engine.renderRaw(input, state);
  let output = null;
  if (typeof flags.output === "string") {
    output = path.resolve(flags.output);
    if (!fs.existsSync(path.dirname(output))) throw new Error("输出父目录不存在");
    if (fs.existsSync(output)) throw new Error("输出文件已存在");
    fs.copyFileSync(result.output, output, fs.constants.COPYFILE_EXCL);
  }
  return {
    engineOutput: result.output,
    output,
    report: result.reportDocument,
    params: engine.toEngineParams(state)
  };
}

async function handleMcpRequest(engine, request) {
  const id = request && Object.prototype.hasOwnProperty.call(request, "id") ? request.id : null;
  const respond = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (!request || request.jsonrpc !== "2.0") return fail(-32600, "不是合法的 JSON-RPC 2.0 请求");
  if (id === null) return null;
  const method = request.method;
  try {
    if (method === "initialize") {
      return respond({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, experimental: {} },
        serverInfo: { name: "几多筒菲林", version: "0.1.0" }
      });
    }
    if (method === "ping") return respond({});
    if (method === "tools/list") return respond({ tools: MCP_TOOLS });
    if (method === "tools/call") {
      const name = request.params && request.params.name;
      const args = (request.params && request.params.arguments) || {};
      if (name === "engine_status") {
        const resolved = engine.resolve();
        return respond({ content: [{ type: "text", text: JSON.stringify(resolved, null, 2) }] });
      }
      if (name === "render_raw") {
        if (typeof args.input !== "string") return fail(-32602, "render_raw 需要 input 字符串");
        const result = await runRender(engine, { input: args.input, output: args.output, params: args.params });
        return respond({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      }
      return fail(-32601, `未知工具：${name}`);
    }
    return fail(-32601, `不支持的方法：${method}`);
  } catch (error) {
    return fail(-32000, error.message);
  }
}

module.exports = {
  MCP_TOOLS, parseCliArgs, buildEngineSettings, defaultWorkDirectory,
  createEngine, runRender, handleMcpRequest
};
