#!/usr/bin/env node

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";

import {
  setDefaultCwd,
  getDefaultCwd,
  getFullDiskAccess,
} from "./lib/path-security.js";
import {
  consumeSessionTransportError,
  createSessionManager,
  extractRequestId,
  isInitializeRequest,
} from "./lib/mcp-session-manager.js";
import { initUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { startAdminServer } from "./admin/server.js";
import { formatLogTime, logMcpHttpEvent, logMcpRequest } from "./lib/activity-log.js";
import {
  buildInstructionContext,
  summarizeInstructionContext,
  type InstructionContext,
} from "./lib/instruction-context.js";
import { getChatGptToolProfile } from "./lib/tool-profile.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || "3001", 10);
const SHELL_TIMEOUT = parseInt(process.env.SHELL_TIMEOUT || "120", 10);
const SESSION_RECOVERY =
  (process.env.MCP_SESSION_RECOVERY || "true").toLowerCase() !== "false";

function splitWorkspaceEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(";")
    .map((p) => p.trim().replace(/^['\"]|['\"]$/g, ""))
    .filter(Boolean);
}

function resolveWorkspaceRoots(): string[] {
  const configuredRoots = [
    ...splitWorkspaceEnv(process.env.WORKSPACE_PATH || process.cwd()),
    ...splitWorkspaceEnv(process.env.EXTRA_WORKSPACE_PATHS),
    ...splitWorkspaceEnv(process.env.WORKSPACE_PATHS),
    ...splitWorkspaceEnv(process.env.ALLOWED_WORKSPACE_PATHS),
  ];

  const roots = configuredRoots.map((p) => path.resolve(p));
  return [...new Set(roots)];
}

const workspaceRoots = resolveWorkspaceRoots();
const workspaceRoot = workspaceRoots[0] || process.cwd();
setDefaultCwd(workspaceRoot);

const upstreamManager = await initUpstreamManager();

const instructionContext: InstructionContext = await buildInstructionContext({
  workspaceRoot,
  workspaceRoots,
  pid: process.pid,
  adminPort: ADMIN_PORT,
});

if (instructionContext.projectMemory.sections.length > 0) {
  console.log(
    `${formatLogTime()} [MCP] Project memory: ${instructionContext.projectMemory.sections.length} file(s) from ${workspaceRoot} (${instructionContext.projectMemory.total_bytes} bytes)`
  );
} else {
  console.log(
    `${formatLogTime()} [MCP] Project memory: no CLAUDE.md/AGENTS.md at ${workspaceRoot} — set WORKSPACE_PATH to your project root`
  );
}
if (instructionContext.git.is_repo) {
  console.log(`${formatLogTime()} [MCP] Git: branch ${instructionContext.git.branch}`);
}
console.log(
  `${formatLogTime()} [MCP] MCP instructions: ${Math.round(instructionContext.instructionBytes / 1024)}KB (agent prompt + env + git + memory)`
);
console.log(`${formatLogTime()} [MCP] Tool profile: ${getChatGptToolProfile()} (CHATGPT_TOOL_PROFILE)`);

const sessionManager = createSessionManager({
  workspaceRoot,
  shellTimeout: SHELL_TIMEOUT,
  workspaceRoots,
  port: PORT,
  projectMemoryInstructions: instructionContext.instructionsText,
});

const app = express();
// CORS hẹp: chỉ cho phép origin local (localhost/127.0.0.1) — chặn trang web độc hại
// gọi /mcp từ trình duyệt nạn nhân (tool run_command = toàn quyền shell).
app.use(
  cors({
    origin: [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/],
  })
);
app.use(express.json({ limit: "50mb" }));
// Error middleware: body-parser lỗi (JSON sai, body quá lớn) → trả JSON-RPC error
// thay vì HTML mặc định của Express (phá shape JSON-RPC mà MCP client đang chờ).
app.use(
  (
    err: Error & { status?: number; type?: string },
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const isParseError =
      err.type === "entity.parse.failed" ||
      err.type === "entity.too.large" ||
      err instanceof SyntaxError;
    const code = isParseError ? -32700 : -32000;
    const message = err.type === "entity.too.large" ? "Request body too large" : err.message;
    const status = isParseError ? 400 : 500;
    const body = req.body as { id?: unknown } | undefined;
    res.status(status).json({
      jsonrpc: "2.0",
      error: { code, message },
      id: body && typeof body.id !== "undefined" ? body.id : null,
    });
  }
);
const MCP_PATHS_SET = new Set(["/", "/mcp"]);

app.use((req, res, next) => {
  const started = Date.now();
  const isMcpRoute = MCP_PATHS_SET.has(req.path);
  res.on("finish", () => {
    const duration = Date.now() - started;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const sessionInfo = sessionId ? ` session=${String(sessionId).slice(0, 8)}...` : "";

    if (req.method === "POST" && isMcpRoute) {
      const transportError =
        consumeSessionTransportError(sessionId) ||
        (typeof res.locals.mcpError === "string" ? res.locals.mcpError : undefined);
      logMcpRequest(req.body, sessionId, duration, res.statusCode, transportError);
      return;
    }

    if (isMcpRoute && res.statusCode >= 400) {
      const reason =
        (typeof res.locals.mcpError === "string" ? res.locals.mcpError : undefined) ||
        (res.statusCode === 404
          ? "Session not found"
          : res.statusCode === 400
            ? "Bad Request (missing Mcp-Session-Id or invalid state)"
            : `HTTP ${res.statusCode}`);
      logMcpHttpEvent({
        method: req.method,
        path: req.path,
        httpStatus: res.statusCode,
        durationMs: duration,
        sessionId,
        errorMessage: reason,
      });
      return;
    }

    if (!isMcpRoute) {
      console.log(`${formatLogTime()} [HTTP] ${req.method} ${req.path} ${res.statusCode} ${duration}ms${sessionInfo}`);
    }
  });
  next();
});

// ChatGPT co the goi "/" hoac "/mcp" — ho tro ca hai
const MCP_PATHS = ["/", "/mcp"];

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    name: "codex-mcp-server",
    workspace: workspaceRoot,
    defaultCwd: getDefaultCwd(),
    fullMachineAccess: true,
    fullDiskAccess: getFullDiskAccess(),
    activeSessions: sessionManager.count(),
    sessionRecovery: SESSION_RECOVERY,
    mcpEndpoints: MCP_PATHS,
    instructions: summarizeInstructionContext(instructionContext),
  });
});

