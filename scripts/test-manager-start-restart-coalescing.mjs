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

function delayedBodyRequest(method, route, body = {}, delayMs = 750) {
  const payload = JSON.stringify(body);
  const firstChunk = payload.slice(0, 1) || "{";
  const remainder = payload.slice(1) || "}";
  let markFirstChunkSent;
  const firstChunkSent = new Promise((resolve) => { markFirstChunkSent = resolve; });
  const result = new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: managerPort,
      path: route,
      method,
      // Pin Content-Length so every method (notably DELETE on Node/Windows) uses
      // valid deterministic framing while we intentionally split the body across
      // time. Relying on ClientRequest's implicit chunked-encoding decision made
      // the fixture itself produce parser-level 400 responses before Manager code.
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          if (!raw.trim()) {
            throw new Error(
              `empty Manager response for delayed ${method} ${route}; status=${res.statusCode}; `
              + `headers=${JSON.stringify(res.headers)}; managerOutput=${JSON.stringify(managerOutput.slice(-6000))}`
            );
          }
          const parsed = JSON.parse(raw);
          rememberManagedPid(parsed?.pid);
          rememberManagedPid(parsed?.previousPid);
          resolve(parsed);
        } catch (err) {
          if (raw.trim()) {
            err.message = `${err.message}; delayed ${method} ${route}; status=${res.statusCode}; raw=${JSON.stringify(raw.slice(-4000))}; managerOutput=${JSON.stringify(managerOutput.slice(-6000))}`;
          }
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.on("socket", (socket) => {
      const sendPartialBody = () => {
        req.flushHeaders();
        req.write(firstChunk);
        markFirstChunkSent();
        setTimeout(() => req.end(remainder), delayMs);
      };
      if (socket.connecting) socket.once("connect", sendPartialBody);
      else sendPartialBody();
    });
  });
  return { firstChunkSent, result };
}

