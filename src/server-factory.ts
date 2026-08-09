import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerShellTools } from "./tools/shell.js";
import { registerGitTools } from "./tools/git.js";
import { registerContextTools } from "./tools/context.js";
import { registerRewindTools } from "./tools/rewind.js";
import { registerMcpBridgeTools } from "./tools/mcp-bridge.js";
import { buildServerInstructions } from "./lib/quickstart.js";
import type { McpUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { refreshProxiedTools } from "./lib/mcp-tool-proxy.js";
import { getChatGptToolProfile, shouldExposeTool } from "./lib/tool-profile.js";

const NOOP_TOOL = {
  remove: () => {},
  update: () => {},
  enable: () => {},
  disable: () => {},
  handler: async () => ({ content: [] }),
  enabled: false,
} as unknown as RegisteredTool;

function applyToolProfile(server: McpServer): () => void {
  const profile = getChatGptToolProfile();
  if (profile === "full") return () => {};

  const original = server.registerTool.bind(server);
  server.registerTool = ((name, ...rest) => {
    if (!shouldExposeTool(String(name), profile)) return NOOP_TOOL;
    return original(name, ...rest);
  }) as typeof server.registerTool;
  return () => {
    // The slim profile filters built-in/bridge tools only. Explicit upstream
    // allowlist/all proxy tools are already controlled by upstream config and
    // must remain callable, otherwise refreshProxiedTools records NOOP entries
    // that never appear in tools/list.
    server.registerTool = original as typeof server.registerTool;
  };
}

export async function createMcpServer(
  workspaceRoot: string,
  shellTimeout: number,
  workspaceRoots: string[] = [workspaceRoot],
  fullDiskAccess = false,
  upstreamManager?: McpUpstreamManager,
  serverInstructions?: string
): Promise<McpServer> {
  const server = new McpServer(
    {
      name: "codex-mcp-server",
      version: "2.0.0",
    },
    {
      capabilities: {
        logging: {},
        tools: { listChanged: true },
      },
      // instruction-context already builds the complete server instruction
      // document (agent workflow + env/git/project memory + quick pointers).
      // Re-wrapping that document with buildServerInstructions() duplicated the
      // header/footer on every initialize response. Only synthesize the minimal
      // default here when the caller did not provide a complete document.
      instructions:
        serverInstructions?.trim() ||
        buildServerInstructions(workspaceRoot, workspaceRoots, fullDiskAccess),
    }
  );

  const restoreRegisterTool = applyToolProfile(server);

  registerFilesystemTools(server);
  registerShellTools(server, workspaceRoot, shellTimeout);
  registerGitTools(server, workspaceRoot);
  registerContextTools(server, workspaceRoot);
  registerRewindTools(server);

  if (upstreamManager) {
    registerMcpBridgeTools(server, upstreamManager);
    restoreRegisterTool();
    upstreamManager.registerMcpServer(server);
    // A client may issue tools/list immediately after initialize. Do not expose
    // the session until all configured proxy tools have been registered, or the
    // first tools/list becomes timing-dependent. Upstream tool discovery itself
    // is cached by McpUpstreamManager, so warm-session cost stays low.
    try {
      await refreshProxiedTools(server, upstreamManager);
    } catch (err) {
      upstreamManager.unregisterMcpServer(server);
      await server.close().catch(() => undefined);
      throw err;
    }
  } else {
    restoreRegisterTool();
  }

  return server;
}