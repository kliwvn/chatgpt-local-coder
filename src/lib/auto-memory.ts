import { createHash } from "node:crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { atomicWriteFile } from "./atomic-write.js";
import { envBoundedInteger } from "./env-utils.js";
import { enqueueKeyedMutation } from "./keyed-mutation.js";

const MAX_BYTES = envBoundedInteger("AUTO_MEMORY_MAX_BYTES", 25_000, 1024, 10_000_000);
const MAX_LINES = envBoundedInteger("AUTO_MEMORY_MAX_LINES", 200, 1, 10_000);
const MEMORY_HEADER = "# Auto memory (cross-session notes)\n\n";
const NOTE_BYTE_BUDGET = Math.max(1, MAX_BYTES - Buffer.byteLength(MEMORY_HEADER, "utf8"));

const memoryWriteChains = new Map<string, Promise<void>>();

function enqueueMemoryWrite<T>(file: string, operation: () => Promise<T>): Promise<T> {
  return enqueueKeyedMutation(memoryWriteChains, file, operation);
}

function projectDir(workspaceRoot: string): string {
  const slug = createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(base, "projects", slug);
}

function memoryPath(workspaceRoot: string): string {
  return path.join(projectDir(workspaceRoot), "MEMORY.md");
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = Math.max(0, Math.min(maxBytes, buffer.length));
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function boundRecentNotes(lines: string[]): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_LINES; i--) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + lineBytes > NOTE_BYTE_BUDGET) {
      if (kept.length === 0) {
        const truncated = truncateUtf8(line, Math.max(1, NOTE_BYTE_BUDGET - 1));
        if (truncated) kept.unshift(truncated);
      }
      break;
    }
    kept.unshift(line);
    bytes += lineBytes;
  }
  return kept;
}

async function readRecentNoteLines(file: string): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const stat = await fs.stat(file);
    if (stat.size <= 0) return [];

    // Read only a bounded tail so a legacy unbounded MEMORY.md cannot create a
    // large transient allocation during startup. Twice the byte budget is enough
    // to recover every line that could fit in the final bounded result.
    const desired = Math.max(MAX_BYTES * 2, 4096);
    const start = Math.max(0, stat.size - desired - 1);
    const size = stat.size - start;
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    const notes = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("- "));
    return boundRecentNotes(notes);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function loadAutoMemory(workspaceRoot: string): Promise<string | null> {
  try {
    const notes = await readRecentNoteLines(memoryPath(workspaceRoot));
    return notes.join("\n").trim() || null;
  } catch {
    return null;
  }
}

export async function appendAutoMemory(workspaceRoot: string, note: string): Promise<string> {
  const dir = projectDir(workspaceRoot);
  const file = memoryPath(workspaceRoot);
  const normalized = note.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("Memory note is empty");
  const line = `- ${new Date().toISOString().slice(0, 10)}: ${normalized}`;

  await enqueueMemoryWrite(file, async () => {
    await fs.mkdir(dir, { recursive: true });
    const notes = await readRecentNoteLines(file);
    const bounded = boundRecentNotes([...notes, line]);
    const text = `${MEMORY_HEADER}${bounded.join("\n")}${bounded.length ? "\n" : ""}`;
    await atomicWriteFile(file, text, "utf8");
  });
  return file;
}

export function formatAutoMemoryForInstructions(content: string | null): string {
  if (!content) return "";
  return ["## Auto memory (learned across sessions)", content].join("\n");
}