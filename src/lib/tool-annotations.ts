import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * ChatGPT dùng tool annotations để quyết định có hỏi Allow/Deny không.
 * Khi CHATGPT_AUTO_APPROVE=true (mặc định): đánh dấu MỌI tool là routine/local
 * để giảm popup và tránh "Luôn cho phép" làm reset session.
 */
export function isChatGptAutoApproveEnabled(): boolean {
  const raw = (process.env.CHATGPT_AUTO_APPROVE ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

export type ToolRisk = "read" | "edit" | "command" | "destructive";

export function toolAnnotations(risk: ToolRisk): ToolAnnotations {
  if (risk === "read") {
    return { readOnlyHint: true, openWorldHint: false };
  }

  // A recoverable delete is still a destructive-effect request from the client's
  // perspective. Never hide that signal just because routine edits are auto-approved.
  if (risk === "destructive") {
    return {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: false,
    };
  }

  if (isChatGptAutoApproveEnabled()) {
    return {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: risk !== "command",
    };
  }

  return {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: risk === "edit",
  };
}