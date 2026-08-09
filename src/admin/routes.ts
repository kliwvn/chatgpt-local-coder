import fs from "fs/promises";
import path from "path";
import { Router, type Request, type Response } from "express";
import type { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";
import type { McpSessionSummary, SessionCounts } from "../lib/mcp-session-manager.js";
import {
  defaultUpstreamConfig,
  discoverMcpConfigs,
  findMcpConfigForSource,
  importMcpConfigFromFile,
  type McpImportSource,
  type UpstreamConfigFile,
  type UpstreamServerConfig,
} from "../lib/mcp-upstream-config.js";
import { getDefaultCwd, getFullDiskAccess } from "../lib/path-security.js";
import { getCheckpointConfig } from "../lib/checkpoint.js";
import {
  getRecentActivity,
  loadAuditHistory,
  subscribeActivity,
  type ActivityEntry,
} from "../lib/activity-log.js";

const SECRET_KEY_PATTERN =
  /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)(_|$)|API_KEY|MCP_API_KEY/i;
const REDACTED_MASK = "********";

const SESSION_POLICY_LIMITS: Record<string, [number, number]> = {
  MCP_SESSION_TTL_MS: [15_000, 86_400_000],
  MCP_SESSION_CLEANUP_MS: [1_000, 600_000],
  MCP_SESSION_DELETE_GRACE_MS: [1_000, 600_000],
  MCP_MAX_SESSIONS: [8, 4096],
};

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}
function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

function serializeDotEnv(values: Record<string, string>, original: string): string {
  const lines = original.split("\n");
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      result.push(line);
      continue;
    }
    const key = trimmed.split("=")[0].trim();
    if (key in values) {
      result.push(`${key}=${values[key]}`);
      seen.add(key);
    } else {
      result.push(line);
    }
  }

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) result.push(`${key}=${value}`);
  }

  return result.join("\n");
}

function validateAdminEnv(text: string): string | null {
  const parsed = parseDotEnv(text);
  for (const [key, [min, max]] of Object.entries(SESSION_POLICY_LIMITS)) {
    if (!(key in parsed) || parsed[key] === "") continue;
    const n = Number(parsed[key]);
    if (!Number.isInteger(n) || n < min || n > max) {
      return `${key} must be an integer between ${min} and ${max}`;
    }
  }
  const ttl = parsed.MCP_SESSION_TTL_MS ? Number(parsed.MCP_SESSION_TTL_MS) : null;
  const cleanup = parsed.MCP_SESSION_CLEANUP_MS ? Number(parsed.MCP_SESSION_CLEANUP_MS) : null;
  if (ttl && cleanup && cleanup > ttl) {
    return "MCP_SESSION_CLEANUP_MS must not exceed MCP_SESSION_TTL_MS";
  }
  return null;
}

