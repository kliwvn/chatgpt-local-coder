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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const STATE_DIR = path.join(__dirname, "state");
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

function pidOnPort(port) {
  try {
    const out = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true }).stdout || "";
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`));
      if (m && m[1] !== "0") return parseInt(m[1], 10);
    }
  } catch {}
  return null;
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
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(data, null, 2), "utf-8");
}

async function readConfig() {
  return readJson(CONFIG_PATH, { connectorName: "", lastTunnelUrl: "" });
}

async function readPidFile(p) {
  try {
    const pid = parseInt((await fsp.readFile(p, "utf-8")).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function writePidFile(p, pid) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  // Windows đôi khi trả EBUSY/EPERM khi process khác đang đọc file — retry ngắn
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (pid) await fsp.writeFile(p, String(pid), "utf-8");
      else await fsp.rm(p, { force: true });
      return;
    } catch (err) {
      if (err && err.code !== "EBUSY" && err.code !== "EPERM" && err.code !== "EACCES") throw err;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
}

/* ------------------------------------------------------------------ */
/* process detection / control                                         */
/* ------------------------------------------------------------------ */

function isPortOpen(port, host = "127.0.0.1") {
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

/** First PID of a running image (tasklist). Returns null if not found. */
async function pidOf(name) {
  try {
    const out = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${name}`], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout || "";
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^(\S+)\s+(\d+)\s/);
      if (m && m[1].toLowerCase() === name.toLowerCase()) return parseInt(m[2], 10);
    }
  } catch {}
  return null;
}


