/**
 * Full verification suite for ChatGPT MCP readiness.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const mcpPort = 4200 + Math.floor(Math.random() * 200);
const adminPort = mcpPort + 1;

function runNode(script, env = {}) {
  const scriptPath = path.join(root, script);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exit ${code}`))));
  });
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc")], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", () => {
      const fallback = spawn("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });
      fallback.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build exit ${code}`))));
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tsc exit ${code}`))));
  });
}

async function waitFor(url, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout ${url}`);
}

console.log("=== Build ===");
await runBuild();

const unitScripts = [
  "scripts/test-patch.mjs",
  "scripts/test-tools.mjs",
  "scripts/test-checkpoints.mjs",
  "scripts/test-mcp-upstream.mjs",
  "scripts/test-activity-log.mjs",
  "scripts/test-config-safety.mjs",
  "scripts/test-redaction.mjs",
  "scripts/test-audit-path.mjs",
  "scripts/test-state-concurrency.mjs",
  "scripts/test-filesystem-safety.mjs",
  "scripts/test-destructive-safety.mjs",
  "scripts/test-git-safety.mjs",
  "scripts/test-output-budget.mjs",
  "scripts/test-post-edit-hooks.mjs",
  "scripts/test-manager-log-utils.mjs",
  "scripts/test-manager-fs-utils.mjs",
  "scripts/test-manager-env-redaction.mjs",
  "scripts/test-manager-safety.mjs",
  "scripts/test-admin-auth.mjs",
  "scripts/test-session-leak.mjs",
  "scripts/test-project-memory.mjs",
  "scripts/test-tool-profile.mjs",
  "scripts/test-chatgpt-action-contract.mjs",
  "scripts/test-chatgpt-public-contract.mjs",
  "scripts/test-chatgpt-diagnostics.mjs",
  "scripts/test-chatgpt-legacy-compat.mjs",
  "scripts/test-shell-persist.mjs",
  "scripts/test-shell-process-manager.mjs",
];
const selfContainedIntegrationScripts = ["scripts/test-mcp-bridge-integration.mjs"];
const specialScripts = ["scripts/test-read-text-streaming.mjs", "scripts/test-mcp-session.mjs"];
const coveredTestFiles = new Set(
  [...unitScripts, ...selfContainedIntegrationScripts, ...specialScripts].map((script) => path.basename(script)),
);
const discoveredTestFiles = (await fs.readdir(path.join(root, "scripts")))
  .filter((name) => /^test-.*\.mjs$/.test(name))
  .sort();
const omittedTestFiles = discoveredTestFiles.filter((name) => !coveredTestFiles.has(name));
if (omittedTestFiles.length > 0) {
  throw new Error(`test:all coverage drift: unreferenced test scripts: ${omittedTestFiles.join(", ")}`);
}

console.log("\n=== Unit tests ===");
for (const script of unitScripts) {
  console.log(`\n--- ${script} ---`);
  await runNode(script);
}

console.log("\n--- scripts/test-read-text-streaming.mjs ---");
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--expose-gc", path.join(root, "scripts/test-read-text-streaming.mjs")], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`test-read-text-streaming.mjs exit ${code}`))));
});

console.log("\n=== Self-contained integration tests ===");
for (const script of selfContainedIntegrationScripts) {
  console.log(`\n--- ${script} ---`);
  await runNode(script);
}

console.log("\n=== Integration (spawn server) ===");
const integrationStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clc-integration-state-"));
const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(mcpPort),
    ADMIN_PORT: String(adminPort),
    CHATGPT_TOOL_PROFILE: "slim",
    // The repo .env ships a template WORKSPACE_PATH that does not exist; the
    // isolated server must override it or every shell spawn fails with ENOENT.
    WORKSPACE_PATH: root,
    MCP_SHELL_STATE_DIR: path.join(integrationStateDir, "shell-state"),
    CHECKPOINT_PATH: path.join(integrationStateDir, "checkpoints"),
    AUDIT_LOG_PATH: path.join(integrationStateDir, "audit.log"),
    // Low cap so the parallel/429 tests deterministically exercise admission
    // without needing 64 connected sessions in CI.
    MCP_MAX_SESSIONS: "8",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout?.on("data", (d) => (serverLog += d));
server.stderr?.on("data", (d) => (serverLog += d));

try {
  const health = await waitFor(`http://127.0.0.1:${mcpPort}/health`);
  if (!health.instructions?.tool_profile) throw new Error("health missing instructions");
  if (!health.managedProcesses || health.managedProcesses.max_running !== 16) {
    throw new Error(`health missing managed process policy: ${JSON.stringify(health.managedProcesses)}`);
  }
  const contractFixture = JSON.parse(
    await fs.readFile(path.join(root, "scripts", "fixtures", "chatgpt-public-contract-v1.json"), "utf8")
  );
  if (!health.boot_id || typeof health.boot_id !== "string") throw new Error("health missing boot_id");
  if (!health.mcp_contract || health.mcp_contract.version !== contractFixture.version) {
    throw new Error(`health mcp_contract missing/version mismatch: ${JSON.stringify(health.mcp_contract)}`);
  }
  if (health.mcp_contract.hash !== contractFixture.hash) {
    throw new Error(`health mcp_contract hash drift: ${health.mcp_contract.hash} != ${contractFixture.hash}`);
  }
  if (health.mcp_contract.tool_count !== contractFixture.tools.length) {
    throw new Error(`health mcp_contract tool_count mismatch: ${health.mcp_contract.tool_count}`);
  }
  if (health.mcp_contract.dynamic_tools !== false || health.mcp_contract.list_changed !== false) {
    throw new Error(`slim health must be non-dynamic: ${JSON.stringify(health.mcp_contract)}`);
  }
  console.log(`OK  health: profile=${health.instructions.tool_profile}, contract=v${health.mcp_contract.version} hash=${health.mcp_contract.hash.slice(0, 12)}…, memory=${health.instructions.memory_files?.length ?? 0} files`);

  const admin = await waitFor(`http://127.0.0.1:${adminPort}/health`);
  if (!admin.instructions) throw new Error("admin health missing instructions");
  console.log("OK  admin health");

  // No-auth MCP servers follow tunnel-client's documented sample behavior: all
  // protected-resource metadata candidates return 404. v0.0.10 must receive a
  // non-empty body so its 404 fallback branch reaches every candidate; a valid
  // PRMD body would incorrectly advertise OAuth on a server that has none.
  for (const suffix of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const prmd = await fetch(`http://127.0.0.1:${mcpPort}${suffix}`);
    if (prmd.status !== 404) throw new Error(`no-auth PRMD endpoint must be 404: ${suffix} -> ${prmd.status}`);
    if (!String(prmd.headers.get("content-type") || "").includes("application/json")) {
      throw new Error(`no-auth PRMD 404 must stay JSON: ${suffix}`);
    }
    const body = await prmd.json();
    if (body?.error !== "not_found") throw new Error(`unexpected no-auth PRMD body: ${JSON.stringify(body)}`);
  }
  console.log("OK  no-auth PRMD candidates return JSON 404");

  const preview = await (await fetch(`http://127.0.0.1:${adminPort}/api/instructions/preview`)).json();
  if (!preview.preview?.includes("Agent workflow")) throw new Error("instructions preview missing agent prompt");
  console.log(`OK  instructions preview ${preview.total_chars} chars`);

  // MCP session + tools/list count
  const initRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }),
  });
  const sid = initRes.headers.get("mcp-session-id");
  if (!sid) throw new Error("no session id");

  const listRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const listText = await listRes.text();
  const listJson = JSON.parse(listText);
  const tools = listJson?.result?.tools || [];
  const bytes = Buffer.byteLength(listText, "utf-8");
  if (tools.length > 30) console.warn(`WARN tools/list has ${tools.length} tools — consider slim profile`);
  if (!tools.some((t) => t.name === "apply_patch")) throw new Error("apply_patch missing");
  // ChatGPT/openai-mcp transport churn should be sampled in console logs rather
  // than producing one noisy initialize line per tool call/session.
  const sampleLogStart = serverLog.length;
  for (let i = 0; i < 25; i++) {
    const r = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `openai-sample-${i}`,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "openai-mcp", version: "1.0.0" },
        },
      }),
    });
    if (r.status !== 200 || !r.headers.get("mcp-session-id")) {
      throw new Error(`openai-mcp sample initialize ${i} failed: HTTP ${r.status}`);
    }
    await r.text();
  }
  await new Promise((r) => setTimeout(r, 50));
  const sampledInitLines = serverLog
    .slice(sampleLogStart)
    .split(/\r?\n/)
    .filter((line) => /Session initialized:.*client=openai-mcp/.test(line));
  if (sampledInitLines.length !== 1) {
    throw new Error(`expected 1 sampled openai-mcp initialize line for 25 sessions, got ${sampledInitLines.length}`);
  }
  if (!/\bclientInitialized=25\b/.test(sampledInitLines[0])) {
    throw new Error(`openai-mcp sampling counter is not client-local: ${sampledInitLines[0]}`);
  }
  console.log("OK  openai-mcp initialize logging sampled 1/25");

  // Explicit DELETE closes the SDK transport, but that is disposal rather than
  // a transient disconnect. Do not log the misleading "kept for recovery" line.
  const deleteLogStart = serverLog.length;
  const deleteInit = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "delete-log-check",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "delete-log-check", version: "1.0.0" },
      },
    }),
  });
  const deleteSid = deleteInit.headers.get("mcp-session-id");
  await deleteInit.text();
  if (deleteInit.status !== 200 || !deleteSid) throw new Error(`delete-log initialize failed: HTTP ${deleteInit.status}`);
  const deleteRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "DELETE",
    headers: { "mcp-session-id": deleteSid, "mcp-protocol-version": "2025-03-26" },
  });
  await deleteRes.text();
  if (!deleteRes.ok) throw new Error(`delete-log DELETE failed: HTTP ${deleteRes.status}`);
  await new Promise((r) => setTimeout(r, 50));
  const deleteLogSlice = serverLog.slice(deleteLogStart);
  const misleadingDeleteLine = deleteLogSlice
    .split(/\r?\n/)
    .find((line) => line.includes(`Transport closed for ${deleteSid.slice(0, 8)}`) && line.includes("session kept for recovery"));
  if (misleadingDeleteLine) {
    throw new Error("explicit DELETE emitted misleading recovery-retention log");
  }
  console.log("OK  explicit DELETE suppresses misleading recovery log");

  // /api/sessions: redacted shortIds, count >= 1 after initialize
  const sessions = await (await fetch(`http://127.0.0.1:${adminPort}/api/sessions`)).json();
  if (!sessions.ok || sessions.total < 1 || sessions.sessions.length !== sessions.total) {
    throw new Error(`sessions endpoint wrong: ${JSON.stringify(sessions)}`);
  }
  const s0 = sessions.sessions[0];
  if (!s0.shortId.endsWith("…") || s0.shortId.length > 9) throw new Error("shortId not redacted");
  if (!["registered", "closing"].includes(s0.status)) throw new Error(`unexpected status ${s0.status}`);
  if (typeof s0.connected !== "boolean") throw new Error(`connected not boolean: ${s0.connected}`);
  if (!Number.isInteger(s0.ageSeconds) || !Number.isInteger(s0.idleSeconds)) throw new Error("age/idle not integers");
  if (typeof sessions.connected !== "number" || sessions.connected < 0) throw new Error(`bad sessions.connected: ${sessions.connected}`);
  const leaked = sessions.sessions.some((s) => s.id || (s.sid && s.sid !== s.shortId));
  if (leaked) throw new Error("raw session id leaked in /api/sessions");
  console.log(`OK  /api/sessions: total=${sessions.total}, shortId redacted, status=${s0.status}`);

  // initialize itself has no session-id request header yet. The immediately
  // following tools/list does, so it is the right boundary check for ensuring
  // admin activity JSON never exposes the replay-capable raw session ID.
  const activity = await (await fetch(`http://127.0.0.1:${adminPort}/api/activity?limit=30`)).json();
  const sessionActivity = activity.entries?.find((e) => e.session_id?.startsWith(sid.slice(0, 8)));
  if (!sessionActivity) throw new Error("session activity not found");
  if (sessionActivity.session_id === sid || !sessionActivity.session_id.endsWith("…") || sessionActivity.session_id.length > 9) {
    throw new Error(`raw session id leaked in /api/activity: ${sessionActivity.session_id}`);
  }
  console.log("OK  /api/activity: session id redacted");

  process.env.PORT = String(mcpPort);
  await runNode("scripts/test-mcp-session.mjs", {
    PORT: String(mcpPort),
    ADMIN_PORT: String(adminPort),
    MCP_SESSION_TEST_ISOLATED: "1",
  });
  console.log("OK  test-mcp-session");
} finally {
  server.kill();
  await new Promise((resolve) => {
    if (server.exitCode != null) return resolve();
    const timer = setTimeout(resolve, 2000);
    server.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await fs.rm(integrationStateDir, { recursive: true, force: true });
}

console.log("\n=== ALL TESTS PASSED ===");