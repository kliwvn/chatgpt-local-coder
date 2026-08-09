import fs from "fs/promises";
import path from "path";
import { atomicWriteFile } from "./atomic-write.js";

/**
 * Apply unified diff / Codex-style patches to text.
 * Supports:
 * - Codex/OpenAI format: hunk header "@@" without line numbers
 * - Standard unified diff: "@@ -1,3 +1,4 @@"
 * - Mixed CRLF/LF input (normalized to LF for matching, preserves original EOL when possible)
 */

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

interface ParsedHunk {
  oldStart?: number;
  lines: Array<{ type: "context" | "remove" | "add"; text: string }>;
}

function parsePatch(patchText: string): ParsedHunk[] {
  const normalized = normalizeEol(patchText.trim());
  const rawLines = normalized.split("\n");
  const hunks: ParsedHunk[] = [];
  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ")) {
      i++;
      continue;
    }
    if (!line.startsWith("@@")) {
      i++;
      continue;
    }

    const headerMatch = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    const hunk: ParsedHunk = {
      oldStart: headerMatch ? Number(headerMatch[1]) : undefined,
      lines: [],
    };
    i++;

    for (; i < rawLines.length; i++) {
      const patchLine = rawLines[i];
      if (patchLine.startsWith("@@")) {
        break;
      }
      if (patchLine === "\\ No newline at end of file") continue;
      if (patchLine.startsWith(" ")) {
        hunk.lines.push({ type: "context", text: patchLine.slice(1) });
      } else if (patchLine.startsWith("-")) {
        hunk.lines.push({ type: "remove", text: patchLine.slice(1) });
      } else if (patchLine.startsWith("+")) {
        hunk.lines.push({ type: "add", text: patchLine.slice(1) });
      } else if (patchLine.length === 0) {
        hunk.lines.push({ type: "context", text: "" });
      }
    }

    if (hunk.lines.length > 0) hunks.push(hunk);
  }

  if (hunks.length === 0 && normalized.includes("\n")) {
    throw new Error("No valid patch hunks found. Use @@ header with +/- lines.");
  }

  return hunks;
}

function hunkSearchPattern(hunk: ParsedHunk): string[] {
  const pattern: string[] = [];
  for (const entry of hunk.lines) {
    if (entry.type === "context" || entry.type === "remove") {
      pattern.push(entry.text);
    }
  }
  return pattern;
}

function hunkReplacement(hunk: ParsedHunk): string[] {
  const replacement: string[] = [];
  for (const entry of hunk.lines) {
    if (entry.type === "context" || entry.type === "add") {
      replacement.push(entry.text);
    }
  }
  return replacement;
}

function findPatternIndex(haystack: string[], needle: string[], startAt = 0): number {
  if (needle.length === 0) return startAt;

  outer: for (let i = startAt; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }

  return -1;
}

function applyHunkAtIndex(output: string[], hunk: ParsedHunk, index: number): void {
  const removeCount = hunk.lines.filter((l) => l.type === "context" || l.type === "remove").length;
  const replacement = hunkReplacement(hunk);
  output.splice(index, removeCount, ...replacement);
}

function applyHunkWithLineNumber(output: string[], hunk: ParsedHunk, delta: number): number {
  if (hunk.oldStart === undefined) {
    throw new Error("Missing line number in hunk header");
  }

  const targetIndex = hunk.oldStart - 1 + delta;
  const removeCount = hunk.lines.filter((l) => l.type === "context" || l.type === "remove").length;
  const replacement = hunkReplacement(hunk);
  output.splice(targetIndex, removeCount, ...replacement);
  return replacement.length - removeCount;
}

function applyHunkWithContextSearch(output: string[], hunk: ParsedHunk, searchFrom: number): number {
  const pattern = hunkSearchPattern(hunk);
  const index = findPatternIndex(output, pattern, searchFrom);
  if (index < 0) {
    const preview = pattern.slice(0, 3).join(" | ") || "(empty hunk)";
    throw new Error(`Patch context not found in file. Expected lines like: ${preview}`);
  }

  applyHunkAtIndex(output, hunk, index);
  return index + hunkReplacement(hunk).length;
}