/** PID còn sống không? (tasklist /FI "PID eq n") */
function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`], { encoding: "utf8", windowsHide: true }).stdout || "";
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^(\S+)\s+(\d+)\s/);
      if (m && parseInt(m[2], 10) === pid) return true;
    }
    return false;
  } catch {
    return false;
  }
}
function spawnHiddenDetached(cmd, args, logFile, extraEnv = null) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const batPath = path.join(STATE_DIR, "spawn-hidden.cmd");
  const vbsPath = path.join(STATE_DIR, "spawn-hidden.vbs");
  const bat = `@echo off\r\ncd /d ${q(STATE_DIR)}\r\n${q(cmd)} ${args.map(q).join(" ")} >> ${q(logFile)} 2>&1\r\n`;
  // VBS dùng Chr(34) cho dấu nháy — tránh lỗi escaping chuỗi VBS
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
  child.on("error", (err) => console.error("[spawnHiddenDetached] wscript lỗi:", err.message));
  return child.pid; // wscript exits at once; the real tunnel pid is tracked via tasklist/port
}

async function tailFile(file, maxBytes = 8000) {
  try {
    const st = await fsp.stat(file);
    const size = Math.min(st.size, maxBytes);
    const fh = await fsp.open(file, "r");
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, st.size - size);
    await fh.close();
    // Cắt ở biên UTF-8 (không cắt nửa ký tự đa byte)
    let end = buf.length;
    while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end--;
    return buf.slice(0, end).toString("utf8");
  } catch {
    return "";
  }
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

/** Tất cả cổng đang được các instance khác dùng (PORT/ADMIN_PORT/healthPort). */
async function allUsedPorts(excludeName = null) {
  const ports = new Set();
  for (const n of await listInstances()) {
    if (n === excludeName) continue;
    const env = await readInstanceEnv(n);
    const p = parseInt(env.PORT, 10);
    if (p) ports.add(p);
    const a = parseInt(env.ADMIN_PORT, 10);
    if (a) ports.add(a);
    const cfg = await readInstanceConfig(n);
    ports.add(cfg.healthPort || parseInt(env.OPENAI_TUNNEL_HEALTH_PORT || "8080", 10));
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
  await fsp.writeFile(inst.env, legacyEnv, "utf-8");
  const legacyConfig = await readConfig();
  const legacyParsed = parseDotEnv(legacyEnv);
  await writeInstanceConfig("default", {
    connectorName: legacyConfig.connectorName || "",
    lastTunnelUrl: legacyConfig.lastTunnelUrl || "",
    healthPort: parseInt(legacyParsed.OPENAI_TUNNEL_HEALTH_PORT || "8080", 10),
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
/** PIDs của process imageName mà command line chứa substring (phân biệt instance). */
function pidsWithCmdLine(imageName, substring) {
  const key = `${imageName}\u0000${substring}`;
  const hit = pidScanCache.get(key);
  if (hit && Date.now() - hit.at < PID_SCAN_TTL_MS) return hit.pids;
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
      .map((l) => parseInt(l.trim(), 10))
      .filter((p) => Number.isInteger(p) && p > 0);
  } catch {
    pids = [];
  }
  pidScanCache.set(key, { at: Date.now(), pids });
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
  const port = parseInt(env.PORT || "3000", 10);
  const running = await isPortOpen(port);
  const pid = running ? pidOnPort(port) : (await readPidFile(inst.serverPid)) || null;
  let health = null;
  if (running) health = await serverHealth(port);
  return { running, port, pid, health };
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

async function startServer(name) {
  const st = await serverStatus(name);
  if (st.running) return { ok: true, alreadyRunning: true, ...st };
  if (!fs.existsSync(SERVER_ENTRY)) {
    return { ok: false, error: "dist/index.js chưa tồn tại — bấm 'Cài Đặt' trước." };
  }
  const inst = instPaths(name);
  const env = await readInstanceEnv(name);
  const pid = spawnDetached(process.execPath, [SERVER_ENTRY], inst.serverLog, env);
  await writePidFile(inst.serverPid, pid);
  const up = await waitFor(() => isPortOpen(st.port), 20000);
  if (!up) {
    // xóa pid file stale — không để stopServer giết nhầm process sau này
    await writePidFile(inst.serverPid, null);
    const tail = await tailFile(inst.serverLog);
    return { ok: false, error: "Server không khởi động được. Log cuối:\n" + tail.slice(-1500) };
  }
  await warmUpMcp(st.port); // làm ấm trước khi tunnel probe (timeout 2s)
  return { ok: true, running: true, port: st.port, pid, health: await serverHealth(st.port) };
}

async function stopServer(name) {
  const st = await serverStatus(name);
  if (!st.running) return { ok: true, alreadyStopped: true, port: st.port };
  const inst = instPaths(name);
  let killed = false;
  const pidFile = await readPidFile(inst.serverPid);
  if (pidFile) killed = killPidTree(pidFile);
  if (!killed && st.pid) killed = killPidTree(st.pid);
  await writePidFile(inst.serverPid, null);
  await waitFor(() => !isPortOpen(st.port), 10000);
  return { ok: true, port: st.port, stopped: true };
}


async function tunnelStatus(name) {
  const env = await readInstanceEnv(name);
  const config = await readInstanceConfig(name);
  const inst = instPaths(name);
  const tunnelId = env.OPENAI_TUNNEL_ID || "";
  const apiKey = env.OPENAI_TUNNEL_API_KEY || "";
  const mode = tunnelId && apiKey ? "openai" : "cloudflare";
  const healthPort = config.healthPort || parseInt(env.OPENAI_TUNNEL_HEALTH_PORT || "8080", 10);
  const controlPlaneUrl = tunnelId ? `https://api.openai.com/v1/tunnel/${tunnelId}` : null;

  // Detection theo instance — KHÔNG dùng tasklist toàn cục (tunnel-client.exe của
  // instance khác gây false-positive): openai = health port mở; cloudflare = pid file.
  const oaRunning = await isPortOpen(healthPort);
  const cfRunning = pidAlive(await readPidFile(inst.tunnelPid));
  const running = mode === "openai" ? oaRunning : cfRunning;
  const cloudflaredExists = fs.existsSync(CLOUDFLARED);

  if (mode === "openai") {
    return {
      running,
      mode,
      tunnelId,
      kind: oaRunning ? "openai" : null,
      url: oaRunning ? controlPlaneUrl : null,
      healthPort,
      cloudflaredExists,
    };
  }
  return {
    running,
    mode: "cloudflare",
    kind: cfRunning ? "cloudflare" : null,
    url: cfRunning ? config.lastTunnelUrl : null,
    cloudflaredExists,
    healthPort,
  };
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

