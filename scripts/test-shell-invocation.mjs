import assert from "node:assert/strict";

const previousFullDisk = process.env.FULL_DISK_ACCESS;
try {
  const { buildShellProcessInvocation } = await import("../dist/lib/persistent-shell.js");

  process.env.FULL_DISK_ACCESS = "false";
  const strict = buildShellProcessInvocation("git status --short");
  if (process.platform === "win32") {
    assert.equal(strict.executable.toLowerCase(), "powershell.exe");
    const strictCommand = strict.args.at(-1) ?? "";
    assert.match(strictCommand, /Get-Command git\.exe/);
    assert.match(strictCommand, /Push-Location \$drive/);
    assert.match(strictCommand, /-C \$target @args/);
    assert.match(strictCommand, /git status --short/);
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
