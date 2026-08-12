import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const base = path.resolve(process.cwd(), "..");
const root = await fs.mkdtemp(path.join(base, "clc-git-worktree-"));
const repo = path.join(root, "repo");
const linked = path.join(root, "linked");
const previousFullDisk = process.env.FULL_DISK_ACCESS;

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git exit ${result.status}`);
  return result.stdout.trim();
}

try {
  await fs.mkdir(repo, { recursive: true });
  git(root, ["init", repo]);
  git(repo, ["config", "user.name", "Linked Worktree Test"]);
  git(repo, ["config", "user.email", "linked-worktree@example.invalid"]);
  await fs.writeFile(path.join(repo, "a.txt"), "base\n", "utf8");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-m", "fixture"]);
  git(repo, ["worktree", "add", "-b", "linked-test", linked]);
  const dotGit = await fs.stat(path.join(linked, ".git"));
  assert.equal(dotGit.isFile(), true, "linked worktree .git should be a file");

  process.env.FULL_DISK_ACCESS = "false";
  const { buildGitProcessInvocation } = await import("../dist/lib/git-process.js");
  const invocation = buildGitProcessInvocation(linked, ["status", "--short"]);
  const result = spawnSync("git", invocation.args, {
    cwd: invocation.cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  console.log("OK strict Git invocation supports linked worktree .git files");
} finally {
  if (previousFullDisk === undefined) delete process.env.FULL_DISK_ACCESS;
  else process.env.FULL_DISK_ACCESS = previousFullDisk;
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}
