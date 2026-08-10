import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { restoreToCheckpoint } from "../dist/lib/checkpoint.js";
import {
  getDefaultCwd,
  getWorkspaceRoots,
  setDefaultCwd,
  setWorkspaceRoots,
} from "../dist/lib/path-security.js";
import { registerGitTools } from "../dist/tools/git.js";

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
const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-git-safety-"));
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

  const handlers = new Map();
  registerGitTools(
    {
      registerTool(name, _definition, handler) {
        handlers.set(name, handler);
      },
    },
    repo,
  );
  const restore = handlers.get("git_restore");
  assert.equal(typeof restore, "function", "git_restore handler not registered");

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

  console.log("git-safety: ok (exact tracked file only, immutable source, complete checkpoint required, rewind recovers dirty content)");
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
  await fs.rm(root, { recursive: true, force: true });
}