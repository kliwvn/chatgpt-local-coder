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
