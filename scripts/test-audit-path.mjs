import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-audit-path-"));
const instanceDir = path.join(root, "instances", "demo");
await fs.mkdir(instanceDir, { recursive: true });
process.env.MCP_ENV_FILE = path.join(instanceDir, ".env");
process.env.AUDIT_LOG_PATH = ".mcp-audit.log";
process.env.AUDIT_LOG_MAX_BYTES = "4096";
const { audit, getAuditPath } = await import("../dist/lib/audit.js");
try {
  assert.equal(getAuditPath(), path.join(instanceDir, ".mcp-audit.log"));
  await audit({ tool: "audit-path-test", action: "write", status: "ok" });
  const text = await fs.readFile(path.join(instanceDir, ".mcp-audit.log"), "utf8");
  assert.match(text, /audit-path-test/);

  const markers = Array.from({ length: 8 }, (_, index) => `audit-rotation-${index}`);
  await Promise.all(
    markers.map((tool, index) =>
      audit({
        tool,
        action: "write",
        status: "ok",
        details: { index, payload: "x".repeat(480) },
      })
    )
  );
  const active = await fs.readFile(path.join(instanceDir, ".mcp-audit.log"), "utf8");
  const rotated = await fs.readFile(path.join(instanceDir, ".mcp-audit.log.1"), "utf8");
  const combined = rotated + active;
  for (const marker of markers) assert.match(combined, new RegExp(marker));

  // The optimized writer caches directory/size state. Preserve the old behavior
  // where deleting the instance directory does not permanently disable auditing.
  await fs.rm(instanceDir, { recursive: true, force: true });
  await audit({ tool: "audit-directory-recreated", action: "write", status: "ok" });
  const recreated = await fs.readFile(path.join(instanceDir, ".mcp-audit.log"), "utf8");
  assert.match(recreated, /audit-directory-recreated/);
  console.log("audit-path: ok");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
