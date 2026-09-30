import fs from "fs/promises";
import os from "os";
import path from "path";
import { validateContextReadPath, validatePathWithinRoots } from "./path-security.js";
import { readUtf8FilePrefix } from "./bounded-file.js";

export type SkillScope = "global" | "project";

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
}

export interface SkillDiscovery {
  agents_md: string | null;
  global_harness_root: string | null;
  global_skills_root: string | null;
  project_skills_root: string;
  global_skills: SkillSummary[];
  project_skills: SkillSummary[];
  total_skills: number;
  loading_policy: string;
  ownership_note: string;
}

const MAX_PROJECT_SKILLS = 64;
const MAX_GLOBAL_SKILLS = 128;
const MAX_SKILL_DEPTH = 8;
const MAX_SKILL_SOURCE_BYTES = 64 * 1024;
const SKILL_SCAN_CONCURRENCY = 16;

function cleanYamlScalar(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const lines = block.split(/\r?\n/);

  const nameLine = lines.find((line) => /^name:\s*/.test(line));
  const name = cleanYamlScalar(nameLine?.replace(/^name:\s*/, ""));

  const descriptionIndex = lines.findIndex((line) => /^description:\s*/.test(line));
  if (descriptionIndex < 0) return { name };

  const rawDescription = lines[descriptionIndex].replace(/^description:\s*/, "").trim();
  if (!/^[>|][+-]?$/.test(rawDescription)) {
    return { name, description: cleanYamlScalar(rawDescription) };
  }

  const folded: string[] = [];
  for (let i = descriptionIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S[^:]*:\s*/.test(line)) break;
    if (!line.trim()) {
      if (folded.length && folded[folded.length - 1] !== "") folded.push("");
      continue;
    }
    if (!/^\s+/.test(line)) break;
    folded.push(line.trim());
  }

  const description = folded.join(" ").replace(/\s+/g, " ").trim();
  return { name, description: description || undefined };
}

function fallbackDescription(content: string, name: string): string {
  return (
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#") && line !== "---" && !/^[\w-]+:\s*/.test(line)) ||
    name
  );
}

async function loadSkillsFromDirectory(
  canonicalSkillsRoot: string,
  scope: SkillScope,
  maxSkills: number
): Promise<SkillSummary[]> {
  const out: SkillSummary[] = [];

  function isWithinSkillsRoot(candidate: string): boolean {
    const rel = path.relative(canonicalSkillsRoot, candidate);
    const normalized = process.platform === "win32" ? rel.toLowerCase() : rel;
    return (
      normalized === "" ||
      (normalized !== ".." &&
        !normalized.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(normalized))
    );
  }

  async function canonicalExistingWithinSkillsRoot(candidate: string): Promise<string> {
    const canonical = await fs.realpath(candidate);
    if (!isWithinSkillsRoot(canonical)) {
      throw new Error(`Skill path escapes catalog root: ${candidate}`);
    }
    return canonical;
  }

  async function inspectDirectory(dir: string): Promise<{
    skill: SkillSummary | null;
    childDirectories: string[];
  } | null> {
    let safeDir: string;
    try {
      safeDir = await canonicalExistingWithinSkillsRoot(dir);
    } catch {
      return null;
    }

    let entries;
    try {
      entries = await fs.readdir(safeDir, { withFileTypes: true });
    } catch {
      return null;
    }

    let skill: SkillSummary | null = null;
    const skillEntry = entries.find((entry) => entry.name === "SKILL.md");
    if (skillEntry) {
      try {
        const safeSkillFile = await canonicalExistingWithinSkillsRoot(
          path.join(safeDir, skillEntry.name)
        );
        const stat = await fs.stat(safeSkillFile);
        if (stat.isFile()) {
          const content = (await readUtf8FilePrefix(safeSkillFile, MAX_SKILL_SOURCE_BYTES)).text;
          const fm = parseFrontmatter(content);
          const fallbackName = path.basename(path.dirname(safeSkillFile));
          const name = fm.name || fallbackName;
          const description = fm.description || fallbackDescription(content, name);
          skill = {
            name,
            description: description.slice(0, 240),
            path: safeSkillFile,
            scope,
          };
        }
      } catch {}
    }

    const childDirectories = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .filter(
        (entry) =>
          !entry.name.startsWith(".") &&
          entry.name !== "node_modules" &&
          entry.name !== "dist" &&
          entry.name !== "build"
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => path.join(safeDir, entry.name));

    return { skill, childDirectories };
  }

  let currentDirectories = [canonicalSkillsRoot];
  for (
    let depth = 0;
    depth <= MAX_SKILL_DEPTH && currentDirectories.length > 0 && out.length < maxSkills;
    depth++
  ) {
    const nextDirectories: string[] = [];

    // Windows filesystem/AV latency dominates this bootstrap scan when every
    // directory is awaited serially. Process a bounded batch concurrently while
    // keeping deterministic directory ordering and the same canonical root
    // containment checks for every directory and SKILL.md file.
    for (
      let offset = 0;
      offset < currentDirectories.length && out.length < maxSkills;
      offset += SKILL_SCAN_CONCURRENCY
    ) {
      const batch = currentDirectories.slice(offset, offset + SKILL_SCAN_CONCURRENCY);
      const inspected = await Promise.all(batch.map((dir) => inspectDirectory(dir)));
      for (const result of inspected) {
        if (!result) continue;
        if (result.skill && out.length < maxSkills) out.push(result.skill);
        if (out.length >= maxSkills) break;
        nextDirectories.push(...result.childDirectories);
      }
    }

    currentDirectories = nextDirectories;
  }

  return out
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    .slice(0, maxSkills);
}

