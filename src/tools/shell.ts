import type { ChildProcessWithoutNullStreams } from "child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { requireCommandAllowed } from "../lib/permissions.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { classifyCommandOutcome } from "../lib/command-outcome.js";
import { toolResult } from "../lib/tool-result.js";
import { envBoundedInteger } from "../lib/env-utils.js";
import { clampSyncTimeoutMs, getSyncResponseBudgetMs } from "../lib/sync-response-budget.js";
import {
  execInShellSession,
  getShellStatus,
  resetShellSession,
} from "../lib/persistent-shell.js";
import { spawnProcess, type ProcessHandle } from "../lib/process-executor.js";

interface ManagedProcess {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  child: ChildProcessWithoutNullStreams;
  processHandle: ProcessHandle;
  stdout: ManagedLogBuffer;
  stderr: ManagedLogBuffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  finishedAt: number | null;
  spawnError?: string;
}

interface ManagedLogBuffer {
  chunks: string[];
  chars: number;
}

const processes = new Map<string, ManagedProcess>();
const MAX_LOG_CHARS = envBoundedInteger("PROCESS_LOG_MAX_CHARS", 200_000, 4_096, 2_000_000);
const MAX_FINISHED_PROCESSES = envBoundedInteger("PROCESS_HISTORY_MAX", 32, 1, 1_000);
const MAX_RUNNING_PROCESSES = envBoundedInteger("PROCESS_MAX_RUNNING", 16, 1, 128);
let managedProcessShutdownStarted = false;

function newLogBuffer(): ManagedLogBuffer {
  return { chunks: [], chars: 0 };
}

function appendLog(buffer: ManagedLogBuffer, data: Buffer | string): void {
  let text = typeof data === "string" ? data : data.toString();
  if (!text) return;
  if (text.length >= MAX_LOG_CHARS) {
    text = text.slice(-MAX_LOG_CHARS);
    buffer.chunks = [text];
    buffer.chars = text.length;
    return;
  }
  buffer.chunks.push(text);
  buffer.chars += text.length;
  while (buffer.chars > MAX_LOG_CHARS && buffer.chunks.length > 0) {
    const excess = buffer.chars - MAX_LOG_CHARS;
    const first = buffer.chunks[0];
    if (first.length <= excess) {
      buffer.chunks.shift();
      buffer.chars -= first.length;
      continue;
    }
    buffer.chunks[0] = first.slice(excess);
    buffer.chars -= excess;
    break;
  }
}

function logTail(buffer: ManagedLogBuffer, maxChars: number): string {
  if (buffer.chars <= maxChars) return buffer.chunks.join("");
  let remaining = maxChars;
  const out: string[] = [];
  for (let i = buffer.chunks.length - 1; i >= 0 && remaining > 0; i--) {
    const chunk = buffer.chunks[i];
    if (chunk.length <= remaining) {
      out.unshift(chunk);
      remaining -= chunk.length;
    } else {
      out.unshift(chunk.slice(-remaining));
      remaining = 0;
    }
  }
  return out.join("");
}

function isRunning(item: ManagedProcess): boolean {
  return item.finishedAt === null;
}

function pruneFinishedProcesses(): void {
  const finished = [...processes.values()]
    .filter((item) => !isRunning(item))
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  while (finished.length > MAX_FINISHED_PROCESSES) {
    const item = finished.shift();
    if (item) processes.delete(item.id);
  }
}

function markFinished(item: ManagedProcess, code: number | null, signal: NodeJS.Signals | null): void {
  if (item.finishedAt !== null) return;
  item.exitCode = code;
  item.signal = signal;
  item.finishedAt = Date.now();
  pruneFinishedProcesses();
}

async function killProcessTree(item: ManagedProcess, force = true): Promise<boolean> {
  if (!item.child.pid || !isRunning(item)) return false;
  try {
    return await item.processHandle.terminate(force);
  } catch {
    return false;
  }
}

export function getManagedProcessStats(): Record<string, number> {
  let running = 0;
  let finished = 0;
  for (const item of processes.values()) {
    if (isRunning(item)) running++;
    else finished++;
  }
  return {
    total: processes.size,
    running,
    finished,
    max_running: MAX_RUNNING_PROCESSES,
    max_finished: MAX_FINISHED_PROCESSES,
    max_log_chars_per_stream: MAX_LOG_CHARS,
  };
}

