export const REDACTED_MASK = "********";

export const SECRET_KEY_PATTERN =
  /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|AUTHORIZATION|CREDENTIAL|PRIVATE|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)(_|$)|API_KEY|MCP_API_KEY/i;

export function isSecretKeyName(key: string): boolean {
  const normalized = key.replace(/^\$?env:/i, "").replace(/[-.]/g, "_");
  return SECRET_KEY_PATTERN.test(normalized);
}

function redactAssignment(match: string, prefix: string, key: string, _value: string): string {
  return isSecretKeyName(key) ? `${prefix}${key}=${REDACTED_MASK}` : match;
}

function redactColonAssignment(match: string, quote: string, key: string, value: string): string {
  if (!isSecretKeyName(key)) return match;
  // Preserve the source value's quote style. JSON string fields stay valid,
  // while shell/log object-like text keeps its original unquoted shape.
  const valueQuote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
  return `${quote}${key}${quote}:${valueQuote}${REDACTED_MASK}${valueQuote}`;
}

/**
 * Best-effort redaction for shell commands, headers, URLs and serialized blobs.
 * Structured objects are additionally handled by redactSensitiveValue().
 */
export function redactSensitiveText(input: string): string {
  let text = String(input);

  // Authorization must be handled before generic key:value masking. Mask the
  // complete quoted header when possible, then conservatively mask the remainder
  // of an unquoted header value. This covers Basic/Digest/AWS-style schemes too,
  // instead of masking only the scheme token and leaving the credential behind.
  text = text.replace(
    /(["'])((?:proxy-)?authorization\s*[:=]\s*)(?!\*{4,})[^"'\r\n]*\1/gi,
    `$1$2${REDACTED_MASK}$1`
  );
  text = text.replace(
    /((?:proxy-)?authorization\s*[:=])(?!(?:[ \t]*\*{4,}))[ \t]*(?:(?:basic|bearer|token)\s+[^\s,;&'\"]+|(?:digest|aws4-hmac-sha256)\s+[^;\r\n]+|[^\s,;&'\"]+)/gi,
    `$1${REDACTED_MASK}`
  );
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{6,}={0,2}/gi, `Bearer ${REDACTED_MASK}`);

  // Shell/env assignments: OPENAI_API_KEY=x, $env:ADMIN_TOKEN='x', token="x".
  text = text.replace(
    /((?:\$?env:)?)([A-Za-z_][A-Za-z0-9_-]{0,100})\s*=\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\])]+)/gi,
    redactAssignment
  );

  // JSON/object-like serialized assignments: "api_key":"x", 'token':'x'.
  text = text.replace(
    /(["']?)([A-Za-z_][A-Za-z0-9_-]{0,100})\1\s*:\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\])]+)/gi,
    redactColonAssignment
  );

  // Common CLI credential flags.
  text = text.replace(
    /((?:--?|\/)(?:api[-_]?key|token|secret|password|pass|authorization|auth|credential)(?:\s+|=))("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi,
    `$1${REDACTED_MASK}`
  );

  // Standalone Bearer values can also appear outside an Authorization field.
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{6,}={0,2}/gi, `Bearer ${REDACTED_MASK}`);

  // OpenAI-style keys that appear without a key name/context.
  text = text.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, `sk-${REDACTED_MASK}`);

  return text;
}

export function redactSensitiveValue(value: unknown, keyHint?: string): unknown {
  if (keyHint && isSecretKeyName(keyHint)) {
    if (value === null || value === undefined || value === "") return value;
    return REDACTED_MASK;
  }
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactSensitiveValue(nested, key);
    }
    return out;
  }
  return value;
}
