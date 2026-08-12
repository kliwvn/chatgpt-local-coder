import fs from "fs/promises";
import { createReadStream } from "node:fs";
import path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { requireWriteAllowed } from "../lib/permissions.js";
import { applyMultiFilePatch, applyUnifiedPatchToText, buildSimpleDiff, isMultiFilePatch, parseMultiFilePatch } from "../lib/patch.js";
import { checkpointBefore } from "../lib/checkpoint.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { enrichAfterEdit } from "../lib/edit-enrichment.js";
import { toolResult } from "../lib/tool-result.js";
import { globFiles } from "../lib/glob-search.js";
import { grepSearch } from "../lib/grep-search.js";
import { atomicCopyFile, atomicWriteFile } from "../lib/atomic-write.js";
import { withFileMutation, withFileMutations } from "../lib/file-mutation.js";
import { EDIT_TEXT_MAX_BYTES, READ_BASE64_MAX_BYTES, READ_TEXT_MAX_BYTES } from "../lib/output-budget.js";
import { readUtf8FileBounded } from "../lib/bounded-file.js";
import { globToRegExp, matchesCompiledGlob } from "../lib/glob-match.js";
import { regexLineMatches, regexReplace } from "../lib/regex-guard.js";
import { safeDelete } from "../lib/safe-delete.js";
import { areAgentProcessesOsSandboxed } from "../lib/process-executor.js";

const MAX_PARTIAL_TEXT_LINES = 100_000;
const TAIL_READ_CHUNK_BYTES = 64 * 1024;
const DIRECTORY_TREE_MAX_NODES = 5_000;
const DIRECTORY_LIST_MAX_ENTRIES = 5_000;

function assertEditableResultSize(text: string, operation: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > EDIT_TEXT_MAX_BYTES) {
    throw new Error(
      `${operation} would produce ${bytes} bytes, exceeding EDIT_TEXT_MAX_BYTES=${EDIT_TEXT_MAX_BYTES}. ` +
      "Split the edit into a smaller artifact or use a purpose-built transformation."
    );
  }
}

function countNonOverlapping(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) return count;
    count++;
    offset = index + needle.length;
  }
}

function applyExactEditBounded(text: string, oldText: string, newText: string, replaceAll: boolean): string {
  if (!oldText) throw new Error("old_text must not be empty");
  const count = replaceAll ? countNonOverlapping(text, oldText) : text.includes(oldText) ? 1 : 0;
  if (count === 0) throw new Error("old_text not found in file. Ensure exact match.");
  const projectedBytes =
    Buffer.byteLength(text, "utf8") +
    count * (Buffer.byteLength(newText, "utf8") - Buffer.byteLength(oldText, "utf8"));
  if (projectedBytes > EDIT_TEXT_MAX_BYTES) {
    throw new Error(
      `Edit would produce about ${projectedBytes} bytes, exceeding EDIT_TEXT_MAX_BYTES=${EDIT_TEXT_MAX_BYTES}.`
    );
  }
  return replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText);
}

function decodeBase64Strict(content: string): Buffer {
  const compact = content.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error("Invalid base64 content");
  }
  const buffer = Buffer.from(compact, "base64");
  const canonicalInput = compact.replace(/=+$/, "");
  const canonicalDecoded = buffer.toString("base64").replace(/=+$/, "");
  if (canonicalInput !== canonicalDecoded) throw new Error("Invalid base64 content");
  return buffer;
}

