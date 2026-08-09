#!/usr/bin/env node
/**
 * Quản Lý ChatGPT Local Coder — management window (standalone launcher).
 *
 * Zero-dependency Node HTTP server bound to 127.0.0.1:<MANAGER_PORT> (default 3300).
 * Controls: install/build, multi-instance workspaces (mỗi instance có .env,
 * server port, tunnel + profile riêng), focus server, focus tunnel
 * (Cloudflare quick tunnel hoac OpenAI Secure MCP Tunnel), ChatGPT links.
 *
 * Instance layout:
 *   manager/instances/<name>/
 *     .env          # PORT, ADMIN_PORT, WORKSPACE_PATH, OPENAI_TUNNEL_ID/KEY...
 *     config.json   # connectorName, lastTunnelUrl, healthPort, autoStart
 *     server.pid / tunnel.pid / profile.yaml / server.log / tunnel.log
 *
 * Usage:
 *   node manager/server.mjs            # start + auto-open browser
 *   node manager/server.mjs --no-open  # start without opening browser
 *   manager.bat                        # Windows launcher
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rotateLogFile, tailFile } from "./log-utils.mjs";
import {
  atomicWriteFile,
  enqueueKeyedMutation,
  pruneExpiredCache,
  retryTransientFsMutation,
} from "./fs-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const STATE_DIR = path.resolve(process.env.MANAGER_STATE_DIR || path.join(__dirname, "state"));
const LOG_DIR = path.join(STATE_DIR, "logs");
const CONFIG_PATH = path.join(STATE_DIR, "config.json");
const PROFILES_PATH = path.join(STATE_DIR, "profiles.json");
const SERVER_PID_FILE = path.join(STATE_DIR, "server.pid");
const TUNNEL_PID_FILE = path.join(STATE_DIR, "tunnel.pid");
const SERVER_LOG = path.join(LOG_DIR, "server.log");
const TUNNEL_LOG = path.join(LOG_DIR, "tunnel.log");
const INSTALL_LOG = path.join(LOG_DIR, "install.log");
/* Mỗi instance là một thư mục con của INSTANCES_DIR. Có thể ghi đè bằng
 * MANAGER_INSTANCES_DIR (dùng cho test mà không đụng instance thật). */
const INSTANCES_DIR = path.resolve(
  process.env.MANAGER_INSTANCES_DIR || path.join(__dirname, "instances")
);
const INSTANCE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const IS_WIN = process.platform === "win32";
const REPO_ROOT = ROOT; // thư mục repo (manager.bat nằm ở đây)
const MANAGER_BAT = path.join(ROOT, "manager.bat");
const MANAGER_HIDDEN_VBS = path.join(STATE_DIR, "manager-hidden.vbs");
const STARTUP_LNK = IS_WIN
  ? path.join(
      process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"),
      "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
      "ChatGPT Local Coder Manager.lnk"
    )
  : path.join(ROOT, ".autostart");
const NPM_CMD = IS_WIN ? "npm.cmd" : "npm";
const CLOUDFLARED = IS_WIN ? path.join(ROOT, "cloudflared.exe") : "cloudflared";
const CLOUDFLARED_PROC = IS_WIN ? "cloudflared.exe" : "cloudflared";
const OPENAI_TUNNEL_CLIENT = IS_WIN ? "tunnel-client.exe" : "tunnel-client";
const OPENAI_TUNNEL_CLIENT_EXE = path.join(ROOT, "bin", "tunnel-client.exe");
const OPENAI_TUNNEL_VERSION = "v0.0.10";
const OPENAI_TUNNEL_ZIP_URL = `https://github.com/openai/tunnel-client/releases/download/${OPENAI_TUNNEL_VERSION}/tunnel-client-${OPENAI_TUNNEL_VERSION}-windows-amd64.zip`;
const FOLDER_PICKER_CS = path.join(__dirname, "folder-picker.cs");
const FOLDER_PICKER_EXE = path.join(STATE_DIR, "bin", "folder-picker.exe");
const CSC_PATH = [
  "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  "C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe",
].find(fs.existsSync) || null;
const SERVER_ENTRY = path.join(ROOT, "dist", "index.js");
const CLOUDFLARED_DOWNLOAD_URL =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const ENV_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
/* Secret keys masked on the wire. ADMIN_TOKEN also gates the instance admin
 * API, so it must never reach the browser either. */
const SECRET_KEY_RE =
  /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)(_|$)|API_KEY|MCP_API_KEY/i;
const MASK_SENTINEL = "********";

function isSecretKey(key) { return SECRET_KEY_RE.test(String(key)); }
function withoutSecrets(values) {
  const out = {};
  if (!values || typeof values !== "object") return out;
  for (const [key, value] of Object.entries(values)) if (!isSecretKey(key)) out[key] = value;
  return out;
}
function scrubProfiles(profiles) {
  if (!profiles || typeof profiles !== "object") return {};
  for (const profile of Object.values(profiles)) {
    if (profile && typeof profile === "object" && profile.values && typeof profile.values === "object") {
      profile.values = withoutSecrets(profile.values);
    }
  }
  return profiles;
}

/* ------------------------------------------------------------------ */
/* dotenv helpers (preserve comments/order, like src/admin/routes.ts)  */
/* ------------------------------------------------------------------ */

function parseDotEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = ENV_LINE_RE.exec(line.trim());
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}

function serializeDotEnv(values, original) {
  const lines = original.split(/\r?\n/);
  const seen = new Set();
  const result = [];
  for (const line of lines) {
    const m = ENV_LINE_RE.exec(line.trim());
    if (m && m[1] in values) {
      seen.add(m[1]);
      if (values[m[1]] !== null) result.push(`${m[1]}=${values[m[1]]}`);
      continue;
    }
    result.push(line);
  }
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key) && value !== null) result.push(`${key}=${value}`);
  }
  return result.join("\n");
}

const PORT_PID_CACHE_TTL_MS = 2000;
let portPidCache = { at: 0, pids: new Map() };
function invalidatePortPidCache() { portPidCache = { at: 0, pids: new Map() }; }
function listeningPortPids() {
  if (Date.now() - portPidCache.at < PORT_PID_CACHE_TTL_MS) return portPidCache.pids;
  const pids = new Map();
  try {
    const out = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true }).stdout || "";
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
      if (!m) continue;
      const port = Number(m[1]);
      const pid = Number(m[2]);
      if (Number.isInteger(port) && Number.isInteger(pid) && pid > 0 && !pids.has(port)) pids.set(port, pid);
    }
  } catch {}
  portPidCache = { at: Date.now(), pids };
  return pids;
}
function pidOnPort(port) {
  return listeningPortPids().get(Number(port)) || null;
}

/* LEGACY single-instance .env tại ROOT/.env — chỉ còn dùng để đọc
 * MANAGER_PORT và migrate sang instance "default" lần đầu. */
async function readEnvRaw() {
  try {
    return await fsp.readFile(ENV_PATH, "utf-8");
  } catch {
    return "";
  }
}

async function readEnv() {
  return parseDotEnv(await readEnvRaw());
}

/* ------------------------------------------------------------------ */
/* manager state (config.json / profiles.json / pid files)             */
/* ------------------------------------------------------------------ */

async function ensureStateDirs() {
  await fsp.mkdir(STATE_DIR, { recursive: true });
  await fsp.mkdir(LOG_DIR, { recursive: true });
  await fsp.mkdir(INSTANCES_DIR, { recursive: true });
}

async function readJson(p, fallback) {
  try {
    return JSON.parse(await fsp.readFile(p, "utf-8"));
  } catch {
    return fallback;
  }
}

async function writeJson(p, data) {
  await atomicWriteFile(p, JSON.stringify(data, null, 2), "utf8");
}

const fileMutationChains = new Map();
function enqueueFileMutation(file, operation) {
  return enqueueKeyedMutation(fileMutationChains, file, operation);
}
async function mutateJson(file, fallback, mutator) {
  return enqueueFileMutation(file, async () => {
    const value = await readJson(file, fallback);
    const result = await mutator(value);
    await writeJson(file, value);
    return result === undefined ? value : result;
  });
}

async function readConfig() {
  return readJson(CONFIG_PATH, { connectorName: "", lastTunnelUrl: "" });
}

async function readPidFile(p) {
  try {
    const pid = Number((await fsp.readFile(p, "utf-8")).trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function writePidFile(p, pid) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  // Windows đôi khi trả EBUSY/EPERM khi process khác đang đọc file — retry ngắn.
  // Retry exhaustion must propagate: reporting lifecycle success with stale/missing
  // PID metadata makes later identity-safe stop/restart decisions unreliable.
  await retryTransientFsMutation(async () => {
      if (pid) await fsp.writeFile(p, String(pid), "utf-8");
      else await fsp.rm(p, { force: true });
  });
}

/* ------------------------------------------------------------------ */
/* process detection / control                                         */
/* ------------------------------------------------------------------ */

function isPortOpen(port, host = "127.0.0.1") {
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = net.connect({ port, host, timeout: 1200 });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

function killPidTree(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    const args = IS_WIN ? ["/PID", String(pid), "/T", "/F"] : ["-9", String(pid)];
    const res = spawnSync(IS_WIN ? "taskkill" : "kill", args, { encoding: "utf8", windowsHide: true });
    return res.status === 0;
  } catch {
    return false;
  }
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but this account cannot signal it.
    return err?.code === "EPERM";
  }
}

async function waitFor(predicate, timeoutMs, intervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Spawn a detached process; its output goes to logFile so it survives manager exit. */
function spawnDetached(cmd, args, logFile, extraEnv = null) {
  const out = fs.openSync(logFile, "a");
  const child = spawn(cmd, args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
  });
  child.on("error", (err) => console.error("[spawnDetached] lỗi:", err.message));
  fs.closeSync(out);
  return child.pid;
}

let hiddenLaunchSeq = 0;
function spawnHiddenDetached(cmd, args, logFile, extraEnv = null) {
  const q = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const token = `${process.pid}-${Date.now().toString(36)}-${(++hiddenLaunchSeq).toString(36)}`;
  const batPath = path.join(STATE_DIR, `spawn-hidden-${token}.cmd`);
  const vbsPath = path.join(STATE_DIR, `spawn-hidden-${token}.vbs`);
  const bat = `@echo off\r\ncd /d ${q(STATE_DIR)}\r\n${q(cmd)} ${args.map(q).join(" ")} >> ${q(logFile)} 2>&1\r\n`;
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    "q = Chr(34)",
    `sh.Run "cmd.exe /c " & q & "${batPath}" & q, 0, False`,
  ].join("\r\n");
  fs.writeFileSync(batPath, bat, "utf-8");
  fs.writeFileSync(vbsPath, vbs, "utf-8");
  const child = spawn("wscript.exe", [vbsPath], {
    windowsHide: true,
    stdio: "ignore",
    detached: true,
    env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
  });
  child.on("error", (err) => console.error("[spawnHiddenDetached] wscript error:", err.message));
  const cleanupTimer = setTimeout(() => {
    void Promise.all([fsp.rm(batPath, { force: true }), fsp.rm(vbsPath, { force: true })]).catch(() => undefined);
  }, 60000);
  cleanupTimer.unref?.();
  return child.pid;
}



/* ------------------------------------------------------------------ */
/* instance paths / helpers                                            */
/* ------------------------------------------------------------------ */

