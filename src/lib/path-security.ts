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

function sameCanonicalPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function hasGitMarker(root: string): Promise<boolean> {
  try {
    await fsp.lstat(path.join(root, ".git"));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export interface WorkspaceScopeInspection {
  root: string;
  project_root: boolean;
  child_repo_roots: string[];
  ambiguous_collection_root: boolean;
}

/**
 * Detect a common scope-authority mistake: configuring a directory that is not
 * itself a Git project but is merely a parent/container of one or more Git
 * repositories. Such a root turns a strict workspace sandbox into broad access
 * across independent projects. Monorepos remain valid because their root owns
 * its own .git marker.
 */
export async function inspectWorkspaceRootScope(inputPath: string): Promise<WorkspaceScopeInspection> {
  const root = await fsp.realpath(path.resolve(inputPath));
  if (await hasGitMarker(root)) {
    return { root, project_root: true, child_repo_roots: [], ambiguous_collection_root: false };
  }

  const childRepoRoots: string[] = [];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const child = path.join(root, entry.name);
    if (await hasGitMarker(child)) {
      childRepoRoots.push(child);
      if (childRepoRoots.length >= 8) break;
    }
  }
  return {
    root,
    project_root: false,
    child_repo_roots: childRepoRoots,
    ambiguous_collection_root: childRepoRoots.length >= 1,
  };
}

export async function assertWorkspaceRootsUnambiguous(roots: string[]): Promise<void> {
  for (const root of roots) {
    const inspection = await inspectWorkspaceRootScope(root);
    if (!inspection.ambiguous_collection_root) continue;
    const examples = inspection.child_repo_roots.slice(0, 4).join("; ");
    throw new Error(
      `WORKSPACE_SCOPE_AMBIGUOUS: ${inspection.root} is a collection root containing multiple independent repositories` +
        `${examples ? ` (${examples})` : ""}. Set WORKSPACE_PATH to the exact primary project root and add only explicitly intended project roots via EXTRA_WORKSPACE_PATHS.`
    );
  }
}

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

/**
 * Context switching is narrower than ordinary file access: an explicit project
 * context target must equal a configured workspace root. Being a descendant of
 * a broad parent is not enough, otherwise a collection root can silently turn
 * into cross-repository authority.
 */
export async function validateConfiguredWorkspaceRoot(inputPath: string): Promise<string> {
  const canonical = await validatePath(inputPath);
  if (!workspaceRoots.some((root) => sameCanonicalPath(root, canonical))) {
    throw new Error(
      `PROJECT_CONTEXT_SCOPE_DENIED: ${canonical} is not an explicitly configured workspace root. ` +
        "Use WORKSPACE_PATH for the primary project or add the exact root to EXTRA_WORKSPACE_PATHS before starting Local Coder."
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
