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
 *     config.json   # public UI config + internal secret-safe Server/Tunnel launch evidence
 *     server.pid / tunnel.pid / profile.yaml / server.log / tunnel.log
 *     checkpoints/ / shell-state/  # managed runtime state, isolated from repo root
 *
 * Usage:
 *   node manager/server.mjs            # start + auto-open browser
 *   node manager/server.mjs --no-open  # start without opening browser
 *   chatgpt-local-coder.bat start      # Windows launcher (file duy nhất)
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { copyTruncateLogFile, isSecretKeyName, redactSensitiveLogText, rotateLogFile, scrubLogFile, tailFile } from "./log-utils.mjs";
import { recycleManagedDirectory } from "./safe-delete.mjs";
import { preserveLegacySandboxPolicyManifest, reconcileLegacyRuntimeDirectory, reconcileLegacyShellStateDirectory } from "./runtime-state.mjs";
import { evaluateOpenAiTunnelLaunchState, legacyOpenAiTunnelLaunchFingerprintV1, legacyPidFileMatchesProcessStart, openAiTunnelLaunchFingerprint, waitForTunnelPortRelease } from "./tunnel-state.mjs";
import { configuredPrimaryWorkspaceRootsFromEnv, configuredWorkspaceRootsFromEnv } from "./workspace-scope.mjs";
import { autoStartInstances, DEFAULT_AUTO_START_CONCURRENCY } from "./autostart-policy.mjs";
import {
  OPENAI_TUNNEL_VERSION,
  ensureLazyCodexTunnelRuntime,
  lazyCodexRuntimeLaunchIdentity,
  lazyCodexRuntimePaths,
} from "./tunnel-runtime.mjs";
import {
  atomicWriteFile,
  enqueueKeyedMutation,
  pruneExpiredCache,
  readUtf8FileBounded,
  readResponseTextBounded,
  retryTransientFsMutation,
  appendBoundedTail,
  extractSingleZipEntryBoundedWindows,
  fingerprintRuntimeSources,
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
  path.join(__dirname, "runtime-state.mjs"),
  path.join(__dirname, "tunnel-state.mjs"),
  path.join(__dirname, "workspace-scope.mjs"),
  path.join(__dirname, "autostart-policy.mjs"),
  path.join(__dirname, "tunnel-runtime.mjs"),
];
const ENV_PATH = path.join(ROOT, ".env");
const STATE_DIR = path.resolve(process.env.MANAGER_STATE_DIR || path.join(__dirname, "state"));
const LOG_DIR = path.join(STATE_DIR, "logs");
const CONFIG_PATH = path.join(STATE_DIR, "config.json");
const PROFILES_PATH = path.join(STATE_DIR, "profiles.json");
const LEGACY_INSTANCE_MIGRATION_PATH = path.join(STATE_DIR, "legacy-instance-migration-v1.json");
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
const REPO_ROOT = ROOT; // thư mục repo (chatgpt-local-coder.bat nằm ở đây)
const LAUNCHER_BAT = path.join(ROOT, "chatgpt-local-coder.bat");
const MANAGER_HIDDEN_VBS = path.join(STATE_DIR, "manager-hidden.vbs"); // chỉ dọn legacy
const STARTUP_LNK = IS_WIN
  ? path.join(
      process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"),
      "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
      "ChatGPT Local Coder Manager.lnk"
    )
  : path.join(ROOT, ".autostart");

function psSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function autostartExpectedArguments() {
  const launcherLiteral = `'${LAUNCHER_BAT.replaceAll("'", "''")}'`;
  return `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& ${launcherLiteral} startup"`;
}

function runBoundedHelperProcess(command, args, {
  timeoutMs = 15000,
  maxOutputChars = HELPER_OUTPUT_MAX_CHARS,
  cwd = ROOT,
  env = process.env,
} = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    let forceTimer = null;
    let terminalError = null;
    let timedOut = false;
    let outputOverflow = false;

    const finish = (status) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({ status, stdout, stderr, error: terminalError, timedOut, outputOverflow });
    };
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (kind, chunk) => {
      const text = String(chunk || "");
      if (kind === "stdout") stdout = appendBoundedTail(stdout, text, maxOutputChars);
      else stderr = appendBoundedTail(stderr, text, maxOutputChars);
      if (!outputOverflow && (stdout.length >= maxOutputChars || stderr.length >= maxOutputChars)) {
        outputOverflow = true;
        terminalError = `helper output exceeded ${maxOutputChars} characters`;
        try { child.kill("SIGKILL"); } catch {}
        forceTimer = setTimeout(() => finish(null), 1000);
        forceTimer.unref?.();
      }
    };
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.once("error", (err) => {
      terminalError = String(err?.message || err || "helper spawn failed");
      finish(null);
    });
    child.once("close", (code) => finish(Number.isInteger(code) ? code : null));
    timer = setTimeout(() => {
      timedOut = true;
      terminalError = `helper timed out after ${timeoutMs}ms`;
      try { child.kill("SIGKILL"); } catch {}
      forceTimer = setTimeout(() => finish(null), 1000);
      forceTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
  });
}

async function inspectAutostartLink() {
  const exists = fs.existsSync(STARTUP_LNK);
  if (!exists) return { exists: false, valid: false, reason: "missing" };
  if (!IS_WIN) return { exists: true, valid: true, reason: "non-windows-marker" };

  const psExe = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
  );
  const expectedTarget = psExe;
  const expectedArguments = autostartExpectedArguments();
  const psCode = [
    "$ErrorActionPreference='Stop'",
    "$w=New-Object -ComObject WScript.Shell",
    `$s=$w.CreateShortcut(${psSingleQuoted(STARTUP_LNK)})`,
    `$expectedTarget=[IO.Path]::GetFullPath(${psSingleQuoted(expectedTarget)})`,
    `$expectedLauncher=[IO.Path]::GetFullPath(${psSingleQuoted(LAUNCHER_BAT)})`,
    `$expectedWork=[IO.Path]::GetFullPath(${psSingleQuoted(REPO_ROOT)}).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)`,
    `$expectedArguments=${psSingleQuoted(expectedArguments)}`,
    "$actualTarget=[IO.Path]::GetFullPath($s.TargetPath)",
    "$actualWork=[IO.Path]::GetFullPath($s.WorkingDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)",
    "if (-not [string]::Equals($actualTarget,$expectedTarget,[StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($actualWork,$expectedWork,[StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($s.Arguments,$expectedArguments,[StringComparison]::OrdinalIgnoreCase)) { exit 1 }",
  ].join("; ");
  const result = await runBoundedHelperProcess(
    psExe,
    ["-NoProfile", "-Command", psCode],
    { timeoutMs: 30000, maxOutputChars: HELPER_OUTPUT_MAX_CHARS }
  );
  return {
    exists: true,
    valid: result.status === 0,
    reason: result.status === 0 ? "exact-current-repo" : "stale-or-invalid",
  };
}
async function reconcileAutostartWithLauncher(enable) {
  if (!IS_WIN) {
    if (enable) await atomicWriteFile(STARTUP_LNK, "enabled\n", "utf8");
    else await fsp.rm(STARTUP_LNK, { force: true });
    return inspectAutostartLink();
  }
  const args = ["/d", "/c", LAUNCHER_BAT, "autostart"];
  if (!enable) args.push("off");
  const result = await runBoundedHelperProcess("cmd.exe", args, {
    timeoutMs: 30000,
    maxOutputChars: HELPER_OUTPUT_MAX_CHARS,
    cwd: REPO_ROOT,
  });
  if (result.status !== 0) {
    const detail = String(result.error || result.stderr || result.stdout || "launcher autostart reconciliation failed")
      .trim()
      .slice(-500);
    throw new Error(detail || "launcher autostart reconciliation failed");
  }
  const state = await inspectAutostartLink();
  if (enable && !state.valid) {
    throw new Error("launcher reported success but Startup LNK is not exact CURRENT repo authority");
  }
  if (!enable && state.exists) {
    throw new Error("launcher reported autostart disabled but Startup LNK still exists");
  }
  return state;
}
const NPM_CMD = IS_WIN ? "npm.cmd" : "npm";
const CLOUDFLARED = IS_WIN ? path.join(ROOT, "cloudflared.exe") : "cloudflared";
const CLOUDFLARED_PROC = IS_WIN ? "cloudflared.exe" : "cloudflared";
const OPENAI_TUNNEL_CLIENT = IS_WIN ? "tunnel-client.exe" : "tunnel-client";
const OPENAI_TUNNEL_CLIENT_EXE = path.join(ROOT, "bin", "tunnel-client.exe");
const OPENAI_TUNNEL_ZIP_URL = `https://github.com/openai/tunnel-client/releases/download/${OPENAI_TUNNEL_VERSION}/tunnel-client-${OPENAI_TUNNEL_VERSION}-windows-amd64.zip`;
/* Marker ghi bản tunnel-client đang cài trong bin/. ensureTunnelClient tự nâng
 * cấp khi marker lệch OPENAI_TUNNEL_VERSION (bản cũ được đổi tên giữ lại làm
 * backup có thể khôi phục, không xóa thẳng). */
const TUNNEL_CLIENT_VERSION_FILE = path.join(ROOT, "bin", "tunnel-client.version");
const FOLDER_PICKER_CS = path.join(__dirname, "folder-picker.cs");
const FOLDER_PICKER_EXE = path.join(STATE_DIR, "bin", "folder-picker.exe");
const CSC_PATH = [
  "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  "C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe",
].find(fs.existsSync) || null;
const SERVER_ENTRY = path.join(ROOT, "dist", "index.js");
const SANDBOX_SETUP_SCRIPT = path.join(ROOT, "scripts", "setup-windows-sandbox.mjs");
const RUNTIME_SOURCE_ROOT = path.join(ROOT, "src");
const RUNTIME_ARTIFACT_ROOT = path.join(ROOT, "dist");
const RUNTIME_BUILD_SOURCE_FILES = [
  path.join(ROOT, "package.json"),
  path.join(ROOT, "package-lock.json"),
  path.join(ROOT, "tsconfig.json"),
];
const RUNTIME_DEPENDENCY_SOURCE_FILES = [
  path.join(ROOT, "package.json"),
  path.join(ROOT, "package-lock.json"),
];
const RUNTIME_DEPENDENCY_STAMP = path.join(STATE_DIR, "runtime-dependencies.sha256");
const RUNTIME_BUILD_CACHE_MS = 1500;
const RUNTIME_BUILD_MAX_ATTEMPTS = 3;
let runtimeBuildCache = { at: 0, value: null };
function clearRuntimeBuildCache() {
  runtimeBuildCache = { at: 0, value: null };
}
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
async function runtimeSourceFingerprint() {
  return fingerprintRuntimeSources({
    sourceRoot: RUNTIME_SOURCE_ROOT,
    sourceFiles: RUNTIME_BUILD_SOURCE_FILES,
    baseDir: ROOT,
  });
}
async function runtimeDependencyFingerprint() {
  return fingerprintRuntimeSources({
    sourceFiles: RUNTIME_DEPENDENCY_SOURCE_FILES,
    baseDir: ROOT,
  });
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

/* ---------------- manager self-restart ---------------- */
/* Manager chạy code cũ hơn source (artifactDrift) → cần khởi động lại để nạp
 * logic mới. Restart an toàn: trả response trước → spawn bản thay thế detached
 * (--restart <token>) → đóng server + exit sau grace. Bản thay thế chờ cổng
 * được giải phóng rồi mới listen, và tự nhận nuôi lại các instance đang chạy. */
const MANAGER_LOG = path.join(LOG_DIR, "manager.log");
const MANAGER_RESTART_FILE = path.join(STATE_DIR, "manager-restart.json");
const MANAGER_RESTART_GRACE_MS = 1500;
const MANAGER_RESTART_RETRY_MS = 20000;
const MANAGER_RESTART_PREPARE_TIMEOUT_MS = 8000;
// A full-disk instance can still cold-start slowly immediately after Windows
// login (disk/cache/AV contention, runtime-state migration, Node initialization).
// Do not classify a live bootstrap as failed after the former 20s window.
const SERVER_START_TIMEOUT_TRUSTED_MS = 120000;
// First strict-mode startup can spend materially longer preparing/verifying the
// AppContainer ACL policy for a broad configured workspace root.
const SERVER_START_TIMEOUT_STRICT_MS = 180000;
const SANDBOX_COMPAT_CHECK_TIMEOUT_MS = 30000;
const SANDBOX_COMPAT_SETUP_TIMEOUT_MS = 6 * 60 * 1000;
const BOOT_TUNNEL_HEALTH_CONFIRMATIONS = 3;
const BOOT_TUNNEL_HEALTH_CONFIRM_INTERVAL_MS = 500;
let httpServer = null;
let managerRestartInFlight = false;
let installInProgress = false;
let runtimeDeployChain = Promise.resolve();
let runtimeDeployInProgress = 0;
const activeManagerMutations = new Map();
let managerMutationSequence = 0;
let sandboxCompatibilityChain = Promise.resolve();
const cancelledBootAutoStart = new Set();
const serverStartInFlight = new Map();
const serverRestartInFlight = new Map();
// Keep the legacy env key for backward compatibility, but this timer is now an
// observation-only maintenance detector. It must never auto-restart healthy service.
const staleConfigObserveIntervalRaw = Number(process.env.MANAGER_STALE_CONFIG_RECONCILE_INTERVAL_MS || 5000);
const STALE_CONFIG_OBSERVE_INTERVAL_MS = Number.isFinite(staleConfigObserveIntervalRaw)
  ? Math.max(1000, Math.trunc(staleConfigObserveIntervalRaw))
  : 5000;
const STALE_CONFIG_RETRY_COOLDOWN_MS = 30000;
const disruptiveRestartQuietRaw = Number(process.env.MANAGER_MCP_RESTART_QUIET_MS || 8000);
const DISRUPTIVE_RESTART_QUIET_MS = Number.isFinite(disruptiveRestartQuietRaw)
  ? Math.min(60000, Math.max(1000, Math.trunc(disruptiveRestartQuietRaw)))
  : 8000;
const disruptiveRestartWaitRaw = Number(process.env.MANAGER_MCP_RESTART_WAIT_MS || 15000);
const DISRUPTIVE_RESTART_WAIT_MS = Number.isFinite(disruptiveRestartWaitRaw)
  ? Math.min(120000, Math.max(DISRUPTIVE_RESTART_QUIET_MS, Math.trunc(disruptiveRestartWaitRaw)))
  : 15000;
const staleConfigObserveInFlight = new Map();
const staleConfigRetryAfter = new Map();
let staleConfigObserveTimer = null;

async function checkManagerSourceSyntax() {
  const result = await runBoundedHelperProcess(
    process.execPath,
    ["--check", fileURLToPath(import.meta.url)],
    { timeoutMs: 15000, maxOutputChars: HELPER_OUTPUT_MAX_CHARS }
  );
  if (result.status !== 0) {
    const detail = String(result.error || result.stderr || result.stdout || "syntax check failed").trim().slice(0, 300);
    return { ok: false, error: detail };
  }
  return { ok: true };
}

async function requestManagerRestart() {
  if (managerRestartInFlight) return { ok: false, error: "Manager đang khởi động lại rồi." };
  if (installInProgress) return { ok: false, error: "Install đang chạy — chờ xong rồi khởi động lại Manager." };
  if (runtimeDeployInProgress > 0) {
    return { ok: false, retryable: true, error: "Shared runtime build/deploy đang chạy; từ chối self-restart Manager giữa transaction." };
  }
  if (activeManagerMutations.size > 0) {
    return {
      ok: false,
      retryable: true,
      error: "Manager đang có mutation request chưa settle; từ chối self-restart để không cắt ngang state persistence.",
      activeMutations: [...activeManagerMutations.values()].map((entry) => ({
        method: entry.method,
        path: entry.path,
        startedAt: entry.startedAt,
      })),
    };
  }
  const busyInstanceCommands = [...instanceCommandChains.keys()];
  const busyServerInstances = [...new Set([...serverCommandChains.keys(), ...serverLifecycleChains.keys()])];
  const busyTunnelInstances = [...new Set([...tunnelCommandChains.keys(), ...tunnelLifecycleChains.keys()])];
  if (busyInstanceCommands.length > 0 || busyServerInstances.length > 0 || busyTunnelInstances.length > 0) {
    return {
      ok: false,
      retryable: true,
      error: "Manager đang có command/lifecycle Server/Tunnel chưa settle; từ chối self-restart để không cắt giữa spawn và persistence.",
      busyInstanceCommands,
      busyServerInstances,
      busyTunnelInstances,
    };
  }
  // Close mutation admission before the first await. An asynchronous syntax
  // helper must not open a race where a new lifecycle mutation can enter after
  // the busy snapshot but before restart handoff authority is established.
  managerRestartInFlight = true;
  const check = await checkManagerSourceSyntax();
  if (!check.ok) {
    managerRestartInFlight = false;
    return { ok: false, error: `Manager source lỗi cú pháp — không restart được: ${check.error}` };
  }
  const token = randomUUID();
  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    await atomicWriteFile(
      MANAGER_RESTART_FILE,
      JSON.stringify({ token, at: Date.now(), pid: process.pid }),
      "utf8"
    );
  } catch (err) {
    managerRestartInFlight = false;
    return {
      ok: false,
      error: `Không persist được restart handoff token; Manager hiện tại được giữ nguyên: ${String((err && err.message) || err).slice(0, 300)}`,
    };
  }
  await rotateLogFile(MANAGER_LOG).catch(() => {});
  console.log(`[Manager] Restart theo yêu cầu (token ${token.slice(0, 8)}…) — spawn bản mới, giữ nguyên instance.`);
  let replacementPid = null;
  try {
    replacementPid = spawnDetached(
      process.execPath,
      ["manager/server.mjs", "--no-open", "--restart", token],
      MANAGER_LOG
    );
    if (!Number.isSafeInteger(replacementPid) || replacementPid <= 0 || !isPidAlive(replacementPid)) {
      throw new Error(`replacement PID is not live/valid: ${replacementPid}`);
    }
  } catch (err) {
    managerRestartInFlight = false;
    return {
      ok: false,
      error: `Không spawn được replacement Manager; Manager hiện tại được giữ nguyên: ${String((err && err.message) || err).slice(0, 300)}`,
    };
  }
  const prepared = await waitFor(async () => {
    if (!isPidAlive(replacementPid)) return false;
    try {
      const receipt = JSON.parse(await fsp.readFile(MANAGER_RESTART_FILE, "utf8"));
      return Boolean(
        receipt &&
        receipt.token === token &&
        receipt.state === "prepared" &&
        Number(receipt.replacementPid) === replacementPid
      );
    } catch {
      return false;
    }
  }, MANAGER_RESTART_PREPARE_TIMEOUT_MS, 100);
  if (!prepared || !isPidAlive(replacementPid)) {
    if (isPidAlive(replacementPid)) {
      await killPidTree(replacementPid);
      await waitFor(() => !isPidAlive(replacementPid), 3000, 100);
    }
    managerRestartInFlight = false;
    return {
      ok: false,
      error: "Replacement Manager không hoàn tất prepared handoff; Manager hiện tại được giữ nguyên.",
      replacementPid,
      replacementPrepared: false,
    };
  }
  // Return the API response while the old listener is still alive. After the
  // response grace window, close only the listener (not the process), let the
  // prepared replacement bind the canonical port, and require a second atomic
  // `listening` receipt before the old process exits. If the replacement dies or
  // never binds, the old Manager re-opens its listener instead of creating an
  // avoidable control-plane outage.
  setTimeout(() => {
    void (async () => {
      const reopenOldListener = async () => {
        if (!httpServer || httpServer.listening) return true;
        try {
          await new Promise((resolve, reject) => {
            const onError = (err) => {
              httpServer.off("listening", onListening);
              reject(err);
            };
            const onListening = () => {
              httpServer.off("error", onError);
              resolve();
            };
            httpServer.once("error", onError);
            httpServer.once("listening", onListening);
            httpServer.listen(managerPortNum, "127.0.0.1");
          });
          return true;
        } catch (err) {
          console.error(`[Manager] Restart rollback could not re-bind port ${managerPortNum}: ${String(err?.message || err).slice(0, 300)}`);
          return false;
        }
      };

      try {
        if (httpServer?.listening) {
          await new Promise((resolve, reject) => {
            httpServer.close((err) => err ? reject(err) : resolve());
          });
        }
        const listening = await waitFor(async () => {
          if (!isPidAlive(replacementPid)) return false;
          try {
            const receipt = JSON.parse(await fsp.readFile(MANAGER_RESTART_FILE, "utf8"));
            return Boolean(
              receipt &&
              receipt.token === token &&
              receipt.state === "listening" &&
              Number(receipt.replacementPid) === replacementPid
            );
          } catch {
            return false;
          }
        }, MANAGER_RESTART_RETRY_MS + 5000, 100);
        if (listening && isPidAlive(replacementPid)) {
          process.exit(0);
        }

        if (isPidAlive(replacementPid)) {
          await killPidTree(replacementPid);
          await waitFor(() => !isPidAlive(replacementPid), 3000, 100);
        }
        managerRestartInFlight = false;
        await reopenOldListener();
        console.error("[Manager] Replacement never proved canonical-port ownership; old Manager stayed alive and attempted listener rollback.");
      } catch (err) {
        managerRestartInFlight = false;
        await reopenOldListener();
        console.error(`[Manager] Restart handoff failed; old Manager stayed alive: ${String(err?.message || err).slice(0, 300)}`);
      }
    })();
  }, MANAGER_RESTART_GRACE_MS);
  return { ok: true, pid: process.pid, replacementPid, handoffPending: true };
}

/* Canonical ChatGPT public contract (ABI v1) — read straight from the repo
 * fixture so /health stays meaningful even when dist/ is stale. The manager
 * cannot know which tool profile an instance runs with, so per-instance
 * runtime state (profile, live hash, dynamic flags) comes from agent_status. */
const CONTRACT_FIXTURE_PATH = path.join(ROOT, "scripts", "fixtures", "chatgpt-public-contract-v1.json");
let managerBootId = null;
function getManagerBootId() {
  if (!managerBootId) managerBootId = randomUUID();
  return managerBootId;
}
async function publicContractFingerprint() {
  try {
    const raw = JSON.parse(await fsp.readFile(CONTRACT_FIXTURE_PATH, "utf8"));
    return {
      version: raw.version,
      hash: raw.hash,
      tool_count: Array.isArray(raw.tools) ? raw.tools.length : null,
    };
  } catch {
    // Fixture thiếu/hỏng không được làm chết health endpoint; instance-level
    // self-check (MCP_PUBLIC_CONTRACT_DRIFT) vẫn fail-closed riêng.
    return null;
  }
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
      delete profile.values.WORKSPACE_PATHS;
      delete profile.values.ALLOWED_WORKSPACE_PATHS;
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
let portPidScanGeneration = 0;
let portPidScanInFlight = null;
function invalidatePortPidCache() {
  portPidCache = { at: 0, pids: new Map() };
  portPidScanGeneration += 1;
}

function runNetstatListenerScan(timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("netstat", ["-ano", "-p", "tcp"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maxBytes = 2 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const finish = (err, result = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };
    const appendBounded = (current, chunk, label) => {
      const next = current + String(chunk || "");
      if (Buffer.byteLength(next, "utf8") > maxBytes) {
        try { child.kill("SIGKILL"); } catch {}
        finish(new Error(`${label} exceeded ${maxBytes} bytes`));
        return current;
      }
      return next;
    };

    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk, "stdout"); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, "stderr"); });
    child.once("error", (err) => finish(err));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(String(stderr || stdout || `exit ${code ?? "null"}${signal ? ` signal=${signal}` : ""}`).trim()));
        return;
      }
      finish(null, stdout);
    });
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
}

async function listeningPortPids() {
  if (Date.now() - portPidCache.at < PORT_PID_CACHE_TTL_MS) return portPidCache.pids;
  // netstat can transiently exceed a few seconds during Windows cold boot or
  // heavy process churn. Ownership must still fail closed, but a single helper
  // timeout must not freeze the Manager event loop or turn an unrelated request
  // into an availability outage. Retry asynchronously with bounded increasing
  // budgets, coalesce callers observing the same lifecycle generation, and cache
  // only a successful scan from the still-current generation.
  const scanTimeouts = [3000, 6000, 10000];
  const generation = portPidScanGeneration;
  if (portPidScanInFlight?.generation === generation) return portPidScanInFlight.promise;

  const pending = (async () => {
    const scanFailures = [];
    let out = null;
    for (let attempt = 0; attempt < scanTimeouts.length; attempt++) {
      const timeout = scanTimeouts[attempt];
      try {
        out = await runNetstatListenerScan(timeout);
        break;
      } catch (err) {
        const detail = String(err?.message || err || "unknown netstat failure");
        scanFailures.push(`attempt ${attempt + 1}/${scanTimeouts.length} (${timeout}ms): ${detail.slice(0, 180)}`);
      }
    }
    if (out === null) {
      throw new Error(`PROCESS_PORT_SCAN_FAILED: netstat listener ownership scan failed after bounded retries: ${scanFailures.join("; ").slice(0, 700)}`);
    }

    const pids = new Map();
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
      if (!m) continue;
      const port = Number(m[1]);
      const pid = Number(m[2]);
      if (Number.isInteger(port) && Number.isInteger(pid) && pid > 0 && !pids.has(port)) pids.set(port, pid);
    }
    if (generation === portPidScanGeneration) portPidCache = { at: Date.now(), pids };
    return pids;
  })();

  portPidScanInFlight = { generation, promise: pending };
  try {
    return await pending;
  } finally {
    if (portPidScanInFlight?.generation === generation && portPidScanInFlight.promise === pending) {
      portPidScanInFlight = null;
    }
  }
}
async function pidOnPort(port) {
  return (await listeningPortPids()).get(Number(port)) || null;
}

async function portsForPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return [];
  const ports = [];
  for (const [port, ownerPid] of await listeningPortPids()) {
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
  let raw;
  try {
    raw = await readUtf8FileBounded(p, MANAGER_JSON_MAX_BYTES, "manager state JSON");
  } catch (err) {
    if (err?.code === "ENOENT") return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`MANAGER_JSON_INVALID: ${p}: ${String(err?.message || err).slice(0, 300)}`);
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
  let raw;
  try {
    raw = await readUtf8FileBounded(p, MANAGER_PID_MAX_BYTES, "manager PID file");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  const text = raw.trim();
  const pid = Number(text);
  if (!text || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`MANAGER_PID_INVALID: ${p}: expected a positive integer PID, received ${JSON.stringify(text.slice(0, 80))}`);
  }
  return pid;
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

async function killPidTree(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    const args = IS_WIN ? ["/PID", String(pid), "/T", "/F"] : ["-9", String(pid)];
    const res = await runBoundedHelperProcess(IS_WIN ? "taskkill" : "kill", args, {
      timeoutMs: 5000,
      maxOutputChars: 256 * 1024,
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

async function isPidDefinitelyDead(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (isPidAlive(pid)) return false;
  if (!IS_WIN) return true;

  // `process.kill(pid, 0)` is a useful fast liveness probe, but on Windows it is
  // not strong enough by itself to authorize rewriting lifecycle authority. A
  // transient/permission/runtime failure can otherwise make a still-live but
  // mismatched server.pid look dead, allowing crash-window recovery to silently
  // overwrite the conflict. Confirm absence through the OS process table; if that
  // confirmation itself fails, fail closed and preserve the existing ledger.
  return await new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\"; if ($null -eq $p) { 'dead' } else { 'alive' }`,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    const maxBytes = 64 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const appendBounded = (current, chunk) => {
      const next = current + String(chunk || "");
      if (Buffer.byteLength(next, "utf8") > maxBytes) {
        try { child.kill("SIGKILL"); } catch {}
        finish(false);
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once("error", () => finish(false));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0 || String(stderr || "").trim()) {
        finish(false);
        return;
      }
      finish(String(stdout || "").trim().toLowerCase() === "dead");
    });
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(false);
    }, 5000);
    timer.unref?.();
  });
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