function instPaths(name) {
  const dir = path.join(INSTANCES_DIR, name);
  return {
    dir,
    env: path.join(dir, ".env"),
    config: path.join(dir, "config.json"),
    serverPid: path.join(dir, "server.pid"),
    tunnelPid: path.join(dir, "tunnel.pid"),
    profile: path.join(dir, "profile.yaml"),
    serverLog: path.join(dir, "server.log"),
    tunnelLog: path.join(dir, "tunnel.log"),
  };
}

async function listInstances() {
  try {
    const names = (await fsp.readdir(INSTANCES_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => INSTANCE_NAME_RE.test(n))
      .sort();
    return names;
  } catch {
    return [];
  }
}

async function readInstanceEnvRaw(name) {
  try {
    return await fsp.readFile(instPaths(name).env, "utf-8");
  } catch {
    return "";
  }
}

async function readInstanceEnv(name) {
  return parseDotEnv(await readInstanceEnvRaw(name));
}

async function readInstanceConfig(name) {
  return readJson(instPaths(name).config, {
    connectorName: "",
    lastTunnelUrl: "",
    healthPort: 8080,
    autoStart: true,
  });
}

async function writeInstanceConfig(name, config) {
  await writeJson(instPaths(name).config, config);
}

async function updateInstanceConfig(name, updater) {
  const file = instPaths(name).config;
  return mutateJson(file, { connectorName: "", lastTunnelUrl: "", healthPort: 8080, autoStart: true }, async (config) => {
    await updater(config);
    return config;
  });
}

/** Tất cả cổng đang được các instance khác dùng (PORT/ADMIN_PORT/healthPort). */
async function allUsedPorts(excludeName = null) {
  const ports = new Set();
  for (const n of await listInstances()) {
    if (n === excludeName) continue;
    const env = await readInstanceEnv(n);
    const p = Number(env.PORT);
    if (Number.isInteger(p) && p > 0 && p < 65536) ports.add(p);
    const a = Number(env.ADMIN_PORT);
    if (Number.isInteger(a) && a > 0 && a < 65536) ports.add(a);
    const cfg = await readInstanceConfig(n);
    const h = Number(cfg.healthPort || env.OPENAI_TUNNEL_HEALTH_PORT || 8080);
    if (Number.isInteger(h) && h > 0 && h < 65536) ports.add(h);
  }
  return ports;
}

/** Tìm instance khác đang dùng cùng tunnel ID hoặc API key (tránh xung đột). */
async function findTunnelConflicts(name, tunnelId, apiKey) {
  const conflicts = [];
  const tid = String(tunnelId || "").trim();
  const akey = String(apiKey || "").trim();
  if (!tid && !akey) return conflicts;
  for (const n of await listInstances()) {
    if (n === name) continue;
    const env = await readInstanceEnv(n);
    if (tid && env.OPENAI_TUNNEL_ID === tid) {
      conflicts.push({ instance: n, field: "OPENAI_TUNNEL_ID", value: tid });
    }
    if (akey && env.OPENAI_TUNNEL_API_KEY === akey) {
      conflicts.push({ instance: n, field: "OPENAI_TUNNEL_API_KEY", value: akey.slice(-4) });
    }
  }
  return conflicts;
}

/** Migrate trạng thái đơn-instance (ROOT/.env + manager/state) sang instance "default". */
async function ensureInstances() {
  await fsp.mkdir(INSTANCES_DIR, { recursive: true });
  if ((await listInstances()).length > 0) return;
  const legacyEnv = await readEnvRaw();
  if (!legacyEnv) return;
  const inst = instPaths("default");
  await fsp.mkdir(inst.dir, { recursive: true });
  await atomicWriteFile(inst.env, legacyEnv, "utf8");
  const legacyConfig = await readConfig();
  const legacyParsed = parseDotEnv(legacyEnv);
  const legacyHealthPortRaw = String(legacyParsed.OPENAI_TUNNEL_HEALTH_PORT || "8080").trim();
  const legacyHealthPort = Number(legacyHealthPortRaw);
  await writeInstanceConfig("default", {
    connectorName: legacyConfig.connectorName || "",
    lastTunnelUrl: legacyConfig.lastTunnelUrl || "",
    healthPort: Number.isInteger(legacyHealthPort) && legacyHealthPort > 0 && legacyHealthPort < 65536 ? legacyHealthPort : 8080,
    autoStart: true,
  });
  // Nhận nuôi process/log đang chạy (server/tunnel sống sót qua migration)
  for (const [old, dest] of [
    [SERVER_PID_FILE, inst.serverPid],
    [TUNNEL_PID_FILE, inst.tunnelPid],
    [SERVER_LOG, inst.serverLog],
    [TUNNEL_LOG, inst.tunnelLog],
  ]) {
    try {
      await fsp.copyFile(old, dest);
    } catch {}
  }
}


/** Cache kết quả quét PID ngắn (2s) — tránh spawn powershell.exe liên tục
 *  khi UI gọi /api/instances (mỗi instance 1-2 lần quét mỗi request). */
const pidScanCache = new Map();
const PID_SCAN_TTL_MS = 2000;
function invalidateProcessScanCache() { pidScanCache.clear(); }
/** PIDs của process imageName mà command line chứa substring (phân biệt instance). */
function pidsWithCmdLine(imageName, substring) {
  const now = Date.now();
  pruneExpiredCache(pidScanCache, PID_SCAN_TTL_MS, now);
  const key = `${imageName}\u0000${substring}`;
  const hit = pidScanCache.get(key);
  if (hit) return hit.pids;
  let pids = [];
  try {
    const needle = String(substring).replace(/'/g, "''");
    const ps = [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='${imageName}'" | Where-Object { $_.CommandLine -like '*${needle}*' } | Select-Object -ExpandProperty ProcessId`,
    ];
    const out = spawnSync("powershell.exe", ps, { encoding: "utf8", windowsHide: true, timeout: 15000 }).stdout || "";
    pids = out
      .split(/\r?\n/)
      .map((l) => Number(l.trim()))
      .filter((p) => Number.isInteger(p) && p > 0);
  } catch {
    pids = [];
  }
  pidScanCache.set(key, { at: now, pids });
  return pids;
}

async function serverHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function samePath(a, b) {
  if (!a || !b) return false;
  const left = path.resolve(String(a));
  const right = path.resolve(String(b));
  return IS_WIN ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function expectedWorkspacePath(env) {
  const configured = String(env.WORKSPACE_PATH || "").trim();
  if (!configured) return null;
  return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(ROOT, configured);
}
function isLocalCoderHealth(health, env) {
  if (!health || health.status !== "ok" || health.name !== "codex-mcp-server") return false;
  const expected = expectedWorkspacePath(env);
  return !expected || samePath(expected, health.workspace);
}
async function tunnelClientHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const type = String(res.headers.get("content-type") || "").toLowerCase();
    if (!type.includes("text/html")) return false;
    return /<title>\s*tunnel-client\s*<\/title>/i.test(await res.text());
  } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* install / server / tunnel control                                   */
/* ------------------------------------------------------------------ */

async function runInstall() {
  await ensureStateDirs();
  const log = [];
  for (const args of [["install"], ["run", "build"]]) {
    const res = await new Promise((resolve) => {
      const child = IS_WIN
        ? spawn("cmd.exe", ["/c", "npm.cmd", ...args], { cwd: ROOT, windowsHide: true })
        : spawn(NPM_CMD, args, { cwd: ROOT, windowsHide: true });
      child.on("error", (err) => resolve({ code: -1, out: "spawn lỗi: " + err.message }));
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out: out.slice(-6000) }));
    });
    log.push({ step: `npm ${args.join(" ")}`, code: res.code, output: res.out });
    if (res.code !== 0) break;
  }
  await fsp.writeFile(INSTALL_LOG, log.map((l) => l.output).join("\n"), "utf-8");
  const ok = log.every((l) => l.code === 0);
  return { ok, steps: log.map((l) => ({ step: l.step, code: l.code })), output: log.map((l) => l.output).join("\n").slice(-6000) };
}

async function serverStatus(name) {
  const env = await readInstanceEnv(name);
  const inst = instPaths(name);
  const port = Number(env.PORT || 0);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    return { running: false, port: 0, pid: await readPidFile(inst.serverPid), health: null, portOccupied: false, invalidConfig: true };
  }
  const portOpen = await isPortOpen(port);
  const health = portOpen ? await serverHealth(port) : null;
  const running = portOpen && isLocalCoderHealth(health, env);
  const portPid = portOpen ? pidOnPort(port) : null;
  const savedPid = await readPidFile(inst.serverPid);
  return { running, port, pid: portPid || savedPid || null, health: running ? health : null, portOccupied: portOpen && !running };
}

async function warmUpMcp(port) {
  // Trả tiền chi phí tạo session MCP đầu tiên (server vừa boot, thường >2s)
  // trước khi tunnel-client chạy probe (timeout 2s) — tránh "mcp probe timed out".
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "manager-warmup", version: "1.0" },
        },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return false;
    const sid = res.headers.get("mcp-session-id");
    if (sid) {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": sid,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        signal: AbortSignal.timeout(10000),
      }).then((r) => r.arrayBuffer()).catch(() => {});
      await fetch(url, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": sid },
        signal: AbortSignal.timeout(10000),
      }).then((r) => r.arrayBuffer()).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

const serverLifecycleChains = new Map();

function enqueueServerLifecycle(name, operation) {
  const previous = serverLifecycleChains.get(name) || Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.then(() => undefined, () => undefined);
  serverLifecycleChains.set(name, settled);
  settled.finally(() => {
    if (serverLifecycleChains.get(name) === settled) serverLifecycleChains.delete(name);
  });
  return run;
}

async function startServerUnlocked(name) {
  const st = await serverStatus(name);
  if (st.running) return { ok: true, alreadyRunning: true, ...st };
  if (st.invalidConfig) return { ok: false, error: "PORT is invalid; fix configuration before starting Local Coder." };
  if (st.portOccupied) return { ok: false, error: `PORT ${st.port} is occupied by another process${st.pid ? ` (PID ${st.pid})` : ""}; refusing to start Local Coder.` };
  if (!fs.existsSync(SERVER_ENTRY)) {
    return { ok: false, error: "dist/index.js chưa tồn tại — bấm 'Cài Đặt' trước." };
  }
  const inst = instPaths(name);
  // Persist documented session-policy defaults for instances created before
  // these keys existed (e.g. "default"), so policy survives manager restarts
  // instead of silently relying on the server process fallback.
  await ensureSessionPolicyDefaults(name);
  // Chặn start nếu policy không hợp lệ: server sẽ chạy với process-default
  // (vd TTL=120000) trong khi UI hiển thị giá trị đã lưu → UI khác thực tế.
  const policy = validateSessionPolicy(await readInstanceEnv(name));
  if (!policy.ok) {
    return { ok: false, error: `Session policy không hợp lệ — sửa trong Cấu hình: ${policy.errors.join("; ")}` };
  }
  const env = await readInstanceEnv(name);
  const runtimeLimits = validateRuntimeLimits(env);
  if (!runtimeLimits.ok) {
    return { ok: false, error: `Runtime limits không hợp lệ — sửa trong Cấu hình: ${runtimeLimits.errors.join("; ")}` };
  }
  await rotateLogFile(inst.serverLog);
  const pid = spawnDetached(process.execPath, [SERVER_ENTRY], inst.serverLog, {
    ...env,
    // Runtime metadata only (not persisted into the user's .env): direct admin
    // config editing must target this instance file, not repo-root .env merely
    // because every managed server process is spawned with cwd=ROOT.
    MCP_ENV_FILE: inst.env,
    MCP_INSTANCE_NAME: name,
  });
  invalidatePortPidCache();
  await writePidFile(inst.serverPid, pid);
  const up = await waitFor(async () => isLocalCoderHealth(await serverHealth(st.port), env), 20000);
  if (!up) {
    killPidTree(pid);
    invalidatePortPidCache();
    await writePidFile(inst.serverPid, null);
    const tail = await tailFile(inst.serverLog);
    return { ok: false, error: "Server không khởi động được. Log cuối:\n" + tail.slice(-1500) };
  }
  await warmUpMcp(st.port); // làm ấm trước khi tunnel probe (timeout 2s)
  return { ok: true, running: true, port: st.port, pid, health: await serverHealth(st.port) };
}

