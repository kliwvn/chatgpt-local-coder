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
function pidLooksLikeLocalCoder(pid) {
  if (!pidAlive(pid)) return false;
  if (process.platform !== "win32") return true;
  const escapedRepo = process.cwd().replace(/'/g, "''");
  const script =
    `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue; ` +
    `if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -like '*dist\\index.js*' -and $p.CommandLine -like '*${escapedRepo}*') { exit 0 }; exit 1`;
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 10000,
  });
  return probe.status === 0;
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
await fs.writeFile(path.join(demo, "config.json"), JSON.stringify({ connectorName: "legacy-must-be-removed", healthPort: fakeTunnelPort, autoStart: false, openaiTunnelLaunchFingerprint: "a".repeat(64), tunnelProcessStartedAt: "2026-08-14T12:00:00.0000000Z" }));
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
  // Lifecycle/ownership tests do not need to exercise Windows UAC. Strict-mode
  // AppContainer behavior has dedicated executable boundary suites; keep this
  // managed restart fixture trusted so the Manager test remains headless.
  "FULL_DISK_ACCESS=true",
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
    MANAGER_STALE_CONFIG_RECONCILE_INTERVAL_MS: "3600000",
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

  const instanceConfigGet = (await api("/api/instances/demo/config")).body;
  assert.equal(Object.prototype.hasOwnProperty.call(instanceConfigGet, "openaiTunnelLaunchFingerprint"), false, "instance config GET must not expose internal tunnel launch fingerprint");
  assert.equal(Object.prototype.hasOwnProperty.call(instanceConfigGet, "tunnelProcessStartedAt"), false, "instance config GET must not expose internal tunnel process identity");
  const legacyConfigGet = (await api("/api/config")).body;
  assert.equal(Object.prototype.hasOwnProperty.call(legacyConfigGet, "openaiTunnelLaunchFingerprint"), false, "legacy config GET must not expose internal tunnel launch fingerprint");
  assert.equal(Object.prototype.hasOwnProperty.call(legacyConfigGet, "tunnelProcessStartedAt"), false, "legacy config GET must not expose internal tunnel process identity");
  const instanceConfigPut = (await put("/api/instances/demo/config", { autoStart: false })).body;
  assert.equal(Object.prototype.hasOwnProperty.call(instanceConfigPut.config || {}, "openaiTunnelLaunchFingerprint"), false, "instance config PUT response must not expose internal tunnel launch fingerprint");
  assert.equal(Object.prototype.hasOwnProperty.call(instanceConfigPut.config || {}, "tunnelProcessStartedAt"), false, "instance config PUT response must not expose internal tunnel process identity");
  const legacyConfigPut = (await put("/api/config", { lastTunnelUrl: "", autoStart: true })).body;
  assert.equal(legacyConfigPut.config?.autoStart, true, "legacy /api/config must preserve alias semantics for autoStart mutations");
  assert.equal(Object.prototype.hasOwnProperty.call(legacyConfigPut.config || {}, "openaiTunnelLaunchFingerprint"), false, "legacy config PUT response must not expose internal tunnel launch fingerprint");
  assert.equal(Object.prototype.hasOwnProperty.call(legacyConfigPut.config || {}, "tunnelProcessStartedAt"), false, "legacy config PUT response must not expose internal tunnel process identity");
  const legacyConfigReset = (await put("/api/config", { autoStart: false })).body;
  assert.equal(legacyConfigReset.config?.autoStart, false, "legacy /api/config autoStart round-trip must remain writable in both directions");
  const internalConfigDisk = JSON.parse(await fs.readFile(path.join(demo, "config.json"), "utf8"));
  assert.equal(internalConfigDisk.openaiTunnelLaunchFingerprint, "a".repeat(64), "public config scrubbing must not destroy internal launch evidence");
  assert.equal(internalConfigDisk.tunnelProcessStartedAt, "2026-08-14T12:00:00.0000000Z", "public config scrubbing must preserve internal tunnel process identity");

  // Emulate the browser Raw editor exactly: all secrets are sent back as the
  // sentinel, while a non-secret value that happens to equal eight stars must
  // remain literal. Raw-mode Check and Save must share this same interpretation.
  const browserRaw = Object.entries(envResponse.values)
    .map(([key, value]) => `${key}=${typeof value === "object" && value !== null ? "********" : value}`)
    .join("\n");
  const rawLiteralStars = `${browserRaw}\nPLAIN_STAR_TEST=********`;
  const rawSave = (await put("/api/instances/demo/env", { raw: rawLiteralStars })).body;
  assert.equal(rawSave.ok, true, `masked browser Raw save failed: ${JSON.stringify(rawSave)}`);
  const rawSavedDisk = await fs.readFile(path.join(demo, ".env"), "utf8");
  assert.match(rawSavedDisk, new RegExp(`^OPENAI_TUNNEL_API_KEY=${tunnelSecret}$`, "m"), "raw Save must restore the existing tunnel secret from its sentinel");
  assert.match(rawSavedDisk, new RegExp(`^ADMIN_TOKEN=${adminSecret}$`, "m"), "raw Save must restore the existing admin secret from its sentinel");
  assert.match(rawSavedDisk, /^PLAIN_STAR_TEST=\*{8}$/m, "non-secret eight-star values must remain literal instead of being restored as a secret sentinel");

  const missingRawWorkspace = path.join(root, "raw-check-missing");
  const rawCheckPayload = {
    raw: rawLiteralStars.replace(/^WORKSPACE_PATH=.*$/m, `WORKSPACE_PATH=${missingRawWorkspace}`),
  };
  const rawCheck = (await post("/api/instances/demo/check", rawCheckPayload)).body;
  assert.equal(rawCheck.ok, false, "instance raw-mode Check ignored the proposed raw WORKSPACE_PATH");
  assert.equal(rawCheck.items.find((entry) => entry.label === "Workspace scope")?.ok, false, "instance raw-mode Check must validate raw workspace authority");
  const legacyRawCheck = (await post("/api/check", rawCheckPayload)).body;
  assert.equal(legacyRawCheck.ok, false, "legacy raw-mode Check ignored the proposed raw WORKSPACE_PATH");
  assert.equal(legacyRawCheck.items.find((entry) => entry.label === "Workspace scope")?.ok, false, "legacy /api/check must share raw-mode semantics with the instance route");

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

  // FULL_DISK_ACCESS is a mode toggle, not a hidden Git-root selector. An
  // explicitly configured collection root remains the strict-mode authority
  // boundary; toggling true -> false must not make Save fail just because the
  // root contains independent repositories.
  const collectionRoot = path.join(root, "collection-root");
  await fs.mkdir(path.join(collectionRoot, "repo-a", ".git"), { recursive: true });
  await fs.mkdir(path.join(collectionRoot, "repo-b", ".git"), { recursive: true });
  const collectionCreate = (await post("/api/instances", {
    name: "collection-root",
    workspacePath: collectionRoot,
    autoStart: false,
  })).body;
  assert.equal(collectionCreate.ok, true, `explicit collection workspace create failed: ${JSON.stringify(collectionCreate)}`);
  const collectionStrictSave = (await put("/api/instances/collection-root/env", {
    values: { FULL_DISK_ACCESS: "false" },
  })).body;
  assert.equal(collectionStrictSave.ok, true, `FULL_DISK_ACCESS=false rejected explicit collection root: ${JSON.stringify(collectionStrictSave)}`);
  const collectionEnvPath = path.join(instances, "collection-root", ".env");
  const collectionNoSecretRaw = await fs.readFile(collectionEnvPath, "utf8");
  const absentSecretSentinelSave = (await put("/api/instances/collection-root/env", {
    raw: `${collectionNoSecretRaw}\nADMIN_TOKEN=********`,
  })).body;
  assert.equal(absentSecretSentinelSave.ok, true, `sentinel save on absent secret failed: ${JSON.stringify(absentSecretSentinelSave)}`);
  const absentSecretDisk = await fs.readFile(collectionEnvPath, "utf8");
  assert.doesNotMatch(absentSecretDisk, /^ADMIN_TOKEN=\*{8}$/m, "secret sentinel must never become a literal credential when no prior secret exists");
  assert.match(absentSecretDisk, /^ADMIN_TOKEN=$/m, "absent secret sentinel must resolve to an empty secret consistently with structured Save");
  const collectionStrictRaw = await fs.readFile(collectionEnvPath, "utf8");
  const collectionTrustedRawSave = (await put("/api/instances/collection-root/env", {
    raw: collectionStrictRaw.replace(/^FULL_DISK_ACCESS=.*$/m, "FULL_DISK_ACCESS=true"),
  })).body;
  assert.equal(collectionTrustedRawSave.ok, true, `raw Save could not toggle FULL_DISK_ACCESS=true: ${JSON.stringify(collectionTrustedRawSave)}`);
  const collectionTrustedRaw = await fs.readFile(collectionEnvPath, "utf8");
  const collectionStrictRawSave = (await put("/api/instances/collection-root/env", {
    raw: collectionTrustedRaw.replace(/^FULL_DISK_ACCESS=.*$/m, "FULL_DISK_ACCESS=false"),
  })).body;
  assert.equal(collectionStrictRawSave.ok, true, `raw Save could not toggle FULL_DISK_ACCESS=false on collection root: ${JSON.stringify(collectionStrictRawSave)}`);
  const collectionStrictCheck = (await post("/api/instances/collection-root/check", {
    values: { FULL_DISK_ACCESS: "false" },
  })).body;
  const collectionScopeItem = collectionStrictCheck.items.find((entry) => entry.label === "Workspace scope");
  assert.equal(collectionScopeItem?.ok, true, `strict collection root was not accepted as configured authority: ${JSON.stringify(collectionScopeItem)}`);
  assert.doesNotMatch(collectionScopeItem?.detail || "", /WORKSPACE_SCOPE_AMBIGUOUS/);
  const collectionTrustedSave = (await put("/api/instances/collection-root/env", {
    values: { FULL_DISK_ACCESS: "true" },
  })).body;
  assert.equal(collectionTrustedSave.ok, true, `FULL_DISK_ACCESS=true failed after strict collection save: ${JSON.stringify(collectionTrustedSave)}`);

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
  const managerSafeDeleteSource = await fs.readFile(path.join(process.cwd(), "manager", "safe-delete.mjs"), "utf8");
  const managerTunnelRuntimeSource = await fs.readFile(path.join(process.cwd(), "manager", "tunnel-runtime.mjs"), "utf8");
  const managerRuntimeStateSource = await fs.readFile(path.join(process.cwd(), "manager", "runtime-state.mjs"), "utf8");
  const tunnelBuilderSource = await fs.readFile(path.join(process.cwd(), "scripts", "build-tunnel-client-lazy-codex.ps1"), "utf8");
  const launcherSource = await fs.readFile(path.join(process.cwd(), "chatgpt-local-coder.bat"), "utf8");
  const adminUiSource = await fs.readFile(path.join(process.cwd(), "public", "ui", "app.js"), "utf8");
  const envExampleSource = await fs.readFile(path.join(process.cwd(), ".env.example"), "utf8");
  const runtimeEntrySource = await fs.readFile(path.join(process.cwd(), "src", "index.ts"), "utf8");
  const sandboxSetupSource = await fs.readFile(path.join(process.cwd(), "scripts", "setup-windows-sandbox.mjs"), "utf8");
  const tsconfig = JSON.parse(await fs.readFile(path.join(process.cwd(), "tsconfig.json"), "utf8"));
  assert.match(managerHtml, /id="btn-server-restart"[^>]*class="[^"]*btn-green[^"]*"[^>]*>[^<]*Khởi động lại Local Coder Server/, "Local Coder Server restart must use the same green emphasis as Connector");
  assert.match(managerHtml, /id="btn-tunnel-restart"[^>]*class="[^"]*btn-green[^"]*"[^>]*>[^<]*Khởi động lại Tunnel/, "Tunnel must expose an explicit restart control beside Start/Stop");
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
  assert.match(managerServerSource, /const stageDir = path\.join\(INSTANCES_DIR, `\.creating-\$\{name\}-\$\{randomUUID\(\)\}`\)/, "new instance creation must stage under a hidden non-instance directory");
  assert.match(managerServerSource, /atomicWriteFile\(stagedEnv, envText[\s\S]{0,420}?writeJson\(stagedConfig[\s\S]{0,420}?fsp\.rename\(stageDir, inst\.dir\)/, "new instance creation must complete .env+config before atomically publishing the valid-name directory");
  assert.doesNotMatch(managerServerSource, /async function createInstanceUnlocked\(body\)[\s\S]{0,7000}?fsp\.mkdir\(inst\.dir, \{ recursive: true \}\)/, "create must never publish the catalog-visible instance directory before authority files are complete");
  assert.match(managerServerSource, /existingManager = await managerHealth\(port\)/, "EADDRINUSE must verify Local Coder Manager identity before treating the port as an existing Manager");
  assert.match(managerServerSource, /isRuntimeArtifactStale\([\s\S]{0,160}?instructions\?\.loaded_at[\s\S]{0,160}?buildState\.newestArtifactMtimeMs/, "Manager status must compare running Local Coder Server startup time against the newest compiled runtime module");
  assert.match(managerServerSource, /inspectRuntimeBuildFreshness/, "Manager must compare source freshness against the complete compiled runtime tree");
  assert.match(managerServerSource, /function enqueueRuntimeDeploy\(operation\)[\s\S]{0,700}?runtimeDeployChain\.then\(execute, execute\)/, "shared runtime build/deploy work must serialize globally across instances");
  assert.match(managerServerSource, /async function ensureRuntimeBuiltUnlocked[\s\S]{0,4000}?const sourceBefore = await runtimeSourceFingerprint\(\)[\s\S]{0,1000}?runNpmStep\(\["run", "build"\]\)[\s\S]{0,1000}?const sourceAfter = await runtimeSourceFingerprint\(\)/, "runtime build must fingerprint source bytes before and after compile before deployment");
  assert.match(managerServerSource, /sourceBefore\.fingerprint === sourceAfter\.fingerprint[\s\S]{0,500}?!verifiedBuild\.sourceNewerThanBuild/, "compiled output must be accepted only for a stable source generation");
  assert.match(managerServerSource, /!dependencyStamp[\s\S]{0,220}?node_modules[\s\S]{0,500}?runNpmStep\(\["ls", "--all", "--json"\]\)[\s\S]{0,700}?atomicWriteFile\(RUNTIME_DEPENDENCY_STAMP, dependencyBefore\.fingerprint[\s\S]{0,180}?installNeeded = false/, "a fresh Manager state must locally prove an existing dependency tree and bootstrap its stamp instead of requiring registry/network install");
  assert.match(managerServerSource, /const installNeeded =|let installNeeded =/, "runtime dependency reconciliation must retain an explicit install decision");
  assert.match(managerServerSource, /const serverCommandChains = new Map\(\)/, "Gateway lifecycle serialization must retain a per-instance server command chain");
  assert.match(managerServerSource, /function enqueueServerCommand\(name, operation\)[\s\S]{0,600}?enqueueInstanceCommand\(name, operation\)[\s\S]{0,600}?serverCommandChains\.set\(name, settled\)/, "Gateway public lifecycle commands must serialize through the shared per-instance command queue");
  assert.match(managerServerSource, /const instanceRequestAdmissionChains = new Map\(\)/, "per-instance HTTP admission chains must exist independently of lifecycle command queues");
  assert.match(managerServerSource, /function reserveDirectInstanceMutationAdmission\(req, url\)[\s\S]{0,900}?reserveInstanceRequestAdmission\(name\)/, "direct multi-instance mutations must reserve per-instance HTTP admission order before asynchronous dispatch");
  assert.match(managerServerSource, /function reserveLegacyDefaultMutationAdmission\(req, url\)[\s\S]{0,900}?reserveInstanceRequestAdmission\(name\)/, "legacy default mutations must reserve the same per-instance HTTP admission order as direct routes");
  assert.match(managerServerSource, /const instanceAdmission = trackMutation[\s\S]{0,300}?reserveDirectInstanceMutationAdmission\(req, url\) \|\| reserveLegacyDefaultMutationAdmission\(req, url\)[\s\S]{0,700}?const body = mutatingMethod \? await readBody\(req\) : \{\}[\s\S]{0,300}?handleApi\(req, res, url, body, instanceAdmission\)/, "Manager must reserve direct and legacy-default instance mutation order before async body parsing can reorder lifecycle intent");
  assert.match(managerServerSource, /async function startServer\(name\)[\s\S]{0,1600}?serverRestartInFlight\.delete\(name\)[\s\S]{0,500}?enqueueServerCommand\([\s\S]{0,350}?enqueueRuntimeDeploy\(\(\) => ensureRuntimeAndServerUnlocked\(name, \{ restartTarget: false \}\)\)/, "Gateway Start must establish an intent barrier and serialize the complete shared-deploy command");
  assert.match(managerServerSource, /async function stopServer\(name\)[\s\S]{0,1400}?serverStartInFlight\.delete\(name\)[\s\S]{0,220}?serverRestartInFlight\.delete\(name\)[\s\S]{0,500}?enqueueServerCommand\([\s\S]{0,500}?enqueueRuntimeDeploy\([\s\S]{0,300}?stopServerUnlocked\(name\)/, "Gateway Stop must be a Start\/Restart coalescing barrier and serialize with shared dist deployment so last explicit intent wins");
  assert.match(managerServerSource, /async function restartServerOnce\(name, inFlightStart = null\)[\s\S]{0,4500}?enqueueRuntimeDeploy\(\(\) => ensureRuntimeAndServerUnlocked\(name, \{ restartTarget: true \}\)\)/, "Gateway restart helper must enter the shared build/deploy transaction instead of refusing stale source at the UI boundary");
  assert.match(managerServerSource, /const serverRestartInFlight = new Map\(\)[\s\S]{0,200000}?async function restartServer\(name\)[\s\S]{0,1200}?serverRestartInFlight\.get\(name\)[\s\S]{0,500}?serverStartInFlight\.get\(name\)[\s\S]{0,220}?serverStartInFlight\.delete\(name\)[\s\S]{0,500}?enqueueServerCommand\(name, \(\) => restartServerOnce\(name, inFlightStart\)\)[\s\S]{0,300}?serverRestartInFlight\.set\(name, pending\)/, "Gateway Restart must coalesce duplicate restarts while treating an intervening command as a generation barrier");
  assert.match(managerServerSource, /async function ensureRuntimeAndServerUnlocked[\s\S]{0,700}?ensureRuntimeBuiltUnlocked[\s\S]{0,5000}?restartServerUnlockedCurrent/, "shared runtime must be built/verified before an explicitly targeted Gateway replacement");
  assert.match(managerServerSource, /const refreshJustStartedTarget = Boolean\([\s\S]{0,500}?targetStarted[\s\S]{0,500}?const restartNames = targetState\?\.running && \(restartTarget \|\| refreshJustStartedTarget\) \? \[name\] : \[\]/, "shared dist/config drift may replace only an explicit Restart target or a target first started inside the same unsettled transaction");
  assert.doesNotMatch(managerServerSource, /sharedArtifactDrift|restartAll|redeployAll/, "shared build drift must never imply a rolling restart of unrelated live Gateway peers");
  assert.match(managerServerSource, /Gateway restart requirement[\s\S]{0,500}?running Gateway processes were preserved to avoid connector interruption/, "Install/Build must preserve live Gateway generations and report explicit restart maintenance instead of rolling them automatically");
  {
    const preflightStart = managerServerSource.indexOf("async function preflightServerStartUnlocked");
    const preflightEnd = managerServerSource.indexOf("\nasync function startServerUnlocked", preflightStart);
    assert.ok(preflightStart >= 0 && preflightEnd > preflightStart, "Gateway start preflight boundaries must be discoverable");
    const preflightBlock = managerServerSource.slice(preflightStart, preflightEnd);
    assert.match(preflightBlock, /validateSessionPolicy\(env\)/, "Gateway preflight must validate session policy before a destructive Restart");
    assert.match(preflightBlock, /validateManagedWorkspaceScope\(env\)/, "Gateway preflight must validate workspace authority before a destructive Restart");
    assert.match(preflightBlock, /validateRuntimeLimits\(env\)/, "Gateway preflight must validate runtime limits before a destructive Restart");
    assert.match(preflightBlock, /serverStartPortCheck\(port, "PORT", currentServer\)[\s\S]{0,300}?serverStartPortCheck\(adminPort, "ADMIN_PORT", currentServer\)/, "Gateway preflight must prove both desired listener ports are startable before a destructive Restart");
    assert.match(preflightBlock, /requirePreparedSandbox[\s\S]{0,300}?checkSandboxCompatibility\(name, env, inst\)/, "Gateway preflight must require already-prepared AppContainer compatibility while a serving generation is still live");
    assert.doesNotMatch(preflightBlock, /ensureSandboxCompatibility|migrateLegacyRuntimeState|stopServerUnlocked|killPidTree|rotateLogFile|writePidFile/, "Gateway preflight must remain non-destructive and must not mutate serving authority before Restart commits");

    const restartStart = managerServerSource.indexOf("async function restartServerUnlockedCurrent(name,");
    const restartEnd = managerServerSource.indexOf("\nasync function runtimeGenerationStatus", restartStart);
    assert.ok(restartStart >= 0 && restartEnd > restartStart, "Gateway restart implementation boundaries must be discoverable");
    const restartBlock = managerServerSource.slice(restartStart, restartEnd);
    const preflightPos = restartBlock.indexOf("preflightServerStartUnlocked");
    const stopPos = restartBlock.indexOf("stopServerUnlocked");
    assert.ok(preflightPos >= 0 && stopPos > preflightPos, "Gateway Restart must complete non-destructive startability preflight before draining/stopping the serving PID");
  }
  assert.match(managerServerSource, /async function checkSandboxCompatibilityUnlocked[\s\S]{0,1600}?\["--check"\][\s\S]{0,1200}?requiresSetup: true/, "AppContainer Restart preflight must use a check-only path and surface setup-required without changing ACLs while the old Gateway serves traffic");
  assert.match(managerServerSource, /async function waitForServerTrafficQuiescence[\s\S]{0,1800}?snapshot\.authoritative && snapshot\.activeRequests === 0 && quietEnough/, "legacy quiet compatibility may authorize disruption only from authoritative HTTP request telemetry, never inferred dispatch counters");
  assert.doesNotMatch(managerServerSource, /function automaticDisruptionReadiness|async function automaticDisruptionReadiness/, "quiet-window heuristics must not authorize automatic stop->start of a healthy serving generation");
  assert.match(managerServerSource, /async function drainServerTrafficForDisruption[\s\S]{0,900}?serverAdminLifecycleRequest\(name, "drain"\)[\s\S]{0,2800}?snapshot\.authoritative[\s\S]{0,180}?snapshot\.admission === "draining"[\s\S]{0,180}?snapshot\.activeRequests === 0/, "destructive lifecycle must atomically close MCP admission and drain already-accepted requests before disruption");
  assert.match(managerServerSource, /async function resumeServerTrafficAdmission[\s\S]{0,1800}?attempt <= 3[\s\S]{0,1000}?serverAdminLifecycleRequest\(name, "resume"\)[\s\S]{0,700}?last\.status === 401 \|\| last\.status === 403/, "MCP admission resume must be bounded, identity-checked, and must not blindly retry authorization failures");
  assert.match(managerServerSource, /async function stopServerUnlocked\(name, \{ allowLegacyPreDrainMaintenance = false \} = \{\}\)[\s\S]{0,2600}?drainServerTrafficForDisruption\(name, st\)[\s\S]{0,2200}?\/api\/process\/shutdown/, "Gateway Stop/Restart must close MCP admission before graceful or forced process stop");
  {
    const legacyBridgeStart = managerServerSource.indexOf("async function waitForExplicitLegacyPreDrainMaintenance");
    const legacyBridgeEnd = managerServerSource.indexOf("\nasync function serverAdminLifecycleRequest", legacyBridgeStart);
    assert.ok(legacyBridgeStart >= 0 && legacyBridgeEnd > legacyBridgeStart, "explicit legacy pre-drain maintenance bridge boundaries must be discoverable");
    const legacyBridgeBlock = managerServerSource.slice(legacyBridgeStart, legacyBridgeEnd);
    assert.match(legacyBridgeBlock, /\[404, 501\]\.includes\(Number\(priorDrain\?\.drainApiStatus\)\)/, "legacy maintenance bridge must exist only for an old runtime that lacks the drain endpoint");
    assert.match(legacyBridgeBlock, /snapshot\.source === "legacy_mcpDispatch"[\s\S]{0,500}?snapshot\.activeRequests === 0[\s\S]{0,500}?connectedSessions === 0/, "legacy maintenance bridge must require zero inferred requests/builds/recoveries and zero connected sessions");
    assert.match(legacyBridgeBlock, /idleObservedAtMs[\s\S]{0,1600}?observedQuietForMs[\s\S]{0,500}?observedQuietForMs >= DISRUPTIVE_RESTART_QUIET_MS/, "timestamp-less legacy runtimes must be observed continuously idle by Manager for the full quiet window");
    assert.match(legacyBridgeBlock, /consecutiveIdle >= 3[\s\S]{0,500}?atomicAdmission: false[\s\S]{0,300}?legacyPreDrainMaintenance: true[\s\S]{0,300}?explicitOnly: true/, "legacy bridge receipt must remain explicitly non-atomic and require repeated exact-identity idle observations");
    assert.doesNotMatch(legacyBridgeBlock, /authoritative:\s*true|snapshot\.authoritative\s*=\s*true/, "legacy dispatch telemetry must never be promoted to authoritative lifecycle telemetry");
  }
  assert.match(managerServerSource, /stopServerUnlocked\(name, \{ allowLegacyPreDrainMaintenance \}\)/, "Gateway restart implementation must thread legacy maintenance authority explicitly into stop");
  assert.match(managerServerSource, /allowLegacyPreDrainMaintenance: restartTarget && instanceName === name/, "only an explicitly targeted Server Restart may enable the legacy pre-drain maintenance bridge");
  assert.doesNotMatch(managerServerSource, /stopServerUnlocked\(name, \{ allowLegacyPreDrainMaintenance: true \}\)/, "no generic Stop/Delete/background path may hard-enable legacy non-atomic maintenance");
  assert.match(managerServerSource, /previousProcessExited: targetRestartReceipt\?\.previousProcessExited === true[\s\S]{0,260}?trafficDrain: targetRestartReceipt\?\.trafficDrain \|\| null[\s\S]{0,220}?legacyPreDrainMaintenance: targetRestartReceipt\?\.legacyPreDrainMaintenance === true/, "outer Server Restart response must preserve traffic-drain and legacy-maintenance receipts instead of false-green flattening lifecycle evidence");
  assert.match(managerServerSource, /if \(!stopped\)[\s\S]{0,500}?trafficDrain\.admissionClosed[\s\S]{0,180}?resumeServerTrafficAdmission\(name, st\)/, "failed Gateway stop must attempt to reopen admission instead of leaving the preserved process stuck draining");
  assert.match(managerServerSource, /const tunnelCommandChains = new Map\(\)[\s\S]{0,1600}?function enqueueTunnelCommand\(name, operation\)[\s\S]{0,600}?tunnelCommandChains\.set\(name, settled\)/, "Tunnel public lifecycle commands must serialize from request intent through Gateway convergence and transport mutation");
  assert.match(managerServerSource, /async function startTunnel\(name\)[\s\S]{0,2600}?tunnelRestartInFlight\.delete\(name\)[\s\S]{0,500}?enqueueTunnelCommand\([\s\S]{0,900}?enqueueRuntimeDeploy\(\(\) => ensureRuntimeAndServerUnlocked\(name, \{ restartTarget: false \}\)\)[\s\S]{0,1000}?enqueueTunnelLifecycle\(name, \(\) => startTunnelUnlocked\(name\)\)/, "Tunnel Start must be idempotent/non-destructive and delegate stale running transport replacement to explicit Restart");
  assert.doesNotMatch(managerServerSource, /safeOwnedDrift/, "Tunnel Start must not retain the old implicit stale-Tunnel restart branch");
  {
    const observeStart = managerServerSource.indexOf("async function observeStaleConfigUnlocked(name)");
    const observeEnd = managerServerSource.indexOf("\nasync function observeStaleConfigOnce()", observeStart);
    assert.ok(observeStart >= 0 && observeEnd > observeStart, "stale-config observer function boundaries must be discoverable");
    const observeBlock = managerServerSource.slice(observeStart, observeEnd);
    assert.match(observeBlock, /pending\.push\("server"\)[\s\S]*pending\.push\("tunnel"\)/, "background observer must report stale Server/Tunnel maintenance without mutating them");
    assert.match(observeBlock, /maintenanceRequired: pending\.length > 0[\s\S]{0,500}?healthy-serving-generation-preserved/, "background observer must explicitly preserve healthy serving generations while surfacing maintenance");
    assert.doesNotMatch(observeBlock, /ensureRuntimeAndServerUnlocked|restartServerUnlocked|restartTunnelUnlocked|stopServerUnlocked|stopTunnelUnlocked/, "background drift observation must contain no destructive Server/Tunnel lifecycle call");
  }
  assert.match(managerServerSource, /enqueueInstanceCommand\(name, \(\) => observeStaleConfigUnlocked\(name\)\)/, "stale-config observation must re-enter the per-instance command queue so status observation cannot race explicit lifecycle authority");
  assert.match(managerServerSource, /startStaleConfigObserver\(\)/, "Manager bootstrap must enable persistent non-destructive stale-config observation");
  assert.match(managerServerSource, /const busyInstanceCommands = \[\.\.\.instanceCommandChains\.keys\(\)\][\s\S]{0,500}?busyInstanceCommands\.length > 0/, "Manager self-restart must refuse while shared per-instance commands/maintenance observation are still in flight");
  assert.match(managerServerSource, /async function stopTunnel\(name\)[\s\S]{0,1200}?tunnelStartInFlight\.delete\(name\)[\s\S]{0,220}?tunnelRestartInFlight\.delete\(name\)[\s\S]{0,500}?enqueueTunnelCommand\([\s\S]{0,350}?stopTunnelWithTrafficDrainUnlocked\(name\)/, "Tunnel Stop must be a Start\/Restart coalescing barrier and must not bypass MCP traffic drain");
  assert.match(managerServerSource, /async function stopTunnelWithTrafficDrainUnlocked\(name\)[\s\S]{0,1200}?drainServerTrafficForDisruption\(name, gateway\)[\s\S]{0,700}?stopTunnelUnlocked\(name\)[\s\S]{0,300}?finishTunnelDisruptionAdmission/, "explicit Tunnel Stop must drain accepted MCP traffic before transport stop and resume admission afterwards");
  assert.match(managerServerSource, /async function restartTunnelUnlocked\(name[\s\S]{0,700}?preflightTunnelReplacementUnlocked\(name, prior\)[\s\S]{0,1200}?drainServerTrafficForDisruption\(name, preflight\.server\)[\s\S]{0,900}?stopTunnelUnlocked\(name\)/, "Tunnel restart must preflight then atomically drain MCP admission before stopping the running Tunnel");
  assert.match(managerServerSource, /async function finishTunnelDisruptionAdmission[\s\S]{0,700}?resumeServerTrafficAdmission\(name, gatewayState\)[\s\S]{0,700}?admission could not be resumed/, "Tunnel lifecycle must resume Gateway MCP admission and fail closed instead of false-green if resume cannot be proven");
  assert.match(managerServerSource, /existing Tunnel was preserved/, "Tunnel replacement preflight failures must explicitly preserve the current healthy Tunnel");
  assert.match(managerServerSource, /if \(!serverState\.running \|\| !serverState\.owned \|\| serverState\.configDrift\)/, "Tunnel start must never expose a Gateway whose exact Manager ownership is unproven");
  assert.match(managerServerSource, /rollbackGatewayMatches[\s\S]{0,500}?Number\(serverState\.pid\) === Number\(rollbackGateway\.pid\)[\s\S]{0,300}?loaded_at[\s\S]{0,300}?rollbackGateway\.loadedAt/, "Tunnel rollback may bypass build drift only for the exact Gateway PID and loaded generation captured before the destructive boundary");
  assert.match(managerServerSource, /async function restorePriorHealthyTunnelUnlocked[\s\S]{0,500}?prior\?\.running && prior\?\.owned && !prior\?\.configDrift && !prior\?\.healthDrift[\s\S]{0,1200}?startTunnelUnlocked\(name, \{ rollbackGateway: gatewayIdentity \}\)/, "post-stop replacement failure must have a bounded restore path only for an exact-owned previously healthy Tunnel");
  assert.match(managerServerSource, /if \(!started\.ok\)[\s\S]{0,320}?restorePriorHealthyTunnelUnlocked\(name, prior, rollbackGateway\)[\s\S]{0,500}?preserved: rollback\.ok === true[\s\S]{0,180}?restored: rollback\.ok === true/, "Tunnel restart must attempt rollback after replacement startup failure and report preservation only when restoration is proven");
  assert.match(managerServerSource, /async function restartTunnelOnce\(name, inFlightStart = null\)[\s\S]{0,3800}?currentGateway\.buildDrift[\s\S]{0,220}?currentGateway\.artifactDrift[\s\S]{0,2800}?enqueueRuntimeDeploy\(\(\) => ensureRuntimeAndServerUnlocked[\s\S]{0,900}?enqueueTunnelLifecycle\(name, \(\) => restartTunnelUnlocked\(name\)\)/, "Tunnel restart may coalesce only an exact-current fresh Start; otherwise it must prepare shared Gateway runtime before destructive replacement");
  assert.match(managerServerSource, /const tunnelRestartInFlight = new Map\(\)[\s\S]{0,100000}?async function restartTunnel\(name\)[\s\S]{0,1100}?tunnelRestartInFlight\.get\(name\)[\s\S]{0,500}?tunnelStartInFlight\.get\(name\)[\s\S]{0,220}?tunnelStartInFlight\.delete\(name\)[\s\S]{0,500}?enqueueTunnelCommand\(name, \(\) => restartTunnelOnce\(name, inFlightStart\)\)[\s\S]{0,300}?tunnelRestartInFlight\.set\(name, pending\)/, "Tunnel Restart must coalesce duplicates while treating intervening Start\/Stop commands as generation barriers");
  assert.match(managerServerSource, /const serverState = await serverStatus\(name\);[\s\S]{0,1200}?serverState\.buildDrift \|\| serverState\.artifactDrift/, "Tunnel replacement/start defensive gates must still refuse a stale Gateway if source changes after deploy preflight");
  assert.match(managerServerSource, /async function deleteInstanceUnlocked\(name\)[\s\S]{0,5000}?enqueueTunnelLifecycle\(name, \(\) => stopTunnelWithTrafficDrainUnlocked\(name\)\)/, "workspace deletion must not bypass the same traffic-drained Tunnel stop contract");
  assert.match(runtimeEntrySource, /let mcpAdmissionDraining = false[\s\S]{0,3600}?admissionRejected = tracksMcpTraffic && mcpAdmissionDraining[\s\S]{0,4200}?res\.setHeader\("Retry-After", "1"\)[\s\S]{0,180}?res\.status\(503\)[\s\S]{0,700}?retryable: true, lifecycle: "draining"/, "Local Coder runtime must reject new MCP mutations as retryable after lifecycle admission closes");
  assert.match(runtimeEntrySource, /mcpTraffic:\s*mcpLifecycleState\(\)/, "Local Coder /health must expose authoritative MCP admission/request lifecycle state to Manager");
  assert.equal(tsconfig.compilerOptions?.noEmitOnError, true, "TypeScript compile errors must never emit partial shared dist output");
  assert.match(managerServerSource, /MANAGER_RUNTIME_FILES/, "Manager must track the source modules that require self-restart after modification");
  assert.match(managerServerSource, /tunnel-state\.mjs/, "Manager self-drift tracking must include tunnel launch-state logic");
  assert.match(managerServerSource, /autostart-policy\.mjs/, "Manager self-drift tracking must include boot autostart policy logic");
  assert.match(managerServerSource, /managerRuntimeStatus\(\)/, "Manager must expose self artifact drift status");
  assert.match(managerServerSource, /!st\.portOccupied && !st\.invalidConfig && !st\.configDrift && !st\.artifactDrift && !st\.buildDrift/, "configuration check must not report stale saved config/source/build/runtime state as healthy");
  assert.match(managerServerSource, /openAiTunnelLaunchFingerprint\(\{[\s\S]{0,260}?tunnelId[\s\S]{0,220}?apiKey[\s\S]{0,220}?healthPort[\s\S]{0,220}?serverPort[\s\S]{0,220}?runtimeIdentity/, "OpenAI tunnel status/start must bind ID, secret, health port, server port and runtime generation into secret-safe launch evidence");
  assert.match(managerServerSource, /CreationDate\.ToUniversalTime\(\)\.ToString\('o'\)[\s\S]{0,120}?ExecutablePath/, "Manager process scan must capture Windows CreationDate plus exact executable path in one identity scan");
  assert.match(managerServerSource, /\$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process/, "CIM process identity scan must convert PowerShell non-terminating errors into a failed scan");
  assert.match(managerServerSource, /async function processesWithCmdLineAsync\(imageName, substring\)[\s\S]{0,1800}?spawn\("powershell\.exe"[\s\S]{0,1800}?code !== 0[\s\S]{0,420}?PROCESS_IDENTITY_SCAN_FAILED/, "failed process identity scans must use non-blocking child I/O and fail closed instead of masquerading as zero matching processes");
  assert.match(managerServerSource, /PROCESS_IDENTITY_SCAN_FAILED: process identity scan timed out after 15000ms/, "process identity scan must have an explicit bounded timeout");
  assert.match(managerServerSource, /const inFlightKey = `\$\{generation\}\\u0000\$\{key\}`[\s\S]{0,260}?pidScanInFlight\.get\(inFlightKey\)[\s\S]{0,2200}?generation === pidScanGeneration[\s\S]{0,180}?pidScanCache\.set/, "process identity scans must coalesce same-generation work and generation-fence cache publication");
  assert.doesNotMatch(managerServerSource, /catch\s*\{\s*processes\s*=\s*\[\]/, "process identity scan failure must never be cached as an empty successful scan");
  assert.match(managerServerSource, /evaluateOpenAiTunnelLaunchState\(\{[\s\S]{0,500}?processPids:\s*oaPids[\s\S]{0,220}?processStartedAt:\s*oaProcessStartedAt[\s\S]{0,220}?savedPid[\s\S]{0,220}?savedProcessStartedAt[\s\S]{0,260}?runtimePathMatches:\s*oaRuntimePathMatches/, "OpenAI tunnel status must bind PID, CreationDate and exact runtime path before accepting a green launch identity");
  assert.match(managerServerSource, /legacyPidFileMatchesProcessStart\(\{[\s\S]{0,180}?processStartedAt:[\s\S]{0,120}?pidFileMtimeMs/, "previous-contract tunnel ownership must be recoverable only through bounded PID-file mtime versus CreationDate evidence");
  assert.match(managerServerSource, /legacyOaProcessIdentity = Boolean\([\s\S]{0,900}?persistedOaFingerprint[\s\S]{0,220}?persistedOaLegacyFingerprint/, "legacy OpenAI ownership bridge must accept only current or immediate-v1 persisted fingerprints for bounded safe-stop migration");
  assert.match(managerServerSource, /managedOaPid = exactOaProcessIdentity \|\| legacyOaProcessIdentity \? savedPid : null/, "legacy evidence may grant stop/restart ownership without pretending CreationDate was already persisted");
  assert.match(managerServerSource, /clearTunnelLaunchEvidence\(config\)[\s\S]{0,360}?config\.openaiTunnelLaunchFingerprint = launchFingerprint[\s\S]{0,600}?spawnDetached\(client\.path/, "OpenAI tunnel start must persist a pending secret-safe fingerprint before spawn so a Manager crash cannot orphan the exact child");
  assert.match(managerServerSource, /const pid = spawnDetached\(client\.path[\s\S]{0,1200}?writePidFile\(inst\.tunnelPid, pid\)/, "OpenAI tunnel start must persist the exact spawned PID instead of relying on profile-path discovery alone");
  assert.match(managerServerSource, /await processesWithCmdLineAsync\("tunnel-client\.exe", profileFile\)[\s\S]{0,320}?\.find\(\(process\) => process\.pid === pid\)[\s\S]{0,260}?sameExecutablePath\(processIdentity\.executablePath, client\.path\)[\s\S]{0,160}?processStartedAt = processIdentity\.startedAt/, "OpenAI tunnel start must asynchronously capture CreationDate and prove exact executable path for the spawned PID");
  assert.match(managerServerSource, /config\.openaiTunnelLaunchFingerprint = launchFingerprint;[\s\S]{0,120}?config\.tunnelProcessStartedAt = processStartedAt;[\s\S]{0,220}?const up = await waitFor/, "OpenAI tunnel must persist exact fingerprint+CreationDate before waiting for network health");
  assert.match(managerServerSource, /if \(!up\)[\s\S]{0,900}?if \(stopped\)[\s\S]{0,220}?clearTunnelLaunchEvidence[\s\S]{0,420}?else \{[\s\S]{0,360}?writePidFile\(inst\.tunnelPid, survivors\[0\] \|\| pid\)/, "OpenAI health cleanup must clear identity only after confirmed exit and preserve evidence for a survivor");
  assert.match(managerServerSource, /await processesWithCmdLineAsync\("cloudflared\.exe", `localhost:\$\{port\}`\)[\s\S]{0,320}?\.find\(\(process\) => process\.pid === pid\)[\s\S]{0,220}?processStartedAt = processIdentity\.startedAt/, "Cloudflare tunnel start must asynchronously capture CreationDate for the exact spawned PID");
  assert.match(managerServerSource, /config\.tunnelProcessStartedAt = processStartedAt;[\s\S]{0,220}?let url = null;[\s\S]{0,220}?const deadline = Date\.now\(\) \+ 25000/, "Cloudflare must persist CreationDate before waiting for public URL discovery");
  assert.match(managerServerSource, /if \(!url\)[\s\S]{0,520}?if \(stopped\)[\s\S]{0,220}?clearTunnelLaunchEvidence[\s\S]{0,360}?else \{[\s\S]{0,260}?writePidFile\(inst\.tunnelPid, pid\)/, "Cloudflare URL cleanup must preserve CreationDate/PID evidence for a survivor");
  assert.ok((managerServerSource.match(/config\.tunnelProcessStartedAt = processStartedAt/g) || []).length >= 2, "successful OpenAI and Cloudflare starts must persist process CreationDate");
  assert.match(managerServerSource, /const targets = new Set\(\);[\s\S]{0,240}?st\.ownedOpenAiPid[\s\S]{0,240}?st\.ownedCloudflarePid/, "Tunnel stop must target only exact process identities proven owned by Manager state");
  assert.doesNotMatch(managerServerSource, /const targets = new Set\(pidsWithCmdLine\("tunnel-client\.exe", inst\.profile\)/, "Tunnel stop must never kill every same-profile OpenAI process");
  assert.match(managerServerSource, /const targets = isPidAlive\(pid\) \? \[pid\] : \[\]/, "failed OpenAI startup cleanup must kill only the exact PID it spawned");
  assert.match(managerServerSource, /const desiredCfProcessesPromise = Number\.isInteger\(serverPort\)[\s\S]{0,360}?processesWithCmdLineAsync\("cloudflared\.exe", `localhost:\$\{serverPort\}`\)/, "Tunnel status must asynchronously detect same-port cloudflared even when OpenAI mode is configured");
  assert.match(managerServerSource, /const cfCandidatePids = \[\.\.\.new Set\(\[[\s\S]{0,220}?\.\.\.desiredCfPids[\s\S]{0,120}?\.\.\.persistedCfPids[\s\S]{0,180}?savedCfProcess/, "mixed detection must include proposed port, persisted port, and exact saved-PID Cloudflare candidates");
  assert.match(managerServerSource, /if \(oaPids\.length > 0 && cfCandidatePids\.length > 0\)[\s\S]{0,180}?mixedPids[\s\S]{0,420}?kind:\s*"mixed"/, "OpenAI plus any relevant managed/candidate cloudflared process must enter the mixed-process branch");
  assert.match(managerServerSource, /kind:\s*"mixed"[\s\S]{0,420}?configDrift:\s*true/, "mixed OpenAI/Cloudflare state must always fail closed as configuration drift");
  assert.match(managerServerSource, /tun\.kind === "mixed"[\s\S]{0,260}?OpenAI tunnel-client và cloudflared/, "Config Check must diagnose mixed OpenAI+Cloudflare state instead of mislabeling it as same-profile duplication");
  assert.match(managerServerSource, /const remaining = await tunnelStatus\(name\);[\s\S]{0,420}?remainingUnowned:\s*true/, "Tunnel stop must fail closed when an unowned duplicate/candidate remains after the exact owned PID stops");
  assert.match(managerServerSource, /waitForTunnelPortRelease\(\{[\s\S]{0,260}?port:\s*Number\(st\.healthPort\)[\s\S]{0,180}?isPortOpen/, "Tunnel stop must settle the OpenAI health listener after the managed process tree exits before reporting restart-safe success");
  assert.match(managerServerSource, /if \(!portReleased\)[\s\S]{0,600}?stopped:\s*true[\s\S]{0,260}?portReleased:\s*false/, "Tunnel stop must fail closed when the process exited but its health listener did not release");
  assert.match(managerServerSource, /restarted:\s*true[\s\S]{0,120}?stop:\s*stopped/, "successful Tunnel restart must return the stop settlement receipt so callers can verify process/port release");
  assert.match(managerServerSource, /const tun = await tunnelStatus\(name, env\);[\s\S]{0,300}?tun\.running && tun\.configDrift/, "Config Check must compare a running Tunnel against candidate unsaved config instead of the stale on-disk env");
  assert.match(managerServerSource, /healthDrift:\s*oaLaunchState\?\.healthDrift === true/, "OpenAI tunnel status must expose operational health drift separately from launch/config drift");
  assert.match(managerServerSource, /if \(st\.running && st\.healthDrift\)[\s\S]{0,360}?health endpoint is not responding/, "Tunnel start must refuse already-running unhealthy transport instead of false-reporting already healthy");
  assert.match(managerServerSource, /function isExactBootRecoveryTunnelGeneration\(reference, current\)[\s\S]{0,2200}?launchPidMatch === true[\s\S]{0,500}?launchProcessStartedAtMatch === true[\s\S]{0,500}?launchFingerprintMatch === true[\s\S]{0,500}?runtimePathMatches === true[\s\S]{0,900}?Number\(current\?\.pid\) === Number\(reference\?\.pid\)/, "automatic boot recovery must require exact modern Tunnel generation identity, not mere same-profile ownership");
  assert.match(managerServerSource, /async function confirmBootTunnelHealthDrift\(name, initial\)[\s\S]{0,2200}?sample < BOOT_TUNNEL_HEALTH_CONFIRMATIONS[\s\S]{0,500}?tunnelStatus\(name\)[\s\S]{0,500}?health-recovered[\s\S]{0,700}?generation-or-authority-changed[\s\S]{0,500}?confirmed: true/, "boot recovery must require sustained independent health-drift observations and preserve transport if health or generation changes");
  {
    const bootRecoverStart = managerServerSource.indexOf("async function recoverTunnelForBoot(name)");
    const bootRecoverEnd = managerServerSource.indexOf("\nasync function restartTunnelOnce", bootRecoverStart);
    assert.ok(bootRecoverStart >= 0 && bootRecoverEnd > bootRecoverStart, "boot Tunnel recovery boundaries must be discoverable");
    const bootRecoverBlock = managerServerSource.slice(bootRecoverStart, bootRecoverEnd);
    const confirmationPos = bootRecoverBlock.indexOf("confirmBootTunnelHealthDrift(name, current)");
    const restartPos = bootRecoverBlock.indexOf("restartTunnelUnlocked(name, confirmation.observation)");
    assert.ok(confirmationPos >= 0 && restartPos > confirmationPos, "boot supervisor must confirm sustained exact-generation health drift before automatic Tunnel stop->start");
    assert.match(bootRecoverBlock, /confirmation\.recovered[\s\S]{0,500}?alreadyRunning: true/, "boot recovery must treat self-recovered Tunnel health as success without restart");
    assert.match(bootRecoverBlock, /preserved: current\.running === true[\s\S]{0,180}?retryable: true/, "unproven automatic Tunnel recovery must preserve current transport and surface retryable status");
  }
  assert.match(managerServerSource, /recoverTunnel:\s*recoverTunnelForBoot/, "Manager boot must wire the bounded unhealthy-Tunnel recovery hook into the autostart supervisor");
  assert.match(managerServerSource, /tun\.running && tun\.healthDrift[\s\S]{0,260}?Tunnel health/, "Config Check must diagnose a matching but unhealthy Tunnel as health drift, not stale launch configuration");
  assert.match(managerServerSource, /The exact same-profile tunnel-client is known[\s\S]{0,180}?portOccupied:\s*false/, "known same-profile OpenAI process health failure must not be mislabeled as an unrelated port occupant");
  assert.match(managerServerSource, /publicInstanceConfig\(await readInstanceConfig\(name\)\)/, "instance config GET must expose only public config fields");
  assert.match(managerServerSource, /config:\s*publicInstanceConfig\(config\)/, "config mutation responses must not leak internal launch fingerprints");
  assert.match(managerApp, /artifactDrift/, "Manager UI must surface stale runtime artifacts");
  assert.match(managerApp, /configDrift/, "Manager UI must surface a live server using stale saved configuration");
  assert.match(managerApp, /const tunnelConfigDrift = Boolean\(tun\.configDrift\)/, "focused Tunnel status must consume backend launch/config drift instead of treating any live process as healthy");
  assert.match(managerApp, /const tunnelHealthDrift = Boolean\(tun\.healthDrift\)/, "focused Tunnel status must consume operational health drift separately from launch config drift");
  assert.match(managerApp, /const tunnelCurrent = tun\.running && !tunnelConfigDrift && !tunnelHealthDrift/, "focused Tunnel dot must be green only when launch identity and operational health are both current");
  assert.match(managerApp, /tun\.running && tunnelConfigDrift[\s\S]{0,520}?btn-copy-url[\s\S]{0,120}?classList\.add\("hidden"\)/, "stale/ambiguous Tunnel state must explain restart and hide the copy-URL action");
  assert.match(managerApp, /tun\.running && tunnelHealthDrift[\s\S]{0,260}?health endpoint[\s\S]{0,160}?btn-copy-url[\s\S]{0,120}?classList\.add\("hidden"\)/, "unhealthy matching Tunnel must show a health-specific warning and hide copy URL");
  assert.match(managerApp, /tun\.kind === "mixed"[\s\S]{0,220}?OpenAI tunnel-client và cloudflared/, "focused Tunnel UI must distinguish mixed OpenAI+Cloudflare from same-profile duplicate OpenAI processes");
  assert.match(managerApp, /const tunnelConfigDrift = Boolean\(i\.tunnel\.configDrift\)[\s\S]{0,180}?const tunnelHealthDrift = Boolean\(i\.tunnel\.healthDrift\)[\s\S]{0,260}?Tunnel health lỗi/, "workspace sidebar must surface health drift separately from configuration drift without false-green status");
  assert.match(managerApp, /btn-server-restart"\)\.disabled = busy \|\| !srv\.running \|\| serverConflict;/, "UI must allow Restart Gateway to invoke backend auto-build/deploy when source is stale");
  assert.doesNotMatch(managerApp, /btn-server-restart"\)\.disabled[^;]*buildDrift/, "UI must not deadlock auto-build by disabling Restart Gateway on source drift");
  assert.match(managerApp, /btn-tunnel-restart"\)\.disabled = busy \|\| !tun\.running \|\| tunnelConflict;/, "Tunnel Restart must remain available for a running exact-owned stale Tunnel");
  assert.match(managerApp, /async function restartTunnelNow\(\)[\s\S]{0,900}?\/tunnel\/restart/, "Tunnel Restart UI must invoke the dedicated backend restart endpoint");
  assert.match(managerApp, /btn-tunnel"\)\.disabled = busy \|\| tunnelConflict;/, "UI must allow Tunnel start/restart to invoke backend Gateway convergence");
  assert.doesNotMatch(managerApp, /btn-tunnel"\)\.disabled[^;]*(?:artifactDrift|buildDrift)/, "UI must delegate stale Gateway handling to the transactional Tunnel backend");
  assert.match(managerApp, /buildDrift \? "Source chưa build"/, "workspace card must surface source/build drift instead of showing a false-green server state");
  assert.match(managerApp, /build mới hơn process/, "Manager UI must tell the user a stale Local Coder Server needs restart");
  assert.match(managerApp, /Manager source mới hơn process/, "Manager UI must surface Manager self-drift instead of silently serving stale control logic");
  assert.match(managerHtml, /btn-mgr-restart/, "Manager UI must expose a Restart Manager button in the header");
  assert.match(managerHtml, /MCP_SYNC_RESPONSE_BUDGET_MS[\s\S]{0,500}?KHÔNG phải hết MCP session\/ChatGPT turn[\s\S]{0,200}?start_process \+ process_output/, "Manager UI must explain that synchronous run_command timeout is per-call and must not be diagnosed as session/turn termination");
  assert.match(managerApp, /btn-mgr-restart/, "Manager frontend must wire the Restart Manager button");
  assert.match(managerApp, /\/api\/manager\/restart/, "Manager frontend must call the dedicated self-restart API");
  assert.match(managerServerSource, /p === "\/api\/manager\/restart"/, "Manager must expose POST /api/manager/restart");
  assert.match(managerServerSource, /--restart/, "Manager self-restart must hand off via a restart token argument");
  assert.match(managerServerSource, /const busyInstanceCommands = \[\.\.\.instanceCommandChains\.keys\(\)\][\s\S]{0,260}?const busyServerInstances = \[\.\.\.new Set\(\[\.\.\.serverCommandChains\.keys\(\), \.\.\.serverLifecycleChains\.keys\(\)\]\)\][\s\S]{0,260}?const busyTunnelInstances = \[\.\.\.new Set\(\[\.\.\.tunnelCommandChains\.keys\(\), \.\.\.tunnelLifecycleChains\.keys\(\)\]\)\][\s\S]{0,500}?retryable:\s*true/, "Manager self-restart must refuse to cut across shared instance commands plus both public command queues and low-level Server/Tunnel lifecycle work");
  assert.match(managerServerSource, /const activeManagerMutations = new Map\(\)[\s\S]{0,180}?let managerMutationSequence = 0/, "Manager must maintain explicit in-flight mutation authority for restart serialization");
  assert.match(managerServerSource, /if \(activeManagerMutations\.size > 0\)[\s\S]{0,260}?retryable:\s*true[\s\S]{0,360}?activeMutations:/, "self-restart must fail closed while any Manager mutation request is unsettled");
  assert.match(managerServerSource, /const mutatingMethod = \["POST", "PUT", "DELETE", "PATCH"\]\.includes\(req\.method\)[\s\S]{0,220}?const restartRequest = req\.method === "POST" && url\.pathname === "\/api\/manager\/restart"[\s\S]{0,160}?const trackMutation = mutatingMethod && !restartRequest/, "HTTP control-plane must classify all mutating methods while excluding the restart request from deadlocking itself");
  {
    const restartGatePos = managerServerSource.indexOf("if (trackMutation && managerRestartInFlight)");
    const mutationRegisterPos = managerServerSource.indexOf("activeManagerMutations.set(mutationId", restartGatePos);
    const admissionReservePos = managerServerSource.indexOf("reserveDirectInstanceMutationAdmission(req, url)", restartGatePos);
    const bodyReadPos = managerServerSource.indexOf("const body = mutatingMethod ? await readBody(req) : {}", restartGatePos);
    const mutationCleanupPos = managerServerSource.indexOf("activeManagerMutations.delete(mutationId)", bodyReadPos);
    assert.ok(restartGatePos >= 0, "HTTP control-plane must reject new mutations after Manager restart handoff begins");
    assert.ok(mutationRegisterPos > restartGatePos, "mutation authority must register only after the restart handoff gate");
    assert.ok(admissionReservePos > restartGatePos && admissionReservePos < bodyReadPos, "direct instance admission order must be reserved before async body parsing");
    assert.ok(mutationRegisterPos < bodyReadPos, "in-flight mutation authority must be registered before async body parsing");
    assert.ok(mutationCleanupPos > bodyReadPos, "in-flight mutation authority must always settle after request dispatch");
    assert.match(managerServerSource.slice(restartGatePos, mutationRegisterPos), /retryable:\s*true/, "restart handoff rejection must remain explicitly retryable");
  }
  assert.match(managerServerSource, /const onError = \(err\) => \{[\s\S]{0,160}?server\.off\("listening", onListening\)[\s\S]{0,180}?const onListening = \(\) => \{[\s\S]{0,160}?server\.off\("error", onError\)[\s\S]{0,220}?server\.once\("error", onError\)[\s\S]{0,120}?server\.once\("listening", onListening\)/, "listenWithRetry must remove its one-shot startup error listener after successful bind instead of swallowing a later HTTP server error");
  {
    const restartStart = managerServerSource.indexOf("async function requestManagerRestart()");
    const restartEnd = managerServerSource.indexOf("\n/* Canonical ChatGPT public contract", restartStart);
    assert.ok(restartStart >= 0 && restartEnd > restartStart, "Manager self-restart boundaries must be discoverable");
    const restartBlock = managerServerSource.slice(restartStart, restartEnd);
    assert.match(restartBlock, /managerRestartInFlight = true;[\s\S]{0,260}?await checkManagerSourceSyntax\(\)[\s\S]{0,220}?if \(!check\.ok\)[\s\S]{0,120}?managerRestartInFlight = false/, "Manager restart must close mutation admission before async syntax preflight and reopen it on syntax failure");
    assert.match(restartBlock, /try \{[\s\S]{0,300}?await atomicWriteFile\([\s\S]{0,120}?MANAGER_RESTART_FILE[\s\S]{0,300}?\} catch \(err\) \{[\s\S]{0,120}?managerRestartInFlight = false/, "Manager restart handoff token persistence must fail closed and keep the current Manager alive");
  }
  assert.doesNotMatch(managerServerSource, /writeFile\(MANAGER_RESTART_FILE[\s\S]{0,180}?\.catch\(\(\) => \{\}\)/, "Manager restart token persistence must never be best-effort/false-green");
  assert.match(managerServerSource, /replacementPid = spawnDetached\([\s\S]{0,420}?isPidAlive\(replacementPid\)[\s\S]{0,900}?const prepared = await waitFor\([\s\S]{0,520}?receipt\.state === "prepared"[\s\S]{0,240}?Number\(receipt\.replacementPid\) === replacementPid[\s\S]{0,700}?if \(!prepared \|\| !isPidAlive\(replacementPid\)\)/, "Manager must require an exact prepared replacement receipt before beginning listener handoff");
  assert.match(managerServerSource, /const reopenOldListener = async \(\) =>[\s\S]{0,900}?httpServer\.listen\(managerPortNum, "127\.0\.0\.1"\)[\s\S]{0,1200}?httpServer\.close[\s\S]{0,1000}?receipt\.state === "listening"[\s\S]{0,240}?Number\(receipt\.replacementPid\) === replacementPid[\s\S]{0,420}?if \(listening && isPidAlive\(replacementPid\)\) \{[\s\S]{0,100}?process\.exit\(0\)/, "old Manager must exit only after exact replacement canonical-port listening proof and retain an old-listener rollback path");
  assert.match(managerServerSource, /if \(isPidAlive\(replacementPid\)\)[\s\S]{0,260}?killPidTree\(replacementPid\)[\s\S]{0,320}?managerRestartInFlight = false;[\s\S]{0,180}?await reopenOldListener\(\)[\s\S]{0,220}?Replacement never proved canonical-port ownership/, "failed replacement bind handoff must kill only the replacement, clear the restart gate and re-open the old Manager listener");
  assert.match(managerServerSource, /return \{ ok: true, pid: process\.pid, replacementPid, handoffPending: true \}/, "Manager restart API must distinguish spawned/prepared handoff from completed listener ownership");
  assert.match(managerServerSource, /httpServer = server;[\s\S]{0,160}?if \(restartToken\)[\s\S]{0,420}?atomicWriteFile\([\s\S]{0,120}?MANAGER_RESTART_FILE[\s\S]{0,360}?state: "prepared"[\s\S]{0,180}?replacementPid: process\.pid[\s\S]{0,420}?async function listenWithRetry/, "replacement Manager must atomically persist its prepared PID receipt after pre-listen initialization and before bind handoff");
  assert.match(managerServerSource, /await listenWithRetry\(port, noOpen, restartToken\);[\s\S]{0,120}?if \(restartToken\)[\s\S]{0,520}?state: "listening"[\s\S]{0,180}?replacementPid: process\.pid[\s\S]{0,180}?listeningAt: Date\.now\(\)/, "replacement Manager must atomically publish exact canonical-port listening ownership after bind succeeds");
  assert.match(managerServerSource, /async function startServer\(name\)[\s\S]{0,180}?if \(managerRestartInFlight\)/, "Server lifecycle must reject new work after restart handoff begins");
  assert.match(managerServerSource, /async function startTunnel\(name\)[\s\S]{0,180}?if \(managerRestartInFlight\)/, "Tunnel lifecycle must reject new work after restart handoff begins");
  assert.match(managerServerSource, /TUNNEL_CLIENT_VERSION_FILE/, "Manager must track the installed tunnel-client version for auto-upgrade");
  assert.match(managerServerSource, /tunnel-client-\$\{OPENAI_TUNNEL_VERSION\}\.zip/, "Manager must retain a versioned tunnel-client zip cache instead of deleting it");
  assert.doesNotMatch(managerServerSource, /fsp\.rm\(tmpZip/, "tunnel-client install must not permanently delete its download");
  assert.match(managerTunnelRuntimeSource, /OPENAI_TUNNEL_VERSION = "v0\.0\.11"/, "tunnel runtime authority must pin tunnel-client v0.0.11");
  assert.match(managerTunnelRuntimeSource, /OPENAI_TUNNEL_LAZY_CODEX_SOURCE_SHA = "8d55683eeef80bc5e360d95abf4692454fafc615"/, "patched tunnel runtime must pin the exact upstream source commit");
  assert.match(managerTunnelRuntimeSource, /OPENAI_TUNNEL_LAZY_CODEX_BINARY_SHA256 = "c900f09edba10115a17f937fb3b101e9e35e58b342d3c92f59f9f6f9b9166494"/, "patched tunnel runtime must pin the exact reproducible production binary digest");
  assert.match(managerTunnelRuntimeSource, /binary-hash-mismatch/, "patched tunnel runtime must verify executable content identity instead of trusting marker presence");
  assert.match(tunnelBuilderSource, /\$goVersion = "1\.26\.2"[\s\S]{0,7000}?Explicit Go executable must be exactly Go \$\{goVersion\}[\s\S]{0,12000}?Patched tunnel-client SHA256 mismatch/, "patched runtime builder must pin both Go toolchain version and final binary digest before publication");
  assert.match(managerServerSource, /if \(IS_WIN\) return await finalizeTunnelClientRuntime\(null\);/, "Windows tunnel startup must bypass the official binary path and require patched runtime authority");
  assert.match(managerServerSource, /failClosed:\s*true/, "Windows patched-runtime failure must fail closed instead of falling back to official tunnel-client");
  assert.match(managerServerSource, /void autoStartInstances\(autoStartNames,[\s\S]{0,520}?concurrency:\s*DEFAULT_AUTO_START_CONCURRENCY[\s\S]{0,520}?startServer,[\s\S]{0,220}?startTunnel/, "autostart must use the bounded independent instance supervisor instead of the old serial one-shot loop");
  assert.match(managerServerSource, /shouldContinue:\s*async \(name\) => !managerRestartInFlight && !cancelledBootAutoStart\.has\(name\)/, "boot retries must stop before self-restart and be cancelled by explicit lifecycle authority");
  assert.match(managerServerSource, /async function stopServer\(name\)[\s\S]{0,120}?cancelledBootAutoStart\.add\(name\)/, "explicit Server Stop must cancel pending boot reconciliation");
  assert.match(managerServerSource, /async function stopTunnel\(name\)[\s\S]{0,120}?cancelledBootAutoStart\.add\(name\)/, "explicit Tunnel Stop must cancel pending boot reconciliation");
  assert.match(managerServerSource, /Refusing to stop an unowned .*tunnel/i, "Tunnel stop must fail closed for unowned processes");
  assert.doesNotMatch(managerServerSource, /pidsWithCmdLine\(profileFile\)/, "Tunnel cleanup must include an executable identity and never call the process scanner with only a profile path");
  assert.match(managerServerSource, /processesWithCmdLineAsync\("tunnel-client\.exe", profileFile\)/, "OpenAI tunnel identity lookup must scope asynchronous discovery by executable plus the instance-unique profile");
  assert.match(managerServerSource, /if \(stopped\) \{[\s\S]{0,180}?writePidFile\(inst\.serverPid, null\)[\s\S]{0,180}?clearServerLaunchEvidence/, "failed Local Coder Server startup must preserve PID/launch metadata until the child is confirmed stopped, then clear both together");
  assert.match(managerServerSource, /LEGACY_INSTANCE_MIGRATION_PATH = path\.join\(STATE_DIR, "legacy-instance-migration-v1\.json"\)/, "legacy instance migration must have a durable one-time tombstone so intentional zero-instance state survives restart");
  assert.match(managerServerSource, /if \(existingInstances\.length > 0\)[\s\S]{0,160}?if \(migrationComplete\) return;[\s\S]{0,1200}?reason: "managed-instances-present"/, "existing managed instances must establish migration completion before zero-instance state can later become authoritative");
  assert.match(managerServerSource, /async function readLegacyInstanceMigrationReceipt\([\s\S]{0,900}?receipt\.version !== 1[\s\S]{0,260}?\["prepared", "complete"\]\.includes\(receipt\.state\)[\s\S]{0,300}?LEGACY_INSTANCE_MIGRATION_RECEIPT_INVALID/, "legacy migration receipt must be versioned/stateful and corrupt receipts must fail closed");
  assert.match(managerServerSource, /const stageDir = path\.join\(INSTANCES_DIR, `\.legacy-default-migration-\$\{migrationId\}`\)/, "legacy migration must stage outside the managed instance-name namespace");
  assert.match(managerServerSource, /atomicWriteFile\([\s\S]{0,120}?staged\.marker[\s\S]{0,260}?migrationId[\s\S]{0,180}?source: "legacy-single-instance"/, "legacy migration stage must carry an exact migration identity marker");
  assert.match(managerServerSource, /writeLegacyInstanceMigrationReceipt\(\{[\s\S]{0,180}?state: "prepared"[\s\S]{0,220}?reason: "legacy-default-stage-ready"[\s\S]{0,220}?fsp\.rename\(stageDir, inst\.dir\)/, "legacy migration must persist prepared authority before atomically publishing default");
  assert.match(managerServerSource, /fsp\.rename\(stageDir, inst\.dir\)[\s\S]{0,220}?writeLegacyInstanceMigrationReceipt\(\{[\s\S]{0,160}?state: "complete"/, "legacy migration may become complete only after the staged directory is atomically published");
  assert.match(managerServerSource, /const migrationStages = await listLegacyMigrationStages\(\)[\s\S]{0,1300}?legacy-default-migrated-stage-recovered[\s\S]{0,1600}?LEGACY_INSTANCE_MIGRATION_ORPHAN_STAGE[\s\S]{0,1300}?legacy-default-migrated-stage-recovered-without-receipt/, "legacy migration must recover exact prepared/orphan marked stages and fail closed on ambiguous or partial stages");
  assert.match(managerServerSource, /err\?\.code !== "ENOENT"[\s\S]{0,220}?Legacy lifecycle authority migration failed/, "legacy PID authority migration must ignore only absence and fail closed on other copy errors");
  assert.match(managerServerSource, /Legacy diagnostic log copy skipped/, "legacy diagnostic-log migration failures must be surfaced without blocking lifecycle authority migration");
  assert.match(managerServerSource, /async function readJson\(p, fallback\)[\s\S]{0,460}?err\?\.code === "ENOENT"[\s\S]{0,360}?MANAGER_JSON_INVALID/, "managed JSON authority must fallback only when missing and reject malformed bytes");
  assert.match(managerServerSource, /async function readPidFile\(p\)[\s\S]{0,420}?err\?\.code === "ENOENT"[\s\S]{0,360}?MANAGER_PID_INVALID/, "managed PID authority must distinguish missing from malformed or unreadable ledger bytes");
  assert.match(managerServerSource, /async function readInstanceConfig\(name\)[\s\S]{0,420}?autoStart: false/, "missing managed config must default autostart to safe false");
  assert.match(managerServerSource, /function publicInstanceConfig\(config\)[\s\S]{0,180}?autoStart: config\?\.autoStart === true/, "public managed config must expose autostart only for explicit true authority");
  assert.match(managerServerSource, /if \(!fs\.existsSync\(instPaths\(name\)\.config\)\) continue;/, "legacy config cleanup must never create a missing managed config and accidentally grant autostart authority");
  assert.match(managerServerSource, /Cannot save instance environment while config authority is unreadable[\s\S]{0,520}?committed: false/, "env save must preflight companion config authority before committing .env");
  assert.match(managerServerSource, /updateInstanceConfig\(name, \(config\) => \{[\s\S]{0,180}?config\.healthPort = hp;[\s\S]{0,180}?body\.autoStart[\s\S]{0,700}?atomicWriteFile\(inst\.env, original[\s\S]{0,500}?rollbackFailed: Boolean\(rollbackError\)/, "logical env+healthPort+autoStart save must rollback exact prior .env bytes when companion config sync fails");
  assert.match(managerServerSource, /async function proveInstanceInactiveWithoutConfig\([\s\S]{0,1800}?Promise\.all\(\[[\s\S]{0,500}?processesWithCmdLineAsync\("tunnel-client\.exe", inst\.profile\)[\s\S]{0,500}?processesWithCmdLineAsync\("cloudflared\.exe", `localhost:\$\{serverPort\}`\)[\s\S]{0,900}?openAiCandidates\.length > 0[\s\S]{0,700}?cloudflareCandidates\.length > 0[\s\S]{0,700}?OPENAI_TUNNEL_HEALTH_PORT[\s\S]{0,500}?await isPortOpen\(healthPort\)[\s\S]{0,320}?return \{ ok: true \}/, "corrupt-config delete/rename recovery must asynchronously prove that server/tunnel candidates and tunnel health listener are all absent");
  assert.match(managerServerSource, /async function isExactCurrentServerProcess\(pid\)[\s\S]{0,520}?await processesWithCmdLineAsync\("node\.exe", SERVER_ENTRY\)/, "missing server.pid recovery must asynchronously prove the exact current repo compiled child command line");
  assert.match(managerServerSource, /async function isPidDefinitelyDead\(pid\)[\s\S]{0,1900}?spawn\([\s\S]{0,180}?"powershell\.exe"[\s\S]{0,500}?Get-CimInstance Win32_Process[\s\S]{0,1000}?finish\(false\)[\s\S]{0,500}?5000/, "Windows PID-ledger recovery must use a bounded non-blocking second OS process-table proof and fail closed when deadness cannot be confirmed");
  assert.match(managerServerSource, /const savedPidAlive = Boolean\(savedPid && isPidAlive\(savedPid\)\)[\s\S]{0,220}?const savedPidDefinitelyDead = Boolean\(savedPid && !savedPidAlive && \(await isPidDefinitelyDead\(savedPid\)\)\)[\s\S]{0,220}?if \(\(!savedPid \|\| savedPidDefinitelyDead\) && !desiredEnv && isLocalCoderHealth\(health, env, name\)\)[\s\S]{0,1000}?portPid === healthPid && await isExactCurrentServerProcess\(healthPid\)[\s\S]{0,220}?writePidFile\(inst\.serverPid, healthPid\)/, "Manager must reconstruct only missing/definitely-dead server.pid from exact instance/workspace/health/listener/current-process evidence and never overwrite a live or uncertain mismatched ledger");
  assert.match(managerServerSource, /owned:\s*exactManagedRuntime \|\| legacyOwnedListener/, "current Server ownership must require exact health PID identity; missing listener scan data must never make a saved PID owned");
  assert.match(managerServerSource, /function runNetstatListenerScan\(timeoutMs\)[\s\S]{0,900}?spawn\("netstat"[\s\S]{0,1700}?timed out after \$\{timeoutMs\}ms/, "listener PID discovery must use bounded non-blocking netstat child I/O");
  assert.match(managerServerSource, /async function listeningPortPids\(\)[\s\S]{0,700}?const scanTimeouts = \[3000, 6000, 10000\][\s\S]{0,900}?for \(let attempt = 0; attempt < scanTimeouts\.length; attempt\+\+\)[\s\S]{0,700}?out === null[\s\S]{0,220}?PROCESS_PORT_SCAN_FAILED/, "listener ownership discovery must tolerate transient netstat timeouts with bounded asynchronous retries while still failing closed after exhaustion");
  assert.match(managerServerSource, /portPidScanInFlight\?\.generation === generation[\s\S]{0,1600}?generation === portPidScanGeneration[\s\S]{0,180}?portPidCache = \{ at: Date\.now\(\), pids \}/, "listener scans must coalesce per lifecycle generation and prevent stale in-flight observations from repopulating cache after invalidation");
  assert.doesNotMatch(managerServerSource, /spawnSync\(/, "Manager control-plane must never block its event loop on synchronous subprocesses");
  assert.match(managerServerSource, /async function killPidTree\(pid\)[\s\S]{0,500}?await runBoundedHelperProcess\(IS_WIN \? "taskkill" : "kill"/, "process-tree termination must use bounded asynchronous subprocess I/O");
  assert.match(managerServerSource, /async function ensureFolderPicker\(\)[\s\S]{0,1000}?await runBoundedHelperProcess\(CSC_PATH[\s\S]{0,300}?timeoutMs: 30000/, "folder-picker compilation must not block the Manager event loop");
  assert.match(managerServerSource, /if \(p === "\/api\/autostart"\)[\s\S]{0,500}?const state = await inspectAutostartLink\(\)[\s\S]{0,1800}?await runBoundedHelperProcess\([\s\S]{0,900}?const verification = await inspectAutostartLink\(\)/, "autostart GET/create/verification must await asynchronous shortcut authority instead of reading Promise properties");
  assert.doesNotMatch(managerServerSource, /function listeningPortPids\(\)[\s\S]{0,900}?catch\s*\{\}/, "listener ownership scan must not swallow netstat errors");
  assert.match(managerSafeDeleteSource, /Add-Type -AssemblyName Microsoft\.VisualBasic[\s\S]{0,500}?DeleteDirectory\([\s\S]{0,500}?SendToRecycleBin/, "managed instance deletion must use the precompiled framework Recycle Bin API instead of compiling C# during an HTTP request");
  assert.doesNotMatch(managerSafeDeleteSource, /^\s*Add-Type -TypeDefinition/m, "managed deletion must not reintroduce per-request C# compilation latency");
  assert.match(managerSafeDeleteSource, /RECYCLE_TIMEOUT_MS = 15_000[\s\S]{0,2200}?child\.kill\("SIGKILL"\)[\s\S]{0,220}?Recycle Bin operation timed out/, "Recycle Bin helper must remain bounded and fail closed on a hung Windows Shell operation");
  assert.match(managerServerSource, /if \(st\.running && !st\.owned\)[\s\S]{0,260}?refusing false-green start\/adoption/, "Server start must fail closed for a running runtime whose exact ownership cannot be proven");
  assert.match(managerServerSource, /readFile\(TUNNEL_CLIENT_VERSION_FILE[\s\S]{0,220}?err\?\.code !== "ENOENT"[\s\S]{0,220}?Không đọc được tunnel-client version marker/, "tunnel-client version authority must ignore only a missing marker and surface other read failures");
  assert.match(managerServerSource, /let rollbackError = null[\s\S]{0,520}?rollbackError = String\(rollbackErr\?\.message \|\| rollbackErr\)[\s\S]{0,520}?rollbackFailed:\s*Boolean\(rollbackError\)[\s\S]{0,180}?backupPath:\s*rollbackError \? backupPath : null/, "tunnel-client failed-install rollback must surface rollback failure and retained backup path instead of swallowing it");
  assert.match(managerServerSource, /if \(stopped\) \{[\s\S]{0,220}?writePidFile\(inst\.tunnelPid, null\)[\s\S]{0,420}?else \{[\s\S]{0,420}?writePidFile\(inst\.tunnelPid, pid\)/, "failed tunnel startup must clear PID only after confirmed exit and preserve exact PID evidence for a survivor");
  assert.match(managerServerSource, /chatgpt-local-coder\.bat/, "Manager autostart must reference the single consolidated launcher bat");
  assert.match(managerServerSource, /function inspectAutostartLink[\s\S]{0,3000}?expectedLauncher[\s\S]{0,900}?expectedWork[\s\S]{0,900}?expectedArguments[\s\S]{0,900}?StringComparison\]::OrdinalIgnoreCase/, "Manager autostart status must validate exact current-repo launcher + working-directory + full argument identity instead of trusting LNK existence/basename");
  assert.match(managerServerSource, /String\.Comparison|StringComparison/, "Manager shortcut verifier must use case-insensitive exact identity comparison");
  assert.match(managerServerSource, /Equals\(\$s\.Arguments,\$expectedArguments,\[StringComparison\]::OrdinalIgnoreCase\)/, "Manager autostart verifier must compare the complete shortcut arguments rather than accept an executable substring");
  assert.match(launcherSource, /:ensure_autostart[\s\S]{0,2200}?\$ErrorActionPreference='Stop'[\s\S]{0,1200}?if errorlevel 1[\s\S]{0,900}?\$ErrorActionPreference='Stop'/, "batch autostart creation and verification must fail fast on PowerShell errors instead of reporting false success after non-terminating errors");
  assert.match(launcherSource, /\$singleQuote=\[string\]\[char\]39[\s\S]{0,900}?\.Replace\(\$singleQuote,\(\$singleQuote\+\$singleQuote\)\)/, "batch autostart launcher quoting must use the string Replace overload so apostrophe escaping cannot silently erase the launcher path");
  assert.match(managerServerSource, /enabled:\s*state\.valid[\s\S]{0,180}?drift:\s*state\.exists && !state\.valid/, "Manager autostart GET must surface stale shortcut drift instead of false-green enabled=true");
  assert.doesNotMatch(managerServerSource, /make-startup-lnk\.ps1|manager-hidden\.ps1/, "autostart must not create auxiliary PowerShell launcher files");
  assert.match(managerServerSource, /workspaceScope\.ok/, "instance bundle must expose workspace-scope validation for self-detection");
  assert.match(managerApp, /!i\.workspaceScope \|\| !i\.workspaceScope\.ok/, "workspace card must surface an invalid workspace scope instead of false-green");
  assert.match(managerApp, /\/server\/restart/);
  assert.match(managerApp, /splitExtraWorkspacePaths/);
  assert.match(managerApp, /\.split\(";"\)/);
  assert.match(managerApp, /extraRoots\.join\("; "\)/, "EXTRA_WORKSPACE_PATHS must render as one semicolon-separated line");
  assert.match(
    managerApp,
    /rawDirty = false;[\s\S]{0,900}?\$\("f-raw"\)\.value = Object\.entries[\s\S]{0,320}?rawDirty = false;/,
    "loading/switching an instance must clear stale raw-editor authority before Save",
  );
  assert.match(
    managerApp,
    /\$\("f-raw"\)\.addEventListener\("input", \(\) => \{[\s\S]{0,180}?syncStructuredFormFromRaw\(\)/,
    "raw env edits must synchronize the structured form so Check and Save see the same workspace authority",
  );
  assert.match(
    managerApp,
    /for \(const id of Object\.keys\(FIELD_ENV\)\) \{[\s\S]{0,260}?syncRawFromStructuredForm\(\)/,
    "structured form edits must synchronize the raw env editor before raw-mode Save",
  );
  assert.match(
    managerApp,
    /function syncRawFromStructuredForm\(\)[\s\S]{0,360}?for \(const \[id, key\] of Object\.entries\(FIELD_ENV\)\)[\s\S]{0,220}?mergeRawEditorValues\(raw\.value, values\)/,
    "structured FULL_DISK_ACCESS/WORKSPACE_PATH values must become the raw Save payload instead of stale values",
  );
  assert.match(
    managerApp,
    /function currentEditorPayload\(\)[\s\S]{0,900}?if \(!rawDirty\) return \{ values: collectValues\(\) \}[\s\S]{0,500}?OPENAI_TUNNEL_API_KEY:\s*tunnelKey[\s\S]{0,240}?return \{ raw \}/,
    "raw-mode Check/Save must overlay a newly typed tunnel key without exposing it in the Raw editor",
  );
  assert.match(managerApp, /\/check"\), "POST", currentEditorPayload\(\)/, "Check must use the exact same payload constructor as Save");
  assert.match(managerApp, /const body = currentEditorPayload\(\)/, "Save must use the same raw/form authority payload as Check");
  assert.match(managerApp, /\$\("f-autostart"\)\.checked = cfg\.autoStart === true;/, "UI must render autostart only from explicit true authority, matching the backend fail-safe contract");
  assert.match(managerApp, /const body = currentEditorPayload\(\);[\s\S]{0,120}?body\.autoStart = \$\("f-autostart"\)\.checked;[\s\S]{0,180}?\/env"\), "PUT", body/, "UI Save must send env and autoStart through one logical backend mutation");
  assert.doesNotMatch(managerApp, /async function doSave\(\)[\s\S]{0,1000}?\/config"\), "PUT"/, "UI Save must not false-transactionally commit env and then save autoStart in a second request");
  assert.match(managerApp, /let saveCommitted = false;[\s\S]{0,500}?saveCommitted = true;[\s\S]{0,1500}?toast\("Đã lưu", "ok"\)[\s\S]{0,500}?Đã lưu, nhưng thao tác sau lưu lỗi:/, "UI must distinguish successful save from failures that happen only after configuration commit");
  assert.match(managerServerSource, /function restoreMaskedRawEnv[\s\S]{0,420}?isSecretKey\(m\[1\]\)/, "raw sentinel restoration must be restricted to actual secret keys");
  assert.match(managerServerSource, /async function checkConfigRequest[\s\S]{0,360}?restoreMaskedRawEnv\(body\.raw, originalValues\)[\s\S]{0,120}?checkConfig\(name, parseDotEnv\(candidateRaw\)\)/, "raw-mode Check must resolve masked secrets with the same semantics as raw-mode Save");
  assert.match(managerServerSource, /p === "\/api\/check"[\s\S]{0,100}?checkConfigRequest\(dname, body\)/, "legacy /api/check must use the same raw/form request semantics as the instance route");
  assert.doesNotMatch(managerApp, /WORKSPACE_PATH chỉ được chứa 1 project/, "Manager UI must not contradict collection-root workspace authority");
  assert.match(managerApp, /root có thể là project, monorepo hoặc collection root/, "Manager add-workspace guidance must describe supported collection roots");
  assert.match(managerApp, /FULL_DISK_ACCESS=true:[\s\S]{0,160}?filesystem authority là full machine/, "workspace guide must not claim root confinement in trusted full-disk mode");
  assert.match(managerApp, /FULL_DISK_ACCESS=false:[\s\S]{0,160}?giới hạn trong các root/, "workspace guide must explain strict root confinement");
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
  assert.match(managerServerSource, /function isExactManagedRuntimeHealth[\s\S]{0,420}?isManagedInstanceHealth\(health, name\)[\s\S]{0,220}?health\?\.pid[\s\S]{0,180}?healthPid === savedPid/, "current runtime health PID must provide exact ownership proof independent of transient netstat cache state");
  assert.match(managerServerSource, /health = await serverHealth\(configuredPort\);[\s\S]{0,120}?if \(health\) portOpen = true/, "configured-port health identity must not be skipped because a separate TCP snapshot briefly reports closed");
  assert.match(managerServerSource, /if \(!health && portOpen\)[\s\S]{0,900}?for \(let attempt = 0; attempt < 3 && !health; attempt \+= 1\)[\s\S]{0,260}?health = await serverHealth\(configuredPort\)/, "configured listener health retries must remain available when server.pid is missing so exact crash-window recovery can prove identity");
  assert.match(managerServerSource, /currentHealthPid = Number\(health\?\.pid\)[\s\S]{0,700}?portPid !== currentHealthPid[\s\S]{0,420}?invalidatePortPidCache\(\)[\s\S]{0,180}?portPid = await pidOnPort\(configuredPort\)/, "managed instance health must asynchronously refresh listener ownership toward health.pid, never toward a possibly stale server.pid ledger");
  assert.match(managerServerSource, /const legacyOwnedListener = Boolean\([\s\S]{0,180}?!String\(health\?\.instance_id \|\| ""\)\.trim\(\)[\s\S]{0,220}?portPid === savedPid[\s\S]{0,120}?isPidAlive\(savedPid\)/, "legacy listener ownership must be impossible for current identity-bearing health responses");
  assert.match(managerServerSource, /const currentManagedListener = Boolean\([\s\S]{0,320}?portPid === currentHealthPid[\s\S]{0,220}?isManagedInstanceHealth\(health, name\)/, "current destructive ownership/listener proof must require exact health.pid == listener PID independently from the server.pid ledger");
  assert.match(managerServerSource, /const currentManagedHealth = Boolean\([\s\S]{0,220}?portOpen[\s\S]{0,220}?currentHealthPidAlive[\s\S]{0,220}?isManagedInstanceHealth\(health, name\)[\s\S]{0,260}?const exactManagedRuntime = Boolean\([\s\S]{0,180}?currentManagedListener/, "current identity-bearing health may prove liveness during transient listener-scan drift, while exact ownership must still depend on currentManagedListener");
  assert.match(managerServerSource, /currentManagedHealth \|\| legacyOwnedListener[\s\S]{0,700}?configDrift:\s*true[\s\S]{0,160}?workspaceDrift:\s*true[\s\S]{0,500}?owned:\s*exactManagedRuntime \|\| legacyOwnedListener/, "workspace drift must keep a proven live runtime visible without granting destructive ownership from health-only evidence");
  assert.match(managerServerSource, /isLocalCoderHealth\(health, env, name, \{ allowLegacy: legacyOwnedListener \}\)/, "configured-port legacy recovery must be gated by the saved-PID listener proof");
  {
    const launchEvidenceStart = managerServerSource.indexOf("async function readServerLaunchEvidence(name)");
    const launchEvidenceEnd = managerServerSource.indexOf("async function tryUpdateServerLaunchEvidence", launchEvidenceStart);
    const launchEvidenceReader = launchEvidenceStart >= 0 && launchEvidenceEnd > launchEvidenceStart
      ? managerServerSource.slice(launchEvidenceStart, launchEvidenceEnd)
      : "";
    assert.match(launchEvidenceReader, /const config = await readInstanceConfig\(name\)/, "Server launch evidence may read auxiliary config only through an isolated optional reader");
    assert.match(launchEvidenceReader, /serverLaunchPid: Number\(config\?\.serverLaunchPid\) \|\| null[\s\S]*serverLaunchPort: Number\(config\?\.serverLaunchPort\) \|\| null/, "optional launch evidence must carry both persisted PID and port hints when config is readable");
    assert.match(launchEvidenceReader, /catch \(err\)[\s\S]*serverLaunchPid: null[\s\S]*serverLaunchPort: null[\s\S]*available: false/, "corrupt auxiliary config must collapse to null non-authorizing launch evidence rather than block Gateway lifecycle");
  }
  assert.match(managerServerSource, /const launchEvidencePid = Number\(launchEvidence\.serverLaunchPid\)[\s\S]{0,220}?const launchEvidencePort = Number\(launchEvidence\.serverLaunchPort\)[\s\S]{0,360}?launchEvidencePid === savedPid/, "PORT-drift liveness discovery must bind optional persisted launch port evidence to the exact saved server PID");
  assert.match(managerServerSource, /const actualPortCandidates = \[[\s\S]{0,180}?launchEvidencePortValid[\s\S]{0,180}?\.\.\.listenerPorts[\s\S]{0,520}?isExactManagedRuntimeHealth\(actualHealth, name, savedPid\)/, "PORT-drift recovery must probe secret-safe launch evidence before relying only on transient listener enumeration");
  assert.match(managerServerSource, /const legacyOwnedListener = Boolean\([\s\S]{0,180}?!String\(actualHealth\?\.instance_id \|\| ""\)\.trim\(\)[\s\S]{0,180}?actualPortPid === savedPid[\s\S]{0,180}?allowLegacy: true/, "PORT-drift legacy bridge must remain listener-PID-proof-only");
  assert.match(managerServerSource, /running:\s*true,[\s\S]{0,620}?portDrift:\s*true[\s\S]{0,520}?owned:\s*actualPortPid === savedPid && \(exactCurrentIdentity \|\| legacyOwnedListener\)/, "PORT-drift health evidence may preserve liveness but must never grant destructive ownership without exact listener PID proof");
  assert.match(managerServerSource, /writePidFile\(inst\.serverPid, pid\)[\s\S]{0,420}?config\.serverLaunchPid = pid[\s\S]{0,120}?config\.serverLaunchPort = port/, "managed Server launch must persist discovery-only PID+port evidence with the PID ledger");
  assert.match(managerServerSource, /function clearServerLaunchEvidence[\s\S]{0,180}?serverLaunchPid[\s\S]{0,120}?serverLaunchPort/, "Server launch evidence must have an explicit cleanup owner");
  assert.match(managerServerSource, /SERVER_START_TIMEOUT_TRUSTED_MS = 120000/, "trusted Windows cold-start must not be killed by the former 20-second startup deadline");
  assert.match(managerServerSource, /SERVER_START_TIMEOUT_STRICT_MS = 180000/, "strict AppContainer startup must have a bounded prepare/self-test window larger than trusted startup");
  assert.match(managerServerSource, /if \(!isPidAlive\(pid\)\)[\s\S]{0,220}?startupState = "exited"[\s\S]{0,420}?isLocalCoderHealth\(await serverHealth\(port\), env, name\)/, "startup wait must stop early on process exit while still requiring strict instance identity on the preflight-resolved desired port");
  assert.match(managerServerSource, /if \(startupState !== "healthy" && isPidAlive\(pid\)\)[\s\S]{0,220}?finalHealth = await serverHealth\(port\)[\s\S]{0,220}?startupState = "healthy"/, "startup timeout boundary must perform one exact final health check on the preflight-resolved desired port before killing the child");
  assert.match(managerServerSource, /const startupLogMarker = `\[manager-start\] attempt=\$\{startupAttemptId\}`/, "startup logs must contain an attempt-scoped marker so failure diagnostics cannot be confused with stale historical log lines");
  assert.match(managerServerSource, /tail\.lastIndexOf\(startupLogMarker\)[\s\S]{0,180}?tail\.slice\(markerOffset\)/, "startup failure diagnostics must slice the log from the current attempt marker instead of exposing stale historical tail lines");
  assert.match(managerServerSource, /startupElapsedMs[\s\S]{0,260}?pidAliveAtDeadline[\s\S]{0,260}?portOpenAtDeadline/, "startup failure must expose deadline diagnostics instead of a generic false-negative message");
  assert.match(managerServerSource, /fetch\(`http:\/\/127\.0\.0\.1:\$\{port\}\/healthz`[\s\S]{0,260}?fetch\(`http:\/\/127\.0\.0\.1:\$\{port\}\/readyz`/, "managed OpenAI Tunnel health must require both tunnel-client liveness and readiness endpoints");
  assert.match(managerServerSource, /liveText\.trim\(\)\.toLowerCase\(\) === "live"[\s\S]{0,180}?readyText\.trim\(\)\.toLowerCase\(\) === "ready"/, "managed OpenAI Tunnel health must validate the tunnel-client endpoint bodies, not only HTTP 200");
  assert.match(managerServerSource, /async function tunnelClientHealth\(port\)[\s\S]{0,700}?attempt < 3[\s\S]{0,320}?tunnelClientHealthOnce\(port\)/, "managed tunnel health classification must retry bounded transient local probe failures instead of producing one-shot false health drift");
  assert.match(managerServerSource, /async function ensureSandboxCompatibility[\s\S]{0,900}?checkSandboxCompatibilityUnlocked\(name, env, inst\)[\s\S]{0,220}?if \(!check\.requiresSetup\) return check[\s\S]{0,900}?SANDBOX_COMPAT_SETUP_TIMEOUT_MS[\s\S]{0,900}?\["--check"\][\s\S]{0,180}?SANDBOX_COMPAT_CHECK_TIMEOUT_MS/, "strict managed startup must reuse check-only AppContainer preflight, prepare it only when stale, then verify the marker");
  {
    const migratePos = managerServerSource.indexOf("await migrateLegacyRuntimeState(name, env, inst);");
    const compatibilityPos = managerServerSource.indexOf("ensureSandboxCompatibility(name, env, inst)", migratePos);
    const spawnPos = managerServerSource.indexOf("spawnDetached(process.execPath", compatibilityPos);
    assert.ok(migratePos >= 0 && compatibilityPos > migratePos && spawnPos > compatibilityPos, "strict compatibility must be established before the managed Local Coder child is spawned");
  }
  assert.match(managerServerSource, /for \(const key of Object\.keys\(childEnv\)\)[\s\S]{0,160}?isSecretKey\(key\)[\s\S]{0,320}?WORKSPACE_PATH/, "sandbox compatibility setup must not inherit instance secrets when it may invoke UAC");
  assert.match(sandboxSetupSource, /sandbox-compat-\$\{instanceId\(\)\}\.json/, "sandbox compatibility must use an instance-scoped durable marker");
  assert.match(sandboxSetupSource, /process\.argv\.includes\("--check"\)[\s\S]{0,420}?compatibilityStateMatches/, "sandbox compatibility helper must support a non-elevating marker preflight");
  assert.match(sandboxSetupSource, /const desiredCompatibilityState = \{[\s\S]{0,700}?version:\s*3,[\s\S]{0,700}?runnerArtifact:\s*path\.basename\(runner\)/, "sandbox compatibility marker must be invalidated when the content-versioned broker artifact changes");
  assert.match(sandboxSetupSource, /recorded\?\.runnerArtifact === desired\.runnerArtifact/, "sandbox compatibility check must compare the recorded broker artifact identity");
  assert.match(sandboxSetupSource, /os\.uptime\(\)[\s\S]{0,520}?recordedAt >= currentBootStartedAtMs\(\) - 5000/, "NUL kernel-object compatibility must be invalidated across Windows reboot instead of trusting a durable false-green receipt");
  assert.match(sandboxSetupSource, /recordCompatibilityState\(desiredCompatibilityState\)/, "successful compatibility setup must persist the verified fingerprint marker");
  assert.match(runtimeEntrySource, /instance_id:\s*process\.env\.LOCAL_CODER_INSTANCE_ID \|\| process\.env\.MCP_INSTANCE_NAME \|\| null/, "Local Coder /health must expose the Manager-injected instance identity without inventing one for direct launches");
  assert.match(runtimeEntrySource, /pid:\s*process\.pid/, "Local Coder /health must expose its actual PID so Manager can prove current-build ownership during config drift");
  assert.match(runtimeEntrySource, /processSecurity\.sandbox_self_test !== "passed"[\s\S]{0,260}?OS_SANDBOX_STARTUP_FAILED/, "strict Local Coder startup must fail closed before listening when process sandbox proof fails");
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
  const managedStartConfig = JSON.parse(await fs.readFile(path.join(restartDemo, "config.json"), "utf8"));
  assert.equal(managedStartConfig.serverLaunchPid, managedStart.pid, "managed Server launch evidence must bind to the exact spawned PID");
  assert.equal(managedStartConfig.serverLaunchPort, restartServerPort, "managed Server launch evidence must record the serving port, not a future desired port");
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

  // Simulate the exact Manager-crash window where the Local Coder child is live
  // but server.pid was never/was no longer persisted. Current health identity,
  // listener PID and exact CURRENT dist/index.js command line must reconstruct
  // the ledger without restarting or adopting an unrelated process.
  const restartPidPath = path.join(restartDemo, "server.pid");
  await fs.rm(restartPidPath, { force: true });
  assert.equal(await fs.stat(restartPidPath).then(() => true, () => false), false, "fault injection failed to remove server.pid");
  const recoveredPidListing = (await api("/api/instances")).body.instances.find((x) => x.name === "restart-demo");
  assert.equal(recoveredPidListing.server.running, true, "live current runtime must remain visible while recovering missing server.pid");
  assert.equal(recoveredPidListing.server.owned, true, "exact current runtime identity must recover managed ownership after missing server.pid");
  assert.equal(recoveredPidListing.server.pid, managedRestart.pid, "server.pid recovery must keep the existing exact process rather than restart it");
  assert.equal(Number((await fs.readFile(restartPidPath, "utf8")).trim()), managedRestart.pid, "server.pid recovery must persist the exact recovered PID");
  const recoveredPidStart = (await post("/api/instances/restart-demo/server/start")).body;
  assert.equal(recoveredPidStart.ok, true, `start after PID-ledger recovery must be idempotent: ${JSON.stringify(recoveredPidStart)}`);
  assert.equal(recoveredPidStart.alreadyRunning, true, "start after exact PID-ledger recovery must not spawn a duplicate runtime");
  assert.equal(recoveredPidStart.pid, managedRestart.pid, "idempotent start after PID recovery must preserve the existing PID");

  // A live but mismatched PID ledger is materially different from a missing/dead
  // ledger: never overwrite it automatically. Surface the actual healthy runtime
  // as unowned and refuse a duplicate start until ownership is explicitly repaired.
  assert.notEqual(process.pid, managedRestart.pid, "test runner PID unexpectedly equals managed runtime PID");
  await fs.writeFile(restartPidPath, `${process.pid}\n`, "utf8");
  const mismatchedLivePidListing = (await api("/api/instances")).body.instances.find((x) => x.name === "restart-demo");
  const mismatchedPidOnDisk = Number((await fs.readFile(restartPidPath, "utf8")).trim());
  const mismatchDiagnostic = JSON.stringify({ server: mismatchedLivePidListing.server, expectedLedgerPid: process.pid, pidOnDisk: mismatchedPidOnDisk, managedPid: managedRestart.pid });
  assert.equal(mismatchedLivePidListing.server.running, true, `healthy runtime must remain observable with a live mismatched PID ledger: ${mismatchDiagnostic}`);
  assert.equal(mismatchedLivePidListing.server.owned, false, `live mismatched PID ledger must not be silently adopted/overwritten: ${mismatchDiagnostic}`);
  assert.equal(mismatchedLivePidListing.server.pid, managedRestart.pid, `status must report the actual listener/runtime PID, not the stale live ledger PID: ${mismatchDiagnostic}`);
  assert.equal(mismatchedPidOnDisk, process.pid, `live mismatched PID ledger must remain untouched for explicit repair: ${mismatchDiagnostic}`);
  const mismatchedLivePidStart = (await post("/api/instances/restart-demo/server/start")).body;
  assert.equal(mismatchedLivePidStart.ok, false, "start must fail closed rather than duplicate a healthy runtime with unproven ownership");
  assert.match(mismatchedLivePidStart.error || "", /ownership|owned|false-green|prove/i);
  assert.equal(pidAlive(managedRestart.pid), true, "ownership conflict handling must not kill the actual healthy runtime");
  await fs.writeFile(restartPidPath, `${managedRestart.pid}\n`, "utf8");
  const restoredPidListing = (await api("/api/instances")).body.instances.find((x) => x.name === "restart-demo");
  assert.equal(restoredPidListing.server.owned, true, "restoring the exact runtime PID ledger must restore managed ownership");

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

  // Restart is explicit destructive authority, but it must still be atomic with
  // respect to predictable desired-generation failures. An out-of-band invalid
  // session/runtime setting must fail before MCP drain/stop and preserve the
  // exact serving PID.
  const preflightProtectedPid = managedRestart.pid;
  const invalidSessionEnv = /^MCP_MAX_SESSIONS=.*$/m.test(restartLiveEnv)
    ? restartLiveEnv.replace(/^MCP_MAX_SESSIONS=.*$/m, "MCP_MAX_SESSIONS=1")
    : `${restartLiveEnv.trimEnd()}\nMCP_MAX_SESSIONS=1\n`;
  await fs.writeFile(restartEnvPath, invalidSessionEnv, "utf8");
  const invalidSessionRestart = (await post("/api/instances/restart-demo/server/restart")).body;
  assert.equal(invalidSessionRestart.ok, false, `invalid desired session policy unexpectedly restarted Gateway: ${JSON.stringify(invalidSessionRestart)}`);
  assert.equal(invalidSessionRestart.restarted, false, "invalid desired session policy must fail before destructive Gateway replacement");
  assert.equal(invalidSessionRestart.preserved, true, "failed Restart preflight must explicitly report the serving Gateway preserved");
  assert.equal(invalidSessionRestart.previousPid, preflightProtectedPid, "failed Restart preflight must identify the exact preserved serving PID");
  assert.match(invalidSessionRestart.error || "", /MCP_MAX_SESSIONS|Session policy/i, "Restart preflight must diagnose the invalid desired policy instead of a post-stop startup failure");
  assert.equal(pidAlive(preflightProtectedPid), true, "invalid Restart preflight must not kill the currently-serving Gateway PID");
  const invalidSessionListing = (await api("/api/instances")).body.instances.find((x) => x.name === "restart-demo");
  assert.equal(invalidSessionListing.server.running, true, "invalid Restart preflight must leave the current Gateway observable/running");
  assert.equal(invalidSessionListing.server.pid, preflightProtectedPid, "invalid Restart preflight must preserve the exact current Gateway generation");
  await fs.writeFile(restartEnvPath, restartLiveEnv, "utf8");

  // Simulate an out-of-band PORT edit while the managed Local Coder Server is still live.
  // Background drift observation and a generic Start are both non-destructive:
  // they must preserve the serving PID and surface explicit maintenance. Only a
  // user-authorized Restart may cross the stop->start boundary and load the new PORT.
  const driftConfiguredPort = await freePort();
  await fs.writeFile(restartEnvPath, restartLiveEnv.replace(/^PORT=.*$/m, `PORT=${driftConfiguredPort}`), "utf8");
  const driftListing = (await api("/api/instances")).body.instances.find((x) => x.name === "restart-demo");
  assert.equal(driftListing.server.running, true, "PORT drift must not make an owned live Local Coder Server disappear");
  assert.equal(driftListing.server.port, restartServerPort, "status must report the actual live port during config drift");
  assert.equal(driftListing.server.configuredPort, driftConfiguredPort);
  assert.equal(driftListing.server.configDrift, true);
  assert.equal(driftListing.server.pid, managedRestart.pid);
  const staleServerPid = managedRestart.pid;
  const driftPreservedStart = (await post("/api/instances/restart-demo/server/start")).body;
  assert.equal(driftPreservedStart.ok, true, `non-destructive Start on PORT drift failed: ${JSON.stringify(driftPreservedStart)}`);
  assert.equal(driftPreservedStart.alreadyRunning, true, "Start on a serving stale Gateway must remain idempotent instead of becoming an implicit Restart");
  assert.equal(driftPreservedStart.restarted, false, "generic Start must never replace an already-serving stale Gateway");
  assert.equal(driftPreservedStart.pid, staleServerPid, "generic Start must preserve the serving PID while maintenance is pending");
  assert.equal(driftPreservedStart.port, restartServerPort, "generic Start must leave the live listener on the old serving PORT");
  assert.equal(driftPreservedStart.configDrift, true, "generic Start must keep stale configuration visible instead of false-green convergence");
  assert.equal(driftPreservedStart.maintenanceRequired, true, "generic Start must report explicit restart maintenance for stale config");
  assert.equal(pidAlive(staleServerPid), true, "generic Start must not kill the serving stale Gateway PID");

  const driftConvergedRestart = (await post("/api/instances/restart-demo/server/restart")).body;
  assert.equal(driftConvergedRestart.ok, true, `explicit PORT-drift Restart failed: ${JSON.stringify(driftConvergedRestart)}`);
  assert.equal(driftConvergedRestart.restarted, true, "explicit Restart must replace the stale exact-owned Local Coder Server");
  assert.equal(driftConvergedRestart.previousPid, staleServerPid);
  assert.ok(Number.isInteger(driftConvergedRestart.pid) && driftConvergedRestart.pid > 0);
  assert.notEqual(driftConvergedRestart.pid, staleServerPid, "explicit stale-config Restart must replace the old PID");
  assert.equal(driftConvergedRestart.port, driftConfiguredPort, "explicitly restarted Server must bind the newly saved PORT");
  assert.equal(driftConvergedRestart.configDrift, false, "explicit Restart must clear PORT configuration drift");
  assert.equal(pidAlive(staleServerPid), false, "stale Local Coder Server PID must exit during explicit Restart convergence");
  managedRestartPid = driftConvergedRestart.pid;
  const managedStop = (await post("/api/instances/restart-demo/server/stop")).body;
  assert.equal(managedStop.ok, true, `managed server stop failed: ${JSON.stringify(managedStop)}`);
  assert.equal(managedStop.processExited, true, "stop must confirm the converged Local Coder Server PID fully exited");
  assert.equal(pidAlive(managedRestartPid), false, "stopped converged Local Coder Server PID must no longer be alive");
  const stoppedServerConfig = JSON.parse(await fs.readFile(path.join(restartDemo, "config.json"), "utf8"));
  assert.equal(Object.hasOwn(stoppedServerConfig, "serverLaunchPid"), false, "successful Server stop must clear stale launch PID evidence");
  assert.equal(Object.hasOwn(stoppedServerConfig, "serverLaunchPort"), false, "successful Server stop must clear stale launch port evidence");
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
  assert.equal(deleteResult.serverPidExited, true, "instance delete must prove the captured managed PID exited before recycling metadata");
  assert.equal(pidLooksLikeLocalCoder(deleteStart.pid), false, "instance delete left its Local Coder Server process alive");
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
