import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(3000) });
  const body = await response.json();
  return { status: response.status, body };
}

async function waitForHealth(baseUrl, predicate = () => true, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await fetchJson(`${baseUrl}/api/health`);
      if (result.status === 200 && result.body?.ok === true && predicate(result.body)) return result.body;
    } catch (err) {
      lastError = err;
    }
    await sleep(100);
  }
  throw new Error(`Manager health did not satisfy predicate: ${lastError?.message || "timeout"}`);
}

function killTree(pid) {
  if (!pidAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-manager-zero-"));
const instancesDir = path.join(root, "instances");
const stateDir = path.join(root, "state");
await fs.mkdir(instancesDir, { recursive: true });
await fs.mkdir(stateDir, { recursive: true });
const seedInstanceDir = path.join(instancesDir, "seed");
await fs.mkdir(seedInstanceDir, { recursive: true });
const seedServerPort = await freePort();
const seedAdminPort = await freePort();
const seedHealthPort = await freePort();
await fs.writeFile(path.join(seedInstanceDir, ".env"), [
  `PORT=${seedServerPort}`,
  `ADMIN_PORT=${seedAdminPort}`,
  `OPENAI_TUNNEL_HEALTH_PORT=${seedHealthPort}`,
  `WORKSPACE_PATH=${root}`,
  "CHATGPT_TOOL_PROFILE=slim",
  "FULL_DISK_ACCESS=true",
  "",
].join("\n"), "utf8");
await fs.writeFile(path.join(seedInstanceDir, "config.json"), JSON.stringify({ autoStart: false, lastTunnelUrl: "" }, null, 2), "utf8");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const env = {
  ...process.env,
  MANAGER_PORT: String(port),
  MANAGER_INSTANCES_DIR: instancesDir,
  MANAGER_STATE_DIR: stateDir,
  MCP_ENV_FILE: path.join(root, "legacy.env"),
};

const manager = spawn(process.execPath, ["manager/server.mjs", "--no-open"], {
  cwd: process.cwd(),
  env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
manager.stdout.on("data", (chunk) => { output += String(chunk); });
manager.stderr.on("data", (chunk) => { output += String(chunk); });
let replacementPid = null;

try {
  const firstHealth = await waitForHealth(baseUrl);
  assert.equal(firstHealth.name, "chatgpt-local-coder-manager", "zero-instance /api/health must preserve exact Manager identity");
  assert.equal(firstHealth.pid, manager.pid, "initial Manager health PID must match the spawned Manager");

  const instances = await fetchJson(`${baseUrl}/api/instances`);
  assert.equal(instances.status, 200);
  assert.deepEqual(instances.body.instances.map((item) => item.name), ["seed"], "test bootstrap must preserve only the explicit non-autostart seed instance");
  const migrationReceiptPath = path.join(stateDir, "legacy-instance-migration-v1.json");
  const migrationReceipt = JSON.parse(await fs.readFile(migrationReceiptPath, "utf8"));
  assert.equal(migrationReceipt.version, 1, "legacy migration tombstone must carry a versioned contract");
  assert.equal(migrationReceipt.reason, "managed-instances-present", "existing managed workspaces must establish migration completion before last-instance deletion");

  const deleted = await fetchJson(`${baseUrl}/api/instances/seed`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.ok, true, `failed to delete seed instance: ${JSON.stringify(deleted.body)}`);
  const zeroInstances = await fetchJson(`${baseUrl}/api/instances`);
  assert.deepEqual(zeroInstances.body.instances, [], "deleting the last workspace must produce a real zero-instance Manager state");

  const autostart = await fetchJson(`${baseUrl}/api/autostart`);
  assert.equal(autostart.status, 200, "autostart is a Manager-global route and must work with zero instances");
  assert.equal(autostart.body.ok, true);
  assert.equal(typeof autostart.body.enabled, "boolean");

  const profiles = await fetchJson(`${baseUrl}/api/profiles`);
  assert.equal(profiles.status, 200, "profiles is a Manager-global route and must work with zero instances");
  assert.equal(profiles.body.ok, true);

  const legacyStatus = await fetchJson(`${baseUrl}/api/status`);
  assert.equal(legacyStatus.status, 404, "instance-dependent legacy status must remain fail-closed when no workspace exists");
  assert.equal(legacyStatus.body.ok, false);

  // Hold a mutating request open before its JSON body is complete. The Manager
  // must register mutation authority before awaiting readBody(), so self-restart
  // cannot cut across a partially received state-changing request.
  const slowMutation = http.request({
    host: "127.0.0.1",
    port,
    path: "/api/instances",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "256",
      connection: "close",
    },
  });
  slowMutation.on("error", () => {});
  slowMutation.flushHeaders();
  slowMutation.write('{"name":"held-mutation"');
  await sleep(150);
  const restartWhileMutationActive = await fetchJson(`${baseUrl}/api/manager/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(restartWhileMutationActive.status, 200);
  assert.equal(restartWhileMutationActive.body.ok, false, "self-restart must fail closed while any mutation request is unsettled");
  assert.equal(restartWhileMutationActive.body.retryable, true, "active-mutation restart refusal must be explicitly retryable");
  assert.ok(
    restartWhileMutationActive.body.activeMutations?.some((entry) => entry.method === "POST" && entry.path === "/api/instances"),
    `restart refusal must identify the active mutation without exposing its body: ${JSON.stringify(restartWhileMutationActive.body)}`,
  );
  slowMutation.destroy();
  await sleep(200);
  const afterAbortedMutation = await fetchJson(`${baseUrl}/api/instances`);
  assert.deepEqual(afterAbortedMutation.body.instances, [], "aborted partial mutation must not create a workspace or leak state");

  const restart = await fetchJson(`${baseUrl}/api/manager/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(restart.status, 200);
  assert.equal(restart.body.ok, true, `zero-instance Manager self-restart failed: ${JSON.stringify(restart.body)} ${output}`);
  assert.equal(restart.body.handoffPending, true, "restart response must distinguish accepted handoff from completed port ownership");
  assert.equal(restart.body.pid, manager.pid);
  assert.ok(Number.isSafeInteger(restart.body.replacementPid) && restart.body.replacementPid > 0, "restart must return the spawned replacement PID");
  assert.notEqual(restart.body.replacementPid, manager.pid);
  replacementPid = restart.body.replacementPid;

  const replacementHealth = await waitForHealth(
    baseUrl,
    (health) => health.pid === replacementPid && health.pid !== manager.pid,
    15000,
  );
  assert.equal(replacementHealth.name, "chatgpt-local-coder-manager");
  assert.equal(replacementHealth.pid, replacementPid);

  const oldDeadline = Date.now() + 5000;
  while (Date.now() < oldDeadline && pidAlive(manager.pid)) await sleep(100);
  assert.equal(pidAlive(manager.pid), false, "old Manager PID must exit only after replacement handoff has been launched");

  const postRestartInstances = await fetchJson(`${baseUrl}/api/instances`);
  assert.deepEqual(postRestartInstances.body.instances, [], "self-restart must preserve zero-instance state without inventing workspaces");
  const postRestartMigrationReceipt = JSON.parse(await fs.readFile(migrationReceiptPath, "utf8"));
  assert.deepEqual(postRestartMigrationReceipt, migrationReceipt, "self-restart must preserve the original migration tombstone instead of rewriting/resurrecting legacy state");

  console.log(`manager-zero-instance: ok (health/global routes + self-restart ${manager.pid}->${replacementPid})`);
} finally {
  killTree(replacementPid);
  killTree(manager.pid);
  await fs.rm(root, { recursive: true, force: true });
}