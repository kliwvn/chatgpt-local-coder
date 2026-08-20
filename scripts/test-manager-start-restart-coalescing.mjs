import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

async function waitFor(fn, timeoutMs = 30000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await sleep(intervalMs);
  }
  return null;
}

const managerPort = await freePort();
const serverPort = await freePort();
const adminPort = await freePort();
const healthPort = await freePort();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-start-restart-race-"));
const instances = path.join(root, "instances");
const stateDir = path.join(root, "state");
const instanceDir = path.join(instances, "race-demo");
await fs.mkdir(instanceDir, { recursive: true });
await fs.writeFile(path.join(instanceDir, ".env"), [
  `PORT=${serverPort}`,
  `ADMIN_PORT=${adminPort}`,
  `WORKSPACE_PATH=${process.cwd()}`,
  "OPENAI_TUNNEL_ID=",
  "OPENAI_TUNNEL_API_KEY=",
  `OPENAI_TUNNEL_HEALTH_PORT=${healthPort}`,
  "CHATGPT_TOOL_PROFILE=slim",
  "FULL_DISK_ACCESS=true",
  "SHELL_TIMEOUT=120",
  "MCP_SESSION_TTL_MS=120000",
  "MCP_SESSION_CLEANUP_MS=15000",
  "MCP_SESSION_DELETE_GRACE_MS=45000",
  "MCP_MAX_SESSIONS=64",
  "",
].join("\n"), "utf8");
await fs.writeFile(path.join(instanceDir, "config.json"), JSON.stringify({
  healthPort,
  autoStart: false,
}), "utf8");

