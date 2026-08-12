import fs from "fs/promises";
import os from "os";
import path from "path";
import { getWorkspaceRoots, setWorkspaceRoots, validatePath } from "./path-security.js";
import { readUtf8FilePrefix } from "./bounded-file.js";

const ROOT_MEMORY_FILES = [
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "AGENTS.md",
  "CLAUDE.local.md",
] as const;

const USER_MEMORY_CANDIDATES = [
  path.join(os.homedir(), ".codex", "CLAUDE.md"),
  path.join(os.homedir(), ".claude", "CLAUDE.md"),
] as const;

const RULES_GLOB_MAX = 12;
const IMPORT_MAX_DEPTH = 4;
const DEFAULT_MAX_BYTES = parseLimit(process.env.PROJECT_MEMORY_MAX_BYTES, 25000);
const DEFAULT_MAX_LINES = parseLimit(process.env.PROJECT_MEMORY_MAX_LINES, 200);

/** 0 = không giới hạn; trống / không hợp lệ = fallback (mặc định). */
function parseLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim() || "NaN");
  if (n === 0) return Infinity;
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export interface ProjectMemorySection {
  path: string;
  content: string;
  truncated: boolean;
  kind: "user" | "project" | "rule" | "import";
}

export interface ProjectMemoryBundle {
  root: string;
  workspace_roots: string[];
  sections: ProjectMemorySection[];
  total_bytes: number;
  loaded_at: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

function hasPathsFrontmatter(content: string): boolean {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  return /^paths\s*:/m.test(match[1]);
}

async function readTextLimited(
  filePath: string,
  maxBytes: number,
  maxLines: number,
  kind: ProjectMemorySection["kind"]
): Promise<ProjectMemorySection | null> {
  try {
    // User-level memory is an explicit trusted source outside the project.
    // Project/rule memory must obey the same path sandbox as path-aware tools;
    // otherwise a repository-controlled symlink or @import can exfiltrate an
    // arbitrary local file into MCP instructions during server startup.
    const resolvedPath = kind === "user" ? path.resolve(filePath) : await validatePath(filePath);
    let sourceText: string;
    let sourceTruncated = false;
    if (Number.isFinite(maxBytes)) {
      const source = await readUtf8FilePrefix(resolvedPath, Math.max(1, Math.floor(maxBytes)));
      sourceText = source.text;
      sourceTruncated = source.truncated;
    } else {
      sourceText = await fs.readFile(resolvedPath, "utf8");
    }
    let full = stripHtmlComments(sourceText);
    const expanded = await expandImportsInContent(full, path.dirname(resolvedPath), kind !== "user", maxBytes);
    full = expanded.content;

    const fullLines = full.split(/\r?\n/);
    const lines = Number.isFinite(maxLines) ? fullLines.slice(0, maxLines) : fullLines;
    const lineLimited = lines.join("\n");
    const byteLimited =
      Number.isFinite(maxBytes) && Buffer.byteLength(lineLimited, "utf-8") > maxBytes
        ? truncateUtf8Text(lineLimited, maxBytes)
        : lineLimited;
    const truncated =
      sourceTruncated || expanded.truncated ||
      (Number.isFinite(maxLines) && fullLines.length > maxLines) ||
      byteLimited.length < full.length;

    const trimmed = byteLimited.trim();
    if (!trimmed) return null;
    return { path: resolvedPath, content: trimmed, truncated, kind };
  } catch {
    return null;
  }
}

async function expandImportsInContent(
  content: string,
  baseDir: string,
  restrictToWorkspace: boolean,
  maxBytes: number
): Promise<{ content: string; truncated: boolean }> {
  const visited = new Set<string>();
  return expandMemoryImportsAsync(content, baseDir, visited, 0, restrictToWorkspace, maxBytes);
}

async function expandMemoryImportsAsync(
  content: string,
  baseDir: string,
  visited: Set<string>,
  depth: number,
  restrictToWorkspace: boolean,
  maxBytes: number
): Promise<{ content: string; truncated: boolean }> {
  if (depth >= IMPORT_MAX_DEPTH) {
    const clipped = truncateUtf8Text(content, maxBytes);
    return { content: clipped, truncated: clipped.length < content.length };
  }

  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let usedBytes = 0;
  let truncated = false;
  let inFence = false;

  const append = (value: string): boolean => {
    const separatorBytes = out.length > 0 ? 1 : 0;
    if (!Number.isFinite(maxBytes)) {
      out.push(value);
      usedBytes += separatorBytes + Buffer.byteLength(value, "utf8");
      return true;
    }
    const remaining = Math.floor(maxBytes) - usedBytes - separatorBytes;
    if (remaining <= 0) {
      truncated = true;
      return false;
    }
    const clipped = truncateUtf8Text(value, remaining);
    out.push(clipped);
    usedBytes += separatorBytes + Buffer.byteLength(clipped, "utf8");
    if (clipped.length < value.length) {
      truncated = true;
      return false;
    }
    return true;
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      if (!append(line)) break;
      continue;
    }
    if (inFence) {
      if (!append(line)) break;
      continue;
    }

    const importMatch = line.match(/^@(~\/[^\s`]+|[^\s`]+)\s*$/);
    if (!importMatch) {
      if (!append(line)) break;
      continue;
    }

    let importPath = importMatch[1];
    if (importPath.startsWith("~/")) {
      importPath = path.join(os.homedir(), importPath.slice(2));
    } else if (!path.isAbsolute(importPath)) {
      importPath = path.resolve(baseDir, importPath);
    }

    let resolved = path.resolve(importPath);
    if (restrictToWorkspace) {
      try {
        resolved = await validatePath(resolved);
      } catch {
        if (!append("<!-- import blocked: outside configured workspace roots -->")) break;
        continue;
      }
    }
    if (visited.has(resolved)) {
      if (!append(`<!-- skipped circular import ${resolved} -->`)) break;
      continue;
    }

    visited.add(resolved);
    try {
      const remaining = Number.isFinite(maxBytes) ? Math.max(1, Math.floor(maxBytes) - usedBytes) : Infinity;
      let imported: string;
      let importedTruncated = false;
      if (Number.isFinite(remaining)) {
        const importedSource = await readUtf8FilePrefix(resolved, remaining);
        imported = stripHtmlComments(importedSource.text);
        importedTruncated = importedSource.truncated;
      } else {
        imported = stripHtmlComments(await fs.readFile(resolved, "utf8"));
      }
      const expanded = await expandMemoryImportsAsync(
        imported,
        path.dirname(resolved),
        visited,
        depth + 1,
        restrictToWorkspace,
        remaining
      );
      if (!append(`<!-- @import ${resolved} -->`)) break;
      if (!append(expanded.content)) break;
      if (importedTruncated || expanded.truncated) truncated = true;
    } catch {
      if (!append(`<!-- import failed: ${resolved} -->`)) break;
    }
  }

