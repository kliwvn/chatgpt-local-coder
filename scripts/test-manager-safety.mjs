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
async function listen(server, port) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
}

const managerPort = await freePort();
const fakeServerPort = await freePort();
const fakeTunnelPort = await freePort();
const createConflictPort = await freePort();
const adminPort = await freePort();
const restartServerPort = await freePort();
const restartAdminPort = await freePort();
const restartHealthPort = await freePort();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-manager-safety-"));
const instances = path.join(root, "instances");
const stateDir = path.join(root, "state");
const demo = path.join(instances, "demo");
const restartDemo = path.join(instances, "restart-demo");
await fs.mkdir(demo, { recursive: true });
await fs.mkdir(restartDemo, { recursive: true });

const fakeServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", name: "codex-mcp-server" })); // missing expected workspace: must not be trusted
    return;
  }
  res.end("fake");
});
const fakeTunnel = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><title>not tunnel-client</title></html>");
});
const createConflict = http.createServer((_req, res) => res.end("occupied"));
await listen(fakeServer, fakeServerPort);
await listen(fakeTunnel, fakeTunnelPort);
await listen(createConflict, createConflictPort);

const tunnelSecret = "manager-safety-tunnel-secret-1234";
const adminSecret = "manager-safety-admin-secret-5678";
await fs.writeFile(path.join(demo, ".env"), [
  `PORT=${fakeServerPort}`,
  `ADMIN_PORT=${adminPort}`,
  `WORKSPACE_PATH=${process.cwd()}`,
  "OPENAI_TUNNEL_ID=tunnel_0123456789abcdef0123456789abcdef",
  `OPENAI_TUNNEL_API_KEY=${tunnelSecret}`,
  `OPENAI_TUNNEL_HEALTH_PORT=${fakeTunnelPort}`,
  `ADMIN_TOKEN=${adminSecret}`,
  "CHATGPT_TOOL_PROFILE=slim",
  "FULL_DISK_ACCESS=false",
  "MCP_SESSION_RECOVERY=true",
  "MCP_SESSION_TTL_MS=120000",
  "MCP_SESSION_CLEANUP_MS=15000",
  "MCP_SESSION_DELETE_GRACE_MS=45000",
  "MCP_MAX_SESSIONS=64",
  "",
].join("\n"));
await fs.writeFile(path.join(demo, "config.json"), JSON.stringify({ connectorName: "demo", healthPort: fakeTunnelPort, autoStart: false }));
await fs.writeFile(path.join(demo, "server.log"), "line-1\n" + "x".repeat(5000) + "\nline-last\n");
await fs.writeFile(path.join(restartDemo, ".env"), [
  `PORT=${restartServerPort}`,
  `ADMIN_PORT=${restartAdminPort}`,
  `WORKSPACE_PATH=${process.cwd()}`,
  "OPENAI_TUNNEL_ID=",
  "OPENAI_TUNNEL_API_KEY=",
  `OPENAI_TUNNEL_HEALTH_PORT=${restartHealthPort}`,
  "CHATGPT_TOOL_PROFILE=slim",
  "FULL_DISK_ACCESS=false",
  "SHELL_TIMEOUT=120",
  "MCP_SESSION_RECOVERY=true",
  "MCP_SESSION_TTL_MS=120000",
  "MCP_SESSION_CLEANUP_MS=15000",
  "MCP_SESSION_DELETE_GRACE_MS=45000",
  "MCP_MAX_SESSIONS=64",
  "",
].join("\n"));
await fs.writeFile(path.join(restartDemo, "config.json"), JSON.stringify({ connectorName: "restart-demo", healthPort: restartHealthPort, autoStart: false }));

