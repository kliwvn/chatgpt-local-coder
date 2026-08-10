import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { recycleManagedDirectory } from "../manager/safe-delete.mjs";
import { checkpointBefore } from "../dist/lib/checkpoint.js";
import { requireCommandAllowed, shouldBlockCommand } from "../dist/lib/permissions.js";
import { safeDelete } from "../dist/lib/safe-delete.js";
import {
  getDefaultCwd,
  getWorkspaceRoots,
  setDefaultCwd,
  setWorkspaceRoots,
} from "../dist/lib/path-security.js";

const blockedCommands = [
  "rm -rf test",
  "rm -r test",
  "rmdir /s /q test",
  "rd /s /q test",
  "del /s test\\*",
  "erase /s test\\*",
  "Remove-Item test -Recurse -Force",
  'powershell -Command "Remove-Item test -Recurse -Force"',
  'powershell -c "& { Remove-Item test -Recurse -Force }"',
  'powershell -Command "Write-Output safe; Remove-Item test -Recurse -Force"',
  "powershell -EncodedCommand ZABlAGwA",
  "cmd /c rmdir /s /q test",
  'cmd /c "echo safe && rmdir /s /q test"',
  "bash -c 'echo safe; rm -rf test'",
  "git clean -f",
  "git clean -fd",
  "git clean -fdx",
  "git clean -d",
  "git -C . clean -fdx",
  "git -c clean.requireForce=false clean -d",
  "git reset --hard HEAD",
  "git restore -- src/file.ts",
  "git checkout HEAD -- src/file.ts",
  "git switch -f main",
  `python -c "import shutil; shutil.rmtree('test')"`,
  `py -c "import os; os.unlink('test.txt')"`,
  `python -c "from pathlib import Path; Path('test.txt').unlink()"`,
  `node -e "require('fs').rmSync('test',{recursive:true,force:true})"`,
  `node -e "require('node:fs').rmdirSync('test')"`,
  `[System.IO.File]::Delete('test.txt')`,
  `[System.IO.Directory]::Delete('test', $true)`,
  `/bin/rm -rf test`,
  String.raw`C:\Windows\System32\cmd.exe /c del /q test.txt`,
  String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "Remove-Item test -Recurse -Force"`,
  String.raw`"C:\Program Files\Git\cmd\git.exe" clean -fdx`,
  `/usr/bin/python3 -c "import shutil; shutil.rmtree('test')"`,
  `/usr/local/bin/node -e "require('fs').rmSync('test',{recursive:true,force:true})"`,
];

for (const command of blockedCommands) {
  assert.equal(shouldBlockCommand(command), true, `destructive command was not classified: ${command}`);
  assert.throws(
    () => requireCommandAllowed(command),
    /BLOCKED_DESTRUCTIVE_COMMAND/,
    `destructive command did not fail closed: ${command}`,
  );
}

for (const command of [
  "npm test",
  "git status --short",
  "git diff --check",
  "git clean -n",
  "git reset --mixed HEAD",
  "git reset --soft HEAD~1",
  "echo safe",
  'echo "rm -rf test"',
  "cmd /c echo rm -rf test",
  'powershell -Command "Write-Output rm -rf test"',
  'powershell -Command "Write-Output \'Remove-Item test -Recurse -Force\'"',
  'git grep -n "rm -rf"',
  'git -C . clean -n',
  `python -c "print('shutil.rmtree(test)')"`,
  `node -e "console.log('fs.rmSync(test)')"`,
  `/usr/bin/git status --short`,
  `/usr/bin/python3 -c "print('shutil.rmtree(test)')"`,
  String.raw`C:\Windows\System32\cmd.exe /c echo rm -rf test`,
]) {
  assert.equal(shouldBlockCommand(command), false, `safe command was blocked: ${command}`);
  assert.doesNotThrow(() => requireCommandAllowed(command));
}

const oldCwd = getDefaultCwd();
const oldRoots = [...getWorkspaceRoots()];
const oldFullDisk = process.env.FULL_DISK_ACCESS;
const oldCheckpointEnabled = process.env.CHECKPOINT_ENABLED;
const oldCheckpointPath = process.env.CHECKPOINT_PATH;
const oldCheckpointMaxFileBytes = process.env.CHECKPOINT_MAX_FILE_BYTES;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-destructive-safety-"));
const recycleNames = [];

function recycleBinContains(name) {
  const script = [
    "$shell = New-Object -ComObject Shell.Application",
    "$bin = $shell.Namespace(10)",
    "if ($null -eq $bin) { exit 2 }",
    "$items = @($bin.Items() | Where-Object { $_.Name -eq $env:CLC_RECYCLE_EXPECT_NAME })",
    "if ($items.Count -gt 0) { exit 0 } else { exit 3 }",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    env: { ...process.env, CLC_RECYCLE_EXPECT_NAME: name },
    encoding: "utf8",
    timeout: 10_000,
  });
  return result.status === 0;
}

async function waitForRecycleBin(name) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (recycleBinContains(name)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Recycle Bin did not expose expected recoverable item: ${name}`);
}

function restoreRecycleItemBestEffort(name) {
  const script = [
    "$shell = New-Object -ComObject Shell.Application",
    "$bin = $shell.Namespace(10)",
    "if ($null -eq $bin) { exit 0 }",
    "$items = @($bin.Items() | Where-Object { $_.Name -eq $env:CLC_RECYCLE_EXPECT_NAME })",
    "foreach ($item in $items) { $item.InvokeVerb('RESTORE') }",
  ].join("; ");
  spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    env: { ...process.env, CLC_RECYCLE_EXPECT_NAME: name },
    encoding: "utf8",
    timeout: 10_000,
  });
}