async function validateManagedWorkspaceScope(env) {
  const primaryRoots = configuredPrimaryWorkspaceRootsFromEnv(env, ROOT);
  if (primaryRoots.length === 0) {
    return {
      ok: false,
      workspaceMissing: true,
      roots: [],
      error: "WORKSPACE_SCOPE_MISSING: WORKSPACE_PATH must identify exactly one primary workspace root.",
    };
  }
  if (primaryRoots.length !== 1) {
    return {
      ok: false,
      workspaceMissing: false,
      roots: primaryRoots,
      error: "WORKSPACE_SCOPE_INVALID: WORKSPACE_PATH must identify exactly one primary workspace root; use EXTRA_WORKSPACE_PATHS for additional explicitly intended roots.",
    };
  }
  const roots = configuredWorkspaceRootsFromEnv(env, ROOT);
  for (const root of roots) {
    try {
      if (!(await fsp.stat(root)).isDirectory()) {
        return { ok: false, workspaceMissing: true, roots, error: `Workspace root does not exist or is not a directory: ${root}` };
      }
    } catch {
      return { ok: false, workspaceMissing: true, roots, error: `Workspace root does not exist or is not a directory: ${root}` };
    }
  }
  // A configured root is explicit authority even when it is a collection/container
  // of multiple repositories. In strict mode the boundary is still the configured
  // root itself; nested repositories do not widen access outside that root.
  return { ok: true, roots };
}

async function migrateLegacyRuntimeState(name, env, inst) {
  if (name !== "default") return;

  // A short-lived older manager migration used shell-state.legacy-orphan as a
  // non-destructive conflict archive. If it contains the AppContainer policy
  // manifest, copy/merge only that authority metadata back into the canonical
  // shell-state directory before runtime initialization. Preserve the orphan
  // tree itself for recovery; do not merge arbitrary shell state implicitly.
  const historicalShellOrphan = path.join(inst.dir, "shell-state.legacy-orphan");
  try {
    const restoredPolicy = await preserveLegacySandboxPolicyManifest({
      legacyDir: historicalShellOrphan,
      targetDir: path.join(inst.dir, "shell-state"),
      instanceId: name,
    });
    if (!["none", "identical", "covered"].includes(restoredPolicy.action)) {
      console.log(`[manager] Recovered sandbox policy metadata from historical shell-state orphan (${restoredPolicy.action}).`);
    }
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

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
      const migrationArgs = {
        legacy: item.legacy,
        target: item.target,
        instanceDir: inst.dir,
        repoRoot: ROOT,
        label: item.envKey,
      };
      const result = item.envKey === "MCP_SHELL_STATE_DIR"
        ? await reconcileLegacyShellStateDirectory({ ...migrationArgs, instanceId: name })
        : await reconcileLegacyRuntimeDirectory(migrationArgs);
      if (result.action === "preserved_conflict") {
        console.warn(
          `[manager] Legacy runtime state conflict preserved without overwrite: ${item.legacy} -> ${result.preserved}; ` +
          `managed target remains authoritative at ${item.target}`
        );
      } else if (result.action === "migrated") {
        console.log(`[manager] Migrated legacy runtime state: ${item.legacy} -> ${item.target}`);
      }
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
    // Missing managed config is missing authority, not consent to start. New
    // instances and legacy migration always persist an explicit autoStart value.
    autoStart: false,
  });
  delete config.connectorName;
  return config;
}

async function readServerLaunchEvidence(name) {
  try {
    const config = await readInstanceConfig(name);
    return {
      serverLaunchPid: Number(config?.serverLaunchPid) || null,
      serverLaunchPort: Number(config?.serverLaunchPort) || null,
      available: true,
      error: null,
    };
  } catch (err) {
    // config.json owns Tunnel/autostart preferences plus optional discovery-only
    // Gateway launch hints. It is not Server liveness or destructive-ownership
    // authority. A corrupt/unreadable auxiliary config must therefore never make
    // an otherwise recoverable manual Gateway Start/Stop impossible. Status simply
    // falls back to the stronger live PID/listener/health proofs below and keeps
    // the original config bytes untouched for explicit repair.
    return {
      serverLaunchPid: null,
      serverLaunchPort: null,
      available: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function tryUpdateServerLaunchEvidence(name, updater) {
  try {
    await updateInstanceConfig(name, updater);
    return { updated: true, error: null };
  } catch (err) {
    // Launch evidence is discovery-only and NEVER grants stop/restart authority.
    // Do not turn an auxiliary config parse/write failure into a Server lifecycle
    // failure after the process/PID authority has already changed. Preserve the
    // existing config bytes and continue using exact PID/listener/health proof.
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[manager] ${name}: optional Server launch evidence not updated: ${error}`);
    return { updated: false, error };
  }
}

function publicInstanceConfig(config) {
  return {
    lastTunnelUrl: String(config?.lastTunnelUrl || ""),
    healthPort: Number(config?.healthPort || 8080),
    autoStart: config?.autoStart === true,
  };
}

function clearServerLaunchEvidence(config) {
  delete config.serverLaunchPid;
  delete config.serverLaunchPort;
}

function clearTunnelLaunchEvidence(config) {
  delete config.openaiTunnelLaunchFingerprint;
  delete config.tunnelProcessStartedAt;
}

async function writeInstanceConfig(name, config) {
  const next = { ...config };
  delete next.connectorName;
  await writeJson(instPaths(name).config, next);
}

async function updateInstanceConfig(name, updater) {
  const file = instPaths(name).config;
  return mutateJson(file, { lastTunnelUrl: "", healthPort: 8080, autoStart: false }, async (config) => {
    await updater(config);
    delete config.connectorName;
    return config;
  });
}

async function removeLegacyConnectorNameConfig() {
  for (const name of await listInstances()) {
    try {
      if (!fs.existsSync(instPaths(name).config)) continue;
      await updateInstanceConfig(name, () => undefined);
    } catch (err) {
      // A corrupt config must never be rewritten from defaults (which could turn
      // autoStart back on), but one damaged workspace must not take the Manager
      // control plane down. Leave the bytes untouched and surface the instance
      // error through /api/instances for explicit repair.
      console.warn(`[manager] ${name}: config cleanup skipped: ${String(err?.message || err).slice(0, 300)}`);
    }
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
    let configHealthPort = null;
    try {
      const cfg = await readInstanceConfig(n);
      configHealthPort = cfg.healthPort;
    } catch (err) {
      // config.json owns UI/autostart/tunnel launch evidence, but the tunnel
      // health port is also persisted in .env. One corrupt auxiliary config must
      // not make unrelated instance create/save operations unavailable. Reserve
      // the .env/default port here; actual allocation also probes OS listeners.
      console.warn(
        `[Manager] ${n}: config unreadable during port catalog scan; using .env health-port authority: ${String(err?.message || err).slice(0, 220)}`
      );
    }
    const h = Number(configHealthPort || env.OPENAI_TUNNEL_HEALTH_PORT || 8080);
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

async function readLegacyInstanceMigrationReceipt() {
  let raw;
  try {
    raw = await readUtf8FileBounded(
      LEGACY_INSTANCE_MIGRATION_PATH,
      MANAGER_JSON_MAX_BYTES,
      "legacy instance migration receipt"
    );
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  try {
    const receipt = JSON.parse(raw);
    if (!receipt || receipt.version !== 1 || !["prepared", "complete"].includes(receipt.state)) {
      throw new Error("unsupported receipt shape/state");
    }
    return receipt;
  } catch (err) {
    throw new Error(`LEGACY_INSTANCE_MIGRATION_RECEIPT_INVALID: ${String(err?.message || err).slice(0, 300)}`);
  }
}

async function writeLegacyInstanceMigrationReceipt(receipt) {
  await atomicWriteFile(
    LEGACY_INSTANCE_MIGRATION_PATH,
    JSON.stringify({ version: 1, ...receipt }, null, 2),
    "utf8"
  );
}

async function readLegacyMigrationMarker(dir, expectedMigrationId) {
  const markerPath = path.join(dir, ".legacy-instance-migration-v1.json");
  let raw;
  try {
    raw = await readUtf8FileBounded(markerPath, MANAGER_JSON_MAX_BYTES, "legacy instance migration marker");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch (err) {
    throw new Error(`LEGACY_INSTANCE_MIGRATION_MARKER_INVALID: ${markerPath}: ${String(err?.message || err).slice(0, 300)}`);
  }
  if (
    !marker ||
    marker.version !== 1 ||
    marker.source !== "legacy-single-instance" ||
    marker.migrationId !== expectedMigrationId
  ) {
    throw new Error(`LEGACY_INSTANCE_MIGRATION_MARKER_INVALID: ${markerPath}: migration identity mismatch`);
  }
  return marker;
}

async function listLegacyMigrationStages() {
  const prefix = ".legacy-default-migration-";
  const stages = [];
  const dir = await fsp.opendir(INSTANCES_DIR);
  for await (const entry of dir) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    stages.push({
      name: entry.name,
      migrationId: entry.name.slice(prefix.length),
      dir: path.join(INSTANCES_DIR, entry.name),
    });
  }
  stages.sort((a, b) => a.name.localeCompare(b.name));
  return stages;
}

/** Migrate trạng thái đơn-instance (ROOT/.env + manager/state) sang instance "default". */
async function ensureInstances() {
  await fsp.mkdir(INSTANCES_DIR, { recursive: true });
  const migrationReceipt = await readLegacyInstanceMigrationReceipt();
  const migrationComplete = migrationReceipt?.state === "complete";
  const existingInstances = await listInstances();
  if (existingInstances.length > 0) {
    if (migrationComplete) return;
    if (migrationReceipt?.state === "prepared") {
      const marker = await readLegacyMigrationMarker(instPaths("default").dir, migrationReceipt.migrationId);
      if (!marker) {
        throw new Error(
          "LEGACY_INSTANCE_MIGRATION_INCOMPLETE: a prepared migration exists beside managed instances, but exact default-instance migration identity cannot be proven."
        );
      }
      await writeLegacyInstanceMigrationReceipt({
        state: "complete",
        migrationId: migrationReceipt.migrationId,
        completedAt: new Date().toISOString(),
        reason: "legacy-default-migrated-recovered",
      });
      return;
    }
    // Upgrade path: managed workspaces existed before the receipt contract. Mark
    // migration complete without touching their bytes. From this point onward,
    // deleting the final workspace is a durable intentional zero-instance state.
    await writeLegacyInstanceMigrationReceipt({
      state: "complete",
      completedAt: new Date().toISOString(),
      reason: "managed-instances-present",
    });
    return;
  }
  if (migrationComplete) return;

  const migrationStages = await listLegacyMigrationStages();
  if (migrationReceipt?.state === "prepared") {
    const expectedStage = migrationStages.find((stage) => stage.migrationId === migrationReceipt.migrationId);
    if (!expectedStage || migrationStages.length !== 1) {
      throw new Error(
        `LEGACY_INSTANCE_MIGRATION_INCOMPLETE: prepared migration ${migrationReceipt.migrationId} does not have exactly one matching hidden stage.`
      );
    }
    const marker = await readLegacyMigrationMarker(expectedStage.dir, migrationReceipt.migrationId);
    if (!marker) {
      throw new Error(
        `LEGACY_INSTANCE_MIGRATION_INCOMPLETE: prepared hidden stage ${expectedStage.name} is missing its exact migration marker.`
      );
    }
    const inst = instPaths("default");
    await fsp.rename(expectedStage.dir, inst.dir);
    await writeLegacyInstanceMigrationReceipt({
      state: "complete",
      migrationId: migrationReceipt.migrationId,
      completedAt: new Date().toISOString(),
      reason: "legacy-default-migrated-stage-recovered",
    });
    return;
  }

  if (migrationStages.length > 0) {
    if (migrationStages.length !== 1) {
      throw new Error(
        `LEGACY_INSTANCE_MIGRATION_ORPHAN_STAGE: found ${migrationStages.length} hidden migration stages without a receipt; refusing ambiguous recovery.`
      );
    }
    const orphanStage = migrationStages[0];
    const marker = await readLegacyMigrationMarker(orphanStage.dir, orphanStage.migrationId);
    if (!marker) {
      throw new Error(
        `LEGACY_INSTANCE_MIGRATION_ORPHAN_STAGE: ${orphanStage.name} is partial (no exact marker); preserving it and refusing false completion.`
      );
    }
    // The stage is fully populated and identity-marked; only the global prepared
    // receipt write was lost. Reconstruct it, then atomically publish the stage.
    await writeLegacyInstanceMigrationReceipt({
      state: "prepared",
      migrationId: orphanStage.migrationId,
      preparedAt: new Date().toISOString(),
      reason: "legacy-default-stage-recovered-without-receipt",
    });
    const inst = instPaths("default");
    await fsp.rename(orphanStage.dir, inst.dir);
    await writeLegacyInstanceMigrationReceipt({
      state: "complete",
      migrationId: orphanStage.migrationId,
      completedAt: new Date().toISOString(),
      reason: "legacy-default-migrated-stage-recovered-without-receipt",
    });
    return;
  }

  const legacyEnv = await readEnvRaw();
  if (!legacyEnv) {
    await writeLegacyInstanceMigrationReceipt({
      state: "complete",
      completedAt: new Date().toISOString(),
      reason: "no-legacy-instance-state",
    });
    return;
  }

  // Build the legacy default instance outside the managed-name namespace. The
  // leading dot makes this staging directory impossible for listInstances() to
  // treat as a real instance. Only a fully populated stage is atomically renamed
  // to `default`, so a crash/error cannot leave a partial valid-looking instance.
  const migrationId = randomUUID();
  const stageDir = path.join(INSTANCES_DIR, `.legacy-default-migration-${migrationId}`);
  const staged = {
    dir: stageDir,
    env: path.join(stageDir, ".env"),
    config: path.join(stageDir, "config.json"),
    serverPid: path.join(stageDir, "server.pid"),
    tunnelPid: path.join(stageDir, "tunnel.pid"),
    serverLog: path.join(stageDir, "server.log"),
    tunnelLog: path.join(stageDir, "tunnel.log"),
    marker: path.join(stageDir, ".legacy-instance-migration-v1.json"),
  };
  await fsp.mkdir(stageDir, { recursive: false });
  await atomicWriteFile(staged.env, legacyEnv, "utf8");
  const inst = instPaths("default");
  const legacyConfig = await readConfig();
  const legacyParsed = parseDotEnv(legacyEnv);
  const legacyHealthPortRaw = String(legacyParsed.OPENAI_TUNNEL_HEALTH_PORT || "8080").trim();
  const legacyHealthPort = Number(legacyHealthPortRaw);
  await writeJson(staged.config, {
    lastTunnelUrl: legacyConfig.lastTunnelUrl || "",
    healthPort: Number.isInteger(legacyHealthPort) && legacyHealthPort > 0 && legacyHealthPort < 65536 ? legacyHealthPort : 8080,
    autoStart: true,
  });
  // Nhận nuôi process/log đang chạy (server/tunnel sống sót qua migration)
  for (const [old, dest] of [
    [SERVER_PID_FILE, staged.serverPid],
    [TUNNEL_PID_FILE, staged.tunnelPid],
  ]) {
    try {
      await fsp.copyFile(old, dest);
    } catch (err) {
      if (err?.code !== "ENOENT") {
        throw new Error(`Legacy lifecycle authority migration failed (${old} -> ${dest}): ${String(err?.message || err)}`);
      }
    }
  }
  // Historical logs are diagnostic only. Their absence/copy failure must not
  // block migration, but non-ENOENT failures are surfaced instead of swallowed.
  for (const [old, dest] of [
    [SERVER_LOG, staged.serverLog],
    [TUNNEL_LOG, staged.tunnelLog],
  ]) {
    try {
      await fsp.copyFile(old, dest);
    } catch (err) {
      if (err?.code !== "ENOENT") {
        console.warn(`[manager] Legacy diagnostic log copy skipped (${old} -> ${dest}): ${String(err?.message || err).slice(0, 240)}`);
      }
    }
  }
  await atomicWriteFile(
    staged.marker,
    JSON.stringify({ version: 1, migrationId, source: "legacy-single-instance" }, null, 2),
    "utf8"
  );
  await writeLegacyInstanceMigrationReceipt({
    state: "prepared",
    migrationId,
    preparedAt: new Date().toISOString(),
    reason: "legacy-default-stage-ready",
  });
  await fsp.rename(stageDir, inst.dir);
  await writeLegacyInstanceMigrationReceipt({
    state: "complete",
    migrationId,
    completedAt: new Date().toISOString(),
    reason: "legacy-default-migrated",
  });
}


/** Cache kết quả quét PID ngắn (2s) — tránh spawn powershell.exe liên tục
 *  khi UI gọi /api/instances (mỗi instance 1-2 lần quét mỗi request). */
const pidScanCache = new Map();
const pidScanInFlight = new Map();
let pidScanGeneration = 0;
const PID_SCAN_TTL_MS = 2000;
function invalidateProcessScanCache() {
  pidScanCache.clear();
  pidScanGeneration += 1;
}

function processIdentityScanKey(imageName, substring) {
  return `${imageName}\u0000${substring}`;
}

function processIdentityPowerShellArgs(imageName, substring) {
  const needle = String(substring).replace(/'/g, "''");
  return [
    "-NoProfile",
    "-Command",
    `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter "Name='${imageName}'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { [string]$_.ProcessId + '|' + $_.CreationDate.ToUniversalTime().ToString('o') + '|' + [string]$_.ExecutablePath }`,
  ];
}

function parseProcessIdentityScanOutput(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pidRaw, startedAtRaw, executablePathRaw] = line.split("|", 3);
      const pid = Number(pidRaw);
      const startedAt = String(startedAtRaw || "");
      const executablePath = String(executablePathRaw || "").trim();
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(Date.parse(startedAt)) || !executablePath) {
        throw new Error("malformed PID/CreationDate/ExecutablePath record");
      }
      return { pid, startedAt, executablePath };
    });
}

/**
 * Async variant for HTTP/lifecycle hot paths. Windows CIM can take seconds under
 * process churn; using spawnSync here used to freeze the entire Manager event loop
 * and make unrelated health/control requests time out. Share one in-flight query
 * per exact identity filter and keep the same fail-closed/cache semantics.
 */
async function processesWithCmdLineAsync(imageName, substring) {
  const now = Date.now();
  pruneExpiredCache(pidScanCache, PID_SCAN_TTL_MS, now);
  const key = processIdentityScanKey(imageName, substring);
  const hit = pidScanCache.get(key);
  if (hit) return hit.processes;
  const generation = pidScanGeneration;
  const inFlightKey = `${generation}\u0000${key}`;
  const existing = pidScanInFlight.get(inFlightKey);
  if (existing) return existing;

  const pending = new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", processIdentityPowerShellArgs(imageName, substring), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maxBytes = 512 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const finish = (err, processes = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(processes);
    };
    const appendBounded = (current, chunk, label) => {
      const next = current + String(chunk || "");
      if (Buffer.byteLength(next, "utf8") > maxBytes) {
        try { child.kill("SIGKILL"); } catch {}
        finish(new Error(`PROCESS_IDENTITY_SCAN_FAILED: ${label} exceeded ${maxBytes} bytes`));
        return current;
      }
      return next;
    };

    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk, "stdout"); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, "stderr"); });
    child.once("error", (err) => finish(new Error(`PROCESS_IDENTITY_SCAN_FAILED: ${String(err?.message || err)}`)));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = String(stderr || stdout || `exit ${code ?? "null"}${signal ? ` signal=${signal}` : ""}`)
          .trim()
          .slice(-300);
        finish(new Error(`PROCESS_IDENTITY_SCAN_FAILED: ${detail}`));
        return;
      }
      try {
        const processes = parseProcessIdentityScanOutput(stdout);
        // A lifecycle mutation may have invalidated process authority while this
        // asynchronous CIM query was in flight. Never let an older observation
        // repopulate the post-mutation cache.
        if (generation === pidScanGeneration) {
          pidScanCache.set(key, { at: Date.now(), processes });
        }
        finish(null, processes);
      } catch (err) {
        finish(new Error(`PROCESS_IDENTITY_SCAN_FAILED: ${String(err?.message || err)}`));
      }
    });

    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(new Error("PROCESS_IDENTITY_SCAN_FAILED: process identity scan timed out after 15000ms"));
    }, 15000);
    timer.unref?.();
  });

  pidScanInFlight.set(inFlightKey, pending);
  try {
    return await pending;
  } finally {
    if (pidScanInFlight.get(inFlightKey) === pending) pidScanInFlight.delete(inFlightKey);
  }
}

