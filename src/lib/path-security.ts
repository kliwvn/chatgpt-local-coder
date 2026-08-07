import fs from "fs";
import path from "path";
import os from "os";

let defaultCwd = process.cwd();
let workspaceRoots: string[] = [defaultCwd];

export function setDefaultCwd(cwd: string): void {
  defaultCwd = path.resolve(cwd);
}

export function getDefaultCwd(): string {
  return defaultCwd;
}

/** Đăng ký danh sách thư mục workspace — ranh giới truy cập khi fullDiskAccess tắt. */
export function setWorkspaceRoots(roots: string[]): void {
  const resolved = roots.map((r) => path.resolve(r));
  workspaceRoots = resolved.length > 0 ? resolved : [defaultCwd];
}

export function getWorkspaceRoots(): string[] {
  return workspaceRoots;
}

/** Returns default working directory, not an access boundary */
export function getAllowedRoots(): string[] {
  return [defaultCwd];
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

export async function validatePath(inputPath: string): Promise<string> {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Path is empty");

  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(defaultCwd, trimmed);

  if (!getFullDiskAccess() && !isWithinWorkspace(resolved)) {
    throw new Error(
      `Path nằm ngoài workspace (${workspaceRoots.join("; ")}): ${resolved}. ` +
        "Bật FULL_DISK_ACCESS=true trong .env nếu muốn truy cập toàn máy."
    );
  }
  return resolved;
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
