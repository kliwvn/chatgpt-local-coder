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
 *     config.json   # lastTunnelUrl, healthPort, autoStart
 *     server.pid / tunnel.pid / profile.yaml / server.log / tunnel.log
 *     checkpoints/ / shell-state/  # managed runtime state, isolated from repo root
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
import { copyTruncateLogFile, isSecretKeyName, redactSensitiveLogText, rotateLogFile, scrubLogFile, tailFile } from "./log-utils.mjs";
import { recycleManagedDirectory } from "./safe-delete.mjs";
import {
  atomicWriteFile,
  enqueueKeyedMutation,
  pruneExpiredCache,
  readUtf8FileBounded,
  readResponseTextBounded,
  retryTransientFsMutation,
  appendBoundedTail,
  extractSingleZipEntryBoundedWindows,
  isRuntimeArtifactStale,
  inspectRuntimeBuildFreshness,
  streamResponseToFileBounded,
} from "./fs-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MANAGER_LOADED_AT_MS = Date.now();
const MANAGER_RUNTIME_FILES = [
  fileURLToPath(import.meta.url),
  path.join(__dirname, "fs-utils.mjs"),
  path.join(__dirname, "log-utils.mjs"),
  path.join(__dirname, "safe-delete.mjs"),
];
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
const MANAGER_ENV_MAX_BYTES = 2 * 1024 * 1024;
const MANAGER_JSON_MAX_BYTES = 2 * 1024 * 1024;
const MANAGER_PID_MAX_BYTES = 128;
const INSTALL_OUTPUT_MAX_CHARS = 6000;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const DOWNLOAD_MAX_BYTES = 128 * 1024 * 1024;
const HELPER_OUTPUT_MAX_CHARS = 16 * 1024;
const MAX_MANAGED_INSTANCES = 256;
const MANAGED_LOG_SWEEP_MS = 60 * 1000;
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
const RUNTIME_SOURCE_ROOT = path.join(ROOT, "src");
const RUNTIME_ARTIFACT_ROOT = path.join(ROOT, "dist");
const RUNTIME_BUILD_SOURCE_FILES = [
  path.join(ROOT, "package.json"),
  path.join(ROOT, "package-lock.json"),
  path.join(ROOT, "tsconfig.json"),
];
const RUNTIME_BUILD_CACHE_MS = 1500;
let runtimeBuildCache = { at: 0, value: null };
async function runtimeBuildStatus(force = false) {
  if (!force && runtimeBuildCache.value && Date.now() - runtimeBuildCache.at < RUNTIME_BUILD_CACHE_MS) {
    return runtimeBuildCache.value;
  }
  const value = await inspectRuntimeBuildFreshness({
    sourceRoot: RUNTIME_SOURCE_ROOT,
    artifactRoot: RUNTIME_ARTIFACT_ROOT,
    sourceFiles: RUNTIME_BUILD_SOURCE_FILES,
  });
  runtimeBuildCache = { at: Date.now(), value };
  return value;
}
const CLOUDFLARED_DOWNLOAD_URL =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const ENV_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
/* Secret keys masked on the wire. ADMIN_TOKEN also gates the instance admin
 * API, so it must never reach the browser either. */
const MASK_SENTINEL = "********";

function isSecretKey(key) { return isSecretKeyName(key); }

async function managerRuntimeStatus() {
  const stats = await Promise.all(MANAGER_RUNTIME_FILES.map((file) => fsp.stat(file).catch(() => null)));
  const newestMtimeMs = stats.reduce((max, stat) => Math.max(max, Number(stat?.mtimeMs) || 0), 0);
  const loadedAt = new Date(MANAGER_LOADED_AT_MS).toISOString();
  return {
    pid: process.pid,
    loadedAt,
    artifactDrift: isRuntimeArtifactStale(loadedAt, newestMtimeMs || Number.NaN),
  };
}

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
      delete profile.values.MCP_CONNECTOR_NAME;
      delete profile.values.MCP_SESSION_RECOVERY;
      delete profile.values.CHATGPT_AUTO_APPROVE;
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
    const out = spawnSync("netstat", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 2 * 1024 * 1024,
    }).stdout || "";
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

function portsForPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return [];
  const ports = [];
  for (const [port, ownerPid] of listeningPortPids()) {
    if (ownerPid === pid) ports.push(port);
  }
  return ports;
}

/* LEGACY single-instance .env tại ROOT/.env — chỉ còn dùng để đọc
 * MANAGER_PORT và migrate sang instance "default" lần đầu. */
async function readEnvRaw() {
  try {
    return await readUtf8FileBounded(ENV_PATH, MANAGER_ENV_MAX_BYTES, "manager .env");
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
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
    return JSON.parse(await readUtf8FileBounded(p, MANAGER_JSON_MAX_BYTES, "manager state JSON"));
  } catch (err) {
    if (err?.code === "ENOENT") return fallback;
    if (/manager state JSON exceeds/i.test(String(err?.message || err))) throw err;
    return fallback;
  }
}

async function writeJson(p, data) {
  const serialized = JSON.stringify(data, null, 2);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MANAGER_JSON_MAX_BYTES) {
    throw new Error(`manager state JSON exceeds ${MANAGER_JSON_MAX_BYTES} bytes (${bytes} bytes): ${p}`);
  }
  await atomicWriteFile(p, serialized, "utf8");
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
  return readJson(CONFIG_PATH, { lastTunnelUrl: "" });
}

