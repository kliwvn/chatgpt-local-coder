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

function trustedCanonicalContextPath(inputPath: string, expectedKind: "directory" | "file"): string | null {
  const lexical = path.resolve(inputPath);
  try {
    const info = fs.lstatSync(lexical);
    if (info.isSymbolicLink()) return null;
    if (expectedKind === "directory" ? !info.isDirectory() : !info.isFile()) return null;

    const canonical = fs.realpathSync.native(lexical);
    // A canonical Harness context surface must not be an alias/reparse entry that
    // silently widens a narrow allowlist to another tree or unrelated file.
    if (!sameCanonicalPath(lexical, canonical)) return null;
    return canonical;
  } catch {
    return null;
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

/** FULL_DISK_ACCESS=true mở ordinary path/process authority ra toàn máy; false giữ workspace boundary, trừ read_text_file Global Harness context exception được validate riêng. */
export function getFullDiskAccess(): boolean {
  return process.env.FULL_DISK_ACCESS === "true";
}

function isWithinRoot(root: string, resolved: string): boolean {
  const rel = path.relative(root, resolved);
  // Windows: so sánh không phân biệt hoa thường (E:\ == e:\)
  const norm = process.platform === "win32" ? rel.toLowerCase() : rel;
  return norm === "" || (norm !== ".." && !norm.startsWith(`..${path.sep}`) && !path.isAbsolute(norm));
}

function isWithinWorkspace(resolved: string): boolean {
  return workspaceRoots.some((root) => isWithinRoot(root, resolved));
}

export function getContextReadRoots(): string[] {
  // Only the two owned read-only subtrees are context roots. The ~/.agents
  // parent may contain unrelated/retired execution-environment state and must
  // not become readable merely because the Harness bootstrap lives beside it.
  return [
    path.join(os.homedir(), ".agents", "global-harness"),
    path.join(os.homedir(), ".agents", "skills"),
  ]
    .map((candidate) => trustedCanonicalContextPath(candidate, "directory"))
    .filter((candidate): candidate is string => candidate !== null);
}

export function getContextReadFiles(): string[] {
  // Do not authorize the whole ~/.agents or ~/.codex directory: both may contain
  // unrelated runtime/history/config material. Only exact canonical bootstrap /
  // continuity text files are readable outside the workspace.
  return [
    path.join(os.homedir(), ".agents", "AGENTS.md"),
    path.join(os.homedir(), ".codex", "AGENTS.md"),
    path.join(os.homedir(), ".codex", "GLOBAL_IMPLEMENTATION_NOTES.md"),
  ]
    .map((candidate) => trustedCanonicalContextPath(candidate, "file"))
    .filter((candidate): candidate is string => candidate !== null);
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
 * Validate one path against an explicit request-local root set.
 *
 * Unlike validatePath(), this boundary is enforced even when FULL_DISK_ACCESS
 * is enabled. Callers use it for automatically loaded project-controlled
 * context where trusted full-machine authority must not silently widen the
 * scope selected for that individual load.
 *
 * The supplied roots are never written into process-global workspace state, so
 * concurrent MCP sessions can validate different project contexts safely.
 */
export async function validatePathWithinRoots(inputPath: string, roots: string[]): Promise<string> {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Path is empty");
  if (!roots.length) throw new Error("Explicit workspace root set is empty");

  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(defaultCwd, trimmed);
  const canonical = await canonicalizeForBoundary(resolved);
  const canonicalRoots = roots.map(canonicalizeExistingSync);
  if (!canonicalRoots.some((root) => isWithinRoot(root, canonical))) {
    throw new Error(
      `Path nằm ngoài explicit workspace roots (${canonicalRoots.join("; ")}): ${canonical}.`
    );
  }
  return canonical;
}

/**
 * Read-only context exception for canonical user-global Harness surfaces.
 * This exists so the canonical ~/.agents/AGENTS.md bootstrap can selectively load
 * Global Harness modules, skill bodies, plus allowlisted Harness-owned ~/.codex text when
 * needed, even while FULL_DISK_ACCESS=false. It intentionally does not widen
 * write, shell, Git, hook, upstream, or project authority: those paths continue
 * to use validatePath().
 */
export async function validateContextReadPath(inputPath: string): Promise<string> {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Path is empty");

  // Global Harness references are intentionally written in portable ~/ form.
  // Expand only for this read-only context adapter; ordinary project/mutation
  // paths retain their existing workspace-relative semantics.
  const expanded = trimmed === "~"
    ? os.homedir()
    : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed;
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(defaultCwd, expanded);
  const canonical = await canonicalizeForBoundary(resolved);

  if (getFullDiskAccess() || isWithinWorkspace(canonical)) return canonical;
  if (getContextReadRoots().some((root) => isWithinRoot(root, canonical))) return canonical;
  if (getContextReadFiles().some((file) => sameCanonicalPath(file, canonical))) return canonical;

  throw new Error(
    `Path nằm ngoài workspace (${workspaceRoots.join("; ")}): ${canonical}. ` +
      "Chỉ read_text_file được phép đọc chọn lọc canonical Global Harness context " +
      "(~/.agents/AGENTS.md, ~/.agents/global-harness/**, ~/.agents/skills/** và các file text ~/.codex được allowlist); " +
      "bật FULL_DISK_ACCESS=true nếu muốn truy cập ngoài các phạm vi này."
  );
}

/**
 * Resolve an explicit project-context root.
 *
 * In strict mode, context switching is narrower than ordinary file access: the
 * target must equal a configured workspace root. A broad collection root does
 * not silently authorize child repositories as independent context owners.
 *
 * In trusted FULL_DISK_ACCESS mode, WORKSPACE_PATH is only the default
 * project/cwd. The user may explicitly target another repository without
 * pre-registering it in EXTRA_WORKSPACE_PATHS, so any canonical existing
 * directory is a valid project-context root.
 */
export async function validateConfiguredWorkspaceRoot(inputPath: string): Promise<string> {
  const canonical = await validatePath(inputPath);
  const stat = await fsp.stat(canonical).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`PROJECT_CONTEXT_INVALID_ROOT: ${canonical} is not an existing directory.`);
  }
  if (getFullDiskAccess()) return canonical;
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
