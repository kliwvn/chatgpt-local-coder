export const REDACTED_MASK = "********";

export const SECRET_KEY_PATTERN =
  /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|AUTHORIZATION|CREDENTIAL|PRIVATE|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)(_|$)|API_KEY|MCP_API_KEY/i;

export function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key.replace(/^\$?env:/i, ""));
}

function redactAssignment(match: string, prefix: string, key: string, _value: string): string {
  return isSecretKeyName(key) ? `${prefix}${key}=${REDACTED_MASK}` : match;
}

function redactColonAssignment(match: string, quote: string, key: string, _value: string): string {
  return isSecretKeyName(key) ? `${quote}${key}${quote}:${REDACTED_MASK}` : match;
}

/**
 * Best-effort redaction for shell commands, headers, URLs and serialized blobs.
 * Structured objects are additionally handled by redactSensitiveValue().
 */
export function redactSensitiveText(input: string): string {
  let text = String(input);

  // Authorization must be handled before generic key:value masking; otherwise
  // "Authorization: Bearer <token>" could mask only the word Bearer and leave
  // the credential behind.
  text = text.replace(
    /((?:proxy-)?authorization\s*[:=]\s*)(?:bearer\s+)?("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi,
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

  // HTTP authorization values, including Bearer tokens.
  text = text.replace(
    /((?:proxy-)?authorization\s*[:=]\s*)(?:bearer\s+)?("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi,
    `$1${REDACTED_MASK}`
  );
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