export async function shutdownManagedProcesses(): Promise<void> {
  managedProcessShutdownStarted = true;
  const running = [...processes.values()].filter(isRunning);
  await Promise.allSettled(running.map((item) => killProcessTree(item, true)));
  const deadline = Date.now() + 2000;
  while (running.some(isRunning) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  pruneFinishedProcesses();
}

export function registerShellTools(server: McpServer, defaultCwd: string, timeoutSec: number): void {
  server.registerTool(
    "run_command",
    {
      title: "Run Command",
      description:
        "Run shell commands to verify work (tests, build, lint). Cwd persists across ChatGPT tool calls (saved to disk). Use shell_status to check cwd. Use start_process for long jobs.",
      inputSchema: {
        command: z.string(),
        working_directory: z.string().optional().describe("One-off isolated cwd; does not mutate or enter persistent shell cwd/history"),
      },

      annotations: toolAnnotations("command"),
    },
    async ({ command, working_directory }) => {
      requireCommandAllowed(command);
      const cwdOverride = working_directory ? await validatePath(working_directory) : undefined;
      const configuredTimeoutMs = timeoutSec * 1000;
      const effectiveTimeoutMs = clampSyncTimeoutMs(configuredTimeoutMs);
      const result = await execInShellSession(command, defaultCwd, effectiveTimeoutMs, cwdOverride);
      const commandOutcome = classifyCommandOutcome(
        command,
        result.exit_code,
        result.stderr,
        result.timed_out
      );
      const response = {
        ...result,
        command_outcome: commandOutcome,
        configured_timeout_ms: configuredTimeoutMs,
        effective_timeout_ms: effectiveTimeoutMs,
        sync_response_budget_ms: getSyncResponseBudgetMs(),
      };
      await audit({
        tool: "run_command",
        action: "command",
        target: result.cwd,
        status: commandOutcome === "failed" ? "error" : "ok",
        details: { command, exit_code: result.exit_code, command_outcome: commandOutcome },
      });
      return toolResult("run_command", response, {
        ok: commandOutcome !== "failed",
        summary:
          commandOutcome === "no_match"
            ? `no matches (git grep exit ${result.exit_code}) in ${result.cwd}`
            : `exit ${result.exit_code} in ${result.cwd}`,
      });
    }
  );

  server.registerTool(
    "shell_status",
    {
      title: "Shell Status",
      description: "Show persistent shell session cwd and recent commands.",
      inputSchema: {},

      annotations: toolAnnotations("read"),
    },
    async () => {
      const status = getShellStatus();
      return toolResult("shell_status", status, { summary: `cwd: ${status.cwd}` });
    }
  );

  server.registerTool(
    "shell_reset",
    {
      title: "Shell Reset",
      description: "Reset persistent shell cwd to a directory (default: workspace).",
      inputSchema: { path: z.string().optional() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: dirPath }) => {
      const cwd = dirPath ? await validatePath(dirPath) : defaultCwd;
      resetShellSession(cwd);
      return toolResult("shell_reset", { cwd }, { summary: `shell cwd reset to ${cwd}` });
    }
  );

  server.registerTool(
    "start_process",
    {
      title: "Start Background Process",
      description: "Start a long-running command in the background. Use process_output/process_status/stop_process afterwards.",
      inputSchema: { command: z.string(), working_directory: z.string().optional() },

      annotations: toolAnnotations("command"),
    },
    async ({ command, working_directory }) => {
      if (managedProcessShutdownStarted) throw new Error("Gateway is shutting down; cannot start a background process");
      pruneFinishedProcesses();
      const runningCount = [...processes.values()].filter(isRunning).length;
      if (runningCount >= MAX_RUNNING_PROCESSES) {
        throw new Error(`Background process capacity reached (${runningCount}/${MAX_RUNNING_PROCESSES})`);
      }
      requireCommandAllowed(command);
      const cwd = await validatePath(working_directory ? working_directory : getShellStatus().cwd || defaultCwd);
      const shell = process.platform === "win32" ? "powershell.exe" : "bash";
      const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
      const processHandle = await spawnProcess({
        executable: shell,
        args,
        cwd,
        env: process.env,
        detached: process.platform !== "win32",
      });
      const child = processHandle.child;
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const item: ManagedProcess = {
        id,
        command,
        cwd,
        startedAt: new Date().toISOString(),
        child,
        processHandle,
        stdout: newLogBuffer(),
        stderr: newLogBuffer(),
        exitCode: null,
        signal: null,
        finishedAt: null,
      };
      processes.set(id, item);
      child.stdout.on("data", (d: Buffer) => appendLog(item.stdout, d));
      child.stderr.on("data", (d: Buffer) => appendLog(item.stderr, d));
      child.on("error", (err) => {
        item.spawnError = err.message;
        appendLog(item.stderr, `[spawn error] ${err.message}\n`);
        if (item.finishedAt === null) markFinished(item, -1, null);
      });
      child.on("exit", (code, signal) => {
        markFinished(item, code, signal);
      });
      child.on("close", (code, signal) => {
        markFinished(item, code, signal);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const onSpawn = () => {
            child.off("error", onError);
            resolve();
          };
          const onError = (err: Error) => {
            child.off("spawn", onSpawn);
            reject(err);
          };
          child.once("spawn", onSpawn);
          child.once("error", onError);
        });
      } catch (err) {
        processes.delete(id);
        throw new Error(`Failed to start background process: ${err instanceof Error ? err.message : String(err)}`);
      }
      await audit({
        tool: "start_process",
        action: "start",
        target: cwd,
        status: "ok",
        details: { id, command, sandboxed: processHandle.sandboxed, sandbox_backend: processHandle.backend },
      });
      return toolResult("start_process", {
        id,
        pid: child.pid,
        command,
        cwd,
        started_at: item.startedAt,
        sandboxed: processHandle.sandboxed,
        sandbox_backend: processHandle.backend,
      }, {
        summary: `started ${id}`,
      });
    }
  );

  server.registerTool(
    "process_status",
    {
      title: "Process Status",
      description: "Show status of background process(es).",
      inputSchema: { id: z.string().optional() },

      annotations: toolAnnotations("read"),
    },
    async ({ id }) => {
      const processes_list = [...processes.values()]
        .filter((p) => !id || p.id === id)
        .map((p) => ({
          id: p.id,
          pid: p.child.pid,
          command: p.command,
          cwd: p.cwd,
          started_at: p.startedAt,
          running: isRunning(p),
          exit_code: p.exitCode,
          signal: p.signal,
          error: p.spawnError,
          sandboxed: p.processHandle.sandboxed,
          sandbox_backend: p.processHandle.backend,
        }));
      return toolResult("process_status", { processes: processes_list }, { summary: `${processes_list.length} process(es)` });
    }
  );

  server.registerTool(
    "process_output",
    {
      title: "Process Output",
      description: "Read stdout/stderr logs for a background process.",
      inputSchema: {
        id: z.string(),
        tail_chars: z.number().int().positive().max(200000).optional().default(40000),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ id, tail_chars }) => {
      const item = processes.get(id);
      if (!item) throw new Error(`Unknown process id: ${id}`);
      const data = {
        id,
        running: isRunning(item),
        exit_code: item.exitCode,
        signal: item.signal,
        error: item.spawnError,
        stdout: logTail(item.stdout, tail_chars),
        stderr: logTail(item.stderr, tail_chars),
      };
      return toolResult("process_output", data, { summary: `output for ${id}` });
    }
  );

  server.registerTool(
    "stop_process",
    {
      title: "Stop Process",
      description: "Stop a background process by id.",
      inputSchema: { id: z.string(), force: z.boolean().optional().default(false) },

      annotations: toolAnnotations("edit"),
    },
    async ({ id, force }) => {
      const item = processes.get(id);
      if (!item) throw new Error(`Unknown process id: ${id}`);
      if (!isRunning(item)) {
        return toolResult("stop_process", { id, already_exited: true }, { summary: `${id} already exited` });
      }
      const sent = await killProcessTree(item, force);
      await audit({ tool: "stop_process", action: "stop", target: item.cwd, status: "ok", details: { id, force } });
      return toolResult("stop_process", { id, force, sent }, { summary: `stop sent to ${id}` });
    }
  );

  server.registerTool(
    "clear_processes",
    {
      title: "Clear Finished Processes",
      description: "Remove finished process records from memory.",
      inputSchema: {},

      annotations: toolAnnotations("edit"),
    },
    async () => {
      let cleared = 0;
      for (const [id, item] of processes) {
        if (!isRunning(item)) {
          processes.delete(id);
          cleared++;
        }
      }
      return toolResult("clear_processes", { cleared }, { summary: `cleared ${cleared}` });
    }
  );
}