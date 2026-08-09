import fs from "fs/promises";
import path from "path";
import { READ_TEXT_MAX_BYTES } from "./output-budget.js";
import { readUtf8FileBounded } from "./bounded-file.js";
import { globToRegExp, matchesCompiledGlob } from "./glob-match.js";

export type GrepOutputMode = "content" | "files_with_matches" | "count";

interface GrepOptions {
  pattern: string;
  path: string;
  glob?: string;
  outputMode?: GrepOutputMode;
  caseInsensitive?: boolean;
  multiline?: boolean;
  headLimit?: number;
  contextBefore?: number;
  contextAfter?: number;
  contextAround?: number;
}

function shouldSkipDir(name: string): boolean {
  return name === "node_modules" || name === ".git";
}

function buildRegex(pattern: string, caseInsensitive: boolean, multiline: boolean): RegExp {
  const flags = `${caseInsensitive ? "i" : ""}${multiline ? "gm" : ""}`;
  return new RegExp(pattern, flags || undefined);
}

export async function grepSearch(options: GrepOptions): Promise<string> {
  const {
    pattern,
    path: searchRoot,
    glob = "*",
    outputMode = "content",
    caseInsensitive = false,
    multiline = false,
    headLimit = 200,
    contextBefore = 0,
    contextAfter = 0,
    contextAround = 0,
  } = options;

  const before = contextAround || contextBefore;
  const after = contextAround || contextAfter;
  const regex = buildRegex(pattern, caseInsensitive, multiline);
  const fileMatches = new Map<string, number>();
  const contentLines: string[] = [];
  let totalMatches = 0;
  const globMatcher = globToRegExp(glob);

  async function processFile(fullPath: string, relativePath: string, basename: string): Promise<void> {
    if (!matchesCompiledGlob(globMatcher, relativePath, basename)) return;

    let text: string;
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile() || stat.size > READ_TEXT_MAX_BYTES) return;
      text = await readUtf8FileBounded(fullPath, READ_TEXT_MAX_BYTES, "grep file");
    } catch {
      return;
    }

    if (multiline) {
      // multiline regex carries `g`, so count reflects every match in a file.
      const matches = text.match(regex);
      const count = matches?.length || 0;
      if (count > 0) {
        totalMatches += count;
        fileMatches.set(fullPath, (fileMatches.get(fullPath) || 0) + count);
        if (outputMode === "content") {
          contentLines.push(`${fullPath}: [multiline match x${count}]`);
        }
      }
      return;
    }

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i])) continue;

      totalMatches++;
      fileMatches.set(fullPath, (fileMatches.get(fullPath) || 0) + 1);

      if (outputMode === "content") {
        if (contentLines.length >= headLimit) break;
        if (before > 0 || after > 0) {
          const start = Math.max(0, i - before);
          const end = Math.min(lines.length - 1, i + after);
          for (let j = start; j <= end; j++) {
            const prefix = j === i ? ":" : "-";
            contentLines.push(`${fullPath}${prefix}${j + 1}: ${lines[j]}`);
            if (contentLines.length >= headLimit) break;
          }
        } else {
          contentLines.push(`${fullPath}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
  }

  async function walk(dir: string): Promise<void> {
    if (
      (outputMode === "content" && contentLines.length >= headLimit) ||
      (outputMode !== "content" && fileMatches.size >= headLimit)
    ) return;

    let handle;
    try {
      handle = await fs.opendir(dir);
    } catch {
      return;
    }
    try {
      for await (const entry of handle) {
        if (
          (outputMode === "content" && contentLines.length >= headLimit) ||
          (outputMode !== "content" && fileMatches.size >= headLimit)
        ) break;
        // Do not read through a symlink/reparse point discovered during recursive
        // traversal; explicit file reads are canonicalized by validatePath instead.
        if (entry.isSymbolicLink()) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!shouldSkipDir(entry.name)) await walk(fullPath);
          continue;
        }

        const rel = path.relative(searchRoot, fullPath).replace(/\\/g, "/");
        await processFile(fullPath, rel, entry.name);
      }
    } finally {
      await handle.close().catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ERR_DIR_CLOSED") throw err;
      });
    }
  }

  try {
    const rootStat = await fs.stat(searchRoot);
    if (rootStat.isFile()) {
      const basename = path.basename(searchRoot);
      await processFile(searchRoot, basename, basename);
    } else if (rootStat.isDirectory()) {
      await walk(searchRoot);
    }
  } catch {
    return "No matches found";
  }

  if (outputMode === "files_with_matches") {
    const files = [...fileMatches.keys()].slice(0, headLimit);
    return files.length ? files.join("\n") : "No matches found";
  }

  if (outputMode === "count") {
    const rows = [...fileMatches.entries()]
      .slice(0, headLimit)
      .map(([file, count]) => `${file}:${count}`);
    return rows.length ? rows.join("\n") : "No matches found";
  }

  return contentLines.length ? contentLines.join("\n") : "No matches found";
}