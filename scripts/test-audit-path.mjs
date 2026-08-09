import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-audit-path-"));
const instanceDir = path.join(root, "instances", "demo");
await fs.mkdir(instanceDir, { recursive: true });
process.env.MCP_ENV_FILE = path.join(instanceDir, ".env");
process.env.AUDIT_LOG_PATH = ".mcp-audit.log";
const { audit, getAuditPath } = await import("../dist/lib/audit.js");
try {
  assert.equal(getAuditPath(), path.join(instanceDir, ".mcp-audit.log"));
  await audit({ tool: "audit-path-test", action: "write", status: "ok" });
  const text = await fs.readFile(path.join(instanceDir, ".mcp-audit.log"), "utf8");
  assert.match(text, /audit-path-test/);
  console.log("audit-path: ok");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
