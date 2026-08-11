import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { recycleManagedDirectory } from "../manager/safe-delete.mjs";
import { checkpointBefore } from "../dist/lib/checkpoint.js";
import { requireCommandAllowed, shouldBlockCommand } from "../dist/lib/permissions.js";
import { execInShellSession } from "../dist/lib/persistent-shell.js";
import { safeDelete } from "../dist/lib/safe-delete.js";
import { toolAnnotations } from "../dist/lib/tool-annotations.js";
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
  "unlink test.txt",
  "del /s test\\*",
  "erase /s test\\*",
  "Remove-Item test -Recurse -Force",
  'powershell -Command "Remove-Item test -Recurse -Force"',
  'powershell -c "& { Remove-Item test -Recurse -Force }"',
  'powershell -Command "Write-Output safe; Remove-Item test -Recurse -Force"',
  "powershell -EncodedCommand ZABlAGwA",
  "cmd /c rmdir /s /q test",
  String.raw`cmd.exe /d /c "rmdir /s /q \"$d\""`,
  'cmd /c "echo safe && rmdir /s /q test"',
  "cmd /c if exist test rmdir /s /q test",
  "cmd /c for /d %i in (*) do rmdir /s /q %i",
  "bash -c 'echo safe; rm -rf test'",
  `powershell -Command "Invoke-Expression 'Remove-Item test -Recurse -Force'"`,
  `powershell -Command "Start-Process cmd -ArgumentList '/c rmdir /s /q test'"`,
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
  "git rm -r src",
  "git stash clear",
  "git reflog expire --expire=now --all",
  "git gc --prune=now",
  "git branch -D old-branch",
  "git push --force origin main",
  "git push --force-with-lease origin main",
  "git push --delete origin main",
  "git push origin :main",
  "git push origin +main:main",
  "git tag -d old-tag",
  "git remote remove origin",
  "git worktree remove ../old-worktree",
  "git notes remove HEAD",
  "git submodule deinit -f --all",
  "diskpart /s wipe.txt",
  "format E: /q",
  "mkfs.ext4 /dev/sdb1",
  "wipefs -a /dev/sdb",
  "shred -u secret.txt",
  "dd if=/dev/zero of=/dev/sdb",
  "Clear-Content important.txt",
  "Clear-Disk -Number 1 -RemoveData",
  "robocopy source target /MIR",
  "rsync -a --delete source/ target/",
  "find . -delete",
  "xargs rm -rf",
  `python -c "import shutil; shutil.rmtree('test')"`,
  `python -c "__import__('shutil').rmtree('test')"`,
  `py -c "import os; os.unlink('test.txt')"`,
  `python -c "from pathlib import Path; Path('test.txt').unlink()"`,
  `node -e "require('fs').rmSync('test',{recursive:true,force:true})"`,
  `node -e "require('fs')['rmSync']('test',{recursive:true,force:true})"`,
  `node -e "require('node:fs').rmdirSync('test')"`,
  `[System.IO.File]::Delete('test.txt')`,
  `[System.IO.Directory]::Delete('test', $true)`,
  `powershell -Command "Invoke-Command -ScriptBlock 'Remove-Item test -Recurse -Force'"`,
  `start cmd /c del /q test.txt`,
  `$x='Remove-Item'; & $x test -Recurse -Force`,
  `powershell -Command "$x='Remove-Item'; & $x test -Recurse -Force"`,
  `& (Get-Command Remove-Item) test -Recurse -Force`,
  `Start-Process cmd -ArgumentList '/c','del /q test.txt'`,
  `Start-Process -FilePath powershell -ArgumentList '-Command','Remove-Item test -Recurse -Force'`,
  `cmd /v:on /c "set x=del&!x! /q test.txt"`,
  `cmd /c ^del /q test.txt`,
  `cmd /c @del /q test.txt`,
  `cmd /c "for %i in (test.txt) do @del /q %i"`,
  `bash -c 'x=rm; $x -rf test'`,
  `find . -exec rm -rf {} +`,
  `busybox rm -rf test`,
  `python -c "from shutil import rmtree; rmtree('test')"`,
  `python -c "import os as x; x.unlink('test')"`,
  `node -e "const {rmSync}=require('fs'); rmSync('test',{recursive:true})"`,
  `perl -e "unlink 'test.txt'"`,
  `ruby -e "File.delete('test.txt')"`,
  `php -r "unlink('test.txt');"`,
  `powershell -Command "(Get-Item test.txt).Delete()"`,
  `powershell -Command "[System.IO.FileInfo]::new('test.txt').Delete()"`,
  `Rem\`ove-Item test -Recurse -Force`,
  `r\`m test -Recurse -Force`,
  `powershell -Command "Rem\`ove-Item test -Recurse -Force"`,
  `& ${'${'}x} test`,
  `& ${'${'}env:TOOL} test`,
  `cmd /c "%TOOL% /q test.txt"`,
  `cmd /v:on /c "!TOOL! /q test.txt"`,
  `bash -c '$TOOL -rf test'`,
  `bash -c '${'${'}TOOL} -rf test'`,
  `bash -c '$(printf rm) -rf test'`,
  `bash -c '\`printf rm\` -rf test'`,
  `bash -c '\`rm -rf test\`'`,
  `python -c "import shutil as s; getattr(s,'rmtree')('test')"`,
  `python -c "import os; getattr(os,'unlink')('test')"`,
  `node -e "const f=require('fs'); f['rmSync']('test',{recursive:true})"`,
  `node -e "const f=require('fs'); const x='rmSync'; f[x]('test',{recursive:true})"`,
  `powershell -Command "& ([scriptblock]::Create('Remove-Item test -Recurse -Force'))"`,
  `powershell -Command "Invoke-Command -ScriptBlock ([scriptblock]::Create('Remove-Item test -Recurse -Force'))"`,
  `powershell -Command "Start-Process $env:ComSpec -ArgumentList '/c','del /q test.txt'"`,
  `bash -c "eval 'rm -rf test'"`,
  `bash -c 'x=rm; eval "$x -rf test"'`,
  `bash -c "x=rm; exec $x -rf test"`,
  `python -c "import os; vars(os)['unlink']('test')"`,
  `python -c "import os; os.__dict__['unlink']('test')"`,
  `python -c "import os; n='unlink'; getattr(os,n)('test')"`,
  `node -e "const {rmSync:r}=require('fs'); r('test',{recursive:true})"`,
  `node -e "const f=require('fs'); const n='r'+'mSync'; f[n]('test',{recursive:true})"`,
  `ruby -e "File.send(:delete,'test.txt')"`,
  `php -r "call_user_func('unlink','test.txt');"`,
  `python -c "import os; import operator; operator.methodcaller('unlink','test')(os)"`,
  `python -c "import os; f=os.unlink; f('test')"`,
  `node -e "const fs=require('fs'); Reflect.get(fs,'rmSync')('test',{recursive:true})"`,
  `node -e "const fs=require('fs'); fs.rmSync.bind(fs)('test',{recursive:true})"`,
  `node -e "const fs=require('fs'); const r=fs.rmSync; r('test',{recursive:true})"`,
  `ruby -e "File.method(:delete).call('test.txt')"`,
  `php -r "$f='unlink'; $f('test.txt');"`,
  `perl -e "$f='unlink'; &$f('test.txt');"`,
  `python -c "import os as x; f=x.unlink; f('test')"`,
  `python -c "from os import unlink as u; u('test')"`,
  `python -c "import shutil as s; f=s.rmtree; f('test')"`,
  `node -e "const q=require; const f=q('fs'); f.rmSync('test',{recursive:true})"`,
  `node -e "const r=require('fs').rmSync; r('test',{recursive:true})"`,
  `ruby -e "m=File.method(:delete); m.call('test.txt')"`,
  `ruby -e "m=:delete; File.send(m,'test.txt')"`,
  `php -r "$f='un'.'link'; $f('test.txt');"`,
  `perl -e "$f='un'.'link'; &$f('test.txt');"`,
  `powershell -Command "([System.IO.File].GetMethod('Delete')).Invoke($null,@('test.txt'))"`,
  `powershell -Command "Get-Item test.txt | ForEach-Object { $_.Delete() }"`,
  `powershell -Command "$x=Get-Item test.txt; $x.Delete()"`,
  `powershell -Command "$x=[System.IO.FileInfo]::new('test.txt'); $x.Delete()"`,
  `bash -c 'x=rm; command $x -rf test'`,
  `bash -c 'x=rm; env $x -rf test'`,
  `python -c "from os import unlink as u; f=u; f('test')"`,
  `python -c "import os as x; f=x.unlink; g=f; g('test')"`,
  `node -e "const f=require('fs'); const r=f.rmSync; const z=r; z('test',{recursive:true})"`,
  `node -e "const {rmSync}=require('fs'); const r=rmSync; r('test',{recursive:true})"`,
  `node -e "const m='fs'; const f=require(m); f.rmSync('test',{recursive:true})"`,
  `ruby -e "m=File.method(:delete); n=m; n.call('test.txt')"`,
  `php -r "$f='unlink'; $g=$f; $g('test.txt');"`,
  `perl -e "$f='unlink'; $g=$f; &$g('test.txt');"`,
  `powershell -Command "([System.IO.File].GetMethod(('De'+'lete'))).Invoke($null,@('test.txt'))"`,
  `python -c "import os; n='un'+'link'; f=getattr(os,n); f('test')"`,
  `python -c "import os; f=os.__dict__['unlink']; f('test')"`,
  `ruby -e "m=('de'+'lete').to_sym; File.send(m,'test.txt')"`,
  `php -r "$f=strrev('knilnu'); $f('test.txt');"`,
  `perl -e "$f=reverse('knilnu'); &$f('test.txt');"`,
  `powershell -Command "Get-Item test.txt | % { $_.PSObject.Methods['Delete'].Invoke() }"`,
  `powershell -Command "[System.IO.File].InvokeMember('Delete',[Reflection.BindingFlags]'Static,Public,InvokeMethod',$null,$null,@('test.txt'))"`,
  `python -c "import os; n=input(); getattr(os,n)()"`,
  `python -c "import os; n=input(); vars(os)[n]()"`,
  `node -e "const fs=require('fs'); const m=process.argv[1]; fs[m]('test')"`,
  `node -e "const fs=require('fs'); const m=process.argv[1]; Reflect.get(fs,m)('test')"`,
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

