import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type ToolRisk = "read" | "edit" | "command" | "destructive";

/**
 * Host-facing MCP annotations must describe actual tool effects. ChatGPT action
 * approval is controlled by the host/workspace, not by a local "auto approve"
 * switch, so keep these annotations deterministic across instances and restarts.
 */
export function toolAnnotations(risk: ToolRisk): ToolAnnotations {
  if (risk === "read") {
    return { readOnlyHint: true, openWorldHint: false };
  }
  if (risk === "destructive") {
    return {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: false,
    };
  }
  return {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: risk === "edit",
  };
}
