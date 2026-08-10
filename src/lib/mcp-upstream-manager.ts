import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { redactSensitiveText } from "./redaction.js";
import { clampSyncTimeoutMs } from "./sync-response-budget.js";

import {
  loadUpstreamConfig,
  normalizeUpstreamConfig,
  saveUpstreamConfig,
  type UpstreamConfigFile,
  type UpstreamServerConfig,
  resolveUpstreamConfigPath,
} from "./mcp-upstream-config.js";

export type UpstreamHealth = "unknown" | "connected" | "reachable" | "unreachable" | "disabled";

export interface UpstreamServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  transport: string;
  health: UpstreamHealth;
  connected: boolean;
  tool_count: number;
  expose: string;
  proxied_tools: string[];
  last_error?: string;
  pid?: number | null;
}

interface UpstreamConnection {
  config: UpstreamServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: Tool[];
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastError?: string;
  connected: boolean;
  activeOperations: number;
}

function positiveEnvInt(name: string, fallback: number, min = 1000, max = 600_000): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

const UPSTREAM_CONNECT_TIMEOUT_MS = positiveEnvInt("MCP_UPSTREAM_CONNECT_TIMEOUT_MS", 15_000);
const UPSTREAM_DISCOVERY_TIMEOUT_MS = positiveEnvInt("MCP_UPSTREAM_DISCOVERY_TIMEOUT_MS", 15_000);
const UPSTREAM_TOOL_TIMEOUT_MS = positiveEnvInt("MCP_UPSTREAM_TOOL_TIMEOUT_MS", 120_000, 1000, 3_600_000);

let singleton: McpUpstreamManager | null = null;

export class McpUpstreamManager {
  private config: UpstreamConfigFile;
  private configPath: string;
  private connections = new Map<string, UpstreamConnection>();
  private connectInFlight = new Map<string, Promise<UpstreamConnection>>();
  private servers = new Set<McpServer>();
  private toolsCache = new Map<string, { tools: Tool[]; expiresAt: number }>();
  private readonly toolsCacheTtlMs = 60_000;
  private configMutationChain: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  constructor(configPath = resolveUpstreamConfigPath()) {
    this.configPath = configPath;
    this.config = { version: 1, servers: [] };
  }

  async init(): Promise<void> {
    this.config = await loadUpstreamConfig(this.configPath);
  }

  private enqueueConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.configMutationChain.then(operation, operation);
    this.configMutationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async applyNormalizedConfig(normalized: UpstreamConfigFile): Promise<UpstreamConfigFile> {
    await saveUpstreamConfig(normalized, this.configPath);
    this.config = normalized;
    await this.disconnectStaleConnections();
    await this.refreshAllProxies();
    return this.config;
  }

  registerMcpServer(server: McpServer): void {
    this.servers.add(server);
  }

  unregisterMcpServer(server: McpServer): void {
    this.servers.delete(server);
  }

  /** Number of servers currently registered for proxying (test/observability). */
  getRegisteredServerCount(): number {
    return this.servers.size;
  }