export function applyUnifiedPatchToText(original: string, patchText: string): string {
  const eol = detectEol(original);
  const normalizedOriginal = normalizeEol(original);
  const output = normalizedOriginal.split("\n");
  const hunks = parsePatch(patchText);

  let delta = 0;
  let searchFrom = 0;

  for (const hunk of hunks) {
    if (hunk.oldStart !== undefined) {
      delta += applyHunkWithLineNumber(output, hunk, delta);
    } else {
      searchFrom = applyHunkWithContextSearch(output, hunk, searchFrom);
    }
  }

  const result = output.join("\n");
  return eol === "\r\n" ? result.replace(/\n/g, "\r\n") : result;
}

export interface MultiPatchFileOp {
  path: string;
  operation: "create" | "update" | "delete";
  patch?: string;
  content?: string;
}

export interface MultiPatchResult {
  path: string;
  operation: "create" | "update" | "delete";
  ok: boolean;
  diff?: string;
  error?: string;
}

export function isMultiFilePatch(patchText: string): boolean {
  const t = patchText.trim();
  return (
    t.includes("*** Begin Patch") ||
    t.includes("*** Update File:") ||
    t.includes("*** Add File:") ||
    t.includes("*** Delete File:") ||
    /^---\s+/m.test(t) ||
    /^\+\+\+\s+/m.test(t)
  );
}

export function parseMultiFilePatch(patchText: string, baseDir?: string): MultiPatchFileOp[] {
  const normalized = normalizeEol(patchText.trim());
  const ops: MultiPatchFileOp[] = [];

  if (normalized.includes("*** Begin Patch") || normalized.includes("*** Update File:")) {
    const lines = normalized.split("\n");
    let i = 0;
    let current: MultiPatchFileOp | null = null;
    const chunk: string[] = [];

    const flush = () => {
      if (!current) return;
      if (current.operation === "create") {
        // Dòng trống trong khối Add File là nội dung file, không phải dấu kết thúc —
        // giữ nguyên; chỉ bỏ tiền tố "+" của các dòng nội dung.
        current.content = chunk
          .map((l) => (l.startsWith("+") ? l.slice(1) : l))
          .join("\n");
      } else if (current.operation === "update") {
        current.patch = chunk.join("\n");
      }
      ops.push(current);
      current = null;
      chunk.length = 0;
    };

    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("*** Update File:")) {
        flush();
        current = { path: resolvePatchPath(line.slice(16).trim(), baseDir), operation: "update" };
        continue;
      }
      if (line.startsWith("*** Add File:")) {
        flush();
        current = { path: resolvePatchPath(line.slice(13).trim(), baseDir), operation: "create" };
        continue;
      }
      if (line.startsWith("*** Delete File:")) {
        flush();
        ops.push({ path: resolvePatchPath(line.slice(16).trim(), baseDir), operation: "delete" });
        continue;
      }
      if (line.startsWith("*** End Patch") || line.startsWith("*** Begin Patch")) continue;
      if (current) chunk.push(line);
    }
    flush();
    return ops;
  }

  // Unified diff multi-file: --- a/path +++ b/path blocks
  const blocks = normalized.split(/\n(?=---\s)/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed.startsWith("---")) continue;
    const header = trimmed.split("\n")[0];
    const filePath = header.replace(/^---\s+[ab]\//, "").replace(/^---\s+/, "").trim();
    const hunks = trimmed.split("\n").slice(1).join("\n");
    ops.push({
      path: resolvePatchPath(filePath, baseDir),
      operation: "update",
      patch: hunks,
    });
  }

  return ops;
}