export function createAdminRouter(manager: McpUpstreamManager, options: {
  mcpPort: number;
  pid: number;
  sessionCount: () => number;
  sessionList?: () => McpSessionSummary[];
  sessionCounts?: () => SessionCounts;
  instructionSummary?: () => Record<string, unknown>;
  instructionsPreview?: () => string;
  requestShutdown?: () => void;
}): Router {
  const router = Router();
  const envPath = path.resolve(process.env.MCP_ENV_FILE || path.join(process.cwd(), ".env"));
  // Header names that carry credentials even though they don't match
  // SECRET_KEY_PATTERN (e.g. "authorization" — the AUTH alternative requires
  // `_`/end so it won't match "Authorization").
  const SENSITIVE_HEADER_NAMES = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
  ]);

  function isSensitiveHeader(name: string): boolean {
    return SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) || isSecretKey(name);
  }

  // Mask secrets in an upstream config so the admin API never echoes
  // credentials. Values that are already the sentinel pass through unchanged
  // (they mean "keep the stored value").
  function maskUpstreamConfig(config: UpstreamConfigFile): UpstreamConfigFile {
    return {
      ...config,
      servers: config.servers.map((server) => {
        const masked: UpstreamServerConfig = { ...server };
        if (server.headers && typeof server.headers === "object") {
          masked.headers = Object.fromEntries(
            Object.entries(server.headers).map(([k, v]) => [
              k,
              isSensitiveHeader(k) && v ? REDACTED_MASK : v,
            ])
          );
        }
        if (server.env && typeof server.env === "object") {
          masked.env = Object.fromEntries(
            Object.entries(server.env).map(([k, v]) => [k, isSecretKey(k) && v ? REDACTED_MASK : v])
          );
        }
        return masked;
      }),
    };
  }

  // Before persisting a config that may contain sentinel values from the UI,
  // merge each server with its currently-stored headers/env so `********`
  // placeholders resolve to the real stored secrets.
  function restoreUpstreamSecrets(config: UpstreamConfigFile): UpstreamConfigFile {
    const stored = manager.getConfig();
    return {
      ...config,
      servers: config.servers.map((server) => {
        const prev = stored.servers.find((s) => s.id === server.id);
        if (!prev) return server;
        const restored: UpstreamServerConfig = { ...server };
        if (server.headers && prev.headers) {
          restored.headers = { ...server.headers };
          for (const k of Object.keys(restored.headers)) {
            if (restored.headers[k] === REDACTED_MASK && prev.headers[k] !== undefined) {
              restored.headers[k] = prev.headers[k];
            }
          }
        }
        if (server.env && prev.env) {
          restored.env = { ...server.env };
          for (const k of Object.keys(restored.env)) {
            if (restored.env[k] === REDACTED_MASK && prev.env[k] !== undefined) {
              restored.env[k] = prev.env[k];
            }
          }
        }
        return restored;
      }),
    };
  }
  // Single source for session counts so /health, /api/sessions and any future
  // route expose the same numbers under the same key names.
  const sessionCounts = (): { total: number; connected: number; policy: Record<string, number | null> } => {
    const counts = options.sessionCounts?.() ?? {
      registered: options.sessionCount(),
      connected: 0,
    };
    return {
      total: counts.registered,
      connected: counts.connected,
      policy: {
        max_retained: counts.maxRetained ?? null,
        idle_ttl_ms: counts.idleTtlMs ?? null,
        cleanup_interval_ms: counts.cleanupIntervalMs ?? null,
      },
    };
  };
  router.get("/health", async (_req: Request, res: Response) => {
    // Passive snapshot only. Admin UI polls /health; an active probe here would
    // reconnect/touch every upstream every few seconds and defeat idle_timeout.
    const upstream = await manager.listStatuses({ probe: false });
    const counts = sessionCounts();
    res.json({
      status: "ok",
      name: "codex-mcp-admin",
      pid: options.pid,
      active_sessions: counts.total,
      connected_sessions: counts.connected,
      session_policy: counts.policy,
      mcp_port: options.mcpPort,
      sessions: options.sessionList?.() ?? [],
      default_cwd: getDefaultCwd(),
      full_disk_access: getFullDiskAccess(),
      upstream,
      checkpoint: getCheckpointConfig(),
      instructions: options.instructionSummary?.() ?? null,
    });
  });

  // Danh sách phiên kết nối đang mở — chỉ shortId (không lộ session ID thật,
  // vì ID đó là credential replay được qua /mcp). Route này nằm sau
  // localhostOnly + adminAuth nên chỉ quản trị viên local xem được.
  router.get("/api/sessions", (_req: Request, res: Response) => {
    const counts = sessionCounts();
    res.json({
      ok: true,
      total: counts.total,
      connected: counts.connected,
      policy: counts.policy,
      sessions: options.sessionList?.() ?? [],
    });
  });


  router.post("/api/process/shutdown", (_req: Request, res: Response) => {
    if (!options.requestShutdown) {
      res.status(501).json({ ok: false, error: "Graceful shutdown is not configured" });
      return;
    }
    // Acknowledge first so the manager receives a complete response before the
    // admin listener and MCP/SSE transports are closed.
    res.status(202).json({ ok: true, shutting_down: true });
    setImmediate(() => options.requestShutdown?.());
  });
  router.get("/api/instructions/preview", (_req, res) => {
    const text = options.instructionsPreview?.() ?? "";
    const summary = options.instructionSummary?.() ?? {};
    res.json({
      ok: true,
      summary,
      preview: text.slice(0, 12000),
      truncated: text.length > 12000,
      total_chars: text.length,
    });
  });

  router.get("/api/config/env", async (_req, res) => {
    try {
      const text = await fs.readFile(envPath, "utf-8");
      const values = parseDotEnv(text);
      const masked: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        masked[key] = isSecretKey(key) && value ? REDACTED_MASK : value;
      }
      res.json({ ok: true, path: envPath, values: masked });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.json({ ok: true, path: envPath, values: {} });
        return;
      }
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.put("/api/config/env", async (req, res) => {
    try {
      const values = req.body?.values as Record<string, string>;
      if (!values || typeof values !== "object") {
        res.status(400).json({ ok: false, error: "values object required" });
        return;
      }
      // Loại bỏ giá trị mask trước khi serialize — nếu không sẽ ghi "********" đè secret thật
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        if (typeof v !== "string") {
          res.status(400).json({ ok: false, error: `Environment value for ${k} must be a string` });
          return;
        }
        if (v !== REDACTED_MASK) filtered[k] = v;
      }
      let original = "";
      try {
        original = await fs.readFile(envPath, "utf-8");
      } catch {}
      const next = serializeDotEnv(filtered, original || "");
      const validationError = validateAdminEnv(next);
      if (validationError) {
        res.status(400).json({ ok: false, error: validationError });
        return;
      }
      const tmpPath = `${envPath}.tmp-${process.pid}`;
      await fs.writeFile(tmpPath, next, "utf-8");
      try {
        await fs.rename(tmpPath, envPath);
      } catch {
        await fs.rm(envPath, { force: true });
        await fs.rename(tmpPath, envPath);
      }
      // Do not mutate process.env here: session/workspace/tool-profile config is
      // captured at startup while a few security helpers read env dynamically.
      // Partial live application would create a mixed old/new runtime. Persist
      // atomically and require one clean restart for all settings.
      res.json({ ok: true, path: envPath, restart_required: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
  router.get("/api/upstream", async (_req, res) => {
    res.json({ ok: true, config: maskUpstreamConfig(manager.getConfig()), path: manager.getConfigPath() });
  });

  router.put("/api/upstream", async (req, res) => {
    try {
      const config = restoreUpstreamSecrets(req.body?.config ?? defaultUpstreamConfig());
      const saved = await manager.updateConfig(config);
      res.json({ ok: true, config: maskUpstreamConfig(saved) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/upstream", async (req, res) => {
    try {
      const server = restoreUpstreamSecrets({
        version: 1,
        servers: [req.body?.server as UpstreamServerConfig],
      }).servers[0] as UpstreamServerConfig;
      if (!server?.id) {
        res.status(400).json({ ok: false, error: "server.id required" });
        return;
      }
      await manager.upsertServer(server);
      res.json({ ok: true, config: maskUpstreamConfig(manager.getConfig()) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/api/upstream/:id", async (req, res) => {
    const removed = await manager.removeServer(req.params.id);
    if (!removed) {
      res.status(404).json({ ok: false, error: "not found" });
      return;
    }
    res.json({ ok: true, config: maskUpstreamConfig(manager.getConfig()) });
  });

  router.post("/api/upstream/:id/test", async (req, res) => {
    try {
      const status = await manager.checkHealth(req.params.id);
      res.json({ ok: status.health === "connected", status });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/upstream/:id/tools", async (req, res) => {
    try {
      const tools = await manager.listTools(req.params.id);
      const config = manager.getServerConfig(req.params.id);
      res.json({
        ok: true,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        proxied_tools: config ? manager.getProxiedToolNames(config, tools) : [],
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/import/sources", async (_req, res) => {
    try {
      const sources = await discoverMcpConfigs();
      res.json({ ok: true, sources });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  async function handleImport(
    source: McpImportSource,
    body: { path?: string; merge?: boolean; enable?: boolean }
  ) {
    const configPath = body.path || (await findMcpConfigForSource(source));
    if (!configPath) throw new Error(`${source} MCP config not found on this machine`);
    return importMcpConfigFromFile(configPath, source, {
      merge: body.merge !== false,
      enableImported: Boolean(body.enable),
    });
  }

  router.post("/api/import/:source", async (req, res) => {
    try {
      const source = req.params.source as McpImportSource;
      if (!["cursor", "claude", "opencode", "file"].includes(source)) {
        res.status(400).json({ ok: false, error: "Unknown import source" });
        return;
      }
      const filePath = req.body?.path as string | undefined;
      if (source === "file" && !filePath) {
        res.status(400).json({ ok: false, error: "path required for file import" });
        return;
      }
      const detectSource: McpImportSource =
        source === "file" ? (req.body?.detect_as as McpImportSource) || "cursor" : source;
      const result = await importMcpConfigFromFile(filePath || (await findMcpConfigForSource(source))!, detectSource, {
        merge: req.body?.merge !== false,
        enableImported: Boolean(req.body?.enable),
      });
      await manager.reloadConfig();
      res.json({ ok: true, ...result, config: maskUpstreamConfig(result.config) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/import/cursor", async (req, res) => {
    try {
      const result = await handleImport("cursor", req.body ?? {});
      await manager.reloadConfig();
      res.json({ ok: true, ...result, config: maskUpstreamConfig(result.config) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  function filterActivity(
    entries: ActivityEntry[],
    opts: { kind?: string; status?: string; tool?: string; q?: string }
  ): ActivityEntry[] {
    let out = entries;
    if (opts.kind && opts.kind !== "all") {
      out = out.filter((e) => e.kind === opts.kind);
    }
    if (opts.status === "error") {
      out = out.filter((e) => e.status === "error" || e.status === "blocked");
    }
    if (opts.tool) {
      const needle = opts.tool.toLowerCase();
      out = out.filter((e) => e.tool?.toLowerCase().includes(needle));
    }
    if (opts.q) {
      const needle = opts.q.toLowerCase();
      out = out.filter((e) => {
        const hay = [e.tool, e.action, e.target, e.summary, e.client, e.session_id]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      });
    }
    return out;
  }

  function redactActivitySession(entry: ActivityEntry): ActivityEntry {
    if (!entry.session_id) return entry;
    return {
      ...entry,
      // MCP session IDs are bearer-like replay credentials. Keep only enough
      // characters for operator correlation; never expose the raw ID through
      // admin JSON/SSE even though the admin server itself is localhost-only.
      session_id: `${entry.session_id.slice(0, 8)}…`,
    };
  }
  // The in-memory/audit entries can embed raw tool-call arguments (file
  // contents, shell commands) — including in `summary` for tools/call and
  // audit-origin tool entries. The admin API only needs a metadata shape, so
  // compose session-id redaction first, then strip summaries/details for tool
  // activity before anything leaves the process (JSON, history and SSE).
  function sanitizeActivityEntry(entry: ActivityEntry): ActivityEntry {
    const wire = redactActivitySession(entry);
    const { details, summary, ...rest } = wire;
    if (wire.kind === "tool" || wire.action === "tools/call" || wire.tool) {
      const safeDetails: Record<string, unknown> = {};
      if (details && typeof details === "object") {
        if (details.http_status !== undefined) safeDetails.http_status = details.http_status;
        if (details.exit_code !== undefined) safeDetails.exit_code = details.exit_code;
      }
      return {
        ...rest,
        summary: undefined,
        ...(Object.keys(safeDetails).length ? { details: { ...safeDetails, redacted: true } } : { details: { redacted: true } }),
      };
    }
    return {
      ...rest,
      summary: summary ? String(summary).slice(0, 200) : undefined,
      ...(details && typeof details === "object" && Object.keys(details).length ? { details } : {}),
    };
  }




  router.get("/api/activity", (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const entries = filterActivity(getRecentActivity(limit, since), {
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      tool: typeof req.query.tool === "string" ? req.query.tool : undefined,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
    });
    res.json({ ok: true, entries: entries.map(sanitizeActivityEntry), count: entries.length });
  });

  router.get("/api/activity/history", async (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit || "80"), 10) || 80, 500);
      const entries = await loadAuditHistory(limit);
      res.json({ ok: true, entries: entries.map(sanitizeActivityEntry), source: "audit_file" });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/activity/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (entry: ActivityEntry) => {
      res.write(`data: ${JSON.stringify(sanitizeActivityEntry(entry))}\n\n`);
    };

    for (const entry of getRecentActivity(30).reverse()) send(entry);

    const unsub = subscribeActivity(send);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);

    req.on("close", () => {
      unsub();
      clearInterval(ping);
    });
  });

  return router;
}