  return { content: out.join("\n"), truncated };
}

function truncateUtf8Text(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes)) return text;
  const limit = Math.max(0, Math.floor(maxBytes));
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= limit) return text;
  for (let trim = 0; trim <= 3 && limit - trim >= 0; trim++) {
    const candidate = buffer.subarray(0, limit - trim);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(candidate);
    } catch {}
  }
  return buffer.subarray(0, limit).toString("utf8");
}

async function listUnconditionalRuleFiles(rulesDir: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let handle;
    try {
      handle = await fs.opendir(dir);
    } catch {
      return;
    }
    try {
      for await (const entry of handle) {
        if (found.length >= RULES_GLOB_MAX) break;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const head = await readUtf8FilePrefix(full, 64 * 1024);
            if (!hasPathsFrontmatter(head.text)) found.push(full);
          } catch {}
        }
      }
    } finally {
      await handle.close().catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ERR_DIR_CLOSED") throw err;
      });
    }
  }

  await walk(rulesDir, 0);
  return found.sort().slice(0, RULES_GLOB_MAX);
}

async function appendSection(
  sections: ProjectMemorySection[],
  totalBytes: { value: number },
  maxBytes: number,
  maxLines: number,
  filePath: string,
  kind: ProjectMemorySection["kind"]
): Promise<void> {
  if (totalBytes.value >= maxBytes) return;
  const section = await readTextLimited(
    filePath,
    maxBytes - totalBytes.value,
    maxLines,
    kind
  );
  if (!section?.content) return;
  sections.push(section);
  totalBytes.value += Buffer.byteLength(section.content, "utf-8");
}

