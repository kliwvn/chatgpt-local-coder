import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testBase = path.join(repoRoot, ".tool-test-tmp");
await fs.mkdir(testBase, { recursive: true });
const temp = await fs.mkdtemp(path.join(testBase, "strict-upstream-policy-"));
const previousFullDisk = process.env.FULL_DISK_ACCESS;

try {
  process.env.FULL_DISK_ACCESS = "false";
  const { McpUpstreamManager } = await import("../dist/lib/mcp-upstream-manager.js");
  const cases = [
    { id: "stdio", transport: "stdio", command: process.execPath, args: ["-e", "process.exit(99)"], expose: "none", pattern: /UPSTREAM_LOCAL_ACCESS_BLOCKED: local stdio upstream/ },
    { id: "loopback-http", transport: "http", url: "http://127.0.0.1:65534/mcp", expose: "none", pattern: /UPSTREAM_LOCAL_ACCESS_BLOCKED: native HTTP upstream/ },
    { id: "public-ip-http", transport: "http", url: "http://93.184.216.34:65534/mcp", expose: "none", pattern: /UPSTREAM_LOCAL_ACCESS_BLOCKED: native HTTP upstream/ },
    { id: "public-name-http", transport: "http", url: "https://example.com/mcp", expose: "none", pattern: /UPSTREAM_LOCAL_ACCESS_BLOCKED: native HTTP upstream/ },
  ];

  for (const testCase of cases) {
    const configPath = path.join(temp, `${testCase.id}.json`);
    const manager = new McpUpstreamManager(configPath);
    await manager.init();
    await manager.updateConfig({ version: 1, servers: [{ ...testCase, name: testCase.id, enabled: true }] });
    await assert.rejects(() => manager.listTools(testCase.id), testCase.pattern);
    await manager.shutdown();
  }

  console.log("mcp-upstream-strict-policy: ok (stdio and native HTTP fail closed before transport)");
} finally {
  if (previousFullDisk === undefined) delete process.env.FULL_DISK_ACCESS;
  else process.env.FULL_DISK_ACCESS = previousFullDisk;
  await fs.rm(temp, { recursive: true, force: true });
}
