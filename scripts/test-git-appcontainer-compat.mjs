import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(path.dirname(repoRoot), "clc-git-appcontainer-"));
const repo = path.join(root, "repo");
const old = {
  FULL_DISK_ACCESS: process.env.FULL_DISK_ACCESS,
  SANDBOX_NETWORK_MODE: process.env.SANDBOX_NETWORK_MODE,
  SANDBOX_ENV_ALLOWLIST: process.env.SANDBOX_ENV_ALLOWLIST,
  GIT_TRACE: process.env.GIT_TRACE,
  LOCAL_CODER_INSTANCE_ID: process.env.LOCAL_CODER_INSTANCE_ID,
  CLC_SANDBOX_PROFILE_NAME: process.env.CLC_SANDBOX_PROFILE_NAME,
  CLC_SANDBOX_STATE_DIR: process.env.CLC_SANDBOX_STATE_DIR,
};

function nativeGit(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function collect(handle) {
  const { child } = handle;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

try {
  await fs.mkdir(repo, { recursive: true });
  nativeGit(root, "init", repo);
  nativeGit(repo, "config", "user.name", "Sandbox Git Test");
  nativeGit(repo, "config", "user.email", "sandbox@example.invalid");
  await fs.writeFile(path.join(repo, "a.txt"), "one\n");
  nativeGit(repo, "add", "a.txt");
  nativeGit(repo, "commit", "-m", "fixture");
  await fs.writeFile(path.join(repo, "a.txt"), "dirty\n");

  process.env.FULL_DISK_ACCESS = "false";
  process.env.SANDBOX_NETWORK_MODE = "none";
  process.env.LOCAL_CODER_INSTANCE_ID = "tests";
  process.env.CLC_SANDBOX_PROFILE_NAME = "ChatGPTLocalCoder.tests";
  process.env.CLC_SANDBOX_STATE_DIR = path.join(root, ".sandbox-state");
  process.env.GIT_TRACE = "1";
  process.env.SANDBOX_ENV_ALLOWLIST = "GIT_TRACE";

  const pathSecurity = await import("../dist/lib/path-security.js");
  const executor = await import("../dist/lib/process-executor.js");
  pathSecurity.setDefaultCwd(repo);
  pathSecurity.setWorkspaceRoots([root]);
  executor.resetProcessSecurityForTests();
  const status = await executor.initializeProcessSecurity();
  assert.equal(status.sandbox_self_test, "passed", status.sandbox_error);
  const sandboxCwd = path.parse(repo).root;
  assert.ok(status.sandbox_profile_path, "sandbox profile path missing");

  const repoPrefix = [
    `--git-dir=${path.join(repo, ".git")}`,
    `--work-tree=${repo}`,
  ];

  const commands = [
    ["--version"],
    [...repoPrefix, "rev-parse", "--show-toplevel"],
    [...repoPrefix, "status", "--short"],
    [...repoPrefix, "rev-parse", "--verify", "HEAD^{tree}"],
    [...repoPrefix, "ls-tree", "-r", "--name-only", "HEAD"],
    [...repoPrefix, "restore", "--source", "HEAD", "--", "a.txt"],
  ];
  for (const args of commands) {
    const result = await collect(await executor.spawnProcess({ executable: "git", args, cwd: sandboxCwd, timeoutMs: 15_000 }));
    console.log(JSON.stringify({ args, ...result }));
    if (result.code !== 0) break;
  }
} finally {
  for (const [name, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}
