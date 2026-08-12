import fs from "node:fs/promises";
import path from "node:path";

function identity(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function workspacePathParts(value) {
  return String(value || "")
    .split(";")
    .map((part) => part.trim().replace(/^['\"]|['\"]$/g, ""))
    .filter(Boolean);
}

export function configuredPrimaryWorkspaceRootsFromEnv(env, baseDir) {
  return workspacePathParts(env?.WORKSPACE_PATH).map((raw) =>
    path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(baseDir, raw)
  );
}

async function hasGitMarker(root) {
  try {
    await fs.lstat(path.join(root, ".git"));
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

export function configuredWorkspaceRootsFromEnv(env, baseDir) {
  const values = [
    ...workspacePathParts(env?.WORKSPACE_PATH),
    ...workspacePathParts(env?.EXTRA_WORKSPACE_PATHS),
  ];
  const roots = [];
  const seen = new Set();
  for (const value of values) {
    const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseDir, value);
    const key = identity(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(resolved);
  }
  return roots;
}

/**
 * A strict workspace root may be a Git project (including a monorepo) or a
 * non-Git project directory. It must not be a parent/container that merely
 * grants access to one or more child Git repositories.
 */
export async function inspectManagedWorkspaceRoot(inputPath) {
  const root = await fs.realpath(path.resolve(inputPath));
  if (await hasGitMarker(root)) {
    return { root, projectRoot: true, childRepoRoots: [], ambiguousCollectionRoot: false };
  }

  const childRepoRoots = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
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
    projectRoot: false,
    childRepoRoots,
    ambiguousCollectionRoot: childRepoRoots.length >= 1,
  };
}

export async function assertManagedWorkspaceRootsUnambiguous(roots, { fullDiskAccess = false } = {}) {
  // In explicit trusted full-machine mode WORKSPACE_PATH is only the default
  // working/project context; it no longer defines the filesystem authority
  // boundary. Collection roots are therefore valid there. Strict mode keeps the
  // exact-root requirement because a broad parent would widen sandbox authority.
  if (fullDiskAccess) return;
  for (const root of roots) {
    const inspection = await inspectManagedWorkspaceRoot(root);
    if (!inspection.ambiguousCollectionRoot) continue;
    const examples = inspection.childRepoRoots.slice(0, 4).join("; ");
    throw new Error(
      `WORKSPACE_SCOPE_AMBIGUOUS: ${inspection.root} is a parent/container of independent Git repositories` +
        `${examples ? ` (${examples})` : ""}. Set WORKSPACE_PATH to the exact primary project root and add only exact intended project roots via EXTRA_WORKSPACE_PATHS.`
    );
  }
}
