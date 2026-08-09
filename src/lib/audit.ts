import fs from "fs/promises";
import path from "path";
import { appendActivity } from "./activity-log.js";
import { redactSensitiveValue } from "./redaction.js";
import { envBoundedInteger } from "./env-utils.js";

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
let auditWriteChain: Promise<void> = Promise.resolve();

async function appendAuditRecord(record: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  const stat = await fs.stat(auditPath).catch(() => null);
  if (stat && stat.size > auditMaxBytes) {
    await fs.rm(`${auditPath}.1`, { force: true }).catch(() => undefined);
    await fs.rename(auditPath, `${auditPath}.1`).catch(() => undefined);
  }
  await fs.appendFile(auditPath, JSON.stringify(record) + "\n", "utf-8");
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
    appendActivity({
      kind: "tool",
      tool: safeEvent.tool,
      action: safeEvent.action,
      target: safeEvent.target,
      status: safeEvent.status ?? "ok",
      summary: safeEvent.target || (safeEvent.details ? JSON.stringify(safeEvent.details).slice(0, 120) : undefined),
      details: safeEvent.details,
    });
  } catch {}
}

export function getAuditPath(): string {
  return auditPath;
}