try {
  setDefaultCwd(root);
  setWorkspaceRoots([root]);
  process.env.FULL_DISK_ACCESS = "true"; // Must not weaken protected-root checks.

  await assert.rejects(
    safeDelete(root, root),
    /SAFE_DELETE_PROTECTED_TARGET.*workspace root/i,
    "configured workspace root was deletable",
  );
  await assert.rejects(
    safeDelete(path.parse(root).root),
    /SAFE_DELETE_PROTECTED_TARGET.*root/i,
    "drive/filesystem root was deletable",
  );
  await assert.rejects(
    safeDelete(os.homedir()),
    /SAFE_DELETE_PROTECTED_TARGET.*home/i,
    "user home root was deletable",
  );

  const repo = path.join(root, "repo");
  const gitObjects = path.join(repo, ".git", "objects");
  await fs.mkdir(gitObjects, { recursive: true });
  await assert.rejects(
    safeDelete(repo, repo),
    /SAFE_DELETE_PROTECTED_TARGET.*repository root/i,
    "repository root was deletable",
  );
  await assert.rejects(
    safeDelete(path.join(repo, ".git"), path.join(repo, ".git")),
    /SAFE_DELETE_PROTECTED_TARGET.*\.git metadata/i,
    ".git metadata was deletable",
  );
  await assert.rejects(
    safeDelete(gitObjects, gitObjects),
    /SAFE_DELETE_PROTECTED_TARGET.*\.git metadata/i,
    ".git descendant metadata was deletable",
  );

  const checkpointFile = path.join(root, "checkpoint-required.txt");
  await fs.writeFile(checkpointFile, "checkpoint-required\n");
  process.env.CHECKPOINT_PATH = path.join(root, "checkpoint-store");
  process.env.CHECKPOINT_ENABLED = "false";
  await assert.rejects(
    checkpointBefore("destructive-test", [checkpointFile], { require_complete: true }),
    /CHECKPOINT_REQUIRED/,
    "required checkpoint silently proceeded while checkpointing was disabled",
  );
  process.env.CHECKPOINT_ENABLED = "true";
  process.env.CHECKPOINT_MAX_FILE_BYTES = "1024";
  const oversizedCheckpointFile = path.join(root, "checkpoint-too-large.bin");
  await fs.writeFile(oversizedCheckpointFile, Buffer.alloc(2048, 0x41));
  await assert.rejects(
    checkpointBefore("destructive-test", [oversizedCheckpointFile], { require_complete: true }),
    /CHECKPOINT_INCOMPLETE/,
    "required checkpoint accepted a skipped oversized snapshot",
  );
  const checkpointId = await checkpointBefore("destructive-test", [checkpointFile], { require_complete: true });
  assert.match(checkpointId || "", /^cp_[0-9a-f]+$/i, "complete required checkpoint was not created");

  if (process.platform === "win32") {
    const aliasTarget = path.join(root, "alias-target");
    const alias = path.join(root, "alias-junction");
    await fs.mkdir(aliasTarget);
    await fs.symlink(aliasTarget, alias, "junction");
    await assert.rejects(
      safeDelete(alias, aliasTarget),
      /SAFE_DELETE_PROTECTED_TARGET.*(?:alias|junction|reparse)/i,
      "junction target could be deleted through an alias",
    );
    assert.equal((await fs.stat(aliasTarget)).isDirectory(), true, "junction rejection damaged its target");

    const fileName = `clc-recycle-file-${randomUUID()}.txt`;
    const file = path.join(root, fileName);
    await fs.writeFile(file, "recoverable-file\n");
    const fileResult = await safeDelete(file, file);
    assert.equal(fileResult.mode, "recycle_bin");
    await assert.rejects(fs.lstat(file), { code: "ENOENT" });
    await waitForRecycleBin(fileName);
    recycleNames.push(fileName);

    const dirName = `clc-recycle-dir-${randomUUID()}`;
    const dir = path.join(root, dirName);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "nested.txt"), "recoverable-dir\n");
    const dirResult = await safeDelete(dir, dir);
    assert.equal(dirResult.mode, "recycle_bin");
    await assert.rejects(fs.lstat(dir), { code: "ENOENT" });
    await waitForRecycleBin(dirName);
    recycleNames.push(dirName);

    const managedParent = path.join(root, "managed-instances");
    await fs.mkdir(managedParent);
    const managedName = `clc-managed-instance-${randomUUID()}`;
    const managedDir = path.join(managedParent, managedName);
    await fs.mkdir(managedDir);
    await fs.writeFile(path.join(managedDir, ".env"), "TOKEN=test-secret\n");
    await recycleManagedDirectory(managedDir, managedParent);
    await assert.rejects(fs.lstat(managedDir), { code: "ENOENT" });
    await waitForRecycleBin(managedName);
    recycleNames.push(managedName);
    await assert.rejects(
      recycleManagedDirectory(root, managedParent),
      /outside exact parent/i,
      "manager recycle helper accepted a target outside its exact managed parent",
    );
  } else {
    const file = path.join(root, "must-survive.txt");
    await fs.writeFile(file, "no-permanent-fallback\n");
    await assert.rejects(safeDelete(file, file), /SAFE_DELETE_UNSUPPORTED/);
    assert.equal(await fs.readFile(file, "utf8"), "no-permanent-fallback\n");
  }

  console.log(
    `destructive-safety: ok (${blockedCommands.length} shell negatives; quote-aware safe commands; protected roots/.git/aliases; required checkpoints; recoverable Recycle Bin verified)`,
  );
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
  if (process.platform === "win32") {
    for (const name of recycleNames) restoreRecycleItemBestEffort(name);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await fs.rm(root, { recursive: true, force: true });
}
