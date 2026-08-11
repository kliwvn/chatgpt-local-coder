const WRITE_LIKE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "delete_file",
  "delete_directory",
  "copy_file",
  "move_file",
  "create_directory",
  "write_file_base64",
  "run_command",
  "start_process",
  "stop_process",
  "shell_reset",
  "process_input",
  "git_add",
  "git_commit",
  "git_branch",
  "git_checkout",
  "git_restore",
  "git_push",
  "git_pull",
  "git_stash",
  "git_reset",
  "remember",
  "rewind",
  "mcp_call",
]);

interface DispatchStage {
  total: number;
  write_total: number;
  last_at: string | null;
  last_tool: string | null;
  last_write_at: string | null;
  last_write_tool: string | null;
}

export type McpRejectReason =
  | "INVALID_SESSION_ID"
  | "MISSING_SESSION_ID"
  | "STALE_SESSION_REBUILD_FAILED"
  | "HANDLER_ERROR";

interface RejectedDispatchStage extends DispatchStage {
  last_reason: McpRejectReason | null;
  last_write_reason: McpRejectReason | null;
  reasons: Record<McpRejectReason, number>;
}

const reached: DispatchStage = {
  total: 0,
  write_total: 0,
  last_at: null,
  last_tool: null,
  last_write_at: null,
  last_write_tool: null,
};

const executed: DispatchStage = {
  total: 0,
  write_total: 0,
  last_at: null,
  last_tool: null,
  last_write_at: null,
  last_write_tool: null,
};

const rejected: RejectedDispatchStage = {
  total: 0,
  write_total: 0,
  last_at: null,
  last_tool: null,
  last_write_at: null,
  last_write_tool: null,
  last_reason: null,
  last_write_reason: null,
  reasons: {
    INVALID_SESSION_ID: 0,
    MISSING_SESSION_ID: 0,
    STALE_SESSION_REBUILD_FAILED: 0,
    HANDLER_ERROR: 0,
  },
};

function toolNameFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const rpc = body as { method?: unknown; params?: { name?: unknown } };
  if (rpc.method !== "tools/call" || !rpc.params || typeof rpc.params.name !== "string") return null;
  const name = rpc.params.name.trim();
  return name || null;
}

export function isWriteLikeTool(name: string): boolean {
  return WRITE_LIKE_TOOLS.has(name);
}

function advance(stage: DispatchStage, tool: string): void {
  const at = new Date().toISOString();
  stage.total++;
  stage.last_at = at;
  stage.last_tool = tool;
  if (isWriteLikeTool(tool)) {
    stage.write_total++;
    stage.last_write_at = at;
    stage.last_write_tool = tool;
  }
}

export function recordMcpReached(body: unknown): string | null {
  const tool = toolNameFromBody(body);
  if (tool) advance(reached, tool);
  return tool;
}

export function recordMcpExecuted(tool: string | null): void {
  if (tool) advance(executed, tool);
}

export function recordMcpRejected(tool: string | null, reason: McpRejectReason): void {
  if (!tool) return;
  advance(rejected, tool);
  rejected.last_reason = reason;
  rejected.reasons[reason]++;
  if (isWriteLikeTool(tool)) rejected.last_write_reason = reason;
}

export function getMcpDispatchDiagnostics(): Record<string, unknown> {
  const inFlight = {
    total: Math.max(0, reached.total - executed.total - rejected.total),
    write_total: Math.max(0, reached.write_total - executed.write_total - rejected.write_total),
  };
  return {
    interpretation:
      "If ChatGPT reports a tool error but MCP_REACHED does not advance, classify that attempt as HOST_NOT_INVOKED. MCP_REJECTED means the request reached this server but failed a transport/session gate. MCP_IN_FLIGHT means it has reached MCP but has not settled yet.",
    stages: {
      HOST_NOT_INVOKED: {
        inferred: true,
        meaning: "ChatGPT/host rejected or did not dispatch the action before the MCP server.",
      },
      MCP_REACHED: { ...reached },
      MCP_EXECUTED: { ...executed },
      MCP_REJECTED: { ...rejected, reasons: { ...rejected.reasons } },
      MCP_IN_FLIGHT: {
        ...inFlight,
        inferred: true,
        meaning: "Requests that reached MCP and have not yet settled as executed or rejected.",
      },
    },
  };
}
