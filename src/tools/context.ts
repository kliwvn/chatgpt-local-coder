import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit, getAuditPath } from "../lib/audit.js";
import { describePermissionProfile, getPermissionProfile } from "../lib/permissions.js";
import { getDefaultCwd, getFullDiskAccess, getMachineRoots } from "../lib/path-security.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { MCP_QUICKSTART } from "../lib/quickstart.js";
import { getCheckpointConfig } from "../lib/checkpoint.js";
import { getUpstreamManager } from "../lib/mcp-upstream-manager.js";
import { appendAutoMemory } from "../lib/auto-memory.js";
import { loadPathRulesForFile } from "../lib/path-rules.js";
import { toolResult } from "../lib/tool-result.js";
import { readUtf8FilePrefix } from "../lib/bounded-file.js";



const contextFileNames = [
  "CLAUDE.md",
  "AGENTS.md",
  "README.md",
  ".claude/settings.json",
  ".codex/config.toml",
  ".cursor/rules",
];

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findContextFiles(root: string, maxDepth: number, maxFiles: number): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || found.length >= maxFiles) return;

    for (const name of contextFileNames) {
      const candidate = path.join(dir, name);
      if (found.length >= maxFiles) break;
      if (!(await exists(candidate))) continue;
      try {
        found.push(await validatePath(candidate));
      } catch {}
    }

    if (depth === maxDepth) return;

    let handle;
    try {
      handle = await fs.opendir(dir);
    } catch {
      return;
    }
    try {
      for await (const entry of handle) {
        if (found.length >= maxFiles) break;
        if (entry.isSymbolicLink()) continue;
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
        await walk(path.join(dir, entry.name), depth + 1);
      }
    } finally {
      await handle.close().catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ERR_DIR_CLOSED") throw err;
      });
    }
  }

  await walk(root, 0);
  return [...new Set(found)];
}

export function registerContextTools(server: McpServer, workspaceRoot: string): void {
  server.registerTool(
    "project_context",
    {
      title: "Project Context",
      description:
        "Load CLAUDE.md/AGENTS.md for a project path. Use when the task targets a repo other than WORKSPACE_PATH (default project is already in MCP instructions).",
      inputSchema: {
        path: z.string().optional().describe("Project directory, defaults to primary workspace"),
        max_depth: z.number().int().min(0).max(5).optional().default(3),
        max_files: z.number().int().min(1).max(200).optional().default(50),
        max_bytes_per_file: z.number().int().positive().max(200000).optional().default(60000),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ path: projectPath, max_depth, max_files, max_bytes_per_file }) => {
      const root = await validatePath(projectPath || workspaceRoot);
      const files = await findContextFiles(root, max_depth, max_files);
      const fileContents: Array<{ path: string; content: string; truncated: boolean }> = [];

      for (const file of files) {
        try {
          const prefix = await readUtf8FilePrefix(file, max_bytes_per_file);
          fileContents.push({ path: file, content: prefix.text, truncated: prefix.truncated });
        } catch {}
      }

      await audit({ tool: "project_context", action: "read", target: root, status: "ok", details: { files: files.length } });
      return toolResult("project_context", { root, files: fileContents, count: fileContents.length });
    }
  );

  server.registerTool(
    "agent_status",
    {
      title: "Agent Status",
      description:
        "Optional: full tool cheat sheet, apply_patch format, permissions, and upstream MCP list. Default workflow is already in MCP instructions.",
      inputSchema: {},

      annotations: toolAnnotations("read"),
    },
    async () => {
      const upstreamManager = getUpstreamManager();
      let upstream: Awaited<ReturnType<typeof upstreamManager.listStatuses>> = [];
      try {
        upstream = await upstreamManager.listStatuses({ probe: false });
      } catch {}
      return toolResult("agent_status", {
        permission_profile: getPermissionProfile(),
        permission_description: describePermissionProfile(),
        full_machine_access: getFullDiskAccess(),
        path_sandbox_enabled: !getFullDiskAccess(),
        shell_commands_os_sandboxed: false,
        default_cwd: getDefaultCwd(),
        machine_roots: getMachineRoots(),
        audit_log: getAuditPath(),
        pid: process.pid,
        node: process.version,
        quickstart: MCP_QUICKSTART,
        rewind: getCheckpointConfig(),
        upstream_mcp: {
          config_path: upstreamManager.getConfigPath(),
          servers: upstream,
        },
        admin_ui: `http://127.0.0.1:${process.env.ADMIN_PORT || "3001"}/ui`,
        tool_profile: process.env.CHATGPT_TOOL_PROFILE || "slim",
      });
    }
  );

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description: "Save a note to auto memory for future ChatGPT sessions (like Claude Code MEMORY.md).",
      inputSchema: {
        note: z.string().describe("Short fact to remember: build command, convention, gotcha"),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ note }) => {
      const file = await appendAutoMemory(workspaceRoot, note);
      await audit({ tool: "remember", action: "append", target: file, status: "ok" });
      return toolResult("remember", { saved_to: file, note }, { summary: "saved to auto memory" });
    }
  );

  server.registerTool(
    "load_path_rules",
    {
      title: "Load Path Rules",
      description:
        "Load .claude/rules/*.md scoped to a file path (Claude Code path-specific rules). Call after read_text_file when editing unfamiliar areas.",
      inputSchema: {
        path: z.string().describe("File path to match against rule paths: frontmatter"),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ path: filePath }) => {
      const validPath = await validatePath(filePath);
      const rules = await loadPathRulesForFile(workspaceRoot, validPath);
      await audit({ tool: "load_path_rules", action: "read", target: validPath, status: "ok", details: { rules: rules.length } });
      return toolResult("load_path_rules", { path: validPath, rules, count: rules.length });
    }
  );
}