async function startTunnel(name) {
  const env = await readInstanceEnv(name);
  const st = await tunnelStatus(name);
  if (st.running) return { ok: true, alreadyRunning: true, ...st };
  const inst = instPaths(name);

  const port = parseInt(env.PORT || "3000", 10);
  const serverUp = await isPortOpen(port);
  if (!serverUp) return { ok: false, error: `Server chưa chạy (cổng ${port}) — bật 'Focus Server' trước.` };

  // Dọn tunnel còn sót của CHÍNH instance này (theo profile / cổng) trước khi spawn mới
  // — không đụng tới tunnel của instance khác
  for (const p of pidsWithCmdLine("tunnel-client.exe", inst.profile)) killPidTree(p);
  for (const p of pidsWithCmdLine("cloudflared.exe", `localhost:${port}`)) killPidTree(p);

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
    await fsp.writeFile(profileFile, yaml, "utf-8");

    await fsp.writeFile(inst.tunnelLog, "");
    spawnHiddenDetached(client.path, ["run", "--profile-file", profileFile], inst.tunnelLog, {
      OPENAI_TUNNEL_API_KEY: env.OPENAI_TUNNEL_API_KEY,
      CONTROL_PLANE_API_KEY: env.OPENAI_TUNNEL_API_KEY,
      CONTROL_PLANE_TUNNEL_ID: env.OPENAI_TUNNEL_ID,
    });
    const up = await waitFor(() => isPortOpen(healthPort), 45000);
    if (!up) {
      for (const p of pidsWithCmdLine(profileFile)) killPidTree(p); // tree-kill: cả codex worker nữa
      await writePidFile(inst.tunnelPid, null);
      const tail = await tailFile(inst.tunnelLog);
      return { ok: false, error: "OpenAI tunnel không khởi động được. Log cuối:\n" + tail.slice(-1500) };
    }
    const config = await readInstanceConfig(name);
    config.lastTunnelUrl = `https://api.openai.com/v1/tunnel/${env.OPENAI_TUNNEL_ID}`;
    await writeInstanceConfig(name, config);
    return { ok: true, mode: "openai", tunnelId: env.OPENAI_TUNNEL_ID, healthPort, url: config.lastTunnelUrl };
  }

  // cloudflare
  if (!fs.existsSync(CLOUDFLARED)) {
    return { ok: false, error: "NO_CLOUDFLARED", hint: "Chưa có cloudflared — bấm 'Tải cloudflared' trong thẻ Tunnel." };
  }
  await fsp.writeFile(inst.tunnelLog, "");
  const pid = spawnDetached(CLOUDFLARED, ["tunnel", "--url", `http://localhost:${port}`], inst.tunnelLog);
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
  const config = await readInstanceConfig(name);
  config.lastTunnelUrl = url;
  await writeInstanceConfig(name, config);
  return { ok: true, mode: "cloudflare", url };
}

async function stopTunnel(name) {
  const st = await tunnelStatus(name);
  if (!st.running) return { ok: true, alreadyStopped: true, mode: st.mode };
  const inst = instPaths(name);
  const env = await readInstanceEnv(name);
  const port = parseInt(env.PORT || "3000", 10);
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
  if (!killed) {
    // Legacy adoption (tunnel sinh bởi manager cũ, profile ở profiles/): chỉ an toàn
    // khi có đúng 1 instance — không thể nhầm sang instance khác
    const names = await listInstances();
    if (names.length === 1) {
      const all = await pidOf(OPENAI_TUNNEL_CLIENT);
      if (all) killPidTree(all);
      const cf = await pidOf(CLOUDFLARED_PROC);
      if (cf) killPidTree(cf);
    }
  }
  await writePidFile(inst.tunnelPid, null);
  return { ok: true, mode: st.mode, stopped: true };
}

