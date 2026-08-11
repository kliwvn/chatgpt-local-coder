import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDefaultCwd, getWorkspaceRoots } from "./path-security.js";

const WINDOWS_RECYCLE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('CLC_SAFE_DELETE_TARGET', 'Process')
if ([string]::IsNullOrWhiteSpace($target)) { throw 'Missing CLC_SAFE_DELETE_TARGET' }
$source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class ClcRecycleBin {
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
  public static int MoveToRecycleBin(string target, out bool aborted) {
    const uint FO_DELETE = 3;
    const ushort FOF_SILENT = 0x0004;
    const ushort FOF_NOCONFIRMATION = 0x0010;
    const ushort FOF_ALLOWUNDO = 0x0040;
    const ushort FOF_NOERRORUI = 0x0400;
    var op = new SHFILEOPSTRUCT {
      wFunc = FO_DELETE,
      pFrom = target + "\0\0",
      pTo = null,
      fFlags = FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI
    };
    int rc = SHFileOperation(ref op);
    aborted = op.fAnyOperationsAborted;
    return rc;
  }
}
'@
if (-not ('ClcRecycleBin' -as [type])) { Add-Type -TypeDefinition $source }
$driveType = [ClcRecycleBin]::TargetDriveType($target)
if ($driveType -ne 3) { throw "SAFE_DELETE_UNSUPPORTED_VOLUME: only fixed local drives are accepted (driveType=$driveType)" }
$aborted = $false
$rc = [ClcRecycleBin]::MoveToRecycleBin($target, [ref]$aborted)
if ($rc -ne 0 -or $aborted) { throw "Recycle Bin operation failed (rc=$rc, aborted=$aborted)" }
`;

export interface SafeDeleteResult {
  path: string;
  mode: "recycle_bin";
}

function identity(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(a: string, b: string): boolean {
  return identity(a) === identity(b);
}

function sameOrDescendant(candidate: string, parent: string): boolean {
  const childId = identity(candidate);
  const parentId = identity(parent);
  if (childId === parentId) return true;
  const rel = path.relative(parentId, childId);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function canonicalHarnessTargets(): string[] {
  const home = path.resolve(os.homedir());
  return [
    path.join(home, ".codex"),
    path.join(home, ".codex", "AGENTS.md"),
    path.join(home, ".agents"),
    path.join(home, ".agents", "skills", "cross-project-delivery"),
    path.join(home, ".agents", "retired", "global-harness-history"),
  ];
}

function resolveRequestedPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("SAFE_DELETE_PROTECTED_TARGET: empty path");
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(getDefaultCwd(), trimmed);
}

async function canonicalExisting(input: string): Promise<string> {
  return path.resolve(await fsp.realpath(path.resolve(input)));
}

async function findRepoRoot(start: string): Promise<string | null> {
  let cursor = start;
  while (true) {
    try {
      await fsp.lstat(path.join(cursor, ".git"));
      return cursor;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

async function assertSafeDeleteTarget(requestedPath: string, canonicalTarget?: string): Promise<string> {
  const requested = resolveRequestedPath(requestedPath);
  const requestedStat = await fsp.lstat(requested);
  if (requestedStat.isSymbolicLink()) {
    throw new Error(`SAFE_DELETE_PROTECTED_TARGET: refusing symlink/junction/reparse alias: ${requested}`);
  }

  const realRequested = await canonicalExisting(requested);
  if (!samePath(requested, realRequested)) {
    throw new Error(`SAFE_DELETE_PROTECTED_TARGET: target resolves through an alias/reparse boundary: ${requested} -> ${realRequested}`);
  }
  const canonical = canonicalTarget ? await canonicalExisting(canonicalTarget) : realRequested;
  if (!samePath(canonical, realRequested)) {
    throw new Error(`SAFE_DELETE_PROTECTED_TARGET: canonical target mismatch: ${requested} -> ${realRequested}, expected ${canonical}`);
  }

  if (samePath(canonical, path.parse(canonical).root)) {
    throw new Error(`SAFE_DELETE_PROTECTED_TARGET: refusing filesystem/drive root: ${canonical}`);
  }
  for (const workspaceRoot of getWorkspaceRoots()) {
    const protectedRoot = await canonicalExisting(workspaceRoot).catch(() => path.resolve(workspaceRoot));
    // Protect both the configured workspace itself and every ancestor that would
    // recursively encompass it. This prevents a malformed/broadened target such
    // as F:\\AI_Home from deleting F:\\AI_Home\\chatgpt-local-coder.
    if (samePath(canonical, protectedRoot) || sameOrDescendant(protectedRoot, canonical)) {
      throw new Error(`SAFE_DELETE_PROTECTED_TARGET: refusing workspace root or ancestor: ${canonical}`);
    }
  }

  const home = await canonicalExisting(os.homedir()).catch(() => path.resolve(os.homedir()));
  if (samePath(canonical, home) || samePath(canonical, path.dirname(home))) {
    throw new Error(`SAFE_DELETE_PROTECTED_TARGET: refusing user home/home-container root: ${canonical}`);
  }

  for (const harnessTarget of canonicalHarnessTargets()) {
    // Protect the canonical harness target itself and any broader target that
    // would recursively encompass it (for example ~/.agents/skills).
    if (samePath(canonical, harnessTarget) || sameOrDescendant(harnessTarget, canonical)) {
      throw new Error(`SAFE_DELETE_PROTECTED_TARGET: refusing canonical harness root/ancestor: ${canonical}`);
    }
  }

  const repoRoot = await findRepoRoot(requestedStat.isDirectory() ? canonical : path.dirname(canonical));
  const gitMetadataRoot = repoRoot ? path.join(repoRoot, ".git") : null;
  if (repoRoot && (samePath(canonical, repoRoot) || (gitMetadataRoot && sameOrDescendant(canonical, gitMetadataRoot)))) {
    throw new Error(`SAFE_DELETE_PROTECTED_TARGET: refusing repository root or .git metadata: ${canonical}`);
  }
  return canonical;
}

async function recycleWindows(target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_RECYCLE_SCRIPT], {
      windowsHide: true,
      env: { ...process.env, CLC_SAFE_DELETE_TARGET: target },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 16_384) stderr += String(chunk).slice(0, 16_384 - stderr.length);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Recycle Bin operation failed (exit=${code ?? "unknown"}): ${stderr.trim() || "unknown error"}`));
    });
  });
}

export async function safeDelete(requestedPath: string, canonicalTarget?: string): Promise<SafeDeleteResult> {
  const target = await assertSafeDeleteTarget(requestedPath, canonicalTarget);
  if (process.platform !== "win32") {
    throw new Error("SAFE_DELETE_UNSUPPORTED: permanent deletion is disabled and Recycle Bin integration is currently implemented only on Windows");
  }
  // Narrow the alias-swap window by revalidating immediately before invoking
  // the OS recycle operation. The operation remains path-based, so this is an
  // application guard rather than a filesystem transaction/OS sandbox.
  await assertSafeDeleteTarget(target, target);
  await recycleWindows(target);
  try {
    await fsp.lstat(target);
    throw new Error(`SAFE_DELETE_FAILED: target still exists after Recycle Bin operation: ${target}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { path: target, mode: "recycle_bin" };
}