  getConfig(): UpstreamConfigFile {
    return this.config;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  listServerConfigs(): UpstreamServerConfig[] {
    return [...this.config.servers];
  }

  getServerConfig(serverId: string): UpstreamServerConfig | undefined {
    return this.config.servers.find((s) => s.id === serverId);
  }

  async reloadConfig(): Promise<UpstreamConfigFile> {
    return this.enqueueConfigMutation(async () => {
      const loaded = await loadUpstreamConfig(this.configPath);
      this.config = loaded;
      await this.disconnectStaleConnections();
      await this.refreshAllProxies();
      return this.config;
    });
  }

  async updateConfig(next: UpstreamConfigFile): Promise<UpstreamConfigFile> {
    const normalized = normalizeUpstreamConfig(next);
    return this.enqueueConfigMutation(() => this.applyNormalizedConfig(normalized));
  }

  async upsertServer(server: UpstreamServerConfig): Promise<void> {
    await this.enqueueConfigMutation(async () => {
      const next = [...this.config.servers];
      const idx = next.findIndex((s) => s.id === server.id);
      if (idx >= 0) next[idx] = server;
      else next.push(server);
      await this.applyNormalizedConfig(normalizeUpstreamConfig({ version: 1, servers: next }));
    });
  }

  async removeServer(serverId: string): Promise<boolean> {
    return this.enqueueConfigMutation(async () => {
      const next = this.config.servers.filter((s) => s.id !== serverId);
      if (next.length === this.config.servers.length) return false;
      await this.applyNormalizedConfig(normalizeUpstreamConfig({ version: 1, servers: next }));
      return true;
    });
  }

  private async disconnectStaleConnections(): Promise<void> {
    const configs = new Map(this.config.servers.map((s) => [s.id, s]));
    for (const [id, conn] of [...this.connections.entries()]) {
      const next = configs.get(id);
      if (!next || !next.enabled || JSON.stringify(next) !== JSON.stringify(conn.config)) {
        await this.disconnect(id);
      }
    }
  }

  private getEnabledServers(): UpstreamServerConfig[] {
    return this.config.servers.filter((s) => s.enabled);
  }

  private scheduleIdleDisconnect(serverId: string, conn: UpstreamConnection): void {
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    conn.idleTimer = null;
    const timeoutSec = conn.config.idle_timeout_sec ?? 600;
    if (timeoutSec <= 0 || conn.activeOperations > 0 || !conn.connected) return;
    conn.idleTimer = setTimeout(() => {
      conn.idleTimer = null;
      // The timer belongs to one specific connection generation. Never let an
      // already-queued timer from an old connection tear down its replacement.
      if (this.connections.get(serverId) !== conn || !conn.connected) return;
      // "Idle" means no operation is using the upstream. A long-running tool
      // must not be killed merely because it runs longer than idle_timeout_sec.
      if (conn.activeOperations > 0) return;
      void this.disconnect(serverId);
    }, timeoutSec * 1000);
    conn.idleTimer.unref?.();
  }

  private touch(conn: UpstreamConnection): void {
    conn.lastUsedAt = Date.now();
    if (conn.activeOperations === 0) this.scheduleIdleDisconnect(conn.config.id, conn);
  }

  private beginOperation(conn: UpstreamConnection): void {
    conn.activeOperations++;
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    conn.idleTimer = null;
  }

  private endOperation(conn: UpstreamConnection): void {
    conn.activeOperations = Math.max(0, conn.activeOperations - 1);
    if (this.connections.get(conn.config.id) === conn && conn.connected) this.touch(conn);
  }

  private async createTransport(config: UpstreamServerConfig): Promise<{
    client: Client;
    transport: StdioClientTransport | StreamableHTTPClientTransport;
    pid: number | null;
  }> {
    const client = new Client({ name: "codex-mcp-hub", version: "2.0.0" });

    if (config.transport === "stdio") {
      const transport = new StdioClientTransport({
        command: config.command!,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
        stderr: "pipe",
      });
      try {
        await client.connect(transport, { timeout: UPSTREAM_CONNECT_TIMEOUT_MS });
      } catch (err) {
        await transport.close().catch(() => undefined);
        throw err;
      }
      return { client, transport, pid: transport.pid };
    }

    const transport = new StreamableHTTPClientTransport(new URL(config.url!), {
      requestInit: Object.keys(config.headers ?? {}).length ? { headers: config.headers } : undefined,
    });
    try {
      await client.connect(transport, { timeout: UPSTREAM_CONNECT_TIMEOUT_MS });
    } catch (err) {
      await transport.close().catch(() => undefined);
      throw err;
    }
    return { client, transport, pid: null };
  }

  async connect(serverId: string, force = false): Promise<UpstreamConnection> {
    if (this.shuttingDown) throw new Error("MCP upstream manager is shutting down");
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    if (!config.enabled) throw new Error(`Upstream server disabled: ${serverId}`);

    const existing = this.connections.get(serverId);
    if (existing && existing.connected && !force) {
      this.touch(existing);
      return existing;
    }

    // One cold connect per upstream. Session initialize can arrive concurrently;
    // without this lock each caller could spawn/connect a separate stdio/HTTP
    // transport and the last one would overwrite the map, leaking the others.
    const pending = this.connectInFlight.get(serverId);
    if (pending) return pending;

    const connectPromise = (async () => {
      if (this.connections.has(serverId)) await this.disconnect(serverId);

      let opened: Awaited<ReturnType<McpUpstreamManager["createTransport"]>> | null = null;
      try {
        opened = await this.createTransport(config);
        const list = await opened.client.listTools(undefined, { timeout: UPSTREAM_DISCOVERY_TIMEOUT_MS });
        const tools = list.tools ?? [];

        // Config may change while an expensive stdio/HTTP connect is in flight.
        // Never publish a transport created from stale command/url/headers into
        // the authoritative map after updateConfig() has already moved on.
        const current = this.getServerConfig(serverId);
        if (!current || !current.enabled || JSON.stringify(current) !== JSON.stringify(config)) {
          await opened.transport.close().catch(() => undefined);
          opened = null;
          throw new Error(`Upstream config changed during connect: ${serverId}`);
        }
        if (this.shuttingDown) {
          await opened.transport.close().catch(() => undefined);
          opened = null;
          throw new Error("MCP upstream manager is shutting down");
        }

        const conn: UpstreamConnection = {
          config,
          client: opened.client,
          transport: opened.transport,
          tools,
          lastUsedAt: Date.now(),
          idleTimer: null,
          connected: true,
          lastError: undefined,
          activeOperations: 0,
        };
        if (config.transport === "stdio" && opened.pid) {
          (conn as UpstreamConnection & { pid?: number }).pid = opened.pid;
        }

        this.connections.set(serverId, conn);
        this.toolsCache.set(serverId, { tools, expiresAt: Date.now() + this.toolsCacheTtlMs });
        this.touch(conn);
        return conn;
      } catch (err) {
        // connect() can succeed but initial listTools() can fail. Close the
        // partially-open transport so a failed discovery never leaks a process/socket.
        if (opened) await opened.transport.close().catch(() => undefined);
        throw err;
      }
    })();
    this.connectInFlight.set(serverId, connectPromise);
    try {
      return await connectPromise;
    } finally {
      if (this.connectInFlight.get(serverId) === connectPromise) this.connectInFlight.delete(serverId);
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    // Remove authority before awaiting close so a concurrent caller cannot grab
    // a connection that is already in the process of shutting down.
    this.connections.delete(serverId);
    this.toolsCache.delete(serverId);
    conn.connected = false;
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    try {
      await conn.transport.close();
    } catch {}
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await this.configMutationChain.catch(() => undefined);
    await Promise.allSettled([...this.connectInFlight.values()]);
    for (const id of [...this.connections.keys()]) {
      await this.disconnect(id);
    }
  }

  async listTools(serverId: string): Promise<Tool[]> {
    const cached = this.toolsCache.get(serverId);
    if (cached && cached.expiresAt > Date.now()) {
      const cachedConn = this.connections.get(serverId);
      if (cachedConn?.connected) this.touch(cachedConn);
      return cached.tools;
    }

    const conn = await this.connect(serverId);
    this.beginOperation(conn);
    try {
      const list = await conn.client.listTools(undefined, { timeout: UPSTREAM_DISCOVERY_TIMEOUT_MS });
      const tools = list.tools ?? [];
      conn.tools = tools;
      this.toolsCache.set(serverId, { tools, expiresAt: Date.now() + this.toolsCacheTtlMs });
      return tools;
    } catch (err) {
      await this.disconnect(serverId);
      throw err;
    } finally {
      this.endOperation(conn);
    }
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const conn = await this.connect(serverId);
    this.beginOperation(conn);
    try {
      return await conn.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: clampSyncTimeoutMs(UPSTREAM_TOOL_TIMEOUT_MS) }
      );
    } catch (err) {
      // A timed-out/failed request may leave protocol state ambiguous. Closing
      // the transport aborts the underlying request/process; the next call reconnects.
      await this.disconnect(serverId);
      throw err;
    } finally {
      this.endOperation(conn);
    }
  }

