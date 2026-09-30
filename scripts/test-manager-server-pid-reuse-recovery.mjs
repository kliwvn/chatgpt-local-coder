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
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function killPid(pid) {
  if (!pidAlive(pid)) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 10000,
    });
    if (result.status !== 0 && pidAlive(pid)) throw new Error(`failed to hard-kill test PID ${pid}`);
    return;
  }
  process.kill(pid, "SIGKILL");
}

function killTree(pid) {
  if (!pidAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 10000,
    });
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
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

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(100);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

const managerPort = await freePort();
const serverPort = await freePort();
const adminPort = await freePort();
const tunnelHealthPort = await freePort();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clc-pid-reuse-recovery-"));
const instancesDir = path.join(tempRoot, "instances");
const stateDir = path.join(tempRoot, "state");
const instanceDir = path.join(instancesDir, "pid-reuse-demo");
await fs.mkdir(instanceDir, { recursive: true });
await fs.mkdir(stateDir, { recursive: true });

await fs.writeFile(path.join(instanceDir, ".env"), [
  `PORT=${serverPort}`,
  `ADMIN_PORT=${adminPort}`,
  `WORKSPACE_PATH=${process.cwd()}`,
  "OPENAI_TUNNEL_ID=",
  "OPENAI_TUNNEL_API_KEY=",
  `OPENAI_TUNNEL_HEALTH_PORT=${tunnelHealthPort}`,
  "CHATGPT_TOOL_PROFILE=slim",
  "FULL_DISK_ACCESS=true",
  "SHELL_TIMEOUT=120",
  "MCP_SESSION_TTL_MS=120000",
  "MCP_SESSION_CLEANUP_MS=15000",
  "MCP_SESSION_DELETE_GRACE_MS=45000",
  "MCP_MAX_SESSIONS=64",
  "",
].join("\n"));
await fs.writeFile(
  path.join(instanceDir, "config.json"),
  JSON.stringify({ healthPort: tunnelHealthPort, autoStart: false }),
  "utf8"
);

const manager = spawn(process.execPath, ["manager/server.mjs", "--no-open"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MANAGER_PORT: String(managerPort),
    MANAGER_INSTANCES_DIR: instancesDir,
    MANAGER_STATE_DIR: stateDir,
    MANAGER_SERVER_RECOVERY_INTERVAL_MS: "250",
    MANAGER_STALE_CONFIG_RECONCILE_INTERVAL_MS: "3600000",
    MCP_ENV_FILE: path.join(tempRoot, "legacy-do-not-use.env"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let managerOutput = "";
manager.stdout.on("data", (chunk) => { managerOutput += chunk; });
manager.stderr.on("data", (chunk) => { managerOutput += chunk; });

async function api(route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${managerPort}${route}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch {
    throw new Error(`${route} HTTP ${response.status}: ${text}`);
  }
  return { status: response.status, body };
}

const post = (route) => api(route, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});

let serverPid = null;
let unrelatedPid = null;
try {
  await waitUntil(async () => (await api("/api/health")).body?.ok === true, 15000, "manager health");

  const started = (await post("/api/instances/pid-reuse-demo/server/start")).body;
  assert.equal(started.ok, true, `initial managed start failed: ${JSON.stringify(started)}\n${managerOutput}`);
  serverPid = started.pid;
  assert.ok(Number.isInteger(serverPid) && serverPid > 0);

  const configPath = path.join(instanceDir, "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.autoStart = true;
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");

  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  unrelatedPid = unrelated.pid;
  assert.ok(Number.isInteger(unrelatedPid) && unrelatedPid > 0);

  // Simulate stale/reused PID authority before the real child disappears. The
  // child-exit observer must not trust or kill this unrelated live PID, while the
  // periodic identity-aware fallback must still restore the missing MCP Server.
  await fs.writeFile(path.join(instanceDir, "server.pid"), `${unrelatedPid}\n`, "utf8");
  killPid(serverPid);
  await waitUntil(() => !pidAlive(serverPid), 5000, "managed server hard exit");

  const recoveredPid = await waitUntil(async () => {
    const raw = await fs.readFile(path.join(instanceDir, "server.pid"), "utf8").catch(() => "");
    const pid = Number(raw.trim());
    return Number.isInteger(pid)
      && pid > 0
      && pid !== serverPid
      && pid !== unrelatedPid
      && pidAlive(pid)
      ? pid
      : null;
  }, 20000, "identity-aware polling recovery");

  const recovered = await waitUntil(async () => {
    const item = (await api("/api/instances")).body.instances.find((entry) => entry.name === "pid-reuse-demo");
    return item?.server?.running && item.server.pid === recoveredPid ? item : null;
  }, 10000, "recovered server health");
  assert.equal(recovered.server.owned, true, "poll recovery must restore exact Manager ownership");
  assert.equal(pidAlive(unrelatedPid), true, "stale/reused live PID must never be terminated");

  const lifecycleRaw = await fs.readFile(path.join(instanceDir, "server-lifecycle.jsonl"), "utf8");
  const events = lifecycleRaw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const exitEvent = events.find((entry) => entry.event === "server_exit" && entry.pid === serverPid);
  assert.ok(exitEvent, "original managed child exit must be journaled");
  assert.equal(exitEvent.expected, true, "stale ledger must classify old observed generation as superseded");
  assert.equal(exitEvent.expected_reason, "superseded_generation");
  assert.equal(exitEvent.recovery_triggered, false, "superseded exit observer must not race the identity-aware polling fallback");

  serverPid = recoveredPid;
  console.log("PASS: PID-reuse/stale-ledger fallback recovers MCP without terminating unrelated process");
} finally {
  if (serverPid && pidAlive(serverPid)) killPid(serverPid);
  if (unrelatedPid && pidAlive(unrelatedPid)) killPid(unrelatedPid);
  killTree(manager.pid);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
