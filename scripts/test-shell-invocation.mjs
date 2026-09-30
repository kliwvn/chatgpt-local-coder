import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const previousFullDisk = process.env.FULL_DISK_ACCESS;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const { buildShellProcessInvocation } = await import("../dist/lib/persistent-shell.js");

  process.env.FULL_DISK_ACCESS = "false";
  const strict = buildShellProcessInvocation("git status --short");
  if (process.platform === "win32") {
    assert.equal(strict.executable.toLowerCase(), "powershell.exe");
    const strictCommand = strict.args.at(-1) ?? "";
    assert.match(strictCommand, /Get-Command git\.exe/);
    assert.match(strictCommand, /Join-Path \$probe '\.git'/);
    assert.match(strictCommand, /'--git-dir=' \+ \$gitDir/);
    assert.match(strictCommand, /'--work-tree=' \+ \$repoRoot/);
    assert.match(strictCommand, /Set-Location -LiteralPath \$drive/);
    assert.match(strictCommand, /\[Environment\]::CurrentDirectory\s*=\s*\$drive/);
    assert.match(strictCommand, /git status --short/);
    const executed = spawnSync(strict.executable, strict.args, {
      cwd: repoRoot,
      stdio: "inherit",
      windowsHide: true,
      timeout: 60_000,
    });
    assert.equal(executed.error, undefined, executed.error?.message);
    assert.equal(executed.status, 0, `strict Git shim exited ${executed.status}`);

  }

  process.env.FULL_DISK_ACCESS = "true";
  const trusted = buildShellProcessInvocation("git status --short");
  if (process.platform === "win32") {
    assert.match(path.basename(trusted.executable).toLowerCase(), /^git(?:\.exe)?$/);
    assert.deepEqual(trusted.args, ["status", "--short"]);
    assert.equal(trusted.strategy, "direct_exec");

    const explicitCmd = buildShellProcessInvocation("cmd /d /c echo CLC_FAST_PATH");
    assert.match(explicitCmd.executable.toLowerCase(), /cmd\.exe$/);
    assert.equal(explicitCmd.strategy, "cmd_fast");

    const simpleNode = buildShellProcessInvocation("node scripts/test-tools.mjs");
    assert.match(path.basename(simpleNode.executable).toLowerCase(), /^node(?:\.exe)?$/);
    assert.deepEqual(simpleNode.args, ["scripts/test-tools.mjs"]);
    assert.equal(simpleNode.strategy, "direct_exec");

    // Direct exec should preserve ordinary quoted argv without paying a shell
    // startup penalty. Shell metacharacters still require PowerShell fallback.
    const quotedNode = buildShellProcessInvocation('node -p "40+2"');
    assert.match(path.basename(quotedNode.executable).toLowerCase(), /^node(?:\.exe)?$/);
    assert.deepEqual(quotedNode.args, ["-p", "40+2"]);
    assert.equal(quotedNode.strategy, "direct_exec");
    const quotedNodeRun = spawnSync(quotedNode.executable, quotedNode.args, {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(quotedNodeRun.error, undefined, quotedNodeRun.error?.message);
    assert.equal(quotedNodeRun.status, 0);
    assert.equal(quotedNodeRun.stdout.trim(), "42");

    const npm = buildShellProcessInvocation("npm run build");
    assert.match(npm.executable.toLowerCase(), /cmd\.exe$/);
    assert.equal(npm.strategy, "cmd_fast");

    const redirected = buildShellProcessInvocation("node script.mjs > out.txt");
    assert.equal(redirected.executable.toLowerCase(), "powershell.exe");

    const powershellSyntax = buildShellProcessInvocation("Write-Output $env:TEMP");
    assert.equal(powershellSyntax.executable.toLowerCase(), "powershell.exe");
    assert.match(powershellSyntax.args.at(-1) ?? "", /Write-Output \$env:TEMP/);
  } else {
    assert.equal(trusted.executable, "bash");
    assert.match(trusted.args.at(-1) ?? "", /git status --short/);
  }

  console.log("shell-invocation: ok (strict Git shim + trusted Windows fast path)");
} finally {
  if (previousFullDisk === undefined) delete process.env.FULL_DISK_ACCESS;
  else process.env.FULL_DISK_ACCESS = previousFullDisk;
}
