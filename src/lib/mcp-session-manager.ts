import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../server-factory.js";
import { getUpstreamManager } from "./mcp-upstream-manager.js";
import { formatLogTime } from "./activity-log.js";
import { getFullDiskAccess } from "./path-security.js";
import { envIntegerOrThrow } from "./env-utils.js";

const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

/** Capacity admission failed — all sessions busy (published + in-flight = MAX). */
export class SessionCapacityError extends Error {
  constructor() {
    super("MCP session capacity reached; all sessions are busy");
    this.name = "SessionCapacityError";
  }
}

function sessionLogId(sessionId: string): string {
  return `${sessionId.slice(0, 8)}…`;
}

// ChatGPT's connector currently creates short-lived MCP transport sessions very
// aggressively (often one initialize per tool call) and does not reliably send
// DELETE afterwards. A 24h retention policy therefore retained thousands of
// complete McpServer/tool registries. Two idle minutes is deliberately
// conservative for this POST-heavy connector: connected SSE and in-flight ops
// are exempt, and a later stale POST is transparently reconstructed by recovery.
const SESSION_TTL_MS = envIntegerOrThrow("MCP_SESSION_TTL_MS", 2 * 60 * 1000, 15_000, 86_400_000);
const SESSION_CLEANUP_INTERVAL_MS = envIntegerOrThrow("MCP_SESSION_CLEANUP_MS", 15 * 1000, 1_000, 600_000);
const SESSION_DELETE_GRACE_MS = envIntegerOrThrow("MCP_SESSION_DELETE_GRACE_MS", 45 * 1000, 1_000, 600_000);
const MAX_SESSION_COUNT = envIntegerOrThrow("MCP_MAX_SESSIONS", 64, 8, 4_096);
if (SESSION_CLEANUP_INTERVAL_MS > SESSION_TTL_MS) {
  throw new Error("MCP_SESSION_CLEANUP_MS must not exceed MCP_SESSION_TTL_MS");
}
// Internal shutdown safety bound. Keep this below the process-level graceful
// shutdown deadline so one wedged SDK transport cannot stall all sessions.
const SESSION_RESOURCE_CLOSE_TIMEOUT_MS = 2000;
const RECOVERY_LOOPBACK_TIMEOUT_MS = 5000;
const RECOVERY_LOOPBACK_RESPONSE_MAX_BYTES = 64 * 1024;

const lastTransportErrors: Record<string, string> = {};
const sessionOpChains = new Map<string, Promise<void>>();

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastAccessedAt: number;
  createdAt: number;
}

/** Summary of a live session — deliberately omits the raw session ID. */
export interface McpSessionSummary {
  index: number;
  shortId: string;
  /** registered = session tồn tại trong map (có thể có hoặc không có SSE mở);
   *  closing = transport close đang ở fallback grace; explicit DELETE normally
   *  drains its serialized op and disposes immediately. */
  status: "registered" | "closing";
  /** connected = có ít nhất 1 SSE GET stream đang mở trên session này (thực tế đang kết nối). */
  connected: boolean;
  ageSeconds: number;
  idleSeconds: number;
}

export interface SessionCounts {
  /** Tổng session giữ trong map (registered + closing). */
  registered: number;
  /** Số session có SSE stream đang mở — "đang kết nối thực tế". */
  connected: number;
  /** Retention policy surfaced for diagnostics/admin UI. */
  maxRetained?: number;
  idleTtlMs?: number;
  cleanupIntervalMs?: number;
}

export interface SessionManagerConfig {
  workspaceRoot: string;
  shellTimeout: number;
  workspaceRoots: string[];
  port: number;
  projectMemoryInstructions?: string;
  /** Test seam: override server construction (defaults to server-factory's
   *  createMcpServer). Lets tests inject a failing connect or a shutdown race. */
  createMcpServerOverride?: typeof createMcpServer;
}

