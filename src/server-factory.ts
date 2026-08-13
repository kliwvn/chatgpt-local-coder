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
import { ensureShellBootstrap } from "./lib/persistent-shell.js";
import { assertNoContractDrift } from "./lib/contract-fingerprint.js";

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
    // Full-profile construction restores raw registration before dynamic
    // upstream proxy registration. Slim never calls this restore function: its
    // filter remains attached for the server lifetime as defense in depth, even
    // though refreshProxiedTools also refuses to run outside the full profile.
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
  await ensureShellBootstrap(workspaceRoot);
  const server = new McpServer(
    {
      name: "codex-mcp-server",
      version: "2.0.0",
    },
    {
      capabilities: {
        logging: {},
        // The slim profile is a frozen ChatGPT ABI: the tool inventory never
        // changes after initialize, so listChanged must not be advertised.
        // The full (dynamic) profile keeps listChanged for upstream proxies.
        tools: getChatGptToolProfile() === "full" ? { listChanged: true } : {},
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

  const profile = getChatGptToolProfile();
  const restoreRegisterTool = applyToolProfile(server);

  registerFilesystemTools(server);
  registerShellTools(server, workspaceRoot, shellTimeout);
  registerGitTools(server, workspaceRoot);
  registerContextTools(server, workspaceRoot);
  registerRewindTools(server);

  if (profile === "full") {
    // Bridge tools exist on every server regardless of manager attachment; the
    // full profile additionally restores raw registration so upstream proxies
    // can be registered dynamically.
    registerMcpBridgeTools(server, upstreamManager ?? null);
    restoreRegisterTool();
    if (upstreamManager) {
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
    }
    return server;
  }
  // slim: keep the profile filter attached for the whole server lifetime so no
  // later proxy refresh can ever leak native upstream tools into the stable
  // ChatGPT inventory, and register the bridge tools unconditionally (with or
  // without an upstream manager) so the tool list is invariant.
  registerMcpBridgeTools(server, upstreamManager ?? null);
  // The SDK hard-codes `listChanged: true` the moment the first tool is
  // registered. The slim profile is a frozen inventory that never changes, so
  // it must not advertise listChanged; override the capability on the
  // underlying Server after all registrations and before any transport
  // connects (the McpServer wrapper exposes `server` for advanced use).
  server.server.registerCapabilities({ tools: { listChanged: false } });
  // Fail closed on accidental contract drift: compare the live registration
  // (serialized exactly like a host tools/list) against the authoritative
  // fixture before the session is publishable.
  await assertNoContractDrift(server);
  return server;
}