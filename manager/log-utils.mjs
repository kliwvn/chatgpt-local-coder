import fs from "node:fs/promises";
import { atomicWriteFile, enqueueKeyedMutation } from "./fs-utils.mjs";

export const DEFAULT_MANAGED_LOG_MAX_BYTES = 10 * 1024 * 1024;
const REDACTED_MASK = "********";
const DEFAULT_LIVE_BACKUP_MAX_BYTES = 1024 * 1024;
const DEFAULT_HISTORICAL_SCRUB_MAX_BYTES = 1024 * 1024;
const liveRotationChains = new Map();
let liveRotationSeq = 0;
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
  const unquotedValue = value.replace(/^["']|["']$/g, "");
  // Keep syntax stable when an earlier pass already masked the value. Without
  // this guard, the generic key:value pass can consume a trailing shell quote.
  if (unquotedValue === REDACTED_MASK) return match;
  // Preserve the source value's quote style. JSON string fields stay valid,
  // while shell/log object-like text keeps its original unquoted shape.
  const valueQuote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
  return `${quote}${key}${quote}:${valueQuote}${REDACTED_MASK}${valueQuote}`;
}

/** Sanitize process-log text before it crosses the Manager API boundary. */
export function redactSensitiveLogText(input) {
  let text = String(input ?? "");

  text = text.replace(/\b(https?:\/\/)([^\s\/@:]+):([^\s\/@]+)@/gi, `$1${REDACTED_MASK}:${REDACTED_MASK}@`);

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
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{6,}={0,2}/gi, `Bearer ${REDACTED_MASK}`);
  text = text.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, `sk-${REDACTED_MASK}`);
  return text;
}

async function readTailStrict(file, maxBytes, knownStat = null) {
  const st = knownStat || await fs.stat(file);
  if (!st.isFile()) throw new Error("Path is not a regular file");
  const size = Math.min(st.size, Math.max(0, maxBytes));
  if (size <= 0) return "";
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, st.size - size);
    let start = 0;
    while (start < bytesRead && (buf[start] & 0xc0) === 0x80) start++;
    return buf.subarray(start, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/**
 * Rewrite a stopped managed process log with secrets redacted at rest.
 * Historical process logs are diagnostic-only and Manager can surface at most
 * 1 MiB, so cap migration to the newest tail instead of loading an arbitrarily
 * large legacy file into memory. A partial first line is discarded when capped.
 */
export async function scrubLogFile(file, maxBytes = DEFAULT_HISTORICAL_SCRUB_MAX_BYTES) {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) throw new Error("Path is not a regular file");
    const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_HISTORICAL_SCRUB_MAX_BYTES;
    const truncated = st.size > limit;
    let raw = truncated ? await readTailStrict(file, limit, st) : await fs.readFile(file, "utf8");
    if (truncated) {
      const firstNewline = raw.indexOf("\n");
      raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
    }
    const sanitized = redactSensitiveLogText(raw);
    if (!truncated && sanitized === raw) return false;
    await atomicWriteFile(file, sanitized, "utf8");
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

/** Read the tail without emitting U+FFFD when the byte window starts mid-codepoint. */
export async function tailFile(file, maxBytes = 8000) {
  try {
    return await readTailStrict(file, maxBytes);
  } catch {
    return "";
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

/**
 * Bound a log while a detached child still owns its append-mode stdout/stderr
 * descriptor. A rename rotation is unsafe in that state on Windows, but a
 * copy-truncate keeps the existing descriptor attached to the active path.
 *
 * The backup is redacted before the active file is truncated, so a failed
 * backup write never destroys the only copy of the log and no plaintext temp
 * backup is persisted. As with standard copytruncate, console lines appended
 * between the snapshot read and truncate can be lost; server/tunnel logs are
 * operational diagnostics, while the canonical MCP audit has its own bounded
 * serialized writer.
 */
export function copyTruncateLogFile(file, maxBytes = DEFAULT_MANAGED_LOG_MAX_BYTES, backups = 2, backupMaxBytes = DEFAULT_LIVE_BACKUP_MAX_BYTES) {
  const key = String(file);
  const threshold = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MANAGED_LOG_MAX_BYTES;
  const requestedBackup = Number.isSafeInteger(backupMaxBytes) && backupMaxBytes > 0 ? backupMaxBytes : DEFAULT_LIVE_BACKUP_MAX_BYTES;
  const backupLimit = Math.min(threshold, requestedBackup);
  return enqueueKeyedMutation(liveRotationChains, key, async () => {
    let st;
    try {
      st = await fs.stat(file);
    } catch (err) {
      if (err?.code === "ENOENT") return false;
      throw err;
    }
    if (st.size <= threshold) return false;

    // Retain only the diagnostic tail the Manager can actually surface. This
    // bounds both memory and synchronous redaction CPU even if a process log
    // grows far beyond its truncate threshold between maintenance sweeps.
    let raw = await tailFile(file, backupLimit);
    if (st.size > backupLimit) {
      // tailFile can begin in the middle of a text line. Drop that partial line
      // so a secret value whose key was outside the window cannot be persisted
      // into the redacted backup without its identifying key.
      const firstNewline = raw.indexOf("\n");
      raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
    }
    const sanitized = redactSensitiveLogText(raw);
    const keep = Math.max(1, Math.floor(backups));
    const temp = `${file}.rotate-${process.pid}-${Date.now()}-${++liveRotationSeq}`;

    try {
      // Materialize a redacted backup first. If anything fails before truncate,
      // the active log remains untouched and the next maintenance sweep retries.
      await atomicWriteFile(temp, sanitized, "utf8");
      await fs.rm(`${file}.${keep}`, { force: true });
      for (let i = keep - 1; i >= 1; i--) {
        const prior = `${file}.${i}`;
        const priorStat = await fs.stat(prior).catch((err) => {
          if (err?.code === "ENOENT") return null;
          throw err;
        });
        if (!priorStat) continue;
        if (priorStat.size > backupLimit) {
          // Bound migration cost for legacy backups that predate at-rest
          // redaction. Dropping an oversized diagnostic generation is safer
          // than retaining plaintext or blocking the Manager for many seconds.
          await fs.rm(prior, { force: true });
          continue;
        }
        await scrubLogFile(prior);
        await fs.rename(prior, `${file}.${i + 1}`);
      }
      await fs.rename(temp, `${file}.1`);
      await fs.truncate(file, 0);
      return true;
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  });
}
