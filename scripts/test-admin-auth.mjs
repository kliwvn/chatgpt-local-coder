import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${url}`);
}

const mcpPort = await freePort();
const adminPort = await freePort();
const token = "admin-auth-test-token";
const root = path.resolve(process.cwd());
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-admin-auth-"));
const oversizedEnvPath = path.join(temp, ".env");
await fs.writeFile(oversizedEnvPath, "X".repeat(2 * 1024 * 1024 + 1), "utf8");
const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(mcpPort),
    ADMIN_PORT: String(adminPort),
    ADMIN_TOKEN: token,
    WORKSPACE_PATH: root,
    CHATGPT_TOOL_PROFILE: "slim",
    MCP_ENV_FILE: oversizedEnvPath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

try {
  await waitFor(`http://127.0.0.1:${mcpPort}/health`);

  const ui = await fetch(`http://127.0.0.1:${adminPort}/ui/`);
  assert.equal(ui.status, 200, "localhost Admin UI shell must load without an auth header");
  assert.match(String(ui.headers.get("content-type")), /text\/html/i);

  const blocked = await fetch(`http://127.0.0.1:${adminPort}/health`);
  assert.equal(blocked.status, 401, "Admin API must remain protected when ADMIN_TOKEN is enabled");

  const allowed = await fetch(`http://127.0.0.1:${adminPort}/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(allowed.status, 200);
  const health = await allowed.json();
  assert.equal(health.mcp_port, mcpPort);

  const oversizedEnv = await fetch(`http://127.0.0.1:${adminPort}/api/config/env`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(oversizedEnv.status, 413, "oversized Admin .env should fail bounded instead of being read into memory");
  assert.match(await oversizedEnv.text(), /Admin \.env exceeds 2097152 bytes/);

  await fs.writeFile(oversizedEnvPath, [
    "MCP_SESSION_RECOVERY=false",
    "MCP_SESSION_TTL_MS=120000",
    "MCP_SESSION_CLEANUP_MS=15000",
    "TEST_KEEP=one",
    "",
  ].join("\n"), "utf8");
  const legacyEnvResponse = await fetch(`http://127.0.0.1:${adminPort}/api/config/env`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(legacyEnvResponse.status, 200);
  const legacyEnvBody = await legacyEnvResponse.json();
  assert.equal(Object.prototype.hasOwnProperty.call(legacyEnvBody.values, "MCP_SESSION_RECOVERY"), false, "Admin API must hide obsolete recovery config");
  const saveEnvResponse = await fetch(`http://127.0.0.1:${adminPort}/api/config/env`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ values: { TEST_KEEP: "two", MCP_SESSION_RECOVERY: "false" } }),
  });
  assert.equal(saveEnvResponse.status, 200);
  const savedEnv = await fs.readFile(oversizedEnvPath, "utf8");
  assert.match(savedEnv, /^TEST_KEEP=two$/m);
  assert.doesNotMatch(savedEnv, /^MCP_SESSION_RECOVERY=/m, "Admin save must scrub obsolete recovery config even if a client sends it");

  const uiJs = await (await fetch(`http://127.0.0.1:${adminPort}/ui/app.js`)).text();
  assert.match(uiJs, /sessionStorage\.setItem\(ADMIN_TOKEN_SESSION_KEY/);
  assert.match(uiJs, /ADMIN_TOKEN_SESSION_KEY_BASE.*API_INSTANCE/s, "proxied multi-instance UI must scope session token by instance");
  assert.match(uiJs, /headers\.Authorization = `Bearer \$\{token\}`/);
  assert.doesNotMatch(uiJs, /ADMIN_TOKEN.*localStorage|localStorage.*ADMIN_TOKEN/i);

  console.log("admin-auth: ok (static UI loadable, API 401/200 boundary preserved, obsolete recovery config scrubbed, token session-scoped)");
} catch (err) {
  throw new Error(`${err.message}\nserver output:\n${output.slice(-3000)}`);
} finally {
  try {
    await fetch(`http://127.0.0.1:${adminPort}/api/process/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {}
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 6000)),
  ]);
  if (child.exitCode == null) child.kill();
  await fs.rm(temp, { recursive: true, force: true });
}