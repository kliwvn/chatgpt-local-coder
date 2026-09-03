import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile } from "../manager/fs-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.join(root, "manager", "state");
const logDir = path.join(stateDir, "logs");
const lockDir = path.join(stateDir, "manager-start.lock");
const lockOwnerFile = path.join(lockDir, "owner.json");
const statusLog = path.join(logDir, "manager-start.log");
const managerStdout = path.join(logDir, "manager-console.log");
const managerStderr = path.join(logDir, "manager-console.err.log");
const START_WAIT_MS = 15_000;
const RESTART_WAIT_MS = 30_000;
const LOCK_STALE_MS = 30_000;
const POLL_MS = 100;

const port = Number(process.argv[2] || 3300);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  console.error(`[LOI] Invalid Manager port: ${process.argv[2] || ""}`);
  process.exit(2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readOwner() {
  try {
    const parsed = JSON.parse(await fsp.readFile(lockOwnerFile, "utf8"));
    return {
      pid: Number(parsed?.pid),
      token: typeof parsed?.token === "string" ? parsed.token : "",
      started_at: Number(parsed?.started_at),
    };
  } catch (err) {
    if (err?.code === "ENOENT" || err instanceof SyntaxError) return null;
    throw err;
  }
}

async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(700),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const value = await response.json();
    if (value?.ok !== true || value?.name !== "chatgpt-local-coder-manager") return null;
    const pid = Number(value?.pid);
    return Number.isSafeInteger(pid) && pid > 0 ? value : null;
  } catch {
    return null;
  }
}

function exactManagerProcess(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  if (process.platform !== "win32") return true;
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!fs.existsSync(powershell)) return false;
  const script = [
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}' -ErrorAction SilentlyContinue`,
    `if (-not $p) { exit 1 }`,
    `if ($p.Name -notmatch '^node(\\.exe)?$') { exit 1 }`,
    `if ($p.CommandLine -notmatch 'manager[\\\\/]server\\.mjs') { exit 1 }`,
    `exit 0`,
  ].join("; ");
  const result = spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    timeout: 3000,
  });
  return !result.error && result.status === 0;
}

