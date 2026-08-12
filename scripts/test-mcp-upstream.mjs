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
// This suite exercises upstream proxy machinery, which is full-profile-only
// (the slim profile deliberately never registers native proxies). Individual
// slim-specific cases override CHATGPT_TOOL_PROFILE themselves.
const suiteProfile = process.env.CHATGPT_TOOL_PROFILE;
const suiteFullDiskAccess = process.env.FULL_DISK_ACCESS;
process.env.CHATGPT_TOOL_PROFILE = "full";
// Existing upstream feature tests intentionally exercise trusted local HTTP and
// stdio transports. Strict-mode denial is tested separately below.
process.env.FULL_DISK_ACCESS = "true";

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

async function waitForHealth(url, timeoutMs = 15000) {
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

await run("proxy preserves root additionalProperties arguments", async () => {
  const calls = [];
  const manager = {
    listServerConfigs: () => [
      { id: "dynamic", name: "Dynamic", enabled: true, expose: "all", tool_prefix: "dynamic" },
    ],
    listTools: async () => [
      {
        name: "echo",
        description: "Echo arbitrary key/value arguments",
        inputSchema: { type: "object", additionalProperties: { type: "string" } },
      },
    ],
    callTool: async (_serverId, _toolName, args) => {
      calls.push(args);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  const hub = new McpServer({ name: "dynamic-proxy-test", version: "1" });
  const client = new Client({ name: "dynamic-proxy-client", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await refreshProxiedTools(hub, manager);
    await Promise.all([hub.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({ name: "dynamic__echo", arguments: { alpha: "one", beta: "two" } });
    assert.deepEqual(calls[0], { alpha: "one", beta: "two" }, "proxy stripped JSON Schema additionalProperties arguments");
  } finally {
    await client.close().catch(() => undefined);
    await hub.close().catch(() => undefined);
  }
});

await run("proxy enforces typed root additionalProperties", async () => {
  const calls = [];
  const manager = {
    listServerConfigs: () => [
      { id: "typed-dynamic", name: "Typed Dynamic", enabled: true, expose: "all", tool_prefix: "typed_dynamic" },
    ],
    listTools: async () => [
      {
        name: "echo",
        inputSchema: { type: "object", additionalProperties: { type: "string" } },
      },
    ],
    callTool: async (_serverId, _toolName, args) => {
      calls.push(args);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  const hub = new McpServer({ name: "typed-dynamic-proxy-test", version: "1" });
  const client = new Client({ name: "typed-dynamic-proxy-client", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await refreshProxiedTools(hub, manager);
    await Promise.all([hub.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({ name: "typed_dynamic__echo", arguments: { alpha: "one" } });
    assert.deepEqual(calls[0], { alpha: "one" });
    const invalid = await client.callTool({ name: "typed_dynamic__echo", arguments: { alpha: 123 } });
    assert.equal(invalid.isError, true, "typed additionalProperties accepted an invalid value");
    assert.equal(calls.length, 1, "invalid dynamic argument reached the upstream handler");
  } finally {
    await client.close().catch(() => undefined);
    await hub.close().catch(() => undefined);
  }
});

await run("proxy preserves upstream mixed content blocks at MCP result level", async () => {
  const manager = {
    listServerConfigs: () => [
      { id: "mixed", name: "Mixed", enabled: true, expose: "all", tool_prefix: "mixed" },
    ],
    listTools: async () => [
      { name: "content", inputSchema: { type: "object", properties: {} } },
    ],
    callTool: async () => ({
      content: [
        { type: "text", text: "hello" },
        { type: "resource_link", uri: "file:///tmp/example.txt", name: "example" },
      ],
    }),
  };
  const hub = new McpServer({ name: "mixed-proxy-test", version: "1" });
  const client = new Client({ name: "mixed-proxy-client", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await refreshProxiedTools(hub, manager);
    await Promise.all([hub.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "mixed__content", arguments: {} });
    assert.equal(result.content?.[0]?.type, "text");
    assert.doesNotThrow(() => JSON.parse(result.content?.[0]?.text || ""), "proxy dropped the local-coder JSON envelope");
    const upstreamText = result.content?.find((block, index) => index > 0 && block.type === "text" && block.text === "hello");
    const resource = result.content?.find((block) => block.type === "resource_link");
    assert.ok(upstreamText, "proxy dropped the upstream text block");
    assert.ok(resource, "proxy flattened upstream resource_link into JSON text");
    assert.equal(resource.uri, "file:///tmp/example.txt");
  } finally {
    await client.close().catch(() => undefined);
    await hub.close().catch(() => undefined);
  }
});

await run("proxy preserves upstream isError and result metadata", async () => {
  const manager = {
    listServerConfigs: () => [
      { id: "error-meta", name: "Error Meta", enabled: true, expose: "all", tool_prefix: "error_meta" },
    ],
    listTools: async () => [
      { name: "fail", inputSchema: { type: "object", properties: {} } },
    ],
    callTool: async () => ({
      content: [{ type: "text", text: "upstream failure" }],
      isError: true,
      _meta: { "mock/result-meta": "preserve-me" },
    }),
  };
  const hub = new McpServer({ name: "error-meta-proxy-test", version: "1" });
  const client = new Client({ name: "error-meta-proxy-client", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await refreshProxiedTools(hub, manager);
    await Promise.all([hub.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "error_meta__fail", arguments: {} });
    assert.equal(result.isError, true, "proxy discarded upstream isError");
    assert.equal(result._meta?.["mock/result-meta"], "preserve-me", "proxy discarded upstream result _meta");
    const envelope = JSON.parse(result.content?.[0]?.text || "{}");
    assert.equal(envelope.ok, false, "local-coder envelope did not mirror upstream tool failure");
    assert.ok(result.content?.some((block, index) => index > 0 && block.type === "text" && block.text === "upstream failure"));
  } finally {
    await client.close().catch(() => undefined);
    await hub.close().catch(() => undefined);
  }
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

await run("upstream config safely preserves prototype-like env/header keys", async () => {
  const dangerousHeaders = JSON.parse('{"__proto__":"header-value","constructor":"ctor-value","Authorization":"Bearer test"}');
  const dangerousEnv = JSON.parse('{"__proto__":"env-value","constructor":"ctor-env","NORMAL":"ok"}');
  const normalized = normalizeUpstreamConfig({
    version: 1,
    servers: [{
      id: "prototype-map",
      enabled: false,
      transport: "http",
      url: "http://127.0.0.1:1/mcp",
      headers: dangerousHeaders,
      env: dangerousEnv,
      expose: "none",
    }],
  });
  const server = normalized.servers[0];
  assert.equal(Object.getPrototypeOf(server.headers), null);
  assert.equal(Object.getPrototypeOf(server.env), null);
  assert.equal(server.headers.__proto__, "header-value");
  assert.equal(server.headers.constructor, "ctor-value");
  assert.equal(server.env.__proto__, "env-value");
  assert.equal(server.env.constructor, "ctor-env");
});

await run("upstream config bounds normalized tool prefixes", async () => {
  const punctuation = normalizeUpstreamConfig({
    version: 1,
    servers: [{ id: "punctuation-prefix", enabled: true, transport: "http", url: "http://127.0.0.1:1/mcp", expose: "all", tool_prefix: "!!!" }],
  });
  assert.equal(punctuation.servers[0].tool_prefix, "___");
  assert.throws(
    () => normalizeUpstreamConfig({
      version: 1,
      servers: [{ id: "long-prefix", enabled: true, transport: "http", url: "http://127.0.0.1:1/mcp", expose: "all", tool_prefix: "x".repeat(129) }],
    }),
    /tool_prefix.*1-128/i,
  );
});

await run("concurrent upstream config mutations do not lose updates", async () => {
  const mutationPath = path.join(tmpDir, "mutation-upstream.json");
  const manager = new McpUpstreamManager(mutationPath);
  await manager.init();
  await Promise.all([
    manager.upsertServer({ id: "alpha", enabled: false, transport: "http", url: "http://127.0.0.1:1/mcp", expose: "none" }),
    manager.upsertServer({ id: "beta", enabled: false, transport: "http", url: "http://127.0.0.1:2/mcp", expose: "none" }),
  ]);
  const ids = new Set(manager.listServerConfigs().map((server) => server.id));
  assert.deepEqual(ids, new Set(["alpha", "beta"]));
  const persisted = await loadUpstreamConfig(mutationPath);
  assert.deepEqual(new Set(persisted.servers.map((server) => server.id)), new Set(["alpha", "beta"]));
  await manager.shutdown();
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

  await run("idle timeout never disconnects a busy upstream operation", async () => {
    const manager = new McpUpstreamManager(configPath);
    await manager.init();
    await manager.updateConfig({
      version: 1,
      servers: [{
        id: "busy-idle",
        enabled: true,
        transport: "http",
        url: `http://127.0.0.1:${httpPort}/mcp`,
        expose: "meta_only",
        idle_timeout_sec: 0.05,
      }],
    });
    const raw = await manager.callTool("busy-idle", "sleep", { ms: 150 });
    if (!JSON.stringify(raw).includes("150")) throw new Error(`slow tool result missing: ${JSON.stringify(raw)}`);
    const immediate = await manager.listStatuses({ probe: false });
    if (!immediate[0]?.connected) throw new Error("busy connection was disconnected before operation completed");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const afterIdle = await manager.listStatuses({ probe: false });
    if (afterIdle[0]?.connected) throw new Error("connection did not disconnect after becoming idle");
    await manager.shutdown();
  });

  await run("upstream synchronous tool calls honor the MCP response budget", async () => {
    const previousBudget = process.env.MCP_SYNC_RESPONSE_BUDGET_MS;
    process.env.MCP_SYNC_RESPONSE_BUDGET_MS = "1000";
    const manager = new McpUpstreamManager(configPath);
    try {
      await manager.init();
      await manager.updateConfig({
        version: 1,
        servers: [{
          id: "sync-budget",
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${httpPort}/mcp`,
          expose: "meta_only",
        }],
      });
      const started = Date.now();
      await assert.rejects(() => manager.callTool("sync-budget", "sleep", { ms: 1500 }));
      const elapsed = Date.now() - started;
      if (elapsed > 3500) throw new Error(`upstream timeout ignored sync response budget: ${elapsed}ms`);
      const statuses = await manager.listStatuses({ probe: false });
      if (statuses[0]?.connected) throw new Error("timed-out upstream call kept a stale transport connected");
    } finally {
      await manager.shutdown();
      if (previousBudget === undefined) delete process.env.MCP_SYNC_RESPONSE_BUDGET_MS;
      else process.env.MCP_SYNC_RESPONSE_BUDGET_MS = previousBudget;
    }
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

  await run("allowlist proxy registers prefixed tool (full profile)", async () => {
    const oldProfile = process.env.CHATGPT_TOOL_PROFILE;
    process.env.CHATGPT_TOOL_PROFILE = "full";
    const manager = new McpUpstreamManager(configPath);
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
      const hub = new McpServer({ name: "test-hub", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
      registerMcpBridgeTools(hub, manager);
      const proxied = await refreshProxiedTools(hub, manager);
      if (!proxied.includes("mockhttp__add")) throw new Error(JSON.stringify(proxied));
      const names = manager.getProxiedToolNames(manager.getServerConfig("mockhttp"), await manager.listTools("mockhttp"));
      if (!names.includes("mockhttp__add")) throw new Error(JSON.stringify(names));
      const client = new Client({ name: "proxy-annotation-test", version: "1" }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([hub.connect(serverTransport), client.connect(clientTransport)]);
      const listed = await client.listTools();
      const add = listed.tools.find((tool) => tool.name === "mockhttp__add");
      if (!add) throw new Error("proxied add tool missing from tools/list");
      assert.equal(add.annotations?.title, "Upstream Add Annotation", "proxy discarded upstream annotation title");
      assert.equal(add.annotations?.readOnlyHint, true, "proxy discarded upstream readOnlyHint");
      assert.equal(add.annotations?.destructiveHint, false, "proxy discarded upstream destructiveHint");
      assert.equal(add.annotations?.idempotentHint, true, "proxy discarded upstream idempotentHint");
      assert.equal(add.annotations?.openWorldHint, false, "proxy discarded upstream openWorldHint");
      assert.equal(add._meta?.["mock/upstream-meta"], "preserve-me", "proxy discarded upstream tool _meta");
      const bridgeServers = listed.tools.find((tool) => tool.name === "mcp_servers");
      const bridgeTools = listed.tools.find((tool) => tool.name === "mcp_tools");
      for (const bridgeRead of [bridgeServers, bridgeTools]) {
        if (!bridgeRead) throw new Error("MCP bridge discovery tool missing from tools/list");
        assert.equal(bridgeRead.annotations?.readOnlyHint, true, `${bridgeRead.name} must remain read-only`);
        assert.equal(bridgeRead.annotations?.openWorldHint, true, `${bridgeRead.name} can contact upstream servers`);
      }
      const bridgeCall = listed.tools.find((tool) => tool.name === "mcp_call");
      if (!bridgeCall) throw new Error("mcp_call bridge tool missing from tools/list");
      assert.equal(bridgeCall.annotations?.readOnlyHint, false, "mcp_call must not claim read-only behavior");
      assert.equal(bridgeCall.annotations?.destructiveHint, true, "mcp_call must conservatively allow destructive upstream effects");
      assert.equal(bridgeCall.annotations?.idempotentHint, false, "mcp_call must not be retried as idempotent");
      assert.equal(bridgeCall.annotations?.openWorldHint, true, "mcp_call crosses the upstream trust boundary");
      await client.close();
      await hub.close();
    } finally {
      await manager.shutdown();
      if (oldProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE;
      else process.env.CHATGPT_TOOL_PROFILE = oldProfile;
    }
  });

  await run("slim profile hides configured proxy and keeps stable inventory", async () => {
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
      if (names.has("mockhttp__add")) throw new Error(`native proxy leaked into slim: ${[...names].join(",")}`);
      if (names.has("read_multiple_files")) throw new Error("heavy local tool leaked into slim profile");
      for (const t of ["read_text_file", "write_file", "run_command", "mcp_servers", "mcp_tools", "mcp_call"]) {
        if (!names.has(t)) throw new Error(`stable tool missing from slim: ${t}`);
      }
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

await run("strict mode blocks stdio upstream before process spawn", async () => {
  const previous = process.env.FULL_DISK_ACCESS;
  process.env.FULL_DISK_ACCESS = "false";
  const marker = path.join(tmpDir, "strict-stdio-spawned.txt");
  const markerScript = path.join(tmpDir, "strict-stdio-marker.mjs");
  await fs.writeFile(markerScript, [
    "import fs from 'node:fs/promises';",
    `await fs.writeFile(${JSON.stringify(marker)}, 'spawned', 'utf8');`,
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  const strictPath = path.join(tmpDir, "strict-stdio-upstream.json");
  const manager = new McpUpstreamManager(strictPath);
  try {
    await manager.init();
    await manager.updateConfig({
      version: 1,
      servers: [{
        id: "strict-stdio",
        name: "Strict stdio",
        enabled: true,
        transport: "stdio",
        command: process.execPath,
        args: [markerScript],
        expose: "meta_only",
      }],
    });
    await assert.rejects(
      () => manager.listTools("strict-stdio"),
      /UPSTREAM_LOCAL_ACCESS_BLOCKED: local stdio upstream/,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(fs.stat(marker), undefined, "strict stdio policy spawned the upstream before blocking it");
  } finally {
    await manager.shutdown();
    if (previous === undefined) delete process.env.FULL_DISK_ACCESS;
    else process.env.FULL_DISK_ACCESS = previous;
  }
});

await run("strict mode blocks loopback/private HTTP upstream before connect", async () => {
  const previous = process.env.FULL_DISK_ACCESS;
  process.env.FULL_DISK_ACCESS = "false";
  const strictPath = path.join(tmpDir, "strict-http-upstream.json");
  const manager = new McpUpstreamManager(strictPath);
  try {
    await manager.init();
    for (const [id, url, pattern] of [
      ["loopback-name", "http://localhost:65534/mcp", /UPSTREAM_LOCAL_ACCESS_BLOCKED: loopback upstream/],
      ["loopback-ip", "http://127.0.0.1:65534/mcp", /UPSTREAM_LOCAL_ACCESS_BLOCKED: non-public upstream address/],
      ["private-ip", "http://192.168.1.1:65534/mcp", /UPSTREAM_LOCAL_ACCESS_BLOCKED: non-public upstream address/],
    ]) {
      await manager.updateConfig({
        version: 1,
        servers: [{ id, name: id, enabled: true, transport: "http", url, expose: "meta_only" }],
      });
      await assert.rejects(() => manager.listTools(id), pattern);
    }
  } finally {
    await manager.shutdown();
    if (previous === undefined) delete process.env.FULL_DISK_ACCESS;
    else process.env.FULL_DISK_ACCESS = previous;
  }
});

if (suiteProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE;
else process.env.CHATGPT_TOOL_PROFILE = suiteProfile;
if (suiteFullDiskAccess === undefined) delete process.env.FULL_DISK_ACCESS;
else process.env.FULL_DISK_ACCESS = suiteFullDiskAccess;

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);