// OAuth protected-resource metadata (RFC 9728) — tunnel-client dùng cho OAuth
// discovery khi kết nối MCP qua OpenAI Secure MCP Tunnel. authorization_servers
// rỗng = server local không yêu cầu OAuth.
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: `http://127.0.0.1:${PORT}/mcp`,
    authorization_servers: [],
  });
});
app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
  res.json({
    resource: `http://127.0.0.1:${PORT}/mcp`,
    authorization_servers: [],
  });
});

async function handleMcpPost(req: express.Request, res: express.Response): Promise<void> {
  try {
    // SEP-2575: server/discover (stateless discovery) — trả JSON-RPC error 200
    // để SDK client fallback về initialize ngay (tránh HTTP 400 → retry → tunnel-client probe timeout)
    const rpcBody = req.body as { method?: unknown; id?: unknown } | undefined;
    if (rpcBody && typeof rpcBody === "object" && rpcBody.method === "server/discover") {
      res.status(200).json({
        jsonrpc: "2.0",
        error: { code: -32601, message: "Method not found: server/discover" },
        id: rpcBody.id ?? null,
      });
      return;
    }
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const requestId = extractRequestId(req.body);

    const existing = sessionId ? sessionManager.get(sessionId) : undefined;
    if (existing) {
      await sessionManager.handleExisting(existing, req, res, req.body);
      return;
    }

    if (isInitializeRequest(req.body)) {
      if (sessionId) {
        console.log(`${formatLogTime()} [MCP] Re-initialize with stale session header: ${sessionId}`);
      }
      await sessionManager.createNew(req, res, req.body);
      return;
    }

    if (sessionId) {
      if (SESSION_RECOVERY) {
        const recovered = await sessionManager.tryRecoverStale(
          sessionId,
          req,
          res,
          req.body
        );
        if (recovered) return;
      }
      sessionManager.sendSessionNotFound(res, requestId);
      return;
    }

    sessionManager.sendBadRequest(
      res,
      "Bad Request: Mcp-Session-Id header is required",
      requestId
    );
  } catch (error) {
    console.log(`${formatLogTime()} [MCP] Error:`, error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: extractRequestId(req.body),
      });
    }
  }
}

