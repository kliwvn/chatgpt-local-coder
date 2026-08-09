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
  requestShutdown?: () => void;
}

export function startAdminServer(options: AdminServerOptions): Server {
  const host = options.host ?? "127.0.0.1";
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(localhostOnly);
  app.use(adminAuth);

  const uiDir = path.resolve(__dirname, "../../public/ui");
  app.use("/ui", express.static(uiDir));
  app.get("/", (_req, res) => res.redirect("/ui/"));

  app.use(createAdminRouter(options.manager, {
    mcpPort: options.mcpPort,
    pid: options.pid,
    sessionCount: options.sessionCount,
    sessionList: options.sessionList,
    sessionCounts: options.sessionCounts,
    instructionSummary: options.instructionSummary,
    instructionsPreview: options.instructionsPreview,
    requestShutdown: options.requestShutdown,
  }));

  return app.listen(options.port, host, () => {
    console.log(`  Admin UI:  http://${host}:${options.port}/ui`);
    console.log(`  Admin API: http://${host}:${options.port}/health`);
  });
}