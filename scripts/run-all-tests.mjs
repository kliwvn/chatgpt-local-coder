/**
 * Full verification suite for ChatGPT MCP readiness.
 */
import { spawn } from "node:child_process";
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
  "scripts/test-redaction.mjs",
  "scripts/test-audit-path.mjs",
  "scripts/test-state-concurrency.mjs",
  "scripts/test-manager-log-utils.mjs",
  "scripts/test-manager-env-redaction.mjs",
  "scripts/test-manager-safety.mjs",
  "scripts/test-session-leak.mjs",
  "scripts/test-project-memory.mjs",
  "scripts/test-tool-profile.mjs",
  "scripts/test-shell-persist.mjs",
];

console.log("\n=== Unit tests ===");
for (const script of unitScripts) {
  console.log(`\n--- ${script} ---`);
  await runNode(script);
}

console.log("\n=== Integration (spawn server) ===");
const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(mcpPort),
    ADMIN_PORT: String(adminPort),
    CHATGPT_TOOL_PROFILE: "slim",
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
  console.log(`OK  health: profile=${health.instructions.tool_profile}, memory=${health.instructions.memory_files?.length ?? 0} files`);

  const admin = await waitFor(`http://127.0.0.1:${adminPort}/health`);
  if (!admin.instructions) throw new Error("admin health missing instructions");
  console.log("OK  admin health");

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
  console.log("OK  openai-mcp initialize logging sampled 1/25");

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
  });
  console.log("OK  test-mcp-session");
} finally {
  server.kill();
}

console.log("\n=== ALL TESTS PASSED ===");