async function readTextLinesFrom(
  filePath: string,
  startLine: number,
  limit?: number
): Promise<string[]> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const output: string[] = [];
  let lineNumber = 0;
  let carry = "";
  let outputBytes = 0;
  const acceptLine = (rawLine: string): boolean => {
    lineNumber++;
    const line = lineNumber === 1 ? rawLine.replace(/^\uFEFF/, "") : rawLine;
    if (lineNumber < startLine) return false;
    const lineBytes = Buffer.byteLength(line, "utf8") + (output.length ? 1 : 0);
    if (outputBytes + lineBytes > READ_TEXT_MAX_BYTES) {
      throw new Error(
        `Requested text slice exceeds READ_TEXT_MAX_BYTES=${READ_TEXT_MAX_BYTES}. ` +
        "Use a smaller line range or read_file_base64 with byte offset/length."
      );
    }
    output.push(line);
    outputBytes += lineBytes;
    return limit !== undefined && output.length >= limit;
  };
  try {
    for await (const chunk of input) {
      carry += chunk;
      let newline: number;
      while ((newline = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        if (acceptLine(line)) return output;
      }
      // Check the unfinished line only after consuming complete lines from this
      // chunk; otherwise a valid near-limit line followed by more data in the same
      // stream chunk can be rejected even though the line itself is within budget.
      if (Buffer.byteLength(carry, "utf8") > READ_TEXT_MAX_BYTES) {
        throw new Error(
          `A text line exceeds READ_TEXT_MAX_BYTES=${READ_TEXT_MAX_BYTES}. ` +
          "Use read_file_base64 with byte offset/length for oversized single-line data."
        );
      }
    }
    // String.split("\n") — used by the legacy implementation — always exposes
    // the final segment, including an empty final line after a trailing newline.
    acceptLine(carry);
  } finally {
    input.destroy();
  }
  return output;
}

async function readTextTail(filePath: string, lineCount: number): Promise<string> {
  const stat = await fs.stat(filePath);
  if (stat.size === 0) return "";
  const handle = await fs.open(filePath, "r");
  const chunks: Buffer[] = [];
  let position = stat.size;
  let newlineCount = 0;
  let bytesBuffered = 0;
  try {
    while (position > 0 && newlineCount < lineCount) {
      const size = Math.min(TAIL_READ_CHUNK_BYTES, position);
      if (bytesBuffered + size > READ_TEXT_MAX_BYTES) {
        throw new Error(
          `Requested tail exceeds READ_TEXT_MAX_BYTES=${READ_TEXT_MAX_BYTES}. ` +
          "Use a smaller tail or read_file_base64 with byte offset/length."
        );
      }
      position -= size;
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(buffer, 0, size, position);
      const chunk = buffer.subarray(0, bytesRead);
      bytesBuffered += bytesRead;
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) newlineCount++;
      chunks.unshift(chunk);
    }
  } finally {
    await handle.close();
  }
  let text = Buffer.concat(chunks).toString("utf8");
  if (position === 0) text = text.replace(/^\uFEFF/, "");
  return text.split("\n").slice(-lineCount).join("\n");
}


async function searchDirectory(
  rootDir: string,
  dir: string,
  pattern: string,
  globMatcher: RegExp,
  results: string[],
  maxResults: number
): Promise<void> {
  if (results.length >= maxResults) return;
  const handle = await fs.opendir(dir);
  try {
    for await (const entry of handle) {
      if (results.length >= maxResults) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        await searchDirectory(rootDir, fullPath, pattern, globMatcher, results, maxResults);
        continue;
      }

      const rel = path.relative(rootDir, fullPath).replace(/\\/g, "/");
      if (!matchesCompiledGlob(globMatcher, rel, entry.name)) continue;
      let content: string;
      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile() || stat.size > READ_TEXT_MAX_BYTES) continue;
        content = await readUtf8FileBounded(fullPath, READ_TEXT_MAX_BYTES, "search file");
      } catch {
        continue;
      }
      const remaining = maxResults - results.length;
      const plainLiteral = pattern && !/[\\^$.*+?()[\]{}|]/.test(pattern) ? pattern.toLowerCase() : null;
      let indexes: number[];
      const lines = content.split("\n");
      if (plainLiteral !== null) {
        indexes = [];
        for (let idx = 0; idx < lines.length && indexes.length < remaining; idx++) {
          if (lines[idx].toLowerCase().includes(plainLiteral)) indexes.push(idx);
        }
      } else {
        ({ indexes } = await regexLineMatches(pattern, "i", content, remaining));
      }
      for (const idx of indexes) {
        if (results.length >= maxResults) break;
        results.push(`${fullPath}:${idx + 1}: ${lines[idx].trim()}`);
      }
    }
  } finally {
    await handle.close().catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ERR_DIR_CLOSED") throw err;
    });
  }
}

interface TreeBuildState {
  nodes: number;
  truncated: boolean;
}

