import fs from "fs/promises";
import path from "path";
import { READ_TEXT_MAX_BYTES } from "./output-budget.js";
import { readUtf8FileBounded } from "./bounded-file.js";
import { globToRegExp, matchesCompiledGlob } from "./glob-match.js";
import { regexLineMatches, regexMultilineCount } from "./regex-guard.js";

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

function plainRegexLiteral(pattern: string): string | null {
  if (!pattern || /[\\^$.*+?()[\]{}|]/.test(pattern)) return null;
  return pattern;
}

function literalLineMatches(
  literal: string,
  text: string,
  caseInsensitive: boolean,
  maxIndexes: number
): { count: number; indexes: number[] } {
  const needle = caseInsensitive ? literal.toLowerCase() : literal;
  const indexes: number[] = [];
  let count = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const haystack = caseInsensitive ? lines[i].toLowerCase() : lines[i];
    if (!haystack.includes(needle)) continue;
    count++;
    if (indexes.length < maxIndexes) indexes.push(i);
  }
  return { count, indexes };
}

function countLiteralMatches(literal: string, text: string, caseInsensitive: boolean): number {
  const needle = caseInsensitive ? literal.toLowerCase() : literal;
  const haystack = caseInsensitive ? text.toLowerCase() : text;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return count;
    count++;
    offset = index + needle.length;
  }
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
  const regexFlags = `${caseInsensitive ? "i" : ""}${multiline ? "gm" : ""}`;
  const literalPattern = plainRegexLiteral(pattern);
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
      const count = literalPattern !== null
        ? countLiteralMatches(literalPattern, text, caseInsensitive)
        : await regexMultilineCount(pattern, regexFlags, text);
      if (count > 0) {
        totalMatches += count;
        fileMatches.set(fullPath, (fileMatches.get(fullPath) || 0) + count);
        if (outputMode === "content") {
          contentLines.push(`${fullPath}: [multiline match x${count}]`);
        }
      }
      return;
    }

    const maxIndexes = outputMode === "content" ? headLimit : 0;
    const { count, indexes } = literalPattern !== null
      ? literalLineMatches(literalPattern, text, caseInsensitive, maxIndexes)
      : await regexLineMatches(pattern, regexFlags, text, maxIndexes);
    if (count === 0) return;
    totalMatches += count;
    fileMatches.set(fullPath, (fileMatches.get(fullPath) || 0) + count);

    if (outputMode === "content") {
      const lines = text.split("\n");
      for (const i of indexes) {
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

  let rootStat;
  try {
    rootStat = await fs.stat(searchRoot);
  } catch {
    return "No matches found";
  }
  if (rootStat.isFile()) {
    const basename = path.basename(searchRoot);
    await processFile(searchRoot, basename, basename);
  } else if (rootStat.isDirectory()) {
    await walk(searchRoot);
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