assert.equal(toolAnnotations("destructive").destructiveHint, true, "destructive tool metadata must stay explicit");
assert.equal(toolAnnotations("edit").readOnlyHint, false, "edit tools must never be mislabeled read-only");

for (const command of [
  "npm test",
  "git status --short",
  "git diff --check",
  "git clean -n",
  "git reset --mixed HEAD",
  "git reset --soft HEAD~1",
  "echo safe",
  "mv source target",
  "move source target",
  "ren source target",
  "rename source target",
  "Set-Content important.txt replacement",
  "Out-File important.txt",
  "Move-Item source target",
  "Rename-Item source target",
  "echo replacement > important.txt",
  "echo append >> safe.log",
  `powershell -Command "Set-Content important.txt replacement"`,
  `powershell -Command "Out-File important.txt"`,
  `powershell -Command "Start-Process notepad.exe -ArgumentList README.md"`,
  `powershell -Command "Invoke-Command -ScriptBlock { Write-Output safe }"`,
  `start notepad.exe README.md`,
  'echo "rm -rf test"',
  "cmd /c echo rm -rf test",
  'powershell -Command "Write-Output rm -rf test"',
  'powershell -Command "Write-Output \'Remove-Item test -Recurse -Force\'"',
  `echo '${'${'}TOOL}'`,
  `echo '$(rm -rf test)'`,
  `$env:OPENAI_API_KEY='sk-test-secret'; Write-Output safe`,
  `$x='safe'; Write-Output safe`,
  `$x=[ordered]@{a=$true;b=$false}; $x | ConvertTo-Json`,
  `$checks=[ordered]@{version='3.5.5';ok=$true}; $checks | ConvertTo-Json`,
  'git grep -n "rm -rf"',
  'git -C . clean -n',
  `python -c "print('shutil.rmtree(test)')"`,
  `python -c "cache.unlink('key')"`,
  `node -e "console.log('fs.rmSync(test)')"`,
  `node -e "cache.rmSync('key')"`,
  `python -c "import os; print(os.getcwd())"`,
  `node -e "const fs=require('fs'); console.log(fs.readFileSync('README.md','utf8').length)"`,
  `bash -c "exec echo safe"`,
  `python -c "import os; f=os.getcwd; print(f())"`,
  `node -e "const fs=require('fs'); const r=fs.readFileSync; console.log(r('README.md','utf8').length)"`,
  `ruby -e "puts File.method(:basename).call('/tmp/x')"`,
  `php -r "$f='strlen'; echo $f('safe');"`,
  `python -c "import os as x; f=x.getcwd; print(f())"`,
  `node -e "const q=require; const f=q('fs'); console.log(f.readFileSync('README.md','utf8').length)"`,
  `ruby -e "m=File.method(:basename); puts m.call('/tmp/x')"`,
  `php -r "$f='str'.'len'; echo $f('safe');"`,
  `powershell -Command "$x=[Custom.Store]::new(); $x.Delete('key')"`,
  `bash -c 'x=echo; command $x safe'`,
  `python -c "from os import getcwd as u; f=u; print(f())"`,
  `node -e "const f=require('fs'); const r=f.readFileSync; const z=r; console.log(z('README.md','utf8').length)"`,
  `python -c "import os; f=getattr(os,'getcwd'); print(f())"`,
  `ruby -e "m=:basename; puts File.send(m,'/tmp/x')"`,
  `python -c "import os; print(getattr(os,'getcwd')())"`,
  `python -c "import os; print(vars(os)['getcwd']())"`,
  `node -e "const fs=require('fs'); console.log(fs['readFileSync']('README.md','utf8').length)"`,
  `node -e "const fs=require('fs'); console.log(Reflect.get(fs,'readFileSync')('README.md','utf8').length)"`,
  `[Custom.Store]::Delete('key')`,
  `widget.delete()`,
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

  // A broader parent of a workspace is equally dangerous: recursive deletion of
  // the parent would encompass the workspace. Keep the ancestor itself disposable.
  const nestedWorkspace = path.join(root, "nested-workspace");
  await fs.mkdir(nestedWorkspace);
  setWorkspaceRoots([nestedWorkspace]);
  await assert.rejects(
    safeDelete(root, root),
    /SAFE_DELETE_PROTECTED_TARGET.*workspace root or ancestor/i,
    "workspace ancestor was deletable",
  );
  setWorkspaceRoots([root]);

  const incidentTarget = path.join(root, "incident-target");
  await fs.mkdir(incidentTarget);
  await fs.writeFile(path.join(incidentTarget, "must-survive.txt"), "survive\n");
  const incidentCommand = String.raw`cmd.exe /d /c "rmdir /s /q \"${incidentTarget}\""`;
  await assert.rejects(
    execInShellSession(incidentCommand, root, 1000, root),
    /BLOCKED_DESTRUCTIVE_COMMAND/,
    "persistent-shell choke point allowed the historical malformed rmdir chain",
  );
  assert.equal((await fs.stat(incidentTarget)).isDirectory(), true, "blocked incident command mutated its target");
  await assert.rejects(
    safeDelete(path.parse(root).root),
    /SAFE_DELETE_PROTECTED_TARGET.*root/i,
    "drive/filesystem root was deletable",
  );
  await assert.rejects(
    safeDelete(os.homedir()),
    /SAFE_DELETE_PROTECTED_TARGET.*(?:home|workspace root or ancestor)/i,
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

  for (const harnessPath of [
    path.join(os.homedir(), ".codex"),
    path.join(os.homedir(), ".agents", "skills", "cross-project-delivery"),
    path.join(os.homedir(), ".agents", "retired", "global-harness-history"),
  ]) {
    await assert.rejects(
      safeDelete(harnessPath, harnessPath),
      /SAFE_DELETE_PROTECTED_TARGET.*canonical harness/i,
      `canonical harness target was not protected: ${harnessPath}`,
    );
  }

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
