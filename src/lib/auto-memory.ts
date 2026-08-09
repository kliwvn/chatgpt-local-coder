import { createHash } from "node:crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";

const MAX_BYTES = parseInt(process.env.AUTO_MEMORY_MAX_BYTES || "25000", 10);
const MAX_LINES = parseInt(process.env.AUTO_MEMORY_MAX_LINES || "200", 10);

const memoryWriteChains = new Map<string, Promise<void>>();

function enqueueMemoryWrite<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = memoryWriteChains.get(file) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  memoryWriteChains.set(file, run.then(() => undefined, () => undefined));
  return run;
}

function projectDir(workspaceRoot: string): string {
  const slug = createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(base, "projects", slug);
}

function memoryPath(workspaceRoot: string): string {
  return path.join(projectDir(workspaceRoot), "MEMORY.md");
}

export async function loadAutoMemory(workspaceRoot: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(memoryPath(workspaceRoot));
    const text = buf.toString("utf-8");
    const lines = text.split(/\r?\n/).slice(0, MAX_LINES).join("\n");
    const limited =
      Buffer.byteLength(lines, "utf-8") > MAX_BYTES
        ? Buffer.from(lines, "utf-8").subarray(0, MAX_BYTES).toString("utf-8")
        : lines;
    return limited.trim() || null;
  } catch {
    return null;
  }
}

export async function appendAutoMemory(workspaceRoot: string, note: string): Promise<string> {
  const dir = projectDir(workspaceRoot);
  const file = memoryPath(workspaceRoot);
  const line = `- ${new Date().toISOString().slice(0, 10)}: ${note.trim()}\n`;

  await enqueueMemoryWrite(file, async () => {
    await fs.mkdir(dir, { recursive: true });
    const stat = await fs.stat(file).catch(() => null);
    const header = !stat || stat.size === 0 ? "# Auto memory (cross-session notes)\n\n" : "";
    await fs.appendFile(file, header + line, "utf-8");
  });
  return file;
}

export function formatAutoMemoryForInstructions(content: string | null): string {
  if (!content) return "";
  return ["## Auto memory (learned across sessions)", content].join("\n");
}