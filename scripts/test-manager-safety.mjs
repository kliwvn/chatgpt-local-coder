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
const legacyNoIdPort = await freePort();
const legacyNoIdAdminPort = await freePort();
const legacyNoIdHealthPort = await freePort();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-manager-safety-"));
const instances = path.join(root, "instances");
const stateDir = path.join(root, "state");
const demo = path.join(instances, "demo");
const restartDemo = path.join(instances, "restart-demo");
const legacyNoId = path.join(instances, "legacy-no-id");
await fs.mkdir(demo, { recursive: true });
await fs.mkdir(restartDemo, { recursive: true });
await fs.mkdir(legacyNoId, { recursive: true });

const fakeServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      name: "codex-mcp-server",
      instance_id: "different-managed-instance",
      workspace: process.cwd(),
    })); // matching workspace but wrong managed identity: must not be trusted
    return;
  }
  res.end("fake");
});
const legacyNoIdServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      name: "codex-mcp-server",
      workspace: process.cwd(),
    })); // legacy-shaped health without instance_id and without Manager PID ledger
    return;
  }
  res.end("legacy-no-id");
});
const fakeTunnel = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><title>not tunnel-client</title></html>");
});
const createConflict = http.createServer((_req, res) => res.end("occupied"));
const fakeAdmin = http.createServer((req, res) => {
  if (req.headers["x-admin-token"] !== adminSecret || req.headers.authorization) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "bad manager proxy auth" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, proxied: true }));
});
await listen(fakeServer, fakeServerPort);
await listen(legacyNoIdServer, legacyNoIdPort);
await listen(fakeTunnel, fakeTunnelPort);
await listen(createConflict, createConflictPort);