function sameExecutablePath(actual, expected) {
  if (!actual || !expected) return false;
  try {
    const a = path.resolve(String(actual));
    const b = path.resolve(String(expected));
    return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

function expectedOpenAiTunnelRuntimeIdentity() {
  return IS_WIN
    ? lazyCodexRuntimeLaunchIdentity()
    : `official:${OPENAI_TUNNEL_VERSION}`;
}

function expectedOpenAiTunnelRuntimePath() {
  return IS_WIN
    ? lazyCodexRuntimePaths(ROOT).exe
    : OPENAI_TUNNEL_CLIENT_EXE;
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

function serverMcpTrafficSnapshot(health) {
  const building = Math.max(0, Number(health?.buildingSessions) || 0);
  const recovering = Math.max(0, Number(health?.recoveringSessions) || 0);
  const traffic = health?.mcpTraffic;
  const active = Number(traffic?.activeRequests);
  if (Number.isFinite(active) && active >= 0) {
    const quiet = traffic?.quietForMs;
    return {
      known: true,
      authoritative: true,
      source: "mcpTraffic",
      admission: String(traffic?.admission || "unknown"),
      draining: traffic?.draining === true,
      activeRequests: Math.max(0, Math.trunc(active)) + building + recovering,
      quietForMs: quiet === null || typeof quiet === "undefined" ? null : Math.max(0, Number(quiet) || 0),
      buildingSessions: building,
      recoveringSessions: recovering,
    };
  }

  // Upgrade bridge for the immediately previous runtime generation. Dispatch
  // counters are inferred and may conservatively remain in-flight after a lost
  // response, so they are suitable only for fail-closed *deferral*, never proof
  // that a request is safe to kill. Recent timestamps still provide a quiet window.
  const inferred = Number(health?.mcpDispatch?.stages?.MCP_IN_FLIGHT?.total);
  if (Number.isFinite(inferred) && inferred >= 0) {
    let latestActivityMs = 0;
    const recent = Array.isArray(health?.mcpDispatch?.recent_dispatches)
      ? health.mcpDispatch.recent_dispatches
      : [];
    for (const entry of recent) {
      const candidate = Date.parse(String(entry?.settled_at || entry?.started_at || ""));
      if (Number.isFinite(candidate)) latestActivityMs = Math.max(latestActivityMs, candidate);
    }
    return {
      known: true,
      authoritative: false,
      source: "legacy_mcpDispatch",
      admission: "unknown",
      draining: false,
      activeRequests: Math.max(0, Math.trunc(inferred)) + building + recovering,
      quietForMs: latestActivityMs > 0 ? Math.max(0, Date.now() - latestActivityMs) : null,
      buildingSessions: building,
      recoveringSessions: recovering,
    };
  }

  return {
    known: false,
    authoritative: false,
    source: "unobservable",
    admission: "unknown",
    draining: false,
    activeRequests: building + recovering,
    quietForMs: null,
    buildingSessions: building,
    recoveringSessions: recovering,
  };
}

async function waitForServerTrafficQuiescence(name, state) {
  if (!state?.running || !state?.owned || !Number.isInteger(Number(state.port)) || !Number.isInteger(Number(state.pid))) {
    return { ok: false, retryable: true, preserved: true, error: `Cannot prove a live owned Gateway for traffic drain before disruptive lifecycle (${name}).` };
  }
  const expectedPid = Number(state.pid);
  const deadline = Date.now() + DISRUPTIVE_RESTART_WAIT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const health = await serverHealth(Number(state.port));
    if (!health || Number(health.pid) !== expectedPid || String(health.instance_id || "") !== String(name)) {
      return {
        ok: false,
        retryable: true,
        preserved: true,
        trafficDrain: last,
        error: `Gateway identity changed or became unavailable while waiting for a safe restart window (${name}); preserved current service.`,
      };
    }
    const snapshot = serverMcpTrafficSnapshot(health);
    last = snapshot;
    const quietEnough = snapshot.quietForMs === null || snapshot.quietForMs >= DISRUPTIVE_RESTART_QUIET_MS;
    // Inferred dispatch telemetry may conservatively remain stale or miss a
    // request boundary. It can defer a restart, but it must never prove a
    // destructive lifecycle safe. Only the authoritative HTTP request counter
    // from the Local Coder runtime may satisfy this compatibility bridge.
    if (snapshot.authoritative && snapshot.activeRequests === 0 && quietEnough) {
      return {
        ok: true,
        trafficDrain: snapshot,
        quietRequiredMs: DISRUPTIVE_RESTART_QUIET_MS,
        atomicAdmission: false,
        legacyQuietBridge: true,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    ok: false,
    retryable: true,
    busy: true,
    preserved: true,
    trafficDrain: last,
    quietRequiredMs: DISRUPTIVE_RESTART_QUIET_MS,
    waitBudgetMs: DISRUPTIVE_RESTART_WAIT_MS,
    error: last?.known
      ? `Gateway '${name}' still has recent/active MCP traffic; disruptive restart was deferred to avoid connector 502/response loss.`
      : `Gateway '${name}' does not expose restart-quiescence telemetry; disruptive restart was deferred fail-closed.`,
  };
}

async function waitForExplicitLegacyPreDrainMaintenance(name, state, priorDrain) {
  if (![404, 501].includes(Number(priorDrain?.drainApiStatus))) {
    return { ok: false, preserved: true, error: "Legacy pre-drain maintenance is only valid when the old runtime lacks the drain endpoint." };
  }
  if (!state?.running || !state?.owned || !Number.isInteger(Number(state.port)) || !Number.isInteger(Number(state.pid))) {
    return { ok: false, preserved: true, error: `Cannot prove exact owned legacy Gateway identity before explicit maintenance (${name}).` };
  }

  // This is deliberately NOT an automatic compatibility path. A runtime older
  // than the mcpTraffic/admission contract cannot provide a mathematically atomic
  // no-new-request boundary, so background drift handling, Start, Stop, Delete,
  // and Tunnel lifecycle must continue to fail closed. Explicit Server Restart
  // may cross that one-time upgrade boundary only after several mutually
  // reinforcing idle observations. The receipt remains explicit that admission
  // was not atomically closed, so callers must not misreport zero-gap semantics.
  const expectedPid = Number(state.pid);
  const expectedBootId = String(state.health?.boot_id || "");
  const deadline = Date.now() + DISRUPTIVE_RESTART_WAIT_MS;
  let consecutiveIdle = 0;
  let idleObservedAtMs = null;
  let last = priorDrain?.trafficDrain || null;
  while (Date.now() < deadline) {
    const health = await serverHealth(Number(state.port));
    if (
      !health
      || Number(health.pid) !== expectedPid
      || String(health.instance_id || "") !== String(name)
      || (expectedBootId && String(health.boot_id || "") !== expectedBootId)
    ) {
      return {
        ok: false,
        retryable: true,
        preserved: true,
        trafficDrain: last,
        error: `Legacy Gateway identity changed while proving explicit maintenance idleness (${name}); preserved current service.`,
      };
    }

    const snapshot = serverMcpTrafficSnapshot(health);
    last = snapshot;
    const connectedSessions = Math.max(0, Math.trunc(Number(health.connectedSessions) || 0));
    const countersIdle = Boolean(
      snapshot.source === "legacy_mcpDispatch"
      && snapshot.activeRequests === 0
      && snapshot.buildingSessions === 0
      && snapshot.recoveringSessions === 0
      && connectedSessions === 0
    );
    if (countersIdle) {
      if (idleObservedAtMs === null) idleObservedAtMs = Date.now();
    } else {
      idleObservedAtMs = null;
    }
    // Very old generations did not publish last-dispatch timestamps. For those
    // runtimes, the Manager itself must observe an uninterrupted idle interval
    // at least as long as the configured quiet window; three quick samples are
    // not enough. If a legacy timestamp is available, require that timestamp's
    // quiet age instead. Neither path upgrades inferred telemetry to authoritative.
    const observedQuietForMs = idleObservedAtMs === null ? 0 : Math.max(0, Date.now() - idleObservedAtMs);
    const quietEnough = snapshot.quietForMs !== null
      ? snapshot.quietForMs >= DISRUPTIVE_RESTART_QUIET_MS
      : observedQuietForMs >= DISRUPTIVE_RESTART_QUIET_MS;
    const legacyIdle = countersIdle && quietEnough;
    consecutiveIdle = legacyIdle ? consecutiveIdle + 1 : 0;
    if (consecutiveIdle >= 3) {
      return {
        ok: true,
        admissionClosed: false,
        atomicAdmission: false,
        legacyPreDrainMaintenance: true,
        explicitOnly: true,
        trafficDrain: snapshot,
        connectedSessions,
        observedQuietForMs,
        quietRequiredMs: DISRUPTIVE_RESTART_QUIET_MS,
        warning: "Legacy runtime predates atomic MCP admission drain; explicit maintenance proceeded only after sustained exact-identity idle proof.",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return {
    ok: false,
    retryable: true,
    busy: true,
    preserved: true,
    trafficDrain: last,
    error: `Legacy Gateway '${name}' never proved a sustained explicit-maintenance idle window; current service was preserved.`,
  };
}

async function serverAdminLifecycleRequest(name, action) {
  const env = await readInstanceEnv(name);
  const adminPort = Number(env.ADMIN_PORT || "3001");
  if (!Number.isInteger(adminPort) || adminPort <= 0 || adminPort >= 65536) {
    return { ok: false, status: 0, error: `Instance '${name}' has invalid ADMIN_PORT for lifecycle ${action}.` };
  }
  const headers = {};
  if (env.ADMIN_TOKEN) headers["x-admin-token"] = env.ADMIN_TOKEN;
  try {
    const response = await fetch(`http://127.0.0.1:${adminPort}/api/process/${action}`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(2500),
    });
    let body = null;
    try {
      const text = await readResponseTextBounded(response, 64 * 1024, `server lifecycle ${action} response`);
      body = text ? JSON.parse(text) : null;
    } catch {}
    return {
      ok: response.ok && body?.ok !== false,
      status: response.status,
      body,
      error: response.ok ? null : String(body?.error || `HTTP ${response.status}`),
    };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err) };
  }
}

async function resumeServerTrafficAdmission(name, state) {
  if (!state?.pid || !state?.port) return { ok: true, skipped: true, reason: "missing-runtime-identity" };
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const health = await serverHealth(Number(state.port));
    if (!health || Number(health.pid) !== Number(state.pid) || String(health.instance_id || "") !== String(name)) {
      return { ok: true, skipped: true, reason: "runtime-no-longer-current", attempt };
    }
    const snapshot = serverMcpTrafficSnapshot(health);
    if (snapshot.admission !== "draining") return { ok: true, skipped: true, reason: "admission-not-draining", attempt };

    last = await serverAdminLifecycleRequest(name, "resume");
    if (last.ok) return { ok: true, resumed: true, status: last.status, attempt };
    // Authentication/authorization failure is not transient and must never be
    // retried blindly. Network/5xx failures get a small bounded retry while the
    // exact same runtime identity remains proven above.
    if (last.status === 401 || last.status === 403 || (last.status >= 400 && last.status < 500)) break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
  }
  return { ok: false, resumed: false, error: last?.error || "resume failed", status: last?.status || 0, attempts: 3 };
}

async function drainServerTrafficForDisruption(name, state) {
  if (!state?.running || !state?.owned || !Number.isInteger(Number(state.port)) || !Number.isInteger(Number(state.pid))) {
    return { ok: false, retryable: true, preserved: true, error: `Cannot prove a live owned Gateway before MCP admission drain (${name}).` };
  }
  const expectedPid = Number(state.pid);
  const begin = await serverAdminLifecycleRequest(name, "drain");

  if (!begin.ok) {
    // One-generation compatibility bridge: runtimes from immediately before the
    // admission-gate contract expose authoritative mcpTraffic but no /drain API.
    // They may be upgraded only after a bounded quiet window. Once the new
    // generation is installed, all future disruptive lifecycle uses the atomic
    // gate below and the health-check -> stop TOCTOU is eliminated.
    if (begin.status === 404 || begin.status === 501) {
      const legacy = await waitForServerTrafficQuiescence(name, state);
      return legacy.ok
        ? { ...legacy, admissionClosed: false, drainApiStatus: begin.status }
        : { ...legacy, drainApiStatus: begin.status };
    }
    return {
      ok: false,
      retryable: true,
      preserved: true,
      drainApiStatus: begin.status,
      error: `Gateway '${name}' MCP admission drain failed before disruptive lifecycle: ${begin.error || "unknown error"}`,
    };
  }

  const deadline = Date.now() + DISRUPTIVE_RESTART_WAIT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const health = await serverHealth(Number(state.port));
    if (!health || Number(health.pid) !== expectedPid || String(health.instance_id || "") !== String(name)) {
      const resume = await resumeServerTrafficAdmission(name, state);
      return {
        ok: false,
        retryable: true,
        preserved: true,
        admissionClosed: true,
        trafficDrain: last,
        resume,
        error: `Gateway identity changed or became unavailable after MCP admission drain (${name}); disruptive lifecycle was aborted.`,
      };
    }
    const snapshot = serverMcpTrafficSnapshot(health);
    last = snapshot;
    if (
      snapshot.authoritative
      && snapshot.admission === "draining"
      && snapshot.activeRequests === 0
    ) {
      return {
        ok: true,
        admissionClosed: true,
        atomicAdmission: true,
        trafficDrain: snapshot,
        waitBudgetMs: DISRUPTIVE_RESTART_WAIT_MS,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const resume = await resumeServerTrafficAdmission(name, state);
  return {
    ok: false,
    retryable: true,
    busy: true,
    preserved: true,
    admissionClosed: true,
    trafficDrain: last,
    waitBudgetMs: DISRUPTIVE_RESTART_WAIT_MS,
    resume,
    error: `Gateway '${name}' did not drain active MCP requests within the lifecycle wait budget; current service was preserved and admission resume was attempted.`,
  };
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
function isLocalCoderRuntimeHealth(health) {
  return Boolean(health && health.status === "ok" && health.name === "codex-mcp-server");
}

function isManagedInstanceHealth(health, name, { allowLegacy = false } = {}) {
  if (!isLocalCoderRuntimeHealth(health)) return false;
  const instanceId = String(health?.instance_id || "").trim();
  if (instanceId) return instanceId === name;
  // Older Local Coder builds did not expose instance_id. Missing identity is
  // accepted only at call sites that separately prove ownership through the
  // persisted PID + live listener, solely so a legacy managed process can be
  // stopped/restarted once into the current identity-bearing runtime.
  return allowLegacy;
}

function isExactManagedRuntimeHealth(health, name, savedPid) {
  if (!Number.isSafeInteger(savedPid) || savedPid <= 0 || !isPidAlive(savedPid)) return false;
  if (!isManagedInstanceHealth(health, name)) return false;
  const healthPid = Number(health?.pid);
  return Number.isSafeInteger(healthPid) && healthPid === savedPid;
}

async function isExactCurrentServerProcess(pid) {
  if (!IS_WIN || !Number.isSafeInteger(pid) || pid <= 0 || !isPidAlive(pid)) return false;
  // Recovery is intentionally stronger than normal health classification. A
  // missing server.pid is writable authority, so only adopt a current repo child
  // whose Windows command line names this exact compiled entry point.
  return (await processesWithCmdLineAsync("node.exe", SERVER_ENTRY)).some((process) => process.pid === pid);
}

function isLocalCoderHealth(health, env, name = null, { allowLegacy = false } = {}) {
  if (!isLocalCoderRuntimeHealth(health)) return false;
  if (name && !isManagedInstanceHealth(health, name, { allowLegacy })) return false;
  const expected = expectedWorkspacePath(env);
  // WORKSPACE_PATH is mandatory project context. An absent desired workspace
  // must never make an arbitrary Local Coder health response look like a match.
  return Boolean(expected && samePath(expected, health.workspace));
}
async function tunnelClientHealthOnce(port) {
  try {
    const [liveness, readiness] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) }),
      fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1500) }),
    ]);
    if (!liveness.ok || !readiness.ok) {
      await liveness.body?.cancel().catch(() => undefined);
      await readiness.body?.cancel().catch(() => undefined);
      return false;
    }
    const [liveText, readyText] = await Promise.all([
      readResponseTextBounded(liveness, 4096, "tunnel liveness response"),
      readResponseTextBounded(readiness, 4096, "tunnel readiness response"),
    ]);
    return liveText.trim().toLowerCase() === "live" && readyText.trim().toLowerCase() === "ready";
  } catch { return false; }
}

async function tunnelClientHealth(port) {
  // The health listener is local and normally answers immediately, but a single
  // probe can transiently time out while Windows/Node is under cold-start load.
  // Do not turn one observation miss into healthDrift for an otherwise exact
  // managed tunnel. Keep the retry bounded and keep the body contract strict:
  // every accepted result still requires healthz="live" + readyz="ready".
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await tunnelClientHealthOnce(port)) return true;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* install / server / tunnel control                                   */
/* ------------------------------------------------------------------ */

function enqueueRuntimeDeploy(operation) {
  const execute = async () => {
    runtimeDeployInProgress += 1;
    try {
      return await operation();
    } finally {
      runtimeDeployInProgress -= 1;
    }
  };
  const run = runtimeDeployChain.then(execute, execute);
  runtimeDeployChain = run.then(() => undefined, () => undefined);
  return run;
}

function runNpmStep(args) {
  return new Promise((resolve) => {
    const child = IS_WIN
      ? spawn("cmd.exe", ["/c", "npm.cmd", ...args], { cwd: ROOT, windowsHide: true })
      : spawn(NPM_CMD, args, { cwd: ROOT, windowsHide: true });
    let settled = false;
    let timeoutCommitted = false;
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
    child.on("error", (err) => {
      if (timeoutCommitted) return;
      finish({ code: -1, out: appendBoundedTail(out, `\nspawn lỗi: ${err.message}`, INSTALL_OUTPUT_MAX_CHARS) });
    });
    child.on("close", (code) => {
      if (timeoutCommitted) return;
      finish({ code, out });
    });
    timer = setTimeout(() => {
      timeoutCommitted = true;
      void (async () => {
        out = appendBoundedTail(out, `\n[timeout after ${INSTALL_TIMEOUT_MS}ms]`, INSTALL_OUTPUT_MAX_CHARS);
        if (child.pid) await killPidTree(child.pid);
        finish({ code: 124, out });
      })();
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();
  });
}

async function readRuntimeDependencyStamp() {
  try {
    return (await fsp.readFile(RUNTIME_DEPENDENCY_STAMP, "utf8")).trim();
  } catch (err) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Bring shared dist/ to one stable source generation without touching any live
 * Gateway process. Dependency install is conditional; compile output is accepted
 * only when the source fingerprint is unchanged across the build.
 */
async function ensureRuntimeBuiltUnlocked({ forceBuild = false, forceInstall = false } = {}) {
  await ensureStateDirs();
  const log = [];
  let dependenciesInstalled = false;
  let built = false;

  for (let attempt = 1; attempt <= RUNTIME_BUILD_MAX_ATTEMPTS; attempt += 1) {
    const dependencyBefore = await runtimeDependencyFingerprint();
    const dependencyStamp = await readRuntimeDependencyStamp();
    let installNeeded =
      (forceInstall && attempt === 1) ||
      !fs.existsSync(path.join(ROOT, "node_modules")) ||
      dependencyStamp !== dependencyBefore.fingerprint;

    // MANAGER_STATE_DIR is intentionally overrideable for recovery/tests, while
    // node_modules belongs to the shared repository generation. A fresh Manager
    // state therefore has no dependency stamp even when the exact local tree is
    // already usable. Do not turn that missing bookkeeping receipt into an
    // unnecessary registry/network dependency: prove the installed tree locally
    // once, then bootstrap the stamp. A *mismatched existing* stamp still forces
    // npm install because package/lock authority changed after a previously
    // recorded generation.
    if (
      installNeeded
      && !forceInstall
      && !dependencyStamp
      && fs.existsSync(path.join(ROOT, "node_modules"))
    ) {
      const localDependencies = await runNpmStep(["ls", "--all", "--json"]);
      log.push({
        step: "npm ls --all --json (local dependency bootstrap proof)",
        code: localDependencies.code,
        output: localDependencies.out,
      });
      if (localDependencies.code === 0) {
        await atomicWriteFile(RUNTIME_DEPENDENCY_STAMP, dependencyBefore.fingerprint, "utf8");
        installNeeded = false;
      }
    }

    if (installNeeded) {
      const install = await runNpmStep(["install"]);
      log.push({ step: "npm install", code: install.code, output: install.out });
      if (install.code !== 0) {
        return { ok: false, built, dependenciesInstalled, steps: log, error: "npm install failed; live Gateway processes were left untouched." };
      }
      dependenciesInstalled = true;
      const dependencyAfter = await runtimeDependencyFingerprint();
      await atomicWriteFile(RUNTIME_DEPENDENCY_STAMP, dependencyAfter.fingerprint, "utf8");
    }

    clearRuntimeBuildCache();
    const buildState = await runtimeBuildStatus(true);
    const buildNeeded = forceBuild || dependenciesInstalled || !fs.existsSync(SERVER_ENTRY) || buildState.sourceNewerThanBuild;
    if (!buildNeeded) {
      const stable = await runtimeSourceFingerprint();
      return {
        ok: true,
        built,
        dependenciesInstalled,
        sourceFingerprint: stable.fingerprint,
        sourceFileCount: stable.fileCount,
        buildState,
        steps: log,
      };
    }

    const sourceBefore = await runtimeSourceFingerprint();
    const build = await runNpmStep(["run", "build"]);
    log.push({ step: `npm run build (attempt ${attempt}/${RUNTIME_BUILD_MAX_ATTEMPTS})`, code: build.code, output: build.out });
    if (build.code !== 0) {
      clearRuntimeBuildCache();
      return { ok: false, built, dependenciesInstalled, steps: log, error: "Runtime build failed; live Gateway processes were left untouched." };
    }

    clearRuntimeBuildCache();
    const sourceAfter = await runtimeSourceFingerprint();
    const verifiedBuild = await runtimeBuildStatus(true);
    const stableBuild =
      sourceBefore.fingerprint === sourceAfter.fingerprint &&
      fs.existsSync(SERVER_ENTRY) &&
      !verifiedBuild.sourceNewerThanBuild;
    if (stableBuild) {
      built = true;
      return {
        ok: true,
        built: true,
        dependenciesInstalled,
        sourceFingerprint: sourceAfter.fingerprint,
        sourceFileCount: sourceAfter.fileCount,
        buildState: verifiedBuild,
        steps: log,
      };
    }

    log.push({
      step: `source stability verification (attempt ${attempt}/${RUNTIME_BUILD_MAX_ATTEMPTS})`,
      code: 75,
      output: "Source changed while the build was running; discarding this generation for deployment and retrying before any Gateway process is stopped.",
    });
    forceBuild = true;
  }

  return {
    ok: false,
    built,
    dependenciesInstalled,
    steps: log,
    error: `Runtime source did not remain stable across ${RUNTIME_BUILD_MAX_ATTEMPTS} build attempts; live Gateway processes were left untouched.`,
  };
}

async function runInstall() {
  if (installInProgress) return { ok: false, steps: [], output: "Install đang chạy rồi." };
  installInProgress = true;
  try {
    const transaction = await enqueueRuntimeDeploy(async () => {
      const names = await listInstances();
      const running = [];
      for (const instanceName of names) {
        const state = await serverStatus(instanceName);
        if (state.running) running.push({ name: instanceName, state });
      }
      const unowned = running.find(({ state }) => !state.owned);
      if (unowned) {
        return {
          runtimeBuild: {
            ok: false,
            built: false,
            dependenciesInstalled: false,
            steps: [],
            error: `Install/Build refused before changing shared dist: running Gateway '${unowned.name}' is not owned by Manager, so safe generation authority cannot be proven while that process is serving.`,
          },
          rollout: null,
        };
      }

      const runtimeBuild = await ensureRuntimeBuiltUnlocked({ forceBuild: true, forceInstall: true });
      if (!runtimeBuild.ok || running.length === 0) return { runtimeBuild, rollout: null };

      // Building shared dist must never implicitly interrupt a healthy connector.
      // Existing Node processes keep their already-loaded generation and expose
      // artifactDrift until the user explicitly restarts each Gateway. This makes
      // Install/Build non-disruptive and prevents a source update from creating a
      // surprise connector 502 window across unrelated instances.
      const rollout = {
        ok: true,
        restarted: false,
        rollingRestarted: [],
        maintenanceRequired: true,
        deferredRestartNames: running.map(({ name: instanceName }) => instanceName),
      };
      return { runtimeBuild, rollout };
    });

    const runtimeBuild = transaction.runtimeBuild;
    const rollout = transaction.rollout;
    const log = [...(runtimeBuild.steps || [])];
    if (rollout) {
      log.push({
        step: "Gateway restart requirement",
        code: rollout.ok ? 0 : 1,
        output: rollout.ok
          ? `Build is ready; running Gateway processes were preserved to avoid connector interruption. Restart explicitly when ready: ${(rollout.deferredRestartNames || []).join(", ") || "none"}`
          : (rollout.error || "Gateway restart requirement could not be determined."),
      });
    }
    if (runtimeBuild.ok && (!rollout || rollout.ok) && IS_WIN) {
      const runtime = await ensureTunnelClient();
      log.push({
        step: "OpenAI Tunnel patched runtime",
        code: runtime.ok ? 0 : 1,
        output: runtime.ok
          ? `Verified required patched runtime: ${runtime.path}${runtime.rebuilt ? " (rebuilt)" : ""}`
          : runtime.error,
      });
    }
    const ok = runtimeBuild.ok && (!rollout || rollout.ok) && log.every((entry) => entry.code === 0);
    return {
      ok,
      built: runtimeBuild.built === true,
      dependenciesInstalled: runtimeBuild.dependenciesInstalled === true,
      rollingRestarted: rollout?.rollingRestarted || [],
      steps: log.map((entry) => ({ step: entry.step, code: entry.code })),
      output: log.map((entry) => entry.output || "").join("\n").slice(-6000),
      error: ok ? undefined : (rollout?.error || runtimeBuild.error),
    };
  } finally {
    installInProgress = false;
  }
}

function sandboxSetupEnv(name, env, inst) {
  // The compatibility helper only needs OS execution context plus the strict
  // workspace/toolchain inputs. Never pass instance tunnel/admin secrets into a
  // child that may later launch an elevated PowerShell process.
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (isSecretKey(key)) delete childEnv[key];
  }
  const stateDir = managedRuntimeStatePath(
    env.CLC_SANDBOX_STATE_DIR,
    path.join(ROOT, ".mcp-state"),
    path.join(inst.dir, "shell-state")
  );
  childEnv.WORKSPACE_PATH = String(env.WORKSPACE_PATH || "");
  childEnv.EXTRA_WORKSPACE_PATHS = String(env.EXTRA_WORKSPACE_PATHS || "");
  childEnv.SANDBOX_EXEC_ROOTS = String(env.SANDBOX_EXEC_ROOTS || "");
  childEnv.MCP_INSTANCE_NAME = name;
  childEnv.LOCAL_CODER_INSTANCE_ID = name;
  childEnv.CLC_SANDBOX_STATE_DIR = stateDir;
  childEnv.MCP_SHELL_STATE_DIR = stateDir;
  if (String(env.CLC_SANDBOX_PROFILE_NAME || "").trim()) {
    childEnv.CLC_SANDBOX_PROFILE_NAME = String(env.CLC_SANDBOX_PROFILE_NAME).trim();
  } else {
    delete childEnv.CLC_SANDBOX_PROFILE_NAME;
  }
  return childEnv;
}

function runSandboxSetupProcess(name, env, inst, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SANDBOX_SETUP_SCRIPT, ...args], {
      cwd: ROOT,
      env: sandboxSetupEnv(name, env, inst),
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let timeoutCommitted = false;
    let output = "";
    let timer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, output });
    };
    child.stdout.on("data", (chunk) => {
      output = appendBoundedTail(output, chunk, INSTALL_OUTPUT_MAX_CHARS);
    });
    child.stderr.on("data", (chunk) => {
      output = appendBoundedTail(output, chunk, INSTALL_OUTPUT_MAX_CHARS);
    });
    child.on("error", (err) => {
      if (timeoutCommitted) return;
      output = appendBoundedTail(output, `\nspawn error: ${err.message}`, INSTALL_OUTPUT_MAX_CHARS);
      finish(-1);
    });
    child.on("close", (code) => {
      if (timeoutCommitted) return;
      finish(Number.isInteger(code) ? code : -1);
    });
    timer = setTimeout(() => {
      timeoutCommitted = true;
      void (async () => {
        output = appendBoundedTail(output, `\n[timeout after ${timeoutMs}ms]`, INSTALL_OUTPUT_MAX_CHARS);
        if (child.pid) await killPidTree(child.pid);
        finish(124);
      })();
    }, timeoutMs);
    timer.unref?.();
  });
}

function enqueueSandboxCompatibility(operation) {
  const run = sandboxCompatibilityChain.then(operation, operation);
  sandboxCompatibilityChain = run.then(() => undefined, () => undefined);
  return run;
}

async function checkSandboxCompatibilityUnlocked(name, env, inst) {
  if (!IS_WIN || String(env.FULL_DISK_ACCESS || "false").trim().toLowerCase() === "true") {
    return { ok: true, skipped: true, prepared: true };
  }
  const check = await runSandboxSetupProcess(
    name,
    env,
    inst,
    ["--check"],
    SANDBOX_COMPAT_CHECK_TIMEOUT_MS
  );
  if (check.code === 0) return { ok: true, prepared: true, setupRan: false };
  if (check.code === 3) {
    return {
      ok: false,
      prepared: false,
      requiresSetup: true,
      error:
        `AppContainer compatibility cho '${name}' chưa được chuẩn bị cho desired workspace/toolchain authority. ` +
        "Refusing to stop an already-serving Gateway before this prerequisite is ready; stop the Gateway first and Start again (which may request UAC), or run the sandbox setup explicitly.",
      output: check.output.trim().slice(-1200),
    };
  }
  return {
    ok: false,
    prepared: false,
    error: `Không kiểm tra được AppContainer compatibility cho '${name}': ${check.output.trim().slice(-1200) || `exit ${check.code}`}`,
  };
}

function checkSandboxCompatibility(name, env, inst) {
  return enqueueSandboxCompatibility(() => checkSandboxCompatibilityUnlocked(name, env, inst));
}

async function ensureSandboxCompatibility(name, env, inst) {
  if (!IS_WIN || String(env.FULL_DISK_ACCESS || "false").trim().toLowerCase() === "true") {
    return { ok: true, skipped: true };
  }
  return enqueueSandboxCompatibility(async () => {
    const check = await checkSandboxCompatibilityUnlocked(name, env, inst);
    if (check.ok) return check;
    if (!check.requiresSetup) return check;

    console.log(`[Security] ${name}: AppContainer compatibility chưa có hoặc đã stale — yêu cầu UAC một lần.`);
    const setup = await runSandboxSetupProcess(
      name,
      env,
      inst,
      [],
      SANDBOX_COMPAT_SETUP_TIMEOUT_MS
    );
    if (setup.code !== 0) {
      return {
        ok: false,
        error:
          `AppContainer compatibility setup cho '${name}' thất bại hoặc UAC bị hủy. ` +
          `${setup.output.trim().slice(-1200) || `exit ${setup.code}`}`,
      };
    }
    const verify = await runSandboxSetupProcess(
      name,
      env,
      inst,
      ["--check"],
      SANDBOX_COMPAT_CHECK_TIMEOUT_MS
    );
    if (verify.code !== 0) {
      return {
        ok: false,
        error: `AppContainer compatibility setup cho '${name}' không qua verify: ${verify.output.trim().slice(-1200) || `exit ${verify.code}`}`,
      };
    }
    return { ok: true, prepared: true, setupRan: true };
  });
}