export function getGlobalAgentsRoot(): string {
  return path.join(os.homedir(), ".agents");
}

export function getGlobalHarnessRoot(): string {
  return path.join(getGlobalAgentsRoot(), "global-harness");
}

export function getGlobalSkillsRoot(): string {
  return path.join(getGlobalAgentsRoot(), "skills");
}

export function getProjectSkillsRoot(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".claude", "skills");
}

async function resolveContextFile(candidate: string): Promise<string | null> {
  try {
    const safe = await validateContextReadPath(candidate);
    const stat = await fs.lstat(safe);
    return stat.isFile() && !stat.isSymbolicLink() ? safe : null;
  } catch {
    return null;
  }
}

async function resolveContextDirectory(candidate: string): Promise<string | null> {
  try {
    const safe = await validateContextReadPath(candidate);
    const stat = await fs.lstat(safe);
    return stat.isDirectory() && !stat.isSymbolicLink() ? safe : null;
  } catch {
    return null;
  }
}

export async function loadProjectSkills(workspaceRoot: string): Promise<SkillSummary[]> {
  const skillsDir = getProjectSkillsRoot(workspaceRoot);
  let canonicalSkillsRoot: string;
  try {
    // Project skill discovery is automatic project-controlled context. Keep it
    // inside the selected project even when ordinary reads have trusted
    // FULL_DISK_ACCESS authority.
    canonicalSkillsRoot = await validatePathWithinRoots(skillsDir, [workspaceRoot]);
    const stat = await fs.stat(canonicalSkillsRoot);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }
  return loadSkillsFromDirectory(canonicalSkillsRoot, "project", MAX_PROJECT_SKILLS);
}

export async function loadGlobalSkills(): Promise<SkillSummary[]> {
  const skillsDir = await resolveContextDirectory(getGlobalSkillsRoot());
  if (!skillsDir) return [];
  return loadSkillsFromDirectory(skillsDir, "global", MAX_GLOBAL_SKILLS);
}

export async function loadSkillDiscovery(workspaceRoot: string): Promise<SkillDiscovery> {
  const projectSkillsRoot = getProjectSkillsRoot(workspaceRoot);
  const [agentsMd, globalHarnessRoot, globalSkillsRoot, globalSkills, projectSkills] =
    await Promise.all([
    resolveContextFile(path.join(getGlobalAgentsRoot(), "AGENTS.md")),
    resolveContextDirectory(getGlobalHarnessRoot()),
    resolveContextDirectory(getGlobalSkillsRoot()),
    loadGlobalSkills(),
    loadProjectSkills(workspaceRoot),
  ]);

  return {
    agents_md: agentsMd,
    global_harness_root: globalHarnessRoot,
    global_skills_root: globalSkillsRoot,
    project_skills_root: projectSkillsRoot,
    global_skills: globalSkills,
    project_skills: projectSkills,
    total_skills: globalSkills.length + projectSkills.length,
    loading_policy:
      "Discovery only. Match the current task against skill descriptions, then read the selected SKILL.md on demand; do not inject every skill body into MCP instructions.",
    ownership_note:
      "~/.agents/skills is an execution-environment skill catalog and is not owned/routed by Global Harness merely because it is a sibling of ~/.agents/global-harness.",
  };
}

function formatSkillLines(skills: SkillSummary[]): string[] {
  return skills.map(
    (skill) => "- **" + skill.name + "**: " + skill.description + " [" + skill.path + "]"
  );
}

export function formatSkillsForInstructions(discovery: SkillDiscovery): string {
  const blocks: string[] = [
    "## Local bootstrap discovery",
    "- Global AGENTS.md: " + (discovery.agents_md || "(not present/canonical)"),
    "- Global Harness root: " + (discovery.global_harness_root || "(not present/canonical)"),
    "- Global skills root: " + (discovery.global_skills_root || "(not present/canonical)"),
    "- Project skills root: " + discovery.project_skills_root,
    "- Skill loading: " + discovery.loading_policy,
    "- Ownership: " + discovery.ownership_note,
  ];

  if (discovery.global_skills.length > 0) {
    blocks.push(
      "",
      "### Global skill catalog (discovery metadata only)",
      ...formatSkillLines(discovery.global_skills)
    );
  }

  if (discovery.project_skills.length > 0) {
    blocks.push(
      "",
      "### Project skill catalog (discovery metadata only)",
      ...formatSkillLines(discovery.project_skills)
    );
  }

  return blocks.join("\n");
}
