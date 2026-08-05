#!/usr/bin/env node
/**
 * Quản Lý ChatGPT Local Coder — management window (standalone launcher).
 *
 * Zero-dependency Node HTTP server bound to 127.0.0.1:<MANAGER_PORT> (default 3300).
 * Controls: install/build, .env editing (PORT, tunnel, profiles...), focus server,
 * focus tunnel (Cloudflare quick tunnel hoac OpenAI Secure MCP Tunnel), ChatGPT links.
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

const IS_WIN = process.platform === "win32";
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
const CONNECTOR_SETTINGS_URL = "https://chatgpt.com/settings/connectors";
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
  if (pid) await fsp.writeFile(p, String(pid), "utf-8");
  else await fsp.rm(p, { force: true });
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

function tasklistHas(name) {
  try {
    const out = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${name}`], { encoding: "utf8", windowsHide: true }).stdout || "";
    return out.toLowerCase().includes(name.toLowerCase());
  } catch {
    return false;
  }
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

async function killProcessesByName(name) {
  try {
    const out = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${name}`], { encoding: "utf8", windowsHide: true }).stdout || "";
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^(\S+)\s+(\d+)\s/);
      if (m) killPidTree(parseInt(m[2], 10));
    }
  } catch {}
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
function spawnHiddenDetached(cmd, args, logFile, extraEnv = null) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const batPath = path.join(STATE_DIR, "spawn-hidden.cmd");
  const vbsPath = path.join(STATE_DIR, "spawn-hidden.vbs");
  const bat = `@echo off\r\n${q(cmd)} ${args.map(q).join(" ")} >> ${q(logFile)} 2>&1\r\n`;
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
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

async function serverHealth() {
  const port = (await readEnv()).PORT || "3000";
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

async function serverStatus() {
  const port = parseInt((await readEnv()).PORT || "3000", 10);
  const running = await isPortOpen(port);
  const pid = running ? pidOnPort(port) : (await readPidFile(SERVER_PID_FILE)) || null;
  let health = null;
  if (running) health = await serverHealth();
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
      }).catch(() => {});
      await fetch(url, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": sid },
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

async function startServer() {
  const st = await serverStatus();
  if (st.running) return { ok: true, alreadyRunning: true, ...st };
  if (!fs.existsSync(SERVER_ENTRY)) {
    return { ok: false, error: "dist/index.js chưa tồn tại — bấm 'Cài Đặt Lần Đầu' trước." };
  }
  const pid = spawnDetached(process.execPath, [SERVER_ENTRY], SERVER_LOG);
  await writePidFile(SERVER_PID_FILE, pid);
  const up = await waitFor(() => isPortOpen(st.port), 20000);
  if (!up) {
    const tail = await tailFile(SERVER_LOG);
    return { ok: false, error: "Server không khởi động được. Log cuối:\n" + tail.slice(-1500) };
  }
  await warmUpMcp(st.port); // làm ấm trước khi tunnel probe (timeout 2s)
  return { ok: true, running: true, port: st.port, pid, health: await serverHealth() };
}

async function stopServer() {
  const st = await serverStatus();
  if (!st.running) return { ok: true, alreadyStopped: true, port: st.port };
  let killed = false;
  const pidFile = await readPidFile(SERVER_PID_FILE);
  if (pidFile) killed = killPidTree(pidFile);
  if (!killed && st.pid) killed = killPidTree(st.pid);
  await writePidFile(SERVER_PID_FILE, null);
  await waitFor(() => !isPortOpen(st.port), 10000);
  return { ok: true, port: st.port, stopped: true };
}


async function tunnelStatus() {
  const env = await readEnv();
  const tunnelId = env.OPENAI_TUNNEL_ID || "";
  const apiKey = env.OPENAI_TUNNEL_API_KEY || "";
  const mode = tunnelId && apiKey ? "openai" : "cloudflare";
  const config = await readConfig();
  const healthPort = parseInt(env.OPENAI_TUNNEL_HEALTH_PORT || "8080", 10);
  const controlPlaneUrl = tunnelId ? `https://api.openai.com/v1/tunnel/${tunnelId}` : null;

  const cfRunning = tasklistHas(CLOUDFLARED_PROC);
  const oaRunning = tasklistHas(OPENAI_TUNNEL_CLIENT) || (await isPortOpen(healthPort));
  const running = cfRunning || oaRunning;
  const cloudflaredExists = fs.existsSync(CLOUDFLARED);

  if (mode === "openai") {
    return {
      running,
      mode,
      tunnelId,
      kind: oaRunning ? "openai" : cfRunning ? "cloudflare" : null,
      url: oaRunning ? controlPlaneUrl : null,
      healthPort,
      cloudflaredExists,
    };
  }
  return {
    running,
    mode: "cloudflare",
    kind: cfRunning ? "cloudflare" : oaRunning ? "openai" : null,
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

async function startTunnel() {
  const env = await readEnv();
  const st = await tunnelStatus();
  if (st.running) return { ok: true, alreadyRunning: true, ...st };

  const port = parseInt(env.PORT || "3000", 10);
  const serverUp = await isPortOpen(port);
  if (!serverUp) return { ok: false, error: `Server chưa chạy (cổng ${port}) — bật 'Focus Server' trước.` };

  // dọn process tunnel thuộc loại còn lại (nếu có) trước khi chuyển mode
  if (st.mode === "openai") {
    if (tasklistHas(CLOUDFLARED_PROC)) await killProcessesByName(CLOUDFLARED_PROC);
  } else if (tasklistHas(OPENAI_TUNNEL_CLIENT)) {
    await killProcessesByName(OPENAI_TUNNEL_CLIENT);
  }

  if (st.mode === "openai") {
    const healthPort = parseInt(env.OPENAI_TUNNEL_HEALTH_PORT || "8080", 10);
    const client = await ensureTunnelClient();
    if (!client.ok) return client;

    const profileDir = path.join(ROOT, "profiles");
    const profileFile = path.join(profileDir, "codex-local.yaml");
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
    await fsp.mkdir(profileDir, { recursive: true });
    await fsp.writeFile(profileFile, yaml, "utf-8");

    await fsp.writeFile(TUNNEL_LOG, "");
    spawnHiddenDetached(client.path, ["run", "--profile-file", profileFile], TUNNEL_LOG, {
      OPENAI_TUNNEL_API_KEY: env.OPENAI_TUNNEL_API_KEY,
      CONTROL_PLANE_API_KEY: env.OPENAI_TUNNEL_API_KEY,
      CONTROL_PLANE_TUNNEL_ID: env.OPENAI_TUNNEL_ID,
    });
    const up = await waitFor(() => isPortOpen(healthPort), 45000);
    if (!up) {
      const tunPid = await pidOf(OPENAI_TUNNEL_CLIENT);
      if (tunPid) killPidTree(tunPid); // tree-kill: cả codex worker nữa
      await writePidFile(TUNNEL_PID_FILE, null);
      const tail = await tailFile(TUNNEL_LOG);
      return { ok: false, error: "OpenAI tunnel không khởi động được. Log cuối:\n" + tail.slice(-1500) };
    }
    const config = await readConfig();
    config.lastTunnelUrl = `https://api.openai.com/v1/tunnel/${env.OPENAI_TUNNEL_ID}`;
    await writeJson(CONFIG_PATH, config);
    return { ok: true, mode: "openai", tunnelId: env.OPENAI_TUNNEL_ID, healthPort, url: config.lastTunnelUrl };
  }

  // cloudflare
  if (!fs.existsSync(CLOUDFLARED)) {
    return { ok: false, error: "NO_CLOUDFLARED", hint: "Chưa có cloudflared — bấm 'Tải cloudflared' trong thẻ Tunnel." };
  }
  await fsp.writeFile(TUNNEL_LOG, "");
  const pid = spawnDetached(CLOUDFLARED, ["tunnel", "--url", `http://localhost:${port}`], TUNNEL_LOG);
  await writePidFile(TUNNEL_PID_FILE, pid);

  let url = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !url) {
    const tail = await tailFile(TUNNEL_LOG, 40000);
    const m = tail.match(TUNNEL_URL_RE);
    if (m) url = m[0];
    if (!url) await new Promise((r) => setTimeout(r, 400));
  }
  if (!url) {
    killPidTree(pid);
    await writePidFile(TUNNEL_PID_FILE, null);
    const tail = await tailFile(TUNNEL_LOG);
    return { ok: false, error: "Không nhận được URL tunnel. Log cuối:\n" + tail.slice(-1500) };
  }
  const config = await readConfig();
  config.lastTunnelUrl = url;
  await writeJson(CONFIG_PATH, config);
  return { ok: true, mode: "cloudflare", url };
}

async function stopTunnel() {
  const st = await tunnelStatus();
  if (!st.running) return { ok: true, alreadyStopped: true, mode: st.mode };
  // tree-kill theo pid thật (bắt qua tasklist) để giết luôn codex worker con
  const tunPid = await pidOf(OPENAI_TUNNEL_CLIENT);
  if (tunPid) killPidTree(tunPid);
  const cfPid = await pidOf(CLOUDFLARED_PROC);
  if (cfPid) killPidTree(cfPid);
  await writePidFile(TUNNEL_PID_FILE, null);
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
  if (fs.existsSync(FOLDER_PICKER_EXE)) return { ok: true };
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

async function pickFolder() {
  // Native MODERN Windows folder dialog via a tiny compiled .NET helper
  // (IFileDialog style — nhanh ~200ms, đẹp như dialog Explorer). No PowerShell.
  const prep = await ensureFolderPicker();
  if (!prep.ok) return { ok: false, cancelled: false, error: prep.error };
  const env = await readEnv();
  try {
    const res = await new Promise((resolve, reject) => {
      const child = spawn(FOLDER_PICKER_EXE, [], {
        windowsHide: true, // ẩn cửa sổ console, chỉ hiện dialog
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FOLDER_PICKER_INITIAL: env.WORKSPACE_PATH || "" },
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

async function checkConfig() {
  const env = await readEnv();
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

  const tunnelId = env.OPENAI_TUNNEL_ID || "";
  const apiKey = env.OPENAI_TUNNEL_API_KEY || "";
  if (tunnelId || apiKey) {
    push(Boolean(tunnelId && apiKey), "OpenAI Tunnel", tunnelId && apiKey ? "Đã đủ ID + API key" : "Thiếu ID hoặc API key");
    if (tunnelId && !/^tunnel_[0-9a-f]{32}$/.test(tunnelId)) {
      push(false, "OpenAI Tunnel ID", "Định dạng phải là tunnel_ + 32 ký tự hex");
    }
  } else {
    push(fs.existsSync(CLOUDFLARED), "Tunnel Cloudflare", fs.existsSync(CLOUDFLARED) ? "cloudflared.exe sẵn sàng" : "Chưa có cloudflared.exe — sẽ tải khi bật Tunnel");
  }

  push(fs.existsSync(SERVER_ENTRY), "Build", fs.existsSync(SERVER_ENTRY) ? "dist/index.js tồn tại" : "Chưa build — bấm 'Cài Đặt Lần Đầu'");

  const st = await serverStatus();
  push(true, "Server", st.running ? `Đang chạy trên cổng ${st.port}` : `Chưa chạy (cổng ${st.port})`);

  return { ok: items.every((i) => i.ok), items };
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
  for await (const chunk of req) chunks.push(chunk);
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

async function handleApi(req, res, url, body) {
  const p = url.pathname;

  if (req.method === "GET" && p === "/api/status") {
    const [env, config, srv, tun, installed] = await Promise.all([
      readEnv(),
      readConfig(),
      serverStatus(),
      tunnelStatus(),
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
        OPENAI_TUNNEL_HEALTH_PORT: env.OPENAI_TUNNEL_HEALTH_PORT || "8080",
      },
      config: { connectorName: config.connectorName || "" },
    });
  }

  if (req.method === "GET" && p === "/api/env") {
    const raw = await readEnvRaw();
    const values = parseDotEnv(raw);
    const masked = {};
    for (const [k, v] of Object.entries(values)) {
      if (k === "OPENAI_TUNNEL_API_KEY" && v) {
        masked[k] = { set: true, last4: v.slice(-4) };
      } else {
        masked[k] = v;
      }
    }
    return json(res, 200, { ok: true, path: ENV_PATH, values: masked, raw });
  }

  if (req.method === "PUT" && p === "/api/env") {
    const original = await readEnvRaw();
    let next;
    if (typeof body.raw === "string") {
      next = body.raw;
    } else {
      const values = body.values || {};
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined) values[k] = null;
      }
      next = serializeDotEnv(values, original);
    }
    await fsp.writeFile(ENV_PATH, next, "utf-8");
    return json(res, 200, { ok: true, path: ENV_PATH });
  }

  if (req.method === "GET" && p === "/api/config") {
    return json(res, 200, { ok: true, ...(await readConfig()) });
  }

  if (req.method === "PUT" && p === "/api/config") {
    const config = await readConfig();
    if (typeof body.connectorName === "string") config.connectorName = body.connectorName;
    if (typeof body.lastTunnelUrl === "string") config.lastTunnelUrl = body.lastTunnelUrl;
    await writeJson(CONFIG_PATH, config);
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
    return json(res, 200, await checkConfig());
  }

  if (req.method === "POST" && p === "/api/server/start") {
    return json(res, 200, await startServer());
  }

  if (req.method === "POST" && p === "/api/server/stop") {
    return json(res, 200, await stopServer());
  }

  if (req.method === "POST" && p === "/api/tunnel/start") {
    return json(res, 200, await startTunnel());
  }

  if (req.method === "POST" && p === "/api/tunnel/stop") {
    return json(res, 200, await stopTunnel());
  }

  if (req.method === "POST" && p === "/api/tunnel/download") {
    return json(res, 200, await downloadCloudflared());
  }

  if (req.method === "POST" && p === "/api/pick-folder") {
    return json(res, 200, await pickFolder());
  }

  if (req.method === "POST" && p === "/api/open/connector") {
    openExternal(CONNECTOR_SETTINGS_URL);
    return json(res, 200, { ok: true, url: CONNECTOR_SETTINGS_URL });
  }

  if (req.method === "GET" && p === "/api/health") {
    return json(res, 200, { ok: true, name: "chatgpt-local-coder-manager", version: "1.0.0" });
  }

  return json(res, 404, { ok: false, error: "Not found" });
}

function openExternal(url) {
  try {
    if (IS_WIN) spawnSync("cmd", ["/c", "start", "", url], { windowsHide: true });
    else if (process.platform === "darwin") spawnSync("open", [url]);
    else spawnSync("xdg-open", [url]);
  } catch {}
}

async function main() {
  await ensureStateDirs();
  const env = await readEnv();
  const port = parseInt(process.env.MANAGER_PORT || env.MANAGER_PORT || "3300", 10);
  const noOpen = process.argv.includes("--no-open");

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      if (url.pathname.startsWith("/api/")) {
        const body = ["POST", "PUT", "DELETE", "PATCH"].includes(req.method) ? await readBody(req) : {};
        await handleApi(req, res, url, body);
        return;
      }
      const file = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
      serveStatic(res, path.join(__dirname, file));
    } catch (err) {
      json(res, 500, { ok: false, error: String(err && err.message || err) });
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
    console.log("=== Quản Lý ChatGPT Local Coder ===");
    console.log(`Manager UI:  http://127.0.0.1:${port}`);
    console.log(`Repo root:   ${ROOT}`);
    console.log(`Server:      ${SERVER_ENTRY}  (PORT=${env.PORT || "3000"})`);
    console.log("");
    if (!noOpen) openExternal(`http://127.0.0.1:${port}`);

    try {
    // Tự động bật Focus Server + Focus Tunnel khi mở app
    const srv = await startServer();
    console.log(
      srv.alreadyRunning
        ? `[Auto] Server đã chạy (cổng ${srv.port})`
        : srv.ok
          ? `[Auto] Server đã bật (pid ${srv.pid})`
          : `[Auto] Server lỗi: ${String(srv.error || "").slice(0, 200)}`
    );
    const tun = await startTunnel();
    console.log(
      tun.alreadyRunning
        ? `[Auto] Tunnel đã chạy (${tun.mode})`
        : tun.ok
          ? `[Auto] Tunnel đã bật (${tun.mode}${tun.url ? " — " + tun.url : ""})`
          : `[Auto] Tunnel lỗi: ${String(tun.error || "").slice(0, 200)}`
    );
    } catch (err) {
      console.log(`[Auto] Lỗi không mong đợi: ${String((err && err.message) || err).slice(0, 300)}`);
    }
  });
}

main();
