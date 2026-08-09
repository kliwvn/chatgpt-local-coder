import fs from "fs/promises";
import os from "node:os";
import path from "path";
import assert from "node:assert/strict";
import { fileURLToPath } from "url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  importCursorMcpConfig,
  loadUpstreamConfig,
  normalizeUpstreamConfig,
  parseClaudeCodeConfig,
  parseMcpServersFile,
  parseOpenCodeConfig,
  saveUpstreamConfig,
} from "../dist/lib/mcp-upstream-config.js";
import { McpUpstreamManager } from "../dist/lib/mcp-upstream-manager.js";
import { formatUpstreamResult, refreshProxiedTools, jsonSchemaToZodShape } from "../dist/lib/mcp-tool-proxy.js";
import { createMcpServer } from "../dist/server-factory.js";
import { registerMcpBridgeTools } from "../dist/tools/mcp-bridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clc-mcp-upstream-"));

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}: ${err.message || err}`);
  failed++;
}

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

function spawnMockHttp(port) {
  return spawn(process.execPath, [path.join(root, "scripts/mock-http-mcp.mjs")], {
    env: { ...process.env, MOCK_HTTP_MCP_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${url}`);
}

await fs.rm(tmpDir, { recursive: true, force: true });
await fs.mkdir(tmpDir, { recursive: true });

const configPath = path.join(tmpDir, "upstream.json");
process.env.MCP_UPSTREAM_CONFIG = configPath;

await run("jsonSchemaToZodShape respects required fields", async () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: { a: { type: "number" }, b: { type: "string" } },
    required: ["a"],
  });
  const aParsed = shape.a.safeParse(undefined);
  const bParsed = shape.b.safeParse(undefined);
  if (aParsed.success) throw new Error("a should be required");
  if (!bParsed.success) throw new Error("b should be optional");
});

await run("upstream result preserves mixed MCP content blocks", async () => {
  const textOnly = formatUpstreamResult({
    content: [{ type: "text", text: "alpha" }, { type: "text", text: "beta" }],
  });
  if (textOnly !== "alpha\nbeta") throw new Error(`text-only result changed: ${JSON.stringify(textOnly)}`);

  const mixed = formatUpstreamResult({
    content: [
      { type: "text", text: "hello" },
      { type: "resource_link", uri: "file:///tmp/example.txt", name: "example" },
    ],
  });
  if (!Array.isArray(mixed) || mixed.length !== 2) throw new Error(`mixed content lost structure: ${JSON.stringify(mixed)}`);
  if (mixed[1]?.uri !== "file:///tmp/example.txt") throw new Error(`resource block corrupted: ${JSON.stringify(mixed)}`);

  const emptyStructured = formatUpstreamResult({ structuredContent: {}, content: [{ type: "text", text: "fallback" }] });
  if (!emptyStructured || Array.isArray(emptyStructured) || Object.keys(emptyStructured).length !== 0) {
    throw new Error(`empty structuredContent was ignored: ${JSON.stringify(emptyStructured)}`);
  }
});

await run("save and load upstream config", async () => {
  await saveUpstreamConfig(
    {
      version: 1,
      servers: [
        {
          id: "demo",
          name: "Demo",
          enabled: true,
          transport: "http",
          url: "http://127.0.0.1:3999/mcp",
          headers: { Authorization: "Bearer test" },
          expose: "meta_only",
        },
      ],
    },
    configPath
  );
  const loaded = await loadUpstreamConfig(configPath);
  if (loaded.servers.length !== 1 || loaded.servers[0].id !== "demo") {
    throw new Error(JSON.stringify(loaded));
  }
  if (loaded.servers[0].headers?.Authorization !== "Bearer test") {
    throw new Error(`headers lost: ${JSON.stringify(loaded.servers[0].headers)}`);
  }
});

await run("upstream config rejects oversized files and unbounded shapes", async () => {
  const oversized = path.join(tmpDir, "oversized-upstream.json");
  await fs.writeFile(oversized, " ".repeat(2 * 1024 * 1024 + 1), "utf8");
  await assert.rejects(
    () => loadUpstreamConfig(oversized),
    /MCP upstream config exceeds 2097152 bytes/,
  );

  const tooMany = {
    version: 1,
    servers: Array.from({ length: 257 }, (_, i) => ({
      id: `server-${i}`,
      name: `server-${i}`,
      enabled: false,
      transport: "http",
      url: "http://127.0.0.1",
      expose: "meta_only",
    })),
  };
  assert.throws(() => normalizeUpstreamConfig(tooMany), /servers exceeds maximum 256/);

  assert.throws(
    () => normalizeUpstreamConfig({
      version: 1,
      servers: [{
        id: "bad-args",
        name: "bad-args",
        enabled: false,
        transport: "stdio",
        command: "node",
        args: "--not-an-array",
        expose: "meta_only",
      }],
    }),
    /args for bad-args must be an array/,
  );
});

