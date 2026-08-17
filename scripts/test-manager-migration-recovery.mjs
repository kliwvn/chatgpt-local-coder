import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
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
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else { try { process.kill(pid, "SIGTERM"); } catch {} }
}

async function makeStage(instancesDir, migrationId, { markerId = migrationId, includeMarker = true, alreadyDefault = false } = {}) {
  const dir = path.join(instancesDir, alreadyDefault ? "default" : `.legacy-default-migration-${migrationId}`);
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
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ autoStart: false, lastTunnelUrl: "", healthPort }, null, 2), "utf8");
  if (includeMarker) {
    await fs.writeFile(
      path.join(dir, ".legacy-instance-migration-v1.json"),
      JSON.stringify({ version: 1, migrationId: markerId, source: "legacy-single-instance" }, null, 2),
      "utf8",
    );
  }
  return dir;
}

async function runCase(name, setup, verify, { expectHealthy = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `clc-migration-${name}-`));
  const instancesDir = path.join(root, "instances");
  const stateDir = path.join(root, "state");
  await fs.mkdir(instancesDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await setup({ root, instancesDir, stateDir });
  const port = await freePort();
  const manager = spawn(process.execPath, ["manager/server.mjs", "--no-open"], {
    cwd: process.cwd(),
    env: { ...process.env, MANAGER_PORT: String(port), MANAGER_INSTANCES_DIR: instancesDir, MANAGER_STATE_DIR: stateDir },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  manager.stdout.on("data", (chunk) => { output += String(chunk); });
  manager.stderr.on("data", (chunk) => { output += String(chunk); });
  try {
    if (expectHealthy) {
      const deadline = Date.now() + 10000;
      let health = null;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
          const body = await response.json();
          if (response.ok && body?.ok === true) { health = body; break; }
        } catch {}
        await sleep(100);
      }
      assert.ok(health, `${name}: Manager did not become healthy: ${output}`);
    } else {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && pidAlive(manager.pid)) await sleep(100);
      assert.equal(pidAlive(manager.pid), false, `${name}: invalid migration state must fail startup instead of binding Manager: ${output}`);
    }
    await verify({ root, instancesDir, stateDir, output, managerPid: manager.pid, port });
  } finally {
    killTree(manager.pid);
    await fs.rm(root, { recursive: true, force: true });
  }
}

await runCase("prepared-stage", async ({ instancesDir, stateDir }) => {
  const id = "prepared-stage-001";
  await makeStage(instancesDir, id);
  await fs.writeFile(path.join(stateDir, "legacy-instance-migration-v1.json"), JSON.stringify({ version: 1, state: "prepared", migrationId: id }, null, 2));
}, async ({ instancesDir, stateDir }) => {
  assert.equal(await fs.stat(path.join(instancesDir, "default")).then(() => true, () => false), true);
  const receipt = JSON.parse(await fs.readFile(path.join(stateDir, "legacy-instance-migration-v1.json"), "utf8"));
  assert.equal(receipt.state, "complete");
  assert.equal(receipt.migrationId, "prepared-stage-001");
  assert.equal(receipt.reason, "legacy-default-migrated-stage-recovered");
  assert.equal((await fs.readdir(instancesDir)).some((name) => name.startsWith(".legacy-default-migration-")), false);
});

await runCase("orphan-marked-stage", async ({ instancesDir }) => {
  await makeStage(instancesDir, "orphan-marked-001");
}, async ({ instancesDir, stateDir }) => {
  assert.equal(await fs.stat(path.join(instancesDir, "default")).then(() => true, () => false), true);
  const receipt = JSON.parse(await fs.readFile(path.join(stateDir, "legacy-instance-migration-v1.json"), "utf8"));
  assert.equal(receipt.state, "complete");
  assert.equal(receipt.migrationId, "orphan-marked-001");
  assert.equal(receipt.reason, "legacy-default-migrated-stage-recovered-without-receipt");
});

await runCase("already-renamed", async ({ instancesDir, stateDir }) => {
  const id = "already-renamed-001";
  await makeStage(instancesDir, id, { alreadyDefault: true });
  await fs.writeFile(path.join(stateDir, "legacy-instance-migration-v1.json"), JSON.stringify({ version: 1, state: "prepared", migrationId: id }, null, 2));
}, async ({ stateDir }) => {
  const receipt = JSON.parse(await fs.readFile(path.join(stateDir, "legacy-instance-migration-v1.json"), "utf8"));
  assert.equal(receipt.state, "complete");
  assert.equal(receipt.reason, "legacy-default-migrated-recovered");
});

await runCase("partial-stage", async ({ instancesDir }) => {
  await makeStage(instancesDir, "partial-001", { includeMarker: false });
}, async ({ instancesDir, stateDir, output }) => {
  assert.equal(await fs.stat(path.join(instancesDir, ".legacy-default-migration-partial-001")).then(() => true, () => false), true, "partial stage must be preserved for explicit recovery");
  assert.equal(await fs.stat(path.join(instancesDir, "default")).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(stateDir, "legacy-instance-migration-v1.json")).then(() => true, () => false), false, "partial stage must never gain a false completion receipt");
  assert.match(output, /LEGACY_INSTANCE_MIGRATION_ORPHAN_STAGE/);
}, { expectHealthy: false });

await runCase("marker-mismatch", async ({ instancesDir, stateDir }) => {
  const id = "expected-001";
  await makeStage(instancesDir, id, { markerId: "wrong-001" });
  await fs.writeFile(path.join(stateDir, "legacy-instance-migration-v1.json"), JSON.stringify({ version: 1, state: "prepared", migrationId: id }, null, 2));
}, async ({ instancesDir, stateDir, output }) => {
  assert.equal(await fs.stat(path.join(instancesDir, `.legacy-default-migration-expected-001`)).then(() => true, () => false), true);
  const receipt = JSON.parse(await fs.readFile(path.join(stateDir, "legacy-instance-migration-v1.json"), "utf8"));
  assert.equal(receipt.state, "prepared", "mismatched marker must not be rewritten complete");
  assert.match(output, /LEGACY_INSTANCE_MIGRATION_MARKER_INVALID/);
}, { expectHealthy: false });

console.log("manager-migration-recovery: ok (prepared/orphan/already-renamed recovery + partial/mismatched fail-closed)");