async function buildTree(
  dirPath: string,
  depth: number,
  maxDepth: number,
  state: TreeBuildState
): Promise<object> {
  const name = path.basename(dirPath);
  state.nodes++;
  if (depth >= maxDepth) return { name, type: "directory", truncated: true };

  const children = [];
  const handle = await fs.opendir(dirPath);
  try {
    for await (const entry of handle) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) continue;
      if (state.nodes >= DIRECTORY_TREE_MAX_NODES) {
        state.truncated = true;
        children.push({ name: "…", type: "truncated", reason: `node limit ${DIRECTORY_TREE_MAX_NODES}` });
        break;
      }
      const childPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) children.push(await buildTree(childPath, depth + 1, maxDepth, state));
      else {
        state.nodes++;
        children.push({ name: entry.name, type: "file" });
      }
    }
  } finally {
    await handle.close().catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ERR_DIR_CLOSED") throw err;
    });
  }

  return { name, type: "directory", children };
}

export function registerFilesystemTools(server: McpServer): void {
  server.registerTool(
    "read_text_file",
    {
      title: "Read Text File",
      description: "Read a file before editing. Use offset+limit for partial reads (1-based line numbers). Always read files you plan to patch.",
      inputSchema: {
        path: z.string(),
        offset: z.number().int().positive().optional().describe("1-based line number to start reading"),
        limit: z.number().int().positive().max(MAX_PARTIAL_TEXT_LINES).optional().describe("Number of lines to read from offset"),
        head: z.number().int().positive().max(MAX_PARTIAL_TEXT_LINES).optional(),
        tail: z.number().int().positive().max(MAX_PARTIAL_TEXT_LINES).optional(),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ path: filePath, offset, limit, head, tail }) => {
      const validPath = await validatePath(filePath);

      if (offset !== undefined) {
        const slice = await readTextLinesFrom(validPath, offset, limit);
        const numbered = slice.map((line, idx) => `${String(offset + idx).padStart(6, " ")}|${line}`);
        await audit({ tool: "read_text_file", action: "read", target: validPath, status: "ok", details: { offset, limit } });
        return toolResult("read_text_file", { path: validPath, content: numbered.join("\n"), offset, limit, lines: slice.length });
      }

      let result: string;
      if (head !== undefined) result = (await readTextLinesFrom(validPath, 1, head)).join("\n");
      else if (tail !== undefined) result = await readTextTail(validPath, tail);
      else {
        const stat = await fs.stat(validPath);
        if (!stat.isFile()) throw new Error("Path is not a regular file");
        if (stat.size > READ_TEXT_MAX_BYTES) {
          await audit({
            tool: "read_text_file",
            action: "read",
            target: validPath,
            status: "ok",
            details: { truncated: true, size: stat.size, maxBytes: READ_TEXT_MAX_BYTES },
          });
          return toolResult(
            "read_text_file",
            {
              path: validPath,
              content: "",
              size_bytes: stat.size,
              truncated: true,
              max_bytes: READ_TEXT_MAX_BYTES,
              hint: "File is too large for a full MCP response. Retry with offset+limit, head, or tail.",
            },
            { summary: `large file: use partial read (${stat.size} bytes)` }
          );
        }
        result = await readUtf8FileBounded(validPath, READ_TEXT_MAX_BYTES, "text file");
      }
      await audit({ tool: "read_text_file", action: "read", target: validPath, status: "ok", details: { head, tail } });
      return toolResult("read_text_file", { path: validPath, content: result, head, tail });
    }
  );

  server.registerTool(
    "read_file_base64",
    {
      title: "Read File Base64",
      description: `Read any local file as base64. Use offset/length for large files. Max chunk ${Math.round(READ_BASE64_MAX_BYTES / 1024)} KiB.`,
      inputSchema: {
        path: z.string(),
        offset: z.number().int().nonnegative().optional().default(0),
        length: z.number().int().positive().max(READ_BASE64_MAX_BYTES).optional().default(Math.min(1024 * 1024, READ_BASE64_MAX_BYTES)),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ path: filePath, offset, length }) => {
      const validPath = await validatePath(filePath);
      const stat = await fs.stat(validPath);
      if (!stat.isFile()) throw new Error("Path is not a regular file");
      const start = Math.min(offset, stat.size);
      const chunkLength = Math.min(length, READ_BASE64_MAX_BYTES, stat.size - start);
      const handle = await fs.open(validPath, "r");
      try {
        const buffer = Buffer.alloc(chunkLength);
        const { bytesRead } = await handle.read(buffer, 0, chunkLength, start);
        const data = buffer.subarray(0, bytesRead);
        const nextOffset = start + bytesRead;
        await audit({ tool: "read_file_base64", action: "read", target: validPath, status: "ok", details: { offset: start, bytesRead } });
        return toolResult("read_file_base64", {
          path: validPath,
          size: stat.size,
          offset: start,
          bytes_read: bytesRead,
          next_offset: nextOffset < stat.size ? nextOffset : null,
          done: nextOffset >= stat.size,
          encoding: "base64",
          content: data.toString("base64"),
        });
      } finally {
        await handle.close();
      }
    }
  );

  server.registerTool(
    "write_file",
    {
      title: "Write File",
      description: "Create or replace a local text file inside the configured path scope. A recovery checkpoint is created before overwrite.",
      inputSchema: { path: z.string(), content: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, content }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      return withFileMutation(validPath, async () => {
        const checkpointId = await checkpointBefore("write_file", [validPath]);
        await atomicWriteFile(validPath, content, "utf-8");
        await audit({ tool: "write_file", action: "write", target: validPath, status: "ok", details: { bytes: Buffer.byteLength(content) } });
        const data = await enrichAfterEdit(
          { path: validPath, bytes: Buffer.byteLength(content), checkpoint_id: checkpointId },
          [validPath]
        );
        return toolResult("write_file", data);
      });
    }
  );

  server.registerTool(
    "write_file_base64",
    {
      title: "Write File Base64",
      description: "Create or overwrite a binary file from base64 content.",
      inputSchema: { path: z.string(), content: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, content }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const buffer = decodeBase64Strict(content);
      return withFileMutation(validPath, async () => {
        const checkpointId = await checkpointBefore("write_file_base64", [validPath]);
        await atomicWriteFile(validPath, buffer);
        await audit({ tool: "write_file_base64", action: "write", target: validPath, status: "ok", details: { bytes: buffer.length } });
        return toolResult("write_file_base64", { path: validPath, bytes: buffer.length, checkpoint_id: checkpointId });
      });
    }
  );

  server.registerTool(
    "edit_file",
    {
      title: "Edit File",
      description: "Modify local text by exact replacement inside the configured path scope. Supports dry-run and creates a recovery checkpoint before changes.",
      inputSchema: {
        path: z.string(),
        old_text: z.string().min(1),
        new_text: z.string(),
        replace_all: z.boolean().optional().default(false),
        dry_run: z.boolean().optional().default(false),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, old_text, new_text, replace_all, dry_run }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      return withFileMutation(validPath, async () => {
        const content = await readUtf8FileBounded(validPath, EDIT_TEXT_MAX_BYTES, "editable text file (EDIT_TEXT_MAX_BYTES)");
        const newContent = applyExactEditBounded(content, old_text, new_text, replace_all);
        const diff = buildSimpleDiff(content, newContent);
        const checkpointId = await checkpointBefore("edit_file", [validPath], { dry_run });
        if (!dry_run) await atomicWriteFile(validPath, newContent, "utf-8");
        await audit({ tool: "edit_file", action: "edit", target: validPath, status: dry_run ? "dry-run" : "ok" });
        const data = await enrichAfterEdit({ path: validPath, diff, dry_run, checkpoint_id: checkpointId }, [validPath], dry_run);
        return toolResult("edit_file", data, { summary: dry_run ? `dry-run ${validPath}` : `edited ${validPath}` });
      });
    }
  );

  server.registerTool(
    "multi_edit",
    {
      title: "Multi Edit",
      description: "Modify one local text file with multiple exact replacements atomically. Supports dry-run and creates a recovery checkpoint before changes.",
      inputSchema: {
        path: z.string(),
        edits: z.array(z.object({ old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional().default(false) })).max(1000),
        dry_run: z.boolean().optional().default(false),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, edits, dry_run }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      return withFileMutation(validPath, async () => {
        const original = await readUtf8FileBounded(validPath, EDIT_TEXT_MAX_BYTES, "editable text file (EDIT_TEXT_MAX_BYTES)");
        let next = original;
        for (const edit of edits) {
          try {
            next = applyExactEditBounded(next, edit.old_text, edit.new_text, edit.replace_all);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`${message} (old_text: ${edit.old_text.slice(0, 120)})`);
          }
        }
        const diff = buildSimpleDiff(original, next);
        const checkpointId = await checkpointBefore("multi_edit", [validPath], { dry_run });
        if (!dry_run) await atomicWriteFile(validPath, next, "utf-8");
        await audit({ tool: "multi_edit", action: "edit", target: validPath, status: dry_run ? "dry-run" : "ok", details: { edits: edits.length } });
        const data = await enrichAfterEdit(
          { path: validPath, diff, edits: edits.length, dry_run, checkpoint_id: checkpointId },
          [validPath],
          dry_run
        );
        return toolResult("multi_edit", data);
      });
    }
  );

  server.registerTool(
    "replace_regex",
    {
      title: "Replace Regex",
      description: "Apply a JavaScript regex replacement to a text file.",
      inputSchema: { path: z.string(), pattern: z.string(), replacement: z.string(), flags: z.string().optional().default("g"), dry_run: z.boolean().optional().default(false) },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, pattern, replacement, flags, dry_run }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      return withFileMutation(validPath, async () => {
        const original = await readUtf8FileBounded(validPath, EDIT_TEXT_MAX_BYTES, "editable text file (EDIT_TEXT_MAX_BYTES)");
        const next = await regexReplace(pattern, flags, original, replacement, EDIT_TEXT_MAX_BYTES);
        if (next === original) throw new Error("Regex made no changes.");
        assertEditableResultSize(next, "Regex edit");
        const diff = buildSimpleDiff(original, next);
        const checkpointId = await checkpointBefore("replace_regex", [validPath], { dry_run });
        if (!dry_run) await atomicWriteFile(validPath, next, "utf-8");
        await audit({ tool: "replace_regex", action: "edit", target: validPath, status: dry_run ? "dry-run" : "ok" });
        return toolResult("replace_regex", { path: validPath, diff, dry_run, checkpoint_id: checkpointId });
      });
    }
  );

  server.registerTool(
    "apply_patch",
    {
      title: "Apply Patch",
      description:
        "Apply checkpointed local code edits with Codex @@ hunks or *** Begin Patch format. Supports dry-run. File removal is not allowed here; use the explicit removal tools.",
      inputSchema: {
        path: z.string().optional().describe("Target file (single-file) or base directory (multi-file)"),
        patch: z.string(),
        dry_run: z.boolean().optional().default(false),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, patch, dry_run }) => {
      requireWriteAllowed();

      if (isMultiFilePatch(patch)) {
        let baseDir: string | undefined;
        if (filePath) {
          const validPath = await validatePath(filePath);
          const stat = await fs.stat(validPath);
          baseDir = stat.isDirectory() ? validPath : path.dirname(validPath);
        }
        const parsedOps = parseMultiFilePatch(patch, baseDir);
        if (parsedOps.some((op) => op.operation === "delete")) {
          throw new Error(
            "APPLY_PATCH_DELETE_UNSUPPORTED: apply_patch is a non-delete edit action. " +
              "Use the explicit recoverable removal tools instead."
          );
        }
        const parsedPaths = parsedOps.map((op) => op.path);
        const patchPaths = await Promise.all(parsedPaths.map((patchPath) => validatePath(patchPath)));
        return withFileMutations(patchPaths, async () => {
          const checkpointId = await checkpointBefore("apply_patch", patchPaths, { dry_run });
          const results = await applyMultiFilePatch(patch, { base_dir: baseDir, dry_run, resolved_paths: patchPaths });
          const failed = results.filter((r) => !r.ok);
          await audit({
            tool: "apply_patch",
            action: "patch",
            target: baseDir || "multi",
            status: failed.length ? "error" : dry_run ? "dry-run" : "ok",
            details: { files: results.length, failed: failed.length },
          });
          const okPaths = results.filter((r) => r.ok && r.path).map((r) => r.path as string);
          const payload = await enrichAfterEdit(
            { files: results, dry_run, multi_file: true, checkpoint_id: checkpointId },
            okPaths,
            dry_run
          );
          return toolResult("apply_patch", payload, {
            ok: failed.length === 0,
            summary: `patched ${results.length} file(s)${failed.length ? `, ${failed.length} failed` : ""}`,
          });
        });
      }

      if (!filePath) throw new Error("path is required for single-file patches");
      const validPath = await validatePath(filePath);
      return withFileMutation(validPath, async () => {
        const original = await readUtf8FileBounded(validPath, EDIT_TEXT_MAX_BYTES, "editable text file (EDIT_TEXT_MAX_BYTES)");
        const next = applyUnifiedPatchToText(original, patch);
        assertEditableResultSize(next, "Patch");
        const diff = buildSimpleDiff(original, next);
        const checkpointId = await checkpointBefore("apply_patch", [validPath], { dry_run });
        if (!dry_run) await atomicWriteFile(validPath, next, "utf-8");
        await audit({ tool: "apply_patch", action: "patch", target: validPath, status: dry_run ? "dry-run" : "ok" });
        const data = await enrichAfterEdit({ path: validPath, diff, dry_run, checkpoint_id: checkpointId }, [validPath], dry_run);
        return toolResult("apply_patch", data);
      });
    }
  );

  server.registerTool(
    "list_directory",
    {
      title: "List Directory",
      description: "List files and directories in a path. Claude LS equivalent with optional ignore globs.",
      inputSchema: {
        path: z.string(),
        ignore: z.array(z.string()).optional().describe("Glob patterns to ignore, e.g. node_modules, *.log"),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ path: dirPath, ignore }) => {
      const validPath = await validatePath(dirPath);
      const ignoreMatchers = (ignore || []).map((p) => globToRegExp(p));
      const items: Array<{ name: string; type: "directory" | "file" }> = [];
      let truncated = false;
      const dir = await fs.opendir(validPath);
      try {
        for await (const entry of dir) {
          if (ignoreMatchers.some((m) => m.test(entry.name))) continue;
          if (entry.isSymbolicLink()) continue;
          if (items.length >= DIRECTORY_LIST_MAX_ENTRIES) {
            truncated = true;
            break;
          }
          items.push({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" });
        }
      } finally {
        // for-await normally closes the handle; close defensively when we break
        // early at the entry cap. Ignore ERR_DIR_CLOSED from an already-closed dir.
        await dir.close().catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "ERR_DIR_CLOSED") throw err;
        });
      }
      await audit({ tool: "list_directory", action: "list", target: validPath, status: "ok", details: { truncated } });
      return toolResult("list_directory", {
        path: validPath,
        entries: items,
        count: items.length,
        truncated,
        max_entries: DIRECTORY_LIST_MAX_ENTRIES,
      });
    }
  );

  server.registerTool(
    "glob",
    {
      title: "Glob",
      description: "Explore: find files by name pattern under a directory. Use before read_text_file when you do not know exact paths.",
      inputSchema: {
        pattern: z.string().describe('Glob pattern like "**/*.ts" or "src/**/*.tsx"'),
        path: z.string().optional().describe("Directory to search in; defaults to workspace root context"),
        max_results: z.number().int().positive().max(500).optional().default(100),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ pattern, path: searchPath, max_results }) => {
      const validPath = searchPath ? await validatePath(searchPath) : (await import("../lib/path-security.js")).getAllowedRoots()[0];
      const matches = await globFiles(validPath, pattern, max_results);
      await audit({ tool: "glob", action: "glob", target: validPath, status: "ok", details: { pattern, results: matches.length } });
      return toolResult("glob", { path: validPath, pattern, matches: matches.map((m) => m.path), count: matches.length });
    }
  );

  server.registerTool(
    "grep",
    {
      title: "Grep",
      description: "Explore: search file contents by regex. Prefer over reading many files blindly. Modes: content, files_with_matches, count.",
      inputSchema: {
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional().default("*"),
        output_mode: z.enum(["content", "files_with_matches", "count"]).optional().default("content"),
        case_insensitive: z.boolean().optional().default(false),
        multiline: z.boolean().optional().default(false),
        head_limit: z.number().int().positive().max(1000).optional().default(200),
        context_before: z.number().int().nonnegative().max(20).optional().default(0),
        context_after: z.number().int().nonnegative().max(20).optional().default(0),
        context_around: z.number().int().nonnegative().max(20).optional().default(0),
      },

      annotations: toolAnnotations("read"),
    },
    async ({
      pattern,
      path: searchPath,
      glob: globPattern,
      output_mode,
      case_insensitive,
      multiline,
      head_limit,
      context_before,
      context_after,
      context_around,
    }) => {
      const validPath = searchPath ? await validatePath(searchPath) : (await import("../lib/path-security.js")).getAllowedRoots()[0];
      const output = await grepSearch({
        pattern,
        path: validPath,
        glob: globPattern,
        outputMode: output_mode,
        caseInsensitive: case_insensitive,
        multiline,
        headLimit: head_limit,
        contextBefore: context_before,
        contextAfter: context_after,
        contextAround: context_around,
      });
      await audit({ tool: "grep", action: "grep", target: validPath, status: "ok", details: { pattern, output_mode } });
      return toolResult("grep", { path: validPath, pattern, output_mode, output });
    }
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete File",
      description: "Remove a file reversibly by moving it to the Windows Recycle Bin. Protected roots are refused.",
      inputSchema: { path: z.string() },

      annotations: toolAnnotations("destructive"),
    },
    async ({ path: filePath }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      return withFileMutation(validPath, async () => {
        const stat = await fs.stat(validPath);
        if (!stat.isFile()) throw new Error("Path is not a file");
        const checkpointId = await checkpointBefore("delete_file", [validPath]);
        const deletion = await safeDelete(filePath, validPath);
        await audit({ tool: "delete_file", action: "recycle", target: deletion.path, status: "ok" });
        return toolResult("delete_file", { path: deletion.path, deletion_mode: deletion.mode, checkpoint_id: checkpointId });
      });
    }
  );

  server.registerTool(
    "create_directory",
    {
      title: "Create Directory",
      description: "Create a directory (and parents if needed).",
      inputSchema: { path: z.string() },

      annotations: toolAnnotations("idempotent_additive"),
    },
    async ({ path: dirPath }) => {
      requireWriteAllowed();
      const validPath = await validatePath(dirPath);
      return withFileMutation(validPath, async () => {
        await fs.mkdir(validPath, { recursive: true });
        await audit({ tool: "create_directory", action: "mkdir", target: validPath, status: "ok" });
        return toolResult("create_directory", { path: validPath });
      });
    }
  );

  server.registerTool(
    "delete_directory",
    {
      title: "Delete Directory",
      description:
        "Remove a folder reversibly by moving it to the Windows Recycle Bin. Workspace/repo/home/drive roots are refused.",
      inputSchema: { path: z.string() },

      annotations: toolAnnotations("destructive"),
    },
    async ({ path: dirPath }) => {
      requireWriteAllowed();
      const validPath = await validatePath(dirPath);
      return withFileMutation(validPath, async () => {
        const stat = await fs.stat(validPath);
        if (!stat.isDirectory()) throw new Error("Path is not a directory");
        const checkpointId = await checkpointBefore("delete_directory", [validPath]);
        const deletion = await safeDelete(dirPath, validPath);
        await audit({ tool: "delete_directory", action: "recycle", target: deletion.path, status: "ok" });
        return toolResult("delete_directory", {
          path: deletion.path,
          deletion_mode: deletion.mode,
          checkpoint_id: checkpointId,
        });
      });
    }
  );

  server.registerTool(
    "copy_file",
    {
      title: "Copy File",
      description: "Copy a file to a new location.",
      inputSchema: { source: z.string(), destination: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ source, destination }) => {
      requireWriteAllowed();
      const src = await validatePath(source);
      const dest = await validatePath(destination);
      return withFileMutations([src, dest], async () => {
        const stat = await fs.stat(src);
        if (!stat.isFile()) throw new Error("Source is not a file");
        const checkpointId = await checkpointBefore("copy_file", [dest]);
        await atomicCopyFile(src, dest);
        await audit({ tool: "copy_file", action: "copy", target: dest, status: "ok", details: { source: src } });
        return toolResult("copy_file", { source: src, destination: dest, checkpoint_id: checkpointId });
      });
    }
  );

  server.registerTool(
    "move_file",
    {
      title: "Move File",
      description: "Move or rename a file or directory.",
      inputSchema: { source: z.string(), destination: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ source, destination }) => {
      requireWriteAllowed();
      const src = await validatePath(source);
      const dest = await validatePath(destination);
      return withFileMutations([src, dest], async () => {
        const checkpointId = await checkpointBefore("move_file", [src, dest]);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        let cross_volume = false;
        try {
          await fs.rename(src, dest);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
          cross_volume = true;

          // rename() cannot cross filesystems/volumes. Copy into a temporary
          // sibling on the destination volume, commit it with a same-volume
          // rename, then delete the source. If source deletion fails, remove the
          // committed destination to preserve move semantics instead of silently
          // leaving two divergent copies.
          try {
            await fs.lstat(dest);
            throw Object.assign(new Error("Destination already exists; refusing cross-volume move overwrite"), { code: "EEXIST" });
          } catch (destErr) {
            if ((destErr as NodeJS.ErrnoException).code !== "ENOENT") throw destErr;
          }

          const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const tempDest = `${dest}.move-tmp-${token}`;
          try {
            const stat = await fs.stat(src);
            await fs.cp(src, tempDest, {
              recursive: stat.isDirectory(),
              force: false,
              errorOnExist: true,
              preserveTimestamps: true,
            });
            await fs.rename(tempDest, dest);
            try {
              await safeDelete(source, src);
            } catch (deleteErr) {
              try {
                // Destination is a user-visible copy created by this transaction.
                // Roll it back recoverably; never hard-delete it when source removal fails.
                await safeDelete(destination, dest);
              } catch (rollbackErr) {
                throw new Error(
                  `Cross-volume move copied destination but could not delete source or roll back destination. ` +
                    `source delete: ${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}; ` +
                    `destination rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`
                );
              }
              throw deleteErr;
            }
          } finally {
            try {
              await fs.lstat(tempDest);
              // Temporary sibling is generated by this exact transaction, but still
              // use the same recoverable primitive instead of recursive permanent rm.
              await safeDelete(tempDest, tempDest);
            } catch (cleanupErr) {
              if ((cleanupErr as NodeJS.ErrnoException).code !== "ENOENT") {
                await audit({
                  tool: "move_file",
                  action: "temp_cleanup",
                  target: tempDest,
                  status: "error",
                  details: { error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) },
                });
              }
            }
          }
        }
        await audit({ tool: "move_file", action: "move", target: dest, status: "ok", details: { source: src } });
        return toolResult("move_file", { source: src, destination: dest, cross_volume, checkpoint_id: checkpointId });
      });
    }
  );

  server.registerTool("search_files", { title: "Search Files", description: "Search file contents for a text pattern.", inputSchema: { path: z.string(), pattern: z.string(), glob: z.string().optional().default("*"), max_results: z.number().int().positive().max(500).optional().default(50) }, annotations: toolAnnotations("read") }, async ({ path: searchPath, pattern, glob: globPattern, max_results }) => {
    const validPath = await validatePath(searchPath);
    const results: string[] = [];
    await searchDirectory(validPath, validPath, pattern, globToRegExp(globPattern), results, max_results);
    await audit({ tool: "search_files", action: "search", target: validPath, status: "ok", details: { pattern, results: results.length } });
    return toolResult("search_files", { path: validPath, pattern, matches: results, count: results.length });
  });

  server.registerTool("directory_tree", { title: "Directory Tree", description: "Get recursive directory structure as JSON.", inputSchema: { path: z.string(), max_depth: z.number().int().nonnegative().max(20).optional().default(4) }, annotations: toolAnnotations("read") }, async ({ path: dirPath, max_depth }) => {
    const validPath = await validatePath(dirPath);
    const state: TreeBuildState = { nodes: 0, truncated: false };
    const tree = await buildTree(validPath, 0, max_depth, state);
    await audit({ tool: "directory_tree", action: "tree", target: validPath, status: "ok" });
    return toolResult("directory_tree", {
      path: validPath,
      tree,
      max_depth,
      nodes: state.nodes,
      truncated: state.truncated,
      max_nodes: DIRECTORY_TREE_MAX_NODES,
    });
  });

  server.registerTool("list_allowed_directories", { title: "List Allowed Directories", description: "Show default working directory and machine access scope.", inputSchema: {}, annotations: toolAnnotations("read") }, async () => {
    const { getDefaultCwd, getFullDiskAccess, getMachineRoots } = await import("../lib/path-security.js");
    const { describePermissionProfile } = await import("../lib/permissions.js");
    const machineRoots = getMachineRoots();
    return toolResult("list_allowed_directories", {
      full_machine_access: getFullDiskAccess(),
      path_sandbox_enabled: !getFullDiskAccess(),
      shell_commands_os_sandboxed: areAgentProcessesOsSandboxed(),
      permission: describePermissionProfile(),
      default_cwd: getDefaultCwd(),
      machine_roots: machineRoots,
    });
  });
}
