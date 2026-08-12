import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { restoreToCheckpoint } from "../dist/lib/checkpoint.js";
import {
  getDefaultCwd,
  getWorkspaceRoots,
  setDefaultCwd,
  setWorkspaceRoots,
} from "../dist/lib/path-security.js";
import { registerGitTools } from "../dist/tools/git.js";
import {
  initializeProcessSecurity,
  resetProcessSecurityForTests,
} from "../dist/lib/process-executor.js";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, windowsHide: true, encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout.trim();
}

const oldCwd = getDefaultCwd();
const oldRoots = [...getWorkspaceRoots()];
const oldFullDisk = process.env.FULL_DISK_ACCESS;
const oldCheckpointEnabled = process.env.CHECKPOINT_ENABLED;
const oldCheckpointPath = process.env.CHECKPOINT_PATH;
const oldCheckpointMaxFileBytes = process.env.CHECKPOINT_MAX_FILE_BYTES;
const oldInstanceId = process.env.LOCAL_CODER_INSTANCE_ID;
const oldSandboxProfile = process.env.CLC_SANDBOX_PROFILE_NAME;
const oldSandboxStateDir = process.env.CLC_SANDBOX_STATE_DIR;
const oldSandboxNetworkMode = process.env.SANDBOX_NETWORK_MODE;
const testBase = path.resolve(process.env.WORKSPACE_PATH?.trim() || path.dirname(process.cwd()));
const root = await fs.mkdtemp(path.join(testBase, "clc-git-safety-"));
const repo = path.join(root, "repo");

