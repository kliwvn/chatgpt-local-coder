import { spawn } from "child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { requireWriteAllowed } from "../lib/permissions.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { appendBoundedHead, appendBoundedTail, GIT_OUTPUT_MAX_CHARS } from "../lib/output-budget.js";
import { checkpointBefore } from "../lib/checkpoint.js";

interface GitRunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}

function markTruncated(text: string, truncated: boolean, where: "head" | "tail"): string {
  if (!truncated) return text.trim();
  const marker = `...[git output truncated at ${GIT_OUTPUT_MAX_CHARS} chars]`;
  if (where === "head") {
    const room = Math.max(0, GIT_OUTPUT_MAX_CHARS - marker.length - 1);
    return `${text.slice(0, room).trimEnd()}\n${marker}`;
  }
  const room = Math.max(0, GIT_OUTPUT_MAX_CHARS - marker.length - 1);
  return `${marker}\n${text.slice(-room).trimStart()}`;
}

function runGit(args: string[], cwd: string, timeoutMs = 30_000): Promise<GitRunResult> {
  const { promise, resolve, reject } = Promise.withResolvers<GitRunResult>();
  const child = spawn("git", args, { cwd, windowsHide: true });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill("SIGKILL");
    resolve({
      stdout: markTruncated(stdout, stdoutTruncated, "head"),
      stderr: stderr
        ? markTruncated(stderr, stderrTruncated, "tail")
        : `git timed out after ${timeoutMs}ms`,
      exit_code: 124,
      stdout_truncated: stdoutTruncated,
      stderr_truncated: stderrTruncated,
    });
  }, timeoutMs);
  child.stdout.on("data", (d: string) => {
    // For diff/status/log, the beginning contains the most useful structural
    // context. Stop retaining bytes after the configured cap.
    const next = appendBoundedHead(stdout, d, GIT_OUTPUT_MAX_CHARS, stdoutTruncated);
    stdout = next.text;
    stdoutTruncated = next.truncated;
  });
  child.stderr.on("data", (d: string) => {
    // Errors are usually most useful at the tail.
    const next = appendBoundedTail(stderr, d, GIT_OUTPUT_MAX_CHARS, stderrTruncated);
    stderr = next.text;
    stderrTruncated = next.truncated;
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({
      stdout: markTruncated(stdout, stdoutTruncated, "head"),
      stderr: markTruncated(stderr, stderrTruncated, "tail"),
      exit_code: code ?? 1,
      stdout_truncated: stdoutTruncated,
      stderr_truncated: stderrTruncated,
    });
  });
  child.on("error", () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(new Error("git not found. Install Git for Windows."));
  });
  return promise;
}

async function gitOrThrow(args: string[], cwd: string): Promise<GitRunResult> {
  const result = await runGit(args, cwd);
  if (result.exit_code !== 0) {
    throw new Error(result.stderr || result.stdout || `git exited with code ${result.exit_code}`);
  }
  return result;
}

function safeGitAtom(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.startsWith("-") || /[\0\r\n]/.test(normalized)) {
    throw new Error(`GIT_${label}_INVALID: refusing option-like/ambiguous value: ${JSON.stringify(value)}`);
  }
  return normalized;
}

async function safeBranchName(value: string, cwd: string): Promise<string> {
  const branch = safeGitAtom(value, "BRANCH");
  // Branch arguments must be names, never force/delete refspecs such as +main or :main.
  if (branch.startsWith("+") || branch.includes(":")) {
    throw new Error(`GIT_BRANCH_INVALID: refusing refspec-like branch: ${JSON.stringify(value)}`);
  }
  const checked = await runGit(["check-ref-format", "--branch", branch], cwd);
  if (checked.exit_code !== 0) {
    throw new Error(`GIT_BRANCH_INVALID: ${checked.stderr || checked.stdout || branch}`);
  }
  return branch;
}