async function stopServerUnlocked(name) {
  const st = await serverStatus(name);
  if (!st.running) return { ok: true, alreadyStopped: true, port: st.port };
  const inst = instPaths(name);
  const env = await readInstanceEnv(name);

  // Prefer an in-process graceful shutdown on Windows too. OS-level SIGTERM /
  // taskkill bypasses Node signal handlers there; the localhost admin endpoint
  // can close MCP sessions/SSE + upstream transports before listeners exit.
  const adminPort = Number(env.ADMIN_PORT || "3001");
  try {
    const headers = {};
    if (env.ADMIN_TOKEN) headers["x-admin-token"] = env.ADMIN_TOKEN;
    const response = await fetch(`http://127.0.0.1:${adminPort}/api/process/shutdown`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(2500),
    });
    await response.arrayBuffer().catch(() => undefined);
    if (response.ok) {
      // server.close() stops listening before all old HTTP connections drain, so
      // "port closed" is not enough: starting the replacement at that point can
      // overlap two Gateway generations while the old PID is still cleaning up.
      // The current runtime bounds HTTP drain to 4s; allow 6s for compatibility,
      // then fall through to the verified hard-stop path for older/wedged builds.
      const graceful = await waitFor(
        async () => !isPidAlive(st.pid) && !(await isPortOpen(st.port)),
        6000,
        150
      );
      if (graceful) {
        await writePidFile(inst.serverPid, null);
        return { ok: true, port: st.port, stopped: true, graceful: true, processExited: true };
      }
    }
  } catch {
    // Old builds / wedged admin listener fall through to the hard-stop path.
  }

  let killed = false;
  const pidFile = await readPidFile(inst.serverPid);
  if (pidFile && pidFile === st.pid) killed = killPidTree(pidFile);
  if (!killed && st.pid) killed = killPidTree(st.pid);
  invalidatePortPidCache();
  await writePidFile(inst.serverPid, null);
  const stopped = await waitFor(
    async () => !isPidAlive(st.pid) && !(await isPortOpen(st.port)),
    5000,
    150
  );
  if (!stopped) {
    const current = await serverStatus(name);
    return {
      ok: false,
      error: `Server did not release PORT ${st.port} after stop request${current.pid ? ` (PID ${current.pid})` : ""}.`,
      port: st.port,
      pid: current.pid || st.pid || null,
      stopped: false,
      graceful: false,
      forced: killed,
    };
  }
  return { ok: true, port: st.port, stopped: true, graceful: false, forced: killed, processExited: true };
}

async function startServer(name) {
  return enqueueServerLifecycle(name, () => startServerUnlocked(name));
}

async function stopServer(name) {
  return enqueueServerLifecycle(name, () => stopServerUnlocked(name));
}

async function restartServer(name) {
  return enqueueServerLifecycle(name, async () => {
    const before = await serverStatus(name);
    const stopped = await stopServerUnlocked(name);
    if (!stopped.ok) return { ...stopped, restarted: false, previousPid: before.pid || null };

    const started = await startServerUnlocked(name);
    if (!started.ok) {
      return {
        ...started,
        restarted: false,
        previousPid: before.pid || null,
        stop: stopped,
      };
    }

    if (before.running && before.pid && started.pid === before.pid) {
      return {
        ...started,
        ok: false,
        restarted: false,
        error: `Restart completed without a PID change (still ${started.pid}); refusing to report a successful restart.`,
        previousPid: before.pid,
      };
    }

    return {
      ...started,
      ok: true,
      restarted: true,
      previousPid: before.pid || null,
      gracefulStop: stopped.graceful === true,
      previousProcessExited: stopped.processExited === true,
    };
  });
}


async function tunnelStatus(name) {
  const env = await readInstanceEnv(name);
  const config = await readInstanceConfig(name);
  const tunnelId = env.OPENAI_TUNNEL_ID || "";
  const apiKey = env.OPENAI_TUNNEL_API_KEY || "";
  const mode = tunnelId && apiKey ? "openai" : "cloudflare";
  const healthPort = Number(config.healthPort || env.OPENAI_TUNNEL_HEALTH_PORT || 0);
  const healthPortValid = Number.isInteger(healthPort) && healthPort > 0 && healthPort < 65536;
  const controlPlaneUrl = tunnelId ? `https://api.openai.com/v1/tunnel/${tunnelId}` : null;
  const oaPortOpen = healthPortValid ? await isPortOpen(healthPort) : false;
  const oaRunning = oaPortOpen ? await tunnelClientHealth(healthPort) : false;
  const serverPort = Number(env.PORT || 0);
  const cfPids = mode === "cloudflare" && Number.isInteger(serverPort)
    ? pidsWithCmdLine("cloudflared.exe", `localhost:${serverPort}`)
    : [];
  const cfRunning = cfPids.length > 0;
  const running = mode === "openai" ? oaRunning : cfRunning;
  const cloudflaredExists = fs.existsSync(CLOUDFLARED);
  if (mode === "openai") {
    return { running, mode, tunnelId, kind: oaRunning ? "openai" : null, url: oaRunning ? controlPlaneUrl : null, healthPort, cloudflaredExists, invalidConfig: !healthPortValid, portOccupied: oaPortOpen && !oaRunning };
  }
  return { running, mode: "cloudflare", kind: cfRunning ? "cloudflare" : null, url: cfRunning ? config.lastTunnelUrl : null, cloudflaredExists, healthPort, pid: cfPids[0] || null, invalidConfig: !healthPortValid, portOccupied: false };
}

async function ensureTunnelClient() {
  const binDir = path.join(ROOT, "bin");
  const exe = OPENAI_TUNNEL_CLIENT_EXE;
  if (fs.existsSync(exe)) return { ok: true, path: exe };
  const tmpZip = path.join(binDir, "tunnel-client.zip");
  try {
    await fsp.mkdir(binDir, { recursive: true });
    const res = await fetch(OPENAI_TUNNEL_ZIP_URL, { signal: AbortSignal.timeout(240000), redirect: "follow" });
    if (!res.ok) return { ok: false, error: `Tải tunnel-client thất bại: HTTP ${res.status}` };
    await fsp.writeFile(tmpZip, Buffer.from(await res.arrayBuffer()));
    const viaTar = spawnSync("tar", ["-xf", tmpZip, "-C", binDir], { windowsHide: true });
    if (viaTar.status !== 0) {
      const viaPs = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `Expand-Archive -Path '${tmpZip}' -DestinationPath '${binDir}' -Force`],
        { windowsHide: true }
      );
      if (viaPs.status !== 0) return { ok: false, error: "Giải nén tunnel-client thất bại." };
    }
    const found = (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const r = walk(p);
          if (r) return r;
        } else if (entry.name.toLowerCase() === "tunnel-client.exe") {
          return p;
        }
      }
      return null;
    })(binDir);
    if (!found) return { ok: false, error: "Không tìm thấy tunnel-client.exe trong gói tải về." };
    if (path.resolve(found) !== path.resolve(exe)) {
      await fsp.rename(found, exe);
    }
    return { ok: true, path: exe };
  } catch (err) {
    return { ok: false, error: "Tải tunnel-client lỗi: " + (err?.message || String(err)) };
  } finally {
    await fsp.rm(tmpZip, { force: true }).catch(() => {});
  }
}

const tunnelLifecycleChains = new Map();

function enqueueTunnelLifecycle(name, operation) {
  const previous = tunnelLifecycleChains.get(name) || Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.then(() => undefined, () => undefined);
  tunnelLifecycleChains.set(name, settled);
  settled.finally(() => {
    if (tunnelLifecycleChains.get(name) === settled) tunnelLifecycleChains.delete(name);
  });
  return run;
}

async function startTunnelUnlocked(name) {
  const env = await readInstanceEnv(name);
  const st = await tunnelStatus(name);
  if (st.running) return { ok: true, alreadyRunning: true, ...st };
  if (st.invalidConfig) return { ok: false, error: "OPENAI_TUNNEL_HEALTH_PORT is invalid; fix configuration before starting Tunnel." };
  if (st.portOccupied) return { ok: false, error: `Tunnel health port ${st.healthPort} is occupied by another process; refusing to start Tunnel.` };
  const inst = instPaths(name);
  const port = Number(env.PORT || 0);
  const serverState = await serverStatus(name);
  if (!serverState.running) {
    const reason = serverState.portOccupied ? "the server port is occupied by another process" : "Local Coder server is not running";
    return { ok: false, error: `Cannot start Tunnel: ${reason} on port ${port}.` };
  }

  // Remove only stale tunnel processes belonging to this instance.
  for (const p of pidsWithCmdLine("tunnel-client.exe", inst.profile)) killPidTree(p);
  for (const p of pidsWithCmdLine("cloudflared.exe", `localhost:${port}`)) killPidTree(p);
  invalidateProcessScanCache();

  if (st.mode === "openai") {
    const healthPort = st.healthPort;
    const client = await ensureTunnelClient();
    if (!client.ok) return client;

    const profileFile = inst.profile;
    const mcpUrl = `http://127.0.0.1:${port}/mcp`;
    const yaml = [
      "config_version: 1",
      "control_plane:",
      `  tunnel_id: ${env.OPENAI_TUNNEL_ID}`,
      "  api_key: env:OPENAI_TUNNEL_API_KEY",
      "log:",
      "  level: info",
      "  format: struct-text",
      "health:",
      `  listen_addr: 127.0.0.1:${healthPort}`,
      "mcp:",
      "  server_urls:",
      "    - channel: main",
      `      url: ${mcpUrl}`,
      "",
    ].join("\n");
    await fsp.mkdir(inst.dir, { recursive: true });
    await atomicWriteFile(profileFile, yaml, "utf8");

    await fsp.writeFile(inst.tunnelLog, "");
    spawnHiddenDetached(client.path, ["run", "--profile-file", profileFile], inst.tunnelLog, {
      OPENAI_TUNNEL_API_KEY: env.OPENAI_TUNNEL_API_KEY,
      CONTROL_PLANE_API_KEY: env.OPENAI_TUNNEL_API_KEY,
      CONTROL_PLANE_TUNNEL_ID: env.OPENAI_TUNNEL_ID,
    });
    invalidateProcessScanCache();
    const up = await waitFor(() => tunnelClientHealth(healthPort), 45000);
    if (!up) {
      for (const p of pidsWithCmdLine(profileFile)) killPidTree(p); // tree-kill: cả codex worker nữa
      await writePidFile(inst.tunnelPid, null);
      const tail = await tailFile(inst.tunnelLog);
      return { ok: false, error: "OpenAI tunnel không khởi động được. Log cuối:\n" + tail.slice(-1500) };
    }
    const tunnelUrl = `https://api.openai.com/v1/tunnel/${env.OPENAI_TUNNEL_ID}`;
    await updateInstanceConfig(name, (config) => { config.lastTunnelUrl = tunnelUrl; });
    return { ok: true, mode: "openai", tunnelId: env.OPENAI_TUNNEL_ID, healthPort, url: tunnelUrl };
  }

  // cloudflare
  if (!fs.existsSync(CLOUDFLARED)) {
    return { ok: false, error: "NO_CLOUDFLARED", hint: "Chưa có cloudflared — bấm 'Tải cloudflared' trong thẻ Tunnel." };
  }
  await fsp.writeFile(inst.tunnelLog, "");
  const pid = spawnDetached(CLOUDFLARED, ["tunnel", "--url", `http://localhost:${port}`], inst.tunnelLog);
  invalidateProcessScanCache();
  await writePidFile(inst.tunnelPid, pid);

  let url = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !url) {
    const tail = await tailFile(inst.tunnelLog, 40000);
    const m = tail.match(TUNNEL_URL_RE);
    if (m) url = m[0];
    if (!url) await new Promise((r) => setTimeout(r, 400));
  }
  if (!url) {
    killPidTree(pid);
    await writePidFile(inst.tunnelPid, null);
    const tail = await tailFile(inst.tunnelLog);
    return { ok: false, error: "Không nhận được URL tunnel. Log cuối:\n" + tail.slice(-1500) };
  }
  await updateInstanceConfig(name, (config) => { config.lastTunnelUrl = url; });
  return { ok: true, mode: "cloudflare", url };
}