async function readPidFile(p) {
  try {
    const pid = Number((await readUtf8FileBounded(p, MANAGER_PID_MAX_BYTES, "manager PID file")).trim());
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
    const res = spawnSync(IS_WIN ? "taskkill" : "kill", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
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

function isLegacyRuntimeStateValue(value, legacyPath) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const resolved = path.resolve(ROOT, raw);
  const legacy = path.resolve(legacyPath);
  return IS_WIN ? resolved.toLowerCase() === legacy.toLowerCase() : resolved === legacy;
}

function managedRuntimeStatePath(value, legacyPath, managedPath) {
  const raw = String(value || "").trim();
  return !raw || isLegacyRuntimeStateValue(raw, legacyPath) ? managedPath : raw;
}

async function migrateLegacyRuntimeState(name, env, inst) {
  if (name !== "default") return;
  const candidates = [
    { envKey: "CHECKPOINT_PATH", legacy: path.join(ROOT, ".mcp-checkpoints"), target: path.join(inst.dir, "checkpoints") },
    { envKey: "MCP_SHELL_STATE_DIR", legacy: path.join(ROOT, ".mcp-state"), target: path.join(inst.dir, "shell-state") },
  ];
  for (const item of candidates) {
    const configured = String(env[item.envKey] || "").trim();
    const legacyConfigured = isLegacyRuntimeStateValue(configured, item.legacy);
    if (configured && !legacyConfigured) continue;
    let legacyExists = false;
    try {
      await fsp.access(item.legacy);
      legacyExists = true;
    } catch {
      // A legacy-equivalent setting can remain after the directory was already
      // cleaned manually. Remove the stale setting below so runtime/UI agree.
    }
    if (legacyExists) {
      try {
        await fsp.access(item.target);
        throw new Error(`Legacy runtime state migration conflict: both ${item.legacy} and ${item.target} exist`);
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
      await fsp.mkdir(inst.dir, { recursive: true });
      try {
        await retryTransientFsMutation(() => fsp.rename(item.legacy, item.target));
      } catch (err) {
        if (err?.code !== "EXDEV") throw err;
        await fsp.cp(item.legacy, item.target, { recursive: true, force: false, errorOnExist: true });
        try {
          await recycleManagedDirectory(item.legacy, ROOT);
        } catch (recycleErr) {
          // The source is still durable. Roll back the transaction-created copy
          // recoverably as well; if rollback itself fails, preserve both copies
          // rather than escalating to recursive permanent deletion.
          try {
            await recycleManagedDirectory(item.target, inst.dir);
          } catch (rollbackErr) {
            throw new Error(
              `Legacy runtime state source recycle failed and rollback copy was preserved: ${item.target}; ` +
              `source error=${String(recycleErr?.message || recycleErr)}; rollback error=${String(rollbackErr?.message || rollbackErr)}`
            );
          }
          throw recycleErr;
        }
      }
      console.log(`[manager] Migrated legacy runtime state: ${item.legacy} -> ${item.target}`);
    }
    if (legacyConfigured) {
      await enqueueFileMutation(inst.env, async () => {
        const rawEnv = await readInstanceEnvRaw(name);
        const current = parseDotEnv(rawEnv);
        if (!isLegacyRuntimeStateValue(current[item.envKey], item.legacy)) return;
        await atomicWriteFile(inst.env, serializeDotEnv({ [item.envKey]: null }, rawEnv), "utf8");
      });
      delete env[item.envKey];
    }
  }
}

async function listInstances() {
  try {
    const names = [];
    const dir = await fsp.opendir(INSTANCES_DIR);
    for await (const entry of dir) {
      if (!entry.isDirectory() || !INSTANCE_NAME_RE.test(entry.name)) continue;
      names.push(entry.name);
      if (names.length > MAX_MANAGED_INSTANCES) {
        throw new Error(`Managed instances exceed hard cap ${MAX_MANAGED_INSTANCES}`);
      }
    }
    names.sort();
    return names;
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    return [];
  }
}

let managedLogSweepPromise = null;

function sweepManagedLogs() {
  if (managedLogSweepPromise) return managedLogSweepPromise;
  const run = (async () => {
    for (const name of await listInstances()) {
      const inst = instPaths(name);
      const targets = [
        ["server", inst.serverLog, enqueueServerLifecycle],
        ["tunnel", inst.tunnelLog, enqueueTunnelLifecycle],
      ];
      for (const [kind, file, enqueueLifecycle] of targets) {
        try {
          // Serialize maintenance with start/stop/restart so backup shifting and
          // pre-start rotation never race the lifecycle operation for this instance.
          if (await enqueueLifecycle(name, () => copyTruncateLogFile(file))) {
            console.log(`[manager] ${name}: rotated live ${kind} log`);
          }
        } catch (err) {
          console.warn(`[manager] ${name}: ${kind} log maintenance failed: ${String((err && err.message) || err).slice(0, 200)}`);
        }
      }
    }
  })();
  const settled = run.finally(() => {
    if (managedLogSweepPromise === settled) managedLogSweepPromise = null;
  });
  managedLogSweepPromise = settled;
  return settled;
}

function startManagedLogMaintenance() {
  const sweep = () => void sweepManagedLogs().catch((err) => {
    console.warn(`[manager] managed log sweep failed: ${String((err && err.message) || err).slice(0, 200)}`);
  });
  sweep();
  const timer = setInterval(sweep, MANAGED_LOG_SWEEP_MS);
  timer.unref?.();
}

async function readInstanceEnvRaw(name) {
  try {
    return await readUtf8FileBounded(instPaths(name).env, MANAGER_ENV_MAX_BYTES, "instance .env");
  } catch (err) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

async function readInstanceEnv(name) {
  return parseDotEnv(await readInstanceEnvRaw(name));
}

async function readInstanceConfig(name) {
  const config = await readJson(instPaths(name).config, {
    lastTunnelUrl: "",
    healthPort: 8080,
    autoStart: true,
  });
  delete config.connectorName;
  return config;
}

async function writeInstanceConfig(name, config) {
  const next = { ...config };
  delete next.connectorName;
  await writeJson(instPaths(name).config, next);
}

async function updateInstanceConfig(name, updater) {
  const file = instPaths(name).config;
  return mutateJson(file, { lastTunnelUrl: "", healthPort: 8080, autoStart: true }, async (config) => {
    await updater(config);
    delete config.connectorName;
    return config;
  });
}

async function removeLegacyConnectorNameConfig() {
  for (const name of await listInstances()) {
    await updateInstanceConfig(name, () => undefined);
  }
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
    const out = spawnSync("powershell.exe", ps, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 512 * 1024,
    }).stdout || "";
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
    return JSON.parse(await readResponseTextBounded(res, 512 * 1024, "server health response"));
  } catch {
    return null;
  }
}

async function managerHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = JSON.parse(await readResponseTextBounded(res, 64 * 1024, "manager health response"));
    return body?.ok === true && body?.name === "chatgpt-local-coder-manager" ? body : null;
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
    return /<title>\s*tunnel-client\s*<\/title>/i.test(
      await readResponseTextBounded(res, 64 * 1024, "tunnel health response")
    );
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
      let settled = false;
      let out = "";
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      child.stdout.on("data", (d) => (out = appendBoundedTail(out, d, INSTALL_OUTPUT_MAX_CHARS)));
      child.stderr.on("data", (d) => (out = appendBoundedTail(out, d, INSTALL_OUTPUT_MAX_CHARS)));
      child.on("error", (err) => finish({ code: -1, out: appendBoundedTail(out, `\nspawn lỗi: ${err.message}`, INSTALL_OUTPUT_MAX_CHARS) }));
      child.on("close", (code) => finish({ code, out }));
      timer = setTimeout(() => {
        out = appendBoundedTail(out, `\n[timeout after ${INSTALL_TIMEOUT_MS}ms]`, INSTALL_OUTPUT_MAX_CHARS);
        if (child.pid) killPidTree(child.pid);
        finish({ code: 124, out });
      }, INSTALL_TIMEOUT_MS);
      timer.unref?.();
    });
    log.push({ step: `npm ${args.join(" ")}`, code: res.code, output: res.out });
    if (res.code !== 0) break;
  }
  await fsp.writeFile(INSTALL_LOG, log.map((l) => l.output).join("\n"), "utf-8");
  runtimeBuildCache = { at: 0, value: null };
  const ok = log.every((l) => l.code === 0);
  return { ok, steps: log.map((l) => ({ step: l.step, code: l.code })), output: log.map((l) => l.output).join("\n").slice(-6000) };
}