async function configuredRemote(value: string, cwd: string): Promise<string> {
  const remote = safeGitAtom(value, "REMOTE");
  const listed = await gitOrThrow(["remote"], cwd);
  const remotes = listed.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (!remotes.includes(remote)) {
    throw new Error(`GIT_REMOTE_INVALID: remote must be one configured remote name: ${JSON.stringify(value)}`);
  }
  return remote;
}

async function resolveCommitRef(value: string, cwd: string): Promise<string> {
  const ref = safeGitAtom(value, "REF");
  const resolved = await gitOrThrow(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
  const commit = resolved.stdout.trim().split(/\r?\n/, 1)[0];
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new Error(`GIT_REF_INVALID: could not bind immutable commit: ${JSON.stringify(value)}`);
  }
  return commit;
}

export function registerGitTools(server: McpServer, defaultCwd: string): void {
  const repo = async (p?: string) => (p ? validatePath(p) : defaultCwd);

  server.registerTool("git_status", {
    title: "Git Status", description: "Show git working tree status.",
    inputSchema: { path: z.string().optional() },

    annotations: toolAnnotations("read"),
  }, async ({ path: repoPath }) => {
    const cwd = await repo(repoPath);
    const r = await gitOrThrow(["status", "--short", "--branch"], cwd);
    await audit({ tool: "git_status", action: "git", target: cwd, status: "ok" });
    return toolResult("git_status", { path: cwd, output: r.stdout || "Clean working tree" });
  });

  server.registerTool("git_diff", {
    title: "Git Diff", description: "Show unstaged or staged changes.",
    inputSchema: { path: z.string().optional(), staged: z.boolean().optional().default(false), file: z.string().optional() },

    annotations: toolAnnotations("read"),
  }, async ({ path: repoPath, staged, file }) => {
    const cwd = await repo(repoPath);
    const args = ["diff"];
    if (staged) args.push("--staged");
    if (file) args.push("--", file);
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_diff", { path: cwd, staged, file, output: r.stdout || "No changes" });
  });

  server.registerTool("git_log", {
    title: "Git Log", description: "Show recent commit history.",
    inputSchema: { path: z.string().optional(), count: z.number().int().positive().max(1000).optional().default(10) },

    annotations: toolAnnotations("read"),
  }, async ({ path: repoPath, count }) => {
    const cwd = await repo(repoPath);
    const r = await gitOrThrow(["log", "--oneline", "-n", String(count)], cwd);
    return toolResult("git_log", { path: cwd, count, commits: r.stdout.split("\n").filter(Boolean) });
  });

  server.registerTool("git_add", {
    title: "Git Add", description: "Stage files for commit.",
    inputSchema: { path: z.string().optional(), files: z.array(z.string()).optional(), all: z.boolean().optional().default(true) },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, files, all }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    const args = ["add"];
    if (all && (!files || files.length === 0)) args.push("-A");
    else if (files?.length) args.push("--", ...files);
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_add", { path: cwd, files: files || ["-A"], output: r.stdout });
  });

  server.registerTool("git_commit", {
    title: "Git Commit", description: "Create a commit (stages all first unless stage_only=false).",
    inputSchema: {
      message: z.string(),
      path: z.string().optional(),
      stage_all: z.boolean().optional().default(true),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ message, path: repoPath, stage_all }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    if (stage_all) await gitOrThrow(["add", "-A"], cwd);
    const r = await gitOrThrow(["commit", "-m", message], cwd);
    await audit({ tool: "git_commit", action: "git", target: cwd, status: "ok", details: { message } });
    return toolResult("git_commit", { path: cwd, message, output: r.stdout });
  });

  server.registerTool("git_branch", {
    title: "Git Branch", description: "List/create/switch branches.",
    inputSchema: {
      path: z.string().optional(),
      action: z.enum(["list", "create", "switch", "create-and-switch"]).optional().default("list"),
      name: z.string().optional(),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, action, name }) => {
    const cwd = await repo(repoPath);
    let args: string[];
    if (action === "list") args = ["branch", "--all"];
    else {
      requireWriteAllowed();
      if (!name) throw new Error("name is required");
      const safeName = await safeBranchName(name, cwd);
      args = action === "create" ? ["branch", safeName] : action === "switch" ? ["switch", safeName] : ["switch", "-c", safeName];
    }
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_branch", { path: cwd, action, name, output: r.stdout });
  });

  server.registerTool("git_checkout", {
    title: "Switch Git Branch",
    description:
      "Switch the current local repository to an existing branch. Local workspace only — does not modify remotes.",
    inputSchema: {
      path: z.string().optional(),
      branch: z.string().describe("Existing branch name to switch to"),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, branch }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    const safeBranch = await safeBranchName(branch, cwd);
    const r = await gitOrThrow(["switch", safeBranch], cwd);
    return toolResult("git_checkout", {
      path: cwd,
      branch,
      output: r.stdout || r.stderr,
      run_command_fallback: `git switch ${branch}`,
    });
  });

  server.registerTool("git_restore", {
    title: "Restore Tracked Files",
    description:
      "Restore tracked file(s) in the current repo to the last committed version. Local workspace only.",
    inputSchema: {
      path: z.string().optional(),
      files: z.array(z.string()).min(1).describe("Repo-relative file paths to restore"),
      source: z
        .string()
        .optional()
        .default("HEAD")
        .describe("Revision to restore from (default HEAD)"),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, files, source }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    const sourceRef = source.trim();
    if (!sourceRef || sourceRef.startsWith("-") || /[\0\r\n]/.test(sourceRef)) {
      throw new Error(`GIT_RESTORE_INVALID_SOURCE: refusing ambiguous revision: ${JSON.stringify(source)}`);
    }
    const resolvedSourceResult = await gitOrThrow(["rev-parse", "--verify", `${sourceRef}^{tree}`], cwd);
    const resolvedSource = resolvedSourceResult.stdout.trim().split(/\r?\n/, 1)[0];
    if (!/^[0-9a-f]{40,64}$/i.test(resolvedSource)) {
      throw new Error(`GIT_RESTORE_INVALID_SOURCE: could not resolve revision to a tree: ${sourceRef}`);
    }

    const checkpointPaths: string[] = [];
    const gitPaths: string[] = [];
    for (const file of files) {
      if (
        !file.trim() ||
        path.isAbsolute(file) ||
        file === "." ||
        file === ".." ||
        /[\0\r\n*?\[\]]/.test(file) ||
        file.startsWith(":")
      ) {
        throw new Error(`GIT_RESTORE_EXACT_PATH_REQUIRED: refusing broad/pathspec restore target: ${file}`);
      }
      const target = path.resolve(cwd, file);
      const relative = path.relative(cwd, target);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`GIT_RESTORE_EXACT_PATH_REQUIRED: target escapes repository: ${file}`);
      }
      const validTarget = await validatePath(target);
      try {
        const current = await fs.lstat(validTarget);
        if (current.isDirectory() || current.isSymbolicLink()) {
          throw new Error(`GIT_RESTORE_EXACT_FILE_REQUIRED: refusing directory/symlink target: ${file}`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }

      const gitPath = relative.split(path.sep).join("/");
      const treeEntry = await runGit(["ls-tree", resolvedSource, "--", gitPath], cwd);
      if (treeEntry.exit_code !== 0 || !treeEntry.stdout.trim()) {
        throw new Error(`GIT_RESTORE_SOURCE_PATH_MISSING: ${gitPath} is not present in ${sourceRef}`);
      }
      const match = /^(\d{6})\s+(\w+)\s+([0-9a-f]+)\t(.+)$/i.exec(treeEntry.stdout.trim());
      if (
        !match ||
        (match[1] !== "100644" && match[1] !== "100755") ||
        match[2] !== "blob" ||
        match[4] !== gitPath
      ) {
        throw new Error(`GIT_RESTORE_EXACT_FILE_REQUIRED: source target is not one regular tracked file: ${gitPath}`);
      }
      checkpointPaths.push(validTarget);
      gitPaths.push(gitPath);
    }
    const checkpointId = await checkpointBefore("git_restore", checkpointPaths, {
      summary: `git restore from ${source}`,
      require_complete: true,
    });
    let r: GitRunResult;
    const restore = await runGit(["restore", `--source=${resolvedSource}`, "--", ...gitPaths], cwd);
    if (restore.exit_code === 0) {
      r = restore;
    } else {
      r = await gitOrThrow(["checkout", resolvedSource, "--", ...gitPaths], cwd);
    }
    return toolResult("git_restore", {
      path: cwd,
      files: gitPaths,
      source,
      resolved_source: resolvedSource,
      checkpoint_id: checkpointId,
      output: r.stdout || r.stderr || "Restored",
    });
  });

  server.registerTool("git_push", {
    title: "Sync Commits to Remote",
    description:
      "Upload local commits to the repository's configured remote (default origin). Uses the repo's existing remote URL.",
    inputSchema: {
      path: z.string().optional(),
      remote: z.string().optional().default("origin"),
      branch: z.string().optional(),
      set_upstream: z.boolean().optional().default(false),
    },

    annotations: toolAnnotations("external"),
  }, async ({ path: repoPath, remote, branch, set_upstream }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    const safeBranch = branch ? await safeBranchName(branch, cwd) : undefined;
    const safeRemote = await configuredRemote(remote, cwd);
    const args = ["push"];
    if (set_upstream) args.push("-u");
    args.push(safeRemote);
    if (safeBranch) args.push(safeBranch);
    const r = await gitOrThrow(args, cwd);
    const cmd = ["git push", set_upstream ? "-u" : "", safeRemote, safeBranch ?? ""]
      .filter(Boolean)
      .join(" ");
    return toolResult("git_push", {
      path: cwd,
      remote: safeRemote,
      branch: safeBranch,
      output: r.stdout || r.stderr,
      run_command_fallback: cmd,
    });
  });

  server.registerTool("git_pull", {
    title: "Sync from Remote",
    description:
      "Download updates from the repository's configured remote into the local working copy.",
    inputSchema: { path: z.string().optional(), remote: z.string().optional().default("origin"), branch: z.string().optional() },

    annotations: toolAnnotations("external"),
  }, async ({ path: repoPath, remote, branch }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    const safeBranch = branch ? await safeBranchName(branch, cwd) : undefined;
    const safeRemote = await configuredRemote(remote, cwd);
    const args = ["pull", safeRemote];
    if (safeBranch) args.push(safeBranch);
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_pull", { path: cwd, remote: safeRemote, branch: safeBranch, output: r.stdout || r.stderr });
  });

  server.registerTool("git_stash", {
    title: "Git Stash", description: "Stash list/push/pop/apply.",
    inputSchema: {
      path: z.string().optional(),
      action: z.enum(["list", "push", "pop", "apply"]).optional().default("list"),
      message: z.string().optional(),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, action, message }) => {
    const cwd = await repo(repoPath);
    const args = ["stash"];
    if (action === "list") args.push("list");
    else {
      requireWriteAllowed();
      if (action === "push") {
        args.push("push");
        if (message) args.push("-m", message);
      } else args.push(action);
    }
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_stash", { path: cwd, action, output: r.stdout || r.stderr });
  });

  server.registerTool("git_reset", {
    title: "Git Reset",
    description:
      "Move HEAD to a ref without discarding working-tree files. mixed=unstage commits, soft=keep staged. Hard reset is intentionally disabled.",
    inputSchema: {
      path: z.string().optional(),
      mode: z.enum(["soft", "mixed"]).optional().default("mixed"),
      ref: z.string().optional().default("HEAD"),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, mode, ref }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    const resolvedRef = await resolveCommitRef(ref, cwd);
    const r = await gitOrThrow(["reset", `--${mode}`, resolvedRef], cwd);
    return toolResult("git_reset", { path: cwd, mode, ref, resolved_ref: resolvedRef, output: r.stdout || r.stderr });
  });
}