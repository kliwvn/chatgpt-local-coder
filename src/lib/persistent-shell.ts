import { spawn } from "child_process";
import path from "path";
import { appendBoundedTail, SHELL_OUTPUT_MAX_CHARS } from "./output-budget.js";

export interface ShellExecResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  output_max_chars?: number;
}

import {
  loadGlobalShellState,
  saveGlobalShellSnapshot,
} from "./global-shell-state.js";

let sessionCwd: string | null = null;
let sessionInitializedAt: string | null = null;
let persistenceRoot: string | null = null;
let bootstrapRoot: string | null = null;
let bootstrapPromise: Promise<void> | null = null;
let shellPersistenceTail: Promise<void> = Promise.resolve();
const history: string[] = [];
const MAX_HISTORY = 50;

export function setShellPersistenceRoot(workspaceRoot: string): void {
  persistenceRoot = path.resolve(workspaceRoot);
}

export function initShellSession(defaultCwd: string): void {
  sessionCwd = path.resolve(defaultCwd);
  sessionInitializedAt = new Date().toISOString();
  history.length = 0;
}

/** Restore cwd from disk (ChatGPT = new MCP session per tool call). */
export async function bootstrapShellSession(defaultCwd: string): Promise<void> {
  setShellPersistenceRoot(defaultCwd);
  const saved = await loadGlobalShellState(defaultCwd, defaultCwd);
  if (saved?.cwd) {
    sessionCwd = path.resolve(saved.cwd);
    sessionInitializedAt = saved.updated_at;
    if (saved.recent_commands?.length) {
      history.length = 0;
      history.push(...saved.recent_commands.slice(-MAX_HISTORY));
    }
    return;
  }
  initShellSession(defaultCwd);
}

/**
 * Bootstrap persistent shell state once per process/workspace. ChatGPT may create
 * a new MCP transport for nearly every tool call; re-reading disk state on every
 * transport can race with a live command and overwrite the singleton cwd/history
 * with an older snapshot.
 */
export function ensureShellBootstrap(defaultCwd: string): Promise<void> {
  const resolved = path.resolve(defaultCwd);
  if (bootstrapPromise && bootstrapRoot === resolved) return bootstrapPromise;
  bootstrapRoot = resolved;
  bootstrapPromise = bootstrapShellSession(resolved).catch((err) => {
    if (bootstrapRoot === resolved) {
      bootstrapRoot = null;
      bootstrapPromise = null;
    }
    throw err;
  });
  return bootstrapPromise;
}

export function getShellCwd(): string {
  if (!sessionCwd) throw new Error("Shell session not initialized");
  return sessionCwd;
}

export function resetShellSession(cwd: string): void {
  sessionCwd = path.resolve(cwd);
  sessionInitializedAt = new Date().toISOString();
  scheduleShellSnapshot();
}

function scheduleShellSnapshot(): void {
  if (!persistenceRoot || !sessionCwd) return;
  const root = persistenceRoot;
  const cwd = sessionCwd;
  const recent = [...history];
  const write = saveGlobalShellSnapshot(root, cwd, recent);
  shellPersistenceTail = write.then(() => undefined, () => undefined);
  void write.catch((err) => {
    console.error("[Shell] Failed to persist shell state:", err instanceof Error ? err.message : String(err));
  });
}

export async function flushShellPersistence(): Promise<void> {
  await shellPersistenceTail;
}

