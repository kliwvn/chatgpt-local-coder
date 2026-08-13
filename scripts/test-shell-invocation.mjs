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
      timeout: 15_000,
    });
    assert.equal(executed.error, undefined, executed.error?.message);
    assert.equal(executed.status, 0, `strict Git shim exited ${executed.status}`);
  }

  process.env.FULL_DISK_ACCESS = "true";
  const trusted = buildShellProcessInvocation("git status --short");
  const trustedCommand = trusted.args.at(-1) ?? "";
  assert.doesNotMatch(trustedCommand, /__clcRealGit/);
  assert.match(trustedCommand, /git status --short/);

  console.log("shell-invocation: ok (strict Git shim isolated from trusted mode)");
} finally {
  if (previousFullDisk === undefined) delete process.env.FULL_DISK_ACCESS;
  else process.env.FULL_DISK_ACCESS = previousFullDisk;
}