export interface SessionManager {
  get(sessionId: string): McpSession | undefined;
  createNew(req: Request, res: Response, body: unknown): Promise<void>;
  handleExisting(
    session: McpSession,
    req: Request,
    res: Response,
    body?: unknown,
    bypassQueue?: boolean
  ): Promise<void>;
  touch(sessionId: string): void;
  list(): McpSessionSummary[];
  count(): number;
  counts(): SessionCounts;
  registerLiveConnection(sessionId: string): void;
  unregisterLiveConnection(sessionId: string): void;
  isSessionConnected(sessionId: string): boolean;
  isInDeleteGrace(sessionId: string): boolean;
  /** Atomically cancel the DELETE grace, detach and close a closing session. */
  disposeClosingSession(sessionId: string): Promise<void>;
  tryRecoverStale(
    staleSessionId: string,
    req: Request,
    res: Response,
    body: unknown
  ): Promise<boolean>;
  sendSessionNotFound(res: Response, requestId?: string | number | null): void;
  sendBadRequest(res: Response, message: string, requestId?: string | number | null): void;
  startCleanup(): void;
  stopCleanup(): void;
  shutdown(): Promise<void>;
}

const OPENAI_MCP_SESSION_LOG_SAMPLE_EVERY = 25;

export function shouldLogSessionInitializeForClient(name: string, clientInitializedTotal: number): boolean {
  return name !== "openai-mcp" || clientInitializedTotal % OPENAI_MCP_SESSION_LOG_SAMPLE_EVERY === 0;
}

function extractRequestId(body: unknown): string | number | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("id" in body)) return null;
  const id = (body as { id?: unknown }).id;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

