import path from "path";
import { appendBoundedTail, SHELL_OUTPUT_MAX_CHARS } from "./output-budget.js";
import { redactSensitiveText } from "./redaction.js";
import { requireCommandAllowed } from "./permissions.js";
import { existsSync } from "node:fs";
import { validatePath } from "./path-security.js";
import { spawnProcess } from "./process-executor.js";

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
let nextStateSequence = 0;
let latestCommittedStateSequence = 0;

function reserveStateSequence(): number {
  nextStateSequence += 1;
  return nextStateSequence;
}

function commitStateSequence(sequence: number): void {
  if (sequence > latestCommittedStateSequence) latestCommittedStateSequence = sequence;
}

export function setShellPersistenceRoot(workspaceRoot: string): void {
  persistenceRoot = path.resolve(workspaceRoot);
}

export function initShellSession(defaultCwd: string): void {
  const sequence = reserveStateSequence();
  sessionCwd = path.resolve(defaultCwd);
  sessionInitializedAt = new Date().toISOString();
  history.length = 0;
  commitStateSequence(sequence);
}

/** Restore cwd from disk (ChatGPT = new MCP session per tool call). */
export async function bootstrapShellSession(defaultCwd: string): Promise<void> {
  const sequence = reserveStateSequence();
  setShellPersistenceRoot(defaultCwd);
  const saved = await loadGlobalShellState(defaultCwd, defaultCwd);
  if (saved?.cwd) {
    try {
      // Persisted cwd is broker state, but it may have been written under an old
      // workspace policy. Re-validate it against the current roots before reuse.
      sessionCwd = await validatePath(saved.cwd);
      sessionInitializedAt = saved.updated_at;
      if (saved.recent_commands?.length) {
        history.length = 0;
        history.push(...saved.recent_commands.slice(-MAX_HISTORY));
      }
      commitStateSequence(sequence);
      return;
    } catch {
      // Policy tightened or the saved directory disappeared. Never resurrect a
      // cwd outside the current workspace; reset to the configured default.
    }
  }
  sessionCwd = path.resolve(defaultCwd);
  sessionInitializedAt = new Date().toISOString();
  history.length = 0;
  commitStateSequence(sequence);
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
  const sequence = reserveStateSequence();
  sessionCwd = path.resolve(cwd);
  sessionInitializedAt = new Date().toISOString();
  history.length = 0;
  commitStateSequence(sequence);
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
    recent_commands: [...history].slice(-10).map((command) => redactSensitiveText(command)),
    history_scope: "default_shell_only",
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

async function runOnce(command: string, cwd: string, timeoutMs: number): Promise<ShellExecResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ShellExecResult>();
  // spawn() reports a missing cwd as "spawn powershell.exe ENOENT", hiding the
  // real cause; fail fast with an actionable message instead.
  if (!existsSync(cwd)) {
    return Promise.reject(new Error(`shell cwd does not exist: ${cwd}`));
  }
  const shell = process.platform === "win32" ? "powershell.exe" : "bash";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
  // The sync response deadline starts BEFORE spawn() so slow spawns (Windows AV
  // scanning can stall powershell.exe ~2.5-3s) count against the budget. The
  // MCP response is resolved AT the deadline; child-tree cleanup (taskkill)
  // continues in the background and must not delay the response.
  const startedAt = Date.now();
  const handle = await spawnProcess({
    executable: shell,
    args,
    cwd,
    env: process.env,
    timeoutMs,
  });
  const child = handle.child;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  let settled = false;

  const timedOutResult = (): ShellExecResult => ({
    command,
    cwd,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exit_code: null,
    timed_out: true,
    stdout_truncated: stdoutTruncated,
    stderr_truncated: stderrTruncated,
    output_max_chars: SHELL_OUTPUT_MAX_CHARS,
  });

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn();
  };

  const handleTimeout = () => {
    timedOut = true;
    // Central executor owns process-tree termination. In strict mode the broker
    // owns a KILL_ON_JOB_CLOSE Job Object; there is no native fallback.
    void handle.terminate(true);
    // Resolve at the deadline, not after tree-kill settles. Detach the child
    // handle so a slow kill can never pin shutdown; stray pipe writes after
    // the deadline are discarded by the no-op error listeners below. (Pipes
    // stay attached: this is a long-running server, and buffered output from
    // an already-killed child is drained by the close event, not by detach.)
    child.unref();
    settle(() => resolve(timedOutResult()));
  };

  const remaining = timeoutMs - (Date.now() - startedAt);
  const timer: NodeJS.Timeout | undefined =
    remaining > 0
      ? setTimeout(handleTimeout, remaining)
      : (queueMicrotask(handleTimeout), undefined);
  timer?.unref?.();

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
  // After a timed-out detach the pipes can EPIPE or EIO; never let that crash
  // the server. Output is already discarded past the deadline.
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  child.on("close", (code) => {
    settle(() => {
      if (timedOut) {
        resolve(timedOutResult());
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
  // Defense in depth: every future/internal caller of the persistent shell must
  // pass the same destructive-command guard before cwd/history mutation or spawn.
  requireCommandAllowed(command);
  if (!sessionCwd) initShellSession(defaultCwd);

  const isolated = Boolean(workingDirectory);
  // Reserve ordering before the first await. A reset/bootstrap or a newer shell
  // invocation that commits state while this call is validating/spawning must
  // remain authoritative even if this older call resumes later.
  const stateSequence = isolated ? 0 : reserveStateSequence();
  const baseCwd = await validatePath(isolated ? path.resolve(workingDirectory!) : sessionCwd!);
  const parsed = applyCwdDirectives(baseCwd, command);
  let cwd: string;
  try {
    // Defense in depth for cd / Set-Location / pushd. The OS sandbox remains the
    // hard boundary, but persistent shell state must never store an escaped cwd.
    cwd = await validatePath(parsed.cwd);
  } catch (error) {
    throw new Error(
      `SHELL_CWD_OUTSIDE_SANDBOX: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const effective = parsed.command;
  const changed = parsed.changed;

  // An explicit workingDirectory is a fully isolated one-off invocation: cwd
  // directives inside it affect only that child process, and its command/history
  // never enters the process-wide default shell state. This prevents concurrent
  // agents/workspaces sharing one Gateway from contaminating each other's shell
  // cwd/history. Calls without workingDirectory retain the legacy persistent-shell
  // behavior for interactive use.
  if (!isolated) {
    if (stateSequence > latestCommittedStateSequence) {
      if (changed) sessionCwd = cwd;
      history.push(effective);
      if (history.length > MAX_HISTORY) history.shift();
      commitStateSequence(stateSequence);
      scheduleShellSnapshot();
    }
  }

  const result = await runOnce(effective, cwd, timeoutMs);
  return result;
}
