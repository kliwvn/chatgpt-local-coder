import {
  MCP_TOOL_RESULT_MAX_BYTES,
  MCP_TOOL_RESULT_TEXT_DUPLICATE_MAX_BYTES,
  utf8Prefix,
} from "./output-budget.js";

/**
 * Chuẩn output JSON cho mọi tool — ChatGPT dễ parse.
 *
 * Schema:
 * { ok, tool, summary, data }
 */
export interface ToolResultPayload<T = Record<string, unknown>> {
  ok: boolean;
  tool: string;
  summary: string;
  data: T;
  [key: string]: unknown;
}

export function toolResult<T extends object>(
  tool: string,
  data: T,
  options?: { ok?: boolean; summary?: string }
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const payload: ToolResultPayload = {
    ok: options?.ok ?? true,
    tool,
    summary: options?.summary ?? defaultSummary(tool, data as Record<string, unknown>),
    data: data as Record<string, unknown>,
  };

  const payloadJson = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  const text =
    payloadBytes <= MCP_TOOL_RESULT_TEXT_DUPLICATE_MAX_BYTES
      ? payloadJson
      : JSON.stringify({
          ok: payload.ok,
          tool: payload.tool,
          summary: payload.summary,
          data: { structured_content: true, payload_bytes: payloadBytes },
        });
  const result = {
    content: [{ type: "text" as const, text }],
    structuredContent: payload as Record<string, unknown>,
  };

  // Avoid serializing a potentially multi-megabyte structured payload a second
  // time just to estimate the outer result size. payloadJson is exactly the JSON
  // representation used by structuredContent; only the small envelope/text need
  // to be measured separately here.
  const resultBytes =
    Buffer.byteLength('{"content":[{"type":"text","text":', "utf8") +
    Buffer.byteLength(JSON.stringify(text), "utf8") +
    Buffer.byteLength('}],"structuredContent":', "utf8") +
    payloadBytes +
    1;
  if (resultBytes <= MCP_TOOL_RESULT_MAX_BYTES) {
    return result;
  }

  // Last-resort wire guard for huge diffs, directory trees or upstream MCP
  // payloads that bypass source-specific caps. Return a useful preview instead
  // of letting the Secure MCP Tunnel fail the entire tool call with HTTP 413.
  const previewBytes = Math.min(64 * 1024, Math.max(8 * 1024, Math.floor(MCP_TOOL_RESULT_MAX_BYTES / 8)));
  const compactPayload: ToolResultPayload = {
    ok: payload.ok,
    tool: payload.tool,
    summary: `${payload.summary} (result truncated to MCP wire budget)`,
    data: {
      truncated: true,
      original_payload_bytes: payloadBytes,
      wire_budget_bytes: MCP_TOOL_RESULT_MAX_BYTES,
      preview: utf8Prefix(payloadJson, previewBytes),
      hint: "Refine the request or use offset/limit/head/tail for large outputs.",
    },
  };
  const compactJson = JSON.stringify(compactPayload);
  return {
    content: [{ type: "text" as const, text: compactJson }],
    structuredContent: compactPayload as Record<string, unknown>,
  };
}

export function toolError(tool: string, message: string, data?: Record<string, unknown>) {
  return toolResult(tool, { error: message, ...data }, { ok: false, summary: message });
}

function defaultSummary(tool: string, data: Record<string, unknown>): string {
  if (typeof data.path === "string") return `${tool}: ${data.path}`;
  if (typeof data.command === "string") return `${tool}: ${data.command}`;
  if (Array.isArray(data.files)) return `${tool}: ${data.files.length} file(s)`;
  if (Array.isArray(data.matches)) return `${tool}: ${data.matches.length} match(es)`;
  if (typeof data.exit_code === "number") return `${tool}: exit ${data.exit_code}`;
  return `${tool}: done`;
}