export async function loopbackMcpPost(
  port: number,
  path: string,
  body: unknown,
  sessionId?: string,
  protocolVersion?: string,
  timeoutMs = RECOVERY_LOOPBACK_TIMEOUT_MS
): Promise<{ ok: boolean; status: number; sessionId?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result = {
      ok: response.ok,
      status: response.status,
      sessionId: response.headers.get("mcp-session-id") ?? undefined,
    };
    // Drain only a bounded amount. A wrong local process or an unexpectedly
    // streaming MCP response must not make recovery allocate/wait without bound.
    if (response.body) {
      let received = 0;
      for await (const chunk of response.body) {
        received += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        if (received > RECOVERY_LOOPBACK_RESPONSE_MAX_BYTES) {
          await response.body.cancel().catch(() => undefined);
          break;
        }
      }
    }
    return result;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`MCP recovery loopback timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function consumeSessionTransportError(sessionId?: string): string | undefined {
  if (!sessionId || !lastTransportErrors[sessionId]) return undefined;
  const message = lastTransportErrors[sessionId];
  delete lastTransportErrors[sessionId];
  return message;
}

async function enqueueSessionOp(sessionId: string, op: () => Promise<void>): Promise<void> {
  const prev = sessionOpChains.get(sessionId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(op);
  sessionOpChains.set(sessionId, run);
  try {
    await run;
  } finally {
    if (sessionOpChains.get(sessionId) === run) {
      sessionOpChains.delete(sessionId);
    }
  }
}

export function createSessionManager(config: SessionManagerConfig): SessionManager {
  const sessions: Record<string, McpSession> = {};
  const pendingRecoveries: Record<string, McpSession> = {};
  const deleteGraceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  const recoveryInFlight = new Map<string, Promise<McpSession | null>>();
  // Số SSE GET stream đang mở trên mỗi session — "thực tế đang kết nối".
  // Dùng đếm (không phải Set) vì 1 session có thể có nhiều GET request cùng lúc
  // (request bị SDK từ chối 409 cũng chạy qua đây) — mỗi stream tăng 1, mỗi close giảm 1.
  const liveConnections = new Map<string, number>();
  // Số build session đang chạy nhưng chưa publish (createMcpServer/connect đang
  // await). buildSession() chạy ngoài op-queue của mọi session, nên nhiều
  // initialize song song có thể cùng pass trimSessionCapacity(1) TRƯỚC khi bất
  // kỳ onsessioninitialized nào publish vào `sessions` — nếu không đếm in-flight,
  // cap MAX_SESSION_COUNT bị vượt đúng bằng số build song song đó. Đếm reservation
  // để admission là chính xác: published + in-flight <= MAX.
  let inFlightBuilds = 0;
  // Reservation đã trao cho transport (build xong, chưa publish). Key = transport
  // object (WeakMap — không giữ transport sống, không rò): sessionId của transport
  // chưa có lúc build return với initialize thường, chỉ có preferredSessionId với
  // recovery, nên key theo object là cách duy nhất hoạt động cho cả 2 path.
  const transportReservationReleases = new WeakMap<StreamableHTTPServerTransport, () => void>();
  let initializedTotal = 0;
  let openAiMcpInitializedTotal = 0;
  let shuttingDown = false;
  function touch(sessionId: string): void {
    const session = sessions[sessionId];
    if (session) {
      session.lastAccessedAt = Date.now();
    }
  }

  function cancelDeleteGrace(sessionId: string): void {
    const timer = deleteGraceTimers[sessionId];
    if (!timer) return;
    clearTimeout(timer);
    delete deleteGraceTimers[sessionId];
  }

  function scheduleDeleteGrace(sessionId: string): void {
    cancelDeleteGrace(sessionId);
    deleteGraceTimers[sessionId] = setTimeout(() => {
      delete deleteGraceTimers[sessionId];
      console.log(
        `${formatLogTime()} [MCP] Session close fallback grace expired after ${SESSION_DELETE_GRACE_MS / 1000}s: ${sessionLogId(sessionId)}`
      );
      disposeSession(sessionId, "client DELETE (grace expired)");
    }, SESSION_DELETE_GRACE_MS);
    deleteGraceTimers[sessionId].unref?.();
  }

  function detachSession(sessionId: string): McpSession | undefined {
    cancelDeleteGrace(sessionId);
    const session = sessions[sessionId];
    if (!session) return undefined;
    getUpstreamManager().unregisterMcpServer(session.server);
    delete sessions[sessionId];
    delete lastTransportErrors[sessionId];
    liveConnections.delete(sessionId);
    return session;
  }

  async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation.then(() => true, () => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function closeSessionResources(session: McpSession): Promise<void> {
    // One wedged SDK transport must not hold the whole process shutdown until
    // the global hard-exit deadline. Let McpServer own normal close, then fall
    // back to the transport with a bounded wait if close rejects or times out.
    const serverClosed = await settleWithin(session.server.close(), SESSION_RESOURCE_CLOSE_TIMEOUT_MS);
    if (!serverClosed) {
      await settleWithin(session.transport.close().catch(() => undefined), Math.min(1000, SESSION_RESOURCE_CLOSE_TIMEOUT_MS));
    }
  }

  function isSessionBusy(sessionId: string): boolean {
    return (liveConnections.get(sessionId) ?? 0) > 0 || sessionOpChains.has(sessionId);
  }

  function disposeSession(sessionId: string, reason: string): void {
    const session = detachSession(sessionId);
    if (!session) return;
    // Detach first so close() -> onsessionclosed cannot re-add a grace timer for
    // a session the server deliberately evicted.
    void closeSessionResources(session).catch(() => undefined);
  }

  async function disposeSessionAndWait(sessionId: string): Promise<void> {
    const session = detachSession(sessionId);
    if (!session) return;
    await closeSessionResources(session);
  }

  async function disposePendingSession(session: McpSession): Promise<void> {
    // Điểm dispose của session chưa publish — release reservation (idempotent:
    // no-op nếu session đã publish và reservation đã giải phóng ở onsessioninitialized).
    releaseUnpublishedSession(session);
    getUpstreamManager().unregisterMcpServer(session.server);
    const sid = session.transport.sessionId;
    if (sid) delete lastTransportErrors[sid];
    await closeSessionResources(session);
  }

  function trimSessionCapacity(reserve = 1): boolean {
    const target = Math.max(0, MAX_SESSION_COUNT - reserve);
    const current = Object.keys(sessions).length;
    if (current <= target) return true;

    const candidates = Object.entries(sessions)
      .filter(([sid]) => !isSessionBusy(sid))
      .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
    let remaining = current;
    for (const [sid] of candidates) {
      if (remaining <= target) break;
      disposeSession(sid, "capacity eviction");
      remaining--;
    }
    return remaining <= target;
  }

  function releaseBuildReservation(): void {
    if (inFlightBuilds > 0) inFlightBuilds--;
  }

  // Admission: published sessions + in-flight builds (chưa publish) phải <= MAX.
  // Gọi TRƯỚC khi createMcpServer để không xảy ra quá nhiều build song song
  // cùng lúc (mỗi cái tốn RAM + timer + upstream handle). Evict idle session
  // nếu cần chỗ; nếu mọi session đang busy thì từ chối luôn thay vì vượt cap.
  function reserveBuildSlot(): boolean {
    // Chống tràn khi MỌI slot đều là in-flight (0 published + 64 in-flight):
    // trimSessionCapacity(65) clamp target về 0 và trả true → 65th được admit.
    // Không có session published nào để evict nên reject cứng ngay.
    if (inFlightBuilds >= MAX_SESSION_COUNT) return false;
    if (Object.keys(sessions).length + inFlightBuilds + 1 > MAX_SESSION_COUNT) {
      // Phải dành chỗ cho MỌI reservation đang chạy + chỗ mới: trim target
      // = MAX - (inFlightBuilds + 1). Nếu dùng (1) thì 63 published + 1 in-flight
      // sẽ cho phép reservation thứ 2 mà không evict (63+2=65 > 64).
      if (!trimSessionCapacity(inFlightBuilds + 1)) return false;
    }
    inFlightBuilds++;
    return true;
  }

  // Hoán chuyển reservation: buildSession() build xong transport TRƯỚC khi
  // initialize được dispatch, nên onsessioninitialized chưa chạy. Nếu giải
  // phóng ngay khi buildSession return, nhiều initialize song song lại vượt
  // cap như cũ. Thay vào đó, buildSession giữ reservation và trao cho transport;
  // release xảy ra ĐÚNG LÚC publish (hoặc shutdown-publish / dispose / build fail).
  function makeReservationReleaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseBuildReservation();
    };
  }

  // Giải phóng reservation của một session đã trao cho transport nhưng chưa
  // publish (vd. recovery build fail sau khi buildSession return). Idempotent.
  function releaseUnpublishedSession(session: McpSession): void {
    const releases = transportReservationReleases.get(session.transport);
    if (releases) {
      releases();
      transportReservationReleases.delete(session.transport);
    }
  }





  function clearPendingRecovery(sessionId: string): void {
    delete pendingRecoveries[sessionId];
  }

  async function buildSession(preferredSessionId?: string): Promise<McpSession> {
    if (shuttingDown) throw new Error("MCP session manager is shutting down");
    if (!reserveBuildSlot()) {
      throw new SessionCapacityError();
    }
    // Reservation giữ cho tới khi transport được publish (hoặc dispose/fail) —
    const releaseReservation = makeReservationReleaser();
    // Hoisted so the catch can clean up a transport/server whose sessionId was
    // assigned or whose connect failed mid-build.
    let transport!: StreamableHTTPServerTransport;
    let mcpServer: McpServer | undefined;
    try {
      mcpServer = await (config.createMcpServerOverride ?? createMcpServer)(
        config.workspaceRoot,
        config.shellTimeout,
        config.workspaceRoots,
        getFullDiskAccess(),
        getUpstreamManager(),
        config.projectMemoryInstructions
      );
      if (shuttingDown) {
        // Cleanup (unregister + close) happens in the catch below — single point.
        throw new Error("MCP session manager is shutting down");
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: preferredSessionId
          ? () => preferredSessionId
          : () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          if (shuttingDown) {
            // Không publish — release reservation và close transport ở turn sau.
            transportReservationReleases.delete(transport);
            releaseReservation();
            clearPendingRecovery(sid);
            setImmediate(() => {
              getUpstreamManager().unregisterMcpServer(mcpServer!);
              void mcpServer!.close().catch(() => transport.close().catch(() => undefined));
            });
            return;
          }
          const existing = sessions[sid];
          sessions[sid] = {
            transport,
            server: mcpServer!, // set before connect() below; callback fires post-connect
            lastAccessedAt: Date.now(),
            createdAt: existing?.createdAt ?? Date.now(),
          };
          initializedTotal++;
          // Publish xong → session đã nằm trong `sessions` (được đếm bởi
          // trimSessionCapacity/reserveBuildSlot), release reservation in-flight.
          transportReservationReleases.delete(transport);
          releaseReservation();
          clearPendingRecovery(sid);
          // NOTE: không đọc clientInfo ở đây — callback này chạy trong
          // StreamableHTTPServerTransport.handleRequest TRƯỚC khi message initialize
          // được dispatch tới handler (SDK webStandardStreamableHttp.js:437-439),
          // nên getClientVersion() chưa được set. Dòng log sẽ được in sau khi
          // handleRequest của POST initialize resolve (xem createNew) để có clientInfo.
        },
        onsessionclosed: (sid) => {
          if (sid && sessions[sid]) scheduleDeleteGrace(sid);
        },
      });

      transport.onerror = (error) => {
        const sid = transport.sessionId;
        const message = error.message || String(error);
        if (sid) lastTransportErrors[sid] = message;
      };

      // Keep session alive across transient SSE disconnects; explicit DELETE cleans up.
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (!sid || !sessions[sid]) return;
        console.log(`${formatLogTime()} [MCP] Transport closed for ${sessionLogId(sid)} (session kept for recovery)`);
      };

      await mcpServer.connect(transport);
      if (shuttingDown) {
        // Cleanup (unregister + close) happens in the catch below — single point.
        throw new Error("MCP session manager is shutting down");
      }

      const sid = transport.sessionId ?? preferredSessionId ?? randomUUID();
      const built = sessions[sid] ?? {
        transport,
        server: mcpServer!, // connect() returned above; server is set
        lastAccessedAt: Date.now(),
        createdAt: Date.now(),
      };
      transportReservationReleases.set(transport, releaseReservation);
      return built;
    } catch (err) {
      // createMcpServer/connect fail (or shutdown flips mid-build) trước khi
      // transport được publish → release reservation và dọn dẹp: unregister
      // khỏi upstream manager rồi đóng server. `mcpServer.close()` tự close
      // transport đã connect (Protocol.close → this._transport?.close()), nên
      // lệnh `transport.close()` tường minh chỉ là fallback khi server.close()
      // reject, hoặc khi server chưa từng được tạo.
      releaseReservation();
      const failedSid = transport?.sessionId;
      if (failedSid) delete lastTransportErrors[failedSid];
      if (mcpServer) {
        getUpstreamManager().unregisterMcpServer(mcpServer);
        await mcpServer.close().catch(() => transport?.close().catch(() => undefined));
      } else {
        await transport?.close().catch(() => undefined);
      }
      throw err;
    }
  }



  async function warmUpRecoveredSession(
    staleSessionId: string,
    mcpPath: string,
    protocolVersion: string
  ): Promise<boolean> {
    const initResult = await loopbackMcpPost(
      config.port,
      mcpPath,
      {
        jsonrpc: "2.0",
        id: "__session_recovery_init__",
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "codex-mcp-session-recovery", version: "1.0.0" },
        },
      },
      staleSessionId
    );

    if (!initResult.ok) {
      console.log(
        `${formatLogTime()} [MCP] Recovery initialize failed: HTTP ${initResult.status} for ${sessionLogId(staleSessionId)}`
      );
      return false;
    }

    const notifyResult = await loopbackMcpPost(
      config.port,
      mcpPath,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      staleSessionId,
      protocolVersion
    );

    if (!notifyResult.ok && notifyResult.status !== 202) {
      console.log(
        `${formatLogTime()} [MCP] Recovery initialized notification failed: HTTP ${notifyResult.status}`
      );
      return false;
    }

    return Boolean(sessions[staleSessionId]);
  }

  return {
    get(sessionId: string) {
      return sessions[sessionId];
    },

    list() {
      const now = Date.now();
      return Object.entries(sessions)
        .sort((a, b) => a[1].createdAt - b[1].createdAt)
        .map(([sid, session], index) => ({
          index: index + 1,
          shortId: `${sid.slice(0, 8)}…`,
          status: deleteGraceTimers[sid] ? "closing" : "registered",
          connected: (liveConnections.get(sid) ?? 0) > 0,
          ageSeconds: Math.max(0, Math.round((now - session.createdAt) / 1000)),
          idleSeconds: Math.max(0, Math.round((now - session.lastAccessedAt) / 1000)),
        }));
    },

    counts() {
      let connected = 0;
      for (const [sid, n] of liveConnections) {
        if (n > 0 && sessions[sid] && !deleteGraceTimers[sid]) connected++;
      }
      return {
        registered: Object.keys(sessions).length,
        connected,
        maxRetained: MAX_SESSION_COUNT,
        idleTtlMs: SESSION_TTL_MS,
        cleanupIntervalMs: SESSION_CLEANUP_INTERVAL_MS,
      };
    },

    registerLiveConnection(sessionId: string) {
      liveConnections.set(sessionId, (liveConnections.get(sessionId) ?? 0) + 1);
    },

    unregisterLiveConnection(sessionId: string) {
      const n = liveConnections.get(sessionId) ?? 0;
      if (n <= 1) liveConnections.delete(sessionId);
      else liveConnections.set(sessionId, n - 1);
    },

    isSessionConnected(sessionId: string) {
      return (liveConnections.get(sessionId) ?? 0) > 0;
    },

    isInDeleteGrace(sessionId: string) {
      return Boolean(deleteGraceTimers[sessionId]);
    },

    // Atomic cancel+detach+close for a session whose DELETE grace is active.
    // Used by handleMcpPost to dispose a closing session before re-initializing
    // it, so the reconnect gets a fresh transport instead of the closed SDK one.
    async disposeClosingSession(sessionId: string): Promise<void> {
      await disposeSessionAndWait(sessionId);
    },

    touch,

    count() {
      return Object.keys(sessions).length;
    },

    sendSessionNotFound(res: Response, requestId: string | number | null = null) {
      const message =
        "Session not found. Server restarted or connector session expired — refresh connector and open a new chat.";
      res.locals.mcpError = message;
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message },
        id: requestId,
      });
    },

    sendBadRequest(res: Response, message: string, requestId: string | number | null = null) {
      res.locals.mcpError = message;
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message },
        id: requestId,
      });
    },

    async createNew(req: Request, res: Response, body: unknown): Promise<void> {
      const headerSessionId = req.headers["mcp-session-id"] as string | undefined;
      let session: McpSession;

      if (headerSessionId && pendingRecoveries[headerSessionId]) {
        session = pendingRecoveries[headerSessionId];
        clearPendingRecovery(headerSessionId);
        console.log(`${formatLogTime()} [MCP] Using pending recovery transport for ${sessionLogId(headerSessionId)}`);
      } else {
        session = await buildSession();
      }

      const sid = headerSessionId || session.transport.sessionId;
      const run = async () => {
        // Trước handleRequest: transport mới build (hoặc recovery) chưa được
        // initialize → chưa có sessionId. Đây là initialize đầu tiên của transport.
        const wasUninitialized = !session.transport.sessionId;
        await session.transport.handleRequest(req, res, body);
        const activeSid = session.transport.sessionId;
        if (activeSid) touch(activeSid);
        // Chỉ log clientInfo cho lần initialize đầu tiên của transport này
        // (bao gồm recovery warm-up vào qua pendingRecoveries). Sau khi
        // handleRequest của initialize resolve, SDK đã set clientInfo
        // (Server._oninitialize → getClientVersion()). handleExisting/
        // tryRecoverStale KHÔNG log lại — dòng này là nguồn duy nhất cho
        // "Session initialized".
        if (wasUninitialized && activeSid) {
          const client = session.server.server.getClientVersion();
          // Client-supplied name is logged verbatim; strip control characters
          // and truncate so a hostile initialize cannot inject log lines.
          const name = (client?.name ?? "unknown").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120) || "unknown";
          const version = client?.version ? String(client.version).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 60) : undefined;
          // ChatGPT currently creates nearly one short-lived openai-mcp transport
          // session per tool call. Logging each initialize dominated server.log.
          // Tool-call lines still carry the short session ID and the dashboard
          // exposes retained sessions, so sample the repetitive client churn.
          // Use an openai-mcp-local counter so manager warm-up/tunnel/recovery
          // initializes cannot shift which ChatGPT session becomes the 25th sample.
          const clientInitializedTotal = name === "openai-mcp" ? ++openAiMcpInitializedTotal : 0;
          const logThisInitialize = shouldLogSessionInitializeForClient(name, clientInitializedTotal);
          if (logThisInitialize) {
            const retained = Object.keys(sessions).length;
            console.log(
              `${formatLogTime()} [MCP] Session initialized: ${sessionLogId(activeSid)} client=${name}${
                version ? ` (${version})` : ""
              } initialized=${initializedTotal}${
                name === "openai-mcp" ? ` clientInitialized=${clientInitializedTotal}` : ""
              } retained=${retained}/${MAX_SESSION_COUNT}`
            );
          }
        }
      };

      if (sid) {
        await enqueueSessionOp(sid, run);
      } else {
        await run();
      }
    },

    async handleExisting(
      session: McpSession,
      req: Request,
      res: Response,
      body?: unknown,
      bypassQueue = false
    ): Promise<void> {
      const sid =
        session.transport.sessionId || (req.headers["mcp-session-id"] as string | undefined);
      if (sid) touch(sid);
      const run = async () => {
        await session.transport.handleRequest(req, res, body);
      };
      // GET (SSE) là stream sống lâu — KHÔNG được nằm trong hàng đợi op của session:
      // nếu nó chặn hàng đợi thì DELETE (cần gọi transport.close() để đóng stream)
      // sẽ chờ sau nó mãi mãi → không bao giờ đóng được SSE. SDK tự chặn GET thứ 2
      // bằng 409, nên không cần serialize GET. POST ngắn và DELETE vẫn tuần tự hóa
      // để tránh SDK close() đua với response promise của POST (strand).
      if (sid && !bypassQueue) {
        await enqueueSessionOp(sid, run);
      } else {
        await run();
      }

      // POST and DELETE share the same per-session op chain. Once an explicit
      // DELETE returns from enqueueSessionOp, every earlier POST/tool call has
      // already settled, so the old fixed 45s grace no longer protects in-flight
      // work. Dispose promptly to keep short-lived client sessions from occupying
      // the retained-session cap. onsessionclosed still keeps the configured grace
      // as a defensive fallback for transport closes outside this explicit path.
      if (sid && req.method === "DELETE" && deleteGraceTimers[sid]) {
        disposeSession(sid, "client DELETE (serialized op drained)");
      }
    },
    async tryRecoverStale(
      staleSessionId: string,
      req: Request,
      res: Response,
      body: unknown
    ): Promise<boolean> {
      if (shuttingDown) return false;
      if (isInitializeRequest(body)) {
        return false;
      }
      console.log(`${formatLogTime()} [MCP] Attempting session recovery for stale ID: ${sessionLogId(staleSessionId)}`);

      const protocolVersion =
        (req.headers["mcp-protocol-version"] as string | undefined) ??
        DEFAULT_PROTOCOL_VERSION;
      const mcpPath = req.path || "/mcp";

      // Lock per-session: 2 request stale cùng sessionId chạy song song → chỉ 1 build session,
      // request sau chờ kết quả rồi dùng chung (tránh 2 transport + upstream register leak).
      const inFlight = recoveryInFlight.get(staleSessionId);
      if (inFlight) {
        const recovered = await inFlight;
        if (!recovered) return false;
        const headers = { ...req.headers, "mcp-session-id": staleSessionId };
        const patchedReq = Object.assign(req, { headers });
        await enqueueSessionOp(staleSessionId, async () => {
          await recovered.transport.handleRequest(patchedReq, res, body);
        });
        return true;
      }

      const promise: Promise<McpSession | null> = (async () => {
        let pending: McpSession | null = null;
        try {
          const built = await buildSession(staleSessionId);
          if (shuttingDown) {
            await disposePendingSession(built);
            return null;
          }
          pending = built;
          pendingRecoveries[staleSessionId] = pending;
          const warmed = await warmUpRecoveredSession(staleSessionId, mcpPath, protocolVersion);
          if (!warmed) {
            clearPendingRecovery(staleSessionId);
            await disposePendingSession(pending);
            return null;
          }
          const recovered = sessions[staleSessionId];
          if (!recovered) {
            clearPendingRecovery(staleSessionId);
            await disposePendingSession(pending);
            return null;
          }
          return recovered;
        } catch (err) {
          clearPendingRecovery(staleSessionId);
          // buildSession() throw (createMcpServer fail) đã release trong catch của
          // chính nó; nếu fail SAU build return (warmUp/dispose), đóng pending ở đây.
          if (pending) await disposePendingSession(pending);
          console.log(`${formatLogTime()} [MCP] Recovery error: ${String(err)}`);
          return null;
        }
      })();
      recoveryInFlight.set(staleSessionId, promise);
      let recovered: McpSession | null = null;
      try {
        recovered = await promise;
      } finally {
        if (recoveryInFlight.get(staleSessionId) === promise) {
          recoveryInFlight.delete(staleSessionId);
        }
      }
      if (!recovered) return false;

      console.log(`${formatLogTime()} [MCP] Session recovered: ${sessionLogId(staleSessionId)}`);
      touch(staleSessionId);

      const headers = { ...req.headers, "mcp-session-id": staleSessionId };
      const patchedReq = Object.assign(req, { headers });
      await enqueueSessionOp(staleSessionId, async () => {
        await recovered.transport.handleRequest(patchedReq, res, body);
      });
      return true;
    },

    startCleanup() {
      if (cleanupTimer) return;
      cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [sid, session] of Object.entries(sessions)) {
          if (now - session.lastAccessedAt > SESSION_TTL_MS && !isSessionBusy(sid)) {
            disposeSession(sid, "idle TTL expired");
          }
        }
        // Bound memory even if a caller creates sessions faster than the TTL
        // sweep can expire them. Busy/SSE-connected sessions are never evicted.
        trimSessionCapacity(0);
        for (const sid of Object.keys(pendingRecoveries)) {
          if (!sessions[sid]) clearPendingRecovery(sid);
        }
      }, SESSION_CLEANUP_INTERVAL_MS);
      cleanupTimer.unref?.();
    },

    stopCleanup() {
      if (!cleanupTimer) return;
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    },

    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      for (const timer of Object.values(deleteGraceTimers)) clearTimeout(timer);
      for (const sid of Object.keys(deleteGraceTimers)) delete deleteGraceTimers[sid];

      // Let recoveries that already crossed buildSession's entry check observe
      // shuttingDown and self-dispose. Bound the wait so a dead upstream cannot
      // block process shutdown indefinitely.
      const recoveries = [...recoveryInFlight.values()];
      if (recoveries.length) {
        await Promise.race([
          Promise.allSettled(recoveries),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 2000);
            timer.unref?.();
          }),
        ]);
      }

      // Close registered sessions first so long-lived SSE responses are ended
      // before the HTTP listener starts waiting for graceful shutdown.
      await Promise.allSettled(Object.keys(sessions).map((sid) => disposeSessionAndWait(sid)));

      // Recovery sessions can exist before onsessioninitialized puts them in the
      // authoritative session map. Close any remaining unique pending servers too.
      const pending = [...new Set(Object.values(pendingRecoveries))];
      for (const sid of Object.keys(pendingRecoveries)) delete pendingRecoveries[sid];
      await Promise.allSettled(pending.map((session) => disposePendingSession(session)));
      recoveryInFlight.clear();
      sessionOpChains.clear();
      liveConnections.clear();
    },
  };
}

export function isStaleSessionRequest(
  sessionId: string | undefined,
  body: unknown,
  getSession: (id: string) => McpSession | undefined
): boolean {
  return Boolean(sessionId && !getSession(sessionId) && !isInitializeRequest(body));
}

export { extractRequestId, isInitializeRequest };