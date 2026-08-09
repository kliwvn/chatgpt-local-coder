import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { readUtf8FileBounded } from "./bounded-file.js";
import { appendBoundedTail } from "./output-budget.js";
import { globToRegExp, matchesCompiledGlob } from "./glob-match.js";

export interface PostEditHook {
  glob: string;
  command: string;
  timeout_ms?: number;
}

interface HooksConfig {
  enabled?: boolean;
  hooks?: PostEditHook[];
}

interface HookRunResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

const DEFAULT_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../profiles/post-edit-hooks.json"
);
const MAX_HOOK_CONFIG_BYTES = 256 * 1024;
const MAX_HOOKS = 100;
const MAX_HOOK_EXECUTIONS = 200;
const HOOK_OUTPUT_MAX_CHARS = 8192;
const MIN_HOOK_TIMEOUT_MS = 100;
const MAX_HOOK_TIMEOUT_MS = 120_000;

async function loadHooksConfig(): Promise<HooksConfig> {
  const configPath = process.env.POST_EDIT_HOOKS_CONFIG || DEFAULT_CONFIG_PATH;
  try {
    const raw = await readUtf8FileBounded(configPath, MAX_HOOK_CONFIG_BYTES, "post-edit hooks config");
    const parsed = JSON.parse(raw) as HooksConfig;
    const hooks = Array.isArray(parsed.hooks)
      ? parsed.hooks
          .filter(
            (hook): hook is PostEditHook =>
              Boolean(hook) &&
              typeof hook.glob === "string" &&
              hook.glob.length > 0 &&
              hook.glob.length <= 512 &&
              typeof hook.command === "string" &&
              hook.command.length > 0 &&
              hook.command.length <= 32_768
          )
          .slice(0, MAX_HOOKS)
          .map((hook) => ({
            ...hook,
            timeout_ms:
              Number.isSafeInteger(hook.timeout_ms) && hook.timeout_ms! >= MIN_HOOK_TIMEOUT_MS
                ? Math.min(hook.timeout_ms!, MAX_HOOK_TIMEOUT_MS)
                : 15_000,
          }))
      : [];
    return { enabled: parsed.enabled !== false, hooks };
  } catch {
    return { enabled: false, hooks: [] };
  }
}

function runHook(command: string, filePath: string, timeoutMs: number): Promise<HookRunResult> {
  const expanded = command.replace(/\{path\}/g, filePath).replace(/\{file\}/g, filePath);
  const shell = process.platform === "win32" ? "powershell.exe" : "bash";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", expanded] : ["-lc", expanded];

  const { promise, resolve } = Promise.withResolvers<HookRunResult>();
  const child = spawn(shell, args, { cwd: path.dirname(filePath), windowsHide: true });
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
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.unref();
    } else {
      child.kill("SIGKILL");
    }
    // Prefer waiting for the child close event so the caller does not move on
    // while a timed-out hook tree is still alive. Keep a bounded fallback in
    // case the OS never reports close after forced termination.
    forceSettleTimer = setTimeout(() => {
      settle(() => resolve({
        stdout,
        stderr: stderr || "hook timeout",
        exit_code: null,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
      }));
    }, 1500);
    forceSettleTimer.unref?.();
  }, timeoutMs);
  timer.unref?.();

  child.stdout.on("data", (d: Buffer) => {
    const next = appendBoundedTail(stdout, d.toString(), HOOK_OUTPUT_MAX_CHARS, stdoutTruncated);
    stdout = next.text;
    stdoutTruncated = next.truncated;
  });
  child.stderr.on("data", (d: Buffer) => {
    const next = appendBoundedTail(stderr, d.toString(), HOOK_OUTPUT_MAX_CHARS, stderrTruncated);
    stderr = next.text;
    stderrTruncated = next.truncated;
  });
  child.on("close", (code) => settle(() => resolve({
    stdout: stdout.trim(),
    stderr: timedOut ? (stderr.trim() || "hook timeout") : stderr.trim(),
    exit_code: timedOut ? null : code,
    stdout_truncated: stdoutTruncated,
    stderr_truncated: stderrTruncated,
  })));
  child.on("error", () => settle(() => resolve({
    stdout: "",
    stderr: timedOut ? "hook timeout" : "hook spawn failed",
    exit_code: timedOut ? null : 1,
    stdout_truncated: false,
    stderr_truncated: false,
  })));
  return promise;
}

export async function runPostEditHooks(filePaths: string[]): Promise<Record<string, unknown> | undefined> {
  const config = await loadHooksConfig();
  if (config.enabled === false || !config.hooks?.length) return undefined;

  const results: Array<Record<string, unknown>> = [];
  let executions = 0;
  let truncated = false;
  const hooks = config.hooks.map((hook) => ({ hook, matcher: globToRegExp(hook.glob) }));

  for (const filePath of filePaths) {
    const base = path.basename(filePath);
    const rel = filePath.replace(/\\/g, "/");
    for (const { hook, matcher } of hooks) {
      if (!matchesCompiledGlob(matcher, rel, base)) continue;
      if (executions >= MAX_HOOK_EXECUTIONS) {
        truncated = true;
        break;
      }
      executions++;
      const out = await runHook(hook.command, filePath, hook.timeout_ms ?? 15000);
      results.push({
        file: filePath,
        glob: hook.glob,
        command: hook.command,
        exit_code: out.exit_code,
        stdout: out.stdout.slice(0, 2000),
        stderr: out.stderr.slice(0, 2000),
        stdout_truncated: out.stdout_truncated || out.stdout.length > 2000,
        stderr_truncated: out.stderr_truncated || out.stderr.length > 2000,
      });
    }
    if (truncated) break;
  }

  if (!results.length) return undefined;
  return { post_edit_hooks: results, ...(truncated ? { truncated: true, max_executions: MAX_HOOK_EXECUTIONS } : {}) };
}