import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const RECYCLE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('CLC_MANAGER_RECYCLE_TARGET', 'Process')
if ([string]::IsNullOrWhiteSpace($target)) { throw 'Missing recycle target' }
$source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class ClcManagerRecycleBin {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct SHFILEOPSTRUCT {
    public IntPtr hwnd;
    public uint wFunc;
    [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
    [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
    public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
    public IntPtr hNameMappings;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  private static extern int SHFileOperation(ref SHFILEOPSTRUCT fileOp);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  private static extern uint GetDriveType(string rootPathName);
  public static uint TargetDriveType(string target) {
    var root = Path.GetPathRoot(target);
    return String.IsNullOrWhiteSpace(root) ? 1u : GetDriveType(root);
  }
  public static int Recycle(string target, out bool aborted) {
    var op = new SHFILEOPSTRUCT {
      wFunc = 3,
      pFrom = target + "\0\0",
      pTo = null,
      fFlags = 0x0004 | 0x0010 | 0x0040 | 0x0400
    };
    int rc = SHFileOperation(ref op);
    aborted = op.fAnyOperationsAborted;
    return rc;
  }
}
'@
if (-not ('ClcManagerRecycleBin' -as [type])) { Add-Type -TypeDefinition $source }
$driveType = [ClcManagerRecycleBin]::TargetDriveType($target)
if ($driveType -ne 3) { throw "Only fixed local drives are accepted for managed Recycle Bin deletion (driveType=$driveType)" }
$aborted = $false
$rc = [ClcManagerRecycleBin]::Recycle($target, [ref]$aborted)
if ($rc -ne 0 -or $aborted) { throw "Recycle Bin operation failed (rc=$rc, aborted=$aborted)" }
`;

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
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += String(chunk).slice(0, 16_384 - stderr.length);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Recycle Bin operation failed (exit=${code ?? "unknown"}): ${stderr.trim() || "unknown error"}`));
    });
  });

  try {
    await fs.lstat(requested);
    throw new Error(`Managed directory still exists after recycle operation: ${requested}`);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}