await run("upstream config rejects duplicate exposed prefixes", async () => {
  let rejected = false;
  try {
    await saveUpstreamConfig(
      {
        version: 1,
        servers: [
          { id: "a", enabled: true, transport: "http", url: "http://127.0.0.1:1/mcp", expose: "all", tool_prefix: "dup" },
          { id: "b", enabled: true, transport: "http", url: "http://127.0.0.1:2/mcp", expose: "allowlist", tools: ["x"], tool_prefix: "dup" },
        ],
      },
      configPath
    );
  } catch (err) {
    rejected = /Duplicate exposed tool_prefix/.test(String(err));
  }
  if (!rejected) throw new Error("duplicate exposed prefix was accepted");
});

await run("upstream config rejects non-string env/header values", async () => {
  for (const server of [
    { id: "bad-env", enabled: true, transport: "stdio", command: "node", env: { X: 123 }, expose: "none" },
    { id: "bad-header", enabled: true, transport: "http", url: "http://127.0.0.1:1/mcp", headers: { X: 123 }, expose: "none" },
  ]) {
    let rejected = false;
    try {
      await saveUpstreamConfig({ version: 1, servers: [server] }, configPath);
    } catch (err) {
      rejected = /must be a string/.test(String(err));
    }
    if (!rejected) throw new Error(`invalid map accepted: ${server.id}`);
  }
});

await run("parse claude code mcp config", async () => {
  const fixture = {
    projects: {
      "/proj": {
        mcpServers: {
          gh: { type: "http", url: "http://127.0.0.1:3100/mcp" },
        },
      },
    },
    mcpServers: {
      local: { command: "node", args: ["srv.js"] },
    },
  };
  const parsed = parseClaudeCodeConfig(fixture);
  if (parsed.length !== 2) throw new Error(`expected 2, got ${parsed.length}`);
});

await run("parse opencode mcp config", async () => {
  const fixture = {
    mcp: {
      demo: { type: "local", command: ["node", "srv.js"] },
      remote: { type: "remote", url: "http://127.0.0.1:3200/mcp" },
    },
  };
  const parsed = parseOpenCodeConfig(fixture);
  if (parsed.length !== 2) throw new Error(`expected 2, got ${parsed.length}`);
});

await run("parse and import cursor mcp config", async () => {
  const fixture = {
    mcpServers: {
      unity: { command: "node", args: ["C:/tools/unity.js"], cwd: "C:/game" },
      crawl: { url: "http://127.0.0.1:3100/mcp" },
    },
  };
  const parsed = parseMcpServersFile(fixture);
  if (parsed.length !== 2) throw new Error(`expected 2, got ${parsed.length}`);
  const fixturePath = path.join(tmpDir, "cursor-mcp-fixture.json");
  await fs.writeFile(fixturePath, JSON.stringify(fixture), "utf-8");
  const result = await importCursorMcpConfig(fixturePath, { merge: true });
  if (!result.imported.includes("unity") || !result.imported.includes("crawl")) {
    throw new Error(JSON.stringify(result.imported));
  }
});

await run("jsonc comments do not corrupt comment-like text inside strings", async () => {
  const fixturePath = path.join(tmpDir, "cursor-jsonc-string-fixture.json");
  const literal = "literal // keep /* block-like text */";
  const jsonc = `{
    // real line comment
    "mcpServers": {
      "jsonc-string-safe": {
        "url": "http://127.0.0.1:3100/mcp/*literal-path*/",
        "headers": { "X-Literal": "${literal}" }
      }
    }
    /* real block comment */
  }`;
  await fs.writeFile(fixturePath, jsonc, "utf8");
  const result = await importCursorMcpConfig(fixturePath, { merge: true });
  const server = result.config.servers.find((entry) => entry.id === "jsonc-string-safe");
  assert.ok(server, "JSONC fixture server was not imported");
  assert.equal(server.url, "http://127.0.0.1:3100/mcp/*literal-path*/");
  assert.equal(server.headers?.["X-Literal"], literal);
});

