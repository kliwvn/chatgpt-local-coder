import fs from "fs/promises";
import path from "path";
import { globToRegExp, matchesCompiledGlob } from "./glob-match.js";

function shouldSkipDir(name: string): boolean {
  return name === "node_modules" || name === ".git";
}

export async function globFiles(
  rootDir: string,
  pattern: string,
  maxResults: number
): Promise<Array<{ path: string; mtimeMs: number }>> {
  const matches: Array<{ path: string; mtimeMs: number }> = [];
  const matcher = globToRegExp(pattern);

  async function walk(dir: string): Promise<void> {
    if (matches.length >= maxResults) return;

    let handle;
    try {
      handle = await fs.opendir(dir);
    } catch {
      return;
    }
    try {
      for await (const entry of handle) {
        if (matches.length >= maxResults) break;
        // Recursive discovery must not follow a symlink/reparse-point target that
        // was never independently validated against workspace boundaries.
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(dir, entry.name);
        const rel = path.relative(rootDir, fullPath).replace(/\\/g, "/");

        if (entry.isDirectory()) {
          if (!shouldSkipDir(entry.name)) await walk(fullPath);
          continue;
        }

        if (!matchesCompiledGlob(matcher, rel, entry.name)) continue;
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isFile()) matches.push({ path: fullPath, mtimeMs: stat.mtimeMs });
        } catch {}
      }
    } finally {
      await handle.close().catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ERR_DIR_CLOSED") throw err;
      });
    }
  }

  await walk(rootDir);
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches;
}