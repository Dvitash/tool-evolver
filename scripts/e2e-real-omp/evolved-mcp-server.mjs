#!/usr/bin/env node
// Manifest-driven stdio MCP server hosting tool-evolver evolved tools (real-OMP e2e).
// Loads /tmp/te-omp-runs/e2e/tools/manifest.json; each entry points at a
// generated tool module (TS) with a default export from defineTool({...}).

import { appendFileSync, realpathSync } from "node:fs";
const rpcLog = (m) => { try { appendFileSync("/tmp/te-proxy/rpc.log", new Date().toISOString() + " " + JSON.stringify(m && {id:m.id, method:m.method}) + "\n"); } catch {} };
appendFileSync("/tmp/te-proxy/spawned.log", new Date().toISOString() + " shim spawned\n");
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";

const SDK = "file:///home/dvitash/Projects/tool-evolver/packages/runtime/dist/worker/sdk.js";
const { createToolContext } = await import(SDK);

const MANIFEST_PATH = "/tmp/te-omp-runs/e2e/tools/manifest.json";
const WORKSPACE = (() => {
  const raw = process.env.TE_MCP_WORKSPACE ?? "";
  const override = raw.trim();
  if (override) return path.resolve(override);
  return process.cwd();
})();
const WORKSPACE_REAL = (() => {
  try { return realpathSync(WORKSPACE); } catch { return WORKSPACE; }
})();

let manifest = { tools: [] };
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`manifest load failed: ${err}\n`);
}

const tools = new Map();
for (const entry of manifest.tools ?? []) {
  try {
    const mod = await import(entry.file);
    tools.set(entry.name, { ...entry, def: mod.default });
  } catch (err) {
    process.stderr.write(`tool load failed ${entry.name}: ${err}\n`);
  }
}

const ALLOWED_CMD = new Set([
  "git", "wc", "grep", "head", "cat", "ls", "tail", "sort", "uniq",
  "find", "awk", "sed", "tr", "xargs", "echo", "nl", "cut", "paste", "comm",
]);

function resolveWithin(p) {
  const abs = path.resolve(WORKSPACE, p ?? ".");
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`fs denied outside workspace: ${p}`);
  }
  let existing = abs;
  let rest = "";
  while (true) {
    try {
      const real = realpathSync(existing);
      const targetReal = rest ? path.join(real, rest) : real;
      const resolved = path.resolve(targetReal);
      if (resolved !== WORKSPACE_REAL && !resolved.startsWith(WORKSPACE_REAL + path.sep)) {
        throw new Error(`fs denied outside workspace: ${p}`);
      }
      break;
    } catch (err) {
      if (err.message && err.message.includes("fs denied outside workspace")) throw err;
      if (err.code && err.code !== "ENOENT") throw err;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      rest = path.join(path.basename(existing), rest);
      existing = parent;
    }
  }
  return abs;
}

async function fsHandler(action, payload) {
  const p = payload?.path;
  switch (action) {
    case "readFile": {
      const encoding = payload?.encoding ?? "utf-8";
      const buf = await fsp.readFile(resolveWithin(p));
      return {
        content: encoding === "base64" ? buf.toString("base64") : buf.toString("utf-8"),
        encoding,
      };
    }
    case "exists": {
      try { await fsp.access(resolveWithin(p)); return { exists: true }; }
      catch { return { exists: false }; }
    }
    case "stat": {
      const s = await fsp.stat(resolveWithin(p));
      return {
        path: p,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        size: s.size,
        mtimeMs: s.mtimeMs,
        modifiedAt: s.mtime.toISOString(),
      };
    }
    case "listDirectory": {
      const target = resolveWithin(p ?? ".");
      if (payload?.recursive) {
        const out = [];
        async function walk(dir, rel) {
          for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
            const r = rel ? `${rel}/${d.name}` : d.name;
            if (d.isDirectory()) await walk(path.join(dir, d.name), r);
            else out.push(r);
          }
        }
        await walk(target, "");
        return out;
      }
      return await fsp.readdir(target);
    }
    default:
      throw new Error(`fs action not supported by shim: ${action}`);
  }
}

function brokerHandler(family, action, payload) {
  if (family === "cmd") {
    const exe = payload?.executable ?? payload?.command;
    if (!ALLOWED_CMD.has(exe)) {
      return Promise.reject(new Error(`broker denied: cmd:${action} ${exe}`));
    }
    let cwd;
    try {
      cwd = payload?.cwd ? resolveWithin(payload.cwd) : WORKSPACE;
    } catch (err) {
      return Promise.reject(err);
    }
    for (const a of payload?.args ?? []) {
      if (typeof a !== "string") continue;
      if (a.startsWith("-")) continue;
      const segments = a.split(/[/\\]/);
      const hasDotDot = segments.includes("..");
      const isPathLike = path.isAbsolute(a) || a.includes("/") || a.includes("\\") || a === "." || a === ".." || hasDotDot;
      if (!isPathLike) continue;
      try {
        resolveWithin(a);
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return new Promise((resolve) => {
      execFile(
        exe,
        payload?.args ?? [],
        { cwd, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          });
        },
      );
    });
  }
  if (family === "fs") return fsHandler(action, payload);
  return Promise.reject(new Error(`broker denied: ${family}:${action}`));
}

async function callTool(name, args) {
  const t = tools.get(name);
  const rawInput = args && Object.keys(args).length > 0 ? args : { path: WORKSPACE };
  let safeRoot = WORKSPACE;
  if (rawInput.path != null) {
    safeRoot = resolveWithin(String(rawInput.path));
  }
  const input = { ...rawInput, path: safeRoot };
  const ctx = createToolContext(input, {
    invocationId: `mcp-${Date.now()}`,
    workspaceRoot: safeRoot,
    brokerHandler,
  });
  // Compatibility aliases for generated code written against either cmd API name.
  ctx.broker.cmd.execute = ctx.broker.cmd.execute ?? ((exe, a, o) => ctx.broker.cmd.exec(exe, a, o));
  const handler = t.def.handler ?? t.def.execute;
  if (typeof handler === "function") return handler.call(t.def, ctx.input, ctx);
  // defineTool(async (context) => ...) single-function form
  if (typeof t.def === "function") return t.def(ctx);
  throw new Error(`tool ${name} has no callable handler`);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  rpcLog(req);
  const { id, method, params } = req;
  try {
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "tool-evolver-evolved", version: "0.3.0" },
      }});
    } else if (method === "notifications/initialized" || method === "initialized") {
      // no response
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      const listed = [...tools.values()].map((t) => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema,
      }));
      try { appendFileSync("/tmp/te-proxy/rpc.log", new Date().toISOString() + " tools/list resp: " + JSON.stringify(listed.map(t => t.name)) + "\n"); } catch {}
      send({ jsonrpc: "2.0", id, result: { tools: listed } });
    } else if (method === "tools/call") {
      if (!tools.has(params?.name)) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
        return;
      }
      const out = await callTool(params.name, params.arguments ?? {});
      send({ jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        isError: out?.success === false,
      }});
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (err) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err?.message ?? err) } });
  }
});