async function stopTunnelUnlocked(name) {
  const st = await tunnelStatus(name);
  if (!st.running) return { ok: true, alreadyStopped: true, mode: st.mode };
  const inst = instPaths(name);
  const env = await readInstanceEnv(name);
  const port = Number(env.PORT || "3000");
  // Chỉ giết tunnel của CHÍNH instance này (lọc theo profile / cổng) — tree-kill cả codex worker con
  let killed = false;
  for (const p of pidsWithCmdLine("tunnel-client.exe", inst.profile)) {
    killPidTree(p);
    killed = true;
  }
  for (const p of pidsWithCmdLine("cloudflared.exe", `localhost:${port}`)) {
    killPidTree(p);
    killed = true;
  }
  invalidateProcessScanCache();
  // No blind image-name fallback: a stale PID/name can belong to an unrelated tunnel.
  await writePidFile(inst.tunnelPid, null);
  const stopped = await waitFor(async () => {
    if (st.mode === "openai") return !(await tunnelClientHealth(st.healthPort));
    return pidsWithCmdLine("cloudflared.exe", `localhost:${port}`).length === 0;
  }, 10000, 150);
  if (!stopped) {
    return { ok: false, mode: st.mode, stopped: false, error: "Tunnel process did not stop within 10 seconds." };
  }
  return { ok: true, mode: st.mode, stopped: true, forced: killed };
}

async function startTunnel(name) {
  return enqueueTunnelLifecycle(name, () => startTunnelUnlocked(name));
}

async function stopTunnel(name) {
  return enqueueTunnelLifecycle(name, () => stopTunnelUnlocked(name));
}

async function restartTunnel(name) {
  return enqueueTunnelLifecycle(name, async () => {
    const before = await tunnelStatus(name);
    const stopped = await stopTunnelUnlocked(name);
    if (!stopped.ok) return { ...stopped, restarted: false };
    const started = await startTunnelUnlocked(name);
    if (!started.ok) return { ...started, restarted: false, stop: stopped };
    return { ...started, ok: true, restarted: true, previousMode: before.mode };
  });
}

async function downloadCloudflared() {
  if (fs.existsSync(CLOUDFLARED)) return { ok: true, alreadyExists: true };
  const res = await fetch(CLOUDFLARED_DOWNLOAD_URL, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) return { ok: false, error: `Tải thất bại: HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  await atomicWriteFile(CLOUDFLARED, buf);
  return { ok: true, bytes: buf.length };
}

/* ------------------------------------------------------------------ */
async function ensureFolderPicker() {
  if (fs.existsSync(FOLDER_PICKER_EXE) && fs.existsSync(FOLDER_PICKER_CS)) {
    // Rebuild khi source mới hơn exe (>1s tránh sai lệch mtime).
    const stExe = fs.statSync(FOLDER_PICKER_EXE).mtimeMs;
    const stCs = fs.statSync(FOLDER_PICKER_CS).mtimeMs;
    if (stCs <= stExe + 1000) return { ok: true };
  }
  if (!CSC_PATH || !fs.existsSync(FOLDER_PICKER_CS)) {
    return { ok: false, error: "Thiếu csc.exe hoặc folder-picker.cs" };
  }
  try {
    await fsp.mkdir(path.dirname(FOLDER_PICKER_EXE), { recursive: true });
    const res = spawnSync(CSC_PATH, ["/nologo", "/target:exe", `/out:${FOLDER_PICKER_EXE}`, FOLDER_PICKER_CS], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.status !== 0 || !fs.existsSync(FOLDER_PICKER_EXE)) {
      return { ok: false, error: "Compile folder-picker thất bại: " + (res.stderr || res.stdout || "").trim().slice(-200) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "Compile folder-picker lỗi: " + String((err && err.message) || err).slice(-200) };
  }
}

async function pickFolder(initialDir = "") {
  // Native MODERN Windows folder dialog via a tiny compiled .NET helper
  // (IFileDialog style — nhanh ~200ms, đẹp như dialog Explorer). No PowerShell.
  const prep = await ensureFolderPicker();
  if (!prep.ok) return { ok: false, cancelled: false, error: prep.error };
  try {
    console.log("[picker] launching " + FOLDER_PICKER_EXE + " initial=" + JSON.stringify(initialDir));
    const res = await new Promise((resolve, reject) => {
      const child = spawn(FOLDER_PICKER_EXE, [], {
        // windowsHide:false — dialog Show() cần console process có desktop
        // hiển thị (ẩn đi sẽ khiến Show trả lỗi); console đen hiện ~1s rồi tắt.
        windowsHide: false,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FOLDER_PICKER_INITIAL: initialDir || "" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        resolve({ status: -1, stdout, stderr });
      }, 180000);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ status: code, stdout, stderr });
      });
    });
    const picked = (res.stdout || "").trim();
    if (picked) return { ok: true, cancelled: false, path: picked };
    if (res.status !== 0) {
      return { ok: false, cancelled: false, error: (res.stderr || "").trim().slice(-300) || "folder-picker lỗi (exit " + res.status + ")" };
    }
    return { ok: true, cancelled: true, path: "" };
  } catch (err) {
    return { ok: false, cancelled: false, error: String((err && err.message) || err).slice(-300) };
  }
}

const SESSION_POLICY_DEFAULTS = {
  MCP_SESSION_TTL_MS: 120000,
  MCP_SESSION_CLEANUP_MS: 15000,
  MCP_SESSION_DELETE_GRACE_MS: 45000,
  MCP_MAX_SESSIONS: 64,
};

const RUNTIME_LIMIT_SPECS = [
  ["SHELL_TIMEOUT", 120, 1, 86400],
  ["ACTIVITY_LOG_MAX", 500, 1, 100000],
  ["AUTO_MEMORY_MAX_BYTES", 25000, 1024, 10000000],
  ["AUTO_MEMORY_MAX_LINES", 200, 1, 10000],
  ["CHECKPOINT_MAX_COUNT", 500, 1, 100000],
  ["CHECKPOINT_RETENTION_DAYS", 30, 1, 3650],
  ["CHECKPOINT_MAX_FILE_BYTES", 5242880, 1024, 1073741824],
  ["AUDIT_LOG_MAX_BYTES", 10485760, 1024, 1073741824],
  ["PROCESS_MAX_RUNNING", 16, 1, 128],
  ["PROCESS_HISTORY_MAX", 32, 1, 1000],
  ["PROCESS_LOG_MAX_CHARS", 200000, 4096, 2000000],
];

/**
 * Fill missing/empty session-policy keys in an existing instance .env so the
 * documented defaults are persisted (survive manager restarts) instead of
 * silently relying on the server's process-level fallback. Invalid values are
 * left untouched and surfaced by validateSessionPolicy/checkConfig instead.
 */
async function ensureSessionPolicyDefaults(name) {
  const file = instPaths(name).env;
  return enqueueFileMutation(file, async () => {
    try {
      // Re-read inside the same mutation queue used by saveInstanceEnv so an
      // auto-start/default-fill cannot overwrite a concurrent config save.
      const raw = await readInstanceEnvRaw(name);
      if (!raw.includes("=")) return { changed: false };
      const env = parseDotEnv(raw);
      const updates = {};
      for (const [key, fallback] of Object.entries(SESSION_POLICY_DEFAULTS)) {
        const current = String(env[key] ?? "").trim();
        if (current === "") updates[key] = String(fallback);
      }
      if (Object.keys(updates).length === 0) return { changed: false };
      const next = serializeDotEnv({ ...env, ...updates }, raw);
      await atomicWriteFile(file, next, "utf8");
      return { changed: true, updates };
    } catch {
      return { changed: false };
    }
  });
}

function validateSessionPolicy(env) {
  const specs = [
    ["MCP_SESSION_TTL_MS", SESSION_POLICY_DEFAULTS.MCP_SESSION_TTL_MS, 15000, 86400000],
    ["MCP_SESSION_CLEANUP_MS", SESSION_POLICY_DEFAULTS.MCP_SESSION_CLEANUP_MS, 1000, 600000],
    ["MCP_SESSION_DELETE_GRACE_MS", SESSION_POLICY_DEFAULTS.MCP_SESSION_DELETE_GRACE_MS, 1000, 600000],
    ["MCP_MAX_SESSIONS", SESSION_POLICY_DEFAULTS.MCP_MAX_SESSIONS, 8, 4096],
  ];
  const values = {};
  const errors = [];
  for (const [key, fallback, min, max] of specs) {
    const raw = String(env[key] ?? "").trim();
    const value = raw === "" ? fallback : Number(raw);
    values[key] = value;
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${key} phải là số nguyên ${min}–${max} (hiện tại: ${raw || `(mặc định ${fallback})`})`);
    }
  }
  if (
    Number.isInteger(values.MCP_SESSION_CLEANUP_MS) &&
    Number.isInteger(values.MCP_SESSION_TTL_MS) &&
    values.MCP_SESSION_CLEANUP_MS > values.MCP_SESSION_TTL_MS
  ) {
    errors.push("MCP_SESSION_CLEANUP_MS không nên lớn hơn MCP_SESSION_TTL_MS");
  }
  return { ok: errors.length === 0, errors, values };
}