const tunnelSecret = "manager-safety-tunnel-secret-1234";
const adminSecret = "manager-safety-admin-secret-5678";
await listen(fakeAdmin, adminPort);
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
await fs.writeFile(path.join(demo, "config.json"), JSON.stringify({ connectorName: "legacy-must-be-removed", healthPort: fakeTunnelPort, autoStart: false }));
await fs.writeFile(path.join(legacyNoId, ".env"), [
  `PORT=${legacyNoIdPort}`,
  `ADMIN_PORT=${legacyNoIdAdminPort}`,
  `WORKSPACE_PATH=${process.cwd()}`,
  "OPENAI_TUNNEL_ID=",
  "OPENAI_TUNNEL_API_KEY=",
  `OPENAI_TUNNEL_HEALTH_PORT=${legacyNoIdHealthPort}`,
  "CHATGPT_TOOL_PROFILE=slim",
  "FULL_DISK_ACCESS=false",
  "",
].join("\n"));
await fs.writeFile(path.join(legacyNoId, "config.json"), JSON.stringify({ healthPort: legacyNoIdHealthPort, autoStart: false }));
const historicalLogSecret = "historical-manager-log-secret-123456";
await fs.writeFile(
  path.join(demo, "server.log"),
  "line-1\n" + "x".repeat(5000) + `\nAuthorization: Bearer ${historicalLogSecret}\nOPENAI_TUNNEL_API_KEY=${historicalLogSecret}\nline-last\n`
);
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
await fs.writeFile(path.join(restartDemo, "config.json"), JSON.stringify({ healthPort: restartHealthPort, autoStart: false }));
const restartHistoricalSecret = "restart-historical-secret-778899";
await fs.writeFile(path.join(restartDemo, "server.log"), `x.api.key=${restartHistoricalSecret}\nplain=keep-before-start\n`, "utf8");

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
  let item;
  for (let i = 0; i < 150; i++) {
    try {
      listing = (await api("/api/instances")).body;
      item = listing.instances.find((x) => x.name === "demo");
      // The first probe can race the fake listener accepting its first socket on
      // busy Windows CI. Require the full identity-conflict state before leaving
      // readiness, rather than treating the first HTTP response as readiness.
      if (item?.server?.portOccupied && item?.tunnel?.portOccupied) break;
    } catch {}
    await sleep(30);
  }
  if (!listing) throw new Error(`manager did not start: ${managerOutput}`);
  const managerHealth = (await api("/api/health")).body;
  assert.equal(managerHealth.ok, true);
  assert.equal(managerHealth.artifactDrift, false, "fresh Manager process must not report its own runtime as stale");
  assert.ok(Number.isInteger(managerHealth.pid) && managerHealth.pid > 0);
  assert.ok(item);
  assert.equal(item.server.running, false);
  assert.equal(item.server.portOccupied, true, "matching workspace with wrong managed instance_id must not be trusted as this instance");
  assert.equal(item.tunnel.running, false);
  assert.equal(item.tunnel.portOccupied, true, "generic HTML must not be trusted as tunnel-client");

  const legacyNoIdItem = (await api("/api/instances")).body.instances.find((x) => x.name === "legacy-no-id");
  assert.ok(legacyNoIdItem, "legacy-no-id fixture instance must be listed");
  assert.equal(legacyNoIdItem.server.running, false, "legacy-shaped health without a saved PID ledger must not be adopted as owned");
  assert.equal(legacyNoIdItem.server.portOccupied, true, "legacy-shaped health without instance_id/PID proof must be treated as an unowned port occupant");
  const legacyNoIdStop = (await post("/api/instances/legacy-no-id/server/stop")).body;
  assert.equal(legacyNoIdStop.alreadyStopped, true, "Manager must refuse to stop an unowned legacy-shaped listener");
  assert.equal(legacyNoIdServer.listening, true, "unowned legacy-shaped listener must remain alive after Manager stop request");

  const envResponse = (await api("/api/instances/demo/env")).body;
  const serializedEnv = JSON.stringify(envResponse);
  assert.equal(serializedEnv.includes(tunnelSecret), false);
  assert.equal(serializedEnv.includes(adminSecret), false);
  assert.deepEqual(envResponse.values.OPENAI_TUNNEL_API_KEY, { set: true, last4: "1234" });
  assert.equal(envResponse.values.ADMIN_TOKEN, "********");
  assert.equal(Object.prototype.hasOwnProperty.call(envResponse.values, "MCP_SESSION_RECOVERY"), false, "obsolete recovery switch must not be exposed by Manager env API");

  const proxiedAdmin = await fetch(`http://127.0.0.1:${managerPort}/admin/health?instance=demo`, {
    headers: { Authorization: "Bearer stale-browser-token" },
  });
  const proxiedAdminBody = await proxiedAdmin.json();
  assert.equal(proxiedAdmin.status, 200, "Manager proxy must inject the instance ADMIN_TOKEN server-side");
  assert.equal(proxiedAdminBody.proxied, true);
  assert.equal(JSON.stringify(proxiedAdminBody).includes(adminSecret), false, "Manager proxy must not echo ADMIN_TOKEN to browser");

  await Promise.all(Array.from({ length: 20 }, (_, i) => put("/api/instances/demo/env", { values: { [`TEST_KEY_${i}`]: `v${i}` } })));
  const diskEnv = await fs.readFile(path.join(demo, ".env"), "utf8");
  for (let i = 0; i < 20; i++) assert.match(diskEnv, new RegExp(`TEST_KEY_${i}=v${i}`));
  assert.match(diskEnv, new RegExp(`OPENAI_TUNNEL_API_KEY=${tunnelSecret}`));
  assert.match(diskEnv, new RegExp(`ADMIN_TOKEN=${adminSecret}`));
  assert.doesNotMatch(diskEnv, /^MCP_SESSION_RECOVERY=/m, "saving any managed env must scrub the obsolete recovery switch");

  const profileSecret = "profile-secret-must-not-persist";
  await Promise.all(Array.from({ length: 30 }, (_, i) => post("/api/profiles", { name: `p${i}`, values: { WORKSPACE_PATH: `D:/p${i}`, MCP_SESSION_RECOVERY: "false", OPENAI_TUNNEL_API_KEY: profileSecret, ADMIN_TOKEN: profileSecret, AUTHORIZATION: profileSecret, "api-key": profileSecret } })));
  const profiles = (await api("/api/profiles")).body.profiles;
  assert.equal(Object.keys(profiles).length, 30);
  assert.equal(JSON.stringify(profiles).includes(profileSecret), false);
  const profileDisk = await fs.readFile(path.join(stateDir, "profiles.json"), "utf8");
  assert.equal(profileDisk.includes(profileSecret), false);
  assert.doesNotMatch(profileDisk, /MCP_SESSION_RECOVERY/, "profiles must not persist the obsolete recovery switch");

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
  const managerRuntimeStateSource = await fs.readFile(path.join(process.cwd(), "manager", "runtime-state.mjs"), "utf8");
  const adminUiSource = await fs.readFile(path.join(process.cwd(), "public", "ui", "app.js"), "utf8");
  const envExampleSource = await fs.readFile(path.join(process.cwd(), ".env.example"), "utf8");
  const runtimeEntrySource = await fs.readFile(path.join(process.cwd(), "src", "index.ts"), "utf8");
  assert.match(managerHtml, /id="btn-server-restart"[^>]*class="[^"]*btn-green[^"]*"[^>]*>[^<]*Khởi động lại Local Coder Server/, "Local Coder Server restart must use the same green emphasis as Connector");
  assert.match(managerHtml, /id="btn-connector"[^>]*class="[^"]*btn-green[^"]*"/, "Connector button must retain the shared green emphasis");
  assert.match(managerHtml, /id="foot-admin"[^>]*class="[^"]*btn-primary[^"]*"/, "Admin UI link must be visually emphasized");
  assert.doesNotMatch(managerHtml, /Focus Server|Focus Tunnel/, "user-facing Manager UI must not expose the ambiguous Focus label");
  assert.match(managerHtml, /id="f-admin-port"/);
  assert.match(managerHtml, /id="add-admin-port"/);
  assert.doesNotMatch(managerHtml, /f-connector|Tên Connector/);
  assert.doesNotMatch(managerApp, /f-connector|MCP_CONNECTOR_NAME/);
  assert.doesNotMatch(managerHtml, /f-recovery|MCP_SESSION_RECOVERY/);
  assert.doesNotMatch(managerApp, /f-recovery|MCP_SESSION_RECOVERY/);
  assert.doesNotMatch(adminUiSource.match(/const ENV_KEYS = \[([\s\S]*?)\];/)?.[1] || "", /MCP_SESSION_RECOVERY/);
  assert.doesNotMatch(envExampleSource, /^MCP_SESSION_RECOVERY=/m);
  assert.doesNotMatch(managerHtml, /f-auto-approve|CHATGPT_AUTO_APPROVE/);
  assert.doesNotMatch(managerApp, /f-auto-approve|CHATGPT_AUTO_APPROVE/);
  assert.doesNotMatch(adminUiSource.match(/const ENV_KEYS = \[([\s\S]*?)\];/)?.[1] || "", /CHATGPT_AUTO_APPROVE/);
  assert.doesNotMatch(envExampleSource, /^CHATGPT_AUTO_APPROVE=/m);
  assert.doesNotMatch(managerHtml, /f-session-cleanup|MCP_SESSION_CLEANUP_MS/, "cleanup cadence is an internal runtime knob and must not clutter Manager UI");
  assert.doesNotMatch(managerApp, /f-session-cleanup/, "Manager structured form must not bind MCP_SESSION_CLEANUP_MS");
  assert.doesNotMatch(adminUiSource.match(/const ENV_KEYS = \[([\s\S]*?)\];/)?.[1] || "", /MCP_SESSION_CLEANUP_MS/, "Admin structured settings must keep internal cleanup cadence hidden");
  assert.doesNotMatch(managerHtml, /f-session-grace|MCP_SESSION_DELETE_GRACE_MS/, "DELETE drain grace is an internal lifecycle knob and must not clutter Manager UI");
  assert.doesNotMatch(managerApp, /f-session-grace/, "Manager structured form must not bind MCP_SESSION_DELETE_GRACE_MS");
  assert.doesNotMatch(adminUiSource.match(/const ENV_KEYS = \[([\s\S]*?)\];/)?.[1] || "", /MCP_SESSION_DELETE_GRACE_MS/, "Admin structured settings must keep internal DELETE drain grace hidden");
  const extraWorkspacePos = managerHtml.indexOf('for="f-extra-ws"');
  const fullDiskPos = managerHtml.indexOf('for="f-full-disk"');
  const memoryBytesPos = managerHtml.indexOf('for="f-mem-bytes"');
  const memoryLinesPos = managerHtml.indexOf('for="f-mem-lines"');
  assert.ok(
    extraWorkspacePos >= 0 && fullDiskPos > extraWorkspacePos && memoryBytesPos > fullDiskPos && memoryLinesPos > memoryBytesPos,
    "EXTRA_WORKSPACE_PATHS must sit immediately before FULL_DISK_ACCESS, then PROJECT_MEMORY_MAX_BYTES/LINES",
  );
  assert.doesNotMatch(runtimeEntrySource, /MCP_SESSION_RECOVERY|SESSION_RECOVERY/, "runtime recovery must be invariant, not controlled by a hidden env switch");
  assert.doesNotMatch(JSON.stringify(item.config), /connectorName/);
  assert.doesNotMatch(await fs.readFile(path.join(demo, "config.json"), "utf8"), /connectorName/, "startup must scrub obsolete connectorName from existing instance config");
  assert.match(managerApp, /"f-admin-port":\s*"ADMIN_PORT"/);
  assert.match(managerApp, /adminPort:\s*parsedAdminPort/);
  assert.match(managerApp, /const adminPort = i\.env\.ADMIN_PORT \|\| "—";/, "workspace cards must surface ADMIN_PORT");
  assert.match(managerApp, /MCP \$\{esc\(String\(port\)\)\} · Admin \$\{esc\(String\(adminPort\)\)\}/, "workspace cards must display MCP and Admin ports together");
  assert.match(managerServerSource, /ADMIN_PORT .*is occupied by another process/);
  assert.match(managerServerSource, /dừng Server trước khi đổi PORT hoặc ADMIN_PORT/);
  assert.match(managerServerSource, /instanceCreateChain = Promise\.resolve\(\)/, "instance creation must serialize port allocation and persistence");
  assert.match(managerServerSource, /existingManager = await managerHealth\(port\)/, "EADDRINUSE must verify Local Coder Manager identity before treating the port as an existing Manager");
  assert.match(managerServerSource, /isRuntimeArtifactStale\([\s\S]{0,160}?instructions\?\.loaded_at[\s\S]{0,160}?buildState\.newestArtifactMtimeMs/, "Manager status must compare running Local Coder Server startup time against the newest compiled runtime module");
  assert.match(managerServerSource, /inspectRuntimeBuildFreshness/, "Manager must compare source freshness against the complete compiled runtime tree");
  assert.match(managerServerSource, /async function restartServer[\s\S]{0,420}?runtimeBuildStatus\(true\)[\s\S]{0,420}?sourceNewerThanBuild[\s\S]{0,420}?stopServerUnlocked/, "Local Coder Server restart must refuse stale source before stopping the live process");
  assert.match(managerServerSource, /startTunnelUnlocked[\s\S]{0,1800}?serverState\.buildDrift \|\| serverState\.artifactDrift/, "Tunnel start must refuse to expose a stale Local Coder Server contract");
  assert.match(managerServerSource, /MANAGER_RUNTIME_FILES/, "Manager must track the source modules that require self-restart after modification");
  assert.match(managerServerSource, /managerRuntimeStatus\(\)/, "Manager must expose self artifact drift status");
  assert.match(managerServerSource, /!st\.portOccupied && !st\.invalidConfig && !st\.configDrift && !st\.artifactDrift && !st\.buildDrift/, "configuration check must not report stale saved config/source/build/runtime state as healthy");
  assert.match(managerApp, /artifactDrift/, "Manager UI must surface stale runtime artifacts");
  assert.match(managerApp, /configDrift/, "Manager UI must surface a live server using stale saved configuration");
  assert.match(managerApp, /btn-server-restart"\)\.disabled = busy \|\| !srv\.running \|\| serverConflict \|\| buildDrift/, "UI must disable restart until stale source has been built");
  assert.match(managerApp, /btn-tunnel"\)\.disabled = busy \|\| tunnelConflict \|\| \(!tun\.running && \(artifactDrift \|\| buildDrift\)\)/, "UI must not allow a stopped Tunnel to expose a stale Local Coder Server");
  assert.match(managerApp, /buildDrift \? "Source chưa build"/, "workspace card must surface source/build drift instead of showing a false-green server state");
  assert.match(managerApp, /build mới hơn process/, "Manager UI must tell the user a stale Local Coder Server needs restart");
  assert.match(managerApp, /Manager source mới hơn process/, "Manager UI must surface Manager self-drift instead of silently serving stale control logic");
  assert.match(managerHtml, /btn-mgr-restart/, "Manager UI must expose a Restart Manager button in the header");
  assert.match(managerApp, /btn-mgr-restart/, "Manager frontend must wire the Restart Manager button");
  assert.match(managerApp, /\/api\/manager\/restart/, "Manager frontend must call the dedicated self-restart API");
  assert.match(managerServerSource, /p === "\/api\/manager\/restart"/, "Manager must expose POST /api/manager/restart");
  assert.match(managerServerSource, /--restart/, "Manager self-restart must hand off via a restart token argument");
  assert.match(managerServerSource, /TUNNEL_CLIENT_VERSION_FILE/, "Manager must track the installed tunnel-client version for auto-upgrade");
  assert.match(managerServerSource, /tunnel-client-\$\{OPENAI_TUNNEL_VERSION\}\.zip/, "Manager must retain a versioned tunnel-client zip cache instead of deleting it");
  assert.doesNotMatch(managerServerSource, /fsp\.rm\(tmpZip/, "tunnel-client install must not permanently delete its download");
  assert.match(managerServerSource, /OPENAI_TUNNEL_VERSION = "v0\.0\.11"/, "Manager must target tunnel-client v0.0.11 (timeout/session fixes)");
  assert.match(managerServerSource, /if \(!srv\.ok\) \{[\s\S]{0,180}?continue;[\s\S]{0,180}?startTunnel\(name\)/, "autostart must not launch Tunnel after Server start fails");
  assert.match(managerServerSource, /Refusing to stop an unowned .*tunnel/i, "Tunnel stop must fail closed for unowned processes");
  assert.doesNotMatch(managerServerSource, /pidsWithCmdLine\(profileFile\)/, "Tunnel cleanup must include an executable identity and never call the process scanner with only a profile path");
  assert.match(managerServerSource, /pidsWithCmdLine\("tunnel-client\.exe", profileFile\)/, "OpenAI tunnel cleanup must scope by executable plus the instance-unique profile");
  assert.match(managerServerSource, /if \(stopped\) await writePidFile\(inst\.serverPid, null\)/, "failed Local Coder Server startup must preserve PID metadata until the child is confirmed stopped");
  assert.match(managerServerSource, /if \(stopped\) await writePidFile\(inst\.tunnelPid, null\)/, "failed cloudflared startup must preserve PID metadata until the child is confirmed stopped");
  assert.match(managerApp, /\/server\/restart/);
  assert.match(managerApp, /splitExtraWorkspacePaths/);
  assert.match(managerApp, /\.split\(";"\)/);
  assert.match(managerApp, /extraRoots\.join\("; "\)/, "EXTRA_WORKSPACE_PATHS must render as one semicolon-separated line");
  assert.match(managerApp, /inst-extra-path/);
  assert.doesNotMatch(managerApp, /shortPath\(extra\)/, "sidebar must not collapse the whole EXTRA_WORKSPACE_PATHS string to one short path");
  assert.match(managerApp, /Đang chạy/);
  assert.doesNotMatch(managerApp, /\?ang ch\?y|Xung \?\?t c\?ng|Ch\?a ch\?y/, "manager status strings must stay valid UTF-8 Vietnamese");
  assert.match(managerCss, /\.inst-extra-path\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  assert.match(managerCss, /\.inst-ws\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*normal/s);
  assert.match(managerServerSource, /"  level: warn"/, "managed OpenAI tunnel must default to warn logging to avoid unbounded INFO churn");
  assert.doesNotMatch(managerServerSource, /HARPOON_ALLOW_PLAINTEXT_HTTP|--harpoon\.allow-plaintext-http/, "managed tunnel must not weaken Harpoon transport policy just to accept local HTTP metadata");
  assert.match(managerServerSource, /spawnDetached\([\s\S]{0,260}?\.\.\.env,[\s\S]{0,260}?MCP_INSTANCE_NAME:\s*name,[\s\S]{0,120}?LOCAL_CODER_INSTANCE_ID:\s*name/, "Manager must inject instance identity after user env values so .env cannot spoof the managed runtime identity");
  assert.match(managerServerSource, /function isManagedInstanceHealth[\s\S]{0,620}?instance_id[\s\S]{0,320}?instanceId === name[\s\S]{0,320}?return allowLegacy/, "Manager must verify managed runtime instance_id and make missing identity an explicit legacy-only path");
  assert.match(managerServerSource, /const legacyOwnedListener = Boolean\(savedPid && portPid === savedPid && isPidAlive\(savedPid\)\)/, "legacy health without instance_id must require persisted PID + live listener proof");
  assert.match(managerServerSource, /isLocalCoderHealth\(health, env, name, \{ allowLegacy: legacyOwnedListener \}\)/, "configured-port legacy recovery must be gated by the saved-PID listener proof");
  assert.match(managerServerSource, /waitFor\(async \(\) => isLocalCoderHealth\(await serverHealth\(st\.port\), env, name\), 20000\)/, "newly spawned runtimes must pass strict instance identity without allowLegacy");
  assert.match(runtimeEntrySource, /instance_id:\s*process\.env\.LOCAL_CODER_INSTANCE_ID \|\| process\.env\.MCP_INSTANCE_NAME \|\| null/, "Local Coder /health must expose the Manager-injected instance identity without inventing one for direct launches");
  assert.match(managerServerSource, /CHECKPOINT_PATH:[^\n]+path\.join\(inst\.dir, "checkpoints"\)/, "managed checkpoint state must live under the instance, not repo root");
  assert.match(managerServerSource, /MCP_SHELL_STATE_DIR:[^\n]+path\.join\(inst\.dir, "shell-state"\)/, "managed shell state must live under the instance, not repo root");
  assert.match(managerServerSource, /CLC_SANDBOX_STATE_DIR:[^\n]+path\.join\(inst\.dir, "shell-state"\)/, "AppContainer policy state must stay bound to managed shell-state so prior ACL roots remain reconcilable");
  assert.match(managerServerSource, /migrateLegacyRuntimeState/, "default instance must migrate legacy repo-root runtime state before startup");
  assert.match(managerRuntimeStateSource, /recycleManagedDirectory\(target, targetParent\)/, "cross-volume runtime-state rollback must be recoverable");
  assert.doesNotMatch(managerRuntimeStateSource, /fs\.rm\([^\n]*recursive:\s*true/, "runtime-state rollback must never permanently recurse-delete its copy");
  assert.match(managerServerSource, /isLegacyRuntimeStateValue/, "legacy relative runtime-state settings must be recognized instead of treated as custom paths");
  assert.match(managerServerSource, /serializeDotEnv\(\{ \[item\.envKey\]: null \}, rawEnv\)/, "legacy runtime-state settings must be removed after migration to avoid UI/runtime drift");
  assert.match(managerServerSource, /managedRuntimeStatePath\(env\.CHECKPOINT_PATH/, "legacy CHECKPOINT_PATH values must resolve to the managed instance store at spawn time");
  assert.match(managerServerSource, /oldHealthPort = Number\(originalValues\.OPENAI_TUNNEL_HEALTH_PORT \|\| 8080\)/, "saving an instance with the implicit 8080 tunnel-health default must not conflict with its own running tunnel");
  assert.match(
    managerServerSource,
    /if \(before\.running && before\.pid && started\.pid === before\.pid\) \{\s*return \{\s*\.\.\.started,\s*ok: false,\s*restarted: false,/,
    "same-PID restart guard must override started.ok instead of being overwritten by object spread"
  );
  const runtimeSpecsBlock = managerServerSource.match(/const RUNTIME_LIMIT_SPECS = \[([\s\S]*?)\n\];/)?.[1] || "";
  const runtimeSpecKeys = [...runtimeSpecsBlock.matchAll(/^\s*\["([A-Z0-9_]+)",/gm)].map((match) => match[1]);
  assert.ok(runtimeSpecKeys.length > 0, "failed to parse RUNTIME_LIMIT_SPECS for drift check");
  const envKeysBlock = adminUiSource.match(/const ENV_KEYS = \[([\s\S]*?)\];/)?.[1] || "";
  const adminEnvKeys = new Set([...envKeysBlock.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]));
  const exampleEnvKeys = new Set([...envExampleSource.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));
  const runtimeLimitsMissingFromUi = runtimeSpecKeys.filter((key) => !adminEnvKeys.has(key));
  const runtimeLimitsMissingFromExample = runtimeSpecKeys.filter((key) => !exampleEnvKeys.has(key));
  assert.deepEqual(runtimeLimitsMissingFromUi, [], `Manager runtime limits missing from Admin ENV_KEYS: ${runtimeLimitsMissingFromUi.join(", ")}`);
  assert.deepEqual(runtimeLimitsMissingFromExample, [], `Manager runtime limits missing from .env.example: ${runtimeLimitsMissingFromExample.join(", ")}`);

  const managedStart = (await post("/api/instances/restart-demo/server/start")).body;
  assert.equal(managedStart.ok, true, `managed server start failed: ${JSON.stringify(managedStart)}`);
  assert.ok(Number.isInteger(managedStart.pid));
  managedRestartPid = managedStart.pid;
  const startLogOnDisk = await fs.readFile(path.join(restartDemo, "server.log"), "utf8");
  assert.equal(startLogOnDisk.includes(restartHistoricalSecret), false, "managed server start must scrub historical secrets at rest");
  assert.match(startLogOnDisk, /plain=keep-before-start/, "managed server scrub must preserve non-secret history");
  const restartEnvAfterStart = await fs.readFile(path.join(restartDemo, ".env"), "utf8");
  assert.match(restartEnvAfterStart, /^AUDIT_LOG_PATH=\.mcp-audit\.log$/m, "existing managed instance must backfill an instance-local audit path before start");
  assert.doesNotMatch(restartEnvAfterStart, /^MCP_SESSION_RECOVERY=/m, "managed start must scrub obsolete recovery config from legacy instances");
  const managedRestart = (await post("/api/instances/restart-demo/server/restart")).body;
  assert.equal(managedRestart.ok, true, `managed restart failed: ${JSON.stringify(managedRestart)}`);
  assert.equal(managedRestart.restarted, true);
  assert.equal(managedRestart.previousPid, managedStart.pid);
  assert.equal(managedRestart.previousProcessExited, true, "restart must confirm the previous Local Coder Server process exited");
  assert.equal(pidAlive(managedStart.pid), false, "replacement Local Coder Server must not start while the previous PID is still alive");
  assert.ok(Number.isInteger(managedRestart.pid) && managedRestart.pid !== managedStart.pid, "restart must replace the gateway PID");
  managedRestartPid = managedRestart.pid;
  await sleep(300);
  const restartLog = await fs.readFile(path.join(restartDemo, "server.log"), "utf8");
  assert.doesNotMatch(restartLog, /Graceful shutdown timeout/, "isolated restart must not hit the Local Coder Server hard-exit timeout");
  let restartListing;
  for (let attempt = 0; attempt < 10; attempt++) {
    restartListing = (await api("/api/instances")).body.instances.find((x) => x.name === "restart-demo");
    if (restartListing?.server?.running) break;
    await sleep(100);
  }
  assert.equal(restartListing.server.running, true, `restarted Local Coder Server was not reflected as running: ${JSON.stringify(restartListing.server)}`);
  assert.equal(restartListing.server.pid, managedRestart.pid);
  assert.equal(restartListing.server.health?.instance_id, "restart-demo", "managed runtime health must carry its injected instance identity");

  // Same-port workspace drift is the dangerous stale-runtime case: the saved
  // .env can change while the already-owned child keeps serving the old project
  // on the same listener. It must remain owned/running (so lifecycle can repair
  // it), but every health/config surface must report the stale configuration.
  const restartEnvPath = path.join(restartDemo, ".env");
  const restartLiveEnv = await fs.readFile(restartEnvPath, "utf8");
  const driftWorkspace = path.join(root, "workspace-drift");
  await fs.mkdir(driftWorkspace, { recursive: true });
  const workspaceDriftEnv = restartLiveEnv.replace(/^WORKSPACE_PATH=.*$/m, `WORKSPACE_PATH=${driftWorkspace}`);
  await fs.writeFile(restartEnvPath, workspaceDriftEnv, "utf8");
  const workspaceDriftListing = (await api("/api/instances")).body.instances.find((x) => x.name === "restart-demo");
  assert.equal(workspaceDriftListing.server.running, true, "WORKSPACE_PATH drift on the same port must not make the owned server disappear");
  assert.equal(workspaceDriftListing.server.port, restartServerPort, "same-port workspace drift must report the actual live listener");
  assert.equal(workspaceDriftListing.server.pid, managedRestart.pid, "same-port workspace drift must retain exact managed PID ownership");
  assert.equal(workspaceDriftListing.server.health?.instance_id, "restart-demo", "workspace drift must not erase managed instance identity");
  assert.equal(workspaceDriftListing.server.configDrift, true, "same-port workspace drift must be configuration drift");
  assert.equal(workspaceDriftListing.server.workspaceDrift, true, "same-port workspace drift must be classified explicitly");
  assert.equal(workspaceDriftListing.server.portDrift, false, "same-port workspace drift must not be misclassified as PORT drift");
  const workspaceDriftCheck = (await post("/api/instances/restart-demo/check")).body;
  assert.equal(workspaceDriftCheck.ok, false, "configuration check must be red while the owned server is running a stale WORKSPACE_PATH");
  const workspaceDriftServerCheck = workspaceDriftCheck.items.find((item) => item.label === "Server");
  assert.equal(workspaceDriftServerCheck?.ok, false, "Server config-check item must reject stale WORKSPACE_PATH");
  assert.match(workspaceDriftServerCheck?.detail || "", /cấu hình process khác|workspace runtime|restart/i);
  await fs.writeFile(restartEnvPath, restartLiveEnv, "utf8");

  // The Check action also accepts unsaved form overrides. Compare them against
  // the live process, not only against the still-matching on-disk .env.
  const proposedWorkspaceDriftCheck = (await post("/api/instances/restart-demo/check", {
    values: { WORKSPACE_PATH: driftWorkspace },
  })).body;
  assert.equal(proposedWorkspaceDriftCheck.ok, false, "unsaved WORKSPACE_PATH drift must not be reported healthy");
  const proposedWorkspaceServerCheck = proposedWorkspaceDriftCheck.items.find((item) => item.label === "Server");
  assert.equal(proposedWorkspaceServerCheck?.ok, false, "Server check must compare against unsaved proposed workspace config");
  assert.match(proposedWorkspaceServerCheck?.detail || "", /cấu hình process khác|workspace runtime|restart/i);

  // A blank primary workspace is invalid context, never a successful "exists"
  // result. Keep ownership of the already-running process so restart/stop remains
  // possible, but surface both workspaceMissing and configuration drift.
  const missingWorkspaceEnv = restartLiveEnv.replace(/^WORKSPACE_PATH=.*$/m, "WORKSPACE_PATH=");
  await fs.writeFile(restartEnvPath, missingWorkspaceEnv, "utf8");
  const missingWorkspaceListing = (await api("/api/instances")).body.instances.find((x) => x.name === "restart-demo");
  assert.equal(missingWorkspaceListing.workspaceMissing, true, "blank WORKSPACE_PATH must be surfaced as missing");
  assert.equal(missingWorkspaceListing.server.running, true, "blank saved workspace must not lose ownership of the live managed PID");
  assert.equal(missingWorkspaceListing.server.configDrift, true, "blank saved workspace must be classified as config drift");
  assert.equal(missingWorkspaceListing.server.workspaceDrift, true, "blank saved workspace must be classified as workspace drift");
  await fs.writeFile(restartEnvPath, restartLiveEnv, "utf8");

  // Simulate an out-of-band PORT edit while the managed Local Coder Server is still live.
  // Manager must keep tracking the owned PID on its actual old port, refuse a
  // duplicate start, and still be able to stop that exact process safely.
  const driftConfiguredPort = await freePort();
  await fs.writeFile(restartEnvPath, restartLiveEnv.replace(/^PORT=.*$/m, `PORT=${driftConfiguredPort}`), "utf8");
  const driftListing = (await api("/api/instances")).body.instances.find((x) => x.name === "restart-demo");
  assert.equal(driftListing.server.running, true, "PORT drift must not make an owned live Local Coder Server disappear");
  assert.equal(driftListing.server.port, restartServerPort, "status must report the actual live port during config drift");
  assert.equal(driftListing.server.configuredPort, driftConfiguredPort);
  assert.equal(driftListing.server.configDrift, true);
  assert.equal(driftListing.server.pid, managedRestart.pid);
  const driftDuplicateStart = (await post("/api/instances/restart-demo/server/start")).body;
  assert.equal(driftDuplicateStart.ok, false, "PORT drift must fail closed instead of starting a duplicate Local Coder Server");
  assert.match(driftDuplicateStart.error, /still running|PORT|configuration/i);
  const driftTunnelStart = (await post("/api/instances/restart-demo/tunnel/start")).body;
  assert.equal(driftTunnelStart.ok, false, "Tunnel must not start against a Local Coder Server with PORT drift");
  assert.match(driftTunnelStart.error, /old PORT|running|configuration|drift/i);
  const managedStop = (await post("/api/instances/restart-demo/server/stop")).body;
  assert.equal(managedStop.ok, true, `managed server stop failed: ${JSON.stringify(managedStop)}`);
  assert.equal(managedStop.processExited, true, "stop must confirm the Local Coder Server PID fully exited");
  assert.equal(pidAlive(managedRestart.pid), false, "stopped Local Coder Server PID must no longer be alive");
  managedRestartPid = null;
  await fs.writeFile(restartEnvPath, restartLiveEnv, "utf8");

  // Deleting a live instance must first stop its owned Local Coder Server and only then
  // remove the instance metadata. This guards against orphaning a process when
  // instance deletion and lifecycle management drift apart.
  const deleteStart = (await post("/api/instances/restart-demo/server/start")).body;
  assert.equal(deleteStart.ok, true, `delete-demo start failed: ${JSON.stringify(deleteStart)}`);
  assert.ok(Number.isInteger(deleteStart.pid));
  managedRestartPid = deleteStart.pid;
  const deleteResult = (await api("/api/instances/restart-demo", { method: "DELETE" })).body;
  assert.equal(deleteResult.ok, true, `live instance delete failed: ${JSON.stringify(deleteResult)}`);
  assert.equal(pidAlive(deleteStart.pid), false, "instance delete left its Local Coder Server process alive");
  assert.equal(await fs.stat(restartDemo).then(() => true, () => false), false, "instance directory survived successful delete");
  managedRestartPid = null;

  const occupiedCreate = (await post("/api/instances", { name: "occupied", port: createConflictPort, workspacePath: process.cwd() })).body;
  assert.equal(occupiedCreate.ok, false);
  const badPort = (await post("/api/instances", { name: "bad-port", port: `${createConflictPort}junk`, workspacePath: process.cwd() })).body;
  assert.equal(badPort.ok, false, "port parsing must reject numeric prefixes with junk suffixes");

  const concurrentCreates = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    post("/api/instances", { name: `race-${i}`, workspacePath: process.cwd(), autoStart: false }).then((r) => r.body)
  ));
  for (const created of concurrentCreates) assert.equal(created.ok, true, `concurrent create failed: ${JSON.stringify(created)}`);
  const allocatedPorts = concurrentCreates.flatMap((created) => [created.port, created.adminPort, created.healthPort]);
  assert.equal(new Set(allocatedPorts).size, allocatedPorts.length, "concurrent instance creates must allocate unique server/admin/health ports");

  // An unrelated process on MANAGER_PORT must not be mistaken for an already
  // running Local Coder Manager merely because bind() returned EADDRINUSE.
  const unrelatedPort = await freePort();
  const unrelatedServer = http.createServer((_req, res) => res.end("not-a-manager"));
  await listen(unrelatedServer, unrelatedPort);
  const collisionManager = spawn(process.execPath, ["manager/server.mjs", "--no-open"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MANAGER_PORT: String(unrelatedPort),
      MANAGER_INSTANCES_DIR: path.join(root, "collision-instances"),
      MANAGER_STATE_DIR: path.join(root, "collision-state"),
      MCP_ENV_FILE: path.join(root, "collision-legacy.env"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let collisionOutput = "";
  collisionManager.stdout.on("data", (d) => (collisionOutput += d));
  collisionManager.stderr.on("data", (d) => (collisionOutput += d));
  const collisionExit = await Promise.race([
    new Promise((resolve, reject) => {
      collisionManager.once("error", reject);
      collisionManager.once("exit", (code) => resolve(code));
    }),
    sleep(6000).then(() => "timeout"),
  ]);
  if (collisionExit === "timeout" && pidAlive(collisionManager.pid)) collisionManager.kill("SIGTERM");
  await new Promise((resolve) => unrelatedServer.close(resolve));
  assert.equal(collisionExit, 1, `unrelated MANAGER_PORT occupant must produce exit 1, got ${collisionExit}: ${collisionOutput}`);
  assert.match(collisionOutput, /process khác|not.*Local Coder Manager/i);

  const auditLocalCreate = (await post("/api/instances", { name: "audit-local", workspacePath: process.cwd(), autoStart: false })).body;
  assert.equal(auditLocalCreate.ok, true, `audit-local create failed: ${JSON.stringify(auditLocalCreate)}`);
  const auditLocalEnv = await fs.readFile(path.join(instances, "audit-local", ".env"), "utf8");
  assert.match(auditLocalEnv, /^AUDIT_LOG_PATH=\.mcp-audit\.log$/m, "new managed instances must default to an instance-local audit path");
  const auditLocalDelete = (await api("/api/instances/audit-local", { method: "DELETE" })).body;
  assert.equal(auditLocalDelete.ok, true, `audit-local delete failed: ${JSON.stringify(auditLocalDelete)}`);

  const log1 = (await api("/api/instances/demo/log?kind=server&max=300000")).body;
  assert.ok(log1.log.includes("line-last"));
  assert.equal(log1.log.includes(historicalLogSecret), false, "manager log API must redact historical secrets");
  assert.match(log1.log, /OPENAI_TUNNEL_API_KEY=\*{8}/);
  assert.match(log1.log, /Authorization:\s*\*{8}/i);
  const log2 = (await api(`/api/instances/demo/log?kind=server&max=300000&if_size=${log1.size}&if_mtime=${log1.mtime}`)).body;
  assert.equal(log2.unchanged, true);
  assert.equal(log2.log, "");

  console.log("manager-safety: ok (instance identity, legacy-no-id fail-closed, env 20/20, profiles 30/30, workspace/port drift ownership, create serialization, manager-port identity, secret-safe, restart PID swap, conditional log)");
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
  for (const server of [fakeServer, legacyNoIdServer, fakeTunnel, createConflict, fakeAdmin]) await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
