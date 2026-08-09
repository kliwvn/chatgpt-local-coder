import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

function canonicalizeExistingSync(inputPath: string): string {
  const absolute = path.resolve(inputPath);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

let defaultCwd = canonicalizeExistingSync(process.cwd());
let workspaceRoots: string[] = [defaultCwd];

export function setDefaultCwd(cwd: string): void {
  defaultCwd = canonicalizeExistingSync(cwd);
}

export function getDefaultCwd(): string {
  return defaultCwd;
}

/** Đăng ký danh sách thư mục workspace — ranh giới truy cập khi fullDiskAccess tắt. */
export function setWorkspaceRoots(roots: string[]): void {
  const resolved = roots.map(canonicalizeExistingSync);
  workspaceRoots = resolved.length > 0 ? resolved : [defaultCwd];
}

export function getWorkspaceRoots(): string[] {
  return workspaceRoots;
}

/** Returns the canonical default search root when sandboxed. */
export function getAllowedRoots(): string[] {
  return getFullDiskAccess() ? [defaultCwd] : [workspaceRoots[0] ?? defaultCwd];
}

/** FULL_DISK_ACCESS=true mở lại toàn quyền máy; mặc định false = chỉ truy cập workspace roots. */
export function getFullDiskAccess(): boolean {
  return process.env.FULL_DISK_ACCESS === "true";
}

function isWithinWorkspace(resolved: string): boolean {
  for (const root of workspaceRoots) {
    const rel = path.relative(root, resolved);
    // Windows: so sánh không phân biệt hoa thường (E:\ == e:\)
    const norm = process.platform === "win32" ? rel.toLowerCase() : rel;
    if (norm === "" || (norm !== ".." && !norm.startsWith(`..${path.sep}`) && !path.isAbsolute(norm))) {
      return true;
    }
  }
  return false;
}

async function canonicalizeForBoundary(resolved: string): Promise<string> {
  let cursor = resolved;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const real = await fsp.realpath(cursor);
      return path.resolve(real, ...missingSegments);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;

      const parent = path.dirname(cursor);
      if (parent === cursor) throw err;
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function validatePath(inputPath: string): Promise<string> {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Path is empty");

  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(defaultCwd, trimmed);

  // Canonicalize in both sandboxed and full-disk modes so aliases that resolve to
  // the same filesystem object share one identity. This is required for the
  // mutation scheduler/checkpoint layer: otherwise a real path and a junction or
  // symlink alias can bypass same-file locking when FULL_DISK_ACCESS=true.
  // For create paths, canonicalize the nearest existing ancestor and retain the
  // missing suffix so the returned path is stable before the target exists.
  const canonical = await canonicalizeForBoundary(resolved);

  if (getFullDiskAccess()) return canonical;

  if (!isWithinWorkspace(canonical)) {
    throw new Error(
      `Path nằm ngoài workspace (${workspaceRoots.join("; ")}): ${canonical}. ` +
        "Bật FULL_DISK_ACCESS=true trong .env nếu muốn truy cập toàn máy."
    );
  }
  return canonical;
}

export function getMachineRoots(): string[] {
  if (!getFullDiskAccess()) return workspaceRoots;
  if (process.platform === "win32") {
    const drives: string[] = [];
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      try {
        fs.accessSync(`${letter}:\\`, fs.constants.R_OK);
        drives.push(`${letter}:\\`);
      } catch {}
    }
    return drives.length ? drives : ["C:\\"];
  }
  return ["/", os.homedir()];
}