async function requestRestartIfDrifted(live) {
  if (live?.artifactDrift !== true) return live;
  if (!exactManagerProcess(Number(live.pid))) {
    throw new Error(`Manager health PID ${live.pid} failed exact process ownership proof`);
  }
  const oldPid = Number(live.pid);
  const deadline = Date.now() + RESTART_WAIT_MS;
  let requested = false;
  while (Date.now() < deadline) {
    const current = await health();
    if (current && Number(current.pid) !== oldPid && current.artifactDrift !== true) return current;
    if (!requested) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/manager/restart`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(5000),
        });
        const body = await response.json().catch(() => ({}));
        if (response.ok && body?.ok === true) {
          requested = true;
        } else if (body?.retryable === true || /khởi động lại rồi|self-restart|restart/i.test(String(body?.error || ""))) {
          await sleep(200);
          continue;
        } else {
          throw new Error(`Manager self-restart rejected: ${String(body?.error || response.status).slice(0, 500)}`);
        }
      } catch (err) {
        const currentAfterError = await health();
        if (currentAfterError && Number(currentAfterError.pid) !== oldPid && currentAfterError.artifactDrift !== true) {
          return currentAfterError;
        }
        if (err?.name !== "AbortError" && err?.name !== "TimeoutError") throw err;
      }
    }
    await sleep(POLL_MS);
  }
  const final = await health();
  if (final && Number(final.pid) !== oldPid && final.artifactDrift !== true) return final;
  throw new Error(`Manager artifact drift restart did not converge within ${RESTART_WAIT_MS}ms`);
}

async function writeStatus(text) {
  await fsp.mkdir(logDir, { recursive: true });
  await atomicWriteFile(statusLog, `${new Date().toISOString()} ${String(text).trim()}\n`, "utf8");
}

async function release(owner) {
  try {
    const current = await readOwner();
    if (!current || current.pid !== owner.pid || current.token !== owner.token) return;
    await fsp.rm(lockDir, { recursive: true, force: true });
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

async function acquireOrJoin() {
  await fsp.mkdir(stateDir, { recursive: true });
  const deadline = Date.now() + START_WAIT_MS;

  while (Date.now() < deadline) {
    const live = await health();
    if (live && live.artifactDrift !== true) return { joined: true, health: live, owner: null };

    try {
      await fsp.mkdir(lockDir);
      const owner = { pid: process.pid, token: randomUUID(), started_at: Date.now() };
      await atomicWriteFile(lockOwnerFile, `${JSON.stringify(owner)}\n`, "utf8");
      return { joined: false, health: null, owner };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }

    let stat;
    try {
      stat = await fsp.stat(lockDir);
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }
    const owner = await readOwner();
    const ageMs = Math.max(0, Date.now() - Number(stat.mtimeMs || 0));
    const ownerDead = Boolean(owner?.pid) && !processIsAlive(owner.pid);
    const ownerMissingTooLong = !owner && ageMs >= 2000;
    if (ownerDead || ownerMissingTooLong || ageMs >= LOCK_STALE_MS) {
      try {
        await fsp.rm(lockDir, { recursive: true, force: true });
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
      continue;
    }
    await sleep(POLL_MS);
  }

  const final = await health();
  if (final && final.artifactDrift !== true) return { joined: true, health: final, owner: null };
  throw new Error("Manager startup single-flight timed out before a healthy Manager appeared");
}

async function spawnManager() {
  await fsp.mkdir(logDir, { recursive: true });
  const outFd = fs.openSync(managerStdout, "a");
  const errFd = fs.openSync(managerStderr, "a");
  let child;
  try {
    child = spawn(process.execPath, ["manager/server.mjs", "--no-open"], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", outFd, errFd],
      env: process.env,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const pid = Number(child.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Manager spawn returned no valid PID");
  child.unref();
  return pid;
}

async function waitHealthy(expectedPid) {
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    const live = await health();
    if (live && live.artifactDrift !== true) {
      if (expectedPid && Number(live.pid) !== expectedPid) {
        return { ...live, coalesced: true };
      }
      return live;
    }
    if (expectedPid && !processIsAlive(expectedPid)) {
      throw new Error(`Manager PID ${expectedPid} exited before health became ready`);
    }
    await sleep(POLL_MS);
  }
  const final = await health();
  if (final && final.artifactDrift !== true) return final;
  throw new Error(`Manager did not become healthy within ${START_WAIT_MS}ms`);
}

async function main() {
  const initial = await health();
  if (initial) {
    if (!exactManagerProcess(Number(initial.pid))) {
      throw new Error(`Manager health PID ${initial.pid} failed exact process ownership proof`);
    }
    const current = await requestRestartIfDrifted(initial);
    await writeStatus(`OK already-running pid=${current.pid}${Number(current.pid) !== Number(initial.pid) ? ` restarted-from=${initial.pid}` : ""}`);
    console.log(`[OK] Manager already healthy: PID ${current.pid}`);
    return;
  }

  const claim = await acquireOrJoin();
  if (claim.joined) {
    if (!exactManagerProcess(Number(claim.health.pid))) {
      throw new Error(`Joined Manager health PID ${claim.health.pid} failed exact process ownership proof`);
    }
    await writeStatus(`OK joined pid=${claim.health.pid}`);
    console.log(`[OK] Manager startup joined existing owner: PID ${claim.health.pid}`);
    return;
  }

  try {
    const afterLock = await health();
    if (afterLock) {
      await writeStatus(`OK appeared-after-lock pid=${afterLock.pid}`);
      console.log(`[OK] Manager became healthy before spawn: PID ${afterLock.pid}`);
      return;
    }

    const pid = await spawnManager();
    const live = await waitHealthy(pid);
    await writeStatus(`OK spawned=${pid} healthy=${live.pid}${live.coalesced ? " coalesced=true" : ""}`);
    console.log(`[OK] Manager healthy: PID ${live.pid}`);
  } finally {
    await release(claim.owner);
  }
}

main().catch(async (err) => {
  const detail = String(err?.stack || err?.message || err).slice(-8000);
  try { await writeStatus(`FAIL ${detail}`); } catch {}
  console.error(`[LOI] Manager startup failed: ${detail}`);
  process.exitCode = 1;
});
