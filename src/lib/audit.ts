import fs from "fs/promises";
import path from "path";
import { appendActivity } from "./activity-log.js";

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

export async function audit(event: AuditEvent): Promise<void> {
  const record = {
    time: new Date().toISOString(),
    pid: process.pid,
    ...event,
  };

  try {
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    const stat = await fs.stat(auditPath).catch(() => null);
    if (stat && stat.size > 10 * 1024 * 1024) {
      await fs.rename(auditPath, `${auditPath}.1`).catch(() => undefined);
    }
    await fs.appendFile(auditPath, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // Audit must never break the requested tool call.
  }

  try {
    appendActivity({
      kind: "tool",
      tool: event.tool,
      action: event.action,
      target: event.target,
      status: event.status ?? "ok",
      summary: event.target || (event.details ? JSON.stringify(event.details).slice(0, 120) : undefined),
      details: event.details,
    });
  } catch {}
}

export function getAuditPath(): string {
  return auditPath;
}