async function serverStatus(name) {
  const env = await readInstanceEnv(name);
  const inst = instPaths(name);
  const buildState = await runtimeBuildStatus();
  const configuredPort = Number(env.PORT || 0);
  const configuredPortValid = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536;
  const savedPid = await readPidFile(inst.serverPid);

  let portOpen = false;
  let health = null;
  let portPid = null;
  if (configuredPortValid) {
    portOpen = await isPortOpen(configuredPort);
    portPid = portOpen ? pidOnPort(configuredPort) : null;
    health = portOpen ? await serverHealth(configuredPort) : null;
    if (!health && savedPid && portPid === savedPid && isPidAlive(savedPid)) {
      // A freshly restarted Gateway can accept TCP a fraction before /health is
      // consistently ready under Windows load. Retry only when the listener PID
      // exactly matches our managed PID; never spend extra retries on an unknown
      // port occupant and never relax the health/workspace identity requirement.
      await new Promise((resolve) => setTimeout(resolve, 120));
      health = await serverHealth(configuredPort);
    }
    if (portOpen && isLocalCoderHealth(health, env)) {
      const artifactDrift = isRuntimeArtifactStale(
        health?.instructions?.loaded_at,
        buildState.newestArtifactMtimeMs
      );
      return {
        running: true,
        port: configuredPort,
        configuredPort,
        pid: portPid || savedPid || null,
        health,
        portOccupied: false,
        invalidConfig: false,
        configDrift: false,
        artifactDrift,
        buildDrift: buildState.sourceNewerThanBuild,
        buildSourceMtimeMs: buildState.newestSourceMtimeMs,
        buildArtifactMtimeMs: buildState.newestArtifactMtimeMs,
        owned: Boolean(savedPid && (!portPid || savedPid === portPid)),
      };
    }
  }

  // A user can edit an instance .env outside the Manager. If PORT changes while
  // the managed child is still alive, following only the new configured port
  // loses the old process and can later start a duplicate workspace. Recover the
  // child strictly through its saved PID + listening port + Local Coder workspace
  // identity. A stale/reused PID that does not satisfy all three checks is ignored.
  if (savedPid && isPidAlive(savedPid)) {
    for (const actualPort of portsForPid(savedPid)) {
      if (actualPort === configuredPort) continue;
      const actualHealth = await serverHealth(actualPort);
      if (!isLocalCoderHealth(actualHealth, env)) continue;
      const artifactDrift = isRuntimeArtifactStale(
        actualHealth?.instructions?.loaded_at,
        buildState.newestArtifactMtimeMs
      );
      return {
        running: true,
        port: actualPort,
        configuredPort: configuredPortValid ? configuredPort : 0,
        pid: savedPid,
        health: actualHealth,
        portOccupied: configuredPortValid && portOpen && !isLocalCoderHealth(health, env),
        invalidConfig: !configuredPortValid,
        configDrift: true,
        artifactDrift,
        buildDrift: buildState.sourceNewerThanBuild,
        buildSourceMtimeMs: buildState.newestSourceMtimeMs,
        buildArtifactMtimeMs: buildState.newestArtifactMtimeMs,
        owned: true,
      };
    }
  }

  return {
    running: false,
    port: configuredPortValid ? configuredPort : 0,
    configuredPort: configuredPortValid ? configuredPort : 0,
    pid: portPid || savedPid || null,
    health: null,
    portOccupied: configuredPortValid && portOpen,
    invalidConfig: !configuredPortValid,
    configDrift: false,
    artifactDrift: false,
    buildDrift: buildState.sourceNewerThanBuild,
    buildSourceMtimeMs: buildState.newestSourceMtimeMs,
    buildArtifactMtimeMs: buildState.newestArtifactMtimeMs,
    owned: false,
  };
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
    await res.body?.cancel().catch(() => undefined);
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
      }).then((r) => r.body?.cancel()).catch(() => {});
      await fetch(url, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": sid },
        signal: AbortSignal.timeout(10000),
      }).then((r) => r.body?.cancel()).catch(() => {});
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
  if (st.running && st.configDrift) {
    return {
      ok: false,
      error: `Managed server PID ${st.pid} is still running on PORT ${st.port}, but .env now configures PORT ${st.configuredPort || "invalid"}. Stop/restart the managed server before starting with the new configuration.`,
      ...st,
    };
  }
  if (st.running) return { ok: true, alreadyRunning: true, ...st };
  if (st.invalidConfig) return { ok: false, error: "PORT is invalid; fix configuration before starting Local Coder." };
  if (st.portOccupied) return { ok: false, error: `PORT ${st.port} is occupied by another process${st.pid ? ` (PID ${st.pid})` : ""}; refusing to start Local Coder.` };
  if (!fs.existsSync(SERVER_ENTRY)) {
    return { ok: false, error: "dist/index.js chưa tồn tại — bấm 'Cài Đặt' trước." };
  }
  const buildState = await runtimeBuildStatus(true);
  if (buildState.sourceNewerThanBuild) {
    return {
      ok: false,
      error: "Runtime source is newer than dist. Run Install/Build before starting or restarting the Gateway.",
      buildDrift: true,
    };
  }
  const inst = instPaths(name);
  // Persist managed-runtime defaults for instances created before these keys
  // existed (e.g. "default"), including an instance-local audit path, instead
  // of silently relying on process-level fallbacks.
  await ensureManagedRuntimeDefaults(name);
  // Chặn start nếu policy không hợp lệ: server sẽ chạy với process-default
  // (vd TTL=120000) trong khi UI hiển thị giá trị đã lưu → UI khác thực tế.
  const policy = validateSessionPolicy(await readInstanceEnv(name));
  if (!policy.ok) {
    return { ok: false, error: `Session policy không hợp lệ — sửa trong Cấu hình: ${policy.errors.join("; ")}` };
  }
  const env = await readInstanceEnv(name);
  const adminPort = Number(env.ADMIN_PORT || 0);
  if (!Number.isInteger(adminPort) || adminPort <= 0 || adminPort >= 65536) {
    return { ok: false, error: "ADMIN_PORT is invalid; fix configuration before starting Local Coder." };
  }
  if (adminPort === st.port) {
    return { ok: false, error: "PORT and ADMIN_PORT must differ before starting Local Coder." };
  }
  if (await isPortOpen(adminPort)) {
    const adminPid = pidOnPort(adminPort);
    return { ok: false, error: `ADMIN_PORT ${adminPort} is occupied by another process${adminPid ? ` (PID ${adminPid})` : ""}; refusing to start Local Coder.` };
  }
  const runtimeLimits = validateRuntimeLimits(env);
  if (!runtimeLimits.ok) {
    return { ok: false, error: `Runtime limits không hợp lệ — sửa trong Cấu hình: ${runtimeLimits.errors.join("; ")}` };
  }
  await migrateLegacyRuntimeState(name, env, inst);
  // serverStatus above established that this managed server is stopped, so no
  // child owns these process logs. Scrub historical generations before append /
  // rotation so old credentials do not remain at rest indefinitely.
  for (const file of [inst.serverLog, `${inst.serverLog}.1`, `${inst.serverLog}.2`]) {
    await scrubLogFile(file);
  }
  await rotateLogFile(inst.serverLog);
  const pid = spawnDetached(process.execPath, [SERVER_ENTRY], inst.serverLog, {
    ...env,
    // Runtime metadata only (not persisted into the user's .env): direct admin
    // config editing must target this instance file, not repo-root .env merely
    // because every managed server process is spawned with cwd=ROOT.
    MCP_ENV_FILE: inst.env,
    MCP_INSTANCE_NAME: name,
    CHECKPOINT_PATH: managedRuntimeStatePath(env.CHECKPOINT_PATH, path.join(ROOT, ".mcp-checkpoints"), path.join(inst.dir, "checkpoints")),
    MCP_SHELL_STATE_DIR: managedRuntimeStatePath(env.MCP_SHELL_STATE_DIR, path.join(ROOT, ".mcp-state"), path.join(inst.dir, "shell-state")),
  });
  invalidatePortPidCache();
  await writePidFile(inst.serverPid, pid);
  const up = await waitFor(async () => isLocalCoderHealth(await serverHealth(st.port), env), 20000);
  if (!up) {
    killPidTree(pid);
    invalidatePortPidCache();
    const stopped = await waitFor(() => !isPidAlive(pid), 5000, 150);
    if (stopped) await writePidFile(inst.serverPid, null);
    const tail = await tailFile(inst.serverLog);
    return {
      ok: false,
      error: "Server không khởi động được." + (stopped ? "" : ` PID ${pid} vẫn còn sống; giữ server.pid để có thể stop/recover an toàn.`) + " Log cuối:\n" + tail.slice(-1500),
      pid: stopped ? null : pid,
      cleanupFailed: !stopped,
    };
  }
  await warmUpMcp(st.port); // làm ấm trước khi tunnel probe (timeout 2s)
  return { ok: true, running: true, port: st.port, pid, health: await serverHealth(st.port) };
}