  async checkHealth(serverId: string): Promise<UpstreamServerStatus> {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);

    if (!config.enabled) {
      return this.buildStatus(config, "disabled", false, []);
    }

    try {
      const conn = await this.connect(serverId, true);
      return this.buildStatus(config, "connected", true, conn.tools, undefined, conn);
    } catch (err) {
      const message = redactSensitiveText(err instanceof Error ? err.message : String(err));
      return this.buildStatus(config, "unreachable", false, [], message);
    }
  }

  async listStatuses(options: { probe?: boolean } = {}): Promise<UpstreamServerStatus[]> {
    if (options.probe) {
      return Promise.all(this.config.servers.map((config) => this.checkHealth(config.id)));
    }
    // Passive snapshot for dashboards/agent_status. Observability must not
    // connect/touch upstreams, otherwise a 5s UI poll defeats idle_timeout.
    return this.config.servers.map((config) => {
      if (!config.enabled) return this.buildStatus(config, "disabled", false, []);
      const conn = this.connections.get(config.id);
      const cached = this.toolsCache.get(config.id);
      const tools = conn?.tools ?? cached?.tools ?? [];
      return this.buildStatus(
        config,
        conn?.connected ? "connected" : "unknown",
        Boolean(conn?.connected),
        tools,
        conn?.lastError,
        conn
      );
    });
  }

  private buildStatus(
    config: UpstreamServerConfig,
    health: UpstreamHealth,
    connected: boolean,
    tools: Tool[],
    lastError?: string,
    conn?: UpstreamConnection
  ): UpstreamServerStatus {
    const proxied = this.getProxiedToolNames(config, tools);
    return {
      id: config.id,
      name: config.name,
      enabled: config.enabled,
      transport: config.transport,
      health,
      connected,
      tool_count: tools.length,
      expose: config.expose,
      proxied_tools: proxied,
      last_error: lastError,
      pid: conn && "pid" in conn ? (conn as UpstreamConnection & { pid?: number }).pid ?? null : null,
    };
  }

  getProxiedToolNames(config: UpstreamServerConfig, tools: Tool[]): string[] {
    if (!config.enabled || config.expose === "none" || config.expose === "meta_only") return [];
    const prefix = `${config.tool_prefix ?? config.id}__`;
    const names = tools.map((t) => t.name);
    if (config.expose === "all") return names.map((n) => `${prefix}${n}`);
    const allow = new Set(config.tools ?? []);
    return names.filter((n) => allow.has(n)).map((n) => `${prefix}${n}`);
  }

  async refreshAllProxies(): Promise<void> {
    const { refreshProxiedTools } = await import("./mcp-tool-proxy.js");
    for (const server of this.servers) {
      await refreshProxiedTools(server, this);
      server.sendToolListChanged();
    }
  }
}

export function getUpstreamManager(): McpUpstreamManager {
  if (!singleton) {
    singleton = new McpUpstreamManager();
  }
  return singleton;
}

export async function initUpstreamManager(): Promise<McpUpstreamManager> {
  const manager = getUpstreamManager();
  await manager.init();
  return manager;
}