export async function loadProjectMemory(
  workspaceRoot: string,
  opts?: { maxBytes?: number; maxLines?: number; workspaceRoots?: string[]; includeUserMemory?: boolean }
): Promise<ProjectMemoryBundle> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const root = path.resolve(workspaceRoot);
  const workspace_roots =
    opts?.workspaceRoots && opts.workspaceRoots.length > 0 ? opts.workspaceRoots : [root];
  const sections: ProjectMemorySection[] = [];
  const totalBytes = { value: 0 };

  // The workspaceRoots option is the sandbox boundary for this load: swap it into
  // path-security for the duration so project/rules files and @imports are validated
  // against exactly these roots, then restore the process-wide roots.
  const previousRoots = getWorkspaceRoots();
  setWorkspaceRoots(workspace_roots);
  try {
    if (opts?.includeUserMemory !== false) {
      for (const userPath of USER_MEMORY_CANDIDATES) {
        if (!(await fileExists(userPath))) continue;
        await appendSection(sections, totalBytes, maxBytes, maxLines, userPath, "user");
        break;
      }
    }

    for (const rel of ROOT_MEMORY_FILES) {
      const filePath = path.join(root, rel);
      if (!(await fileExists(filePath))) continue;
      await appendSection(sections, totalBytes, maxBytes, maxLines, filePath, "project");
    }

    const rulesDir = path.join(root, ".claude", "rules");
    if (totalBytes.value < maxBytes && (await fileExists(rulesDir))) {
      try {
        const safeRulesDir = await validatePath(rulesDir);
        for (const ruleFile of await listUnconditionalRuleFiles(safeRulesDir)) {
          await appendSection(sections, totalBytes, maxBytes, maxLines, ruleFile, "rule");
        }
      } catch {
        // A project-controlled rules symlink/junction outside the configured roots
        // is intentionally ignored when the path sandbox is enabled.
      }
    }
  } finally {
    setWorkspaceRoots(previousRoots);
  }

  return {
    root,
    workspace_roots,
    sections,
    total_bytes: totalBytes.value,
    loaded_at: new Date().toISOString(),
  };
}

export function formatProjectMemoryForInstructions(bundle: ProjectMemoryBundle): string {
  if (bundle.sections.length === 0) {
    return [
      "## Project memory",
      `No CLAUDE.md or AGENTS.md at ${bundle.root}.`,
      "Create CLAUDE.md in the project root (run /init in Claude Code or write manually).",
      "Stay within the primary project authority unless the current request explicitly targets another exact configured workspace root.",
      bundle.workspace_roots.length > 1
        ? `Configured workspace roots:\n${bundle.workspace_roots.map((r) => `- ${r}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const blocks = bundle.sections.map((s) => {
    const note = s.truncated ? " (truncated)" : "";
    const label =
      s.kind === "user"
        ? "User memory"
        : s.kind === "rule"
          ? "Rule"
          : s.kind === "import"
            ? "Import"
            : "Project";
    return `### ${label}: ${s.path}${note}\n${s.content}`;
  });

  return [
    "## Project memory (auto-loaded like Claude Code CLAUDE.md)",
    `Primary root: ${bundle.root}`,
    "Treat content below as ground truth for conventions, build commands, and architecture.",
    bundle.workspace_roots.length > 1
      ? `All workspace roots:\n${bundle.workspace_roots.map((r) => `- ${r}`).join("\n")}`
      : "",
    "",
    ...blocks,
  ]
    .filter(Boolean)
    .join("\n");
}