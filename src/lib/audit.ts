import fs from "fs/promises";
import path from "path";
import { appendActivity, summarizeToolArgs } from "./activity-log.js";
import { redactSensitiveText, redactSensitiveValue } from "./redaction.js";
import { envBoundedInteger } from "./env-utils.js";
import { atomicWriteFile } from "./atomic-write.js";
import { readUtf8FileTail } from "./bounded-file.js";

export type AuditStatus = "ok" | "error" | "blocked" | "dry-run";

export interface AuditEvent {
  tool: string;
  action: string;
  target?: string;
  status?: AuditStatus;
  details?: Record<string, unknown>;
}

function resolveAuditPath(): string {
  const configured = process.env.AUDIT_LOG_PATH?.trim();
  if (!configured) return path.resolve(process.cwd(), ".mcp-audit.log");
  if (path.isAbsolute(configured)) return path.normalize(configured);
  // Managed instances are spawned with cwd=repo root, so resolving a relative
  // AUDIT_LOG_PATH against cwd would mix every instance into one shared file.
  // MCP_ENV_FILE is injected by manager and gives each instance a stable base.
  const envFile = process.env.MCP_ENV_FILE?.trim();
  const base = envFile ? path.dirname(path.resolve(envFile)) : process.cwd();
  return path.resolve(base, configured);
}

const auditPath = resolveAuditPath();
const auditMaxBytes = envBoundedInteger("AUDIT_LOG_MAX_BYTES", 10 * 1024 * 1024, 1_024, 1_073_741_824);
const auditHistoryScrubMaxBytes = Math.min(auditMaxBytes, 10 * 1024 * 1024);
let auditWriteChain: Promise<void> = Promise.resolve();
let auditHistoryPrepared = false;
let auditWriterPrepared = false;
let auditCurrentBytes = 0;

async function scrubHistoricalAuditFile(file: string): Promise<void> {
  const tail = await readUtf8FileTail(file, auditHistoryScrubMaxBytes).catch((err: NodeJS.ErrnoException) => {
    if (err?.code === "ENOENT") return null;
    throw err;
  });
  if (tail === null || tail.sizeBytes === 0) return;

  let raw = tail.text;
  if (tail.truncated) {
    // A bounded tail can begin inside a JSONL record or secret value. Drop the
    // partial first record so content whose identifying key is outside the read
    // window is never persisted as an orphan plaintext fragment.
    const firstNewline = raw.indexOf("\n");
    raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
  }
  const hadFinalNewline = raw.endsWith("\n");
  const lines = raw.split(/\r?\n/);
  if (hadFinalNewline && lines.at(-1) === "") lines.pop();
  const sanitized = lines.map((line) => {
    if (!line) return "";
    try {
      return JSON.stringify(redactSensitiveValue(JSON.parse(line)));
    } catch {
      return redactSensitiveText(line);
    }
  }).join("\n") + (hadFinalNewline ? "\n" : "");
  if (!tail.truncated && sanitized === raw) return;

  await atomicWriteFile(file, sanitized, "utf8");
}

async function prepareHistoricalAuditLogs(): Promise<void> {
  if (auditHistoryPrepared) return;
  for (const file of [auditPath, `${auditPath}.1`]) {
    await scrubHistoricalAuditFile(file);
  }
  auditHistoryPrepared = true;
}

async function rotateAuditFile(): Promise<void> {
  await fs.rm(`${auditPath}.1`, { force: true }).catch(() => undefined);
  await fs.rename(auditPath, `${auditPath}.1`).catch(() => undefined);
  // Preserve the previous best-effort rotation contract: a transient Windows
  // rename failure must not make auditing block the actual tool call. Resync to
  // whichever active file remains, then the append below can still proceed.
  auditCurrentBytes = (await fs.stat(auditPath).catch(() => null))?.size ?? 0;
}

async function prepareAuditWriter(): Promise<void> {
  if (auditWriterPrepared) return;
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  const stat = await fs.stat(auditPath).catch(() => null);
  if (stat && stat.size > auditMaxBytes) {
    auditCurrentBytes = stat.size;
    await rotateAuditFile();
  }
  // Rotate first so an oversized historical generation is scrubbed in its final
  // `.1` location before this process performs its first append.
  await prepareHistoricalAuditLogs();
  auditCurrentBytes = (await fs.stat(auditPath).catch(() => null))?.size ?? 0;
  auditWriterPrepared = true;
}

async function appendAuditRecord(record: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify(record) + "\n";
  const lineBytes = Buffer.byteLength(line, "utf8");

  for (let attempt = 0; attempt < 2; attempt++) {
    await prepareAuditWriter();
    if (auditCurrentBytes > auditMaxBytes) await rotateAuditFile();
    try {
      await fs.appendFile(auditPath, line, "utf-8");
      auditCurrentBytes += lineBytes;
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (attempt === 0 && (code === "ENOENT" || code === "ENOTDIR")) {
        // Preserve the old self-healing behavior if the instance/log directory is
        // removed while the process is running. Recreate and resync exactly once.
        auditWriterPrepared = false;
        auditCurrentBytes = 0;
        continue;
      }
      throw err;
    }
  }
}

export async function audit(event: AuditEvent): Promise<void> {
  const safeEvent = redactSensitiveValue(event) as AuditEvent;
  const record = {
    time: new Date().toISOString(),
    pid: process.pid,
    ...safeEvent,
  };

  // Tool calls from multiple MCP sessions can finish concurrently. Serialize the
  // stat/rotate/append critical section so two writers cannot race log rotation.
  const write = auditWriteChain.then(() => appendAuditRecord(record));
  auditWriteChain = write.catch(() => undefined);
  await write.catch(() => undefined); // audit must never break the requested tool call

  try {
    const command =
      safeEvent.tool === "run_command" && typeof safeEvent.details?.command === "string"
        ? safeEvent.details.command
        : undefined;
    appendActivity({
      kind: "tool",
      tool: safeEvent.tool,
      action: safeEvent.action,
      target: safeEvent.target,
      status: safeEvent.status ?? "ok",
      summary: command
        ? summarizeToolArgs("run_command", { command })
        : safeEvent.target || (safeEvent.details ? JSON.stringify(safeEvent.details).slice(0, 120) : undefined),
      details: safeEvent.details,
    });
  } catch {}
}

export function getAuditPath(): string {
  return auditPath;
}