async function serverStatus(name, desiredEnv = null) {
  const env = desiredEnv || (await readInstanceEnv(name));
  const inst = instPaths(name);
  const [buildState, launchEvidence] = await Promise.all([
    runtimeBuildStatus(),
    readServerLaunchEvidence(name),
  ]);
  const configuredPort = Number(env.PORT || 0);
  const configuredPortValid = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536;
  let savedPid = await readPidFile(inst.serverPid);

  let portOpen = false;
  let health = null;
  let portPid = null;
  if (configuredPortValid) {
    portOpen = await isPortOpen(configuredPort);
    portPid = portOpen ? await pidOnPort(configuredPort) : null;
    // Do not gate the authoritative HTTP identity probe behind a separate TCP
    // connect snapshot. On Windows the socket/netstat view can briefly report
    // closed/stale immediately after restart even though /health is already
    // serving. A successful health response itself proves the configured port is
    // open and lets current builds prove exact instance + PID ownership.
    health = await serverHealth(configuredPort);
    if (health) portOpen = true;
    if (portOpen && !portPid) portPid = await pidOnPort(configuredPort);
    if (!health && portOpen) {
      // A freshly restarted Local Coder Server can accept TCP a fraction before
      // /health is consistently ready under Windows load. This retry must also
      // work in the exact crash window where server.pid is missing/dead; gating
      // it on savedPid makes the recovery path self-defeating. Retry only the
      // identity probe — never infer ownership from an open socket alone.
      for (let attempt = 0; attempt < 3 && !health; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        health = await serverHealth(configuredPort);
      }
    }
    // netstat is cached for UI efficiency and Windows can briefly publish the
    // listener before the PID snapshot catches up. Current health carries its own
    // PID, so refresh toward health.pid rather than toward server.pid. The latter
    // can itself be a live-but-wrong stale ledger and must never become the target
    // of cache reconciliation.
    let currentHealthPid = Number(health?.pid);
    let currentHealthPidAlive = Boolean(
      Number.isSafeInteger(currentHealthPid) && currentHealthPid > 0 && isPidAlive(currentHealthPid)
    );
    if (
      portOpen &&
      currentHealthPidAlive &&
      isManagedInstanceHealth(health, name) &&
      portPid !== currentHealthPid
    ) {
      for (let attempt = 0; attempt < 3 && portPid !== currentHealthPid; attempt++) {
        invalidatePortPidCache();
        portPid = await pidOnPort(configuredPort);
        if (portPid === currentHealthPid) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    // Crash-window recovery: the managed child may have reached /health after
    // spawn while the Manager died before server.pid persistence completed.
    // Reconstruct the ledger only from mutually reinforcing current-build proof:
    // exact instance+workspace health, health PID, live listener PID and exact
    // CURRENT repo dist/index.js command-line identity. Never apply this bridge to
    // legacy health without instance_id, unsaved/proposed config, or a PID mismatch.
    const savedPidAlive = Boolean(savedPid && isPidAlive(savedPid));
    const savedPidDefinitelyDead = Boolean(savedPid && !savedPidAlive && (await isPidDefinitelyDead(savedPid)));
    if ((!savedPid || savedPidDefinitelyDead) && !desiredEnv && isLocalCoderHealth(health, env, name)) {
      const healthPid = currentHealthPid;
      if (Number.isSafeInteger(healthPid) && healthPid > 0 && isPidAlive(healthPid)) {
        for (let attempt = 0; attempt < 3 && portPid !== healthPid; attempt += 1) {
          invalidatePortPidCache();
          portPid = await pidOnPort(configuredPort);
          if (portPid === healthPid) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (portPid === healthPid && await isExactCurrentServerProcess(healthPid)) {
          await writePidFile(inst.serverPid, healthPid);
          savedPid = healthPid;
          currentHealthPid = healthPid;
          currentHealthPidAlive = true;
          console.warn(`[manager] ${name}: recovered missing server.pid from exact current runtime identity (PID ${healthPid}).`);
        }
      }
    }
    const currentManagedListener = Boolean(
      portOpen &&
      currentHealthPidAlive &&
      portPid === currentHealthPid &&
      isManagedInstanceHealth(health, name)
    );
    // Liveness and destructive ownership are deliberately different proofs.
    // A current identity-bearing /health response with a live health PID proves
    // that this Local Coder instance is serving on the configured localhost port,
    // even if the Windows listener-PID snapshot is briefly stale/unavailable.
    // That weaker proof is sufficient to avoid false `running:false`, but it must
    // NEVER grant `owned:true`; stop/restart authority still requires the exact
    // listener-PID proof below (or the bounded legacy bridge).
    const currentManagedHealth = Boolean(
      portOpen &&
      currentHealthPidAlive &&
      isManagedInstanceHealth(health, name)
    );
    const exactManagedRuntime = Boolean(
      currentManagedListener && isExactManagedRuntimeHealth(health, name, savedPid)
    );
    const legacyOwnedListener = Boolean(
      !String(health?.instance_id || "").trim() &&
      savedPid &&
      portPid === savedPid &&
      isPidAlive(savedPid)
    );
    if (portOpen && isLocalCoderHealth(health, env, name, { allowLegacy: legacyOwnedListener })) {
      const artifactDrift = isRuntimeArtifactStale(
        health?.instructions?.loaded_at,
        buildState.newestArtifactMtimeMs
      );
      return {
        running: true,
        port: configuredPort,
        configuredPort,
        pid: currentManagedListener ? currentHealthPid : (portPid || savedPid || null),
        health,
        portOccupied: false,
        invalidConfig: false,
        configDrift: false,
        artifactDrift,
        buildDrift: buildState.sourceNewerThanBuild,
        buildSourceMtimeMs: buildState.newestSourceMtimeMs,
        buildArtifactMtimeMs: buildState.newestArtifactMtimeMs,
        // Current runtimes prove ownership through exact saved-PID == health-PID
        // identity. Legacy runtimes without instance_id require the stricter
        // saved-PID listener proof. Missing netstat data alone is never ownership.
        owned: exactManagedRuntime || legacyOwnedListener,
      };
    }

    // Keep liveness separate from desired configuration. A changed/blank
    // WORKSPACE_PATH is configuration drift, not a stopped server. Current
    // identity-bearing health may keep the runtime visible during a transient
    // Windows listener-PID scan miss, while `owned` remains fail-closed until the
    // stronger listener proof is available.
    if (
      currentManagedHealth || legacyOwnedListener
    ) {
      const artifactDrift = isRuntimeArtifactStale(
        health?.instructions?.loaded_at,
        buildState.newestArtifactMtimeMs
      );
      return {
        running: true,
        port: configuredPort,
        configuredPort,
        pid: currentManagedListener ? currentHealthPid : savedPid,
        health,
        portOccupied: false,
        invalidConfig: false,
        configDrift: true,
        portDrift: false,
        workspaceDrift: true,
        artifactDrift,
        buildDrift: buildState.sourceNewerThanBuild,
        buildSourceMtimeMs: buildState.newestSourceMtimeMs,
        buildArtifactMtimeMs: buildState.newestArtifactMtimeMs,
        owned: exactManagedRuntime || legacyOwnedListener,
      };
    }
  }

  // A user can edit an instance .env outside the Manager. If PORT changes while
  // the managed child is still alive, following only the new configured port
  // loses the old process and can later start a duplicate workspace. Recover the
  // child strictly through its saved PID + listening port + managed instance
  // identity. Workspace may legitimately drift before restart; a mismatched
  // instance_id on current builds is never adopted as owned. Older builds that
  // predate instance_id remain recoverable once so the Manager can upgrade them.
  if (savedPid && isPidAlive(savedPid)) {
    let listenerPorts = [];
    // This path is entered specifically because desired PORT no longer proves
    // the live child. Never make *liveness* depend exclusively on Windows
    // netstat/listener enumeration: under process churn that snapshot can briefly
    // miss a healthy listener. Manager therefore persists the last port it
    // actually launched for this exact server.pid and probes that endpoint first.
    // Launch evidence is discovery-only; destructive ownership still requires the
    // live listener PID proof below.
    const launchEvidencePid = Number(launchEvidence.serverLaunchPid);
    const launchEvidencePort = Number(launchEvidence.serverLaunchPort);
    const launchEvidencePortValid = Boolean(
      launchEvidencePid === savedPid &&
      Number.isInteger(launchEvidencePort) && launchEvidencePort > 0 && launchEvidencePort < 65536
    );
    for (let attempt = 0; attempt < 3 && listenerPorts.length === 0; attempt++) {
      invalidatePortPidCache();
      listenerPorts = await portsForPid(savedPid);
      if (listenerPorts.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const actualPortCandidates = [
      ...(launchEvidencePortValid ? [launchEvidencePort] : []),
      ...listenerPorts,
    ].filter((candidate, index, all) => candidate !== configuredPort && all.indexOf(candidate) === index);

    for (const actualPort of actualPortCandidates) {
      const actualHealth = await serverHealth(actualPort);
      const exactCurrentIdentity = isExactManagedRuntimeHealth(actualHealth, name, savedPid);
      let actualPortPid = listenerPorts.includes(actualPort) ? savedPid : null;
      if (exactCurrentIdentity && actualPortPid !== savedPid) {
        for (let attempt = 0; attempt < 3 && actualPortPid !== savedPid; attempt += 1) {
          invalidatePortPidCache();
          actualPortPid = await pidOnPort(actualPort);
          if (actualPortPid === savedPid) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const legacyOwnedListener = Boolean(
        !String(actualHealth?.instance_id || "").trim() &&
        actualPortPid === savedPid &&
        isManagedInstanceHealth(actualHealth, name, { allowLegacy: true })
      );
      // Current identity-bearing health + exact health.pid may keep the runtime
      // visible even while listener enumeration is transiently missing. Legacy
      // runtimes have no such identity and remain listener-proof-only.
      if (!exactCurrentIdentity && !legacyOwnedListener) continue;
      const workspaceDrift = !isLocalCoderHealth(actualHealth, env, name, { allowLegacy: legacyOwnedListener });
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
        portOccupied: configuredPortValid && portOpen && !isLocalCoderHealth(health, env, name),
        invalidConfig: !configuredPortValid,
        configDrift: true,
        portDrift: true,
        workspaceDrift,
        artifactDrift,
        buildDrift: buildState.sourceNewerThanBuild,
        buildSourceMtimeMs: buildState.newestSourceMtimeMs,
        buildArtifactMtimeMs: buildState.newestArtifactMtimeMs,
        owned: actualPortPid === savedPid && (exactCurrentIdentity || legacyOwnedListener),
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
    portDrift: false,
    workspaceDrift: false,
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

// One public command order per instance across BOTH Gateway and Tunnel controls.
// Separate Server/Tunnel queues allow a Tunnel spawn/preflight to interleave with
// Server Stop after shared deploy releases its global lock. The shared queue makes
// request arrival order authoritative across the whole instance control plane;
// low-level lifecycle queues remain separate because rollout internals intentionally
// restart Gateway while keeping an already-established Tunnel transport alive.
const instanceCommandChains = new Map();
const instanceIntentState = new Map();
// Delete/Rename invalidate the catalog identity behind a name. A request that
// arrived after such a mutation was registered must not queue lifecycle/config
// work against the soon-to-be-stale name and later resurrect/recreate authority.
// Keep an explicit tombstone from synchronous command registration until the
// catalog mutation settles; later public mutations fail retryably instead.
const instanceCatalogMutationInFlight = new Map();
// HTTP bodies are parsed asynchronously. Without a separate admission-order gate,
// a later tiny request can reach beginInstanceIntent()/enqueueInstanceCommand()
// before an earlier request whose body/parser/callback yielded under load. Reserve
// only the *dispatch-registration* turn at socket admission time: once the prior
// request has synchronously registered its intent + command promise, release the
// next request immediately. Long lifecycle work still overlaps/coalesces normally.
const instanceRequestAdmissionChains = new Map();
const serverCommandChains = new Map();
const serverLifecycleChains = new Map();

function beginInstanceIntent(name, type) {
  const previous = instanceIntentState.get(name) || null;
  const current = {
    type,
    sequence: Number(previous?.sequence || 0) + 1,
  };
  instanceIntentState.set(name, current);
  return {
    ...current,
    previousType: previous?.type || null,
    consecutiveSameType: previous?.type === type,
  };
}

function enqueueInstanceCommand(name, operation) {
  const previous = instanceCommandChains.get(name) || Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.then(() => undefined, () => undefined);
  instanceCommandChains.set(name, settled);
  settled.finally(() => {
    if (instanceCommandChains.get(name) === settled) instanceCommandChains.delete(name);
  });
  return run;
}

function reserveInstanceRequestAdmission(name) {
  const previous = instanceRequestAdmissionChains.get(name) || Promise.resolve();
  let releaseCurrent;
  let released = false;
  const current = new Promise((resolve) => { releaseCurrent = resolve; });
  // The chain never rejects: it represents only admission ordering, not command
  // success. A failed earlier mutation must still hand the next admitted request
  // its registration turn.
  const chain = previous.then(() => current, () => current);
  instanceRequestAdmissionChains.set(name, chain);
  chain.finally(() => {
    if (instanceRequestAdmissionChains.get(name) === chain) instanceRequestAdmissionChains.delete(name);
  });

  const release = () => {
    if (released) return;
    released = true;
    releaseCurrent();
  };

  return {
    name,
    release,
    async dispatch(operation) {
      await previous.catch(() => undefined);
      try {
        // Invoking an async command runs its synchronous prefix immediately. All
        // public mutation wrappers register beginInstanceIntent + queue/coalescing
        // state before their first await, so the next admitted request can be
        // released now instead of waiting for this long lifecycle to finish.
        return operation();
      } finally {
        release();
      }
    },
  };
}

function catalogMutationConflict(name) {
  const pending = instanceCatalogMutationInFlight.get(name);
  if (!pending) return null;
  return {
    ok: false,
    retryable: true,
    staleInstanceAuthority: true,
    error: `Instance '${name}' catalog authority is changing (${pending.type}); retry against the current catalog after that mutation settles.`,
  };
}

const DIRECT_INSTANCE_ADMISSION_MUTATIONS = new Set([
  "DELETE:",
  "POST:/rename",
  "PUT:/env",
  "PUT:/config",
  "POST:/server/start",
  "POST:/server/stop",
  "POST:/server/restart",
  "POST:/tunnel/start",
  "POST:/tunnel/stop",
  "POST:/tunnel/restart",
]);

const LEGACY_DEFAULT_ADMISSION_MUTATIONS = new Set([
  "PUT:/api/env",
  "PUT:/api/config",
  "POST:/api/server/start",
  "POST:/api/server/stop",
  "POST:/api/server/restart",
  "POST:/api/tunnel/start",
  "POST:/api/tunnel/stop",
  "POST:/api/tunnel/restart",
]);

function reserveDirectInstanceMutationAdmission(req, url) {
  const match = /^\/api\/instances\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) return null;
  let name;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!INSTANCE_NAME_RE.test(name)) return null;
  const sub = match[2] || "";
  if (!DIRECT_INSTANCE_ADMISSION_MUTATIONS.has(`${req.method}:${sub}`)) return null;
  return reserveInstanceRequestAdmission(name);
}

function reserveLegacyDefaultMutationAdmission(req, url) {
  if (!LEGACY_DEFAULT_ADMISSION_MUTATIONS.has(`${req.method}:${url.pathname}`)) return null;
  // Legacy aliases must freeze their target before readBody() just like direct
  // multi-instance routes. Re-resolving "default" after an earlier Rename/Delete
  // could silently retarget the request to a different workspace.
  const name = defaultInstanceNameForAdmission();
  if (!name) return null;
  return { ...reserveInstanceRequestAdmission(name), legacyDefault: true };
}

function enqueueServerCommand(name, operation) {
  const run = enqueueInstanceCommand(name, operation);
  const settled = run.then(() => undefined, () => undefined);
  serverCommandChains.set(name, settled);
  settled.finally(() => {
    if (serverCommandChains.get(name) === settled) serverCommandChains.delete(name);
  });
  return run;
}

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

async function serverStartPortCheck(port, label, currentServer = null) {
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    return { ok: false, error: `${label} is invalid; fix configuration before starting Local Coder.` };
  }
  if (port === managerPortNum) {
    return { ok: false, error: `${label} ${port} conflicts with MANAGER_PORT; refusing to start Local Coder.` };
  }

  if (!(await isPortOpen(port))) return { ok: true, occupied: false, pid: null };

  // netstat/PID snapshots can lag a just-started listener. Refresh toward an
  // exact currently-owned serving PID before deciding that the desired listener
  // is foreign. Unknown ownership always fails closed.
  const allowedPid = currentServer?.running && currentServer?.owned && Number.isSafeInteger(Number(currentServer.pid))
    ? Number(currentServer.pid)
    : null;
  let ownerPid = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    invalidatePortPidCache();
    ownerPid = await pidOnPort(port);
    if (ownerPid || !allowedPid) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (allowedPid && ownerPid === allowedPid) {
    return { ok: true, occupied: true, ownedByCurrent: true, pid: ownerPid };
  }
  return {
    ok: false,
    occupied: true,
    pid: ownerPid || null,
    error: `${label} ${port} is occupied by another or unproven process${ownerPid ? ` (PID ${ownerPid})` : ""}; refusing to replace the serving Gateway.`,
  };
}

/**
 * Validate every predictable prerequisite for the desired Gateway generation
 * without stopping the currently-serving process. This function intentionally
 * does not migrate runtime state, modify AppContainer ACLs, rotate logs or write
 * lifecycle ledgers. Those mutations remain after the destructive boundary.
 */
async function preflightServerStartUnlocked(name, { currentServer = null, requirePreparedSandbox = false } = {}) {
  if (!fs.existsSync(SERVER_ENTRY)) {
    return { ok: false, error: "dist/index.js chưa tồn tại — bấm 'Cài Đặt' trước." };
  }
  const buildState = await runtimeBuildStatus(true);
  if (buildState.sourceNewerThanBuild) {
    return {
      ok: false,
      error: "Runtime source changed after build/deploy preflight; no Gateway was stopped or started. Retry the lifecycle action.",
      buildDrift: true,
    };
  }

  const env = await readInstanceEnv(name);
  const inst = instPaths(name);
  const policy = validateSessionPolicy(env);
  if (!policy.ok) {
    return { ok: false, error: `Session policy không hợp lệ — sửa trong Cấu hình: ${policy.errors.join("; ")}` };
  }
  const workspaceScope = await validateManagedWorkspaceScope(env);
  if (!workspaceScope.ok) {
    return {
      ok: false,
      workspaceMissing: workspaceScope.workspaceMissing === true,
      error: workspaceScope.error,
    };
  }
  const runtimeLimits = validateRuntimeLimits(env);
  if (!runtimeLimits.ok) {
    return { ok: false, error: `Runtime limits không hợp lệ — sửa trong Cấu hình: ${runtimeLimits.errors.join("; ")}` };
  }

  const port = Number(env.PORT || 0);
  const adminPort = Number(env.ADMIN_PORT || 0);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    return { ok: false, error: "PORT is invalid; fix configuration before starting Local Coder." };
  }
  if (!Number.isInteger(adminPort) || adminPort <= 0 || adminPort >= 65536) {
    return { ok: false, error: "ADMIN_PORT is invalid; fix configuration before starting Local Coder." };
  }
  if (port === adminPort) {
    return { ok: false, error: "PORT and ADMIN_PORT must differ before starting Local Coder." };
  }
  const catalogPorts = await allUsedPorts(name);
  catalogPorts.add(managerPortNum);
  if (catalogPorts.has(port)) {
    return { ok: false, error: `PORT ${port} conflicts with another managed instance or MANAGER_PORT.` };
  }
  if (catalogPorts.has(adminPort)) {
    return { ok: false, error: `ADMIN_PORT ${adminPort} conflicts with another managed instance or MANAGER_PORT.` };
  }
  const portCheck = await serverStartPortCheck(port, "PORT", currentServer);
  if (!portCheck.ok) return portCheck;
  const adminPortCheck = await serverStartPortCheck(adminPort, "ADMIN_PORT", currentServer);
  if (!adminPortCheck.ok) return adminPortCheck;

  let sandboxCompatibility = { ok: true, skipped: true, prepared: true };
  if (requirePreparedSandbox) {
    sandboxCompatibility = await checkSandboxCompatibility(name, env, inst);
    if (!sandboxCompatibility.ok) {
      return {
        ok: false,
        sandboxCompatibility: false,
        requiresSandboxSetup: sandboxCompatibility.requiresSetup === true,
        error: sandboxCompatibility.error,
      };
    }
  }

  return {
    ok: true,
    env,
    inst,
    port,
    adminPort,
    policy,
    workspaceScope,
    runtimeLimits,
    sandboxCompatibility,
  };
}

async function startServerUnlocked(name) {
  const st = await serverStatus(name);
  if (st.running && st.configDrift) {
    const driftDetail = st.portDrift
      ? `PORT ${st.port} is still live while .env configures PORT ${st.configuredPort || "invalid"}`
      : st.workspaceDrift
        ? `the running process still uses workspace ${st.health?.workspace || "(unknown)"} while .env configures ${expectedWorkspacePath(await readInstanceEnv(name)) || "(none)"}`
        : "the running process does not match the saved configuration";
    return {
      ok: false,
      error: `Managed server PID ${st.pid} has configuration drift: ${driftDetail}. Restart the managed server before starting with the saved configuration.`,
      ...st,
    };
  }
  if (st.running && !st.owned) {
    return {
      ok: false,
      error: `A Local Coder runtime is already serving PORT ${st.port} but exact managed PID ownership could not be proven; refusing false-green start/adoption.`,
      ...st,
    };
  }
  if (st.running) return { ok: true, alreadyRunning: true, ...st };
  if (st.invalidConfig) return { ok: false, error: "PORT is invalid; fix configuration before starting Local Coder." };
  if (st.portOccupied) return { ok: false, error: `PORT ${st.port} is occupied by another process${st.pid ? ` (PID ${st.pid})` : ""}; refusing to start Local Coder.` };
  // Persist managed-runtime defaults for instances created before these keys
  // existed (e.g. "default"), including an instance-local audit path, instead
  // of silently relying on process-level fallbacks.
  await ensureManagedRuntimeDefaults(name);
  const preflight = await preflightServerStartUnlocked(name);
  if (!preflight.ok) return preflight;
  const { env, inst, port } = preflight;
  await migrateLegacyRuntimeState(name, env, inst);
  const sandboxCompatibility = await ensureSandboxCompatibility(name, env, inst);
  if (!sandboxCompatibility.ok) {
    return { ok: false, error: sandboxCompatibility.error, sandboxCompatibility: false };
  }
  // serverStatus above established that this managed server is stopped, so no
  // child owns these process logs. Scrub historical generations before append /
  // rotation so old credentials do not remain at rest indefinitely.
  for (const file of [inst.serverLog, `${inst.serverLog}.1`, `${inst.serverLog}.2`]) {
    await scrubLogFile(file);
  }
  await rotateLogFile(inst.serverLog);
  const startupTimeoutMs = String(env.FULL_DISK_ACCESS || "false").trim().toLowerCase() === "true"
    ? SERVER_START_TIMEOUT_TRUSTED_MS
    : SERVER_START_TIMEOUT_STRICT_MS;
  const startupAttemptId = randomUUID().slice(0, 12);
  const startupStartedAt = Date.now();
  const startupLogMarker = `[manager-start] attempt=${startupAttemptId}`;
  await fsp.appendFile(
    inst.serverLog,
    `\n${startupLogMarker} instance=${name} started_at=${new Date(startupStartedAt).toISOString()} timeout_ms=${startupTimeoutMs}\n`,
    "utf8"
  );
  const pid = spawnDetached(process.execPath, [SERVER_ENTRY], inst.serverLog, {
    ...env,
    // Manager-owned identity/state injected after user env so .env cannot spoof runtime identity.
    MCP_ENV_FILE: inst.env,
    MCP_INSTANCE_NAME: name,
    LOCAL_CODER_INSTANCE_ID: name,
    CHECKPOINT_PATH: managedRuntimeStatePath(env.CHECKPOINT_PATH, path.join(ROOT, ".mcp-checkpoints"), path.join(inst.dir, "checkpoints")),
    MCP_SHELL_STATE_DIR: managedRuntimeStatePath(env.MCP_SHELL_STATE_DIR, path.join(ROOT, ".mcp-state"), path.join(inst.dir, "shell-state")),
    // AppContainer policy manifests historically lived in the same repo-local
    // .mcp-state directory as persistent shell state. Keep that authority state
    // bound to the managed instance as well, otherwise migration can move the
    // manifest away while the next runtime silently recreates a fresh .mcp-state
    // and loses the previous ACL roots that must be revoked during reconciliation.
    CLC_SANDBOX_STATE_DIR: managedRuntimeStatePath(env.CLC_SANDBOX_STATE_DIR, path.join(ROOT, ".mcp-state"), path.join(inst.dir, "shell-state")),
  });
  invalidatePortPidCache();
  await writePidFile(inst.serverPid, pid);
  // Persist discovery-only launch evidence as soon as server.pid exists. If the
  // desired PORT is edited out-of-band later, status can still probe the serving
  // generation directly instead of depending on a transient netstat snapshot.
  // This evidence NEVER authorizes stop/restart by itself.
  await tryUpdateServerLaunchEvidence(name, (config) => {
    config.serverLaunchPid = pid;
    config.serverLaunchPort = port;
  });
  let startupState = "pending";
  await waitFor(async () => {
    if (!isPidAlive(pid)) {
      startupState = "exited";
      return true;
    }
    if (isLocalCoderHealth(await serverHealth(port), env, name)) {
      startupState = "healthy";
      return true;
    }
    return false;
  }, startupTimeoutMs);
  // One exact final probe closes the waitFor deadline race: the runtime may have
  // become healthy between the last polling iteration and timeout expiry. Never
  // kill a process that can prove the expected instance/workspace identity now.
  let finalHealth = null;
  if (startupState !== "healthy" && isPidAlive(pid)) {
    finalHealth = await serverHealth(port);
    if (isLocalCoderHealth(finalHealth, env, name)) startupState = "healthy";
  }
  const up = startupState === "healthy";
  if (!up) {
    const startupElapsedMs = Date.now() - startupStartedAt;
    const pidAliveAtDeadline = isPidAlive(pid);
    const portOpenAtDeadline = await isPortOpen(port);
    await killPidTree(pid);
    invalidatePortPidCache();
    const stopped = await waitFor(() => !isPidAlive(pid), 5000, 150);
    if (stopped) {
      await writePidFile(inst.serverPid, null);
      await tryUpdateServerLaunchEvidence(name, clearServerLaunchEvidence);
    }
    const tail = await tailFile(inst.serverLog);
    const markerOffset = tail.lastIndexOf(startupLogMarker);
    const attemptTail = markerOffset >= 0 ? tail.slice(markerOffset) : tail;
    const diagnostic = `attempt=${startupAttemptId} state=${startupState} elapsed_ms=${startupElapsedMs} timeout_ms=${startupTimeoutMs} pid_alive=${pidAliveAtDeadline} port_open=${portOpenAtDeadline}`;
    return {
      ok: false,
      error: `Server không đạt health-ready (${diagnostic}).` + (stopped ? "" : ` PID ${pid} vẫn còn sống; giữ server.pid để có thể stop/recover an toàn.`) + " Log của attempt:\n" + attemptTail.slice(-1500),
      pid: stopped ? null : pid,
      cleanupFailed: !stopped,
      startupState,
      startupAttemptId,
      startupTimeoutMs,
      startupElapsedMs,
      pidAliveAtDeadline,
      portOpenAtDeadline,
    };
  }
  await warmUpMcp(port); // làm ấm trước khi tunnel probe (timeout 2s)
  return { ok: true, running: true, port, pid, health: finalHealth || await serverHealth(port) };
}

async function stopServerUnlocked(name, { allowLegacyPreDrainMaintenance = false } = {}) {
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

  // Close MCP POST/DELETE admission before crossing any destructive boundary,
  // then wait for requests accepted before the gate to settle. This is stronger
  // than a health-based quiet check: once admission is closed no new tool call
  // can enter between the final activeRequests=0 observation and process stop.
  let trafficDrain = await drainServerTrafficForDisruption(name, st);
  if (!trafficDrain.ok && allowLegacyPreDrainMaintenance) {
    const legacyMaintenance = await waitForExplicitLegacyPreDrainMaintenance(name, st, trafficDrain);
    if (legacyMaintenance.ok) trafficDrain = legacyMaintenance;
  }
  if (!trafficDrain.ok) {
    return {
      ...trafficDrain,
      ok: false,
      stopped: false,
      port: st.port,
      pid: st.pid || null,
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
      // overlap two Local Coder Server generations while the old PID is still cleaning up.
      // The current runtime bounds HTTP drain to 4s; allow 6s for compatibility,
      // then fall through to the verified hard-stop path for older/wedged builds.
      const graceful = await waitFor(
        async () => !isPidAlive(st.pid) && !(await isPortOpen(st.port)),
        6000,
        150
      );
      if (graceful) {
        await writePidFile(inst.serverPid, null);
        await tryUpdateServerLaunchEvidence(name, clearServerLaunchEvidence);
        return { ok: true, port: st.port, stopped: true, graceful: true, processExited: true, trafficDrain };
      }
    }
  } catch {
    // Old builds / wedged admin listener fall through to the hard-stop path.
  }

  let killed = false;
  if (pidFile === st.pid) killed = await killPidTree(pidFile);
  invalidatePortPidCache();
  const stopped = await waitFor(
    async () => !isPidAlive(st.pid) && !(await isPortOpen(st.port)),
    5000,
    150
  );
  if (!stopped) {
    const current = await serverStatus(name);
    const admissionResume = trafficDrain.admissionClosed
      ? await resumeServerTrafficAdmission(name, st)
      : { ok: true, skipped: true, reason: "legacy-quiet-bridge" };
    return {
      ok: false,
      error: `Server did not release PORT ${st.port} after stop request${current.pid ? ` (PID ${current.pid})` : ""}.`,
      port: st.port,
      pid: current.pid || st.pid || null,
      stopped: false,
      graceful: false,
      forced: killed,
      trafficDrain,
      admissionResume,
    };
  }
  await writePidFile(inst.serverPid, null);
  await tryUpdateServerLaunchEvidence(name, clearServerLaunchEvidence);
  return { ok: true, port: st.port, stopped: true, graceful: false, forced: killed, processExited: true, trafficDrain };
}

async function restartServerUnlockedCurrent(name, { allowLegacyPreDrainMaintenance = false } = {}) {
  const before = await serverStatus(name);
  if (before.running && !before.owned) {
    return {
      ok: false,
      restarted: false,
      preserved: true,
      previousPid: before.pid || null,
      error: `Refusing Gateway restart: the currently-serving process on PORT ${before.port} is not exactly owned by Manager.`,
    };
  }
  const preflight = await preflightServerStartUnlocked(name, {
    currentServer: before,
    requirePreparedSandbox: before.running === true,
  });
  if (!preflight.ok) {
    return {
      ...preflight,
      ok: false,
      restarted: false,
      preserved: before.running === true,
      previousPid: before.pid || null,
    };
  }
  const stopped = await stopServerUnlocked(name, { allowLegacyPreDrainMaintenance });
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
    trafficDrain: stopped.trafficDrain || null,
    legacyPreDrainMaintenance: stopped.trafficDrain?.legacyPreDrainMaintenance === true,
  };
}

async function runtimeGenerationStatus(expectedFingerprint) {
  clearRuntimeBuildCache();
  const [source, buildState] = await Promise.all([
    runtimeSourceFingerprint(),
    runtimeBuildStatus(true),
  ]);
  return {
    ok: Boolean(
      expectedFingerprint
      && source.fingerprint === expectedFingerprint
      && fs.existsSync(SERVER_ENTRY)
      && !buildState.sourceNewerThanBuild
    ),
    sourceFingerprint: source.fingerprint,
    buildState,
  };
}

/**
 * Shared-core deployment transaction. Build once under the global deploy lock,
 * but never replace an already-serving Gateway merely because shared dist moved.
 * A live process keeps its loaded generation and surfaces maintenance drift until
 * an explicit Restart targets that instance. This prevents unrelated Start/Build
 * actions from opening surprise connector 502 windows on healthy peers.
 */
async function collectRuntimeDeployStates(targetName, names, rollout) {
  const states = new Map();
  for (const instanceName of names) {
    try {
      states.set(instanceName, await serverStatus(instanceName));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // The requested target must always have readable authority; starting it
      // while its own PID/config status is corrupt would silently rewrite or
      // bypass the exact recovery evidence that the Manager is meant to guard.
      if (instanceName === targetName) {
        return {
          ok: false,
          error,
          failedInstance: instanceName,
          result: {
            ok: false,
            restarted: false,
            preserved: true,
            rollingRestarted: rollout,
            error,
            failedInstance: instanceName,
          },
        };
      }

      // A corrupt *peer* authority record must not globally deadlock an
      // unrelated manual lifecycle. Preserve the corrupt bytes and derive only
      // the minimum current liveness needed by shared-runtime safety. If the
      // peer's configured listener proves a managed runtime is alive, mark it
      // running-but-unowned so any rollout that would have to touch it still
      // fails closed. With no live proof, keep the peer isolated and continue;
      // never repair/adopt its PID ledger as a side effect of another instance.
      let fallback = {
        running: false,
        port: 0,
        configuredPort: 0,
        pid: null,
        health: null,
        portOccupied: false,
        invalidConfig: true,
        configDrift: false,
        artifactDrift: false,
        buildDrift: false,
        owned: false,
        authorityError: error,
      };
      try {
        const peerEnv = await readInstanceEnv(instanceName);
        const peerPort = Number(peerEnv.PORT || 0);
        const validPeerPort = Number.isInteger(peerPort) && peerPort > 0 && peerPort < 65536;
        if (validPeerPort) {
          const peerHealth = await serverHealth(peerPort);
          const peerHealthPid = Number(peerHealth?.pid);
          const provenRunning = Boolean(
            peerHealth &&
            isManagedInstanceHealth(peerHealth, instanceName) &&
            Number.isSafeInteger(peerHealthPid) &&
            peerHealthPid > 0 &&
            isPidAlive(peerHealthPid)
          );
          fallback = {
            ...fallback,
            running: provenRunning,
            port: peerPort,
            configuredPort: peerPort,
            pid: provenRunning ? peerHealthPid : null,
            health: provenRunning ? peerHealth : null,
            invalidConfig: false,
            portOccupied: !provenRunning && await isPortOpen(peerPort),
          };
        }
      } catch {
        // The original authority error remains the diagnostic owner. This peer
        // is not adopted or rewritten by the unrelated lifecycle transaction.
      }
      states.set(instanceName, fallback);
    }
  }
  return { ok: true, states };
}

async function ensureRuntimeAndServerUnlocked(name, { restartTarget = false } = {}) {
  const rollout = [];
  let targetRestartReceipt = null;
  let targetStarted = false;
  let forceBuild = false;

  for (let pass = 1; pass <= RUNTIME_BUILD_MAX_ATTEMPTS; pass += 1) {
    const build = await ensureRuntimeBuiltUnlocked({ forceBuild });
    if (!build.ok) {
      return { ...build, ok: false, restarted: false, rollingRestarted: rollout, deployPass: pass };
    }
    const generation = build.sourceFingerprint;
    const names = await listInstances();
    if (!names.includes(name)) {
      return {
        ok: false,
        retryable: true,
        staleInstanceAuthority: true,
        preserved: true,
        restarted: false,
        rollingRestarted: rollout,
        deployPass: pass,
        error: `Gateway '${name}' is no longer present in the managed instance catalog; refusing to recreate stale lifecycle authority.`,
      };
    }
    names.sort();

    const stateCollection = await collectRuntimeDeployStates(name, names, rollout);
    if (!stateCollection.ok) return stateCollection.result;
    const states = stateCollection.states;
    const runningNames = names.filter((instanceName) => states.get(instanceName)?.running);
    const targetState = states.get(name);
    if (targetState?.running && !targetState.owned) {
      return {
        ok: false,
        restarted: false,
        preserved: true,
        rollingRestarted: rollout,
        error: `Gateway '${name}' is running but exact Manager ownership cannot be proven; refusing false-green Start/Restart or duplicate process creation.`,
      };
    }
    // Start is idempotent and non-destructive for an already-running Gateway.
    // Only an explicit Restart may replace a previously-serving target. If this
    // transaction itself started the target and source/config moved before the
    // transaction settled, it may refresh that not-yet-exposed generation so the
    // Start result is internally coherent. Unrelated live peers are *never*
    // rolling-restarted merely because shared dist advanced; they remain healthy
    // on their loaded generation and surface artifact/build drift until explicit
    // maintenance. This removes cross-instance connector interruption.
    const refreshJustStartedTarget = Boolean(
      targetStarted
      && targetState?.running
      && (targetState.configDrift || targetState.artifactDrift || targetState.buildDrift)
    );
    const restartNames = targetState?.running && (restartTarget || refreshJustStartedTarget) ? [name] : [];

    const unowned = restartNames.find((instanceName) => states.get(instanceName)?.running && !states.get(instanceName)?.owned);
    if (unowned) {
      return {
        ok: false,
        restarted: false,
        preserved: true,
        rollingRestarted: rollout,
        error: `Shared runtime deployment requires restarting ${unowned}, but that Gateway process is not owned by Manager. No managed Gateway was stopped in this pass.`,
      };
    }

    let generationMoved = false;
    for (const instanceName of restartNames) {
      const beforeRestart = await runtimeGenerationStatus(generation);
      if (!beforeRestart.ok) {
        forceBuild = true;
        generationMoved = true;
        break;
      }
      const restarted = await enqueueServerLifecycle(instanceName, () => restartServerUnlockedCurrent(instanceName, {
        // Only a user-explicit Server Restart may bridge a runtime that predates
        // atomic MCP admission drain. Start/background/build paths remain unable
        // to use the non-atomic legacy maintenance fallback.
        allowLegacyPreDrainMaintenance: restartTarget && instanceName === name,
      }));
      if (!restarted.ok) {
        return {
          ...restarted,
          ok: false,
          restarted: false,
          rollingRestarted: rollout,
          failedInstance: instanceName,
        };
      }
      if (instanceName === name && !targetRestartReceipt) targetRestartReceipt = restarted;
      rollout.push(instanceName);
      const afterRestart = await runtimeGenerationStatus(generation);
      if (!afterRestart.ok) {
        forceBuild = true;
        generationMoved = true;
        break;
      }
    }
    if (generationMoved) continue;

    let currentTarget = await serverStatus(name);
    if (!currentTarget.running) {
      const beforeStart = await runtimeGenerationStatus(generation);
      if (!beforeStart.ok) {
        forceBuild = true;
        continue;
      }
      const started = await enqueueServerLifecycle(name, () => startServerUnlocked(name));
      if (!started.ok) {
        return { ...started, restarted: false, rollingRestarted: rollout, failedInstance: name };
      }
      targetStarted = true;
      currentTarget = await serverStatus(name);
      const afterStart = await runtimeGenerationStatus(generation);
      if (!afterStart.ok) {
        forceBuild = true;
        continue;
      }
    }

    const finalGeneration = await runtimeGenerationStatus(generation);
    if (!finalGeneration.ok) {
      forceBuild = true;
      continue;
    }
    currentTarget = await serverStatus(name);
    const deferredRestartNames = runningNames.filter((instanceName) => {
      if (instanceName === name && rollout.includes(name)) return false;
      const state = states.get(instanceName);
      return Boolean(state?.artifactDrift || state?.buildDrift || state?.configDrift);
    });
    return {
      ...currentTarget,
      ok: true,
      alreadyRunning: currentTarget.running && !targetStarted && !rollout.includes(name) && !restartTarget,
      started: targetStarted,
      restarted: rollout.includes(name),
      previousPid: targetRestartReceipt?.previousPid ?? null,
      previousProcessExited: targetRestartReceipt?.previousProcessExited === true,
      gracefulStop: targetRestartReceipt?.gracefulStop === true,
      trafficDrain: targetRestartReceipt?.trafficDrain || null,
      legacyPreDrainMaintenance: targetRestartReceipt?.legacyPreDrainMaintenance === true,
      built: build.built === true,
      dependenciesInstalled: build.dependenciesInstalled === true,
      sourceFingerprint: generation,
      rollingRestarted: [...new Set(rollout)],
      maintenanceRequired: Boolean(
        currentTarget.configDrift
        || currentTarget.artifactDrift
        || currentTarget.buildDrift
        || deferredRestartNames.length > 0
      ),
      deferredRestartNames,
      deployPass: pass,
    };
  }

  return {
    ok: false,
    restarted: false,
    rollingRestarted: [...new Set(rollout)],
    error: `Shared runtime generation did not remain stable across ${RUNTIME_BUILD_MAX_ATTEMPTS} deployment passes; no further Gateway was stopped.`,
  };
}

async function startServer(name) {
  if (managerRestartInFlight) {
    return { ok: false, error: "Manager đang self-restart; từ chối bắt đầu Server lifecycle mới." };
  }
  const intent = beginInstanceIntent(name, "server:start");
  const existing = intent.consecutiveSameType ? serverStartInFlight.get(name) : null;
  if (existing) return await existing;

  // Any non-consecutive command — including Tunnel controls — is a coalescing
  // barrier. This Start is a fresh intent generation and must enter the shared
  // per-instance command queue in arrival order.
  serverRestartInFlight.delete(name);
  const pending = enqueueServerCommand(
    name,
    () => enqueueRuntimeDeploy(() => ensureRuntimeAndServerUnlocked(name, { restartTarget: false }))
  );
  serverStartInFlight.set(name, pending);
  // This marker proves the Start intent and its shared command promise are
  // registered. It intentionally precedes the potentially slow shared runtime
  // build and process-spawn marker so diagnostics/tests never confuse cold-build
  // latency with request-order admission failure.
  console.log(`[manager-command] instance=${name} intent=server:start sequence=${intent.sequence} registered=true`);
  try {
    return await pending;
  } finally {
    if (serverStartInFlight.get(name) === pending) serverStartInFlight.delete(name);
  }
}

async function stopServer(name) {
  cancelledBootAutoStart.add(name);
  if (managerRestartInFlight) {
    return { ok: false, error: "Manager đang self-restart; từ chối bắt đầu Server lifecycle mới." };
  }
  beginInstanceIntent(name, "server:stop");
  // Stop is an explicit intent barrier: callers arriving after it must not
  // coalesce onto an older Start/Restart that is still settling.
  serverStartInFlight.delete(name);
  serverRestartInFlight.delete(name);
  return enqueueServerCommand(
    name,
    // Serialize Stop with shared dist work so a concurrent build/start transaction
    // cannot observe half-settled lifecycle authority. Shared builds are non-
    // disruptive to live peers, but the global turn still gives this explicit
    // Stop deterministic last-intent ordering.
    () => enqueueRuntimeDeploy(() => enqueueServerLifecycle(name, () => stopServerUnlocked(name)))
  );
}

async function restartServerOnce(name, inFlightStart = null) {
  // A bootstrap/manual Start may already be inside the shared build/deploy
  // transaction when an explicit Restart arrives. Without coalescing, Restart
  // waits for that exact-current Start to finish and immediately performs a
  // second stop -> start, producing the visible "starts twice" race. If the
  // in-flight Start actually created/restarted this instance and the resulting
  // generation is still exact-current, that mutation already satisfies the
  // restart intent. Do not bounce a freshly healthy process just because the UI
  // request landed a few milliseconds later. An idempotent already-running
  // Start does not satisfy Restart and still falls through to a real restart.
  if (inFlightStart) {
    let startResult = null;
    try {
      startResult = await inFlightStart;
    } catch {
      // The normal restart transaction below will diagnose/recover the state.
    }
    const startMutatedTarget = Boolean(
      startResult?.ok
      && (startResult.started === true || startResult.restarted === true)
    );
    if (startMutatedTarget) {
      const current = await serverStatus(name);
      const exactCurrent = Boolean(
        current.running
        && current.owned
        && !current.configDrift
        && !current.buildDrift
        && !current.artifactDrift
      );
      if (exactCurrent) {
        return {
          ...startResult,
          ...current,
          ok: true,
          restarted: true,
          coalescedInFlightStart: true,
          previousPid: startResult.previousPid || null,
        };
      }
    }
  }
  return enqueueRuntimeDeploy(() => ensureRuntimeAndServerUnlocked(name, { restartTarget: true }));
}

async function restartServer(name) {
  cancelledBootAutoStart.add(name);
  if (managerRestartInFlight) {
    return { ok: false, restarted: false, error: "Manager đang self-restart; từ chối bắt đầu Server lifecycle mới." };
  }

  // Coalesce only truly consecutive duplicate Restart intents. Any intervening
  // Server/Tunnel command is a generation barrier even if an older Restart
  // promise is still settling in the ledger.
  const intent = beginInstanceIntent(name, "server:restart");
  const existing = intent.consecutiveSameType ? serverRestartInFlight.get(name) : null;
  if (existing) return await existing;

  // A Restart may treat the immediately preceding in-flight Start as satisfying
  // the restart intent, but never a Start from an older generation separated by
  // Stop or any Tunnel command.
  const inFlightStart = intent.previousType === "server:start"
    ? serverStartInFlight.get(name) || null
    : null;
  serverStartInFlight.delete(name);

  const pending = enqueueServerCommand(name, () => restartServerOnce(name, inFlightStart));
  serverRestartInFlight.set(name, pending);
  try {
    return await pending;
  } finally {
    if (serverRestartInFlight.get(name) === pending) serverRestartInFlight.delete(name);
  }
}


async function tunnelStatus(name, desiredEnv = null) {
  const env = desiredEnv || (await readInstanceEnv(name));
  const persistedEnv = desiredEnv ? await readInstanceEnv(name) : env;
  const config = await readInstanceConfig(name);
  const inst = instPaths(name);
  const tunnelId = env.OPENAI_TUNNEL_ID || "";
  const apiKey = env.OPENAI_TUNNEL_API_KEY || "";
  const mode = tunnelId && apiKey ? "openai" : "cloudflare";
  const healthPort = Number(
    desiredEnv
      ? (env.OPENAI_TUNNEL_HEALTH_PORT || config.healthPort || 0)
      : (config.healthPort || env.OPENAI_TUNNEL_HEALTH_PORT || 0)
  );
  const healthPortValid = Number.isInteger(healthPort) && healthPort > 0 && healthPort < 65536;
  const controlPlaneUrl = tunnelId ? `https://api.openai.com/v1/tunnel/${tunnelId}` : null;
  const serverPort = Number(env.PORT || 0);
  const persistedTunnelId = persistedEnv.OPENAI_TUNNEL_ID || "";
  const persistedApiKey = persistedEnv.OPENAI_TUNNEL_API_KEY || "";
  const persistedMode = persistedTunnelId && persistedApiKey ? "openai" : "cloudflare";
  const persistedHealthPort = Number(config.healthPort || persistedEnv.OPENAI_TUNNEL_HEALTH_PORT || 0);
  const persistedServerPort = Number(persistedEnv.PORT || 0);
  const oaPortPromise = healthPortValid ? isPortOpen(healthPort) : Promise.resolve(false);
  const oaProcessesPromise = processesWithCmdLineAsync("tunnel-client.exe", inst.profile);
  const desiredCfProcessesPromise = Number.isInteger(serverPort) && serverPort > 0 && serverPort < 65536
    ? processesWithCmdLineAsync("cloudflared.exe", `localhost:${serverPort}`)
    : Promise.resolve([]);
  const persistedCfProcessesPromise = persistedServerPort === serverPort
    ? desiredCfProcessesPromise
    : Number.isInteger(persistedServerPort) && persistedServerPort > 0 && persistedServerPort < 65536
      ? processesWithCmdLineAsync("cloudflared.exe", `localhost:${persistedServerPort}`)
      : Promise.resolve([]);
  const [oaPortOpen, rawOaProcesses, rawDesiredCfProcesses, rawPersistedCfProcesses] = await Promise.all([
    oaPortPromise,
    oaProcessesPromise,
    desiredCfProcessesPromise,
    persistedCfProcessesPromise,
  ]);
  const oaProcesses = rawOaProcesses.filter((process) => isPidAlive(process.pid));
  const oaPids = oaProcesses.map((process) => process.pid);
  const expectedOaRuntimePath = expectedOpenAiTunnelRuntimePath();
  const expectedOaRuntimeIdentity = expectedOpenAiTunnelRuntimeIdentity();
  const oaRuntimePathMatches = Boolean(
    oaProcesses.length === 1
    && sameExecutablePath(oaProcesses[0].executablePath, expectedOaRuntimePath)
  );
  // A single TCP connect miss is weaker evidence than the bounded strict
  // /healthz + /readyz probe. Never gate health on oaPortOpen: Windows can
  // transiently miss that one connect while the exact managed tunnel remains
  // live/ready. Only spend the health retry budget when a same-profile tunnel
  // process actually exists; stopped/conflict-only status remains cheap.
  const oaHealthy = healthPortValid && oaPids.length > 0
    ? await tunnelClientHealth(healthPort)
    : false;
  const oaProcessStartedAt = oaProcesses.length === 1 ? oaProcesses[0].startedAt : null;
  // Always detect cloudflared processes targeting this instance's server port,
  // even when OpenAI mode is currently configured. Otherwise an old/unowned
  // Cloudflare tunnel can coexist with OpenAI and escape mixed-process drift.
  const desiredCfProcesses = rawDesiredCfProcesses.filter((process) => isPidAlive(process.pid));
  const desiredCfPids = desiredCfProcesses.map((process) => process.pid);
  const persistedCfProcesses = persistedServerPort === serverPort
    ? desiredCfProcesses
    : rawPersistedCfProcesses.filter((process) => isPidAlive(process.pid));
  const persistedCfPids = persistedCfProcesses.map((process) => process.pid);
  const savedPid = await readPidFile(inst.tunnelPid);
  const pidFileStat = savedPid ? await fsp.stat(inst.tunnelPid).catch(() => null) : null;
  const pidFileMtimeMs = Number(pidFileStat?.mtimeMs);
  const savedOaProcess = savedPid ? oaProcesses.find((process) => process.pid === savedPid) || null : null;
  const savedProcessStartedAt = String(config.tunnelProcessStartedAt || "");
  const exactOaProcessIdentity = Boolean(
    savedOaProcess
    && savedProcessStartedAt
    && savedOaProcess.startedAt === savedProcessStartedAt
  );
  const persistedOaFingerprint = persistedMode === "openai"
    ? openAiTunnelLaunchFingerprint({
        tunnelId: persistedTunnelId,
        apiKey: persistedApiKey,
        healthPort: persistedHealthPort,
        serverPort: persistedServerPort,
        runtimeIdentity: expectedOaRuntimeIdentity,
      })
    : null;
  const persistedOaLegacyFingerprint = persistedMode === "openai"
    ? legacyOpenAiTunnelLaunchFingerprintV1({
        tunnelId: persistedTunnelId,
        apiKey: persistedApiKey,
        healthPort: persistedHealthPort,
        serverPort: persistedServerPort,
      })
    : null;
  const legacyOaProcessIdentity = Boolean(
    !savedProcessStartedAt
    && savedOaProcess
    && legacyPidFileMatchesProcessStart({
      processStartedAt: savedOaProcess.startedAt,
      pidFileMtimeMs,
    })
    && typeof config.openaiTunnelLaunchFingerprint === "string"
    && /^[0-9a-f]{64}$/.test(config.openaiTunnelLaunchFingerprint)
    && [persistedOaFingerprint, persistedOaLegacyFingerprint].includes(config.openaiTunnelLaunchFingerprint)
  );
  const managedOaPid = exactOaProcessIdentity || legacyOaProcessIdentity ? savedPid : null;
  const desiredOaFingerprint = mode === "openai"
    ? openAiTunnelLaunchFingerprint({
        tunnelId,
        apiKey,
        healthPort,
        serverPort,
        runtimeIdentity: expectedOaRuntimeIdentity,
      })
    : null;
  const oaLaunchState = oaPids.length > 0
    ? evaluateOpenAiTunnelLaunchState({
        mode,
        healthy: oaHealthy,
        processPids: oaPids,
        processStartedAt: oaProcessStartedAt,
        savedPid,
        savedProcessStartedAt: config.tunnelProcessStartedAt,
        savedFingerprint: config.openaiTunnelLaunchFingerprint,
        desiredFingerprint: desiredOaFingerprint,
        runtimePathMatches: oaRuntimePathMatches,
      })
    : null;
  const localCfProcesses = savedPid
    ? (await processesWithCmdLineAsync("cloudflared.exe", "localhost:"))
        .filter((process) => isPidAlive(process.pid))
    : [];
  const savedCfProcess = savedPid
    ? localCfProcesses.find((process) => process.pid === savedPid) || null
    : null;
  const exactCfProcessIdentity = Boolean(
    savedCfProcess
    && savedProcessStartedAt
    && savedCfProcess.startedAt === savedProcessStartedAt
  );
  const legacyCfProcessIdentity = Boolean(
    !savedProcessStartedAt
    && savedCfProcess
    && persistedCfPids.includes(savedPid)
    && legacyPidFileMatchesProcessStart({
      processStartedAt: savedCfProcess.startedAt,
      pidFileMtimeMs,
    })
  );
  const managedCfPid = exactCfProcessIdentity || legacyCfProcessIdentity ? savedPid : null;
  const savedCfRunning = Boolean(savedCfProcess);
  const desiredCfPid = desiredCfPids[0] || null;
  const desiredCfOwned = Boolean(managedCfPid && desiredCfPids.includes(managedCfPid));
  // Mixed detection must cover the proposed/destination port, the persisted
  // current config, and an exact saved-PID cloudflared process that may still
  // target an older port after out-of-band config drift.
  const cfCandidatePids = [...new Set([
    ...desiredCfPids,
    ...persistedCfPids,
    ...(savedCfProcess ? [savedCfProcess.pid] : []),
  ])];
  const cloudflaredExists = fs.existsSync(CLOUDFLARED);

  // The profile path identifies candidate OpenAI processes, but ownership is
  // stronger: exact saved PID + process CreationDate. Cloudflared has no profile file,
  // so its ownership is saved PID + CreationDate + local-url command target.
  if (oaPids.length > 0 && cfCandidatePids.length > 0) {
    const mixedPids = [...new Set([...oaPids, ...cfCandidatePids])];
    return {
      running: true,
      mode,
      kind: "mixed",
      pid: managedOaPid || managedCfPid || mixedPids[0] || null,
      owned: Boolean(managedOaPid || managedCfPid),
      ownedOpenAiPid: managedOaPid,
      ownedCloudflarePid: managedCfPid,
      legacyProcessIdentity: legacyOaProcessIdentity || legacyCfProcessIdentity,
      configDrift: true,
      ambiguous: true,
      duplicateProcesses: mixedPids.length > 1,
      pids: mixedPids,
      healthPort,
      cloudflaredExists,
      invalidConfig: !healthPortValid,
      // A known same-profile tunnel-client exists; a failed /health probe is
      // operational health drift, not proof that an unrelated process owns the port.
      portOccupied: false,
    };
  }
  if (oaPids.length > 0) {
    const desired = oaLaunchState?.desired === true;
    return {
      running: true,
      mode,
      tunnelId,
      kind: "openai",
      pid: managedOaPid || oaPids[0],
      owned: Boolean(managedOaPid),
      ownedOpenAiPid: managedOaPid,
      legacyProcessIdentity: legacyOaProcessIdentity,
      configDrift: oaLaunchState?.configDrift !== false,
      healthDrift: oaLaunchState?.healthDrift === true,
      ambiguous: oaLaunchState?.ambiguous === true,
      duplicateProcesses: oaLaunchState?.duplicateProcesses === true,
      pids: oaLaunchState?.duplicateProcesses ? oaLaunchState.pids : undefined,
      launchPidMatch: oaLaunchState?.pidMatch === true,
      launchProcessStartedAtMatch: oaLaunchState?.processStartedAtMatch === true,
      launchFingerprintMatch: oaLaunchState?.fingerprintMatch === true,
      runtimePath: oaProcesses.length === 1 ? oaProcesses[0].executablePath : null,
      expectedRuntimePath: expectedOaRuntimePath,
      runtimePathMatches: oaLaunchState?.runtimePathMatches === true,
      runtimeIdentity: expectedOaRuntimeIdentity,
      healthy: oaHealthy,
      url: desired ? controlPlaneUrl : config.lastTunnelUrl || null,
      healthPort,
      cloudflaredExists,
      invalidConfig: !healthPortValid,
      // The exact same-profile tunnel-client is known. A failed health probe is
      // health drift, not evidence that an unrelated process owns this port.
      portOccupied: false,
    };
  }
  if (savedCfRunning) {
    const desired = mode === "cloudflare" && desiredCfOwned && exactCfProcessIdentity;
    return {
      running: true,
      mode,
      kind: "cloudflare",
      pid: managedCfPid || savedPid,
      owned: Boolean(managedCfPid),
      ownedCloudflarePid: managedCfPid,
      legacyProcessIdentity: legacyCfProcessIdentity,
      launchProcessStartedAtMatch: exactCfProcessIdentity,
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
      configDrift: true,
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

/* Ensure bản tunnel-client đúng OPENAI_TUNNEL_VERSION đang cài trong bin/.
 * - Marker khớp + exe tồn tại → dùng luôn (không tải lại mỗi lần).
 * - Marker lệch (hoặc thiếu) → nâng cấp: bản cũ được đổi tên thành
 *   tunnel-client-<version>.exe giữ lại trong bin/ (backup khôi phục được),
 *   KHÔNG xóa thẳng. Nếu exe đang bị tunnel chạy khóa (Windows không cho
 *   rename file đang thực thi) → trả lỗi rõ ràng, không đè. */
async function finalizeTunnelClientRuntime(officialExe) {
  if (!IS_WIN) {
    return {
      ok: true,
      path: officialExe,
      patchedRuntime: false,
      runtimeIdentity: `official:${OPENAI_TUNNEL_VERSION}`,
    };
  }
  const runtime = await ensureLazyCodexTunnelRuntime({ root: ROOT });
  if (!runtime.ok) {
    return {
      ok: false,
      error: runtime.error,
      patchedRuntime: true,
      failClosed: true,
    };
  }
  return {
    ok: true,
    path: runtime.path,
    patchedRuntime: true,
    runtimeIdentity: runtime.runtimeIdentity || lazyCodexRuntimeLaunchIdentity(),
    rebuilt: Boolean(runtime.rebuilt),
    repairedFrom: runtime.repairedFrom || null,
  };
}

async function ensureTunnelClientUnlocked() {
  // Windows must never depend on, download, select, or fall back to the official
  // v0.0.11 runtime: that build eagerly starts CodexBridge/codex app-server. The
  // verified lazy-Codex runtime is the only legal OpenAI Tunnel executable here.
  if (IS_WIN) return await finalizeTunnelClientRuntime(null);

  const binDir = path.join(ROOT, "bin");
  const exe = OPENAI_TUNNEL_CLIENT_EXE;
  let installedVersion = "";
  let backupPath = null;
  try {
    installedVersion = (await fsp.readFile(TUNNEL_CLIENT_VERSION_FILE, "utf8")).trim();
  } catch (err) {
    if (err?.code !== "ENOENT") {
      return { ok: false, error: `Không đọc được tunnel-client version marker: ${String(err?.message || err).slice(0, 300)}` };
    }
  }
  if (fs.existsSync(exe) && installedVersion === OPENAI_TUNNEL_VERSION) {
    return await finalizeTunnelClientRuntime(exe);
  }
  if (fs.existsSync(exe)) {
    // Bản cũ: đổi tên giữ backup (reversible), lỗi rename = file đang bị
    // tunnel đang chạy khóa → yêu cầu tắt Tunnel trước.
    backupPath = path.join(binDir, `tunnel-client-${installedVersion || "unknown"}.exe`);
    try {
      await fsp.mkdir(binDir, { recursive: true });
      if (backupPath !== exe) await fsp.rename(exe, backupPath);
    } catch {
      return {
        ok: false,
        error: `tunnel-client đang chạy bản cũ (${installedVersion || "?"}) — tắt Tunnel rồi bấm lại để nâng cấp lên ${OPENAI_TUNNEL_VERSION}.`,
      };
    }
  }
  // Cache zip theo version (giữ lại, không xóa — tái sử dụng cho lần sau và
  // cho phép cài lại/re-extract mà không cần tải lại). streamResponseToFileBounded
  // ghi atomic (tmp + rename) nên file cache luôn là một bản tải hoàn chỉnh.
  const zipCache = path.join(binDir, `tunnel-client-${OPENAI_TUNNEL_VERSION}.zip`);
  try {
    await fsp.mkdir(binDir, { recursive: true });
    if (!fs.existsSync(zipCache) || (await fsp.stat(zipCache)).size === 0) {
      const res = await fetch(OPENAI_TUNNEL_ZIP_URL, { signal: AbortSignal.timeout(240000), redirect: "follow" });
      if (!res.ok) throw new Error(`Tải tunnel-client thất bại: HTTP ${res.status}`);
      await streamResponseToFileBounded(res, zipCache, DOWNLOAD_MAX_BYTES, "tunnel-client download");
    }
    extractSingleZipEntryBoundedWindows(
      zipCache,
      exe,
      "tunnel-client.exe",
      DOWNLOAD_MAX_BYTES,
      { timeoutMs: 120000, maxBuffer: HELPER_OUTPUT_MAX_CHARS }
    );
    if (!fs.existsSync(exe)) {
      throw new Error("Giải nén tunnel-client thất bại: không tạo được tunnel-client.exe.");
    }
    // Ghi marker SAU khi exe mới đã nằm tại chỗ — nếu bước này lỗi, marker cũ
    // còn nguyên và lần chạy sau tự nâng cấp lại (trạng thái version nhất quán).
    await fsp.writeFile(TUNNEL_CLIENT_VERSION_FILE, OPENAI_TUNNEL_VERSION, "utf8");
    return await finalizeTunnelClientRuntime(exe);
  } catch (err) {
    const message = String((err && err.message) || err);
    // Rollback: nếu chưa cài được bản mới mà exe đang thiếu (đã rename đi),
    // khôi phục backup ngay để không để lại trạng thái mất binary.
    let rollbackError = null;
    if (backupPath && !fs.existsSync(exe)) {
      try {
        await fsp.rename(backupPath, exe);
        backupPath = null;
      } catch (rollbackErr) {
        rollbackError = String(rollbackErr?.message || rollbackErr).slice(0, 300);
      }
    }
    const baseError = message.startsWith("Giải nén") || message.startsWith("Tải tunnel-client") ? message : `Tải tunnel-client lỗi: ${message}`;
    return {
      ok: false,
      error: rollbackError
        ? `${baseError}; rollback binary thất bại (${rollbackError}). Backup được giữ tại ${backupPath}.`
        : baseError,
      rollbackFailed: Boolean(rollbackError),
      backupPath: rollbackError ? backupPath : null,
    };
  }
}

let tunnelClientEnsurePromise = null;

async function ensureTunnelClient() {
  if (tunnelClientEnsurePromise) return await tunnelClientEnsurePromise;
  const pending = ensureTunnelClientUnlocked();
  tunnelClientEnsurePromise = pending;
  try {
    return await pending;
  } finally {
    if (tunnelClientEnsurePromise === pending) tunnelClientEnsurePromise = null;
  }
}

const tunnelCommandChains = new Map();
const tunnelLifecycleChains = new Map();
const tunnelStartInFlight = new Map();
const tunnelRestartInFlight = new Map();

function enqueueTunnelCommand(name, operation) {
  const run = enqueueInstanceCommand(name, operation);
  const settled = run.then(() => undefined, () => undefined);
  tunnelCommandChains.set(name, settled);
  settled.finally(() => {
    if (tunnelCommandChains.get(name) === settled) tunnelCommandChains.delete(name);
  });
  return run;
}

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

async function startTunnelUnlocked(name, { rollbackGateway = null } = {}) {
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
  if (st.running && st.healthDrift) {
    return {
      ok: false,
      error: "Managed OpenAI Tunnel process matches the saved launch configuration but its health endpoint is not responding; stop/restart Tunnel instead of treating it as already healthy.",
      ...st,
    };
  }
  if (st.running) return { ok: true, alreadyRunning: true, ...st };
  if (st.invalidConfig) return { ok: false, error: "OPENAI_TUNNEL_HEALTH_PORT is invalid; fix configuration before starting Tunnel." };
  if (st.portOccupied) return { ok: false, error: `Tunnel health port ${st.healthPort} is occupied by another process; refusing to start Tunnel.` };
  const inst = instPaths(name);
  const port = Number(env.PORT || 0);
  const serverState = await serverStatus(name);
  if (!serverState.running || !serverState.owned || serverState.configDrift) {
    const reason = serverState.portOccupied
      ? "the server port is occupied by another process"
      : !serverState.running
        ? "Local Coder server is not running"
        : !serverState.owned
          ? "Local Coder server ownership cannot be proven"
          : "Local Coder server configuration is stale";
    const driftDetail = serverState.portDrift
      ? `old PORT ${serverState.port} while .env configures PORT ${port}`
      : serverState.workspaceDrift
        ? `workspace ${serverState.health?.workspace || "(unknown)"} while .env configures ${expectedWorkspacePath(env) || "(none)"}`
        : "a configuration that differs from the saved .env";
    return { ok: false, error: serverState.configDrift ? `Cannot start Tunnel: managed Local Coder is still running with ${driftDetail}. Restart Local Coder first.` : `Cannot start Tunnel: ${reason} on port ${port}.` };
  }
  const rollbackGatewayMatches = Boolean(
    rollbackGateway
    && serverState.running
    && serverState.owned
    && !serverState.configDrift
    && Number(serverState.pid) === Number(rollbackGateway.pid)
    && String(serverState.health?.instructions?.loaded_at || "") === String(rollbackGateway.loadedAt || "")
  );
  if ((serverState.buildDrift || serverState.artifactDrift) && !rollbackGatewayMatches) {
    return {
      ok: false,
      error: serverState.buildDrift
        ? "Cannot start Tunnel: Gateway source changed after build/deploy preflight; retry the Tunnel lifecycle action."
        : "Cannot start Tunnel: Local Coder Server is running an older compiled runtime. Retry the Tunnel lifecycle action so the Gateway can be converged first.",
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
      // continuously even when the Manager/Local Coder Server stay healthy for days.
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
    const launchFingerprint = openAiTunnelLaunchFingerprint({
      tunnelId: env.OPENAI_TUNNEL_ID,
      apiKey: env.OPENAI_TUNNEL_API_KEY,
      healthPort,
      serverPort: port,
      runtimeIdentity: client.runtimeIdentity || expectedOpenAiTunnelRuntimeIdentity(),
    });
    await updateInstanceConfig(name, (config) => {
      clearTunnelLaunchEvidence(config);
      // Persist a pending fingerprint before spawn. Without a persisted
      // CreationDate this can never become a green/desired launch, but it lets
      // the bounded legacy bridge recover ownership after a Manager/CIM crash.
      config.openaiTunnelLaunchFingerprint = launchFingerprint;
    });
    await writePidFile(inst.tunnelPid, null);

    await fsp.writeFile(inst.tunnelLog, "");
    const pid = spawnDetached(client.path, ["run", "--profile-file", profileFile], inst.tunnelLog, {
      OPENAI_TUNNEL_API_KEY: env.OPENAI_TUNNEL_API_KEY,
      CONTROL_PLANE_API_KEY: env.OPENAI_TUNNEL_API_KEY,
      CONTROL_PLANE_TUNNEL_ID: env.OPENAI_TUNNEL_ID,
    });
    if (!Number.isInteger(pid) || pid <= 0) {
      await updateInstanceConfig(name, clearTunnelLaunchEvidence);
      await writePidFile(inst.tunnelPid, null);
      return { ok: false, error: "OpenAI tunnel process did not return a valid PID; startup was not accepted." };
    }
    await writePidFile(inst.tunnelPid, pid);
    invalidateProcessScanCache();
    let processStartedAt = null;
    const identityReady = await waitFor(async () => {
      const processIdentity = (await processesWithCmdLineAsync("tunnel-client.exe", profileFile))
        .find((process) => process.pid === pid);
      if (!processIdentity?.startedAt || !sameExecutablePath(processIdentity.executablePath, client.path)) return false;
      processStartedAt = processIdentity.startedAt;
      return true;
    }, 5000, 250);
    if (!identityReady || !processStartedAt) {
      await killPidTree(pid);
      invalidateProcessScanCache();
      const stopped = await waitFor(() => !isPidAlive(pid), 10000, 150);
      if (stopped) {
        await updateInstanceConfig(name, clearTunnelLaunchEvidence);
        await writePidFile(inst.tunnelPid, null);
      } else {
        // Keep the pending fingerprint + exact spawned PID. Once CIM recovers,
        // the bounded PID-file-mtime bridge can still prove safe stop ownership.
        await writePidFile(inst.tunnelPid, pid);
      }
      return {
        ok: false,
        error: "OpenAI tunnel process started but its Windows CreationDate identity could not be captured; refusing to accept unverifiable tunnel ownership."
          + (stopped ? "" : ` PID ${pid} is still alive; PID metadata was preserved for a safe stop/retry.`),
        pid: stopped ? null : pid,
        cleanupFailed: !stopped,
      };
    }
    // As soon as the OS identity is known, persist it before waiting on network
    // health. A Manager crash during the health window then leaves exact
    // PID+CreationDate+fingerprint evidence instead of an unowned live process.
    await updateInstanceConfig(name, (config) => {
      config.openaiTunnelLaunchFingerprint = launchFingerprint;
      config.tunnelProcessStartedAt = processStartedAt;
    });
    const up = await waitFor(() => tunnelClientHealth(healthPort), 45000);
    if (!up) {
      // Startup owns only the exact PID it just spawned. A same-profile process
      // that appears concurrently is not ours and must never be killed as cleanup.
      const targets = isPidAlive(pid) ? [pid] : [];
      for (const p of targets) await killPidTree(p);
      invalidateProcessScanCache();
      const stopped = await waitFor(() => targets.every((p) => !isPidAlive(p)), 10000, 150);
      if (stopped) {
        await updateInstanceConfig(name, clearTunnelLaunchEvidence);
        await writePidFile(inst.tunnelPid, null);
      } else {
        // Keep exact fingerprint + CreationDate for a survivor. Clearing them
        // here would turn a failed cleanup into an unowned process deadlock.
        const survivors = targets.filter(isPidAlive);
        await writePidFile(inst.tunnelPid, survivors[0] || pid);
      }
      const tail = await tailFile(inst.tunnelLog);
      return {
        ok: false,
        error: "OpenAI tunnel không khởi động được."
          + (stopped ? "" : " Managed tunnel process is still alive; PID metadata was preserved for a safe stop/retry.")
          + " Log cuối:\n" + tail.slice(-1500),
        pid: stopped ? null : (targets.find(isPidAlive) || pid),
        cleanupFailed: !stopped,
      };
    }
    const tunnelUrl = `https://api.openai.com/v1/tunnel/${env.OPENAI_TUNNEL_ID}`;
    await updateInstanceConfig(name, (config) => {
      config.lastTunnelUrl = tunnelUrl;
      config.openaiTunnelLaunchFingerprint = launchFingerprint;
      config.tunnelProcessStartedAt = processStartedAt;
    });
    return { ok: true, mode: "openai", tunnelId: env.OPENAI_TUNNEL_ID, healthPort, url: tunnelUrl, pid };
  }

  // cloudflare
  if (!fs.existsSync(CLOUDFLARED)) {
    return { ok: false, error: "NO_CLOUDFLARED", hint: "Chưa có cloudflared — bấm 'Tải cloudflared' trong thẻ Tunnel." };
  }
  await updateInstanceConfig(name, clearTunnelLaunchEvidence);
  await writePidFile(inst.tunnelPid, null);
  await fsp.writeFile(inst.tunnelLog, "");
  const pid = spawnDetached(CLOUDFLARED, ["tunnel", "--url", `http://localhost:${port}`], inst.tunnelLog);
  if (!Number.isInteger(pid) || pid <= 0) {
    await updateInstanceConfig(name, clearTunnelLaunchEvidence);
    await writePidFile(inst.tunnelPid, null);
    return { ok: false, error: "cloudflared did not return a valid PID; startup was not accepted." };
  }
  invalidateProcessScanCache();
  await writePidFile(inst.tunnelPid, pid);
  let processStartedAt = null;
  const identityReady = await waitFor(async () => {
    const processIdentity = (await processesWithCmdLineAsync("cloudflared.exe", `localhost:${port}`))
      .find((process) => process.pid === pid);
    if (!processIdentity?.startedAt) return false;
    processStartedAt = processIdentity.startedAt;
    return true;
  }, 5000, 250);
  if (!identityReady || !processStartedAt) {
    await killPidTree(pid);
    invalidateProcessScanCache();
    const stopped = await waitFor(() => !isPidAlive(pid), 10000, 150);
    await updateInstanceConfig(name, clearTunnelLaunchEvidence);
    await writePidFile(inst.tunnelPid, stopped ? null : pid);
    return {
      ok: false,
      error: "cloudflared started but its Windows CreationDate identity could not be captured; refusing to accept unverifiable tunnel ownership."
        + (stopped ? "" : ` PID ${pid} is still alive; PID metadata was preserved for a safe stop/retry.`),
      pid: stopped ? null : pid,
      cleanupFailed: !stopped,
    };
  }
  // Persist the exact OS identity before waiting for the public URL. If the
  // Manager exits during this window, the surviving cloudflared process stays
  // exactly owned rather than falling back to weaker legacy evidence.
  await updateInstanceConfig(name, (config) => {
    config.tunnelProcessStartedAt = processStartedAt;
  });
  let url = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !url) {
    const tail = await tailFile(inst.tunnelLog, 40000);
    const m = tail.match(TUNNEL_URL_RE);
    if (m) url = m[0];
    if (!url) await new Promise((r) => setTimeout(r, 400));
  }
  if (!url) {
    await killPidTree(pid);
    invalidateProcessScanCache();
    const stopped = await waitFor(() => !isPidAlive(pid), 5000, 150);
    if (stopped) {
      await updateInstanceConfig(name, clearTunnelLaunchEvidence);
      await writePidFile(inst.tunnelPid, null);
    } else {
      // CreationDate was already persisted before URL discovery. Preserve it
      // for a survivor so the next stop/retry keeps exact ownership.
      await writePidFile(inst.tunnelPid, pid);
    }
    const tail = await tailFile(inst.tunnelLog);
    return {
      ok: false,
      error: "Không nhận được URL tunnel." + (stopped ? "" : ` PID ${pid} vẫn còn sống; giữ tunnel.pid để có thể stop/recover an toàn.`) + " Log cuối:\n" + tail.slice(-1500),
      pid: stopped ? null : pid,
      cleanupFailed: !stopped,
    };
  }
  await updateInstanceConfig(name, (config) => {
    config.lastTunnelUrl = url;
    config.tunnelProcessStartedAt = processStartedAt;
  });
  return { ok: true, mode: "cloudflare", url, pid };
}

async function stopTunnelUnlocked(name) {
  const st = await tunnelStatus(name);
  const inst = instPaths(name);
  if (!st.running) {
    await writePidFile(inst.tunnelPid, null);
    await updateInstanceConfig(name, clearTunnelLaunchEvidence);
    return { ok: true, alreadyStopped: true, mode: st.mode };
  }
  if (!st.owned) {
    return {
      ok: false,
      mode: st.mode,
      stopped: false,
      error: `Refusing to stop an unowned ${st.kind || "tunnel"} process${st.pid ? ` (PID ${st.pid})` : ""}.`,
    };
  }
  const targets = new Set();
  if (Number.isInteger(st.ownedOpenAiPid) && isPidAlive(st.ownedOpenAiPid)) targets.add(st.ownedOpenAiPid);
  if (Number.isInteger(st.ownedCloudflarePid) && isPidAlive(st.ownedCloudflarePid)) targets.add(st.ownedCloudflarePid);
  if (targets.size === 0) return { ok: false, mode: st.mode, stopped: false, error: "Managed Tunnel is reported running but no owned process can be identified safely." };

  let killed = false;
  for (const pid of targets) killed = (await killPidTree(pid)) || killed;
  invalidateProcessScanCache();
  const stopped = await waitFor(() => [...targets].every((pid) => !isPidAlive(pid)), 10000, 150);
  if (!stopped) {
    return { ok: false, mode: st.mode, stopped: false, error: "Managed Tunnel process did not stop within 10 seconds; PID metadata was preserved for a safe retry." };
  }
  const needsHealthPortRelease = (st.kind === "openai" || st.kind === "mixed")
    && Number.isInteger(Number(st.healthPort))
    && Number(st.healthPort) > 0
    && Number(st.healthPort) < 65536;
  const portReleased = !needsHealthPortRelease || await waitForTunnelPortRelease({
    port: Number(st.healthPort),
    isPortOpen,
    timeoutMs: 5000,
    intervalMs: 100,
  });
  await writePidFile(inst.tunnelPid, null);
  await updateInstanceConfig(name, clearTunnelLaunchEvidence);
  if (!portReleased) {
    invalidatePortPidCache();
    const portPid = await pidOnPort(Number(st.healthPort));
    return {
      ok: false,
      mode: st.mode,
      kind: st.kind,
      stopped: true,
      forced: killed,
      portReleased: false,
      healthPort: Number(st.healthPort),
      portPid,
      error: `Managed Tunnel process exited but health port ${st.healthPort} did not release within 5 seconds${portPid ? ` (current listener PID ${portPid})` : ""}; refusing immediate restart.`,
    };
  }
  // Re-scan after removing only the exact owned process identities. A duplicate
  // or otherwise unowned candidate may intentionally remain alive; never call
  // that a clean stop and never let restart proceed over it.
  invalidateProcessScanCache();
  const remaining = await tunnelStatus(name);
  if (remaining.running) {
    return {
      ok: false,
      mode: st.mode,
      kind: st.kind,
      stopped: true,
      forced: killed,
      portReleased: true,
      remainingUnowned: true,
      remainingKind: remaining.kind,
      remainingPid: remaining.pid || null,
      error: `Owned Tunnel process stopped, but an unowned ${remaining.kind || "tunnel"} candidate${remaining.pid ? ` (PID ${remaining.pid})` : ""} is still running; refusing to report a clean stop or restart over it.`,
    };
  }
  return { ok: true, mode: st.mode, kind: st.kind, stopped: true, forced: killed, portReleased: true };
}

async function finishTunnelDisruptionAdmission(name, gatewayState, trafficDrain, result) {
  const admissionResume = trafficDrain?.admissionClosed
    ? await resumeServerTrafficAdmission(name, gatewayState)
    : { ok: true, skipped: true, reason: "admission-was-not-closed" };
  if (!admissionResume.ok) {
    return {
      ...result,
      ok: false,
      restarted: false,
      trafficDrain,
      admissionResume,
      error: `${result?.error ? `${result.error} ` : ""}Gateway MCP admission could not be resumed after Tunnel lifecycle: ${admissionResume.error || "unknown error"}`,
    };
  }
  return { ...result, trafficDrain, admissionResume };
}

async function stopTunnelWithTrafficDrainUnlocked(name) {
  const prior = await tunnelStatus(name);
  if (!prior.running) return stopTunnelUnlocked(name);

  const gateway = await serverStatus(name);
  let trafficDrain = { ok: true, admissionClosed: false, skipped: true, reason: "gateway-not-running" };
  if (gateway.running) {
    if (!gateway.owned) {
      return {
        ok: false,
        stopped: false,
        preserved: true,
        retryable: true,
        error: `Refusing disruptive Tunnel stop for '${name}': Gateway is running but exact Manager ownership is not proven, so active MCP traffic cannot be drained safely.`,
      };
    }
    trafficDrain = await drainServerTrafficForDisruption(name, gateway);
    if (!trafficDrain.ok) {
      return { ...trafficDrain, ok: false, stopped: false, preserved: true };
    }
  }

  const stopped = await stopTunnelUnlocked(name);
  return finishTunnelDisruptionAdmission(name, gateway, trafficDrain, stopped);
}

async function startTunnel(name) {
  if (managerRestartInFlight) {
    return { ok: false, error: "Manager đang self-restart; từ chối bắt đầu Tunnel lifecycle mới." };
  }
  const intent = beginInstanceIntent(name, "tunnel:start");
  const existing = intent.consecutiveSameType ? tunnelStartInFlight.get(name) : null;
  if (existing) return await existing;

  // Any intervening Server/Tunnel command is a coalescing barrier. A later
  // Tunnel Start must therefore enter the shared per-instance queue rather than
  // attach to a Start promise from an older intent generation.
  tunnelRestartInFlight.delete(name);
  const pending = enqueueTunnelCommand(name, async () => {
    const gateway = await enqueueRuntimeDeploy(() => ensureRuntimeAndServerUnlocked(name, { restartTarget: false }));
    if (!gateway.ok) {
      return { ...gateway, ok: false, tunnelStarted: false, preserved: true };
    }
    // Start is idempotent/non-destructive. A stale or unhealthy already-running
    // Tunnel is reported by startTunnelUnlocked and must be handled through the
    // explicit Restart action (or the dedicated boot health-recovery hook when
    // service is already unhealthy). Never turn Start into a surprise stop/start.
    const started = await enqueueTunnelLifecycle(name, () => startTunnelUnlocked(name));
    return started?.ok && started.alreadyRunning !== true
      ? { ...started, started: true, tunnelStarted: true }
      : started;
  });
  tunnelStartInFlight.set(name, pending);
  try {
    return await pending;
  } finally {
    if (tunnelStartInFlight.get(name) === pending) tunnelStartInFlight.delete(name);
  }
}

async function stopTunnel(name) {
  cancelledBootAutoStart.add(name);
  if (managerRestartInFlight) {
    return { ok: false, error: "Manager đang self-restart; từ chối bắt đầu Tunnel lifecycle mới." };
  }
  beginInstanceIntent(name, "tunnel:stop");
  // Stop is a command-order barrier. A later Start/Restart must queue after this
  // stop instead of coalescing onto an earlier still-settling operation.
  tunnelStartInFlight.delete(name);
  tunnelRestartInFlight.delete(name);
  return enqueueTunnelCommand(name, () => enqueueTunnelLifecycle(name, () => stopTunnelWithTrafficDrainUnlocked(name)));
}

async function preflightTunnelReplacementUnlocked(name, before = null) {
  const prior = before || await tunnelStatus(name);
  const preserved = prior.running === true;
  if (prior.running && !prior.owned) {
    return {
      ok: false,
      preserved,
      prior,
      error: `Refusing Tunnel restart: the current ${prior.kind || "tunnel"} process is not owned by Manager.`,
    };
  }
  if (prior.invalidConfig) {
    return { ok: false, preserved, prior, error: "OPENAI_TUNNEL_HEALTH_PORT is invalid; existing Tunnel was preserved." };
  }
  if (prior.portOccupied) {
    return { ok: false, preserved, prior, error: `Tunnel health port ${prior.healthPort} is occupied by another process; existing Tunnel was preserved.` };
  }

  // Re-check the Gateway after the global deploy lock was released. A source edit
  // in that small window must abort before stopTunnelUnlocked() touches the old tunnel.
  const serverState = await serverStatus(name);
  if (!serverState.running || !serverState.owned || serverState.configDrift || serverState.buildDrift || serverState.artifactDrift) {
    return {
      ok: false,
      preserved,
      prior,
      server: serverState,
      error: "Cannot replace Tunnel: the managed Gateway is not running on the exact current config/build generation; existing Tunnel was preserved.",
    };
  }

  if (prior.mode === "openai") {
    const client = await ensureTunnelClient();
    if (!client.ok) {
      return { ...client, ok: false, preserved, prior, error: `${client.error || "OpenAI Tunnel runtime preflight failed"}; existing Tunnel was preserved.` };
    }
    return { ok: true, prior, server: serverState, tunnelRuntime: client };
  }
  if (!fs.existsSync(CLOUDFLARED)) {
    return {
      ok: false,
      preserved,
      prior,
      error: "NO_CLOUDFLARED: replacement runtime is not installed; existing Tunnel was preserved.",
      hint: "Chưa có cloudflared — bấm 'Tải cloudflared' trong thẻ Tunnel.",
    };
  }
  return { ok: true, prior, server: serverState };
}

async function restorePriorHealthyTunnelUnlocked(name, prior, gatewayIdentity) {
  const eligible = Boolean(prior?.running && prior?.owned && !prior?.configDrift && !prior?.healthDrift);
  if (!eligible) return { ok: false, attempted: false, reason: "prior-tunnel-was-not-exact-healthy" };

  let last = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const current = await tunnelStatus(name);
    if (current.running) {
      if (current.owned && !current.configDrift && !current.healthDrift) {
        return { ok: true, attempted: true, restored: true, alreadyRunning: true, attempt, tunnel: current };
      }
      return {
        ok: false,
        attempted: true,
        restored: false,
        attempt,
        error: "Rollback refused because a Tunnel process is still present but exact healthy ownership is not proven.",
        tunnel: current,
      };
    }

    last = await startTunnelUnlocked(name, { rollbackGateway: gatewayIdentity });
    if (last.ok) return { ok: true, attempted: true, restored: true, attempt, tunnel: last };
    if (last.cleanupFailed) break;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    ok: false,
    attempted: true,
    restored: false,
    error: last?.error || "Tunnel rollback failed after replacement startup failure.",
    tunnel: last,
  };
}

async function restartTunnelUnlocked(name, before = null) {
  const prior = before || await tunnelStatus(name);
  const preflight = await preflightTunnelReplacementUnlocked(name, prior);
  if (!preflight.ok) {
    return {
      ...preflight,
      ok: false,
      restarted: false,
      preserved: prior.running === true,
      previousPid: prior.pid || null,
    };
  }
  let trafficDrain = { ok: true, admissionClosed: false, skipped: true, reason: "tunnel-not-running" };
  if (prior.running) {
    trafficDrain = await drainServerTrafficForDisruption(name, preflight.server);
    if (!trafficDrain.ok) {
      return {
        ...trafficDrain,
        ok: false,
        restarted: false,
        preserved: true,
        previousPid: prior.pid || null,
      };
    }
  }
  const rollbackGateway = {
    pid: preflight.server?.pid || null,
    loadedAt: preflight.server?.health?.instructions?.loaded_at || "",
  };
  const stopped = await stopTunnelUnlocked(name);
  if (!stopped.ok) {
    return finishTunnelDisruptionAdmission(name, preflight.server, trafficDrain, {
      ...stopped,
      restarted: false,
      preserved: (await tunnelStatus(name).catch(() => null))?.running === true,
      previousPid: prior.pid || null,
    });
  }
  const started = await startTunnelUnlocked(name);
  if (!started.ok) {
    const rollback = await restorePriorHealthyTunnelUnlocked(name, prior, rollbackGateway);
    return finishTunnelDisruptionAdmission(name, preflight.server, trafficDrain, {
      ...started,
      ok: false,
      restarted: false,
      preserved: rollback.ok === true,
      restored: rollback.ok === true,
      rollback,
      stop: stopped,
      previousPid: prior.pid || null,
      error: rollback.ok
        ? `${started.error || "Tunnel replacement failed"} Previous healthy Tunnel service was restored.`
        : `${started.error || "Tunnel replacement failed"} Rollback did not restore the previous healthy Tunnel service: ${rollback.error || rollback.reason || "unknown rollback failure"}`,
    });
  }
  return finishTunnelDisruptionAdmission(name, preflight.server, trafficDrain, {
    ...started,
    ok: true,
    restarted: true,
    preserved: false,
    previousMode: prior.mode,
    previousPid: prior.pid || null,
    stop: stopped,
  });
}

function isExactBootRecoveryTunnelGeneration(reference, current) {
  return Boolean(
    reference?.running
    && reference?.owned
    && reference?.kind === "openai"
    && reference?.healthDrift === true
    && reference?.configDrift !== true
    && reference?.ambiguous !== true
    && reference?.duplicateProcesses !== true
    && reference?.launchPidMatch === true
    && reference?.launchProcessStartedAtMatch === true
    && reference?.launchFingerprintMatch === true
    && reference?.runtimePathMatches === true
    && current?.running
    && current?.owned
    && current?.kind === "openai"
    && current?.healthDrift === true
    && current?.configDrift !== true
    && current?.ambiguous !== true
    && current?.duplicateProcesses !== true
    && current?.launchPidMatch === true
    && current?.launchProcessStartedAtMatch === true
    && current?.launchFingerprintMatch === true
    && current?.runtimePathMatches === true
    && Number(current?.pid) === Number(reference?.pid)
    && Number(current?.healthPort) === Number(reference?.healthPort)
    && String(current?.runtimePath || "") === String(reference?.runtimePath || "")
    && String(current?.runtimeIdentity || "") === String(reference?.runtimeIdentity || "")
  );
}

async function confirmBootTunnelHealthDrift(name, initial) {
  if (!isExactBootRecoveryTunnelGeneration(initial, initial)) {
    return {
      confirmed: false,
      reason: "exact-current-generation-not-proven",
      observation: initial,
    };
  }

  let observation = initial;
  for (let sample = 1; sample < BOOT_TUNNEL_HEALTH_CONFIRMATIONS; sample += 1) {
    await new Promise((resolve) => setTimeout(resolve, BOOT_TUNNEL_HEALTH_CONFIRM_INTERVAL_MS));
    if (managerRestartInFlight || cancelledBootAutoStart.has(name)) {
      return { confirmed: false, cancelled: true, reason: "lifecycle-cancelled", observation };
    }
    observation = await tunnelStatus(name);
    if (observation.running && observation.owned && !observation.configDrift && !observation.healthDrift) {
      return { confirmed: false, recovered: true, reason: "health-recovered", observation };
    }
    if (!isExactBootRecoveryTunnelGeneration(initial, observation)) {
      return { confirmed: false, reason: "generation-or-authority-changed", observation };
    }
  }
  return { confirmed: true, observation };
}

async function recoverTunnelForBoot(name) {
  if (managerRestartInFlight || cancelledBootAutoStart.has(name)) {
    return { ok: false, cancelled: true, error: "Bootstrap Tunnel recovery was cancelled by Manager restart or an explicit lifecycle action." };
  }
  return enqueueTunnelCommand(name, () => enqueueTunnelLifecycle(name, async () => {
    // Re-check after acquiring both the public command queue and lifecycle queue.
    // A manual Stop/Restart may have been queued between the supervisor's
    // shouldContinue() check and this operation; that explicit action must win and
    // must never be followed by a boot recovery that silently starts Tunnel again.
    if (managerRestartInFlight || cancelledBootAutoStart.has(name)) {
      return { ok: false, cancelled: true, error: "Bootstrap Tunnel recovery was cancelled before lifecycle execution." };
    }
    const current = await tunnelStatus(name);
    if (current.running && current.owned && !current.configDrift && !current.healthDrift) {
      return { ok: true, alreadyRunning: true, recovered: false, ...current };
    }
    if (!(current.running && current.owned && current.healthDrift && !current.configDrift)) {
      return {
        ok: false,
        error: "Bootstrap Tunnel recovery refused because exact-owned unhealthy state is no longer proven.",
        ...current,
      };
    }
    // One health snapshot is insufficient authority for an automatic stop->start:
    // Windows cold-start pressure or a brief tunnel readiness wobble can outlast
    // the bounded health probe. Confirm the SAME exact PID/CreationDate/fingerprint/
    // runtime generation stays unhealthy across independent observations before
    // crossing the destructive boundary. Explicit user Restart remains immediate.
    const confirmation = await confirmBootTunnelHealthDrift(name, current);
    if (!confirmation.confirmed) {
      if (confirmation.cancelled) {
        return { ok: false, cancelled: true, recovered: false, reason: confirmation.reason };
      }
      if (confirmation.recovered) {
        return { ok: true, alreadyRunning: true, recovered: false, reason: confirmation.reason, ...confirmation.observation };
      }
      return {
        ...confirmation.observation,
        ok: false,
        recovered: false,
        preserved: current.running === true,
        retryable: true,
        reason: confirmation.reason,
        error: "Bootstrap Tunnel recovery deferred because sustained exact-generation health drift was not proven; existing transport was preserved.",
      };
    }
    return restartTunnelUnlocked(name, confirmation.observation);
  }));
}

async function restartTunnelOnce(name, inFlightStart = null) {
  if (inFlightStart) {
    const startResult = await inFlightStart;
    if (startResult?.ok && startResult.started === true) {
      const [currentTunnel, currentGateway] = await Promise.all([
        tunnelStatus(name),
        serverStatus(name),
      ]);
      const sameTunnelGeneration = !Number.isInteger(startResult.pid)
        || Number(currentTunnel.pid) === Number(startResult.pid);
      const exactCurrent = Boolean(
        sameTunnelGeneration
        && currentTunnel.running
        && currentTunnel.owned
        && !currentTunnel.configDrift
        && !currentTunnel.healthDrift
        && currentGateway.running
        && currentGateway.owned
        && !currentGateway.configDrift
        && !currentGateway.buildDrift
        && !currentGateway.artifactDrift
      );
      if (exactCurrent) {
        return {
          ...startResult,
          ...currentTunnel,
          ok: true,
          restarted: true,
          coalescedInFlightStart: true,
          previousPid: null,
        };
      }
    }
  }

  // Prepare the shared Gateway generation first, while the existing Tunnel is
  // still untouched. The replacement preflight below re-checks for races after
  // this global build/deploy transaction releases its lock.
  const gateway = await enqueueRuntimeDeploy(() => ensureRuntimeAndServerUnlocked(name, { restartTarget: false }));
  if (!gateway.ok) {
    const prior = await tunnelStatus(name).catch(() => null);
    return {
      ...gateway,
      ok: false,
      restarted: false,
      preserved: prior?.running === true,
      previousPid: prior?.pid || null,
    };
  }
  return enqueueTunnelLifecycle(name, () => restartTunnelUnlocked(name));
}

async function restartTunnel(name) {
  cancelledBootAutoStart.add(name);
  if (managerRestartInFlight) {
    return { ok: false, restarted: false, error: "Manager đang self-restart; từ chối bắt đầu Tunnel lifecycle mới." };
  }

  // Coalesce only consecutive duplicate Restart intents. A Server command or a
  // different Tunnel command in between is a generation barrier even while the
  // older promise remains in flight.
  const intent = beginInstanceIntent(name, "tunnel:restart");
  const existing = intent.consecutiveSameType ? tunnelRestartInFlight.get(name) : null;
  if (existing) return await existing;

  // Only the immediately preceding Tunnel Start generation may satisfy this
  // Restart via coalescing. Never capture a stale Start separated by a Server
  // Stop/Start or another Tunnel lifecycle intent.
  const inFlightStart = intent.previousType === "tunnel:start"
    ? tunnelStartInFlight.get(name) || null
    : null;
  tunnelStartInFlight.delete(name);

  const pending = enqueueTunnelCommand(name, () => restartTunnelOnce(name, inFlightStart));
  tunnelRestartInFlight.set(name, pending);
  try {
    return await pending;
  } finally {
    if (tunnelRestartInFlight.get(name) === pending) tunnelRestartInFlight.delete(name);
  }
}

async function observeStaleConfigUnlocked(name) {
  if (managerRestartInFlight) {
    return { ok: true, changed: false, skipped: true, reason: "manager-restart" };
  }

  // Re-read after entering the per-instance command queue. Background drift
  // observation is deliberately NON-DESTRUCTIVE: a healthy serving generation
  // must never be stopped just because it became stale. Quiet-window heuristics
  // cannot make stop->start zero-gap; only an explicit lifecycle intent may cross
  // that destructive boundary. The observer therefore records maintenance need
  // and leaves the exact live PID/Tunnel untouched.
  const [serverBefore, tunnelBefore] = await Promise.all([
    serverStatus(name),
    tunnelStatus(name),
  ]);
  const pending = [];

  if (serverBefore.running && serverBefore.configDrift) {
    if (!serverBefore.owned) {
      return {
        ok: false,
        changed: false,
        blocked: true,
        stage: "server",
        error: `Local Coder Server '${name}' has stale configuration but exact Manager ownership is not proven.`,
      };
    }
    pending.push("server");
  }

  if (tunnelBefore.running && tunnelBefore.configDrift) {
    const safeOwnedTunnel = Boolean(
      tunnelBefore.owned
      && tunnelBefore.ambiguous !== true
      && tunnelBefore.duplicateProcesses !== true
      && tunnelBefore.kind !== "mixed"
    );
    if (!safeOwnedTunnel) {
      return {
        ok: false,
        changed: false,
        blocked: true,
        stage: "tunnel",
        error: `Tunnel '${name}' has stale configuration but exact, unambiguous Manager ownership is not proven.`,
        server: serverBefore,
        tunnel: tunnelBefore,
      };
    }
    pending.push("tunnel");
  }

  return {
    ok: true,
    changed: false,
    skipped: pending.length > 0,
    deferred: pending.length > 0,
    maintenanceRequired: pending.length > 0,
    stage: pending.length === 1 ? pending[0] : (pending.length > 1 ? "server+tunnel" : null),
    reason: pending.length > 0 ? "healthy-serving-generation-preserved" : "no-stale-serving-generation",
    pending,
    serverRestarted: false,
    tunnelRestarted: false,
    server: serverBefore,
    tunnel: tunnelBefore,
  };
}

async function observeStaleConfigOnce() {
  if (managerRestartInFlight) return;
  try {
    const names = await listInstances();
    for (const name of names) {
      if (managerRestartInFlight) return;
      if (staleConfigObserveInFlight.has(name)) continue;
      if ((staleConfigRetryAfter.get(name) || 0) > Date.now()) continue;

      let stale = false;
      try {
        const [server, tunnel] = await Promise.all([serverStatus(name), tunnelStatus(name)]);
        stale = Boolean(
          (server.running && server.configDrift)
          || (tunnel.running && tunnel.configDrift)
        );
      } catch (err) {
        staleConfigRetryAfter.set(name, Date.now() + STALE_CONFIG_RETRY_COOLDOWN_MS);
        console.warn(`[Drift] '${name}' scan failed: ${String(err?.message || err).slice(0, 300)}`);
        continue;
      }
      if (!stale) {
        staleConfigRetryAfter.delete(name);
        continue;
      }

      const pending = enqueueInstanceCommand(name, () => observeStaleConfigUnlocked(name));
      staleConfigObserveInFlight.set(name, pending);
      void pending.then((result) => {
        if (result?.maintenanceRequired) {
          staleConfigRetryAfter.set(name, Date.now() + STALE_CONFIG_RETRY_COOLDOWN_MS);
          console.warn(`[Drift] '${name}' maintenance pending (${(result.pending || []).join("+") || result.stage || "runtime"}); healthy serving generation preserved.`);
        }
        if (result?.ok === false) {
          staleConfigRetryAfter.set(name, Date.now() + STALE_CONFIG_RETRY_COOLDOWN_MS);
          console.warn(`[Drift] '${name}' stale configuration blocked: ${String(result.error || "unknown error").slice(0, 300)}`);
        } else if (!result?.maintenanceRequired) {
          staleConfigRetryAfter.delete(name);
        }
      }).catch((err) => {
        staleConfigRetryAfter.set(name, Date.now() + STALE_CONFIG_RETRY_COOLDOWN_MS);
        console.warn(`[Drift] '${name}' observation failed: ${String(err?.message || err).slice(0, 300)}`);
      }).finally(() => {
        if (staleConfigObserveInFlight.get(name) === pending) staleConfigObserveInFlight.delete(name);
      });
    }
  } catch (err) {
    console.warn(`[Drift] stale configuration scan failed: ${String(err?.message || err).slice(0, 300)}`);
  }
}

function startStaleConfigObserver() {
  if (staleConfigObserveTimer) return;
  void observeStaleConfigOnce();
  staleConfigObserveTimer = setInterval(() => {
    void observeStaleConfigOnce();
  }, STALE_CONFIG_OBSERVE_INTERVAL_MS);
  staleConfigObserveTimer.unref?.();
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
    const res = await runBoundedHelperProcess(CSC_PATH, ["/nologo", "/target:exe", `/out:${FOLDER_PICKER_EXE}`, FOLDER_PICKER_CS], {
      timeoutMs: 30000,
      maxOutputChars: HELPER_OUTPUT_MAX_CHARS,
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
      let timeoutCommitted = false;
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
        timeoutCommitted = true;
        void (async () => {
          if (child.pid) await killPidTree(child.pid);
          finish({ status: -1, stdout, stderr: appendBoundedTail(stderr, "\n[folder-picker timeout]", HELPER_OUTPUT_MAX_CHARS) });
        })();
      }, 180000);
      child.on("error", (e) => {
        if (timeoutCommitted) return;
        finish(null, e);
      });
      child.on("close", (code) => {
        if (timeoutCommitted) return;
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
  ["PROJECT_MEMORY_MAX_BYTES", 0, 0, 5000000],
  ["PROJECT_MEMORY_MAX_LINES", 0, 0, 10000],
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
      // Legacy hidden workspace aliases are no longer authority inputs. Keeping
      // them in managed .env would create invisible scope drift outside the UI.
      for (const obsoleteScopeKey of ["WORKSPACE_PATHS", "ALLOWED_WORKSPACE_PATHS"]) {
        if (Object.prototype.hasOwnProperty.call(env, obsoleteScopeKey)) updates[obsoleteScopeKey] = null;
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

  const workspaceScope = await validateManagedWorkspaceScope(env);
  push(
    workspaceScope.ok,
    "Workspace scope",
    workspaceScope.ok
      ? `Configured workspace roots: ${workspaceScope.roots.join("; ") || "(none)"}`
      : workspaceScope.error
  );

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

  const fda = (env.FULL_DISK_ACCESS ?? "false").toLowerCase();
  push(
    ["true", "false"].includes(fda),
    "FULL_DISK_ACCESS",
    fda === "true"
      ? "true — explicit trusted native full-machine mode"
      : "false — configured workspace roots; local process trees require AppContainer and fail closed when sandbox health is not proven"
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
      ? "dist/index.js is missing — Start/Restart will build before deployment"
      : buildState.sourceNewerThanBuild
        ? "Runtime source is newer than dist — Start/Restart will build before deployment"
        : "Compiled runtime is current with source"
  );

  // Compare the live process against the exact configuration being checked.
  // This matters for unsaved form overrides: a proposed WORKSPACE_PATH/PORT must
  // not be reported healthy merely because the on-disk .env still matches.
  const st = await serverStatus(name, env);
  push(
    !st.portOccupied && !st.invalidConfig && !st.configDrift && !st.artifactDrift && !st.buildDrift,
    "Server",
    st.running
      ? st.buildDrift
        ? `Running on port ${st.port}, but runtime source is newer than dist — build may be prepared non-disruptively; explicit Restart is required to load the new generation`
        : st.artifactDrift
        ? `Đang chạy trên cổng ${st.port}, nhưng dist/index.js mới hơn process — cần khởi động lại Local Coder Server`
        : st.configDrift
          ? `Đang chạy trên cổng ${st.port}, nhưng cấu hình process khác .env${st.workspaceDrift ? ` (workspace runtime: ${st.health?.workspace || "?"})` : ""} — cần restart`
          : `Đang chạy trên cổng ${st.port}`
      : st.invalidConfig
        ? "PORT không hợp lệ"
        : st.portOccupied
          ? `Cổng ${st.port} đang bị process khác chiếm${st.pid ? ` (PID ${st.pid})` : ""}`
          : `Chưa chạy (cổng ${st.port})`
  );
  const tun = await tunnelStatus(name, env);
  if (tun.running && tun.configDrift) {
    push(
      false,
      "Tunnel",
      tun.kind === "mixed"
        ? `Phát hiện đồng thời OpenAI tunnel-client và cloudflared (${tun.pids?.length || 2} process) — phải dừng trạng thái mixed trước khi khởi động lại Tunnel.`
        : tun.ambiguous
          ? `OpenAI Tunnel có ${tun.pids?.length || 2} process dùng cùng profile — phải dừng và khởi động lại để khôi phục ownership duy nhất.`
          : "Tunnel đang chạy với launch configuration khác cấu hình đang kiểm tra — cần restart Tunnel sau khi lưu."
    );
  } else if (tun.running && tun.healthDrift) {
    push(false, "Tunnel health", `OpenAI Tunnel process đúng launch identity nhưng health endpoint ${tun.healthPort} không phản hồi — cần kiểm tra/restart Tunnel.`);
  }
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
  let wsResolved;
  try {
    const ws = String(env.WORKSPACE_PATH || "").trim();
    wsResolved = {
      path: ws,
      exists: Boolean(ws) && (await fsp.stat(path.isAbsolute(ws) ? ws : path.resolve(ROOT, ws))).isDirectory(),
    };
  } catch {
    wsResolved = { path: String(env.WORKSPACE_PATH || "").trim(), exists: false };
  }
  const chk = includeCheck
    ? await checkConfig(name).catch((e) => ({ ok: false, items: [], error: String((e && e.message) || e) }))
    : null;
  // Tự phát hiện scope lỗi: bundle nào cũng kèm kết quả validate để UI hiển thị
  // ngay (ví dụ workspaceMissing) thay vì chỉ lộ ra lúc save/start.
  let workspaceScope;
  try {
    workspaceScope = await validateManagedWorkspaceScope(env);
  } catch (err) {
    workspaceScope = { ok: false, workspaceMissing: false, error: String((err && err.message) || err) };
  }
  return {
    name,
    node: process.version,
    workspaceMissing: !wsResolved.exists,
    workspaceScope: {
      ok: Boolean(workspaceScope.ok),
      workspaceMissing: workspaceScope.workspaceMissing === true,
      error: workspaceScope.error || "",
    },
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
      autoStart: config.autoStart === true,
      lastTunnelUrl: config.lastTunnelUrl || "",
    },
    server: srv,
    tunnel: tun,
    check: chk,
    installed,
  };
}

let instanceCreateChain = Promise.resolve();

function enqueueInstanceCatalogMutation(operation) {
  const run = instanceCreateChain.then(operation, operation);
  instanceCreateChain = run.then(() => undefined, () => undefined);
  return run;
}

function enqueueInstanceCreate(operation) {
  return enqueueInstanceCatalogMutation(operation);
}

function enqueueInstanceCatalogCommand(name, operation) {
  // Reserve both orders synchronously at command arrival. Acquiring only the
  // catalog queue first lets a later lifecycle command overtake while this
  // mutation waits for unrelated catalog work; acquiring only the instance queue
  // leaves create/rename publication races. The two tickets rendezvous without
  // either operation running until both turns are authoritative.
  let markInstanceTurn;
  let grantCatalogTurn;
  const instanceTurnReached = new Promise((resolve) => { markInstanceTurn = resolve; });
  const catalogTurnGranted = new Promise((resolve) => { grantCatalogTurn = resolve; });

  const instanceRun = enqueueInstanceCommand(name, async () => {
    markInstanceTurn();
    await catalogTurnGranted;
    return operation();
  });
  return enqueueInstanceCatalogMutation(async () => {
    await instanceTurnReached;
    grantCatalogTurn();
    return instanceRun;
  });
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
  const ws = String(body.workspacePath || "").trim();
  const workspaceScope = await validateManagedWorkspaceScope({ WORKSPACE_PATH: ws });
  if (!workspaceScope.ok) {
    return {
      ok: false,
      workspaceMissing: workspaceScope.workspaceMissing === true,
      error: workspaceScope.error,
    };
  }
  const inst = instPaths(name);
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
  // Publish a new instance transactionally. A valid-name directory is catalog
  // authority (`listInstances()` discovers it), so never create that directory
  // until every required authority file is complete. Hidden staging names cannot
  // match INSTANCE_NAME_RE and therefore remain invisible after a process crash.
  const stageDir = path.join(INSTANCES_DIR, `.creating-${name}-${randomUUID()}`);
  const stagedEnv = path.join(stageDir, ".env");
  const stagedConfig = path.join(stageDir, "config.json");
  await fsp.mkdir(stageDir, { recursive: false });
  try {
    await atomicWriteFile(stagedEnv, envText, "utf8");
    await writeJson(stagedConfig, {
      lastTunnelUrl: "",
      healthPort,
      autoStart: body.autoStart !== false,
    });
    // A serialized Manager create cannot race another Manager create, but an
    // out-of-band directory may still appear. rename() is the final atomic
    // catalog publication and must fail rather than merge/overwrite it.
    await fsp.rename(stageDir, inst.dir);
    return { ok: true, name, port, adminPort, healthPort, workspace: ws };
  } catch (err) {
    let cleanupError = null;
    if (fs.existsSync(stageDir)) {
      try {
        await recycleManagedDirectory(stageDir, INSTANCES_DIR);
      } catch (cleanupErr) {
        cleanupError = String(cleanupErr?.message || cleanupErr).slice(0, 400);
      }
    }
    return {
      ok: false,
      error: `Instance '${name}' was not published because transactional creation failed: ${String(err?.message || err).slice(0, 500)}`
        + (cleanupError ? `; hidden staging cleanup failed and was preserved for recovery: ${cleanupError}` : ""),
      published: false,
      stagingPreserved: Boolean(cleanupError),
    };
  }
}

async function createInstance(body) {
  // Port discovery and instance persistence must be one catalog transaction.
  // Otherwise concurrent creates can choose the same free port pair.
  return enqueueInstanceCreate(() => createInstanceUnlocked(body));
}

async function deleteInstanceUnlocked(name) {
  if (!INSTANCE_NAME_RE.test(name)) return { ok: false, error: "Tên không hợp lệ." };
  if (name === "default") return { ok: false, error: "Instance 'default' là mặc định, không xóa được." };
  const inst = instPaths(name);
  let configReadable = true;
  let configReadError = null;
  try {
    await readInstanceConfig(name);
  } catch (err) {
    configReadable = false;
    configReadError = err;
  }
  // Capture the exact managed PID before lifecycle teardown. Metadata must not be
  // recycled until that process is confirmed gone; otherwise a transient status
  // false-negative can orphan a still-running Local Coder child.
  const serverBeforeDelete = await serverStatus(name);
  const serverPidBeforeDelete = serverBeforeDelete.owned && Number.isSafeInteger(serverBeforeDelete.pid)
    ? serverBeforeDelete.pid
    : null;

  // Fail closed: never delete the only metadata/profile/PID files for a process
  // we failed to stop. Otherwise a transient lifecycle failure can turn a managed
  // server/tunnel into an orphan that the Manager can no longer identify safely.
  if (!configReadable) {
    const proof = await proveInstanceInactiveWithoutConfig(name, serverBeforeDelete);
    if (!proof.ok) {
      return {
        ok: false,
        error: `Config authority của '${name}' không đọc được (${String(configReadError?.message || configReadError)}); từ chối xóa vì chưa chứng minh instance hoàn toàn inactive: ${proof.error}`,
      };
    }
  } else {
    let tunnelStop;
    try {
      tunnelStop = await enqueueTunnelLifecycle(name, () => stopTunnelWithTrafficDrainUnlocked(name));
    } catch (err) {
      return { ok: false, error: `Không thể dừng Tunnel trước khi xóa '${name}': ${String(err?.message || err)}` };
    }
    if (!tunnelStop?.ok) {
      return { ok: false, error: `Không thể dừng Tunnel trước khi xóa '${name}': ${tunnelStop?.error || "unknown error"}` };
    }
  }

  let serverStop;
  try {
    serverStop = await enqueueRuntimeDeploy(() => enqueueServerLifecycle(name, () => stopServerUnlocked(name)));
  } catch (err) {
    return { ok: false, error: `Không thể dừng Server trước khi xóa '${name}': ${String(err?.message || err)}` };
  }
  if (!serverStop?.ok) {
    return { ok: false, error: `Không thể dừng Server trước khi xóa '${name}': ${serverStop?.error || "unknown error"}` };
  }

  if (serverPidBeforeDelete) {
    const exited = await waitFor(() => !isPidAlive(serverPidBeforeDelete), 5000, 100);
    if (!exited) {
      return {
        ok: false,
        error: `Từ chối xóa '${name}': managed Server PID ${serverPidBeforeDelete} vẫn còn sống sau stop; giữ nguyên metadata để retry an toàn.`,
        serverPid: serverPidBeforeDelete,
        serverPidExited: false,
      };
    }
  }

  const serverAfter = await serverStatus(name);
  const tunnelAfter = configReadable ? await tunnelStatus(name) : { running: false };
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
  return { ok: true, name, serverPid: serverPidBeforeDelete, serverPidExited: true };
}

async function deleteInstance(name) {
  if (!INSTANCE_NAME_RE.test(name)) return { ok: false, error: "Tên không hợp lệ." };
  if (name === "default") return { ok: false, error: "Instance 'default' là mặc định, không xóa được." };
  cancelledBootAutoStart.add(name);
  beginInstanceIntent(name, "instance:delete");
  // Deletion is a lifecycle barrier. Clear only coalescing ledgers; queued work
  // itself remains ordered and is never cancelled implicitly.
  serverStartInFlight.delete(name);
  serverRestartInFlight.delete(name);
  tunnelStartInFlight.delete(name);
  tunnelRestartInFlight.delete(name);
  // Catalog publication/removal and per-instance lifecycle share one order, but
  // ordering alone is not sufficient: a later Start queued behind Delete could
  // otherwise execute after the directory was recycled and recreate stale
  // authority through runtime defaults. Publish a tombstone synchronously before
  // yielding so every later admitted public mutation fails closed instead.
  const pending = enqueueInstanceCatalogCommand(name, () => deleteInstanceUnlocked(name));
  const marker = { type: "delete", pending };
  instanceCatalogMutationInFlight.set(name, marker);
  try {
    return await pending;
  } finally {
    if (instanceCatalogMutationInFlight.get(name) === marker) {
      instanceCatalogMutationInFlight.delete(name);
    }
  }
}

async function proveInstanceInactiveWithoutConfig(name, knownServerStatus = null) {
  const inst = instPaths(name);
  const env = await readInstanceEnv(name);
  const server = knownServerStatus || await serverStatus(name);
  if (server.running) {
    return { ok: false, error: `Server vẫn đang chạy trên PORT ${server.port || env.PORT || "?"}.` };
  }

  const savedTunnelPid = await readPidFile(inst.tunnelPid);
  if (savedTunnelPid && isPidAlive(savedTunnelPid)) {
    return { ok: false, error: `tunnel.pid còn trỏ tới PID sống ${savedTunnelPid}.` };
  }

  const serverPort = Number(env.PORT || 0);
  const [rawOpenAiCandidates, rawCloudflareCandidates] = await Promise.all([
    processesWithCmdLineAsync("tunnel-client.exe", inst.profile),
    Number.isInteger(serverPort) && serverPort > 0 && serverPort < 65536
      ? processesWithCmdLineAsync("cloudflared.exe", `localhost:${serverPort}`)
      : Promise.resolve([]),
  ]);
  const openAiCandidates = rawOpenAiCandidates.filter((process) => isPidAlive(process.pid));
  if (openAiCandidates.length > 0) {
    return { ok: false, error: `còn tunnel-client candidate theo exact profile (${openAiCandidates.map((p) => p.pid).join(",")}).` };
  }

  const cloudflareCandidates = rawCloudflareCandidates.filter((process) => isPidAlive(process.pid));
  if (cloudflareCandidates.length > 0) {
    return { ok: false, error: `còn cloudflared candidate cho PORT ${serverPort} (${cloudflareCandidates.map((p) => p.pid).join(",")}).` };
  }

  const healthPort = Number(env.OPENAI_TUNNEL_HEALTH_PORT || 0);
  if (Number.isInteger(healthPort) && healthPort > 0 && healthPort < 65536 && await isPortOpen(healthPort)) {
    return { ok: false, error: `tunnel health port ${healthPort} vẫn đang listen; ownership không thể chứng minh an toàn khi config hỏng.` };
  }
  return { ok: true };
}

async function renameInstanceUnlocked(name, body) {
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
  const srv = await serverStatus(name);
  let tun = null;
  try {
    tun = await tunnelStatus(name);
  } catch (err) {
    const proof = await proveInstanceInactiveWithoutConfig(name, srv);
    if (!proof.ok) {
      return {
        ok: false,
        error: `Không thể đọc config/tunnel authority để đổi tên '${name}' (${String(err?.message || err)}); ${proof.error}`,
      };
    }
  }
  if (srv.running || tun?.running) {
    return { ok: false, error: "Phải dừng Server và Tunnel trước khi đổi tên workspace." };
  }
  const src = instPaths(name);
  const dst = instPaths(newName);
  await fsp.mkdir(INSTANCES_DIR, { recursive: true });
  try {
    // Windows can keep a recently-stopped process/log/AV handle briefly alive
    // after lifecycle liveness is already false. Treat only known sharing/access
    // failures as transient; all other rename errors still fail immediately.
    await retryTransientFsMutation(() => fsp.rename(src.dir, dst.dir), {
      attempts: 8,
      baseDelayMs: 150,
    });
  } catch (err) {
    return { ok: false, error: "Đổi tên thất bại: " + String((err && err.message) || err) };
  }
  return { ok: true, name: newName, renamed: true };
}

async function renameInstance(name, body) {
  if (!INSTANCE_NAME_RE.test(name)) return { ok: false, error: "Tên không hợp lệ." };
  if (name === "default") return { ok: false, error: "Instance 'default' là instance mặc định, không đổi tên được." };
  const newName = String(body.name || "").trim().toLowerCase();
  if (!INSTANCE_NAME_RE.test(newName)) {
    return { ok: false, error: "Tên mới: 2–32 ký tự, chỉ chữ thường/số/gạch ngang, bắt đầu bằng chữ hoặc số." };
  }
  if (newName === name) return { ok: true, name, renamed: false };
  cancelledBootAutoStart.add(name);
  beginInstanceIntent(name, "instance:rename");
  const pending = enqueueInstanceCatalogCommand(name, () => renameInstanceUnlocked(name, body));
  const marker = { type: "rename", pending };
  instanceCatalogMutationInFlight.set(name, marker);
  try {
    return await pending;
  } finally {
    if (instanceCatalogMutationInFlight.get(name) === marker) {
      instanceCatalogMutationInFlight.delete(name);
    }
  }
}

async function saveInstanceEnvUnlocked(name, body) {
  const inst = instPaths(name);
  const original = await readInstanceEnvRaw(name);
  const originalValues = parseDotEnv(original);
  let next;
  if (typeof body.raw === "string") {
    next = restoreMaskedRawEnv(body.raw, originalValues);
    next = serializeDotEnv({ MCP_SESSION_RECOVERY: null, CHATGPT_AUTO_APPROVE: null, WORKSPACE_PATHS: null, ALLOWED_WORKSPACE_PATHS: null }, next);
  } else {
    const values = { ...(body.values || {}) };
    delete values.MCP_SESSION_RECOVERY;
    delete values.CHATGPT_AUTO_APPROVE;
    delete values.WORKSPACE_PATHS;
    delete values.ALLOWED_WORKSPACE_PATHS;
    if (!(body.values && Object.prototype.hasOwnProperty.call(body.values, "ADMIN_PORT"))) {
      if (originalValues.ADMIN_PORT) values.ADMIN_PORT = originalValues.ADMIN_PORT;
    }
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) values[key] = null;
      else if (value === MASK_SENTINEL && isSecretKey(key)) values[key] = originalValues[key] !== undefined ? originalValues[key] : null;
    }
    next = serializeDotEnv({ ...values, MCP_SESSION_RECOVERY: null, CHATGPT_AUTO_APPROVE: null, WORKSPACE_PATHS: null, ALLOWED_WORKSPACE_PATHS: null }, original);
  }

  const parsed = parseDotEnv(next);
  const workspaceScope = await validateManagedWorkspaceScope(parsed);
  if (!workspaceScope.ok) {
    return {
      ok: false,
      workspaceMissing: workspaceScope.workspaceMissing === true,
      error: workspaceScope.error,
    };
  }
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
    const managedPid = await readPidFile(inst.serverPid);
    const oldPortPid = await pidOnPort(oldPort);
    const legacyOwnedOldListener = Boolean(managedPid && oldPortPid === managedPid && isPidAlive(managedPid));
    if (isLocalCoderHealth(oldHealth, originalValues, name, { allowLegacy: legacyOwnedOldListener })) {
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

  // `.env` and config.healthPort form one logical mutation. Prove the auxiliary
  // config authority is readable before committing `.env`; otherwise a corrupt
  // config could make the API return failure after silently changing runtime
  // configuration. A later I/O race is handled by rolling `.env` back below.
  try {
    await readInstanceConfig(name);
  } catch (err) {
    return {
      ok: false,
      error: `Cannot save instance environment while config authority is unreadable: ${String(err?.message || err).slice(0, 500)}`,
      committed: false,
    };
  }

  await atomicWriteFile(inst.env, next, "utf8");
  try {
    await updateInstanceConfig(name, (config) => {
      config.healthPort = hp;
      if (typeof body.autoStart === "boolean") config.autoStart = body.autoStart;
    });
  } catch (err) {
    let rollbackError = null;
    try {
      await atomicWriteFile(inst.env, original, "utf8");
    } catch (restoreErr) {
      rollbackError = String(restoreErr?.message || restoreErr).slice(0, 500);
    }
    return {
      ok: false,
      error: `Config health-port sync failed after .env write: ${String(err?.message || err).slice(0, 500)}`
        + (rollbackError ? `; .env rollback also failed: ${rollbackError}` : "; .env was rolled back to its exact previous bytes."),
      committed: false,
      rollbackFailed: Boolean(rollbackError),
    };
  }
  return { ok: true, path: inst.env };
}

function restoreMaskedRawEnv(raw, originalValues) {
  return String(raw)
    .split(/\r?\n/)
    .map((line) => {
      const m = ENV_LINE_RE.exec(line.trim());
      if (!m || m[2].trim() !== MASK_SENTINEL || !isSecretKey(m[1])) return line;
      const orig = originalValues[m[1]];
      // The sentinel means "preserve an existing secret", never "set the
      // literal secret to eight stars". Match the structured-values branch:
      // when no prior secret exists, keep the key empty rather than inventing
      // a credential that will fail later in a less obvious place.
      return orig !== undefined ? `${m[1]}=${orig}` : `${m[1]}=`;
    })
    .join("\n");
}

async function checkConfigRequest(name, body) {
  if (typeof body?.raw !== "string") return checkConfig(name, body?.values);
  const originalValues = await readInstanceEnv(name);
  const candidateRaw = restoreMaskedRawEnv(body.raw, originalValues);
  return checkConfig(name, parseDotEnv(candidateRaw));
}

async function saveInstanceEnv(name, body) {
  const file = instPaths(name).env;
  beginInstanceIntent(name, "instance:config");
  // Config bytes and lifecycle reads form one per-instance order. This prevents
  // Start/Restart from observing half of a save transaction or a save from
  // changing authority while a lifecycle preflight is still consuming it.
  return enqueueInstanceCommand(
    name,
    () => enqueueFileMutation(file, () => saveInstanceEnvUnlocked(name, body))
  );
}

async function saveInstanceConfig(name, body) {
  beginInstanceIntent(name, "instance:config");
  // config.json participates in the same runtime authority transaction as .env.
  // In particular autoStart and tunnel metadata must not race Delete/Rename or a
  // lifecycle command that is reading/updating the same instance authority.
  return enqueueInstanceCommand(name, () => updateInstanceConfig(name, (config) => {
    if (typeof body.lastTunnelUrl === "string") config.lastTunnelUrl = body.lastTunnelUrl;
    if (typeof body.autoStart === "boolean") config.autoStart = body.autoStart;
  }));
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

function defaultInstanceNameForAdmission() {
  try {
    const names = [];
    for (const entry of fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !INSTANCE_NAME_RE.test(entry.name)) continue;
      names.push(entry.name);
      if (names.length > MAX_MANAGED_INSTANCES) {
        throw new Error(`Managed instances exceed hard cap ${MAX_MANAGED_INSTANCES}`);
      }
    }
    names.sort();
    return names.includes("default") ? "default" : names[0] || null;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function handleApi(req, res, url, body, instanceAdmission = null) {
  const p = url.pathname;
  // An admitted mutation may reach routing after a preceding Delete/Rename has
  // already published its catalog tombstone (or even after it removed/moved the
  // directory). Surface that exact stale-authority condition before generic
  // list/existence guards can collapse it into a misleading 404. The catalog
  // mutation itself does not see its own marker here because it publishes the
  // tombstone only when its ordered dispatch turn begins below.
  if (instanceAdmission?.name) {
    const conflict = catalogMutationConflict(instanceAdmission.name);
    if (conflict) return json(res, 200, conflict);
  }
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
          config: { autoStart: false, lastTunnelUrl: "" },
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
    const dispatchInstanceMutation = (operation) =>
      instanceAdmission?.name === name
        ? instanceAdmission.dispatch(() => catalogMutationConflict(name) || operation())
        : operation();

    if (req.method === "POST" && sub === "") return json(res, 200, await instanceBundle(name, { includeCheck: true }));
    if (req.method === "DELETE" && sub === "") return json(res, 200, await dispatchInstanceMutation(() => deleteInstance(name)));
    if (req.method === "POST" && sub === "/rename") return json(res, 200, await dispatchInstanceMutation(() => renameInstance(name, body)));

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
    if (req.method === "PUT" && sub === "/env") return json(res, 200, await dispatchInstanceMutation(() => saveInstanceEnv(name, body)));

    if (req.method === "GET" && sub === "/config") {
      return json(res, 200, { ok: true, ...publicInstanceConfig(await readInstanceConfig(name)) });
    }
    if (req.method === "PUT" && sub === "/config") {
      const config = await dispatchInstanceMutation(() => saveInstanceConfig(name, body));
      return json(res, 200, { ok: true, config: publicInstanceConfig(config) });
    }

    if (req.method === "POST" && sub === "/check") return json(res, 200, await checkConfigRequest(name, body));

    if (req.method === "POST" && sub === "/server/start") return json(res, 200, await dispatchInstanceMutation(() => startServer(name)));
    if (req.method === "POST" && sub === "/server/stop") return json(res, 200, await dispatchInstanceMutation(() => stopServer(name)));
    if (req.method === "POST" && sub === "/server/restart") return json(res, 200, await dispatchInstanceMutation(() => restartServer(name)));

    if (req.method === "POST" && sub === "/tunnel/start") return json(res, 200, await dispatchInstanceMutation(() => startTunnel(name)));
    if (req.method === "POST" && sub === "/tunnel/stop") return json(res, 200, await dispatchInstanceMutation(() => stopTunnel(name)));
    if (req.method === "POST" && sub === "/tunnel/restart") return json(res, 200, await dispatchInstanceMutation(() => restartTunnel(name)));

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
  const dname = instanceAdmission?.legacyDefault === true
    ? instanceAdmission.name
    : await defaultInstanceName();
  const dispatchDefaultMutation = (operation) =>
    instanceAdmission?.legacyDefault === true && instanceAdmission.name === dname
      ? instanceAdmission.dispatch(() => catalogMutationConflict(dname) || operation())
      : operation();
  // Do NOT gate the rest of the API on a default instance. Instance-dependent
  // legacy aliases are already rejected by the no-instance guard above, while
  // Manager-global routes below (/health, /autostart, /manager/restart,
  // /profiles, /install, /tunnel/download) must remain usable on a fresh install
  // with zero workspaces. A catch-all `if (!dname) return ...` here used to
  // shadow those routes and made exact Manager health identity disappear.

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
    return json(res, 200, await dispatchDefaultMutation(() => saveInstanceEnv(dname, body)));
  }

  if (req.method === "GET" && p === "/api/config") {
    return json(res, 200, { ok: true, ...publicInstanceConfig(await readInstanceConfig(dname)) });
  }

  if (req.method === "PUT" && p === "/api/config") {
    const config = await dispatchDefaultMutation(() => saveInstanceConfig(dname, body));
    return json(res, 200, { ok: true, config: publicInstanceConfig(config) });
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
      delete values.WORKSPACE_PATHS;
      delete values.ALLOWED_WORKSPACE_PATHS;
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
    return json(res, 200, await checkConfigRequest(dname, body));
  }

  if (req.method === "POST" && p === "/api/server/start") {
    return json(res, 200, await dispatchDefaultMutation(() => startServer(dname)));
  }

  if (req.method === "POST" && p === "/api/server/stop") {
    return json(res, 200, await dispatchDefaultMutation(() => stopServer(dname)));
  }

  if (req.method === "POST" && p === "/api/server/restart") {
    return json(res, 200, await dispatchDefaultMutation(() => restartServer(dname)));
  }

  if (req.method === "POST" && p === "/api/tunnel/start") {
    return json(res, 200, await dispatchDefaultMutation(() => startTunnel(dname)));
  }

  if (req.method === "POST" && p === "/api/tunnel/stop") {
    return json(res, 200, await dispatchDefaultMutation(() => stopTunnel(dname)));
  }

  if (req.method === "POST" && p === "/api/tunnel/restart") {
    return json(res, 200, await dispatchDefaultMutation(() => restartTunnel(dname)));
  }
  if (req.method === "POST" && p === "/api/manager/restart") {
    return json(res, 200, await requestManagerRestart());
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
      const state = await inspectAutostartLink();
      return json(res, 200, {
        ok: true,
        enabled: state.valid,
        exists: state.exists,
        drift: state.exists && !state.valid,
        reason: state.reason,
        lnk: STARTUP_LNK,
      });
    }
    if (req.method === "POST") {
      const enable = Boolean(body && body.enabled);
      try {
        const state = await reconcileAutostartWithLauncher(enable);
        return json(res, 200, {
          ok: true,
          enabled: state.valid,
          exists: state.exists,
          drift: state.exists && !state.valid,
          reason: state.reason,
          synchronized: true,
        });
      } catch (err) {
        return json(res, 500, {
          ok: false,
          error: "Autostart synchronization failed: " + String((err && err.message) || err).slice(-500),
        });
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
      boot_id: getManagerBootId(),
      mcp_public_contract: await publicContractFingerprint(),
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
  // Self-restart handoff: --restart <token> do manager cũ spawn. Token phải
  // khớp file restart đang chờ thì bản mới mới được quyền đợi cổng nhả ra.
  // File để nguyên (inert sau khi dùng) — không xóa, tránh destructive op.
  const restartArgIndex = process.argv.indexOf("--restart");
  const restartToken = restartArgIndex >= 0 ? process.argv[restartArgIndex + 1] : null;
  let restartPending = null;
  if (restartToken) {
    try {
      const pending = JSON.parse(await fsp.readFile(MANAGER_RESTART_FILE, "utf8"));
      if (!pending || pending.token !== restartToken) {
        console.error(`[Manager] --restart token không khớp file đang chờ — từ chối khởi động.`);
        process.exit(1);
      }
      restartPending = pending;
    } catch {
      console.error(`[Manager] Không đọc được file restart (${MANAGER_RESTART_FILE}) — từ chối khởi động.`);
      process.exit(1);
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      if (url.pathname.startsWith("/api/")) {
        const mutatingMethod = ["POST", "PUT", "DELETE", "PATCH"].includes(req.method);
        const restartRequest = req.method === "POST" && url.pathname === "/api/manager/restart";
        const trackMutation = mutatingMethod && !restartRequest;
        if (trackMutation && managerRestartInFlight) {
          return json(res, 409, {
            ok: false,
            retryable: true,
            error: "Manager đang self-restart; mutation mới bị từ chối cho tới khi handoff settle.",
          });
        }
        const mutationId = trackMutation ? ++managerMutationSequence : null;
        // Reserve direct and legacy-default per-instance mutation order before any
        // asynchronous body parsing. The reservation is released as soon as that
        // request registers its intent + command promise, not when the potentially
        // long command ends. Both API surfaces therefore share one instance order.
        const instanceAdmission = trackMutation
          ? reserveDirectInstanceMutationAdmission(req, url) || reserveLegacyDefaultMutationAdmission(req, url)
          : null;
        if (trackMutation) {
          activeManagerMutations.set(mutationId, {
            method: req.method,
            path: url.pathname,
            startedAt: new Date().toISOString(),
          });
        }
        try {
          const body = mutatingMethod ? await readBody(req) : {};
          await handleApi(req, res, url, body, instanceAdmission);
        } finally {
          // Invalid/nonexistent routes may never dispatch an admitted mutation.
          // Releasing here is idempotent and prevents a malformed request from
          // permanently blocking later valid commands for the same instance.
          instanceAdmission?.release();
          if (trackMutation) activeManagerMutations.delete(mutationId);
        }
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

  httpServer = server;

  if (restartToken) {
    // Signal only after all pre-listen initialization above completed. The old
    // Manager refuses to exit until this exact replacement PID proves it reached
    // the handoff-ready point and persisted the receipt atomically.
    await atomicWriteFile(
      MANAGER_RESTART_FILE,
      JSON.stringify({
        ...restartPending,
        state: "prepared",
        replacementPid: process.pid,
        preparedAt: Date.now(),
      }),
      "utf8"
    );
  }

  async function listenWithRetry(port, noOpen, restartToken) {
    const deadline = Date.now() + MANAGER_RESTART_RETRY_MS;
    for (;;) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (err) => {
            server.off("listening", onListening);
            reject(err);
          };
          const onListening = () => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(port, "127.0.0.1");
        });
        return;
      } catch (err) {
        if (err && err.code === "EADDRINUSE") {
          if (restartToken && Date.now() < deadline) {
            // Manager cũ đang nhả cổng trong lúc self-restart — chờ rồi thử lại.
            await new Promise((r) => setTimeout(r, 400));
            continue;
          }
          const existingManager = await managerHealth(port);
          if (existingManager) {
            console.log(`[Manager] Cổng ${port} đã có Local Coder Manager chạy — mở http://127.0.0.1:${port}`);
            if (!noOpen) openExternal(`http://127.0.0.1:${port}`);
            process.exit(0);
          }
          console.error(`[Manager] Cổng ${port} đang bị process khác chiếm; không coi đó là Local Coder Manager.`);
          process.exit(1);
        }
        console.error("[Manager] Lỗi:", (err && err.message) || err);
        process.exit(1);
      }
    }
  }

  await listenWithRetry(port, noOpen, restartToken);
  if (restartToken) {
    // The old Manager exits only after this exact replacement proves it owns the
    // canonical control-plane listener. This closes the prepared-but-not-bound
    // handoff window without requiring two Managers to bind the same port.
    await atomicWriteFile(
      MANAGER_RESTART_FILE,
      JSON.stringify({
        ...restartPending,
        token: restartToken,
        state: "listening",
        replacementPid: process.pid,
        listeningAt: Date.now(),
      }),
      "utf8"
    );
  }
  console.log("");
  console.log("=== Quản Lý ChatGPT Local Coder (multi-instance) ===");
  console.log(`Manager UI:  http://127.0.0.1:${port}`);
  console.log(`Repo root:   ${ROOT}`);
  console.log(`Instances:   ${INSTANCES_DIR}`);
  console.log("");
  startManagedLogMaintenance();
  if (!noOpen) openExternal(`http://127.0.0.1:${port}`);

  // Bootstrap autoStart as a bounded supervisor, not a one-shot serial loop.
  // Keep this detached from manager HTTP startup so one slow Windows cold-start
  // cannot block the dashboard or another independent instance. Explicit Stop /
  // Restart cancels pending boot retries for that instance for this manager run.
  const autoStartNames = await listInstances();
  void autoStartInstances(autoStartNames, {
    concurrency: DEFAULT_AUTO_START_CONCURRENCY,
    readConfig: readInstanceConfig,
    startServer,
    startTunnel,
    recoverTunnel: recoverTunnelForBoot,
    shouldContinue: async (name) => !managerRestartInFlight && !cancelledBootAutoStart.has(name),
    log: (line) => console.log(line),
  }).then((results) => {
    const failed = results.filter((result) => !result.ok);
    if (failed.length > 0) {
      console.warn(`[Auto] bootstrap completed with ${failed.length}/${results.length} instance(s) still unavailable.`);
    }
  }).catch((err) => {
    console.error(`[Auto] bootstrap supervisor failed: ${String((err && err.message) || err).slice(0, 300)}`);
  }).finally(() => {
    // Bootstrap handles the initial desired state. Afterwards continuously
    // observe stale configuration on already-running Server/Tunnel processes.
    // Healthy serving generations are preserved; maintenance requires explicit Restart.
    startStaleConfigObserver();
  });
}

main();