async function stopServerUnlocked(name) {
  const st = await serverStatus(name);
  if (!st.running) return { ok: true, alreadyStopped: true, port: st.port };
  const inst = instPaths(name);
  const env = await readInstanceEnv(name);
  const pidFile = await readPidFile(inst.serverPid);
  if (!pidFile || pidFile !== st.pid || !st.owned) {
    return {
      ok: false,
      error: `Refusing to stop an unowned Local Coder process on PORT ${st.port}${st.pid ? ` (PID ${st.pid})` : ""}; managed PID metadata does not match.`,
      port: st.port,
      pid: st.pid || null,
      stopped: false,
    };
  }

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
    await response.body?.cancel().catch(() => undefined);
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
  if (pidFile === st.pid) killed = killPidTree(pidFile);
  invalidatePortPidCache();
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
  await writePidFile(inst.serverPid, null);
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
    const buildState = await runtimeBuildStatus(true);
    if (buildState.sourceNewerThanBuild) {
      return {
        ok: false,
        restarted: false,
        buildDrift: true,
        error: "Runtime source is newer than dist. Run Install/Build before restarting the Gateway.",
      };
    }
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
  const inst = instPaths(name);
  const tunnelId = env.OPENAI_TUNNEL_ID || "";
  const apiKey = env.OPENAI_TUNNEL_API_KEY || "";
  const mode = tunnelId && apiKey ? "openai" : "cloudflare";
  const healthPort = Number(config.healthPort || env.OPENAI_TUNNEL_HEALTH_PORT || 0);
  const healthPortValid = Number.isInteger(healthPort) && healthPort > 0 && healthPort < 65536;
  const controlPlaneUrl = tunnelId ? `https://api.openai.com/v1/tunnel/${tunnelId}` : null;
  const oaPortOpen = healthPortValid ? await isPortOpen(healthPort) : false;
  const oaHealthy = oaPortOpen ? await tunnelClientHealth(healthPort) : false;
  const oaPids = pidsWithCmdLine("tunnel-client.exe", inst.profile).filter(isPidAlive);
  const serverPort = Number(env.PORT || 0);
  const desiredCfPids = mode === "cloudflare" && Number.isInteger(serverPort)
    ? pidsWithCmdLine("cloudflared.exe", `localhost:${serverPort}`)
    : [];
  const savedPid = await readPidFile(inst.tunnelPid);
  const localCfPids = savedPid ? pidsWithCmdLine("cloudflared.exe", "localhost:") : [];
  const savedCfRunning = Boolean(savedPid && isPidAlive(savedPid) && localCfPids.includes(savedPid));
  const desiredCfPid = desiredCfPids[0] || null;
  const desiredCfOwned = Boolean(savedPid && desiredCfPids.includes(savedPid));
  const cloudflaredExists = fs.existsSync(CLOUDFLARED);

  // The profile path is instance-unique, so a tunnel-client process carrying it
  // is safely attributable to this instance even if its current .env changed.
  // Cloudflared has no profile file, therefore ownership additionally requires
  // the saved PID to still be a cloudflared local-url tunnel process.
  if (oaPids.length > 0 && savedCfRunning) {
    return {
      running: true,
      mode,
      kind: "mixed",
      pid: oaPids[0],
      owned: true,
      configDrift: true,
      ambiguous: true,
      healthPort,
      cloudflaredExists,
      invalidConfig: !healthPortValid,
      portOccupied: oaPortOpen && !oaHealthy,
    };
  }
  if (oaPids.length > 0) {
    const desired = mode === "openai" && oaHealthy;
    return {
      running: true,
      mode,
      tunnelId,
      kind: "openai",
      pid: oaPids[0],
      owned: true,
      configDrift: !desired,
      healthy: oaHealthy,
      url: desired ? controlPlaneUrl : config.lastTunnelUrl || null,
      healthPort,
      cloudflaredExists,
      invalidConfig: !healthPortValid,
      portOccupied: oaPortOpen && !oaHealthy,
    };
  }
  if (savedCfRunning) {
    const desired = mode === "cloudflare" && desiredCfOwned;
    return {
      running: true,
      mode,
      kind: "cloudflare",
      pid: savedPid,
      owned: true,
      configDrift: !desired,
      url: config.lastTunnelUrl || null,
      healthPort,
      cloudflaredExists,
      invalidConfig: !healthPortValid,
      portOccupied: false,
    };
  }
  if (desiredCfPid) {
    // A cloudflared process points at the desired port, but without matching
    // managed PID metadata we must not assume ownership or kill it.
    return {
      running: true,
      mode,
      kind: "cloudflare",
      pid: desiredCfPid,
      owned: false,
      configDrift: false,
      url: config.lastTunnelUrl || null,
      healthPort,
      cloudflaredExists,
      invalidConfig: !healthPortValid,
      portOccupied: false,
    };
  }
  return {
    running: false,
    mode,
    kind: null,
    pid: savedPid || null,
    owned: false,
    configDrift: false,
    url: null,
    healthPort,
    cloudflaredExists,
    invalidConfig: !healthPortValid,
    portOccupied: mode === "openai" && oaPortOpen && !oaHealthy,
  };
}

