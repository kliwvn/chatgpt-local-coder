import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const RECYCLE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('CLC_MANAGER_RECYCLE_TARGET', 'Process')
if ([string]::IsNullOrWhiteSpace($target)) { throw 'Missing recycle target' }
$root = [IO.Path]::GetPathRoot($target)
if ([string]::IsNullOrWhiteSpace($root)) { throw 'Recycle target has no drive root' }
$driveType = [IO.DriveInfo]::new($root).DriveType
if ($driveType -ne [IO.DriveType]::Fixed) { throw "Only fixed local drives are accepted for managed Recycle Bin deletion (driveType=$driveType)" }
# Load the framework assembly instead of compiling C# via Add-Type -TypeDefinition
# for every delete. Recompilation introduced multi-second jitter in Manager HTTP
# lifecycle requests even though the actual Recycle Bin operation was fast.
Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
  $target,
  [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
  [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
  [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException
)
`;

const RECYCLE_TIMEOUT_MS = 15_000;
const RECYCLE_STDERR_MAX_CHARS = 16_384;

function identity(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function recycleManagedDirectory(target, allowedParent) {
  const requested = path.resolve(target);
  const parent = path.resolve(allowedParent);
  if (identity(path.dirname(requested)) !== identity(parent)) {
    throw new Error(`Refusing managed delete outside exact parent: ${requested}`);
  }
  const stat = await fs.lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing managed delete for non-directory or alias: ${requested}`);
  }
  const real = path.resolve(await fs.realpath(requested));
  if (identity(real) !== identity(requested)) {
    throw new Error(`Refusing managed delete through reparse/alias boundary: ${requested} -> ${real}`);
  }
  if (process.platform !== "win32") {
    throw new Error("Permanent managed-instance deletion is disabled; Recycle Bin integration is currently Windows-only");
  }

  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", RECYCLE_SCRIPT], {
      windowsHide: true,
      env: { ...process.env, CLC_MANAGER_RECYCLE_TARGET: requested },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (err = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    child.stderr.on("data", (chunk) => {
      if (stderr.length < RECYCLE_STDERR_MAX_CHARS) {
        stderr += String(chunk).slice(0, RECYCLE_STDERR_MAX_CHARS - stderr.length);
      }
    });
    child.once("error", (err) => finish(err));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`Recycle Bin operation failed (exit=${code ?? "unknown"}): ${stderr.trim() || "unknown error"}`));
    });
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(new Error(`Recycle Bin operation timed out after ${RECYCLE_TIMEOUT_MS}ms`));
    }, RECYCLE_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    await fs.lstat(requested);
    throw new Error(`Managed directory still exists after recycle operation: ${requested}`);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}