function validateRuntimeLimits(env) {
  const values = {};
  const errors = [];
  for (const [key, fallback, min, max] of RUNTIME_LIMIT_SPECS) {
    const raw = String(env[key] ?? "").trim();
    const value = raw === "" ? fallback : Number(raw);
    values[key] = value;
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${key} phải là số nguyên ${min}–${max} (hiện tại: ${raw || `(mặc định ${fallback})`})`);
    }
  }
  return { ok: errors.length === 0, errors, values };
}

async function checkConfig(name, overrides) {
  const env = { ...(await readInstanceEnv(name)), ...(overrides || {}) };
  const items = [];
  const push = (ok, label, detail) => items.push({ ok, label, detail });

  // Server chạy với cwd = ROOT, nên đường dẫn tương đối được resolve theo ROOT
  let ws = env.WORKSPACE_PATH || "";
  if (ws && !path.isAbsolute(ws)) ws = path.resolve(ROOT, ws);
  try {
    const st = await fsp.stat(ws);
    push(st.isDirectory(), "WORKSPACE_PATH", `${ws} (${st.isDirectory() ? "tồn tại" : "KHÔNG phải thư mục"})`);
  } catch {
    push(false, "WORKSPACE_PATH", `${ws} — không tồn tại`);
  }

  const port = Number(env.PORT);
  push(Number.isInteger(port) && port > 0 && port < 65536, "PORT", env.PORT || "(trống)");
  const adminPort = Number(env.ADMIN_PORT);
  push(Number.isInteger(adminPort) && adminPort > 0 && adminPort < 65536, "ADMIN_PORT", env.ADMIN_PORT || "(trống)");
  if (port && adminPort && port === adminPort) {
    push(false, "Cổng trùng", "PORT và ADMIN_PORT không được giống nhau");
  }
  const healthPort = Number(env.OPENAI_TUNNEL_HEALTH_PORT || 8080);
  push(
    Number.isInteger(healthPort) && healthPort > 0 && healthPort < 65536,
    "OPENAI_TUNNEL_HEALTH_PORT",
    env.OPENAI_TUNNEL_HEALTH_PORT || "8080"
  );
  if (healthPort && (healthPort === port || healthPort === adminPort || healthPort === managerPortNum)) {
    push(false, "Tunnel health port", "OPENAI_TUNNEL_HEALTH_PORT phải khác PORT, ADMIN_PORT và MANAGER_PORT");
  }
  const usedPorts = await allUsedPorts(name);
  if (healthPort && usedPorts.has(healthPort)) {
    push(false, "Tunnel health port", `Port ${healthPort} đã được instance khác dùng`);
  }

  const profile = env.CHATGPT_TOOL_PROFILE || "slim";
  push(["slim", "full"].includes(profile), "CHATGPT_TOOL_PROFILE", profile);

  const sessionPolicy = validateSessionPolicy(env);
  for (const [key, value] of Object.entries(sessionPolicy.values)) {
    const error = sessionPolicy.errors.find((msg) => msg.startsWith(key));
    push(!error, key, error || String(value));
  }
  const cleanupRelationError = sessionPolicy.errors.find((msg) => msg.startsWith("MCP_SESSION_CLEANUP_MS không"));
  if (cleanupRelationError) push(false, "Session cleanup/TTL", cleanupRelationError);

  const runtimeLimits = validateRuntimeLimits(env);
  for (const [key, value] of Object.entries(runtimeLimits.values)) {
    const error = runtimeLimits.errors.find((msg) => msg.startsWith(key));
    push(!error, key, error || String(value));
  }

  // FULL_DISK_ACCESS controls path-aware tools, not native shell OS isolation.
  const fda = (env.FULL_DISK_ACCESS ?? "false").toLowerCase();
  push(
    ["true", "false"].includes(fda),
    "FULL_DISK_ACCESS",
    fda === "true" ? "true — path-aware tools dùng path toàn máy" : "false — path-aware tools chỉ workspace roots"
  );

  // EXTRA_WORKSPACE_PATHS — mỗi path phải tồn tại
  const extraRaw = (env.EXTRA_WORKSPACE_PATHS || "").trim();
  if (extraRaw) {
    const extraPaths = extraRaw.split(";").map((s) => s.trim()).filter(Boolean);
    const missing = [];
    for (const p of extraPaths) {
      const abs = path.isAbsolute(p) ? p : path.resolve(ROOT, p);
      try {
        if (!(await fsp.stat(abs)).isDirectory()) missing.push(p);
      } catch {
        missing.push(p);
      }
    }
    push(missing.length === 0, "EXTRA_WORKSPACE_PATHS", missing.length ? `Không tồn tại: ${missing.join(", ")}` : `${extraPaths.length} path: ${extraPaths.join(", ")}`);
  } else {
    push(true, "EXTRA_WORKSPACE_PATHS", "(trống — chỉ WORKSPACE_PATH)");
  }

  // Project memory giới hạn
  const memBytesRaw = (env.PROJECT_MEMORY_MAX_BYTES || "").trim();
  const memBytes = memBytesRaw === "" ? null : Number(memBytesRaw);
  const memBytesOk = memBytes === null || (Number.isInteger(memBytes) && memBytes >= 0);
  push(memBytesOk, "PROJECT_MEMORY_MAX_BYTES", memBytes === null ? "(mặc định ~25KB)" : memBytes === 0 ? "0 — không giới hạn" : `${memBytes} bytes`);
  const memLinesRaw = (env.PROJECT_MEMORY_MAX_LINES || "").trim();
  const memLines = memLinesRaw === "" ? null : Number(memLinesRaw);
  const memLinesOk = memLines === null || (Number.isInteger(memLines) && memLines >= 0);
  push(memLinesOk, "PROJECT_MEMORY_MAX_LINES", memLines === null ? "(mặc định 200)" : memLines === 0 ? "0 — không giới hạn" : `${memLines} dòng`);

  const tunnelId = env.OPENAI_TUNNEL_ID || "";
  const apiKey = env.OPENAI_TUNNEL_API_KEY || "";
  if (tunnelId || apiKey) {
    push(Boolean(tunnelId && apiKey), "OpenAI Tunnel", tunnelId && apiKey ? "Đã đủ ID + API key" : "Thiếu ID hoặc API key");
    if (tunnelId && !/^tunnel_[0-9a-f]{32}$/.test(tunnelId)) {
      push(false, "OpenAI Tunnel ID", "Định dạng phải là tunnel_ + 32 ký tự hex");
    }
    const conflicts = await findTunnelConflicts(name, tunnelId, apiKey);
    if (conflicts.length) {
      const first = conflicts[0];
      push(false, "Tunnel trùng", `ID/API key đã được instance '${first.instance}' dùng`);
    }
  } else {
    push(fs.existsSync(CLOUDFLARED), "Tunnel Cloudflare", fs.existsSync(CLOUDFLARED) ? "cloudflared.exe sẵn sàng" : "Chưa có cloudflared.exe — sẽ tải khi bật Tunnel");
  }

  push(fs.existsSync(SERVER_ENTRY), "Build", fs.existsSync(SERVER_ENTRY) ? "dist/index.js tồn tại" : "Chưa build — bấm 'Cài Đặt'");

  const st = await serverStatus(name);
  push(
    !st.portOccupied && !st.invalidConfig,
    "Server",
    st.running
      ? `Đang chạy trên cổng ${st.port}`
      : st.invalidConfig
        ? "PORT không hợp lệ"
        : st.portOccupied
          ? `Cổng ${st.port} đang bị process khác chiếm${st.pid ? ` (PID ${st.pid})` : ""}`
          : `Chưa chạy (cổng ${st.port})`
  );
  const tun = await tunnelStatus(name);
  if (tun.mode === "openai" && tun.portOccupied) {
    push(false, "Tunnel health port", `Port ${tun.healthPort} đang mở nhưng không phải tunnel-client`);
  }

  return { ok: items.every((i) => i.ok), items };
}

/** Bundle đầy đủ trạng thái một instance (cho UI). */
async function instanceBundle(name, { includeCheck = false } = {}) {
  const [env, config, srv, tun, installed] = await Promise.all([
    readInstanceEnv(name),
    readInstanceConfig(name),
    serverStatus(name),
    tunnelStatus(name),
    Promise.resolve({ dist: fs.existsSync(SERVER_ENTRY), nodeModules: fs.existsSync(path.join(ROOT, "node_modules")) }),
  ]);
  const chk = includeCheck
    ? await checkConfig(name).catch((e) => ({ ok: false, items: [], error: String((e && e.message) || e) }))
    : null;
  return {
    name,
    node: process.version,
    env: {
      PORT: env.PORT || "3000",
      ADMIN_PORT: env.ADMIN_PORT || "3001",
      WORKSPACE_PATH: env.WORKSPACE_PATH || "",
      CHATGPT_TOOL_PROFILE: env.CHATGPT_TOOL_PROFILE || "slim",
      CHATGPT_AUTO_APPROVE: env.CHATGPT_AUTO_APPROVE ?? "true",
      SHELL_TIMEOUT: env.SHELL_TIMEOUT || "120",
      MCP_SESSION_RECOVERY: env.MCP_SESSION_RECOVERY ?? "true",
      MCP_SESSION_TTL_MS: env.MCP_SESSION_TTL_MS || String(SESSION_POLICY_DEFAULTS.MCP_SESSION_TTL_MS),
      MCP_SESSION_CLEANUP_MS: env.MCP_SESSION_CLEANUP_MS || String(SESSION_POLICY_DEFAULTS.MCP_SESSION_CLEANUP_MS),
      MCP_SESSION_DELETE_GRACE_MS: env.MCP_SESSION_DELETE_GRACE_MS || String(SESSION_POLICY_DEFAULTS.MCP_SESSION_DELETE_GRACE_MS),
      MCP_MAX_SESSIONS: env.MCP_MAX_SESSIONS || String(SESSION_POLICY_DEFAULTS.MCP_MAX_SESSIONS),
      FULL_DISK_ACCESS: env.FULL_DISK_ACCESS ?? "false",
      EXTRA_WORKSPACE_PATHS: env.EXTRA_WORKSPACE_PATHS || "",
      PROJECT_MEMORY_MAX_BYTES: env.PROJECT_MEMORY_MAX_BYTES || "",
      PROJECT_MEMORY_MAX_LINES: env.PROJECT_MEMORY_MAX_LINES || "",
      OPENAI_TUNNEL_ID: env.OPENAI_TUNNEL_ID || "",
      OPENAI_TUNNEL_API_KEY_SET: Boolean(env.OPENAI_TUNNEL_API_KEY),
      OPENAI_TUNNEL_HEALTH_PORT: String(config.healthPort || env.OPENAI_TUNNEL_HEALTH_PORT || "8080"),
    },
    config: {
      connectorName: config.connectorName || "",
      autoStart: config.autoStart !== false,
      lastTunnelUrl: config.lastTunnelUrl || "",
    },
    server: srv,
    tunnel: tun,
    check: chk,
    installed,
  };
}

async function createInstance(body) {
  const name = String(body.name || "").trim().toLowerCase();
  if (!INSTANCE_NAME_RE.test(name)) {
    return { ok: false, error: "Tên instance: 2–32 ký tự, chỉ chữ thường/số/gạch ngang, bắt đầu bằng chữ hoặc số." };
  }
  if ((await listInstances()).includes(name)) {
    return { ok: false, error: `Instance '${name}' đã tồn tại.` };
  }
  const used = await allUsedPorts();
  used.add(managerPortNum);
  // Nếu client gửi port/adminPort: phải là số nguyên trong 3000–3999 (không tự cấp thay cho giá trị lỗi)
  const reqPort = body.port === undefined || body.port === null || body.port === "" ? 0 : Number(body.port);
  const reqAdmin = body.adminPort === undefined || body.adminPort === null || body.adminPort === "" ? 0 : Number(body.adminPort);
  if (reqPort !== 0 && (!Number.isInteger(reqPort) || reqPort < 3000 || reqPort > 3999)) {
    return { ok: false, error: `PORT '${body.port}' không hợp lệ — phải là số nguyên 3000–3999 (để trống = tự chọn).` };
  }
  if (reqAdmin !== 0 && (!Number.isInteger(reqAdmin) || reqAdmin < 3000 || reqAdmin > 3999)) {
    return { ok: false, error: `ADMIN_PORT '${body.adminPort}' không hợp lệ — phải là số nguyên 3000–3999 (để trống = tự chọn).` };
  }
  if (reqPort && (used.has(reqPort) || await isPortOpen(reqPort))) return { ok: false, error: `PORT ${reqPort} is already in use.` };
  if (reqAdmin && (used.has(reqAdmin) || await isPortOpen(reqAdmin))) return { ok: false, error: `ADMIN_PORT ${reqAdmin} is already in use.` };
  let port = reqPort;
  if (!port) {
    for (let candidate = 3000; candidate < 4000; candidate++) if (!used.has(candidate) && !(await isPortOpen(candidate))) { port = candidate; break; }
  }
  let adminPort = reqAdmin;
  if (!adminPort) {
    for (let candidate = 3000; candidate < 4000; candidate++) if (candidate !== port && !used.has(candidate) && !(await isPortOpen(candidate))) { adminPort = candidate; break; }
  }
  if (!port || !adminPort) return { ok: false, error: "Không tìm được cổng trống trong 3000–3999." };
  if (port === adminPort) return { ok: false, error: "PORT và ADMIN_PORT không được giống nhau." };
  if (used.has(port)) return { ok: false, error: `Cổng ${port} đã được instance khác (hoặc manager) dùng.` };
  if (used.has(adminPort)) return { ok: false, error: `Cổng ${adminPort} đã được instance khác (hoặc manager) dùng.` };
  let healthPort = 0;
  for (let candidate = 8080; candidate < 8200; candidate++) {
    if (!used.has(candidate) && candidate !== port && candidate !== adminPort && candidate !== managerPortNum && !(await isPortOpen(candidate))) { healthPort = candidate; break; }
  }
  if (!healthPort) return { ok: false, error: "No free tunnel health port found in 8080-8199." };
  const inst = instPaths(name);
  await fsp.mkdir(inst.dir, { recursive: true });
  const ws = String(body.workspacePath || "").trim();
  const envText = [
    `PORT=${port}`,
    `ADMIN_PORT=${adminPort}`,
    `WORKSPACE_PATH=${ws}`,
    "OPENAI_TUNNEL_ID=",
    "OPENAI_TUNNEL_API_KEY=",
    `OPENAI_TUNNEL_HEALTH_PORT=${healthPort}`,
    "CHATGPT_TOOL_PROFILE=slim",
    "CHATGPT_AUTO_APPROVE=true",
    "SHELL_TIMEOUT=120",
    "MCP_SESSION_RECOVERY=true",
    `MCP_SESSION_TTL_MS=${SESSION_POLICY_DEFAULTS.MCP_SESSION_TTL_MS}`,
    `MCP_SESSION_CLEANUP_MS=${SESSION_POLICY_DEFAULTS.MCP_SESSION_CLEANUP_MS}`,
    `MCP_SESSION_DELETE_GRACE_MS=${SESSION_POLICY_DEFAULTS.MCP_SESSION_DELETE_GRACE_MS}`,
    `MCP_MAX_SESSIONS=${SESSION_POLICY_DEFAULTS.MCP_MAX_SESSIONS}`,
    "",
  ].join("\n");
  await atomicWriteFile(inst.env, envText, "utf8");
  await writeInstanceConfig(name, {
    connectorName: body.connectorName ? String(body.connectorName).slice(0, 80) : "",
    lastTunnelUrl: "",
    healthPort,
    autoStart: body.autoStart !== false,
  });
  return { ok: true, name, port, adminPort, healthPort, workspace: ws };
}

async function deleteInstance(name) {
  if (!INSTANCE_NAME_RE.test(name)) return { ok: false, error: "Tên không hợp lệ." };
  if (name === "default") return { ok: false, error: "Instance 'default' là mặc định, không xóa được." };
  const inst = instPaths(name);

  // Fail closed: never delete the only metadata/profile/PID files for a process
  // we failed to stop. Otherwise a transient lifecycle failure can turn a managed
  // server/tunnel into an orphan that the Manager can no longer identify safely.
  let tunnelStop;
  try {
    tunnelStop = await stopTunnel(name);
  } catch (err) {
    return { ok: false, error: `Không thể dừng Tunnel trước khi xóa '${name}': ${String(err?.message || err)}` };
  }
  if (!tunnelStop?.ok) {
    return { ok: false, error: `Không thể dừng Tunnel trước khi xóa '${name}': ${tunnelStop?.error || "unknown error"}` };
  }

  let serverStop;
  try {
    serverStop = await stopServer(name);
  } catch (err) {
    return { ok: false, error: `Không thể dừng Server trước khi xóa '${name}': ${String(err?.message || err)}` };
  }
  if (!serverStop?.ok) {
    return { ok: false, error: `Không thể dừng Server trước khi xóa '${name}': ${serverStop?.error || "unknown error"}` };
  }

  const [serverAfter, tunnelAfter] = await Promise.all([serverStatus(name), tunnelStatus(name)]);
  if (serverAfter.running || tunnelAfter.running) {
    return {
      ok: false,
      error: `Từ chối xóa '${name}': process vẫn đang chạy sau stop (server=${serverAfter.running}, tunnel=${tunnelAfter.running}).`,
    };
  }

  // Windows có thể giữ file vài trăm ms sau taskkill — retry ngắn trước khi báo lỗi
  for (let i = 0; i < 5; i++) {
    try {
      await fsp.rm(inst.dir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  if (fs.existsSync(inst.dir)) {
    return { ok: false, error: `Xóa instance '${name}' thất bại — thư mục vẫn tồn tại. Hãy thử lại sau khi dừng server/tunnel.` };
  }
  return { ok: true, name };
}
async function renameInstance(name, body) {
  if (!INSTANCE_NAME_RE.test(name)) return { ok: false, error: "Tên không hợp lệ." };
  if (name === "default") return { ok: false, error: "Instance 'default' là instance mặc định, không đổi tên được." };
  const newName = String(body.name || "").trim().toLowerCase();
  if (!INSTANCE_NAME_RE.test(newName)) {
    return { ok: false, error: "Tên mới: 2–32 ký tự, chỉ chữ thường/số/gạch ngang, bắt đầu bằng chữ hoặc số." };
  }
  if (newName === name) return { ok: true, name, renamed: false };
  if ((await listInstances()).includes(newName)) {
    return { ok: false, error: `Instance '${newName}' đã tồn tại.` };
  }
  // Chặn đổi tên khi server/tunnel đang chạy (pid files theo tên thư mục — đổi lúc chạy sẽ mất dấu process)
  const [srv, tun] = await Promise.all([serverStatus(name), tunnelStatus(name)]);
  if (srv.running || tun.running) {
    return { ok: false, error: "Phải dừng Server và Tunnel trước khi đổi tên workspace." };
  }
  const src = instPaths(name);
  const dst = instPaths(newName);
  await fsp.mkdir(INSTANCES_DIR, { recursive: true });
  try {
    await fsp.rename(src.dir, dst.dir);
  } catch (err) {
    return { ok: false, error: "Đổi tên thất bại: " + String((err && err.message) || err) };
  }
  return { ok: true, name: newName, renamed: true };
}
async function saveInstanceEnvUnlocked(name, body) {
  const inst = instPaths(name);
  const original = await readInstanceEnvRaw(name);
  const originalValues = parseDotEnv(original);
  let next;
  if (typeof body.raw === "string") {
    next = body.raw
      .split(/\r?\n/)
      .map((line) => {
        const m = ENV_LINE_RE.exec(line.trim());
        if (!m || m[2].trim() !== MASK_SENTINEL) return line;
        const orig = originalValues[m[1]];
        return orig !== undefined ? `${m[1]}=${orig}` : line;
      })
      .join("\n");
  } else {
    const values = { ...(body.values || {}) };
    if (!(body.values && Object.prototype.hasOwnProperty.call(body.values, "ADMIN_PORT"))) {
      if (originalValues.ADMIN_PORT) values.ADMIN_PORT = originalValues.ADMIN_PORT;
    }
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) values[key] = null;
      else if (value === MASK_SENTINEL) values[key] = originalValues[key] !== undefined ? originalValues[key] : null;
    }
    next = serializeDotEnv(values, original);
  }

  const parsed = parseDotEnv(next);
  const sessionPolicy = validateSessionPolicy(parsed);
  if (!sessionPolicy.ok) return { ok: false, error: sessionPolicy.errors.join("; ") };
  const runtimeLimits = validateRuntimeLimits(parsed);
  if (!runtimeLimits.ok) return { ok: false, error: runtimeLimits.errors.join("; ") };

  const port = Number(parsed.PORT);
  const adminPort = Number(parsed.ADMIN_PORT);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536 || !Number.isInteger(adminPort) || adminPort <= 0 || adminPort >= 65536) {
    return { ok: false, error: "PORT and ADMIN_PORT must be integers in 1-65535." };
  }
  if (port === adminPort) return { ok: false, error: "PORT and ADMIN_PORT must differ." };

  const used = await allUsedPorts(name);
  used.add(managerPortNum);
  if (used.has(port)) return { ok: false, error: `PORT ${port} is already used by another instance or the manager.` };
  if (used.has(adminPort)) return { ok: false, error: `ADMIN_PORT ${adminPort} is already used by another instance or the manager.` };

  const hp = Number(parsed.OPENAI_TUNNEL_HEALTH_PORT || 8080);
  if (!Number.isInteger(hp) || hp <= 0 || hp >= 65536) return { ok: false, error: "OPENAI_TUNNEL_HEALTH_PORT must be an integer in 1-65535." };
  if (hp === port || hp === adminPort || hp === managerPortNum) return { ok: false, error: "OPENAI_TUNNEL_HEALTH_PORT must differ from PORT, ADMIN_PORT and MANAGER_PORT." };
  if (used.has(hp)) return { ok: false, error: `Tunnel health port ${hp} is already used by another instance.` };

  const oldPort = Number(originalValues.PORT || 0);
  const oldAdminPort = Number(originalValues.ADMIN_PORT || 0);
  const oldHealthPort = Number(originalValues.OPENAI_TUNNEL_HEALTH_PORT || 0);
  if (port !== oldPort && await isPortOpen(port)) return { ok: false, error: `PORT ${port} is occupied by another process.` };
  if (adminPort !== oldAdminPort && await isPortOpen(adminPort)) return { ok: false, error: `ADMIN_PORT ${adminPort} is occupied by another process.` };
  if (hp !== oldHealthPort && await isPortOpen(hp)) return { ok: false, error: `Tunnel health port ${hp} is occupied by another process.` };

  const conflicts = await findTunnelConflicts(name, parsed.OPENAI_TUNNEL_ID, parsed.OPENAI_TUNNEL_API_KEY);
  if (conflicts.length) {
    const first = conflicts[0];
    return { ok: false, error: `Tunnel ${first.field === "OPENAI_TUNNEL_ID" ? "ID" : "API key"} '${first.value}' is already used by instance '${first.instance}'; each workspace must use its own tunnel.` };
  }

  await atomicWriteFile(inst.env, next, "utf8");
  await updateInstanceConfig(name, (config) => { config.healthPort = hp; });
  return { ok: true, path: inst.env };
}

async function saveInstanceEnv(name, body) {
  const file = instPaths(name).env;
  return enqueueFileMutation(file, () => saveInstanceEnvUnlocked(name, body));
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  let tooBig = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      tooBig = true;
      continue; // drain hết body để client không nghẽn, rồi trả 413
    }
    chunks.push(chunk);
  }
  if (tooBig) {
    throw Object.assign(new Error("Request body quá lớn (tối đa 1MB)."), { status: 413 });
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  });
}
/** Proxy /admin/* → 127.0.0.1:<ADMIN_PORT> của instance (gộp admin UI vào cổng manager). */
function proxyAdmin(req, res, targetPort, pathname) {
  let done = false;
  const finish = (fn) => (...args) => {
    if (done) return;
    done = true;
    fn(...args);
  };
  const options = {
    hostname: "127.0.0.1",
    port: targetPort,
    path: pathname + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""),
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
  };
  const proxyReq = http.request(options, finish((proxyRes) => {
    const headers = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      // bỏ hop-by-hop headers (connection/transfer-encoding...) — không forward nguyên trạng
      if (["connection", "transfer-encoding", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"].includes(k.toLowerCase())) continue;
      headers[k] = v;
    }
    res.writeHead(proxyRes.statusCode || 502, headers);
    proxyRes.on("error", finish(() => res.destroy()));
    proxyRes.pipe(res);
  }));
  req.on("error", finish(() => res.destroy()));
  proxyReq.setTimeout(30000, () => {
    proxyReq.destroy(new Error("Admin server timeout"));
  });
  proxyReq.on("error", finish((err) => {
    if (!res.headersSent) {
      json(res, 502, { ok: false, error: `Admin server của instance chưa chạy (${targetPort}): ${err.message}` });
    } else {
      res.destroy();
    }
  }));
  req.pipe(proxyReq);
}

/** Instance mặc định cho các route cũ (alias) — ưu tiên "default", nếu đã xóa thì lấy instance đầu tiên. */
async function defaultInstanceName() {
  const names = await listInstances();
  return names.includes("default") ? "default" : names[0] || null;
}

async function handleApi(req, res, url, body) {
  const p = url.pathname;
  if (req.method === "GET" && p === "/api/instances") {
    const names = await listInstances();
    const instances = await Promise.all(names.map(async (n) => {
      try {
        return await instanceBundle(n, { includeCheck: false });
      } catch (err) {
        // một instance lỗi (vd env bị xóa) không được làm 500 toàn bộ list
        return {
          name: n,
          node: process.version,
          error: String((err && err.message) || err),
          env: {},
          config: { connectorName: "", autoStart: true, lastTunnelUrl: "" },
          server: { running: false, port: 0, pid: null, health: null },
          tunnel: { running: false, mode: "cloudflare", kind: null, url: null, healthPort: 8080, cloudflaredExists: false },
          check: { ok: false, items: [], error: String((err && err.message) || err) },
          installed: { dist: fs.existsSync(SERVER_ENTRY), nodeModules: fs.existsSync(path.join(ROOT, "node_modules")) },
        };
      }
    }));
    return json(res, 200, { ok: true, instances });
  }
  if (!(await listInstances()).length) {
    const noInst = {
      ok: false,
      error: "Chưa có instance nào — tạo workspace trước.",
      instances: [],
      env: {},
      config: { connectorName: "" },
      server: { running: false, port: 3000, pid: null, health: null },
      tunnel: { running: false, mode: "cloudflare", kind: null, url: null, healthPort: 8080, cloudflaredExists: false },
    };
    if (req.method === "GET" && p === "/api/instances") return json(res, 200, { ok: true, instances: [] });
    if (req.method === "POST" && p === "/api/instances") return json(res, 200, await createInstance(body));
    if (
      p.startsWith("/api/instances/") || p === "/api/status" || p === "/api/env" ||
      p === "/api/config" || p === "/api/server" || p === "/api/tunnel" ||
      p === "/api/check" || p === "/api/pick-folder"
    ) {
      return json(res, 404, noInst);
    }
  }


  if (req.method === "POST" && p === "/api/instances") {
    return json(res, 200, await createInstance(body));
  }

  const instMatch = /^\/api\/instances\/([^/]+)(\/.*)?$/.exec(p);
  if (instMatch) {
    const name = decodeURIComponent(instMatch[1]);
    const sub = instMatch[2] || "";
    const exists = (await listInstances()).includes(name);
    if (!INSTANCE_NAME_RE.test(name) || !exists) {
      return json(res, 404, { ok: false, error: `Instance '${name}' không tồn tại` });
    }
    const inst = instPaths(name);

    if (req.method === "POST" && sub === "") return json(res, 200, await instanceBundle(name, { includeCheck: true }));
    if (req.method === "DELETE" && sub === "") return json(res, 200, await deleteInstance(name));
    if (req.method === "POST" && sub === "/rename") return json(res, 200, await renameInstance(name, body));

    if (req.method === "GET" && sub === "/env") {
      const raw = await readInstanceEnvRaw(name);
      const values = parseDotEnv(raw);
      const masked = {};
      for (const [k, v] of Object.entries(values)) {
        // Never ship the plaintext .env to the browser. Secret keys are replaced
        // with a sentinel; saveInstanceEnv restores the original value when the
        // UI round-trips the sentinel unchanged. OPENAI_TUNNEL_API_KEY keeps its
        // set/last4 shape for the structured form's key hint.
        if (k === "OPENAI_TUNNEL_API_KEY" && v) masked[k] = { set: true, last4: v.slice(-4) };
        else if (SECRET_KEY_RE.test(k) && v) masked[k] = MASK_SENTINEL;
        else masked[k] = v;
      }
      return json(res, 200, { ok: true, path: inst.env, values: masked });
    }
    if (req.method === "PUT" && sub === "/env") return json(res, 200, await saveInstanceEnv(name, body));

    if (req.method === "GET" && sub === "/config") return json(res, 200, { ok: true, ...(await readInstanceConfig(name)) });
    if (req.method === "PUT" && sub === "/config") {
      const config = await updateInstanceConfig(name, (config) => {
        if (typeof body.connectorName === "string") config.connectorName = body.connectorName.slice(0, 80);
        if (typeof body.lastTunnelUrl === "string") config.lastTunnelUrl = body.lastTunnelUrl;
        if (typeof body.autoStart === "boolean") config.autoStart = body.autoStart;
      });
      return json(res, 200, { ok: true, config });
    }

    if (req.method === "POST" && sub === "/check") return json(res, 200, await checkConfig(name, body && body.values));

    if (req.method === "POST" && sub === "/server/start") return json(res, 200, await startServer(name));
    if (req.method === "POST" && sub === "/server/stop") return json(res, 200, await stopServer(name));
    if (req.method === "POST" && sub === "/server/restart") return json(res, 200, await restartServer(name));

    if (req.method === "POST" && sub === "/tunnel/start") return json(res, 200, await startTunnel(name));
    if (req.method === "POST" && sub === "/tunnel/stop") return json(res, 200, await stopTunnel(name));
    if (req.method === "POST" && sub === "/tunnel/restart") return json(res, 200, await restartTunnel(name));

    if (req.method === "POST" && sub === "/pick-folder") {
      const env = await readInstanceEnv(name);
      return json(res, 200, await pickFolder(env.WORKSPACE_PATH || ""));
    }

    if (req.method === "GET" && sub.startsWith("/log")) {
      const kind = url.searchParams.get("kind") === "tunnel" ? "tunnel" : "server";
      const maxRaw = url.searchParams.get("max");
      const maxParsed = maxRaw === null || maxRaw.trim() === "" ? 300000 : Number(maxRaw);
      const max = Number.isSafeInteger(maxParsed) && maxParsed >= 1024 && maxParsed <= 1048576 ? maxParsed : 300000;
      const file = kind === "tunnel" ? inst.tunnelLog : inst.serverLog;
      const st = await fsp.stat(file).catch(() => null);
      const ifSize = Number(url.searchParams.get("if_size"));
      const ifMtime = Number(url.searchParams.get("if_mtime"));
      if (st && Number.isFinite(ifSize) && Number.isFinite(ifMtime) && ifSize === st.size && ifMtime === st.mtimeMs) {
        return json(res, 200, { ok: true, kind, unchanged: true, log: "", size: st.size, mtime: st.mtimeMs });
      }
      const rawLog = st ? await tailFile(file, max) : "";
      let log = rawLog;
      if (st && st.size > max) {
        const nl = log.indexOf("\n");
        if (nl > 0) log = log.slice(nl + 1);
      }
      return json(res, 200, { ok: true, kind, log, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 });
    }
    return json(res, 404, { ok: false, error: "Not found" });
  }

  /* ---------------- legacy single-instance routes (alias → default) ---------------- */
  const dname = await defaultInstanceName();
  if (!dname) {
    return json(res, 200, {
      ok: true,
      migrated: false,
      error: "Chưa có instance nào — tạo qua POST /api/instances",
      env: {},
      config: { connectorName: "" },
      server: { running: false, port: 3000, pid: null, health: null },
      tunnel: { running: false, mode: "cloudflare", kind: null, url: null, healthPort: 8080, cloudflaredExists: false },
    });
  }

  if (req.method === "GET" && p === "/api/status") {
    const [env, config, srv, tun, installed] = await Promise.all([
      readInstanceEnv(dname),
      readInstanceConfig(dname),
      serverStatus(dname),
      tunnelStatus(dname),
      Promise.resolve({ dist: fs.existsSync(SERVER_ENTRY), nodeModules: fs.existsSync(path.join(ROOT, "node_modules")) }),
    ]);
    return json(res, 200, {
      ok: true,
      root: ROOT,
      installed,
      node: process.version,
      server: srv,
      env: {
        PORT: env.PORT || "3000",
        ADMIN_PORT: env.ADMIN_PORT || "3001",
        WORKSPACE_PATH: env.WORKSPACE_PATH || "",
        CHATGPT_TOOL_PROFILE: env.CHATGPT_TOOL_PROFILE || "slim",
        CHATGPT_AUTO_APPROVE: env.CHATGPT_AUTO_APPROVE ?? "true",
        SHELL_TIMEOUT: env.SHELL_TIMEOUT || "120",
        MCP_SESSION_RECOVERY: env.MCP_SESSION_RECOVERY ?? "true",
        MCP_SESSION_TTL_MS: env.MCP_SESSION_TTL_MS || String(SESSION_POLICY_DEFAULTS.MCP_SESSION_TTL_MS),
        MCP_SESSION_CLEANUP_MS: env.MCP_SESSION_CLEANUP_MS || String(SESSION_POLICY_DEFAULTS.MCP_SESSION_CLEANUP_MS),
        MCP_SESSION_DELETE_GRACE_MS: env.MCP_SESSION_DELETE_GRACE_MS || String(SESSION_POLICY_DEFAULTS.MCP_SESSION_DELETE_GRACE_MS),
        MCP_MAX_SESSIONS: env.MCP_MAX_SESSIONS || String(SESSION_POLICY_DEFAULTS.MCP_MAX_SESSIONS),
        OPENAI_TUNNEL_ID: env.OPENAI_TUNNEL_ID || "",
        OPENAI_TUNNEL_API_KEY_SET: Boolean(env.OPENAI_TUNNEL_API_KEY),
        OPENAI_TUNNEL_HEALTH_PORT: String(config.healthPort || env.OPENAI_TUNNEL_HEALTH_PORT || "8080"),
      },
      config: { connectorName: config.connectorName || "" },
    });
  }

  if (req.method === "GET" && p === "/api/env") {
    const raw = await readInstanceEnvRaw(dname);
    const values = parseDotEnv(raw);
    const masked = {};
    for (const [k, v] of Object.entries(values)) {
      if (k === "OPENAI_TUNNEL_API_KEY" && v) masked[k] = { set: true, last4: v.slice(-4) };
      else if (SECRET_KEY_RE.test(k) && v) masked[k] = MASK_SENTINEL;
      else masked[k] = v;
    }
    return json(res, 200, { ok: true, path: instPaths(dname).env, values: masked });
  }


  if (req.method === "PUT" && p === "/api/env") {
    return json(res, 200, await saveInstanceEnv(dname, body));
  }

  if (req.method === "GET" && p === "/api/config") {
    return json(res, 200, { ok: true, ...(await readInstanceConfig(dname)) });
  }

  if (req.method === "PUT" && p === "/api/config") {
    const config = await updateInstanceConfig(dname, (config) => {
      if (typeof body.connectorName === "string") config.connectorName = body.connectorName.slice(0, 80);
      if (typeof body.lastTunnelUrl === "string") config.lastTunnelUrl = body.lastTunnelUrl;
    });
    return json(res, 200, { ok: true, config });
  }

  if (req.method === "GET" && p === "/api/profiles") {
    const profiles = await mutateJson(PROFILES_PATH, {}, (profiles) => scrubProfiles(profiles));
    return json(res, 200, { ok: true, profiles });
  }

  if (req.method === "POST" && p === "/api/profiles") {
    const profileName = String(body.name || "").trim();
    if (!profileName) return json(res, 400, { ok: false, error: "Profile name is required." });
    if (!/^[a-zA-Z0-9._-]{1,40}$/.test(profileName)) {
      return json(res, 400, { ok: false, error: "Profile name must be 1-40 characters: letters, numbers, dot, dash or underscore." });
    }
    const profiles = await mutateJson(PROFILES_PATH, {}, (profiles) => {
      scrubProfiles(profiles);
      profiles[profileName] = { savedAt: new Date().toISOString(), values: withoutSecrets(body.values || {}) };
      return profiles;
    });
    return json(res, 200, { ok: true, profiles });
  }

  if (req.method === "DELETE" && p === "/api/profiles") {
    const profileName = String(url.searchParams.get("name") || "").trim();
    const profiles = await mutateJson(PROFILES_PATH, {}, (profiles) => {
      scrubProfiles(profiles);
      if (profiles[profileName]) delete profiles[profileName];
      return profiles;
    });
    return json(res, 200, { ok: true, profiles });
  }

  if (req.method === "POST" && p === "/api/install") {
    const result = await runInstall();
    return json(res, result.ok ? 200 : 500, result);
  }

  if (req.method === "POST" && p === "/api/check") {
    return json(res, 200, await checkConfig(dname, body && body.values));
  }

  if (req.method === "POST" && p === "/api/server/start") {
    return json(res, 200, await startServer(dname));
  }

  if (req.method === "POST" && p === "/api/server/stop") {
    return json(res, 200, await stopServer(dname));
  }

  if (req.method === "POST" && p === "/api/server/restart") {
    return json(res, 200, await restartServer(dname));
  }

  if (req.method === "POST" && p === "/api/tunnel/start") {
    return json(res, 200, await startTunnel(dname));
  }

  if (req.method === "POST" && p === "/api/tunnel/stop") {
    return json(res, 200, await stopTunnel(dname));
  }

  if (req.method === "POST" && p === "/api/tunnel/restart") {
    return json(res, 200, await restartTunnel(dname));
  }

  if (req.method === "POST" && p === "/api/tunnel/download") {
    return json(res, 200, await downloadCloudflared());
  }

  if (req.method === "POST" && p === "/api/pick-folder") {
    const env = await readInstanceEnv(dname);
    return json(res, 200, await pickFolder(env.WORKSPACE_PATH || ""));
  }

  // --- Autostart manager khi đăng nhập Windows (Startup folder .lnk) ---
  if (p === "/api/autostart") {
    if (req.method === "GET") {
      const on = fs.existsSync(STARTUP_LNK);
      return json(res, 200, { ok: true, enabled: on, lnk: STARTUP_LNK });
    }
    if (req.method === "POST") {
      const enable = Boolean(body && body.enabled);
      if (enable) {
        if (!fs.existsSync(STARTUP_LNK)) {
          // Tạo shortcut .lnk trỏ manager-hidden.vbs (wscript, ẩn hoàn toàn khi login)
          // VBS tự tái tạo mỗi lần bật autostart — manager/state/ bị gitignore nên không commit file
          const vbsBody =
            "Set sh = CreateObject(\"WScript.Shell\")\n" +
            "q = Chr(34)\n" +
            'sh.Run "cmd.exe /c " & q & "' +
            MANAGER_BAT +
            '" & q, 0, False\n';
          await fsp.writeFile(MANAGER_HIDDEN_VBS, vbsBody, "utf8");
          const vbs = [
            'Set ws = CreateObject("WScript.Shell")',
            'Set lnk = ws.CreateShortcut("' + STARTUP_LNK.replace(/\\/g, "\\\\") + '")',
            'lnk.TargetPath = "' + MANAGER_HIDDEN_VBS.replace(/\\/g, "\\\\") + '"',
            'lnk.WorkingDirectory = "' + REPO_ROOT.replace(/\\/g, "\\\\") + '"',
            "lnk.WindowStyle = 7",
            'lnk.Description = "ChatGPT Local Coder Manager (multi-instance, hidden)"',
            "lnk.Save()",
          ].join("\n");
          const vbsPath = path.join(STATE_DIR, "make-startup-lnk.vbs");
          await fsp.writeFile(vbsPath, vbs, "utf8");
          const r = spawnSync("cscript", ["//nologo", "//B", vbsPath], { encoding: "utf8", windowsHide: true });
          if (r.status !== 0) {
            return json(res, 500, { ok: false, error: "Tạo shortcut autostart lỗi: " + (r.stderr || r.stdout || "").trim().slice(-200) });
          }
        }
        return json(res, 200, { ok: true, enabled: true });
      }
      // Tắt: xóa shortcut
      try {
        if (fs.existsSync(STARTUP_LNK)) await fsp.unlink(STARTUP_LNK);
        return json(res, 200, { ok: true, enabled: false });
      } catch (err) {
        return json(res, 500, { ok: false, error: "Xóa shortcut lỗi: " + String((err && err.message) || err).slice(-200) });
      }
    }
  }

  if (req.method === "GET" && p === "/api/health") {
    return json(res, 200, { ok: true, name: "chatgpt-local-coder-manager", version: "2.0.0", multiInstance: true });
  }

  return json(res, 404, { ok: false, error: "Not found" });
}

function openExternal(url) {
  try {
    // Dùng spawn bất đồng bộ + unref: cmd /c start có thể treo vô hạn trong
    // shell headless (không có desktop) — spawnSync chặn event loop (đã trace).
    const open = (cmd, args) => {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
    };
    if (IS_WIN) open("cmd", ["/c", "start", "", `"${String(url).replace(/"/g, '""')}"`]);
    else if (process.platform === "darwin") open("open", [url]);
    else open("xdg-open", [url]);
  } catch {}
}

