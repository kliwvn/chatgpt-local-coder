import { spawn } from "child_process";
import os from "os";
import { appendBoundedHead, appendBoundedTail } from "./output-budget.js";

const GIT_SNAPSHOT_TIMEOUT_MS = 5_000;
const GIT_SNAPSHOT_STDOUT_MAX_CHARS = 32_768;
const GIT_SNAPSHOT_STDERR_MAX_CHARS = 16_384;

interface GitRunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

function runGit(args: string[], cwd: string): Promise<GitRunResult> {
  const { promise, resolve } = Promise.withResolvers<GitRunResult>();
  const child = spawn("git", args, {
    cwd,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let settled = false;
  let timedOut = false;
  let forceSettleTimer: NodeJS.Timeout | null = null;
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (forceSettleTimer) clearTimeout(forceSettleTimer);
    fn();
  };
  const result = (code: number): GitRunResult => ({
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exit_code: code,
    timed_out: timedOut,
    stdout_truncated: stdoutTruncated,
    stderr_truncated: stderrTruncated,
  });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.unref();
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    } else {
      child.kill("SIGKILL");
    }
    forceSettleTimer = setTimeout(() => settle(() => resolve(result(124))), 1_000);
    forceSettleTimer.unref?.();
  }, GIT_SNAPSHOT_TIMEOUT_MS);
  timer.unref?.();

  child.stdout.on("data", (d: Buffer) => {
    const next = appendBoundedHead(stdout, d.toString(), GIT_SNAPSHOT_STDOUT_MAX_CHARS, stdoutTruncated);
    stdout = next.text;
    stdoutTruncated = next.truncated;
  });
  child.stderr.on("data", (d: Buffer) => {
    const next = appendBoundedTail(stderr, d.toString(), GIT_SNAPSHOT_STDERR_MAX_CHARS, stderrTruncated);
    stderr = next.text;
    stderrTruncated = next.truncated;
  });
  child.on("close", (code) => settle(() => resolve(result(timedOut ? 124 : (code ?? 1)))));
  child.on("error", () => settle(() => resolve({
    ...result(127),
    stdout: "",
    stderr: "git not found",
  })));
  return promise;
}

export interface GitSnapshot {
  is_repo: boolean;
  branch?: string;
  status_short?: string;
  recent_commits?: string[];
  error?: string;
}

export async function collectGitSnapshot(cwd: string): Promise<GitSnapshot> {
  const root = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (root.exit_code !== 0) {
    return {
      is_repo: false,
      error: root.timed_out
        ? `git repository probe timed out after ${GIT_SNAPSHOT_TIMEOUT_MS}ms`
        : root.stderr || "not a git repository",
    };
  }

  const [branch, status, log] = await Promise.all([
    runGit(["branch", "--show-current"], cwd),
    runGit(["status", "--short", "--branch"], cwd),
    runGit(["log", "-3", "--oneline", "--no-decorate"], cwd),
  ]);

  return {
    is_repo: true,
    branch: branch.timed_out ? "(git branch probe timed out)" : branch.stdout || "(detached)",
    status_short: status.timed_out
      ? `[git status timed out after ${GIT_SNAPSHOT_TIMEOUT_MS}ms]${status.stdout ? `\n${status.stdout.slice(0, 1100)}` : ""}`
      : `${status.stdout.slice(0, 1200)}${status.stdout_truncated ? "\n… [git status output truncated]" : ""}`,
    recent_commits: log.timed_out
      ? [`[git log timed out after ${GIT_SNAPSHOT_TIMEOUT_MS}ms]`]
      : log.stdout ? log.stdout.split("\n").filter(Boolean) : [],
  };
}

export function formatGitSnapshotForInstructions(snapshot: GitSnapshot): string {
  if (!snapshot.is_repo) {
    return "## Git\nNot a git repository at WORKSPACE_PATH (or git unavailable).";
  }

  const lines = [
    "## Git (auto-loaded like Claude Code)",
    `Branch: ${snapshot.branch}`,
    "Status:",
    snapshot.status_short || "(clean)",
  ];
  if (snapshot.recent_commits?.length) {
    lines.push("Recent commits:", ...snapshot.recent_commits.map((c) => `- ${c}`));
  }
  return lines.join("\n");
}

export function formatEnvironmentForInstructions(opts: {
  workspaceRoot: string;
  workspaceRoots: string[];
  pid: number;
  adminPort: number;
  nodeVersion: string;
}): string {
  return [
    "## Environment",
    `Platform: ${process.platform} ${os.release()} (${os.arch()})`,
    `Node: ${opts.nodeVersion}`,
    `MCP PID: ${opts.pid}`,
    `Default cwd (WORKSPACE_PATH): ${opts.workspaceRoot}`,
    `Admin UI: http://127.0.0.1:${opts.adminPort}/ui`,
    opts.workspaceRoots.length > 1
      ? `Additional workspace roots:\n${opts.workspaceRoots.slice(1).map((r) => `- ${r}`).join("\n")}`
      : "",
    "Relative paths resolve from default cwd. Use absolute paths when working outside it.",
  ]
    .filter(Boolean)
    .join("\n");
}