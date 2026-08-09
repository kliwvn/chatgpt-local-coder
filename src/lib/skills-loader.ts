import fs from "fs/promises";
import path from "path";
import { validatePath } from "./path-security.js";
import { readUtf8FilePrefix } from "./bounded-file.js";

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

const MAX_SKILLS = 20;
const MAX_SKILL_SOURCE_BYTES = 64 * 1024;

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

export async function loadProjectSkills(workspaceRoot: string): Promise<SkillSummary[]> {
  const skillsDir = path.join(workspaceRoot, ".claude", "skills");
  const out: SkillSummary[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3 || out.length >= MAX_SKILLS) return;
    let handle;
    try {
      handle = await fs.opendir(dir);
    } catch {
      return;
    }
    try {
      for await (const entry of handle) {
        if (out.length >= MAX_SKILLS) break;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const skillFile = path.join(full, "SKILL.md");
          try {
            const safeSkillFile = await validatePath(skillFile);
            const content = (await readUtf8FilePrefix(safeSkillFile, MAX_SKILL_SOURCE_BYTES)).text;
            const fm = parseFrontmatter(content);
            const name = fm.name || entry.name;
            const description = fm.description || content.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() || name;
            out.push({ name, description: description.slice(0, 200), path: safeSkillFile });
          } catch {
            await walk(full, depth + 1);
          }
        }
      }
    } finally {
      await handle.close().catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ERR_DIR_CLOSED") throw err;
      });
    }
  }

  await walk(skillsDir, 0);
  return out;
}

export function formatSkillsForInstructions(skills: SkillSummary[]): string {
  if (!skills.length) return "";
  return [
    "## Skills (invoke manually — ChatGPT has no /slash; describe the skill in your prompt)",
    ...skills.map((s) => `- **${s.name}**: ${s.description}`),
  ].join("\n");
}