async function downloadCloudflared() {
  if (fs.existsSync(CLOUDFLARED)) return { ok: true, alreadyExists: true };
  const res = await fetch(CLOUDFLARED_DOWNLOAD_URL, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) return { ok: false, error: `Tải thất bại: HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(CLOUDFLARED, buf);
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

  const port = parseInt(env.PORT || "", 10);
  push(Number.isInteger(port) && port > 0 && port < 65536, "PORT", env.PORT || "(trống)");
  const adminPort = parseInt(env.ADMIN_PORT || "", 10);
  push(Number.isInteger(adminPort) && adminPort > 0 && adminPort < 65536, "ADMIN_PORT", env.ADMIN_PORT || "(trống)");
  if (port && adminPort && port === adminPort) {
    push(false, "Cổng trùng", "PORT và ADMIN_PORT không được giống nhau");
  }

  const profile = env.CHATGPT_TOOL_PROFILE || "slim";
  push(["slim", "full"].includes(profile), "CHATGPT_TOOL_PROFILE", profile);

  // FULL_DISK_ACCESS — sandbox fail-closed
  const fda = (env.FULL_DISK_ACCESS ?? "false").toLowerCase();
  push(["true", "false"].includes(fda), "FULL_DISK_ACCESS", fda === "true" ? "true — truy cập toàn máy" : "false — sandbox (chỉ workspace)");

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
  const memBytes = memBytesRaw === "" ? null : parseInt(memBytesRaw, 10);
  const memBytesOk = memBytes === null || (Number.isInteger(memBytes) && memBytes >= 0);
  push(memBytesOk, "PROJECT_MEMORY_MAX_BYTES", memBytes === null ? "(mặc định ~25KB)" : memBytes === 0 ? "0 — không giới hạn" : `${memBytes} bytes`);
  const memLinesRaw = (env.PROJECT_MEMORY_MAX_LINES || "").trim();
  const memLines = memLinesRaw === "" ? null : parseInt(memLinesRaw, 10);
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
  push(true, "Server", st.running ? `Đang chạy trên cổng ${st.port}` : `Chưa chạy (cổng ${st.port})`);

  return { ok: items.every((i) => i.ok), items };
}

/** Bundle đầy đủ trạng thái một instance (cho UI). */
async function instanceBundle(name) {
  const [env, config, srv, tun, chk, installed] = await Promise.all([
    readInstanceEnv(name),
    readInstanceConfig(name),
    serverStatus(name),
    tunnelStatus(name),
    checkConfig(name).catch((e) => ({ ok: false, items: [], error: String((e && e.message) || e) })),
    Promise.resolve({ dist: fs.existsSync(SERVER_ENTRY), nodeModules: fs.existsSync(path.join(ROOT, "node_modules")) }),
  ]);
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
  const reqPort = body.port === undefined || body.port === null || body.port === "" ? 0 : parseInt(body.port, 10);
  const reqAdmin = body.adminPort === undefined || body.adminPort === null || body.adminPort === "" ? 0 : parseInt(body.adminPort, 10);
  if (reqPort !== 0 && (!Number.isInteger(reqPort) || reqPort < 3000 || reqPort > 3999)) {
    return { ok: false, error: `PORT '${body.port}' không hợp lệ — phải là số nguyên 3000–3999 (để trống = tự chọn).` };
  }
  if (reqAdmin !== 0 && (!Number.isInteger(reqAdmin) || reqAdmin < 3000 || reqAdmin > 3999)) {
    return { ok: false, error: `ADMIN_PORT '${body.adminPort}' không hợp lệ — phải là số nguyên 3000–3999 (để trống = tự chọn).` };
  }
  let port = reqPort;
  if (!port) {
    for (let p = 3000; p < 4000; p++) if (!used.has(p)) { port = p; break; }
  }
  let adminPort = reqAdmin;
  if (!adminPort) {
    for (let p = 3000; p < 4000; p++) if (p !== port && !used.has(p)) { adminPort = p; break; }
  }
  if (!port || !adminPort) return { ok: false, error: "Không tìm được cổng trống trong 3000–3999." };
  if (port === adminPort) return { ok: false, error: "PORT và ADMIN_PORT không được giống nhau." };
  if (used.has(port)) return { ok: false, error: `Cổng ${port} đã được instance khác (hoặc manager) dùng.` };
  if (used.has(adminPort)) return { ok: false, error: `Cổng ${adminPort} đã được instance khác (hoặc manager) dùng.` };
  let healthPort = 8080;
  for (let h = 8080; h < 8200; h++) if (!used.has(h)) { healthPort = h; break; }
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
    "",
  ].join("\n");
  await fsp.writeFile(inst.env, envText, "utf-8");
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
  try {
    await stopServer(name);
  } catch {}
  try {
    await stopTunnel(name);
} catch {}
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

async function saveInstanceEnv(name, body) {
  const inst = instPaths(name);
  const original = await readInstanceEnvRaw(name);
  let next;
  if (typeof body.raw === "string") {
    next = body.raw;
  } else {
    const values = { ...(body.values || {}) };
    // ADMIN_PORT giờ tự cấp + ẩn khỏi UI — nếu không gửi thì giữ giá trị cũ
    // (vẫn theo workspace, mỗi MCP server có admin riêng, truy cập qua manager proxy).
    if (!(body.values && Object.prototype.hasOwnProperty.call(body.values, "ADMIN_PORT"))) {
      const old = parseDotEnv(original);
      if (old.ADMIN_PORT) values.ADMIN_PORT = old.ADMIN_PORT;
    }
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) values[k] = null;
    }
    next = serializeDotEnv(values, original);
  }
  const parsed = parseDotEnv(next);
  const port = parseInt(parsed.PORT || "", 10);
  const adminPort = parseInt(parsed.ADMIN_PORT || "", 10);
  if (!Number.isInteger(port) || !Number.isInteger(adminPort) || port <= 0 || adminPort <= 0) {
    return { ok: false, error: "PORT và ADMIN_PORT phải là số nguyên dương." };
  }
  if (port === adminPort) return { ok: false, error: "PORT và ADMIN_PORT không được giống nhau." };
  const used = await allUsedPorts(name);
  used.add(managerPortNum);
  if (used.has(port)) return { ok: false, error: `Cổng ${port} đã được instance khác (hoặc manager) dùng.` };
  if (used.has(adminPort)) return { ok: false, error: `Cổng ${adminPort} đã được instance khác (hoặc manager) dùng.` };
  const hp = parseInt(parsed.OPENAI_TUNNEL_HEALTH_PORT || "", 10);
  // Mỗi workspace phải có tunnel riêng — chặn trùng ID/API key với instance khác
  const conflicts = await findTunnelConflicts(name, parsed.OPENAI_TUNNEL_ID, parsed.OPENAI_TUNNEL_API_KEY);
  if (conflicts.length) {
    const first = conflicts[0];
    return {
      ok: false,
      error: `Tunnel ${first.field === "OPENAI_TUNNEL_ID" ? "ID" : "API key"} '${first.value}' đã được instance '${first.instance}' dùng — mỗi workspace phải có tunnel riêng.`,
    };
  }
  // Atomic write: ghi temp rồi rename (Windows rename overwrite cần unlink trước)
  const tmp = inst.env + ".tmp";
  await fsp.writeFile(tmp, next, "utf-8");
  try {
    await fsp.rename(tmp, inst.env);
  } catch {
    await fsp.rm(inst.env, { force: true });
    await fsp.rename(tmp, inst.env);
  }
  const config = await readInstanceConfig(name);
  if (hp && hp !== config.healthPort) {
    config.healthPort = hp;
    await writeInstanceConfig(name, config);
  }
  return { ok: true, path: inst.env };
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
    const instances = [];
    for (const n of await listInstances()) {
      try {
        instances.push(await instanceBundle(n));
      } catch (err) {
        // một instance lỗi (vd env bị xóa) không được làm 500 toàn bộ list
        instances.push({
          name: n,
          node: process.version,
          error: String((err && err.message) || err),
          env: {},
          config: { connectorName: "", autoStart: true, lastTunnelUrl: "" },
          server: { running: false, port: 0, pid: null, health: null },
          tunnel: { running: false, mode: "cloudflare", kind: null, url: null, healthPort: 8080, cloudflaredExists: false },
          check: { ok: false, items: [], error: String((err && err.message) || err) },
          installed: { dist: fs.existsSync(SERVER_ENTRY), nodeModules: fs.existsSync(path.join(ROOT, "node_modules")) },
        });
      }
    }
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

    if (req.method === "POST" && sub === "") return json(res, 200, await instanceBundle(name));
    if (req.method === "DELETE" && sub === "") return json(res, 200, await deleteInstance(name));
    if (req.method === "POST" && sub === "/rename") return json(res, 200, await renameInstance(name, body));

    if (req.method === "GET" && sub === "/env") {
      const raw = await readInstanceEnvRaw(name);
      const values = parseDotEnv(raw);
      const masked = {};
      for (const [k, v] of Object.entries(values)) {
        if (k === "OPENAI_TUNNEL_API_KEY" && v) masked[k] = { set: true, last4: v.slice(-4) };
        else masked[k] = v;
      }
      return json(res, 200, { ok: true, path: inst.env, values: masked, raw });
    }
    if (req.method === "PUT" && sub === "/env") return json(res, 200, await saveInstanceEnv(name, body));

    if (req.method === "GET" && sub === "/config") return json(res, 200, { ok: true, ...(await readInstanceConfig(name)) });
    if (req.method === "PUT" && sub === "/config") {
      const config = await readInstanceConfig(name);
      if (typeof body.connectorName === "string") config.connectorName = body.connectorName.slice(0, 80);
      if (typeof body.lastTunnelUrl === "string") config.lastTunnelUrl = body.lastTunnelUrl;
      if (typeof body.autoStart === "boolean") config.autoStart = body.autoStart;
      await writeInstanceConfig(name, config);
      return json(res, 200, { ok: true, config });
    }

    if (req.method === "POST" && sub === "/check") return json(res, 200, await checkConfig(name, body && body.values));

    if (req.method === "POST" && sub === "/server/start") return json(res, 200, await startServer(name));
    if (req.method === "POST" && sub === "/server/stop") return json(res, 200, await stopServer(name));

    if (req.method === "POST" && sub === "/tunnel/start") return json(res, 200, await startTunnel(name));
    if (req.method === "POST" && sub === "/tunnel/stop") return json(res, 200, await stopTunnel(name));

    if (req.method === "POST" && sub === "/pick-folder") {
      const env = await readInstanceEnv(name);
      return json(res, 200, await pickFolder(env.WORKSPACE_PATH || ""));
    }

    if (req.method === "GET" && sub.startsWith("/log")) {
      const kind = url.searchParams.get("kind") === "tunnel" ? "tunnel" : "server";
      const max = Math.min(
        Math.max(parseInt(url.searchParams.get("max") || "300000", 10) || 300000, 1024),
        1048576
      );
      const file = kind === "tunnel" ? inst.tunnelLog : inst.serverLog;
      const [rawLog, st] = await Promise.all([
        tailFile(file, max),
        fsp.stat(file).catch(() => null),
      ]);
      // Tail cắt giữa chừng → bỏ phần đầu dòng dở dang (chỉ khi file lớn hơn max)
      let log = rawLog;
      if (st && st.size > max) {
        const nl = log.indexOf("\n");
        if (nl > 0) log = log.slice(nl + 1);
      }
      return json(res, 200, {
        ok: true,
        kind,
        log,
        size: st ? st.size : 0,
        mtime: st ? st.mtimeMs : 0,
      });
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
      tunnel: tun,
      env: {
        PORT: env.PORT || "3000",
        ADMIN_PORT: env.ADMIN_PORT || "3001",
        WORKSPACE_PATH: env.WORKSPACE_PATH || "",
        CHATGPT_TOOL_PROFILE: env.CHATGPT_TOOL_PROFILE || "slim",
        CHATGPT_AUTO_APPROVE: env.CHATGPT_AUTO_APPROVE ?? "true",
        SHELL_TIMEOUT: env.SHELL_TIMEOUT || "120",
        MCP_SESSION_RECOVERY: env.MCP_SESSION_RECOVERY ?? "true",
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
      if (k === "OPENAI_TUNNEL_API_KEY" && v) {
        masked[k] = { set: true, last4: v.slice(-4) };
      } else {
        masked[k] = v;
      }
    }
    return json(res, 200, { ok: true, path: instPaths(dname).env, values: masked, raw });
  }

  if (req.method === "PUT" && p === "/api/env") {
    return json(res, 200, await saveInstanceEnv(dname, body));
  }

  if (req.method === "GET" && p === "/api/config") {
    return json(res, 200, { ok: true, ...(await readInstanceConfig(dname)) });
  }

  if (req.method === "PUT" && p === "/api/config") {
    const config = await readInstanceConfig(dname);
    if (typeof body.connectorName === "string") config.connectorName = body.connectorName.slice(0, 80);
    if (typeof body.lastTunnelUrl === "string") config.lastTunnelUrl = body.lastTunnelUrl;
    await writeInstanceConfig(dname, config);
    return json(res, 200, { ok: true, config });
  }

  if (req.method === "GET" && p === "/api/profiles") {
    const profiles = await readJson(PROFILES_PATH, {});
    return json(res, 200, { ok: true, profiles });
  }

  if (req.method === "POST" && p === "/api/profiles") {
    const profiles = await readJson(PROFILES_PATH, {});
    const name = String(body.name || "").trim();
    if (!name) return json(res, 400, { ok: false, error: "Tên profile trống" });
    if (!/^[a-zA-Z0-9._-]{1,40}$/.test(name)) {
      return json(res, 400, { ok: false, error: "Tên profile: 1–40 ký tự, chỉ chữ/số/dấu chấm/gạch ngang/gạch dưới." });
    }
    profiles[name] = { savedAt: new Date().toISOString(), values: body.values || {} };
    await writeJson(PROFILES_PATH, profiles);
    return json(res, 200, { ok: true, profiles });
  }

  if (req.method === "DELETE" && p === "/api/profiles") {
    const profiles = await readJson(PROFILES_PATH, {});
    const name = String(url.searchParams.get("name") || "").trim();
    if (profiles[name]) {
      delete profiles[name];
      await writeJson(PROFILES_PATH, profiles);
    }
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

  if (req.method === "POST" && p === "/api/tunnel/start") {
    return json(res, 200, await startTunnel(dname));
  }

  if (req.method === "POST" && p === "/api/tunnel/stop") {
    return json(res, 200, await stopTunnel(dname));
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
  managerPortNum = parseInt(process.env.MANAGER_PORT || env.MANAGER_PORT || "3300", 10);
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
        const adminPort = parseInt(env.ADMIN_PORT || "", 10);
        if (!adminPort) {
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