function delayedBodyPost(route, delayMs = 750, body = {}) {
  return delayedBodyRequest("POST", route, body, delayMs);
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
  let startSettled = false;
  const startPromise = post("/api/instances/race-demo/server/start").finally(() => {
    startSettled = true;
  });
  // Do not use an arbitrary client-side sleep as an HTTP ordering contract, and
  // do not use the process-spawn marker either: cold dependency/build preflight
  // can legitimately precede spawn for tens of seconds under Windows/AV load.
  // The manager-command marker is emitted immediately after the Start intent and
  // its shared command promise are registered, which is the exact ordering fact
  // this overlap fixture needs before sending the later Restart.
  const startRegistered = await waitFor(
    () => managerOutput.includes("[manager-command] instance=race-demo intent=server:start") ? true : null,
    30000,
    5
  );
  assert.equal(startRegistered, true, `Start command was never registered by Manager: ${managerOutput}`);
  assert.equal(startSettled, false, "Start settled before overlap could be exercised; fixture no longer proves in-flight coalescing");
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

  // Mixed legacy/direct aliases must share the SAME HTTP-admission order before
  // body parsing. Hold the earlier Start body deliberately incomplete: without an
  // admission reservation the later Stop would register first, then the delayed
  // Start would run last and incorrectly leave Gateway running.
  const delayedLegacyStart = delayedBodyPost("/api/server/start");
  await delayedLegacyStart.firstChunkSent;
  await sleep(100);
  const directStopAfterLegacyStartPromise = post("/api/instances/race-demo/server/stop");
  const [legacyStart, directStopAfterLegacyStart] = await Promise.all([
    delayedLegacyStart.result,
    directStopAfterLegacyStartPromise,
  ]);
  assert.equal(legacyStart.ok, true, `delayed legacy Start failed: ${JSON.stringify(legacyStart)}`);
  assert.equal(directStopAfterLegacyStart.ok, true, `direct Stop after delayed legacy Start failed: ${JSON.stringify(directStopAfterLegacyStart)}`);
  assert.ok(Number.isInteger(legacyStart.pid), "delayed legacy Start must create a concrete PID");
  assert.equal(pidAlive(legacyStart.pid), false, "later direct Stop must retire the earlier legacy Start PID");
  const mixedLegacyFirstFinal = (await (await fetch(`http://127.0.0.1:${managerPort}/api/instances`)).json()).instances.find((item) => item.name === "race-demo");
  assert.equal(mixedLegacyFirstFinal?.server?.running, false, "legacy->direct mixed ordering must leave the last Stop intent authoritative");

  const delayedDirectStart = delayedBodyPost("/api/instances/race-demo/server/start");
  await delayedDirectStart.firstChunkSent;
  await sleep(100);
  const legacyStopAfterDirectStartPromise = post("/api/server/stop");
  const [directStart, legacyStopAfterDirectStart] = await Promise.all([
    delayedDirectStart.result,
    legacyStopAfterDirectStartPromise,
  ]);
  assert.equal(directStart.ok, true, `delayed direct Start failed: ${JSON.stringify(directStart)}`);
  assert.equal(legacyStopAfterDirectStart.ok, true, `legacy Stop after delayed direct Start failed: ${JSON.stringify(legacyStopAfterDirectStart)}`);
  assert.ok(Number.isInteger(directStart.pid), "delayed direct Start must create a concrete PID");
  assert.equal(pidAlive(directStart.pid), false, "later legacy Stop must retire the earlier direct Start PID");
  const mixedDirectFirstFinal = (await (await fetch(`http://127.0.0.1:${managerPort}/api/instances`)).json()).instances.find((item) => item.name === "race-demo");
  assert.equal(mixedDirectFirstFinal?.server?.running, false, "direct->legacy mixed ordering must leave the last Stop intent authoritative");

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

  // Conversely, once Rename has registered its catalog mutation, a later Start
  // against the old name must fail retryably BEFORE the rename settles. Holding
  // the Rename body open first proves request arrival order, while the tombstone
  // prevents the later Start from being queued behind Rename and resurrecting the
  // recycled old-name authority after publication.
  const delayedRename = delayedBodyPost("/api/instances/race-demo/rename", 750, { name: "race-renamed" });
  await delayedRename.firstChunkSent;
  await sleep(100);
  const staleNameStartDuringRenamePromise = post("/api/instances/race-demo/server/start");
  const [renameFirst, staleNameStartDuringRename] = await Promise.all([
    delayedRename.result,
    staleNameStartDuringRenamePromise,
  ]);
  assert.equal(renameFirst.ok, true, `Rename transaction failed: ${JSON.stringify(renameFirst)}`);
  assert.equal(renameFirst.renamed, true, "Rename transaction must publish the destination name");
  assert.equal(staleNameStartDuringRename.ok, false, `Start admitted after Rename registration must fail closed: ${JSON.stringify(staleNameStartDuringRename)}`);
  assert.equal(staleNameStartDuringRename.retryable, true, "stale Start during Rename must be explicitly retryable against the current catalog");
  assert.equal(staleNameStartDuringRename.staleInstanceAuthority, true, "stale Start during Rename must identify catalog authority invalidation");
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

  // Delete is the stronger terminal catalog barrier: a later Start that already
  // passed HTTP admission must never land on the same name after Recycle Bin
  // removal and recreate its directory/default config. Hold Delete's body open to
  // make the arrival order deterministic, then issue the stale Start behind it.
  const renamedDir = path.join(instances, "race-renamed");
  const delayedDelete = delayedBodyRequest("DELETE", "/api/instances/race-renamed", {}, 750);
  await delayedDelete.firstChunkSent;
  await sleep(100);
  const staleStartDuringDeletePromise = post("/api/instances/race-renamed/server/start");
  const [deleted, staleStartDuringDelete] = await Promise.all([
    delayedDelete.result,
    staleStartDuringDeletePromise,
  ]);
  assert.equal(deleted.ok, true, `Delete transaction failed: ${JSON.stringify(deleted)}`);
  assert.equal(staleStartDuringDelete.ok, false, `Start admitted after Delete registration must fail closed: ${JSON.stringify(staleStartDuringDelete)}`);
  assert.equal(staleStartDuringDelete.retryable, true, "stale Start during Delete must be explicitly retryable against the current catalog");
  assert.equal(staleStartDuringDelete.staleInstanceAuthority, true, "stale Start during Delete must identify catalog authority invalidation");
  assert.equal(await fs.stat(renamedDir).then(() => true, () => false), false, "Delete followed by stale Start must not recreate the deleted instance directory");
  const catalogAfterDelete = await (await fetch(`http://127.0.0.1:${managerPort}/api/instances`)).json();
  assert.equal(catalogAfterDelete.instances.some((item) => item.name === "race-renamed"), false, "deleted instance name must remain absent after stale lifecycle rejection");

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