function handleStaleSession(
  req: express.Request,
  res: express.Response,
  sessionId: string | undefined
): boolean {
  if (!sessionId || sessionManager.get(sessionId)) {
    return false;
  }
  sessionManager.sendSessionNotFound(res);
  return true;
}

async function handleMcpGet(req: express.Request, res: express.Response): Promise<void> {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (handleStaleSession(req, res, sessionId)) return;

    if (!sessionId) {
      sessionManager.sendBadRequest(res, "Bad Request: Mcp-Session-Id header is required");
      return;
    }

    const session = sessionManager.get(sessionId);
    if (!session) {
      sessionManager.sendSessionNotFound(res);
      return;
    }

    await sessionManager.handleExisting(session, req, res, undefined);
  } catch (error) {
    console.log(`${formatLogTime()} [MCP] GET error:`, error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: extractRequestId(req.body),
      });
    }
  }
}

async function handleMcpDelete(req: express.Request, res: express.Response): Promise<void> {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (handleStaleSession(req, res, sessionId)) return;

    if (!sessionId) {
      sessionManager.sendBadRequest(res, "Bad Request: Mcp-Session-Id header is required");
      return;
    }

    const session = sessionManager.get(sessionId);
    if (!session) {
      sessionManager.sendSessionNotFound(res);
      return;
    }

    await sessionManager.handleExisting(session, req, res, undefined);
  } catch (error) {
    console.log(`${formatLogTime()} [MCP] DELETE error:`, error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: extractRequestId(req.body),
      });
    }
  }
}

for (const mcpPath of MCP_PATHS) {
  app.post(mcpPath, handleMcpPost);
  app.get(mcpPath, handleMcpGet);
  app.delete(mcpPath, handleMcpDelete);
}

sessionManager.startCleanup();

const adminServer = startAdminServer({
  port: ADMIN_PORT,
  host: "127.0.0.1",
  mcpPort: PORT,
  pid: process.pid,
  manager: upstreamManager,
  sessionCount: () => sessionManager.count(),
  instructionSummary: () => summarizeInstructionContext(instructionContext),
  instructionsPreview: () => instructionContext.instructionsText,
});

const server = app.listen(PORT, "127.0.0.1", () => {
  const ts = formatLogTime();
  console.log("");
  console.log("========================================");
  console.log("  Codex MCP Server");
  console.log("========================================");
  console.log(`  ${ts} Local:     http://localhost:${PORT}`);
  console.log(`  ${ts} MCP:       http://localhost:${PORT}/`);
  console.log(`  ${ts} MCP alt:   http://localhost:${PORT}/mcp`);
  console.log(`  ${ts} Health:    http://localhost:${PORT}/health`);
  console.log(`  ${ts} Admin UI:  http://127.0.0.1:${ADMIN_PORT}/ui`);
  console.log(`  ${ts} Default cwd: ${workspaceRoot}`);
  console.log(`  ${ts} Full machine access: ON (no path restrictions)`);
  console.log(`  ${ts} Session recovery: ${SESSION_RECOVERY ? "ON" : "OFF"}`);
  console.log(`  ${ts} PID:       ${process.pid}`);
  console.log("========================================");
  console.log("  Dang chay... (Ctrl+C de dung)");
  console.log("========================================");
  console.log("");
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n[LOI] Port ${PORT} da co server khac dang chay!`);
    console.error("Chay lenh sau de tim process:");
    console.error(`  netstat -ano | findstr ":${PORT}"`);
    console.error("Hoac dung: .\\stop.bat de tat server cu\n");
  } else {
    console.error("\n[LOI] Khong the khoi dong server:", err.message, "\n");
  }
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\n[DUNG] Server dang tat...");
  sessionManager.stopCleanup();
  void upstreamManager.shutdown();
  adminServer.close();
  server.close(() => process.exit(0));
});

// Tranh process tu tat khi stdin dong (Windows + .bat)
if (process.stdin.isTTY) {
  process.stdin.resume();
}