import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getDefaultCwd,
  getWorkspaceRoots,
  setDefaultCwd,
  setWorkspaceRoots,
} from "../dist/lib/path-security.js";
import {
  initializeProcessSecurity,
  resetProcessSecurityForTests,
} from "../dist/lib/process-executor.js";
import { registerGitTools } from "../dist/tools/git.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testBase = path.resolve(process.env.WORKSPACE_PATH?.trim() || path.dirname(process.cwd()));
const root = await fs.mkdtemp(path.join(testBase, "clc-git-sandbox-"));
const repo = path.join(root, "repo");
const outside = await fs.mkdtemp(path.join(testBase, "clc-git-outside-"));
const outsideSecret = path.join(outside, "outside-secret.txt");
const outsideWrite = path.join(outside, "outside-write.txt");
const hookProbeSource = path.join(repoRoot, "native", "windows-sandbox-runner", "bin", "SandboxGitHookProbe.exe");
const hookMarker = path.join(repo, "hook-inside.txt");
const hookOutput = path.join(repo, "hook-output.txt");

function nativeGit(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout.trim();
}

const old = {
  cwd: getDefaultCwd(),
  roots: [...getWorkspaceRoots()],
  FULL_DISK_ACCESS: process.env.FULL_DISK_ACCESS,
  LOCAL_CODER_INSTANCE_ID: process.env.LOCAL_CODER_INSTANCE_ID,
  CLC_SANDBOX_PROFILE_NAME: process.env.CLC_SANDBOX_PROFILE_NAME,
  CLC_SANDBOX_STATE_DIR: process.env.CLC_SANDBOX_STATE_DIR,
  SANDBOX_NETWORK_MODE: process.env.SANDBOX_NETWORK_MODE,
  SANDBOX_ENV_ALLOWLIST: process.env.SANDBOX_ENV_ALLOWLIST,
  CLC_HOOK_INSIDE: process.env.CLC_HOOK_INSIDE,
  CLC_HOOK_OUTSIDE_READ: process.env.CLC_HOOK_OUTSIDE_READ,
  CLC_HOOK_OUTSIDE_WRITE: process.env.CLC_HOOK_OUTSIDE_WRITE,
  CLC_HOOK_OUTPUT: process.env.CLC_HOOK_OUTPUT,
};

try {
  await fs.mkdir(repo, { recursive: true });
  nativeGit(root, "init", repo);
  nativeGit(repo, "config", "user.name", "Sandbox Boundary Test");
  nativeGit(repo, "config", "user.email", "sandbox-boundary@example.invalid");
  await fs.writeFile(path.join(repo, "data.txt"), "base\n", "utf8");
  nativeGit(repo, "add", "data.txt");
  nativeGit(repo, "commit", "-m", "fixture");
  await fs.writeFile(outsideSecret, "outside-secret\n", "utf8");

  setDefaultCwd(repo);
  setWorkspaceRoots([root]);
  process.env.FULL_DISK_ACCESS = "false";
  process.env.LOCAL_CODER_INSTANCE_ID = "tests";
  process.env.CLC_SANDBOX_PROFILE_NAME = "ChatGPTLocalCoder.tests";
  process.env.CLC_SANDBOX_STATE_DIR = path.join(root, ".sandbox-state");
  process.env.SANDBOX_NETWORK_MODE = "none";
  process.env.SANDBOX_ENV_ALLOWLIST = [
    "CLC_HOOK_INSIDE",
    "CLC_HOOK_OUTSIDE_READ",
    "CLC_HOOK_OUTSIDE_WRITE",
    "CLC_HOOK_OUTPUT",
  ].join(";");
  process.env.CLC_HOOK_INSIDE = hookMarker;
  process.env.CLC_HOOK_OUTSIDE_READ = outsideSecret;
  process.env.CLC_HOOK_OUTSIDE_WRITE = outsideWrite;
  process.env.CLC_HOOK_OUTPUT = hookOutput;
  resetProcessSecurityForTests();
  const security = await initializeProcessSecurity();
  assert.equal(security.sandbox_self_test, "passed", security.sandbox_error);

  // Use a native hook executable (stored at Git's exact hook path without a
  // shell extension). This proves Git-spawned descendants inherit AppContainer
  // without granting MSYS a global BaseNamedObjects namespace.
  await fs.copyFile(hookProbeSource, path.join(repo, ".git", "hooks", "pre-commit"));

  const handlers = new Map();
  registerGitTools({
    registerTool(name, _definition, handler) {
      handlers.set(name, handler);
    },
  }, repo);
  const gitAdd = handlers.get("git_add");
  const gitCommit = handlers.get("git_commit");
  assert.equal(typeof gitAdd, "function");
  assert.equal(typeof gitCommit, "function");

  await fs.writeFile(path.join(repo, "data.txt"), "sandboxed commit\n", "utf8");
  await gitAdd({ path: repo, files: ["data.txt"], all: false });
  const commit = await gitCommit({
    path: repo,
    message: "sandboxed typed git commit",
    stage_all: false,
  });
  assert.match(commit.structuredContent.data.output || "", /sandboxed typed git commit/i);

  assert.equal((await fs.readFile(hookMarker, "utf8")).trim(), "hook-child-ok", "pre-commit child did not execute inside workspace");
  const hookText = await fs.readFile(hookOutput, "utf8");
  assert.match(hookText, /outside_read=denied/, hookText);
  assert.match(hookText, /outside_write=denied/, hookText);
  await assert.rejects(fs.stat(outsideWrite), undefined, "Git hook escaped sandbox and wrote outside root");
  assert.match(nativeGit(repo, "log", "-1", "--pretty=%s"), /sandboxed typed git commit/);

  console.log("OK git sandbox boundary: typed add/commit + real pre-commit child denied outside read/write");
} finally {
  setDefaultCwd(old.cwd);
  setWorkspaceRoots(old.roots);
  for (const [name, value] of Object.entries(old)) {
    if (name === "cwd" || name === "roots") continue;
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetProcessSecurityForTests();
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(outside, { recursive: true, force: true }).catch(() => undefined);
}