function resolvePatchPath(input: string, baseDir?: string): string {
  const cleaned = input.trim().replace(/^['"]|['"]$/g, "");
  if (path.isAbsolute(cleaned)) return path.resolve(cleaned);
  if (baseDir) return path.resolve(baseDir, cleaned);
  return path.resolve(cleaned);
}

export async function applyMultiFilePatch(
  patchText: string,
  options?: {
    base_dir?: string;
    dry_run?: boolean;
    resolve_path?: (filePath: string) => Promise<string>;
    resolved_paths?: string[];
  }
): Promise<MultiPatchResult[]> {
  const baseDir = options?.base_dir;
  const dryRun = options?.dry_run ?? false;
  const ops = parseMultiFilePatch(patchText, baseDir);
  if (ops.length === 0) throw new Error("No file operations found in patch");

  if (options?.resolved_paths) {
    if (options.resolved_paths.length !== ops.length) {
      throw new Error("resolved_paths length does not match patch operation count");
    }
    for (let i = 0; i < ops.length; i++) ops[i].path = options.resolved_paths[i];
  } else if (options?.resolve_path) {
    for (const op of ops) op.path = await options.resolve_path(op.path);
  }

  const normalizedTargets = ops.map((op) => {
    const resolved = path.resolve(op.path);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  });
  if (new Set(normalizedTargets).size !== normalizedTargets.length) {
    throw new Error("Multi-file patch targets the same path more than once; combine operations for each file into one block.");
  }

  type PreparedOperation = {
    op: MultiPatchFileOp;
    originalExists: boolean;
    original?: Buffer;
    next?: string;
    result: MultiPatchResult;
  };

  const prepared: PreparedOperation[] = [];
  let preflightError: { index: number; message: string } | null = null;

  // Preflight every operation before touching disk. This prevents the common
  // partial-patch failure where file A is changed and file B's hunk then fails.
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    try {
      if (op.operation === "delete") {
        const stat = await fs.stat(op.path);
        if (!stat.isFile()) throw new Error("Delete target is not a regular file");
        prepared.push({
          op,
          originalExists: true,
          original: await fs.readFile(op.path),
          result: { path: op.path, operation: "delete", ok: true, diff: "[deleted]" },
        });
        continue;
      }

      if (op.operation === "create") {
        const content = op.content ?? "";
        let originalExists = false;
        let original: Buffer | undefined;
        try {
          const stat = await fs.stat(op.path);
          if (!stat.isFile()) throw new Error("Create target exists and is not a regular file");
          originalExists = true;
          original = await fs.readFile(op.path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        prepared.push({
          op,
          originalExists,
          original,
          next: content,
          result: { path: op.path, operation: "create", ok: true, diff: buildSimpleDiff("", content) },
        });
        continue;
      }

      const original = await fs.readFile(op.path, "utf-8");
      const next = applyUnifiedPatchToText(original, op.patch || "");
      const diff = buildSimpleDiff(original, next);
      prepared.push({
        op,
        originalExists: true,
        original: Buffer.from(original, "utf-8"),
        next,
        result: { path: op.path, operation: "update", ok: true, diff },
      });
    } catch (err) {
      preflightError = { index, message: err instanceof Error ? err.message : String(err) };
      break;
    }
  }

  if (preflightError) {
    return ops.map((op, index) => ({
      path: op.path,
      operation: op.operation,
      ok: false,
      error:
        index === preflightError!.index
          ? preflightError!.message
          : "not applied because another operation failed preflight",
    }));
  }

  if (dryRun) return prepared.map((item) => item.result);

  const committed: PreparedOperation[] = [];
  try {
    for (const item of prepared) {
      if (item.op.operation === "delete") await fs.unlink(item.op.path);
      else await atomicWriteFile(item.op.path, item.next ?? "", "utf-8");
      committed.push(item);
    }
    return prepared.map((item) => item.result);
  } catch (commitError) {
    const rollbackErrors: string[] = [];
    for (const item of [...committed].reverse()) {
      try {
        if (item.originalExists && item.original) await atomicWriteFile(item.op.path, item.original);
        else await fs.rm(item.op.path, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(
          `${item.op.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
      }
    }
    if (rollbackErrors.length) {
      throw new Error(
        `Multi-file patch commit failed (${commitError instanceof Error ? commitError.message : String(commitError)}) and rollback was incomplete: ${rollbackErrors.join("; ")}`
      );
    }
    const message = `commit failed; all previously-applied operations were rolled back: ${commitError instanceof Error ? commitError.message : String(commitError)}`;
    return prepared.map((item) => ({ ...item.result, ok: false, error: message }));
  }
}

export function buildSimpleDiff(oldContent: string, newContent: string): string {
  const oldLines = normalizeEol(oldContent).split("\n");
  const newLines = normalizeEol(newContent).split("\n");
  const diff: string[] = [];

  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine !== newLine) {
      if (oldLine !== undefined) diff.push(`- ${oldLine}`);
      if (newLine !== undefined) diff.push(`+ ${newLine}`);
    }
  }

  return diff.join("\n") || "(no visible diff)";
}