const httpPort = 3901 + Math.floor(Math.random() * 200);
const mockHttp = spawnMockHttp(httpPort);
try {
  await waitForHealth(`http://127.0.0.1:${httpPort}/health`);

  await run("manager connects to http upstream and lists tools", async () => {
    const manager = new McpUpstreamManager(configPath);
    await manager.init();
    await manager.updateConfig({
      version: 1,
      servers: [
        {
          id: "mockhttp",
          name: "Mock HTTP",
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${httpPort}/mcp`,
          expose: "allowlist",
          tools: ["add"],
          tool_prefix: "mockhttp",
        },
      ],
    });
    const tools = await manager.listTools("mockhttp");
    if (!tools.some((t) => t.name === "add")) throw new Error("add tool missing");
    const raw = await manager.callTool("mockhttp", "add", { a: 2, b: 3 });
    const text = JSON.stringify(raw);
    if (!text.includes("5")) throw new Error(text);
    await manager.shutdown();
  });

  await run("passive status does not connect cold upstream", async () => {
    const manager = new McpUpstreamManager(configPath);
    await manager.init();
    await manager.updateConfig({
      version: 1,
      servers: [{ id: "cold", enabled: true, transport: "http", url: `http://127.0.0.1:${httpPort}/mcp`, expose: "meta_only" }],
    });
    const passive = await manager.listStatuses({ probe: false });
    if (passive[0]?.connected || passive[0]?.health !== "unknown") throw new Error(JSON.stringify(passive));
    const active = await manager.listStatuses({ probe: true });
    if (!active[0]?.connected || active[0]?.health !== "connected") throw new Error(JSON.stringify(active));
    await manager.shutdown();
  });

  await run("concurrent cold connects share one upstream connection", async () => {
    const manager = new McpUpstreamManager(configPath);
    await manager.init();
    await manager.updateConfig({
      version: 1,
      servers: [{ id: "race", enabled: true, transport: "http", url: `http://127.0.0.1:${httpPort}/mcp`, expose: "meta_only" }],
    });
    const [a, b, c] = await Promise.all([manager.connect("race"), manager.connect("race"), manager.connect("race")]);
    if (a !== b || b !== c) throw new Error("concurrent connect returned multiple connection objects");
    await manager.shutdown();
  });

  await run("config change invalidates active upstream connection", async () => {
    const manager = new McpUpstreamManager(configPath);
    await manager.init();
    await manager.updateConfig({
      version: 1,
      servers: [{ id: "swap", enabled: true, transport: "http", url: `http://127.0.0.1:${httpPort}/mcp`, expose: "meta_only" }],
    });
    await manager.connect("swap");
    let passive = await manager.listStatuses({ probe: false });
    if (!passive[0]?.connected) throw new Error("expected active connection before config change");
    await manager.updateConfig({
      version: 1,
      servers: [{ id: "swap", enabled: true, transport: "http", url: `http://127.0.0.1:${httpPort}/mcp?rev=2`, expose: "meta_only" }],
    });
    passive = await manager.listStatuses({ probe: false });
    if (passive[0]?.connected) throw new Error("stale connection survived config change");
    await manager.shutdown();
  });

  await run("allowlist proxy registers prefixed tool", async () => {
    const manager = new McpUpstreamManager(configPath);
    await manager.init();
    await manager.updateConfig({
      version: 1,
      servers: [
        {
          id: "mockhttp",
          name: "Mock HTTP",
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${httpPort}/mcp`,
          expose: "allowlist",
          tools: ["add"],
          tool_prefix: "mockhttp",
        },
      ],
    });
    const hub = new McpServer({ name: "test-hub", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
    registerMcpBridgeTools(hub, manager);
    const proxied = await refreshProxiedTools(hub, manager);
    if (!proxied.includes("mockhttp__add")) throw new Error(JSON.stringify(proxied));
    const names = manager.getProxiedToolNames(manager.getServerConfig("mockhttp"), await manager.listTools("mockhttp"));
    if (!names.includes("mockhttp__add")) throw new Error(JSON.stringify(names));
    await manager.shutdown();
  });

  await run("slim profile keeps configured proxy but hides heavy local tools", async () => {
    const oldProfile = process.env.CHATGPT_TOOL_PROFILE;
    process.env.CHATGPT_TOOL_PROFILE = "slim";
    const manager = new McpUpstreamManager(configPath);
    let server;
    let client;
    try {
      await manager.init();
      await manager.updateConfig({
        version: 1,
        servers: [
          {
            id: "mockhttp",
            name: "Mock HTTP",
            enabled: true,
            transport: "http",
            url: `http://127.0.0.1:${httpPort}/mcp`,
            expose: "allowlist",
            tools: ["add"],
            tool_prefix: "mockhttp",
          },
        ],
      });
      server = await createMcpServer(root, 30, [root], false, manager, "test instructions");
      client = new Client({ name: "slim-proxy-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const list = await client.listTools();
      const names = new Set((list.tools || []).map((t) => t.name));
      if (!names.has("mockhttp__add")) throw new Error(`proxy missing from slim: ${[...names].join(",")}`);
      if (names.has("read_multiple_files")) throw new Error("heavy local tool leaked into slim profile");
    } finally {
      await client?.close().catch(() => undefined);
      await server?.close().catch(() => undefined);
      await manager.shutdown();
      if (oldProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE;
      else process.env.CHATGPT_TOOL_PROFILE = oldProfile;
    }
  });
} finally {
  mockHttp.kill("SIGTERM");
}

await run("manager connects to stdio mock upstream", async () => {
  const manager = new McpUpstreamManager(configPath);
  await manager.init();
  await manager.updateConfig({
    version: 1,
    servers: [
      {
        id: "mockstdio",
        name: "Mock Stdio",
        enabled: true,
        transport: "stdio",
        command: process.execPath,
        args: [path.join(root, "scripts/mock-stdio-mcp.mjs")],
        expose: "meta_only",
      },
    ],
  });
  const tools = await manager.listTools("mockstdio");
  if (!tools.some((t) => t.name === "echo")) throw new Error(JSON.stringify(tools));
  const raw = await manager.callTool("mockstdio", "echo", { message: "hi" });
  const text = JSON.stringify(raw);
  if (!text.includes("echo:hi")) throw new Error(text);
  await manager.disconnect("mockstdio");
  await manager.shutdown();
});

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);