export function getShellStatus() {
  return {
    active: sessionCwd !== null,
    cwd: sessionCwd,
    started_at: sessionInitializedAt,
    recent_commands: [...history].slice(-10),
  };
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function resolveCdTarget(current: string, target: string): string {
  const cleaned = stripQuotes(target);
  if (cleaned === "-" || cleaned === "~") return current;
  return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(current, cleaned);
}

/** Cập nhật cwd khi gặp cd / Set-Location ở đầu command (giống Bash persistent). */
export function applyCwdDirectives(currentCwd: string, command: string): { cwd: string; command: string; changed: boolean } {
  let cwd = currentCwd;
  let rest = command.trim();
  let changed = false;

  for (let i = 0; i < 8; i++) {
    const psMatch = rest.match(/^(?:Set-Location|sl)\s+(.+?)(?:\s*;\s*|\s*&&\s*|$)/i);
    if (psMatch) {
      cwd = resolveCdTarget(cwd, psMatch[1]);
      changed = true;
      rest = rest.slice(psMatch[0].length).trim();
      continue;
    }

    const cdMatch = rest.match(/^cd(?:\s+(.+?))?(?:\s*;\s*|\s*&&\s*|$)/i);
    if (cdMatch) {
      if (cdMatch[1]) cwd = resolveCdTarget(cwd, cdMatch[1]);
      changed = true;
      rest = rest.slice(cdMatch[0].length).trim();
      continue;
    }

    const pushdMatch = rest.match(/^pushd\s+(.+?)(?:\s*;\s*|\s*&&\s*|$)/i);
    if (pushdMatch) {
      cwd = resolveCdTarget(cwd, pushdMatch[1]);
      changed = true;
      rest = rest.slice(pushdMatch[0].length).trim();
      continue;
    }

    break;
  }

  return { cwd, command: rest || "pwd", changed };
}

function runOnce(command: string, cwd: string, timeoutMs: number): Promise<ShellExecResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ShellExecResult>();
  const shell = process.platform === "win32" ? "powershell.exe" : "bash";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
  const child = spawn(shell, args, { cwd, windowsHide: true, env: process.env });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  let settled = false;
  let forceSettleTimer: ReturnType<typeof setTimeout> | undefined;

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (forceSettleTimer) clearTimeout(forceSettleTimer);
    fn();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    // Giết cả process tree — child process con (npm test, node script) không bị bỏ lại
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref();
    } else {
      child.kill("SIGKILL");
    }
    // Usually the child emits close promptly after tree-kill. Bound the rare OS
    // edge where it never does so a timed-out run_command cannot hang forever.
    forceSettleTimer = setTimeout(() => {
      settle(() => reject(new Error(`Command timed out after ${timeoutMs / 1000}s`)));
    }, 1500);
    forceSettleTimer.unref?.();
  }, timeoutMs);
  timer.unref?.();

  child.stdout.on("data", (d: string) => {
    const next = appendBoundedTail(stdout, d, SHELL_OUTPUT_MAX_CHARS, stdoutTruncated);
    stdout = next.text;
    stdoutTruncated = next.truncated;
  });
  child.stderr.on("data", (d: string) => {
    const next = appendBoundedTail(stderr, d, SHELL_OUTPUT_MAX_CHARS, stderrTruncated);
    stderr = next.text;
    stderrTruncated = next.truncated;
  });
  child.on("close", (code) => {
    settle(() => {
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
        return;
      }
      resolve({
        command,
        cwd,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exit_code: code,
        timed_out: false,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        output_max_chars: SHELL_OUTPUT_MAX_CHARS,
      });
    });
  });
  child.on("error", (err) => settle(() => reject(err)));
  return promise;
}

/**
 * Chạy command trong shell session bền vững: cwd thay đổi qua `cd` được giữ
 * giữa các lần gọi khi command có `cd`/`Set-Location`/`pushd`. `workingDirectory`
 * chỉ là one-off execution cwd và không đổi persistent cwd.
 */
export async function execInShellSession(
  command: string,
  defaultCwd: string,
  timeoutMs: number,
  workingDirectory?: string
): Promise<ShellExecResult> {
  if (!sessionCwd) initShellSession(defaultCwd);

  const baseCwd = workingDirectory ? path.resolve(workingDirectory) : sessionCwd!;
  const { cwd, command: effective, changed } = applyCwdDirectives(baseCwd, command);
  // Explicit workingDirectory is intentionally one-off. Only an explicit cwd
  // directive mutates process-wide persistent cwd. Apply that mutation before
  // spawn so the newest invocation wins regardless of completion order.
  if (changed) sessionCwd = cwd;

  history.push(effective);
  if (history.length > MAX_HISTORY) history.shift();
  scheduleShellSnapshot();

  const result = await runOnce(effective, cwd, timeoutMs);
  return result;
}