async function ensureTunnelClient() {
  const binDir = path.join(ROOT, "bin");
  const exe = OPENAI_TUNNEL_CLIENT_EXE;
  if (fs.existsSync(exe)) return { ok: true, path: exe };
  const tmpZip = path.join(binDir, "tunnel-client.zip");
  try {
    await fsp.mkdir(binDir, { recursive: true });
    await fsp.rm(tmpZip, { force: true }).catch(() => undefined);
    const res = await fetch(OPENAI_TUNNEL_ZIP_URL, { signal: AbortSignal.timeout(240000), redirect: "follow" });
    if (!res.ok) return { ok: false, error: `Tải tunnel-client thất bại: HTTP ${res.status}` };
    await streamResponseToFileBounded(res, tmpZip, DOWNLOAD_MAX_BYTES, "tunnel-client download");
    extractSingleZipEntryBoundedWindows(
      tmpZip,
      exe,
      "tunnel-client.exe",
      DOWNLOAD_MAX_BYTES,
      { timeoutMs: 120000, maxBuffer: HELPER_OUTPUT_MAX_CHARS }
    );
    if (!fs.existsSync(exe)) {
      return { ok: false, error: "Giải nén tunnel-client thất bại: không tạo được tunnel-client.exe." };
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
  if (st.running && (!st.owned || st.configDrift)) {
    return {
      ok: false,
      error: st.owned
        ? `Managed ${st.kind || "tunnel"} process is still running with configuration drift; stop it before starting the newly configured Tunnel.`
        : `A ${st.kind || "tunnel"} process is already using this instance configuration but is not owned by this Manager; refusing to replace or kill it.`,
      ...st,
    };
  }
  if (st.running) return { ok: true, alreadyRunning: true, ...st };
  if (st.invalidConfig) return { ok: false, error: "OPENAI_TUNNEL_HEALTH_PORT is invalid; fix configuration before starting Tunnel." };
  if (st.portOccupied) return { ok: false, error: `Tunnel health port ${st.healthPort} is occupied by another process; refusing to start Tunnel.` };
  const inst = instPaths(name);
  const port = Number(env.PORT || 0);
  const serverState = await serverStatus(name);
  if (!serverState.running || serverState.configDrift) {
    const reason = serverState.portOccupied ? "the server port is occupied by another process" : "Local Coder server is not running";
    return { ok: false, error: serverState.configDrift ? `Cannot start Tunnel: managed Local Coder is still running on old PORT ${serverState.port} while .env configures PORT ${port}.` : `Cannot start Tunnel: ${reason} on port ${port}.` };
  }
  if (serverState.buildDrift || serverState.artifactDrift) {
    return {
      ok: false,
      error: serverState.buildDrift
        ? "Cannot start Tunnel: runtime source is newer than dist. Run Install/Build, restart Gateway, then start Tunnel."
        : "Cannot start Tunnel: Gateway is running an older compiled runtime. Restart Gateway before exposing it through the Tunnel.",
    };
  }

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
      // INFO emits one line per control-plane/MCP event and grows tunnel.log
      // continuously even when the Manager/Gateway stay healthy for days.
      // WARN keeps actionable diagnostics while avoiding idle log churn.
      "  level: warn",
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
    await writePidFile(inst.tunnelPid, null);

    await fsp.writeFile(inst.tunnelLog, "");
    spawnHiddenDetached(client.path, ["run", "--profile-file", profileFile], inst.tunnelLog, {
      OPENAI_TUNNEL_API_KEY: env.OPENAI_TUNNEL_API_KEY,
      CONTROL_PLANE_API_KEY: env.OPENAI_TUNNEL_API_KEY,
      CONTROL_PLANE_TUNNEL_ID: env.OPENAI_TUNNEL_ID,
    });
    invalidateProcessScanCache();
    const up = await waitFor(() => tunnelClientHealth(healthPort), 45000);
    if (!up) {
      for (const p of pidsWithCmdLine("tunnel-client.exe", profileFile)) killPidTree(p);
      invalidateProcessScanCache();
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
    invalidateProcessScanCache();
    const stopped = await waitFor(() => !isPidAlive(pid), 5000, 150);
    if (stopped) await writePidFile(inst.tunnelPid, null);
    const tail = await tailFile(inst.tunnelLog);
    return {
      ok: false,
      error: "Không nhận được URL tunnel." + (stopped ? "" : ` PID ${pid} vẫn còn sống; giữ tunnel.pid để có thể stop/recover an toàn.`) + " Log cuối:\n" + tail.slice(-1500),
      pid: stopped ? null : pid,
      cleanupFailed: !stopped,
    };
  }
  await updateInstanceConfig(name, (config) => { config.lastTunnelUrl = url; });
  return { ok: true, mode: "cloudflare", url };
}

async function stopTunnelUnlocked(name) {
  const st = await tunnelStatus(name);
  if (!st.running) return { ok: true, alreadyStopped: true, mode: st.mode };
  const inst = instPaths(name);
  if (!st.owned) {
    return {
      ok: false,
      mode: st.mode,
      stopped: false,
      error: `Refusing to stop an unowned ${st.kind || "tunnel"} process${st.pid ? ` (PID ${st.pid})` : ""}.`,
    };
  }
  const targets = new Set(pidsWithCmdLine("tunnel-client.exe", inst.profile).filter(isPidAlive));
  const savedPid = await readPidFile(inst.tunnelPid);
  if (savedPid && pidsWithCmdLine("cloudflared.exe", "localhost:").includes(savedPid) && isPidAlive(savedPid)) targets.add(savedPid);
  if (targets.size === 0) return { ok: false, mode: st.mode, stopped: false, error: "Managed Tunnel is reported running but no owned process can be identified safely." };

  let killed = false;
  for (const pid of targets) killed = killPidTree(pid) || killed;
  invalidateProcessScanCache();
  const stopped = await waitFor(() => [...targets].every((pid) => !isPidAlive(pid)), 10000, 150);
  if (!stopped) {
    return { ok: false, mode: st.mode, stopped: false, error: "Managed Tunnel process did not stop within 10 seconds; PID metadata was preserved for a safe retry." };
  }
  await writePidFile(inst.tunnelPid, null);
  return { ok: true, mode: st.mode, kind: st.kind, stopped: true, forced: killed };
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
  const bytes = await streamResponseToFileBounded(res, CLOUDFLARED, DOWNLOAD_MAX_BYTES, "cloudflared download");
  return { ok: true, bytes };
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
      timeout: 30000,
      maxBuffer: HELPER_OUTPUT_MAX_CHARS,
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
      let settled = false;
      child.stdout.on("data", (d) => (stdout = appendBoundedTail(stdout, d, HELPER_OUTPUT_MAX_CHARS)));
      child.stderr.on("data", (d) => (stderr = appendBoundedTail(stderr, d, HELPER_OUTPUT_MAX_CHARS)));
      const finish = (value, rejectError = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (rejectError) reject(rejectError);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        if (child.pid) killPidTree(child.pid);
        finish({ status: -1, stdout, stderr: appendBoundedTail(stderr, "\n[folder-picker timeout]", HELPER_OUTPUT_MAX_CHARS) });
      }, 180000);
      child.on("error", (e) => {
        finish(null, e);
      });
      child.on("close", (code) => {
        finish({ status: code, stdout, stderr });
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
const SYNC_RESPONSE_BUDGET_DEFAULT_MS = 100000;

const RUNTIME_LIMIT_SPECS = [
  ["SHELL_TIMEOUT", 120, 1, 86400],
  ["MCP_SYNC_RESPONSE_BUDGET_MS", SYNC_RESPONSE_BUDGET_DEFAULT_MS, 1000, 115000],
  ["ACTIVITY_LOG_MAX", 500, 1, 100000],
  ["PROJECT_MEMORY_MAX_BYTES", 25000, 0, 5000000],
  ["PROJECT_MEMORY_MAX_LINES", 200, 0, 10000],
  ["AUTO_MEMORY_MAX_BYTES", 25000, 1024, 10000000],
  ["AUTO_MEMORY_MAX_LINES", 200, 1, 10000],
  ["CHECKPOINT_MAX_COUNT", 500, 1, 100000],
  ["CHECKPOINT_RETENTION_DAYS", 30, 1, 3650],
  ["CHECKPOINT_MAX_FILE_BYTES", 5242880, 1024, 1073741824],
  ["CHECKPOINT_MAX_TOTAL_BYTES", 33554432, 65536, 134217728],
  ["CHECKPOINT_MAX_NODES", 10000, 100, 100000],
  ["AUDIT_LOG_MAX_BYTES", 10485760, 1024, 1073741824],
  ["PROCESS_MAX_RUNNING", 16, 1, 128],
  ["PROCESS_HISTORY_MAX", 32, 1, 1000],
  ["PROCESS_LOG_MAX_CHARS", 200000, 4096, 2000000],
  ["SHELL_OUTPUT_MAX_CHARS", 250000, 4096, 1000000],
  ["GIT_OUTPUT_MAX_CHARS", 500000, 4096, 2000000],
  ["READ_TEXT_MAX_BYTES", 2097152, 65536, 6291456],
  ["EDIT_TEXT_MAX_BYTES", 5242880, 65536, 67108864],
  ["READ_BASE64_MAX_BYTES", 2097152, 65536, 2097152],
  ["MCP_TOOL_RESULT_MAX_BYTES", 7340032, 262144, 8388608],
  ["MCP_TOOL_RESULT_TEXT_DUPLICATE_MAX_BYTES", 131072, 16384, 524288],
];

/**
 * Fill missing/empty managed-runtime defaults in an existing instance .env.
 * Besides session policy, AUDIT_LOG_PATH must stay relative to MCP_ENV_FILE so
 * multiple managed instances do not silently share the repo-root audit log.
 * Invalid non-empty values are left untouched for normal validation/reporting.
 */
async function ensureManagedRuntimeDefaults(name) {
  const file = instPaths(name).env;
  return enqueueFileMutation(file, async () => {
    try {
      // Re-read inside the same mutation queue used by saveInstanceEnv so an
      // auto-start/default-fill cannot overwrite a concurrent config save.
      const raw = await readInstanceEnvRaw(name);
      if (!raw.includes("=")) return { changed: false };
      const env = parseDotEnv(raw);
      const updates = {};
      const managedDefaults = {
        ...SESSION_POLICY_DEFAULTS,
        MCP_SYNC_RESPONSE_BUDGET_MS: SYNC_RESPONSE_BUDGET_DEFAULT_MS,
        AUDIT_LOG_PATH: ".mcp-audit.log",
      };
      for (const [key, fallback] of Object.entries(managedDefaults)) {
        const current = String(env[key] ?? "").trim();
        if (current === "") updates[key] = String(fallback);
      }
      // Recovery is a runtime invariant now; remove the obsolete hidden switch
      // from pre-existing managed instances instead of preserving invisible drift.
      if (Object.prototype.hasOwnProperty.call(env, "MCP_SESSION_RECOVERY")) {
        updates.MCP_SESSION_RECOVERY = null;
      }
      if (Object.prototype.hasOwnProperty.call(env, "CHATGPT_AUTO_APPROVE")) {
        updates.CHATGPT_AUTO_APPROVE = null;
      }
      if (Object.keys(updates).length === 0) return { changed: false };
      const next = serializeDotEnv({ ...env, ...updates }, raw);
      await atomicWriteFile(file, next, "utf8");
      return { changed: true, updates };
    } catch (err) {
      if (err?.code === "ENOENT") return { changed: false };
      throw err;
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
  const wireMax = values.MCP_TOOL_RESULT_MAX_BYTES;
  const duplicateMax = values.MCP_TOOL_RESULT_TEXT_DUPLICATE_MAX_BYTES;
  if (
    Number.isInteger(wireMax) &&
    Number.isInteger(duplicateMax) &&
    duplicateMax > wireMax
  ) {
    errors.push("MCP_TOOL_RESULT_TEXT_DUPLICATE_MAX_BYTES must not exceed MCP_TOOL_RESULT_MAX_BYTES");
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

  const buildState = await runtimeBuildStatus();
  push(
    fs.existsSync(SERVER_ENTRY) && !buildState.sourceNewerThanBuild,
    "Build",
    !fs.existsSync(SERVER_ENTRY)
      ? "dist/index.js is missing — run Install/Build"
      : buildState.sourceNewerThanBuild
        ? "Runtime source is newer than dist — run Install/Build"
        : "Compiled runtime is current with source"
  );

  const st = await serverStatus(name);
  push(
    !st.portOccupied && !st.invalidConfig && !st.artifactDrift && !st.buildDrift,
    "Server",
    st.running
      ? st.buildDrift
        ? `Running on port ${st.port}, but runtime source is newer than dist — run Install/Build, then restart Gateway`
        : st.artifactDrift
        ? `Đang chạy trên cổng ${st.port}, nhưng dist/index.js mới hơn process — cần Khởi động lại Gateway`
        : `Đang chạy trên cổng ${st.port}`
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
      SHELL_TIMEOUT: env.SHELL_TIMEOUT || "120",
      MCP_SYNC_RESPONSE_BUDGET_MS: env.MCP_SYNC_RESPONSE_BUDGET_MS || String(SYNC_RESPONSE_BUDGET_DEFAULT_MS),
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
      autoStart: config.autoStart !== false,
      lastTunnelUrl: config.lastTunnelUrl || "",
    },
    server: srv,
    tunnel: tun,
    check: chk,
    installed,
  };
}

let instanceCreateChain = Promise.resolve();

function enqueueInstanceCreate(operation) {
  const run = instanceCreateChain.then(operation, operation);
  instanceCreateChain = run.then(() => undefined, () => undefined);
  return run;
}

async function createInstanceUnlocked(body) {
  const name = String(body.name || "").trim().toLowerCase();
  if (!INSTANCE_NAME_RE.test(name)) {
    return { ok: false, error: "Tên instance: 2–32 ký tự, chỉ chữ thường/số/gạch ngang, bắt đầu bằng chữ hoặc số." };
  }
  const existingInstances = await listInstances();
  if (existingInstances.includes(name)) {
    return { ok: false, error: `Instance '${name}' đã tồn tại.` };
  }
  if (existingInstances.length >= MAX_MANAGED_INSTANCES) {
    return { ok: false, error: `Đã đạt giới hạn ${MAX_MANAGED_INSTANCES} managed instances.` };
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
    "SHELL_TIMEOUT=120",
    `MCP_SYNC_RESPONSE_BUDGET_MS=${SYNC_RESPONSE_BUDGET_DEFAULT_MS}`,
    `MCP_SESSION_TTL_MS=${SESSION_POLICY_DEFAULTS.MCP_SESSION_TTL_MS}`,
    `MCP_SESSION_CLEANUP_MS=${SESSION_POLICY_DEFAULTS.MCP_SESSION_CLEANUP_MS}`,
    `MCP_SESSION_DELETE_GRACE_MS=${SESSION_POLICY_DEFAULTS.MCP_SESSION_DELETE_GRACE_MS}`,
    `MCP_MAX_SESSIONS=${SESSION_POLICY_DEFAULTS.MCP_MAX_SESSIONS}`,
    "AUDIT_LOG_PATH=.mcp-audit.log",
    "",
  ].join("\n");
  await atomicWriteFile(inst.env, envText, "utf8");
  await writeInstanceConfig(name, {
    lastTunnelUrl: "",
    healthPort,
    autoStart: body.autoStart !== false,
  });
  return { ok: true, name, port, adminPort, healthPort, workspace: ws };
}

async function createInstance(body) {
  // Port discovery and instance persistence must be one catalog transaction.
  // Otherwise concurrent creates can choose the same free port pair.
  return enqueueInstanceCreate(() => createInstanceUnlocked(body));
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

  // Windows có thể giữ file vài trăm ms sau taskkill — retry Recycle Bin ngắn.
  // Never fall back to recursive permanent deletion for managed instance state.
  for (let i = 0; i < 5; i++) {
    try {
      await recycleManagedDirectory(inst.dir, INSTANCES_DIR);
      break;
    } catch (err) {
      if (i === 4) {
        return { ok: false, error: `Không thể chuyển instance '${name}' vào Recycle Bin: ${String(err?.message || err)}` };
      }
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
    next = serializeDotEnv({ MCP_SESSION_RECOVERY: null, CHATGPT_AUTO_APPROVE: null }, next);
  } else {
    const values = { ...(body.values || {}) };
    delete values.MCP_SESSION_RECOVERY;
    delete values.CHATGPT_AUTO_APPROVE;
    if (!(body.values && Object.prototype.hasOwnProperty.call(body.values, "ADMIN_PORT"))) {
      if (originalValues.ADMIN_PORT) values.ADMIN_PORT = originalValues.ADMIN_PORT;
    }
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) values[key] = null;
      else if (value === MASK_SENTINEL) values[key] = originalValues[key] !== undefined ? originalValues[key] : null;
    }
    next = serializeDotEnv({ ...values, MCP_SESSION_RECOVERY: null, CHATGPT_AUTO_APPROVE: null }, original);
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
  // An omitted health-port setting still means the runtime default (8080).
  // Treating the old value as 0 makes every unrelated config save look like a
  // port change while the instance's own tunnel is listening on 8080.
  const oldHealthPort = Number(originalValues.OPENAI_TUNNEL_HEALTH_PORT || 8080);
  const changesRuntimePort = port !== oldPort || adminPort !== oldAdminPort;
  if (changesRuntimePort && oldPort > 0 && await isPortOpen(oldPort)) {
    const oldHealth = await serverHealth(oldPort);
    if (isLocalCoderHealth(oldHealth, originalValues)) {
      return { ok: false, error: "Server đang chạy — hãy dừng Server trước khi đổi PORT hoặc ADMIN_PORT." };
    }
  }
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
function proxyAdmin(req, res, targetPort, pathname, adminToken = "") {
  let done = false;
  const finish = (fn) => (...args) => {
    if (done) return;
    done = true;
    fn(...args);
  };
  const forwardedHeaders = { ...req.headers, host: `127.0.0.1:${targetPort}` };
  if (adminToken) {
    // The manager already owns the instance .env. Authenticate server-to-server
    // without ever exposing ADMIN_TOKEN to browser JS. Remove a stale browser
    // Authorization header because adminAuth prioritizes it over x-admin-token.
    delete forwardedHeaders.authorization;
    forwardedHeaders["x-admin-token"] = adminToken;
  }
  const options = {
    hostname: "127.0.0.1",
    port: targetPort,
    path: pathname + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""),
    method: req.method,
    headers: forwardedHeaders,
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
    const [instances, manager] = await Promise.all([
      Promise.all(names.map(async (n) => {
      try {
        return await instanceBundle(n, { includeCheck: false });
      } catch (err) {
        // một instance lỗi (vd env bị xóa) không được làm 500 toàn bộ list
        return {
          name: n,
          node: process.version,
          error: String((err && err.message) || err),
          env: {},
          config: { autoStart: true, lastTunnelUrl: "" },
          server: { running: false, port: 0, pid: null, health: null },
          tunnel: { running: false, mode: "cloudflare", kind: null, url: null, healthPort: 8080, cloudflaredExists: false },
          check: { ok: false, items: [], error: String((err && err.message) || err) },
          installed: { dist: fs.existsSync(SERVER_ENTRY), nodeModules: fs.existsSync(path.join(ROOT, "node_modules")) },
        };
      }
      })),
      managerRuntimeStatus(),
    ]);
    return json(res, 200, { ok: true, node: process.version, manager, instances });
  }
  if (!(await listInstances()).length) {
    const noInst = {
      ok: false,
      error: "Chưa có instance nào — tạo workspace trước.",
      instances: [],
      env: {},
      config: {},
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
        if (k === "MCP_SESSION_RECOVERY" || k === "CHATGPT_AUTO_APPROVE") continue;
        // Never ship the plaintext .env to the browser. Secret keys are replaced
        // with a sentinel; saveInstanceEnv restores the original value when the
        // UI round-trips the sentinel unchanged. OPENAI_TUNNEL_API_KEY keeps its
        // set/last4 shape for the structured form's key hint.
        if (k === "OPENAI_TUNNEL_API_KEY" && v) masked[k] = { set: true, last4: v.slice(-4) };
        else if (isSecretKey(k) && v) masked[k] = MASK_SENTINEL;
        else masked[k] = v;
      }
      return json(res, 200, { ok: true, path: inst.env, values: masked });
    }
    if (req.method === "PUT" && sub === "/env") return json(res, 200, await saveInstanceEnv(name, body));

    if (req.method === "GET" && sub === "/config") return json(res, 200, { ok: true, ...(await readInstanceConfig(name)) });
    if (req.method === "PUT" && sub === "/config") {
      const config = await updateInstanceConfig(name, (config) => {
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
      let log = redactSensitiveLogText(rawLog);
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
      config: {},
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
        SHELL_TIMEOUT: env.SHELL_TIMEOUT || "120",
        MCP_SYNC_RESPONSE_BUDGET_MS: env.MCP_SYNC_RESPONSE_BUDGET_MS || String(SYNC_RESPONSE_BUDGET_DEFAULT_MS),
        MCP_SESSION_TTL_MS: env.MCP_SESSION_TTL_MS || String(SESSION_POLICY_DEFAULTS.MCP_SESSION_TTL_MS),
        MCP_SESSION_CLEANUP_MS: env.MCP_SESSION_CLEANUP_MS || String(SESSION_POLICY_DEFAULTS.MCP_SESSION_CLEANUP_MS),
        MCP_SESSION_DELETE_GRACE_MS: env.MCP_SESSION_DELETE_GRACE_MS || String(SESSION_POLICY_DEFAULTS.MCP_SESSION_DELETE_GRACE_MS),
        MCP_MAX_SESSIONS: env.MCP_MAX_SESSIONS || String(SESSION_POLICY_DEFAULTS.MCP_MAX_SESSIONS),
        OPENAI_TUNNEL_ID: env.OPENAI_TUNNEL_ID || "",
        OPENAI_TUNNEL_API_KEY_SET: Boolean(env.OPENAI_TUNNEL_API_KEY),
        OPENAI_TUNNEL_HEALTH_PORT: String(config.healthPort || env.OPENAI_TUNNEL_HEALTH_PORT || "8080"),
      },
      config: {},
    });
  }

  if (req.method === "GET" && p === "/api/env") {
    const raw = await readInstanceEnvRaw(dname);
    const values = parseDotEnv(raw);
    const masked = {};
    for (const [k, v] of Object.entries(values)) {
      if (k === "MCP_SESSION_RECOVERY" || k === "CHATGPT_AUTO_APPROVE") continue;
      if (k === "OPENAI_TUNNEL_API_KEY" && v) masked[k] = { set: true, last4: v.slice(-4) };
      else if (isSecretKey(k) && v) masked[k] = MASK_SENTINEL;
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
      const values = withoutSecrets(body.values || {});
      delete values.MCP_CONNECTOR_NAME;
      delete values.MCP_SESSION_RECOVERY;
      delete values.CHATGPT_AUTO_APPROVE;
      profiles[profileName] = { savedAt: new Date().toISOString(), values };
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
          const r = spawnSync("cscript", ["//nologo", "//B", vbsPath], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 30000,
            maxBuffer: HELPER_OUTPUT_MAX_CHARS,
          });
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
    return json(res, 200, {
      ok: true,
      name: "chatgpt-local-coder-manager",
      version: "2.0.0",
      multiInstance: true,
      ...(await managerRuntimeStatus()),
    });
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
  await removeLegacyConnectorNameConfig();
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
        proxyAdmin(req, res, adminPort, adminPath, String(env.ADMIN_TOKEN || ""));
        return;
      }
      const file = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
      serveStatic(res, path.join(__dirname, file));
    } catch (err) {
      const status = Number.isInteger(err && err.status) ? err.status : 500;
      json(res, status, { ok: false, error: String((err && err.message) || err) });
    }
  });

  server.on("error", async (err) => {
    if (err.code === "EADDRINUSE") {
      const existingManager = await managerHealth(port);
      if (existingManager) {
        console.log(`[Manager] Cổng ${port} đã có Local Coder Manager chạy — mở http://127.0.0.1:${port}`);
        if (!noOpen) openExternal(`http://127.0.0.1:${port}`);
        process.exit(0);
      }
      console.error(`[Manager] Cổng ${port} đang bị process khác chiếm; không coi đó là Local Coder Manager.`);
      process.exit(1);
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
    startManagedLogMaintenance();
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
        if (!srv.ok) {
          console.log(`[Auto] ${name}: bỏ qua Tunnel vì Server chưa chạy an toàn.`);
          continue;
        }
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