/* Port của manager (dùng để chặn instance chiếm cổng này) — set trước khi listen. */
let managerPortNum = 3300;

async function main() {
  await ensureStateDirs();
  await ensureInstances();
  const env = await readEnv();
  const managerPortRaw = process.env.MANAGER_PORT || env.MANAGER_PORT || "3300";
  managerPortNum = Number(managerPortRaw);
  if (!Number.isInteger(managerPortNum) || managerPortNum <= 0 || managerPortNum >= 65536) {
    throw new Error(`MANAGER_PORT must be an integer in 1-65535; received ${JSON.stringify(managerPortRaw)}`);
  }
  const port = managerPortNum;
  const noOpen = process.argv.includes("--no-open");

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      if (url.pathname.startsWith("/api/")) {
        const body = ["POST", "PUT", "DELETE", "PATCH"].includes(req.method) ? await readBody(req) : {};
        await handleApi(req, res, url, body);
        return;
      }
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        const qInst = url.searchParams.get("instance");
        const instName = req.headers["x-instance-name"] || qInst;
        const name = instName && INSTANCE_NAME_RE.test(String(instName)) ? String(instName) : await defaultInstanceName();
        if (!name) {
          json(res, 404, { ok: false, error: "Chưa có instance nào" });
          return;
        }
        const env = await readInstanceEnv(name);
        const adminPort = Number(env.ADMIN_PORT || "");
        if (!Number.isInteger(adminPort) || adminPort <= 0 || adminPort >= 65536) {
          json(res, 400, { ok: false, error: `Instance '${name}' chưa có ADMIN_PORT` });
          return;
        }
        const adminPath = url.pathname.replace(/^\/admin/, "") || "/";
        proxyAdmin(req, res, adminPort, adminPath);
        return;
      }
      const file = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
      serveStatic(res, path.join(__dirname, file));
    } catch (err) {
      const status = Number.isInteger(err && err.status) ? err.status : 500;
      json(res, status, { ok: false, error: String((err && err.message) || err) });
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`[Manager] Cổng ${port} đã có manager chạy — mở http://127.0.0.1:${port}`);
      if (!noOpen) openExternal(`http://127.0.0.1:${port}`);
      process.exit(0);
    }
    console.error("[Manager] Lỗi:", err.message);
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", async () => {
    console.log("");
    console.log("=== Quản Lý ChatGPT Local Coder (multi-instance) ===");
    console.log(`Manager UI:  http://127.0.0.1:${port}`);
    console.log(`Repo root:   ${ROOT}`);
    console.log(`Instances:   ${INSTANCES_DIR}`);
    console.log("");
    if (!noOpen) openExternal(`http://127.0.0.1:${port}`);

    // Tự động bật Focus Server + Focus Tunnel cho từng instance có autoStart
    for (const name of await listInstances()) {
      const config = await readInstanceConfig(name);
      if (config.autoStart === false) {
        console.log(`[Auto] ${name}: bỏ qua (autoStart tắt)`);
        continue;
      }
      try {
        const srv = await startServer(name);
        console.log(
          srv.alreadyRunning
            ? `[Auto] ${name}: Server đã chạy (cổng ${srv.port})`
            : srv.ok
              ? `[Auto] ${name}: Server đã bật (pid ${srv.pid})`
              : `[Auto] ${name}: Server lỗi: ${String(srv.error || "").slice(0, 160)}`
        );
        const tun = await startTunnel(name);
        console.log(
          tun.alreadyRunning
            ? `[Auto] ${name}: Tunnel đã chạy (${tun.mode})`
            : tun.ok
              ? `[Auto] ${name}: Tunnel đã bật (${tun.mode}${tun.url ? " — " + tun.url : ""})`
              : `[Auto] ${name}: Tunnel lỗi: ${String(tun.error || "").slice(0, 160)}`
        );
      } catch (err) {
        console.log(`[Auto] ${name}: Lỗi không mong đợi: ${String((err && err.message) || err).slice(0, 200)}`);
      }
    }
  });
}

main();
