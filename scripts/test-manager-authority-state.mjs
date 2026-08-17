import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STATUS_REQUEST_TIMEOUT_MS = 30000;
const HEALTH_PROBE_TIMEOUT_MS = 2000;
const SERVER_START_REQUEST_TIMEOUT_MS = 150000;

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

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; }
}

function killTree(pid) {
  if (!pidAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
}

async function writeInstance(instancesDir, name, { config = "valid", pid = null } = {}) {
  const dir = path.join(instancesDir, name);
  await fs.mkdir(dir, { recursive: true });
  const port = await freePort();
  const adminPort = await freePort();
  const healthPort = await freePort();
  await fs.writeFile(path.join(dir, ".env"), [
    `PORT=${port}`,
    `ADMIN_PORT=${adminPort}`,
    `OPENAI_TUNNEL_HEALTH_PORT=${healthPort}`,
    `WORKSPACE_PATH=${dir}`,
    "CHATGPT_TOOL_PROFILE=slim",
    "FULL_DISK_ACCESS=true",
    "",
  ].join("\n"), "utf8");
  if (config === "valid") {
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ autoStart: false, lastTunnelUrl: "", healthPort }, null, 2), "utf8");
  } else if (config === "corrupt") {
    await fs.writeFile(path.join(dir, "config.json"), '{"autoStart":', "utf8");
  }
  if (pid !== null) await fs.writeFile(path.join(dir, "server.pid"), String(pid), "utf8");
  return { dir, port, adminPort, healthPort };
}

async function fetchJson(baseUrl, pathname, options = {}, timeoutMs = STATUS_REQUEST_TIMEOUT_MS) {
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: response.status, body };
}

async function waitHealth(baseUrl, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await fetchJson(baseUrl, "/api/health", {}, HEALTH_PROBE_TIMEOUT_MS);
      if (result.status === 200 && result.body?.ok === true) return result.body;
    } catch {}
    await sleep(100);
  }
  throw new Error("Manager did not become healthy");
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-manager-authority-"));
const instancesDir = path.join(root, "instances");
const stateDir = path.join(root, "state");
await fs.mkdir(instancesDir, { recursive: true });
await fs.mkdir(stateDir, { recursive: true });
await fs.writeFile(
  path.join(stateDir, "legacy-instance-migration-v1.json"),
  JSON.stringify({ version: 1, state: "complete", reason: "test-authority", completedAt: new Date().toISOString() }, null, 2),
  "utf8",
);

const good = await writeInstance(instancesDir, "good");
const corrupt = await writeInstance(instancesDir, "corrupt", { config: "corrupt" });
const missing = await writeInstance(instancesDir, "missing", { config: "missing" });
const badPid = await writeInstance(instancesDir, "badpid", { pid: "not-a-pid" });
const corruptConfigPath = path.join(corrupt.dir, "config.json");
const corruptConfigOriginal = await fs.readFile(corruptConfigPath, "utf8");
const corruptEnvPath = path.join(corrupt.dir, ".env");
const corruptEnvOriginal = await fs.readFile(corruptEnvPath, "utf8");
const badPidPath = path.join(badPid.dir, "server.pid");
const badPidOriginal = await fs.readFile(badPidPath, "utf8");

