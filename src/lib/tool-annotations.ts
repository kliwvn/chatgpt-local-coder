import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type ToolRisk =
  | "read"
  | "external_read"
  | "idempotent_additive"
  | "edit"
  | "command"
  | "external"
  | "destructive";

/**
 * Host-facing MCP annotations must describe actual tool effects. ChatGPT action
 * approval is controlled by the host/workspace, not by a local "auto approve"
 * switch, so keep these annotations deterministic across instances and restarts.
 */
export function toolAnnotations(risk: ToolRisk): ToolAnnotations {
  if (risk === "read") {
    return { readOnlyHint: true, openWorldHint: false };
  }
  if (risk === "external_read") {
    return { readOnlyHint: true, openWorldHint: true };
  }
  if (risk === "idempotent_additive") {
    return {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    };
  }
  if (risk === "command" || risk === "external") {
    return {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    };
  }
  return {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: false,
  };
}

/**
 * Preserve upstream annotations when proxying a tool. Missing hints use the
 * MCP specification defaults (write-capable, potentially destructive,
 * non-idempotent, open-world) instead of optimistic local assumptions.
 */
export function proxiedToolAnnotations(annotations?: ToolAnnotations): ToolAnnotations {
  return {
    // Preserve upstream metadata such as annotation.title (and remain forward-
    // compatible with additional annotation fields) while filling only missing
    // effect hints with the MCP specification's conservative defaults.
    ...annotations,
    readOnlyHint: annotations?.readOnlyHint ?? false,
    destructiveHint: annotations?.destructiveHint ?? true,
    idempotentHint: annotations?.idempotentHint ?? false,
    openWorldHint: annotations?.openWorldHint ?? true,
  };
}
