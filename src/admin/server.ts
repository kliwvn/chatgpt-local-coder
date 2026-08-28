import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import type { Server } from "http";
import type { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";
import type { McpSessionSummary, SessionCounts } from "../lib/mcp-session-manager.js";
import { createAdminRouter } from "./routes.js";
import { adminAuth, localhostOnly } from "./localhost-guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AdminServerOptions {
  host?: string;
  port: number;
  mcpPort: number;
  pid: number;
  manager: McpUpstreamManager;
  sessionCount: () => number;
  sessionList?: () => McpSessionSummary[];
  sessionCounts?: () => SessionCounts;
  instructionSummary?: () => Record<string, unknown>;
  instructionsPreview?: () => string;
  lifecycleState?: () => Record<string, unknown>;
  beginMcpDrain?: () => Record<string, unknown>;
  resumeMcpAdmission?: () => Record<string, unknown>;
  requestShutdown?: () => void;
}

export function startAdminServer(options: AdminServerOptions): Server {
  const host = options.host ?? "127.0.0.1";
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(localhostOnly);

  const uiDir = path.resolve(__dirname, "../../public/ui");
  // The static localhost-only shell must remain loadable when ADMIN_TOKEN is
  // enabled; otherwise a normal browser cannot attach the token header and the
  // Admin UI locks itself out with 401 before its JavaScript can run.
  app.use("/ui", express.static(uiDir));
  app.get("/", (_req, res) => res.redirect("/ui/"));

  // Protect the operational API, not the static shell. The UI keeps the token
  // in sessionStorage and sends it as Authorization on API requests.
  app.use(adminAuth);

  app.use(createAdminRouter(options.manager, {
    mcpPort: options.mcpPort,
    pid: options.pid,
    sessionCount: options.sessionCount,
    sessionList: options.sessionList,
    sessionCounts: options.sessionCounts,
    instructionSummary: options.instructionSummary,
    instructionsPreview: options.instructionsPreview,
    lifecycleState: options.lifecycleState,
    beginMcpDrain: options.beginMcpDrain,
    resumeMcpAdmission: options.resumeMcpAdmission,
    requestShutdown: options.requestShutdown,
  }));

  return app.listen(options.port, host, () => {
    console.log(`  Admin UI:  http://${host}:${options.port}/ui`);
    console.log(`  Admin API: http://${host}:${options.port}/health`);
  });
}