const managerPort = await freePort();
const baseUrl = `http://127.0.0.1:${managerPort}`;
const manager = spawn(process.execPath, ["manager/server.mjs", "--no-open"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MANAGER_PORT: String(managerPort),
    MANAGER_INSTANCES_DIR: instancesDir,
    MANAGER_STATE_DIR: stateDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
manager.stdout.on("data", (chunk) => { output += String(chunk); });
manager.stderr.on("data", (chunk) => { output += String(chunk); });

try {
  const health = await waitHealth(baseUrl);
  assert.equal(health.name, "chatgpt-local-coder-manager");

  // Give detached bootstrap enough time to inspect all configs. None may be
  // started: explicit valid config is false, missing config is fail-safe false,
  // and corrupt config is rejected rather than defaulted to true.
  await sleep(800);
  for (const item of [good, corrupt, missing, badPid]) {
    assert.equal(await new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(250);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.connect(item.port, "127.0.0.1");
    }), false, `authority failure unexpectedly autostarted port ${item.port}`);
  }

  const listed = await fetchJson(baseUrl, "/api/instances");
  assert.equal(listed.status, 200);
  const byName = new Map(listed.body.instances.map((item) => [item.name, item]));
  assert.equal(byName.get("good")?.error, undefined);
  assert.equal(byName.get("good")?.config?.autoStart, false);
  assert.equal(byName.get("missing")?.error, undefined, "missing config must use the safe managed fallback, not become an instance-wide error");
  assert.equal(byName.get("missing")?.config?.autoStart, false, "missing config authority must never imply autostart consent");
  assert.match(byName.get("corrupt")?.error || "", /MANAGER_JSON_INVALID/);
  assert.equal(byName.get("corrupt")?.config?.autoStart, false, "corrupt config fallback shown to UI must be fail-safe false");
  assert.match(byName.get("badpid")?.error || "", /MANAGER_PID_INVALID/);
  assert.equal(byName.get("badpid")?.config?.autoStart, false, "invalid PID authority must not produce a false-green bundle");
  assert.equal(await fs.readFile(corruptConfigPath, "utf8"), corruptConfigOriginal, "corrupt config bytes must remain untouched for explicit repair");
  assert.equal(await fs.readFile(badPidPath, "utf8"), badPidOriginal, "invalid PID ledger must remain untouched instead of being treated as missing/adoptable");

  const corruptEnvSave = await fetchJson(baseUrl, "/api/instances/corrupt/env", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { PROJECT_MEMORY_MAX_BYTES: "12345" } }),
  });
  assert.notEqual(corruptEnvSave.body?.ok, true, "environment save must fail closed when companion config authority is corrupt");
  assert.equal(corruptEnvSave.body?.committed, false);
  assert.equal(await fs.readFile(corruptEnvPath, "utf8"), corruptEnvOriginal, "failed logical env+config mutation must preserve exact prior .env bytes");
  assert.equal(await fs.readFile(corruptConfigPath, "utf8"), corruptConfigOriginal, "failed logical env+config mutation must preserve corrupt config bytes for explicit repair");

  const corruptStart = await fetchJson(baseUrl, "/api/instances/corrupt/server/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }, SERVER_START_REQUEST_TIMEOUT_MS);
  assert.equal(corruptStart.body?.ok, true, `explicit manual Server start may use intact .env/PID authority even when tunnel/autostart config is corrupt: ${JSON.stringify(corruptStart.body)}`);
  assert.equal(await fs.readFile(corruptConfigPath, "utf8"), corruptConfigOriginal, "manual Server start must never rewrite corrupt tunnel/autostart config bytes");
  const corruptStop = await fetchJson(baseUrl, "/api/instances/corrupt/server/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(corruptStop.body?.ok, true, `explicit manual Server stop must remain available for recovery: ${JSON.stringify(corruptStop.body)}`);
  assert.equal(await fs.readFile(corruptConfigPath, "utf8"), corruptConfigOriginal, "manual Server stop must preserve corrupt config bytes for explicit repair");

  const peerCreate = await fetchJson(baseUrl, "/api/instances", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "peer", workspacePath: good.dir, autoStart: false }),
  });
  assert.equal(peerCreate.body?.ok, true, `corrupt auxiliary config in one instance must not block unrelated catalog allocation: ${JSON.stringify(peerCreate.body)}`);
  const peerDelete = await fetchJson(baseUrl, "/api/instances/peer", { method: "DELETE" });
  assert.equal(peerDelete.body?.ok, true, `peer cleanup after isolated catalog allocation failed: ${JSON.stringify(peerDelete.body)}`);

  const corruptRename = await fetchJson(baseUrl, "/api/instances/corrupt/rename", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "corrupt-renamed" }),
  });
  assert.equal(corruptRename.body?.ok, true, `inactive corrupt instance must remain administratively recoverable by exact process-absence proof: ${JSON.stringify(corruptRename.body)}`);
  const renamedDir = path.join(instancesDir, "corrupt-renamed");
  assert.equal(await fs.readFile(path.join(renamedDir, "config.json"), "utf8"), corruptConfigOriginal, "rename recovery must preserve corrupt config bytes exactly");
  const corruptDelete = await fetchJson(baseUrl, "/api/instances/corrupt-renamed", { method: "DELETE" });
  assert.equal(corruptDelete.body?.ok, true, `inactive corrupt instance must be deletable only after exact process-absence proof: ${JSON.stringify(corruptDelete.body)}`);
  assert.equal(await fs.stat(renamedDir).then(() => true, () => false), false, "successful corrupt-instance delete must remove/recycle the instance directory");

  const badPidStart = await fetchJson(baseUrl, "/api/instances/badpid/server/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.notEqual(badPidStart.body?.ok, true, "manual start with invalid PID authority must fail closed");
  assert.equal(await fs.readFile(badPidPath, "utf8"), badPidOriginal);

  console.log("manager-authority-state: ok (corrupt/missing config + invalid PID fail closed without autostart or byte rewriting)");
} finally {
  killTree(manager.pid);
  await fs.rm(root, { recursive: true, force: true });
}