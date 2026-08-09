import fs from "fs/promises";
import path from "path";
import { validatePath } from "./path-security.js";
import { readUtf8FilePrefix } from "./bounded-file.js";

const MAX_RULE_FILES = 128;
const MAX_RULE_SOURCE_BYTES = 64 * 1024;

function parseFrontmatter(content: string): { paths?: string[] } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const pathsLine = match[1].match(/^paths:\s*\n((?:\s+-\s*.+\n?)+)/m);
  if (!pathsLine) return {};
  const paths = [...pathsLine[1].matchAll(/^\s+-\s*["']?([^"'\n]+)["']?\s*$/gm)].map((m) => m[1].trim());
  return { paths };
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/{{GLOBSTAR}}/g, ".*")
    .replace(/\{([^}]+)\}/g, (_, inner) => `(${inner.split(",").map((s: string) => s.trim()).join("|")})`)
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  const norm = filePath.replace(/\\/g, "/");
  const basename = path.basename(norm);
  return patterns.some((p) => {
    const matcher = globToRegex(p);
    return matcher.test(norm) || matcher.test(basename);
  });
}

async function listRuleFiles(rulesDir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3 || found.length >= MAX_RULE_FILES) return;
    let handle;
    try {
      handle = await fs.opendir(dir);
    } catch {
      return;
    }
    try {
      for await (const entry of handle) {
        if (found.length >= MAX_RULE_FILES) break;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".md")) found.push(full);
      }
    } finally {
      await handle.close().catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ERR_DIR_CLOSED") throw err;
      });
    }
  }
  await walk(rulesDir, 0);
  return found;
}

export async function loadPathRulesForFile(
  workspaceRoot: string,
  filePath: string
): Promise<Array<{ path: string; content: string }>> {
  const matched: Array<{ path: string; content: string }> = [];
  let rulesDir: string;
  try {
    rulesDir = await validatePath(path.join(workspaceRoot, ".claude", "rules"));
  } catch {
    return matched;
  }

  for (const ruleFile of await listRuleFiles(rulesDir)) {
    try {
      const safeRuleFile = await validatePath(ruleFile);
      const raw = (await readUtf8FilePrefix(safeRuleFile, MAX_RULE_SOURCE_BYTES)).text;
      const fm = parseFrontmatter(raw);
      if (!fm.paths?.length) continue;
      if (!matchesAny(filePath, fm.paths)) continue;
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      if (body) matched.push({ path: safeRuleFile, content: body.slice(0, 4000) });
    } catch {}
  }

  return matched;
}