try {
  await fs.mkdir(path.join(repo, "folder"), { recursive: true });
  git(root, "init", repo);
  git(repo, "config", "user.name", "Local Coder Safety Test");
  git(repo, "config", "user.email", "local-coder-safety@example.invalid");
  await fs.writeFile(path.join(repo, "a.txt"), "committed-a\n");
  await fs.writeFile(path.join(repo, "folder", "b.txt"), "committed-b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "fixture");

  setDefaultCwd(repo);
  setWorkspaceRoots([root]);
  process.env.FULL_DISK_ACCESS = "false";
  process.env.CHECKPOINT_ENABLED = "true";
  process.env.CHECKPOINT_PATH = path.join(root, "checkpoints");
  process.env.CHECKPOINT_MAX_FILE_BYTES = "5242880";
  process.env.LOCAL_CODER_INSTANCE_ID = "tests";
  process.env.CLC_SANDBOX_PROFILE_NAME = "ChatGPTLocalCoder.tests";
  process.env.CLC_SANDBOX_STATE_DIR = path.join(root, ".sandbox-state");
  process.env.SANDBOX_NETWORK_MODE = "none";
  resetProcessSecurityForTests();
  const sandbox = await initializeProcessSecurity();
  assert.equal(
    sandbox.sandbox_self_test,
    "passed",
    `strict Git sandbox unavailable: ${sandbox.sandbox_error || sandbox.sandbox_self_test}`,
  );

  const handlers = new Map();
  const definitions = new Map();
  registerGitTools(
    {
      registerTool(name, definition, handler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      },
    },
    repo,
  );
  const restore = handlers.get("git_restore");
  const branchTool = handlers.get("git_branch");
  const checkout = handlers.get("git_checkout");
  const push = handlers.get("git_push");
  const pull = handlers.get("git_pull");
  const reset = handlers.get("git_reset");
  assert.equal(typeof restore, "function", "git_restore handler not registered");
  for (const [name, handler] of [["git_branch", branchTool], ["git_checkout", checkout], ["git_push", push], ["git_pull", pull], ["git_reset", reset]]) {
    assert.equal(typeof handler, "function", `${name} handler not registered`);
  }
  for (const name of ["git_push", "git_pull"]) {
    assert.deepEqual(
      definitions.get(name)?.annotations,
      { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      `${name} must stay conservative across the remote/network boundary`,
    );
  }

  const tracked = path.join(repo, "a.txt");
  await fs.writeFile(tracked, "dirty-a\n");
  const result = await restore({ path: repo, files: ["a.txt"], source: "HEAD" });
  const data = result.structuredContent.data;
  assert.equal(
    (await fs.readFile(tracked, "utf8")).replace(/\r\n/g, "\n"),
    "committed-a\n",
    "git_restore did not restore source content",
  );
  assert.match(data.checkpoint_id || "", /^cp_[0-9a-f]+$/i, "git_restore did not return a recovery checkpoint");
  assert.match(data.resolved_source || "", /^[0-9a-f]{40,64}$/i, "git_restore did not bind an immutable source tree");

  await restoreToCheckpoint(data.checkpoint_id);
  assert.equal(
    await fs.readFile(tracked, "utf8"),
    "dirty-a\n",
    "git_restore checkpoint could not recover the pre-restore dirty content",
  );

  await assert.rejects(
    restore({ path: repo, files: ["folder"], source: "HEAD" }),
    /GIT_RESTORE_EXACT_FILE_REQUIRED/,
    "git_restore accepted a directory pathspec",
  );
  await assert.rejects(
    restore({ path: repo, files: ["../outside.txt"], source: "HEAD" }),
    /GIT_RESTORE_EXACT_PATH_REQUIRED/,
    "git_restore accepted a repository escape",
  );
  await assert.rejects(
    restore({ path: repo, files: [tracked], source: "HEAD" }),
    /GIT_RESTORE_EXACT_PATH_REQUIRED/,
    "git_restore accepted an absolute path",
  );
  await assert.rejects(
    restore({ path: repo, files: ["a.txt"], source: "--work-tree=outside" }),
    /GIT_RESTORE_INVALID_SOURCE/,
    "git_restore accepted an option-like source revision",
  );

  const headBeforeInjectionChecks = git(repo, "rev-parse", "HEAD");
  const dirtyBeforeInjectionChecks = await fs.readFile(tracked, "utf8");
  await assert.rejects(
    branchTool({ path: repo, action: "create", name: "--help" }),
    /GIT_BRANCH_INVALID/,
    "git_branch accepted an option-like branch",
  );
  await assert.rejects(
    checkout({ path: repo, branch: "--detach" }),
    /GIT_BRANCH_INVALID/,
    "git_checkout accepted an option-like branch",
  );
  await assert.rejects(
    push({ path: repo, remote: "--mirror", branch: undefined, set_upstream: false }),
    /GIT_REMOTE_INVALID/,
    "git_push accepted an option-like remote",
  );
  await assert.rejects(
    push({ path: repo, remote: "origin", branch: ":main", set_upstream: false }),
    /GIT_BRANCH_INVALID/,
    "git_push accepted a delete refspec as branch",
  );
  await assert.rejects(
    pull({ path: repo, remote: "origin", branch: "--force" }),
    /GIT_BRANCH_INVALID/,
    "git_pull accepted an option-like branch",
  );
  await assert.rejects(
    reset({ path: repo, mode: "mixed", ref: "--hard" }),
    /GIT_REF_INVALID/,
    "git_reset accepted a destructive option through ref",
  );
  assert.equal(git(repo, "rev-parse", "HEAD"), headBeforeInjectionChecks, "typed Git injection checks moved HEAD");
  assert.equal(await fs.readFile(tracked, "utf8"), dirtyBeforeInjectionChecks, "typed Git injection checks changed dirty content");

  const safeReset = await reset({ path: repo, mode: "mixed", ref: "HEAD" });
  assert.match(safeReset.structuredContent.data.resolved_ref || "", /^[0-9a-f]{40,64}$/i, "git_reset did not bind an immutable commit");
  assert.equal(await fs.readFile(tracked, "utf8"), dirtyBeforeInjectionChecks, "safe mixed reset changed working file content");

  process.env.CHECKPOINT_ENABLED = "false";
  await fs.writeFile(tracked, "dirty-checkpoint-disabled\n");
  await assert.rejects(
    restore({ path: repo, files: ["a.txt"], source: "HEAD" }),
    /CHECKPOINT_REQUIRED/,
    "git_restore overwrote a file while required checkpoints were disabled",
  );
  assert.equal(
    await fs.readFile(tracked, "utf8"),
    "dirty-checkpoint-disabled\n",
    "checkpoint-disabled rejection mutated the working file",
  );

  process.env.CHECKPOINT_ENABLED = "true";
  process.env.CHECKPOINT_MAX_FILE_BYTES = "1024";
  await fs.writeFile(tracked, Buffer.alloc(2048, 0x41));
  await assert.rejects(
    restore({ path: repo, files: ["a.txt"], source: "HEAD" }),
    /CHECKPOINT_INCOMPLETE/,
    "git_restore accepted an incomplete recovery snapshot",
  );
  assert.equal((await fs.stat(tracked)).size, 2048, "incomplete-checkpoint rejection mutated the working file");

  console.log("git-safety: ok (exact restore, typed Git option/refspec injection blocked, immutable refs, complete checkpoint, rewind recovery)");
} finally {
  setDefaultCwd(oldCwd);
  setWorkspaceRoots(oldRoots);
  if (oldFullDisk === undefined) delete process.env.FULL_DISK_ACCESS;
  else process.env.FULL_DISK_ACCESS = oldFullDisk;
  if (oldCheckpointEnabled === undefined) delete process.env.CHECKPOINT_ENABLED;
  else process.env.CHECKPOINT_ENABLED = oldCheckpointEnabled;
  if (oldCheckpointPath === undefined) delete process.env.CHECKPOINT_PATH;
  else process.env.CHECKPOINT_PATH = oldCheckpointPath;
  if (oldCheckpointMaxFileBytes === undefined) delete process.env.CHECKPOINT_MAX_FILE_BYTES;
  else process.env.CHECKPOINT_MAX_FILE_BYTES = oldCheckpointMaxFileBytes;
  if (oldInstanceId === undefined) delete process.env.LOCAL_CODER_INSTANCE_ID;
  else process.env.LOCAL_CODER_INSTANCE_ID = oldInstanceId;
  if (oldSandboxProfile === undefined) delete process.env.CLC_SANDBOX_PROFILE_NAME;
  else process.env.CLC_SANDBOX_PROFILE_NAME = oldSandboxProfile;
  if (oldSandboxStateDir === undefined) delete process.env.CLC_SANDBOX_STATE_DIR;
  else process.env.CLC_SANDBOX_STATE_DIR = oldSandboxStateDir;
  if (oldSandboxNetworkMode === undefined) delete process.env.SANDBOX_NETWORK_MODE;
  else process.env.SANDBOX_NETWORK_MODE = oldSandboxNetworkMode;
  resetProcessSecurityForTests();
  await fs.rm(root, { recursive: true, force: true });
}