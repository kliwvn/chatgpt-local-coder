import fs from "node:fs/promises";
import { atomicWriteFile } from "./fs-utils.mjs";

export const DEFAULT_MANAGED_LOG_MAX_BYTES = 10 * 1024 * 1024;
const REDACTED_MASK = "********";
const SECRET_KEY_RE =
  /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|AUTHORIZATION|CREDENTIAL|PRIVATE|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)(_|$)|API_KEY|MCP_API_KEY/i;

export function isSecretKeyName(key) {
  const normalized = String(key).replace(/^\$?env:/i, "").replace(/[-.]/g, "_");
  return SECRET_KEY_RE.test(normalized);
}

function redactAssignment(match, prefix, key) {
  return isSecretKeyName(key) ? `${prefix}${key}=${REDACTED_MASK}` : match;
}

function redactColonAssignment(match, quote, key, value) {
  if (!isSecretKeyName(key)) return match;
  // Preserve the source value's quote style. JSON string fields stay valid,
  // while shell/log object-like text keeps its original unquoted shape.
  const valueQuote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
  return `${quote}${key}${quote}:${valueQuote}${REDACTED_MASK}${valueQuote}`;
}

/** Sanitize process-log text before it crosses the Manager API boundary. */
export function redactSensitiveLogText(input) {
  let text = String(input ?? "");

  text = text.replace(
    /(["'])((?:proxy-)?authorization\s*[:=]\s*)(?!\*{4,})[^"'\r\n]*\1/gi,
    `$1$2${REDACTED_MASK}$1`
  );
  text = text.replace(
    /((?:proxy-)?authorization\s*[:=])(?!(?:[ \t]*\*{4,}))[ \t]*(?:(?:basic|bearer|token)\s+[^\s,;&'\"]+|(?:digest|aws4-hmac-sha256)\s+[^;\r\n]+|[^\s,;&'\"]+)/gi,
    `$1${REDACTED_MASK}`
  );
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{6,}={0,2}/gi, `Bearer ${REDACTED_MASK}`);
  text = text.replace(
    /((?:\$?env:)?)([A-Za-z_][A-Za-z0-9_.-]{0,100})\s*=\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\])]+)/gi,
    redactAssignment
  );
  text = text.replace(
    /(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,100})\1\s*:\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\])]+)/gi,
    redactColonAssignment
  );
  text = text.replace(
    /((?:--?|\/)(?:api[-_]?key|token|secret|password|pass|authorization|auth|credential)(?:\s+|=))("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi,
    `$1${REDACTED_MASK}`
  );
  text = text.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, `sk-${REDACTED_MASK}`);
  return text;
}

/** Rewrite a stopped managed process log with secrets redacted at rest. */
export async function scrubLogFile(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const sanitized = redactSensitiveLogText(raw);
    if (sanitized === raw) return false;
    await atomicWriteFile(file, sanitized, "utf8");
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

/** Read the tail without emitting U+FFFD when the byte window starts mid-codepoint. */
export async function tailFile(file, maxBytes = 8000) {
  let fh = null;
  try {
    const st = await fs.stat(file);
    const size = Math.min(st.size, Math.max(0, maxBytes));
    if (size <= 0) return "";
    fh = await fs.open(file, "r");
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, st.size - size);
    let start = 0;
    while (start < bytesRead && (buf[start] & 0xc0) === 0x80) start++;
    return buf.subarray(start, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/**
 * Rotate a stopped managed process log before the next spawn. The child owns its
 * stdout file descriptor while running, so rotation is intentionally performed
 * only at the safe pre-start boundary.
 */
export async function rotateLogFile(file, maxBytes = DEFAULT_MANAGED_LOG_MAX_BYTES, backups = 2) {
  try {
    const st = await fs.stat(file);
    if (st.size <= maxBytes) return false;
    const keep = Math.max(1, Math.floor(backups));
    await fs.rm(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      await fs.rename(`${file}.${i}`, `${file}.${i + 1}`).catch((err) => {
        if (err?.code !== "ENOENT") throw err;
      });
    }
    await fs.rename(file, `${file}.1`);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    return false;
  }
}