const manager = spawn(process.execPath, ["manager/server.mjs", "--no-open"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MANAGER_PORT: String(managerPort),
    MANAGER_INSTANCES_DIR: instances,
    MANAGER_STATE_DIR: stateDir,
    MCP_ENV_FILE: path.join(root, "legacy-do-not-use.env"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let managerOutput = "";
let managedRestartPid = null;
manager.stdout.on("data", (d) => (managerOutput += d));
manager.stderr.on("data", (d) => (managerOutput += d));

async function api(route, options = {}) {
  const res = await fetch(`http://127.0.0.1:${managerPort}${route}`, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${route} HTTP ${res.status}: ${text}`); }
  return { status: res.status, body };
}
const post = (route, body = {}) => api(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const put = (route, body = {}) => api(route, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

try {
  let listing;
  for (let i = 0; i < 150; i++) {
    try { listing = (await api("/api/instances")).body; break; } catch {}
    await sleep(30);
  }
  if (!listing) throw new Error(`manager did not start: ${managerOutput}`);
  const item = listing.instances.find((x) => x.name === "demo");
  assert.ok(item);
  assert.equal(item.server.running, false);
  assert.equal(item.server.portOccupied, true, "fake MCP-like health must not be trusted as this workspace");
  assert.equal(item.tunnel.running, false);
  assert.equal(item.tunnel.portOccupied, true, "generic HTML must not be trusted as tunnel-client");

  const envResponse = (await api("/api/instances/demo/env")).body;
  const serializedEnv = JSON.stringify(envResponse);
  assert.equal(serializedEnv.includes(tunnelSecret), false);
  assert.equal(serializedEnv.includes(adminSecret), false);
  assert.deepEqual(envResponse.values.OPENAI_TUNNEL_API_KEY, { set: true, last4: "1234" });
  assert.equal(envResponse.values.ADMIN_TOKEN, "********");

  await Promise.all(Array.from({ length: 20 }, (_, i) => put("/api/instances/demo/env", { values: { [`TEST_KEY_${i}`]: `v${i}` } })));
  const diskEnv = await fs.readFile(path.join(demo, ".env"), "utf8");
  for (let i = 0; i < 20; i++) assert.match(diskEnv, new RegExp(`TEST_KEY_${i}=v${i}`));
  assert.match(diskEnv, new RegExp(`OPENAI_TUNNEL_API_KEY=${tunnelSecret}`));
  assert.match(diskEnv, new RegExp(`ADMIN_TOKEN=${adminSecret}`));

  const profileSecret = "profile-secret-must-not-persist";
  await Promise.all(Array.from({ length: 30 }, (_, i) => post("/api/profiles", { name: `p${i}`, values: { WORKSPACE_PATH: `D:/p${i}`, OPENAI_TUNNEL_API_KEY: profileSecret, ADMIN_TOKEN: profileSecret } })));
  const profiles = (await api("/api/profiles")).body.profiles;
  assert.equal(Object.keys(profiles).length, 30);
  assert.equal(JSON.stringify(profiles).includes(profileSecret), false);
  const profileDisk = await fs.readFile(path.join(stateDir, "profiles.json"), "utf8");
  assert.equal(profileDisk.includes(profileSecret), false);

  const serverStart = (await post("/api/instances/demo/server/start")).body;
  assert.equal(serverStart.ok, false);
  assert.match(serverStart.error, /chiếm|occupied|process/i);
  const tunnelStart = (await post("/api/instances/demo/tunnel/start")).body;
  assert.equal(tunnelStart.ok, false);
  assert.match(tunnelStart.error, /chiếm|occupied|process/i);
  assert.equal((await post("/api/instances/demo/server/stop")).body.alreadyStopped, true);
  assert.equal((await post("/api/instances/demo/tunnel/stop")).body.alreadyStopped, true);
  assert.equal(fakeServer.listening, true);
  assert.equal(fakeTunnel.listening, true);

  const managerHtml = await fs.readFile(path.join(process.cwd(), "manager", "index.html"), "utf8");
  const managerApp = await fs.readFile(path.join(process.cwd(), "manager", "app.js"), "utf8");
  const managerCss = await fs.readFile(path.join(process.cwd(), "manager", "styles.css"), "utf8");
  const managerServerSource = await fs.readFile(path.join(process.cwd(), "manager", "server.mjs"), "utf8");
  assert.match(managerHtml, /id="btn-server-restart"[^>]*>[^<]*Khởi động lại Gateway/);
  assert.match(managerApp, /\/server\/restart/);
  assert.match(managerApp, /splitExtraWorkspacePaths/);
  assert.match(managerApp, /\.split\(";"\)/);
  assert.match(managerApp, /inst-extra-path/);
  assert.doesNotMatch(managerApp, /shortPath\(extra\)/, "sidebar must not collapse the whole EXTRA_WORKSPACE_PATHS string to one short path");
  assert.match(managerApp, /Đang chạy/);
  assert.doesNotMatch(managerApp, /\?ang ch\?y|Xung \?\?t c\?ng|Ch\?a ch\?y/, "manager status strings must stay valid UTF-8 Vietnamese");
  assert.match(managerCss, /\.inst-extra-path\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*normal/s);
  assert.match(managerCss, /\.inst-ws\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*normal/s);
  assert.match(
    managerServerSource,
    /if \(before\.running && before\.pid && started\.pid === before\.pid\) \{\s*return \{\s*\.\.\.started,\s*ok: false,\s*restarted: false,/,
    "same-PID restart guard must override started.ok instead of being overwritten by object spread"
  );

  const managedStart = (await post("/api/instances/restart-demo/server/start")).body;
  assert.equal(managedStart.ok, true, `managed server start failed: ${JSON.stringify(managedStart)}`);
  assert.ok(Number.isInteger(managedStart.pid));
  managedRestartPid = managedStart.pid;
  const managedRestart = (await post("/api/instances/restart-demo/server/restart")).body;
  assert.equal(managedRestart.ok, true, `managed restart failed: ${JSON.stringify(managedRestart)}`);
  assert.equal(managedRestart.restarted, true);
  assert.equal(managedRestart.previousPid, managedStart.pid);
  assert.ok(Number.isInteger(managedRestart.pid) && managedRestart.pid !== managedStart.pid, "restart must replace the gateway PID");
  managedRestartPid = managedRestart.pid;
  const restartListing = (await api("/api/instances")).body.instances.find((x) => x.name === "restart-demo");
  assert.equal(restartListing.server.running, true);
  assert.equal(restartListing.server.pid, managedRestart.pid);
  const managedStop = (await post("/api/instances/restart-demo/server/stop")).body;
  assert.equal(managedStop.ok, true, `managed server stop failed: ${JSON.stringify(managedStop)}`);
  managedRestartPid = null;

  const occupiedCreate = (await post("/api/instances", { name: "occupied", port: createConflictPort, workspacePath: process.cwd() })).body;
  assert.equal(occupiedCreate.ok, false);
  const badPort = (await post("/api/instances", { name: "bad-port", port: `${createConflictPort}junk`, workspacePath: process.cwd() })).body;
  assert.equal(badPort.ok, false, "port parsing must reject numeric prefixes with junk suffixes");

  const log1 = (await api("/api/instances/demo/log?kind=server&max=300000")).body;
  assert.ok(log1.log.includes("line-last"));
  const log2 = (await api(`/api/instances/demo/log?kind=server&max=300000&if_size=${log1.size}&if_mtime=${log1.mtime}`)).body;
  assert.equal(log2.unchanged, true);
  assert.equal(log2.log, "");

  console.log("manager-safety: ok (identity, env 20/20, profiles 30/30, secret-safe, restart PID swap, conditional log)");
} finally {
  if (managedRestartPid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(managedRestartPid), "/T", "/F"], { windowsHide: true });
    else {
      try { process.kill(managedRestartPid, "SIGTERM"); } catch {}
    }
  }
  manager.kill("SIGTERM");
  await sleep(300);
  if (manager.exitCode == null && process.platform === "win32") spawnSync("taskkill", ["/PID", String(manager.pid), "/T", "/F"], { windowsHide: true });
  for (const server of [fakeServer, fakeTunnel, createConflict]) await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
