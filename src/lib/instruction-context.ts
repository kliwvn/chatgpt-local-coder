import { CODEX_AGENT_PROMPT } from "./codex-agent-prompt.js";
import {
  collectGitSnapshot,
  formatEnvironmentForInstructions,
  formatGitSnapshotForInstructions,
  type GitSnapshot,
} from "./git-snapshot.js";
import {
  formatProjectMemoryForInstructions,
  getCanonicalGlobalHarnessBootstrapPath,
  loadProjectMemory,
  type ProjectMemoryBundle,
} from "./project-memory.js";
import { appendAutoMemory, formatAutoMemoryForInstructions, loadAutoMemory } from "./auto-memory.js";
import { formatSkillsForInstructions, loadProjectSkills } from "./skills-loader.js";
import { getChatGptToolProfile } from "./tool-profile.js";
import { getFullDiskAccess } from "./path-security.js";
import { buildServerInstructions } from "./quickstart.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export interface InstructionContextOptions {
  workspaceRoot: string;
  workspaceRoots: string[];
  pid: number;
  adminPort: number;
}

export interface InstructionContext {
  projectMemory: ProjectMemoryBundle;
  git: GitSnapshot;
  instructionsText: string;
  instructionBytes: number;
}

export function hasCanonicalGlobalHarnessBootstrap(projectMemory: ProjectMemoryBundle): boolean {
  const expected = path.resolve(getCanonicalGlobalHarnessBootstrapPath());
  return projectMemory.sections.some((section) => {
    if (section.kind !== "user") return false;
    const actual = path.resolve(section.path);
    return process.platform === "win32"
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  });
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function inspectGlobalHarnessFreshness(projectMemory: ProjectMemoryBundle): Record<string, unknown> {
  const expected = path.resolve(getCanonicalGlobalHarnessBootstrapPath());
  const loaded = projectMemory.sections.find(
    (section) => section.kind === "user" && samePath(section.path, expected)
  );

  let currentExists = false;
  let currentCanonical = false;
  let currentBytes: number | null = null;
  let currentSha256: string | null = null;
  let currentError: string | null = null;
  try {
    const stat = fs.lstatSync(expected);
    currentExists = true;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      currentError = "canonical bootstrap path is not an exact regular file";
    } else {
      const real = fs.realpathSync(expected);
      currentCanonical = samePath(real, expected);
      if (!currentCanonical) {
        currentError = "canonical bootstrap path resolves through an alias/reparse path";
      } else {
        const bytes = fs.readFileSync(expected);
        currentBytes = bytes.length;
        currentSha256 = sha256(bytes);
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") currentError = err instanceof Error ? err.message : String(err);
  }

  let reason = "current";
  let restartRequired = false;
  if (loaded) {
    if (!currentExists) {
      reason = "loaded_bootstrap_missing";
      restartRequired = true;
    } else if (!currentCanonical || currentError) {
      reason = "loaded_bootstrap_no_longer_canonical";
      restartRequired = true;
    } else if (currentSha256 !== loaded.source_sha256 || currentBytes !== loaded.source_bytes) {
      reason = "bootstrap_changed_after_process_start";
      restartRequired = true;
    }
  } else if (currentExists && currentCanonical && !currentError) {
    reason = "canonical_bootstrap_appeared_after_process_start";
    restartRequired = true;
  } else if (currentError) {
    reason = "canonical_bootstrap_invalid";
    restartRequired = true;
  } else {
    reason = "canonical_bootstrap_absent";
  }

  return {
    active_in_snapshot: Boolean(loaded),
    path: expected,
    loaded_bytes: loaded?.source_bytes ?? null,
    loaded_sha256: loaded?.source_sha256 ?? null,
    current_exists: currentExists,
    current_canonical: currentCanonical,
    current_bytes: currentBytes,
    current_sha256: currentSha256,
    stale: restartRequired,
    restart_required: restartRequired,
    reason,
    ...(currentError ? { error: currentError } : {}),
  };
}

export async function buildInstructionContext(
  opts: InstructionContextOptions
): Promise<InstructionContext> {
  const [projectMemory, git, skills] = await Promise.all([
    loadProjectMemory(opts.workspaceRoot, { workspaceRoots: opts.workspaceRoots }),
    collectGitSnapshot(opts.workspaceRoot),
    loadProjectSkills(opts.workspaceRoot),
  ]);
  // Global Harness Memory/project continuity is the canonical owner when its
  // bootstrap is present. Do not inject Local Coder's legacy host-local auto
  // memory into the same context and create a competing/stale memory plane.
  const autoMemory = hasCanonicalGlobalHarnessBootstrap(projectMemory)
    ? null
    : await loadAutoMemory(opts.workspaceRoot);

  const profile = getChatGptToolProfile();

  const blocks = [
    CODEX_AGENT_PROMPT,
    `Tool profile: **${profile}** (${profile === "slim" ? "core tools only — optimal for ChatGPT web" : "all tools exposed"}).`,
    formatEnvironmentForInstructions({
      workspaceRoot: opts.workspaceRoot,
      workspaceRoots: opts.workspaceRoots,
      pid: opts.pid,
      adminPort: opts.adminPort,
      nodeVersion: process.version,
    }),
    formatGitSnapshotForInstructions(git),
    formatAutoMemoryForInstructions(autoMemory),
    formatProjectMemoryForInstructions(projectMemory),
    formatSkillsForInstructions(skills),
  ].filter(Boolean);

  const projectMemoryBlock = blocks.join("\n\n");
  const instructionsText = buildServerInstructions(
    opts.workspaceRoot,
    opts.workspaceRoots,
    getFullDiskAccess(),
    projectMemoryBlock
  );

  return {
    projectMemory,
    git,
    instructionsText,
    instructionBytes: Buffer.byteLength(instructionsText, "utf-8"),
  };
}

export function summarizeInstructionContext(ctx: InstructionContext): Record<string, unknown> {
  return {
    root: ctx.projectMemory.root,
    workspace_roots: ctx.projectMemory.workspace_roots,
    memory_files: ctx.projectMemory.sections.map((s) => ({
      path: s.path,
      kind: s.kind,
      truncated: s.truncated,
      source_bytes: s.source_bytes,
      source_sha256: s.source_sha256,
    })),
    memory_bytes: ctx.projectMemory.total_bytes,
    instruction_bytes: ctx.instructionBytes,
    instruction_sha256: sha256(ctx.instructionsText),
    global_harness: inspectGlobalHarnessFreshness(ctx.projectMemory),
    git: ctx.git.is_repo
      ? { branch: ctx.git.branch, commits: ctx.git.recent_commits?.length ?? 0 }
      : { is_repo: false },
    loaded_at: ctx.projectMemory.loaded_at,
    tool_profile: getChatGptToolProfile(),
  };
}

export { appendAutoMemory };