const manager = spawn(process.execPath, ["manager/server.mjs", "--no-open"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MANAGER_PORT: String(managerPort),
    MANAGER_INSTANCES_DIR: instances,
    MANAGER_STATE_DIR: stateDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let managerOutput = "";
manager.stdout.on("data", (chunk) => { managerOutput += chunk.toString(); });
manager.stderr.on("data", (chunk) => { managerOutput += chunk.toString(); });

const observedManagedPids = new Set();

function rememberManagedPid(value) {
  const pid = Number(value);
  if (Number.isSafeInteger(pid) && pid > 0 && pid !== manager.pid) observedManagedPids.add(pid);
}

function killPidTree(pid) {
  if (!pidAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
}

async function request(method, route, body = {}) {
  const response = await fetch(`http://127.0.0.1:${managerPort}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: ["GET", "HEAD"].includes(method) ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = JSON.parse(text);
  // Cleanup must not depend on which assertion happens to run next. A failed
  // assertion can occur after Manager spawned a detached Gateway but before the
  // happy-path livePid variable is updated. Remember every lifecycle PID as soon
  // as it crosses the API boundary so exceptional cleanup still owns it.
  rememberManagedPid(parsed?.pid);
  rememberManagedPid(parsed?.previousPid);
  return parsed;
}

async function post(route, body = {}) {
  return request("POST", route, body);
}

let livePid = null;
try {
  const ready = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${managerPort}/api/health`);
    return response.ok ? await response.json() : null;
  });
  assert.ok(ready?.ok, `manager did not become ready: ${managerOutput}`);

  // Reproduce the real bug: explicit Restart lands while a boot/manual Start for
  // the same stopped instance is already inside the shared deploy transaction.
  const startPromise = post("/api/instances/race-demo/server/start");
  await sleep(20);
  const restartPromise = post("/api/instances/race-demo/server/restart");
  const [started, restarted] = await Promise.all([startPromise, restartPromise]);

  assert.equal(started.ok, true, `in-flight Start failed: ${JSON.stringify(started)}`);
  assert.equal(started.started, true, `stopped-instance Start must report an actual new generation: ${JSON.stringify(started)}`);
  assert.equal(started.alreadyRunning, false, "a newly spawned process must not be mislabeled alreadyRunning");
  assert.ok(Number.isInteger(started.pid) && started.pid > 0, "Start must return the spawned PID");
  livePid = started.pid;

  assert.equal(restarted.ok, true, `overlapping Restart failed: ${JSON.stringify(restarted)}`);
  assert.equal(restarted.restarted, true, "Restart intent must be satisfied");
  assert.equal(restarted.coalescedInFlightStart, true, "Restart must coalesce with the exact-current in-flight Start instead of bouncing it");
  assert.equal(restarted.pid, started.pid, "coalesced Restart must preserve the freshly started PID");

  const log = await fs.readFile(path.join(instanceDir, "server.log"), "utf8");
  const starts = (log.match(/\[manager-start\]/g) || []).length;
  const shutdowns = (log.match(/\[DUNG\]/g) || []).length;
  assert.equal(starts, 1, `race must create exactly one Gateway generation before cleanup; observed ${starts}\n${log}`);
  assert.equal(shutdowns, 0, `fresh in-flight generation must not be immediately shut down by overlapping Restart; observed ${shutdowns}\n${log}`);

  // Two explicit Restart requests that overlap must also share one lifecycle
  // mutation. Serialization alone is insufficient: without an in-flight Restart
  // ledger the second request would stop/start the PID produced by the first.
  const beforeDuplicateRestartPid = livePid;
  const beforeDuplicateRestartLog = await fs.readFile(path.join(instanceDir, "server.log"), "utf8");
  const startsBeforeDuplicate = (beforeDuplicateRestartLog.match(/\[manager-start\]/g) || []).length;
  const shutdownsBeforeDuplicate = (beforeDuplicateRestartLog.match(/\[DUNG\]/g) || []).length;
  const restartA = post("/api/instances/race-demo/server/restart");
  await sleep(5);
  const restartB = post("/api/instances/race-demo/server/restart");
  const [duplicateA, duplicateB] = await Promise.all([restartA, restartB]);

  assert.equal(duplicateA.ok, true, `first duplicate Restart failed: ${JSON.stringify(duplicateA)}`);
  assert.equal(duplicateB.ok, true, `second duplicate Restart failed: ${JSON.stringify(duplicateB)}`);
  assert.equal(duplicateA.restarted, true, "first duplicate Restart must report restart intent satisfied");
  assert.equal(duplicateB.restarted, true, "second duplicate Restart must report restart intent satisfied");
  assert.equal(duplicateA.previousPid, beforeDuplicateRestartPid, "coalesced duplicate Restart must report the original previous PID");
  assert.equal(duplicateB.previousPid, beforeDuplicateRestartPid, "both overlapping Restart callers must observe the same previous PID");
  assert.equal(duplicateA.pid, duplicateB.pid, "overlapping Restart callers must observe the same replacement PID");
  assert.notEqual(duplicateA.pid, beforeDuplicateRestartPid, "one real Restart must replace the old PID");
  livePid = duplicateA.pid;

  const afterDuplicateRestartLog = await fs.readFile(path.join(instanceDir, "server.log"), "utf8");
  const startsAfterDuplicate = (afterDuplicateRestartLog.match(/\[manager-start\]/g) || []).length;
  const shutdownsAfterDuplicate = (afterDuplicateRestartLog.match(/\[DUNG\]/g) || []).length;
  assert.equal(startsAfterDuplicate - startsBeforeDuplicate, 1, `overlapping Restart requests must create exactly one new Gateway generation; log:\n${afterDuplicateRestartLog}`);
  assert.equal(shutdownsAfterDuplicate - shutdownsBeforeDuplicate, 1, `overlapping Restart requests must stop the old Gateway exactly once; log:\n${afterDuplicateRestartLog}`);

  const stopped = await post("/api/instances/race-demo/server/stop");
  assert.equal(stopped.ok, true, `cleanup stop failed: ${JSON.stringify(stopped)}`);
  livePid = null;

  // Last explicit intent must win across the whole public command, including the
  // shared build/deploy phase that happens before the low-level lifecycle queue.
  // Old behavior let Stop observe "not running" and return before Start spawned.
  const startThenStopStart = post("/api/instances/race-demo/server/start");
  await sleep(5);
  const startThenStopStop = post("/api/instances/race-demo/server/stop");
  const [startBeforeStop, stopAfterStart] = await Promise.all([startThenStopStart, startThenStopStop]);
  assert.equal(startBeforeStop.ok, true, `Start->Stop initial Start failed: ${JSON.stringify(startBeforeStop)}`);
  assert.equal(stopAfterStart.ok, true, `Start->Stop Stop failed: ${JSON.stringify(stopAfterStart)}`);
  assert.ok(Number.isInteger(startBeforeStop.pid), "Start->Stop must have spawned one concrete PID before Stop settles");
  const stoppedFinal = (await (await fetch(`http://127.0.0.1:${managerPort}/api/instances`)).json()).instances.find((item) => item.name === "race-demo");
  assert.equal(stoppedFinal?.server?.running, false, `last Stop intent must leave Gateway stopped: ${JSON.stringify(stoppedFinal?.server)}`);
  assert.equal(pidAlive(startBeforeStop.pid), false, "Start->Stop must leave the PID created by the earlier Start fully exited");

  // A third Start after the Stop is a new intent generation. It must queue after
  // Stop, never stale-coalesce onto Start1 merely because Start1 is still settling.
  const orderedStart1Promise = post("/api/instances/race-demo/server/start");
  await sleep(5);
  const orderedStopPromise = post("/api/instances/race-demo/server/stop");
  await sleep(5);
  const orderedStart2Promise = post("/api/instances/race-demo/server/start");
  const [orderedStart1, orderedStop, orderedStart2] = await Promise.all([
    orderedStart1Promise,
    orderedStopPromise,
    orderedStart2Promise,
  ]);
  assert.equal(orderedStart1.ok, true, `Start1 failed: ${JSON.stringify(orderedStart1)}`);
  assert.equal(orderedStop.ok, true, `middle Stop failed: ${JSON.stringify(orderedStop)}`);
  assert.equal(orderedStart2.ok, true, `Start2 failed: ${JSON.stringify(orderedStart2)}`);
  assert.ok(Number.isInteger(orderedStart1.pid) && Number.isInteger(orderedStart2.pid), "ordered starts must return concrete PIDs");
  assert.notEqual(orderedStart2.pid, orderedStart1.pid, "Start2 after a Stop barrier must create a new generation, not stale-coalesce onto Start1");
  livePid = orderedStart2.pid;
  const runningFinal = (await (await fetch(`http://127.0.0.1:${managerPort}/api/instances`)).json()).instances.find((item) => item.name === "race-demo");
  assert.equal(runningFinal?.server?.running, true, `last Start intent must leave Gateway running: ${JSON.stringify(runningFinal?.server)}`);
  assert.equal(runningFinal?.server?.pid, orderedStart2.pid, "final managed PID must belong to the last Start intent");
  assert.equal(pidAlive(orderedStart1.pid), false, "middle Stop must fully retire Start1's PID before Start2 becomes authoritative");

  const finalStop = await post("/api/instances/race-demo/server/stop");
  assert.equal(finalStop.ok, true, `final cleanup stop failed: ${JSON.stringify(finalStop)}`);
  assert.equal(pidAlive(orderedStart2.pid), false, "final cleanup Stop must retire Start2 PID");
  livePid = null;

  // Config mutation is an intent-generation barrier too. A Restart arriving after
  // config must not coalesce onto the earlier Start even if that Start promise was
  // still in flight when the config request arrived.
  const configBarrierStartPromise = post("/api/instances/race-demo/server/start");
  await sleep(5);
  const configBarrierSavePromise = request("PUT", "/api/instances/race-demo/config", { autoStart: false });
  await sleep(5);
  const configBarrierRestartPromise = post("/api/instances/race-demo/server/restart");
  const [configBarrierStart, configBarrierSave, configBarrierRestart] = await Promise.all([
    configBarrierStartPromise,
    configBarrierSavePromise,
    configBarrierRestartPromise,
  ]);
  assert.equal(configBarrierStart.ok, true, `config-barrier Start failed: ${JSON.stringify(configBarrierStart)}`);
  assert.ok(Number.isInteger(configBarrierStart.pid), "config-barrier Start must return a concrete PID");
  assert.equal(configBarrierSave.ok, true, `config-barrier save failed: ${JSON.stringify(configBarrierSave)}`);
  assert.equal(configBarrierRestart.ok, true, `config-barrier Restart failed: ${JSON.stringify(configBarrierRestart)}`);
  assert.notEqual(configBarrierRestart.coalescedInFlightStart, true, "Restart after config must not stale-coalesce onto the pre-config Start generation");
  assert.equal(configBarrierRestart.previousPid, configBarrierStart.pid, "Restart after config must replace the Start generation that precedes the config barrier");
  assert.notEqual(configBarrierRestart.pid, configBarrierStart.pid, "Restart after config must create a fresh PID generation");
  livePid = configBarrierRestart.pid;

  const stopBeforeRename = await post("/api/instances/race-demo/server/stop");
  assert.equal(stopBeforeRename.ok, true, `pre-rename cleanup stop failed: ${JSON.stringify(stopBeforeRename)}`);
  assert.equal(pidAlive(livePid), false, "pre-rename cleanup must fully stop the Gateway");
  livePid = null;

  // If Start reaches the instance queue first, Rename must wait for it, observe
  // the now-running process, and fail closed instead of moving ownership files.
  const startBeforeRenamePromise = post("/api/instances/race-demo/server/start");
  await sleep(5);
  const renameAfterStartPromise = post("/api/instances/race-demo/rename", { name: "race-renamed" });
  const [startBeforeRename, renameAfterStart] = await Promise.all([startBeforeRenamePromise, renameAfterStartPromise]);
  assert.equal(startBeforeRename.ok, true, `Start before Rename failed: ${JSON.stringify(startBeforeRename)}`);
  assert.equal(renameAfterStart.ok, false, `Rename must fail closed after an earlier Start wins the instance turn: ${JSON.stringify(renameAfterStart)}`);
  livePid = startBeforeRename.pid;
  assert.equal(await fs.stat(instanceDir).then(() => true, () => false), true, "failed Rename must preserve the original instance directory");
  assert.equal(await fs.stat(path.join(instances, "race-renamed")).then(() => true, () => false), false, "failed Rename must not publish the destination directory");

  const stopAfterFailedRename = await post("/api/instances/race-demo/server/stop");
  assert.equal(stopAfterFailedRename.ok, true, `stop after failed Rename failed: ${JSON.stringify(stopAfterFailedRename)}`);
  assert.equal(pidAlive(livePid), false, "stop after failed Rename must retire the active PID");
  livePid = null;

  // Conversely, once Rename owns and publishes the authority move, the old name
  // must become non-startable. Arrival-order reservation itself is proven by the
  // static dual-ticket invariant above; trying to infer HTTP handler arrival from
  // two client promises is scheduler-dependent and produced a false flaky race.
  const renameFirst = await post("/api/instances/race-demo/rename", { name: "race-renamed" });
  assert.equal(renameFirst.ok, true, `Rename transaction failed: ${JSON.stringify(renameFirst)}`);
  assert.equal(renameFirst.renamed, true, "Rename transaction must publish the destination name");
  const staleNameStart = await post("/api/instances/race-demo/server/start");
  assert.notEqual(staleNameStart.ok, true, `Start on old name must fail after Rename authority moved: ${JSON.stringify(staleNameStart)}`);
  assert.equal(await fs.stat(instanceDir).then(() => true, () => false), false, "successful Rename must remove the old catalog path");
  assert.equal(await fs.stat(path.join(instances, "race-renamed")).then(() => true, () => false), true, "successful Rename must publish the new catalog path");

  const renamedStart = await post("/api/instances/race-renamed/server/start");
  assert.equal(renamedStart.ok, true, `renamed instance must remain startable: ${JSON.stringify(renamedStart)}`);
  livePid = renamedStart.pid;
  const renamedStop = await post("/api/instances/race-renamed/server/stop");
  assert.equal(renamedStop.ok, true, `renamed instance cleanup stop failed: ${JSON.stringify(renamedStop)}`);
  assert.equal(pidAlive(livePid), false, "renamed instance cleanup must retire the final PID");
  livePid = null;

  console.log("manager command ordering/coalescing races: ok");
} finally {
  rememberManagedPid(livePid);

  // Reconcile cleanup from independent authorities rather than the happy-path
  // livePid variable. Rename may have moved the instance, and an assertion may
  // have fired before livePid was assigned even though server.pid was already
  // persisted. Stop both possible catalog names while Manager is still alive.
  for (const name of ["race-demo", "race-renamed"]) {
    try { await post(`/api/instances/${name}/server/stop`); } catch {}
  }

  for (const name of ["race-demo", "race-renamed"]) {
    try {
      const raw = await fs.readFile(path.join(instances, name, "server.pid"), "utf8");
      rememberManagedPid(raw.trim());
    } catch {}
  }

  for (const pid of observedManagedPids) {
    if (!pidAlive(pid)) continue;
    await waitFor(() => !pidAlive(pid), 3000, 50);
    if (pidAlive(pid)) killPidTree(pid);
    await waitFor(() => !pidAlive(pid), 3000, 50);
  }

  try { manager.kill(); } catch {}
  await waitFor(() => manager.exitCode !== null || manager.signalCode !== null, 5000, 50);

  const survivors = [...observedManagedPids].filter(pidAlive);
  assert.deepEqual(survivors, [], `race regression cleanup leaked detached Gateway PID(s): ${survivors.join(", ")}`);
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}
