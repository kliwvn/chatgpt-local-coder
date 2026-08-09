import { envBoundedInteger } from "./env-utils.js";

// OpenAI Secure MCP Tunnel rejects a request/response body above 10 MiB. Keep a
// conservative margin for the outer JSON-RPC envelope and HTTP framing.
export const MCP_TOOL_RESULT_MAX_BYTES = envBoundedInteger(
  "MCP_TOOL_RESULT_MAX_BYTES",
  7 * 1024 * 1024,
  256 * 1024,
  8 * 1024 * 1024
);

// `toolResult` historically duplicated the complete payload in both text content
// and structuredContent. Preserve that convenient text form for small results,
// but stop doubling medium/large payloads (and model context) on the wire.
export const MCP_TOOL_RESULT_TEXT_DUPLICATE_MAX_BYTES = envBoundedInteger(
  "MCP_TOOL_RESULT_TEXT_DUPLICATE_MAX_BYTES",
  128 * 1024,
  16 * 1024,
  512 * 1024
);

export const SHELL_OUTPUT_MAX_CHARS = envBoundedInteger(
  "SHELL_OUTPUT_MAX_CHARS",
  250_000,
  4_096,
  1_000_000
);

export const GIT_OUTPUT_MAX_CHARS = envBoundedInteger(
  "GIT_OUTPUT_MAX_CHARS",
  500_000,
  4_096,
  2_000_000
);

export const READ_TEXT_MAX_BYTES = envBoundedInteger(
  "READ_TEXT_MAX_BYTES",
  2 * 1024 * 1024,
  64 * 1024,
  6 * 1024 * 1024
);

// Base64 expands binary data by roughly 4/3 before the JSON envelope. A 2 MiB
// binary chunk stays comfortably below the tunnel result budget.
export const READ_BASE64_MAX_BYTES = envBoundedInteger(
  "READ_BASE64_MAX_BYTES",
  2 * 1024 * 1024,
  64 * 1024,
  2 * 1024 * 1024
);

export function appendBoundedTail(
  current: string,
  chunk: string,
  maxChars: number,
  wasTruncated = false
): { text: string; truncated: boolean } {
  if (!chunk) return { text: current, truncated: wasTruncated };
  if (chunk.length >= maxChars) {
    return { text: chunk.slice(-maxChars), truncated: true };
  }
  const combined = current + chunk;
  if (combined.length <= maxChars) {
    return { text: combined, truncated: wasTruncated };
  }
  return { text: combined.slice(-maxChars), truncated: true };
}

export function appendBoundedHead(
  current: string,
  chunk: string,
  maxChars: number,
  wasTruncated = false
): { text: string; truncated: boolean } {
  if (!chunk) return { text: current, truncated: wasTruncated };
  if (current.length >= maxChars) return { text: current, truncated: true };
  const remaining = maxChars - current.length;
  if (chunk.length <= remaining) {
    return { text: current + chunk, truncated: wasTruncated };
  }
  return { text: current + chunk.slice(0, remaining), truncated: true };
}

/** UTF-8-safe prefix bounded by bytes rather than JS UTF-16 code units. */
export function utf8Prefix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  // Avoid returning a dangling high surrogate if the byte boundary lands between
  // a UTF-16 surrogate pair.
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1]) && /[\uDC00-\uDFFF]/.test(text[low] ?? "")) {
    low--;
  }
  return text.slice(0, low);
}